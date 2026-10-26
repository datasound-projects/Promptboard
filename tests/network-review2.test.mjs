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

test('P2-5: a replay from 0 parses each journal segment about once, not once per page; appends and backward pages still read right', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-review2-journal-')), dir = join(dataDir, 'network', 'events');
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await mkdir(dir, { recursive: true });
  const SEGMENTS = 2, PER = 3000; // Written in the journal's own format: a header, then one event per line.
  let seq = 1;
  for (let s = 0; s < SEGMENTS; s++) {
    const first = seq, lines = [JSON.stringify({ schema: 'promptboard.network-events', version: 1, first })];
    for (let i = 0; i < PER; i++, seq++) lines.push(JSON.stringify({ seq, id: `evt_${seq.toString(16).padStart(20, '0')}`, at: 1_790_000_000_000 + seq, type: 'job.status', jobId: 'job_0123456789abcdef0123', status: 'running', message: 'x'.repeat(120) }));
    await writeFile(join(dir, `${String(first).padStart(16, '0')}.jsonl`), `${lines.join('\n')}\n`);
  }
  const events = new NetworkEvents({ dataDir }), total = SEGMENTS * PER;
  const parse = JSON.parse; let parses = 0, pages = 0, sent = 0, last = 0;
  JSON.parse = function (...args) { parses++; return parse.apply(this, args); };
  try { for (let more = true; more; pages++) { const page = await events.read({ after: last, limit: 200 }); sent += page.events.length; last = page.next; more = page.more; } }
  finally { JSON.parse = parse; }
  assert.equal(sent, total);
  assert.ok(parses < 3 * total, `${parses} lines parsed for a replay of ${total} events in ${pages} pages`);
  // The newest segment grows: the next read sees the new event. Reading backward twice answers the same pages in order.
  assert.ok(await events.append({ type: 'job.status', jobId: 'job_0123456789abcdef0123', status: 'completed' }));
  assert.deepEqual((await events.read({ after: total, limit: 10 })).events.map(event => event.seq), [total + 1]);
  for (let i = 0; i < 2; i++) assert.deepEqual((await events.read({ limit: 3 })).events.map(event => event.seq), [total - 1, total, total + 1]);
  assert.deepEqual((await events.read({ before: PER + 2, limit: 3 })).events.map(event => event.seq), [PER - 1, PER, PER + 1], 'across the segment boundary');
  assert.deepEqual((await events.read({ after: total - 2, limit: 10 })).events.map(event => event.seq), [total - 1, total, total + 1], 'forward after backward reads');
});

test('P2-7: a join(any) report says a step was still running when it was saved, never that it did not run', async t => {
  const worker = fakeWorker({ mode: 'manual' });
  const ctx = await fixture(t, { worker });
  const lead = await ctx.register('lead');
  const network = (await ctx.owner('/api/network/networks', 'POST', { name: 'Desk', nodes: [{ id: `n_${pad(1)}`, type: 'agent', agentId: lead.id, position: { x: 0, y: 0 } }], edges: [] })).json.network;
  await ctx.owner(`/api/network/networks/${network.id}/publish`, 'POST', { expectedRevision: 1 });
  const step = (n, type, label, config) => ({ id: `n_${pad(n)}`, type, label, position: { x: n * 200, y: 0 }, config });
  const edge = (n, from, to, fromPort) => ({ id: `e_${pad(n)}`, from: `n_${pad(from)}`, to: `n_${pad(to)}`, fromPort, toPort: 'input' });
  const pipeline = (await ctx.owner('/api/network/pipelines', 'POST', { networkId: network.id, networkVersion: 1, name: 'First answer wins',
    nodes: [step(1, 'agent', 'Fast', { agentId: lead.id }), step(2, 'agent', 'Slow', { agentId: lead.id }), step(3, 'join', 'First', { require: 'any' }),
      step(4, 'output', 'Report', { name: 'report', include: [`n_${pad(1)}`, `n_${pad(2)}`] })],
    edges: [edge(1, 1, 3, 'text'), edge(2, 2, 3, 'text'), edge(3, 3, 4, 'done')] })).json.pipeline;
  assert.equal((await ctx.owner(`/api/network/pipelines/${pipeline.id}/publish`, 'POST', { expectedRevision: 1 })).status, 200);
  const a = worker.next(), b = worker.next();
  const { runId } = (await ctx.owner(`/api/network/pipelines/${pipeline.id}/runs`, 'POST', { version: 1, confirm: true })).json;
  const entries = await Promise.all([a, b]), byNode = id => entries.find(entry => entry.job.nodeId === `n_${pad(id)}`);
  const finish = async (entry, text) => { await entry.own.launching(); await entry.own.spawned({ pid: 4242 }); await entry.own.finish({ status: 'completed', exitCode: 0, result: { text } }); entry.end(); };
  await finish(byNode(1), 'Fast answer.');
  await until(async () => (await ctx.owner(`/api/network/pipeline-runs/${runId}`)).json.run.nodes[`n_${pad(4)}`].status === 'completed', 'report written', 10000);
  await finish(byNode(2), 'Slow answer.');
  await until(async () => (await ctx.owner(`/api/network/pipeline-runs/${runId}`)).json.run.status === 'completed', 'run completed', 10000);
  const report = (await ctx.owner(`/api/network/pipeline-runs/${runId}/nodes/n_${pad(4)}/report`)).json.text;
  assert.equal(report, '# First answer wins\n\n## Fast\n\nFast answer.\n\n## Slow\n\n_This step had not finished when this report was saved._\n');
});

