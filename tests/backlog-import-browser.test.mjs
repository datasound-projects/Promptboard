import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';
import { BoardError } from '../src/board.mjs';
import { listGitHubBacklogIssues } from '../src/backlog-github.mjs';
const chrome = await findChrome(), exact = '  Engineered source 雪\r\n{{title}}\r\n  ';
const issue = (number, patch = {}) => ({ id: 100 + number, number, title: `Issue ${number}`, body: exact, state: 'open', html_url: `https://github.com/acme/app/issues/${number}`, labels: [{ name: 'Bug', color: 'ABCDEF' }], assignees: [{ login: 'octo' }], type: { name: 'Bug' }, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z', ...patch });
const item = (id, type = 'select') => `[data-issue-key="github:issue:${id}"] input[data-issue-control="${type}"]`;
const change = (browser, id, value, type = 'change') => browser.eval(`const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event(${JSON.stringify(type)},{bubbles:true}));`);
async function key(browser, selector, space = false) {
  await browser.until(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e&&!e.disabled&&e.getClientRects().length>0;})()`, 'enabled import keyboard control');
  await browser.eval(`const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});e.focus();`);
  assert.equal(await browser.eval(`return document.activeElement===document.querySelector(${JSON.stringify(selector)});`), true);
  const args = { key: space ? ' ' : 'Enter', code: space ? 'Space' : 'Enter', windowsVirtualKeyCode: space ? 32 : 13 };
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', ...args, text: space ? ' ' : '\r' }); await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...args });
}
async function setup(t, rows, { width = 1280, theme = 'light', saved = false, old = false } = {}) {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] }), calls = [];
  app.board.githubIssueReader = async input => { calls.push(input); return listGitHubBacklogIssues(input, { run: async () => JSON.stringify(rows) }); };
  const project = await app.board.createProject({ name: 'Captured issue owner', workflowMode: 'pipeline' });
  const composer = await app.board.createTask({ projectId: project.id, title: 'Composer exact task', prompt: exact, source: { provider: 'codex', quality: 'fast', verification: 'checks-passed' } });
  const source = saved ? await app.board.connectBacklogGitHubSource(project.id, { repository: 'acme/app', expectedImportRevision: 0 }) : null;
  const browser = await launch({ width, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('ste-prompt-engineer.theme',${JSON.stringify(theme)});localStorage.setItem('promptboard.kanban.project',${JSON.stringify(project.id)});window.__writes=[];const nativeFetch=window.fetch;window.fetch=async function(...args){if(args[1]?.method&&!['GET','HEAD'].includes(args[1].method))window.__writes.push({url:args[0],body:JSON.parse(args[1].body)});const response=await Reflect.apply(nativeFetch,this,args);if(${old}&&String(args[0]).endsWith('/api/session')){const data=await response.json();data.capabilities.pipelineBacklogImports=false;return new Response(JSON.stringify(data),{status:response.status,headers:response.headers});}return response;};` });
  await browser.goto(app.url + '/#/kanban'); await browser.resize(width, 900); await browser.until(`document.querySelector('[data-id="${composer.id}"]')`, 'Composer exact board'); await key(browser, '#view-backlog');
  const owner = async () => (await app.board.state()).projects.find(row => row.id === project.id);
  return { app, project, composer, source, browser, calls, owner };
}
async function open(w) { await key(w.browser, '#backlog-import'); await w.browser.until('document.getElementById("backlog-import-dialog").open', 'issue picker'); }
async function ready(w) { await w.browser.until('backlogImportDraft && !backlogImportDraft.reading && !backlogImportDraft.mutation && document.querySelector("#backlog-import-list li")', 'source page loaded'); }

