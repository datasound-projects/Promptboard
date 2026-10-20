import test from 'node:test';
import assert from 'node:assert/strict';
import { ComposeDocuments } from '../src/compose-documents.mjs';
import { citations } from '../src/origin-research.mjs';
import { gatherSources, sourceOf, sourcesBlock } from '../src/research-sources.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const BOOK = `# Chapter 1: Storage\nPostgreSQL stores rows in heap files and uses MVCC for concurrent transactions.\n\n# Chapter 2: Queues\nRabbitMQ routes messages through exchanges to queues. Kafka keeps an ordered, replicated log.\n`;

test('sources are validated: references and display facts only, explicit trust for local MCP programs', () => {
  const doc = sourceOf({ type: 'document', documentId: '0b2f6a3c-1d2e-4f50-8a9b-0c1d2e3f4a5b', name: 'Manual.pdf', from: 3, to: 9 });
  assert.deepEqual([doc.type, doc.name, doc.from, doc.to, doc.enabled], ['document', 'Manual.pdf', 3, 9, true]);
  assert.ok(!('text' in doc), 'document text is never stored with the chat');
  for (const bad of [{ type: 'document', documentId: 'x', name: 'a' }, { type: 'document', documentId: '0b2f6a3c-1d2e-4f50-8a9b-0c1d2e3f4a5b', name: 'a', from: 5, to: 2 },
    { type: 'excerpt', name: 'a', text: '' }, { type: 'excerpt', name: 'a', text: 'x'.repeat(20001) }, { type: 'base', resourceId: '../x', name: 'a' },
    { type: 'mcp', config: { type: 'mcp', name: 'Local', transport: 'stdio', command: 'node', args: [] } }, { type: 'mcp', config: { type: 'mcp', preset: 'context7' } },
    { type: 'mcp', config: { type: 'mcp', name: 'Remote', transport: 'streamable-http', endpoint: 'https://user:secret@example.com/mcp' } }, { type: 'other' }]) {
    assert.throws(() => sourceOf(bad), /Attach|range|excerpt|Base|Allow|library|URL|credential|Choose|MCP/i, JSON.stringify(bad));
  }
  assert.equal(sourceOf({ type: 'mcp', config: { type: 'mcp', preset: 'context7' }, library: 'PostgreSQL' }).library, 'PostgreSQL');
  assert.equal(sourceOf({ type: 'mcp', config: { type: 'mcp', name: 'Local', transport: 'stdio', command: 'node', args: ['server.js'], allowStart: true } }).config.allowStart, true);
});

