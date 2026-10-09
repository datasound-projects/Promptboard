import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../public/base.js', import.meta.url), 'utf8');
const skill = { id: 'res_skill', kind: 'skill', name: 'Review checklist', description: 'Check invariants.', tags: [], enabled: true, trust: 'trusted', revision: 1, dependencies: [], configuration: { format: 'instruction' }, content: { body: 'Preserve this instruction exactly.\n', files: [] } };
const pack = { id: 'res_pack', kind: 'pack', name: 'Project essentials', description: '', tags: [], enabled: true, trust: 'trusted', revision: 1, dependencies: [], configuration: { resources: [{ resourceId: skill.id, required: true }] }, content: {} };
const target = { scope: 'project', projectId: 'project_a' };
const taskColumn = { scope: 'task-column', projectId: 'project_a', taskId: 'task_a', columnId: 'c_custom_01' };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let n = 0; n < 100; n++) { if (fn()) return; await wait(10); } assert.fail(`Timed out: ${label}`); }

function setup(t, { resources = [skill, pack], respond, savedView } = {}) {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:4318/#/base', runScripts: 'outside-only' });
  const win = dom.window;
  win.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  win.HTMLDialogElement.prototype.close = function () { this.open = false; };
  // Discarding unsaved editor changes asks first; tests answer yes unless they say otherwise.
  const confirms = []; let confirmAnswer = true;
  win.confirm = message => { confirms.push(message); return confirmAnswer; };
  if (savedView) win.localStorage.setItem('promptboard.base.library-view', JSON.stringify(savedView));
  win.eval(script);
  t.after(async () => { await wait(50); win.close(); });
  const $ = selector => win.document.querySelector(selector);
  const calls = [], announcements = [];
  const state = { revision: 3, resources: structuredClone(resources), providers: { claude: { name: 'Claude Code' } }, targets: [
    { target, label: 'Project Alpha', binding: { mode: 'inherit', include: [], exclude: [] }, revision: 2, provider: 'claude' },
    { target: { scope: 'project', projectId: 'project_b' }, label: 'Project Beta', binding: { mode: 'inherit', include: [], exclude: [] }, revision: 1, provider: 'codex' },
    { target: taskColumn, label: 'Task Alpha · Custom stage', binding: { mode: 'inherit', include: [], exclude: [] }, revision: 4, provider: 'claude' },
  ] };
  const response = data => ({ response: { ok: true }, data });
  const api = async (path, options = {}) => {
    const request = { path, ...options, ...(options.body ? { body: structuredClone(options.body) } : {}) }; calls.push(request);
    const custom = respond && await respond(request, state);
    if (custom) return custom;
    if (path === '/api/base') return response(structuredClone(state));
    if (path === '/api/base/presets') return response({ presets: [{ kind: 'mcp', name: 'Context7', configuration: { transport: 'streamable-http', endpoint: 'https://mcp.context7.com/mcp', headers: { Authorization: 'CONTEXT7_AUTHORIZATION' }, auth: { required: true, description: 'Environment reference; no key stored.' } } }] });
    if (path === '/api/base/preview') return response({ provider: 'claude', manifest: { resources: (options.body.binding?.include || []).map(ref => ({ ...ref, name: state.resources.find(item => item.id === ref.resourceId)?.name, delivery: 'instruction', origins: ['project'], revision: 1 })), warnings: [], errors: [] } });
    if (path === '/api/base/apply') { state.revision++; return response(structuredClone(state)); }
    if (path === '/api/base/resources' && options.method === 'POST') {
      const item = { ...structuredClone(options.body), id: `res_${state.resources.length}`, revision: 1 }; state.resources.push(item); state.revision++; return response({ resource: item });
    }
    const resourcePath = /^\/api\/base\/resources\/([^/]+)$/.exec(path);
    if (resourcePath) {
      const item = state.resources.find(item => item.id === resourcePath[1]);
      if (options.method === 'PATCH') { Object.assign(item, structuredClone(options.body), { revision: item.revision + 1 }); state.revision++; }
      return response({ resource: structuredClone(item) });
    }
    if (path.endsWith('/test')) return response({ connection: { status: 'connected', tools: [{ name: 'lookup', description: 'Lookup docs' }] } });
    if (path === '/api/base/wiki/generate') return response({ draft: { pages: [{ id: 'page_one', title: 'Draft page', markdown: '# Generated draft', links: [] }] }, sources: ['source_one'] });
    if (path === '/api/base/wiki/apply') return response({});
    if (path.startsWith('/api/runs/')) return response({ manifest: { resources: [{ resourceId: skill.id, name: skill.name, revision: 1, required: true, delivery: 'instruction' }], supplied: [{ resourceId: skill.id, delivery: 'instruction', hash: 'abc123', capturedAt: '2026-10-02T00:00:00Z' }], observed: [] } });
    return response({});
  };
  const view = win.PromptboardBase.create({ api, announce: value => announcements.push(value), ensureBoard: async () => {}, refreshBoard: async () => {},
    agentFields: () => { const node = win.document.createElement('div'); node.textContent = 'Existing provider controls'; return node; }, readAgentFields: () => ({ provider: 'claude', model: 'fixture' }) });
  const clickText = (text, root = win.document) => { const node = [...root.querySelectorAll('button')].find(node => node.textContent === text || node.getAttribute('aria-label') === text); assert.ok(node, `button ${text}`); node.click(); return node; };
  const change = (node, value) => { node.value = value; node.dispatchEvent(new win.Event('change', { bubbles: true })); };
  const submit = form => form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  return { win, $, view, calls, state, announcements, clickText, change, submit, confirms, answerConfirm: value => { confirmAnswer = value; } };
}

