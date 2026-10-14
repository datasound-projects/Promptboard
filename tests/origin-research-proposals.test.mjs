import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/origin-model.js';
import { extractSuggestions, mergeProposals, proposalsFor } from '../src/origin-research.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const M = globalThis.PromptboardOriginModel;
function blueprint() {
  const bp = M.emptyBlueprint();
  bp.idea = 'A shop';
  bp.vision.goal = 'Sell online';
  bp.labels.sections.security = 'Protection';
  bp.questions.push({ id: 'q1', scope: 'section', sectionId: 'security', text: 'Who rotates keys?' }, { id: 'q2', scope: 'component', sectionId: '', text: 'How does it scale?' });
  bp.technologies.push({ id: 't1', origin: 'human', name: 'PostgreSQL', category: 'database', purpose: 'Orders', version: '', status: 'candidate', reason: '', alternatives: '', sourceIds: [] });
  bp.components.push({ id: 'c1', origin: 'human', name: 'API', type: 'api', purpose: 'Takes orders', responsibilities: '', technologyIds: [], interfaces: '', dataHandled: '', status: 'draft', notes: '', sourceIds: [], x: 0, y: 0, layerId: null, answers: {} });
  bp.sources.push({ id: 's1', origin: 'human', title: 'Docs', url: 'https://example.com', type: 'documentation', claim: '', accessedAt: '', verification: 'unverified', notes: '' });
  return bp;
}

test('suggestions are checked against the blueprint by stable IDs; sources are never marked verified', () => {
  const bp = blueprint(), check = raw => M.validateResearchSuggestion(bp, raw);
  const reason = check({ title: 'Why PostgreSQL', why: 'Transactions', evidence: ['S1', 'https://www.postgresql.org/docs/'], target: { kind: 'record', collection: 'technologies', id: 't1', field: 'reason' }, value: 'ACID transactions for orders' });
  assert.deepEqual([reason.op, reason.key, reason.value, reason.original], ['set', 'record:technologies:t1:reason', 'ACID transactions for orders', '']);
  assert.equal(check({ target: { kind: 'record', collection: 'technologies', id: 't1', field: 'status' }, value: 'Selected' }).value, 'selected', 'enum labels map to their IDs');
  assert.equal(check({ target: { kind: 'vision', field: 'goal' }, value: 'Sell 1,000 items a month' }).original, 'Sell online');
  assert.equal(check({ target: { kind: 'topic', section: 'security', area: 'secrets' }, value: 'A vault' }).title, 'Protection › Secrets', 'labels use the project’s own names');
  assert.equal(check({ target: { kind: 'answer', questionId: 'q1' }, value: 'The platform team' }).original, '');
  assert.equal(check({ target: { kind: 'componentAnswer', componentId: 'c1', questionId: 'q2' }, value: 'Two instances' }).key, 'componentAnswer:c1:q2');
  const added = check({ target: { kind: 'add', collection: 'technologies' }, value: { name: 'Redis', purpose: 'Cache', status: 'candidate', id: 'injected', sourceIds: ['x'] } });
  assert.deepEqual(added.value, { name: 'Redis', purpose: 'Cache', status: 'candidate' }, 'only suggestible fields are kept');
  for (const [raw, message] of [
    [{ target: { kind: 'record', collection: 'sources', id: 's1', field: 'verification' }, value: 'verified' }, /cannot be suggested/],
    [{ target: { kind: 'record', collection: 'technologies', id: 'gone', field: 'reason' }, value: 'x' }, /does not exist/],
    [{ target: { kind: 'record', collection: 'technologies', id: 't1', field: 'sourceIds' }, value: 'x' }, /cannot be suggested/],
    [{ target: { kind: 'record', collection: 'technologies', id: 't1', field: 'status' }, value: 'perfect' }, /not a valid status/],
    [{ target: { kind: 'vision', field: 'goal' }, value: 'Sell online' }, /does not change anything/],
    [{ target: { kind: 'answer', questionId: 'missing' }, value: 'x' }, /does not exist/],
    [{ target: { kind: 'add', collection: 'items' }, value: { title: 'x' } }, /New records can be/],
    [{ target: { kind: 'add', collection: 'technologies' }, value: { purpose: 'no name' } }, /needs a name/],
    [{ target: { kind: 'add', collection: 'sources' }, value: { title: 'Bad', url: 'https://user:pw@example.com/x' } }, /without credentials/],
    [{ target: { kind: 'other' }, value: 'x' }, /Unknown suggestion target/],
  ]) assert.throws(() => check(raw), message, JSON.stringify(raw.target));
  assert.equal(M.researchTargetValue(bp, { kind: 'record', collection: 'technologies', id: 'gone', field: 'reason' }), undefined);
  assert.equal(M.researchTargetLabel(bp, { kind: 'record', collection: 'technologies', id: 't1', field: 'reason' }), 'Technology “PostgreSQL” › reason');
});

