import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.mjs';
import { runPipeline } from '../src/pipeline.mjs';
import { validateRequest } from '../src/engine.mjs';
import { ProviderError } from '../src/providers.mjs';

const detector = async () => [{ id: 'codex', name: 'Codex', available: true }];
async function open(t, runner, options = {}) {
  const app = await startServer({ port: 0, runner, detector, authAdapter: { installed: async () => true, status: async () => ({ state: 'unknown' }) }, ...options });
  t.after(() => app.close());
  const { token } = await fetch(app.url + '/api/session').then(r => r.json());
  const post = (data, signal) => fetch(app.url + '/api/generate', { method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-ste-token': token }, body: JSON.stringify({ quality: 'fast', input: 'Add a test.', ...data }) });
  const status = () => fetch(app.url + '/api/status', { headers: { 'x-ste-token': token } }).then(r => r.json());
  return { ...app, post, status };
}
const waitFor = async (fn, label, ms = 3000) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) assert.fail(`Timed out: ${label}`); await new Promise(r => setTimeout(r, 10)); } };

test('a timeout reaches a terminal state with a stable code, and the next request succeeds', async t => {
  let calls = 0;
  const app = await open(t, async () => { if (calls++ === 0) throw new ProviderError('stderr: /Users/me/.secret', 'TIMEOUT'); return { text: 'Add a test.' }; });
  const first = await app.post();
  assert.equal(first.status, 504);
  const body = await first.json();
  assert.equal(body.code, 'TIMEOUT');
  assert.doesNotMatch(JSON.stringify(body), /secret/);
  assert.equal((await app.status()).busy, null, 'Busy state is cleared after a failure.');
  assert.equal((await app.post()).status, 200);
});

test('the pipeline deadline is reported as a timeout, not an unknown error', async t => {
  // AbortSignal.timeout rejects with a TimeoutError DOMException when the six-minute deadline passes.
  await assert.rejects(runPipeline(validateRequest({ input: 'Add a test.', quality: 'fast' }), {
    runner: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), timeoutMs: 30,
  }), { name: 'TimeoutError' });
  const app = await open(t, async () => { throw new DOMException('The operation timed out.', 'TimeoutError'); });
  const response = await app.post();
  assert.equal(response.status, 504);
  assert.equal((await response.json()).code, 'TIMEOUT');
});

test('cancellation stops the run, and an immediate new request is not blocked', async t => {
  let calls = 0, stopped;
  const cancelled = new Promise(resolve => { stopped = resolve; });
  const app = await open(t, ({ signal }) => {
    if (calls++ > 0) return Promise.resolve({ text: 'Add a test.' });
    return new Promise((_, reject) => signal.addEventListener('abort', () => {
      // Simulate a CLI that needs a moment to exit after cancellation.
      setTimeout(() => { stopped(); reject(new ProviderError('Cancelled.', 'ABORTED')); }, 150);
    }, { once: true }));
  });
  const controller = new AbortController();
  const first = app.post({}, controller.signal).catch(error => error);
  await waitFor(async () => (await app.status()).busy?.stage === 'draft', 'draft stage');
  controller.abort();
  assert.equal((await first).name, 'AbortError');
  // Sent before the old CLI has exited: the server waits briefly instead of returning 409.
  const second = await app.post();
  assert.equal(second.status, 200);
  await cancelled;
});

test('duplicate submissions are rejected while one runs, and progress reports the stage', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const app = await open(t, async () => { await gate; return { text: 'Add a test.' }; });
  const first = app.post();
  await waitFor(async () => (await app.status()).busy?.stage === 'draft', 'draft stage');
  const progress = await app.status();
  assert.equal(progress.busy.kind, 'generate');
  assert.ok(progress.busy.elapsedMs >= 0);
  const duplicate = await app.post();
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).code, 'BUSY');
  release();
  assert.equal((await first).status, 200);
  assert.equal((await app.status()).busy, null);
});

test('provider reset times pass through only when supplied', async t => {
  let error;
  const app = await open(t, async () => { throw error; });
  error = Object.assign(new ProviderError('x', 'RATE_LIMITED'), { resetsAt: '2026-10-01T12:00:00.000Z' });
  const limited = await (await app.post()).json();
  assert.deepEqual([limited.code, limited.resetsAt], ['RATE_LIMITED', '2026-10-01T12:00:00.000Z']);
  assert.match(limited.error, /temporarily limiting/);
  error = new ProviderError('x', 'QUOTA_EXHAUSTED');
  const quota = await (await app.post()).json();
  assert.equal(quota.code, 'QUOTA_EXHAUSTED');
  assert.equal(quota.resetsAt, undefined);
  error = new Error('/Users/private/secret-path failure');
  const unknown = await (await app.post()).json();
  assert.equal(unknown.code, 'UNKNOWN');
  assert.doesNotMatch(unknown.error, /private/);
});

