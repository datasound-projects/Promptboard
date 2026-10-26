// Network → Settings (public/network-clients.js inside app.js) in jsdom against the real server: opening Network and
// Settings opens no port and writes nothing; the machine listener turned on, its port changed and refused when the app
// uses it; a client created with a one-time token that reaches the clipboard only when Copy is clicked and leaves the
// page when the dialog closes; the list never shows a token; rotate and revoke with confirmation; setup snippets that
// name the environment variable, never the token; keyboard and labels. No CLI runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setup, until } from './helpers/ui-harness.mjs';
import { fakeWorker } from './helpers/network-worker.mjs';

const freePort = () => new Promise(resolve => { const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
async function call(ctx, path, method = 'GET', body, headers = {}) {
  const response = await fetch(`${ctx.app.url}${path}`, { method, headers: { 'X-STE-Token': ctx.win.__pbTest.token, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, json: await response.json() };
}
const machine = (url, token, path = '/machine/v1/agents') => fetch(`${url}${path}`, { headers: { Authorization: `Bearer ${token}` } }).then(response => response.status);
const key = (ctx, node, name) => node.dispatchEvent(new ctx.win.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));

test('Settings: opening it opens nothing; the listener turns on and changes port; a client’s token shows once, copies only on click and leaves the page; rotate and revoke; snippets never hold a token', async t => {
  const ctx = await setup(t, { hash: '#/network/settings', executor: null, networkWorker: fakeWorker() }); const { $, win } = ctx;
  await until(() => /^Off\./.test($('#network-listener-status')?.textContent || ''), 'the listener shows off');
  assert.deepEqual([$('#network-tab-settings').getAttribute('aria-selected'), $('#network-panel-settings').hidden, $('#network-panel-soon').hidden, $('#network-panel-agents').hidden], ['true', false, true, true]);
  assert.equal($('#network-sections a[aria-current="page"]').dataset.section, 'settings');
  assert.deepEqual([$('#network-listener-enabled').checked, $('#network-listener-port').value, (await ctx.app.machine.status()).listener.listening], [false, '4330', false]);
  assert.equal(await access(join(ctx.dataDir, 'network')).then(() => true, () => false), false, 'visiting Network and Settings wrote nothing');
  assert.match($('#network-clients-empty').textContent, /No clients yet\./);
  // Snippets are there before anything is turned on, with the variable and never a value.
  for (const button of $('.network-clients-hosts').querySelectorAll('button')) {
    button.click();
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    assert.match($('#network-setup-snippet').textContent, button.dataset.host === 'other' ? /PROMPTBOARD_MACHINE_TOKEN_FILE/ : /PROMPTBOARD_MACHINE_TOKEN/, button.dataset.host);
    assert.match($('#network-setup-snippet').textContent, /127\.0\.0\.1:4330/);
  }
  // No agent yet: Create explains what is needed; Escape closes and focus returns.
  $('#network-client-create').focus(); $('#network-client-create').click();
  await until(() => $('#network-clients-dialog').open && /Register an agent in Network first/.test($('#network-clients-dialog').textContent), 'needs an agent');
  key(ctx, $('#network-clients-dialog'), 'Escape');
  assert.deepEqual([$('#network-clients-dialog').open, win.document.activeElement], [false, $('#network-client-create')]);

  await ctx.app.board.base.create({ id: 'lead', kind: 'profile', name: 'Lead', configuration: { agent: { provider: 'claude' } } });
  const lead = (await call(ctx, '/api/network/agents', 'POST', { baseResourceId: 'lead', expectedRevision: (await call(ctx, '/api/network/agents')).json.revision })).json.agent;
  win.location.hash = '#/network'; await until(() => !$('#network-panel-agents').hidden, 'agents');
  win.location.hash = '#/network/settings'; await until(() => !$('#network-panel-settings').hidden, 'settings again'); await ctx.idle();

  // The listener: a free port, then on; the app's own port is refused with the server's reason.
  const port = await freePort();
  $('#network-listener-port').value = String(port); $('#network-listener-save').click();
  await until(() => /Off\./.test($('#network-listener-status').textContent) && /off/.test($('#network-status').textContent), 'port saved');
  $('#network-listener-enabled').checked = true; $('#network-listener-enabled').dispatchEvent(new win.Event('change', { bubbles: true }));
  await until(() => $('#network-listener-status').textContent === `On at http://127.0.0.1:${port}: this computer only.`, 'listening');
  assert.equal((await ctx.app.machine.status()).listener.url, `http://127.0.0.1:${port}`);
  $('#network-listener-port').value = new URL(ctx.app.url).port; $('#network-listener-save').click();
  await until(() => /already uses this port/.test($('#network-error').textContent), 'the app port is refused');
  $('#network-listener-port').value = '80'; $('#network-listener-save').click();
  await until(() => /from 1024 to 65535/.test($('#network-error').textContent), 'a low port is refused in the page');

  // Create: the form, then the token once.
  $('#network-client-create').focus(); $('#network-client-create').click();
  await until(() => $('#network-client-name'), 'create form');
  assert.equal(win.document.activeElement, $('#network-client-name'));
  for (const control of $('#network-clients-dialog').querySelectorAll('input, select, button')) assert.ok(control.closest('label') || control.getAttribute('aria-label') || control.textContent.trim(), `labelled ${control.outerHTML.slice(0, 80)}`);
  assert.deepEqual([...$('#network-clients-dialog').querySelectorAll('input[name="permissions"]')].map(input => [input.value, input.checked]),
    [['read_agents', true], ['submit_jobs', true], ['read_job_result', true], ['cancel_own_jobs', true], ['read_scoped_memory', false]], 'memory is off unless chosen');
  $('#network-client-submit').click();
  await until(() => /Name the client\./.test($('#network-clients-dialog').textContent), 'a name is needed');
  $('#network-client-name').value = 'Claude Code on this Mac'; $('#network-client-submit').click();
  await until(() => /Choose at least one agent\./.test($('#network-clients-dialog').textContent), 'an agent is needed');
  $(`#network-clients-dialog input[name="agents"][value="${lead.id}"]`).checked = true; $('#network-client-submit').click();
  await until(() => $('#network-client-token'), 'the token');
  const token = $('#network-client-token').textContent;
  assert.match(token, /^pbm_cli_[0-9a-f]{20}_[A-Za-z0-9_-]{43}$/);
  assert.equal(win.document.activeElement, $('#network-client-token'));
  assert.match($('#network-clients-dialog').textContent, /will not show this token again/);
  assert.equal(ctx.copied(), undefined, 'nothing reaches the clipboard by itself');
  $('#network-client-token-copy').click(); await until(() => ctx.copied() === token, 'copied on click');
  assert.equal(await machine(`http://127.0.0.1:${port}`, token), 200, 'the shown token works');
  $('#network-client-token-done').click();
  assert.equal($('#network-clients-dialog').open, false);
  assert.ok(!win.document.documentElement.outerHTML.includes(token), 'the token left the page');
  assert.equal(win.document.activeElement, $('#network-client-create'));
  await until(() => $('#network-clients-list > li'), 'listed');
  const row = $('#network-clients-list > li');
  assert.match(row.textContent, new RegExp(`Claude Code on this Mac.*Active.*Lead.*pbm_…${token.slice(-4)}.*Never`));
  // Snippets name the listener and the variable; Copy copies the snippet, never a token.
  for (const button of $('.network-clients-hosts').querySelectorAll('button')) {
    button.click(); $('#network-setup-copy').click(); await until(() => ctx.copied() === $('#network-setup-snippet').textContent, `copy ${button.dataset.host}`);
    assert.ok($('#network-setup-snippet').textContent.includes(`http://127.0.0.1:${port}`) && !ctx.copied().includes(token.split('_').at(-1)), button.dataset.host);
  }
  assert.match($('#network-setup-snippet').textContent, /Authorization: Bearer \$PROMPTBOARD_MACHINE_TOKEN/);

  // Rotate: confirm, a new token once; the old one stops.
  const id = row.dataset.clientId;
  $(`#network-client-rotate-${id}`).click();
  await until(() => $('#network-client-confirm') && /Rotate the token/.test($('#network-clients-dialog').textContent), 'rotate confirm');
  assert.equal(win.document.activeElement, $('#network-client-confirm'));
  $('#network-client-confirm').click();
  await until(() => $('#network-client-token'), 'the new token');
  const rotated = $('#network-client-token').textContent;
  assert.notEqual(rotated, token);
  assert.deepEqual([await machine(`http://127.0.0.1:${port}`, token), await machine(`http://127.0.0.1:${port}`, rotated)], [401, 200]);
  key(ctx, $('#network-clients-dialog'), 'Escape');
  assert.ok(!win.document.documentElement.outerHTML.includes(rotated), 'Escape also removes it');
  // Revoke: confirm; it shows as revoked without actions, and its token stops.
  await until(() => $(`#network-client-revoke-${id}`), 'redrawn');
  $(`#network-client-revoke-${id}`).click();
  await until(() => /cannot be undone/.test($('#network-clients-dialog').textContent), 'revoke confirm');
  $('#network-client-confirm').click();
  await until(() => $('#network-clients-list > li')?.dataset.status === 'revoked', 'revoked');
  assert.deepEqual([$(`#network-client-revoke-${id}`), $(`#network-client-rotate-${id}`), /Revoked/.test($('#network-clients-list > li').textContent)], [null, null, true]);
  assert.equal(await machine(`http://127.0.0.1:${port}`, rotated), 401);
  assert.match($('#network-status').textContent, /was revoked/);
  // Off closes the port again.
  $('#network-listener-enabled').checked = false; $('#network-listener-enabled').dispatchEvent(new win.Event('change', { bubbles: true }));
  await until(() => /^Off\./.test($('#network-listener-status').textContent), 'off again');
  assert.equal((await ctx.app.machine.status()).listener.listening, false);
  // Leaving the section with a dialog open closes it.
  $('#network-client-create').click(); await until(() => $('#network-clients-dialog').open, 'dialog');
  win.location.hash = '#/network'; await until(() => !$('#network-clients-dialog').open, 'closed on leaving');
});
