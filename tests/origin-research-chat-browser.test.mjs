import test from 'node:test';
import assert from 'node:assert/strict';
import { findChrome } from './helpers/browser.mjs';
import { researchPage } from './helpers/research.mjs';

const chrome = await findChrome();
const J = JSON.stringify;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('Research chat streams the answer, stops on request, resumes the CLI session and keeps history across reloads', { skip: !chrome, timeout: 180000 }, async t => {
  const runs = [];
  let gate = null;
  const researchRunner = async call => {
    runs.push({ provider: call.provider, session: call.session, prompt: call.prompt, web: call.web });
    if (call.prompt.includes('HOLD')) {
      call.onEvent({ type: 'delta', text: 'First findings' });
      await new Promise((resolve, reject) => call.signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { code: 'ABORTED', partial: 'First findings' })), { once: true }));
    }
    call.onEvent({ type: 'activity', kind: 'search', label: 'stripe pricing' });
    await (gate ? gate : pause(50));
    for (const text of ['## Payment\n', 'Use **Stripe** ', 'for cards.']) { call.onEvent({ type: 'delta', text }); await pause(250); }
    return { text: '## Payment\nUse **Stripe** for cards.', session: call.session?.id || 'thread-1' };
  };
  const { browser, ev, wait } = await researchPage(t, { server: { researchRunner } });
  const click = selector => ev(`document.querySelector(${J(selector)}).click();`);
  const ask = async text => { await ev(`const i = document.querySelector('#origin-research-input'); i.value = ${J(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.closest('form').requestSubmit();`); };

  await click('#origin-research-open');
  await wait(`document.querySelector('#origin-research-send') && !document.querySelector('#origin-research-send').disabled`, 'ready to send');
  await ask('Which payment provider?');
  await wait(`document.querySelector('.origin-research-message.is-user')?.textContent === 'Which payment provider?'`, 'question shown');
  await wait(`/Searching the web: stripe pricing/.test(document.querySelector('.origin-research-activity')?.textContent || '')`, 'web activity shown');
  // The answer grows while the CLI writes it.
  await wait(`document.querySelector('.is-live .origin-research-text')?.textContent === '## Payment\\n'`, 'first text');
  assert.equal(await ev(`return document.querySelector('#origin-research-send').getAttribute('aria-label');`), 'Stop', 'Send becomes Stop while the CLI works');
  await wait(`document.querySelector('.is-live .origin-research-text')?.textContent.includes('Use **Stripe**')`, 'more text');
  await wait(`!document.querySelector('.is-live') && document.querySelector('.origin-research-message.is-assistant h3')?.textContent === 'Payment' && document.querySelector('.origin-research-message.is-assistant strong')?.textContent === 'Stripe'`, 'final answer as Markdown')
    .catch(async error => { throw new Error(`${error.message}: ${await ev(`return document.querySelector('#origin-research-log')?.innerHTML.slice(0, 1500) + ' ERROR=' + (document.querySelector('#origin-drawer .origin-inline-error')?.textContent || '');`)}`); });
  assert.match(await ev(`return document.querySelector('.origin-research-message.is-assistant .origin-research-meta').textContent;`), /Codex|Claude Code/);
  assert.equal(runs[0].web, false, 'web search was off');

  // A follow-up resumes the CLI session with only the question.
  await ask('And fees?');
  await wait(`document.querySelectorAll('.origin-research-message.is-assistant:not(.is-live)').length === 2`, 'second answer');
  assert.equal(runs[1].prompt, '# Question\nAnd fees?');
  assert.equal(runs[1].session.resume, true);

  // Stop keeps the partial answer.
  await ask('HOLD this research');
  await wait(`document.querySelector('.is-live .origin-research-text')?.textContent === 'First findings'`, 'partial text');
  await click('#origin-research-send');
  await wait(`!document.querySelector('.is-live') && [...document.querySelectorAll('.origin-research-message.is-assistant .origin-research-meta')].some(m => m.textContent.includes('Stopped'))`, 'stopped and kept');
  assert.equal(await ev(`return [...document.querySelectorAll('.origin-research-message.is-assistant')].at(-1).textContent.includes('First findings');`), true);
  await wait(`document.querySelector('#origin-research-send').getAttribute('aria-label') === 'Send'`, 'ready again');

  // History survives a reload; a chat can be resumed, searched and deleted after confirmation.
  await browser.reload();
  await wait(`document.querySelector('#origin-view').dataset.save === 'saved' && !document.querySelector('#origin-research-open').hidden`, 'reloaded');
  await click('#origin-research-open');
  await wait(`document.querySelector('#origin-research-history')`, 'panel again');
  assert.equal(await ev(`return document.querySelectorAll('.origin-research-message').length;`), 0, 'a reload starts a new chat');
  await click('#origin-research-history');
  await wait(`document.querySelector('.origin-research-chat strong')?.textContent === 'Which payment provider?'`, 'chat in history');
  assert.match(await ev(`return document.querySelector('.origin-research-chat small').textContent;`), /6 messages/);
  await ev(`const s = document.querySelector('#origin-research-search'); s.value = 'nothing like this'; s.dispatchEvent(new Event('input', { bubbles: true }));`);
  await wait(`document.querySelector('.origin-research-chats')?.textContent === 'No chat matches.'`, 'search filters');
  await ev(`const s = document.querySelector('#origin-research-search'); s.value = 'stripe'; s.dispatchEvent(new Event('input', { bubbles: true }));`);
  await wait(`document.querySelectorAll('.origin-research-chat').length === 1`, 'search finds the answer text');
  await click('.origin-research-chat-open');
  await wait(`document.querySelectorAll('.origin-research-message').length === 6 && document.querySelector('.origin-research-message.is-assistant h3')`, 'chat resumed with every message');
  await ask('One more?');
  await wait(`document.querySelectorAll('.origin-research-message.is-assistant:not(.is-live)').length === 4`, 'continued after reload');
  assert.equal(runs.at(-1).session.resume, true, 'the CLI session continues after a reload');
  await click('#origin-research-history');
  await wait(`document.querySelector('.origin-research-chat [aria-label^="Delete"]')`, 'history again');
  await click('.origin-research-chat [aria-label^="Delete"]');
  await wait(`document.activeElement?.id === 'origin-research-delete-confirm'`, 'asks first');
  await click('#origin-research-delete-confirm');
  await wait(`document.querySelector('.origin-research-chats')?.textContent.includes('No chat matches.') || document.querySelector('.origin-research-chats')?.textContent === 'No research chats yet.'`, 'deleted');
  assert.deepEqual(browser.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);
});
