// Pipeline routes over HTTP through the real server (src/network/http.mjs, wiring in src/server.mjs): token checks,
// bounded bodies, validate/publish/start/get/list/cancel/approve, nothing started by a save, an approval that waits across a
// server restart, and no secret from the run input in any Network file. The worker is the deterministic fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from '../src/board.mjs';
import { startServer } from '../src/server.mjs';
import { fakeWorker } from './helpers/network-worker.mjs';

const hex = text => createHash('sha256').update(text).digest('hex');
const N = name => `n_${hex(`step:${name}`).slice(0, 12)}`;
const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end; await tick()) { const value = await check(); if (value) return value; }
  assert.fail(`timed out: ${label}`);
}
function request(port, path, { method = 'GET', headers = {}, body, raw } = {}) {
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { Host: `127.0.0.1:${port}`, ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, json, text }); });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
async function files(dir) {
  const found = [];
  for (const name of await readdir(dir)) { const path = join(dir, name); if ((await stat(path)).isDirectory()) found.push(...await files(path)); else found.push(path); }
  return found;
}
const SECRET = 'sk-proj-4f9aZ2kQ8vW1xY7bN3mL6tR0';

test('pipeline routes over HTTP: owner checks, bounded bodies, nothing runs on save, explicit start, approval across a server restart, cancel, no secret stored', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-network-pipeline-http-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const board = new Board({ dataDir });
  for (const id of ['writer', 'checker']) await board.base.create({ id, kind: 'profile', name: id, configuration: { agent: { provider: 'claude', model: 'sonnet' } } });
  let server = null, port, token;
  const boot = async () => {
    server = await startServer({ port: 0, dataDir, executor: null, networkWorker: fakeWorker({ text: job => `Draft for ${job.nodeId}.` }), catalogReader: async provider => ({ provider, source: 'test fixture', models: [] }) });
    port = Number(new URL(server.url).port); token = (await (await fetch(`${server.url}/api/session`)).json()).token;
  };
  t.after(() => server?.close());
  await boot();
  const call = (path, method = 'GET', body) => request(port, path, { method, body, headers: { 'X-STE-Token': token } });
  const ok = async (pending, label, status = 200) => { const response = await pending; assert.equal(response.status, status, `${label}: ${response.text.slice(0, 400)}`); return response.json; };
  const agents = [];
  for (const baseResourceId of ['writer', 'checker']) {
    const { revision } = await ok(call('/api/network/agents'), 'agents');
    agents.push((await ok(call('/api/network/agents', 'POST', { baseResourceId, expectedRevision: revision }), 'register')).agent);
  }
  const { network } = await ok(call('/api/network/networks', 'POST', { name: 'Desk', nodes: agents.map((agent, i) => ({ id: N(`m${i}`), type: 'agent', agentId: agent.id, position: { x: i * 200, y: 0 } })), edges: [] }), 'network');
  await ok(call(`/api/network/networks/${network.id}/publish`, 'POST', { expectedRevision: network.revision }), 'publish network');
  const step = (name, type, config, label = name) => ({ id: N(name), type, label, position: { x: 0, y: 0 }, config });
  const edge = (from, to, fromPort) => ({ id: `e_${hex(`${from}${to}`).slice(0, 12)}`, from: N(from), to: N(to), fromPort });
  const definition = { nodes: [step('write', 'agent', { agentId: agents[0].id, instructions: 'Write it.' }), step('gate', 'approval', { prompt: 'Keep it?' }), step('check', 'agent', { agentId: agents[1].id }), step('report', 'output', { include: [N('write'), N('check')] })],
    edges: [edge('write', 'gate', 'text'), edge('write', 'check', 'text'), edge('gate', 'check', 'done'), edge('gate', 'report', 'done'), edge('check', 'report', 'text')] };

  // Owner checks and bounds, before anything is saved.
  assert.equal((await request(port, '/api/network/pipelines')).status, 403, 'no token');
  assert.equal((await request(port, '/api/network/pipelines', { method: 'POST', headers: { 'X-STE-Token': token, Origin: 'http://evil.example' }, body: {} })).status, 403);
  assert.equal((await call('/api/network/pipelines', 'POST', { networkId: network.id, networkVersion: 1, name: 'Big', description: 'x'.repeat(4 * 1024 * 1024 + 70 * 1024) })).status, 413);
  assert.equal((await call(`/api/network/pipelines/pip_${'0'.repeat(20)}`)).json.code, 'NOT_FOUND');
  assert.equal((await call(`/api/network/pipeline-runs/run_${'0'.repeat(20)}`)).status, 404);
  assert.equal((await call('/api/network/pipelines/pip_1')).status, 404, 'not a route');

  // Save, validate, publish: nothing starts.
  const { pipeline } = await ok(call('/api/network/pipelines', 'POST', { networkId: network.id, networkVersion: 1, name: 'Article', ...definition }), 'create');
  assert.deepEqual((await ok(call(`/api/network/pipelines?networkId=${network.id}`), 'list')).pipelines.map(item => [item.id, item.stepCount]), [[pipeline.id, 4]]);
  const renamed = await ok(call(`/api/network/pipelines/${pipeline.id}`, 'PATCH', { expectedRevision: 1, name: 'Article v1' }), 'rename');
  assert.equal((await call(`/api/network/pipelines/${pipeline.id}`, 'PATCH', { expectedRevision: 1, name: 'Late' })).json.code, 'REVISION_CONFLICT');
  const checked = await ok(call(`/api/network/pipelines/${pipeline.id}/validate`, 'POST', {}), 'validate');
  assert.ok(checked.valid, JSON.stringify(checked.error));
  assert.deepEqual(checked.summary.order, ['write', 'gate', 'check', 'report'].map(N));
  const published = await ok(call(`/api/network/pipelines/${pipeline.id}/publish`, 'POST', { expectedRevision: renamed.pipeline.revision }), 'publish');
  assert.equal(published.published.version, 1);
  assert.equal((await ok(call(`/api/network/pipelines/${pipeline.id}/versions/1`), 'version')).version.name, 'Article v1');
  assert.equal((await call(`/api/network/pipelines/${pipeline.id}`, 'DELETE', { expectedRevision: published.pipeline.revision })).json.code, 'PIPELINE_PUBLISHED');
  assert.deepEqual([(await ok(call('/api/network/jobs'), 'jobs')).total, (await ok(call('/api/network/pipeline-runs'), 'runs')).total], [0, 0], 'saving, validating and publishing ran nothing');

  // An explicit, confirmed start; the run waits for the approval, across a server restart.
  assert.equal((await call(`/api/network/pipelines/${pipeline.id}/runs`, 'POST', { version: 1 })).json.code, 'CONFIRMATION_REQUIRED');
  assert.equal((await call(`/api/network/pipelines/${pipeline.id}/runs`, 'POST', { version: 2, confirm: true })).json.code, 'NOT_FOUND');
  const started = await ok(call(`/api/network/pipelines/${pipeline.id}/runs`, 'POST', { version: 1, confirm: true, input: { text: `Use api_key=${SECRET} for the topic.`, json: { token: SECRET } } }), 'start', 202);
  const runPath = `/api/network/pipeline-runs/${started.runId}`;
  await until(async () => (await call(runPath)).json.run.status === 'waiting_for_approval', 'waiting for approval');
  assert.deepEqual((await ok(call(`/api/network/pipeline-runs?pipelineId=${pipeline.id}`), 'list runs')).runs.map(run => [run.id, run.status, run.steps]), [[started.runId, 'waiting_for_approval', { completed: 1, waiting_for_approval: 1, pending: 2 }]]);
  await server.close();
  await boot();
  for (let i = 0; i < 3; i++) { await tick(400); assert.equal((await call(runPath)).json.run.status, 'waiting_for_approval', 'still waiting after the restart'); }
  assert.equal((await call(`${runPath}/nodes/${N('write')}/approve`, 'POST', { decision: 'approve' })).json.code, 'STEP_STATE');
  await ok(call(`${runPath}/nodes/${N('gate')}/approve`, 'POST', { decision: 'approve' }), 'approve');
  const { run, plan } = await until(async () => { const answer = (await call(runPath)).json; return answer.run.status === 'completed' && answer; }, 'completed');
  assert.deepEqual([plan.pipeline.id, plan.pipeline.version, plan.nodes.length, run.nodes[N('gate')].approval.decision], [pipeline.id, 1, 4, 'approved']);
  const linked = await ok(call(`/api/network/jobs?pipelineRunId=${started.runId}`), 'step jobs');
  assert.deepEqual(linked.jobs.map(job => [job.nodeId, job.status]).sort(), [[N('check'), 'completed'], [N('write'), 'completed']].sort());
  assert.match((await ok(call(`/api/network/jobs/${linked.jobs.find(job => job.nodeId === N('check')).id}`), 'check job')).request.input.text, /Draft for n_[0-9a-f]{12}\./);
  assert.equal((await call(`${runPath}/cancel`, 'POST', {})).json.code, 'RUN_FINISHED');

  // Cancel a second run while it waits; reject is the other answer an approval takes.
  const second = await ok(call(`/api/network/pipelines/${pipeline.id}/runs`, 'POST', { version: 1, confirm: true }), 'second start', 202);
  await until(async () => (await call(`/api/network/pipeline-runs/${second.runId}`)).json.run.status === 'waiting_for_approval', 'second waits');
  const cancelled = await ok(call(`/api/network/pipeline-runs/${second.runId}/cancel`, 'POST', {}), 'cancel');
  assert.deepEqual([cancelled.run.status, cancelled.run.nodes[N('gate')].status], ['cancelled', 'cancelled']);
  assert.equal((await call(`/api/network/pipeline-runs/${second.runId}/nodes/${N('gate')}/approve`, 'POST', { decision: 'approve' })).json.code, 'STEP_STATE');

  // The secret in the run input is masked before anything is saved, so no Network file holds it.
  for (const path of await files(join(dataDir, 'network'))) assert.ok(!(await readFile(path, 'utf8')).includes(SECRET), `${path} holds the secret`);
  assert.equal(run.input.text, 'Use api_key=[redacted] for the topic.');
});
