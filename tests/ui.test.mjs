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
async function setup(t, { catalogReader = async id => ({ provider: id, ...catalogs[id], note: 'Native model options.' }), storage, kanban, hash = '', generationResponse, authAdapter = fakeAuth(), runner } = {}) {
  const calls = [];
  const requests = [];
  const app = await startServer({ port: 0, authAdapter, detector: async () => Object.keys(catalogs).map(id => ({ id, available: true })), catalogReader,
    runner: runner ? async request => { calls.push(request); return runner(request); } : async request => { calls.push(request); return { text: request.prompt.includes('prose in Polish') ? 'Dodaj test.' : request.prompt.includes('prose in German') ? 'Füge einen Test hinzu.' : 'Add a test.', reportedModels: ['actual-model'], durationMs: 3 }; } });
  const dom = new JSDOM(await readFile(new URL('../public/index.html', import.meta.url), 'utf8'), { url: app.url + hash, runScripts: 'outside-only' });
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
  if (kanban !== undefined) win.localStorage.setItem('ste-prompt-engineer.kanban.v1', typeof kanban === 'string' ? kanban : JSON.stringify(kanban));
  // jsdom has <dialog> without showModal/close.
  win.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  win.HTMLDialogElement.prototype.close = function () { this.open = false; };
  let copied;
  Object.defineProperty(win.navigator, 'clipboard', { value: { writeText: async text => { copied = text; } } });
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

// Kanban page.
const HISTORY_KEY = 'ste-prompt-engineer.history.v1';
const KANBAN_KEY = 'ste-prompt-engineer.kanban.v1';
const storedBoard = win => JSON.parse(win.localStorage.getItem(KANBAN_KEY));
const titles = $ => Array.from($('#card-list').querySelectorAll('.kanban-open'), button => button.textContent);
const byText = (root, text) => Array.from(root.querySelectorAll('button')).find(button => button.textContent === text);
const submitForm = ({ $, win }, selector) => $(selector).dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
const cardItem = ({ $ }, title) => Array.from($('#card-list').children).find(item => item.querySelector('.kanban-open').textContent === title);
async function goTo({ $, win }, hash) {
  win.location.hash = hash;
  await until(() => $('#kanban-view').hidden === (hash !== '#/kanban'), `page ${hash}`);
}
function newProject(ctx, name) { ctx.$('#project-new').click(); ctx.$('#project-name').value = name; submitForm(ctx, '#project-form'); }
function newCard(ctx, title, prompt) { ctx.$('#card-new').click(); ctx.$('#card-title').value = title; ctx.$('#card-prompt').value = prompt; submitForm(ctx, '#card-form'); }
async function importFile({ $, win }, text) {
  $('#project-detail').replaceChildren(); $('#project-detail').hidden = true;
  Object.defineProperty($('#import-file'), 'files', { value: [new File([text], 'backup.json', { type: 'application/json' })], configurable: true });
  $('#import-file').dispatchEvent(new win.Event('change'));
  await until(() => !$('#project-detail').hidden, 'import result');
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
  newProject(ctx, 'Alpha');
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
  // A reload on the Kanban address opens the Kanban page.
  const reloaded = await setup(t, { hash: '#/kanban', kanban: win.localStorage.getItem(KANBAN_KEY) });
  assert.equal(reloaded.$('#kanban-view').hidden, false);
  assert.equal(reloaded.$('#project-select').selectedOptions[0].textContent, 'Alpha');
});

