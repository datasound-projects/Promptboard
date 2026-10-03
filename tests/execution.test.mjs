// PB-02 tests. Everything here is SIMULATED: fake CLIs (tests/fixtures/fake-agent.cjs)
// stand in for Claude Code, Codex, and Gemini CLI. Live-provider checks are separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, ARGV_PROMPT_LIMIT, buildSession, composeMessage, HOOK_SCRIPT, interpretEvent, resolveConfig, validateResumeId } from '../src/agents.mjs';
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

test('native resume selects an exact conversation, preserves controls and treats continuation text as data', async t => {
  const runDir = await temp(t, 'pb-resume-argv-'), id = '550e8400-e29b-41d4-a716-446655440000';
  for (const bad of ['', '--dangerously-bypass-approvals-and-sandbox', 'latest', '1', '/tmp/transcript', 'name with spaces']) assert.throws(() => validateResumeId(bad), { code: 'SESSION_ID_UNAVAILABLE' });
  for (const provider of ['claude', 'codex', 'gemini']) {
    for (const message of ['', '--dangerously-skip-permissions\n@/etc/passwd `id`']) {
      const built = await buildSession({ provider, stage: 'executing', config: resolveConfig('executing', { provider }), message, runDir,
        eventsFile: join(runDir, 'events'), sessionId: 'unused', resumeId: id, workspacePath: runDir });
      assert.equal(built.args.includes('--last'), false); assert.equal(built.args.includes('--session-id'), false);
      if (provider === 'codex') { assert.deepEqual(built.args.slice(0, 4), ['resume', id, '--cd', runDir]); assert.equal(built.args[built.args.indexOf('--sandbox') + 1], 'workspace-write'); }
      else assert.equal(built.args[built.args.indexOf('--resume') + 1], id);
      if (!message) { assert.equal(built.paste, null); assert.equal(built.args.includes('--prompt-interactive'), false); }
      else if (provider === 'gemini') assert.equal(JSON.parse(built.args[built.args.indexOf('--prompt-interactive') + 1].split('\n').slice(1).join('\n')), message);
      else assert.deepEqual(built.args.slice(-2), ['--', message], 'Option-like text must follow the option terminator.');
    }
  }
});

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

