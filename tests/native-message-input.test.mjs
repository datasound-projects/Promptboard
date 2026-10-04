import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendOwnedNativeMessage } from '../src/native-message-input.mjs';
import { SessionActivity } from '../src/session-activity.mjs';
import { TerminalInputObservation } from '../src/terminal-input-observation.mjs';
import { Supervisor } from '../src/supervisor.mjs';

const nativeId = 'native-owned-input';
async function fixture(t, provider = 'claude') {
  const dir = await mkdtemp(join(tmpdir(), 'pb-owned-message-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, provider === 'claude' ? nativeId + '.jsonl' : provider === 'codex' ? `rollout-fixture-${nativeId}.jsonl` : 'session-input.jsonl');
  const first = provider === 'claude' ? { type: 'user', sessionId: nativeId, message: { role: 'user', content: 'Original task' } }
    : provider === 'codex' ? { type: 'session_meta', payload: { id: nativeId, source: 'cli' } } : { sessionId: nativeId, kind: 'main' };
  await writeFile(path, JSON.stringify(first) + '\n');
  const writes = [], stages = [], activity = new SessionActivity(provider), terminalInput = new TerminalInputObservation();
  activity.observe({ name: provider === 'claude' ? 'Stop' : provider === 'gemini' ? 'AfterAgent' : 'agent-turn-complete' }, Date.now() - 2000);
  terminalInput.observeOutput('\x1b[?2004h');
  const run = { id: 'run-owned-input', sessionId: 'logical-owned', config: { pipeline: true, provider }, status: 'running' };
  let buffer = '', pending = Promise.resolve(), index = 0;
  const w = { dir, path, run, writes, stages, mode: 'confirm', onWrite: null, live: true };
  const session = w.session = { runId: run.id, pipeline: true, provider, nativeSessionId: nativeId,
    inputEpoch: 0, messageLifecycleEpoch: 0, nativeHistoryPath: path, activity, terminalInput,
    proc: { write(data) {
      writes.push(data); w.onWrite?.(data);
      if (data !== '\r') { buffer += data; return; }
      const message = buffer.slice(6, -6); buffer = '';
      const record = w.mode === 'queue' ? { type: 'queue-operation', sessionId: nativeId, operation: 'enqueue', content: message }
        : provider === 'claude' ? { type: 'user', sessionId: nativeId, message: { role: 'user', content: message } }
          : provider === 'codex' ? { type: 'event_msg', payload: { type: 'user_message', message } }
            : { id: `message-${++index}`, type: 'user', content: [{ text: message }] };
      if (w.mode !== 'none') pending = appendFile(path, JSON.stringify(record) + '\n');
    } } };
  w.request = { dispatchId: 'dispatch-one', message: '  Literal 😀\ncontinued\ttext  ', mode: 'deferred', timeoutMs: 3000,
    grant: async scope => { stages.push(['grant', scope]); return true; },
    submitted: async () => { await pending; stages.push(['submitted']); return true; },
    accepted: async () => { stages.push(['accepted']); return true; } };
  w.call = extra => sendOwnedNativeMessage({ ...w.request, ...extra, session, run, owns: () => w.live,
    readEvents: extra?.readEvents || (async () => {}) });
  return w;
}

test('deferred transport writes exact literal Unicode once and needs new native conversation evidence for each provider', async t => {
  for (const provider of ['claude', 'codex', 'gemini']) {
    const w = await fixture(t, provider), message = 'a'.repeat(999) + '😀' + 'b'.repeat(1100) + '\n  literal';
    assert.deepEqual(await w.call({ message }), { status: 'confirmed', confirmed: true });
    assert.equal(w.writes.at(-1), '\r');
    assert.equal(w.writes.slice(0, -1).join(''), '\x1b[200~' + message + '\x1b[201~');
    assert.ok(w.writes.every(chunk => chunk.isWellFormed() && Buffer.byteLength(chunk) <= 1012));
    assert.deepEqual(w.stages.map(stage => stage[0]), ['grant', 'submitted']);
    assert.deepEqual(w.stages[0][1], { dispatchId: 'dispatch-one', provider, sessionId: w.run.sessionId, runId: w.run.id,
      mode: 'deferred', messageHash: createHash('sha256').update(message).digest('hex') });
    assert.equal(w.session.messageInputUncertain, undefined);
    const count = w.writes.length; assert.equal((await w.call()).status, 'unavailable'); assert.equal(w.writes.length, count);
  }
});

test('unsupported immediate/slash/control/ill-formed input cannot acquire a grant or write terminal bytes', async t => {
  const w = await fixture(t);
  for (const extra of [{ mode: 'immediate' }, { message: '  /clear' }, { message: 'literal\x1b[200~' },
    { message: '\ud800' }, { message: 'x'.repeat(65537) }, { message: '   ' }, { dispatchId: '../outside' },
    { timeoutMs: 150001 }, { grant: undefined }]) assert.equal((await w.call(extra)).status, 'unavailable');
  assert.deepEqual(w.writes, []); assert.deepEqual(w.stages, []);
});

test('native mode, completed turn and absence of human draft are independent prerequisites', async t => {
  for (const revoke of [w => w.session.terminalInput.observeOutput('\x1b[?2004l'),
    w => w.session.terminalInput.observeOutput('\x1b['), w => w.session.terminalInput.manualInput('human draft'),
    w => w.session.activity.input(), w => { w.session.activity.permission = true; },
    w => { w.session.activity.background = 1; }, w => { w.session.paste = 'Original pending prompt'; },
    w => { w.session.initialSubmitPending = true; }, w => { w.session.initialInputUncertain = true; }]) {
    const w = await fixture(t); revoke(w);
    assert.equal((await w.call({ timeoutMs: 60 })).status, 'timed_out');
    assert.deepEqual(w.writes, []); assert.deepEqual(w.stages, []);
  }
});

test('a failed or unknown durable grant never supplies input and cannot be replayed with the same dispatch ID', async t => {
  for (const grant of [async () => false, async () => undefined, async () => { throw new Error('PRIVATE SAVE'); },
    () => new Promise(() => {})]) {
    const w = await fixture(t); const result = await w.call({ grant, timeoutMs: 100 });
    assert.ok(['unconfirmed', 'timed_out'].includes(result.status)); assert.doesNotMatch(JSON.stringify(result), /PRIVATE SAVE/);
    assert.equal((await w.call()).status, 'unavailable'); assert.deepEqual(w.writes, []);
  }
});

test('one process admits only one active attempt even when dispatch IDs differ', async t => {
  const w = await fixture(t); let release; const waiting = new Promise(resolve => { release = resolve; });
  const first = w.call({ grant: () => waiting, timeoutMs: 100 });
  assert.equal((await w.call({ dispatchId: 'second' })).status, 'unavailable');
  assert.equal((await first).status, 'timed_out'); release(true);
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(w.writes, []);
});

test('changed input after the durable grant prevents every byte, and stopped owners bound hanging callbacks', async t => {
  const w = await fixture(t);
  assert.equal((await w.call({ grant: async () => { w.session.inputEpoch++; return true; } })).status, 'unconfirmed');
  assert.deepEqual(w.writes, []); assert.equal(w.session.messageInputUncertain, undefined);
  const next = await fixture(t); let entered; const pending = new Promise(resolve => { entered = resolve; });
  const attempt = next.call({ grant: () => { entered(); return new Promise(() => {}); } });
  await pending; next.live = false;
  assert.equal((await attempt).status, 'unconfirmed'); assert.deepEqual(next.writes, []);
});

test('human input, process/native replacement and new main lifecycle revoke delayed Enter without clearing or retrying', async t => {
  for (const revoke of [w => { w.session.inputEpoch++; w.session.terminalInput.manualInput('partial draft'); },
    w => { w.session.proc = { write() { assert.fail('Replacement process cannot receive input.'); } }; },
    w => { w.session.nativeSessionId = 'different-native'; }, w => { w.session.messageLifecycleEpoch++; },
    w => { w.session.terminalInput.observeOutput('\x1b[?2004l'); }, w => { w.session.activity.permission = true; }]) {
    const w = await fixture(t); w.onWrite = () => revoke(w);
    assert.equal((await w.call()).status, 'unconfirmed');
    assert.equal(w.writes.length, 1); assert.ok(!w.writes.includes('\r')); assert.ok(!w.writes.includes('\x15'));
    assert.equal(w.session.messageInputUncertain, true); assert.equal(w.session.activity.uncertain, true);
    assert.equal((await w.call({ dispatchId: 'second' })).status, 'unavailable'); assert.equal(w.writes.length, 1);
  }
});

test('throwing or cancelled partial writes are sticky unknown outcomes and publish no raw transport errors', async t => {
  for (const fail of ['throw', 'cancel']) {
    const w = await fixture(t), controller = new AbortController();
    w.onWrite = () => { if (fail === 'throw') throw new Error('PRIVATE PTY'); controller.abort(); };
    const result = await w.call({ signal: controller.signal });
    assert.ok(['cancelled', 'unconfirmed'].includes(result.status)); assert.doesNotMatch(JSON.stringify(result), /PRIVATE PTY/);
    assert.equal(w.session.messageInputUncertain, true); assert.equal(w.writes.length, 1); assert.ok(!w.writes.includes('\r'));
  }
});

test('native queue acceptance alone never confirms submission or completion and unknown marker saves block further input', async t => {
  const w = await fixture(t), queued = new AbortController(); w.mode = 'queue';
  assert.equal((await w.call({ timeoutMs: 10000, signal: queued.signal, accepted: async () => {
    w.stages.push(['accepted']); queued.abort(); return true;
  } })).status, 'cancelled');
  assert.deepEqual(w.stages.map(row => row[0]), ['grant', 'submitted', 'accepted']);
  assert.equal(w.writes.filter(data => data === '\r').length, 1); assert.equal(w.session.messageInputUncertain, true);
  for (const hanging of [false, true]) {
    const w = await fixture(t), controller = new AbortController();
    const submitted = () => { if (!hanging) return false; controller.abort(); return new Promise(() => {}); };
    assert.equal((await w.call({ submitted, signal: controller.signal, timeoutMs: 10000 })).status, hanging ? 'cancelled' : 'unconfirmed');
    assert.equal(w.session.messageInputUncertain, true); assert.equal(w.writes.filter(data => data === '\r').length, 1);
  }
});

test('cancellation and deadlines bound event readers before input and cannot be revived by late callback acknowledgement', async t => {
  const w = await fixture(t), controller = new AbortController(); let release;
  const reading = new Promise(resolve => { release = resolve; });
  const result = w.call({ signal: controller.signal, readEvents: () => reading }); controller.abort();
  assert.equal((await result).status, 'cancelled'); release();
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(w.writes, []);
  const next = await fixture(t);
  assert.equal((await next.call({ timeoutMs: 50, readEvents: () => new Promise(() => {}) })).status, 'timed_out');
  assert.deepEqual(next.writes, []);
});

test('Supervisor binds the private writer to its live pipeline run and refuses caller-supplied ownership overrides', async t => {
  const w = await fixture(t), updates = [], eventsFile = join(w.dir, 'events.jsonl'); await writeFile(eventsFile, '');
  Object.assign(w.session, { eventsFile, eventsOffset: 0, seq: 0, ring: [], ringBytes: 0, subscribers: new Set(), status: 'running' });
  const supervisor = new Supervisor({ dataDir: w.dir, board: { run: async () => w.run,
    updateRun: async (_id, change) => { updates.push(change); return { ...w.run, ...change }; } } });
  supervisor.sessions.set(w.run.id, w.session);
  const callerOverride = { ...w.request, owns: () => true, readEvents: async () => {} };
  supervisor.stopping = true;
  assert.equal((await supervisor.sendNativeMessage(w.run.id, callerOverride)).status, 'unavailable'); assert.deepEqual(w.writes, []);
  supervisor.stopping = false; w.onWrite = () => { throw new Error('PRIVATE WRITE FAILURE'); };
  assert.equal((await supervisor.sendNativeMessage(w.run.id, { ...callerOverride, dispatchId: 'next' })).status, 'unconfirmed');
  assert.ok(updates.some(row => row.lifecycle === 'message-input-unconfirmed' && row.turnComplete === false));
  await appendFile(eventsFile, JSON.stringify({ provider: 'claude', name: 'Stop', sessionId: nativeId }) + '\n');
  await supervisor.checkpointMessage(w.run.id);
  assert.ok(updates.filter(row => 'turnComplete' in row).every(row => row.turnComplete === false));
  assert.doesNotMatch(JSON.stringify(updates), /PRIVATE WRITE|Literal|nativeHistoryPath/);
});

test('a native Stop during pending submission supplies neither completion nor a checkpoint, and lost saves stay blocked', async t => {
  const w = await fixture(t), updates = [], eventsFile = join(w.dir, 'events.jsonl'); await writeFile(eventsFile, '');
  Object.assign(w.session, { eventsFile, eventsOffset: 0, seq: 0, ring: [], ringBytes: 0, subscribers: new Set(), status: 'running', turns: 0 });
  const supervisor = new Supervisor({ dataDir: w.dir, board: { run: async () => w.run,
    updateRun: async (_id, change) => { updates.push(change); return { ...w.run, ...change }; } } });
  supervisor.sessions.set(w.run.id, w.session);
  const result = await supervisor.sendNativeMessage(w.run.id, { ...w.request, submitted: async () => {
    assert.equal(w.session.messageInputPending, true);
    await appendFile(eventsFile, JSON.stringify({ provider: 'claude', name: 'Stop', sessionId: nativeId }) + '\n');
    assert.equal((await supervisor.checkpointMessage(w.run.id)).status, 'unavailable');
    assert.equal(updates.filter(row => 'turnComplete' in row).at(-1).turnComplete, false);
    assert.equal(updates.filter(row => row.activity).at(-1).activity.ready, false);
    return false;
  } });
  assert.equal(result.status, 'unconfirmed'); assert.equal(w.session.messageInputPending, false);
  assert.ok(updates.filter(row => 'turnComplete' in row).every(row => row.turnComplete === false));
  assert.equal((await supervisor.checkpointMessage(w.run.id)).status, 'unavailable');
});

test('Supervisor budget covers preparation and final publication, retaining its lease through unknown saves', async t => {
  const w = await fixture(t), eventsFile = join(w.dir, 'events.jsonl'); await writeFile(eventsFile, '');
  Object.assign(w.session, { eventsFile, eventsOffset: 0, seq: 0, ring: [], ringBytes: 0, subscribers: new Set(), status: 'running' });
  const supervisor = new Supervisor({ dataDir: w.dir, board: { run: () => new Promise(() => {}), updateRun: async () => ({}) } });
  supervisor.sessions.set(w.run.id, w.session);
  const pending = supervisor.sendNativeMessage(w.run.id, { ...w.request, timeoutMs: 60 });
  assert.equal((await supervisor.sendNativeMessage(w.run.id, w.request)).status, 'unavailable');
  assert.equal((await pending).status, 'unavailable'); assert.deepEqual(w.writes, []);
  supervisor.board.run = async () => w.run;
  let entered, release; const publishing = new Promise(resolve => { entered = resolve; });
  supervisor.board.updateRun = async (_id, change) => {
    if ('turnComplete' in change) { entered(); await new Promise(resolve => { release = resolve; }); }
    return { ...w.run, ...change };
  };
  const controller = new AbortController();
  const delivery = supervisor.sendNativeMessage(w.run.id, { ...w.request, timeoutMs: 10000, signal: controller.signal });
  await Promise.race([publishing, delivery.then(() => assert.fail('Expected the owned publication callback to start.'))]);
  assert.equal((await supervisor.sendNativeMessage(w.run.id, { ...w.request, dispatchId: 'second' })).status, 'unavailable');
  controller.abort();
  assert.equal((await delivery).status, 'unconfirmed'); assert.equal(w.session.messageInputUncertain, true);
  assert.equal((await supervisor.sendNativeMessage(w.run.id, { ...w.request, dispatchId: 'third' })).status, 'unavailable');
  release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(w.writes.filter(data => data === '\r').length, 1);
});

test('a fresh process without an observed native ID acquires no grant and does not consume a later valid attempt', async t => {
  const w = await fixture(t); delete w.session.nativeSessionId;
  assert.equal((await w.call()).status, 'unavailable'); assert.deepEqual(w.writes, []); assert.deepEqual(w.stages, []);
  w.session.nativeSessionId = nativeId;
  assert.equal((await w.call()).status, 'confirmed');
});