test('Add to Kanban stores an exact prompt snapshot with secondary metadata; card edits never change history', async t => {
  const exact = '  Leading spaces stay.\r\nCRLF line.\n\n\tTabbed <script>alert(1)</script> — ünïcødé ✓ 🚀\n' + 'Long line. '.repeat(80) + '\n  trailing  \n';
  let result = { prompt: exact, provider: 'codex', reportedModels: ['actual-model'], verification: report({ status: 'needs-review' }) };
  const ctx = await setup(t, { generationResponse: () => result });
  const { $, win, submit, requests, choose, radio, copied } = ctx;
  choose('#model', 'codex-one'); choose('#effort', 'high'); radio('de');
  $('#prompt-input').value = 'Build   the\nexport endpoint with tests.'; submit();
  await until(() => requests.length === 1 && !$('#generate-button').disabled, 'result');
  const historyBefore = win.localStorage.getItem(HISTORY_KEY);
  const entry = JSON.parse(historyBefore)[0];
  $('#kanban-button').click();
  assert.equal($('#add-dialog').open, true);
  assert.equal($('#add-project').value, '');
  assert.equal($('#add-project-name-field').hidden, false);
  assert.equal($('#add-title').value, 'Build the export endpoint with tests.');
  assert.equal($('#add-preview').textContent, exact);
  assert.match($('#add-note').textContent, /exact prompt/);
  submitForm(ctx, '#add-form');
  assert.match($('#add-error').textContent, /project name/);
  assert.equal(win.localStorage.getItem(KANBAN_KEY), null);
  $('#add-project-name').value = 'Alpha';
  submitForm(ctx, '#add-form');
  assert.equal($('#add-dialog').open, false);
  const card = storedBoard(win).projects[0].cards[0];
  assert.equal(card.prompt, exact);
  assert.equal(card.title, 'Build the export endpoint with tests.');
  assert.deepEqual(card.source, { historyId: entry.id, provider: 'codex', model: 'codex-one', effort: 'high', reportedModels: ['actual-model'], language: 'de', quality: 'reviewed', verification: 'needs-review', generatedAt: entry.createdAt });
  assert.equal(card.checksOutdated, false);
  // A second prompt with passed checks goes to the preselected existing project.
  result = { prompt: 'Second prompt.', provider: 'codex', verification: report() };
  submit(); await until(() => requests.length === 2 && !$('#generate-button').disabled, 'second result');
  $('#kanban-button').click();
  assert.equal($('#add-project').value, storedBoard(win).projects[0].id);
  assert.equal($('#add-project-name-field').hidden, true);
  submitForm(ctx, '#add-form');
  assert.equal(storedBoard(win).projects.length, 1);
  await goTo(ctx, '#/kanban');
  const [draft, passed] = $('#card-list').children;
  assert.ok(draft.classList.contains('needs-review'));
  assert.equal(draft.querySelector('.kanban-status').textContent, 'Draft—review needed');
  assert.equal(draft.querySelector('.kanban-meta').textContent, 'Codex · codex-one · Deutsch');
  assert.ok(draft.querySelector('.kanban-preview').textContent.length <= 400);
  assert.equal($('#card-list script'), null);
  assert.ok(!passed.classList.contains('needs-review'));
  assert.equal(passed.querySelector('.kanban-status').textContent, 'Checks complete—review before use');
  draft.querySelector('.kanban-copy').click();
  await until(() => copied() === exact, 'exact copy');
  // Open and save without changes: the stored text and status stay the same.
  draft.querySelector('.kanban-open').click();
  assert.equal($('#card-dialog').open, true);
  assert.match($('#card-note').textContent, /marks the previous checks as outdated/);
  assert.match($('#card-source-list').textContent, /Models reported: actual-model/);
  submitForm(ctx, '#card-form');
  assert.equal(storedBoard(win).projects[0].cards[0].prompt, exact);
  assert.equal(storedBoard(win).projects[0].cards[0].checksOutdated, false);
  // A real edit marks the old checks as outdated and leaves history alone.
  $('#card-list .kanban-open').click();
  $('#card-prompt').value = 'Edited prompt.';
  submitForm(ctx, '#card-form');
  const edited = storedBoard(win).projects[0].cards[0];
  assert.equal(edited.prompt, 'Edited prompt.');
  assert.equal(edited.checksOutdated, true);
  assert.equal(edited.source.verification, 'needs-review');
  assert.equal($('#card-list .kanban-status').textContent, 'Edited—previous checks outdated');
  assert.deepEqual(JSON.parse(win.localStorage.getItem(HISTORY_KEY)).find(item => item.id === entry.id), entry);
  Array.from($('#history-list').querySelectorAll('.history-restore')).at(-1).click();
  await until(() => !$('#prompt-view').hidden, 'restored on prompt page');
  assert.equal($('#prompt-output').textContent, exact);
});

