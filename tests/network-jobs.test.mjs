// Network jobs (src/network/jobs.mjs, routes in src/network/http.mjs, wiring in src/server.mjs): durable submit with the
// accepted snapshot, the transition table, idempotency inside one requester, claims and leases, the FIFO pool and its
// ceiling, restarts after every transition, storage failures, cancel races, uncertain outcomes that wait for the owner,
// retention, sign-in waiting for jobs, shutdown, and no Kanban change. Real Base, Store and registry on temporary data
// folders; the only worker is the deterministic fake in tests/helpers/network-worker.mjs, so no process or CLI starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { Base } from '../src/base.mjs';
import { Board } from '../src/board.mjs';
import { git } from '../src/git.mjs';
import { Store } from '../src/store.mjs';
import { NetworkRegistry } from '../src/network/registry.mjs';
import { JOB_TRANSITIONS, NetworkJobs } from '../src/network/jobs.mjs';
import { startServer } from '../src/server.mjs';
import { fakeWorker } from './helpers/network-worker.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await tick()) { const value = await check(); if (value) return value; }
  assert.fail(`timed out: ${label}`);
}
const folderOf = id => `job__${id.slice(4)}`;

/** Base agents (Claude, Gemini, one without a provider), board projects p1 and p2, and a registration of each agent. */
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-network-jobs-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const base = new Base({ store: new Store(dataDir) });
  await base.create({ id: 'lead', kind: 'profile', name: 'Lead', configuration: { agent: { provider: 'claude', model: 'sonnet', instructions: 'Answer briefly.' } } });
  await base.create({ id: 'gem', kind: 'profile', name: 'Gem', configuration: { agent: { provider: 'gemini' } } });
  await base.create({ id: 'plain', kind: 'profile', name: 'Plain', configuration: { agent: {} } }); // No provider: nothing Network can run.
  const projects = ['p1', 'p2'];
  let clock = 1_800_000_000_000;
  const now = () => (clock += 1000);
  const registry = new NetworkRegistry({ dataDir, base, projects: async () => projects, now });
  const register = async (baseResourceId, extra = {}) => (await registry.registerAgent({ baseResourceId, expectedRevision: (await registry.listAgents()).revision, ...extra })).agent;
  const lead = await register('lead', { projectAllowlist: ['p1'] }), gem = await register('gem'), plain = await register('plain');
  const open = (extra = {}) => new NetworkJobs({ dataDir, registry, now, prepareTimeoutMs: 600_000, ...extra });
  const file = (...parts) => join(dataDir, 'network', ...parts);
  const disk = async id => JSON.parse(await readFile(file('jobs', folderOf(id), 'job.json'), 'utf8'));
  return { dataDir, base, registry, projects, lead, gem, plain, open, file, disk, advance: ms => { clock += ms; } };
}
const submit = (jobs, agentId, extra = {}) => jobs.submit({ agentId, input: { text: 'Summarise the release notes.' }, ...extra });
/** Memory and disk agree: the job the engine shows is the job.json on disk. */
async function agree(jobs, ctx, id) {
  const { job } = await jobs.read(id), saved = await ctx.disk(id);
  assert.deepEqual([job.revision, job.status, job.attempts], [saved.revision, saved.status, saved.attempts], 'memory equals disk');
  return job;
}
const statuses = job => job.history.map(entry => entry.status);

test('submit answers a durable queued job (never completed); without a worker it stays queued and says why; the fake worker completes it', async t => {
  const ctx = await fixture(t);
  const idle = ctx.open();
  const accepted = await submit(idle, ctx.lead.id);
  assert.deepEqual([accepted.status, accepted.deduplicated, accepted.job.status, accepted.job.outcome], ['queued', false, 'queued', null]);
  // Durable before the answer: both files exist, and the request's bytes hash to what job.json records.
  const requestText = await readFile(ctx.file('jobs', folderOf(accepted.jobId), 'request.json'), 'utf8'), saved = await ctx.disk(accepted.jobId);
  assert.deepEqual([saved.status, saved.requestSha256, saved.attempts], ['queued', sha(requestText), []]);
  assert.equal(accepted.job.waiting.for, 'worker');
  assert.match(accepted.job.waiting.message, /No job worker is available.*stays queued and nothing runs/);
  await idle.start(); await tick(50);
  assert.deepEqual([(await idle.read(accepted.jobId)).job.status, (await idle.read(accepted.jobId)).job.attempts.length], ['queued', 0], 'inert without a worker');

  const worker = fakeWorker(), jobs = ctx.open({ worker });
  await jobs.start();
  const done = await until(async () => { const { job } = await jobs.read(accepted.jobId); return job.status === 'completed' && job; }, 'completed');
  assert.deepEqual(statuses(done), ['queued', 'preparing', 'running', 'completed']);
  assert.deepEqual(done.history.map(entry => entry.by), ['owner', 'app', 'worker', 'worker']);
  const [attempt] = done.attempts;
  assert.deepEqual([attempt.status, attempt.number, attempt.workerInstance, attempt.pid, attempt.exitCode, attempt.provider, attempt.model, attempt.sideEffects], ['completed', 1, jobs.instance, 4242, 0, 'claude', 'sonnet', 'none']);
  assert.ok(attempt.claimedAt <= attempt.launchingAt && attempt.launchingAt <= attempt.spawnedAt && attempt.spawnedAt <= attempt.endedAt);
  const text = await readFile(ctx.file('jobs', folderOf(accepted.jobId), done.result.textRef), 'utf8');
  assert.deepEqual([text, done.result.chars, done.result.sha256, done.outcome], ['Report for: Summarise the release notes.', text.length, sha(text), 'completed']);
  assert.ok(!JSON.stringify(await jobs.read(accepted.jobId)).includes(worker.attempts.get(attempt.id).own.lease), 'the lease never appears in a view');
  assert.ok(!(await readFile(ctx.file('jobs', folderOf(accepted.jobId), 'job.json'), 'utf8')).includes(worker.attempts.get(attempt.id).own.lease), 'nor on disk');
});

test('the accepted request pins the agent and Base revision with default permissions; Base edits afterwards change nothing; secrets are masked', async t => {
  const ctx = await fixture(t), jobs = ctx.open();
  const { jobId } = await jobs.submit({ agentId: ctx.lead.id, input: { text: 'Use api_key=abcdef0123456789 to read it.', json: { token: 'sk-proj-4f9aZ2kQ8vW1xY7bN3mL6tR0', n: 1 } } });
  const path = ctx.file('jobs', folderOf(jobId), 'request.json'), before = await readFile(path, 'utf8'), { request, job } = await jobs.read(jobId);
  const resource = (await ctx.base.list()).resources.find(item => item.id === 'lead');
  assert.deepEqual(request.permissions, { filesystem: 'read_only', memory: 'agent', projectLessons: false });
  assert.deepEqual([request.tools, request.requireApproval, request.limits, request.instructions], ['none', false, { timeoutMs: 20 * 60_000, maxOutputBytes: 1024 * 1024 }, '']);
  const { manifest, ...agent } = request.agent;
  assert.deepEqual(agent, { registrationId: ctx.lead.id, registrationRevision: 1, baseResourceId: 'lead', baseKind: 'profile', baseRevisionRef: resource.revisionRef,
    primaryAgent: null, provider: 'claude', model: 'sonnet', effort: null });
  // Task 07: the Base manifest is pinned at acceptance with the revision references it delivers (tests/network-worker.test.mjs).
  assert.deepEqual([manifest.profiles.map(profile => profile.revisionRef), manifest.errors], [[resource.revisionRef], []]);
  assert.deepEqual([request.projectId, request.networkId, request.parentJobId, job.projectId, job.source, job.requester], [null, null, null, null, 'owner', { kind: 'owner', id: null }], 'no card, branch, repository or project is needed');
  assert.equal(request.input.text, 'Use api_key=[redacted] to read it.');
  assert.deepEqual(request.input.json, { token: '[redacted]', n: 1 });
  assert.ok(!before.includes('abcdef0123456789') && !before.includes('sk-proj-4f9aZ2kQ8vW1xY7bN3mL6tR0'));
  await ctx.base.update('lead', { configuration: { agent: { provider: 'codex', model: 'gpt-5' } } }, { expectedRevision: resource.revision, expectedBaseRevision: (await ctx.base.list()).revision });
  assert.equal(await readFile(path, 'utf8'), before, 'the snapshot is immutable');
  assert.deepEqual([(await jobs.read(jobId)).request.agent.provider, (await jobs.read(jobId)).request.agent.baseRevisionRef.revision], ['claude', 1]);
  // Explicit choices are kept exactly; a project needs the board, lessons need the registration's project list.
  const chosen = await jobs.submit({ agentId: ctx.lead.id, input: { text: 'x' }, tools: 'web', permissions: { memory: 'none', projectLessons: true }, limits: { timeoutMs: 90_000 }, projectId: 'p1', requireApproval: true });
  const { request: explicit } = await jobs.read(chosen.jobId);
  assert.deepEqual([chosen.status, explicit.tools, explicit.permissions, explicit.limits.timeoutMs, explicit.projectId], ['waiting_for_approval', 'web', { filesystem: 'read_only', memory: 'none', projectLessons: true }, 90_000, 'p1']);
  assert.equal(chosen.job.waiting.for, 'approval');
});

