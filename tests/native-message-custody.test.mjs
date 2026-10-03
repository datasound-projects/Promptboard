import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Supervisor } from '../src/supervisor.mjs';
import { SessionActivity } from '../src/session-activity.mjs';

const nativeId = '11111111-2222-3333-4444-555555555555';
const user = (provider, text, id = 'new-user') => provider === 'claude'
  ? { type: 'user', sessionId: nativeId, message: { role: 'user', content: text } }
  : provider === 'codex' ? { type: 'event_msg', payload: { type: 'user_message', message: text } }
    : { id, type: 'user', content: [{ text }] };
async function fixture(t, provider = 'claude', { historyAt = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pb-native-custody-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const eventsFile = join(dir, 'events.jsonl'), writes = [], updates = [], startedAt = Date.now();
  let path = join(dir, provider === 'claude' ? `${nativeId}.jsonl` : `session-fixture.jsonl`);
  if (provider === 'codex') {
    const previousHome = process.env.CODEX_HOME; process.env.CODEX_HOME = dir;
    t.after(() => { if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome; });
    const date = new Date(historyAt ?? startedAt), parts = [String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')], day = join(dir, 'sessions', ...parts);
    await mkdir(day, { recursive: true }); path = join(day, `rollout-${parts.join('-')}T00-00-00-${nativeId}.jsonl`);
  }
  const first = provider === 'claude' ? user(provider, 'Original task') : provider === 'codex'
    ? { type: 'session_meta', payload: { id: nativeId, source: 'cli' } } : { sessionId: nativeId, kind: 'main' };
  await writeFile(path, JSON.stringify(first) + '\n');
  await writeFile(eventsFile, JSON.stringify({ provider, name: provider === 'codex' ? 'agent-turn-complete' : 'SessionStart',
    sessionId: nativeId, transcriptPath: path }) + '\n');
  const run = { id: 'receipt-run', config: { provider, pipeline: true }, status: 'running' };
  const board = { run: async () => structuredClone(run), updateRun: async (_id, change) => { updates.push(structuredClone(change)); Object.assign(run, change); return structuredClone(run); } };
  const supervisor = new Supervisor({ board, dataDir: dir });
  // A controlled PTY seam, with no real provider, process, timer or network call.
  const session = { runId: run.id, provider, pipeline: true, proc: { write: data => writes.push(data) }, inputEpoch: 0,
    sessionId: nativeId, eventsFile, eventsOffset: 0, startedAt, runDir: dir,
    activity: new SessionActivity(provider), status: 'running', turns: 0, seq: 0, ring: [], ringBytes: 0, subscribers: new Set() };
  supervisor.sessions.set(run.id, session);
  const emit = event => appendFile(eventsFile, JSON.stringify({ provider, ...event }) + '\n');
  let messageNumber = 0;
  const append = text => appendFile(path, JSON.stringify(user(provider, text, `new-user-${++messageNumber}`)) + '\n');
  return { supervisor, session, path, dir, writes, updates, run, emit, append };
}

test('Supervisor binds opaque receipt tickets to exact main Claude/Gemini hook paths and Codex thread history without input', async t => {
  for (const provider of ['claude', 'gemini', 'codex']) {
    const w = await fixture(t, provider), text = '  literal message\nwith whitespace  ';
    const baseline = await w.supervisor.checkpointMessage(w.run.id);
    assert.equal(baseline.status, 'ready'); assert.equal(JSON.stringify(baseline.ticket), '{}');
    assert.equal(Object.isFrozen(baseline.ticket), true);
    assert.equal((await w.supervisor.verifyMessage(baseline.ticket, text)).status, 'pending');
    await w.append(text);
    assert.equal((await w.supervisor.verifyMessage(baseline.ticket, text)).status, 'confirmed');
    assert.equal((await w.supervisor.verifyMessage(baseline.ticket, text)).status, 'uncertain');
    assert.deepEqual(w.writes, []);
    assert.doesNotMatch(JSON.stringify(w.updates), /transcriptPath|nativeHistoryPath|literal message/);
  }
});

test('native queue acceptance stays distinct from confirmation, and partial manual input immediately revokes the checkpoint', async t => {
  const w = await fixture(t), baseline = await w.supervisor.checkpointMessage(w.run.id), text = 'Automated continuation';
  await appendFile(w.path, JSON.stringify({ type: 'queue-operation', sessionId: nativeId, operation: 'enqueue', content: text }) + '\n');
  assert.deepEqual(await w.supervisor.verifyMessage(baseline.ticket, text), { status: 'accepted', reason: 'native_queue' });
  w.supervisor.input(w.run.id, 'human draft'); assert.deepEqual(w.writes, ['human draft']);
  await w.append(text);
  assert.deepEqual(await w.supervisor.verifyMessage(baseline.ticket, text), { status: 'uncertain', reason: 'input_changed' });
  const fresh = await w.supervisor.checkpointMessage(w.run.id);
  w.supervisor.input(w.run.id, ''); // Empty input supplies no bytes and does not invalidate proof.
  await w.append('Fresh continuation');
  assert.equal((await w.supervisor.verifyMessage(fresh.ticket, 'Fresh continuation')).status, 'confirmed');
});

test('Supervisor locates an older resumed Codex conversation by exact native metadata without typing or exposing its path', async t => {
  const w = await fixture(t, 'codex', { historyAt: Date.UTC(2025, 0, 2) });
  const baseline = await w.supervisor.checkpointMessage(w.run.id); assert.equal(baseline.status, 'ready');
  await w.append('Older resumed continuation');
  assert.equal((await w.supervisor.verifyMessage(baseline.ticket, 'Older resumed continuation')).status, 'confirmed');
  assert.deepEqual(w.writes, []); assert.doesNotMatch(JSON.stringify(w.updates), /rollout-|Older resumed continuation/);
});

test('main startup invalidates prior receipt epochs while subordinate startup cannot redirect or revoke the main history', async t => {
  for (const provider of ['claude', 'gemini']) {
    const w = await fixture(t, provider), before = await w.supervisor.checkpointMessage(w.run.id);
    await w.emit({ name: 'SessionStart', sessionId: 'child-native', agentId: 'child', transcriptPath: join(w.dir, 'child.jsonl') });
    await w.append('Main continuation');
    assert.equal((await w.supervisor.verifyMessage(before.ticket, 'Main continuation')).status, 'confirmed');
    const old = await w.supervisor.checkpointMessage(w.run.id);
    await w.emit({ name: 'SessionStart', sessionId: nativeId, transcriptPath: w.path });
    await w.append('Old lifecycle continuation');
    assert.equal((await w.supervisor.verifyMessage(old.ticket, 'Old lifecycle continuation')).status, 'uncertain');
    const fresh = await w.supervisor.checkpointMessage(w.run.id);
    await w.append('New lifecycle continuation');
    assert.equal((await w.supervisor.verifyMessage(fresh.ticket, 'New lifecycle continuation')).status, 'confirmed');
  }
});

test('a new native conversation revokes old evidence and requires its own exact history identity', async t => {
  for (const provider of ['claude', 'gemini']) {
    const w = await fixture(t, provider), before = await w.supervisor.checkpointMessage(w.run.id);
    const nextId = '66666666-7777-8888-9999-000000000000', nextPath = join(w.dir, provider === 'claude' ? `${nextId}.jsonl` : 'session-next.jsonl');
    await writeFile(nextPath, JSON.stringify(provider === 'claude' ? { ...user(provider, 'Next task'), sessionId: nextId } : { sessionId: nextId, kind: 'main' }) + '\n');
    await w.emit({ name: 'SessionStart', sessionId: nextId, transcriptPath: nextPath }); await w.append('Old conversation message');
    assert.equal((await w.supervisor.verifyMessage(before.ticket, 'Old conversation message')).status, 'uncertain');
    const next = await w.supervisor.checkpointMessage(w.run.id); assert.equal(next.status, 'ready');
    const message = user(provider, 'Next conversation message'); if (provider === 'claude') message.sessionId = nextId;
    await appendFile(nextPath, JSON.stringify(message) + '\n');
    assert.equal((await w.supervisor.verifyMessage(next.ticket, 'Next conversation message')).status, 'confirmed');
    assert.deepEqual(w.writes, []);
  }
});

test('closed, cancelled, uncertain or replaced owners cannot confirm matching late native messages', async t => {
  for (const invalidate of [w => { w.session.proc = null; }, w => { w.session.proc = { write() {} }; },
    w => { w.supervisor.sessions.delete(w.run.id); }, w => { w.supervisor.stopping = true; },
    w => { w.session.cancelled = true; }, w => { w.session.suspending = true; }, w => { w.session.exiting = true; }, w => { w.session.failure = {}; },
    w => { w.session.launchFailed = true; }, w => { w.session.activity.ended = true; }, w => { w.session.activity.uncertain = true; }]) {
    const w = await fixture(t), baseline = await w.supervisor.checkpointMessage(w.run.id);
    invalidate(w); await w.append('Late matching message');
    assert.equal((await w.supervisor.verifyMessage(baseline.ticket, 'Late matching message')).status, 'uncertain');
    assert.deepEqual(w.writes, []);
  }
  const w = await fixture(t), baseline = await w.supervisor.checkpointMessage(w.run.id);
  assert.equal(w.supervisor.cancelMessageCheckpoint(baseline.ticket), true);
  assert.equal(w.supervisor.cancelMessageCheckpoint(baseline.ticket), false);
  await w.append('Cancelled matching message');
  assert.deepEqual(await w.supervisor.verifyMessage(baseline.ticket, 'Cancelled matching message'), { status: 'uncertain', reason: 'cancelled' });
});

test('missing, partial or malformed lifecycle evidence grants no checkpoint and cannot revive a failed ticket', async t => {
  for (const suffix of ['{"partial', '{broken}\n']) {
    const w = await fixture(t), baseline = await w.supervisor.checkpointMessage(w.run.id);
    await appendFile(w.session.eventsFile, suffix); await w.append('Uncertain continuation');
    assert.equal((await w.supervisor.verifyMessage(baseline.ticket, 'Uncertain continuation')).status, 'uncertain');
    assert.equal((await w.supervisor.checkpointMessage(w.run.id)).status, 'unavailable');
  }
  const w = await fixture(t), baseline = await w.supervisor.checkpointMessage(w.run.id), bytes = await readFile(w.session.eventsFile);
  await rm(w.session.eventsFile);
  assert.deepEqual(await w.supervisor.verifyMessage(baseline.ticket, 'Missing events'), { status: 'uncertain', reason: 'events_unavailable' });
  assert.deepEqual(await w.supervisor.checkpointMessage(w.run.id), { status: 'unavailable', reason: 'events_unavailable' });
  await writeFile(w.session.eventsFile, bytes); await w.append('Missing events');
  assert.equal((await w.supervisor.verifyMessage(baseline.ticket, 'Missing events')).status, 'uncertain');
});

test('unknown tickets, absent/legacy sessions and unreported or mismatched paths remain unavailable', async t => {
  const w = await fixture(t);
  assert.equal((await w.supervisor.checkpointMessage('unknown-run')).status, 'unavailable');
  assert.deepEqual(await w.supervisor.verifyMessage({}, 'Message'), { status: 'uncertain', reason: 'checkpoint_invalid' });
  assert.equal(w.supervisor.cancelMessageCheckpoint(null), false);
  w.session.pipeline = false;
  assert.equal((await w.supervisor.checkpointMessage(w.run.id)).status, 'unavailable');
  w.session.pipeline = true;
  await writeFile(w.session.eventsFile, JSON.stringify({ provider: 'claude', name: 'SessionStart', sessionId: nativeId }) + '\n');
  assert.deepEqual(await w.supervisor.checkpointMessage(w.run.id), { status: 'unavailable', reason: 'history_unavailable' });
  await w.emit({ name: 'SessionStart', sessionId: nativeId, transcriptPath: join(w.dir, 'wrong-id.jsonl') });
  assert.equal((await w.supervisor.checkpointMessage(w.run.id)).status, 'unavailable');
  assert.deepEqual(w.writes, []);
});
