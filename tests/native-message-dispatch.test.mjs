import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PipelineJournal } from '../src/pipeline-journal.mjs';
import { NativeMessageDispatch } from '../src/native-message-dispatch.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pb-native-dispatch-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const journal = new PipelineJournal(dir), calls = [];
  const scope = message => ({ provider: 'claude', sessionId: 'logical-session', runId: 'native-run', mode: 'deferred', messageHash: createHash('sha256').update(message).digest('hex') });
  let handler = async request => {
    assert.equal(await request.grant({ dispatchId: request.dispatchId, ...scope(request.message) }), true);
    calls.push(request.message); assert.equal(await request.submitted(), true); assert.equal(await request.confirmDelivery(), true);
    return { status: 'confirmed', confirmed: true };
  };
  const dispatcher = new NativeMessageDispatch({ journal, supervisor: { sendNativeMessage: (_id, request) => handler(request) } });
  t.after(() => dispatcher.shutdown());
  const schedule = async (name, message = `Literal ${name} 😀`) => {
    const key = { projectId: 'project', taskId: 'task', transitionId: name };
    const { move } = await journal.beginMove({ ...key, taskRevision: 1, projectRevision: 1,
      from: { id: 'before', name: 'Before' }, to: { id: 'after', name: 'After' }, onEnter: [{ id: 'message', name: 'Review', type: 'send_message', enabled: true, mode: 'deferred', message }] });
    await journal.advance(key); await journal.startLifecycle(key); await journal.finishLifecycle(key, { status: 'succeeded' });
    const actionId = move.actions[0].id; await journal.startAction(key, actionId); await journal.scheduleMessage(key, actionId, scope(message)); await journal.advance(key);
    return { key, actionId, message, scope: scope(message) };
  };
  return { journal, dispatcher, schedule, calls, handle: fn => { handler = fn; }, delivery: async request => (await journal.read(request.key)).actions[0].delivery };
}
const checked = { preflight: async () => true };

test('native callbacks acknowledge exact journal stages before success and do not replay completed placement', async t => {
  const w = await fixture(t), request = await w.schedule('first');
  assert.equal((await w.dispatcher.deliver(request, checked)).confirmed, true);
  const record = await w.journal.read(request.key), receipt = record.actions[0].delivery;
  assert.equal(record.status, 'completed'); assert.equal(record.actions[0].status, 'scheduled'); assert.equal(receipt.status, 'confirmed');
  assert.ok(receipt.dispatchStartedAt <= receipt.submittedAt && receipt.submittedAt <= receipt.finishedAt);
  assert.doesNotMatch(JSON.stringify(record), /Literal first|😀/);
  assert.equal((await w.dispatcher.deliver(request, checked)).confirmed, false); assert.deepEqual(w.calls, [request.message]);
});

test('a transport success claim without native grant/submission/receipt callbacks cannot fabricate confirmation', async t => {
  const w = await fixture(t), request = await w.schedule('forged'); w.handle(async () => ({ status: 'confirmed', confirmed: true }));
  assert.equal((await w.dispatcher.deliver(request, checked)).status, 'failed');
  assert.equal((await w.delivery(request)).status, 'failed'); assert.equal((await w.delivery(request)).submittedAt, undefined); assert.deepEqual(w.calls, []);
});

test('hash, mode and target mismatches supply no native input or dispatch grant', async t => {
  const w = await fixture(t), request = await w.schedule('scope');
  for (const scope of [{ ...request.scope, runId: 'foreign-run' }, { ...request.scope, sessionId: 'foreign-logical' },
    { ...request.scope, provider: 'codex' }, { ...request.scope, mode: 'immediate' }, { ...request.scope, messageHash: '0'.repeat(64) }])
    assert.equal((await w.dispatcher.deliver({ ...request, scope }, checked)).confirmed, false);
  assert.equal((await w.delivery(request)).status, 'queued'); assert.deepEqual(w.calls, []);
});

