import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendOwnedNativeMessage } from '../src/native-message-input.mjs';
import { NativeMessageReceipts } from '../src/native-message-receipts.mjs';
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
  // A settings change waiting for a turn boundary reads that later Stop and still finds no finished turn.
  await assert.rejects(supervisor.suspendAtBoundary(w.run.id, { timeoutMs: 100 }), { code: 'PIPELINE_BOUNDARY_TIMEOUT' });
  assert.ok(updates.some(row => row.status === 'waiting_for_input'));
  assert.ok(updates.filter(row => 'turnComplete' in row).every(row => row.turnComplete === false));
  assert.doesNotMatch(JSON.stringify(updates), /PRIVATE WRITE|Literal|nativeHistoryPath/);
});

test('a native Stop during pending submission supplies neither completion nor another attempt, and unknown outcomes stay blocked', async t => {
  const w = await fixture(t), updates = [], eventsFile = join(w.dir, 'events.jsonl'); await writeFile(eventsFile, '');
  Object.assign(w.session, { eventsFile, eventsOffset: 0, seq: 0, ring: [], ringBytes: 0, subscribers: new Set(), status: 'running', turns: 0 });
  const supervisor = new Supervisor({ dataDir: w.dir, board: { run: async () => w.run,
    updateRun: async (_id, change) => { updates.push(change); return { ...w.run, ...change }; } } });
  supervisor.sessions.set(w.run.id, w.session);
  w.mode = 'none'; // The CLI never records the message, so its receipt stays pending until the budget.
  const result = await supervisor.sendNativeMessage(w.run.id, { ...w.request, timeoutMs: 1500, submitted: async () => {
    assert.equal(w.session.messageInputPending, true);
    await appendFile(eventsFile, JSON.stringify({ provider: 'claude', name: 'Stop', sessionId: nativeId }) + '\n');
    return true;
  } });
  assert.equal(result.status, 'unconfirmed'); assert.equal(w.session.messageInputPending, false);
  assert.ok(updates.some(row => row.status === 'waiting_for_input'), 'The transport read the Stop while submission was pending.');
  assert.ok(updates.filter(row => 'turnComplete' in row).every(row => row.turnComplete === false));
  assert.ok(updates.filter(row => row.activity).every(row => row.activity.ready === false));
  assert.equal((await supervisor.sendNativeMessage(w.run.id, { ...w.request, dispatchId: 'after-unknown' })).status, 'unavailable');
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

test('an exact native turn cannot release input or completion after a lost durable confirmation acknowledgement', async t => {
  const w = await fixture(t);
  assert.equal((await w.call({ confirmDelivery: async () => {
    assert.equal(w.session.messageInputPending, true); return false;
  } })).status, 'unconfirmed');
  assert.equal(w.session.messageInputUncertain, true); assert.equal(w.session.activity.uncertain, true);
  assert.equal(w.writes.filter(value => value === '\r').length, 1);
  assert.equal((await w.call({ dispatchId: 'after-lost-confirmation' })).status, 'unavailable');
  assert.equal(w.writes.filter(value => value === '\r').length, 1);
});

test('cancellation bounds a hanging confirmation save after real native input evidence without reviving the attempt', async t => {
  const w = await fixture(t), controller = new AbortController(); let release;
  const result = await w.call({ signal: controller.signal, timeoutMs: 10000, confirmDelivery: () => {
    controller.abort(); return new Promise(resolve => { release = resolve; });
  } });
  assert.equal(result.status, 'cancelled'); assert.equal(result.confirmed, false); assert.equal(w.session.messageInputUncertain, true);
  release(true); await new Promise(resolve => setImmediate(resolve)); assert.equal(w.writes.filter(value => value === '\r').length, 1);
});

test('outer deadlines differ from explicit cancellation before native input', async t => {
  for (const timeout of [true, false]) {
    const w = await fixture(t), controller = new AbortController();
    controller.abort(timeout ? new DOMException('PRIVATE deadline', 'TimeoutError') : new Error('PRIVATE cancellation'));
    const result = await w.call({ signal: controller.signal });
    assert.equal(result.status, timeout ? 'timed_out' : 'cancelled');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    assert.deepEqual(w.writes, []); assert.deepEqual(w.stages, []);
  }
});

test('an outer deadline after paste stays unconfirmed without Enter or replay', async t => {
  const w = await fixture(t), controller = new AbortController();
  w.onWrite = () => controller.abort(new DOMException('PRIVATE deadline', 'TimeoutError'));
  const result = await w.call({ signal: controller.signal });
  assert.equal(result.status, 'unconfirmed'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  assert.equal(w.session.messageInputUncertain, true); assert.equal(w.writes.length, 1);
  assert.ok(!w.writes.includes('\r'));
  assert.equal((await w.call({ dispatchId: 'after-deadline' })).status, 'unavailable');
  assert.equal(w.writes.length, 1);
});

test('pending publication of a valid owned Stop cannot revoke native receipt custody', { timeout: 10000 }, async t => {
  const w = await fixture(t), eventsFile = join(w.dir, 'events.jsonl'); await writeFile(eventsFile, '');
  Object.assign(w.session, { eventsFile, eventsOffset: 0, seq: 0, ring: [], ringBytes: 0,
    subscribers: new Set(), status: 'running', turns: 0 });
  let publishing, release;
  const entered = new Promise(resolve => { publishing = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const supervisor = new Supervisor({ dataDir: w.dir, board: { run: async () => w.run,
    updateRun: async (_id, change) => {
      if (change.status === 'waiting_for_input') { publishing(); await held; }
      return { ...w.run, ...change };
    } } });
  supervisor.sessions.set(w.run.id, w.session);
  t.after(() => release());
  let pendingWhileHeld;
  // The transport's own hook drain reads this Stop; hold its status publication for a while.
  entered.then(() => { pendingWhileHeld = w.session.eventsPending; setTimeout(release, 100); });
  const result = await supervisor.sendNativeMessage(w.run.id, { ...w.request, submitted: async () => {
    await w.request.submitted();
    await appendFile(eventsFile, JSON.stringify({ provider: 'claude', name: 'Stop', sessionId: nativeId }) + '\n');
    return true;
  } });
  assert.equal(pendingWhileHeld, true); assert.equal(result.status, 'confirmed'); assert.equal(w.session.messageInputUncertain, undefined);
  assert.equal(w.writes.filter(data => data === '\r').length, 1);
});

test('incomplete owned hooks block input until the budget without acquiring a grant', async t => {
  const w = await fixture(t);
  const result = await w.call({ timeoutMs: 100, readEvents: async () => { w.session.eventsPending = true; } });
  assert.equal(result.status, 'timed_out'); assert.deepEqual(w.writes, []); assert.deepEqual(w.stages, []);
});

test('pending hooks during paste block Enter and leave sticky uncertainty without replay', async t => {
  const w = await fixture(t); w.onWrite = () => { w.session.eventsPending = true; };
  assert.equal((await w.call()).status, 'unconfirmed'); assert.equal(w.writes.length, 1);
  assert.ok(!w.writes.includes('\r')); assert.equal(w.session.messageInputUncertain, true);
  assert.equal((await w.call({ dispatchId: 'after-pending-hook' })).status, 'unavailable');
  assert.equal(w.writes.length, 1);
});

test('native input confirmation waits for pending hooks before reading its receipt', async t => {
  const w = await fixture(t); let pendingReads = 0;
  const result = await w.call({ submitted: async () => {
    await w.request.submitted(); w.session.eventsPending = true; return true;
  }, readEvents: async () => {
    if (w.session.eventsPending && ++pendingReads === 2) w.session.eventsPending = false;
  }, confirmDelivery: async () => { assert.equal(w.session.eventsPending, false); return true; } });
  assert.equal(result.status, 'confirmed'); assert.equal(pendingReads, 2);
  assert.equal(w.writes.filter(data => data === '\r').length, 1);
});

test('a hook arriving during receipt read is drained before durable confirmation', async t => {
  const w = await fixture(t); let pendingReads = 0, proofs = 0;
  const verify = NativeMessageReceipts.prototype.verify;
  t.after(() => { NativeMessageReceipts.prototype.verify = verify; });
  NativeMessageReceipts.prototype.verify = async function (...args) {
    const result = await verify.apply(this, args);
    if (result.status === 'confirmed') { proofs++; w.session.eventsPending = true; }
    return result;
  };
  const result = await w.call({ readEvents: async () => {
    if (w.session.eventsPending && ++pendingReads === 2) w.session.eventsPending = false;
  }, confirmDelivery: async () => { assert.equal(w.session.eventsPending, false); return true; } });
  assert.equal(result.status, 'confirmed'); assert.equal(pendingReads, 2); assert.equal(proofs, 1);
  assert.equal(w.writes.filter(data => data === '\r').length, 1);
});

test('hooks arriving during receipt read cannot hide changed identity or a stalled hook', async t => {
  const verify = NativeMessageReceipts.prototype.verify;
  t.after(() => { NativeMessageReceipts.prototype.verify = verify; });
  for (const changed of [true, false]) {
    const w = await fixture(t); let saves = 0;
    NativeMessageReceipts.prototype.verify = async function (...args) {
      const result = await verify.apply(this, args);
      if (result.status === 'confirmed') w.session.eventsPending = true;
      return result;
    };
    const result = await w.call({ timeoutMs: 2000, readEvents: async () => {
      if (w.session.eventsPending && changed) {
        w.session.nativeSessionId = 'different-native'; w.session.eventsPending = false;
      }
    }, confirmDelivery: async () => { saves++; return true; } });
    assert.equal(result.status, 'unconfirmed'); assert.equal(saves, 0);
    assert.equal(w.session.messageInputUncertain, true);
    assert.equal(w.writes.filter(data => data === '\r').length, 1);
    assert.equal((await w.call({ dispatchId: 'after-receipt-hook' })).status, 'unavailable');
  }
});

test('Supervisor readiness observes owned lifecycle without I/O, input, grants or session selection', async t => {
  for (const provider of ['claude', 'codex', 'gemini']) {
    const w = await fixture(t, provider), supervisor = new Supervisor({ dataDir: w.dir, board: {
      run: () => assert.fail('A cached observation must not select or read another run.'),
      updateRun: () => assert.fail('A cached observation must not publish state.') } });
    supervisor.sessions.set(w.run.id, w.session);
    assert.equal(supervisor.nativeMessageReadiness('different-run'), 'unavailable');
    assert.equal(supervisor.nativeMessageReadiness(w.run.id), 'ready');
    w.session.activity.input(); assert.equal(supervisor.nativeMessageReadiness(w.run.id), 'waiting');
    w.session.activity.observe({ name: provider === 'claude' ? 'Stop' : provider === 'gemini' ? 'AfterAgent' : 'agent-turn-complete' }, Date.now() - 2000);
    w.session.activity.permission = true; assert.equal(supervisor.nativeMessageReadiness(w.run.id), 'waiting'); w.session.activity.permission = false;
    w.session.eventsPending = true; assert.equal(supervisor.nativeMessageReadiness(w.run.id), 'waiting'); w.session.eventsPending = false;
    w.session.initialSubmitPending = true; assert.equal(supervisor.nativeMessageReadiness(w.run.id), 'waiting'); w.session.initialSubmitPending = false;
    delete w.session.nativeSessionId; assert.equal(supervisor.nativeMessageReadiness(w.run.id), 'waiting'); w.session.nativeSessionId = nativeId;
    assert.equal(supervisor.nativeMessageReadiness(w.run.id), 'ready');
    assert.equal(w.session.inputEpoch, 0); assert.deepEqual(w.writes, []); assert.deepEqual(w.stages, []);
  }
});

test('readiness cannot waive human draft, uncertain input, termination or process ownership guards', async t => {
  for (const change of [
    w => w.session.terminalInput.manualInput('Human draft'),
    w => w.session.terminalInput.close(),
    w => { w.session.initialInputUncertain = true; },
    w => { w.session.messageInputUncertain = true; },
    w => { w.session.activity.uncertain = true; },
    w => { w.session.activity.ended = true; },
    w => { w.session.cancelled = true; },
    w => { w.session.proc = null; },
    w => { w.supervisor.stopping = true; },
  ]) {
    const w = await fixture(t); w.supervisor = new Supervisor({ dataDir: w.dir, board: {} });
    w.supervisor.sessions.set(w.run.id, w.session); change(w);
    assert.equal(w.supervisor.nativeMessageReadiness(w.run.id), 'unavailable');
    assert.equal(w.session.inputEpoch, 0); assert.deepEqual(w.writes, []); assert.deepEqual(w.stages, []);
  }
});

test('xterm automatic reports reach the PTY without counting as human input, and replayed output is marked', async t => {
  const w = await fixture(t), supervisor = new Supervisor({ dataDir: w.dir, board: {} });
  Object.assign(w.session, { seq: 0, ring: [], ringBytes: 0, subscribers: new Set() });
  supervisor.sessions.set(w.run.id, w.session);
  const reports = ['\x1b[O', '\x1b[I', '\x1b[12;40R', '\x1b[?1;2c\x1b[>0;276;0c', '\x1b]11;rgb:1111/1111/1111\x1b\\', '\x1b[0n', '\x1b[?2004;1$y', '\x1b[8;32;120t', '\x1bP1$r0m\x1b\\',
    // A click, wheel or motion over a CLI that tracks the mouse (Claude Code does) is not a draft either.
    '\x1b[<0;40;12M\x1b[<0;40;12m', '\x1b[<35;41;12M', '\x1b[<64;10;5M', '\x1b[32;40;12M', '\x1b[M !!'];
  for (const data of reports) supervisor.input(w.run.id, data);
  assert.deepEqual(w.writes, reports); assert.equal(w.session.inputEpoch, 0);
  assert.equal(supervisor.nativeMessageReadiness(w.run.id), 'ready');
  w.session.messageInputPending = true; supervisor.input(w.run.id, '\x1b[O'); w.session.messageInputPending = false;
  assert.deepEqual(w.writes, reports, 'A report never lands inside a native paste.');
  supervisor.input(w.run.id, 'x\x1b[O');
  assert.equal(w.session.inputEpoch, 1); assert.equal(supervisor.nativeMessageReadiness(w.run.id), 'unavailable');
  w.session.ring.push({ item: { seq: 1, data: '\x1b[6n' }, size: 4 }); w.session.seq = 1;
  const items = [], unsubscribe = supervisor.subscribe(w.run.id, 0, { write: item => { items.push(item); return true; }, onDrain() {}, end() {} });
  w.session.ring.push({ item: { seq: 2, data: 'live' }, size: 4 }); w.session.seq = 2;
  for (const subscriber of w.session.subscribers) subscriber.flush();
  unsubscribe();
  assert.deepEqual(items, [{ seq: 1, data: '\x1b[6n', replay: true }, { seq: 2, data: 'live' }]);
});

test('answering a CLI permission dialog keeps queued column messages deliverable; a typed draft does not', async t => {
  const w = await fixture(t), supervisor = new Supervisor({ dataDir: w.dir, board: {} });
  supervisor.sessions.set(w.run.id, w.session);
  w.session.activity.observe({ name: 'PermissionRequest', tool: 'Bash' }, Date.now());
  assert.equal(w.session.activity.snapshot().permissionPending, true);
  for (const key of ['\x1b[B', '\x1b[B', '\r']) supervisor.input(w.run.id, key);
  assert.deepEqual(w.writes, ['\x1b[B', '\x1b[B', '\r'], 'the keys still reach the CLI');
  assert.equal(w.session.terminalInput.snapshot().manualInputObserved, false, 'a dialog answer is not a draft');
  w.session.activity.observe({ name: 'PostToolUse', tool: 'Bash' }, Date.now() - 5000);
  w.session.activity.observe({ name: 'Stop' }, Date.now() - 5000);
  assert.equal(supervisor.nativeMessageReadiness(w.run.id), 'ready', 'the deferred column message can still be delivered');
  // Free text during a dialog, or a key outside one, is a human draft: messages stay unavailable.
  w.session.activity.observe({ name: 'PermissionRequest', tool: 'Bash' }, Date.now());
  supervisor.input(w.run.id, 'please use npm ci');
  assert.equal(w.session.terminalInput.snapshot().manualInputObserved, true);
  assert.equal(supervisor.nativeMessageReadiness(w.run.id), 'unavailable');
});

test('a key typed when no CLI dialog is open still counts as a human draft', async t => {
  const w = await fixture(t), supervisor = new Supervisor({ dataDir: w.dir, board: {} });
  supervisor.sessions.set(w.run.id, w.session);
  supervisor.input(w.run.id, '\r');
  assert.equal(w.session.terminalInput.snapshot().manualInputObserved, true);
  assert.equal(supervisor.nativeMessageReadiness(w.run.id), 'unavailable');
});
