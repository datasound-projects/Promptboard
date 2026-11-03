import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { startTestServer } from './helpers/test-server.mjs';

test('private MCP setup is protected, revision checked, deactivates stale tests, exports no secrets and cleans credentials on deletion', async t => {
  let tests = 0;
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [], mcpTester: async (definition, { environment }) => {
    tests++; assert.equal(environment[definition.configuration.headers.Authorization], 'Bearer PRIVATE_TEST_TOKEN'); return { status: 'connected', tools: [{ name: 'lookup', description: 'Read a document.' }], resources: 0, prompts: 0 };
  } });
  const token = (await fetch(app.url + '/api/session').then(r => r.json())).token;
  const call = async (path, body, method = body === undefined ? 'GET' : 'POST', headers = {}) => {
    const response = await fetch(app.url + path, { method, headers: { 'x-ste-token': token, ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, data: await response.json() };
  };
  const created = await call('/api/base/resources', { kind: 'mcp', name: 'Private docs', trust: 'trusted', enabled: false, configuration: { transport: 'streamable-http', endpoint: 'https://docs.example/mcp', headers: { Authorization: 'DOCS_AUTHORIZATION' }, auth: { mode: 'environment', required: true } } });
  assert.equal(created.status, 200); let resource = created.data.resource; const path = `/api/base/resources/${resource.id}`;
  assert.equal(tests, 0);
  assert.equal((await call(path + '/auth/credentials', { expectedRevision: resource.revision, values: { DOCS_AUTHORIZATION: 'Bearer PRIVATE_TEST_TOKEN' } }, 'POST', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(path + '/auth/credentials', { expectedRevision: 0, values: { DOCS_AUTHORIZATION: 'Bearer PRIVATE_TEST_TOKEN' } })).status, 409);
  const saved = await call(path + '/auth/credentials', { expectedRevision: resource.revision, values: { DOCS_AUTHORIZATION: 'Bearer PRIVATE_TEST_TOKEN' } });
  assert.equal(saved.status, 200); assert.doesNotMatch(JSON.stringify(saved.data), /PRIVATE_TEST_TOKEN/); resource = (await app.board.base.detail(resource.id)); assert.equal(resource.enabled, false); assert.equal(resource.connectionTest.status, 'failed');
  const checked = await call(path + '/test', { expectedRevision: resource.revision }); assert.equal(checked.status, 200, JSON.stringify(checked.data)); assert.equal(tests, 1); resource = checked.data.resource; assert.equal(resource.enabled, false, 'Testing never activates a connection.');
  const activated = await call(path, { enabled: true, expectedRevision: resource.revision }, 'PATCH'); assert.equal(activated.status, 200); resource = activated.data.resource; assert.equal(resource.enabled, true); assert.equal(resource.connectionTest.status, 'connected');
  const exported = await call('/api/base/export', { resourceIds: [resource.id], includeContent: true }); assert.equal(exported.status, 200); assert.doesNotMatch(JSON.stringify(exported.data), /PRIVATE_TEST_TOKEN/); assert.equal(tests, 1, 'Save/export never call the MCP server.');
  const vault = app.board.mcpConnections.path(resource.id); assert.match(await readFile(vault, 'utf8'), /PRIVATE_TEST_TOKEN/);
  const changed = await call(path, { configuration: { ...resource.configuration, endpoint: 'https://other.example/mcp' }, enabled: true, expectedRevision: resource.revision }, 'PATCH'); resource = changed.data.resource;
  assert.equal(resource.enabled, false); assert.equal(resource.connectionTest, undefined); assert.equal((await call(path + '/auth')).data.references[0].ready, false);
  const revoked = await call(path, { trust: 'revoked', expectedRevision: resource.revision }, 'PATCH'); resource = revoked.data.resource;
  assert.equal((await call(path + '/auth/disconnect', {})).status, 200, 'Revoked connections can still remove their private credentials.'); await assert.rejects(stat(vault));
  resource = await app.board.base.detail(resource.id);
  const deleted = await call(path, { expectedRevision: resource.revision }, 'DELETE'); assert.equal(deleted.status, 200); await assert.rejects(stat(vault));
});
