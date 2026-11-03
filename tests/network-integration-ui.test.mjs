// Wave A integration in the page (jsdom, real server, the deterministic fake worker driven through the job engine's own
// calls): a pipeline step job's events and queue row name its run and step, a worker activity is labelled by its kind, the
// job record shows the result text from the result route and links to its run's events; the agent's Tasks tab reads its
// list on job events while the event stream is live instead of polling every 2 seconds, and polls again when the stream
// cannot be live. No CLI runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setup } from './helpers/ui-harness.mjs';
import { fakeWorker } from './helpers/network-worker.mjs';

const hex = text => createHash('sha256').update(text).digest('hex');
const N = name => `n_${hex(`step:${name}`).slice(0, 12)}`;
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, ms = 10000) {
  for (const end = Date.now() + ms; Date.now() < end; await tick(10)) { const value = await check(); if (value) return value; }
  assert.fail(`timed out: ${label}`);
}
async function call(ctx, path, method = 'GET', body) {
  const response = await fetch(`${ctx.app.url}${path}`, { method, headers: { 'X-STE-Token': ctx.win.__pbTest.token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, json: await response.json() };
}
async function agent(ctx, id, provider = 'claude') {
  await ctx.app.board.base.create({ id, kind: 'profile', name: id, configuration: { agent: { provider } } });
  const { json: list } = await call(ctx, '/api/network/agents');
  return (await call(ctx, '/api/network/agents', 'POST', { baseResourceId: id, expectedRevision: list.revision })).json.agent;
}
const streamLive = ctx => until(() => ctx.$('#network-activity-live')?.dataset.state === 'live', 'the event stream is live');

test('Activity: a pipeline step job’s events and queue row name its run and step, its activity is labelled by kind, and its record shows the result text and opens the run’s events', async t => {
  const worker = fakeWorker({ mode: 'manual' });
  const ctx = await setup(t, { hash: '#/network/activity', networkWorker: worker, executor: null }); const { $, win } = ctx;
  await streamLive(ctx);
  const lead = await agent(ctx, 'lead');
  const { json: { network } } = await call(ctx, '/api/network/networks', 'POST', { name: 'Desk', nodes: [{ id: N('member'), type: 'agent', agentId: lead.id, position: { x: 0, y: 0 } }], edges: [] });
  await call(ctx, `/api/network/networks/${network.id}/publish`, 'POST', { expectedRevision: network.revision });
  const { json: { pipeline } } = await call(ctx, '/api/network/pipelines', 'POST', { networkId: network.id, networkVersion: 1, name: 'Notes',
    nodes: [{ id: N('draft'), type: 'agent', label: 'Draft', position: { x: 0, y: 0 }, config: { agentId: lead.id } }, { id: N('out'), type: 'output', label: 'Out', position: { x: 0, y: 0 }, config: { include: [N('draft')] } }],
    edges: [{ id: `e_${hex('draft>out').slice(0, 12)}`, from: N('draft'), to: N('out'), fromPort: 'text' }] });
  await call(ctx, `/api/network/pipelines/${pipeline.id}/publish`, 'POST', { expectedRevision: pipeline.revision });
  const started = worker.next();
  const { json: { runId } } = await call(ctx, `/api/network/pipelines/${pipeline.id}/runs`, 'POST', { version: 1, confirm: true });
  const entry = await started, jobId = entry.own.jobId, run = runId.slice(4, 10);
  await entry.own.launching(); entry.process = 'running'; await entry.own.spawned({ pid: 7 });
  entry.own.activity({ kind: 'web', label: 'Searched the web.' });

  // The worker's activity reaches the timeline through the engine and the journal, named by its kind and its run.
  const activity = await until(() => [...$('#network-activity-feed').querySelectorAll('[data-type="job.activity"]')].find(node => /Searched the web\./.test(node.textContent)), 'the activity event');
  assert.match(activity.textContent, new RegExp(`Job ${jobId.slice(4, 10)} \\(pipeline run ${run}, step ${N('draft')}\\) · Web search`));
  await until(() => [...$('#network-activity-feed').querySelectorAll('[data-type="job.status"]')].some(node => node.textContent.includes(`(pipeline run ${run}, step ${N('draft')}): Preparing → Running`)), 'the step job’s status names its run');
  const row = await until(() => $(`#network-activity-queue [data-open-job="${jobId}"]`)?.closest('li'), 'the step job in Running and queued');
  assert.match(row.textContent, new RegExp(`pipeline run ${run}, step ${N('draft')}`));

  // Its record: the run and step, the result text (Task 07's result route) as text, and a way to the run's events.
  const result = 'Findings: **two** sources. <script>window.hacked = true</script>';
  await entry.own.finish({ status: 'completed', exitCode: 0, result: { text: result } }); entry.end();
  await until(async () => (await call(ctx, `/api/network/pipeline-runs/${runId}`)).json.run.status === 'completed', 'run completed');
  win.location.hash = `#/network/activity/${jobId}`;
  const shown = await until(() => $('#network-activity-job .network-result'), 'the result text');
  assert.equal(shown.textContent, result);
  assert.equal(win.hacked, undefined);
  const record = $('#network-activity-job');
  assert.match(record.textContent, new RegExp(`Pipeline run.*Run ${run}: show its events.*Pipeline step${N('draft')}`));
  $('#network-activity-run-events').click();
  await until(() => win.location.hash === '#/network/activity' && win.document.activeElement === $('#network-activity-search'), 'the timeline, focus on its search');
  assert.equal($('#network-activity-search').value, runId);
  const journal = (await call(ctx, `/api/network/events?pipelineRunId=${runId}&limit=200`)).json.events;
  await until(() => $('#network-activity-feed').querySelectorAll('[data-seq]').length === journal.length, 'only the run’s events');
  const types = new Set([...$('#network-activity-feed').querySelectorAll('[data-seq]')].map(node => node.dataset.type));
  assert.deepEqual([...types].sort(), ['job.activity', 'job.status', 'pipeline.node', 'pipeline.run']);
});

test('Tasks follows the event stream: job events read the list again and the 2-second polling stops while the stream is live; without a live stream it polls', async t => {
  const worker = fakeWorker({ mode: 'manual' });
  const ctx = await setup(t, { hash: '#/', networkWorker: worker, executor: null }); const { $, win } = ctx;
  const lead = await agent(ctx, 'lead');
  const reads = [], original = win.fetch;
  win.fetch = (url, options) => { if (String(url).startsWith(`/api/network/jobs?agentId=${lead.id}`)) reads.push(Date.now()); return original(url, options); };
  const started = worker.next();
  const jobId = (await call(ctx, '/api/network/jobs', 'POST', { agentId: lead.id, input: { text: 'Collect the notes.' } })).json.jobId;
  const entry = await started;
  await entry.own.launching(); entry.process = 'running'; await entry.own.spawned({ pid: 8 });
  const item = (id = jobId) => $(`#network-job-${id}`);
  const openTasks = async id => {
    win.location.hash = `#/network/agents/${lead.id}`;
    await until(() => $('#network-profile-tab-tasks'), 'profile');
    $('#network-profile-tab-tasks').click();
    await until(() => item(id)?.dataset.status === 'running', 'the running job listed');
  };
  await openTasks(jobId);
  await streamLive(ctx);
  entry.own.activity({ kind: 'tool', label: 'Read the notes.' });
  await until(() => /Last: Read the notes\./.test(item()?.textContent || ''), 'the activity, read on its event');
  await ctx.idle();
  // While the stream is live and nothing happens, the open job's list is not read again every 2 seconds.
  const quiet = reads.length;
  await tick(2600);
  assert.equal(reads.length, quiet, 'no polling while the stream is live');
  // Each job event reads it at once (the safety read is 30 s away, beyond this wait).
  entry.own.activity({ kind: 'web', label: 'Searched the web.' });
  await until(() => /Last: Searched the web\./.test(item()?.textContent || ''), 'the next activity', 5000);
  await entry.own.finish({ status: 'completed', exitCode: 0, result: { text: 'Done.' } }); entry.end();
  await until(() => item()?.dataset.status === 'completed', 'completed, read on its status event', 5000);

  // Without a live stream (every stream slot of this computer is taken), the tab polls as before.
  win.location.hash = '#/network';
  await until(() => $('#network-activity-live')?.dataset.state === 'off' && !ctx.app.networkEvents.streams().local, 'the page’s stream closed on both ends');
  const holders = await Promise.all(Array.from({ length: 4 }, async () => {
    const controller = new AbortController();
    const response = await fetch(`${ctx.app.url}/api/network/events/stream`, { headers: { 'X-STE-Token': win.__pbTest.token }, signal: controller.signal });
    assert.equal(response.status, 200);
    return { controller, response }; // Retain the body too: Node may collect a discarded Response and close its stream.
  }));
  t.after(async () => { await Promise.allSettled(holders.map(async ({ controller, response }) => { controller.abort(); await response.body.cancel().catch(() => {}); })); });
  const second = worker.next();
  const secondId = (await call(ctx, '/api/network/jobs', 'POST', { agentId: lead.id, input: { text: 'Another one.' } })).json.jobId;
  const next = await second;
  await next.own.launching(); next.process = 'running'; await next.own.spawned({ pid: 9 });
  assert.equal(ctx.app.networkEvents.streams().local, holders.length, 'the retained responses still occupy the stream slots');
  await openTasks(secondId);
  await until(() => $('#network-activity-live')?.dataset.state === 'limited', 'the page’s stream is refused (429)');
  next.own.activity({ kind: 'tool', label: 'Polled activity.' });
  await until(() => /Last: Polled activity\./.test(item(secondId)?.textContent || ''), 'the activity, read by polling', 8000);
  const before = reads.length;
  await until(() => reads.length > before, 'the open job’s list is read again by polling without a live stream', 8000);
  next.end();
});
