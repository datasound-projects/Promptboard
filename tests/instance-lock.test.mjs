import test from 'node:test';
import assert from 'node:assert/strict';
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
