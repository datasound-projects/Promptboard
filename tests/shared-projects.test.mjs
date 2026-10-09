import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from '../src/board.mjs';
import { OriginStore, originRoute } from '../src/origin.mjs';
import { PromptStore, ensureProject, findProject } from '../src/projects.mjs';
import { startTestServer } from './helpers/test-server.mjs';

async function client(t) {
  const app = await startTestServer(t, { port: 0, executor: null });
  const { token } = await (await fetch(`${app.url}/api/session`)).json();
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  return { app, call };
}
const entry = (projects, name) => projects.filter(project => project.name === name);
async function local(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-shared-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const board = new Board({ dataDir }), origin = new OriginStore(dataDir), prompts = new PromptStore(dataDir);
  const route = (pathname, body) => originRoute({ origin, board, prompts, req: { method: 'POST' }, res: {}, pathname, jsonBody: async () => body, send: (_res, status, data) => ({ status, data }) });
  return { board, origin, prompts, services: { origin, board }, route };
}

test('one project keeps one ID across Origin and Kanban, and names are never duplicated', async t => {
  const { app, call } = await client(t);
  // Origin creates its board now: same ID on both sides.
  const now = (await call('/api/origin/projects', 'POST', { name: 'Shop', createKanban: true })).data.project;
  assert.equal(now.kanbanProjectId, now.id);
  // Origin creates its board later: same ID too.
  let later = (await call('/api/origin/projects', 'POST', { name: 'Blog' })).data.project;
  assert.equal(later.kanbanProjectId, null);
  later = (await call(`/api/origin/projects/${later.id}/link`, 'POST', { expectedRevision: later.revision, createKanban: true })).data.project;
  assert.equal(later.kanbanProjectId, later.id);
  // Kanban creates a board for a project Origin already has: it joins that project.
  const notes = (await call('/api/origin/projects', 'POST', { name: 'Notes' })).data.project;
  const board = (await call('/api/projects', 'POST', { name: 'notes' })).data;
  assert.equal(board.project.id, notes.id); assert.equal(board.sharedWith, notes.id);
  assert.equal((await call(`/api/origin/projects/${notes.id}`)).data.project.kanbanProjectId, notes.id);
  // Origin creates a project whose board Kanban made first: it joins the board and keeps its ID.
  const kanbanFirst = await app.board.createProject({ name: 'CLI tool', workflowMode: 'pipeline' });
  const joined = (await call('/api/origin/projects', 'POST', { name: 'CLI Tool', createKanban: true })).data;
  assert.equal(joined.project.id, kanbanFirst.id); assert.equal(joined.joinedKanban, true);
  // No duplicates.
  assert.equal((await call('/api/origin/projects', 'POST', { name: 'shop' })).data.code, 'NAME_TAKEN');
  assert.equal((await call('/api/projects', 'POST', { name: 'Shop' })).data.code, 'NAME_TAKEN');
  const list = (await call('/api/shared-projects')).data.projects;
  for (const name of ['Shop', 'Blog', 'Notes', 'CLI tool']) assert.equal(list.filter(project => project.name.toLowerCase() === name.toLowerCase()).length, 1, name);
  assert.equal((await app.board.state()).projects.length, 4);
  // Compose asks for a project by name: an existing one is selected, a new one is an Origin project without a board.
  assert.equal((await call('/api/shared-projects', 'POST', { name: 'BLOG' })).data.existing, true);
  const fresh = (await call('/api/shared-projects', 'POST', { name: 'Ideas' })).data;
  assert.equal(fresh.existing, false); assert.equal(fresh.project.kanban, null); assert.ok(fresh.project.origin);
  assert.equal((await app.board.state()).projects.length, 4, 'Compose never creates a board on its own');
  // A board without an Origin project can start one with the same ID.
  const solo = await app.board.createProject({ name: 'Board only', workflowMode: 'pipeline' });
  const started = (await call(`/api/shared-projects/${solo.id}/origin`, 'POST', {})).data;
  assert.equal(started.project.id, solo.id); assert.deepEqual(started.project.ids, [solo.id]); assert.equal(started.project.origin.id, solo.id);
});

