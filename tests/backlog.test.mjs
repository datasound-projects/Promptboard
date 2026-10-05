import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from '../src/board.mjs';
import { Store, STATE_VERSION } from '../src/store.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const exact = '  Composer 雪\r\n{{title}}  ', labels = [{ id: 'bug', name: 'Bug', color: '#123456' }, { id: 'ui', name: 'UI', color: '#abcdef' }];
async function directory(t) { const path = await mkdtemp(join(tmpdir(), 'pb-backlog-')); t.after(() => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })); return path; }
async function world(t) {
  const dataDir = await directory(t), board = new Board({ dataDir }), project = await board.createProject({ name: 'Backlog', workflowMode: 'pipeline' });
  await board.setLabels(project.id, { labels, expectedLabelRevision: 0 });
  const forbidden = () => assert.fail('Backlog edits and To Do promotion cannot probe, signal or start agents.');
  board.executor = { start: forbidden, validate: forbidden, cancel: forbidden };
  board.messageScheduler = { ownsTask: forbidden, cancelTask: forbidden, waitTask: forbidden };
  return { board, dataDir, project, current: async () => (await board.state()).projects[0] };
}

test('backlog drafts preserve exact Composer text, labels, priority, source and independent revisions without board cards or agents', async t => {
  const w = await world(t), source = { provider: 'codex', verification: 'checks-passed' };
  const first = await w.board.createBacklogItem(w.project.id, { title: 'First', prompt: exact, source, priority: 4, labelIds: ['ui', 'bug'], expectedLabelRevision: 1, expectedBacklogRevision: 0 });
  assert.equal(first.prompt, exact); assert.deepEqual(first.labelIds, ['ui', 'bug']); assert.equal(first.priority, 4); assert.equal(first.checksOutdated, false);
  assert.equal(Object.hasOwn(first, 'column'), false); assert.equal(Object.hasOwn(first, 'number'), false); assert.equal(Object.hasOwn(first, 'sessionId'), false);
  let project = await w.current(); assert.deepEqual(project.tasks, []); assert.equal(project.revision, w.project.revision); assert.equal(project.backlogRevision, 1); assert.equal(project.nextTaskNumber, 1);
  const second = await w.board.createBacklogItem(project.id, { title: 'Second', expectedLabelRevision: 1, expectedBacklogRevision: 1 });
  assert.equal(second.prompt, ''); assert.deepEqual(second.labelIds, []);
  const changed = await w.board.updateBacklogItem(project.id, first.id, { priority: 1, expectedRevision: first.revision });
  assert.equal(changed.item.prompt, exact); assert.deepEqual(changed.item.source, first.source); assert.equal(changed.item.checksOutdated, false);
  const reordered = await w.board.reorderBacklog(project.id, { ids: [second.id, first.id], expectedBacklogRevision: 3 });
  assert.deepEqual(reordered.backlog.map(item => item.id), [second.id, first.id]); assert.deepEqual(reordered.backlog[1], changed.item);
  const before = await w.board.state(); await w.board.reorderBacklog(project.id, { ids: [second.id, first.id], expectedBacklogRevision: 4 });
  const after = await w.board.state(); assert.deepEqual(after.projects, before.projects); assert.equal(after.revision, before.revision + 1);
  const edited = await w.board.updateBacklogItem(project.id, first.id, { prompt: exact + 'edited', expectedRevision: changed.item.revision }); assert.equal(edited.item.checksOutdated, true);
  project = await w.current(); assert.equal(project.revision, w.project.revision); assert.deepEqual((await w.board.state()).runs, []); assert.deepEqual((await w.board.state()).sessions, []);
  assert.deepEqual(await new Board({ dataDir: w.dataDir }).state(), await w.board.state());
});

test('shared label rename/recolor leaves backlog drafts unchanged; removal updates only affected assignments and metadata revisions', async t => {
  const w = await world(t);
  const first = await w.board.createBacklogItem(w.project.id, { title: 'Both labels', prompt: exact, labelIds: ['ui', 'bug'], expectedLabelRevision: 1, expectedBacklogRevision: 0 });
  const second = await w.board.createBacklogItem(w.project.id, { title: 'UI only', labelIds: ['ui'], expectedLabelRevision: 1, expectedBacklogRevision: 1 });
  let project = await w.board.setLabels(w.project.id, { labels: [{ ...labels[0], name: 'Renamed', color: '#654321' }, labels[1]], expectedLabelRevision: 1 });
  assert.deepEqual(project.backlog, [first, second]); assert.equal(project.backlogRevision, 2);
  project = await w.board.setLabels(project.id, { labels: [labels[1]], expectedLabelRevision: 2 });
  assert.deepEqual(project.backlog[0].labelIds, ['ui']); assert.equal(project.backlog[0].revision, 2); assert.equal(project.backlog[0].prompt, exact);
  assert.equal(project.backlog[0].checksOutdated, false); assert.deepEqual(project.backlog[1], second); assert.equal(project.backlogRevision, 3); assert.equal(project.revision, w.project.revision);
});

