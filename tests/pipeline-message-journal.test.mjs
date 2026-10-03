import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PipelineJournal } from '../src/pipeline-journal.mjs';
import { PipelineAutomations } from '../src/pipeline-automations.mjs';
import { NativeMessageReceipts } from '../src/native-message-receipts.mjs';

const message = { id: 'message', name: 'Review', type: 'send_message', message: 'PRIVATE Review text', mode: 'deferred' };
const input = (transitionId = 'move', fields = {}) => ({ projectId: 'project', taskId: 'task', transitionId, taskRevision: 4, projectRevision: 2,
  from: { id: 'source', name: 'Source' }, to: { id: 'target', name: 'Target' }, onEnter: [message], ...fields });
const scope = (fields = {}) => ({ provider: 'claude', sessionId: 'logical-session', runId: 'process-run', mode: 'deferred',
  messageHash: createHash('sha256').update(message.message).digest('hex'), ...fields });
async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'pb-message-journal-')); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return dir; }
async function fixture(t, move = input()) {
  const dir = await temp(t), journal = new PipelineJournal(dir), { move: saved } = await journal.beginMove(move);
  await journal.advance(move); await journal.startLifecycle(move); await journal.finishLifecycle(move, { status: 'succeeded' });
  const actionId = saved.actions.find(action => action.trigger === 'enter')?.id;
  return { dir, journal, key: move, actionId };
}
async function queued(ctx, target = scope()) { await ctx.journal.startAction(ctx.key, ctx.actionId); return ctx.journal.scheduleMessage(ctx.key, ctx.actionId, target); }
async function delivery(ctx) { return (await ctx.journal.read(ctx.key)).actions.find(action => action.id === ctx.actionId).delivery; }
async function folder(dir) { return join(dir, 'automations', (await readdir(join(dir, 'automations')))[0]); }
function child(dir, move, code) {
  return new Promise((resolve, reject) => {
    const source = `import {PipelineJournal} from ${JSON.stringify(new URL('../src/pipeline-journal.mjs', import.meta.url).href)};
      const journal=new PipelineJournal(process.argv[1]), key=JSON.parse(process.argv[2]), scope=JSON.parse(process.argv[3]); ${code}`;
    const worker = spawn(process.execPath, ['--input-type=module', '--eval', source, dir, JSON.stringify(move), JSON.stringify(scope())], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = ''; worker.stdout.on('data', bytes => { output += bytes; }); worker.stderr.on('data', bytes => { error += bytes; }); worker.once('error', reject);
    worker.once('close', status => status === 0 ? resolve(JSON.parse(output)) : reject(new Error(`Message journal fixture exited ${status}: ${error}`)));
  });
}

test('queued enter messages release row order and complete placement without inventing successful delivery', async t => {
  const ctx = await fixture(t, input('nonblocking', { onEnter: [message, { id: 'later', name: 'Later', type: 'notify' }] }));
  const claimed = await queued(ctx); assert.equal(claimed.accepted, true); assert.equal(claimed.delivery.status, 'queued');
  const move = await ctx.journal.read(ctx.key), later = move.actions[1];
  assert.equal(move.actions[0].status, 'scheduled'); assert.equal(move.actions[0].outcome.status, 'scheduled');
  assert.equal((await ctx.journal.startAction(ctx.key, later.id)).accepted, true);
  await ctx.journal.finishAction(ctx.key, later.id, { status: 'succeeded' }); await ctx.journal.advance(ctx.key);
  const completed = await ctx.journal.read(ctx.key); assert.equal(completed.phase, 'complete'); assert.equal(completed.status, 'completed');
  assert.equal(completed.lifecycle.status, 'succeeded'); assert.equal(completed.actions[0].delivery.status, 'queued');
  assert.equal((await ctx.journal.startAction(ctx.key, ctx.actionId)).accepted, false);
  await assert.rejects(ctx.journal.cancelMove(ctx.key), { code: 'JOURNAL_WORK_ACTIVE' });
});

test('one durable dispatch grant survives concurrent instances, after placement completes, and each native stage is distinct', async t => {
  const ctx = await fixture(t); await queued(ctx); await ctx.journal.advance(ctx.key);
  const other = new PipelineJournal(ctx.dir), claims = await Promise.all([ctx.journal.startMessageDelivery(ctx.key, ctx.actionId), other.startMessageDelivery(ctx.key, ctx.actionId)]);
  assert.equal(claims.filter(value => value.accepted).length, 1); assert.equal((await delivery(ctx)).status, 'dispatching');
  await assert.rejects(ctx.journal.markMessageAccepted(ctx.key, ctx.actionId), { code: 'JOURNAL_ORDER' });
  await assert.rejects(ctx.journal.finishMessageDelivery(ctx.key, ctx.actionId, { status: 'confirmed' }), { code: 'JOURNAL_ORDER' });
  assert.equal(await ctx.journal.markMessageSubmitted(ctx.key, ctx.actionId), true); assert.equal(await other.markMessageSubmitted(ctx.key, ctx.actionId), false);
  assert.equal((await delivery(ctx)).status, 'submitted'); assert.equal(await other.markMessageAccepted(ctx.key, ctx.actionId), true);
  assert.equal(await ctx.journal.markMessageAccepted(ctx.key, ctx.actionId), false); assert.equal((await delivery(ctx)).status, 'accepted');
  assert.equal(await ctx.journal.finishMessageDelivery(ctx.key, ctx.actionId, { status: 'confirmed', durationMs: 12 }), true);
  const receipt = await delivery(ctx); assert.equal(receipt.status, 'confirmed');
  for (const field of ['queuedAt', 'dispatchStartedAt', 'submittedAt', 'acceptedAt', 'finishedAt']) assert.equal(Number.isSafeInteger(receipt[field]), true);
  assert.equal((await other.startMessageDelivery(ctx.key, ctx.actionId)).accepted, false);
});

test('private receipt verification confirms only after persisted dispatch and submission, with no second input grant', async t => {
  const ctx = await fixture(t), nativePath = join(ctx.dir, 'native.jsonl');
  await writeFile(nativePath, JSON.stringify({ type: 'assistant', sessionId: 'native', message: { role: 'assistant', content: 'Prior turn' } }) + '\n');
  const reader = new NativeMessageReceipts({ provider: 'claude', nativeSessionId: 'native', runId: 'process-run', getInputEpoch: () => 0 });
  const { ticket } = await reader.checkpoint(nativePath); await queued(ctx); await ctx.journal.advance(ctx.key);
  const grant = await ctx.journal.startMessageDelivery(ctx.key, ctx.actionId); assert.equal(grant.accepted, true);
  assert.equal((await new PipelineJournal(ctx.dir).read(ctx.key)).actions[0].delivery.status, 'dispatching');
  // Simulated native transport: the actual adapter must write only after this grant.
  await appendFile(nativePath, JSON.stringify({ type: 'user', sessionId: 'native', message: { role: 'user', content: message.message } }) + '\n');
  await ctx.journal.markMessageSubmitted(ctx.key, ctx.actionId); const proof = await reader.verify(ticket, message.message); assert.equal(proof.status, 'confirmed');
  await ctx.journal.finishMessageDelivery(ctx.key, ctx.actionId, proof);
  assert.equal((await delivery(ctx)).status, 'confirmed'); assert.equal((await ctx.journal.startMessageDelivery(ctx.key, ctx.actionId)).accepted, false);
});

test('scheduling needs a started enter message; exits and non-message rows cannot acquire asynchronous ownership', async t => {
  const ctx = await fixture(t); assert.equal((await ctx.journal.scheduleMessage(ctx.key, ctx.actionId, scope())).accepted, false);
  await assert.rejects(ctx.journal.startMessageDelivery(ctx.key, ctx.actionId), { code: 'JOURNAL_DELIVERY_MISSING' });
  for (const type of ['notify', 'webhook', 'run_script']) {
    const row = { id: type, name: type, type, ...(type === 'webhook' ? { url: 'https://example.test/' } : type === 'run_script' ? { script: 'PRIVATE' } : {}) };
    const other = await fixture(t, input(type, { onEnter: [row] })); await other.journal.startAction(other.key, other.actionId);
    await assert.rejects(other.journal.scheduleMessage(other.key, other.actionId, scope()), { code: 'JOURNAL_ORDER' });
  }
  const dir = await temp(t), journal = new PipelineJournal(dir), key = input('exit', { onExit: [message], onEnter: [] }), { move: saved } = await journal.beginMove(key);
  await journal.startAction(key, saved.actions[0].id); await assert.rejects(journal.scheduleMessage(key, saved.actions[0].id, scope()), { code: 'JOURNAL_ORDER' });
  await assert.rejects(journal.finishAction(key, saved.actions[0].id, { status: 'scheduled' }), { code: 'JOURNAL_INVALID' });
});

test('scope and message hashes are captured before asynchronous reads and persist no raw prompt, path or native conversation', async t => {
  const ctx = await fixture(t); await ctx.journal.startAction(ctx.key, ctx.actionId); const target = scope(), pending = ctx.journal.scheduleMessage(ctx.key, ctx.actionId, target);
  target.runId = 'changed'; target.messageHash = 'b'.repeat(64); await pending;
  const saved = await delivery(ctx); assert.equal(saved.runId, 'process-run'); assert.equal(saved.messageHash, scope().messageHash);
  const files = await readdir(await folder(ctx.dir));
  for (const file of files.filter(file => file.endsWith('.json'))) assert.doesNotMatch(await readFile(join(await folder(ctx.dir), file), 'utf8'), /PRIVATE|native\.jsonl|nativeSessionId|Authorization/);
  for (const changed of [{ provider: 'unknown' }, { runId: '../run' }, { sessionId: '' }, { messageHash: 'bad' }, { messageHash: ['a'.repeat(64)] }, { mode: 'unknown' }, { raw: 'PRIVATE' }])
    await assert.rejects(ctx.journal.scheduleMessage(ctx.key, ctx.actionId, scope(changed)), { code: 'JOURNAL_DELIVERY_INVALID' });
});

test('duplicate handoff and terminal acknowledgements never change scope or revive queued, cancelled and uncertain effects', async t => {
  for (const status of ['cancelled', 'timed_out', 'failed', 'unconfirmed']) {
    const ctx = await fixture(t, input(status)); await queued(ctx);
    const duplicate = await ctx.journal.scheduleMessage(ctx.key, ctx.actionId, scope({ runId: 'other' })); assert.equal(duplicate.accepted, false); assert.equal(duplicate.delivery.runId, 'process-run');
    assert.equal(await ctx.journal.finishMessageDelivery(ctx.key, ctx.actionId, { status, reason: 'Delivery stopped.' }), true);
    const revision = (await ctx.journal.read(ctx.key)).revision;
    assert.equal(await ctx.journal.finishMessageDelivery(ctx.key, ctx.actionId, { status: 'confirmed' }), false);
    assert.equal(await ctx.journal.markMessageSubmitted(ctx.key, ctx.actionId), false); assert.equal(await ctx.journal.markMessageAccepted(ctx.key, ctx.actionId), false);
    assert.equal((await ctx.journal.startMessageDelivery(ctx.key, ctx.actionId)).accepted, false);
    assert.equal((await ctx.journal.read(ctx.key)).revision, revision); assert.equal((await delivery(ctx)).status, status);
    await ctx.journal.advance(ctx.key); assert.equal(await ctx.journal.cancelMove(ctx.key), false);
  }
});

test('normal cancellation records pending delivery outcomes first and retains already confirmed action and lifecycle outcomes', async t => {
  const ctx = await fixture(t, input('cancel', { onEnter: [message, { id: 'later', name: 'Later', type: 'notify' }] })); await queued(ctx);
  await assert.rejects(ctx.journal.cancelMove(ctx.key), { code: 'JOURNAL_WORK_ACTIVE' });
  await ctx.journal.finishMessageDelivery(ctx.key, ctx.actionId, { status: 'cancelled' }); assert.equal(await ctx.journal.cancelMove(ctx.key), true);
  const saved = await ctx.journal.read(ctx.key); assert.equal(saved.lifecycle.status, 'succeeded'); assert.equal(saved.actions[0].status, 'scheduled');
  assert.equal(saved.actions[0].delivery.status, 'cancelled'); assert.equal(saved.actions[1].status, 'skipped');
});

test('dead-owner recovery covers every asynchronous delivery phase even after placement completed, while preserving confirmation', async t => {
  const dir = await temp(t), journal = new PipelineJournal(dir);
  for (const phase of ['queued', 'dispatching', 'submitted', 'accepted', 'confirmed']) {
    const key = input(phase); await child(dir, key, `const {move}=await journal.beginMove(key), id=move.actions[0].id;
      await journal.advance(key); await journal.startLifecycle(key); await journal.finishLifecycle(key,{status:'succeeded'}); await journal.startAction(key,id); await journal.scheduleMessage(key,id,scope); await journal.advance(key);
      if(key.transitionId!=='queued') await journal.startMessageDelivery(key,id);
      if(['submitted','accepted','confirmed'].includes(key.transitionId)) await journal.markMessageSubmitted(key,id);
      if(['accepted','confirmed'].includes(key.transitionId)) await journal.markMessageAccepted(key,id);
      if(key.transitionId==='confirmed') await journal.finishMessageDelivery(key,id,{status:'confirmed'});
      console.log(JSON.stringify(await journal.read(key)));`);
  }
  const recovered = await journal.recoverInterrupted(); assert.equal(recovered.length, 4);
  for (const move of recovered) { assert.equal(move.status, 'completed'); assert.equal(move.phase, 'complete'); assert.equal(move.lifecycle.status, 'succeeded'); assert.equal(move.actions[0].status, 'scheduled'); assert.equal(move.actions[0].delivery.status, 'interrupted'); }
  assert.equal((await journal.read(input('confirmed'))).actions[0].delivery.status, 'confirmed'); assert.deepEqual(await journal.recoverInterrupted(), []);
  await assert.rejects(journal.startMessageDelivery(input('queued'), (await journal.read(input('queued'))).actions[0].id), { code: 'JOURNAL_OWNER_MISMATCH' });
});

test('live-owner queued messages remain protected during recovery and cannot be dispatched by another OS process', async t => {
  const ctx = await fixture(t); await queued(ctx); await ctx.journal.advance(ctx.key);
  const reported = await child(ctx.dir, ctx.key, `let code; try{await journal.startMessageDelivery(key,(await journal.read(key)).actions[0].id);}catch(error){code=error.code;}
    console.log(JSON.stringify({recovered:await journal.recoverInterrupted(),code}));`);
  assert.deepEqual(reported, { recovered: [], code: 'JOURNAL_OWNER_MISMATCH' }); assert.equal((await delivery(ctx)).status, 'queued');
});

test('version one moves stay readable and finish through their original synchronous contract without implicit migration', async t => {
  const ctx = await fixture(t); await ctx.journal.startAction(ctx.key, ctx.actionId);
  const location = await folder(ctx.dir);
  for (const file of (await readdir(location)).filter(file => file.endsWith('.json'))) { const path = join(location, file), data = JSON.parse(await readFile(path, 'utf8')); data.version = 1; await writeFile(path, JSON.stringify(data)); }
  const prior = await ctx.journal.read(ctx.key); assert.equal(prior.version, 1);
  await assert.rejects(ctx.journal.scheduleMessage(ctx.key, ctx.actionId, scope()), { code: 'JOURNAL_VERSION_UNSUPPORTED' });
  assert.equal((await ctx.journal.read(ctx.key)).revision, prior.revision); await ctx.journal.finishAction(ctx.key, ctx.actionId, { status: 'unconfirmed' }); await ctx.journal.advance(ctx.key);
  assert.equal((await ctx.journal.read(ctx.key)).version, 1); assert.equal((await ctx.journal.beginMove(ctx.key)).created, false);
});

test('corrupt/newer receipt records fail closed and cannot fall back to queued intent', async t => {
  const ctx = await fixture(t); await queued(ctx); const location = await folder(ctx.dir), names = (await readdir(location)).filter(file => file.endsWith('.json')).sort(), path = join(location, names.at(-1));
  const original = JSON.parse(await readFile(path, 'utf8'));
  for (const mutate of [data => { data.actions[0].delivery.status = 'confirmed'; }, data => { data.actions[0].delivery.raw = 'PRIVATE'; }, data => { data.actions[0].delivery.runId = '../other'; }, data => { data.actions[0].trigger = 'exit'; }, data => { data.version = 99; }]) {
    const changed = structuredClone(original); mutate(changed); await writeFile(path, JSON.stringify(changed));
    const code = changed.version === 99 ? 'JOURNAL_VERSION_UNSUPPORTED' : 'JOURNAL_CORRUPT';
    await assert.rejects(ctx.journal.read(ctx.key), { code }); await assert.rejects(ctx.journal.startMessageDelivery(ctx.key, ctx.actionId), { code });
  }
});

test('receipt outcomes reject raw diagnostics and scheduling alone cannot become generic action success', async t => {
  const ctx = await fixture(t); await queued(ctx);
  for (const outcome of [{ status: 'confirmed', raw: 'PRIVATE' }, { status: 'submitted' }, { status: 'interrupted' }, { status: 'failed', reason: 'x'.repeat(501) }, { status: 'failed', httpStatus: 200 }])
    await assert.rejects(ctx.journal.finishMessageDelivery(ctx.key, ctx.actionId, outcome));
  assert.equal(await ctx.journal.finishAction(ctx.key, ctx.actionId, { status: 'succeeded' }), false); assert.equal((await delivery(ctx)).status, 'queued');
  const runner = new PipelineAutomations({ journal: ctx.journal, deliverMessage: () => { assert.fail('A scheduled action was replayed.'); } }); t.after(() => runner.shutdown());
  const duplicate = await runner.runGroup({ key: ctx.key, trigger: 'enter', rows: [message], context: { task: { id: 'task' }, project: { id: 'project' } } });
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.safeToAdvance, false);
});

