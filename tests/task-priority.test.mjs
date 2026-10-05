import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Board } from '../src/board.mjs';
import { Store, emptyState } from '../src/store.mjs';
import { startTestServer } from './helpers/test-server.mjs';

async function directory(t) { const dir = await mkdtemp(join(tmpdir(), 'pb-priority-')); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })); return dir; }
async function world(t) {
  const dataDir = await directory(t), board = new Board({ dataDir }), project = await board.createProject({ name: 'Priority', workflowMode: 'pipeline' });
  board.executor = { start() { assert.fail('Metadata cannot start agents.'); }, validate() { assert.fail('Metadata cannot probe providers.'); }, cancel() { assert.fail('Metadata cannot signal agents.'); } };
  return { board, dataDir, project };
}

test('priority is inert metadata: Composer defaults, all levels, exact prompts, checks, copies and saved order', async t => {
  const { board, dataDir, project } = await world(t), prompt = '  Engineered 🐕\r\n{{title}}  ', source = { provider: 'codex', verification: 'checks-passed', quality: 'reviewed' };
  const first = await board.createTask({ projectId: project.id, title: 'Composer', prompt, source });
  assert.equal(first.priority, 0); assert.equal(first.column, 'todo');
  const ids = [first.id];
  for (const priority of [1, 2, 3, 4]) { const card = await board.createTask({ projectId: project.id, title: `Level ${priority}`, priority }); assert.equal(card.priority, priority); ids.push(card.id); }
  const changed = await board.updateTask(first.id, { priority: 4, expectedRevision: first.revision });
  assert.equal(changed.changed, true); assert.equal(changed.task.priority, 4); assert.equal(changed.task.revision, 2);
  assert.equal(changed.task.contentRevision, first.contentRevision); assert.equal(changed.task.checksOutdated, false);
  assert.equal(changed.task.prompt, prompt); assert.deepEqual(changed.task.source, first.source);
  assert.deepEqual((await board.state()).projects[0].tasks.map(task => task.id), ids);
  const noop = await board.updateTask(first.id, { priority: 4, expectedRevision: 2 }); assert.equal(noop.changed, false); assert.equal(noop.task.revision, 2);
  const copy = await board.duplicateTask(first.id); assert.equal(copy.priority, 4); assert.equal(copy.prompt, prompt); assert.equal(copy.column, 'todo'); assert.equal(copy.workspace, null);
  const state = await board.state(); assert.deepEqual(state.runs, []); assert.deepEqual(state.sessions, []);
  assert.deepEqual((await new Board({ dataDir }).state()).projects[0].tasks, state.projects[0].tasks);
  await assert.rejects(board.updateTask(first.id, { priority: 1, expectedRevision: 1 }), { code: 'REVISION_CONFLICT' });
  assert.deepEqual(await board.state(), state);
});

test('invalid priorities reject create, edit and portable import without state changes; current backups retain every level', async t => {
  const { board, project } = await world(t);
  for (const priority of [0, 1, 2, 3, 4]) await board.createTask({ projectId: project.id, title: `Level ${priority}`, priority });
  const state = await board.state(), task = state.projects[0].tasks[0];
  for (const priority of [null, -1, 5, 1.5, '4', {}, [], true]) {
    await assert.rejects(board.createTask({ projectId: project.id, title: 'Invalid', priority }), { code: 'INVALID_TASK_PRIORITY' });
    await assert.rejects(board.updateTask(task.id, { priority, expectedRevision: task.revision }), { code: 'INVALID_TASK_PRIORITY' });
  }
  assert.deepEqual(await board.state(), state);
  const backup = await board.exportBackup(); assert.equal(backup.version, 10);
  const imported = new Board({ dataDir: await directory(t) }); await imported.importBackup(backup);
  const restored = await imported.state(); assert.deepEqual(restored.projects[0].tasks.map(row => row.priority), [0, 1, 2, 3, 4]); assert.deepEqual(restored.runs, []);
  const bad = structuredClone(backup); bad.projects[0].tasks[0].priority = 'urgent';
  await assert.rejects(imported.importBackup(bad, { replace: true }), { code: 'INVALID_BACKUP' }); assert.deepEqual(await imported.state(), restored);
  const older = structuredClone(backup); older.version = 6;
  const olderBoard = new Board({ dataDir: await directory(t) }); await olderBoard.importBackup(older);
  assert.deepEqual((await olderBoard.state()).projects[0].tasks.map(row => row.priority), [0, 0, 0, 0, 0]);
});

