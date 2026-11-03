// Network owner routes through the real server (src/network/http.mjs behind server.mjs handle()): the request checks,
// bounded JSON bodies, a restart on the same data folder, an existing board, Base, backup and Origin project left
// byte-identical, no process started by any save, publish or import, and a paired device using every route.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { Board } from '../src/board.mjs';
import { git } from '../src/git.mjs';
import { startServer } from '../src/server.mjs';

const freePort = () => new Promise(resolve => { const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
/** One HTTP request with any headers (fetch cannot set Host). */
function request(port, path, { method = 'GET', headers = {}, body, raw, host = `127.0.0.1:${port}` } = {}) {
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { Host: host, ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, json }); });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
async function folder(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pb-network-http-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}
/** An existing install: a board project and two Base agents, saved before Network existed. */
async function legacy(dataDir) {
  const board = new Board({ dataDir });
  const project = await board.createProject({ name: 'Site' });
  await board.base.create({ id: 'lead', kind: 'profile', name: 'Lead', configuration: { agent: { provider: 'claude', model: 'sonnet' } } });
  await board.base.create({ id: 'team', kind: 'agentProfile', name: 'Team', configuration: { agents: [{ resourceId: 'lead', role: 'primary' }] } });
  return project.id;
}
async function start(t, dataDir, options = {}) {
  const app = await startServer({ port: 0, dataDir, executor: null, catalogReader: async provider => ({ provider, source: 'test fixture', models: [] }), ...options });
  t.after(() => app.close());
  const port = Number(new URL(app.url).port), token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = (path, method = 'GET', body) => request(port, path, { method, body, headers: { 'X-STE-Token': token } });
  return { app, port, token, call };
}
const ok = async (promise, label) => { const response = await promise; assert.equal(response.status, 200, `${label}: ${JSON.stringify(response.json)}`); return response.json; };
const pad = n => String(n).padStart(12, '0'), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const agentNode = (n, agentId) => ({ id: `n_${pad(n)}`, type: 'agent', agentId, position: { x: n, y: 0 } });

test('Network routes keep the token, Host, Origin and fetch-site checks; bodies are bounded JSON; reading creates nothing', async t => {
  const dataDir = await folder(t), { port, token, call } = await start(t, dataDir);
  const auth = { 'X-STE-Token': token };
  const refusals = [
    ['no token', request(port, '/api/network/agents')],
    ['wrong Host', request(port, '/api/network/agents', { headers: auth, host: `evil.example:${port}` })],
    ['foreign Origin', request(port, '/api/network/agents', { headers: { ...auth, Origin: 'http://evil.example' } })],
    ['cross-site fetch', request(port, '/api/network/agents', { headers: { ...auth, 'Sec-Fetch-Site': 'cross-site' } })],
    ['proxied request', request(port, '/api/network/export', { headers: { ...auth, 'X-Forwarded-For': '10.0.0.9' } })],
  ];
  for (const [label, pending] of refusals) assert.equal((await pending).status, 403, label);
  assert.equal((await request(port, '/api/network/agents', { method: 'POST', headers: { ...auth, 'Content-Type': 'text/plain' }, raw: '{}' })).status, 415);
  assert.equal((await request(port, '/api/network/agents', { method: 'POST', headers: auth, body: { baseResourceId: 'x'.repeat(70 * 1024), expectedRevision: 0 } })).status, 413);
  assert.deepEqual([(await request(port, '/api/network/networks', { method: 'POST', headers: auth, raw: '{nope' })).status], [400]);
  assert.deepEqual([(await call('/api/network/agents', 'DELETE')).status, (await call('/api/network/agents/agt_123')).status, (await call(`/api/network/networks/net_${'0'.repeat(20)}`)).status], [404, 404, 404]);
  const list = await ok(call('/api/network/agents'), 'list');
  assert.deepEqual([list.revision, list.total, list.agents], [0, 0, []]);
  assert.equal((await call('/api/network/agents?limit=500')).json.code, 'INVALID_INPUT');
  assert.ok(!(await readdir(dataDir)).includes('network'), 'no network folder until the first save');
});