test('failed dispatch publication grants no input; a lost final receipt retains submitted ownership and refuses a second dispatch', async t => {
  const ctx = await fixture(t); await queued(ctx); const normalRead = ctx.journal.read.bind(ctx.journal);
  async function blockPublication(operation) {
    let blocked = false;
    ctx.journal.read = async key => {
      const saved = await normalRead(key);
      if (!blocked) { blocked = true; await rename(join(ctx.dir, 'automations'), join(ctx.dir, 'held')); await writeFile(join(ctx.dir, 'automations'), 'blocked'); }
      return saved;
    };
    try { await assert.rejects(operation(), { code: 'JOURNAL_WRITE_FAILED' }); }
    finally { ctx.journal.read = normalRead; await rm(join(ctx.dir, 'automations')); await rename(join(ctx.dir, 'held'), join(ctx.dir, 'automations')); }
  }
  await blockPublication(() => ctx.journal.startMessageDelivery(ctx.key, ctx.actionId)); assert.equal((await delivery(ctx)).status, 'queued');
  assert.equal((await ctx.journal.startMessageDelivery(ctx.key, ctx.actionId)).accepted, true); await ctx.journal.markMessageSubmitted(ctx.key, ctx.actionId);
  await blockPublication(() => ctx.journal.finishMessageDelivery(ctx.key, ctx.actionId, { status: 'confirmed' }));
  assert.equal((await delivery(ctx)).status, 'submitted'); assert.equal((await ctx.journal.startMessageDelivery(ctx.key, ctx.actionId)).accepted, false);
});

