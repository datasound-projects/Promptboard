// Task 14 end-to-end scenarios through the real app (startServer) and its default local job worker, with the fake headless
// CLIs (tests/fixtures/fake-headless-cli.mjs) as the only programs on PATH besides node. (1) The local MVP scenario over
// the owner's HTTP API: Base agents created and registered, a nested graph published, a pipeline (two parallel research
// steps → join → a reviewer from a sub-network's sub-pipeline → approval → report) followed on the NDJSON stream, with
// two app restarts; pinned versions, statuses and no duplicate effects. (2) An outside client: the real MCP client over
// stdio with a scoped machine token submits, polls and retrieves; the same token is refused everywhere else. (3)
// Federation: a mock A2A peer built with the official SDK, with a card and bearer auth, is a step of a pipeline; private,
// insecure and non-allowlisted endpoints are refused. No real CLI, no live A2A service, no network beyond 127.0.0.1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { startServer } from '../src/server.mjs';
import { mockPeer } from './helpers/a2a-peer.mjs';
import { follow, installFakeClis, skipFakes as skip, tick, until } from './helpers/network-e2e.mjs';
import { fixture, request } from './helpers/network-machine.mjs';

const fakes = await installFakeClis();
const hex = text => createHash('sha256').update(text).digest('hex');
const N = name => `n_${hex(`step:${name}`).slice(0, 12)}`;
const E = (from, to) => `e_${hex(`${from}>${to}`).slice(0, 12)}`;
const step = (name, type, config, label) => ({ id: N(name), type, label, position: { x: 0, y: 0 }, config });
const edge = (from, to, fromPort) => ({ id: E(from, to), from: N(from), to: N(to), fromPort });

