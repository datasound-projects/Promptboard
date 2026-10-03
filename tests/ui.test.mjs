import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { startServer } from '../src/server.mjs';
import { fakeGh } from './fixtures/fake-gh.mjs';
// Git output for assertions (the file's local helpers take other argument shapes).
const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
import { VERSION } from '../src/version.mjs';

const catalogs = {
  codex: { source: 'cli', defaultModel: 'codex-one', defaultEffort: 'medium', models: [{ id: 'codex-one', name: 'Codex One', efforts: ['low', 'medium', 'high', 'xhigh'] }, { id: 'codex-two', name: 'Codex Two', efforts: ['low'] }] },
  claude: { source: 'cli', models: [{ id: 'opus', name: 'Opus', efforts: ['low', 'medium', 'high', 'max'] }, { id: 'haiku', name: 'Haiku', efforts: [] }] },
  gemini: { source: 'cli', models: [{ id: 'gemini-one', name: 'Gemini One', efforts: [] }] },
  agy: { source: 'cli', models: [{ id: 'gemini-agy', name: 'Gemini AGY', efforts: ['low', 'medium', 'high'] }] },
};
async function until(fn, label, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!await fn()) { if (Date.now() > deadline) assert.fail(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 10)); }
}
// Fixture auth adapter: never runs a real CLI, and records every mutation.
function fakeAuth(overrides = {}) {
  const log = [];
  return { log, installed: async () => true, status: async provider => { log.push(['status', provider]); return { state: 'signed-in', method: 'fixture' }; },
    login: async (provider, options) => { log.push(['login', provider, options.method]); options.onUpdate({ authUrl: 'https://auth.example/start' }); return { state: 'signed-in' }; },
    logout: async provider => { log.push(['logout', provider]); return { state: 'signed-out' }; }, ...overrides };
}
async function setup(t, { catalogReader = async id => ({ provider: id, ...catalogs[id], note: 'Native model options.' }), storage, prefs = {}, kanban, hash = '', generationResponse, authAdapter = fakeAuth(), runner, dataDir, executor = 'auto', folderPicker, usageReader } = {}) {
  // Every page gets a private board folder unless a test shares one to simulate a reload.
  if (!dataDir) { dataDir = await mkdtemp(join(tmpdir(), 'pb-ui-')); t.after(() => rm(dataDir, { recursive: true, force: true })); }
  const calls = [];
  const requests = [];
  const app = await startServer({ port: 0, dataDir, executor, authAdapter, usageReader, ...(folderPicker ? { folderPicker } : {}), detector: async () => Object.keys(catalogs).map(id => ({ id, available: true })), catalogReader,
    runner: runner ? async request => { calls.push(request); return runner(request); } : async request => { calls.push(request); return { text: request.prompt.includes('prose in Polish') ? 'Dodaj test.' : request.prompt.includes('prose in German') ? 'Füge einen Test hinzu.' : 'Add a test.', reportedModels: ['actual-model'], durationMs: 3 }; } });
  const dom = new JSDOM(await readFile(new URL('../public/index.html', import.meta.url), 'utf8'), { url: app.url + hash, runScripts: 'outside-only' });
  const win = dom.window;
  const intervals = [], nativeInterval = win.setInterval.bind(win);
  win.setInterval = (fn, ms, ...args) => { intervals.push({ fn, ms }); return nativeInterval(fn, ms, ...args); };
  let pending = 0;
  win.fetch = (url, options) => {
    pending++;
    const done = response => { pending--; return response; };
    const fail = error => { pending--; throw error; };
    if (url === '/api/generate') {
      const request = JSON.parse(options.body);
      requests.push(request);
      if (generationResponse) return Promise.resolve(Response.json(typeof generationResponse === 'function' ? generationResponse(request) : generationResponse)).then(done, fail);
    }
    return fetch(new URL(url, app.url), options).then(done, fail);
  };
  win.TextEncoder = TextEncoder;
  win.TextDecoder = TextDecoder;
  win.AbortController = AbortController;
  win.scrollTo = () => {};
  win.HTMLElement.prototype.scrollIntoView = () => {};
  const downloads = [], blobs = [];
  win.Blob = Blob;
  win.URL.createObjectURL = blob => { blobs.push(blob); return `blob:test-${blobs.length}`; };
  win.URL.revokeObjectURL = () => {};
  win.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
  if (storage) win.localStorage.setItem('ste-prompt-engineer.history.v1', JSON.stringify(storage));
  for (const [key, value] of Object.entries(prefs)) win.localStorage.setItem(key, value);
  if (kanban !== undefined) win.localStorage.setItem('ste-prompt-engineer.kanban.v1', typeof kanban === 'string' ? kanban : JSON.stringify(kanban));
  // jsdom has <dialog> without showModal/close.
  win.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  win.HTMLDialogElement.prototype.close = function () { this.open = false; };
  let copied;
  Object.defineProperty(win.navigator, 'clipboard', { value: { writeText: async text => { copied = text; } } });
  // Same order as the page: prefs.js runs in <head>, app.js is deferred.
  win.eval(await readFile(new URL('../public/prefs.js', import.meta.url), 'utf8'));
  win.eval(await readFile(new URL('../public/base.js', import.meta.url), 'utf8'));
  // Browsers share one global scope across classic scripts; jsdom's eval does not, so evaluate them together.
  // Test-only export appended by the harness (not part of the app): reload the board and read the token.
  win.eval(`${await readFile(new URL('../public/app.js', import.meta.url), 'utf8')}\n${await readFile(new URL('../public/dock.js', import.meta.url), 'utf8')}\nwindow.__pbTest = { loadBoard, get token() { return token; } };`);
  t.after(async () => {
    // A request can still be in flight when a test ends (for example a model refresh). Its handler
    // would then touch a closed window. Wait until the page is idle for a few ticks, then close.
    for (let idle = 0, end = Date.now() + 3000; idle < 3 && Date.now() < end;) { await new Promise(resolve => setTimeout(resolve, 10)); idle = pending ? 0 : idle + 1; }
    for (const session of win.promptboardDock?.sessions.values() || []) { session.closed = true; session.abort?.abort(); }
    win.close(); await app.close();
  });
  const $ = selector => win.document.querySelector(selector);
  const choose = (id, value) => { $(id).value = value; $(id).dispatchEvent(new win.Event('change', { bubbles: true })); };
  const radio = language => { $(`input[name="language"][value="${language}"]`).checked = true; $(`input[name="language"][value="${language}"]`).dispatchEvent(new win.Event('change')); };
  const submit = () => $('#prompt-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => !$('#generate-button').disabled, 'initial model discovery');
  const quality = value => { $(`input[name="quality"][value="${value}"]`).checked = true; $(`input[name="quality"][value="${value}"]`).dispatchEvent(new win.Event('change')); };
  // Resolves when no request from the page is in flight.
  const idle = async () => { for (let quiet = 0, end = Date.now() + 5000; quiet < 3 && Date.now() < end;) { await new Promise(resolve => setTimeout(resolve, 10)); quiet = pending ? 0 : quiet + 1; } };
  return { win, intervals, $, choose, radio, quality, submit, calls, requests, downloads, blobs, copied: () => copied, authAdapter, app, dataDir, idle };
}

test('UI sends selected model, effort, and language through HTTP, then restores history and copies output', async t => {
  const { $, choose, radio, quality, submit, calls, requests, copied, win } = await setup(t);
  assert.equal($('input[name="language"]:checked').value, 'en');
  assert.equal($('input[name="quality"]:checked').value, 'reviewed');
  quality('fast');
  assert.match($('#model').options[0].textContent, /codex-one/);
  choose('#model', 'codex-one'); choose('#effort', 'xhigh'); radio('pl');
  $('#prompt-input').value = 'Add a test.';
  submit();
  await until(() => !$('#generate-button').disabled && calls.length === 1, 'first result');
  assert.equal(calls[0].model, 'codex-one'); assert.equal(calls[0].effort, 'xhigh');
  assert.equal(requests[0].quality, 'fast');
  assert.match(calls[0].prompt, /prose in Polish/);
  assert.equal($('#prompt-output').textContent, 'Dodaj test.');
  assert.match($('#output-meta').textContent, /actual-model/);
  $('#copy-button').click(); await until(() => copied(), 'copy'); assert.equal(copied(), 'Dodaj test.');
  await until(() => $('#copy-label').textContent === 'Copied!', 'copy feedback');
  assert.equal($('#copy-cheer'), null);
  $('#new-prompt').click(); assert.equal($('input[name="language"]:checked').value, 'en');
  assert.equal($('input[name="quality"]:checked').value, 'reviewed');
  $('.history-restore').click();
  await until(() => !$('#generate-button').disabled, 'restore model discovery');
  assert.equal($('#model').value, 'codex-one'); assert.equal($('#effort').value, 'xhigh'); assert.equal($('input[name="language"]:checked').value, 'pl');
  assert.equal($('input[name="quality"]:checked').value, 'fast');
  const entry = JSON.parse(win.localStorage.getItem('ste-prompt-engineer.history.v1'))[0];
  assert.equal(entry.model, 'codex-one'); assert.equal(entry.language, 'pl');
  choose('#model', 'codex-two'); assert.equal($('#effort').value, '');
  assert.deepEqual(Array.from($('#effort').options, x => x.value), ['', 'low']);
  choose('#provider', 'claude'); await until(() => !$('#model').disabled, 'Claude catalog');
  choose('#model', 'opus'); choose('#effort', 'max'); radio('de'); submit();
  await until(() => calls.length === 2 && !$('#generate-button').disabled, 'German result');
  assert.equal(calls[1].provider, 'claude'); assert.equal(calls[1].effort, 'max'); assert.match(calls[1].prompt, /prose in German/);
  choose('#model', 'haiku'); assert.equal($('#effort').disabled, true); assert.equal($('#effort').value, '');
  choose('#provider', 'gemini'); await until(() => !$('#model').disabled, 'Gemini catalog');
  choose('#model', 'gemini-one'); assert.equal($('#effort').disabled, true);
  choose('#provider', 'agy'); await until(() => !$('#model').disabled, 'AGY catalog');
  choose('#model', 'gemini-agy'); choose('#effort', 'high'); submit();
  await until(() => calls.length === 3 && !$('#generate-button').disabled, 'AGY result');
  assert.equal(calls[2].provider, 'agy'); assert.equal(calls[2].effort, 'high');
});

test('UI ignores stale model responses when the provider changes quickly', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { $, choose } = await setup(t, { catalogReader: async provider => {
    if (provider === 'claude') await gate;
    return { provider, ...catalogs[provider] };
  } });
  choose('#provider', 'claude');
  choose('#provider', 'agy');
  await until(() => !$('#model').disabled, 'newest provider catalog');
  assert.ok(Array.from($('#model').options, x => x.value).includes('gemini-agy'));
  release(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal($('#provider').value, 'agy');
  assert.ok(!Array.from($('#model').options, x => x.value).includes('opus'));
});

test('unavailable catalogs keep explicit custom IDs usable; old history defaults to English', async t => {
  const storage = [{ id: 'old', input: 'Add a test.', prompt: 'Add a test.', provider: 'codex', model: 'old-model' }];
  const { $, choose, quality, submit, calls } = await setup(t, { storage, catalogReader: async provider => ({ provider, models: [], source: 'unavailable', note: 'Update your CLI.' }) });
  assert.match($('#model-note').textContent, /Update/);
  $('.history-restore').click(); await until(() => !$('#model').disabled, 'old history');
  assert.equal($('input[name="language"]:checked').value, 'en');
  assert.equal($('input[name="quality"]:checked').value, 'reviewed');
  assert.match($('#verification-status').textContent, /no verification report/);
  assert.equal($('#verification-report').hidden, true);
  assert.equal($('#report-button').disabled, true);
  assert.equal($('#model').value, '__custom__'); assert.equal($('#custom-model').value, 'old-model');
  quality('fast');
  choose('#effort', 'high'); submit();
  await until(() => calls.length === 1 && !$('#generate-button').disabled, 'custom ID result');
  assert.equal(calls[0].model, 'old-model'); assert.equal(calls[0].effort, 'high');
});

function report(overrides = {}) {
  return {
    status: 'checks-passed', mode: 'reviewed',
    automatic: { status: 'pass', checks: [{ id: 'protected-literals', status: 'pass', count: 1 }], issues: [], protectedCount: 1, matchedCount: 1, reviewRequired: true },
    review: { status: 'pass', requirements: [{ id: 'S1', sourceQuote: 'Add a test.', promptQuote: 'Add a test.', status: 'covered', note: 'The requirement is preserved.' }], criteria: ['meaning', 'constraints', 'no-invention', 'conflicts', 'language', 'scope', 'clarity'].map(criterion => ({ criterion, status: 'pass', note: 'No issue found.' })), issues: [] },
    repaired: false, repairFailed: false, calls: 2, engineVersion: '0.3.0', promptHash: 'prompt-hash', inputHash: 'input-hash', instructionsHash: 'instructions-hash',
    repairReasons: [], stages: [{ stage: 'draft', reportedModels: ['model-one'], durationMs: 250, status: 'complete', inputBytes: 5000, outputBytes: 300 }, { stage: 'review', reportedModels: ['model-one'], durationMs: 250, status: 'complete', inputBytes: 2048, outputBytes: 200 }],
    timings: { totalMs: 530, modelMs: 500, checksMs: 30 }, reviewRequired: true, ...overrides,
  };
}

test('reviewed mode shows bounded usage, report evidence, JSON export, and restored verification', async t => {
  const verification = report();
  const { $, submit, requests, downloads, blobs, win, copied } = await setup(t, { generationResponse: { prompt: 'Add a test.', provider: 'codex', verification } });
  assert.match($('#quality-note').textContent, /2 CLI calls; up to 4/);
  assert.ok($('.sidebar-footer').textContent.endsWith(`v${VERSION}`), 'The footer shows the package version.');
  $('#prompt-input').value = 'Add a test.';
  submit();
  await until(() => !$('#generate-button').disabled && requests.length === 1, 'reviewed result');
  assert.equal(requests[0].quality, 'reviewed');
  assert.equal($('#verification-status').textContent, 'Checks complete—review before use');
  assert.equal($('#verification-report').hidden, false);
  assert.equal($('#verification-report').open, false);
  assert.match($('#verification-limits').textContent, /Model review can miss errors/);
  assert.match($('#automatic-checks').textContent, /protected literals: pass \(1\)/);
  assert.equal($('#requirement-ledger').children.length, 1);
  assert.match($('#requirement-ledger').textContent, /Covered/);
  assert.equal($('#review-criteria').children.length, 7);
  assert.match($('#review-criteria').textContent, /no invention: pass/);
  assert.match($('#verification-stages').textContent, /models reported: model-one/);
  assert.match($('#verification-stages').textContent, /review: complete · 0\.3s · in 2\.0 KB, out 0\.2 KB/);
  assert.match($('#verification-overview').textContent, /1 of 1 detected protected items matched/);
  $('#copy-button').click(); await until(() => copied(), 'copy without report');
  assert.equal(copied(), 'Add a test.');
  $('#report-button').click();
  assert.match(downloads[0], /^ste-check-report-.*\.json$/);
  const exported = JSON.parse(await blobs[0].text());
  assert.equal(exported.request.input, 'Add a test.');
  assert.equal(exported.prompt, 'Add a test.');
  assert.deepEqual(exported.verification, verification);
  const stored = JSON.parse(win.localStorage.getItem('ste-prompt-engineer.history.v1'));
  assert.deepEqual(stored[0].verification, verification);
  const restored = await setup(t, { storage: stored });
  restored.$('.history-restore').click();
  await until(() => !restored.$('#model').disabled, 'saved report restore');
  assert.equal(restored.$('#verification-status').textContent, 'Checks complete—review before use');
  assert.equal(restored.$('#requirement-ledger').children.length, 1);
  assert.equal(restored.$('#report-button').disabled, false);
});

test('issues and unavailable reviews keep the draft visible, flag it, and render evidence as plain text', async t => {
  let result = {
    prompt: 'Add a test.', verification: report({ status: 'needs-review', repaired: true, calls: 4,
      automatic: { status: 'issues', checks: [{ id: 'protected-literals', status: 'issues' }], issues: [{ rule: 'missing-literal', message: 'A literal is absent.', excerpt: '<img src=x onerror=alert(1)>' }], protectedCount: 1, matchedCount: 0 },
      review: { status: 'issues', requirements: [{ sourceQuote: 'Keep <script> unchanged.', promptQuote: '', status: 'missing', note: 'The text is missing.' }], issues: [{ category: 'requirements', message: 'A requirement is missing.', sourceQuote: 'Keep <script> unchanged.' }] },
    }),
  };
  const { $, submit, requests } = await setup(t, { generationResponse: () => result });
  $('#prompt-input').value = 'Add a test.'; submit();
  await until(() => !$('#generate-button').disabled && requests.length === 1, 'flagged draft');
  assert.equal($('#prompt-output').hidden, false);
  assert.equal($('#copy-button').disabled, false);
  assert.equal($('#verification-status').textContent, 'Draft—review needed');
  assert.equal($('#verification-report').open, true);
  assert.match($('#verification-summary').textContent, /4 CLI calls · one repair/);
  assert.equal($('#verification-issues').children.length, 2);
  assert.match($('#verification-issues').textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal($('#verification-issues img'), null);
  assert.equal($('#requirement-ledger script'), null);
  assert.match($('#requirement-ledger').textContent, /Missing/);
  result = { prompt: 'Add a test.', verification: report({ status: 'needs-review', review: { status: 'unavailable', requirements: [], issues: [] } }) };
  submit(); await until(() => !$('#generate-button').disabled && requests.length === 2, 'unavailable review');
  assert.equal($('#verification-status').textContent, 'Draft—review needed');
  assert.match($('#requirement-note').textContent, /unavailable/);
  assert.equal($('#requirement-ledger').hidden, true);
  assert.equal($('#prompt-output').textContent, 'Add a test.');
});

test('fast mode clearly distinguishes automatic checks from skipped model review', async t => {
  const { $, quality, submit, requests } = await setup(t, { generationResponse: { prompt: 'Add a test.', verification: report({ mode: 'fast', calls: 1, review: { status: 'skipped', requirements: [], issues: [] } }) } });
  quality('fast');
  assert.match($('#quality-note').textContent, /1 CLI call/);
  assert.match($('#quality-note').textContent, /No model review or repair/);
  $('#prompt-input').value = 'Add a test.'; submit();
  await until(() => !$('#generate-button').disabled && requests.length === 1, 'fast result');
  assert.equal(requests[0].quality, 'fast');
  assert.match($('#verification-status').textContent, /model review skipped/);
  assert.match($('#requirement-note').textContent, /No requirement coverage claim/);
  assert.equal($('#requirement-ledger').hidden, true);
});

test('a failed repair, uncertain criterion, and language issue are visible with the retained draft', async t => {
  const verification = report({ status: 'needs-review', repairFailed: true, calls: 3,
    review: { ...report().review, status: 'issues', criteria: [{ criterion: 'meaning', status: 'uncertain', note: 'The constraint is ambiguous.' }] },
  });
  const { $, submit, requests, downloads, blobs } = await setup(t, { generationResponse: {
    prompt: 'Add a test.', verification, lint: { warnings: [{ rule: 'sentence-length', line: 1, message: 'Shorten this instruction.' }] },
  } });
  $('#prompt-input').value = 'Add a test.'; submit();
  await until(() => !$('#generate-button').disabled && requests.length === 1, 'failed repair report');
  assert.equal($('#verification-status').textContent, 'Draft—review needed');
  assert.equal($('#prompt-output').textContent, 'Add a test.');
  assert.match($('#verification-issues').textContent, /repair call failed/);
  assert.match($('#verification-issues').textContent, /Line 1: Shorten this instruction/);
  assert.match($('#review-criteria').textContent, /meaning: uncertain — The constraint is ambiguous/);
  $('#report-button').click();
  assert.equal(downloads.length, 1);
  const exported = JSON.parse(await blobs[0].text());
  assert.equal(exported.verification.repairFailed, true);
  assert.equal(exported.lint.warnings[0].rule, 'sentence-length');
});

test('full browser storage keeps the result usable and shows a persistent unsaved-history warning', async t => {
  const { $, win, submit, requests, copied, downloads } = await setup(t, { generationResponse: { prompt: 'Add a test.', verification: report() } });
  win.Storage.prototype.setItem = () => { throw new win.DOMException('Storage is full.', 'QuotaExceededError'); };
  $('#prompt-input').value = 'Add a test.'; submit();
  await until(() => !$('#generate-button').disabled && requests.length === 1, 'result despite full storage');
  assert.equal($('#prompt-output').textContent, 'Add a test.');
  assert.equal($('#prompt-output').hidden, false);
  assert.equal($('#storage-warning').hidden, false);
  assert.match($('#storage-warning').textContent, /History changes were not saved/);
  assert.match($('#announcement').textContent, /Browser history was not saved/);
  assert.equal(win.localStorage.getItem('ste-prompt-engineer.history.v1'), null);
  assert.equal($('#copy-button').disabled, false);
  $('#copy-button').click(); await until(() => copied(), 'copy unsaved prompt');
  assert.equal(copied(), 'Add a test.');
  $('#report-button').click(); assert.equal(downloads.length, 1);
  assert.equal($('#storage-warning').hidden, false);
  $('#new-prompt').click();
  assert.equal($('#storage-warning').hidden, false);
  assert.equal($('#history-list').children.length, 1);
});

test('progress shows the stage and elapsed time; cancel restores the form and keeps the input', async t => {
  let release;
  const { $, submit, calls } = await setup(t, { runner: ({ signal }) => new Promise((resolve, reject) => {
    release = () => resolve({ text: 'Add a test.' });
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }) });
  $('#prompt-input').value = 'Keep this request.';
  submit();
  await until(() => calls.length === 1, 'generation started');
  assert.equal($('#generate-button').disabled, true);
  assert.equal($('#cancel-button').hidden, false);
  await until(() => $('#progress-stage').textContent === 'Drafting prompt', 'stage label');
  assert.match($('#progress-elapsed').textContent, /^\d+:\d\d$/);
  submit(); // A duplicate submit while running is ignored.
  $('#cancel-button').click();
  await until(() => !$('#generate-button').disabled, 'form restored after cancel');
  assert.equal($('#cancel-button').hidden, true);
  assert.equal($('#prompt-input').value, 'Keep this request.');
  assert.match($('#announcement').textContent, /canceled/i);
  assert.equal(calls.length, 1);
});

test('provider failures show a stable message with a supplied reset time, keep input, and allow a retry', async t => {
  const { ProviderError } = await import('../src/providers.mjs');
  let fail = true;
  const { $, submit, calls, quality } = await setup(t, { runner: async () => {
    if (fail) throw Object.assign(new ProviderError('raw SECRET', 'RATE_LIMITED'), { resetsAt: '2026-10-01T12:00:00.000Z' });
    return { text: 'Add a test.' };
  } });
  quality('fast');
  $('#prompt-input').value = 'Keep this request.';
  submit();
  await until(() => !$('#generation-error').hidden && !$('#generate-button').disabled, 'error shown');
  assert.match($('#generation-error').textContent, /temporarily limiting/);
  assert.match($('#generation-error').textContent, /reset at/);
  assert.doesNotMatch($('#generation-error').textContent, /SECRET|exhausted/i);
  assert.doesNotMatch($('#generation-error').textContent, /nerd|glasses|tidy|goooo/i);
  assert.equal($('#prompt-input').value, 'Keep this request.');
  fail = false;
  submit();
  await until(() => calls.length === 2 && !$('#generate-button').disabled, 'retry result');
  assert.equal($('#prompt-output').textContent, 'Add a test.');
  assert.equal($('#generation-error').hidden, true);
});

test('connection panel separates install and sign-in, hands off terminal sign-in, and confirms sign-out', async t => {
  const authAdapter = fakeAuth({ status: async provider => (provider === 'codex' ? { state: 'signed-in', method: 'chatgpt' } : provider === 'claude' ? { state: 'signed-out' } : { state: 'unknown' }) });
  let lookups = 0;
  const { $, choose, win } = await setup(t, { authAdapter, catalogReader: async id => { lookups++; return { provider: id, ...catalogs[id] }; } });
  await until(() => /Signed in/.test($('#connection-auth').textContent), 'codex status');
  assert.match($('#connection-install').textContent, /CLI installed/);
  assert.equal($('#connection-auth').textContent, 'Signed in (chatgpt)');
  assert.equal($('#auth-login').textContent, 'Reauthenticate');
  assert.equal($('#auth-device').hidden, false);
  // Native sign-in: a link to the CLI's https page, then a refresh of state and models.
  const before = lookups;
  $('#auth-login').click();
  await until(() => authAdapter.log.some(entry => entry[0] === 'login'), 'login started');
  await until(() => /confirmed the sign-in/.test($('#auth-detail').textContent), 'login completion', 6000);
  await until(() => lookups > before, 'model refresh after sign-in');
  assert.ok(!authAdapter.log.some(entry => entry[0] === 'logout'), 'Reauthentication never signs out first.');
  // Terminal handoff for Claude, with the verified command.
  choose('#provider', 'claude');
  await until(() => $('#connection-auth').textContent === 'Signed out', 'claude status');
  assert.equal($('#auth-login').textContent, 'Connect / Sign in');
  assert.equal($('#auth-device').hidden, true);
  $('#auth-login').click();
  assert.equal($('#auth-detail code').textContent, 'claude auth login');
  assert.match($('#auth-detail').textContent, /Check again/);
  // Sign-out requires an explicit confirmation that explains shared sessions.
  $('#auth-logout').click();
  assert.match($('#auth-detail').textContent, /Other terminals, editors, and apps/);
  assert.ok(!authAdapter.log.some(entry => entry[0] === 'logout'));
  Array.from(win.document.querySelectorAll('#auth-detail button')).find(b => b.textContent === 'Keep me signed in').click();
  assert.equal($('#auth-detail').hidden, true);
  assert.ok(!authAdapter.log.some(entry => entry[0] === 'logout'));
  $('#auth-logout').click();
  Array.from(win.document.querySelectorAll('#auth-detail button')).find(b => b.textContent === 'Sign out').click();
  await until(() => authAdapter.log.some(entry => entry[0] === 'logout'), 'logout after confirmation');
  assert.deepEqual(authAdapter.log.filter(entry => entry[0] === 'logout'), [['logout', 'claude']]);
  // Gemini: status and sign-out are labelled as unsupported, not simulated.
  choose('#provider', 'gemini');
  await until(() => /not reported by this CLI/.test($('#connection-auth').textContent), 'gemini status');
  $('#auth-logout').click();
  assert.match($('#auth-detail').textContent, /not available here/);
  assert.equal(authAdapter.log.filter(entry => entry[0] === 'logout').length, 1);
});

test('saved theme and sidebar state apply before app code runs, persist, and survive storage failures', async t => {
  const { $, win } = await setup(t, { prefs: { 'ste-prompt-engineer.theme': 'dark', 'ste-prompt-engineer.sidebar': 'collapsed' } });
  const root = win.document.documentElement;
  assert.equal(root.dataset.theme, 'dark');
  assert.equal($('meta[name="color-scheme"]').content, 'dark');
  assert.equal($('#theme-toggle').getAttribute('aria-pressed'), 'true');
  assert.equal(root.dataset.sidebar, 'collapsed');
  assert.equal($('#menu-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal($('#menu-toggle').getAttribute('aria-label'), 'Show prompt history');
  $('#theme-toggle').click();
  assert.equal(root.dataset.theme, 'light');
  assert.equal($('#theme-toggle').getAttribute('aria-pressed'), 'false');
  assert.equal(win.localStorage.getItem('ste-prompt-engineer.theme'), 'light');
  $('#menu-toggle').click();
  assert.equal(root.dataset.sidebar, 'expanded');
  assert.equal($('#menu-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(win.localStorage.getItem('ste-prompt-engineer.sidebar'), 'expanded');
  win.Storage.prototype.setItem = () => { throw new win.DOMException('Storage is full.', 'QuotaExceededError'); };
  $('#theme-toggle').click();
  assert.equal(root.dataset.theme, 'dark');
  // Narrow screens: the same toggle opens a drawer; Escape closes it and returns focus to the toggle.
  Object.defineProperty(win, 'innerWidth', { value: 375, configurable: true });
  $('#menu-toggle').click();
  assert.ok($('#sidebar').classList.contains('open'));
  assert.equal($('#sidebar-scrim').hidden, false);
  assert.equal($('#menu-toggle').getAttribute('aria-expanded'), 'true');
  win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.ok(!$('#sidebar').classList.contains('open'));
  assert.equal($('#sidebar-scrim').hidden, true);
  assert.equal(win.document.activeElement, $('#menu-toggle'));
});

test('long history lists every entry, restores a selection, deletes one, and filters by search', async t => {
  const storage = Array.from({ length: 501 }, (_, index) => ({ id: `entry-${index}`, input: `Request number ${index}`, prompt: `Prompt ${index}`, createdAt: 1790000000000 - index, provider: 'codex' }));
  const { $, win } = await setup(t, { storage });
  assert.equal($('#history-list').children.length, 500, 'History keeps the newest 500 prompts.');
  assert.equal($('#history-count').textContent, '500');
  assert.equal($('#history-empty').hidden, true);
  win.document.querySelectorAll('.history-restore')[5].click();
  await until(() => !$('#model').disabled, 'restored entry');
  assert.equal($('#prompt-input').value, 'Request number 5');
  assert.equal($('.history-item.active .history-restore').getAttribute('aria-current'), 'true');
  $('.history-item.active .history-delete').click();
  assert.equal($('#history-list').children.length, 499);
  assert.equal($('.history-item.active'), null);
  const stored = JSON.parse(win.localStorage.getItem('ste-prompt-engineer.history.v1'));
  assert.equal(stored.length, 499);
  assert.ok(!stored.some(entry => entry.id === 'entry-5'));
  $('#history-search').value = 'no such request';
  $('#history-search').dispatchEvent(new win.Event('input'));
  assert.equal($('#history-list').children.length, 0);
  assert.equal($('#history-empty').hidden, false);
  assert.match($('#history-empty small').textContent, /Try another word/);
});

test('the skip link focuses the visible page and never changes the page', async t => {
  const { $, win } = await setup(t, { hash: '#/kanban' });
  await until(() => !$('#kanban-view').hidden, 'Kanban page');
  const skip = () => $('#skip-link').dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  skip();
  assert.equal(win.document.activeElement, $('#kanban-view'));
  assert.equal(win.location.hash, '#/kanban');
  win.location.hash = '#/';
  await until(() => $('#kanban-view').hidden, 'prompt page');
  skip();
  assert.equal(win.document.activeElement, $('#prompt-input'));
  assert.equal(win.location.hash, '#/');
});

// Kanban page. The board lives on the server; the browser only shows it.
const HISTORY_KEY = 'ste-prompt-engineer.history.v1';
const KANBAN_KEY = 'ste-prompt-engineer.kanban.v1';
const serverBoard = ctx => ctx.app.board.view();
const serverTasks = async (ctx, name) => (await serverBoard(ctx)).projects.find(project => !name || project.name === name).tasks;
const column = ($, id) => $(`#kanban-columns .kanban-cards[data-column="${id}"]`);
const titles = ($, id = 'todo') => Array.from(column($, id)?.querySelectorAll('.kanban-open') || [], button => button.textContent);
const byText = (root, text) => Array.from(root.querySelectorAll('button')).find(button => button.textContent === text);
const submitForm = ({ $, win }, selector) => $(selector).dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
const cardItem = ({ $ }, title) => Array.from($('#kanban-columns').querySelectorAll('.kanban-card')).find(item => item.querySelector('.kanban-open').textContent === title);
async function goTo({ $, win, idle }, hash) {
  win.location.hash = hash;
  await until(() => $('#kanban-view').hidden === (hash !== '#/kanban'), `page ${hash}`);
  await idle();
}
async function newProject(ctx, name) { ctx.$('#project-new').click(); ctx.$('#project-name').value = name; submitForm(ctx, '#project-form'); await ctx.idle(); }
async function newCard(ctx, title, prompt) { ctx.$('#card-new').click(); ctx.$('#card-title').value = title; ctx.$('#card-prompt').value = prompt; submitForm(ctx, '#card-form'); await ctx.idle(); }
async function click(ctx, element) { element.click(); await ctx.idle(); }
async function importFile(ctx, text) {
  const { $, win } = ctx;
  $('#project-detail').replaceChildren(); $('#project-detail').hidden = true;
  Object.defineProperty($('#import-file'), 'files', { value: [new File([text], 'backup.json', { type: 'application/json' })], configurable: true });
  $('#import-file').dispatchEvent(new win.Event('change'));
  await until(() => !$('#project-detail').hidden, 'import result');
  await ctx.idle();
}
async function gitRepo(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pb-ui-repo-')));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-q', '-b', 'trunk'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  await writeFile(join(dir, 'a.txt'), 'a\n'); git('add', '.'); git('commit', '-q', '-m', 'init');
  return dir;
}

test('page navigation keeps unsaved prompt input, settings, and the current result', async t => {
  const ctx = await setup(t, { generationResponse: { prompt: 'Add a test.', verification: report() } });
  const { $, win, submit, requests } = ctx;
  $('#prompt-input').value = 'First request.'; submit();
  await until(() => requests.length === 1 && !$('#generate-button').disabled, 'result');
  $('#prompt-input').value = 'Unsaved next idea.';
  $('#terminology').value = 'FastAPI';
  // jsdom does not follow link clicks, so navigate the same way a link does: by hash.
  assert.equal($('.brand').getAttribute('href'), '#/');
  await goTo(ctx, $('.page-nav a[href="#/kanban"]').getAttribute('href'));
  assert.equal($('#prompt-view').hidden, true);
  assert.equal($('.page-nav a[href="#/kanban"]').getAttribute('aria-current'), 'page');
  assert.equal($('.page-nav a[href="#/"]').hasAttribute('aria-current'), false);
  assert.match(win.document.title, /Kanban/);
  await newProject(ctx, 'Alpha');
  $('#card-new').click();
  // Shortcuts from Kanban fields never start a generation or clear the prompt form.
  $('#card-prompt').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  win.document.body.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'n', bubbles: true }));
  $('#card-cancel').click();
  assert.equal(requests.length, 1);
  await goTo(ctx, $('.page-nav a[href="#/"]').getAttribute('href'));
  assert.equal($('.page-nav a[href="#/"]').getAttribute('aria-current'), 'page');
  assert.equal($('#prompt-input').value, 'Unsaved next idea.');
  assert.equal($('#terminology').value, 'FastAPI');
  assert.equal($('#prompt-output').textContent, 'Add a test.');
  // A reload on the Kanban address opens the Kanban page with the server's board.
  const reloaded = await setup(t, { hash: '#/kanban', dataDir: ctx.dataDir });
  await reloaded.idle();
  assert.equal(reloaded.$('#kanban-view').hidden, false);
  assert.equal(reloaded.$('#project-select').selectedOptions[0].textContent, 'Alpha');
});

test('Add to Kanban stores an exact prompt snapshot in To Do; card edits never change history', async t => {
  const exact = '  Leading spaces stay.\r\nCRLF line.\n\n\tTabbed <script>alert(1)</script> — ünïcødé ✓ 🚀\n' + 'Long line. '.repeat(80) + '\n  trailing  \n';
  let result = { prompt: exact, provider: 'codex', reportedModels: ['actual-model'], verification: report({ status: 'needs-review' }) };
  const ctx = await setup(t, { generationResponse: () => result });
  const { $, win, submit, requests, choose, radio, copied } = ctx;
  choose('#model', 'codex-one'); choose('#effort', 'high'); radio('de');
  $('#prompt-input').value = 'Build   the\nexport endpoint with tests.'; submit();
  await until(() => requests.length === 1 && !$('#generate-button').disabled, 'result');
  const entry = JSON.parse(win.localStorage.getItem(HISTORY_KEY))[0];
  $('#kanban-button').click();
  assert.equal($('#add-dialog').open, true);
  assert.equal($('#add-project').value, '');
  assert.equal($('#add-project-name-field').hidden, false);
  assert.equal($('#add-title').value, 'Build the export endpoint with tests.');
  assert.equal($('#add-preview').textContent, exact);
  assert.match($('#add-note').textContent, /exact prompt/);
  submitForm(ctx, '#add-form'); await ctx.idle();
  assert.match($('#add-error').textContent, /project name/);
  assert.equal((await serverBoard(ctx)).projects.length, 0);
  $('#add-project-name').value = 'Alpha';
  submitForm(ctx, '#add-form'); await ctx.idle();
  assert.equal($('#add-dialog').open, false);
  const [card] = await serverTasks(ctx);
  assert.equal(card.prompt, exact);
  assert.equal(card.column, 'todo');
  assert.equal(card.title, 'Build the export endpoint with tests.');
  assert.deepEqual(card.source, { historyId: entry.id, provider: 'codex', model: 'codex-one', effort: 'high', reportedModels: ['actual-model'], language: 'de', quality: 'reviewed', verification: 'needs-review', generatedAt: entry.createdAt });
  assert.equal(card.checksOutdated, false);
  assert.equal(win.localStorage.getItem(KANBAN_KEY), null, 'The browser no longer stores the board.');
  // A second prompt goes to the preselected existing project.
  result = { prompt: 'Second prompt.', provider: 'codex', verification: report() };
  submit(); await until(() => requests.length === 2 && !$('#generate-button').disabled, 'second result');
  $('#kanban-button').click();
  assert.equal($('#add-project').value, (await serverBoard(ctx)).projects[0].id);
  assert.equal($('#add-project-name-field').hidden, true);
  submitForm(ctx, '#add-form'); await ctx.idle();
  assert.equal((await serverBoard(ctx)).projects.length, 1);
  assert.deepEqual((await serverBoard(ctx)).runs, [], 'Adding a card never starts a run.');
  await goTo(ctx, '#/kanban');
  const [draft, passed] = column($, 'todo').children;
  assert.ok(draft.classList.contains('needs-review'));
  assert.equal(draft.querySelector('.kanban-status').textContent, 'Draft—review needed');
  assert.equal(draft.querySelector('.kanban-meta').textContent, 'Prompt source: Codex · codex-one · Deutsch');
  assert.ok(draft.querySelector('.kanban-preview').textContent.length <= 400);
  assert.equal($('#kanban-columns script'), null);
  assert.equal(passed.querySelector('.kanban-status').textContent, 'Checks complete—review before use');
  draft.querySelector('.kanban-copy').click();
  await until(() => copied() === exact, 'exact copy');
  // Open and save without changes: the stored text and status stay the same.
  draft.querySelector('.kanban-open').click();
  assert.match($('#card-note').textContent, /marks the previous checks as outdated/);
  assert.match($('#card-source-list').textContent, /Models reported: actual-model/);
  submitForm(ctx, '#card-form'); await ctx.idle();
  assert.equal((await serverTasks(ctx))[0].prompt, exact);
  assert.equal((await serverTasks(ctx))[0].checksOutdated, false);
  // A real edit marks the old checks as outdated and leaves history alone.
  column($, 'todo').querySelector('.kanban-open').click();
  $('#card-prompt').value = 'Edited prompt.';
  submitForm(ctx, '#card-form'); await ctx.idle();
  const edited = (await serverTasks(ctx))[0];
  assert.equal(edited.prompt, 'Edited prompt.');
  assert.equal(edited.checksOutdated, true);
  assert.equal(edited.source.verification, 'needs-review');
  assert.equal(column($, 'todo').querySelector('.kanban-status').textContent, 'Edited—previous checks outdated');
  assert.deepEqual(JSON.parse(win.localStorage.getItem(HISTORY_KEY)).find(item => item.id === entry.id), entry);
});

test('projects keep separate boards; names are validated; deletion needs confirmation', async t => {
  const history = [{ id: 'h1', input: 'Old request.', prompt: 'Old prompt.', provider: 'codex' }];
  const ctx = await setup(t, { storage: history });
  const { $, win, choose } = ctx;
  await goTo(ctx, '#/kanban');
  assert.match($('#board-empty').textContent, /Create a project to start planning/);
  assert.equal($('#card-new').disabled, true);
  assert.equal($('#project-delete').disabled, true);
  assert.equal($('#kanban-columns').hidden, true);
  await newProject(ctx, 'Alpha');
  const alpha = $('#project-select').value;
  await newCard(ctx, 'A1', 'Prompt A1'); await newCard(ctx, 'A2', 'Prompt A2');
  await newProject(ctx, 'Beta');
  assert.notEqual($('#project-select').value, alpha);
  assert.deepEqual(titles($), []);
  assert.match($('#board-empty').textContent, /No tasks yet/);
  await newCard(ctx, 'B1', 'Prompt B1');
  choose('#project-select', alpha);
  assert.deepEqual(titles($), ['A1', 'A2']);
  assert.equal($('#board-count').textContent, '02');
  // On Kanban the sidebar is the project workspace, not prompt history; it switches boards too.
  assert.equal($('#history-panel').hidden, true);
  assert.equal($('#workspace-panel').hidden, false);
  assert.equal($('#sidebar').getAttribute('aria-label'), 'Projects');
  const items = () => [...$('#workspace-list').querySelectorAll('.workspace-item')];
  assert.deepEqual(items().map(item => item.querySelector('.workspace-name').textContent), ['Alpha', 'Beta']);
  assert.match(items()[0].querySelector('.workspace-meta').textContent, /^Alpha → \S+ · 2 cards$/, 'A new project has its own Git repository.');
  assert.equal(items()[0].getAttribute('aria-current'), 'true');
  items()[1].click(); await ctx.idle();
  assert.deepEqual(titles($), ['B1']);
  assert.equal($('#project-select').selectedOptions[0].textContent, 'Beta');
  assert.equal(items()[1].getAttribute('aria-current'), 'true');
  items()[0].click(); await ctx.idle();
  assert.deepEqual(titles($), ['A1', 'A2']);
  // Each project can be managed from the sidebar: ⋯ → Rename (inline), Link repository, Delete (inline confirm).
  const entry = name => items().find(item => item.querySelector('.workspace-name').textContent === name).closest('li');
  const menu = async (name, label) => { entry(name).querySelector('.workspace-menu-toggle').click(); await ctx.idle(); [...entry(name).querySelectorAll('.workspace-menu button')].find(button => button.textContent === label).click(); await ctx.idle(); };
  await menu('Beta', 'Rename');
  const rename = entry('Beta').querySelector('.workspace-rename');
  rename.querySelector('input').value = 'Alpha';
  rename.dispatchEvent(new win.Event('submit', { cancelable: true })); await ctx.idle();
  assert.match(entry('Beta').querySelector('.workspace-menu').textContent, /already exists/);
  entry('Beta').querySelector('.workspace-rename input').value = 'Beta two';
  entry('Beta').querySelector('.workspace-rename').dispatchEvent(new win.Event('submit', { cancelable: true })); await ctx.idle();
  assert.deepEqual(items().map(item => item.querySelector('.workspace-name').textContent), ['Alpha', 'Beta two']);
  await menu('Beta two', 'Delete…');
  assert.match(entry('Beta two').querySelector('.workspace-menu').textContent, /Delete “Beta two” and its 1 card\? This cannot be undone/);
  [...entry('Beta two').querySelectorAll('.workspace-menu button')].find(button => button.textContent === 'Keep').click(); await ctx.idle();
  assert.equal(entry('Beta two').querySelector('.workspace-menu'), null);
  await menu('Beta two', 'Change repository…'); // A new project already has its own repository.
  assert.equal($('#project-select').selectedOptions[0].textContent, 'Beta two', 'The action selects that project.');
  assert.equal($('#repo-panel').hidden, false);
  assert.equal($('#project-body').hidden, false);
  await menu('Beta two', 'Rename');
  entry('Beta two').querySelector('.workspace-rename input').value = 'Beta';
  entry('Beta two').querySelector('.workspace-rename').dispatchEvent(new win.Event('submit', { cancelable: true })); await ctx.idle();
  items()[0].click(); await ctx.idle();
  $('#project-new').click(); $('#project-name').value = ' beta '; submitForm(ctx, '#project-form'); await ctx.idle();
  assert.match($('#project-error').textContent, /already exists/);
  $('#project-name').value = '   '; submitForm(ctx, '#project-form');
  assert.match($('#project-error').textContent, /Enter a project name/);
  $('#project-cancel').click();
  assert.equal((await serverBoard(ctx)).projects.length, 2);
  $('#project-rename').click();
  assert.equal($('#project-name').value, 'Alpha');
  $('#project-name').value = 'Alpha renamed'; submitForm(ctx, '#project-form'); await ctx.idle();
  assert.equal($('#project-select').selectedOptions[0].textContent, 'Alpha renamed');
  $('#project-delete').click();
  assert.match($('#project-detail').textContent, /Delete “Alpha renamed” and its 2 cards\? This cannot be undone/);
  byText($('#project-detail'), 'Keep project').click();
  assert.equal($('#project-detail').hidden, true);
  assert.equal((await serverBoard(ctx)).projects.length, 2);
  $('#project-delete').click();
  await click(ctx, byText($('#project-detail'), 'Delete project'));
  const board = await serverBoard(ctx);
  assert.deepEqual(board.projects.map(project => project.name), ['Beta']);
  assert.deepEqual(board.projects[0].tasks.map(card => card.title), ['B1']);
  assert.deepEqual(titles($), ['B1']);
  assert.equal(win.localStorage.getItem(HISTORY_KEY), JSON.stringify(history));
});

test('seven stages render; cards are created, edited, duplicated, deleted, and reordered; the order persists', async t => {
  const ctx = await setup(t);
  const { $, win, copied } = ctx;
  await goTo(ctx, '#/kanban');
  await newProject(ctx, 'Work');
  assert.deepEqual(Array.from($('#kanban-columns').querySelectorAll('h3'), heading => heading.textContent), ['To Do', 'Planning', 'Executing', 'Code Review', 'Testing', 'Merge', 'Done']);
  assert.match($('#kanban-columns [data-column="todo"] .kanban-column-note').textContent, /Never runs an agent/);
  assert.match($('#kanban-columns [data-column="done"] .kanban-column-note').textContent, /never runs an agent/);
  $('#card-new').click(); submitForm(ctx, '#card-form'); await ctx.idle();
  assert.match($('#card-error').textContent, /title/);
  $('#card-title').value = 'Only a title'; submitForm(ctx, '#card-form'); await ctx.idle();
  assert.match($('#card-error').textContent, /prompt/);
  $('#card-cancel').click();
  assert.equal((await serverTasks(ctx)).length, 0);
  await newCard(ctx, 'One', 'Prompt one'); await newCard(ctx, 'Two', 'Prompt two'); await newCard(ctx, 'Three', 'Prompt three');
  assert.deepEqual(titles($), ['One', 'Two', 'Three']);
  assert.equal(cardItem(ctx, 'One').querySelector('.kanban-status').textContent, 'Manual card—not checked');
  assert.equal(cardItem(ctx, 'One').querySelector('.kanban-move-up').disabled, true);
  assert.equal(cardItem(ctx, 'Three').querySelector('.kanban-move-down').disabled, true);
  assert.equal(cardItem(ctx, 'One').querySelector('.kanban-move-down').getAttribute('aria-label'), 'Move down: One');
  // The stage menu offers only valid moves: Planning, or Executing directly.
  assert.deepEqual(Array.from(cardItem(ctx, 'One').querySelectorAll('.kanban-move-to option'), item => item.value), ['', 'planning', 'executing']);
  // Keyboard reorder keeps focus on the moved card.
  await click(ctx, cardItem(ctx, 'One').querySelector('.kanban-move-down'));
  assert.deepEqual(titles($), ['Two', 'One', 'Three']);
  assert.equal(win.document.activeElement, cardItem(ctx, 'One').querySelector('.kanban-move-down'));
  assert.match($('#announcement').textContent, /Moved “One” to position 2 of 3/);
  await click(ctx, cardItem(ctx, 'One').querySelector('.kanban-move-down'));
  assert.deepEqual(titles($), ['Two', 'Three', 'One']);
  assert.equal(win.document.activeElement, cardItem(ctx, 'One').querySelector('.kanban-move-up'));
  await click(ctx, cardItem(ctx, 'One').querySelector('.kanban-move-up'));
  assert.deepEqual(titles($), ['Two', 'One', 'Three']);
  // Drag-and-drop: drop "Three" on "Two".
  cardItem(ctx, 'Three').dispatchEvent(new win.Event('dragstart', { bubbles: true }));
  const over = new win.Event('dragover', { bubbles: true, cancelable: true });
  cardItem(ctx, 'Two').dispatchEvent(over);
  assert.equal(over.defaultPrevented, true);
  cardItem(ctx, 'Two').dispatchEvent(new win.Event('drop', { bubbles: true, cancelable: true }));
  await ctx.idle();
  assert.deepEqual(titles($), ['Three', 'Two', 'One']);
  assert.deepEqual((await serverTasks(ctx)).map(card => card.title), ['Three', 'Two', 'One']);
  // An unlinked project keeps cards in To Do and explains why.
  await unlink(ctx);
  const menu = cardItem(ctx, 'One').querySelector('.kanban-move-to');
  menu.value = 'planning'; menu.dispatchEvent(new win.Event('change')); await ctx.idle();
  assert.match($('#project-detail').textContent, /Link this project to a Git repository/);
  assert.deepEqual(titles($), ['Three', 'Two', 'One']);
  // Edit a manual card.
  cardItem(ctx, 'Two').querySelector('.kanban-open').click();
  assert.equal($('#card-prompt').value, 'Prompt two');
  $('#card-title').value = 'Two edited'; $('#card-prompt').value = 'Prompt two, edited.';
  submitForm(ctx, '#card-form'); await ctx.idle();
  const editedCard = (await serverTasks(ctx))[1];
  assert.equal(editedCard.title, 'Two edited'); assert.equal(editedCard.prompt, 'Prompt two, edited.'); assert.equal(editedCard.checksOutdated, false);
  // Duplicate goes right after the original.
  await click(ctx, cardItem(ctx, 'Two edited').querySelector('.kanban-duplicate'));
  assert.deepEqual(titles($), ['Three', 'Two edited', 'Two edited (copy)', 'One']);
  const cards = await serverTasks(ctx);
  assert.notEqual(cards[2].id, cards[1].id);
  assert.equal(cards[2].prompt, cards[1].prompt);
  // Delete needs a confirmation.
  cardItem(ctx, 'Two edited (copy)').querySelector('.kanban-delete').click();
  assert.match($('#kanban-columns').textContent, /Delete “Two edited \(copy\)”\? This cannot be undone/);
  byText($('#kanban-columns'), 'Keep card').click();
  assert.equal((await serverTasks(ctx)).length, 4);
  cardItem(ctx, 'Two edited (copy)').querySelector('.kanban-delete').click();
  await click(ctx, byText($('#kanban-columns'), 'Delete card'));
  assert.deepEqual(titles($), ['Three', 'Two edited', 'One']);
  cardItem(ctx, 'One').querySelector('.kanban-copy').click();
  await until(() => copied() === 'Prompt one', 'copy');
  // Reload: projects and order come back from the app, not the browser.
  const reloaded = await setup(t, { dataDir: ctx.dataDir });
  await goTo(reloaded, '#/kanban');
  assert.deepEqual(titles(reloaded.$), ['Three', 'Two edited', 'One']);
  assert.equal(reloaded.$('#project-select').selectedOptions[0].textContent, 'Work');
});

test('a linked repository enables stage moves; invalid folders explain the problem; nothing runs', { skip: process.platform === 'win32' }, async t => {
  const ctx = await setup(t);
  const { $, win } = ctx;
  const repo = await gitRepo(t);
  await goTo(ctx, '#/kanban');
  await newProject(ctx, 'Linked');
  await newCard(ctx, 'Feature', 'Build the feature.');
  // The new project comes with its own Git repository in the projects folder.
  assert.match($('#repo-state').textContent, /Linked to \S+\/projects\/Linked\./);
  assert.equal(gitIn((await serverBoard(ctx)).projects[0].repository.root, 'log', '--format=%s'), 'Initial commit');
  $('#repo-path').value = join(repo, 'missing'); submitForm(ctx, '#repo-form'); await ctx.idle();
  assert.equal($('#repo-message').textContent, 'This folder does not exist.');
  $('#repo-path').value = tmpdir(); submitForm(ctx, '#repo-form'); await ctx.idle();
  assert.match($('#repo-message').textContent, /not a Git repository yet/);
  assert.equal($('#repo-setup').hidden, false, 'Setting up Git is offered, not done.');
  $('#repo-path').value = repo; submitForm(ctx, '#repo-form'); await ctx.idle();
  assert.match($('#repo-state').textContent, new RegExp(`Linked to ${repo}`));
  assert.deepEqual(Array.from($('#target-branch').options, item => item.value), ['', 'trunk']);
  $('#target-branch').value = 'trunk';
  await click(ctx, $('#branch-save'));
  assert.match($('#branch-state').textContent, /Target branch: trunk at [0-9a-f]{12}/);
  // Manual: the drag only moves (this test runs the real supervisor, so no agent may start).
  const linkedProject = (await serverBoard(ctx)).projects[0];
  await ctx.app.board.setWorkflow(linkedProject.id, { workflow: { executing: { policy: 'manual' } }, expectedRevision: linkedProject.revision });
  await ctx.win.__pbTest.loadBoard(); await ctx.idle();
  const menu = cardItem(ctx, 'Feature').querySelector('.kanban-move-to');
  menu.value = 'executing'; menu.dispatchEvent(new win.Event('change')); await ctx.idle();
  assert.deepEqual(titles($, 'executing'), ['Feature']);
  assert.match($('#announcement').textContent, /Moved “Feature” to Executing\. Nothing was started/);
  const board = await serverBoard(ctx);
  assert.equal(board.projects[0].tasks[0].column, 'executing');
  assert.equal(board.projects[0].tasks[0].workspace, null);
  assert.deepEqual(board.runs, []);
  assert.equal(board.execution.available, true);
  assert.match($('#kanban-columns [data-column="executing"] .kanban-column-note').textContent, /Manual · start from the card/);
  assert.match($('#kanban-columns [data-column="code_review"] .kanban-column-note').textContent, /Starts when a card arrives/);
  assert.match($('#kanban-columns [data-column="merge"] .kanban-column-note').textContent, /One click merges when verified/);
  // Project settings collapse to a one-line summary and remember the choice.
  $('#project-toggle').click();
  assert.equal($('#project-body').hidden, true);
  assert.equal($('#project-toggle').getAttribute('aria-expanded'), 'false');
  assert.match($('#project-summary').textContent, /Not linked|→/);
  assert.equal(ctx.win.localStorage.getItem('promptboard.project-panel'), 'collapsed');
  $('#project-toggle').click();
  assert.equal($('#project-body').hidden, false);
  // Copy, duplicate, and delete sit behind the card's "⋯" button.
  const card = $('#kanban-columns .kanban-card');
  assert.equal(card.querySelector('.kanban-more').hidden, true);
  card.querySelector('.kanban-more-toggle').click();
  assert.equal(card.querySelector('.kanban-more').hidden, false);
  assert.equal(card.querySelector('.kanban-more-toggle').getAttribute('aria-expanded'), 'true');
  // The ‹ › board buttons only appear when the stages overflow the window (never in jsdom, which has no layout).
  assert.equal($('#board-left').hidden && $('#board-right').hidden, true);
});

test('backups: export round-trips, import validates, asks before replacing, and keeps imported settings pending', async t => {
  const exact = 'Line 1\r\n  indented <b>x</b>\n';
  const legacy = { application: 'AI Prompt Engineer', kind: 'kanban-backup', version: 1, selectedProjectId: 'p2', projects: [
    { id: 'p1', name: 'One', createdAt: 1, cards: [{ id: 'c1', title: 'Card 1', prompt: exact, createdAt: 1, updatedAt: 1, checksOutdated: false,
      source: { historyId: 'h', provider: 'claude', model: 'opus', effort: '', reportedModels: [], language: 'pl', quality: 'fast', verification: 'checks-passed', generatedAt: 1 } }] },
    { id: 'p2', name: 'Two', createdAt: 2, cards: [] },
  ] };
  const ctx = await setup(t);
  const { $, choose, downloads, blobs } = ctx;
  await goTo(ctx, '#/kanban');
  await newProject(ctx, 'Current');
  await newCard(ctx, 'Keep me', 'Keep.');
  const before = JSON.stringify((await serverBoard(ctx)).projects);
  const withCard = changes => JSON.stringify({ ...legacy, projects: [{ ...legacy.projects[0], cards: [{ ...legacy.projects[0].cards[0], ...changes }] }] });
  for (const [text, message] of [
    ['not json', /not valid JSON/],
    [JSON.stringify({ ...legacy, kind: 'other' }), /not a Promptboard or Kanban backup/],
    [JSON.stringify({ ...legacy, version: 3 }), /not a Promptboard or version 1 Kanban board/],
    [withCard({ prompt: '' }), /card 1 needs a prompt/],
    [withCard({ title: 'x'.repeat(121) }), /title needs 1 to 120/],
    [JSON.stringify({ ...legacy, projects: [legacy.projects[0], { ...legacy.projects[1], id: 'p1' }] }), /unique ID/],
  ]) {
    await importFile(ctx, text);
    if (/Replace the current board/.test($('#project-detail').textContent)) await click(ctx, byText($('#project-detail'), 'Replace board'));
    assert.match($('#project-detail').textContent, /Import failed\. Your board is unchanged\./);
    assert.match($('#project-detail').textContent, message);
    assert.equal(JSON.stringify((await serverBoard(ctx)).projects), before);
  }
  await importFile(ctx, JSON.stringify(legacy));
  assert.match($('#project-detail').textContent, /Replace the current board \(1 project, 1 card\) with this backup \(2 projects, 1 card\)\?/);
  byText($('#project-detail'), 'Keep current board').click();
  assert.equal(JSON.stringify((await serverBoard(ctx)).projects), before);
  await importFile(ctx, JSON.stringify(legacy));
  await click(ctx, byText($('#project-detail'), 'Replace board'));
  assert.match($('#project-detail').textContent, /No agent runs were started/);
  const board = await serverBoard(ctx);
  assert.deepEqual(board.projects.map(project => project.name), ['One', 'Two']);
  assert.equal($('#project-select').value, 'p2');
  assert.equal(board.projects[0].tasks[0].prompt, exact);
  choose('#project-select', 'p1');
  assert.equal(column($, 'todo').querySelector('.kanban-status').textContent, 'Automatic checks only—review before use');
  assert.equal(column($, 'todo').querySelector('.kanban-meta').textContent, 'Prompt source: Claude Code · opus · Polski');
  await click(ctx, $('#export-board'));
  assert.match(downloads.at(-1), /^promptboard-backup-\d{4}-\d\d-\d\d\.json$/);
  const exported = JSON.parse(await blobs.at(-1).text());
  assert.equal(exported.kind, 'promptboard-backup');
  assert.equal(exported.projects[0].tasks[0].prompt, exact);
  // A version 2 backup with a repository path and automation waits for confirmation.
  exported.projects[0].repository = { path: '/nowhere/repo' };
  exported.projects[0].workflow = { executing: { policy: 'start' } };
  const fresh = await setup(t);
  await goTo(fresh, '#/kanban');
  await importFile(fresh, JSON.stringify(exported));
  assert.match(fresh.$('#project-detail').textContent, /Backup imported: 2 projects, 1 card\. No agent runs were started\. Imported repository paths and workflow settings wait for your confirmation/);
  fresh.choose('#project-select', 'p1');
  assert.equal(fresh.$('#import-pending').hidden, false);
  assert.match(fresh.$('#import-pending-text').textContent, /repository \/nowhere\/repo, workflow settings \(automatic runs in Executing\)/);
  const project = (await serverBoard(fresh)).projects.find(item => item.id === 'p1');
  assert.equal(project.repository, null);
  assert.deepEqual(project.workflow, {});
  assert.equal(project.effectiveWorkflow.executing.policy, 'start', 'The default; imported settings wait.');
  await click(fresh, fresh.$('#import-confirm'));
  assert.equal(fresh.$('#repo-message').textContent, 'This folder does not exist.');
  await click(fresh, fresh.$('#import-dismiss'));
  assert.equal(fresh.$('#import-pending').hidden, true);
  assert.deepEqual((await serverBoard(fresh)).runs, []);
});

test('the browser board migrates once with exact text; unreadable data and failed saves stay visible', { skip: process.platform === 'win32' }, async t => {
  const exact = '  Spaces\r\nCRLF 🚀\n';
  const browser = { version: 1, selectedProjectId: 'b', projects: [
    { id: 'a', name: 'Alpha', createdAt: 1, cards: [{ id: 'c1', title: 'First', prompt: exact, createdAt: 1, updatedAt: 2, checksOutdated: true, source: { provider: 'codex', verification: 'checks-passed', quality: 'reviewed' } }, { id: 'c2', title: 'Second', prompt: 'Two', createdAt: 3, updatedAt: 3 }] },
    { id: 'b', name: 'Beta', createdAt: 2, cards: [] },
  ] };
  const ctx = await setup(t, { kanban: browser, hash: '#/kanban' });
  await ctx.idle();
  let board = await serverBoard(ctx);
  assert.deepEqual(board.projects.map(project => project.id), ['a', 'b']);
  assert.deepEqual(board.projects[0].tasks.map(task => [task.id, task.prompt, task.checksOutdated, task.column]), [['c1', exact, true, 'todo'], ['c2', 'Two', false, 'todo']]);
  assert.equal(ctx.$('#project-select').value, 'b');
  assert.equal(ctx.win.localStorage.getItem(KANBAN_KEY), JSON.stringify(browser), 'The browser copy is kept.');
  assert.ok(ctx.win.localStorage.getItem(`${KANBAN_KEY}.migrated`));
  assert.match(ctx.$('#announcement').textContent, /Moved 2 projects and 2 cards/);
  // The same browser data on a fresh page (marker cleared) adds no duplicates.
  const again = await setup(t, { kanban: browser, hash: '#/kanban', dataDir: ctx.dataDir });
  await again.idle();
  board = await serverBoard(again);
  assert.equal(board.projects.length, 2);
  assert.equal(board.projects[0].tasks.length, 2);
  // Unreadable browser data is reported, kept, and not sent anywhere.
  const raw = '{"version":1,"projects":[{"id":"p"';
  const broken = await setup(t, { kanban: raw, hash: '#/kanban' });
  await broken.idle();
  assert.equal(broken.$('#kanban-load-warning').hidden, false);
  assert.match(broken.$('#kanban-load-warning').textContent, /could not be read, so it was not moved/);
  assert.equal(broken.win.localStorage.getItem(`${KANBAN_KEY}.unreadable`), raw);
  assert.equal(broken.win.localStorage.getItem(KANBAN_KEY), raw);
  assert.equal((await serverBoard(broken)).projects.length, 0);
  // A failed server write is visible and the board keeps its last saved state.
  await chmod(ctx.dataDir, 0o500);
  t.after(() => chmod(ctx.dataDir, 0o700).catch(() => {}));
  await goTo(ctx, '#/kanban');
  ctx.choose('#project-select', 'a');
  await newCard(ctx, 'Unsaved', 'Not written.');
  assert.match(ctx.$('#card-error').textContent, /could not be saved/);
  assert.equal(ctx.$('#kanban-view .board-warning').hidden, false);
  assert.deepEqual(titles(ctx.$), ['First', 'Second']);
  await chmod(ctx.dataDir, 0o700);
});

test('the settings step collapses and expands, is remembered, and reopens for an invalid field', async t => {
  const { $, win } = await setup(t);
  const toggle = $('#settings-toggle');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.textContent, '−');
  toggle.click();
  assert.equal($('#settings-body').hidden, true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.textContent, '+');
  assert.equal(toggle.getAttribute('aria-label'), 'Expand settings');
  assert.equal(win.localStorage.getItem('ste-prompt-engineer.settings'), 'collapsed');
  const restored = await setup(t, {});
  assert.equal(restored.$('#settings-body').hidden, false, 'A fresh browser storage starts expanded.');
  $('#custom-model').dispatchEvent(new win.Event('invalid', { cancelable: true }));
  assert.equal($('#settings-body').hidden, false);
  toggle.click(); toggle.click();
  assert.equal($('#settings-body').hidden, false);
  assert.equal(win.localStorage.getItem('ste-prompt-engineer.settings'), 'expanded');
});

test('the Kanban header exposes a collapsible settings panel outside the board', async t => {
  const { $ } = await setup(t);
  assert.equal($('#project-toggle').getAttribute('aria-controls'), 'project-settings');
  assert.ok($('#project-settings').contains($('#project-body')));
  assert.equal($('.kanban-board').contains($('#project-settings')), false);
  if ($('#project-settings').hidden) $('#project-toggle').click();
  assert.equal($('#project-settings').hidden, false);
  $('#project-settings-close').click();
  assert.equal($('#project-settings').hidden, true);
  assert.equal($('#project-toggle').getAttribute('aria-expanded'), 'false');
});

test('missing agent terminal support shows setup steps; the prompt editor still works', async t => {
  const executor = { describe: async () => ({ available: false, setupMessage: 'Agent terminals need the node-pty package. Run npm install in the Promptboard folder, then restart.' }), activeCount: () => 0 };
  const ctx = await setup(t, { executor, generationResponse: { prompt: 'Add a test.', verification: report() } });
  const { $, submit, requests } = ctx;
  $('#prompt-input').value = 'Still works.'; submit();
  await until(() => requests.length === 1 && !$('#generate-button').disabled, 'prompt result');
  assert.equal($('#prompt-output').textContent, 'Add a test.');
  await goTo(ctx, '#/kanban');
  assert.equal($('#execution-status').hidden, false);
  assert.match($('#execution-status').textContent, /Agent runs are unavailable\. Agent terminals need the node-pty package\. Run npm install/);
  await newProject(ctx, 'Setup');
  assert.match($('#kanban-columns [data-column="executing"] .kanban-column-note').textContent, /not set up/);
});

// ---- PB-03: transitions, workflow settings, consent, and task details ----

function fakeExecutor() {
  const providers = {
    claude: { name: 'Claude Code', planning: { supported: true, how: 'Plan mode, read-only tools.' }, execution: { supported: true, how: 'Edits in the task worktree.' }, permissionModes: ['acceptEdits', 'default'] },
    codex: { name: 'Codex CLI', planning: { supported: true, how: 'Read-only sandbox.' }, execution: { supported: true, how: 'Workspace-write sandbox.' }, permissionModes: ['workspace-write'] },
  };
  const executor = {
    started: [],
    describe: async () => ({ available: true, setupMessage: '', providers }),
    validate: async ({ stage, config }) => ({ provider: config.provider || 'claude', model: config.model || '', effort: config.effort || '', permissionMode: stage === 'planning' ? 'plan' : config.permissionMode || providers[config.provider || 'claude'].permissionModes[0] }),
    start: async ({ run }) => { executor.started.push(run); },
    activeCount: () => 0,
    subscribe: () => null,
    async confirm(runId) { const run = await executor.board.run(runId); if (run.stage === 'planning') await executor.board.approvePlan(run.taskId, { runId }); if (run.status === 'queued') await executor.board.updateRun(runId, { status: 'running' }); await executor.board.updateRun(runId, { status: 'succeeded' }); if (['executing', 'testing'].includes(run.stage)) await executor.board.recordStageResult(run, 'Verified the task results.'); },
    async cancel(runId) { await executor.board.updateRun(runId, { status: 'cancelled' }); },
    async suspend(runId) { await executor.board.beginSuspension(runId); await executor.board.updateRun(runId, { status: 'suspended' }); },
    artifact: async () => 'PLAN\n1. Change the parser.',
  };
  return executor;
}
async function linkedKanban(t, options = {}) {
  const executor = fakeExecutor();
  const ctx = await setup(t, { executor, hash: '#/kanban', ...options });
  executor.board = ctx.app.board;
  const repo = await gitRepo(t);
  await ctx.idle();
  await newProject(ctx, 'Flow');
  const project = (await serverBoard(ctx)).projects[0];
  return { ...ctx, executor, repo, project };
}
/** Remove the repository link of the selected project, to test what an unlinked project does. */
async function unlink(ctx) {
  const id = ctx.$('#project-select').value;
  await ctx.app.board.linkRepository(id, { path: null, expectedRevision: (await ctx.app.board.state()).projects.find(project => project.id === id).revision });
  await ctx.win.__pbTest.loadBoard(); await ctx.idle();
}
async function link(ctx) {
  // New projects already have their own repository; these tests link a prepared one with a "trunk" branch.
  const revision = async () => (await ctx.app.board.state()).projects.find(project => project.id === ctx.project.id).revision;
  await ctx.app.board.linkRepository(ctx.project.id, { path: ctx.repo, expectedRevision: await revision() });
  await ctx.app.board.setTargetBranch(ctx.project.id, { branch: 'trunk', expectedRevision: await revision() });
  await ctx.win.__pbTest.loadBoard(); await ctx.idle();
}
const moveBy = async (ctx, title, column) => { const menu = cardItem(ctx, title).querySelector('.kanban-move-to'); menu.value = column; menu.dispatchEvent(new ctx.win.Event('change')); };

test('Kanban Pause and Resume preserve the conversation and keep Composer cards in To Do', { skip: process.platform === 'win32' }, async t => {
  const ctx = await linkedKanban(t);
  await link(ctx);
  await newCard(ctx, 'Unstarted', 'Exact To Do text.');
  const card = await ctx.app.board.createTask({ projectId: ctx.project.id, title: 'Conversation', prompt: 'Original task.' });
  await ctx.app.board.moveTask(card.id, { column: 'executing', expectedRevision: 1 });
  const run = await ctx.app.board.requestRun(card.id, { stage: 'executing', consent: true });
  await ctx.app.board.updateRun(run.id, { status: 'running', providerSessionId: 'native-conversation' });
  await ctx.win.__pbTest.loadBoard(); await ctx.idle();
  const pause = cardItem(ctx, 'Conversation').querySelector('.kanban-pause');
  assert.match(pause.getAttribute('aria-label'), /Pause agent.*Conversation/);
  pause.focus(); assert.equal(ctx.win.document.activeElement, pause);
  await click(ctx, pause);
  assert.equal((await ctx.app.board.run(run.id)).status, 'suspended');
  const resume = cardItem(ctx, 'Conversation').querySelector('.kanban-resume');
  assert.match(resume.getAttribute('aria-label'), /Resume conversation.*Conversation/);
  assert.match(cardItem(ctx, 'Conversation').textContent, /Paused/);
  assert.equal(cardItem(ctx, 'Unstarted').querySelector('.kanban-resume'), null);
  await click(ctx, resume);
  const resumed = ctx.executor.started.at(-1);
  assert.equal(resumed.sessionId, run.sessionId);
  assert.equal(resumed.providerSessionId, 'native-conversation');
  assert.deepEqual(resumed.resumeFrom, { runId: run.id, nativeSessionId: 'native-conversation' });
  assert.deepEqual(titles(ctx.$, 'todo'), ['Unstarted']);
  assert.equal((await serverTasks(ctx)).find(task => task.title === 'Unstarted').prompt, 'Exact To Do text.');
});

test('drag-and-drop and keyboard moves use the same transition; rejected moves roll back visibly with the reason', { skip: process.platform === 'win32' }, async t => {
  const ctx = await linkedKanban(t);
  const { $, win } = ctx;
  await newCard(ctx, 'Keyboard', 'Move me with the menu.');
  await newCard(ctx, 'Dragged', 'Move me with the mouse.');
  // Keyboard: the card stays in its column, marked "Moving to …", until the server answers; it never jumps first.
  await unlink(ctx);
  await moveBy(ctx, 'Keyboard', 'planning');
  assert.ok(cardItem(ctx, 'Keyboard').classList.contains('moving'), 'A move shows as pending until the server answers.');
  assert.match(cardItem(ctx, 'Keyboard').textContent, /Moving to Planning…/);
  assert.deepEqual(titles($, 'planning'), [], 'The card does not enter Planning before the server accepts the move.');
  await ctx.idle();
  assert.deepEqual(titles($, 'todo'), ['Keyboard', 'Dragged'], 'The refused move leaves the card in place.');
  assert.ok(cardItem(ctx, 'Keyboard').classList.contains('rejected'));
  assert.match($('#project-detail').textContent, /“Keyboard” stayed in To Do\. Link this project to a Git repository before cards leave To Do/);
  // Drag-and-drop onto the empty Planning column: the same transition and the same rejection.
  cardItem(ctx, 'Dragged').dispatchEvent(new win.Event('dragstart', { bubbles: true }));
  const planning = column($, 'planning');
  const over = new win.Event('dragover', { bubbles: true, cancelable: true });
  planning.dispatchEvent(over);
  assert.equal(over.defaultPrevented, true);
  planning.dispatchEvent(new win.Event('drop', { bubbles: true, cancelable: true }));
  await ctx.idle();
  assert.deepEqual(titles($, 'todo'), ['Keyboard', 'Dragged']);
  assert.match($('#project-detail').textContent, /“Dragged” stayed in To Do\. Link this project/);
  // After linking, both paths make the same transition (Executing set to Manual here, so nothing starts).
  await link(ctx);
  await ctx.app.board.setWorkflow(ctx.project.id, { workflow: { executing: { policy: 'manual' } }, expectedRevision: (await serverBoard(ctx)).projects[0].revision });
  await ctx.win.__pbTest.loadBoard(); await ctx.idle();
  await moveBy(ctx, 'Keyboard', 'executing'); await ctx.idle();
  cardItem(ctx, 'Dragged').dispatchEvent(new win.Event('dragstart', { bubbles: true }));
  column($, 'executing').dispatchEvent(new win.Event('drop', { bubbles: true, cancelable: true }));
  await ctx.idle();
  assert.deepEqual(titles($, 'executing'), ['Keyboard', 'Dragged']);
  const tasks = await serverTasks(ctx);
  assert.deepEqual(tasks.map(task => task.transitions.map(({ from, to, by }) => [from, to, by])), [[['todo', 'executing', 'user']], [['todo', 'executing', 'user']]]);
  // Done accepts a drop only from Merge (a verified merge). From Executing, the drop zone refuses the card.
  assert.match(column($, 'done').querySelector('.kanban-done-drop').textContent, /Complete from Testing or Merge · no merge/);
  cardItem(ctx, 'Dragged').dispatchEvent(new win.Event('dragstart', { bubbles: true }));
  const refused = new win.Event('dragover', { bubbles: true, cancelable: true });
  column($, 'done').querySelector('.kanban-done-drop').dispatchEvent(refused);
  assert.equal(refused.defaultPrevented, false, 'Done is not a drop target for a card in Executing.');
  column($, 'done').querySelector('.kanban-done-drop').dispatchEvent(new win.Event('drop', { bubbles: true, cancelable: true }));
  await ctx.idle();
  assert.deepEqual(titles($, 'executing'), ['Keyboard', 'Dragged']);
  // A verified completion (here: no changes required) lists the card in Done; Reopen starts a new cycle.
  const dragged = (await serverTasks(ctx)).find(task => task.title === 'Dragged');
  await ctx.app.board.delivery.completeNoChanges(dragged.id, { confirm: true });
  await win.__pbTest.loadBoard(); await ctx.idle();
  assert.match(column($, 'done').textContent, /Completed \(1\)/);
  assert.match(column($, 'done').querySelector('.kanban-done-card').textContent, /#\d+.*just now/s);
  column($, 'done').querySelector('.kanban-done-all').click();
  assert.equal($('#done-dialog').open, true);
  assert.deepEqual(Array.from($('#done-dialog-list').querySelectorAll('.kanban-open'), button => button.textContent), ['Dragged']);
  await click(ctx, $('#done-dialog-list .kanban-reopen'));
  assert.equal($('#done-dialog').open, false);
  assert.deepEqual(titles($, 'todo'), ['Dragged']);
  const reopened = (await serverTasks(ctx)).find(task => task.title === 'Dragged');
  assert.deepEqual([reopened.completion, reopened.previousCompletions.at(-1).kind, reopened.transitions.at(-1).by], [null, 'no_changes', 'reopen']);
  assert.equal(ctx.executor.started.length, 0, 'Manual moves start nothing.');
});

test('workflow settings: dragging starts the stage by default; Manual only moves; Merge shows one button unless it merges automatically; To Do stays inert', { skip: process.platform === 'win32' }, async t => {
  const ctx = await linkedKanban(t);
  const { $, win } = ctx;
  await link(ctx);
  await newCard(ctx, 'Alpha', 'First task.');
  await newCard(ctx, 'Beta', 'Second task.');
  assert.match($('#workflow-summary').textContent, /Planning: Start automatically · Executing: Start automatically/);
  $('#workflow-open').click();
  const stages = [...$('#workflow-stages').querySelectorAll('.workflow-stage[data-stage]')];
  assert.deepEqual(stages.map(box => box.dataset.stage), ['planning', 'executing', 'code_review', 'testing', 'merge'], 'To Do and Done have no workflow setting.');
  assert.deepEqual(Array.from(stages.at(-1).querySelectorAll('.segmented span'), span => span.textContent), ['Merge automatically', 'Merge button']);
  assert.equal(stages.at(-1).querySelector('input[value="manual"]').checked, true, 'Merge waits for the button by default.');
  assert.ok(stages.slice(0, -1).every(box => box.querySelector('input[value="start"]').checked), 'Every stage starts when a card arrives.');
  assert.equal(stages[0].querySelectorAll('input[type="radio"]').length, 2, 'No "Ask" setting.');
  assert.match(stages[0].querySelector('.workflow-preview').textContent, /Moving a card here starts it/);
  assert.match($('#workflow-stages').textContent, /Dragging a card is the instruction/);
  // Manual for Planning.
  $('#workflow-stages [data-stage="planning"] input[value="manual"]').checked = true;
  submitForm(ctx, '#workflow-form'); await ctx.idle();
  assert.equal($('#workflow-dialog').open, false);
  const project = (await serverBoard(ctx)).projects[0];
  assert.equal(project.workflow.planning.policy, 'manual');
  await moveBy(ctx, 'Beta', 'planning'); await ctx.idle();
  assert.deepEqual(titles($, 'planning'), ['Beta'], 'Manual only moves.');
  assert.equal(ctx.executor.started.length, 0);
  // The default: dropping on Executing starts the agent at once, with no question.
  await moveBy(ctx, 'Alpha', 'executing'); await ctx.idle();
  assert.equal(ctx.executor.started.length, 1, 'One run started by the drag.');
  const run = ctx.executor.started[0];
  assert.equal(run.trigger, 'user');
  const alpha = (await serverTasks(ctx)).find(task => task.title === 'Alpha');
  assert.deepEqual([alpha.column, alpha.lastTransition.runId], ['executing', run.id], 'The card and its run are saved together.');
  assert.match($('#announcement').textContent, /Moved “Alpha” to Executing and started the Executing agent/);
  // Settings changes apply to future runs only.
  $('#workflow-open').click();
  $('#workflow-stages [data-stage="executing"] [data-field="provider"]').value = 'codex';
  submitForm(ctx, '#workflow-form'); await ctx.idle();
  assert.equal((await ctx.app.board.run(run.id)).config.provider, 'claude', 'The active run keeps its configuration snapshot.');
  // To Do stays inert and cannot be targeted by a run.
  await ctx.app.board.updateRun(run.id, { status: 'cancelled' }); await win.__pbTest.loadBoard(); await ctx.idle();
  await moveBy(ctx, 'Alpha', 'todo'); await ctx.idle();
  assert.equal(ctx.executor.started.length, 1);
  const refused = await fetch(`${ctx.app.url}/api/tasks/${alpha.id}/runs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ste-token': win.__pbTest.token }, body: JSON.stringify({ stage: 'todo', consent: true }) });
  assert.equal((await refused.json()).code, 'STAGE_NOT_RUNNABLE');
});

test('the card’s Start button starts at once with the resolved agent; plan approval stays available; details show prompt, plan, and history', { skip: process.platform === 'win32' }, async t => {
  const ctx = await linkedKanban(t);
  const { $, win } = ctx;
  await link(ctx);
  await ctx.app.board.setWorkflow(ctx.project.id, { workflow: { planning: { policy: 'manual' } }, agentDefaults: { provider: 'claude', model: 'haiku' }, expectedRevision: (await serverBoard(ctx)).projects[0].revision });
  const created = await ctx.app.board.createTask({ projectId: ctx.project.id, title: 'Parser', prompt: 'Fix the parser.', source: { provider: 'codex', verification: 'needs-review', quality: 'reviewed' } });
  await ctx.app.board.moveTask(created.id, { column: 'planning', expectedRevision: 1 });
  await win.__pbTest.loadBoard(); await ctx.idle();
  assert.equal(ctx.executor.started.length, 0, 'Manual: nothing started on arrival.');
  assert.equal(cardItem(ctx, 'Parser').querySelector('.kanban-start').textContent, 'Start planning');
  await click(ctx, cardItem(ctx, 'Parser').querySelector('.kanban-start'));
  assert.equal(ctx.executor.started.length, 1, 'One click starts; no dialog.');
  const run = ctx.executor.started[0];
  assert.deepEqual([run.trigger, run.config.model, run.config.permissionMode], ['user', 'haiku', 'plan'], 'The inherited model; read-only planning.');
  // Simulate the plan turn the real supervisor records from provider events.
  await ctx.app.board.updateRun(run.id, { status: 'running' });
  await ctx.app.board.updateRun(run.id, { status: 'waiting_for_input', turns: 1, turnComplete: true, hasPlan: true, planExcerpt: 'PLAN' });
  await win.__pbTest.loadBoard(); await ctx.idle();
  assert.match(cardItem(ctx, 'Parser').querySelector('.run-badge').textContent, /Planning · AWAITS YOU/);
  assert.equal($('#workspace-list .workspace-live.waiting').textContent, '1 waiting', 'The sidebar shows which project needs attention.');
  cardItem(ctx, 'Parser').querySelector('.kanban-confirm-run').click(); await ctx.idle();
  assert.equal($('#task-dialog').open, true);
  const details = $('#task-details').textContent;
  assert.match(details, /Draft—review needed\. Task text revision 1/);
  assert.match(details, /Fix the parser\./);
  assert.match(details, /PLAN\n1\. Change the parser\./);
  assert.match(details, /Claude Code · haiku/);
  assert.match(details, /waiting for input/);
  await click(ctx, byText($('#task-details'), 'Approve plan'));
  const approved = (await serverTasks(ctx))[0];
  assert.equal(approved.planApproval.runId, run.id);
  assert.equal((await ctx.app.board.run(run.id)).status, 'succeeded');
  // Editing the task text makes the approval stale, and details say so.
  cardItem(ctx, 'Parser').querySelector('.kanban-open').click();
  $('#card-prompt').value = 'Fix the parser and the lexer.';
  submitForm(ctx, '#card-form'); await ctx.idle();
  cardItem(ctx, 'Parser').querySelector('.kanban-details').click(); await ctx.idle();
  assert.match($('#task-details').textContent, /Task text revision 2/);
  assert.match($('#task-details').textContent, /approval is stale: the task changed/);
});

test('Workflow permissions: Plan Mode is fixed; project and inherited stage settings persist; Codex never offers per-file approval', { skip: process.platform === 'win32' }, async t => {
  const ctx = await linkedKanban(t);
  const { $, win } = ctx;
  await link(ctx);
  $('#workflow-open').click();
  const defaults = $('#workflow-stages .workflow-defaults');
  const provider = defaults.querySelector('[data-field="provider"]');
  provider.value = 'claude'; provider.dispatchEvent(new win.Event('change', { bubbles: true }));
  defaults.querySelector('[data-field="permissionMode"]').value = 'approve_edit';
  const planning = $('#workflow-stages [data-stage="planning"] [data-field="permissionMode"]');
  assert.equal(planning.value, 'plan');
  assert.equal(planning.disabled, true);
  const executing = $('#workflow-stages [data-stage="executing"]');
  assert.equal(executing.querySelector('[data-field="provider"]').value, '');
  executing.querySelector('[data-field="permissionMode"]').value = 'auto';
  submitForm(ctx, '#workflow-form'); await ctx.idle();
  let project = (await serverBoard(ctx)).projects[0];
  assert.equal(project.agentDefaults.permissionMode, 'default');
  assert.equal(project.workflow.executing.permissionMode, 'auto');
  assert.equal(project.effectiveWorkflow.executing.permissionMode, 'acceptEdits');
  assert.equal(project.effectiveWorkflow.planning.permissionMode, 'plan');
  $('#workflow-open').click();
  const stageProvider = $('#workflow-stages [data-stage="executing"] [data-field="provider"]');
  stageProvider.value = 'codex'; stageProvider.dispatchEvent(new win.Event('change', { bubbles: true }));
  const permissions = $('#workflow-stages [data-stage="executing"] [data-field="permissionMode"]');
  assert.deepEqual([...permissions.options].map(item => item.value), ['', 'auto']);
  assert.match($('#workflow-stages [data-stage="executing"]').textContent, /no per-file Approve edit mode/);
  permissions.value = 'auto';
  submitForm(ctx, '#workflow-form'); await ctx.idle();
  project = (await serverBoard(ctx)).projects[0];
  assert.equal(project.effectiveWorkflow.executing.provider, 'codex');
  assert.equal(project.effectiveWorkflow.executing.permissionMode, 'workspace-write');
});

test('Done keeps accomplishments and evidence visible, offers no task-work controls, and does not merge', { skip: process.platform === 'win32' }, async t => {
  const ctx = await linkedKanban(t);
  const { $ } = ctx;
  await link(ctx);
  const board = ctx.app.board;
  const created = await board.createTask({ projectId: ctx.project.id, title: 'Keep unmerged', prompt: 'Add a file.' });
  // This test supplies its own review/test evidence. Do not also start stage agents,
  // whose confirmation can launch another test run while the Done assertion is underway.
  await board.moveTask(created.id, { column: 'executing', decision: 'move', expectedRevision: 1 });
  const ws = await board.ensureTaskWorktree(created.id);
  await writeFile(join(ws.path, 'unmerged.txt'), 'keep this change\n');
  await board.delivery.commit(created.id, { message: 'unmerged work', confirm: true });
  const current = async () => (await serverTasks(ctx)).find(task => task.id === created.id);
  await board.moveTask(created.id, { column: 'code_review', decision: 'move', expectedRevision: (await current()).revision });
  const head = (await board.delivery.revision(created.id)).taskCommit;
  await board.delivery.recordReview({ id: 'same-task-review', taskId: created.id, review: { taskCommit: head }, promptRevision: 1 }, '```json\n{"verdict":"no_issues","findings":[]}\n```');
  await board.moveTask(created.id, { column: 'testing', decision: 'move', expectedRevision: (await current()).revision });
  await board.delivery.setTestCommands(ctx.project.id, { commands: [{ command: `${process.execPath} -e "0"` }], expectedRevision: (await serverBoard(ctx)).projects[0].revision });
  await board.delivery.runTests(created.id, { confirm: true });
  await until(async () => (await current()).evidence?.tests?.status === 'passed', 'configured tests passed');
  await board.updateTaskEvidence(created.id, task => { task.stageResults = { executing: { runId: 'task-execution', promptRevision: 1, summary: 'Added unmerged.txt and verified it.' } }; });
  const before = (await board.delivery.revision(created.id)).targetCommit;
  await board.moveTask(created.id, { column: 'done', expectedRevision: (await current()).revision });
  await ctx.win.__pbTest.loadBoard(); await ctx.idle();
  column($, 'done').querySelector('.kanban-details').click();
  await until(() => /Accomplished/.test($('#task-details').textContent) && /Last run: passed/.test($('#task-details').textContent), 'saved accomplishments and evidence');
  assert.match($('#task-details').textContent, /Nothing was merged or pushed/);
  assert.match($('#task-details').textContent, /Added unmerged\.txt and verified it\./);
  assert.equal(byText($('#task-details'), 'Run tests…'), undefined);
  assert.equal(byText($('#task-details'), 'Commit task changes…'), undefined);
  assert.equal((await board.delivery.revision(created.id)).targetCommit, before);
});

test('PB-04 in the UI: commit, configured tests, accepted review, merge preview, confirmed merge', { skip: process.platform === 'win32', timeout: 60000 }, async t => {
  const ctx = await linkedKanban(t);
  const { $, win } = ctx;
  await link(ctx);
  const created = await ctx.app.board.createTask({ projectId: ctx.project.id, title: 'Ship it', prompt: 'Add a file.' });
  const task = await ctx.app.board.moveTask(created.id, { column: 'executing', expectedRevision: 1 });
  const workspace = await ctx.app.board.ensureTaskWorktree(task.id);
  await writeFile(join(workspace.path, 'shipped.txt'), 'shipped\n');
  await ctx.win.__pbTest.loadBoard(); await ctx.idle();
  const openDetails = async () => { cardItem(ctx, 'Ship it').querySelector('.kanban-details').click(); await until(() => !/Reading the task branch/.test($('#task-details').textContent) && /Task revision/.test($('#task-details').textContent), 'delivery details'); await ctx.idle(); };
  // Commit through the details view, with a diff preview and an inline confirmation.
  await openDetails();
  await until(() => /\+shipped/.test($('#task-details').textContent), 'diff preview');
  assert.match($('#task-details').textContent, /1 uncommitted change/);
  byText($('#task-details'), 'Commit task changes…').click();
  assert.match($('#task-details').textContent, /with your existing Git identity\?/);
  await click(ctx, byText($('#task-details'), 'Commit'));
  await until(() => /1 commit ahead of trunk/.test($('#task-details').textContent), 'committed');
  $('#task-dialog').close();
  // Test commands come from Workflow settings only.
  $('#workflow-open').click();
  $('#test-commands').value = `${process.execPath} -e "process.exit(0)"`;
  submitForm(ctx, '#workflow-form'); await ctx.idle();
  assert.deepEqual((await serverBoard(ctx)).projects[0].testCommands[0].argv, [process.execPath, '-e', 'process.exit(0)']);
  // Review evidence (recorded as the supervisor does after a confirmed review run), accepted in the UI.
  const tasks = () => serverTasks(ctx);
  await moveBy(ctx, 'Ship it', 'code_review'); await ctx.idle(); // The drag starts the review.
  const reviewRun = ctx.executor.started.at(-1);
  assert.equal(reviewRun.stage, 'code_review');
  assert.equal(reviewRun.config.permissionMode, 'plan', 'Review is read-only.');
  await ctx.app.board.updateRun(reviewRun.id, { status: 'running' });
  await ctx.app.board.updateRun(reviewRun.id, { status: 'succeeded' });
  await ctx.app.board.delivery.recordReview(reviewRun, '```json\n{"verdict":"no_issues","findings":[]}\n```');
  await ctx.win.__pbTest.loadBoard(); await ctx.idle();
  await openDetails();
  assert.match($('#task-details').textContent, /Review completed · verdict no issues/);
  await click(ctx, byText($('#task-details'), 'Accept review'));
  await until(async () => (await tasks())[0].evidence.review.status === 'accepted', 'accepted');
  $('#task-dialog').close();
  // Tests in Testing: only exit codes decide.
  await moveBy(ctx, 'Ship it', 'testing'); await ctx.idle();
  assert.equal(ctx.executor.started.at(-1).stage, 'testing');
  await ctx.executor.confirm(ctx.executor.started.at(-1).id);
  await until(async () => (await tasks())[0].evidence.tests?.status === 'passed', 'tests passed', 15000);
  // Merge: the task details also show the preview and can merge (the card has the one-click button).
  await moveBy(ctx, 'Ship it', 'merge'); await ctx.idle();
  // A revision-conflict retry can begin after idle's short quiet window. Wait for
  // the confirmed destination, not merely a gap between the asynchronous requests.
  await until(() => column($, 'merge').querySelector(`[data-id="${task.id}"]`), 'confirmed Merge column', 15000);
  assert.ok(Array.from(cardItem(ctx, 'Ship it').querySelectorAll('.kanban-move-to option'), item => item.value).includes('done'));
  cardItem(ctx, 'Ship it').querySelector('.kanban-details').click();
  await until(() => byText($('#task-details'), 'Confirm merge…'), 'merge preview', 15000);
  assert.match($('#task-details').textContent, /→ trunk:/);
  assert.match($('#task-details').textContent, /A\tshipped\.txt/);
  assert.match($('#task-details').textContent, /Nothing is pushed/);
  byText($('#task-details'), 'Confirm merge…').click();
  assert.match($('#task-details').textContent, /It is not pushed/);
  await click(ctx, byText($('#task-details'), 'Confirm merge'));
  await until(async () => (await tasks())[0].column === 'done', 'merged into Done');
  const done = (await tasks())[0];
  assert.equal(done.completion.kind, 'merged');
  assert.equal(execFileSync('git', ['rev-parse', 'trunk'], { cwd: ctx.repo, encoding: 'utf8' }).trim(), done.completion.mergedCommit);
  assert.deepEqual(titles($, 'done'), ['Ship it']);
  assert.ok(win.document.querySelector('#announcement').textContent.includes('Merged into trunk and verified'));
});

test('a folder that is not a Git repository is set up only after confirmation; its files are never committed', { skip: process.platform === 'win32' }, async t => {
  const saved = Object.fromEntries(['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' });
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pb-ui-plain-')));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await writeFile(join(dir, 'notes.txt'), 'private notes\n');
  const ctx = await setup(t);
  const { $ } = ctx;
  await goTo(ctx, '#/kanban');
  await newProject(ctx, 'Fresh');
  $('#repo-path').value = dir; submitForm(ctx, '#repo-form'); await ctx.idle();
  const offer = $('#repo-setup');
  assert.match(offer.textContent, /run git init and make one empty commit named “Initial commit”/);
  assert.match(offer.textContent, /Your files are not added or committed/);
  await assert.rejects(readFile(join(dir, '.git', 'HEAD')), 'Nothing happens before the user confirms.');
  await click(ctx, [...offer.querySelectorAll('button')].find(button => button.textContent === 'Set up Git here'));
  assert.match($('#repo-state').textContent, new RegExp(`Linked to ${dir}`));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  assert.equal(git('rev-list', '--count', 'HEAD'), '1');
  assert.equal(git('log', '-1', '--format=%s'), 'Initial commit');
  assert.equal(git('ls-tree', '-r', '--name-only', 'HEAD'), '', 'The first commit is empty.');
  assert.equal(git('status', '--porcelain'), '?? notes.txt', 'User files stay untracked.');
});

test('when browser storage is full, the oldest prompts are dropped so the newest one is still saved', async t => {
  const storage = Array.from({ length: 30 }, (_, index) => ({ id: `old-${index}`, input: `Old request ${index} ${'x'.repeat(200)}`, prompt: `Old prompt ${index}`, createdAt: 1790000000000 - index, provider: 'codex' }));
  const { $, win, submit, requests } = await setup(t, { storage, generationResponse: { prompt: 'Add a test.', verification: report() } });
  const setItem = win.Storage.prototype.setItem;
  // Room for about ten entries.
  win.Storage.prototype.setItem = function (key, value) { if (key === 'ste-prompt-engineer.history.v1' && value.length > 3500) throw new win.DOMException('Storage is full.', 'QuotaExceededError'); return setItem.call(this, key, value); };
  $('#prompt-input').value = 'Add a test.'; submit();
  await until(() => !$('#generate-button').disabled && requests.length === 1, 'result');
  const saved = JSON.parse(win.localStorage.getItem('ste-prompt-engineer.history.v1'));
  assert.ok(saved.length > 1 && saved.length < 31, `Some older prompts were dropped (${saved.length} kept).`);
  assert.equal(saved[0].prompt, 'Add a test.', 'The newest prompt is kept.');
  assert.equal(saved.at(-1).id, `old-${saved.length - 2}`, 'The oldest prompts go first.');
  assert.equal($('#storage-warning').hidden, true);
  assert.match($('#announcement').textContent, new RegExp(`the ${31 - saved.length} oldest prompts were removed from history`));
  assert.equal($('#history-list').children.length, saved.length);
});

test('Open folder… turns a chosen folder into a linked project, sets up Git when needed without adding files, and reuses a known folder', { skip: process.platform === 'win32' }, async t => {
  const repo = await gitRepo(t);
  const plain = await realpath(await mkdtemp(join(tmpdir(), 'pb-ui-open-')));
  t.after(() => rm(plain, { recursive: true, force: true }));
  await writeFile(join(plain, 'mine.txt'), 'my file\n');
  const picks = [{ path: `${repo}/` }, { path: plain }, { cancelled: true }, { path: repo }];
  const ctx = await setup(t, { folderPicker: async () => picks.shift() });
  const { $, win } = ctx;
  await goTo(ctx, '#/kanban');
  const names = () => [...$('#workspace-list').querySelectorAll('.workspace-name')].map(item => item.textContent);
  // A Git repository becomes a linked project named after its folder.
  await click(ctx, $('#workspace-open'));
  await until(() => $('#repo-state').textContent.includes(`Linked to ${repo}`), 'project created and linked');
  const repoName = repo.split('/').pop();
  assert.deepEqual(names(), [repoName]);
  // A folder without Git becomes a linked project too: git init and one empty first commit. Its files are not added.
  await click(ctx, $('#workspace-open'));
  await until(() => names().length === 2 && $('#repo-state').textContent.includes(`Linked to ${plain}`), 'second project, Git set up');
  assert.equal($('#project-select').selectedOptions[0].textContent, plain.split('/').pop());
  assert.equal(gitIn(plain, 'log', '--format=%s'), 'Initial commit');
  assert.equal(gitIn(plain, 'status', '--porcelain'), '?? mine.txt', 'The user\'s file is not committed.');
  assert.match($('#announcement').textContent, /Git was set up there with an empty first commit; your files were not added/);
  // Cancelling the picker changes nothing; a folder that a project already uses is selected, not duplicated.
  await click(ctx, $('#workspace-open'));
  assert.equal(names().length, 2);
  await click(ctx, $('#workspace-open'));
  await until(() => $('#project-select').selectedOptions[0].textContent === repoName, 'existing project selected');
  assert.equal(names().length, 2);
  assert.match($('#announcement').textContent, /already uses this folder/);
});

test('without a system folder picker, Open folder… asks for the path instead', { skip: process.platform === 'win32' }, async t => {
  const repo = await gitRepo(t);
  const { BoardError } = await import('../src/board.mjs');
  const ctx = await setup(t, { folderPicker: async () => { throw new BoardError('No picker.', 'PICKER_UNAVAILABLE', 501); } });
  const { $ } = ctx;
  await goTo(ctx, '#/kanban');
  await click(ctx, $('#workspace-open'));
  assert.equal($('#workspace-path-form').hidden, false);
  $('#workspace-path').value = 'relative/path'; submitForm(ctx, '#workspace-path-form'); await ctx.idle();
  assert.match($('#workspace-path-error').textContent, /absolute path/);
  $('#workspace-path').value = repo; submitForm(ctx, '#workspace-path-form');
  await until(() => $('#workspace-list').querySelectorAll('.workspace-item').length === 1, 'project from typed path');
  assert.equal($('#workspace-path-form').hidden, true);
  await until(() => $('#repo-state').textContent.includes(`Linked to ${repo}`), 'linked from typed path');
});

test('Testing starts its agent on arrival and verifies commands after confirmation; Merge needs its button; one click merges', { skip: process.platform === 'win32' }, async t => {
  const ctx = await linkedKanban(t);
  const { $, win } = ctx;
  await link(ctx);
  const board = ctx.app.board;
  const created = await board.createTask({ projectId: ctx.project.id, title: 'Checked', prompt: 'Add input checks.' });
  await board.moveTask(created.id, { column: 'executing', expectedRevision: 1 });
  const ws = (await board.ensureTaskWorktree(created.id)).path;
  await writeFile(join(ws, 'checks.txt'), 'checks\n');
  await board.delivery.commit(created.id, { message: 'checks', confirm: true });
  const current = async () => (await serverBoard(ctx)).projects[0].tasks.find(task => task.id === created.id);
  await board.moveTask(created.id, { column: 'code_review', expectedRevision: (await current()).revision });
  const head = (await board.delivery.revision(created.id)).taskCommit;
  await board.delivery.recordReview({ id: 'review-run', taskId: created.id, review: { taskCommit: head }, promptRevision: 1 }, '```json\n{"verdict":"no_issues","findings":[]}\n```');
  await board.delivery.setTestCommands(ctx.project.id, { commands: [{ command: `${process.execPath} -e "0"` }], expectedRevision: (await serverBoard(ctx)).projects[0].revision });
  // Dropping on Testing runs the project's tests at once.
  await win.__pbTest.loadBoard(); await ctx.idle();
  await moveBy(ctx, 'Checked', 'testing'); await ctx.idle();
  assert.match($('#announcement').textContent, /started the Testing agent/);
  assert.equal(ctx.executor.started.at(-1).stage, 'testing');
  await ctx.executor.confirm(ctx.executor.started.at(-1).id);
  await until(async () => (await current()).evidence?.tests?.status === 'passed', 'tests passed');
  await win.__pbTest.loadBoard(); await ctx.idle();
  const card = () => cardItem(ctx, 'Checked');
  assert.equal(card().querySelector('.kanban-deliver').textContent, 'Run tests again');
  assert.equal(card().querySelector('.kanban-start').textContent, 'Start testing agent');
  await click(ctx, card().querySelector('.kanban-start'));
  assert.equal(ctx.executor.started.at(-1).stage, 'testing');
  assert.equal(ctx.executor.started.at(-1).config.permissionMode, 'acceptEdits', 'The testing agent can edit in the worktree.');
  await board.updateRun(ctx.executor.started.at(-1).id, { status: 'running' });
  await ctx.executor.cancel(ctx.executor.started.at(-1).id);
  // Merge: entering verifies; the card shows one merge button and a pull request button.
  await win.__pbTest.loadBoard(); await ctx.idle();
  await moveBy(ctx, 'Checked', 'merge'); await ctx.idle();
  assert.match(card().textContent, /Ready to merge into trunk\./);
  assert.equal(card().querySelector('.kanban-merge').textContent, 'Merge trunk');
  assert.equal(card().querySelector('.kanban-pr').textContent, 'Open pull request');
  await click(ctx, card().querySelector('.kanban-merge'));
  const done = await current();
  assert.deepEqual([done.column, done.completion.kind, done.completion.trigger], ['done', 'merged', 'user']);
  assert.match($('#announcement').textContent, /Merged “Checked” into trunk\. The card is Done/);
});

test('Autopilot dialog: queue order, which cards, per-card routes, consent to start, and a live status bar', { skip: process.platform === 'win32' }, async t => {
  const ctx = await linkedKanban(t);
  const { $, win } = ctx;
  await link(ctx);
  for (const title of ['Alpha', 'Beta', 'Gamma']) await ctx.app.board.createTask({ projectId: ctx.project.id, title, prompt: `Do ${title}.` });
  await win.__pbTest.loadBoard(); await ctx.idle();
  $('#autopilot-open').click(); await ctx.idle();
  assert.equal($('#autopilot-dialog').open, true);
  const items = () => [...$('#autopilot-queue').querySelectorAll('.autopilot-item')];
  const names = () => items().map(item => item.querySelector('.autopilot-title').textContent);
  assert.deepEqual(names(), ['Alpha', 'Beta', 'Gamma'], 'To Do cards in board order, all included the first time.');
  // Gamma first; Beta left out; Alpha skips Planning and Testing via its own route (Merge becomes a pull request).
  items()[2].querySelector('.autopilot-up').click(); items()[1].querySelector('.autopilot-up').click();
  assert.deepEqual(names(), ['Gamma', 'Alpha', 'Beta']);
  const beta = items()[2].querySelector('input[type="checkbox"]'); beta.checked = false; beta.dispatchEvent(new win.Event('change'));
  $('#autopilot-finish').value = 'pull_request'; $('#autopilot-finish').dispatchEvent(new win.Event('change'));
  for (const stage of ['planning', 'testing']) { const chip = items()[1].querySelector(`.route-chip[data-stage="${stage}"] input`); chip.checked = false; chip.dispatchEvent(new win.Event('change')); }
  assert.equal(items()[1].querySelector('.autopilot-custom').textContent, 'Own route');
  assert.equal(items()[0].querySelector('.route-chip[data-stage="executing"] input').disabled, true, 'Executing is always in the route.');
  // Starting needs the explicit acknowledgment.
  submitForm(ctx, '#autopilot-form'); await ctx.idle();
  assert.match($('#autopilot-error').textContent, /Confirm that you understand/);
  $('#autopilot-consent').checked = true;
  // A route that merges without Testing breaks the stage contract, so the server refuses it with the reason.
  submitForm(ctx, '#autopilot-form'); await ctx.idle();
  assert.match($('#autopilot-error').textContent, /Merge must include Code Review and Testing/);
  assert.equal($('#autopilot-dialog').open, true);
  for (const [stage, on] of [['testing', true], ['merge', false]]) { const chip = items()[1].querySelector(`.route-chip[data-stage="${stage}"] input`); chip.checked = on; chip.dispatchEvent(new win.Event('change')); }
  submitForm(ctx, '#autopilot-form'); await ctx.idle();
  assert.equal($('#autopilot-dialog').open, false);
  const project = (await serverBoard(ctx)).projects[0];
  const id = title => project.tasks.find(task => task.title === title).id;
  assert.deepEqual(project.autopilot.queue, [id('Gamma'), id('Alpha')]);
  assert.deepEqual(project.autopilot.routes, { [id('Alpha')]: ['executing', 'code_review', 'testing'] });
  assert.equal(project.autopilot.finish, 'pull_request');
  assert.equal(project.autopilot.status, 'running');
  // The engine picks Gamma first; the bar and the card show it.
  await win.__pbTest.loadBoard(); await ctx.idle();
  for (const end = Date.now() + 10000; !/Autopilot is working on “Gamma”/.test($('#autopilot-bar').textContent);) {
    if (Date.now() > end) assert.fail(`Timed out: status bar (${$('#autopilot-bar').textContent})`);
    await new Promise(resolve => setTimeout(resolve, 200));
    await win.__pbTest.loadBoard(); await ctx.idle();
  }
  assert.equal(cardItem(ctx, 'Gamma').querySelector('.autopilot-tag').textContent, 'Autopilot · now');
  assert.equal(cardItem(ctx, 'Alpha').querySelector('.autopilot-tag').textContent, 'Autopilot · #1');
  assert.equal(cardItem(ctx, 'Beta').querySelector('.autopilot-tag'), null);
  // Pause from the bar; settings stay editable only while not running.
  [...$('#autopilot-bar').querySelectorAll('button')].find(button => button.textContent === 'Pause').click(); await ctx.idle();
  await until(() => /Autopilot paused: Paused by you/.test($('#autopilot-bar').textContent), 'paused bar');
  assert.ok([...$('#autopilot-bar').querySelectorAll('button')].some(button => button.textContent === 'Resume'));
});

// ---- Agents sidebar and dock tabs ----

async function agentFixture(t) {
  const ctx = await linkedKanban(t);
  ctx.executor.subscribe = (_runId, _after, sink) => {
    // Keep the fake session live, but flush the response with a harmless heartbeat.
    // Otherwise each fixture waits for the server's 15s keepalive before fetch resolves.
    sink.write({ ping: true });
    return () => {};
  };
  await newProject(ctx, 'Other');
  const board = ctx.app.board;
  const [flow, other] = (await serverBoard(ctx)).projects;
  const task = async (project, title) => (await board.createTask({ projectId: project.id, title, prompt: `Do ${title}.` })).id;
  const tasks = { a: await task(flow, 'Auth middleware'), b: await task(flow, 'API tests'), c: await task(other, 'Review docs') };
  const now = Date.now();
  const run = (id, taskId, projectId, stage, status, config) => ({ id, taskId, projectId, stage, status, createdAt: now - 5000, updatedAt: now, startedAt: now - 5000, turns: 0,
    config, branch: `promptboard/${id}`, workspacePath: `/tmp/wt-${id}`, artifactsDir: `runs/${id}` });
  await board.store.update(draft => {
    draft.runs.push(run('run-a', tasks.a, flow.id, 'executing', 'running', { provider: 'claude', model: 'opus', effort: 'high' }),
      run('run-b', tasks.b, flow.id, 'code_review', 'waiting_for_input', { provider: 'codex', model: 'gpt-5.5', effort: '' }),
      run('run-c', tasks.c, other.id, 'planning', 'queued', { provider: 'claude', model: '', effort: '' }));
  });
  // Show the Flow project.
  ctx.win.localStorage.setItem('promptboard.kanban.project', flow.id);
  await ctx.win.__pbTest.loadBoard(); await ctx.idle();
  return { ...ctx, tasks, flow, other };
}
const agentRows = ({ $ }) => Array.from($('#agents-list').querySelectorAll('.agent-item'));

test('the Agents sidebar shows real runs with provider, model, stage, and state; selecting one opens its project, card, and terminal', { skip: process.platform === 'win32' }, async t => {
  const ctx = await agentFixture(t);
  const { $, win } = ctx;
  assert.equal($('#workspace-panel').hidden, false);
  assert.equal($('#history-panel').hidden, true, 'Agents belong to the Kanban sidebar only.');
  // This project: the waiting agent first, then the active one.
  let rows = agentRows(ctx);
  assert.deepEqual(rows.map(row => row.querySelector('.agent-title').textContent), ['API tests', 'Auth middleware']);
  assert.match(rows[0].textContent, /Codex CLI · gpt-5\.5/);
  assert.match(rows[0].textContent, /Code Review · Awaits you/);
  assert.equal(rows[0].querySelector('.agent-icon').textContent, '!');
  assert.match(rows[0].getAttribute('aria-label'), /Awaits you/, 'State is in text and the accessible name, not colour alone.');
  assert.match(rows[1].textContent, /Claude Code · opus · high/);
  assert.match(rows[1].textContent, /Executing · Active/);
  assert.equal($('#agents-count').textContent, '02');
  assert.match(cardItem(ctx, 'API tests').textContent, /Code Review · AWAITS YOU/);
  assert.match(cardItem(ctx, 'Auth middleware').textContent, /Claude Code · opus · high/);
  assert.match(cardItem(ctx, 'Auth middleware').textContent, /Working…/);
  // All projects: the queued run of the other project is On hold and names its project.
  $('#agents-filter').value = 'all'; $('#agents-filter').dispatchEvent(new win.Event('change'));
  rows = agentRows(ctx);
  assert.equal(rows.length, 3);
  const queued = rows.find(row => row.dataset.runId === 'run-c');
  assert.match(queued.textContent, /Planning · On hold/);
  assert.match(queued.textContent, /Claude Code · CLI default model/);
  assert.match(queued.textContent, /Project: Other/);
  assert.equal(win.localStorage.getItem('promptboard.agents.filter'), 'all');
  // Selecting it switches project and opens its existing run in the dock. No run starts.
  queued.click(); await ctx.idle();
  assert.equal($('#project-select').value, ctx.other.id);
  assert.ok(cardItem(ctx, 'Review docs').classList.contains('agent-focus'));
  assert.equal(win.promptboardDock.selected, 'run-c');
  assert.equal(ctx.executor.started.length, 0, 'Selecting an agent never starts a run.');
  // A finished run becomes Inactive; a reload shows each run once.
  await ctx.app.board.updateRun('run-a', { status: 'succeeded', endedAt: Date.now() });
  await win.__pbTest.loadBoard(); await ctx.idle();
  await win.__pbTest.loadBoard(); await ctx.idle();
  rows = agentRows(ctx);
  assert.equal(rows.length, 3);
  assert.match(rows.find(row => row.dataset.runId === 'run-a').textContent, /Inactive · succeeded/);
  assert.equal($('#agents-count').textContent, '02');
});

test('dock tabs: one per run with state and model; switching never restarts; closing a tab never stops the agent', { skip: process.platform === 'win32' }, async t => {
  const ctx = await agentFixture(t);
  const { $, win } = ctx;
  const tabs = () => Array.from($('#dock-tabs').querySelectorAll('.dock-tab:not(#dock-tab-activity)'));
  assert.deepEqual(tabs().map(tab => tab.id).sort(), ['dock-tab-run-a', 'dock-tab-run-b', 'dock-tab-run-c']);
  const b = $('#dock-tab-run-b');
  assert.match(b.textContent, /API tests · Codex CLI · gpt-5\.5/);
  assert.equal(b.dataset.state, 'awaits_you');
  assert.match(b.getAttribute('aria-label'), /Codex CLI · gpt-5\.5: Awaits you/);
  assert.equal($('#dock-tab-run-a').dataset.state, 'active');
  assert.equal($('#dock-tab-run-c').dataset.state, 'on_hold');
  const sessionA = win.promptboardDock.sessions.get('run-a');
  $('#dock-tab-run-b').click(); $('#dock-tab-run-a').click(); await ctx.idle();
  assert.equal(win.promptboardDock.sessions.get('run-a'), sessionA, 'Switching tabs keeps the same session.');
  assert.match($('#dock-details .dock-run-summary').textContent, /Claude Code · opus · high · Executing · Active/);
  assert.match($('#dock-details .dock-location').textContent, /Task branchpromptboard\/run-a.*Worktree\/tmp\/wt-run-a/);
  assert.equal($('#dock-indicator').textContent, '1 waiting for you');
  // Close the active tab: the run keeps its status, the indicator still counts it, a reload does not reopen it.
  $('#dock-tab-run-a .tab-close').click(); await ctx.idle();
  assert.equal($('#dock-tab-run-a'), null);
  assert.equal((await ctx.app.board.run('run-a')).status, 'running', 'Closing a tab does not stop the agent.');
  await win.__pbTest.loadBoard(); await ctx.idle();
  assert.equal($('#dock-tab-run-a'), null);
  assert.equal(tabs().length, 2, 'Reloading the board does not duplicate tabs.');
  // Selecting the agent again reopens its tab.
  $('#agents-list [data-run-id="run-a"]').click(); await ctx.idle();
  assert.ok($('#dock-tab-run-a'));
  assert.equal(win.promptboardDock.selected, 'run-a');
  assert.equal(ctx.executor.started.length, 0);
});

test('Kanban project and stage agent selection is visible, persists, and launches the selected provider independently of Compose', { skip: process.platform === 'win32' }, async t => {
  const ctx = await linkedKanban(t);
  const { $, win, choose } = ctx;
  await link(ctx);
  if (!$('#project-body').hidden) $('#project-toggle').click();
  assert.equal($('#project-body').hidden, true);
  assert.equal($('#project-settings').hidden, true, 'All project controls collapse outside the board.');
  $('#project-toggle').click();
  assert.equal($('#project-settings').hidden, false);
  assert.ok($('#project-settings').contains($('#project-agent-form')));
  assert.ok(!$('.kanban-board').contains($('#project-settings')));
  assert.equal($('#project-agent-panel').hidden, true);
  assert.equal($('#project-location').hidden, true);
  $('#project-files-toggle').click();
  assert.equal($('#project-location').hidden, false);
  $('#project-agent-toggle').click();
  assert.equal($('#project-agent-panel').hidden, false);
  assert.match($('#project-location').textContent, new RegExp(ctx.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match($('#project-location').textContent, /Target branchtrunk/);
  choose('#project-agent-fields [data-field="provider"]', 'codex');
  await ctx.idle();
  choose('#project-agent-fields [data-field="model"]', 'codex-two');
  assert.deepEqual(Array.from($('#project-agent-fields [data-field="effort"]').options, item => item.value), ['', 'low']);
  choose('#project-agent-fields [data-field="effort"]', 'low');
  await win.__pbTest.loadBoard();
  assert.equal($('#project-agent-fields [data-field="model"]').value, 'codex-two', 'Background board refresh preserves unsaved selections.');
  submitForm(ctx, '#project-agent-form'); await ctx.idle();
  let project = (await serverBoard(ctx)).projects[0];
  assert.deepEqual(project.agentDefaults, { provider: 'codex', model: 'codex-two', effort: 'low' });
  assert.equal(project.effectiveWorkflow.executing.provider, 'codex');
  assert.match($('#kanban-columns [data-column="executing"] .column-agent').textContent, /Codex CLI · codex-two · low/);
  // Each stage has a direct settings shortcut, with an independent provider and model.
  $('#kanban-columns [data-column="code_review"] .column-agent').click(); await ctx.idle();
  const review = '#workflow-stages [data-stage="code_review"]';
  assert.equal(win.document.activeElement, $(`${review} [data-field="provider"]`));
  choose(`${review} [data-field="provider"]`, 'claude'); await ctx.idle();
  choose(`${review} [data-field="model"]`, 'haiku');
  assert.equal($(`${review} [data-field="effort"]`).disabled, true);
  submitForm(ctx, '#workflow-form'); await ctx.idle();
  project = (await serverBoard(ctx)).projects[0];
  assert.equal(project.effectiveWorkflow.code_review.provider, 'claude');
  assert.equal(project.effectiveWorkflow.code_review.model, 'haiku');
  assert.equal(project.effectiveWorkflow.executing.provider, 'codex');
  assert.match($('#project-agent-summary').textContent, /Stage overrides: Code Review/);
  // Compose can select Claude without changing the project's Codex agent.
  choose('#provider', 'claude'); await ctx.idle();
  await newCard(ctx, 'Selected agent', 'Build the feature.');
  await moveBy(ctx, 'Selected agent', 'executing'); await ctx.idle();
  const run = ctx.executor.started.at(-1);
  assert.deepEqual([run.config.provider, run.config.model, run.config.effort], ['codex', 'codex-two', 'low']);
  assert.match(cardItem(ctx, 'Selected agent').querySelector('.run-agent').textContent, /Run agent: Codex CLI · codex-two/);
  assert.match($(`#dock-tab-${run.id}`).textContent, /Codex CLI · codex-two/);
  assert.match($('#dock-details').textContent, /Codex CLI · codex-two/);
  assert.ok($('#dock-details').textContent.includes(ctx.repo));
  assert.ok($('#dock-details').textContent.includes(run.branch));
  assert.ok($('#dock-details').textContent.includes(run.workspacePath));
  cardItem(ctx, 'Selected agent').querySelector('.card-workspace').open = true;
  const facts = cardItem(ctx, 'Selected agent').querySelector('.task-location');
  assert.ok(facts.textContent.includes(run.workspacePath));
  const copy = [...facts.querySelectorAll('button')].find(button => button.textContent === 'Copy worktree');
  copy.click(); await ctx.idle();
  assert.equal(ctx.copied(), run.workspacePath);
  const taskItem = cardItem(ctx, 'Selected agent');
  taskItem.querySelector('.kanban-more-toggle').click();
  column($, 'executing').scrollTop = 81;
  await win.__pbTest.loadBoard(); await ctx.idle();
  assert.equal(cardItem(ctx, 'Selected agent').querySelector('.card-workspace').open, true, 'Board refresh keeps open file details.');
  assert.equal(cardItem(ctx, 'Selected agent').querySelector('.kanban-more').hidden, false, 'Board refresh keeps the action menu open.');
  assert.equal(column($, 'executing').scrollTop, 81, 'Board refresh does not jump to the first card.');
  // A new default affects future runs; the existing run still identifies Codex accurately.
  $('#project-agent-toggle').click();
  choose('#project-agent-fields [data-field="provider"]', 'claude'); await ctx.idle();
  submitForm(ctx, '#project-agent-form'); await ctx.idle();
  assert.equal((await ctx.app.board.run(run.id)).config.provider, 'codex');
  assert.match($(`#dock-tab-${run.id}`).textContent, /Codex CLI/);
  const reload = await setup(t, { executor: ctx.executor, hash: '#/kanban', dataDir: ctx.dataDir }); await reload.idle();
  assert.equal(reload.$('#project-agent-fields [data-field="provider"]').value, 'claude');
  assert.match(reload.$('#kanban-columns [data-column="code_review"] .column-agent').textContent, /haiku/);
});

test('Stop stays visible from a collapsed dock, survives refresh and tab switches, retries errors, and stops only the confirmed run', { skip: process.platform === 'win32' }, async t => {
  const ctx = await agentFixture(t);
  const { $, win } = ctx;
  const cancel = ctx.executor.cancel;
  let attempts = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  ctx.executor.cancel = async runId => {
    attempts++;
    if (attempts === 1) throw new Error('Simulated stop failure.');
    await gate;
    await cancel(runId);
  };
  $('#dock-tab-run-a').click();
  if (win.promptboardDock.state !== 'collapsed') $('#dock-toggle').click();
  $('#dock-stop').click();
  const prompt = $('#dock-stop-prompt');
  assert.equal(win.promptboardDock.state, 'open');
  assert.equal(prompt.hidden, false);
  assert.equal(prompt.querySelector('button'), win.document.activeElement);
  $('#dock-toggle').click();
  assert.equal(win.promptboardDock.state, 'collapsed');
  assert.equal(prompt.hidden, false, 'Collapsing during confirmation keeps the independent Stop controls.');
  await win.__pbTest.loadBoard(); await ctx.idle();
  assert.equal(prompt.hidden, false, 'Refreshing the board does not erase the confirmation.');
  $('#dock-tab-run-b').click();
  const originalConfirmation = prompt.querySelector('button');
  $('#dock-stop').click();
  assert.equal(prompt.querySelector('button'), originalConfirmation, 'Another Stop click cannot replace a pending confirmation after switching tabs.');
  prompt.querySelector('button').click();
  await until(() => prompt.querySelector('button').textContent === 'Retry stop', 'visible stop error');
  assert.equal(prompt.hidden, false);
  const retry = prompt.querySelector('button'); retry.click(); retry.click();
  await until(() => attempts === 2, 'one retry request');
  assert.equal(retry.disabled, true);
  release();
  await until(() => prompt.hidden, 'stop completed');
  assert.equal(attempts, 2, 'Repeated clicks do not send duplicate stop requests.');
  assert.equal((await ctx.app.board.run('run-a')).status, 'cancelled');
  assert.equal((await ctx.app.board.run('run-b')).status, 'waiting_for_input', 'Switching tabs never changes the confirmed stop target.');
  assert.equal(win.promptboardDock.sessions.get('run-a').ended, true);
});

test('Run details preserve immediate disclosure changes across refreshes and tab switches', { skip: process.platform === 'win32' }, async t => {
  const ctx = await agentFixture(t);
  const { $, win } = ctx;
  $('#dock-tab-run-a').click();
  $('#dock-details .dock-context').open = true;
  win.PromptboardDock.sync(); // Native toggle events have not fired yet.
  assert.equal($('#dock-details .dock-context').open, true);
  $('#dock-tab-run-b').click();
  assert.equal($('#dock-details .dock-context').open, false, 'Disclosure is per run.');
  $('#dock-tab-run-a').click();
  assert.equal($('#dock-details .dock-context').open, true);
  $('#dock-details .dock-context').open = false;
  win.PromptboardDock.sync();
  assert.equal($('#dock-details .dock-context').open, false);
});

test('Kanban model selection keeps CLI default while discovery is pending and ignores replies after switching to inheritance', { skip: process.platform === 'win32' }, async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const ctx = await linkedKanban(t, { catalogReader: async provider => {
    if (provider === 'claude') await pending;
    return { provider, ...catalogs[provider] };
  } });
  const { $, choose, win } = ctx;
  t.after(() => release());
  await ctx.app.board.setWorkflow(ctx.project.id, { workflow: {}, agentDefaults: { provider: 'claude', model: 'saved-model' }, expectedRevision: (await serverBoard(ctx)).projects[0].revision });
  await win.__pbTest.loadBoard();
  assert.equal($('#project-agent-fields [data-field="model"]').value, '__custom__');
  choose('#project-agent-fields [data-field="model"]', '');
  release(); await ctx.idle();
  assert.equal($('#project-agent-fields [data-field="model"]').value, '', 'Discovery must not restore the saved model after the user chooses CLI default.');
  choose('#project-agent-fields [data-field="provider"]', 'codex');
  choose('#project-agent-fields [data-field="provider"]', '');
  await ctx.idle();
  assert.equal($('#project-agent-fields [data-field="provider"]').value, '');
  assert.equal($('#project-agent-fields [data-field="model"]').value, '');
  assert.equal($('#project-agent-fields .model-field').hidden, true);
  assert.equal($('#project-agent-fields [data-field="model-custom"]').value, '', 'Switching provider clears its custom model.');
});

test('ended agent output is available after a restart and remains readable without terminal graphics', { skip: process.platform === 'win32' }, async t => {
  const ctx = await linkedKanban(t);
  const { $, win } = ctx;
  await link(ctx);
  // xterm exists, but its CSP-compatible renderer is unavailable: it must use text.
  win.Terminal = class { constructor() { assert.fail('Do not use the invisible DOM renderer without WebGL.'); } };
  const task = await ctx.app.board.createTask({ projectId: ctx.project.id, title: 'Old Codex run', prompt: 'Fix it.' });
  const now = Date.now();
  await ctx.app.board.store.update(state => state.runs.push({ id: 'old-codex', taskId: task.id, projectId: ctx.project.id, stage: 'executing', status: 'interrupted', createdAt: now, updatedAt: now,
    config: { provider: 'codex', model: 'codex-one' }, branch: 'promptboard/old-task', workspacePath: '/tmp/old-worktree', artifactsDir: 'runs/old-codex' }));
  ctx.executor.artifact = async () => 'Reading parser.mjs\nChanged parser.mjs\nTests passed\n<img src=x onerror="window.__pwned=1">';
  await win.__pbTest.loadBoard(); await ctx.idle();
  cardItem(ctx, 'Old Codex run').querySelector('.kanban-terminal').click(); await ctx.idle();
  const session = win.promptboardDock.sessions.get('old-codex');
  await until(() => session.pre?.textContent.includes('Changed parser.mjs'), 'saved output rendered');
  assert.match($('#dock-details').textContent, /Codex CLI · codex-one/);
  assert.match($('#dock-connection').textContent, /Saved output/);
  assert.equal($('#dock-stop').hidden, true);
  assert.equal($('#dock-copy').hidden, true);
  assert.equal($('#dock-terminals img'), null);
  assert.equal(win.__pwned, undefined);
  assert.equal(ctx.executor.started.length, 0, 'Reading old output never restarts the agent.');
});

// ---- Settings ----

test('every visible setting is stored and changes the app; global settings stay separate from project workflow', { skip: process.platform === 'win32' }, async t => {
  const ctx = await agentFixture(t);
  const { $, win } = ctx;
  const change = (id, value) => { const el = $(id); if (el.type === 'checkbox') el.checked = value; else el.value = value; el.dispatchEvent(new win.Event('change')); };
  assert.equal($('#app-settings-open').getAttribute('aria-label'), 'Settings');
  $('#app-settings-open').click(); await ctx.idle();
  assert.equal($('#app-settings').open, true);
  assert.equal($('#set-project-name').textContent, 'Flow');
  // Theme.
  change('#set-theme', 'dark');
  assert.equal(win.document.documentElement.dataset.theme, 'dark');
  assert.equal(win.localStorage.getItem('ste-prompt-engineer.theme'), 'dark');
  change('#set-theme', 'light');
  assert.equal(win.document.documentElement.dataset.theme, 'light');
  // Global server settings.
  change('#set-max-runs', '3'); await ctx.idle();
  assert.equal((await ctx.app.board.state()).settings.maxConcurrentRuns, 3);
  // The default agent fills stages without their own provider, in every project, but never a stage a project set.
  await ctx.app.board.setWorkflow(ctx.other.id, { workflow: { executing: { policy: 'ask', provider: 'claude', model: 'haiku' } }, expectedRevision: (await ctx.app.board.state()).projects[1].revision });
  change('#set-agent-provider', 'codex'); await ctx.idle();
  change('#set-agent-model', '__custom__'); change('#set-agent-model-custom', 'gpt-test');
  $('#set-agent-save').click(); await ctx.idle();
  const view = await ctx.app.board.view();
  assert.deepEqual((await ctx.app.board.state()).settings.defaultAgent, { provider: 'codex', model: 'gpt-test', effort: '' });
  assert.equal(view.projects[0].effectiveWorkflow.executing.agentSource, 'global');
  assert.equal(view.projects[1].effectiveWorkflow.executing.agentSource, 'stage');
  assert.equal(view.projects[0].effectiveWorkflow.executing.provider, 'codex');
  assert.equal(view.projects[0].effectiveWorkflow.planning.model, 'gpt-test');
  assert.equal(view.projects[1].effectiveWorkflow.executing.provider, 'claude', 'A project stage keeps its own agent.');
  assert.equal(view.projects[1].effectiveWorkflow.executing.model, 'haiku');
  assert.equal(view.projects[1].effectiveWorkflow.planning.provider, 'codex');
  change('#set-agent-model-custom', 'bad model'); $('#set-agent-save').click(); await ctx.idle();
  assert.match($('#app-settings-error').textContent, /model ID/);
  assert.equal((await ctx.app.board.state()).settings.defaultAgent.model, 'gpt-test', 'An invalid value is refused and not stored.');
  // Browser preferences.
  change('#set-start', 'kanban'); change('#set-open-terminal', false); change('#set-keep-tabs', false); change('#set-term-font', '14'); change('#set-dock-start', 'open');
  assert.equal(win.localStorage.getItem('promptboard.settings.start-page'), 'kanban');
  assert.equal(win.localStorage.getItem('promptboard.settings.terminal-font'), '14');
  // Keep tabs off: a run that ends closes its tab (the run history stays on the board).
  win.promptboardDock.selected = 'activity';
  await ctx.app.board.updateRun('run-a', { status: 'succeeded', endedAt: Date.now() });
  await win.__pbTest.loadBoard(); await ctx.idle();
  assert.equal($('#dock-tab-run-a'), null);
  assert.equal((await ctx.app.board.run('run-a')).status, 'succeeded');
  // Close finished tabs.
  change('#set-keep-tabs', true);
  await ctx.app.board.updateRun('run-b', { status: 'cancelled' });
  await win.__pbTest.loadBoard(); await ctx.idle();
  assert.ok($('#dock-tab-run-b'));
  $('#set-clear-tabs').click();
  assert.equal($('#dock-tab-run-b'), null);
  assert.ok($('#dock-tab-run-c'), 'Live runs keep their tab.');
  // Project settings open for the current project only.
  $('#set-workflow').click(); await ctx.idle();
  assert.equal($('#app-settings').open, false);
  assert.equal($('#workflow-dialog').open, true);
  assert.match($('#workflow-dialog-project').textContent, /Flow/i);
});

test('stored settings apply on the next page load: start page, dock state, and open-terminal on run start', { skip: process.platform === 'win32' }, async t => {
  const ctx = await linkedKanban(t, { hash: '', prefs: { 'promptboard.settings.start-page': 'kanban', 'promptboard.settings.dock-start': 'open', 'promptboard.settings.open-terminal': '0' } });
  const { $, win } = ctx;
  assert.equal($('#kanban-view').hidden, false, 'The start page is Kanban.');
  assert.equal(win.location.hash, '#/kanban');
  assert.equal(win.promptboardDock.state, 'open', 'The dock opens as set.');
  await link(ctx);
  await newCard(ctx, 'Parser', 'Fix the parser.');
  win.PromptboardDock.setState('collapsed');
  await moveBy(ctx, 'Parser', 'executing'); await ctx.idle();
  assert.equal(ctx.executor.started.length, 1);
  await until(() => $(`#dock-tab-${ctx.executor.started[0].id}`), 'tab for the new run');
  assert.equal(win.promptboardDock.state, 'collapsed', 'With "open terminal" off, the dock stays collapsed.');
});

test('GitHub in Settings: status, repository search, connect a managed clone, fetch, and disconnect without signing out', { skip: process.platform === 'win32' }, async t => {
  const gh = await fakeGh(t);
  const ctx = await linkedKanban(t);
  const { $, win } = ctx;
  $('#app-settings-open').click();
  await until(() => /Connected as @octo/.test($('#set-github-group').textContent), 'GitHub status');
  assert.doesNotMatch($('#set-github-group').textContent, /Connect GitHub/, 'No sign-in button while connected.');
  const search = $('#github-search');
  search.value = 'app'; search.dispatchEvent(new win.Event('input'));
  await until(() => $('#set-github-group .github-result'), 'search results');
  assert.deepEqual(Array.from($('#set-github-group').querySelectorAll('.github-result'), b => b.textContent), ['acme/app · private · main']);
  $('#set-github-group .github-result').click();
  assert.equal($('#github-branch').value, 'main');
  byText($('#set-github-group'), 'Connect repository').click();
  await until(() => /GitHub: acme\/app \(private\) · Target: main · Remote: origin · Sync: Not fetched yet/.test($('#set-github-group').textContent), 'connected repository');
  const project = (await serverBoard(ctx)).projects[0];
  assert.match(project.repository.root, /\/clones\/acme\/app$/);
  byText($('#set-github-group'), 'Fetch').click();
  await until(() => /Sync: Up to date/.test($('#set-github-group').textContent), 'fetched');
  byText($('#set-github-group'), 'Disconnect…').click();
  byText($('#set-github-group'), 'Disconnect').click();
  await until(() => $('#github-search'), 'disconnected');
  assert.equal((await serverBoard(ctx)).projects[0].github, null);
  assert.ok(!(await gh.log()).some(args => args.includes('logout')));
  // Signed out: the sign-in button appears. Without a terminal library here, it explains the terminal command.
  await gh.setMode('none');
  byText($('#set-github-group'), 'Check connection').click();
  await until(() => byText($('#set-github-group'), 'Connect GitHub'), 'connect button');
  assert.match($('#set-github-group').textContent, /Status: Not connected/);
  assert.equal(win.localStorage.length >= 0 && Object.keys(win.localStorage).some(key => /github|token/i.test(win.localStorage.getItem(key) || '')), false, 'Nothing about GitHub is kept in browser storage.');
});

test('the dock shows usage only as the CLI reported it; context is labelled as context, not progress', { skip: process.platform === 'win32' }, async t => {
  const ctx = await agentFixture(t);
  const { $, win } = ctx;
  win.PromptboardDock.open('run-a'); await ctx.idle();
  assert.match($('#dock-details').textContent, /Usage: not reported yet/);
  assert.doesNotMatch($('#dock-details').textContent, /%/, 'No percentage without a real number.');
  await ctx.app.board.updateRun('run-a', { usage: { source: 'claude-transcript', model: 'claude-opus-5-5', inputTokens: 124000, cachedTokens: 80000, outputTokens: 19000, contextTokens: 42000, contextWindow: 0, updatedAt: Date.now() } });
  await ctx.app.board.updateRun('run-b', { usage: { source: 'codex-rollout', model: 'gpt-5.5', inputTokens: 8000, cachedTokens: 7000, outputTokens: 99, contextTokens: 15000, contextWindow: 200000, rateLimit: { usedPercent: 40 }, updatedAt: Date.now() } });
  await win.__pbTest.loadBoard(); await ctx.idle();
  assert.match($('#dock-details').textContent, /Input 124k · Cached 80k · Output 19k · Context 42k tokens · Reported model claude-opus-5-5/);
  win.PromptboardDock.open('run-b'); await ctx.idle();
  assert.match($('#dock-details').textContent, /Context 8% \(15k of 200k\) · Plan usage 40%/);
  assert.doesNotMatch($('#dock-details').textContent, /Reported model/, 'The reported model equals the requested one.');
});

test('Timeline view: one project, real events grouped by day, completed order, open the task, and add, edit, and remove notes', { skip: process.platform === 'win32' }, async t => {
  const ctx = await agentFixture(t);
  const { $, win } = ctx;
  const board = ctx.app.board;
  await board.updateRun('run-b', { status: 'cancelled', endedAt: Date.now() });
  await board.completeTask(ctx.tasks.b, { kind: 'no_changes', details: {} });
  await win.__pbTest.loadBoard(); await ctx.idle();
  $('#view-timeline').click();
  await until(() => $('#timeline-track .timeline-event'), 'timeline events');
  assert.equal($('#timeline').hidden, false);
  assert.equal($('#kanban-columns').hidden, true);
  assert.equal($('#view-timeline').getAttribute('aria-selected'), 'true');
  assert.equal($('#card-new').hidden, true);
  const text = $('#timeline-track').textContent;
  assert.match(text, /Auth middleware/);
  assert.doesNotMatch(text, /Review docs/, 'Another project’s tasks never appear.');
  assert.match(text, /Executing · Agent run/);
  assert.match(text, /Claude Code · opus · high/);
  assert.match(text, /Completed: no changes required/);
  assert.equal($('#timeline-track .timeline-order').textContent, '#1');
  assert.match($('#timeline-summary').textContent, /2 tasks · 1 completed · 2 agent runs · 0 commits/);
  assert.ok($('#timeline-track .timeline-date'));
  // Completed only.
  $('#timeline-filter').value = 'completed'; $('#timeline-filter').dispatchEvent(new win.Event('change'));
  assert.equal($('#timeline-track').querySelectorAll('.timeline-event').length, 1);
  $('#timeline-filter').value = 'key'; $('#timeline-filter').dispatchEvent(new win.Event('change'));
  // Open the related task.
  byText($('#timeline-track'), 'API tests').click(); await ctx.idle();
  assert.equal($('#task-dialog').open, true);
  $('#task-dialog').close();
  // Add a note linked to a task, edit it, remove it.
  $('#timeline-note-new').click();
  $('#note-title').value = 'Design review';
  $('#note-text').value = 'Agreed on the API.';
  $('#note-task').value = ctx.tasks.a;
  submitForm(ctx, '#timeline-note-form');
  await until(() => /Design review/.test($('#timeline-track').textContent), 'note shown');
  const noteCard = () => Array.from($('#timeline-track').querySelectorAll('.timeline-event[data-kind="note"]'))[0];
  assert.match(noteCard().textContent, /Auth middleware/);
  byText(noteCard(), 'Edit').click();
  assert.equal($('#note-title').value, 'Design review');
  $('#note-title').value = 'Design review, final';
  submitForm(ctx, '#timeline-note-form');
  await until(() => /Design review, final/.test($('#timeline-track').textContent), 'note edited');
  byText(noteCard(), 'Remove').click();
  byText(noteCard(), 'Remove note').click();
  await until(() => !noteCard(), 'note removed');
  assert.equal((await board.state()).projects[0].timelineNotes.length, 0);
  // System events cannot be edited.
  assert.equal(byText($('#timeline-track'), 'Edit'), undefined);
  // The view choice persists; Board brings the columns back.
  assert.equal(win.localStorage.getItem('promptboard.project-view'), 'timeline');
  $('#view-board').click();
  assert.equal($('#kanban-columns').hidden, false);
  assert.equal($('#timeline').hidden, true);
});

test('rapid drops and repeated clicks start exactly one run', { skip: process.platform === 'win32' }, async t => {
  const ctx = await linkedKanban(t);
  const { $, win } = ctx;
  await link(ctx);
  await newCard(ctx, 'Fast', 'Drop me twice.');
  await newCard(ctx, 'Clicked', 'Start me once.');
  // Two drops of the same card send one move and start one run.
  for (let i = 0; i < 2; i++) {
    cardItem(ctx, 'Fast').dispatchEvent(new win.Event('dragstart', { bubbles: true }));
    column($, 'executing').dispatchEvent(new win.Event('drop', { bubbles: true, cancelable: true }));
  }
  await ctx.idle();
  assert.deepEqual(titles($, 'executing'), ['Fast']);
  assert.equal(ctx.executor.started.length, 1);
  assert.equal((await serverTasks(ctx)).find(task => task.title === 'Fast').transitions.length, 1);
  // Two clicks on a card's Start button: one run (the second is refused because the card has an active run).
  await ctx.app.board.setWorkflow(ctx.project.id, { workflow: { planning: { policy: 'manual' } }, expectedRevision: (await serverBoard(ctx)).projects[0].revision });
  await win.__pbTest.loadBoard(); await ctx.idle();
  await moveBy(ctx, 'Clicked', 'planning'); await ctx.idle();
  const start = cardItem(ctx, 'Clicked').querySelector('.kanban-start');
  start.click(); start.click();
  await ctx.idle();
  assert.equal(ctx.executor.started.length, 2);
  assert.deepEqual(ctx.executor.started.map(run => run.stage), ['executing', 'planning']);
});

test('“How your data is used” describes the current app in four short sections', async t => {
  const { $ } = await setup(t);
  $('#privacy-help').click();
  assert.equal($('#help-dialog').open, true);
  assert.deepEqual(Array.from($('#dialog-content').querySelectorAll('h3'), heading => heading.textContent), ['Saved on this computer', 'Sent to your AI provider', 'Accounts and costs', 'What Promptboard does not do']);
  const text = $('#dialog-content').textContent;
  assert.match(text, /when you approve a stage \(or it starts automatically\), the agent CLI gets the card text/);
  assert.doesNotMatch(text, /not active yet|does not send cards/, 'No outdated statement about agent runs.');
});

test('Split into tasks (optional): ordered, editable tasks become To Do cards, then Autopilot opens with them first', { skip: process.platform === 'win32' }, async t => {
  const tasks = [{ title: 'Add the parser', prompt: 'Add `src/parser.ts`.' }, { title: 'Test the parser', prompt: 'Test `src/parser.ts`.' }, { title: 'Write docs', prompt: 'Document the parser.' }];
  const ctx = await linkedKanban(t, { hash: '', runner: request => ({ text: request.prompt.startsWith('# Task split') ? JSON.stringify({ tasks }) : 'Add, test, and document `src/parser.ts`.', reportedModels: ['m'] }) });
  const { $, win, submit, calls } = ctx;
  await goTo(ctx, '#/');
  $('#prompt-input').value = 'Build a parser with tests and docs.'; submit();
  await until(() => $('#prompt-output').textContent.includes('src/parser.ts') && !$('#split-button').disabled, 'prompt');
  $('#prompt-edit').click();
  const editedPrompt = '  Add, test, and document `src/parser.ts`.\nPreserve this edited requirement.  ';
  $('#prompt-edit-text').value = editedPrompt; $('#prompt-edit-save').click();
  $('#split-button').click();
  await until(() => $('#split-list').children.length === 3, 'task list');
  assert.equal(calls.filter(call => call.prompt.startsWith('# Task split')).length, 1, 'One CLI call.');
  assert.equal(JSON.parse(calls.find(call => call.prompt.startsWith('# Task split')).prompt.split('# Source data\n')[1]).prompt, editedPrompt, 'Split receives the saved edited prompt exactly.');
  assert.match($('#split-status').textContent, /3 tasks, in the order they run/);
  // Reorder: "Write docs" first; leave out "Test the parser"; edit a title.
  $('#split-list').children[2].querySelector('.split-up').click();
  $('#split-list').children[1].querySelector('.split-up').click();
  const items = () => [...$('#split-list').children];
  assert.deepEqual(items().map(item => item.querySelector('.split-title').value), ['Write docs', 'Add the parser', 'Test the parser']);
  const exclude = items()[2].querySelector('input[type="checkbox"]'); exclude.checked = false; exclude.dispatchEvent(new win.Event('change'));
  const title = items()[1].querySelector('.split-title'); title.value = 'Add the parser module'; title.dispatchEvent(new win.Event('input'));
  assert.match($('#split-add').textContent, /Add 2 cards to To Do/);
  submitForm(ctx, '#split-form');
  await until(() => $('#autopilot-dialog').open, 'Autopilot opened');
  const cards = (await serverTasks(ctx)).filter(task => task.column === 'todo');
  assert.deepEqual(cards.map(card => card.title), ['Write docs', 'Add the parser module']);
  assert.equal(cards[1].prompt, 'Add `src/parser.ts`.');
  assert.equal(cards[0].source.provider, 'codex', 'Each card keeps its Compose source.');
  // Autopilot lists the new cards first, included, in that order; nothing starts without consent.
  const queue = [...$('#autopilot-queue').querySelectorAll('.autopilot-item')];
  assert.deepEqual(queue.map(item => item.querySelector('.autopilot-title').textContent).slice(0, 2), ['Write docs', 'Add the parser module']);
  assert.ok(queue.slice(0, 2).every(item => item.querySelector('input[type="checkbox"]').checked));
  assert.equal((await serverBoard(ctx)).projects[0].autopilot?.status ?? 'off', 'off');
});

test('Column Manager: add, name, colour, reorder, and remove custom columns; built-in stages stay fixed; the board and moves follow', { skip: process.platform === 'win32' }, async t => {
  const ctx = await linkedKanban(t);
  const { $, win } = ctx;
  await link(ctx);
  await newCard(ctx, 'Card', 'Do it.');
  await click(ctx, $('#columns-open'));
  assert.equal($('#columns-dialog').open, true);
  const rows = () => [...$('#columns-list').querySelectorAll('.columns-item span')].map(item => item.textContent);
  assert.deepEqual(rows(), ['To Do', 'Planning', 'Executing', 'Code Review', 'Testing', 'Merge', 'Done']);
  assert.equal($('#columns-list').querySelectorAll('.columns-lock').length, 7, 'Built-in stages are fixed.');
  // Select Executing, add a column after it, name it, pick a colour, turn on its agent.
  [...$('#columns-list').querySelectorAll('.columns-item')][2].click();
  $('#columns-add').click();
  const name = $('#column-name'); name.value = 'Blocked'; name.dispatchEvent(new win.Event('input'));
  const red = $('#columns-editor input[value="red"]'); red.checked = true; red.dispatchEvent(new win.Event('change'));
  assert.match($('#columns-editor').textContent, /Cards reach this column from Executing/);
  $('#columns-add').click();
  const second = $('#column-name'); second.value = 'Docs'; second.dispatchEvent(new win.Event('input'));
  const agent = $('#column-agent'); agent.checked = true; agent.dispatchEvent(new win.Event('change'));
  const instructions = $('#column-instructions'); instructions.value = 'Update the docs.'; instructions.dispatchEvent(new win.Event('input'));
  assert.deepEqual(rows(), ['To Do', 'Planning', 'Executing', 'Blocked', 'Docs', 'Code Review', 'Testing', 'Merge', 'Done']);
  // Reorder: Docs to the left of Blocked. Hide Planning.
  [...$('#columns-list').querySelectorAll('.columns-row')][4].querySelector('button[aria-label^="Move left"]').click();
  assert.deepEqual(rows().slice(3, 5), ['Docs', 'Blocked']);
  [...$('#columns-list').querySelectorAll('.columns-item')][1].click();
  const show = $('#column-show'); show.checked = false; show.dispatchEvent(new win.Event('change'));
  submitForm(ctx, '#columns-form'); await ctx.idle();
  assert.equal($('#columns-dialog').open, false);
  const project = (await serverBoard(ctx)).projects[0];
  assert.deepEqual(project.columns.map(column => column.title), ['To Do', 'Executing', 'Docs', 'Blocked', 'Code Review', 'Testing', 'Merge', 'Done']);
  assert.deepEqual([...$('#kanban-columns').querySelectorAll('.kanban-column')].map(column => column.querySelector('h3').textContent), ['To Do', 'Executing', 'Docs', 'Blocked', 'Code Review', 'Testing', 'Merge', 'Done']);
  assert.ok([...$('#kanban-columns').querySelectorAll('.kanban-column')][3].classList.contains('col-red'));
  // The stage menu follows the moves: from To Do only Executing (Planning is hidden).
  assert.deepEqual(Array.from(cardItem(ctx, 'Card').querySelectorAll('.kanban-move-to option'), item => item.textContent), ['Move to…', 'Executing']);
  // Removing a column that holds a card is refused with the reason.
  const card = (await serverTasks(ctx))[0];
  await ctx.app.board.moveTask(card.id, { column: 'executing', expectedRevision: card.revision });
  const blocked = project.columns.find(column => column.title === 'Blocked').id;
  const moved = (await serverTasks(ctx))[0];
  await ctx.app.board.moveTask(moved.id, { column: blocked, expectedRevision: moved.revision });
  await win.__pbTest.loadBoard(); await ctx.idle();
  await click(ctx, $('#columns-open'));
  [...$('#columns-list').querySelectorAll('.columns-item')].find(item => item.textContent.startsWith('Blocked')).click();
  $('#columns-remove').click();
  submitForm(ctx, '#columns-form'); await ctx.idle();
  assert.match($('#columns-error').textContent, /Move the cards out first \(1 in Blocked\)/);
  assert.equal($('#columns-dialog').open, true);
});

test('Start over in task details: says exactly what happens, takes a reason, and can start Executing at once', { skip: process.platform === 'win32' }, async t => {
  const ctx = await linkedKanban(t);
  const { $ } = ctx;
  await link(ctx);
  const board = ctx.app.board;
  await board.setWorkflow(ctx.project.id, { workflow: { executing: { policy: 'manual' } }, expectedRevision: (await serverBoard(ctx)).projects[0].revision });
  const created = await board.createTask({ projectId: ctx.project.id, title: 'Redo', prompt: 'Do it again.' });
  await board.moveTask(created.id, { column: 'executing', expectedRevision: 1 });
  const ws = await board.ensureTaskWorktree(created.id);
  await writeFile(join(ws.path, 'a.txt'), 'first try\n');
  await ctx.win.__pbTest.loadBoard(); await ctx.idle();
  cardItem(ctx, 'Redo').querySelector('.kanban-details').click();
  await until(() => $('#task-details .start-over-open'), 'Start over section');
  await click(ctx, $('#task-details .start-over-open'));
  const text = $('#task-details').textContent;
  assert.match(text, new RegExp(`The branch ${ws.branch.replace(/[/.]/g, '\\$&')} stays exactly as it is \\(0 commits\\)\\. It is not deleted, reset, or pushed\\.`));
  assert.match(text, /1 uncommitted change will be committed to that branch first, so nothing is lost\./);
  assert.match(text, /The card goes to To Do\. Its next run starts a new branch from the current trunk\./);
  $('#start-over-reason').value = 'Wrong file.';
  $('#start-over-now').checked = true;
  await click(ctx, $('#task-details .start-over-confirm'));
  await until(() => !$('#task-dialog').open, 'dialog closed');
  const card = (await serverTasks(ctx))[0];
  assert.deepEqual([card.column, card.previousAttempts[0].reason, card.previousAttempts[0].branch], ['executing', 'Wrong file.', ws.branch]);
  assert.equal(ctx.executor.started.length, 1, 'Start Executing right away started one run.');
  assert.notEqual(ctx.executor.started[0].branch, ws.branch);
  assert.match($('#announcement').textContent, /Started “Redo” over\. Executing started on a fresh branch/);
});


test('To Do prompt entry creates an exact task and optionally sends a draft to Composer', async t => {
  const ctx = await setup(t, { hash: '#/kanban' });
  const { $, win } = ctx;
  await newProject(ctx, 'Prompt entry');
  $('.kanban-add-task').click();
  assert.equal(win.document.activeElement.id, 'card-prompt');
  submitForm(ctx, '#card-form'); await ctx.idle();
  assert.equal($('#card-error').hidden, false);
  const prompt = '  Add a search field.\nKeep keyboard navigation.  ';
  $('#card-prompt').value = prompt;
  submitForm(ctx, '#card-form'); await ctx.idle();
  const cards = await serverTasks(ctx);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].prompt, prompt);
  assert.equal(cards[0].column, 'todo');
  $('.kanban-add-task').click();
  $('#card-prompt').value = 'Refine this request.';
  $('#card-refine').click(); await ctx.idle();
  assert.equal($('#kanban-view').hidden, true);
  assert.equal($('#prompt-input').value, 'Refine this request.');
  assert.equal($('#card-dialog').open, false);
  assert.equal((await serverTasks(ctx)).length, 1);
  ctx.submit();
  await until(() => !$('#generate-button').disabled && ctx.requests.length === 1, 'refinement');
  assert.equal(ctx.requests[0].input, 'Refine this request.');
});

test('Composer saves optional exact edits to history and Kanban, and cancels or rejects empty edits', async t => {
  const ctx = await setup(t);
  const { $, win } = ctx;
  $('#prompt-input').value = 'Make a feature.'; ctx.submit();
  await until(() => !$('#generate-button').disabled && ctx.requests.length === 1, 'generated');
  const original = $('#prompt-output').textContent;
  $('#prompt-edit').click(); $('#prompt-edit-text').value = 'discard me'; $('#prompt-edit-cancel').click();
  assert.equal($('#prompt-output').textContent, original);
  $('#prompt-edit').click(); $('#prompt-edit-text').value = '   '; $('#prompt-edit-save').click();
  assert.equal($('#prompt-edit-error').hidden, false);
  assert.equal($('#kanban-button').disabled, true);
  const edited = '  My exact version.\nKeep `src/a.ts`.  ';
  $('#prompt-edit-text').value = edited; $('#prompt-edit-save').click();
  assert.equal($('#prompt-output').textContent, edited);
  assert.equal($('#verification-report').hidden, true);
  const stored = JSON.parse(win.localStorage.getItem('ste-prompt-engineer.history.v1'));
  assert.equal(stored[0].prompt, edited);
  assert.equal(stored[0].verification, null);
  $('#kanban-button').click();
  assert.equal($('#add-preview').textContent, edited);
  $('#add-project-name').value = 'Edited prompts';
  submitForm(ctx, '#add-form'); await ctx.idle();
  assert.equal((await serverTasks(ctx))[0].prompt, edited);
  $('.history-restore').click(); await ctx.idle();
  assert.equal($('#prompt-output').textContent, edited);
});


test('Agents toolbar configures each project, column overrides, custom agents, and a shared model', async t => {
  const ctx = await linkedKanban(t);
  const { $, choose, win } = ctx;
  await link(ctx);
  const projectId = (await serverBoard(ctx)).projects[0].id;
  await newProject(ctx, 'Independent');
  const otherBefore = (await serverBoard(ctx)).projects.find(project => project.id !== projectId);
  // Return to the linked project and add an agent column.
  const project = (await serverBoard(ctx)).projects.find(project => project.id === projectId);
  const columns = ['todo', 'planning', 'executing', 'code_review', 'testing', 'merge', 'done'].map(id => ({ id }));
  columns.splice(3, 0, { id: 'c_docs0001', custom: true, title: 'Docs', agent: { enabled: true, policy: 'manual', instructions: 'Write docs.' } });
  await ctx.app.board.setColumns(projectId, { columns, expectedRevision: project.revision });
  await win.__pbTest.loadBoard(); await ctx.idle();
  // Select using the workspace control so the test follows the real project selection path.
  const workspace = [...$('#workspace-list').querySelectorAll('button')].find(button => button.textContent.includes(project.name));
  workspace.click(); await ctx.idle();
  $('#agents-open').click(); await ctx.idle();
  const defaults = '#workflow-stages .workflow-defaults';
  choose(`${defaults} [data-field="provider"]`, 'codex'); await ctx.idle();
  choose(`${defaults} [data-field="model"]`, 'codex-one');
  const review = '#workflow-stages [data-stage="code_review"]';
  choose(`${review} [data-field="provider"]`, 'codex'); await ctx.idle();
  choose(`${review} [data-field="model"]`, 'codex-two');
  const custom = '#workflow-stages [data-stage="c_docs0001"]';
  choose(`${custom} [data-field="provider"]`, 'claude'); await ctx.idle();
  choose(`${custom} [data-field="model"]`, 'haiku');
  submitForm(ctx, '#workflow-form'); await ctx.idle();
  let saved = (await serverBoard(ctx)).projects.find(project => project.id === projectId);
  assert.equal(saved.effectiveWorkflow.executing.model, 'codex-one');
  assert.equal(saved.effectiveWorkflow.code_review.model, 'codex-two');
  assert.equal(saved.effectiveWorkflow.c_docs0001.provider, 'claude');
  assert.equal(saved.effectiveWorkflow.c_docs0001.model, 'haiku');
  assert.equal(saved.effectiveWorkflow.c_docs0001.agentSource, 'stage');
  assert.match($('#project-agent-summary').textContent, /Stage overrides:.*Docs/);
  assert.deepEqual((await serverBoard(ctx)).projects.find(project => project.id !== projectId), otherBefore);
  $('#kanban-columns [data-column="c_docs0001"] .column-agent').click(); await ctx.idle();
  assert.equal(win.document.activeElement, $(`${custom} [data-field="provider"]`));
  $('#workflow-use-project-agent').click();
  submitForm(ctx, '#workflow-form'); await ctx.idle();
  saved = (await serverBoard(ctx)).projects.find(project => project.id === projectId);
  for (const id of ['planning', 'executing', 'code_review', 'testing', 'merge', 'c_docs0001']) {
    assert.equal(saved.effectiveWorkflow[id].provider, 'codex');
    assert.equal(saved.effectiveWorkflow[id].model, 'codex-one');
    assert.equal(saved.effectiveWorkflow[id].agentSource, 'project');
  }
  assert.equal(saved.effectiveWorkflow.c_docs0001.policy, 'manual');
  assert.equal(saved.effectiveWorkflow.c_docs0001.instructions, 'Write docs.');
  const reload = await setup(t, { executor: ctx.executor, hash: '#/kanban', dataDir: ctx.dataDir });
  assert.equal((await serverBoard(reload)).projects.find(project => project.id === projectId).effectiveWorkflow.c_docs0001.model, 'codex-one');
});


test('Task card menu edits content and saves independent display preferences with keyboard dismissal', async t => {
  const ctx = await setup(t, { hash: '#/kanban' });
  const { $, win } = ctx;
  await newProject(ctx, 'Card design');
  await newCard(ctx, 'Minimal task', 'Original prompt.');
  await newCard(ctx, 'Another task', 'Keep this card unchanged.');
  let card = cardItem(ctx, 'Minimal task');
  const id = card.dataset.id;
  assert.equal(card.querySelector('.kanban-more').hidden, true);
  assert.ok(card.querySelector('.kanban-more .kanban-move-to'));
  assert.ok(card.querySelector('.kanban-more .kanban-details'));
  assert.ok(card.querySelector('.kanban-more .card-workspace'));
  card.querySelector('.kanban-more-toggle').click();
  for (const field of ['preview', 'agent', 'comfortable']) card.querySelector(`[data-card-display="${field}"]`).click();
  assert.ok(card.classList.contains('hide-preview'));
  assert.ok(card.classList.contains('show-agent'));
  assert.ok(card.classList.contains('comfortable'));
  assert.equal(cardItem(ctx, 'Another task').classList.contains('hide-preview'), false);
  card.querySelector('.card-appearance').open = true;
  card.querySelector('[data-card-display="preview"]').focus();
  await win.__pbTest.loadBoard(); await ctx.idle();
  card = cardItem(ctx, 'Minimal task');
  assert.equal(card.querySelector('.card-appearance').open, true);
  assert.equal(win.document.activeElement.dataset.cardDisplay, 'preview');
  card.querySelector('.kanban-edit').click();
  $('#card-title').value = 'Edited task'; $('#card-prompt').value = '  Exact edited prompt.  ';
  submitForm(ctx, '#card-form'); await ctx.idle();
  card = cardItem(ctx, 'Edited task');
  assert.equal((await serverTasks(ctx)).find(task => task.id === id).prompt, '  Exact edited prompt.  ');
  assert.ok(card.classList.contains('hide-preview'));
  card.querySelector('.kanban-more').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(card.querySelector('.kanban-more').hidden, true);
  assert.equal(win.document.activeElement, card.querySelector('.kanban-more-toggle'));
  const key = `promptboard.card-appearance.${id}`;
  const reload = await setup(t, { hash: '#/kanban', dataDir: ctx.dataDir, prefs: { [key]: win.localStorage.getItem(key) } });
  await reload.idle();
  const restored = cardItem(reload, 'Edited task');
  assert.ok(restored.classList.contains('hide-preview'));
  assert.ok(restored.classList.contains('comfortable'));
  restored.querySelector('.kanban-more-toggle').click();
  restored.querySelector('[data-card-display="preview"]').click();
  assert.equal(restored.classList.contains('hide-preview'), false);
});


test('Shared Settings uses live model catalogs, explicit saves, and model-specific effort', async t => {
  let catalogReads = 0;
  const ctx = await setup(t, { catalogReader: async provider => { catalogReads++; return { provider, ...catalogs[provider] }; } });
  const { $, choose } = ctx;
  $('#app-settings-open').click(); await ctx.idle();
  choose('#set-agent-provider', 'claude'); await ctx.idle();
  choose('#set-agent-model', 'haiku');
  assert.equal($('#set-agent-effort').disabled, true, 'Haiku reports no effort choices.');
  assert.equal((await serverBoard(ctx)).settings.defaultAgent ?? null, null, 'Draft choices do not save automatically.');
  $('#set-agent-save').click(); await ctx.idle();
  assert.equal((await serverBoard(ctx)).settings.defaultAgent.model, 'haiku');
  choose('#set-agent-provider', 'codex'); await ctx.idle();
  choose('#set-agent-model', 'codex-two'); choose('#set-agent-effort', 'low');
  const before = catalogReads;
  $('#set-agent-fields .agent-refresh-models').click(); await ctx.idle();
  assert.ok(catalogReads > before, 'Refresh rereads the CLI catalog.');
  assert.equal($('#set-agent-model').value, 'codex-two');
  assert.equal($('#set-agent-effort').value, 'low');
  $('#set-agent-save').click(); await ctx.idle();
  assert.deepEqual((await serverBoard(ctx)).settings.defaultAgent, { provider: 'codex', model: 'codex-two', effort: 'low' });
  choose('#set-agent-provider', ''); $('#set-agent-save').click(); await ctx.idle();
  assert.equal((await serverBoard(ctx)).settings.defaultAgent, null);
  assert.equal($('#set-agent-fields .model-field').hidden, true);
});

test('Settings connects Composer and Kanban, with universal display defaults and per-card overrides', async t => {
  const ctx = await setup(t, { hash: '#/kanban' });
  const { $, win, choose } = ctx;
  await newProject(ctx, 'Shared settings'); await newCard(ctx, 'Task', 'Do this.');
  $('#app-settings-open').click(); await ctx.idle();
  $('#set-card-preview').click(); $('#set-card-spacing').click();
  let card = cardItem(ctx, 'Task');
  assert.ok(card.classList.contains('hide-preview')); assert.ok(card.classList.contains('comfortable'));
  $('#app-settings-close').click();
  card.querySelector('.kanban-more-toggle').click(); card.querySelector('[data-card-display="preview"]').click();
  assert.equal(card.classList.contains('hide-preview'), false);
  $('#app-settings-open').click(); await ctx.idle();
  $('#set-card-agent').click();
  card = cardItem(ctx, 'Task'); assert.equal(card.classList.contains('hide-preview'), false);
  assert.ok(card.classList.contains('show-agent'));
  $('#app-settings-close').click(); card.querySelector('.card-display-reset').click();
  assert.ok(card.classList.contains('hide-preview'));
  $('#app-settings-open').click(); await ctx.idle(); $('#set-columns').click();
  assert.equal($('#columns-dialog').open, true); $('#columns-close').click();
  $('#app-settings-open').click(); await ctx.idle(); $('#set-compose').click();
  assert.equal($('#prompt-view').hidden, false); assert.equal($('#settings-body').hidden, false);
  assert.equal(win.document.activeElement.id, 'settings-toggle');
  assert.equal($('#view-board').getAttribute('aria-controls'), 'kanban-columns');
  $('#app-settings-open').click(); await ctx.idle();
  choose('#set-max-runs', '2'); choose('#set-max-runs', '4'); await ctx.idle();
  assert.equal((await serverBoard(ctx)).settings.maxConcurrentRuns, 4);
  const reload = await setup(t, { dataDir: ctx.dataDir, hash: '#/kanban', prefs: {
    'promptboard.settings.card-preview': '0', 'promptboard.settings.card-spacing': '1', 'promptboard.settings.terminal-font': 'bad',
  } }); await reload.idle();
  assert.ok(cardItem(reload, 'Task').classList.contains('hide-preview'));
  assert.ok(cardItem(reload, 'Task').classList.contains('comfortable'));
});


test('Task saves ignore repeated submits and Split retries only unsaved cards', async t => {
  const tasks = [{ title: 'First split task', prompt: 'Implement it.' }, { title: 'Second split task', prompt: 'Test it.' }];
  const ctx = await setup(t, { hash: '#/kanban', runner: request => ({ text: request.prompt.startsWith('# Task split') ? JSON.stringify({ tasks }) : 'Implement and test it.', reportedModels: ['m'] }) });
  const { $, win } = ctx;
  await newProject(ctx, 'Retry tasks');
  $('.kanban-add-task').click(); $('#card-prompt').value = 'Create once.';
  submitForm(ctx, '#card-form'); submitForm(ctx, '#card-form'); await ctx.idle();
  assert.equal((await serverTasks(ctx)).length, 1);
  await goTo(ctx, '#/'); ctx.quality('fast'); $('#prompt-input').value = 'Implement and test.'; ctx.submit();
  await until(() => !$('#split-button').disabled, 'generated prompt');
  $('#kanban-button').click(); submitForm(ctx, '#add-form'); submitForm(ctx, '#add-form'); await ctx.idle();
  assert.equal((await serverTasks(ctx)).length, 2);
  $('#split-button').click(); await until(() => $('#split-list').children.length === 2, 'split result');
  $('#split-autopilot').checked = false;
  const originalFetch = win.fetch;
  let creates = 0;
  win.fetch = (url, options) => {
    if (url === '/api/tasks' && options?.method === 'POST' && ++creates === 2) return Promise.resolve(Response.json({ error: 'Temporary save failure.' }, { status: 500 }));
    return originalFetch(url, options);
  };
  submitForm(ctx, '#split-form'); submitForm(ctx, '#split-form');
  await until(() => !$('#split-error').hidden && $('#split-form').getAttribute('aria-busy') === 'false', 'partial failure');
  assert.equal((await serverTasks(ctx)).filter(task => task.title === 'First split task').length, 1);
  assert.equal($('#split-list').children.length, 1);
  assert.match($('#split-error').textContent, /Only unsaved tasks remain/);
  submitForm(ctx, '#split-form'); await ctx.idle();
  assert.equal($('#split-dialog').open, false);
  const saved = await serverTasks(ctx);
  assert.equal(saved.filter(task => task.title === 'First split task').length, 1);
  assert.equal(saved.filter(task => task.title === 'Second split task').length, 1);
});


test('Composer installation status and model availability follow the latest connection check', async t => {
  let installed = true;
  const ctx = await setup(t, { authAdapter: fakeAuth({ installed: async () => installed }) });
  const { $ } = ctx;
  installed = false;
  $('#auth-check').click(); await ctx.idle();
  assert.match($('#provider option:checked').textContent, /not installed/);
  assert.equal($('#connection-install').textContent, 'CLI not installed');
  assert.equal($('#generate-button').disabled, true);
  installed = true;
  $('#auth-check').click(); await ctx.idle();
  assert.doesNotMatch($('#provider option:checked').textContent, /not installed/);
  assert.match($('#connection-install').textContent, /CLI installed/);
  assert.equal($('#generate-button').disabled, false);
  assert.ok($('#model option[value="codex-one"]'));
  assert.match($('#cli-status-label').textContent, /installed/);
});


test('Composer starts with an empty input and no bundled example feature', async t => {
  const { $, submit, calls } = await setup(t);
  assert.equal($('#prompt-input').value, '');
  assert.equal($('#prompt-input').getAttribute('placeholder'), null);
  assert.equal($('#load-example'), null);
  const script = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /load-example|Build a small FastAPI service/);
  $('#prompt-input').value = 'Review my task.';
  submit();
  await until(() => !$('#generate-button').disabled && calls.length > 0, 'generation without example control');
  assert.ok($('#prompt-output').textContent.trim());
});


