import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CODEX_BUSY_MESSAGE, CODEX_QUEUED_MESSAGE, codexBusyEvidence, CodexBusyEvidenceReader } from '../scripts/codex-busy-evidence.mjs';
const meta = { type: 'session_meta', payload: { id: 'owned', source: 'cli' } };
const event = (type, extra = {}) => ({ type: 'event_msg', payload: { type, ...extra } });
const start = turn_id => event('task_started', { turn_id });
const finish = (turn_id, last_agent_message, extra = {}) => event('task_complete', { turn_id, last_agent_message, ...extra });
const input = text => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const reply = numbered => Array.from({ length: 160 }, (_, n) => { const id = String(n + 1).padStart(3, '0'); return (numbered ? id + ' ' : '') + 'PB_BUSY_LINE_' + id; }).concat('PB_BUSY_END').join('\n');
const initial = [meta, start('initial'), input('Initial task'), finish('initial', 'PB_NATIVE_FIRST')];
const busy = [...initial, start('busy'), input(CODEX_BUSY_MESSAGE)];
const completed = numbered => [...busy, finish('busy', reply(numbered)), start('next'), input(CODEX_QUEUED_MESSAGE), finish('next', 'PB_BUSY_NEXT')];

test('current input_text and user_message formats bind only to the new owned active native turn', () => {
  assert.equal(codexBusyEvidence(initial, 'owned').busy, false);
  assert.equal(codexBusyEvidence(busy, 'owned').busy, true);
  const alternate = [...busy.slice(0, -1), event('user_message', { message: CODEX_BUSY_MESSAGE, images: [], local_images: [] })];
  assert.equal(codexBusyEvidence(alternate, 'owned').busy, true);
  assert.equal(codexBusyEvidence([...alternate, input(CODEX_BUSY_MESSAGE)], 'owned').busy, true);
  assert.equal(codexBusyEvidence([...busy.slice(0, -1), { ...input(CODEX_BUSY_MESSAGE), payload: { ...input(CODEX_BUSY_MESSAGE).payload, role: 'assistant' } }], 'owned').busy, false);
  assert.equal(codexBusyEvidence([...busy.slice(0, -1), event('user_message', { message: CODEX_BUSY_MESSAGE, images: ['attachment'] })], 'owned').busy, false);
});

test('queue success needs all ordered reply lines, a native completion and a different subsequent turn', () => {
  for (const numbered of [false, true]) assert.deepEqual(codexBusyEvidence(completed(numbered), 'owned'),
    { busy: false, interrupted: false, steered: false, firstReplyComplete: true, nextInputObserved: true, sequenceValid: true, nextReplyComplete: true });
  for (const text of [reply(false).replace('PB_BUSY_LINE_088\n', ''), reply(false).replace('PB_BUSY_LINE_088', 'PB_BUSY_LINE_089'), 'PB_BUSY_END']) {
    const rows = completed(false); rows[6] = finish('busy', text); assert.equal(codexBusyEvidence(rows, 'owned').firstReplyComplete, false);
  }
  const failed = completed(false); failed[6] = finish('busy', reply(false), { error: { message: 'Owned failure' } });
  assert.equal(codexBusyEvidence(failed, 'owned').firstReplyComplete, false);
  assert.equal(codexBusyEvidence(completed(false).slice(0, -1), 'owned').nextReplyComplete, false);
});

test('steering, aborted work, duplicate input on another turn and wrong native identity never prove queue success', () => {
  const steered = [...busy, input(CODEX_QUEUED_MESSAGE), finish('busy', reply(false))];
  const evidence = codexBusyEvidence(steered, 'owned'); assert.equal(evidence.steered, true); assert.equal(evidence.sequenceValid, false);
  assert.equal(codexBusyEvidence([...completed(false), event('turn_aborted')], 'owned').nextReplyComplete, false);
  assert.equal(codexBusyEvidence([...completed(false), start('duplicate'), input(CODEX_BUSY_MESSAGE)], 'owned').sequenceValid, false);
  for (const rows of [[{ ...meta, payload: { id: 'other', source: 'cli' } }, ...busy.slice(1)], [meta, input(CODEX_BUSY_MESSAGE)], [...busy, finish('unknown', reply(false))], [...busy, meta, { ...meta, payload: { id: 'other', source: 'cli' } }]]) assert.throws(() => codexBusyEvidence(rows, 'owned'), /unavailable/);
});

test('bounded reader accepts only append-only complete evidence and refuses truncated, rewritten or replaced history', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-codex-busy-evidence-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'history.jsonl'), lines = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
  await writeFile(path, lines(busy)); const reader = new CodexBusyEvidenceReader(path, 'owned'); assert.equal((await reader.read()).busy, true);
  const rest = lines(completed(false).slice(busy.length)); await appendFile(path, rest.slice(0, 20)); assert.equal((await reader.read()).firstReplyComplete, false);
  await appendFile(path, rest.slice(20)); assert.equal((await reader.read()).nextReplyComplete, true);
  await writeFile(path, lines(initial)); await assert.rejects(reader.read(), /unavailable/);
  await writeFile(path, lines(busy)); const rewritten = new CodexBusyEvidenceReader(path, 'owned'); await rewritten.read();
  await writeFile(path, lines(busy).replace('PB_NATIVE_FIRST', 'PB_NATIVE_WRONG')); await assert.rejects(rewritten.read(), /unavailable/);
  await writeFile(path, lines(busy)); const replaced = new CodexBusyEvidenceReader(path, 'owned'); await replaced.read();
  await rename(path, join(dir, 'old-history.jsonl')); await writeFile(path, lines(busy)); await assert.rejects(replaced.read(), /unavailable/);
});

test('reader rejects oversized, malformed and symlinked files without granting busy evidence', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-codex-busy-invalid-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'history.jsonl'); await writeFile(path, 'x'.repeat(4 * 1024 * 1024 + 1)); await assert.rejects(new CodexBusyEvidenceReader(path, 'owned').read(), /unavailable/);
  await writeFile(path, '{malformed}\n'); await assert.rejects(new CodexBusyEvidenceReader(path, 'owned').read());
  if (process.platform !== 'win32') { const linked = join(dir, 'linked.jsonl'); await symlink(path, linked); await assert.rejects(new CodexBusyEvidenceReader(linked, 'owned').read(), /unavailable/); }
});
