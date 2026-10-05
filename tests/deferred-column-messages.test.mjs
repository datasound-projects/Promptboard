import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile, readFile, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, emptyState, migrateState } from '../src/store.mjs';
import { Board } from '../src/board.mjs';
import { defaultPipelineConfig } from '../src/pipeline-config.mjs';
import { resolveConfig } from '../src/agents.mjs';
import { PipelineActions } from '../src/pipeline-actions.mjs';
import { pipelineTaskEnvelope } from '../src/pipeline-templates.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } });
async function temp(t) { const path = await realpath(await mkdtemp(join(tmpdir(), 'pb-column-message-')));
  t.after(() => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return path; }
async function until(check) { for (const end = Date.now() + 10000;;) { const value = await check(); if (value) return value;
  if (Date.now() >= end) assert.fail('The column-message fixture did not settle.'); await new Promise(resolve => setTimeout(resolve, 20)); } }
const messageRow = (id, message = 'Review {{taskNumber}} {{title}}') => ({ id, name: id, type: 'send_message', enabled: true, mode: 'deferred', message });

async function world(t, configure = () => {}) {
  const dataDir = await temp(t), root = await temp(t), events = [], starts = [], writes = [], stops = [];
  git(root, 'init', '-q', '-b', 'trunk'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(root, 'README.md'), 'Disposable repository\n'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'Fixture');
  const board = new Board({ dataDir, automationActions: new PipelineActions({ notifier: async () => { events.push('notify'); return { confirmed: true }; } }) });
  t.after(() => board.shutdownAutomations());
  const config = defaultPipelineConfig(); for (const column of config.columns) if (column.role === 'active') column.strategy.agentOverride = 'claude';
  config.columns.find(row => row.id === 'code_review').automations.onEnter = [messageRow('review')]; configure(config);
  let handler;
  const deliver = async (runId, request) => {
    const run = await board.run(runId), scope = { dispatchId: request.dispatchId, provider: run.config.provider, sessionId: run.sessionId,
      runId, mode: request.mode, messageHash: createHash('sha256').update(request.message).digest('hex') };
    if (await request.grant(scope) !== true) return { status: 'unconfirmed', confirmed: false };
    writes.push({ runId, message: request.message }); events.push('message');
    assert.equal(await request.submitted(), true); assert.equal(await request.confirmDelivery(), true);
    return { status: 'confirmed', confirmed: true };
  };
  handler = deliver;
  board.executor = {
    validate: async ({ stage, config }) => resolveConfig(stage, config),
    start: async payload => { starts.push(payload); events.push('start'); await board.updateRun(payload.run.id,
      { status: 'running', providerSessionId: payload.run.resumeFrom?.nativeSessionId || 'native-fixture' }); },
    cancel: async id => { board.abortAutomationTask((await board.run(id)).taskId); stops.push(id); await board.updateRun(id, { status: 'cancelled' }); },
    suspend: async id => { board.abortAutomationTask((await board.run(id)).taskId); stops.push(id); await board.updateRun(id, { status: 'suspended' }); },
    sendNativeMessage: (...args) => handler(...args),
  };
  const project = await board.createProject({ name: 'Configured messages' });
  await board.linkRepository(project.id, { path: root, expectedRevision: 1 }); await board.setTargetBranch(project.id, { branch: 'trunk', expectedRevision: 2 });
  await board.setPipeline(project.id, { pipeline: config, expectedRevision: 3, confirm: true });
  const prompt = '  Exact Composer {{taskNumber}}\r\n雪  ';
  const task = await board.createTask({ projectId: project.id, title: 'Split task', prompt });
  const taskNow = async () => (await board.state()).projects.find(row => row.id === project.id).tasks.find(row => row.id === task.id);
  const move = async (column, extra = {}) => board.transition(task.id, { column, expectedRevision: (await taskNow()).revision, ...extra });
  const receipts = () => board.automationRuns(task.id);
  const settled = () => until(async () => !(await taskNow()).pendingAutomationMessages?.length);
  return { board, dataDir, root, project, task, config, prompt, starts, writes, stops, events, deliver, taskNow, move, receipts, settled,
    handle: fn => { handler = fn; } };
}

test('configured Review/Testing/Merge enter messages retain one run and preserve exact Composer first input', async t => {
  const w = await world(t, config => {
    config.columns.find(row => row.id === 'testing').automations.onEnter = [messageRow('test', 'Test {{taskNumber}}')];
    config.columns.find(row => row.id === 'merge').automations.onEnter = [messageRow('ship', 'Ship {{taskNumber}}')];
  });
  assert.equal(w.starts.length, 0); assert.equal((await w.board.state()).runs.length, 0);
  const start = await w.move('executing');
  for (const column of ['code_review', 'testing', 'merge']) {
    const result = await w.move(column); assert.equal(result.continuedRunId, start.run.id);
    assert.equal(result.automationMove.status, 'completed'); await w.settled();
  }
  assert.equal(w.starts.length, 1); assert.equal(w.starts[0].firstPrompt, pipelineTaskEnvelope(w.task));
  assert.deepEqual(w.writes, ['Review #1 Split task', 'Test #1', 'Ship #1'].map(message => ({ runId: start.run.id, message })));
  assert.equal((await w.taskNow()).prompt, w.prompt); assert.equal(git(w.root, 'status', '--porcelain').trim(), '');
  assert.ok((await w.receipts()).every(move => move.actions[0].delivery.status === 'confirmed'));
});

test('label assignments and shared recoloring preserve a pending column message and its exact live target', async t => {
  const w = await world(t); let ready = false, observed = 0;
  w.board.executor.nativeMessageReadiness = () => { observed++; return ready ? 'ready' : 'waiting'; };
  const initialProject = (await w.board.state()).projects.find(row => row.id === w.project.id);
  await w.board.setLabels(w.project.id, { labels: [{ id: 'bug', name: 'Bug', color: '#c93451' }], expectedLabelRevision: 0 });
  const start = await w.move('executing'), move = await w.move('code_review');
  await until(() => observed > 0);
  assert.deepEqual(w.writes, []); assert.equal((await w.receipts()).at(-1).actions[0].delivery.status, 'queued');
  const before = await w.taskNow();
  const edit = await w.board.updateTask(w.task.id, { labelIds: ['bug'], expectedLabelRevision: 1, expectedRevision: before.revision });
  assert.equal(edit.task.contentRevision, before.contentRevision); assert.equal(edit.task.prompt, w.prompt);
  await w.board.setLabels(w.project.id, { labels: [{ id: 'bug', name: 'Fix 雪', color: '#abcdef' }], expectedLabelRevision: 1 });
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal((await w.receipts()).at(-1).actions[0].delivery.status, 'queued');
  assert.equal((await w.board.state()).projects[0].revision, initialProject.revision);
  ready = true; await w.settled();
  assert.equal((await w.receipts()).at(-1).actions[0].delivery.status, 'confirmed');
  assert.deepEqual(w.writes, [{ runId: start.run.id, message: 'Review #1 Split task' }]);
  assert.equal(move.continuedRunId, start.run.id); assert.equal(w.starts.length, 1); assert.deepEqual(w.stops, []);
  assert.equal(w.starts[0].firstPrompt, pipelineTaskEnvelope(w.task)); assert.equal(git(w.root, 'status', '--porcelain').trim(), '');
});

test('a fresh queued agent starts after all enter rows while message placement completes before native input', async t => {
  const w = await world(t, config => { config.columns.find(row => row.id === 'executing').automations.onEnter = [messageRow('execute', 'Continue {{title}}'),
    { id: 'notify', name: 'Notify', type: 'notify', enabled: true, title: 'Arrived', body: 'Task' }]; });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  w.handle(async (runId, request) => { entered.resolve(); await release.promise; return w.deliver(runId, request); });
  try {
    const result = await w.move('executing'); await entered.promise;
    assert.equal(result.automationMove.status, 'completed'); assert.deepEqual(w.events, ['notify', 'start']); assert.deepEqual(w.writes, []);
    assert.equal((await w.taskNow()).pendingAutomationMessages.length, 1);
    release.resolve(); await w.settled(); assert.equal(w.writes[0].message, 'Continue Split task');
  } finally { release.resolve(); }
});

test('compatible moves retain queued messages in FIFO while pending references survive a history window change', async t => {
  const w = await world(t, config => { config.columns.find(row => row.id === 'testing').automations.onEnter = [messageRow('test', 'Then test')]; });
  await w.move('executing'); const entered = Promise.withResolvers(), release = Promise.withResolvers(); let first = true;
  w.handle(async (runId, request) => { if (first) { first = false; entered.resolve(); await release.promise; } return w.deliver(runId, request); });
  try {
    const review = await w.move('code_review'); await entered.promise; const testing = await w.move('testing');
    assert.equal(testing.continuedRunId, review.continuedRunId); assert.deepEqual(w.writes, []);
    await w.board.store.update(state => { const task = state.projects.find(row => row.id === w.project.id).tasks.find(row => row.id === w.task.id);
      task.automationMoves = task.automationMoves.filter(key => key.transitionId !== review.automationMove.transitionId); });
    assert.equal((await w.receipts()).length, 2); assert.equal((await w.taskNow()).pendingAutomationMessages.length, 2);
    release.resolve(); await w.settled(); assert.deepEqual(w.writes.map(row => row.message), ['Review #1 Split task', 'Then test']);
    assert.equal(w.starts.length, 1);
  } finally { release.resolve(); }
});

test('Stop after completed placement cancels only message delivery and leaves the task agent running', async t => {
  const w = await world(t); await w.move('executing'); const entered = Promise.withResolvers();
  w.handle(async (_runId, request) => { entered.resolve(); await new Promise(resolve => {
    request.signal.addEventListener('abort', resolve, { once: true }); if (request.signal.aborted) resolve();
  }); return { status: 'cancelled', confirmed: false }; });
  const result = await w.move('code_review'); await entered.promise;
  await w.board.cancelAutomationMove(w.task.id, { confirm: true }); await w.settled();
  assert.deepEqual(w.writes, []); assert.deepEqual(w.stops, []);
  assert.equal((await w.board.run(result.continuedRunId)).status, 'running');
  assert.equal((await w.receipts()).at(-1).actions[0].delivery.status, 'cancelled'); assert.equal((await w.taskNow()).column, 'code_review');
});

test('To Do cancels pending delivery, stops the owned run and resets its session without deleting files', async t => {
  const w = await world(t); await w.move('executing'); const entered = Promise.withResolvers();
  w.handle(async (_runId, request) => { entered.resolve(); await new Promise(resolve => {
    request.signal.addEventListener('abort', resolve, { once: true }); if (request.signal.aborted) resolve();
  }); return { status: 'cancelled', confirmed: false }; });
  await w.move('code_review'); await entered.promise; const moved = await w.move('todo'); await w.settled();
  assert.equal(moved.task.sessionId, null); assert.equal(moved.task.column, 'todo'); assert.equal(w.stops.length, 1);
  assert.deepEqual(w.writes, []); assert.equal((await w.taskNow()).workspace.status, 'ready');
  assert.equal((await w.receipts()).at(-1).actions[0].delivery.status, 'cancelled');
});

test('Done suspends context and restoration skips message rows while retaining other enter actions', async t => {
  const w = await world(t, config => { config.columns.find(row => row.id === 'code_review').automations.onEnter.push(
    { id: 'notify', name: 'Notify', type: 'notify', enabled: true, title: 'Restored', body: 'Task' }); });
  const start = await w.move('executing'); await w.move('code_review'); await w.settled();
  const done = await w.move('done'); assert.equal(done.task.sessionId, start.run.sessionId); assert.ok(done.task.archivedAt);
  const restored = await w.move('code_review'); await w.settled(); assert.equal(restored.run.sessionId, start.run.sessionId);
  assert.equal(restored.run.resumeFrom.nativeSessionId, 'native-fixture'); assert.equal(w.writes.length, 1);
  assert.deepEqual(restored.automationMove.actions.map(row => row.status), ['skipped', 'succeeded']); assert.equal(w.events.filter(row => row === 'notify').length, 2);
});

test('a manual destination with no agent skips messages rather than starting a task or inventing a target', async t => {
  const w = await world(t, config => { config.columns.find(row => row.id === 'code_review').strategy.autoSpawn = false; });
  const moved = await w.move('code_review'); assert.equal(moved.automationMove.actions[0].status, 'skipped');
  assert.equal(w.starts.length, 0); assert.deepEqual(w.writes, []); assert.equal((await w.taskNow()).sessionId, undefined);
});

test('failure to publish the recovery reference records a failed handoff without supplying native input or wedging placement', async t => {
  const w = await world(t); await w.move('executing'); const update = w.board.store.update.bind(w.board.store);
  w.board.store.update = fn => update(state => { const result = fn(state); if (state.projects.some(project => project.tasks.some(task => task.pendingAutomationMessages?.length)))
    throw new Error('PRIVATE recovery-reference publication failure'); return result; });
  const moved = await w.move('code_review'); assert.equal(moved.automationMove.status, 'completed');
  assert.equal(moved.automationMove.actions[0].status, 'failed'); assert.equal(moved.automationMove.actions[0].delivery, undefined);
  assert.deepEqual(w.writes, []); assert.equal(w.starts.length, 1); assert.doesNotMatch(JSON.stringify(moved.automationMove), /PRIVATE/);
});

test('a task content edit cancels and awaits outstanding input before publishing the new card text', async t => {
  const w = await world(t); await w.move('executing'); const entered = Promise.withResolvers();
  w.handle(async (_runId, request) => { entered.resolve(); await new Promise(resolve => {
    request.signal.addEventListener('abort', resolve, { once: true }); if (request.signal.aborted) resolve();
  }); assert.equal((await w.taskNow()).prompt, w.prompt); return { status: 'cancelled', confirmed: false }; });
  await w.move('code_review'); await entered.promise;
  await w.board.updateTask(w.task.id, { expectedRevision: (await w.taskNow()).revision, prompt: 'New exact prompt' });
  await w.settled(); assert.equal((await w.taskNow()).prompt, 'New exact prompt'); assert.deepEqual(w.writes, []);
  assert.equal((await w.receipts()).at(-1).actions[0].delivery.status, 'cancelled');
});


test('v7 migration keeps exact identities and extensions with an original byte-for-byte backup', async t => {
  const dir = await temp(t), original = { ...emptyState(), version: 7, revision: 27, extension: { retained: true },
    projects: [{ id: 'p', name: 'Saved', nextTaskNumber: 51, tasks: [{ id: 't', number: 40, column: 'todo',
      prompt: '  Exact\r\n雪', revision: 9, extension: { saved: true } }] }] };
  const bytes = JSON.stringify(original, null, 3); await writeFile(join(dir, 'state.json'), bytes);
  const store = new Store(dir), saved = await store.read();
  assert.equal(saved.version, 13); assert.equal(saved.revision, 27); assert.deepEqual(saved.projects, original.projects.map(project => ({ ...project, labels: [], labelRevision: 0, backlog: [], backlogRevision: 0, backlogSources: [], backlogImported: [], backlogImportRevision: 0, tasks: project.tasks.map(task => ({ ...task, priority: 0, labelIds: [] })) })));
  assert.deepEqual(saved.extension, original.extension); assert.deepEqual(saved.migrations.map(row => row.kind), ['state-v7-to-v8', 'state-v8-to-v9', 'state-v9-to-v10', 'state-v10-to-v11', 'state-v11-to-v12', 'state-v12-to-v13']);
  assert.equal(await readFile(join(dir, store.recovery.migrationBackup), 'utf8'), bytes);
  assert.deepEqual(await new Store(dir).read(), saved);
});

test('v8 pending references reject cross-task, duplicate, excessive and executable metadata; newer state stays untouched', async t => {
  const original = { ...emptyState(), projects: [{ id: 'p', nextTaskNumber: 2, labels: [], labelRevision: 0, backlog: [], backlogRevision: 0, backlogSources: [], backlogImported: [], backlogImportRevision: 0, tasks: [{ id: 't', number: 1, column: 'todo', labelIds: [] }] }] };
  const key = { projectId: 'p', taskId: 't', transitionId: 'owned' };
  for (const references of [[{ ...key, taskId: 'other' }], [{ ...key, projectId: 'other' }], [key, key],
    [{ ...key, message: 'Never executable in state' }], [{ ...key, transitionId: '../outside' }],
    Array.from({ length: 1001 }, (_, index) => ({ ...key, transitionId: 'id-' + index }))]) {
    const state = structuredClone(original); state.projects[0].tasks[0].pendingAutomationMessages = references;
    assert.throws(() => migrateState(state), /Invalid pending message references/);
  }
  const dir = await temp(t), bytes = JSON.stringify({ ...original, version: 14 }); await writeFile(join(dir, 'state.json'), bytes);
  await assert.rejects(new Store(dir).read(), { code: 'STATE_VERSION_UNSUPPORTED' });
  assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), bytes); assert.deepEqual(await readdir(dir), ['state.json']);
});