test('a link made before shared IDs still lists one project, reachable by either ID', async t => {
  const { app, call } = await client(t);
  const board = await app.board.createProject({ name: 'Legacy board', workflowMode: 'pipeline' });
  let origin = (await call('/api/origin/projects', 'POST', { name: 'Legacy plan' })).data.project;
  origin = (await call(`/api/origin/projects/${origin.id}/link`, 'POST', { expectedRevision: origin.revision, kanbanProjectId: board.id })).data.project;
  const list = (await call('/api/shared-projects')).data.projects;
  assert.equal(list.length, 1); assert.deepEqual(list[0].ids, [origin.id, board.id]); assert.equal(list[0].name, 'Legacy plan');
  // A prompt saved through the board's ID belongs to the same project.
  const saved = (await call(`/api/shared-projects/${board.id}/prompts`, 'POST', { title: 'Login', prompt: 'Build the login form.' })).data;
  assert.equal(saved.project.id, origin.id);
  assert.equal((await call(`/api/shared-projects/${origin.id}/prompts`)).data.prompts.length, 1);
});

test('saved prompts keep revisions and links; cards are made only on request and change only when idle', async t => {
  const { app, call } = await client(t);
  const project = (await call('/api/shared-projects', 'POST', { name: 'Shop' })).data.project;
  const base = `/api/shared-projects/${project.id}/prompts`;
  const first = (await call(base, 'POST', { title: 'Checkout', prompt: 'Build checkout v1.', input: 'checkout', historyId: 'h1', settings: { provider: 'codex', model: 'gpt' }, verification: 'checks-passed', origin: [] })).data;
  assert.equal(first.existing, false); assert.equal(first.prompt.current, 1);
  assert.equal((await call(base, 'POST', { title: 'Again', prompt: 'Build checkout v1.', historyId: 'h1' })).data.existing, true, 'the same result is saved once');
  assert.equal((await app.board.state()).projects.length, 0, 'saving a prompt creates no board and no card');
  const promptPath = `${base}/${first.prompt.id}`;
  // A card needs a board; it is created only when asked.
  assert.equal((await call(`${promptPath}/cards`, 'POST', { expectedRevision: 1 })).data.code, 'NO_BOARD');
  const carded = (await call(`${promptPath}/cards`, 'POST', { expectedRevision: 1, createBoard: true })).data;
  assert.equal(carded.project.kanban.id, project.id, 'the board keeps the project ID');
  let state = await app.board.state();
  const card = state.projects[0].tasks[0];
  assert.equal(card.prompt, 'Build checkout v1.'); assert.deepEqual([card.source.projectId, card.source.promptId, card.source.promptRevision], [project.id, first.prompt.id, 1]);
  assert.equal(card.column, state.projects[0].pipeline.columns.find(column => column.role === 'todo').id);
  // A new revision keeps the old one and leaves the card alone until an explicit update.
  let saved = (await call(`${promptPath}/revisions`, 'POST', { expectedRevision: 2, prompt: 'Build checkout v2.', historyId: 'h2' })).data.prompt;
  assert.deepEqual(saved.revisions.map(revision => revision.prompt), ['Build checkout v1.', 'Build checkout v2.']);
  assert.equal(saved.cards[0].behind, true); assert.equal((await app.board.state()).projects[0].tasks[0].prompt, 'Build checkout v1.');
  assert.equal((await call(`${promptPath}/revisions`, 'POST', { expectedRevision: 2, prompt: 'stale' })).data.code, 'PROMPT_REVISION_CONFLICT');
  // A running card keeps its instructions.
  await app.board.store.update(draft => { draft.runs.push({ id: 'run-1', taskId: card.id, projectId: project.id, status: 'running', createdAt: Date.now(), config: { provider: 'codex' } }); });
  const busy = await call(`${promptPath}/cards/${card.id}/update`, 'POST', { expectedRevision: 3, expectedCardRevision: card.revision });
  assert.equal(busy.data.code, 'CARD_BUSY'); assert.equal((await app.board.state()).projects[0].tasks[0].prompt, 'Build checkout v1.');
  await app.board.store.update(draft => { draft.runs = draft.runs.filter(run => run.id !== 'run-1'); });
  // An idle card in To Do takes the new revision; an edited card asks first.
  await app.board.updateTask(card.id, { title: card.title, prompt: 'Edited on the board.', expectedRevision: card.revision });
  state = await app.board.state();
  const edited = await call(`${promptPath}/cards/${card.id}/update`, 'POST', { expectedRevision: 3, expectedCardRevision: state.projects[0].tasks[0].revision });
  assert.equal(edited.data.code, 'CARD_EDITED');
  saved = (await call(`${promptPath}/cards/${card.id}/update`, 'POST', { expectedRevision: 3, expectedCardRevision: state.projects[0].tasks[0].revision, replaceEdited: true })).data.prompt;
  const updated = (await app.board.state()).projects[0].tasks[0];
  assert.equal(updated.prompt, 'Build checkout v2.'); assert.equal(updated.source.promptRevision, 2); assert.equal(saved.cards[0].behind, false);
  assert.equal(updated.contentRevision, card.contentRevision + 2);
  // Links to Origin records resolve their names at read time; renaming or deleting a prompt never touches cards.
  const blueprint = (await call(`/api/origin/projects/${project.id}`)).data;
  blueprint.blueprint.components.push({ id: 'cmp', name: 'Checkout service' });
  await call(`/api/origin/projects/${project.id}`, 'PUT', { expectedRevision: blueprint.revision, blueprint: blueprint.blueprint });
  saved = (await call(promptPath, 'PATCH', { expectedRevision: 4, title: 'Checkout flow', origin: [{ originId: project.id, collection: 'components', id: 'cmp' }] })).data.prompt;
  assert.deepEqual(saved.origin, [{ originId: project.id, collection: 'components', id: 'cmp', name: 'Checkout service', exists: true }]);
  assert.equal((await call(promptPath, 'DELETE', { expectedRevision: 5 })).data.deleted, true);
  assert.equal((await app.board.state()).projects[0].tasks[0].prompt, 'Build checkout v2.');
  // Stored apart from History and the board, in its own file.
  assert.match(await readFile(join(app.board.store.dir, 'prompts', `prompts-${project.id.replace(/[A-Z_]/g, c => `_${c === '_' ? '_' : c.toLowerCase()}`)}.json`), 'utf8'), /"schema": "promptboard.project-prompts"/);
});

