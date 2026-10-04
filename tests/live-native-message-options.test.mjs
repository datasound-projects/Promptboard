import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/live-native-messages.mjs', import.meta.url));
for (const [args, message] of [
  [['--provider', 'unsupported'], /Use provider claude, codex or gemini/],
  [['--timeout', '181'], /Timeout must be between 1 and 180 seconds/],
  [['--model', '-untrusted-flag'], /Use a model ID without spaces or command flags/],
  [['--effort', 'unsupported'], /effort/],
]) test(`live native smoke rejects ${args[0]} before filesystem setup or a CLI launch`, () => {
  const missing = join(tmpdir(), 'pb-live-native-options-missing-directory', 'never-created');
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000,
    env: { ...process.env, TMPDIR: missing, TMP: missing, TEMP: missing } });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.match(result.stderr, message); assert.doesNotMatch(result.stderr, /ENOENT|AUTH_REQUIRED/);
});

test('the live smoke harness confirms exact private delivery and cleans up with an offline owned CLI', { skip: process.platform === 'win32', timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-live-harness-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const bin = join(dir, 'bin'), capture = join(dir, 'messages.jsonl'); await mkdir(bin);
  const fixture = fileURLToPath(new URL('./fixtures/fake-native-message.cjs', import.meta.url));
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\nrequire(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
  const result = spawnSync(process.execPath, [script, '--provider', 'claude', '--timeout', '20'], {
    encoding: 'utf8', timeout: 25000, env: { ...process.env, PATH: bin + delimiter + process.env.PATH,
      TMPDIR: dir, TMP: dir, TEMP: dir, FAKE_NATIVE_MESSAGE_REPORT: capture,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.equal(result.status, 0, result.stderr); const report = JSON.parse(result.stdout);
  assert.equal(report.initial.ready, true); assert.equal(report.initial.manualInputObserved, false);
  assert.equal(report.sameRun, true); assert.deepEqual(report.message,
    { status: 'confirmed', confirmed: true, receiptStatus: 'confirmed', submitted: true });
  for (const key of ['exactPrompt', 'mainCheckoutClean', 'worktreeClean', 'processStopped']) assert.equal(report[key], true, key);
  assert.equal(report.errorCode, undefined);
  const records = (await readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.filter(row => row.kind === 'initial').length, 1);
  assert.deepEqual(records.filter(row => row.kind === 'submitted').map(row => row.text),
    ['Reply exactly PB_NATIVE_SECOND. Do not use tools or change any file.']);
  assert.deepEqual((await readdir(dir)).filter(name => /^pb-live-native-(data|repo)-/.test(name)), []);
});
