// Kanban UI fixes in a real browser: dialogs and menus that outlive a background board change, board feedback, focus and phone layout.
// Agents are SIMULATED (tests/fixtures/fake-agent.cjs, or a fake runner); the server, routes and page are real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, launch } from './helpers/browser.mjs';
import { startServer } from '../src/server.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const chrome = await findChrome();
const fake = fileURLToPath(new URL('./fixtures/fake-agent.cjs', import.meta.url));
const exceptions = browser => browser.consoleMessages.filter(message => message.startsWith('EXCEPTION'));
const enter = async browser => {
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
};
const escape = browser => browser.key('Escape', 'Escape', 27);
async function open(t, options = {}, size = {}) {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [], ...options });
  const browser = await launch(size); assert.ok(browser); t.after(() => browser.close());
  if (size.width) await browser.resize(size.width, size.height);
  return { app, browser };
}
const linked = async (app, name, extra = {}) => (await app.board.createProjectWithRepository({ name, folder: 'new', ...extra })).project;
const fresh = async (app, id) => (await app.board.state()).projects.flatMap(project => project.tasks).find(task => task.id === id);
// A board change saved elsewhere reaches this page through its 2 s background poll.
const polled = async (app, browser) => browser.until(`board.revision === ${(await app.board.state()).revision}`, 'the poll took the newer board');

test('the Autopilot dialog keeps working after one of its To Do cards is deleted in another window', { skip: !chrome, timeout: 90000 }, async t => {
  const { app, browser } = await open(t);
  const project = await linked(app, 'Autopilot queue');
  await app.board.createTask({ projectId: project.id, title: 'Alpha', prompt: 'a' });
  const bravo = await app.board.createTask({ projectId: project.id, title: 'Bravo', prompt: 'b' });
  await browser.goto(`${app.url}/#/kanban`); await browser.until(`document.querySelector('[data-id="${bravo.id}"]')`, 'cards');
  await browser.eval(`document.querySelector('#autopilot-open').click();`);
  await browser.until(`document.querySelectorAll('#autopilot-queue .autopilot-head input').length === 2`, 'queue');
  await app.board.deleteTask(bravo.id, { expectedRevision: bravo.revision });
  await polled(app, browser);
  await browser.eval(`document.querySelector('#autopilot-queue .autopilot-head input').click();`);
  assert.deepEqual(await browser.eval(`return [...document.querySelectorAll('#autopilot-queue .autopilot-title')].map(node => node.textContent);`), ['Alpha']);
  assert.equal(await browser.eval(`return document.querySelector('#autopilot-queue-note').textContent;`), '0 of 1 To Do cards · top runs first');
  assert.deepEqual(exceptions(browser), []);
});

test('the pipeline Autopilot dialog keeps working after one of its route columns is removed in another window', { skip: !chrome, timeout: 90000 }, async t => {
  const { app, browser } = await open(t);
  const project = await linked(app, 'Autopilot route', { workflowMode: 'pipeline' });
  let current = (await app.board.state()).projects[0];
  const pipeline = structuredClone(current.pipeline);
  pipeline.columns.splice(pipeline.columns.findIndex(column => column.id === 'done'), 0, { id: 'c_polish', name: 'Polish', role: 'active', kind: 'custom', color: 'blue', description: '', strategy: { autoSpawn: true }, automations: { onEnter: [], onExit: [] } });
  await app.board.setPipeline(project.id, { pipeline, expectedRevision: current.revision, confirm: true });
  await app.board.createTask({ projectId: project.id, title: 'One' });
  await browser.goto(`${app.url}/#/kanban`); await browser.until(`document.querySelector('.kanban-card')`, 'card');
  await browser.eval(`document.querySelector('#autopilot-open').click();`);
  await browser.until(`document.querySelector('#autopilot-route input[aria-label="Polish"]')`, 'route with Polish');
  current = (await app.board.state()).projects[0];
  await app.board.setPipeline(project.id, { pipeline: { ...structuredClone(current.pipeline), columns: current.pipeline.columns.filter(column => column.id !== 'c_polish') }, expectedRevision: current.revision, confirm: true });
  await polled(app, browser);
  await browser.eval(`document.querySelector('#autopilot-queue .autopilot-head input').click();`);
  assert.equal(await browser.eval(`return Boolean(document.querySelector('#autopilot-route input[aria-label="Polish"]'));`), false);
  assert.deepEqual(exceptions(browser), []);
});

