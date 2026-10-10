import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from '../src/board.mjs';
import { Store, emptyState, migrateState, STATE_VERSION } from '../src/store.mjs';
import { defaultPipelineConfig } from '../src/pipeline-config.mjs';
import { resolveConfig } from '../src/agents.mjs';
import { PipelineActions } from '../src/pipeline-actions.mjs';
import { pipelineTaskEnvelope } from '../src/pipeline-templates.mjs';
import { expireLease } from './helpers/journal.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } }).trim();
const quote = text => process.platform === 'win32' ? `'${text.replaceAll("'", "''")}'` : `'${text.replaceAll("'", "'\\''")}'`;
// PowerShell scripts explicitly propagate a native command's exit code, as a
// user-authored Windows automation must do; invocation alone exits successfully.
const nodeScript = (file, ...args) => `${process.platform === 'win32' ? '& ' : ''}${[process.execPath, file, ...args].map(quote).join(' ')}${process.platform === 'win32' ? '\nexit $LASTEXITCODE' : ''}`;
async function until(fn) { const end = Date.now() + 10000; for (;;) { const value = await fn(); if (value) return value; if (Date.now() > end) assert.fail('Runtime automation fixture did not become ready.'); await new Promise(resolve => setTimeout(resolve, 30)); } }
async function temp(t) { const dir = await realpath(await mkdtemp(join(tmpdir(), 'pb-runtime-actions-'))); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return dir; }
async function world(t, { autoSpawn = false, actions = new PipelineActions() } = {}) {
  const dataDir = await temp(t), root = await temp(t), fixture = await temp(t), board = new Board({ dataDir, automationActions: actions });
  t.after(() => board.shutdownAutomations());
  git(root, 'init', '-q', '-b', 'trunk'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.test');
  await writeFile(join(root, 'README.md'), 'Untouched project\n'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'Fixture');
  const project = await board.createProject({ name: 'Automations' });
  await board.linkRepository(project.id, { path: root, expectedRevision: 1 }); await board.setTargetBranch(project.id, { branch: 'trunk', expectedRevision: 2 });
  const log = join(fixture, 'observations.jsonl'), worker = join(fixture, 'worker.mjs'), starts = [];
  await writeFile(worker, `import {appendFileSync,existsSync,writeFileSync} from 'node:fs'; import {join} from 'node:path';
const [log,tag,folder]=process.argv.slice(2); appendFileSync(log,JSON.stringify({tag,cwd:process.cwd(),title:process.env.PROMPTBOARD_TITLE,prompt:process.env.PROMPTBOARD_DESCRIPTION,taskId:process.env.PROMPTBOARD_TASK_ID,trigger:process.env.PROMPTBOARD_TRIGGER})+'\\n');
if(tag==='busy'||tag==='gate'){setInterval(()=>{writeFileSync(join(folder,'heartbeat-'+process.env.PROMPTBOARD_TASK_ID),String(Date.now()));if(tag==='gate'&&existsSync(join(folder,'release')))process.exit(0)},20)}else if(tag==='failed')process.exit(7);`);
  const observations = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  board.executor = { validate: async ({ stage, config }) => resolveConfig(stage, config),
    start: async payload => { starts.push({ ...payload, observations: await observations() }); await board.updateRun(payload.run.id, { status: 'running' }); },
    cancel: async id => board.updateRun(id, { status: 'cancelled' }), suspend: async id => board.updateRun(id, { status: 'suspended' }) };
  const config = defaultPipelineConfig(); for (const column of config.columns) column.strategy.autoSpawn = autoSpawn;
  const projectNow = async () => (await board.state()).projects.find(item => item.id === project.id);
  const taskNow = async id => (await projectNow()).tasks.find(item => item.id === id);
  const configure = () => board.setPipeline(project.id, { pipeline: config, expectedRevision: 3, confirm: true });
  const row = (tag, fields = {}) => ({ id: 'row-' + tag, name: tag, type: 'run_script', enabled: true, script: nodeScript(worker, log, tag, fixture), ...fields });
  const move = async (id, column, extra = {}) => board.transition(id, { column, expectedRevision: (await taskNow(id)).revision, ...extra });
  return { board, dataDir, root, fixture, log, starts, config, projectNow, taskNow, configure, row, move, observations, projectId: project.id };
}

test('v5 migration preserves pipeline configuration, exact Composer text, Base and native sessions without execution', async t => {
  const dir = await temp(t), original = { ...emptyState(), version: 5, projects: [{ id: 'p', name: 'Saved', workflowMode: 'pipeline',
    pipeline: defaultPipelineConfig(), tasks: [{ id: 't', title: 'Exact task', prompt: '  Composer\r\ntext  ', column: 'todo', baseBinding: { ids: ['saved-resource'] } }] }],
    runs: [{ id: 'r', taskId: 't', projectId: 'p', status: 'suspended', providerSessionId: 'native-exact' }],
    sessions: [{ id: 's', taskId: 't', projectId: 'p', status: 'suspended', runIds: ['r'], artifacts: [], nativeSessionId: 'native-exact' }] };
  const bytes = JSON.stringify(original); await writeFile(join(dir, 'state.json'), bytes);
  const store = new Store(dir), migrated = await store.read();
  assert.equal(migrated.version, STATE_VERSION); assert.equal(STATE_VERSION, 13);
  assert.deepEqual(migrated.projects, original.projects.map(project => ({ ...project, nextTaskNumber: 2, labels: [], labelRevision: 0, tasks: project.tasks.map(task => ({ ...task, number: 1, priority: 0, labelIds: [] })) }))); assert.deepEqual(migrated.base, original.base);
  assert.deepEqual(migrated.runs, original.runs); assert.deepEqual(migrated.sessions, original.sessions);
  assert.equal(await readFile(join(dir, store.recovery.migrationBackup), 'utf8'), bytes);
  await assert.rejects(access(join(dir, 'automations')), { code: 'ENOENT' });
});

test('real scripts run exit/lifecycle/enter in order, use exact metadata and start the fresh agent only after enter rows', async t => {
  const w = await world(t, { autoSpawn: true });
  w.config.columns[0].automations.onExit = [w.row('exit')];
  w.config.columns[2].automations.onEnter = [w.row('first'), w.row('failed'), w.row('last')]; await w.configure();
  const prompt = '  Exact Composer task\r\nconst x = 1;  ', card = await w.board.createTask({ projectId: w.projectId, title: 'Task "& `$(literal)` {{projectName}}', prompt });
  const nonce = randomUUID(), result = await w.move(card.id, 'executing', { transitionId: nonce });
  const records = await w.observations(); assert.deepEqual(records.map(item => item.tag), ['exit', 'first', 'failed', 'last']);
  assert.equal(records[0].cwd, w.root); assert.ok(records.slice(1).every(item => item.cwd === result.run.workspacePath));
  assert.ok(records.every(item => item.title === card.title && item.prompt === ': ' + prompt && item.taskId === card.id));
  assert.deepEqual(records.map(item => item.trigger), ['exit', 'enter', 'enter', 'enter']);
  assert.equal(w.starts.length, 1); assert.deepEqual(w.starts[0].observations.map(item => item.tag), ['exit', 'first', 'failed', 'last']);
  assert.equal(w.starts[0].firstPrompt, pipelineTaskEnvelope(card));
  const [receipt] = await w.board.automationRuns(card.id);
  assert.equal(receipt.status, 'completed'); assert.equal(receipt.lifecycle.status, 'succeeded');
  assert.deepEqual(receipt.actions.map(action => action.status), ['succeeded', 'succeeded', 'failed', 'succeeded']);
  await w.move(card.id, 'code_review');
  const duplicate = await w.move(card.id, 'executing', { transitionId: nonce }); assert.equal(duplicate.duplicate, true);
  assert.equal((await w.taskNow(card.id)).column, 'code_review'); assert.equal((await w.observations()).length, 4); assert.equal(w.starts.length, 1);
  assert.equal(await readFile(join(w.root, 'README.md'), 'utf8'), 'Untouched project\n');
});

test('manual columns run their non-message rows without an agent, and Done restoration retains its other enter actions', async t => {
  const w = await world(t);
  w.config.columns[3].automations.onEnter = [w.row('manual')];
  w.config.columns[6].automations.onExit = [w.row('restore')]; await w.configure();
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Manual', prompt: 'No agent input' });
  await w.move(card.id, 'done'); assert.ok((await w.taskNow(card.id)).archivedAt);
  await w.move(card.id, 'code_review'); assert.equal((await w.taskNow(card.id)).archivedAt, undefined);
  assert.deepEqual((await w.observations()).map(item => item.tag), ['restore', 'manual']); assert.equal(w.starts.length, 0);
  const before = await w.board.automationRuns(card.id); await w.move(card.id, 'code_review', { index: 0 });
  assert.deepEqual(await w.board.automationRuns(card.id), before);
});

test('a revision change after exit effects fails the lifecycle without running enter rows or starting stale task text', async t => {
  const w = await world(t, { autoSpawn: true });
  w.config.columns[0].automations.onExit = [w.row('gate')]; w.config.columns[2].automations.onEnter = [w.row('never')]; await w.configure();
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Old title', prompt: 'Old prompt' });
  const moving = w.move(card.id, 'executing'); const rejected = assert.rejects(moving, { code: 'REVISION_CONFLICT' });
  await until(() => readFile(join(w.fixture, 'heartbeat-' + card.id), 'utf8').catch(() => null));
  await w.board.updateTask(card.id, { title: 'New title', expectedRevision: (await w.taskNow(card.id)).revision });
  await writeFile(join(w.fixture, 'release'), 'release'); await rejected;
  assert.deepEqual((await w.observations()).map(item => item.tag), ['gate']); assert.equal(w.starts.length, 0);
  const task = await w.taskNow(card.id); assert.equal(task.column, 'todo'); assert.equal(task.title, 'New title');
  const [move] = await w.board.automationRuns(card.id); assert.equal(move.lifecycle.status, 'failed'); assert.equal(move.actions.at(-1).status, 'skipped');
});

test('an edit during enter actions cancels the unstarted agent while preserving known placement and script outcomes', async t => {
  const w = await world(t, { autoSpawn: true }); w.config.columns[2].automations.onEnter = [w.row('gate')]; await w.configure();
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Original', prompt: 'Original task' });
  const moving = w.move(card.id, 'executing'), rejected = assert.rejects(moving, { code: 'REVISION_CONFLICT' });
  await until(() => readFile(join(w.fixture, 'heartbeat-' + card.id), 'utf8').catch(() => null));
  const entered = await w.taskNow(card.id); assert.equal(entered.column, 'executing');
  await w.board.updateTask(card.id, { title: 'Edited', expectedRevision: entered.revision }); await writeFile(join(w.fixture, 'release'), 'release'); await rejected;
  assert.equal(w.starts.length, 0); assert.equal(w.board.deferredPipelineStarts.size, 0);
  const state = await w.board.state(); assert.equal(state.runs[0].status, 'cancelled'); assert.equal(state.projects[0].tasks[0].title, 'Edited');
  const [receipt] = await w.board.automationRuns(card.id); assert.equal(receipt.lifecycle.status, 'succeeded'); assert.equal(receipt.actions[0].status, 'succeeded'); assert.equal(receipt.status, 'cancelled');
});

test('Stop revokes a pending lifecycle validation without waiting for an unresponsive executable lookup', async t => {
  const w = await world(t, { autoSpawn: true }); w.config.columns[2].automations.onEnter = [w.row('never')]; await w.configure();
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Lookup', prompt: 'No stale start' });
  let validating = false; w.board.executor.validate = () => { validating = true; return new Promise(() => {}); };
  const moving = w.move(card.id, 'executing'), rejected = assert.rejects(moving, { code: 'PIPELINE_RECONFIGURE_CANCELLED' });
  await until(() => validating); await w.board.cancelAutomationMove(card.id, { confirm: true }); await rejected;
  const [receipt] = await w.board.automationRuns(card.id); assert.equal(receipt.lifecycle.status, 'cancelled'); assert.equal(receipt.actions[0].status, 'skipped');
  assert.equal((await w.taskNow(card.id)).column, 'todo'); assert.equal(w.starts.length, 0); assert.equal(w.board.automationMoves.size, 0);
});

test('native plan approval revoked during move acceptance cannot start source scripts or change the card', async t => {
  const w = await world(t, { autoSpawn: true });
  for (const column of w.config.columns) column.strategy.agentOverride = 'claude';
  w.config.columns[1].automations.onExit = [w.row('never')]; await w.configure();
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Plan', prompt: 'Exact plan task' });
  const { run } = await w.move(card.id, 'planning'), approval = { provider: 'claude', source: 'PostToolUse', at: Date.now(), toolId: 'approved-native-tool' };
  await w.board.updateRun(run.id, { activity: { planApproval: approval } });
  const update = w.board.store.update.bind(w.board.store); let revoked = false;
  w.board.store.update = async mutator => {
    let accepted = false;
    const result = await update(draft => { const value = mutator(draft); accepted = draft.projects[0].tasks[0].automationMove?.status === 'pending'; return value; });
    if (accepted && !revoked) { revoked = true; await update(draft => { draft.runs.find(item => item.id === run.id).activity.planApproval = null; }); }
    return result;
  };
  const route = await w.board.routeApprovedPlan(run.id, approval);
  assert.equal(route.status, 'failed'); assert.equal(route.errorCode, 'PLAN_APPROVAL_STALE');
  assert.equal((await w.taskNow(card.id)).column, 'planning'); assert.equal((await w.observations()).length, 0); assert.equal(w.starts.length, 1);
  const [receipt] = await w.board.automationRuns(card.id); assert.equal(receipt.actions[0].status, 'skipped'); assert.equal(receipt.lifecycle.status, 'cancelled');
});

test('Stop cancels only the selected task before task locks and pipeline edits cannot replace active row definitions', async t => {
  const w = await world(t); w.config.columns[0].automations.onExit = [w.row('busy')]; await w.configure();
  const a = await w.board.createTask({ projectId: w.projectId, title: 'A', prompt: 'A' }), b = await w.board.createTask({ projectId: w.projectId, title: 'B', prompt: 'B' });
  const movingA = w.move(a.id, 'executing'), movingB = w.move(b.id, 'executing');
  const stoppedA = assert.rejects(movingA, { code: 'AUTOMATION_MOVE_CANCELLED' }), stoppedB = assert.rejects(movingB, { code: 'AUTOMATION_MOVE_CANCELLED' });
  const beat = id => readFile(join(w.fixture, 'heartbeat-' + id), 'utf8').catch(() => null);
  await until(async () => (await beat(a.id)) && (await beat(b.id)));
  await assert.rejects(w.board.deleteProject(w.projectId, { expectedRevision: (await w.projectNow()).revision }), { code: 'AUTOMATIONS_ACTIVE' });
  await assert.rejects(w.board.deleteTask(a.id, { expectedRevision: (await w.taskNow(a.id)).revision }), { code: 'AUTOMATIONS_ACTIVE' });
  await assert.rejects(w.board.removeTaskWorktree(a.id), { code: 'AUTOMATIONS_ACTIVE' });
  await assert.rejects(w.board.completeTask(a.id, { kind: 'fixture', details: {} }), { code: 'AUTOMATIONS_ACTIVE' });
  await assert.rejects(w.board.setPipeline(w.projectId, { pipeline: w.config, expectedRevision: (await w.projectNow()).revision }), { code: 'AUTOMATIONS_ACTIVE' });
  await assert.rejects(w.board.cancelAutomationMove(a.id), { code: 'CONFIRMATION_REQUIRED' });
  await w.board.cancelAutomationMove(a.id, { confirm: true }); await stoppedA;
  const paused = await beat(a.id), live = await beat(b.id); await until(async () => (await beat(b.id)) !== live);
  assert.equal(await beat(a.id), paused); assert.equal((await w.taskNow(a.id)).column, 'todo');
  await w.board.cancelAutomationMove(b.id, { confirm: true }); await stoppedB;
  assert.equal(w.board.automations.actions.jobs.size, 0); assert.equal(w.starts.length, 0);
});

test('a failed task-state acceptance publishes no executable grant and keeps the task and agent untouched', async t => {
  const w = await world(t, { autoSpawn: true }); w.config.columns[0].automations.onExit = [w.row('never')]; await w.configure();
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Save failure', prompt: 'Exact body' }), update = w.board.store.update.bind(w.board.store);
  let refused = false;
  w.board.store.update = mutator => update(draft => { const result = mutator(draft); if (!refused && draft.projects[0].tasks[0].automationMove?.status === 'pending') { refused = true; throw new Error('Fixture acceptance failure'); } return result; });
  await assert.rejects(w.move(card.id, 'executing'), /Fixture acceptance failure/);
  assert.equal((await w.observations()).length, 0); assert.equal(w.starts.length, 0); assert.equal((await w.taskNow(card.id)).column, 'todo');
  assert.equal(w.board.automationMoves.size, 0);
});

test('startup recovers only referenced dead-owner moves, preserves known receipts and never executes or repeats an old move ID', async t => {
  const w = await world(t); w.config.columns[0].automations.onExit = [w.row('never')]; await w.configure();
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Recover', prompt: 'Original input' });
  const key = { projectId: w.projectId, taskId: card.id, transitionId: randomUUID() }, module = new URL('../src/pipeline-journal.mjs', import.meta.url).href;
  const code = `import {PipelineJournal} from ${JSON.stringify(module)}; const j=new PipelineJournal(process.argv[1]); const key=JSON.parse(process.argv[2]); const r=await j.beginMove({...key,taskRevision:1,projectRevision:4,from:{id:'todo',name:'To Do'},to:{id:'executing',name:'Executing'},onExit:[{id:'unknown',name:'Unknown',type:'run_script',enabled:true,script:'echo NEVER_REPLAY'}]}); await j.startAction(key,r.move.actions[0].id);`;
  execFileSync(process.execPath, ['--input-type=module', '-e', code, w.dataDir, JSON.stringify(key)], { encoding: 'utf8' });
  await expireLease(w.dataDir, key);
  await w.board.store.update(state => { const task = state.projects[0].tasks[0]; task.automationMoves = [key]; task.automationMove = { ...key, status: 'running', phase: 'exit' }; });
  const recovered = new Board({ dataDir: w.dataDir }); t.after(() => recovered.shutdownAutomations());
  const task = (await recovered.state()).projects[0].tasks[0]; assert.equal(task.automationMove.status, 'interrupted'); assert.equal(task.column, 'todo');
  const [receipt] = await recovered.automationRuns(card.id); assert.equal(receipt.actions[0].status, 'interrupted'); assert.equal(receipt.lifecycle.status, 'interrupted');
  const duplicate = await recovered.transition(card.id, { column: 'executing', expectedRevision: -1, transitionId: key.transitionId }); assert.equal(duplicate.duplicate, true);
  assert.equal((await w.observations()).length, 0); assert.equal((await recovered.state()).runs.length, 0);
});

test('shutdown records cancellation before returning and refuses later executable moves', async t => {
  const w = await world(t); w.config.columns[0].automations.onExit = [w.row('busy')]; await w.configure();
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Shutdown', prompt: 'Keep exact' });
  const moving = w.move(card.id, 'executing'), stopped = assert.rejects(moving, { code: 'AUTOMATION_MOVE_CANCELLED' });
  await until(() => readFile(join(w.fixture, 'heartbeat-' + card.id), 'utf8').catch(() => null));
  await w.board.shutdownAutomations(); await stopped;
  assert.equal(w.board.automationMoves.size, 0); assert.equal(w.board.automations.actions.jobs.size, 0);
  const [receipt] = await w.board.automationRuns(card.id); assert.equal(receipt.status, 'cancelled'); assert.equal(receipt.lifecycle.status, 'cancelled');
  assert.equal((await w.taskNow(card.id)).automationMove.status, 'cancelled');
  await assert.rejects(w.move(card.id, 'executing'), { code: 'AUTOMATIONS_SHUTTING_DOWN' });
  assert.equal((await w.observations()).length, 1);
});

test('missing journals block only their task and cannot be bypassed by a destination with no rows', async t => {
  const w = await world(t); await w.configure();
  const broken = await w.board.createTask({ projectId: w.projectId, title: 'Missing', prompt: 'Do not replay' });
  const healthy = await w.board.createTask({ projectId: w.projectId, title: 'Healthy', prompt: 'Exact body' });
  const key = { projectId: w.projectId, taskId: broken.id, transitionId: randomUUID() };
  await w.board.store.update(state => { const card = state.projects[0].tasks.find(item => item.id === broken.id); card.automationMoves = [key]; card.automationMove = { ...key, status: 'pending', phase: 'exit' }; });
  const cold = new Board({ dataDir: w.dataDir }); t.after(() => cold.shutdownAutomations());
  const state = await cold.state(); assert.equal(state.projects[0].tasks.find(item => item.id === broken.id).automationMove.status, 'blocked');
  await assert.rejects(cold.transition(broken.id, { column: 'code_review', expectedRevision: 1 }), { code: 'AUTOMATION_MOVE_ACTIVE' });
  await assert.rejects(cold.automationRuns(broken.id), { code: 'AUTOMATION_JOURNAL_MISSING' });
  await cold.transition(healthy.id, { column: 'code_review', expectedRevision: 1 });
  const cards = (await cold.state()).projects[0].tasks;
  assert.equal(cards.find(item => item.id === broken.id).column, 'todo'); assert.equal(cards.find(item => item.id === healthy.id).column, 'code_review'); assert.equal(w.starts.length, 0);
});

test('portable backups omit move grants and histories, and imported executable rows stay inert', async t => {
  const w = await world(t); w.config.columns[3].automations.onEnter = [w.row('original')]; await w.configure();
  const card = await w.board.createTask({ projectId: w.projectId, title: 'Portable', prompt: '  Exact Composer\r\n' });
  await w.move(card.id, 'code_review');
  const backup = await w.board.exportBackup(); assert.doesNotMatch(JSON.stringify(backup), /automationMove|ownerPid|configHash/);
  const clone = new Board({ dataDir: await temp(t) }); t.after(() => clone.shutdownAutomations()); await clone.importBackup(backup);
  const state = await clone.state(), imported = state.projects[0], task = imported.tasks[0];
  assert.equal(task.prompt, card.prompt); assert.equal(task.automationMoves, undefined); assert.equal(task.automationMove, undefined);
  assert.ok(imported.pipelineImport); assert.equal(imported.pipeline.columns[3].automations.onEnter[0].enabled, false);
  assert.equal((await clone.automationRuns(task.id)).length, 0); assert.equal((await w.observations()).length, 1);
});

test('v6 rejects forged cross-task grants and quarantines malformed summaries with their original bytes preserved', async t => {
  const key = { projectId: 'p', taskId: 't', transitionId: 'move' };
  const original = { ...emptyState(), projects: [{ id: 'p', labels: [], labelRevision: 0, tasks: [{ id: 't', labelIds: [], automationMoves: [key], automationMove: { ...key, status: 'pending', phase: 'exit' } }] }] };
  for (const changed of [ { taskId: 'another' }, { updatedAt: -1 }, { reason: 'x'.repeat(501) }, { errorCode: 'raw private diagnostics' } ]) {
    const invalid = structuredClone(original); Object.assign(invalid.projects[0].tasks[0].automationMove, changed);
    assert.throws(() => migrateState(invalid), /Invalid task automation move/);
    const dir = await temp(t);
    const bytes = JSON.stringify(invalid); await writeFile(join(dir, 'state.json'), bytes);
    const store = new Store(dir); assert.deepEqual((await store.read()).projects, []);
    assert.equal(await readFile(join(dir, store.recovery.quarantined), 'utf8'), bytes);
    await assert.rejects(access(join(dir, 'state.json')), { code: 'ENOENT' });
  }
});
