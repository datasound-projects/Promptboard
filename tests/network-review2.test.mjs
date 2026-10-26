// Phase-2 review of Network Tasks 06–11 (docs/network/implementation-progress.md, "Phase-2 review fixes"): the server-side
// findings, each with the scenario that showed it. Machine stream slots dropped during an await (P2-2), retention of a
// finished run's step-job logs when the runner loads second (P2-3), journal replay cost (P2-5), a join(any) report about a
// step still running (P2-7), a job read from its backup (P2-8), a machine client's stream after its expiry (P2-9) and a
// worker entry left by a cancel during claim (P2-11). Fake workers and fake CLIs only; temporary folders; port 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NetworkEvents } from '../src/network/events.mjs';
import { LocalJobWorker } from '../src/network/worker-local.mjs';
import { fakeWorker } from './helpers/network-worker.mjs';
import { fixture, until } from './helpers/network-machine.mjs';

const pad = n => String(n).padStart(12, '0');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = path => access(path).then(() => true, () => false);
const DAY = 86_400_000;

/** Opens a machine event stream and drops the connection after `ms`, before any answer. */
function openAndDrop(port, token, ms) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: '/machine/v1/events/stream?after=0', headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${token}` } });
    req.on('error', () => resolve());
    req.end();
    setTimeout(() => { req.destroy(); resolve(); }, ms);
  });
}
/** Opens a machine event stream: its status, its NDJSON lines as they come, whether it ended, and a way to close it. */
function openStream(port, token) {
  const stream = { status: null, lines: [], ended: false };
  const req = http.request({ host: '127.0.0.1', port, path: '/machine/v1/events/stream', headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${token}` } }, res => {
    stream.status = res.statusCode; res.setEncoding('utf8'); let buffer = '';
    res.on('data', chunk => { buffer += chunk; for (let end; (end = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(end + 1)) { try { stream.lines.push(JSON.parse(buffer.slice(0, end))); } catch {} } });
    res.on('close', () => { stream.ended = true; });
  });
  req.on('error', () => { stream.ended = true; }); req.end();
  stream.close = () => req.destroy();
  return stream;
}
async function streamAnswers(ctx, token) {
  const stream = openStream(ctx.machinePort, token);
  await until(() => stream.status !== null && (stream.status !== 200 || stream.lines.length), 'stream answer');
  stream.close();
  return `${stream.status} ${JSON.stringify(stream.lines[0] ?? null)}`;
}

test('P2-2: a machine stream dropped while the listener authenticates it or scans its own jobs gives its slot back', async t => {
  const ctx = await fixture(t);
  const lead = await ctx.register('lead');
  const { token } = await ctx.client({ agents: [lead.id] });
  await ctx.on();
  const { jobs, clients } = ctx.app.machine;
  // Eight readers leave during a slow first own-job scan (a large job index): every slot comes back.
  const list = jobs.list.bind(jobs);
  jobs.list = async (...args) => { await sleep(300); return list(...args); };
  await Promise.all(Array.from({ length: 8 }, () => openAndDrop(ctx.machinePort, token, 50)));
  await sleep(800);
  jobs.list = list;
  assert.match(await streamAnswers(ctx, (await ctx.client({ agents: [lead.id] })).token), /^200 /, 'slots freed after drops during the scan');
  // Eight more leave while their token is checked (before the stream is counted at all): no slot is lost either.
  const authenticate = clients.authenticate.bind(clients);
  clients.authenticate = async (...args) => { await sleep(300); return authenticate(...args); };
  await Promise.all(Array.from({ length: 8 }, () => openAndDrop(ctx.machinePort, token, 50)));
  await sleep(800);
  clients.authenticate = authenticate;
  assert.match(await streamAnswers(ctx, (await ctx.client({ agents: [lead.id] })).token), /^200 /, 'slots freed after drops during authentication');
});

