// Task 12 review (phase 3), the server side: a chain with an ancestor that cannot be read is refused, never judged short
// (P3-2); a cancel that meets a handoff still ends the job and its tree, and nothing is claimed or delegated under a cancelled
// ancestor (P3-3); a schedule time that fires while the engine shuts down runs once after the restart, and a time due before a
// new confirmation never fires (P3-4); an answer to the job's question always fits beside 200 notes (P3-5); a client's sub-job
// request under a used key with another task is IDEMPOTENCY_CONFLICT (P3-6). Real Base, Store, registry, job engine and
// schedules on temporary folders; the only worker is the deterministic fake, so no CLI starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Base } from '../src/base.mjs';
import { Store } from '../src/store.mjs';
import { NetworkRegistry } from '../src/network/registry.mjs';
import { NetworkJobs } from '../src/network/jobs.mjs';
import { Delegation } from '../src/network/delegation.mjs';
import { NetworkPipelines } from '../src/network/pipeline-model.mjs';
import { PipelineRunner } from '../src/network/pipeline-runner.mjs';
import { NetworkSchedules } from '../src/network/schedules.mjs';
import { fakeWorker } from './helpers/network-worker.mjs';

const hex = text => createHash('sha256').update(text).digest('hex');
const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await tick()) { const value = await check(); if (value) return value; }
  assert.fail(`timed out: ${label}`);
}
const N = id => `n_${hex(`node:${id}`).slice(0, 12)}`;
const rel = (from, to) => ({ id: `e_${hex(`${from.id}>${to.id}`).slice(0, 12)}`, from: N(from.id), to: N(to.id), relation: 'delegate' });
const delegate = (...tasks) => ({ promptboard: { delegate: tasks } });
const CLI = `cli_${'1'.repeat(20)}`;
const ENDED = ['completed', 'failed', 'cancelled'];
/** A manual attempt to running, then (unless `json` is undefined) its completed report with that structured result. */
const runTo = async (entry, json) => { await entry.own.launching(); await entry.own.spawned({ pid: 1 }); if (json !== undefined) return entry.own.finish({ status: 'completed', exitCode: 0, result: { text: 'r', ...(json ? { json } : {}) } }); };

/**
 * Agents lead, helper, checker and outsider; the network "Team" with delegate relations lead → helper → checker → outsider.
 * The client CLI is active with submit_jobs and may use the agents in `ctx.scope`.
 */
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-network-review3-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const base = new Base({ store: new Store(dataDir) });
  for (const id of ['lead', 'helper', 'checker', 'outsider']) await base.create({ id, kind: 'profile', name: id, configuration: { agent: { provider: 'claude' } } });
  let clock = 1_800_000_000_000;
  const now = () => (clock += 1000), engines = [], scope = [];
  const registry = new NetworkRegistry({ dataDir, base, projects: async () => [], now });
  const register = async id => (await registry.registerAgent({ baseResourceId: id, expectedRevision: (await registry.listAgents()).revision })).agent;
  const agents = { lead: await register('lead'), helper: await register('helper'), checker: await register('checker'), outsider: await register('outsider') };
  const { lead, helper, checker, outsider } = agents;
  const { network } = await registry.createNetwork({ name: 'Team', nodes: Object.values(agents).map(agent => ({ id: N(agent.id), type: 'agent', agentId: agent.id, position: { x: 0, y: 0 } })),
    edges: [rel(lead, helper), rel(helper, checker), rel(checker, outsider)] });
  const clients = async () => ({ clients: [{ id: CLI, status: 'active', scopes: { agents: scope, permissions: ['submit_jobs'] } }] });
  const open = ({ worker = null } = {}) => {
    const jobs = new NetworkJobs({ dataDir, registry, worker, now, prepareTimeoutMs: 600_000 });
    jobs.delegation = new Delegation({ dataDir, registry, now, clients });
    engines.push(jobs);
    return Object.assign(jobs, { ready: jobs.start(), worker });
  };
  t.after(async () => { for (const jobs of engines) { for (const entry of jobs.worker?.attempts?.values() || []) entry.end?.(); await jobs.close(); } });
  const policy = async (jobs, changes) => jobs.delegation.update({ expectedRevision: (await jobs.delegation.policy()).policy.revision, ...changes });
  const damage = async id => { const folder = join(dataDir, 'network', 'jobs', `job__${id.slice(4)}`); for (const name of ['job.json', 'job.json.bak']) await writeFile(join(folder, name), '{broken'); };
  return { dataDir, agents, network, scope, open, policy, damage };
}
const read = async (jobs, id) => (await jobs.read(id)).job;

