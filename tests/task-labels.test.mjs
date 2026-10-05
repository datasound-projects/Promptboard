import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Board } from '../src/board.mjs';
import { Store, emptyState, STATE_VERSION } from '../src/store.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const catalog = [{ id: 'bug', name: 'Bug 雪', color: '#C93451' }, { id: 'ui', name: '<frontend>', color: '#4585aa' }];
async function directory(t) { const dir = await mkdtemp(join(tmpdir(), 'pb-labels-')); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })); return dir; }
async function world(t) {
  const dataDir = await directory(t), board = new Board({ dataDir }), project = await board.createProject({ name: 'Labels', workflowMode: 'pipeline' });
  board.executor = { start() { assert.fail('Labels cannot start agents.'); }, validate() { assert.fail('Labels cannot probe providers.'); }, cancel() { assert.fail('Labels cannot signal agents.'); } };
  board.messageScheduler = { ownsTask: () => true, cancelTask() { assert.fail('Labels cannot cancel messages.'); }, waitTask() { assert.fail('No input cancellation was granted.'); } };
  return { board, dataDir, project };
}

test('shared label names and colors are inert metadata; creation, edits, copies and reopening retain exact prompt and order', async t => {
  const { board, dataDir, project } = await world(t), prompt = '  Engineered 雪\r\n{{title}}  ';
  const first = await board.createTask({ projectId: project.id, title: 'Composer', prompt, source: { provider: 'codex', verification: 'checks-passed' } });
  assert.deepEqual(first.labelIds, []); assert.equal(first.column, 'todo');
  const labeledProject = await board.setLabels(project.id, { labels: catalog, expectedLabelRevision: 0 });
  assert.equal(labeledProject.revision, project.revision); assert.equal(labeledProject.labelRevision, 1);
  assert.equal(labeledProject.labels[0].color, '#c93451');
  const second = await board.createTask({ projectId: project.id, title: 'Labeled', labelIds: ['ui', 'bug'], expectedLabelRevision: 1 });
  assert.deepEqual(second.labelIds, ['ui', 'bug']);
  const result = await board.updateTask(first.id, { labelIds: ['bug'], expectedLabelRevision: 1, expectedRevision: 1 });
  assert.equal(result.task.revision, 2); assert.equal(result.task.contentRevision, 1); assert.equal(result.task.prompt, prompt);
  assert.deepEqual(result.task.source, first.source); assert.equal(result.task.checksOutdated, false);
  const before = await board.state(), configRevision = before.projects[0].revision;
  const recolored = await board.setLabels(project.id, { labels: [{ ...catalog[0], name: 'Fix', color: '#abcdef' }, catalog[1]], expectedLabelRevision: 1 });
  assert.equal(recolored.revision, configRevision); assert.deepEqual(recolored.tasks, before.projects[0].tasks);
  const noop = await board.updateTask(first.id, { labelIds: ['bug'], expectedLabelRevision: 2, expectedRevision: 2 }); assert.equal(noop.changed, false);
  const copy = await board.duplicateTask(first.id); assert.deepEqual(copy.labelIds, ['bug']); assert.equal(copy.prompt, prompt); assert.equal(copy.workspace, null);
  const state = await board.state(); assert.deepEqual(state.projects[0].tasks.map(row => row.id), [first.id, copy.id, second.id]);
  assert.deepEqual(state.runs, []); assert.deepEqual(state.sessions, []); assert.deepEqual(await new Board({ dataDir }).state(), state);
});

test('removing a shared label removes only its assignments with card revisions and retains content and configuration', async t => {
  const { board, project } = await world(t); await board.setLabels(project.id, { labels: catalog, expectedLabelRevision: 0 });
  const first = await board.createTask({ projectId: project.id, title: 'Both', prompt: 'Exact', labelIds: ['bug', 'ui'], expectedLabelRevision: 1 });
  const second = await board.createTask({ projectId: project.id, title: 'Untouched', labelIds: ['ui'], expectedLabelRevision: 1 });
  const updated = await board.setLabels(project.id, { labels: [catalog[1]], expectedLabelRevision: 1 });
  assert.equal(updated.revision, project.revision); assert.deepEqual(updated.tasks[0].labelIds, ['ui']); assert.equal(updated.tasks[0].revision, 2);
  assert.equal(updated.tasks[0].prompt, first.prompt); assert.equal(updated.tasks[0].contentRevision, 1); assert.deepEqual(updated.tasks[1], second);
  const before = await board.state(); await board.setLabels(project.id, { labels: [catalog[1]], expectedLabelRevision: 2 });
  const after = await board.state(); assert.deepEqual(after.projects, before.projects); assert.deepEqual(after.runs, before.runs); assert.deepEqual(after.sessions, before.sessions);
  assert.equal(after.revision, before.revision + 1, 'The Store still publishes its existing successful update revision.');
});

