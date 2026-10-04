/** Owned asynchronous deferred enter-message scheduling for Board transitions. */
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeMessageDispatch } from './native-message-dispatch.mjs';
import { captureNativeMessageTarget } from './native-message-target.mjs';

const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const ownerId = (key, actionId) => JSON.stringify([key.projectId, key.taskId, key.transitionId, actionId]);
const same = (left, right) => ['provider', 'sessionId', 'runId', 'mode', 'messageHash'].every(field => left?.[field] === right?.[field]);
const outcome = (status, blocked = false) => ({ status, confirmed: false, reason: 'Scheduled native delivery was not confirmed. No input will be retried.', ...(blocked ? { blocked: true } : {}) });

export class NativeMessageScheduler {
  constructor({ board, journal, supervisor }) {
    if (typeof board?.state !== 'function' || !journal) throw new TypeError('Use an owned Board and message journal.');
    this.board = board; this.journal = journal; this.dispatch = new NativeMessageDispatch({ journal, supervisor });
    this.jobs = new Map(); this.completed = new Map(); this.tails = new Map(); this.blockedRuns = new Set(); this.stopping = false;
  }

  schedule({ key, actionId, runId, message, mode, expectedTaskRevision, expectedProjectRevision }, { signal = null, timeoutMs = 150000 } = {}) {
    if (this.stopping || !key || !['projectId', 'taskId', 'transitionId'].every(field => id(key[field])) || !id(actionId) || !id(runId)
      || mode !== 'deferred' || typeof message !== 'string' || !message.isWellFormed() || !message.trim() || Buffer.byteLength(message) > 65536
      || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(message) || message.trimStart().startsWith('/')
      || ![expectedTaskRevision, expectedProjectRevision].every(value => Number.isSafeInteger(value) && value > 0)
      || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 150000) return Promise.resolve({ scheduled: false });
    key = Object.fromEntries(['projectId', 'taskId', 'transitionId'].map(field => [field, key[field]]));
    const identity = ownerId(key, actionId), existing = this.jobs.get(identity) || this.completed.get(identity);
    if (existing) return existing.runId === runId && existing.messageHash === hash(message)
      && existing.expectedTaskRevision === expectedTaskRevision && existing.expectedProjectRevision === expectedProjectRevision
      ? existing.handoff : Promise.resolve({ scheduled: false });
    if (this.jobs.size >= 1000 || this.blockedRuns.has(runId)) return Promise.resolve({ scheduled: false });
    const controller = new AbortController(), deadline = new AbortController(), started = performance.now();
    const combined = AbortSignal.any([controller.signal, deadline.signal, ...(signal ? [signal] : [])]);
    const timer = setTimeout(() => deadline.abort(new DOMException('Scheduler budget expired.', 'TimeoutError')), Math.ceil(timeoutMs));
    const job = { key, actionId, runId, messageHash: hash(message), expectedTaskRevision, expectedProjectRevision,
      controller, knownQueue: false, saveAttempted: false, blocked: false, finished: false };
    this.jobs.set(identity, job);
    const remaining = () => timeoutMs - (performance.now() - started);
    const bounded = callback => new Promise((resolve, reject) => {
      const finish = (fn, value) => { combined.removeEventListener('abort', abort); fn(value); };
      const abort = () => finish(reject, new Error('Scheduled input stopped.'));
      combined.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => { combined.throwIfAborted(); return callback(); }).then(value => finish(resolve, value), error => finish(reject, error));
      if (combined.aborted) abort();
    });
    const stopped = () => combined.aborted ? combined.reason?.name === 'TimeoutError' ? 'timed_out' : 'cancelled' : 'unconfirmed';
    const finishQueue = async () => {
      if (!job.saveAttempted) return outcome(stopped());
      if (!job.knownQueue) { job.blocked = true; return outcome(stopped(), true); }
      // A cancelled delivery still has a small, bounded durable cleanup budget.
      const saved = await new Promise(resolve => {
        let settled = false;
        const finish = value => { if (settled) return; settled = true; clearTimeout(cleanup); resolve(value === true); };
        const cleanup = setTimeout(() => finish(false), 1500);
        Promise.resolve().then(() => this.journal.finishQueuedMessageDelivery(key, actionId,
          { status: stopped(), reason: 'Scheduled delivery stopped before input. No input was supplied.' })).then(finish, () => finish(false));
      });
      job.blocked = saved !== true;
      return outcome(stopped(), job.blocked);
    };
    job.handoff = (async () => {
      try {
        const state = await bounded(() => this.board.state());
        const target = captureNativeMessageTarget(state, { projectId: key.projectId, taskId: key.taskId, runId });
        if (!target || target.provider === 'codex' && /^<(?:environment_context|user_instructions)>/.test(message)) return { scheduled: false };
        const move = await bounded(() => this.journal.read(key)), action = move?.actions.find(row => row.id === actionId);
        const project = state.projects.find(row => row.id === key.projectId), task = project.tasks.find(row => row.id === key.taskId);
        if (task.revision !== expectedTaskRevision || project.revision !== expectedProjectRevision) return { scheduled: false };
        const preparingMatches = current => {
          const currentProject = current.projects?.find(row => row.id === key.projectId), currentTask = currentProject?.tasks?.find(row => row.id === key.taskId);
          return target.matches(current) && currentProject.revision === expectedProjectRevision && currentTask.revision === expectedTaskRevision;
        };
        const column = project.pipeline.columns.find(row => row.id === task.column), row = column.automations?.onEnter?.find(row => row.id === action?.rowId);
        if (move?.ownerPid !== process.pid || move.phase !== 'enter' || move.lifecycle.status !== 'succeeded' || move.to.id !== task.column
          || action?.status !== 'running' || action.type !== 'send_message' || action.trigger !== 'enter'
          || !row?.enabled || row.type !== 'send_message' || row.mode !== mode || action.configHash !== hash(JSON.stringify(row))) return { scheduled: false };
        job.target = target; job.scope = { provider: target.provider, sessionId: target.sessionId, runId, mode, messageHash: hash(message) };
        if (!preparingMatches(await bounded(() => this.board.state()))) return { scheduled: false };
        job.saveAttempted = true;
        const saved = await bounded(() => this.journal.scheduleMessage(key, actionId, job.scope));
        if (saved?.accepted === false) { job.saveAttempted = false; return { scheduled: false }; }
        if (saved?.accepted !== true || saved.delivery?.status !== 'queued' || !same(saved.delivery, job.scope)) return { scheduled: false };
        job.knownQueue = true;
        const recorded = await bounded(() => this.journal.read(key)), receipt = recorded?.actions.find(row => row.id === actionId);
        if (recorded?.ownerPid !== process.pid || receipt?.status !== 'scheduled' || receipt.delivery?.status !== 'queued'
          || !same(receipt.delivery, job.scope) || !preparingMatches(await bounded(() => this.board.state()))) return { scheduled: false };
        combined.throwIfAborted();
        return { scheduled: true, provider: target.provider, sessionId: target.sessionId, runId };
      } catch { return { scheduled: false }; }
    })();
    const previous = this.tails.get(runId) || Promise.resolve();
    job.done = (async () => {
      try {
        const handoff = await job.handoff;
        if (!handoff.scheduled) return await finishQueue();
        await bounded(() => previous);
        if (this.blockedRuns.has(runId)) return await finishQueue();
        for (;;) {
          const state = await bounded(() => this.board.state());
          if (!job.target.matches(state)) return await finishQueue();
          if (state.runs.find(row => row.id === runId).status !== 'queued') break;
          await delay(50, undefined, { signal: combined });
        }
        combined.throwIfAborted();
        const result = await this.dispatch.deliver({ key, actionId, message, scope: job.scope },
          { signal: combined, timeoutMs: Math.max(1, remaining()), preflight: async () => job.target.matches(await bounded(() => this.board.state())) });
        job.blocked = result.blocked === true;
        return result;
      } catch { return await finishQueue(); }
      finally {
        clearTimeout(timer); job.finished = true;
        if (job.blocked) this.blockedRuns.add(runId);
        else {
          this.jobs.delete(identity);
          this.completed.set(identity, job);
          if (this.completed.size > 1000) this.completed.delete(this.completed.keys().next().value);
        }
      }
    })();
    // Reserve FIFO at invocation time, including preparation and queued startup.
    const tail = previous.catch(() => null).then(() => job.done);
    this.tails.set(runId, tail);
    tail.finally(() => { if (!this.blockedRuns.has(runId) && this.tails.get(runId) === tail) this.tails.delete(runId); });
    return job.handoff;
  }

  wait(key, actionId) { const identity = ownerId(key, actionId); return (this.jobs.get(identity) || this.completed.get(identity))?.done ?? Promise.resolve(outcome('unavailable')); }
  cancel(key, actionId) { const job = this.jobs.get(ownerId(key, actionId)); job?.controller.abort('Scheduled message stopped.'); return Boolean(job); }
  ownsTask(taskId) { return [...this.jobs.values()].some(job => job.key.taskId === taskId && !job.finished); }
  cancelTask(taskId, { exceptTransitionId = null } = {}) {
    const jobs = [...this.jobs.values()].filter(job => job.key.taskId === taskId && !job.finished && job.key.transitionId !== exceptTransitionId);
    for (const job of jobs) job.controller.abort('Scheduled task messages stopped.');
    return jobs.length > 0;
  }
  async waitTask(taskId) { await Promise.allSettled([...this.jobs.values()].filter(job => job.key.taskId === taskId).map(job => job.done)); }
  async shutdown() {
    this.stopping = true;
    for (const job of this.jobs.values()) job.controller.abort('shutdown');
    await Promise.allSettled([...this.jobs.values()].map(job => job.done));
    await this.dispatch.shutdown();
  }
}
