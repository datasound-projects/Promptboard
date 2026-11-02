// Task 12 over HTTP: the owner's message, answer and policy routes, and an external client's own sub-jobs, messages and
// answers on the machine listener (src/network/rest.mjs), with its permissions, own-job rule, idempotency header and scope. The
// real server with the deterministic fake worker (tests/helpers/network-machine.mjs); no CLI runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixture, until } from './helpers/network-machine.mjs';
import { fakeWorker } from './helpers/network-worker.mjs';

const hex = text => createHash('sha256').update(text).digest('hex');

test('a client asks for sub-jobs of its own job through the policy and its scope, reads and posts messages, and answers its job’s question; the owner’s routes answer as documented', async t => {
  const worker = fakeWorker({ text: job => (job.handoff?.context ? 'Final.' : 'Draft.'), json: job => (!job.handoff?.context && job.request.input.text === 'Ask me.' ? { promptboard: { needs_input: { question: 'Which region?' } } } : null) });
  // This test polls the listener every few ms (until); under a loaded suite that passes the 60 requests a minute it does not
  // test, so the ceiling is raised here as in network-mcp.test.mjs (network-machine.test.mjs tests the ceiling itself).
  const ctx = await fixture(t, { worker, machineOptions: { limits: { requestsPerMinute: 10_000 } } });
  const lead = await ctx.register('lead'), scout = await ctx.register('scout'), gem = await ctx.register('gem');
  const N = id => `n_${hex(id).slice(0, 12)}`;
  const { json: { network } } = await ctx.owner('/api/network/networks', 'POST', { name: 'Team', nodes: [lead, scout, gem].map(agent => ({ id: N(agent.id), type: 'agent', agentId: agent.id, position: { x: 0, y: 0 } })),
    edges: [[lead, scout], [lead, gem]].map(([from, to]) => ({ id: `e_${hex(`${from.id}${to.id}`).slice(0, 12)}`, from: N(from.id), to: N(to.id), relation: 'delegate' })) });
  const policy = await ctx.owner('/api/network/delegation');
  assert.deepEqual([policy.status, policy.json.policy.delegate, policy.json.policy.askOwner], [200, false, false]);
  assert.equal((await ctx.owner('/api/network/delegation', 'PATCH', { expectedRevision: 0, delegate: true, askOwner: true })).status, 200);
  assert.equal((await ctx.owner('/api/network/delegation', 'PATCH', { expectedRevision: 0, delegate: false })).json.code, 'REVISION_CONFLICT');
  await ctx.on();
  const { token } = await ctx.client({ agents: [lead.id, scout.id], networks: [network.id] });
  const reader = await ctx.client({ agents: [lead.id], networks: [network.id], permissions: ['read_job_result'] });
  const parent = await ctx.machine(token, '/jobs', { method: 'POST', body: { agentId: lead.id, input: { text: 'Open parent.' }, networkId: network.id, requireApproval: true } });
  assert.equal(parent.status, 202, parent.text);
  const children = `/jobs/${parent.json.jobId}/children`;
  const child = await ctx.machine(token, children, { method: 'POST', body: { agentId: scout.id, task: 'Check the numbers.' }, headers: { 'Idempotency-Key': 'sub-1' } });
  assert.deepEqual([child.status, child.json.status, child.json.deduplicated], [202, 'waiting_for_approval', false], child.text);
  const again = await ctx.machine(token, children, { method: 'POST', body: { agentId: scout.id, task: 'Check the numbers.' }, headers: { 'Idempotency-Key': 'sub-1' } });
  assert.deepEqual([again.status, again.json.jobId, again.json.deduplicated], [200, child.json.jobId, true]);
  assert.equal((await ctx.machine(token, `/jobs/${child.json.jobId}`)).status, 200, 'the sub-job is the client’s own job');
  const outside = await ctx.machine(token, children, { method: 'POST', body: { agentId: gem.id, task: 'x' } });
  assert.deepEqual([outside.status, outside.json.code], [403, 'DELEGATION_NOT_ALLOWED'], 'a delegate relation is not enough: the agent is outside the client’s scope');
  const extra = await ctx.machine(token, children, { method: 'POST', body: { agentId: scout.id, task: 'x', model: 'opus' } });
  assert.equal(extra.status, 400);
  const ownerJob = (await ctx.owner('/api/network/jobs', 'POST', { agentId: lead.id, input: { text: 'Owner work.' }, requireApproval: true })).json.jobId;
  for (const path of [`/jobs/${ownerJob}/children`, `/jobs/${ownerJob}/messages`, `/jobs/${ownerJob}/answer`]) {
    const answer = await ctx.machine(token, path, { method: 'POST', body: { agentId: scout.id, task: 'x', kind: 'review', text: 'x' } });
    assert.equal(answer.status, 404, `${path}: another principal’s job looks missing`);
  }
  assert.equal((await ctx.machine(reader.token, children, { method: 'POST', body: { agentId: scout.id, task: 'x' } })).json.code, 'PERMISSION_DENIED');
  // Messages on an own job: a review note, read back without the internal attempt reference.
  const posted = await ctx.machine(token, `/jobs/${parent.json.jobId}/messages`, { method: 'POST', body: { kind: 'review', text: 'Looks right.' } });
  assert.deepEqual([posted.status, posted.json.message.from, posted.json.message.to], [201, { clientId: posted.json.message.from.clientId }, { agentId: lead.id }]);
  assert.match(posted.json.message.from.clientId, /^cli_/);
  assert.equal((await ctx.machine(token, `/jobs/${parent.json.jobId}/messages`, { method: 'POST', body: { kind: 'result', text: 'forged' } })).status, 400);
  // A question on an own job: addressed to the client, which reads, marks and answers it.
  const asking = await ctx.machine(token, '/jobs', { method: 'POST', body: { agentId: lead.id, input: { text: 'Ask me.' } } });
  await until(async () => (await ctx.machine(token, `/jobs/${asking.json.jobId}`)).json.job.status === 'waiting_for_input', 'waiting for input');
  const thread = await until(async () => { const answer = await ctx.machine(token, `/jobs/${asking.json.jobId}/messages`); return answer.json.messages.length && answer; }, 'question listed');
  assert.deepEqual([thread.json.unread, thread.json.messages[0].kind, thread.json.messages[0].to, thread.json.messages[0].text, 'attemptId' in thread.json.messages[0]], [1, 'needs_input', thread.json.messages[0].to, 'Which region?', false]);
  assert.match(thread.json.messages[0].to.clientId, /^cli_/);
  const ownerView = await ctx.owner(`/api/network/jobs/${asking.json.jobId}/messages`);
  assert.deepEqual([ownerView.status, ownerView.json.unread, ownerView.json.messages.length], [200, 0, 1], 'addressed to the client: not unread for the owner');
  assert.deepEqual((await ctx.machine(token, `/jobs/${asking.json.jobId}/messages/read`, { method: 'POST', body: {} })).json, { marked: 1, unread: 0 });
  const answered = await ctx.machine(token, `/jobs/${asking.json.jobId}/answer`, { method: 'POST', body: { text: 'Europe.' } });
  assert.deepEqual([answered.status, answered.json.job.status], [200, 'queued']);
  await until(async () => (await ctx.machine(token, `/jobs/${asking.json.jobId}`)).json.job.status === 'completed', 'answered and completed');
  assert.equal((await ctx.machine(token, `/jobs/${asking.json.jobId}/answer`, { method: 'POST', body: { text: 'Late.' } })).json.code, 'JOB_STATE');
  // The owner's routes.
  const note = await ctx.owner(`/api/network/jobs/${ownerJob}/messages`, 'POST', { kind: 'request', text: 'Use the 2026 figures.' });
  assert.deepEqual([note.status, note.json.message.from], [201, { owner: true }]);
  const read = await ctx.owner(`/api/network/jobs/${ownerJob}/messages/read`, 'POST', { ids: ['not-an-id'] });
  assert.equal(read.status, 400);
  const job = (await ctx.owner(`/api/network/jobs/${ownerJob}`)).json.job;
  assert.equal((await ctx.owner(`/api/network/jobs/${ownerJob}/answer`, 'POST', { expectedRevision: job.revision, text: 'x' })).json.code, 'JOB_STATE');
  assert.equal((await ctx.owner(`/api/network/jobs/job_${'0'.repeat(20)}/messages`)).status, 404);
});