test('projects keep separate boards; names are validated; deletion needs confirmation', async t => {
  const history = [{ id: 'h1', input: 'Old request.', prompt: 'Old prompt.', provider: 'codex' }];
  const ctx = await setup(t, { storage: history });
  const { $, win, choose } = ctx;
  await goTo(ctx, '#/kanban');
  assert.match($('#board-empty').textContent, /Create a project to start planning/);
  assert.equal($('#card-new').disabled, true);
  assert.equal($('#project-delete').disabled, true);
  newProject(ctx, 'Alpha');
  const alpha = storedBoard(win).selectedProjectId;
  newCard(ctx, 'A1', 'Prompt A1'); newCard(ctx, 'A2', 'Prompt A2');
  newProject(ctx, 'Beta');
  assert.notEqual($('#project-select').value, alpha);
  assert.deepEqual(titles($), []);
  assert.match($('#board-empty').textContent, /No tasks yet/);
  newCard(ctx, 'B1', 'Prompt B1');
  choose('#project-select', alpha);
  assert.deepEqual(titles($), ['A1', 'A2']);
  assert.equal($('#todo-count').textContent, '02');
  $('#project-new').click(); $('#project-name').value = ' beta '; submitForm(ctx, '#project-form');
  assert.match($('#project-error').textContent, /already exists/);
  $('#project-name').value = '   '; submitForm(ctx, '#project-form');
  assert.match($('#project-error').textContent, /Enter a project name/);
  $('#project-cancel').click();
  assert.equal(storedBoard(win).projects.length, 2);
  $('#project-rename').click();
  assert.equal($('#project-name').value, 'Alpha');
  $('#project-name').value = 'Alpha renamed'; submitForm(ctx, '#project-form');
  assert.equal($('#project-select').selectedOptions[0].textContent, 'Alpha renamed');
  $('#project-delete').click();
  assert.match($('#project-detail').textContent, /Delete “Alpha renamed” and its 2 cards\? This cannot be undone/);
  byText($('#project-detail'), 'Keep project').click();
  assert.equal($('#project-detail').hidden, true);
  assert.equal(storedBoard(win).projects.length, 2);
  $('#project-delete').click();
  byText($('#project-detail'), 'Delete project').click();
  const board = storedBoard(win);
  assert.deepEqual(board.projects.map(project => project.name), ['Beta']);
  assert.deepEqual(board.projects[0].cards.map(card => card.title), ['B1']);
  assert.equal(board.selectedProjectId, board.projects[0].id);
  assert.deepEqual(titles($), ['B1']);
  assert.equal(win.localStorage.getItem(HISTORY_KEY), JSON.stringify(history));
});

