import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import '../public/origin-model.js';
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
