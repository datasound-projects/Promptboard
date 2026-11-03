// Network pipelines (src/network/pipeline-model.mjs, pipeline-compiler.mjs, pipeline-runner.mjs; the pipeline link in
// src/network/jobs.mjs): drafts and immutable versions with execution edges apart from Graph relations, the compiler's
// refusals and pins, and runs through the real job engine with the deterministic fake worker (tests/helpers/network-worker.mjs):
// topological order, true parallelism, joins, typed conditions, approvals across a restart, cancel, restart reconciliation,
// nested version pinning, revocation, time limits, bounded retries and receipts that do not hold. Temporary data folders;
// no process, CLI or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Base } from '../src/base.mjs';
import { Store } from '../src/store.mjs';
import { NetworkRegistry } from '../src/network/registry.mjs';
import { NetworkJobs } from '../src/network/jobs.mjs';
import { NetworkPipelines } from '../src/network/pipeline-model.mjs';
import { decide } from '../src/network/pipeline-compiler.mjs';
import { PipelineRunner } from '../src/network/pipeline-runner.mjs';
import { fakeWorker } from './helpers/network-worker.mjs';

const hex = text => createHash('sha256').update(text).digest('hex');
const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await tick()) { const value = await check(); if (value) return value; }
  assert.fail(`timed out: ${label}`);
}
const refused = async (pending, code) => { await assert.rejects(pending, error => { assert.equal(error.code, code, error.message); return true; }); };

// Steps and execution edges by readable names (IDs are n_/e_ + 12 hex characters derived from the name).
const N = name => `n_${hex(`step:${name}`).slice(0, 12)}`;
const step = (name, type, config = {}, label = name) => ({ id: N(name), type, label, position: { x: 0, y: 0 }, config });
const edge = (from, to, fromPort) => ({ id: `e_${hex(`edge:${from}>${fromPort}>${to}`).slice(0, 12)}`, from: N(from), to: N(to), fromPort });
/** Drive a manual fake attempt to its end with `report` (launching, spawned, then the report). */
async function finish(entry, report) { await entry.own.launching(); await entry.own.spawned({ pid: 4242 }); const answer = await entry.own.finish(report); entry.end(); return answer; }
const done = text => ({ status: 'completed', exitCode: 0, result: { text } });
/** Every attempt the manual worker starts gets `respond(entry)` (a report, or null to leave it running) as soon as it appears. */
function autopilot(t, worker, respond) {
  const seen = new Set(), timer = setInterval(() => {
    for (const [id, entry] of worker.attempts) if (!seen.has(id)) { seen.add(id); const report = respond(entry); if (report) finish(entry, report).catch(() => {}); }
  }, 2);
  t.after(() => clearInterval(timer));
  return timer;
}

/**
 * Base agents (Claude, Codex, Gemini), their registrations and the network "Team" (research A, research B, reviewer,
 * Gemini) published as v1, with a share_result relation from A to the reviewer. `open()` builds the registry, job engine,
 * pipelines and runner on the data folder (again after a restart); `events` collects what the runner reports.
 */
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-network-pipeline-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const base = new Base({ store: new Store(dataDir) });
  for (const [id, provider] of [['research-a', 'claude'], ['research-b', 'codex'], ['reviewer', 'claude'], ['outsider', 'claude'], ['gem', 'gemini']]) {
    await base.create({ id, kind: 'profile', name: id, configuration: { agent: { provider } } });
  }
  let clock = 1_800_000_000_000;
  const now = () => clock, events = [], instances = [];
  const registry = new NetworkRegistry({ dataDir, base, projects: async () => [], now });
  const register = async baseResourceId => (await registry.registerAgent({ baseResourceId, expectedRevision: (await registry.listAgents()).revision })).agent;
  const agents = { a: await register('research-a'), b: await register('research-b'), r: await register('reviewer'), x: await register('outsider'), g: await register('gem') };
  const node = (agent, x) => ({ id: N(`member:${agent.id}`), type: 'agent', agentId: agent.id, position: { x, y: 0 } });
  /** A network with these agents and pinned sub-networks, published as v1. */
  const network = async (name, members = [], subs = [], relations = []) => {
    const nodes = [...members.map((agent, index) => node(agent, index * 200)), ...subs.map((sub, index) => ({ id: N(`sub:${sub.id}`), type: 'subnetwork', networkId: sub.id, version: sub.version, position: { x: index * 200, y: 300 } }))];
    const { network: draft } = await registry.createNetwork({ name, nodes, edges: relations.map(([from, to, relation]) => ({ id: `e_${hex(`${from.id}${to.id}`).slice(0, 12)}`, from: N(`member:${from.id}`), to: N(`member:${to.id}`), relation })) });
    await registry.publishNetwork(draft.id, { expectedRevision: draft.revision });
    return { id: draft.id, version: 1 };
  };
  const team = await network('Team', [agents.a, agents.b, agents.r, agents.g], [], [[agents.a, agents.r, 'share_result']]);
  const open = ({ worker = fakeWorker({ mode: 'manual' }), start = true, pollMs = 5, jobs: wrap = jobs => jobs } = {}) => {
    const jobs = new NetworkJobs({ dataDir, registry, worker, now, prepareTimeoutMs: 600_000 });
    const pipelines = new NetworkPipelines({ dataDir, registry, now });
    const runner = new PipelineRunner({ dataDir, pipelines, jobs: wrap(jobs), now, pollMs, events: { append: async event => { events.push(event); return { seq: events.length, id: 'evt' }; } } });
    const instance = { jobs, pipelines, runner, worker, ready: start ? Promise.all([jobs.start(), runner.start()]) : Promise.resolve() };
    instances.push(instance);
    return instance;
  };
  t.after(async () => { for (const { runner, jobs, worker } of instances) { await runner.close(); for (const entry of worker.attempts.values()) entry.end?.(); await jobs.close(); } });
  /** A saved and published pipeline of `net` (default Team v1). */
  const publish = async (pipelines, name, { nodes, edges, settings, net = team } = {}) => {
    const { pipeline } = await pipelines.create({ networkId: net.id, networkVersion: net.version, name, nodes, edges, ...(settings ? { settings } : {}) });
    return (await pipelines.publish(pipeline.id, { expectedRevision: pipeline.revision })).pipeline;
  };
  const file = (...parts) => join(dataDir, 'network', ...parts);
  const runOf = async (runner, runId) => (await runner.read(runId)).run;
  return { dataDir, base, registry, agents, team, network, open, publish, file, runOf, events, now, advance: ms => { clock += ms; } };
}
/** Two parallel research steps → join → reviewer → approval (which also sees the research) → saved report. */
const demo = ({ a, b, r }) => ({
  nodes: [step('researchA', 'agent', { agentId: a.id, instructions: 'Research the market.' }), step('researchB', 'agent', { agentId: b.id, instructions: 'Research the competitors.' }),
    step('join', 'join', { require: 'all' }), step('review', 'agent', { agentId: r.id, instructions: 'Review both reports.' }),
    step('approve', 'approval', { prompt: 'Save the report?' }), step('report', 'output', { name: 'report', include: [N('researchA'), N('researchB'), N('review')] })],
  edges: [edge('researchA', 'join', 'text'), edge('researchB', 'join', 'text'), edge('join', 'review', 'done'), edge('review', 'approve', 'text'), edge('join', 'approve', 'done'), edge('approve', 'report', 'done')],
});
/** a → b → saved report. */
const chain = ({ a, r }, config = {}) => ({
  nodes: [step('first', 'agent', { agentId: a.id, ...config.first }), step('second', 'agent', { agentId: r.id, ...config.second }), step('out', 'output', { include: [N('second')] })],
  edges: [edge('first', 'second', 'text'), edge('second', 'out', 'text')], ...(config.settings ? { settings: config.settings } : {}),
});

