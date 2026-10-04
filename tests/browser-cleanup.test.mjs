import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeChrome, trackChrome } from './helpers/browser-cleanup.mjs';

test('Chrome profile cleanup waits for the owned process to close', async t => {
  const profile = await mkdtemp(join(tmpdir(), 'pb-chrome-cleanup-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  await writeFile(join(profile, 'lockfile'), 'owned profile');
  const child = trackChrome(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }));
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  let closed = false;
  child.once('close', () => { closed = true; });
  await closeChrome(child, profile, { remove: async (path, options) => {
    assert.equal(closed, true);
    assert.equal(path, profile);
    assert.deepEqual(options, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(path, options);
  } });
  await assert.rejects(access(profile), { code: 'ENOENT' });
});

test('Chrome profile is retained if the owned process never closes', async () => {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: () => true });
  let removed = false;
  await assert.rejects(closeChrome(child, 'owned-profile', { timeout: 20, remove: async () => { removed = true; } }), /profile was retained/);
  assert.equal(removed, false);
  assert.equal(child.listenerCount('close'), 0);
});

test('Already exited Chrome does not get signalled again and cleanup errors are reported', async () => {
  const child = { exitCode: 1, signalCode: null, kill: () => { throw new Error('Unexpected signal'); } };
  const error = Object.assign(new Error('Profile remains locked'), { code: 'EBUSY' });
  await assert.rejects(closeChrome(child, 'owned-profile', { remove: async () => { throw error; } }), failure => failure === error);
});

test('Process exit before close still keeps the Chrome profile until close', async () => {
  const child = trackChrome(Object.assign(new EventEmitter(), { exitCode: 0, signalCode: null, kill: () => { throw new Error('Unexpected signal'); } }));
  let removed = false;
  const pending = closeChrome(child, 'owned-profile', { remove: async () => { removed = true; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(removed, false);
  child.emit('close', 0);
  await pending;
  assert.equal(removed, true);
});
