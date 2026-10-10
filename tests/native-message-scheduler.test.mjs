import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeMessageScheduler } from '../src/native-message-scheduler.mjs';
import { PipelineJournal } from '../src/pipeline-journal.mjs';
import { PipelineAutomations } from '../src/pipeline-automations.mjs';
import { normalizePipelineAutomations } from '../src/pipeline-config.mjs';
import { customPipelineConfig } from './helpers/pipeline.mjs';

async function fixture(t, { queued = false, count = 1, start = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pb-native-scheduler-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const journal = new PipelineJournal(dir), pipeline = customPipelineConfig(), path = join(dir, 'owned-workspace');
  const rows = normalizePipelineAutomations({ onEnter: Array.from({ length: count }, (_, i) => ({ id: `row-${i}`, name: `Message ${i}`,
    type: 'send_message', enabled: true, mode: 'deferred', message: `Review ${i} {{title}}` })) }).onEnter;
  pipeline.columns.find(row => row.id === 'code_review').automations.onEnter = rows;
  const config = { provider: 'codex', pipeline: true, permissionMode: 'workspace-write', model: '' }, status = queued ? 'queued' : 'running';
  const task = { id: 'task', revision: 2, contentRevision: 1, column: 'code_review', title: 'Literal 雪', prompt: 'Exact task',
    sessionId: 'session', workspace: { path, branch: 'branch' } };
  const project = { id: 'project', name: 'Project', revision: 4, workflowMode: 'pipeline', pipeline, tasks: [task] };
  const run = { id: 'run', taskId: 'task', projectId: 'project', sessionId: 'session', promptRevision: 1, config,
    status, workspacePath: path, branch: 'branch', baseManifest: { resources: [], profiles: [] } };
  const state = { projects: [project], runs: [run], sessions: [{ id: 'session', taskId: 'task', projectId: 'project',
    provider: 'codex', currentRunId: 'run', runIds: ['run'], config, status, workspacePath: path, branch: 'branch' }], base: { revision: 1 }, settings: {} };
  const key = { projectId: 'project', taskId: 'task', transitionId: 'move' };
  const { move } = await journal.beginMove({ ...key, taskRevision: 1, projectRevision: 4,
    from: { id: 'executing', name: 'Executing' }, to: { id: 'code_review', name: 'Code Review' }, onEnter: rows });
  await journal.advance(key); await journal.startLifecycle(key); await journal.finishLifecycle(key, { status: 'succeeded' });
  const writes = [], board = { state: async () => structuredClone(state) };
  let handler = async (_runId, request) => {
    const scope = { dispatchId: request.dispatchId, provider: 'codex', sessionId: 'session', runId: 'run', mode: 'deferred',
      messageHash: createHash('sha256').update(request.message).digest('hex') };
    if (await request.grant(scope) !== true) return { status: 'unconfirmed', confirmed: false };
    writes.push(request.message); assert.equal(await request.submitted(), true); assert.equal(await request.confirmDelivery(), true);
    return { status: 'confirmed', confirmed: true };
  };
  const deliver = handler;
  const supervisor = { sendNativeMessage: (...args) => handler(...args) };
  const scheduler = new NativeMessageScheduler({ board, journal, supervisor });
  t.after(() => scheduler.shutdown());
  if (start) await journal.startAction(key, move.actions[0].id);
  const request = (index = 0) => ({ key, actionId: move.actions[index].id, runId: 'run', mode: 'deferred', message: `Review ${index} Literal 雪`,
    expectedTaskRevision: 2, expectedProjectRevision: 4 });
  return { journal, scheduler, state, task, project, run, key, rows, move, writes, board, supervisor, request, deliver,
    handler: fn => { handler = fn; }, activate: () => { run.status = state.sessions[0].status = 'running'; },
    receipt: async (index = 0) => (await journal.read(key)).actions[index].delivery };
}

test('enter scheduling acknowledges durable intent without waiting for queued startup or blocking placement', async t => {
  const w = await fixture(t, { queued: true });
  assert.deepEqual(await w.scheduler.schedule(w.request()), { scheduled: true, provider: 'codex', sessionId: 'session', runId: 'run' });
  assert.deepEqual(w.writes, []); assert.equal((await w.receipt()).status, 'queued');
  await w.journal.advance(w.key); assert.equal((await w.journal.read(w.key)).status, 'completed');
  w.activate(); assert.equal((await w.scheduler.wait(w.key, w.request().actionId)).confirmed, true);
  assert.deepEqual(w.writes, ['Review 0 Literal 雪']); assert.equal((await w.receipt()).status, 'confirmed');
});

test('the real coordinator renders literal templates, verifies scheduler handoff and finishes later enter rows', async t => {
  const w = await fixture(t, { queued: true, count: 2, start: false });
  const coordinator = new PipelineAutomations({ journal: w.journal,
    scheduleEnterMessage: (request, options) => w.scheduler.schedule({ ...request, runId: 'run' }, options) });
  t.after(() => coordinator.shutdown());
  const result = await coordinator.runGroup({ key: w.key, trigger: 'enter', rows: w.rows, context: { task: w.task, project: w.project } });
  assert.equal(result.safeToAdvance, true); assert.deepEqual(result.outcomes.map(row => row.status), ['scheduled', 'scheduled']);
  await w.journal.advance(w.key); assert.equal((await w.journal.read(w.key)).status, 'completed'); assert.deepEqual(w.writes, []);
  w.activate(); await Promise.all(w.move.actions.map(row => w.scheduler.wait(w.key, row.id)));
  assert.deepEqual(w.writes, ['Review 0 Literal 雪', 'Review 1 Literal 雪']);
});

test('duplicate handoffs share one owner and changed requests cannot alter its literal message', async t => {
  const w = await fixture(t, { queued: true }), request = w.request();
  const first = w.scheduler.schedule(request), duplicate = w.scheduler.schedule(request);
  assert.equal(first, duplicate); await first;
  assert.deepEqual(await w.scheduler.schedule({ ...request, message: 'Changed' }), { scheduled: false });
  w.activate(); assert.equal((await w.scheduler.wait(w.key, request.actionId)).confirmed, true);
  assert.deepEqual(w.writes, [request.message]); assert.equal(w.scheduler.schedule(request), first);
});

test('more than 1000 completed messages do not exhaust active capacity or replay evicted receipts', async t => {
  const w = await fixture(t), template = await w.journal.read(w.key), moves = new Map();
  // Controlled durable-receipt contract for a long-run capacity check. The other
  // scenarios in this file exercise the actual filesystem journal and grants.
  const action = key => moves.get(key.transitionId)?.actions[0];
  const journal = {
    read: async key => structuredClone(moves.get(key.transitionId)),
    scheduleMessage: async (key, _id, scope) => {
      const row = action(key);
      if (row.status !== 'running') return { accepted: false };
      row.status = 'scheduled'; row.delivery = { ...scope, status: 'queued' };
      return { accepted: true, delivery: structuredClone(row.delivery) };
    },
    startMessageDelivery: async key => {
      const row = action(key);
      if (row.delivery.status !== 'queued') return { accepted: false };
      row.delivery.status = 'dispatching'; return { accepted: true, delivery: structuredClone(row.delivery) };
    },
    markMessageSubmitted: async key => { action(key).delivery.status = 'submitted'; return true; },
    finishMessageDelivery: async (key, _id, result) => { action(key).delivery.status = result.status; return true; },
  };
  const scheduler = new NativeMessageScheduler({ board: w.board, journal, supervisor: { sendNativeMessage: w.deliver } });
  t.after(() => scheduler.shutdown());
  let first, firstHandoff;
  for (let i = 0; i < 1001; i++) {
    const key = { ...w.key, transitionId: `long-run-${i}` }, request = { ...w.request(), key };
    moves.set(key.transitionId, { ...structuredClone(template), ...key });
    const handoff = scheduler.schedule(request);
    assert.equal((await handoff).scheduled, true, `Message ${i} must have available capacity.`);
    assert.equal((await scheduler.wait(key, request.actionId)).confirmed, true);
    if (i === 0) { first = request; firstHandoff = handoff; assert.equal(scheduler.schedule(request), firstHandoff); }
  }
  assert.equal(w.writes.length, 1001);
  assert.equal(scheduler.jobs.size, 0);
  assert.equal(scheduler.completed.size, 1000);
  assert.deepEqual(await scheduler.schedule(first), { scheduled: false });
  assert.equal(w.writes.length, 1001, 'The evicted in-memory owner still has a terminal receipt and cannot supply input again.');
});

test('finished uncertain scheduling remains an active owner and cannot be evicted into completed capacity', async t => {
  const w = await fixture(t), schedule = w.journal.scheduleMessage.bind(w.journal);
  w.journal.scheduleMessage = async (...args) => { await schedule(...args); throw new Error('Lost acknowledgement'); };
  assert.deepEqual(await w.scheduler.schedule(w.request()), { scheduled: false });
  assert.equal((await w.scheduler.wait(w.key, w.request().actionId)).blocked, true);
  assert.equal(w.scheduler.jobs.size, 1);
  assert.equal(w.scheduler.completed.size, 0);
  assert.equal(w.scheduler.blockedRuns.has(w.run.id), true);
  assert.equal((await w.receipt()).status, 'queued');
  assert.deepEqual(w.writes, []);
});

test('settings changes while a run is queued cancel the captured target without retargeting or input', async t => {
  const w = await fixture(t, { queued: true }); await w.scheduler.schedule(w.request());
  w.state.base.revision++; w.activate();
  assert.equal((await w.scheduler.wait(w.key, w.request().actionId)).confirmed, false);
  assert.deepEqual(w.writes, []); assert.equal((await w.receipt()).status, 'unconfirmed');
  assert.equal((await w.receipt()).dispatchStartedAt, undefined);
});

test('a content edit between dispatch and the native grant fails before input', async t => {
  const w = await fixture(t);
  w.handler(async (_runId, request) => {
    w.task.prompt += ' changed';
    assert.equal(await request.grant({ dispatchId: request.dispatchId, provider: 'codex', sessionId: 'session', runId: 'run', mode: 'deferred',
      messageHash: createHash('sha256').update(request.message).digest('hex') }), false);
    return { status: 'unconfirmed', confirmed: false };
  });
  await w.scheduler.schedule(w.request()); assert.equal((await w.scheduler.wait(w.key, w.request().actionId)).confirmed, false);
  assert.deepEqual(w.writes, []); assert.equal((await w.receipt()).submittedAt, undefined);
});

test('shutdown cancels queued ownership with durable outcomes and starts no process', async t => {
  const w = await fixture(t, { queued: true }); await w.scheduler.schedule(w.request()); await w.scheduler.shutdown();
  assert.equal((await w.scheduler.wait(w.key, w.request().actionId)).status, 'cancelled');
  assert.equal((await w.receipt()).status, 'cancelled'); assert.deepEqual(w.writes, []); assert.equal(w.run.status, 'queued');
  assert.deepEqual(await w.scheduler.schedule(w.request()), { scheduled: false });
});

test('preparation deadlines bound hanging state reads and cannot resume after a late acknowledgement', async t => {
  const w = await fixture(t), held = Promise.withResolvers(); w.board.state = () => held.promise;
  assert.deepEqual(await w.scheduler.schedule(w.request(), { timeoutMs: 40 }), { scheduled: false });
  assert.equal((await w.scheduler.wait(w.key, w.request().actionId)).status, 'timed_out');
  held.resolve(w.state); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(w.writes, []);
  assert.equal(await w.receipt(), undefined);
});

test('lost scheduling acknowledgement keeps queued intent blocked without cancellation, input or late revival', { timeout: 10000 }, async t => {
  const w = await fixture(t), original = w.journal.scheduleMessage.bind(w.journal), held = Promise.withResolvers(), published = Promise.withResolvers();
  // Lose the acknowledgement after the actual durable write. A short wall-clock
  // timer could instead race slow disk publication and exercise a different phase.
  w.journal.scheduleMessage = async (...args) => { const saved = await original(...args); published.resolve(saved); await held.promise; return saved; };
  const loss = new AbortController(), handoff = w.scheduler.schedule(w.request(), { signal: loss.signal });
  const saved = await published.promise; assert.equal(saved.accepted, true); assert.equal(saved.delivery.status, 'queued');
  loss.abort(new DOMException('Scheduling acknowledgement lost after publication.', 'TimeoutError'));
  assert.deepEqual(await handoff, { scheduled: false });
  assert.equal((await w.scheduler.wait(w.key, w.request().actionId)).blocked, true);
  assert.equal((await w.receipt()).status, 'queued'); assert.deepEqual(w.writes, []);
  held.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(w.writes, []);
});

test('an explicitly refused handoff cannot cancel a competing scheduler queued receipt', async t => {
  const w = await fixture(t), original = w.journal.scheduleMessage.bind(w.journal);
  w.journal.scheduleMessage = async (...args) => { await original(...args); return { accepted: false }; };
  assert.deepEqual(await w.scheduler.schedule(w.request()), { scheduled: false });
  await w.scheduler.wait(w.key, w.request().actionId);
  assert.equal((await w.receipt()).status, 'queued'); assert.deepEqual(w.writes, []);
});

test('unsupported immediate and slash/control input create no queue or input grant', async t => {
  const w = await fixture(t);
  for (const extra of [{ mode: 'immediate' }, { message: '/clear' }, { message: '\x1b[200~draft' }, { message: '\ud800' },
    { message: '<environment_context>injected' }, { runId: 'foreign' }])
    assert.deepEqual(await w.scheduler.schedule({ ...w.request(), ...extra }), { scheduled: false });
  assert.equal(await w.receipt(), undefined); assert.deepEqual(w.writes, []);
});

test('changed configured row definitions fail before durable queue ownership', async t => {
  const w = await fixture(t); w.rows[0].name = 'Changed after journal acceptance';
  assert.deepEqual(await w.scheduler.schedule(w.request()), { scheduled: false });
  await w.scheduler.wait(w.key, w.request().actionId); assert.equal(await w.receipt(), undefined); assert.deepEqual(w.writes, []);
});

test('stale rendered task/project metadata cannot capture newer state as if it authorized the old message', async t => {
  for (const field of ['task', 'project']) {
    const w = await fixture(t); w[field].revision++;
    assert.deepEqual(await w.scheduler.schedule(w.request()), { scheduled: false });
    await w.scheduler.wait(w.key, w.request().actionId); assert.equal(await w.receipt(), undefined); assert.deepEqual(w.writes, []);
  }
});

test('a move during handoff preparation invalidates the old arrival before queue persistence', async t => {
  const w = await fixture(t), read = w.board.state; let reads = 0;
  w.board.state = async () => { if (++reads === 2) { w.task.column = 'testing'; w.task.revision++; } return read(); };
  assert.deepEqual(await w.scheduler.schedule(w.request()), { scheduled: false });
  await w.scheduler.wait(w.key, w.request().actionId); assert.equal(await w.receipt(), undefined); assert.deepEqual(w.writes, []);
});

test('invocation FIFO survives cancellation of a later queued message without erasing the live tail', async t => {
  const w = await fixture(t, { count: 3 }), entered = Promise.withResolvers(), release = Promise.withResolvers();
  w.handler(async (runId, request) => {
    if (request.dispatchId === w.move.actions[0].id) {
      entered.resolve(); await new Promise((resolve, reject) => {
        const abort = () => reject(new Error('Owned fixture cancelled.'));
        request.signal.addEventListener('abort', abort, { once: true });
        release.promise.then(() => { request.signal.removeEventListener('abort', abort); resolve(); });
        if (request.signal.aborted) abort();
      });
    }
    return w.deliver(runId, request);
  });
  try {
    await w.scheduler.schedule(w.request()); await entered.promise;
    await w.journal.startAction(w.key, w.move.actions[1].id); await w.scheduler.schedule(w.request(1));
    await w.journal.startAction(w.key, w.move.actions[2].id); await w.scheduler.schedule(w.request(2));
    assert.equal(w.scheduler.cancel(w.key, w.move.actions[1].id), true);
    assert.equal((await w.scheduler.wait(w.key, w.move.actions[1].id)).status, 'cancelled');
    assert.equal((await w.receipt(1)).status, 'cancelled'); assert.deepEqual(w.writes, []);
    release.resolve(); await Promise.all([w.scheduler.wait(w.key, w.move.actions[0].id), w.scheduler.wait(w.key, w.move.actions[2].id)]);
    assert.deepEqual(w.writes, ['Review 0 Literal 雪', 'Review 2 Literal 雪']);
    assert.equal((await w.receipt(0)).status, 'confirmed'); assert.equal((await w.receipt(2)).status, 'confirmed');
  } finally { release.resolve(); }
});

test('lost queued-outcome acknowledgement blocks later scheduling instead of releasing uncertain ownership', async t => {
  const w = await fixture(t, { queued: true, count: 2 });
  await w.scheduler.schedule(w.request());
  w.journal.finishQueuedMessageDelivery = async () => false;
  w.state.base.revision++; w.activate();
  assert.equal((await w.scheduler.wait(w.key, w.request().actionId)).blocked, true);
  await w.journal.startAction(w.key, w.move.actions[1].id);
  assert.deepEqual(await w.scheduler.schedule(w.request(1)), { scheduled: false });
  assert.deepEqual(w.writes, []); assert.equal((await w.receipt()).status, 'queued');
});


test('long queued startup and busy readiness waits preserve the later native delivery budget', { timeout: 10000 }, async t => {
  const w = await fixture(t, { queued: true }); let ready = false, readinessReads = 0, deliveredBudget = 0, readyAt = 0, deliveredAt = 0;
  w.supervisor.nativeMessageReadiness = async () => { readinessReads++; if (ready) readyAt = performance.now(); return ready ? 'ready' : 'waiting'; };
  w.handler(async (runId, request) => { deliveredAt = performance.now(); deliveredBudget = request.timeoutMs; return w.deliver(runId, request); });
  assert.equal((await w.scheduler.schedule(w.request(), { timeoutMs: 300, waitForReadiness: true })).scheduled, true);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal((await w.receipt()).status, 'queued'); assert.deepEqual(w.writes, []); assert.equal(readinessReads, 0);
  w.activate(); for (const end = Date.now() + 5000; !readinessReads && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(readinessReads > 0); assert.equal((await w.receipt()).status, 'queued'); assert.deepEqual(w.writes, []);
  ready = true;
  assert.equal((await w.scheduler.wait(w.key, w.request().actionId)).confirmed, true);
  assert.ok(readyAt > 0 && deliveredAt >= readyAt);
  assert.ok(deliveredBudget > 0 && deliveredBudget <= 300, 'Native delivery stays within its bounded attempt.');
  // Durable dispatch preparation consumes part of the fresh 300 ms budget.
  // Account for that measured work instead of requiring a particular disk speed.
  assert.ok(deliveredBudget >= 300 - (deliveredAt - readyAt) - 5, 'Queued/busy time is excluded from the fresh native budget.');
  assert.deepEqual(w.writes, [w.request().message]);
});

test('Stop cancels a readiness wait without a native grant, input or replacement process', async t => {
  const w = await fixture(t); let reads = 0;
  w.supervisor.nativeMessageReadiness = async () => { reads++; return 'waiting'; };
  assert.equal((await w.scheduler.schedule(w.request(), { waitForReadiness: true })).scheduled, true);
  for (const end = Date.now() + 5000; !reads && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(w.scheduler.cancel(w.key, w.request().actionId), true);
  assert.equal((await w.scheduler.wait(w.key, w.request().actionId)).status, 'cancelled');
  assert.equal((await w.receipt()).status, 'cancelled'); assert.deepEqual(w.writes, []); assert.equal(w.run.status, 'running');
});

test('a hanging readiness read is bounded and a late ready result cannot revive input', { timeout: 10000 }, async t => {
  const w = await fixture(t), held = Promise.withResolvers(); let reads = 0;
  t.signal.addEventListener('abort', () => held.resolve('ready'), { once: true });
  // Isolate the 150 ms readiness boundary from filesystem publication speed.
  // Other cases retain real durable journals and acknowledgement failures.
  const move = await w.journal.read(w.key), action = move.actions[0];
  w.journal.read = async () => structuredClone(move);
  w.journal.scheduleMessage = async (_key, _id, scope) => {
    assert.equal(action.status, 'running'); action.status = 'scheduled'; action.delivery = { ...scope, status: 'queued' };
    return { accepted: true, delivery: structuredClone(action.delivery) };
  };
  w.journal.finishQueuedMessageDelivery = async (_key, _id, result) => {
    assert.equal(action.delivery.status, 'queued'); action.delivery.status = result.status; return true;
  };
  w.supervisor.nativeMessageReadiness = () => { reads++; return held.promise; };
  assert.equal((await w.scheduler.schedule(w.request(), { timeoutMs: 150, waitForReadiness: true })).scheduled, true);
  assert.equal((await w.scheduler.wait(w.key, w.request().actionId)).status, 'timed_out');
  assert.equal(reads, 1); assert.equal((await w.receipt()).status, 'timed_out'); assert.deepEqual(w.writes, []);
  held.resolve('ready'); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(w.writes, []);
});

test('unavailable or malformed native readiness ends the queued intent without terminal input', async t => {
  for (const result of ['unavailable', 'unknown', { status: 'ready' }]) {
    const w = await fixture(t); w.supervisor.nativeMessageReadiness = async () => result;
    assert.equal((await w.scheduler.schedule(w.request(), { waitForReadiness: true })).scheduled, true);
    assert.equal((await w.scheduler.wait(w.key, w.request().actionId)).confirmed, false);
    assert.equal((await w.receipt()).status, 'unconfirmed'); assert.deepEqual(w.writes, []);
  }
});

test('FIFO readiness waits outlive the input budget and cancelling a later message preserves the earlier owner', async t => {
  const w = await fixture(t, { count: 2 }); let ready = false;
  w.supervisor.nativeMessageReadiness = async () => ready ? 'ready' : 'waiting';
  assert.equal((await w.scheduler.schedule(w.request(0), { timeoutMs: 300, waitForReadiness: true })).scheduled, true);
  await w.journal.startAction(w.key, w.move.actions[1].id);
  assert.equal((await w.scheduler.schedule(w.request(1), { timeoutMs: 300, waitForReadiness: true })).scheduled, true);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal((await w.receipt(0)).status, 'queued'); assert.equal((await w.receipt(1)).status, 'queued'); assert.deepEqual(w.writes, []);
  assert.equal(w.scheduler.cancel(w.key, w.move.actions[1].id), true);
  assert.equal((await w.scheduler.wait(w.key, w.move.actions[1].id)).status, 'cancelled');
  assert.equal((await w.receipt(0)).status, 'queued'); ready = true;
  assert.equal((await w.scheduler.wait(w.key, w.move.actions[0].id)).confirmed, true);
  assert.deepEqual(w.writes, [w.request(0).message]);
});

test('a Base registry change during readiness waiting ends the captured queue without retargeting', async t => {
  const w = await fixture(t); let reads = 0;
  w.supervisor.nativeMessageReadiness = async () => { reads++; return 'waiting'; };
  assert.equal((await w.scheduler.schedule(w.request(), { waitForReadiness: true })).scheduled, true);
  for (const end = Date.now() + 5000; !reads && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 5));
  w.state.base.revision++;
  assert.equal((await w.scheduler.wait(w.key, w.request().actionId)).confirmed, false);
  assert.equal((await w.receipt()).status, 'unconfirmed'); assert.deepEqual(w.writes, []);
});

test('state reads remain bounded after accepted readiness handoff and cannot revive a timed-out queue', async t => {
  const w = await fixture(t), held = Promise.withResolvers();
  w.supervisor.nativeMessageReadiness = async () => 'ready';
  assert.equal((await w.scheduler.schedule(w.request(), { timeoutMs: 150, waitForReadiness: true })).scheduled, true);
  w.board.state = () => held.promise;
  assert.equal((await w.scheduler.wait(w.key, w.request().actionId)).status, 'timed_out');
  assert.equal((await w.receipt()).status, 'timed_out'); assert.deepEqual(w.writes, []);
  held.resolve(structuredClone(w.state)); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(w.writes, []);
});
