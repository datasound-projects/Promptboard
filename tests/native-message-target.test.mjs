import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { captureNativeMessageTarget } from '../src/native-message-target.mjs';
import { NativeMessageDispatch } from '../src/native-message-dispatch.mjs';
import { PipelineJournal } from '../src/pipeline-journal.mjs';

const key = { projectId: 'project', taskId: 'task', runId: 'run' };
function fixture(provider = 'codex', status = 'running') {
  const path = join(tmpdir(), 'private-task-workspace'), config = { pipeline: true, provider, model: '', permissionMode: 'workspace-write' };
  return { settings: { defaultAgent: { provider } }, base: { revision: 1 },
    projects: [{ id: 'project', revision: 4, workflowMode: 'pipeline', pipeline: { columns: [
      { id: 'todo', role: 'todo' }, { id: 'execute', role: 'active' }, { id: 'review', role: 'active' }, { id: 'done', role: 'done' } ] },
      tasks: [{ id: 'task', revision: 2, contentRevision: 1, title: 'Original title', prompt: '  Literal {{taskNumber}}\r\n雪  ',
        column: 'execute', sessionId: 'session', workspace: { path, branch: 'task-branch' } }] }],
    runs: [{ id: 'run', projectId: 'project', taskId: 'task', sessionId: 'session', status, promptRevision: 1,
      config, workspacePath: path, branch: 'task-branch', baseManifest: { resources: [] } }],
    sessions: [{ id: 'session', projectId: 'project', taskId: 'task', provider, status, currentRunId: 'run', runIds: ['run'],
      pauseIntent: null, config, workspacePath: path, branch: 'task-branch' }] };
}

test('capture supports each owned pipeline provider and queued/running/permission-waiting runs without granting readiness', () => {
  for (const provider of ['claude', 'codex', 'gemini']) for (const status of ['queued', 'running', 'waiting_for_input']) {
    const state = fixture(provider, status), before = structuredClone(state), target = captureNativeMessageTarget(state, key);
    assert.ok(target); assert.equal(target.matches(state), true); assert.equal(Object.isFrozen(target), true);
    assert.deepEqual(Object.keys(target), ['provider', 'sessionId', 'runId', 'matches']);
    assert.deepEqual(JSON.parse(JSON.stringify(target)), { provider, sessionId: 'session', runId: 'run' });
    assert.deepEqual(state, before);
  }
});

test('compatible active moves and lifecycle polling retain the captured conversation without retargeting by stage', () => {
  const state = fixture(), target = captureNativeMessageTarget(state, key), task = state.projects[0].tasks[0];
  task.column = 'review'; task.revision++; task.updatedAt = 123; task.order = 7;
  Object.assign(state.runs[0], { stage: 'execute', turns: 3, providerSessionId: 'native-conversation', activity: { ready: false } });
  Object.assign(state.sessions[0], { nativeSessionId: 'native-conversation', updatedAt: 124 });
  assert.equal(target.matches(state), true);
  state.runs[0].status = state.sessions[0].status = 'waiting_for_input'; assert.equal(target.matches(state), true);
});

test('native identity can become known after queueing but cannot later change or disappear', () => {
  for (const initiallyKnown of [false, true]) for (const replacement of ['other-native', null]) {
    const state = fixture();
    if (initiallyKnown) state.runs[0].providerSessionId = state.sessions[0].nativeSessionId = 'first-native';
    const target = captureNativeMessageTarget(state, key);
    state.runs[0].providerSessionId = state.sessions[0].nativeSessionId = 'first-native';
    assert.equal(target.matches(state), true);
    state.runs[0].providerSessionId = state.sessions[0].nativeSessionId = replacement;
    assert.equal(target.matches(state), false);
    assert.doesNotMatch(JSON.stringify(target), /first-native|other-native/);
  }
  const state = fixture(); state.runs[0].providerSessionId = 'one'; state.sessions[0].nativeSessionId = 'two';
  assert.equal(captureNativeMessageTarget(state, key), null);
});

