import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, copyFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Board, projectColumns, projectTransitions } from '../src/board.mjs';
import { Store, emptyState, STATE_VERSION } from '../src/store.mjs';
import { attachSession } from '../src/sessions.mjs';
import { defaultPipelineConfig } from '../src/pipeline-config.mjs';
import { pipelineTaskEnvelope } from '../src/pipeline-templates.mjs';
import { buildSession, resolveConfig } from '../src/agents.mjs';
import { Supervisor } from '../src/supervisor.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } }).trim();
async function temp(t) { const path = await realpath(await mkdtemp(join(tmpdir(), 'pb-pipeline-'))); t.after(() => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return path; }
async function until(fn) { const deadline = Date.now() + 10000; for (;;) { const value = await fn(); if (value) return value; if (Date.now() > deadline) assert.fail('Pipeline fixture did not become ready.'); await new Promise(resolve => setTimeout(resolve, 50)); } }
async function world(t, native = false) {
  const dataDir = await temp(t), root = await temp(t), board = new Board({ dataDir });
  git(root, 'init', '-q', '-b', 'trunk'); git(root, 'config', 'user.email', 'fixture@example.test'); git(root, 'config', 'user.name', 'Fixture');
  await writeFile(join(root, 'README.md'), 'main checkout\n'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'Fixture');
  const project = await board.createProject({ name: 'Pipeline' });
  await board.linkRepository(project.id, { path: root, expectedRevision: 1 });
  await board.setTargetBranch(project.id, { branch: 'trunk', expectedRevision: 2 });
  const starts = [];
  if (native) {
    const bin = await temp(t), fake = fileURLToPath(new URL('./fixtures/fake-agent.cjs', import.meta.url));
    for (const provider of ['claude', 'codex', 'gemini']) await copyFile(fake, join(bin, provider + '.cjs'));
    board.executor = new Supervisor({ board, dataDir, resolver: async provider => ({ command: process.execPath, prefix: [join(bin, provider + '.cjs')] }) });
    t.after(() => board.executor.shutdown(500));
  } else board.executor = { validate: async ({ stage, config }) => resolveConfig(stage, config), start: async payload => { starts.push(payload); },
    suspend: async id => board.updateRun(id, { status: 'suspended' }), cancel: async id => board.updateRun(id, { status: 'cancelled' }) };
  const projectNow = async () => (await board.state()).projects.find(item => item.id === project.id);
  const taskNow = async id => (await projectNow()).tasks.find(item => item.id === id);
  const configure = async pipeline => board.setPipeline(project.id, { pipeline, expectedRevision: (await projectNow()).revision, confirm: true });
  const move = async (id, column, extra = {}) => board.transition(id, { column, expectedRevision: (await taskNow(id)).revision, ...extra });
  return { board, dataDir, root, starts, projectNow, taskNow, configure, move, projectId: project.id };
}

test('a long Composer prompt is pasted and submitted once in a real owned PTY with Base and CLI tools intact', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t), report = join(await temp(t), 'initial-input.jsonl'), previous = process.env.FAKE_INITIAL_INPUT_FILE;
  process.env.FAKE_INITIAL_INPUT_FILE = report;
  t.after(() => { if (previous === undefined) delete process.env.FAKE_INITIAL_INPUT_FILE; else process.env.FAKE_INITIAL_INPUT_FILE = previous; });
  const fake = fileURLToPath(new URL('./fixtures/fake-initial-prompt.cjs', import.meta.url));
  w.board.executor = new Supervisor({ board: w.board, dataDir: w.dataDir, resolver: async () => ({ command: process.execPath, prefix: [fake] }) });
  t.after(() => w.board.executor.shutdown(500));
  const config = defaultPipelineConfig(); for (const column of config.columns) column.strategy.autoSpawn = false; config.columns[2].strategy.autoSpawn = true; config.columns[2].strategy.agentOverride = 'claude';
  await w.configure(config);
  const skill = await w.board.base.create({ kind: 'skill', name: 'Initial Base instruction', enabled: true, trust: 'trusted', content: { body: 'BASE_INITIAL_LITERAL' }, configuration: {} });
  const mcp = await w.board.base.create({ kind: 'mcp', name: 'Initial Base tool', enabled: true, trust: 'trusted', configuration: { transport: 'stdio', command: process.execPath, args: ['--version'] } });
  await w.board.base.apply({ changes: [{ target: { scope: 'project', projectId: w.projectId }, binding: { mode: 'extend', include: [{ resourceId: skill.id, required: true }, { resourceId: mcp.id, required: true }], exclude: [] } }], expectedBaseRevision: (await w.board.state()).base.revision });
  const prompt = '  Exact engineered <literal> & prompt\r\n' + 'long literal 😀 '.repeat(8000) + '\r\n  End ';
  const task = await w.board.createTask({ projectId: w.projectId, title: 'Long Composer', prompt }); assert.equal((await w.board.state()).runs.length, 0);
  const result = await w.move(task.id, 'executing');
  await until(async () => (await w.board.run(result.run.id)).turnComplete);
  const rows = (await readFile(report, 'utf8')).trim().split('\n').map(JSON.parse), submitted = rows.filter(row => row.kind === 'submitted');
  assert.equal(submitted.length, 1); assert.equal(submitted[0].submissions, 1); assert.ok(submitted[0].text.startsWith(pipelineTaskEnvelope(task))); assert.ok(submitted[0].text.includes('BASE_INITIAL_LITERAL'));
  assert.ok(rows[0].args.includes('--mcp-config')); assert.ok(!rows[0].args.includes('--strict-mcp-config')); assert.ok(!rows[0].args.includes('--tools')); assert.ok(!rows[0].args.includes('--disallowedTools'));
  const run = await w.board.run(result.run.id); assert.equal(submitted[0].text, await readFile(join(w.dataDir, run.artifactsDir, 'prompt.md'), 'utf8')); assert.equal(run.baseManifest.deliveryState, 'supplied'); assert.ok(run.baseManifest.resources.some(row => row.resourceId === mcp.id && row.delivery === 'native-mcp'));
  assert.equal((await w.taskNow(task.id)).prompt, prompt);
  await w.board.executor.cancel(result.run.id);
});

test('pipeline process privately observes actual PTY modes and manual input, closes on Done and starts fresh on native resume', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, true);
  for (const provider of ['claude', 'gemini', 'codex']) {
    const config = defaultPipelineConfig(); config.columns[2].strategy.agentOverride = provider; await w.configure(config);
    const task = await w.board.createTask({ projectId: w.projectId, title: `${provider} private terminal observation`, prompt: '  Exact Composer\r\n' });
    const first = await w.move(task.id, 'executing'); await until(async () => (await w.board.run(first.run.id)).turnComplete);
    const session = w.board.executor.sessions.get(first.run.id), observed = session.terminalInput;
    assert.deepEqual(observed.snapshot(), { bracketedPaste: null, controlPending: false, manualInputObserved: false, closed: false });
    w.board.executor.input(first.run.id, ''); assert.equal(observed.snapshot().manualInputObserved, false);
    // The offline CLI echoes these bytes; the observer receives real onData.
    w.board.executor.input(first.run.id, '\x1b[?2004h\r');
    await until(() => observed.snapshot().bracketedPaste === true); assert.equal(observed.snapshot().manualInputObserved, true);
    w.board.executor.input(first.run.id, '\x1b[?2004l\r'); await until(() => observed.snapshot().bracketedPaste === false);
    assert.doesNotMatch(JSON.stringify(await w.board.view()), /terminalInput|manualInputObserved|bracketedPaste/);
    await w.move(task.id, 'done'); assert.equal(observed.snapshot().closed, true);
    const restored = await w.move(task.id, 'executing');
    const next = await until(() => w.board.executor.sessions.get(restored.run.id)?.terminalInput);
    assert.notEqual(next, observed); assert.equal(next.snapshot().manualInputObserved, false); assert.equal(next.snapshot().bracketedPaste, null);
    assert.equal(restored.run.sessionId, first.run.sessionId); assert.equal((await w.taskNow(task.id)).prompt, task.prompt);
    await w.move(task.id, 'todo'); assert.equal(next.snapshot().closed, true);
  }
});

test('v4 migration preserves logical conversations byte-for-byte and assigns legacy rules without launching', async t => {
  const dir = await temp(t), original = { ...emptyState(), version: 4, projects: [{ id: 'p', tasks: [{ id: 't', column: 'executing', prompt: '  Composer\r\ntext  ' }] }] };
  const run = { id: 'r', taskId: 't', projectId: 'p', status: 'suspended', config: { provider: 'claude' }, artifactsDir: 'runs/r', providerSessionId: 'native-exact' };
  original.runs.push(run); attachSession(original, run, 'persistent-logical-id');
  const bytes = JSON.stringify(original); await writeFile(join(dir, 'state.json'), bytes);
  const store = new Store(dir), saved = await store.read();
  assert.equal(saved.version, STATE_VERSION); assert.equal(saved.projects[0].workflowMode, 'legacy');
  assert.deepEqual(saved.sessions, original.sessions); assert.deepEqual(saved.runs, original.runs);
  assert.equal(saved.projects[0].tasks[0].prompt, original.projects[0].tasks[0].prompt);
  assert.equal(await readFile(join(dir, store.recovery.migrationBackup), 'utf8'), bytes);
});

test('conversion is explicit and inert; role IDs control Composer entry and unrestricted moves; unsupported actions fail visibly', async t => {
  const w = await world(t), config = defaultPipelineConfig();
  await assert.rejects(w.board.setPipeline(w.projectId, { expectedRevision: 3 }), { code: 'CONFIRMATION_REQUIRED' });
  config.columns[0].id = 'inbox'; config.columns.at(-1).id = 'archive';
  for (const column of config.columns) column.strategy.autoSpawn = false;
  await w.configure(config); assert.equal(w.starts.length, 0);
  const prompt = '  Engineered {{title}}\r\nconst x = 1;  \r\n';
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Split task', prompt });
  assert.equal(card.column, 'inbox'); assert.equal(card.prompt, prompt); assert.equal(w.starts.length, 0);
  await w.move(card.id, 'testing'); await w.move(card.id, 'code_review'); await w.move(card.id, 'merge');
  assert.equal(w.starts.length, 0); assert.equal((await w.taskNow(card.id)).prompt, prompt);
  const copy = await w.board.duplicateTask(card.id); assert.equal(copy.column, 'inbox'); assert.equal(copy.prompt, prompt);
  const imported = 'browser-task-id';
  await w.board.migrateBrowserBoard({ version: 1, projects: [{ id: w.projectId, name: 'Pipeline', cards: [{ id: imported, title: 'Imported Composer task', prompt }] }] });
  assert.equal((await w.taskNow(imported)).column, 'inbox');
  await w.board.completeTask(copy.id, { kind: 'fixture', details: {} }); assert.equal((await w.taskNow(copy.id)).column, 'archive');
  await w.board.reopenTask(copy.id, { expectedRevision: (await w.taskNow(copy.id)).revision }); assert.equal((await w.taskNow(copy.id)).column, 'inbox');
  assert.equal(projectColumns(await w.projectNow()).at(-1).role, 'done');
  assert.ok(projectTransitions(await w.projectNow()).archive.includes('testing'));
  const invalid = structuredClone(config); invalid.columns[2].automations.onEnter.push({ id: 'send', name: 'Review', type: 'send_message', enabled: true, message: 'review' });
  await assert.rejects(w.configure(invalid), { code: 'PIPELINE_FEATURE_PENDING' });
  invalid.columns[2].automations.onEnter = []; invalid.columns[2].strategy.sessionTarget = 'isolated';
  await assert.rejects(w.configure(invalid), { code: 'PIPELINE_FEATURE_PENDING' });
  const remove = structuredClone(config); remove.columns = remove.columns.filter(column => column.id !== 'merge');
  await assert.rejects(w.configure(remove), { code: 'COLUMN_NOT_EMPTY' });
  assert.equal((await w.projectNow()).pipeline.columns.length, 7);
  const changedRole = structuredClone(config); changedRole.columns[0].id = 'another-inbox';
  await assert.rejects(w.configure(changedRole), { code: 'PIPELINE_SYSTEM_ROLE_CHANGED' });
});