test('Base library creates a real instruction draft without assigning or testing anything', async t => {
  const ctx = setup(t), { $, view, calls, clickText, change, submit } = ctx;
  await view.show();
  assert.equal($('#base-list').children.length, 2);
  assert.match($('#base-list').textContent, /Available · trusted · r1/);
  change($('#base-new-kind'), 'skill'); clickText('Create');
  $('#base-resource-name').value = 'Exact instructions';
  $('#base-skill-body').value = 'Keep $HOME literal.\n\nOriginal trailing space. ';
  submit($('.base-resource-form'));
  await until(() => calls.some(call => call.path === '/api/base/resources' && call.method === 'POST'), 'create skill');
  const create = calls.find(call => call.path === '/api/base/resources' && call.method === 'POST');
  assert.equal(create.body.content.body, 'Keep $HOME literal.\n\nOriginal trailing space. ');
  assert.equal(create.body.expectedBaseRevision, 3);
  assert.equal(calls.some(call => /apply|\/test$|generate/.test(call.path)), false);
  await until(() => $('#base-list').children.length === 3, 'saved list');
  $('#base-search').value = 'Exact'; $('#base-search').dispatchEvent(new ctx.win.Event('input'));
  assert.equal($('#base-list').children.length, 1);
  clickText('MCPs'); assert.equal($('#base-list').children.length, 0); assert.equal($('#base-empty').hidden, false);
});

test('Base sidebar categories change the visible collection, editor, creation type and empty state', async t => {
  const profile = { ...skill, id: 'profile_a', kind: 'profile', name: 'Engineer', configuration: { agent: { provider: 'claude' }, binding: { mode: 'extend', include: [{ resourceId: skill.id, required: true }], exclude: [] } }, content: {} };
  const { $, view, clickText } = setup(t, { resources: [skill, profile] });
  await view.show(); await view.openResource(skill.id); clickText('Agents');
  assert.equal($('#base-categories').closest('#base-sidebar-panel') !== null, true);
  assert.equal($('#base-category-heading').textContent, 'Agents'); assert.equal($('#base-list').children.length, 1); assert.equal($('#base-detail').hidden, true);
  assert.equal($('.base-agent-card .base-agent-loadout input').checked, true);
  assert.match($('.base-agent-card').textContent, /Review checklist/);
  clickText('Agents'); assert.equal($('#base-new-kind').value, 'profile');
  clickText('MCPs'); assert.equal($('#base-list').children.length, 0); assert.match($('#base-empty').textContent, /No mcps yet/);
  clickText('Create'); assert.equal($('.base-resource-form').dataset.kind, 'mcp'); assert.equal($('#base-detail').hidden, false);
});

