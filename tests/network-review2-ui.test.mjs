// Phase-2 review of Network Tasks 06–11, the page side (jsdom against the real server, fake job worker): an edit made while
// a pipeline or a network draft saves is kept (P2-1), an interrupted run can be cancelled from its view (P2-4), a job's and
// an agent's events older than one journal read are found (P2-6), the Create client form offers every agent (P2-10), and
// the Task 10 seams: "Open job" opens the Activity job record, and a run view follows the page's one event stream (Activity's),
// polling only while that stream is not live.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, until } from './helpers/ui-harness.mjs';
import { fakeWorker } from './helpers/network-worker.mjs';

const pad = n => String(n).padStart(12, '0');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function call(ctx, path, method = 'GET', body) {
  const response = await fetch(`${ctx.app.url}${path}`, { method, headers: { 'X-STE-Token': ctx.win.__pbTest.token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, json: await response.json() };
}
async function register(ctx, names) {
  const agents = [];
  for (const [index, name] of names.entries()) {
    await ctx.app.board.base.create({ id: `b${index}`, kind: 'profile', name, configuration: { agent: { provider: 'claude' } } });
    agents.push((await call(ctx, '/api/network/agents', 'POST', { baseResourceId: `b${index}`, expectedRevision: index })).json.agent);
  }
  return agents;
}
/** Three registered agents in the network “Desk”, published as version 1. */
async function seed(ctx) {
  const agents = await register(ctx, ['Scout', 'Analyst', 'Editor']);
  const { json } = await call(ctx, '/api/network/networks', 'POST', { name: 'Desk', nodes: agents.map((agent, i) => ({ id: `n_${pad(i + 1)}`, type: 'agent', agentId: agent.id, position: { x: i * 200, y: 0 } })), edges: [] });
  await call(ctx, `/api/network/networks/${json.network.id}/publish`, 'POST', { expectedRevision: 1 });
  return { agents, network: json.network };
}
const step = (n, type, label, config) => ({ id: `n_${pad(n)}`, type, label, position: { x: n * 200, y: 0 }, config });
const edge = (n, from, to, fromPort) => ({ id: `e_${pad(n)}`, from: `n_${pad(from)}`, to: `n_${pad(to)}`, fromPort, toPort: 'input' });
/** One agent step, an approval and the report, published as version 1. */
async function approvalPipeline(ctx, { agents, network }) {
  const { json } = await call(ctx, '/api/network/pipelines', 'POST', { networkId: network.id, networkVersion: 1, name: 'Checked',
    nodes: [step(1, 'agent', 'Research', { agentId: agents[0].id }), step(2, 'approval', 'Your approval', { prompt: 'Save it?' }), step(3, 'output', 'Report', { name: 'report', include: [`n_${pad(1)}`] })],
    edges: [edge(1, 1, 2, 'text'), edge(2, 2, 3, 'done')] });
  assert.equal((await call(ctx, `/api/network/pipelines/${json.pipeline.id}/publish`, 'POST', { expectedRevision: 1 })).status, 200);
  return json.pipeline;
}
const choose = (ctx, selector, value) => { const node = ctx.$(selector); assert.ok(node, `${selector} exists`); node.value = value; node.dispatchEvent(new ctx.win.Event('change', { bubbles: true })); };
const text = (ctx, selector) => ctx.$(selector)?.textContent || '';
const stepRow = (ctx, name) => [...ctx.$('#network-pipeline-steps').querySelectorAll('[data-step-id]')].find(node => node.querySelector('strong').textContent.replace(/^\d+\. /, '') === name);
const runRow = (ctx, name) => [...ctx.$('#network-run-steps').querySelectorAll('[data-step-id]')].find(node => node.querySelector('strong').textContent === name);
/** Holds the server's answer to each matching request for `ms`, as a slow save would be; answers the function that stops it. */
function hold(ctx, method, pattern, ms = 400) {
  const original = ctx.win.fetch;
  ctx.win.fetch = async (url, options = {}) => { const answer = await original(url, options); if (options.method === method && pattern.test(String(url))) await sleep(ms); return answer; };
  return () => { ctx.win.fetch = original; };
}
function requestLog(ctx) {
  const log = [], original = ctx.win.fetch;
  ctx.win.fetch = (url, options = {}) => { log.push([options.method || 'GET', String(url)]); return original(url, options); };
  return log;
}

test('P2-1: an edit made while the pipeline draft saves, or while “Save, validate and publish” saves it, stays on the page as an unsaved change', async t => {
  const ctx = await setup(t, { hash: '#/', networkWorker: fakeWorker() }); const { $ } = ctx;
  const { agents, network } = await seed(ctx);
  const { json } = await call(ctx, '/api/network/pipelines', 'POST', { networkId: network.id, networkVersion: 1, name: 'Report',
    nodes: [step(1, 'agent', 'Research', { agentId: agents[0].id }), step(2, 'output', 'Out', { name: 'report', include: [`n_${pad(1)}`] })], edges: [edge(1, 1, 2, 'text')] });
  const id = json.pipeline.id, server = async () => (await call(ctx, `/api/network/pipelines/${id}`)).json.pipeline;
  ctx.win.location.hash = `#/network/pipelines/${id}`;
  await until(() => text(ctx, '#network-pipeline-heading') === 'Report' && stepRow(ctx, 'Research'), 'designer open');
  await ctx.idle();
  stepRow(ctx, 'Research').click();
  await until(() => $('#network-pipeline-label'), 'details');
  choose(ctx, '#network-pipeline-label', 'Research renamed');
  await until(() => stepRow(ctx, 'Research renamed') && $('#network-pipeline-dirty'), 'renamed, unsaved');

  // Save draft, answered slowly; a Parallel step is added meanwhile.
  let release = hold(ctx, 'PATCH', /\/api\/network\/pipelines\/pip_/);
  $('#network-pipeline-save').click();
  await until(() => text(ctx, '#network-pipeline-save') === 'Saving…', 'saving');
  $('#network-pipeline-add-parallel').click();
  await until(() => stepRow(ctx, 'Parallel'), 'parallel added during the save');
  await until(() => text(ctx, '#network-pipeline-save') === 'Save draft', 'save answered');
  await ctx.idle(); release();
  assert.ok(stepRow(ctx, 'Parallel') && stepRow(ctx, 'Research renamed'), 'both edits on the page');
  assert.ok($('#network-pipeline-dirty'), 'the Parallel step is an unsaved change');
  assert.equal($('#network-pipeline-undo').disabled, false, 'undo still has it');
  assert.deepEqual((await server()).nodes.map(node => node.label || node.type), ['Research renamed', 'Out'], 'the save carried what was sent');
  $('#network-pipeline-save').click();
  await until(() => !$('#network-pipeline-dirty') && !text(ctx, '#network-pipeline-save').includes('…'), 'saved again');
  assert.deepEqual((await server()).nodes.map(node => node.type), ['agent', 'output', 'parallel']);

  // Save, validate and publish: a Join added while its save runs survives the publish.
  choose(ctx, '#network-pipeline-label', 'Parallel renamed');
  await until(() => $('#network-pipeline-dirty'), 'renamed, unsaved');
  release = hold(ctx, 'PATCH', /\/api\/network\/pipelines\/pip_/);
  $('#network-pipeline-publish').click();
  await until(() => text(ctx, '#network-pipeline-save') === 'Saving…', 'saving before publish');
  $('#network-pipeline-add-join').click();
  await until(() => stepRow(ctx, 'Join'), 'join added during the save');
  await until(() => text(ctx, '#network-dialog-heading') === 'Publish version 1?', 'publish dialog');
  release();
  $('#network-confirm').click();
  await until(() => /Version 1 latest/.test(text(ctx, '#network-pipeline-meta')) && !$('#network-dialog').open, 'published');
  assert.ok(stepRow(ctx, 'Join') && $('#network-pipeline-dirty'), 'the Join step stays, unsaved, after the publish');
  const published = (await call(ctx, `/api/network/pipelines/${id}/versions/1`)).json.version;
  assert.deepEqual(published.nodes.map(node => node.label || node.type), ['Research renamed', 'Out', 'Parallel renamed'], 'version 1 is the saved draft');
  assert.ok(!(await server()).nodes.some(node => node.type === 'join'));
});

test('P2-1 (Graph): an edit made while the network draft saves stays on the page as an unsaved change', async t => {
  const ctx = await setup(t, { hash: '#/' }); const { $ } = ctx;
  const agents = await register(ctx, ['Scout', 'Analyst']);
  const { json } = await call(ctx, '/api/network/networks', 'POST', { name: 'Desk', nodes: [{ id: `n_${pad(1)}`, type: 'agent', agentId: agents[0].id, position: { x: 0, y: 0 } }], edges: [] });
  const id = json.network.id, rows = () => [...$('#network-graph-nodes').querySelectorAll('[data-node-id]')];
  ctx.win.location.hash = `#/network/graph/${id}`;
  await until(() => text(ctx, '#network-graph-heading') === 'Desk' && !$('.network-graph-body').hidden && rows().length === 1, 'editor open');
  await ctx.idle();
  $('#network-graph-add-agent').click();
  await until(() => $('#network-pick-list [data-agent-id]'), 'agents offered');
  [...$('#network-pick-list').querySelectorAll('[data-agent-id]')].find(node => node.querySelector('strong').textContent === 'Analyst').click();
  await until(() => rows().length === 2 && $('#network-graph-dirty'), 'Analyst added, unsaved');
  const analyst = rows().find(node => node.querySelector('strong').textContent === 'Analyst').dataset.nodeId;

  const release = hold(ctx, 'PATCH', /\/api\/network\/networks\/net_/);
  $('#network-graph-save').click();
  await until(() => text(ctx, '#network-graph-save') === 'Saving…', 'saving');
  // Meanwhile: a relation from Scout to Analyst.
  $(`[data-node-id="n_${pad(1)}"]`).click();
  await until(() => text(ctx, '#network-graph-detail-heading') === 'Scout', 'Scout chosen');
  choose(ctx, '#network-graph-connect-to', analyst); choose(ctx, '#network-graph-connect-relation', 'share_result');
  $('#network-graph-connect-add').click();
  await until(() => $('#network-graph-edges [data-edge-id]'), 'relation added during the save');
  await until(() => text(ctx, '#network-graph-save') === 'Save draft', 'save answered');
  await ctx.idle(); release();
  assert.ok($('#network-graph-edges [data-edge-id]'), 'the relation is still on the page');
  assert.ok($('#network-graph-dirty'), 'and unsaved');
  assert.equal($('#network-graph-undo').disabled, false);
  let saved = (await call(ctx, `/api/network/networks/${id}`)).json.network;
  assert.deepEqual([saved.nodes.length, saved.edges.length], [2, 0], 'the save carried what was sent');
  $('#network-graph-save').click();
  await until(() => !$('#network-graph-dirty') && $('#network-graph-save').disabled, 'saved again');
  saved = (await call(ctx, `/api/network/networks/${id}`)).json.network;
  assert.deepEqual([saved.nodes.length, saved.edges.length], [2, 1]);
});

test('P2-4: an interrupted run offers Cancel run, and it cancels', async t => {
  const first = await setup(t, { hash: '#/', networkWorker: fakeWorker({ mode: 'manual' }) });
  const seeded = await seed(first), pipeline = await approvalPipeline(first, seeded);
  const { runId } = (await call(first, `/api/network/pipelines/${pipeline.id}/runs`, 'POST', { version: 1, confirm: true })).json;
  const folder = join(first.dataDir, 'network', 'pipeline-runs', `run__${runId.slice(4)}`);
  await until(async () => (await call(first, `/api/network/pipeline-runs/${runId}`)).json.run.revision >= 3, 'run saved a few times (a backup exists)');
  await first.app.close();
  await writeFile(join(folder, 'run.json'), '{ damaged'); // Its .bak is good: the run comes back interrupted.

  const ctx = await setup(t, { dataDir: first.dataDir, hash: `#/network/runs/${runId}`, networkWorker: fakeWorker({ mode: 'manual' }) }); const { $ } = ctx;
  await until(() => /run of version 1/.test(text(ctx, '#network-run-heading')) && text(ctx, '#network-run-status') === 'Interrupted', 'interrupted run view');
  assert.equal($('#network-run-cancel').hidden, false, 'Cancel is offered for a run that has not ended');
  $('#network-run-cancel').click();
  await until(() => text(ctx, '#network-dialog-heading') === 'Cancel this run?', 'asks first');
  $('#network-confirm').click();
  await until(() => text(ctx, '#network-run-status') === 'Cancelled', 'cancelled');
  assert.equal($('#network-run-cancel').hidden, true);
  assert.equal((await call(ctx, `/api/network/pipeline-runs/${runId}`)).json.run.status, 'cancelled');
});

test('P2-6: a job’s and an agent’s events older than the newest 50,000 journal lines are found', async t => {
  const first = await setup(t, { hash: '#/' }); // No worker: the job stays queued.
  const [agent] = await register(first, ['Scout']);
  const { jobId } = (await call(first, '/api/network/jobs', 'POST', { agentId: agent.id, input: { text: 'Old job' } })).json;
  await until(async () => (await call(first, `/api/network/events?jobId=${jobId}`)).json.events.length >= 1, 'job event written');
  const last = (await call(first, '/api/network/events?limit=1')).json.last;
  await first.app.close();
  // 50,000 later events of other work, in the journal's own line format.
  const dir = join(first.dataDir, 'network', 'events'), segment = (await readdir(dir)).sort().at(-1), lines = [];
  for (let seq = last + 1; seq <= last + 50_000; seq++) lines.push(JSON.stringify({ seq, id: `evt_${seq.toString(16).padStart(20, '0')}`, at: Date.now(), type: 'job.status', jobId: 'job_ffffffffffffffffffff', agentId: 'agt_ffffffffffffffffffff', status: 'queued' }));
  await appendFile(join(dir, segment), `${lines.join('\n')}\n`);

  const ctx = await setup(t, { dataDir: first.dataDir, hash: `#/network/activity/${jobId}` }); const { $ } = ctx;
  await until(() => $('#network-activity-job-heading') && $('#network-activity-job-events').children.length > 0, 'the job’s events found');
  assert.ok(![...$('#network-activity-job-events').parentElement.querySelectorAll('p')].some(node => /No events of this job/.test(node.textContent)));
  ctx.win.location.hash = `#/network/agents/${agent.id}`;
  await until(() => text(ctx, '#network-detail-heading') === 'Scout', 'profile');
  $('#network-profile-tab-activity').click();
  await until(() => $('#network-agent-activity-feed')?.children.length > 0, 'the agent’s events found');
});

test('P2-10: the Create client form offers every registered agent, past the first 200', async t => {
  const ctx = await setup(t, { hash: '#/' });
  const COUNT = 205;
  for (let i = 0; i < COUNT; i++) {
    await ctx.app.board.base.create({ id: `b${i}`, kind: 'profile', name: `Agent ${String(i).padStart(3, '0')}`, configuration: { agent: { provider: 'claude' } } });
    assert.equal((await call(ctx, '/api/network/agents', 'POST', { baseResourceId: `b${i}`, expectedRevision: i })).status, 200);
  }
  ctx.win.location.hash = '#/network/settings';
  await until(() => ctx.$('#network-client-create') && !ctx.$('#network-panel-settings').hidden, 'settings');
  await ctx.idle();
  ctx.$('#network-client-create').click();
  await until(() => ctx.$('#network-client-name'), 'create form');
  const offered = [...ctx.win.document.querySelectorAll('#network-clients-dialog input[name="agents"]')];
  assert.equal(offered.length, COUNT);
  assert.ok(offered.some(box => box.closest('label')?.textContent.includes('Agent 204')), 'the last one too');
});

test('Task 10 seams: “Open job” opens the Activity job record and back; a run view follows the page’s one event stream without polling while it is live, and polls while it cannot be live', async t => {
  const ctx = await setup(t, { hash: '#/', networkWorker: fakeWorker() }); const { $, win } = ctx;
  const seeded = await seed(ctx), pipeline = await approvalPipeline(ctx, seeded);
  const runPath = runId => `/api/network/pipeline-runs/${runId}`;
  const reads = (log, runId) => log.filter(([method, url]) => method === 'GET' && url.endsWith(runPath(runId))).length;
  const streams = () => ctx.app.networkEvents.streams().local ?? 0, live = () => $('#network-activity-live')?.dataset.state;
  let most = 0; const sample = setInterval(() => { most = Math.max(most, streams()); }, 20); t.after(() => clearInterval(sample));

  // Live: the run view turns the page's one stream on; while the run waits for approval nothing is polled.
  const first = (await call(ctx, `/api/network/pipelines/${pipeline.id}/runs`, 'POST', { version: 1, confirm: true })).json.runId;
  await until(async () => (await call(ctx, runPath(first))).json.run.status === 'waiting_for_approval', 'run waits', 15000);
  const log = requestLog(ctx);
  win.location.hash = `#/network/runs/${first}`;
  await until(() => text(ctx, '#network-run-status') === 'Waiting for your approval', 'run view');
  await until(() => live() === 'live' && streams() === 1, 'the page’s stream is live');
  await sleep(300); const before = reads(log, first);
  await sleep(2500);
  assert.equal(reads(log, first), before, 'no polling while the stream is live');
  // An approval made elsewhere reaches the view through the stream.
  const approval = `n_${pad(2)}`;
  assert.equal((await call(ctx, `${runPath(first)}/nodes/${approval}/approve`, 'POST', { decision: 'approve' })).status, 200);
  await until(() => text(ctx, '#network-run-status') === 'Completed', 'completed, live', 10000);
  assert.ok(reads(log, first) > before, 'read again on its events');

  // Open job: the step's job record in Activity, which leads back to the run view.
  runRow(ctx, 'Research').click();
  await until(() => $('#network-run-open-job'), 'step details');
  const jobId = (await call(ctx, `/api/network/jobs?pipelineRunId=${first}`)).json.jobs[0].id;
  $('#network-run-open-job').click();
  await until(() => win.location.hash === `#/network/activity/${jobId}` && $('#network-activity-job-heading'), 'the Activity job record');
  assert.equal($('#network-job-json'), null, 'no JSON dialog');
  assert.ok($('#network-activity-run-events'), 'its run’s events are still offered');
  $('#network-activity-open-run').click();
  await until(() => win.location.hash === `#/network/runs/${first}` && text(ctx, '#network-run-status') === 'Completed', 'back to the run view');
  assert.equal(most, 1, 'the page never opened a second event stream');

  // Not live (every stream slot of this computer is taken): the view polls once a second and still follows the run.
  win.location.hash = '#/network';
  await until(() => live() === 'off' && !streams(), 'the page’s stream closed on both ends');
  const holders = await Promise.all(Array.from({ length: 4 }, async () => {
    const controller = new AbortController();
    const response = await fetch(`${ctx.app.url}/api/network/events/stream`, { headers: { 'X-STE-Token': win.__pbTest.token }, signal: controller.signal });
    assert.equal(response.status, 200);
    return { controller, response }; // Keep the Response alive: collecting it would release the slot this fixture needs.
  }));
  t.after(async () => { await Promise.allSettled(holders.map(async ({ controller, response }) => { controller.abort(); await response.body.cancel().catch(() => {}); })); });
  assert.equal(streams(), holders.length, 'all retained responses occupy their stream slots');
  const second = (await call(ctx, `/api/network/pipelines/${pipeline.id}/runs`, 'POST', { version: 1, confirm: true })).json.runId;
  await until(async () => (await call(ctx, runPath(second))).json.run.status === 'waiting_for_approval', 'second run waits', 15000);
  win.location.hash = `#/network/runs/${second}`;
  await until(() => text(ctx, '#network-run-status') === 'Waiting for your approval', 'second run view');
  await until(() => live() === 'limited', 'the page’s stream is refused (429)', 20000); // Its first page load can be slow in a loaded suite.
  const start = reads(log, second);
  await until(() => reads(log, second) >= start + 2, 'polled while the stream cannot be live', 4000);
  assert.equal((await call(ctx, `${runPath(second)}/nodes/${approval}/approve`, 'POST', { decision: 'approve' })).status, 200);
  await until(() => text(ctx, '#network-run-status') === 'Completed', 'completed, polled', 10000);
  const done = reads(log, second);
  await sleep(1500);
  assert.equal(reads(log, second), done, 'polling stops once the run ended');
});
