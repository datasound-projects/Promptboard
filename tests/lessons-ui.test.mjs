// Project memory page module (public/lessons.js) in JSDOM, against a small in-memory stand-in for its routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const domSource = await readFile(new URL('../public/dom.js', import.meta.url), 'utf8');
const source = await readFile(new URL('../public/lessons.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(fn, label) { for (let n = 0; n < 300; n++) { if (fn()) return; await tick(); } assert.fail(`Timed out: ${label}`); }
const lesson = (id, kind, text, status = 'suggested', extra = {}) => ({ id, kind, text, evidence: `Evidence for ${id}.`, taskId: 'c1', taskNumber: 4, status, createdAt: 1, ...extra });

function setup(t, memory) {
  const dom = new JSDOM('<div id="project-body"><div class="kanban-toolbar"><div class="toolbar-cell settings-row"><button id="workflow-open">Edit</button></div></div></div><div id="details"></div>', { url: 'http://127.0.0.1/', runScripts: 'outside-only' });
  const win = dom.window, $ = selector => win.document.querySelector(selector), $$ = selector => [...win.document.querySelectorAll(selector)];
  win.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  win.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new win.Event('close')); };
  const errors = []; win.addEventListener('error', event => errors.push(event.error));
  t.after(() => win.close());
  let data = { revision: 5, settings: { enabled: true, provider: '', model: '' }, defaults: { claude: { model: 'haiku', effort: '' }, codex: { model: '', effort: 'low' }, gemini: { model: 'flash', effort: '' } }, rejected: 0, jobs: [], lessons: [], ...memory };
  const calls = [], announced = [], opened = [], kanban = [];
  // The routes as the server answers them: a change on the current revision returns the new memory.
  const api = async (path, options = {}) => {
    const method = options.method || 'GET', body = options.body;
    calls.push({ path, method, body: body && JSON.parse(JSON.stringify(body)) }); // Out of the page's realm, as the server receives it.
    if (method === 'GET') return { response: { ok: true, status: 200 }, data: structuredClone(data) };
    if (body.expectedRevision !== data.revision) return { response: { ok: false, status: 409 }, data: { error: 'Project memory changed since you loaded it. Reload it and try again.' } };
    const next = structuredClone(data); next.revision++;
    const target = next.lessons.find(item => path.endsWith(`/lessons/${item.id}`));
    if (target) { if (body.status) target.status = body.status; if (body.text) Object.assign(target, { text: body.text, edited: true }); if (body.kind) target.kind = body.kind; }
    if (path.endsWith('/lessons/approve')) for (const item of next.lessons) if (body.ids.includes(item.id)) item.status = 'approved';
    if (path.endsWith('/lessons/settings')) next.settings = { ...next.settings, ...Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'expectedRevision')) };
    if (path.startsWith('/api/tasks/')) next.jobs = [{ taskId: 'c1', status: 'queued', trigger: 'owner' }];
    next.lessons = next.lessons.filter(item => item.status !== 'rejected');
    data = next;
    return { response: { ok: true, status: 200 }, data: structuredClone(data) };
  };
  const project = { id: 'p1', name: 'Shop', tasks: [{ id: 'c1', number: 4, title: 'Checkout flow', completion: { kind: 'merged', at: 1 } }, { id: 'c2', number: 5, title: 'Search', completion: null }] };
  win.eval(domSource); win.eval(source);
  const view = win.PromptboardLessons.create({ api, announce: text => announced.push(text), project: () => project, projects: () => [project], openTask: id => opened.push(id), openKanban: (id, then) => { kanban.push(id); then(); } });
  const section = (title, ...nodes) => { const box = win.document.createElement('section'); const heading = win.document.createElement('h3'); heading.textContent = title; box.append(heading, ...nodes); return box; };
  const details = card => { const nodes = view.taskSection(card, section); $('#details').replaceChildren(...nodes); return nodes; };
  const button = (root, text) => [...root.querySelectorAll('button')].find(node => node.textContent === text);
  return { win, $, $$, view, project, details, section, button, calls, announced, opened, kanban, errors, set: change => { data = { ...data, ...change }; } };
}
const changes = calls => calls.filter(call => call.method !== 'GET').map(call => [call.method, call.path, call.body]);

