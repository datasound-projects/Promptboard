// Wave B integration: a pipeline step whose agent job delegates (Task 12) or asks a question, end to end through the real app
// (startServer) and its default local worker, with the fake headless Claude Code and Codex CLIs (tests/fixtures/fake-headless-cli.mjs
// [[delegate:<id>]] and [[ask]]) as the only programs on PATH besides node. While the step's job waits for its sub-job or for the
// owner's answer, the runner treats the step as running, submits no second step job and keeps counting the run's deadline; the
// step completes with the job's final result (its second attempt); cancelling the run, or passing its deadline, cancels the
// step's job and through it the sub-job. Sub-jobs do not carry the run's link (only the runner links a job to a run); the step
// job's own handoff and message events do, so the run's event filter shows them. No real CLI, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { chmod, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.mjs';

const skip = process.platform === 'win32'; // The fakes are scripts with a shebang line.
const bin = await mkdtemp(join(tmpdir(), 'pb-network-handoff-bin-'));
for (const name of ['claude', 'codex']) {
  await writeFile(join(bin, name), `#!${process.execPath}\nimport ${JSON.stringify(new URL('./fixtures/fake-headless-cli.mjs', import.meta.url).href)};\n`);
  await chmod(join(bin, name), 0o700);
}
await writeFile(join(bin, 'package.json'), '{"type":"module"}');
await symlink(process.execPath, join(bin, 'node'));
process.env.PATH = bin; // Only the fakes and node: no real CLI can be found.
process.on('exit', () => rmSync(bin, { recursive: true, force: true }));

const hex = text => createHash('sha256').update(text).digest('hex');
const N = name => `n_${hex(`step:${name}`).slice(0, 12)}`;
const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, ms = 30000) {
  for (const end = Date.now() + ms; Date.now() < end; await tick()) { const value = await check(); if (value) return value; }
  assert.fail(`timed out: ${label}`);
}