test('stale, malformed, foreign and unsupported backlog requests fail atomically before changing text, order or execution', async t => {
  const w = await world(t), first = await w.board.createBacklogItem(w.project.id, { title: 'First', prompt: exact, labelIds: ['bug'], expectedLabelRevision: 1, expectedBacklogRevision: 0 });
  const other = await w.board.createProject({ name: 'Other', workflowMode: 'pipeline' });
  const legacy = await w.board.createProject({ name: 'Legacy', workflowMode: 'legacy' });
  const before = await w.board.state();
  for (const input of [{ title: '' }, { title: '\ud800' }, { prompt: '\0' }, { prompt: '\ud800' }, { priority: 99 }, { labelIds: ['foreign'] }, { labelIds: ['bug', 'bug'] }]) {
    await assert.rejects(w.board.createBacklogItem(w.project.id, { title: 'Bad', expectedLabelRevision: 1, expectedBacklogRevision: 1, ...input }));
    await assert.rejects(w.board.updateBacklogItem(w.project.id, first.id, { expectedRevision: 1, expectedLabelRevision: 1, ...input }));
  }
  await assert.rejects(w.board.createBacklogItem(w.project.id, { title: 'Stale', expectedLabelRevision: 1, expectedBacklogRevision: 0 }), { code: 'BACKLOG_REVISION_CONFLICT' });
  await assert.rejects(w.board.createBacklogItem(w.project.id, { title: 'Stale labels', expectedLabelRevision: 0, expectedBacklogRevision: 1 }), { code: 'LABEL_REVISION_CONFLICT' });
  await assert.rejects(w.board.updateBacklogItem(w.project.id, first.id, { title: 'Stale', expectedRevision: 9 }), { code: 'REVISION_CONFLICT' });
  await assert.rejects(w.board.updateBacklogItem(other.id, first.id, { title: 'Foreign', expectedRevision: 1 }), { code: 'NOT_FOUND' });
  await assert.rejects(w.board.createBacklogItem(legacy.id, { title: 'Unsupported', expectedBacklogRevision: 0, expectedLabelRevision: 0 }), { code: 'PIPELINE_SETTINGS_REQUIRED' });
  for (const ids of [[], [first.id, first.id], ['foreign'], null]) await assert.rejects(w.board.reorderBacklog(w.project.id, { ids, expectedBacklogRevision: 1 }), { code: 'INVALID_BACKLOG' });
  await assert.rejects(w.board.promoteBacklogItem(w.project.id, first.id, { expectedRevision: 1, expectedBacklogRevision: 1, column: 'executing' }), { code: 'BACKLOG_TARGET_UNSUPPORTED' });
  await assert.rejects(w.board.deleteBacklogItem(w.project.id, first.id, { expectedRevision: 1, expectedBacklogRevision: 0 }), { code: 'BACKLOG_REVISION_CONFLICT' });
  assert.deepEqual(await w.board.state(), before);
});

test('promotion atomically creates one normal To Do task, retaining identity/text/labels/priority and allocating a board number once', async t => {
  const w = await world(t);
  const composer = await w.board.createTask({ projectId: w.project.id, title: 'Composer card', prompt: exact });
  const item = await w.board.createBacklogItem(w.project.id, { title: 'Promoted', prompt: exact, priority: 4, labelIds: ['ui', 'bug'], expectedLabelRevision: 1, expectedBacklogRevision: 0 });
  const request = { expectedRevision: item.revision, expectedBacklogRevision: 1 };
  const attempts = await Promise.allSettled([w.board.promoteBacklogItem(w.project.id, item.id, request), w.board.promoteBacklogItem(w.project.id, item.id, request)]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1); assert.equal(attempts.filter(result => result.status === 'rejected').length, 1);
  const task = attempts.find(result => result.status === 'fulfilled').value;
  assert.equal(task.id, item.id); assert.equal(task.createdAt, item.createdAt); assert.equal(task.prompt, exact); assert.deepEqual(task.labelIds, item.labelIds); assert.equal(task.priority, 4);
  assert.equal(task.column, 'todo'); assert.equal(task.number, composer.number + 1); assert.equal(task.revision, 1); assert.equal(task.contentRevision, 1); assert.equal(task.workspace, null);
  const project = await w.current(); assert.deepEqual(project.backlog, []); assert.equal(project.backlogRevision, 2); assert.equal(project.revision, w.project.revision);
  assert.deepEqual(project.tasks[0], composer); assert.equal(project.tasks.length, 2); assert.equal(project.nextTaskNumber, 3);
  assert.deepEqual((await w.board.state()).runs, []); assert.deepEqual((await w.board.state()).sessions, []);
});

