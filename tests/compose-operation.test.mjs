import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { startTestServer } from './helpers/test-server.mjs';
import { researchPlan, researchReview } from './helpers/compose-fixtures.mjs';

async function until(fn) { for (const end = Date.now() + 10_000; !fn();) { assert.ok(Date.now() < end, 'UI operation did not settle'); await new Promise(r => setTimeout(r, 5)); } }
async function page(t, { prefs = {}, intercept, runner } = {}) {
  const calls = [], requests = [];
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [{ id: 'codex', available: true }], catalogReader: async () => ({ models: [] }),
    authAdapter: { installed: async () => true, status: async () => ({ state: 'signed-in' }) }, runner: async call => { calls.push(call); if (runner) return runner(call); const data = call.prompt.split('# Preparation data\n')[1]; return { text: data ? JSON.stringify({ ...researchPlan(JSON.parse(data).request, { complexity: 'simple', research: 'none' }), questions: [] }) : call.prompt.startsWith('# Compose research review') ? JSON.stringify(researchReview(call.prompt)) : 'Write a clear announcement.' }; } });
  const dom = new JSDOM(await readFile(new URL('../public/index.html', import.meta.url), 'utf8'), { url: app.url, runScripts: 'outside-only', pretendToBeVisual: true }); t.after(() => dom.window.close());
  const win = dom.window; Object.assign(win, { TextEncoder, TextDecoder, AbortController, scrollTo() {} });
  win.HTMLElement.prototype.scrollIntoView = () => {}; win.HTMLDialogElement.prototype.showModal = function () { this.open = true; }; win.HTMLDialogElement.prototype.close = function () { this.open = false; };
  win.localStorage.setItem('promptboard.compose-context', JSON.stringify(prefs));
  win.fetch = async (path, options = {}) => { const row = { path, options, body: options.body && JSON.parse(options.body) }; requests.push(row); const held = intercept?.(row); if (held) return held; return fetch(new URL(path, app.url), options); };
  win.eval(await readFile(new URL('../public/prefs.js', import.meta.url), 'utf8'));
  win.eval(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'));
  const $ = s => win.document.querySelector(s), change = (id, checked) => { $('#'+id).checked = checked; $('#'+id).dispatchEvent(new win.Event('change', { bubbles: true })); };
  await until(() => !$('#generate-button').disabled);
  $('input[name="quality"][value="fast"]').checked = true; $('#prompt-input').value = 'Write a clear announcement.';
  const submit = () => $('#prompt-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  return { $, win, change, submit, calls, requests };
}

test('master off preserves old source consent but submits only normal generation', async t => {
  const { $, win, submit, calls, requests } = await page(t, { prefs: { 'context-autonomous': false, 'context-use-sources': true, 'context-auto-split': false } });
  assert.equal($('#context-use-sources').checked, true); assert.equal($('#context-use-sources').disabled, true); assert.equal($('#context-sources').hidden, true);
  $('#context-add-expert').click(); const text = $('#context-source-list textarea'); if (text) { text.value = 'Use direct language.'; text.dispatchEvent(new win.Event('input')); }
  submit(); await until(() => !$('#prompt-output').hidden && $('#cancel-button').hidden);
  assert.equal(calls.length, 1); assert.equal(requests.some(r => r.path === '/api/compose/prepare'), false);
  assert.equal(requests.find(r => r.path === '/api/generate').body.grounding, undefined);
});

test('legacy source-only preference migrates deliberately; explicit master false is never overridden', async t => {
  const { $, win } = await page(t, { prefs: { 'context-use-sources': true, 'context-auto-split': false } });
  assert.equal($('#context-autonomous').checked, true); assert.equal($('#context-use-sources').checked, true);
  const stored = JSON.parse(win.localStorage.getItem('promptboard.compose-context')); assert.equal(stored['context-autonomous'], true); assert.equal(stored['context-use-sources'], true);
});

test('one UI operation owns preparation and generation, captures all settings, and rejects duplicate submit', async t => {
  let release; const gate = new Promise(r => { release = r; });
  const { $, submit, requests } = await page(t, { prefs: { 'context-autonomous': true }, intercept: row => row.path === '/api/compose/prepare' ? gate.then(() => Response.json({ state: 'ready', grounding: {}, evidence: [], sources: [], warnings: [] })) : null });
  submit(); submit(); await until(() => requests.some(r => r.path === '/api/compose/prepare')); release();
  await until(() => !$('#prompt-output').hidden && $('#cancel-button').hidden);
  const prep = requests.filter(r => r.path === '/api/compose/prepare'), generate = requests.filter(r => r.path === '/api/generate'); assert.equal(prep.length, 1); assert.equal(generate.length, 1);
  assert.equal(prep[0].options.headers['X-STE-Compose-Id'], generate[0].options.headers['X-STE-Compose-Id']);
  const final = { ...generate[0].body }; delete final.grounding; assert.deepEqual(final, prep[0].body.request);
});

test('source/task changes cancel an old preparation; a late failed response cannot overwrite the new operation', async t => {
  let release; const gate = new Promise(r => { release = r; }); let held = true;
  const { $, win, submit, requests } = await page(t, { prefs: { 'context-autonomous': true }, intercept: row => row.path === '/api/compose/prepare' && held ? gate : null });
  submit(); await until(() => requests.some(r => r.path === '/api/compose/prepare'));
  $('#prompt-input').value = 'Write a different clear announcement.'; $('#prompt-input').dispatchEvent(new win.Event('input', { bubbles: true }));
  held = false; release(Response.json({ error: 'OLD_SOURCE_FAILURE', code: 'CLI_FAILED' }, { status: 502 }));
  await until(() => $('#cancel-button').hidden); submit(); await until(() => !$('#prompt-output').hidden && $('#cancel-button').hidden);
  assert.doesNotMatch($('#context-prepared').textContent, /OLD_SOURCE_FAILURE/);
  const generated = requests.filter(r => r.path === '/api/generate'); assert.equal(generated.length, 1); assert.equal(generated[0].body.input, 'Write a different clear announcement.');
});

test('Cancel then retry keeps late generation errors and cancellation IDs owned by the original operation', async t => {
  let release; const gate = new Promise(r => { release = r; }); let held = true;
  const { $, win, submit, requests } = await page(t, { prefs: { 'context-autonomous': true }, intercept: row => row.path === '/api/generate' && held ? gate : null });
  submit(); await until(() => requests.some(r => r.path === '/api/generate'));
  const originalId = requests.find(r => r.path === '/api/generate').options.headers['X-STE-Compose-Id'];
  $('#cancel-button').click();
  $('#prompt-input').value = 'Write a new announcement after cancellation.'; $('#prompt-input').dispatchEvent(new win.Event('input', { bubbles: true }));
  held = false; release(Response.json({ error: 'OLD_GENERATION_FAILURE', code: 'CLI_FAILED' }, { status: 502 }));
  await until(() => $('#cancel-button').hidden); assert.equal($('#generation-error').hidden, true);
  assert.equal(requests.find(r => r.path === '/api/compose/cancel').body.id, originalId);
  submit(); await until(() => !$('#prompt-output').hidden && $('#cancel-button').hidden);
  const final = requests.filter(r => r.path === '/api/generate').at(-1);
  assert.notEqual(final.options.headers['X-STE-Compose-Id'], originalId); assert.equal(final.body.input, 'Write a new announcement after cancellation.');
  assert.doesNotMatch($('#generation-error').textContent, /OLD_GENERATION_FAILURE/);
});

test('changing selected expert content invalidates a preparation snapshot before it can reach generation', async t => {
  let release; const gate = new Promise(r => { release = r; }); let held = true;
  const { $, win, submit, requests } = await page(t, { prefs: { 'context-autonomous': true, 'context-use-sources': true }, intercept: row => row.path === '/api/compose/prepare' && held ? gate : null });
  $('#context-add-expert').click(); const text = $('#context-source-list textarea');
  text.value = 'Use the old style.'; text.dispatchEvent(new win.Event('input', { bubbles: true })); submit();
  await until(() => requests.some(r => r.path === '/api/compose/prepare'));
  assert.equal(requests.find(r => r.path === '/api/compose/prepare').body.sources[0].text, 'Use the old style.');
  text.value = 'Use the new style.'; text.dispatchEvent(new win.Event('input', { bubbles: true }));
  held = false; release(Response.json({ state: 'ready', grounding: { evidence: [{ text: 'STALE_EVIDENCE' }] }, evidence: [], sources: [], warnings: [] }));
  await until(() => $('#cancel-button').hidden); assert.equal(requests.some(r => r.path === '/api/generate'), false);
  submit(); await until(() => !$('#prompt-output').hidden && $('#cancel-button').hidden);
  assert.equal(requests.filter(r => r.path === '/api/compose/prepare').at(-1).body.sources[0].text, 'Use the new style.');
  assert.doesNotMatch(JSON.stringify(requests.find(r => r.path === '/api/generate').body), /STALE_EVIDENCE/);
});
