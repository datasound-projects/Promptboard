import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, until } from './helpers/ui-harness.mjs';

test('Chat can be the start page; an explicit route still wins and Settings preserves the selection', async t => {
  const prefs = { 'promptboard.settings.start-page': 'chat' };
  const first = await setup(t, { prefs }); await first.idle();
  await until(() => first.$('#chat-version')?.textContent.includes('0.4.0'), 'Chat metadata loaded');
  assert.equal(first.win.location.hash, '#/chat');
  assert.equal(first.win.document.title, 'Chat · Promptboard');
  assert.equal(first.$('#chat-view').hidden, false); assert.equal(first.$('#prompt-view').hidden, true);
  assert.equal(first.$('#chat-open').getAttribute('aria-current'), 'page');
  assert.equal(first.calls.length, 0, 'opening Chat never calls a model');
  const explicit = await setup(t, { prefs, hash: '#/kanban' }); await explicit.idle();
  assert.equal(explicit.$('#kanban-view').hidden, false); assert.equal(explicit.$('#chat-view').hidden, true);
  explicit.$('#app-settings-open').click(); await explicit.idle();
  assert.equal(explicit.$('#set-start').value, 'chat');
});

test('the global icon, sidebar and skip link navigate to the dedicated page without running any agent', async t => {
  const ctx = await setup(t, { hash: '#/base' }); await ctx.idle();
  ctx.$('#chat-open').dispatchEvent(new ctx.win.MouseEvent('click', { bubbles: true, cancelable: true }));
  await until(() => ctx.win.document.documentElement.dataset.page === 'chat' && ctx.$('#chat-version')?.textContent.includes('0.4.0'), 'Chat page');
  assert.equal(ctx.$('#base-view').hidden, true);
  assert.equal(ctx.$('#sidebar').getAttribute('aria-label'), 'Chat conversations');
  assert.equal(ctx.$('#chat-sidebar-panel').hidden, false);
  ctx.$('#skip-link').dispatchEvent(new ctx.win.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(ctx.win.document.activeElement.id, 'chat-view');
  assert.equal(ctx.win.location.hash, '#/chat');
  assert.equal(ctx.calls.length, 0);
});
