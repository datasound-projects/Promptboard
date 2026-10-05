import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from '../src/board.mjs';
import { Store } from '../src/store.mjs';
import { defaultPipelineConfig, normalizePipelineConfig } from '../src/pipeline-config.mjs';
import { resolveConfig } from '../src/agents.mjs';
import { PipelineActions } from '../src/pipeline-actions.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const exact = '  Engineered 雪\r\n{{title}}\r\n  ';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } }).trim();
async function temp(t) { const dir = await realpath(await mkdtemp(join(tmpdir(), 'pb-backlog-arrival-'))); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return dir; }
async function world(t, target = 'code_review', autoSpawn = false) {
  const dataDir = await temp(t), root = await temp(t), observations = [], starts = [];
  const actions = new PipelineActions({ notifier: async message => { observations.push(message); return { confirmed: true }; } });
  const board = new Board({ dataDir, automationActions: actions }); t.after(() => board.shutdownAutomations());
  git(root, 'init', '-q', '-b', 'trunk'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.test');
  await writeFile(join(root, 'README.md'), 'Untouched fixture\n'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'Fixture');
  const project = await board.createProject({ name: 'Arrival', workflowMode: 'pipeline' });
  await board.linkRepository(project.id, { path: root, expectedRevision: project.revision });
  await board.setTargetBranch(project.id, { branch: 'trunk', expectedRevision: 2 });
  const config = defaultPipelineConfig(); for (const column of config.columns) column.strategy.autoSpawn = false;
  const notify = (id, title) => ({ id, name: title, type: 'notify', enabled: true, title, body: '{{title}}' });
  config.columns.find(column => column.role === 'todo').automations.onExit = [notify('exit', 'Must not run')];
  const destination = config.columns.find(column => column.id === target);
  if (destination.role === 'active') Object.assign(destination.strategy, { autoSpawn, agentOverride: 'claude', permissionMode: target === 'planning' ? 'plan' : 'default' });
  if (destination.role === 'active') destination.automations.onEnter = [notify('enter', 'Arrival')];
  await board.setPipeline(project.id, { pipeline: config, expectedRevision: 3, confirm: true });
  board.executor = { validate: async ({ stage, config }) => resolveConfig(stage, config), start: async payload => { starts.push({ ...payload, observed: [...observations] }); },
    cancel: async id => board.updateRun(id, { status: 'cancelled' }), suspend: async id => board.updateRun(id, { status: 'suspended' }) };
  const owner = () => board.state().then(state => state.projects.find(row => row.id === project.id));
  const item = await board.createBacklogItem(project.id, { title: 'Exact draft', prompt: exact, priority: 3, expectedLabelRevision: 0, expectedBacklogRevision: 0 });
  const request = { column: target, expectedRevision: 1, expectedBacklogRevision: 1, expectedProjectRevision: (await owner()).revision };
  return { board, dataDir, projectId: project.id, config, item, request, owner, starts, observations };
}

test('initial manual-column arrival runs only destination automations and preserves draft identity without an agent', async t => {
  const w = await world(t), baseline = await w.board.state();
  const result = await w.board.promoteBacklogToColumn(w.projectId, w.item.id, w.request);
  assert.equal(result.arrival.status, 'completed'); assert.equal(result.task.column, 'code_review'); assert.equal(result.task.id, w.item.id);
  assert.equal(result.task.prompt, exact); assert.equal(result.task.createdAt, w.item.createdAt); assert.equal(result.task.priority, 3); assert.equal(result.task.number, 1);
  assert.deepEqual(w.observations.map(row => row.title), ['Arrival']); assert.deepEqual(w.starts, []);
  const state = await w.board.state(); assert.deepEqual(state.runs, []); assert.deepEqual(state.sessions, []); assert.deepEqual(state.projects[0].backlog, []);
  assert.equal(state.projects[0].nextTaskNumber, 2); assert.equal(state.projects[0].revision, baseline.projects[0].revision); assert.deepEqual(state.base, baseline.base);
});

test('normal board moves cannot request the private initial-arrival exemption', async t => {
  const w = await world(t), task = await w.board.createTask({ projectId: w.projectId, title: 'Normal card', prompt: exact });
  await w.board.transition(task.id, { column: 'code_review', expectedRevision: task.revision, initialArrival: true });
  assert.deepEqual(w.observations.map(row => row.title), ['Must not run', 'Arrival']);
  assert.equal((await w.owner()).backlog.length, 1, 'A normal move leaves the staged draft untouched.');
});

for (const target of ['planning', 'executing']) test(`initial ${target} arrival uses the normal fresh agent lifecycle after entry actions`, async t => {
  const w = await world(t, target, true);
  const result = await w.board.promoteBacklogToColumn(w.projectId, w.item.id, w.request);
  assert.equal(result.arrival.status, 'completed'); assert.equal(result.task.column, target); assert.equal(w.starts.length, 1);
  assert.equal(result.run.taskId, w.item.id); assert.equal(result.run.stage, target); assert.equal(result.run.config.permissionMode, target === 'planning' ? 'plan' : 'default');
  assert.deepEqual(w.starts[0].observed.map(row => row.title), ['Arrival']); assert.equal(w.starts[0].task.prompt, exact);
  assert.equal((await w.owner()).tasks.length, 1); assert.deepEqual((await w.owner()).backlog, []);
  await assert.rejects(w.board.promoteBacklogToColumn(w.projectId, w.item.id, w.request));
  assert.equal(w.starts.length, 1); assert.equal((await w.owner()).nextTaskNumber, 2);
});

test('To Do remains inert and initial Done arrival archives without inventing a session', async t => {
  for (const column of ['todo', 'done']) {
    const w = await world(t, column), result = await w.board.promoteBacklogToColumn(w.projectId, w.item.id, w.request);
    assert.equal(result.arrival.status, 'completed'); assert.equal(result.task.column, column); assert.equal(Boolean(result.task.archivedAt), column === 'done');
    if (column === 'todo') assert.equal(result.task.revision, 1);
    assert.deepEqual(w.starts, []); assert.deepEqual(w.observations, []); assert.deepEqual((await w.board.state()).sessions, []);
  }
});

test('concurrent promotion requests publish one card and grant one initial arrival', async t => {
  const w = await world(t, 'executing', true);
  const results = await Promise.allSettled([w.board.promoteBacklogToColumn(w.projectId, w.item.id, w.request), w.board.promoteBacklogToColumn(w.projectId, w.item.id, w.request)]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(results.filter(row => row.status === 'rejected').length, 1);
  assert.equal(w.starts.length, 1); assert.deepEqual(w.observations.map(row => row.title), ['Arrival']);
  const owner = await w.owner(); assert.equal(owner.tasks.length, 1); assert.equal(owner.tasks[0].id, w.item.id); assert.equal(owner.nextTaskNumber, 2); assert.deepEqual(owner.backlog, []);
});

test('a failed atomic publication keeps the draft and number and starts no destination effects', async t => {
  const w = await world(t, 'executing', true), before = await w.board.state(), original = w.board.store.path;
  const blocked = join(w.dataDir, 'blocked-target'); await mkdir(blocked); w.board.store.path = blocked;
  await assert.rejects(w.board.promoteBacklogToColumn(w.projectId, w.item.id, w.request), { code: 'STATE_WRITE_FAILED' });
  assert.deepEqual(await w.board.state(), before); assert.deepEqual(w.observations, []); assert.deepEqual(w.starts, []);
  w.board.store.path = original; assert.deepEqual(await new Store(w.dataDir).read(), before);
  const result = await w.board.promoteBacklogToColumn(w.projectId, w.item.id, w.request); assert.equal(result.arrival.status, 'completed'); assert.equal(result.task.number, 1); assert.equal(w.starts.length, 1);
});

test('invalid targets, stale configuration and stale draft/list revisions publish no task or automation', async t => {
  const w = await world(t), before = await w.board.state();
  for (const patch of [{ column: 'foreign' }, { expectedProjectRevision: 1 }, { expectedProjectRevision: undefined }, { expectedBacklogRevision: 0 }, { expectedRevision: 9 }]) {
    await assert.rejects(async () => w.board.promoteBacklogToColumn(w.projectId, w.item.id, { ...w.request, ...patch }));
    assert.deepEqual(await w.board.state(), before); assert.deepEqual(w.observations, []); assert.deepEqual(w.starts, []);
  }
  w.config.columns.find(row => row.id === 'code_review').automations.onEnter = [{ id: 'immediate', name: 'Unsupported', type: 'send_message', message: 'Do not send', mode: 'immediate' }];
  // Public editing already rejects this mode; model an older persisted definition instead.
  await w.board.store.update(state => { state.projects[0].pipeline = normalizePipelineConfig(w.config); state.projects[0].revision++; });
  const configured = await w.board.state();
  await assert.rejects(w.board.promoteBacklogToColumn(w.projectId, w.item.id, { ...w.request, expectedProjectRevision: configured.projects[0].revision }), { code: 'PIPELINE_FEATURE_PENDING' });
  assert.deepEqual(await w.board.state(), configured);
});

test('a failed native preparation reports the published card and never repeats promotion or its number', async t => {
  const w = await world(t, 'executing', true);
  w.board.executor.validate = async () => { const error = new Error('Fixture CLI unavailable'); error.code = 'AGENT_UNAVAILABLE'; throw error; };
  const result = await w.board.promoteBacklogToColumn(w.projectId, w.item.id, w.request);
  assert.equal(result.arrival.status, 'failed'); assert.equal(result.arrival.code, 'AGENT_UNAVAILABLE'); assert.equal(result.task.id, w.item.id);
  assert.equal(result.task.column, 'todo'); assert.deepEqual(w.starts, []);
  const state = await w.board.state(); assert.equal(state.projects[0].tasks.length, 1); assert.deepEqual(state.projects[0].backlog, []); assert.equal(state.projects[0].nextTaskNumber, 2);
  await assert.rejects(w.board.promoteBacklogToColumn(w.projectId, w.item.id, w.request)); assert.equal((await w.owner()).tasks.length, 1);
});

test('authenticated column promotion preserves inert fallback and rejects foreign origins', async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const project = await app.board.createProject({ name: 'HTTP arrival', workflowMode: 'pipeline' });
  const item = await app.board.createBacklogItem(project.id, { title: 'HTTP draft', expectedLabelRevision: 0, expectedBacklogRevision: 0 });
  const token = (await (await fetch(app.url + '/api/session')).json()).token;
  const input = { column: 'done', expectedRevision: 1, expectedBacklogRevision: 1, expectedProjectRevision: project.revision };
  const request = headers => fetch(`${app.url}/api/projects/${project.id}/backlog/${item.id}/promote-to-column`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-ste-token': token, ...headers }, body: JSON.stringify(input) });
  assert.equal((await request({ Origin: 'https://foreign.example' })).status, 403); assert.equal((await request({ 'x-ste-token': 'wrong' })).status, 403);
  assert.equal((await app.board.state()).projects[0].backlog.length, 1);
  const response = await request({}); assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.arrival.status, 'completed'); assert.equal(result.task.id, item.id); assert.equal(result.task.column, 'done'); assert.ok(result.task.archivedAt);
  assert.deepEqual((await app.board.state()).runs, []);
});
