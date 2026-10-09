import test from 'node:test';
import assert from 'node:assert/strict';
import { findChrome, launch } from './helpers/browser.mjs';
import { pickProject, shownProject } from './helpers/projects.mjs';
import { startTestServer } from './helpers/test-server.mjs';
import { defaultPipelineConfig } from '../src/pipeline-config.mjs';

const chrome = await findChrome();

// Claude is installed and Codex is not, so a silent reset to Codex would disable Generate.
async function setup(t, { seed = '', width = 1280, height = 900 } = {}) {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [{ id: 'claude', available: true }, { id: 'codex', available: false }],
    authAdapter: { installed: async () => true, status: async () => ({ state: 'signed-in' }) }, runner: async () => ({ text: 'ok' }) });
  const browser = await launch({ width, height }); assert.ok(browser); t.after(() => browser.close());
  if (seed) await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `if (!sessionStorage.getItem('seeded')) { ${seed}; sessionStorage.setItem('seeded', '1'); }` });
  const ev = code => browser.eval(code), wait = (expression, label, ms = 15000) => browser.until(expression, label, ms);
  const key = async (name, code, keyCode) => { await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, text: name, code, windowsVirtualKeyCode: keyCode }); await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: keyCode }); };
  const task = async projectId => (await app.board.state()).projects.find(project => project.id === projectId).tasks;
  return { app, browser, ev, wait, key, task };
}
const noExceptions = browser => assert.deepEqual(browser.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);

test('a window keeps its own project when another window picks one, and N starts a new prompt only on Compose', { skip: !chrome, timeout: 120000 }, async t => {
  const { app, browser, ev, wait, key } = await setup(t);
  const shop = await app.board.createProject({ name: 'Shop', workflowMode: 'pipeline' }), blog = await app.board.createProject({ name: 'Blog', workflowMode: 'pipeline' });
  await app.board.createTask({ projectId: shop.id, title: 'Card A', prompt: 'Build card A.' });
  await browser.goto(`${app.url}/#/`);
  await wait(`token && document.querySelector('#prompt-input')`, 'compose');
  await ev(`const input = document.querySelector('#prompt-input'); input.value = 'My unsent draft'; input.dispatchEvent(new Event('input', { bubbles: true })); location.hash = '#/kanban';`);
  await wait(`document.querySelector('#kanban-columns .kanban-open')`, 'Shop board');
  // Another window (same browser storage) shows Blog. This window still shows Shop and acts on Shop.
  await ev(`localStorage.setItem('promptboard.kanban.project', ${JSON.stringify(blog.id)});`);
  await app.board.createTask({ projectId: shop.id, title: 'Card B', prompt: 'Build card B.' });
  await wait(`document.querySelectorAll('#kanban-columns .kanban-card').length === 2`, 'a board refresh keeps Shop');
  assert.equal(await ev(`return ${shownProject};`), shop.id);
  await ev(`document.querySelector('#kanban-columns .kanban-open').click();`);
  await wait(`document.querySelector('#card-dialog').open`, 'card dialog');
  assert.deepEqual(await ev(`return [document.querySelector('#card-dialog-heading').textContent, document.querySelector('#card-title').value];`), ['Edit card', 'Card A']);
  assert.match(await ev(`return document.querySelector('#card-dialog-project').textContent;`), /Shop · To Do$/);
  await ev(`document.querySelector('#card-dialog').close(); document.querySelector('#card-new').focus();`);
  // N on Kanban does nothing: the page and the Compose draft stay.
  await key('n', 'KeyN', 78);
  assert.deepEqual(await ev(`return [location.hash, document.querySelector('#prompt-input').value];`), ['#/kanban', 'My unsent draft']);
  // On Compose, N still starts a new prompt.
  await ev(`location.hash = '#/';`);
  await wait(`!document.querySelector('#prompt-view').hidden`, 'compose again');
  await ev(`document.querySelector('#settings-toggle').focus();`);
  await key('n', 'KeyN', 78);
  assert.deepEqual(await ev(`return [document.querySelector('#prompt-input').value, document.activeElement.id];`), ['', 'prompt-input']);
  noExceptions(browser);
});

