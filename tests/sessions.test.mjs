import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, emptyState, migrateState, STATE_VERSION } from '../src/store.mjs';
import { Board } from '../src/board.mjs';
import { attachSession } from '../src/sessions.mjs';

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pb-sessions-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}
function legacyState() {
  const state = { ...emptyState(), version: 3, revision: 17,
    projects: [{ id: 'project', name: 'Fixture', tasks: [{ id: 'task', column: 'executing', revision: 8, prompt: '  Exact\r\nengineered prompt\n', workspace: { path: '/fixture/worktree', branch: 'task-branch' } }] }],
    runs: ['planning', 'executing'].map((stage, i) => ({ id: `run-${i}`, taskId: 'task', projectId: 'project', stage,
      config: { provider: 'claude', model: 'fixture', permissionMode: stage === 'planning' ? 'plan' : 'default' },
      providerSessionId: `native-${i}`, status: i ? 'interrupted' : 'succeeded', createdAt: 100 + i, artifactsDir: `runs/run-${i}`,
      baseManifest: { resources: [{ resourceId: 'resource', revision: 2 }] } })),
    base: { revision: 12, resources: [{ id: 'resource', revision: 2 }], approvedRoots: [{ id: 'fixture-root' }] }, extension: { keep: true } };
  delete state.sessions;
  return state;
}

test('v3 migration preserves exact Composer text, Base, workspaces and distinct native stage conversations', async t => {
  const dir = await directory(t), original = legacyState(), bytes = JSON.stringify(original, null, 3);
  await writeFile(join(dir, 'state.json'), bytes);
  const store = new Store(dir), state = await store.read();
  assert.equal(state.version, STATE_VERSION); assert.equal(state.revision, 17);
  assert.deepEqual(state.base, original.base); assert.deepEqual(state.extension, original.extension);
  assert.equal(state.projects[0].tasks[0].prompt, original.projects[0].tasks[0].prompt);
  assert.deepEqual(state.projects[0].tasks[0].workspace, original.projects[0].tasks[0].workspace);
  assert.equal(state.projects[0].tasks[0].revision, 8);
  assert.deepEqual(state.sessions.map(session => session.nativeSessionId), ['native-0', 'native-1']);
  assert.deepEqual(state.sessions.map(session => session.status), ['exited', 'orphaned']);
  assert.deepEqual(state.runs.map(run => run.baseManifest), original.runs.map(run => run.baseManifest));
  assert.notEqual(state.runs[0].sessionId, state.runs[1].sessionId);
  assert.equal(state.projects[0].tasks[0].sessionId, state.runs[1].sessionId);
  assert.equal(await readFile(join(dir, store.recovery.migrationBackup), 'utf8'), bytes);
  assert.equal(store.recovery.migratedFromVersion, 3);
  const again = await new Store(dir).read(); assert.deepEqual(again, state);
  assert.equal((await readdir(dir)).filter(name => name.startsWith('state.pre-migration')).length, 1);
  const clone = structuredClone(original); migrateState(clone); assert.deepEqual(clone, original, 'The migration helper must not mutate its input.');
});

test('v3 migration write failure leaves the valid primary and exact backup intact and can be retried', async t => {
  const dir = await directory(t), bytes = JSON.stringify(legacyState());
  await writeFile(join(dir, 'state.json'), bytes); await mkdir(join(dir, 'state.json.bak'));
  const store = new Store(dir);
  await assert.rejects(store.read(), { code: 'STATE_MIGRATION_FAILED' }); assert.equal(store.state, null);
  assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), bytes);
  assert.equal((await readdir(dir)).some(name => name.startsWith('state.corrupt')), false);
  await rm(join(dir, 'state.json.bak'), { recursive: true });
  assert.equal((await store.read()).sessions.length, 2);
});

