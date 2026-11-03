#!/usr/bin/env node
// Opt-in live check of Task 12 (docs/network/implementation-progress.md, "Task 12"): can a real model emit the structured
// delegation request that Network's handoff contract defines (architecture §23 item 1)? One job for a Claude Code agent (haiku)
// in a network with a delegate relation to a second agent, through an isolated app on port 4912 with a temporary data folder
// and the app's own local worker. The sub-job's agent runs on the FAKE Codex CLI (tests/fixtures/fake-headless-cli.mjs), so
// at most two real (paid) CLI runs happen: the parent's first attempt and, if it delegated, its second attempt with the
// sub-job's result. Never part of `npm test`.
//
//   PB_NETWORK_LIVE=claude node scripts/network-delegation-live.mjs
//
// The real CLI runs through a wrapper that copies its stdout to a log (for the reported usage). Everything is removed at the
// end unless PB_NETWORK_KEEP=1.
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { resolveExecutable } from '../src/providers.mjs';
import { startServer } from '../src/server.mjs';

if (process.env.PB_NETWORK_LIVE !== 'claude') { console.error('Set PB_NETWORK_LIVE=claude to spend up to two real Claude Code (haiku) runs.'); process.exit(2); }
const real = await resolveExecutable('claude');
if (!real) { console.error('Claude Code is not installed.'); process.exit(2); }
const root = await mkdtemp(join(tmpdir(), 'pb-network-delegation-live-')), bin = join(root, 'bin'), logs = join(root, 'stdout');
for (const dir of [bin, logs]) await mkdir(dir, { recursive: true });
await writeFile(join(bin, 'claude'), `#!${process.execPath}
import { spawn } from 'node:child_process'; import { createWriteStream } from 'node:fs';
const log = createWriteStream(${JSON.stringify(join(logs, 'claude'))} + '-' + process.pid + '.out');
const child = spawn(${JSON.stringify(real.command)}, [...${JSON.stringify(real.prefix)}, ...process.argv.slice(2)], { stdio: ['inherit', 'pipe', 'inherit'] });
child.stdout.on('data', chunk => { log.write(chunk); process.stdout.write(chunk); });
child.on('close', (code, signal) => log.end(() => process.exit(code ?? (signal ? 1 : 0))));
`);
await writeFile(join(bin, 'codex'), `#!${process.execPath}\nimport ${JSON.stringify(new URL('../tests/fixtures/fake-headless-cli.mjs', import.meta.url).href)};\n`);
await writeFile(join(bin, 'package.json'), '{"type":"module"}');
for (const name of ['claude', 'codex']) await chmod(join(bin, name), 0o700);
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`; // The fake Codex comes first; the real Claude Code only through its wrapper.

const app = await startServer({ port: 4912, dataDir: join(root, 'data'), projectsDir: join(root, 'projects'), executor: null });
const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
const call = async (path, method = 'GET', body) => (await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
const hex = text => createHash('sha256').update(text).digest('hex').slice(0, 12);
let summary;
try {
  await app.board.base.create({ id: 'live-lead', kind: 'profile', name: 'Release planner', configuration: { agent: { provider: 'claude', model: 'haiku' } } });
  await app.board.base.create({ id: 'live-checker', kind: 'profile', name: 'Fact checker', configuration: { agent: { provider: 'codex' } } });
  const lead = (await call('/api/network/agents', 'POST', { baseResourceId: 'live-lead', expectedRevision: 0 })).agent;
  const checker = (await call('/api/network/agents', 'POST', { baseResourceId: 'live-checker', expectedRevision: 1 })).agent;
  const { network } = await call('/api/network/networks', 'POST', { name: 'Live team', nodes: [lead, checker].map(agent => ({ id: `n_${hex(agent.id)}`, type: 'agent', agentId: agent.id, position: { x: 0, y: 0 } })),
    edges: [{ id: `e_${hex('edge')}`, from: `n_${hex(lead.id)}`, to: `n_${hex(checker.id)}`, relation: 'delegate' }] });
  await call('/api/network/delegation', 'PATCH', { expectedRevision: 0, delegate: true, requireApproval: false, maxChildren: 1 });
  const text = 'Write a three-item checklist for releasing a small open-source library. One item must state the version format. You cannot check that format yourself: hand that check to the fact-checking agent as one sub-task, using the request format in the HANDOFFS section, and finish the checklist when its answer comes back.';
  const started = Date.now(), accepted = await call('/api/network/jobs', 'POST', { agentId: lead.id, input: { text }, networkId: network.id, limits: { timeoutMs: 180_000 } });
  let job;
  for (;;) { job = (await call(`/api/network/jobs/${accepted.jobId}`)).job; if (['completed', 'failed', 'cancelled', 'unknown', 'interrupted'].includes(job.status) || Date.now() - started > 600_000) break; await new Promise(resolve => setTimeout(resolve, 1000)); }
  const detail = await call(`/api/network/jobs/${job.id}`), handoff = job.attempts[0]?.handoff
    ? await readFile(join(root, 'data', 'network', 'jobs', `job__${job.id.slice(4)}`, 'attempts', `att__${job.attempts[0].id.slice(4)}`, 'handoff.md'), 'utf8') : null;
  const children = await Promise.all(detail.children.map(async id => (await call(`/api/network/jobs/${id}`)).job));
  const messages = (await call(`/api/network/jobs/${job.id}/messages`)).messages;
  summary = { jobId: job.id, status: job.status, errorCode: job.errorCode, reason: job.reason, seconds: Math.round((Date.now() - started) / 1000), history: job.history.map(entry => entry.status),
    attempts: job.attempts.map(attempt => ({ number: attempt.number, status: attempt.status, handoff: attempt.handoff?.kind ?? null, usage: attempt.usage })),
    delegationJson: handoff ? handoff.match(/```json[^\S\n]*\n([\s\S]*?)\n```/g)?.at(-1) ?? null : null,
    children: children.map(child => ({ id: child.id, agent: child.agentId === checker.id ? 'checker' : child.agentId, status: child.status, delegation: child.delegation })),
    messages: messages.map(message => `${message.kind}: ${message.text.slice(0, 160)}`), result: job.result ? (await call(`/api/network/jobs/${job.id}/result`)).text.slice(0, 1200) : null,
    realClaudeRuns: job.attempts.length };
} finally {
  await app.close();
  if (process.env.PB_NETWORK_KEEP !== '1') await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify(summary, null, 2));