for (const width of [1280, 390]) for (const theme of ['light', 'dark']) test(`persistent issue previews and explicit incremental sync retain inert state in ${width}/${theme}`, { skip: !chrome, timeout: 90000 }, async t => {
  const rows = [issue(1)], w = await setup(t, rows, { width, theme, saved: true }), b = w.browser;
  await open(w); await ready(w); const before = await w.app.board.state(), reads = w.calls.length;
  assert.equal(await b.eval('return backlogImportDraft.cache.cached;'), false);
  await key(b, '#backlog-import-cancel'); await b.until('!document.getElementById("backlog-import-dialog").open', 'closed cached picker');
  await open(w); await ready(w); assert.equal(w.calls.length, reads);
  assert.equal(await b.eval('return backlogImportDraft.cache.cached;'), true);
  assert.match(await b.eval('return document.getElementById("backlog-import-freshness").textContent;'), /Cached page/);
  rows.push(issue(2, { title: 'New literal <img src=x> issue', body: '  New exact\r\n雪  ' }));
  await key(b, '#backlog-import-sync'); await b.until('!backlogImportDraft.reading && backlogImportDraft.cache?.changed===2', 'explicit changed-issue sync');
  assert.equal(w.calls.length, reads + 2); assert.equal(typeof w.calls.at(-2).since, 'string'); assert.equal(w.calls.at(-1).since, undefined);
  assert.equal(await b.eval('return document.querySelectorAll("#backlog-import-list li").length;'), 2);
  assert.equal(await b.eval('return !!document.querySelector("#backlog-import-list img");'), false);
  assert.deepEqual(await w.app.board.state(), before);
  await key(b, item(102), true); assert.equal(await b.eval('return document.getElementById("backlog-import-sync").disabled;'), true);
  assert.equal(await b.layout('const d=document.getElementById("backlog-import-dialog").getBoundingClientRect(),s=document.getElementById("backlog-import-sync").getBoundingClientRect();return d.left>=0&&d.right<=innerWidth&&s.left>=0&&s.right<=innerWidth;'), true);
  await key(b, '#backlog-import-submit'); await b.until('!backlogImportDraft.mutation && backlogImportDraft.selected.size===0', 'fresh selected import after sync');
  const state = await w.app.board.state(), owner = state.projects.find(row => row.id === w.project.id);
  assert.equal(owner.backlog[0].prompt, rows[1].body); assert.equal(owner.tasks.find(row => row.id === w.composer.id).prompt, exact);
  assert.deepEqual(state.base, before.base); assert.deepEqual(state.runs, []); assert.deepEqual(state.sessions, []);
});

test('failed incremental sync keeps the previous cached page and selections require explicit clearing before another sync', { skip: !chrome, timeout: 60000 }, async t => {
  const w = await setup(t, [issue(1)], { saved: true }), b = w.browser; await open(w); await ready(w);
  const reader = w.app.board.githubIssueReader, before = await w.app.board.state();
  w.app.board.githubIssueReader = async () => { throw Object.assign(new Error('GitHub rate-limited this preview. Try again later.'), { code: 'GH_RATE_LIMITED', status: 429 }); };
  await key(b, '#backlog-import-sync'); await b.until('!backlogImportDraft.reading && backlogImportDraft.readError', 'failed incremental read');
  assert.equal(await b.eval('return document.querySelectorAll("#backlog-import-list li").length;'), 1); assert.match(await b.eval('return document.getElementById("backlog-import-error").textContent;'), /rate-limited/);
  await key(b, item(101), true); assert.equal(await b.eval('return document.getElementById("backlog-import-submit").disabled;'), true);
  const writes = await b.eval('return window.__writes.length;'); await b.eval('document.getElementById("backlog-import-sync").click();'); assert.equal(await b.eval('return window.__writes.length;'), writes);
  await key(b, '#backlog-import-clear'); w.app.board.githubIssueReader = reader; await key(b, '#backlog-import-sync'); await ready(w);
  assert.equal(await b.eval('return backlogImportDraft.readError;'), false); assert.deepEqual(await w.app.board.state(), before);
});

