import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/origin-model.js';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const J = JSON.stringify, Model = globalThis.PromptboardOriginModel;
const chrome = await findChrome();

// Requests the page makes can be failed or held from inside the page: window.__fail is a list of [method, path regexp source].
const FETCH_HOOK = `(() => {
  const real = window.fetch; window.__fail = []; window.__hold = [];
  window.fetch = (url, options = {}) => {
    const path = String(url), method = options.method || 'GET', match = list => list.some(([m, p]) => m === method && new RegExp(p).test(path));
    if (match(window.__fail)) return Promise.resolve(new Response(JSON.stringify({ error: 'Injected failure.' }), { status: 500, headers: { 'Content-Type': 'application/json' } }));
    if (match(window.__hold)) return new Promise((resolve, reject) => options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    return real(url, options);
  };
})();`;

async function setup(t, blueprints) {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [{ id: 'codex', available: true }], runner: async () => { throw new Error('No model call is allowed.'); } });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = async (path, method = 'GET', body) => (await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: J(body) } : {}) })).json();
  const projects = [];
  for (const [name, bp] of blueprints) {
    const { project } = await call('/api/origin/projects', 'POST', { name });
    await call(`/api/origin/projects/${project.id}`, 'PUT', { expectedRevision: project.revision, blueprint: bp });
    projects.push(project);
  }
  const browser = await launch({ width: 1280, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `${FETCH_HOOK} if (!sessionStorage.getItem('seeded')) { localStorage.setItem('promptboard.origin.project', ${J(projects[0].id)}); localStorage.setItem('promptboard.origin.task-view', 'all'); localStorage.setItem('promptboard.origin.more', 'open'); sessionStorage.setItem('seeded', '1'); }` });
  const ev = code => browser.eval(code), wait = (expression, label, ms = 15000) => browser.until(expression, label, ms);
  await browser.goto(`${app.url}/#/origin`);
  await wait(`document.querySelector('#origin-view').dataset.save === 'saved' && document.querySelector('#origin-context-open') && !document.querySelector('#origin-context-open').disabled`, 'Origin loaded');
  const section = async id => { await ev(`document.querySelector('.origin-nav-item[data-section="${id}"]').click();`); await wait(`document.querySelector('#origin-view').dataset.section === ${J(id)}`, id); };
  const saved = () => wait(`document.querySelector('#origin-view').dataset.save === 'saved'`, 'saved');
  const focused = () => ev(`const a = document.activeElement; return a === document.body ? 'BODY' : a.id || a.className || a.textContent;`);
  return { app, call, projects, browser, ev, wait, section, saved, focused };
}

