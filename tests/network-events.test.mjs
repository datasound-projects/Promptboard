// Network events and Activity (src/network/events.mjs, src/network/activity.mjs, the job engine's events option, the
// routes in src/network/http.mjs): one job.status event per saved transition, ordered sequence numbers and unique IDs,
// cursor paging and filters, the NDJSON stream (replay, live, ping, reconnect exactly once across a restart), journal
// recovery (damaged lines, torn tail, rollover and retention, newer version), redaction, stream ceilings, teardown,
// backpressure and paired-device revocation, provider coverage and read-only Kanban runs. Temporary data folders; the
// only worker is the deterministic fake (tests/helpers/network-worker.mjs); synthetic appends stand in for the worker's
// job.activity and the pipeline runner's pipeline.* events. No CLI, no network beyond the local test servers.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Base } from '../src/base.mjs';
import { Store } from '../src/store.mjs';
import { NetworkRegistry } from '../src/network/registry.mjs';
import { NetworkJobs } from '../src/network/jobs.mjs';
import { NetworkEvents, normalizeEvent } from '../src/network/events.mjs';
import { coverageOf, kanbanRuns } from '../src/network/activity.mjs';
import { startServer } from '../src/server.mjs';
import { startTestServer } from './helpers/test-server.mjs';
import { fakeWorker } from './helpers/network-worker.mjs';

const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await tick()) { const value = await check(); if (value) return value; }
  assert.fail(`timed out: ${label}`);
}
const freePort = () => new Promise(resolve => { const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
const catalogReader = async provider => ({ provider, source: 'test fixture', models: [] });
const JOB = 'job_' + 'a'.repeat(20), JOB2 = 'job_' + 'b'.repeat(20), AGENT = 'agt_' + 'a'.repeat(20), AGENT2 = 'agt_' + 'b'.repeat(20);
const NET = 'net_' + 'a'.repeat(20), RUN = 'run_' + 'a'.repeat(20);
const all = async events => { const items = []; for (let after = 0, more = true; more;) { const page = await events.read({ after, limit: 200 }); items.push(...page.events); after = page.next; more = page.more; } return items; };
async function files(dir) { try { return (await readdir(dir)).sort(); } catch { return []; } }
const text = async dir => (await Promise.all((await files(dir)).map(name => readFile(join(dir, name), 'utf8')))).join('');

/** Base agents (Claude, Codex), their registrations and a journal factory on one temporary data folder. */
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-network-events-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const base = new Base({ store: new Store(dataDir) });
  await base.create({ id: 'lead', kind: 'profile', name: 'Lead', configuration: { agent: { provider: 'claude', model: 'sonnet' } } });
  await base.create({ id: 'scout', kind: 'profile', name: 'Scout', configuration: { agent: { provider: 'codex' } } });
  const registry = new NetworkRegistry({ dataDir, base, projects: async () => ['p1'] });
  const register = async id => (await registry.registerAgent({ baseResourceId: id, expectedRevision: (await registry.listAgents()).revision })).agent;
  const lead = await register('lead'), scout = await register('scout');
  return { dataDir, registry, lead, scout, dir: join(dataDir, 'network', 'events'), journal: (options = {}) => new NetworkEvents({ dataDir, ...options }) };
}
const submit = (jobs, agentId, extra = {}) => jobs.submit({ agentId, input: { text: 'Summarise the release notes.' }, ...extra });
/** A manual attempt driven to running. */
async function running(worker, start) { const next = worker.next(); const accepted = await start(); const entry = await next; await entry.own.launching(); await entry.own.spawned({ pid: 77 }); return { accepted, entry }; }

/** An NDJSON stream over plain HTTP (any Host and Cookie header); `lines` fills as they arrive. */
function openStream(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, res => {
      const stream = { status: res.statusCode, lines: [], ended: false };
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { buffer += chunk; for (let end; (end = buffer.indexOf('\n')) >= 0;) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); try { stream.lines.push(JSON.parse(line)); } catch { stream.lines.push({ unparsed: line }); } } });
      // A refusal is one JSON answer without a line break.
      stream.closed = new Promise(done => res.on('close', () => { if (buffer.trim()) { try { stream.lines.push(JSON.parse(buffer)); } catch {} } stream.ended = true; done(); }));
      stream.close = () => { req.destroy(); return stream.closed; };
      stream.events = () => stream.lines.filter(line => Number.isSafeInteger(line.seq));
      resolve(stream);
    });
    req.on('error', reject); req.end();
  });
}
async function owner(app) {
  const port = Number(new URL(app.url).port), token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = async (path, method = 'GET', body) => { const response = await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, json: await response.json() }; };
  return { port, token, call };
}
async function registerOver(call, baseResourceId) {
  const { json: list } = await call('/api/network/agents');
  const { status, json } = await call('/api/network/agents', 'POST', { baseResourceId, expectedRevision: list.revision });
  assert.equal(status, 200, JSON.stringify(json));
  return json.agent;
}