test('pause/resume keeps one native conversation across owned processes without replaying task or Base text', { skip }, async t => {
  const w = await world(t);
  for (const provider of ['claude', 'codex', 'gemini']) {
    const card = await w.task(`Resume ${provider}`, 'Exact engineered task with WRITE_FILE:resume.txt');
    const skill = await baseSkill(w.board, `Original Base context ${provider}`);
    await attachBase(w.board, { scope: 'task', projectId: w.projectId, taskId: card.id }, skill);
    const first = await w.board.requestRun(card.id, { stage: 'executing', consent: true, config: { provider } });
    await until(async () => (await w.run(first.id)).turnComplete, `${provider} first turn`);
    const nativeId = (await w.run(first.id)).providerSessionId, originalPid = w.supervisor.sessions.get(first.id).proc.pid;
    await assert.rejects(w.board.pauseRun(first.id), { code: 'CONFIRMATION_REQUIRED' }); assert.ok(alive(originalPid));
    await w.board.pauseRun(first.id, { confirm: true });
    assert.equal((await w.run(first.id)).status, 'suspended'); assert.equal(alive(originalPid), false);
    let saved = (await w.board.state()).sessions.find(session => session.id === first.sessionId);
    assert.equal(saved.pauseIntent, 'user'); assert.equal(saved.nativeSessionId, nativeId);
    await assert.rejects(w.board.resumeTask(card.id), { code: 'CONSENT_REQUIRED' });
    const requests = await Promise.allSettled([w.board.resumeTask(card.id, { consent: true }), w.board.resumeTask(card.id, { consent: true })]);
    assert.equal(requests.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(requests.find(result => result.status === 'rejected').reason.code, 'RUN_ACTIVE');
    const resumed = requests.find(result => result.status === 'fulfilled').value;
    await until(async () => (await w.run(resumed.id)).status === 'running', `${provider} resumed process`);
    assert.equal(resumed.sessionId, first.sessionId); assert.equal(resumed.workspacePath, first.workspacePath);
    assert.equal(resumed.providerSessionId, nativeId); assert.equal(resumed.resumeFrom.runId, first.id);
    assert.equal(await readFile(join(w.dataDir, resumed.artifactsDir, 'prompt.md'), 'utf8'), '');
    assert.equal(await readFile(join(resumed.workspacePath, 'resume.txt'), 'utf8'), 'written by the agent\n');
    assert.equal((await w.run(resumed.id)).turns, 0, 'Inspection resume must send no hidden prompt.');
    saved = (await w.board.state()).sessions.find(session => session.id === first.sessionId);
    assert.deepEqual(saved.runIds, [first.id, resumed.id]); assert.equal(saved.pauseIntent, null);
    assert.equal((await w.run(resumed.id)).baseManifest.supplied.filter(item => item.resourceId === skill.id).length, 1, 'Resume starts a fresh delivery record.');
    w.supervisor.input(resumed.id, 'A follow-up question\r');
    await until(async () => (await w.run(resumed.id)).turnComplete, `${provider} resumed turn`);
    assert.equal((await w.run(resumed.id)).providerSessionId, nativeId);
    await w.supervisor.cancel(resumed.id);
  }
});

test('resume rechecks Base revocations and stale task text before creating a process', { skip }, async t => {
  const w = await world(t), card = await w.task('Pinned context', 'Original requirement');
  const skill = await baseSkill(w.board); await attachBase(w.board, { scope: 'task', projectId: w.projectId, taskId: card.id }, skill);
  const run = await w.board.requestRun(card.id, { stage: 'executing', consent: true });
  await until(async () => (await w.run(run.id)).turnComplete, 'first turn'); await w.board.pauseRun(run.id, { confirm: true });
  const before = (await w.board.state()).runs.length;
  const disabled = await w.board.base.update(skill.id, { enabled: false }, { expectedRevision: skill.revision });
  await assert.rejects(w.board.resumeTask(card.id, { consent: true }), { code: 'BASE_REVOKED' });
  await w.board.base.update(skill.id, { enabled: true }, { expectedRevision: disabled.revision });
  const task = (await w.board.view()).projects.flatMap(project => project.tasks).find(task => task.id === card.id);
  await w.board.updateTask(task.id, { prompt: 'Changed requirement', expectedRevision: task.revision });
  await assert.rejects(w.board.resumeTask(card.id, { consent: true }), { code: 'SESSION_PROMPT_STALE' });
  assert.equal((await w.board.state()).runs.length, before); assert.equal((await w.reports()).length, 1);
});

test('pausing a queued task never spawns it or resumes a different conversation', { skip }, async t => {
  const w = await world(t), first = await w.task('Occupy slot', 'Keep this agent alive'), second = await w.task('Queued pause', 'Never start this task');
  const active = await w.board.requestRun(first.id, { stage: 'executing', consent: true });
  await until(async () => (await w.run(active.id)).turnComplete, 'occupied slot');
  const queued = await w.board.requestRun(second.id, { stage: 'executing', consent: true });
  await w.board.pauseRun(queued.id, { confirm: true });
  assert.equal((await w.run(queued.id)).status, 'suspended');
  await assert.rejects(w.board.resumeTask(second.id, { consent: true }), { code: 'SESSION_ID_UNAVAILABLE' });
  await w.supervisor.cancel(active.id); await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await w.reports()).length, 1); assert.equal(w.supervisor.queue.length, 0);
});

test('pause aborts preparation and failed pause persistence leaves the owned agent usable', { skip }, async t => {
  const w = await world(t), card = await w.task('Pause preparation', 'No spawn');
  let entered;
  const ready = new Promise(resolve => { entered = resolve; }), original = w.supervisor.basePreparer;
  w.supervisor.basePreparer = async args => {
    entered(); await new Promise((resolve, reject) => args.signal.addEventListener('abort', () => reject(args.signal.reason), { once: true }));
  };
  const queued = await w.board.requestRun(card.id, { stage: 'executing', consent: true });
  await ready; await w.board.pauseRun(queued.id, { confirm: true });
  await until(() => !w.supervisor.launching?.has(queued.id), 'paused preparation unwinds');
  assert.equal((await w.run(queued.id)).status, 'suspended'); assert.deepEqual(await w.reports(), []);
  w.supervisor.basePreparer = original;
  const activeCard = await w.task('Persistence failure', 'Keep working');
  const active = await w.board.requestRun(activeCard.id, { stage: 'executing', consent: true });
  await until(async () => (await w.run(active.id)).turnComplete, 'live agent');
  const pid = w.supervisor.sessions.get(active.id).proc.pid, save = w.board.beginSuspension;
  w.board.beginSuspension = async () => { throw new Error('Fixture disk write failure'); };
  await assert.rejects(w.board.pauseRun(active.id, { confirm: true }), /Fixture disk write failure/);
  w.board.beginSuspension = save;
  assert.ok(alive(pid)); assert.equal(w.supervisor.sessions.get(active.id).suspending, false);
  w.supervisor.input(active.id, 'Still usable\r');
  await until(async () => (await w.run(active.id)).turns === 2, 'input works after failed pause');
  assert.equal((await w.board.state()).sessions.find(item => item.id === active.sessionId).pauseIntent, null);
});