test('malformed or unrunnable submissions are refused with 400/409/413 and leave no job file', async t => {
  const ctx = await fixture(t), jobs = ctx.open();
  const cases = [
    [{ agentId: ctx.lead.id, input: { text: 'x' }, model: 'opus' }, 400, 'INVALID_INPUT'],
    [{ agentId: ctx.lead.id, input: { text: 'x', extra: 1 } }, 400, 'INVALID_INPUT'],
    [{ agentId: ctx.lead.id, input: 'just text' }, 400, 'INVALID_INPUT'],
    [{ agentId: ctx.lead.id, input: { text: '   ' } }, 400, 'INVALID_INPUT'],
    [{ agentId: ctx.lead.id, input: { text: 'é'.repeat(131073) } }, 413, 'NETWORK_LIMIT'],
    [{ agentId: ctx.lead.id, input: { text: 'x', json: { blob: 'y'.repeat(66000) } } }, 413, 'NETWORK_LIMIT'],
    [{ agentId: ctx.lead.id, input: { text: 'x', json: 'not an object' } }, 400, 'INVALID_INPUT'],
    [{ agentId: ctx.lead.id, input: { text: 'x' }, instructions: 'z'.repeat(33 * 1024) }, 413, 'NETWORK_LIMIT'],
    [{ agentId: 'agt_123', input: { text: 'x' } }, 400, 'INVALID_INPUT'],
    [{ agentId: '../../state', input: { text: 'x' } }, 400, 'INVALID_INPUT'],
    [{ agentId: `agt_${'0'.repeat(20)}`, input: { text: 'x' } }, 409, 'AGENT_NOT_FOUND'],
    [{ agentId: ctx.lead.id, input: { text: 'x' }, tools: 'shell' }, 400, 'INVALID_INPUT'],
    [{ agentId: ctx.lead.id, input: { text: 'x' }, permissions: { filesystem: 'workspace_write' } }, 400, 'EXECUTION_POLICY_UNSUPPORTED'],
    [{ agentId: ctx.lead.id, input: { text: 'x' }, permissions: { memory: 'everything' } }, 400, 'INVALID_INPUT'],
    [{ agentId: ctx.lead.id, input: { text: 'x' }, permissions: { memory: 'agent+network' } }, 400, 'INVALID_INPUT'],
    [{ agentId: ctx.lead.id, input: { text: 'x' }, permissions: { projectLessons: true } }, 400, 'INVALID_INPUT'],
    [{ agentId: ctx.lead.id, input: { text: 'x' }, limits: { timeoutMs: 121 * 60_000 } }, 400, 'INVALID_INPUT'],
    [{ agentId: ctx.lead.id, input: { text: 'x' }, limits: { timeoutMs: 1.5 } }, 400, 'INVALID_INPUT'],
    [{ agentId: ctx.lead.id, input: { text: 'x' }, requireApproval: 'yes' }, 400, 'INVALID_INPUT'],
    [{ agentId: ctx.lead.id, input: { text: 'x' }, idempotencyKey: 'a\nb' }, 400, 'INVALID_INPUT'],
    [{ agentId: ctx.lead.id, input: { text: 'x' }, idempotencyKey: 'k'.repeat(201) }, 400, 'INVALID_INPUT'],
    [{ agentId: ctx.lead.id, input: { text: 'x' }, projectId: 'gone' }, 409, 'PROJECT_NOT_FOUND'],
    [{ agentId: ctx.lead.id, input: { text: 'x' }, projectId: 'p2', permissions: { projectLessons: true } }, 409, 'PROJECT_NOT_ALLOWED'],
    [{ agentId: ctx.lead.id, input: { text: 'x' }, networkId: `net_${'0'.repeat(20)}` }, 409, 'NETWORK_NOT_FOUND'],
    [{ agentId: ctx.lead.id, input: { text: 'x' }, parentJobId: `job_${'0'.repeat(20)}` }, 409, 'JOB_NOT_FOUND'],
    [{ agentId: ctx.plain.id, input: { text: 'x' } }, 409, 'PROVIDER_UNSUPPORTED'],
    [{ agentId: ctx.gem.id, input: { text: 'x' }, tools: 'web' }, 409, 'TOOLS_UNSUPPORTED'],
  ];
  for (const [input, status, code] of cases) await assert.rejects(jobs.submit(input), error => error.status === status && error.code === code, JSON.stringify(input).slice(0, 120));
  await ctx.registry.updateAgent(ctx.gem.id, { expectedRevision: 1, enabled: false });
  await assert.rejects(submit(jobs, ctx.gem.id), { code: 'REGISTRATION_DISABLED', status: 409 });
  const lead = (await ctx.base.list()).resources.find(item => item.id === 'lead');
  await ctx.base.update('lead', { enabled: false }, { expectedRevision: lead.revision, expectedBaseRevision: (await ctx.base.list()).revision });
  await assert.rejects(submit(jobs, ctx.lead.id), error => error.code === 'REGISTRATION_STALE' && error.details.staleReason === 'disabled');
  await assert.rejects(jobs.submit(null), { code: 'INVALID_INPUT' });
  await assert.rejects(stat(ctx.file('jobs')), { code: 'ENOENT' }, 'no job folder was made');
  assert.equal((await jobs.list()).total, 0);
});

test('idempotency: the same key answers one job (sequential and concurrent, also after a restart); another body conflicts; other requesters never collide', async t => {
  const ctx = await fixture(t), jobs = ctx.open();
  const first = await submit(jobs, ctx.lead.id, { idempotencyKey: 'ui-click-1' });
  const again = await submit(jobs, ctx.lead.id, { idempotencyKey: 'ui-click-1' });
  assert.deepEqual([again.jobId, again.deduplicated, again.status], [first.jobId, true, 'queued']);
  const together = await Promise.all(Array.from({ length: 8 }, () => submit(jobs, ctx.lead.id, { idempotencyKey: 'burst' })));
  assert.equal(new Set(together.map(item => item.jobId)).size, 1);
  assert.equal(together.filter(item => !item.deduplicated).length, 1);
  await assert.rejects(submit(jobs, ctx.lead.id, { idempotencyKey: 'ui-click-1', input: { text: 'Something else.' } }), error => error.code === 'IDEMPOTENCY_CONFLICT' && error.status === 409 && error.details.jobId === first.jobId);
  const machine = await jobs.submit({ agentId: ctx.lead.id, input: { text: 'Summarise the release notes.' }, idempotencyKey: 'ui-click-1' }, { requester: { kind: 'machine', id: 'cli_aaaaaaaaaaaaaaaaaaaa' } });
  assert.notEqual(machine.jobId, first.jobId, 'a key is scoped by its requester');
  assert.deepEqual([machine.job.source, machine.job.requester], ['machine', { kind: 'machine', id: 'cli_aaaaaaaaaaaaaaaaaaaa' }]);
  const keyless = [await submit(jobs, ctx.lead.id), await submit(jobs, ctx.lead.id)];
  assert.notEqual(keyless[0].jobId, keyless[1].jobId, 'without a key every submit is a new job');
  const restarted = ctx.open();
  assert.deepEqual([(await submit(restarted, ctx.lead.id, { idempotencyKey: 'ui-click-1' })).jobId, (await restarted.list()).total], [first.jobId, 5]);
  assert.equal((await readdir(ctx.file('jobs'))).length, 5);
});