test('every saved job transition appends one job.status event, in order, with unique IDs; a restart continues the sequence', async t => {
  const ctx = await fixture(t), events = ctx.journal(), worker = fakeWorker({ mode: 'manual' });
  const jobs = new NetworkJobs({ dataDir: ctx.dataDir, registry: ctx.registry, worker, events, prepareTimeoutMs: 600_000 });
  await jobs.start();
  // Completed; cancelled while running; rejected before it ran; approved, unknown, retried, then failed before launch.
  const done = await running(worker, () => submit(jobs, ctx.lead.id));
  await done.entry.own.finish({ status: 'completed', exitCode: 0, result: { text: 'Done.' } }); done.entry.end();
  const stopped = await running(worker, () => submit(jobs, ctx.scout.id, { projectId: 'p1' }));
  await jobs.cancel(stopped.accepted.jobId, {});
  const rejected = await submit(jobs, ctx.lead.id, { requireApproval: true });
  await jobs.approve(rejected.jobId, { expectedRevision: 1, decision: 'reject' });
  const retried = await submit(jobs, ctx.scout.id, { requireApproval: true });
  let next = worker.next();
  await jobs.approve(retried.jobId, { expectedRevision: 1, decision: 'approve' });
  let entry = await next;
  await entry.own.launching(); await entry.own.finish({ status: 'unknown', reason: 'No result.' }); entry.end();
  await until(async () => (await jobs.read(retried.jobId)).job.status === 'unknown', 'unknown');
  next = worker.next();
  await jobs.retry(retried.jobId, { expectedRevision: (await jobs.read(retried.jobId)).job.revision, confirm: true, confirmUncertain: true });
  entry = await next; await entry.own.finish({ status: 'failed', errorCode: 'WORKER_REFUSED', reason: 'Refused.' }); entry.end();
  const ids = [done.accepted.jobId, stopped.accepted.jobId, rejected.jobId, retried.jobId];
  const records = await until(async () => {
    const list = await Promise.all(ids.map(async id => (await jobs.read(id)).job));
    return list.every(job => ['completed', 'cancelled', 'failed'].includes(job.status)) && list;
  }, 'all jobs ended');
  const expected = records.reduce((sum, job) => sum + job.history.length, 0);
  const journal = await until(async () => { const items = await all(events); return items.length === expected && items; }, 'every transition journaled');
  // seq 1…N without a gap, strictly increasing; IDs unique and server-made.
  assert.deepEqual(journal.map(event => event.seq), Array.from({ length: expected }, (_, i) => i + 1));
  assert.equal(new Set(journal.map(event => event.id)).size, expected);
  assert.ok(journal.every(event => /^evt_[0-9a-f]{20}$/.test(event.id) && event.type === 'job.status'));
  for (const job of records) {
    const mine = journal.filter(event => event.jobId === job.id);
    assert.deepEqual(mine.map(event => event.status), job.history.map(entry => entry.status), `${job.id}: one event per saved transition`);
    assert.deepEqual(mine.map(event => event.from ?? null), [null, ...job.history.slice(0, -1).map(entry => entry.status)], 'from chains the transitions');
    assert.deepEqual(mine.map(event => event.by), job.history.map(entry => entry.by));
    assert.ok(mine.every(event => event.agentId === job.agentId));
  }
  const [doneJob, stoppedJob] = records;
  const doneEvents = journal.filter(event => event.jobId === doneJob.id);
  assert.equal(doneEvents.at(-1).artifactRef, doneJob.result.textRef, 'the completed event points at the saved result');
  assert.ok(doneEvents.slice(1).every(event => event.attemptId === doneJob.attempts[0].id), 'claimed and later transitions name the attempt');
  assert.equal(journal.find(event => event.jobId === stoppedJob.id && event.status === 'queued').projectId, 'p1');
  assert.equal(journal.find(event => event.jobId === retried.jobId && event.status === 'failed').errorCode, 'WORKER_REFUSED');
  // An event is never authority: a forged "completed" for an open job changes nothing.
  const open = await submit(jobs, ctx.lead.id, { requireApproval: true });
  await events.append({ type: 'job.status', jobId: open.jobId, agentId: ctx.lead.id, status: 'completed', from: 'waiting_for_approval' });
  assert.equal((await jobs.read(open.jobId)).job.status, 'waiting_for_approval');
  // Restart while a job runs: the reconciled "interrupted" is journaled after everything before it.
  const live = await running(worker, () => submit(jobs, ctx.lead.id));
  const before = await until(async () => { const items = await all(events); return items.some(event => event.jobId === live.accepted.jobId && event.status === 'running') && items; }, 'running journaled');
  const restarted = ctx.journal(), again = new NetworkJobs({ dataDir: ctx.dataDir, registry: ctx.registry, events: restarted });
  await again.start();
  const after = await until(async () => { const items = await all(restarted); return items.length === before.length + 1 && items; }, 'interrupted journaled');
  assert.deepEqual(after.slice(0, -1), before, 'nothing earlier changed');
  assert.deepEqual([after.at(-1).seq, after.at(-1).jobId, after.at(-1).from, after.at(-1).status, after.at(-1).errorCode, after.at(-1).by], [before.at(-1).seq + 1, live.accepted.jobId, 'running', 'interrupted', 'APP_RESTARTED', 'app']);
});

