import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, access, readdir, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeChrome, sweepChromes, trackChrome } from './helpers/browser-cleanup.mjs';

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

test('Inherited diagnostic pipes cannot hold cleanup after the owned browser exits', async t => {
  const profile = await mkdtemp(join(tmpdir(), 'pb-chrome-pipe-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const script = `const { spawn } = require('node:child_process');
    const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], { stdio: ['ignore', 'ignore', 'inherit'] });
    descendant.once('spawn', () => process.stderr.write('ready'));
    setInterval(() => {}, 1000);`;
  const child = trackChrome(spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] }));
  t.after(() => closeChrome(child, profile));
  await new Promise((resolve, reject) => { child.stderr.once('data', resolve); child.once('error', reject); });
  await closeChrome(child, profile, { timeout: 1000 });
  assert.equal(child.stderr.destroyed, true);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  await assert.rejects(access(profile), { code: 'ENOENT' });
});

const gone = async pid => { for (let tries = 100; tries--;) { try { process.kill(pid, 0); } catch { return true; } await new Promise(resolve => setTimeout(resolve, 50)); } return false; };
const KEEP = 'setInterval(() => {}, 1000)';

test('an owned Chrome is stopped when its test process ends by an error, process.exit or a signal', async t => {
  const helper = new URL('./helpers/browser-cleanup.mjs', import.meta.url).href;
  for (const [ending, expected] of [['throw new Error("Unexpected failure")', { code: 1 }], ['process.exit(3)', { code: 3 }], ...(process.platform === 'win32' ? [] : [['', { signal: 'SIGTERM' }]])]) {
    const script = `import { spawn } from 'node:child_process'; import { trackChrome } from ${JSON.stringify(helper)};
      const chrome = trackChrome(spawn(process.execPath, ['-e', ${JSON.stringify(KEEP)}], { stdio: 'ignore' }));
      chrome.once('spawn', () => { console.log(chrome.pid); ${ending} });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    const pid = Number(await new Promise(resolve => child.stdout.once('data', resolve)));
    t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
    if (expected.signal) child.kill(expected.signal);
    const [code, signal] = await new Promise(resolve => child.once('close', (...result) => resolve(result)));
    assert.deepEqual(expected.signal ? { signal } : { code }, expected, `${ending || 'SIGTERM'} keeps its exit status`);
    assert.equal(await gone(pid), true, `${ending || 'SIGTERM'} stops the owned Chrome`);
  }
});

test('the startup sweep stops only helper Chromes whose owner is gone and removes only unowned profiles', { skip: process.platform === 'win32' }, async t => {
  const tmp = await mkdtemp(join(tmpdir(), 'pb-sweep-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const ended = spawn(process.execPath, ['-e', '']); await new Promise(resolve => ended.once('close', resolve));
  const dead = ended.pid, profile = name => join(tmp, `pb-chrome-${name}`);
  const fake = (name, flags = ['--headless=new', '--remote-debugging-port=0']) => {
    const child = spawn(process.execPath, ['-e', KEEP, '--', ...flags, `--user-data-dir=${profile(name)}`, '--no-first-run'], { stdio: 'ignore' });
    t.after(() => child.kill('SIGKILL'));
    return child;
  };
  const orphan = fake(`${dead}-orphan`), legacy = fake('legacy1'), live = fake(`${process.pid}-live`), helper = fake(`${dead}-helper`, ['--type=renderer', '--headless=new', '--remote-debugging-port=0']), own = fake(`${dead}-own`, ['--headless=new']);
  await Promise.all([orphan, legacy, live, helper, own].map(child => new Promise(resolve => child.once('spawn', resolve))));
  for (const name of [`${dead}-orphan`, `${dead}-stale`, `${process.pid}-live`, 'legacy1', 'fresh', 'old']) await mkdir(profile(name));
  await utimes(profile('old'), new Date(Date.now() - 3600000), new Date(Date.now() - 3600000));
  await mkdir(join(tmp, 'unrelated'));
  // The unnamed profile's Chrome lost its parent (PID 1); the real parent of every fake is this test.
  const list = () => new Promise(resolve => execFile('ps', ['-A', '-ww', '-o', 'pid=,ppid=,args='], (error, stdout) => resolve(stdout.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
    .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(pid) === legacy.pid ? 1 : Number(ppid), command })))));
  await sweepChromes({ tmp, list });
  assert.deepEqual([await gone(orphan.pid), await gone(legacy.pid)], [true, true], 'orphaned helper Chromes are stopped');
  for (const child of [live, helper, own]) assert.equal(child.exitCode === null && child.signalCode === null, true, 'a Chrome with a live owner, a subprocess or another Chrome is never signalled');
  assert.deepEqual((await readdir(tmp)).sort(), [`pb-chrome-${process.pid}-live`, 'pb-chrome-fresh', 'unrelated'].sort());
});