test('profile editor equips other profiles and saves an explicitly generated AI avatar with its draft', async t => {
  const child = { ...skill, id: 'child_agent', kind: 'profile', configuration: { agent: {}, binding: { mode: 'inherit', include: [], exclude: [] } }, content: {} };
  const image = { mime: 'image/png', data: 'iVBORw0KGgo=' }, avatar = { version: 2, prompt: 'Purple scientist', model: 'image-fixture', contentHash: 'a'.repeat(64) };
  const { $, view, calls, clickText, change, submit } = setup(t, { resources: [skill, child], respond: request => request.path === '/api/base/avatar/generate' ? { response: { ok: true }, data: { avatar, image } } : null });
  await view.show(); change($('#base-new-kind'), 'profile'); clickText('Create');
  $('#base-resource-name').value = 'Lead engineer'; $('#base-avatar-prompt').value = avatar.prompt;
  const refs = $('.base-binding-fields .settings-group'); refs.querySelector(`[data-resource="${child.id}"]`).checked = true;
  clickText('Generate avatar'); await until(() => $('.base-avatar-editor img'), 'AI avatar preview');
  assert.equal(calls.some(call => call.path === '/api/base/resources' && call.method === 'POST'), false, 'Generating does not save or assign.');
  submit($('.base-resource-form')); await until(() => calls.some(call => call.path === '/api/base/resources' && call.method === 'POST'), 'profile saved');
  const saved = calls.find(call => call.path === '/api/base/resources' && call.method === 'POST').body;
  assert.equal(saved.configuration.binding.include[0].resourceId, child.id); assert.deepEqual(saved.configuration.avatar, avatar); assert.deepEqual(saved.content.avatar, image);
});

test('a task-column picker opts out with empty Replace and never changes provider/profile settings', async t => {
  const { $, view, calls, change, submit } = setup(t);
  await view.openPicker(taskColumn);
  assert.equal($('[data-base-profile]'), null);
  change($('[data-base-mode]'), 'replace');
  submit($('#base-dialog-content form'));
  await until(() => calls.some(call => call.path === '/api/base/apply'), 'apply task-column binding');
  const applied = calls.find(call => call.path === '/api/base/apply').body;
  assert.deepEqual(applied, { expectedBaseRevision: 3, changes: [{ target: taskColumn, expectedRevision: 4, binding: { mode: 'replace', include: [], exclude: [] } }] });
  assert.equal('provider' in applied.changes[0], false); assert.equal('profileId' in applied.changes[0], false);
});

test('bulk application previews targets and sends one atomic revision-checked assignment request', async t => {
  const { $, view, calls, clickText, win } = setup(t);
  await view.show(); await view.openResource(skill.id); clickText('Apply to…');
  await until(() => $('.base-apply-targets'), 'target list');
  const boxes = [...$('.base-apply-targets').querySelectorAll('input')].slice(0, 2);
  for (const box of boxes) { box.checked = true; box.dispatchEvent(new win.Event('change', { bubbles: true })); }
  assert.equal([...$('#base-dialog-content').querySelectorAll('button')].find(node => node.textContent === 'Apply assignments').disabled, true);
  clickText('Preview changes');
  await until(() => [...$('#base-dialog-content').querySelectorAll('button')].some(node => node.textContent === 'Apply assignments' && !node.disabled), 'bulk preview');
  assert.match($('#base-dialog-content').textContent, /Project Alpha/); assert.match($('#base-dialog-content').textContent, /Project Beta/);
  clickText('Apply assignments');
  await until(() => calls.some(call => call.path === '/api/base/apply'), 'bulk apply');
  const applications = calls.filter(call => call.path === '/api/base/apply');
  assert.equal(applications.length, 1); assert.equal(applications[0].body.changes.length, 2);
  assert.deepEqual(applications[0].body.changes.map(item => item.expectedRevision), [2, 1]);
  assert.equal(applications[0].body.changes.every(item => !('profileId' in item)), true);
});

