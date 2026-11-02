// External clients over REST (src/network/machine-auth.mjs, src/network/rest.mjs, the owner routes in
// src/network/http.mjs and the wiring in src/server.mjs): the machine listener is off by default and opens nothing on
// its own; clients are scoped and their tokens are shown once and stored as a hash; revoke and rotate; scoped agents,
// own jobs only, denials for agents, projects, networks and memory outside the scope; Host, Origin and rebinding checks,
// no CORS, body and rate limits; idempotent submits; streams that end on revoke; no token in any file, event, log or
// answer; restart; a missing worker. Real server, registry, job engine and journal on temporary data folders; jobs run
// only through the deterministic fake worker (tests/helpers/network-worker.mjs). No CLI, no network beyond 127.0.0.1.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { access, readdir, readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fakeWorker } from './helpers/network-worker.mjs';
import { ALL, fixture, refused, request, tick, until } from './helpers/network-machine.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const exists = path => access(path).then(() => true, () => false);
const TOKEN = /^pbm_cli_[0-9a-f]{20}_[A-Za-z0-9_-]{43}$/;

const status = async pending => { const answer = await pending; return [answer.status, answer.json?.code]; };

test('off by default: a fresh install and every Network read open no port and write nothing; on, it listens on 127.0.0.1 only and away from the app port; off closes it', async t => {
  const ctx = await fixture(t);
  for (const path of ['/api/network/listener', '/api/network/clients', '/api/network/agents', '/api/network/jobs', '/api/network/activity']) assert.equal((await ctx.owner(path)).status, 200, path);
  const { listener, mcp } = (await ctx.owner('/api/network/listener')).json;
  assert.deepEqual(listener, { enabled: false, port: 4330, bind: '127.0.0.1', listening: false, url: null, error: '' });
  assert.deepEqual([mcp.command, mcp.args.at(-1), mcp.env.token], ['node', '--mcp', 'PROMPTBOARD_MACHINE_TOKEN']);
  assert.equal(await exists(join(ctx.dataDir, 'network')), false, 'reading creates no Network file');
  // Refused changes write nothing and open nothing.
  for (const [body, code] of [[{ enabled: 'yes' }, 'INVALID_INPUT'], [{ port: 80 }, 'INVALID_INPUT'], [{ port: 70000 }, 'INVALID_INPUT'], [{ port: ctx.port }, 'PORT_IN_USE'], [{ enabled: true, bind: '0.0.0.0' }, 'INVALID_INPUT']]) {
    assert.equal((await ctx.owner('/api/network/listener', 'PATCH', body)).json.code, code, JSON.stringify(body));
  }
  assert.deepEqual([await exists(join(ctx.dataDir, 'network', 'clients.json')), (await ctx.owner('/api/network/listener')).json.listener.listening], [false, false]);
  const port = await ctx.on();
  assert.notEqual(port, ctx.port);
  // Bound to loopback only: another address of this computer is refused (checked when the computer has one).
  const other = Object.values(networkInterfaces()).flat().find(entry => entry && !entry.internal && entry.family === 'IPv4')?.address;
  if (other) assert.equal(await new Promise(resolve => { const socket = net.connect({ host: other, port }); socket.once('connect', () => { socket.destroy(); resolve('connected'); }); socket.once('error', error => resolve(error.code)); }), 'ECONNREFUSED');
  assert.equal((await ctx.machine(null, '/agents')).status, 401, 'it answers on 127.0.0.1');
  const saved = JSON.parse(await readFile(join(ctx.dataDir, 'network', 'clients.json'), 'utf8'));
  assert.deepEqual([saved.schema, saved.version, saved.listener, saved.clients], ['promptboard.network-clients', 1, { enabled: true, port: 0 }, []]);
  const off = (await ctx.owner('/api/network/listener', 'PATCH', { enabled: false })).json.listener;
  assert.deepEqual([off.enabled, off.listening, off.url], [false, false, null]);
  assert.equal(await refused(port), true, 'the port is closed');
});

