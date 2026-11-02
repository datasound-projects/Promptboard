// Task 12 handoffs (src/network/delegation.mjs, messages.mjs and the job engine's handoff path): an agent's structured request
// at the end of its report is only a request. Delegation along a `delegate` relation with the owner's policy (depth, fan-out,
// budget share, no escalation, no other project, no cycles, owner approval), refusals recorded with nothing created, one child
// per key across restarts, revocation at claim, cancellation of a whole tree, questions answered by the owner, bounded
// messages with read receipts apart from execution, and none of it needing A2A. Real Base, Store, registry and job engine on
// temporary folders; the only worker is the deterministic fake (tests/helpers/network-worker.mjs), so no CLI starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Base } from '../src/base.mjs';
import { Store } from '../src/store.mjs';
import { NetworkRegistry } from '../src/network/registry.mjs';
import { NetworkJobs } from '../src/network/jobs.mjs';
import { Delegation, parseHandoff } from '../src/network/delegation.mjs';
import { fakeWorker } from './helpers/network-worker.mjs';

const hex = text => createHash('sha256').update(text).digest('hex');
const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await tick()) { const value = await check(); if (value) return value; }
  assert.fail(`timed out: ${label}`);
}
const exists = path => access(path).then(() => true, () => false);
const statuses = job => job.history.map(entry => entry.status);
const N = id => `n_${hex(`node:${id}`).slice(0, 12)}`;
const rel = (from, to, relation = 'delegate') => ({ id: `e_${hex(`${from.id}>${to.id}:${relation}`).slice(0, 12)}`, from: N(from.id), to: N(to.id), relation });
const delegate = (...tasks) => ({ promptboard: { delegate: tasks } });
const OWNER = { owner: true };

/**
 * Base agents lead, helper (Claude), checker (Codex), outsider (Claude) and gem (Gemini), registered (lead, helper and outsider
 * may work on project p1), and the network "Team": delegate relations lead → helper, lead → checker, lead → gem,
 * helper → checker, helper → lead; lead → outsider is only a `message` relation. `open()` builds an engine with the fake worker
 * whose structured result comes from `ctx.asks` (by input text, first attempt only) and the delegation policy beside it.
 */
async function fixture(t, { clients = null } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-network-delegation-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const base = new Base({ store: new Store(dataDir) });
  for (const [id, provider] of [['lead', 'claude'], ['helper', 'claude'], ['checker', 'codex'], ['outsider', 'claude'], ['gem', 'gemini']]) await base.create({ id, kind: 'profile', name: id, configuration: { agent: { provider } } });
  let clock = 1_800_000_000_000;
  const now = () => (clock += 1000), projects = ['p1', 'p2'], events = [], engines = [];
  const registry = new NetworkRegistry({ dataDir, base, projects: async () => projects, now });
  const register = async (id, extra = {}) => (await registry.registerAgent({ baseResourceId: id, expectedRevision: (await registry.listAgents()).revision, ...extra })).agent;
  const agents = { lead: await register('lead', { projectAllowlist: ['p1'] }), helper: await register('helper', { projectAllowlist: ['p1'] }), checker: await register('checker'),
    outsider: await register('outsider', { projectAllowlist: ['p1'] }), gem: await register('gem') };
  const { lead, helper, checker, outsider, gem } = agents;
  const { network } = await registry.createNetwork({ name: 'Team', nodes: Object.values(agents).map(agent => ({ id: N(agent.id), type: 'agent', agentId: agent.id, position: { x: 0, y: 0 } })),
    edges: [rel(lead, helper), rel(lead, checker), rel(lead, gem), rel(helper, checker), rel(helper, lead), rel(lead, outsider, 'message')] });
  const asks = new Map(); // input text → structured result of a job's first attempt
  const worker = (options = {}) => fakeWorker({ text: job => (job.handoff?.context ? `Final report on: ${job.request.input.text}` : `Report for: ${job.request.input.text}`),
    json: job => (job.handoff?.context && !options.always ? null : asks.get(job.request.input.text)?.(job) ?? null), ...options });
  const open = ({ worker: given = worker(), start = true } = {}) => {
    const jobs = new NetworkJobs({ dataDir, registry, worker: given, now, prepareTimeoutMs: 600_000, events: { append: async event => { events.push(event); return { seq: events.length, id: 'evt' }; } } });
    jobs.delegation = new Delegation({ dataDir, registry, now, ...(clients ? { clients } : {}) });
    engines.push(jobs);
    return Object.assign(jobs, { ready: start ? jobs.start() : Promise.resolve(), worker: given });
  };
  t.after(async () => { for (const jobs of engines) { for (const entry of jobs.worker?.attempts?.values() || []) entry.end?.(); await jobs.close(); } });
  const policy = async (jobs, changes) => jobs.delegation.update({ expectedRevision: (await jobs.delegation.policy()).policy.revision, ...changes });
  const submit = (jobs, agent, text, extra = {}) => jobs.submit({ agentId: agent.id, input: { text }, networkId: network.id, ...extra });
  const settled = (jobs, id, wanted = ['completed', 'failed', 'cancelled', 'waiting_for_input', 'waiting_for_approval']) => until(async () => { const { job } = await jobs.read(id); return wanted.includes(job.status) && job; }, `job ${id} in ${wanted}`);
  const file = (...parts) => join(dataDir, 'network', ...parts);
  /** The job waits for its sub-jobs and all `count` exist (the wait is saved before they are written, so readers can see it first). */
  const delegated = async (jobs, id, count) => { await settled(jobs, id, ['waiting_for_input']); return until(async () => { const { children } = await jobs.read(id); return children.length === count && children; }, `${count} sub-jobs of ${id}`); };
  return { dataDir, registry, agents, network, asks, worker, open, policy, submit, settled, delegated, events, file, now, advance: ms => { clock += ms; } };
}

