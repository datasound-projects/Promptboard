// Task 12 Network job schedules (src/network/schedules.mjs over Kanban's slot arithmetic in src/schedules.mjs): off until the
// owner confirms; saving, editing and importing start nothing; one coalesced job after downtime; no pile-up while the previous
// job or run is open; a restart (or a crash between submit and save) never fires a slot twice; a zone change warns and fires
// nothing; Run now and on-demand schedules; the export carries definitions only. A fake clock and zone, no timers: tick() is
// called by the test. Real Base, Store, registry, job engine and pipeline runner on temporary folders; no CLI starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Base } from '../src/base.mjs';
import { Store } from '../src/store.mjs';
import { NetworkRegistry } from '../src/network/registry.mjs';
import { NetworkJobs } from '../src/network/jobs.mjs';
import { NetworkPipelines } from '../src/network/pipeline-model.mjs';
import { PipelineRunner } from '../src/network/pipeline-runner.mjs';
import { NetworkSchedules } from '../src/network/schedules.mjs';
import { nextFire } from '../src/schedules.mjs';
import { fakeWorker } from './helpers/network-worker.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const hex = text => createHash('sha256').update(text).digest('hex');
const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await tick()) { const value = await check(); if (value) return value; }
  assert.fail(`timed out: ${label}`);
}
const HOUR = 3_600_000, DAY = 24 * HOUR;
// Local times, so the test holds in any zone the computer runs in (January: no clock change in any common zone).
const local = (day, hours, minutes = 0) => new Date(2027, 0, day, hours, minutes).getTime();
const DAILY = { kind: 'daily', time: '02:00' };

/** Base agents lead (Claude) and gem (Gemini) registered; an engine (fake worker or none) and schedules on a fake clock and zone. */
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-network-schedules-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const base = new Base({ store: new Store(dataDir) });
  await base.create({ id: 'lead', kind: 'profile', name: 'Lead', configuration: { agent: { provider: 'claude' } } });
  await base.create({ id: 'gem', kind: 'profile', name: 'Gem', configuration: { agent: { provider: 'gemini' } } });
  const clock = { at: local(14, 12), zone: 'Europe/Warsaw' }, events = [], made = [];
  const now = () => clock.at, zone = () => clock.zone;
  const registry = new NetworkRegistry({ dataDir, base, projects: async () => ['p1'], now });
  const register = async id => (await registry.registerAgent({ baseResourceId: id, expectedRevision: (await registry.listAgents()).revision, projectAllowlist: ['p1'] })).agent;
  const lead = await register('lead'), gem = await register('gem');
  const sink = { append: async event => { events.push(event); return { seq: events.length, id: 'evt' }; } };
  const open = ({ worker = null } = {}) => {
    const jobs = new NetworkJobs({ dataDir, registry, worker, now, prepareTimeoutMs: 600_000, events: sink });
    const pipelines = new NetworkPipelines({ dataDir, registry, now });
    const runs = new PipelineRunner({ dataDir, pipelines, jobs, now, pollMs: 5, events: sink });
    const schedules = new NetworkSchedules({ dataDir, jobs, runs, registry, events: sink, now, zone, setTimer: () => null, clearTimer: () => {} });
    const instance = { jobs, pipelines, runs, schedules, worker, ready: Promise.all([jobs.start(), runs.start()]) };
    made.push(instance);
    return instance;
  };
  t.after(async () => { for (const { jobs, runs, schedules, worker } of made) { schedules.stop(); await runs.close(); for (const entry of worker?.attempts?.values() || []) entry.end?.(); await jobs.close(); } });
  const create = async (schedules, extra = {}) => (await schedules.create({ expectedRevision: (await schedules.list()).revision, name: 'Morning digest', target: { agentId: lead.id, input: { text: 'Summarise yesterday.' } }, cadence: DAILY, ...extra })).schedule;
  const confirm = async (schedules, id) => (await schedules.confirm(id, { expectedRevision: (await schedules.list()).schedules.find(row => row.id === id).revision, confirm: true })).schedule;
  const row = async (schedules, id) => (await schedules.list()).schedules.find(item => item.id === id);
  const scheduled = async (jobs, id) => (await jobs.list({ limit: 200 })).jobs.filter(job => job.requester.kind === 'schedule' && job.requester.id === id);
  return { dataDir, registry, lead, gem, clock, events, open, create, confirm, row, scheduled, file: (...parts) => join(dataDir, 'network', ...parts) };
}

