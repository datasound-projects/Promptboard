#!/usr/bin/env node
// Opt-in live smoke test of a Network pipeline with the real signed-in Codex CLI (docs/network/implementation-progress.md,
// "Wave A integration"): two parallel agent steps → join → output, through an isolated app on port 4930 with a temporary
// data folder and the app's own local worker. Paid: exactly two real Codex runs at low effort (one per agent step); the
// steps have no retries, so a failure is reported, never run again. Never part of `npm test`.
//
//   PB_NETWORK_LIVE=codex node scripts/network-pipeline-live-smoke.mjs
//
// The app's PATH holds only a wrapper for Codex and node, so no other CLI can start; the wrapper runs the real Codex (absolute
// path) with the original PATH. The folder is removed at the end unless PB_NETWORK_KEEP=1.
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveExecutable } from '../src/providers.mjs';
import { startServer } from '../src/server.mjs';

if (process.env.PB_NETWORK_LIVE !== 'codex') { console.error('Set PB_NETWORK_LIVE=codex to run two real Codex jobs.'); process.exit(2); }
const real = await resolveExecutable('codex');
if (!real) { console.log(JSON.stringify({ codex: 'not installed: nothing ran' })); process.exit(0); }
const root = await mkdtemp(join(tmpdir(), 'pb-network-pipeline-live-')), dataDir = join(root, 'data'), wrappers = join(root, 'bin');
await mkdir(wrappers, { recursive: true });
await writeFile(join(wrappers, 'codex'), `#!${process.execPath}
import { spawn } from 'node:child_process';
const child = spawn(${JSON.stringify(real.command)}, [...${JSON.stringify(real.prefix)}, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, PATH: ${JSON.stringify(process.env.PATH)} } });
child.on('close', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
`);
await chmod(join(wrappers, 'codex'), 0o700);
await symlink(process.execPath, join(wrappers, 'node'));
process.env.PATH = wrappers;

const step = (id, type, config, label) => ({ id, type, label, position: { x: 0, y: 0 }, config });
const A = 'n_00000000000a', B = 'n_00000000000b', JOIN = 'n_0000000000a1', OUT = 'n_0000000000b1';
const app = await startServer({ port: 4930, dataDir, projectsDir: join(root, 'projects'), executor: null });
const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
const call = async (path, method = 'GET', body) => {
  const response = await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = await response.json();
  if (response.status >= 400) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(json)}`);
  return json;
};
let summary;
try {
  await app.board.base.create({ id: 'live-codex', kind: 'profile', name: 'Live Codex', configuration: { agent: { provider: 'codex', effort: 'low' } } });
  const { agent } = await call('/api/network/agents', 'POST', { baseResourceId: 'live-codex', expectedRevision: (await call('/api/network/agents')).revision });
  const { network } = await call('/api/network/networks', 'POST', { name: 'Live', nodes: [{ id: 'n_0000000000c1', type: 'agent', agentId: agent.id, position: { x: 0, y: 0 } }], edges: [] });
  await call(`/api/network/networks/${network.id}/publish`, 'POST', { expectedRevision: network.revision });
  const { pipeline } = await call('/api/network/pipelines', 'POST', { networkId: network.id, networkVersion: 1, name: 'Live smoke',
    nodes: [step(A, 'agent', { agentId: agent.id, instructions: 'In one short sentence, name one benefit of running coding agents locally.' }, 'Benefit'),
      step(B, 'agent', { agentId: agent.id, instructions: 'In one short sentence, name one risk of running coding agents locally.' }, 'Risk'),
      step(JOIN, 'join', { require: 'all' }, 'Join'), step(OUT, 'output', { name: 'report', include: [A, B] }, 'Report')],
    edges: [{ id: 'e_0000000000a1', from: A, to: JOIN, fromPort: 'text' }, { id: 'e_0000000000b1', from: B, to: JOIN, fromPort: 'text' }, { id: 'e_0000000000c1', from: JOIN, to: OUT, fromPort: 'done' }] });
  await call(`/api/network/pipelines/${pipeline.id}/publish`, 'POST', { expectedRevision: pipeline.revision });
  const started = Date.now(), { runId } = await call(`/api/network/pipelines/${pipeline.id}/runs`, 'POST', { version: 1, confirm: true, input: { text: 'Context: Promptboard runs Claude Code and Codex on this computer.' } });
  let run;
  for (const end = Date.now() + 6 * 60_000; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 1000))) {
    ({ run } = await call(`/api/network/pipeline-runs/${runId}`));
    if (!['running', 'waiting_for_approval'].includes(run.status)) break;
  }
  const jobs = await Promise.all((await call(`/api/network/jobs?pipelineRunId=${runId}`)).jobs.map(async job => {
    const attempt = job.attempts.at(-1), result = job.result ? await call(`/api/network/jobs/${job.id}/result`) : null;
    return { step: job.nodeId === A ? 'Benefit' : 'Risk', status: job.status, errorCode: job.errorCode, reason: job.reason, provider: attempt?.provider, effort: attempt?.effort, model: attempt?.model || '(CLI default)',
      spawnedAt: attempt?.spawnedAt, endedAt: attempt?.endedAt, coverage: attempt?.coverage, usage: attempt?.usage, result: result?.text?.slice(0, 300) ?? null };
  }));
  const [first, second] = jobs, overlap = Boolean(first?.spawnedAt && second?.spawnedAt && first.spawnedAt < second.endedAt && second.spawnedAt < first.endedAt);
  const events = (await call(`/api/network/events?after=0&limit=200&pipelineRunId=${runId}`)).events;
  const report = await readFile(join(dataDir, 'network', 'pipeline-runs', `run__${runId.slice(4)}`, 'reports', 'report.md'), 'utf8').catch(() => null);
  summary = { runId, status: run.status, errorCode: run.errorCode, seconds: Math.round((Date.now() - started) / 1000), realCliRuns: jobs.filter(job => job.spawnedAt).length, ranInParallel: overlap,
    runHistory: run.history.map(entry => entry.status), eventTypes: Object.fromEntries([...new Set(events.map(event => event.type))].map(type => [type, events.filter(event => event.type === type).length])),
    activityKinds: [...new Set(events.filter(event => event.type === 'job.activity').map(event => event.kind))], jobs, report: report?.slice(0, 800) ?? null };
} finally {
  await app.close();
  if (process.env.PB_NETWORK_KEEP !== '1') await rm(root, { recursive: true, force: true }); else console.log(`Kept ${root}`);
}
console.log(JSON.stringify(summary, null, 2));
