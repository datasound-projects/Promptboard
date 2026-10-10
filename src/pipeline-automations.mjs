/** Ordered automation groups. Board owns placement and session lifecycle between them. */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { PipelineActions } from './pipeline-actions.mjs';
import { normalizePipelineAutomations } from './pipeline-config.mjs';
import { pipelineTemplateVariables, renderPipelineTemplate } from './pipeline-templates.mjs';
import { abortable } from './cancellation.mjs';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'unconfirmed', 'skipped', 'interrupted', 'scheduled']);
export class PipelineAutomationError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
const fail = (message, code) => { throw new PipelineAutomationError(message, code); };
const hash = row => createHash('sha256').update(JSON.stringify(row)).digest('hex');
const taskKey = key => JSON.stringify([key.projectId, key.taskId]);

export class PipelineAutomations {
  constructor({ journal, actions = new PipelineActions(), deliverMessage = null, scheduleEnterMessage = null }) {
    if (!journal) fail('Automation groups need their durable journal.', 'AUTOMATION_JOURNAL_REQUIRED');
    if (deliverMessage !== null && typeof deliverMessage !== 'function') fail('Use a session message delivery callback.', 'MESSAGE_SCHEDULER_REQUIRED');
    if (scheduleEnterMessage !== null && typeof scheduleEnterMessage !== 'function') fail('Use a durable enter-message scheduler.', 'MESSAGE_SCHEDULER_REQUIRED');
    this.journal = journal; this.actions = actions; this.deliverMessage = deliverMessage; this.scheduleEnterMessage = scheduleEnterMessage;
    this.jobs = new Map(); this.stopping = false;
  }

  #ownsWork(job) { return [...job.started].some(id => this.actions.jobs.has(id)); }

