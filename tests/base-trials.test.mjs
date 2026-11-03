import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { startTestServer } from './helpers/test-server.mjs';

async function world(t, runner) {
  const app = await startTestServer(t, { port: 0, executor: null, runner, detector: async () => [{ id: 'codex', available: true }] });
  const token = (await fetch(`${app.url}/api/session`).then(r => r.json())).token;
  const request = async (path, body, method = body === undefined ? 'GET' : 'POST', extra = {}) => {
    const response = await fetch(app.url + path, { method, headers: { 'x-ste-token': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  const create = resource => app.board.base.create(resource);
  return { ...app, request, create };
}

test('agent trials use pinned instructions and stored knowledge, validate answers, preserve saved data and remove the empty workspace', async t => {
  const requests = [], w = await world(t, async request => { requests.push(request); await access(request.cwd); return { text: requests.length === 1 ? '{"summary":"checked"}' : 'invalid json' }; });
  const knowledge = await w.create({ kind: 'knowledge', name: 'API manual', content: { sources: [{ id: 'notes', name: 'Saved notes', text: 'The widget uses revision 7.' }] } });
  const mcp = await w.create({ kind: 'mcp', name: 'Unused server', enabled: true, trust: 'trusted', configuration: { transport: 'stdio', command: 'must-never-execute' } });
  const agent = await w.create({ kind: 'profile', name: 'Specialist', configuration: { agent: { provider: 'codex', instructions: 'Cite the supplied version.' }, binding: { mode: 'extend', include: [{ resourceId: knowledge.id, required: true }, { resourceId: mcp.id, required: true }], exclude: [] }, contract: { output: { format: 'json', schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false } }, evaluations: [{ name: 'Saved case', input: 'What version?', contains: ['revision'], excludes: [] }] } } });
  const before = await w.board.state(), response = await w.request(`/api/base/resources/${agent.id}/trial`, { expectedRevision: agent.revision, operationId: 'trial_operation_one', question: 'Check the manual' });
  assert.equal(response.status, 200, JSON.stringify(response.data)); assert.equal(requests.length, 2);
  assert.match(requests[0].prompt, /Cite the supplied version/); assert.match(requests[0].prompt, /revision 7/); assert.doesNotMatch(requests[0].prompt, /must-never-execute/);
  assert.equal(response.data.results[0].validation.passed, true); assert.equal(response.data.results[1].validation.passed, false);
  assert.match(response.data.coverage.join(' '), /MCP tools.*not exercised/); assert.equal(response.data.expectedRevision, agent.revision);
  for (const request of requests) await assert.rejects(access(request.cwd));
  const after = await w.board.state(); assert.deepEqual(after.base, before.base); assert.equal(after.runs.length, 0);
});

test('compatibility is read-only, detects required MCP restrictions and stale/invalid trial requests never call a CLI', async t => {
  let calls = 0; const w = await world(t, async () => { calls++; return { text: 'answer' }; });
  const mcp = await w.create({ kind: 'mcp', name: 'Server', enabled: true, trust: 'trusted', configuration: { transport: 'streamable-http', endpoint: 'https://example.com/mcp' } });
  const agent = await w.create({ kind: 'profile', name: 'Agent', configuration: { binding: { mode: 'extend', include: [{ resourceId: mcp.id, required: true }], exclude: [] } } });
  const result = await w.request(`/api/base/resources/${agent.id}/preflight`); assert.equal(result.status, 200); assert.equal(result.data.matrix.length, 9);
  assert.ok(result.data.matrix.some(row => row.columnId === 'planning' && !row.ready)); assert.ok(result.data.matrix.some(row => row.columnId === 'executing' && row.ready)); assert.equal(calls, 0);
  assert.equal((await w.request(`/api/base/resources/${agent.id}/trial`, { expectedRevision: 0, operationId: 'trial_stale_one', question: 'Test' })).status, 409);
  assert.equal((await w.request(`/api/base/resources/${agent.id}/trial`, { expectedRevision: agent.revision, operationId: '../invalid', question: 'Test' })).status, 400);
  assert.equal((await w.request(`/api/base/resources/${agent.id}/trial`, { expectedRevision: agent.revision, operationId: 'trial_empty_one', question: '' })).status, 400);
  assert.equal((await w.request(`/api/base/resources/${agent.id}/trial`, { expectedRevision: agent.revision, operationId: 'trial_wrong_origin', question: 'Test' }, 'POST', { origin: 'https://evil.example' })).status, 403); assert.equal(calls, 0);
});

test('cancelling a trial reaches the owned runner and a changed revision cannot receive a passing result', async t => {
  let enter, finish, calls = 0; const ready = new Promise(resolve => { enter = resolve; });
  const w = await world(t, request => { calls++; enter(); return new Promise((resolve, reject) => { finish = resolve; request.signal.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { code: 'ABORTED', status: 409 })), { once: true }); }); });
  const agent = await w.create({ kind: 'profile', name: 'Agent', configuration: { agent: { provider: 'codex' } } });
  const pending = w.request(`/api/base/resources/${agent.id}/trial`, { expectedRevision: agent.revision, operationId: 'trial_cancel_one', question: 'Test' }); await ready;
  assert.equal((await w.request(`/api/base/resources/${agent.id}/trial/cancel`, { operationId: 'trial_cancel_one' })).data.cancelled, true); assert.notEqual((await pending).status, 200);
  for (let n = 0; n < 100 && (await w.request('/api/status')).data.busy; n++) await new Promise(resolve => setTimeout(resolve, 10));
  const second = w.request(`/api/base/resources/${agent.id}/trial`, { expectedRevision: agent.revision, operationId: 'trial_changed_one', question: 'Test' });
  for (let n = 0; n < 100 && calls < 2; n++) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(calls, 2);
  await w.board.base.update(agent.id, { ...agent, description: 'Changed during test' }, { expectedRevision: agent.revision }); finish({ text: 'answer' });
  assert.equal((await second).status, 409);
});