test('P3-2: a queued sub-job whose chain has an unreadable ancestor fails at its claim; it never runs on a short chain', { timeout: 30000 }, async t => {
  const ctx = await fixture(t), { lead, helper, checker, outsider } = ctx.agents;
  ctx.scope.push(lead.id, helper.id, checker.id); // outsider is outside the client's scope
  const asks = { R: delegate({ agentId: helper.id, task: 'S' }), S: delegate({ agentId: checker.id, task: 'T' }), T: delegate({ agentId: outsider.id, task: 'U' }) };
  const worker = () => fakeWorker({ json: job => (job.handoff?.context ? null : asks[job.request.input.text]) });
  const first = ctx.open({ worker: worker() }); await first.ready;
  await ctx.policy(first, { delegate: true, requireApproval: true, maxDepth: 3 });
  const { jobId: R } = await first.submit({ agentId: lead.id, input: { text: 'R' }, networkId: ctx.network.id }, { requester: { kind: 'machine', id: CLI } });
  const [S] = await until(async () => (await first.read(R)).children.length === 1 && (await first.read(R)).children, 'S');
  await first.approve(S, { expectedRevision: (await read(first, S)).revision, decision: 'approve' });
  const [T] = await until(async () => (await first.read(S)).children.length === 1 && (await first.read(S)).children, 'T');
  await first.close();
  await ctx.damage(R); // the client's root job and its backup become unreadable
  const second = ctx.open({ worker: worker() }); await second.ready;
  assert.equal(await second.read(R).then(() => null, error => error.code), 'NETWORK_DATA_DAMAGED');
  await second.approve(T, { expectedRevision: (await read(second, T)).revision, decision: 'approve' });
  const ended = await until(async () => { const job = await read(second, T); return job.status !== 'queued' && job; }, 'T claimed or refused');
  assert.deepEqual([ended.status, ended.errorCode, ended.attempts.length, (await second.read(T)).children.length], ['failed', 'DELEGATION_REVOKED', 0, 0]);
});

test('P3-2: a job under an unreadable client root is offered no one and its delegation is refused', { timeout: 30000 }, async t => {
  const ctx = await fixture(t), { lead, helper, checker, outsider } = ctx.agents;
  ctx.scope.push(lead.id, helper.id, checker.id);
  const first = ctx.open(); await first.ready; // no worker: both jobs stay queued
  await ctx.policy(first, { delegate: true, requireApproval: false });
  const { jobId: R } = await first.submit({ agentId: lead.id, input: { text: 'R' }, networkId: ctx.network.id }, { requester: { kind: 'machine', id: CLI } });
  // The owner links a checker job under the client's job, so the client's scope covers its chain.
  const { jobId: X } = await first.submit({ agentId: checker.id, input: { text: 'X' }, networkId: ctx.network.id, parentJobId: R });
  await first.close();
  await ctx.damage(R);
  const handoffs = [];
  const second = ctx.open({ worker: fakeWorker({ json: job => { handoffs.push(job.handoff); return job.handoff?.context ? null : delegate({ agentId: outsider.id, task: 'U' }); } }) });
  await second.ready;
  const job = await until(async () => { const item = await read(second, X); return ENDED.includes(item.status) || item.status === 'waiting_for_input' ? item : null; }, 'X ran');
  assert.ok(!JSON.stringify(handoffs[0] ?? null).includes(outsider.id), 'the prompt does not offer an agent outside the client scope');
  assert.equal(job.status, 'completed');
  assert.match(job.reason, /refused/);
  assert.equal((await second.read(X)).children.length, 0);
});

test('P3-3 (b): a cancel that reaches a job right after its handoff was saved cancels it and its sub-jobs', { timeout: 15000 }, async t => {
  const ctx = await fixture(t), { lead, helper } = ctx.agents;
  // endOnCancel: false — the worker has not returned yet (its live entry stays), as in the review's case (b).
  const worker = fakeWorker({ mode: 'manual', endOnCancel: false }), jobs = ctx.open({ worker }); await jobs.ready;
  await ctx.policy(jobs, { delegate: true });
  const next = worker.next();
  const { jobId: P } = await jobs.submit({ agentId: lead.id, input: { text: 'parent' }, networkId: ctx.network.id });
  const parent = await next;
  await runTo(parent, delegate({ agentId: helper.id, task: 'child task' })); // the handoff is saved; the worker has not returned yet
  const [C] = (await jobs.read(P)).children;
  const answer = await jobs.cancel(P, {});
  parent.end();
  assert.deepEqual([answer.cancelled, answer.job.status], [true, 'cancelled']);
  await until(async () => (await read(jobs, C)).status === 'cancelled', 'its sub-job cancelled with it');
});