test('restart recovery is shared by concurrent readers, never launches, and preserves user pause intent', async t => {
  const dir = await directory(t), state = migrateState(legacyState());
  state.runs[1].status = 'running'; state.sessions[1].status = 'running';
  state.sessions[0].status = 'suspended'; state.sessions[0].pauseIntent = 'user';
  await writeFile(join(dir, 'state.json'), JSON.stringify(state));
  const board = new Board({ dataDir: dir, executor: { start() { assert.fail('Recovery must not start an agent.'); } } });
  const update = board.store.update.bind(board.store); let release, entered;
  const held = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
  let writes = 0;
  board.store.update = async change => { writes++; entered(); await held; return update(change); };
  const first = board.state(); await started;
  let secondReturned = false; const second = board.state().then(value => { secondReturned = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(secondReturned, false);
  release(); const states = await Promise.all([first, second]); assert.equal(writes, 1);
  for (const recovered of states) {
    assert.equal(recovered.runs[1].status, 'interrupted'); assert.equal(recovered.sessions[1].status, 'orphaned');
    assert.equal(recovered.sessions[1].nativeSessionId, 'native-1');
    assert.equal(recovered.sessions[0].status, 'suspended'); assert.equal(recovered.sessions[0].pauseIntent, 'user');
  }
  assert.equal((await new Board({ dataDir: dir }).state()).sessions[0].pauseIntent, 'user');
});

test('run updates persist native IDs and logical lifecycle without rewriting prompt, Base or older runs', async t => {
  const dir = await directory(t), board = new Board({ dataDir: dir }); await board.state();
  await board.store.update(state => {
    state.projects.push({ id: 'p', labels: [], labelRevision: 0, backlog: [], backlogRevision: 0, tasks: [{ id: 't', prompt: 'Exact task', column: 'executing', labelIds: [] }] });
    for (const id of ['first', 'second']) {
      const run = { id, taskId: 't', projectId: 'p', status: 'queued', createdAt: 1, config: { provider: 'codex' }, baseManifest: { resources: [] } };
      state.runs.push(run); attachSession(state, run);
    }
  });
  await board.updateRun('first', { status: 'cancelled', endedAt: 2 });
  await board.updateRun('second', { status: 'running', providerSessionId: 'thread-fixture' });
  await board.updateRun('second', { status: 'waiting_for_input', turnComplete: true, turns: 1 });
  let state = await new Store(dir).read();
  assert.equal(state.sessions[0].status, 'exited'); assert.equal(state.sessions[0].lastRunStatus, 'cancelled');
  assert.equal(state.sessions[1].status, 'waiting_for_input'); assert.equal(state.sessions[1].nativeSessionId, 'thread-fixture');
  assert.equal(state.projects[0].tasks[0].prompt, 'Exact task'); assert.deepEqual(state.runs[1].baseManifest, { resources: [] });
  await board.updateRun('second', { status: 'succeeded', endedAt: 3 }); state = await new Store(dir).read();
  assert.equal(state.sessions[1].status, 'exited'); assert.equal(state.sessions[1].lastRunStatus, 'succeeded');
  assert.equal(state.runs[0].status, 'cancelled');
});

test('restart between saved pause intent and process exit retains suspension without relaunching', async t => {
  const dir = await directory(t), state = migrateState(legacyState());
  state.runs[1].status = 'running'; state.runs[1].lifecycle = 'suspending';
  state.sessions[1].status = 'running'; state.sessions[1].pauseIntent = 'user'; state.sessions[1].suspensionRequestedAt = 123;
  await writeFile(join(dir, 'state.json'), JSON.stringify(state));
  const board = new Board({ dataDir: dir, executor: { start() { assert.fail('Saved pause must not launch a process.'); } } });
  const recovered = await board.state();
  assert.equal(recovered.runs[1].status, 'interrupted');
  assert.equal(recovered.sessions[1].status, 'suspended');
  assert.equal(recovered.sessions[1].pauseIntent, 'user');
  assert.equal(recovered.sessions[1].nativeSessionId, 'native-1');
  assert.equal(recovered.sessions[1].suspensionRequestedAt, 123);
});

test('session and run acceptance share an atomic write; a failed write publishes neither', async t => {
  const dir = await directory(t), store = new Store(dir); await store.update(() => {});
  await mkdir(join(dir, 'state.json.bak'));
  await assert.rejects(store.update(state => {
    const run = { id: 'rejected', taskId: 't', projectId: 'p', status: 'queued', config: { provider: 'claude' } };
    state.runs.push(run); attachSession(state, run);
  }), { code: 'STATE_WRITE_FAILED' });
  assert.deepEqual((await store.read()).runs, []); assert.deepEqual((await store.read()).sessions, []);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).sessions, []);
});

test('restart during a system settings handoff keeps the native ID and does not replay the move or claim a user pause', async t => {
  const dir = await directory(t), state = migrateState(legacyState());
  state.runs[1].status = 'running'; state.runs[1].lifecycle = 'suspending';
  state.sessions[1].status = 'running'; state.sessions[1].pauseIntent = 'system';
  state.sessions[1].suspensionRequestedAt = 123; state.sessions[1].suspensionToken = 'lease-fixture';
  await writeFile(join(dir, 'state.json'), JSON.stringify(state));
  const board = new Board({ dataDir: dir, executor: { start() { assert.fail('Recovery must not replay a system handoff.'); } } });
  const recovered = await board.state();
  assert.equal(recovered.runs[1].status, 'interrupted'); assert.equal(recovered.sessions[1].status, 'orphaned');
  assert.equal(recovered.sessions[1].pauseIntent, 'system'); assert.equal(recovered.sessions[1].nativeSessionId, 'native-1');
  assert.equal(recovered.projects[0].tasks[0].column, 'executing'); assert.equal(recovered.runs.length, 2);
});