test('Base displays stale-write rejection without closing or discarding the editor', async t => {
  const { $, view, submit } = setup(t, { respond: request => request.method === 'PATCH' ? { response: { ok: false }, data: { code: 'BASE_REVISION_CONFLICT', error: 'Resource changed. Reload before saving.' } } : null });
  await view.show(); await view.openResource(skill.id);
  $('#base-skill-body').value = 'Unsaved manual draft'; submit($('.base-resource-form'));
  await until(() => $('.base-resource-form .inline-error')?.textContent, 'stale rejection');
  assert.match($('.base-resource-form .inline-error').textContent, /Resource changed/);
  assert.equal($('#base-skill-body').value, 'Unsaved manual draft');
  assert.equal($('#base-resource-save').disabled, false);
});

test('Markdown preview treats HTML and unsafe links as text while linked pages remain navigable', t => {
  const { win } = setup(t); let page;
  const rendered = win.PromptboardBase.markdown('<img src=x onerror=alert(1)>\n[bad](javascript:alert) [secure](https://example.com) [next](base:page_two) [[page_three|Generated link]]\n```\n<script>alert(1)</script>\n```', id => { page = id; });
  assert.equal(rendered.querySelector('img, script'), null);
  assert.equal(rendered.querySelectorAll('a').length, 1);
  assert.equal(rendered.querySelector('a').getAttribute('rel'), 'noopener noreferrer');
  assert.match(rendered.textContent, /<img src=x onerror=alert\(1\)>/);
  rendered.querySelector('button').click(); assert.equal(page, 'page_two');
  rendered.querySelectorAll('button')[1].click(); assert.equal(page, 'page_three');
});

test('knowledge editing preserves exact manual Markdown and generation requires explicit draft review', async t => {
  const wiki = { ...skill, id: 'res_wiki', kind: 'knowledge', name: 'Engineering wiki', configuration: {}, content: { pages: [{ id: 'page_one', title: 'Manual page', markdown: 'Keep my manual prose.', links: [] }], sources: [{ id: 'source_one', name: 'Readme', text: 'Source text', provenance: { path: 'README.md' } }] } };
  const { $, view, calls, clickText, submit, win } = setup(t, { resources: [wiki] });
  await view.show(); await view.openResource(wiki.id);
  $('#base-wiki-markdown').value = '# My own wiki\nExact text. ';
  submit($('.base-resource-form'));
  await until(() => calls.some(call => call.method === 'PATCH'), 'save wiki');
  assert.equal(calls.find(call => call.method === 'PATCH').body.content.pages[0].markdown, '# My own wiki\nExact text. ');
  assert.equal(calls.some(call => call.path.includes('/wiki/generate')), false);
  await until(() => $('#base-wiki-markdown')?.value === '# My own wiki\nExact text. ' && !$('#base-resource-save').disabled, 'wiki saved');
  clickText('Generate/update from sources…'); clickText('Generate draft');
  await until(() => [...$('#base-dialog-content').querySelectorAll('button')].some(node => node.textContent === 'Apply reviewed draft' && !node.hidden), 'wiki draft');
  const generate = calls.find(call => call.path === '/api/base/wiki/generate');
  assert.deepEqual(generate.body.sourceIds, ['source_one']); assert.match(generate.body.operationId, /^wiki_/);
  assert.equal(calls.some(call => call.path === '/api/base/wiki/apply'), false);
  const proposed = [...$('#base-dialog-content').querySelectorAll('textarea')].at(-1); proposed.value = 'Edited draft before apply'; proposed.dispatchEvent(new win.Event('input'));
  clickText('Apply reviewed draft');
  await until(() => calls.some(call => call.path === '/api/base/wiki/apply'), 'apply edited draft');
  assert.equal(calls.find(call => call.path === '/api/base/wiki/apply').body.draft.pages[0].markdown, 'Edited draft before apply');
});

