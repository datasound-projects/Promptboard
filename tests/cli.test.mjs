import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('headless SIGTERM stops the provider and removes its temporary working folder', {
  skip: process.platform === 'win32', timeout: 6000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ste-cli-test-'));
  const reportPath = join(dir, 'provider.json');
  const executable = join(dir, 'codex');
  let cli, report;
  try {
    await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === 'mcp') { process.stdout.write('[]'); process.exit(0); }
fs.writeFileSync(${JSON.stringify(reportPath + '.tmp')}, JSON.stringify({ pid: process.pid, cwd: process.cwd() }));
fs.renameSync(${JSON.stringify(reportPath + '.tmp')}, ${JSON.stringify(reportPath)});
process.stdin.resume();
setInterval(() => {}, 1000);
`);
    await chmod(executable, 0o700);
    cli = spawn(process.execPath, ['bin/ste.mjs', '--provider', 'codex'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: { ...process.env, PATH: dir },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    cli.stderr.setEncoding('utf8');
    cli.stderr.on('data', chunk => { stderr += chunk; });
    const exit = new Promise((resolve, reject) => {
      cli.once('error', reject);
      cli.once('close', (code, signal) => resolve({ code, signal }));
    });
    cli.stdin.end('Write a prompt for a small code change.');
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try { report = JSON.parse(await readFile(reportPath, 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(report, 'The fixture provider must start before cancellation.');
    cli.kill('SIGTERM');
    assert.deepEqual(await exit, { code: 143, signal: null });
    assert.match(stderr, /cancelled/i);
    assert.throws(() => process.kill(report.pid, 0), { code: 'ESRCH' });
    await assert.rejects(access(report.cwd), { code: 'ENOENT' });
  } finally {
    if (cli && cli.exitCode === null && cli.signalCode === null) cli.kill('SIGKILL');
    if (report) {
      try { process.kill(-report.pid, 'SIGKILL'); } catch {}
      await rm(report.cwd, { recursive: true, force: true });
    }
    await rm(dir, { recursive: true, force: true });
  }
});


test('headless output gates flagged drafts and JSON preserves the report', {
  skip: process.platform === 'win32', timeout: 10000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ste-cli-output-'));
  try {
    const executable = join(dir, 'codex');
    await writeFile(executable, `#!${process.execPath}
if (process.argv[2] === 'mcp') { process.stdout.write('[]'); process.exit(0); }
process.stdin.resume();
process.stdin.on('end', () => process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Keep the file.' } })));
`);
    await chmod(executable, 0o700);
    async function run(args) {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['bin/ste.mjs', ...args], {
          cwd: fileURLToPath(new URL('../', import.meta.url)), env: { ...process.env, PATH: dir },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', reject);
        child.once('close', code => resolve({ code, stdout, stderr }));
        child.stdin.end('Keep `src/api.ts`.');
      });
    }
    const blocked = await run(['--quality', 'fast']);
    assert.equal(blocked.code, 2); assert.equal(blocked.stdout, '');
    assert.match(blocked.stderr, /review|draft/i);
    const draft = await run(['--quality', 'fast', '--allow-draft']);
    assert.equal(draft.code, 2); assert.equal(draft.stdout.trim(), 'Keep the file.');
    const json = await run(['--quality', 'fast', '--json']);
    assert.equal(json.code, 2);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.verification.status, 'needs-review');
    assert.equal(parsed.verification.calls, 1);
    assert.ok(parsed.verification.automatic.issues.length);
    const reviewed = await run(['--json']);
    assert.equal(reviewed.code, 2);
    assert.equal(JSON.parse(reviewed.stdout).verification.review.status, 'unavailable');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('--doctor names each CLI version and the executable that runs, and says what is missing', { skip: process.platform === 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ste-doctor-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'codex'), `#!${process.execPath}\nprocess.stdout.write('codex-cli 9.9.9\\n');\n`);
  await writeFile(join(dir, 'claude'), `#!${process.execPath}\nprocess.exit(3);\n`);
  await chmod(join(dir, 'codex'), 0o700); await chmod(join(dir, 'claude'), 0o700);
  const output = await new Promise((resolve, reject) => {
    const cli = spawn(process.execPath, ['bin/ste.mjs', '--doctor'], { cwd: fileURLToPath(new URL('../', import.meta.url)), env: { ...process.env, PATH: dir }, stdio: ['ignore', 'pipe', 'inherit'] });
    let text = ''; cli.stdout.setEncoding('utf8'); cli.stdout.on('data', chunk => { text += chunk; });
    cli.once('error', reject); cli.once('close', code => code === 0 ? resolve(text) : reject(new Error(`exit ${code}`)));
  });
  assert.deepEqual(output.trim().split('\n').sort(), [
    'Antigravity CLI: Install this CLI and add it to PATH.',
    `Claude Code: The CLI version check failed. Check its installation. · ${join(dir, 'claude')}`,
    `Codex CLI: codex-cli 9.9.9 · ${join(dir, 'codex')}`,
    'Gemini CLI: Install this CLI and add it to PATH.',
  ]);
});
