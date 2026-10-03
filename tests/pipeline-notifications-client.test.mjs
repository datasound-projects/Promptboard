import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../public/notifications.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(fn) { const end = Date.now() + 3000; while (Date.now() < end) { if (fn()) return; await tick(); } assert.fail('Fixture receiver did not settle.'); }
function fixture(t, { supported = true, permission = 'default', requested = 'granted', stored = false } = {}) {
  const dom = new JSDOM('', { url: 'http://localhost:4318', runScripts: 'outside-only' }), win = dom.window;
  const calls = [], displays = [], opened = []; let requests = 0, stream, lease = 0;
  win.AbortController = AbortController; win.TextDecoder = TextDecoder; win.focus = () => {};
  Object.defineProperty(win, 'isSecureContext', { value: true });
  if (stored) win.localStorage.setItem('promptboard:browser-notifications', '1');
  class FakeNotification {
    static permission = permission;
    static async requestPermission() { requests++; return this.permission = requested; }
    constructor(title, options) { this.title = title; this.options = options; this.closed = false; displays.push(this); }
    close() { this.closed = true; this.onclose?.(); }
    show() { this.onshow?.(); }
    error() { this.onerror?.(); }
    click() { this.onclick?.(); }
  }
  if (supported) win.Notification = FakeNotification;
  win.fetch = async (path, options) => {
    const body = JSON.parse(options.body); calls.push({ path, options, body });
    if (path.endsWith('/ack')) return Response.json({ accepted: true });
    const ownLease = 'lease-' + ++lease, encoder = new TextEncoder(); let own;
    const bodyStream = new ReadableStream({ start(controller) {
      stream = { controller, clientId: body.clientId, lease: ownLease, closed: false };
      controller.enqueue(encoder.encode(JSON.stringify({ type: 'ready', clientId: body.clientId, lease: ownLease }) + '\n'));
      own = stream;
      options.signal.addEventListener('abort', () => { if (!own.closed) { own.closed = true; controller.close(); } }, { once: true });
    }, cancel() { own.closed = true; } });
    return new Response(bodyStream, { headers: { 'Content-Type': 'application/x-ndjson' } });
  };
  win.eval(source);
  const client = new win.PromptboardNotifications({ token: () => 'header-only-token', onOpen: ids => opened.push(ids) });
  t.after(() => { client.stop(); dom.window.close(); });
  const send = (id = 'alert-one', fields = {}) => {
    const row = { type: 'notification', lease: client.lease, receipt: `receipt-${id}`, id, taskId: 'task-one', projectId: 'project-one', title: '  Literal <img src=x>', body: 'Unicode 😀\r\n {{unknown}}', ...fields };
    client.receive(row, client.controller); return row;
  };
  return { win, client, FakeNotification, calls, displays, opened, send, requests: () => requests, stream: () => stream };
}

test('permission is requested only by explicit enable; denied, unsupported and stored preferences never prompt on resume', async t => {
  const a = fixture(t); a.client.resume(); assert.equal(a.requests(), 0); assert.equal(a.calls.length, 0);
  await a.client.enable(); await until(() => a.client.connected); assert.equal(a.requests(), 1);
  assert.equal(a.calls[0].options.headers['X-STE-Token'], 'header-only-token'); assert.equal(a.calls[0].path.includes('token'), false);
  assert.deepEqual(a.calls[0].body, { clientId: a.client.clientId, permission: 'granted', consent: true });
  a.client.disable(); assert.equal(a.client.enabled, false); assert.equal(a.client.connected, false);
  const denied = fixture(t, { requested: 'denied' }); await denied.client.enable(); assert.equal(denied.requests(), 1); assert.equal(denied.calls.length, 0); assert.equal(denied.client.enabled, false);
  const stale = fixture(t, { stored: true, permission: 'default' }); stale.client.resume(); assert.equal(stale.requests(), 0); assert.equal(stale.calls.length, 0);
  const unsupported = fixture(t, { supported: false }); await unsupported.client.enable(); assert.equal(unsupported.calls.length, 0); assert.equal(unsupported.client.supported(), false);
  const authorized = fixture(t, { stored: true, permission: 'granted' }); authorized.client.resume(); await until(() => authorized.client.connected); assert.equal(authorized.requests(), 0);
});