test('MCP discovery requires an explicit test action; Context7 preset remains inactive and untrusted', async t => {
  const mcp = { ...skill, id: 'res_mcp', kind: 'mcp', name: 'Docs MCP', trust: 'untrusted', configuration: { transport: 'streamable-http', endpoint: 'https://example.com/mcp', headers: {} }, content: {} };
  const { $, view, calls, clickText, submit } = setup(t, { resources: [mcp] });
  await view.show(); await view.openResource(mcp.id);
  assert.equal(calls.some(call => call.path.endsWith('/test')), false);
  clickText('Test connection and discover tools');
  await until(() => calls.some(call => call.path.endsWith('/test')), 'explicit connection test');
  clickText('Context7 preset');
  await until(() => $('#base-resource-name').value === 'Context7', 'Context7 preset loaded');
  assert.equal($('#base-resource-enabled').checked, false); assert.equal($('#base-resource-trust').value, 'untrusted');
  submit($('.base-resource-form'));
  await until(() => calls.some(call => call.path === '/api/base/resources' && call.method === 'POST'), 'preset saved');
  const create = calls.find(call => call.path === '/api/base/resources' && call.method === 'POST');
  assert.equal(create.body.configuration.endpoint, 'https://mcp.context7.com/mcp');
  assert.equal(create.body.enabled, false); assert.equal(create.body.trust, 'untrusted');
  assert.equal(calls.filter(call => call.path.endsWith('/test')).length, 1);
});

for (const outcome of ['connected', 'failed']) test(`MCP ${outcome} discovery refreshes editor revisions before retrying or saving`, async t => {
  const mcp = { ...skill, id: 'res_mcp', kind: 'mcp', configuration: { transport: 'stdio', command: 'fixture', args: [] }, content: {} };
  const { $, view, calls, clickText, submit } = setup(t, { resources: [mcp], respond: (request, state) => {
    if (!request.path.endsWith('/test')) return;
    const item = state.resources[0]; item.revision++; state.revision++;
    item.connectionTest = { status: outcome, testedRevision: item.revision };
    return outcome === 'failed' ? { response: { ok: false }, data: { code: 'BASE_MCP_FAILED', error: 'Fixture connection failed.' } }
      : { response: { ok: true }, data: { resource: structuredClone(item), result: item.connectionTest } };
  } });
  await view.show(); await view.openResource(mcp.id);
  clickText('Test connection and discover tools');
  await until(() => $('.base-resource-form').textContent.includes('r2'), 'editor reflects persisted test revision');
  if (outcome === 'failed') assert.match($('.base-resource-form').textContent, /Fixture connection failed/);
  $('#base-resource-name').value = 'Edited after discovery'; submit($('.base-resource-form'));
  await until(() => calls.some(call => call.method === 'PATCH'), 'save after discovery');
  const saved = calls.find(call => call.method === 'PATCH').body;
  assert.equal(saved.expectedRevision, 2); assert.equal(saved.expectedBaseRevision, 4);
});

test('saved-resource actions preserve drafts and refresh source text before a later save', async t => {
  const wiki = { ...skill, id: 'res_wiki', kind: 'knowledge', configuration: { sources: [{ kind: 'knowledge', resourceId: skill.id }] }, content: { pages: [], sources: [{ id: 'live', name: 'Live source', text: 'Old capture' }] } };
  const { $, view, calls, clickText, win, submit } = setup(t, { resources: [wiki], respond: (request, state) => {
    if (!request.path.endsWith('/refresh')) return;
    const item = state.resources[0]; item.revision++; state.revision++; item.content.sources[0].text = 'Fresh capture';
    return { response: { ok: true }, data: { resource: structuredClone(item) } };
  } });
  await view.show(); await view.openResource(wiki.id);
  $('#base-resource-name').value = 'Unsaved title'; $('#base-resource-name').dispatchEvent(new win.Event('input', { bubbles: true }));
  clickText('Refresh saved sources');
  await until(() => $('.base-resource-form').textContent.includes('Save your edits'), 'dirty draft guarded');
  assert.equal(calls.some(call => call.path.endsWith('/refresh')), false); assert.equal($('#base-resource-name').value, 'Unsaved title');
  await view.openResource(wiki.id); clickText('Refresh saved sources');
  await until(() => [...$('.base-source-list').querySelectorAll('textarea')].some(node => node.value === 'Fresh capture'), 'refreshed content displayed');
  submit($('.base-resource-form'));
  await until(() => calls.some(call => call.method === 'PATCH'), 'save fresh source content');
  const saved = calls.find(call => call.method === 'PATCH').body;
  assert.equal(saved.expectedRevision, 2); assert.equal(saved.expectedBaseRevision, 4); assert.equal(saved.content.sources[0].text, 'Fresh capture');
});

