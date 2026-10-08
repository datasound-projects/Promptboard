import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const chrome = await findChrome();

test('Coordinator panel: minimized, expanded, hidden and off, remembered per project, with read-only cited chat', { skip: !chrome, timeout: 180000 }, async t => {
  const calls = [];
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [{ id: 'codex', available: true }], authAdapter: { installed: async () => true, status: async () => ({ state: 'signed-in' }) },
    runner: async call => { calls.push(call); return { text: 'Checkout is waiting in To Do [T1]; nothing has run yet. Unknown [T42].' }; } });
  const shop = await app.board.createProject({ name: 'Shop', workflowMode: 'pipeline' }), blog = await app.board.createProject({ name: 'Blog', workflowMode: 'pipeline' });
  const card = await app.board.createTask({ projectId: shop.id, title: 'Checkout flow', prompt: 'Build checkout.' });
  await app.board.createTask({ projectId: shop.id, title: 'Search page' });
  const browser = await launch({ width: 1280, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `if (!sessionStorage.getItem('seeded')) { localStorage.setItem('promptboard.kanban.project', ${JSON.stringify(shop.id)}); sessionStorage.setItem('seeded', '1'); }` });
  const ev = code => browser.eval(code), wait = (expression, label) => browser.until(expression, label, 15000);
  const click = selector => ev(`document.querySelector(${JSON.stringify(selector)}).click();`);
  await browser.goto(`${app.url}/#/kanban`);
  await wait(`document.querySelector('#coordinator') && !document.querySelector('#coordinator').hidden && /0\\/2 done/.test(document.querySelector('.coordinator-status').textContent)`, 'minimized panel');
  assert.equal(await ev(`return document.querySelector('#coordinator').dataset.mode;`), 'minimized');
  assert.equal(await ev(`const panel = document.querySelector('#coordinator'), columns = document.querySelector('#kanban-columns'); return panel.compareDocumentPosition(columns) & Node.DOCUMENT_POSITION_FOLLOWING;`) > 0, true, 'above the Kanban columns');
  // Expanded: overview cards; remembered for this project only.
  await click('#coordinator-size');
  await wait(`document.querySelectorAll('#coordinator .coordinator-card').length === 4`, 'expanded dashboard');
  assert.match(await ev(`return document.querySelector('.coordinator-columns').textContent;`), /To Do 2/);
  if (process.env.PB_BROWSER_SHOTS) { await mkdir(process.env.PB_BROWSER_SHOTS, { recursive: true }); await writeFile(join(process.env.PB_BROWSER_SHOTS, 'coordinator-expanded.png'), await browser.screenshot()); }
  await browser.reload();
  await wait(`document.querySelector('#coordinator')?.dataset.mode === 'expanded'`, 'expanded after reload');
  await ev(`const s = document.querySelector('#project-select'); s.value = ${JSON.stringify(blog.id)}; s.dispatchEvent(new Event('change'));`);
  await wait(`document.querySelector('#coordinator').dataset.mode === 'minimized' && /0\\/0 done/.test(document.querySelector('.coordinator-status').textContent)`, 'other project keeps its own state');
  await ev(`const s = document.querySelector('#project-select'); s.value = ${JSON.stringify(shop.id)}; s.dispatchEvent(new Event('change'));`);
  await wait(`document.querySelector('#coordinator').dataset.mode === 'expanded'`, 'back to Shop');
  // Hidden: restored from the toolbar.
  await click('#coordinator-hide');
  await wait(`document.querySelector('#coordinator').hidden && !document.querySelector('#coordinator-show').hidden`, 'hidden');
  await click('#coordinator-show');
  await wait(`!document.querySelector('#coordinator').hidden && document.querySelector('#coordinator-show').hidden`, 'restored');
  assert.equal(calls.length, 0, 'no model call without a question');
  // Ask: one call, cited answer, links open the real card.
  await click('#coordinator-ask');
  await wait(`document.querySelector('#coordinator-question')`, 'chat');
  await ev(`const q = document.querySelector('#coordinator-question'); q.value = 'What is the status of checkout?'; q.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#coordinator-send').click();`);
  await wait(`document.querySelectorAll('.coordinator-message.coordinator').length === 1`, 'answer');
  assert.equal(calls.length, 1);
  assert.deepEqual(await ev(`return [...document.querySelectorAll('.coordinator-message.coordinator .coordinator-ref')].map(b => b.textContent);`), ['#1'], 'only real references become links');
  assert.match(await ev(`return document.querySelector('.coordinator-message.coordinator').textContent;`), /\[T42\]/);
  await click('.coordinator-message.coordinator .coordinator-ref');
  await wait(`document.querySelector('#task-dialog').open && document.querySelector('#task-dialog-heading').textContent === 'Checkout flow'`, 'reference opens the card');
  // From a card: Ask Coordinator about it.
  await ev(`[...document.querySelectorAll('#task-dialog button')].find(b => b.textContent === 'Ask Coordinator about this card').click();`);
  await wait(`!document.querySelector('#task-dialog').open && document.querySelector('#coordinator-scope').value === 'task' && document.querySelector('#coordinator-target').value === ${JSON.stringify(card.id)}`, 'card scope');
  // Off: knowledge kept, no asking, remembered after reload; on again.
  await click('#coordinator-enabled');
  await wait(`document.querySelector('#coordinator').dataset.mode === 'off' && !document.querySelector('#coordinator-ask')`, 'off');
  await browser.reload();
  await wait(`document.querySelector('#coordinator')?.dataset.mode === 'off'`, 'still off after reload');
  await click('#coordinator-enabled');
  await wait(`document.querySelector('#coordinator').dataset.mode === 'expanded' && document.querySelector('#coordinator-ask')`, 'on again');
  assert.equal(calls.length, 1, 'turning on reconciles without a model call');
  assert.deepEqual(JSON.parse(JSON.stringify((await app.board.state()).projects.map(project => project.tasks.map(task => task.prompt)))), [['Build checkout.', ''], []], 'nothing on the board changed');
  // Narrow screens: the panel fits.
  await browser.resize(390, 800);
  await wait(`(() => { const r = document.querySelector('#coordinator').getBoundingClientRect(); return r.left >= 0 && r.right <= document.documentElement.clientWidth; })()`, 'narrow');
  assert.deepEqual(browser.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);
});
