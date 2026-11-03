// A2A federation through the real app (src/network/a2a-{registry,client,server}.mjs, the job engine, the pipeline runner,
// the machine listener and the owner routes): off by default; preview → review → approve of a peer card (local-only routes);
// a trusted peer's result flowing into a pipeline through a `federated` step; streaming, the poll fallback and a dropped
// stream; every remote state; a time limit → unknown with the steps after it blocked; cancellation that the peer confirms
// or not; outbound credentials by environment variable name; inbound A2A tasks from a permissioned caller as Network jobs;
// privacy; no public listener. Mock peers are built with the official @a2a-js/sdk 1.3.0 server classes on 127.0.0.1
// (tests/helpers/a2a-peer.mjs) and reached as "local test peers"; local jobs run on the deterministic fake worker. No CLI,
// no network beyond 127.0.0.1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Role } from '@a2a-js/sdk';
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { mockPeer } from './helpers/a2a-peer.mjs';
import { fakeWorker } from './helpers/network-worker.mjs';
import { fixture, request, until } from './helpers/network-machine.mjs';

const hex = text => createHash('sha256').update(text).digest('hex');
const N = name => `n_${hex(`step:${name}`).slice(0, 12)}`;
const exists = path => access(path).then(() => true, () => false);
const SECRET = 'peer-credential-value-7f3a9c';

/** The app with the fake worker for local jobs, the A2A worker polling fast, and the given environment for peer credentials. */
async function setup(t, { worker = fakeWorker(), env = {}, workerLimits = {} } = {}) {
  const ctx = await fixture(t, { worker, serverOptions: { a2aOptions: { federation: { env }, worker: { limits: { pollMs: 25, ...workerLimits } }, inbound: { pollMs: 20 } } } });
  ctx.fed = async () => (await ctx.owner('/api/network/federation')).json;
  ctx.ok = async (pending, label, status = 200) => { const answer = await pending; assert.equal(answer.status, status, `${label}: ${answer.text}`); return answer.json; };
  ctx.outbound = async (enabled = true) => ctx.ok(ctx.owner('/api/network/federation/outbound', 'PATCH', { expectedRevision: (await ctx.fed()).revision, enabled }), 'outbound switch');
  ctx.trust = async (peer, extra = {}) => {
    const { preview } = await ctx.ok(ctx.owner('/api/network/federation/peers/preview', 'POST', { url: peer.cardUrl, localTest: true }), 'preview');
    return (await ctx.ok(ctx.owner('/api/network/federation/peers', 'POST', { url: peer.cardUrl, localTest: true, cardSha256: preview.cardSha256, expectedRevision: (await ctx.fed()).revision, ...extra }), 'approve', 201)).peer;
  };
  ctx.job = async id => (await ctx.ok(ctx.owner(`/api/network/jobs/${id}`), 'job')).job;
  ctx.submitPeer = async (peerId, text = 'What is A2A?', extra = {}) => (await ctx.ok(ctx.owner('/api/network/jobs', 'POST', { peerId, input: { text }, ...extra }), 'submit', 202)).jobId;
  ctx.settled = (id, statuses = ['completed', 'failed', 'cancelled', 'unknown', 'interrupted']) => until(async () => { const job = await ctx.job(id); return statuses.includes(job.status) && job; }, `job ${id} settles`, 15000);
  /** A published network holding these nodes, and a published pipeline over it; answers both. */
  ctx.pipeline = async (members, definition, name = 'Remote pipeline') => {
    const network = (await ctx.ok(ctx.owner('/api/network/networks', 'POST', { name: `${name} network`, nodes: members.map((member, i) => ({ id: N(`member${i}`), ...member, position: { x: i * 200, y: 0 } })), edges: [] }), 'network')).network;
    await ctx.ok(ctx.owner(`/api/network/networks/${network.id}/publish`, 'POST', { expectedRevision: network.revision }), 'publish network');
    const { pipeline } = await ctx.ok(ctx.owner('/api/network/pipelines', 'POST', { networkId: network.id, networkVersion: 1, name, ...definition }), 'create pipeline');
    await ctx.ok(ctx.owner(`/api/network/pipelines/${pipeline.id}/publish`, 'POST', { expectedRevision: pipeline.revision }), 'publish pipeline');
    return { network, pipeline };
  };
  ctx.run = async (pipelineId, text) => (await ctx.ok(ctx.owner(`/api/network/pipelines/${pipelineId}/runs`, 'POST', { version: 1, confirm: true, input: { text } }), 'start run', 202)).runId;
  ctx.runOf = async id => (await ctx.ok(ctx.owner(`/api/network/pipeline-runs/${id}`), 'run')).run;
  return ctx;
}
const step = (name, type, config, label) => ({ id: N(name), type, label, position: { x: 0, y: 0 }, config });
const edge = (from, to, fromPort) => ({ id: `e_${hex(`${from}>${to}`).slice(0, 12)}`, from: N(from), to: N(to), fromPort });
/** Every file under `dir` with its text (for the secret checks). */
async function texts(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return Promise.all(entries.filter(entry => entry.isFile()).map(async entry => [join(entry.parentPath, entry.name), await readFile(join(entry.parentPath, entry.name), 'utf8')]));
}