test('clients: the token is shown once and stored only as its SHA-256; lists never show it; scopes are checked; revoke is final; rotate keeps the client and its jobs', async t => {
  let clock = Date.now();
  const ctx = await fixture(t, { worker: null, machineOptions: { now: () => clock } });
  const lead = await ctx.register('lead'), scout = await ctx.register('scout');
  await ctx.on();
  // Refused: no agent, an unknown agent, project or network, an unknown permission, a two-line name, a bad expiry, extra fields.
  const bad = [[{ name: 'x', scopes: { agents: [], permissions: ALL } }, 400], [{ name: 'x', scopes: { agents: [`agt_${'0'.repeat(20)}`], permissions: ALL } }, 409, 'AGENT_NOT_FOUND'],
    [{ name: 'x', scopes: { agents: [lead.id], projects: ['nope'], permissions: ALL } }, 409, 'PROJECT_NOT_FOUND'], [{ name: 'x', scopes: { agents: [lead.id], networks: [`net_${'0'.repeat(20)}`], permissions: ALL } }, 409, 'NETWORK_NOT_FOUND'],
    [{ name: 'x', scopes: { agents: [lead.id], permissions: ['admin'] } }, 400], [{ name: 'a\nb', scopes: { agents: [lead.id], permissions: ALL } }, 400], [{ name: 'x', scopes: { agents: [lead.id], permissions: ALL }, expiresInDays: 0 }, 400],
    [{ name: 'x', scopes: { agents: [lead.id], permissions: ALL, wildcard: true } }, 400], [{ name: 'x', scopes: { agents: [lead.id], permissions: ALL }, token: 'mine' }, 400]];
  for (const [body, code, error] of bad) { const answer = await ctx.owner('/api/network/clients', 'POST', body); assert.equal(answer.status, code, answer.text); if (error) assert.equal(answer.json.code, error); }
  const { client, token } = await ctx.client({ agents: [lead.id, scout.id], projects: [ctx.projects[0]] }, { name: 'Claude Code on this Mac', expiresInDays: 30 });
  assert.match(token, TOKEN);
  assert.ok(token.startsWith(`pbm_${client.id}_`));
  assert.deepEqual([client.status, client.tokenHint, client.scopes.agents, client.scopes.projects, client.scopes.permissions, client.revision], ['active', token.slice(-4), [lead.id, scout.id], [ctx.projects[0]], ALL, 1]);
  assert.equal(client.tokenSha256, undefined, 'the answer never carries the hash');
  const file = await readFile(join(ctx.dataDir, 'network', 'clients.json'), 'utf8');
  assert.ok(file.includes(sha(token)) && !file.includes(token) && !file.includes(token.slice(-43)), 'only the hash is stored');
  const listed = await ctx.owner('/api/network/clients');
  assert.ok(!listed.text.includes(token.slice(-43)) && !listed.text.includes(sha(token)), 'a list shows neither the token nor its hash');
  assert.equal(listed.json.clients[0].id, client.id);
  assert.equal((await ctx.machine(token, '/agents')).status, 200);
  // Rotate: the expected revision, a new token, the same client; the old token stops at once; its jobs stay its own.
  const job = (await ctx.machine(token, '/jobs', { method: 'POST', body: { agentId: lead.id, input: { text: 'Before rotation.' } } })).json.jobId;
  assert.equal((await ctx.owner(`/api/network/clients/${client.id}/rotate`, 'POST', { expectedRevision: 9 })).json.code, 'REVISION_CONFLICT');
  const rotated = (await ctx.owner(`/api/network/clients/${client.id}/rotate`, 'POST', { expectedRevision: 1 })).json;
  assert.match(rotated.token, TOKEN);
  assert.deepEqual([rotated.client.id, rotated.client.revision, rotated.token === token, typeof rotated.client.rotatedAt], [client.id, 2, false, 'number']);
  assert.deepEqual(await status(ctx.machine(token, '/agents')), [401, 'MACHINE_UNAUTHORIZED']);
  assert.equal((await ctx.machine(rotated.token, `/jobs/${job}`)).json.job.jobId, job, 'the rotated client still owns its job');
  // Expiry: the same 401 once the time passes; it is listed as expired and cannot be rotated.
  clock += 31 * 86_400_000;
  assert.deepEqual(await status(ctx.machine(rotated.token, '/agents')), [401, 'MACHINE_UNAUTHORIZED']);
  assert.equal((await ctx.owner('/api/network/clients')).json.clients[0].status, 'expired');
  assert.equal((await ctx.owner(`/api/network/clients/${client.id}/rotate`, 'POST', { expectedRevision: 2 })).json.code, 'CLIENT_EXPIRED');
  // Revoke: final and idempotent.
  const other = await ctx.client({ agents: [lead.id] });
  const revoked = (await ctx.owner(`/api/network/clients/${other.client.id}`, 'DELETE', {})).json;
  assert.deepEqual([revoked.revoked, revoked.client.status], [true, 'revoked']);
  assert.equal((await ctx.owner(`/api/network/clients/${other.client.id}`, 'DELETE', {})).json.revoked, false);
  assert.deepEqual(await status(ctx.machine(other.token, '/agents')), [401, 'MACHINE_UNAUTHORIZED']);
  assert.equal((await ctx.owner(`/api/network/clients/${other.client.id}/rotate`, 'POST', { expectedRevision: 2 })).json.code, 'CLIENT_REVOKED');
  assert.equal((await ctx.owner(`/api/network/clients/cli_${'0'.repeat(20)}`, 'DELETE', {})).status, 404);
  // Unknown, malformed and wrong tokens all look the same.
  for (const header of [undefined, 'Bearer', `Bearer ${other.token}x`, `Basic ${other.token}`, `Bearer pbm_${other.client.id}_${'A'.repeat(43)}`, `Bearer ${rotated.token.replace(client.id, `cli_${'f'.repeat(20)}`)}`]) {
    assert.deepEqual(await status(request(ctx.machinePort, '/machine/v1/agents', { headers: header ? { Authorization: header } : {} })), [401, 'MACHINE_UNAUTHORIZED'], header);
  }
});

