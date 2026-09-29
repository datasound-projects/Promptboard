import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { startServer } from '../src/server.mjs';
import { VERSION } from '../src/version.mjs';

const catalogs = {
  codex: { source: 'cli', defaultModel: 'codex-one', defaultEffort: 'medium', models: [{ id: 'codex-one', name: 'Codex One', efforts: ['low', 'medium', 'high', 'xhigh'] }, { id: 'codex-two', name: 'Codex Two', efforts: ['low'] }] },
  claude: { source: 'cli', models: [{ id: 'opus', name: 'Opus', efforts: ['low', 'medium', 'high', 'max'] }, { id: 'haiku', name: 'Haiku', efforts: [] }] },
  gemini: { source: 'cli', models: [{ id: 'gemini-one', name: 'Gemini One', efforts: [] }] },
  agy: { source: 'cli', models: [{ id: 'gemini-agy', name: 'Gemini AGY', efforts: ['low', 'medium', 'high'] }] },
};
async function until(fn, label, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!fn()) { if (Date.now() > deadline) assert.fail(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 10)); }
}
// Fixture auth adapter: never runs a real CLI, and records every mutation.
function fakeAuth(overrides = {}) {
  const log = [];
  return { log, installed: async () => true, status: async provider => { log.push(['status', provider]); return { state: 'signed-in', method: 'fixture' }; },
    login: async (provider, options) => { log.push(['login', provider, options.method]); options.onUpdate({ authUrl: 'https://auth.example/start' }); return { state: 'signed-in' }; },
    logout: async provider => { log.push(['logout', provider]); return { state: 'signed-out' }; }, ...overrides };
}
async function setup(t, { catalogReader = async id => ({ provider: id, ...catalogs[id], note: 'Native model options.' }), storage, prefs = {}, kanban, hash = '', generationResponse, authAdapter = fakeAuth(), runner, dataDir, executor = 'auto', folderPicker } = {}) {
  // Every page gets a private board folder unless a test shares one to simulate a reload.
  if (!dataDir) { dataDir = await mkdtemp(join(tmpdir(), 'pb-ui-')); t.after(() => rm(dataDir, { recursive: true, force: true })); }
  const calls = [];
  const requests = [];
  const app = await startServer({ port: 0, dataDir, executor, authAdapter, ...(folderPicker ? { folderPicker } : {}), detector: async () => Object.keys(catalogs).map(id => ({ id, available: true })), catalogReader,
    runner: runner ? async request => { calls.push(request); return runner(request); } : async request => { calls.push(request); return { text: request.prompt.includes('prose in Polish') ? 'Dodaj test.' : request.prompt.includes('prose in German') ? 'Füge einen Test hinzu.' : 'Add a test.', reportedModels: ['actual-model'], durationMs: 3 }; } });
  const dom = new JSDOM(await readFile(new URL('../public/index.html', import.meta.url), 'utf8'), { url: app.url + hash, runScripts: 'outside-only' });
  const win = dom.window;
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
  // Browsers share one global scope across classic scripts; jsdom's eval does not, so evaluate them together.
  // Test-only export appended by the harness (not part of the app): reload the board and read the token.
  win.eval(`${await readFile(new URL('../public/app.js', import.meta.url), 'utf8')}\n${await readFile(new URL('../public/dock.js', import.meta.url), 'utf8')}\nwindow.__pbTest = { loadBoard, get token() { return token; } };`);
  t.after(async () => {
    // A request can still be in flight when a test ends (for example a model refresh). Its handler
    // would then touch a closed window. Wait until the page is idle for a few ticks, then close.
    for (let idle = 0, end = Date.now() + 3000; idle < 3 && Date.now() < end;) { await new Promise(resolve => setTimeout(resolve, 10)); idle = pending ? 0 : idle + 1; }
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
  return { win, $, choose, radio, quality, submit, calls, requests, downloads, blobs, copied: () => copied, authAdapter, app, dataDir, idle };
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
  await until(() => !$('#copy-cheer').hidden, 'copy cheer');
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
    stages: [{ stage: 'draft', reportedModels: ['model-one'], durationMs: 250, status: 'complete' }, { stage: 'review', reportedModels: ['model-one'], durationMs: 250, status: 'complete' }],
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
  await until(() => $('#progress-stage').textContent === 'Drafting', 'stage label');
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
  t.after(() => rm(dir, { recursive: true, force: true }));
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
  assert.equal(draft.querySelector('.kanban-meta').textContent, 'Codex · codex-one · Deutsch');
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
  assert.match(items()[0].querySelector('.workspace-meta').textContent, /Not linked · 2 cards/);
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
  await menu('Beta two', 'Link repository…');
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
  $('#card-new').click(); submitForm(ctx, '#card-form');
  assert.match($('#card-error').textContent, /title/);
  $('#card-title').value = 'Only a title'; submitForm(ctx, '#card-form');
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
  assert.match($('#repo-state').textContent, /Not linked/);
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
  const menu = cardItem(ctx, 'Feature').querySelector('.kanban-move-to');
  menu.value = 'executing'; menu.dispatchEvent(new win.Event('change')); await ctx.idle();
  assert.deepEqual(titles($, 'executing'), ['Feature']);
  assert.match($('#announcement').textContent, /does not run or approve that stage/);
  const board = await serverBoard(ctx);
  assert.equal(board.projects[0].tasks[0].column, 'executing');
  assert.equal(board.projects[0].tasks[0].workspace, null);
  assert.deepEqual(board.runs, []);
  assert.equal(board.execution.available, true);
  assert.match($('#kanban-columns [data-column="executing"] .kanban-column-note').textContent, /starts only when you choose/);
  assert.match($('#kanban-columns [data-column="code_review"] .kanban-column-note').textContent, /starts only when you choose/);
  assert.match($('#kanban-columns [data-column="merge"] .kanban-column-note').textContent, /never pushed/);
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
  assert.equal(column($, 'todo').querySelector('.kanban-meta').textContent, 'Claude Code · opus · Polski');
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
  assert.equal(project.effectiveWorkflow.executing.policy, 'ask');
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

test('the Kanban page shows its own mascot next to the heading', async t => {
  const { $ } = await setup(t);
  const image = $('#kanban-view .intro .mascot img');
  assert.equal(image.getAttribute('src'), '/kanban-mascot.png');
  assert.match(image.getAttribute('alt'), /pixel-art creature/);
  assert.equal($('#kanban-view .intro figcaption').textContent, 'One bite at a time.');
  assert.equal($('#board-empty img'), null, 'The empty board has no image.');
  const served = await fetch(new URL('/kanban-mascot.png', $('#kanban-view').ownerDocument.location.href));
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
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
    async confirm(runId) { const run = await executor.board.run(runId); if (run.stage === 'planning') await executor.board.approvePlan(run.taskId, { runId }); await executor.board.updateRun(runId, { status: 'succeeded' }); },
    async cancel(runId) { await executor.board.updateRun(runId, { status: 'cancelled' }); },
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
async function link(ctx) {
  await ctx.app.board.linkRepository(ctx.project.id, { path: ctx.repo, expectedRevision: 1 });
  await ctx.app.board.setTargetBranch(ctx.project.id, { branch: 'trunk', expectedRevision: 2 });
  await ctx.win.__pbTest.loadBoard(); await ctx.idle();
}
const moveBy = async (ctx, title, column) => { const menu = cardItem(ctx, title).querySelector('.kanban-move-to'); menu.value = column; menu.dispatchEvent(new ctx.win.Event('change')); };

test('drag-and-drop and keyboard moves use the same transition; rejected moves roll back visibly with the reason', { skip: process.platform === 'win32' }, async t => {
  const ctx = await linkedKanban(t);
  const { $, win } = ctx;
  await newCard(ctx, 'Keyboard', 'Move me with the menu.');
  await newCard(ctx, 'Dragged', 'Move me with the mouse.');
  // Keyboard: the card moves at once and shows as pending, then rolls back with the server's reason.
  await moveBy(ctx, 'Keyboard', 'planning');
  assert.ok(cardItem(ctx, 'Keyboard').classList.contains('pending'), 'A move shows as pending until the server confirms it.');
  assert.deepEqual(titles($, 'planning'), ['Keyboard']);
  await ctx.idle();
  assert.deepEqual(titles($, 'todo'), ['Keyboard', 'Dragged'], 'The rejected move is rolled back.');
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
  // After linking, both paths succeed and record the same kind of transition.
  await link(ctx);
  await moveBy(ctx, 'Keyboard', 'executing'); await ctx.idle();
  cardItem(ctx, 'Dragged').dispatchEvent(new win.Event('dragstart', { bubbles: true }));
  column($, 'executing').dispatchEvent(new win.Event('drop', { bubbles: true, cancelable: true }));
  await ctx.idle();
  assert.deepEqual(titles($, 'executing'), ['Keyboard', 'Dragged']);
  const tasks = await serverTasks(ctx);
  assert.deepEqual(tasks.map(task => task.transitions.map(({ from, to, by }) => [from, to, by])), [[['todo', 'executing', 'user']], [['todo', 'executing', 'user']]]);
  // A move the rules forbid is refused the same way, with a clear reason.
  cardItem(ctx, 'Dragged').dispatchEvent(new win.Event('dragstart', { bubbles: true }));
  column($, 'done').dispatchEvent(new win.Event('drop', { bubbles: true, cancelable: true }));
  await ctx.idle();
  assert.deepEqual(titles($, 'done'), []);
  assert.match($('#project-detail').textContent, /cannot move from Executing to Done/);
  assert.equal(ctx.executor.started.length, 0, 'Moves under the default Ask setting start nothing.');
});

test('workflow settings: Ask by default, Manual does nothing, Start runs as a separate recorded event; To Do stays inert', { skip: process.platform === 'win32' }, async t => {
  const ctx = await linkedKanban(t);
  const { $, win } = ctx;
  await link(ctx);
  await newCard(ctx, 'Alpha', 'First task.');
  await newCard(ctx, 'Beta', 'Second task.');
  assert.match($('#workflow-summary').textContent, /Planning: Ask on entry · Executing: Ask on entry/);
  $('#workflow-open').click();
  const stages = [...$('#workflow-stages').querySelectorAll('.workflow-stage')];
  assert.deepEqual(stages.map(box => box.dataset.stage), ['planning', 'executing', 'code_review', 'testing', 'merge'], 'To Do and Done have no workflow setting.');
  assert.match(stages.at(-1).textContent, /Merge automatically/);
  assert.equal(stages.at(-1).querySelector('input[value="manual"]').checked, true, 'Merge is manual by default.');
  assert.ok(stages.slice(0, -1).every(box => box.querySelector('input[value="ask"]').checked), 'Ask on entry is the default for the run stages.');
  assert.match(stages[0].querySelector('.workflow-preview').textContent, /asks whether to start/);
  assert.match($('#workflow-stages').textContent, /To Do and Done never run agents\. Merges are fast-forward only and never pushed/);
  $('#workflow-cancel').click();
  // Ask on entry: a question appears; nothing starts until the user agrees.
  await moveBy(ctx, 'Alpha', 'planning'); await ctx.idle();
  assert.equal($('#ask-panel').hidden, false);
  assert.match($('#ask-panel').textContent, /“Alpha” is now in Planning\. Start the agent for this stage\? Nothing starts until you confirm/);
  assert.equal(ctx.executor.started.length, 0);
  byText($('#ask-panel'), 'Not now').click();
  assert.equal($('#ask-panel').hidden, true);
  // Start on entry for Executing; Manual for Planning.
  $('#workflow-open').click();
  const executing = $('#workflow-stages [data-stage="executing"]');
  executing.querySelector('input[value="start"]').checked = true;
  executing.dispatchEvent(new win.Event('change', { bubbles: true }));
  assert.match(executing.querySelector('.workflow-preview').textContent, /starts at once/);
  $('#workflow-stages [data-stage="planning"] input[value="manual"]').checked = true;
  submitForm(ctx, '#workflow-form'); await ctx.idle();
  assert.equal($('#workflow-dialog').open, false);
  let project = (await serverBoard(ctx)).projects[0];
  assert.deepEqual([project.workflow.planning.policy, project.workflow.executing.policy], ['manual', 'start']);
  await moveBy(ctx, 'Beta', 'planning'); await ctx.idle();
  assert.equal($('#ask-panel').hidden, true, 'Manual asks nothing.');
  assert.equal(ctx.executor.started.length, 0);
  await moveBy(ctx, 'Alpha', 'executing'); await ctx.idle();
  assert.equal(ctx.executor.started.length, 1, 'Start on entry started one run.');
  const run = ctx.executor.started[0];
  assert.equal(run.trigger, 'automation');
  const alpha = (await serverTasks(ctx)).find(task => task.title === 'Alpha');
  assert.deepEqual(alpha.transitions.map(item => item.to), ['planning', 'executing'], 'The move is recorded as a transition; the run is a separate record.');
  // Settings changes apply to future runs only.
  $('#workflow-open').click();
  const exec = $('#workflow-stages [data-stage="executing"]');
  exec.querySelector('[data-field="provider"]').value = 'codex';
  submitForm(ctx, '#workflow-form'); await ctx.idle();
  assert.equal((await ctx.app.board.run(run.id)).config.provider, 'claude', 'The active run keeps its configuration snapshot.');
  // To Do stays inert under every setting, and cannot be targeted by a run.
  await ctx.app.board.updateRun(run.id, { status: 'cancelled' }); await win.__pbTest.loadBoard(); await ctx.idle();
  await moveBy(ctx, 'Alpha', 'todo'); await ctx.idle();
  assert.equal(ctx.executor.started.length, 1);
  const refused = await fetch(`${ctx.app.url}/api/tasks/${alpha.id}/runs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ste-token': win.__pbTest.token }, body: JSON.stringify({ stage: 'todo', consent: true }) });
  assert.equal((await refused.json()).code, 'STAGE_NOT_RUNNABLE');
});

test('starting a run needs consent and an acknowledgment for unverified prompts; details show prompt, plan, approval, and history', { skip: process.platform === 'win32' }, async t => {
  const ctx = await linkedKanban(t);
  const { $, win } = ctx;
  await link(ctx);
  const created = await ctx.app.board.createTask({ projectId: ctx.project.id, title: 'Parser', prompt: 'Fix the parser.', source: { provider: 'codex', verification: 'needs-review', quality: 'reviewed' } });
  await ctx.app.board.moveTask(created.id, { column: 'planning', expectedRevision: 1 });
  await win.__pbTest.loadBoard(); await ctx.idle();
  cardItem(ctx, 'Parser').querySelector('.kanban-start').click();
  assert.equal($('#run-dialog').open, true);
  assert.match($('#run-dialog-summary').textContent, /cannot change files/);
  assert.equal($('#run-ack-field').hidden, false, 'An unverified prompt needs an acknowledgment.');
  assert.deepEqual(Array.from($('#run-permission').options, item => item.value), ['plan']);
  submitForm(ctx, '#run-form'); await ctx.idle();
  assert.match($('#run-error').textContent, /Confirm that you reviewed this prompt/);
  assert.equal(ctx.executor.started.length, 0);
  $('#run-ack').checked = true;
  submitForm(ctx, '#run-form'); await ctx.idle();
  assert.equal($('#run-dialog').open, false);
  assert.equal(ctx.executor.started.length, 1);
  const run = ctx.executor.started[0];
  assert.equal(run.trigger, 'user');
  // Simulate the plan turn the real supervisor records from provider events.
  await ctx.app.board.updateRun(run.id, { status: 'running' });
  await ctx.app.board.updateRun(run.id, { status: 'waiting_for_input', turns: 1, hasPlan: true, planExcerpt: 'PLAN' });
  await win.__pbTest.loadBoard(); await ctx.idle();
  assert.match(cardItem(ctx, 'Parser').querySelector('.run-badge').textContent, /Plan waiting for input/);
  assert.equal($('#workspace-list .workspace-live.waiting').textContent, '1 waiting', 'The sidebar shows which project needs attention.');
  cardItem(ctx, 'Parser').querySelector('.kanban-confirm-run').click(); await ctx.idle();
  assert.equal($('#task-dialog').open, true);
  const details = $('#task-details').textContent;
  assert.match(details, /Draft—review needed\. Task text revision 1/);
  assert.match(details, /Fix the parser\./);
  assert.match(details, /PLAN\n1\. Change the parser\./);
  assert.match(details, /Claude Code · CLI default/);
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

test('PB-04 in the UI: commit, configured tests, accepted review, merge preview, confirmed merge; Done only through merge', { skip: process.platform === 'win32', timeout: 60000 }, async t => {
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
  await moveBy(ctx, 'Ship it', 'code_review'); await ctx.idle();
  $('#ask-panel').hidden = true;
  cardItem(ctx, 'Ship it').querySelector('.kanban-start').click();
  submitForm(ctx, '#run-form'); await ctx.idle();
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
  $('#ask-panel').hidden = true;
  cardItem(ctx, 'Ship it').querySelector('.kanban-deliver').click();
  await until(() => byText($('#task-details'), 'Run tests…'), 'run tests button');
  byText($('#task-details'), 'Run tests…').click();
  await click(ctx, byText($('#task-details'), 'Run tests'));
  await until(async () => (await tasks())[0].evidence.tests?.status === 'passed', 'tests passed', 15000);
  $('#task-dialog').close();
  // Merge: the menu never offers Done; the preview shows the plan; the merge needs confirmation.
  await moveBy(ctx, 'Ship it', 'merge'); await ctx.idle();
  assert.ok(!Array.from(cardItem(ctx, 'Ship it').querySelectorAll('.kanban-move-to option'), item => item.value).includes('done'));
  cardItem(ctx, 'Ship it').querySelector('.kanban-deliver').click();
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
  t.after(() => rm(dir, { recursive: true, force: true }));
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

test('Open folder… turns a chosen folder into a linked project, offers Git setup, and reuses a known folder', { skip: process.platform === 'win32' }, async t => {
  const repo = await gitRepo(t);
  const plain = await realpath(await mkdtemp(join(tmpdir(), 'pb-ui-open-')));
  t.after(() => rm(plain, { recursive: true, force: true }));
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
  // A folder without Git becomes a project too, with the Git setup offered (not done).
  await click(ctx, $('#workspace-open'));
  await until(() => names().length === 2 && !$('#repo-setup').hidden, 'second project with the Git setup offer');
  assert.equal($('#project-select').selectedOptions[0].textContent, plain.split('/').pop());
  assert.equal($('#repo-path').value, plain);
  assert.equal($('#repo-setup').hidden, false);
  await assert.rejects(readFile(join(plain, '.git', 'HEAD')));
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