test('interrupted dirty cards and completed cards delete through HTTP and stay deleted after reload', async t => {
  const ctx = await setup(t);
  await goTo(ctx, '#/kanban'); await newProject(ctx, 'Deletion');
  await newCard(ctx, 'Interrupted work', 'Keep my files.');
  const task = (await serverTasks(ctx))[0];
  const workspace = await ctx.app.board.ensureTaskWorktree(task.id);
  await writeFile(join(workspace.path, 'unfinished.txt'), 'keep this');
  await ctx.app.board.store.update(state => { state.runs.push({ id: 'interrupted-delete', projectId: state.projects[0].id, taskId: task.id, status: 'interrupted', stage: 'executing', updatedAt: Date.now(), config: { provider: 'codex' } }); });
  await ctx.win.__pbTest.loadBoard(); await ctx.idle();
  cardItem(ctx, 'Interrupted work').querySelector('.kanban-delete').click();
  await ctx.win.__pbTest.loadBoard(); await ctx.idle();
  assert.match(ctx.$('#kanban-columns').textContent, /Files and branch are kept/);
  assert.equal(ctx.win.document.activeElement.textContent, 'Keep card');
  byText(ctx.$('#kanban-columns'), 'Keep card').click();
  assert.equal(ctx.$('.kanban-confirm'), null);
  cardItem(ctx, 'Interrupted work').querySelector('.kanban-delete').click();
  await click(ctx, byText(ctx.$('#kanban-columns'), 'Delete card'));
  assert.equal((await serverTasks(ctx)).length, 0);
  assert.equal(await readFile(join(workspace.path, 'unfinished.txt'), 'utf8'), 'keep this');
  assert.equal(ctx.$('#agents-list').children.length, 0);
  await newCard(ctx, 'Completed work', 'Done.');
  const completed = (await serverTasks(ctx))[0];
  await ctx.app.board.store.update(state => { state.projects[0].tasks.find(item => item.id === completed.id).column = 'done'; });
  await ctx.win.__pbTest.loadBoard(); await ctx.idle();
  ctx.$('.kanban-done-all').click();
  ctx.$('#done-dialog .kanban-delete').click();
  byText(ctx.$('#done-dialog'), 'Keep card').click();
  assert.equal(ctx.$('#done-dialog .kanban-confirm'), null);
  ctx.$('#done-dialog .kanban-delete').click();
  await click(ctx, byText(ctx.$('#done-dialog'), 'Delete card'));
  assert.equal(ctx.$('#done-dialog').open, false);
  const fresh = await setup(t, { dataDir: ctx.dataDir });
  assert.equal((await serverTasks(fresh)).length, 0);
});


