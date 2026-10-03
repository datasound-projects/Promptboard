import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { NativeMessageReceipts } from '../src/native-message-receipts.mjs';

const nativeId = 'native-session', runId = 'owned-run';
const jsonl = records => records.map(record => JSON.stringify(record) + '\n').join('');
const identity = provider => provider === 'claude' ? { type: 'assistant', sessionId: nativeId, message: { role: 'assistant', content: 'Prior answer' } }
  : provider === 'codex' ? { type: 'session_meta', payload: { id: nativeId, source: 'cli' } }
    : { sessionId: nativeId, projectHash: 'a'.repeat(64), kind: 'main' };
const user = (provider, text, fields = {}) => provider === 'claude'
  ? { type: 'user', sessionId: nativeId, message: { role: 'user', content: text }, ...fields }
  : provider === 'codex' ? { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }, ...fields }
    : { type: 'user', id: 'new-message', content: [{ text }], ...fields };
async function fixture(t, provider, records = [identity(provider)], legacy = false) {
  const dir = await mkdtemp(join(tmpdir(), 'pb-native-receipt-')); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const path = join(dir, provider === 'claude' ? `${nativeId}.jsonl` : provider === 'codex' ? `rollout-test-${nativeId}.jsonl` : `session-test-${nativeId}.${legacy ? 'json' : 'jsonl'}`);
  const data = messages => JSON.stringify({ sessionId: nativeId, kind: 'main', messages });
  await writeFile(path, legacy ? data(records) : jsonl(records));
  let epoch = 0;
  const receipts = new NativeMessageReceipts({ provider, nativeSessionId: nativeId, runId, getInputEpoch: () => epoch });
  const checkpoint = await receipts.checkpoint(path); assert.equal(checkpoint.status, 'ready');
  return { dir, path, receipts, ticket: checkpoint.ticket, append: record => appendFile(path, jsonl([record])), input: () => epoch++, data };
}

test('all native formats confirm only exact new plain user turns, once, without writing artifacts or exposing text', async t => {
  const expected = '  Review café 🧪\n{{unknown}} "& PRIVATE TEXT  ';
  for (const provider of ['claude', 'codex', 'gemini']) {
    const ctx = await fixture(t, provider, [identity(provider), user(provider, expected, provider === 'gemini' ? { id: 'old-message' } : {})]);
    assert.deepEqual(await ctx.receipts.verify(ctx.ticket, expected), { status: 'pending' });
    await ctx.append(user(provider, expected)); const bytes = await readFile(ctx.path);
    const receipt = await ctx.receipts.verify(ctx.ticket, expected); assert.deepEqual(receipt, { status: 'confirmed' });
    assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE|café|native-session|owned-run|jsonl/);
    assert.deepEqual(await readFile(ctx.path), bytes); assert.equal((await readdir(ctx.dir)).length, 1);
    assert.equal((await ctx.receipts.verify(ctx.ticket, expected)).reason, 'checkpoint_used');
  }
});

test('timestamps, substring matches, trimmed text, assistant output, mixed tool/attachment blocks and synthetic context cannot grant receipt', async t => {
  for (const provider of ['claude', 'codex', 'gemini']) {
    const ctx = await fixture(t, provider);
    await ctx.append(user(provider, 'prefix Review suffix', { timestamp: '2999-01-01T00:00:00Z', id: 'contains' }));
    await ctx.append(user(provider, ' Review ', { id: 'whitespace' }));
    const nonUser = user(provider, 'Review', { id: 'assistant' });
    if (provider === 'codex') nonUser.payload.role = 'assistant'; else nonUser.type = provider === 'claude' ? 'assistant' : 'gemini';
    await ctx.append(nonUser);
    const mixed = user(provider, 'Review', { id: 'mixed' });
    if (provider === 'claude') mixed.message.content = [{ type: 'text', text: 'Review' }, { type: 'tool_result', content: 'Review' }];
    else if (provider === 'codex') mixed.payload.content.push({ type: 'input_image', image_url: 'data:image/png,FAKE' });
    else mixed.content.push({ inlineData: { data: 'FAKE', mimeType: 'image/png' } });
    await ctx.append(mixed);
    assert.equal((await ctx.receipts.verify(ctx.ticket, 'Review')).status, 'pending');
  }
  const codex = await fixture(t, 'codex'); await codex.append(user('codex', '<environment_context>fake</environment_context>'));
  assert.equal((await codex.receipts.verify(codex.ticket, '<environment_context>fake</environment_context>')).status, 'unsupported');
});

