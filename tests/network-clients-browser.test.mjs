// Network → Settings in headless Chrome: light and dark at 1440 and 390 px with nothing scrolling sideways (the
// snippet scrolls inside itself); the listener card beside the clients at 1440 and below them on a phone; the create
// dialog and the one-time token dialog; the keyboard (Enter opens, focus lands on the name, Escape returns focus, a
// visible focus ring); no exception or CSP message. Jobs never run here. PB_NETWORK_SCREENSHOTS=<folder> saves PNGs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const chrome = await findChrome();
const J = JSON.stringify;

test('Settings in Chrome: both themes at 1440 and 390 px, the create and token dialogs, and the keyboard', { skip: !chrome, timeout: 240000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, networkWorker: null });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = async (path, method = 'GET', body) => (await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: J(body) } : {}) })).json();
  const agents = [];
  for (const [id, name, provider] of [['lead', 'Research lead', 'claude'], ['scout', 'Scout', 'codex']]) {
    await app.board.base.create({ id, kind: 'profile', name, configuration: { agent: { provider } } });
    agents.push((await call('/api/network/agents', 'POST', { baseResourceId: id, expectedRevision: (await call('/api/network/agents')).revision })).agent);
  }
  await app.board.createProject({ name: 'Site' });
  const project = (await app.board.state()).projects[0];
  await call('/api/network/clients', 'POST', { name: 'Claude Code on this Mac', scopes: { agents: agents.map(agent => agent.id), projects: [project.id], permissions: ['read_agents', 'submit_jobs', 'read_job_result', 'cancel_own_jobs'] }, expiresInDays: 90 });
  const old = await call('/api/network/clients', 'POST', { name: 'Old build script', scopes: { agents: [agents[1].id], permissions: ['submit_jobs'] } });
  await call(`/api/network/clients/${old.client.id}`, 'DELETE', {});
  await call('/api/network/listener', 'PATCH', { enabled: true, port: 0 });

  const browser = await launch({ width: 1440, height: 1000 }); assert.ok(browser); t.after(() => browser.close());
  const ev = code => browser.eval(code), wait = (expression, label, ms = 20000) => browser.until(expression, label, ms);
  const shots = process.env.PB_NETWORK_SCREENSHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  const shot = async name => { if (shots) await writeFile(join(shots, `${name}.png`), await browser.screenshot()); };
  const noSideways = 'document.documentElement.scrollWidth <= document.documentElement.clientWidth';
  // A key that types (Enter, Space) activates the focused control, as a person's key press does.
  const press = async (key, code, keyCode, text) => { await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, text }); await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode }); };
  await browser.goto(`${app.url}/#/network/settings`);
  for (const theme of ['light', 'dark']) {
    await ev(`localStorage.setItem('ste-prompt-engineer.theme', ${J(theme)});`);
    await browser.reload();
    await browser.resize(1440, 1000);
    await wait(`(document.documentElement.dataset.theme || 'light') === ${J(theme)} && /^On at http/.test(document.querySelector('#network-listener-status')?.textContent || '') && document.querySelectorAll('#network-clients-list > li').length >= 2`, `${theme}: Settings loaded`);
    assert.equal(await browser.layout(`const list = document.querySelector('#network-clients-list').getBoundingClientRect(), side = document.querySelector('.network-clients-side').getBoundingClientRect();
      return ${noSideways} && side.left >= list.right && list.width > 400;`), true, `${theme}: the listener and setup beside the clients at 1440`);
    const colors = await ev(`const panel = getComputedStyle(document.querySelector('.network-clients-card')), body = getComputedStyle(document.body); return [panel.backgroundColor, body.color];`);
    assert.equal(theme === 'dark' ? colors[0] !== 'rgb(255, 255, 255)' : colors[0] === 'rgb(255, 255, 255)', true, `${theme}: the card follows the theme (${colors})`);
    await shot(`settings-1440-${theme}`);
    // The create dialog, then the one-time token.
    await ev(`document.querySelector('#network-client-create').click();`);
    await wait(`document.querySelector('#network-clients-dialog')?.open && document.activeElement?.id === 'network-client-name'`, `${theme}: create dialog`);
    assert.equal(await browser.layout(`const box = document.querySelector('#network-clients-dialog').getBoundingClientRect(); return box.right <= innerWidth && box.left >= 0;`), true);
    await shot(`settings-create-1440-${theme}`);
    await ev(`document.querySelector('#network-client-name').value = 'CI pipeline (${theme})'; document.querySelector('#network-clients-dialog input[name="agents"]').checked = true; document.querySelector('#network-client-submit').click();`);
    await wait(`/^pbm_cli_/.test(document.querySelector('#network-client-token')?.textContent || '')`, `${theme}: token dialog`);
    assert.equal(await browser.layout(`const value = document.querySelector('#network-client-token').getBoundingClientRect(), box = document.querySelector('#network-clients-dialog').getBoundingClientRect(); return value.right <= box.right && value.width > 200;`), true, 'the token wraps inside the dialog');
    await shot(`settings-token-1440-${theme}`);
    await browser.resize(390, 844);
    assert.equal(await browser.layout(`const box = document.querySelector('#network-clients-dialog').getBoundingClientRect(), value = document.querySelector('#network-client-token').getBoundingClientRect(); return box.right <= innerWidth + 1 && value.right <= box.right;`), true, `${theme}: token dialog at 390`);
    await shot(`settings-token-390-${theme}`);
    await ev(`document.querySelector('#network-client-token-done').click();`);
    await wait(`!document.querySelector('#network-clients-dialog').open && !document.body.innerHTML.includes('pbm_cli_')`, `${theme}: token gone`);
    // Phone: one column, nothing sideways; the snippet scrolls inside its own box.
    assert.equal(await browser.layout(`const list = document.querySelector('#network-clients-list').getBoundingClientRect(), side = document.querySelector('.network-clients-side').getBoundingClientRect(), pre = document.querySelector('#network-setup-snippet');
      return ${noSideways} && side.top >= list.bottom && pre.getBoundingClientRect().right <= innerWidth && pre.scrollWidth <= pre.clientWidth + 1;`), true, `${theme}: one column at 390, the snippet wraps`);
    await shot(`settings-390-${theme}`);
    await ev(`window.scrollTo(0, document.querySelector('.network-clients-side').getBoundingClientRect().top + scrollY - 70);`);
    await shot(`settings-390-${theme}-setup`);
    await browser.resize(1440, 1000);
  }
  // Keyboard: Tab from the section tabs reaches Create with a visible ring; Enter opens the dialog with the name focused;
  // Escape closes it and focus returns to Create.
  await ev(`window.scrollTo(0, 0); document.querySelector('#network-tab-settings').focus();`);
  await browser.key('Tab', 'Tab', 9);
  await wait(`document.activeElement?.id === 'network-client-create'`, 'Tab reaches Create');
  assert.notEqual(await ev(`return getComputedStyle(document.activeElement).outlineStyle;`), 'none', 'visible focus on Create');
  await press('Enter', 'Enter', 13, '\r');
  await wait(`document.querySelector('#network-clients-dialog')?.open && document.activeElement?.id === 'network-client-name'`, 'Enter opens the dialog');
  await browser.key('Tab', 'Tab', 9);
  await wait(`document.activeElement?.name === 'agents'`, 'Tab reaches the agents');
  await browser.key('Escape', 'Escape', 27);
  await wait(`!document.querySelector('#network-clients-dialog').open && document.activeElement?.id === 'network-client-create'`, 'Escape returns focus');
  // The switch is reachable by Tab from the last client control and shows focus; Space turns the listener off.
  await ev(`[...document.querySelectorAll('#network-clients-list button')].at(-1).focus();`);
  await browser.key('Tab', 'Tab', 9);
  await wait(`document.activeElement?.id === 'network-listener-enabled'`, 'Tab reaches the switch');
  await press(' ', 'Space', 32, ' ');
  await wait(`/^Off\./.test(document.querySelector('#network-listener-status').textContent)`, 'Space turns it off');
  assert.notEqual(await ev(`return getComputedStyle(document.activeElement).outlineStyle;`), 'none', 'visible focus on the switch');
  assert.deepEqual(browser.consoleMessages.filter(message => /EXCEPTION|Uncaught|Content Security Policy|Refused/i.test(message)), []);
});