test('cards are created, edited, duplicated, deleted, and reordered by keyboard or drag-and-drop; the order persists', async t => {
  const ctx = await setup(t);
  const { $, win, copied } = ctx;
  await goTo(ctx, '#/kanban');
  newProject(ctx, 'Work');
  $('#card-new').click(); submitForm(ctx, '#card-form');
  assert.match($('#card-error').textContent, /title/);
  $('#card-title').value = 'Only a title'; submitForm(ctx, '#card-form');
  assert.match($('#card-error').textContent, /prompt/);
  $('#card-cancel').click();
  assert.equal(storedBoard(win).projects[0].cards.length, 0);
  newCard(ctx, 'One', 'Prompt one'); newCard(ctx, 'Two', 'Prompt two'); newCard(ctx, 'Three', 'Prompt three');
  assert.deepEqual(titles($), ['One', 'Two', 'Three']);
  assert.equal(cardItem(ctx, 'One').querySelector('.kanban-status').textContent, 'Manual card—not checked');
  assert.ok(!cardItem(ctx, 'One').classList.contains('needs-review'));
  assert.equal(cardItem(ctx, 'One').querySelector('.kanban-move-up').disabled, true);
  assert.equal(cardItem(ctx, 'Three').querySelector('.kanban-move-down').disabled, true);
  assert.equal(cardItem(ctx, 'One').querySelector('.kanban-move-down').getAttribute('aria-label'), 'Move down: One');
  // Keyboard reorder keeps focus on the moved card.
  cardItem(ctx, 'One').querySelector('.kanban-move-down').click();
  assert.deepEqual(titles($), ['Two', 'One', 'Three']);
  assert.equal(win.document.activeElement, cardItem(ctx, 'One').querySelector('.kanban-move-down'));
  assert.match($('#announcement').textContent, /Moved “One” to position 2 of 3/);
  cardItem(ctx, 'One').querySelector('.kanban-move-down').click();
  assert.deepEqual(titles($), ['Two', 'Three', 'One']);
  assert.equal(win.document.activeElement, cardItem(ctx, 'One').querySelector('.kanban-move-up'));
  cardItem(ctx, 'One').querySelector('.kanban-move-up').click();
  assert.deepEqual(titles($), ['Two', 'One', 'Three']);
  // Drag-and-drop: drop "Three" on "Two".
  cardItem(ctx, 'Three').dispatchEvent(new win.Event('dragstart', { bubbles: true }));
  const over = new win.Event('dragover', { bubbles: true, cancelable: true });
  cardItem(ctx, 'Two').dispatchEvent(over);
  assert.equal(over.defaultPrevented, true);
  cardItem(ctx, 'Two').dispatchEvent(new win.Event('drop', { bubbles: true, cancelable: true }));
  assert.deepEqual(titles($), ['Three', 'Two', 'One']);
  assert.deepEqual(storedBoard(win).projects[0].cards.map(card => card.title), ['Three', 'Two', 'One']);
  // Edit a manual card.
  cardItem(ctx, 'Two').querySelector('.kanban-open').click();
  assert.equal($('#card-prompt').value, 'Prompt two');
  $('#card-title').value = 'Two edited'; $('#card-prompt').value = 'Prompt two, edited.';
  submitForm(ctx, '#card-form');
  const editedCard = storedBoard(win).projects[0].cards[1];
  assert.equal(editedCard.title, 'Two edited'); assert.equal(editedCard.prompt, 'Prompt two, edited.'); assert.equal(editedCard.checksOutdated, false);
  // Duplicate goes right after the original.
  cardItem(ctx, 'Two edited').querySelector('.kanban-duplicate').click();
  assert.deepEqual(titles($), ['Three', 'Two edited', 'Two edited (copy)', 'One']);
  const cards = storedBoard(win).projects[0].cards;
  assert.notEqual(cards[2].id, cards[1].id);
  assert.equal(cards[2].prompt, cards[1].prompt);
  // Delete needs a confirmation.
  cardItem(ctx, 'Two edited (copy)').querySelector('.kanban-delete').click();
  assert.match($('#card-list').textContent, /Delete “Two edited \(copy\)”\? This cannot be undone/);
  byText($('#card-list'), 'Keep card').click();
  assert.equal(storedBoard(win).projects[0].cards.length, 4);
  cardItem(ctx, 'Two edited (copy)').querySelector('.kanban-delete').click();
  byText($('#card-list'), 'Delete card').click();
  assert.deepEqual(titles($), ['Three', 'Two edited', 'One']);
  cardItem(ctx, 'One').querySelector('.kanban-copy').click();
  await until(() => copied() === 'Prompt one', 'copy');
  // Reload: projects, order, and selection come back.
  const reloaded = await setup(t, { kanban: win.localStorage.getItem(KANBAN_KEY) });
  await goTo(reloaded, '#/kanban');
  assert.deepEqual(titles(reloaded.$), ['Three', 'Two edited', 'One']);
  assert.equal(reloaded.$('#project-select').selectedOptions[0].textContent, 'Work');
});

