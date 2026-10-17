// Remote access in a real browser with a SIMULATED network: the remote listener on 127.0.0.1 stands in for Tailscale
// Serve or a Twingate Connector. The phone is Chrome with an iPhone-sized touch viewport, not a real iPhone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const skip = !(await findChrome());
const freePort = () => new Promise(resolve => { const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });

test('Settings turns remote access on and pairs a phone; the phone uses the same app, stays paired, and is sent to pairing when revoked', { skip, timeout: 120000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [{ id: 'codex', available: true }], authAdapter: { installed: async () => true, status: async () => ({ state: 'signed-in' }) } });
  await app.board.createProject({ name: 'Shop' });
  const remotePort = await freePort();
  const browser = await launch({ width: 1280, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  const ev = code => browser.eval(code), wait = (expression, label, ms = 15000) => browser.until(expression, label, ms);
  // On the computer: Settings → Remote access → Twingate on 127.0.0.1 (a Connector on this computer), then Pair a device.
  await browser.goto(`${app.url}/#/kanban`);
  await wait(`!!document.querySelector('#app-settings-open')`, 'app');
  await ev(`document.querySelector('#app-settings-open').click(); document.querySelector('#settings-remote-section').open = true;`);
  await wait(`!!document.querySelector('#set-remote-method')`, 'remote section');
  assert.match(await ev(`return document.querySelector('#set-remote-group').textContent`), /Off\. Promptboard answers only on this computer/);
  await ev(`const s = document.querySelector('#set-remote-method'); s.value = 'twingate'; s.dispatchEvent(new Event('change'));`);
  await wait(`!!document.querySelector('#set-remote-port')`, 'Twingate fields');
  // The test stands in for a Connector on this computer, so it listens on 127.0.0.1 (a private address is the default).
  await ev(`const b = document.querySelector('#set-remote-bind'); b.value = '127.0.0.1'; b.dispatchEvent(new Event('change'));`);
  assert.match(await ev(`return document.querySelector('#set-remote-group').textContent`), /same control as you at this computer/);
  await ev(`const p = document.querySelector('#set-remote-port'); p.value = '${remotePort}'; p.dispatchEvent(new Event('input')); [...document.querySelectorAll('#set-remote-group button')].find(b => b.textContent === 'Save').click();`);
  await wait(`/Twingate · listening on 127\\.0\\.0\\.1:${remotePort}/.test(document.querySelector('#set-remote-group').textContent)`, 'listening');
  assert.match(await ev(`return document.querySelector('#set-remote-group').textContent`), new RegExp(`add a Resource for 127\\.0\\.0\\.1, limited to TCP port ${remotePort}`));
  await ev(`[...document.querySelectorAll('#set-remote-group button')].find(b => b.textContent === 'Pair a device').click();`);
  const code = await wait(`document.querySelector('#set-remote-code')?.textContent`, 'pairing code');
  assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  // The phone: an iPhone-sized touch screen opening the private address.
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await browser.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const remoteUrl = `http://127.0.0.1:${remotePort}`;
  await browser.goto(`${remoteUrl}/#/kanban`);
  await wait(`location.pathname === '/remote' && !!document.querySelector('#code')`, 'pairing page');
  await ev(`document.querySelector('#code').value = ${JSON.stringify(code)}; document.querySelector('#name').value = 'iPhone'; document.querySelector('#pair').requestSubmit();`);
  await wait(`location.pathname === '/' && !!document.querySelector('#kanban-view')`, 'the app after pairing');
  await ev(`location.hash = '#/kanban';`);
  await wait(`!!document.querySelector('#kanban-columns [data-column="todo"]')`, 'the board, served from the computer');
  assert.deepEqual(await ev(`return (await (await fetch('/api/board', { headers: { 'X-STE-Token': token } })).json()).board.projects.map(project => project.name)`), ['Shop']);
  assert.equal(await ev(`return document.documentElement.scrollWidth <= innerWidth`), true, 'no sideways scrolling on the phone');
  assert.equal(await ev(`return document.cookie`), '', 'the device secret is not readable by page scripts');
  // A reload (Safari closed and opened again) keeps the pairing; the phone sees who it is and cannot change remote access.
  await browser.reload();
  await wait(`!!document.querySelector('#app-settings-open')`, 'app after reload');
  await ev(`document.querySelector('#app-settings-open').click(); document.querySelector('#settings-remote-section').open = true;`);
  await wait(`/remotely as “iPhone”/.test(document.querySelector('#set-remote-group').textContent)`, 'remote device notice');
  assert.equal(await ev(`return !!document.querySelector('#set-remote-method')`), false);
  const exceptions = browser.consoleMessages.filter(line => line.startsWith('EXCEPTION'));
  assert.deepEqual(exceptions, []);
  // Revoked on the computer: the phone's next request sends it to pairing.
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  await fetch(`${app.url}/api/remote/sessions/all`, { method: 'DELETE', headers: { 'X-STE-Token': token } });
  await ev(`document.querySelector('#app-settings')?.close(); location.hash = '#/base';`);
  await wait(`location.pathname === '/remote'`, 'back to pairing after revoke', 20000);
});