test('pipelines are drafts with immutable versions; their execution edges are stored apart from Graph relations; the schema is strict; saving runs nothing', async t => {
  const ctx = await fixture(t), { pipelines, jobs } = ctx.open({ start: false });
  const teamFile = ctx.file('networks', `net__${ctx.team.id.slice(4)}.json`), teamBytes = await readFile(teamFile, 'utf8');
  const { pipeline } = await pipelines.create({ networkId: ctx.team.id, networkVersion: 1, name: 'Market report', ...demo(ctx.agents) });
  const draftFile = ctx.file('pipelines', `pip__${pipeline.id.slice(4)}.json`), saved = JSON.parse(await readFile(draftFile, 'utf8'));
  assert.deepEqual([saved.schema, saved.networkId, saved.networkVersion, saved.settings], ['promptboard.pipeline-draft', ctx.team.id, 1, { maxParallel: 2, deadlineMs: 7_200_000, failurePolicy: 'stop' }]);
  assert.deepEqual(Object.keys(saved.edges[0]), ['id', 'from', 'to', 'fromPort', 'toPort'], 'execution edges carry ports, never a relation');
  assert.equal(await readFile(teamFile, 'utf8'), teamBytes, 'the network and its relations are a separate file, untouched');
  assert.ok(!JSON.stringify(saved).includes('share_result'));
  // Strict: unknown keys, wrong ports, loops and dangling references are refused before anything is written.
  const create = extra => pipelines.create({ networkId: ctx.team.id, networkVersion: 1, name: `P ${Math.random()}`, ...extra });
  const one = step('one', 'agent', { agentId: ctx.agents.a.id }), out = step('out', 'output', { include: [N('one')] });
  await refused(create({ nodes: [step('one', 'agent', { agentId: ctx.agents.a.id, model: 'opus' }), out] }), 'INVALID_INPUT');
  await refused(create({ nodes: [one, out], edges: [edge('one', 'out', 'true')] }), 'PIPELINE_PORT');
  await refused(create({ nodes: [one, out], edges: [edge('out', 'one', 'text')] }), 'PIPELINE_PORT');
  await refused(create({ nodes: [one, out], edges: [{ ...edge('one', 'out', 'text'), toPort: 'json' }] }), 'PIPELINE_PORT');
  await refused(create({ nodes: [one, out], edges: [edge('one', 'one', 'text')] }), 'INVALID_INPUT');
  await refused(create({ nodes: [one, step('two', 'agent', { agentId: ctx.agents.b.id }), out], edges: [edge('one', 'two', 'text'), edge('two', 'one', 'text')] }), 'PIPELINE_CYCLE');
  await refused(create({ nodes: [one, step('out', 'output', { include: [N('ghost')] })] }), 'PIPELINE_REFERENCE_INVALID');
  await refused(create({ nodes: [one, step('if', 'condition', { all: [{ path: `${N('one')}.json.score`, op: 'gt', value: 'high' }] }), out] }), 'INVALID_INPUT');
  await refused(create({ nodes: [one, step('if', 'condition', { all: [{ path: `${N('one')}.json.score; process.exit()`, op: 'eq', value: 1 }] }), out] }), 'INVALID_INPUT');
  await refused(pipelines.create({ networkId: ctx.team.id, networkVersion: 2, name: 'Unpublished', nodes: [one, out] }), 'PIPELINE_NETWORK_INVALID');
  await refused(create({ nodes: [one, out], settings: { maxParallel: 5 } }), 'INVALID_INPUT');
  // Publish v1, change the draft, publish v2: v1's bytes and hash never change; a tampered version is refused.
  const v1 = await pipelines.publish(pipeline.id, { expectedRevision: pipeline.revision });
  const [entry] = v1.pipeline.publishedVersions, v1File = ctx.file('pipelines', `pip__${pipeline.id.slice(4)}`, `v1-${entry.sha256}.json`), v1Bytes = await readFile(v1File, 'utf8');
  assert.deepEqual([hex(v1Bytes), entry.networkVersion, v1.summary.order], [entry.sha256, 1, ['researchA', 'researchB', 'join', 'review', 'approve', 'report'].map(N)], 'topological order');
  const edited = demo(ctx.agents);
  edited.nodes[0].config.instructions = 'Research the market again.';
  const changed = await pipelines.update(pipeline.id, { expectedRevision: v1.pipeline.revision, nodes: edited.nodes });
  await refused(pipelines.update(pipeline.id, { expectedRevision: v1.pipeline.revision, name: 'Stale' }), 'REVISION_CONFLICT');
  await pipelines.publish(pipeline.id, { expectedRevision: changed.pipeline.revision });
  assert.equal(await readFile(v1File, 'utf8'), v1Bytes);
  assert.equal((await pipelines.version(pipeline.id, 1)).version.nodes[0].config.instructions, 'Research the market.');
  assert.equal((await pipelines.version(pipeline.id, 2)).version.nodes[0].config.instructions, 'Research the market again.');
  await refused(pipelines.remove(pipeline.id, { expectedRevision: (await pipelines.get(pipeline.id)).pipeline.revision }), 'PIPELINE_PUBLISHED');
  await writeFile(v1File, v1Bytes.replace('Research the market.', 'Research the market!'));
  const reopened = new NetworkPipelines({ dataDir: ctx.dataDir, registry: ctx.registry });
  await refused(reopened.version(pipeline.id, 1), 'NETWORK_CONTENT_INVALID');
  assert.equal((await reopened.get(pipeline.id)).pipeline.revision, 4, 'the draft survives a restart');
  // A never-published pipeline can be deleted (set aside); nothing above created a job or a run.
  const { pipeline: scratch } = await create({ nodes: [one, out], edges: [edge('one', 'out', 'text')] });
  assert.deepEqual((await pipelines.remove(scratch.id, { expectedRevision: 1 })).deleted.id, scratch.id);
  await refused(pipelines.get(scratch.id), 'NOT_FOUND');
  assert.equal((await jobs.list()).total, 0);
  assert.deepEqual((await readdir(ctx.file())).filter(name => !name.endsWith('.bak')).sort(), ['agents.json', 'networks', 'pipelines']);
});

