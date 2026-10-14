import test from 'node:test';
import assert from 'node:assert/strict';
import { findChrome } from './helpers/browser.mjs';
import { drawerState, researchPage } from './helpers/research.mjs';

const chrome = await findChrome();
const J = JSON.stringify;

test('Research panel: opens beside Create Context, resizes, maximizes to the sidebar, minimizes, and shares the drawer without losing work', { skip: !chrome, timeout: 180000 }, async t => {
  const { browser, ev, wait, calls } = await researchPage(t);
  const click = selector => ev(`document.querySelector(${J(selector)}).click();`);
  assert.equal(await ev(`return document.querySelector('#origin-context-open').nextElementSibling.id;`), 'origin-research-open', 'beside Create Context');

  await click('#origin-research-open');
  await wait(`document.querySelector('#origin-drawer').dataset.mode === 'research' && document.querySelector('#origin-research-provider, #origin-research-cli')`, 'open');
  assert.equal((await drawerState(ev)).width, 500, 'about 500 px by default');
  assert.deepEqual(await ev(`return [...document.querySelectorAll('.origin-research-modes [role=radio]')].map(b => [b.textContent, b.getAttribute('aria-checked')]);`),
    [['Chat', 'true'], ['Swarm', 'false'], ['Decision Lab', 'false'], ['Audit', 'false']]);
  const scopes = await ev(`return [...document.querySelectorAll('#origin-research-scope option')].map(o => o.textContent);`);
  assert.ok(scopes.includes('Design › Stack') && scopes.includes('Decide › Pricing model') && scopes[0] === 'Whole project', scopes.join(' | '));
  assert.equal(await ev(`return document.querySelector('#origin-research-web').getAttribute('aria-pressed');`), 'false', 'web search starts off');

  // Drag the left edge: wider, remembered.
  const box = await drawerState(ev), y = 400;
  for (const [type, x] of [['mousePressed', box.left + 1], ['mouseMoved', box.left - 60], ['mouseMoved', box.left - 120], ['mouseReleased', box.left - 120]]) await browser.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  await wait(`Math.abs(document.querySelector('#origin-drawer').getBoundingClientRect().width - ${box.width + 121}) <= 2`, 'resized');
  assert.equal(await ev(`return Number(localStorage.getItem('promptboard.origin.research-width'));`), (await drawerState(ev)).width);

  // Maximize up to the navigation sidebar, then restore.
  await click('#origin-research-max');
  const sidebarRight = await ev(`return Math.round(document.querySelector('#sidebar').getBoundingClientRect().right);`);
  await wait(`document.querySelector('#origin-drawer').getBoundingClientRect().left > ${sidebarRight} && document.querySelector('#origin-drawer').getBoundingClientRect().left - ${sidebarRight} <= 14`, 'maximized to the sidebar');
  assert.equal(await ev(`return document.querySelector('#origin-research-max').getAttribute('aria-label');`), 'Restore width');
  await click('#origin-research-max');
  await wait(`Math.abs(document.querySelector('#origin-drawer').getBoundingClientRect().width - ${box.width + 121}) <= 2`, 'restored');

  // An unsent question survives every panel switch.
  await ev(`const i = document.querySelector('#origin-research-input'); i.value = 'Which payment provider fits?'; i.dispatchEvent(new Event('input', { bubbles: true }));`);
  await click('#origin-research-minimize');
  await wait(`document.querySelector('#origin-drawer').hidden && !document.querySelector('#origin-research-mini').hidden && document.activeElement?.id === 'origin-research-mini'`, 'minimized');
  await click('#origin-research-mini');
  await wait(`document.querySelector('#origin-drawer').dataset.mode === 'research' && document.querySelector('#origin-research-input').value === 'Which payment provider fits?'`, 'restored from the box');

  // The record editor and Project Context take the drawer; Research yields and keeps its state.
  await ev(`document.querySelector('.origin-nav-item[data-section="architecture"]').click();`);
  await wait(`[...document.querySelectorAll('#origin-main .origin-row-open')].some(b => b.textContent.includes('Checkout API'))`, 'architecture');
  await ev(`[...document.querySelectorAll('#origin-main .origin-row-open')].find(b => b.textContent.includes('Checkout API')).click();`);
  await wait(`!document.querySelector('#origin-drawer').dataset.mode && document.querySelector('#origin-drawer-title')?.value === 'Checkout API'`, 'record editor took the drawer');
  assert.equal(await ev(`return document.querySelectorAll('#origin-drawer').length + document.querySelectorAll('.origin-research-body').length;`), 1, 'never two panels');
  await click('#origin-research-open');
  await wait(`document.querySelector('#origin-drawer').dataset.mode === 'research' && document.querySelector('#origin-research-input').value === 'Which payment provider fits?'`, 'research back, editor closed');
  assert.equal(await ev(`return JSON.parse(document.querySelector('#origin-research-scope').value).id + ' ' + document.querySelector('#origin-research-scope').selectedOptions[0].textContent;`), 'c1 Checkout API', 'a new chat starts on the record that was open');
  await click('#origin-context-open');
  await wait(`document.querySelector('#origin-drawer').dataset.mode === 'context'`, 'Project Context took the drawer');
  await click('#origin-research-open');
  await wait(`document.querySelector('#origin-drawer').dataset.mode === 'research'`, 'research again');

  // History and settings views; Escape closes.
  await click('#origin-research-history');
  await wait(`document.querySelector('.origin-research-chats')?.textContent === 'No research chats yet.'`, 'empty history');
  await click('#origin-research-cli');
  await wait(`document.querySelector('#origin-research-provider') && [...document.querySelector('#origin-research-model').options].some(o => o.value === 'gpt-5.5' || o.value === 'sonnet')`, 'CLI settings');
  await ev(`document.querySelector('#origin-research-input')?.focus() || document.querySelector('#origin-research-provider').focus();`);
  await ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
  await wait(`document.querySelector('#origin-drawer').hidden && document.querySelector('#origin-research-open').getAttribute('aria-pressed') === 'false'`, 'Escape closes');

  // Phones: one full-width sheet.
  await browser.resize(390, 800);
  await click('#origin-research-open');
  await wait(`document.querySelector('#origin-drawer').dataset.mode === 'research'`, 'open on a phone');
  const phone = await drawerState(ev);
  assert.ok(phone.left <= 8 && phone.right >= 382, JSON.stringify(phone));
  assert.equal(calls.length, 0, 'opening and arranging Research never calls a model');
  assert.deepEqual(browser.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);
});

