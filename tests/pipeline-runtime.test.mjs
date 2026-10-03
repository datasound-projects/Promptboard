import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
  await assert.rejects(w.move(card.id, 'planning'), { code: 'PIPELINE_RECONFIGURE_REQUIRED' });
  assert.equal((await w.taskNow(card.id)).column, 'testing');
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
  const backup = await w.board.exportBackup(); assert.equal(backup.version, 4);
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
    const restored = await w.move(card.id, 'testing'); await until(async () => (await w.board.run(restored.run.id)).status === 'running');
    assert.equal(restored.run.sessionId, first.run.sessionId); assert.equal(await readFile(join(w.dataDir, restored.run.artifactsDir, 'prompt.md'), 'utf8'), '');
    await w.move(card.id, 'todo');
  }
  assert.equal(await readFile(join(w.root, 'README.md'), 'utf8'), 'main checkout\n');
});
