import test from 'node:test';
import assert from 'node:assert/strict';
import { findChrome } from './helpers/browser.mjs';
import { researchPage } from './helpers/research.mjs';

const chrome = await findChrome();
const J = JSON.stringify;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('Research chat streams the answer, stops on request, resumes the CLI session and keeps history across reloads', { skip: !chrome, timeout: 180000 }, async t => {
  const runs = [];
  // The first answer pauses after its first piece until the test has seen that piece on screen: text shows while the
  // CLI still works, whatever the paint speed (headless Chrome rasterizes in software and can batch updates).
  let seenFirst, firstSeen = new Promise(resolve => { seenFirst = resolve; });
  let gate = null;
  const researchRunner = async call => {
    runs.push({ provider: call.provider, session: call.session, prompt: call.prompt, web: call.web });
    if (call.prompt.includes('HOLD')) {
      call.onEvent({ type: 'delta', text: 'First findings' });
      await new Promise((resolve, reject) => call.signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { code: 'ABORTED', partial: 'First findings' })), { once: true }));
    }
    call.onEvent({ type: 'activity', kind: 'search', label: 'stripe pricing' });
    await (gate ? gate : pause(600)); // A search takes a moment; the activity line shows until text arrives.
    call.onEvent({ type: 'delta', text: '## Payment\n' });
    if (runs.length === 1) await firstSeen;
    for (const text of ['Use **Stripe** ', 'for cards.']) { call.onEvent({ type: 'delta', text }); await pause(100); }
    return { text: '## Payment\nUse **Stripe** for cards.', session: call.session?.id || 'thread-1' };
  };
  const { browser, ev, wait } = await researchPage(t, { server: { researchRunner } });
  const click = selector => ev(`document.querySelector(${J(selector)}).click();`);
  const ask = async text => { await ev(`const i = document.querySelector('#origin-research-input'); i.value = ${J(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.closest('form').requestSubmit();`); };

  await click('#origin-research-open');
  await wait(`document.querySelector('#origin-research-send') && !document.querySelector('#origin-research-send').disabled`, 'ready to send');
  await ask('Which payment provider?');
  await wait(`document.querySelector('.origin-research-message.is-user')?.textContent === 'Which payment provider?'`, 'question shown');
  // The first piece is on screen while the CLI still works; Send has become Stop.
  await wait(`document.querySelector('.is-live .origin-research-text')?.textContent === '## Payment\\n' && document.querySelector('#origin-research-send').getAttribute('aria-label') === 'Stop'`, 'first text while working', 30000);
  assert.match(await ev(`return document.querySelector('.is-live').textContent;`), /## Payment/);
  seenFirst();
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

test('Research sources: attach an excerpt, turn it off and on, remove it; answers list their citations', { skip: !chrome, timeout: 180000 }, async t => {
  const prompts = [];
  const researchRunner = async call => { prompts.push(call.prompt); call.onEvent({ type: 'delta', text: 'x' }); return { text: 'Keep fees under 2% [S1]. See [Stripe pricing](https://stripe.com/pricing).', session: call.session?.id || 'thread-1' }; };
  const { ev, wait } = await researchPage(t, { server: { researchRunner } });
  const click = selector => ev(`document.querySelector(${J(selector)}).click();`);
  await click('#origin-research-open');
  await wait(`document.querySelector('#origin-research-add-source')`, 'sources button');
  await click('#origin-research-add-source');
  await wait(`document.querySelector('#origin-research-source-excerpt')`, 'source form');
  await click('#origin-research-source-excerpt');
  await wait(`document.querySelector('#origin-research-excerpt')`, 'excerpt form');
  await ev(`document.querySelector('#origin-research-excerpt-name').value = 'Finance policy'; document.querySelector('#origin-research-excerpt').value = 'Card fees must stay under 2% of the order value.';`);
  await click('#origin-research-source-submit');
  await wait(`document.querySelector('.origin-research-chip-toggle')?.textContent.includes('Finance policy') && document.querySelector('#origin-research-input')`, 'chip shown, back to the chat');
  // The chip turns the source off and on.
  await click('.origin-research-chip-toggle');
  await wait(`document.querySelector('.origin-research-chip.is-off .origin-research-chip-toggle')?.getAttribute('aria-pressed') === 'false'`, 'turned off');
  await click('.origin-research-chip-toggle');
  await wait(`document.querySelector('.origin-research-chip:not(.is-off)')`, 'turned on');
  await ev(`const i = document.querySelector('#origin-research-input'); i.value = 'What card fees are acceptable?'; i.dispatchEvent(new Event('input', { bubbles: true })); i.closest('form').requestSubmit();`);
  await wait(`document.querySelector('.origin-research-citations')`, 'citations shown');
  assert.ok(prompts[0].includes('<<<S1 Finance policy (selected excerpt)'));
  assert.deepEqual(await ev(`return [...document.querySelectorAll('.origin-research-citations li')].map(li => li.textContent.replace(/accessed \\d{4}-\\d{2}-\\d{2}/, 'accessed DATE'));`), ['[S1] Finance policy · selected excerpt', 'Stripe pricing · accessed DATE']);
  assert.equal(await ev(`return document.querySelector('.origin-research-citations a').getAttribute('rel');`), 'noopener noreferrer');
  await click('.origin-research-chip-remove');
  await wait(`!document.querySelector('.origin-research-chip') && document.activeElement?.id === 'origin-research-add-source'`, 'removed');
  // Claude Code offers its installed skills as an explicit option; Codex does not show it.
  await click('#origin-research-cli');
  await wait(`document.querySelector('#origin-research-provider')`, 'settings');
  await ev(`const p = document.querySelector('#origin-research-provider'); p.value = 'claude'; p.dispatchEvent(new Event('change', { bubbles: true }));`);
  await wait(`document.querySelector('#origin-research-skills') && !document.querySelector('#origin-research-skills').checked`, 'skills option, off');
  await ev(`const p = document.querySelector('#origin-research-provider'); p.value = 'codex'; p.dispatchEvent(new Event('change', { bubbles: true }));`);
  await wait(`!document.querySelector('#origin-research-skills')`, 'no skills option for Codex');
});

test('Swarm in the panel: pick parts, watch one live agent per part, stop one, read the summary', { skip: !chrome, timeout: 180000 }, async t => {
  // Agents other than Security finish only after the page has shown all three live (a handshake, not a timer).
  let release; const shown = new Promise(resolve => { release = resolve; });
  const researchRunner = async call => {
    const part = call.prompt.match(/## Focus: this (?:section|record)\n\[(?:section|components) (\w+)\]/)?.[1] || 'project';
    call.onEvent({ type: 'delta', text: `Researching ${part}` });
    await new Promise((resolve, reject) => {
      if (part !== 'security') shown.then(resolve);
      call.signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { code: 'ABORTED', partial: `Researching ${part}` })), { once: true });
    });
    return { text: `Findings for ${part}` };
  };
  const { ev, wait } = await researchPage(t, { server: { researchRunner } });
  const click = selector => ev(`document.querySelector(${J(selector)}).click();`);
  const pick = async label => ev(`const s = document.querySelector('#origin-research-scope'); s.value = [...s.options].find(o => o.textContent === ${J(label)}).value; s.dispatchEvent(new Event('change', { bubbles: true }));`);
  await click('#origin-research-open');
  await wait(`document.querySelector('#origin-research-mode-swarm')`, 'panel');
  await click('#origin-research-mode-swarm');
  await wait(`document.querySelector('#origin-research-scope').getAttribute('aria-label') === 'Add a part to research'`, 'swarm picker');
  for (const label of ['Operate › Security', 'Operate › Testing', 'Checkout API']) await pick(label);
  await wait(`document.querySelectorAll('.origin-research-targets .origin-research-chip').length === 3`, 'three parts');
  await ev(`document.querySelector('#origin-research-input').closest('form').requestSubmit();`);
  await wait(`document.querySelectorAll('.is-live').length === 3`, 'one live bubble per agent');
  // Stop Security while the others still run: a per-agent Stop shows only while more than one agent is running.
  await wait(`[...document.querySelectorAll('.is-live')].find(n => n.textContent.includes('Researching security'))?.querySelector('.origin-research-agent-stop')`, 'security stop offered');
  await ev(`[...document.querySelectorAll('.is-live')].find(n => n.textContent.includes('Researching security')).querySelector('.origin-research-agent-stop').click();`);
  release();
  await wait(`document.querySelector('.origin-research-message.is-summary') && !document.querySelector('.is-live')`, 'summary after all agents');
  const summary = await ev(`return document.querySelector('.origin-research-message.is-summary').textContent;`);
  assert.match(summary, /2 of 3 agents finished/);
  assert.match(summary, /Security: stopped/);
  assert.deepEqual(await ev(`return [...document.querySelectorAll('.origin-research-message.is-agent .origin-research-agent')].map(n => n.textContent).sort();`),
    ['Agent · Security', 'Agent · Testing', 'Agent · Checkout API'].sort());
});