test('a title-only pipeline task starts with its escaped title envelope and inherited CLI tools, without filling its stored description', async t => {
  const w = await world(t); await w.configure(defaultPipelineConfig());
  const task = await w.board.createTask({ projectId: w.projectId, title: 'Fix <widget> & 😀' }); assert.equal(w.starts.length, 0);
  await w.move(task.id, 'executing'); assert.equal(w.starts.length, 1);
  const payload = w.starts[0]; assert.equal(payload.task.prompt, ''); assert.equal(payload.firstPrompt, '<task>\n  <title>Fix &lt;widget&gt; &amp; 😀</title>\n</task>');
  const built = await buildSession({ provider: 'claude', stage: 'executing', config: payload.run.config, message: payload.firstPrompt,
    runDir: await temp(t), eventsFile: join(await temp(t), 'events.jsonl'), sessionId: 'title-only-fixture', workspacePath: payload.workspace.path });
  assert.ok(built.args.includes(payload.firstPrompt)); assert.ok(!built.args.includes('--strict-mcp-config')); assert.equal((await w.taskNow(task.id)).prompt, '');
});

test('compatible live moves retain one run without completing, committing, testing, merging, or replaying a prompt', async t => {
  const w = await world(t); await w.configure(defaultPipelineConfig());
  w.board.delivery.commit = w.board.delivery.prepareMergeRun = w.board.delivery.testingContext = () => assert.fail('A column name must not perform a delivery action.');
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Feature', prompt: 'Exact Composer task' });
  const first = await w.move(card.id, 'executing'); const sessionId = first.run.sessionId;
  await w.board.updateRun(first.run.id, { status: 'running', providerSessionId: 'native-fixture' });
  for (const column of ['code_review', 'testing', 'merge', 'executing']) {
    const result = await w.move(card.id, column); assert.equal(result.continuedRunId, first.run.id);
    assert.equal((await w.taskNow(card.id)).sessionId, sessionId);
  }
  const reordered = await w.move(card.id, 'executing', { index: 0 }); assert.equal(reordered.run, undefined); assert.equal(w.starts.length, 1);
  const duplicateId = 'move-fixture-id'; await w.move(card.id, 'testing', { transitionId: duplicateId });
  assert.equal((await w.board.transition(card.id, { column: 'testing', expectedRevision: -1, transitionId: duplicateId })).duplicate, true);
  assert.equal((await w.move(card.id, 'planning')).continuedRunId, first.run.id); // Permissions are launch metadata; live CLI choices are retained.
  await w.move(card.id, 'testing');
  await w.move(card.id, 'done'); assert.equal((await w.board.run(first.run.id)).status, 'suspended');
  assert.ok((await w.taskNow(card.id)).archivedAt); assert.equal((await w.taskNow(card.id)).sessionId, sessionId);
  const restored = await w.move(card.id, 'code_review'); assert.equal(restored.run.sessionId, sessionId);
  assert.equal(restored.run.resumeFrom.nativeSessionId, 'native-fixture'); assert.equal((await w.taskNow(card.id)).archivedAt, undefined);
  await w.move(card.id, 'todo'); assert.equal((await w.board.run(restored.run.id)).status, 'cancelled'); assert.equal((await w.taskNow(card.id)).sessionId, null);
  assert.ok((await w.taskNow(card.id)).workspace.path); // Reset cleanup remains a later checkpoint.
  const fresh = await w.move(card.id, 'executing'); assert.notEqual(fresh.run.sessionId, sessionId); assert.equal(fresh.run.resumeFrom, undefined);
});

test('pipeline backups preserve structure and Base scopes but restore with dispatch disabled and no machine sessions', async t => {
  const w = await world(t), config = defaultPipelineConfig(); config.columns[2].name = 'Build'; await w.configure(config);
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Saved split task', prompt: '  CRLF\r\nexact  ' });
  await w.move(card.id, 'testing', { decision: 'move' });
  const backup = await w.board.exportBackup(); assert.equal(backup.version, 11);
  const other = new Board({ dataDir: await temp(t), executor: { start() { assert.fail('Import must not execute.'); } } });
  await other.importBackup(backup);
  const saved = (await other.state()).projects[0]; assert.equal(saved.workflowMode, 'pipeline'); assert.equal(saved.pipeline.columns[2].name, 'Build');
  assert.equal(saved.tasks[0].prompt, card.prompt); assert.equal(saved.tasks[0].column, 'testing');
  assert.ok(saved.pipeline.columns.every(column => column.strategy.autoSpawn === false)); assert.ok(saved.pipelineImport);
  assert.deepEqual((await other.state()).runs, []); assert.deepEqual((await other.state()).sessions, []);
  assert.deepEqual((await other.exportBackup()).projects[0].pipeline, config);
});

test('pipeline CLI modes depend on configured permissions rather than column names and retain ambient tools', async t => {
  const runDir = await temp(t);
  for (const provider of ['claude', 'codex', 'gemini']) for (const [stage, permissionMode] of [['code_review', ''], ['custom_build', 'plan']]) {
    const config = resolveConfig(stage, { provider, permissionMode, pipeline: true });
    assert.equal(config.permissionMode === 'plan', permissionMode === 'plan');
    const built = await buildSession({ provider, stage, config, message: 'Literal first message', runDir, eventsFile: join(runDir, 'events.jsonl'), sessionId: 'native-fixture' });
    assert.ok(!built.args.includes('--strict-mcp-config')); assert.ok(!built.args.includes('--extensions')); assert.ok(!built.args.includes('--allowed-mcp-server-names'));
    if (provider === 'claude') { assert.ok(!built.args.includes('--tools')); assert.ok(!built.args.includes('--disallowedTools')); }
    if (provider === 'codex') assert.equal(built.args[built.args.indexOf('--sandbox') + 1], permissionMode === 'plan' ? 'read-only' : 'workspace-write');
    if (provider === 'gemini') assert.ok(!built.args.includes('--policy'));
  }
});

test('pipeline Planning and Review deliver selected Base MCPs, retain stable assignments, and block incompatible live changes', async t => {
  const w = await world(t); await w.configure(defaultPipelineConfig());
  const mcp = await w.board.base.create({ kind: 'mcp', name: 'Selected native tool', enabled: true, trust: 'trusted', configuration: { transport: 'stdio', command: process.execPath, args: ['--version'] } });
  await w.board.base.apply({ changes: [{ target: { scope: 'project', projectId: w.projectId }, binding: { mode: 'extend', include: [{ resourceId: mcp.id, required: true }], exclude: [] } }], expectedBaseRevision: (await w.board.state()).base.revision });
  for (const columnId of ['planning', 'code_review']) {
    const preview = await w.board.previewBase({ target: { scope: 'column', projectId: w.projectId, columnId } });
    assert.deepEqual(preview.manifest.errors, []); assert.ok(preview.manifest.resources.some(resource => resource.resourceId === mcp.id && resource.delivery === 'native-mcp'));
  }
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Configured Base', prompt: 'Base is separate from this task.' });
  const first = await w.move(card.id, 'executing'); assert.ok(first.run.baseManifest.resources.some(resource => resource.resourceId === mcp.id));
  await w.board.updateRun(first.run.id, { status: 'running' });
  const skill = await w.board.base.create({ kind: 'skill', name: 'Review instructions', content: { body: 'Only user-configured review guidance.' } });
  await w.board.base.apply({ changes: [{ target: { scope: 'column', projectId: w.projectId, columnId: 'code_review' }, binding: { mode: 'extend', include: [{ resourceId: skill.id, required: true }], exclude: [] } }], expectedBaseRevision: (await w.board.state()).base.revision });
  await assert.rejects(w.move(card.id, 'code_review'), { code: 'PIPELINE_RECONFIGURE_REQUIRED' });
  assert.equal(w.starts.length, 1); assert.equal((await w.taskNow(card.id)).column, 'executing');
  await w.board.pauseRun(first.run.id, { confirm: true });
  const layout = structuredClone((await w.projectNow()).pipeline); layout.columns[3].name = 'Inspect';
  [layout.columns[3], layout.columns[4]] = [layout.columns[4], layout.columns[3]];
  await w.configure(layout);
  assert.equal((await w.projectNow()).baseColumns.code_review.binding.include[0].resourceId, skill.id);
  await w.board.store.update(state => { state.projects[0].pendingImport = { baseColumns: { merge: { binding: { mode: 'extend', include: [{ resourceId: skill.id, required: true }], exclude: [] } } } }; });
  const withoutMerge = structuredClone(layout); withoutMerge.columns = withoutMerge.columns.filter(column => column.id !== 'merge');
  await w.configure(withoutMerge); assert.equal((await w.projectNow()).pendingImport.baseColumns.merge, undefined);
  assert.ok(!(await w.board.baseView()).targets.some(entry => entry.target.columnId === 'merge'));
});

test('pipeline input rejects terminal escape sequences before argv or bracketed-paste delivery', async t => {
  const runDir = await temp(t), config = resolveConfig('executing', { pipeline: true });
  await assert.rejects(buildSession({ provider: 'claude', stage: 'executing', config, message: 'x'.repeat(100001) + '\x1b[201~injected\r', runDir }), { code: 'INVALID_PIPELINE_INPUT' });
});

test('an edit during asynchronous run validation cannot launch an obsolete Composer prompt', async t => {
  const w = await world(t); await w.configure(defaultPipelineConfig());
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Race', prompt: 'Original task' });
  const validate = w.board.executor.validate; let release, entered;
  const waiting = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  w.board.executor.validate = async request => { entered(); await waiting; return validate(request); };
  const move = w.move(card.id, 'executing'); await started;
  await w.board.updateTask(card.id, { prompt: '  New engineered task\r\n', expectedRevision: 1 }); release();
  await assert.rejects(move, { code: 'REVISION_CONFLICT' });
  assert.equal(w.starts.length, 0); assert.deepEqual((await w.board.state()).runs, []);
  assert.equal((await w.taskNow(card.id)).prompt, '  New engineered task\r\n'); assert.equal((await w.taskNow(card.id)).column, 'todo');
});

test('real PTY simulated providers use a silent first envelope, keep the live process across columns and resume Done without replay', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, true);
  for (const provider of ['claude', 'codex', 'gemini']) {
    const config = defaultPipelineConfig(); for (const column of config.columns.filter(item => item.role === 'active')) column.strategy.agentOverride = provider;
    await w.configure(config);
    const card = await w.board.createTask({ projectId: w.projectId, title: `${provider} task`, prompt: '  Exact task {{title}}\r\ncode  \r\n' });
    const first = await w.move(card.id, 'executing'); await until(async () => (await w.board.run(first.run.id)).turnComplete);
    assert.equal(await readFile(join(w.dataDir, first.run.artifactsDir, 'prompt.md'), 'utf8'), pipelineTaskEnvelope(card));
    const pid = w.board.executor.sessions.get(first.run.id).proc.pid;
    for (const destination of ['code_review', 'testing', 'merge']) {
      await w.move(card.id, destination); assert.equal(w.board.executor.sessions.get(first.run.id).proc.pid, pid);
    }
    await w.move(card.id, 'done'); assert.equal(w.board.executor.sessions.get(first.run.id).proc, null);
    assert.match((await w.board.run(first.run.id)).reason, /^The card moved to Done\./, 'A Done move is not reported as a pause by the user.');
    const restored = await w.move(card.id, 'testing'); await until(async () => (await w.board.run(restored.run.id)).status === 'running');
    assert.equal(restored.run.sessionId, first.run.sessionId); assert.equal(await readFile(join(w.dataDir, restored.run.artifactsDir, 'prompt.md'), 'utf8'), '');
    await w.move(card.id, 'todo');
  }
  assert.equal(await readFile(join(w.root, 'README.md'), 'utf8'), 'main checkout\n');
});