test('P2-3: retention removes the old logs of a finished run’s step job, as it does for a plain job, though the runner loads after the job engine', async t => {
  const ctx = await fixture(t, { worker: fakeWorker() });
  const lead = await ctx.register('lead');
  const network = (await ctx.owner('/api/network/networks', 'POST', { name: 'Desk', nodes: [{ id: `n_${pad(1)}`, type: 'agent', agentId: lead.id, position: { x: 0, y: 0 } }], edges: [] })).json.network;
  await ctx.owner(`/api/network/networks/${network.id}/publish`, 'POST', { expectedRevision: 1 });
  const step = (n, type, config) => ({ id: `n_${pad(n)}`, type, position: { x: n * 200, y: 0 }, config });
  const pipeline = (await ctx.owner('/api/network/pipelines', 'POST', { networkId: network.id, networkVersion: 1, name: 'One',
    nodes: [step(1, 'agent', { agentId: lead.id }), step(2, 'output', { name: 'report', include: [`n_${pad(1)}`] })],
    edges: [{ id: `e_${pad(1)}`, from: `n_${pad(1)}`, to: `n_${pad(2)}`, fromPort: 'text', toPort: 'input' }] })).json.pipeline;
  await ctx.owner(`/api/network/pipelines/${pipeline.id}/publish`, 'POST', { expectedRevision: 1 });
  const { runId } = (await ctx.owner(`/api/network/pipelines/${pipeline.id}/runs`, 'POST', { version: 1, confirm: true })).json;
  await until(async () => (await ctx.owner(`/api/network/pipeline-runs/${runId}`)).json.run.status === 'completed', 'run completed', 15000);
  const plainId = (await ctx.owner('/api/network/jobs', 'POST', { agentId: lead.id, input: { text: 'Plain' } })).json.jobId;
  await until(async () => (await ctx.owner(`/api/network/jobs/${plainId}`)).json.job.status === 'completed', 'plain job completed');
  const stepId = (await ctx.owner(`/api/network/jobs?pipelineRunId=${runId}`)).json.jobs[0].id;
  await ctx.app.close();
  // Both jobs finished 40 days ago (retention: 30 days) and each has a stream.jsonl log.
  const logs = {};
  for (const id of [stepId, plainId]) {
    const folder = join(ctx.dataDir, 'network', 'jobs', `job__${id.slice(4)}`), file = join(folder, 'job.json'), job = JSON.parse(await readFile(file, 'utf8'));
    job.updatedAt = Date.now() - 40 * DAY; await writeFile(file, `${JSON.stringify(job, null, 1)}\n`);
    logs[id] = join(folder, 'attempts', `att__${job.attempts[0].id.slice(4)}`, 'stream.jsonl'); await writeFile(logs[id], '{"kind":"status"}\n');
  }
  const again = await fixture(t, { dataDir: ctx.dataDir, worker: fakeWorker() });
  await until(async () => (await again.owner(`/api/network/jobs/${plainId}`)).json.job.outputsRemovedAt, 'the plain job swept');
  await until(async () => (await again.owner(`/api/network/jobs/${stepId}`)).json.job.outputsRemovedAt, 'the step job swept once the runner loaded');
  assert.equal(await exists(logs[stepId]), false, 'the finished run no longer needs its step job’s log');
  assert.equal(await exists(logs[plainId]), false);
  assert.equal((await again.owner(`/api/network/pipeline-runs/${runId}`)).json.run.status, 'completed');
});

test('P2-9: a machine client’s open stream ends at its expiry and delivers nothing after it', async t => {
  let skew = 0;
  const ctx = await fixture(t, { worker: fakeWorker({ mode: 'manual' }), machineOptions: { now: () => Date.now() + skew } });
  const lead = await ctx.register('lead');
  const soon = await ctx.client({ agents: [lead.id] }, { expiresInDays: 1 }), later = await ctx.client({ agents: [lead.id] }, { expiresInDays: 2 });
  await ctx.on();
  const submitted = await ctx.machine(later.token, '/jobs', { method: 'POST', body: { agentId: lead.id, input: { text: 'Hello' } } });
  assert.equal(submitted.status, 202, submitted.text);

  // A stream opened 400 ms before its client expires closes at the expiry (pings would keep it open otherwise).
  skew = DAY - 400;
  const first = openStream(ctx.machinePort, soon.token);
  t.after(() => first.close());
  await until(() => first.lines.some(line => line.live), 'stream live');
  await until(() => first.ended, 'the stream ends at the expiry', 3000);

  // The clock passes a client's expiry while its stream is open: the next event closes the stream instead of reaching it.
  const second = openStream(ctx.machinePort, later.token);
  t.after(() => second.close());
  await until(() => second.lines.some(line => line.live), 'second stream live');
  skew = 3 * DAY;
  assert.equal((await ctx.machine(later.token, '/agents')).status, 401, 'the token stopped working');
  assert.equal((await ctx.owner(`/api/network/jobs/${submitted.json.jobId}/cancel`, 'POST', {})).status, 200);
  await until(() => second.ended, 'the expired client’s stream ends', 3000);
  assert.deepEqual(second.lines.filter(line => line.jobId), [], 'no event reached the expired client');
});
