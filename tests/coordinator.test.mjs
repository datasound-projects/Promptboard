import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Board } from '../src/board.mjs';
import { Coordinator, coordinatorRoute } from '../src/coordinator.mjs';
import { OriginStore } from '../src/origin.mjs';

async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'pb-coordinator-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
const SECRET_SPEC = 'Exact engineered card specification that must never be copied into the index.';

async function world(t) {
  const dataDir = await temp(t), board = new Board({ dataDir });
  const project = await board.createProject({ name: 'Shop', workflowMode: 'pipeline' });
  const other = await board.createProject({ name: 'Blog', workflowMode: 'pipeline' });
  const card = await board.createTask({ projectId: project.id, title: 'Checkout flow', prompt: SECRET_SPEC });
  const second = await board.createTask({ projectId: project.id, title: 'Search page', prompt: 'Search spec' });
  const foreign = await board.createTask({ projectId: other.id, title: 'Blog editor', prompt: 'Blog spec' });
  const calls = [];
  const runner = async call => { calls.push(call); return { text: `Checkout is in progress [T${card.number}] and the agent failed once [run:${(await board.state()).runs[0]?.id.slice(0, 8) || 'none0000'}]. Unknown [T999].` }; };
  return { dataDir, board, project, other, card, second, foreign, calls, runner, coordinator: new Coordinator({ dataDir, board }) };
}
const file = (dataDir, id) => join(dataDir, 'coordinator', `${id.replace(/[A-Z_]/g, c => `_${c === '_' ? '_' : c.toLowerCase()}`)}.json.gz`);
const index = async (dataDir, id) => JSON.parse(gunzipSync(await readFile(file(dataDir, id))).toString('utf8'));

test('the index keeps references and facts, not card specifications, and never calls a model on its own', async t => {
  const { dataDir, board, project, card, calls, coordinator } = await world(t);
  await board.store.update(draft => { draft.runs.push({ id: 'run-aaaa1111', taskId: card.id, projectId: project.id, stage: 'executing', status: 'failed', reason: 'quota', createdAt: Date.now() - 5000, startedAt: Date.now() - 5000, config: { provider: 'codex' } }); });
  const view = await coordinator.view(project.id);
  assert.equal(view.enabled, true);
  assert.deepEqual(view.columns.find(column => column.role === 'todo').count, 2);
  assert.ok(view.blockers.some(blocker => blocker.kind === 'failed' && blocker.taskId === card.id && /quota/.test(blocker.text)));
  assert.ok(view.recent.some(event => event.kind === 'run' && event.run === 'run-aaaa1111'));
  const stored = await index(dataDir, project.id);
  assert.equal(stored.tasks[card.id].title, 'Checkout flow'); assert.equal(stored.tasks[card.id].lastRun, 'run-aaaa1111');
  assert.equal(JSON.stringify(stored).includes(SECRET_SPEC), false, 'Kanban stays the source of the specification');
  assert.ok((await readdir(join(dataDir, 'coordinator'))).every(name => name.endsWith('.json.gz') || name.endsWith('.bak')), 'stored compressed');
  // Repeated views read the same index; events keep one entry per source ID.
  await coordinator.reconcile(project.id, { force: true }); await coordinator.reconcile(project.id, { force: true });
  const again = await index(dataDir, project.id);
  assert.equal(new Set(again.events.map(event => event.id)).size, again.events.length);
  assert.equal(calls.length, 0, 'zero model calls without a question');
});

test('turned off, it records nothing; turned on, it reconciles missed changes with their times; it survives a restart', async t => {
  const { dataDir, board, project, card, second, calls, runner, coordinator } = await world(t);
  await coordinator.view(project.id);
  const off = await coordinator.setEnabled(project.id, false);
  assert.equal(off.enabled, false); assert.equal(off.columns, undefined);
  const missedAt = Date.now();
  await board.transition(second.id, { column: 'planning', expectedRevision: second.revision, decision: 'move' });
  await assert.rejects(coordinator.ask(project.id, { question: 'Status?', provider: 'codex' }, { runner }), { code: 'COORDINATOR_OFF' });
  assert.equal((await index(dataDir, project.id)).events.some(event => event.task === second.id && event.kind === 'moved'), false, 'nothing recorded while off');
  // A restart in between: the knowledge is on disk.
  const restarted = new Coordinator({ dataDir, board });
  assert.equal((await restarted.view(project.id)).enabled, false);
  const on = await restarted.setEnabled(project.id, true);
  assert.equal(on.enabled, true);
  const moved = (await index(dataDir, project.id)).events.find(event => event.task === second.id && event.kind === 'moved');
  assert.ok(moved, 'the missed move is reconciled'); assert.ok(moved.at >= missedAt && moved.at <= Date.now());
  assert.ok((await index(dataDir, project.id)).tasks[card.id], 'earlier knowledge kept');
  assert.equal(calls.length, 0);
});

