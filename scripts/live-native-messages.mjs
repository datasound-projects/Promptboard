#!/usr/bin/env node
/** Opt-in native input/column check. Uses model quota in its own disposable repository only. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from '../src/board.mjs';
import { Supervisor } from '../src/supervisor.mjs';
import { NativeMessageDispatch } from '../src/native-message-dispatch.mjs';
import { captureNativeMessageTarget } from '../src/native-message-target.mjs';
import { defaultPipelineConfig, normalizePipelineStrategy } from '../src/pipeline-config.mjs';
import { ClaudeFolderTrust } from './claude-folder-trust.mjs';
import { CODEX_BUSY_MESSAGE, CODEX_QUEUED_MESSAGE, CodexBusyEvidenceReader } from './codex-busy-evidence.mjs';

const option = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const value = process.argv[at + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing ${name} option.`);
  return value;
};
const provider = option('provider', 'claude'), model = option('model', provider === 'claude' ? 'haiku' : ''), effort = option('effort', '');
if (!['claude', 'codex', 'gemini'].includes(provider)) throw new Error('Use provider claude, codex or gemini.');
const seconds = Number(option('timeout', '120'));
if (!Number.isFinite(seconds) || seconds < 1 || seconds > 180) throw new Error('Timeout must be between 1 and 180 seconds.');
const strategy = normalizePipelineStrategy({ agentOverride: provider, ...(model ? { modelOverride: model } : {}), ...(effort ? { effortOverride: effort } : {}) });
const keep = process.argv.includes('--keep'), answerTrust = process.argv.includes('--answer-trust'), freshTrusted = process.argv.includes('--fresh-trusted');
const columnAutomation = process.argv.includes('--column-automation');
const busyQueue = process.argv.includes('--busy-queue');
if (busyQueue && (provider !== 'codex' || !columnAutomation)) throw new Error('Busy queue requires provider codex and --column-automation.');
const cancelled = new AbortController(), stop = () => cancelled.abort('live-check-stopped');
process.once('SIGINT', stop); process.once('SIGTERM', stop);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const report = { provider, model: model || null, effort: effort || null, freshTrusted, columnAutomation, busyQueue, initial: null, warmup: null,
  sameRun: false, message: null, exactPrompt: false, mainCheckoutClean: false, worktreeClean: false, processStopped: false };
const root = await realpath(await mkdtemp(join(tmpdir(), 'pb-live-native-repo-')));
let dataDir, supervisor, dispatch, board, project, task;
const pids = new Set(), started = Date.now(), deadline = started + seconds * 1000;
const message = busyQueue ? CODEX_BUSY_MESSAGE : 'Reply exactly PB_NATIVE_SECOND. Do not use tools or change any file.';
const prompt = 'Reply exactly PB_NATIVE_FIRST. Do not use tools, change files, send messages or make other network requests. No plan is needed.';
const summary = (run, session) => ({ status: run.status, errorCode: run.errorCode || null, turns: run.turns || 0,
  nativeIdentityObserved: Boolean(session?.nativeSessionId), ready: session?.activity?.snapshot().ready === true,
  manualInputObserved: session?.terminalInput?.snapshot().manualInputObserved === true });
async function waitReady(runId, mayAnswer) {
  const answered = new Set();
  const claudeTrust = mayAnswer && provider === 'claude' ? new ClaudeFolderTrust() : null;
  try {
    for (;;) {
      const run = await board.run(runId), session = supervisor.sessions.get(runId);
      if (session?.proc?.pid) pids.add(session.proc.pid);
      const state = summary(run, session);
      if (cancelled.signal.aborted || state.ready && state.nativeIdentityObserved || ['failed', 'cancelled', 'interrupted'].includes(run.status) || Date.now() >= deadline) return state;
      // Only fixed startup questions in this owned fixture; never answer a tool permission.
      if (mayAnswer && !run.turns && session?.proc) {
        const output = await supervisor.artifact(runId, 'output');
        const screen = output.replace(/\x1b\[[0-9;?<>]*[A-Za-z]/g, '').replace(/\s+/g, '');
        if (claudeTrust && !answered.has('folder')) {
          const input = await claudeTrust.observe(output, performance.now());
          if (cancelled.signal.aborted || Date.now() >= deadline) continue;
          if (input === 'down') supervisor.input(runId, '\x1b[B');
          if (input === 'confirm') { answered.add('folder'); supervisor.input(runId, '\r'); }
        } else if (provider !== 'claude' && !answered.has('folder') && /trustthisfolder|Trustthisfolder\?/i.test(screen)) {
          answered.add('folder');
          supervisor.input(runId, '\r');
        } else if (!answered.has('hooks') && /Hooksneedreview/i.test(screen)) {
          answered.add('hooks'); supervisor.input(runId, '\x1b[B'); await pause(300);
          supervisor.input(runId, '\x1b[B'); await pause(300); supervisor.input(runId, '\r');
        }
      }
      await pause(100);
    }
  } finally { claudeTrust?.close(); }
}
async function observeBusyQueue(runId) {
  const session = supervisor.sessions.get(runId), path = session?.usage?.tail.path;
  report.busy = { observed: false, key: 'Tab', pasted: false, queuedBeforeCompletion: false,
    firstReplyComplete: false, nextReplyComplete: false, interrupted: false, exactNextInput: false, sequenceValid: false };
  if (!report.sameRun || !report.message?.confirmed || !path || !session?.nativeSessionId) throw new Error('Busy queue prerequisite unavailable.');
  const nativeId = session.nativeSessionId, proc = session.proc, reader = new CodexBusyEvidenceReader(path, nativeId);
  const stopped = () => cancelled.signal.aborted || Date.now() >= deadline || supervisor.stopping || supervisor.sessions.get(runId) !== session
    || !proc || session.proc !== proc || session.nativeSessionId !== nativeId || session.cancelled || session.suspending || session.exiting || session.failure || session.launchFailed;
  let evidence;
  do {
    evidence = await reader.read();
    if (evidence.busy || evidence.firstReplyComplete || stopped()) break;
    await pause(50);
  } while (!stopped());
  if (!evidence.busy || stopped()) throw new Error('No owned busy turn observed.');
  report.busy.observed = true;
  // Deliberate manual input in this owned fixture only. Never clear its guard.
  const safeTerminal = () => { const terminal = session.terminalInput.snapshot(), activity = session.activity.snapshot();
    return terminal.bracketedPaste === true && !terminal.controlPending && !terminal.closed && !session.eventsPending
      && activity.phase !== 'ended' && !activity.permissionPending && !activity.uncertain; };
  if (!safeTerminal() || session.terminalInput.snapshot().manualInputObserved) throw new Error('Owned terminal unavailable.');
  supervisor.input(runId, '\x1b[200~' + CODEX_QUEUED_MESSAGE + '\x1b[201~'); report.busy.pasted = true;
  await pause(1000);
  evidence = await reader.read();
  report.busy.queueGuard = { busy: evidence.busy, stopped: Boolean(stopped()), terminal: session.terminalInput.snapshot(),
    phase: session.activity.snapshot().phase, permissionPending: session.activity.snapshot().permissionPending,
    uncertain: session.activity.snapshot().uncertain, eventsPending: Boolean(session.eventsPending) };
  if (!evidence.busy || stopped() || !safeTerminal()) throw new Error('Busy turn changed before queue key.');
  // Codex 0.157.0's default Tab binding queues; Enter can steer the current turn.
  supervisor.input(runId, '\t'); report.busy.queuedBeforeCompletion = true;
  do {
    evidence = await reader.read();
    Object.assign(report.busy, { firstReplyComplete: evidence.firstReplyComplete, nextReplyComplete: evidence.nextReplyComplete,
      interrupted: evidence.interrupted, exactNextInput: evidence.nextInputObserved, sequenceValid: evidence.sequenceValid });
    if (evidence.nextReplyComplete || evidence.interrupted || evidence.steered || stopped()) break;
    await pause(100);
  } while (!stopped());
  report.busy.manualInputObserved = session.terminalInput.snapshot().manualInputObserved;
}
try {
  dataDir = await realpath(await mkdtemp(join(tmpdir(), 'pb-live-native-data-')));
  git(root, 'init', '-q', '-b', 'trunk');
  git(root, '-c', 'user.email=live@example.invalid', '-c', 'user.name=Live Test', 'commit', '-q', '--allow-empty', '-m', 'Disposable fixture');
  board = new Board({ dataDir }); supervisor = new Supervisor({ board, dataDir }); board.executor = supervisor;
  project = await board.createProject({ name: 'Private native smoke' });
  await board.linkRepository(project.id, { path: root, expectedRevision: 1 });
  await board.setTargetBranch(project.id, { branch: 'trunk', expectedRevision: 2 });
  // Native message delivery belongs to custom columns (one conversation across columns); typed columns start fresh sessions.
  const pipeline = defaultPipelineConfig();
  for (const column of pipeline.columns) if (column.role === 'active') { column.kind = 'custom'; Object.assign(column.strategy, strategy); }
  if (columnAutomation) pipeline.columns.find(column => column.id === 'code_review').automations.onEnter = [
    { id: 'live-column-message', name: 'Live column check', type: 'send_message', enabled: true, mode: 'deferred', message }];
  await board.setPipeline(project.id, { pipeline, expectedRevision: 3, confirm: true });
  task = await board.createTask({ projectId: project.id, title: 'Private native input smoke', prompt });
  if ((await board.state()).runs.length) throw new Error('Unexpected To Do run.');
  cancelled.signal.throwIfAborted();
  let result = await board.transition(task.id, { column: 'executing', expectedRevision: task.revision });
  report.initial = await waitReady(result.run.id, answerTrust);
  if (!cancelled.signal.aborted && freshTrusted && report.initial.ready && report.initial.manualInputObserved && Date.now() < deadline) {
    // A separate fresh conversation in the already trusted fixture. No guard is reset,
    // and the warmup never receives a native message or an unknown-write retry.
    report.warmup = report.initial;
    let current = (await board.state()).projects.find(p => p.id === project.id).tasks.find(t => t.id === task.id);
    await board.transition(task.id, { column: 'todo', expectedRevision: current.revision });
    current = (await board.state()).projects.find(p => p.id === project.id).tasks.find(t => t.id === task.id);
    cancelled.signal.throwIfAborted();
    result = await board.transition(task.id, { column: 'executing', expectedRevision: current.revision });
    report.initial = await waitReady(result.run.id, false);
  }
  if (!cancelled.signal.aborted && report.initial.ready && report.initial.nativeIdentityObserved && Date.now() < deadline) {
    let current = (await board.state()).projects.find(p => p.id === project.id).tasks.find(t => t.id === task.id);
    const moved = await board.transition(task.id, { column: 'code_review', expectedRevision: current.revision });
    report.sameRun = moved.continuedRunId === result.run.id;
    if (columnAutomation) {
      report.placementStatus = moved.automationMove.status;
      const key = { projectId: project.id, taskId: task.id, transitionId: moved.automationMove.transitionId };
      const receiptDeadline = Math.min(deadline, Date.now() + 10000);
      let receipt;
      do {
        receipt = (await board.automationJournal.read(key)).actions.find(row => row.type === 'send_message')?.delivery;
        if (receipt && !['queued', 'dispatching', 'submitted', 'accepted'].includes(receipt.status)) break;
        await pause(50);
      } while (!cancelled.signal.aborted && Date.now() < receiptDeadline);
      report.message = { status: receipt?.status || 'unconfirmed', confirmed: receipt?.status === 'confirmed',
        receiptStatus: receipt?.status || null, submitted: Boolean(receipt?.submittedAt) };
      // A durable receipt can appear before its transport callback returns.
      // Deliberate manual input must not revoke that still-owned callback.
      if (report.message.confirmed) {
        while (board.messageScheduler?.ownsTask(task.id) && !cancelled.signal.aborted && Date.now() < receiptDeadline) await pause(25);
        if (board.messageScheduler?.ownsTask(task.id) || cancelled.signal.aborted || Date.now() >= receiptDeadline) throw new Error('Native transport did not settle inside the receipt budget.');
        const settled = await board.messageScheduler.wait(key, (await board.automationJournal.read(key)).actions.find(row => row.type === 'send_message').id);
        report.message.transportSettled = settled.confirmed === true;
        if (!report.message.transportSettled) throw new Error('The native receipt callback was not acknowledged.');
      }
    } else {
      const key = { projectId: project.id, taskId: task.id, transitionId: 'live-private-message' }, journal = board.automationJournal;
      const target = captureNativeMessageTarget(await board.state(), { projectId: project.id, taskId: task.id, runId: result.run.id });
      if (!report.sameRun || !target) throw new Error('The exact task conversation is unavailable.');
      const scope = { provider: target.provider, sessionId: target.sessionId, runId: target.runId, mode: 'deferred', messageHash: createHash('sha256').update(message).digest('hex') };
      current = (await board.state()).projects.find(p => p.id === project.id);
      const { move } = await journal.beginMove({ ...key, taskRevision: current.tasks[0].revision, projectRevision: current.revision,
        from: { id: 'executing', name: 'Executing' }, to: { id: 'code_review', name: 'Code Review' },
        onEnter: [{ id: 'private-message', name: 'Private smoke', type: 'send_message', enabled: true, mode: 'deferred', message }] });
      await journal.advance(key); await journal.startLifecycle(key); await journal.finishLifecycle(key, { status: 'succeeded' });
      const actionId = move.actions[0].id; await journal.startAction(key, actionId); await journal.scheduleMessage(key, actionId, scope); await journal.advance(key);
      dispatch = new NativeMessageDispatch({ journal, supervisor });
      const delivered = await dispatch.deliver({ key, actionId, message, scope }, { signal: cancelled.signal, timeoutMs: Math.max(1, Math.min(10000, deadline - Date.now())),
        preflight: async () => target.matches(await board.state()) });
      const receipt = (await journal.read(key)).actions[0].delivery;
      report.message = { status: delivered.status, confirmed: delivered.confirmed === true, receiptStatus: receipt.status, submitted: Boolean(receipt.submittedAt) };
    }
    if (busyQueue) await observeBusyQueue(result.run.id);
  }
} catch (error) {
  report.errorCode = /^[A-Z0-9_]{1,80}$/.test(error.code || '') ? error.code : 'LIVE_CHECK_FAILED';
} finally {
  await dispatch?.shutdown(); await board?.shutdownAutomations(); await supervisor?.shutdown(1000);
  report.cancelled = cancelled.signal.aborted;
  report.processStopped = [...pids].every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } });
  if (board && task) {
    const current = (await board.state()).projects.find(p => p.id === project.id)?.tasks.find(t => t.id === task.id);
    report.exactPrompt = current?.prompt === prompt;
    report.worktreeClean = current?.workspace ? git(current.workspace.path, 'status', '--porcelain') === '' : true;
    report.mainCheckoutClean = git(root, 'status', '--porcelain') === '';
  }
  if (keep) Object.assign(report, { root, dataDir });
  else { await rm(root, { recursive: true, force: true }); if (dataDir) await rm(dataDir, { recursive: true, force: true }); }
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  console.log(JSON.stringify(report, null, 2));
}