test('a failing, hanging or unwritable event sink never holds up or breaks a job transition', async t => {
  const ctx = await fixture(t);
  await mkdir(join(ctx.dataDir, 'network'), { recursive: true });
  await writeFile(ctx.dir, 'not a folder'); // The journal cannot read or write its folder.
  const unwritable = ctx.journal();
  const sinks = [['throws', { append() { throw new Error('boom'); } }], ['rejects', { append: async () => { throw new Error('boom'); } }], ['never answers', { append: () => new Promise(() => {}) }], ['unwritable journal', unwritable]];
  for (const [label, events] of sinks) {
    const jobs = new NetworkJobs({ dataDir: ctx.dataDir, registry: ctx.registry, worker: fakeWorker(), events });
    await jobs.start();
    const { jobId, status } = await submit(jobs, ctx.lead.id);
    assert.equal(status, 'queued', label);
    const job = await until(async () => { const { job: current } = await jobs.read(jobId); return current.status === 'completed' && current; }, `${label}: completed`);
    assert.deepEqual(job.history.map(entry => entry.status), ['queued', 'preparing', 'running', 'completed'], label);
    await jobs.close();
  }
  assert.ok((await unwritable.status()).failures >= 4, 'the journal counts what it could not write');
  assert.equal((await unwritable.status()).unavailable, 'NETWORK_DATA_UNREADABLE');
});

test('pages follow exact cursors forward and backward, filters match agent, job, network and pipeline run; bad queries are refused', async t => {
  const ctx = await fixture(t), events = ctx.journal();
  // Synthetic job.activity (Task 07's worker) and pipeline.* (Task 09's runner) events beside job.status.
  for (let i = 0; i < 30; i++) {
    const kind = ['job.status', 'job.activity', 'pipeline.run', 'pipeline.node'][i % 4];
    assert.ok(await events.append({ type: kind, agentId: i % 2 ? AGENT : AGENT2, jobId: i % 3 ? JOB : JOB2, networkId: i < 10 ? NET : undefined, pipelineRunId: i >= 20 ? RUN : undefined,
      nodeId: kind === 'pipeline.node' ? 'n_aaaaaaaaaaaa/n_bbbbbbbbbbbb' : undefined, status: kind === 'job.activity' ? undefined : 'running', kind: kind === 'job.activity' ? 'tool' : undefined, label: `step ${i}` }));
  }
  const pages = [];
  for (let after = 0, more = true; more;) { const page = await events.read({ after, limit: 7 }); pages.push(page.events.map(event => event.seq)); assert.ok(page.events.length <= 7); after = page.next; more = page.more; }
  assert.deepEqual(pages.flat(), Array.from({ length: 30 }, (_, i) => i + 1), 'forward pages: each event once, in order');
  const backward = [];
  for (let before, more = true; more;) { const page = await events.read({ before, limit: 8 }); backward.unshift(...page.events.map(event => event.seq)); before = page.prev; more = page.prev !== null; assert.equal(page.last, 30); }
  assert.deepEqual(backward, Array.from({ length: 30 }, (_, i) => i + 1), 'backward pages from the newest: each event once');
  const tail = await events.read({ limit: 5 });
  assert.deepEqual([tail.events.map(event => event.seq), tail.prev, tail.next], [[26, 27, 28, 29, 30], 26, 30]);
  const count = async filters => (await events.read({ after: 0, limit: 200, ...filters })).events;
  assert.ok((await count({ agentId: AGENT })).every(event => event.agentId === AGENT));
  assert.equal((await count({ agentId: AGENT })).length, 15);
  assert.equal((await count({ jobId: JOB2 })).length, 10);
  assert.equal((await count({ networkId: NET })).length, 10);
  assert.equal((await count({ pipelineRunId: RUN })).length, 10);
  assert.deepEqual((await count({ agentId: AGENT, jobId: JOB2, pipelineRunId: RUN })).map(event => event.seq), [22, 28], 'filters combine');
  const node = (await count({})).find(event => event.type === 'pipeline.node');
  assert.deepEqual([node.nodeId, node.status, node.message], ['n_aaaaaaaaaaaa/n_bbbbbbbbbbbb', 'running', 'step 3']);
  assert.deepEqual((await count({})).find(event => event.type === 'job.activity').kind, 'tool');
  // A filtered page that finds nothing still moves its cursor, so a narrow filter never re-reads what it saw.
  const none = await events.read({ after: 0, limit: 10, agentId: 'agt_' + 'c'.repeat(20) });
  assert.deepEqual([none.events.length, none.next, none.more], [0, 30, false]);
  assert.deepEqual([(await events.read({ after: 99 })).reset, (await events.read({ after: 99 })).events.length], [true, 0], 'a cursor past the newest asks the reader to reload');
  for (const query of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { after: -1 }, { after: Number.NaN }, { before: 'x' }, { after: 1, before: 5 }, { type: 'job.status' }, { agentId: '../x' }, { jobId: 'job a' }]) {
    await assert.rejects(events.read(query), { code: 'INVALID_INPUT' }, JSON.stringify(query));
  }
  // Only known fields of the right shape are kept; kanban.* is derived, never journaled; types are namespaced words.
  assert.equal(await events.append({ type: 'kanban.run', status: 'running' }), null);
  for (const type of ['job', 'JOB.STATUS', 'job.status.x', '', undefined]) assert.equal(await events.append({ type }), null, String(type));
  const kept = normalizeEvent({ type: 'job.status', at: 5, jobId: '../../etc/passwd', agentId: AGENT, status: 'Running!', errorCode: 'lower', prompt: 'SECRET PROMPT', input: { text: 'x' }, toolInput: '{"cmd":"rm"}', result: 'r', artifactRef: '/etc/passwd' }, 9);
  assert.deepEqual(kept, { at: 5, type: 'job.status', agentId: AGENT });
  assert.deepEqual(normalizeEvent({ type: 'job.activity', label: 'Searching', artifactRef: 'attempts/att__x/result.md' }, 9), { at: 9, type: 'job.activity', artifactRef: 'attempts/att__x/result.md', message: 'Searching' });

  // The same over HTTP, behind the owner checks.
  const app = await startTestServer(t, { port: 0, executor: null });
  const { call, port } = await owner(app);
  for (let i = 0; i < 12; i++) await app.networkEvents.append({ type: 'job.activity', jobId: i % 2 ? JOB : JOB2, agentId: AGENT, label: `step ${i}` });
  const first = await call('/api/network/events?after=0&limit=5'), second = await call(`/api/network/events?after=${first.json.next}&limit=5`);
  assert.deepEqual([first.status, first.json.events.map(event => event.seq), second.json.events.map(event => event.seq), second.json.more], [200, [1, 2, 3, 4, 5], [6, 7, 8, 9, 10], true]);
  assert.deepEqual((await call(`/api/network/events?jobId=${JOB}&limit=200`)).json.events.map(event => event.seq), [2, 4, 6, 8, 10, 12]);
  assert.deepEqual((await call('/api/network/events?limit=3')).json.events.map(event => event.seq), [10, 11, 12]);
  assert.deepEqual((await call('/api/network/events?before=10&limit=3')).json.events.map(event => event.seq), [7, 8, 9]);
  for (const query of ['limit=0', 'limit=500', 'after=-1', 'after=x', 'agentId=..%2Fx', 'after=1&before=4']) assert.equal((await call(`/api/network/events?${query}`)).status, 400, query);
  const anonymous = await fetch(`${app.url}/api/network/events`);
  assert.equal(anonymous.status, 403, 'the owner token is required');
  assert.equal((await openStream(port, '/api/network/events/stream')).status, 403, 'the stream too');
});