test('a merged card’s suggested lessons are approved, edited and rejected from its details, each on the current revision', async t => {
  const ui = setup(t, { jobs: [{ taskId: 'c1', status: 'done', found: 3 }], lessons: [lesson('l1', 'command', 'Run npm test.'), lesson('l2', 'convention', 'One file per feature.'), lesson('l3', 'gotcha', 'The review wants a test.')] });
  assert.equal(ui.details(ui.project.tasks[1]).length, 0, 'a card that did not merge has no section');
  const [box] = ui.details(ui.project.tasks[0]);
  assert.equal(box.querySelector('h3').textContent, 'Suggested lessons');
  await until(() => ui.$$('#task-lessons .lesson').length === 3, 'suggestions shown');
  assert.deepEqual(ui.$$('#task-lessons .lesson-kind').map(node => node.textContent), ['Command', 'Convention', 'Gotcha']);
  assert.equal(ui.$('#task-lessons .lesson-evidence').textContent, 'Evidence: Evidence for l1.');
  assert.match(ui.$('#task-lessons').textContent, /3 suggestions to review/);
  ui.button(ui.$('[data-id="l1"]'), 'Approve').click();
  await until(() => ui.$$('#task-lessons .lesson').length === 2, 'approved one');
  assert.match(ui.$('#task-lessons').textContent, /1 approved lesson from this card/);
  // Edit: the text and its kind, saved on the next revision; the suggestion stays to be approved.
  ui.button(ui.$('[data-id="l2"]'), 'Edit').click();
  await until(() => ui.$('[data-id="l2"] textarea'), 'editor');
  await tick();
  assert.equal(ui.win.document.activeElement, ui.$('[data-id="l2"] textarea'), 'the editor gets focus');
  const area = ui.$('[data-id="l2"] textarea'), kind = ui.$('[data-id="l2"] select');
  area.value = 'Each feature has its own file in src/.'; area.dispatchEvent(new ui.win.Event('input'));
  kind.value = 'gotcha'; kind.dispatchEvent(new ui.win.Event('change'));
  ui.button(ui.$('[data-id="l2"]'), 'Save').click();
  await until(() => ui.$('[data-id="l2"] .lesson-text')?.textContent === 'Each feature has its own file in src/.', 'saved edit');
  assert.deepEqual(ui.$$('[data-id="l2"] .lesson-head span').map(node => node.textContent), ['Gotcha', 'Edited']);
  ui.button(ui.$('[data-id="l3"]'), 'Reject').click();
  await until(() => !ui.$('[data-id="l3"]'), 'rejected');
  assert.deepEqual(changes(ui.calls), [
    ['PATCH', '/api/projects/p1/lessons/l1', { status: 'approved', expectedRevision: 5 }],
    ['PATCH', '/api/projects/p1/lessons/l2', { text: 'Each feature has its own file in src/.', kind: 'gotcha', expectedRevision: 6 }],
    ['PATCH', '/api/projects/p1/lessons/l3', { status: 'rejected', expectedRevision: 7 }],
  ]);
  assert.ok(ui.announced.includes('Lesson approved.') && ui.announced.includes('Lesson rejected. It is not suggested again.'));
  assert.deepEqual(ui.errors, []);
});

