import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { PipelineJournal } from '../src/pipeline-journal.mjs';
import { PipelineActions } from '../src/pipeline-actions.mjs';
import { PipelineAutomations } from '../src/pipeline-automations.mjs';

const row = (id, fields = {}) => ({ id, name: id, type: 'notify', ...fields });
const move = (transitionId = 'move', taskId = 'task', fields = {}) => ({ projectId: 'project', taskId, transitionId, from: { id: 'from', name: 'From' }, to: { id: 'to', name: 'To' }, taskRevision: 2, projectRevision: 1, ...fields });
const metadata = key => ({ task: { id: key.taskId, title: '{{unknown}} "& PRIVATE TITLE', prompt: 'Exact task prompt' }, project: { id: key.projectId, name: 'Project' }, move: { column: 'From', fromColumn: 'From', toColumn: 'To' } });
async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'pb-automations-')); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return dir; }
async function fixture(t, input = move(), options = {}) {
  const journal = new PipelineJournal(await temp(t)); await journal.beginMove(input);
  const runner = new PipelineAutomations({ journal, ...options }); t.after(() => runner.shutdown());
  return { journal, runner, key: input, context: metadata(input) };
}
async function enter(journal, key) { await journal.advance(key); await journal.startLifecycle(key); await journal.finishLifecycle(key, { status: 'succeeded' }); }
async function until(fn) { const end = Date.now() + 5000; while (!await fn()) { if (Date.now() > end) assert.fail('Coordinator fixture did not become ready.'); await new Promise(resolve => setTimeout(resolve, 10)); } }

test('ordered groups persist each start before transport and keep failed exit rows from blocking the lifecycle', async t => {
  const input = move('ordered', 'task', { onExit: [row('disabled', { enabled: false }), row('bad'), row('good')], onEnter: [row('hook', { type: 'webhook', url: 'https://example.test/' })] });
  let journal; const seen = [], progress = [];
  const actions = new PipelineActions({ notifier: async value => {
    const state = await journal.read(input), action = state.actions.find(action => action.id === value.id);
    assert.equal(action.status, 'running'); seen.push(action.rowId); if (action.rowId === 'bad') throw new Error('PRIVATE DIAGNOSTIC'); return { confirmed: true };
  }, fetcher: async (_url, options) => {
    const state = await journal.read(input), action = state.actions.find(action => action.id === options.headers.get('Idempotency-Key'));
    assert.equal(action.status, 'running'); assert.equal(action.attempts.length, 1); seen.push(action.rowId); return new Response(null, { status: 204 });
  } });
  const ctx = await fixture(t, input, { actions }); journal = ctx.journal;
  const exit = await ctx.runner.runGroup({ ...ctx, trigger: 'exit', rows: input.onExit, onProgress: value => progress.push(value.name) });
  assert.equal(exit.safeToAdvance, true); assert.deepEqual(exit.outcomes.map(action => action.status), ['skipped', 'failed', 'succeeded']); assert.doesNotMatch(JSON.stringify(exit.outcomes), /PRIVATE DIAGNOSTIC/);
  await enter(journal, input); const arrival = await ctx.runner.runGroup({ ...ctx, trigger: 'enter', rows: input.onEnter });
  assert.equal(arrival.safeToAdvance, true); await journal.advance(input); assert.equal((await journal.read(input)).status, 'completed');
  assert.deepEqual(seen, ['bad', 'good', 'hook']); assert.deepEqual(progress, ['bad', 'good']);
});

test('active duplicate groups share one promise; completed requests do not execute again or authorize advancing', async t => {
  let release, calls = 0; const held = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const input = move('duplicate', 'task', { onExit: [row('held')] }), actions = new PipelineActions({ notifier: async () => { calls++; await held; return { confirmed: true }; } });
  const ctx = await fixture(t, input, { actions }), request = { ...ctx, trigger: 'exit', rows: input.onExit };
  const first = ctx.runner.runGroup(request), second = ctx.runner.runGroup({ ...request, rows: [] }); assert.equal(first, second);
  await until(() => calls === 1); await assert.rejects(ctx.runner.runGroup({ ...request, key: { ...input, transitionId: 'different' } }), { code: 'AUTOMATION_GROUP_ACTIVE' });
  release(); await first; const replay = await ctx.runner.runGroup(request); assert.equal(replay.duplicate, true); assert.equal(replay.safeToAdvance, false); assert.equal(calls, 1);
});

