import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResearchStore, scopeOf, settingsOf } from '../src/origin-research.mjs';
import { startTestServer } from './helpers/test-server.mjs';

async function folder(t) { const dir = await mkdtemp(join(tmpdir(), 'pb-research-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function api(app, path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${app.url}${path}`, { method, headers: { ...(token === undefined ? {} : { 'X-STE-Token': token }), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}

test('research scopes and settings use stable IDs and accept only Claude Code and Codex', () => {
  assert.deepEqual(scopeOf(undefined), { kind: 'project' });
  assert.deepEqual(scopeOf({ kind: 'section', id: 'own_section-1' }), { kind: 'section', id: 'own_section-1' });
  assert.deepEqual(scopeOf({ kind: 'record', collection: 'technologies', id: 't1', extra: 'dropped' }), { kind: 'record', collection: 'technologies', id: 't1' });
  for (const key of ['vision:goal', 'topic:security:secrets', 'question:q_1', 'component:c1:q_1']) assert.deepEqual(scopeOf({ kind: 'question', key }), { kind: 'question', key });
  for (const bad of [{ kind: 'record', collection: 'questions', id: 'x' }, { kind: 'record', collection: 'nope', id: 'x' }, { kind: 'section', id: '../x' }, { kind: 'question', key: 'field:x' }, { kind: 'other' }, []]) {
    assert.throws(() => scopeOf(bad), /Choose|Invalid/);
  }
  assert.deepEqual(settingsOf({ provider: 'codex', model: 'gpt-5.5', effort: 'low', mode: 'swarm', web: true, scope: { kind: 'section', id: 'security' } }),
    { provider: 'codex', model: 'gpt-5.5', effort: 'low', mode: 'swarm', web: true, scope: { kind: 'section', id: 'security' } });
  assert.equal(settingsOf({ provider: 'claude' }).web, false, 'web research is off unless asked for');
  assert.equal(settingsOf({ provider: 'claude', web: 'yes' }).web, false);
  for (const bad of [{ provider: 'gemini' }, { provider: 'agy' }, { provider: 'claude', model: '--dangerous' }, { provider: 'claude', model: 'a b' }, { provider: 'claude', mode: 'other' }, { provider: 'claude', effort: 'HIGH;' }]) {
    assert.throws(() => settingsOf(bad), /Research uses|model|Choose/);
  }
});

test('chats are stored per project, searchable, updated atomically and never mixed between projects', async t => {
  const dir = await folder(t), store = new ResearchStore(dir);
  assert.deepEqual(await store.list('p1'), [], 'no folder is needed to list');
  assert.deepEqual(await readdir(dir), [], 'listing writes nothing');
  const first = await store.create('p1', { provider: 'claude', mode: 'chat' });
  const second = await store.create('p1', { provider: 'codex', mode: 'audit' });
  const other = await store.create('P1', { provider: 'claude' });
  await store.update('p1', first.id, chat => { chat.title = 'Queue choice'; chat.messages.push({ id: 'm1', role: 'user', text: 'Compare RabbitMQ and Kafka', at: 1 }); });
  assert.deepEqual((await store.list('p1')).map(chat => chat.id), [first.id, second.id], 'newest first');
  assert.deepEqual((await store.list('p1', { query: 'kafka rabbitmq' })).map(chat => [chat.id, chat.title, chat.messages]), [[first.id, 'Queue choice', 1]]);
  assert.deepEqual((await store.list('P1')).map(chat => chat.id), [other.id], 'IDs that differ only in case are different projects');
  await assert.rejects(store.read('p1', other.id), /does not exist/, 'another project’s chat is not readable here');
  await assert.rejects(store.read('p1', '../../x'), /does not exist/);
  // Concurrent updates are applied in order, none is lost.
  await Promise.all(Array.from({ length: 10 }, (_, index) => store.update('p1', second.id, chat => { chat.messages.push({ id: `m${index}`, role: 'user', text: `q${index}`, at: index }); })));
  assert.equal((await store.read('p1', second.id)).messages.length, 10);
  assert.deepEqual(await store.remove('p1', first.id), { removed: true });
  await assert.rejects(store.read('p1', first.id), /does not exist/);
  assert.deepEqual((await store.list('p1')).map(chat => chat.id), [second.id]);
});

test('research routes need the session token and an existing Origin project; no chat folder until a chat is saved', async t => {
  const app = await startTestServer(t, { port: 0, executor: null, runner: async () => { throw new Error('No model call is expected.'); } });
  const { token } = (await api(app, '/api/session')).data;
  const project = (await api(app, '/api/origin/projects', { method: 'POST', token, body: { name: 'Shop' } })).data.project;
  const base = `/api/origin/research/${project.id}/chats`;
  const revision = async () => { const { data } = await api(app, `/api/origin/projects/${project.id}`, { token }); return data.project?.revision ?? data.revision; };
  const before = await revision();
  assert.equal((await api(app, base)).status, 403, 'the token is required');
  assert.deepEqual(await api(app, base, { token }), { status: 200, data: { chats: [] } });
  assert.equal((await api(app, '/api/origin/research/missing/chats', { token })).status, 404);
  const created = await api(app, base, { method: 'POST', token, body: { settings: { provider: 'claude', mode: 'decision', scope: { kind: 'section', id: 'technology' } } } });
  assert.equal(created.status, 200);
  assert.deepEqual(created.data.chat.settings, { provider: 'claude', model: '', effort: '', mode: 'decision', web: false, scope: { kind: 'section', id: 'technology' } });
  const chat = created.data.chat.id;
  assert.equal((await api(app, base, { method: 'POST', token, body: { settings: { provider: 'gemini' } } })).status, 400);
  assert.equal((await api(app, `${base}/${chat}`, { method: 'PATCH', token, body: { title: 'Pick a database' } })).data.chat.title, 'Pick a database');
  assert.equal((await api(app, `${base}?q=database`, { token })).data.chats.length, 1);
  assert.equal((await api(app, `${base}/${chat}`, { token })).data.chat.title, 'Pick a database');
  assert.deepEqual((await api(app, `${base}/${chat}`, { method: 'DELETE', token })).data, { removed: true });
  assert.equal((await api(app, `${base}/${chat}`, { token })).status, 404);
  assert.equal(await revision(), before, 'research never writes the blueprint');
});

/** POST a research run and collect its NDJSON events. */
async function run(app, token, originId, chat, body, { signal, onEvent } = {}) {
  const response = await fetch(`${app.url}/api/origin/research/${originId}/chats/${chat}/run`, { method: 'POST', signal, headers: { 'X-STE-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) return { status: response.status, data: await response.json() };
  const events = [], reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines.filter(Boolean)) { const event = JSON.parse(line); if (!event.ping) { events.push(event); onEvent?.(event); } }
    }
  } catch (error) { if (error.name !== 'AbortError') throw error; }
  return { status: response.status, events };
}

test('a chat turn streams events, stores both messages, resumes the CLI session for follow-ups and falls back to history once', async t => {
  const calls = [];
  let mode = 'ok';
  const researchRunner = async call => {
    calls.push({ ...call, signal: undefined, onEvent: undefined });
    if (mode === 'lost' && call.session?.resume) throw Object.assign(new Error('gone'), { code: 'CLI_FAILED', resumeFailed: true });
    call.onEvent({ type: 'activity', kind: 'search', label: 'stripe fees' });
    for (const text of ['Use ', 'Stripe.']) call.onEvent({ type: 'delta', text });
    return { text: 'Use Stripe.', session: call.session?.id || 'thread-x' };
  };
  const app = await startTestServer(t, { port: 0, executor: null, researchRunner });
  const { token } = (await api(app, '/api/session')).data;
  const project = (await api(app, '/api/origin/projects', { method: 'POST', token, body: { name: 'Shop' } })).data.project;
  const settings = { provider: 'claude', mode: 'chat', web: true, scope: { kind: 'project' } };
  const chat = (await api(app, `/api/origin/research/${project.id}/chats`, { method: 'POST', token, body: { settings } })).data.chat.id;

  const first = await run(app, token, project.id, chat, { text: 'Which payment provider?', settings });
  assert.deepEqual(first.events.map(event => event.type), ['message', 'start', 'activity', 'delta', 'delta', 'message', 'done']);
  assert.deepEqual(first.events.filter(event => event.type === 'delta').map(event => [event.agent, event.text]), [['main', 'Use '], ['main', 'Stripe.']]);
  const done = first.events.at(-1).chat;
  assert.deepEqual(done.messages.map(message => [message.role, message.text, message.status]), [['user', 'Which payment provider?', undefined], ['assistant', 'Use Stripe.', 'done']]);
  assert.equal(done.title, 'Which payment provider?');
  assert.equal(calls[0].web, true);
  assert.equal(calls[0].session.resume, false);
  assert.match(calls[0].prompt, /# Rules[\s\S]*Web search is available[\s\S]*<<<BLUEPRINT\n## Project\nShop[\s\S]*\[section vision\][\s\S]*BLUEPRINT>>>[\s\S]*Answer the question about the whole project[\s\S]*# Question\nWhich payment provider\?/);
  assert.equal(done.native.sessionId, calls[0].session.id);

  // A follow-up resumes the same CLI session and sends only the question: no rules, no repeated context.
  await run(app, token, project.id, chat, { text: 'And fees?', settings });
  assert.deepEqual([calls[1].session, calls[1].prompt], [{ id: calls[0].session.id, resume: true }, '# Question\nAnd fees?']);

  // A session that cannot continue: one new session with this chat's history.
  mode = 'lost';
  const third = await run(app, token, project.id, chat, { text: 'Refunds?', settings });
  assert.equal(calls.length, 4);
  assert.equal(calls[3].session.resume, false);
  assert.match(calls[3].prompt, /# Earlier conversation \(data\)\nPerson: Which payment provider\?\n\nAssistant: Use Stripe\.[\s\S]*Person: And fees\?[\s\S]*# Question\nRefunds\?/);
  assert.equal(third.events.find(event => event.type === 'activity' && event.kind === 'note').agent, 'main');
  const stored = (await api(app, `/api/origin/research/${project.id}/chats/${chat}`, { token })).data.chat;
  assert.equal(stored.messages.length, 6);
  assert.equal(stored.native.sessionId, calls[3].session.id);
});

test('stopping a run keeps its partial answer; runs share the one-job slot; invalid runs are refused before it', async t => {
  let release;
  const researchRunner = call => new Promise((resolve, reject) => {
    call.onEvent({ type: 'delta', text: 'Partial findings' });
    call.signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { code: 'ABORTED', partial: 'Partial findings' })), { once: true });
    release = () => resolve({ text: 'Complete.', session: call.session?.id });
  });
  const app = await startTestServer(t, { port: 0, executor: null, researchRunner });
  const { token } = (await api(app, '/api/session')).data;
  const project = (await api(app, '/api/origin/projects', { method: 'POST', token, body: { name: 'Shop' } })).data.project;
  const settings = { provider: 'codex', mode: 'chat' };
  const chat = (await api(app, `/api/origin/research/${project.id}/chats`, { method: 'POST', token, body: { settings } })).data.chat.id;
  assert.equal((await run(app, token, project.id, chat, { text: '', settings })).status, 400, 'a chat needs a question');
  assert.equal((await run(app, token, project.id, chat, { text: 'x', settings: { provider: 'gemini' } })).status, 400);

  const controller = new AbortController();
  const busyCheck = new Promise(resolve => {
    void run(app, token, project.id, chat, { text: 'Long research', settings }, { signal: controller.signal, onEvent: async event => {
      if (event.type !== 'delta') return;
      resolve(await run(app, token, project.id, chat, { text: 'Second', settings }));
      controller.abort();
    } });
  });
  assert.equal((await busyCheck).status, 409, 'a second run waits for the shared job slot');
  let stored;
  for (let i = 0; i < 50; i++) {
    stored = (await api(app, `/api/origin/research/${project.id}/chats/${chat}`, { token })).data.chat;
    if (stored.messages.length === 2) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.deepEqual(stored.messages.map(message => [message.role, message.text, message.status || '']), [['user', 'Long research', ''], ['assistant', 'Partial findings', 'stopped']]);
  assert.equal(release === undefined, false);
});