test('older cache capability keeps live preview and cannot submit a hidden incremental action', { skip: !chrome, timeout: 60000 }, async t => {
  const w = await setup(t, [issue(1)], { saved: true }), b = w.browser;
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `const previous=window.fetch;window.fetch=async function(...args){const response=await Reflect.apply(previous,this,args);if(String(args[0]).endsWith('/api/session')){const data=await response.json();data.capabilities.pipelineBacklogSourceCache=false;return new Response(JSON.stringify(data),{status:response.status,headers:response.headers});}return response;};` });
  await b.reload(); await key(b, '#view-backlog'); await open(w); await ready(w);
  assert.equal(await b.eval('return document.getElementById("backlog-import-sync").hidden;'), true);
  const before = await w.app.board.state(), reads = w.calls.length, writes = await b.eval('return window.__writes.length;');
  await b.eval('document.getElementById("backlog-import-sync").click();'); assert.equal(w.calls.length, reads); assert.equal(await b.eval('return window.__writes.length;'), writes);
  await key(b, '#backlog-import-refresh'); await ready(w); assert.equal(w.calls.length, reads + 1); assert.deepEqual(await w.app.board.state(), before);
});

for (const width of [1280, 390]) for (const theme of ['light', 'dark']) test(`GitHub issue import preserves hidden selection, exact metadata and Composer in ${width}/${theme}`, { skip: !chrome, timeout: 90000 }, async t => {
  const rows = [issue(1, { title: 'Literal <img src=x> 雪' }), issue(2, { state: 'closed', title: 'Closed feature', type: { name: 'Feature' }, assignees: [{ login: 'dependabot[bot]' }], labels: [{ name: 'Other', color: '654321' }] }), issue(3, { title: 'Hidden bug' })];
  const w = await setup(t, rows, { width, theme }), b = w.browser; await open(w);
  await b.eval('document.getElementById("backlog-import-repository").focus();'); await b.type('Acme/App'); await key(b, '#backlog-import-connect'); await ready(w);
  assert.equal(await b.eval('return document.getElementById("backlog-import-state").value;'), 'open'); assert.equal(await b.eval('return document.querySelectorAll("#backlog-import-list li").length;'), 2);
  assert.equal(await b.eval('return !!document.querySelector("#backlog-import-list img");'), false); assert.equal(await b.eval('return document.querySelector("#backlog-import-list a").href;'), rows[0].html_url);
  const baseline = await w.app.board.state(), reads = w.calls.length; assert.equal(reads, 2);
  await change(b, 'backlog-import-state', 'closed'); assert.equal(await b.eval('return document.querySelectorAll("#backlog-import-list li").length;'), 1);
  await change(b, 'backlog-import-assignee', 'assignee:dependabot[bot]'); await change(b, 'backlog-import-type', 'type:Feature'); await change(b, 'backlog-import-label', 'label:Other');
  await change(b, 'backlog-import-search', '#2', 'input'); assert.equal(await b.eval('return document.querySelector("#backlog-import-list li").dataset.issueKey;'), 'github:issue:102');
  for (const id of ['assignee','type','label']) await change(b, 'backlog-import-' + id, 'all'); await change(b, 'backlog-import-state', 'open'); await change(b, 'backlog-import-search', '', 'input');
  await key(b, item(101), true); await change(b, 'backlog-import-search', 'Hidden', 'input'); await key(b, '#backlog-import-select-visible');
  assert.equal(await b.eval('return document.getElementById("backlog-import-submit").textContent;'), 'Import (2)'); assert.ok(await b.eval('return document.getElementById("backlog-import-progress").textContent.includes("1 hidden");'));
  assert.equal(await b.eval('return document.getElementById("backlog-import-source").disabled;'), true); assert.deepEqual(await w.app.board.state(), baseline); assert.equal(w.calls.length, reads);
  if (process.env.PB_BROWSER_SHOTS) { await mkdir(process.env.PB_BROWSER_SHOTS, { recursive: true }); await writeFile(join(process.env.PB_BROWSER_SHOTS, `backlog-import-${width}-${theme}.png`), await b.screenshot()); }
  assert.equal(await b.layout('const d=document.getElementById("backlog-import-dialog"),r=d.getBoundingClientRect();return d.scrollWidth<=d.clientWidth+1&&r.left>=0&&r.right<=innerWidth;'), true);
  await key(b, '#backlog-import-submit'); await b.until('!backlogImportDraft.mutation && document.getElementById("backlog-import-submit").textContent==="Import (0)"', 'selected import confirmed');
  const owner = await w.owner(); assert.equal(owner.backlog.length, 2); assert.equal(owner.tasks.length, 1); assert.deepEqual(owner.tasks[0], w.composer);
  assert.deepEqual(owner.backlog.map(row => row.externalSource.id), [101,103]); assert.ok(owner.backlog.every(row => row.prompt === exact && row.priority === 0 && row.number === undefined && row.source === null));
  assert.equal(owner.labels[0].name, 'Bug'); assert.equal(owner.labels[0].color, '#abcdef'); assert.deepEqual(owner.backlog[0].externalSource.assignees, ['octo']); assert.equal(owner.revision, w.project.revision); assert.equal(owner.nextTaskNumber, 2);
  const writes = await b.eval('return window.__writes;'); assert.equal(writes.length, 2); assert.deepEqual(writes[1].body, { keys: ['github:issue:101','github:issue:103'], state: 'all', page: 1, titleOverrides: {}, includeAttachments: true, expectedImportRevision: 1, expectedBacklogRevision: 0, expectedLabelRevision: 0 });
  await key(b, '#backlog-import-cancel'); await b.until('!document.getElementById("backlog-import-dialog").open', 'picker closed');
  assert.equal(await b.eval('return document.querySelector("#backlog-list .task-external-source").href;'), rows[0].html_url);
  const state = await w.app.board.state(); assert.deepEqual(state.runs, []); assert.deepEqual(state.sessions, []); assert.deepEqual(b.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);
});

