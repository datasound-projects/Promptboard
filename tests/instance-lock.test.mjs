import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockDataDir } from '../src/instance-lock.mjs';
import { startServer } from '../src/server.mjs';

const temp = async t => { const dir = await mkdtemp(join(tmpdir(), 'pb-lock-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };

test('one app per data folder: a second start is refused and the first keeps its board', async t => {
  const dataDir = await temp(t);
  const first = await startServer({ port: 0, dataDir, executor: null, detector: async () => [] });
  t.after(() => first.close());
  const lock = JSON.parse(await readFile(join(dataDir, 'instance.lock'), 'utf8'));
  assert.deepEqual([lock.pid, lock.port], [process.pid, first.server.address().port]);
  await assert.rejects(startServer({ port: 0, dataDir, executor: null, detector: async () => [] }), { code: 'DATA_DIR_IN_USE', message: /already running with this data folder/ });
  await first.close();
  await assert.rejects(readFile(join(dataDir, 'instance.lock')), { code: 'ENOENT' }, 'closing releases the folder');
  const second = await startServer({ port: 0, dataDir, executor: null, detector: async () => [] });
  await second.close();
});

test('a lock left by an app that stopped is replaced, even when the PID was reused or the host name changed', async t => {
  const dataDir = await temp(t), path = join(dataDir, 'instance.lock');
  // A crashed app: its process is gone (a PID that cannot exist).
  await writeFile(path, JSON.stringify({ pid: 2 ** 30, host: hostname(), startedAt: Date.now() - 60000, port: 1 }));
  const taken = await lockDataDir(dataDir);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).pid, process.pid);
  await taken.release();
  // A reused PID (this process is alive) whose port no longer answers is stale too.
  await writeFile(path, JSON.stringify({ pid: process.ppid, host: hostname(), startedAt: Date.now() - 60000, port: 1 }));
  await (await lockDataDir(dataDir)).release();
  // macOS can rename the computer between runs: the host name alone never blocks a start.
  await writeFile(path, JSON.stringify({ pid: 2 ** 30, host: 'renamed-mac', startedAt: Date.now() - 60000, port: 1 }));
  await (await lockDataDir(dataDir)).release();
});

test('apps that start at the same moment over a stale lock: exactly one gets the folder, the others are refused clearly', { timeout: 60000 }, async t => {
  const stale = path => writeFile(path, JSON.stringify({ pid: 2 ** 30, host: hostname(), startedAt: Date.now() - 60000, port: 1 }));
  const dataDir = await temp(t);
  await stale(join(dataDir, 'instance.lock'));
  const results = await Promise.allSettled([lockDataDir(dataDir), lockDataDir(dataDir)]);
  assert.deepEqual(results.map(result => result.status === 'fulfilled' ? 'held' : result.reason.code).sort(), ['DATA_DIR_IN_USE', 'held']);
  await results.find(result => result.status === 'fulfilled').value.release();
  // Separate processes, released together: none may remove a lock another one has just written.
  const child = `const { lockDataDir } = await import(${JSON.stringify(new URL('../src/instance-lock.mjs', import.meta.url).href)});
process.stdin.once('data', async () => {
  let lock; try { lock = await lockDataDir(process.argv[1]); console.log('held'); } catch (error) { console.log(error.code || error.message); }
  process.stdin.once('end', () => lock?.release());
});
console.log('ready');`;
  const dirs = await Promise.all([1, 2, 3, 4].map(() => temp(t)));
  await Promise.all(dirs.map(dir => stale(join(dir, 'instance.lock'))));
  const apps = dirs.flatMap(dir => [1, 2, 3].map(() => {
    const app = spawn(process.execPath, ['--input-type=module', '-e', child, dir], { stdio: ['pipe', 'pipe', 'inherit'] });
    let output = ''; app.stdout.on('data', chunk => { output += chunk; });
    return { dir, app, output: () => output.split('\n').filter(Boolean), closed: new Promise(resolve => app.once('close', resolve)) };
  }));
  t.after(() => { for (const { app } of apps) app.kill(); });
  const until = async count => { while (apps.some(({ output }) => output().length < count)) await new Promise(resolve => setTimeout(resolve, 20)); };
  await until(1); // Every process has loaded the module; then all try at once.
  for (const { app } of apps) app.stdin.write('go\n');
  await until(2);
  for (const dir of dirs) assert.deepEqual(apps.filter(entry => entry.dir === dir).map(entry => entry.output()[1]).sort(), ['DATA_DIR_IN_USE', 'DATA_DIR_IN_USE', 'held'], dir);
  for (const { app } of apps) app.stdin.end();
  await Promise.all(apps.map(entry => entry.closed));
});