test('the compiler refuses what cannot run: missing, foreign, disabled agents, typed ports, outputs, recursion, scope, depth over 4 and more than 2,000 steps', async t => {
  const ctx = await fixture(t), { pipelines } = ctx.open({ start: false }), { a, b, r, x, g } = ctx.agents;
  const check = async (nodes, edges = [], code, net = ctx.team) => {
    const { pipeline } = await pipelines.create({ networkId: net.id, networkVersion: net.version, name: `Check ${Math.random()}`, nodes, edges });
    const answer = await pipelines.validate(pipeline.id);
    assert.equal(answer.valid ? 'valid' : answer.error.code, code, JSON.stringify(answer.error));
    if (!answer.valid) await refused(pipelines.publish(pipeline.id, { expectedRevision: 1 }), code);
    return { pipeline, answer };
  };
  const out = (...names) => step('out', 'output', { include: names.map(N) });
  const ghost = `agt_${'f'.repeat(20)}`;
  await check([step('one', 'agent', { agentId: ghost }), out('one')], [edge('one', 'out', 'text')], 'AGENT_NOT_FOUND');
  await check([step('one', 'agent', { agentId: x.id }), out('one')], [edge('one', 'out', 'text')], 'PIPELINE_AGENT_NOT_IN_NETWORK');
  await ctx.registry.updateAgent(r.id, { expectedRevision: 1, enabled: false });
  await check([step('one', 'agent', { agentId: r.id }), out('one')], [edge('one', 'out', 'text')], 'REGISTRATION_DISABLED');
  await ctx.registry.updateAgent(r.id, { expectedRevision: 2, enabled: true });
  await check([step('one', 'agent', { agentId: g.id, tools: 'web' }), out('one')], [edge('one', 'out', 'text')], 'TOOLS_UNSUPPORTED');
  // Conditions read only json that reaches them; outputs include only what reaches them; every pipeline ends in an output.
  const score = [{ path: `${N('one')}.json.score`, op: 'gte', value: 0.5 }];
  await check([step('one', 'agent', { agentId: a.id }), step('if', 'condition', { all: score }), out('one')], [edge('one', 'if', 'text'), edge('if', 'out', 'true')], 'CONDITION_PORT');
  const { answer } = await check([step('one', 'agent', { agentId: a.id }), step('if', 'condition', { all: score }), out('one')], [edge('one', 'if', 'json'), edge('one', 'if', 'text'), edge('if', 'out', 'true')], 'valid');
  assert.deepEqual(answer.summary.order, [N('one'), N('if'), N('out')]);
  await check([step('one', 'agent', { agentId: a.id }), step('two', 'agent', { agentId: b.id }), out('one', 'two')], [edge('one', 'out', 'text')], 'OUTPUT_INCLUDE_MISSING');
  await check([step('one', 'agent', { agentId: a.id })], [], 'PIPELINE_NO_OUTPUT');
  await check([step('one', 'agent', { agentId: a.id }), out('one'), step('out2', 'output', { include: [N('one')] })], [edge('one', 'out', 'text'), edge('one', 'out2', 'text')], 'OUTPUT_NAME_TAKEN');
  // A loop that never passed the draft check (a crafted definition) is still refused by the compiler.
  await refused(pipelines.compile({ pipelineId: `pip_${'a'.repeat(20)}`, version: null, sha256: null, name: 'Crafted', networkId: ctx.team.id, networkVersion: 1, settings: { maxParallel: 2, deadlineMs: 60_000, failurePolicy: 'stop' },
    nodes: [step('one', 'agent', { agentId: a.id, instructions: '', tools: 'none', timeoutMs: null, retries: 0 }), step('two', 'agent', { agentId: b.id, instructions: '', tools: 'none', timeoutMs: null, retries: 0 }), out('one')],
    edges: [{ ...edge('one', 'two', 'text'), toPort: 'input' }, { ...edge('two', 'one', 'text'), toPort: 'input' }, { ...edge('one', 'out', 'text'), toPort: 'input' }] }), 'PIPELINE_CYCLE');
  // Recursion: a pipeline whose draft names its own published version.
  const self = await ctx.publish(pipelines, 'Self', { nodes: [step('one', 'agent', { agentId: a.id }), out('one')], edges: [edge('one', 'out', 'text')] });
  await pipelines.update(self.id, { expectedRevision: self.revision, nodes: [step('one', 'agent', { agentId: a.id }), step('again', 'subnetwork', { pipelineId: self.id, version: 1 }), out('one', 'again')], edges: [edge('one', 'out', 'text'), edge('again', 'out', 'text')] });
  assert.equal((await pipelines.validate(self.id)).error.code, 'PIPELINE_RECURSIVE');
  // Scope: a sub-pipeline must belong to a network this network version contains, at the pinned version.
  const child = await ctx.network('Child', [b]), stranger = await ctx.network('Stranger', [b]);
  const childPipeline = await ctx.publish(pipelines, 'Child work', { net: child, nodes: [step('c', 'agent', { agentId: b.id }), out('c')], edges: [edge('c', 'out', 'text')] });
  const strangerPipeline = await ctx.publish(pipelines, 'Stranger work', { net: stranger, nodes: [step('c', 'agent', { agentId: b.id }), out('c')], edges: [edge('c', 'out', 'text')] });
  const parent = await ctx.network('Parent', [a], [child]);
  const sub = id => [step('sub', 'subnetwork', { pipelineId: id, version: 1 }), out('sub')];
  await check(sub(childPipeline.id), [edge('sub', 'out', 'text')], 'valid', parent);
  await check(sub(strangerPipeline.id), [edge('sub', 'out', 'text')], 'PIPELINE_SCOPE', parent);
  await check([step('sub', 'subnetwork', { pipelineId: childPipeline.id, version: 9 }), out('sub')], [edge('sub', 'out', 'text')], 'PIPELINE_REFERENCE_INVALID', parent);
  await check([step('sub', 'subnetwork', { pipelineId: childPipeline.id, version: 1 }), step('c', 'agent', { agentId: b.id }), out('sub', 'c')], [edge('sub', 'out', 'text'), edge('c', 'out', 'text')], 'PIPELINE_AGENT_NOT_IN_NETWORK', parent);
  // Depth: four levels of sub-pipelines compile, five are refused.
  let net = await ctx.network('Level 5', [a]), inner = await ctx.publish(pipelines, 'Level 5', { net, nodes: [step('one', 'agent', { agentId: a.id }), out('one')], edges: [edge('one', 'out', 'text')] });
  for (const level of [4, 3, 2, 1]) {
    net = await ctx.network(`Level ${level}`, [], [net]);
    inner = await ctx.publish(pipelines, `Level ${level}`, { net, nodes: sub(inner.id), edges: [edge('sub', 'out', 'text')] });
  }
  const top = await ctx.network('Level 0', [], [net]);
  const { answer: deep } = await check(sub(inner.id), [edge('sub', 'out', 'text')], 'PIPELINE_DEPTH', top);
  assert.equal(deep.error.details.nodeId.split('/').length, 5, 'the step that would nest a fifth level');
  // More than 2,000 steps after expansion: five sub-pipeline steps of a 450-step pipeline.
  const wide = await ctx.network('Wide', [a]);
  const chainNodes = [step('w', 'agent', { agentId: a.id }), ...Array.from({ length: 448 }, (_, i) => step(`p${i}`, 'parallel')), out('w')];
  const chainEdges = [edge('w', 'p0', 'text'), ...Array.from({ length: 447 }, (_, i) => edge(`p${i}`, `p${i + 1}`, 'done')), edge('p447', 'out', 'done')];
  const big = await ctx.publish(pipelines, 'Big', { net: wide, nodes: chainNodes, edges: chainEdges });
  const holder = await ctx.network('Holder', [], [wide]);
  const fives = [0, 1, 2, 3, 4].map(i => step(`s${i}`, 'subnetwork', { pipelineId: big.id, version: 1 }));
  await check([...fives, step('out', 'output', { include: fives.map(item => item.id) })], fives.map((_, i) => edge(`s${i}`, 'out', 'text')), 'PIPELINE_TOO_LARGE', holder);
  await check([...fives.slice(0, 4), step('out', 'output', { include: fives.slice(0, 4).map(item => item.id) })], [0, 1, 2, 3].map(i => edge(`s${i}`, 'out', 'text')), 'valid', holder);
});

test('the MVP pipeline: two research steps run at the same time, the join waits for both, the reviewer sees only what its edges bring, the approval waits for the owner, the report is saved', async t => {
  const ctx = await fixture(t), { pipelines, runner, jobs, worker, ready } = ctx.open();
  await ready;
  const pipeline = await ctx.publish(pipelines, 'Market report', demo(ctx.agents));
  assert.equal((await jobs.list()).total, 0, 'publishing started nothing');
  await refused(runner.startRun(pipeline.id, { version: 1 }), 'CONFIRMATION_REQUIRED');
  const { runId } = await runner.startRun(pipeline.id, { version: 1, confirm: true, input: { text: 'Electric bikes in Europe.' } });
  // True parallelism: both research attempts are running at once (neither has finished), and nothing after the join started.
  await until(() => worker.attempts.size === 2, 'both research steps started');
  const [first, second] = [...worker.attempts.values()];
  await first.own.launching(); await first.own.spawned({ pid: 1 }); await second.own.launching(); await second.own.spawned({ pid: 2 });
  const running = await Promise.all([first, second].map(async entry => (await jobs.read(entry.own.jobId)).job.status));
  assert.deepEqual([running, worker.active], [['running', 'running'], 2], 'two step jobs run at the same time');
  const byNode = Object.fromEntries([first, second].map(entry => [entry.job.nodeId, entry]));
  assert.deepEqual(Object.keys(byNode).sort(), [N('researchA'), N('researchB')].sort());
  await first.own.finish(done(`Findings of ${first.job.nodeId === N('researchA') ? 'A' : 'B'}.`)); first.end();
  await tick(60);
  let run = await ctx.runOf(runner, runId);
  assert.deepEqual([run.nodes[N('join')].status, run.nodes[N('review')].status, worker.attempts.size], ['pending', 'pending', 2], 'the join waits for the other branch');
  await second.own.finish(done(`Findings of ${second.job.nodeId === N('researchA') ? 'A' : 'B'}.`)); second.end();
  await until(() => worker.attempts.size === 3, 'the reviewer started');
  const review = [...worker.attempts.values()][2], reviewInput = review.job.request.input.text;
  assert.equal(review.job.nodeId, N('review'));
  assert.match(reviewInput, /Run input:\n {2}Electric bikes in Europe\./);
  assert.match(reviewInput, /Result of step “researchA” \(n_[0-9a-f]{12}\):\n {2}Findings of A\./);
  assert.match(reviewInput, /Result of step “researchB” \(n_[0-9a-f]{12}\):\n {2}Findings of B\./);
  assert.equal(review.job.request.instructions, 'Review both reports.');
  await finish(review, done('Both reports agree.'));
  run = await until(async () => { const value = await ctx.runOf(runner, runId); return value.status === 'waiting_for_approval' && value; }, 'waiting for approval');
  assert.deepEqual([run.nodes[N('approve')].status, run.nodes[N('approve')].approval.prompt, run.nodes[N('report')].status], ['waiting_for_approval', 'Save the report?', 'pending']);
  assert.deepEqual((await readdir(ctx.file('pipeline-runs', `run__${runId.slice(4)}`))).sort(), ['plan.json', 'run.json', 'run.json.bak'], 'no report before the approval');
  await refused(runner.decide(runId, N('review'), { decision: 'approve' }), 'STEP_STATE');
  await runner.decide(runId, N('approve'), { decision: 'approve' });
  run = await until(async () => { const value = await ctx.runOf(runner, runId); return value.status === 'completed' && value; }, 'completed');
  const report = await readFile(ctx.file('pipeline-runs', `run__${runId.slice(4)}`, 'reports', 'report.md'), 'utf8');
  assert.equal(report, '# Market report\n\n## researchA\n\nFindings of A.\n\n## researchB\n\nFindings of B.\n\n## review\n\nBoth reports agree.\n');
  assert.deepEqual([run.nodes[N('report')].result.text.sha256, run.nodes[N('approve')].approval.decision], [hex(report), 'approved']);
  assert.deepEqual(run.history.map(entry => entry.status), ['running', 'waiting_for_approval', 'running', 'completed']);
  // Three real Network jobs, linked to the run and its steps, each with its own request (one per step; no shared session).
  const { jobs: stepJobs, total } = await jobs.list({ pipelineRunId: runId });
  assert.equal(total, 3);
  for (const job of stepJobs) {
    assert.deepEqual([job.source, job.requester, job.pipelineRunId, job.idempotencyKey], ['pipeline', { kind: 'pipeline', id: runId }, runId, `run:${runId}:node:${job.nodeId}:a1`]);
    assert.deepEqual((await jobs.read(job.id)).request.pipeline, { runId, nodeId: job.nodeId });
  }
  const runEvents = ctx.events.filter(event => event.type === 'pipeline.run').map(event => event.status);
  assert.deepEqual(runEvents, ['running', 'waiting_for_approval', 'running', 'completed']);
  assert.ok(ctx.events.some(event => event.type === 'pipeline.node' && event.nodeId === N('approve') && event.status === 'completed' && event.by === 'owner'));
  assert.ok(ctx.events.every(event => !JSON.stringify(event).includes('Findings')), 'events carry no results');
});