test('long source titles need an explicit short title and imported filters remain inert without another fetch', { skip: !chrome, timeout: 60000 }, async t => {
  const w = await setup(t, [issue(1, { title: 'X'.repeat(121) })], { saved: true }); await open(w); await ready(w); const b = w.browser, before = await w.app.board.state();
  await key(b, item(101), true); assert.equal(await b.eval('return document.getElementById("backlog-import-submit").disabled;'), true);
  await b.eval(`document.querySelector(${JSON.stringify(item(101,'title'))}).focus();`); await b.type('Explicit short title'); assert.deepEqual(await w.app.board.state(), before);
  await key(b, '#backlog-import-submit'); await b.until('!backlogImportDraft.mutation && backlogImportDraft.selected.size===0', 'short title imported');
  const draft = (await w.owner()).backlog[0]; assert.equal(draft.title, 'Explicit short title'); assert.equal(draft.externalSource.title.length, 121); assert.equal(draft.prompt, exact);
  const calls = w.calls.length; await key(b, '#backlog-import-hide-imported', true); assert.ok(await b.eval('return document.querySelector("#backlog-import-list").textContent.includes("Imported ✓");')); assert.equal(await b.eval(`return document.querySelector(${JSON.stringify(item(101))}).disabled;`), true); assert.equal(w.calls.length, calls);
});

