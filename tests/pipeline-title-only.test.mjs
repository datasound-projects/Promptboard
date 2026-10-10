import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from '../src/board.mjs';
import { customPipelineConfig } from './helpers/pipeline.mjs';
import { startTestServer } from './helpers/test-server.mjs';

async function directory(t) { const path = await mkdtemp(join(tmpdir(), 'pb-title-only-')); t.after(() => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })); return path; }
async function fixture(t) {
  const dataDir = await directory(t), board = new Board({ dataDir }), project = await board.createProject({ name: 'Title-only pipeline' }), pipeline = customPipelineConfig();
  for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  pipeline.columns[0].id = 'inbox';
  await board.setPipeline(project.id, { pipeline, expectedRevision: project.revision, confirm: true });
  board.executor = { start() { assert.fail('Authoring must not start agents.'); }, validate() { assert.fail('Authoring must not probe providers.'); }, cancel() { assert.fail('Authoring must not signal agents.'); } };
  return { board, dataDir, projectId: project.id };
}

test('pipeline title-only tasks enter the To Do role without runs; exact bodies and legacy/type/title bounds remain intact', async t => {
  const { board, projectId } = await fixture(t);
  const task = await board.createTask({ projectId, title: 'Fix <img> & 😀' }); assert.equal(task.prompt, ''); assert.equal(task.column, 'inbox');
  const whitespace = ' \t\r\n ', exact = '  Exact Composer 😀\r\n{{title}}  ';
  assert.equal((await board.createTask({ projectId, title: 'Whitespace', prompt: whitespace })).prompt, whitespace);
  assert.equal((await board.createTask({ projectId, title: 'Composer', prompt: exact })).prompt, exact);
  const before = structuredClone(await board.state()); assert.deepEqual(before.runs, []); assert.deepEqual(before.sessions, []);
  for (const input of [{ title: '', prompt: 'Body' }, { title: 'Task', prompt: null }, { title: 'Task', prompt: {} }, { title: 'Task', prompt: 'x'.repeat(2 * 1024 * 1024 + 1) }])
    await assert.rejects(board.createTask({ projectId, ...input }), { code: 'INVALID_INPUT' });
  assert.deepEqual(await board.state(), before);
  const legacy = await board.createProject({ name: 'Legacy' });
  await assert.rejects(board.createTask({ projectId: legacy.id, title: 'Required body' }), { code: 'INVALID_INPUT' });
});

test('empty pipeline descriptions survive editing, copy, restart and inert portable import; clearing generated text invalidates its checks', async t => {
  const { board, dataDir, projectId } = await fixture(t), source = { provider: 'claude', quality: 'reviewed', verification: 'checks-passed', generatedAt: 1 };
  const original = await board.createTask({ projectId, title: 'Original', prompt: '  Original\r\n', source });
  const edited = await board.updateTask(original.id, { title: 'Title only', prompt: '', expectedRevision: original.revision });
  assert.equal(edited.task.prompt, ''); assert.equal(edited.task.checksOutdated, true); assert.equal(edited.task.contentRevision, 2); assert.deepEqual(edited.task.source, original.source);
  const copied = await board.duplicateTask(original.id); assert.equal(copied.prompt, ''); assert.equal(copied.column, 'inbox'); assert.equal(copied.checksOutdated, true);
  assert.deepEqual((await new Board({ dataDir }).state()).projects[0].tasks, (await board.state()).projects[0].tasks);
  const backup = await board.exportBackup(), imported = new Board({ dataDir: await directory(t) }); await imported.importBackup(backup, { confirm: true });
  const state = await imported.state(); assert.ok(state.projects[0].tasks.every(task => task.prompt === '')); assert.deepEqual(state.runs, []); assert.deepEqual(state.sessions, []);
  assert.ok(state.projects[0].pipeline.columns.every(column => !column.strategy.autoSpawn));
  for (const value of [null, undefined]) {
    const malformed = structuredClone(backup);
    if (value === undefined) delete malformed.projects[0].tasks[0].prompt;
    else malformed.projects[0].tasks[0].prompt = value;
    await assert.rejects(imported.importBackup(malformed, { confirm: true }), { code: 'INVALID_BACKUP' });
    assert.deepEqual(await imported.state(), state);
  }
  const invalid = structuredClone(backup); invalid.projects[0].workflowMode = 'legacy'; delete invalid.projects[0].pipeline;
  for (const task of invalid.projects[0].tasks) task.column = 'todo';
  await assert.rejects(imported.importBackup(invalid, { confirm: true }), { code: 'INVALID_BACKUP' }); assert.deepEqual(await imported.state(), state);
});

test('authenticated task authoring accepts a pipeline title without a body and still rejects unauthorized and invalid input', async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] }), project = await app.board.createProject({ name: 'API pipeline' }), pipeline = customPipelineConfig();
  for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  await app.board.setPipeline(project.id, { pipeline, expectedRevision: project.revision, confirm: true });
  const { token, capabilities } = await (await fetch(`${app.url}/api/session`)).json();
  assert.equal(capabilities.pipelineTitleOnly, true);
  const post = (body, supplied = token) => fetch(`${app.url}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-STE-Token': supplied, Origin: app.url }, body: JSON.stringify(body) });
  assert.equal((await post({ projectId: project.id, title: 'Unauthorized' }, 'wrong')).status, 403);
  const response = await post({ projectId: project.id, title: 'Only title' }); assert.equal(response.status, 200); const value = await response.json();
  assert.equal(value.task.prompt, ''); assert.equal(value.task.column, 'todo');
  assert.equal((await post({ projectId: project.id, title: 'Invalid', prompt: null })).status, 400);
  assert.deepEqual((await app.board.state()).runs, []);
});
