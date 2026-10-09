import test from 'node:test';
import assert from 'node:assert/strict';
import { PipelineNotifications } from '../src/pipeline-notifications.mjs';

const message = (id = 'alert-one') => ({ id, taskId: 'task-one', projectId: 'project-one', title: '  Literal <img src=x> {{unknown}}', body: 'Task update\r\nUnicode 😀' });
const receiver = (broker, id = 'browser-one') => {
  const sent = []; let closed = 0;
  const client = broker.connect(id, { send: row => { sent.push(row); }, close: () => { closed++; } });
  const ack = (row, status = 'shown', extra = {}) => broker.acknowledge({ clientId: id, lease: client.lease, id: row.id, receipt: row.receipt, status, ...extra });
  return { sent, client, ack, closed: () => closed };
};

test('transport writes are unconfirmed until the exact selected receiver reports shown', async t => {
  const broker = new PipelineNotifications(); t.after(() => broker.close());
  const first = receiver(broker), second = receiver(broker, 'browser-two');
  let settled = false; const pending = broker.deliver(message()).then(result => { settled = true; return result; });
  await Promise.resolve(); assert.equal(settled, false); assert.equal(first.sent.length, 1);
  const sent = second.sent.at(-1); assert.deepEqual({ id: sent.id, taskId: sent.taskId, projectId: sent.projectId, title: sent.title, body: sent.body }, message());
  assert.equal(first.ack(sent).accepted, false); assert.equal(second.ack(sent, 'shown', { receipt: 'wrong-receipt' }).accepted, false);
  assert.equal(second.ack(sent).accepted, true); assert.deepEqual(await pending, { confirmed: true });
  assert.equal(second.ack(sent).accepted, false); assert.equal(broker.pending.size, 0);
});

test('pending duplicates share dispatch while changed metadata and finished identities never replay', async t => {
  const broker = new PipelineNotifications(); t.after(() => broker.close()); const r = receiver(broker);
  const first = broker.deliver(message()), repeated = broker.deliver(message()); assert.equal(first, repeated);
  assert.equal((await broker.deliver({ ...message(), taskId: 'other-task' })).confirmed, false);
  assert.equal(r.sent.length, 2); r.ack(r.sent.at(-1)); await first;
  assert.equal((await broker.deliver(message())).confirmed, false); assert.equal(r.sent.length, 2);
});

test('a long-running server keeps dispatching after 10,000 alerts while recent identities still never replay', async t => {
  const broker = new PipelineNotifications(); t.after(() => broker.close()); const r = receiver(broker);
  for (let n = 0; n < 10001; n++) { const pending = broker.deliver(message(`alert-${n}`)); r.ack(r.sent.at(-1)); await pending; }
  const next = broker.deliver(message('alert-next')), inFlight = broker.deliver(message('alert-next'));
  assert.equal(next, inFlight); r.ack(r.sent.at(-1)); assert.deepEqual(await next, { confirmed: true });
  assert.deepEqual(await broker.deliver(message('alert-10000')), { confirmed: false, reason: 'dispatch_unavailable' });
  assert.ok(broker.seen.size <= 10000);
});

test('receiver replacement cannot accept old receipts or replay an unknown display', async t => {
  const broker = new PipelineNotifications(); t.after(() => broker.close()); const old = receiver(broker);
  const pending = broker.deliver(message()), sent = old.sent.at(-1), fresh = receiver(broker);
  assert.equal((await pending).confirmed, false); assert.equal(old.closed(), 1);
  assert.equal(old.ack(sent).accepted, false); assert.equal(fresh.ack(sent).accepted, false);
  assert.equal(broker.disconnect(old.client), false); assert.equal(broker.clients.size, 1);
  assert.equal((await broker.deliver(message())).confirmed, false); assert.equal(fresh.sent.length, 1);
});

test('missing receivers, display errors, deadlines and scoped cancellation never invent confirmation', async t => {
  const broker = new PipelineNotifications(); t.after(() => broker.close());
  assert.equal((await broker.deliver(message('missing'))).confirmed, false); const r = receiver(broker);
  assert.equal((await broker.deliver(message('missing'))).confirmed, false); assert.equal(r.sent.length, 1);
  const failed = broker.deliver(message('failed')); r.ack(r.sent.at(-1), 'failed'); assert.equal((await failed).confirmed, false);
  const closed = broker.deliver(message('closed')); r.ack(r.sent.at(-1), 'closed'); assert.equal((await closed).confirmed, false);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timed = broker.deliver(message('timed'), { timeoutMs: 20 }); t.mock.timers.tick(20); assert.equal((await timed).confirmed, false);
  assert.deepEqual(r.sent.at(-1).type, 'cancel');
  const own = new AbortController(), stopping = broker.deliver(message('cancelled'), { signal: own.signal }), unrelated = broker.deliver(message('unrelated'));
  own.abort(new DOMException('Owned operation stopped.', 'AbortError')); await assert.rejects(stopping, { name: 'AbortError' });
  assert.equal(broker.pending.has('unrelated'), true); const other = r.sent.find(row => row.id === 'unrelated'); r.ack(other); assert.equal((await unrelated).confirmed, true);
});

