import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Board, parseBackup } from '../src/board.mjs';
import { Store, STATE_VERSION } from '../src/store.mjs';

async function directory(t) { const dir = await mkdtemp(join(tmpdir(), 'pb-no-backlog-')); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })); return dir; }
const issue = { provider: 'github-issues', repository: 'acme/app', id: 7, number: 3, url: 'https://github.com/acme/app/issues/3', title: 'Crash', assignees: ['octo'], updatedAt: 5 };
const draft = (id, extra = {}) => ({ id, title: `Draft ${id}`, prompt: `  Exact ${id}\r\n雪`, source: null, checksOutdated: false, createdAt: 10, updatedAt: 20, priority: 2, labelIds: ['bug'], revision: 3, ...extra });
async function labeledProject(dataDir) {
  const board = new Board({ dataDir }), project = await board.createProject({ name: 'Drafts', workflowMode: 'pipeline' });
  await board.setLabels(project.id, { labels: [{ id: 'bug', name: 'Bug', color: '#c93451' }], expectedLabelRevision: 0 });
  const card = await board.createTask({ projectId: project.id, title: 'Existing card' });
  return { board, project, card };
}

test('version 13 turns saved Backlog drafts into idle To Do cards and keeps the exact earlier file', async t => {
  const dir = await directory(t), { board, card } = await labeledProject(dir);
  const old = structuredClone(await board.state()); old.version = 12;
  Object.assign(old.projects[0], { backlog: [draft('a'), draft('b', { externalSource: issue })], backlogRevision: 4,
    backlogSources: [{ id: 'src', provider: 'github-issues', repository: 'acme/app' }], backlogImported: [{ key: 'github:issue:7', taskId: 'b' }], backlogImportRevision: 2 });
  const bytes = JSON.stringify(old); await writeFile(join(dir, 'state.json'), bytes);
  const store = new Store(dir), saved = await store.read(), project = saved.projects[0];
  assert.equal(saved.version, STATE_VERSION); assert.equal(STATE_VERSION, 13);
  for (const key of ['backlog', 'backlogRevision', 'backlogSources', 'backlogImported', 'backlogImportRevision']) assert.equal(Object.hasOwn(project, key), false, key);
  const todo = project.pipeline.columns.find(column => column.role === 'todo').id;
  assert.deepEqual(project.tasks.map(task => [task.id, task.number, task.column]), [[card.id, 1, todo], ['a', 2, todo], ['b', 3, todo]]);
  assert.equal(project.nextTaskNumber, 4);
  const [a, b] = project.tasks.slice(1);
  assert.equal(a.prompt, '  Exact a\r\n雪'); assert.equal(a.priority, 2); assert.deepEqual(a.labelIds, ['bug']); assert.equal(a.createdAt, 10);
  assert.deepEqual(b.externalSource, issue);
  assert.equal(saved.migrations.at(-1).kind, 'state-v12-to-v13'); assert.equal(saved.migrations.at(-1).draftsMovedToTodo, 2);
  assert.equal(await readFile(join(dir, store.recovery.migrationBackup), 'utf8'), bytes);
  assert.deepEqual(saved.runs, []); assert.deepEqual(saved.sessions, []);
  assert.deepEqual(await new Store(dir).read(), saved);
  // The former drafts are ordinary cards now.
  const edited = await new Board({ dataDir: dir }).updateTask('a', { title: 'Edited', expectedRevision: 1 });
  assert.equal(edited.task.title, 'Edited'); assert.equal(edited.task.prompt, a.prompt);
});

test('older backups with Backlog drafts import them as To Do cards; new backups have no Backlog', async t => {
  const { board } = await labeledProject(await directory(t)), backup = await board.exportBackup();
  assert.equal(backup.version, 11);
  for (const key of ['backlog', 'backlogSources', 'backlogImported']) assert.equal(Object.hasOwn(backup.projects[0], key), false, key);
  const older = structuredClone(backup); older.version = 10;
  Object.assign(older.projects[0], { backlog: [draft('a'), draft('b', { externalSource: issue })], backlogSources: [], backlogImported: [] });
  const target = new Board({ dataDir: await directory(t) }); await target.importBackup(older);
  const project = (await target.state()).projects[0], todo = project.pipeline.columns.find(column => column.role === 'todo').id;
  assert.deepEqual(project.tasks.map(task => [task.title, task.number, task.column]), [['Existing card', 1, todo], ['Draft a', 2, todo], ['Draft b', 3, todo]]);
  assert.equal(project.tasks[1].prompt, '  Exact a\r\n雪'); assert.deepEqual(project.tasks[2].externalSource, issue);
  assert.equal(Object.hasOwn(project, 'backlog'), false); assert.deepEqual((await target.state()).runs, []);
  // A draft with an unknown label is refused like any invalid card; a newer backup is refused clearly.
  const invalid = structuredClone(older); invalid.projects[0].backlog = [draft('c', { labelIds: ['missing'] })];
  assert.throws(() => parseBackup(invalid), { code: 'INVALID_BACKUP' });
  assert.throws(() => parseBackup({ ...backup, version: 12 }), { code: 'INVALID_BACKUP' });
});