test('real PTY activity hooks track outstanding work and native approval without advancing or failing the parent task', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, true);
  const updateRun = w.board.updateRun.bind(w.board); let failedActivityWrite = false;
  w.board.updateRun = async (id, fields) => {
    if (fields.activity?.ready && !failedActivityWrite) { failedActivityWrite = true; throw new Error('Simulated activity persistence failure'); }
    return updateRun(id, fields);
  };
  for (const provider of ['claude', 'gemini']) {
    const config = defaultPipelineConfig(); for (const column of config.columns.filter(item => item.role === 'active')) column.strategy.agentOverride = provider;
    await w.configure(config);
    const card = await w.board.createTask({ projectId: w.projectId, title: 'Activity', prompt: 'ACTIVITY_FIXTURE' });
    const { run } = await w.move(card.id, 'executing');
    await until(async () => (await w.board.run(run.id)).activity?.ready);
    assert.equal(failedActivityWrite, true); // An unchanged snapshot is retried after a failed store write.
    const input = text => w.board.executor.input(run.id, `${text}\r`);
    await input('activity-start');
    const busy = await until(async () => { const r = await w.board.run(run.id); return r.activity?.background === 1 && r; });
    assert.equal(busy.activity.ready, false); assert.equal(busy.activity.phase, 'working');
    assert.equal(busy.activity.parentTurnComplete, true); assert.equal(busy.activity.tools, 2);
    if (provider === 'claude') assert.equal(busy.activity.subagents, 1);
    assert.doesNotMatch(await readFile(join(w.dataDir, run.artifactsDir, 'last-message.md'), 'utf8'), /Child response/);
    await input('activity-child-failure'); await new Promise(resolve => setTimeout(resolve, 400));
    assert.notEqual((await w.board.run(run.id)).status, 'failed');
    await input('activity-finish'); await until(async () => (await w.board.run(run.id)).activity?.ready);
    await input('activity-plan-request');
    await until(async () => (await w.board.run(run.id)).activity?.permissionPending);
    assert.equal((await w.board.run(run.id)).activity.planApproval, undefined);
    const eventsFile = join(w.dataDir, run.artifactsDir, 'events.jsonl');
    const observedInput = async text => {
      const before = Buffer.byteLength(await readFile(eventsFile, 'utf8'));
      await input(text);
      await until(async () => {
        const bytes = Buffer.byteLength(await readFile(eventsFile, 'utf8'));
        const output = await readFile(join(w.dataDir, run.artifactsDir, 'output.log'), 'utf8');
        const session = w.board.executor.sessions.get(run.id);
        return output.includes(`${text} emitted`) && bytes > before && session.eventsOffset === bytes && !session.reading;
      });
    };
    await observedInput('activity-unrelated-results');
    assert.equal((await w.board.run(run.id)).activity.permissionPending, true);
    assert.equal((await w.board.run(run.id)).activity.phase, 'waiting');
    // Documented permission events have no tool ID. Even the rejected plan's
    // result cannot resolve that uncorrelated notification before a turn boundary.
    await observedInput('activity-plan-reject');
    assert.equal((await w.board.run(run.id)).activity.permissionPending, true);
    await input('activity-finish');
    await until(async () => !(await w.board.run(run.id)).activity?.permissionPending);
    assert.equal((await w.board.run(run.id)).activity.planApproval, undefined);
    await input('activity-plan-approve');
    const approved = await until(async () => (await w.board.run(run.id)).activity?.planApproval);
    assert.equal(approved.provider, provider);
    assert.equal((await w.taskNow(card.id)).column, 'executing'); // Evidence foundation does not auto-move yet.
    assert.doesNotMatch(await readFile(join(w.dataDir, run.artifactsDir, 'events.jsonl'), 'utf8'), /PRIVATE/);
    if (provider === 'claude') {
      await observedInput('activity-child-permission');
      assert.equal((await w.board.run(run.id)).activity.parentTurnComplete, true);
      assert.equal((await w.board.run(run.id)).activity.permissionPending, true);
      await observedInput('activity-unrelated-results');
      assert.equal((await w.board.run(run.id)).activity.permissionPending, true);
      await input('activity-finish'); await until(async () => (await w.board.run(run.id)).activity?.ready);
    }
    await w.move(card.id, 'todo'); assert.equal((await w.board.run(run.id)).activity.phase, 'ended');
  }
});

test('queued pipeline retargeting uses the latest provider/model/Base and keeps FIFO while acceptance holds its slot', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, true), config = defaultPipelineConfig();
  config.columns.find(column => column.id === 'testing').strategy.agentOverride = 'gemini';
  Object.assign(config.columns.find(column => column.id === 'code_review').strategy, { agentOverride: 'codex', modelOverride: 'fixture-final' });
  await w.configure(config);
  const skill = await w.board.base.create({ kind: 'skill', name: 'Latest destination', content: { body: 'CURRENT DESTINATION BASE' } });
  await w.board.base.apply({ changes: [{ target: { scope: 'column', projectId: w.projectId, columnId: 'code_review' }, binding: { mode: 'extend', include: [{ resourceId: skill.id, required: true }], exclude: [] } }], expectedBaseRevision: (await w.board.state()).base.revision });
  const cards = [], runs = [];
  for (const title of ['Blocker', 'Retarget', 'After one', 'After two']) {
    const card = await w.board.createTask({ projectId: w.projectId, title, prompt: `  Exact ${title}\r\n` });
    cards.push(card); runs.push((await w.move(card.id, 'executing')).run);
    if (cards.length === 1) await until(async () => (await w.board.run(runs[0].id)).turnComplete);
  }
  const order = runs.slice(1).map(run => run.id), sessionId = runs[1].sessionId;
  for (const destination of ['testing', 'merge']) {
    const result = await w.move(cards[1].id, destination);
    assert.equal(result.retargetedRunId, runs[1].id);
    assert.deepEqual(w.board.executor.queue.map(entry => entry.runId), order);
  }
  const validate = w.board.executor.validate.bind(w.board.executor); let release, entered;
  const barrier = new Promise(resolve => { release = resolve; }), accepting = new Promise(resolve => { entered = resolve; });
  w.board.executor.validate = async request => { if (request.stage === 'code_review') { entered(); await barrier; } return validate(request); };
  const move = w.move(cards[1].id, 'code_review'); await accepting;
  await w.move(cards[0].id, 'todo'); await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(w.board.executor.queue.map(entry => entry.runId), order);
  assert.equal(w.board.executor.activeCount(), 0); assert.equal((await w.taskNow(cards[1].id)).column, 'merge');
  release(); const result = await move;
  assert.equal(result.run.sessionId, sessionId); assert.equal(result.run.config.provider, 'codex'); assert.equal(result.run.config.model, 'fixture-final');
  await until(async () => (await w.board.run(runs[1].id)).turnComplete);
  assert.equal(w.board.executor.sessions.get(runs[1].id).provider, 'codex');
  const prompt = await readFile(join(w.dataDir, runs[1].artifactsDir, 'prompt.md'), 'utf8');
  assert.ok(prompt.startsWith(pipelineTaskEnvelope(cards[1]))); assert.match(prompt, /CURRENT DESTINATION BASE/);
  assert.equal((await w.board.state()).sessions.find(session => session.id === sessionId).provider, 'codex');
  assert.deepEqual(w.board.executor.queue.map(entry => entry.runId), order.slice(1));
  await w.move(cards[1].id, 'todo'); await until(async () => (await w.board.run(runs[2].id)).turnComplete);
  assert.deepEqual(w.board.executor.queue.map(entry => entry.runId), [runs[3].id]);
  await w.move(cards[2].id, 'todo'); await until(async () => (await w.board.run(runs[3].id)).turnComplete);
  await w.move(cards[3].id, 'todo'); assert.equal(await readFile(join(w.root, 'README.md'), 'utf8'), 'main checkout\n');
});

test('column scripts hold an actual queued agent through retargeting and run before native startup without losing FIFO', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, true), pipeline = defaultPipelineConfig(), worker = join(w.dataDir, 'enter-gate.mjs');
  const ready = join(w.dataDir, 'enter-ready'), release = join(w.dataDir, 'enter-release');
  await writeFile(worker, `import {writeFileSync,existsSync} from 'node:fs'; writeFileSync(${JSON.stringify(ready)},process.cwd()); setInterval(()=>{if(existsSync(${JSON.stringify(release)}))process.exit(0)},20);`);
  const shellQuote = text => `'${text.replaceAll("'", "'\\''")}'`;
  const review = pipeline.columns.find(column => column.id === 'code_review'); review.strategy.agentOverride = 'gemini';
  review.automations.onEnter = [{ id: 'enter-gate', name: 'Before agent', type: 'run_script', enabled: true, script: `${shellQuote(process.execPath)} ${shellQuote(worker)}` }];
  await w.configure(pipeline); t.after(() => w.board.shutdownAutomations());
  const cards = [], runs = [];
  for (const title of ['Blocker', 'Retarget with actions', 'Later']) {
    const card = await w.board.createTask({ projectId: w.projectId, title, prompt: title }); cards.push(card); runs.push((await w.move(card.id, 'executing')).run);
    if (runs.length === 1) await until(async () => (await w.board.run(runs[0].id)).turnComplete);
  }
  const moving = w.move(cards[1].id, 'code_review'); await until(() => readFile(ready, 'utf8').catch(() => null));
  assert.equal(await readFile(ready, 'utf8'), runs[1].workspacePath); assert.equal((await w.board.run(runs[1].id)).config.provider, 'gemini');
  await w.move(cards[0].id, 'todo'); await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(w.board.executor.activeCount(), 0); assert.deepEqual(w.board.executor.queue.map(item => item.runId), runs.slice(1).map(run => run.id));
  assert.equal(w.board.executor.sessions.has(runs[1].id), false); await writeFile(release, 'release'); const result = await moving;
  assert.equal(result.retargetedRunId, runs[1].id); assert.equal(result.automationMove.status, 'completed');
  await until(async () => (await w.board.run(runs[1].id)).turnComplete);
  assert.equal(w.board.executor.sessions.get(runs[1].id).provider, 'gemini'); assert.deepEqual(w.board.executor.queue.map(item => item.runId), [runs[2].id]);
  await w.move(cards[1].id, 'todo'); await until(async () => (await w.board.run(runs[2].id)).turnComplete); await w.move(cards[2].id, 'todo');
  assert.equal(w.board.executor.queuedHolds.size, 0); assert.equal(w.board.automationMoves.size, 0);
});

test('opaque automation holds retain a queued FIFO slot through retargeting and cancellation', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, true); await w.configure(defaultPipelineConfig());
  const cards = [], runs = [];
  for (const title of ['Blocker', 'Held', 'Later']) {
    const card = await w.board.createTask({ projectId: w.projectId, title, prompt: title }); cards.push(card);
    runs.push((await w.move(card.id, 'executing')).run);
    if (runs.length === 1) await until(async () => (await w.board.run(runs[0].id)).turnComplete);
  }
  const supervisor = w.board.executor, held = supervisor.holdQueued(runs[1].id);
  assert.equal(supervisor.releaseQueued(runs[1].id, {}), false);
  await assert.rejects(supervisor.retargetQueued(runs[1].id, async () => assert.fail('Forged hold accepted.'), { hold: {} }), { code: 'RUN_BUSY' });
  await supervisor.retargetQueued(runs[1].id, async () => ({ run: runs[1], payload: { ...supervisor.queue[0] } }), { hold: held });
  await w.move(cards[0].id, 'todo');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(supervisor.activeCount(), 0); assert.deepEqual(supervisor.queue.map(item => item.runId), runs.slice(1).map(run => run.id));
  assert.equal(supervisor.releaseQueued(runs[1].id, held), true);
  assert.equal(supervisor.releaseQueued(runs[1].id, held), false);
  await until(async () => (await w.board.run(runs[1].id)).turnComplete);
  const cancelledHold = supervisor.holdQueued(runs[2].id); await supervisor.cancel(runs[2].id);
  assert.equal(supervisor.releaseQueued(runs[2].id, cancelledHold), true);
  await w.move(cards[1].id, 'todo'); await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(supervisor.queue.length, 0); assert.equal(supervisor.sessions.has(runs[2].id), false); assert.equal(supervisor.queuedHolds.size, 0);
});

test('a cancelled held queue entry is never resurrected by retargeting', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, true), config = defaultPipelineConfig();
  config.columns.find(column => column.id === 'testing').strategy.agentOverride = 'gemini'; await w.configure(config);
  const first = await w.board.createTask({ projectId: w.projectId, title: 'Blocker', prompt: 'Stay live' });
  const blocker = (await w.move(first.id, 'executing')).run; await until(async () => (await w.board.run(blocker.id)).turnComplete);
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Cancelled', prompt: 'Never launch' });
  const queued = (await w.move(card.id, 'executing')).run;
  const validate = w.board.executor.validate.bind(w.board.executor); let release, entered;
  const barrier = new Promise(resolve => { release = resolve; }), accepting = new Promise(resolve => { entered = resolve; });
  w.board.executor.validate = async request => { entered(); await barrier; return validate(request); };
  const move = w.move(card.id, 'testing'); const rejection = assert.rejects(move, { code: 'REVISION_CONFLICT' });
  await accepting; await w.board.executor.cancel(queued.id); release(); await rejection;
  assert.equal((await w.taskNow(card.id)).column, 'executing'); assert.equal((await w.board.run(queued.id)).status, 'cancelled');
  assert.equal(w.board.executor.queue.some(entry => entry.runId === queued.id), false);
  await w.move(first.id, 'todo'); await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(w.board.executor.sessions.has(queued.id), false);
});