test('chat is read-only, scoped, cached and isolated per project', async t => {
  const { board, project, other, card, foreign, calls, runner, coordinator } = await world(t);
  await board.store.update(draft => { draft.runs.push({ id: 'run-bbbb2222', taskId: card.id, projectId: project.id, stage: 'executing', status: 'failed', reason: 'tests broke', createdAt: Date.now(), startedAt: Date.now(), config: { provider: 'codex' } }); });
  const before = JSON.stringify(await board.state());
  // A task question reads that card's own text; a project question does not include card texts.
  const answer = await coordinator.ask(project.id, { question: 'What happened to checkout?', scope: { kind: 'task', id: card.id }, provider: 'codex' }, { runner });
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /read-only/); assert.ok(calls[0].prompt.includes(SECRET_SPEC)); assert.equal(calls[0].prompt.includes('Search spec'), false);
  assert.equal(calls[0].prompt.includes('Blog'), false, 'another project never leaks in');
  assert.deepEqual(answer.refs.map(ref => ref.ref).sort(), [`T${card.number}`, 'run:run-bbbb'].sort(), 'only references that exist in the evidence become links');
  assert.equal(answer.refs.find(ref => ref.kind === 'task').taskId, card.id);
  // The same question on the same evidence is answered from the cache.
  const cached = await coordinator.ask(project.id, { question: 'what happened to checkout?', scope: { kind: 'task', id: card.id }, provider: 'codex' }, { runner });
  assert.equal(cached.cached, true); assert.equal(calls.length, 1);
  await coordinator.ask(project.id, { question: 'What is the overall progress?', provider: 'codex' }, { runner });
  assert.equal(calls[1].prompt.includes(SECRET_SPEC), false, 'a project question does not copy card texts');
  assert.equal(JSON.stringify(await board.state()), before, 'asking changes nothing on the board');
  // Questions about another project's card are refused; chats stay apart.
  await assert.rejects(coordinator.ask(project.id, { question: 'And this?', scope: { kind: 'task', id: foreign.id }, provider: 'codex' }, { runner }), { code: 'NOT_FOUND' });
  assert.equal((await coordinator.view(project.id)).chat.length, 6);
  assert.equal((await coordinator.view(other.id)).chat.length, 0);
  // Design questions add Origin names only when asked.
  assert.equal(calls[1].prompt.includes('Origin'), false);
});

test('a question whose client left while the job slot was claimed is cancelled, not left running', async () => {
  // The close event fired before the route could listen for it; only res.destroyed records it.
  const res = Object.assign(new EventEmitter(), { destroyed: true, writableEnded: false }), job = { controller: new AbortController() };
  let aborted = null, released = false;
  await coordinatorRoute({ coordinator: { ask: async (_, __, { signal }) => { aborted = signal.aborted; return {}; } }, runner: async () => ({}), track: work => work,
    claim: async () => ({ job, release: () => { released = true; } }), req: { method: 'POST' }, res, pathname: '/api/coordinator/p1/ask',
    jsonBody: async () => ({ question: 'Where is checkout?', provider: 'codex' }), send: () => {} });
  assert.equal(aborted, true);
  assert.equal(released, true);
});

test('an index that exists but cannot be read is reported as such, never replaced by empty knowledge', async t => {
  const { dataDir, project, coordinator } = await world(t);
  await mkdir(file(dataDir, project.id), { recursive: true });
  await assert.rejects(coordinator.view(project.id), error => error.code !== 'COORDINATOR_WRITE_FAILED');
  assert.ok((await stat(file(dataDir, project.id))).isDirectory());
});

test('a deleted card, an unknown project, another board’s design and a reused board ID never leak in', async t => {
  const { dataDir, board, project, other, card, calls, runner } = await world(t);
  const origin = new OriginStore(dataDir), coordinator = new Coordinator({ dataDir, board, origin });
  // An agent run whose card was deleted (runs are kept) is a clear "not found", not a crash.
  await board.store.update(draft => { draft.runs.push({ id: 'run-cccc3333', taskId: 'deleted-card', projectId: project.id, stage: 'executing', status: 'failed', createdAt: Date.now(), config: { provider: 'codex' } }); });
  await assert.rejects(coordinator.ask(project.id, { question: 'What happened?', scope: { kind: 'agent', id: 'run-cccc3333' }, provider: 'codex' }, { runner }), { code: 'NOT_FOUND', status: 404 });
  // Turning a project that does not exist on or off writes nothing.
  await assert.rejects(coordinator.setEnabled('no-such-project', false), { code: 'NOT_FOUND' });
  assert.equal((await readdir(join(dataDir, 'coordinator')).catch(() => [])).some(name => name.startsWith('no-such')), false);
  // An Origin project with this board's ID that is linked to another board is that board's design.
  await origin.create({ name: 'Blog design', id: project.id, kanbanProjectId: other.id });
  await coordinator.ask(project.id, { question: 'Which design decision applies?', provider: 'codex' }, { runner });
  assert.match(calls.at(-1).prompt, /this project has no Origin blueprint/); assert.equal(calls.at(-1).prompt.includes('Blog design'), false);
  await coordinator.ask(other.id, { question: 'Which design decision applies?', provider: 'codex' }, { runner });
  assert.match(calls.at(-1).prompt, /Origin blueprint “Blog design”/);
  // A new board that reuses a deleted board's ID starts with its own knowledge and chat.
  assert.ok((await coordinator.view(project.id)).chat.length > 0);
  await board.store.update(draft => { draft.runs = draft.runs.filter(run => run.projectId !== project.id); });
  await board.deleteProject(project.id, { expectedRevision: (await board.state()).projects.find(entry => entry.id === project.id).revision });
  await new Promise(resolve => setTimeout(resolve, 5));
  const reborn = await board.createProject({ name: 'New shop', workflowMode: 'pipeline', id: project.id });
  const fresh = await coordinator.view(project.id);
  assert.equal(fresh.chat.length, 0); assert.equal(fresh.recent.some(event => event.task === card.id), false);
  assert.ok(fresh.knowledge.since >= reborn.createdAt);
});