test('refining a card from Compose changes only an idle card in To Do', async t => {
  const { app, call } = await client(t);
  const project = await app.board.createProject({ name: 'Board', workflowMode: 'pipeline' });
  const card = await app.board.createTask({ projectId: project.id, title: 'Card', prompt: 'Original' });
  const done = (await call(`/api/tasks/${card.id}/refine`, 'POST', { prompt: 'Refined', expectedRevision: card.revision })).data.task;
  assert.equal(done.prompt, 'Refined'); assert.equal(done.contentRevision, 2);
  const active = project.pipeline.columns.find(column => column.role === 'active').id;
  await app.board.store.update(draft => { draft.projects[0].tasks[0].column = active; });
  const refused = await call(`/api/tasks/${card.id}/refine`, 'POST', { prompt: 'Again', expectedRevision: done.revision });
  assert.equal(refused.status, 409); assert.equal(refused.data.code, 'CARD_BUSY');
  assert.equal((await app.board.state()).projects[0].tasks[0].prompt, 'Refined');
});

test('one name and one ID belong to one project, also when two windows ask at once', async t => {
  const { board, origin, services } = await local(t);
  const both = await Promise.all([ensureProject(services, { name: 'Shop' }), ensureProject(services, { name: 'shop' })]);
  assert.deepEqual(both.map(result => result.existing).sort(), [false, true]); assert.equal(both[0].project.id, both[1].project.id);
  assert.equal((await origin.list()).length, 1);
  await assert.rejects(Promise.all([origin.create({ name: 'Blog' }), origin.create({ name: 'BLOG' })]), { code: 'NAME_TAKEN' });
  // A board with an Origin project's own ID is that project's board, even without a stored link.
  const beta = await origin.create({ name: 'Beta' }), alpha = await origin.create({ name: 'Alpha' });
  await board.createProject({ name: 'Beta board', id: beta.id });
  await assert.rejects(origin.link(alpha.id, { expectedRevision: 1, kanbanProjectId: beta.id }), { code: 'ALREADY_LINKED' });
  await assert.rejects(origin.create({ name: 'Gamma', kanbanProjectId: beta.id }), { code: 'ALREADY_LINKED' });
  // Older data where two projects reach one board: its ID opens the project that owns that ID.
  await origin.create({ name: 'Delta', kanbanProjectId: 'shared-x' });
  await board.createProject({ name: 'Shared board', id: 'shared-x' });
  await origin.create({ name: 'Owner', id: 'shared-x' });
  assert.equal((await findProject(services, 'shared-x')).name, 'Owner');
});