test('Claude queue acceptance is distinct from a user turn and does not consume the checkpoint; removal is observable', async t => {
  const ctx = await fixture(t, 'claude');
  await ctx.append({ type: 'queue-operation', sessionId: nativeId, operation: 'enqueue', content: 'Review' });
  assert.deepEqual(await ctx.receipts.verify(ctx.ticket, 'Review'), { status: 'accepted', reason: 'native_queue' });
  await ctx.append({ type: 'queue-operation', sessionId: nativeId, operation: 'remove', content: 'Review' });
  assert.equal((await ctx.receipts.verify(ctx.ticket, 'Review')).status, 'pending');
  await ctx.append(user('claude', 'Review')); assert.equal((await ctx.receipts.verify(ctx.ticket, 'Review')).status, 'confirmed');
});

test('main Claude evidence excludes sidechains, metadata, local commands and tool results', async t => {
  const ctx = await fixture(t, 'claude');
  for (const fields of [{ isSidechain: true }, { isMeta: true }, { sessionId: 'child-session', isSidechain: true }, { message: { role: 'user', content: [{ type: 'tool_result', content: 'Review' }] } }])
    await ctx.append(user('claude', 'Review', fields));
  await ctx.append({ type: 'system', subtype: 'local_command', sessionId: nativeId, content: '<command-name>Review</command-name>' });
  assert.equal((await ctx.receipts.verify(ctx.ticket, 'Review')).status, 'pending');
});

test('Codex current user_message events confirm independently of response items; unknown content formats remain pending', async t => {
  const ctx = await fixture(t, 'codex');
  await ctx.append({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'Review' } });
  assert.equal((await ctx.receipts.verify(ctx.ticket, 'Review')).status, 'pending');
  await ctx.append({ type: 'event_msg', payload: { type: 'user_message', message: 'Review', images: [], local_images: [] } });
  assert.equal((await ctx.receipts.verify(ctx.ticket, 'Review')).status, 'confirmed');
});

test('Gemini assistant patches and metadata updates do not invent user receipt; matching text must have a fresh ID', async t => {
  const ctx = await fixture(t, 'gemini', [identity('gemini'), user('gemini', 'Review', { id: 'old' })]);
  await ctx.append(user('gemini', 'Review', { id: 'old' }));
  await ctx.append({ $patch: { id: 'assistant', content: 'Review' } });
  await ctx.append({ $set: { lastUpdated: '2999-01-01T00:00:00Z' } });
  assert.equal((await ctx.receipts.verify(ctx.ticket, 'Review')).status, 'pending');
  await ctx.append(user('gemini', 'Review')); assert.equal((await ctx.receipts.verify(ctx.ticket, 'Review')).status, 'confirmed');
});

test('Gemini rewinds, removals, content changes and duplicate new identities invalidate the checkpoint before acknowledgement', async t => {
  for (const changed of [{ $rewindTo: 'new-message' }, { $patch: { removeIds: ['new-message'] } }, { $patch: { id: 'new-message', content: 'Other' } }, { $set: { messages: [] } }, user('gemini', 'Other')]) {
    const ctx = await fixture(t, 'gemini'); await ctx.append(user('gemini', 'Review')); await ctx.append(changed);
    assert.equal((await ctx.receipts.verify(ctx.ticket, 'Review')).status, 'uncertain');
  }
});

test('legacy Gemini rewrite verifies immutable prior messages and new IDs across atomic file replacement', async t => {
  const prior = user('gemini', 'Review', { id: 'old' }), ctx = await fixture(t, 'gemini', [prior], true);
  assert.equal((await ctx.receipts.verify(ctx.ticket, 'Review')).status, 'pending');
  await writeFile(join(ctx.dir, 'replacement'), ctx.data([prior, user('gemini', 'Review')])); await rename(join(ctx.dir, 'replacement'), ctx.path);
  assert.equal((await ctx.receipts.verify(ctx.ticket, 'Review')).status, 'confirmed');
  const changed = await fixture(t, 'gemini', [prior], true);
  await writeFile(changed.path, changed.data([{ ...prior, content: 'Altered prior turn' }, user('gemini', 'Review')]));
  assert.equal((await changed.receipts.verify(changed.ticket, 'Review')).reason, 'history_rewritten');
});

test('torn appends and legacy writes remain pending until complete, but malformed complete records fail closed', async t => {
  const ctx = await fixture(t, 'claude'), appended = jsonl([user('claude', 'café 🧪')]), cut = Buffer.from(appended).indexOf(Buffer.from('🧪')) + 1;
  await appendFile(ctx.path, Buffer.from(appended).subarray(0, cut));
  assert.deepEqual(await ctx.receipts.verify(ctx.ticket, 'café 🧪'), { status: 'pending', reason: 'write_in_progress' });
  await appendFile(ctx.path, Buffer.from(appended).subarray(cut)); assert.equal((await ctx.receipts.verify(ctx.ticket, 'café 🧪')).status, 'confirmed');
  const malformed = await fixture(t, 'claude'); await malformed.append(user('claude', 'Review')); await appendFile(malformed.path, '{broken}\n');
  assert.equal((await malformed.receipts.verify(malformed.ticket, 'Review')).reason, 'record_invalid');
  const legacy = await fixture(t, 'gemini', [], true); await writeFile(legacy.path, '{');
  assert.equal((await legacy.receipts.verify(legacy.ticket, 'Review')).status, 'pending');
  await writeFile(legacy.path, legacy.data([user('gemini', 'Review')])); assert.equal((await legacy.receipts.verify(legacy.ticket, 'Review')).status, 'confirmed');
});