test('Compose handoffs: a card keeps the Compose CLI, a new card starts unlinked, History drops the Origin link, and the editor blocks stale sends', { skip: !chrome, timeout: 120000 }, async t => {
  const entry = { id: 'h1', input: 'Unrelated old request', prompt: 'Unrelated old prompt', createdAt: Date.now(), provider: 'claude' };
  const { app, browser, ev, wait } = await setup(t, { seed: `localStorage.setItem('ste-prompt-engineer.history.v1', ${JSON.stringify(JSON.stringify([entry]))})` });
  const shop = await app.board.createProject({ name: 'Shop', workflowMode: 'pipeline' });
  await app.board.createTask({ projectId: shop.id, title: 'Card A', prompt: 'Build card A.' });
  await browser.goto(`${app.url}/#/`);
  await wait(`token && document.querySelector('#provider').value === 'claude'`, 'the installed CLI is chosen');
  await ev(`document.querySelector('#task').value = 'debug'; document.querySelector('#task').dispatchEvent(new Event('change', { bubbles: true })); location.hash = '#/kanban';`);
  await wait(`document.querySelector('#kanban-columns .kanban-open')`, 'card');
  // An existing card opens linked, with the current Compose CLI and task type.
  await ev(`document.querySelector('#kanban-columns .kanban-open').click();`);
  await wait(`document.querySelector('#card-dialog').open`, 'card dialog');
  await ev(`document.querySelector('#card-refine').click();`);
  await wait(`location.hash === '#/' && document.querySelector('#prompt-input').value === 'Build card A.' && !document.querySelector('#compose-link').hidden`, 'linked card in Compose');
  assert.deepEqual(await ev(`return [document.querySelector('#provider').value, document.querySelector('#task').value, document.querySelector('#provider-note').classList.contains('unavailable')];`), ['claude', 'debug', false]);
  // A new card goes to Compose unlinked: Update card cannot overwrite the earlier card.
  await ev(`location.hash = '#/kanban';`);
  await wait(`!document.querySelector('#kanban-view').hidden && !document.querySelector('#card-new').disabled`, 'Kanban');
  await ev(`document.querySelector('#card-new').click();`);
  await wait(`document.querySelector('#card-dialog').open`, 'new card dialog');
  await ev(`document.querySelector('#card-prompt').value = 'A different new task'; document.querySelector('#card-refine').click();`);
  await wait(`location.hash === '#/' && document.querySelector('#prompt-input').value === 'A different new task'`, 'new card text in Compose');
  assert.deepEqual(await ev(`return [document.querySelector('#compose-link').hidden, document.querySelector('#prompt-output').hidden, document.querySelector('#card-dialog').open];`), [true, true, false]);
  // A History prompt is unrelated to the Origin task: its link goes.
  assert.equal(await ev(`return prefillCompose({ text: 'Origin task text', replace: true, origin: { key: 'K-1', title: 'Origin task' } });`), 'ok');
  assert.equal(await ev(`return document.querySelector('#compose-origin').hidden;`), false);
  await ev(`document.querySelector('.history-restore').click();`);
  assert.deepEqual(await ev(`return [document.querySelector('#compose-origin').hidden, document.querySelector('#prompt-output').textContent];`), [true, 'Unrelated old prompt']);
  // While the prompt editor is open, nothing sends the text from before the edit.
  await ev(`composeOrigin = { key: 'K-1', title: 'Origin task' }; renderComposeOrigin(); projectsView.setLink({ kind: 'card', taskId: 't', number: 1, title: 'Card A', kanbanProjectId: ${JSON.stringify(shop.id)}, prompt: 'Build card A.' });`);
  const sends = '#kanban-button, #project-save-button, #compose-origin-use, #compose-link-update';
  assert.deepEqual(await ev(`return [...document.querySelectorAll(${JSON.stringify(sends)})].map(button => button.disabled);`), [false, false, false, false]);
  await ev(`document.querySelector('#prompt-edit').click();`);
  assert.deepEqual(await ev(`return [...document.querySelectorAll(${JSON.stringify(sends)})].map(button => button.disabled);`), [true, true, true, true]);
  await ev(`document.querySelector('#prompt-edit-cancel').click();`);
  assert.deepEqual(await ev(`return [...document.querySelectorAll(${JSON.stringify(sends)})].map(button => button.disabled);`), [false, false, false, false]);
  noExceptions(browser);
});

