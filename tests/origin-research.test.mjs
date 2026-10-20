import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  assert.deepEqual(settingsOf({ provider: 'codex', model: 'gpt-5.5', effort: 'low', mode: 'swarm', web: true, scope: { kind: 'section', id: 'security' }, targets: [{ kind: 'section', id: 'data' }] }),
    { provider: 'codex', model: 'gpt-5.5', effort: 'low', mode: 'swarm', web: true, skills: false, scope: { kind: 'section', id: 'security' }, targets: [{ kind: 'section', id: 'data' }] });
  assert.equal(settingsOf({ provider: 'claude', skills: true }).skills, true, 'Claude Code skills only when asked for');
  assert.equal(settingsOf({ provider: 'codex', skills: true }).skills, false, 'only Claude Code offers skills');
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
  assert.deepEqual(created.data.chat.settings, { provider: 'claude', model: '', effort: '', mode: 'decision', web: false, skills: false, scope: { kind: 'section', id: 'technology' } });
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

test('swarm: one independent agent per part, at most three at a time; one stopped and one failed agent keep the others; a summary without an extra model call', async t => {
  const prompts = [];
  let active = 0, peak = 0;
  const researchRunner = async call => {
    prompts.push(call);
    active++; peak = Math.max(peak, active);
    try {
      call.onEvent({ type: 'delta', text: 'Working' });
      if (call.prompt.includes('[section security]') && call.prompt.includes('## Focus: this section\n[section security]')) {
        await new Promise((resolve, reject) => call.signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { code: 'ABORTED', partial: 'Partial security notes' })), { once: true }));
      }
      await new Promise(resolve => setTimeout(resolve, 80));
      if (call.prompt.includes('## Focus: this section\n[section testing]')) throw Object.assign(new Error('limit'), { code: 'RATE_LIMITED' });
      return { text: `Findings for ${call.prompt.match(/## Focus: this section\n\[section (\w+)\]/)[1]}` };
    } finally { active--; }
  };
  const app = await startTestServer(t, { port: 0, executor: null, researchRunner });
  const { token } = (await api(app, '/api/session')).data;
  const project = (await api(app, '/api/origin/projects', { method: 'POST', token, body: { name: 'Shop' } })).data.project;
  const targets = ['architecture', 'security', 'testing', 'deployment', 'data'].map(id => ({ kind: 'section', id }));
  const settings = { provider: 'codex', mode: 'swarm', targets };
  const chat = (await api(app, `/api/origin/research/${project.id}/chats`, { method: 'POST', token, body: { settings } })).data.chat.id;
  const result = await run(app, token, project.id, chat, { text: 'Find gaps', settings }, { onEvent: event => {
    if (event.type === 'agent' && event.status === 'running' && event.agent === 'a2') setTimeout(() => void fetch(`${app.url}/api/origin/research/${project.id}/chats/${chat}/agents/a2/stop`, { method: 'POST', headers: { 'X-STE-Token': token } }), 30);
  } });
  assert.equal(peak, 3, 'three agents at the same time, the rest wait');
  assert.equal(prompts.length, 5, 'one model call per agent and none to combine');
  for (const [index, id] of targets.map(target => target.id).entries()) {
    const own = prompts.find(call => call.prompt.includes(`## Focus: this section\n[section ${id}]`));
    assert.ok(own, id);
    assert.match(own.prompt, /# Mode: swarm research[\s\S]*# What the person wants to find out\nFind gaps/);
    assert.ok(!own.prompt.includes('Findings for'), `agent ${index + 1} never sees another agent’s results`);
    assert.equal(own.persist, false, 'swarm agents leave no CLI session behind');
  }
  const start = result.events.find(event => event.type === 'start');
  assert.deepEqual(start.agents.map(agent => [agent.id, agent.status]), [['a1', 'queued'], ['a2', 'queued'], ['a3', 'queued'], ['a4', 'queued'], ['a5', 'queued']]);
  const finals = result.events.filter(event => event.type === 'agent' && event.status !== 'running').map(event => [event.agent, event.status]);
  assert.deepEqual(Object.fromEntries(finals), { a1: 'done', a2: 'stopped', a3: 'failed', a4: 'done', a5: 'done' });
  const chatAfter = result.events.at(-1).chat;
  const agentMessages = chatAfter.messages.filter(message => message.role === 'agent');
  assert.equal(agentMessages.length, 5);
  assert.equal(agentMessages.find(message => message.agent.id === 'a2').text, 'Partial security notes');
  assert.equal(agentMessages.find(message => message.agent.id === 'a3').error.code, 'RATE_LIMITED');
  const summary = chatAfter.messages.at(-1);
  assert.equal(summary.summary, true);
  assert.match(summary.text, /3 of 5 agents finished\.[\s\S]*✓ \*\*Architecture\*\*: finished/);
  assert.match(summary.text, /■ \*\*Security\*\*: stopped[\s\S]*✗ \*\*Testing\*\*: failed \(The provider is temporarily limiting/);
  assert.equal((await api(app, `/api/origin/research/${project.id}/chats/${chat}/agents/a1/stop`, { method: 'POST', token })).status, 409, 'nothing to stop after the run');
});