test('Research and project switching: a run stops and keeps its partial answer; each project has its own chats; the edge resizes by keyboard', { skip: !chrome, timeout: 180000 }, async t => {
  const researchRunner = call => new Promise((resolve, reject) => {
    call.onEvent({ type: 'delta', text: 'Early notes' });
    call.signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { code: 'ABORTED', partial: 'Early notes' })), { once: true });
  });
  const { browser, ev, wait, call, originId } = await researchPage(t, { server: { researchRunner } });
  const other = (await call('/api/origin/projects', 'POST', { name: 'Blog' })).project;
  await browser.reload();
  await wait(`document.querySelector('#origin-view').dataset.save === 'saved' && [...document.querySelector('#origin-project').options].some(o => o.value === ${J(other.id)})`, 'two projects');
  const click = selector => ev(`document.querySelector(${J(selector)}).click();`);
  await click('#origin-research-open');
  await wait(`document.querySelector('#origin-research-send') && !document.querySelector('#origin-research-send').disabled`, 'ready');
  // Keyboard: the left edge is a separator; the arrow keys resize it.
  const before = (await drawerState(ev)).width;
  await ev(`document.querySelector('.origin-research-resize').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));`);
  await wait(`Math.abs(document.querySelector('#origin-drawer').getBoundingClientRect().width - ${before + 40}) <= 2`, 'wider by keyboard');
  assert.equal(await ev(`return document.querySelector('.origin-research-resize').getAttribute('role');`), 'separator');

  await ev(`const i = document.querySelector('#origin-research-input'); i.value = 'Long research'; i.dispatchEvent(new Event('input', { bubbles: true })); i.closest('form').requestSubmit();`);
  await wait(`document.querySelector('.is-live .origin-research-text')?.textContent === 'Early notes'`, 'running');
  await ev(`const s = document.querySelector('#origin-project'); s.value = ${J(other.id)}; s.dispatchEvent(new Event('change', { bubbles: true }));`);
  await wait(`document.querySelector('#origin-project').value === ${J(other.id)} && document.querySelector('#origin-drawer').hidden`, 'switched; the panel closed');
  await click('#origin-research-open');
  await click('#origin-research-history');
  await wait(`document.querySelector('.origin-research-chats')?.textContent === 'No research chats yet.'`, 'the other project has no chats');
  // The stopped run kept its partial answer in its own project.
  let chats;
  for (let i = 0; i < 40 && !(chats = (await call(`/api/origin/research/${originId}/chats`)).chats).some(chat => chat.messages === 2); i++) await new Promise(resolve => setTimeout(resolve, 100));
  const stored = (await call(`/api/origin/research/${originId}/chats/${chats[0].id}`)).chat;
  assert.deepEqual(stored.messages.map(message => [message.role, message.text, message.status || '']), [['user', 'Long research', ''], ['assistant', 'Early notes', 'stopped']]);
  assert.deepEqual(browser.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);
});