test('version 8 migration adds None without altering task identities, revisions, native references or exact original backup', async t => {
  const dir = await directory(t), original = { ...emptyState(), version: 8, revision: 33, extension: { keep: true }, projects: [{ id: 'p', nextTaskNumber: 12,
    tasks: [{ id: 't', number: 11, prompt: '  Exact\r\n雪', revision: 7, contentRevision: 4, column: 'todo', extension: { retained: true },
      pendingAutomationMessages: [{ projectId: 'p', taskId: 't', transitionId: 'owned' }] }] }] };
  const bytes = JSON.stringify(original, null, 2); await writeFile(join(dir, 'state.json'), bytes);
  const store = new Store(dir), saved = await store.read(); assert.equal(saved.version, 12); assert.equal(saved.revision, 33);
  assert.deepEqual(saved.projects, original.projects.map(project => ({ ...project, labels: [], labelRevision: 0, backlog: [], backlogRevision: 0, backlogSources: [], backlogImported: [], backlogImportRevision: 0, tasks: project.tasks.map(task => ({ ...task, priority: 0, labelIds: [] })) })));
  assert.deepEqual(saved.extension, original.extension); assert.deepEqual(saved.migrations.map(row => row.kind), ['state-v8-to-v9', 'state-v9-to-v10', 'state-v10-to-v11', 'state-v11-to-v12']);
  assert.equal(await readFile(join(dir, store.recovery.migrationBackup), 'utf8'), bytes);
  assert.deepEqual(await new Store(dir).read(), saved);
  const newer = JSON.stringify({ ...original, version: 13 }); const futureDir = await directory(t); await writeFile(join(futureDir, 'state.json'), newer);
  await assert.rejects(new Store(futureDir).read(), { code: 'STATE_VERSION_UNSUPPORTED' }); assert.equal(await readFile(join(futureDir, 'state.json'), 'utf8'), newer);
});

test('authenticated HTTP priority authoring advertises support and rejects unauthorized or malformed metadata', async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const project = await app.board.createProject({ name: 'HTTP priority', workflowMode: 'pipeline' });
  const { token, capabilities } = await (await fetch(app.url + '/api/session')).json(); assert.equal(capabilities.taskPriority, true);
  const call = (method, path, data, supplied = token) => fetch(app.url + path, { method, headers: { 'Content-Type': 'application/json', 'X-STE-Token': supplied, Origin: app.url }, body: JSON.stringify(data) });
  const request = { projectId: project.id, title: 'Urgent', priority: 4 };
  assert.equal((await call('POST', '/api/tasks', request, 'wrong')).status, 403);
  const response = await call('POST', '/api/tasks', request); assert.equal(response.status, 200); const { task } = await response.json(); assert.equal(task.priority, 4); assert.equal(task.prompt, '');
  assert.equal((await call('PATCH', '/api/tasks/' + task.id, { priority: 1, expectedRevision: task.revision })).status, 200);
  assert.equal((await call('POST', '/api/tasks', { ...request, priority: 'urgent' })).status, 400);
  assert.deepEqual((await app.board.state()).runs, []);
});

test('common manual column moves, archive and restore retain priority without turning metadata into task text', async t => {
  const { board, project } = await world(t), pipeline = structuredClone(project.pipeline);
  for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  await board.setPipeline(project.id, { pipeline, expectedRevision: project.revision, confirm: true });
  const task = await board.createTask({ projectId: project.id, title: 'Retained urgent task', prompt: '  Exact\r\n', priority: 4 });
  let current = task;
  for (const column of ['executing', 'done', 'code_review', 'todo']) {
    current = (await board.transition(task.id, { column, expectedRevision: current.revision })).task;
    assert.equal(current.priority, 4); assert.equal(current.prompt, task.prompt); assert.equal(current.contentRevision, 1);
  }
  assert.deepEqual((await board.state()).runs, []);
  board.messageScheduler = { ownsTask: () => true, cancelTask: () => assert.fail('Invalid priority cannot cancel live delivery.'), waitTask: () => assert.fail('No cancellation was granted.') };
  await assert.rejects(board.updateTask(task.id, { prompt: 'Changed body', priority: 'urgent', expectedRevision: current.revision }), { code: 'INVALID_TASK_PRIORITY' });
  board.messageScheduler = null;
  assert.equal((await board.state()).projects[0].tasks[0].prompt, task.prompt);
});
