import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyProviderFailure, execute, runProvider, FAILURE_MESSAGES } from '../src/providers.mjs';

const lines = (...events) => events.map(event => JSON.stringify(event)).join('\n') + '\n';
const code = (provider, details) => classifyProviderFailure(provider, details)?.code ?? null;

test('Claude: credits_required is quota exhaustion; other rejections are temporary rate limits', () => {
  const quota = classifyProviderFailure('claude', { stdout: lines(
    { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1790000000, errorCode: 'credits_required' } },
    { type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: 'limit' }) });
  assert.equal(quota.code, 'QUOTA_EXHAUSTED');
  assert.equal(quota.resetsAt, new Date(1790000000 * 1000).toISOString());
  const limited = classifyProviderFailure('claude', { stdout: lines(
    { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1790000000 } },
    { type: 'result', is_error: true, api_error_status: 429 }) });
  assert.equal(limited.code, 'RATE_LIMITED');
  assert.ok(limited.resetsAt);
  // A warning is not a failure, and a bare HTTP 429 is never labelled as exhausted quota.
  assert.equal(code('claude', { stdout: lines({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } }, { type: 'result', is_error: true, api_error_status: 429 }) }), 'RATE_LIMITED');
  const noReset = classifyProviderFailure('claude', { stdout: lines({ type: 'result', is_error: true, api_error_status: 429 }) });
  assert.equal(noReset.resetsAt, undefined, 'Reset times are shown only when the provider supplies one.');
});

test('Claude: structured assistant errors map to auth, model, account, overload, and policy codes', () => {
  const assistant = error => lines({ type: 'assistant', error, message: { content: [] } }, { type: 'result', is_error: true });
  assert.equal(code('claude', { stdout: assistant('authentication_failed') }), 'AUTH_REQUIRED');
  assert.equal(code('claude', { stdout: assistant('model_not_found') }), 'MODEL_UNAVAILABLE');
  assert.equal(code('claude', { stdout: assistant('billing_error') }), 'ACCOUNT_UNAVAILABLE');
  assert.equal(code('claude', { stdout: assistant('overloaded') }), 'PROVIDER_UNAVAILABLE');
  assert.equal(code('claude', { stdout: assistant('oauth_org_not_allowed') }), 'POLICY_DENIED');
  assert.equal(code('claude', { stdout: assistant('rate_limit') }), 'RATE_LIMITED');
  assert.equal(code('claude', { stdout: lines({ type: 'result', is_error: true, api_error_status: 401 }) }), 'AUTH_REQUIRED');
  assert.equal(code('claude', { stdout: assistant('unknown') }), null, 'Unknown failures stay unknown.');
  assert.equal(code('claude', { stdout: 'not json' }), null);
});

test('Gemini: TerminalQuotaError is quota, RetryableQuotaError is a rate limit, exit 41 is auth', () => {
  const json = type => JSON.stringify({ session_id: 'x', error: { type, message: 'SECRET detail', code: 1 } });
  assert.equal(code('gemini', { stderr: json('TerminalQuotaError'), exitCode: 1 }), 'QUOTA_EXHAUSTED');
  assert.equal(code('gemini', { stdout: json('RetryableQuotaError'), exitCode: 1 }), 'RATE_LIMITED');
  assert.equal(code('gemini', { stderr: json('ModelNotFoundError'), exitCode: 1 }), 'MODEL_UNAVAILABLE');
  assert.equal(code('gemini', { stderr: 'Please sign in', exitCode: 41 }), 'AUTH_REQUIRED');
  assert.equal(code('gemini', { stderr: json('SomethingNew'), exitCode: 1 }), null);
});