test('while lessons are suggested the details say so; a failure shows its reason with Suggest again; Approve all approves each suggestion shown', async t => {
  const ui = setup(t, { jobs: [{ taskId: 'c1', status: 'running' }] });
  ui.details(ui.project.tasks[0]);
  await until(() => /Suggesting lessons…/.test(ui.$('#task-lessons').textContent), 'running');
  assert.equal(ui.$('#task-lessons [role="status"]').textContent, 'Suggesting lessons…');
  assert.equal(ui.button(ui.$('#task-lessons'), 'Suggest again'), undefined, 'nothing to start while it runs');
  ui.set({ revision: 6, jobs: [{ taskId: 'c1', status: 'failed', reason: 'The CLI is not signed in, or its sign-in expired.' }] });
  ui.details(ui.project.tasks[0]);
  await until(() => /could not be suggested/.test(ui.$('#task-lessons').textContent), 'failed');
  assert.equal(ui.$('#task-lessons .inline-error').textContent, 'Lessons could not be suggested: The CLI is not signed in, or its sign-in expired.');
  ui.button(ui.$('#task-lessons'), 'Suggest again').click();
  await until(() => /Waiting for a free CLI slot/.test(ui.$('#task-lessons').textContent), 'queued again');
  assert.deepEqual(changes(ui.calls), [['POST', '/api/tasks/c1/lessons', { expectedRevision: 6 }]]);
  ui.set({ revision: 9, jobs: [{ taskId: 'c1', status: 'done', found: 2 }], lessons: [lesson('a', 'command', 'npm test'), lesson('b', 'failed_approach', 'Mocking the clock broke the suite.')] });
  ui.details(ui.project.tasks[0]);
  await until(() => ui.$$('#task-lessons .lesson').length === 2, 'two suggestions');
  ui.button(ui.$('#task-lessons'), 'Approve all').click();
  await until(() => !ui.$('#task-lessons .lesson'), 'all approved');
  assert.deepEqual(changes(ui.calls).at(-1), ['POST', '/api/projects/p1/lessons/approve', { ids: ['a', 'b'], expectedRevision: 9 }]);
  assert.match(ui.$('#task-lessons').textContent, /2 approved lessons from this card/);
  ui.set({ jobs: [], lessons: [] });
  ui.details(ui.project.tasks[0]);
  await until(() => /No lessons were suggested for this card/.test(ui.$('#task-lessons').textContent), 'merged before the feature');
  assert.ok(ui.button(ui.$('#task-lessons'), 'Suggest lessons'));
  assert.deepEqual(ui.errors, []);
});

test('Project memory: approved lessons by kind, suggestions linked to their cards, the switch on by default, and the CLI and model under More', async t => {
  const ui = setup(t, { lessons: [lesson('l1', 'command', 'npm test', 'approved', { decidedAt: 2 }), lesson('l2', 'gotcha', 'Tests need Git.', 'approved', { decidedAt: 3 }), lesson('l3', 'convention', 'ESM only.')] });
  ui.view.sync(ui.project, 1);
  await until(() => ui.$('#lessons-summary').textContent === '2 lessons · 1 new', 'settings row');
  assert.equal(ui.$('#workflow-open').closest('.settings-row').nextElementSibling.id, 'lessons-row', 'right after Columns in the project settings');
  ui.$('#lessons-open').click();
  await until(() => ui.$('#lessons-dialog')?.open && ui.$('#lessons-enabled'), 'dialog');
  const dialog = ui.$('#lessons-dialog');
  assert.equal(ui.$('#lessons-heading').textContent, 'Project memory');
  assert.equal(ui.$('#lessons-enabled').checked, true);
  assert.match(dialog.textContent, /One short run with a small model after each merged card\./);
  assert.deepEqual(ui.$$('#lessons-dialog h4').map(node => node.textContent), ['Commands that worked', 'Gotchas']);
  assert.deepEqual(ui.$$('#lessons-dialog .lessons-list .lesson-text').map(node => node.textContent), ['npm test', 'Tests need Git.']);
  assert.equal(ui.$('#lessons-more').open, false, 'CLI and model wait under More');
  // A suggestion links to its card's details.
  const link = ui.$('.lessons-card-link');
  assert.equal(link.textContent, '#4 Checkout flow');
  link.click();
  assert.deepEqual([ui.opened, dialog.open], [['c1'], false]);
  ui.$('#lessons-open').click();
  await until(() => ui.$('#lessons-dialog').open && ui.$('[data-id="l1"]'), 'open again');
  ui.button(ui.$('[data-id="l1"]'), 'Remove').click();
  await until(() => !ui.$('#lessons-dialog [data-id="l1"]'), 'removed');
  ui.$('#lessons-enabled').click();
  await until(() => changes(ui.calls).length === 2, 'switched off');
  await until(() => ui.$('#lessons-summary').textContent === '1 lesson · 1 new · off', 'row says off');
  ui.$('#lessons-more').open = true;
  const cli = ui.$('#lessons-provider'), model = ui.$('#lessons-model');
  assert.deepEqual([...cli.options].map(option => option.textContent), ['The card’s CLI', 'Claude Code', 'Codex', 'Gemini CLI']);
  assert.equal(model.disabled, true, 'a model needs a chosen CLI');
  cli.value = 'codex'; cli.dispatchEvent(new ui.win.Event('change'));
  assert.equal(model.placeholder, 'Default: the CLI’s own model, low effort');
  model.value = 'gpt-5-mini';
  ui.$('#lessons-settings-save').click();
  await until(() => changes(ui.calls).length === 3, 'settings saved');
  assert.deepEqual(changes(ui.calls), [
    ['PATCH', '/api/projects/p1/lessons/l1', { status: 'rejected', expectedRevision: 5 }],
    ['PATCH', '/api/projects/p1/lessons/settings', { enabled: false, expectedRevision: 6 }],
    ['PATCH', '/api/projects/p1/lessons/settings', { provider: 'codex', model: 'gpt-5-mini', expectedRevision: 7 }],
  ]);
  assert.deepEqual(ui.errors, []);
});