test('a run already preparing rejects retargeting without changing its card or accepted configuration', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, true), config = defaultPipelineConfig();
  config.columns.find(column => column.id === 'testing').strategy.agentOverride = 'gemini'; await w.configure(config);
  const prepare = w.board.executor.basePreparer; let release, entered;
  const barrier = new Promise(resolve => { release = resolve; }), preparing = new Promise(resolve => { entered = resolve; });
  w.board.executor.basePreparer = async request => { entered(); await barrier; return prepare(request); };
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Preparing', prompt: 'Original authorized input' });
  const run = (await w.move(card.id, 'executing')).run; await preparing;
  await assert.rejects(w.move(card.id, 'testing'), { code: 'RUN_STARTING' });
  assert.equal((await w.taskNow(card.id)).column, 'executing'); assert.equal((await w.board.run(run.id)).config.provider, 'claude');
  release(); await until(async () => (await w.board.run(run.id)).turnComplete); await w.move(card.id, 'todo');
});

test('queued native resumes retain the exact conversation and apply new flags/Base without task replay; provider handoff stays guarded', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, true), config = defaultPipelineConfig();
  Object.assign(config.columns.find(column => column.id === 'code_review').strategy, { modelOverride: 'resume-fixture', permissionMode: 'default' });
  config.columns.find(column => column.id === 'merge').strategy.agentOverride = 'gemini'; await w.configure(config);
  const skill = await w.board.base.create({ kind: 'skill', name: 'Resume destination', content: { body: 'RESUME DESTINATION INSTRUCTIONS' } });
  await w.board.base.apply({ changes: [{ target: { scope: 'column', projectId: w.projectId, columnId: 'code_review' }, binding: { mode: 'extend', include: [{ resourceId: skill.id, required: true }], exclude: [] } }], expectedBaseRevision: (await w.board.state()).base.revision });
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Native context', prompt: 'ORIGINAL UNIQUE TASK INPUT' });
  const original = (await w.move(card.id, 'executing')).run; await until(async () => (await w.board.run(original.id)).turnComplete);
  const nativeId = (await w.board.run(original.id)).providerSessionId; await w.move(card.id, 'done');
  const other = await w.board.createTask({ projectId: w.projectId, title: 'Blocker', prompt: 'Hold this slot' });
  const blocker = (await w.move(other.id, 'executing')).run; await until(async () => (await w.board.run(blocker.id)).turnComplete);
  const resume = (await w.move(card.id, 'testing')).run;
  const changed = (await w.move(card.id, 'code_review')).run;
  assert.equal(changed.id, resume.id); assert.equal(changed.sessionId, original.sessionId);
  assert.equal(changed.resumeFrom.nativeSessionId, nativeId); assert.equal(changed.baseChanged, true);
  assert.equal(changed.config.model, 'resume-fixture'); assert.equal(changed.config.permissionMode, 'default');
  await assert.rejects(w.move(card.id, 'merge'), { code: 'PIPELINE_RECONFIGURE_REQUIRED' });
  assert.equal((await w.taskNow(card.id)).column, 'code_review');
  await w.move(other.id, 'todo'); await until(async () => (await w.board.run(resume.id)).turnComplete);
  assert.equal((await w.board.run(resume.id)).providerSessionId, nativeId);
  const prompt = await readFile(join(w.dataDir, resume.artifactsDir, 'prompt.md'), 'utf8');
  assert.match(prompt, /RESUME DESTINATION INSTRUCTIONS/); assert.doesNotMatch(prompt, /ORIGINAL UNIQUE TASK INPUT|<task>/);
  await w.move(card.id, 'todo');
});

test('manual pipeline columns park queued and live sessions; explicit Start resumes captured context', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, true), config = defaultPipelineConfig(); config.columns.find(column => column.id === 'testing').strategy.autoSpawn = false; await w.configure(config);
  const first = await w.board.createTask({ projectId: w.projectId, title: 'Live', prompt: 'Keep my conversation' });
  const live = (await w.move(first.id, 'executing')).run; await until(async () => (await w.board.run(live.id)).turnComplete);
  const second = await w.board.createTask({ projectId: w.projectId, title: 'Queued', prompt: 'Keep my prompt' });
  const queued = (await w.move(second.id, 'executing')).run;
  assert.equal((await w.move(second.id, 'testing')).suspendedRunId, queued.id);
  assert.equal((await w.board.run(queued.id)).status, 'suspended'); assert.equal(w.board.executor.queue.length, 0);
  assert.equal((await w.move(first.id, 'testing')).suspendedRunId, live.id);
  assert.equal(w.board.executor.sessions.get(live.id).proc, null); assert.equal((await w.taskNow(first.id)).sessionId, live.sessionId);
  const resumed = await w.board.requestRun(first.id, { stage: 'testing', consent: true });
  await until(async () => (await w.board.run(resumed.id)).status === 'running');
  assert.equal(resumed.sessionId, live.sessionId); assert.equal(await readFile(join(w.dataDir, resumed.artifactsDir, 'prompt.md'), 'utf8'), '');
  await w.move(first.id, 'todo');
  const fresh = await w.board.requestRun(second.id, { stage: 'testing', consent: true });
  await until(async () => (await w.board.run(fresh.id)).turnComplete);
  assert.notEqual(fresh.sessionId, queued.sessionId); await w.move(second.id, 'todo');
});

test('live model/permission/Base changes wait for observed work to settle and resume the exact conversation without task replay', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, true);
  for (const provider of ['claude', 'codex', 'gemini']) {
    const config = defaultPipelineConfig();
    for (const column of config.columns.filter(item => item.role === 'active')) column.strategy.agentOverride = provider;
    Object.assign(config.columns.find(column => column.id === 'code_review').strategy, { modelOverride: 'boundary-fixture', permissionMode: 'plan' });
    await w.configure(config);
    const skill = await w.board.base.create({ kind: 'skill', name: `Boundary ${provider}`, content: { body: `DESTINATION BASE ${provider}` } });
    await w.board.base.apply({ changes: [{ target: { scope: 'column', projectId: w.projectId, columnId: 'code_review' }, binding: { mode: 'extend', include: [{ resourceId: skill.id, required: true }], exclude: [] } }], expectedBaseRevision: (await w.board.state()).base.revision });
    const card = await w.board.createTask({ projectId: w.projectId, title: 'Live change', prompt: 'ACTIVITY_FIXTURE ORIGINAL COMPOSER TASK' });
    const original = (await w.move(card.id, 'executing')).run;
    await until(async () => (await w.board.run(original.id)).activity?.ready);
    const owned = w.board.executor.sessions.get(original.id), pid = owned.proc.pid;
    const nativeId = (await w.board.run(original.id)).providerSessionId;
    await writeFile(join(original.workspacePath, 'preserve-dirty.txt'), 'USER WORK MUST SURVIVE\n');
    if (provider !== 'codex') {
      w.board.executor.input(original.id, 'activity-start\r');
      await until(async () => (await w.board.run(original.id)).activity?.tools === 2);
    } else w.board.executor.input(original.id, 'unsent'); // No turn hook yet: submitted text must invalidate readiness immediately.
    const moving = w.move(card.id, 'code_review');
    await until(() => w.board.executor.boundaryWaits.has(original.id));
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(owned.proc.pid, pid); assert.equal((await w.taskNow(card.id)).column, 'executing');
    w.board.executor.input(original.id, provider === 'codex' ? '\r' : 'activity-finish\r');
    const result = await moving; await until(async () => (await w.board.run(result.run.id)).turnComplete);
    assert.equal(result.resumedRunId, result.run.id); assert.notEqual(result.run.id, original.id);
    assert.equal(result.run.resumeFrom.nativeSessionId, nativeId); assert.equal(result.run.sessionId, original.sessionId);
    assert.equal(owned.proc, null); assert.equal(result.run.config.model, 'boundary-fixture'); assert.equal(result.run.baseChanged, true);
    const resumed = w.board.executor.sessions.get(result.run.id);
    assert.notEqual(resumed.proc.pid, pid); assert.equal((await w.board.run(result.run.id)).providerSessionId, nativeId);
    const prompt = await readFile(join(w.dataDir, result.run.artifactsDir, 'prompt.md'), 'utf8');
    assert.match(prompt, new RegExp(`DESTINATION BASE ${provider}`)); assert.doesNotMatch(prompt, /ORIGINAL COMPOSER TASK|<task>/);
    const logical = (await w.board.state()).sessions.find(session => session.id === original.sessionId);
    assert.deepEqual(logical.config, result.run.config); assert.equal(logical.pauseIntent, null);
    assert.match((await w.board.run(original.id)).reason, /native turn boundary/);
    assert.equal(await readFile(join(result.run.workspacePath, 'preserve-dirty.txt'), 'utf8'), 'USER WORK MUST SURVIVE\n');
    assert.equal((await w.taskNow(card.id)).prompt, card.prompt); await w.move(card.id, 'todo');
  }
  assert.equal(await readFile(join(w.root, 'README.md'), 'utf8'), 'main checkout\n');
});

test('a boundary timeout never kills a permission wait or a partially entered prompt, even if persisted activity says ready', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, true), config = defaultPipelineConfig(); config.columns[3].strategy.modelOverride = 'boundary-fixture'; await w.configure(config);
  const suspend = w.board.executor.suspendAtBoundary.bind(w.board.executor);
  w.board.executor.suspendAtBoundary = (id, options) => suspend(id, { ...options, timeoutMs: 350 });
  for (const input of ['activity-plan-request\r', 'partially typed prompt']) {
    const card = await w.board.createTask({ projectId: w.projectId, title: 'Wait', prompt: 'ACTIVITY_FIXTURE' });
    const original = (await w.move(card.id, 'executing')).run; await until(async () => (await w.board.run(original.id)).activity?.ready);
    const owned = w.board.executor.sessions.get(original.id), pid = owned.proc.pid;
    w.board.executor.input(original.id, input);
    if (input.endsWith('\r')) await until(async () => (await w.board.run(original.id)).activity?.permissionPending);
    await w.board.updateRun(original.id, { activity: { ready: true } }); // A saved snapshot is never the authorization to kill.
    await assert.rejects(w.move(card.id, 'code_review'), { code: 'PIPELINE_BOUNDARY_TIMEOUT' });
    assert.equal(owned.proc.pid, pid); assert.equal(owned.suspending, undefined);
    assert.equal((await w.taskNow(card.id)).column, 'executing'); assert.equal((await w.board.state()).runs.filter(run => run.taskId === card.id).length, 1);
    await w.move(card.id, 'todo');
  }
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Slow discovery', prompt: 'ACTIVITY_FIXTURE' });
  const original = (await w.move(card.id, 'executing')).run; await until(async () => (await w.board.run(original.id)).activity?.ready);
  const owned = w.board.executor.sessions.get(original.id), pid = owned.proc.pid, validate = w.board.executor.validate;
  w.board.executor.validate = () => new Promise(() => {});
  await assert.rejects(w.move(card.id, 'code_review'), { code: 'PIPELINE_BOUNDARY_TIMEOUT' });
  assert.equal(owned.proc.pid, pid); assert.equal((await w.taskNow(card.id)).column, 'executing');
  w.board.executor.validate = validate; await w.move(card.id, 'todo');
});

test('new native work during pause-intent persistence revokes the lease and waits again before signalling', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, true), config = defaultPipelineConfig(); config.columns[3].strategy.modelOverride = 'boundary-fixture'; await w.configure(config);
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Lease', prompt: 'ACTIVITY_FIXTURE' });
  const original = (await w.move(card.id, 'executing')).run; await until(async () => (await w.board.run(original.id)).activity?.ready);
  const owned = w.board.executor.sessions.get(original.id), pid = owned.proc.pid;
  const begin = w.board.beginSuspension.bind(w.board), abort = w.board.abortSuspension.bind(w.board); let injected = false, revoked = false;
  w.board.beginSuspension = async (id, options) => {
    const result = await begin(id, options);
    if (id === original.id && options?.intent === 'system' && !injected) {
      injected = true;
      assert.throws(() => w.board.executor.input(id, 'another prompt\r'), { code: 'SESSION_SUSPENDING' });
      // The CLI starts work independently while the disk write is in flight.
      owned.proc.write('activity-start\r'); await until(() => owned.activity.snapshot().tools === 2);
    }
    return result;
  };
  w.board.abortSuspension = async (...args) => { await abort(...args); revoked = true; };
  const moving = w.move(card.id, 'code_review');
  await until(() => revoked && !owned.suspending);
  assert.equal(owned.proc.pid, pid); assert.equal((await w.taskNow(card.id)).column, 'executing');
  assert.equal((await w.board.state()).sessions.find(session => session.id === original.sessionId).pauseIntent, null);
  w.board.executor.input(original.id, 'activity-finish\r'); const result = await moving;
  await until(async () => (await w.board.run(result.run.id)).status === 'running');
  assert.equal(result.run.resumeFrom.nativeSessionId, original.providerSessionId || owned.sessionId); await w.move(card.id, 'todo');
});