test('stale catalog imports preserve selections and typed overrides until explicit refresh choices', { skip: !chrome, timeout: 60000 }, async t => {
  const w = await setup(t, [issue(1, { title: 'Y'.repeat(121) })], { saved: true }); await open(w); await ready(w); const b = w.browser;
  await key(b, item(101), true); await b.eval(`const e=document.querySelector(${JSON.stringify(item(101,'title'))});e.value='My short title';e.dispatchEvent(new Event('input',{bubbles:true}));`);
  await w.app.board.setLabels(w.project.id, { labels: [{ id: 'concurrent', name: 'Concurrent', color: '#123456' }], expectedLabelRevision: 0 });
  await key(b, '#backlog-import-submit'); await b.until('backlogImportDraft.blocked && !backlogImportDraft.mutation', 'stale import refused');
  assert.equal((await w.owner()).backlog.length, 0); assert.equal(await b.eval(`return document.querySelector(${JSON.stringify(item(101,'title'))}).value;`), 'My short title'); assert.equal(await b.eval('return backlogImportDraft.selected.size;'), 1);
  const writes = await b.eval('return window.__writes.length;'); await b.eval('document.getElementById("backlog-import-submit").click();'); assert.equal(await b.eval('return window.__writes.length;'), writes);
  await key(b, '#backlog-import-refresh-choices'); await b.until('!backlogImportDraft.blocked', 'explicit catalog refresh'); assert.equal(await b.eval(`return document.querySelector(${JSON.stringify(item(101,'title'))}).value;`), 'My short title');
  await key(b, '#backlog-import-submit'); await b.until('!backlogImportDraft.mutation && backlogImportDraft.selected.size===0', 'explicit new import'); assert.equal((await w.owner()).backlog[0].title, 'My short title');
});

test('a lost completed import reply requires review and never automatically replays selected issues', { skip: !chrome, timeout: 60000 }, async t => {
  const w = await setup(t, [issue(1)], { saved: true }); await open(w); await ready(w); const b = w.browser;
  await b.eval(`const previous=window.fetch;window.fetch=async function(...args){const response=await Reflect.apply(previous,this,args);if(args[1]?.method==='POST'&&String(args[0]).endsWith('/import'))return new Response(JSON.stringify({error:'Lost reply'}),{status:502});return response;};`);
  await key(b, item(101), true); await key(b, '#backlog-import-submit'); await b.until('backlogImportDraft.blocked && !backlogImportDraft.mutation', 'unknown reply review');
  assert.equal((await w.owner()).backlog.length, 1); assert.equal((await w.owner()).backlogImported.length, 1); assert.equal(await b.eval('return backlogImportDraft.selected.size;'), 1);
  const writes = await b.eval('return window.__writes.length;'); await b.eval('document.getElementById("backlog-import-submit").click();'); assert.equal(await b.eval('return window.__writes.length;'), writes);
  await key(b, '#backlog-import-refresh-choices'); await b.until('!backlogImportDraft.blocked', 'known identity refreshed'); assert.equal(await b.eval('return backlogImportDraft.selected.size;'), 0); assert.equal((await w.owner()).backlog.length, 1); assert.equal(await b.eval('return window.__writes.length;'), writes);
});

test('source removal defaults to Keep and removes configuration without deleting imported identities', { skip: !chrome, timeout: 60000 }, async t => {
  const w = await setup(t, [issue(1)], { saved: true }); const owner = await w.owner(); await w.app.board.importGitHubBacklogIssues(w.project.id, w.source.id, { keys: ['github:issue:101'], expectedImportRevision: 1, expectedBacklogRevision: 0, expectedLabelRevision: 0 });
  await w.browser.reload(); await key(w.browser, '#view-backlog'); await open(w); await w.browser.until('!backlogImportDraft.reading', 'imported source read');
  const b = w.browser, before = await w.app.board.state(); await key(b, '#backlog-import-remove-source'); assert.equal(await b.eval('return document.activeElement.id;'), 'backlog-import-keep-source'); await key(b, '#backlog-import-keep-source'); assert.deepEqual(await w.app.board.state(), before);
  await key(b, '#backlog-import-remove-source'); await key(b, '#backlog-import-remove-confirmed'); await b.until('!backlogImportDraft.mutation && backlogImportDraft.sources.length===0', 'source removed');
  const after = await w.owner(); assert.equal(after.backlogSources.length, 0); assert.equal(after.backlog.length, 1); assert.equal(after.backlogImported.length, 1); assert.equal(after.revision, owner.revision);
});