test('concurrent submits and claims: distinct jobs in FIFO order; one claim wins; forged, stale and ended ownerships change nothing', async t => {
  const ctx = await fixture(t), jobs = ctx.open();
  const submitted = await Promise.all(Array.from({ length: 20 }, (_, n) => jobs.submit({ agentId: ctx.lead.id, input: { text: `Job ${n}` } })));
  assert.equal(new Set(submitted.map(item => item.jobId)).size, 20);
  const queued = (await jobs.list({ status: 'queued', limit: 200 })).jobs.sort((a, b) => a.queuedAt - b.queuedAt);
  assert.equal(new Set(queued.map(job => job.queuedAt)).size, 20, 'FIFO stamps are distinct');
  assert.deepEqual(queued.map(job => job.waiting.position), Array.from({ length: 20 }, (_, n) => n + 1));
  const id = submitted[0].jobId;
  const claims = await Promise.all([jobs.claim(id), jobs.claim(id), jobs.claim(id)]);
  const [own] = claims.filter(Boolean);
  assert.equal(claims.filter(Boolean).length, 1, 'exactly one claim');
  let job = await agree(jobs, ctx, id);
  assert.deepEqual([job.status, job.attempts.length, job.currentAttemptId], ['preparing', 1, own.attemptId]);
  assert.equal(await jobs.claim(id), null, 'a preparing job cannot be claimed again');
  const revision = job.revision;
  const forged = { ...own, lease: 'x'.repeat(43) };
  assert.deepEqual(await jobs.finish(forged, { status: 'completed', result: { text: 'forged' } }), { applied: false, reason: 'JOB_OWNERSHIP_LOST' });
  await assert.rejects(jobs.launching(forged), { code: 'JOB_OWNERSHIP_LOST' });
  await assert.rejects(jobs.launching({ ...own, jobId: submitted[1].jobId }), { code: 'JOB_OWNERSHIP_LOST' });
  await assert.rejects(jobs.spawned(own, { pid: 7 }), { code: 'JOB_STATE' }, 'spawned before launching is refused');
  await assert.rejects(jobs.finish(own, { status: 'done' }), { code: 'INVALID_INPUT' });
  await assert.rejects(jobs.finish(own, { status: 'completed', bonus: true }), { code: 'INVALID_INPUT' });
  assert.equal((await agree(jobs, ctx, id)).revision, revision, 'nothing was written');
  // The attempt ends; its ownership then writes nothing, and after a retry an older attempt's report is ignored.
  await own.launching(); await own.spawned({ pid: 99 }); await own.finish({ status: 'unknown', reason: 'lost the stream' });
  await assert.rejects(own.launching(), { code: 'JOB_OWNERSHIP_LOST' });
  assert.equal((await own.finish({ status: 'completed', result: { text: 'late' } })).applied, false);
  job = (await jobs.retry(id, { expectedRevision: (await jobs.read(id)).job.revision, confirm: true, confirmUncertain: true })).job;
  const second = await jobs.claim(id);
  assert.deepEqual((await own.finish({ status: 'completed', result: { text: 'stale attempt' } })).applied, false);
  job = await agree(jobs, ctx, id);
  assert.deepEqual([job.status, job.attempts.length, job.currentAttemptId, job.attempts[0].status], ['preparing', 2, second.attemptId, 'unknown']);
  // The pump claims in FIFO order within the ceiling.
  const worker = fakeWorker({ mode: 'manual' }), pool = ctx.open({ worker });
  await pool.updateSettings({ expectedRevision: 0, maxConcurrentJobs: 1 });
  await pool.start();
  const started = [];
  for (let n = 0; n < 3; n++) { const entry = await until(() => [...worker.attempts.values()].find(item => !started.includes(item)), `start ${n}`); started.push(entry); entry.end(); }
  assert.deepEqual(started.map(entry => entry.own.jobId), submitted.slice(1, 4).map(item => item.jobId), 'FIFO');
});

test('the pool keeps to maxConcurrentJobs (1, 2, 4); the setting is checked, revisioned and survives a restart', async t => {
  const ctx = await fixture(t);
  for (const ceiling of [1, 2, 4]) {
    const worker = fakeWorker({ mode: 'manual' }), jobs = ctx.open({ worker });
    const { settings } = await jobs.settings();
    await jobs.updateSettings({ expectedRevision: settings.revision, maxConcurrentJobs: ceiling });
    await jobs.start();
    for (let n = 0; n < 6; n++) await submit(jobs, ctx.lead.id);
    await until(() => worker.attempts.size === ceiling, `${ceiling} running`);
    await tick(60);
    assert.deepEqual([worker.attempts.size, worker.active, jobs.activeCount()], [ceiling, ceiling, ceiling], `ceiling ${ceiling}`);
    // Each round ends the running attempts (without a result: never success) and the pool fills up again.
    await until(async () => { for (const entry of worker.attempts.values()) entry.end(); return worker.attempts.size === 6 && jobs.activeCount() === 0; }, 'all six ran');
    assert.equal(worker.maxActive, ceiling, `never more than ${ceiling} at once`);
    const { jobs: ended } = await jobs.list({ limit: 200 });
    assert.ok(ended.every(job => job.status === 'failed'), 'a worker that returned without a result never completes a job');
    await jobs.close();
  }
  const jobs = ctx.open();
  assert.equal((await jobs.settings()).settings.maxConcurrentJobs, 4);
  await assert.rejects(jobs.updateSettings({ expectedRevision: 3, maxConcurrentJobs: 5 }), { code: 'INVALID_INPUT' });
  await assert.rejects(jobs.updateSettings({ expectedRevision: 3, maxConcurrentJobs: 0 }), { code: 'INVALID_INPUT' });
  await assert.rejects(jobs.updateSettings({ expectedRevision: 3, defaultTimeoutMs: 121 * 60_000 }), { code: 'INVALID_INPUT' });
  await assert.rejects(jobs.updateSettings({ expectedRevision: 2, maxConcurrentJobs: 3 }), { code: 'REVISION_CONFLICT' });
  await assert.rejects(jobs.updateSettings({ maxConcurrentJobs: 3 }), { code: 'REVISION_REQUIRED' });
  await assert.rejects(jobs.updateSettings({ expectedRevision: 3, colour: 'red' }), { code: 'INVALID_INPUT' });
  const { settings } = await jobs.updateSettings({ expectedRevision: 3, defaultTimeoutMs: 5 * 60_000, outputRetentionDays: 7 });
  assert.deepEqual(settings, { revision: 4, maxConcurrentJobs: 4, defaultTimeoutMs: 300_000, outputRetentionDays: 7 });
  assert.equal((await ctx.open().settings()).settings.revision, 4);
  assert.equal((await jobs.read((await submit(jobs, ctx.lead.id)).jobId)).request.limits.timeoutMs, 300_000, 'new jobs take the default');
});

