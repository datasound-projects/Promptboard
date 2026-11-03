import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, stat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpConnections, mcpOAuthFetch } from '../src/base-mcp-auth.mjs';

const server = (id, configuration = {}) => ({ id, kind: 'mcp', revision: 1, trust: 'trusted', configuration: { transport: 'streamable-http', endpoint: 'https://example.com/mcp', auth: { mode: 'environment' }, headers: { Authorization: 'SHARED_KEY' }, ...configuration } });
async function world(t, definitions, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-base-auth-')), resources = new Map(definitions.map(d => [d.id, d]));
  const manager = new McpConnections({ dataDir, readResource: async id => { const d = resources.get(id); if (!d) throw new Error('Not found'); return structuredClone(d); }, ...options });
  t.after(async () => { manager.close(); await rm(dataDir, { recursive: true, force: true }); }); return { manager, resources, dataDir };
}
async function listen(t, handler) { const http = createServer(handler); await new Promise(resolve => http.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { http.closeAllConnections(); http.close(resolve); })); return `http://127.0.0.1:${http.address().port}`; }
const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };

test('private credentials are restricted to declared references, owner-only, endpoint-bound, and isolated between connections', async t => {
  const a = server('one'), b = server('two'), { manager, resources } = await world(t, [a, b]);
  await assert.rejects(manager.credentials('one', { UNKNOWN: 'SECRET' }, 1), { code: 'BASE_INVALID_INPUT' });
  await assert.rejects(manager.credentials('one', { SHARED_KEY: 'SECRET\r\nInjected: yes' }, 1), { code: 'BASE_INVALID_INPUT' });
  await assert.rejects(manager.credentials('one', { SHARED_KEY: 'SECRET' }, 2), { code: 'RESOURCE_REVISION_CONFLICT' });
  await manager.credentials('one', { SHARED_KEY: 'Bearer FIRST_SECRET' }, 1); await manager.credentials('two', { SHARED_KEY: 'Bearer SECOND_SECRET' }, 1);
  const permissions = (await stat(manager.path('one'))).mode & 0o777;
  // Windows exposes only the writable bit through chmod/stat, not POSIX owner/group ACLs.
  if (process.platform === 'win32') assert.ok(permissions & 0o200);
  else assert.equal(permissions, 0o600);
  const status = await manager.status('one'); assert.deepEqual(status.references, [{ name: 'SHARED_KEY', ready: true }]); assert.doesNotMatch(JSON.stringify(status), /FIRST_SECRET/);
  const da = await manager.delivery(a), db = await manager.delivery(b), ra = da.definition.configuration.headers.Authorization, rb = db.definition.configuration.headers.Authorization;
  assert.notEqual(ra, rb); assert.equal(da.environment[ra], 'Bearer FIRST_SECRET'); assert.equal(db.environment[rb], 'Bearer SECOND_SECRET');
  assert.equal(a.configuration.headers.Authorization, 'SHARED_KEY', 'The portable definition stays unchanged.');
  resources.get('one').configuration.endpoint = 'https://different.example/mcp'; assert.equal((await manager.status('one')).references[0].ready, false);
  await manager.disconnect('two'); assert.equal((await manager.status('two')).references[0].ready, false);
  await assert.rejects(manager.disconnect('../outside'), { code: 'BASE_INVALID_INPUT' });
});

test('private vault refuses symlinks and malformed files without revealing credential contents', async t => {
  const d = server('one'), { manager, dataDir } = await world(t, [d]);
  await manager.credentials('one', { SHARED_KEY: 'SECRET' }, 1);
  await writeFile(manager.path('one'), 'BROKEN SECRET CONTENT');
  await assert.rejects(manager.status('one'), e => e.code === 'BASE_AUTH_STORAGE' && !e.message.includes('SECRET'));
  await manager.disconnect('one'); const outsideDir = join(dataDir, 'outside-dir'); await mkdir(outsideDir); const outside = join(outsideDir, 'outside'); await writeFile(outside, 'outside');
  // A Windows directory junction needs no developer-mode/file-symlink privilege.
  await symlink(process.platform === 'win32' ? outsideDir : outside, manager.path('one'), process.platform === 'win32' ? 'junction' : 'file');
  await assert.rejects(manager.status('one'), { code: 'BASE_AUTH_STORAGE' }); await manager.disconnect('one'); assert.equal(await readFile(outside, 'utf8'), 'outside');
});

test('OAuth fetch pins DNS, refuses redirects/private discovery and bounds responses', async t => {
  const endpoint = await listen(t, (req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/other' }); res.end(); }
    else if (req.url === '/large') { res.end('x'.repeat(256001)); }
    else json(res, 200, { ok: true });
  });
  const request = mcpOAuthFetch(endpoint);
  assert.deepEqual(await (await request(`${endpoint}/ok`)).json(), { ok: true });
  await assert.rejects(request(`${endpoint}/redirect`), /redirect/);
  await assert.rejects(request(`${endpoint}/large`), /too large/);
  await assert.rejects(mcpOAuthFetch(endpoint, { lookupFn: async () => [{ address: '127.0.0.1', family: 4 }] })('https://identity.example/discovery'), { code: 'BASE_AUTH_ADDRESS' });
  await assert.rejects(request('http://identity.example/discovery'), { code: 'BASE_AUTH_ADDRESS' });
  await assert.rejects(request('https://user:password@identity.example/'), { code: 'BASE_AUTH_ADDRESS' });
  const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(request(`${endpoint}/ok`, { signal: cancelled.signal }), { name: 'AbortError' });
});

