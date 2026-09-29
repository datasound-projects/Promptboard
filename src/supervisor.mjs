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
import { ADAPTERS, AgentError, buildSession, composeMessage, HOOK_ERRORS, interpretEvent, resolveConfig } from './agents.mjs';
import { FAILURE_MESSAGES, killPidGroup, resolveExecutable, trackPid, untrackPid } from './providers.mjs';

const RING_BYTES = 1024 * 1024; // Live scrollback kept per run for reconnects.
const LOG_BYTES = 20 * 1024 * 1024; // Output log file cap per run.
const INPUT_BYTES = 64 * 1024;
const LINGER_MS = 30 * 60 * 1000; // Keep a finished session's output for reconnects.
const ACTIVE = new Set(['queued', 'running', 'waiting_for_input']);

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
  constructor({ board, dataDir, ptyLoader = loadPty, resolver = resolveExecutable, nodePath = process.execPath }) {
    this.board = board;
    this.dataDir = dataDir;
    this.ptyLoader = ptyLoader;
    this.resolver = resolver;
    this.nodePath = nodePath;
    this.sessions = new Map(); // runId -> session
    this.queue = [];
    this.pending = new Map(); // runId -> subscribers waiting for a queued run to start
    this.stopping = false;
  }

  async pty() { this.loaded ??= this.ptyLoader(); return this.loaded; }

  async describe() {
    const { pty, message } = await this.pty();
    return { available: Boolean(pty), setupMessage: message, providers: Object.fromEntries(Object.entries(ADAPTERS).map(([id, adapter]) => [id, { name: adapter.name, ...adapter.capabilities, permissionModes: adapter.permissionModes }])) };
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
  async start({ run, task, planRunId }) {
    this.queue.push({ runId: run.id, task, planRunId });
    this.#pump();
  }

  #pump() {
    if (this.stopping || this.pumping) return;
    this.pumping = (async () => {
      while (this.queue.length && !this.stopping) {
        if (this.activeCount() >= await this.limit()) break;
        const next = this.queue.shift(); // Re-read after the await: a cancel may have emptied the queue.
        if (!next) break;
        (this.launching ??= new Set()).add(next.runId);
        await this.#launch(next).catch(error => this.#fail(next.runId, error)).finally(() => this.launching.delete(next.runId));
      }
    })().finally(() => { this.pumping = null; });
  }

  #endPending(runId) {
    for (const waiter of this.pending.get(runId) || []) waiter.handlers.end();
    this.pending.delete(runId);
  }

  async #fail(runId, error) {
    this.#endPending(runId);
    const code = typeof error?.code === 'string' ? error.code : 'CLI_FAILED';
    const reason = error instanceof AgentError ? error.message : FAILURE_MESSAGES[code] || 'The agent session could not start.';
    await this.board.updateRun(runId, { status: 'failed', errorCode: code, reason, endedAt: Date.now() }).catch(() => {});
  }

  async #launch({ runId, task, planRunId }) {
    const run = await this.board.run(runId);
    if (run.status !== 'queued') { this.#endPending(runId); return; } // Cancelled while queued.
    const { pty, message: setup } = await this.pty();
    if (!pty) throw new AgentError(setup, 'EXECUTION_SETUP_REQUIRED');
    const executable = await this.resolver(run.config.provider);
    if (!executable) throw new AgentError(`${ADAPTERS[run.config.provider].name} is not installed.`, 'NOT_INSTALLED');
    const runDir = join(this.dataDir, run.artifactsDir);
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    const plan = planRunId ? await readFile(join(this.dataDir, 'runs', planRunId, 'plan.md'), 'utf8').catch(() => null) : null;
    const message = composeMessage(run.stage, task.prompt, plan, run.config.instructions || '');
    // Stage instructions, the exact task text, and the plan are stored with the run.
    await writeFile(join(runDir, 'prompt.md'), message, { mode: 0o600 });
    await writeFile(join(runDir, 'task-prompt.txt'), task.prompt, { mode: 0o600 });
    const eventsFile = join(runDir, 'events.jsonl');
    await writeFile(eventsFile, '', { mode: 0o600 });
    const sessionId = randomUUID();
    const built = await buildSession({ provider: run.config.provider, stage: run.stage, config: run.config, message, runDir, eventsFile, sessionId, nodePath: this.nodePath });
    const log = createWriteStream(join(runDir, 'output.log'), { flags: 'a', mode: 0o600 });
    log.on('error', () => {});
    const proc = pty.spawn(executable.command, [...executable.prefix, ...built.args], {
      name: 'xterm-256color', cols: 120, rows: 32, cwd: run.workspacePath, env: { ...process.env, ...built.env },
    });
    trackPid(proc.pid);
    const session = { runId, taskId: run.taskId, stage: run.stage, provider: run.config.provider, proc, seq: 0, ring: [], ringBytes: 0,
      subscribers: new Set(), log, logBytes: 0, eventsFile, eventsOffset: 0, runDir, paste: built.paste, turns: 0, status: 'running', startedAt: Date.now() };
    this.sessions.set(runId, session);
    // Streams opened while the run was queued attach now.
    for (const waiter of this.pending.get(runId) || []) waiter.attach();
    this.pending.delete(runId);
    await this.board.updateRun(runId, { status: 'running', startedAt: session.startedAt, providerSessionId: run.config.provider === 'claude' ? sessionId : undefined, lifecycle: 'waiting-for-first-event' });
    this.#push(session, { status: 'running' });
    proc.onData(data => this.#output(session, data));
    proc.onExit(({ exitCode, signal }) => { this.#exited(session, exitCode, signal).catch(() => {}); });
    session.poll = setInterval(() => this.#readEvents(session).catch(() => {}), 250);
    // No event yet usually means the CLI is asking a startup question (such as folder trust).
    // Say so without claiming anything: the status stays running.
    session.watchdog = setTimeout(() => {
      if (session.proc && !session.sawEvent) this.board.updateRun(runId, { lifecycle: 'no-events-yet', waitingReason: 'No lifecycle event yet. The CLI may be asking a startup question, such as whether to trust this folder. Check the terminal.' }).catch(() => {});
    }, 10000);
    session.watchdog.unref();
    if (session.paste) {
      // Long prompts are pasted once the session is ready (bracketed paste keeps the text intact).
      session.pasteTimer = setTimeout(() => this.#paste(session), 15000);
    }
  }

  #paste(session) {
    if (!session.paste || !session.proc) return;
    clearTimeout(session.pasteTimer);
    session.proc.write(`\x1b[200~${session.paste}\x1b[201~`);
    setTimeout(() => session.proc?.write('\r'), 300);
    session.paste = null;
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
    this.#push(session, { data });
    if (session.logBytes < LOG_BYTES) {
      const chunk = session.logBytes + Buffer.byteLength(data) > LOG_BYTES ? '\n[Promptboard: output log limit reached]\n' : data;
      session.logBytes += Buffer.byteLength(chunk);
      session.log.write(chunk);
    }
  }

  async #readEvents(session) {
    if (session.reading) return;
    session.reading = true;
    try {
      const handle = await open(session.eventsFile, 'r');
      try {
        const { size } = await handle.stat();
        if (size <= session.eventsOffset) return;
        const buffer = Buffer.alloc(Math.min(size - session.eventsOffset, 8 * 1024 * 1024));
        await handle.read(buffer, 0, buffer.length, session.eventsOffset);
        const text = buffer.toString('utf8');
        const end = text.lastIndexOf('\n');
        if (end < 0) return;
        session.eventsOffset += Buffer.byteLength(text.slice(0, end + 1));
        for (const line of text.slice(0, end).split('\n')) {
          let event; try { event = JSON.parse(line); } catch { continue; }
          await this.#signal(session, interpretEvent(session.provider, event));
        }
      } finally { await handle.close(); }
    } finally { session.reading = false; }
  }

  async #setStatus(session, status, fields = {}) {
    session.status = status;
    await this.board.updateRun(session.runId, { status, ...fields }).catch(() => {});
    this.#push(session, { status, ...(fields.waitingReason ? { reason: fields.waitingReason } : {}) });
  }

  async #signal(session, signal) {
    if (signal.kind === 'ignore' || !session.proc) return;
    if (!session.sawEvent) { session.sawEvent = true; clearTimeout(session.watchdog); await this.board.updateRun(session.runId, { lifecycle: 'events-received', waitingReason: '' }).catch(() => {}); }
    if (signal.kind === 'started') {
      if (signal.sessionId) await this.board.updateRun(session.runId, { providerSessionId: signal.sessionId }).catch(() => {});
      if (session.paste) setTimeout(() => this.#paste(session), 1500);
    } else if (signal.kind === 'running') {
      if (session.status !== 'running') await this.#setStatus(session, 'running', { waitingReason: '' });
    } else if (signal.kind === 'waiting') {
      await this.#setStatus(session, 'waiting_for_input', { waitingReason: signal.reason });
    } else if (signal.kind === 'turn_complete') {
      session.turns++;
      const planning = session.stage === 'planning';
      if (signal.message) await writeFile(join(session.runDir, planning ? 'plan.md' : 'last-message.md'), signal.message, { mode: 0o600 });
      await this.#setStatus(session, 'waiting_for_input', {
        turns: session.turns, ...(planning && signal.message ? { hasPlan: true, planExcerpt: signal.message } : {}),
        waitingReason: planning ? (signal.message ? 'The plan is ready. Review it, continue in the terminal, or approve it.' : 'The agent finished its turn without a plan message. Continue in the terminal.')
          : 'The agent finished its turn. Review the work, continue in the terminal, or confirm the stage.',
      });
    } else if (signal.kind === 'failed') {
      // Account and quota failures are final for this run; there is no automatic retry.
      const code = HOOK_ERRORS[signal.error] || 'CLI_FAILED';
      session.failure = { code, reason: FAILURE_MESSAGES[code] };
      await this.#setStatus(session, 'failed', { errorCode: code, reason: FAILURE_MESSAGES[code] });
      this.#kill(session);
    }
  }

  #kill(session) {
    if (!session.proc) return;
    killPidGroup(session.proc.pid, 'SIGTERM');
    clearTimeout(session.killTimer);
    session.killTimer = setTimeout(() => { if (session.proc) killPidGroup(session.proc.pid, 'SIGKILL'); }, 3000);
    session.killTimer.unref();
  }

  async #exited(session, exitCode, signal) {
    clearInterval(session.poll); clearTimeout(session.pasteTimer); clearTimeout(session.watchdog);
    // Read the last lifecycle events (for example a final Stop) before the session closes.
    await this.#readEvents(session).catch(() => {});
    untrackPid(session.proc.pid);
    session.proc = null;
    clearTimeout(session.killTimer);
    await new Promise(resolve => session.log.end(resolve));
    const endedAt = Date.now();
    const exit = { exitCode: Number.isInteger(exitCode) ? exitCode : null, endedAt };
    const current = await this.board.run(session.runId).catch(() => null);
    if (!current) { /* Run removed. */ }
    else if (session.confirmed) await this.board.updateRun(session.runId, exit).catch(() => {});
    else if (session.failure || current.status === 'failed') await this.board.updateRun(session.runId, exit).catch(() => {});
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
    session.proc.write(data);
    if (session.status === 'waiting_for_input' && /\r|\n/.test(data)) this.#setStatus(session, 'running', { waitingReason: '' });
  }

  resize(runId, cols, rows) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 500 || rows < 5 || rows > 300) throw new AgentError('Use 20–500 columns and 5–300 rows.', 'INVALID_SIZE');
    this.#session(runId).proc.resize(cols, rows);
  }

  /** Stop one run. Only that run's own process group is signalled. */
  async cancel(runId) {
    const queued = this.queue.findIndex(item => item.runId === runId);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      await this.board.updateRun(runId, { status: 'cancelled', reason: 'Cancelled before it started.', endedAt: Date.now() });
      this.#endPending(runId);
      return;
    }
    const session = this.#session(runId);
    session.cancelled = true;
    this.#kill(session);
  }

  /**
   * The user confirms the stage. Planning needs a captured plan and records its approval.
   * The agent session then ends; the worktree stays.
   */
  async confirm(runId) {
    const run = await this.board.run(runId);
    if (run.status !== 'waiting_for_input' || !run.turns) throw new AgentError('Confirm after the agent has finished a turn and is waiting.', 'NOT_CONFIRMABLE', 409);
    if (run.stage === 'planning') await this.board.approvePlan(run.taskId, { runId });
    await this.board.updateRun(runId, { status: 'succeeded', reason: run.stage === 'planning' ? 'Plan approved by you.' : 'Stage confirmed by you.', endedAt: Date.now() });
    const session = this.sessions.get(runId);
    if (session?.proc) { session.confirmed = true; this.#push(session, { status: 'succeeded' }); this.#kill(session); }
  }

  /** Read a run artifact (plan, last message, or the tail of the output log). */
  async artifact(runId, name) {
    const run = await this.board.run(runId);
    const file = { plan: 'plan.md', 'last-message': 'last-message.md', output: 'output.log' }[name];
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
    const subscriber = {
      flush() {
        if (paused) return;
        const first = session.ring[0]?.item.seq ?? session.seq + 1;
        if (last < first - 1) { write({ gap: true, from: last + 1, to: first - 1 }); last = first - 1; }
        for (const { item } of session.ring) {
          if (item.seq <= last) continue;
          last = item.seq;
          if (!write(item)) { paused = true; onDrain(() => { paused = false; subscriber.flush(); }); return; }
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
    this.stopping = true;
    for (const { runId } of this.queue.splice(0)) { await this.board.updateRun(runId, { status: 'interrupted', reason: 'The app stopped before this run started.' }).catch(() => {}); this.#endPending(runId); }
    const live = [...this.sessions.values()].filter(session => session.proc);
    for (const session of live) { session.shuttingDown = true; killPidGroup(session.proc.pid, 'SIGTERM'); }
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