test('P2-8: a finished job read from its backup is recovered with a job.recovered event and a revision it never had', async t => {
  const worker = fakeWorker({ mode: 'manual', endOnCancel: false });
  const ctx = await fixture(t, { worker });
  const lead = await ctx.register('lead');
  const started = worker.next();
  const jobId = (await ctx.owner('/api/network/jobs', 'POST', { agentId: lead.id, input: { text: 'Hello' } })).json.jobId;
  const entry = await started;
  await entry.own.launching(); await entry.own.spawned({ pid: 4242 });
  await ctx.owner(`/api/network/jobs/${jobId}/cancel`, 'POST', {}); // The engine ends it; the worker still delivers its result.
  await entry.own.finish({ status: 'completed', exitCode: 0, result: { text: 'The answer that came late.' } });
  entry.end();
  const folder = join(ctx.dataDir, 'network', 'jobs', `job__${jobId.slice(4)}`), saved = JSON.parse(await readFile(join(folder, 'job.json'), 'utf8'));
  assert.ok(saved.attempts.at(-1).lateResult, 'the newest save holds the late result; the backup does not');
  await ctx.app.close();
  await writeFile(join(folder, 'job.json'), '{ damaged');

  const again = await fixture(t, { dataDir: ctx.dataDir, worker: fakeWorker() });
  const { job } = (await again.owner(`/api/network/jobs/${jobId}`)).json;
  assert.equal(job.status, 'cancelled', 'a finished job stays finished');
  assert.ok(job.revision > saved.revision, `revision ${job.revision} is newer than the lost ${saved.revision}, so no stale copy matches it`);
  const events = await until(async () => { const page = (await again.owner(`/api/network/events?jobId=${jobId}&limit=200`)).json; return page.events.some(event => event.type === 'job.recovered') && page.events; }, 'job.recovered');
  const recovered = events.filter(event => event.type === 'job.recovered');
  assert.equal(recovered.length, 1);
  assert.deepEqual([recovered[0].agentId, recovered[0].status, recovered[0].errorCode, recovered[0].by], [lead.id, 'cancelled', 'RESTORED_FROM_BACKUP', 'app']);
  assert.match(recovered[0].message, /read from its backup copy/);
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

test('P2-11: a job cancelled while the local worker claims it leaves no attempt entry behind', { skip: process.platform === 'win32' }, async t => {
  const bin = await mkdtemp(join(tmpdir(), 'pb-review2-bin-')), path = process.env.PATH;
  t.after(() => { process.env.PATH = path; return rm(bin, { recursive: true, force: true }); });
  await writeFile(join(bin, 'claude'), '#!/bin/sh\nexit 0\n'); await chmod(join(bin, 'claude'), 0o700);
  process.env.PATH = bin; // A fake Claude Code: the claim only looks it up.
  let release; const gate = new Promise(resolve => { release = resolve; });
  const worker = new LocalJobWorker({ dataDir: bin, registry: { base: { list: async () => { await gate; return { revision: 1, resources: [], approvedRoots: [] }; } } } });
  const controller = new AbortController(), own = { attemptId: 'att_0123456789abcdef0123', signal: controller.signal };
  const job = { request: { agent: { provider: 'claude', manifest: { resources: [], profiles: [] } }, tools: 'none', permissions: { filesystem: 'read_only' } } };
  const claiming = worker.claim(job, own);
  controller.abort(); await worker.cancel(own); // The engine's stop while the claim reads Base: the worker holds nothing yet.
  release(); await claiming;
  assert.deepEqual(worker.getStatus(own), { process: 'none' }, 'the ended attempt is forgotten');
});
