import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
  [['--provider', 'claude', '--column-automation', '--busy-queue'], /Busy queue requires provider codex and --column-automation/],
  [['--provider', 'codex', '--busy-queue'], /Busy queue requires provider codex and --column-automation/],
]) test(`live native smoke rejects ${args[0]} before filesystem setup or a CLI launch`, () => {
  const missing = join(tmpdir(), 'pb-live-native-options-missing-directory', 'never-created');
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000,
    env: { ...process.env, TMPDIR: missing, TMP: missing, TEMP: missing } });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.match(result.stderr, message); assert.doesNotMatch(result.stderr, /ENOENT|AUTH_REQUIRED/);
});

for (const steers of [false, true]) test(`the offline Codex busy check ${steers ? 'refuses steering' : 'proves queued completion'} and retains its manual guard`, { skip: process.platform === 'win32', timeout: 25000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-live-codex-queue-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const bin = join(dir, 'bin'), capture = join(dir, 'messages.jsonl'); await mkdir(bin);
  const fixture = fileURLToPath(new URL('./fixtures/fake-codex-queue.cjs', import.meta.url));
  await writeFile(join(bin, 'codex'), `#!${process.execPath}\nrequire(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
  const result = spawnSync(process.execPath, [script, '--provider', 'codex', '--timeout', '18', '--column-automation', '--busy-queue'], {
    encoding: 'utf8', timeout: 22000, env: { ...process.env, PATH: bin + delimiter + process.env.PATH,
      TMPDIR: dir, TMP: dir, TEMP: dir, CODEX_HOME: join(dir, 'codex-fixture'), FAKE_NATIVE_MESSAGE_REPORT: capture,
      ...(steers ? { FAKE_CODEX_QUEUE_STEERS: '1' } : {}), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.equal(result.status, 0, result.stderr); const report = JSON.parse(result.stdout);
  assert.equal(report.initial.ready, true); assert.equal(report.sameRun, true); assert.equal(report.message.confirmed, true);
  assert.equal(report.busy.observed, true); assert.equal(report.busy.pasted, true); assert.equal(report.busy.queuedBeforeCompletion, true);
  assert.equal(report.busy.manualInputObserved, true); assert.equal(report.busy.key, 'Tab'); assert.equal(report.errorCode, undefined);
  assert.equal(report.busy.sequenceValid, !steers); assert.equal(report.busy.nextReplyComplete, !steers);
  if (!steers) assert.equal(report.busy.firstReplyComplete, true);
  for (const key of ['exactPrompt', 'mainCheckoutClean', 'worktreeClean', 'processStopped']) assert.equal(report[key], true, key);
  const records = (await readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse);
  const submitted = records.filter(row => row.kind === 'submitted'); assert.equal(submitted.length, 2);
  assert.deepEqual(submitted.map(row => [row.key, row.busy]), [['\r', false], ['\t', true]]);
  assert.deepEqual((await readdir(dir)).filter(name => /^pb-live-native-(data|repo)-/.test(name)), []);
});

test('the offline Codex busy check refuses the queue key after work ends during an owned paste', { skip: process.platform === 'win32', timeout: 25000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-live-codex-ended-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const bin = join(dir, 'bin'), capture = join(dir, 'messages.jsonl'); await mkdir(bin);
  const fixture = fileURLToPath(new URL('./fixtures/fake-codex-queue.cjs', import.meta.url));
  await writeFile(join(bin, 'codex'), `#!${process.execPath}\nrequire(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
  const result = spawnSync(process.execPath, [script, '--provider', 'codex', '--timeout', '18', '--column-automation', '--busy-queue'], {
    encoding: 'utf8', timeout: 22000, env: { ...process.env, PATH: bin + delimiter + process.env.PATH,
      TMPDIR: dir, TMP: dir, TEMP: dir, CODEX_HOME: join(dir, 'codex-fixture'), FAKE_NATIVE_MESSAGE_REPORT: capture,
      FAKE_CODEX_QUEUE_ENDS_AFTER_PASTE: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.equal(result.status, 0, result.stderr); const report = JSON.parse(result.stdout);
  assert.equal(report.initial.ready, true); assert.equal(report.sameRun, true); assert.equal(report.message.confirmed, true);
  assert.equal(report.busy.observed, true); assert.equal(report.busy.pasted, true);
  assert.equal(report.busy.queuedBeforeCompletion, false, JSON.stringify(report));
  assert.equal(report.errorCode, 'LIVE_CHECK_FAILED');
  for (const key of ['exactPrompt', 'mainCheckoutClean', 'worktreeClean', 'processStopped']) assert.equal(report[key], true, key);
  const records = (await readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.filter(row => row.kind === 'completed-before-key').length, 1);
  assert.deepEqual(records.filter(row => row.kind === 'submitted').map(row => [row.key, row.busy]), [['\r', false]]);
  assert.deepEqual((await readdir(dir)).filter(name => /^pb-live-native-(data|repo)-/.test(name)), []);
});

for (const columnAutomation of [false, true]) test(`the live smoke harness confirms exact ${columnAutomation ? 'configured column' : 'private'} delivery and cleans up with an offline owned CLI`, { skip: process.platform === 'win32', timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-live-harness-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const bin = join(dir, 'bin'), capture = join(dir, 'messages.jsonl'); await mkdir(bin);
  const fixture = fileURLToPath(new URL('./fixtures/fake-native-message.cjs', import.meta.url));
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\nrequire(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
  const result = spawnSync(process.execPath, [script, '--provider', 'claude', '--timeout', '20', ...(columnAutomation ? ['--column-automation'] : [])], {
    encoding: 'utf8', timeout: 25000, env: { ...process.env, PATH: bin + delimiter + process.env.PATH,
      TMPDIR: dir, TMP: dir, TEMP: dir, FAKE_NATIVE_MESSAGE_REPORT: capture,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.equal(result.status, 0, result.stderr); const report = JSON.parse(result.stdout);
  assert.equal(report.initial.ready, true); assert.equal(report.initial.manualInputObserved, false);
  assert.equal(report.columnAutomation, columnAutomation);
  if (columnAutomation) assert.equal(report.placementStatus, 'completed');
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

test('stopping the smoke harness shuts down its owned CLI before reporting and removing its fixture', { skip: process.platform === 'win32', timeout: 15000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-live-harness-stop-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const bin = join(dir, 'bin'), capture = join(dir, 'messages.jsonl'); await mkdir(bin);
  const fixture = fileURLToPath(new URL('./fixtures/fake-native-message.cjs', import.meta.url));
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\nrequire(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
  const child = spawn(process.execPath, [script, '--provider', 'claude', '--timeout', '20'], {
    env: { ...process.env, PATH: bin + delimiter + process.env.PATH, TMPDIR: dir, TMP: dir, TEMP: dir,
      FAKE_NATIVE_MESSAGE_REPORT: capture, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const ended = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  for (const deadline = Date.now() + 8000;;) {
    if (await readFile(capture, 'utf8').catch(() => '')) break;
    if (child.exitCode !== null || Date.now() >= deadline) assert.fail(`The offline owned CLI did not start: ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  child.kill('SIGTERM'); assert.equal(await ended, 0, stderr);
  const report = JSON.parse(stdout); assert.equal(report.cancelled, true); assert.equal(report.processStopped, true);
  assert.equal(report.message, null); assert.equal(report.exactPrompt, true); assert.equal(report.mainCheckoutClean, true);
  assert.deepEqual((await readdir(dir)).filter(name => /^pb-live-native-(data|repo)-/.test(name)), []);
  assert.equal((await readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse).filter(row => row.kind === 'submitted').length, 0);
});

test('startup trust waits for the actual positive selection and a fresh process retains its manual-input guard', { skip: process.platform === 'win32', timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-live-harness-trust-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const bin = join(dir, 'bin'), capture = join(dir, 'messages.jsonl'); await mkdir(bin);
  const fixture = fileURLToPath(new URL('./fixtures/fake-native-message.cjs', import.meta.url));
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\nrequire(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
  const result = spawnSync(process.execPath, [script, '--provider', 'claude', '--timeout', '20', '--answer-trust', '--fresh-trusted', '--column-automation'], {
    encoding: 'utf8', timeout: 25000, env: { ...process.env, PATH: bin + delimiter + process.env.PATH,
      TMPDIR: dir, TMP: dir, TEMP: dir, FAKE_NATIVE_MESSAGE_REPORT: capture, FAKE_NATIVE_STARTUP_TRUST: '1',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.equal(result.status, 0, result.stderr); const report = JSON.parse(result.stdout);
  assert.equal(report.warmup?.ready, true); assert.equal(report.warmup.manualInputObserved, true);
  assert.equal(report.initial.ready, true); assert.equal(report.initial.manualInputObserved, false);
  assert.equal(report.sameRun, true); assert.equal(report.placementStatus, 'completed');
  assert.deepEqual(report.message, { status: 'confirmed', confirmed: true, receiptStatus: 'confirmed', submitted: true });
  for (const key of ['exactPrompt', 'mainCheckoutClean', 'worktreeClean', 'processStopped']) assert.equal(report[key], true, key);
  const records = (await readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.filter(row => row.kind === 'navigation').map(row => row.selected), ['yes']);
  assert.deepEqual(records.filter(row => row.kind === 'trust-confirmation').map(row => row.selected), ['yes']);
  assert.equal(records.filter(row => row.kind === 'initial').length, 2);
  assert.equal(records.filter(row => row.kind === 'submitted').length, 1);
  assert.equal(records.some(row => row.kind === 'reset'), false);
  assert.deepEqual((await readdir(dir)).filter(name => /^pb-live-native-(data|repo)-/.test(name)), []);
});
