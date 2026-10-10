import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ownsMove, PipelineJournal } from '../src/pipeline-journal.mjs';
import { PipelineActions } from '../src/pipeline-actions.mjs';
import { expireLease } from './helpers/journal.mjs';

const move = (transitionId = 'move-one', fields = {}) => ({ projectId: 'project-one', taskId: 'task-one', transitionId,
  taskRevision: 12, projectRevision: 3, from: { id: 'planning', name: 'Planning' }, to: { id: 'build', name: 'Build' }, ...fields });
const row = (id, fields = {}) => ({ id, name: id, type: 'notify', enabled: true, ...fields });
async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'pb-journal-')); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return dir; }
async function folder(dir) { return join(dir, 'automations', (await readdir(join(dir, 'automations'))).find(name => /^[a-f0-9]{64}$/.test(name))); }
async function until(fn) { const end = Date.now() + 15000; for (;;) { const value = await fn(); if (value) return value; if (Date.now() > end) assert.fail('The journal fixture did not reach the expected state.'); await delay(50); } }
function child(dir, input, code) {
  const source = `import { PipelineJournal } from ${JSON.stringify(new URL('../src/pipeline-journal.mjs', import.meta.url).href)};
    const journal = new PipelineJournal(process.argv[1]), input = JSON.parse(process.argv[2]);
    ${code}`;
  return new Promise((resolve, reject) => {
    const worker = spawn(process.execPath, ['--input-type=module', '--eval', source, dir, JSON.stringify(input)], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let output = '', error = '';
    worker.stdout.on('data', data => { output += data; }); worker.stderr.on('data', data => { error += data; }); worker.once('error', reject);
    worker.once('close', status => status === 0 ? resolve(JSON.parse(output)) : reject(new Error(`Journal fixture exited ${status}: ${error}`)));
  });
}

test('scoped restart recovery ignores an unrelated corrupt journal and never grants execution', async t => {
  const dir = await temp(t), journal = new PipelineJournal(dir), broken = move('unrelated-corrupt');
  await journal.beginMove(broken);
  await writeFile(join(await folder(dir), '00000000.json'), 'unreadable fixture');
  const current = move('owned-dead', { taskId: 'task-two', onExit: [row('unknown')] });
  await child(dir, current, 'const saved=await journal.beginMove(input); await journal.startAction(input,saved.move.actions[0].id); console.log(JSON.stringify({ok:true}));');
  await expireLease(dir, current);
  const recovered = await journal.recoverInterrupted(current);
  assert.equal(recovered.length, 1); assert.equal(recovered[0].taskId, 'task-two');
  assert.equal((await journal.read(current)).actions[0].status, 'interrupted');
  assert.deepEqual(await journal.recoverInterrupted(current), []);
  await assert.rejects(journal.read(broken), { code: 'JOURNAL_CORRUPT' });
  await assert.rejects(journal.startAction(current, recovered[0].actions[0].id), { code: 'JOURNAL_OWNER_MISMATCH' });
});

test('reading and recovery are inert; first intent captures bounded metadata, never executable configuration', async t => {
  const dir = await temp(t), journal = new PipelineJournal(dir), input = move('literal', {
    onExit: [row('script', { type: 'run_script', script: 'PRIVATE SCRIPT', enabled: false })],
    onEnter: [row('hook', { type: 'webhook', url: 'https://example.test/private', headers: { Authorization: 'PRIVATE TOKEN' }, body: 'PRIVATE BODY' }),
      row('message', { type: 'send_message', message: 'PRIVATE PROMPT' })] });
  assert.equal(await journal.read(input), null); assert.deepEqual(await journal.recoverInterrupted(input), []);
  assert.deepEqual(await readdir(dir), []);
  const { created, move: saved } = await journal.beginMove(input); assert.equal(created, true); assert.equal(saved.phase, 'exit'); assert.equal(saved.actions[0].status, 'skipped');
  assert.equal(saved.actions.length, 3); assert.equal(new Set(saved.actions.map(action => action.id)).size, 3);
  const bytes = await readFile(join(await folder(dir), '00000000.json'), 'utf8'); assert.doesNotMatch(bytes, /PRIVATE|example\.test|Authorization/);
  assert.match(saved.actions[1].configHash, /^[a-f0-9]{64}$/); saved.actions[1].name = 'Changed returned value';
  assert.equal((await journal.read(input)).actions[1].name, 'hook');
  const duplicate = await journal.beginMove({ ...input, onEnter: [row('new', { title: 'Different' })] });
  assert.equal(duplicate.created, false); assert.deepEqual(duplicate.move.actions, (await journal.read(input)).actions);
});

test('concurrent journal instances grant one durable start and reject duplicate webhook attempts', async t => {
  const dir = await temp(t), first = new PipelineJournal(dir), second = new PipelineJournal(dir), input = move('race', { onExit: [row('hook', { type: 'webhook', url: 'https://example.test/' })] });
  const begun = await Promise.all([first.beginMove(input), second.beginMove(input)]); assert.equal(begun.filter(value => value.created).length, 1);
  assert.deepEqual(begun[0].move.actions, begun[1].move.actions);
  const actionId = begun[0].move.actions[0].id, starts = await Promise.all([first.startAction(input, actionId), second.startAction(input, actionId)]);
  assert.equal(starts.filter(value => value.accepted).length, 1); assert.equal((await first.read(input)).actions[0].status, 'running');
  const attempts = await Promise.allSettled([first.recordAttempt(input, actionId, 1), second.recordAttempt(input, actionId, 1)]);
  assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 1); assert.equal(attempts.find(value => value.status === 'rejected').reason.code, 'JOURNAL_ATTEMPT_INVALID');
  await first.recordAttempt(input, actionId, 2); await second.recordAttempt(input, actionId, 3);
  await assert.rejects(first.recordAttempt(input, actionId, 4), { code: 'JOURNAL_ATTEMPT_INVALID' });
  await first.finishAction(input, actionId, { status: 'failed', httpStatus: 503, attempts: 3 });
  assert.equal(await second.finishAction(input, actionId, { status: 'succeeded' }), false); assert.equal((await first.startAction(input, actionId)).accepted, false);
  assert.equal((await first.read(input)).actions[0].status, 'failed');
});