test('REST: a client sees only its agents (public fields), submits get 202 at once, it polls and reads its result, cancels its own job; another client’s or the owner’s job is 404', async t => {
  const worker = fakeWorker({ mode: 'manual' });
  const ctx = await fixture(t, { worker });
  const lead = await ctx.register('lead'), scout = await ctx.register('scout'), gem = await ctx.register('gem');
  await ctx.owner('/api/network/settings', 'PATCH', { expectedRevision: 0, maxConcurrentJobs: 1 });
  await ctx.on();
  const a = await ctx.client({ agents: [lead.id, scout.id] }), b = await ctx.client({ agents: [lead.id, gem.id] });
  const agents = (await ctx.machine(a.token, '/agents')).json.agents;
  assert.deepEqual(agents.map(agent => agent.id), [lead.id, scout.id]);
  assert.deepEqual(Object.keys(agents[0]).sort(), ['available', 'capabilities', 'id', 'name', 'provider', 'tags', 'tools']);
  assert.deepEqual([agents[0].name, agents[0].provider, agents[0].tools, agents[0].available], ['Lead', 'claude', ['none', 'web'], true]);
  assert.ok(!JSON.stringify(agents).includes('SECRET-INSTRUCTIONS'), 'no Base content');
  assert.equal((await ctx.machine(a.token, `/agents/${scout.id}`)).json.agent.name, 'Scout');
  assert.deepEqual(await status(ctx.machine(a.token, `/agents/${gem.id}`)), [403, 'AGENT_NOT_ALLOWED']);
  assert.deepEqual(await status(ctx.machine(a.token, `/agents/agt_${'0'.repeat(20)}`)), [403, 'AGENT_NOT_ALLOWED'], 'existence is not revealed');

  // Submit answers at once while nothing has run; the job runs only when the worker takes it.
  const next = worker.next(), started = Date.now();
  const accepted = await ctx.machine(a.token, '/jobs', { method: 'POST', body: { agentId: lead.id, input: { text: 'Summarise the release notes.' } } });
  assert.equal(accepted.status, 202, accepted.text);
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual([accepted.json.status, accepted.json.deduplicated, accepted.json.job.jobId], ['queued', false, accepted.json.jobId]);
  const jobId = accepted.json.jobId, entry = await next;
  await entry.own.launching(); await entry.own.spawned({ pid: 7 });
  const running = (await ctx.machine(a.token, `/jobs/${jobId}`)).json.job;
  assert.deepEqual(Object.keys(running).sort(), ['agentId', 'attempts', 'createdAt', 'errorCode', 'jobId', 'networkId', 'outcome', 'projectId', 'reason', 'result', 'status', 'updatedAt', 'waiting']);
  assert.equal(running.status, 'running');
  assert.deepEqual(await status(ctx.machine(a.token, `/jobs/${jobId}/result`)), [404, 'NOT_FOUND'], 'no result before it completes');
  await entry.own.finish({ status: 'completed', exitCode: 0, result: { text: 'The release adds three features.', json: { features: 3 } } }); entry.end();
  const done = await until(async () => { const { job } = (await ctx.machine(a.token, `/jobs/${jobId}`)).json; return job.status === 'completed' && job; }, 'completed');
  assert.deepEqual([done.outcome, done.result.chars, done.result.json], ['completed', 32, true]);
  assert.deepEqual((await ctx.machine(a.token, `/jobs/${jobId}/result`)).json, { jobId, text: 'The release adds three features.', json: { features: 3 }, chars: 32 });
  const owned = (await ctx.owner(`/api/network/jobs/${jobId}`)).json.job;
  assert.deepEqual([owned.source, owned.requester], ['machine', { kind: 'machine', id: a.client.id }], 'the owner sees who submitted it');

  // A second job of its own runs (the one slot), then the owner's and client B's wait behind it.
  const nextActive = worker.next();
  const active = (await ctx.machine(a.token, '/jobs', { method: 'POST', body: { agentId: lead.id, input: { text: 'Still running.' } } })).json.jobId;
  const activeEntry = await nextActive;
  await activeEntry.own.launching(); await activeEntry.own.spawned({ pid: 8 });
  // Another client's and the owner's jobs do not exist for this client.
  const ownerJob = (await ctx.owner('/api/network/jobs', 'POST', { agentId: lead.id, input: { text: 'The owner’s own.' } })).json.jobId;
  const theirs = (await ctx.machine(b.token, '/jobs', { method: 'POST', body: { agentId: gem.id, input: { text: 'Client B’s.' } } })).json.jobId;
  for (const id of [ownerJob, theirs, `job_${'0'.repeat(20)}`]) {
    for (const [path, method] of [[`/jobs/${id}`, 'GET'], [`/jobs/${id}/result`, 'GET'], [`/jobs/${id}/cancel`, 'POST']]) assert.deepEqual(await status(ctx.machine(a.token, path, { method, ...(method === 'POST' ? { body: {} } : {}) })), [404, 'NOT_FOUND'], `${method} ${path}`);
  }
  assert.equal((await ctx.owner(`/api/network/jobs/${theirs}`)).json.job.status, 'queued', 'B’s job was not touched');
  const mine = (await ctx.machine(a.token, '/jobs')).json;
  assert.deepEqual([mine.total, mine.jobs.map(job => job.jobId).sort()], [2, [jobId, active].sort()]);
  assert.deepEqual((await ctx.machine(b.token, '/jobs?status=queued')).json.jobs.map(job => job.jobId), [theirs]);
  assert.equal((await ctx.machine(a.token, '/jobs?status=done')).status, 400);

  // Cancel its own jobs: one while queued (behind the others), recorded as the client's doing.
  const queued = (await ctx.machine(a.token, '/jobs', { method: 'POST', body: { agentId: scout.id, input: { text: 'Cancel me.' } } })).json.jobId;
  const cancel = await ctx.machine(a.token, `/jobs/${queued}/cancel`, { method: 'POST' });
  assert.deepEqual([cancel.status, cancel.json.cancelled, cancel.json.job.status, cancel.json.job.reason], [200, true, 'cancelled', 'Cancelled by the external client that submitted it.']);
  assert.equal((await ctx.owner(`/api/network/jobs/${queued}`)).json.job.history.at(-1).by, 'machine');
  assert.deepEqual(await status(ctx.machine(a.token, `/jobs/${queued}/cancel`, { method: 'POST', body: {} })), [409, 'JOB_FINISHED']);
  // A running one is stopped through the worker.
  const stopped = await ctx.machine(a.token, `/jobs/${active}/cancel`, { method: 'POST', body: {} });
  assert.deepEqual([stopped.json.cancelled, stopped.json.job.status, worker.cancels.includes(activeEntry.own.attemptId)], [true, 'cancelled', true]);
  // Events: only its own jobs, and only the narrow fields.
  const events = (await ctx.machine(a.token, '/events?after=0&limit=200')).json;
  assert.ok(events.events.length >= 5);
  assert.ok(events.events.every(event => [jobId, active, queued].includes(event.jobId)), 'only own jobs');
  assert.ok(events.events.every(event => !('attemptId' in event) && !('artifactRef' in event) && !('id' in event) && !('projectId' in event)));
  assert.deepEqual(events.events.filter(event => event.jobId === jobId).map(event => event.status), ['queued', 'preparing', 'running', 'completed']);
  assert.equal((await ctx.machine(b.token, '/events?after=0')).json.events.every(event => event.jobId === theirs), true);
});