test('edits after pause-intent persistence fail the final guard without killing the original agent or moving the card', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, true), config = defaultPipelineConfig(); config.columns[3].strategy.modelOverride = 'boundary-fixture'; await w.configure(config);
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Edit race', prompt: 'ACTIVITY_FIXTURE' });
  const original = (await w.move(card.id, 'executing')).run; await until(async () => (await w.board.run(original.id)).activity?.ready);
  const owned = w.board.executor.sessions.get(original.id), pid = owned.proc.pid, begin = w.board.beginSuspension.bind(w.board);
  w.board.beginSuspension = async (id, options) => {
    const result = await begin(id, options);
    if (options?.intent === 'system') await w.board.updateTask(card.id, { prompt: 'NEW COMPOSER REQUIREMENT', expectedRevision: (await w.taskNow(card.id)).revision });
    return result;
  };
  await assert.rejects(w.move(card.id, 'code_review'), { code: 'REVISION_CONFLICT' });
  assert.equal(owned.proc.pid, pid); assert.equal(owned.suspending, false);
  assert.equal((await w.taskNow(card.id)).column, 'executing'); assert.equal((await w.taskNow(card.id)).prompt, 'NEW COMPOSER REQUIREMENT');
  assert.equal((await w.board.state()).sessions.find(session => session.id === original.sessionId).pauseIntent, null);
  await assert.rejects(w.move(card.id, 'code_review'), { code: 'SESSION_PROMPT_STALE' }); await w.move(card.id, 'todo');
});

test('an explicit Pause during asynchronous destination validation cancels the handoff and preserves user pause intent', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, true), config = defaultPipelineConfig(); config.columns[3].strategy.modelOverride = 'boundary-fixture'; await w.configure(config);
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Pause wins', prompt: 'ACTIVITY_FIXTURE' });
  const original = (await w.move(card.id, 'executing')).run; await until(async () => (await w.board.run(original.id)).activity?.ready);
  const validate = w.board.executor.validate.bind(w.board.executor); let release;
  w.board.executor.validate = async request => { await new Promise(resolve => { release = resolve; }); return validate(request); };
  const moving = w.move(card.id, 'code_review'); const rejected = assert.rejects(moving, { code: 'PIPELINE_RECONFIGURE_CANCELLED' });
  await until(() => release);
  const paused = w.board.pauseRun(original.id, { confirm: true });
  await rejected; await paused;
  release(); // Read-only discovery may finish later; Pause must not wait for it.
  assert.equal((await w.taskNow(card.id)).column, 'executing'); assert.equal((await w.board.run(original.id)).status, 'suspended');
  const state = await w.board.state(); assert.equal(state.sessions.find(session => session.id === original.sessionId).pauseIntent, 'user');
  assert.equal(state.runs.filter(run => run.taskId === card.id).length, 1); assert.equal(w.board.executor.sessions.get(original.id).proc, null);
});

test('Stop cancels a busy boundary wait promptly without creating a replacement conversation', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, true), config = defaultPipelineConfig(); config.columns[3].strategy.modelOverride = 'boundary-fixture'; await w.configure(config);
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Stop wins', prompt: 'ACTIVITY_FIXTURE' });
  const original = (await w.move(card.id, 'executing')).run; await until(async () => (await w.board.run(original.id)).activity?.ready);
  w.board.executor.input(original.id, 'activity-start\r'); await until(async () => (await w.board.run(original.id)).activity?.tools === 2);
  const moving = w.move(card.id, 'code_review'); const rejected = assert.rejects(moving, { code: 'PIPELINE_RECONFIGURE_CANCELLED' });
  await until(() => w.board.executor.boundaryWaits.has(original.id));
  await w.board.executor.cancel(original.id); await rejected;
  assert.equal((await w.taskNow(card.id)).column, 'executing'); assert.equal((await w.board.run(original.id)).status, 'cancelled');
  assert.equal((await w.board.state()).runs.filter(run => run.taskId === card.id).length, 1);
  assert.equal(w.board.executor.sessions.get(original.id).proc, null);
});

test('Pause after the system process has exited cancels resume and records a user pause', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, true), config = defaultPipelineConfig(); config.columns[3].strategy.modelOverride = 'boundary-fixture'; await w.configure(config);
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Exit race', prompt: 'ACTIVITY_FIXTURE' });
  const original = (await w.move(card.id, 'executing')).run; await until(async () => (await w.board.run(original.id)).activity?.ready);
  const update = w.board.updateRun.bind(w.board); let exited, release;
  w.board.updateRun = async (id, fields) => {
    const result = await update(id, fields);
    if (id === original.id && fields.status === 'suspended') { exited = true; await new Promise(resolve => { release = resolve; }); }
    return result;
  };
  const moving = w.move(card.id, 'code_review'); const rejected = assert.rejects(moving, { code: 'PIPELINE_RECONFIGURE_CANCELLED' });
  await until(() => exited);
  const paused = w.board.pauseRun(original.id, { confirm: true });
  await until(() => w.board.executor.boundaryWaits.get(original.id)?.signal.aborted); release();
  await rejected; await paused;
  const state = await w.board.state(); assert.equal(state.sessions.find(session => session.id === original.sessionId).pauseIntent, 'user');
  assert.equal(state.runs.filter(run => run.taskId === card.id).length, 1); assert.equal((await w.taskNow(card.id)).column, 'executing');
});

test('partial or malformed native events cannot reuse an old completed turn to authorize a live restart', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, true), config = defaultPipelineConfig(); config.columns[3].strategy.modelOverride = 'boundary-fixture'; await w.configure(config);
  const suspend = w.board.executor.suspendAtBoundary.bind(w.board.executor);
  w.board.executor.suspendAtBoundary = (id, options) => suspend(id, { ...options, timeoutMs: 350 });
  for (const suffix of ['', '\n']) {
    const card = await w.board.createTask({ projectId: w.projectId, title: 'Interrupted hook', prompt: 'ACTIVITY_FIXTURE' });
    const original = (await w.move(card.id, 'executing')).run; await until(async () => (await w.board.run(original.id)).activity?.ready);
    const owned = w.board.executor.sessions.get(original.id), pid = owned.proc.pid;
    await appendFile(owned.eventsFile, '{"provider":"claude","name":"PreToolUse","toolId":"partial' + suffix);
    await assert.rejects(w.move(card.id, 'code_review'), { code: 'PIPELINE_BOUNDARY_TIMEOUT' });
    assert.equal(owned.proc.pid, pid); assert.equal((await w.taskNow(card.id)).column, 'executing');
    assert.equal((await w.board.run(original.id)).activity.uncertain, true);
    if (!suffix) {
      await appendFile(owned.eventsFile, '"}\n'); await until(async () => (await w.board.run(original.id)).activity?.tools === 1);
      await appendFile(owned.eventsFile, JSON.stringify({ provider: 'claude', name: 'PostToolUse', toolId: 'partial' }) + '\n' + JSON.stringify({ provider: 'claude', name: 'Stop', backgroundCount: 0, scheduledCount: 0 }) + '\n');
      await until(async () => (await w.board.run(original.id)).activity?.ready); // A valid completed record releases a partial read.
    } else {
      await appendFile(owned.eventsFile, JSON.stringify({ provider: 'claude', name: 'Stop', backgroundCount: 0, scheduledCount: 0 }) + '\n');
      await new Promise(resolve => setTimeout(resolve, 1700)); assert.equal((await w.board.run(original.id)).activity.ready, false);
    }
    await w.move(card.id, 'todo');
  }
});

test('Pause can cancel replacement validation after the system suspension without waiting for CLI discovery', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, true), config = defaultPipelineConfig(); config.columns[3].strategy.modelOverride = 'boundary-fixture'; await w.configure(config);
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Resume discovery', prompt: 'ACTIVITY_FIXTURE' });
  const original = (await w.move(card.id, 'executing')).run; await until(async () => (await w.board.run(original.id)).activity?.ready);
  const validate = w.board.executor.validate.bind(w.board.executor); let calls = 0, release;
  w.board.executor.validate = async request => { if (++calls === 2) await new Promise(resolve => { release = resolve; }); return validate(request); };
  const moving = w.move(card.id, 'code_review'); const rejected = assert.rejects(moving, { code: 'PIPELINE_RECONFIGURE_CANCELLED' });
  await until(() => release); assert.equal(w.board.executor.sessions.get(original.id).proc, null);
  await w.board.pauseRun(original.id, { confirm: true }); await rejected; release();
  const state = await w.board.state(); assert.equal(state.runs.filter(run => run.taskId === card.id).length, 1);
  assert.equal(state.sessions.find(session => session.id === original.sessionId).pauseIntent, 'user');
  assert.equal((await w.taskNow(card.id)).column, 'executing');
});

test('Pause or Stop during atomic replacement publication prevents queueing and follows only the same logical conversation', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, true), config = defaultPipelineConfig(); config.columns[3].strategy.modelOverride = 'boundary-fixture'; await w.configure(config);
  for (const action of ['pause', 'stop', 'shutdown']) {
    const card = await w.board.createTask({ projectId: w.projectId, title: 'Publication race', prompt: 'ACTIVITY_FIXTURE' });
    const original = (await w.move(card.id, 'executing')).run; await until(async () => (await w.board.run(original.id)).activity?.ready);
    const update = w.board.store.update.bind(w.board.store); let release;
    w.board.store.update = async change => {
      let accepted = false;
      const result = await update(draft => { const before = draft.runs.length; const value = change(draft); accepted = draft.runs.length > before; return value; });
      if (accepted) await new Promise(resolve => { release = resolve; });
      return result;
    };
    const moving = w.move(card.id, 'code_review'); await until(() => release);
    const currentId = (await w.board.state()).sessions.find(session => session.id === original.sessionId).currentRunId;
    assert.notEqual(currentId, original.id); assert.equal(w.board.executor.queue.length, 0);
    const stopping = action === 'pause' ? w.board.pauseRun(original.id, { confirm: true }) : action === 'stop' ? w.board.executor.cancel(original.id) : w.board.executor.shutdown(500);
    await until(() => w.board.executor.boundaryWaits.get(original.id)?.signal.aborted); release();
    const result = await moving; await stopping;
    assert.equal(result.run.id, currentId); assert.equal(result.run.status, action === 'pause' ? 'suspended' : action === 'stop' ? 'cancelled' : 'interrupted');
    assert.equal(result.run.sessionId, original.sessionId); assert.equal((await w.taskNow(card.id)).column, 'code_review'); // Placement was already atomically accepted.
    assert.equal(w.board.executor.sessions.has(currentId), false); assert.equal(w.board.executor.queue.length, 0);
    const logical = (await w.board.state()).sessions.find(session => session.id === original.sessionId);
    assert.equal(logical.pauseIntent, action === 'pause' ? 'user' : null);
    w.board.store.update = update; await w.move(card.id, 'todo');
  }
});

test('a title edit during post-suspension validation cannot accept a stale requested move or launch a replacement', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, true), config = defaultPipelineConfig(); config.columns[3].strategy.modelOverride = 'boundary-fixture'; await w.configure(config);
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Old title', prompt: 'ACTIVITY_FIXTURE' });
  const original = (await w.move(card.id, 'executing')).run; await until(async () => (await w.board.run(original.id)).activity?.ready);
  const validate = w.board.executor.validate.bind(w.board.executor); let calls = 0, release;
  w.board.executor.validate = async request => { if (++calls === 2) await new Promise(resolve => { release = resolve; }); return validate(request); };
  const moving = w.move(card.id, 'code_review'); const rejected = assert.rejects(moving, { code: 'REVISION_CONFLICT' });
  await until(() => release);
  await w.board.updateTask(card.id, { title: 'New title', expectedRevision: (await w.taskNow(card.id)).revision }); release(); await rejected;
  const state = await w.board.state(); assert.equal(state.runs.filter(run => run.taskId === card.id).length, 1);
  assert.equal((await w.taskNow(card.id)).column, 'executing'); assert.equal((await w.taskNow(card.id)).title, 'New title');
  assert.equal(w.board.executor.sessions.get(original.id).proc, null);
  assert.equal(state.sessions.find(session => session.id === original.sessionId).nativeSessionId, (await w.board.run(original.id)).providerSessionId);
});