test('a slow model lookup cannot outlive cancellation of the generation', async t => {
  let release;
  const app = await open(t, async () => ({ text: 'Add a test.' }), {
    catalogReader: () => new Promise(resolve => { release = () => resolve({ models: [] }); }),
  });
  const controller = new AbortController();
  const pending = app.post({ effort: 'high' }, controller.signal).catch(error => error);
  await waitFor(async () => (await app.status()).busy?.stage === 'models', 'model stage');
  controller.abort();
  await pending;
  await waitFor(async () => (await app.status()).busy === null, 'busy cleared while lookup still pending');
  release();
});

test('a rate limit during review stops further calls instead of repairing', async () => {
  let calls = 0;
  const result = await runPipeline(validateRequest({ input: 'Keep `src/a.ts`.', quality: 'reviewed' }), { runner: async () => {
    calls++;
    if (calls === 1) return { text: 'Change the file.' }; // Loses the literal: normally triggers repair.
    throw new ProviderError('x', 'RATE_LIMITED');
  } });
  assert.equal(calls, 2);
  assert.equal(result.verification.review.errorCode, 'RATE_LIMITED');
  assert.equal(result.verification.repaired, false);
  assert.equal(result.verification.stages.at(-1).errorCode, 'RATE_LIMITED');
});

// ---- Real process: signals, owned-process cleanup, and port release ----

const root = fileURLToPath(new URL('../', import.meta.url));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const canBind = port => new Promise(resolve => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });

async function startApp(t, dir, port) {
  const child = spawn(process.execPath, ['bin/ste.mjs', '--gui', '--no-open', '--port', String(port)], { cwd: root, env: { ...process.env, PATH: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await waitFor(() => output.includes(`127.0.0.1:${port}`), 'app start', 5000);
  const url = `http://127.0.0.1:${port}`;
  const { token } = await fetch(url + '/api/session').then(r => r.json());
  return { child, exited, url, token, output: () => output };
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ste-shutdown-test-'));
  const report = join(dir, 'report.jsonl');
  // A fake Codex CLI that ignores SIGTERM and hangs, for both `exec` and `app-server`.
  await writeFile(join(dir, 'codex'), `#!${process.execPath}
const fs = require('node:fs');
process.on('SIGTERM', () => {});
fs.appendFileSync(${JSON.stringify(report)}, JSON.stringify({ pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
process.stdin.resume();
setInterval(() => {}, 1000);
`);
  await chmod(join(dir, 'codex'), 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const reports = async () => (await readFile(report, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { dir, reports };
}

for (const [signal, phase] of [['SIGINT', 'generation'], ['SIGTERM', 'model discovery'], ['SIGHUP', 'idle']]) {
  test(`${signal} during ${phase} stops owned CLIs, removes temp folders, and frees the port`, { skip: process.platform === 'win32', timeout: 20000 }, async t => {
    const { dir, reports } = await fixture(t);
    const port = await freePort();
    const app = await startApp(t, dir, port);
    const headers = { 'x-ste-token': app.token, 'content-type': 'application/json' };
    if (phase === 'generation') fetch(app.url + '/api/generate', { method: 'POST', headers, body: JSON.stringify({ input: 'Add a test.', provider: 'codex', quality: 'fast' }) }).catch(() => {});
    if (phase === 'model discovery') fetch(app.url + '/api/models?provider=codex', { headers }).catch(() => {});
    if (phase !== 'idle') await waitFor(async () => (await reports()).length > 0, `${phase} CLI started`, 5000);
    const sent = Date.now();
    app.child.kill(signal);
    const result = await app.exited;
    assert.equal(result.code, 0, app.output());
    assert.ok(Date.now() - sent < 8000, 'Shutdown is bounded.');
    assert.ok(await canBind(port), 'The same port can be bound immediately after shutdown.');
    for (const { pid, cwd } of await reports()) {
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'Owned CLI processes are stopped.');
      await assert.rejects(access(cwd), { code: 'ENOENT' }, 'Owned temporary folders are removed.');
    }
  });
}

test('a port held by another process is reported and that process is left alone', { skip: process.platform === 'win32', timeout: 10000 }, async () => {
  const holder = net.createServer();
  await new Promise(resolve => holder.listen(0, '127.0.0.1', resolve));
  const { port } = holder.address();
  try {
    const child = spawn(process.execPath, ['bin/ste.mjs', '--gui', '--no-open', '--port', String(port)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise(resolve => child.once('close', resolve));
    assert.equal(code, 1);
    assert.match(output, new RegExp(`Port ${port} is already in use`));
    assert.match(output, /--port/);
    assert.equal(holder.listening, true, 'The unrelated listener keeps running.');
  } finally { await new Promise(resolve => holder.close(resolve)); }
});