test('card edits survive a newer card: a bare revision change saves at once, a real change asks before replacing it', { skip: !chrome, timeout: 120000 }, async t => {
  const { app, browser, ev, wait, task } = await setup(t);
  const shop = await app.board.createProject({ name: 'Shop', workflowMode: 'pipeline' }), old = await app.board.createProject({ name: 'Old board' });
  const card = await app.board.createTask({ projectId: shop.id, title: 'Card A', prompt: 'Build card A.' });
  const legacy = await app.board.createTask({ projectId: old.id, title: 'Legacy card', prompt: 'Keep the legacy prompt.' });
  await browser.goto(`${app.url}/#/kanban`);
  await wait(`document.querySelector('#kanban-columns .kanban-open')`, 'Shop board');
  const edit = async (title, change) => {
    await ev(`[...document.querySelectorAll('#kanban-columns .kanban-open')].find(button => button.textContent === ${JSON.stringify(title)}).click();`);
    await wait(`document.querySelector('#card-dialog').open && document.querySelector('#card-title').value === ${JSON.stringify(title)}`, 'edit dialog');
    await change();
  };
  const save = () => ev(`document.querySelector('#card-save').click();`);
  // Only the revision moved (as a run or move does): the first Save succeeds.
  await edit('Card A', () => app.board.store.update(state => { const row = state.projects.find(project => project.id === shop.id).tasks[0]; row.revision++; row.updatedAt = Date.now(); }));
  await ev(`document.querySelector('#card-prompt').value = 'Edited once';`); await save();
  await wait(`!document.querySelector('#card-dialog').open`, 'saved after a bare revision change');
  assert.equal((await task(shop.id))[0].prompt, 'Edited once');
  // The title changed elsewhere: the typed text stays, nothing is overwritten until a second Save.
  await edit('Card A', async () => { const [current] = await task(shop.id); await app.board.updateTask(card.id, { title: 'Renamed elsewhere', expectedRevision: current.revision }); });
  await ev(`document.querySelector('#card-prompt').value = 'My careful edit';`); await save();
  await wait(`!document.querySelector('#card-error').hidden`, 'conflict message');
  assert.match(await ev(`return document.querySelector('#card-error').textContent;`), /changed elsewhere while you edited it\. Save again to replace/);
  assert.deepEqual(await ev(`return [document.querySelector('#card-dialog').open, document.querySelector('#card-prompt').value];`), [true, 'My careful edit']);
  assert.deepEqual([(await task(shop.id))[0].title, (await task(shop.id))[0].prompt], ['Renamed elsewhere', 'Edited once']);
  await save();
  await wait(`!document.querySelector('#card-dialog').open`, 'second Save replaces the newer card');
  assert.deepEqual([(await task(shop.id))[0].title, (await task(shop.id))[0].prompt], ['Card A', 'My careful edit']);
  // A legacy board no longer overwrites a newer card silently.
  await ev(pickProject(old.id));
  await wait(`document.querySelector('#kanban-columns .kanban-open')?.textContent === 'Legacy card'`, 'legacy board');
  await edit('Legacy card', async () => { const [current] = await task(old.id); await app.board.updateTask(legacy.id, { prompt: 'Changed in another window.', expectedRevision: current.revision }); });
  await ev(`document.querySelector('#card-title').value = 'Legacy renamed';`); await save();
  await wait(`!document.querySelector('#card-error').hidden`, 'legacy conflict message');
  assert.deepEqual([(await task(old.id))[0].title, (await task(old.id))[0].prompt], ['Legacy card', 'Changed in another window.']);
  noExceptions(browser);
});