test('saved prompts stay with a kept board when the Origin side of an older link is deleted', async t => {
  const { board, origin, prompts, services, route } = await local(t);
  const kept = await board.createProject({ name: 'Legacy board' }), plan = await origin.create({ name: 'Legacy plan' });
  const linked = await origin.link(plan.id, { expectedRevision: 1, kanbanProjectId: kept.id });
  const shared = await findProject(services, kept.id);
  await prompts.create(shared.id, shared.ids, { title: 'Saved', prompt: 'Build the login form.' });
  assert.equal((await route(`/api/origin/projects/${plan.id}/delete`, { expectedRevision: linked.revision })).status, 200);
  const after = await findProject(services, kept.id);
  assert.deepEqual(after.ids, [kept.id]);
  assert.deepEqual((await prompts.list(after.ids)).map(prompt => prompt.title), ['Saved']);
});

test('names are checked against projects and boards, on create and rename, and a stale link creates no board', async t => {
  const { app, call } = await client(t);
  const shop = (await call('/api/origin/projects', 'POST', { name: 'Shop', createKanban: true })).data.project;
  await app.board.renameProject(shop.id, { name: 'Storefront', expectedRevision: (await app.board.state()).projects[0].revision });
  assert.equal((await call('/api/origin/projects', 'POST', { name: 'storefront' })).data.code, 'NAME_TAKEN', 'a board name is taken too');
  const blog = (await call('/api/origin/projects', 'POST', { name: 'Blog' })).data.project;
  assert.equal((await call(`/api/origin/projects/${blog.id}`, 'PATCH', { expectedRevision: 1, name: 'SHOP' })).data.code, 'NAME_TAKEN');
  assert.equal((await call(`/api/origin/projects/${blog.id}`, 'PATCH', { expectedRevision: 1, name: 'Storefront' })).data.code, 'NAME_TAKEN');
  assert.equal((await call(`/api/origin/projects/${shop.id}`, 'PATCH', { expectedRevision: shop.revision, name: 'Storefront' })).status, 200, 'a project may take its own board’s name');
  const stale = await call(`/api/origin/projects/${blog.id}/link`, 'POST', { expectedRevision: 0, createKanban: true });
  assert.equal(stale.data.code, 'ORIGIN_REVISION_CONFLICT');
  assert.equal((await app.board.state()).projects.length, 1, 'a refused link creates no board');
  assert.equal((await call(`/api/origin/projects/${blog.id}/link`, 'POST', { expectedRevision: 1, createKanban: true, name: 'storefront' })).data.code, 'NAME_TAKEN');
  const linked = (await call(`/api/origin/projects/${blog.id}/link`, 'POST', { expectedRevision: 1, createKanban: true })).data.project;
  assert.equal(linked.kanbanProjectId, blog.id);
});

test('renaming a board in Kanban keeps the one-name rule across Origin', async t => {
  const { app, call } = await client(t);
  await call('/api/origin/projects', 'POST', { name: 'Plan only' });
  const board = await app.board.createProject({ name: 'Board' });
  const rename = name => call(`/api/projects/${board.id}`, 'PATCH', { name, expectedRevision: board.revision });
  const taken = await rename('plan ONLY');
  assert.equal(taken.status, 409); assert.equal(taken.data.code, 'NAME_TAKEN');
  assert.equal((await rename('Board two')).status, 200);
});
