import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import '../public/origin-model.js';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const J = JSON.stringify, Model = globalThis.PromptboardOriginModel;
const chrome = await findChrome();

async function setup(t) {
  let version = 0;
  const app = await startTestServer(t, { port: 0, detector: async () => [{ id: 'codex', available: true }], authAdapter: { installed: async () => true, status: async () => ({ state: 'signed-in' }) },
    runner: async call => ({ text: `Engineered prompt ${++version}: ${call.prompt.includes('Checkout') ? 'Build the checkout service.' : 'Build the requested feature.'}` }) });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = async (path, method = 'GET', body) => { const response = await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: J(body) } : {}) }); return { status: response.status, data: await response.json() }; };
  const browser = await launch({ width: 1280, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  const ev = code => browser.eval(code), wait = (expression, label, ms = 15000) => browser.until(expression, label, ms);
  const click = selector => ev(`const node = document.querySelector(${J(selector)}); if (!node) throw new Error('missing ' + ${J(selector)}); node.click();`);
  const value = (selector, text) => ev(`const node = document.querySelector(${J(selector)}); node.value = ${J(text)}; node.dispatchEvent(new Event('input', { bubbles: true }));`);
  const generate = async text => {
    if (text !== undefined) await value('#prompt-input', text);
    await ev(`document.querySelector('[name="quality"][value="fast"]').click();`);
    const before = await ev(`return document.querySelector('#prompt-output').textContent;`);
    await click('#generate-button');
    await wait(`document.querySelector('#cancel-button').hidden && !document.querySelector('#prompt-output').hidden && document.querySelector('#prompt-output').textContent !== ${J(before)}`, 'generated');
  };
  const button = (scope, text) => ev(`const b = [...document.querySelectorAll(${J(scope + ' button')})].find(b => b.textContent.trim().startsWith(${J(text)})); if (!b) throw new Error('no button ' + ${J(text)}); b.click();`);
  return { app, call, browser, ev, wait, click, value, generate, button };
}

test('Compose works without any project; History and Projects stay separate; prompts are saved or moved only on request', { skip: !chrome, timeout: 180000 }, async t => {
  const { app, call, browser, ev, wait, click, value, generate, button } = await setup(t);
  await browser.goto(app.url);
  await wait(`!document.querySelector('#generate-button').disabled`, 'Compose ready');
  assert.deepEqual(await ev(`return [document.querySelector('#sidebar-tab-history').getAttribute('aria-selected'), document.querySelector('#history-section').hidden, document.querySelector('#projects-section').hidden];`), ['true', false, true]);
  // Plain Compose: no project is needed, and none is created.
  await generate('Build a login form');
  await generate('Build a search page');
  assert.equal(await ev(`return document.querySelectorAll('#history-list .history-item').length;`), 2);
  assert.equal(await ev(`return document.querySelector('#compose-link').hidden;`), true);
  assert.deepEqual((await call('/api/shared-projects')).data.projects, []);
  // Projects is its own category.
  await click('#sidebar-tab-projects');
  await wait(`!document.querySelector('#projects-section').hidden && document.querySelector('#history-section').hidden && /No projects yet/.test(document.querySelector('#projects-section').textContent)`, 'projects tab');
  // Move the older History entry into a new project; nothing else changes.
  await click('#sidebar-tab-history');
  await ev(`document.querySelectorAll('#history-list .history-save')[1].click();`);
  await wait(`document.querySelector('#project-save-dialog').open`, 'save dialog');
  assert.equal(await ev(`return document.querySelector('#project-save-target').value;`), '', 'with no projects, the dialog creates one');
  await value('#project-save-name', 'Shop'); await value('#project-save-title', 'Login form');
  await ev(`document.querySelector('#project-save-move').checked = true; document.querySelector('#project-save-submit').click();`);
  await wait(`!document.querySelector('#project-save-dialog').open`, 'saved');
  assert.equal(await ev(`return document.querySelectorAll('#history-list .history-item').length;`), 1, 'moved out of History');
  assert.match(await ev(`return document.querySelector('#history-list').textContent;`), /search page/);
  let projects = (await call('/api/shared-projects')).data.projects;
  assert.deepEqual(projects.map(project => [project.name, project.prompts, project.kanban]), [['Shop', 1, null]]);
  assert.equal((await app.board.state()).projects.length, 0, 'saving creates no board and no card');
  // Save the current result into the existing project: it is selected, not duplicated.
  await click('#output-tools summary'); await click('#project-save-button');
  await wait(`document.querySelector('#project-save-dialog').open`, 'save dialog again');
  assert.equal(await ev(`return document.querySelector('#project-save-target').selectedOptions[0].textContent;`), 'Shop');
  assert.equal(await ev(`return document.querySelector('#project-save-move').closest('label').hidden;`), true, 'only History entries can be moved');
  await click('#project-save-submit');
  await wait(`!document.querySelector('#compose-link').hidden && /Project · Shop \\/ /.test(document.querySelector('#compose-link').textContent)`, 'linked to the saved prompt');
  projects = (await call('/api/shared-projects')).data.projects;
  assert.equal(projects.length, 1); assert.equal(projects[0].prompts, 2);
  assert.equal(await ev(`return document.querySelectorAll('#history-list .history-item').length;`), 1, 'saving keeps History');
  await click('#sidebar-tab-projects');
  await wait(`document.querySelectorAll('#projects-list .project-prompt').length === 2`, 'project prompts listed');
  if (process.env.PB_BROWSER_SHOTS) { await mkdir(process.env.PB_BROWSER_SHOTS, { recursive: true }); await writeFile(join(process.env.PB_BROWSER_SHOTS, 'shared-projects-sidebar.png'), await browser.screenshot()); }
  // New prompt clears the link; History still works on its own.
  await click('#new-prompt');
  await wait(`document.querySelector('#compose-link').hidden`, 'unlinked');
  await button('#projects-section', '＋ New project');
  await value('#projects-new-name', 'shop'); await ev(`document.querySelector('.projects-new-form').requestSubmit();`);
  await wait(`document.querySelectorAll('#projects-list .project-row').length === 1`, 'no duplicate project');
  assert.deepEqual(browser.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);
});

test('Origin → Compose → project → Kanban, with reverse navigation and protected card instructions', { skip: !chrome, timeout: 240000 }, async t => {
  const { app, call, browser, ev, wait, click, generate, button } = await setup(t);
  const bp = Model.emptyBlueprint(); bp.components.push({ id: 'checkout', name: 'Checkout service', purpose: 'Takes payments.' });
  let { project } = (await call('/api/origin/projects', 'POST', { name: 'Shop' })).data;
  await call(`/api/origin/projects/${project.id}`, 'PUT', { expectedRevision: project.revision, blueprint: bp });
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('promptboard.origin.project', ${J(project.id)});` });
  // Origin: send the component to Compose; the link travels with it.
  await browser.goto(`${app.url}/#/origin`);
  await wait(`document.querySelector('#origin-view')?.dataset.save === 'saved' && document.querySelector('.origin-nav-item[data-section="architecture"]')`, 'Origin ready');
  await click('.origin-nav-item[data-section="architecture"]');
  await wait(`[...document.querySelectorAll('#origin-main .origin-row-open')].some(b => b.textContent.includes('Checkout service'))`, 'component row');
  await ev(`[...document.querySelectorAll('#origin-main .origin-row-open')].find(b => b.textContent.includes('Checkout service')).click();`);
  await wait(`!document.querySelector('#origin-drawer').hidden && document.querySelector('#origin-drawer .origin-compose')`, 'component drawer');
  await click('#origin-drawer .origin-compose');
  await wait(`location.hash === '#/' && /From Origin · Checkout service/.test(document.querySelector('#compose-link').textContent)`, 'linked from Origin');
  await generate();
  await click('#output-tools summary'); await click('#project-save-button');
  await wait(`document.querySelector('#project-save-dialog').open`, 'save dialog');
  assert.equal(await ev(`return document.querySelector('#project-save-target').value;`), project.id, 'the Origin project is preselected');
  await click('#project-save-submit');
  await wait(`/Project · Shop \\/ .*\\(revision 1\\)/.test(document.querySelector('#compose-link').textContent)`, 'saved with its link');
  let prompts = (await call(`/api/shared-projects/${project.id}/prompts`)).data.prompts;
  assert.deepEqual(prompts[0].origin.map(link => [link.collection, link.id, link.name]), [['components', 'checkout', 'Checkout service']]);
  // Kanban: a card only on request; the board is created then, with the project's ID.
  await click('#compose-link-card');
  await wait(`document.querySelector('#compose-link-board')`, 'board offer');
  assert.equal((await app.board.state()).projects.length, 0);
  await click('#compose-link-board');
  await wait(`/Created card #1 in To Do/.test(document.querySelector('#compose-link').textContent)`, 'card created');
  let state = await app.board.state();
  assert.equal(state.projects[0].id, project.id, 'one project ID in Origin and Kanban');
  const card = state.projects[0].tasks[0];
  assert.deepEqual([card.source.promptId, card.source.promptRevision], [prompts[0].id, 1]);
  assert.deepEqual(state.runs, [], 'no agent started');
  // Reverse: Origin shows the prompt and its card on the component.
  await ev(`[...document.querySelectorAll('#compose-link button')].find(b => b.textContent.startsWith('Origin: Checkout service')).click();`);
  await wait(`location.hash === '#/origin' && /Saved prompts/.test(document.querySelector('#origin-drawer')?.textContent || '') && /Kanban #1/.test(document.querySelector('#origin-drawer').textContent)`, 'Origin shows links');
  // Reverse: Kanban card → its saved prompt in Compose.
  await ev(`[...document.querySelectorAll('#origin-drawer .origin-linked-prompt button')].find(b => b.textContent.startsWith('Kanban #1')).click();`);
  await wait(`location.hash === '#/kanban' && document.querySelector('#task-dialog').open && /From a saved prompt/.test(document.querySelector('#task-dialog').textContent)`, 'card details');
  await button('#task-dialog', 'Open the saved prompt in Compose');
  await wait(`location.hash === '#/' && /\\(revision 1\\)/.test(document.querySelector('#compose-link').textContent) && /Card #1/.test(document.querySelector('#compose-link').textContent)`, 'saved prompt in Compose');
  // A new revision is kept; the card changes only by an explicit update while idle.
  await generate();
  await click('#compose-link-revise');
  await wait(`/Saved revision 2/.test(document.querySelector('#compose-link').textContent)`, 'revision 2');
  assert.equal((await app.board.state()).projects[0].tasks[0].prompt, card.prompt, 'the card keeps revision 1');
  prompts = (await call(`/api/shared-projects/${project.id}/prompts/${prompts[0].id}`)).data.prompt;
  assert.equal(prompts.revisions.length, 2);
  await button('#compose-link', 'Update card #1');
  await wait(`/Card #1 now has revision 2/.test(document.querySelector('#compose-link').textContent)`, 'card updated');
  state = await app.board.state();
  assert.equal(state.projects[0].tasks[0].prompt, prompts.revisions[1].prompt);
  // A card with a running agent keeps its instructions.
  await app.board.store.update(draft => { draft.runs.push({ id: 'run-1', taskId: card.id, projectId: project.id, status: 'running', createdAt: Date.now(), config: { provider: 'codex' } }); });
  await ev(`location.hash = '#/kanban'`);
  await wait(`document.querySelector('[data-id="${card.id}"] .kanban-open')`, 'board');
  await click(`[data-id="${card.id}"] .kanban-open`);
  await wait(`document.querySelector('#card-dialog').open && document.querySelector('#card-refine').textContent === 'Open in Compose' && !document.querySelector('#card-refine').hidden`, 'card editor');
  await click('#card-refine');
  await wait(`location.hash === '#/' && /Kanban · #1/.test(document.querySelector('#compose-link').textContent)`, 'card in Compose');
  await generate();
  await click('#compose-link-update');
  await wait(`/Only an idle card in To Do can take a refined prompt/.test(document.querySelector('#compose-link').textContent)`, 'protected');
  assert.equal((await app.board.state()).projects[0].tasks[0].prompt, prompts.revisions[1].prompt, 'active instructions are unchanged');
  if (process.env.PB_BROWSER_SHOTS) { await mkdir(process.env.PB_BROWSER_SHOTS, { recursive: true }); await writeFile(join(process.env.PB_BROWSER_SHOTS, 'shared-projects-compose.png'), await browser.screenshot()); }
  assert.deepEqual(browser.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);
});