test('older servers hide issue import controls and cannot submit programmatic hidden actions', { skip: !chrome, timeout: 60000 }, async t => {
  const w = await setup(t, [issue(1)], { old: true }), before = await w.app.board.state(); assert.equal(await w.browser.eval('return document.getElementById("backlog-import").hidden;'), true);
  await w.browser.eval('document.getElementById("backlog-import").click();document.getElementById("backlog-import-submit").click();document.getElementById("backlog-import-connect-form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));');
  assert.equal(await w.browser.eval('return document.getElementById("backlog-import-dialog").open;'), false); assert.deepEqual(await w.app.board.state(), before); assert.equal(w.calls.length, 0); assert.deepEqual(await w.browser.eval('return window.__writes;'), []);
});

test('raw pull-request-only pages advance and the selected page is captured for import', { skip: !chrome, timeout: 60000 }, async t => {
  const w = await setup(t, [issue(1)], { saved: true }), b = w.browser;
  w.app.board.githubIssueReader = async input => { w.calls.push(input); return listGitHubBacklogIssues(input, { run: async () => JSON.stringify(input.page === 1 ? Array.from({length:100},(_,i)=>issue(i+1,{pull_request:{url:'ignored'}})) : [issue(1)]) }); };
  await open(w); await b.until('backlogImportDraft && !backlogImportDraft.reading && backlogImportDraft.nextPage===2', 'raw-page pagination'); assert.equal(await b.eval('return document.querySelectorAll("#backlog-import-list li").length;'), 0);
  await key(b, '#backlog-import-next'); await ready(w); assert.equal(await b.eval('return document.getElementById("backlog-import-page").textContent;'), 'Page 2');
  await key(b, item(101), true); assert.equal(await b.eval('return document.getElementById("backlog-import-previous").disabled;'), true); await key(b, '#backlog-import-submit'); await b.until('!backlogImportDraft.mutation && backlogImportDraft.selected.size===0', 'page-two import');
  assert.equal(await b.eval('return window.__writes.at(-1).body.page;'), 2); assert.equal((await w.owner()).backlog[0].prompt, exact); assert.equal(w.calls.at(-1).page, 2);
});

test('queued import-dialog close preserves a reopened picker and later draft keyboard focus', { skip: !chrome, timeout: 60000 }, async t => {
  const w = await setup(t, [issue(1)]), b = w.browser; await open(w);
  assert.equal(await b.eval(`return new Promise(resolve=>{const dialog=$('#backlog-import-dialog');dialog.addEventListener('close',()=>resolve(dialog.open&&!!backlogImportDraft&&dialog.contains(document.activeElement)),{once:true});dialog.close();openBacklogImport();});`), true);
  assert.equal(await b.eval(`return new Promise(resolve=>{const dialog=$('#backlog-import-dialog');dialog.addEventListener('close',()=>resolve(document.activeElement.id),{once:true});dialog.close();$('#backlog-new').focus();});`), 'backlog-new');
  assert.deepEqual(await b.eval('return window.__writes;'), []); assert.equal(w.calls.length, 0);
});