test('exit failure permits the lifecycle, ordered enter work waits for it, and late acknowledgements cannot change outcomes', async t => {
  const journal = new PipelineJournal(await temp(t)), input = move('order', { onExit: [row('exit-one'), row('exit-two')], onEnter: [row('enter-one'), row('enter-two')] });
  const { move: saved } = await journal.beginMove(input), [a, b, c, d] = saved.actions;
  for (const action of [b, c]) await assert.rejects(journal.startAction(input, action.id), { code: 'JOURNAL_ORDER' });
  await assert.rejects(journal.startLifecycle(input), { code: 'JOURNAL_ORDER' }); await assert.rejects(journal.advance(input), { code: 'JOURNAL_ORDER' });
  await journal.startAction(input, a.id); await journal.finishAction(input, a.id, { status: 'failed', reason: 'Receiver unavailable.' });
  await journal.skipAction(input, b.id, 'No agent is running.'); assert.equal(await journal.advance(input), 'lifecycle');
  await assert.rejects(journal.startAction(input, c.id), { code: 'JOURNAL_ORDER' });
  assert.equal(await journal.finishLifecycle(input, { status: 'succeeded' }), false); assert.equal(await journal.startLifecycle(input), true); assert.equal(await journal.startLifecycle(input), false);
  await journal.finishLifecycle(input, { status: 'succeeded' }); await journal.startAction(input, c.id); await journal.finishAction(input, c.id, { status: 'unconfirmed' });
  await journal.startAction(input, d.id); await journal.finishAction(input, d.id, { status: 'succeeded' }); assert.equal(await journal.advance(input), 'complete');
  const completed = await journal.read(input); assert.equal(completed.status, 'completed'); assert.deepEqual(completed.actions.map(action => action.status), ['failed', 'skipped', 'unconfirmed', 'succeeded']);
  assert.equal(await journal.advance(input), 'complete'); assert.equal(await journal.finishLifecycle(input, { status: 'failed' }), false); assert.equal((await journal.read(input)).revision, completed.revision);
});