test('P3-3 (a): a cancel whose stop window meets a handoff still cancels the job and its new sub-job', { timeout: 30000 }, async t => {
  const ctx = await fixture(t), { lead, helper } = ctx.agents;
  const worker = fakeWorker({ mode: 'manual', endOnCancel: false }), stop = worker.cancel;
  let release; const gate = new Promise(resolve => { release = resolve; });
  worker.cancel = async own => { await stop(own); await gate; }; // the worker is still stopping
  const jobs = ctx.open({ worker }); await jobs.ready;
  await ctx.policy(jobs, { delegate: true });
  const next = worker.next();
  const { jobId: P } = await jobs.submit({ agentId: lead.id, input: { text: 'parent' }, networkId: ctx.network.id });
  const parent = await next;
  await runTo(parent);
  const cancelling = jobs.cancel(P, {});
  await until(() => worker.cancels.length === 1, 'the stop began');
  const late = await parent.own.finish({ status: 'completed', exitCode: 0, result: { text: 'r', json: delegate({ agentId: helper.id, task: 'child task' }) } });
  assert.equal(late.job?.status, 'waiting_for_input', 'the handoff was saved inside the stop window');
  release();
  const answer = await cancelling;
  parent.end();
  assert.deepEqual([answer.cancelled, answer.job.status], [true, 'cancelled']);
  const [C] = (await jobs.read(P)).children;
  await until(async () => (await read(jobs, C)).status === 'cancelled', 'the new sub-job cancelled');
});

test('P3-3 (a): a cascade whose sub-job delegates inside the stop window leaves nothing open under the cancelled job', { timeout: 30000 }, async t => {
  const ctx = await fixture(t), { lead, helper, checker } = ctx.agents;
  const worker = fakeWorker({ mode: 'manual', endOnCancel: false }), stop = worker.cancel;
  let release; const gate = new Promise(resolve => { release = resolve; });
  worker.cancel = async own => { await stop(own); await gate; };
  const jobs = ctx.open({ worker }); await jobs.ready;
  await ctx.policy(jobs, { delegate: true, requireApproval: false });
  let next = worker.next();
  const { jobId: P } = await jobs.submit({ agentId: lead.id, input: { text: 'parent' }, networkId: ctx.network.id });
  const parent = await next;
  next = worker.next();
  await runTo(parent, delegate({ agentId: helper.id, task: 'child task' }));
  parent.end();
  const child = await next, C = child.own.jobId;
  await runTo(child); // C is running
  assert.equal((await jobs.cancel(P, {})).job.status, 'cancelled');
  await until(() => worker.cancels.includes(child.own.attemptId), 'the cascade is stopping C');
  await child.own.finish({ status: 'completed', exitCode: 0, result: { text: 'child report', json: delegate({ agentId: checker.id, task: 'grandchild task' }) } });
  release();
  child.end();
  const c = await until(async () => { const job = await read(jobs, C); return ENDED.includes(job.status) && job; }, 'C ended with its parent');
  await tick(100);
  const tree = (await jobs.list({ limit: 200 })).jobs;
  assert.deepEqual(tree.filter(job => !ENDED.includes(job.status)).map(job => job.id), [], 'nothing under the cancelled job is open');
  assert.equal((await read(jobs, C)).attempts.length, 1, 'C never runs again');
  assert.ok(ENDED.includes(c.status));
});