test('Usage dashboard shows limits, model/tool totals, charts, minute refresh, errors, and focus return', async t => {
  let left = 75, failed = false, reads = 0;
  const provider = () => ({ id: 'codex', name: 'Codex', sessions: 2, inputTokens: 1200, cachedTokens: 100, outputTokens: 50, costUSD: null, costNote: 'Not reported', limits: { status: 'live', checkedAt: Date.now(), windows: [{ label: '5h', remainingPercent: left, usedPercent: 100-left }] }, models: [{ model: 'gpt-test', inputTokens: 1200, cachedTokens: 100, outputTokens: 50 }], tools: [{ name: 'exec_command', count: 3 }], daily: [{ day: '2026-10-02', tokens: 1350 }] });
  const ctx = await setup(t, { usageReader: { get: async () => { reads++; if (failed) throw new Error('private'); return { updatedAt: Date.now(), providers: [provider()] }; } } });
  Object.defineProperty(ctx.win.document, 'hidden', { configurable: true, value: false });
  ctx.$('#usage-open').click(); await ctx.idle();
  assert.match(ctx.$('#usage-providers').textContent, /75% left/);
  assert.equal(ctx.$('#usage-providers progress').value, 75);
  assert.equal(ctx.$('#usage-providers svg').getAttribute('role'), 'img');
  assert.match(ctx.$('#usage-providers').textContent, /gpt-test/);
  assert.match(ctx.$('#usage-providers').textContent, /exec_command · 3/);
  assert.match(ctx.$('#usage-providers').textContent, /Cost not reported/);
  ctx.$('#usage-providers details').open = true;
  left = 62;
  ctx.intervals.findLast(timer => timer.ms === 60000).fn(); await ctx.idle();
  assert.match(ctx.$('#usage-providers').textContent, /62% left/);
  assert.equal(ctx.$('#usage-providers details').open, true);
  failed = true; ctx.$('#usage-refresh').click(); await ctx.idle();
  assert.equal(ctx.$('#usage-error').hidden, false);
  assert.match(ctx.$('#usage-providers').textContent, /62% left/);
  ctx.$('#usage-close').click();
  assert.equal(ctx.win.document.activeElement.id, 'usage-open');
  const before = reads; ctx.intervals.findLast(timer => timer.ms === 60000).fn(); await ctx.idle();
  assert.equal(reads, before);
});