test('failed and cancelled session lifecycles skip destination effects without granting a second lifecycle', async t => {
  const journal = new PipelineJournal(await temp(t));
  for (const status of ['failed', 'cancelled']) {
    const input = move(status, { onEnter: [row('enter')] }), { move: saved } = await journal.beginMove(input);
    await journal.advance(input); await journal.startLifecycle(input); await journal.finishLifecycle(input, { status, errorCode: 'SESSION_STOPPED' });
    const failed = await journal.read(input); assert.equal(failed.phase, 'complete'); assert.equal(failed.status, status); assert.equal(failed.actions[0].status, 'skipped');
    assert.equal((await journal.startAction(input, saved.actions[0].id)).accepted, false); assert.equal(await journal.startLifecycle(input), false);
  }
});

test('explicit move cancellation waits for owned work and preserves confirmed effects', async t => {
  const journal = new PipelineJournal(await temp(t));
  for (const phase of ['exit', 'lifecycle', 'enter']) {
    const input = move(`cancel-${phase}`, { onExit: [row('exit')], onEnter: [row('enter'), row('remaining')] }), { move: saved } = await journal.beginMove(input);
    const [exit, enter] = saved.actions;
    await journal.startAction(input, exit.id); await assert.rejects(journal.cancelMove(input), { code: 'JOURNAL_WORK_ACTIVE' });
    await journal.finishAction(input, exit.id, { status: 'succeeded' });
    if (phase !== 'exit') {
      await journal.advance(input);
      if (phase === 'enter') { await journal.startLifecycle(input); await assert.rejects(journal.cancelMove(input), { code: 'JOURNAL_WORK_ACTIVE' }); await journal.finishLifecycle(input, { status: 'succeeded' }); }
    }
    if (phase === 'enter') {
      await journal.startAction(input, enter.id); await assert.rejects(journal.cancelMove(input), { code: 'JOURNAL_WORK_ACTIVE' });
      await journal.finishAction(input, enter.id, { status: 'cancelled' });
    }
    assert.equal(await journal.cancelMove(input), true); assert.equal(await journal.cancelMove(input), false);
    const cancelled = await journal.read(input); assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.actions[0].status, 'succeeded'); assert.equal(cancelled.actions.at(-1).status, 'skipped');
    assert.equal(cancelled.lifecycle.status, phase === 'enter' ? 'succeeded' : 'cancelled');
    assert.equal((await journal.startAction(input, saved.actions.at(-1).id)).accepted, false);
  }
});

test('independent OS processes create one intent; dead-owner recovery preserves known outcomes and prevents replay', async t => {
  const dir = await temp(t), input = move('process-race', { onExit: [row('completed'), row('unknown')], onEnter: [row('not-started')] });
  const code = `const begun = await journal.beginMove(input);
    if (begun.created) { const [a,b] = begun.move.actions; await journal.startAction(input,a.id); await journal.finishAction(input,a.id,{status:'succeeded'}); await journal.startAction(input,b.id); }
    console.log(JSON.stringify(begun));`;
  const begun = await Promise.all([child(dir, input, code), child(dir, input, code)]); assert.equal(begun.filter(value => value.created).length, 1);
  await expireLease(dir, input);
  const journal = new PipelineJournal(dir), prior = await journal.read(input), recovered = await journal.recoverInterrupted(input);
  assert.equal(recovered.length, 1); assert.equal(recovered[0].status, 'interrupted'); assert.deepEqual(recovered[0].actions.map(action => action.status), ['succeeded', 'interrupted', 'interrupted']);
  assert.equal(recovered[0].actions[1].startedAt, prior.actions[1].startedAt); assert.equal(recovered[0].actions[2].startedAt, undefined); assert.equal(recovered[0].lifecycle.status, 'interrupted');
  assert.deepEqual(await journal.recoverInterrupted(input), []); assert.equal((await journal.beginMove(input)).created, false);
  await assert.rejects(journal.startAction(input, prior.actions[1].id), { code: 'JOURNAL_OWNER_MISMATCH' });
  const retry = await journal.beginMove(move('explicit-new-move', { onEnter: [row('retry')] })); assert.equal(retry.created, true); assert.notEqual(retry.move.actions[0].id, prior.actions[1].id);
});

test('recovery never interrupts a live owner, including another OS process', async t => {
  const dir = await temp(t), journal = new PipelineJournal(dir), input = move('live', { onExit: [row('live')] });
  const { move: saved } = await journal.beginMove(input); await journal.startAction(input, saved.actions[0].id);
  assert.deepEqual(await new PipelineJournal(dir).recoverInterrupted(input), []);
  const snapshot = await child(dir, input, `console.log(JSON.stringify({ recovered: await journal.recoverInterrupted(input), move: await journal.read(input) }));`);
  assert.deepEqual(snapshot.recovered, []); assert.equal(snapshot.move.actions[0].status, 'running');
  const result = await child(dir, input, `let code; try { await journal.startAction(input, (await journal.read(input)).actions[0].id); } catch (error) { code=error.code; } console.log(JSON.stringify({code}));`);
  assert.equal(result.code, 'JOURNAL_OWNER_MISMATCH');
});