test('the stream replays from a cursor, then goes live with pings; reconnecting with the last seq gives every event exactly once across a restart', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-network-stream-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const options = { port: 0, dataDir, executor: null, catalogReader, networkWorker: fakeWorker(), networkEventOptions: { pingMs: 60 } };
  let app = await startServer(options);
  t.after(() => app.close());
  let { call, port, token } = await owner(app);
  await app.board.base.create({ id: 'lead', kind: 'profile', name: 'Lead', configuration: { agent: { provider: 'claude' } } });
  const lead = await registerOver(call, 'lead');
  const job = async () => {
    const { status, json } = await call('/api/network/jobs', 'POST', { agentId: lead.id, input: { text: 'Find the facts.' } });
    assert.equal(status, 202);
    await until(async () => (await call(`/api/network/jobs/${json.jobId}`)).json.job.status === 'completed', 'job completed');
    return json.jobId;
  };
  const seen = [];
  const first = await openStream(port, '/api/network/events/stream?after=0', { 'X-STE-Token': token });
  assert.equal(first.status, 200);
  await until(() => first.lines.some(line => line.live), 'live');
  assert.deepEqual(first.lines.find(line => line.live), { live: true, last: 0 });
  const one = await job();
  await until(() => first.events().length === 4, 'four live events');
  assert.deepEqual(first.events().map(event => [event.seq, event.jobId, event.status]), [[1, one, 'queued'], [2, one, 'preparing'], [3, one, 'running'], [4, one, 'completed']]);
  await until(() => first.lines.some(line => line.ping), 'a ping');
  seen.push(...first.events());
  await first.close();
  const two = await job(); // While no stream is open.
  const second = await openStream(port, `/api/network/events/stream?after=${seen.at(-1).seq}`, { 'X-STE-Token': token });
  await until(() => second.lines.some(line => line.live), 'live again');
  const replayed = second.lines.slice(0, second.lines.findIndex(line => line.live));
  assert.deepEqual(replayed.map(event => [event.seq, event.jobId]), [[5, two], [6, two], [7, two], [8, two]], 'only what was missed, before the live line');
  seen.push(...second.events());
  await second.close();
  // A restart: a new server (and token) on the same data folder; the sequence carries on.
  await app.close();
  app = await startServer(options);
  ({ call, port, token } = await owner(app));
  const three = await job();
  const third = await openStream(port, `/api/network/events/stream?after=${seen.at(-1).seq}`, { 'X-STE-Token': token });
  await until(() => third.lines.some(line => line.live), 'live after the restart');
  assert.deepEqual(third.events().map(event => [event.seq, event.jobId]), [[9, three], [10, three], [11, three], [12, three]]);
  seen.push(...third.events());
  const journal = (await call('/api/network/events?after=0&limit=200')).json.events;
  assert.deepEqual(seen.map(event => event.seq), Array.from({ length: 12 }, (_, i) => i + 1), 'each event exactly once');
  assert.deepEqual(seen, journal, 'the stream sent exactly what the journal holds');
  // Without a cursor: no replay, only what happens next.
  const fresh = await openStream(port, '/api/network/events/stream', { 'X-STE-Token': token });
  await until(() => fresh.lines.some(line => line.live), 'live without a cursor');
  assert.deepEqual([fresh.events().length, fresh.lines.find(line => line.live).last], [0, 12]);
  await app.networkEvents.append({ type: 'job.activity', jobId: three, agentId: lead.id, kind: 'tool', label: 'WebSearch' });
  await until(() => fresh.events().length === 1, 'the next event');
  assert.deepEqual([fresh.events()[0].seq, fresh.events()[0].message], [13, 'WebSearch']);
  // A cursor past the newest (the journal was removed) asks the reader to reload.
  const ahead = await openStream(port, '/api/network/events/stream?after=500', { 'X-STE-Token': token });
  await until(() => ahead.lines.some(line => line.live), 'live after reset');
  assert.deepEqual(ahead.lines.slice(0, 2), [{ reset: true, last: 13 }, { live: true, last: 13 }]);
  assert.equal((await openStream(port, '/api/network/events/stream?after=x', { 'X-STE-Token': token })).status, 400);
  await Promise.all([fresh.close(), ahead.close()]);
});

