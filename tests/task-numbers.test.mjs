import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board, parseBackup } from '../src/board.mjs';
import { Store, emptyState } from '../src/store.mjs';
import { defaultPipelineConfig } from '../src/pipeline-config.mjs';

async function world(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-numbers-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const board = new Board({ dataDir, executor: { start() { assert.fail('Numbering must not launch agents.'); } } });
  return { dataDir, board };
}
const create = (board, projectId, title = 'Exact task') => board.createTask({ projectId, title, prompt: '  Original\r\n雪\n' });

test('concurrent Composer births, duplicates and deletion use durable project-local numbers without reuse', async t => {
  const { board, dataDir } = await world(t), project = await board.createProject({ name: 'One' });
  const tasks = await Promise.all(Array.from({ length: 20 }, (_, index) => create(board, project.id, `Task ${index}`)));
  assert.deepEqual(tasks.map(task => task.number), Array.from({ length: 20 }, (_, index) => index + 1));
  assert.ok(tasks.every(task => task.column === 'todo' && task.prompt === '  Original\r\n雪\n' && !task.workspace));
  const duplicate = await board.duplicateTask(tasks[0].id); assert.equal(duplicate.number, 21); assert.equal(duplicate.prompt, tasks[0].prompt);
  await board.deleteTask(duplicate.id, { expectedRevision: duplicate.revision });
  const restarted = new Board({ dataDir }), next = await create(restarted, project.id); assert.equal(next.number, 22);
  const other = await restarted.createProject({ name: 'Two' }); assert.equal((await create(restarted, other.id)).number, 1);
  assert.equal((await restarted.state()).runs.length, 0);
});

test('rename, reorder, archive and restore retain number; rejected creation consumes none', async t => {
  const { board } = await world(t), project = await board.createProject({ name: 'Pipeline' }), pipeline = defaultPipelineConfig();
  for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  await board.setPipeline(project.id, { pipeline, expectedRevision: project.revision, confirm: true });
  const task = await create(board, project.id);
  await assert.rejects(board.createTask({ projectId: project.id, title: '', prompt: 'Invalid' }), { code: 'INVALID_INPUT' });
  await board.updateTask(task.id, { title: 'Renamed', expectedRevision: task.revision });
  let current = (await board.state()).projects[0].tasks[0];
  await board.transition(task.id, { column: 'done', expectedRevision: current.revision, transitionId: 'archive-number' });
  current = (await board.state()).projects[0].tasks[0]; assert.equal(current.number, 1); assert.ok(current.archivedAt);
  await board.transition(task.id, { column: 'executing', expectedRevision: current.revision, transitionId: 'restore-number' });
  current = (await board.state()).projects[0].tasks[0]; assert.equal(current.number, 1); assert.equal(current.archivedAt, undefined);
  await board.transition(task.id, { column: 'executing', index: 0, expectedRevision: current.revision, transitionId: 'reorder-number' });
  assert.equal((await board.state()).projects[0].tasks[0].number, 1);
  assert.equal((await create(board, project.id)).number, 2); assert.equal((await board.state()).runs.length, 0);
});

test('v6 state migration assigns saved order once, preserves exact original backup and all ownership metadata', async t => {
  const { dataDir } = await world(t), state = { ...emptyState(), version: 6, revision: 19,
    projects: [{ id: 'project', name: 'Existing', tasks: [
      { id: 'later-created', createdAt: 200, prompt: '  CRLF\r\n', column: 'todo', revision: 9, baseBinding: { fixture: true } },
      { id: 'earlier-created', createdAt: 100, prompt: '雪', column: 'done', archivedAt: 300, sessionId: 'session', workspace: { fixture: true } }
    ] }], extension: { retain: true } };
  const bytes = JSON.stringify(state, null, 3); await writeFile(join(dataDir, 'state.json'), bytes);
  const store = new Store(dataDir), saved = await store.read();
  assert.equal(saved.version, 13); assert.equal(saved.revision, 19); assert.equal(saved.projects[0].nextTaskNumber, 3);
  for (let index = 0; index < 2; index++) assert.deepEqual(saved.projects[0].tasks[index], { ...state.projects[0].tasks[index], number: index + 1, priority: 0, labelIds: [] });
  assert.deepEqual(saved.extension, state.extension); assert.equal(await readFile(join(dataDir, store.recovery.migrationBackup), 'utf8'), bytes);
  assert.deepEqual(await new Store(dataDir).read(), saved);
});