test('board refreshes keep keyboard focus and the timeline: per-project loads, one note per save, Ask Coordinator shows the board', { skip: !chrome, timeout: 150000 }, async t => {
  const { app, browser, ev, wait } = await setup(t, { seed: `localStorage.setItem('promptboard.project-view', 'timeline')` });
  const shop = await app.board.createProject({ name: 'Shop', workflowMode: 'pipeline' }), blog = await app.board.createProject({ name: 'Blog', workflowMode: 'pipeline' });
  const checkout = await app.board.createTask({ projectId: shop.id, title: 'Checkout flow', prompt: 'Build checkout.' });
  await app.board.createTask({ projectId: blog.id, title: 'Blog post', prompt: 'Write it.' });
  await browser.goto(`${app.url}/#/kanban`);
  const shows = title => `[...document.querySelectorAll('#timeline-track .timeline-task')].some(node => node.textContent === ${JSON.stringify(title)})`;
  await wait(`!document.querySelector('#timeline').hidden && ${shows('Checkout flow')}`, 'Shop timeline');
  // A slow Shop read neither blocks nor completes Blog's.
  await ev(`const slow = '/api/projects/' + ${JSON.stringify(shop.id)} + '/timeline', original = window.__fetch = window.fetch;
    window.fetch = function (url, ...rest) { return String(url) === slow ? new Promise(resolve => setTimeout(resolve, 8000)).then(() => original.call(this, url, ...rest)) : original.call(this, url, ...rest); };
    timeline.loadedAt = 0; refreshTimeline(currentProject()); ${pickProject(blog.id)}`);
  await wait(shows('Blog post'), 'Blog timeline while Shop is still loading', 5000);
  await ev(`window.fetch = window.__fetch; ${pickProject(shop.id)}`);
  await wait(shows('Checkout flow'), 'Shop timeline again', 15000);
  // Keyboard focus stays on the same timeline control and the same sidebar control while the board changes.
  await ev(`[...document.querySelectorAll('#timeline-track .timeline-task')].find(node => node.textContent === 'Checkout flow').focus();`);
  await app.board.createTask({ projectId: shop.id, title: 'Another', prompt: 'x' });
  await wait(shows('Another'), 'timeline rebuilt');
  assert.equal(await ev(`return document.activeElement.matches('#timeline-track .timeline-task') && document.activeElement.textContent;`), 'Checkout flow');
  await ev(`document.querySelector('#workspace-list [data-project-id=${JSON.stringify(blog.id)}] .workspace-menu-toggle').focus();`);
  await app.board.createTask({ projectId: shop.id, title: 'One more', prompt: 'x' });
  await wait(`/3 cards/.test(document.querySelector('#workspace-list [data-project-id=${JSON.stringify(shop.id)}] .workspace-meta').textContent)`, 'sidebar rebuilt');
  assert.equal(await ev(`return document.activeElement.getAttribute('aria-label');`), 'Manage project: Blog');
  // Two quick clicks on Save note add one note.
  await ev(`document.querySelector('#timeline-note-new').click(); document.querySelector('#note-title').value = 'Once'; const save = document.querySelector('#note-save'); save.click(); save.click();`);
  await wait(`document.querySelector('#timeline-note-form').hidden`, 'note saved');
  const token = await ev(`return token;`);
  const { events } = await (await fetch(`${app.url}/api/projects/${shop.id}/timeline`, { headers: { 'X-STE-Token': token } })).json();
  assert.deepEqual(events.filter(event => event.kind === 'note').map(event => event.title), ['Once']);
  // Ask Coordinator from the timeline switches to the board, where the Coordinator lives.
  await ev(`[...document.querySelectorAll('#timeline-track .timeline-task')].find(node => node.textContent === 'Checkout flow').click();`);
  await wait(`document.querySelector('#task-dialog').open`, 'task details');
  await ev(`[...document.querySelectorAll('#task-dialog button')].find(button => button.textContent === 'Ask Coordinator about this card').click();`);
  await wait(`!document.querySelector('#task-dialog').open && document.querySelector('#timeline').hidden && !document.querySelector('#coordinator').hidden && document.querySelector('#coordinator-target')?.value === ${JSON.stringify(checkout.id)}`, 'Coordinator asks about the card');
  noExceptions(browser);
});

