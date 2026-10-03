import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers/test-server.mjs';
import { defaultPipelineConfig } from '../src/pipeline-config.mjs';

async function fixture(t) {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const { token } = await (await fetch(`${app.url}/api/session`)).json();
  const headers = { 'Content-Type': 'application/json', 'X-STE-Token': token };
  const post = (path, body, extra = {}) => fetch(`${app.url}/api/notifications/${path}`, { method: 'POST', headers, body: JSON.stringify(body), ...extra });
  const connect = async id => {
    const controller = new AbortController(); t.after(() => controller.abort());
    const response = await post('connect', { clientId: id, consent: true, permission: 'granted' }, { signal: controller.signal });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /x-ndjson/);
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    const read = async () => { while (!buffer.includes('\n')) { const chunk = await reader.read(); if (chunk.done) throw new Error('Fixture stream ended.'); buffer += decoder.decode(chunk.value, { stream: true }); } const at = buffer.indexOf('\n'), line = buffer.slice(0, at); buffer = buffer.slice(at + 1); return JSON.parse(line); };
    const ready = await read(); assert.equal(ready.type, 'ready'); assert.equal(ready.clientId, id);
    return { read, ready, controller, ack: row => post('ack', { clientId: id, lease: ready.lease, id: row.id, receipt: row.receipt, status: 'shown' }) };
  };
  return { ...app, token, post, connect, headers };
}

test('notification reception retains token, local origin, fetch-site and bounded explicit-consent guards', async t => {
  const app = await fixture(t), body = { clientId: 'browser', consent: true, permission: 'granted' };
  for (const headers of [{ 'Content-Type': 'application/json' }, { ...app.headers, Origin: 'https://outside.test' }, { ...app.headers, 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await app.post('connect', body, { headers })).status, 403);
    assert.equal((await app.post('ack', {}, { headers })).status, 403);
  }
  assert.equal((await app.post('connect', { ...body, consent: false })).status, 400);
  assert.equal((await app.post('connect', { ...body, permission: 'denied' })).status, 400);
  assert.equal((await app.post('connect', { ...body, extra: 'x' })).status, 400);
  assert.equal((await app.post('connect', { ...body, clientId: '../unsafe' })).status, 400);
  assert.equal((await app.post('connect', { ...body, clientId: 'a'.repeat(3000) })).status, 413);
  assert.equal((await app.post('ack', {})).status, 400);
  assert.equal((await app.post('unknown', {})).status, 404);
  assert.equal((await fetch(`${app.url}/api/notifications/connect`, { headers: app.headers })).status, 405);
  const asset = await fetch(`${app.url}/notifications.js`); assert.equal(asset.status, 200); assert.match(await asset.text(), /PromptboardNotifications/);
});

test('real column notification moves record only exact display acknowledgements and never replay after reconnect', async t => {
  const app = await fixture(t), config = defaultPipelineConfig();
  for (const column of config.columns) column.strategy.autoSpawn = false;
  config.columns[2].automations.onEnter = [{ id: 'notify', name: 'Task arrival', type: 'notify', enabled: true, title: '{{title}}', body: '{{toColumn}} · {{projectName}}' }];
  const project = await app.board.createProject({ name: 'Scoped notices' });
  await app.board.setPipeline(project.id, { pipeline: config, confirm: true, expectedRevision: 1 });
  const prompt = '  Composer exact\r\n<input>  ', task = await app.board.createTask({ projectId: project.id, title: 'Literal <img src=x>', prompt });
  assert.equal((await app.board.automationRuns(task.id)).length, 0); // Saving and task creation are inert.
  const old = await app.connect('old-browser'), active = await app.connect('active-browser');
  const move = app.board.transition(task.id, { column: 'executing', expectedRevision: 1, transitionId: 'notification-move' });
  const notice = await active.read(); assert.equal(notice.type, 'notification'); assert.equal(notice.taskId, task.id); assert.equal(notice.projectId, project.id); assert.equal(notice.title, task.title); assert.match(notice.body, /Executing · Scoped notices/);
  assert.equal((await (await old.ack(notice)).json()).accepted, false);
  const forged = await app.post('ack', { clientId: 'active-browser', lease: active.ready.lease, id: notice.id, receipt: 'wrong', status: 'shown' }); assert.equal((await forged.json()).accepted, false);
  assert.equal((await (await active.ack(notice)).json()).accepted, true); await move;
  const history = await app.board.automationRuns(task.id); assert.equal(history[0].actions[0].status, 'succeeded');
  assert.equal((await (await active.ack(notice)).json()).accepted, false);
  active.controller.abort(); await app.connect('active-browser');
  await app.board.transition(task.id, { column: 'executing', expectedRevision: 1, transitionId: 'notification-move' });
  assert.equal((await app.board.automationRuns(task.id)).length, 1);
  const state = await app.board.state(); assert.equal(state.projects[0].tasks[0].prompt, prompt); assert.deepEqual(state.runs, []);
});

test('lost and cancelled browser receivers leave scoped durable outcomes without marking alerts delivered', async t => {
  const app = await fixture(t), config = defaultPipelineConfig(); for (const column of config.columns) column.strategy.autoSpawn = false;
  config.columns[2].automations.onEnter = [{ id: 'notify', name: 'Alert', type: 'notify', title: '{{title}}', body: 'Owned notice' }];
  const project = await app.board.createProject({ name: 'Receiver loss' }); await app.board.setPipeline(project.id, { pipeline: config, expectedRevision: 1, confirm: true });
  const receiver = await app.connect('browser'); const first = await app.board.createTask({ projectId: project.id, title: 'Lost', prompt: 'Exact task' });
  const moving = app.board.transition(first.id, { column: 'executing', expectedRevision: 1 }); const notice = await receiver.read();
  receiver.controller.abort(); await moving;
  assert.equal((await app.board.automationRuns(first.id))[0].actions[0].status, 'unconfirmed');
  const next = await app.connect('browser'), second = await app.board.createTask({ projectId: project.id, title: 'Cancel', prompt: 'Exact second' });
  const stopped = app.board.transition(second.id, { column: 'executing', expectedRevision: 1 }); const rejection = assert.rejects(stopped, { code: 'AUTOMATION_MOVE_CANCELLED' });
  const own = await next.read(); await app.board.cancelAutomationMove(second.id, { confirm: true }); await rejection;
  assert.equal((await next.read()).type, 'cancel'); assert.equal((await (await next.ack(own)).json()).accepted, false);
  assert.equal((await app.board.automationRuns(second.id))[0].actions[0].status, 'cancelled');
  assert.equal((await (await next.ack(notice)).json()).accepted, false);
  await app.close(); // Owned stream closure must fit the ordinary server shutdown.
});
