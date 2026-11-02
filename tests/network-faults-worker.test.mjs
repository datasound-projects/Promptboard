// Task 14 fault injection on the real local worker (src/network/worker-local.mjs) with the fake headless Claude Code and Codex
// CLIs as the only programs on PATH besides node (no Gemini CLI at all): a Base agent changed between submit and claim runs
// with what was accepted; output lines no adapter knows and a failed tool neither end the job nor leak into events; a
// missing or signed-out CLI fails once and is never retried; output over the limit ends the CLI; an app stop with hung
// CLIs is quick, ends their process groups and relaunches nothing after the restart. No real CLI, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installFakeClis, skipFakes as skip, tick, until } from './helpers/network-e2e.mjs';
import { fixture } from './helpers/network-machine.mjs';

const fakes = await installFakeClis(['claude', 'codex']);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const real = { networkWorker: undefined }; // The app's own LocalJobWorker.

async function setup(t, dataDir) {
  const ctx = await fixture(t, { ...(dataDir ? { dataDir } : {}), serverOptions: real });
  const ok = async (path, method, body, status = 200) => { const answer = await ctx.owner(path, method, body); assert.equal(answer.status, status, `${method || 'GET'} ${path}: ${answer.text}`); return answer.json; };
  const job = async id => (await ok(`/api/network/jobs/${id}`)).job;
  const submit = async (agentId, text, extra = {}) => (await ok('/api/network/jobs', 'POST', { agentId, input: { text }, ...extra }, 202)).jobId;
  const settled = id => until(async () => { const value = await job(id); return ['completed', 'failed', 'cancelled', 'unknown', 'interrupted', 'waiting_for_approval'].includes(value.status) && value; }, `job ${id} settles`, 30000);
  const cli = async marker => (await fakes.runs()).filter(run => run.input.includes(marker));
  return { ctx, ok, job, submit, settled, cli };
}

test('a Base agent changed between submit and claim: the job runs with the model and instructions it was accepted with', { skip, timeout: 60000 }, async t => {
  const { ctx, ok, job, submit, settled, cli } = await setup(t);
  const lead = await ctx.register('lead');
  const id = await submit(lead.id, 'Pinned at submit.', { requireApproval: true });
  const before = (await ok(`/api/network/jobs/${id}`)).request.agent;
  const resource = (await ctx.app.board.base.list()).resources.find(item => item.id === 'lead');
  await ctx.app.board.base.update('lead', { configuration: { agent: { provider: 'claude', model: 'opus', instructions: 'CHANGED-INSTRUCTIONS after the submit.' } } }, { expectedRevision: resource.revision });
  assert.equal((await ok(`/api/network/agents/${lead.id}`)).agent.base.model, 'opus', 'the registration shows the change');
  await ok(`/api/network/jobs/${id}/approve`, 'POST', { expectedRevision: (await job(id)).revision, decision: 'approve' });
  assert.equal((await settled(id)).status, 'completed');
  const [run] = await cli('Pinned at submit.');
  assert.deepEqual([before.model, run.args[run.args.indexOf('--model') + 1]], ['sonnet', 'sonnet'], 'the model accepted at submit');
  assert.ok(run.input.includes('SECRET-INSTRUCTIONS stay in Base.') && !run.input.includes('CHANGED-INSTRUCTIONS'), 'the instructions accepted at submit');
});

test('output no adapter knows and a failed tool: Claude and Codex jobs still complete on their structured answer; the tool shows as activity; no path from the tool or the odd lines reaches an event or the activity log', { skip, timeout: 60000 }, async t => {
  const { ctx, ok, submit, settled } = await setup(t);
  const lead = await ctx.register('lead'), scout = await ctx.register('scout');
  for (const [agent, cliName] of [[lead, 'claude'], [scout, 'codex']]) {
    const id = await submit(agent.id, `[[odd]] [[toolfail]] Odd output from ${cliName}.`);
    const done = await settled(id);
    assert.equal(done.status, 'completed', `${cliName}: ${JSON.stringify(done)}`);
    assert.equal((await ok(`/api/network/jobs/${id}/result`)).text, `Answer from ${cliName}.`);
    const events = (await ok(`/api/network/events?after=0&limit=200&jobId=${id}`)).events;
    assert.ok(events.some(event => event.type === 'job.activity' && event.kind === 'tool'), `${cliName}: the tool call is activity`);
    const attempt = join(ctx.dataDir, 'network', 'jobs', `job__${id.slice(4)}`, 'attempts', `att__${done.attempts[0].id.slice(4)}`);
    for (const text of [JSON.stringify(events), await readFile(join(attempt, 'stream.jsonl'), 'utf8')]) assert.ok(!text.includes('/Users/someone') && !text.includes('secret.txt') && !text.includes('not json'), `${cliName}: ${text.slice(0, 300)}`);
  }
});

test('a missing or signed-out CLI fails once and is never retried; output over the limit ends the CLI', { skip, timeout: 60000 }, async t => {
  const { ctx, job, submit, settled, cli } = await setup(t);
  const lead = await ctx.register('lead'), gem = await ctx.register('gem');
  const missing = await submit(gem.id, 'No Gemini CLI here.'), signedOut = await submit(lead.id, '[[auth]] Signed out.'), big = await submit(lead.id, '[[big]] Too much.');
  assert.deepEqual([(await settled(missing)).errorCode, (await settled(signedOut)).errorCode, (await settled(big)).errorCode], ['NOT_INSTALLED', 'AUTH_REQUIRED', 'OUTPUT_LIMIT']);
  const [bigRun] = await cli('Too much.');
  await until(() => !alive(bigRun.pid), 'the CLI with too much output is gone', 10000);
  await tick(1500);
  for (const id of [missing, signedOut, big]) assert.deepEqual([(await job(id)).status, (await job(id)).attempts.length], ['failed', 1], `${id}: no retry`);
  assert.deepEqual([(await cli('Signed out.')).length, (await cli('No Gemini CLI here.')).length], [1, 0], 'one CLI run for the signed-out job; none without a CLI');
});

test('an app stop with hung CLIs is quick, ends their process groups, saves them interrupted, and the restart relaunches nothing', { skip, timeout: 60000 }, async t => {
  const first = await setup(t);
  const lead = await first.ctx.register('lead'), scout = await first.ctx.register('scout');
  const ids = [await first.submit(lead.id, '[[hang]] Hung Claude.'), await first.submit(scout.id, '[[hang]] Hung Codex.')];
  await until(async () => (await Promise.all(ids.map(first.job))).every(job => job.status === 'running'), 'both run', 30000);
  const hung = await until(async () => { const runs = (await fakes.runs()).filter(run => run.input.includes('[[hang]]')); return runs.length === 2 && runs; }, 'both CLIs started', 10000);
  const started = Date.now();
  await first.ctx.app.close();
  const took = Date.now() - started;
  assert.ok(took < 10000, `the app stopped in ${took} ms`);
  for (const run of hung) await until(() => !alive(run.pid) && !alive(run.helper), `${run.cli} and its helper gone`, 10000);
  const second = await setup(t, first.ctx.dataDir);
  for (const id of ids) {
    const job = await second.job(id);
    assert.deepEqual([job.status, job.outcome, job.attempts.length], ['interrupted', 'uncertain', 1], id);
  }
  const runs = (await fakes.runs()).length;
  await tick(1500);
  assert.equal((await fakes.runs()).length, runs, 'nothing was relaunched');
  assert.deepEqual((await readdir(join(first.ctx.dataDir, 'network', 'jobs'))).length, 2);
});