test('owner flow over HTTP: a restart keeps everything; the board, Base, backup and Origin project stay byte-identical; nothing is spawned', async t => {
  const dataDir = await folder(t), projectId = await legacy(dataDir);
  // Every child process started by any module from here on is recorded (the Network code must start none).
  const spawned = [], names = ['spawn', 'execFile', 'exec', 'fork', 'spawnSync', 'execFileSync', 'execSync'], originals = Object.fromEntries(names.map(name => [name, childProcess[name]]));
  for (const name of names) childProcess[name] = function (...args) { spawned.push(`${name} ${args[0]}`); return originals[name].apply(this, args); };
  syncBuiltinESMExports();
  t.after(() => { Object.assign(childProcess, originals); syncBuiltinESMExports(); });
  await git(['--version'], { cwd: dataDir }).catch(() => {});
  assert.ok(spawned.length === 1 && /^execFile .*git/.test(spawned[0]), 'the recorder sees processes started inside src modules');
  spawned.length = 0;

  const first = await start(t, dataDir, { runner: async () => { spawned.push('runner'); throw new Error('no CLI'); }, researchRunner: async () => { spawned.push('research'); throw new Error('no CLI'); } });
  const origin = await ok(first.call('/api/origin/projects', 'POST', { name: 'Notes' }), 'origin project');
  // Every file outside network/ (state.json and its backup, Base revisions, the Origin project) by hash, plus what the
  // board backup, Base and Origin answer. Only the instance lock (it holds the port) may differ.
  const snapshot = async call => {
    const { exportedAt, base: { exportedAt: baseExportedAt, ...baseBackup }, ...backup } = await ok(call('/api/board/export'), 'board export');
    const base = await ok(call('/api/base'), 'base');
    const files = (await readdir(dataDir, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => relative(dataDir, join(entry.parentPath, entry.name)))
      .filter(path => path !== 'instance.lock' && !path.startsWith(`network${sep}`)).sort();
    return JSON.stringify({ files: await Promise.all(files.map(async path => [path, sha(await readFile(join(dataDir, path)))])), backup: { ...backup, base: baseBackup },
      base: [base.revision, base.resources.map(item => [item.id, item.revision, item.revisionRef.hash])], origin: (await ok(call('/api/origin/projects'), 'origin')).projects.map(item => [item.id, item.name, item.revision]) });
  };
  const before = await snapshot(first.call);
  const covered = JSON.parse(before).files.map(([path]) => path);
  assert.ok(covered.includes('state.json') && covered.some(path => path.startsWith(join('base', 'revisions'))) && covered.some(path => path.includes(origin.project.id.replace(/[A-Z_]/g, c => `_${c.toLowerCase()}`))), `the snapshot covers the board, Base and Origin files: ${covered}`);

  const lead = (await ok(first.call('/api/network/agents', 'POST', { baseResourceId: 'lead', expectedRevision: 0, tags: ['research'], projectAllowlist: [projectId] }), 'register')).agent;
  const team = (await ok(first.call('/api/network/agents', 'POST', { baseResourceId: 'team', expectedRevision: 1 }), 'register profile')).agent;
  assert.deepEqual([lead.base.model, team.base.kind], ['sonnet', 'agentProfile']);
  assert.equal((await first.call('/api/network/agents', 'POST', { baseResourceId: 'ghost', expectedRevision: 2 })).json.code, 'BASE_PROFILE_INVALID');
  assert.equal((await first.call(`/api/network/agents/${lead.id}`, 'PATCH', { expectedRevision: 9, enabled: false })).status, 409);
  await ok(first.call(`/api/network/agents/${lead.id}`, 'PATCH', { expectedRevision: 1, capabilities: ['summaries'] }), 'patch');
  const { network } = await ok(first.call('/api/network/networks', 'POST', { name: 'Research', nodes: [agentNode(1, lead.id), agentNode(2, team.id)], edges: [{ id: `e_${pad(1)}`, from: `n_${pad(1)}`, to: `n_${pad(2)}`, relation: 'delegate' }] }), 'network');
  const { published } = await ok(first.call(`/api/network/networks/${network.id}/publish`, 'POST', { expectedRevision: 1 }), 'publish');
  await ok(first.call(`/api/network/networks/${network.id}`, 'PATCH', { expectedRevision: 2, description: 'Draft after v1' }), 'edit draft');
  const cycle = await first.call(`/api/network/networks/${network.id}`, 'PATCH', { expectedRevision: 3, nodes: [{ id: `n_${pad(9)}`, type: 'subnetwork', networkId: network.id, version: 1, position: { x: 0, y: 0 } }], edges: [] });
  assert.deepEqual([cycle.status, cycle.json.code, cycle.json.details.path], [400, 'NETWORK_CYCLE', [network.id, network.id]]);
  const exported = await ok(first.call('/api/network/export'), 'export');
  const imported = await ok(first.call('/api/network/import', 'POST', { data: exported, expectedRevision: 3 }), 'import');
  assert.deepEqual(imported.imported, { agents: 2, networks: 1, versions: 1 });
  const unresolved = await first.call('/api/network/import', 'POST', { data: { ...exported, agents: exported.agents.map(row => ({ ...row, baseResourceId: 'ghost' })) }, expectedRevision: imported.revision });
  assert.deepEqual([unresolved.status, unresolved.json.code, unresolved.json.details.baseResourceIds], [409, 'NETWORK_IMPORT_UNRESOLVED', ['ghost']]);
  const listed = await ok(first.call(`/api/network/agents?tag=research&limit=1`), 'filtered list');
  assert.deepEqual([listed.total, listed.next, listed.agents[0].id], [2, 1, lead.id]);
  assert.equal(await snapshot(first.call), before, 'board, Base, backup and Origin unchanged by Network');
  const response = JSON.stringify([exported, imported, listed]);
  assert.ok(!response.includes(dataDir) && !response.includes(first.token), 'no path or token in Network responses');

  const view = async call => JSON.stringify([await ok(call('/api/network/agents?limit=200'), 'agents'), await ok(call('/api/network/networks'), 'networks'), await ok(call(`/api/network/networks/${network.id}`), 'draft'), await ok(call(`/api/network/networks/${network.id}/versions/1`), 'version')]);
  const shown = await view(first.call);
  await first.app.close();
  const second = await start(t, dataDir);
  assert.equal(await view(second.call), shown, 'same IDs, revisions, scopes, drafts and versions after a restart');
  assert.equal((await ok(second.call(`/api/network/networks/${network.id}/versions/1`), 'v1')).version.sha256, published.sha256);
  assert.equal(await snapshot(second.call), before, 'the existing data still loads and exports unchanged');
  assert.deepEqual(spawned, [], 'no save, publish or import started a process');
});

test('a paired device uses every Network route with its own session', async t => {
  const dataDir = await folder(t);
  await legacy(dataDir);
  const { call } = await start(t, dataDir), remotePort = await freePort();
  await ok(call('/api/remote/settings', 'POST', { method: 'twingate', port: remotePort, bind: '127.0.0.1' }), 'remote settings');
  const { pairing } = await ok(call('/api/remote/pairing', 'POST', {}), 'pairing');
  const cookie = (await request(remotePort, '/api/remote/pair', { method: 'POST', body: { code: pairing.code } })).headers['set-cookie'][0].split(';')[0];
  const token = (await request(remotePort, '/api/session', { headers: { Cookie: cookie } })).json.token;
  const phone = (path, method = 'GET', body) => request(remotePort, path, { method, body, headers: { Cookie: cookie, 'X-STE-Token': token } });
  const { agent } = await ok(phone('/api/network/agents', 'POST', { baseResourceId: 'lead', expectedRevision: 0 }), 'register');
  await ok(phone('/api/network/agents'), 'list agents');
  await ok(phone(`/api/network/agents/${agent.id}`), 'agent');
  await ok(phone(`/api/network/agents/${agent.id}`, 'PATCH', { expectedRevision: 1, displayName: 'From the phone' }), 'patch agent');
  const { network } = await ok(phone('/api/network/networks', 'POST', { name: 'Phone', nodes: [agentNode(1, agent.id)] }), 'network');
  await ok(phone('/api/network/networks'), 'list networks');
  await ok(phone(`/api/network/networks/${network.id}`), 'draft');
  await ok(phone(`/api/network/networks/${network.id}`, 'PATCH', { expectedRevision: 1, description: 'Edited' }), 'edit');
  await ok(phone(`/api/network/networks/${network.id}/publish`, 'POST', { expectedRevision: 2 }), 'publish');
  await ok(phone(`/api/network/networks/${network.id}/versions/1`), 'version');
  const data = await ok(phone('/api/network/export'), 'export');
  await ok(phone('/api/network/import', 'POST', { data, expectedRevision: 2 }), 'import');
  // Without the pairing cookie the remote listener refuses before the app sees the request.
  assert.equal((await request(remotePort, '/api/network/agents', { headers: { 'X-STE-Token': token } })).status, 401);
});