test('interrupted unfinished enter groups preserve scheduled handoff and known native confirmation while stopping remaining work', async t => {
  const dir = await temp(t), key = input('unfinished', { onEnter: [message, { id: 'unknown', name: 'Unknown', type: 'notify' }] });
  await child(dir, key, `const {move}=await journal.beginMove(key), [message,unknown]=move.actions;
    await journal.advance(key); await journal.startLifecycle(key); await journal.finishLifecycle(key,{status:'succeeded'});
    await journal.startAction(key,message.id); await journal.scheduleMessage(key,message.id,scope); await journal.startMessageDelivery(key,message.id);
    await journal.markMessageSubmitted(key,message.id); await journal.finishMessageDelivery(key,message.id,{status:'confirmed'});
    await journal.startAction(key,unknown.id); console.log(JSON.stringify(await journal.read(key)));`);
  const journal = new PipelineJournal(dir), [saved] = await journal.recoverInterrupted();
  assert.equal(saved.status, 'interrupted'); assert.equal(saved.phase, 'complete'); assert.equal(saved.lifecycle.status, 'succeeded');
  assert.equal(saved.actions[0].status, 'scheduled'); assert.equal(saved.actions[0].delivery.status, 'confirmed'); assert.equal(saved.actions[1].status, 'interrupted');
});