test('changed definitions and incorrect phase fail before any action starts; unsupported messages fail before mixed effects', async t => {
  let calls = 0; const input = move('guards', 'task', { onExit: [row('effect')], onEnter: [row('message', { type: 'send_message', message: 'Never send' })] });
  const ctx = await fixture(t, input, { actions: new PipelineActions({ notifier: () => { calls++; return { confirmed: true }; } }) });
  await assert.rejects(ctx.runner.runGroup({ ...ctx, trigger: 'exit', rows: [row('effect', { title: 'Edited' })] }), { code: 'AUTOMATION_CONFIG_CHANGED' });
  await assert.rejects(ctx.runner.runGroup({ ...ctx, trigger: 'enter', rows: input.onEnter }), { code: 'MESSAGE_SCHEDULER_REQUIRED' });
  assert.equal(calls, 0); assert.equal((await ctx.journal.read(input)).actions[0].status, 'pending');
  const withReceiver = new PipelineAutomations({ journal: ctx.journal, deliverMessage: () => ({ confirmed: true }) }); t.after(() => withReceiver.shutdown());
  await assert.rejects(withReceiver.runGroup({ ...ctx, trigger: 'enter', rows: input.onEnter }), { code: 'AUTOMATION_GROUP_ORDER' });
});

test('one total exit budget stops a hung callback and skips later rows while enter groups keep their own per-row budget', async t => {
  const input = move('budget', 'task', { onExit: [row('hung'), row('never')], onEnter: [row('enter')] }), seen = [];
  const ctx = await fixture(t, input, { actions: new PipelineActions({ notifier: value => { seen.push(value.id); return value.title === 'Enter' ? { confirmed: true } : new Promise(() => {}); } }) });
  const result = await ctx.runner.runGroup({ ...ctx, trigger: 'exit', rows: input.onExit, exitBudgetMs: 1000 });
  assert.equal(result.safeToAdvance, true); assert.equal(result.cancelled, false); assert.deepEqual(result.outcomes.map(action => action.status), ['timed_out', 'skipped']); assert.equal(seen.length, 1);
  await enter(ctx.journal, input);
  // Input definitions are fixed by the move; receiver acknowledgement can vary by group.
  ctx.runner.actions.notifier = () => ({ confirmed: true });
  const arrived = await ctx.runner.runGroup({ ...ctx, trigger: 'enter', rows: input.onEnter, exitBudgetMs: 1 }); assert.equal(arrived.outcomes[0].status, 'succeeded');
});

test('cancellation stops only the selected task and skips its remaining effects; shutdown cancels the other owned task', async t => {
  const journal = new PipelineJournal(await temp(t)), a = move('cancel-a', 'a', { onExit: [row('one'), row('two')] }), b = move('cancel-b', 'b', { onExit: [row('other')] });
  await journal.beginMove(a); await journal.beginMove(b);
  const actions = new PipelineActions({ notifier: () => new Promise(() => {}) }), runner = new PipelineAutomations({ journal, actions }); t.after(() => runner.shutdown());
  const pa = runner.runGroup({ key: a, context: metadata(a), trigger: 'exit', rows: a.onExit });
  const pb = runner.runGroup({ key: b, context: metadata(b), trigger: 'exit', rows: b.onExit });
  await until(() => actions.jobs.size === 2); assert.equal(runner.cancel(a), true); const stopped = await pa;
  assert.equal(stopped.cancelled, true); assert.equal(stopped.safeToAdvance, false); assert.deepEqual(stopped.outcomes.map(action => action.status), ['cancelled', 'skipped']);
  assert.equal((await journal.read(b)).actions[0].status, 'running'); await runner.shutdown(); assert.equal((await pb).cancelled, true);
  await assert.rejects(runner.runGroup({ key: a, trigger: 'exit', rows: a.onExit }), { code: 'AUTOMATION_SHUTTING_DOWN' });
});