test('replaced, truncated or same-size rewritten JSONL cannot confirm even when the new file contains exact text', async t => {
  for (const mode of ['replace', 'truncate', 'rewrite']) {
    const ctx = await fixture(t, 'claude'), baseline = await readFile(ctx.path);
    if (mode === 'replace') { await writeFile(join(ctx.dir, 'replacement'), baseline); await rename(join(ctx.dir, 'replacement'), ctx.path); }
    if (mode === 'truncate') { await writeFile(ctx.path, ''); assert.equal((await ctx.receipts.verify(ctx.ticket, 'Review')).status, 'uncertain'); await writeFile(ctx.path, baseline); }
    if (mode === 'rewrite') await writeFile(ctx.path, baseline.toString().replace('Prior answer', 'Other answer'));
    await ctx.append(user('claude', 'Review'));
    assert.equal((await ctx.receipts.verify(ctx.ticket, 'Review')).status, 'uncertain');
  }
});

test('file and record identity changes cannot cross native conversations, including a forked Codex root ID', async t => {
  for (const provider of ['claude', 'codex', 'gemini']) {
    const ctx = await fixture(t, provider);
    await ctx.append(provider === 'codex' ? { type: 'session_meta', payload: { id: 'other' } } : provider === 'claude' ? { sessionId: 'other', type: 'user' } : { $set: { sessionId: 'other' } });
    await ctx.append(user(provider, 'Review')); assert.equal((await ctx.receipts.verify(ctx.ticket, 'Review')).reason, 'identity_changed');
    await writeFile(ctx.path, jsonl([{ ...identity(provider), ...(provider === 'codex' ? { payload: { id: 'other', session_id: nativeId } } : { sessionId: 'other' }) }]));
    assert.notEqual((await ctx.receipts.checkpoint(ctx.path)).status, 'ready');
  }
});

test('manual input, cancellation and closing a run revoke pending and in-flight receipt checks', async t => {
  for (const mode of ['input', 'cancel', 'close', 'during-read']) {
    const ctx = await fixture(t, 'claude'); await ctx.append(user('claude', 'Review'));
    if (mode === 'input') ctx.input();
    if (mode === 'cancel') assert.equal(ctx.receipts.cancel(ctx.ticket), true);
    if (mode === 'close') ctx.receipts.close();
    const pending = ctx.receipts.verify(ctx.ticket, 'Review');
    if (mode === 'during-read') ctx.input();
    assert.equal((await pending).status, 'uncertain');
    assert.equal((await ctx.receipts.verify(ctx.ticket, 'Review')).status, 'uncertain');
  }
  const cancelled = await fixture(t, 'claude'); const pending = cancelled.receipts.verify(cancelled.ticket, 'Review'); cancelled.receipts.cancel(cancelled.ticket);
  assert.equal((await pending).reason, 'cancelled');
});

test('opaque tickets cannot be forged, reused by another reader, or concurrently grant two receipts', async t => {
  const ctx = await fixture(t, 'claude'), other = await fixture(t, 'claude');
  for (const ticket of [{}, structuredClone(ctx.ticket), null, other.ticket]) assert.equal((await ctx.receipts.verify(ticket, 'Review')).reason, 'checkpoint_invalid');
  await ctx.append(user('claude', 'Review'));
  const results = await Promise.all([ctx.receipts.verify(ctx.ticket, 'Review'), ctx.receipts.verify(ctx.ticket, 'Review')]);
  assert.equal(results.filter(receipt => receipt.status === 'confirmed').length, 1);
  assert.equal(results.filter(receipt => receipt.reason === 'verification_in_progress').length, 1);
  assert.throws(() => { ctx.receipts.runId = 'other-run'; }, TypeError);
});

test('expected transport bytes stay bound to the checkpoint; unsupported commands/control text do not claim success', async t => {
  const ctx = await fixture(t, 'claude');
  for (const text of ['', '\x1b[201~injection', '/review', '  /review', 'x'.repeat(256 * 1024 + 1)]) assert.equal((await ctx.receipts.verify(ctx.ticket, text)).status, 'unsupported');
  assert.equal((await ctx.receipts.verify(ctx.ticket, 'First')).status, 'pending');
  assert.equal((await ctx.receipts.verify(ctx.ticket, 'Other')).reason, 'message_changed');
  await ctx.append(user('claude', 'First')); assert.equal((await ctx.receipts.verify(ctx.ticket, 'First')).status, 'uncertain');
});