test('native approved plans move immediately while implementation continues; requests/rejections never route and no prompt is injected', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, true);
  for (const provider of ['claude', 'gemini']) {
    const config = defaultPipelineConfig(); for (const column of config.columns.filter(item => item.role === 'active')) column.strategy.agentOverride = provider;
    config.columns.find(column => column.id === 'planning').strategy.modelOverride = 'native-current-model';
    await w.configure(config);
    const card = await w.board.createTask({ projectId: w.projectId, title: 'Native plan', prompt: 'ACTIVITY_FIXTURE ORIGINAL PLANNING INPUT' });
    const original = (await w.move(card.id, 'planning')).run; await until(async () => (await w.board.run(original.id)).activity?.ready);
    const owned = w.board.executor.sessions.get(original.id), pid = owned.proc.pid;
    w.board.executor.input(original.id, 'activity-plan-request\r'); await until(async () => (await w.board.run(original.id)).activity?.permissionPending);
    assert.equal((await w.taskNow(card.id)).column, 'planning'); assert.equal((await w.board.run(original.id)).planRoutes, undefined);
    w.board.executor.input(original.id, 'activity-plan-reject\r');
    await until(async () => (await readFile(join(w.dataDir, original.artifactsDir, 'output.log'), 'utf8')).includes('activity-plan-reject emitted') && !owned.reading);
    assert.equal((await w.board.run(original.id)).activity.permissionPending, true);
    assert.equal((await w.taskNow(card.id)).column, 'planning'); assert.equal((await w.board.run(original.id)).planRoutes, undefined);
    w.board.executor.input(original.id, 'activity-finish\r'); await until(async () => (await w.board.run(original.id)).activity?.ready);
    assert.equal((await w.taskNow(card.id)).column, 'planning'); assert.equal((await w.board.run(original.id)).planRoutes, undefined);
    w.board.executor.input(original.id, 'activity-plan-approve-working\r');
    await until(async () => (await w.taskNow(card.id)).column === 'executing');
    const routed = await until(async () => { const r = await w.board.run(original.id); return r.planRoutes?.at(-1)?.status === 'completed' && r; });
    assert.equal(owned.proc.pid, pid); assert.equal(routed.activity.parentTurnComplete, false); assert.equal(routed.activity.ready, false);
    assert.equal(routed.config.permissionMode, 'plan'); // Historical spawn settings were not fabricated as the live native permission mode.
    assert.equal(routed.config.model, 'native-current-model'); // Empty destination model preserves the current live choice.
    assert.equal((await w.taskNow(card.id)).sessionId, original.sessionId); assert.equal((await w.board.state()).runs.filter(run => run.taskId === card.id).length, 1);
    // Routing is deliberately immediate. The next tool/file write may still
    // be starting when the move commits; observe it without waiting for Stop.
    const implementation = await until(() => readFile(join(original.workspacePath, 'native-implementation.txt'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; }));
    assert.equal(implementation, 'Native approved implementation is still running.\n');
    assert.equal(owned.proc.pid, pid); assert.equal((await w.board.run(original.id)).activity.parentTurnComplete, false);
    assert.equal(await readFile(join(w.dataDir, original.artifactsDir, 'prompt.md'), 'utf8'), pipelineTaskEnvelope(card));
    const output = await readFile(join(w.dataDir, original.artifactsDir, 'output.log'), 'utf8'); assert.doesNotMatch(output, /you said:.*Proceed with implementing/);
    const proof = routed.activity.planApproval, before = (await w.taskNow(card.id)).transitions.length;
    const repeated = await w.board.routeApprovedPlan(original.id, proof); assert.equal(repeated.id, routed.planRoutes[0].id);
    assert.equal((await w.taskNow(card.id)).transitions.length, before); assert.equal((await w.board.run(original.id)).planRoutes.length, 1);
    await w.move(card.id, 'todo');
  }
});

test('batched main session startup prevents stale approval routing while a fresh native approval still routes', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, true);
  for (const provider of ['claude', 'gemini']) {
    const config = defaultPipelineConfig();
    for (const column of config.columns.filter(item => item.role === 'active')) column.strategy.agentOverride = provider;
    await w.configure(config);
    const card = await w.board.createTask({ projectId: w.projectId, title: 'New native lifecycle', prompt: 'ACTIVITY_FIXTURE' });
    const original = (await w.move(card.id, 'planning')).run;
    await until(async () => (await w.board.run(original.id)).activity?.ready);
    const owned = w.board.executor.sessions.get(original.id), pid = owned.proc.pid;
    const end = provider === 'claude' ? 'PostToolUse' : 'AfterTool', tool = provider === 'claude' ? 'ExitPlanMode' : 'exit_plan_mode';
    const events = [{ name: end, tool, toolId: 'prior-lifecycle', planApproved: true },
      { name: 'SessionStart' }, { name: provider === 'claude' ? 'Stop' : 'AfterAgent', backgroundCount: 0, scheduledCount: 0 }];
    await appendFile(owned.eventsFile, events.map(event => JSON.stringify({ provider, ...event })).join('\n') + '\n');
    await until(() => owned.activity.finishedTools.has(JSON.stringify([null, 'prior-lifecycle'])));
    await until(async () => owned.activity.snapshot().ready && !owned.reading && (await w.board.run(original.id)).activity?.ready);
    assert.equal((await w.taskNow(card.id)).column, 'planning');
    assert.equal((await w.board.run(original.id)).planRoutes, undefined);
    assert.equal((await w.board.run(original.id)).activity.planApproval, undefined);
    assert.equal(owned.proc.pid, pid);
    w.board.executor.input(original.id, 'activity-plan-approve\r');
    await until(async () => (await w.taskNow(card.id)).column === 'executing');
    assert.equal(owned.proc.pid, pid); await w.move(card.id, 'todo');
  }
});

test('live pipeline sessions: a partial human draft and actual teardown revoke native messages without typing automation input', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, true);
  for (const provider of ['claude', 'gemini']) {
    const config = defaultPipelineConfig();
    for (const column of config.columns.filter(item => item.role === 'active')) column.strategy.agentOverride = provider;
    await w.configure(config);
    const card = await w.board.createTask({ projectId: w.projectId, title: 'Receipt custody', prompt: 'ACTIVITY_FIXTURE' });
    const original = (await w.move(card.id, 'executing')).run;
    await until(async () => (await w.board.run(original.id)).activity?.ready);
    const owned = w.board.executor.sessions.get(original.id);
    const request = message => ({ dispatchId: message.split(' ')[0], message, mode: 'deferred', timeoutMs: 300,
      grant: async () => assert.fail('No native input is granted.'), submitted: async () => true, accepted: async () => true });
    assert.notEqual(w.board.executor.nativeMessageReadiness(original.id), 'unavailable');
    w.board.executor.input(original.id, 'human partial draft');
    assert.equal(w.board.executor.nativeMessageReadiness(original.id), 'unavailable');
    assert.equal((await w.board.executor.sendNativeMessage(original.id, request('Late automation message'))).status, 'timed_out');
    await w.move(card.id, 'todo'); assert.equal(owned.proc, null);
    assert.equal(w.board.executor.nativeMessageReadiness(original.id), 'unavailable');
    assert.equal((await w.board.executor.sendNativeMessage(original.id, request('Stopped automation message'))).status, 'unavailable');
    const saved = await w.board.run(original.id); assert.equal(saved.nativeHistoryPath, undefined); assert.equal(saved.transcriptPath, undefined);
    assert.doesNotMatch(await readFile(join(w.dataDir, original.artifactsDir, 'output.log'), 'utf8'), /you said:.*(?:Late|Stopped) automation message/);
  }
});

test('native plan targets follow the task profile, null targets stay put, and successful re-entry enables another approved stage', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, true), config = defaultPipelineConfig();
  config.profiles = [{ id: 'profile-plan', name: 'Custom planning', columns: { planning: { planExitTargetId: 'testing' } } }];
  config.columns.find(column => column.id === 'testing').strategy.planExitTargetId = 'merge'; await w.configure(config);
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Profile target', prompt: 'ACTIVITY_FIXTURE' });
  await w.board.store.update(state => { state.projects[0].tasks.find(task => task.id === card.id).profileId = 'profile-plan'; });
  const original = (await w.move(card.id, 'planning')).run; await until(async () => (await w.board.run(original.id)).activity?.ready);
  const owned = w.board.executor.sessions.get(original.id), pid = owned.proc.pid;
  w.board.executor.input(original.id, 'activity-plan-approve\r'); await until(async () => (await w.taskNow(card.id)).column === 'testing');
  w.board.executor.input(original.id, 'activity-enter-plan\r'); await until(async () => !(await w.board.run(original.id)).activity?.planApproval);
  w.board.executor.input(original.id, 'activity-plan-approve\r'); await until(async () => (await w.taskNow(card.id)).column === 'merge');
  await until(async () => (await w.board.run(original.id)).planRoutes?.length === 2);
  assert.equal(owned.proc.pid, pid); assert.equal((await w.board.run(original.id)).planRoutes[0].toColumn, 'testing');
  assert.equal((await w.board.run(original.id)).planRoutes[1].toColumn, 'merge'); await w.move(card.id, 'todo');
  const stay = await w.board.createTask({ projectId: w.projectId, title: 'Stay', prompt: 'ACTIVITY_FIXTURE' });
  const run = (await w.move(stay.id, 'code_review')).run; await until(async () => (await w.board.run(run.id)).activity?.ready);
  w.board.executor.input(run.id, 'activity-plan-approve\r');
  await until(async () => (await w.board.run(run.id)).planRoutes?.at(-1)?.status === 'ignored');
  assert.equal((await w.taskNow(stay.id)).column, 'code_review'); await w.move(stay.id, 'todo');
});

test('approved-plan model changes defer until work settles and use a resume-only continuation without replaying task text', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, true), config = defaultPipelineConfig(); config.columns.find(column => column.id === 'executing').strategy.modelOverride = 'approved-model'; await w.configure(config);
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Model handoff', prompt: 'ACTIVITY_FIXTURE ORIGINAL PLAN BODY' });
  const original = (await w.move(card.id, 'planning')).run; await until(async () => (await w.board.run(original.id)).activity?.ready);
  const owned = w.board.executor.sessions.get(original.id), pid = owned.proc.pid, nativeId = (await w.board.run(original.id)).providerSessionId;
  w.board.executor.input(original.id, 'activity-plan-approve-working\r');
  await until(() => w.board.executor.boundaryWaits.has(original.id));
  assert.equal(owned.proc.pid, pid); assert.equal((await w.taskNow(card.id)).column, 'planning');
  assert.equal((await w.board.run(original.id)).planRoutes.at(-1).status, 'pending');
  w.board.executor.input(original.id, 'activity-finish\r');
  const completed = await until(async () => { const route = (await w.board.run(original.id)).planRoutes.at(-1); return route.status === 'completed' && route; });
  const resumed = await w.board.run(completed.destinationRunId); await until(async () => (await w.board.run(resumed.id)).turnComplete);
  assert.equal(resumed.sessionId, original.sessionId); assert.equal(resumed.resumeFrom.nativeSessionId, nativeId); assert.equal(resumed.config.model, 'approved-model');
  assert.equal(await readFile(join(w.dataDir, resumed.artifactsDir, 'prompt.md'), 'utf8'), 'Proceed with implementing the approved plan.');
  assert.equal((await w.taskNow(card.id)).column, 'executing'); assert.equal(owned.proc, null); await w.move(card.id, 'todo');
});