test('the request format: only a lone promptboard key is a request; malformed ones are errors, never guessed at', () => {
  assert.equal(parseHandoff(null), null);
  assert.equal(parseHandoff({ verdict: 'ok' }), null, 'an ordinary result json');
  assert.deepEqual(parseHandoff({ promptboard: { needs_input: { question: ' Which quarter? ' } } }), { kind: 'needs_input', question: 'Which quarter?' });
  const id = `agt_${'a'.repeat(20)}`;
  assert.deepEqual(parseHandoff(delegate({ agentId: id, task: 'Check it.' })), { kind: 'delegate', tasks: [{ agentId: id, task: 'Check it.', tools: 'none' }] });
  for (const bad of [{ promptboard: {} }, { promptboard: { needs_input: {}, delegate: [] } }, { promptboard: { delegate: [] } }, { promptboard: { delegate: Array(11).fill({ agentId: id, task: 'x' }) } },
    { promptboard: { delegate: [{ agentId: 'agt_x', task: 'x' }] } }, { promptboard: { delegate: [{ agentId: id, task: 'x', model: 'opus' }] } }, { promptboard: { delegate: [{ agentId: id, task: 'x', tools: 'shell' }] } },
    { promptboard: { delegate: [{ agentId: id, task: 'x'.repeat(16 * 1024 + 1) }] } }, { promptboard: { needs_input: { question: 'x'.repeat(2001) } } }, { promptboard: { needs_input: { question: 'Q', extra: 1 } } },
    { promptboard: { needs_input: { question: 'Q' } }, verdict: 'also data' }]) {
    assert.ok(parseHandoff(bad).error, JSON.stringify(bad).slice(0, 80));
  }
});

