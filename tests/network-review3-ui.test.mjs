// Task 12 review (phase 3), the page side in jsdom against the real server: a double-click on a schedule's Run now starts one
// job, not two, also when the list is drawn again while the request is in flight (P3-7). No worker, so jobs stay queued.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, until } from './helpers/ui-harness.mjs';

async function call(ctx, path, method = 'GET', body) {
  const response = await fetch(`${ctx.app.url}${path}`, { method, headers: { 'X-STE-Token': ctx.win.__pbTest.token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, json: await response.json() };
}

test('P3-7: a double-click on a schedule’s Run now starts one job; the button stays off while its request is in flight', async t => {
  const ctx = await setup(t, { executor: null }), { $, win } = ctx;
  await ctx.app.board.base.create({ id: 'lead', kind: 'profile', name: 'Lead', configuration: { agent: { provider: 'claude' } } });
  const { agent } = (await call(ctx, '/api/network/agents', 'POST', { baseResourceId: 'lead', expectedRevision: 0 })).json;
  const schedule = async (name, revision) => (await call(ctx, '/api/network/schedules', 'POST', { expectedRevision: revision, name, target: { agentId: agent.id, input: { text: 'Summarise.' } }, cadence: { kind: 'on_demand' } })).json.schedule;
  const digest = await schedule('Digest', 0), other = await schedule('Other', 1);
  const jobsOf = async id => (await call(ctx, '/api/network/jobs?limit=200')).json.jobs.filter(job => job.requester.kind === 'schedule' && job.requester.id === id);
  // Run now's requests for the digest wait until the test lets them through: the request is in flight.
  let release; const gate = new Promise(resolve => { release = resolve; }), held = [];
  const pageFetch = win.fetch;
  win.fetch = (url, options) => { if (String(url).includes(`/schedules/${digest.id}/run`)) { held.push(url); return gate.then(() => pageFetch(url, options)); } return pageFetch(url, options); };
  win.location.hash = '#/network/activity';
  const run = () => $(`#network-schedule-run-${digest.id}`);
  await until(() => run() && $('#network-activity-live')?.dataset.state === 'live', 'Run now shown, live');
  const first = run();
  first.click(); first.click();
  assert.equal(first.disabled, true, 'off while its request is in flight');
  // The list is drawn again meanwhile (a schedule event from another schedule's Run now): the new button is off too.
  await call(ctx, `/api/network/schedules/${other.id}/run`, 'POST', {});
  await until(() => !first.isConnected && run(), 'the list drawn again');
  assert.equal(run().disabled, true, 'a row drawn again while the request is in flight keeps Run now off');
  run().click();
  release();
  await until(async () => (await jobsOf(digest.id)).length >= 1 && run() && !run().disabled, 'the request answered');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual([held.length, (await jobsOf(digest.id)).length], [1, 1], 'one double-click, one request, one job');
  run().click(); // a later click is a new intent
  await until(async () => (await jobsOf(digest.id)).length === 2, 'Run now again');
});