test('restart recovers a completed placement pending message outside the history window without replay', async t => {
  const w = await world(t); await w.move('executing'); const entered = Promise.withResolvers();
  w.handle(async (_runId, request) => { entered.resolve(); await new Promise(resolve => {
    request.signal.addEventListener('abort', resolve, { once: true }); if (request.signal.aborted) resolve();
  }); return { status: 'cancelled', confirmed: false }; });
  await w.move('code_review'); await entered.promise;
  const state = structuredClone(await w.board.state()), move = structuredClone((await w.receipts()).at(-1));
  const task = state.projects[0].tasks[0]; task.automationMoves = []; delete task.automationMove;
  // Clone a dead owner's durable state, never mutate a live application's files.
  move.ownerPid = 2147483647;
  const dir = await temp(t), folder = join(dir, 'automations', createHash('sha256').update(JSON.stringify([move.projectId, move.taskId, move.transitionId])).digest('hex'));
  await mkdir(folder, { recursive: true });
  for (let index = 0; index <= move.revision; index++) await writeFile(join(folder, String(index).padStart(8, '0') + '.json'), JSON.stringify({ ...move, revision: index }));
  await writeFile(join(dir, 'state.json'), JSON.stringify(state));
  const restored = new Board({ dataDir: dir, executor: { start() { assert.fail('Recovery must not start a CLI'); }, sendNativeMessage() { assert.fail('Recovery must not replay input'); } } });
  const saved = await restored.state(); assert.deepEqual(saved.projects[0].tasks[0].pendingAutomationMessages, []);
  assert.equal(saved.projects[0].tasks[0].column, 'code_review'); assert.equal(saved.runs[0].status, 'interrupted');
  const receipt = await restored.automationJournal.read(move); assert.equal(receipt.status, 'completed');
  assert.equal(receipt.actions[0].delivery.status, 'interrupted');
  assert.doesNotMatch(JSON.stringify(await restored.exportBackup()), /pendingAutomationMessages|ownerPid|dispatchId/);
});