test('source access failures retain typed repositories and saved pages require an explicit read retry', { skip: !chrome, timeout: 60000 }, async t => {
  const w = await setup(t, [issue(1)]), b = w.browser, reader = w.app.board.githubIssueReader;
  w.app.board.githubIssueReader = async input => { w.calls.push(input); throw Object.assign(new Error('Connect GitHub before previewing issues.'), { code: 'GH_AUTH_REQUIRED', status: 409 }); };
  await open(w); await b.eval('document.getElementById("backlog-import-repository").focus();'); await b.type('Acme/App'); await key(b, '#backlog-import-connect');
  await b.until('!backlogImportDraft.mutation && document.getElementById("backlog-import-error").textContent.includes("Connect GitHub")', 'source authentication failure');
  assert.equal(await b.eval('return document.getElementById("backlog-import-repository").value;'), 'Acme/App'); assert.equal((await w.owner()).backlogSources.length, 0); assert.equal((await w.owner()).backlogImportRevision, 0);
  w.app.board.githubIssueReader = reader; await key(b, '#backlog-import-connect'); await ready(w);
  await key(b, item(101), true);
  w.app.board.githubIssueReader = async input => { w.calls.push(input); throw Object.assign(new Error('GitHub issues could not be read.'), { code: 'GH_ISSUES_FAILED', status: 502 }); };
  const before = await w.app.board.state(), writes = await b.eval('return window.__writes.length;'); await key(b, '#backlog-import-refresh');
  await b.until('!backlogImportDraft.reading && backlogImportDraft.readError', 'failed page refresh');
  assert.equal(await b.eval('return backlogImportDraft.selected.size;'), 1); assert.equal(await b.eval('return document.getElementById("backlog-import-submit").disabled;'), true); assert.deepEqual(await w.app.board.state(), before);
  await b.eval('document.getElementById("backlog-import-submit").click();'); assert.equal(await b.eval('return window.__writes.length;'), writes);
  w.app.board.githubIssueReader = reader; await key(b, '#backlog-import-refresh'); await ready(w); assert.equal(await b.eval('return backlogImportDraft.selected.size;'), 1); assert.equal(await b.eval('return document.getElementById("backlog-import-submit").disabled;'), false);
});

test('an accepted import retains its project owner while close, Escape and project changes occur', { skip: !chrome, timeout: 60000 }, async t => {
  const w = await setup(t, [issue(1)], { saved: true }), b = w.browser;
  const other = await w.app.board.createProject({ name: 'Other import owner', workflowMode: 'pipeline' });
  await b.until(`document.querySelector('#project-select option[value="${other.id}"]')`, 'other import project');
  await open(w); await ready(w); await key(b, item(101), true);
  const reader = w.app.board.githubIssueReader; let entered = false, release;
  const held = new Promise(resolve => { release = resolve; }); t.after(() => release());
  w.app.board.githubIssueReader = async input => { entered = true; await held; return reader(input); };
  await key(b, '#backlog-import-submit'); await b.until('backlogImportDraft.mutation', 'accepted import');
  assert.equal(entered, true); assert.equal(await b.eval('return document.getElementById("backlog-import-close").disabled && document.getElementById("backlog-import-cancel").disabled;'), true);
  await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await change(b, 'project-select', other.id); await b.eval('document.getElementById("backlog-import-cancel").click();'); assert.equal(await b.eval('return document.getElementById("backlog-import-dialog").open;'), true);
  release(); await b.until('!backlogImportDraft.mutation && backlogImportDraft.selected.size===0', 'captured owner import confirmation');
  const state = await w.app.board.state(), unchanged = state.projects.find(project => project.id === other.id);
  assert.equal((await w.owner()).backlog.length, 1); assert.deepEqual(unchanged.backlog, []); assert.deepEqual(unchanged.backlogImported, []); assert.equal(unchanged.backlogImportRevision, 0); assert.equal(unchanged.revision, other.revision);
  assert.ok(await b.eval(`return window.__writes.at(-1).url.includes(${JSON.stringify(w.project.id)});`)); assert.deepEqual(state.runs, []); assert.deepEqual(state.sessions, []);
});

test('uncertain inline-image import responses require review before explicit text-only recovery', { skip: !chrome, timeout: 60000 }, async t => {
  const url = 'https://github.com/user-attachments/assets/abc123', body = exact + `![screenshot](${url})`, w = await setup(t, [issue(1, { body })], { saved: true, width: 390, theme: 'dark' }), { browser: b } = w;
  w.app.board.imageDownloader = async () => { throw new BoardError('Image request failed unexpectedly. Uncheck images to import text only.', 'TASK_FILE_IMPORT_FAILED', 500); };
  await open(w); await ready(w); assert.equal(await b.eval('return document.getElementById("backlog-import-images").checked;'), true); await key(b, item(101), true);
  const before = await w.app.board.state(); await key(b, '#backlog-import-submit'); await b.until('backlogImportDraft.blocked&&!backlogImportDraft.mutation', 'image failure requires review');
  assert.deepEqual(await w.app.board.state(), before); assert.match(await b.eval('return document.getElementById("backlog-import-error").textContent;'), /Uncheck images/);
  await key(b, '#backlog-import-refresh-choices'); await b.until('!backlogImportDraft.blocked', 'review unchanged import choices'); await key(b, '#backlog-import-images', true); assert.equal(await b.eval('return document.getElementById("backlog-import-images").checked;'), false);
  await key(b, '#backlog-import-submit'); await b.until('!backlogImportDraft.mutation&&backlogImportDraft.imported.has("github:issue:101")', 'explicit text-only import');
  const owner = await w.owner(); assert.equal(owner.backlog[0].prompt, body); assert.equal(owner.backlog[0].attachments, undefined); assert.deepEqual((await w.app.board.state()).runs, []); assert.deepEqual((await w.app.board.state()).sessions, []); assert.equal(owner.tasks[0].prompt, exact);
});