test('permissions and denials: agent, project, network and memory outside the scope are 403; memory only when granted; no admin action exists for a machine token', async t => {
  const ctx = await fixture(t, { worker: null, machineOptions: { limits: { submitsPerMinute: 100 } } }); // Every refusal below is a submit.
  const [p1, p2] = ctx.projects;
  const lead = await ctx.register('lead', { projectAllowlist: [p1] }), scout = await ctx.register('scout');
  const network = (await ctx.owner('/api/network/networks', 'POST', { name: 'Research' })).json.network, other = (await ctx.owner('/api/network/networks', 'POST', { name: 'Other' })).json.network;
  await ctx.on();
  const plain = await ctx.client({ agents: [lead.id], projects: [p1], networks: [network.id] });
  const submit = (token, body, headers = {}) => ctx.machine(token, '/jobs', { method: 'POST', body: { agentId: lead.id, input: { text: 'Check the scope.' }, ...body }, headers });
  for (const [body, code] of [[{ agentId: scout.id }, 'AGENT_NOT_ALLOWED'], [{ agentId: `agt_${'0'.repeat(20)}` }, 'AGENT_NOT_ALLOWED'], [{ projectId: p2 }, 'PROJECT_NOT_ALLOWED'],
    [{ networkId: other.id }, 'NETWORK_NOT_ALLOWED'], [{ permissions: { memory: 'agent' } }, 'MEMORY_NOT_ALLOWED'], [{ projectId: p1, permissions: { projectLessons: true } }, 'MEMORY_NOT_ALLOWED'],
    [{ networkId: network.id, permissions: { memory: 'agent+network' } }, 'MEMORY_NOT_ALLOWED']]) {
    assert.deepEqual(await status(submit(plain.token, body)), [403, code], JSON.stringify(body));
  }
  // Fields only the owner or the app may set are not fields of a machine job.
  for (const body of [{ parentJobId: `job_${'0'.repeat(20)}` }, { idempotencyKey: 'in-the-body' }, { pipeline: { runId: `run_${'0'.repeat(20)}`, nodeId: `n_${'0'.repeat(12)}` } }, { permissions: { filesystem: 'workspace_write' } }]) {
    assert.equal((await submit(plain.token, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await ctx.owner('/api/network/jobs')).json.total, 0, 'nothing was submitted by any refusal');
  // Without read_scoped_memory a job gets no memory; with it, the agent's memory by default and lessons of its project.
  const allowed = await submit(plain.token, { projectId: p1, networkId: network.id });
  assert.equal(allowed.status, 202, allowed.text);
  assert.deepEqual((await ctx.owner(`/api/network/jobs/${allowed.json.jobId}`)).json.request.permissions, { filesystem: 'read_only', memory: 'none', projectLessons: false });
  const reader = await ctx.client({ agents: [lead.id], projects: [p1], permissions: [...ALL, 'read_scoped_memory'] });
  const withMemory = await submit(reader.token, { projectId: p1, permissions: { projectLessons: true } });
  assert.equal(withMemory.status, 202, withMemory.text);
  assert.deepEqual((await ctx.owner(`/api/network/jobs/${withMemory.json.jobId}`)).json.request.permissions, { filesystem: 'read_only', memory: 'agent', projectLessons: true });
  assert.deepEqual(await status(submit(reader.token, { projectId: p2, permissions: { projectLessons: true } })), [403, 'PROJECT_NOT_ALLOWED']);
  // Each permission guards its routes.
  const readOnly = await ctx.client({ agents: [lead.id], permissions: ['read_agents'] }), submitOnly = await ctx.client({ agents: [lead.id], permissions: ['submit_jobs'] });
  assert.deepEqual(await status(submit(readOnly.token, {})), [403, 'PERMISSION_DENIED']);
  assert.deepEqual(await status(ctx.machine(submitOnly.token, '/agents')), [403, 'PERMISSION_DENIED']);
  const own = (await submit(submitOnly.token, {})).json.jobId;
  assert.deepEqual(await status(ctx.machine(submitOnly.token, `/jobs/${own}/cancel`, { method: 'POST', body: {} })), [403, 'PERMISSION_DENIED']);
  assert.deepEqual(await status(ctx.machine(submitOnly.token, `/jobs/${own}/result`)), [403, 'PERMISSION_DENIED']);
  assert.equal((await ctx.machine(submitOnly.token, `/jobs/${own}`)).json.job.status, 'queued', 'its own job is still readable');
  // No admin action exists on the machine listener: approve, retry, close, delete, settings, clients, the owner API.
  for (const [method, path] of [['POST', `/jobs/${own}/approve`], ['POST', `/jobs/${own}/retry`], ['POST', `/jobs/${own}/close`], ['DELETE', `/jobs/${own}`], ['PATCH', '/settings'], ['POST', '/clients'], ['GET', '/clients'], ['GET', '/listener'], ['PATCH', '/listener']]) {
    assert.deepEqual(await status(ctx.machine(reader.token, path, { method, body: {} })), [404, 'NOT_FOUND'], `${method} ${path}`);
  }
  for (const path of ['/api/network/agents', '/api/session', '/api/board', '/']) assert.deepEqual(await status(request(ctx.machinePort, path, { headers: { Authorization: `Bearer ${reader.token}` } })), [404, 'NOT_FOUND'], path);
  // A machine token never works on the owner's routes, not even beside the owner's token.
  assert.equal((await request(ctx.port, '/api/network/agents', { headers: { Authorization: `Bearer ${reader.token}` } })).status, 403);
  assert.deepEqual(await status(ctx.owner('/api/network/agents', 'GET', undefined, { Authorization: `Bearer ${reader.token}` })), [403, 'MACHINE_TOKEN_REFUSED']);
  assert.deepEqual(await status(ctx.owner(`/api/network/jobs/${own}/approve`, 'POST', { expectedRevision: 1, decision: 'approve' }, { Authorization: `Bearer ${reader.token}` })), [403, 'MACHINE_TOKEN_REFUSED']);
  // The owner's token and a paired-phone cookie never act on the machine listener, even with a valid bearer token.
  assert.deepEqual(await status(ctx.machine(null, '/agents', { headers: { 'X-STE-Token': ctx.session } })), [403, 'MACHINE_CREDENTIAL_REQUIRED']);
  assert.deepEqual(await status(ctx.machine(reader.token, '/agents', { headers: { 'X-STE-Token': ctx.session } })), [403, 'MACHINE_CREDENTIAL_REQUIRED']);
  assert.deepEqual(await status(ctx.machine(reader.token, '/agents', { headers: { Cookie: 'theme=dark; pb_remote=abc' } })), [403, 'MACHINE_CREDENTIAL_REQUIRED']);
  assert.equal((await ctx.machine(reader.token, '/agents', { headers: { Cookie: 'theme=dark' } })).status, 200, 'another cookie is not a credential');
});

test('Host, Origin and rebinding: a foreign Host or Origin, cross-site and proxied requests are 403; no CORS header ever; bodies are bounded JSON; 60 requests and 10 submits a minute', async t => {
  const ctx = await fixture(t, { worker: null });
  const lead = await ctx.register('lead');
  const port = await ctx.on(), { token } = await ctx.client({ agents: [lead.id] });
  const answers = [];
  const ask = async (options, path = '/machine/v1/agents') => { const answer = await request(port, path, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } }); answers.push(answer); return [answer.status, answer.json?.code]; };
  for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1:${ctx.port}`, `localhost:${port + 1}`, `127.0.0.1.nip.io:${port}`, `[::1]:${port}`]) assert.deepEqual(await ask({ host }), [403, 'MACHINE_HOST'], host);
  for (const origin of ['http://evil.example', `http://127.0.0.1:${ctx.port}`, `https://127.0.0.1:${port}`, 'null']) assert.deepEqual(await ask({ headers: { Origin: origin } }), [403, 'MACHINE_ORIGIN'], origin);
  assert.deepEqual(await ask({ headers: { 'Sec-Fetch-Site': 'cross-site' } }), [403, 'MACHINE_ORIGIN']);
  for (const header of ['X-Forwarded-For', 'X-Forwarded-Host', 'Forwarded', 'Via', 'X-Real-IP', 'Tailscale-Funnel-Request']) assert.deepEqual(await ask({ headers: { [header]: 'x' } }), [403, 'PROXY_REFUSED'], header);
  assert.deepEqual(await ask({ headers: { Origin: `http://127.0.0.1:${port}` } }), [200, undefined], 'its own origin');
  assert.deepEqual(await ask({ host: `localhost:${port}` }), [200, undefined], 'localhost');
  // A CORS preflight gets no CORS answer.
  assert.deepEqual(await ask({ method: 'OPTIONS', headers: { Origin: `http://127.0.0.1:${port}`, 'Access-Control-Request-Method': 'POST' } }), [404, 'NOT_FOUND']);
  // Bodies: JSON only, at most 256 KiB.
  assert.deepEqual(await ask({ method: 'POST', raw: 'x', headers: { 'Content-Type': 'text/plain' } }, '/machine/v1/jobs'), [415, 'UNSUPPORTED_MEDIA_TYPE']);
  assert.deepEqual(await ask({ method: 'POST', raw: '{nope' }, '/machine/v1/jobs'), [400, 'INVALID_INPUT']);
  assert.deepEqual(await ask({ method: 'POST', body: { agentId: lead.id, input: { text: 'x'.repeat(300 * 1024) } } }, '/machine/v1/jobs'), [413, 'BODY_TOO_LARGE']);
  assert.deepEqual(await ask({ method: 'POST', body: [1] }, '/machine/v1/jobs'), [400, 'INVALID_INPUT']);
  for (const answer of answers) assert.ok(!Object.keys(answer.headers).some(name => name.startsWith('access-control-')), `no CORS header (${answer.status})`);
  assert.ok(answers.every(answer => answer.headers['cache-control'] === 'no-store' && answer.headers['x-content-type-options'] === 'nosniff'));
  // Rate limits per client: 10 submits a minute, then 60 requests a minute (counted per client, so another client still works).
  const limited = await ctx.client({ agents: [lead.id] }), fresh = await ctx.client({ agents: [lead.id] });
  const submits = [];
  for (let i = 0; i < 11; i++) submits.push((await ctx.machine(limited.token, '/jobs', { method: 'POST', body: { agentId: lead.id, input: { text: `Job ${i}.` } } })).status);
  assert.deepEqual(submits, [...Array(10).fill(202), 429]);
  const reads = [];
  for (let i = 0; i < 50; i++) reads.push((await ctx.machine(limited.token, '/agents')).status);
  assert.deepEqual([reads.slice(0, 49).every(code => code === 200), reads.at(-1)], [true, 429], 'the 61st request in a minute is refused');
  assert.equal((await ctx.machine(limited.token, '/agents')).headers['retry-after'], '60');
  assert.equal((await ctx.machine(fresh.token, '/agents')).status, 200);
});