test('a schedule is off until the owner confirms it; saving and editing start nothing; nothing before the confirmation is caught up', async t => {
  const ctx = await fixture(t), { jobs, schedules, ready } = ctx.open();
  await ready;
  const made = await ctx.create(schedules);
  assert.deepEqual([made.enabled, made.confirmedAt, made.timeZone, made.next, made.zoneMismatch, made.lastSlot], [false, null, 'Europe/Warsaw', null, false, null]);
  assert.deepEqual(made.target, { agentId: ctx.lead.id, input: { text: 'Summarise yesterday.' }, instructions: '', tools: 'none', permissions: { filesystem: 'read_only', memory: 'agent', projectLessons: false }, requireApproval: false, projectId: null, networkId: null });
  const stored = JSON.parse(await readFile(ctx.file('schedules.json'), 'utf8'));
  assert.deepEqual([stored.schema, stored.version, stored.schedules.length], ['promptboard.network-schedules', 1, 1]);
  ctx.clock.at = local(15, 2, 1);
  await schedules.tick();
  assert.equal((await jobs.list()).total, 0, 'off: its time passes and nothing starts');
  await assert.rejects(schedules.update(made.id, { expectedRevision: made.revision, enabled: true }), { code: 'CONFIRMATION_REQUIRED' });
  await assert.rejects(schedules.confirm(made.id, { expectedRevision: made.revision }), { code: 'CONFIRMATION_REQUIRED' });
  await assert.rejects(schedules.create({ expectedRevision: 1, name: 'Bad', target: { agentId: ctx.lead.id, input: { text: 'x' }, parentJobId: `job_${'a'.repeat(20)}` }, cadence: DAILY }), { code: 'INVALID_INPUT' });
  await assert.rejects(schedules.create({ expectedRevision: 1, name: 'Bad', target: { agentId: `agt_${'0'.repeat(20)}`, input: { text: 'x' } }, cadence: DAILY }), { code: 'AGENT_NOT_FOUND' });
  await assert.rejects(schedules.create({ expectedRevision: 1, name: 'Bad', target: { agentId: ctx.lead.id, input: { text: 'x' } }, cadence: { kind: 'hourly' } }), { code: 'INVALID_SCHEDULE' });
  ctx.clock.at = local(15, 9);
  const on = await ctx.confirm(schedules, made.id);
  assert.deepEqual([on.enabled, on.confirmedAt, on.next], [true, local(15, 9), local(16, 2)], 'counting starts at the confirmation');
  await schedules.tick();
  assert.equal((await jobs.list()).total, 0, 'the 02:00 slot before the confirmation is not caught up');
  ctx.clock.at = local(16, 2, 0) + 30_000;
  await schedules.tick();
  const [job] = await ctx.scheduled(jobs, made.id);
  assert.deepEqual([job.source, job.requester, job.schedule, job.idempotencyKey, job.status], ['schedule', { kind: 'schedule', id: made.id }, { id: made.id, slot: local(16, 2) }, `slot:${local(16, 2)}`, 'queued']);
  assert.deepEqual((await jobs.read(job.id)).request.schedule, { id: made.id, slot: local(16, 2) }, 'the slot is part of the accepted request');
  const after = await ctx.row(schedules, made.id);
  assert.deepEqual([after.lastSlot, after.lastJobId, after.lastSkip, after.revision], [local(16, 2), job.id, null, on.revision], 'firing keeps the revision, so an open edit never conflicts');
  await schedules.tick();
  assert.equal((await jobs.list()).total, 1, 'one job per slot');
  // A new name keeps it on; a new input switches it off until it is confirmed again; neither starts anything.
  const renamed = await schedules.update(made.id, { expectedRevision: after.revision, name: 'Daily digest' });
  assert.deepEqual([renamed.schedule.enabled, renamed.switchedOff], [true, false]);
  const changed = await schedules.update(made.id, { expectedRevision: renamed.schedule.revision, target: { agentId: ctx.lead.id, input: { text: 'Something else.' } } });
  assert.deepEqual([changed.schedule.enabled, changed.schedule.confirmedAt, changed.switchedOff], [false, null, true]);
  ctx.clock.at = local(17, 3);
  await schedules.tick();
  assert.equal((await jobs.list()).total, 1);
  const started = ctx.events.filter(event => event.type === 'schedule.run');
  assert.deepEqual(started.map(event => [event.scheduleId, event.status, event.jobId]), [[made.id, 'started', job.id]]);
  assert.ok(!JSON.stringify(ctx.events).includes('Summarise yesterday'), 'no job input in an event');
});