test('P3-3: under a cancelled ancestor nothing gets a sub-job and nothing is claimed', { timeout: 30000 }, async t => {
  const ctx = await fixture(t), { lead, helper, checker } = ctx.agents;
  const worker = fakeWorker({ mode: 'manual' }), jobs = ctx.open({ worker }); await jobs.ready;
  await ctx.policy(jobs, { delegate: true, requireApproval: false });
  let next = worker.next();
  const { jobId: P } = await jobs.submit({ agentId: lead.id, input: { text: 'parent' }, networkId: ctx.network.id });
  const parent = await next;
  next = worker.next();
  await runTo(parent, delegate({ agentId: helper.id, task: 'child task' }));
  parent.end();
  const child = await next, C = child.own.jobId;
  await runTo(child);
  await child.own.finish({ status: 'unknown', exitCode: null }); // C needs the owner's decision, so the cascade leaves it
  child.end();
  await until(() => jobs.activeCount() === 0, 'attempts released');
  assert.equal((await jobs.cancel(P, {})).job.status, 'cancelled');
  await tick(50);
  assert.equal((await read(jobs, C)).status, 'unknown');
  const refused = await jobs.delegate(C, { agentId: checker.id, task: 'more' }, { clientId: CLI }).then(() => null, error => error.code);
  assert.equal(refused, 'DELEGATION_CANCELLED', 'no sub-job under a cancelled ancestor');
  next = worker.next(2000); next.catch(() => {});
  await jobs.retry(C, { expectedRevision: (await read(jobs, C)).revision, confirm: true, confirmUncertain: true });
  const job = await until(async () => { const item = await read(jobs, C); return item.status !== 'queued' && item; }, 'C claimed or refused');
  assert.deepEqual([job.status, job.errorCode, job.attempts.length], ['failed', 'DELEGATION_REVOKED', 1]);
});

test('P3-5: an answer to the job\'s question fits beside 200 notes; notes stay bounded', { timeout: 60000 }, async t => {
  const ctx = await fixture(t), { lead } = ctx.agents;
  const worker = fakeWorker({ json: job => (job.handoff?.context ? null : { promptboard: { needs_input: { question: 'Which quarter?' } } }) });
  const jobs = ctx.open({ worker }); await jobs.ready;
  await ctx.policy(jobs, { askOwner: true });
  const { jobId } = await jobs.submit({ agentId: lead.id, input: { text: 'Summarise.' } });
  await until(async () => (await read(jobs, jobId)).status === 'waiting_for_input', 'question asked');
  for (let i = 0; i < 200; i++) await jobs.postMessage(jobId, { kind: 'review', text: `note ${i}` }, { from: { owner: true } });
  assert.equal(await jobs.postMessage(jobId, { kind: 'review', text: 'one more' }, { from: { owner: true } }).then(() => null, error => error.code), 'NETWORK_LIMIT');
  const { job } = await jobs.read(jobId);
  await jobs.answer(jobId, { expectedRevision: job.revision, text: 'Q3' });
  await until(async () => (await read(jobs, jobId)).status === 'completed', 'answered and completed');
});

test('P3-6: a client\'s sub-job request under a used key with another task is IDEMPOTENCY_CONFLICT; the same task answers the same sub-job', async t => {
  const ctx = await fixture(t), { lead, helper } = ctx.agents;
  ctx.scope.push(lead.id, helper.id);
  const jobs = ctx.open(); await jobs.ready;
  await ctx.policy(jobs, { delegate: true });
  const { jobId: P } = await jobs.submit({ agentId: lead.id, input: { text: 'parent' }, networkId: ctx.network.id }, { requester: { kind: 'machine', id: CLI } });
  const first = await jobs.delegate(P, { agentId: helper.id, task: 'Check the totals.' }, { clientId: CLI, idempotencyKey: 'k1' });
  const again = await jobs.delegate(P, { agentId: helper.id, task: 'Check the totals.' }, { clientId: CLI, idempotencyKey: 'k1' });
  assert.deepEqual([again.jobId, again.deduplicated], [first.jobId, true]);
  for (const changed of [{ task: 'Summarise the risks instead.' }, { task: 'Check the totals.', tools: 'web' }, { task: 'Check the totals.', json: { strict: true } }]) {
    const error = await jobs.delegate(P, { agentId: helper.id, ...changed }, { clientId: CLI, idempotencyKey: 'k1' }).then(() => null, caught => caught);
    assert.deepEqual([error?.code, error?.status, error?.details?.jobId], ['IDEMPOTENCY_CONFLICT', 409, first.jobId], JSON.stringify(changed));
  }
  assert.equal((await jobs.read(P)).children.length, 1);
});

