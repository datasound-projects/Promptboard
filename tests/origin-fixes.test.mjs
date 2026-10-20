import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import '../public/origin-model.js';
import { OriginStore, buildContext } from '../src/origin.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const M = globalThis.PromptboardOriginModel;

async function server(t, options = {}) {
  const app = await startTestServer(t, { port: 0, executor: null, ...options });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const api = async (path, body, method = body ? 'POST' : 'GET') => { const response = await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, data: await response.json().catch(() => ({})) }; };
  return { app, api };
}

test('your own answered questions in built-in sections count as content and reach every task', () => {
  const bp = M.emptyBlueprint();
  bp.questions.push({ id: 'q1', scope: 'section', sectionId: 'deployment', text: 'Which region?' });
  assert.equal(M.sectionStates(bp).deployment, 'empty');
  bp.answers.q1 = 'eu-west-1 only';
  assert.notEqual(M.sectionStates(bp).deployment, 'empty', 'an answered question starts the section');
  bp.items.push({ id: 'i1', key: 'IMP-001', title: 'Deploy', description: 'Ship it.', acceptanceCriteria: 'It runs.' });
  const context = M.taskContext(M.normalizeBlueprint(bp).blueprint, 'i1', { projectName: 'Shop' });
  assert.match(M.taskBody(context, { projectName: 'Shop' }), /## Your questions\n- Deployment · Which region\? → eu-west-1 only/);
});

test('a card link restored from the card keeps what it was sent with', async t => {
  const { app, api } = await server(t);
  const kanban = await app.board.createProject({ name: 'Shop', workflowMode: 'pipeline' });
  let res = await api('/api/origin/projects', { name: 'Shop design' });
  const id = res.data.project.id;
  res = await api(`/api/origin/projects/${id}/link`, { expectedRevision: res.data.project.revision, kanbanProjectId: kanban.id });
  const bp = M.emptyBlueprint(); bp.items.push({ id: 'i1', key: 'IMP-001', title: 'Schema', acceptanceCriteria: 'Tables exist' }); bp.sequence = { requirements: 0, items: 1 };
  res = await api(`/api/origin/projects/${id}`, { expectedRevision: res.data.revision, blueprint: bp }, 'PUT');
  res = await api(`/api/origin/projects/${id}/handoff`, { expectedRevision: res.data.revision, itemIds: ['i1'] });
  const card = (await app.board.state()).projects[0].tasks[0];
  // An interrupted handoff lost the link on the Origin side; sending again restores it from the card.
  const lost = res.data.blueprint; lost.items[0].handoff = null;
  res = await api(`/api/origin/projects/${id}`, { expectedRevision: res.data.revision, blueprint: lost }, 'PUT');
  res = await api(`/api/origin/projects/${id}/handoff`, { expectedRevision: res.data.revision, itemIds: ['i1'] });
  assert.equal(res.data.results[0].status, 'existing');
  assert.deepEqual([res.data.blueprint.items[0].handoff.snapshotId, res.data.blueprint.items[0].handoff.hash], [card.originSource.snapshotId, card.originSource.hash]);
});

test('Update context never replaces a split part or an edited card unseen, also when the Origin link has no snapshot', async t => {
  const { app, api } = await server(t);
  const kanban = await app.board.createProject({ name: 'Shop', workflowMode: 'pipeline' }), store = new OriginStore(app.board.store.dir);
  let res = await api('/api/origin/projects', { name: 'Shop design' });
  const id = res.data.project.id;
  res = await api(`/api/origin/projects/${id}/link`, { expectedRevision: res.data.project.revision, kanbanProjectId: kanban.id });
  const bp = M.emptyBlueprint(); bp.items.push({ id: 'i1', key: 'IMP-001', title: 'Schema', acceptanceCriteria: 'Tables exist' }, { id: 'i2', key: 'IMP-002', title: 'API', acceptanceCriteria: 'It answers' }); bp.sequence = { requirements: 0, items: 2 };
  res = await api(`/api/origin/projects/${id}`, { expectedRevision: res.data.revision, blueprint: bp }, 'PUT');
  // IMP-001 was split in Compose Batch: its card is part 1. IMP-002 was sent from Origin, then edited in Kanban.
  const part = await store.snapshot(id, { ...buildContext(await store.read(id), 'i1'), instruction: 'Part one', body: 'Part one', compose: { batchId: id, itemId: 'i1', childId: '1', versionId: 'v1', promptHash: 'h' } }, res.data.revision);
  const [split] = await app.board.createOriginTasks(kanban.id, { originProjectId: id, tasks: [{ originTaskId: 'i1-s1', key: 'IMP-001.1', title: 'IMP-001.1 Tables', prompt: 'Part one', snapshotId: part.id, hash: part.hash }] });
  res = await api(`/api/origin/projects/${id}/handoff`, { expectedRevision: res.data.revision, itemIds: ['i2'] });
  const card = (await app.board.state()).projects[0].tasks.find(task => task.originSource.originTaskId === 'i2');
  await app.board.updateTask(card.id, { prompt: `${card.prompt}\nMy own note.`, expectedRevision: card.revision });
  // Both links were restored without a snapshot (as a resend that finds the card does), and the design changes.
  const lost = res.data.blueprint; lost.vision.constraints = 'EU hosting only';
  lost.items[0].handoff = { projectId: kanban.id, taskId: split.taskId, at: Date.now(), snapshotId: '', hash: '', keptHash: '' }; lost.items[1].handoff.snapshotId = '';
  res = await api(`/api/origin/projects/${id}`, { expectedRevision: res.data.revision, blueprint: lost }, 'PUT');
  const status = (await api(`/api/origin/projects/${id}/context-status`, { expectedRevision: res.data.revision })).data.tasks;
  assert.deepEqual(status.map(task => [task.key, task.status, task.splitPart, task.edited]), [['IMP-001', 'changed', true, true], ['IMP-002', 'changed', false, true]]);
  const update = (task, extra = {}) => api(`/api/origin/projects/${id}/update-context`, { expectedRevision: res.data.revision, itemId: task.itemId, expectedHash: task.hash, expectedCardRevision: task.cardRevision, ...extra });
  assert.equal((await update(status[0], { replaceEdited: true })).data.code, 'SPLIT_PART');
  assert.equal((await update(status[1])).data.code, 'CARD_EDITED');
  assert.deepEqual((await app.board.state()).projects[0].tasks.map(task => task.prompt.endsWith('My own note.') || task.prompt === 'Part one'), [true, true], 'neither card changed');
});

test('a task split in Compose Batch whose Origin link was lost is never sent again as one whole card', async t => {
  const { app, api } = await server(t);
  const kanban = await app.board.createProject({ name: 'Shop', workflowMode: 'pipeline' });
  let res = await api('/api/origin/projects', { name: 'Shop design' });
  const id = res.data.project.id;
  res = await api(`/api/origin/projects/${id}/link`, { expectedRevision: res.data.project.revision, kanbanProjectId: kanban.id });
  const bp = M.emptyBlueprint(); bp.items.push({ id: 'i1', key: 'IMP-001', title: 'Schema', acceptanceCriteria: 'Tables exist' }, { id: 'i2', key: 'IMP-002', title: 'API', acceptanceCriteria: 'It answers', dependsOn: ['i1'] }); bp.sequence = { requirements: 0, items: 2 };
  res = await api(`/api/origin/projects/${id}`, { expectedRevision: res.data.revision, blueprint: bp }, 'PUT');
  // IMP-001 reached Kanban as two parts from Compose Batch, but Origin never recorded the link to them.
  const parts = await app.board.createOriginTasks(kanban.id, { originProjectId: id, tasks: [1, 2].map(n => ({ originTaskId: `i1-s${n}`, key: `IMP-001.${n}`, title: `IMP-001.${n} Part`, prompt: `Part ${n}` })) });
  res = await api(`/api/origin/projects/${id}/handoff`, { expectedRevision: res.data.revision, itemIds: ['i2'], includePrerequisites: true });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.deepEqual(res.data.results.map(result => [result.key, result.status]), [['IMP-002', 'created']], 'IMP-001 already has its cards');
  res = await api(`/api/origin/projects/${id}/handoff`, { expectedRevision: res.data.revision, itemIds: ['i1'] });
  assert.deepEqual([res.data.results[0].status, res.data.results[0].taskId], ['existing', parts[1].taskId]);
  assert.equal(res.data.blueprint.items[0].handoff.taskId, parts[1].taskId, 'the link is restored to the last part');
  const tasks = (await app.board.state()).projects[0].tasks;
  assert.deepEqual(tasks.map(task => task.originSource.originTaskId), ['i1-s1', 'i1-s2', 'i2'], 'no whole card next to the parts');
  assert.deepEqual(tasks[2].dependsOn, [parts[1].taskId], 'the next task waits for the last part');
  assert.equal(M.splitCard(tasks, id, 'i1', itemId => itemId === 'i1-s1').id, parts[1].taskId, 'a part ID that is a task of its own is not a part');
});

test('Delete from Origin moves the project\'s research chats aside, so a project made later under its ID starts without them', async t => {
  const { app, api } = await server(t, { researchRunner: async call => ({ text: 'Findings.', session: call.session?.id }) });
  const project = (await api('/api/origin/projects', { name: 'Shop' })).data.project;
  const settings = { provider: 'claude', mode: 'chat' };
  await api(`/api/origin/research/${project.id}/chats`, { settings });
  assert.equal((await api(`/api/origin/research/${project.id}/chats`)).data.chats.length, 1);
  const deleted = await api(`/api/origin/projects/${project.id}/delete`, { expectedRevision: project.revision });
  assert.equal(deleted.status, 200);
  const origin = join(app.board.store.dir, 'origin');
  assert.ok((await readdir(join(origin, 'deleted'))).some(name => name.startsWith(`research-`)), 'kept in origin/deleted/');
  assert.deepEqual((await api(`/api/origin/research/${project.id}/chats`)).data.chats ?? [], []);
});

test('control characters pasted into Origin never reach a card: page breaks become line breaks, escape sequences go', () => {
  const bp = M.emptyBlueprint();
  bp.items.push({ id: 'i1', title: 'T', description: 'Page\x0cbreak \x1b[0mreset\ttab\nline\r\nok\x00' });
  const { blueprint, repairs } = M.normalizeBlueprint(bp);
  assert.equal(blueprint.items[0].description, 'Page\nbreak reset\ttab\nline\r\nok');
  assert.equal(repairs, 1);
});