test('manual columns and restoration skip messages while scripts/webhooks/notifications remain eligible', async t => {
  for (const suppressed of [false, true]) {
    const input = move(`skip-${suppressed}`, 'task', { onEnter: [row('message', { type: 'send_message', message: 'Do not send' }), row('notify')] });
    let calls = 0; const ctx = await fixture(t, input, { actions: new PipelineActions({ notifier: () => { calls++; return { confirmed: true }; } }) }); await enter(ctx.journal, input);
    const result = await ctx.runner.runGroup({ ...ctx, trigger: 'enter', rows: input.onEnter, canMessage: suppressed, suppressMessages: suppressed });
    assert.deepEqual(result.outcomes.map(action => action.status), ['skipped', 'succeeded']); assert.equal(calls, 1);
  }
});

test('message callbacks preserve literal text/mode and require explicit delivery confirmation', async t => {
  for (const confirmed of [true, false]) {
    const input = move(`message-${confirmed}`, 'task', { onEnter: [row('message', { type: 'send_message', message: 'Review {{title}} {{unknown}}', mode: 'deferred' })] }), seen = [];
    const ctx = await fixture(t, input, { deliverMessage: async (value, { signal }) => { signal.throwIfAborted(); seen.push(value); return { confirmed }; } }); await enter(ctx.journal, input);
    const result = await ctx.runner.runGroup({ ...ctx, trigger: 'enter', rows: input.onEnter });
    assert.equal(result.outcomes[0].status, confirmed ? 'succeeded' : 'unconfirmed'); assert.equal(seen[0].message, `Review ${ctx.context.task.title} {{unknown}}`); assert.equal(seen[0].mode, 'deferred'); assert.equal(seen[0].trigger, 'enter');
    assert.equal(seen[0].actionId, result.outcomes[0].id);
  }
});

test('hung or cancelled message acknowledgement never invents success, including a late acknowledgement', async t => {
  let release; const held = new Promise(resolve => { release = resolve; }); t.after(() => release({ confirmed: true }));
  const input = move('message-timeout', 'task', { onEnter: [row('message', { type: 'send_message', message: 'Hello' })] }), ctx = await fixture(t, input, { deliverMessage: () => held }); await enter(ctx.journal, input);
  const result = await ctx.runner.runGroup({ ...ctx, trigger: 'enter', rows: input.onEnter, messageTimeoutMs: 100 }); assert.equal(result.outcomes[0].status, 'timed_out');
  release({ confirmed: true }); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal((await ctx.journal.read(input)).actions[0].status, 'timed_out');
});

test('lost outcome persistence refuses partial group replay rather than repeating effects or starting later rows', async t => {
  const input = move('save-failure', 'task', { onExit: [row('first'), row('unknown'), row('never')] }); let calls = 0;
  const ctx = await fixture(t, input, { actions: new PipelineActions({ notifier: () => { calls++; return { confirmed: true }; } }) });
  const finish = ctx.journal.finishAction.bind(ctx.journal), saved = await ctx.journal.read(input);
  ctx.journal.finishAction = (key, actionId, result) => actionId === saved.actions[1].id ? Promise.reject(new Error('PRIVATE WRITE ERROR')) : finish(key, actionId, result);
  await assert.rejects(ctx.runner.runGroup({ ...ctx, trigger: 'exit', rows: input.onExit })); assert.equal(calls, 2);
  assert.deepEqual((await ctx.journal.read(input)).actions.map(action => action.status), ['succeeded', 'running', 'pending']);
  await assert.rejects(ctx.runner.runGroup({ ...ctx, trigger: 'exit', rows: input.onExit }), { code: 'AUTOMATION_GROUP_INTERRUPTED' }); assert.equal(calls, 2);
});