test('native construction is unconfirmed until show; literal fields, failure, close and scoped cancel keep exact ownership', async t => {
  const f = fixture(t); await f.client.enable(); await until(() => f.client.connected);
  const row = f.send(); assert.equal(f.calls.filter(c => c.path.endsWith('/ack')).length, 0);
  assert.equal(f.displays[0].title, row.title); assert.equal(f.displays[0].options.body, row.body);
  f.displays[0].show(); f.displays[0].show(); await tick();
  const receipts = () => f.calls.filter(c => c.path.endsWith('/ack')).map(c => c.body);
  assert.deepEqual(receipts(), [{ clientId: f.client.clientId, lease: row.lease, id: row.id, receipt: row.receipt, status: 'shown' }]);
  f.send(); assert.equal(f.displays.length, 1); // Duplicate events never produce another alert.
  const error = f.send('error'); f.displays[1].error(); assert.equal(receipts().at(-1).status, 'failed'); assert.equal(receipts().at(-1).receipt, error.receipt);
  f.send('closed'); f.displays[2].close(); assert.equal(receipts().at(-1).status, 'closed');
  const cancel = f.send('cancelled'); f.send('unrelated'); const before = receipts().length;
  f.client.receive({ type: 'cancel', id: cancel.id, receipt: 'foreign' }, f.client.controller); assert.equal(f.displays[3].closed, false);
  f.client.receive({ type: 'cancel', id: cancel.id, receipt: cancel.receipt }, f.client.controller);
  assert.equal(f.displays[3].closed, true); assert.equal(f.displays[4].closed, false); f.displays[3].show(); assert.equal(receipts().length, before);
  f.displays[4].show(); assert.equal(receipts().at(-1).id, 'unrelated');
});

test('reconnect revokes old display callbacks, duplicate grants stay inert, and task clicks supply scoped IDs only', async t => {
  const f = fixture(t); await f.client.enable(); await until(() => f.client.connected);
  const old = f.send(), oldLease = f.client.lease, oldController = f.client.controller;
  f.client.connect(); await until(() => f.client.connected && f.client.lease !== oldLease);
  assert.equal(f.displays[0].closed, true); f.displays[0].show(); f.displays[0].click(); assert.equal(f.opened.length, 0);
  f.client.receive(old, oldController); f.send(); assert.equal(f.displays.length, 1);
  assert.equal(f.calls.at(-1).body.status, 'failed');
  f.send('click'); f.displays[1].show(); f.displays[1].click();
  assert.deepEqual(JSON.parse(JSON.stringify(f.opened)), [{ taskId: 'task-one', projectId: 'project-one' }]); assert.equal(f.displays[1].closed, true);
  f.client.disable(); f.displays[1].show(); assert.equal(f.client.owned.size, 0);
});

test('malformed transport and revoked permission cannot show untrusted or oversized alerts', async t => {
  const f = fixture(t); await f.client.enable(); await until(() => f.client.connected);
  assert.throws(() => f.send('bad', { title: 'x'.repeat(501) }), /Invalid notification/);
  assert.throws(() => f.send('bad-id', { taskId: '../other' }), /Invalid notification/);
  f.FakeNotification.permission = 'denied'; f.send('revoked'); assert.equal(f.displays.length, 0); assert.equal(f.calls.at(-1).body.status, 'failed');
  f.stream().controller.enqueue(new TextEncoder().encode('x'.repeat(65537))); await until(() => !f.client.connected);
  assert.match(f.client.status, /disconnected/); assert.equal(f.requests(), 1); assert.equal(f.calls.filter(c => c.path.endsWith('/connect')).length, 1);
});

test('constructor failures cannot confirm delivery and focus restrictions do not prevent scoped task navigation', async t => {
  const f = fixture(t); await f.client.enable(); await until(() => f.client.connected);
  f.win.Notification = class extends f.FakeNotification { constructor() { throw new Error('PRIVATE BROWSER ERROR'); } };
  f.send('construction-error'); assert.equal(f.calls.at(-1).body.status, 'failed'); assert.equal(f.client.owned.size, 0); assert.doesNotMatch(JSON.stringify(f.calls.at(-1).body), /PRIVATE/);
  f.win.Notification = f.FakeNotification; f.win.focus = () => { throw new Error('Focus restricted.'); };
  f.send('focus'); f.displays[0].show(); f.displays[0].click(); assert.deepEqual(JSON.parse(JSON.stringify(f.opened)), [{ taskId: 'task-one', projectId: 'project-one' }]);
});