  runGroup({ key, trigger, rows = [], context, signal = null, onProgress = null, canMessage = true, suppressMessages = false, suppressReason = 'This restoration suppresses agent messages.', exitBudgetMs = 60000, messageTimeoutMs = 150000 }) {
    if (this.stopping) return Promise.reject(new PipelineAutomationError('Automation groups are shutting down.', 'AUTOMATION_SHUTTING_DOWN'));
    if (!key || !['exit', 'enter'].includes(trigger) || typeof canMessage !== 'boolean' || typeof suppressMessages !== 'boolean'
      || !Number.isFinite(exitBudgetMs) || exitBudgetMs < 1 || exitBudgetMs > 60000
      || !Number.isFinite(messageTimeoutMs) || messageTimeoutMs < 1 || messageTimeoutMs > 150000)
      return Promise.reject(new PipelineAutomationError('Use a recorded move and an exit budget of at most sixty seconds.', 'AUTOMATION_CONTEXT_INVALID'));
    try { key = structuredClone(key); }
    catch { return Promise.reject(new PipelineAutomationError('Use a recorded move identity.', 'AUTOMATION_CONTEXT_INVALID')); }
    const ownerKey = taskKey(key), existing = this.jobs.get(ownerKey);
    if (existing?.finished && !this.#ownsWork(existing)) this.jobs.delete(ownerKey);
    else if (existing) {
      if (existing.transitionId === key.transitionId && existing.trigger === trigger) return existing.promise;
      return Promise.reject(new PipelineAutomationError('Finish or cancel the current automation group first.', 'AUTOMATION_GROUP_ACTIVE'));
    }
    let metadata;
    try { rows = structuredClone(rows); metadata = structuredClone({ task: context?.task, project: context?.project, cwd: context?.cwd }); }
    catch { return Promise.reject(new PipelineAutomationError('Use plain task metadata and automation definitions.', 'AUTOMATION_CONTEXT_INVALID')); }
    const controller = new AbortController(), external = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    const groupStartedAt = performance.now();
    // AbortSignal.timeout uses an unreferenced timer. Keep accepted work alive
    // until its bounded outcome is recorded, including on Node 22 without I/O.
    const deadlineController = trigger === 'exit' ? new AbortController() : null;
    const deadlineTimer = deadlineController ? setTimeout(() => deadlineController.abort(new DOMException('Exit automation budget expired.', 'TimeoutError')), Math.ceil(exitBudgetMs)) : null;
    const deadline = deadlineController?.signal;
    const combined = AbortSignal.any([external, ...(deadline ? [deadline] : [])]);
    const job = { controller, trigger, transitionId: key.transitionId, started: new Set(), finished: false };
    this.jobs.set(ownerKey, job);
    job.promise = Promise.resolve().then(async () => {
      const group = trigger === 'exit' ? 'onExit' : 'onEnter';
      const definitions = normalizePipelineAutomations({ [group]: rows })[group];
      if (canMessage && !suppressMessages && definitions.some(row => row.enabled && row.type === 'send_message') && !this.deliverMessage && !(trigger === 'enter' && this.scheduleEnterMessage))
        fail('Agent messages need the session delivery scheduler.', 'MESSAGE_SCHEDULER_REQUIRED');
      const move = await this.journal.read(key);
      if (!move) fail('Record this move before running an automation group.', 'AUTOMATION_MOVE_MISSING');
      const recorded = move.actions.filter(action => action.trigger === trigger);
      if (recorded.length !== definitions.length || recorded.some((action, index) => action.rowId !== definitions[index].id || action.configHash !== hash(definitions[index])))
        fail('The automation definitions changed after this move was recorded.', 'AUTOMATION_CONFIG_CHANGED');
      const enabled = recorded.filter((_action, index) => definitions[index].enabled);
      if (enabled.length && enabled.every(action => TERMINAL.has(action.status))) return { duplicate: true, cancelled: false, safeToAdvance: false, outcomes: recorded };
      if (enabled.some(action => action.status !== 'pending')) fail('This group has unfinished prior execution. It cannot be replayed.', 'AUTOMATION_GROUP_INTERRUPTED');
      if (move.phase !== trigger) fail('Run exit actions before the lifecycle and enter actions after it.', 'AUTOMATION_GROUP_ORDER');
      // Caller metadata was captured before asynchronous journal reads.
      if (recorded.some(action => action.status === 'pending') && (metadata.task?.id !== move.taskId || metadata.project?.id !== move.projectId))
        fail('Automation metadata must belong to the recorded task and project.', 'AUTOMATION_CONTEXT_INVALID');
      metadata.move = { column: trigger === 'exit' ? move.from.name : move.to.name, fromColumn: move.from.name, toColumn: move.to.name, trigger };
      let cleanupUnconfirmed = false;
      for (let index = 0; index < recorded.length; index++) {
        const action = recorded[index], row = definitions[index];
        if (!row.enabled) continue;
        const remaining = trigger === 'exit' ? exitBudgetMs - (performance.now() - groupStartedAt) : null;
        const skip = external.aborted ? 'The move was cancelled before this automation started.'
          : cleanupUnconfirmed ? 'Earlier script termination was not confirmed.'
            : deadline?.aborted || remaining !== null && remaining <= 0 ? 'Exit automations reached their sixty-second group budget.'
              : row.type === 'send_message' && (!canMessage || suppressMessages) ? (suppressMessages ? suppressReason : 'The column has no eligible agent message target.') : null;
        if (skip) { await this.journal.skipAction(key, action.id, skip); continue; }
        const grant = await this.journal.startAction(key, action.id);
        if (!grant.accepted) fail('Another caller already claimed this action. It cannot be replayed.', 'AUTOMATION_ACTION_CLAIMED');
        job.started.add(action.id);
        // Display callbacks are best effort; durable intent is the execution gate.
        try { Promise.resolve(onProgress?.({ actionId: action.id, name: row.name, type: row.type, trigger, columnId: action.columnId })).catch(() => {}); } catch {}
        const ctx = { ...metadata, actionId: action.id, move: { ...metadata.move, trigger }, onAttempt: number => this.journal.recordAttempt(key, action.id, number) };
        const dispatchRemaining = trigger === 'exit' ? exitBudgetMs - (performance.now() - groupStartedAt) : null;
        let result;
        if (external.aborted || deadline?.aborted || dispatchRemaining !== null && dispatchRemaining <= 0)
          result = { status: external.aborted ? 'cancelled' : 'timed_out', reason: 'The move stopped or its exit budget expired before dispatch.' };
        else if (row.type === 'send_message') result = await this.#message(row, ctx, combined, messageTimeoutMs, key);
        else {
          try { result = await this.actions.run(row, ctx, { signal: combined, timeoutMs: dispatchRemaining === null ? null : Math.max(1, dispatchRemaining) }); }
          catch { result = { status: 'failed', errorCode: 'AUTOMATION_START_FAILED', reason: 'The automation could not start with this task context.' }; }
        }
        // A verified scheduler already committed the separate delivery intent.
        // Every other outcome must be acknowledged; false can mean a callback
        // persisted a queue but lost its acknowledgement. Never advance that row.
        const scheduled = row.type === 'send_message' && trigger === 'enter' && this.scheduleEnterMessage && result.status === 'scheduled';
        if (!scheduled && await this.journal.finishAction(key, action.id, result) !== true)
          fail('The action outcome was not acknowledged. Stop its owned work before advancing.', 'AUTOMATION_OUTCOME_UNSAVED');
        cleanupUnconfirmed ||= this.actions.jobs.has(action.id);
      }
      const final = await this.journal.read(key);
      return { duplicate: false, cancelled: external.aborted, safeToAdvance: !external.aborted && !cleanupUnconfirmed,
        outcomes: final.actions.filter(action => action.trigger === trigger) };
    }).finally(() => {
      clearTimeout(deadlineTimer);
      job.finished = true;
      // Retain an unresolved script tree so Cancel/shutdown can retry stopping it.
      if (!this.#ownsWork(job) && this.jobs.get(ownerKey) === job) this.jobs.delete(ownerKey);
    });
    return job.promise;
  }

  async #message(row, context, parentSignal, timeoutMs, key) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(new DOMException('Message acknowledgement budget expired.', 'TimeoutError')), Math.ceil(timeoutMs));
    const signal = AbortSignal.any([parentSignal, controller.signal]);
    const startedAt = performance.now();
    try {
      signal.throwIfAborted();
      const message = renderPipelineTemplate(row.message, pipelineTemplateVariables(context));
      const schedule = context.move.trigger === 'enter' && this.scheduleEnterMessage;
      const receiver = schedule || this.deliverMessage;
      const result = await abortable(Promise.resolve().then(() => { signal.throwIfAborted(); return receiver({ actionId: context.actionId,
        taskId: context.task.id, projectId: context.project?.id, message, mode: row.mode, trigger: context.move.trigger,
        ...(schedule ? { key: { projectId: key.projectId, taskId: key.taskId, transitionId: key.transitionId },
          expectedTaskRevision: context.task.revision, expectedProjectRevision: context.project?.revision } : {}) }, { signal }); }), signal);
      signal.throwIfAborted();
      if (schedule) {
        const action = (await this.journal.read(key))?.actions.find(action => action.id === context.actionId);
        signal.throwIfAborted();
        const messageHash = createHash('sha256').update(message).digest('hex');
        if (result?.scheduled === true && action?.status === 'scheduled' && action.delivery?.messageHash === messageHash
          && action.delivery.mode === row.mode && ['provider', 'sessionId', 'runId'].every(field => action.delivery[field] === result[field]))
          return { status: 'scheduled', durationMs: Math.round(performance.now() - startedAt) };
        return { status: 'unconfirmed', reason: 'Enter message scheduling was not confirmed.', durationMs: Math.round(performance.now() - startedAt) };
      }
      return { status: result?.confirmed === true ? 'succeeded' : 'unconfirmed', ...(result?.confirmed === true ? {} : { reason: 'Agent message delivery was not confirmed.' }), durationMs: Math.round(performance.now() - startedAt) };
    } catch {
      const timed = signal.aborted && signal.reason?.name === 'TimeoutError';
      return { status: signal.aborted ? (timed ? 'timed_out' : 'cancelled') : 'failed', errorCode: signal.aborted ? (timed ? 'MESSAGE_TIMEOUT' : 'MESSAGE_CANCELLED') : 'MESSAGE_FAILED',
        reason: 'The agent message did not confirm delivery.', durationMs: Math.round(performance.now() - startedAt) };
    } finally { clearTimeout(timer); }
  }

  cancel(key) {
    const job = this.jobs.get(taskKey(key)); if (!job) return false;
    job.controller.abort('move cancelled');
    for (const id of job.started) this.actions.cancel(id);
    return true;
  }

  async shutdown() {
    this.stopping = true;
    for (const job of this.jobs.values()) { job.controller.abort('shutdown'); for (const id of job.started) this.actions.cancel(id); }
    await Promise.allSettled([...this.jobs.values()].map(job => job.promise));
    await this.actions.shutdown();
  }
}
