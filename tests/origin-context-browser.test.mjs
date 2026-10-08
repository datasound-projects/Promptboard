import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import '../public/origin-model.js';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';
import { blueprintFileName } from '../src/origin.mjs';

const J = JSON.stringify, Model = globalThis.PromptboardOriginModel;
const chrome = await findChrome();

function blueprint() {
  const bp = Model.emptyBlueprint();
  bp.idea = 'Release notes hub';
  bp.layers.push({ id: 'L1', name: 'Backend' });
  bp.components.push({ id: 'web', name: '<img src=x onerror="window.__pwned=1">Web', purpose: 'UI' }, { id: 'api', name: 'API', layerId: 'L1', purpose: 'Rules' });
  bp.connections.push({ id: 'c1', from: 'web', to: 'api', label: 'calls', protocol: 'HTTPS' });
  bp.requirements.push({ id: 'r1', key: 'REQ-001', title: 'Publish notes', acceptanceCriteria: 'A maintainer can publish' });
  bp.items.push({ id: 'i1', key: 'IMP-001', title: 'Repository' }, { id: 'i2', key: 'IMP-002', title: 'API', dependsOn: ['i1'] });
  bp.sequence = { requirements: 1, decisions: 0, items: 2 };
  return bp;
}

async function setup(t, { width = 1280, height = 900 } = {}) {
  const generated = [];
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [{ id: 'codex', available: true }], runner: async request => { generated.push(request); throw new Error('No model call is allowed.'); } });
  const kanban = await app.board.createProject({ name: 'Board', workflowMode: 'pipeline' });
  const card = await app.board.createTask({ projectId: kanban.id, title: 'Build sign-in', prompt: 'Exact card prompt' });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = async (path, method = 'GET', body) => { const response = await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: J(body) } : {}) }); return { status: response.status, data: await response.json() }; };
  let { project } = (await call('/api/origin/projects', 'POST', { name: 'Notes app' })).data;
  project = (await call(`/api/origin/projects/${project.id}/link`, 'POST', { expectedRevision: project.revision, kanbanProjectId: kanban.id })).data.project;
  const saved = (await call(`/api/origin/projects/${project.id}`, 'PUT', { expectedRevision: project.revision, blueprint: blueprint() })).data;
  const browser = await launch({ width, height }); assert.ok(browser); t.after(() => browser.close());
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('promptboard.origin.project', ${J(project.id)});` });
  const ev = code => browser.eval(code), wait = (expression, label, ms = 15000) => browser.until(expression, label, ms);
  await browser.goto(`${app.url}/#/origin`);
  await wait(`document.querySelector('#origin-view').dataset.save === 'saved' && document.querySelector('#origin-context-open') && !document.querySelector('#origin-context-open').disabled`, 'Origin loaded');
  const file = async () => JSON.parse(await readFile(join(app.board.store.dir, 'origin', blueprintFileName(project.id)), 'utf8'));
  const menuItem = async (menu, label) => assert.equal(await ev(`const m = document.querySelector(${J(`#${menu}`)}); m.open = true; const b = [...m.querySelectorAll('.origin-menu-item')].find(b => b.textContent === ${J(label)}); if (!b) return false; b.click(); return true;`), true, label);
  const editText = value => ev(`const a = document.querySelector('#origin-context-editor'); a.value = ${J(value)}; a.dispatchEvent(new Event('input', { bubbles: true }));`);
  const docSaved = () => wait(`document.querySelector('#origin-drawer').dataset.contextSave === 'saved'`, 'document saved');
  return { app, kanban, card, project, saved, browser, ev, wait, call, file, menuItem, editText, docSaved, generated };
}

test('Create Context saves pending Origin edits, previews safely, edits independently and regenerates on request', { skip: !chrome, timeout: 180000 }, async t => {
  const { app, project, browser, ev, wait, call, file, menuItem, editText, docSaved, generated } = await setup(t);
  assert.equal(await ev(`return document.querySelector('#origin-context-open').textContent;`), 'Create Context');
  // A pending Origin edit is saved first and appears in the document.
  await ev(`document.querySelector('.origin-nav-item[data-section="vision"]').click();`);
  await wait(`document.querySelector('#origin-section-heading')?.textContent === 'Vision & Scope'`, 'vision');
  await ev(`const a = document.querySelector('#origin-main textarea'); a.value = 'Pending goal text'; a.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#origin-context-open').click();`);
  await wait(`document.querySelector('#origin-drawer')?.dataset.mode === 'context' && document.querySelector('#origin-context-preview h2')`, 'context panel');
  const afterCreate = await file();
  assert.equal(afterCreate.blueprint.vision.summary, 'Pending goal text');
  assert.match(await ev(`return document.querySelector('#origin-context-preview').textContent;`), /Pending goal text/);
  assert.equal(await ev(`return document.querySelector('#origin-context-open').textContent;`), 'Open Context');
  if (process.env.PB_BROWSER_SHOTS) { await mkdir(process.env.PB_BROWSER_SHOTS, { recursive: true }); for (const theme of ['dark', 'light']) { await ev(`document.documentElement.dataset.theme = ${J(theme)};`); await writeFile(join(process.env.PB_BROWSER_SHOTS, `context-1280-${theme}.png`), await browser.screenshot()); } }
  // Safe preview: hostile text stays text; diagrams are drawn locally from the saved code.
  assert.equal(await ev(`return window.__pwned === undefined && !document.querySelector('#origin-context-preview img, #origin-context-preview script');`), true);
  assert.equal(await ev(`return document.querySelectorAll('#origin-context-preview .md-diagram svg').length;`), 2);
  assert.match(await ev(`return document.querySelector('#origin-context-preview .md-diagram-code code').textContent;`), /^flowchart LR\n {2}subgraph L_L1\["Backend"\]/);
  await ev(`document.querySelector('#origin-context-preview a[href="#ctx-section-plan"]').click();`);
  await wait(`document.activeElement?.id === 'ctx-section-plan'`, 'anchor navigation');
  // Editing saves the document only.
  const revision = (await file()).revision;
  await ev(`document.querySelector('#origin-context-tab-edit').click();`);
  await wait(`document.querySelector('#origin-context-editor')`, 'editor');
  const original = await ev(`return document.querySelector('#origin-context-editor').value;`);
  await editText(`${original}\n## My notes\n\nKeep this.\n\n\`\`\`mermaid\nflowchart LR\n  click A call x()\n\`\`\`\n`);
  await docSaved();
  assert.equal((await file()).revision, revision, 'editing the document never saves Origin');
  await ev(`document.querySelector('#origin-context-tab-preview').click();`);
  await wait(`document.querySelector('#origin-context-preview .md-diagram-error')`, 'local diagram error');
  assert.match(await ev(`return document.querySelector('#origin-context-preview .md-diagram-error').textContent;`), /Line 2: this statement is not supported/);
  assert.match(await ev(`return document.querySelector('#origin-context-meta, .origin-context-meta').textContent;`), /Edited/);
  // Origin changes show a marker but change nothing until regeneration.
  const current = await file();
  const changed = structuredClone(current.blueprint); changed.idea = 'A new direction';
  await call(`/api/origin/projects/${project.id}`, 'PUT', { expectedRevision: current.revision, blueprint: changed });
  await ev(`document.querySelector('[aria-label="Close Project Context"]').click(); document.querySelector('#origin-context-open').click();`);
  await wait(`document.querySelector('#origin-context-changed')`, 'Origin changed marker');
  assert.doesNotMatch(await ev(`return document.querySelector('#origin-context-preview').textContent;`), /A new direction/);
  await ev(`document.querySelector('#origin-context-changed').click();`);
  await wait(`document.querySelector('#origin-context-regenerate')`, 'regenerate view');
  assert.match(await ev(`return document.querySelector('#origin-context-body').textContent;`), /reads Origin’s saved design, not this document/);
  await ev(`document.querySelector('#origin-context-regenerate').click();`);
  await wait(`document.querySelector('#origin-context-diff')`, 'comparison');
  const diff = await ev(`return document.querySelector('#origin-context-diff').textContent;`);
  assert.match(diff, /\+ A new direction/); assert.match(diff, /− ## My notes/);
  await ev(`document.querySelector('#origin-context-use-new').click();`);
  await wait(`!document.querySelector('#origin-context-diff') && document.querySelector('#origin-context-preview') && /A new direction/.test(document.querySelector('#origin-context-preview').textContent)`, 'new version');
  assert.doesNotMatch(await ev(`return document.querySelector('#origin-context-preview').textContent;`), /Keep this\./);
  await menuItem('origin-context-more', 'Versions…');
  await wait(`document.querySelectorAll('.origin-context-version').length === 2`, 'versions');
  await ev(`[...document.querySelectorAll('.origin-context-version')].find(row => !/current/.test(row.textContent)).querySelector('button').click();`);
  await wait(`/Keep this\\./.test(document.querySelector('#origin-context-body').textContent)`, 'older version keeps its edits');
  assert.deepEqual(generated, [], 'no model call');
  assert.deepEqual((await app.board.state()).runs, []);
});

test('Use in Base, Kanban and Compose captures the saved revision and changes only what was chosen', { skip: !chrome, timeout: 180000 }, async t => {
  const { app, kanban, card, project, ev, wait, menuItem, generated } = await setup(t);
  await ev(`document.querySelector('#origin-context-open').click();`);
  await wait(`document.querySelector('#origin-context-preview h2')`, 'panel');
  // Base: one copy, not assigned, and a second save creates nothing.
  await menuItem('origin-context-use', 'Save in Base…');
  await ev(`document.querySelector('#origin-context-base').click();`);
  await wait(`/Saved in Base as/.test(document.querySelector('.origin-context-result')?.textContent || '')`, 'saved in Base');
  await ev(`document.querySelector('#origin-context-base').click();`);
  await wait(`/already in Base/.test(document.querySelector('.origin-context-result')?.textContent || '')`, 'no duplicate');
  let state = await app.board.state();
  assert.equal(state.base.resources.length, 1); assert.equal(state.projects[0].tasks[0].baseBinding, undefined);
  // Kanban: one chosen card, chosen sections, an explicit preview first.
  await menuItem('origin-context-use', 'Kanban…');
  await wait(`document.querySelector('#origin-context-scope')`, 'kanban view');
  await ev(`const s = document.querySelector('#origin-context-scope'); s.value = ${J(`task:${card.id}`)}; s.dispatchEvent(new Event('change'));
    for (const box of document.querySelectorAll('.origin-context-sections input[value="s-requirements"], .origin-context-sections input[value="s-architecture"]')) { box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); }`);
  await wait(`!document.querySelector('#origin-context-kanban').disabled && /Uses the Base copy/.test(document.querySelector('#origin-context-kanban-plan').textContent)`, 'kanban preview');
  assert.match(await ev(`return document.querySelector('#origin-context-kanban-plan').textContent;`), /2 sections.*Adds it to Board \/ Build sign-in\. Existing assignments are kept\./s);
  assert.equal((await app.board.state()).base.resources.length, 1, 'the preview changes nothing');
  await ev(`document.querySelector('#origin-context-kanban').click();`);
  await wait(`/Future runs in this scope receive these sections/.test(document.querySelector('#origin-context-kanban-plan').textContent)`, 'assigned');
  state = await app.board.state();
  const task = state.projects[0].tasks.find(entry => entry.id === card.id);
  assert.equal(task.baseBinding.mode, 'extend'); assert.equal(task.prompt, 'Exact card prompt');
  assert.equal(state.base.resources.filter(resource => resource.kind === 'context').length, 1);
  // Compose: the draft stays, the document becomes one optional source and nothing is generated.
  await ev(`location.hash = '#/'`);
  await wait(`document.querySelector('#prompt-input') && !document.querySelector('#prompt-input').closest('[hidden]')`, 'compose');
  await ev(`const input = document.querySelector('#prompt-input'); input.value = 'My own Compose draft'; input.dispatchEvent(new Event('input', { bubbles: true })); location.hash = '#/origin';`);
  await wait(`document.querySelector('#origin-context-open') && !document.querySelector('#origin-context-open').disabled`, 'back in Origin');
  await ev(`document.querySelector('#origin-context-open').click();`);
  await wait(`document.querySelector('#origin-context-preview h2')`, 'panel again');
  await menuItem('origin-context-use', 'Compose…');
  assert.match(await ev(`return document.querySelector('#origin-context-body').textContent;`), /full document: revision 1/);
  await ev(`document.querySelector('#origin-context-compose').click();`);
  await wait(`location.hash === '#/' && /Planned design \\(Origin\\) · Notes app · revision 1/.test(document.querySelector('#context-source-list').textContent)`, 'attached');
  assert.equal(await ev(`return document.querySelector('#prompt-input').value;`), 'My own Compose draft');
  assert.equal(await ev(`return document.querySelector('#context-use-sources').checked && document.querySelector('#context-autonomous').checked;`), true);
  assert.deepEqual(generated, [], 'attaching starts no generation');
  assert.deepEqual((await app.board.state()).runs, []);
  assert.equal(project.kanbanProjectId, kanban.id);
});

test('the panel resizes, works on a narrow screen in both themes, handles conflicts and follows project switches', { skip: !chrome, timeout: 180000 }, async t => {
  const { project, browser, ev, wait, call, editText, docSaved } = await setup(t);
  await ev(`document.querySelector('#origin-context-open').click();`);
  await wait(`document.querySelector('#origin-context-preview h2')`, 'panel');
  // CI runners may open a smaller window than requested; fix the viewport so the desktop panel can grow.
  await browser.resize(1280, 900);
  await wait(`!matchMedia('(max-width: 730px)').matches && Math.round(document.querySelector('#origin-drawer').getBoundingClientRect().width) === 560`, 'desktop panel width');
  const before = await ev(`return document.querySelector('#origin-drawer').getBoundingClientRect().width;`);
  await ev(`const g = document.querySelector('.origin-context-resize'); g.focus(); for (let i = 0; i < 3; i++) g.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));`);
  const after = await ev(`return document.querySelector('#origin-drawer').getBoundingClientRect().width;`);
  assert.equal(Math.round(after - before), 120); assert.equal(await ev(`return localStorage.getItem('promptboard.origin.context-width');`), String(Math.round(after)));
  // A save conflict keeps the text and offers Reload or Keep mine.
  const { data } = await call(`/api/origin/projects/${project.id}/document`);
  await call(`/api/origin/projects/${project.id}/document`, 'PUT', { expectedRevision: data.document.revision, text: `${data.text}\nFrom another window.\n` });
  await ev(`document.querySelector('#origin-context-tab-edit').click();`);
  await editText('Mine');
  await wait(`document.querySelector('#origin-drawer').dataset.contextSave === 'conflict'`, 'conflict');
  assert.match(await ev(`return document.querySelector('#origin-context-save').textContent;`), /Changed in another window.*Reload saved version.*Keep mine/);
  assert.equal(await ev(`return document.querySelector('#origin-context-editor').value;`), 'Mine');
  await ev(`[...document.querySelectorAll('#origin-context-save button')].find(b => b.textContent === 'Keep mine').click();`);
  await docSaved();
  assert.equal((await call(`/api/origin/projects/${project.id}/document`)).data.text, 'Mine');
  // Narrow screen and light theme: a full-width sheet without the resize handle.
  for (const theme of ['light', 'dark']) {
    await browser.resize(390, 800); await ev(`document.documentElement.dataset.theme = ${J(theme)};`);
    await wait(`Math.abs(document.querySelector('#origin-drawer').getBoundingClientRect().width - (document.documentElement.clientWidth - 12)) < 2`, `narrow ${theme}`);
    assert.equal(await ev(`return getComputedStyle(document.querySelector('.origin-context-resize')).display;`), 'none');
    assert.equal(await ev(`const d = document.querySelector('#origin-drawer'), r = d.getBoundingClientRect(); return r.left >= 0 && r.right <= document.documentElement.clientWidth && d.scrollWidth <= d.clientWidth;`), true, 'the panel fits the screen');
    if (process.env.PB_BROWSER_SHOTS) { await mkdir(process.env.PB_BROWSER_SHOTS, { recursive: true }); await writeFile(join(process.env.PB_BROWSER_SHOTS, `context-390-${theme}.png`), await browser.screenshot()); }
  }
  await browser.resize(1280, 900);
  // Escape closes the panel; switching projects closes it and shows the other project's state.
  await ev(`document.querySelector('#origin-context-editor').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
  await wait(`document.querySelector('#origin-drawer').hidden && document.activeElement?.id === 'origin-context-open'`, 'closed with Escape');
  const other = (await call('/api/origin/projects', 'POST', { name: 'Second app' })).data.project;
  await ev(`document.querySelector('#origin-context-open').click();`);
  await wait(`document.querySelector('#origin-drawer').dataset.mode === 'context'`, 'reopened');
  await ev(`location.reload();`);
  await wait(`document.querySelector('#origin-project') && [...document.querySelector('#origin-project').options].some(o => o.value === ${J(other.id)}) && !document.querySelector('#origin-context-open').disabled`, 'reloaded');
  await ev(`const s = document.querySelector('#origin-project'); s.value = ${J(other.id)}; s.dispatchEvent(new Event('change'));`);
  await wait(`document.querySelector('#origin-context-open').textContent === 'Create Context' && !document.querySelector('#origin-context-open').disabled && document.querySelector('#origin-drawer').hidden`, 'other project');
});