test('local scenario: Base agents created and registered over HTTP, a nested graph published, a parallel → join → sub-pipeline reviewer → approval → report pipeline followed on the stream across two restarts; versions stay pinned, statuses are accurate, every effect happens once', { skip, timeout: 240000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-network-e2e-local-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  let app = null, token = null;
  const boot = async () => {
    app = await startServer({ port: 0, dataDir, executor: null, catalogReader: async provider => ({ provider, source: 'test fixture', models: [] }) }); // networkWorker unset: the app's own LocalJobWorker
    token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  };
  t.after(() => app?.close());
  await boot();
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, json: await response.json() };
  };
  const ok = async (path, method, body, status = 200) => { const answer = await call(path, method, body); assert.equal(answer.status, status, `${method || 'GET'} ${path}: ${JSON.stringify(answer.json)}`); return answer.json; };
  const runOf = async id => (await ok(`/api/network/pipeline-runs/${id}`)).run;
  const stepJobs = async id => (await ok(`/api/network/jobs?pipelineRunId=${id}&limit=200`)).jobs;

  // 1. Base agents created through Base's own route, then registered in Network.
  const base = {};
  for (const [key, name, agent] of [['a', 'Market researcher', { provider: 'claude', model: 'haiku' }], ['b', 'Competitor researcher', { provider: 'codex', effort: 'low' }], ['review', 'Reviewer', { provider: 'claude', model: 'haiku' }]]) {
    base[key] = (await ok('/api/base/resources', 'POST', { kind: 'profile', name, configuration: { agent } })).resource;
  }
  const agents = {};
  for (const key of ['a', 'b', 'review']) {
    const { revision } = await ok('/api/network/agents');
    agents[key] = (await ok('/api/network/agents', 'POST', { baseResourceId: base[key].id, expectedRevision: revision })).agent;
  }
  const directory = (await ok('/api/network/agents')).agents;
  assert.deepEqual(directory.map(agent => [agent.baseResourceId, agent.base.provider, agent.base.model || null, agent.enabled]).sort(),
    [[base.a.id, 'claude', 'haiku', true], [base.b.id, 'codex', null, true], [base.review.id, 'claude', 'haiku', true]].sort());

  // 2. A nested graph: "Review desk" (the reviewer) is pinned as v1 inside "Desk" (both researchers); a containment loop is refused.
  const member = (key, i) => ({ id: N(`member:${key}`), type: 'agent', agentId: agents[key].id, position: { x: i * 200, y: 0 } });
  const desk = (await ok('/api/network/networks', 'POST', { name: 'Review desk', nodes: [member('review', 0)], edges: [] })).network;
  await ok(`/api/network/networks/${desk.id}/publish`, 'POST', { expectedRevision: desk.revision });
  const outer = (await ok('/api/network/networks', 'POST', { name: 'Desk', nodes: [member('a', 0), member('b', 1), { id: N('member:desk'), type: 'subnetwork', networkId: desk.id, version: 1, position: { x: 400, y: 0 } }],
    edges: [{ id: E('member:a', 'member:b'), from: N('member:a'), to: N('member:b'), relation: 'share_result' }] })).network;
  const outerV1 = await ok(`/api/network/networks/${outer.id}/publish`, 'POST', { expectedRevision: outer.revision });
  const deskDraft = (await ok(`/api/network/networks/${desk.id}`)).network;
  const loop = await call(`/api/network/networks/${desk.id}`, 'PATCH', { expectedRevision: deskDraft.revision, nodes: [...deskDraft.nodes, { id: N('member:loop'), type: 'subnetwork', networkId: outer.id, version: 1, position: { x: 0, y: 200 } }] });
  assert.deepEqual([loop.status, loop.json.code], [400, 'NETWORK_CYCLE'], 'a recursive containment loop is refused');
  assert.equal((await ok(`/api/network/networks/${desk.id}`)).network.revision, deskDraft.revision, 'the draft is unchanged');

  // 3. The pipelines: "Review" on the inner network (reviewer → output), used as a sub-pipeline step of "Market report" on Desk v1.
  const review = (await ok('/api/network/pipelines', 'POST', { networkId: desk.id, networkVersion: 1, name: 'Review',
    nodes: [step('reviewer', 'agent', { agentId: agents.review.id, instructions: 'Review both research results.' }, 'Reviewer'), step('reviewed', 'output', { name: 'review', include: [N('reviewer')] }, 'Reviewed')],
    edges: [edge('reviewer', 'reviewed', 'text')] })).pipeline;
  await ok(`/api/network/pipelines/${review.id}/publish`, 'POST', { expectedRevision: review.revision });
  const definition = {
    nodes: [step('a', 'agent', { agentId: agents.a.id, instructions: 'Research the market. [[barrier:research:2]]' }, 'Research A'),
      step('b', 'agent', { agentId: agents.b.id, instructions: 'Research the competitors. [[barrier:research:2]]' }, 'Research B'),
      step('join', 'join', { require: 'all' }, 'Join'), step('desk', 'subnetwork', { pipelineId: review.id, version: 1 }, 'Review desk'),
      step('approve', 'approval', { prompt: 'Save the report?' }, 'Approve'), step('report', 'output', { name: 'report', include: [N('a'), N('b'), N('desk')] }, 'Report')],
    edges: [edge('a', 'join', 'text'), edge('b', 'join', 'text'), edge('join', 'desk', 'done'), edge('desk', 'approve', 'text'), edge('join', 'approve', 'done'), edge('approve', 'report', 'done')],
  };
  const pipeline = (await ok('/api/network/pipelines', 'POST', { networkId: outer.id, networkVersion: 1, name: 'Market report', ...definition })).pipeline;
  await ok(`/api/network/pipelines/${pipeline.id}/publish`, 'POST', { expectedRevision: pipeline.revision });
  assert.deepEqual([(await ok('/api/network/jobs')).total, (await fakes.runs()).length], [0, 0], 'creating, saving and publishing ran nothing');

  // 4. Run v1, followed live on the NDJSON stream, until it waits for the approval.
  let stream = follow(app.url, token, (await ok('/api/network/events?limit=1')).last);
  await until(() => stream.live(), 'the stream is live');
  const runId = (await ok(`/api/network/pipelines/${pipeline.id}/runs`, 'POST', { version: 1, confirm: true, input: { text: 'Electric bikes in Europe.' } }, 202)).runId;
  const heard = (events, type, status, extra = {}) => events.find(event => event.type === type && event.status === status && Object.entries(extra).every(([key, value]) => event[key] === value));
  await until(() => heard(stream.events, 'pipeline.run', 'waiting_for_approval', { pipelineRunId: runId }), 'the stream says the run waits for the approval');
  const REVIEWER = `${N('desk')}/${N('reviewer')}`;
  let run = await runOf(runId);
  assert.equal(run.status, 'waiting_for_approval');
  assert.deepEqual([N('a'), N('b'), REVIEWER, N('join'), N('approve'), N('report')].map(id => [id, run.nodes[id].status]),
    [[N('a'), 'completed'], [N('b'), 'completed'], [REVIEWER, 'completed'], [N('join'), 'completed'], [N('approve'), 'waiting_for_approval'], [N('report'), 'pending']]);
  const jobs = await stepJobs(runId), byNode = Object.fromEntries(jobs.map(job => [job.nodeId, job]));
  assert.deepEqual(jobs.map(job => [job.nodeId, job.status]).sort(), [[N('a'), 'completed'], [N('b'), 'completed'], [REVIEWER, 'completed']].sort());
  const at = (jobId, status) => heard(stream.events, 'job.status', status, { jobId })?.seq;
  assert.ok(Math.max(at(byNode[N('a')].id, 'running'), at(byNode[N('b')].id, 'running')) < Math.min(at(byNode[N('a')].id, 'completed'), at(byNode[N('b')].id, 'completed')), 'both research jobs ran at the same time');
  assert.ok(at(byNode[REVIEWER].id, 'queued') > Math.max(at(byNode[N('a')].id, 'completed'), at(byNode[N('b')].id, 'completed')), 'the reviewer waited for the join');
  const reviewerRequest = (await ok(`/api/network/jobs/${byNode[REVIEWER].id}`)).request;
  assert.match(reviewerRequest.input.text, /Answer from claude\.[\s\S]*Answer from codex\.|Answer from codex\.[\s\S]*Answer from claude\./, 'the reviewer got both research results');
  assert.deepEqual([reviewerRequest.agent.model, reviewerRequest.pipeline.runId, reviewerRequest.pipeline.nodeId], ['haiku', runId, REVIEWER]);

  // 5. Pinning: while the run waits, the Base agent, both networks and the pipeline change and are republished as v2.
  const planPath = join(dataDir, 'network', 'pipeline-runs', `run__${runId.slice(4)}`, 'plan.json'), planBytes = await readFile(planPath, 'utf8');
  const plan = JSON.parse(planBytes);
  assert.equal(run.planSha256, hex(planBytes));
  await ok(`/api/base/resources/${base.review.id}`, 'PATCH', { configuration: { agent: { provider: 'claude', model: 'sonnet' } }, expectedRevision: base.review.revision });
  assert.equal((await ok(`/api/network/agents/${agents.review.id}`)).agent.base.model, 'sonnet', 'the registration shows the new Base model');
  for (const net of [desk, outer]) {
    const draft = (await ok(`/api/network/networks/${net.id}`)).network;
    const changed = await ok(`/api/network/networks/${net.id}`, 'PATCH', { expectedRevision: draft.revision, nodes: draft.nodes.map(node => ({ ...node, position: { x: node.position.x + 50, y: 30 } })) });
    await ok(`/api/network/networks/${net.id}/publish`, 'POST', { expectedRevision: changed.network.revision });
  }
  const parentDraft = (await ok(`/api/network/pipelines/${pipeline.id}`)).pipeline;
  const edited = await ok(`/api/network/pipelines/${pipeline.id}`, 'PATCH', { expectedRevision: parentDraft.revision, nodes: parentDraft.nodes.map(node => (node.id === N('report') ? { ...node, label: 'Report v2', config: { ...node.config, include: [N('a')] } } : node)) });
  const v2 = await ok(`/api/network/pipelines/${pipeline.id}/publish`, 'POST', { expectedRevision: edited.pipeline.revision });
  assert.equal(v2.published.version, 2);
  assert.equal(await readFile(planPath, 'utf8'), planBytes, 'the run keeps its plan.json byte for byte');

  // 6. Restart while the approval waits: still waiting, nothing ran again; the stream resumes from its last seq.
  await stream.stop();
  const before = stream.events;
  await app.close(); app = null;
  await boot();
  stream = follow(app.url, token, before.at(-1).seq);
  await until(() => stream.live(), 'the stream is live after the restart');
  await tick(2500); // More than two passes of the runner (every second).
  assert.deepEqual([(await runOf(runId)).status, (await fakes.runs()).length, (await stepJobs(runId)).length], ['waiting_for_approval', 3, 3], 'nothing ran again after the restart');
  await ok(`/api/network/pipeline-runs/${runId}/nodes/${N('approve')}/approve`, 'POST', { decision: 'approve' });
  await until(() => heard(stream.events, 'pipeline.run', 'completed', { pipelineRunId: runId }), 'the stream says the run completed');

  // 7. Accurate end state: the v1 plan ran (the report holds all three results, not v2's one), one job and one CLI run per step, one report.
  run = await runOf(runId);
  const runDir = join(dataDir, 'network', 'pipeline-runs', `run__${runId.slice(4)}`), report = await readFile(join(runDir, 'reports', 'report.md'), 'utf8');
  assert.equal(report, '# Market report\n\n## Research A\n\nAnswer from claude.\n\n## Research B\n\nAnswer from codex.\n\n## Review desk\n\n# Review desk\n\n## Reviewer\n\nAnswer from claude.\n'); // The sub-pipeline's own output, as its section.
  assert.deepEqual((await readdir(join(runDir, 'reports'))).sort(), [`${N('desk')}.review.md`, 'report.md'], 'one file per output step: the sub-pipeline’s and the run’s');
  assert.deepEqual([run.status, run.pipelineVersion, plan.pipeline.version, run.nodes[N('report')].result.text.sha256, run.nodes[N('approve')].approval.decision], ['completed', 1, 1, hex(report), 'approved']);
  assert.deepEqual(run.history.map(entry => entry.status), ['running', 'waiting_for_approval', 'running', 'completed']);
  assert.equal(hex(await readFile(planPath, 'utf8')), run.planSha256);
  assert.deepEqual([plan.pins.pipelines.map(pin => [pin.pipelineId, pin.version]), plan.groups.map(group => [group.networkId, group.networkVersion])], [[[review.id, 1]], [[desk.id, 1]]], 'the sub-pipeline and its network are pinned at v1');
  const final = await stepJobs(runId);
  assert.deepEqual([final.length, new Set(final.map(job => job.idempotencyKey)).size, final.every(job => job.status === 'completed' && job.attempts.length === 1)], [3, 3, true]);
  for (const job of final) assert.equal(job.idempotencyKey, `run:${runId}:node:${job.nodeId}:a1`);
  const cli = await fakes.runs();
  assert.deepEqual(cli.map(entry => entry.cli).sort(), ['claude', 'claude', 'codex']);
  const reviewerCli = cli.find(entry => entry.input.includes('Review both research results.'));
  assert.equal(reviewerCli.args[reviewerCli.args.indexOf('--model') + 1], 'haiku', 'the reviewer ran with the model pinned when its job was accepted');
  assert.deepEqual([outerV1.published.version, plan.network.id, plan.network.version, plan.network.sha256], [1, outer.id, 1, outerV1.published.sha256], 'the run pinned Desk v1');

  // 8. Restart once more after the end: nothing is replayed; the journal gave every event of the run once, in order.
  await stream.stop();
  const streamed = [...before, ...stream.events];
  await app.close(); app = null;
  await boot();
  await tick(2500);
  assert.deepEqual([(await runOf(runId)).status, (await stepJobs(runId)).length, (await fakes.runs()).length, await readFile(join(runDir, 'reports', 'report.md'), 'utf8')], ['completed', 3, 3, report], 'no replay after the end');
  const journal = (await ok(`/api/network/events?after=0&limit=200&pipelineRunId=${runId}`)).events;
  const mine = streamed.filter(event => event.pipelineRunId === runId);
  assert.deepEqual(mine.map(event => event.seq), journal.map(event => event.seq), 'the stream gave each event of the run exactly once across the restart');
  assert.equal(new Set(streamed.map(event => event.seq)).size, streamed.length, 'no event twice');
  assert.deepEqual(journal.filter(event => event.type === 'pipeline.run').map(event => event.status), ['running', 'waiting_for_approval', 'running', 'completed']);
  for (const job of final) assert.deepEqual(journal.filter(event => event.type === 'job.status' && event.jobId === job.id).map(event => event.status), ['queued', 'preparing', 'running', 'completed']);

  // 9. A run started now pins pipeline v2 (whose draft still names Desk v1: a network's new version is never picked up on its
  // own) and the reviewer's new Base model.
  const runV2 = (await ok(`/api/network/pipelines/${pipeline.id}/runs`, 'POST', { version: 2, confirm: true, input: { text: 'Second run.' } }, 202)).runId;
  const waiting = await until(async () => { const value = await runOf(runV2); return value.status === 'waiting_for_approval' && value; }, 'run v2 waits');
  const v2Plan = await readFile(join(dataDir, 'network', 'pipeline-runs', `run__${runV2.slice(4)}`, 'plan.json'), 'utf8');
  const parsed = JSON.parse(v2Plan);
  assert.deepEqual([parsed.pipeline.version, parsed.network.version, parsed.nodes.find(node => node.id === N('report')).config.include], [2, 1, [N('a')]], 'run v2 pins pipeline v2, which names Desk v1 itself');
  assert.equal(hex(v2Plan), waiting.planSha256);
  const v2Reviewer = (await stepJobs(runV2)).find(job => job.nodeId === REVIEWER);
  assert.equal((await ok(`/api/network/jobs/${v2Reviewer.id}`)).request.agent.model, 'sonnet');
  await ok(`/api/network/pipeline-runs/${runV2}/nodes/${N('approve')}/approve`, 'POST', { decision: 'reject' });
  const rejected = await until(async () => { const value = await runOf(runV2); return value.status !== 'running' && value; }, 'run v2 settles after the rejection');
  assert.deepEqual([rejected.status, rejected.errorCode, rejected.nodes[N('report')].status], ['cancelled', 'APPROVAL_REJECTED', 'cancelled'], 'a rejected approval writes no report');
  assert.equal(await readdir(join(dataDir, 'network', 'pipeline-runs', `run__${runV2.slice(4)}`, 'reports')).then(names => names.includes('report.md')), false);
  assert.deepEqual([(await runOf(runId)).status, (await stepJobs(runId)).length], ['completed', 3], 'the first run is untouched');
});