test('a restart after every transition keeps the exact state; nothing that may have started runs again; queued jobs wait for a claim', async t => {
  const ctx = await fixture(t);
  let jobs = ctx.open();
  const restart = async (extra = {}) => { jobs = ctx.open(extra); await jobs.start(); return jobs; };
  const state = async id => { const { job } = await jobs.read(id); return [job.status, job.outcome, job.errorCode, job.attempts.map(item => item.status)]; };
  const queuedJob = (await submit(jobs, ctx.lead.id)).jobId, approval = (await submit(jobs, ctx.lead.id, { requireApproval: true })).jobId;
  await restart();
  assert.deepEqual([await state(queuedJob), await state(approval)], [['queued', null, null, []], ['waiting_for_approval', null, null, []]]);
  await jobs.approve(approval, { expectedRevision: 1, decision: 'approve' });
  await restart();
  assert.deepEqual(await state(approval), ['queued', null, null, []]);
  // Claimed, not launched: interrupted, nothing ran.
  await jobs.claim(queuedJob);
  await restart();
  assert.deepEqual(await state(queuedJob), ['interrupted', 'not_started', 'APP_RESTARTED', ['interrupted']]);
  assert.match((await jobs.read(queuedJob)).job.waiting.message, /Nothing ran/);
  await assert.rejects(jobs.retry(queuedJob, { expectedRevision: (await jobs.read(queuedJob)).job.revision }), { code: 'CONFIRMATION_REQUIRED' });
  await jobs.retry(queuedJob, { expectedRevision: (await jobs.read(queuedJob)).job.revision, confirm: true });
  await restart();
  assert.deepEqual(await state(queuedJob), ['queued', null, null, ['interrupted']]);
  // Launching recorded: the process may have started, so the outcome is uncertain.
  let own = await jobs.claim(queuedJob); await own.launching();
  await restart();
  assert.deepEqual(await state(queuedJob), ['interrupted', 'uncertain', 'APP_RESTARTED', ['interrupted', 'interrupted']]);
  await assert.rejects(jobs.retry(queuedJob, { expectedRevision: (await jobs.read(queuedJob)).job.revision, confirm: true }), { code: 'UNCERTAIN_CONFIRMATION_REQUIRED' });
  await jobs.retry(queuedJob, { expectedRevision: (await jobs.read(queuedJob)).job.revision, confirm: true, confirmUncertain: true });
  // Running with a pid: uncertain, and the view says the process may still run.
  own = await jobs.claim(queuedJob); await own.launching(); await own.spawned({ pid: 31337 });
  await restart();
  assert.deepEqual(await state(queuedJob), ['interrupted', 'uncertain', 'APP_RESTARTED', ['interrupted', 'interrupted', 'interrupted']]);
  assert.match((await jobs.read(queuedJob)).job.reason, /process 31337 may still be running/);
  // A worker after a restart claims only queued jobs (the approved one), never an interrupted one.
  const worker = fakeWorker();
  await restart({ worker });
  await until(async () => (await jobs.read(approval)).job.status === 'completed', 'approved job completes');
  assert.deepEqual([worker.starts.length, (await state(queuedJob))[0], (await jobs.read(queuedJob)).job.attempts.length], [1, 'interrupted', 3]);
  await restart();
  assert.deepEqual(await state(approval), ['completed', 'completed', null, ['completed']]);
  // Unknown, cancelled and closed (failed) stay what they were.
  await jobs.retry(queuedJob, { expectedRevision: (await jobs.read(queuedJob)).job.revision, confirm: true, confirmUncertain: true });
  own = await jobs.claim(queuedJob); await own.launching(); await own.spawned({ pid: 5 }); await own.finish({ status: 'unknown', reason: 'no final event' });
  await restart();
  assert.deepEqual(await state(queuedJob), ['unknown', 'uncertain', null, ['interrupted', 'interrupted', 'interrupted', 'unknown']]);
  await jobs.closeJob(queuedJob, { expectedRevision: (await jobs.read(queuedJob)).job.revision });
  const cancelled = (await submit(jobs, ctx.lead.id)).jobId;
  await jobs.cancel(cancelled);
  await restart({ worker: fakeWorker() });
  await tick(50);
  assert.deepEqual([await state(queuedJob), await state(cancelled)], [['failed', 'uncertain', 'CLOSED_BY_OWNER', ['interrupted', 'interrupted', 'interrupted', 'unknown']], ['cancelled', 'cancelled', null, []]]);
  assert.deepEqual(statuses((await jobs.read(queuedJob)).job), ['queued', 'preparing', 'interrupted', 'queued', 'preparing', 'interrupted', 'queued', 'preparing', 'running', 'interrupted', 'queued', 'preparing', 'running', 'unknown', 'failed']);
});

test('a job.json read from its backup never runs again by itself; damaged, newer and tampered files are refused, not repaired', async t => {
  const ctx = await fixture(t), jobs = ctx.open();
  const restored = (await submit(jobs, ctx.lead.id)).jobId, damaged = (await submit(jobs, ctx.lead.id)).jobId, newer = (await submit(jobs, ctx.lead.id)).jobId, tampered = (await submit(jobs, ctx.lead.id)).jobId;
  await jobs.cancel(restored).catch(() => {}); // Rewrites job.json, so the backup holds the queued copy.
  const path = id => ctx.file('jobs', folderOf(id), 'job.json');
  await writeFile(path(restored), '{"schema": broken');
  await writeFile(path(damaged), 'nope'); await writeFile(`${path(damaged)}.bak`, 'nope either');
  const newerText = JSON.stringify({ ...(await ctx.disk(newer)), version: 2 });
  await writeFile(path(newer), newerText); await rm(`${path(newer)}.bak`, { force: true });
  await writeFile(ctx.file('jobs', folderOf(tampered), 'request.json'), (await readFile(ctx.file('jobs', folderOf(tampered), 'request.json'), 'utf8')).replace('Summarise', 'Delete'));
  const worker = fakeWorker(), again = ctx.open({ worker });
  await again.start();
  const { job } = await again.read(restored);
  assert.deepEqual([job.status, job.outcome, job.errorCode], ['interrupted', 'uncertain', 'RESTORED_FROM_BACKUP'], 'the queued backup copy may be older than what ran');
  assert.ok((await readdir(ctx.file('jobs', folderOf(restored)))).some(name => name.startsWith('job.json.corrupt-')), 'the damaged copy is set aside');
  await assert.rejects(again.read(damaged), { code: 'NETWORK_DATA_DAMAGED', status: 409 });
  await assert.rejects(again.read(newer), { code: 'NETWORK_VERSION_UNSUPPORTED', status: 409 });
  assert.equal(await readFile(path(newer), 'utf8'), newerText, 'a newer file is never rewritten');
  assert.deepEqual((await again.list()).unavailable.map(item => item.code).sort(), ['NETWORK_DATA_DAMAGED', 'NETWORK_VERSION_UNSUPPORTED']);
  const failed = await until(async () => { const { job } = await again.read(tampered); return job.status === 'failed' && job; }, 'tampered request fails at claim');
  assert.deepEqual([failed.errorCode, failed.attempts.length, worker.starts.length, (await again.read(tampered)).requestError], ['REQUEST_INVALID', 0, 0, 'REQUEST_INVALID']);
  await assert.rejects(again.cancel(damaged), { code: 'NETWORK_DATA_DAMAGED' });
});