test('the Agents, Columns and Autopilot dialogs never save over a change saved meanwhile in another window', { skip: !chrome, timeout: 120000 }, async t => {
  const { app, browser } = await open(t);
  const project = await linked(app, 'Lost update');
  const card = await app.board.createTask({ projectId: project.id, title: 'Card', prompt: 'c' });
  await browser.goto(`${app.url}/#/kanban`); await browser.until(`document.querySelector('[data-id="${card.id}"]') && !document.querySelector('#agents-open').disabled`, 'board');
  const conflict = /changed since you loaded/;
  // Agents (workflow): the other window chose Manual for Planning.
  await browser.eval(`document.querySelector('#agents-open').click();`); await browser.until(`document.querySelector('#workflow-dialog').open`, 'Agents dialog');
  let current = (await app.board.state()).projects[0];
  await app.board.setWorkflow(project.id, { workflow: { ...current.workflow, planning: { policy: 'manual', instructions: 'Other window' } }, expectedRevision: current.revision });
  await polled(app, browser);
  await browser.eval(`document.querySelector('#workflow-form').requestSubmit();`);
  await browser.until(`!document.querySelector('#workflow-error').hidden`, 'Agents save refused');
  assert.match(await browser.eval(`return document.querySelector('#workflow-error').textContent;`), conflict);
  assert.equal((await app.board.state()).projects[0].workflow.planning.policy, 'manual');
  await browser.eval(`document.querySelector('#workflow-dialog').close();`);
  // Columns: the other window renamed Planning.
  await browser.eval(`document.querySelector('#columns-open').click();`); await browser.until(`document.querySelector('#columns-dialog').open`, 'Columns dialog');
  const view = (await app.board.view()).projects[0], layout = view.columnLayout?.length ? view.columnLayout : view.columns.map(column => ({ id: column.id }));
  await app.board.setColumns(project.id, { columns: layout.map(column => column.id === 'planning' ? { ...column, title: 'Renamed elsewhere' } : column), expectedRevision: (await app.board.state()).projects[0].revision });
  await polled(app, browser);
  await browser.eval(`document.querySelector('#columns-form').requestSubmit();`);
  await browser.until(`!document.querySelector('#columns-error').hidden`, 'Columns save refused');
  assert.match(await browser.eval(`return document.querySelector('#columns-error').textContent;`), conflict);
  assert.equal((await app.board.view()).projects[0].columns.find(column => column.id === 'planning').title, 'Renamed elsewhere');
  await browser.eval(`document.querySelector('#columns-dialog').close();`);
  // Autopilot: the other window saved its own route.
  await browser.eval(`document.querySelector('#autopilot-open').click();`); await browser.until(`document.querySelector('#autopilot-dialog').open`, 'Autopilot dialog');
  await app.board.setAutopilot(project.id, { route: ['executing'], queue: [card.id], expectedRevision: (await app.board.state()).projects[0].revision });
  await polled(app, browser);
  await browser.eval(`document.querySelector('#autopilot-save').click();`);
  await browser.until(`!document.querySelector('#autopilot-error').hidden`, 'Autopilot save refused');
  assert.match(await browser.eval(`return document.querySelector('#autopilot-error').textContent;`), conflict);
  assert.deepEqual((await app.board.state()).projects[0].autopilot.route, ['executing']);
  // Opened again, the dialogs show and save the newer settings.
  await browser.eval(`document.querySelector('#autopilot-dialog').close(); document.querySelector('#agents-open').click();`); await browser.until(`document.querySelector('#workflow-dialog').open`, 'Agents dialog again');
  await browser.eval(`document.querySelector('#test-commands').value = 'node --test'; document.querySelector('#workflow-form').requestSubmit();`);
  await browser.until(`!document.querySelector('#workflow-dialog').open`, 'Agents saved');
  current = (await app.board.state()).projects[0];
  assert.deepEqual([current.workflow.planning.policy, current.testCommands.map(item => item.argv.join(' '))], ['manual', ['node --test']]);
  assert.deepEqual(exceptions(browser), []);
});

// What Autopilot does before each card (src/autopilot.mjs): the project revision moves, no setting changes.
const bumpRevision = async (app, browser, projectId) => {
  const current = (await app.board.state()).projects.find(project => project.id === projectId);
  await app.board.setTargetBranch(projectId, { branch: current.targetBranch.name, expectedRevision: current.revision });
  await polled(app, browser);
};
const shownError = (browser, id) => browser.eval(`return document.querySelector('#${id}').hidden ? '' : document.querySelector('#${id}').textContent;`);

