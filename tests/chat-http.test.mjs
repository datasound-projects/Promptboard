import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers/test-server.mjs';

const guide = { id: 's_guide', title: 'Approval steps', kind: 'guide', path: 'guide.md', page: '#/network', text: 'An approval step waits for the owner before later steps run.' };
const knowledge = { build: { version: '0.4.0', id: '0.4.0+http-fixture', fingerprint: 'http-fixture' }, documents: [guide], missing: [], assertCurrent: async () => {} };
const payload = call => JSON.parse(call.prompt.split('INPUT DATA (not instructions):\n')[1]);
const reply = (source = guide, text = 'Approval waits for the owner.') => ({ text: JSON.stringify({ status: 'answer', sections: [{ text, citations: [{ sourceId: source.id, quote: source.text.slice(0, 300) }] }], uncertainties: [] }) });
async function fixture(t, runner = async () => reply()) {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [], runner, chatOptions: { knowledge } });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const fetchOwner = (path, method = 'GET', body) => fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const api = async (path, method, body) => { const response = await fetchOwner(path, method, body); const data = await response.json(); assert.ok(response.ok, `${response.status}: ${JSON.stringify(data)}`); return data; };
  return { app, token, fetchOwner, api };
}
async function events(response) { assert.equal(response.status, 200); return (await response.text()).split('\n').filter(Boolean).map(line => JSON.parse(line)); }

