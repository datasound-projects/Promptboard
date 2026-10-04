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
const cancelled = new AbortController(), stop = () => cancelled.abort('live-check-stopped');
process.once('SIGINT', stop); process.once('SIGTERM', stop);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const report = { provider, model: model || null, effort: effort || null, freshTrusted, columnAutomation, initial: null, warmup: null,
  sameRun: false, message: null, exactPrompt: false, mainCheckoutClean: false, worktreeClean: false, processStopped: false };
const root = await realpath(await mkdtemp(join(tmpdir(), 'pb-live-native-repo-')));
let dataDir, supervisor, dispatch, board, project, task;
const pids = new Set(), started = Date.now(), deadline = started + seconds * 1000;
const message = 'Reply exactly PB_NATIVE_SECOND. Do not use tools or change any file.';
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
try {
  dataDir = await realpath(await mkdtemp(join(tmpdir(), 'pb-live-native-data-')));
  git(root, 'init', '-q', '-b', 'trunk');
  git(root, '-c', 'user.email=live@example.invalid', '-c', 'user.name=Live Test', 'commit', '-q', '--allow-empty', '-m', 'Disposable fixture');
  board = new Board({ dataDir }); supervisor = new Supervisor({ board, dataDir }); board.executor = supervisor;
  project = await board.createProject({ name: 'Private native smoke' });
  await board.linkRepository(project.id, { path: root, expectedRevision: 1 });
  await board.setTargetBranch(project.id, { branch: 'trunk', expectedRevision: 2 });
  const pipeline = defaultPipelineConfig();
  for (const column of pipeline.columns) if (column.role === 'active') Object.assign(column.strategy, strategy);
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