test('storage failures at submit, claim, launch, spawn and finish report NETWORK_WRITE_FAILED; memory equals disk; an unrecorded process is stopped', async t => {
  const ctx = await fixture(t), jobs = ctx.open(), worker = fakeWorker({ mode: 'manual' });
  await jobs.list(); // Loaded: the failures below hit writes only.
  // Submit: the jobs folder cannot be made. Nothing is listed and no job folder stays.
  await writeFile(ctx.file('jobs'), 'blocks the folder');
  await assert.rejects(submit(jobs, ctx.lead.id, { idempotencyKey: 'k' }), { code: 'NETWORK_WRITE_FAILED', status: 500 });
  assert.equal((await jobs.list()).total, 0);
  await rm(ctx.file('jobs'));
  const { jobId } = await submit(jobs, ctx.lead.id, { idempotencyKey: 'k' });
  assert.equal((await jobs.list()).total, 1, 'the key was not taken by the failed submit');
  // The next job.json write fails: its backup name is taken by a folder (writeAtomic keeps the old file, throws).
  const backup = id => ctx.file('jobs', folderOf(id), 'job.json.bak');
  const block = async (id = jobId) => { await rm(backup(id), { recursive: true, force: true }); await mkdir(backup(id)); };
  const unblock = (id = jobId) => rm(backup(id), { recursive: true, force: true });
  await block();
  await assert.rejects(jobs.claim(jobId), { code: 'NETWORK_WRITE_FAILED' });
  assert.deepEqual((await agree(jobs, ctx, jobId)).status, 'queued');
  await unblock();
  let own = await jobs.claim(jobId);
  await block();
  await assert.rejects(own.launching(), { code: 'NETWORK_WRITE_FAILED' });
  let job = await agree(jobs, ctx, jobId);
  assert.deepEqual([job.status, job.attempts[0].launchingAt], ['preparing', null], 'not launched: the worker must not start a process');
  await unblock();
  await jobs.cancel(jobId);
  // Spawn: the process exists but cannot be recorded, so the engine stops it.
  const jobs2 = ctx.open({ worker });
  const second = (await submit(jobs2, ctx.lead.id)).jobId;
  own = await jobs2.claim(second); await own.launching();
  worker.attempts.set(own.attemptId, { own, process: 'running', killed: false, end: () => {} });
  await block(second);
  await assert.rejects(own.spawned({ pid: 77 }), { code: 'NETWORK_WRITE_FAILED' });
  assert.deepEqual([worker.attempts.get(own.attemptId).killed, worker.cancels.includes(own.attemptId)], [true, true], 'the unrecorded process was stopped');
  job = await agree(jobs2, ctx, second);
  assert.deepEqual([job.status, job.attempts[0].status, job.attempts[0].pid], ['preparing', 'launching', null]);
  // Finish: the report cannot be saved; the job keeps its last saved state, and once storage works the open attempt ends
  // as unknown (it ran), never completed.
  await unblock(second);
  await jobs2.cancel(second);
  const third = (await submit(jobs2, ctx.lead.id)).jobId;
  const pending = worker.next();
  await jobs2.start();
  const entry = await pending;
  await entry.own.launching(); await entry.own.spawned({ pid: 78 });
  await block(third);
  await assert.rejects(entry.own.finish({ status: 'completed', exitCode: 0, result: { text: 'All done.' } }), { code: 'NETWORK_WRITE_FAILED' });
  job = await agree(jobs2, ctx, third);
  assert.deepEqual([job.status, job.result], ['running', null]);
  await unblock(third);
  entry.end();
  job = await until(async () => { const { job } = await jobs2.read(third); return job.status === 'unknown' && job; }, 'unknown after the lost finish');
  assert.deepEqual([job.outcome, job.errorCode], ['uncertain', 'NO_RESULT']);
  await agree(jobs2, ctx, third);
});

test('cancel races: queued, preparing and running jobs; completion saved first wins; a result after the cancel is kept only as late-result.md', async t => {
  const ctx = await fixture(t), worker = fakeWorker({ mode: 'manual', endOnCancel: false }), jobs = ctx.open({ worker });
  const queued = (await submit(jobs, ctx.lead.id)).jobId; // Not started yet: the pool claims nothing before start().
  assert.deepEqual([(await jobs.cancel(queued)).cancelled, (await jobs.read(queued)).job.status, (await jobs.read(queued)).job.attempts], [true, 'cancelled', []]);
  await assert.rejects(jobs.cancel(queued), { code: 'JOB_FINISHED', status: 409 });
  await assert.rejects(jobs.cancel(queued, { force: true }), { code: 'INVALID_INPUT' });
  await jobs.start();
  await tick(30);
  assert.equal(worker.starts.length, 0, 'a cancelled job is never claimed');
  // Preparing: stopped before it launched; launching afterwards is refused.
  let next = worker.next();
  const preparing = (await submit(jobs, ctx.lead.id)).jobId;
  let entry = await next;
  const cancelled = await jobs.cancel(preparing);
  assert.deepEqual([cancelled.cancelled, cancelled.job.status, cancelled.job.outcome, cancelled.job.attempts[0].status], [true, 'cancelled', 'cancelled', 'cancelled']);
  assert.ok(worker.cancels.includes(entry.own.attemptId) && entry.own.signal.aborted);
  await assert.rejects(entry.own.launching(), { code: 'JOB_OWNERSHIP_LOST' });
  entry.end();
  // Running: cancelled first, then the worker's result arrives: the status stays cancelled, the text is kept aside.
  next = worker.next();
  const running = (await submit(jobs, ctx.lead.id)).jobId;
  entry = await next;
  await entry.own.launching(); await entry.own.spawned({ pid: 11 }); entry.process = 'running';
  assert.deepEqual([(await jobs.read(running)).job.live, (await jobs.read(queued)).job.live], [{ process: 'running' }, null], 'the worker reports its process');
  await jobs.cancel(running);
  assert.equal(worker.attempts.get(entry.own.attemptId).killed, true);
  const late = await entry.own.finish({ status: 'completed', exitCode: 0, result: { text: 'Finished anyway.' } });
  assert.deepEqual([late.applied, late.lateResult, late.job.status, late.job.result], [false, true, 'cancelled', null]);
  const folder = ctx.file('jobs', folderOf(running), 'attempts', `att__${entry.own.attemptId.slice(4)}`);
  assert.deepEqual((await readdir(folder)).sort(), ['late-result.md']);
  assert.equal(await readFile(join(folder, 'late-result.md'), 'utf8'), 'Finished anyway.');
  assert.equal(late.job.attempts[0].lateResult.chars, 16);
  entry.end();
  assert.equal((await entry.own.finish({ status: 'completed', result: { text: 'Again.' } })).applied, false);
  // At the same moment, two orders. The completion is queued before the cancel looks: the cancel finds it ended.
  next = worker.next();
  const first = (await submit(jobs, ctx.lead.id)).jobId;
  entry = await next;
  await entry.own.launching(); await entry.own.spawned({ pid: 12 });
  const [finished, refused] = await Promise.allSettled([entry.own.finish({ status: 'completed', exitCode: 0, result: { text: 'Done first.' } }), jobs.cancel(first)]);
  assert.deepEqual([finished.value.applied, refused.reason.code, (await agree(jobs, ctx, first)).status], [true, 'JOB_FINISHED', 'completed']);
  entry.end();
  // The cancel has looked and is stopping the worker when the worker's completion arrives: saved first, so it stands.
  next = worker.next();
  const racing = (await submit(jobs, ctx.lead.id)).jobId;
  entry = await next;
  await entry.own.launching(); await entry.own.spawned({ pid: 13 });
  const stop = worker.cancel;
  worker.cancel = async own => { await own.finish({ status: 'completed', exitCode: 0, result: { text: 'Done while stopping.' } }); return stop(own); };
  const cancel = await jobs.cancel(racing);
  worker.cancel = stop;
  assert.deepEqual([cancel.cancelled, cancel.job.status, cancel.job.result.chars, (await agree(jobs, ctx, racing)).status], [false, 'completed', 20, 'completed']);
  await assert.rejects(jobs.cancel(racing), { code: 'JOB_FINISHED' });
  entry.end();
  // Waiting for approval: cancel (or reject) ends it without any attempt.
  const waiting = (await submit(jobs, ctx.lead.id, { requireApproval: true })).jobId;
  assert.deepEqual([(await jobs.cancel(waiting)).job.status, (await jobs.read(waiting)).job.attempts], ['cancelled', []]);
});

