import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launch, findChrome } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';
import { questTask, questText, questPlan, pdfFixture } from './helpers/compose-fixtures.mjs';

const skip = !(await findChrome());
test('Compose browser: all option combinations, skip, cancel, failure, languages, editing, history and split', { skip, timeout: 120000 }, async t => {
  const calls = [], retrieved = [], requests = []; let failSource = false, pendingAbort = false;
  const app = await startTestServer(t, { port: 0, detector: async () => [{ id: 'codex', available: true }], authAdapter: { installed: async () => true, status: async () => ({ state: 'signed-in' }) },
    runner: async call => {
      calls.push(call);
      if (call.prompt.startsWith('# Task split')) return { text: JSON.stringify({ tasks: [{ title: 'Implement ingestion', prompt: questTask }, { title: 'Verify ingestion', prompt: 'Verify the ingestion service.' }] }) };
      if (call.prompt.startsWith('# Compose context preparation')) {
        if (call.prompt.includes('CANCEL_FIXTURE')) { pendingAbort = true; await new Promise((resolve, reject) => call.signal.addEventListener('abort', () => { pendingAbort = false; reject(call.signal.reason); }, { once: true })); }
        const language = call.prompt.includes('Write questions in German') ? 'de' : call.prompt.includes('Write questions in Polish') ? 'pl' : 'en';
        const plan = structuredClone(questPlan); if (language !== 'en') plan.questions[0].question = language === 'de' ? 'Welche Ereignisrate ist erforderlich?' : 'Jaka szybkość zapisu jest wymagana?';
        return { text: JSON.stringify(plan) };
      }
      return { text: questTask + ' Keep event_time. Keep 150000 events/sec. Review unresolved decisions.' };
    }, composeMcp: { retrieve: async (source, plan) => { retrieved.push({ source, plan }); if (failSource) throw new Error('MCP server is unavailable. Retry or continue.'); return plan.map(query => ({ source: 'Context7 / QuestDB', sourceType: 'mcp', locator: '/questdb/questdb', text: questText, questionId: query.questionId, query: query.query })); } } });
  const browser = await launch(); if (!browser) { t.skip('Chrome did not start.'); return; } t.after(() => browser.close());
  browser.on(message => { if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request); }); await browser.send('Network.enable');
  await browser.goto(app.url);
  await browser.until(`!document.querySelector('#generate-button').disabled`, 'ready');
  const click = id => browser.eval(`document.querySelector('#${id}').click();`);
  const value = (id, text) => browser.eval(`const node = document.querySelector('#${id}'); node.value = ${JSON.stringify(text)}; node.dispatchEvent(new Event('input', { bubbles: true }));`);
  const toggle = (id, checked) => browser.eval(`const node = document.querySelector('#${id}'); node.checked = ${checked}; node.dispatchEvent(new Event('change', { bubbles: true }));`);
  const generate = async () => { await click('generate-button'); await browser.until(`!document.querySelector('#cancel-button').hidden || !document.querySelector('#prompt-output').hidden`, 'started'); await browser.until(`document.querySelector('#cancel-button').hidden`, 'finished'); };
  const prepare = async () => { await click('generate-button'); await browser.until(`!document.querySelector('#context-prepared').hidden && document.querySelector('#cancel-button').hidden`, 'prepared'); };
  await value('prompt-input', questTask); await browser.eval(`document.querySelector('[name="quality"][value="fast"]').click();`);
  assert.equal(await browser.eval(`return document.querySelector('#generate-label').textContent;`), 'Generate prompt');
  await generate();
  assert.equal(calls.length, 1); assert.equal(retrieved.length, 0);
  assert.equal(requests.filter(row => row.url.includes('/api/compose/')).length, 0);
  assert.equal(JSON.parse(requests.find(row => row.url.endsWith('/api/generate')).postData).grounding, undefined);
  // Existing output editing, export and history remain available with features off.
  await click('prompt-edit'); await value('prompt-edit-text', 'Edited exact prompt.');
  await browser.eval(`document.querySelector('#prompt-edit-save').click();`);
  assert.equal(await browser.eval(`return document.querySelector('#prompt-output').textContent;`), 'Edited exact prompt.');
  await click('new-prompt'); await browser.eval(`document.querySelector('.history-restore').click();`);
  assert.equal(await browser.eval(`return document.querySelector('#prompt-output').textContent;`), 'Edited exact prompt.');
  await click('split-button'); await browser.until(`document.querySelectorAll('#split-list .split-item').length === 2`, 'manual split'); await click('split-close');
  await browser.eval(`document.querySelector('#compose-context').open = true;`);
  await toggle('context-clarify', true); await prepare();
  assert.equal(await browser.eval(`return document.querySelectorAll('#context-questions textarea').length;`), 3);
  await click('context-skip'); await browser.until(`document.querySelector('#cancel-button').hidden`, 'skip generated');
  let last = requests.filter(row => row.url.endsWith('/api/generate')).at(-1); assert.equal(JSON.parse(last.postData).grounding.userAnswers.length, 0); assert.equal(JSON.parse(last.postData).grounding.unresolvedQuestions.length, 3);
  // Source-only and mixed flows: Context7, document, both, and expert context.
  await toggle('context-use-sources', true); await click('context-add-mcp');
  await toggle('context-clarify', false); await prepare();
  assert.ok(retrieved.length); assert.equal(await browser.eval(`return document.querySelectorAll('#context-questions textarea').length;`), 0); await generate();
  const pdf = pdfFixture(Array.from({ length: 60 }, (_, i) => i >= 39 && i <= 54 ? questText : 'EXCLUDED CSS typography only.')).toString('base64');
  await click('context-add-document'); await value('context-page-from', '40'); await value('context-page-to', '55');
  await browser.eval(`const bytes = Uint8Array.from(atob(${JSON.stringify(pdf)}), c => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bytes], 'architecture.pdf', { type: 'application/pdf' })); document.querySelector('#context-file').files = dt.files;`);
  await click('context-upload'); await browser.until(`document.querySelector('#context-source-list').textContent.includes('pp. 40–55') && document.querySelector('#cancel-button').hidden`, 'PDF uploaded');
  const firstSource = enabled => browser.eval(`const node = document.querySelector('#context-source-list input'); node.checked = ${enabled}; node.dispatchEvent(new Event('change'));`);
  await firstSource(false); await prepare(); await generate(); // PDF only.
  await toggle('context-clarify', true); await prepare(); // Questions + PDF.
  assert.match(await browser.eval(`return document.querySelector('#context-evidence-list').textContent;`), /page 4/);
  assert.doesNotMatch(await browser.eval(`return document.querySelector('#context-evidence-list').textContent;`), /EXCLUDED/);
  await firstSource(true); await prepare(); // Questions + PDF + Context7.
  await click('context-add-expert'); await browser.eval(`const node = document.querySelector('#context-source-list textarea'); node.value = ${JSON.stringify(questText)}; node.dispatchEvent(new Event('input'));`); await prepare();
  await value('context-answer-q1', '150000 events/sec'); await value('context-answer-q3', 'Use event_time.');
  const planningCalls = calls.filter(call => call.prompt.startsWith('# Compose context')).length;
  await toggle('context-auto-split', true); // Splitting does not invalidate prepared answers.
  assert.equal(calls.filter(call => call.prompt.startsWith('# Compose context')).length, planningCalls);
  const boardRequestsBefore = requests.filter(row => row.url.endsWith('/api/board')).length;
  await generate(); await browser.until(`document.querySelector('#split-dialog').open && document.querySelectorAll('#split-list .split-item').length === 2`, 'auto split');
  const final = requests.filter(row => row.url.endsWith('/api/generate')).at(-1);
  const payload = JSON.parse(final.postData); assert.equal(payload.grounding.userAnswers.length, 2); assert.ok(payload.grounding.evidence.length); assert.deepEqual(payload.grounding.unresolvedQuestions, []);
  const splitCall = requests.filter(row => row.url.endsWith('/api/split')).at(-1);
  assert.equal(JSON.parse(splitCall.postData).prompt, await browser.eval(`return document.querySelector('#prompt-output').textContent;`));
  assert.equal(requests.filter(row => row.url.endsWith('/api/board')).length, boardRequestsBefore);
  assert.equal(await browser.eval(`return document.querySelector('#split-target').hidden && document.querySelector('#split-add').hidden;`), true);
  await click('split-close'); await toggle('context-auto-split', false);
  const storage = await browser.eval(`return Object.values(localStorage).join(' ');`); assert.doesNotMatch(storage, /"evidence"|"sourceQueries"|"headers"|EXCLUDED/);
  // Failure and retry retain the original task and allow generation.
  failSource = true; await prepare(); assert.match(await browser.eval(`return document.querySelector('#context-warnings').textContent;`), /unavailable/); await generate(); failSource = false;
  // Cancellation reaches the provider.
  await value('prompt-input', 'CANCEL_FIXTURE ' + questTask); await click('generate-button');
  await browser.until(`!document.querySelector('#cancel-button').hidden`, 'planning started');
  for (let i = 0; !pendingAbort && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(pendingAbort, true);
  await click('cancel-button'); await browser.until(`document.querySelector('#cancel-button').hidden`, 'planning cancelled');
  for (let i = 0; pendingAbort && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(pendingAbort, false);
  await value('prompt-input', questTask);
  for (const language of ['en', 'de', 'pl']) {
    await browser.eval(`document.querySelector('[name="language"][value="${language}"]').click();`); await prepare();
    if (language !== 'en') assert.match(await browser.eval(`return document.querySelector('#context-questions').textContent;`), language === 'de' ? /Ereignisrate/ : /szybkość/);
  }
  // Both themes and narrow layout preserve controls and keyboard access.
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    await browser.resize(width, 900); await browser.eval(`document.documentElement.dataset.theme = '${theme}'; document.querySelector('#context-prepared').scrollIntoView({ block: 'center' });`);
    assert.equal(await browser.layout(`return document.documentElement.scrollWidth <= innerWidth;`), true);
    await browser.eval(`document.querySelector('#context-answer-q1').focus();`);
    await browser.key('Tab', 'Tab', 9);
    assert.equal(await browser.eval(`return document.activeElement.id;`), 'context-answer-q3');
    if (process.env.PB_BROWSER_SHOTS) await writeFile(join(process.env.PB_BROWSER_SHOTS, `compose-${width}-${theme}.png`), await browser.screenshot());
  }
  assert.deepEqual(browser.consoleMessages.filter(message => message.startsWith('EXCEPTION')), []);
});