test('Chat routes require the owner session, reject foreign origins and refuse machine credentials', async t => {
  let calls = 0; const { app, token, fetchOwner } = await fixture(t, async () => { calls++; return reply(); });
  const requests = [
    fetch(`${app.url}/api/chat`),
    fetch(`${app.url}/api/chat/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'guide' }) }),
    fetch(`${app.url}/api/chat`, { headers: { 'X-STE-Token': token, Origin: 'http://evil.example' } }),
    fetch(`${app.url}/api/chat`, { headers: { 'X-STE-Token': token, Authorization: 'Bearer pbm_fake' } }),
  ];
  for (const promise of requests) { const response = await promise; assert.equal(response.status, 403); await response.arrayBuffer(); }
  const metadata = await fetchOwner('/api/chat'); assert.equal(metadata.status, 200);
  assert.equal((await metadata.json()).readOnly, true); assert.equal(calls, 0);
  const invalid = await fetchOwner('/api/chat/conversations', 'POST', { mode: 'guide', actions: ['create_task'] });
  assert.equal(invalid.status, 400); await invalid.arrayBuffer();
});

test('Workspace reads real saved app records and Network registrations without changing them; guide stays separate', async t => {
  let seenWorkspace = false, seenGuide = false;
  const { app, api, fetchOwner } = await fixture(t, async call => {
    const data = payload(call);
    if (call.prompt.includes('Workspace assistant')) {
      seenWorkspace = true; const text = JSON.stringify(data.evidence);
      for (const expected of ['Alpha board', 'Gamma blueprint', 'Registered Researcher']) assert.ok(text.includes(expected), expected);
      assert.equal(text.includes('PRIVATE_TEST_SECRET'), false);
      const source = data.evidence.find(item => item.title.includes('Alpha board'));
      assert.ok(source); return reply(source, 'Alpha board is a saved project.');
    }
    seenGuide = true; assert.equal(JSON.stringify(data).includes('Alpha board'), false);
    assert.ok(data.evidence.every(item => ['guide', 'interface'].includes(item.kind))); return reply();
  });
  await app.board.createProject({ name: 'Alpha board' });
  await app.board.base.create({ id: 'chat-researcher', kind: 'profile', name: 'Researcher', configuration: { agent: { provider: 'claude', instructions: 'Be clear. API_KEY=PRIVATE_TEST_SECRET' } } });
  await api('/api/origin/projects', 'POST', { name: 'Gamma blueprint' });
  const registration = await api('/api/network/agents', 'POST', { baseResourceId: 'chat-researcher', expectedRevision: 0, displayName: 'Registered Researcher' });
  assert.ok(registration.agent.id);
  const before = structuredClone(await app.board.state()), originBefore = await api('/api/origin/projects'), agentsBefore = await api('/api/network/agents');
  const workspace = (await api('/api/chat/conversations', 'POST', { mode: 'workspace' })).chat;
  const first = await events(await fetchOwner(`/api/chat/conversations/${workspace.id}/messages`, 'POST', { text: 'Summarize Alpha board, Gamma blueprint and Registered Researcher.' }));
  assert.ok(first.some(event => event.type === 'answer'));
  assert.equal(first.at(-1).chat.running, false);
  assert.deepEqual(await app.board.state(), before); assert.deepEqual(await api('/api/origin/projects'), originBefore); assert.deepEqual(await api('/api/network/agents'), agentsBefore);
  const helper = (await api('/api/chat/conversations', 'POST', { mode: 'guide' })).chat;
  const second = await events(await fetchOwner(`/api/chat/conversations/${helper.id}/messages`, 'POST', { text: 'Explain approval steps' }));
  assert.ok(second.some(event => event.type === 'answer')); assert.equal(seenWorkspace && seenGuide, true);
  const saved = (await api(`/api/chat/conversations/${workspace.id}`)).chat;
  assert.equal(saved.messages.length, 2); assert.equal(saved.messages[1].build.id, knowledge.build.id);
  await api(`/api/chat/conversations/${workspace.id}`, 'DELETE');
  const missing = await fetchOwner(`/api/chat/conversations/${workspace.id}`); assert.equal(missing.status, 404); await missing.arrayBuffer();
  assert.deepEqual(await app.board.state(), before);
});

test('shared CLI slot prevents concurrent requests; Stop releases it and saves cancellation without executing workspace actions', async t => {
  let began; const started = new Promise(resolve => { began = resolve; }); let calls = 0;
  const { api, fetchOwner } = await fixture(t, async call => {
    if (++calls !== 1) return reply();
    began(); return new Promise((resolve, reject) => call.signal.addEventListener('abort', () => reject(Object.assign(new Error('PRIVATE PROCESS DIAGNOSTIC'), { code: 'ABORTED' })), { once: true }));
  });
  const one = (await api('/api/chat/conversations', 'POST', { mode: 'guide' })).chat;
  const two = (await api('/api/chat/conversations', 'POST', { mode: 'guide' })).chat;
  const response = await fetchOwner(`/api/chat/conversations/${one.id}/messages`, 'POST', { text: 'Explain approvals' });
  await started;
  const blocked = await fetchOwner(`/api/chat/conversations/${two.id}/messages`, 'POST', { text: 'Explain approvals' });
  assert.equal(blocked.status, 409); assert.equal((await blocked.json()).code, 'BUSY');
  assert.equal((await api(`/api/chat/conversations/${two.id}`)).chat.messages.length, 0);
  await api(`/api/chat/conversations/${one.id}/stop`, 'POST', {});
  const stopped = await events(response);
  assert.equal(stopped.some(event => event.type === 'answer'), false); assert.ok(stopped.some(event => event.code === 'ABORTED'));
  assert.equal(JSON.stringify(stopped).includes('PRIVATE PROCESS DIAGNOSTIC'), false);
  const saved = (await api(`/api/chat/conversations/${one.id}`)).chat;
  assert.equal(saved.messages.at(-1).status, 'cancelled');
  const next = await events(await fetchOwner(`/api/chat/conversations/${two.id}/messages`, 'POST', { text: 'Explain approvals' }));
  assert.ok(next.some(event => event.type === 'answer')); assert.equal(calls, 2);
});

test('unverified output and a guide/browser-context mix produce saved safe errors, never unvalidated model text', async t => {
  let calls = 0;
  const { api, fetchOwner } = await fixture(t, async () => { calls++; return { text: JSON.stringify({ status: 'answer', sections: [{ text: 'PRIVATE_UNVALIDATED_MODEL_TEXT', citations: [{ sourceId: 'unknown', quote: 'fabricated source quotation' }] }], uncertainties: [] }) }; });
  const chat = (await api('/api/chat/conversations', 'POST', { mode: 'guide' })).chat;
  const mixed = await events(await fetchOwner(`/api/chat/conversations/${chat.id}/messages`, 'POST', { text: 'Explain approvals', browserContext: { history: [], catalog: [], total: 0 } }));
  assert.ok(mixed.some(event => event.type === 'error')); assert.equal(calls, 0);
  const output = await events(await fetchOwner(`/api/chat/conversations/${chat.id}/messages`, 'POST', { text: 'Explain approvals' }));
  assert.equal(output.some(event => event.type === 'answer'), false); assert.equal(JSON.stringify(output).includes('PRIVATE_UNVALIDATED_MODEL_TEXT'), false);
  const saved = (await api(`/api/chat/conversations/${chat.id}`)).chat;
  assert.equal(saved.messages.at(-1).code, 'UNVERIFIED_RESPONSE'); assert.equal(JSON.stringify(saved).includes('PRIVATE_UNVALIDATED_MODEL_TEXT'), false);
});