test('an approved plan whose turn goes on implementing it waits past the move budget, and another move of the card cancels that wait', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, true), config = defaultPipelineConfig(); config.columns.find(column => column.id === 'executing').strategy.modelOverride = 'approved-model'; await w.configure(config);
  const suspend = w.board.executor.suspendAtBoundary.bind(w.board.executor);
  w.board.executor.suspendAtBoundary = (id, options) => suspend(id, { ...options, timeoutMs: 300 });
  for (const ending of ['finish', 'move']) {
    const card = await w.board.createTask({ projectId: w.projectId, title: `Long turn then ${ending}`, prompt: 'ACTIVITY_FIXTURE' });
    const original = (await w.move(card.id, 'planning')).run; await until(async () => (await w.board.run(original.id)).activity?.ready);
    w.board.executor.input(original.id, 'activity-plan-approve-working\r');
    await until(() => w.board.executor.boundaryWaits.has(original.id));
    await new Promise(resolve => setTimeout(resolve, 900));
    assert.equal((await w.board.run(original.id)).planRoutes.at(-1).status, 'pending', 'The implementation turn may outlast the move budget.');
    if (ending === 'finish') {
      w.board.executor.input(original.id, 'activity-finish\r');
      await until(async () => (await w.board.run(original.id)).planRoutes.at(-1).status === 'completed');
      assert.equal((await w.taskNow(card.id)).column, 'executing');
    } else {
      await w.move(card.id, 'todo'); // Does not queue behind the unfinished turn.
      assert.equal((await w.board.run(original.id)).planRoutes.at(-1).status, 'failed'); assert.equal((await w.taskNow(card.id)).column, 'todo');
      continue;
    }
    await w.move(card.id, 'todo');
  }
});

test('approval observation persistence retries before routing; incompatible providers fail once without replacing the conversation', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, true), config = defaultPipelineConfig(); config.columns.find(column => column.id === 'executing').strategy.agentOverride = 'gemini'; await w.configure(config);
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Persist approval', prompt: 'ACTIVITY_FIXTURE' });
  const original = (await w.move(card.id, 'planning')).run; await until(async () => (await w.board.run(original.id)).activity?.ready);
  const owned = w.board.executor.sessions.get(original.id), pid = owned.proc.pid, update = w.board.updateRun.bind(w.board); let rejected = false, calls = 0;
  const route = w.board.routeApprovedPlan.bind(w.board);
  w.board.routeApprovedPlan = (...args) => { calls++; return route(...args); };
  w.board.updateRun = async (id, change) => {
    if (id === original.id && change.activity?.planApproval && !rejected) { rejected = true; throw new Error('Fixture transient observation write failure'); }
    return update(id, change);
  };
  w.board.executor.input(original.id, 'activity-plan-approve\r');
  const failed = await until(async () => { const r = await w.board.run(original.id); return r.planRoutes?.at(-1)?.status === 'failed' && r; });
  assert.equal(rejected, true); assert.equal(failed.planRoutes[0].errorCode, 'PIPELINE_RECONFIGURE_REQUIRED'); assert.equal(calls, 1);
  assert.equal(owned.proc.pid, pid); assert.equal((await w.taskNow(card.id)).column, 'planning');
  assert.equal((await w.board.routeApprovedPlan(original.id, failed.activity.planApproval)).id, failed.planRoutes[0].id);
  assert.equal((await w.board.state()).runs.filter(run => run.taskId === card.id).length, 1); await w.move(card.id, 'todo');
});

test('Pause cancels automatic routing before boundary registration, while Stop cannot resurrect a stopped run', { skip: process.platform === 'win32' }, async t => {
  for (const action of ['pause', 'stop', 'shutdown']) {
    const w = await world(t, true), config = defaultPipelineConfig(); config.columns.find(column => column.id === 'executing').strategy.modelOverride = 'next-model'; await w.configure(config);
    const card = await w.board.createTask({ projectId: w.projectId, title: action, prompt: 'ACTIVITY_FIXTURE' });
    const original = (await w.move(card.id, 'planning')).run; await until(async () => (await w.board.run(original.id)).activity?.ready);
    const update = w.board.updateRun.bind(w.board); let release;
    const held = new Promise(resolve => { release = resolve; }); let saved = false;
    w.board.updateRun = async (id, change) => {
      const result = await update(id, change);
      if (id === original.id && change.planRoutes?.at(-1)?.status === 'pending') { saved = true; await held; }
      return result;
    };
    t.after(release); w.board.executor.input(original.id, 'activity-plan-approve-working\r'); await until(() => saved);
    assert.equal(w.board.executor.boundaryWaits.has(original.id), false);
    const cancelling = action === 'pause' ? w.board.pauseRun(original.id, { confirm: true }) : action === 'stop' ? w.board.executor.cancel(original.id) : w.board.executor.shutdown(500);
    await until(() => w.board.executor.sessions.get(original.id).planRoutingController.signal.aborted);
    release(); await cancelling;
    await until(async () => (await w.board.run(original.id)).planRoutes.at(-1).status === 'failed');
    assert.equal((await w.taskNow(card.id)).column, 'planning'); assert.equal((await w.board.run(original.id)).status, action === 'pause' ? 'suspended' : action === 'stop' ? 'cancelled' : 'interrupted');
    assert.equal((await w.board.state()).runs.filter(run => run.taskId === card.id).length, 1);
    assert.equal(w.board.executor.sessions.get(original.id).proc, null);
  }
});

test('a new native plan entry or exit request invalidates a pending approved-plan handoff without stopping work', { skip: process.platform === 'win32' }, async t => {
  for (const provider of ['claude', 'gemini']) for (const command of ['activity-enter-plan', 'activity-plan-request']) {
    const w = await world(t, true), config = defaultPipelineConfig();
    for (const column of config.columns.filter(item => item.role === 'active')) column.strategy.agentOverride = provider;
    config.columns.find(column => column.id === 'executing').strategy.modelOverride = 'next-model'; await w.configure(config);
    const card = await w.board.createTask({ projectId: w.projectId, title: 'Superseded plan', prompt: 'ACTIVITY_FIXTURE' });
    const original = (await w.move(card.id, 'planning')).run; await until(async () => (await w.board.run(original.id)).activity?.ready);
    const owned = w.board.executor.sessions.get(original.id), pid = owned.proc.pid;
    w.board.executor.input(original.id, 'activity-plan-approve-working\r'); await until(() => w.board.executor.boundaryWaits.has(original.id));
    w.board.executor.input(original.id, command + '\r');
    const failed = await until(async () => { const r = await w.board.run(original.id); return r.planRoutes.at(-1).status === 'failed' && r; });
    assert.equal(failed.planRoutes[0].errorCode, 'PLAN_APPROVAL_STALE'); assert.equal(owned.proc.pid, pid);
    assert.equal((await w.taskNow(card.id)).column, 'planning'); assert.equal((await w.board.state()).runs.filter(run => run.taskId === card.id).length, 1);
    await w.move(card.id, 'todo');
  }
});

test('an uncertain final plan-route save is never replayed and restart interrupts the durable pending marker even for an ended run', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, true); await w.configure(defaultPipelineConfig());
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Unknown outcome', prompt: 'ACTIVITY_FIXTURE' });
  const original = (await w.move(card.id, 'planning')).run; await until(async () => (await w.board.run(original.id)).activity?.ready);
  const update = w.board.updateRun.bind(w.board);
  w.board.updateRun = (id, change) => id === original.id && change.planRoutes?.at(-1)?.status === 'completed' ? Promise.reject(new Error('Fixture final route write failure')) : update(id, change);
  w.board.executor.input(original.id, 'activity-plan-approve\r');
  await until(async () => (await w.taskNow(card.id)).column === 'executing'); await until(() => !w.board.executor.sessions.get(original.id).planRouting);
  const run = await w.board.run(original.id), transitions = (await w.taskNow(card.id)).transitions.length;
  assert.equal(run.planRoutes[0].status, 'pending');
  assert.equal((await w.board.routeApprovedPlan(original.id, run.activity.planApproval)).id, run.planRoutes[0].id);
  assert.equal((await w.taskNow(card.id)).transitions.length, transitions);
  await w.move(card.id, 'todo'); assert.equal((await w.board.run(original.id)).status, 'cancelled');
  const recovered = new Board({ dataDir: w.dataDir, executor: { start() { assert.fail('Recovery must not replay.'); } } });
  const restored = await recovered.run(original.id); assert.equal(restored.planRoutes[0].status, 'interrupted'); assert.equal(restored.status, 'cancelled');
  assert.match(restored.planRoutes[0].reason, /not replayed/);
});

test('stale task approval is recorded as ignored and Codex turn completion cannot route a plan', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, true); await w.configure(defaultPipelineConfig());
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Edited task', prompt: 'ACTIVITY_FIXTURE' });
  const original = (await w.move(card.id, 'planning')).run; await until(async () => (await w.board.run(original.id)).activity?.ready);
  await w.board.updateTask(card.id, { prompt: 'ACTIVITY_FIXTURE EDITED', expectedRevision: (await w.taskNow(card.id)).revision });
  w.board.executor.input(original.id, 'activity-plan-approve\r');
  await until(async () => (await w.board.run(original.id)).planRoutes?.at(-1)?.status === 'ignored');
  assert.equal((await w.taskNow(card.id)).column, 'planning'); assert.match((await w.board.run(original.id)).planRoutes[0].reason, /task changed/i); await w.move(card.id, 'todo');
  const config = defaultPipelineConfig(); config.columns.find(column => column.id === 'planning').strategy.agentOverride = 'codex'; await w.configure(config);
  const codexCard = await w.board.createTask({ projectId: w.projectId, title: 'Codex native limit', prompt: 'ACTIVITY_FIXTURE' });
  const codex = (await w.move(codexCard.id, 'planning')).run; await until(async () => (await w.board.run(codex.id)).activity?.ready);
  w.board.executor.input(codex.id, 'activity-plan-approve\r'); await until(async () => (await w.board.run(codex.id)).activity?.ready);
  assert.equal((await w.board.run(codex.id)).planRoutes, undefined); assert.equal((await w.taskNow(codexCard.id)).column, 'planning');
  await assert.rejects(w.board.routeApprovedPlan(codex.id, { provider: 'codex', source: 'agent-turn-complete', at: Date.now() }), { code: 'PLAN_APPROVAL_NOT_OBSERVED' });
  await w.move(codexCard.id, 'todo');
});

test('an approved-plan target with auto-start off parks the native conversation without launching or injecting a continuation', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, true), config = defaultPipelineConfig(); config.columns.find(column => column.id === 'executing').strategy.autoSpawn = false; await w.configure(config);
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Manual destination', prompt: 'ACTIVITY_FIXTURE' });
  const original = (await w.move(card.id, 'planning')).run; await until(async () => (await w.board.run(original.id)).activity?.ready);
  w.board.executor.input(original.id, 'activity-plan-approve-working\r');
  const routed = await until(async () => { const run = await w.board.run(original.id); return run.planRoutes?.at(-1)?.status === 'completed' && run; });
  assert.equal(routed.status, 'suspended'); assert.equal(w.board.executor.sessions.get(original.id).proc, null);
  assert.equal((await w.taskNow(card.id)).column, 'executing'); assert.equal((await w.taskNow(card.id)).sessionId, original.sessionId);
  assert.equal((await w.board.state()).runs.filter(run => run.taskId === card.id).length, 1);
  const output = await readFile(join(w.dataDir, original.artifactsDir, 'output.log'), 'utf8'); assert.doesNotMatch(output, /you said:.*Proceed with implementing/);
});