test('idempotency and replay: the same key answers the same job, a changed body is a conflict, another client’s key is its own, a lost answer and its retry make one job; a replayed request with a revoked token is 401', async t => {
  const ctx = await fixture(t, { worker: null });
  const lead = await ctx.register('lead');
  const port = await ctx.on(), a = await ctx.client({ agents: [lead.id] }), b = await ctx.client({ agents: [lead.id] });
  const body = { agentId: lead.id, input: { text: 'Collect the open questions.' } };
  const submit = (token, key, payload = body) => ctx.machine(token, '/jobs', { method: 'POST', body: payload, headers: key ? { 'Idempotency-Key': key } : {} });
  const first = await submit(a.token, 'click-1');
  assert.equal(first.status, 202);
  const again = await submit(a.token, 'click-1');
  assert.deepEqual([again.status, again.json.jobId, again.json.deduplicated], [200, first.json.jobId, true]);
  const changed = await submit(a.token, 'click-1', { ...body, input: { text: 'Something else.' } });
  assert.deepEqual([changed.status, changed.json.code, changed.json.details.jobId], [409, 'IDEMPOTENCY_CONFLICT', first.json.jobId]);
  const otherClient = await submit(b.token, 'click-1');
  assert.deepEqual([otherClient.status, otherClient.json.jobId === first.json.jobId], [202, false], 'keys are scoped by client');
  assert.equal((await submit(a.token, 'k'.repeat(201))).status, 400);
  // A lost answer: the request arrives, the client never reads the reply, then sends it again.
  await new Promise(resolve => {
    const payload = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: '/machine/v1/jobs', method: 'POST', headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${a.token}`, 'Idempotency-Key': 'lost', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } });
    req.on('error', () => resolve()); req.on('close', resolve);
    req.end(payload, () => setTimeout(() => req.destroy(), 30));
  });
  const retried = await submit(a.token, 'lost');
  const mine = (await ctx.machine(a.token, '/jobs?limit=200')).json.jobs;
  assert.equal(mine.filter(job => job.jobId === retried.json.jobId).length, 1);
  assert.deepEqual([mine.length, (await ctx.owner('/api/network/jobs?limit=200')).json.total], [2, 3], 'one job per key: click-1 and lost for A, click-1 for B');
  // Replay after revocation.
  await ctx.owner(`/api/network/clients/${a.client.id}`, 'DELETE', {});
  assert.deepEqual(await status(submit(a.token, 'click-1')), [401, 'MACHINE_UNAUTHORIZED']);
  assert.deepEqual(await status(submit(a.token, 'brand-new')), [401, 'MACHINE_UNAUTHORIZED']);
  assert.equal((await ctx.owner('/api/network/jobs?limit=200')).json.total, 3);
});

/** NDJSON lines of a stream, read as they arrive. */
function openStream(port, token, after) {
  const lines = [];
  let ended = false, response;
  const req = http.request({ host: '127.0.0.1', port, path: `/machine/v1/events/stream${after === undefined ? '' : `?after=${after}`}`, headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${token}` } }, res => {
    response = res; let buffer = '';
    res.setEncoding('utf8');
    res.on('data', chunk => { buffer += chunk; let at; while ((at = buffer.indexOf('\n')) >= 0) { lines.push(JSON.parse(buffer.slice(0, at))); buffer = buffer.slice(at + 1); } });
    res.on('close', () => { ended = true; });
  });
  req.on('error', () => { ended = true; });
  req.end();
  return { lines, get ended() { return ended; }, get status() { return response?.statusCode; }, close: () => req.destroy() };
}

