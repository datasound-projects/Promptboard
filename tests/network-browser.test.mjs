// Network page in headless Chrome: list beside the profile at 1440 px, list then profile at 390 px, no sideways scroll,
// light and dark themes, real keyboard (tablist arrows, visible focus, Escape returning focus) and Open in Base.
// PB_NETWORK_SCREENSHOTS=<folder> also saves each width and theme as a PNG for a person to look at.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const chrome = await findChrome();
const J = JSON.stringify;

test('Network in Chrome: list and profile side by side or one after the other, both themes, keyboard, Open in Base', { skip: !chrome, timeout: 240000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = async (path, method = 'GET', body) => { const response = await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: J(body) } : {}) }); return response.json(); };
  const site = await app.board.createProject({ name: 'Site' });
  await app.board.base.create({ id: 'lead', kind: 'profile', name: 'Lead', configuration: { agent: { provider: 'claude', model: 'sonnet', instructions: 'Lead the research and quote every source exactly as written.' } } });
  await app.board.base.create({ id: 'reviewer', kind: 'profile', name: 'Reviewer', configuration: { agent: { provider: 'codex' } } });
  await app.board.base.create({ id: 'team', kind: 'agentProfile', name: 'Team', configuration: { agents: [{ resourceId: 'reviewer', role: 'primary' }] } });
  const lead = (await call('/api/network/agents', 'POST', { baseResourceId: 'lead', expectedRevision: 0, displayName: 'A research lead with a rather long display name', tags: ['research'], capabilities: ['research', 'sources'], projectAllowlist: [site.id] })).agent;
  const team = (await call('/api/network/agents', 'POST', { baseResourceId: 'team', expectedRevision: 1, enabled: false })).agent;

  const browser = await launch({ width: 1440, height: 1000 }); assert.ok(browser); t.after(() => browser.close());
  const ev = code => browser.eval(code), wait = (expression, label, ms = 20000) => browser.until(expression, label, ms);
  const shots = process.env.PB_NETWORK_SCREENSHOTS;
  const shot = async name => { if (shots) await writeFile(join(shots, `${name}.png`), await browser.screenshot()); };
  const noSideways = `document.documentElement.scrollWidth <= document.documentElement.clientWidth`;
  const box = selector => `document.querySelector(${J(selector)}).getBoundingClientRect()`;
  const shown = selector => `(() => { const node = document.querySelector(${J(selector)}); return Boolean(node) && getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().height > 0; })()`;
  const colors = {};
  await browser.goto(`${app.url}/#/network`);
  for (const theme of ['light', 'dark']) {
    await ev(`localStorage.setItem('ste-prompt-engineer.theme', ${J(theme)});`);
    await browser.reload();
    await browser.resize(1440, 1000);
    await ev(`location.hash = '#/network/agents/${lead.id}';`);
    await wait(`(document.documentElement.dataset.theme || 'light') === ${J(theme)} && document.querySelector('#network-detail-heading')?.textContent.startsWith('A research lead') && document.querySelectorAll('#network-list [data-agent-id]').length === 2`, `${theme} profile at 1440`);
    // Wide: the directory and the profile sit side by side, top-aligned, with nothing scrolling sideways.
    assert.equal(await browser.layout(`const list = ${box('.network-list-panel')}, detail = ${box('#network-detail')};
      return ${noSideways} && list.width > 250 && detail.left >= list.right && Math.abs(detail.top - list.top) < 40 && detail.width > list.width;`), true, `${theme}: side by side at 1440`);
    assert.equal(await ev(`return document.title;`), 'Network · Promptboard');
    colors[theme] = await ev(`return [getComputedStyle(document.querySelector('#network-detail')).backgroundColor, getComputedStyle(document.querySelector('.network-agent')).color];`);
    await shot(`network-1440-${theme}-profile`);
    await ev(`location.hash = '#/network/graph';`); await wait(`!document.querySelector('#network-panel-soon').hidden`, 'Graph');
    await shot(`network-1440-${theme}-graph`);

    // Phone: the list first; choosing an agent shows its profile instead (focus moves there); Back returns to the row.
    await browser.resize(390, 844);
    await ev(`location.hash = '#/network';`);
    await wait(`!document.querySelector('#network-panel-agents').hidden`, 'Agents at 390');
    assert.equal(await browser.layout(`return ${noSideways} && ${shown('.network-list-panel')} && ${shown('.network-toolbar')} && !${shown('#network-detail')};`), true, `${theme}: list only at 390`);
    await shot(`network-390-${theme}-list`);
    const point = await ev(`const node = document.querySelector('[data-agent-id="${team.id}"]'); node.scrollIntoView({ block: 'center' }); const r = node.getBoundingClientRect(); return { x: r.left + 40, y: r.top + 20 };`);
    await browser.click(point.x, point.y); // A real tap on the row.
    await wait(`location.hash === '#/network/agents/${team.id}' && document.activeElement?.id === 'network-detail-heading'`, `${theme}: profile focused at 390`);
    assert.equal(await browser.layout(`return ${noSideways} && ${shown('#network-detail')} && !${shown('.network-list-panel')} && !${shown('.network-toolbar')} && ${shown('.network-back')};`), true, `${theme}: profile only at 390`);
    await shot(`network-390-${theme}-profile`);
    await ev(`document.querySelector('.network-back').click();`);
    await wait(`location.hash === '#/network' && document.activeElement?.dataset.agentId === ${J(team.id)}`, `${theme}: back to the chosen row`);
    assert.equal(await browser.layout(`return ${noSideways} && ${shown('.network-list-panel')} && !${shown('#network-detail')};`), true);
  }
  assert.notDeepEqual(colors.light, colors.dark, 'the profile follows the theme');

  // Keyboard in a real browser: arrows move between section tabs with a visible focus ring; Escape closes the dialog
  // and returns focus to the button that opened it.
  await browser.resize(1440, 1000);
  await ev(`location.hash = '#/network';`); await wait(`!document.querySelector('#network-panel-agents').hidden`, 'Agents');
  await ev(`document.querySelector('#network-tab-agents').focus();`);
  await browser.key('ArrowRight', 'ArrowRight', 39);
  await wait(`location.hash === '#/network/graph' && document.activeElement?.id === 'network-tab-graph' && document.activeElement.getAttribute('aria-selected') === 'true'`, 'ArrowRight to Graph');
  assert.notEqual(await ev(`return getComputedStyle(document.activeElement).outlineStyle;`), 'none', 'visible focus');
  await browser.key('ArrowLeft', 'ArrowLeft', 37);
  await wait(`location.hash === '#/network' && document.activeElement?.id === 'network-tab-agents' && !document.querySelector('#network-panel-agents').hidden`, 'ArrowLeft to Agents');
  await ev(`document.querySelector('#network-register').focus();`);
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); // Activates the focused button.
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await wait(`document.querySelector('#network-dialog').open && document.querySelector('#network-form-base') && document.activeElement?.id === 'network-form-base'`, 'register dialog by keyboard');
  await shot('network-1440-dark-register');
  await browser.key('Escape', 'Escape', 27);
  await wait(`!document.querySelector('#network-dialog').open && document.activeElement?.id === 'network-register'`, 'Escape returns focus');

  // Open in Base: Base's own editor on the real resource; Back returns to the profile.
  await ev(`location.hash = '#/network/agents/${lead.id}';`); await wait(`document.querySelector('#network-open-base')`, 'profile');
  await ev(`document.querySelector('#network-open-base').click();`);
  await wait(`location.hash === '#/base' && document.querySelector('#base-resource-name')?.value === 'Lead' && document.querySelector('.base-resource-form').dataset.kind === 'profile'`, 'Lead open in Base');
  await ev(`history.back();`);
  await wait(`location.hash === '#/network/agents/${lead.id}' && document.querySelector('#network-detail-heading')`, 'back to the profile');
  assert.deepEqual(browser.consoleMessages.filter(message => /EXCEPTION|Uncaught|Content Security Policy/i.test(message)), []);
});
