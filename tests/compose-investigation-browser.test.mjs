import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, findChrome } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';
import { researchPlan, researchReview } from './helpers/compose-fixtures.mjs';

test('Compose real UI grounds simple writing, preserves roles/settings, keeps disabled sources inert and reuses exact output tools', { skip: !(await findChrome()), timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pb-compose-role-ui-')); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await writeFile(join(root, 'README.md'), 'This unrelated reference uses React.');
  const input = 'Przeredaguj ogłoszenie zgodnie z wybranym poradnikiem.', style = 'Use direct voice and short sentences. Avoid inflated language.';
  const result = 'Przeredaguj ogłoszenie. Użyj krótkich zdań. Zachowaj podane znaczenie.';
  const calls = [], requests = [];
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [{ id: 'codex', available: true }], folderPicker: async () => ({ path: root }),
    authAdapter: { installed: async () => true, status: async () => ({ state: 'signed-in' }) }, runner: async call => {
      calls.push(call);
      if (call.prompt.startsWith('# Compose context preparation')) {
        const data = JSON.parse(call.prompt.split('# Preparation data\n')[1]); assert.equal(data.request, input);
        const guide = data.sources.find(s => s.type === 'expert');
        return { text: JSON.stringify({ ...researchPlan(input, { complexity: 'simple', research: 'none', entities: ['ogłoszenie'] }), questions: guide ? [{ id: 'r7', kind: 'fact', question: 'What supplied style guidance applies?', reason: 'Preserve the selected writing style.', sourceHint: guide.id, libraryHint: '', query: 'direct voice short sentences' }] : [], unverified: [] }) };
      }
      if (call.prompt.startsWith('# Compose research review')) return { text: JSON.stringify(researchReview(call.prompt)) };
      if (call.prompt.startsWith('# Task split')) { assert.ok(call.prompt.includes(result)); return { text: JSON.stringify({ tasks: [{ title: 'Rewrite announcement', prompt: result }] }) }; }
      return { text: result };
    }, composeMcp: { retrieve: () => assert.fail('None-level writing and disabled grounding cannot contact MCP') } });
  const browser = await launch(); assert.ok(browser); t.after(() => browser.close());
  browser.on(event => { if (event.method === 'Network.requestWillBeSent') requests.push(event.params.request); }); await browser.send('Network.enable');
  await browser.goto(app.url); await browser.until('!document.querySelector("#generate-button").disabled', 'Compose ready');
  const click = id => browser.eval(`document.getElementById(${JSON.stringify(id)}).click();`);
  const toggle = (id, checked) => browser.eval(`const el=document.getElementById(${JSON.stringify(id)});el.checked=${checked};el.dispatchEvent(new Event('change',{bubbles:true}));`);
  const value = (id, text) => browser.eval(`const el=document.getElementById(${JSON.stringify(id)});el.value=${JSON.stringify(text)};el.dispatchEvent(new Event('input',{bubbles:true}));`);
  const done = () => browser.until('document.querySelector("#cancel-button").hidden && !document.querySelector("#prompt-output").hidden', 'finished');
  await browser.eval('document.querySelector("#compose-context").open=true;document.querySelector("input[name=quality][value=fast]").checked=true;document.querySelector("input[name=language][value=pl]").checked=true;');
  await value('prompt-input', input); await toggle('context-autonomous', true); await toggle('context-use-sources', true);
  await click('context-add-expert'); await browser.eval(`const el=document.querySelector('#context-source-list textarea');el.value=${JSON.stringify(style)};el.dispatchEvent(new Event('input',{bubbles:true}));`);
  await click('context-add-mcp'); await click('context-add-local'); await click('context-pick-local'); await browser.until('document.querySelector("#context-local-path").value.length>0', 'chosen folder');
  assert.equal(await browser.eval('return document.querySelector("#context-local-purpose").value;'), 'reference');
  await click('context-save-local'); await click('generate-button'); await done();
  let prepare = requests.filter(r => r.url.endsWith('/api/compose/prepare')).at(-1), final = requests.filter(r => r.url.endsWith('/api/generate')).at(-1);
  const grounded = JSON.parse(final.postData); assert.equal(grounded.input, input); assert.equal(grounded.language, 'pl'); assert.ok(grounded.grounding.evidence.some(e => e.sourceType === 'expert' && e.text.includes('direct voice')));
  assert.deepEqual(grounded.grounding.userAnswers, []); assert.equal(prepare.headers['X-STE-Compose-Id'], final.headers['X-STE-Compose-Id']);
  assert.equal(JSON.parse(prepare.postData).sources.find(s => s.type === 'local').purpose, 'reference');
  assert.equal(await browser.eval('return document.querySelectorAll("#context-prepared textarea").length;'), 0);
  // Same source role editor, no new wizard/dashboard.
  await browser.eval('const el=document.querySelector("#context-source-list select");el.value="target";el.dispatchEvent(new Event("change",{bubbles:true}));');
  await click('generate-button'); await done(); assert.equal(JSON.parse(requests.filter(r => r.url.endsWith('/api/compose/prepare')).at(-1).postData).sources.find(s => s.type === 'local').purpose, 'target');
  // Turn only the master off, leaving source choices intact.
  await toggle('context-autonomous', false); const prepCount = requests.filter(r => r.url.endsWith('/api/compose/prepare')).length, callCount = calls.length;
  assert.equal(await browser.eval('return document.querySelector("#context-use-sources").checked && document.querySelector("#context-use-sources").disabled && document.querySelector("#context-sources").hidden;'), true);
  await click('generate-button'); await done(); assert.equal(calls.length, callCount + 1); assert.equal(requests.filter(r => r.url.endsWith('/api/compose/prepare')).length, prepCount);
  assert.equal(JSON.parse(requests.filter(r => r.url.endsWith('/api/generate')).at(-1).postData).grounding, undefined);
  // The existing editor, exact copy/export, history and splitter operate on the result.
  await browser.eval('window.__copied="";Object.defineProperty(navigator,"clipboard",{value:{writeText:async text=>{window.__copied=text}},configurable:true});window.__exports=[];URL.createObjectURL=blob=>{window.__exports.push(blob);return "blob:fixture"};URL.revokeObjectURL=()=>{};HTMLAnchorElement.prototype.click=function(){};');
  await click('prompt-edit'); await value('prompt-edit-text', result); await click('prompt-edit-save'); await click('copy-button'); assert.equal(await browser.eval('return window.__copied;'), result);
  await click('export-button'); assert.match(await browser.eval('return await window.__exports.at(-1).text();'), /Zachowaj podane znaczenie/);
  const history = await browser.eval('return JSON.parse(localStorage.getItem("ste-prompt-engineer.history.v1"));'); assert.ok(history.every(row => !row.grounding && !row.sources));
  assert.doesNotMatch(JSON.stringify(history), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await click('split-button'); await browser.until('document.querySelector("#split-dialog").open && document.querySelectorAll(".split-item").length===1', 'manual split'); await click('split-close');
  await toggle('context-auto-split', true); await click('generate-button'); await done(); await browser.until('document.querySelector("#split-dialog").open', 'auto-split preview');
  assert.equal(JSON.parse(requests.filter(r => r.url.endsWith('/api/split')).at(-1).postData).prompt, result); await click('split-close');
  assert.equal(requests.some(r => /\/api\/tasks$/.test(r.url)), false);
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    await browser.resize(width, 900); await browser.eval(`document.documentElement.dataset.theme=${JSON.stringify(theme)};`); await toggle('context-autonomous', true);
    assert.equal(await browser.layout('return document.documentElement.scrollWidth<=innerWidth;'), true);
    await browser.eval('document.querySelector("#context-autonomous").focus();'); await browser.key('Tab','Tab',9); assert.equal(await browser.eval('return document.activeElement.id;'), 'context-use-sources');
    if (process.env.PB_COMPOSE_GROUNDING_SHOTS) { await mkdir('test-results/compose-investigation', { recursive: true }); await writeFile(`test-results/compose-investigation/${theme}-${width}.png`, await browser.screenshot()); }
  }
  assert.deepEqual(browser.consoleMessages.filter(m => m.startsWith('EXCEPTION')), []);
});
