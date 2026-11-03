// Task 14 performance on the server, at suite size (tests/fixtures/network-perf.mjs SIZES.suite: 1,100 registrations, 50
// published team networks of 20 agents pinned by one "Org" network, a 1,000-node draft, a 200-step published pipeline, 500
// jobs and a journal of 15 full segments): owner-API list, search, read, save, publish and validate times; the start of an
// app on that folder; and the job ceiling, which holds with far more jobs than slots, on the fake worker and with real
// processes (the real worker on the fake CLIs). Times are logged (t.diagnostic; PB_NETWORK_PERF_LOG=<file> writes JSON) and
// only gross regressions fail. The full sizes run in the opt-in scripts/network-perf.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from '../src/board.mjs';
import { startServer } from '../src/server.mjs';
import { buildGraphs, copyJobs, measureServer, SIZES, writeOffline } from './fixtures/network-perf.mjs';
import { installFakeClis, skipFakes, until } from './helpers/network-e2e.mjs';
import { fakeWorker } from './helpers/network-worker.mjs';

const fakes = await installFakeClis(['claude', 'codex']);
const catalogReader = async provider => ({ provider, source: 'test fixture', models: [] });
const results = {};
test.after(async () => { if (process.env.PB_NETWORK_PERF_LOG) await writeFile(process.env.PB_NETWORK_PERF_LOG, `${JSON.stringify(results, null, 1)}\n`); });