test('board profiles save exclusive task settings without changing Composer bytes or starting agents, and drive an explicit arrival', async t => {
  const w = await world(t), config = defaultPipelineConfig();
  config.profiles = [{ id: 'economy', name: 'Economy', columns: { executing: { agentOverride: 'codex', modelOverride: 'profile-model', effortOverride: 'high', autoSpawn: false } } }];
  await w.configure(config);
  const mcp = await w.board.base.create({ kind: 'mcp', name: 'Profile tools', enabled: true, trust: 'trusted', configuration: { transport: 'stdio', command: process.execPath, args: ['--version'] } });
  await w.board.base.apply({ changes: [{ target: { scope: 'project', projectId: w.projectId }, binding: { mode: 'extend', include: [{ resourceId: mcp.id, required: true }], exclude: [] } }], expectedBaseRevision: (await w.board.state()).base.revision });
  const prompt = '  Engineered <literal> & {{title}}\r\n  Split task 😀  ';
  const card = await w.board.createTask({ projectId: w.projectId, title: 'From Composer', prompt });
  const edited = await w.board.updateTask(card.id, { pipelineSettings: { profileId: 'economy' }, expectedProjectRevision: (await w.projectNow()).revision, expectedRevision: card.revision });
  assert.equal(edited.task.prompt, prompt); assert.equal(edited.task.contentRevision, 1); assert.equal(edited.task.checksOutdated, false); assert.equal(edited.task.column, 'todo');
  assert.equal(w.starts.length, 0); assert.deepEqual((await w.board.state()).runs, []);
  const copy = await w.board.duplicateTask(card.id); assert.equal(copy.profileId, 'economy'); assert.equal(copy.prompt, prompt); assert.equal(copy.workspace, null);
  await w.move(card.id, 'executing'); assert.equal(w.starts.length, 0, 'A profile can make a shared automatic column manual.');
  const view = await w.board.view(), shown = view.projects[0].tasks.find(task => task.id === card.id);
  assert.equal(shown.pipelineAgent.provider, 'codex'); assert.equal(shown.pipelineAgent.model, 'profile-model'); assert.equal(shown.pipelineAgent.policy, 'manual');
  const preview = await w.board.previewBase({ target: { scope: 'task', projectId: w.projectId, taskId: card.id } }); assert.equal(preview.provider, 'codex');
  assert.equal((await w.board.baseView()).targets.find(item => item.target.scope === 'task' && item.target.taskId === card.id).provider, 'codex');
  const started = { run: await w.board.requestRun(card.id, { stage: 'executing', consent: true }) };
  assert.equal(started.run.config.provider, 'codex'); assert.equal(started.run.config.model, 'profile-model'); assert.equal(started.run.config.effort, 'high');
  assert.ok(started.run.baseManifest.resources.some(resource => resource.resourceId === mcp.id));
  const built = await buildSession({ provider: 'codex', stage: 'executing', config: started.run.config, message: pipelineTaskEnvelope(card), runDir: await temp(t) });
  assert.ok(!built.args.includes('--strict-mcp-config')); assert.equal((await w.taskNow(card.id)).prompt, prompt);
});

test('board profiles reject stale, foreign, conflicting or unsafe task choices atomically', async t => {
  const w = await world(t), config = defaultPipelineConfig(); config.profiles = [{ id: 'p', name: 'Profile', columns: {} }]; await w.configure(config);
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Exact', prompt: '  Exact\r\n' });
  const projectRevision = (await w.projectNow()).revision, before = structuredClone(await w.board.state());
  for (const pipelineSettings of [{ profileId: 'missing' }, { profileId: 'p', agentOverride: { agentOverride: 'codex' } }, { agentOverride: { agentOverride: 'claude', permissionMode: 'yolo' } }, { agentOverride: { agentOverride: 'codex', modelOverride: '--flag' } }, { autoSpawn: true }]) {
    await assert.rejects(w.board.updateTask(card.id, { title: 'Must not save', pipelineSettings, expectedRevision: 1, expectedProjectRevision: projectRevision }), { code: 'INVALID_PIPELINE_CONFIG' });
    assert.deepEqual(await w.board.state(), before);
  }
  for (const values of [{ expectedRevision: 99, expectedProjectRevision: projectRevision }, { expectedRevision: 1, expectedProjectRevision: projectRevision - 1 }]) await assert.rejects(w.board.updateTask(card.id, { pipelineSettings: { profileId: 'p' }, ...values }), { code: 'REVISION_CONFLICT' });
  await assert.rejects(w.board.updateTask(card.id, { pipelineSettings: {}, expectedProjectRevision: projectRevision }), { code: 'REVISION_REQUIRED' });
  await assert.rejects(w.board.createTask({ projectId: w.projectId, title: 'Unsafe creation', prompt: 'Exact', pipelineSettings: { profileId: 'missing' }, expectedProjectRevision: projectRevision }), { code: 'INVALID_PIPELINE_CONFIG' });
  assert.deepEqual(await w.board.state(), before); assert.equal(w.starts.length, 0);
});

test('board profiles keep active runs and automation ownership unchanged and allow future pins only after pause', async t => {
  const w = await world(t); await w.configure(defaultPipelineConfig());
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Pinned', prompt: 'Original' }), started = await w.move(card.id, 'executing');
  const save = () => w.board.updateTask(card.id, { pipelineSettings: { agentOverride: { agentOverride: 'codex' } }, expectedRevision: (w.board.store.state.projects[0].tasks.find(task => task.id === card.id)).revision, expectedProjectRevision: w.board.store.state.projects[0].revision });
  await assert.rejects(save(), { code: 'RUN_ACTIVE' }); await w.board.updateRun(started.run.id, { status: 'suspended' });
  w.board.automationMoves.set(card.id, {}); await assert.rejects(save(), { code: 'AUTOMATIONS_ACTIVE' }); w.board.automationMoves.delete(card.id);
  const before = structuredClone(await w.board.run(started.run.id));
  const result = await save(); assert.equal(result.task.agentOverride.agentOverride, 'codex'); assert.equal(result.task.profileId, null);
  assert.deepEqual(await w.board.run(started.run.id), before); assert.equal(w.starts.length, 1); assert.equal(result.task.contentRevision, 1);
});

test('board profiles rename stable choices and deletion returns tasks to Default without invalidating their text or Base', async t => {
  const w = await world(t), config = defaultPipelineConfig();
  for (const column of config.columns) column.strategy.autoSpawn = false;
  config.profiles = [{ id: 'profile', name: 'Before', columns: { executing: { modelOverride: 'pinned' } } }]; await w.configure(config);
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Profile task', prompt: '  Keep exact\r\n', pipelineSettings: { profileId: 'profile' }, expectedProjectRevision: (await w.projectNow()).revision });
  const baseBefore = structuredClone((await w.board.state()).base); config.profiles[0].name = 'After'; await w.configure(config);
  assert.equal((await w.taskNow(card.id)).profileId, 'profile'); assert.equal((await w.taskNow(card.id)).revision, 1);
  config.profiles = []; await w.configure(config);
  const saved = await w.taskNow(card.id); assert.equal(saved.profileId, null); assert.equal(saved.revision, 2); assert.equal(saved.contentRevision, 1); assert.equal(saved.prompt, card.prompt); assert.equal(saved.checksOutdated, false);
  assert.deepEqual((await w.board.state()).base, baseBefore); assert.equal(w.starts.length, 0);
  const reload = new Board({ dataDir: w.dataDir }); assert.equal((await reload.state()).projects[0].tasks[0].profileId, null);
});

test('board profiles and whole-task pins round-trip through v5 backups without sessions or imported dispatch', async t => {
  const w = await world(t), config = defaultPipelineConfig(); config.profiles = [{ id: 'p', name: 'Portable', columns: { planning: { permissionMode: null }, executing: { agentOverride: 'codex' } } }]; await w.configure(config);
  const rev = (await w.projectNow()).revision, prompt = '  Portable 😀\r\n{{title}} ';
  await w.board.createTask({ projectId: w.projectId, title: 'Profile', prompt, pipelineSettings: { profileId: 'p' }, expectedProjectRevision: rev });
  await w.board.createTask({ projectId: w.projectId, title: 'Pin', prompt, pipelineSettings: { agentOverride: { agentOverride: 'claude', modelOverride: 'custom', effortOverride: 'max', permissionMode: 'default' } }, expectedProjectRevision: rev });
  const backup = await w.board.exportBackup(); assert.equal(backup.version, 11); assert.equal(backup.projects[0].tasks[0].profileId, 'p');
  const imported = new Board({ dataDir: await temp(t) }); await imported.importBackup(backup, { replace: true });
  const project = (await imported.state()).projects[0]; assert.equal(project.tasks[0].profileId, 'p'); assert.deepEqual(project.tasks[1].agentOverride, backup.projects[0].tasks[1].agentOverride);
  assert.equal(project.tasks[1].prompt, prompt); assert.equal(project.tasks[1].workspace, null); assert.deepEqual((await imported.state()).sessions, []);
  assert.ok(project.pipeline.columns.every(column => column.strategy.autoSpawn === false)); assert.ok(project.pipeline.profiles.every(profile => Object.values(profile.columns).every(strategy => strategy.autoSpawn === false)));
  const again = await imported.exportBackup(); assert.deepEqual(again.projects[0].pipeline, config); assert.equal(again.projects[0].tasks[0].profileId, 'p');
  const invalid = structuredClone(backup); invalid.projects[0].tasks[0].profileId = 'foreign'; await assert.rejects(imported.importBackup(invalid, { replace: true }), { code: 'INVALID_BACKUP' });
  const old = structuredClone(backup); old.version = 4; for (const task of old.projects[0].tasks) { delete task.profileId; delete task.agentOverride; }
  await imported.importBackup(old, { replace: true }); assert.equal((await imported.state()).projects[0].tasks[0].profileId, null);
});

test('board profiles apply actual native launch flags and paused same-provider changes resume context without replaying Composer or Base', { skip: process.platform === 'win32' }, async t => {
  const report = join(await temp(t), 'profile-launches.jsonl'), previous = process.env.FAKE_AGENT_REPORT;
  process.env.FAKE_AGENT_REPORT = report; t.after(() => { if (previous === undefined) delete process.env.FAKE_AGENT_REPORT; else process.env.FAKE_AGENT_REPORT = previous; });
  const w = await world(t, true), config = defaultPipelineConfig(); for (const column of config.columns) column.strategy.autoSpawn = false;
  config.profiles = [{ id: 'p', name: 'Native profile', columns: { executing: { agentOverride: 'claude', modelOverride: 'profile-one', effortOverride: 'low', permissionMode: 'default', autoSpawn: true } } }]; await w.configure(config);
  const mcp = await w.board.base.create({ kind: 'mcp', name: 'Native profile tool', enabled: true, trust: 'trusted', configuration: { transport: 'stdio', command: process.execPath, args: ['--version'] } });
  await w.board.base.apply({ changes: [{ target: { scope: 'project', projectId: w.projectId }, binding: { mode: 'extend', include: [{ resourceId: mcp.id, required: true }], exclude: [] } }], expectedBaseRevision: (await w.board.state()).base.revision });
  const prompt = '  Original Composer <literal>\r\n😀  ', card = await w.board.createTask({ projectId: w.projectId, title: 'Native profile task', prompt, pipelineSettings: { profileId: 'p' }, expectedProjectRevision: (await w.projectNow()).revision });
  const first = await w.move(card.id, 'executing'); await until(async () => (await w.board.run(first.run.id)).turnComplete);
  const nativeId = (await w.board.state()).sessions.find(session => session.id === first.run.sessionId).nativeSessionId;
  await w.board.pauseRun(first.run.id, { confirm: true }); config.profiles[0].columns.executing.modelOverride = 'profile-two'; await w.configure(config);
  const second = await w.board.resumeTask(card.id, { consent: true }); await until(async () => w.board.executor.sessions.get(second.id)?.sawEvent && (await w.board.run(second.id)).status === 'running');
  await w.board.pauseRun(second.id, { confirm: true });
  await w.board.updateTask(card.id, { pipelineSettings: { agentOverride: { agentOverride: 'claude', modelOverride: 'whole-task', effortOverride: 'high', permissionMode: 'default' } }, expectedRevision: (await w.taskNow(card.id)).revision, expectedProjectRevision: (await w.projectNow()).revision });
  const third = await w.board.resumeTask(card.id, { consent: true }); await until(async () => w.board.executor.sessions.get(third.id)?.sawEvent && (await w.board.run(third.id)).status === 'running');
  assert.equal(second.sessionId, first.run.sessionId); assert.equal(third.sessionId, first.run.sessionId);
  assert.equal(second.providerSessionId, nativeId); assert.equal(third.providerSessionId, nativeId);
  for (const run of [second, third]) { assert.equal(await readFile(join(w.dataDir, run.artifactsDir, 'prompt.md'), 'utf8'), ''); assert.ok(run.baseManifest.resources.some(resource => resource.resourceId === mcp.id)); }
  const launches = (await readFile(report, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); assert.equal(launches.length, 3);
  assert.deepEqual(launches.map(launch => launch.args[launch.args.indexOf('--model') + 1]), ['profile-one', 'profile-two', 'whole-task']);
  for (const launch of launches) { assert.ok(launch.args.includes('--mcp-config')); assert.ok(!launch.args.includes('--strict-mcp-config')); assert.ok(!launch.args.includes('--tools')); assert.ok(!launch.args.includes('--disallowedTools')); }
  assert.equal((await w.taskNow(card.id)).prompt, prompt); assert.equal((await w.taskNow(card.id)).contentRevision, 1);
});