test('malformed, duplicate, cross-project and stale label edits reject before state, delivery or prompt changes', async t => {
  const { board, project } = await world(t); await board.setLabels(project.id, { labels: catalog, expectedLabelRevision: 0 });
  const task = await board.createTask({ projectId: project.id, title: 'Original', prompt: ' Exact ' }), before = await board.state();
  for (const labels of [null, {}, [null], [{ ...catalog[0], color: 'url(http://bad)' }], [{ ...catalog[0], name: '\ud800' }], [{ ...catalog[0], id: '../bad' }],
    [{ ...catalog[0], name: ' ' }], [{ ...catalog[0], name: 'a\n' }], [catalog[0], catalog[0]], [catalog[0], { ...catalog[1], name: 'BUG 雪' }], Array.from({ length: 101 }, (_, i) => ({ id: 'l' + i, name: String(i), color: '#123456' }))]) {
    await assert.rejects(board.setLabels(project.id, { labels, expectedLabelRevision: 1 }), { code: 'INVALID_TASK_LABELS' });
  }
  for (const labelIds of [null, 'bug', ['foreign'], ['bug', 'bug'], ['../bad'], Array.from({ length: 21 }, (_, i) => 'l' + i)]) {
    await assert.rejects(board.createTask({ projectId: project.id, title: 'Bad', labelIds, expectedLabelRevision: 1 }), { code: 'INVALID_TASK_LABELS' });
    await assert.rejects(board.updateTask(task.id, { prompt: 'Changed', labelIds, expectedLabelRevision: 1, expectedRevision: 1 }), { code: 'INVALID_TASK_LABELS' });
  }
  await assert.rejects(board.setLabels(project.id, { labels: [], expectedLabelRevision: 0 }), { code: 'LABEL_REVISION_CONFLICT' });
  await assert.rejects(board.updateTask(task.id, { labelIds: ['bug'], expectedLabelRevision: 0, expectedRevision: 1 }), { code: 'LABEL_REVISION_CONFLICT' });
  await assert.rejects(board.updateTask(task.id, { labelIds: ['bug'], expectedLabelRevision: 1, expectedRevision: 9 }), { code: 'REVISION_CONFLICT' });
  assert.deepEqual(await board.state(), before);
  const other = await board.createProject({ name: 'Other', workflowMode: 'pipeline' });
  await assert.rejects(board.createTask({ projectId: other.id, title: 'Foreign', labelIds: ['bug'], expectedLabelRevision: 0 }), { code: 'INVALID_TASK_LABELS' });
});

test('portable label metadata round-trips without execution and malformed imports remain atomic; old backups have no labels', async t => {
  const { board, project } = await world(t); await board.setLabels(project.id, { labels: catalog, expectedLabelRevision: 0 });
  const task = await board.createTask({ projectId: project.id, title: 'Imported', prompt: '  Exact\r\n雪', labelIds: ['ui', 'bug'], expectedLabelRevision: 1 });
  const backup = await board.exportBackup(); assert.equal(backup.version, 10);
  const imported = new Board({ dataDir: await directory(t) }); await imported.importBackup(backup);
  const state = await imported.state(); assert.deepEqual(state.projects[0].labels, backup.projects[0].labels);
  assert.deepEqual(state.projects[0].tasks[0].labelIds, task.labelIds); assert.equal(state.projects[0].tasks[0].prompt, task.prompt);
  assert.deepEqual(state.runs, []); assert.deepEqual(state.sessions, []);
  for (const change of [data => { data.projects[0].tasks[0].labelIds = ['missing']; }, data => { delete data.projects[0].labels; },
    data => { data.projects[0].labels[0].color = 'red'; }, data => { data.projects[0].labels.push(data.projects[0].labels[0]); }]) {
    const bad = structuredClone(backup); change(bad);
    await assert.rejects(imported.importBackup(bad, { replace: true }), { code: 'INVALID_BACKUP' }); assert.deepEqual(await imported.state(), state);
  }
  const old = structuredClone(backup); old.version = 7;
  const older = new Board({ dataDir: await directory(t) }); await older.importBackup(old);
  assert.deepEqual((await older.state()).projects[0].labels, []); assert.deepEqual((await older.state()).projects[0].tasks[0].labelIds, []);
  const migrated = new Board({ dataDir: await directory(t) }); await migrated.migrateBrowserBoard(backup);
  assert.deepEqual((await migrated.state()).projects[0].labels, backup.projects[0].labels);
  assert.deepEqual((await migrated.state()).projects[0].tasks[0].labelIds, task.labelIds);
  const repeated = await migrated.migrateBrowserBoard(backup); assert.equal(repeated.cards, 0); assert.equal(repeated.skipped, 1);
  const before = await migrated.state(), conflicting = structuredClone(backup); conflicting.projects[0].labels[0].color = '#123456';
  await assert.rejects(migrated.migrateBrowserBoard(conflicting), { code: 'LABEL_REVISION_CONFLICT' }); assert.deepEqual(await migrated.state(), before);
});

