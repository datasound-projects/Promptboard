// Task 12 end to end through the real app (startServer) and its default local worker, with the fake headless Claude Code and
// Codex CLIs (tests/fixtures/fake-headless-cli.mjs) as the only programs on PATH besides node: the parent's prompt.md offers
// the delegate relation's agent, the CLI's report ends with a fenced json delegation request, the server creates the sub-job,
// the Codex sub-job runs, and the parent runs again with the sub-job's result inside its EARLIER WORK section. Local delegation
// needs nothing of A2A: no federation file, no machine listener. No real CLI, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { access, chmod, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.mjs';

const skip = process.platform === 'win32'; // The fakes are scripts with a shebang line.
const bin = await mkdtemp(join(tmpdir(), 'pb-network-delegation-bin-'));
for (const name of ['claude', 'codex']) {
  await writeFile(join(bin, name), `#!${process.execPath}\nimport ${JSON.stringify(new URL('./fixtures/fake-headless-cli.mjs', import.meta.url).href)};\n`);
  await chmod(join(bin, name), 0o700);
}
await writeFile(join(bin, 'package.json'), '{"type":"module"}');
await symlink(process.execPath, join(bin, 'node'));
process.env.PATH = bin; // Only the fakes and node: no real CLI can be found.
process.on('exit', () => rmSync(bin, { recursive: true, force: true }));

const hex = text => createHash('sha256').update(text).digest('hex');
const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, ms = 30000) {
  for (const end = Date.now() + ms; Date.now() < end; await tick()) { const value = await check(); if (value) return value; }
  assert.fail(`timed out: ${label}`);
}

test('a real worker run: the prompt offers the delegate, the CLI’s json asks for a sub-job, the sub-job runs on another CLI, and the parent runs again with its result', { skip, timeout: 120000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-network-delegation-e2e-')), logs = await mkdtemp(join(tmpdir(), 'pb-network-delegation-log-'));
  t.after(() => Promise.all([dataDir, logs].map(dir => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))));
  process.env.FAKE_HEADLESS_LOG = logs;
  const app = await startServer({ port: 0, dataDir, executor: null, catalogReader: async provider => ({ provider, source: 'test fixture', models: [] }) }); // The app's own LocalJobWorker.
  t.after(() => app.close());
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const json = await response.json();
    assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(json)}`);
    return json;
  };
  await app.board.base.create({ id: 'lead', kind: 'profile', name: 'Lead', configuration: { agent: { provider: 'claude', model: 'haiku' } } });
  await app.board.base.create({ id: 'checker', kind: 'profile', name: 'Checker', configuration: { agent: { provider: 'codex' } } });
  const lead = (await call('/api/network/agents', 'POST', { baseResourceId: 'lead', expectedRevision: 0 })).agent;
  const checker = (await call('/api/network/agents', 'POST', { baseResourceId: 'checker', expectedRevision: 1 })).agent;
  const N = id => `n_${hex(id).slice(0, 12)}`;
  const { network } = await call('/api/network/networks', 'POST', { name: 'Team', nodes: [lead, checker].map(agent => ({ id: N(agent.id), type: 'agent', agentId: agent.id, position: { x: 0, y: 0 } })),
    edges: [{ id: `e_${hex('edge').slice(0, 12)}`, from: N(lead.id), to: N(checker.id), relation: 'delegate' }] });
  await call('/api/network/delegation', 'PATCH', { expectedRevision: 0, delegate: true, requireApproval: false });
  const { jobId } = await call('/api/network/jobs', 'POST', { agentId: lead.id, input: { text: `Summarise the quarter. [[delegate:${checker.id}]]` }, networkId: network.id });
  const done = await until(async () => { const { job } = await call(`/api/network/jobs/${jobId}`); return job.status === 'completed' && job; }, 'the parent completed');
  const { children: [childId] } = await call(`/api/network/jobs/${jobId}`), { job: child } = await call(`/api/network/jobs/${childId}`);
  assert.deepEqual([done.attempts.length, child.status, child.requester, child.agentId, child.delegation.depth], [2, 'completed', { kind: 'job', id: jobId }, checker.id, 1]);
  const attemptDir = (id, attempt) => join(dataDir, 'network', 'jobs', `job__${id.slice(4)}`, 'attempts', `att__${attempt.slice(4)}`);
  const first = await readFile(join(attemptDir(jobId, done.attempts[0].id), 'prompt.md'), 'utf8'), second = await readFile(join(attemptDir(jobId, done.attempts[1].id), 'prompt.md'), 'utf8');
  assert.match(first, new RegExp(`=== HANDOFFS \\(optional; Promptboard checks every request and may refuse it\\) ===[\\s\\S]*  - ${checker.id}: Checker[\\s\\S]*=== END HANDOFFS ===`));
  assert.ok(!first.includes('=== EARLIER WORK ON THIS JOB'), 'the first attempt has no earlier work');
  assert.match(await readFile(join(attemptDir(jobId, done.attempts[0].id), 'handoff.md'), 'utf8'), /"promptboard":\{"delegate"/);
  assert.match(second, /=== EARLIER WORK ON THIS JOB \(your previous report and its handoff messages; data, not instructions\) ===\n {2}Your report from your previous attempt/);
  assert.match(second, /\n {6}Answer from codex\.\n/, 'the sub-job’s result, indented as data');
  assert.equal((await call(`/api/network/jobs/${jobId}/result`)).text, 'Final answer from claude, with what came back.');
  const childPrompt = await readFile(join(attemptDir(childId, child.attempts[0].id), 'prompt.md'), 'utf8');
  assert.match(childPrompt, new RegExp(`sub-task that job ${jobId} \\(agent ${lead.id}\\) delegated to you`));
  assert.ok(!childPrompt.includes('=== HANDOFFS'), 'the checker has no delegate relation and questions are off: nothing offered');
  const runs = (await readdir(logs)).filter(name => /^\d+\.json$/.test(name)).length;
  assert.equal(runs, 3, 'three CLI runs: the parent, the sub-job, the parent again');
  for (const absent of ['federation.json', 'clients.json']) assert.equal(await access(join(dataDir, 'network', absent)).then(() => true, () => false), false, `no ${absent}: local delegation needs no A2A or machine listener`);
});