test('run inspection keeps configured, supplied, and observed facts separate and scopes next-run edits', async t => {
  const { $, view, calls, clickText, win } = setup(t);
  await view.show();
  const node = view.runManifest({ id: 'run_one', taskId: taskColumn.taskId, projectId: taskColumn.projectId, stage: taskColumn.columnId, config: { provider: 'claude' }, baseManifest: { resources: [{ resourceId: skill.id }] } });
  win.document.body.append(node); assert.match(node.textContent, /Configured for this accepted run/);
  clickText('Inspect supplied resources', node);
  await until(() => node.textContent.includes('abc123'), 'supplied manifest');
  assert.match(node.textContent, /Observed invocation: not reported/);
  clickText('Configure resources for next run…', node);
  await until(() => $('[data-base-mode]'), 'next-run picker');
  assert.match($('#base-dialog-content').textContent, /do not reconfigure a running CLI session/);
  assert.equal(calls.some(call => call.path.includes('/runs/') && call.method), false);
});


const categoryCases = [['', 'All'], ['agent', 'Agents'], ['pack', 'Packs'], ['mcp', 'MCPs'], ['skill', 'Skills'], ['knowledge', 'Knowledge'], ['context', 'Context'], ['tool', 'Tools']];
const categoryResources = () => categoryCases.slice(1).flatMap(([type], index) => [true, false].map(enabled => ({ ...skill, id: `${type}_${enabled}`, type, kind: type === 'agent' ? 'profile' : type, name: `coding ${type} ${enabled}`, enabled, updatedAt: index * 10 + (enabled ? 1 : 2), configuration: type === 'agent' ? { agent: {}, binding: { mode: 'inherit', include: [], exclude: [] } } : {} })));

test('exactly eight categories filter stored types locally with shared AND filters, sort, view and canonical counts', async t => {
  const { $, win, view, calls, clickText, change } = setup(t, { resources: categoryResources() });
  await view.show();
  assert.deepEqual([...$('#base-categories').children].map(node => node.getAttribute('aria-label')), categoryCases.map(([, name]) => name));
  assert.equal($('#base-categories [aria-pressed="true"]').dataset.kind, '');
  assert.equal($('#base-list').children.length, 14);
  for (const [type, label] of categoryCases) {
    clickText(label); assert.equal($('#base-categories [aria-pressed="true"]').dataset.kind, type);
    assert.equal($('#base-categories').querySelectorAll('[aria-pressed="true"]').length, 1);
    assert.equal($('#base-list').children.length, type ? 2 : 14);
    if (type) assert.equal($('#base-new-kind').value, type === 'agent' ? 'profile' : type);
  }
  $('#base-search').value = 'coding'; $('#base-search').dispatchEvent(new win.Event('input'));
  change($('#base-filter'), 'enabled'); change($('#base-sort'), 'name'); change($('#base-view-mode'), 'list');
  clickText('Agents'); clickText('Skills');
  assert.equal($('#base-search').value, 'coding'); assert.equal($('#base-filter').value, 'enabled');
  assert.equal($('#base-sort').value, 'name'); assert.equal($('#base-view-mode').value, 'list');
  assert.equal($('#base-list').children.length, 1); assert.equal($('#base-list .base-resource').dataset.resourceId, 'skill_true');
  assert.equal($('#base-list').classList.contains('base-list-mode'), true);
  assert.equal($('#base-categories [data-kind="skill"] .base-category-count').textContent, '2');
  clickText('All'); assert.equal($('#base-list').children.length, 7);
  await view.show(); assert.equal(calls.filter(call => call.path === '/api/base').length, 1, 'Category changes and revisiting cached Base never refetch.');
  const stored = JSON.parse(win.localStorage.getItem('promptboard.base.library-view'));
  assert.deepEqual(stored, { category: '', search: 'coding', filter: 'enabled', sort: 'name', viewMode: 'list' });
});