test('the event stream shows only the client’s own jobs, ends at once when the client is revoked or rotated, and is bounded', async t => {
  const ctx = await fixture(t, { worker: fakeWorker(), machineOptions: { limits: { streams: 5 } } }); // Machine streams together stay below the journal's 32.
  const lead = await ctx.register('lead');
  const port = await ctx.on(), a = await ctx.client({ agents: [lead.id] }), b = await ctx.client({ agents: [lead.id] });
  const stream = openStream(port, a.token, 0);
  await until(() => stream.lines.some(line => line.live), 'live');
  const mine = (await ctx.machine(a.token, '/jobs', { method: 'POST', body: { agentId: lead.id, input: { text: 'Mine.' } } })).json.jobId;
  const theirs = (await ctx.machine(b.token, '/jobs', { method: 'POST', body: { agentId: lead.id, input: { text: 'Theirs.' } } })).json.jobId;
  await ctx.owner('/api/network/jobs', 'POST', { agentId: lead.id, input: { text: 'The owner’s.' } });
  await until(async () => (await ctx.owner('/api/network/jobs?status=completed')).json.total === 3, 'all three completed');
  await until(() => stream.lines.filter(line => line.jobId === mine).length === 4, 'my four events');
  await tick(100);
  const events = stream.lines.filter(line => line.seq);
  assert.ok(events.every(event => event.jobId === mine), 'only its own job');
  assert.ok(!events.some(event => event.jobId === theirs));
  assert.deepEqual(events.map(event => event.status), ['queued', 'preparing', 'running', 'completed']);
  // A reconnect from 0 replays only its own events, each once.
  const replay = openStream(port, a.token, 0);
  await until(() => replay.lines.some(line => line.live), 'replay live');
  assert.deepEqual(replay.lines.filter(line => line.seq).map(line => line.seq), events.map(event => event.seq));
  replay.close();
  await until(() => ctx.app.networkEvents.streams()[`machine:${a.client.id}`] === 1, 'the replay stream is torn down');
  // Bounded: four streams per client.
  const extra = [1, 2, 3].map(() => openStream(port, a.token));
  await until(() => extra.every(item => item.status === 200), 'three more');
  const fifth = await request(port, '/machine/v1/events/stream', { headers: { Authorization: `Bearer ${a.token}` } });
  assert.deepEqual([fifth.status, fifth.json.code], [429, 'STREAM_LIMIT']);
  // Rotation ends every open stream of the old token at once; a new stream needs the new token.
  const other = openStream(port, b.token);
  await until(() => other.status === 200, 'b streams');
  const c = await ctx.client({ agents: [lead.id] });
  assert.deepEqual(await status(request(port, '/machine/v1/events/stream', { headers: { Authorization: `Bearer ${c.token}` } })), [429, 'STREAM_LIMIT'], 'all machine clients together: 5');
  await ctx.owner(`/api/network/clients/${a.client.id}/rotate`, 'POST', { expectedRevision: 1 });
  await until(() => stream.ended && extra.every(item => item.ended), 'streams of the rotated client ended', 2000);
  assert.equal(other.ended, false, 'another client’s stream stays open');
  const third = openStream(port, c.token);
  await until(() => third.status === 200, 'the closed streams freed their places');
  third.close();
  // Revocation does the same, and the token is 401 afterwards.
  await ctx.owner(`/api/network/clients/${b.client.id}`, 'DELETE', {});
  await until(() => other.ended, 'revoked stream ended', 2000);
  assert.deepEqual(await status(request(port, '/machine/v1/events/stream', { headers: { Authorization: `Bearer ${b.token}` } })), [401, 'MACHINE_UNAUTHORIZED']);
});