test('unconfirmed script cleanup blocks advancing and keeps ownership for explicit Cancel', async t => {
  const input = move('cleanup', 'task', { onExit: [row('script', { type: 'run_script', script: 'fixture' }), row('later')] }), jobs = new Map(); let calls = 0, cancelled = 0;
  const actions = { jobs, run: async (_row, context) => { calls++; jobs.set(context.actionId, {}); return { status: 'failed', errorCode: 'SCRIPT_STOP_FAILED' }; },
    cancel: id => { cancelled++; jobs.delete(id); }, shutdown: async () => { jobs.clear(); } };
  const ctx = await fixture(t, input, { actions }), result = await ctx.runner.runGroup({ ...ctx, trigger: 'exit', rows: input.onExit });
  assert.equal(result.safeToAdvance, false); assert.deepEqual(result.outcomes.map(action => action.status), ['failed', 'skipped']); assert.equal(calls, 1); assert.equal(ctx.runner.jobs.size, 1);
  assert.equal(ctx.runner.cancel(input), true); assert.equal(cancelled, 1); assert.equal(jobs.size, 0);
});

test('progress callback failure cannot erase intent or prevent execution; invalid budgets and pre-cancellation have no effects', async t => {
  let calls = 0; const input = move('progress', 'task', { onExit: [row('notify')] }), ctx = await fixture(t, input, { actions: new PipelineActions({ notifier: () => { calls++; return { confirmed: true }; } }) });
  await assert.rejects(ctx.runner.runGroup({ ...ctx, trigger: 'exit', rows: input.onExit, exitBudgetMs: 60001 }), { code: 'AUTOMATION_CONTEXT_INVALID' });
  const result = await ctx.runner.runGroup({ ...ctx, trigger: 'exit', rows: input.onExit, onProgress: () => Promise.reject(new Error('PRIVATE DISPLAY ERROR')) });
  assert.equal(result.outcomes[0].status, 'succeeded'); assert.equal(calls, 1);
  const cancelled = move('pre-cancel', 'task', { onExit: [row('never')] }); await ctx.journal.beginMove(cancelled); const signal = AbortSignal.abort('cancelled');
  const skipped = await ctx.runner.runGroup({ key: cancelled, context: metadata(cancelled), trigger: 'exit', rows: cancelled.onExit, signal }); assert.equal(skipped.cancelled, true); assert.equal(skipped.outcomes[0].status, 'skipped'); assert.equal(calls, 1);
});

test('metadata belongs to the recorded task, uses recorded columns and remains fixed while callbacks await', async t => {
  let release; const held = new Promise(resolve => { release = resolve; }); t.after(() => release()); const seen = [];
  const input = move('metadata', 'task', { onEnter: [row('first', { title: '{{column}}' }), row('second', { title: '{{title}} {{fromColumn}} {{toColumn}}' })] });
  const ctx = await fixture(t, input, { actions: new PipelineActions({ notifier: async value => { seen.push(value); if (seen.length === 1) await held; return { confirmed: true }; } }) }); await enter(ctx.journal, input);
  for (const context of [{ ...ctx.context, task: { ...ctx.context.task, id: 'wrong' } }, { ...ctx.context, project: { id: 'wrong' } }])
    await assert.rejects(ctx.runner.runGroup({ ...ctx, context, trigger: 'enter', rows: input.onEnter }), { code: 'AUTOMATION_CONTEXT_INVALID' });
  assert.equal(seen.length, 0); const expectedTitle = ctx.context.task.title;
  ctx.context.move = { column: 'Wrong', fromColumn: 'Wrong', toColumn: 'Wrong' };
  const pending = ctx.runner.runGroup({ ...ctx, trigger: 'enter', rows: input.onEnter }); await until(() => seen.length === 1);
  ctx.context.task.title = 'Mutated'; release(); await pending;
  assert.equal(seen[0].title, 'To'); assert.equal(seen[1].title, `${expectedTitle} From To`);
});

test('enter message cancellation is distinct from timeout and missing confirmation', async t => {
  const input = move('message-cancel', 'task', { onEnter: [row('message', { type: 'send_message', message: 'Hello' }), row('never')] }); let called = false;
  const ctx = await fixture(t, input, { deliverMessage: () => { called = true; return new Promise(() => {}); } }); await enter(ctx.journal, input);
  const pending = ctx.runner.runGroup({ ...ctx, trigger: 'enter', rows: input.onEnter }); await until(() => called); ctx.runner.cancel(input);
  const cancelled = await pending; assert.equal(cancelled.cancelled, true); assert.equal(cancelled.safeToAdvance, false); assert.deepEqual(cancelled.outcomes.map(action => action.status), ['cancelled', 'skipped']);
});