test('journal recovery: damaged and duplicate lines are skipped and counted, a torn tail is closed, seq continues; rollover keeps the newest segments; a newer segment fails closed', async t => {
  const ctx = await fixture(t);
  await mkdir(ctx.dir, { recursive: true });
  const header = first => JSON.stringify({ schema: 'promptboard.network-events', version: 1, first });
  const line = (seq, extra = {}) => JSON.stringify({ seq, id: `evt_${String(seq).padStart(20, '0')}`, at: 1000 + seq, type: 'job.status', jobId: JOB, status: 'running', ...extra });
  const one = [header(1), line(1), line(2), 'not json at all', line(2, { status: 'completed' }), line(3), ''].join('\n');
  const two = `${[header(4), line(4), '{"seq":5,"id":"evt_x"', line(5), line(6)].join('\n')}\n{"seq":7,"id":"evt_0000`; // Torn: no line break.
  await writeFile(join(ctx.dir, '0000000000000001.jsonl'), one);
  await writeFile(join(ctx.dir, '0000000000000004.jsonl'), two);
  const events = ctx.journal();
  const page = await events.read({ after: 0 });
  assert.deepEqual(page.events.map(event => [event.seq, event.status]), [[1, 'running'], [2, 'running'], [3, 'running'], [4, 'running'], [5, 'running'], [6, 'running']], 'the duplicate seq 2 is skipped');
  assert.equal(page.skipped, 4, 'not json, the duplicate, the corrupt middle line and the torn tail');
  assert.equal((await events.append({ type: 'job.status', jobId: JOB, status: 'completed' })).seq, 7, 'max + 1');
  assert.equal(await readFile(join(ctx.dir, '0000000000000001.jsonl'), 'utf8'), one, 'never repaired in place');
  const after = await readFile(join(ctx.dir, '0000000000000004.jsonl'), 'utf8');
  assert.ok(after.startsWith(`${two}\n{"seq":7,`), 'append only: the torn line is closed, the new event starts on its own line');
  assert.deepEqual((await events.read({ after: 0 })).events.map(event => event.seq), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal((await ctx.journal().append({ type: 'job.status', status: 'queued' })).seq, 8, 'a restart keeps the sequence');
  // A segment that only has its header (a crash right after it was made) still fixes where the sequence continues.
  await writeFile(join(ctx.dir, '0000000000000100.jsonl'), `${header(100)}\n`);
  assert.equal((await ctx.journal().append({ type: 'job.status', status: 'queued' })).seq, 100);

  // Rollover and retention: small segments, the newest three kept, each named by its first seq; cursors keep working.
  const small = await fixture(t), rolling = small.journal({ segmentBytes: 1024, maxSegments: 3 });
  for (let i = 1; i <= 60; i++) assert.equal((await rolling.append({ type: 'job.activity', jobId: JOB, label: `step ${i} ${'x'.repeat(80)}` })).seq, i);
  const names = await files(small.dir);
  assert.equal(names.length, 3);
  for (const name of names) {
    const lines = (await readFile(join(small.dir, name), 'utf8')).trim().split('\n');
    assert.deepEqual([JSON.parse(lines[0]).first, JSON.parse(lines[1]).seq], [Number(name.slice(0, 16)), Number(name.slice(0, 16))], name);
    assert.ok(Buffer.byteLength(lines.slice(0, -1).join('\n')) <= 1024, `${name} rolled over at its size`);
  }
  const oldest = Number(names[0].slice(0, 16)), kept = await all(rolling), status = await rolling.status();
  assert.deepEqual([kept[0].seq, kept.at(-1).seq, kept.length, status.oldest, status.last], [oldest, 60, 61 - oldest, oldest, 60]);
  const old = await rolling.read({ after: 2, limit: 5 });
  assert.deepEqual([old.gap, old.events[0].seq], [true, oldest], 'a cursor older than the oldest kept event reads from there and says so');
  assert.equal((await rolling.read({ after: oldest, limit: 1 })).gap, false);
  assert.equal((await small.journal({ segmentBytes: 1024, maxSegments: 3 }).append({ type: 'job.status', status: 'queued' })).seq, 61);

  // A segment from a newer version: nothing is read or written, nothing is changed.
  const newer = await fixture(t);
  await mkdir(newer.dir, { recursive: true });
  const future = `${JSON.stringify({ schema: 'promptboard.network-events', version: 2, first: 1 })}\n${line(1)}\n`;
  await writeFile(join(newer.dir, '0000000000000001.jsonl'), future);
  const refused = newer.journal();
  await assert.rejects(refused.read({ after: 0 }), { code: 'NETWORK_VERSION_UNSUPPORTED', status: 409 });
  assert.equal(await refused.append({ type: 'job.status', status: 'queued' }), null);
  await assert.rejects(refused.stream({ res: new EventEmitter(), client: 'local' }), { code: 'NETWORK_VERSION_UNSUPPORTED' });
  assert.deepEqual([(await refused.status()).unavailable, await files(newer.dir), await readFile(join(newer.dir, '0000000000000001.jsonl'), 'utf8')], ['NETWORK_VERSION_UNSUPPORTED', ['0000000000000001.jsonl'], future]);
});

test('events never carry prompts, tool inputs, folders or secrets: messages are one redacted line of at most 500 characters', async t => {
  const ctx = await fixture(t), events = ctx.journal(), worker = fakeWorker({ mode: 'manual' });
  const jobs = new NetworkJobs({ dataDir: ctx.dataDir, registry: ctx.registry, worker, events, prepareTimeoutMs: 600_000 });
  await jobs.start();
  const secrets = ['abcd1234efgh5678', 'ghp_0123456789abcdefABCDEF0123456789abcd', 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'];
  const { accepted, entry } = await running(worker, () => jobs.submit({ agentId: ctx.lead.id, input: { text: `SECRET-PROMPT-TEXT-123 with api_key=${secrets[0]}` }, instructions: 'INSTRUCTION-TEXT-456' }));
  // Task 07's worker activity, as a synthetic append: a label with a tool input, a home folder, a token and line breaks.
  await events.append({ type: 'job.activity', jobId: accepted.jobId, agentId: ctx.lead.id, kind: 'tool', label: `Read /Users/alice/private/plan.md\n--api-key ${secrets[2]}\n${'y'.repeat(700)}`, toolInput: { path: '/Users/alice/private/plan.md' } });
  await entry.own.finish({ status: 'failed', errorCode: 'RATE_LIMITED', reason: `Could not read /Users/alice/private/notes.txt: token=${secrets[1]}\nsecond line` }); entry.end();
  const journal = await until(async () => { const items = await all(events); return items.some(event => event.status === 'failed') && items; }, 'failed journaled');
  const activity = journal.find(event => event.type === 'job.activity'), failed = journal.find(event => event.status === 'failed');
  assert.ok(activity.message.length <= 500 && !/[\n\r]/.test(activity.message));
  assert.match(activity.message, /^Read …\/plan\.md --api-key \[redacted\] y+/);
  assert.equal(activity.toolInput, undefined);
  assert.match(failed.message, /^Could not read …\/notes\.txt: token=\[redacted\] second line$/);
  const disk = await text(ctx.dir), answer = JSON.stringify(await events.read({ after: 0 }));
  for (const value of [...secrets, 'SECRET-PROMPT-TEXT-123', 'INSTRUCTION-TEXT-456', '/Users/alice', 'private/plan']) {
    assert.ok(!disk.includes(value), `journal files hold no ${value}`);
    assert.ok(!answer.includes(value), `answers hold no ${value}`);
  }
  assert.ok(disk.trim().split('\n').every(item => Buffer.byteLength(item) <= 4096), 'every line within 4 KiB');
});

test('streams: four per client and 32 in all, torn down on close, a slow reader is dropped, a revoked paired device is cut off at once', async t => {
  const app = await startTestServer(t, { port: 0, executor: null });
  const { call, port, token } = await owner(app);
  const local = [];
  for (let i = 0; i < 4; i++) { local.push(await openStream(port, '/api/network/events/stream', { 'X-STE-Token': token })); await until(() => local[i].lines.some(line => line.live), `local ${i}`); }
  const fifth = await openStream(port, '/api/network/events/stream', { 'X-STE-Token': token });
  await fifth.closed;
  assert.deepEqual([fifth.status, fifth.lines[0].code], [429, 'STREAM_LIMIT']);
  assert.deepEqual(app.networkEvents.streams(), { local: 4 });
  await local.shift().close();
  await until(() => app.networkEvents.streams().local === 3, 'the closed stream is torn down');
  local.push(await openStream(port, '/api/network/events/stream', { 'X-STE-Token': token }));
  await until(() => local.at(-1).lines.some(line => line.live), 'a freed slot is used again');
  // A paired device is its own client: it may open its own streams beside the computer's four.
  const remotePort = await freePort();
  await call('/api/remote/settings', 'POST', { method: 'twingate', port: remotePort, bind: '127.0.0.1' });
  const { pairing } = (await call('/api/remote/pairing', 'POST', {})).json;
  const paired = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ code: pairing.code, name: 'Phone' });
    const req = http.request({ host: '127.0.0.1', port: remotePort, path: '/api/remote/pair', method: 'POST', headers: { Host: `127.0.0.1:${remotePort}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => { res.resume(); res.on('end', () => resolve(res.headers['set-cookie'][0].split(';')[0])); });
    req.on('error', reject); req.end(body);
  });
  const remoteToken = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: remotePort, path: '/api/session', headers: { Host: `127.0.0.1:${remotePort}`, Cookie: paired } }, res => { let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve(JSON.parse(body).token)); });
    req.on('error', reject); req.end();
  });
  const phone = await openStream(remotePort, '/api/network/events/stream?after=0', { Cookie: paired, 'X-STE-Token': remoteToken });
  assert.equal(phone.status, 200);
  await until(() => phone.lines.some(line => line.live), 'the phone is live');
  const [session] = Object.keys(app.networkEvents.streams()).filter(key => key !== 'local');
  assert.deepEqual(app.networkEvents.streams(), { local: 4, [session]: 1 });
  await app.networkEvents.append({ type: 'job.status', jobId: JOB, status: 'queued' });
  await until(() => phone.events().length === 1 && local.every(stream => stream.events().length === 1), 'everyone hears the event');
  // Revoked on the computer: the phone's stream ends at once and it gets nothing more.
  assert.equal((await call('/api/remote/sessions/all', 'DELETE')).status, 200);
  assert.equal(await Promise.race([phone.closed.then(() => 'closed'), tick(2000).then(() => 'still open')]), 'closed');
  await until(() => !(session in app.networkEvents.streams()), 'the revoked stream is torn down');
  await app.networkEvents.append({ type: 'job.status', jobId: JOB, status: 'preparing' });
  await until(() => local.every(stream => stream.events().length === 2), 'the computer still hears');
  assert.equal(phone.events().length, 1);
  const again = await openStream(remotePort, '/api/network/events/stream', { Cookie: paired, 'X-STE-Token': remoteToken });
  assert.equal(again.status, 401);
  await Promise.all(local.map(stream => stream.close()));
  await until(() => Object.keys(app.networkEvents.streams()).length === 0, 'every stream torn down');

  // A reader that leaves more than 1 MiB unread is dropped (it reconnects with its last seq); the ceiling of 32 in all.
  const ctx = await fixture(t), events = ctx.journal();
  const slow = Object.assign(new EventEmitter(), { writableLength: 0, writableEnded: false, destroyed: false, writeHead() {}, write() { this.writableLength += 400_000; return false; }, destroy() { this.destroyed = true; this.emit('close'); } });
  await events.stream({ res: slow, client: 'slow' });
  for (let i = 0; i < 3; i++) await events.append({ type: 'job.status', status: 'queued' });
  assert.deepEqual([slow.destroyed, events.streams()], [true, {}]);
  const quiet = () => Object.assign(new EventEmitter(), { writableLength: 0, writableEnded: false, destroyed: false, writeHead() {}, write() { return true; }, destroy() { this.destroyed = true; this.emit('close'); } });
  const open = [];
  for (let i = 0; i < 32; i++) { const res = quiet(); open.push(res); await events.stream({ res, client: `device-${i % 8}` }); }
  await assert.rejects(events.stream({ res: quiet(), client: 'device-new' }), { code: 'STREAM_LIMIT', status: 429 });
  open[0].destroy();
  await events.stream({ res: quiet(), client: 'device-new' });
});

test('Activity: each agent’s status with its CLI coverage, open jobs in order, and read-only Kanban runs of registered agents', async t => {
  const worker = fakeWorker({ mode: 'manual' });
  const app = await startTestServer(t, { port: 0, executor: null, networkWorker: worker });
  const { call } = await owner(app);
  const base = app.board.base;
  await base.create({ id: 'lead', kind: 'profile', name: 'Lead', configuration: { agent: { provider: 'claude' } } });
  await base.create({ id: 'scout', kind: 'profile', name: 'Scout', configuration: { agent: { provider: 'codex' } } });
  await base.create({ id: 'gem', kind: 'profile', name: 'Gem', configuration: { agent: { provider: 'gemini' } } });
  await base.create({ id: 'writer', kind: 'profile', name: 'Writer', configuration: { agent: { provider: 'claude' } } });
  await base.create({ id: 'plain', kind: 'profile', name: 'Plain', configuration: { agent: {} } });
  await base.create({ id: 'other', kind: 'profile', name: 'Other', configuration: { agent: { provider: 'claude' } } });
  const agents = {};
  for (const id of ['lead', 'scout', 'gem', 'writer', 'plain']) agents[id] = await registerOver(call, id);
  await call('/api/network/settings', 'PATCH', { expectedRevision: 0, maxConcurrentJobs: 2 });
  const start = async (agent, extra = {}) => { const next = worker.next(); const { json } = await call('/api/network/jobs', 'POST', { agentId: agent.id, input: { text: 'PRIVATE INPUT TEXT' }, ...extra }); const entry = await next; return { jobId: json.jobId, entry }; };
  // Writer: waiting for input. Scout: unknown. Lead: running, and a second lead job queued behind the full pool.
  const waiting = await start(agents.writer); await waiting.entry.own.launching(); await waiting.entry.own.spawned({ pid: 5 }); await waiting.entry.own.finish({ status: 'waiting_for_input', result: { text: 'Which year?' } }); waiting.entry.end();
  const lost = await start(agents.scout); await lost.entry.own.launching(); await lost.entry.own.finish({ status: 'unknown' }); lost.entry.end();
  const busy = await start(agents.lead); await busy.entry.own.launching(); await busy.entry.own.spawned({ pid: 6 });
  const blocker = await start(agents.lead); // Holds the second slot.
  const queued = (await call('/api/network/jobs', 'POST', { agentId: agents.lead.id, input: { text: 'PRIVATE INPUT TEXT' } })).json.jobId;
  const approval = (await call('/api/network/jobs', 'POST', { agentId: agents.gem.id, input: { text: 'PRIVATE INPUT TEXT' }, requireApproval: true })).json.jobId;
  // Kanban: a running card of Lead with reported usage, a finished one of Scout, and runs of unregistered agents (left out).
  const project = await app.board.createProject({ name: 'Site' });
  const card = await app.board.createTask({ projectId: project.id, title: 'Fix the login', prompt: 'Fix it.' });
  const done = await app.board.createTask({ projectId: project.id, title: 'Write the notes', prompt: 'Write.' });
  const now = Date.now(), manifest = id => ({ version: 1, provider: 'claude', profiles: [{ resourceId: id, revision: 1, origin: 'project' }] });
  await app.board.store.update(draft => {
    draft.runs.push({ id: 'run-k1', taskId: card.id, projectId: project.id, stage: 'executing', status: 'running', createdAt: now - 5000, updatedAt: now - 1000, config: { provider: 'claude', model: 'sonnet' }, baseManifest: manifest('lead'), usage: { inputTokens: 1200, outputTokens: 300, costUSD: 0.0123 } });
    draft.runs.push({ id: 'run-k2', taskId: done.id, projectId: project.id, stage: 'planning', status: 'succeeded', createdAt: now - 9000, updatedAt: now - 8000, config: { provider: 'codex' }, baseManifest: manifest('scout') });
    draft.runs.push({ id: 'run-k3', taskId: card.id, projectId: project.id, stage: 'executing', status: 'running', createdAt: now, updatedAt: now, config: { provider: 'claude' }, baseManifest: manifest('other') });
    draft.runs.push({ id: 'run-k4', taskId: card.id, projectId: project.id, stage: 'executing', status: 'failed', createdAt: now, updatedAt: now, config: { provider: 'claude' } });
  });
  const stateFile = join(app.board.dataDir, 'state.json'), before = await readFile(stateFile, 'utf8');
  const { status, json } = await call('/api/network/activity');
  assert.equal(status, 200);
  const byName = Object.fromEntries(json.agents.map(agent => [agent.name, agent]));
  assert.deepEqual(Object.fromEntries(Object.entries(byName).map(([name, agent]) => [name, agent.status])), { Lead: 'running', Scout: 'unknown', Gem: 'waiting_for_approval', Writer: 'waiting_for_input', Plain: 'none' });
  assert.deepEqual(byName.Lead.counts, { waiting_for_input: 0, unknown: 0, waiting_for_approval: 0, running: 2, queued: 1 });
  assert.deepEqual(Object.fromEntries(Object.entries(byName).map(([name, agent]) => [name, agent.coverage.level])), { Lead: 'tools', Scout: 'partial-tools', Gem: 'final-only', Writer: 'tools', Plain: 'unknown' });
  assert.match(byName.Scout.coverage.note, /only its web searches and MCP calls/);
  assert.match(byName.Gem.coverage.note, /reports nothing while a job runs/);
  assert.deepEqual(json.queue.map(row => row.status), ['waiting_for_input', 'unknown', 'waiting_for_approval', 'running', 'preparing', 'queued']);
  assert.deepEqual([json.queueTotal, json.queue.find(row => row.id === queued).waiting.position, json.queue.find(row => row.id === approval).agentId], [6, 1, agents.gem.id]);
  assert.equal(json.queue.find(row => row.id === busy.jobId).attempt.usage, null, 'usage not reported');
  assert.ok(!JSON.stringify(json).includes('PRIVATE INPUT TEXT') && !JSON.stringify(json).includes('Which year?'), 'no input or result text');
  assert.ok(!/percent|progress/i.test(JSON.stringify(json)), 'nothing claims progress');
  assert.deepEqual(json.kanban.map(run => [run.runId, run.taskTitle, run.status, run.active, run.agentIds]), [['run-k1', 'Fix the login', 'running', true, [agents.lead.id]], ['run-k2', 'Write the notes', 'succeeded', false, [agents.scout.id]]]);
  assert.deepEqual([json.kanban[0].usage, json.kanban[1].usage, json.kanban[0].projectName, json.kanban[0].taskId], [{ inputTokens: 1200, outputTokens: 300, cachedTokens: null, costUsd: 0.0123 }, null, 'Site', card.id]);
  assert.deepEqual([byName.Lead.kanbanActive, byName.Scout.kanbanActive], [1, 0]);
  assert.equal(await readFile(stateFile, 'utf8'), before, 'reading Kanban runs changes nothing');
  assert.equal(json.events.last > 0, true);
  // The view follows the job records: approving moves Gem to queued (behind the full pool), a forged event moves nothing.
  await app.networkEvents.append({ type: 'job.status', jobId: approval, agentId: agents.gem.id, status: 'completed' });
  assert.equal((await call('/api/network/activity')).json.agents.find(agent => agent.name === 'Gem').status, 'waiting_for_approval');
  await call(`/api/network/jobs/${approval}/approve`, 'POST', { expectedRevision: 1, decision: 'approve' });
  assert.equal((await call('/api/network/activity')).json.agents.find(agent => agent.name === 'Gem').status, 'queued');
  blocker.entry.end(); busy.entry.end();
  // Pure parts: coverage by provider (unknown for anything else), and runs matched only through registered Base IDs.
  assert.deepEqual(['claude', 'codex', 'gemini', 'agy', undefined, 'toString'].map(provider => coverageOf(provider).level), ['tools', 'partial-tools', 'final-only', 'none', 'unknown', 'unknown']);
  assert.deepEqual(kanbanRuns({ runs: [{ id: 'r', status: 'running', baseManifest: { profiles: [{ resourceId: 'x' }] } }], projects: [] }, [{ id: AGENT, baseResourceId: 'y' }]), []);
  assert.deepEqual(kanbanRuns({ runs: [{ id: 'r', taskId: 'gone', status: 'interrupted', baseManifest: { profiles: [{ resourceId: 'y' }, { resourceId: 'y' }] } }], projects: [] }, [{ id: AGENT, baseResourceId: 'y' }, { id: AGENT2, baseResourceId: 'y' }])
    .map(run => [run.taskTitle, run.active, run.agentIds]), [['', false, [AGENT, AGENT2]]]);
});
