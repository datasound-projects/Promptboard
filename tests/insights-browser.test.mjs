import test from 'node:test';
import assert from 'node:assert/strict';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const chrome = await findChrome();

test('Insights: the top bar icon next to Settings opens the four sections, the range changes them, and a card opens its details', { skip: !chrome, timeout: 180000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [{ id: 'claude', available: true }] });
  const shop = await app.board.createProject({ name: 'Shop', workflowMode: 'pipeline' });
  await app.board.createProject({ name: 'Blog', workflowMode: 'pipeline' });
  const login = await app.board.createTask({ projectId: shop.id, title: 'Login form', prompt: 'Build login.' });
  const search = await app.board.createTask({ projectId: shop.id, title: 'Search page', prompt: 'Build search.' });
  const H = 3600000, t0 = Date.now() - 2 * 24 * H, move = (h, from, to) => ({ at: t0 + h * H, from, to, by: 'user' });
  await app.board.store.update(state => {
    const tasks = state.projects.find(project => project.id === shop.id).tasks;
    Object.assign(tasks.find(task => task.id === login.id), { column: 'done', archivedAt: t0 + 5 * H, transitions: [move(1, 'todo', 'executing'), move(3, 'executing', 'code_review'), move(5, 'code_review', 'done')],
      stageHistory: [{ columnId: 'code_review', stage: 'code_review', runId: 'r1', provider: 'claude', status: 'changes_required', at: t0 + 4 * H, reason: 'Validate the email field.' }], completion: { kind: 'merged', at: t0 + 5 * H } });
    Object.assign(tasks.find(task => task.id === search.id), { column: 'code_review', transitions: [move(1, 'todo', 'code_review')] });
    state.runs.push({ id: 'r1', taskId: login.id, projectId: shop.id, stage: 'executing', stageKind: 'executing', status: 'succeeded', createdAt: t0 + H, startedAt: t0 + H, updatedAt: t0 + 2 * H, trigger: 'user',
      config: { provider: 'claude', model: '' }, providerSessionId: 's1', usage: { model: 'claude-opus', inputTokens: 2000, outputTokens: 500, cachedTokens: 9000, costUSD: 0.42 } });
  });
  const browser = await launch({ width: 1280, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('promptboard.kanban.project', ${JSON.stringify(shop.id)});` });
  const ev = code => browser.eval(code), wait = (expression, label) => browser.until(expression, label, 15000);
  await browser.goto(`${app.url}/#/kanban`);
  await wait(`document.querySelector('#insights-open') && document.querySelector('.kanban-column')`, 'board');
  assert.deepEqual(await ev(`const b = document.querySelector('#insights-open'); return [b.nextElementSibling.id, b.title, b.getAttribute('aria-haspopup')];`), ['app-settings-open', 'Insights', 'dialog']);
  // Keyboard: the icon takes focus and opens with Enter.
  await ev(`document.querySelector('#insights-open').focus();`);
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await wait(`document.querySelector('#insights-dialog')?.open && document.querySelectorAll('#insights-dialog .insights-section').length === 4`, 'four sections');
  assert.deepEqual(await ev(`return [...document.querySelectorAll('#insights-dialog .insights-section h3')].map(h => h.textContent);`), ['Rework', 'Time in each column', 'Cost per merged card', 'Cards that fail review most']);
  assert.equal(await ev(`return document.querySelector('#insights-project').value;`), shop.id, 'The selected Kanban project, with a picker for the others.');
  assert.match(await ev(`return document.querySelector('.insights-tiles').textContent;`), /1cards finished1merged4\.0 hmedian from first start to merge3ktokens9k cached\$0\.42reported price/);
  assert.match(await ev(`return document.querySelectorAll('.insights-section')[1].textContent;`), /Code Review.*1 still here/);
  // The range: All asks again and keeps the sections.
  await ev(`[...document.querySelectorAll('.insights-range button')].find(b => b.textContent === 'All').click();`);
  await wait(`document.querySelector('.insights-range button[aria-pressed="true"]').textContent === 'All' && /Updated/.test(document.querySelector('.insights-status').textContent)`, 'All');
  // Phone width: the dialog fits without sideways scrolling.
  await browser.resize(390, 844);
  assert.equal(await browser.layout(`const d = document.querySelector('#insights-dialog'), r = d.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && d.scrollWidth <= d.clientWidth && document.documentElement.scrollWidth <= innerWidth;`), true);
  await browser.resize(1280, 900);
  // A card in it opens that card's details.
  await ev(`[...document.querySelectorAll('.insights-card')].find(b => b.textContent === '#1 Login form').click();`);
  await wait(`!document.querySelector('#insights-dialog').open && document.querySelector('#task-dialog').open && document.querySelector('#task-dialog-heading').textContent === 'Login form'`, 'card details');
  assert.deepEqual(browser.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);
});
