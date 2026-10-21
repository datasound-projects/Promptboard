import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Board } from '../src/board.mjs';
import { Coordinator, coordinatorRoute, noPaths } from '../src/coordinator.mjs';
import { OriginStore } from '../src/origin.mjs';
import { commandOnPath, removeOwnedTempDirsSync } from '../src/providers.mjs';

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
  await board.store.update(draft => { draft.runs.push({ id: 'run-aaaa1111', taskId: card.id, projectId: project.id, stage: 'executing', status: 'failed', reason: 'The quota ran out.', createdAt: Date.now() - 5000, startedAt: Date.now() - 5000, config: { provider: 'codex' } }); });
  const view = await coordinator.view(project.id);
  assert.equal(view.enabled, true);
  assert.deepEqual(view.columns.find(column => column.role === 'todo').count, 2);
  assert.ok(view.blockers.some(blocker => blocker.kind === 'failed' && blocker.taskId === card.id && blocker.text === 'The agent run failed: The quota ran out.'));
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
  assert.equal(moved.at, (await board.state()).projects.find(item => item.id === project.id).tasks.find(task => task.id === second.id).transitions.at(-1).at, 'with its original time');
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
  // One call in an empty temporary folder, removed afterwards, also when the call fails.
  assert.match(calls[0].cwd, /pb-coordinator-/); await assert.rejects(stat(calls[0].cwd), { code: 'ENOENT' });
  let failedIn = '';
  await assert.rejects(coordinator.ask(project.id, { question: 'Fails?', provider: 'codex' }, { runner: async call => {
    failedIn = call.cwd; assert.deepEqual(await readdir(call.cwd), []);
    // A forced exit (a second Ctrl+C) removes the app's own temporary folders; this is one of them.
    removeOwnedTempDirsSync(); await assert.rejects(stat(call.cwd), { code: 'ENOENT' });
    throw new Error('quota');
  } }), /quota/);
  await assert.rejects(stat(failedIn), { code: 'ENOENT' });
  // The same question on the same evidence is answered from the cache.
  const cached = await coordinator.ask(project.id, { question: 'what happened to checkout?', scope: { kind: 'task', id: card.id }, provider: 'codex' }, { runner });
  assert.equal(cached.cached, true); assert.equal(calls.length, 1);
  await coordinator.ask(project.id, { question: 'What is the overall progress?', provider: 'codex' }, { runner });
  assert.equal(calls[1].prompt.includes(SECRET_SPEC), false, 'a project question does not copy card texts');
  assert.match(calls[1].prompt, /Repository: not linked · target branch not set\./, 'the repository is named, never a local path');
  assert.equal(JSON.stringify(await board.state()), before, 'asking changes nothing on the board');
  // Questions about another project's card are refused; chats stay apart.
  await assert.rejects(coordinator.ask(project.id, { question: 'And this?', scope: { kind: 'task', id: foreign.id }, provider: 'codex' }, { runner }), { code: 'NOT_FOUND' });
  // Antigravity cannot run without tools, so it never answers.
  await assert.rejects(coordinator.ask(project.id, { question: 'Status?', provider: 'agy' }, { runner }), { code: 'INVALID_INPUT', message: /without tools/ });
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