test('Decision Lab and Blueprint Audit use their own instructions; a mode switch in a resumed session says so; swarm parts are validated', async t => {
  const prompts = [];
  const researchRunner = async call => { prompts.push(call.prompt); return { text: 'Done.', session: call.session?.id || 'thread-1' }; };
  const app = await startTestServer(t, { port: 0, executor: null, researchRunner });
  const { token } = (await api(app, '/api/session')).data;
  const project = (await api(app, '/api/origin/projects', { method: 'POST', token, body: { name: 'Shop' } })).data.project;
  const create = async settings => (await api(app, `/api/origin/research/${project.id}/chats`, { method: 'POST', token, body: { settings } })).data.chat.id;
  const decision = { provider: 'claude', mode: 'decision', scope: { kind: 'section', id: 'technology' } };
  const lab = await create(decision);
  await run(app, token, project.id, lab, { text: 'PostgreSQL vs MongoDB', settings: decision });
  assert.match(prompts[0], /# Mode: Decision Lab[\s\S]*suitability for this project, complexity, performance, security, maturity, maintenance, licensing, cost[\s\S]*Do not change a requirement[\s\S]*# Question\nPostgreSQL vs MongoDB/);
  // The same CLI session continues in another mode: the follow-up carries the new mode's instructions.
  await run(app, token, project.id, lab, { text: '', settings: { ...decision, mode: 'audit' } });
  assert.match(prompts[1], /^# Mode: Blueprint Audit[\s\S]*# Request\nAudit this part of the blueprint\.$/);
  // Origin's own checks start once the project has content.
  const saved = (await api(app, `/api/origin/projects/${project.id}`, { token })).data;
  await api(app, `/api/origin/projects/${project.id}`, { method: 'PUT', token, body: { expectedRevision: saved.revision, blueprint: { ...saved.blueprint, idea: 'An online shop' } } });
  const audit = await create({ provider: 'codex', mode: 'audit' });
  await run(app, token, project.id, audit, { text: '', settings: { provider: 'codex', mode: 'audit' } });
  assert.match(prompts[2], /## Open points found by Origin’s checks[\s\S]*# Mode: Blueprint Audit[\s\S]*missing building blocks, incompatible technologies/);
  for (const targets of [[], Array.from({ length: 9 }, (_, i) => ({ kind: 'section', id: `s${i}` })), [{ kind: 'section', id: 'data' }, { kind: 'section', id: 'data' }]]) {
    assert.equal((await run(app, token, project.id, audit, { text: '', settings: { provider: 'codex', mode: 'swarm', targets } })).status, 400, JSON.stringify(targets).slice(0, 60));
  }
});

test('Stop through the server: the run ends, its partial answer is stored and the stream reports it before closing', async t => {
  const researchRunner = call => new Promise((resolve, reject) => {
    call.onEvent({ type: 'delta', text: 'Partial' });
    call.signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { code: 'ABORTED', partial: 'Partial' })), { once: true });
  });
  const app = await startTestServer(t, { port: 0, executor: null, researchRunner });
  const { token } = (await api(app, '/api/session')).data;
  const project = (await api(app, '/api/origin/projects', { method: 'POST', token, body: { name: 'Shop' } })).data.project;
  const settings = { provider: 'claude', mode: 'chat' };
  const chat = (await api(app, `/api/origin/research/${project.id}/chats`, { method: 'POST', token, body: { settings } })).data.chat.id;
  assert.equal((await api(app, `/api/origin/research/${project.id}/chats/${chat}/stop`, { method: 'POST', token })).status, 409, 'nothing to stop yet');
  const result = await run(app, token, project.id, chat, { text: 'Research', settings }, { onEvent: event => {
    if (event.type === 'delta') void api(app, `/api/origin/research/${project.id}/chats/${chat}/stop`, { method: 'POST', token });
  } });
  const answer = result.events.find(event => event.type === 'message' && event.message.role === 'assistant').message;
  assert.deepEqual([answer.text, answer.status], ['Partial', 'stopped']);
  assert.equal(result.events.at(-1).type, 'done', 'the stream ends normally with the stored chat');
});