test('request identity, definitions and metadata are captured before the first asynchronous read', async t => {
  const input = move('invocation', 'task', { onExit: [row('notify', { title: 'Before {{title}}' })] }), seen = [];
  const ctx = await fixture(t, input, { actions: new PipelineActions({ notifier: value => { seen.push(value); return { confirmed: true }; } }) });
  const requestKey = { ...input }, expected = ctx.context.task.title;
  const pending = ctx.runner.runGroup({ ...ctx, key: requestKey, trigger: 'exit', rows: input.onExit });
  requestKey.transitionId = 'other'; ctx.context.task.title = 'Changed'; input.onExit[0].title = 'Changed definition';
  const result = await pending; assert.equal(result.outcomes[0].status, 'succeeded'); assert.equal(seen[0].title, `Before ${expected}`); assert.equal((await ctx.journal.read(input)).actions[0].status, 'succeeded');
});

test('the exit deadline starts when a group is accepted, including a delay before its first microtask', async t => {
  const input = move('accepted-deadline', 'task', { onExit: [row('never')] }), persisted = new PipelineJournal(await temp(t));
  let snapshot = (await persisted.beginMove(input)).move, calls = 0;
  // A hot receipt cache completes inside the microtask queue, before timers can
  // fire. The monotonic budget must still include time spent awaiting that queue.
  const journal = { read: async () => snapshot,
    skipAction: async (_key, id, reason) => { const action = snapshot.actions.find(item => item.id === id); action.status = 'skipped'; action.outcome = { reason }; },
    startAction: async (_key, id) => { snapshot.actions.find(item => item.id === id).status = 'running'; return { accepted: true }; },
    finishAction: async (_key, id, result) => { snapshot.actions.find(item => item.id === id).status = result.status; return true; } };
  const actions = { jobs: new Map(), run: async () => { calls++; return { status: 'succeeded' }; }, shutdown: async () => {} };
  const runner = new PipelineAutomations({ journal, actions }); t.after(() => runner.shutdown());
  const pending = runner.runGroup({ key: input, trigger: 'exit', rows: input.onExit, context: metadata(input), exitBudgetMs: 40 });
  const end = performance.now() + 90; while (performance.now() < end) {}
  const result = await pending;
  assert.equal(calls, 0); assert.equal(result.outcomes[0].status, 'skipped'); assert.equal(result.safeToAdvance, true);
});

test('an exit budget exhausted while progress blocks the event loop cannot dispatch a side effect', async t => {
  const input = move('dispatch-deadline', 'task', { onExit: [row('never')] }); let calls = 0, progressCalled = false;
  const ctx = await fixture(t, input, { actions: new PipelineActions({ notifier: () => { calls++; return { confirmed: true }; } }) });
  const result = await ctx.runner.runGroup({ ...ctx, trigger: 'exit', rows: input.onExit, exitBudgetMs: 1000, onProgress: () => {
    progressCalled = true; const end = performance.now() + 1050; while (performance.now() < end) {} // Hold timer callbacks past the real deadline.
  } });
  assert.equal(progressCalled, true); assert.equal(calls, 0); assert.equal(result.outcomes[0].status, 'timed_out'); assert.equal(result.safeToAdvance, true);
});

const scheduledScope = request => ({ provider: 'claude', sessionId: 'logical-session', runId: 'owned-run', mode: request.mode,
  messageHash: createHash('sha256').update(request.message).digest('hex') });
const schedulingAck = scope => ({ scheduled: true, provider: scope.provider, sessionId: scope.sessionId, runId: scope.runId });