test('a resumed CLI reporting another native conversation is stopped without overwriting the original ID', { skip }, async t => {
  const w = await world(t), card = await w.task('Wrong CLI conversation', 'Initial task');
  const first = await w.board.requestRun(card.id, { stage: 'executing', consent: true });
  await until(async () => (await w.run(first.id)).turnComplete, 'native ID captured');
  const nativeId = (await w.run(first.id)).providerSessionId;
  await w.board.pauseRun(first.id, { confirm: true });
  const saved = process.env.FAKE_AGENT_RESUME_ID;
  process.env.FAKE_AGENT_RESUME_ID = 'wrong-conversation';
  t.after(() => { if (saved === undefined) delete process.env.FAKE_AGENT_RESUME_ID; else process.env.FAKE_AGENT_RESUME_ID = saved; });
  const resumed = await w.board.resumeTask(card.id, { consent: true });
  await until(async () => (await w.run(resumed.id)).errorCode === 'SESSION_ID_MISMATCH' && !w.supervisor.sessions.get(resumed.id)?.proc, 'wrong conversation stopped');
  assert.equal((await w.run(resumed.id)).providerSessionId, nativeId);
  assert.equal((await w.board.state()).sessions.find(item => item.id === first.sessionId).nativeSessionId, nativeId);
});