test('board export round-trips; import validates the whole file and asks before it replaces the board', async t => {
  const exact = 'Line 1\r\n  indented <b>x</b>\n';
  const backup = { application: 'AI Prompt Engineer', kind: 'kanban-backup', version: 1, selectedProjectId: 'p2', projects: [
    { id: 'p1', name: 'One', createdAt: 1, cards: [{ id: 'c1', title: 'Card 1', prompt: exact, createdAt: 1, updatedAt: 1, checksOutdated: false,
      source: { historyId: 'h', provider: 'claude', model: 'opus', effort: '', reportedModels: [], language: 'pl', quality: 'fast', verification: 'checks-passed', generatedAt: 1 } }] },
    { id: 'p2', name: 'Two', createdAt: 2, cards: [] },
  ] };
  const current = { version: 1, selectedProjectId: 'x', projects: [{ id: 'x', name: 'Current', createdAt: 1, cards: [{ id: 'y', title: 'Keep me', prompt: 'Keep.', createdAt: 1, updatedAt: 1, checksOutdated: false, source: null }] }] };
  const ctx = await setup(t, { kanban: current });
  const { $, win, choose, downloads, blobs } = ctx;
  await goTo(ctx, '#/kanban');
  const before = win.localStorage.getItem(KANBAN_KEY);
  const withCard = changes => JSON.stringify({ ...backup, projects: [{ ...backup.projects[0], cards: [{ ...backup.projects[0].cards[0], ...changes }] }] });
  for (const [text, message] of [
    ['not json', /not valid JSON/],
    [JSON.stringify({ ...backup, kind: 'other' }), /not a Kanban backup/],
    [JSON.stringify({ ...backup, version: 2 }), /version 1/],
    [withCard({ prompt: '' }), /card 1 needs a prompt/],
    [withCard({ title: 'x'.repeat(121) }), /title needs 1 to 120/],
    [JSON.stringify({ ...backup, projects: [backup.projects[0], { ...backup.projects[1], id: 'p1' }] }), /unique ID/],
  ]) {
    await importFile(ctx, text);
    assert.match($('#project-detail').textContent, /Import failed\. Your board is unchanged\./);
    assert.match($('#project-detail').textContent, message);
    assert.equal(win.localStorage.getItem(KANBAN_KEY), before);
  }
  await importFile(ctx, JSON.stringify(backup));
  assert.match($('#project-detail').textContent, /Replace the current board \(1 project, 1 card\) with this backup \(2 projects, 1 card\)\?/);
  byText($('#project-detail'), 'Keep current board').click();
  assert.equal(win.localStorage.getItem(KANBAN_KEY), before);
  assert.deepEqual(titles($), ['Keep me']);
  await importFile(ctx, JSON.stringify(backup));
  byText($('#project-detail'), 'Replace board').click();
  const board = storedBoard(win);
  assert.deepEqual(board.projects.map(project => project.name), ['One', 'Two']);
  assert.equal(board.selectedProjectId, 'p2');
  assert.equal(board.projects[0].cards[0].prompt, exact);
  choose('#project-select', 'p1');
  assert.equal($('#card-list .kanban-status').textContent, 'Automatic checks only—review before use');
  assert.equal($('#card-list .kanban-meta').textContent, 'Claude Code · opus · Polski');
  $('#export-board').click();
  assert.match(downloads.at(-1), /^ste-kanban-backup-\d{4}-\d\d-\d\d\.json$/);
  const exportedText = await blobs.at(-1).text();
  const exported = JSON.parse(exportedText);
  assert.equal(exported.kind, 'kanban-backup');
  assert.deepEqual(exported.projects, storedBoard(win).projects);
  // An empty board imports without a confirmation.
  const fresh = await setup(t);
  await goTo(fresh, '#/kanban');
  await importFile(fresh, exportedText);
  assert.match(fresh.$('#project-detail').textContent, /Backup imported: 2 projects, 1 card/);
  assert.deepEqual(storedBoard(fresh.win).projects, exported.projects);
  assert.equal(storedBoard(fresh.win).selectedProjectId, 'p1');
});

test('Kanban storage failures stay visible, keep the board usable, and keep unreadable saved data', async t => {
  const ctx = await setup(t, { generationResponse: { prompt: 'Add a test.', verification: report() } });
  const { $, win, submit, requests, downloads } = ctx;
  $('#prompt-input').value = 'Add a test.'; submit();
  await until(() => requests.length === 1 && !$('#generate-button').disabled, 'result');
  const setItem = win.Storage.prototype.setItem;
  win.Storage.prototype.setItem = () => { throw new win.DOMException('Storage is full.', 'QuotaExceededError'); };
  $('#kanban-button').click();
  $('#add-project-name').value = 'Alpha';
  submitForm(ctx, '#add-form');
  assert.equal($('#prompt-view .board-warning').hidden, false);
  assert.match($('#announcement').textContent, /for this session only/);
  assert.equal(win.localStorage.getItem(KANBAN_KEY), null);
  await goTo(ctx, '#/kanban');
  assert.equal($('#kanban-view .board-warning').hidden, false);
  assert.match($('#kanban-view .board-warning').textContent, /Export a backup/);
  newCard(ctx, 'Manual', 'Manual prompt.');
  assert.deepEqual(titles($), ['Add a test.', 'Manual']);
  $('#export-board').click();
  assert.equal(downloads.length, 1);
  win.Storage.prototype.setItem = setItem;
  cardItem(ctx, 'Manual').querySelector('.kanban-move-up').click();
  assert.equal($('#kanban-view .board-warning').hidden, true);
  assert.deepEqual(storedBoard(win).projects[0].cards.map(card => card.title), ['Manual', 'Add a test.']);
  // Unreadable saved data is reported and kept, not silently replaced.
  const raw = '{"version":1,"projects":[{"id":"p"';
  const broken = await setup(t, { kanban: raw });
  assert.equal(broken.$('#kanban-load-warning').hidden, false);
  assert.match(broken.$('#kanban-load-warning').textContent, /could not be read/);
  assert.equal(broken.win.localStorage.getItem(`${KANBAN_KEY}.unreadable`), raw);
  assert.equal(broken.win.localStorage.getItem(KANBAN_KEY), raw);
});