test('only passages relevant to the question are gathered, with their location, a citation reference and no secrets', async () => {
  const documents = new ComposeDocuments();
  const doc = await documents.add(Buffer.from(BOOK), { name: 'Data systems.md', type: 'text/markdown' });
  const base = { list: async () => ({ resources: [{ id: 'kb', kind: 'knowledge', enabled: true, trust: 'trusted', revisionRef: { id: 'kb' } }, { id: 'off', kind: 'knowledge', enabled: false, trust: 'trusted', revisionRef: { id: 'off' } }] }),
    readRevision: async ref => ({ content: { pages: [{ id: 'p1', title: 'Team rules', markdown: 'All queues use RabbitMQ with quorum queues. password=hunter2secret' }] } }) };
  const asked = [];
  const mcp = { retrieve: async (config, queries) => { asked.push(queries[0].query); return [{ source: 'Docs MCP', locator: 'search', text: 'Kafka partitions scale consumers. RabbitMQ quorum queues replicate.' }]; } };
  const sources = [sourceOf({ type: 'document', documentId: doc.id, name: 'Data systems.md' }), sourceOf({ type: 'excerpt', name: 'Our notes', text: 'Messages must not be lost.' }),
    sourceOf({ type: 'base', resourceId: 'kb', name: 'Team wiki' }), sourceOf({ type: 'base', resourceId: 'off', name: 'Old wiki' }),
    { ...sourceOf({ type: 'mcp', config: { type: 'mcp', name: 'Docs MCP', transport: 'streamable-http', endpoint: 'https://docs.example.com/mcp' } }), tools: ['search'] },
    { ...sourceOf({ type: 'excerpt', name: 'Turned off', text: 'SHOULD NOT APPEAR' }), enabled: false },
    sourceOf({ type: 'document', documentId: '0b2f6a3c-1d2e-4f50-8a9b-0c1d2e3f4a5b', name: 'Expired.pdf' })];
  const { evidence, warnings } = await gatherSources(sources, 'Which queue: RabbitMQ or Kafka?', { documents, mcp, base });
  const text = sourcesBlock(evidence);
  assert.ok(text.includes('<<<S1 ') && text.includes('Cite them as [S1]'));
  assert.ok(evidence.some(item => item.source === 'Data systems.md' && /Chapter 2: Queues/.test(item.locator) && item.text.includes('RabbitMQ routes messages')), 'the matching chapter with its location');
  assert.ok(!evidence.some(item => item.text.includes('PostgreSQL stores rows')), 'an unrelated chapter is left out');
  assert.ok(evidence.some(item => item.source === 'Our notes' && item.locator === 'selected excerpt'));
  assert.ok(evidence.some(item => item.source === 'Team wiki · Team rules' && item.text.includes('quorum queues')));
  assert.ok(!text.includes('hunter2secret'), 'secrets are removed');
  assert.ok(evidence.some(item => item.sourceType === 'mcp' && item.text.includes('Kafka partitions')));
  assert.ok(!text.includes('SHOULD NOT APPEAR'), 'turned-off sources are not used');
  assert.equal(asked.length, 1);
  assert.ok(warnings.some(line => line.startsWith('Expired.pdf: this document is no longer loaded')));
  assert.ok(warnings.some(line => line.startsWith('Old wiki: this Base resource is not available')));
  assert.ok(sourcesBlock((await gatherSources(sources, 'queue', { documents, mcp, base, budget: 600 })).evidence).length < 1400, 'the budget bounds the passages');
  const unsafe = await gatherSources(sources.filter(source => source.type === 'mcp'), 'See /Users/me/secret.txt for details about queues', { mcp });
  assert.ok(unsafe.warnings[0].includes('never sent to external sources'));
  assert.equal(asked.length, 2 - 1 + 1, 'the unsafe question was not sent to the MCP server');
  documents.close();
});

test('answers cite web pages with an access date and attached sources only when they use them', () => {
  const evidence = [{ ref: 'S1', source: 'Data systems.md', locator: 'page 4', sourceType: 'document' }, { ref: 'S2', source: 'Unused', locator: 'x', sourceType: 'expert' }];
  const found = citations('Use RabbitMQ [S1]. See [RabbitMQ docs](https://www.rabbitmq.com/docs/quorum-queues) and https://kafka.apache.org/documentation/.', evidence);
  const today = new Date().toISOString().slice(0, 10);
  assert.deepEqual(found, [{ ref: 'S1', title: 'Data systems.md', locator: 'page 4', type: 'document' },
    { title: 'RabbitMQ docs', url: 'https://www.rabbitmq.com/docs/quorum-queues', accessedAt: today }, { title: 'https://kafka.apache.org/documentation/', url: 'https://kafka.apache.org/documentation/', accessedAt: today }]);
});