test('queued startup retains pinned Base definitions through normal resource preparation and supply', () => {
  const state = fixture('claude', 'queued');
  state.runs[0].baseManifest = { resources: [{ resourceId: 'resource', revision: 2, revisionRef: { id: 'immutable' },
    required: false, kind: 'context', delivery: 'prompt', status: 'ready', issues: [] }], profiles: [], supplied: [], observed: [], deliveryState: 'configured' };
  const target = captureNativeMessageTarget(state, key);
  state.runs[0].status = state.sessions[0].status = 'running';
  Object.assign(state.runs[0].baseManifest, { deliveryState: 'supplied', suppliedAt: 50, preparedAt: 40,
    supplied: [{ resourceId: 'resource', revision: 2, hash: 'captured-context' }], warnings: [] });
  state.runs[0].baseManifest.resources[0].issues.push('Optional capture omitted.');
  assert.equal(target.matches(state), true);
  state.runs[0].baseManifest.resources[0].revision++;
  assert.equal(target.matches(state), false);
});

test('edits, task settings, Base revocations and project/default-agent changes invalidate capture', () => {
  for (const change of [s => s.projects[0].tasks[0].contentRevision++, s => { s.projects[0].tasks[0].title = 'edited'; },
    s => { s.projects[0].tasks[0].prompt += '\n'; }, s => { s.projects[0].tasks[0].profileId = 'profile'; },
    s => { s.projects[0].tasks[0].agentOverride = { modelOverride: 'new-model' }; },
    s => { s.projects[0].tasks[0].baseBinding = { resources: ['new-resource'] }; }, s => { s.projects[0].tasks[0].baseColumns = { review: {} }; },
    s => { s.projects[0].tasks[0].baseRevision = 2; }, s => s.base.revision++, s => s.projects[0].revision++,
    s => { s.settings.defaultAgent.model = 'changed'; }, s => { s.runs[0].config.model = 'changed'; },
    s => { s.runs[0].baseManifest.resources.push({ id: 'different' }); }]) {
    const state = fixture(), target = captureNativeMessageTarget(state, key); change(state); assert.equal(target.matches(state), false);
  }
});

test('reset/archive/pause/exit, replacement sessions and changed workspaces cannot inherit another target', () => {
  for (const change of [s => { s.projects[0].tasks[0].column = 'todo'; }, s => { s.projects[0].tasks[0].column = 'done'; },
    s => { s.projects[0].tasks[0].archivedAt = 1; }, s => { s.projects[0].tasks[0].sessionId = null; },
    s => { s.sessions[0].pauseIntent = 'user'; }, s => { s.sessions[0].suspensionRequestedAt = 1; },
    s => { s.sessions[0].currentRunId = 'replacement'; }, s => { s.sessions[0].runIds = []; },
    s => { s.sessions[0].status = 'suspended'; }, s => { s.runs[0].status = 'interrupted'; },
    s => { s.projects[0].tasks[0].workspace.path += '-changed'; }, s => { s.sessions[0].workspacePath += '-changed'; },
    s => { s.runs[0].branch = 'different'; }, s => { s.sessions[0].provider = 'claude'; },
    s => { s.runs[0].taskId = 'foreign'; }, s => { s.sessions[0].projectId = 'foreign'; }, s => { s.projects[0].pipelineImport = {}; }]) {
    const state = fixture(), target = captureNativeMessageTarget(state, key); change(state);
    assert.equal(target.matches(state), false); assert.equal(captureNativeMessageTarget(state, key), null);
  }
});

test('malformed or ambiguous identities fail closed and do not mutate capture or expose prompt facts', () => {
  for (const change of [s => s.projects.push(structuredClone(s.projects[0])), s => s.projects[0].tasks.push(structuredClone(s.projects[0].tasks[0])),
    s => s.runs.push(structuredClone(s.runs[0])), s => s.sessions.push(structuredClone(s.sessions[0])),
    s => { s.runs[0].config.pipeline = false; }, s => { s.runs[0].workspacePath = 'relative'; },
    s => { s.base.revision = NaN; }, s => { s.projects[0].tasks[0].contentRevision = undefined; },
    s => { s.projects[0].pipeline.columns.push({ id: 'execute', role: 'active' }); },
    s => { s.runs.push({ ...s.runs[0], id: 'second-active' }); }, s => { s.sessions[0].runIds = 'run'; },
    s => { s.sessions[0].config = { ...s.runs[0].config, model: 'different' }; }]) {
    const state = fixture(); change(state); assert.equal(captureNativeMessageTarget(state, key), null);
  }
  for (const state of [null, {}, { projects: {} }]) assert.equal(captureNativeMessageTarget(state, key), null);
  const state = fixture(), supplied = { ...key }, target = captureNativeMessageTarget(state, supplied);
  supplied.taskId = 'foreign'; assert.equal(target.matches(state), true);
  assert.doesNotMatch(JSON.stringify(target), /Literal|Original title|workspace|config|fingerprint|native/);
});