test('uncertain side effects stay unknown or interrupted until the owner decides; nothing is replayed by itself', async t => {
  const ctx = await fixture(t), worker = fakeWorker({ mode: 'manual' }), jobs = ctx.open({ worker });
  await jobs.start();
  let next = worker.next();
  const id = (await submit(jobs, ctx.lead.id, { tools: 'web' })).jobId;
  let entry = await next;
  await entry.own.launching(); await entry.own.spawned({ pid: 21 });
  // "Completed" without result text is not a receipt: unknown.
  await entry.own.finish({ status: 'completed', exitCode: 0, result: { text: '  ' } });
  let job = (await jobs.read(id)).job;
  assert.deepEqual([job.status, job.outcome, job.errorCode, job.attempts[0].sideEffects], ['unknown', 'uncertain', 'NO_RESULT', 'read_only_web']);
  entry.end();
  await tick(50);
  const restarted = ctx.open({ worker: fakeWorker() });
  await restarted.start(); await tick(50);
  job = (await restarted.read(id)).job;
  assert.deepEqual([job.status, job.attempts.length], ['unknown', 1], 'no implicit replay after a restart');
  await assert.rejects(restarted.retry(id, { expectedRevision: job.revision, confirm: true }), { code: 'UNCERTAIN_CONFIRMATION_REQUIRED' });
  await assert.rejects(restarted.retry(id, { expectedRevision: job.revision - 1, confirm: true, confirmUncertain: true }), { code: 'REVISION_CONFLICT' });
  await assert.rejects(restarted.closeJob(id, {}), { code: 'REVISION_REQUIRED' });
  await assert.rejects(restarted.cancel(id), { code: 'JOB_STATE' });
  // A worker that returns after launching without any report: unknown. Before launching: failed, nothing ran.
  next = worker.next();
  const silent = (await submit(jobs, ctx.lead.id)).jobId;
  entry = await next;
  await entry.own.launching();
  entry.end();
  job = await until(async () => { const { job } = await jobs.read(silent); return job.status !== 'preparing' && job; }, 'silent worker settles');
  assert.deepEqual([job.status, job.outcome, job.errorCode], ['unknown', 'uncertain', 'NO_RESULT']);
  next = worker.next();
  const quiet = (await submit(jobs, ctx.lead.id)).jobId;
  (await next).end();
  job = await until(async () => { const { job } = await jobs.read(quiet); return job.status !== 'preparing' && job; }, 'quiet worker settles');
  assert.deepEqual([job.status, job.outcome, job.errorCode], ['failed', 'failed', 'WORKER_ENDED']);
  // A report of success from an attempt that never ran is a failure; "unknown" before launch is too.
  const direct = ctx.open();
  const early = (await submit(direct, ctx.lead.id)).jobId, own = await direct.claim(early);
  await own.finish({ status: 'unknown' });
  assert.deepEqual([(await direct.read(early)).job.status, (await direct.read(early)).job.outcome], ['failed', 'failed']);
  // The transition table never lets a terminal job move, nor a queued job complete without running.
  assert.deepEqual([JOB_TRANSITIONS.completed, JOB_TRANSITIONS.failed, JOB_TRANSITIONS.cancelled, JOB_TRANSITIONS.queued.includes('completed')], [[], [], [], false]);
});

test('claim-time checks fail a job without a process; a worker can refuse; preparation and run time limits stop the attempt', async t => {
  const ctx = await fixture(t);
  const refusing = fakeWorker({ refuse: Object.assign(new Error('The Codex CLI is not installed.'), { code: 'CLI_MISSING' }) }), jobs = ctx.open({ worker: refusing });
  const refused = (await submit(jobs, ctx.lead.id)).jobId;
  await jobs.start();
  let job = await until(async () => { const { job } = await jobs.read(refused); return job.status === 'failed' && job; }, 'refused');
  assert.deepEqual([job.errorCode, job.attempts[0].status, job.attempts[0].launchingAt, refusing.starts.length, job.reason], ['CLI_MISSING', 'failed', null, 0, 'The Codex CLI is not installed.']);
  await jobs.close();
  // The registration is switched off after the job was accepted: it fails at claim, the worker never hears of it.
  // The project is removed from the board after acceptance: the same.
  const idle = ctx.open(), off = (await submit(idle, ctx.gem.id)).jobId, gone = (await submit(idle, ctx.lead.id, { projectId: 'p2' })).jobId;
  await ctx.registry.updateAgent(ctx.gem.id, { expectedRevision: 1, enabled: false });
  ctx.projects.splice(ctx.projects.indexOf('p2'), 1);
  const worker = fakeWorker(), checking = ctx.open({ worker });
  await checking.start();
  job = await until(async () => { const { job } = await checking.read(off); return job.status === 'failed' && job; }, 'disabled at claim');
  const projectless = await until(async () => { const { job } = await checking.read(gone); return job.status === 'failed' && job; }, 'project gone at claim');
  assert.deepEqual([job.errorCode, job.attempts, projectless.errorCode, projectless.attempts, worker.claims], ['REGISTRATION_DISABLED', [], 'PROJECT_NOT_FOUND', [], []]);
  await checking.close();
  // Preparation limit and run time limit.
  const slow = fakeWorker({ mode: 'manual' }), timed = ctx.open({ worker: slow, prepareTimeoutMs: 80 });
  await timed.start();
  let next = slow.next();
  const stuck = (await submit(timed, ctx.lead.id)).jobId;
  let entry = await next;
  job = await until(async () => { const { job } = await timed.read(stuck); return job.status === 'failed' && job; }, 'preparation limit');
  assert.deepEqual([job.errorCode, slow.cancels.includes(entry.own.attemptId), entry.own.signal.aborted], ['PREPARE_TIMEOUT', true, true]);
  next = slow.next();
  const long = (await submit(timed, ctx.lead.id, { limits: { timeoutMs: 1000 } })).jobId;
  entry = await next;
  await entry.own.launching(); await entry.own.spawned({ pid: 31 }); entry.process = 'running';
  job = await until(async () => { const { job } = await timed.read(long); return job.status === 'failed' && job; }, 'run time limit', 6000);
  assert.deepEqual([job.errorCode, job.attempts[0].status, entry.killed], ['TIMEOUT', 'failed', true]);
  assert.match(job.reason, /1-second limit/);
});

test('retention removes only old outputs of finished jobs whose parent is closed; delete is for finished jobs nothing open names', async t => {
  const ctx = await fixture(t), jobs = ctx.open();
  const finished = async extra => {
    const { jobId } = await submit(jobs, ctx.lead.id, extra), own = await jobs.claim(jobId);
    await own.launching(); await own.spawned({ pid: 3 }); await own.finish({ status: 'completed', exitCode: 0, result: { text: `Result of ${jobId}` } });
    const folder = ctx.file('jobs', folderOf(jobId), 'attempts', `att__${own.attemptId.slice(4)}`);
    await writeFile(join(folder, 'stream.jsonl'), '{}\n'); await writeFile(join(folder, 'output.log'), 'log');
    return { jobId, folder };
  };
  const parent = (await submit(jobs, ctx.lead.id)).jobId;
  const old = await finished(), child = await finished({ parentJobId: parent });
  ctx.advance(31 * 86_400_000);
  const recent = await finished();
  const swept = ctx.open();
  await swept.start();
  assert.deepEqual((await readdir(old.folder)).sort(), ['result.md'], 'old logs removed, the result kept');
  assert.deepEqual((await readdir(child.folder)).sort(), ['output.log', 'result.md', 'stream.jsonl'], 'its parent job is still open');
  assert.deepEqual((await readdir(recent.folder)).sort(), ['output.log', 'result.md', 'stream.jsonl'], 'recent outputs stay');
  assert.ok((await swept.read(old.jobId)).job.outputsRemovedAt);
  assert.ok((await stat(ctx.file('jobs', folderOf(old.jobId), 'request.json'))).isFile());
  // Delete: finished only, under its revision, never while an open job names it as parent.
  await assert.rejects(swept.remove(parent, { expectedRevision: 1 }), { code: 'JOB_STATE' });
  const parentDone = await swept.cancel(parent);
  const childJob = (await submit(swept, ctx.lead.id, { parentJobId: parent, idempotencyKey: 'child' })).jobId;
  await assert.rejects(swept.remove(parent, { expectedRevision: parentDone.job.revision }), error => error.code === 'JOB_IN_USE' && error.details.jobIds.includes(childJob));
  await swept.cancel(childJob);
  await assert.rejects(swept.remove(parent, { expectedRevision: 1 }), { code: 'REVISION_CONFLICT' });
  assert.deepEqual(await swept.remove(parent, { expectedRevision: parentDone.job.revision }), { deleted: parent });
  await assert.rejects(stat(ctx.file('jobs', folderOf(parent))), { code: 'ENOENT' });
  assert.ok(!(await readdir(ctx.file('jobs'))).some(name => name.includes(parent.slice(4))), 'nothing of it is left');
  await assert.rejects(swept.read(parent), { code: 'NOT_FOUND', status: 404 });
  const { revision } = (await swept.read(childJob)).job;
  await swept.remove(childJob, { expectedRevision: revision });
  assert.notEqual((await submit(swept, ctx.lead.id, { parentJobId: old.jobId, idempotencyKey: 'child' })).jobId, childJob, 'a deleted job frees its key');
  assert.equal((await ctx.open().list({ limit: 200 })).total, 4);
});

