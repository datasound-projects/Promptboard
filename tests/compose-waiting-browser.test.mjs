import test from 'node:test';
import assert from 'node:assert/strict';
import { launch, findChrome } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';
import { REVIEW_CRITERIA } from '../src/pipeline.mjs';
import { researchPlan } from './helpers/compose-fixtures.mjs';

test('Compose waits beyond old browser deadlines in generation, research and split; Cancel still works', { skip: !(await findChrome()), timeout: 90000 }, async t => {
  const calls = []; let hold = 'draft', pending;
  const input = 'Write a Python script that lists files in a directory.\n' + 'Keep the output sorted.\n'.repeat(480);
  const draft = input + '\n' + 'Keep error handling explicit.\n'.repeat(2200);
  const app = await startTestServer(t, { port: 0, detector: async () => [{ id: 'codex', available: true }],
    authAdapter: { installed: async () => true, status: async () => ({ state: 'signed-in' }) },
    catalogReader: async provider => ({ provider, models: [{ id: 'slow-model', name: 'Slow model', efforts: ['xhigh'] }] }),
    runner: async call => {
      const stage = call.prompt.startsWith('# Compose context preparation') ? 'research' : call.prompt.startsWith('# Review task') ? 'review' : call.prompt.startsWith('# Task split') ? 'split' : 'draft';
      calls.push({ call, stage }); assert.equal(call.timeoutMs, null);
      assert.equal(call.model, 'slow-model'); assert.equal(call.effort, 'xhigh');
      if (stage === hold) await new Promise((resolve, reject) => {
        pending = { call, stage, resolve };
        call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true });
      });
      if (stage === 'research') return { text: JSON.stringify(researchPlan(input, { complexity: 'simple', research: 'none', entities: ['Python'], reason: 'No external context is needed.' })) };
      if (stage === 'review') {
        const data = JSON.parse(call.prompt.split('# Review data\n')[1]);
        return { text: JSON.stringify({ covered: data.units.map(unit => unit.id), requirements: [], criteria: Object.fromEntries(REVIEW_CRITERIA.map(key => [key, 'pass'])), issues: [] }) };
      }
      if (stage === 'split') return { text: JSON.stringify({ tasks: [{ title: 'Implement and verify', prompt: draft }] }) };
      return { text: draft };
    } });
  const browser = await launch(); if (!browser) { t.skip('Chrome did not start.'); return; } t.after(() => browser.close());
  await browser.goto(app.url); await browser.until(`!document.querySelector('#generate-button').disabled`, 'ready');
  const click = id => browser.eval(`document.querySelector('#${id}').click();`);
  const toggle = (id, checked) => browser.eval(`const node = document.querySelector('#${id}'); node.checked = ${checked}; node.dispatchEvent(new Event('change', { bubbles: true }));`);
  await browser.eval(`const input = document.querySelector('#prompt-input'); input.value = ${JSON.stringify(input)}; input.dispatchEvent(new Event('input', { bubbles: true })); const model = document.querySelector('#model'); model.value = 'slow-model'; model.dispatchEvent(new Event('change', { bubbles: true })); const effort = document.querySelector('#effort'); effort.value = 'xhigh'; effort.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('[name="detail"][value="extremely-detailed"]').click();`);
  const waitPending = async stage => {
    for (const end = Date.now() + 10000; pending?.stage !== stage;) {
      if (Date.now() > end) assert.fail(`${stage} did not start`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const advanceElevenMinutes = async () => {
    let unsubscribe, timer;
    const expired = new Promise(resolve => { unsubscribe = browser.on(event => { if (event.method === 'Emulation.virtualTimeBudgetExpired') resolve(); }); });
    try {
      await browser.send('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: 660000, maxVirtualTimeTaskStarvationCount: 1000 });
      await Promise.race([expired, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Virtual time did not advance.')), 15000); timer.unref(); })]);
    } finally { clearTimeout(timer); unsubscribe(); }
    // Budget expiry pauses Chrome's virtual clock. Permit network-driven UI
    // completion again before retrying; retain a finite virtual-time budget.
    await browser.send('Emulation.setVirtualTimePolicy', { policy: 'pauseIfNetworkFetchesPending', budget: 10000 });
  };
  await click('generate-button'); await waitPending('draft');
  await advanceElevenMinutes();
  assert.equal(pending.call.signal.aborted, false);
  assert.equal(await browser.eval(`return !document.querySelector('#cancel-button').hidden && !document.querySelector('#cancel-button').disabled;`), true);
  hold = 'review'; pending.resolve(); pending = null;
  await waitPending('review'); await advanceElevenMinutes();
  assert.equal(pending.call.signal.aborted, false);
  hold = ''; pending.resolve(); pending = null;
  await browser.until(`document.querySelector('#cancel-button').hidden && !document.querySelector('#prompt-output').hidden`, 'long result generated');
  assert.equal(await browser.eval(`return document.querySelector('#prompt-output').textContent;`), draft.trim());
  assert.ok(draft.length > 64000); assert.equal(calls.length, 2);
  assert.equal(await browser.eval(`return document.querySelector('#generation-error').hidden;`), true);
  // A long planning call remains cancellable and cannot proceed to generation after Cancel.
  await toggle('context-autonomous', true); hold = 'research';
  await click('generate-button'); await waitPending('research'); await advanceElevenMinutes();
  const planning = pending, before = calls.filter(row => row.stage === 'draft').length;
  assert.equal(planning.call.signal.aborted, false); await click('cancel-button');
  await browser.until(`document.querySelector('#cancel-button').hidden`, 'research cancelled');
  for (let i = 0; !planning.call.signal.aborted && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(planning.call.signal.aborted, true); assert.equal(calls.filter(row => row.stage === 'draft').length, before);
  assert.equal(await browser.eval(`return document.querySelector('#prompt-input').value;`), input); pending = null;
  // Auto-split operates on the exact completed prompt and does not execute anything.
  await toggle('context-autonomous', false); await toggle('context-auto-split', true); hold = 'split';
  await click('generate-button'); await waitPending('split'); await advanceElevenMinutes();
  const splitting = pending; assert.equal(splitting.call.signal.aborted, false);
  assert.equal(await browser.eval(`return document.querySelector('#split-dialog').open;`), true);
  assert.equal(await browser.eval(`return document.querySelector('#prompt-output').textContent;`), draft.trim());
  await click('split-close');
  for (let i = 0; !splitting.call.signal.aborted && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(splitting.call.signal.aborted, true); hold = ''; pending = null;
  await click('split-button');
  try { await browser.until(`document.querySelectorAll('#split-list .split-item').length === 1`, 'manual split after cancellation'); }
  catch (error) { throw new Error(`${error.message}; ${JSON.stringify(await browser.eval(`return { status: document.querySelector('#split-status').textContent, error: document.querySelector('#split-error').textContent, open: document.querySelector('#split-dialog').open };`))}; calls=${calls.map(row => row.stage).join(',')}`); }
  assert.equal(await browser.eval(`return document.querySelector('#split-error').hidden;`), true);
  await click('split-close'); hold = 'split'; pending = null;
  await click('split-button'); await waitPending('split');
  const escaped = pending;
  await browser.key('Escape', 'Escape', 27);
  await browser.until(`!document.querySelector('#split-dialog').open`, 'Escape closes the pending split');
  for (let i = 0; !escaped.call.signal.aborted && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(escaped.call.signal.aborted, true);
  assert.equal(await browser.eval(`return document.querySelector('#prompt-output').textContent;`), draft.trim());
  assert.doesNotMatch(browser.consoleMessages.join('\n'), /EXCEPTION/);
});