test('a move left by an earlier process with this same PID is recovered once its lease expires, while PID-only legacy moves keep their owner', async t => {
  const dir = await temp(t), journal = new PipelineJournal(dir);
  const rewrite = async change => { const location = await folder(dir);
    for (const file of (await readdir(location)).filter(name => name.endsWith('.json'))) { const path = join(location, file), data = JSON.parse(await readFile(path, 'utf8')); change(data); await writeFile(path, JSON.stringify(data)); } };
  const reused = move('reused-pid', { onExit: [row('unknown'), row('next')] }), { move: saved } = await journal.beginMove(reused);
  assert.equal(saved.ownerPid, process.pid); assert.match(saved.ownerInstance, /^[0-9a-f-]{36}$/);
  await journal.startAction(reused, saved.actions[0].id);
  await rewrite(data => { data.ownerInstance = '00000000-0000-4000-8000-000000000000'; });
  await assert.rejects(journal.startAction(reused, saved.actions[1].id), { code: 'JOURNAL_OWNER_MISMATCH' });
  assert.deepEqual(await journal.recoverInterrupted(reused), []);
  await expireLease(dir, reused);
  const recovered = await journal.recoverInterrupted(reused);
  assert.equal(recovered.length, 1); assert.deepEqual(recovered[0].actions.map(action => action.status), ['interrupted', 'interrupted']);
  await rm(join(dir, 'automations'), { recursive: true });
  const legacy = move('legacy-pid', { onExit: [row('live')] }), { move: old } = await journal.beginMove(legacy);
  await journal.startAction(legacy, old.actions[0].id);
  await rewrite(data => { for (const field of ['ownerInstance', 'leaseId', 'heartbeatAt', 'leaseExpiresAt']) delete data[field]; });
  assert.deepEqual(await journal.recoverInterrupted(legacy), []); assert.equal((await journal.read(legacy)).actions[0].status, 'running');
});

test('PID reuse cannot pin a move: an expired lease is recovered although its PID is live, an unexpired one waits for a retry', async t => {
  const dir = await temp(t), journal = new PipelineJournal(dir), input = move('foreign-lease', { onExit: [row('unknown')] });
  const { move: saved } = await journal.beginMove(input); await journal.startAction(input, saved.actions[0].id);
  assert.match(saved.leaseId, /^[0-9a-f-]{36}$/); assert.equal(saved.heartbeatAt, saved.createdAt); assert.equal(saved.leaseExpiresAt, saved.createdAt + 60000);
  // Another instance holds the lease; its PID is a live, unrelated process.
  const foreign = data => { data.ownerPid = process.ppid; data.ownerInstance = '00000000-0000-4000-8000-000000000000'; };
  await expireLease(dir, input, data => { foreign(data); data.leaseExpiresAt = Date.now() + 60000; });
  assert.deepEqual(await journal.recoverInterrupted(input), []); assert.equal((await journal.read(input)).actions[0].status, 'running');
  assert.deepEqual(journal.pendingRecoveries(), [{ projectId: input.projectId, taskId: input.taskId, transitionId: input.transitionId }]);
  await expireLease(dir, input, foreign);
  const [recovered] = await journal.recoverInterrupted(input);
  assert.equal(recovered.status, 'interrupted'); assert.equal(recovered.actions[0].status, 'interrupted'); assert.equal(recovered.ownerPid, process.ppid);
  assert.deepEqual(journal.pendingRecoveries(), []); assert.deepEqual(await journal.recoverInterrupted(input), []);
});