async function dispatchFixture(t, change, beforeGrant = false) {
  const dir = await mkdtemp(join(tmpdir(), 'pb-native-target-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const state = fixture(), target = captureNativeMessageTarget(state, key), journal = new PipelineJournal(dir), writes = [];
  const message = 'Exact review 雪', moveKey = { projectId: 'project', taskId: 'task', transitionId: 'move' };
  const scope = { provider: target.provider, sessionId: target.sessionId, runId: target.runId, mode: 'deferred',
    messageHash: createHash('sha256').update(message).digest('hex') };
  const { move } = await journal.beginMove({ ...moveKey, taskRevision: 2, projectRevision: 4,
    from: { id: 'execute', name: 'Execute' }, to: { id: 'review', name: 'Review' },
    onEnter: [{ id: 'row', name: 'Review', type: 'send_message', enabled: true, mode: 'deferred', message }] });
  await journal.advance(moveKey); await journal.startLifecycle(moveKey); await journal.finishLifecycle(moveKey, { status: 'succeeded' });
  const actionId = move.actions[0].id; await journal.startAction(moveKey, actionId); await journal.scheduleMessage(moveKey, actionId, scope); await journal.advance(moveKey);
  if (!beforeGrant) change(state);
  const dispatcher = new NativeMessageDispatch({ journal, supervisor: { async sendNativeMessage(runId, request) {
    assert.equal(runId, target.runId); if (beforeGrant) change(state);
    if (await request.grant({ dispatchId: actionId, ...scope }) !== true) return { status: 'unconfirmed', confirmed: false };
    writes.push(request.message); assert.equal(await request.submitted(), true); assert.equal(await request.confirmDelivery(), true);
    return { status: 'confirmed', confirmed: true };
  } } });
  t.after(() => dispatcher.shutdown());
  const result = await dispatcher.deliver({ key: moveKey, actionId, message, scope }, { preflight: async () => target.matches(state) });
  return { result, writes, record: await journal.read(moveKey) };
}

test('the journal bridge retains one exact target through a compatible active-column move', async t => {
  const w = await dispatchFixture(t, state => { state.projects[0].tasks[0].column = 'review'; state.projects[0].tasks[0].revision++; });
  assert.equal(w.result.confirmed, true); assert.deepEqual(w.writes, ['Exact review 雪']);
  assert.equal(w.record.status, 'completed'); assert.equal(w.record.actions[0].delivery.status, 'confirmed');
  assert.doesNotMatch(JSON.stringify(w.record), /Exact review|Original title|workspace|fingerprint/);
});

test('a replaced logical session after placement cannot receive queued native input', async t => {
  const w = await dispatchFixture(t, state => { state.sessions[0].currentRunId = 'replacement'; });
  assert.equal(w.result.confirmed, false); assert.deepEqual(w.writes, []);
  assert.equal(w.record.status, 'completed'); assert.equal(w.record.actions[0].delivery.status, 'unconfirmed');
  assert.equal(w.record.actions[0].delivery.dispatchStartedAt, undefined);
});

test('a task edit between dispatch and the native grant is rechecked before any input', async t => {
  const w = await dispatchFixture(t, state => { state.projects[0].tasks[0].prompt += ' changed'; }, true);
  assert.equal(w.result.confirmed, false); assert.deepEqual(w.writes, []);
  assert.equal(w.record.actions[0].delivery.status, 'unconfirmed'); assert.equal(w.record.actions[0].delivery.submittedAt, undefined);
});
