import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCodexRollout } from '../src/usage.mjs';
import { locateCodexRollout } from '../src/codex-rollout-locator.mjs';

const thread = '11111111-2222-3333-4444-555555555555';
const other = '66666666-7777-8888-9999-000000000000';
async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'pb-codex-locator-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const write = async (day, id = thread, metadata = { id, source: 'cli' }, prefix = '2025-01-02T12-00-00') => {
    const dir = join(home, 'sessions', ...day.split('/')); await mkdir(dir, { recursive: true });
    const path = join(dir, `rollout-${prefix}-${id}.jsonl`);
    await writeFile(path, JSON.stringify({ type: 'session_meta', payload: metadata }) + '\n'); return path;
  };
  const today = () => { const d = new Date(); return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('/'); };
  return { home, write, today };
}

test('resumed Codex history is found on its original date by exact thread identity', async t => {
  const w = await fixture(t), path = await w.write('2025/01/02');
  await w.write(w.today(), other); // A newer unrelated conversation is never substituted.
  assert.equal(await findCodexRollout(thread, Date.now(), w.home), path);
  assert.equal(await findCodexRollout(other, Date.now(), w.home), join(w.home, 'sessions', ...w.today().split('/'), `rollout-2025-01-02T12-00-00-${other}.jsonl`));
});

test('current-date filename matches still require a main CLI thread metadata record', async t => {
  for (const metadata of [{ id: other, source: 'cli' }, { id: thread, source: 'exec' }, { id: thread, source: { subagent: 'parent' } }, {}]) {
    const w = await fixture(t); await w.write(w.today(), thread, metadata);
    assert.equal(await findCodexRollout(thread, Date.now(), w.home), null);
  }
});

test('legacy metadata without a source is accepted only with the exact thread ID', async t => {
  const w = await fixture(t), path = await w.write('2025/01/02', thread, { id: thread });
  assert.equal(await findCodexRollout(thread, Date.now(), w.home), path);
});

test('duplicate or reverted older rollouts cannot select an arbitrary history', async t => {
  const w = await fixture(t); await w.write('2025/01/02'); await w.write('2025/01/03');
  assert.equal(await findCodexRollout(thread, Date.now(), w.home), null);
  const reverted = await fixture(t); await reverted.write('2025/01/02');
  await reverted.write('2025/01/03', `${thread}_${other}`, { id: thread, source: 'cli' });
  assert.equal(await findCodexRollout(thread, Date.now(), reverted.home), null);
});

test('a preferred current-date match cannot conceal another rollout for the same thread', async t => {
  const w = await fixture(t); await w.write(w.today()); await w.write('2025/01/02');
  assert.equal(await findCodexRollout(thread, Date.now(), w.home), null);
  const sameDay = await fixture(t); await sameDay.write(sameDay.today());
  await sameDay.write(sameDay.today(), thread, { id: thread, source: 'cli' }, '2025-01-02T12-00-01');
  assert.equal(await findCodexRollout(thread, Date.now(), sameDay.home), null);
});

test('malformed, torn and oversized metadata cannot become a verified locator', async t => {
  const invalidUtf8 = Buffer.concat([Buffer.from(`{"type":"session_meta","payload":{"id":"${thread}","source":"cli","private":"`), Buffer.from([255]), Buffer.from('"}}\n')]);
  for (const content of ['{broken\n', '{"type":"session_meta","payload":{"id":"' + thread + '"}}', JSON.stringify({ type: 'turn_context', payload: { id: thread } }) + '\n', 'x'.repeat(1024 * 1024 + 1) + '\n', invalidUtf8]) {
    const w = await fixture(t), path = await w.write(w.today()); await writeFile(path, content);
    assert.equal(await findCodexRollout(thread, Date.now(), w.home), null);
  }
});

test('symlink histories and date directories never redirect discovery', { skip: process.platform === 'win32' }, async t => {
  const w = await fixture(t), path = await w.write(w.today()), outside = await fixture(t);
  const target = await outside.write('2025/01/02'); await rm(path); await symlink(target, path);
  assert.equal(await findCodexRollout(thread, Date.now(), w.home), null);
  await rm(join(w.home, 'sessions'), { recursive: true }); await mkdir(join(w.home, 'sessions'));
  await symlink(join(outside.home, 'sessions', '2025'), join(w.home, 'sessions', '2025'), 'dir');
  assert.equal(await findCodexRollout(thread, Date.now(), w.home), null);
});

test('an unreadable canonical folder cannot conceal another active rollout behind a known match', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const w = await fixture(t); await w.write(w.today()); await w.write('2024/01/02', other);
  const hidden = join(w.home, 'sessions', '2024', '01'); await chmod(hidden, 0);
  try { assert.equal(await findCodexRollout(thread, Date.now(), w.home), null); }
  finally { await chmod(hidden, 0o700); }
});

test('a canonical symlink shadow cannot publish a partial match from another date', { skip: process.platform === 'win32' }, async t => {
  const w = await fixture(t), outside = await fixture(t); await w.write(w.today()); await outside.write('2024/01/02');
  await symlink(join(outside.home, 'sessions', '2024'), join(w.home, 'sessions', '2024'), 'dir');
  assert.equal(await findCodexRollout(thread, Date.now(), w.home), null);
});

test('invalid identity and non-date directories cannot trigger history substitution', async t => {
  const w = await fixture(t); await w.write('not-a-year/01/02');
  for (const id of [thread, null, '', '../escape', 'x'.repeat(101)]) assert.equal(await findCodexRollout(id, Date.now(), w.home), null);
});

test('compressed histories and impossible dates cannot conceal an unknown active rollout', async t => {
  const compressed = await fixture(t); await compressed.write(compressed.today());
  const variant = await compressed.write('2025/01/02', `${thread}_${other}`, { id: thread, source: 'cli' });
  await writeFile(variant + '.zst', 'Never read compressed content.'); await rm(variant);
  assert.equal(await findCodexRollout(thread, Date.now(), compressed.home), null);
  for (const [day, stamp] of [['2025/02/31', '2025-01-02T12-00-00'], ['2025/01/02', '2025-01-02T99-00-00']]) {
    const w = await fixture(t); await w.write(day, thread, { id: thread, source: 'cli' }, stamp);
    assert.equal(await findCodexRollout(thread, Date.now(), w.home), null);
  }
});

test('exhausted directory or entry budgets cannot publish a partial older-history match', async t => {
  const w = await fixture(t), path = await w.write('2025/01/02'); await w.write('2025/01/03', other);
  for (let n = 0; n < 8; n++) await writeFile(join(w.home, 'sessions', '2025', '01', '03', `unrelated-${n}`), 'Never parse this file.');
  assert.equal(await findCodexRollout(thread, Date.now(), w.home), path);
  assert.equal(await locateCodexRollout(thread, Date.now(), w.home, { maxDirectories: 4 }), null);
  assert.equal(await locateCodexRollout(thread, Date.now(), w.home, { maxEntries: 6 }), null);
});