test('validated preferences restore category/search/filter/sort/view and details restore list scroll', async t => {
  const savedView = { category: 'skill', search: 'coding', filter: 'enabled', sort: 'recently_updated', viewMode: 'grid' };
  const { $, view, clickText } = setup(t, { resources: categoryResources(), savedView });
  await view.show(); assert.equal($('#base-list').children.length, 1); assert.equal($('#base-search').value, savedView.search);
  $('.base-list-panel').scrollTop = 95; await view.openResource('skill_true');
  assert.equal($('#base-filter').value, 'enabled'); clickText('Back to library');
  assert.equal($('#base-detail').hidden, true); assert.equal($('.base-list-panel').scrollTop, 95);
  clickText('Knowledge'); assert.equal($('.base-list-panel').scrollTop, 0); assert.equal($('#base-sort').value, savedView.sort);
  const invalid = setup(t, { savedView: { category: 'imaginary', search: 12, filter: 'unknown', sort: 'broken', viewMode: 'broken' } });
  await invalid.view.show(); assert.equal(invalid.$('#base-categories [aria-pressed="true"]').dataset.kind, '');
  assert.equal(invalid.$('#base-sort').value, 'recently_updated'); assert.equal(invalid.$('#base-view-mode').value, 'grid');
});

test('empty search and category states retain active filters and use the shared contextual creation flow', async t => {
  const { $, win, view, clickText, change } = setup(t, { resources: [] }); await view.show();
  for (const [type, label] of categoryCases.slice(1)) {
    clickText(label); assert.equal($('#base-empty').hidden, false); assert.equal($('#base-categories [aria-pressed="true"]').dataset.kind, type);
    clickText('Create'); assert.equal($('.base-resource-form').dataset.kind, type === 'agent' ? 'profile' : type);
    clickText('Back to library');
  }
  clickText('MCPs'); $('#base-search').value = 'github'; $('#base-search').dispatchEvent(new win.Event('input'));
  change($('#base-filter'), 'enabled'); assert.match($('#base-empty').textContent, /No mcps match “github”/);
  clickText('Clear search'); assert.equal($('#base-search').value, ''); assert.equal($('#base-filter').value, 'enabled');
  clickText('Clear filters'); assert.equal($('#base-filter').value, 'all'); assert.equal($('#base-categories [aria-pressed="true"]').dataset.kind, 'mcp');
  clickText('Add MCP'); assert.equal($('.base-resource-form').dataset.kind, 'mcp');
});

