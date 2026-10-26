// Phase-2 review of Network Tasks 06–11, the page side (jsdom against the real server, fake job worker): an edit made while
// a pipeline or a network draft saves is kept (P2-1), an interrupted run can be cancelled from its view (P2-4), a job's and
// an agent's events older than one journal read are found (P2-6), the Create client form offers every agent (P2-10), and
// the Task 10 seams: "Open job" opens the Activity job record, and a run view follows the event stream, polling only while
// the stream is not live.
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