test('slots missed while the app was closed give one job; while the previous job is open the next slot is skipped and used up (no pile-up)', async t => {
  const ctx = await fixture(t), { jobs, schedules, ready } = ctx.open();
  await ready;
  const made = await ctx.create(schedules);
  await ctx.confirm(schedules, made.id);
  ctx.clock.at = local(18, 12); // Closed since the 14th: the 15th, 16th, 17th and 18th 02:00 were missed.
  await schedules.tick();
  const jobsNow = await ctx.scheduled(jobs, made.id);
  assert.equal(jobsNow.length, 1, 'one coalesced job, not four');
  assert.equal(jobsNow[0].schedule.slot, local(18, 2), 'for the latest missed slot');
  assert.match(ctx.events.at(-1).message, /late \(Promptboard was not running at its time; missed times run once\)/);
  ctx.clock.at = local(19, 2, 5); // No worker: the job is still queued, so it is still open.
  await schedules.tick();
  assert.equal((await ctx.scheduled(jobs, made.id)).length, 1, 'no pile-up');
  const skipped = await ctx.row(schedules, made.id);
  assert.deepEqual([skipped.lastSlot, skipped.lastSkip.slot, skipped.lastSkip.code, skipped.lastJobId], [local(19, 2), local(19, 2), 'PREVIOUS_OPEN', jobsNow[0].id]);
  assert.match(skipped.lastSkip.reason, new RegExp(`previous job ${jobsNow[0].id} is still open`));
  assert.deepEqual(ctx.events.filter(event => event.type === 'schedule.run').map(event => event.status), ['started', 'skipped']);
  await schedules.tick();
  assert.equal((await ctx.scheduled(jobs, made.id)).length, 1, 'the skipped slot is used up, not retried');
  await jobs.cancel(jobsNow[0].id);
  ctx.clock.at = local(20, 2, 5);
  await schedules.tick();
  assert.equal((await ctx.scheduled(jobs, made.id)).length, 2, 'the next slot after the previous job ended starts again');
});

