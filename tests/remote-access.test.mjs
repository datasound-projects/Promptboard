// Remote access with SIMULATED networks: the remote listener on 127.0.0.1 stands in for what Tailscale Serve or a
// Twingate Connector forwards, and a fake Tailscale CLI answers its status commands. No real tailnet, Twingate network
// or phone is used here; see docs/remote-access.md for the real-device check.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateAddress, remoteSettings, RemoteAccess, tailscaleState } from '../src/remote-access.mjs';
import { NETWORK_ROUTES } from '../src/network/http.mjs';
import { startTestServer } from './helpers/test-server.mjs';
import { setup, until } from './helpers/ui-harness.mjs';

const freePort = () => new Promise(resolve => { const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
/** One HTTP request with any headers (fetch cannot set Host). Resolves { status, headers, body, json }. */
function request(port, path, { method = 'GET', headers = {}, body, host = `127.0.0.1:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    // A length, as browsers send: Node drops a kept-alive socket after a refused request whose chunked body was not read.
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { Host: host, ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(body)) } : {}), ...headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, body: text, json }); });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
async function app(t, options = {}) {
  const server = await startTestServer(t, { port: 0, executor: null, ...options });
  const port = Number(new URL(server.url).port), token = (await (await fetch(`${server.url}/api/session`)).json()).token;
  const local = (path, method = 'GET', body) => fetch(`${server.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async r => ({ status: r.status, json: await r.json() }));
  return { server, port, token, local };
}

test('settings: off by default; only loopback or private addresses; Tailscale stays on 127.0.0.1', () => {
  assert.deepEqual(remoteSettings({}), { method: 'local', port: 4319, bind: '127.0.0.1', host: '', cert: '', key: '' });
  for (const bind of ['0.0.0.0', '::', '8.8.8.8', '100.128.0.1', 'example.com', '']) assert.throws(() => remoteSettings({ method: 'twingate', bind }), /private address/, bind);
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.20', '100.64.0.1', 'fd12:3456::1', '::1']) assert.equal(privateAddress(address), true, address);
  assert.throws(() => remoteSettings({ method: 'tailscale', bind: '192.168.1.20' }), /127\.0\.0\.1/);
  for (const bind of ['::1', 'fd12:3456::1']) assert.throws(() => remoteSettings({ method: 'twingate', bind }), /IPv4/, bind);
  assert.throws(() => remoteSettings({ method: 'twingate', port: 4318 }, { localPort: 4318 }), /does not use/);
  assert.throws(() => remoteSettings({ method: 'twingate', port: 80 }), /1024/);
  assert.throws(() => remoteSettings({ method: 'twingate', host: 'https://x.example' }), /without http/);
  assert.throws(() => remoteSettings({ method: 'twingate', cert: '/tmp/cert.pem' }), /both/);
  assert.throws(() => remoteSettings({ method: 'tailscale', cert: '/a', key: '/b' }), /Tailscale Serve provides HTTPS/);
});

test('the local app refuses proxied requests, and remote access is off until it is turned on', async t => {
  const { port, local } = await app(t);
  const { json } = await local('/api/remote');
  assert.deepEqual([json.remote.method, json.remote.listening, json.remote.sessions], ['local', false, []]);
  for (const header of ['X-Forwarded-For', 'X-Forwarded-Host', 'X-Forwarded-Proto', 'X-Real-IP', 'Forwarded', 'Via', 'Tailscale-User-Login', 'Tailscale-Funnel-Request']) {
    const refused = await request(port, '/api/session', { headers: { [header]: 'x' } });
    assert.deepEqual([refused.status, refused.json?.code], [403, 'PROXY_REFUSED'], header);
  }
  assert.equal((await request(port, '/api/session', { host: 'mac.tail1234.ts.net' })).status, 403, 'another host name is refused as before');
  assert.equal((await local('/api/remote/pairing', 'POST', {})).json.code, 'REMOTE_OFF');
});

test('a paired device reaches the app through the remote listener; everything else is refused', async t => {
  const { server, local } = await app(t);
  const remotePort = await freePort();
  const on = await local('/api/remote/settings', 'POST', { method: 'twingate', port: remotePort, bind: '127.0.0.1', host: 'promptboard.internal' });
  assert.equal(on.json.remote.listening, true, JSON.stringify(on.json));
  assert.match(on.json.remote.url, new RegExp(`^http://promptboard\\.internal:${remotePort}$`));
  assert.ok(on.json.remote.warnings.some(line => /also reaches Promptboard’s local port .* without pairing/.test(line)) && on.json.remote.warnings.some(line => /unencrypted/.test(line)));
  const host = `promptboard.internal:${remotePort}`, remote = (path, options = {}) => request(remotePort, path, { host, ...options });
  // Without pairing: the page goes to the pairing screen, the API answers 401, nothing else is served.
  assert.deepEqual([(await remote('/')).status, (await remote('/')).headers.location], [302, '/remote']);
  assert.equal((await remote('/api/board')).status, 401);
  assert.match((await remote('/remote')).body, /Pair this device/);
  assert.equal((await remote('/', { host: 'evil.example' })).status, 403, 'only the configured name');
  assert.equal((await remote('/', { headers: { 'Tailscale-Funnel-Request': '1' } })).status, 403, 'never from the public internet');
  // Pairing: a one-time code from the computer. Wrong codes are counted and limited.
  const { pairing } = (await local('/api/remote/pairing', 'POST', {})).json;
  assert.match(pairing.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal((await remote('/api/remote/pair', { method: 'POST', body: { code: 'AAAA-AAAA' } })).status, 401);
  const paired = await remote('/api/remote/pair', { method: 'POST', body: { code: pairing.code.toLowerCase(), name: 'iPhone' } });
  assert.equal(paired.status, 200, paired.body);
  const cookie = paired.headers['set-cookie'][0];
  assert.match(cookie, /^pb_remote=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000$/, 'no Secure flag over plain HTTP');
  assert.equal((await remote('/api/remote/pair', { method: 'POST', body: { code: pairing.code } })).status, 401, 'one code pairs one device');
  const jar = { Cookie: cookie.split(';')[0] };
  // Paired: the same app, behind the same session token and checks.
  const session = (await remote('/api/session', { headers: jar })).json;
  assert.deepEqual([typeof session.token, session.remote], ['string', { name: 'iPhone' }]);
  assert.equal((await remote('/api/board', { headers: jar })).status, 403, 'the session token is still required');
  assert.equal((await remote('/api/board', { headers: { ...jar, 'X-STE-Token': session.token } })).status, 200);
  assert.equal((await remote('/', { headers: jar })).status, 200);
  assert.equal((await remote('/api/board', { headers: { ...jar, 'X-STE-Token': session.token, Origin: 'https://evil.example' } })).status, 403, 'cross-origin');
  assert.equal((await remote('/api/board', { headers: { ...jar, 'X-STE-Token': session.token, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  // What stays on the computer: remote access itself, CLI and GitHub sign-in, native dialogs, starting local programs.
  const authed = { ...jar, 'X-STE-Token': session.token };
  for (const [path, method] of [['/api/remote', 'GET'], ['/api/remote/settings', 'POST'], ['/api/remote/pairing', 'POST'], ['/api/auth/login', 'POST'], ['/api/github/login', 'POST'], ['/api/folder/choose', 'POST'], ['/api/projects/p1/open', 'POST'], ['/api/editors', 'GET'], ['/api/editors', 'PUT'], ['/api/base/mcp/import/preview', 'POST'], ['/api/base/markdown/scan', 'POST']]) {
    const refused = await remote(path, { method, headers: authed, ...(method === 'POST' ? { body: {} } : {}) });
    assert.deepEqual([refused.status, refused.json?.code], [403, 'REMOTE_LOCAL_ONLY'], path);
  }
  // The file keeps only a hash of the device secret.
  const stored = await readFile(join(server.board.dataDir, 'remote-access.json'), 'utf8');
  assert.equal(stored.includes(cookie.split(';')[0].split('=')[1]), false);
  // Revoked on the computer: the device is out at once, and an open stream ends.
  const { json: listed } = await local('/api/remote');
  assert.equal(listed.remote.sessions.length, 1);
  assert.equal(listed.remote.sessions[0].name, 'iPhone');
  await local(`/api/remote/sessions/${listed.remote.sessions[0].id}`, 'DELETE');
  assert.equal((await remote('/api/board', { headers: authed })).status, 401);
  // Off again: the remote listener is gone, the local app is unchanged.
  const off = await local('/api/remote/settings', 'POST', { method: 'local' });
  assert.equal(off.json.remote.listening, false);
  await assert.rejects(request(remotePort, '/remote', { host }));
  assert.equal((await local('/api/board')).status, 200);
});

test('wrong codes are rate limited, a session survives a restart, a revoked one does not, and open streams end on revoke', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-remote-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const port = await freePort();
  let hold;
  const handle = (req, res) => { hold = res; res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); res.write('{"ping":true}\n'); };
  const make = () => new RemoteAccess({ dataDir, localPort: 1, handle }).load();
  let access = await make(); t.after(() => access.close());
  await access.configure({ method: 'twingate', port, bind: '127.0.0.1' });
  const pair = body => request(port, '/api/remote/pair', { method: 'POST', body });
  const { code } = access.newPairing();
  for (let i = 0; i < 5; i++) assert.equal((await pair({ code: 'ZZZZ-ZZZZ' })).status, 401);
  assert.equal((await pair({ code })).status, 429, 'the right code waits after five wrong ones in a minute');
  access.failures = [];
  const ok = await pair({ code: access.newPairing().code });
  const jar = { Cookie: ok.headers['set-cookie'][0].split(';')[0] };
  // Restart: the device stays paired; a pairing code does not survive.
  await access.close(); access = await make();
  assert.equal(access.server !== null, true, 'the listener starts again with the app');
  const stream = new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/runs/x/stream', headers: { Host: `127.0.0.1:${port}`, ...jar } }, res => { res.on('data', () => {}); res.on('close', () => resolve('closed')); });
    req.on('error', () => resolve('closed')); req.end();
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(hold, 'the paired device reached the app');
  await access.revoke('all');
  assert.equal(await Promise.race([stream, new Promise(resolve => setTimeout(() => resolve('still open'), 2000))]), 'closed');
  assert.equal((await request(port, '/api/board', { headers: jar })).status, 401);
});

test('Tailscale: the URL is the one Tailscale reports; Serve changes need a yes; another service on 443 moves Promptboard to 8443; Funnel is flagged', async t => {
  const calls = [];
  let serve = {};
  const cli = { run: async args => { calls.push(args); if (args[0] === 'status') return JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mac.tail1234.ts.net.', Online: true } }); if (args.join(' ') === 'serve status --json') return JSON.stringify(serve); return ''; } };
  let state = await tailscaleState(4319, cli);
  assert.deepEqual([state.running, state.name, state.serving, state.httpsPort, state.command], [true, 'mac.tail1234.ts.net', undefined, 443, 'tailscale serve --bg --https=443 http://127.0.0.1:4319']);
  serve = { Web: { 'mac.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } };
  assert.equal((await tailscaleState(4319, cli)).httpsPort, 8443, 'an existing service keeps 443');
  serve.Web['mac.tail1234.ts.net:8443'] = { Handlers: { '/': { Proxy: 'http://127.0.0.1:5000' } } };
  assert.match((await tailscaleState(4319, cli)).message, /443 and 8443 for other services/, 'both taken: nothing is changed');
  serve = { Web: { 'mac.tail1234.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4319' } } } }, AllowFunnel: { 'mac.tail1234.ts.net:8443': true } };
  state = await tailscaleState(4319, cli);
  assert.deepEqual([state.serving, state.url, state.funnel], [true, 'https://mac.tail1234.ts.net:8443', true]);
  assert.ok(!calls.some(args => args.includes('funnel')), 'Funnel is never changed');
  // Through the app: off by default, a Serve change needs confirm, and the remote listener only accepts the tailnet name.
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-remote-ts-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const port = await freePort();
  serve = {};
  const access = await new RemoteAccess({ dataDir, localPort: 1, handle: (req, res) => { res.writeHead(200); res.end('app'); }, cli }).load(); t.after(() => access.close());
  const status = await access.configure({ method: 'tailscale', port });
  assert.deepEqual([status.url, status.tailscale.serving], ['', undefined], 'no URL until Serve forwards to Promptboard');
  calls.length = 0;
  await access.setServe(true);
  assert.deepEqual(calls.find(args => args[0] === 'serve' && args[1] === '--bg'), ['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`]);
  const { code } = access.newPairing();
  const pairing = await request(port, '/api/remote/pair', { method: 'POST', host: 'mac.tail1234.ts.net', body: { code } });
  assert.equal(pairing.status, 200);
  assert.match(pairing.headers['set-cookie'][0], /; Secure$/, 'Secure behind Tailscale HTTPS');
  assert.equal((await request(port, '/', { host: 'other.tail1234.ts.net', headers: { Cookie: pairing.headers['set-cookie'][0].split(';')[0] } })).status, 403);
  assert.equal((await request(port, '/', { host: 'mac.tail1234.ts.net', headers: { Cookie: pairing.headers['set-cookie'][0].split(';')[0], 'Tailscale-User-Login': 'someone@example.com' } })).body, 'app', 'identity headers are neither needed nor trusted: the paired session decides');
});

test('a Research run started from a paired phone keeps going when the phone disconnects, and its answer is saved', async t => {
  let release; const answered = new Promise(resolve => { release = resolve; });
  // Like the real CLI: a stopped run is killed and answers nothing.
  const researchRunner = call => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { release('answered'); resolve({ text: 'Use PostgreSQL.', session: call.session?.id || 'thread-1' }); }, 600);
    call.signal?.addEventListener('abort', () => { clearTimeout(timer); release('stopped'); reject(Object.assign(new Error('Research was stopped.'), { code: 'ABORTED' })); }, { once: true });
  });
  const { local } = await app(t, { researchRunner });
  const remotePort = await freePort();
  await local('/api/remote/settings', 'POST', { method: 'twingate', port: remotePort, bind: '127.0.0.1' });
  const { pairing } = (await local('/api/remote/pairing', 'POST', {})).json;
  const paired = await request(remotePort, '/api/remote/pair', { method: 'POST', body: { code: pairing.code } });
  const cookie = paired.headers['set-cookie'][0].split(';')[0];
  const token = (await request(remotePort, '/api/session', { headers: { Cookie: cookie } })).json.token;
  const project = (await local('/api/origin/projects', 'POST', { name: 'Shop' })).json.project;
  const chat = (await local(`/api/origin/research/${project.id}/chats`, 'POST', { settings: { provider: 'claude' } })).json.chat.id;
  // The phone asks, then its connection drops (Safari closed, phone locked).
  const req = http.request({ host: '127.0.0.1', port: remotePort, method: 'POST', path: `/api/origin/research/${project.id}/chats/${chat}/run`,
    headers: { Host: `127.0.0.1:${remotePort}`, Cookie: cookie, 'X-STE-Token': token, 'Content-Type': 'application/json' } }, res => res.on('data', () => {}));
  req.on('error', () => {});
  req.end(JSON.stringify({ text: 'Which database?', settings: { provider: 'claude' } }));
  await new Promise(resolve => setTimeout(resolve, 200));
  req.destroy();
  assert.equal(await answered, 'answered', 'the run was not stopped by the disconnect');
  for (const end = Date.now() + 5000; ;) {
    const messages = (await local(`/api/origin/research/${project.id}/chats/${chat}`)).json.chat.messages;
    if (messages.some(message => message.role === 'assistant' && /PostgreSQL/.test(message.text))) break;
    if (Date.now() > end) assert.fail(`The answer was not saved: ${JSON.stringify(messages)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
});

test('overlapping saves end in the last setting, a busy port is retried on Save, and shutdown leaves no listener', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-remote-race-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const port = await freePort();
  const access = await new RemoteAccess({ dataDir, localPort: 1, handle: (req, res) => { res.writeHead(200); res.end(); } }).load(); t.after(() => access.close());
  await Promise.all([access.configure({ method: 'twingate', port, bind: '127.0.0.1' }), access.configure({ method: 'local' })]);
  assert.deepEqual([access.settings.method, Boolean(access.server)], ['local', false]);
  await assert.rejects(request(port, '/remote'), 'nothing answers after it was turned off');
  // A port that is busy: the listener reports it, and the same Save works once the port is free.
  const busy = http.createServer().listen(port, '127.0.0.1'); await new Promise(resolve => busy.once('listening', resolve));
  let status = await access.configure({ method: 'twingate', port, bind: '127.0.0.1' });
  assert.deepEqual([status.listening, /already in use/.test(status.error)], [false, true]);
  await new Promise(resolve => busy.close(resolve));
  status = await access.configure({ method: 'twingate', port, bind: '127.0.0.1' });
  assert.equal(status.listening, true);
  // Shutdown while a change is on its way: no listener is left behind.
  const change = access.configure({ method: 'twingate', port: await freePort(), bind: '127.0.0.1' });
  await access.shutdown(); await change.catch(() => {});
  assert.equal(access.server, null);
});

test('Tailscale off uses the port Promptboard is served on; a shared host name is flagged', async t => {
  const calls = [];
  let serve = { Web: { 'mac.tail1234.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4319' } } } } };
  const cli = { run: async args => { calls.push(args); if (args[0] === 'status') return JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mac.tail1234.ts.net.' } }); if (args.join(' ') === 'serve status --json') return JSON.stringify(serve); return ''; } };
  const state = await tailscaleState(4319, cli);
  assert.deepEqual([state.servePort, state.httpsPort, state.offCommand, Boolean(state.shared)], [8443, 443, 'tailscale serve --bg --https=8443 http://127.0.0.1:4319 off', false]);
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-remote-off-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const access = await new RemoteAccess({ dataDir, localPort: 1, handle: () => {}, cli }).load(); t.after(() => access.close());
  access.settings = { ...access.settings, method: 'tailscale', port: 4319 };
  calls.length = 0;
  await access.setServe(false);
  assert.deepEqual(calls.find(args => args.includes('off')), ['serve', '--bg', '--https=8443', 'http://127.0.0.1:4319', 'off']);
  serve = { Web: { ...serve.Web, 'mac.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } };
  assert.equal((await tailscaleState(4319, cli)).shared, true);
  access.tailscale = null;
  assert.ok((await access.status()).warnings.some(line => /sign-in to it as well/.test(line)));
});

test('every route from a paired phone: the local-only ones are refused, every other one reaches the app', async t => {
  const { local } = await app(t);
  const remotePort = await freePort();
  await local('/api/remote/settings', 'POST', { method: 'twingate', port: remotePort, bind: '127.0.0.1' });
  const { pairing } = (await local('/api/remote/pairing', 'POST', {})).json;
  const jar = { Cookie: (await request(remotePort, '/api/remote/pair', { method: 'POST', body: { code: pairing.code } })).headers['set-cookie'][0].split(';')[0] };
  const token = (await request(remotePort, '/api/session', { headers: jar })).json.token;
  const id = '00000000-0000-4000-8000-000000000000';
  const LOCAL_ONLY = ['GET /api/remote', 'GET /api/remote?refresh=1', 'POST /api/remote/settings', 'POST /api/remote/pairing', 'POST /api/remote/serve', 'DELETE /api/remote/sessions/all', `DELETE /api/remote/sessions/${id}`,
    'GET /api/editors', 'PUT /api/editors', 'POST /api/auth/login', 'POST /api/auth/cancel', 'POST /api/auth/logout', 'POST /api/github/login', 'POST /api/github/login/cancel', 'POST /api/folder/choose', 'POST /api/projects/p1/open', 'POST /api/tasks/t1/preview', 'DELETE /api/tasks/t1/preview',
    'POST /api/base/mcp/import/preview', 'POST /api/base/mcp/import', 'POST /api/base/markdown/scan', 'POST /api/base/markdown/import', 'PUT /api/sandbox/claude-token', 'DELETE /api/sandbox/claude-token'];
  const each = (prefix, rows) => rows.map(row => { const [method, action = ''] = row.split(' '); return `${method} ${prefix}${action ? `/${action}` : ''}`; });
  const ALLOWED = ['GET /', 'GET /app.js', 'GET /api/session', 'GET /api/providers', 'GET /api/status', 'GET /api/models', 'GET /api/usage', 'GET /api/auth', 'POST /api/notifications/connect', 'POST /api/notifications/ack',
    'POST /api/compose/cancel', 'GET /api/compose/batches', 'POST /api/compose/prepare', 'POST /api/compose/sources/document', 'DELETE /api/compose/sources/document/d1', 'POST /api/compose/mcp/test', 'POST /api/split', 'POST /api/generate',
    'GET /api/coordinator/p1', 'POST /api/coordinator/p1/ask', 'GET /api/sandbox', 'GET /api/sandbox/build', 'POST /api/sandbox/build', 'POST /api/sandbox/build/cancel', 'PUT /api/sandbox/settings', 'GET /api/shared-projects', 'GET /api/origin/projects', 'GET /api/origin/blueprints', 'GET /api/origin/projects/p1/document', 'GET /api/origin/research/p1/chats', `POST /api/origin/research/p1/chats/${id}/run`,
    'GET /api/board', 'GET /api/board/export', 'POST /api/board/migrate', 'POST /api/board/import', 'POST /api/projects', 'POST /api/repository/validate', 'POST /api/tasks', 'PATCH /api/settings',
    'GET /api/github/status', 'GET /api/github/login', 'GET /api/github/repos', 'PATCH /api/projects/p1/timeline/n1', 'DELETE /api/projects/p1/timeline/n1', 'POST /api/projects/p1/file-proposal',
    'GET /api/projects/p1/lessons', 'PATCH /api/projects/p1/lessons/settings', 'POST /api/projects/p1/lessons/approve', 'PATCH /api/projects/p1/lessons/l1', 'POST /api/tasks/t1/lessons',
    'GET /api/projects/p1/schedules', 'POST /api/projects/p1/schedules', 'PATCH /api/projects/p1/schedules/s1', 'DELETE /api/projects/p1/schedules/s1', 'POST /api/projects/p1/schedules/s1/run',
    ...each('/api/projects/p1', ['PUT file', 'GET files', 'GET file', 'POST files', 'GET git-status', 'PATCH', 'PATCH labels', 'DELETE', 'POST repository', 'POST init-repository', 'GET branches', 'PATCH autopilot', 'POST autopilot', 'PATCH columns', 'PATCH pipeline', 'PATCH execution', 'POST full-autopilot',
      'GET repository-pipeline', 'GET repository-pipeline-status', 'POST repository-pipeline', 'PATCH workflow', 'PATCH tests', 'PATCH preview', 'POST target-branch', 'GET timeline', 'GET insights', 'POST timeline', 'POST github', 'GET github-remote', 'GET run-info', 'DELETE github', 'POST github-fetch', 'POST github-update', 'POST confirm-import']),
    ...each('/api/runs/r1', ['GET', 'GET stream', 'GET plan', 'GET last-message', 'GET output', 'POST input', 'POST resize', 'POST cancel', 'POST confirm', 'POST pause', 'GET base', 'GET base-context', 'GET base-definition']),
    ...each('/api/tasks/t1', ['PATCH', 'POST refine', 'POST pipeline-settings', 'DELETE', 'POST move', 'GET automations', 'POST cancel-automations', 'POST merge-now', 'POST start-over', 'POST restart-sessions', 'POST restore-worktree', 'POST complete-stage', 'POST reopen', 'POST duplicate',
      'POST prerequisites', 'POST runs', 'POST resume', 'DELETE worktree', 'GET preview', 'GET revision', 'GET uncommitted', 'GET merge-preview', 'POST commit', 'POST accept-review', 'POST tests', 'POST merge', 'POST update-branch', 'POST abort-merge', 'POST pull-request', 'POST pull-request-status', 'POST complete-no-changes']),
    ...each('/api/base', ['GET', 'GET presets', 'POST avatar/cancel', 'POST avatar/generate', 'POST preview', 'POST apply', 'POST restore-global', 'POST skills/import', 'POST resources', 'POST import/preview', 'POST import', 'POST export', 'POST roots', 'DELETE roots/r1',
      'POST wiki/cancel', 'POST wiki/generate', 'POST wiki/apply', 'POST source/import', 'GET markdown/templates']),
    ...each('/api/base/resources/b1', ['GET', 'GET revisions', 'GET revisions/1', 'GET avatar', 'POST override', 'POST deploy', 'PATCH', 'DELETE', 'POST test', 'POST refresh', 'GET search']),
    // Network (architecture §10.2): registry, graph, export, memory, report, job and job-settings routes create no way in and
    // change no trust (a paired device has the owner's control, so it may submit and cancel jobs).
    'GET /api/network/agents', 'POST /api/network/agents', 'GET /api/network/networks', 'POST /api/network/networks', 'GET /api/network/export', 'POST /api/network/import',
    'GET /api/network/settings', 'PATCH /api/network/settings', 'GET /api/network/jobs', 'POST /api/network/jobs',
    ...each(`/api/network/jobs/job_${'a'.repeat(20)}`, ['GET', 'DELETE', 'POST cancel', 'POST approve', 'POST retry', 'POST close']),
    ...each(`/api/network/agents/agt_${'a'.repeat(20)}`, ['GET', 'PATCH', 'GET memory', 'POST memory', 'GET memory/preview', `PATCH memory/mem_${'b'.repeat(20)}`, `DELETE memory/mem_${'b'.repeat(20)}`, `POST memory/mem_${'b'.repeat(20)}/approve`,
      'GET posts', 'POST posts', `PATCH posts/pst_${'c'.repeat(20)}`, `DELETE posts/pst_${'c'.repeat(20)}`]),
    ...each(`/api/network/networks/net_${'a'.repeat(20)}`, ['GET', 'PATCH', 'DELETE', 'POST publish', 'POST duplicate', 'GET versions/1', 'GET memory', 'POST memory', `PATCH memory/mem_${'b'.repeat(20)}`, `DELETE memory/mem_${'b'.repeat(20)}`, `POST memory/mem_${'b'.repeat(20)}/approve`])];
  // The table covers every route the server and Base declare: a new route must be added here, local-only or not.
  const paths = [...LOCAL_ONLY, ...ALLOWED].map(row => row.split(' ')[1].split('?')[0]);
  for (const file of ['server.mjs', 'base-http.mjs', 'sandbox.mjs']) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
    for (const [, literal] of source.matchAll(/'(\/api\/[^'`$]*)'/g)) assert.ok(paths.some(path => path.startsWith(literal)), `${file}: ${literal} is not in the route table`);
    const actions = [...source.matchAll(/action === '([a-z-]+)'/g)].map(match => match[1]).concat([...source.matchAll(/\[([^\]]+)\]\.includes\(action\)/g)].flatMap(match => match[1].match(/[a-z-]+/g)));
    for (const action of actions) assert.ok(paths.some(path => path.endsWith(`/${action}`)), `${file}: the ${action} action is not in the route table`);
  }
  // Network routes come from the dispatcher's own table (src/network/http.mjs): each method and path pattern has exactly
  // one row above, and each Network row above is a route of that table, so a route can be neither left out nor invented.
  const networkRows = [...LOCAL_ONLY, ...ALLOWED].map(row => row.split(' ')).filter(([, path]) => path.startsWith('/api/network'));
  for (const route of NETWORK_ROUTES) assert.equal(networkRows.filter(([method, path]) => method === route.method && route.pattern.test(path.split('?')[0])).length, 1, `${route.method} ${route.pattern}: one row in ALLOWED or LOCAL_ONLY`);
  for (const [method, path] of networkRows) assert.ok(NETWORK_ROUTES.some(route => route.method === method && route.pattern.test(path.split('?')[0])), `${method} ${path} is not a Network route`);
  // Refused with the right token too: the refusal comes before the app.
  for (const row of LOCAL_ONLY) {
    const [method, path] = row.split(' ');
    const refused = await request(remotePort, path, { method, headers: { ...jar, 'X-STE-Token': token }, ...(method === 'GET' ? {} : { body: {} }) });
    assert.deepEqual([refused.status, refused.json?.code], [403, 'REMOTE_LOCAL_ONLY'], row);
  }
  // Allowed: the request passes the remote checks and reaches the app, shown by the app's own token check, so no handler runs.
  for (const row of ALLOWED) {
    const [method, path] = row.split(' ');
    const reached = await request(remotePort, path, { method, headers: { ...jar, 'X-STE-Token': 'not-the-token' }, ...(method === 'GET' ? {} : { body: {} }) });
    if (path.startsWith('/api/') && path !== '/api/session') assert.deepEqual([reached.status, reached.json?.error], [403, 'Reload this page before you try again.'], row);
    else assert.equal(reached.status, 200, row);
  }
});

test('a damaged settings file is set aside when its backup loads, so the next save keeps the good backup', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-remote-damaged-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const path = join(dataDir, 'remote-access.json'), good = { schema: 'promptboard.remote-access', version: 1, settings: { method: 'local' }, sessions: [{ hash: 'a'.repeat(64), name: 'iPhone', createdAt: 1, expiresAt: Date.now() + 86400000 }] };
  await writeFile(`${path}.bak`, JSON.stringify(good)); await writeFile(path, '{"schema":');
  const access = await new RemoteAccess({ dataDir, localPort: 1, handle: () => {} }).load(); t.after(() => access.close());
  assert.equal((await access.status()).sessions.length, 1, 'The backup loads.');
  assert.equal((await readdir(dataDir)).filter(name => name.startsWith('remote-access.json.corrupt-')).length, 1);
  await access.revoke('all');
  assert.equal(JSON.parse(await readFile(`${path}.bak`, 'utf8')).sessions.length, 1, 'The backup is still the good copy.');
});

test('Revoke all also voids an unused code, turning off clears a listener error, expired devices leave the list, a stored wildcard address is never used, and a new port closes the old one', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-remote-state-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  let now = Date.now();
  const make = () => new RemoteAccess({ dataDir, localPort: 1, handle: (req, res) => { res.writeHead(200); res.end('app'); }, now: () => now }).load();
  let access = await make(); t.after(() => access.close());
  const first = await freePort();
  await access.configure({ method: 'twingate', port: first, bind: '127.0.0.1' });
  // A code shown before Revoke all (perhaps seen by someone else) does not pair a device afterwards.
  await access.pair(access.newPairing().code);
  const { code } = access.newPairing();
  await access.revoke('all');
  await assert.rejects(access.pair(code), { code: 'REMOTE_NO_PAIRING' });
  assert.equal((await access.status()).pairing, null);
  // An expired device leaves the list when it loses access.
  await access.pair(access.newPairing().code);
  assert.equal((await access.status()).sessions.length, 1);
  now += 31 * 86400000;
  assert.deepEqual((await access.status()).sessions, []);
  // Another port: the old listener is closed, the new one answers.
  const second = await freePort();
  assert.equal((await access.configure({ method: 'twingate', port: second, bind: '127.0.0.1' })).listening, true);
  await assert.rejects(request(first, '/remote'));
  assert.equal((await request(second, '/remote')).status, 200);
  // A busy port is reported; turning remote access off does not keep showing that error.
  const busy = http.createServer().listen(first, '127.0.0.1'); await new Promise(resolve => busy.once('listening', resolve)); t.after(() => new Promise(resolve => busy.close(resolve)));
  assert.match((await access.configure({ method: 'twingate', port: first, bind: '127.0.0.1' })).error, new RegExp(`Port ${first} is already in use`));
  assert.deepEqual([(await access.configure({ method: 'local' })).error, access.server], ['', null]);
  // A settings file edited to listen on every interface is never used: remote access stays off.
  await access.close();
  await writeFile(join(dataDir, 'remote-access.json'), JSON.stringify({ schema: 'promptboard.remote-access', version: 1, settings: { method: 'twingate', port: second, bind: '0.0.0.0', host: '', cert: '', key: '' }, sessions: [] }));
  access = await make();
  assert.deepEqual([access.settings.method, access.settings.bind, access.server], ['local', '127.0.0.1', null]);
});

test('Settings: saving another Twingate field keeps the HTTPS certificate, and a code that no longer works is not shown', async t => {
  const ctx = await setup(t);
  const { $, win } = ctx;
  const local = (path, method = 'GET', body) => fetch(`${ctx.app.url}${path}`, { method, headers: { 'X-STE-Token': win.__pbTest.token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(r => r.json());
  const port = await freePort();
  // Paths to files that do not exist: the settings are saved, the HTTPS listener reports that it cannot start.
  await local('/api/remote/settings', 'POST', { method: 'twingate', port, bind: '127.0.0.1', host: 'promptboard.internal', cert: '/missing/cert.pem', key: '/missing/key.pem' });
  $('#app-settings-open').click(); await ctx.idle();
  await until(() => $('#set-remote-cert'), 'Twingate fields');
  assert.deepEqual([$('#set-remote-cert').value, $('#set-remote-key').value], ['/missing/cert.pem', '/missing/key.pem']);
  const type = (id, value) => { $(id).value = value; $(id).dispatchEvent(new win.Event('input')); };
  const click = label => [...$('#set-remote-group').querySelectorAll('button')].find(button => button.textContent === label).click();
  type('#set-remote-host', 'pb.internal'); click('Save'); await ctx.idle({ requireComplete: true });
  const { remote } = await local('/api/remote');
  assert.deepEqual([remote.host, remote.cert, remote.key], ['pb.internal', '/missing/cert.pem', '/missing/key.pem'], 'HTTPS is kept');
  // Cleared on purpose: plain HTTP, and the listener starts.
  type('#set-remote-cert', ''); type('#set-remote-key', ''); click('Save'); await ctx.idle({ requireComplete: true });
  await until(() => /listening on 127\.0\.0\.1/.test($('#set-remote-group').textContent), 'listening');
  const { pairing } = await local('/api/remote/pairing', 'POST', {});
  assert.equal((await request(port, '/api/remote/pair', { method: 'POST', body: { code: pairing.code } })).status, 200);
  // A code on screen, then Revoke all: the code no longer pairs, so it is not shown any more.
  click('Pair a device'); await ctx.idle({ requireComplete: true });
  await until(() => $('#set-remote-code'), 'code shown');
  click('Revoke all devices'); await ctx.idle({ requireComplete: true });
  await until(() => !$('#set-remote-group .remote-sessions'), 'devices revoked');
  assert.equal($('#set-remote-code'), null);
});

test('a server error on the live remote listener is shown in Settings and stops nothing: the app keeps running', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-remote-error-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const port = await freePort();
  await writeFile(join(dataDir, 'remote-access.json'), JSON.stringify({ schema: 'promptboard.remote-access', version: 1, settings: { method: 'twingate', port, bind: '127.0.0.1', host: '', cert: '', key: '' }, sessions: [] }));
  // Its own process, so an unhandled 'error' would end it the way it ends the real app (with every running agent).
  const script = `
    const { RemoteAccess } = await import(${JSON.stringify(new URL('../src/remote-access.mjs', import.meta.url).href)});
    let access; const listen = RemoteAccess.prototype.listen; RemoteAccess.prototype.listen = function () { access = this; return listen.call(this); };
    const { startServer } = await import(${JSON.stringify(new URL('../src/server.mjs', import.meta.url).href)});
    const app = await startServer({ port: 0, dataDir: ${JSON.stringify(dataDir)}, projectsDir: ${JSON.stringify(join(dataDir, 'projects'))}, executor: null });
    setImmediate(() => access.server.emit('error', Object.assign(new Error('accept failed'), { code: 'EMFILE' })));
    await new Promise(resolve => setTimeout(resolve, 200));
    const token = (await (await fetch(app.url + '/api/session')).json()).token;
    const { remote } = await (await fetch(app.url + '/api/remote', { headers: { 'X-STE-Token': token } })).json();
    const page = await fetch('http://127.0.0.1:${port}/remote');
    console.log(JSON.stringify({ error: remote.error, listening: remote.listening, page: page.status }));
    await app.close(); process.exit(0);`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: 60000 });
  assert.deepEqual(JSON.parse(stdout.trim().split('\n').at(-1)), { error: 'The remote listener reported an error (EMFILE). If the phone cannot connect, turn remote access off and on again.', listening: true, page: 200 });
});

test('requests that arrive together share one Tailscale status lookup; a refresh reads again', async t => {
  let calls = 0;
  const cli = { run: async args => { if (args[0] !== 'status') return '{}'; calls++; await new Promise(resolve => setTimeout(resolve, 50)); return JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mac.tail1234.ts.net.' } }); } };
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-remote-lookup-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const access = await new RemoteAccess({ dataDir, localPort: 1, handle: () => {}, cli }).load(); t.after(() => access.close());
  access.settings = { ...access.settings, method: 'tailscale', port: 4319 };
  const states = await Promise.all([access.status(), access.status(), access.status()]);
  assert.deepEqual([calls, states.map(state => state.tailscale.name)], [1, ['mac.tail1234.ts.net', 'mac.tail1234.ts.net', 'mac.tail1234.ts.net']]);
  await access.status({ refresh: true });
  assert.equal(calls, 2);
});

test('Tailscale Serve not enabled for the tailnet: the refusal carries Tailscale’s own link and nothing is changed', async t => {
  const cli = { run: async args => {
    if (args[0] === 'status') return JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mac.tail1234.ts.net.' }, CertDomains: [] });
    if (args.join(' ') === 'serve status --json') return '{}';
    // As the real CLI does: it prints the link and waits until Serve is enabled (here: it is stopped by the timeout).
    throw Object.assign(new Error('timed out'), { stdout: 'Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc123\n', stderr: '' });
  } };
  assert.equal((await tailscaleState(4319, cli)).https, false);
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-remote-enable-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const access = await new RemoteAccess({ dataDir, localPort: 1, handle: () => {}, cli }).load(); t.after(() => access.close());
  access.settings = { ...access.settings, method: 'tailscale', port: 4319 };
  await assert.rejects(access.setServe(true), error => error.code === 'REMOTE_TAILSCALE_NOT_ENABLED' && error.link === 'https://login.tailscale.com/f/serve?node=abc123');
});

test('a change that cannot be saved is undone and reported plainly: pairing, revoking and settings match what a restart loads', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-remote-unsaved-'));
  t.after(async () => { await chmod(dataDir, 0o700); await rm(dataDir, { recursive: true, force: true }); });
  const port = await freePort();
  const make = () => new RemoteAccess({ dataDir, localPort: 1, handle: (req, res) => { res.writeHead(200); res.end(); } }).load();
  const access = await make(); t.after(() => access.close());
  await access.configure({ method: 'twingate', port, bind: '127.0.0.1' });
  const paired = await request(port, '/api/remote/pair', { method: 'POST', body: { code: access.newPairing().code } });
  assert.equal(paired.status, 200);
  const jar = { Cookie: paired.headers['set-cookie'][0].split(';')[0] };
  await chmod(dataDir, 0o500); // The data folder can no longer be written (full disk, permissions, a sync tool).
  // A phone pairing now gets a plain answer, never a local path or an errno, and no session that nobody holds.
  const { code } = access.newPairing();
  const refused = await request(port, '/api/remote/pair', { method: 'POST', body: { code } });
  assert.deepEqual([refused.status, refused.json.code], [500, 'REMOTE_SAVE_FAILED']);
  assert.match(refused.json.error, /could not be saved\. Check free disk space and folder permissions/);
  assert.ok(!refused.body.includes(dataDir) && !/EACCES|EPERM/.test(refused.body), refused.body);
  assert.equal(access.sessions.length, 1);
  assert.equal((await access.status()).pairing !== null, true, 'the code was not used up: the phone can try it again');
  // A revoke that is not saved leaves the device paired, here and after a restart.
  await assert.rejects(access.revoke('all'), { code: 'REMOTE_SAVE_FAILED' });
  assert.equal((await access.status()).sessions.length, 1);
  assert.equal((await request(port, '/', { headers: jar })).status, 200, 'the device still works, as Settings shows');
  // Settings that are not saved are not used: the listener stays as it was.
  await assert.rejects(access.configure({ method: 'local' }), { code: 'REMOTE_SAVE_FAILED' });
  assert.deepEqual([access.settings.method, Boolean(access.server)], ['twingate', true]);
  await chmod(dataDir, 0o700);
  const restarted = await make(); t.after(() => restarted.close());
  assert.deepEqual([restarted.settings.method, restarted.sessions.length], ['twingate', 1]);
});

test('Tailscale Serve on another HTTPS port (443 and 8443 are taken): the address Settings shows is let through to pairing', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-remote-ts-port-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const port = await freePort();
  // As Settings tells the user to do then: tailscale serve --bg --https=10000 http://127.0.0.1:<port>
  const serve = { Web: { 'mac.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } }, 'mac.tail1234.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3001' } } },
    'mac.tail1234.ts.net:10000': { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } } };
  const cli = { run: async args => JSON.stringify(args[0] === 'status' ? { BackendState: 'Running', Self: { DNSName: 'mac.tail1234.ts.net.', Online: true }, CertDomains: ['mac.tail1234.ts.net'] } : serve) };
  const access = await new RemoteAccess({ dataDir, localPort: 1, handle: (req, res) => { res.writeHead(200); res.end('app'); }, cli }).load(); t.after(() => access.close());
  assert.equal((await access.configure({ method: 'tailscale', port })).url, 'https://mac.tail1234.ts.net:10000');
  // Tailscale Serve keeps the browser's Host header, port included.
  const opened = await request(port, '/', { host: 'mac.tail1234.ts.net:10000' });
  assert.deepEqual([opened.status, opened.headers.location], [302, '/remote'], opened.body);
  assert.equal((await request(port, '/', { host: 'mac.tail1234.ts.net:10001' })).status, 403, 'another port of that name is still refused');
});