test('no token or secret in any Network file, event, log or answer after creation; the Network export holds no client', async t => {
  const logged = [], originals = {};
  for (const name of ['log', 'info', 'warn', 'error', 'debug']) { originals[name] = console[name]; console[name] = (...args) => { logged.push(args.map(String).join(' ')); }; }
  const stderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { logged.push(String(chunk)); return stderr(chunk, ...rest); };
  t.after(() => { Object.assign(console, originals); process.stderr.write = stderr; });
  const ctx = await fixture(t, { worker: fakeWorker() });
  const lead = await ctx.register('lead');
  await ctx.on();
  const created = await ctx.client({ agents: [lead.id] }), rotated = (await ctx.owner(`/api/network/clients/${created.client.id}/rotate`, 'POST', { expectedRevision: 1 })).json;
  const tokens = [created.token, rotated.token], secrets = tokens.flatMap(token => [token, token.slice(-43)]);
  const answers = [];
  const keep = async pending => { const answer = await pending; answers.push(answer.text); return answer; };
  const jobId = (await keep(ctx.machine(rotated.token, '/jobs', { method: 'POST', body: { agentId: lead.id, input: { text: 'Report.' } } }))).json.jobId;
  await until(async () => (await ctx.owner(`/api/network/jobs/${jobId}`)).json.job.status === 'completed', 'completed');
  for (const path of [`/jobs/${jobId}`, `/jobs/${jobId}/result`, '/jobs', '/agents', '/events?after=0']) await keep(ctx.machine(rotated.token, path));
  await keep(ctx.machine(created.token, '/agents')); // 401 with the old token
  for (const path of ['/api/network/clients', '/api/network/listener', '/api/network/export', `/api/network/jobs/${jobId}`, '/api/network/events?after=0&limit=200', '/api/network/activity']) await keep(ctx.owner(path));
  await keep(ctx.owner(`/api/network/clients/${created.client.id}`, 'DELETE', {}));
  // Every file under network/ (clients.json and its backup, the job, its request and result, the journal).
  const files = [];
  const walk = async dir => { for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) await walk(path); else files.push(path); } };
  await walk(join(ctx.dataDir, 'network'));
  assert.ok(files.some(path => path.endsWith('clients.json')) && files.some(path => path.endsWith('.jsonl')) && files.some(path => path.endsWith('request.json')));
  const everything = [...await Promise.all(files.map(path => readFile(path, 'utf8'))), ...answers, ...logged].join('\n');
  for (const secret of secrets) assert.ok(!everything.includes(secret), 'no token anywhere');
  assert.ok(!everything.includes(ctx.session), 'no owner token either');
  const exported = answers.find(text => text.includes('promptboard-network'));
  assert.ok(exported && !exported.includes(created.client.id) && !exported.includes('tokenSha256') && !exported.includes(sha(rotated.token)), 'the export holds no client');
});