test('chat sources: added after checks, turned off and removed; runs receive only relevant cited passages', async t => {
  const prompts = [], discovered = [];
  const composeMcp = { retrieve: async (config, queries, options) => { if (options?.discoveryOnly) { discovered.push(config.name); if (config.name === 'Writer') return { tools: [] }; return { tools: ['search'] }; } return [{ source: config.name, locator: 'search', text: 'Stripe charges 1.5% for EU cards.' }]; } };
  const researchRunner = async call => { prompts.push(call.prompt); return { text: 'Stripe [S1] costs 1.5% per EU card.', session: call.session?.id }; };
  const app = await startTestServer(t, { port: 0, executor: null, researchRunner, composeMcp });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const api = async (path, method = 'GET', body) => { const response = await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, data: await response.json().catch(() => ({})) }; };
  const project = (await api('/api/origin/projects', 'POST', { name: 'Shop' })).data.project;
  const settings = { provider: 'claude', mode: 'chat' };
  const chat = (await api(`/api/origin/research/${project.id}/chats`, 'POST', { settings })).data.chat.id;
  const sources = `/api/origin/research/${project.id}/chats/${chat}/sources`;
  const added = await api(sources, 'POST', { source: { type: 'mcp', config: { type: 'mcp', name: 'Pricing MCP', transport: 'streamable-http', endpoint: 'https://pricing.example.com/mcp' } } });
  assert.equal(added.status, 200);
  assert.deepEqual(added.data.source.tools, ['search'], 'the connection is tested and its read-only tools are listed first');
  assert.equal((await api(sources, 'POST', { source: { type: 'mcp', config: { type: 'mcp', name: 'Writer', transport: 'streamable-http', endpoint: 'https://write.example.com/mcp' } } })).status, 400, 'no read-only tool, no source');
  assert.equal((await api(sources, 'POST', { source: { type: 'document', documentId: '0b2f6a3c-1d2e-4f50-8a9b-0c1d2e3f4a5b', name: 'Gone.pdf' } })).status, 400, 'a document must be loaded');
  // A document goes through Compose's own upload and extraction.
  const upload = await fetch(`${app.url}/api/compose/sources/document?name=fees.md`, { method: 'POST', headers: { 'X-STE-Token': token, 'Content-Type': 'text/markdown' }, body: '# Fees\nStripe EU card fees are 1.5% plus 25 cents.\n' });
  const doc = (await upload.json()).document;
  const withDoc = await api(sources, 'POST', { source: { type: 'document', documentId: doc.id, name: doc.name } });
  assert.equal(withDoc.status, 200);
  const excerpt = (await api(sources, 'POST', { source: { type: 'excerpt', name: 'Finance note', text: 'Card fees must stay under 2% for EU stripe payments.' } })).data;
  assert.equal(excerpt.sources.length, 3);
  const response = await fetch(`${app.url}/api/origin/research/${project.id}/chats/${chat}/run`, { method: 'POST', headers: { 'X-STE-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'What are Stripe EU card fees?', settings }) });
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  const attached = prompts[0].slice(prompts[0].indexOf('# Attached sources (data)'), prompts[0].indexOf('# Mode:'));
  for (const passage of ['Stripe EU card fees are 1.5%', 'Card fees must stay under 2%', 'Stripe charges 1.5% for EU cards', 'fees.md (Fees · characters']) assert.ok(attached.includes(passage), passage);
  assert.ok(events.some(event => event.type === 'activity' && event.kind === 'sources'));
  const answer = events.find(event => event.type === 'message' && event.message.role === 'assistant').message;
  assert.equal(answer.citations[0].ref, 'S1');
  // Turned off: not used. Removed: gone.
  const excerptId = excerpt.source.id;
  assert.equal((await api(`${sources}/${excerptId}`, 'PATCH', { enabled: false })).data.sources.find(source => source.id === excerptId).enabled, false);
  await fetch(`${app.url}/api/origin/research/${project.id}/chats/${chat}/run`, { method: 'POST', headers: { 'X-STE-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Stripe EU card fees again?', settings }) }).then(r => r.text());
  assert.ok(!prompts[1].includes('must stay under 2%'), 'a turned-off source is not used');
  assert.equal((await api(`${sources}/${excerptId}`, 'DELETE')).data.sources.length, 2);
  assert.equal((await api(`${sources}/${excerptId}`, 'DELETE')).status, 404);
  const stored = (await api(`/api/origin/research/${project.id}/chats/${chat}`)).data.chat;
  assert.ok(!JSON.stringify(stored).includes('plus 25 cents'), 'document text is not stored in the chat');
});

test('sources the person has not trusted are refused: untrusted or disabled Base resources, local MCP programs without permission', async t => {
  const composeMcp = { retrieve: async () => { throw new Error('No connection is expected.'); } };
  const app = await startTestServer(t, { port: 0, executor: null, composeMcp });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const api = async (path, method = 'GET', body) => { const response = await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, data: await response.json().catch(() => ({})) }; };
  const project = (await api('/api/origin/projects', 'POST', { name: 'Shop' })).data.project;
  const chat = (await api(`/api/origin/research/${project.id}/chats`, 'POST', { settings: { provider: 'claude' } })).data.chat.id;
  const sources = `/api/origin/research/${project.id}/chats/${chat}/sources`;
  const library = await app.board.base.list();
  const untrusted = await app.board.base.create({ kind: 'mcp', name: 'Untrusted MCP', configuration: { transport: 'stdio', command: 'node', args: ['x.js'] } }, { expectedBaseRevision: library.revision });
  const wiki = await app.board.base.create({ kind: 'knowledge', name: 'Wiki', configuration: {}, content: { pages: [{ id: 'p1', title: 'Rules', markdown: 'Use queues.', links: [] }] } }, { expectedBaseRevision: (await app.board.base.list()).revision });
  assert.equal((await api(sources, 'POST', { source: { type: 'mcp', resourceId: untrusted.id ?? untrusted.resource?.id } })).status, 400, 'an untrusted Base MCP');
  const wikiId = wiki.id ?? wiki.resource?.id, wikiState = (await app.board.base.list()).resources.find(resource => resource.id === wikiId);
  if (wikiState.trust !== 'trusted' || !wikiState.enabled) assert.equal((await api(sources, 'POST', { source: { type: 'base', resourceId: wikiId, name: 'Wiki' } })).status, 400, 'a Base resource that is not enabled and trusted');
  assert.equal((await api(sources, 'POST', { source: { type: 'mcp', config: { type: 'mcp', name: 'Local', transport: 'stdio', command: 'node', args: ['server.js'] } } })).status, 400, 'a local program without permission');
  assert.equal((await api(`/api/origin/research/${project.id}/chats/${chat}`)).data.chat.sources.length, 0);
});