test('failed promotion publication retains the complete draft and task-number counter before a later explicit successful attempt', async t => {
  const w = await world(t), item = await w.board.createBacklogItem(w.project.id, { title: 'Durable', prompt: exact, expectedLabelRevision: 1, expectedBacklogRevision: 0 });
  const before = await w.board.state(), originalPath = w.board.store.path, blockedPath = join(w.dataDir, 'blocked-target');
  await mkdir(blockedPath); w.board.store.path = blockedPath;
  await assert.rejects(w.board.promoteBacklogItem(w.project.id, item.id, { expectedRevision: 1, expectedBacklogRevision: 1 }), { code: 'STATE_WRITE_FAILED' });
  assert.deepEqual(await w.board.state(), before); w.board.store.path = originalPath;
  assert.deepEqual(await new Store(w.dataDir).read(), before);
  const promoted = await w.board.promoteBacklogItem(w.project.id, item.id, { expectedRevision: 1, expectedBacklogRevision: 1 }); assert.equal(promoted.number, 1);
});

test('backlog and board capacity and safe revision limits refuse changes while preserving complete drafts and counters', async t => {
  const w = await world(t), item = await w.board.createBacklogItem(w.project.id, { title: 'Kept', expectedLabelRevision: 1, expectedBacklogRevision: 0 });
  await w.board.store.update(state => { state.projects[0].backlog = Array.from({ length: 1000 }, (_, index) => ({ ...item, id: 'backlog-' + index })); });
  let before = await w.board.state();
  await assert.rejects(w.board.createBacklogItem(w.project.id, { title: 'Over capacity', expectedLabelRevision: 1, expectedBacklogRevision: 1 }), { code: 'LIMIT' });
  assert.deepEqual(await w.board.state(), before);
  const sample = await w.board.createTask({ projectId: w.project.id, title: 'Normal' });
  await w.board.store.update(state => { const project = state.projects[0]; project.tasks = Array.from({ length: 1000 }, (_, index) => ({ ...sample, id: 'task-' + index, number: index + 1 })); project.nextTaskNumber = 1001; });
  before = await w.board.state();
  await assert.rejects(w.board.promoteBacklogItem(w.project.id, 'backlog-0', { expectedRevision: 1, expectedBacklogRevision: 1 }), { code: 'LIMIT' });
  assert.deepEqual(await w.board.state(), before);
  await w.board.store.update(state => { const project = state.projects[0]; project.backlog[0].revision = Number.MAX_SAFE_INTEGER; });
  before = await w.board.state();
  await assert.rejects(w.board.updateBacklogItem(w.project.id, 'backlog-0', { title: 'Changed', expectedRevision: Number.MAX_SAFE_INTEGER }), { code: 'LIMIT' });
  assert.deepEqual(await w.board.state(), before);
  await w.board.store.update(state => { state.projects[0].backlogRevision = Number.MAX_SAFE_INTEGER; });
  before = await w.board.state();
  await assert.rejects(w.board.deleteBacklogItem(w.project.id, 'backlog-1', { expectedRevision: 1, expectedBacklogRevision: Number.MAX_SAFE_INTEGER }), { code: 'LIMIT' });
  assert.deepEqual(await w.board.state(), before);
});