test('legacy moves without a lease keep the PID and instance rule', async t => {
  const dir = await temp(t), journal = new PipelineJournal(dir), legacy = data => { for (const field of ['ownerInstance', 'leaseId', 'heartbeatAt', 'leaseExpiresAt']) delete data[field]; };
  for (const [transitionId, ownerPid, recoveredCount] of [['live-pid', process.ppid, 0], ['dead-pid', 2147483647, 1]]) {
    const input = move(transitionId, { onExit: [row('unknown')] }), { move: saved } = await journal.beginMove(input);
    await journal.startAction(input, saved.actions[0].id);
    await expireLease(dir, input, data => { legacy(data); data.ownerPid = ownerPid; });
    assert.equal((await journal.read(input)).leaseExpiresAt, undefined);
    assert.equal((await journal.recoverInterrupted(input)).length, recoveredCount);
    assert.equal((await journal.read(input)).actions[0].status, recoveredCount ? 'interrupted' : 'running');
  }
  const own = move('own-pid', { onExit: [row('first'), row('second')] }), { move: saved } = await journal.beginMove(own);
  await journal.startAction(own, saved.actions[0].id); await expireLease(dir, own, legacy);
  assert.deepEqual(await journal.recoverInterrupted(own), []);
  await journal.finishAction(own, saved.actions[0].id, { status: 'succeeded' }); assert.equal((await journal.startAction(own, saved.actions[1].id)).accepted, true);
  // A lease is complete or absent, and unknown owner fields stay invalid.
  const partial = move('partial-lease'), { move: leased } = await journal.beginMove(partial);
  for (const change of ['ownerInstance', 'leaseId', 'heartbeatAt', 'leaseExpiresAt'].map(field => data => { delete data[field]; })
    .concat(data => { data.leaseId = '../lease'; }, data => { data.leaseOwner = process.pid; })) {
    await expireLease(dir, partial, data => { Object.assign(data, leased); change(data); });
    await assert.rejects(journal.read(partial), { code: 'JOURNAL_CORRUPT' });
  }
});

test('the owner renews its lease while work is active and stops once the move completes', async t => {
  const dir = await temp(t), journal = new PipelineJournal(dir, { leaseMs: 3000 }), input = move('renewal', { onExit: [row('effect')] });
  const { move: saved } = await journal.beginMove(input); await journal.startAction(input, saved.actions[0].id);
  const renewed = await until(async () => { const current = await journal.read(input); return current.leaseExpiresAt > saved.leaseExpiresAt && current; });
  assert.ok(renewed.heartbeatAt > saved.heartbeatAt); assert.equal(renewed.leaseId, saved.leaseId); assert.equal(renewed.actions[0].status, 'running');
  await journal.finishAction(input, saved.actions[0].id, { status: 'succeeded' }); await journal.cancelMove(input);
  const finished = await journal.read(input); await delay(2500);
  assert.deepEqual(await journal.read(input), finished);
});

test('an expired lease that no process recovered stays with its owner, as after the computer slept', async t => {
  const dir = await temp(t), journal = new PipelineJournal(dir), input = move('slept', { onExit: [row('effect'), row('next')] });
  const { move: saved } = await journal.beginMove(input); await journal.startAction(input, saved.actions[0].id);
  await expireLease(dir, input); assert.equal(ownsMove(await journal.read(input)), false);
  await assert.rejects(new PipelineJournal(dir).finishAction(input, saved.actions[0].id, { status: 'succeeded' }), { code: 'AUTOMATION_LEASE_LOST' });
  await journal.finishAction(input, saved.actions[0].id, { status: 'succeeded' });
  assert.equal((await journal.startAction(input, saved.actions[1].id)).accepted, true);
  assert.deepEqual((await journal.read(input)).actions.map(action => action.status), ['succeeded', 'running']);
});

test('an owner whose lease another process recovered gets AUTOMATION_LEASE_LOST and replays nothing', async t => {
  const dir = await temp(t), lost = [], journal = new PipelineJournal(dir, { leaseMs: 3000, onLeaseLost: key => lost.push(key) });
  const input = move('lease-lost', { onExit: [row('effect'), row('next')] }), { move: saved } = await journal.beginMove(input);
  await journal.startAction(input, saved.actions[0].id);
  // The owner stalled past its lease; another process recovers the move.
  await expireLease(dir, input); assert.equal((await new PipelineJournal(dir).recoverInterrupted(input)).length, 1);
  const recovered = await journal.read(input); assert.notEqual(recovered.leaseId, saved.leaseId);
  await assert.rejects(journal.finishAction(input, saved.actions[0].id, { status: 'succeeded' }), { code: 'AUTOMATION_LEASE_LOST' });
  await assert.rejects(journal.startAction(input, saved.actions[1].id), { code: 'AUTOMATION_LEASE_LOST' });
  await until(() => lost.length);
  assert.deepEqual(lost, [{ projectId: input.projectId, taskId: input.taskId, transitionId: input.transitionId }]);
  assert.deepEqual(await journal.read(input), recovered); assert.deepEqual(recovered.actions.map(action => action.status), ['interrupted', 'interrupted']);
});

