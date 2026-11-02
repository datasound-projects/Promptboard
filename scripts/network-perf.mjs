#!/usr/bin/env node
// Opt-in Network performance run at full size (tests/fixtures/network-perf.mjs SIZES.full: 5,000 registrations, the
// registry's ceiling; 50 published teams of 20 agents under one "Org" network; a 1,000-node draft; a 200-step pipeline;
// 5,000 jobs; a journal of 15 full 8 MiB segments, near the 16-segment ceiling). Never part of `npm test`. Everything runs on
// a temporary data folder with the deterministic fake job worker: no CLI, no network, nothing of the owner's.
//   node scripts/network-perf.mjs [--json <file>]
// Prints the hardware and the measurements as JSON (docs/network/performance.md records them).
import { cpus, loadavg, totalmem, tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Board } from '../src/board.mjs';
import { startServer } from '../src/server.mjs';
import { buildGraphs, copyJobs, measureServer, SIZES, writeOffline } from '../tests/fixtures/network-perf.mjs';
import { fakeWorker } from '../tests/helpers/network-worker.mjs';

const out = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
const sizes = SIZES.full, catalogReader = async provider => ({ provider, source: 'perf fixture', models: [] });
const cpu = (() => { try { return execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim(); } catch { return cpus()[0]?.model ?? 'unknown'; } })();
const dataDir = await mkdtemp(join(tmpdir(), 'pb-network-perf-full-'));
async function open(worker) {
  const app = await startServer({ port: 0, dataDir, executor: null, networkWorker: worker, catalogReader });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const json = await response.json();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(json).slice(0, 300)}`);
    return json;
  };
  return { app, call };
}
try {
  const board = new Board({ dataDir });
  await board.base.create({ id: 'lead', kind: 'profile', name: 'Lead', configuration: { agent: { provider: 'claude' } } });
  await board.base.create({ id: 'scout', kind: 'profile', name: 'Scout', configuration: { agent: { provider: 'codex' } } });
  const generated = performance.now();
  const { rows } = await writeOffline(dataDir, sizes, ['lead', 'scout']);
  let { app, call } = await open(fakeWorker());
  const ids = await buildGraphs(call, rows, sizes);
  const template = (await call('/api/network/jobs', 'POST', { agentId: rows[0].id, input: { text: 'The template job.' } })).jobId;
  for (let i = 0; (await call(`/api/network/jobs/${template}`)).job.status !== 'completed'; i++) { if (i > 500) throw new Error('The template job did not complete.'); await new Promise(resolve => setTimeout(resolve, 20)); }
  await app.close();
  await copyJobs(dataDir, template, sizes.jobs - 1);
  const results = { fixtureMs: Math.round(performance.now() - generated), journalBytes: 0 };
  const started = performance.now();
  ({ app, call } = await open(fakeWorker()));
  results.startMs = Math.round(performance.now() - started);
  let at = performance.now();
  await call('/api/network/jobs?limit=200'); results.firstJobListMs = Math.round(performance.now() - at);
  at = performance.now();
  await call('/api/network/events?limit=200'); results.firstEventsPageMs = Math.round(performance.now() - at);
  Object.assign(results, await measureServer(call, ids, rows));
  const memory = process.memoryUsage();
  results.serverHeapMB = +(memory.heapUsed / 2 ** 20).toFixed(1);
  results.serverRssMB = +(memory.rss / 2 ** 20).toFixed(1);
  for (const name of await readdir(join(dataDir, 'network', 'events'))) results.journalBytes += (await stat(join(dataDir, 'network', 'events', name))).size;
  await app.close();
  const report = { hardware: { cpu, cores: cpus().length, memoryGB: Math.round(totalmem() / 2 ** 30), node: process.version, platform: `${process.platform} ${process.arch}`, loadAverage: loadavg().map(value => +value.toFixed(1)) }, sizes, results };
  console.log(JSON.stringify(report, null, 1));
  if (out) await writeFile(out, `${JSON.stringify(report, null, 1)}\n`);
} finally { await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