test('Origin unlinks deleted records from tasks, keeps focus on task controls, keeps Contents links in the panel and never stacks dialog handlers', { skip: !chrome, timeout: 180000 }, async t => {
  const bp = Model.emptyBlueprint();
  bp.idea = 'Probe';
  bp.decisions.push({ id: 'd1', key: 'ADR-001', title: 'Database', status: 'proposed' });
  bp.customSections.push({ id: 's1', phase: 'design', title: 'Payments', description: '' });
  bp.milestones.push({ id: 'm1', title: 'First' });
  bp.items.push({ id: 'i1', key: 'IMP-001', title: 'Task one', contextIds: [{ collection: 'decisions', id: 'd1' }, { collection: 'customSections', id: 's1' }] }, { id: 'i2', key: 'IMP-002', title: 'Task two' });
  bp.sequence = { requirements: 0, decisions: 1, items: 2 };
  const { call, projects, ev, wait, section, saved, focused } = await setup(t, [['Probe app', bp]]);
  const [project] = projects;

  // Deleting a record linked under “Also include” counts and removes that link.
  await section('decisions');
  await ev(`document.querySelector('#origin-main .origin-row-open').click();`);
  await wait(`!document.querySelector('#origin-drawer').hidden && document.querySelector('#origin-drawer .origin-delete')`, 'decision drawer');
  await ev(`document.querySelector('#origin-drawer .origin-delete').click();`);
  assert.equal(await ev(`return document.querySelector('#origin-drawer .origin-delete').textContent;`), 'Delete and unlink 1 reference?');
  await ev(`document.querySelector('#origin-drawer .origin-delete').click();`);
  await saved();
  // So does deleting one of your own sections.
  await section('s1');
  await ev(`document.querySelector('.origin-section-delete').click();`);
  await wait(`document.querySelector('#origin-view').dataset.section === 'overview'`, 'section deleted');
  await saved();
  assert.deepEqual((await call(`/api/origin/projects/${project.id}`)).blueprint.items.find(item => item.id === 'i1').contextIds, []);
  await section('plan');
  await ev(`[...document.querySelectorAll('#origin-main .origin-row-open')].find(b => b.textContent.includes('Task one')).click();`);
  await wait(`!document.querySelector('#origin-drawer').hidden && document.querySelector('#origin-drawer [aria-label="Also include"]')`, 'task drawer');
  assert.equal(await ev(`return document.querySelector('#origin-drawer').textContent.includes('Removed record');`), false, 'no stale chip');
  await ev(`document.querySelector('#origin-drawer [aria-label="Close editor"]').click();`);
  await wait(`document.querySelector('#origin-drawer').hidden`, 'drawer closed');

  // Controls that redraw the task list keep keyboard focus.
  await ev(`document.querySelector('#origin-main .origin-check').focus(); document.querySelector('#origin-main .origin-check').click();`);
  await wait(`document.activeElement?.matches('.origin-row[data-id="i1"] .origin-check') && document.activeElement.checked`, 'focus stays on the ticked task')
    .catch(async error => { throw new Error(`${error.message}: ${await focused()}`); });
  await ev(`document.querySelector('#origin-select-drafts').click();`);
  await wait(`document.activeElement?.id === 'origin-select-drafts' && /2 tasks selected/.test(document.querySelector('.origin-selection').textContent)`, 'focus stays on Select all drafts');
  await ev(`[...document.querySelectorAll('.origin-selection button')].find(b => b.textContent === 'Clear').click();`);
  await wait(`document.activeElement?.id === 'origin-select-drafts' && !document.querySelector('#origin-main .origin-check:checked')`, 'focus after Clear');
  await ev(`document.querySelector('.origin-toggle-option[data-view="layers"]').click();`);
  await wait(`document.activeElement?.matches('.origin-toggle-option[data-view="layers"]') && document.activeElement.getAttribute('aria-pressed') === 'true'`, 'focus stays on the view toggle');
  await ev(`const f = document.querySelector('#origin-task-milestone'); f.focus(); f.value = 'm1'; f.dispatchEvent(new Event('change'));`);
  await wait(`document.activeElement?.id === 'origin-task-milestone' && document.activeElement.value === 'm1'`, 'focus stays on the milestone filter');
  await ev(`const f = document.querySelector('#origin-task-milestone'); f.value = ''; f.dispatchEvent(new Event('change'));`);

  // Every in-document link in a Project Context preview, including an older version's, stays in the panel.
  await ev(`document.querySelector('#origin-context-open').click();`);
  await wait(`document.querySelector('#origin-drawer')?.dataset.mode === 'context' && document.querySelector('#origin-context-preview a[href^="#ctx-"]')`, 'context preview');
  await ev(`const m = document.querySelector('#origin-context-more'); m.open = true; [...m.querySelectorAll('.origin-menu-item')].find(b => b.textContent === 'Versions…').click();`);
  await wait(`[...document.querySelectorAll('.origin-context-version button')].some(b => b.textContent === 'View')`, 'versions');
  await ev(`[...document.querySelectorAll('.origin-context-version button')].find(b => b.textContent === 'View').click();`);
  await wait(`document.querySelector('#origin-context-body .origin-context-preview a[href^="#ctx-section"]')`, 'version view');
  const target = await ev(`const link = document.querySelector('#origin-context-body .origin-context-preview a[href^="#ctx-section"]'); link.click(); return link.getAttribute('href').slice(1);`);
  await wait(`document.activeElement?.id === ${J(target)}`, 'anchor focused inside the version');
  assert.equal(await ev(`return location.hash;`), '#/origin', 'the route did not change');
  await ev(`document.querySelector('#origin-drawer [aria-label="Close Project Context"]').click();`);
  await wait(`document.querySelector('#origin-drawer').hidden`, 'context closed');

  // Opening a busy dialog again replaces its Escape guard instead of stacking one per open.
  await ev(`window.__cancelListeners = 0; const add = HTMLDialogElement.prototype.addEventListener; HTMLDialogElement.prototype.addEventListener = function (type, ...rest) { if (type === 'cancel') window.__cancelListeners++; return add.call(this, type, ...rest); }; window.__hold.push(['POST', '/api/split$']);`);
  for (let round = 0; round < 3; round++) {
    await ev(`document.querySelector('.origin-suggest').click();`);
    await wait(`document.querySelector('#origin-suggest-dialog')?.open`, 'suggest dialog');
    if (round < 2) { await ev(`document.querySelector('#origin-suggest-dialog .origin-modal-close').click();`); await wait(`!document.querySelector('#origin-suggest-dialog').open`, 'closed'); }
  }
  assert.equal(await ev(`return window.__cancelListeners;`), 0);
  await ev(`document.querySelector('#origin-suggest-start').click();`);
  await wait(`/Asking your CLI/.test(document.querySelector('#origin-suggest-dialog').textContent)`, 'suggesting');
  assert.equal(await ev(`const d = document.querySelector('#origin-suggest-dialog'), e = new Event('cancel', { cancelable: true }); d.dispatchEvent(e); d.querySelector('.origin-modal-close').click(); return e.defaultPrevented && d.open;`), true, 'a running job keeps the dialog open');
  await ev(`[...document.querySelectorAll('#origin-suggest-dialog button')].find(b => b.textContent === 'Cancel').click();`);
  await wait(`/Cancelled/.test(document.querySelector('#origin-suggest-dialog').textContent)`, 'cancelled');
  assert.equal(await ev(`const d = document.querySelector('#origin-suggest-dialog'), e = new Event('cancel', { cancelable: true }); d.dispatchEvent(e); return e.defaultPrevented;`), false, 'Escape closes once nothing runs');
});

