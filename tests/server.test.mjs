import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import http from 'node:http';
import { startServer } from '../src/server.mjs';

const detector = async () => [{ id: 'codex', name: 'Codex', available: true, version: 'test fixture' }];
async function open(t, runner = async () => ({ text: 'Add the route. Do the tests.', provider: 'codex', durationMs: 15 })) {
  const app = await startServer({ port: 0, runner, detector });
  t.after(() => app.close());
  const { token } = await fetch(app.url + '/api/session').then(r => r.json());
  const post = (data, extra = {}) => fetch(app.url + '/api/generate', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-ste-token': token, ...extra }, body: JSON.stringify({ quality: 'fast', ...data }),
  });
  return { ...app, post };
}

test('the endpoint transforms text through a runner and removes the temporary folder', async t => {
  let folder;
  const app = await open(t, async request => {
    folder = request.cwd;
    await access(folder);
    assert.match(request.prompt, /Add a status route/);
    assert.equal(request.provider, 'codex');
    return { text: 'Add a status route. Do the tests.', provider: 'codex', durationMs: 7 };
  });
  const response = await app.post({ input: 'Add a status route', provider: 'codex' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.prompt, 'Add a status route. Do the tests.');
  assert.equal(body.lint.reviewRequired, true);
  assert.ok(body.durationMs >= 0);
  assert.equal(body.verification.calls, 1);
  await assert.rejects(access(folder));
});

test('the endpoint rejects cross-site access, invalid tokens, and rebinding hosts', async t => {
  let calls = 0;
  const app = await open(t, async () => { calls++; return { text: 'No call expected.' }; });
  assert.equal((await app.post({ input: 'Hello' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await app.post({ input: 'Hello' }, { 'x-ste-token': 'wrong' })).status, 403);
  const rebound = await new Promise((resolve, reject) => {
    const req = http.get(app.url + '/api/session', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(rebound, 403);
  assert.equal((await fetch(app.url + '/api/session', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal(calls, 0);
});

test('validation rejects invalid fields before calling a CLI', async t => {
  let calls = 0;
  const app = await open(t, async () => { calls++; return { text: 'No call expected.' }; });
  for (const request of [{ input: '' }, { input: 'Hi', provider: 'sh' }, { input: 'Hi', model: '--unsafe' }, { input: 'Hi', options: { planFirst: 'yes' } }]) {
    assert.equal((await app.post(request)).status, 400);
  }
  assert.equal(calls, 0);
});

test('runner failures do not expose private CLI diagnostics and always clean up', async t => {
  let folder;
  const app = await open(t, async request => { folder = request.cwd; throw new Error('SECRET_API_KEY and private file data'); });
  const response = await app.post({ input: 'Check the route.' });
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /SECRET_API_KEY/);
  await assert.rejects(access(folder));
});

test('only one generation can run at a time', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const app = await open(t, async () => { entered(); await gate; return { text: 'Write one prompt.' }; });
  const first = app.post({ input: 'A request.' });
  await started;
  // 409, not 429: a local busy state must not look like a provider rate limit.
  const second = await app.post({ input: 'A second request.' });
  assert.equal(second.status, 409);
  assert.equal((await second.json()).code, 'BUSY');
  release();
  assert.equal((await first).status, 200);
});

test('browser cancellation reaches the runner', async t => {
  let entered, cancelled;
  const started = new Promise(resolve => { entered = resolve; });
  const stopped = new Promise(resolve => { cancelled = resolve; });
  const app = await open(t, ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { cancelled(); reject(new Error('Cancelled')); }, { once: true });
    entered();
  }));
  const { token } = await fetch(app.url + '/api/session').then(r => r.json());
  const controller = new AbortController();
  const response = fetch(app.url + '/api/generate', { method: 'POST', signal: controller.signal,
    headers: { 'content-type': 'application/json', 'x-ste-token': token }, body: JSON.stringify({ input: 'A request.' }) });
  const rejected = assert.rejects(response, { name: 'AbortError' });
  await started;
  controller.abort();
  await rejected;
  await Promise.race([stopped, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Cancel did not propagate')), 2000); timer.unref(); })]);
});

test('static assets have local security headers and cannot expose source files', async t => {
  const app = await open(t);
  const response = await fetch(app.url + '/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(app.url + '/src/server.mjs')).status, 404);
  const prefs = await fetch(app.url + '/prefs.js');
  assert.equal(prefs.status, 200);
  assert.match(prefs.headers.get('content-type'), /^text\/javascript/);
  const providers = await fetch(app.url + '/api/providers').then(r => r.json());
  assert.equal(providers.providers[0].available, true);
});

test('model lookup is token protected, cached, and validates requested effort before generation', async t => {
  let lookups = 0, calls = 0, last;
  const catalogReader = async provider => {
    lookups++;
    return { provider, source: 'cli', defaultModel: 'test-model', models: [{ id: 'test-model', name: 'Test', efforts: ['low', 'high'] }] };
  };
  const app = await startServer({ port: 0, detector, catalogReader, runner: async request => { calls++; last = request; return { text: 'Dodaj test.', reportedModels: ['resolved-test-model'] }; } });
  t.after(() => app.close());
  const { token } = await fetch(app.url + '/api/session').then(r => r.json());
  const headers = { 'x-ste-token': token };
  assert.equal((await fetch(app.url + '/api/models?provider=codex')).status, 403);
  assert.equal((await fetch(app.url + '/api/models?provider=sh', { headers })).status, 400);
  assert.equal((await fetch(app.url + '/api/models?provider=codex', { headers })).status, 200);
  await fetch(app.url + '/api/models?provider=codex', { headers });
  assert.equal(lookups, 1);
  await fetch(app.url + '/api/models?provider=codex&refresh=1', { headers });
  assert.equal(lookups, 2);
  const post = effort => fetch(app.url + '/api/generate', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ input: 'Add a test.', quality: 'fast', model: 'test-model', provider: 'codex', effort, language: 'pl' }) });
  assert.equal((await post('medium')).status, 400);
  assert.equal(calls, 0);
  const response = await post('high');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(last.model, 'test-model');
  assert.equal(last.effort, 'high');
  assert.match(last.prompt, /Write all headings and prose in Polish/);
  assert.equal(result.language, 'pl');
  assert.deepEqual(result.reportedModels, ['resolved-test-model']);
  assert.equal(result.lint.warnings[0].rule, 'language-review');
  assert.equal(lookups, 2);
});