test('Base is the third global page, preserves Compose and project state, and supports direct links and browser history', async t => {
  const ctx = await setup(t, { hash: '#/base' }); const { $, win } = ctx;
  await ctx.idle();
  assert.deepEqual([...win.document.querySelectorAll('.page-nav a')].map(link => link.textContent), ['Compose', 'Kanban', 'Base']);
  assert.equal($('#base-view').hidden, false); assert.equal($('#prompt-view').hidden, true); assert.equal($('#kanban-view').hidden, true);
  assert.equal(win.document.title, 'Base · Promptboard');
  assert.equal($('.page-nav [aria-current="page"]').getAttribute('href'), '#/base');
  assert.equal($('#sidebar').hidden, false); assert.equal($('#menu-toggle').hidden, false);
  assert.equal($('#base-sidebar-panel').hidden, false); assert.equal($('#workspace-panel').hidden, true);
  assert.equal($('#sidebar').getAttribute('aria-label'), 'Base library');
  assert.equal($('#base-categories').closest('#base-sidebar-panel') !== null, true);
  assert.equal($('#base-error').hidden, true, $('#base-error').textContent);
  $('#skip-link').dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true })); assert.equal(win.document.activeElement.id, 'base-view'); assert.equal(win.location.hash, '#/base');
  await goTo(ctx, '#/'); $('#prompt-input').value = 'An unfinished Compose draft.';
  await goTo(ctx, '#/kanban'); await newProject(ctx, 'Persistent selection');
  const selected = win.localStorage.getItem('promptboard.kanban.project');
  await goTo(ctx, '#/base'); await until(() => !$('#base-view').hidden, 'Base shown');
  assert.equal($('#prompt-input').value, 'An unfinished Compose draft.');
  assert.equal(win.localStorage.getItem('promptboard.kanban.project'), selected);
  win.history.back(); await until(() => !$('#kanban-view').hidden, 'Back to Kanban');
  win.history.forward(); await until(() => !$('#base-view').hidden, 'Forward to Base');
  $('#new-prompt').click(); await until(() => !$('#prompt-view').hidden, 'Compose action leaves Base');
  assert.equal(win.document.title, 'Compose · Promptboard');
});

