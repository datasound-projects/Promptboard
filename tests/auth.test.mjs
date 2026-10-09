import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AUTH_CAPABILITIES, logout, readAuthStatus, startLogin } from '../src/auth.mjs';
import { ProviderError } from '../src/providers.mjs';
import { readCodexLimits } from '../src/usage-dashboard.mjs';
import { startTestServer } from './helpers/test-server.mjs';

// Fake CLIs only. These tests never run an installed Codex or Claude binary and never sign anyone out.
async function fakeClis(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ste-auth-test-'));
  const state = join(dir, 'state.json'), log = join(dir, 'log.jsonl');
  await writeFile(state, JSON.stringify({ codex: true, claude: true, authUrl: 'https://auth.example/oauth?state=x', completeAfterMs: 50 }));
  const codex = `#!${process.execPath}
const fs = require('node:fs'); const { createInterface } = require('node:readline');
const args = process.argv.slice(2), state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cli: 'codex', args, pid: process.pid }) + '\\n');
const save = next => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify({ ...state, ...next }));
if (args[0] === 'logout') { save({ codex: false }); process.exit(0); }
if (args[0] !== 'app-server') process.exit(2);
const send = v => process.stdout.write(JSON.stringify(v) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ id: msg.id, result: {} });
  else if (msg.method === 'account/rateLimits/read') send({ id: msg.id, result: { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1791000000 } } } });
  else if (msg.method === 'account/read') send({ id: msg.id, result: { account: state.codex ? { type: 'chatgpt', email: 'private@example.com', planType: 'plus' } : null, requiresOpenaiAuth: true } });
  else if (msg.method === 'account/login/start') {
    const device = msg.params.type === 'chatgptDeviceCode';
    send({ id: msg.id, result: device ? { type: 'chatgptDeviceCode', loginId: 'L1', userCode: 'ABCD-1234', verificationUrl: 'https://auth.example/device' } : { type: 'chatgpt', loginId: 'L1', authUrl: state.authUrl } });
    if (state.completeAfterMs >= 0) setTimeout(() => { save({ codex: true }); send({ method: 'account/login/completed', params: { loginId: 'L1', success: true, error: null } }); }, state.completeAfterMs);
  }
});
`;
  const claude = `#!${process.execPath}
const fs = require('node:fs'); const args = process.argv.slice(2), state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cli: 'claude', args }) + '\\n');
if (args.join(' ') === 'auth status --json') { process.stdout.write(JSON.stringify({ loggedIn: state.claude, authMethod: state.claude ? 'claude.ai' : 'none', email: 'private@example.com' })); process.exit(state.claude ? 0 : 1); }
if (args.join(' ') === 'auth logout') { fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify({ ...state, claude: false })); process.exit(0); }
process.exit(2);
`;
  await writeFile(join(dir, 'codex'), codex); await writeFile(join(dir, 'claude'), claude);
  await chmod(join(dir, 'codex'), 0o700); await chmod(join(dir, 'claude'), 0o700);
  const oldPath = process.env.PATH;
  process.env.PATH = dir;
  t.after(async () => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; await rm(dir, { recursive: true, force: true }); });
  return {
    set: async next => writeFile(state, JSON.stringify({ ...JSON.parse(await readFile(state, 'utf8')), ...next })),
    log: async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
  };
}

test('status reads report sign-in without account identity', { skip: process.platform === 'win32' }, async t => {
  const cli = await fakeClis(t);
  assert.deepEqual(await readAuthStatus('codex'), { state: 'signed-in', method: 'chatgpt' });
  assert.deepEqual(await readAuthStatus('claude'), { state: 'signed-in', method: 'claude.ai' });
  await cli.set({ codex: false, claude: false });
  assert.equal((await readAuthStatus('codex')).state, 'signed-out');
  assert.equal((await readAuthStatus('claude')).state, 'signed-out');
  assert.doesNotMatch(JSON.stringify([await readAuthStatus('codex'), await readAuthStatus('claude')]), /private@example/);
  // Gemini and Antigravity have no documented status command: report unknown, not signed out.
  assert.deepEqual(await readAuthStatus('gemini'), { state: 'unknown' });
  assert.deepEqual(await readAuthStatus('agy'), { state: 'unknown' });
});

test('native Codex sign-in uses app-server login, recovers the account, and never logs out first', { skip: process.platform === 'win32' }, async t => {
  const cli = await fakeClis(t);
  await cli.set({ codex: false });
  const updates = [];
  assert.deepEqual(await startLogin('codex', { onUpdate: update => updates.push(update) }), { state: 'signed-in' });
  assert.deepEqual(updates, [{ authUrl: 'https://auth.example/oauth?state=x' }]);
  assert.equal((await readAuthStatus('codex')).state, 'signed-in');
  const device = [];
  await startLogin('codex', { method: 'device', onUpdate: update => device.push(update) });
  assert.deepEqual(device, [{ verificationUrl: 'https://auth.example/device', userCode: 'ABCD-1234' }]);
  assert.ok(!(await cli.log()).some(entry => entry.args.includes('logout')), 'Reauthentication must not sign out first.');
});

