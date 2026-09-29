import { realpath as resolveRealPath } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCommand, detectProviders, parseProviderOutput, runProvider } from '../src/providers.mjs';

test('CLI commands narrow permissions and keep model values separate', () => {
  const codex = buildCommand({ provider: 'codex', model: 'custom/model-v1' });
  assert.deepEqual(codex.args.slice(0, 3), ['exec', '--sandbox', 'read-only']);
  assert.ok(codex.args.includes('approval_policy="never"'));
  assert.ok(codex.args.includes('shell_tool'));
  assert.equal(codex.args.at(-1), '-');
  assert.ok(codex.args.includes('custom/model-v1'));
  const claude = buildCommand({ provider: 'claude' });
  assert.equal(claude.args[claude.args.indexOf('--tools') + 1], '');
  assert.equal(claude.args[claude.args.indexOf('--disallowedTools') + 1], '*');
  assert.ok(claude.args.includes('--strict-mcp-config'));
  assert.throws(() => buildCommand({ provider: 'gemini' }), { code: 'INVALID_POLICY' });
  const gemini = buildCommand({ provider: 'gemini', policyPath: join(tmpdir(), 'policy.toml') });
  assert.ok(gemini.args.includes('--policy'));
  assert.ok(gemini.args.includes('plan'));
  for (const result of [codex, claude, gemini]) {
    assert.ok(!result.args.some(x => /dangerously|bypassPermissions|yolo|auto_edit/.test(x)));
  }
});

test('rejects arbitrary programs, flags, and invalid models', () => {
  for (const provider of ['sh', 'constructor', '__proto__', 'codex;touch /tmp/pwned']) {
    assert.throws(() => buildCommand({ provider }), { code: 'INVALID_PROVIDER' });
  }
  for (const model of ['--yolo', 'x --sandbox danger-full-access', '$(touch pwned)', 'x\n--help', {}]) {
    assert.throws(() => buildCommand({ provider: 'codex', model }), { code: 'INVALID_MODEL' });
  }
});