test('Base start-page preference applies only without an explicit route', async t => {
  const saved = { 'promptboard.settings.start-page': 'base' };
  const first = await setup(t, { prefs: saved }); await first.idle();
  assert.equal(first.win.location.hash, '#/base'); assert.equal(first.$('#base-view').hidden, false);
  const explicit = await setup(t, { prefs: saved, hash: '#/kanban' }); await explicit.idle();
  assert.equal(explicit.$('#kanban-view').hidden, false); assert.equal(explicit.$('#base-view').hidden, true);
  explicit.$('#app-settings-open').click(); await explicit.idle();
  assert.equal(explicit.$('#set-start').value, 'base');
  assert.ok(explicit.$('#set-base-fields .base-picker'), 'Global agent settings use the shared Base picker.');
});

test('Base skill creation and project assignment persist through the actual authenticated interface', async t => {
  const ctx = await setup(t, { hash: '#/kanban' }); const { $, win } = ctx;
  await newProject(ctx, 'Base project');
  const project = (await serverBoard(ctx)).projects[0];
  await goTo(ctx, '#/base'); await until(() => !$('#base-view').hidden && !$('#base-status').textContent.includes('Loading'), 'Base ready');
  $('#base-new-kind').value = 'skill'; byText($('#base-actions'), 'Create').click();
  $('#base-resource-name').value = 'UI instruction skill'; $('#base-skill-body').value = 'Keep the original task exactly.\n';
  submitForm(ctx, '.base-resource-form'); await ctx.idle();
  const resources = await ctx.app.board.base.list();
  const created = (resources.resources || resources).find(item => item.name === 'UI instruction skill'); assert.ok(created);
  const before = (await serverBoard(ctx)).projects[0]; assert.equal(before.baseBinding, undefined, 'Creating a skill never assigns it.');
  await goTo(ctx, '#/kanban'); $('#project-agent-toggle').click();
  $('#project-agent-fields .base-picker button').click(); await ctx.idle();
  const mode = $('[data-base-mode]'); mode.value = 'extend'; mode.dispatchEvent(new win.Event('change', { bubbles: true }));
  const include = $(`.base-binding-fields [data-resource="${created.id}"]`); include.checked = true; include.dispatchEvent(new win.Event('change', { bubbles: true }));
  submitForm(ctx, '#base-dialog-content form'); await ctx.idle();
  const after = (await serverBoard(ctx)).projects.find(item => item.id === project.id);
  assert.deepEqual(after.baseBinding.include, [{ resourceId: created.id, required: true }]);
  assert.equal(after.agentDefaults?.provider, before.agentDefaults?.provider, 'Resource selection does not change inherited provider.');
  assert.equal((await serverBoard(ctx)).runs.length, 0, 'Assignment never starts a run.');
});