test('latest collection request wins while rapid category switches, failures and retry preserve all controls', async t => {
  let resolveFirst, resolveSecond, resolveThird, requestNumber = 0;
  const pending = new Map();
  const { $, win, view, clickText, change } = setup(t, { respond: request => {
    if (request.path !== '/api/base') return null;
    const number = ++requestNumber; return new Promise(resolve => pending.set(number, resolve));
  } });
  const initial = view.show(); await until(() => pending.has(1), 'initial pending collection');
  resolveFirst = pending.get(1);
  clickText('Agents'); clickText('MCPs'); clickText('Skills');
  $('#base-search').value = 'coding'; $('#base-search').dispatchEvent(new win.Event('input'));
  change($('#base-filter'), 'enabled'); change($('#base-sort'), 'name'); change($('#base-view-mode'), 'list');
  assert.equal($('#base-list').children.length, 0); assert.match($('#base-empty').textContent, /Loading skills/);
  const newer = view.refresh(true); await until(() => pending.has(2), 'newer request'); resolveSecond = pending.get(2);
  resolveSecond({ response: { ok: true }, data: { revision: 3, resources: categoryResources() } }); await newer;
  resolveFirst({ response: { ok: false }, data: { error: 'Obsolete initial failure' } }); await initial;
  assert.equal($('#base-list .base-resource').dataset.resourceId, 'skill_true');
  const failure = view.refresh(true); await until(() => pending.has(3), 'failure request'); resolveThird = pending.get(3);
  resolveThird({ response: { ok: false }, data: { error: 'Connection unavailable' } }); await assert.rejects(failure);
  assert.equal($('#base-categories [aria-pressed="true"]').dataset.kind, 'skill');
  assert.equal($('#base-list').children.length, 0); assert.match($('#base-empty').textContent, /Could not load skills/);
  assert.equal($('#base-error').hidden, true); assert.equal($('#base-search').value, 'coding');
  clickText('Retry'); await until(() => pending.has(4), 'retry request');
  assert.equal($('.base-list-panel').getAttribute('aria-busy'), 'true');
  pending.get(4)({ response: { ok: true }, data: { revision: 4, resources: categoryResources() } });
  await until(() => $('#base-list').children.length === 1, 'retry result');
  assert.equal($('#base-filter').value, 'enabled'); assert.equal($('#base-sort').value, 'name'); assert.equal($('#base-view-mode').value, 'list');
  const obsolete = view.refresh(true), latest = view.refresh(true);
  await until(() => pending.has(6), 'overlapping equal-revision refreshes');
  pending.get(6)({ response: { ok: true }, data: { revision: 4, resources: categoryResources() } }); await latest;
  pending.get(5)({ response: { ok: true }, data: { revision: 4, resources: [{ ...skill, name: 'stale' }] } }); await obsolete;
  assert.equal($('#base-list .base-resource').dataset.resourceId, 'skill_true'); assert.equal($('.base-list-panel').getAttribute('aria-busy'), 'false');
});

test('category counts track canonical mutations and keyboard focus alone never changes the filter', async t => {
  const { $, win, view, state, clickText } = setup(t, { resources: categoryResources() }); await view.show();
  const nav = $('#base-categories'), first = nav.firstElementChild; first.focus();
  first.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(win.document.activeElement.dataset.kind, 'agent'); assert.equal(nav.querySelector('[aria-pressed="true"]').dataset.kind, '');
  win.document.activeElement.click(); assert.equal(nav.querySelector('[aria-pressed="true"]').dataset.kind, 'agent');
  state.resources = state.resources.filter(item => item.type !== 'mcp'); state.revision++;
  state.resources.push({ ...skill, type: 'tool', kind: 'tool', id: 'new_tool', name: 'MCP skill in name only' });
  await view.refresh(); clickText('Tools');
  assert.equal($('#base-list').children.length, 3);
  assert.equal(nav.querySelector('[data-kind="mcp"] .base-category-count').textContent, '0');
  assert.equal(nav.querySelector('[data-kind=""] .base-category-count').textContent, '13');
  assert.equal($('#base-search').value, '');
});

test('an editor with unsaved changes is replaced only after confirmation, and leaving the page warns', async t => {
  const { $, view, win, clickText, confirms, answerConfirm, calls } = setup(t);
  await view.show(); await view.openResource(skill.id);
  // Unchanged, or only filled in by the page itself (a model list loading): no question.
  $('#base-skill-body').value = 'Filled in by the page';
  await view.openResource(pack.id); await view.openResource(skill.id);
  assert.equal(confirms.length, 0);
  $('#base-skill-body').value = 'An edit that is not saved yet.'; $('#base-skill-body').dispatchEvent(new win.Event('input', { bubbles: true }));
  const unload = new win.Event('beforeunload', { cancelable: true }); win.dispatchEvent(unload);
  assert.equal(unload.defaultPrevented, true, 'closing the tab warns');
  answerConfirm(false); const before = calls.length;
  clickText('Back to library');
  $('[data-resource-id="res_pack"]').click();
  clickText('Create');
  clickText('Context7 preset');
  assert.equal(confirms.length, 4);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal($('#base-skill-body').value, 'An edit that is not saved yet.', 'the edit is still there');
  assert.equal(calls.length, before, 'nothing was loaded over the edit');
  answerConfirm(true);
  clickText('Back to library');
  assert.equal($('#base-detail').hidden, true, 'confirmed: back to the library');
  assert.equal(confirms.length, 5);
});