test('closed or off, it starts no timer, reads no Git and calls no model; the same board gives byte-identical knowledge', { skip: process.platform === 'win32' }, async t => {
  // Spies: a `git` on PATH that logs every call, the global timers, and the runner.
  const real = await commandOnPath('git'), shim = await temp(t), log = join(shim, 'calls.log');
  await writeFile(join(shim, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const path = process.env.PATH; process.env.PATH = `${shim}${delimiter}${path}`; t.after(() => { process.env.PATH = path; });
  const gitReads = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(line => line.startsWith('log --no-merges')).length;
  const root = await realpath(await temp(t)), sh = (...args) => execFileSync(real, args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  sh('init', '-q', '-b', 'trunk'); sh('config', 'user.email', 't@e'); sh('config', 'user.name', 'T');
  await writeFile(join(root, 'a.txt'), '1\n'); sh('add', '.'); sh('commit', '-q', '-m', 'init');
  const before = sh('rev-parse', 'HEAD'); await writeFile(join(root, 'a.txt'), '2\n'); sh('commit', '-q', '-am', 'Add the parser'); const after = sh('rev-parse', 'HEAD');
  const dataDir = await temp(t), board = new Board({ dataDir }), calls = [], runner = async call => { calls.push(call); return { text: 'Done.' }; };
  const project = await board.createProject({ name: 'Shop' });
  await board.linkRepository(project.id, { path: root, expectedRevision: 1 });
  const task = await board.createTask({ projectId: project.id, title: 'Parser', prompt: 'Build it.' });
  await board.moveTask(task.id, { column: 'executing', expectedRevision: 1 });
  await board.completeTask(task.id, { kind: 'merged', details: { targetBranch: 'trunk', previousTarget: before, mergedCommit: after, method: 'fast-forward', commits: 1, trigger: 'user' } });
  const coordinator = new Coordinator({ dataDir, board });
  assert.equal(await gitReads(), 0, 'never viewed: nothing is read');
  await coordinator.view(project.id);
  assert.equal(await gitReads(), 1, 'viewing reads the task commits once');
  assert.ok((await index(dataDir, project.id)).events.some(event => event.kind === 'commit' && event.commit === after));
  const bytes = await readFile(file(dataDir, project.id));
  await coordinator.view(project.id); await coordinator.reconcile(project.id, { force: true });
  assert.equal(await gitReads(), 2, 'a view within 5 s reads nothing; a forced update reads again');
  assert.ok(bytes.equals(await readFile(file(dataDir, project.id))), 'the same board gives byte-identical knowledge');
  await coordinator.setEnabled(project.id, false);
  const reads = await gitReads(), timers = [], saved = { setTimeout, setInterval, setImmediate };
  for (const name of Object.keys(saved)) globalThis[name] = (...args) => { timers.push(name); return saved[name](...args); };
  try {
    for (let n = 0; n < 3; n++) await coordinator.view(project.id);
    await assert.rejects(coordinator.ask(project.id, { question: 'Status?', provider: 'codex' }, { runner }), { code: 'COORDINATOR_OFF' });
  } finally { Object.assign(globalThis, saved); }
  assert.deepEqual([await gitReads() - reads, timers, calls.length], [0, [], 0], 'off: no Git read, no timer, no model call');
});

test('the index holds what the board still has: deleted cards and notes leave it, and a full index stays unchanged', async t => {
  const { dataDir, board, project, card, second, calls, runner, coordinator } = await world(t);
  const note = await board.addTimelineNote(project.id, { title: 'Private plan', text: 'Ship on Friday.', at: Date.now() });
  await coordinator.view(project.id);
  assert.ok((await index(dataDir, project.id)).events.some(event => event.id === `note:${note.id}`));
  await board.deleteTimelineNote(project.id, note.id);
  await board.deleteTask(second.id, { expectedRevision: second.revision });
  await coordinator.reconcile(project.id, { force: true });
  const kept = await index(dataDir, project.id);
  assert.equal(kept.events.some(event => event.id === `note:${note.id}` || event.task === second.id), false, 'a deleted note or card is not kept');
  assert.ok(kept.events.some(event => event.task === card.id));
  assert.equal((await coordinator.view(project.id)).recent.some(event => event.task === second.id), false);
  await coordinator.ask(project.id, { question: 'Any plans?', provider: 'codex' }, { runner });
  assert.equal(calls.at(-1).prompt.includes('Private plan'), false, 'a deleted note never reaches the model');
  // More events than the index keeps: the oldest stay out, and an unchanged board changes nothing.
  await board.store.update(draft => { for (let n = 0; n < 3100; n++) draft.runs.push({ id: `run-${String(n).padStart(6, '0')}`, taskId: card.id, projectId: project.id, stage: 'executing', status: 'succeeded', createdAt: n + 1, startedAt: n + 1, endedAt: n + 2, config: { provider: 'codex' } }); });
  await coordinator.reconcile(project.id, { force: true });
  const full = await readFile(file(dataDir, project.id)), stored = await index(dataDir, project.id);
  assert.equal(stored.events.length, 3000);
  assert.deepEqual(await coordinator.reconcile(project.id, { force: true }).then(({ added, updated }) => [added, updated]), [0, 0]);
  assert.ok(full.equals(await readFile(file(dataDir, project.id))), 'no new snapshot for an unchanged board');
});

test('moves keep their identity past the board’s 100-move history; positional IDs saved by earlier versions are replaced, not doubled', async t => {
  const { dataDir, board, project, card, coordinator } = await world(t);
  const moves = n => Array.from({ length: n }, (_, i) => ({ at: 1_700_000_000_000 + i * 1000, from: i % 2 ? 'planning' : 'todo', to: i % 2 ? 'todo' : 'planning', by: 'user' }));
  const setMoves = list => board.store.update(draft => { draft.projects.find(item => item.id === project.id).tasks.find(task => task.id === card.id).transitions = list; });
  const moved = async () => (await index(dataDir, project.id)).events.filter(event => event.task === card.id && event.kind === 'moved');
  await setMoves(moves(100)); await coordinator.reconcile(project.id, { force: true });
  // An index from an earlier version keyed these moves by their place in the history: move:<card>:<n>.
  const old = await index(dataDir, project.id); let n = 0;
  for (const event of old.events) if (event.task === card.id && event.kind === 'moved') event.id = `move:${card.id}:${n++}`;
  await writeFile(file(dataDir, project.id), gzipSync(JSON.stringify(old)));
  await coordinator.reconcile(project.id, { force: true });
  assert.deepEqual([(await moved()).length, (await moved()).filter(event => /:\d{1,3}$/.test(event.id)).length], [100, 0], 'replaced under stable IDs, never kept twice');
  // Five more moves: the board keeps its newest 100, the index all 105, each once with its own time.
  await setMoves(moves(105).slice(-100)); await coordinator.reconcile(project.id, { force: true });
  const all = await moved();
  assert.deepEqual([all.length, new Set(all.map(event => event.at)).size, new Set(all.map(event => event.id)).size], [105, 105, 105]);
});

test('a damaged index or chat is kept aside, never overwritten by the next saves', async t => {
  const { dataDir, project, runner, coordinator } = await world(t);
  const chat = file(dataDir, project.id).replace(/\.json\.gz$/, '.chat.json.gz');
  await mkdir(join(dataDir, 'coordinator'), { recursive: true });
  await writeFile(file(dataDir, project.id), 'not gzip'); await writeFile(chat, 'damaged chat');
  assert.equal((await coordinator.view(project.id)).enabled, true, 'the knowledge is rebuilt from the board');
  for (const question of ['First?', 'Second?']) await coordinator.ask(project.id, { question, provider: 'codex' }, { runner });
  const names = await readdir(join(dataDir, 'coordinator')), kept = await Promise.all(names.filter(name => name.includes('.corrupt-')).map(name => readFile(join(dataDir, 'coordinator', name), 'utf8')));
  assert.deepEqual(kept.sort(), ['damaged chat', 'not gzip']);
  assert.equal((await coordinator.view(project.id)).chat.length, 4);
});

test('evidence and answers are bounded', async t => {
  const { board, project, calls, coordinator } = await world(t);
  await board.store.update(draft => {
    const target = draft.projects.find(item => item.id === project.id);
    for (let n = 0; n < 60; n++) {
      const id = `bulk-${n}`;
      target.tasks.push({ ...target.tasks[0], id, number: 100 + n, title: `Bulk ${n}`, prompt: '', evidence: { tests: { id: `t${n}`, status: 'failed', endedAt: Date.now() } } });
    }
  });
  const long = `${'Line [T1].\n'.repeat(4000)}`;
  const result = await coordinator.ask(project.id, { question: 'What is blocked?', provider: 'codex' }, { runner: async call => { calls.push(call); return { text: long }; } });
  assert.ok(calls[0].prompt.split('\n').filter(line => line.includes('The tests failed.')).length <= 40, 'at most 40 blockers');
  assert.ok(result.answer.length <= 20000 && result.answer.includes('\n'), 'the stored answer is clipped, its lines kept');
  assert.equal((await coordinator.view(project.id)).chat.at(-1).text, result.answer);
});

test('local folder paths in event details never reach the model; their last name does', async t => {
  const { board, project, calls, coordinator } = await world(t);
  await board.store.update(draft => {
    const target = draft.projects.find(item => item.id === project.id);
    target.tasks[0].completion = { kind: 'merged', at: Date.now(), targetBranch: 'main', commits: 1, method: 'squash commit, fast-forward in /Users/someone/Secret/app', mergedCommit: 'a'.repeat(40) };
  });
  await coordinator.ask(project.id, { question: 'What was merged?', provider: 'codex' }, { runner: async call => { calls.push(call); return { text: 'Merged [T1].' }; } });
  const prompt = calls.at(-1).prompt;
  assert.equal(prompt.includes('/Users/someone'), false, 'no absolute local path');
  assert.match(prompt, /fast-forward in …\/app/, 'the folder name stays');
  // Also after "=" and in file:// links; web addresses and paths inside the repository stay as they are.
  assert.equal(noPaths('run with --cwd=/Users/alice/secret/app and open file:///Users/alice/secret/app/index.html'), 'run with --cwd=…/app and open file://…/index.html');
  assert.equal(noPaths('C:\\Users\\bob\\shop, ROOT=D:\\work\\shop'), '…/shop, ROOT=…/shop');
  assert.equal(noPaths('https://github.com/acme/shop/pull/7 changed src/cart/total.js'), 'https://github.com/acme/shop/pull/7 changed src/cart/total.js');
});
