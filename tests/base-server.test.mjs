import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../src/server.mjs';
import { COLUMNS, effectiveWorkflow } from '../src/board.mjs';
import { WikiJobs, parseWikiDraft } from '../src/base-wiki.mjs';

async function world(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-base-http-'));
  const app = await startServer({ port: 0, dataDir, executor: null, detector: async () => [], ...options });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const { token } = await fetch(`${app.url}/api/session`).then(response => response.json());
  const request = async (path, data, method = data === undefined ? 'GET' : 'POST', headers = {}) => {
    const response = await fetch(app.url + path, { method, headers: { 'x-ste-token': token, ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, data: await response.json() };
  };
  const create = async resource => {
    const result = await request('/api/base/resources', { ...resource, expectedBaseRevision: (await app.board.state()).base.revision });
    assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data.resource;
  };
  return { ...app, request, create, dataDir };
}
const skill = { kind: 'skill', name: 'Portable instructions', enabled: true, trust: 'trusted', content: { body: 'A PRIVATE DOCUMENT BODY' } };
const knowledge = { kind: 'knowledge', name: 'Team wiki', enabled: true, trust: 'trusted', content: { pages: [{ id: 'manual', title: 'Manual page', markdown: 'Keep this manual wording.' }], sources: [{ id: 'source-one', name: 'Notes', text: 'The API accepts plain text and returns Markdown.' }] } };

test('Base endpoints are token/origin protected; metadata and Board polling exclude document text and creation assigns nothing', async t => {
  const w = await world(t);
  assert.equal((await w.request('/api/base', undefined, 'GET', { 'x-ste-token': 'wrong' })).status, 403);
  assert.equal((await w.request('/api/base/resources', skill, 'POST', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(w.url + '/base.js')).status, 200);
  assert.equal((await fetch(w.url + '/base/revisions/secret.json')).status, 404);
  const resource = await w.create(skill);
  const metadata = await w.request('/api/base');
  assert.doesNotMatch(JSON.stringify(metadata.data), /PRIVATE DOCUMENT BODY/);
  assert.doesNotMatch(JSON.stringify((await w.request('/api/board')).data), /PRIVATE DOCUMENT BODY/);
  assert.equal((await w.request(`/api/base/resources/${resource.id}`)).data.resource.content.body, skill.content.body);
  const preview = await w.request('/api/base/preview', { target: { scope: 'global' } });
  assert.deepEqual(preview.data.manifest.resources, []);
  assert.equal((await w.board.state()).runs.length, 0);
  const revision = metadata.data.revision;
  await w.board.setSettings({ maxConcurrentRuns: 2 });
  assert.equal((await w.request('/api/base')).data.revision, revision, 'Ordinary settings/polling do not conflict with Base editing.');
});

test('one resource can be applied atomically across real targets, including inherited providers/custom columns/task opt-out', async t => {
  const w = await world(t), resource = await w.create(skill);
  const a = await w.board.createProject({ name: 'First' }), b = await w.board.createProject({ name: 'Second' });
  const task = await w.board.createTask({ projectId: a.id, title: 'Task', prompt: 'Exact task text' });
  const columns = COLUMNS.map(column => ({ id: column.id })); columns.splice(3, 0, { id: 'c_base01', custom: true, title: 'Specialist', agent: { enabled: true, instructions: 'Do the work.' } });
  await w.board.setColumns(a.id, { columns, expectedRevision: a.revision });
  const binding = { mode: 'extend', include: [{ resourceId: resource.id, required: true }], exclude: [] };
  const before = (await w.board.state()).base.revision;
  const changes = [{ target: { scope: 'project', projectId: a.id }, binding, expectedRevision: 0 }, { target: { scope: 'column', projectId: b.id, columnId: 'executing' }, binding, expectedRevision: 0 }];
  assert.equal((await w.request('/api/base/apply', { changes, expectedBaseRevision: before })).status, 200);
  const conflict = await w.request('/api/base/apply', { changes: [{ ...changes[0], expectedRevision: 1 }, { ...changes[1], expectedRevision: 0 }], expectedBaseRevision: before + 1 });
  assert.equal(conflict.status, 409);
  assert.equal((await w.board.state()).projects[0].baseRevision, 1, 'No partial write on a later target conflict.');
  const preview = await w.request('/api/base/preview', { target: { scope: 'task-column', projectId: a.id, taskId: task.id, columnId: 'c_base01' } });
  assert.equal(preview.data.manifest.resources[0].resourceId, resource.id);
  assert.equal((await w.request('/api/base/apply', { changes: [{ target: { scope: 'task-column', projectId: a.id, taskId: task.id, columnId: 'c_base01' }, binding: { mode: 'replace', include: [], exclude: [] }, expectedRevision: 0 }], expectedBaseRevision: before + 1 })).status, 200);
  const state = await w.board.state(), saved = state.projects[0].tasks[0];
  assert.equal(saved.contentRevision, 1); assert.equal(saved.prompt, 'Exact task text');
  const copy = await w.board.duplicateTask(task.id); assert.deepEqual(copy.baseColumns, saved.baseColumns); assert.equal(copy.workspace, null);
  const optOut = await w.request('/api/base/preview', { target: { scope: 'task-column', projectId: a.id, taskId: task.id, columnId: 'c_base01' } });
  assert.deepEqual(optOut.data.manifest.resources, []);
  const project = (await w.board.state()).projects[0];
  await w.board.setWorkflow(a.id, { workflow: {}, agentDefaults: { provider: 'gemini', model: 'custom-model' }, expectedRevision: project.revision });
  assert.equal((await w.board.view()).projects[0].baseBinding.include[0].resourceId, resource.id);
  assert.equal((await w.board.view()).projects[0].effectiveWorkflow['c_base01'].provider, 'gemini');
});

test('profile defaults stay in their configuration scope and explicit provider tuples override without mixing', async t => {
  const w = await world(t), resource = await w.create(skill);
  const profile = await w.create({ kind: 'profile', name: 'Reusable Claude', enabled: true, trust: 'trusted', configuration: { agent: { provider: 'claude', model: 'profile-model', effort: 'high' }, binding: { mode: 'extend', include: [{ resourceId: resource.id, required: true }], exclude: [] } } });
  const project = await w.board.createProject({ name: 'Profiles' });
  await w.board.base.apply({ changes: [{ target: { scope: 'project', projectId: project.id }, profileId: profile.id, binding: { mode: 'inherit' } }] });
  let state = await w.board.state(), agent = effectiveWorkflow(state.projects[0], null, state).executing;
  assert.equal(agent.provider, 'claude'); assert.equal(agent.model, 'profile-model'); assert.equal(agent.effort, 'high');
  await w.board.setWorkflow(project.id, { workflow: { executing: { provider: 'codex', model: 'different', effort: 'low' } }, expectedRevision: state.projects[0].revision });
  state = await w.board.state(); agent = effectiveWorkflow(state.projects[0], null, state).executing;
  assert.equal(agent.provider, 'codex'); assert.equal(agent.model, 'different'); assert.equal(agent.effort, 'low');
  const preview = await w.request('/api/base/preview', { target: { scope: 'column', projectId: project.id, columnId: 'executing' } });
  assert.ok(preview.data.manifest.resources.some(item => item.resourceId === resource.id));
});

test('wiki generation returns a reviewable draft through the shared restricted runner and guards manual edits', async t => {
  let folder, captured;
  const w = await world(t, { runner: async value => { folder = value.cwd; captured = value.prompt; await access(folder); return { text: JSON.stringify({ pages: [{ id: 'api', title: 'API', markdown: '# API\nPlain text → Markdown. [[manual]]', sourceIds: ['source-one'] }] }) }; } });
  const wiki = await w.create(knowledge);
  const generated = await w.request('/api/base/wiki/generate', { resourceId: wiki.id, expectedRevision: wiki.revision, provider: 'codex', sourceIds: ['source-one'], operationId: 'wiki-operation-one' });
  assert.equal(generated.status, 200, JSON.stringify(generated.data));
  assert.match(captured, /documentation drafting request/); assert.match(captured, /API accepts plain text/);
  assert.doesNotMatch(captured, /ASD-STE100|Simplified Technical English/);
  await assert.rejects(access(folder));
  assert.equal((await w.board.base.detail(wiki.id)).content.pages.length, 1, 'Generation does not save over manual pages.');
  generated.data.draft.pages[0].markdown += '\nA reviewed user edit.';
  const applied = await w.request('/api/base/wiki/apply', { resourceId: wiki.id, expectedRevision: wiki.revision, draft: generated.data.draft });
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  const saved = await w.board.base.detail(wiki.id);
  assert.equal(saved.content.pages[0].markdown, 'Keep this manual wording.');
  assert.match(saved.content.pages[1].markdown, /reviewed user edit/);
  assert.deepEqual(saved.content.pages[1].provenance.sourceIds, ['source-one']);
  assert.equal((await w.request('/api/base/wiki/apply', { resourceId: wiki.id, expectedRevision: wiki.revision, draft: generated.data.draft })).status, 409);
  assert.equal((await w.board.state()).runs.length, 0);
  const search = await w.request(`/api/base/resources/${wiki.id}/search?q=reviewed`); assert.ok(search.data.results.some(result => result.text.includes('reviewed user edit')));
  const refresh = await w.request(`/api/base/resources/${wiki.id}/refresh`, { expectedRevision: saved.revision });
  assert.equal(refresh.status, 400); assert.equal((await w.board.base.detail(wiki.id)).content.sources.length, 1, 'Refresh never clears pasted sources.');
});

test('refresh replaces live captures without deleting pasted sources or accumulating stale captures', async t => {
  const w = await world(t), upstream = await w.create(knowledge);
  const collection = await w.create({ ...knowledge, name: 'Mixed sources', configuration: { sources: [{ kind: 'knowledge', resourceId: upstream.id }] } });
  const refresh = async () => {
    const saved = await w.board.base.detail(collection.id);
    const response = await w.request(`/api/base/resources/${collection.id}/refresh`, { expectedRevision: saved.revision });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return w.board.base.detail(collection.id);
  };
  let saved = await refresh();
  assert.equal(saved.content.sources.find(source => source.id === 'source-one')?.text, knowledge.content.sources[0].text);
  assert.equal(saved.content.sources.length, 2);
  await w.board.base.update(upstream.id, { content: { pages: [{ id: 'replacement', title: 'New page', markdown: 'Fresh documentation' }] } }, { expectedRevision: upstream.revision });
  saved = await refresh();
  assert.equal(saved.content.sources.length, 2, 'A removed live page is replaced, while the pasted source remains.');
  assert.ok(saved.content.sources.some(source => source.text === 'Fresh documentation'));
  assert.equal(saved.content.sources.some(source => source.text === 'Keep this manual wording.'), false);
  assert.equal((await refresh()).content.sources.length, 2, 'Repeated refresh does not duplicate captures.');
});

test('context refresh keeps same-named pages from separate knowledge collections distinct', async t => {
  const w = await world(t), first = await w.create(knowledge);
  const second = await w.create({ ...knowledge, name: 'Another wiki', content: { pages: [{ id: 'manual', title: 'Manual page', markdown: 'Different collection text' }] } });
  const context = await w.create({ kind: 'context', name: 'Both wikis', enabled: true, trust: 'trusted', configuration: { sources: [{ kind: 'knowledge', resourceId: first.id }, { kind: 'knowledge', resourceId: second.id }] } });
  const response = await w.request(`/api/base/resources/${context.id}/refresh`, { expectedRevision: context.revision });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const sources = (await w.board.base.detail(context.id)).content.sources;
  assert.equal(sources.length, 2); assert.equal(new Set(sources.map(source => source.id)).size, 2);
  assert.deepEqual(sources.map(source => source.text), ['Keep this manual wording.', 'Different collection text']);
});

test('wiki operation cancellation is scoped and shares Compose/auth job coordination', async t => {
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  const w = await world(t, { runner: ({ signal }) => new Promise((resolve, reject) => { enter(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) });
  const wiki = await w.create(knowledge);
  const pending = w.request('/api/base/wiki/generate', { resourceId: wiki.id, expectedRevision: wiki.revision, provider: 'codex', operationId: 'wiki-current-job' });
  await entered;
  assert.equal((await w.request('/api/generate', { input: 'Other request', provider: 'codex' })).status, 409);
  assert.equal((await w.request('/api/base/wiki/cancel', { operationId: 'wiki-unrelated-job' })).data.cancelled, false);
  assert.equal((await w.request('/api/status')).data.busy.kind, 'wiki');
  assert.equal((await w.request('/api/base/wiki/cancel', { operationId: 'wiki-current-job' })).data.cancelled, true);
  assert.equal((await pending).status, 499);
  assert.equal((await w.request('/api/status')).data.busy, null);
  assert.equal((await w.board.base.detail(wiki.id)).revision, wiki.revision);
});

test('MCP tests are explicit and trust checked; sanitized discovery status persists without starting agents', async t => {
  let calls = 0;
  const w = await world(t, { mcpTester: async () => { calls++; return { status: 'connected', tools: [{ name: 'lookup' }], resources: [], prompts: [], server: { name: 'fixture', version: '1' } }; } });
  let resource = await w.create({ kind: 'mcp', name: 'Fixture', enabled: false, trust: 'untrusted', configuration: { transport: 'stdio', command: process.execPath } });
  assert.equal(calls, 0);
  assert.equal((await w.request(`/api/base/resources/${resource.id}/test`, { expectedRevision: resource.revision })).status, 409);
  assert.equal(calls, 0);
  resource = await w.board.base.update(resource.id, { trust: 'trusted' }, { expectedRevision: resource.revision });
  const result = await w.request(`/api/base/resources/${resource.id}/test`, { expectedRevision: resource.revision });
  assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(calls, 1);
  assert.equal((await w.board.base.detail(resource.id)).connectionTest.status, 'connected');
  assert.equal((await w.board.state()).runs.length, 0);
  assert.doesNotMatch(await readFile(join(w.dataDir, 'state.json'), 'utf8'), /PRIVATE DOCUMENT BODY/);
  const source = await w.request('/api/base/source/import', { url: 'http://127.0.0.1:12345/private.txt' });
  assert.equal(source.status, 409); assert.equal(source.data.code, 'BASE_PRIVATE_NETWORK');
});

test('wiki draft generation rejects concurrent manual edits and always releases the shared job slot', async t => {
  let enter, finish, folder;
  const entered = new Promise(resolve => { enter = resolve; });
  const w = await world(t, { runner: value => { folder = value.cwd; enter(); return new Promise(resolve => { finish = resolve; }); } });
  const wiki = await w.create(knowledge);
  const pending = w.request('/api/base/wiki/generate', { resourceId: wiki.id, expectedRevision: wiki.revision, provider: 'codex', operationId: 'wiki-stale-draft' });
  await entered;
  const resource = await w.board.base.detail(wiki.id);
  await w.board.base.update(wiki.id, { content: { ...resource.content, pages: [{ id: 'manual', title: 'Manual', markdown: 'A concurrent manual edit.' }] } }, { expectedRevision: resource.revision });
  finish({ text: JSON.stringify({ pages: [{ id: 'manual', title: 'Overwritten?', markdown: 'Generated old data', sourceIds: ['source-one'] }] }) });
  const result = await pending;
  assert.equal(result.status, 409); assert.equal(result.data.code, 'RESOURCE_REVISION_CONFLICT'); assert.equal((await w.request('/api/status')).data.busy, null);
  assert.equal((await w.board.base.detail(wiki.id)).content.pages[0].markdown, 'A concurrent manual edit.'); await assert.rejects(access(folder));
});

test('wiki cancellation during initial resource loading prevents a later model job from starting', async () => {
  let finishRead, claimCount = 0, runnerCount = 0;
  const jobs = new WikiJobs({ board: { base: { detail: () => new Promise(resolve => { finishRead = resolve; }) } }, runner: () => { runnerCount++; }, claim: () => { claimCount++; }, track: value => value });
  const pending = jobs.generate({ resourceId: 'wiki', expectedRevision: 1, operationId: 'cancel-before-read', provider: 'codex' });
  assert.equal(jobs.cancel('cancel-before-read').cancelled, true);
  finishRead({ ...knowledge, id: 'wiki', revision: 1 });
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(claimCount, 0); assert.equal(runnerCount, 0); assert.equal(jobs.operations.size, 0);
});

test('malformed wiki output and forged source identities fail safely without saving', async t => {
  assert.throws(() => parseWikiDraft('null', []), { code: 'BASE_WIKI_OUTPUT' });
  assert.throws(() => parseWikiDraft(JSON.stringify({ pages: [{ id: 'p', title: 'P', markdown: 'Text', sourceIds: [] }] }), []), { code: 'BASE_WIKI_OUTPUT' });
  const w = await world(t), wiki = await w.create(knowledge);
  const forged = await w.request('/api/base/wiki/apply', { resourceId: wiki.id, expectedRevision: wiki.revision, draft: { pages: [{ id: 'new', title: 'New', markdown: 'Unverified claim', provenance: { sourceIds: ['missing'] } }] } });
  assert.equal(forged.status, 400);
  const malformed = await w.request('/api/base/wiki/apply', { resourceId: wiki.id, expectedRevision: wiki.revision, draft: { pages: [null] } });
  assert.equal(malformed.status, 400); assert.equal((await w.board.base.detail(wiki.id)).revision, wiki.revision);
});

test('imports cannot treat prototype property names as remapped resource references', async t => {
  const w = await world(t);
  const result = await w.request('/api/base/import/preview', { data: { kind: 'promptboard-base', version: 1, resources: [{ id: 'pack', kind: 'pack', name: 'Bad pack', configuration: { resources: [{ resourceId: 'constructor' }] } }] } });
  assert.equal(result.status, 400); assert.equal((await w.board.base.list()).resources.length, 0); assert.equal({}.polluted, undefined);
  const resource = await w.create({ ...skill, id: '__proto__' });
  const exported = await w.board.base.export({ ids: [resource.id], includeContent: true });
  const copied = await w.board.base.import(exported); assert.ok(Object.hasOwn(copied.remap, '__proto__')); assert.notEqual(copied.remap.__proto__, resource.id);
  assert.equal((await w.board.base.detail(copied.remap.__proto__)).name, resource.name);
});