test('the import picker saves public inline-image bytes separately while retaining the exact issue and Composer prompts', { skip: !chrome, timeout: 60000 }, async t => {
  const url = 'https://github.com/user-attachments/assets/abc123', body = exact + `<img src="${url}">`, w = await setup(t, [issue(1, { body })], { saved: true }), b = w.browser;
  let downloads = 0; w.app.board.imageDownloader = async value => { assert.equal(value, url); downloads++; return { name: 'screenshot.png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=' }; };
  await open(w); await ready(w); await key(b, item(101), true); await key(b, '#backlog-import-submit'); await b.until('!backlogImportDraft.mutation&&backlogImportDraft.imported.has("github:issue:101")', 'image import completed');
  const owner = await w.owner(); assert.equal(downloads, 1); assert.equal(owner.backlog[0].prompt, body); assert.equal(owner.backlog[0].attachments[0].name, 'screenshot.png'); assert.equal(owner.tasks[0].prompt, exact); assert.deepEqual((await w.app.board.state()).runs, []); assert.deepEqual((await w.app.board.state()).sessions, []);
  assert.equal((await w.app.board.taskAttachment(w.project.id, owner.backlog[0].attachments[0])).size, 68);
});

test('confirmed inline-image failures preserve selections and allow only an explicit text-only retry without automatic replay', { skip: !chrome, timeout: 60000 }, async t => {
  const url = 'https://github.com/user-attachments/assets/abc123', body = exact + `![screenshot](${url})`, w = await setup(t, [issue(1, { body })], { saved: true }), b = w.browser;
  let downloads = 0; w.app.board.imageDownloader = async () => { downloads++; throw new BoardError('Image unavailable. Uncheck images to import text only.', 'TASK_FILE_IMPORT_FAILED', 409); };
  await open(w); await ready(w); await key(b, item(101), true); const before = await w.app.board.state(); await key(b, '#backlog-import-submit');
  await b.until('!backlogImportDraft.mutation&&backlogImportDraft.error.includes("Uncheck images")', 'confirmed image error');
  assert.deepEqual(await w.app.board.state(), before); assert.equal(downloads, 1); assert.equal(await b.eval('return backlogImportDraft.blocked;'), false); assert.equal(await b.eval('return backlogImportDraft.selected.has("github:issue:101");'), true);
  assert.equal(await b.eval('return window.__writes.length;'), 1);
  await key(b, '#backlog-import-images', true); assert.equal((await w.owner()).backlog.length, 0); assert.equal(downloads, 1); assert.equal(await b.eval('return window.__writes.length;'), 1);
  await key(b, '#backlog-import-submit'); await b.until('!backlogImportDraft.mutation&&backlogImportDraft.imported.has("github:issue:101")', 'manual text-only retry');
  assert.equal(downloads, 1); assert.equal(await b.eval('return window.__writes.at(-1).body.includeAttachments;'), false); assert.equal((await w.owner()).backlog[0].prompt, body); assert.equal((await w.owner()).backlog[0].attachments, undefined); assert.deepEqual((await w.app.board.state()).runs, []);
});