test('a pipeline step whose job delegates or asks: still running while it waits, one step job, completed with the final result; cancel and the deadline reach the sub-job', { skip, timeout: 180000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-network-handoff-e2e-')), logs = await mkdtemp(join(tmpdir(), 'pb-network-handoff-log-'));
  t.after(() => Promise.all([dataDir, logs].map(dir => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))));
  process.env.FAKE_HEADLESS_LOG = logs;
  let skew = 0; // The runner's clock only, so the run's deadline can pass without waiting two hours.
  // networkWorker: undefined on purpose: the app's own LocalJobWorker, with only the fakes on PATH.
  const app = await startServer({ port: 0, dataDir, executor: null, networkWorker: undefined, networkPipelineOptions: { now: () => Date.now() + skew }, catalogReader: async provider => ({ provider, source: 'test fixture', models: [] }) });
  t.after(() => app.close());
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const json = await response.json();
    assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(json)}`);
    return json;
  };
  const cliRuns = async () => (await readdir(logs)).filter(name => /^\d+\.json$/.test(name)).length;
  const runOf = async id => (await call(`/api/network/pipeline-runs/${id}`)).run;
  const stepJobs = async id => (await call(`/api/network/jobs?pipelineRunId=${id}&limit=200`)).jobs;
  const jobOf = async id => call(`/api/network/jobs/${id}`);

  // Lead (Claude) may delegate to Checker (Codex) in the published network "Desk"; questions and delegation are on, and
  // sub-jobs wait for the owner's approval (the default), which holds the step's job waiting for its sub-job.
  await app.board.base.create({ id: 'lead', kind: 'profile', name: 'Lead', configuration: { agent: { provider: 'claude', model: 'haiku' } } });
  await app.board.base.create({ id: 'checker', kind: 'profile', name: 'Checker', configuration: { agent: { provider: 'codex' } } });
  const lead = (await call('/api/network/agents', 'POST', { baseResourceId: 'lead', expectedRevision: 0 })).agent;
  const checker = (await call('/api/network/agents', 'POST', { baseResourceId: 'checker', expectedRevision: 1 })).agent;
  const { network } = await call('/api/network/networks', 'POST', { name: 'Desk', nodes: [lead, checker].map((agent, i) => ({ id: N(`member${i}`), type: 'agent', agentId: agent.id, position: { x: i * 200, y: 0 } })),
    edges: [{ id: `e_${hex('delegate').slice(0, 12)}`, from: N('member0'), to: N('member1'), relation: 'delegate' }] });
  await call(`/api/network/networks/${network.id}/publish`, 'POST', { expectedRevision: network.revision });
  await call('/api/network/delegation', 'PATCH', { expectedRevision: 0, delegate: true, askOwner: true });
  const pipelineOf = async (name, instructions) => {
    const { pipeline } = await call('/api/network/pipelines', 'POST', { networkId: network.id, networkVersion: 1, name,
      nodes: [{ id: N('lead'), type: 'agent', label: 'Lead', position: { x: 0, y: 0 }, config: { agentId: lead.id, instructions } }, { id: N('report'), type: 'output', label: 'Report', position: { x: 200, y: 0 }, config: { name: 'report', include: [N('lead')] } }],
      edges: [{ id: `e_${hex(name).slice(0, 12)}`, from: N('lead'), to: N('report'), fromPort: 'text' }] });
    await call(`/api/network/pipelines/${pipeline.id}/publish`, 'POST', { expectedRevision: pipeline.revision });
    return pipeline.id;
  };
  const delegating = await pipelineOf('Delegating', `Write the summary. [[delegate:${checker.id}]]`), asking = await pipelineOf('Asking', 'Write the summary. [[ask]]');
  const start = async id => (await call(`/api/network/pipelines/${id}/runs`, 'POST', { version: 1, confirm: true, input: { text: 'The quarter.' } })).runId;
  /** The run's one step job once it waits for its sub-job (itself waiting for approval): [parent, sub-job]. */
  const waitingParent = async runId => until(async () => {
    const [job] = await stepJobs(runId), children = job ? (await jobOf(job.id)).children : [];
    if (job?.status !== 'waiting_for_input' || children.length !== 1) return null;
    const { job: child } = await jobOf(children[0]);
    return child.status === 'waiting_for_approval' && [job, child];
  }, `the step job of ${runId} waits for its sub-job`);
  const report = async runId => readFile(join(dataDir, 'network', 'pipeline-runs', `run__${runId.slice(4)}`, 'reports', 'report.md'), 'utf8');

  // Run 1: the step's job delegates. While it waits, the step is running and the run moves on nothing; one step job only.
  const run1 = await start(delegating);
  const [parent1, child1] = await waitingParent(run1);
  assert.deepEqual([parent1.waiting.for, parent1.awaiting.kind, child1.parentJobId, child1.pipelineRunId, child1.requester], ['children', 'children', parent1.id, null, { kind: 'job', id: parent1.id }]);
  await tick(2500); // More than two passes of the runner.
  let run = await runOf(run1);
  assert.deepEqual([run.status, run.nodes[N('lead')].status, run.nodes[N('lead')].jobId, run.nodes[N('lead')].jobIds, run.pausedAt], ['running', 'running', parent1.id, [parent1.id], null], 'still running, its deadline counting');
  assert.deepEqual([(await stepJobs(run1)).map(job => job.id), await cliRuns()], [[parent1.id], 1], 'one step job; the sub-job does not carry the run’s link');
  // The run's event filter shows the step job's handoff and its request message, named by the run and the step.
  let events = (await call(`/api/network/events?after=0&limit=200&pipelineRunId=${run1}`)).events;
  assert.ok(events.some(event => event.type === 'job.handoff' && event.jobId === parent1.id && event.status === 'waiting' && event.kind === 'delegate' && event.nodeId === N('lead')), 'the handoff event carries the run and step');
  assert.ok(events.some(event => event.type === 'job.message' && event.jobId === parent1.id && event.kind === 'request'), 'the request message too');
  assert.ok(!events.some(event => event.jobId === child1.id), 'the sub-job’s own events stay its own (Activity shows them under the step’s job)');
  // The owner approves the sub-job: it runs on Codex, the step's job runs again with its result, and the step completes.
  await call(`/api/network/jobs/${child1.id}/approve`, 'POST', { expectedRevision: child1.revision, decision: 'approve' });
  run = await until(async () => { const value = await runOf(run1); return value.status === 'completed' && value; }, 'run 1 completed');
  const { job: done1 } = await jobOf(parent1.id);
  assert.deepEqual([done1.attempts.length, run.nodes[N('lead')].result.jobId, run.nodes[N('lead')].result.attemptId, run.nodes[N('lead')].jobIds], [2, parent1.id, done1.attempts[1].id, [parent1.id]], 'completed with the second attempt’s result');
  assert.equal(await report(run1), '# Delegating\n\n## Lead\n\nFinal answer from claude, with what came back.\n');
  assert.deepEqual([(await stepJobs(run1)).length, (await jobOf(child1.id)).job.status, await cliRuns()], [1, 'completed', 3], 'the parent, its sub-job, the parent again');
  events = (await call(`/api/network/events?after=0&limit=200&pipelineRunId=${run1}`)).events;
  assert.ok(events.some(event => event.type === 'job.handoff' && event.jobId === parent1.id && event.status === 'continued'), 'the handoff came back');

  // Run 2: the step's job asks a question. The step runs on while it waits; the owner's answer completes it.
  const run2 = await start(asking);
  const [parent2] = await until(async () => { const jobs = await stepJobs(run2); return jobs[0]?.status === 'waiting_for_input' && jobs; }, 'the step job of run 2 asks');
  assert.deepEqual([parent2.waiting.for, parent2.awaiting.question], ['input', 'Which region?']);
  await tick(2500);
  run = await runOf(run2);
  assert.deepEqual([run.status, run.nodes[N('lead')].status, run.nodes[N('lead')].jobIds, (await stepJobs(run2)).length, await cliRuns()], ['running', 'running', [parent2.id], 1, 4]);
  const { messages } = await call(`/api/network/jobs/${parent2.id}/messages`);
  assert.deepEqual(messages.map(message => [message.kind, message.to]), [['needs_input', { owner: true }]], 'a pipeline step’s question goes to the owner');
  await call(`/api/network/jobs/${parent2.id}/answer`, 'POST', { expectedRevision: (await jobOf(parent2.id)).job.revision, text: 'Europe.' });
  run = await until(async () => { const value = await runOf(run2); return value.status === 'completed' && value; }, 'run 2 completed');
  assert.deepEqual([run.nodes[N('lead')].result.attemptId, (await jobOf(parent2.id)).job.attempts.length, await report(run2), await cliRuns()],
    [(await jobOf(parent2.id)).job.attempts[1].id, 2, '# Asking\n\n## Lead\n\nFinal answer from claude, with what came back.\n', 5]);

  // Run 3: cancelled while the step's job waits for its sub-job: the run, the step, the job and the sub-job are cancelled.
  const run3 = await start(delegating);
  const [parent3, child3] = await waitingParent(run3);
  assert.equal((await call(`/api/network/pipeline-runs/${run3}/cancel`, 'POST', {})).run.status, 'cancelled');
  await until(async () => (await jobOf(parent3.id)).job.status === 'cancelled' && (await jobOf(child3.id)).job.status === 'cancelled', 'run 3’s jobs cancelled');
  assert.match((await jobOf(child3.id)).job.reason, /the job that delegated it was cancelled/);
  await tick(1500);
  assert.deepEqual([(await runOf(run3)).nodes[N('lead')].status, (await stepJobs(run3)).length, await cliRuns()], ['cancelled', 1, 6], 'nothing ran after the cancel');

  // Run 4: the deadline passes while the step's job waits for its sub-job: the run fails DEADLINE and both jobs are cancelled.
  const run4 = await start(delegating);
  const [parent4, child4] = await waitingParent(run4);
  skew = 3 * 60 * 60_000; // Past the default two hours.
  run = await until(async () => { const value = await runOf(run4); return value.status === 'failed' && value; }, 'run 4 failed at its deadline');
  assert.deepEqual([run.errorCode, run.nodes[N('lead')].status, run.nodes[N('lead')].errorCode], ['DEADLINE', 'cancelled', 'RUN_STOPPED']);
  await until(async () => (await jobOf(parent4.id)).job.status === 'cancelled' && (await jobOf(child4.id)).job.status === 'cancelled', 'run 4’s jobs cancelled');
  await tick(1500);
  assert.deepEqual([(await stepJobs(run4)).length, await cliRuns()], [1, 7], 'nothing ran after the deadline');
});