test('the suggestions block is taken out of the answer, invalid suggestions are dropped, and swarm results are merged', () => {
  const answer = 'Use PostgreSQL.\n\n```origin-suggestions\n{"suggestions":[{"title":"Reason","target":{"kind":"record","collection":"technologies","id":"t1","field":"reason"},"value":"Transactions"},{"target":{"kind":"record","collection":"technologies","id":"nope","field":"reason"},"value":"x"}]}\n```';
  const extracted = extractSuggestions(answer);
  assert.equal(extracted.text, 'Use PostgreSQL.');
  assert.equal(extracted.raw.length, 2);
  assert.deepEqual(extractSuggestions('No block.'), { text: 'No block.', raw: [] });
  assert.equal(extractSuggestions('Text\n```origin-suggestions\n{broken\n```').unreadable, true);
  const record = { revision: 7, blueprint: blueprint() };
  const { proposals, dropped } = proposalsFor(record, extracted.raw, { messageId: 'm1' });
  assert.equal(dropped, 1);
  assert.deepEqual([proposals[0].status, proposals[0].baseRevision, proposals[0].original, proposals[0].messageId], ['pending', 7, '', 'm1']);
  const one = proposalsFor(record, [{ target: { kind: 'record', collection: 'technologies', id: 't1', field: 'reason' }, value: 'Transactions' }], { messageId: 'a', agent: { id: 'a1', label: 'Stack' } }).proposals;
  const two = proposalsFor(record, [{ target: { kind: 'record', collection: 'technologies', id: 't1', field: 'reason' }, value: 'Transactions' }], { messageId: 'b', agent: { id: 'a2', label: 'Data' } }).proposals;
  const three = proposalsFor(record, [{ target: { kind: 'record', collection: 'technologies', id: 't1', field: 'reason' }, value: 'Cheap hosting' }], { messageId: 'c', agent: { id: 'a3', label: 'Ops' } }).proposals;
  const merged = mergeProposals([...one, ...two, ...three]);
  assert.equal(merged.length, 2, 'the same change from two agents is reviewed once');
  assert.deepEqual(merged[0].alsoFrom, ['Data']);
  assert.ok(merged.every(proposal => proposal.disagree), 'different values for one field are marked');
});

test('runs store suggestions with the answer; the review state is saved with the chat; the blueprint is not touched by the server', async t => {
  const researchRunner = async call => ({ text: 'Findings.\n```origin-suggestions\n{"suggestions":[{"title":"Add a cache","target":{"kind":"add","collection":"technologies"},"value":{"name":"Redis","purpose":"Session cache"}},{"title":"Goal","target":{"kind":"vision","field":"goal"},"value":"Sell 1,000 items a month"}]}\n```', session: call.session?.id });
  const app = await startTestServer(t, { port: 0, executor: null, researchRunner });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const api = async (path, method = 'GET', body) => { const response = await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, data: await response.json().catch(() => ({})) }; };
  const project = (await api('/api/origin/projects', 'POST', { name: 'Shop' })).data.project;
  const before = (await api(`/api/origin/projects/${project.id}`)).data;
  const settings = { provider: 'claude', mode: 'chat' };
  const chat = (await api(`/api/origin/research/${project.id}/chats`, 'POST', { settings })).data.chat.id;
  const events = (await (await fetch(`${app.url}/api/origin/research/${project.id}/chats/${chat}/run`, { method: 'POST', headers: { 'X-STE-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Improve the plan', settings }) })).text()).trim().split('\n').map(line => JSON.parse(line));
  const answer = events.find(event => event.type === 'message' && event.message.role === 'assistant').message;
  assert.equal(answer.text, 'Findings.', 'the raw block is not shown as text');
  const { proposals } = events.find(event => event.type === 'proposals');
  assert.deepEqual(proposals.map(proposal => [proposal.op, proposal.title, proposal.status, proposal.messageId === answer.id]), [['add', 'Add a cache', 'pending', true], ['set', 'Goal', 'pending', true]]);
  assert.equal(proposals[1].baseRevision, before.revision);
  const path = `/api/origin/research/${project.id}/chats/${chat}/proposals`;
  assert.equal((await api(`${path}/${proposals[0].id}`, 'PATCH', { status: 'applied', revision: before.revision + 1, edited: true })).data.proposals[0].status, 'applied');
  assert.equal((await api(`${path}/${proposals[1].id}`, 'PATCH', { status: 'rejected' })).data.proposals[1].status, 'rejected');
  assert.equal((await api(`${path}/${proposals[1].id}`, 'PATCH', { status: 'done' })).status, 400);
  const after = (await api(`/api/origin/projects/${project.id}`)).data;
  assert.deepEqual([after.revision, after.blueprint.vision.goal, after.blueprint.technologies.length], [before.revision, '', 0], 'only the page applies suggestions, through Origin’s save');
});