test('a restart never fires a slot twice, also when it stopped between the submit and the save', async t => {
  const ctx = await fixture(t);
  let { jobs, schedules, ready } = ctx.open({ worker: fakeWorker() });
  await ready;
  const made = await ctx.create(schedules);
  await ctx.confirm(schedules, made.id);
  ctx.clock.at = local(15, 2, 1);
  await schedules.tick();
  const [first] = await ctx.scheduled(jobs, made.id);
  await until(async () => (await jobs.read(first.id)).job.status === 'completed', 'first job done');
  schedules.stop(); await jobs.close();
  ({ jobs, schedules, ready } = ctx.open({ worker: fakeWorker() }));
  await ready;
  await schedules.tick();
  assert.equal((await ctx.scheduled(jobs, made.id)).length, 1, 'restarted at the same time: the slot was recorded');
  // The next slot's job was submitted, then the app stopped before the schedule saved it.
  const row = await ctx.row(schedules, made.id), slot = local(16, 2);
  const orphan = await jobs.submit({ ...row.target, idempotencyKey: `slot:${slot}` }, { requester: { kind: 'schedule', id: made.id }, link: { schedule: { id: made.id, slot } } });
  await until(async () => (await jobs.read(orphan.jobId)).job.status === 'completed', 'orphan done');
  ctx.clock.at = local(16, 2, 30);
  await schedules.tick();
  const all = await ctx.scheduled(jobs, made.id);
  assert.equal(all.length, 2, 'the same slot found its job by key: no second job');
  assert.equal((await ctx.row(schedules, made.id)).lastJobId, orphan.jobId);
});

test('a change of the computer’s time zone shows a warning and fires nothing until the owner confirms the schedule again', async t => {
  const ctx = await fixture(t), { jobs, schedules, ready } = ctx.open();
  await ready;
  const made = await ctx.create(schedules);
  await ctx.confirm(schedules, made.id);
  ctx.clock.zone = 'America/New_York';
  const listed = await schedules.list();
  assert.deepEqual([listed.timeZone, listed.schedules[0].timeZone, listed.schedules[0].zoneMismatch, listed.schedules[0].next], ['America/New_York', 'Europe/Warsaw', true, null]);
  ctx.clock.at = local(15, 2, 1);
  await schedules.tick();
  assert.equal((await jobs.list()).total, 0, 'another zone: nothing fires');
  const again = await ctx.confirm(schedules, made.id);
  assert.deepEqual([again.timeZone, again.zoneMismatch, again.next], ['America/New_York', false, local(16, 2)]);
  ctx.clock.at = local(16, 2, 1);
  await schedules.tick();
  assert.equal((await jobs.list()).total, 1);
});

test('Run now starts one job at once, even while off or while the previous job is open; on-demand schedules run only that way; a refused time is used up and says why', async t => {
  const ctx = await fixture(t), { jobs, schedules, ready } = ctx.open();
  await ready;
  const demand = await ctx.create(schedules, { name: 'When I ask', cadence: { kind: 'on_demand' } });
  await assert.rejects(schedules.confirm(demand.id, { expectedRevision: demand.revision, confirm: true }), { code: 'SCHEDULE_ON_DEMAND' });
  const once = await schedules.runNow(demand.id, { idempotencyKey: 'click-1' });
  const same = await schedules.runNow(demand.id, { idempotencyKey: 'click-1' }), other = await schedules.runNow(demand.id, {});
  assert.deepEqual([same.jobId, same.deduplicated, other.jobId !== once.jobId], [once.jobId, true, true], 'a repeated click with its key is the same job; a new click is a new job');
  const { job } = await jobs.read(once.jobId);
  assert.deepEqual([job.requester, job.schedule, job.idempotencyKey], [{ kind: 'schedule', id: demand.id }, { id: demand.id, slot: null }, 'run:click-1']);
  ctx.clock.at = local(20, 2, 1);
  await schedules.tick();
  assert.equal((await ctx.scheduled(jobs, demand.id)).length, 2, 'an on-demand schedule never fires on its own');
  // Refused at its time (the agent was switched off): the slot is used up, the reason is shown, nothing ran.
  const daily = await ctx.create(schedules, { target: { agentId: ctx.gem.id, input: { text: 'Gem work.' } } });
  await ctx.confirm(schedules, daily.id);
  const { agent } = await ctx.registry.agent(ctx.gem.id);
  await ctx.registry.updateAgent(ctx.gem.id, { expectedRevision: agent.revision, enabled: false });
  ctx.clock.at = local(21, 2, 1);
  await schedules.tick();
  const refused = await ctx.row(schedules, daily.id);
  assert.deepEqual([refused.lastSlot, refused.lastSkip.code, (await ctx.scheduled(jobs, daily.id)).length], [local(21, 2), 'REGISTRATION_DISABLED', 0]);
  assert.equal(ctx.events.findLast(event => event.type === 'schedule.run').status, 'failed');
  await schedules.remove(daily.id, { expectedRevision: refused.revision });
  assert.equal((await schedules.list()).schedules.length, 1);
});