test('portable backlog metadata round-trips inertly; injected execution fields, duplicate identities and malformed imports reject without publication', async t => {
  const w = await world(t), item = await w.board.createBacklogItem(w.project.id, { title: 'Backup', prompt: exact, labelIds: ['bug'], expectedLabelRevision: 1, expectedBacklogRevision: 0 });
  await w.board.createTask({ projectId: w.project.id, title: 'Board card', prompt: exact });
  const backup = await w.board.exportBackup(); assert.equal(backup.version, 10); assert.deepEqual(backup.projects[0].backlog, [item]);
  const imported = new Board({ dataDir: await directory(t) }); await imported.importBackup(backup);
  const before = await imported.state(); assert.deepEqual(before.projects[0].backlog, [item]); assert.equal(before.projects[0].backlogRevision, 0);
  assert.deepEqual(before.runs, []); assert.deepEqual(before.sessions, []);
  for (const change of [data => { delete data.projects[0].backlog; }, data => { data.projects[0].backlog[0].labelIds = ['foreign']; },
    data => { data.projects[0].backlog[0].sessionId = 'injected'; }, data => { data.projects[0].backlog[0].id = data.projects[0].tasks[0].id; },
    data => { data.projects[0].backlog[0].revision = 0; }, data => { data.projects[0].backlog[0].prompt = '\ud800'; }]) {
    const invalid = structuredClone(backup); change(invalid); await assert.rejects(imported.importBackup(invalid, { replace: true }), { code: 'INVALID_BACKUP' }); assert.deepEqual(await imported.state(), before);
  }
  const old = structuredClone(backup); old.version = 8;
  const older = new Board({ dataDir: await directory(t) }); await older.importBackup(old);
  assert.deepEqual((await older.state()).projects[0].backlog, []); assert.deepEqual((await older.state()).projects[0].tasks[0].labelIds, backup.projects[0].tasks[0].labelIds);
  const migration = new Board({ dataDir: await directory(t) }), empty = await migration.state();
  await assert.rejects(migration.migrateBrowserBoard(backup), { code: 'INVALID_BACKUP' }); assert.deepEqual(await migration.state(), empty, 'Legacy browser migration must not silently drop version 9 backlog data.');
});

test('v10 migration keeps existing labels, exact prompts, Base and native state with an exact original backup; future versions stay untouched', async t => {
  const w = await world(t), task = await w.board.createTask({ projectId: w.project.id, title: 'Exact', prompt: exact, labelIds: ['bug'], expectedLabelRevision: 1 });
  const saved = await w.board.state(); saved.version = 10;
  for (const project of saved.projects) { delete project.backlog; delete project.backlogRevision; }
  saved.privateExtension = { exact: 'retained' }; saved.runs.push({ id: 'retained-run', taskId: task.id, providerSessionId: 'native-fixture', status: 'suspended' });
  const dir = await directory(t), bytes = JSON.stringify(saved, null, 2); await writeFile(join(dir, 'state.json'), bytes);
  const store = new Store(dir), migrated = await store.read();
  assert.equal(migrated.version, 13); assert.equal(STATE_VERSION, 13);
  assert.deepEqual(migrated.projects, saved.projects.map(project => ({ ...project, backlog: [], backlogRevision: 0 })));
  assert.deepEqual(migrated.runs, saved.runs); assert.deepEqual(migrated.sessions, saved.sessions); assert.deepEqual(migrated.base, saved.base); assert.deepEqual(migrated.privateExtension, saved.privateExtension);
  assert.equal(await readFile(join(dir, store.recovery.migrationBackup), 'utf8'), bytes);
  const futureDir = await directory(t), future = JSON.stringify({ ...saved, version: STATE_VERSION + 1 }); await writeFile(join(futureDir, 'state.json'), future);
  await assert.rejects(new Store(futureDir).read(), { code: 'STATE_VERSION_UNSUPPORTED' }); assert.equal(await readFile(join(futureDir, 'state.json'), 'utf8'), future);
});

test('backlog HTTP authoring is project-scoped and requires the local token/origin; promotion preserves exact text without a run', async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] }), project = await app.board.createProject({ name: 'HTTP backlog', workflowMode: 'pipeline' });
  const token = (await (await fetch(app.url + '/api/session')).json()).token;
  const path = `/api/projects/${project.id}/backlog`, input = { title: 'HTTP exact', prompt: exact, expectedLabelRevision: 0, expectedBacklogRevision: 0 };
  const request = (suffix, method, body, headers = {}) => fetch(app.url + path + suffix, { method, headers: { 'Content-Type': 'application/json', 'x-ste-token': token, ...headers }, body: JSON.stringify(body) });
  assert.equal((await request('', 'POST', input, { 'x-ste-token': 'invalid' })).status, 403);
  assert.equal((await request('', 'POST', input, { Origin: 'https://untrusted.example' })).status, 403);
  const created = await request('', 'POST', input); assert.equal(created.status, 200); const { item } = await created.json(); assert.equal(item.prompt, exact);
  const update = await request('/' + item.id, 'PATCH', { priority: 4, expectedRevision: 1 }); assert.equal(update.status, 200);
  const promoted = await request('/' + item.id + '/promote', 'POST', { expectedRevision: 2, expectedBacklogRevision: 2 }); assert.equal(promoted.status, 200);
  const { task, board } = await promoted.json(); assert.equal(task.prompt, exact); assert.equal(task.priority, 4); assert.equal(task.column, 'todo'); assert.deepEqual(board.runs, []); assert.deepEqual(board.sessions, []);
});