test('restart: clients and the listener setting persist, a client’s jobs stay its own, and without a worker its jobs stay queued and say so', async t => {
  const first = await fixture(t, { worker: null });
  const lead = await first.register('lead');
  await first.on();
  const { client, token } = await first.client({ agents: [lead.id] });
  const jobId = (await first.machine(token, '/jobs', { method: 'POST', body: { agentId: lead.id, input: { text: 'Survive a restart.' } } })).json.jobId;
  const queued = (await first.machine(token, `/jobs/${jobId}`)).json.job;
  assert.deepEqual([queued.status, queued.waiting.for, queued.waiting.position], ['queued', 'worker', 1]);
  assert.match(queued.waiting.message, /No job worker is available/);
  await first.app.close();
  assert.equal(await refused(first.machinePort), true, 'shutdown closes the listener');
  const second = await fixture(t, { dataDir: first.dataDir, worker: null });
  const { listener } = (await second.owner('/api/network/listener')).json;
  assert.deepEqual([listener.enabled, listener.listening], [true, true], 'it listens again after the restart');
  second.machinePort = Number(new URL(listener.url).port);
  const mine = (await second.machine(token, '/jobs')).json;
  assert.deepEqual([mine.total, mine.jobs[0].jobId, mine.jobs[0].status, mine.jobs[0].waiting.for], [1, jobId, 'queued', 'worker']);
  assert.equal((await second.owner('/api/network/clients')).json.clients[0].id, client.id);
  // A worker after a restart runs it, and the client reads the result.
  await second.app.close();
  const third = await fixture(t, { dataDir: first.dataDir, worker: fakeWorker() });
  third.machinePort = Number(new URL((await third.owner('/api/network/listener')).json.listener.url).port);
  await until(async () => (await third.machine(token, `/jobs/${jobId}`)).json.job.status === 'completed', 'completed after the restart');
  assert.equal((await third.machine(token, `/jobs/${jobId}/result`)).json.text, 'Report for: Survive a restart.');
});

test('paired-device remote access stays separate: a phone lists and revokes clients but cannot create, rotate or open the listener, and never reaches the machine listener; a phone cookie is refused there', async t => {
  const ctx = await fixture(t, { worker: null });
  const lead = await ctx.register('lead');
  await ctx.on();
  const { client, token } = await ctx.client({ agents: [lead.id] });
  const remotePort = await new Promise(resolve => { const probe = net.createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
  assert.equal((await ctx.owner('/api/remote/settings', 'POST', { method: 'twingate', port: remotePort, bind: '127.0.0.1' })).status, 200);
  const { pairing } = (await ctx.owner('/api/remote/pairing', 'POST', {})).json;
  const cookie = (await request(remotePort, '/api/remote/pair', { method: 'POST', body: { code: pairing.code } })).headers['set-cookie'][0].split(';')[0];
  const session = (await request(remotePort, '/api/session', { headers: { Cookie: cookie } })).json.token;
  const phone = (path, method = 'GET', body, headers = {}) => request(remotePort, path, { method, body, headers: { Cookie: cookie, 'X-STE-Token': session, ...headers } });
  const listed = await phone('/api/network/clients');
  assert.deepEqual([listed.status, listed.json.clients[0].id, listed.text.includes(token.slice(-43))], [200, client.id, false]);
  assert.equal((await phone('/api/network/listener')).json.listener.listening, true);
  for (const [method, path, body] of [['PATCH', '/api/network/listener', { enabled: false }], ['POST', '/api/network/clients', { name: 'Phone', scopes: { agents: [lead.id], permissions: ['read_agents'] } }], ['POST', `/api/network/clients/${client.id}/rotate`, { expectedRevision: 1 }]]) {
    assert.deepEqual(await status(phone(path, method, body)), [403, 'REMOTE_LOCAL_ONLY'], `${method} ${path}`);
  }
  assert.equal((await ctx.owner('/api/network/listener')).json.listener.listening, true, 'still on');
  // The phone's listener forwards only to the owner app: no machine route there, and a machine token is refused.
  assert.equal((await phone('/machine/v1/agents')).status, 404);
  assert.deepEqual(await status(phone('/machine/v1/agents', 'GET', undefined, { Authorization: `Bearer ${token}` })), [403, 'MACHINE_TOKEN_REFUSED']);
  assert.deepEqual(await status(request(remotePort, '/api/network/agents', { headers: { Cookie: cookie, Authorization: `Bearer ${token}` } })), [403, 'MACHINE_TOKEN_REFUSED']);
  // The phone's cookie is no credential on the machine listener.
  assert.deepEqual(await status(ctx.machine(token, '/agents', { headers: { Cookie: cookie } })), [403, 'MACHINE_CREDENTIAL_REQUIRED']);
  // Revoking from the phone works: it only removes access.
  assert.equal((await phone(`/api/network/clients/${client.id}`, 'DELETE', {})).json.client.status, 'revoked');
  assert.deepEqual(await status(ctx.machine(token, '/agents')), [401, 'MACHINE_UNAUTHORIZED']);
  await ctx.owner('/api/remote/settings', 'POST', { method: 'local' });
});