test('failed transports, shutdown and malformed inputs keep ownership bounded without raw errors', async t => {
  const broker = new PipelineNotifications(); t.after(() => broker.close());
  assert.throws(() => broker.connect('../outside', { send() {} }), { code: 'NOTIFICATION_INVALID' });
  assert.throws(() => broker.connect('broken', { send() { throw new Error('PRIVATE ERROR'); } }), { code: 'NOTIFICATION_RECEIVER_LOST' });
  const r = receiver(broker); r.client.send = () => { throw new Error('PRIVATE ERROR'); };
  const failed = await broker.deliver(message()); assert.equal(failed.confirmed, false); assert.doesNotMatch(JSON.stringify(failed), /PRIVATE/);
  await assert.rejects(broker.deliver({ ...message(), title: 'x'.repeat(501) }), { code: 'NOTIFICATION_INVALID' });
  await assert.rejects(broker.deliver(message('budget'), { timeoutMs: 6000 }), { code: 'NOTIFICATION_INVALID' });
  const live = receiver(broker, 'live'), pending = broker.deliver(message('shutdown')); broker.close();
  assert.equal((await pending).confirmed, false); assert.equal(live.closed(), 1); assert.equal(broker.pending.size, 0);
  assert.equal((await broker.deliver(message('late'))).confirmed, false); assert.throws(() => receiver(broker, 'late'), { code: 'NOTIFICATION_STOPPING' });
});

test('an immediate acknowledgement can settle its already-owned dispatch grant', async () => {
  const broker = new PipelineNotifications(); let lease;
  broker.connect('instant', { send: row => {
    if (row.type === 'ready') lease = row.lease;
    else if (row.type === 'notification') broker.acknowledge({ clientId: 'instant', lease, id: row.id, receipt: row.receipt, status: 'shown' });
  } });
  assert.equal((await broker.deliver(message())).confirmed, true); assert.equal(broker.pending.size, 0); broker.close();
});

test('falsy cancellation reasons reject and asynchronous ready failures revoke only their lease', async t => {
  const broker = new PipelineNotifications(); t.after(() => broker.close());
  const r = receiver(broker), control = new AbortController(), pending = broker.deliver(message(), { signal: control.signal });
  control.abort(0); let rejected = false;
  await pending.then(() => assert.fail('An aborted display resolved.'), reason => { rejected = true; assert.equal(reason, 0); });
  assert.equal(rejected, true); assert.equal(r.sent.at(-1).type, 'cancel');
  const broken = broker.connect('async-broken', { send: () => Promise.reject(new Error('PRIVATE')) });
  await Promise.resolve(); assert.equal(broken.closed, true); assert.equal(broker.clients.get(r.client.clientId), r.client);
});

test('receiver and pending bounds refuse extra grants while preserving existing exact receipts', async t => {
  const broker = new PipelineNotifications(); t.after(() => broker.close());
  const clients = Array.from({ length: 8 }, (_, i) => receiver(broker, `browser-${i}`));
  assert.throws(() => receiver(broker, 'overflow'), { code: 'NOTIFICATION_RECEIVER_LIMIT' });
  const selected = clients.at(-1), pending = Array.from({ length: 128 }, (_, i) => broker.deliver(message(`alert-${i}`)));
  assert.equal(broker.pending.size, 128); assert.equal((await broker.deliver(message('overflow'))).confirmed, false);
  selected.ack(selected.sent.at(-1)); assert.equal((await pending.at(-1)).confirmed, true);
  const freed = broker.deliver(message('freed')); selected.ack(selected.sent.at(-1)); assert.equal((await freed).confirmed, true);
  broker.close(); const results = await Promise.all(pending.slice(0, -1)); assert.equal(results.every(result => result.confirmed === false), true);
  assert.equal(broker.pending.size, 0); assert.equal(broker.clients.size, 0);
});
