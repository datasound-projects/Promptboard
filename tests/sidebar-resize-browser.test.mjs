import test from 'node:test';
import assert from 'node:assert/strict';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const chrome = await findChrome();

test('the sidebar resizes, collapses and opens again by dragging its edge, on every page', { skip: !chrome, timeout: 120000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [{ id: 'claude', available: true }],
    authAdapter: { installed: async () => true, status: async () => ({ state: 'signed-in' }) }, runner: async () => ({ text: 'ok' }) });
  const browser = await launch({ width: 1280, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  const mouse = (type, x, extra = {}) => browser.send('Input.dispatchMouseEvent', { type, x, y: 400, button: 'left', ...extra });
  const drag = async (from, to) => { await mouse('mousePressed', from, { buttons: 1, clickCount: 1 }); for (const x of [from + Math.sign(to - from) * 10, to]) await mouse('mouseMoved', x, { buttons: 1 }); await mouse('mouseReleased', to, { clickCount: 1 }); };
  const geometry = () => browser.eval(`const side = document.querySelector('#sidebar'), view = [...document.querySelectorAll('main.workspace')].find(main => !main.hidden);
    return { collapsed: getComputedStyle(side).display === 'none', sidebar: Math.round(side.getBoundingClientRect().width), content: Math.round(view.getBoundingClientRect().left),
      grip: Math.round(document.querySelector('#sidebar-resizer').getBoundingClientRect().left), saved: localStorage.getItem('ste-prompt-engineer.sidebar-width') };`);

  await browser.goto(`${app.url}/#/kanban`);
  await browser.until(`token && document.querySelector('#workspace-panel:not([hidden])')`, 'Kanban sidebar');
  assert.deepEqual(await geometry(), { collapsed: false, sidebar: 272, content: 272, grip: 268, saved: null });

  await drag(272, 400);
  assert.deepEqual(await geometry(), { collapsed: false, sidebar: 400, content: 400, grip: 396, saved: '400' }, 'Dragging right widens the sidebar and moves the page.');
  await drag(400, 900);
  assert.equal((await geometry()).sidebar, 560, 'The sidebar stops at its widest width.');
  await drag(560, 150);
  assert.equal((await geometry()).sidebar, 200, 'Dragging left stops at the narrowest width first.');

  // The width is the same on every page and after a reload.
  for (const [hash, panel] of [['#/', '#history-panel'], ['#/origin', '#origin-sidebar-panel'], ['#/base', '#base-sidebar-panel']]) {
    await browser.eval(`location.hash = ${JSON.stringify(hash)};`);
    await browser.until(`!document.querySelector(${JSON.stringify(panel)}).hidden`, `${hash} sidebar`);
    assert.deepEqual(await geometry(), { collapsed: false, sidebar: 200, content: 200, grip: 196, saved: '200' }, hash);
  }
  await browser.reload();
  await browser.until(`token && !document.querySelector('#base-sidebar-panel').hidden`, 'Base after reload');
  assert.equal((await geometry()).sidebar, 200);

  // Far to the left collapses it; from the left screen edge it opens again.
  await drag(200, 40);
  assert.deepEqual(await geometry(), { collapsed: true, sidebar: 0, content: 0, grip: 0, saved: '200' });
  assert.equal(await browser.eval(`return document.querySelector('#menu-toggle').getAttribute('aria-expanded');`), 'false');
  await drag(2, 330);
  assert.deepEqual(await geometry(), { collapsed: false, sidebar: 330, content: 330, grip: 326, saved: '330' });
  assert.equal(await browser.eval(`return document.querySelector('#menu-toggle').getAttribute('aria-expanded');`), 'true');

  // Double-click resets the width. The keyboard resizes, and Enter collapses and opens.
  await mouse('mousePressed', 330, { clickCount: 2 }); await mouse('mouseReleased', 330, { clickCount: 2 });
  assert.deepEqual(await geometry(), { collapsed: false, sidebar: 272, content: 272, grip: 268, saved: null });
  await browser.eval(`document.querySelector('#sidebar-resizer').focus();`);
  await browser.key('ArrowRight', 'ArrowRight', 39);
  assert.equal((await geometry()).sidebar, 288);
  assert.equal(await browser.eval(`return document.querySelector('#sidebar-resizer').getAttribute('aria-valuenow');`), '288');
  await browser.key('Enter');
  assert.equal((await geometry()).collapsed, true);
  await browser.key('Enter');
  assert.equal((await geometry()).sidebar, 288);

  // Phones keep the drawer; there is no resize edge.
  await browser.resize(390, 800);
  await browser.until(`getComputedStyle(document.querySelector('#sidebar-resizer')).display === 'none'`, 'no resize edge on a phone');
  assert.deepEqual(browser.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);
});