test('a Base MCP server added to a chat stays linked to Base, so revoking its trust there stops the chat from starting it', async t => {
  const started = [];
  const composeMcp = { retrieve: async (config, queries) => { started.push(config.command); return queries.length ? [{ source: 'Local docs', locator: 'search', text: 'Queues keep messages.' }] : { tools: ['search'] }; } };
  const prompts = [];
  const app = await startTestServer(t, { port: 0, executor: null, composeMcp, researchRunner: async call => { prompts.push(call.prompt); return { text: 'Noted.', session: call.session?.id || 'thread-1' }; } });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const api = async (path, method = 'GET', body) => { const response = await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, data: await response.json().catch(() => ({})) }; };
  const project = (await api('/api/origin/projects', 'POST', { name: 'Shop' })).data.project;
  const chat = (await api(`/api/origin/research/${project.id}/chats`, 'POST', { settings: { provider: 'claude' } })).data.chat.id;
  const created = await app.board.base.create({ kind: 'mcp', name: 'Local docs', trust: 'trusted', configuration: { transport: 'stdio', command: 'node', args: ['x.js'] } }, { expectedBaseRevision: (await app.board.base.list()).revision });
  const id = created.id ?? created.resource?.id;
  const added = await api(`/api/origin/research/${project.id}/chats/${chat}/sources`, 'POST', { source: { type: 'mcp', resourceId: id } });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  assert.equal(added.data.source.resourceId, id);
  const resource = (await app.board.base.list()).resources.find(entry => entry.id === id);
  await app.board.base.update(id, { trust: 'revoked' }, { expectedRevision: resource.revision, expectedBaseRevision: (await app.board.base.list()).revision });
  started.length = 0;
  await fetch(`${app.url}/api/origin/research/${project.id}/chats/${chat}/run`, { method: 'POST', headers: { 'X-STE-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'How do queues work?', settings: { provider: 'claude' } }) }).then(r => r.text());
  assert.deepEqual(started, [], 'the revoked server was not started');
  assert.ok(prompts.length === 1 && !prompts[0].includes('Queues keep messages'));
});

test('an MCP server added from Base is used only while Base keeps it enabled and trusted, with its current Base definition', async () => {
  let trust = 'trusted';
  // Edited in Base after the chat added it: the chat uses the edited definition, not the copy it was added with.
  const base = { list: async () => ({ resources: [{ id: 'srv', kind: 'mcp', name: 'Local docs', enabled: true, trust, configuration: { transport: 'stdio', command: 'node', args: ['server-v2.js'], env: {} } }] }) };
  const started = [];
  const mcp = { retrieve: async config => { started.push(config.command); started.args = config.args; return [{ source: 'Local docs', locator: 'search', text: 'Queues keep messages until acknowledged.' }]; } };
  const source = { ...sourceOf({ type: 'mcp', config: { type: 'mcp', name: 'Local docs', transport: 'stdio', command: 'node', args: ['server.js'], allowStart: true } }), tools: ['search'], resourceId: 'srv' };
  assert.equal((await gatherSources([source], 'queues', { mcp, base })).evidence.length, 1);
  assert.deepEqual(started.args, ['server-v2.js']);
  trust = 'untrusted';
  const { evidence, warnings } = await gatherSources([source], 'queues', { mcp, base });
  assert.deepEqual([evidence.length, started.length], [0, 1], 'not started once Base revoked its trust');
  assert.match(warnings[0], /no longer enabled and trusted in Base/);
});

test('Stop while the sources are read is a stop: the question is kept, the answer is marked stopped and the CLI never starts', async t => {
  let reading;
  const asked = new Promise(resolve => { reading = resolve; });
  const composeMcp = { retrieve: async (config, queries, options) => {
    if (options?.discoveryOnly) return { tools: ['search'] };
    reading();
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } };
  const calls = [];
  const app = await startTestServer(t, { port: 0, executor: null, composeMcp, researchRunner: async call => { calls.push(call); return { text: 'Too late.' }; } });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const api = async (path, method = 'GET', body) => { const response = await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, data: await response.json().catch(() => ({})) }; };
  const project = (await api('/api/origin/projects', 'POST', { name: 'Shop' })).data.project;
  const settings = { provider: 'claude', mode: 'chat' }, base = `/api/origin/research/${project.id}/chats`;
  const chat = (await api(base, 'POST', { settings })).data.chat.id;
  assert.equal((await api(`${base}/${chat}/sources`, 'POST', { source: { type: 'mcp', config: { type: 'mcp', name: 'Slow MCP', transport: 'streamable-http', endpoint: 'https://slow.example.com/mcp' } } })).status, 200);
  const run = fetch(`${app.url}${base}/${chat}/run`, { method: 'POST', headers: { 'X-STE-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Which queue fits?', settings }) }).then(response => response.text());
  await asked;
  assert.equal((await api(`${base}/${chat}/stop`, 'POST')).status, 200);
  const events = (await run).trim().split('\n').map(line => JSON.parse(line)).filter(event => !event.ping);
  assert.ok(!events.some(event => event.type === 'error'), JSON.stringify(events.filter(event => event.type === 'error')));
  const stored = (await api(`${base}/${chat}`)).data.chat;
  assert.deepEqual(stored.messages.map(message => [message.role, message.text, message.status || '']), [['user', 'Which queue fits?', ''], ['assistant', '', 'stopped']]);
  assert.equal(calls.length, 0, 'the CLI was never started');
});