test('Codex: only the verified usage-limit text is quota; 429 retries are rate limits', () => {
  const failed = message => lines({ type: 'turn.started' }, { type: 'error', message }, { type: 'turn.failed', error: { message } });
  assert.equal(code('codex', { stdout: failed("You've hit your usage limit. Try again at 3:05 PM.") }), 'QUOTA_EXHAUSTED');
  assert.equal(code('codex', { stdout: failed('exceeded retry limit, last status: 429 Too Many Requests') }), 'RATE_LIMITED');
  assert.equal(code('codex', { stdout: failed('unexpected status 401 Unauthorized: token expired') }), 'AUTH_REQUIRED');
  assert.equal(code('codex', { stdout: failed('stream disconnected before completion: connection reset') }), 'NETWORK_ERROR');
  assert.equal(code('codex', { stdout: failed('unexpected status 503 Service Unavailable') }), 'PROVIDER_UNAVAILABLE');
  assert.equal(code('codex', { stdout: failed(JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The 'test-model' model is not supported when using Codex with a ChatGPT account." } })) }), 'MODEL_UNAVAILABLE');
  assert.equal(code('codex', { stdout: failed('Something unusual happened.') }), null);
  // Codex exec does not supply a structured reset time; none is invented.
  assert.equal(classifyProviderFailure('codex', { stdout: failed("You've hit your usage limit. Try again at 3:05 PM.") }).resetsAt, undefined);
});

test('Antigravity: the documented authentication-required result is auth', () => {
  const stdout = lines({ event: 'result', result: { status: 'ERROR', error: 'authentication required' } });
  assert.equal(code('agy', { stdout, exitCode: 1 }), 'AUTH_REQUIRED');
  assert.equal(code('agy', { stdout: lines({ event: 'result', result: { status: 'ERROR' } }), exitCode: 1 }), null);
});

test('real CLI processes return stable codes without leaking diagnostics', { skip: process.platform === 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ste-errors-test-'));
  const oldPath = process.env.PATH;
  t.after(async () => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; await rm(dir, { recursive: true, force: true }); });
  const fake = body => `#!${process.execPath}\nlet input = ''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => {\n${body}\n});\n`;
  await writeFile(join(dir, 'claude'), fake(`
    const scenario = input.includes('QUOTA') ? 'credits_required' : undefined;
    process.stdout.write(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1790000000, ...(scenario ? { errorCode: scenario } : {}) } }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: 'SECRET_TOKEN_abc /Users/private/path' }) + '\\n');
    process.stderr.write('SECRET_TOKEN_abc');
    process.exit(1);`));
  await writeFile(join(dir, 'gemini'), fake(`process.stderr.write(JSON.stringify({ error: { type: 'TerminalQuotaError', message: 'SECRET_TOKEN_abc' } })); process.exit(1);`));
  await writeFile(join(dir, 'codex'), fake(`if (process.argv[2] === 'mcp') { process.stdout.write('[]'); process.exit(0); } process.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'mystery SECRET_TOKEN_abc' } }) + '\\n'); process.exit(1);`));
  for (const name of ['claude', 'gemini', 'codex']) await chmod(join(dir, name), 0o700);
  await writeFile(join(dir, 'package.json'), '{"type":"commonjs"}');
  process.env.PATH = dir;
  const check = async (provider, prompt, expected) => {
    await assert.rejects(runProvider({ provider, prompt, cwd: dir, timeoutMs: 10000 }), error => {
      assert.equal(error.code, expected);
      if (expected !== 'CLI_FAILED') assert.equal(error.message, FAILURE_MESSAGES[expected]);
      assert.doesNotMatch(JSON.stringify({ message: error.message, ...error }), /SECRET_TOKEN|\/Users\/private/);
      return true;
    });
  };
  await check('claude', 'QUOTA please', 'QUOTA_EXHAUSTED');
  await check('claude', 'limit please', 'RATE_LIMITED');
  await check('gemini', 'anything', 'QUOTA_EXHAUSTED');
  await check('codex', 'anything', 'CLI_FAILED'); // Unknown failures remain unknown.
});

test('a CLI that exits while a detached descendant holds stdout still completes promptly', { skip: process.platform === 'win32', timeout: 8000 }, async () => {
  // The grandchild starts its own session, so process-group cleanup cannot reach it.
  const script = `const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
child.unref(); process.stdout.write('done'); process.exit(0);`;
  const started = Date.now();
  const result = await execute({ command: process.execPath, args: ['-e', script], cwd: tmpdir(), timeoutMs: 15000 });
  assert.equal(result.stdout, 'done');
  assert.ok(Date.now() - started < 6000, 'Completion must not wait for the escaped descendant.');
});