// ---- Over HTTP, through the real server ----

function request(port, path, { method = 'GET', headers = {}, body, raw } = {}) {
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { Host: `127.0.0.1:${port}`, ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, json, text }); });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
/** An install with a board project and Base agents saved before Network; Network registers the lead. */
async function app(t, options = {}, dataDir = null) {
  if (!dataDir) {
    dataDir = await mkdtemp(join(tmpdir(), 'pb-network-jobs-http-'));
    t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    const board = new Board({ dataDir });
    await board.createProject({ name: 'Site' });
    await board.base.create({ id: 'lead', kind: 'profile', name: 'Lead', configuration: { agent: { provider: 'claude', model: 'sonnet' } } });
  }
  const started = await startServer({ port: 0, dataDir, executor: null, catalogReader: async provider => ({ provider, source: 'test fixture', models: [] }), networkWorker: null, ...options });
  t.after(() => started.close());
  const port = Number(new URL(started.url).port), token = (await (await fetch(`${started.url}/api/session`)).json()).token;
  const call = (path, method = 'GET', body) => request(port, path, { method, body, headers: { 'X-STE-Token': token } });
  return { dataDir, app: started, port, token, call };
}
const ok = async (pending, label, status = 200) => { const response = await pending; assert.equal(response.status, status, `${label}: ${response.text.slice(0, 300)}`); return response.json; };
async function registerLead(call) {
  const { revision } = await ok(call('/api/network/agents'), 'agents');
  return (await ok(call('/api/network/agents', 'POST', { baseResourceId: 'lead', expectedRevision: revision }), 'register')).agent;
}

test('job routes over HTTP: token checks, 202 queued with the reason, bounded bodies, every action, settings, a repeated POST and a lost answer make one job', async t => {
  const { port, token, call, dataDir } = await app(t);
  const lead = await registerLead(call);
  assert.equal((await request(port, '/api/network/jobs')).status, 403, 'no token');
  assert.equal((await request(port, '/api/network/jobs', { method: 'POST', headers: { 'X-STE-Token': token, Origin: 'http://evil.example' }, body: {} })).status, 403);
  const body = { agentId: lead.id, input: { text: 'Collect the open questions.' }, idempotencyKey: 'click-1' };
  const accepted = await ok(call('/api/network/jobs', 'POST', body), 'submit', 202);
  assert.deepEqual([accepted.status, accepted.deduplicated, accepted.job.waiting.for], ['queued', false, 'worker']);
  const repeated = await ok(call('/api/network/jobs', 'POST', body), 'repeat');
  assert.deepEqual([repeated.jobId, repeated.deduplicated], [accepted.jobId, true]);
  assert.deepEqual([(await call('/api/network/jobs', 'POST', { ...body, input: { text: 'Other.' } })).json.code], ['IDEMPOTENCY_CONFLICT']);
  // A lost answer: the request arrives, the client never reads the reply, then sends it again.
  await new Promise(resolve => {
    const payload = JSON.stringify({ ...body, idempotencyKey: 'lost-answer' });
    const req = http.request({ host: '127.0.0.1', port, path: '/api/network/jobs', method: 'POST', headers: { Host: `127.0.0.1:${port}`, 'X-STE-Token': token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } });
    // A reply that arrives before the socket is destroyed is never read; its reset is expected (unhandled, it failed this
    // test under load: Task 07 review).
    req.on('error', () => resolve()); req.on('close', resolve); req.on('response', res => res.on('error', () => {}));
    req.end(payload, () => setTimeout(() => req.destroy(), 30));
  });
  const retried = (await call('/api/network/jobs', 'POST', { ...body, idempotencyKey: 'lost-answer' })).json;
  const list = await ok(call('/api/network/jobs?limit=200'), 'list');
  assert.equal(list.jobs.filter(job => job.idempotencyKey === 'lost-answer').length, 1, 'one job for the lost answer and its retry');
  assert.equal(retried.jobId, list.jobs.find(job => job.idempotencyKey === 'lost-answer').id);
  assert.deepEqual([list.total, list.worker], [2, false]);
  assert.equal((await call('/api/network/jobs', 'POST', { agentId: lead.id, input: { text: 'x'.repeat(1100 * 1024) } })).status, 413);
  assert.equal((await call('/api/network/jobs', 'POST', { agentId: lead.id, input: { text: 'x'.repeat(300 * 1024) } })).json.code, 'NETWORK_LIMIT');
  assert.equal((await request(port, '/api/network/jobs', { method: 'POST', headers: { 'X-STE-Token': token }, raw: '{nope' })).status, 400);
  assert.deepEqual([(await call(`/api/network/jobs/job_${'0'.repeat(20)}`)).status, (await call('/api/network/jobs/job_1')).status, (await call(`/api/network/jobs/${accepted.jobId}/run`, 'POST', {})).status], [404, 404, 404]);
  assert.equal((await call('/api/network/jobs?status=done')).status, 400);
  const detail = await ok(call(`/api/network/jobs/${accepted.jobId}`), 'detail');
  assert.deepEqual([detail.job.id, detail.request.input.text, detail.children], [accepted.jobId, 'Collect the open questions.', []]);
  // Approve, reject, cancel, retry, close and delete.
  const approval = (await ok(call('/api/network/jobs', 'POST', { agentId: lead.id, input: { text: 'Needs a yes.' }, requireApproval: true }), 'approval job', 202)).jobId;
  assert.equal((await call(`/api/network/jobs/${approval}/approve`, 'POST', { expectedRevision: 9, decision: 'approve' })).json.code, 'REVISION_CONFLICT');
  assert.equal((await call(`/api/network/jobs/${approval}/approve`, 'POST', { expectedRevision: 1, decision: 'maybe' })).json.code, 'INVALID_INPUT');
  assert.equal((await ok(call(`/api/network/jobs/${approval}/approve`, 'POST', { expectedRevision: 1, decision: 'reject' }), 'reject')).job.status, 'cancelled');
  const cancelled = await ok(call(`/api/network/jobs/${accepted.jobId}/cancel`, 'POST', {}), 'cancel');
  assert.deepEqual([cancelled.cancelled, cancelled.job.status], [true, 'cancelled']);
  assert.equal((await call(`/api/network/jobs/${accepted.jobId}/retry`, 'POST', { expectedRevision: cancelled.job.revision, confirm: true })).json.code, 'JOB_STATE');
  assert.equal((await call(`/api/network/jobs/${accepted.jobId}/close`, 'POST', { expectedRevision: cancelled.job.revision })).json.code, 'JOB_STATE');
  assert.deepEqual(await ok(call(`/api/network/jobs/${accepted.jobId}`, 'DELETE', { expectedRevision: cancelled.job.revision }), 'delete'), { deleted: accepted.jobId });
  const settings = await ok(call('/api/network/settings'), 'settings');
  assert.deepEqual([settings.settings, settings.worker], [{ revision: 0, maxConcurrentJobs: 2, defaultTimeoutMs: 1_200_000, outputRetentionDays: 30 }, false]);
  assert.equal((await ok(call('/api/network/settings', 'PATCH', { expectedRevision: 0, maxConcurrentJobs: 3 }), 'patch settings')).settings.maxConcurrentJobs, 3);
  assert.equal((await call('/api/network/settings', 'PATCH', { expectedRevision: 0, maxConcurrentJobs: 2 })).status, 409);
  assert.equal((await call('/api/network/settings', 'PATCH', { expectedRevision: 1, maxConcurrentJobs: 9 })).status, 400);
  const everything = JSON.stringify([list, detail, settings, cancelled]);
  assert.ok(!everything.includes(dataDir) && !everything.includes(token), 'no data-folder path or token in job answers');
});

