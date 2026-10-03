import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComposeMcp, isReadOnlyTool, validateMcp, selectContext7Library } from '../src/compose-mcp.mjs';
import { questText } from './helpers/compose-fixtures.mjs';
const fixture = fileURLToPath(new URL('./fixtures/compose-mcp-server.mjs', import.meta.url));
const source = (mode = 'safe', log) => ({ type: 'mcp', name: 'Test docs', transport: 'stdio', command: process.execPath, args: [fixture, mode, ...(log ? [log] : [])], allowStart: true });
const queries = [{ questionId: 'q1', libraryHint: 'QuestDB', query: 'QuestDB crypto ingestion ILP high throughput' }];

test('Context7 library selection prefers the requested language and never matches only an owner', () => {
  const matches = '- Title: C QuestDB Client\n- Context7-compatible library ID: /questdb/c-questdb-client\n-----\n- Title: QuestDB\n- Context7-compatible library ID: /websites/questdb\n-----\n- Title: QuestDB Client Library for Python\n- Context7-compatible library ID: /websites/py-questdb-client_readthedocs_io_en';
  assert.equal(selectContext7Library(matches, 'QuestDB', 'Python QuestDB ILP ingestion'), '/websites/py-questdb-client_readthedocs_io_en');
  assert.equal(selectContext7Library(matches, 'QuestDB', 'QuestDB designated timestamp'), '/websites/questdb');
  assert.equal(selectContext7Library('- Title: Other database\n- Library ID: /questdb/other', 'QuestDB', 'QuestDB ingestion'), undefined);
});

test('MCP validation uses environment references, explicit local consent and safe URLs', () => {
  assert.equal(validateMcp({ type: 'mcp', preset: 'context7' }).endpoint, 'https://mcp.context7.com/mcp');
  assert.equal(validateMcp(source()).transport, 'stdio');
  for (const data of [{ ...source(), allowStart: false }, { ...source(), env: { KEY: 'literal-secret!' } }, { type: 'mcp', preset: 'context7', endpoint: 'http://evil.test' },
    ...['file:///tmp/x', 'https://user:pass@example.com/mcp', 'http://remote.test/mcp', 'https://remote.test/mcp?token=secret'].map(endpoint => ({ type: 'mcp', name: 'X', transport: 'streamable-http', endpoint }))]) assert.throws(() => validateMcp(data));
});

test('side-effect/ambiguous tools are never eligible even with misleading annotations', () => {
  for (const name of ['delete_database', 'send_email', 'deploy', 'get_shell', 'read_account', 'execute_query']) assert.equal(isReadOnlyTool({ name, annotations: { readOnlyHint: true } }), false, name);
  assert.equal(isReadOnlyTool({ name: 'get_documentation', annotations: { readOnlyHint: true } }), true);
  assert.equal(isReadOnlyTool({ name: 'get_documentation' }), false);
  assert.equal(isReadOnlyTool({ name: 'get_documentation', annotations: { readOnlyHint: true, destructiveHint: true } }), false);
});

test('real stdio SDK discovers tools, calls only retrieval, redacts secrets and caches identical queries', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-compose-mcp-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls.log'); const adapter = new ComposeMcp();
  const config = { ...source('safe', log), env: { KEY: 'TEST_MCP_KEY' } };
  const options = { environment: { TEST_MCP_KEY: 'SECRET_REF' } };
  const tools = await adapter.retrieve(config, [], { ...options, discoveryOnly: true });
  assert.deepEqual(tools.tools, ['get_documentation']);
  const rows = await adapter.retrieve(config, [...queries, { ...queries[0], questionId: 'q2' }], options);
  assert.equal(rows.length, 2); assert.match(rows[0].text, /QuestDB/); assert.doesNotMatch(rows[0].text, /SECRET_REF/);
  assert.deepEqual(rows.map(row => row.questionId), ['q1', 'q2']);
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 1);
  const cached = await adapter.retrieve(config, queries, options); assert.equal(cached[0].questionId, 'q1');
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 1);
});

test('stdio unavailable, malformed, ambiguous, timeout and cancellation fail boundedly', async () => {
  for (const [mode, message] of [['failure', /unavailable/], ['malformed', /invalid|usable/], ['ambiguous', /no compatible/]]) await assert.rejects(new ComposeMcp().retrieve(source(mode), queries), message);
  await assert.rejects(new ComposeMcp().retrieve(source('hang'), queries, { timeoutMs: 150 }), /limit/);
  const controller = new AbortController();
  const pending = new ComposeMcp().retrieve(source('hang'), queries, { signal: controller.signal }); setTimeout(() => controller.abort(), 150);
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(new ComposeMcp().retrieve({ ...source(), command: 'nonexistent-promptboard-fixture' }, queries), /unavailable/);
});

function context7Fetch(calls, { changed = false } = {}) {
  return async (url, options) => {
    assert.equal(String(url), 'https://mcp.context7.com/mcp');
    if (!options?.body) return new Response(null, { status: 202 });
    const request = JSON.parse(options.body);
    if (request.id === undefined) return new Response(null, { status: 202 });
    let result;
    if (request.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'Context7', version: 'fixture' } };
    else if (request.method === 'tools/list') result = { tools: [['resolve-library-id', ['libraryName', 'query']], ['query-docs', ['libraryId', 'query']]].map(([name, fields]) => ({ name: changed ? name + '-new' : name, annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: Object.fromEntries(fields.map(field => [field, { type: 'string' }])), required: fields } })) };
    else if (request.method === 'tools/call') {
      calls.push(request.params);
      result = { content: [{ type: 'text', text: request.params.name === 'resolve-library-id' ? '- Title: QuestDB\n- Context7-compatible library ID: /questdb/questdb\n- Description: Time series database' : questText }] };
    }
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  };
}

test('Context7 discovers current capabilities and resolves only task-specific library/query data', async t => {
  const calls = [], previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = context7Fetch(calls);
  const rows = await new ComposeMcp().retrieve({ type: 'mcp', preset: 'context7' }, queries);
  assert.equal(calls.length, 2); assert.deepEqual(calls[0].arguments, { libraryName: 'QuestDB', query: queries[0].query });
  assert.deepEqual(calls[1].arguments, { libraryId: '/questdb/questdb', query: queries[0].query });
  assert.equal(rows[0].locator, '/questdb/questdb'); assert.equal(rows[0].source, 'Context7 / QuestDB');
  globalThis.fetch = context7Fetch([], { changed: true });
  await assert.rejects(new ComposeMcp().retrieve({ type: 'mcp', preset: 'context7' }, queries), /capabilities changed/);
});