test('the Agents, Columns and Autopilot dialogs save again after their own save, a refused start and a revision change the app makes itself', { skip: !chrome, timeout: 120000 }, async t => {
  const { app, browser } = await open(t);
  const project = await linked(app, 'One window');
  const card = await app.board.createTask({ projectId: project.id, title: 'Card', prompt: 'c' });
  await browser.goto(`${app.url}/#/kanban`); await browser.until(`document.querySelector('[data-id="${card.id}"]') && !document.querySelector('#agents-open').disabled`, 'board');
  // Agents: the workflow saves, then a mistyped test command is refused; corrected after a revision change, Save goes through.
  await browser.eval(`document.querySelector('#agents-open').click();`); await browser.until(`document.querySelector('#workflow-dialog').open`, 'Agents dialog');
  await browser.eval(`document.querySelector('#test-commands').value = 'nodee --test'; document.querySelector('#workflow-form').requestSubmit();`);
  await browser.until(`!document.querySelector('#workflow-error').hidden`, 'mistyped command refused');
  assert.match(await shownError(browser, 'workflow-error'), /not a program installed/);
  await bumpRevision(app, browser, project.id);
  await browser.eval(`document.querySelector('#test-commands').value = 'node --test'; document.querySelector('#workflow-form').requestSubmit();`);
  await browser.until(`!document.querySelector('#workflow-dialog').open`, 'Agents saved');
  assert.deepEqual((await app.board.state()).projects[0].testCommands.map(item => item.argv.join(' ')), ['node --test']);
  // Columns: two saves in a row, each after a revision change.
  for (const title of ['Plan', 'Plan first']) {
    await browser.eval(`document.querySelector('#columns-open').click();`); await browser.until(`document.querySelector('#columns-dialog').open`, 'Columns dialog');
    await bumpRevision(app, browser, project.id);
    await browser.eval(`columnsDraft.list.find(entry => entry.id === 'planning').title = ${JSON.stringify(title)}; document.querySelector('#columns-form').requestSubmit();`);
    await browser.until(`!document.querySelector('#columns-dialog').open`, `Columns saved: ${title}`);
    assert.equal((await app.board.view()).projects[0].columns.find(column => column.id === 'planning').title, title);
  }
  // Autopilot: Start saves the settings, then no agent can run here. Start again gives that reason again, not a conflict.
  await browser.eval(`document.querySelector('#autopilot-open').click();`); await browser.until(`document.querySelector('#autopilot-dialog').open`, 'Autopilot dialog');
  for (const attempt of [1, 2]) {
    await browser.eval(`document.querySelector('#autopilot-error').hidden = true; document.querySelector('#autopilot-consent').checked = true; document.querySelector('#autopilot-form').requestSubmit();`);
    await browser.until(`!document.querySelector('#autopilot-error').hidden`, `start ${attempt} refused`);
    assert.match(await shownError(browser, 'autopilot-error'), /Agent execution is not available/, `start ${attempt}`);
    await bumpRevision(app, browser, project.id);
  }
  await browser.eval(`document.querySelector('#autopilot-save').click();`);
  await browser.until(`!document.querySelector('#autopilot-dialog').open`, 'Autopilot saved');
  assert.deepEqual(exceptions(browser), []);
});

test('the pipeline Column Manager saves after a revision change the app makes itself, and refuses settings changed elsewhere', { skip: !chrome, timeout: 120000 }, async t => {
  const { app, browser } = await open(t);
  const project = await linked(app, 'Pipeline window', { workflowMode: 'pipeline' });
  const card = await app.board.createTask({ projectId: project.id, title: 'Card' });
  await browser.goto(`${app.url}/#/kanban`); await browser.until(`document.querySelector('[data-id="${card.id}"]')`, 'board');
  const active = (await app.board.state()).projects[0].pipeline.columns.find(column => column.role === 'active').id;
  for (const [name, tests] of [['Shape', ''], ['Shape it', 'node --test']]) {
    await browser.eval(`document.querySelector('#columns-open').click();`); await browser.until(`document.querySelector('#columns-dialog').open`, 'Columns dialog');
    await bumpRevision(app, browser, project.id);
    await browser.eval(`columnsDraft.list.find(entry => entry.id === ${JSON.stringify(active)}).name = ${JSON.stringify(name)}; columnsDraft.tests = ${JSON.stringify(tests)}; document.querySelector('#columns-form').requestSubmit();`);
    await browser.until(`!document.querySelector('#columns-dialog').open || !document.querySelector('#columns-error').hidden`, `Columns saved: ${name}`);
    assert.equal(await shownError(browser, 'columns-error'), '');
    const saved = (await app.board.state()).projects[0];
    assert.deepEqual([saved.pipeline.columns.find(column => column.id === active).name, (saved.testCommands || []).map(item => item.argv.join(' '))], [name, tests ? [tests] : []]);
  }
  // Test commands changed in another window: a save from the open dialog is refused and keeps them.
  await browser.eval(`document.querySelector('#columns-open').click();`); await browser.until(`document.querySelector('#columns-dialog').open`, 'Columns dialog again');
  await app.board.delivery.setTestCommands(project.id, { commands: [{ command: 'node --version' }], expectedRevision: (await app.board.state()).projects[0].revision });
  await polled(app, browser);
  await browser.eval(`columnsDraft.list.find(entry => entry.id === ${JSON.stringify(active)}).name = 'Mine'; document.querySelector('#columns-form').requestSubmit();`);
  await browser.until(`!document.querySelector('#columns-error').hidden`, 'stale save refused');
  assert.match(await shownError(browser, 'columns-error'), /changed since you loaded/);
  const kept = (await app.board.state()).projects[0];
  assert.deepEqual([kept.pipeline.columns.find(column => column.id === active).name, kept.testCommands.map(item => item.argv.join(' '))], ['Shape it', ['node --version']]);
  assert.deepEqual(exceptions(browser), []);
});