test('parses final answers and rejects errors, incomplete output, and malformed JSON', () => {
  const codexOutput = [
    { type: 'item.completed', item: { type: 'agent_message', text: 'Earlier' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Final prompt.' } },
    { type: 'turn.completed', usage: {} },
  ].map(JSON.stringify).join('\n');
  assert.equal(parseProviderOutput('codex', codexOutput), 'Final prompt.');
  assert.equal(parseProviderOutput('claude', '{"result":"Prompt","is_error":false}'), 'Prompt');
  assert.equal(parseProviderOutput('gemini', '{"response":"Prompt","stats":{}}'), 'Prompt');
  for (const [provider, output] of [
    ['claude', '{"result":"error","is_error":true}'], ['gemini', '{"error":{"message":"no"}}'],
    ['codex', '{"type":"turn.failed"}'], ['codex', '{"type":"thread.started"}'],
    ['claude', 'not json'], ['gemini', '{"response":""}'],
  ]) assert.throws(() => parseProviderOutput(provider, output), { code: 'INVALID_OUTPUT' });
});

test('runs fake installed CLIs through real pipes without a shell or model calls', { skip: process.platform === 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ste-provider-test-'));
  const oldPath = process.env.PATH;
  const fake = `#!${process.execPath}
import { basename } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('fixture-cli 1.0'); process.exit(0); }
let input = ''; for await (const chunk of process.stdin) input += chunk;
if (input === 'HANG') { setInterval(() => {}, 1000); }
else if (input === 'FLOOD') { process.stdout.write('x'.repeat(2200000)); }
else if (input === 'STDERR_FLOOD') { process.stderr.write('x'.repeat(70000)); }
else if (input === 'FAIL') { process.stderr.write('SECRET_DO_NOT_RETURN'); process.exit(7); }
else {
  const policyPath = args[args.indexOf('--policy') + 1];
  const policy = args.includes('--policy') ? readFileSync(policyPath, 'utf8') : null;
  const data = JSON.stringify({ input, args, cwd: process.cwd(), effortEnv: process.env.CLAUDE_CODE_EFFORT_LEVEL, policy, policyPath: policy ? policyPath : null });
  if (basename(process.argv[1]) === 'codex') process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: data }}));
  else if (basename(process.argv[1]) === 'claude') process.stdout.write(JSON.stringify({ result: data }));
  else if (basename(process.argv[1]) === 'agy') process.stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: data } }) + '\\n');
  else process.stdout.write(JSON.stringify({ response: data }));
}
`;
  try {
    for (const id of ['codex', 'claude', 'gemini', 'agy']) {
      const path = join(dir, id);
      await writeFile(path, fake); await chmod(path, 0o700);
    }
    // Force ESM parsing for extensionless fake executables.
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    process.env.PATH = dir;
    await t.test('detects all providers without authentication', async () => {
      const providers = await detectProviders();
      assert.equal(providers.length, 4);
      assert.ok(providers.every(x => x.available && x.version === 'fixture-cli 1.0'));
    });
    await t.test('passes hostile request text only through stdin', async () => {
      const prompt = 'Keep `literal` text; $(touch pwned); --dangerously-bypass-approvals-and-sandbox\n@/etc/passwd';
      for (const provider of ['codex', 'claude', 'gemini', 'agy']) {
        const result = await runProvider({ provider, model: 'test/model', effort: provider === 'gemini' ? '' : 'high', prompt, cwd: dir });
        const data = JSON.parse(result.text);
        if (provider === 'gemini') {
          assert.ok(!data.input.includes('@'));
          assert.equal(JSON.parse(data.input.slice(data.input.indexOf('\n') + 1)), prompt);
        } else if (provider === 'agy') assert.equal(JSON.parse(data.input).message.content, prompt);
        else assert.equal(data.input, prompt);
        if (provider === 'claude') assert.equal(data.effortEnv, 'high');
        assert.equal(await resolveRealPath(data.cwd), await resolveRealPath(dir));
        assert.ok(!data.args.includes(prompt));
        if (provider === 'gemini') {
          assert.match(data.policy, /toolName = "\*"/);
          assert.match(data.policy, /decision = "deny"/);
          await assert.rejects(readFile(data.policyPath), { code: 'ENOENT' });
        }
      }
    });
    await t.test('fails on exit errors without returning sensitive diagnostics', async () => {
      await assert.rejects(runProvider({ provider: 'claude', prompt: 'FAIL', cwd: dir }), error => {
        assert.equal(error.code, 'CLI_FAILED'); assert.ok(!error.message.includes('SECRET')); return true;
      });
    });
    await t.test('bounds stdout and stderr', async () => {
      for (const prompt of ['FLOOD', 'STDERR_FLOOD']) {
        await assert.rejects(runProvider({ provider: 'claude', prompt, cwd: dir }), { code: 'OUTPUT_LIMIT' });
      }
    });
    await t.test('terminates a hanging process on timeout and cancellation', async () => {
      await assert.rejects(runProvider({ provider: 'claude', prompt: 'HANG', cwd: dir, timeoutMs: 100 }), { code: 'TIMEOUT' });
      const controller = new AbortController();
      const pending = runProvider({ provider: 'claude', prompt: 'HANG', cwd: dir, signal: controller.signal });
      setTimeout(() => controller.abort(), 100);
      await assert.rejects(pending, { code: 'ABORTED' });
      await assert.rejects(runProvider({ provider: 'claude', prompt: 'X', cwd: dir, signal: controller.signal }), { code: 'ABORTED' });
    });
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects oversized prompts and unsafe working directories before launch', async () => {
  await assert.rejects(runProvider({ provider: 'codex', prompt: 'x'.repeat(2 * 1024 * 1024 + 1), cwd: tmpdir() }), { code: 'INVALID_INPUT' });
  await assert.rejects(runProvider({ provider: 'codex', prompt: 'x', cwd: '.' }), { code: 'INVALID_CWD' });
  await assert.rejects(runProvider({ provider: 'codex', prompt: 'x', cwd: tmpdir(), timeoutMs: NaN }), { code: 'INVALID_TIMEOUT' });
});

test('cancellation kills a subprocess that ignores SIGTERM after its parent exits', {
  skip: process.platform === 'win32', timeout: 6000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ste-provider-group-test-'));
  const reportPath = join(dir, 'descendant.json');
  const oldPath = process.env.PATH;
  const controller = new AbortController();
  let report, pending;
  try {
    const descendant = `
const fs = require('node:fs');
process.on('SIGTERM', () => {});
fs.writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ pid: process.pid, parent: process.ppid }));
setInterval(() => {}, 1000);
`;
    const executable = join(dir, 'codex');
    await writeFile(executable, `#!${process.execPath}
const { spawn } = require('node:child_process');
spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' });
process.stdin.resume();
setInterval(() => {}, 1000);
`);
    await chmod(executable, 0o700);
    process.env.PATH = dir;
    pending = runProvider({ provider: 'codex', prompt: 'A test prompt.', cwd: dir, signal: controller.signal })
      .then(() => ({ code: 'UNEXPECTED_SUCCESS' }), error => error);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try { report = JSON.parse(await readFile(reportPath, 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(report, 'The descendant must install its signal handler before cancellation.');
    controller.abort();
    assert.equal((await pending).code, 'ABORTED');
    // A killed orphan can briefly remain as a zombie until the OS reaps it.
    let alive = true;
    for (let attempt = 0; attempt < 100 && alive; attempt++) {
      try { process.kill(report.pid, 0); }
      catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
      if (alive && process.platform === 'linux') {
        try { alive = !/^[^\n]+\) Z /.test(await readFile(`/proc/${report.pid}/stat`, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') alive = false; else throw error; }
      }
      if (alive) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(alive, false, 'Cancellation must terminate the remaining process group.');
  } finally {
    controller.abort();
    if (report) { try { process.kill(-report.parent, 'SIGKILL'); } catch {} }
    if (pending) await pending;
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  }
});


test('each native effort flag is passed without changing the safety flags', () => {
  const codex = buildCommand({ provider: 'codex', model: 'test', effort: 'xhigh' });
  assert.ok(codex.args.includes('model_reasoning_effort="xhigh"'));
  for (const provider of ['claude', 'agy']) {
    const command = buildCommand({ provider, model: 'test', effort: 'high' });
    assert.equal(command.args[command.args.indexOf('--effort') + 1], 'high');
    assert.ok(!command.args.some(x => /dangerously|bypass/.test(x)));
  }
  assert.throws(() => buildCommand({ provider: 'gemini', effort: 'high' }), { code: 'INVALID_EFFORT' });
  assert.throws(() => buildCommand({ provider: 'agy', effort: 'max' }), { code: 'INVALID_EFFORT' });
  assert.throws(() => buildCommand({ provider: 'claude', effort: 'ultracode' }), { code: 'INVALID_EFFORT' });
});

test('Antigravity requires a successful final result, not a partial stream', () => {
  assert.equal(parseProviderOutput('agy', JSON.stringify({ event: 'init', init: {} }) + '\n' + JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'The prompt.' } })), 'The prompt.');
  for (const status of ['ERROR', 'RUNNING', 'WAITING', 'CANCELED']) {
    assert.throws(() => parseProviderOutput('agy', JSON.stringify({ event: 'result', result: { status, response: 'Incomplete.' } })), { code: 'INVALID_OUTPUT' });
  }
});