test('Base saves a linked wiki and official MCP preset, then groups them in a pack without executing', async t => {
  const ctx = await setup(t, { hash: '#/base' }); const { $, win } = ctx; await ctx.idle();
  $('#base-new-kind').value = 'knowledge'; byText($('#base-actions'), 'Create').click();
  $('#base-resource-name').value = 'Local wiki'; byText($('#base-detail'), 'Add page').click();
  $('#base-wiki-markdown').value = '# Manual wiki\nKeep this wording unchanged.';
  submitForm(ctx, '.base-resource-form'); await ctx.idle();
  assert.equal($('.base-resource-form .inline-error').hidden, true, $('.base-resource-form .inline-error').textContent);
  let resources = (await ctx.app.board.base.list()).resources;
  const wiki = resources.find(item => item.name === 'Local wiki'); assert.ok(wiki);
  const detail = await ctx.app.board.base.detail(wiki.id); assert.equal(detail.content.pages[0].markdown, '# Manual wiki\nKeep this wording unchanged.');
  byText($('#base-actions'), 'Context7 preset').click(); await ctx.idle();
  assert.equal($('#base-resource-enabled').checked, false); assert.equal($('#base-resource-trust').value, 'untrusted');
  submitForm(ctx, '.base-resource-form'); await ctx.idle();
  resources = (await ctx.app.board.base.list()).resources;
  const mcp = resources.find(item => item.name === 'Context7'); assert.ok(mcp);
  assert.equal(mcp.configuration.headers.Authorization, 'CONTEXT7_AUTHORIZATION'); assert.equal(mcp.connectionTest, undefined);
  $('#base-new-kind').value = 'pack'; byText($('#base-actions'), 'Create').click(); $('#base-resource-name').value = 'Optional documentation';
  for (const id of [wiki.id, mcp.id]) { const input = $(`.base-resource-form [data-resource="${id}"]`); input.checked = true; input.dispatchEvent(new win.Event('change', { bubbles: true })); }
  submitForm(ctx, '.base-resource-form'); await ctx.idle();
  const pack = (await ctx.app.board.base.list()).resources.find(item => item.name === 'Optional documentation');
  assert.deepEqual(pack.configuration.resources.map(ref => ref.resourceId).sort(), [wiki.id, mcp.id].sort());
  assert.equal((await serverBoard(ctx)).runs.length, 0); assert.equal(ctx.calls.length, 0, 'Library edits never invoke the generation runner.');
});