test('agent A delegates an approved sub-job to agent B along a delegate relation; the child result goes back to A, which runs again with it; no A2A is involved', async t => {
  const ctx = await fixture(t), { lead, helper, outsider, checker } = ctx.agents, jobs = ctx.open();
  ctx.asks.set('Write the release summary.', () => delegate({ agentId: helper.id, task: 'Check the release numbers.' }));
  // Off by default: the prompt offers nothing and a request is refused.
  assert.deepEqual((await jobs.delegation.policy()).policy, { revision: 0, askOwner: false, delegate: false, maxDepth: 2, maxChildren: 3, budgetShare: 50, requireApproval: true });
  await ctx.policy(jobs, { delegate: true });
  const { jobId } = await ctx.submit(jobs, lead, 'Write the release summary.', { projectId: 'p1', limits: { timeoutMs: 600_000 } });
  const [childId] = await ctx.delegated(jobs, jobId, 1), parent = (await jobs.read(jobId)).job;
  assert.deepEqual([parent.awaiting.kind, parent.waiting.for, parent.outcome, parent.result], ['children', 'children', null, null]);
  assert.match(parent.reason, /Delegated 1 sub-job/);
  // The prompt offered exactly the agents of lead's delegate relations that may work on p1 (not outsider: no delegate relation;
  // not checker: not on p1), with the request format.
  const guide = ctx.jobsWorker = jobs.worker.attempts.get(parent.attempts[0].id).job.handoff.guide;
  assert.match(guide, /=== HANDOFFS \(optional; Promptboard checks every request and may refuse it\) ===/);
  assert.ok(guide.includes(helper.id) && !guide.includes(outsider.id) && !guide.includes(checker.id), guide);
  assert.match(guide, /"promptboard": \{"delegate"/);
  assert.equal(parent.attempts[0].handoff.kind, 'delegate');
  const { job: child, request } = await jobs.read(childId), parentRequest = (await jobs.read(jobId)).request;
  assert.deepEqual([child.status, child.source, child.requester, child.parentJobId, child.agentId, child.projectId, child.networkId, child.idempotencyKey],
    ['waiting_for_approval', 'delegation', { kind: 'job', id: jobId }, jobId, helper.id, 'p1', ctx.network.id, 'delegate:a1:0']);
  assert.deepEqual(child.delegation, { by: 'agent', depth: 1, index: 0, parentAttemptId: parent.attempts[0].id, budgetShare: 50, policyRevision: 1 });
  assert.deepEqual(request.delegation, child.delegation, 'the delegation record is part of the immutable accepted request');
  assert.deepEqual([request.tools, request.permissions, request.limits.timeoutMs, request.requireApproval, request.input.text], ['none', parentRequest.permissions, 300_000, true, 'Check the release numbers.']);
  assert.match(request.instructions, new RegExp(`sub-task that job ${jobId} \\(agent ${lead.id}\\) delegated to you`));
  // Nothing runs before the owner approves the sub-job.
  await tick(50);
  assert.equal((await jobs.read(childId)).job.attempts.length, 0);
  await jobs.approve(childId, { expectedRevision: child.revision, decision: 'approve' });
  const done = await ctx.settled(jobs, jobId, ['completed']);
  assert.deepEqual(statuses(done), ['queued', 'preparing', 'running', 'waiting_for_input', 'queued', 'preparing', 'running', 'completed']);
  assert.deepEqual(done.history.map(entry => entry.by), ['owner', 'app', 'worker', 'worker', 'app', 'app', 'worker', 'worker']);
  assert.equal((await jobs.result(jobId)).text, 'Final report on: Write the release summary.');
  // The second attempt read what came back, as data: the request and the child's result.
  const context = jobs.worker.attempts.get(done.attempts[1].id).job.handoff.context;
  assert.match(context, /Your report from your previous attempt, when you handed off:\n {4}Report for: Write the release summary\./);
  assert.match(context, new RegExp(`- request from agent ${lead.id} to agent ${helper.id} \\(sub-job ${childId}, sub-task 1\\)`));
  assert.match(context, new RegExp(`- result from agent ${helper.id} to agent ${lead.id} \\(sub-job ${childId}, sub-task 1\\)[^\\n]*:\\n {4}Report for: Check the release numbers\\.`));
  const { messages, unread } = await jobs.messagesOf(jobId, { reader: OWNER });
  assert.deepEqual(messages.map(message => [message.kind, message.from, message.to, message.jobId, message.task, message.readAt]),
    [['request', { agentId: lead.id }, { agentId: helper.id }, childId, 0, null], ['result', { agentId: helper.id }, { agentId: lead.id }, childId, 0, null]]);
  assert.equal(unread, 0, 'nothing here is addressed to the owner');
  // Events name IDs and kinds only: never the task, the report or the child's result.
  const handoffs = ctx.events.filter(event => event.type === 'job.handoff').map(event => [event.jobId, event.status, event.kind]);
  assert.deepEqual(handoffs, [[jobId, 'waiting', 'delegate'], [jobId, 'continued', 'delegate']]);
  assert.deepEqual(ctx.events.filter(event => event.type === 'job.message').map(event => event.kind), ['request', 'result']);
  assert.ok(!JSON.stringify(ctx.events).includes('release numbers') && !JSON.stringify(ctx.events).includes('Report for'), 'no message body in an event');
  // Local delegation needs no A2A: no federation file, no machine listener, no peer; the policy had no client list either.
  assert.equal(await exists(ctx.file('federation.json')), false);
  assert.equal(await exists(ctx.file('clients.json')), false);
});

test('a refused delegation creates nothing and is recorded: switched off, no relation, escalation, another project, a registration switched off, no network, malformed, one bad sub-task', async t => {
  const ctx = await fixture(t), { lead, helper, outsider, checker } = ctx.agents, jobs = ctx.open();
  const cases = [
    ['off', delegate({ agentId: helper.id, task: 'x' }), 'DELEGATION_OFF', {}],
    ['no relation', delegate({ agentId: outsider.id, task: 'x' }), 'DELEGATION_NOT_ALLOWED', {}],
    ['escalation', delegate({ agentId: helper.id, task: 'x', tools: 'web' }), 'DELEGATION_ESCALATION', {}],
    ['other project', delegate({ agentId: checker.id, task: 'x' }), 'PROJECT_NOT_ALLOWED', { projectId: 'p1' }],
    ['unregistered', delegate({ agentId: `agt_${'0'.repeat(20)}`, task: 'x' }), 'DELEGATION_NOT_ALLOWED', {}],
    ['no network', delegate({ agentId: helper.id, task: 'x' }), 'DELEGATION_NO_NETWORK', { networkId: null }],
    ['malformed', { promptboard: { delegate: [{ agentId: helper.id }] } }, 'HANDOFF_INVALID', {}],
    ['one bad of two', delegate({ agentId: helper.id, task: 'fine' }, { agentId: outsider.id, task: 'not allowed' }), 'DELEGATION_NOT_ALLOWED', {}],
    ['switched off agent', delegate({ agentId: helper.id, task: 'x' }), 'REGISTRATION_DISABLED', {}],
  ];
  for (const [text, json] of cases) ctx.asks.set(text, () => json);
  for (const [text, , code, extra] of cases) {
    if (text === 'no relation') await ctx.policy(jobs, { delegate: true });
    if (text === 'switched off agent') { const { agent } = await ctx.registry.agent(helper.id); await ctx.registry.updateAgent(helper.id, { expectedRevision: agent.revision, enabled: false }); }
    const { jobId } = await ctx.submit(jobs, lead, text, extra);
    const job = await ctx.settled(jobs, jobId, ['completed']);
    assert.match(job.reason, /which was refused/, text);
    assert.deepEqual((await jobs.read(jobId)).children, [], `${text}: no child`);
    assert.equal((await jobs.result(jobId)).text, `Report for: ${text}`, `${text}: the report is the result`);
    const [blocked] = (await jobs.messagesOf(jobId, { reader: OWNER })).messages;
    assert.deepEqual([blocked.kind, blocked.from, blocked.to, blocked.attemptId], ['blocked', { app: true }, OWNER, job.attempts[0].id], text);
    assert.equal(ctx.events.findLast(event => event.type === 'job.handoff' && event.jobId === jobId).errorCode, code, text);
    assert.equal(job.attempts[0].handoff, undefined, `${text}: no handoff recorded on the attempt`);
  }
  assert.equal((await jobs.list({ agentId: helper.id })).total + (await jobs.list({ agentId: outsider.id })).total, 0, 'no sub-job anywhere');
});

test('depth and fan-out ceilings and the handoff rounds hold; delegating back up the chain is a cycle', async t => {
  const ctx = await fixture(t), { lead, helper, checker, gem } = ctx.agents, jobs = ctx.open();
  await ctx.policy(jobs, { delegate: true, requireApproval: false, maxDepth: 1, maxChildren: 2 });
  // Fan-out: three sub-tasks when two are allowed.
  ctx.asks.set('three', () => delegate({ agentId: helper.id, task: 'a' }, { agentId: checker.id, task: 'b' }, { agentId: gem.id, task: 'c' }));
  const three = await ctx.submit(jobs, lead, 'three');
  await ctx.settled(jobs, three.jobId, ['completed']);
  assert.deepEqual((await jobs.read(three.jobId)).children, []);
  assert.equal(ctx.events.findLast(event => event.jobId === three.jobId && event.type === 'job.handoff').errorCode, 'DELEGATION_FANOUT');
  // Depth: lead → helper is depth 1; helper asking for checker would be depth 2.
  ctx.asks.set('deep', () => delegate({ agentId: helper.id, task: 'go deeper' }));
  ctx.asks.set('go deeper', () => delegate({ agentId: checker.id, task: 'too deep' }));
  const deep = await ctx.submit(jobs, lead, 'deep');
  await ctx.settled(jobs, deep.jobId, ['completed']);
  const [middle] = (await jobs.read(deep.jobId)).children;
  assert.equal(ctx.events.findLast(event => event.jobId === middle && event.type === 'job.handoff').errorCode, 'DELEGATION_DEPTH');
  assert.deepEqual((await jobs.read(middle)).children, []);
  assert.equal(jobs.worker.attempts.get((await jobs.read(middle)).job.attempts[0].id).job.handoff, null, 'at the depth limit nothing is offered');
  // Cycle: helper (working for lead) may not hand work back to lead, even with room in depth.
  await ctx.policy(jobs, { maxDepth: 3, maxChildren: 3 });
  ctx.asks.set('loop', () => delegate({ agentId: helper.id, task: 'loop back' }));
  ctx.asks.set('loop back', () => delegate({ agentId: lead.id, task: 'back to the start' }));
  const loop = await ctx.submit(jobs, lead, 'loop');
  await ctx.settled(jobs, loop.jobId, ['completed']);
  const [second] = (await jobs.read(loop.jobId)).children;
  assert.equal(ctx.events.findLast(event => event.jobId === second && event.type === 'job.handoff').errorCode, 'DELEGATION_CYCLE');
  const offered = jobs.worker.attempts.get((await jobs.read(second)).job.attempts[0].id).job.handoff.guide;
  assert.ok(offered.includes(checker.id) && !offered.includes(lead.id), 'the guide never offers an agent already on the chain');
});

test('a second round counts against the fan-out, and five handoffs per job is the ceiling', async t => {
  const ctx = await fixture(t), { lead, helper, checker, gem } = ctx.agents, jobs = ctx.open({ worker: ctx.worker({ always: true }) });
  await ctx.policy(jobs, { delegate: true, askOwner: true, requireApproval: false, maxChildren: 3 });
  ctx.asks.set('rounds', job => (job.attempts.length ? delegate({ agentId: gem.id, task: 'c' }, { agentId: checker.id, task: 'd' }) : delegate({ agentId: helper.id, task: 'a' }, { agentId: checker.id, task: 'b' })));
  const { jobId } = await ctx.submit(jobs, lead, 'rounds');
  const done = await ctx.settled(jobs, jobId, ['completed']);
  assert.deepEqual([(await jobs.read(jobId)).children.length, done.attempts.length], [2, 2]);
  assert.equal(ctx.events.findLast(event => event.jobId === jobId && event.type === 'job.handoff').errorCode, 'DELEGATION_FANOUT');
  // A job that keeps asking: five answered questions, then the sixth is refused and it completes.
  ctx.asks.set('again and again', () => ({ promptboard: { needs_input: { question: 'One more thing?' } } }));
  const asking = await ctx.submit(jobs, lead, 'again and again');
  for (let round = 1; round <= 5; round++) {
    const waiting = await ctx.settled(jobs, asking.jobId, ['waiting_for_input']);
    assert.equal(waiting.attempts.length, round);
    await jobs.answer(asking.jobId, { expectedRevision: waiting.revision, text: `Answer ${round}.` });
  }
  const last = await ctx.settled(jobs, asking.jobId, ['completed']);
  assert.equal(last.attempts.length, 6);
  assert.equal(ctx.events.findLast(event => event.jobId === asking.jobId && event.type === 'job.handoff').errorCode, 'HANDOFF_LIMIT');
  assert.equal(jobs.worker.attempts.get(last.attempts[5].id).job.handoff.guide, '', 'after five handoffs nothing more is offered');
});

test('one child per key: a restart that finds sub-jobs missing creates them once under the same keys, and never again', async t => {
  const ctx = await fixture(t), { lead, helper, checker } = ctx.agents;
  let jobs = ctx.open();
  await ctx.policy(jobs, { delegate: true });
  ctx.asks.set('two', () => delegate({ agentId: helper.id, task: 'first part' }, { agentId: checker.id, task: 'second part' }));
  const { jobId } = await ctx.submit(jobs, lead, 'two');
  const before = await ctx.delegated(jobs, jobId, 2);
  await jobs.close();
  // A crash after the parent saved its delegation but before the sub-jobs were written leaves exactly this on disk.
  for (const id of before) await rm(ctx.file('jobs', `job__${id.slice(4)}`), { recursive: true, force: true });
  jobs = ctx.open();
  await jobs.ready;
  const after = (await jobs.read(jobId)).children;
  assert.equal(after.length, 2, 'created again, once each');
  assert.deepEqual((await Promise.all(after.map(async id => (await jobs.read(id)).job.idempotencyKey))).sort(), ['delegate:a1:0', 'delegate:a1:1']);
  assert.deepEqual((await Promise.all(after.map(async id => (await jobs.read(id)).request.input.text))).sort(), ['first part', 'second part']);
  await jobs.close();
  jobs = ctx.open();
  await jobs.ready;
  assert.deepEqual((await jobs.read(jobId)).children.sort(), after.sort(), 'a second restart finds them by key: no duplicate');
  assert.equal((await readdir(ctx.file('jobs'))).filter(name => name.startsWith('job__')).length, 3);
  // A sub-job that ended while its parent still waits for the other cannot be deleted (it would be made again at the next start).
  const rejected = (await jobs.approve(after[0], { expectedRevision: (await jobs.read(after[0])).job.revision, decision: 'reject' })).job;
  await assert.rejects(jobs.remove(after[0], { expectedRevision: rejected.revision }), error => error.code === 'JOB_IN_USE' && error.details.jobIds[0] === jobId);
});

test('revoking a permission blocks further delegation: a queued sub-job whose relation was removed, or whose policy was switched off, fails at its claim without running', async t => {
  const ctx = await fixture(t), { lead, helper, checker } = ctx.agents, jobs = ctx.open();
  await ctx.policy(jobs, { delegate: true });
  ctx.asks.set('relation', () => delegate({ agentId: helper.id, task: 'needs the relation' }));
  ctx.asks.set('policy', () => delegate({ agentId: checker.id, task: 'needs the policy' }));
  const first = await ctx.submit(jobs, lead, 'relation'), second = await ctx.submit(jobs, lead, 'policy');
  const [viaRelation] = await ctx.delegated(jobs, first.jobId, 1), [viaPolicy] = await ctx.delegated(jobs, second.jobId, 1);
  // The owner removes lead → helper from the Graph, then approves the sub-job that used it.
  const { network } = await ctx.registry.network(ctx.network.id);
  await ctx.registry.updateNetwork(ctx.network.id, { expectedRevision: network.revision, edges: network.edges.filter(edge => edge.id !== rel(lead, helper).id) });
  await jobs.approve(viaRelation, { expectedRevision: (await jobs.read(viaRelation)).job.revision, decision: 'approve' });
  const revoked = await ctx.settled(jobs, viaRelation, ['failed']);
  assert.deepEqual([revoked.errorCode, revoked.outcome, revoked.attempts.length], ['DELEGATION_REVOKED', 'failed', 0]);
  assert.match(revoked.reason, /delegate relation .* was removed .* Nothing ran\./);
  // Its parent goes on with why there is no result.
  const parent = await ctx.settled(jobs, first.jobId, ['completed']);
  assert.match(jobs.worker.attempts.get(parent.attempts[1].id).job.handoff.context, /- blocked from agent [^\n]*:\n {4}Sub-job job_\w+ ended failed \(DELEGATION_REVOKED\)/);
  // Switching delegation off stops the other one the same way.
  await ctx.policy(jobs, { delegate: false });
  await jobs.approve(viaPolicy, { expectedRevision: (await jobs.read(viaPolicy)).job.revision, decision: 'approve' });
  const off = await ctx.settled(jobs, viaPolicy, ['failed']);
  assert.match(off.reason, /Delegation was switched off before this sub-job started/);
  assert.deepEqual([off.errorCode, off.attempts.length], ['DELEGATION_REVOKED', 0], 'failed at the claim: no attempt, so the worker never heard of it');
});

test('cancelling a job cancels its whole open tree, sub-jobs of sub-jobs too', async t => {
  const ctx = await fixture(t), { lead, helper, checker } = ctx.agents, jobs = ctx.open();
  await ctx.policy(jobs, { delegate: true });
  ctx.asks.set('tree', () => delegate({ agentId: helper.id, task: 'branch one' }, { agentId: checker.id, task: 'branch two' }));
  const { jobId } = await ctx.submit(jobs, lead, 'tree');
  const children = await ctx.delegated(jobs, jobId, 2);
  // A grandchild the owner linked under one sub-job (also waiting for approval, so nothing runs).
  const grandchild = await jobs.submit({ agentId: checker.id, input: { text: 'leaf' }, parentJobId: children[0], requireApproval: true });
  const { job: parent } = await jobs.read(jobId);
  await jobs.cancel(jobId);
  for (const id of [...children, grandchild.jobId]) {
    const job = await ctx.settled(jobs, id, ['cancelled']);
    assert.deepEqual([job.status, job.history.at(-1).by, job.reason], ['cancelled', 'app', 'Cancelled because the job that delegated it was cancelled.'], id);
  }
  assert.equal((await jobs.read(jobId)).job.status, 'cancelled');
  assert.equal(parent.status, 'waiting_for_input');
});

test('questions: off by default, then the job waits for the owner’s answer, which a new attempt reads; read receipts are apart from execution; messages are bounded', async t => {
  const ctx = await fixture(t), { lead } = ctx.agents, jobs = ctx.open();
  ctx.asks.set('Plan the launch.', () => ({ promptboard: { needs_input: { question: 'Which market comes first?' } } }));
  const off = await ctx.submit(jobs, lead, 'Plan the launch.');
  assert.match((await ctx.settled(jobs, off.jobId, ['completed'])).reason, /ask a question, which was refused: Questions from agents are switched off/);
  await ctx.policy(jobs, { askOwner: true });
  const { jobId } = await ctx.submit(jobs, lead, 'Plan the launch.');
  const waiting = await ctx.settled(jobs, jobId, ['waiting_for_input']);
  assert.deepEqual([waiting.awaiting.kind, waiting.awaiting.question, waiting.waiting.for], ['input', 'Which market comes first?', 'input']);
  assert.match(jobs.worker.attempts.get(waiting.attempts[0].id).job.handoff.guide, /"needs_input"/);
  let { messages, unread } = await jobs.messagesOf(jobId, { reader: OWNER });
  assert.deepEqual([messages.length, messages[0].kind, messages[0].from, messages[0].to, messages[0].text, unread], [1, 'needs_input', { agentId: lead.id }, OWNER, 'Which market comes first?', 1]);
  // Read receipts change no execution state.
  const marked = await jobs.readMessages(jobId, {}, { reader: OWNER });
  assert.deepEqual(marked, { marked: 1, unread: 0 });
  const still = (await jobs.read(jobId)).job;
  assert.deepEqual([still.status, still.revision, still.attempts.length], ['waiting_for_input', waiting.revision, 1]);
  assert.ok((await jobs.messagesOf(jobId, { reader: OWNER })).messages[0].readAt > 0);
  // Answering: the revision is checked, then the job runs again with the question and the answer as data.
  await assert.rejects(jobs.answer(jobId, { expectedRevision: waiting.revision - 1, text: 'Germany.' }), { code: 'REVISION_CONFLICT' });
  await assert.rejects(jobs.answer(jobId, { expectedRevision: waiting.revision, text: 'Germany.', extra: 1 }), { code: 'INVALID_INPUT' });
  await jobs.answer(jobId, { expectedRevision: waiting.revision, text: 'Germany, then Austria.' });
  const done = await ctx.settled(jobs, jobId, ['completed']);
  const context = jobs.worker.attempts.get(done.attempts[1].id).job.handoff.context;
  assert.match(context, /- needs_input from agent .* to the owner[^\n]*:\n {4}Which market comes first\?/);
  assert.match(context, /- result from the owner to agent [^\n]*:\n {4}Germany, then Austria\./);
  await assert.rejects(jobs.answer(jobId, { expectedRevision: done.revision, text: 'late' }), { code: 'JOB_STATE' });
  assert.ok(!JSON.stringify(ctx.events).includes('Which market') && !JSON.stringify(ctx.events).includes('Austria'), 'no question or answer in an event');
  // Owner notes: only review or request, 16 KiB, 200 per job; and 500 messages in all.
  await assert.rejects(jobs.postMessage(jobId, { kind: 'result', text: 'forged result' }, { from: OWNER }), { code: 'INVALID_INPUT' });
  await assert.rejects(jobs.postMessage(jobId, { kind: 'review', text: 'x'.repeat(16 * 1024 + 1) }, { from: OWNER }), { code: 'NETWORK_LIMIT' });
  const note = await jobs.postMessage(jobId, { kind: 'review', text: 'Good plan. My key sk-abcdefghijklmnopqrstuvwxyz0123456789 stays out.' }, { from: OWNER });
  assert.deepEqual([note.message.kind, note.message.from, note.message.to], ['review', OWNER, { agentId: lead.id }]);
  assert.ok(!note.message.text.includes('sk-abcdefghijklmnopqrstuvwxyz0123456789'), 'secrets are masked in notes');
  assert.deepEqual(await jobs.readMessages(jobId, {}, { reader: OWNER }), { marked: 0, unread: 0 }, 'a read mark is only for what is addressed to the reader');
  assert.equal((await jobs.messagesOf(jobId, { reader: OWNER })).messages.find(message => message.id === note.message.id).readAt, null);
  // The owner's answer above is not a note (P3-5): 200 notes fit beside it.
  for (let index = 1; index < 200; index++) await jobs.postMessage(jobId, { kind: 'request', text: `note ${index}` }, { from: OWNER });
  await assert.rejects(jobs.postMessage(jobId, { kind: 'review', text: 'one too many' }, { from: OWNER }), error => error.code === 'NETWORK_LIMIT' && /200 notes/.test(error.message));
  const file = ctx.file('jobs', `job__${jobId.slice(4)}`, 'messages.json'), full = (await jobs.messagesOf(jobId, { reader: OWNER })).messages;
  const filler = Array.from({ length: 500 - full.length }, (_, index) => ({ ...full[0], id: `msg_${hex(`filler${index}`).slice(0, 20)}`, from: { agentId: lead.id } }));
  await writeFile(file, JSON.stringify({ schema: 'promptboard.network-messages', version: 1, jobId, revision: 999, messages: [...full, ...filler] }));
  await assert.rejects(jobs.messages.post(jobId, { kind: 'blocked', from: { app: true }, to: OWNER, text: 'over' }), error => error.code === 'NETWORK_LIMIT' && /500 messages/.test(error.message));
});

test('a chain started by an external client stays inside its scope and stops when the client is revoked; a client’s own sub-job uses the same policy and its key', async t => {
  const clientRows = [];
  const ctx = await fixture(t, { clients: async () => ({ clients: clientRows }) }), { lead, helper, checker } = ctx.agents, jobs = ctx.open();
  const client = { id: `cli_${'c'.repeat(20)}`, status: 'active', scopes: { agents: [lead.id, helper.id], networks: [ctx.network.id], projects: [], permissions: ['submit_jobs', 'read_job_result'] } };
  clientRows.push(client);
  await ctx.policy(jobs, { delegate: true });
  ctx.asks.set('client chain', () => delegate({ agentId: checker.id, task: 'outside the client scope' }));
  const machine = { requester: { kind: 'machine', id: client.id } };
  const outside = await jobs.submit({ agentId: lead.id, input: { text: 'client chain' }, networkId: ctx.network.id, permissions: { memory: 'none' } }, machine);
  await ctx.settled(jobs, outside.jobId, ['completed']);
  assert.equal(ctx.events.findLast(event => event.jobId === outside.jobId && event.type === 'job.handoff').errorCode, 'DELEGATION_NOT_ALLOWED');
  const [blocked] = (await jobs.messagesOf(outside.jobId, { reader: { clientId: client.id } })).messages;
  assert.deepEqual(blocked.to, { clientId: client.id }, 'the refusal is addressed to the client that submitted the job');
  // The client asks for a sub-job of its own open job: the same checks, its own key, the parent does not wait.
  const parent = await jobs.submit({ agentId: lead.id, input: { text: 'open parent' }, networkId: ctx.network.id, permissions: { memory: 'none' }, requireApproval: true }, machine);
  const child = await jobs.delegate(parent.jobId, { agentId: helper.id, task: 'client sub-task' }, { clientId: client.id, idempotencyKey: 'k1' });
  const again = await jobs.delegate(parent.jobId, { agentId: helper.id, task: 'client sub-task' }, { clientId: client.id, idempotencyKey: 'k1' });
  assert.deepEqual([again.jobId, again.deduplicated, child.deduplicated], [child.jobId, true, false]);
  await assert.rejects(jobs.delegate(parent.jobId, { agentId: lead.id, task: 'other' }, { clientId: client.id, idempotencyKey: 'k1' }), { code: 'IDEMPOTENCY_CONFLICT' });
  const { job, request } = await jobs.read(child.jobId);
  assert.deepEqual([job.requester, job.source, job.parentJobId, job.delegation.by, request.permissions.memory, request.requireApproval], [{ kind: 'machine', id: client.id }, 'machine', parent.jobId, 'machine', 'none', true]);
  await assert.rejects(jobs.delegate(parent.jobId, { agentId: checker.id, task: 'x' }, { clientId: client.id }), { code: 'DELEGATION_NOT_ALLOWED' });
  await assert.rejects(jobs.delegate(parent.jobId, { agentId: lead.id, task: 'x' }, { clientId: client.id }), { code: 'DELEGATION_CYCLE' });
  // Revoked: no new sub-job, and the queued one fails at its claim.
  client.status = 'revoked';
  await assert.rejects(jobs.delegate(parent.jobId, { agentId: helper.id, task: 'after revoke' }, { clientId: client.id }), { code: 'CLIENT_REVOKED' });
  await jobs.approve(child.jobId, { expectedRevision: job.revision, decision: 'approve' });
  const stopped = await ctx.settled(jobs, child.jobId, ['failed']);
  assert.deepEqual([stopped.errorCode, stopped.attempts.length], ['DELEGATION_REVOKED', 0]);
  // A finished job gets no sub-job.
  await assert.rejects(jobs.delegate(outside.jobId, { agentId: helper.id, task: 'late' }, { clientId: client.id }), { code: 'JOB_FINISHED' });
});