/** Every file under `dir` with its text (for the secret checks). */
async function texts(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return Promise.all(entries.filter(entry => entry.isFile()).map(async entry => [join(entry.parentPath, entry.name), await readFile(join(entry.parentPath, entry.name), 'utf8').catch(() => '')]));
}
const freePort = () => new Promise(resolve => { const probe = net.createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });

test('outside client: a real MCP host over stdio with a scoped machine token submits, polls and retrieves a job that runs on the real worker; the same token is refused for an unrelated project, agent, network and memory, on the owner API and on the paired-device listener; the owner token and a phone cookie are refused on the machine listener', { skip, timeout: 120000 }, async t => {
  const ctx = await fixture(t, { serverOptions: { networkWorker: undefined, machineOptions: { limits: { requestsPerMinute: 10_000 } } } }); // The app's own LocalJobWorker on the fake CLIs.
  const lead = await ctx.register('lead'), scout = await ctx.register('scout');
  const [site, docs] = ctx.projects;
  const other = (await ctx.owner('/api/network/networks', 'POST', { name: 'Unrelated', nodes: [{ id: N('member:scout'), type: 'agent', agentId: scout.id, position: { x: 0, y: 0 } }], edges: [] })).json.network;
  await ctx.on();
  const { client, token } = await ctx.client({ agents: [lead.id], projects: [site] });
  const cliBefore = (await fakes.runs()).length;

  // The host: `node bin/ste.mjs --mcp`, the token only in its environment.
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../bin/ste.mjs', import.meta.url)), '--mcp'],
    env: { PROMPTBOARD_MACHINE_URL: `http://127.0.0.1:${ctx.machinePort}`, PROMPTBOARD_MACHINE_TOKEN: token }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  const host = new Client({ name: 'outside-host', version: '1.0.0' });
  await host.connect(transport);
  t.after(() => host.close().catch(() => {}));
  const answers = [];
  const callTool = async (name, args = {}) => { const result = await host.callTool({ name, arguments: args }); answers.push(JSON.stringify(result)); return result; };
  const json = async (name, args) => { const result = await callTool(name, args); assert.ok(!result.isError, `${name}: ${result.content?.[0]?.text}`); return JSON.parse(result.content[0].text); };

  assert.deepEqual((await json('agents_list')).agents.map(agent => agent.id), [lead.id], 'only the agent in scope');
  const submitted = await json('jobs_submit', { agentId: lead.id, input: 'Summarise the release notes for the site.', projectId: site, idempotencyKey: 'outside-1' });
  assert.deepEqual([submitted.status, submitted.deduplicated], ['queued', false]);
  const done = await until(async () => { const { job } = await json('jobs_get', { jobId: submitted.jobId }); return ['completed', 'failed', 'unknown'].includes(job.status) && job; }, 'the outside job ends');
  assert.equal(done.status, 'completed', JSON.stringify(done));
  const artifact = await callTool('artifacts_get', { jobId: submitted.jobId });
  assert.equal(artifact.content[1].text, 'Answer from claude.', 'the result the fake Claude CLI wrote');
  const again = await json('jobs_submit', { agentId: lead.id, input: 'Summarise the release notes for the site.', projectId: site, idempotencyKey: 'outside-1' });
  assert.deepEqual([again.jobId, again.deduplicated], [submitted.jobId, true], 'a retried submit is the same job');
  const ownerView = (await ctx.owner(`/api/network/jobs/${submitted.jobId}`)).json.job;
  assert.deepEqual([ownerView.source, ownerView.requester, ownerView.projectId], ['machine', { kind: 'machine', id: client.id }, site]);

  // The same token, out of scope: every refusal is a tool error and starts nothing.
  const ownerJob = (await ctx.owner('/api/network/jobs', 'POST', { agentId: lead.id, input: { text: 'The owner’s own job.' }, requireApproval: true })).json.jobId;
  for (const [name, args, code] of [
    ['jobs_submit', { agentId: lead.id, input: 'Another project.', projectId: docs }, 'PROJECT_NOT_ALLOWED'],
    ['jobs_submit', { agentId: scout.id, input: 'Another agent.' }, 'AGENT_NOT_ALLOWED'], ['agents_get', { agentId: scout.id }, 'AGENT_NOT_ALLOWED'],
    ['jobs_submit', { agentId: lead.id, input: 'Another network.', networkId: other.id }, 'NETWORK_NOT_ALLOWED'],
    ['jobs_submit', { agentId: lead.id, input: 'Memory.', memory: 'agent' }, 'MEMORY_NOT_ALLOWED'], ['jobs_submit', { agentId: lead.id, input: 'Lessons.', projectId: site, projectLessons: true }, 'MEMORY_NOT_ALLOWED'],
    ['jobs_get', { jobId: ownerJob }, 'NOT_FOUND'], ['artifacts_get', { jobId: ownerJob }, 'NOT_FOUND'], ['jobs_cancel', { jobId: ownerJob }, 'NOT_FOUND']]) {
    const result = await callTool(name, args);
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(result.content[0].text, new RegExp(code), `${name} ${JSON.stringify(args)}`);
  }
  assert.equal((await ctx.owner(`/api/network/jobs/${ownerJob}`)).json.job.status, 'waiting_for_approval', 'the owner’s job was not touched');

  // Owner API: the machine token is no owner credential, as a bearer or in the owner's header; owner paths are not on the machine listener.
  for (const headers of [{ Authorization: `Bearer ${token}` }, { 'X-STE-Token': token }]) {
    for (const [method, path, body] of [['GET', '/api/network/agents'], ['POST', '/api/network/jobs', { agentId: lead.id, input: { text: 'x' } }], ['POST', `/api/network/jobs/${ownerJob}/approve`, { expectedRevision: 1, decision: 'approve' }], ['GET', '/api/board']]) {
      const answer = await request(ctx.port, path, { method, body, headers });
      assert.equal(answer.status, 403, `${Object.keys(headers)[0]} ${method} ${path}: ${answer.text}`);
    }
  }
  for (const path of ['/api/network/agents', '/api/session', '/machine/v1/clients', '/machine/v1/listener', `/machine/v1/jobs/${submitted.jobId}/approve`]) {
    assert.equal((await request(ctx.machinePort, path, { headers: { Authorization: `Bearer ${token}` } })).status, 404, path);
  }
  // The owner's token and a paired phone's cookie are no machine credentials.
  const machineAgents = headers => ctx.machine(token, '/agents', { headers });
  assert.deepEqual([(await machineAgents({ 'X-STE-Token': ctx.session })).json.code, (await machineAgents({ Cookie: 'pb_remote=abc' })).json.code], ['MACHINE_CREDENTIAL_REQUIRED', 'MACHINE_CREDENTIAL_REQUIRED']);
  // The paired-device listener: a real pairing; the machine token is refused there on every path.
  const remotePort = await freePort();
  assert.equal((await ctx.owner('/api/remote/settings', 'POST', { method: 'twingate', port: remotePort, bind: '127.0.0.1' })).status, 200);
  const { pairing } = (await ctx.owner('/api/remote/pairing', 'POST', {})).json;
  const cookie = (await request(remotePort, '/api/remote/pair', { method: 'POST', body: { code: pairing.code } })).headers['set-cookie'][0].split(';')[0];
  for (const [path, headers] of [['/api/network/agents', { Authorization: `Bearer ${token}` }], ['/api/network/agents', { Cookie: cookie, Authorization: `Bearer ${token}` }], ['/machine/v1/agents', { Cookie: cookie, Authorization: `Bearer ${token}` }], ['/api/session', { Authorization: `Bearer ${token}` }]]) {
    const answer = await request(remotePort, path, { headers });
    assert.ok([401, 403].includes(answer.status), `remote ${path} ${Object.keys(headers).join('+')}: ${answer.status}`);
    assert.ok(!answer.text.includes('"agents"'), 'no data');
  }
  assert.deepEqual(await machineAgents({ Cookie: cookie }).then(answer => [answer.status, answer.json.code]), [403, 'MACHINE_CREDENTIAL_REQUIRED']);
  await ctx.owner('/api/remote/settings', 'POST', { method: 'local' });

  // One job ran (one CLI run), the refused calls made none; the token is nowhere but in the client's hands.
  assert.equal((await ctx.owner('/api/network/jobs?limit=200')).json.total, 2, 'the outside job and the owner’s job');
  assert.equal((await fakes.runs()).length - cliBefore, 1);
  const files = await texts(join(ctx.dataDir, 'network'));
  for (const [path, text] of files) assert.ok(!text.includes(token) && !text.includes(token.slice(-43)), path);
  assert.ok(![...answers, stderr].join('\n').includes(token.slice(-43)), 'no token in an answer or the host’s log');
});