// ---- Schedules (fake clock and zone, no timers: the test calls tick()).
const local = (day, hours, minutes = 0) => new Date(2027, 0, day, hours, minutes).getTime();
async function schedulesFixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-network-review3-schedules-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const base = new Base({ store: new Store(dataDir) });
  await base.create({ id: 'lead', kind: 'profile', name: 'Lead', configuration: { agent: { provider: 'claude' } } });
  const clock = { at: local(14, 12), zone: 'Europe/Warsaw' }, made = [];
  const now = () => clock.at, zone = () => clock.zone;
  const registry = new NetworkRegistry({ dataDir, base, projects: async () => [], now });
  const lead = (await registry.registerAgent({ baseResourceId: 'lead', expectedRevision: (await registry.listAgents()).revision })).agent;
  const open = () => {
    const jobs = new NetworkJobs({ dataDir, registry, worker: null, now, prepareTimeoutMs: 600_000 });
    const pipelines = new NetworkPipelines({ dataDir, registry, now });
    const runs = new PipelineRunner({ dataDir, pipelines, jobs, now, pollMs: 5 });
    const schedules = new NetworkSchedules({ dataDir, jobs, runs, registry, now, zone, setTimer: () => null, clearTimer: () => {} });
    const instance = { jobs, runs, schedules, ready: Promise.all([jobs.start(), runs.start()]) };
    made.push(instance);
    return instance;
  };
  t.after(async () => { for (const { jobs, runs, schedules } of made) { schedules.stop(); await runs.close(); await jobs.close(); } });
  const create = async (schedules, name) => (await schedules.create({ expectedRevision: (await schedules.list()).revision, name, target: { agentId: lead.id, input: { text: 'Summarise yesterday.' } }, cadence: { kind: 'daily', time: '02:00' } })).schedule;
  const row = async (schedules, id) => (await schedules.list()).schedules.find(item => item.id === id);
  const confirm = async (schedules, id) => schedules.confirm(id, { expectedRevision: (await row(schedules, id)).revision, confirm: true });
  const scheduled = async (jobs, id) => (await jobs.list({ limit: 200 })).jobs.filter(job => job.requester.kind === 'schedule' && job.requester.id === id);
  return { clock, open, create, row, confirm, scheduled };
}

test('P3-4: a time that fires while the job engine shuts down is not used up; after the restart it runs exactly once', async t => {
  const ctx = await schedulesFixture(t);
  const first = ctx.open(); await first.ready;
  const made = await ctx.create(first.schedules, 'Morning digest');
  await ctx.confirm(first.schedules, made.id);
  ctx.clock.at = local(15, 2) + 30_000; // 02:00:30: the 02:00 time is due
  await first.jobs.close(); // the app is closing while the schedules tick is in flight
  await first.schedules.tick();
  const kept = await ctx.row(first.schedules, made.id);
  assert.deepEqual([kept.lastSlot, kept.lastSkip], [null, null], 'a refusal that means "try later" uses nothing up');
  const second = ctx.open(); await second.ready;
  ctx.clock.at = local(15, 2, 5);
  await second.schedules.tick();
  await second.schedules.tick();
  const jobs = await ctx.scheduled(second.jobs, made.id);
  assert.deepEqual(jobs.map(job => job.schedule), [{ id: made.id, slot: local(15, 2) }]);
  assert.equal((await ctx.row(second.schedules, made.id)).lastSlot, local(15, 2));
});

test('P3-4: a time due before the schedule was switched off and on again does not fire from a tick that read the older row', async t => {
  const ctx = await schedulesFixture(t);
  const app = ctx.open(); await app.ready;
  const a = await ctx.create(app.schedules, 'First'), b = await ctx.create(app.schedules, 'Second');
  await ctx.confirm(app.schedules, a.id);
  const { schedule: before } = await ctx.confirm(app.schedules, b.id);
  ctx.clock.at = local(15, 2) + 30_000;
  // The first schedule's submit waits, so the tick (which read both rows) is held between them.
  let release, entered; const gate = new Promise(resolve => { release = resolve; }), inside = new Promise(resolve => { entered = resolve; });
  const submit = app.jobs.submit.bind(app.jobs);
  app.jobs.submit = async (input, options) => { if (options?.requester?.id === a.id) { entered(); await gate; } return submit(input, options); };
  const ticking = app.schedules.tick();
  await inside;
  const off = app.schedules.update(b.id, { expectedRevision: before.revision, enabled: false });
  const on = app.schedules.confirm(b.id, { expectedRevision: before.revision + 1, confirm: true }); // confirmed at 02:00:30, after its 02:00 time
  release();
  await Promise.all([ticking, off, on]);
  assert.equal((await ctx.scheduled(app.jobs, a.id)).length, 1);
  assert.deepEqual(await ctx.scheduled(app.jobs, b.id), [], 'nothing before the new confirmation is caught up');
  assert.equal((await ctx.row(app.schedules, b.id)).lastSlot, null);
});