test('pipeline boards use column roles, name their columns, hide the legacy Agents button, and open Columns at a column', { skip: !chrome, timeout: 120000 }, async t => {
  const { app, browser, ev, wait } = await setup(t);
  const pipeline = defaultPipelineConfig();
  for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  Object.assign(pipeline.columns[0], { id: 'inbox', name: 'Inbox' }); pipeline.columns.at(-1).id = 'shipped';
  const project = await app.board.createProject({ name: 'Roles' }), old = await app.board.createProject({ name: 'Old board' });
  await app.board.setPipeline(project.id, { pipeline, expectedRevision: project.revision, confirm: true });
  const queued = await app.board.createTask({ projectId: project.id, title: 'Queued', prompt: 'Wait.' }), finished = await app.board.createTask({ projectId: project.id, title: 'Finished', prompt: 'Done.' });
  await app.board.store.update(state => {
    const row = state.projects.find(item => item.id === project.id);
    Object.assign(row.tasks.find(item => item.id === finished.id), { column: 'shipped', archivedAt: Date.now() });
    row.autopilot = { status: 'paused', reason: 'Paused for this check.', route: ['executing'], finish: 'done', maxRework: 0, queue: [queued.id], done: [], routes: {}, log: [] };
  });
  await browser.goto(`${app.url}/#/kanban`);
  await wait(`document.querySelector('.kanban-column[data-column="inbox"]')`, 'pipeline board');
  assert.equal(await ev(`return Boolean(document.querySelector('.kanban-column[data-column="inbox"] .kanban-add-task'));`), true, 'To Do role column offers Add task');
  assert.equal(await ev(`return document.querySelector('.kanban-column[data-column="inbox"] .autopilot-tag')?.textContent;`), 'Autopilot · #1');
  assert.deepEqual(await ev(`const display = document.querySelector('.kanban-column[data-column="shipped"] .kanban-done-card .card-appearance'); return [Boolean(display), Boolean(display?.querySelector('[data-card-display="agent"]'))];`), [true, false], 'Done role cards hide agent display');
  assert.equal(await ev(`return document.querySelector('#agents-open').hidden;`), true);
  assert.equal(await ev(`return document.querySelector('#workflow-summary').textContent;`), 'Inbox → Planning → Executing → Code Review → Testing → Merge → Done');
  await ev(`document.querySelector('#workflow-open').click();`);
  await wait(`document.querySelector('#columns-dialog').open`, 'Columns');
  assert.equal(await ev(`return typeof columnsDraft.selected === 'string' && document.querySelectorAll('#columns-list [aria-current="true"]').length;`), 1);
  await ev(`document.querySelector('#columns-dialog').close(); ${pickProject(old.id)}`);
  await wait(`document.querySelector('.kanban-column[data-column="todo"]')`, 'legacy board');
  assert.equal(await ev(`return document.querySelector('#agents-open').hidden;`), false);
  assert.match(await ev(`return document.querySelector('#workflow-summary').textContent;`), /^Planning: .+ · Executing: /);
  noExceptions(browser);
});

test('running tests refresh open task details only when their status changes', { skip: !chrome, timeout: 120000 }, async t => {
  const { app, browser, ev, wait } = await setup(t);
  const project = await app.board.createProject({ name: 'Old board' }), card = await app.board.createTask({ projectId: project.id, title: 'Tested', prompt: 'Test it.' });
  const tests = status => app.board.store.update(state => { const row = state.projects[0].tasks[0]; row.evidence = { ...row.evidence, tests: { status, results: [], taskCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40) } }; row.revision++; });
  await tests('running');
  await browser.goto(`${app.url}/#/kanban`);
  await wait(`document.querySelector('#kanban-columns .kanban-open')`, 'board');
  await ev(`openTaskDetails(${JSON.stringify(card.id)}); document.querySelector('#task-details section').dataset.kept = 'yes';`);
  await wait(`document.querySelector('#task-dialog').open`, 'details');
  // Several polls pass; typed fields in the dialog would survive.
  await new Promise(resolve => setTimeout(resolve, 4000));
  assert.equal(await ev(`return document.querySelector('#task-details section').dataset.kept;`), 'yes');
  await tests('passed');
  await wait(`document.querySelector('#task-dialog').open && !document.querySelector('#task-details section').dataset.kept`, 'refreshed when the status changed');
  noExceptions(browser);
});