test('enter scheduling completes placement before fresh startup and keeps queued/submitted/confirmed delivery distinct without replay', async t => {
  const input = move('async-enter', 'task', { onEnter: [row('first', { type: 'send_message', mode: 'immediate', message: '  Review {{title}}\r\n😀 {{unknown}}  ' }),
    row('second', { type: 'send_message', mode: 'deferred', message: 'Next' }), row('notice')] }), queued = []; let notices = 0, starts = 0;
  const ctx = await fixture(t, input, { actions: new PipelineActions({ notifier: () => { notices++; return { confirmed: true }; } }) }); await enter(ctx.journal, input);
  ctx.runner.deliverMessage = () => assert.fail('Enter scheduling must not wait for a fresh agent receipt.');
  ctx.runner.scheduleEnterMessage = async (request, { signal }) => {
    signal.throwIfAborted(); assert.equal(starts, 0);
    assert.deepEqual(request.key, { projectId: input.projectId, taskId: input.taskId, transitionId: input.transitionId });
    const scope = scheduledScope(request), saved = await ctx.journal.scheduleMessage(request.key, request.actionId, scope); assert.equal(saved.accepted, true);
    queued.push({ ...request, key: { ...request.key }, scope }); request.key.taskId = 'mutated-callback-copy';
    return { ...schedulingAck(scope), confirmed: true }; // A callback cannot promote a queue acknowledgement into delivery.
  };
  const result = await ctx.runner.runGroup({ ...ctx, trigger: 'enter', rows: input.onEnter });
  assert.equal(result.safeToAdvance, true); assert.deepEqual(result.outcomes.map(action => action.status), ['scheduled', 'scheduled', 'succeeded']);
  assert.ok(result.outcomes.slice(0, 2).every(action => action.delivery.status === 'queued'));
  assert.equal(queued[0].message, `  Review ${ctx.context.task.title}\r\n😀 {{unknown}}  `); assert.equal(notices, 1); assert.equal(starts, 0);
  await ctx.journal.advance(input); assert.equal((await ctx.journal.read(input)).phase, 'complete'); starts++; // Only the caller releases the fresh startup after placement.
  const duplicate = await ctx.runner.runGroup({ ...ctx, trigger: 'enter', rows: input.onEnter }); assert.equal(duplicate.safeToAdvance, false); assert.equal(queued.length, 2);
  assert.equal((await ctx.journal.startMessageDelivery(input, queued[0].actionId)).accepted, true);
  await ctx.journal.markMessageSubmitted(input, queued[0].actionId); assert.equal((await ctx.journal.read(input)).actions[0].delivery.status, 'submitted');
  await ctx.journal.finishMessageDelivery(input, queued[0].actionId, { status: 'confirmed' });
  const delivered = await ctx.journal.read(input); assert.equal(delivered.status, 'completed'); assert.equal(delivered.actions[0].delivery.status, 'confirmed'); assert.equal(delivered.actions[1].delivery.status, 'queued'); assert.equal(starts, 1);
});

test('a scheduling claim without exact persisted intent is unconfirmed and cannot fabricate delivery success', async t => {
  for (const reply of [{ scheduled: true, provider: 'claude', sessionId: 'logical-session', runId: 'owned-run' }, { confirmed: true }]) {
    const input = move(`false-claim-${Boolean(reply.scheduled)}`, 'task', { onEnter: [row('message', { type: 'send_message', message: 'Exact' }), row('later')] }); let effects = 0;
    const ctx = await fixture(t, input, { scheduleEnterMessage: () => reply, actions: new PipelineActions({ notifier: () => { effects++; return { confirmed: true }; } }) }); await enter(ctx.journal, input);
    const result = await ctx.runner.runGroup({ ...ctx, trigger: 'enter', rows: input.onEnter });
    assert.deepEqual(result.outcomes.map(action => action.status), ['unconfirmed', 'succeeded']); assert.equal(result.outcomes[0].delivery, undefined); assert.equal(effects, 1);
  }
});