async function open(dataDir, worker, events) {
  const app = await startServer({ port: 0, dataDir, executor: null, networkWorker: worker, catalogReader, networkEventOptions: events });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const json = await response.json();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(json).slice(0, 300)}`);
    return json;
  };
  return { app, call };
}

test('server at size: lists, search, reads, saves, publish and validation stay fast; an app starts on 500 jobs and a full journal; the job ceiling holds with 40 jobs for 2 slots', { timeout: 240000 }, async t => {
  const sizes = SIZES.suite, events = { segmentBytes: sizes.segmentBytes };
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-network-perf-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const board = new Board({ dataDir });
  await board.base.create({ id: 'lead', kind: 'profile', name: 'Lead', configuration: { agent: { provider: 'claude' } } });
  await board.base.create({ id: 'scout', kind: 'profile', name: 'Scout', configuration: { agent: { provider: 'codex' } } });
  const generated = performance.now();
  const { rows, lastSeq } = await writeOffline(dataDir, sizes, ['lead', 'scout']);
  let { app, call } = await open(dataDir, fakeWorker(), events);
  t.after(() => app.close()); // The app open at the end (each one is closed before the next starts).
  const ids = await buildGraphs(call, rows, sizes);
  const template = (await call('/api/network/jobs', 'POST', { agentId: rows[0].id, input: { text: 'The template job.' } })).jobId;
  await until(async () => (await call(`/api/network/jobs/${template}`)).job.status === 'completed', 'the template job completes');
  await app.close();
  await copyJobs(dataDir, template, sizes.jobs - 1);
  results.fixtureMs = Math.round(performance.now() - generated);

  // The start: the app on this folder, then the first job list (the start scan of every job.json) and the first journal page.
  const started = performance.now();
  ({ app, call } = await open(dataDir, fakeWorker(), events));
  results.startMs = Math.round(performance.now() - started);
  const firstJobs = performance.now(), jobs = await call('/api/network/jobs?limit=200');
  results.firstJobListMs = Math.round(performance.now() - firstJobs);
  const firstEvents = performance.now(), page = await call('/api/network/events?limit=200');
  results.firstEventsPageMs = Math.round(performance.now() - firstEvents);
  assert.deepEqual([jobs.total, jobs.unavailable.length, page.last > lastSeq], [sizes.jobs, 0, true]);
  Object.assign(results, await measureServer(call, ids, rows));
  assert.deepEqual([results.agents, results.bigGraphNodes, results.jobs], [sizes.agents, sizes.bigGraph, sizes.jobs]);
  const org = (await call(`/api/network/networks/${ids.orgId}`)).network;
  assert.equal(org.nodes.filter(node => node.type === 'subnetwork').length, sizes.teams);

  // The ceiling on the fake worker: 40 jobs for 2 slots; never more than 2 attempts at once, and 2 are reached.
  await app.close();
  const manual = fakeWorker({ mode: 'manual' });
  ({ app, call } = await open(dataDir, manual, events));
  await call('/api/network/settings', 'PATCH', { expectedRevision: (await call('/api/network/settings')).settings.revision, maxConcurrentJobs: 2 });
  const submitted = [];
  for (let i = 0; i < 40; i++) submitted.push((await call('/api/network/jobs', 'POST', { agentId: rows[i % 2].id, input: { text: `Ceiling ${i}.` } })).jobId);
  const finished = new Set();
  while (finished.size < 40) {
    const running = await until(() => { const open = [...manual.attempts.values()].filter(entry => !finished.has(entry.own.attemptId)); return open.length && open; }, 'an attempt runs', 10000);
    assert.ok(manual.active <= 2 && running.length <= 2, `at most 2 at once (${manual.active})`);
    for (const entry of running) {
      finished.add(entry.own.attemptId);
      await entry.own.launching(); await entry.own.spawned({ pid: 4242 });
      await entry.own.finish({ status: 'completed', exitCode: 0, result: { text: 'Done.' } }); entry.end();
    }
  }
  await until(async () => (await Promise.all(submitted.map(async id => (await call(`/api/network/jobs/${id}`)).job.status))).every(status => status === 'completed'), 'all 40 completed', 20000);
  assert.deepEqual([manual.maxActive, manual.starts.length], [2, 40], 'the ceiling was reached and never passed');
  results.ceilingFakeWorker = { jobs: 40, slots: 2, maxActive: manual.maxActive };
  await app.close();
  results.loadAverage = loadavg().map(value => +value.toFixed(1)); // Other work on the machine slows every number above.
  t.diagnostic(`Network server at size: ${JSON.stringify(results)}`);
  // Gross regressions only: each of these is far below 1 s on the test machine (docs/network/performance.md).
  for (const [name, ms] of Object.entries(results)) if (/Ms$/.test(name) && name !== 'fixtureMs') assert.ok(ms < (name === 'startMs' ? 30000 : 10000), `${name}: ${ms} ms`);
});

test('the job ceiling holds with real processes: 12 jobs on the real worker and the fake CLIs, 2 slots, never more than 2 CLIs alive at once', { skip: skipFakes, timeout: 120000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-network-perf-ceiling-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const board = new Board({ dataDir });
  await board.base.create({ id: 'lead', kind: 'profile', name: 'Lead', configuration: { agent: { provider: 'claude' } } });
  const { app, call } = await open(dataDir, undefined, {}); // The app's own LocalJobWorker.
  t.after(() => app.close());
  const agent = (await call('/api/network/agents', 'POST', { baseResourceId: 'lead', expectedRevision: 0 })).agent;
  assert.equal((await call('/api/network/settings')).settings.maxConcurrentJobs, 2, 'the default ceiling');
  const before = new Set((await fakes.runs()).map(run => run.pid)), started = performance.now();
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push((await call('/api/network/jobs', 'POST', { agentId: agent.id, input: { text: `[[slow:300]] Ceiling ${i}.` } })).jobId);
  await until(async () => (await Promise.all(ids.map(async id => (await call(`/api/network/jobs/${id}`)).job.status))).every(status => status === 'completed'), 'all 12 completed', 60000);
  results.ceilingRealWorker = { jobs: 12, slots: 2, wallMs: Math.round(performance.now() - started) };
  // Each fake CLI recorded when it started working and when it ended: at any moment at most 2 were between the two.
  const runs = (await fakes.runs()).filter(run => !before.has(run.pid) && run.input.includes('Ceiling'));
  const spans = await Promise.all(runs.map(async run => [run.at, Number(await readFile(join(fakes.logs, `${run.pid}.end`), 'utf8'))]));
  const most = Math.max(...spans.map(([at]) => spans.filter(([start, end]) => start <= at && at < end).length));
  assert.deepEqual([runs.length, most], [12, 2], `never more than 2 CLIs at once, and 2 were reached: ${JSON.stringify(spans)}`);
  results.ceilingRealWorker.maxAlive = most;
  assert.equal((await readdir(join(dataDir, 'network', 'jobs'))).length, 12);
});