test('a pipeline schedule saves its slot before the run starts and skips while a run of the pipeline is open', async t => {
  const ctx = await fixture(t), { jobs, pipelines, runs, schedules, ready } = ctx.open({ worker: fakeWorker({ mode: 'manual' }) });
  await ready;
  const N = name => `n_${hex(name).slice(0, 12)}`;
  const { network } = await ctx.registry.createNetwork({ name: 'Team', nodes: [{ id: N('lead'), type: 'agent', agentId: ctx.lead.id, position: { x: 0, y: 0 } }], edges: [] });
  await ctx.registry.publishNetwork(network.id, { expectedRevision: network.revision });
  const { pipeline } = await pipelines.create({ networkId: network.id, networkVersion: 1, name: 'Digest',
    nodes: [{ id: N('step'), type: 'agent', label: 'step', position: { x: 0, y: 0 }, config: { agentId: ctx.lead.id } }, { id: N('out'), type: 'output', label: 'out', position: { x: 0, y: 0 }, config: { include: [N('step')] } }],
    edges: [{ id: `e_${hex('edge').slice(0, 12)}`, from: N('step'), to: N('out'), fromPort: 'text' }] });
  await pipelines.publish(pipeline.id, { expectedRevision: pipeline.revision });
  await assert.rejects(ctx.create(schedules, { target: { pipelineId: pipeline.id, version: 2 } }), { code: 'PIPELINE_NOT_FOUND' });
  const made = await ctx.create(schedules, { target: { pipelineId: pipeline.id, version: 1 } });
  await ctx.confirm(schedules, made.id);
  ctx.clock.at = local(15, 2, 1);
  await schedules.tick();
  const started = await ctx.row(schedules, made.id);
  assert.deepEqual([started.lastSlot, started.lastJobId], [local(15, 2), null]);
  const { run } = await runs.read(started.lastRunId);
  assert.deepEqual([run.pipelineId, run.pipelineVersion, run.status], [pipeline.id, 1, 'running']);
  ctx.clock.at = local(16, 2, 1);
  await schedules.tick();
  const skipped = await ctx.row(schedules, made.id);
  assert.deepEqual([skipped.lastRunId, skipped.lastSkip.code, (await runs.list({ pipelineId: pipeline.id })).total], [run.id, 'PREVIOUS_OPEN', 1]);
  await runs.cancel(run.id, {});
  // The slot is saved before the run starts: a stop in between loses that one run, and the slot never starts a second one.
  const start = runs.startRun;
  runs.startRun = async () => { throw new Error('the app stopped here'); };
  ctx.clock.at = local(17, 2, 1);
  await schedules.tick();
  runs.startRun = start;
  assert.deepEqual([(await ctx.row(schedules, made.id)).lastSlot, (await runs.list({ pipelineId: pipeline.id })).total], [local(17, 2), 1]);
  await schedules.tick();
  assert.equal((await runs.list({ pipelineId: pipeline.id })).total, 1, 'the same slot is not started again');
  assert.equal((await jobs.list()).jobs.every(job => job.requester.kind === 'pipeline'), true, 'a pipeline schedule submits no job of its own');
});