test('federation: a mock A2A peer (official SDK) with an Agent Card and bearer auth is a step of a pipeline that runs on the real worker; private, insecure, redirected and non-allowlisted endpoints are refused before anything is sent. No live external A2A service is used', { skip, timeout: 120000 }, async t => {
  const SECRET = 'e2e-peer-credential-4b1d';
  const peer = await mockPeer(t, { token: SECRET, streaming: true });
  const stranger = await mockPeer(t); // Never approved: not on the allowlist.
  const ctx = await fixture(t, { serverOptions: { networkWorker: undefined, a2aOptions: { federation: { env: { PROMPTBOARD_A2A_PEER_TOKEN: SECRET } }, worker: { limits: { pollMs: 25 } } } } });
  const ok = async (pending, label, status = 200) => { const answer = await pending; assert.equal(answer.status, status, `${label}: ${answer.text}`); return answer.json; };
  const fed = async () => (await ctx.owner('/api/network/federation')).json;
  const lead = await ctx.register('lead');
  await ok(ctx.owner('/api/network/federation/outbound', 'PATCH', { expectedRevision: (await fed()).revision, enabled: true }), 'outbound on');
  const { preview } = await ok(ctx.owner('/api/network/federation/peers/preview', 'POST', { url: peer.cardUrl, localTest: true }), 'preview');
  assert.deepEqual([preview.card.name, preview.card.security], ['Mock peer', ['bearer']]);
  const trusted = (await ok(ctx.owner('/api/network/federation/peers', 'POST', { url: peer.cardUrl, localTest: true, cardSha256: preview.cardSha256, expectedRevision: (await fed()).revision, credentialEnv: 'PROMPTBOARD_A2A_PEER_TOKEN', credentialScheme: 'bearer' }), 'approve', 201)).peer;

  // The pipeline: a local research step (fake Claude through the real worker) and the remote peer in parallel → join → a local reviewer → approval → report.
  const network = (await ok(ctx.owner('/api/network/networks', 'POST', { name: 'Federated desk', nodes: [{ id: N('member:lead'), type: 'agent', agentId: lead.id, position: { x: 0, y: 0 } }, { id: N('member:peer'), type: 'federated', peerId: trusted.id, position: { x: 200, y: 0 } }], edges: [] }), 'network')).network;
  await ok(ctx.owner(`/api/network/networks/${network.id}/publish`, 'POST', { expectedRevision: network.revision }), 'publish network');
  const pipeline = (await ok(ctx.owner('/api/network/pipelines', 'POST', { networkId: network.id, networkVersion: 1, name: 'Federated report',
    nodes: [step('local', 'agent', { agentId: lead.id, instructions: 'Research locally.' }, 'Local research'), step('remote', 'federated', { peerId: trusted.id, instructions: 'Answer briefly.' }, 'Remote research'),
      step('join', 'join', { require: 'all' }, 'Join'), step('review', 'agent', { agentId: lead.id, instructions: 'Review the local and remote answers.' }, 'Review'),
      step('approve', 'approval', { prompt: 'Save it?' }, 'Approve'), step('report', 'output', { name: 'report', include: [N('local'), N('remote'), N('review')] }, 'Report')],
    edges: [edge('local', 'join', 'text'), edge('remote', 'join', 'text'), edge('join', 'review', 'done'), edge('review', 'approve', 'text'), edge('join', 'approve', 'done'), edge('approve', 'report', 'done')] }), 'pipeline')).pipeline;
  await ok(ctx.owner(`/api/network/pipelines/${pipeline.id}/publish`, 'POST', { expectedRevision: pipeline.revision }), 'publish pipeline');
  const runId = (await ok(ctx.owner(`/api/network/pipelines/${pipeline.id}/runs`, 'POST', { version: 1, confirm: true, input: { text: 'Is federation safe?' } }), 'start', 202)).runId;
  const runOf = async () => (await ok(ctx.owner(`/api/network/pipeline-runs/${runId}`), 'run')).run;
  await until(async () => (await runOf()).status === 'waiting_for_approval', 'the run waits for the approval');
  await ok(ctx.owner(`/api/network/pipeline-runs/${runId}/nodes/${N('approve')}/approve`, 'POST', { decision: 'approve' }), 'approve');
  const run = await until(async () => { const value = await runOf(); return ['completed', 'failed', 'blocked', 'cancelled'].includes(value.status) && value; }, 'the run ends');
  assert.equal(run.status, 'completed', JSON.stringify(run));
  const report = (await ok(ctx.owner(`/api/network/pipeline-runs/${runId}/nodes/${N('report')}/report`), 'report'));
  const reportText = JSON.stringify(report);
  assert.ok(reportText.includes('Answer from claude.') && reportText.includes('Remote answer to:'), 'the report holds the local and the remote result');
  const remoteJob = (await ok(ctx.owner(`/api/network/jobs/${run.nodes[N('remote')].jobId}`), 'remote job')).job;
  assert.deepEqual([remoteJob.peerId, remoteJob.status, remoteJob.attempts.length, remoteJob.attempts[0].provider, remoteJob.attempts[0].sideEffects, remoteJob.attempts[0].remoteTaskId], [trusted.id, 'completed', 1, 'a2a', 'external_unknown', peer.taskIds[0]]);
  assert.equal(peer.rpc('SendMessage').length + peer.rpc('SendStreamingMessage').length, 1, 'one remote task, no replay');
  assert.ok(peer.requests.filter(item => item.url === '/a2a').every(item => item.headers.authorization === `Bearer ${SECRET}`), 'the credential went to the endpoint');
  assert.ok(peer.requests.filter(item => item.method === 'GET').every(item => item.headers.authorization === undefined), 'never to the card');
  const locals = (await ok(ctx.owner(`/api/network/jobs?pipelineRunId=${runId}&limit=50`), 'jobs')).jobs;
  assert.deepEqual(locals.map(job => [job.nodeId, job.status]).sort(), [[N('local'), 'completed'], [N('remote'), 'completed'], [N('review'), 'completed']].sort(), 'one job per step');

  // Refused before anything is sent: private, link-local and loopback addresses, plain http outside a local test, a card whose
  // endpoint is a metadata address, a peer nobody approved, and a trusted peer that redirects its endpoint to another origin.
  for (const [url, localTest, code] of [['https://10.0.0.1/.well-known/agent-card.json', false, 'A2A_ADDRESS_REFUSED'], ['https://169.254.169.254/.well-known/agent-card.json', false, 'A2A_ADDRESS_REFUSED'],
    ['https://127.0.0.1/.well-known/agent-card.json', false, 'A2A_ADDRESS_REFUSED'], ['https://[::ffff:192.168.1.1]/.well-known/agent-card.json', false, 'A2A_ADDRESS_REFUSED'], [peer.cardUrl, false, 'A2A_URL_INSECURE'], ['http://10.0.0.1/', true, 'A2A_URL_INSECURE']]) {
    const answer = await ctx.owner('/api/network/federation/peers/preview', 'POST', { url, localTest });
    assert.deepEqual([answer.status >= 400, answer.json.code], [true, code], url);
  }
  const elsewhere = await mockPeer(t, { card: () => ({ supportedInterfaces: [{ url: 'http://169.254.169.254/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] }) });
  assert.equal((await ctx.owner('/api/network/federation/peers/preview', 'POST', { url: elsewhere.cardUrl, localTest: true })).json.code, 'CARD_ENDPOINT_REFUSED');
  assert.equal((await ctx.owner('/api/network/jobs', 'POST', { peerId: `peer_${'0'.repeat(20)}`, input: { text: 'Not approved.' } })).json.code, 'PEER_NOT_FOUND');
  const unlisted = await ctx.owner('/api/network/networks', 'POST', { name: 'Stranger', nodes: [{ id: N('member:stranger'), type: 'federated', peerId: `peer_${'1'.repeat(20)}`, position: { x: 0, y: 0 } }], edges: [] });
  assert.ok(unlisted.status >= 400, `a network cannot name a peer nobody approved: ${unlisted.text}`);
  const redirecting = await mockPeer(t, { token: SECRET, route: (req, res) => { if (req.method !== 'POST') return false; res.writeHead(307, { Location: `${stranger.url}/a2a` }); res.end(); return true; } });
  const { preview: second } = await ok(ctx.owner('/api/network/federation/peers/preview', 'POST', { url: redirecting.cardUrl, localTest: true }), 'preview 2');
  const moving = (await ok(ctx.owner('/api/network/federation/peers', 'POST', { url: redirecting.cardUrl, localTest: true, cardSha256: second.cardSha256, expectedRevision: (await fed()).revision, credentialEnv: 'PROMPTBOARD_A2A_PEER_TOKEN', credentialScheme: 'bearer' }), 'approve 2', 201)).peer;
  const redirected = (await ok(ctx.owner('/api/network/jobs', 'POST', { peerId: moving.id, input: { text: 'Follow me elsewhere.' } }), 'submit', 202)).jobId;
  const ended = await until(async () => { const { job } = (await ctx.owner(`/api/network/jobs/${redirected}`)).json; return !['queued', 'preparing', 'running'].includes(job.status) && job; }, 'the redirected job ends');
  assert.notEqual(ended.status, 'completed');
  assert.match(JSON.stringify(ended), /A2A_REDIRECT_REFUSED/);
  assert.deepEqual(stranger.requests, [], 'nothing, and so no credential, ever reached the endpoint that was not approved');
  for (const [path, text] of await texts(join(ctx.dataDir, 'network'))) assert.ok(!text.includes(SECRET), path);
});
