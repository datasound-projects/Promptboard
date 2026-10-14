import test from 'node:test';
import assert from 'node:assert/strict';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const chrome = await findChrome();

test('Coordinator layout: fold the overview, detach, drag, resize, minimize anywhere and attach again, without changing what it does', { skip: !chrome, timeout: 180000 }, async t => {
  const calls = [];
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [{ id: 'codex', available: true }], authAdapter: { installed: async () => true, status: async () => ({ state: 'signed-in' }) },
    runner: async call => { calls.push(call); return { text: 'Checkout is waiting in To Do [T1].' }; } });
  const shop = await app.board.createProject({ name: 'Shop', workflowMode: 'pipeline' });
  await app.board.createTask({ projectId: shop.id, title: 'Checkout flow', prompt: 'Build checkout.' });
  const browser = await launch({ width: 1440, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  const ev = code => browser.eval(code), wait = (expression, label) => browser.until(expression, label, 15000);
  const click = selector => ev(`document.querySelector(${JSON.stringify(selector)}).click();`);
  const rect = selector => ev(`const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };`);
  const mouse = (type, x, y) => browser.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  const drag = async (from, to) => { await mouse('mousePressed', from.x, from.y); for (let i = 1; i <= 4; i++) await mouse('mouseMoved', from.x + (to.x - from.x) * i / 4, from.y + (to.y - from.y) * i / 4); await mouse('mouseReleased', to.x, to.y); };
  const saved = () => ev(`return JSON.parse(localStorage.getItem('promptboard.coordinator.layout') || '{}');`);
  const dock = () => ev(`return document.querySelector('#coordinator').dataset.dock;`);

  await browser.goto(`${app.url}/#/kanban`);
  await wait(`document.querySelector('#coordinator-toggle') && !document.querySelector('#coordinator-toggle').hidden`, 'toggle');
  await click('#coordinator-toggle');
  await wait(`document.querySelectorAll('#coordinator .coordinator-card').length === 4`, 'open with overview');
  assert.equal(await dock(), 'attached');

  // The overview folds to give the chat room, and unfolds again; the summary line stays.
  await click('#coordinator-overview');
  await wait(`getComputedStyle(document.querySelector('.coordinator-grid')).display === 'none' && document.querySelector('#coordinator-overview').getAttribute('aria-expanded') === 'false'`, 'folded');
  assert.match(await ev(`return document.querySelector('.coordinator-status').textContent;`), /0\/1 done/);
  await click('#coordinator-overview');
  await wait(`getComputedStyle(document.querySelector('.coordinator-grid')).display === 'grid'`, 'unfolded');

  // Detach: a floating window with the chat open.
  await click('#coordinator-dock');
  await wait(`document.querySelector('#coordinator').dataset.dock === 'float' && document.querySelector('#coordinator-question')`, 'detached with chat');
  const start = await rect('#coordinator');
  assert.equal(await ev(`return getComputedStyle(document.querySelector('#coordinator')).position;`), 'fixed');
  assert.ok(start.w === 480 && start.x + start.w <= 1440 && start.y >= 60, JSON.stringify(start));

  // Drag it by its top bar.
  const name = await rect('#coordinator .coordinator-name');
  await drag({ x: name.x + 10, y: name.y + 5 }, { x: name.x - 590, y: name.y + 45 });
  await wait(`Math.round(document.querySelector('#coordinator').getBoundingClientRect().x) === ${start.x - 600}`, 'dragged')
    .catch(async error => { throw new Error(`${error.message}: ${JSON.stringify(await rect('#coordinator'))}`); });
  const moved = await rect('#coordinator');
  assert.equal(moved.y, start.y + 40);
  assert.deepEqual([(await saved()).x, (await saved()).y], [moved.x, moved.y]);

  // Resize it from its corner: wider and taller.
  await drag({ x: moved.x + moved.w - 3, y: moved.y + moved.h - 3 }, { x: moved.x + moved.w + 117, y: moved.y + moved.h + 57 });
  await wait(`document.querySelector('#coordinator').getBoundingClientRect().width > ${moved.w + 80}`, 'resized');
  const resized = await rect('#coordinator');
  assert.ok(resized.h > moved.h + 30, JSON.stringify(resized));
  await wait(`JSON.parse(localStorage.getItem('promptboard.coordinator.layout')).w === ${resized.w}`, 'size saved');

  // Asking works the same in the window.
  await ev(`const q = document.querySelector('#coordinator-question'); q.value = 'Status?'; q.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#coordinator-send').click();`);
  await wait(`document.querySelectorAll('.coordinator-message.is-coordinator').length === 1`, 'answer in the window');
  assert.equal(calls.length, 1);

  // Minimize to a small box, drag it anywhere, click to open the window again where it was.
  await click('#coordinator-minimize');
  await wait(`document.querySelector('#coordinator').dataset.dock === 'mini' && document.activeElement?.id === 'coordinator-mini'`, 'minimized');
  const mini = await rect('#coordinator-mini');
  assert.ok(mini.w < 320 && mini.h < 50, JSON.stringify(mini));
  await drag({ x: mini.x + 20, y: mini.y + 10 }, { x: 420, y: 300 });
  await wait(`Math.round(document.querySelector('#coordinator').getBoundingClientRect().x) === 400`, 'mini dragged');
  assert.equal(await dock(), 'mini', 'a drag does not open it');
  await new Promise(resolve => setTimeout(resolve, 500));
  const placed = await rect('#coordinator-mini');
  await mouse('mousePressed', placed.x + 20, placed.y + 10); await mouse('mouseReleased', placed.x + 20, placed.y + 10);
  await wait(`document.querySelector('#coordinator').dataset.dock === 'float' && document.querySelectorAll('.coordinator-message.is-coordinator').length === 1`, 'restored with the chat')
    .catch(async error => { throw new Error(`${error.message}: ${JSON.stringify(await ev(`const p = document.querySelector('#coordinator'); return { dock: p.dataset.dock, hidden: p.hidden, children: [...p.children].map(c => c.className), layout: localStorage.getItem('promptboard.coordinator.layout') };`))}`); });
  assert.deepEqual(await rect('#coordinator'), resized);

  // Everything is remembered after a reload.
  await browser.reload();
  await wait(`document.querySelector('#coordinator')?.dataset.dock === 'float'`, 'still detached');
  assert.deepEqual(await rect('#coordinator'), resized);

  // Attach: back above the columns, with no floating geometry left.
  await click('#coordinator-dock');
  await wait(`document.querySelector('#coordinator').dataset.dock === 'attached'`, 'attached');
  assert.equal(await ev(`const panel = document.querySelector('#coordinator'); return getComputedStyle(panel).position === 'static' && !panel.style.left && !panel.style.width && (panel.compareDocumentPosition(document.querySelector('#kanban-columns')) & Node.DOCUMENT_POSITION_FOLLOWING) > 0;`), true);

  // Phones always use the attached panel.
  await click('#coordinator-dock');
  await wait(`document.querySelector('#coordinator').dataset.dock === 'float'`, 'detached again');
  await browser.resize(390, 800);
  await wait(`document.querySelector('#coordinator').dataset.dock === 'attached' && !document.querySelector('#coordinator-dock')`, 'attached on a phone');
  assert.equal(await ev(`const r = document.querySelector('#coordinator').getBoundingClientRect(); return r.left >= 0 && r.right <= document.documentElement.clientWidth;`), true);

  assert.equal(calls.length, 1, 'layout changes never call a model');
  assert.deepEqual((await app.board.state()).projects[0].tasks.map(task => task.prompt), ['Build checkout.'], 'nothing on the board changed');
  assert.deepEqual(browser.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);
});
