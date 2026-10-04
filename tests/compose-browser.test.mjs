import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launch, findChrome } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';
import { questTask, questText, researchPlan, researchReview, pdfFixture } from './helpers/compose-fixtures.mjs';

const skip = !(await findChrome());
test('Compose autonomous browser: one click, no user questions, restraint, mixed sources, cancel, languages, history and split', { skip, timeout: 120000 }, async t => {
  const calls = [], retrieved = [], requests = []; let failSource = false, pendingAbort = false;
  const app = await startTestServer(t, { port: 0, detector: async () => [{ id: 'codex', available: true }], authAdapter: { installed: async () => true, status: async () => ({ state: 'signed-in' }) },
    runner: async call => {
      calls.push(call);
      if (call.prompt.startsWith('# Task split')) return { text: JSON.stringify({ tasks: [{ title: 'Implement ingestion', prompt: questTask }, { title: 'Verify ingestion', prompt: 'Verify the ingestion service.' }] }) };
      if (call.prompt.startsWith('# Compose research review')) return { text: JSON.stringify(researchReview(call.prompt)) };
      if (call.prompt.startsWith('# Compose context preparation')) {
        if (call.prompt.includes('CANCEL_FIXTURE')) { pendingAbort = true; await new Promise((resolve, reject) => call.signal.addEventListener('abort', () => { pendingAbort = false; reject(call.signal.reason); }, { once: true })); }
        const data = JSON.parse(call.prompt.split('# Preparation data\n')[1]);
        if (data.request.includes('website about dogs')) { const plan = researchPlan(data.request, { complexity: 'simple', research: 'none', entities: ['dogs'], reason: 'No external research is necessary.' }); plan.questions = []; return { text: JSON.stringify(plan) }; }
        const plan = researchPlan(data.request); plan.assessment.reason = data.language === 'de' ? 'Relevante Dokumentation prüfen.' : data.language === 'pl' ? 'Sprawdź odpowiednią dokumentację.' : plan.assessment.reason;
        return { text: JSON.stringify(plan) };
      }
      return { text: questTask + ' Detect the actual timestamp field and ingestion rate. Preserve unresolved implementation constraints.' };
    }, composeMcp: { retrieve: async (source, plan) => { retrieved.push({ source, plan }); if (failSource) throw new Error('MCP server is unavailable. Retry or continue.'); return plan.map(query => ({ source: 'Context7 / QuestDB', sourceType: 'mcp', locator: '/questdb/questdb', text: questText, questionId: query.questionId, query: query.query })); } } });
  const browser = await launch(); if (!browser) { t.skip('Chrome did not start.'); return; } t.after(() => browser.close());
  browser.on(message => { if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request); }); await browser.send('Network.enable');
  await browser.goto(app.url); await browser.until(`!document.querySelector('#generate-button').disabled`, 'ready');
  const click = id => browser.eval(`document.querySelector('#${id}').click();`);
  const value = (id, text) => browser.eval(`const node = document.querySelector('#${id}'); node.value = ${JSON.stringify(text)}; node.dispatchEvent(new Event('input', { bubbles: true }));`);
  const toggle = (id, checked) => browser.eval(`const node = document.querySelector('#${id}'); node.checked = ${checked}; node.dispatchEvent(new Event('change', { bubbles: true }));`);
  const generate = async () => { await click('generate-button'); await browser.until(`document.querySelector('#cancel-button').hidden && !document.querySelector('#prompt-output').hidden`, 'generated'); };
  assert.equal(await browser.eval(`return !!document.querySelector('#context-clarify') || !!document.querySelector('#context-skip');`), false);
  assert.equal(await browser.eval(`return document.querySelector('#context-autonomous').checked;`), false);
  await toggle('context-autonomous', true);
  // A topic cannot invent a task or call a model/source.
  await value('prompt-input', 'dog'); await click('generate-button');
  await browser.until(`!document.querySelector('#context-prepared').hidden && document.querySelector('#cancel-button').hidden`, 'no task');
  assert.match(await browser.eval(`return document.querySelector('#context-prepared-status').textContent;`), /No actionable task/);
  assert.equal(calls.length, 0); assert.equal(requests.filter(r => r.url.endsWith('/api/generate')).length, 0);
  // The optional OFF path still uses only the original generation call.
  await toggle('context-autonomous', false); await value('prompt-input', questTask); await browser.eval(`document.querySelector('[name="quality"][value="fast"]').click();`); await generate();
  assert.equal(calls.length, 1); assert.equal(retrieved.length, 0);
  assert.equal(JSON.parse(requests.find(row => row.url.endsWith('/api/generate')).postData).grounding, undefined);
  await click('prompt-edit'); await value('prompt-edit-text', 'Edited exact prompt.'); await click('prompt-edit-save');
  await click('new-prompt'); await browser.eval(`document.querySelector('.history-restore').click();`);
  assert.equal(await browser.eval(`return document.querySelector('#prompt-output').textContent;`), 'Edited exact prompt.');
  await click('split-button'); await browser.until(`document.querySelectorAll('#split-list .split-item').length === 2`, 'manual split'); await click('split-close');
  await browser.eval(`document.querySelector('#compose-context').open = true;`);
  await toggle('context-autonomous', true); await generate(); // Autonomous without any external source.
  assert.equal(await browser.eval(`return document.querySelectorAll('#context-prepared textarea').length;`), 0);
  let last = JSON.parse(requests.filter(r => r.url.endsWith('/api/generate')).at(-1).postData); assert.deepEqual(last.grounding.userAnswers, []); assert.ok(last.grounding.unresolvedQuestions.length);
  await toggle('context-use-sources', true); await click('context-add-mcp');
  const before = retrieved.length; await value('prompt-input', 'Create a website about dogs.'); await generate(); assert.equal(retrieved.length, before); // Sources available but not needed.
  await value('prompt-input', questTask); await generate(); assert.ok(retrieved.length > before); // Context7 only.
  const pdf = pdfFixture(Array.from({ length: 60 }, (_, i) => i >= 39 && i <= 54 ? questText : 'EXCLUDED CSS typography only.')).toString('base64');
  await click('context-add-document'); await value('context-page-from', '40'); await value('context-page-to', '55');
  await browser.eval(`const bytes = Uint8Array.from(atob(${JSON.stringify(pdf)}), c => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bytes], 'architecture.pdf', { type: 'application/pdf' })); document.querySelector('#context-file').files = dt.files;`);
  await click('context-upload');
  // Extraction has a 30-second production deadline. Wait for the operation's
  // terminal state rather than imposing the driver's generic 10-second UI bound.
  await browser.until(`document.querySelector('#cancel-button').hidden && (document.querySelector('#context-source-list').textContent.includes('pp. 40–55') || !document.querySelector('#context-error').hidden)`, 'PDF upload completed', 40000);
  assert.equal(await browser.eval(`return document.querySelector('#context-error').hidden ? '' : document.querySelector('#context-error').textContent;`), '', 'The real PDF upload must succeed.');
  assert.equal(await browser.eval(`return document.querySelector('#context-source-list').textContent.includes('pp. 40–55');`), true);
  const firstSource = enabled => browser.eval(`const node = document.querySelector('#context-source-list input'); node.checked = ${enabled}; node.dispatchEvent(new Event('change'));`);
  await firstSource(false); await generate(); // PDF only.
  assert.match(await browser.eval(`return document.querySelector('#context-evidence-list').textContent;`), /page 4/);
  assert.doesNotMatch(await browser.eval(`return document.querySelector('#context-evidence-list').textContent;`), /EXCLUDED/);
  await firstSource(true); await click('context-add-expert'); await browser.eval(`const node = document.querySelector('#context-source-list textarea'); node.value = ${JSON.stringify(questText)}; node.dispatchEvent(new Event('input'));`); await generate();
  last = JSON.parse(requests.filter(r => r.url.endsWith('/api/generate')).at(-1).postData); assert.ok(last.grounding.evidence.length); assert.deepEqual(last.grounding.userAnswers, []);
  const planners = calls.filter(c => c.prompt.startsWith('# Compose context')).length;
  await toggle('context-auto-split', true); const boardBefore = requests.filter(r => r.url.endsWith('/api/board')).length; await generate();
  await browser.until(`document.querySelector('#split-dialog').open && document.querySelectorAll('#split-list .split-item').length === 2`, 'auto split');
  assert.equal(calls.filter(c => c.prompt.startsWith('# Compose context')).length, planners);
  assert.equal(JSON.parse(requests.filter(r => r.url.endsWith('/api/split')).at(-1).postData).prompt, await browser.eval(`return document.querySelector('#prompt-output').textContent;`));
  assert.equal(requests.filter(r => r.url.endsWith('/api/board')).length, boardBefore);
  assert.equal(await browser.eval(`return document.querySelector('#split-target').hidden && document.querySelector('#split-add').hidden;`), true);
  await click('split-close'); await toggle('context-auto-split', false);
  // Failure cannot erase the task and still proceeds with unknowns explicitly retained.
  failSource = true; await click('context-retry'); await browser.until(`document.querySelector('#cancel-button').hidden`, 'source failure generated');
  assert.match(await browser.eval(`return document.querySelector('#context-warnings').textContent;`), /unavailable/); failSource = false;
  // Cancellation stops at research: no final generation can follow it.
  const generatedBefore = requests.filter(r => r.url.endsWith('/api/generate')).length;
  await value('prompt-input', 'CANCEL_FIXTURE ' + questTask); await click('generate-button'); await browser.until(`!document.querySelector('#cancel-button').hidden`, 'research started');
  for (let i = 0; !pendingAbort && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(pendingAbort, true);
  await click('cancel-button'); await browser.until(`document.querySelector('#cancel-button').hidden`, 'research cancelled');
  for (let i = 0; pendingAbort && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(pendingAbort, false);
  assert.equal(requests.filter(r => r.url.endsWith('/api/generate')).length, generatedBefore);
  await value('prompt-input', questTask);
  for (const language of ['en', 'de', 'pl']) {
    await browser.eval(`document.querySelector('[name="language"][value="${language}"]').click();`); await generate();
    assert.equal(await browser.eval(`return document.querySelectorAll('#context-prepared textarea').length;`), 0);
  }
  await click('context-add-local'); await value('context-local-path', '/example/project'); await click('context-save-local');
  assert.match(await browser.eval(`return document.querySelector('#context-source-list').textContent;`), /Project · project/);
  assert.doesNotMatch(await browser.eval(`return Object.values(localStorage).join(' ');`), /"evidence"|"sourceQueries"|\/example\/project|"headers"|EXCLUDED/);
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    await browser.resize(width, 900); await browser.eval(`document.documentElement.dataset.theme = '${theme}'; document.querySelector('#compose-context').scrollIntoView({ block: 'center' });`);
    assert.equal(await browser.layout(`return document.documentElement.scrollWidth <= innerWidth;`), true);
    await browser.eval(`document.querySelector('#context-autonomous').focus();`); await browser.key('Tab', 'Tab', 9);
    assert.equal(await browser.eval(`return document.activeElement.id;`), 'context-use-sources');
    if (process.env.PB_BROWSER_SHOTS) await writeFile(join(process.env.PB_BROWSER_SHOTS, `compose-${width}-${theme}.png`), await browser.screenshot());
  }
  assert.deepEqual(browser.consoleMessages.filter(message => message.startsWith('EXCEPTION')), []);
});
