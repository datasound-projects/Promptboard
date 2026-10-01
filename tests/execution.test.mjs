// PB-02 tests. Everything here is SIMULATED: fake CLIs (tests/fixtures/fake-agent.cjs)
// stand in for Claude Code, Codex, and Gemini CLI. Live-provider checks are separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, ARGV_PROMPT_LIMIT, buildSession, composeMessage, HOOK_SCRIPT, interpretEvent, resolveConfig } from '../src/agents.mjs';
import { Board } from '../src/board.mjs';
import { Supervisor } from '../src/supervisor.mjs';
import { startServer } from '../src/server.mjs';

const skip = process.platform === 'win32';
const fake = fileURLToPath(new URL('./fixtures/fake-agent.cjs', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
async function temp(t, prefix) { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return dir; }
async function until(fn, label, ms = 10000) { const end = Date.now() + ms; for (;;) { const value = await fn(); if (value) return value; if (Date.now() > end) assert.fail(`Timed out: ${label}`); await new Promise(r => setTimeout(r, 50)); } }

// ---- Adapter contracts (no processes) ----

test('adapter capabilities are explicit; unsupported providers and unsafe modes are refused', () => {
  for (const id of ['claude', 'codex', 'gemini']) { assert.equal(ADAPTERS[id].capabilities.planning.supported, true); assert.equal(ADAPTERS[id].capabilities.execution.supported, true); }
  assert.equal(ADAPTERS.agy.capabilities.execution.supported, false);
  assert.throws(() => resolveConfig('executing', { provider: 'agy' }), { code: 'STAGE_UNSUPPORTED_BY_PROVIDER', message: /Antigravity CLI: Not enabled/ });
  assert.throws(() => resolveConfig('executing', { provider: 'sh' }), { code: 'INVALID_PROVIDER' });
  assert.throws(() => resolveConfig('executing', { provider: 'claude', permissionMode: 'bypassPermissions' }), { code: 'INVALID_PERMISSION_MODE' });
  assert.throws(() => resolveConfig('executing', { provider: 'gemini', permissionMode: 'yolo' }), { code: 'INVALID_PERMISSION_MODE' });
  assert.throws(() => resolveConfig('executing', { provider: 'codex', model: '--dangerously-bypass-approvals-and-sandbox' }), { code: 'INVALID_MODEL' });
  assert.throws(() => resolveConfig('executing', { provider: 'gemini', effort: 'high' }), { code: 'INVALID_EFFORT' });
  assert.deepEqual(resolveConfig('planning', { provider: 'claude', permissionMode: 'acceptEdits' }), { provider: 'claude', model: '', effort: '', permissionMode: 'plan' });
  assert.deepEqual(resolveConfig('executing', {}), { provider: 'claude', model: '', effort: '', permissionMode: 'acceptEdits' });
});

test('session arguments: planning is read-only per provider; execution never bypasses permissions; task text stays one argument', async t => {
  const runDir = await temp(t, 'pb-args-');
  const hostile = '$(touch /tmp/pwned) `id`; --dangerously-skip-permissions\n@/etc/passwd /help';
  const message = composeMessage('planning', hostile);
  assert.ok(message.includes(`=== TASK (exact text from the card) ===\n${hostile}\n=== END TASK ===`));
  const build = (provider, stage, config = {}) => buildSession({ provider, stage, config: resolveConfig(stage, { provider, ...config }), message, runDir, eventsFile: join(runDir, 'events.jsonl'), sessionId: 'sid' });
  const claudePlan = await build('claude', 'planning');
  assert.deepEqual(claudePlan.args.slice(claudePlan.args.indexOf('--permission-mode'), claudePlan.args.indexOf('--permission-mode') + 2), ['--permission-mode', 'plan']);
  assert.equal(claudePlan.args[claudePlan.args.indexOf('--tools') + 1], 'Read,Grep,Glob');
  assert.match(claudePlan.args[claudePlan.args.indexOf('--disallowedTools') + 1], /Edit.*Write.*Bash.*ExitPlanMode/);
  assert.equal(claudePlan.args.at(-1), message, 'The whole message is one argument.');
  const hook = JSON.parse(claudePlan.args[claudePlan.args.indexOf('--settings') + 1]).hooks.Stop[0].hooks[0];
  assert.deepEqual([hook.command, hook.args[0], hook.args[2]], [process.execPath, HOOK_SCRIPT, 'claude']);
  const codexPlan = await build('codex', 'planning');
  assert.deepEqual(codexPlan.args.slice(codexPlan.args.indexOf('--sandbox'), codexPlan.args.indexOf('--sandbox') + 4), ['--sandbox', 'read-only', '--ask-for-approval', 'never']);
  const geminiPlan = await build('gemini', 'planning');
  assert.equal(geminiPlan.args[geminiPlan.args.indexOf('--approval-mode') + 1], 'plan');
  const policy = await readFile(geminiPlan.args[geminiPlan.args.indexOf('--policy') + 1], 'utf8');
  for (const tool of ['write_file', 'replace', 'run_shell_command', 'exit_plan_mode']) assert.match(policy, new RegExp(`toolName = "${tool}"\\ndecision = "deny"`));
  const encoded = geminiPlan.args[geminiPlan.args.indexOf('--prompt-interactive') + 1];
  assert.ok(!encoded.includes('@'), 'Gemini @file references are encoded.');
  assert.equal(JSON.parse(encoded.split('\n').slice(1).join('\n')), message);
  for (const provider of ['claude', 'codex', 'gemini']) {
    const { args } = await build(provider, 'executing');
    // The task text may mention anything; it is one argument and never parsed as a flag.
    assert.ok(!args.filter(arg => arg !== message && !arg.startsWith('Decode the JSON')).some(arg => /dangerously|bypassPermissions|yolo|danger-full-access/.test(arg)), provider);
  }
  assert.deepEqual((await build('codex', 'executing')).args.slice(-5, -1), ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request']);
  // Only Planning plans: writing stages cannot switch Claude Code into plan mode and are told to start their own work.
  for (const stage of ['executing', 'testing', 'merge']) {
    const { args } = await build('claude', stage);
    assert.equal(args[args.indexOf('--disallowedTools') + 1], 'EnterPlanMode,ExitPlanMode', stage);
    assert.match(composeMessage(stage, 'Plan first.'), /do not enter plan mode: planning happens only in the Planning column/, stage);
  }
  assert.match(composeMessage('executing', 'x'), /^Start implementing the task below now\./);
  // A prompt too long for one argv element is pasted into the terminal instead.
  const long = composeMessage('executing', 'x'.repeat(ARGV_PROMPT_LIMIT + 10));
  const pasted = await buildSession({ provider: 'claude', stage: 'executing', config: resolveConfig('executing', {}), message: long, runDir, eventsFile: 'e', sessionId: 's' });
  assert.equal(pasted.paste, long);
  assert.ok(!pasted.args.includes(long));
});

test('lifecycle events map to supervisor signals; the hook bridge records only lifecycle fields', async t => {
  assert.deepEqual(interpretEvent('claude', { name: 'Stop', message: 'done' }), { kind: 'turn_complete', message: 'done' });
  assert.equal(interpretEvent('claude', { name: 'PermissionRequest', tool: 'Bash' }).kind, 'waiting');
  assert.deepEqual(interpretEvent('claude', { name: 'StopFailure', error: 'rate_limit' }), { kind: 'failed', error: 'rate_limit' });
  assert.equal(interpretEvent('codex', { name: 'agent-turn-complete', message: 'x' }).kind, 'turn_complete');
  assert.equal(interpretEvent('codex', { name: 'agent-turn-complete', message: '{"title":"Plan adding beta"}' }).kind, 'ignore', 'Codex thread-title turns are not replies.');
  assert.equal(interpretEvent('gemini', { name: 'Notification', notification: 'ToolPermission' }).kind, 'waiting');
  assert.equal(interpretEvent('gemini', { name: 'AfterAgent', message: 'p' }).kind, 'turn_complete');
  assert.equal(interpretEvent('claude', { name: 'PreToolUse' }).kind, 'ignore');
  const dir = await temp(t, 'pb-hook-');
  const events = join(dir, 'events.jsonl');
  const result = spawnSync(process.execPath, [HOOK_SCRIPT, events, 'claude'], { input: JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', last_assistant_message: 'Plan text', tool_input: { content: 'SECRET FILE CONTENT' } }) });
  assert.equal(result.stdout.length, 0, 'The hook prints nothing, so it cannot change agent decisions.');
  spawnSync(process.execPath, [HOOK_SCRIPT, events, 'codex', JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 't', 'last-assistant-message': 'Done' })]);
  const lines = (await readFile(events, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines.map(line => [line.provider, line.name, line.message]), [['claude', 'Stop', 'Plan text'], ['codex', 'agent-turn-complete', 'Done']]);
  assert.doesNotMatch(await readFile(events, 'utf8'), /SECRET/);
});

// ---- Supervisor integration with a real PTY and fake CLIs ----

test('Plan Mode is forced for every supported provider and model; execution permissions use native controls', async t => {
  const runDir = await temp(t, 'pb-mode-matrix-');
  for (const provider of ['claude', 'codex', 'gemini']) {
    for (const model of ['', 'custom-model-v1']) {
      const config = resolveConfig('planning', { provider, model, permissionMode: 'auto' });
      assert.equal(config.permissionMode, 'plan');
      assert.equal(config.model, model);
      const session = await buildSession({ provider, stage: 'planning', config, message: composeMessage('planning', 'Inspect, do not edit.'), runDir, eventsFile: join(runDir, 'events'), sessionId: 'test-session' });
      const flag = { claude: '--permission-mode', codex: '--sandbox', gemini: '--approval-mode' }[provider];
      assert.equal(session.args[session.args.indexOf(flag) + 1], provider === 'codex' ? 'read-only' : 'plan');
      if (model) assert.equal(session.args[session.args.indexOf('--model') + 1], model);
    }
    assert.equal(resolveConfig('executing', { provider, permissionMode: 'auto' }).permissionMode, ADAPTERS[provider].permissionModes[0]);
  }
  for (const provider of ['claude', 'gemini']) {
    const config = resolveConfig('executing', { provider, permissionMode: 'approve_edit' });
    assert.equal(config.permissionMode, 'default');
    const session = await buildSession({ provider, stage: 'executing', config, message: 'Implement.', runDir, eventsFile: join(runDir, 'events'), sessionId: 's' });
    const flag = provider === 'claude' ? '--permission-mode' : '--approval-mode';
    assert.equal(session.args[session.args.indexOf(flag) + 1], 'default');
  }
  assert.throws(() => resolveConfig('executing', { provider: 'codex', permissionMode: 'approve_edit' }), { code: 'INVALID_PERMISSION_MODE' }, 'Unsupported per-file approval is not silently weakened.');
});

async function world(t, { limit = 1, providers = ['claude', 'codex', 'gemini'], server = false } = {}) {
  const bin = await temp(t, 'pb-bin-');
  for (const id of providers) { await writeFile(join(bin, id), `#!${process.execPath}\nrequire(${JSON.stringify(fake)});\n`); await chmod(join(bin, id), 0o755); }
  const report = join(bin, 'report.jsonl');
  const oldPath = process.env.PATH, oldReport = process.env.FAKE_AGENT_REPORT;
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.FAKE_AGENT_REPORT = report;
  const dataDir = await temp(t, 'pb-data-');
  const root = await temp(t, 'pb-repo-');
  git(root, 'init', '-q', '-b', 'trunk'); git(root, 'config', 'user.email', 't@e'); git(root, 'config', 'user.name', 'T');
  await writeFile(join(root, 'README.md'), 'main checkout\n'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'init');
  // With server: true the HTTP server owns the only Board and Supervisor for this data folder.
  const app = server ? await startServer({ port: 0, dataDir, detector: async () => [] }) : null;
  const board = app ? app.board : new Board({ dataDir });
  const supervisor = app ? board.executor : new Supervisor({ board, dataDir });
  board.executor = supervisor;
  t.after(async () => { if (app) await app.close(); else await supervisor.shutdown(500); process.env.PATH = oldPath; if (oldReport === undefined) delete process.env.FAKE_AGENT_REPORT; else process.env.FAKE_AGENT_REPORT = oldReport; });
  const project = await board.createProject({ name: 'Repo' });
  await board.linkRepository(project.id, { path: root, expectedRevision: 1 });
  await board.setTargetBranch(project.id, { branch: 'trunk', expectedRevision: 2 });
  await board.setSettings({ maxConcurrentRuns: limit });
  const task = async (title, prompt, column = 'executing') => {
    const created = await board.createTask({ projectId: project.id, title, prompt });
    return board.moveTask(created.id, { column, expectedRevision: 1 });
  };
  const run = id => board.run(id);
  const reports = async () => (await readFile(report, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { board, supervisor, root, dataDir, task, run, reports, projectId: project.id, app };
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('cancel during launch prevents a spawn, and repeated cancellation is harmless', { skip }, async t => {
  const w = await world(t);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  t.after(() => release());
  const resolveExecutable = w.supervisor.resolver;
  w.supervisor.resolver = async provider => {
    if (w.supervisor.launching?.size) { entered(); await gate; }
    return resolveExecutable(provider);
  };
  const task = await w.task('Cancel startup', 'Do not spawn.');
  const run = await w.board.requestRun(task.id, { stage: 'executing', consent: true, config: { provider: 'codex' } });
  await started;
  await w.supervisor.cancel(run.id);
  assert.equal((await w.run(run.id)).status, 'cancelled');
  release();
  await until(() => !w.supervisor.launching?.has(run.id), 'cancelled launch settled');
  assert.deepEqual(await w.reports(), [], 'Cancelled startup never starts the CLI.');
  await w.supervisor.cancel(run.id);
  assert.equal((await w.run(run.id)).status, 'cancelled');
});

test('Stop waits for a stubborn agent to exit, escalates once, and keeps its files and logs', { skip }, async t => {
  const w = await world(t);
  const task = await w.task('Stubborn agent', 'IGNORE_TERM WRITE_FILE');
  const run = await w.board.requestRun(task.id, { stage: 'executing', consent: true, config: { provider: 'codex' } });
  await until(async () => (await w.run(run.id)).status === 'waiting_for_input', 'stubborn agent ready');
  const [report] = await w.reports();
  let exitReached, releaseExit;
  const finalWrite = new Promise(resolve => { exitReached = resolve; });
  const finish = new Promise(resolve => { releaseExit = resolve; });
  t.after(() => releaseExit());
  const updateRun = w.board.updateRun.bind(w.board);
  w.board.updateRun = async (id, fields) => {
    if (id === run.id && fields.status === 'cancelled') { exitReached(); await finish; }
    return updateRun(id, fields);
  };
  const start = Date.now();
  const first = w.supervisor.cancel(run.id);
  await finalWrite;
  assert.equal(alive(report.pid), false);
  const second = w.supervisor.cancel(run.id); // The process exited; status is still being saved.
  releaseExit();
  await Promise.all([first, second]);
  assert.ok(Date.now() - start >= 2500, 'An ignored SIGTERM reaches the SIGKILL fallback.');
  assert.equal(alive(report.pid), false, 'Successful Stop means the agent exited.');
  assert.equal((await w.run(run.id)).status, 'cancelled');
  assert.equal(await readFile(join(run.workspacePath, 'agent-output.txt'), 'utf8'), 'written by the agent\n');
  assert.match(await w.supervisor.artifact(run.id, 'output'), /fake codex started/);
});

test('planning captures a plan outside the worktree, cannot implement, and approval is tied to the task text', { skip }, async t => {
  const w = await world(t);
  const task = await w.task('Plan it', 'Add a WRITE_FILE feature.', 'planning');
  const run = await w.board.requestRun(task.id, { stage: 'planning', consent: true, config: { provider: 'claude' } });
  const waiting = await until(async () => { const r = await w.run(run.id); return r.status === 'waiting_for_input' && r; }, 'plan ready');
  assert.equal(waiting.hasPlan, true);
  assert.match(waiting.planExcerpt, /^PLAN/);
  const plan = await readFile(join(w.dataDir, run.artifactsDir, 'plan.md'), 'utf8');
  assert.match(plan, /1\. Change the code/);
  const workspace = (await w.board.view()).projects[0].tasks[0].workspace;
  assert.ok(!join(w.dataDir, run.artifactsDir).startsWith(workspace.path), 'The plan is stored outside the worktree.');
  // SIMULATED: the fake honours the read-only flags like the real CLIs; live tests confirm the real boundary.
  assert.equal(git(workspace.path, 'status', '--porcelain'), '', 'Planning did not change the worktree.');
  assert.match(await w.supervisor.artifact(run.id, 'output'), /write denied: read-only planning session/);
  const [{ args }] = await w.reports();
  assert.ok(args.includes('plan') && args.includes('Read,Grep,Glob'));
  await w.supervisor.confirm(run.id);
  assert.equal((await w.run(run.id)).status, 'succeeded');
  const approved = (await w.board.view()).projects[0].tasks[0];
  assert.equal(approved.planApproval.runId, run.id);
  // Executing gets the approved plan with the exact task text.
  await w.board.moveTask(task.id, { column: 'executing', expectedRevision: approved.revision });
  const promptFile = join(w.dataDir, 'prompt-seen.txt');
  process.env.FAKE_AGENT_PROMPT_FILE = promptFile;
  t.after(() => { delete process.env.FAKE_AGENT_PROMPT_FILE; });
  const exec = await w.board.requestRun(task.id, { stage: 'executing', consent: true, config: { provider: 'claude' } });
  assert.equal(exec.planRunId, run.id);
  await until(async () => (await w.run(exec.id)).status === 'waiting_for_input', 'execution turn');
  const seen = await readFile(promptFile, 'utf8');
  assert.ok(seen.includes('Add a WRITE_FILE feature.') && seen.includes('=== APPROVED PLAN ===') && seen.includes('1. Change the code.'));
  // The agent wrote only in the task worktree; the main checkout is unchanged.
  assert.equal(await readFile(join(workspace.path, 'agent-output.txt'), 'utf8'), 'written by the agent\n');
  assert.equal(git(w.root, 'status', '--porcelain'), '');
  await w.supervisor.confirm(exec.id);
  // Editing the task text makes the plan approval stale for later runs.
  const current = (await w.board.view()).projects[0].tasks[0];
  await w.board.updateTask(task.id, { prompt: 'Changed text.', expectedRevision: current.revision });
  const next = await w.board.requestRun(task.id, { stage: 'executing', consent: true, config: { provider: 'claude' } });
  assert.equal(next.planRunId, null, 'A stale plan is not sent to the agent.');
  await w.supervisor.cancel(next.id).catch(() => {});
});

test('two tasks run concurrently in separate processes; stopping one does not stop the other; the default limit queues', { skip }, async t => {
  const w = await world(t, { limit: 2 });
  const a = await w.task('A', 'Task A.'), b = await w.task('B', 'Task B.'), c = await w.task('C', 'Task C.');
  const runA = await w.board.requestRun(a.id, { stage: 'executing', consent: true, config: { provider: 'claude' } });
  const runB = await w.board.requestRun(b.id, { stage: 'executing', consent: true, config: { provider: 'codex' } });
  const runC = await w.board.requestRun(c.id, { stage: 'executing', consent: true, config: { provider: 'gemini' } });
  await until(async () => (await w.run(runA.id)).status === 'waiting_for_input' && (await w.run(runB.id)).status === 'waiting_for_input', 'two turns');
  assert.equal((await w.run(runC.id)).status, 'queued', 'The third run waits for a free slot.');
  const [ra, rb] = await w.reports();
  assert.notEqual(ra.pid, rb.pid);
  assert.notEqual(ra.cwd, rb.cwd, 'Each run uses its own worktree.');
  const outputs = await Promise.all([runA, runB].map(run => w.supervisor.artifact(run.id, 'output')));
  assert.match(outputs[0], /fake claude started/); assert.match(outputs[1], /fake codex started/);
  assert.doesNotMatch(outputs[0], /fake codex/);
  await w.supervisor.cancel(runA.id);
  await until(async () => (await w.run(runA.id)).status === 'cancelled', 'A cancelled');
  assert.equal(alive(ra.pid), false);
  assert.equal(alive(rb.pid), true, 'Stopping one task does not stop another.');
  assert.equal((await w.run(runB.id)).status, 'waiting_for_input');
  // The freed slot starts the queued Gemini run.
  await until(async () => (await w.run(runC.id)).status === 'waiting_for_input', 'queued run started');
  // Input reaches the right session only.
  w.supervisor.input(runB.id, 'continue please\r');
  await until(async () => /you said: continue please/.test(await w.supervisor.artifact(runB.id, 'output')), 'input echoed');
  assert.doesNotMatch(await w.supervisor.artifact(runC.id, 'output'), /continue please/);
});

test('failures are classified once; unconfirmed exits are interrupted; waiting states surface; streams resume in order', { skip }, async t => {
  const w = await world(t, { limit: 3 });
  const billing = await w.task('Billing', 'BILLING');
  const run = await w.board.requestRun(billing.id, { stage: 'executing', consent: true, config: { provider: 'claude' } });
  const failed = await until(async () => { const r = await w.run(run.id); return r.status === 'failed' && r; }, 'failed');
  assert.equal(failed.errorCode, 'ACCOUNT_UNAVAILABLE');
  await new Promise(r => setTimeout(r, 400));
  assert.equal((await w.reports()).length, 1, 'An account failure is not retried.');
  const exits = await w.task('Exit', 'EXIT_NOW');
  const exitRun = await w.board.requestRun(exits.id, { stage: 'executing', consent: true, config: { provider: 'claude' } });
  const ended = await until(async () => { const r = await w.run(exitRun.id); return r.status === 'interrupted' && r; }, 'interrupted');
  assert.match(ended.reason, /before you confirmed/);
  await assert.rejects(w.supervisor.confirm(exitRun.id), { code: 'NOT_CONFIRMABLE' });
  const ask = await w.task('Ask', 'ASK_PERMISSION');
  const askRun = await w.board.requestRun(ask.id, { stage: 'executing', consent: true, config: { provider: 'claude' } });
  const waiting = await until(async () => { const r = await w.run(askRun.id); return r.status === 'waiting_for_input' && r; }, 'permission wait');
  assert.match(waiting.waitingReason, /Permission requested for Bash/);
  await assert.rejects(w.supervisor.confirm(askRun.id), { code: 'NOT_CONFIRMABLE' }, 'A permission wait is not a finished turn.');
  // Ordered stream with resume.
  const first = [];
  const stop = w.supervisor.subscribe(askRun.id, 0, { write: item => { first.push(item); return true; }, onDrain: () => {}, end: () => {} });
  stop();
  assert.ok(first.length > 0);
  assert.deepEqual(first.map(item => item.seq), first.map((_, i) => first[0].seq + i));
  w.supervisor.input(askRun.id, 'y\r');
  await until(async () => (await w.run(askRun.id)).turns === 1, 'turn after approval');
  const later = [];
  w.supervisor.subscribe(askRun.id, first.at(-1).seq, { write: item => { later.push(item); return true; }, onDrain: () => {}, end: () => {} })();
  assert.ok(later.length && later[0].seq === first.at(-1).seq + 1, 'Reconnect resumes after the last seen event.');
  // Backpressure: a subscriber that cannot write pauses without losing order.
  let resume;
  const slow = [];
  w.supervisor.subscribe(askRun.id, 0, { write: item => { slow.push(item.seq); return slow.length % 2 === 0 ? (resume ? true : false) : true; }, onDrain: fn => { resume = fn; }, end: () => {} });
  const before = slow.length;
  resume();
  assert.ok(slow.length >= before);
  assert.deepEqual(slow, [...slow].sort((x, y) => x - y));
  assert.throws(() => w.supervisor.input(askRun.id, 'x'.repeat(70000)), { code: 'INPUT_TOO_LARGE' });
  // Shutdown stops owned sessions and records them as interrupted.
  const pid = (await w.reports()).at(-1).pid;
  await w.supervisor.shutdown(1000);
  assert.equal(alive(pid), false);
  assert.equal((await w.run(askRun.id)).status, 'interrupted');
});

test('missing terminal support is reported with setup steps and starts nothing', async t => {
  const dataDir = await temp(t, 'pb-data-');
  const board = new Board({ dataDir });
  const supervisor = new Supervisor({ board, dataDir, ptyLoader: async () => ({ pty: null, message: 'Agent terminals need the node-pty package. Run npm install.' }) });
  board.executor = supervisor;
  const view = await board.view();
  assert.equal(view.execution.available, false);
  assert.match(view.execution.setupMessage, /npm install/);
  await assert.rejects(supervisor.validate({ stage: 'executing', config: {} }), { code: 'EXECUTION_SETUP_REQUIRED' });
});

test('run endpoints need the token, bound input, need confirmation to stop, and stream NDJSON', { skip }, async t => {
  const w = await world(t, { server: true });
  const app = w.app;
  const { token } = await fetch(app.url + '/api/session').then(r => r.json());
  const call = (method, path, body, extra = {}) => fetch(app.url + path, { method, headers: { 'x-ste-token': token, 'content-type': 'application/json', ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const task = await w.task('HTTP', 'Over HTTP.');
  assert.equal((await call('POST', `/api/tasks/${task.id}/runs`, { stage: 'executing' })).status, 400, 'Consent is required.');
  const started = await call('POST', `/api/tasks/${task.id}/runs`, { stage: 'executing', consent: true, config: { provider: 'claude' } });
  assert.equal(started.status, 200);
  const run = (await started.json()).run;
  assert.equal((await fetch(`${app.url}/api/runs/${run.id}/stream`)).status, 403, 'Streams need the token header.');
  assert.equal((await fetch(`${app.url}/api/runs/${run.id}/stream?token=${token}`)).status, 403, 'A token in the URL is not accepted.');
  assert.equal((await call('POST', `/api/runs/${run.id}/input`, { data: 'x' }, { origin: 'https://evil.example' })).status, 403);
  const unknown = await call('GET', '/api/runs/not-a-run/stream');
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).code, 'NOT_FOUND', 'Unknown runs are rejected by the run route, not a missing route.');
  const stream = await call('GET', `/api/runs/${run.id}/stream?after=0`);
  assert.match(stream.headers.get('content-type'), /ndjson/);
  const reader = stream.body.getReader();
  let text = '';
  for (const end = Date.now() + 10000; !/turn complete/.test(text);) {
    if (Date.now() > end) assert.fail(`No turn in the stream: ${text.slice(-500)}`);
    const { value, done } = await reader.read();
    if (done) assert.fail(`The stream ended early: ${text.slice(-500)}`);
    text += new TextDecoder().decode(value);
  }
  const items = text.trim().split('\n').map(line => JSON.parse(line)).filter(item => item.seq);
  assert.deepEqual(items.map(item => item.seq), items.map((_, i) => items[0].seq + i));
  await reader.cancel();
  assert.equal((await call('POST', `/api/runs/${run.id}/input`, { data: 'x'.repeat(200 * 1024) })).status, 413);
  assert.equal((await call('POST', `/api/runs/${run.id}/cancel`, {})).status, 400, 'Stopping needs confirmation.');
  const moved = await call('POST', `/api/tasks/${task.id}/move`, { column: 'todo', expectedRevision: (await app.board.view()).projects[0].tasks.find(item => item.id === task.id).revision });
  assert.equal(moved.status, 409, 'An active card cannot move until its run stops.');
  assert.equal((await call('POST', `/api/runs/${run.id}/cancel`, { confirm: true })).status, 200);
  await until(async () => (await app.board.run(run.id)).status === 'cancelled', 'cancelled over HTTP');
  // A page reload (new board read) starts nothing.
  const before = (await app.board.view()).runs.length;
  await fetch(app.url + '/api/board', { headers: { 'x-ste-token': token } });
  assert.equal((await app.board.view()).runs.length, before);
});