test('restart recovery covers pending, lifecycle and enter phases without changing confirmed effects', async t => {
  const dir = await temp(t), journal = new PipelineJournal(dir);
  for (const phase of ['pending', 'lifecycle', 'enter']) {
    const input = move(phase, { onEnter: [row('confirmed'), row('unknown')] });
    await child(dir, input, `const {move:saved}=await journal.beginMove(input);
      if(input.transitionId!=='pending'){await journal.advance(input); await journal.startLifecycle(input);}
      if(input.transitionId==='enter'){await journal.finishLifecycle(input,{status:'succeeded'}); await journal.startAction(input,saved.actions[0].id); await journal.finishAction(input,saved.actions[0].id,{status:'succeeded'}); await journal.startAction(input,saved.actions[1].id);}
      console.log(JSON.stringify(saved));`);
  }
  const recovered = [];
  for (const phase of ['pending', 'lifecycle', 'enter']) { await expireLease(dir, move(phase)); recovered.push(...await journal.recoverInterrupted(move(phase))); }
  assert.equal(recovered.length, 3);
  for (const saved of recovered) {
    assert.equal(saved.status, 'interrupted'); assert.equal(saved.phase, 'complete');
    assert.equal(saved.lifecycle.status, saved.transitionId === 'enter' ? 'succeeded' : 'interrupted');
    assert.deepEqual(saved.actions.map(action => action.status), saved.transitionId === 'enter' ? ['succeeded', 'interrupted'] : ['interrupted', 'interrupted']);
  }
});

test('old move IDs remain deduplicated after later moves, and identities cannot traverse paths', async t => {
  const journal = new PipelineJournal(await temp(t)), old = move('old', { onExit: [row('first')] });
  const original = await journal.beginMove(old);
  for (let index = 0; index < 12; index++) await journal.beginMove(move(`new-${index}`));
  assert.deepEqual(await journal.beginMove(old), { created: false, move: original.move });
  for (const taskId of ['../task', 'task/other', '', 'x'.repeat(101), 'bad\0id']) await assert.rejects(journal.read({ ...old, taskId }), { code: 'JOURNAL_INVALID' });
  await assert.rejects(journal.beginMove(move('same', { to: { id: 'planning', name: 'Same column' } })), { code: 'JOURNAL_INVALID' });
});

test('corrupt, missing and newer latest revisions fail closed instead of falling back to pending intent', async t => {
  const dir = await temp(t), journal = new PipelineJournal(dir), input = move('corrupt', { onExit: [row('effect')] });
  const { move: saved } = await journal.beginMove(input); await journal.startAction(input, saved.actions[0].id);
  const path = join(await folder(dir), '00000001.json'), bytes = await readFile(path, 'utf8');
  for (const replacement of ['{"partial":', JSON.stringify({ ...JSON.parse(bytes), version: 99 }), JSON.stringify({ ...JSON.parse(bytes), taskId: 'different-task' })]) {
    await writeFile(path, replacement);
    const code = replacement.includes('"version":99') ? 'JOURNAL_VERSION_UNSUPPORTED' : 'JOURNAL_CORRUPT';
    await assert.rejects(journal.read(input), { code }); await assert.rejects(journal.startAction(input, saved.actions[0].id), { code }); await assert.rejects(journal.beginMove(input), { code });
    assert.equal(await readFile(path, 'utf8'), replacement);
  }
  await writeFile(path, bytes); await writeFile(join(await folder(dir), '.tmp-interrupted'), '{partial'); assert.equal((await journal.read(input)).actions[0].status, 'running');
  await writeFile(join(await folder(dir), '00000003.json'), bytes); await assert.rejects(journal.read(input), { code: 'JOURNAL_CORRUPT' });
  await rm(join(await folder(dir), '00000003.json')); await rm(join(await folder(dir), '00000000.json')); await assert.rejects(journal.read(input), { code: 'JOURNAL_CORRUPT' });
});