async function oauth(t, { staticClient = false, delayToken = null } = {}) {
  let endpoint, authorization, tokenRequests = 0, registration = 0;
  endpoint = await listen(t, async (req, res) => {
    if (req.url.startsWith('/.well-known/oauth-protected-resource')) return json(res, 200, { resource: `${endpoint}/mcp`, authorization_servers: [endpoint] });
    if (req.url.startsWith('/.well-known/oauth-authorization-server')) return json(res, 200, { issuer: endpoint, authorization_endpoint: `${endpoint}/authorize`, token_endpoint: `${endpoint}/token`, ...(staticClient ? {} : { registration_endpoint: `${endpoint}/register` }), response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
    if (req.url === '/register') { registration++; let body = ''; for await (const chunk of req) body += chunk; return json(res, 201, { ...JSON.parse(body), client_id: 'promptboard-test-client' }); }
    if (req.url === '/token') {
      tokenRequests++; let body = ''; for await (const chunk of req) body += chunk; const params = new URLSearchParams(body);
      if (params.get('grant_type') === 'authorization_code') {
        assert.equal(params.get('code'), 'test-code'); assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge')); assert.equal(params.get('redirect_uri'), authorization.searchParams.get('redirect_uri'));
        if (delayToken) await delayToken();
      } else assert.equal(params.get('refresh_token'), 'PRIVATE_REFRESH');
      return json(res, 200, { access_token: 'PRIVATE_ACCESS', token_type: 'Bearer', expires_in: 3600, refresh_token: 'PRIVATE_REFRESH' });
    }
    json(res, 404, {});
  });
  const definition = server('oauth', { endpoint: `${endpoint}/mcp`, headers: {}, auth: { mode: 'oauth', ...(staticClient ? { clientId: 'static-client' } : {}) } });
  const w = await world(t, [definition]);
  const start = async () => { const result = await w.manager.start('oauth', 1); authorization = new URL(result.url); return result; };
  const callback = (result, changes = {}) => { const url = new URL(result.redirectUrl); url.searchParams.set('state', changes.state ?? authorization.searchParams.get('state')); url.searchParams.set('code', 'test-code'); if (changes.iss) url.searchParams.set('iss', changes.iss); return fetch(url); };
  return { ...w, definition, start, callback, get authorization() { return authorization; }, get tokenRequests() { return tokenRequests; }, get registration() { return registration; } };
}

test('OAuth uses PKCE and state, stores tokens privately and refreshes without changing definitions', async t => {
  const w = await oauth(t), result = await w.start();
  assert.equal(w.authorization.searchParams.get('code_challenge_method'), 'S256'); assert.equal((await w.manager.status('oauth')).pending, true);
  assert.equal((await w.callback(result, { state: 'wrong' })).status, 400); assert.equal(w.tokenRequests, 0);
  assert.equal((await w.callback(result)).status, 200); assert.equal(w.tokenRequests, 1); assert.equal(w.registration, 1);
  assert.equal((await w.manager.status('oauth')).signedIn, true); assert.doesNotMatch(JSON.stringify(await w.manager.status('oauth')), /PRIVATE_ACCESS|PRIVATE_REFRESH/);
  const delivery = await w.manager.delivery(w.definition); assert.ok(Object.values(delivery.environment).includes('Bearer PRIVATE_ACCESS')); assert.deepEqual(w.definition.configuration.headers, {});
  const record = await w.manager.read(w.definition); record.expiresAt = Date.now() - 1; await w.manager.save(w.definition, record); await Promise.all([w.manager.delivery(w.definition), w.manager.delivery(w.definition)]); assert.equal(w.tokenRequests, 2, 'Concurrent runs share one refresh.');
  const again = await w.start(); assert.ok(again.url, 'Explicit sign-in opens a fresh authorization rather than reusing the previous account.'); assert.equal(w.registration, 2, 'Dynamic registration binds the new loopback callback.'); assert.equal((await w.callback(again)).status, 200);
  await w.manager.disconnect('oauth'); assert.equal((await w.manager.status('oauth')).signedIn, false); await assert.rejects(w.manager.delivery(w.definition), { code: 'BASE_AUTH_REQUIRED' });
});

test('OAuth supports a provider client ID, rejects an issuer switch, and stops cancelled callbacks from reviving a connection', async t => {
  const w = await oauth(t, { staticClient: true }), result = await w.start(); assert.equal(w.registration, 0); assert.equal(w.authorization.searchParams.get('client_id'), 'static-client');
  assert.equal((await w.callback(result, { iss: 'https://different.example' })).status, 400); assert.equal(w.tokenRequests, 0); assert.equal((await w.manager.status('oauth')).signedIn, false);
  let release, entered; const ready = new Promise(resolve => { entered = resolve; }), delayed = await oauth(t, { delayToken: () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  const next = await delayed.start(), pending = delayed.callback(next); await ready; await delayed.manager.disconnect('oauth'); release(); await pending.catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal((await delayed.manager.status('oauth')).signedIn, false); await assert.rejects(accessFile(delayed.manager.path('oauth')));
});
async function accessFile(path) { await stat(path); }