test('at the suggestion cap a chat drops decided suggestions before the ones still waiting for a decision', async t => {
  const dir = await folder(t), store = new ResearchStore(dir);
  const chat = await store.create('p1', { provider: 'claude' });
  const proposal = (n, status) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, status, title: `S${n}`, target: { kind: 'idea' }, value: '' });
  await store.update('p1', chat.id, value => { value.proposals.push(...Array.from({ length: 300 }, (_, n) => proposal(n, n < 10 ? 'pending' : 'applied'))); });
  const updated = await store.update('p1', chat.id, value => { value.proposals.push(...Array.from({ length: 5 }, (_, n) => proposal(1000 + n, 'pending'))); });
  assert.equal(updated.proposals.length, 300);
  assert.equal(updated.proposals.filter(entry => entry.status === 'pending').length, 15, 'every open suggestion is kept');
});

test('deleting a chat while it researches stops its CLI first; the stream ends without an error', async t => {
  let started, stopped = false;
  const running = new Promise(resolve => { started = resolve; });
  const researchRunner = call => new Promise((resolve, reject) => {
    call.onEvent({ type: 'delta', text: 'Partial' }); started();
    call.signal.addEventListener('abort', () => { stopped = true; reject(Object.assign(new Error('stopped'), { code: 'ABORTED', partial: 'Partial' })); }, { once: true });
  });
  const app = await startTestServer(t, { port: 0, executor: null, researchRunner });
  const { token } = (await api(app, '/api/session')).data;
  const project = (await api(app, '/api/origin/projects', { method: 'POST', token, body: { name: 'Shop' } })).data.project;
  const settings = { provider: 'claude', mode: 'chat' }, base = `/api/origin/research/${project.id}/chats`;
  const chat = (await api(app, base, { method: 'POST', token, body: { settings } })).data.chat.id;
  const result = run(app, token, project.id, chat, { text: 'Research', settings });
  await running;
  assert.deepEqual((await api(app, `${base}/${chat}`, { method: 'DELETE', token })).data, { removed: true });
  assert.equal(stopped, true, 'the CLI was stopped');
  const { events } = await result;
  assert.ok(!events.some(event => event.type === 'error'), JSON.stringify(events.at(-1)));
  assert.equal((await api(app, `${base}/${chat}`, { token })).status, 404);
  assert.equal((await api(app, `${base}/${chat}/stop`, { method: 'POST', token })).status, 409, 'nothing runs any more');
});

test('a swarm whose results cannot be stored stops its other agents before the job slot is free', async t => {
  let active = 0, chat;
  const researchRunner = async call => {
    active++;
    try {
      // The first agent to finish finds its chat gone (removed outside the app), so its result cannot be stored.
      if (call.prompt.includes('## Focus: this section\n[section security]')) { await rm(join(dirname(call.cwd), `${chat}.json`), { force: true }); return { text: 'Done first.' }; }
      await new Promise((resolve, reject) => call.signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { code: 'ABORTED' })), { once: true }));
    } finally { active--; }
  };
  const app = await startTestServer(t, { port: 0, executor: null, researchRunner });
  const { token } = (await api(app, '/api/session')).data;
  const project = (await api(app, '/api/origin/projects', { method: 'POST', token, body: { name: 'Shop' } })).data.project;
  const settings = { provider: 'codex', mode: 'swarm', targets: ['architecture', 'security', 'testing'].map(id => ({ kind: 'section', id })) };
  chat = (await api(app, `/api/origin/research/${project.id}/chats`, { method: 'POST', token, body: { settings } })).data.chat.id;
  const result = await run(app, token, project.id, chat, { text: 'Find gaps', settings });
  assert.equal(result.events.at(-1).type, 'error');
  assert.equal(active, 0, 'no agent is still running once the run has ended');
});