test('failed writes grant no action and lost outcome writes leave the original started marker intact', async t => {
  const dir = await temp(t), journal = new PipelineJournal(dir), input = move('write-failure', { onExit: [row('effect')] });
  await writeFile(join(dir, 'automations'), 'blocked'); await assert.rejects(journal.beginMove(input)); assert.equal(await readFile(join(dir, 'automations'), 'utf8'), 'blocked');
  await rm(join(dir, 'automations')); const { move: saved } = await journal.beginMove(input); await journal.startAction(input, saved.actions[0].id);
  await rename(join(dir, 'automations'), join(dir, 'held')); await writeFile(join(dir, 'automations'), 'blocked');
  await assert.rejects(journal.finishAction(input, saved.actions[0].id, { status: 'succeeded' }));
  await rm(join(dir, 'automations')); await rename(join(dir, 'held'), join(dir, 'automations'));
  assert.equal((await journal.read(input)).actions[0].status, 'running'); assert.equal((await journal.startAction(input, saved.actions[0].id)).accepted, false);
});

test('webhook primitives persist each real attempt using the same durable action identity', async t => {
  const dir = await temp(t), journal = new PipelineJournal(dir), definition = row('hook', { type: 'webhook', url: 'https://example.test/' }), input = move('hook', { onExit: [definition] });
  const { move: saved } = await journal.beginMove(input), actionId = saved.actions[0].id; assert.equal((await journal.startAction(input, actionId)).accepted, true);
  const seen = [], runner = new PipelineActions({ fetcher: async (_url, options) => {
    const recorded = await new PipelineJournal(dir).read(input); assert.equal(recorded.actions[0].status, 'running'); assert.equal(recorded.actions[0].attempts.length, seen.length + 1);
    seen.push(options.headers.get('Idempotency-Key')); return new Response(null, { status: seen.length === 1 ? 503 : 204, headers: { 'Retry-After': '0' } });
  } }); t.after(() => runner.shutdown());
  const result = await runner.run(definition, { actionId, project: { id: input.projectId, name: 'Fixture' }, task: { id: input.taskId, title: 'Fixture', prompt: 'Exact prompt' },
    move: { trigger: 'exit', column: 'Planning', fromColumn: 'Planning', toColumn: 'Build' }, onAttempt: number => journal.recordAttempt(input, actionId, number) });
  assert.equal(result.status, 'succeeded'); assert.deepEqual(seen, [actionId, actionId]); await journal.finishAction(input, actionId, result);
  const finished = await journal.read(input); assert.equal(finished.actions[0].status, 'succeeded'); assert.equal(finished.actions[0].attempts.length, 2);
  assert.equal((await journal.startAction(input, actionId)).accepted, false);
});

test('outcomes reject raw diagnostics and unsupported fields; malformed actions cannot be acknowledged', async t => {
  const journal = new PipelineJournal(await temp(t)), input = move('outcomes', { onExit: [row('effect')] }), { move: saved } = await journal.beginMove(input);
  for (const result of [{ status: 'succeeded', raw: 'PRIVATE' }, { status: 'failed', reason: 'x'.repeat(501) }, { status: 'failed', errorCode: 'PRIVATE / path' },
    { status: 'succeeded', durationMs: -1 }, { status: 'succeeded', attempts: 4 }, { status: 'pending' }, { status: 'interrupted' }]) await assert.rejects(journal.finishAction(input, saved.actions[0].id, result), { code: 'JOURNAL_INVALID' });
  assert.equal(await journal.finishAction(input, saved.actions[0].id, { status: 'succeeded' }), false);
  await journal.startAction(input, saved.actions[0].id); await journal.finishAction(input, saved.actions[0].id, { status: 'failed', exitCode: null, terminatedBy: 'SIGTERM', durationMs: 7 });
  assert.deepEqual((await journal.read(input)).actions[0].outcome, { status: 'failed', exitCode: null, terminatedBy: 'SIGTERM', durationMs: 7 });
  await assert.rejects(journal.startAction(input, 'unknown'), { code: 'JOURNAL_ACTION_NOT_FOUND' }); await assert.rejects(journal.recordAttempt(input, saved.actions[0].id, 1), { code: 'JOURNAL_ATTEMPT_INVALID' });
  await assert.rejects(journal.startAction(move('unknown'), 'unknown'), { code: 'JOURNAL_NOT_FOUND' });
});
