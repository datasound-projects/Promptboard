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

function setup(t, { resources = [skill, pack], respond } = {}) {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:4318/#/base', runScripts: 'outside-only' });
  const win = dom.window;
  win.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  win.HTMLDialogElement.prototype.close = function () { this.open = false; };
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
  const clickText = (text, root = win.document) => { const node = [...root.querySelectorAll('button')].find(node => node.textContent === text); assert.ok(node, `button ${text}`); node.click(); return node; };
  const change = (node, value) => { node.value = value; node.dispatchEvent(new win.Event('change', { bubbles: true })); };
  const submit = form => form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  return { win, $, view, calls, state, announcements, clickText, change, submit };
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
