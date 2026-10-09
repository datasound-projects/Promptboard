import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWithBackup, serial, writeAtomic } from '../src/durable.mjs';

test('atomic writes keep the previous file as a backup and leave no temporary file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-durable-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'data.json');
  await writeAtomic(path, 'one'); await writeAtomic(path, 'two');
  assert.deepEqual([await readFile(path, 'utf8'), await readFile(`${path}.bak`, 'utf8')], ['two', 'one']);
  await writeAtomic(join(dir, 'plain.md'), 'text', { backup: false });
  assert.deepEqual((await readdir(dir)).sort(), ['data.json', 'data.json.bak', 'plain.md']);
  await assert.rejects(writeAtomic(join(dir, 'missing', 'x.json'), 'x'), { code: 'ENOENT' });
});

test('reads fall back to the backup only for a missing or damaged file; other read errors are thrown', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-durable-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'data.json'), parse = bytes => { try { return JSON.parse(bytes); } catch { return undefined; } };
  assert.equal(await readWithBackup([path, `${path}.bak`], parse), undefined);
  await writeFile(`${path}.bak`, '{"good":1}');
  assert.deepEqual(await readWithBackup([path, `${path}.bak`], parse), { good: 1 }, 'a missing file falls back');
  await writeFile(path, '{ damaged');
  assert.deepEqual(await readWithBackup([path, `${path}.bak`], parse), { good: 1 }, 'a damaged file falls back');
  // A file that exists but cannot be read is not "no data": the next save would replace it.
  await rm(path); await mkdir(path);
  await assert.rejects(readWithBackup([path, `${path}.bak`], parse), error => error.code !== 'ENOENT');
});

test('a queue runs work one at a time, in order, past failures', async () => {
  const run = serial(), order = [];
  const slow = run(async () => { await new Promise(resolve => setTimeout(resolve, 20)); order.push(1); });
  const failed = run(async () => { order.push(2); throw new Error('no'); });
  await Promise.all([slow, failed.catch(() => {}), run(() => order.push(3))]);
  assert.deepEqual(order, [1, 2, 3]);
});