test('wrong durable message hash, mode or acknowledged session/run/provider blocks advancement and later effects', async t => {
  for (const mismatch of ['messageHash', 'mode', 'provider', 'sessionId', 'runId']) {
    const input = move(`wrong-${mismatch}`, 'task', { onEnter: [row('message', { type: 'send_message', message: 'Exact', mode: 'deferred' }), row('never')] }); let effects = 0;
    const ctx = await fixture(t, input, { actions: new PipelineActions({ notifier: () => { effects++; return { confirmed: true }; } }) }); await enter(ctx.journal, input);
    ctx.runner.scheduleEnterMessage = async request => {
      const scope = scheduledScope(request), ack = schedulingAck(scope);
      if (mismatch === 'messageHash') scope.messageHash = '0'.repeat(64);
      else if (mismatch === 'mode') scope.mode = 'immediate';
      else ack[mismatch] = mismatch === 'provider' ? 'codex' : 'wrong-owner';
      await ctx.journal.scheduleMessage(request.key, request.actionId, scope); return ack;
    };
    await assert.rejects(ctx.runner.runGroup({ ...ctx, trigger: 'enter', rows: input.onEnter }), { code: 'AUTOMATION_OUTCOME_UNSAVED' });
    const saved = await ctx.journal.read(input); assert.equal(saved.phase, 'enter'); assert.deepEqual(saved.actions.map(action => action.status), ['scheduled', 'pending']); assert.equal(effects, 0);
    await assert.rejects(ctx.journal.advance(input), { code: 'JOURNAL_ORDER' });
    await ctx.journal.finishMessageDelivery(input, saved.actions[0].id, { status: 'cancelled', reason: 'Owned fixture queue revoked without writes.' }); await ctx.journal.cancelMove(input);
  }
});

test('cancellation after durable scheduling but before its acknowledgement cannot invent cleanup, advance or accept a late acknowledgement', async t => {
  const input = move('schedule-cancel', 'task', { onEnter: [row('message', { type: 'send_message', message: 'Exact' }), row('never')] }), held = Promise.withResolvers(); let scope, actionId, effects = 0;
  t.after(() => held.resolve(schedulingAck(scope || { provider: 'claude', sessionId: 'logical-session', runId: 'owned-run' })));
  const ctx = await fixture(t, input, { actions: new PipelineActions({ notifier: () => { effects++; return { confirmed: true }; } }) }); await enter(ctx.journal, input);
  ctx.runner.scheduleEnterMessage = async request => { scope = scheduledScope(request); actionId = request.actionId; await ctx.journal.scheduleMessage(request.key, request.actionId, scope); return held.promise; };
  const pending = ctx.runner.runGroup({ ...ctx, trigger: 'enter', rows: input.onEnter }), rejected = assert.rejects(pending, { code: 'AUTOMATION_OUTCOME_UNSAVED' });
  await until(async () => (await ctx.journal.read(input)).actions[0].status === 'scheduled'); ctx.runner.cancel(input); await rejected;
  held.resolve(schedulingAck(scope)); await new Promise(resolve => setTimeout(resolve, 20));
  const saved = await ctx.journal.read(input); assert.equal(saved.phase, 'enter'); assert.equal(saved.actions[0].delivery.status, 'queued'); assert.equal(saved.actions[1].status, 'pending'); assert.equal(effects, 0);
  await assert.rejects(ctx.journal.cancelMove(input), { code: 'JOURNAL_WORK_ACTIVE' });
  await ctx.journal.finishMessageDelivery(input, actionId, { status: 'cancelled', reason: 'Owned fixture queue stopped without any transport.' }); await ctx.journal.cancelMove(input);
});

test('a timed-out scheduler cannot acquire a late queue grant after the row outcome is saved', async t => {
  const input = move('schedule-timeout', 'task', { onEnter: [row('message', { type: 'send_message', message: 'Exact' })] }), held = Promise.withResolvers(); let late;
  const ctx = await fixture(t, input, { scheduleEnterMessage: async request => {
    await held.promise; late = await ctx.journal.scheduleMessage(request.key, request.actionId, scheduledScope(request)); return schedulingAck(scheduledScope(request));
  } }); await enter(ctx.journal, input); t.after(() => held.resolve());
  const result = await ctx.runner.runGroup({ ...ctx, trigger: 'enter', rows: input.onEnter, messageTimeoutMs: 100 }); assert.equal(result.outcomes[0].status, 'timed_out');
  held.resolve(); await until(() => late); assert.equal(late.accepted, false); assert.equal((await ctx.journal.read(input)).actions[0].delivery, undefined);
});