test('unavailable paths, symlinks, partial checkpoints, invalid UTF-8 and size limits never grant a baseline', async t => {
  const ctx = await fixture(t, 'claude');
  for (const path of ['relative.jsonl', `${ctx.path}\0`, join(ctx.dir, 'wrong.jsonl'), ctx.dir]) assert.equal((await ctx.receipts.checkpoint(path)).status, 'unavailable');
  await writeFile(ctx.path, jsonl([identity('claude')]).trimEnd()); assert.equal((await ctx.receipts.checkpoint(ctx.path)).reason, 'write_in_progress');
  await writeFile(ctx.path, Buffer.from([0xff, 10])); assert.equal((await ctx.receipts.checkpoint(ctx.path)).reason, 'record_invalid');
  await writeFile(ctx.path, 'x'.repeat(16 * 1024 * 1024 + 1)); assert.equal((await ctx.receipts.checkpoint(ctx.path)).reason, 'size_limit');
  await writeFile(ctx.path, jsonl([identity('claude')])); const link = join(ctx.dir, 'link', `${nativeId}.jsonl`);
  if (process.platform !== 'win32') {
    const { mkdir } = await import('node:fs/promises'); await mkdir(join(ctx.dir, 'link')); await symlink(ctx.path, link);
    assert.equal((await ctx.receipts.checkpoint(link)).reason, 'file_unavailable');
  }
});

test('unknown/subagent sources, mixed session formats and malformed metadata cannot authorize confirmation', async t => {
  for (const [provider, bad] of [
    ['codex', { type: 'session_meta', payload: { id: nativeId, source: { subagent: 'parent' } } }],
    ['codex', { type: 'session_meta', payload: { id: nativeId, source: 'future_source' } }],
    ['gemini', { sessionId: nativeId, kind: 'subagent' }],
    ['gemini', { sessionId: nativeId, kind: 'future_kind' }],
    ['gemini', { sessionId: nativeId, messages: [] }],
    ['claude', { type: 'assistant', sessionId: nativeId, isSidechain: true }],
  ]) {
    const ctx = await fixture(t, provider); await writeFile(ctx.path, jsonl([bad]));
    assert.equal((await ctx.receipts.checkpoint(ctx.path)).status, 'unavailable');
  }
  const ctx = await fixture(t, 'gemini'); await ctx.append(user('gemini', 'Review')); await ctx.append({ $set: 'unexpected' });
  assert.equal((await ctx.receipts.verify(ctx.ticket, 'Review')).reason, 'record_invalid');
});

test('expired, invalidated and cancelled checkpoints cannot revive after later matching bytes appear', async t => {
  const ctx = await fixture(t, 'claude'), receipts = new NativeMessageReceipts({ provider: 'claude', nativeSessionId: nativeId, runId, getInputEpoch: () => 0, maxAgeMs: 1 });
  const { ticket } = await receipts.checkpoint(ctx.path); await new Promise(resolve => setTimeout(resolve, 10)); await ctx.append(user('claude', 'Review'));
  assert.equal((await receipts.verify(ticket, 'Review')).reason, 'checkpoint_expired');
  for (const maxAgeMs of [0, NaN, Infinity, 150001]) assert.throws(() => new NativeMessageReceipts({ provider: 'claude', nativeSessionId: nativeId, runId, getInputEpoch: () => 0, maxAgeMs }), TypeError);
  const cancelled = await fixture(t, 'gemini', [], true); await writeFile(cancelled.path, '{');
  const pending = cancelled.receipts.verify(cancelled.ticket, 'Review'); cancelled.receipts.cancel(cancelled.ticket);
  assert.equal((await pending).reason, 'cancelled');
});

test('expiry is rechecked after asynchronous reads and synchronous ownership callbacks before granting a receipt', async t => {
  const ctx = await fixture(t, 'claude'); let calls = 0;
  const receipts = new NativeMessageReceipts({ provider: 'claude', nativeSessionId: nativeId, runId, maxAgeMs: 1000, getInputEpoch: () => {
    if (++calls === 4) { const end = performance.now() + 1050; while (performance.now() < end) {} }
    return 0;
  } });
  const { ticket } = await receipts.checkpoint(ctx.path); await ctx.append(user('claude', 'Review'));
  assert.equal((await receipts.verify(ticket, 'Review')).reason, 'checkpoint_expired'); assert.equal(calls, 4);
});