test('sign-in cancellation, timeout, and unsafe URLs fail cleanly', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
  const cli = await fakeClis(t);
  await cli.set({ completeAfterMs: -1 });
  const controller = new AbortController();
  const pending = startLogin('codex', { signal: controller.signal, onUpdate: () => controller.abort() });
  await assert.rejects(pending, { code: 'ABORTED' });
  await assert.rejects(startLogin('codex', { timeoutMs: 150, onUpdate: () => {} }), { code: 'TIMEOUT' });
  const pids = (await cli.log()).filter(entry => entry.args[0] === 'app-server').map(entry => entry.pid);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await cli.set({ authUrl: 'javascript:alert(1)', completeAfterMs: 20 });
  await assert.rejects(startLogin('codex', { onUpdate: () => assert.fail('An unsafe URL must never reach the page.') }), { code: 'AUTH_FAILED' });
});

test('sign-out runs only the documented command; unsupported capabilities are explicit', { skip: process.platform === 'win32' }, async t => {
  const cli = await fakeClis(t);
  await logout('codex'); await logout('claude');
  assert.deepEqual((await cli.log()).map(entry => [entry.cli, entry.args.join(' ')]), [['codex', 'logout'], ['claude', 'auth logout']]);
  assert.equal((await readAuthStatus('claude')).state, 'signed-out');
  for (const provider of ['gemini', 'agy']) await assert.rejects(logout(provider), { code: 'UNSUPPORTED' });
  for (const provider of ['claude', 'gemini', 'agy']) await assert.rejects(startLogin(provider), { code: 'UNSUPPORTED' });
  await assert.rejects(startLogin('codex', { method: 'shell' }), { code: 'UNSUPPORTED' });
  await assert.rejects(readAuthStatus('sh'), { code: 'INVALID_PROVIDER' });
  assert.equal(AUTH_CAPABILITIES.claude.loginCommand, 'claude auth login');
  assert.equal(AUTH_CAPABILITIES.gemini.logout, 'unsupported');
});

// ---- HTTP boundary with a fixture adapter ----

function adapter() {
  const calls = [];
  let gate = null;
  return { calls, hold: () => { let open; gate = new Promise(resolve => { open = resolve; }); return () => { gate = null; open(); }; },
    installed: async () => true,
    status: async provider => { calls.push(['status', provider]); return { state: 'signed-in', method: 'fixture' }; },
    login: async (provider, { method, signal, onUpdate }) => {
      calls.push(['login', provider, method]);
      onUpdate({ authUrl: 'https://auth.example/start' });
      if (gate) await Promise.race([gate, new Promise((_, reject) => signal.addEventListener('abort', () => reject(new ProviderError('Cancelled.', 'ABORTED')), { once: true }))]);
      return { state: 'signed-in' };
    },
    logout: async provider => { calls.push(['logout', provider]); return { state: 'signed-out' }; } };
}