test('pause and resume HTTP routes enforce authorization and send only the explicit continuation', { skip }, async t => {
  const w = await world(t, { server: true }), card = await w.task('HTTP continuation', 'Do not replay this task.');
  const { token } = await fetch(w.app.url + '/api/session').then(response => response.json());
  const call = (path, body, headers = {}) => fetch(w.app.url + path, { method: 'POST', headers: { 'x-ste-token': token, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const first = await w.board.requestRun(card.id, { stage: 'executing', consent: true });
  await until(async () => (await w.run(first.id)).turnComplete, 'first HTTP turn');
  const pausePath = `/api/runs/${first.id}/pause`, resumePath = `/api/tasks/${card.id}/resume`;
  assert.equal((await call(pausePath, { confirm: true }, { 'x-ste-token': '' })).status, 403);
  assert.equal((await call(pausePath, {})).status, 400);
  assert.equal((await call(pausePath, { confirm: true })).status, 200);
  assert.equal((await call(resumePath, { consent: true }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(resumePath, {})).status, 400);
  assert.equal((await call(resumePath, { consent: true, message: 'x'.repeat(64 * 1024 + 1) })).status, 400);
  const message = 'Only this continuation\n--dangerously-skip-permissions';
  const response = await call(resumePath, { consent: true, message }); assert.equal(response.status, 200);
  const resumed = (await response.json()).run;
  await until(async () => (await w.run(resumed.id)).turnComplete, 'explicit continuation turn');
  assert.equal(await readFile(join(w.dataDir, resumed.artifactsDir, 'prompt.md'), 'utf8'), message);
  assert.equal(await readFile(join(w.dataDir, resumed.artifactsDir, 'task-prompt.txt'), 'utf8'), card.prompt);
});

async function baseSkill(board, text = 'BASE INSTRUCTION ONLY FOR ASSIGNED TARGET') {
  return board.base.create({ kind: 'skill', name: 'Reusable instructions', enabled: true, trust: 'trusted', content: { body: text } });
}
async function attachBase(board, target, resource, mode = 'extend') {
  return board.base.apply({ changes: [{ target, binding: { mode, include: resource ? [{ resourceId: resource.id, required: true }] : [], exclude: [] } }], expectedBaseRevision: (await board.state()).base.revision });
}

test('Base custom-column task overrides deliver isolated resources to concurrent inherited-provider agents from their own workspaces', { skip }, async t => {
  const w = await world(t, { limit: 2 });
  const project = (await w.board.view()).projects[0];
  const customId = 'c_base0001';
  const columns = ['todo', 'planning', 'executing', { id: customId, custom: true, title: 'Research', color: 'blue', agent: { enabled: true, policy: 'start', instructions: 'Follow the task.' } }, 'code_review', 'testing', 'merge', 'done'].map(value => typeof value === 'string' ? { id: value } : value);
  await w.board.setColumns(w.projectId, { columns, expectedRevision: project.revision });
  const a = await w.task('A', 'Task A'), b = await w.task('B', 'Task B');
  const skillA = await baseSkill(w.board, 'ONLY_RESOURCE_A'), skillB = await baseSkill(w.board, 'ONLY_RESOURCE_B');
  const context = await w.board.base.create({ kind: 'context', name: 'Task workspace README', enabled: true, trust: 'trusted', configuration: { sources: [{ kind: 'repository', path: 'README.md' }] } });
  await attachBase(w.board, { scope: 'column', projectId: w.projectId, columnId: customId }, skillA);
  await attachBase(w.board, { scope: 'task-column', projectId: w.projectId, taskId: b.id, columnId: customId }, skillB, 'replace');
  for (const card of [a, b]) {
    const workspace = await w.board.ensureTaskWorktree(card.id);
    await writeFile(join(workspace.path, 'README.md'), `WORKSPACE_CONTEXT_${card.id}\n`);
  }
  const bindingB = { mode: 'replace', include: [skillB, context].map(resource => ({ resourceId: resource.id, required: true })), exclude: [] };
  await w.board.base.apply({ changes: [{ target: { scope: 'task-column', projectId: w.projectId, taskId: b.id, columnId: customId }, binding: bindingB }, { target: { scope: 'task', projectId: w.projectId, taskId: a.id }, binding: { mode: 'extend', include: [{ resourceId: context.id, required: true }], exclude: [] } }], expectedBaseRevision: (await w.board.state()).base.revision });
  const current = async id => (await w.board.view()).projects[0].tasks.find(task => task.id === id);
  const runA = (await w.board.transition(a.id, { column: customId, expectedRevision: (await current(a.id)).revision })).run;
  const runB = (await w.board.transition(b.id, { column: customId, expectedRevision: (await current(b.id)).revision })).run;
  await until(async () => (await w.run(runA.id)).turns && (await w.run(runB.id)).turns, 'custom agents receive separate Base context');
  for (const [run, card, own, other] of [[runA, a, 'ONLY_RESOURCE_A', 'ONLY_RESOURCE_B'], [runB, b, 'ONLY_RESOURCE_B', 'ONLY_RESOURCE_A']]) {
    const message = await readFile(join(w.dataDir, run.artifactsDir, 'prompt.md'), 'utf8');
    assert.match(message, new RegExp(own)); assert.doesNotMatch(message, new RegExp(other)); assert.ok(message.includes(`WORKSPACE_CONTEXT_${card.id}`)); assert.doesNotMatch(message, /main checkout/);
    const accepted = await w.run(run.id); assert.equal(accepted.stage, customId); assert.equal(accepted.config.provider, 'claude');
    assert.ok(accepted.baseManifest.supplied.some(item => item.resourceId === context.id && item.captures[0].path === 'README.md'));
    assert.equal(card.contentRevision, (await current(card.id)).contentRevision, 'Assignments do not edit task text.');
  }
  const reports = await w.reports(); assert.equal(reports.length, 2);
  assert.ok(reports.find(report => report.args.at(-1).includes('ONLY_RESOURCE_A'))); assert.ok(reports.find(report => report.args.at(-1).includes('ONLY_RESOURCE_B')));
  await w.supervisor.cancel(runA.id); assert.equal((await w.run(runB.id)).status, 'waiting_for_input');
});

test('Base source changes after plan approval are recorded without changing the approved task text', { skip }, async t => {
  const w = await world(t);
  const context = await w.board.base.create({ kind: 'context', name: 'Repository guide', enabled: true, trust: 'trusted', configuration: { sources: [{ kind: 'repository', path: 'README.md' }] } });
  await attachBase(w.board, { scope: 'project', projectId: w.projectId }, context);
  const task = await w.board.createTask({ projectId: w.projectId, title: 'Plan with context', prompt: 'Implement the documented feature.' });
  const planning = (await w.board.transition(task.id, { column: 'planning', expectedRevision: task.revision })).run;
  await until(async () => (await w.run(planning.id)).hasPlan, 'Base-informed plan');
  await w.supervisor.confirm(planning.id);
  const approved = (await w.board.view()).projects[0].tasks.find(item => item.id === task.id);
  assert.equal(approved.planApproval.runId, planning.id);
  await writeFile(join(planning.workspacePath, 'README.md'), 'UPDATED GUIDE AFTER PLAN APPROVAL\n');
  const executing = (await w.board.transition(task.id, { column: 'executing', expectedRevision: approved.revision })).run;
  await until(async () => (await w.run(executing.id)).turns, 'execution captures updated context');
  const finished = await w.run(executing.id), prior = await w.run(planning.id);
  assert.equal(finished.planRunId, planning.id);
  assert.equal(finished.planBaseChanged, true, 'Approval is not claimed to cover newly captured Base context.');
  assert.notEqual(finished.baseManifest.supplied[0].contentHash, prior.baseManifest.supplied[0].contentHash);
  assert.equal((await w.board.view()).projects[0].tasks.find(item => item.id === task.id).contentRevision, task.contentRevision);
  const prompt = await readFile(join(w.dataDir, finished.artifactsDir, 'prompt.md'), 'utf8');
  assert.match(prompt, /UPDATED GUIDE AFTER PLAN APPROVAL/); assert.match(prompt, /=== APPROVED PLAN ===/); assert.ok(prompt.includes(task.prompt));
});

test('A transition resolves required Base resources against the explicit runtime provider override', { skip }, async t => {
  const w = await world(t), skill = await baseSkill(w.board, 'RUNTIME_PROVIDER_BASE');
  await attachBase(w.board, { scope: 'project', projectId: w.projectId }, skill);
  // A legacy/imported unavailable provider must not defeat an explicit supported override.
  await w.board.store.update(state => { state.projects.find(project => project.id === w.projectId).agentDefaults = { provider: 'agy', model: 'unavailable-model', effort: 'high' }; });
  const task = await w.board.createTask({ projectId: w.projectId, title: 'Runtime provider', prompt: 'Use the selected runtime provider.' });
  const started = await w.board.transition(task.id, { column: 'executing', expectedRevision: task.revision, config: { provider: 'claude' } });
  await until(async () => (await w.run(started.run.id)).turns, 'runtime override delivered Base');
  const run = await w.run(started.run.id);
  assert.equal(run.config.provider, 'claude'); assert.equal(run.config.model, ''); assert.equal(run.config.effort, '');
  assert.equal(run.baseManifest.provider, 'claude'); assert.match(await readFile(join(w.dataDir, run.artifactsDir, 'prompt.md'), 'utf8'), /RUNTIME_PROVIDER_BASE/);
});

test('A Base revocation during asynchronous transition validation prevents handoff and commit', { skip }, async t => {
  const w = await world(t), task = await w.task('Preserve dirty work', 'WRITE_FILE');
  const active = await w.board.requestRun(task.id, { stage: 'executing', consent: true });
  await until(async () => (await w.run(active.id)).turns, 'finished dirty execution');
  const before = git(active.workspacePath, 'rev-parse', 'HEAD');
  const skill = await baseSkill(w.board);
  await attachBase(w.board, { scope: 'column', projectId: w.projectId, columnId: 'code_review' }, skill);
  const validate = w.supervisor.validate.bind(w.supervisor); let revoked = false;
  w.supervisor.validate = async options => {
    const result = await validate(options);
    if (options.stage === 'code_review' && !revoked) { revoked = true; await w.board.base.update(skill.id, { trust: 'revoked' }, { expectedRevision: skill.revision }); }
    return result;
  };
  const current = (await w.board.view()).projects[0].tasks.find(item => item.id === task.id);
  await assert.rejects(w.board.transition(task.id, { column: 'code_review', expectedRevision: current.revision }), { code: 'BASE_REQUIRED_UNAVAILABLE' });
  assert.equal((await w.run(active.id)).status, 'waiting_for_input');
  assert.equal(git(active.workspacePath, 'rev-parse', 'HEAD'), before);
  assert.match(git(active.workspacePath, 'status', '--porcelain'), /agent-output\.txt/);
  assert.equal((await w.board.view()).projects[0].tasks.find(item => item.id === task.id).column, 'executing');
});

test('Manifest, artifact, or status persistence failures after spawning terminate only that run and release its queue slot', { skip, timeout: 60000 }, async t => {
  const w = await world(t, { limit: 2 }), hold = await w.task('Unaffected run', 'Keep this separate session alive.');
  const unrelated = await w.board.requestRun(hold.id, { stage: 'executing', consent: true });
  await until(async () => (await w.run(unrelated.id)).turns, 'unrelated session ready');
  const unrelatedPid = (await w.reports())[0].pid;
  const skill = await baseSkill(w.board, 'PERSISTENCE_FAILURE_RESOURCE');
  const record = w.board.recordBaseManifest.bind(w.board), update = w.board.updateRun.bind(w.board);
  for (const failure of ['manifest', 'artifact', 'status']) {
    const card = await w.board.createTask({ projectId: w.projectId, title: `Fail ${failure}`, prompt: 'Start, then fail durable bookkeeping.' });
    await attachBase(w.board, { scope: 'task', projectId: w.projectId, taskId: card.id }, skill);
    let release, entered = false, injected = false;
    const gate = new Promise(resolve => { release = resolve; });
    const inject = async runId => {
      const run = await w.run(runId);
      if (injected || run.taskId !== card.id) return;
      injected = true;
      await until(async () => (await w.reports()).some(report => report.cwd === run.workspacePath), 'failed-start CLI actually spawned');
      entered = true; await gate;
      if (failure === 'artifact') await mkdir(join(w.dataDir, run.artifactsDir, 'base-manifest.json'));
      else throw Object.assign(new Error('private filesystem failure detail'), { code: 'EIO' });
    };
    w.board.recordBaseManifest = async (runId, manifest) => { if (failure !== 'status' && manifest.deliveryState === 'supplied') await inject(runId); return record(runId, manifest); };
    w.board.updateRun = async (runId, fields) => { if (failure === 'status' && fields.status === 'running') await inject(runId); return update(runId, fields); };
    const started = (await w.board.transition(card.id, { column: 'executing', expectedRevision: card.revision })).run;
    await until(() => entered, `${failure} failure point`);
    const next = await w.board.createTask({ projectId: w.projectId, title: `After ${failure}`, prompt: 'The queued task still starts.' });
    const queued = (await w.board.transition(next.id, { column: 'executing', expectedRevision: next.revision })).run;
    assert.equal((await w.run(queued.id)).status, 'queued');
    release();
    await until(async () => (await w.run(started.id)).status === 'failed', `${failure} persisted as failed`);
    await until(() => !w.supervisor.launching?.has(started.id), `${failure} failed-start rollback finished`);
    const pid = (await w.reports()).find(report => report.cwd === started.workspacePath).pid;
    assert.equal(alive(pid), false, `${failure} failure did not leave its process running`);
    assert.equal(alive(unrelatedPid), true);
    assert.equal((await w.board.view()).projects[0].tasks.find(item => item.id === card.id).column, 'todo');
    assert.equal((await w.run(started.id)).baseManifest.deliveryState, 'failed');
    assert.equal((await w.run(started.id)).baseManifest.supplied[0].resourceId, skill.id, 'Historical capture remains readable when a process actually received it.');
    assert.doesNotMatch((await w.run(started.id)).reason, /private filesystem/);
    await until(async () => (await w.run(queued.id)).turns, 'next queued run continues after failed start');
    await w.supervisor.cancel(queued.id);
  }
  w.board.recordBaseManifest = record; w.board.updateRun = update;
  assert.equal((await w.run(unrelated.id)).status, 'waiting_for_input');
});

test('nested Base agent profiles reach the existing PTY as native subagents with their pinned resources', { skip }, async t => {
  const w = await world(t), skill = await baseSkill(w.board, 'SUBAGENT_RESOURCE_CONTEXT');
  const child = await w.board.base.create({ kind: 'profile', name: 'Specialist', configuration: { agent: { provider: 'claude', instructions: 'SPECIALIST_ROLE' }, binding: { mode: 'extend', include: [{ resourceId: skill.id, required: true }], exclude: [] } } });
  const parent = await w.board.base.create({ kind: 'profile', name: 'Lead', configuration: { agent: { provider: 'claude' }, binding: { mode: 'extend', include: [{ resourceId: child.id, required: true }], exclude: [] } } });
  await w.board.base.apply({ changes: [{ target: { scope: 'project', projectId: w.projectId }, binding: { mode: 'inherit' }, profileId: parent.id }] });
  const task = await w.board.createTask({ projectId: w.projectId, title: 'Native specialist', prompt: 'Exact original task. ' });
  const transition = await w.board.transition(task.id, { column: 'executing', expectedRevision: task.revision });
  const run = await until(async () => { const current = await w.run(transition.run.id); return current.turns && current; }, 'native agent configuration supplied');
  const report = (await w.reports())[0], native = JSON.parse(report.args[report.args.indexOf('--agents') + 1]);
  assert.match(Object.values(native)[0].prompt, /SPECIALIST_ROLE/); assert.match(Object.values(native)[0].prompt, /SUBAGENT_RESOURCE_CONTEXT/);
  assert.equal(await readFile(join(w.dataDir, run.artifactsDir, 'task-prompt.txt'), 'utf8'), task.prompt);
  assert.equal(run.baseManifest.supplied.find(resource => resource.resourceId === child.id).delivery, 'native-subagent'); assert.equal(run.baseManifest.observed.length, 0);
});

test('Base portable project resources reach each existing CLI through normal transitions; exact task text and unassigned targets stay intact', { skip }, async t => {
  const w = await world(t, { limit: 2 });
  const skill = await baseSkill(w.board);
  await attachBase(w.board, { scope: 'project', projectId: w.projectId }, skill);
  const exact = '  Exact task\r\n@file `literal` $(not-a-command)  \n';
  for (const provider of ['claude', 'codex', 'gemini']) {
    const task = await w.board.createTask({ projectId: w.projectId, title: provider, prompt: exact });
    const transition = await w.board.transition(task.id, { column: 'executing', expectedRevision: task.revision, transitionId: `base-delivery-${provider}`, config: { provider } });
    const run = await until(async () => { const current = await w.run(transition.run.id); return current.turns && current; }, `${provider} receives Base`);
    const prompt = await readFile(join(w.dataDir, run.artifactsDir, 'prompt.md'), 'utf8');
    assert.ok(prompt.includes(`=== TASK (exact text from the card) ===\n${exact}\n=== END TASK ===`));
    assert.match(prompt, /BASE INSTRUCTION ONLY FOR ASSIGNED TARGET/);
    assert.equal(await readFile(join(w.dataDir, run.artifactsDir, 'task-prompt.txt'), 'utf8'), exact);
    assert.equal(run.baseManifest.resources[0].revision, skill.revision);
    assert.equal(run.baseManifest.deliveryState, 'supplied');
    assert.equal(run.baseManifest.supplied[0].delivery, 'instruction');
    assert.equal(run.baseManifest.observed.length, 0, 'Attachment is not observed invocation.');
    assert.equal(JSON.parse(await readFile(join(w.dataDir, run.artifactsDir, 'base-manifest.json'), 'utf8')).resources[0].resourceId, skill.id);
    await w.supervisor.cancel(run.id);
  }
  const project = await w.board.createProject({ name: 'No Base' });
  await w.board.linkRepository(project.id, { path: w.root, expectedRevision: project.revision });
  const task = await w.board.createTask({ projectId: project.id, title: 'Unassigned', prompt: exact });
  const { run } = await w.board.transition(task.id, { column: 'executing', expectedRevision: task.revision });
  await until(async () => (await w.run(run.id)).turns, 'unassigned run');
  assert.doesNotMatch(await readFile(join(w.dataDir, run.artifactsDir, 'prompt.md'), 'utf8'), /BASE INSTRUCTION ONLY/);
  assert.deepEqual((await w.run(run.id)).baseManifest.resources, []);
});

test('Base queued definitions stay pinned after edits; current revocation blocks launch and rolls back the move', { skip }, async t => {
  const w = await world(t);
  const first = await w.task('Occupy slot', 'First');
  const occupying = await w.board.requestRun(first.id, { stage: 'executing', consent: true });
  await until(async () => (await w.run(occupying.id)).turns, 'first holds slot');
  const skill = await baseSkill(w.board, 'PINNED OLD CONTENT');
  const pinned = await w.board.createTask({ projectId: w.projectId, title: 'Pinned', prompt: 'Keep the old instructions.' });
  await attachBase(w.board, { scope: 'task', projectId: w.projectId, taskId: pinned.id }, skill);
  const queued = (await w.board.transition(pinned.id, { column: 'executing', expectedRevision: pinned.revision })).run;
  await w.board.base.update(skill.id, { content: { body: 'NEW FUTURE CONTENT' } }, { expectedRevision: 1 });
  await w.supervisor.cancel(occupying.id);
  await until(async () => (await w.run(queued.id)).turns, 'pinned queued launch');
  const prompt = await readFile(join(w.dataDir, queued.artifactsDir, 'prompt.md'), 'utf8');
  assert.match(prompt, /PINNED OLD CONTENT/); assert.doesNotMatch(prompt, /NEW FUTURE CONTENT/);
  const revoked = await w.board.createTask({ projectId: w.projectId, title: 'Revoked', prompt: 'Never launch this.' });
  await attachBase(w.board, { scope: 'task', projectId: w.projectId, taskId: revoked.id }, skill);
  const denied = (await w.board.transition(revoked.id, { column: 'executing', expectedRevision: revoked.revision })).run;
  await w.board.base.update(skill.id, { trust: 'revoked' }, { expectedRevision: 2 });
  await w.supervisor.cancel(queued.id);
  await until(async () => (await w.run(denied.id)).status === 'failed', 'revoked queued failure');
  await until(() => !w.supervisor.launching?.has(denied.id), 'revoked queued rollback finished');
  const state = await w.board.view(), card = state.projects[0].tasks.find(task => task.id === revoked.id);
  assert.equal(card.column, 'todo');
  assert.equal((await w.run(denied.id)).errorCode, 'BASE_REVOKED');
  assert.equal((await w.reports()).length, 2);
});

test('Base required preflight fails before handoff and commit; manual moves remain available', { skip }, async t => {
  const w = await world(t);
  const task = await w.task('Preserve unfinished output', 'WRITE_FILE:base-feature.txt');
  const run = await w.board.requestRun(task.id, { stage: 'executing', consent: true });
  await until(async () => (await w.run(run.id)).turns, 'execution complete');
  const mcp = await w.board.base.create({ kind: 'mcp', name: 'Not allowed in Review', enabled: true, trust: 'trusted', configuration: { transport: 'stdio', command: process.execPath, args: [] } });
  await attachBase(w.board, { scope: 'column', projectId: w.projectId, columnId: 'code_review' }, mcp);
  const latest = (await w.board.view()).projects[0].tasks.find(card => card.id === task.id);
  await assert.rejects(w.board.transition(task.id, { column: 'code_review', expectedRevision: latest.revision }), { code: 'BASE_REQUIRED_UNAVAILABLE' });
  assert.equal((await w.run(run.id)).status, 'waiting_for_input', 'The failed transition never confirms the outgoing stage.');
  assert.match(git(run.workspacePath, 'status', '--porcelain'), /base-feature/);
  const moved = await w.board.transition(task.id, { column: 'code_review', expectedRevision: latest.revision, decision: 'move' });
  assert.equal(moved.task.column, 'code_review', 'A move with no destination agent does not require MCP delivery.');
});

test('Base changes during asynchronous acceptance reject a stale run instead of pinning a stale selection', { skip }, async t => {
  const w = await world(t), skill = await baseSkill(w.board);
  const task = await w.task('Racing configuration', 'Original prompt');
  const validate = w.supervisor.validate.bind(w.supervisor);
  let release, enter;
  const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { enter = resolve; });
  w.supervisor.validate = async value => { const result = await validate(value); enter(); await gate; return result; };
  t.after(() => release());
  const pending = w.board.requestRun(task.id, { stage: 'executing', consent: true });
  const rejected = assert.rejects(pending, { code: 'BASE_REVISION_CONFLICT' });
  await entered;
  await attachBase(w.board, { scope: 'task', projectId: w.projectId, taskId: task.id }, skill);
  release(); await rejected;
  assert.equal((await w.board.state()).runs.length, 0);
});

test('Base launch preparation is cancellable and does not spawn or interfere with another queued run', { skip }, async t => {
  const w = await world(t), skill = await baseSkill(w.board);
  const task = await w.task('Cancel Base preparation', 'Do not start');
  await attachBase(w.board, { scope: 'task', projectId: w.projectId, taskId: task.id }, skill);
  const original = w.supervisor.basePreparer;
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  w.supervisor.basePreparer = async args => {
    entered();
    await new Promise((resolve, reject) => args.signal.addEventListener('abort', () => reject(args.signal.reason), { once: true }));
    return original(args);
  };
  const run = await w.board.requestRun(task.id, { stage: 'executing', consent: true });
  await ready; await w.supervisor.cancel(run.id);
  await until(() => w.supervisor.preparing.size === 0, 'preparation unwinds');
  assert.equal((await w.run(run.id)).status, 'cancelled'); assert.equal((await w.reports()).length, 0);
  w.supervisor.basePreparer = original;
  const other = await w.task('Unaffected next task', 'Next');
  const next = await w.board.requestRun(other.id, { stage: 'executing', consent: true });
  await until(async () => (await w.run(next.id)).turns, 'next run starts');
  assert.deepEqual((await w.run(next.id)).baseManifest.resources, []);
});

test('Shutdown during or immediately after preparation stays interrupted without rollback; cancellation stays cancelled', { skip }, async t => {
  for (const timing of ['preparing', 'preparing-entry-removed', 'cancelled']) await t.test(timing, async t => {
    const w = await world(t);
    const task = await w.board.createTask({ projectId: w.projectId, title: 'Interrupted preparation', prompt: 'Never spawn.' });
    let enter, release, failEntered, releaseFailure;
    const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const failureEntered = new Promise(resolve => { failEntered = resolve; }), failureGate = new Promise(resolve => { releaseFailure = resolve; });
    t.after(() => { release(); releaseFailure(); });
    w.supervisor.basePreparer = async () => { enter(); await gate; throw Object.assign(new Error('Preparation stopped'), { code: 'ABORTED' }); };
    const moved = await w.board.transition(task.id, { column: 'executing', expectedRevision: task.revision });
    const runId = moved.run.id;
    await entered;
    let rollbackCalls = 0;
    const rollback = w.board.runFailedToStart.bind(w.board);
    w.board.runFailedToStart = async id => { rollbackCalls++; return rollback(id); };
    if (timing === 'preparing-entry-removed') {
      // Hold failed-start handling after #launch has removed its preparing entry.
      // Shutdown must still catch this queued run using its stopping flag.
      const readRun = w.board.run.bind(w.board);
      let held = false;
      w.board.run = async id => {
        if (id === runId && !held && !w.supervisor.preparing.has(id)) { held = true; failEntered(); await failureGate; }
        return readRun(id);
      };
      release(); await failureEntered;
      assert.equal(w.supervisor.preparing.size, 0);
      await w.supervisor.shutdown(100);
      releaseFailure();
    } else {
      if (timing === 'cancelled') await w.supervisor.cancel(runId);
      await w.supervisor.shutdown(100);
      release();
    }
    await until(() => !w.supervisor.launching?.has(runId), 'shutdown preparation has fully unwound');
    const run = await w.run(runId);
    assert.equal(run.status, timing === 'cancelled' ? 'cancelled' : 'interrupted');
    assert.equal(run.baseManifest.deliveryState, 'configured', 'No delivery or failure is claimed for an interrupted preparation.');
    assert.equal(rollbackCalls, 0);
    assert.equal((await w.board.view()).projects[0].tasks.find(card => card.id === task.id).column, 'executing');
    assert.deepEqual(await w.reports(), []);
    assert.equal(w.supervisor.activeCount(), 0);
  });
});

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
