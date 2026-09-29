import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { startServer } from '../src/server.mjs';

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
async function setup(t, { catalogReader = async id => ({ provider: id, ...catalogs[id], note: 'Native model options.' }), storage, prefs = {}, generationResponse, authAdapter = fakeAuth(), runner } = {}) {
  const calls = [];
  const requests = [];
  const app = await startServer({ port: 0, authAdapter, detector: async () => Object.keys(catalogs).map(id => ({ id, available: true })), catalogReader,
    runner: runner ? async request => { calls.push(request); return runner(request); } : async request => { calls.push(request); return { text: request.prompt.includes('prose in Polish') ? 'Dodaj test.' : request.prompt.includes('prose in German') ? 'Füge einen Test hinzu.' : 'Add a test.', reportedModels: ['actual-model'], durationMs: 3 }; } });
  const dom = new JSDOM(await readFile(new URL('../public/index.html', import.meta.url), 'utf8'), { url: app.url, runScripts: 'outside-only' });
  const win = dom.window;
  win.fetch = (url, options) => {
    if (url === '/api/generate') {
      const request = JSON.parse(options.body);
      requests.push(request);
      if (generationResponse) return Promise.resolve(Response.json(typeof generationResponse === 'function' ? generationResponse(request) : generationResponse));
    }
    return fetch(new URL(url, app.url), options);
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
  let copied;
  Object.defineProperty(win.navigator, 'clipboard', { value: { writeText: async text => { copied = text; } } });
  // Same order as the page: prefs.js runs in <head>, app.js is deferred.
  win.eval(await readFile(new URL('../public/prefs.js', import.meta.url), 'utf8'));
  win.eval(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'));
  t.after(async () => { win.close(); await app.close(); });
  const $ = selector => win.document.querySelector(selector);
  const choose = (id, value) => { $(id).value = value; $(id).dispatchEvent(new win.Event('change', { bubbles: true })); };
  const radio = language => { $(`input[name="language"][value="${language}"]`).checked = true; $(`input[name="language"][value="${language}"]`).dispatchEvent(new win.Event('change')); };
  const submit = () => $('#prompt-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => !$('#generate-button').disabled, 'initial model discovery');
  const quality = value => { $(`input[name="quality"][value="${value}"]`).checked = true; $(`input[name="quality"][value="${value}"]`).dispatchEvent(new win.Event('change')); };
  return { win, $, choose, radio, quality, submit, calls, requests, downloads, blobs, copied: () => copied, authAdapter, app };
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
  assert.match($('.sidebar-footer').textContent, /v0\.3\.0/);
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
  const storage = Array.from({ length: 40 }, (_, index) => ({ id: `entry-${index}`, input: `Request number ${index}`, prompt: `Prompt ${index}`, createdAt: 1790000000000 - index, provider: 'codex' }));
  const { $, win } = await setup(t, { storage });
  assert.equal($('#history-list').children.length, 40);
  assert.equal($('#history-count').textContent, '40');
  assert.equal($('#history-empty').hidden, true);
  win.document.querySelectorAll('.history-restore')[5].click();
  await until(() => !$('#model').disabled, 'restored entry');
  assert.equal($('#prompt-input').value, 'Request number 5');
  assert.equal($('.history-item.active .history-restore').getAttribute('aria-current'), 'true');
  $('.history-item.active .history-delete').click();
  assert.equal($('#history-list').children.length, 39);
  assert.equal($('.history-item.active'), null);
  const stored = JSON.parse(win.localStorage.getItem('ste-prompt-engineer.history.v1'));
  assert.equal(stored.length, 39);
  assert.ok(!stored.some(entry => entry.id === 'entry-5'));
  $('#history-search').value = 'no such request';
  $('#history-search').dispatchEvent(new win.Event('input'));
  assert.equal($('#history-list').children.length, 0);
  assert.equal($('#history-empty').hidden, false);
  assert.match($('#history-empty small').textContent, /Try another word/);
});