test('a persisted last-row queue with a timed-out or failed acknowledgement cannot authorize placement or replay', async t => {
  for (const timeout of [false, true]) {
    const input = move(`saved-unacknowledged-${timeout}`, 'task', { onEnter: [row('message', { type: 'send_message', message: 'Exact' })] }), held = Promise.withResolvers();
    const ctx = await fixture(t, input, { scheduleEnterMessage: async request => {
      const scope = scheduledScope(request); assert.equal((await ctx.journal.scheduleMessage(request.key, request.actionId, scope)).accepted, true);
      if (timeout) await held.promise;
      else throw new Error('PRIVATE SCHEDULER FAILURE');
      return schedulingAck(scope);
    } }); await enter(ctx.journal, input); t.after(() => held.resolve());
    await assert.rejects(ctx.runner.runGroup({ ...ctx, trigger: 'enter', rows: input.onEnter, messageTimeoutMs: 100 }), { code: 'AUTOMATION_OUTCOME_UNSAVED' });
    held.resolve(); const saved = await ctx.journal.read(input); assert.equal(saved.phase, 'enter'); assert.equal(saved.actions[0].delivery.status, 'queued');
    const duplicate = await ctx.runner.runGroup({ ...ctx, trigger: 'enter', rows: input.onEnter }); assert.equal(duplicate.safeToAdvance, false); assert.equal(duplicate.duplicate, true);
    await ctx.journal.finishMessageDelivery(input, saved.actions[0].id, { status: 'cancelled', reason: 'Owned fixture queue stopped.' }); await ctx.journal.cancelMove(input);
  }
});

test('exit messages still require confirmation and cannot use the enter scheduler; manual/restored messages never schedule', async t => {
  const input = move('exit-schedule', 'task', { onExit: [row('notice'), row('message', { type: 'send_message', message: 'Exit' })] }); let scheduled = 0, effects = 0;
  const ctx = await fixture(t, input, { scheduleEnterMessage: () => { scheduled++; return { scheduled: true }; }, actions: new PipelineActions({ notifier: () => { effects++; return { confirmed: true }; } }) });
  await assert.rejects(ctx.runner.runGroup({ ...ctx, trigger: 'exit', rows: input.onExit }), { code: 'MESSAGE_SCHEDULER_REQUIRED' }); assert.equal(effects, 0);
  ctx.runner.deliverMessage = () => ({ confirmed: true }); const result = await ctx.runner.runGroup({ ...ctx, trigger: 'exit', rows: input.onExit }); assert.equal(result.outcomes[1].status, 'succeeded'); assert.equal(scheduled, 0);
  for (const restored of [false, true]) {
    const key = move(`suppressed-schedule-${restored}`, 'other', { onEnter: [row('message', { type: 'send_message', message: 'Never' })] }); await ctx.journal.beginMove(key); await enter(ctx.journal, key);
    const skipped = await ctx.runner.runGroup({ key, context: metadata(key), trigger: 'enter', rows: key.onEnter, canMessage: restored, suppressMessages: restored }); assert.equal(skipped.outcomes[0].status, 'skipped');
  }
  assert.equal(scheduled, 0);
});

test('a false normal outcome acknowledgement stops the group and cannot replay the effect or start later rows', async t => {
  const input = move('false-save', 'task', { onExit: [row('effect'), row('never')] }); let effects = 0;
  const ctx = await fixture(t, input, { actions: new PipelineActions({ notifier: () => { effects++; return { confirmed: true }; } }) }), finish = ctx.journal.finishAction.bind(ctx.journal);
  ctx.journal.finishAction = () => Promise.resolve(false);
  await assert.rejects(ctx.runner.runGroup({ ...ctx, trigger: 'exit', rows: input.onExit }), { code: 'AUTOMATION_OUTCOME_UNSAVED' }); assert.equal(effects, 1);
  const saved = await ctx.journal.read(input); assert.deepEqual(saved.actions.map(action => action.status), ['running', 'pending']);
  await assert.rejects(ctx.runner.runGroup({ ...ctx, trigger: 'exit', rows: input.onExit }), { code: 'AUTOMATION_GROUP_INTERRUPTED' }); assert.equal(effects, 1);
  ctx.journal.finishAction = finish; await finish(input, saved.actions[0].id, { status: 'unconfirmed' }); await ctx.journal.cancelMove(input);
});
