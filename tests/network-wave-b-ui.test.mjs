// Wave B integration in the page (jsdom, real server, the deterministic fake worker): a pipeline run view shows a step whose
// job asked a question or waits for the sub-jobs it delegated (Task 12), and leads to the job's record where the owner answers
// or approves; the Schedules editor (Task 12) makes pipeline schedules of published versions only, and shows what a run does
// (Task 10's run facts) before it is switched on or run now. No CLI runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setup } from './helpers/ui-harness.mjs';
import { fakeWorker } from './helpers/network-worker.mjs';

const hex = text => createHash('sha256').update(text).digest('hex');
const N = name => `n_${hex(`step:${name}`).slice(0, 12)}`;
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, ms = 10000) {
  for (const end = Date.now() + ms; Date.now() < end; await tick(10)) { const value = await check(); if (value) return value; }
  assert.fail(`timed out: ${label}`);
}
async function call(ctx, path, method = 'GET', body) {
  const response = await fetch(`${ctx.app.url}${path}`, { method, headers: { 'X-STE-Token': ctx.win.__pbTest.token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, json: await response.json() };
}
async function agent(ctx, id, name) {
  await ctx.app.board.base.create({ id, kind: 'profile', name, configuration: { agent: { provider: 'claude' } } });
  const { json: list } = await call(ctx, '/api/network/agents');
  return (await call(ctx, '/api/network/agents', 'POST', { baseResourceId: id, expectedRevision: list.revision })).json.agent;
}
/** Lead may delegate to Helper in the published network "Desk". */
async function desk(ctx) {
  const lead = await agent(ctx, 'lead', 'Lead'), helper = await agent(ctx, 'helper', 'Helper');
  const { json: { network } } = await call(ctx, '/api/network/networks', 'POST', { name: 'Desk', nodes: [lead, helper].map((item, i) => ({ id: N(`member${i}`), type: 'agent', agentId: item.id, position: { x: i * 200, y: 0 } })),
    edges: [{ id: `e_${hex('delegate').slice(0, 12)}`, from: N('member0'), to: N('member1'), relation: 'delegate' }] });
  await call(ctx, `/api/network/networks/${network.id}/publish`, 'POST', { expectedRevision: network.revision });
  return { lead, helper, network };
}
/** A one-step pipeline (Lead → report), published `versions` times. */
async function pipelineOf(ctx, { lead, network }, name, instructions, versions = 1) {
  let { json: { pipeline } } = await call(ctx, '/api/network/pipelines', 'POST', { networkId: network.id, networkVersion: 1, name,
    nodes: [{ id: N('lead'), type: 'agent', label: 'Lead', position: { x: 0, y: 0 }, config: { agentId: lead.id, instructions } }, { id: N('report'), type: 'output', label: 'Report', position: { x: 200, y: 0 }, config: { name: 'report', include: [N('lead')] } }],
    edges: [{ id: `e_${hex(name).slice(0, 12)}`, from: N('lead'), to: N('report'), fromPort: 'text' }] });
  for (let n = 0; n < versions; n++) {
    if (n) pipeline = (await call(ctx, `/api/network/pipelines/${pipeline.id}`, 'PATCH', { expectedRevision: pipeline.revision, description: `Edition ${n + 1}.` })).json.pipeline;
    pipeline = (await call(ctx, `/api/network/pipelines/${pipeline.id}/publish`, 'POST', { expectedRevision: pipeline.revision })).json.pipeline;
  }
  return pipeline;
}
const stepChip = ctx => ctx.$(`#network-run-steps [data-step-id="${N('lead')}"] .base-status`)?.textContent || '';

test('Run view: a step whose job asked a question or waits for its sub-jobs says so, and leads to the job’s record, where the owner answers or approves; the run then completes', async t => {
  const asks = new Map();
  const worker = fakeWorker({ text: job => (job.handoff?.context ? 'Final.' : 'Draft.'), json: job => (job.handoff?.context ? null : asks.get(job.request.instructions) ?? null) });
  const ctx = await setup(t, { hash: '#/network/activity', networkWorker: worker, executor: null }); const { $, win } = ctx;
  const seeded = await desk(ctx);
  asks.set('ASK', { promptboard: { needs_input: { question: 'Which region?' } } });
  asks.set('DELEGATE', { promptboard: { delegate: [{ agentId: seeded.helper.id, task: 'Check the numbers.' }] } });
  await call(ctx, '/api/network/delegation', 'PATCH', { expectedRevision: 0, delegate: true, askOwner: true }); // Sub-jobs wait for approval (the default).
  const asking = await pipelineOf(ctx, seeded, 'Asking', 'ASK'), delegating = await pipelineOf(ctx, seeded, 'Delegating', 'DELEGATE');

  // A question: the step row, the summary and the step's details say it waits for your answer.
  const run1 = (await call(ctx, `/api/network/pipelines/${asking.id}/runs`, 'POST', { version: 1, confirm: true })).json.runId;
  win.location.hash = `#/network/runs/${run1}`;
  await until(() => /Waiting for your answer/.test(stepChip(ctx)), 'the step waits for your answer');
  assert.match($('#network-run-summary').textContent, /“Lead” waits for your answer/);
  assert.equal($('#network-run-status').textContent, 'Running', 'the run itself is running');
  $(`#network-run-steps [data-step-id="${N('lead')}"]`).click();
  await until(() => $('#network-run-step-handoff'), 'the step’s details');
  assert.match($('#network-run-step-handoff').textContent, /Its agent asked you a question: Which region\? The step waits for your answer.*deadline keeps counting/);
  assert.equal($('#network-run-step-status').textContent, 'Waiting for your answer');
  const [job1] = (await call(ctx, `/api/network/jobs?pipelineRunId=${run1}`)).json.jobs;
  // The agent's Tasks tab names the wait too and leads to the same record.
  win.location.hash = `#/network/agents/${seeded.lead.id}`;
  await until(() => $('#network-profile-tab-tasks'), 'the profile');
  $('#network-profile-tab-tasks').click();
  await until(() => $(`#network-job-${job1.id}-record`), 'the job in Tasks with its answer link');
  assert.equal($(`#network-job-${job1.id}-record`).textContent, 'Answer…');
  $(`#network-job-${job1.id}-record`).click();
  await until(() => win.location.hash === `#/network/activity/${job1.id}` && $('#network-handoff-answer'), 'the record from Tasks');
  win.location.hash = `#/network/runs/${run1}`;
  await until(() => $(`#network-run-steps [data-step-id="${N('lead')}"]`) && /Waiting for your answer/.test(stepChip(ctx)), 'back in the run view');
  $(`#network-run-steps [data-step-id="${N('lead')}"]`).click();
  await until(() => $('#network-run-handoff'), 'the step’s details again');
  $('#network-run-handoff').click();
  await until(() => win.location.hash === `#/network/activity/${job1.id}` && $('#network-handoff-answer'), 'the job’s record with the answer form');
  $('#network-handoff-answer').value = 'Europe.';
  $('#network-handoff-answer').closest('form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await until(async () => (await call(ctx, `/api/network/pipeline-runs/${run1}`)).json.run.status === 'completed', 'run 1 completed after the answer');
  win.location.hash = `#/network/runs/${run1}`;
  await until(() => $('#network-run-status')?.textContent === 'Completed' && /Completed/.test(stepChip(ctx)), 'the run view shows it completed');

  // Sub-jobs: the step waits for them; its details lead to the record, where the owner approves the sub-job.
  const run2 = (await call(ctx, `/api/network/pipelines/${delegating.id}/runs`, 'POST', { version: 1, confirm: true })).json.runId;
  win.location.hash = `#/network/runs/${run2}`;
  await until(() => /Waiting for sub-jobs/.test(stepChip(ctx)), 'the step waits for its sub-jobs');
  assert.match($('#network-run-summary').textContent, /“Lead” waits for its sub-jobs/);
  $(`#network-run-steps [data-step-id="${N('lead')}"]`).click();
  await until(() => /Waiting for 1 of its 1 delegated sub-jobs/.test($('#network-run-step-handoff')?.textContent || ''), 'the step’s details');
  const [job2] = (await call(ctx, `/api/network/jobs?pipelineRunId=${run2}`)).json.jobs;
  const [childId] = await until(async () => { const { json } = await call(ctx, `/api/network/jobs/${job2.id}`); return json.children.length === 1 && json.children; }, 'the sub-job is written');
  assert.equal($('#network-run-handoff').textContent, 'Open its sub-jobs');
  $('#network-run-handoff').click();
  await until(() => win.location.hash === `#/network/activity/${job2.id}` && $(`#network-approve-${childId}`), 'the record with the sub-job’s approval');
  $(`#network-approve-${childId}`).click();
  await until(async () => (await call(ctx, `/api/network/pipeline-runs/${run2}`)).json.run.status === 'completed', 'run 2 completed after the approval');
  assert.equal((await call(ctx, `/api/network/jobs?pipelineRunId=${run2}`)).json.total, 1, 'one step job');
});

test('Schedules: a pipeline schedule of a published version only, saved off; Switch on… and Run now show what a run does first; Last run opens it; a version that cannot start cannot be switched on', async t => {
  const ctx = await setup(t, { hash: '#/network/activity', networkWorker: fakeWorker(), executor: null }); const { $, win } = ctx;
  const seeded = await desk(ctx), digest = await pipelineOf(ctx, seeded, 'Digest', 'Summarise.', 2);
  await call(ctx, '/api/network/pipelines', 'POST', { networkId: seeded.network.id, networkVersion: 1, name: 'Draft only', nodes: [], edges: [] });
  const runs = async () => (await call(ctx, '/api/network/pipeline-runs')).json.total;
  await until(() => /No schedules\./.test($('#network-schedules')?.textContent || ''), 'empty list');
  $('#network-schedule-new').click();
  await until(() => $('#network-schedule-kind'), 'editor');
  assert.equal($('#network-schedule-kind').value, 'job');
  ctx.choose('#network-schedule-kind', 'pipeline');
  assert.deepEqual([...$('#network-schedule-pipeline').options].map(option => [option.value, option.textContent]), [[`${digest.id}@2`, 'Digest · version 2 (latest)'], [`${digest.id}@1`, 'Digest · version 1']], 'published versions only');
  assert.equal($('#network-schedule-agent').closest('.network-schedule-part').hidden, true, 'the job fields are hidden');
  await until(() => /Steps2 steps after sub-pipelines are expanded; 1 agent job\..*Cost/.test($('#network-schedule-facts')?.textContent || ''), 'the run facts of the chosen version');
  ctx.choose('#network-schedule-pipeline', `${digest.id}@1`);
  $('#network-schedule-name').value = 'Nightly digest'; $('#network-schedule-run-input').value = 'Today’s notes.';
  $('.network-schedule-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => $('#network-schedules-list li'), 'saved');
  const [row] = (await call(ctx, '/api/network/schedules')).json.schedules;
  assert.deepEqual([row.target, row.enabled, await runs()], [{ pipelineId: digest.id, version: 1, input: { text: 'Today’s notes.' } }, false, 0], 'saved off; nothing ran');
  const item = () => $('#network-schedules-list li');
  assert.match(item().textContent, /Nightly digest–OffDigest · version 1 · Every day at 02:00/);

  // Switch on… shows the run facts first; it starts nothing now (slots count from the confirmation).
  $(`#network-schedule-toggle-${row.id}`).click();
  await until(() => $('#network-schedule-confirm') && !$('#network-schedule-confirm').disabled, 'the confirmation, enabled once the version is checked');
  assert.match($('#network-handoff-dialog').textContent, /It will start a run of Digest · version 1 every day at 02:00 .*Each run does what a run started from Pipelines does:.*1 agent job.*Not enforced, and unknown before it runs.*previous run is still open/s);
  $('#network-schedule-confirm').click();
  await until(() => /✓On/.test(item()?.textContent || ''), 'switched on');
  assert.equal(await runs(), 0);

  // Run now asks first, with the same facts, then starts one run; Last run opens it.
  $(`#network-schedule-run-${row.id}`).click();
  await until(() => $('#network-schedule-run-confirm') && !$('#network-schedule-run-confirm').disabled, 'the Run now confirmation');
  assert.match($('#network-handoff-dialog').textContent, /It starts one run of Digest · version 1 now.*1 agent job/s);
  assert.equal(await runs(), 0, 'nothing before Start run');
  $('#network-schedule-run-confirm').click();
  await until(async () => (await runs()) === 1 && $(`#network-schedule-last-run-${row.id}`), 'one run and its link');
  const { json: { runs: [started] } } = await call(ctx, '/api/network/pipeline-runs');
  const { json: { run: scheduled } } = await call(ctx, `/api/network/pipeline-runs/${started.id}`), { json: { events } } = await call(ctx, `/api/network/events?after=0&pipelineRunId=${started.id}`);
  assert.deepEqual([scheduled.history[0].by, events.find(event => event.type === 'pipeline.run' && event.from === undefined)?.by], ['schedule', 'schedule'], 'a scheduled run says a schedule started it');
  $(`#network-schedule-last-run-${row.id}`).click();
  await until(() => win.location.hash === `#/network/runs/${started.id}` && /Started .* by a schedule/.test($('#network-run-meta')?.textContent || ''), 'the run view says a schedule started it');

  // Edit keeps the pipeline target; another version switches it off.
  win.location.hash = '#/network/activity';
  await until(() => $(`#network-schedule-edit-${row.id}`), 'list again');
  $(`#network-schedule-edit-${row.id}`).click();
  await until(() => $('#network-schedule-kind')?.value === 'pipeline' && $('#network-schedule-pipeline').value === `${digest.id}@1` && $('#network-schedule-run-input').value === 'Today’s notes.', 'the edit form');
  ctx.choose('#network-schedule-pipeline', `${digest.id}@2`);
  $('.network-schedule-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => /–Off/.test(item()?.textContent || '') && /version 2/.test(item().textContent), 'switched off by the edit');

  // A version that cannot start now (its agent switched off) cannot be switched on: the confirmation says why.
  await call(ctx, `/api/network/agents/${seeded.lead.id}`, 'PATCH', { expectedRevision: seeded.lead.revision, enabled: false });
  $(`#network-schedule-toggle-${row.id}`).click();
  await until(() => /This version cannot start now/.test($('#network-schedule-facts')?.textContent || ''), 'refused in the confirmation');
  assert.equal($('#network-schedule-confirm').disabled, true);
  assert.equal((await call(ctx, '/api/network/schedules')).json.schedules[0].enabled, false);
});

test('Activity: a job read from its backup copy reads as such in the timeline, under Job status', async t => {
  const ctx = await setup(t, { hash: '#/network/activity', executor: null }); const { $ } = ctx;
  await until(() => $('#network-activity-live')?.dataset.state === 'live', 'the event stream is live');
  const jobId = `job_${'a'.repeat(20)}`;
  await ctx.app.networkEvents.append({ type: 'job.recovered', jobId, status: 'interrupted', by: 'app', errorCode: 'RESTORED_FROM_BACKUP', message: 'Its saved record was damaged, so it was read from its backup copy.' });
  const item = await until(() => $('#network-activity-feed li[data-type="job.recovered"], li.network-event[data-type="job.recovered"]'), 'the event in the timeline');
  assert.match(item.querySelector('.network-event-title').textContent, /^Job aaaaaa: read from its backup copy · Interrupted: needs your decision$/);
  ctx.choose('#network-activity-kind', 'job.status');
  assert.ok($('li.network-event[data-type="job.recovered"]'), 'shown under Job status');
});