test('a stale revision is reported in plain words and the memory is read again', async t => {
  const ui = setup(t, { lessons: [lesson('l1', 'command', 'npm test')] });
  ui.details(ui.project.tasks[0]);
  await until(() => ui.$('[data-id="l1"]'), 'shown');
  ui.set({ revision: 8 }); // Changed in another window.
  ui.button(ui.$('[data-id="l1"]'), 'Approve').click();
  await until(() => ui.$('#task-lessons [role="alert"]'), 'error');
  assert.equal(ui.$('#task-lessons [role="alert"]').textContent, 'Project memory changed since you loaded it. Reload it and try again.');
  ui.button(ui.$('[data-id="l1"]'), 'Approve').click();
  await until(() => !ui.$('[data-id="l1"]'), 'approved on the fresh revision');
  assert.deepEqual(changes(ui.calls).at(-1), ['PATCH', '/api/projects/p1/lessons/l1', { status: 'approved', expectedRevision: 8 }]);
});

test('Origin’s Project Context lists the linked board’s approved lessons read-only, with a link to manage them', async t => {
  const ui = setup(t, { lessons: [lesson('l1', 'command', 'npm test', 'approved'), lesson('l2', 'convention', 'Not yet approved.')] });
  assert.equal(ui.view.contextPanel({ id: 'o9', kanbanProjectId: null }, [ui.project]), null, 'no linked board, no panel');
  const panel = ui.view.contextPanel({ id: 'p1', kanbanProjectId: null }, [ui.project]); // The same ID links them.
  ui.$('#details').replaceChildren(panel);
  await until(() => /\(1\)/.test(panel.querySelector('summary').textContent), 'loaded');
  assert.equal(panel.querySelector('summary').textContent, 'Lessons from finished work (1)');
  assert.deepEqual([...panel.querySelectorAll('li')].map(node => node.textContent), ['npm test']);
  assert.equal(panel.querySelectorAll('textarea, input').length, 0, 'read-only');
  ui.button(panel, 'Manage in Kanban').click();
  await until(() => ui.$('#lessons-dialog')?.open, 'Project memory opens in Kanban');
  assert.deepEqual(ui.kanban, ['p1']);
});