test('twenty jobs completed by the fake worker change no board file, card, run, session, branch or worktree, and start no process', async t => {
  const spawned = [], names = ['spawn', 'execFile', 'exec', 'fork', 'spawnSync', 'execFileSync', 'execSync'], originals = Object.fromEntries(names.map(name => [name, childProcess[name]]));
  for (const name of names) childProcess[name] = function (...args) { spawned.push(`${name} ${args[0]}`); return originals[name].apply(this, args); };
  syncBuiltinESMExports();
  t.after(() => { Object.assign(childProcess, originals); syncBuiltinESMExports(); });
  await git(['--version'], { cwd: tmpdir() }).catch(() => {});
  assert.ok(spawned.length === 1 && /^execFile .*git/.test(spawned[0]), 'the recorder sees processes started inside src modules');
  const worker = fakeWorker(), { call, dataDir } = await app(t, { networkWorker: worker });
  const lead = await registerLead(call);
  const outside = async () => {
    const files = (await readdir(dataDir, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => relative(dataDir, join(entry.parentPath, entry.name)))
      .filter(path => path !== 'instance.lock' && !path.startsWith(`network${sep}`)).sort();
    return JSON.stringify(await Promise.all(files.map(async path => [path, sha(await readFile(join(dataDir, path)))])));
  };
  const board = async () => { const { board: view } = await ok(call('/api/board'), 'board'); return JSON.stringify([view.revision, view.projects.map(project => [project.id, project.tasks.length, project.repository ?? null]), view.runs, view.sessions]); };
  const before = [await outside(), await board()];
  assert.ok(before[0].includes('state.json'));
  spawned.length = 0;
  const ids = [];
  for (let n = 0; n < 20; n++) ids.push((await ok(call('/api/network/jobs', 'POST', { agentId: lead.id, input: { text: `Question ${n}` } }), `submit ${n}`, 202)).jobId);
  await until(async () => (await ok(call('/api/network/jobs?status=completed&limit=200'), 'list')).total === 20, 'twenty completed', 15000);
  assert.deepEqual([await outside(), await board()], before, 'state.json and every file outside network/ are byte-identical; no card, run or session');
  assert.deepEqual(spawned, [], 'no process: no CLI, git branch, worktree, test or merge');
  assert.equal(worker.starts.length, 20, 'one start per job');
  assert.deepEqual((await readdir(join(dataDir, 'network'))).sort(), ['agents.json', 'events', 'jobs'], 'and the activity journal (Task 08)');
});

test('sign-in waits for Network jobs: a job queued during a sign-in change starts right after it; sign-in is refused while one runs', async t => {
  const worker = fakeWorker({ mode: 'manual' });
  const authAdapter = { installed: async () => true, status: async () => ({ state: 'signed-in' }),
    login: async (provider, { signal, onUpdate }) => { onUpdate({ code: 'ABCD-1234' }); return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); } };
  const { call } = await app(t, { networkWorker: worker, authAdapter });
  const lead = await registerLead(call);
  // A sign-in change is in progress: a new job waits, says so, and starts as soon as the change ends.
  assert.equal((await call('/api/auth/login', 'POST', { provider: 'codex' })).status, 202);
  const waiting = await ok(call('/api/network/jobs', 'POST', { agentId: lead.id, input: { text: 'After sign-in.' } }), 'submit during sign-in', 202);
  await tick(50);
  assert.deepEqual([worker.starts.length, (await ok(call(`/api/network/jobs/${waiting.jobId}`), 'waiting')).job.waiting.for], [0, 'sign-in']);
  const next = worker.next(2000);
  await ok(call('/api/auth/cancel', 'POST', {}), 'end sign-in');
  const entry = await next;
  assert.equal(entry.own.jobId, waiting.jobId);
  // While it runs, sign-in is refused; once it has stopped, sign-in may start.
  await entry.own.launching(); await entry.own.spawned({ pid: 41 });
  const refused = await call('/api/auth/login', 'POST', { provider: 'codex' });
  assert.deepEqual([refused.status, refused.json.code], [409, 'RUNS_ACTIVE']);
  assert.match(refused.json.error, /Network jobs are running/);
  await ok(call(`/api/network/jobs/${waiting.jobId}/cancel`, 'POST', {}), 'cancel');
  entry.end();
  await until(async () => (await call('/api/auth/login', 'POST', { provider: 'codex' })).status === 202, 'sign-in allowed once nothing runs');
});

test('only queued jobs never block sign-in when no worker exists', async t => {
  const authAdapter = { installed: async () => true, status: async () => ({ state: 'signed-in' }), login: async () => ({}) };
  const { call } = await app(t, { authAdapter });
  const lead = await registerLead(call);
  await ok(call('/api/network/jobs', 'POST', { agentId: lead.id, input: { text: 'Queued.' } }), 'submit', 202);
  assert.equal((await call('/api/auth/login', 'POST', { provider: 'codex' })).status, 202);
});

test('shutdown stops claiming, stops the running attempt and saves it interrupted; the next start never relaunches it', async t => {
  const worker = fakeWorker({ mode: 'manual' });
  const first = await app(t, { networkWorker: worker });
  const lead = await registerLead(first.call);
  await ok(first.call('/api/network/settings', 'PATCH', { expectedRevision: 0, maxConcurrentJobs: 1 }), 'one at a time');
  const next = worker.next();
  const running = (await ok(first.call('/api/network/jobs', 'POST', { agentId: lead.id, input: { text: 'Runs now.' } }), 'submit', 202)).jobId;
  const entry = await next;
  await entry.own.launching(); await entry.own.spawned({ pid: 51 }); entry.process = 'running';
  const queued = (await ok(first.call('/api/network/jobs', 'POST', { agentId: lead.id, input: { text: 'Waits.' } }), 'submit 2', 202)).jobId;
  await first.app.close();
  assert.deepEqual([entry.killed, entry.own.signal.aborted, worker.starts.length], [true, true, 1]);
  const disk = async id => JSON.parse(await readFile(join(first.dataDir, 'network', 'jobs', folderOf(id), 'job.json'), 'utf8'));
  const stopped = await disk(running);
  assert.deepEqual([stopped.status, stopped.outcome, stopped.errorCode, stopped.attempts[0].status, (await disk(queued)).status], ['interrupted', 'uncertain', 'APP_STOPPED', 'interrupted', 'queued']);
  const after = fakeWorker();
  const second = await app(t, { networkWorker: after }, first.dataDir);
  await until(async () => (await ok(second.call(`/api/network/jobs/${queued}`), 'queued')).job.status === 'completed', 'the queued job runs after the restart');
  const { job } = await ok(second.call(`/api/network/jobs/${running}`), 'interrupted');
  assert.deepEqual([job.status, job.attempts.length, after.starts.length], ['interrupted', 1, 1]);
});
