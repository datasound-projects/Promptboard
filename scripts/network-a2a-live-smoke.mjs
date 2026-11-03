#!/usr/bin/env node
// Opt-in live smoke test of inbound A2A (docs/network/implementation-progress.md, Task 13): one A2A task from the official
// @a2a-js/sdk client, through the machine listener of an isolated app on port 4913 (temporary data folder), to one agent
// published for A2A, executed as a Network job by the app's own local worker with the real signed-in CLI. Paid: exactly one
// CLI call (Codex at low effort, or Claude with haiku). Never part of `npm test`.
//
//   PB_NETWORK_LIVE=codex node scripts/network-a2a-live-smoke.mjs      (or PB_NETWORK_LIVE=claude)
//
// PATH holds only a link to node and a link to that CLI. The folder is removed at the end unless PB_NETWORK_KEEP=1.
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Role } from '@a2a-js/sdk';
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { resolveExecutable } from '../src/providers.mjs';
import { startServer } from '../src/server.mjs';

const name = (process.env.PB_NETWORK_LIVE || '').trim(), AGENTS = { codex: { provider: 'codex', effort: 'low' }, claude: { provider: 'claude', model: 'haiku' } };
if (!AGENTS[name]) { console.error('Set PB_NETWORK_LIVE to codex or claude (one run).'); process.exit(2); }
const real = await resolveExecutable(name);
if (!real) { console.error(`${name} is not installed.`); process.exit(2); }
const root = await mkdtemp(join(tmpdir(), 'pb-network-a2a-live-')), bin = join(root, 'bin');
await mkdir(bin);
await symlink(process.execPath, join(bin, 'node'));
await symlink(real.command, join(bin, name));
process.env.PATH = bin;

const app = await startServer({ port: 4913, dataDir: join(root, 'data'), projectsDir: join(root, 'projects'), executor: null }); // The app's own LocalJobWorker.
const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
const call = async (path, method = 'GET', body) => (await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
let report;
try {
  await app.board.base.create({ id: `live-${name}`, kind: 'profile', name: `Live ${name}`, configuration: { agent: AGENTS[name] } });
  const { agent } = await call('/api/network/agents', 'POST', { baseResourceId: `live-${name}`, expectedRevision: (await call('/api/network/agents')).revision });
  const listener = (await call('/api/network/listener', 'PATCH', { enabled: true, port: 0 })).listener;
  await call('/api/network/federation/inbound', 'PATCH', { expectedRevision: (await call('/api/network/federation')).revision, enabled: true, agents: [{ agentId: agent.id, description: 'Summarises short texts.' }] });
  const { client, token: caller } = await call('/api/network/clients', 'POST', { kind: 'a2a', name: 'Live A2A caller', scopes: { agents: [agent.id], permissions: ['submit_jobs', 'read_job_result', 'cancel_own_jobs'] } });
  const fetchImpl = (url, init = {}) => fetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers ?? {})), authorization: `Bearer ${caller}` } });
  const card = await new DefaultAgentCardResolver({ fetchImpl }).resolve(listener.url);
  const sdk = await new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl })], cardResolver: new DefaultAgentCardResolver({ fetchImpl }) }).createFromAgentCard(card);
  const started = Date.now();
  const task = await sdk.sendMessage({ tenant: '', metadata: undefined, configuration: undefined, message: { messageId: 'live-1', contextId: '', taskId: '', role: Role.ROLE_USER, metadata: undefined, extensions: [], referenceTaskIds: [],
    parts: [{ content: { $case: 'text', value: 'Summarise in two bullet points: A2A lets independent agents send each other tasks. Promptboard runs each inbound task as one read-only Network job.' }, metadata: undefined, filename: '', mediaType: 'text/plain' }] } });
  const { job } = await call(`/api/network/jobs/${task.id}`), attempt = job.attempts.at(-1);
  report = { provider: name, ...AGENTS[name], seconds: Math.round((Date.now() - started) / 1000), taskState: task.status?.state, jobStatus: job.status, errorCode: job.errorCode, source: job.source,
    requester: job.requester.kind === 'a2a' && job.requester.id === client.id ? 'the A2A caller' : job.requester, exitCode: attempt?.exitCode, coverage: attempt?.coverage, usage: attempt?.usage,
    result: task.artifacts?.[0]?.parts?.[0]?.content?.value?.slice(0, 400) ?? null };
} finally {
  await app.close();
  if (process.env.PB_NETWORK_KEEP !== '1') await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
console.log(JSON.stringify(report, null, 2));