async function open(t, options = {}) {
  const auth = adapter();
  let lookups = 0;
  const app = await startTestServer(t, { port: 0, authAdapter: auth, detector: async () => [{ id: 'codex', available: true }],
    catalogReader: async provider => { lookups++; return { provider, source: 'cli', models: [{ id: 'm', name: 'M', efforts: [] }] }; },
    runner: async () => ({ text: 'Add a test.' }), ...options });
  const { token } = await fetch(app.url + '/api/session').then(r => r.json());
  const post = (path, body, headers = {}) => fetch(app.url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ste-token': token, ...headers }, body: JSON.stringify(body) });
  const get = path => fetch(app.url + path, { headers: { 'x-ste-token': token } });
  const until = async (fn, label) => { const end = Date.now() + 10000; while (!(await fn())) { if (Date.now() > end) assert.fail(label); await new Promise(r => setTimeout(r, 10)); } };
  return { app, auth, token, post, get, until, lookups: () => lookups };
}

test('auth endpoints require the token, local origin, JSON, and explicit sign-out confirmation', async t => {
  const { app, auth, post } = await open(t);
  assert.equal((await fetch(app.url + '/api/auth?provider=codex')).status, 403);
  assert.equal((await fetch(app.url + '/api/status')).status, 403);
  assert.equal((await post('/api/auth/logout', { provider: 'codex', confirm: true }, { 'x-ste-token': 'wrong' })).status, 403);
  assert.equal((await post('/api/auth/logout', { provider: 'codex', confirm: true }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/auth/login', { provider: 'codex' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post('/api/auth/logout', { provider: 'codex', confirm: true }, { 'content-type': 'text/plain' })).status, 415);
  const unconfirmed = await post('/api/auth/logout', { provider: 'codex' });
  assert.equal(unconfirmed.status, 400);
  assert.equal((await unconfirmed.json()).code, 'CONFIRMATION_REQUIRED');
  assert.equal((await post('/api/auth/logout', { provider: 'codex', confirm: 'yes' })).status, 400);
  assert.equal((await post('/api/auth/login', { provider: 'sh' })).status, 400);
  assert.equal((await post('/api/auth/login', { provider: 'codex', method: 'bash -c id' })).status, 400);
  assert.deepEqual(auth.calls.filter(call => call[0] !== 'status'), [], 'No rejected request may reach the CLI.');
});

test('unsupported native sign-in is reported, not simulated', async t => {
  // The real adapter rejects before starting any process for these providers.
  const app = await startTestServer(t, { port: 0, detector: async () => [] });
  const { token } = await fetch(app.url + '/api/session').then(r => r.json());
  for (const provider of ['claude', 'gemini', 'agy']) {
    const response = await fetch(app.url + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ste-token': token }, body: JSON.stringify({ provider }) });
    assert.equal(response.status, 400, provider);
    assert.equal((await response.json()).operation.code, 'UNSUPPORTED');
  }
  const logoutResponse = await fetch(app.url + '/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ste-token': token }, body: JSON.stringify({ provider: 'gemini', confirm: true }) });
  assert.equal(logoutResponse.status, 400);
  assert.equal((await logoutResponse.json()).code, 'UNSUPPORTED');
});

test('auth and generation cannot overlap, and cancelling sign-in frees the next request', async t => {
  let releaseRun, entered, runs = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const { auth, post, get, until } = await open(t, { runner: async () => {
    if (runs++ === 0) { entered(); await new Promise(resolve => { releaseRun = resolve; }); }
    return { text: 'Add a test.' };
  } });
  const generation = post('/api/generate', { input: 'Add a test.', quality: 'fast' });
  await started;
  const blocked = await post('/api/auth/logout', { provider: 'codex', confirm: true });
  assert.equal(blocked.status, 409);
  assert.equal((await post('/api/auth/login', { provider: 'codex' })).status, 409);
  assert.ok(!auth.calls.some(call => call[0] === 'logout'));
  releaseRun();
  assert.equal((await generation).status, 200);
  const release = auth.hold();
  const login = await post('/api/auth/login', { provider: 'codex' });
  assert.equal(login.status, 202);
  assert.equal((await login.json()).operation.authUrl, 'https://auth.example/start');
  const duringAuth = await post('/api/generate', { input: 'Add a test.', quality: 'fast' });
  assert.equal(duringAuth.status, 409);
  assert.equal((await duringAuth.json()).code, 'AUTH_IN_PROGRESS');
  await post('/api/auth/cancel', {});
  await until(async () => (await (await get('/api/status')).json()).auth?.state === 'cancelled', 'cancelled sign-in');
  release();
  assert.equal((await post('/api/generate', { input: 'Add a test.', quality: 'fast' })).status, 200);
});

test('auth failure recovers after sign-in, and auth changes refresh the model cache', async t => {
  let signedIn = false;
  const { post, get, until, lookups } = await open(t, { runner: async () => {
    if (!signedIn) throw new ProviderError('raw stderr SECRET', 'AUTH_REQUIRED');
    return { text: 'Add a test.' };
  } });
  const failed = await post('/api/generate', { input: 'Add a test.', quality: 'fast' });
  const body = await failed.json();
  assert.equal(failed.status, 502);
  assert.equal(body.code, 'AUTH_REQUIRED');
  assert.doesNotMatch(JSON.stringify(body), /SECRET/);
  await get('/api/models?provider=codex');
  await get('/api/models?provider=codex');
  assert.equal(lookups(), 1, 'Models are cached between reads.');
  const status = await (await get('/api/auth?provider=codex')).json();
  assert.equal(status.installed, true);
  assert.equal(status.state, 'signed-in');
  assert.equal(status.capabilities.login, 'native');
  signedIn = true;
  assert.equal((await post('/api/auth/login', { provider: 'codex' })).status, 202);
  await until(async () => (await (await get('/api/status')).json()).auth?.state === 'succeeded', 'sign-in success');
  await get('/api/models?provider=codex');
  assert.equal(lookups(), 2, 'A successful sign-in invalidates the model cache.');
  assert.equal((await post('/api/generate', { input: 'Add a test.', quality: 'fast' })).status, 200);
  assert.equal((await post('/api/auth/logout', { provider: 'codex', confirm: true })).status, 200);
  await get('/api/models?provider=codex');
  assert.equal(lookups(), 3, 'Sign-out invalidates the model cache.');
});


test('Codex usage uses only native read-only metadata and returns normalized allowance', { skip: process.platform === 'win32' }, async t => {
  const cli = await fakeClis(t);
  const usage = await readCodexLimits();
  assert.equal(usage.windows[0].remainingPercent, 75);
  assert.equal(usage.status, 'live');
  assert.deepEqual((await cli.log()).map(entry => entry.args), [['app-server']]);
  assert.doesNotMatch(JSON.stringify(usage), /private@example/);
});