test('Origin keeps a Project Context draft that could not be saved, reads Base again, and deletes a blueprint that failed to load', { skip: !chrome, timeout: 180000 }, async t => {
  const first = Model.emptyBlueprint(), second = Model.emptyBlueprint();
  first.idea = 'First idea';
  first.areas.push({ id: 'a1', section: 'ai', area: 'models', title: 'Claude for planning' });
  second.idea = 'Second idea';
  const { app, call, projects, ev, wait, section, saved } = await setup(t, [['First', first], ['Unreadable', second]]);
  const [one, two] = projects;
  await app.board.base.create({ kind: 'skill', name: 'Review checklist', configuration: { format: 'instruction' }, content: { body: 'Check it.' } });

  // A blueprint that cannot be read can still be deleted from the project menu.
  await ev(`window.__fail.push(['GET', '/api/origin/projects/${two.id}$']); const s = document.querySelector('#origin-project'); s.value = ${J(two.id)}; s.dispatchEvent(new Event('change'));`);
  await wait(`/This blueprint is unavailable/.test(document.querySelector('#origin-main').textContent)`, 'unreadable project');
  await ev(`document.querySelector('#origin-project-menu').open = true; [...document.querySelectorAll('#origin-project-menu .origin-menu-item')].find(b => b.textContent.startsWith('Delete')).click();`);
  await wait(`document.querySelector('#origin-delete-dialog')?.open`, 'delete dialog');
  await ev(`document.querySelector('#origin-delete-dialog-submit').click();`);
  await wait(`!document.querySelector('#origin-delete-dialog').open && document.querySelector('#origin-project').value === ${J(one.id)}`, 'deleted and back on the first project')
    .catch(async error => { throw new Error(`${error.message}: ${await ev(`return document.querySelector('#origin-delete-dialog .origin-inline-error')?.textContent;`)}`); });
  assert.deepEqual((await call('/api/origin/projects')).projects.map(project => project.id), [one.id]);
  await ev(`window.__fail.length = 0;`);
  await saved();

  // Base: a failed read is tried again on the next editor, and Origin reads Base again whenever it is shown.
  await ev(`window.__fail.push(['GET', '/api/base$']);`);
  await section('ai');
  const openArea = async () => { await ev(`document.querySelector('.origin-topic[data-area="models"] .origin-answer-more').click();`); await wait(`!document.querySelector('#origin-drawer').hidden`, 'area drawer'); };
  await openArea();
  await wait(`/Base could not be read/.test(document.querySelector('#origin-drawer').textContent)`, 'failed Base read');
  await ev(`window.__fail.length = 0; document.querySelector('#origin-drawer [aria-label="Close editor"]').click();`);
  await openArea();
  await wait(`[...document.querySelectorAll('#origin-drawer option')].some(o => o.textContent.startsWith('Review checklist'))`, 'Base read again');
  await ev(`document.querySelector('#origin-drawer [aria-label="Close editor"]').click();`);
  await app.board.base.create({ kind: 'skill', name: 'Release notes', configuration: { format: 'instruction' }, content: { body: 'Write them.' } });
  await ev(`location.hash = '#/kanban';`); await wait(`document.querySelector('#origin-view').closest('[hidden]') !== null || location.hash === '#/kanban'`, 'left Origin');
  await ev(`location.hash = '#/origin';`); await wait(`document.querySelector('.origin-topic[data-area="models"] .origin-answer-more')`, 'back in Origin');
  await openArea();
  await wait(`[...document.querySelectorAll('#origin-drawer option')].some(o => o.textContent.startsWith('Release notes'))`, 'new Base resource after showing Origin again');
  await ev(`document.querySelector('#origin-drawer [aria-label="Close editor"]').click();`);

  // A Project Context edit that could not be saved blocks New project and survives Origin's own reload.
  await ev(`document.querySelector('#origin-context-open').click();`);
  await wait(`document.querySelector('#origin-drawer')?.dataset.mode === 'context' && document.querySelector('#origin-context-preview')`, 'context created');
  await ev(`window.__fail.push(['PUT', '/document$']); document.querySelector('#origin-context-tab-edit').click();`);
  await wait(`document.querySelector('#origin-context-editor')`, 'editor');
  await ev(`const a = document.querySelector('#origin-context-editor'); a.value = a.value + '\\nUNSAVED CONTEXT NOTE\\n'; a.dispatchEvent(new Event('input', { bubbles: true }));`);
  await wait(`document.querySelector('#origin-drawer').dataset.contextSave === 'error'`, 'context save failed');
  await ev(`document.querySelector('#origin-new-project').click();`);
  await wait(`document.querySelector('#origin-new-dialog')?.open`, 'new project dialog');
  await ev(`const n = document.querySelector('#origin-new-name'); n.value = 'Another'; document.querySelector('#origin-new-dialog-submit').click();`);
  await wait(`/Project Context has unsaved edits/.test(document.querySelector('#origin-new-dialog .origin-inline-error')?.textContent || '')`, 'New project refused');
  assert.equal((await call('/api/origin/projects')).projects.length, 1, 'nothing was created');
  await ev(`document.querySelector('#origin-new-dialog .origin-modal-close').click();`);
  // Origin's own conflict reload leaves the Project Context draft alone.
  const current = await call(`/api/origin/projects/${one.id}`);
  await call(`/api/origin/projects/${one.id}`, 'PUT', { expectedRevision: current.revision, blueprint: { ...current.blueprint, idea: 'Changed elsewhere' } });
  await section('vision');
  await ev(`const a = document.querySelector('#origin-main textarea'); a.value = 'Edited here'; a.dispatchEvent(new Event('input', { bubbles: true }));`);
  await wait(`document.querySelector('#origin-view').dataset.save === 'conflict'`, 'Origin conflict');
  await ev(`[...document.querySelectorAll('#origin-save button')].find(b => b.textContent === 'Reload saved version').click();`);
  await saved();
  await ev(`window.__fail.length = 0; document.querySelector('#origin-context-open').click();`);
  await wait(`document.querySelector('#origin-drawer')?.dataset.mode === 'context'`, 'context reopened');
  await ev(`document.querySelector('#origin-context-tab-edit').click();`);
  await wait(`document.querySelector('#origin-context-editor')?.value.includes('UNSAVED CONTEXT NOTE')`, 'the unsaved draft is still there');
});