test('acceptance: an explicitly trusted remote peer performs a task and its result flows into a Promptboard pipeline (federated step → local agent → report)', async t => {
  const peer = await mockPeer(t, { json: { score: 7 } });
  const ctx = await setup(t);
  const lead = await ctx.register('lead');
  await ctx.outbound();
  const trusted = await ctx.trust(peer);
  const { pipeline } = await ctx.pipeline([{ type: 'federated', peerId: trusted.id }, { type: 'agent', agentId: lead.id }], {
    nodes: [step('remote', 'federated', { peerId: trusted.id, instructions: 'Answer briefly.' }, 'Remote research'), step('review', 'agent', { agentId: lead.id, instructions: 'Review the remote answer.' }, 'Review'),
      step('report', 'output', { name: 'report', include: [N('remote'), N('review')] }, 'Report')],
    edges: [edge('remote', 'review', 'text'), edge('review', 'report', 'text'), edge('remote', 'report', 'text')],
  });
  const runId = await ctx.run(pipeline.id, 'Is federation safe?');
  const run = await until(async () => { const value = await ctx.runOf(runId); return ['completed', 'failed', 'blocked'].includes(value.status) && value; }, 'the run ends', 15000);
  assert.equal(run.status, 'completed', JSON.stringify(run));
  // The remote step is a Network job for the peer: external side effects, the peer's task ID kept exactly, protocol states only.
  const remoteJob = await ctx.job(run.nodes[N('remote')].jobId);
  assert.deepEqual([remoteJob.peerId, remoteJob.agentId, remoteJob.source, remoteJob.status], [trusted.id, null, 'pipeline', 'completed']);
  const attempt = remoteJob.attempts.at(-1);
  assert.deepEqual([attempt.provider, attempt.sideEffects, attempt.remoteTaskId, attempt.pid], ['a2a', 'external_unknown', peer.taskIds[0], null]);
  assert.deepEqual(remoteJob.history.map(entry => entry.status), ['queued', 'preparing', 'running', 'completed']);
  const result = await ctx.ok(ctx.owner(`/api/network/jobs/${remoteJob.id}/result`), 'result');
  assert.deepEqual([result.text, result.json], ['Remote answer to: Instructions:\nAnswer briefly.\n\nInput:\n' + (await ctx.ok(ctx.owner(`/api/network/jobs/${remoteJob.id}`), 'job')).request.input.text, { score: 7 }]);
  // The peer got the step's input (the run input as data) and nothing else: no memory, no Base content.
  const sent = peer.rpc('SendMessage')[0];
  assert.match(sent.params.message.parts[0].text, /Run input:\n {2}Is federation safe\?/);
  assert.equal(sent.params.message.messageId, attempt.id, 'one message per attempt');
  assert.ok(!JSON.stringify(peer.requests).includes('SECRET-INSTRUCTIONS'), 'no Base instructions reach the peer');
  // The local reviewer received the remote result as data, and the report holds both.
  const review = await ctx.ok(ctx.owner(`/api/network/jobs/${run.nodes[N('review')].jobId}`), 'review');
  assert.match(review.request.input.text, /Result of step “Remote research” \(n_[0-9a-f]{12}\):\n {2}Remote answer to: Instructions:/);
  const report = await ctx.ok(ctx.owner(`/api/network/pipeline-runs/${runId}/nodes/${N('report')}/report`), 'report');
  assert.match(report.text, /## Remote research\n\nRemote answer to:/);
  assert.match(report.text, /## Review\n\nReport for: Pipeline/);
});

test('off by default: no federation file, no outbound call (preview and peer jobs refused), no Agent Card or A2A endpoint, no listener', async t => {
  const peer = await mockPeer(t);
  const ctx = await setup(t);
  const view = await ctx.fed();
  assert.deepEqual([view.outbound, view.inbound.enabled, view.inbound.agents, view.peers, view.inbound.serving, view.inbound.cardUrl, view.inbound.listener.listening], [{ enabled: false }, false, [], [], false, null, false]);
  assert.equal(await exists(join(ctx.dataDir, 'network', 'federation.json')), false, 'reading creates nothing');
  const preview = await ctx.owner('/api/network/federation/peers/preview', 'POST', { url: peer.cardUrl, localTest: true });
  assert.deepEqual([preview.status, preview.json.code], [409, 'FEDERATION_OFF']);
  const job = await ctx.owner('/api/network/jobs', 'POST', { peerId: `peer_${'a'.repeat(20)}`, input: { text: 'Hello?' } });
  assert.deepEqual([job.status, job.json.code], [409, 'FEDERATION_OFF']);
  assert.equal(peer.requests.length, 0, 'no outbound call while outbound is off');
  // The machine listener on, an agent published, but inbound off: neither the card nor the endpoint exists.
  const lead = await ctx.register('lead');
  await ctx.on();
  await ctx.ok(ctx.owner('/api/network/federation/inbound', 'PATCH', { expectedRevision: (await ctx.fed()).revision, agents: [{ agentId: lead.id }] }), 'publish with inbound off');
  const rpc = { jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'x' } };
  assert.equal((await request(ctx.machinePort, '/.well-known/agent-card.json')).status, 404);
  assert.equal((await request(ctx.machinePort, '/a2a/v1', { method: 'POST', body: rpc })).status, 404);
  // Inbound on with nothing published: still no card.
  await ctx.ok(ctx.owner('/api/network/federation/inbound', 'PATCH', { expectedRevision: (await ctx.fed()).revision, enabled: true, agents: [] }), 'inbound on, nothing published');
  assert.equal((await request(ctx.machinePort, '/.well-known/agent-card.json')).status, 404);
  const after = await ctx.fed();
  assert.deepEqual([after.inbound.serving, after.inbound.cardUrl, after.outbound.enabled], [false, null, false]);
  // The machine listener binds 127.0.0.1 only, and the inbound endpoint lives only there.
  assert.match(after.inbound.listener.url, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test('peers: preview (nothing saved) → review → approve the exact card; only public card fields and a credential variable name are stored; changed cards, duplicates and disabled peers are refused; trust survives a restart', async t => {
  const peer = await mockPeer(t, { token: SECRET });
  const ctx = await setup(t, { env: { PROMPTBOARD_A2A_PEER_TOKEN: SECRET } });
  await ctx.outbound();
  const { preview } = await ctx.ok(ctx.owner('/api/network/federation/peers/preview', 'POST', { url: peer.cardUrl, localTest: true }), 'preview');
  assert.deepEqual([preview.card.name, preview.card.endpoint, preview.card.capabilities, preview.card.security, preview.origin],
    ['Mock peer', { url: `${peer.url}/a2a`, protocolVersion: '1.0', tenant: '' }, { streaming: false, pushNotifications: false }, ['bearer'], peer.url]);
  assert.deepEqual(preview.card.securitySchemes, [{ name: 'bearer', description: 'A token', type: 'bearer', scheme: 'Bearer' }]);
  assert.deepEqual(preview.card.skills, [{ id: 'answer', name: 'Answer', description: 'Answers a question.', tags: ['test'], examples: [] }]);
  assert.ok(preview.warnings.some(text => /asks for a credential/.test(text)) && preview.warnings.some(text => /does not verify card signatures/.test(text)));
  assert.equal(await exists(join(ctx.dataDir, 'network', 'federation.json')), true, 'only the outbound switch was saved');
  assert.equal((await ctx.fed()).peers.length, 0, 'a preview saves no peer');
  const revision = (await ctx.fed()).revision, base = { url: peer.cardUrl, localTest: true, expectedRevision: revision };
  // Refused: another card hash, a pasted credential instead of a variable name, an unsupported scheme, a stale revision.
  for (const [body, code] of [[{ cardSha256: '0'.repeat(64) }, 'CARD_CHANGED'], [{ cardSha256: preview.cardSha256, credentialEnv: SECRET, credentialScheme: 'bearer' }, 'CREDENTIAL_REFERENCE_INVALID'],
    [{ cardSha256: preview.cardSha256, credentialEnv: 'PROMPTBOARD_A2A_PEER_TOKEN', credentialScheme: 'oauth' }, 'CREDENTIAL_SCHEME_UNSUPPORTED'], [{ cardSha256: preview.cardSha256, expectedRevision: revision + 5 }, 'REVISION_CONFLICT'],
    [{ cardSha256: preview.cardSha256, localTest: false }, 'A2A_URL_INSECURE']]) {
    assert.equal((await ctx.owner('/api/network/federation/peers', 'POST', { ...base, ...body })).json.code, code, JSON.stringify(body));
  }
  const approved = (await ctx.ok(ctx.owner('/api/network/federation/peers', 'POST', { ...base, cardSha256: preview.cardSha256, credentialEnv: 'PROMPTBOARD_A2A_PEER_TOKEN', credentialScheme: 'bearer' }), 'approve', 201)).peer;
  assert.match(approved.id, /^peer_[0-9a-f]{20}$/);
  assert.deepEqual([approved.enabled, approved.cardSha256, approved.credential, approved.localTest, approved.privateAddress], [true, preview.cardSha256, { env: 'PROMPTBOARD_A2A_PEER_TOKEN', scheme: 'bearer', set: true }, true, null]);
  assert.equal((await ctx.owner('/api/network/federation/peers', 'POST', { ...base, expectedRevision: (await ctx.fed()).revision, cardSha256: preview.cardSha256 })).json.code, 'PEER_EXISTS');
  const stored = JSON.parse(await readFile(join(ctx.dataDir, 'network', 'federation.json'), 'utf8'));
  assert.deepEqual([stored.schema, stored.version, stored.outbound, stored.peers[0].credential], ['promptboard.network-federation', 1, { enabled: true }, { env: 'PROMPTBOARD_A2A_PEER_TOKEN', scheme: 'bearer' }]);
  assert.ok(!JSON.stringify(stored).includes(SECRET), 'the credential value is never stored');
  // A peer job runs with the credential read from the environment, sent only to the endpoint, never to the card fetch.
  const jobId = await ctx.submitPeer(approved.id);
  assert.equal((await ctx.settled(jobId)).status, 'completed');
  assert.ok(peer.requests.filter(item => item.url === '/a2a').every(item => item.headers.authorization === `Bearer ${SECRET}`));
  assert.ok(peer.requests.filter(item => item.method === 'GET').every(item => item.headers.authorization === undefined), 'the card is fetched without the credential');
  // Switched off: jobs are refused at submit; a queued job would fail at claim. Removing it is allowed and final.
  const off = await ctx.ok(ctx.owner(`/api/network/federation/peers/${approved.id}`, 'PATCH', { expectedRevision: approved.revision, enabled: false }), 'disable');
  assert.equal(off.peer.enabled, false);
  assert.equal((await ctx.owner('/api/network/jobs', 'POST', { peerId: approved.id, input: { text: 'x' } })).json.code, 'PEER_DISABLED');
  // A refreshed card is kept only when it is exactly what a fresh preview showed.
  assert.equal((await ctx.owner(`/api/network/federation/peers/${approved.id}`, 'PATCH', { expectedRevision: off.peer.revision, cardSha256: '1'.repeat(64) })).json.code, 'CARD_CHANGED');
  const refreshed = await ctx.ok(ctx.owner(`/api/network/federation/peers/${approved.id}`, 'PATCH', { expectedRevision: off.peer.revision, cardSha256: preview.cardSha256, enabled: true }), 'refresh');
  assert.deepEqual([refreshed.peer.enabled, refreshed.peer.revision, refreshed.peer.credential.env], [true, off.peer.revision + 1, 'PROMPTBOARD_A2A_PEER_TOKEN']);
  // Restart: the peer and the switch come back as they were.
  await ctx.app.close();
  const restarted = await fixture(t, { dataDir: ctx.dataDir, serverOptions: { a2aOptions: { federation: { env: { PROMPTBOARD_A2A_PEER_TOKEN: SECRET } } } } });
  const view = (await restarted.owner('/api/network/federation')).json;
  assert.deepEqual([view.outbound.enabled, view.peers.map(item => [item.id, item.enabled, item.cardSha256])], [true, [[approved.id, true, preview.cardSha256]]]);
  const removed = await restarted.owner(`/api/network/federation/peers/${approved.id}`, 'DELETE', { expectedRevision: view.peers[0].revision });
  assert.equal(removed.status, 200, removed.text);
  assert.equal((await restarted.owner('/api/network/jobs', 'POST', { peerId: approved.id, input: { text: 'x' } })).json.code, 'PEER_NOT_FOUND');
});

test('malicious or broken Agent Cards are bounded or refused: markup stays text, spoofing characters go, links and icons are dropped, odd endpoints and protocols are refused, oversized cards are cut off', async t => {
  const big = 'x'.repeat(70 * 1024);
  const evil = await mockPeer(t, { card: () => ({ name: '<img src=x onerror=alert(1)>Evil\u202eexe.txt', description: `<script>steal()</script>${'d'.repeat(5000)}`, iconUrl: 'javascript:alert(1)', documentationUrl: 'http://169.254.169.254/latest',
    provider: { organization: 'Org', url: 'http://10.0.0.1/' }, securitySchemes: { __proto__: { httpAuthSecurityScheme: { scheme: 'Bearer' } }, oauth: { oauth2SecurityScheme: { flows: {} } }, key: { apiKeySecurityScheme: { location: 'header', name: 'Cookie' } } },
    skills: Array.from({ length: 80 }, (_, i) => ({ id: `s${i}`, name: `Skill ${i}`, description: 'd', tags: ['a'], examples: [] })) }) });
  const ctx = await setup(t);
  await ctx.outbound();
  const { preview } = await ctx.ok(ctx.owner('/api/network/federation/peers/preview', 'POST', { url: evil.cardUrl, localTest: true }), 'preview');
  assert.equal(preview.card.name, '<img src=x onerror=alert(1)>Evilexe.txt', 'markup is kept as text; the bidi override is removed');
  assert.equal([...preview.card.description].length, 2000);
  assert.ok(preview.card.description.endsWith('…'));
  assert.deepEqual([preview.card.iconUrl, preview.card.documentationUrl, preview.card.provider], [undefined, undefined, 'Org']);
  assert.equal(preview.card.skills.length, 50);
  assert.deepEqual(preview.card.securitySchemes.map(item => [item.name, item.type, item.header]), [['oauth', 'oauth2', undefined], ['key', 'apiKey', undefined]], 'a __proto__ key is dropped; a reserved header is never used');
  assert.equal({}.httpAuthSecurityScheme, undefined, 'no prototype was touched');
  for (const warning of [/markup/, /shortened/, /left out/, /more skills/]) assert.ok(preview.warnings.some(text => warning.test(text)), String(warning));
  // Refused cards: another host as endpoint, a javascript: endpoint, no A2A 1.x JSON-RPC interface, no name, not JSON, too large.
  const cases = [
    [port => ({ supportedInterfaces: [{ url: 'http://169.254.169.254/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] }), 'CARD_ENDPOINT_REFUSED'],
    [() => ({ supportedInterfaces: [{ url: 'javascript:alert(1)', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] }), 'CARD_ENDPOINT_REFUSED'],
    [port => ({ supportedInterfaces: [{ url: `http://127.0.0.1:${port}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '0.3' }] }), 'CARD_UNSUPPORTED'],
    [port => ({ supportedInterfaces: [{ url: `http://127.0.0.1:${port}/a2a`, protocolBinding: 'GRPC', protocolVersion: '1.0' }] }), 'CARD_UNSUPPORTED'],
    [() => ({ name: { toString: 'x' } }), 'CARD_INVALID'],
    [() => ({ description: big }), 'PEER_RESPONSE_TOO_LARGE'],
  ];
  for (const [card, code] of cases) {
    const bad = await mockPeer(t, { card });
    const answer = await ctx.owner('/api/network/federation/peers/preview', 'POST', { url: bad.cardUrl, localTest: true });
    assert.equal(answer.json.code, code, answer.text);
  }
  const notJson = await mockPeer(t, { route: (req, res) => { if (req.method !== 'GET') return false; res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>hi</html>'); return true; } });
  assert.equal((await ctx.owner('/api/network/federation/peers/preview', 'POST', { url: notJson.cardUrl, localTest: true })).json.code, 'CARD_INVALID');
  assert.equal((await ctx.fed()).peers.length, 0, 'nothing was saved');
});

test('outbound states: streaming, a dropped stream falls back to polling, polling alone; every remote state maps to the job lifecycle; a stream lost before a task is unknown', async t => {
  const ctx = await setup(t);
  await ctx.outbound();
  // Streaming: one SendStreamingMessage, no polling, protocol states as activity.
  const streaming = await mockPeer(t, { streaming: true });
  const streamJob = await ctx.submitPeer((await ctx.trust(streaming)).id, 'Stream it.');
  const streamed = await ctx.settled(streamJob);
  assert.deepEqual([streamed.status, streaming.rpc('SendStreamingMessage').length, streaming.rpc('GetTask').length], ['completed', 1, 0]);
  // The journal is written after each saved transition, without holding it up: wait for the last event to land.
  const events = await until(async () => { const page = (await ctx.ok(ctx.owner(`/api/network/events?jobId=${streamJob}&limit=200`), 'events')).events; return page.some(event => event.type === 'job.status' && event.status === 'completed') && page; }, 'the completed event is journaled');
  assert.deepEqual(events.filter(event => event.type === 'job.status').map(event => event.status), ['queued', 'preparing', 'running', 'completed']);
  assert.ok(events.some(event => event.type === 'job.activity' && event.message === 'The remote agent reports that it is working.'));
  // The stream drops after its first event while the remote task goes on: the worker polls the same task to its end.
  const dropping = await mockPeer(t, { streaming: true, dropStream: true });
  const dropJob = await ctx.submitPeer((await ctx.trust(dropping)).id, 'Drop it.');
  const dropped = await ctx.settled(dropJob);
  assert.equal(dropped.status, 'completed', JSON.stringify(dropped));
  assert.ok(dropping.rpc('GetTask').length >= 1 && dropping.rpc('GetTask').every(call => call.params.id === dropping.taskIds[0]), 'polls the same, exact task ID');
  await until(async () => (await ctx.ok(ctx.owner(`/api/network/events?jobId=${dropJob}&limit=200`), 'events')).events.some(event => event.message === 'The stream ended early; following the remote task by polling.'), 'the fallback is journaled');
  // Polling only (the card does not stream): SendMessage returns at once, GetTask until the end.
  const polling = await mockPeer(t, { hold: true });
  const pollJob = await ctx.submitPeer((await ctx.trust(polling)).id, 'Poll it.');
  await until(async () => (await ctx.job(pollJob)).status === 'running', 'running while the peer works');
  await until(() => polling.rpc('GetTask').length >= 2, 'polled while the task works');
  polling.release();
  assert.equal((await ctx.settled(pollJob)).status, 'completed');
  assert.equal(polling.rpc('SendMessage')[0].params.configuration.returnImmediately, true);
  // Every terminal or interrupted remote state, and one the protocol does not define.
  for (const [finish, status, code] of [['TASK_STATE_FAILED', 'failed', 'REMOTE_FAILED'], ['TASK_STATE_REJECTED', 'failed', 'REMOTE_REJECTED'], ['TASK_STATE_CANCELED', 'failed', 'REMOTE_CANCELLED'],
    ['TASK_STATE_INPUT_REQUIRED', 'failed', 'REMOTE_INPUT_REQUIRED'], ['TASK_STATE_AUTH_REQUIRED', 'failed', 'REMOTE_AUTH_REQUIRED'], ['TASK_STATE_UNSPECIFIED', 'unknown', 'REMOTE_STATE_UNKNOWN']]) {
    const peer = await mockPeer(t, { finish });
    const job = await ctx.settled(await ctx.submitPeer((await ctx.trust(peer)).id, finish));
    assert.deepEqual([job.status, job.errorCode, job.attempts.at(-1).sideEffects], [status, code, 'external_unknown'], finish);
    assert.ok(!job.reason.includes('Remote said no'), 'the peer’s own words never become the job’s reason');
  }
  // A stream that ends before the peer named a task: whether it started is not known.
  const lost = await mockPeer(t, { streaming: true, route: (req, res, _peer, body) => { if (req.method !== 'POST' || !body.includes('SendStreamingMessage')) return false; res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.destroy(); return true; } });
  const lostJob = await ctx.settled(await ctx.submitPeer((await ctx.trust(lost)).id, 'Lose it.'));
  assert.deepEqual([lostJob.status, lostJob.errorCode, lostJob.outcome], ['unknown', 'REMOTE_STREAM_LOST', 'uncertain']);
  // A server error after the request reached the peer: it may have done work.
  const stopped = await mockPeer(t, { route: (req, res) => { if (req.method !== 'POST') return false; res.writeHead(503); res.end(); return true; } });
  const busy = await ctx.settled(await ctx.submitPeer((await ctx.trust(stopped)).id, 'Busy?'));
  assert.deepEqual([busy.status, busy.errorCode], ['unknown', 'REMOTE_SERVER_ERROR'], 'a 5xx may have done work: unknown');
  // Refused by the peer before it took the task (an HTTP 4xx): a definite failure.
  const refusing = await mockPeer(t, { route: (req, res) => { if (req.method !== 'POST') return false; res.writeHead(429); res.end(); return true; } });
  const refused = await ctx.settled(await ctx.submitPeer((await ctx.trust(refusing)).id, 'Too many?'));
  assert.deepEqual([refused.status, refused.errorCode, refused.outcome], ['failed', 'REMOTE_BUSY', 'failed']);
});

test('a remote step that runs past its time limit ends unknown (never completed) and blocks the steps after it; a retry needs confirmation', async t => {
  const peer = await mockPeer(t, { hold: true });
  const ctx = await setup(t);
  await ctx.outbound();
  const trusted = await ctx.trust(peer);
  const { pipeline } = await ctx.pipeline([{ type: 'federated', peerId: trusted.id }], {
    nodes: [step('remote', 'federated', { peerId: trusted.id, timeoutMs: 1000 }, 'Slow peer'), step('report', 'output', { name: 'report', include: [N('remote')] }, 'Report')],
    edges: [edge('remote', 'report', 'text')],
  }, 'Slow pipeline');
  const runId = await ctx.run(pipeline.id, 'Take your time.');
  const run = await until(async () => { const value = await ctx.runOf(runId); return value.status === 'blocked' && value; }, 'the run is blocked', 15000);
  const job = await ctx.job(run.nodes[N('remote')].jobId);
  assert.deepEqual([job.status, job.errorCode, job.outcome], ['unknown', 'TIMEOUT', 'uncertain']);
  assert.match(job.reason, /did not finish within the 1-second limit/);
  assert.deepEqual([run.nodes[N('remote')].status, run.nodes[N('report')].status], ['blocked', 'pending']);
  assert.equal((await ctx.owner(`/api/network/jobs/${job.id}/retry`, 'POST', { expectedRevision: job.revision, confirm: true })).json.code, 'UNCERTAIN_CONFIRMATION_REQUIRED');
});

test('cancelling a remote job asks the peer: "confirmed" only when the protocol confirms it, otherwise the outcome stays uncertain', async t => {
  const ctx = await setup(t);
  await ctx.outbound();
  for (const [cancel, outcome, said] of [['confirm', 'cancelled', /The remote agent confirmed the cancellation\./], ['refuse', 'uncertain', /did not confirm, so it may still finish its work/]]) {
    const peer = await mockPeer(t, { hold: true, cancel });
    const jobId = await ctx.submitPeer((await ctx.trust(peer)).id, `Cancel me (${cancel}).`);
    const running = await until(async () => { const job = await ctx.job(jobId); return job.status === 'running' && job; }, 'running');
    const answer = await ctx.ok(ctx.owner(`/api/network/jobs/${jobId}/cancel`, 'POST', {}), 'cancel');
    assert.deepEqual([answer.job.status, answer.job.outcome], ['cancelled', outcome], cancel);
    assert.match(answer.job.reason, said);
    assert.deepEqual(peer.rpc('CancelTask').map(call => call.params.id), [running.attempts.at(-1).remoteTaskId], 'the cancel names the exact remote task');
  }
});

test('outbound credentials: read from the named environment variable at call time; missing → refused before anything is sent; wrong → the peer refuses; never stored, returned or journaled', async t => {
  const peer = await mockPeer(t, { token: SECRET });
  const env = { PROMPTBOARD_A2A_PEER_TOKEN: SECRET };
  const ctx = await setup(t, { env });
  await ctx.outbound();
  const { preview } = await ctx.ok(ctx.owner('/api/network/federation/peers/preview', 'POST', { url: peer.cardUrl, localTest: true }), 'preview');
  const trusted = (await ctx.ok(ctx.owner('/api/network/federation/peers', 'POST', { url: peer.cardUrl, localTest: true, cardSha256: preview.cardSha256, expectedRevision: (await ctx.fed()).revision, credentialEnv: 'PROMPTBOARD_A2A_PEER_TOKEN', credentialScheme: 'bearer' }), 'approve', 201)).peer;
  assert.equal((await ctx.settled(await ctx.submitPeer(trusted.id))).status, 'completed');
  delete env.PROMPTBOARD_A2A_PEER_TOKEN;
  const calls = peer.rpc('SendMessage').length;
  const missing = await ctx.settled(await ctx.submitPeer(trusted.id, 'No credential.'));
  assert.deepEqual([missing.status, missing.errorCode, missing.attempts.at(-1).launchingAt], ['failed', 'CREDENTIAL_MISSING', null]);
  assert.equal(peer.rpc('SendMessage').length, calls, 'nothing was sent without the credential');
  env.PROMPTBOARD_A2A_PEER_TOKEN = 'wrong-value';
  const wrong = await ctx.settled(await ctx.submitPeer(trusted.id, 'Wrong credential.'));
  assert.deepEqual([wrong.status, wrong.errorCode], ['failed', 'REMOTE_AUTH']);
  // The value never appears in the data folder, the journal, or what the owner routes answer.
  const files = await texts(join(ctx.dataDir, 'network'));
  assert.ok(files.length > 3);
  for (const [path, text] of files) assert.ok(!text.includes(SECRET) && !text.includes('wrong-value'), path);
  for (const path of ['/api/network/federation', '/api/network/jobs?limit=200', '/api/network/events?limit=200', '/api/network/activity', '/api/network/export']) {
    const answer = await ctx.owner(path);
    assert.ok(!answer.text.includes(SECRET) && !answer.text.includes('wrong-value'), path);
  }
});

/** An official SDK client for the inbound endpoint, sending the caller's token. */
async function callerClient(port, token) {
  const fetchImpl = (url, init = {}) => fetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers ?? {})), authorization: `Bearer ${token}` } });
  const card = await new DefaultAgentCardResolver({ fetchImpl }).resolve(`http://127.0.0.1:${port}`);
  return new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl })], cardResolver: new DefaultAgentCardResolver({ fetchImpl }) }).createFromAgentCard(card);
}
const message = (messageId, text, extra = {}) => ({ messageId, contextId: '', taskId: '', role: Role.ROLE_USER, parts: [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
  metadata: undefined, extensions: [], referenceTaskIds: [], ...extra });
const A2A_PERMISSIONS = ['submit_jobs', 'read_job_result', 'cancel_own_jobs'];

test('acceptance: a permissioned A2A client submits to one explicitly published local agent through the private authenticated endpoint; the task is a Network job and its status and result come from that job', async t => {
  const worker = fakeWorker();
  const ctx = await setup(t, { worker });
  const lead = await ctx.register('lead'), scout = await ctx.register('scout');
  const port = await ctx.on();
  await ctx.ok(ctx.owner('/api/network/federation/inbound', 'PATCH', { expectedRevision: (await ctx.fed()).revision, enabled: true, agents: [{ agentId: lead.id, description: 'Answers questions about the docs.' }] }), 'publish');
  // The card lists only the published agent, names the private endpoint and asks for a bearer token; no Base content.
  const cardAnswer = await request(port, '/.well-known/agent-card.json');
  assert.equal(cardAnswer.status, 200);
  const card = cardAnswer.json;
  assert.deepEqual(card.supportedInterfaces, [{ url: `http://127.0.0.1:${port}/a2a/v1`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }]);
  assert.deepEqual(card.skills.map(skill => [skill.id, skill.name, skill.description]), [[lead.id, 'Lead', 'Answers questions about the docs.']]);
  assert.deepEqual(Object.keys(card.securitySchemes), ['promptboard']);
  assert.ok(!cardAnswer.text.includes('SECRET-INSTRUCTIONS') && !cardAnswer.text.includes(scout.id));
  const view = await ctx.fed();
  assert.deepEqual([view.inbound.serving, view.inbound.cardUrl, view.inbound.endpoint], [true, `http://127.0.0.1:${port}/.well-known/agent-card.json`, `http://127.0.0.1:${port}/a2a/v1`]);
  // Callers are machine clients of kind a2a, only for published agents and without projects or networks.
  assert.equal((await ctx.owner('/api/network/clients', 'POST', { kind: 'a2a', name: 'Partner', scopes: { agents: [scout.id], permissions: A2A_PERMISSIONS } })).json.code, 'AGENT_NOT_PUBLISHED');
  assert.equal((await ctx.owner('/api/network/clients', 'POST', { kind: 'a2a', name: 'Partner', scopes: { agents: [lead.id], projects: [ctx.projects[0]], permissions: A2A_PERMISSIONS } })).status, 400);
  const { client, token } = await ctx.client({ agents: [lead.id], permissions: A2A_PERMISSIONS }, { kind: 'a2a', name: 'Partner agent' });
  assert.equal(client.kind, 'a2a');
  const other = await ctx.client({ agents: [lead.id], permissions: A2A_PERMISSIONS }, { kind: 'a2a', name: 'Another partner' });
  const api = await ctx.client({ agents: [lead.id] }, { name: 'REST app' });
  // The official SDK client: SendMessage (blocking) → the job runs through the job engine's worker → COMPLETED with the result.
  const sdk = await callerClient(port, token);
  const task = await sdk.sendMessage({ tenant: '', message: message('msg-1', 'Summarise the A2A protocol.'), configuration: undefined, metadata: undefined });
  assert.match(task.id, /^job_[0-9a-f]{20}$/);
  assert.equal(task.status.state, 3, JSON.stringify(task));
  assert.equal(task.artifacts[0].parts[0].content.value, 'Report for: Summarise the A2A protocol.');
  const job = await ctx.ok(ctx.owner(`/api/network/jobs/${task.id}`), 'job');
  assert.deepEqual([job.job.source, job.job.requester, job.job.agentId, job.request.permissions.memory, job.request.projectId], ['a2a', { kind: 'a2a', id: client.id }, lead.id, 'none', null]);
  assert.deepEqual(worker.claims, [job.job.attempts[0].id], 'the job engine ran it on its worker: no CLI was started from the endpoint');
  // GetTask reads the same job; the same messageId answers the same task (one job); another caller cannot see it.
  assert.equal((await sdk.getTask({ tenant: '', id: task.id })).status.state, 3);
  assert.equal((await sdk.sendMessage({ tenant: '', message: message('msg-1', 'Summarise the A2A protocol.'), configuration: undefined, metadata: undefined })).id, task.id);
  assert.equal((await ctx.ok(ctx.owner('/api/network/jobs'), 'jobs')).total, 1);
  await assert.rejects((await callerClient(port, other.token)).getTask({ tenant: '', id: task.id }), error => /does not exist/.test(error.message));
  // Refused: no token, an API client's token here, an A2A token on /machine/v1, another agent, files and links, follow-ups, streaming.
  const rpc = (body, auth = token) => request(port, '/a2a/v1', { method: 'POST', body: { jsonrpc: '2.0', id: 9, ...body }, headers: auth ? { Authorization: `Bearer ${auth}` } : {} });
  const send = (parts, extra = {}) => rpc({ method: 'SendMessage', params: { message: { messageId: `m-${Math.random()}`, role: 'ROLE_USER', parts }, ...extra } });
  assert.equal((await rpc({ method: 'GetTask', params: { id: task.id } }, null)).status, 401);
  assert.equal((await rpc({ method: 'GetTask', params: { id: task.id } }, api.token)).status, 401);
  assert.equal((await request(port, '/machine/v1/agents', { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  assert.equal((await send([{ text: 'x' }], { metadata: { skillId: scout.id } })).json.error.code, -32602, 'an agent outside the caller’s scope');
  assert.equal((await send([{ url: 'http://169.254.169.254/latest/meta-data', mediaType: 'text/plain' }])).json.error.code, -32005);
  assert.equal((await send([{ text: 'more' }])).json.result.task.status.state, 'TASK_STATE_COMPLETED', 'raw JSON-RPC 1.0 works too');
  assert.equal((await rpc({ method: 'SendMessage', params: { message: { messageId: 'follow', taskId: task.id, role: 'ROLE_USER', parts: [{ text: 'and?' }] } } })).json.error.code, -32004);
  assert.equal((await rpc({ method: 'SendStreamingMessage', params: { message: { messageId: 's1', role: 'ROLE_USER', parts: [{ text: 'stream' }] } } })).json.error.code, -32004);
  assert.equal((await rpc({ method: 'ListTasks', params: {} })).json.error.code, -32004);
  // Privacy: answers hold the job's state and result only: no instructions, memory, attempts, process IDs or file paths.
  const answer = await rpc({ method: 'GetTask', params: { id: task.id } });
  for (const hidden of ['SECRET-INSTRUCTIONS', ctx.dataDir, job.job.attempts[0].id, '4242', 'prompt']) assert.ok(!answer.text.includes(hidden), hidden);
  // An agent that needs the owner's approval: the task waits as SUBMITTED; the caller may cancel it; the job says who did.
  await ctx.ok(ctx.owner('/api/network/federation/inbound', 'PATCH', { expectedRevision: (await ctx.fed()).revision, agents: [{ agentId: lead.id, requireApproval: true }] }), 'require approval');
  const waiting = await sdk.sendMessage({ tenant: '', message: message('msg-2', 'Needs approval.'), configuration: undefined, metadata: undefined }); // Blocking: returns as soon as the job waits for the owner.
  assert.equal(waiting.status.state, 1);
  assert.match(waiting.status.message.parts[0].content.value, /Waiting for the owner/);
  const cancelled = await sdk.cancelTask({ tenant: '', id: waiting.id, metadata: undefined });
  assert.equal(cancelled.status.state, 5);
  assert.equal((await ctx.job(waiting.id)).history.at(-1).by, 'machine');
  // Restart: the task is still the job, so GetTask answers from it after the app starts again.
  await ctx.app.close();
  const restarted = await fixture(t, { dataDir: ctx.dataDir, worker: fakeWorker() });
  const listener = (await restarted.owner('/api/network/listener')).json.listener;
  assert.equal(listener.listening, true);
  assert.equal((await (await callerClient(Number(new URL(listener.url).port), token)).getTask({ tenant: '', id: task.id })).artifacts[0].parts[0].content.value, 'Report for: Summarise the A2A protocol.');
  // Revoked: the token stops at once.
  await restarted.owner(`/api/network/clients/${client.id}`, 'DELETE', {});
  assert.equal((await request(Number(new URL(listener.url).port), '/a2a/v1', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: task.id } }, headers: { Authorization: `Bearer ${token}` } })).status, 401);
});

test('Graph and pipeline scope: a federated node names a trusted peer; issues name a switched-off peer or outbound off; a remote step must be a member of its network version; peer jobs carry no tools, memory or project; exports never carry peers', async t => {
  const peer = await mockPeer(t);
  const ctx = await setup(t);
  await ctx.outbound();
  const trusted = await ctx.trust(peer);
  const missing = `peer_${'b'.repeat(20)}`;
  const refused = await ctx.owner('/api/network/networks', 'POST', { name: 'Ghost', nodes: [{ id: N('ghost'), type: 'federated', peerId: missing, position: { x: 0, y: 0 } }], edges: [] });
  assert.deepEqual([refused.status, refused.json.code, refused.json.details.peerIds], [400, 'NETWORK_REFERENCE_INVALID', [missing]]);
  const lead = await ctx.register('lead');
  const created = await ctx.ok(ctx.owner('/api/network/networks', 'POST', { name: 'Mixed', nodes: [{ id: N('remote'), type: 'federated', peerId: trusted.id, position: { x: 0, y: 0 } }, { id: N('lead'), type: 'agent', agentId: lead.id, position: { x: 200, y: 0 } }],
    edges: [{ id: 'e_000000000001', from: N('lead'), to: N('remote'), relation: 'delegate' }] }), 'network');
  assert.deepEqual([created.refs.peers[trusted.id], created.issues], [{ name: 'Mock peer', origin: peer.url, enabled: true, outbound: true }, []]);
  await ctx.ok(ctx.owner(`/api/network/networks/${created.network.id}/publish`, 'POST', { expectedRevision: created.network.revision }), 'publish');
  // A pipeline step for a peer that is not a node of the pinned version is refused; a member validates.
  const other = await mockPeer(t);
  const outsider = await ctx.trust(other);
  const draft = (peerId, name) => ctx.ok(ctx.owner('/api/network/pipelines', 'POST', { networkId: created.network.id, networkVersion: 1, name, nodes: [step('r', 'federated', { peerId }, 'Remote'), step('o', 'output', { include: [N('r')] }, 'Out')], edges: [edge('r', 'o', 'json')] }), name);
  const wrong = (await draft(outsider.id, 'Outsider')).pipeline;
  const checked = await ctx.ok(ctx.owner(`/api/network/pipelines/${wrong.id}/validate`, 'POST', {}), 'validate outsider');
  assert.deepEqual([checked.valid, checked.error.code, checked.error.details.nodeId], [false, 'PIPELINE_PEER_NOT_IN_NETWORK', N('r')]);
  const good = (await draft(trusted.id, 'Member')).pipeline;
  const valid = await ctx.ok(ctx.owner(`/api/network/pipelines/${good.id}/validate`, 'POST', {}), 'validate member');
  assert.deepEqual([valid.valid, valid.summary.remoteSteps], [true, 1]);
  // Switched off, then outbound off: the network shows why and pipelines refuse to compile.
  const off = await ctx.ok(ctx.owner(`/api/network/federation/peers/${trusted.id}`, 'PATCH', { expectedRevision: trusted.revision, enabled: false }), 'disable');
  assert.deepEqual((await ctx.ok(ctx.owner(`/api/network/networks/${created.network.id}`), 'detail')).issues.map(issue => issue.code), ['PEER_DISABLED']);
  assert.equal((await ctx.ok(ctx.owner(`/api/network/pipelines/${good.id}/validate`, 'POST', {}), 'validate')).error.code, 'PEER_DISABLED');
  await ctx.ok(ctx.owner(`/api/network/federation/peers/${trusted.id}`, 'PATCH', { expectedRevision: off.peer.revision, enabled: true }), 'enable');
  await ctx.outbound(false);
  assert.deepEqual((await ctx.ok(ctx.owner(`/api/network/networks/${created.network.id}`), 'detail')).issues.map(issue => issue.code), ['FEDERATION_OFF']);
  assert.equal((await ctx.ok(ctx.owner(`/api/network/pipelines/${good.id}/validate`, 'POST', {}), 'validate')).error.code, 'FEDERATION_OFF');
  await ctx.outbound(true);
  // A peer job carries only its input and instructions.
  for (const extra of [{ tools: 'web' }, { permissions: { memory: 'agent' } }, { projectId: ctx.projects[0] }, { agentId: lead.id }]) {
    assert.ok(['PEER_SCOPE', 'INVALID_INPUT'].includes((await ctx.owner('/api/network/jobs', 'POST', { peerId: trusted.id, input: { text: 'x' }, ...extra })).json.code), JSON.stringify(extra));
  }
  // The export keeps the node (its peer ID) but never a peer, its card or its credential reference; an import keeps the node.
  const exported = await ctx.ok(ctx.owner('/api/network/export'), 'export');
  assert.equal(exported.peers, undefined);
  assert.ok(!JSON.stringify(exported).includes(peer.cardUrl));
  assert.ok(exported.networks.find(item => item.id === created.network.id).nodes.some(node => node.type === 'federated' && node.peerId === trusted.id));
});

test('A2A caller scopes: only its own published agents; without cancel or result permissions it can neither cancel nor read results', async t => {
  const ctx = await setup(t);
  const lead = await ctx.register('lead'), scout = await ctx.register('scout');
  const port = await ctx.on();
  await ctx.ok(ctx.owner('/api/network/federation/inbound', 'PATCH', { expectedRevision: (await ctx.fed()).revision, enabled: true, agents: [{ agentId: lead.id }, { agentId: scout.id, requireApproval: true }] }), 'publish both');
  const { token } = await ctx.client({ agents: [scout.id], permissions: ['submit_jobs'] }, { kind: 'a2a', name: 'Narrow caller' });
  const rpc = body => request(port, '/a2a/v1', { method: 'POST', body: { jsonrpc: '2.0', id: 3, ...body }, headers: { Authorization: `Bearer ${token}` } });
  const send = (messageId, skillId) => rpc({ method: 'SendMessage', params: { message: { messageId, role: 'ROLE_USER', parts: [{ text: 'Hello' }] }, configuration: { returnImmediately: true }, ...(skillId ? { metadata: { skillId } } : {}) } });
  assert.equal((await send('m-lead', lead.id)).json.error.code, -32602, 'a published agent outside its scope is refused');
  const waiting = (await send('m-scout', scout.id)).json.result.task;
  assert.equal(waiting.status.state, 'TASK_STATE_SUBMITTED');
  assert.equal((await rpc({ method: 'CancelTask', params: { id: waiting.id } })).json.error.code, -32004, 'no cancel permission');
  assert.equal((await ctx.job(waiting.id)).status, 'waiting_for_approval', 'nothing was cancelled');
  // The owner approves; the job completes on the fake worker; the caller sees COMPLETED without the result it may not read.
  const job = await ctx.job(waiting.id);
  await ctx.ok(ctx.owner(`/api/network/jobs/${waiting.id}/approve`, 'POST', { expectedRevision: job.revision, decision: 'approve' }), 'approve');
  await ctx.settled(waiting.id);
  const done = (await rpc({ method: 'GetTask', params: { id: waiting.id } })).json.result;
  assert.deepEqual([done.status.state, done.artifacts ?? []], ['TASK_STATE_COMPLETED', []]);
});

test('remote answers Promptboard cannot trust: another task ID than the one accepted is unknown; more than the result limit fails', async t => {
  const ctx = await setup(t, { workerLimits: { resultBytes: 200 } });
  await ctx.outbound();
  // The peer accepts the task, then answers a poll about a different task: nothing it says is used.
  const swapping = await mockPeer(t, { hold: true, route: (req, res, _peer, body) => {
    if (req.method !== 'POST' || !body.includes('"GetTask"')) return false;
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body).id, result: { id: 'another-task', contextId: 'c', status: { state: 'TASK_STATE_COMPLETED' } } })); return true;
  } });
  const swapped = await ctx.settled(await ctx.submitPeer((await ctx.trust(swapping)).id, 'Swap.'));
  assert.deepEqual([swapped.status, swapped.errorCode, swapped.attempts.at(-1).remoteTaskId], ['unknown', 'REMOTE_PROTOCOL', swapping.taskIds[0]]);
  // An answer larger than the result limit is not kept.
  const long = await mockPeer(t, { answer: () => 'x'.repeat(500) });
  const tooLong = await ctx.settled(await ctx.submitPeer((await ctx.trust(long)).id, 'Long.'));
  assert.deepEqual([tooLong.status, tooLong.errorCode, tooLong.result], ['failed', 'OUTPUT_LIMIT', null]);
});

test('a peer whose card changed after a job was accepted is refused at claim, before any attempt or request', async t => {
  let version = 1;
  const peer = await mockPeer(t, { card: () => ({ version: `${version}.0.0` }) });
  const ctx = await setup(t);
  await ctx.outbound();
  const trusted = await ctx.trust(peer);
  const jobId = await ctx.submitPeer(trusted.id, 'Accepted with version 1.', { requireApproval: true });
  version = 2; // The peer publishes a new card; the owner reviews and keeps it.
  const { preview } = await ctx.ok(ctx.owner('/api/network/federation/peers/preview', 'POST', { url: peer.cardUrl, localTest: true }), 'preview');
  await ctx.ok(ctx.owner(`/api/network/federation/peers/${trusted.id}`, 'PATCH', { expectedRevision: trusted.revision, cardSha256: preview.cardSha256 }), 'keep the new card');
  const job = await ctx.job(jobId);
  await ctx.ok(ctx.owner(`/api/network/jobs/${jobId}/approve`, 'POST', { expectedRevision: job.revision, decision: 'approve' }), 'approve');
  const ended = await ctx.settled(jobId);
  assert.deepEqual([ended.status, ended.errorCode, ended.attempts.length], ['failed', 'PEER_CHANGED', 0], 'refused by the engine’s claim: no attempt was even made');
  assert.equal(peer.rpc('SendMessage').length, 0);
});

test('inbound tasks report the job’s state honestly: a job whose outcome is unknown is not "completed" or "failed" for the caller', async t => {
  const worker = fakeWorker({ mode: 'manual' });
  const ctx = await setup(t, { worker });
  const lead = await ctx.register('lead');
  const port = await ctx.on();
  await ctx.ok(ctx.owner('/api/network/federation/inbound', 'PATCH', { expectedRevision: (await ctx.fed()).revision, enabled: true, agents: [{ agentId: lead.id }] }), 'publish');
  const { token } = await ctx.client({ agents: [lead.id], permissions: A2A_PERMISSIONS }, { kind: 'a2a', name: 'Caller' });
  const rpc = body => request(port, '/a2a/v1', { method: 'POST', body: { jsonrpc: '2.0', id: 5, ...body }, headers: { Authorization: `Bearer ${token}` } });
  const started = worker.next();
  const task = (await rpc({ method: 'SendMessage', params: { message: { messageId: 'u1', role: 'ROLE_USER', parts: [{ text: 'Maybe.' }] }, configuration: { returnImmediately: true } } })).json.result.task;
  const entry = await started;
  await entry.own.launching(); await entry.own.spawned({ pid: 4242 });
  assert.equal((await rpc({ method: 'GetTask', params: { id: task.id } })).json.result.status.state, 'TASK_STATE_WORKING');
  await entry.own.finish({ status: 'unknown', errorCode: 'INVALID_OUTPUT', reason: 'Exit 0 without an answer.' }); entry.end();
  const after = (await rpc({ method: 'GetTask', params: { id: task.id } })).json.result;
  assert.deepEqual([after.status.state ?? 'TASK_STATE_UNSPECIFIED', after.artifacts ?? []], ['TASK_STATE_UNSPECIFIED', []], 'proto-JSON leaves out the default (unspecified) state');
  assert.match(after.status.message.parts[0].text, /The outcome of this task is not known/);
  assert.ok(!JSON.stringify(after).includes('Exit 0 without an answer') && !JSON.stringify(after).includes('4242'), 'the job’s own reason and process stay private');
  assert.equal((await rpc({ method: 'CancelTask', params: { id: task.id } })).json.error.code, -32002, 'it cannot be cancelled: the owner decides');
});
