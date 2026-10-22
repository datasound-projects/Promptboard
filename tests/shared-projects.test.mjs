import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from '../src/board.mjs';
import { OriginError, OriginStore, originRoute } from '../src/origin.mjs';
import { PromptStore, createBoardFor, ensureProject, findProject, projectsRoute } from '../src/projects.mjs';
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

test('a card whose prompt link cannot be saved is removed again, so a retry makes exactly one card', async t => {
  const { board, origin, prompts } = await local(t);
  const project = await board.createProject({ name: 'Shop' });
  const { prompt } = await prompts.create(project.id, [project.id], { title: 'Checkout', prompt: 'Build checkout.' });
  let saveFails = true;
  // The update runs, then the save fails, as on a full disk.
  const flaky = { change: (ids, id, revision, update) => prompts.change(ids, id, revision, async (...args) => {
    await update(...args); if (saveFails) throw new OriginError('The prompt could not be saved.', 'PROMPTS_WRITE_FAILED', 500);
  }) };
  const card = () => projectsRoute({ origin, board, prompts: flaky, req: { method: 'POST' }, res: {}, pathname: `/api/shared-projects/${project.id}/prompts/${prompt.id}/cards`,
    jsonBody: async () => ({ expectedRevision: 1 }), send: (_res, status, data) => ({ status, data }) });
  const cards = async () => (await board.state()).projects[0].tasks.length;
  await assert.rejects(card(), { code: 'PROMPTS_WRITE_FAILED' });
  assert.equal(await cards(), 0);
  // When the card cannot be removed either, the error says so instead of hiding it.
  const deleteTask = board.deleteTask; board.deleteTask = async () => { throw new Error('disk'); };
  await assert.rejects(card(), { code: 'CARD_UNLINKED', message: /Card \d+ was created/ });
  board.deleteTask = deleteTask;
  await board.deleteTask((await board.state()).projects[0].tasks[0].id, { expectedRevision: 1 });
  saveFails = false;
  assert.equal((await card()).status, 200);
  assert.equal(await cards(), 1);
  assert.equal((await prompts.list([project.id]))[0].links.cards.length, 1);
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

test('a board made for an Origin project is linked although the blueprint was saved meanwhile, never over a link made meanwhile', async t => {
  const { origin } = await local(t);
  // The board service takes a while (folder, git init, first commit); another save lands in that time.
  const slow = meanwhile => ({ state: async () => ({ projects: [] }), createProjectWithRepository: async ({ id }) => { await meanwhile(); return { project: { id } }; } });
  const record = await origin.create({ name: 'Race' });
  const made = await createBoardFor({ origin, board: slow(() => origin.write(record.id, { expectedRevision: record.revision, blueprint: { ...record.blueprint, idea: 'typed meanwhile' } })) }, record);
  assert.deepEqual([made.record.kanbanProjectId, made.record.blueprint.idea], [record.id, 'typed meanwhile']);
  // Another window linked another board in that time: its link stays.
  const other = await origin.create({ name: 'Race two' });
  await assert.rejects(createBoardFor({ origin, board: slow(() => origin.link(other.id, { expectedRevision: other.revision, kanbanProjectId: 'chosen' })) }, other), { code: 'ORIGIN_REVISION_CONFLICT' });
  assert.equal((await origin.read(other.id)).kanbanProjectId, 'chosen');
});

test('one name, one project, also when two windows create or rename on different pages at the same moment', async t => {
  const { app, call } = await client(t);
  const using = async name => (await call('/api/shared-projects')).data.projects.filter(project => [project.name, project.kanban?.name].some(used => used?.toLowerCase() === name)).length;
  const a = (await call('/api/origin/projects', 'POST', { name: 'First' })).data.project, b = (await call('/api/origin/projects', 'POST', { name: 'Second' })).data.project;
  const renames = await Promise.all([call(`/api/origin/projects/${a.id}`, 'PATCH', { expectedRevision: a.revision, name: 'Same Name' }), call(`/api/origin/projects/${b.id}`, 'PATCH', { expectedRevision: b.revision, name: 'same name' })]);
  assert.deepEqual(renames.map(result => result.status).sort(), [200, 409], 'both renames to one name succeeded');
  const board = await app.board.createProject({ name: 'Board' }), c = (await call('/api/origin/projects', 'POST', { name: 'Third' })).data.project;
  await Promise.all([call(`/api/projects/${board.id}`, 'PATCH', { name: 'Renamed', expectedRevision: board.revision }), call(`/api/origin/projects/${c.id}`, 'PATCH', { expectedRevision: c.revision, name: 'renamed' })]);
  const kanban = name => call('/api/projects', 'POST', { name, folder: 'new', workflowMode: 'pipeline' });
  await Promise.all([kanban('Twin'), call('/api/shared-projects', 'POST', { name: 'twin' })]);
  await Promise.all([kanban('Pair'), call('/api/origin/projects', 'POST', { name: 'pair' })]);
  for (const name of ['same name', 'renamed', 'twin', 'pair']) assert.equal(await using(name), 1, `projects named ${name}`);
  // Origin's own store checks a new name in its write queue, on rename as on create.
  const { origin } = await local(t), one = await origin.create({ name: 'One' }), two = await origin.create({ name: 'Two' });
  await assert.rejects(Promise.all([origin.update(one.id, { expectedRevision: one.revision, name: 'Both' }), origin.update(two.id, { expectedRevision: two.revision, name: 'BOTH' })]), { code: 'NAME_TAKEN' });
  assert.equal((await origin.update(one.id, { expectedRevision: (await origin.read(one.id)).revision, name: 'one' })).name, 'one', 'a project may change the case of its own name');
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

test('a name spelled with another Unicode form, case, spacing or invisible characters is the same name on every path', async t => {
  const { app, call } = await client(t);
  const composed = 'D\u00e9mo', decomposed = 'De\u0301mo';
  const demo = (await call('/api/origin/projects', 'POST', { name: composed })).data.project;
  assert.equal((await call('/api/origin/projects', 'POST', { name: ` ${decomposed.toUpperCase()} ` })).data.code, 'NAME_TAKEN');
  assert.deepEqual(await call('/api/shared-projects', 'POST', { name: decomposed }).then(({ data }) => [data.existing, data.project.id]), [true, demo.id], 'Compose selects the project');
  assert.equal((await call('/api/projects', 'POST', { name: '\uff24\uff45\u0301\uff4d\uff4f' })).data.project.id, demo.id, 'Kanban gives that project its board');
  const other = await app.board.createProject({ name: 'Other' });
  const rename = name => call(`/api/projects/${other.id}`, 'PATCH', { name, expectedRevision: other.revision });
  for (const name of [`${decomposed}\u200b`, 'de\u0301mo', 'D\u00c9MO']) assert.equal((await rename(name)).data.code, 'NAME_TAKEN', JSON.stringify(name));
  assert.equal((await rename('Demo')).status, 200, 'an accent still makes another name');
  // The stores check the same rule in their own write queues, and imports rename instead of duplicating.
  const { board, origin } = await local(t);
  await origin.create({ name: composed });
  await assert.rejects(origin.create({ name: decomposed }), { code: 'NAME_TAKEN' });
  await board.importBackup({ version: 1, kind: 'kanban-backup', projects: [{ id: 'imported', name: decomposed, cards: [] }] }, { originProjects: await origin.list() });
  await board.migrateBrowserBoard({ version: 1, projects: [{ id: 'browser', name: 'DE\u0301MO', cards: [] }] }, { originProjects: await origin.list() });
  assert.deepEqual((await board.state()).projects.map(project => project.name), [`${decomposed} (2)`, 'DE\u0301MO (3)']);
  await board.createProject({ name: 'My App' });
  for (const name of ['my\u00a0app', 'My  App', 'M\u200by App']) await assert.rejects(board.createProject({ name }), { code: 'NAME_TAKEN' }, JSON.stringify(name));
});

test('a new or changed project name has no NUL or other control character on any path; names stored before still load', async t => {
  const { app, call } = await client(t);
  for (const name of ['a\u0000b', 'a\nb', 'tab\there', 'bell\u0007']) {
    for (const path of ['/api/projects', '/api/origin/projects', '/api/shared-projects']) assert.equal((await call(path, 'POST', { name })).data.code, 'INVALID_INPUT', `${path} ${JSON.stringify(name)}`);
  }
  const kept = await app.board.createProject({ name: 'Kept' });
  assert.equal((await call(`/api/projects/${kept.id}`, 'PATCH', { name: 'Kept\u0001', expectedRevision: kept.revision })).data.code, 'INVALID_INPUT');
  const { board, origin } = await local(t), record = await origin.create({ name: 'Plan' });
  await assert.rejects(origin.update(record.id, { expectedRevision: record.revision, name: 'Pl\ran' }), { code: 'INVALID_INPUT' });
  // Older names are not checked again: an Origin file and a board backup with a tab in a name still load.
  const made = await origin.create({ name: 'Old' }), file = join(origin.dir, (await readdir(origin.dir)).find(name => name.startsWith('blueprint-') && name.endsWith('.json') && name.includes(made.id.toLowerCase().slice(0, 6))));
  const data = JSON.parse(await readFile(file, 'utf8')); data.project.name = 'Old\tname'; await writeFile(file, JSON.stringify(data));
  assert.equal((await new OriginStore(board.dataDir).read(made.id)).name, 'Old\tname');
  await board.importBackup({ version: 1, kind: 'kanban-backup', projects: [{ id: 'tabbed', name: 'Tab\tbed', cards: [] }] });
  assert.deepEqual((await new Board({ dataDir: board.dataDir }).state()).projects.map(project => project.name), ['Tab\tbed']);
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

test('damaged saved-prompt files are kept aside, never overwritten by the next saves', async t => {
  const { prompts } = await local(t);
  for (const title of ['One', 'Two']) await prompts.create('p1', ['p1'], { title, prompt: `${title} body` });
  const file = join(prompts.dir, 'prompts-p1.json'), good = await readFile(file, 'utf8');
  await writeFile(file, good.slice(0, -20)); await writeFile(`${file}.bak`, good.slice(0, 50));
  assert.equal((await prompts.list(['p1'])).length, 0);
  for (const title of ['Three', 'Four']) await prompts.create('p1', ['p1'], { title, prompt: `${title} body` });
  const kept = (await readdir(prompts.dir)).filter(name => name.includes('.corrupt-'));
  assert.equal(kept.length, 2);
  assert.ok((await Promise.all(kept.map(name => readFile(join(prompts.dir, name), 'utf8')))).some(text => text.includes('One body')));
});

test('prompts saved to one project at the same moment all survive', async t => {
  const { prompts } = await local(t);
  await Promise.all(Array.from({ length: 8 }, (_, i) => prompts.create('p1', ['p1'], { title: `T${i}`, prompt: `Body ${i}` })));
  assert.deepEqual((await prompts.list(['p1'])).map(prompt => prompt.title).sort(), Array.from({ length: 8 }, (_, i) => `T${i}`));
});

test('board import and browser migration keep the one-name rule across Origin', async t => {
  const { app, call } = await client(t);
  await call('/api/origin/projects', 'POST', { name: 'Shop' });
  const backup = { version: 1, kind: 'kanban-backup', projects: [{ id: 'imported', name: 'shop', cards: [] }] };
  assert.equal((await call('/api/board/import', 'POST', { backup })).status, 200);
  assert.equal((await call('/api/board/migrate', 'POST', { board: { version: 1, projects: [{ id: 'browser', name: 'SHOP', cards: [] }] } })).status, 200);
  assert.deepEqual((await app.board.state()).projects.map(project => project.name), ['shop (2)', 'SHOP (3)']);
});

test('a board import or browser migration at the same moment as an Origin or Compose create still gives one project per name', async t => {
  const { call } = await client(t);
  const using = async name => (await call('/api/shared-projects')).data.projects.filter(project => [project.name, project.kanban?.name].some(used => used?.toLowerCase() === name)).length;
  for (let i = 0; i < 3; i++) {
    await Promise.all([call('/api/board/import', 'POST', { backup: { version: 1, kind: 'kanban-backup', projects: [{ id: `imported-${i}`, name: `Shop ${i}`, cards: [] }] } }), call('/api/origin/projects', 'POST', { name: `shop ${i}` })]);
    await Promise.all([call('/api/board/migrate', 'POST', { board: { version: 1, projects: [{ id: `browser-${i}`, name: `Blog ${i}`, cards: [] }] } }), call('/api/shared-projects', 'POST', { name: `blog ${i}` })]);
    for (const name of [`shop ${i}`, `blog ${i}`]) assert.equal(await using(name), 1, `projects named ${name}`);
  }
});

test('a saved prompt keeps the Compose options and terminology it was made with', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-prompts-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const prompts = new PromptStore(dataDir);
  const settings = { provider: 'codex', model: 'gpt-5.5', options: { acceptanceChecks: true, planFirst: false, 'bad key': true, edgeCases: 'yes' }, terminology: 'Order = a paid cart' };
  const { prompt } = await prompts.create('p1', ['p1'], { title: 'Checkout', prompt: 'Build checkout.', settings });
  const saved = prompt.revisions?.at(-1)?.settings ?? prompt.settings;
  assert.deepEqual([saved.options, saved.terminology], [{ acceptanceChecks: true, planFirst: false }, 'Order = a paid cart']);
});