test('over HTTP: schedules are definitions in the Network export, come back switched off from an import that checks them first, and the routes answer as documented', async t => {
  const app = await startTestServer(t, { port: 0, executor: null, networkWorker: null, networkScheduleOptions: { setTimer: () => null } }); // No timer: nothing fires on its own here.
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = async (path, method = 'GET', body) => { const response = await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, json: await response.json() }; };
  await app.board.base.create({ id: 'lead', kind: 'profile', name: 'Lead', configuration: { agent: { provider: 'claude' } } });
  const agent = (await call('/api/network/agents', 'POST', { baseResourceId: 'lead', expectedRevision: 0 })).json.agent;
  const exportedBefore = (await call('/api/network/export')).json;
  assert.equal('schedules' in exportedBefore, false, 'no schedules: the export is what it was before Task 12');
  const list = await call('/api/network/schedules');
  assert.deepEqual([list.status, list.json.revision, list.json.schedules, typeof list.json.timeZone], [200, 0, [], 'string']);
  const created = await call('/api/network/schedules', 'POST', { expectedRevision: 0, name: 'Nightly', target: { agentId: agent.id, input: { text: 'Check the docs.' } }, cadence: { kind: 'weekly', days: [1, 3], time: '03:30' } });
  assert.deepEqual([created.status, created.json.schedule.enabled, created.json.schedule.cadence], [201, false, { kind: 'weekly', days: [1, 3], time: '03:30' }]);
  const id = created.json.schedule.id;
  const confirmed = await call(`/api/network/schedules/${id}/confirm`, 'POST', { expectedRevision: 1, confirm: true });
  assert.deepEqual([confirmed.status, confirmed.json.schedule.enabled, confirmed.json.schedule.next === nextFire({ kind: 'weekly', days: [1, 3], time: '03:30' }, confirmed.json.schedule.confirmedAt)], [200, true, true]);
  const ran = await call(`/api/network/schedules/${id}/run`, 'POST', { idempotencyKey: 'first' });
  assert.deepEqual([ran.status, ran.json.status], [202, 'queued']);
  const exported = (await call('/api/network/export')).json;
  assert.deepEqual(Object.keys(exported.schedules[0]).sort(), ['cadence', 'createdAt', 'id', 'name', 'target', 'timeZone', 'updatedAt'], 'definitions only: no on/off, confirmation or history');
  // An import whose schedule names an agent the file does not hold is refused whole.
  const agentsBefore = (await call('/api/network/agents')).json.total;
  const bad = await call('/api/network/import', 'POST', { data: { ...exported, schedules: [{ ...exported.schedules[0], target: { ...exported.schedules[0].target, agentId: `agt_${'0'.repeat(20)}` } }] }, expectedRevision: 1 });
  assert.deepEqual([bad.status, bad.json.code, (await call('/api/network/agents')).json.total], [409, 'NETWORK_IMPORT_UNRESOLVED', agentsBefore]);
  const imported = await call('/api/network/import', 'POST', { data: exported, expectedRevision: 1 });
  assert.deepEqual([imported.status, imported.json.imported.schedules], [200, 1], JSON.stringify(imported.json));
  const copy = (await call('/api/network/schedules')).json.schedules.find(row => row.id !== id);
  assert.deepEqual([copy.enabled, copy.confirmedAt, copy.lastSlot, copy.lastJobId, copy.target.agentId], [false, null, null, null, imported.json.remapped.agents[agent.id]]);
  assert.notEqual(copy.id, id, 'a taken ID gets a new one');
  const edited = await call(`/api/network/schedules/${id}`, 'PATCH', { expectedRevision: confirmed.json.schedule.revision, enabled: false });
  assert.deepEqual([edited.status, edited.json.schedule.enabled, edited.json.switchedOff], [200, false, true]);
  const deleted = await call(`/api/network/schedules/${id}`, 'DELETE', { expectedRevision: edited.json.schedule.revision });
  assert.deepEqual([deleted.status, deleted.json.deleted], [200, id]);
  const jobs = (await call('/api/network/jobs')).json;
  assert.deepEqual(jobs.jobs.map(job => job.requester.kind), ['schedule'], 'only Run now started a job; no import or save did');
});