test('manual active moves, archive and restore retain labels without creating agent instructions', async t => {
  const { board, project } = await world(t), pipeline = structuredClone(project.pipeline); board.messageScheduler = null;
  for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  await board.setPipeline(project.id, { pipeline, expectedRevision: project.revision, confirm: true });
  await board.setLabels(project.id, { labels: catalog, expectedLabelRevision: 0 });
  let task = await board.createTask({ projectId: project.id, title: 'Labeled task', prompt: '  Exact\r\n', labelIds: ['bug', 'ui'], expectedLabelRevision: 1 });
  for (const column of ['executing', 'done', 'code_review', 'todo']) {
    task = (await board.transition(task.id, { column, expectedRevision: task.revision })).task;
    assert.deepEqual(task.labelIds, ['bug', 'ui']); assert.equal(task.prompt, '  Exact\r\n'); assert.equal(task.contentRevision, 1);
  }
  assert.deepEqual((await board.state()).runs, []); assert.deepEqual((await board.state()).sessions, []);
});

test('version 9 migration adds only empty label metadata and keeps exact original bytes and native references', async t => {
  const dir = await directory(t), original = { ...emptyState(), version: 9, revision: 44, extension: { retain: true }, projects: [{ id: 'p', nextTaskNumber: 3,
    tasks: [{ id: 't', number: 2, priority: 4, prompt: ' Exact\r\n雪 ', revision: 5, contentRevision: 2, nativeReference: 'preserved',
      pendingAutomationMessages: [{ projectId: 'p', taskId: 't', transitionId: 'owned' }] }] }] };
  const bytes = JSON.stringify(original, null, 2); await writeFile(join(dir, 'state.json'), bytes);
  const store = new Store(dir), state = await store.read(); assert.equal(state.version, STATE_VERSION); assert.equal(state.revision, original.revision);
  assert.deepEqual(state.projects, original.projects.map(project => ({ ...project, labels: [], labelRevision: 0, backlog: [], backlogRevision: 0, backlogSources: [], backlogImported: [], backlogImportRevision: 0, tasks: project.tasks.map(task => ({ ...task, labelIds: [] })) })));
  assert.deepEqual(state.extension, original.extension); assert.deepEqual(state.migrations.map(row => row.kind), ['state-v9-to-v10', 'state-v10-to-v11', 'state-v11-to-v12', 'state-v12-to-v13']);
  assert.equal(await readFile(join(dir, store.recovery.migrationBackup), 'utf8'), bytes); assert.deepEqual(await new Store(dir).read(), state);
  const futureDir = await directory(t), future = JSON.stringify({ ...original, version: 14 }); await writeFile(join(futureDir, 'state.json'), future);
  await assert.rejects(new Store(futureDir).read(), { code: 'STATE_VERSION_UNSUPPORTED' }); assert.equal(await readFile(join(futureDir, 'state.json'), 'utf8'), future);
});

test('authenticated label catalog and card HTTP edits bind catalog and task revisions without starting agents', async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] }), project = await app.board.createProject({ name: 'HTTP labels', workflowMode: 'pipeline' });
  const { token } = await (await fetch(app.url + '/api/session')).json();
  const call = (method, path, body, auth = token) => fetch(app.url + path, { method, headers: { 'Content-Type': 'application/json', 'X-STE-Token': auth, Origin: app.url }, body: JSON.stringify(body) });
  assert.equal((await call('PATCH', '/api/projects/' + project.id + '/labels', { labels: catalog, expectedLabelRevision: 0 }, 'bad')).status, 403);
  assert.equal((await call('PATCH', '/api/projects/' + project.id + '/labels', { labels: catalog, expectedLabelRevision: 0 })).status, 200);
  const response = await call('POST', '/api/tasks', { projectId: project.id, title: 'Labeled', labelIds: ['bug'], expectedLabelRevision: 1 }); assert.equal(response.status, 200);
  const { task } = await response.json(); assert.deepEqual(task.labelIds, ['bug']);
  assert.equal((await call('PATCH', '/api/tasks/' + task.id, { labelIds: ['ui'], expectedLabelRevision: 1, expectedRevision: 1 })).status, 200);
  assert.equal((await call('PATCH', '/api/projects/' + project.id + '/labels', { labels: [], expectedLabelRevision: 0 })).status, 409);
  assert.equal((await call('PATCH', '/api/tasks/' + task.id, { labelIds: ['foreign'], expectedLabelRevision: 1, expectedRevision: 2 })).status, 400);
  assert.deepEqual((await app.board.state()).runs, []);
});