// Visible: painted inside the viewport, with no hidden ancestor (a closed drawer is visibility: hidden).
const shown = text => `return [...document.querySelectorAll('body *')].filter(node => !node.children.length && node.textContent.includes(${JSON.stringify(text)})).some(node => {
  for (let item = node; item; item = item.parentElement) { const style = getComputedStyle(item); if (style.visibility === 'hidden' || style.display === 'none') return false; }
  const r = node.getBoundingClientRect(); return r.width > 0 && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight;
});`;

test('board feedback shows on the board on a phone and with the sidebar collapsed', { skip: !chrome, timeout: 90000 }, async t => {
  const { app, browser } = await open(t, {}, { width: 390, height: 844 });
  const project = await app.board.createProject({ name: 'Not linked' });
  const card = await app.board.createTask({ projectId: project.id, title: 'Waits', prompt: 'w' });
  await browser.goto(`${app.url}/#/kanban`); await browser.until(`document.querySelector('[data-id="${card.id}"]')`, 'card');
  const refuse = `const item = document.querySelector('[data-id="${card.id}"]'); if (item.querySelector('.kanban-more').hidden) item.querySelector('.kanban-more-toggle').click();
    const select = item.querySelector('.kanban-move-to'); select.value = [...select.options].find(option => option.value).value; select.dispatchEvent(new Event('change'));`;
  for (const [width, height] of [[390, 844], [1440, 900]]) for (const theme of ['light', 'dark']) {
    await browser.resize(width, height);
    await browser.eval(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; showProjectDetail();
      if (innerWidth > 730 && document.documentElement.dataset.sidebar !== 'collapsed') document.querySelector('#menu-toggle').click();`);
    await browser.eval(refuse);
    await browser.until(`/stayed in To Do/.test(document.querySelector('#project-detail').textContent)`, 'refused');
    assert.equal(await browser.layout(shown('stayed in To Do')), true, `${width}/${theme}: the reason is on screen`);
    assert.equal(await browser.layout(`return document.documentElement.scrollWidth <= innerWidth;`), true, `${width}/${theme}: no sideways scroll`);
  }
  // Feedback for an action in the phone drawer closes the drawer, so the board shows it.
  await browser.resize(390, 844);
  await browser.eval(`showProjectDetail(); if (!document.querySelector('#sidebar').classList.contains('open')) document.querySelector('#menu-toggle').click();`);
  await browser.until(`document.querySelector('#sidebar').classList.contains('open')`, 'drawer open');
  await browser.eval(`showBoardError(new Error('Shown on the board.'));`);
  assert.equal(await browser.layout(shown('Shown on the board.')), true);
  assert.deepEqual(exceptions(browser), []);
});

test('a slow request that started earlier never clears the feedback of a later action', { skip: !chrome, timeout: 90000 }, async t => {
  const { app, browser } = await open(t);
  const project = await app.board.createProject({ name: 'Race' });
  const slow = await app.board.createTask({ projectId: project.id, title: 'Slow one', prompt: 'x' });
  const refused = await app.board.createTask({ projectId: project.id, title: 'Refused one', prompt: 'y' });
  await browser.goto(`${app.url}/#/kanban`); await browser.until(`document.querySelector('[data-id="${refused.id}"]')`, 'cards');
  // The duplicate answers after 2 s here; a merge or a pull request can take minutes.
  await browser.eval(`window.__api = window.api; window.api = async (path, options) => { if (/duplicate/.test(path)) await new Promise(resolve => setTimeout(resolve, 2000)); return window.__api(path, options); };
    window.__slow = duplicateCard(${JSON.stringify(slow.id)});`);
  await browser.eval(`const item = document.querySelector('[data-id="${refused.id}"]'); if (item.querySelector('.kanban-more').hidden) item.querySelector('.kanban-more-toggle').click();
    const select = item.querySelector('.kanban-move-to'); select.value = [...select.options].find(option => option.value).value; select.dispatchEvent(new Event('change'));`);
  await browser.until(`/“Refused one” stayed in To Do/.test(document.querySelector('#project-detail').textContent)`, 'refusal shown');
  await browser.eval(`await window.__slow;`);
  assert.equal((await app.board.state()).projects[0].tasks.length, 3);
  assert.equal(await browser.eval(`return !document.querySelector('#project-detail').hidden && /“Refused one” stayed in To Do/.test(document.querySelector('#project-detail').textContent);`), true, 'the later refusal stays');
  // A change that starts while the refusal shows, and goes through, clears it.
  await browser.eval(`window.api = window.__api; await duplicateCard(${JSON.stringify(slow.id)});`);
  assert.equal(await browser.eval(`return document.querySelector('#project-detail').hidden;`), true);
});

test('after an import that waits for confirmation, the board message leads to "Check and apply" on a phone and with the sidebar collapsed', { skip: !chrome, timeout: 120000 }, async t => {
  const { app, browser } = await open(t, {}, { width: 390, height: 844 });
  const project = await linked(app, 'Imported');
  await app.board.createTask({ projectId: project.id, title: 'Card', prompt: 'c' });
  await browser.goto(`${app.url}/#/kanban`); await browser.until(`document.querySelector('.kanban-card')`, 'board');
  const backup = await browser.eval(`const { data } = await api('/api/board/export'); return JSON.stringify(data);`);
  await app.board.deleteProject(project.id, { expectedRevision: (await app.board.state()).projects[0].revision });
  await browser.until(`board.projects.length === 0`, 'empty board');
  await browser.eval(`document.querySelector('#menu-toggle').click();`); await browser.until(`document.querySelector('#sidebar').classList.contains('open')`, 'drawer open');
  await browser.eval(`const files = new DataTransfer(); files.items.add(new File([${JSON.stringify(backup)}], 'backup.json', { type: 'application/json' }));
    const input = document.querySelector('#import-file'); input.files = files.files; input.dispatchEvent(new Event('change'));`);
  await browser.until(`/wait for your confirmation/.test(document.querySelector('#project-detail').textContent)`, 'import waits for confirmation', 20000);
  assert.ok((await app.board.state()).projects[0].pendingImport);
  const review = `[...document.querySelectorAll('#project-detail button')].find(button => button.textContent === 'Review in Project settings')`;
  const confirmShown = `const node = document.querySelector('#import-confirm'), r = node.getBoundingClientRect();
    for (let item = node; item; item = item.parentElement) { const style = getComputedStyle(item); if (item.hidden || style.visibility === 'hidden' || style.display === 'none') return false; }
    return document.activeElement === node && r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;`;
  for (const [width, height] of [[390, 844], [1440, 900]]) {
    await browser.resize(width, height);
    if (width > 730) await browser.eval(`if (document.documentElement.dataset.sidebar !== 'collapsed') document.querySelector('#menu-toggle').click(); if (!document.querySelector('#project-settings').hidden) document.querySelector('#project-settings-close').click();`);
    assert.equal(await browser.layout(shown('Review in Project settings')), true, `${width}: the pointer shows on the board`);
    await browser.eval(`${review}.click();`);
    assert.equal(await browser.layout(confirmShown), true, `${width}: Check and apply is shown and focused`);
  }
  assert.deepEqual(exceptions(browser), []);
});

test('an open page takes the board of a restarted app whose board was restored from its last good copy', { skip: !chrome, timeout: 90000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-kanban-ui-'));
  const options = { executor: null, dataDir, detector: async () => [], catalogReader: async provider => ({ provider, source: 'test fixture', models: [] }) };
  let app = await startServer({ ...options, port: 0 });
  t.after(async () => { await app.close().catch(() => {}); await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const browser = await launch(); assert.ok(browser); t.after(() => browser.close());
  const project = await app.board.createProject({ name: 'Recover' });
  await app.board.createTask({ projectId: project.id, title: 'Kept', prompt: 'a' });
  await app.board.createTask({ projectId: project.id, title: 'Lost in the damaged write', prompt: 'b' });
  await browser.goto(`${app.url}/#/kanban`); await browser.until(`document.querySelectorAll('.kanban-card').length === 2`, 'two cards');
  const { port } = new URL(app.url);
  await app.close();
  // The store sets the damaged file aside and restores state.json.bak, one revision older than the page's board.
  await writeFile(join(dataDir, 'state.json'), '{ damaged');
  app = await startServer({ ...options, port: Number(port) });
  await browser.until(`!document.querySelector('#kanban-load-warning').hidden && document.querySelectorAll('.kanban-card').length === 1`, 'the restored board', 15000);
  assert.deepEqual(await browser.eval(`return [...document.querySelectorAll('.kanban-card .kanban-open')].map(node => node.textContent);`), ['Kept']);
  assert.match(await browser.eval(`return document.querySelector('#kanban-load-warning').textContent;`), /last good copy was restored/);
});

test('Escape in a dialog opened from the phone drawer closes only that dialog and returns focus to its opener', { skip: !chrome, timeout: 90000 }, async t => {
  const { app, browser } = await open(t, {}, { width: 390, height: 844 });
  await linked(app, 'Drawer');
  await browser.goto(`${app.url}/#/kanban`); await browser.until(`document.querySelector('#workspace-count').textContent === '01'`, 'board');
  await browser.eval(`document.querySelector('#menu-toggle').click();`);
  await browser.until(`getComputedStyle(document.querySelector('#sidebar')).visibility === 'visible'`, 'drawer open');
  await browser.eval(`if (document.querySelector('#project-settings').hidden) document.querySelector('#project-toggle').click();
    document.querySelector('#workflow-open').scrollIntoView({ block: 'center' }); document.querySelector('#workflow-open').focus();`);
  await enter(browser); await browser.until(`document.querySelector('#workflow-dialog').open`, 'dialog');
  await escape(browser);
  await browser.until(`!document.querySelector('#workflow-dialog').open`, 'dialog closed');
  assert.deepEqual(await browser.layout(`return JSON.stringify({ drawer: document.querySelector('#sidebar').classList.contains('open'), focus: document.activeElement.id });`, JSON.stringify({ drawer: true, focus: 'workflow-open' })), JSON.stringify({ drawer: true, focus: 'workflow-open' }));
  // Escape outside a dialog still closes the drawer.
  await escape(browser);
  assert.equal(await browser.layout(`return !document.querySelector('#sidebar').classList.contains('open') && document.activeElement.id === 'menu-toggle';`), true);
});

test('closing a card or details dialog returns focus to the card after a background re-render', { skip: !chrome, timeout: 90000 }, async t => {
  const { app, browser } = await open(t);
  const project = await linked(app, 'Focus');
  const one = await app.board.createTask({ projectId: project.id, title: 'One', prompt: '1' });
  const two = await app.board.createTask({ projectId: project.id, title: 'Two', prompt: '2' });
  await browser.goto(`${app.url}/#/kanban`); await browser.until(`document.querySelector('[data-id="${two.id}"]')`, 'cards');
  let title = 0;
  const rerender = async () => {
    const text = `Two, changed elsewhere ${++title}`;
    await app.board.updateTask(two.id, { title: text, expectedRevision: (await fresh(app, two.id)).revision });
    await browser.until(`document.querySelector('[data-id="${two.id}"] .kanban-open').textContent === ${JSON.stringify(text)}`, 'background render');
  };
  await browser.eval(`document.querySelector('[data-id="${one.id}"] .kanban-open').focus();`); await enter(browser);
  await browser.until(`document.querySelector('#card-dialog').open`, 'card dialog');
  await rerender();
  await escape(browser);
  assert.equal(await browser.layout(`return !document.querySelector('#card-dialog').open && document.activeElement === document.querySelector('[data-id="${one.id}"] .kanban-open');`), true, 'the card title takes focus back');
  await browser.eval(`const item = document.querySelector('[data-id="${one.id}"]'); item.querySelector('.kanban-more-toggle').click(); item.querySelector('.kanban-details').focus();`); await enter(browser);
  await browser.until(`document.querySelector('#task-dialog').open`, 'details dialog');
  await rerender();
  await escape(browser);
  assert.equal(await browser.layout(`return !document.querySelector('#task-dialog').open && document.activeElement.closest('.kanban-card')?.dataset.id === ${JSON.stringify(one.id)};`), true, 'the card keeps focus');
});

test('the sidebar project menu keeps keyboard focus: Escape closes it, Delete… and Keep land on a control', { skip: !chrome, timeout: 90000 }, async t => {
  const { app, browser } = await open(t);
  const project = await app.board.createProject({ name: 'Beta' });
  await browser.goto(`${app.url}/#/kanban`); await browser.until(`document.querySelector('.workspace-menu-toggle')`, 'sidebar');
  const row = `document.querySelector('#workspace-list [data-project-id="${project.id}"]')`, toggle = `${row}.querySelector('.workspace-menu-toggle')`;
  const item = label => `[...${row}.querySelectorAll('.workspace-menu button')].find(button => button.textContent === ${JSON.stringify(label)})`;
  await browser.eval(`${toggle}.focus();`); await enter(browser);
  await browser.until(`${row}.querySelector('.workspace-menu[role="menu"]')`, 'menu open');
  await escape(browser);
  assert.equal(await browser.layout(`return !${row}.querySelector('.workspace-menu') && document.activeElement === ${toggle};`), true, 'Escape closes the menu and returns to ⋯');
  await enter(browser); await browser.until(`${item('Delete…')}`, 'menu open again');
  await browser.eval(`${item('Delete…')}.focus();`); await enter(browser);
  assert.equal(await browser.layout(`return document.activeElement === ${item('Keep')};`), true, 'Delete… focuses Keep');
  await enter(browser);
  assert.equal(await browser.layout(`return !${row}.querySelector('.workspace-menu') && document.activeElement === ${toggle};`), true, 'Keep returns to ⋯');
  await enter(browser); await browser.until(`${item('Rename')}`, 'menu open a third time');
  await browser.eval(`${item('Rename')}.focus();`); await enter(browser);
  await browser.until(`document.activeElement === ${row}.querySelector('.workspace-rename input')`, 'rename field');
  await escape(browser);
  assert.equal(await browser.layout(`return !${row}.querySelector('.workspace-menu') && document.activeElement === ${toggle};`), true, 'Escape in Rename returns to ⋯');
  assert.equal((await app.board.state()).projects[0].name, 'Beta');
});

test('"Keep running" in the dock\'s stop prompt returns focus to Stop…', { skip: process.platform === 'win32' || !chrome ? 'Chrome is not installed or the platform has no PTY support in this test.' : false, timeout: 120000 }, async t => {
  const bin = await realpath(await mkdtemp(join(tmpdir(), 'pb-kanban-ui-bin-'))); t.after(() => rm(bin, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\nrequire(${JSON.stringify(fake)});\n`); await chmod(join(bin, 'claude'), 0o755);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`; t.after(() => { process.env.PATH = oldPath; });
  const { app, browser } = await open(t, { executor: 'auto' });
  const project = await linked(app, 'Dock');
  const card = await app.board.createTask({ projectId: project.id, title: 'Live', prompt: 'Say hello.' });
  await app.board.moveTask(card.id, { column: 'executing', expectedRevision: card.revision });
  await browser.goto(`${app.url}/#/kanban`); await browser.until(`document.querySelector('[data-column="executing"] .kanban-start')`, 'start');
  await browser.eval(`document.querySelector('[data-column="executing"] .kanban-start').click();`);
  await browser.until(`window.promptboardDock.sessions.size === 1 && !document.querySelector('#dock-stop').hidden`, 'live session', 30000);
  await browser.eval(`document.querySelector('#dock-stop').focus();`); await enter(browser);
  await browser.until(`document.activeElement.textContent === 'Stop this agent'`, 'stop prompt');
  await browser.eval(`[...document.querySelectorAll('#dock-stop-prompt button')].find(button => button.textContent === 'Keep running').focus();`); await enter(browser);
  assert.equal(await browser.layout(`return document.querySelector('#dock-stop-prompt').hidden && document.activeElement.id;`, 'dock-stop'), 'dock-stop');
  assert.equal((await app.board.state()).runs.filter(run => run.status === 'cancelled').length, 0);
});

test('an unsaved "Merges into" choice survives a background board refresh', { skip: !chrome, timeout: 90000 }, async t => {
  const { app, browser } = await open(t);
  const project = await linked(app, 'Branches');
  execFileSync('git', ['branch', 'develop'], { cwd: project.repository.root });
  const card = await app.board.createTask({ projectId: project.id, title: 'Background', prompt: 'b' });
  await browser.goto(`${app.url}/#/kanban`); await browser.until(`document.querySelector('[data-id="${card.id}"]')`, 'card');
  await browser.eval(`if (document.querySelector('#project-settings').hidden) document.querySelector('#project-toggle').click();`);
  await browser.until(`[...document.querySelector('#target-branch').options].some(option => option.value === 'develop')`, 'branches');
  const target = `JSON.stringify({ value: document.querySelector('#target-branch').value, save: !document.querySelector('#branch-save').hidden })`;
  await browser.eval(`const select = document.querySelector('#target-branch'); select.focus(); select.value = 'develop'; select.dispatchEvent(new Event('change'));`);
  await app.board.updateTask(card.id, { title: 'Changed elsewhere', expectedRevision: (await fresh(app, card.id)).revision });
  await browser.until(`document.querySelector('[data-id="${card.id}"] .kanban-open').textContent === 'Changed elsewhere'`, 'background render');
  assert.equal(await browser.eval(`return ${target};`), JSON.stringify({ value: 'develop', save: true }));
  await browser.eval(`document.querySelector('#branch-save').click();`);
  await browser.until(`(${target}) === ${JSON.stringify(JSON.stringify({ value: 'develop', save: false }))}`, 'saved');
  // With no choice pending, the list follows a target branch saved elsewhere.
  await app.board.setTargetBranch(project.id, { branch: 'main', expectedRevision: (await app.board.state()).projects[0].revision });
  await browser.until(`(${target}) === ${JSON.stringify(JSON.stringify({ value: 'main', save: false }))}`, 'target saved elsewhere');
});

test('a dialog close button never covers its eyebrow text at 390 px', { skip: !chrome, timeout: 90000 }, async t => {
  const { app, browser } = await open(t, {}, { width: 390, height: 844 });
  const project = await linked(app, 'Quarterly infrastructure migration and observability programme for the north');
  const card = await app.board.createTask({ projectId: project.id, title: 'Card', prompt: 'c' });
  await browser.goto(`${app.url}/#/kanban`); await browser.until(`document.querySelector('[data-id="${card.id}"]')`, 'card');
  for (const theme of ['light', 'dark']) for (const [opener, dialog, eyebrow, close] of [
    [`document.querySelector('[data-id="${card.id}"] .kanban-open').click()`, 'card-dialog', 'card-dialog-project', 'card-dialog-close'],
    [`openTaskDetails(${JSON.stringify(card.id)})`, 'task-dialog', 'task-dialog-stage', 'task-dialog-close'],
    [`document.querySelector('#agents-open').click()`, 'workflow-dialog', 'workflow-dialog-project', 'workflow-dialog-close'],
    [`document.querySelector('#columns-open').click()`, 'columns-dialog', 'columns-project', 'columns-close'],
    [`document.querySelector('#autopilot-open').click()`, 'autopilot-dialog', 'autopilot-project', 'autopilot-close'],
    // Base's dialog has its heading (a resource's own name) right after the close button; short words fill each line.
    [`document.querySelector('#base-dialog-heading').textContent = 'Release checklist a b c d e f g h i j k l m n o p q r s t u v w x y z'; document.querySelector('#base-dialog').showModal()`, 'base-dialog', 'base-dialog-heading', 'base-dialog-close'],
  ]) {
    await browser.eval(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; ${opener};`); await browser.until(`document.querySelector('#${dialog}').open`, dialog);
    assert.equal(await browser.layout(`const c = document.querySelector('#${close}').getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(document.querySelector('#${eyebrow}'));
      return range.toString().length > 40 && ![...range.getClientRects()].some(r => r.right > c.left + 1 && r.left < c.right - 1 && r.bottom > c.top + 1 && r.top < c.bottom - 1);`), true, `${theme}: ${dialog}`);
    await browser.eval(`document.querySelector('#${dialog}').close();`);
  }
});

test('Project memory fits a phone without sideways scrolling for an ordinary card title', { skip: !chrome, timeout: 120000 }, async t => {
  const { app, browser } = await open(t, { detector: async () => [{ id: 'claude', available: true }], authAdapter: { installed: async () => true, status: async () => ({ state: 'signed-in' }) },
    runner: async () => ({ text: JSON.stringify([{ kind: 'command', text: 'Run npm test first.', evidence: 'It passed.' }]) }) }, { width: 390, height: 844 });
  const project = await linked(app, 'Shop', { workflowMode: 'pipeline' });
  const card = await app.board.createTask({ projectId: project.id, title: 'Add pagination to the orders table in the admin dashboard', prompt: 'p' });
  await app.board.completeTask(card.id, { kind: 'merged', details: { targetBranch: 'main', commits: 1 } });
  for (const end = Date.now() + 15000; (await app.board.lessons.view(project.id)).jobs[0]?.status !== 'done';) {
    if (Date.now() > end) assert.fail('The suggestion did not finish.');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await browser.goto(`${app.url}/#/kanban`); await browser.until(`document.querySelector('#lessons-summary')?.textContent.includes('new')`, 'memory row');
  await browser.eval(`document.querySelector('#lessons-open').click();`); await browser.until(`document.querySelector('#lessons-dialog')?.open && document.querySelector('.lessons-card-link')`, 'dialog');
  for (const theme of ['light', 'dark']) {
    await browser.eval(`document.documentElement.dataset.theme = ${JSON.stringify(theme)};`);
    assert.equal(await browser.layout(`const dialog = document.querySelector('#lessons-dialog'), link = document.querySelector('.lessons-card-link').getBoundingClientRect(), box = dialog.getBoundingClientRect();
      return dialog.scrollWidth <= dialog.clientWidth && link.right <= box.right;`), true, theme);
  }
});