test('one process run preserves invocation FIFO; cancelled later requests cannot erase an earlier live tail', async t => {
  const w = await fixture(t), first = await w.schedule('one'), second = await w.schedule('two'), third = await w.schedule('three');
  let release, entered; const started = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  w.handle(async request => {
    assert.equal(await request.grant({ dispatchId: request.dispatchId, ...first.scope, messageHash: createHash('sha256').update(request.message).digest('hex') }), true);
    w.calls.push(request.message); if (request.message === first.message) {
      entered(); await new Promise((resolve, reject) => {
        const abort = () => reject(new Error('Fixture stopped.')); request.signal.addEventListener('abort', abort, { once: true });
        held.then(() => { request.signal.removeEventListener('abort', abort); resolve(); });
        if (request.signal.aborted) abort();
      });
    }
    assert.equal(await request.submitted(), true); assert.equal(await request.confirmDelivery(), true); return { status: 'confirmed', confirmed: true };
  });
  const a = w.dispatcher.deliver(first, checked); await started;
  const read = w.journal.read.bind(w.journal), observed = Promise.withResolvers();
  w.journal.read = async key => { const record = await read(key); if (key.transitionId === second.key.transitionId) observed.resolve(); return record; };
  const controller = new AbortController(), b = w.dispatcher.deliver(second, { ...checked, signal: controller.signal });
  await observed.promise; await new Promise(resolve => setImmediate(resolve)); controller.abort();
  assert.equal((await b).status, 'cancelled'); assert.equal((await w.delivery(second)).status, 'cancelled');
  const c = w.dispatcher.deliver(third, checked); await new Promise(resolve => setTimeout(resolve, 30)); assert.deepEqual(w.calls, [first.message]);
  release(); assert.equal((await a).confirmed, true); assert.equal((await c).confirmed, true); assert.deepEqual(w.calls, [first.message, third.message]);
});

test('lost final receipt acknowledgement retains a blocked owner and prevents later native input', async t => {
  const w = await fixture(t), first = await w.schedule('lost'), second = await w.schedule('later');
  const finish = w.journal.finishMessageDelivery.bind(w.journal); let publications = 0;
  w.journal.finishMessageDelivery = async (...args) => { publications++; await finish(...args); return false; };
  assert.equal((await w.dispatcher.deliver(first, checked)).blocked, true);
  assert.equal((await w.delivery(first)).status, 'confirmed');
  assert.equal((await w.dispatcher.deliver(second, checked)).confirmed, false); assert.equal((await w.delivery(second)).status, 'queued');
  assert.deepEqual(w.calls, [first.message]); assert.equal(w.dispatcher.jobs.size, 1);
  assert.equal(publications, 1);
});

test('queued cancellation cannot overwrite a concurrently acquired dispatch grant', async t => {
  const w = await fixture(t), request = await w.schedule('competing');
  assert.equal((await w.journal.startMessageDelivery(request.key, request.actionId)).accepted, true);
  assert.equal(await w.journal.finishQueuedMessageDelivery(request.key, request.actionId, { status: 'cancelled' }), false);
  assert.equal((await w.delivery(request)).status, 'dispatching');
  await assert.rejects(w.journal.finishQueuedMessageDelivery(request.key, request.actionId, { status: 'confirmed' }), { code: 'JOURNAL_ORDER' });
});

test('preflight rejection and shutdown finish known queued input without acquiring a native grant', async t => {
  const w = await fixture(t), request = await w.schedule('preflight');
  assert.equal((await w.dispatcher.deliver(request, { preflight: async () => false })).confirmed, false);
  assert.equal((await w.delivery(request)).status, 'unconfirmed'); assert.equal((await w.delivery(request)).dispatchStartedAt, undefined);
  await w.dispatcher.shutdown(); assert.equal((await w.dispatcher.deliver(await w.schedule('closed'), checked)).status, 'unavailable'); assert.deepEqual(w.calls, []);
});
