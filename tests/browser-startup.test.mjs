import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserStartup } from './helpers/browser-startup.mjs';

async function fixture(t, timeout = 1000) {
  const profile = await mkdtemp(join(tmpdir(), 'pb-browser-startup-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, stderr: new PassThrough() });
  const startup = new BrowserStartup(child, profile, { timeout });
  t.after(() => startup.close());
  return { profile, child, startup };
}

test('Chrome startup waits for a valid port and connection work uses the same deadline', async t => {
  const { profile, startup } = await fixture(t, 1000);
  await writeFile(join(profile, 'DevToolsActivePort'), '70000\ninvalid');
  const ready = startup.port();
  await new Promise(resolve => setTimeout(resolve, 30));
  await writeFile(join(profile, 'DevToolsActivePort'), '12345\n/devtools/browser/owned');
  assert.equal(await ready, 12345);
  assert.equal(await startup.wait(Promise.resolve('connected')), 'connected');
  await assert.rejects(startup.wait(new Promise(() => {})), /startup exceeded 1000ms/);
});

test('Missing DevTools fails with bounded sanitized Chrome diagnostics rather than skipping', async t => {
  const { child, startup } = await fixture(t, 25);
  child.stderr.write('x'.repeat(4096) + '\x1b[31mCold launch diagnostic\x1b[0m\x00');
  await assert.rejects(startup.port(), error => {
    assert.match(error.message, /startup exceeded 25ms/);
    assert.match(error.message, /Cold launch diagnostic/);
    assert.ok(error.message.length < 1100);
    assert.doesNotMatch(error.message, /[\x00\x1b]/);
    return true;
  });
});

test('Chrome spawn errors stop startup immediately and listener cleanup is scoped', async t => {
  const { child, startup } = await fixture(t);
  const waiting = startup.port();
  const error = Object.assign(new Error('Owned executable missing'), { code: 'ENOENT' });
  child.emit('error', error);
  await assert.rejects(waiting, failure => failure === error);
  startup.close();
  assert.equal(child.listenerCount('error'), 0);
  assert.equal(child.stderr.listenerCount('data'), 0);
});

test('An exited Chrome fails immediately before readiness', async t => {
  const { child, startup } = await fixture(t);
  child.exitCode = 1; child.stderr.write('Owned Chrome exited');
  await assert.rejects(startup.port(), /Chrome exited before DevTools became available.*Owned Chrome exited/);
});