test('typed conditions take the true or the false path, skip the other, and keep their inputs and evidence; the interpreter evaluates no code', async t => {
  const ctx = await fixture(t), { a, b, r } = ctx.agents, { pipelines, runner, worker, ready } = ctx.open();
  await ready;
  let scoreJson;
  autopilot(t, worker, entry => (entry.job.nodeId === N('score') ? { status: 'completed', exitCode: 0, result: { text: 'Scored.', json: scoreJson } } : done(`Ran ${entry.job.nodeId}.`)));
  const rules = { all: [{ path: `${N('score')}.json.result.score`, op: 'gte', value: 0.7 }, { path: `${N('score')}.json.tags`, op: 'contains', value: 'ok' }] };
  const pipeline = await ctx.publish(pipelines, 'Branching', {
    nodes: [step('score', 'agent', { agentId: a.id }), step('if', 'condition', rules), step('high', 'agent', { agentId: b.id }), step('low', 'agent', { agentId: r.id }), step('out', 'output', { include: [N('high'), N('low')] })],
    edges: [edge('score', 'if', 'json'), edge('if', 'high', 'true'), edge('if', 'low', 'false'), edge('high', 'out', 'text'), edge('low', 'out', 'text')] });
  const runWith = async json => {
    scoreJson = json;
    const { runId } = await runner.startRun(pipeline.id, { version: 1, confirm: true });
    return until(async () => { const run = await ctx.runOf(runner, runId); return run.status === 'completed' && run; }, 'completed');
  };
  const high = await runWith({ result: { score: 0.9 }, tags: ['ok'] });
  assert.deepEqual([high.nodes[N('high')].status, high.nodes[N('low')].status], ['completed', 'skipped']);
  const { decision } = high.nodes[N('if')];
  assert.deepEqual([decision.mode, decision.result, decision.rules.map(rule => [rule.actual, rule.matched])], ['all', true, [['0.9', true], ['["ok"]', true]]]);
  assert.deepEqual(high.nodes[N('if')].inputs, [{ node: N('score'), port: 'json' }]);
  const low = await runWith({ result: { score: 0.2 }, tags: ['ok'] });
  assert.deepEqual([low.nodes[N('high')].status, low.nodes[N('low')].status, low.nodes[N('if')].decision.result], ['skipped', 'completed', false]);
  const report = await readFile(ctx.file('pipeline-runs', `run__${low.id.slice(4)}`, 'reports', 'report.md'), 'utf8');
  assert.match(report, /## high\n\n_This step did not run in this run\._\n\n## low\n\nRan n_[0-9a-f]{12}\./);
  // The interpreter: fixed operators over JSON values; a missing value matches nothing; text is only ever compared.
  const json = { s: 'process.exit(1)', n: 3, list: [1, 'two'], nested: { deep: [{ v: true }] } };
  const rule = (path, op, value) => ({ path, op, value, node: 'x', fields: path.split('.') });
  const one = (path, op, value) => decide({ all: [rule(path, op, value)] }, () => json).result;
  assert.deepEqual([one('s', 'eq', 'process.exit(1)'), one('s', 'contains', 'exit'), one('n', 'in', [1, 3]), one('n', 'lt', 4), one('n', 'gt', 4), one('list', 'contains', 'two'), one('nested.deep.0.v', 'eq', true)], [true, true, true, true, false, true, true]);
  assert.deepEqual([one('missing', 'ne', 1), one('missing', 'exists'), one('n', 'exists'), one('s', 'lt', 5), one('constructor', 'exists'), one('list.length', 'eq', 2)], [false, false, true, false, false, false]);
  assert.equal(decide({ any: [rule('n', 'eq', 1), rule('n', 'eq', 3)] }, () => json).result, true);
});

test('an approval waits for the owner across a restart and is never approved by itself; a rejection cancels what follows', async t => {
  const ctx = await fixture(t), { a, r } = ctx.agents, first = ctx.open();
  await first.ready;
  autopilot(t, first.worker, entry => done(`Done ${entry.job.nodeId}.`));
  const pipeline = await ctx.publish(first.pipelines, 'Gated', {
    nodes: [step('draft', 'agent', { agentId: a.id }), step('gate', 'approval', { prompt: 'Go on?' }), step('final', 'agent', { agentId: r.id }), step('out', 'output', { include: [N('final')] })],
    edges: [edge('draft', 'gate', 'text'), edge('gate', 'final', 'done'), edge('final', 'out', 'text')] });
  const { runId } = await first.runner.startRun(pipeline.id, { version: 1, confirm: true });
  await until(async () => (await ctx.runOf(first.runner, runId)).status === 'waiting_for_approval', 'waiting');
  // A job that "approves" in its result, a restart and time passing: still waiting, no further job.
  await first.runner.close(); await first.jobs.close();
  ctx.advance(3 * 3_600_000);
  const second = ctx.open();
  await second.ready;
  autopilot(t, second.worker, entry => done(`Done ${entry.job.nodeId}.`));
  for (let i = 0; i < 5; i++) await second.runner.tick();
  const waiting = await ctx.runOf(second.runner, runId);
  assert.deepEqual([waiting.status, waiting.nodes[N('gate')].status, waiting.nodes[N('final')].status, (await second.jobs.list({ pipelineRunId: runId })).total], ['waiting_for_approval', 'waiting_for_approval', 'pending', 1]);
  await refused(second.runner.decide(runId, N('gate'), { decision: 'yes' }), 'INVALID_INPUT');
  await refused(second.runner.decide(runId, `${N('gate')}/${N('x')}`, { decision: 'approve' }), 'NOT_FOUND');
  await second.runner.decide(runId, N('gate'), { decision: 'approve' });
  await refused(second.runner.decide(runId, N('gate'), { decision: 'approve' }), 'STEP_STATE');
  const finished = await until(async () => { const run = await ctx.runOf(second.runner, runId); return run.status === 'completed' && run; }, 'completed after approval');
  assert.ok(finished.deadlineAt > finished.startedAt + 7_200_000, 'the wait for the owner did not count against the deadline');
  // Reject: the steps after the approval never run; the run ends cancelled with the reason.
  const { runId: rejectedId } = await second.runner.startRun(pipeline.id, { version: 1, confirm: true });
  await until(async () => (await ctx.runOf(second.runner, rejectedId)).status === 'waiting_for_approval', 'waiting again');
  await second.runner.decide(rejectedId, N('gate'), { decision: 'reject' });
  const rejected = await until(async () => { const run = await ctx.runOf(second.runner, rejectedId); return run.status === 'cancelled' && run; }, 'cancelled');
  assert.deepEqual([rejected.errorCode, rejected.nodes[N('gate')].errorCode, rejected.nodes[N('final')].status, rejected.nodes[N('out')].status], ['APPROVAL_REJECTED', 'APPROVAL_REJECTED', 'cancelled', 'cancelled']);
  assert.equal((await second.jobs.list({ pipelineRunId: rejectedId })).total, 1, 'only the step before the approval ran');
  assert.equal(rejected.nodes[N('gate')].status, 'cancelled');
  const loose = await ctx.publish(second.pipelines, 'Gated loosely', { ...(await second.pipelines.version(pipeline.id, 1)).version, settings: { maxParallel: 2, deadlineMs: 7_200_000, failurePolicy: 'continue_independent' } });
  const { runId: looseId } = await second.runner.startRun(loose.id, { version: 1, confirm: true });
  await until(async () => (await ctx.runOf(second.runner, looseId)).status === 'waiting_for_approval', 'waiting (continue_independent)');
  await second.runner.decide(looseId, N('gate'), { decision: 'reject' });
  const looseEnd = await until(async () => { const run = await ctx.runOf(second.runner, looseId); return run.status === 'cancelled' && run; }, 'cancelled (continue_independent)');
  assert.deepEqual([looseEnd.nodes[N('final')].status, looseEnd.nodes[N('final')].errorCode, (await second.jobs.list({ pipelineRunId: looseId })).total], ['cancelled', 'UPSTREAM_FAILED', 1]);
});

test('cancelling a run cancels its running step jobs and every step that has not run', async t => {
  const ctx = await fixture(t), { pipelines, runner, jobs, worker, ready } = ctx.open();
  await ready;
  const pipeline = await ctx.publish(pipelines, 'Long', demo(ctx.agents));
  const { runId } = await runner.startRun(pipeline.id, { version: 1, confirm: true });
  await until(() => worker.attempts.size === 2, 'both started');
  for (const entry of worker.attempts.values()) { await entry.own.launching(); await entry.own.spawned({ pid: 7 }); }
  const { run } = await runner.cancel(runId);
  assert.equal(run.status, 'cancelled');
  assert.deepEqual(Object.values(run.nodes).map(node => [node.status, node.errorCode]), Array(6).fill(['cancelled', 'RUN_STOPPED']));
  const stepJobs = (await jobs.list({ pipelineRunId: runId })).jobs;
  assert.deepEqual(stepJobs.map(job => job.status), ['cancelled', 'cancelled']);
  assert.deepEqual(worker.cancels.sort(), [...worker.attempts.keys()].sort(), 'the worker was told to stop both attempts');
  await tick(50);
  assert.equal(worker.attempts.size, 2, 'nothing started afterwards');
  await refused(runner.cancel(runId), 'RUN_FINISHED');
  assert.equal((await ctx.runOf(runner, runId)).history.at(-1).by, 'owner');
});

test('restart: an interrupted step job blocks what follows with its reason until the owner retries it; a submit cut short is found again by its key, never doubled', async t => {
  const ctx = await fixture(t), first = ctx.open();
  await first.ready;
  const pipeline = await ctx.publish(first.pipelines, 'Chain', chain(ctx.agents));
  const { runId } = await first.runner.startRun(pipeline.id, { version: 1, confirm: true });
  await until(() => first.worker.attempts.size === 1, 'first step started');
  const [entry] = first.worker.attempts.values();
  await entry.own.launching(); await entry.own.spawned({ pid: 99 });
  await first.runner.close(); await first.jobs.close(); entry.end();
  const second = ctx.open();
  await second.ready;
  const blocked = await until(async () => { const run = await ctx.runOf(second.runner, runId); return run.status === 'blocked' && run; }, 'blocked');
  const node = blocked.nodes[N('first')], [job] = (await second.jobs.list({ pipelineRunId: runId })).jobs;
  assert.deepEqual([node.status, node.errorCode, job.status, job.outcome, blocked.nodes[N('second')].status], ['blocked', 'APP_STOPPED', 'interrupted', 'uncertain', 'pending']);
  assert.match(node.reason, new RegExp(`Job ${job.id} ended interrupted: .*Retry the job \\(confirming it\\) or close it\\.`));
  for (let i = 0; i < 5; i++) await second.runner.tick();
  assert.deepEqual([(await second.jobs.list({ pipelineRunId: runId })).total, second.worker.attempts.size], [1, 0], 'nothing resubmitted or relaunched on its own');
  autopilot(t, second.worker, item => done(`Done ${item.job.nodeId}.`));
  await second.jobs.retry(job.id, { expectedRevision: job.revision, confirm: true, confirmUncertain: true });
  const completed = await until(async () => { const run = await ctx.runOf(second.runner, runId); return run.status === 'completed' && run; }, 'completed after the owner retried');
  assert.deepEqual([completed.nodes[N('first')].jobId, completed.nodes[N('first')].result.attemptId], [job.id, (await second.jobs.read(job.id)).job.currentAttemptId], 'the same job, its second attempt');
  assert.equal((await second.jobs.list({ pipelineRunId: runId })).total, 2);
  // A submit that was accepted but whose answer was lost (the app stopped before saving the job ID): the same key finds it.
  let lose = true;
  const third = ctx.open({ jobs: jobs => ({ list: (...args) => jobs.list(...args), read: (...args) => jobs.read(...args), cancel: (...args) => jobs.cancel(...args), settings: () => jobs.settings(),
    submit: async (...args) => { const answer = await jobs.submit(...args); if (lose) throw new Error('the app stopped'); return answer; } }) });
  await third.ready;
  autopilot(t, third.worker, item => done(`Done ${item.job.nodeId}.`));
  const { runId: lostId } = await third.runner.startRun(pipeline.id, { version: 1, confirm: true });
  await until(async () => (await third.jobs.list({ pipelineRunId: lostId })).total === 1, 'accepted once');
  for (let i = 0; i < 3; i++) await third.runner.tick();
  const pendingIntent = await ctx.runOf(third.runner, lostId);
  assert.deepEqual([pendingIntent.nodes[N('first')].status, pendingIntent.nodes[N('first')].jobId, (await third.jobs.list({ pipelineRunId: lostId })).total], ['running', null, 1]);
  await third.runner.close();
  lose = false;
  const fourth = new PipelineRunner({ dataDir: ctx.dataDir, pipelines: third.pipelines, jobs: third.jobs, now: ctx.now, pollMs: 5 });
  t.after(() => fourth.close());
  await fourth.start();
  const lost = await until(async () => { const run = (await fourth.read(lostId)).run; return run.status === 'completed' && run; }, 'completed after the restart');
  assert.equal((await third.jobs.list({ pipelineRunId: lostId })).total, 2, 'one job per step');
  assert.deepEqual(lost.nodes[N('first')].jobIds.length, 1);
});

test('a running run keeps its exact pinned versions: editing and republishing the pipeline, its sub-pipeline and the networks changes nothing', async t => {
  const ctx = await fixture(t), { a, b } = ctx.agents, { pipelines, runner, worker, registry, ready } = { ...ctx.open(), registry: ctx.registry };
  await ready;
  const child = await ctx.network('Child', [b]), parent = await ctx.network('Parent', [a], [child]);
  const childPipeline = await ctx.publish(pipelines, 'Child work', { net: child, nodes: [step('c', 'agent', { agentId: b.id, instructions: 'child v1' }), step('cout', 'output', { name: 'summary', include: [N('c')] })], edges: [edge('c', 'cout', 'text')] });
  const parentPipeline = await ctx.publish(pipelines, 'Parent work', { net: parent, nodes: [step('p', 'agent', { agentId: a.id, instructions: 'parent v1' }), step('sub', 'subnetwork', { pipelineId: childPipeline.id, version: 1 }, ''), step('out', 'output', { include: [N('p'), N('sub')] })],
    edges: [edge('p', 'sub', 'text'), edge('p', 'out', 'text'), edge('sub', 'out', 'text')] });
  const { runId } = await runner.startRun(parentPipeline.id, { version: 1, confirm: true, input: { text: 'Topic.' } });
  const planFile = ctx.file('pipeline-runs', `run__${runId.slice(4)}`, 'plan.json'), planBytes = await readFile(planFile, 'utf8');
  const { plan } = await runner.read(runId);
  const nested = `${N('sub')}/${N('c')}`;
  assert.deepEqual(plan.nodes.map(item => item.id), [N('p'), nested, `${N('sub')}/${N('cout')}`, N('out')]);
  assert.deepEqual(plan.groups.map(group => [group.id, group.pipelineId, group.version, group.networkId, group.networkVersion]), [[N('sub'), childPipeline.id, 1, child.id, 1]]);
  assert.deepEqual(plan.pins.pipelines, [{ pipelineId: childPipeline.id, version: 1, sha256: childPipeline.publishedVersions[0].sha256 }]);
  // Edits while the run waits on its first step.
  await until(() => worker.attempts.size === 1, 'first step');
  const childDraft = (await pipelines.get(childPipeline.id)).pipeline;
  const changed = await pipelines.update(childPipeline.id, { expectedRevision: childDraft.revision, nodes: childDraft.nodes.map(item => (item.type === 'agent' ? { ...item, config: { ...item.config, instructions: 'child v2' } } : item)) });
  await pipelines.publish(childPipeline.id, { expectedRevision: changed.pipeline.revision });
  const parentDraft = (await pipelines.get(parentPipeline.id)).pipeline;
  const repinned = await pipelines.update(parentPipeline.id, { expectedRevision: parentDraft.revision, nodes: parentDraft.nodes.map(item => (item.type === 'subnetwork' ? { ...item, config: { ...item.config, version: 2 } } : item.type === 'agent' ? { ...item, config: { ...item.config, instructions: 'parent v2' } } : item)) });
  await pipelines.publish(parentPipeline.id, { expectedRevision: repinned.pipeline.revision });
  const childNet = (await registry.network(child.id)).network;
  await registry.updateNetwork(child.id, { expectedRevision: childNet.revision, name: 'Child renamed' });
  autopilot(t, worker, entry => done(`${entry.job.request.instructions} answered.`));
  const run = await until(async () => { const value = await ctx.runOf(runner, runId); return value.status === 'completed' && value; }, 'completed');
  assert.equal(await readFile(planFile, 'utf8'), planBytes, 'plan.json unchanged');
  const instructions = await Promise.all([...worker.attempts.values()].map(entry => [entry.job.nodeId, entry.job.request.instructions]));
  assert.deepEqual(instructions, [[N('p'), 'parent v1'], [nested, 'child v1']]);
  assert.equal(run.nodes[nested].status, 'completed');
  const report = await readFile(ctx.file('pipeline-runs', `run__${runId.slice(4)}`, 'reports', 'report.md'), 'utf8');
  assert.equal(report, '# Parent work\n\n## p\n\nparent v1 answered.\n\n## Child work\n\n# Child work\n\n## c\n\nchild v1 answered.\n');
  assert.ok((await readdir(ctx.file('pipeline-runs', `run__${runId.slice(4)}`, 'reports'))).includes(`${N('sub')}.summary.md`), 'the nested output keeps its own file');
  // A new run of version 1 still uses child v1; the new version 2 uses child v2.
  const { plan: again } = await runner.read((await runner.startRun(parentPipeline.id, { version: 1, confirm: true })).runId);
  assert.deepEqual([again.pipeline.version, again.groups[0].version, again.nodes[0].config.instructions, again.nodes[1].config.instructions], [1, 1, 'parent v1', 'child v1']);
  const { plan: second } = await runner.read((await runner.startRun(parentPipeline.id, { version: 2, confirm: true })).runId);
  assert.deepEqual([second.groups[0].version, second.nodes[1].config.instructions], [2, 'child v2']);
});

test('a registration switched off mid-run: the running step finishes, the next step is refused and the run fails with the reason; a start compiles again', async t => {
  const ctx = await fixture(t), { pipelines, runner, jobs, worker, ready } = ctx.open();
  await ready;
  const pipeline = await ctx.publish(pipelines, 'Chain', chain(ctx.agents));
  const { runId } = await runner.startRun(pipeline.id, { version: 1, confirm: true });
  await until(() => worker.attempts.size === 1, 'first step');
  await ctx.registry.updateAgent(ctx.agents.r.id, { expectedRevision: 1, enabled: false });
  await finish([...worker.attempts.values()][0], done('First done.'));
  const run = await until(async () => { const value = await ctx.runOf(runner, runId); return value.status === 'failed' && value; }, 'failed');
  assert.deepEqual([run.nodes[N('first')].status, run.nodes[N('second')].status, run.nodes[N('second')].errorCode, run.errorCode, run.nodes[N('out')].status],
    ['completed', 'failed', 'REGISTRATION_DISABLED', 'REGISTRATION_DISABLED', 'cancelled']);
  assert.match(run.reason, /Step “second” failed \(REGISTRATION_DISABLED\), so the run stopped/);
  assert.equal((await jobs.list({ pipelineRunId: runId })).total, 1);
  await refused(runner.startRun(pipeline.id, { version: 1, confirm: true }), 'REGISTRATION_DISABLED');
});

test('time limits: a step over its timeoutMs fails; a run over its deadline is stopped and its jobs cancelled', async t => {
  const ctx = await fixture(t), { pipelines, runner, jobs, worker, ready } = ctx.open();
  await ready;
  const slow = await ctx.publish(pipelines, 'Slow step', chain(ctx.agents, { first: { timeoutMs: 1000 } }));
  const { runId } = await runner.startRun(slow.id, { version: 1, confirm: true });
  await until(() => worker.attempts.size === 1, 'started');
  const [entry] = worker.attempts.values();
  await entry.own.launching(); await entry.own.spawned({ pid: 3 }); // and never finishes
  const timedOut = await until(async () => { const run = await ctx.runOf(runner, runId); return run.status === 'failed' && run; }, 'failed by the step limit', 6000);
  assert.deepEqual([timedOut.nodes[N('first')].errorCode, timedOut.errorCode, (await jobs.read(entry.own.jobId)).job.errorCode], ['TIMEOUT', 'TIMEOUT', 'TIMEOUT']);
  entry.end();
  const late = await ctx.publish(pipelines, 'Deadline', chain(ctx.agents, { settings: { deadlineMs: 60_000 } }));
  const { runId: lateId } = await runner.startRun(late.id, { version: 1, confirm: true });
  await until(() => worker.attempts.size === 2, 'started');
  ctx.advance(61_000);
  const stopped = await until(async () => { const run = await ctx.runOf(runner, lateId); return run.status === 'failed' && run; }, 'past the deadline');
  assert.deepEqual([stopped.errorCode, stopped.nodes[N('first')].status, stopped.nodes[N('second')].status], ['DEADLINE', 'cancelled', 'cancelled']);
  await until(async () => (await jobs.list({ pipelineRunId: lateId })).jobs[0].status === 'cancelled', 'its job cancelled');
});

test('retries are bounded and explicit: a failed step is tried again as a new job up to its retries; an unknown outcome is never retried', async t => {
  const ctx = await fixture(t), { pipelines, runner, jobs, worker, ready } = ctx.open();
  await ready;
  const failures = new Map();
  autopilot(t, worker, entry => {
    const plan = entry.job.request.instructions;
    if (plan === 'always fail') return { status: 'failed', errorCode: 'PROVIDER_ERROR', reason: 'The CLI failed.', exitCode: 1 };
    if (plan === 'unknown') return { status: 'unknown', reason: 'Exit 0 without a result.', exitCode: 0 };
    if (plan === 'fail once' && !failures.has(entry.job.nodeId)) { failures.set(entry.job.nodeId, true); return { status: 'failed', errorCode: 'RATE_LIMITED', exitCode: 1 }; }
    return done('Fine.');
  });
  const start = async (first, label) => {
    const pipeline = await ctx.publish(pipelines, label, chain(ctx.agents, { first }));
    const { runId } = await runner.startRun(pipeline.id, { version: 1, confirm: true });
    return runId;
  };
  const failing = await start({ instructions: 'always fail', retries: 2 }, 'Always failing');
  const failed = await until(async () => { const run = await ctx.runOf(runner, failing); return run.status === 'failed' && run; }, 'failed after three tries');
  const tries = (await jobs.list({ pipelineRunId: failing })).jobs;
  assert.deepEqual(tries.map(job => job.idempotencyKey).sort(), [1, 2, 3].map(n => `run:${failing}:node:${N('first')}:a${n}`));
  assert.deepEqual([failed.nodes[N('first')].attempt, failed.nodes[N('first')].jobIds.length, failed.nodes[N('first')].errorCode, failed.nodes[N('second')].status], [3, 3, 'PROVIDER_ERROR', 'cancelled']);
  const flaky = await start({ instructions: 'fail once', retries: 1 }, 'Flaky');
  const recovered = await until(async () => { const run = await ctx.runOf(runner, flaky); return run.status === 'completed' && run; }, 'completed on the second try');
  assert.deepEqual([recovered.nodes[N('first')].attempt, (await jobs.list({ pipelineRunId: flaky })).total], [2, 3]);
  const uncertain = await start({ instructions: 'unknown', retries: 2 }, 'Unknown');
  const blocked = await until(async () => { const run = await ctx.runOf(runner, uncertain); return run.status === 'blocked' && run; }, 'blocked');
  for (let i = 0; i < 3; i++) await runner.tick();
  assert.deepEqual([blocked.nodes[N('first')].errorCode, (await jobs.list({ pipelineRunId: uncertain })).total], ['OUTCOME_UNKNOWN', 1], 'never retried on its own');
  const noRetry = await start({ instructions: 'always fail' }, 'No retry');
  await until(async () => (await ctx.runOf(runner, noRetry)).status === 'failed', 'failed at once');
  assert.equal((await jobs.list({ pipelineRunId: noRetry })).total, 1);
});

test('receipts that do not hold are never used: forged ownership is ignored, a job record of another attempt or run blocks, a changed result file blocks', async t => {
  const ctx = await fixture(t);
  const forged = new Map(); // job ID → how its record is altered on the way to the runner
  const { pipelines, runner, jobs, worker } = ctx.open({ start: false, jobs: real => ({ list: (...args) => real.list(...args), cancel: (...args) => real.cancel(...args), settings: () => real.settings(), submit: (...args) => real.submit(...args),
    read: async id => { const answer = await real.read(id); return forged.has(id) ? { ...answer, job: forged.get(id)(answer.job) } : answer; } }) });
  await jobs.start();
  const pipeline = await ctx.publish(pipelines, 'Chain', chain(ctx.agents));
  const go = async () => { const { runId } = await runner.startRun(pipeline.id, { version: 1, confirm: true }); await runner.tick(); return runId; };
  const runId = await go();
  await until(() => worker.attempts.size === 1, 'started');
  const [entry] = worker.attempts.values();
  await entry.own.launching(); await entry.own.spawned({ pid: 5 });
  // Forged reports: another lease, another attempt. The engine ignores both; the step keeps running.
  assert.equal((await jobs.finish({ ...entry.own, lease: 'forged' }, done('Forged.'))).applied, false);
  assert.equal((await jobs.finish({ ...entry.own, attemptId: `att_${'0'.repeat(20)}` }, done('Forged.'))).applied, false);
  await runner.tick();
  assert.equal((await ctx.runOf(runner, runId)).nodes[N('first')].status, 'running');
  // A record that names a result of another attempt: blocked, and nothing after it starts.
  forged.set(entry.own.jobId, job => ({ ...job, result: job.result && { ...job.result, textRef: `attempts/att__${'1'.repeat(20)}/result.md` } }));
  await entry.own.finish(done('Real result.')); entry.end();
  const decoy = join(ctx.dataDir, 'network', 'jobs', `job__${entry.own.jobId.slice(4)}`, 'attempts', `att__${'1'.repeat(20)}`);
  await mkdir(decoy, { recursive: true }); await writeFile(join(decoy, 'result.md'), 'Real result.'); // Same bytes and hash, another attempt.
  for (let i = 0; i < 3; i++) await runner.tick();
  let run = await ctx.runOf(runner, runId);
  assert.deepEqual([run.status, run.nodes[N('first')].status, run.nodes[N('first')].errorCode, run.nodes[N('second')].status, worker.attempts.size], ['blocked', 'blocked', 'RECEIPT_INVALID', 'pending', 1]);
  // A job that belongs to another run.
  const other = await go();
  await until(() => worker.attempts.size === 2, 'second run started');
  forged.set([...worker.attempts.values()][1].own.jobId, job => ({ ...job, pipelineRunId: `run_${'2'.repeat(20)}` }));
  await finish([...worker.attempts.values()][1], done('Other.'));
  await until(async () => { await runner.tick(); return (await ctx.runOf(runner, other)).nodes[N('first')].errorCode === 'RECEIPT_INVALID'; }, 'blocked: not its job');
  // A result file changed after the job completed: the hash does not match, so it is not used.
  const third = await go();
  await until(() => worker.attempts.size === 3, 'third run started');
  const last = [...worker.attempts.values()][2];
  await finish(last, done('Original.'));
  const { job } = await jobs.read(last.own.jobId);
  await writeFile(join(ctx.dataDir, 'network', 'jobs', `job__${job.id.slice(4)}`, job.result.textRef), 'Changed.');
  for (let i = 0; i < 3; i++) await runner.tick();
  run = await ctx.runOf(runner, third);
  assert.deepEqual([run.nodes[N('first')].status, run.nodes[N('first')].errorCode, run.nodes[N('second')].status], ['blocked', 'RECEIPT_INVALID', 'pending']);
  // An upstream result changed after it was checked (while an approval held the next step): the next step is not submitted with it.
  const gated = await ctx.publish(pipelines, 'Gated chain', { nodes: [step('first', 'agent', { agentId: ctx.agents.a.id }), step('gate', 'approval'), step('second', 'agent', { agentId: ctx.agents.r.id }), step('out', 'output', { include: [N('second')] })],
    edges: [edge('first', 'gate', 'text'), edge('first', 'second', 'text'), edge('gate', 'second', 'done'), edge('second', 'out', 'text')] });
  const { runId: fourth } = await runner.startRun(gated.id, { version: 1, confirm: true });
  await runner.tick();
  await until(() => worker.attempts.size === 4, 'fourth run started');
  const checked = [...worker.attempts.values()][3];
  await finish(checked, done('Checked.'));
  await until(async () => { await runner.tick(); return (await ctx.runOf(runner, fourth)).nodes[N('gate')].status === 'waiting_for_approval'; }, 'checked and waiting');
  const { job: upstream } = await jobs.read(checked.own.jobId);
  await writeFile(join(ctx.dataDir, 'network', 'jobs', `job__${upstream.id.slice(4)}`, upstream.result.textRef), 'Tampered.');
  await runner.decide(fourth, N('gate'), { decision: 'approve' });
  await runner.tick();
  run = await ctx.runOf(runner, fourth);
  assert.deepEqual([run.status, run.nodes[N('first')].status, run.nodes[N('second')].status, run.nodes[N('second')].errorCode, run.nodes[N('second')].jobId, worker.attempts.size], ['blocked', 'completed', 'blocked', 'ARTIFACT_INVALID', null, 4]);
});

test('the job engine link: only the runner sets it, it is stored and filterable, and an open run keeps its jobs (no delete, logs kept)', async t => {
  const ctx = await fixture(t), { pipelines, runner, jobs, worker, ready } = ctx.open();
  await ready;
  const runId = `run_${'a'.repeat(20)}`, nodeId = `${N('sub')}/${N('c')}`;
  const body = { agentId: ctx.agents.a.id, input: { text: 'x' }, pipeline: { runId, nodeId } };
  await refused(jobs.submit(body), 'PIPELINE_LINK_REFUSED');
  await refused(jobs.submit(body, { requester: { kind: 'pipeline', id: `run_${'b'.repeat(20)}` } }), 'PIPELINE_LINK_REFUSED');
  await refused(jobs.submit({ ...body, pipeline: { runId, nodeId: 'n_1' } }, { requester: { kind: 'pipeline', id: runId } }), 'INVALID_INPUT');
  await refused(jobs.submit({ ...body, pipeline: { runId, nodeId, extra: 1 } }, { requester: { kind: 'pipeline', id: runId } }), 'INVALID_INPUT');
  await refused(jobs.list({ pipelineRunId: 'run_1' }), 'INVALID_INPUT');
  const linked = await jobs.submit(body, { requester: { kind: 'pipeline', id: runId } });
  assert.deepEqual([linked.job.pipelineRunId, linked.job.nodeId, linked.job.source, (await jobs.read(linked.jobId)).request.pipeline], [runId, nodeId, 'pipeline', { runId, nodeId }]);
  assert.deepEqual([(await jobs.list({ pipelineRunId: runId })).total, (await jobs.list({ pipelineRunId: `run_${'c'.repeat(20)}` })).total], [1, 0]);
  const plain = await jobs.submit({ agentId: ctx.agents.a.id, input: { text: 'x' } });
  assert.deepEqual([plain.job.pipelineRunId, plain.job.nodeId, 'pipeline' in (await jobs.read(plain.jobId)).request], [null, null, false], 'jobs without a link are unchanged');
  // An open run holds its step jobs: they cannot be deleted; once the run ended they can.
  autopilot(t, worker, entry => (entry.job.pipelineRunId ? done('Step.') : done('Plain.')));
  const pipeline = await ctx.publish(pipelines, 'Gated', {
    nodes: [step('one', 'agent', { agentId: ctx.agents.a.id }), step('gate', 'approval'), step('out', 'output', { include: [N('one')] })], edges: [edge('one', 'gate', 'text'), edge('gate', 'out', 'done')] });
  const { runId: open } = await runner.startRun(pipeline.id, { version: 1, confirm: true });
  await until(async () => (await ctx.runOf(runner, open)).status === 'waiting_for_approval', 'waiting');
  const [stepJob] = (await jobs.list({ pipelineRunId: open })).jobs;
  await refused(jobs.remove(stepJob.id, { expectedRevision: stepJob.revision }), 'JOB_IN_USE');
  // Retention: an old finished step job of an open run keeps its logs; the same job of an ended run loses them.
  const logs = join(ctx.dataDir, 'network', 'jobs', `job__${stepJob.id.slice(4)}`, 'attempts', `att__${stepJob.currentAttemptId.slice(4)}`, 'stream.jsonl');
  await writeFile(logs, '{}\n');
  ctx.advance(40 * 86_400_000);
  const later = ctx.open({ start: false });
  await later.runner.list(); await later.jobs.list();
  assert.equal(await readFile(logs, 'utf8'), '{}\n', 'kept while the run is open');
  await runner.decide(open, N('gate'), { decision: 'approve' });
  await until(async () => (await ctx.runOf(runner, open)).status === 'completed', 'completed');
  const last = ctx.open({ start: false });
  await last.runner.list(); await last.jobs.list();
  await assert.rejects(readFile(logs, 'utf8'), { code: 'ENOENT' }, 'swept once the run ended');
  const current = (await last.jobs.read(stepJob.id)).job;
  assert.deepEqual((await last.jobs.remove(stepJob.id, { expectedRevision: current.revision })).deleted, stepJob.id);
});

test('caps: maxParallel and the job pool’s ceiling bound the steps in flight, within a run and across runs', async t => {
  const ctx = await fixture(t), { a, b } = ctx.agents, { pipelines, runner, jobs, worker, ready } = ctx.open();
  await ready;
  const entries = () => [...worker.attempts.values()];
  const settled = async (runId, status) => until(async () => { const run = await ctx.runOf(runner, runId); return run.status === status && run; }, status);
  const fan = { nodes: [step('one', 'agent', { agentId: a.id }), step('two', 'agent', { agentId: b.id }), step('out', 'output', { include: [N('one'), N('two')] })], edges: [edge('one', 'out', 'text'), edge('two', 'out', 'text')] };
  // maxParallel 1: two independent steps never run at once.
  const single = await ctx.publish(pipelines, 'One at a time', { ...fan, settings: { maxParallel: 1 } });
  const { runId: serialRun } = await runner.startRun(single.id, { version: 1, confirm: true });
  await until(() => worker.attempts.size === 1, 'one step');
  await tick(60);
  let run = await ctx.runOf(runner, serialRun);
  assert.deepEqual([worker.attempts.size, Object.values(run.nodes).map(node => node.status).sort()], [1, ['pending', 'ready', 'running']]);
  await finish(entries()[0], done('First.'));
  await until(() => worker.attempts.size === 2, 'then the other');
  await finish(entries()[1], done('Second.'));
  await settled(serialRun, 'completed');
  // The job pool's ceiling bounds steps across runs: with one job slot, two runs of maxParallel 2 run one step at a time.
  await jobs.updateSettings({ expectedRevision: (await jobs.settings()).settings.revision, maxConcurrentJobs: 1 });
  const wide = await ctx.publish(pipelines, 'Two at a time', fan);
  const runs = [(await runner.startRun(wide.id, { version: 1, confirm: true })).runId, (await runner.startRun(wide.id, { version: 1, confirm: true })).runId];
  await until(() => worker.attempts.size === 3, 'one step of the two runs');
  await until(async () => (await Promise.all(runs.map(async id => Object.values((await ctx.runOf(runner, id)).nodes).filter(node => ['ready', 'running'].includes(node.status)).length))).every(n => n === 2), 'every entry step admitted or ready');
  await tick(60);
  const submitted = await Promise.all(runs.map(async id => (await jobs.list({ pipelineRunId: id })).total));
  assert.deepEqual([worker.attempts.size, submitted.reduce((sum, n) => sum + n, 0)], [3, 1], 'one step job submitted in all while the only slot is taken; the others wait as ready');
  autopilot(t, worker, entry => done(`Done ${entry.job.nodeId}.`));
  for (const id of runs) await settled(id, 'completed');
  assert.equal(worker.maxActive, 1);
  await jobs.updateSettings({ expectedRevision: (await jobs.settings()).settings.revision, maxConcurrentJobs: 2 });
});

test('continue_independent lets an independent branch finish; a join of any goes on with the first branch; a Graph relation carries no data', async t => {
  const ctx = await fixture(t), { a, b, r } = ctx.agents, { pipelines, runner, jobs, worker, ready } = ctx.open();
  await ready;
  const entries = () => [...worker.attempts.values()], byNode = id => entries().find(entry => entry.job.nodeId === id);
  const settled = async (runId, status) => until(async () => { const run = await ctx.runOf(runner, runId); return run.status === status && run; }, status);
  // continue_independent: one branch fails while the other runs; the other is not stopped and finishes; what follows the failure is cancelled.
  const branches = await ctx.publish(pipelines, 'Independent', { settings: { failurePolicy: 'continue_independent' },
    nodes: [step('one', 'agent', { agentId: a.id }), step('after', 'agent', { agentId: r.id }), step('two', 'agent', { agentId: b.id }), step('out', 'output', { include: [N('after'), N('two')] })],
    edges: [edge('one', 'after', 'text'), edge('after', 'out', 'text'), edge('two', 'out', 'text')] });
  const { runId } = await runner.startRun(branches.id, { version: 1, confirm: true });
  await until(() => worker.attempts.size === 2, 'both branches');
  await finish(byNode(N('one')), { status: 'failed', errorCode: 'PROVIDER_ERROR', exitCode: 1 });
  await until(async () => (await ctx.runOf(runner, runId)).nodes[N('after')].status === 'cancelled', 'what follows the failure is cancelled');
  let run = await ctx.runOf(runner, runId);
  assert.deepEqual([run.status, run.nodes[N('two')].status, (await jobs.read(byNode(N('two')).own.jobId)).job.status], ['running', 'running', 'preparing'], 'the other branch goes on');
  await finish(byNode(N('two')), done('Two.'));
  run = await settled(runId, 'failed');
  assert.deepEqual([run.errorCode, run.nodes[N('two')].status, run.nodes[N('after')].errorCode, run.nodes[N('out')].status], ['PROVIDER_ERROR', 'completed', 'UPSTREAM_FAILED', 'cancelled']);
  // A join of any goes on with the first branch; the step after it sees only what had arrived.
  const race = await ctx.publish(pipelines, 'Race', {
    nodes: [step('fast', 'agent', { agentId: a.id }), step('slow', 'agent', { agentId: b.id }), step('first', 'join', { require: 'any' }), step('use', 'agent', { agentId: r.id }), step('out', 'output', { include: [N('use')] })],
    edges: [edge('fast', 'first', 'text'), edge('slow', 'first', 'text'), edge('first', 'use', 'done'), edge('use', 'out', 'text')] });
  const { runId: raceId } = await runner.startRun(race.id, { version: 1, confirm: true });
  await until(() => byNode(N('fast')) && byNode(N('slow')), 'both racing');
  await finish(byNode(N('fast')), done('Fast result.'));
  await until(() => byNode(N('use')), 'the step after the join started while the slow one runs');
  const input = byNode(N('use')).job.request.input.text;
  assert.match(input, /Fast result\./);
  assert.ok(!input.includes(N('slow')), 'the slow branch had not arrived');
  await finish(byNode(N('slow')), done('Slow result.'));
  await finish(byNode(N('use')), done('Used.'));
  assert.deepEqual((await settled(raceId, 'completed')).nodes[N('first')].inputs, [{ node: N('fast'), port: 'text' }]);
  // Team has a share_result relation from research A to the reviewer; without an execution edge nothing flows along it,
  // even when A finished before the reviewer became ready.
  const apart = await ctx.publish(pipelines, 'Apart', { nodes: [step('a', 'agent', { agentId: a.id }), step('z', 'agent', { agentId: b.id }), step('r', 'agent', { agentId: r.id }), step('out', 'output', { include: [N('a'), N('r')] })],
    edges: [edge('a', 'out', 'text'), edge('z', 'r', 'text'), edge('r', 'out', 'text')] });
  const { runId: apartId } = await runner.startRun(apart.id, { version: 1, confirm: true });
  await until(() => byNode(N('a')) && byNode(N('z')), 'a and z started');
  await finish(byNode(N('a')), done('Secret findings of A.'));
  await until(async () => (await ctx.runOf(runner, apartId)).nodes[N('a')].status === 'completed', 'a recorded');
  await finish(byNode(N('z')), done('Notes of Z.'));
  await until(() => byNode(N('r')), 'the reviewer started');
  const reviewerInput = byNode(N('r')).job.request.input.text;
  assert.ok(reviewerInput.includes('Notes of Z.') && !reviewerInput.includes('Secret findings'), 'a drawn relation shares no data');
  await finish(byNode(N('r')), done('Reviewed.'));
  assert.deepEqual((await settled(apartId, 'completed')).nodes[N('r')].inputs, [{ node: N('z'), port: 'text' }]);
});

test('damaged run files: a run.json read from its backup never goes on by itself; a changed plan.json makes the run unavailable; a pass that cannot be saved says why', async t => {
  const ctx = await fixture(t), first = ctx.open();
  await first.ready;
  const pipeline = await ctx.publish(first.pipelines, 'Chain', chain(ctx.agents));
  const ids = [];
  for (let i = 0; i < 3; i++) { ids.push((await first.runner.startRun(pipeline.id, { version: 1, confirm: true })).runId); }
  await until(() => first.worker.attempts.size === 2, 'two steps started (the pool holds two)');
  await first.runner.close(); await first.jobs.close();
  for (const entry of first.worker.attempts.values()) entry.end();
  const folder = id => ctx.file('pipeline-runs', `run__${id.slice(4)}`);
  await writeFile(join(folder(ids[0]), 'run.json'), '{"schema":');
  const planText = await readFile(join(folder(ids[1]), 'plan.json'), 'utf8');
  await writeFile(join(folder(ids[1]), 'plan.json'), planText.replace('"Chain"', '"Chainz"'));
  const second = ctx.open();
  await second.ready;
  for (let i = 0; i < 3; i++) await second.runner.tick();
  const restored = await ctx.runOf(second.runner, ids[0]);
  assert.deepEqual([restored.status, restored.errorCode], ['interrupted', 'RESTORED_FROM_BACKUP']);
  assert.ok((await readdir(folder(ids[0]))).some(name => name.startsWith('run.json.corrupt-')), 'the damaged copy was set aside');
  await refused(second.runner.read(ids[1]), 'NETWORK_CONTENT_INVALID');
  assert.deepEqual((await second.runner.list()).unavailable, [{ id: ids[1], code: 'NETWORK_CONTENT_INVALID' }]);
  assert.equal((await second.jobs.list({ pipelineRunId: ids[0] })).total, 1, 'nothing new submitted for the restored run');
  await refused(second.runner.decide(ids[0], N('first'), { decision: 'approve' }), 'STEP_STATE');
  assert.equal((await second.runner.cancel(ids[0])).run.status, 'cancelled', 'the owner can still cancel it');
  // A pass whose save fails leaves the run as saved and says why in its view.
  const third = ids[2], runFile = join(folder(third), 'run.json');
  await rm(`${runFile}.bak`, { force: true });
  await mkdir(`${runFile}.bak`); // A folder where the backup goes: the next save fails.
  const before = await ctx.runOf(second.runner, third);
  autopilot(t, second.worker, entry => done(`Done ${entry.job.nodeId}.`));
  const failing = await until(async () => { const run = await ctx.runOf(second.runner, third); return run.passError && run; }, 'a pass error');
  assert.deepEqual([failing.revision, failing.passError.code], [before.revision, 'NETWORK_WRITE_FAILED']);
  await rm(`${runFile}.bak`, { recursive: true });
  const recovered = await until(async () => { const run = await ctx.runOf(second.runner, third); return run.status === 'completed' && run; }, 'completed once saving works');
  assert.equal(recovered.passError, null);
});