test('portable v7 backup preserves gaps and deletion counter; older backups assign order and imports remain inert', async t => {
  const { board } = await world(t), project = await board.createProject({ name: 'Source' });
  const a = await create(board, project.id), b = await create(board, project.id); await board.deleteTask(b.id, { expectedRevision: b.revision });
  const backup = await board.exportBackup(); assert.equal(backup.version, 10); assert.equal(backup.projects[0].nextTaskNumber, 3);
  const { board: target } = await world(t); await target.importBackup(backup);
  assert.equal((await target.state()).projects[0].tasks[0].number, a.number); assert.equal((await create(target, project.id)).number, 3);
  const old = structuredClone(backup); old.version = 3; delete old.projects[0].nextTaskNumber; delete old.projects[0].tasks[0].number;
  assert.equal(parseBackup(old).projects[0].tasks[0].number, 1);
  const { board: legacy } = await world(t); await legacy.importBackup(old); assert.equal((await create(legacy, project.id)).number, 2);
  assert.equal((await target.state()).runs.length, 0);
});

test('malformed portable task numbers fail atomically instead of renumbering saved identities', async t => {
  const { board } = await world(t), project = await board.createProject({ name: 'Source' }); await create(board, project.id); await create(board, project.id);
  const backup = await board.exportBackup(), { board: target } = await world(t), before = structuredClone(await target.state());
  const mutations = [p => { p.tasks[1].number = 1; }, p => { p.tasks[0].number = 0; }, p => { p.tasks[0].number = '1'; },
    p => { delete p.tasks[0].number; }, p => { p.nextTaskNumber = 2; }, p => { delete p.nextTaskNumber; }, p => { p.nextTaskNumber = Number.MAX_SAFE_INTEGER + 1; }];
  for (const mutate of mutations) {
    const invalid = structuredClone(backup); mutate(invalid.projects[0]);
    await assert.rejects(target.importBackup(invalid), { code: 'INVALID_BACKUP' }); assert.deepEqual(await target.state(), before);
  }
});

test('browser migration numbers only new identities, retains deduplication and never recycles deleted numbers', async t => {
  const { board } = await world(t), project = await board.createProject({ name: 'Existing' }), first = await create(board, project.id);
  const old = { version: 1, projects: [{ id: project.id, name: 'Existing', cards: [
    { id: first.id, title: 'Duplicate', prompt: 'Ignored' }, { id: 'browser-task', title: 'Browser', prompt: ' Exact\r\n' }
  ] }] };
  assert.deepEqual(await board.migrateBrowserBoard(old), { projects: 0, cards: 1, skipped: 1 });
  const tasks = (await board.state()).projects[0].tasks; assert.deepEqual(tasks.map(task => task.number), [1, 2]); assert.equal(tasks[1].prompt, ' Exact\r\n');
  assert.deepEqual(await board.migrateBrowserBoard(old), { projects: 0, cards: 0, skipped: 2 });
  assert.equal((await create(board, project.id)).number, 3);
});

test('a failed atomic store publication cannot consume a number or change the saved task list', async t => {
  const { board, dataDir } = await world(t), project = await board.createProject({ name: 'Atomic' }); await create(board, project.id);
  const before = structuredClone(await board.state()), bytes = await readFile(join(dataDir, 'state.json'), 'utf8');
  const backupPath = join(dataDir, 'state.json.bak'); await rm(backupPath); await mkdir(backupPath);
  await assert.rejects(create(board, project.id), { code: 'STATE_WRITE_FAILED' });
  assert.deepEqual(await board.state(), before); assert.equal(await readFile(join(dataDir, 'state.json'), 'utf8'), bytes);
  await rm(backupPath, { recursive: true }); assert.equal((await create(board, project.id)).number, 2);
});

test('caller-supplied numbers cannot replace allocation or renumber an existing identity', async t => {
  const { board } = await world(t), project = await board.createProject({ name: 'Server owned' });
  const task = await board.createTask({ projectId: project.id, title: 'Owned', prompt: 'Exact', number: 900, nextTaskNumber: 1000 });
  assert.equal(task.number, 1);
  await board.updateTask(task.id, { title: 'Edited', expectedRevision: task.revision, number: 900 });
  assert.equal((await board.state()).projects[0].tasks[0].number, 1); assert.equal((await create(board, project.id)).number, 2);
});
