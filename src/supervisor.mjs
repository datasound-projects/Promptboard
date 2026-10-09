/**
 * Agent session supervisor (PB-02). Runs board stages in interactive terminal sessions
 * (node-pty) inside task worktrees. Separate from prompt generation: it never touches
 * the single prompt job, and cancelling one run never stops another.
 *
 * Lifecycle comes from provider hook/notify events (agents.mjs), never from silence or
 * exit codes. A stage succeeds only when the user confirms it.
 */
import { randomUUID } from 'node:crypto';
import { access, chmod, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { constants, createWriteStream } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { ADAPTERS, AgentError, buildSession, composeMessage, interpretEvent, resolveConfig } from './agents.mjs';
import { CLAUDE_ERRORS, FAILURE_MESSAGES, killPidGroup, resolveExecutable, trackPid, untrackPid } from './providers.mjs';
import { addClaudeRecord, addCodexRecord, claudeTranscript, findCodexRollout, newUsage, readNewLines, usageSummary } from './usage.mjs';
import { prepareBase } from './base-context.mjs';
import { BaseDeliveryError, checkBaseRevocations } from './base-resolver.mjs';
import { SessionActivity } from './session-activity.mjs';
import { TerminalInputObservation } from './terminal-input-observation.mjs';
import { nativeMessageInputReadiness, sendOwnedNativeMessage } from './native-message-input.mjs';
import { untilStopped } from './native-message-common.mjs';

const RING_BYTES = 1024 * 1024; // Live scrollback kept per run for reconnects.
const LOG_BYTES = 20 * 1024 * 1024; // Output log file cap per run.
const INPUT_BYTES = 64 * 1024;
const LINGER_MS = 30 * 60 * 1000; // Keep a finished session's output for reconnects.
const ACTIVE = new Set(['queued', 'running', 'waiting_for_input']);
const PREPARATION_STOPPED = Object.freeze({
  TimeoutError: { code: 'PREPARATION_TIMEOUT', reason: 'Preparing the agent session took too long, so the agent was not started. Try again.' },
  AbortError: { code: 'PREPARATION_ABORTED', reason: 'Preparing the agent session was stopped before the agent started.' },
});
// xterm answers queries and focus changes with no keystroke: CPR, DA1/DA2, DSR, DECRPM, window
// and OSC colour reports, DECRQSS. Only modified F3 (ESC[1;<m>R) shares a shape with a CPR.
const TERMINAL_REPORTS = /^(?:\x1b\[(?:[?>]?[\d;]*c|\d*n|\??\d+;\d+R|[\d;]+t|\??\d+;\d+\$y|[IO])|\x1b\][\d;]+;[^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\)+$/;

/** Load node-pty once. On macOS its prebuilt helper can lose the execute bit on install. */
export async function loadPty(requireFrom = import.meta.url) {
  try {
    const require = createRequire(requireFrom);
    const entry = require.resolve('node-pty');
    if (process.platform !== 'win32') {
      const helper = join(dirname(entry), '..', 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
      if (await access(helper).then(() => true, () => false) && !(await access(helper, constants.X_OK).then(() => true, () => false))) await chmod(helper, 0o755);
    }
    return { pty: require('node-pty'), message: '' };
  } catch {
    return { pty: null, message: 'Agent terminals need the node-pty package. Run npm install in the Promptboard folder, then restart. On Linux, node-pty is built locally and needs python3, make, and a C++ compiler.' };
  }
}

export class Supervisor {
  #nativeMessageOwners = new WeakSet();
  constructor({ board, dataDir, ptyLoader = loadPty, resolver = resolveExecutable, nodePath = process.execPath, basePreparer = prepareBase }) {
    this.board = board;
    this.dataDir = dataDir;
    this.ptyLoader = ptyLoader;
    this.resolver = resolver;
    this.nodePath = nodePath;
    this.basePreparer = basePreparer;
    this.preparing = new Map();
    this.sessions = new Map(); // runId -> session
    this.queue = [];
    this.heldQueue = new Set();
    this.queuedHolds = new Map();
    this.boundaryWaits = new Map();
    this.pending = new Map(); // runId -> subscribers waiting for a queued run to start
    this.stopping = false;
  }

  async pty() { this.loaded ??= this.ptyLoader(); return this.loaded; }

  async describe() {
    const { pty, message } = await this.pty();
    return { available: Boolean(pty), setupMessage: message, providers: Object.fromEntries(Object.entries(ADAPTERS).map(([id, adapter]) => [id, { name: adapter.name, notLiveVerified: Boolean(adapter.notLiveVerified), ...adapter.capabilities, permissionModes: adapter.permissionModes }])) };
  }

  async validate({ stage, config }) {
    const { pty, message } = await this.pty();
    if (!pty) throw new AgentError(message, 'EXECUTION_SETUP_REQUIRED', 503);
    const resolved = resolveConfig(stage, config);
    if (!(await this.resolver(resolved.provider))) throw new AgentError(`${ADAPTERS[resolved.provider].name} is not installed. Install it and sign in from your terminal.`, 'NOT_INSTALLED', 409);
    return resolved;
  }

  activeCount() { return [...this.sessions.values()].filter(session => session.proc).length; }

  async limit() { return (await this.board.state()).settings.maxConcurrentRuns || 1; }

  /** Queue a run. Returns at once; the run starts when a slot is free. */
  async start({ run, task, planRunId, extra = '', continuation = '', firstPrompt = '' }) {
    this.queue.push({ runId: run.id, task, planRunId, extra, continuation, firstPrompt });
    this.#pump();
  }

  #pump() {
    if (this.stopping || this.pumping) return;
    this.pumping = (async () => {
      while (this.queue.length && !this.stopping) {
        if (this.activeCount() >= await this.limit()) break;
        if (this.heldQueue.has(this.queue[0]?.runId)) break; // Preserve FIFO while its destination is accepted.
        const next = this.queue.shift(); // Re-read after the await: a cancel may have emptied the queue.
        if (!next) break;
        (this.launching ??= new Set()).add(next.runId);
        await this.#launch(next).catch(error => this.#fail(next.runId, error)).finally(() => this.launching.delete(next.runId));
      }
    })().finally(() => { this.pumping = null; });
  }

  /** Keep a waiting run's FIFO slot while Board atomically retargets its configuration. */
  async retargetQueued(runId, accept, { hold = null } = {}) {
    const entry = this.queue.find(item => item.runId === runId);
    if (!entry || this.preparing.has(runId) || this.sessions.get(runId)?.proc) throw new AgentError('This agent is already starting. Wait for startup or pause it before changing settings.', 'RUN_STARTING', 409);
    const inheritedHold = hold !== null && this.queuedHolds.get(runId) === hold;
    if (this.heldQueue.has(runId) && !inheritedHold) throw new AgentError('This queued run is already changing destinations.', 'RUN_BUSY', 409);
    this.heldQueue.add(runId);
    try {
      const result = await accept();
      // A concurrent explicit Stop can remove this entry; never put it back.
      if (this.queue.includes(entry)) Object.assign(entry, result.payload);
      return result.run;
    } finally {
      if (!inheritedHold) this.heldQueue.delete(runId);
      if (this.pumping) this.pumping.finally(() => this.#pump()).catch(() => {});
      else this.#pump();
    }
  }

  /** Hold a known queued run while its column's actions finish, preserving FIFO. */
  holdQueued(runId) {
    if (!this.queue.some(item => item.runId === runId) || this.preparing.has(runId) || this.launching?.has(runId)) throw new AgentError('This queued agent is already starting. Wait for startup before changing its automation destination.', 'RUN_STARTING', 409);
    if (this.heldQueue.has(runId)) throw new AgentError('This queued run is already changing destinations.', 'RUN_BUSY', 409);
    const hold = Object.freeze({}); this.queuedHolds.set(runId, hold); this.heldQueue.add(runId);
    return hold;
  }

  releaseQueued(runId, hold) {
    if (!hold || this.queuedHolds.get(runId) !== hold) return false;
    this.queuedHolds.delete(runId); this.heldQueue.delete(runId);
    if (this.pumping) this.pumping.finally(() => this.#pump()).catch(() => {});
    else this.#pump();
    return true;
  }

  #endPending(runId) {
    for (const waiter of this.pending.get(runId) || []) waiter.handlers.end();
    this.pending.delete(runId);
  }

  async #fail(runId, error) {
    this.#endPending(runId);
    // AbortSignal.timeout/abort reject with a DOMException whose numeric code says nothing about the CLI.
    const stopped = PREPARATION_STOPPED[error?.name];
    const code = stopped ? stopped.code : typeof error?.code === 'string' ? error.code : 'CLI_FAILED';
    const reason = stopped ? stopped.reason : error instanceof AgentError || error instanceof BaseDeliveryError ? error.message : FAILURE_MESSAGES[code] || 'The agent session could not start.';
    const session = this.sessions.get(runId);
    // A spawn can succeed before manifest/status persistence fails. An unrecorded
    // process must never keep running after failed-start handling moves its card back.
    if (session?.proc) {
      session.launchFailed = true;
      session.failure = { code, reason };
      this.#kill(session);
      let timer;
      try { await Promise.race([session.exited, new Promise(resolve => { timer = setTimeout(resolve, 7000); })]); }
      finally { clearTimeout(timer); }
      if (session.proc) killPidGroup(session.proc.pid, 'SIGKILL');
    }
    const failed = await this.board.run(runId).catch(() => null);
    if (['cancelled', 'suspended'].includes(failed?.status)) return;
    // Preparation may unwind and leave the preparing map before shutdown visits
    // it. The stopping flag also covers that gap; shutdown is not a failed start.
    if (this.stopping || failed?.status === 'interrupted') {
      if (ACTIVE.has(failed?.status)) await this.board.updateRun(runId, { status: 'interrupted', reason: 'The app stopped during resource preparation.', endedAt: Date.now() }).catch(() => {});
      return;
    }
    const manifest = session?.baseManifest || failed?.baseManifest;
    if (manifest) await this.board.recordBaseManifest(runId, { ...manifest, deliveryState: 'failed', preparationError: { code, message: reason } }).catch(() => {});
    await this.board.updateRun(runId, { status: 'failed', errorCode: code, reason, endedAt: Date.now() }).catch(() => {});
    // The card entered the stage with this run; the session never began, so it returns to its previous column.
    if (!this.stopping && (await this.board.run(runId).catch(() => null))?.status === 'failed') await this.board.runFailedToStart?.(runId).catch(() => {});
  }

  async #launch(next) {
    const controller = new AbortController();
    this.preparing.set(next.runId, controller);
    let prepared;
    try { return await this.#launchSession(next, AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]), value => { prepared = value; }); }
    finally {
      this.preparing.delete(next.runId);
      const session = this.sessions.get(next.runId);
      if (!session?.proc) await prepared?.cleanup?.({ discardCaptures: !session });
    }
  }

  async #launchSession({ runId, task, planRunId, extra, continuation, firstPrompt }, signal, onPrepared) {
    const run = await this.board.run(runId);
    if (run.status !== 'queued') { this.#endPending(runId); return; } // Cancelled while queued.
    const { pty, message: setup } = await this.pty();
    if (!pty) throw new AgentError(setup, 'EXECUTION_SETUP_REQUIRED');
    const executable = await this.resolver(run.config.provider);
    if (!executable) throw new AgentError(`${ADAPTERS[run.config.provider].name} is not installed.`, 'NOT_INSTALLED');
    const runDir = join(this.dataDir, run.artifactsDir);
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    signal.throwIfAborted();
    const state = await this.board.state();
    const baseDelivery = await this.basePreparer({ manifest: run.baseManifest, readRevision: ref => this.board.base.readRevision(ref),
      currentResources: state.base?.resources || [], workspacePath: run.workspacePath, runDir, signal, approvedRoots: state.base?.approvedRoots || [] });
    onPrepared(baseDelivery);
    signal.throwIfAborted();
    const plan = planRunId ? await readFile(join(this.dataDir, 'runs', planRunId, 'plan.md'), 'utf8').catch(() => null) : null;
    const message = run.config.pipeline
      ? [run.resumeFrom ? continuation || '' : firstPrompt, (!run.resumeFrom || run.baseChanged) ? baseDelivery.sections : ''].filter(Boolean).join('\n\n')
      : run.resumeFrom ? continuation || '' : composeMessage(run.stage, task.prompt, plan, run.config.instructions || '', extra || '', baseDelivery.sections);
    // Stage instructions, the exact task text, and the plan are stored with the run.
    await writeFile(join(runDir, 'prompt.md'), message, { mode: 0o600 });
    await writeFile(join(runDir, 'task-prompt.txt'), task.prompt, { mode: 0o600 });
    const eventsFile = join(runDir, 'events.jsonl');
    await writeFile(eventsFile, '', { mode: 0o600 });
    const sessionId = run.resumeFrom?.nativeSessionId || randomUUID();
    const built = await buildSession({ provider: run.config.provider, stage: run.stage, config: run.config, message, runDir, eventsFile, sessionId,
      resumeId: run.resumeFrom?.nativeSessionId || null, workspacePath: run.workspacePath, nodePath: this.nodePath, baseDelivery });
    // Cancellation can arrive during CLI discovery or session preparation.
    if ((await this.board.run(runId)).status !== 'queued') { this.#endPending(runId); return; }
    signal.throwIfAborted();
    const currentBase = (await this.board.state()).base;
    checkBaseRevocations(run.baseManifest, currentBase?.resources || [], currentBase?.approvedRoots || []);
    const supplied = { ...baseDelivery.manifest, acceptedAt: run.baseManifest?.acceptedAt, deliveryState: 'supplied', suppliedAt: Date.now() };
    signal.throwIfAborted();
    const log = createWriteStream(join(runDir, 'output.log'), { flags: 'a', mode: 0o600 });
    log.on('error', () => {});
    let proc;
    try {
      proc = pty.spawn(executable.command, [...executable.prefix, ...built.args], {
        name: 'xterm-256color', cols: 120, rows: 32, cwd: run.workspacePath, env: { ...process.env, ...built.env },
      });
    } catch (error) { log.destroy(); throw error; }
    trackPid(proc.pid);
    const session = { runId, taskId: run.taskId, stage: run.stage, provider: run.config.provider, proc, seq: 0, ring: [], ringBytes: 0,
      subscribers: new Set(), log, logBytes: 0, eventsFile, eventsOffset: 0, runDir, paste: built.paste, turns: 0, status: 'running', startedAt: Date.now(), sessionId,
      pipeline: run.config.pipeline === true, inputEpoch: 0, resumeNativeId: run.resumeFrom?.nativeSessionId, baseCleanup: baseDelivery.cleanup, baseManifest: supplied };
    if (session.pipeline) {
      session.activity = new SessionActivity(session.provider);
      session.terminalInput = new TerminalInputObservation();
    }
    this.sessions.set(runId, session);
    session.exited = new Promise(resolve => { session.resolveExit = resolve; });
    // Listen before any await so early output and fast exits are never lost.
    proc.onData(data => this.#output(session, data));
    proc.onExit(({ exitCode, signal }) => { this.#exited(session, exitCode, signal).catch(() => {}).finally(() => session.resolveExit()); });
    // Streams opened while the run was queued attach now.
    for (const waiter of this.pending.get(runId) || []) waiter.attach();
    this.pending.delete(runId);
    await this.board.recordBaseManifest(runId, supplied);
    await writeFile(join(runDir, 'base-manifest.json'), `${JSON.stringify(supplied, null, 2)}\n`, { mode: 0o600 });
    await this.board.updateRun(runId, { status: 'running', startedAt: session.startedAt, providerSessionId: run.resumeFrom?.nativeSessionId || (run.config.provider === 'claude' ? sessionId : undefined), lifecycle: 'waiting-for-first-event' });
    if (!session.proc || session.exiting) return; // Exited during the update: #exited owns the outcome.
    this.#push(session, { status: 'running' });
    session.poll = setInterval(() => this.#readEvents(session).catch(() => {}), 250);
    session.usagePoll = setInterval(() => this.#readUsage(session).catch(() => {}), 3000);
    session.usagePoll.unref();
    // No event yet usually means the CLI is asking a startup question (such as folder trust).
    // Say so without claiming anything: the status stays running.
    session.watchdog = setTimeout(() => {
      if (session.proc && !session.sawEvent) this.board.updateRun(runId, { lifecycle: 'no-events-yet', waitingReason: 'No lifecycle event yet. The CLI may be asking a startup question, such as whether to trust this folder. Check the terminal.' }).catch(() => {});
    }, 10000);
    session.watchdog.unref();
    if (session.paste) {
      // Long prompts are pasted once the session is ready (bracketed paste keeps the text intact).
      const proc = session.proc;
      session.pasteTimer = setTimeout(() => { if (this.#ownsInitialInput(session, proc)) this.#paste(session); }, 15000);
    }
  }

  #paste(session) {
    if (!session.paste || !this.#ownsInitialInput(session, session.proc)) return;
    clearTimeout(session.pasteTimer);
    clearTimeout(session.pasteReadyTimer);
    const proc = session.proc, nativeId = session.nativeSessionId, text = session.paste;
    session.paste = null; // An unknown write outcome must never grant another paste.
    session.inputEpoch++;
    session.activity?.input();
    const epoch = session.inputEpoch;
    session.initialSubmitPending = true;
    try { proc.write(`\x1b[200~${text}\x1b[201~`); }
    catch { this.#initialInputUnconfirmed(session, true); return; }
    if (!session.initialSubmitPending) return;
    session.initialSubmitTimer = setTimeout(() => {
      session.initialSubmitPending = false;
      if (!this.#ownsInitialInput(session, proc) || session.inputEpoch !== epoch || session.nativeSessionId !== nativeId) {
        if (this.#ownsInitialProcess(session, proc)) this.#initialInputUnconfirmed(session);
        return;
      }
      session.inputEpoch++;
      session.activity?.input();
      try { proc.write('\r'); }
      catch { this.#initialInputUnconfirmed(session, true); }
    }, 300);
  }

  #ownsInitialInput(session, proc) {
    return this.#ownsInitialProcess(session, proc) && !session.initialInputUncertain && !session.eventsPending
      && !session.activity?.ended && !session.activity?.uncertain;
  }

  #ownsInitialProcess(session, proc) {
    return Boolean(proc && this.sessions.get(session.runId) === session && session.proc === proc && !this.stopping
      && !session.cancelled && !session.suspending && !session.exiting && !session.failure && !session.launchFailed && !session.confirmed
    );
  }

  #initialInputUnconfirmed(session, transportFailed = false) {
    clearTimeout(session.initialSubmitTimer); session.initialSubmitPending = false;
    session.activity?.input();
    if (transportFailed) session.initialInputUncertain = true;
    if (transportFailed && session.activity) session.activity.uncertain = true;
    const reason = transportFailed ? 'Initial prompt input was not confirmed. Check the terminal before continuing; no input will be retried.'
      : 'Initial prompt submission was cancelled because terminal ownership or input changed. Check the terminal before submitting.';
    this.#push(session, { initialInput: { status: 'unconfirmed', reason } });
    this.board.updateRun(session.runId, { lifecycle: 'initial-input-unconfirmed', waitingReason: reason, turnComplete: false }).catch(() => {});
  }

  #push(session, entry) {
    session.seq++;
    const item = { seq: session.seq, ...entry };
    const size = entry.data ? Buffer.byteLength(entry.data) : 64;
    session.ring.push({ item, size });
    session.ringBytes += size;
    while (session.ringBytes > RING_BYTES && session.ring.length > 1) session.ringBytes -= session.ring.shift().size;
    for (const subscriber of session.subscribers) subscriber.flush();
  }

  #output(session, data) {
    session.terminalInput?.observeOutput(data);
    session.activity?.output();
    this.#push(session, { data });
    if (session.logBytes < LOG_BYTES) {
      const chunk = session.logBytes + Buffer.byteLength(data) > LOG_BYTES ? '\n[Promptboard: output log limit reached]\n' : data;
      session.logBytes += Buffer.byteLength(chunk);
      session.log.write(chunk);
    }
  }

  async #readEvents(session) {
    if (session.eventRead) return session.eventRead;
    session.eventRead = this.#readEventBatch(session);
    try { return await session.eventRead; }
    finally { session.eventRead = null; this.#schedulePlanRoute(session); }
  }

  #schedulePlanRoute(session) {
    const approval = session.activity?.planApproval;
    if (!approval || !session.proc || session.cancelled || session.suspending || session.failure || session.launchFailed || session.messageInputPending || session.messageInputUncertain || this.#nativeMessageOwners.has(session) || this.stopping || session.planRouting) return;
    const key = JSON.stringify(approval);
    if (session.publishedPlanApprovalKey !== key) return; // Retry observation persistence before accepting the move.
    if (key === session.planRouteKey) return;
    // At most one attempt per native approval. A failed move is visible and can
    // be made explicitly; never restart/replay an uncertain automatic action.
    session.planRouteKey = key;
    const controller = new AbortController(); session.planRoutingController = controller;
    session.planRouting = Promise.resolve().then(() => this.board.routeApprovedPlan(session.runId, approval, { signal: controller.signal }))
      .catch(error => {
        this.#push(session, { planRoutingError: { code: error.code || 'PLAN_ROUTE_FAILED', reason: 'The approved plan could not be routed. Check the card and move it explicitly.' } });
      }).finally(() => { session.planRouting = null; session.planRoutingController = null; });
  }

  async #readEventBatch(session) {
    session.reading = true;
    try {
      const handle = await open(session.eventsFile, 'r');
      try {
        const { size } = await handle.stat();
        if (size < session.eventsOffset && session.activity) session.activity.uncertain = true;
        if (size <= session.eventsOffset) { session.eventsPending = false; return; }
        session.eventsPending = true;
        const buffer = Buffer.alloc(Math.min(size - session.eventsOffset, 8 * 1024 * 1024));
        await handle.read(buffer, 0, buffer.length, session.eventsOffset);
        const text = buffer.toString('utf8');
        const end = text.lastIndexOf('\n');
        if (end < 0) return;
        session.eventsOffset += Buffer.byteLength(text.slice(0, end + 1));
        for (const line of text.slice(0, end).split('\n')) {
          let event; try { event = JSON.parse(line); } catch { if (session.activity) session.activity.uncertain = true; continue; }
          if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.name !== 'string') {
            if (session.activity) session.activity.uncertain = true;
            continue;
          }
          if (event.name === 'SessionStart' && !event.agentId && !event.subordinate) {
            session.inputEpoch++;
            if (session.initialSubmitPending) this.#initialInputUnconfirmed(session);
          }
          if (session.activity) {
            session.activity.observe(event);
            // Subagent hooks share the parent's lifecycle file. A subordinate
            // Stop, failure or permission event must not finish/fail its parent.
            if (event.agentId || event.subordinate) continue;
          }
          if (session.pipeline && (!event.provider || event.provider === session.provider))
            session.messageLifecycleEpoch = (session.messageLifecycleEpoch || 0) + 1;
          await this.#locateUsage(session, event);
          await this.#signal(session, interpretEvent(session.provider, event));
          // Keep hook paths private. The receipt reader still validates the exact
          // native identity and file format before it grants any checkpoint.
          if (session.pipeline && (!event.provider || event.provider === session.provider) && !event.activityUncertain && event.sessionId === session.nativeSessionId && typeof event.transcriptPath === 'string'
            && ['claude', 'gemini'].includes(session.provider)) session.nativeHistoryPath = event.transcriptPath;
        }
        session.eventsPending = size > session.eventsOffset;
      } finally { await handle.close(); }
    } finally { try { await this.#publishActivity(session); } finally { session.reading = false; } }
  }

  async #publishActivity(session) {
    if (!session.activity || !session.proc || session.cancelled || session.suspending || session.launchFailed) return;
    const activity = this.#activity(session), key = JSON.stringify(activity);
    if (key === session.activityKey) return;
    await this.board.updateRun(session.runId, { activity });
    session.activityKey = key;
    session.publishedPlanApprovalKey = JSON.stringify(activity.planApproval || null);
    this.#push(session, { activity });
  }

  #activity(session) {
    const activity = session.activity.snapshot();
    if (session.eventsPending) return { ...activity, ready: false, uncertain: true, phase: activity.phase === 'ended' ? 'ended' : 'working' };
    return session.messageInputPending || this.#nativeMessageOwners.has(session) ? { ...activity, ready: false } : activity;
  }

  /** Find the CLI's own session file once: Claude names it in hook payloads, Codex by thread ID. */
  async #locateUsage(session, event) {
    if (session.usage) return;
    let path = null;
    if (session.provider === 'claude') path = claudeTranscript(event.transcriptPath, session.sessionId);
    else if (session.provider === 'codex' && event.sessionId) path = await findCodexRollout(event.sessionId, session.startedAt);
    if (path) session.usage = { tail: { path, offset: 0 }, acc: newUsage(session.provider === 'claude' ? 'claude-transcript' : 'codex-rollout'), last: '' };
  }

  /** Read new usage records; store and stream them only when the numbers changed. */
  async #readUsage(session) {
    if (!session.usage || session.readingUsage) return;
    session.readingUsage = true;
    try {
      const { usage } = session;
      for (const record of await readNewLines(usage.tail)) (session.provider === 'claude' ? addClaudeRecord : addCodexRecord)(usage.acc, record);
      const summary = usageSummary(usage.acc);
      const key = JSON.stringify({ ...summary, updatedAt: 0 });
      if (key === usage.last || (!summary.inputTokens && !summary.outputTokens)) return;
      usage.last = key;
      await this.board.updateRun(session.runId, { usage: summary }).catch(() => {});
      this.#push(session, { usage: summary });
    } finally { session.readingUsage = false; }
  }

  async #setStatus(session, status, fields = {}) {
    session.status = status;
    await this.board.updateRun(session.runId, { status, ...fields }).catch(() => {});
    this.#push(session, { status, ...(fields.waitingReason ? { reason: fields.waitingReason } : {}) });
  }

  async #signal(session, signal) {
    if (signal.kind === 'ignore' || !session.proc || session.cancelled || session.suspending || session.launchFailed) return;
    if (signal.sessionId) {
      if (session.resumeNativeId && signal.sessionId !== session.resumeNativeId) {
        session.failure = { code: 'SESSION_ID_MISMATCH', reason: 'The CLI opened a different conversation instead of the requested session. It was stopped; files and the original conversation are kept.' };
        await this.#setStatus(session, 'failed', { errorCode: session.failure.code, reason: session.failure.reason });
        this.#kill(session); return;
      }
      await this.board.updateRun(session.runId, { providerSessionId: signal.sessionId }).catch(() => {});
      session.nativeSessionId = signal.sessionId;
    }
    if (!session.sawEvent) { session.sawEvent = true; clearTimeout(session.watchdog); await this.board.updateRun(session.runId, { lifecycle: 'events-received', waitingReason: '' }).catch(() => {}); }
    if (signal.kind === 'started') {
      if (session.paste) {
        clearTimeout(session.pasteReadyTimer);
        const proc = session.proc;
        session.pasteReadyTimer = setTimeout(() => { if (this.#ownsInitialInput(session, proc)) this.#paste(session); }, 1500);
      }
    } else if (signal.kind === 'running') {
      if (session.status !== 'running') await this.#setStatus(session, 'running', { waitingReason: '', turnComplete: false });
    } else if (signal.kind === 'waiting') {
      // A permission prompt or question: the turn is not finished (Autopilot must not advance).
      await this.#setStatus(session, 'waiting_for_input', { waitingReason: signal.reason, turnComplete: false });
    } else if (signal.kind === 'turn_complete') {
      session.turns++;
      await this.#readUsage(session).catch(() => {});
      const planning = !session.pipeline && session.stage === 'planning', reviewing = !session.pipeline && session.stage === 'code_review';
      if (signal.message) await writeFile(join(session.runDir, planning ? 'plan.md' : reviewing ? 'review.md' : 'last-message.md'), signal.message, { mode: 0o600 });
      await this.#setStatus(session, 'waiting_for_input', {
        turns: session.turns, turnComplete: !session.initialInputUncertain && !session.messageInputPending && !session.messageInputUncertain, ...(planning && signal.message ? { hasPlan: true, planExcerpt: signal.message } : {}), ...(reviewing && signal.message ? { hasReview: true } : {}),
        waitingReason: session.messageInputUncertain ? 'Native message input remains unconfirmed. Check the terminal; automatic advancement is blocked.'
          : session.initialInputUncertain ? 'The agent finished a turn, but initial prompt input remains unconfirmed. Check the terminal; automatic advancement is blocked.'
          : planning ? (signal.message ? 'The plan is ready. Review it, continue in the terminal, or approve it.' : 'The agent finished its turn without a plan message. Continue in the terminal.')
          : reviewing ? 'The review is ready. Check the findings, then confirm to record them.'
          : session.pipeline ? 'The agent finished its turn. Continue in the terminal or move the card.' : 'The agent finished its turn. Review the work, continue in the terminal, or confirm the stage.',
      });
    } else if (signal.kind === 'failed') {
      // Account and quota failures are final for this run; there is no automatic retry.
      const code = CLAUDE_ERRORS[signal.error] || 'CLI_FAILED';
      session.failure = { code, reason: FAILURE_MESSAGES[code] };
      await this.#setStatus(session, 'failed', { errorCode: code, reason: FAILURE_MESSAGES[code] });
      this.#kill(session);
    }
  }

  #kill(session) {
    clearTimeout(session.pasteTimer); clearTimeout(session.pasteReadyTimer); clearTimeout(session.initialSubmitTimer);
    session.initialSubmitPending = false;
    session.terminalInput?.close();
    if (!session.proc) return;
    killPidGroup(session.proc.pid, 'SIGTERM');
    clearTimeout(session.killTimer);
    session.killTimer = setTimeout(() => { if (session.proc) killPidGroup(session.proc.pid, 'SIGKILL'); }, 3000);
    session.killTimer.unref();
  }

  async #exited(session, exitCode, signal) {
    session.exiting = true;
    clearTimeout(session.pasteReadyTimer); clearTimeout(session.initialSubmitTimer); session.initialSubmitPending = false;
    session.terminalInput?.close();
    clearInterval(session.poll); clearInterval(session.usagePoll); clearTimeout(session.pasteTimer); clearTimeout(session.watchdog);
    // Read the last lifecycle events (for example a final Stop) and usage before the session closes.
    await this.#readEvents(session).catch(() => {});
    await this.#readUsage(session).catch(() => {});
    untrackPid(session.proc.pid);
    session.proc = null;
    try { await session.baseCleanup?.(); } catch { /* Continue closing the owned session even if a temporary file cannot be removed. */ }
    clearTimeout(session.killTimer);
    await new Promise(resolve => session.log.end(resolve));
    const endedAt = Date.now();
    session.activity?.observe({ name: 'SessionEnd' });
    const exit = { exitCode: Number.isInteger(exitCode) ? exitCode : null, endedAt,
      ...(session.activity ? { activity: session.activity.snapshot() } : {}) };
    const current = await this.board.run(session.runId).catch(() => null);
    if (!current) { /* Run removed. */ }
    else if (session.confirmed) await this.board.updateRun(session.runId, exit).catch(() => {});
    else if (session.failure || current.status === 'failed') await this.board.updateRun(session.runId, exit).catch(() => {});
    else if (session.suspended) await this.#finish(session, 'suspended', { ...exit, reason: session.suspensionReason || 'Paused by you. The conversation, worktree and output are kept.' });
    else if (session.cancelled) await this.#finish(session, 'cancelled', { ...exit, reason: 'Stopped by you. The worktree and output are kept.' });
    else if (ACTIVE.has(current.status)) {
      // An exit is not a confirmation. The user checks the worktree and decides.
      await this.#finish(session, 'interrupted', { ...exit, reason: `The agent session ended${exitCode ? ` with exit code ${exitCode}` : ''}${signal ? ` (signal ${signal})` : ''} before you confirmed the stage. The worktree and output are kept.` });
    }
    this.#push(session, { ended: true, status: (await this.board.run(session.runId).catch(() => ({ status: 'interrupted' }))).status });
    for (const subscriber of session.subscribers) subscriber.end();
    session.subscribers.clear();
    session.lingerTimer = setTimeout(() => this.sessions.delete(session.runId), LINGER_MS);
    session.lingerTimer.unref();
    this.#pump();
  }

  async #finish(session, status, fields) {
    await this.board.updateRun(session.runId, { status, ...fields }).catch(() => {});
  }

  #session(runId) {
    const session = this.sessions.get(runId);
    if (!session?.proc) throw new AgentError('This run has no live terminal session.', 'SESSION_NOT_LIVE', 409);
    return session;
  }

  input(runId, data) {
    if (typeof data !== 'string' || Buffer.byteLength(data) > INPUT_BYTES) throw new AgentError(`Send at most ${INPUT_BYTES / 1024} KiB of input at a time.`, 'INPUT_TOO_LARGE', 413);
    const session = this.#session(runId);
    if (session.suspending) throw new AgentError('The agent is being paused. Wait for it to exit before resuming.', 'SESSION_SUSPENDING', 409);
    // A terminal report is not human input. Drop it during a native paste so it cannot land inside the message.
    if (TERMINAL_REPORTS.test(data)) { if (!session.messageInputPending) session.proc.write(data); return; }
    if (data) {
      session.terminalInput?.manualInput(data);
      session.inputEpoch++; session.activity?.input();
      const initialPastePending = Boolean(session.paste);
      if (initialPastePending) {
        // A human owns the input before transport, even if their write fails.
        // Startup events must never append the task to their partial draft.
        session.paste = null;
        clearTimeout(session.pasteTimer); clearTimeout(session.pasteReadyTimer);
      }
      if (initialPastePending || session.initialSubmitPending) this.#initialInputUnconfirmed(session);
    }
    session.proc.write(data);
    if (session.status === 'waiting_for_input' && /\r|\n/.test(data)) this.#setStatus(session, 'running', { waitingReason: '' });
  }

  /** Private cached observation: no input, hook processing, grant or session selection. */
  nativeMessageReadiness(runId) {
    const session = this.sessions.get(runId), proc = session?.proc;
    if (!session?.pipeline || !this.#ownsInitialProcess(session, proc)) return 'unavailable';
    if (this.#nativeMessageOwners.has(session)) return 'waiting';
    return nativeMessageInputReadiness(session, () => this.#ownsInitialProcess(session, proc));
  }

  /** Private transport seam used by the connected deferred column scheduler. */
  async sendNativeMessage(runId, request) {
    const session = this.sessions.get(runId), proc = session?.proc;
    if (!session?.pipeline || !proc) return { status: 'unavailable', confirmed: false, reason: 'The owned pipeline process is unavailable.' };
    if (session.messageInputUncertain) return { status: 'unavailable', confirmed: false, reason: 'Native input remains unconfirmed for this process. No input will be retried.' };
    const timeoutMs = request?.timeoutMs ?? 150000, started = performance.now();
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 150000 || this.#nativeMessageOwners.has(session))
      return { status: 'unavailable', confirmed: false, reason: 'This process cannot grant another native input attempt.' };
    this.#nativeMessageOwners.add(session);
    const remaining = () => timeoutMs - (performance.now() - started);
    const bounded = callback => untilStopped(() => request?.signal?.aborted || remaining() <= 0 || !this.#ownsInitialProcess(session, proc), callback);
    let result;
    try {
      let run;
      try { run = await bounded(() => this.board.run(runId)); await bounded(() => this.#readEvents(session)); }
      catch { return { status: 'unavailable', confirmed: false, reason: 'The owned pipeline lifecycle is unavailable.' }; }
      if (!run?.config?.pipeline || run.id !== runId || run.config.provider !== session.provider || !ACTIVE.has(run.status) || remaining() <= 0)
        return { status: 'unavailable', confirmed: false, reason: 'The owned pipeline run is unavailable.' };
      result = await sendOwnedNativeMessage({ ...request, timeoutMs: remaining(), session, run,
        // A pending hook changes readiness, not custody of this process. The
        // transport drains hooks and checks pending input at each write boundary.
        owns: () => this.#ownsInitialProcess(session, proc) && !session.initialInputUncertain && !session.messageInputUncertain
          && !session.activity?.ended && !session.activity?.uncertain,
        readEvents: () => this.#readEvents(session) });
      if (session.messageInputUncertain) {
        const reason = 'Native message input remains unconfirmed. Check the terminal; no input will be retried.';
        this.#push(session, { messageInput: { status: 'unconfirmed', reason } });
        await bounded(() => this.board.updateRun(runId, { lifecycle: 'message-input-unconfirmed', waitingReason: reason, turnComplete: false })).catch(() => {});
      } else if (result.confirmed && this.#ownsInitialInput(session, proc)) {
        // A receipt proves input only. Completion still requires the independently
        // observed main Stop, never queue acceptance or transport success.
        try {
          await bounded(() => this.board.updateRun(runId, { turnComplete: Boolean(session.activity?.parentComplete) }));
          await bounded(() => this.#publishActivity(session));
        } catch {
          session.messageInputUncertain = true; session.activity.uncertain = true;
          result = { status: 'unconfirmed', confirmed: false, reason: 'Native input outcome publication was not acknowledged. No input will be retried.' };
        }
      }
      return result;
    } finally { this.#nativeMessageOwners.delete(session); }
  }

  resize(runId, cols, rows) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 500 || rows < 5 || rows > 300) throw new AgentError('Use 20–500 columns and 5–300 rows.', 'INVALID_SIZE');
    this.#session(runId).proc.resize(cols, rows);
  }

  /** Stop one run. Only that run's own process group is signalled. */
  async cancel(runId, { withinAutomationMove = null } = {}) {
    const cancelledHandoff = this.abortBoundary(runId, 'stop');
    const run = await this.board.run(runId);
    this.board.abortAutomationTask?.(run.taskId, { exceptTransitionId: withinAutomationMove });
    if (cancelledHandoff && !ACTIVE.has(run.status) && run.sessionId) {
      const session = (await this.board.state()).sessions.find(item => item.id === run.sessionId);
      if (session?.currentRunId && session.currentRunId !== runId) return this.cancel(session.currentRunId);
    }
    const stopping = this.sessions.get(runId)?.cancelPromise;
    if (stopping) return stopping; // Also share a stop while final status is being saved.
    if (!ACTIVE.has(run.status)) return; // Stopping an already-ended run is harmless.
    const queued = this.queue.findIndex(item => item.runId === runId);
    if (queued >= 0 || ((run.status === 'queued' || this.launching?.has(runId)) && !this.sessions.get(runId)?.proc)) {
      this.preparing.get(runId)?.abort();
      if (queued >= 0) this.queue.splice(queued, 1);
      await this.board.updateRun(runId, { status: 'cancelled', reason: 'Cancelled before it started.', endedAt: Date.now() });
      this.#endPending(runId);
      // A spawn may have raced the state write; stop that owned process too.
      const started = this.sessions.get(runId);
      if (started?.proc) await this.#cancelSession(started);
      return;
    }
    const session = this.#session(runId);
    await this.#cancelSession(session);
  }

  /** Pause a queued/preparing or owned live process, preserving the exact native conversation. */
  async suspend(runId, { withinAutomationMove = null } = {}) {
    this.abortBoundary(runId);
    const run = await this.board.run(runId);
    this.board.abortAutomationTask?.(run.taskId, { exceptTransitionId: withinAutomationMove });
    if (!ACTIVE.has(run.status)) return;
    const session = this.sessions.get(runId);
    if (session?.cancelPromise) return session.cancelPromise;
    if (session) session.suspending = true;
    try { await this.board.beginSuspension(runId); }
    catch (error) { if (session) session.suspending = false; throw error; }
    const queued = this.queue.findIndex(item => item.runId === runId);
    if (queued >= 0 || ((run.status === 'queued' || this.launching?.has(runId)) && !this.sessions.get(runId)?.proc)) {
      this.preparing.get(runId)?.abort();
      if (queued >= 0) this.queue.splice(queued, 1);
      await this.board.updateRun(runId, { status: 'suspended', endedAt: Date.now(), reason: 'Paused before the agent started. Start a fresh run when ready.' });
      this.#endPending(runId);
      const started = this.sessions.get(runId);
      if (started?.proc) await this.#cancelSession(started, true);
      return;
    }
    await this.#cancelSession(this.#session(runId), true);
  }

  abortBoundary(runId, reason = 'pause') {
    const controller = this.boundaryWaits.get(runId), plan = this.sessions.get(runId)?.planRoutingController;
    controller?.abort(reason); plan?.abort(reason); return Boolean(controller || plan);
  }

  /** A column move may replace only an owned, observably settled pipeline process. */
  async suspendAtBoundary(runId, { prepare, guard, currentGuard, resume, requiredApproval = null, signal = null, timeoutMs = 120000 } = {}) {
    const session = this.#session(runId);
    if (!session.activity || !session.pipeline) throw new AgentError('This session cannot report a pipeline turn boundary.', 'PIPELINE_RECONFIGURE_REQUIRED', 409);
    if (this.boundaryWaits.has(runId) || session.suspending || session.cancelPromise) throw new AgentError('This agent is already changing settings or stopping.', 'RUN_BUSY', 409);
    const controller = new AbortController(), token = randomUUID(), deadline = Date.now() + timeoutMs;
    const externalAbort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', externalAbort, { once: true });
    if (signal?.aborted) externalAbort();
    this.boundaryWaits.set(runId, controller);
    const cancelled = () => new AgentError('The settings change was cancelled. The card stays in its current column.', 'PIPELINE_RECONFIGURE_CANCELLED', 409);
    const timedOut = () => new AgentError('The agent did not reach a settled native turn boundary. Its process and card were kept; finish the turn or pause it before retrying.', 'PIPELINE_BOUNDARY_TIMEOUT', 409);
    const check = () => {
      if (controller.signal.aborted || this.stopping) throw cancelled();
      if (!session.proc || session.cancelled || session.failure || session.launchFailed) throw new AgentError('The original agent is no longer available for this settings change.', 'SESSION_NOT_LIVE', 409);
      if (requiredApproval && JSON.stringify(session.activity.planApproval) !== JSON.stringify(requiredApproval)) throw new AgentError('Native plan approval changed while waiting. The automatic move was cancelled.', 'PLAN_APPROVAL_STALE', 409);
      if (Date.now() >= deadline) throw timedOut();
    };
    try {
      // Validation is read-only. An unresponsive resolver must not hold the
      // task lock or block an explicit Pause beyond the handoff's budget.
      let timer, onAbort;
      try {
        check();
        await Promise.race([Promise.resolve().then(() => prepare?.()), new Promise((_, reject) => {
          onAbort = () => reject(cancelled()); controller.signal.addEventListener('abort', onAbort, { once: true });
          timer = setTimeout(() => reject(timedOut()), Math.max(0, deadline - Date.now()));
          if (controller.signal.aborted) onAbort();
        })]);
      } finally { clearTimeout(timer); if (onAbort) controller.signal.removeEventListener('abort', onAbort); }
      check();
      for (;;) {
        check();
        await this.#readEvents(session); check();
        if (!this.#activity(session).ready) {
          await new Promise(resolve => { const timer = setTimeout(done, 100); function done() { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); } controller.signal.addEventListener('abort', done, { once: true }); });
          continue;
        }
        // Block input while the atomic guard and final hook drain are pending.
        session.suspending = true;
        let intentSaved = false;
        try {
          await this.board.beginSuspension(runId, { intent: 'system', token, guard }); intentSaved = true;
          await this.#readEvents(session); check();
          currentGuard?.(); // No await between the final committed-state check and signalling.
          if (!this.#activity(session).ready) continue;
          session.suspensionReason = 'Suspended at a native turn boundary to apply column settings. The conversation, worktree and output are kept.';
          await this.#cancelSession(session, true);
          if (controller.signal.aborted || this.stopping) throw new AgentError('The settings change was cancelled. The saved conversation stays paused in its current column.', 'PIPELINE_RECONFIGURE_CANCELLED', 409);
          return resume ? await resume(AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))])) : undefined;
        } finally {
          // New output/hooks during persistence revoke the lease. Do not signal
          // the process, and never erase another caller's pause intent.
          if (!session.suspended) {
            if (intentSaved) await this.board.abortSuspension(runId, token);
            session.suspending = false;
          }
        }
      }
    } finally { this.boundaryWaits.delete(runId); signal?.removeEventListener('abort', externalAbort); }
  }

  async #cancelSession(session, suspended = false) {
    if (session.cancelPromise) return session.cancelPromise;
    if (suspended) { session.suspended = true; session.suspending = true; }
    else session.cancelled = true;
    clearTimeout(session.pasteTimer);
    session.cancelPromise = (async () => {
      this.#kill(session);
      let timer;
      try {
        await Promise.race([session.exited, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new AgentError('The agent has not exited yet. Try Stop again; its files and output are kept.', 'STOP_TIMEOUT', 409)), 7000);
        })]);
        if (ACTIVE.has((await this.board.run(session.runId)).status)) throw new AgentError('The agent exited, but its final status could not be saved. Refresh the board before retrying.', 'STOP_STATE_UNSAVED', 409);
      } finally { clearTimeout(timer); }
    })();
    try { await session.cancelPromise; }
    catch (error) { session.cancelPromise = null; throw error; }
  }

  /**
   * The user confirms the stage. Planning needs a captured plan and records its approval.
   * The agent session then ends; the worktree stays.
   */
  async confirm(runId) {
    const run = await this.board.run(runId);
    if (run.config.pipeline) throw new AgentError('Move this pipeline card or pause its agent; a finished turn does not complete a stage.', 'PIPELINE_STAGE_CONFIRM_UNAVAILABLE', 409);
    if (run.status !== 'waiting_for_input' || !run.turns) throw new AgentError('Confirm after the agent has finished a turn and is waiting.', 'NOT_CONFIRMABLE', 409);
    if (run.stage === 'planning') await this.board.approvePlan(run.taskId, { runId });
    // A confirmed review records its findings for the reviewed commits; accepting it is a separate step.
    if (run.stage === 'code_review') await this.board.delivery.recordReview(run, await readFile(join(this.dataDir, run.artifactsDir, 'review.md'), 'utf8').catch(() => ''));
    await this.board.updateRun(runId, { status: 'succeeded', reason: run.stage === 'planning' ? 'Plan approved by you.' : run.stage === 'code_review' ? 'Review completed; accept it or send it back.' : 'Stage confirmed by you.', endedAt: Date.now() });
    const session = this.sessions.get(runId);
    if (session?.proc) { session.confirmed = true; this.#push(session, { status: 'succeeded' }); this.#kill(session); }
    if (['executing', 'testing'].includes(run.stage)) await this.board.recordStageResult(run, await readFile(join(this.dataDir, run.artifactsDir, 'last-message.md'), 'utf8').catch(() => ''));
  }

  /** Read a run artifact (plan, last message, or the tail of the output log). */
  async artifact(runId, name) {
    const run = await this.board.run(runId);
    const file = { plan: 'plan.md', review: 'review.md', 'last-message': 'last-message.md', output: 'output.log' }[name];
    const path = join(this.dataDir, run.artifactsDir, file);
    const handle = await open(path, 'r').catch(() => null);
    if (!handle) return '';
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, 2 * 1024 * 1024);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      return buffer.toString('utf8');
    } finally { await handle.close(); }
  }

  /** Stream subscription with ordered sequence numbers and write backpressure. */
  subscribe(runId, after, handlers) {
    const session = this.sessions.get(runId);
    if (!session) {
      // A queued or starting run has no session yet: wait for it instead of reporting it missing.
      if (!this.queue.some(item => item.runId === runId) && !this.launching?.has(runId)) return null;
      let detach = null;
      const waiter = { handlers, attach: () => { detach = this.subscribe(runId, after, handlers); } };
      if (!this.pending.has(runId)) this.pending.set(runId, new Set());
      this.pending.get(runId).add(waiter);
      return () => { this.pending.get(runId)?.delete(waiter); detach?.(); };
    }
    const { write, onDrain, end } = handlers;
    let last = Number.isInteger(after) && after >= 0 ? after : 0;
    let paused = false;
    const replayTo = session.seq; // Already-produced items: the page must not answer their old terminal queries.
    const subscriber = {
      flush() {
        if (paused) return;
        const first = session.ring[0]?.item.seq ?? session.seq + 1;
        if (last < first - 1) { write({ gap: true, from: last + 1, to: first - 1 }); last = first - 1; }
        for (const { item } of session.ring) {
          if (item.seq <= last) continue;
          last = item.seq;
          if (!write(item.seq <= replayTo && item.data ? { ...item, replay: true } : item)) { paused = true; onDrain(() => { paused = false; subscriber.flush(); }); return; }
        }
      },
      end,
    };
    session.subscribers.add(subscriber);
    subscriber.flush();
    if (!session.proc) { session.subscribers.delete(subscriber); end(); }
    return () => session.subscribers.delete(subscriber);
  }

  /** Shutdown: stop owned sessions, record them as interrupted, and end streams. */
  async shutdown(graceMs = 3000) {
    for (const controller of this.boundaryWaits.values()) controller.abort('shutdown');
    for (const session of this.sessions.values()) session.planRoutingController?.abort('shutdown');
    this.stopping = true;
    for (const [runId, controller] of this.preparing) {
      controller.abort();
      await this.board.updateRun(runId, { status: 'interrupted', reason: 'The app stopped during resource preparation.', endedAt: Date.now() }).catch(() => {});
    }
    for (const { runId } of this.queue.splice(0)) { await this.board.updateRun(runId, { status: 'interrupted', reason: 'The app stopped before this run started.' }).catch(() => {}); this.#endPending(runId); }
    const live = [...this.sessions.values()].filter(session => session.proc);
    for (const session of live) killPidGroup(session.proc.pid, 'SIGTERM');
    const deadline = Date.now() + graceMs;
    while (live.some(session => session.proc) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    for (const session of live) if (session.proc) killPidGroup(session.proc.pid, 'SIGKILL');
    for (const session of live) {
      await this.board.updateRun(session.runId, { status: 'interrupted', reason: 'The app stopped during this run. The worktree and output are kept.', endedAt: Date.now() }).catch(() => {});
      for (const subscriber of session.subscribers) subscriber.end();
    }
    for (const session of this.sessions.values()) clearTimeout(session.lingerTimer);
  }
}
