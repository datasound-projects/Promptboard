// Task 12 UI (public/network-delegation.js inside Network → Activity and Settings) in jsdom against the real server: the
// handoff policy card (off by default, saved with its revision); a delegating job's record with its origin, the sub-job tree
// and its approval request, the handoff messages and the timeline's words for them; a sub-job's record linking back; a
// question answered from the record without a live redraw dropping the typed answer, read marks and notes; and the Schedules
// list (new, switch on with a confirmation, Run now, an edit that switches it off, delete). Jobs run through the
// deterministic fake worker; no CLI runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setup, until } from './helpers/ui-harness.mjs';
import { fakeWorker } from './helpers/network-worker.mjs';

const hex = text => createHash('sha256').update(text).digest('hex');
async function call(ctx, path, method = 'GET', body) {
  const response = await fetch(`${ctx.app.url}${path}`, { method, headers: { 'X-STE-Token': ctx.win.__pbTest.token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, json: await response.json() };
}
async function agent(ctx, id, name, provider = 'claude') {
  await ctx.app.board.base.create({ id, kind: 'profile', name, configuration: { agent: { provider } } });
  const { json: list } = await call(ctx, '/api/network/agents');
  return (await call(ctx, '/api/network/agents', 'POST', { baseResourceId: id, expectedRevision: list.revision })).json.agent;
}
const job = async (ctx, id) => (await call(ctx, `/api/network/jobs/${id}`)).json.job;
const submitForm = (ctx, selector) => ctx.$(selector).dispatchEvent(new ctx.win.Event('submit', { bubbles: true, cancelable: true }));
const byText = (root, text) => [...root.querySelectorAll('button')].find(node => node.textContent === text);
async function waitFor(check, label, ms = 10000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 10))) { const value = await check(); if (value) return value; }
  assert.fail(`Timed out: ${label}`);
}

test('Settings: the handoff policy is off by default and saved with its revision', async t => {
  const ctx = await setup(t, { hash: '#/network/settings', executor: null }), { $ } = ctx;
  await until(() => /Off: agents cannot ask questions or delegate\./.test($('#network-handoff-status')?.textContent || ''), 'policy loaded');
  assert.deepEqual([$('#network-handoff-ask').checked, $('#network-handoff-delegate').checked, $('#network-handoff-approve').checked, $('#network-handoff-depth').value, $('#network-handoff-children').value, $('#network-handoff-share').value],
    [false, false, true, '2', '3', '50']);
  assert.equal($('#network-handoff-delegate').getAttribute('role'), 'switch');
  $('#network-handoff-delegate').checked = true; $('#network-handoff-depth').value = '3';
  $('#network-handoff-save').click();
  await until(() => /Delegation on \(up to 3 deep, 3 sub-jobs per job\)/.test($('#network-handoff-status').textContent), 'saved');
  const { json } = await call(ctx, '/api/network/delegation');
  assert.deepEqual([json.policy.delegate, json.policy.maxDepth, json.policy.revision], [true, 3, 1]);
});

test('Activity: a delegating job’s record shows its sub-job tree with the approval request, the handoff messages and where each job came from; the parent goes on after approval', async t => {
  const asks = new Map();
  const worker = fakeWorker({ text: job => (job.handoff?.context ? `Final: ${job.request.input.text}` : `Report for: ${job.request.input.text}`), json: job => (job.handoff?.context ? null : asks.get(job.request.input.text) ?? null) });
  const ctx = await setup(t, { hash: '#/network/activity', networkWorker: worker, executor: null }), { $, win } = ctx;
  const lead = await agent(ctx, 'lead', 'Lead'), helper = await agent(ctx, 'helper', 'Helper');
  const N = id => `n_${hex(id).slice(0, 12)}`;
  const { json: { network } } = await call(ctx, '/api/network/networks', 'POST', { name: 'Team', nodes: [lead, helper].map(item => ({ id: N(item.id), type: 'agent', agentId: item.id, position: { x: 0, y: 0 } })),
    edges: [{ id: `e_${hex('edge').slice(0, 12)}`, from: N(lead.id), to: N(helper.id), relation: 'delegate' }] });
  await call(ctx, '/api/network/delegation', 'PATCH', { expectedRevision: 0, delegate: true, askOwner: true });
  asks.set('Write the summary.', { promptboard: { delegate: [{ agentId: helper.id, task: 'Check the numbers.' }] } });
  const { json: { jobId } } = await call(ctx, '/api/network/jobs', 'POST', { agentId: lead.id, input: { text: 'Write the summary.' }, networkId: network.id });
  const [childId] = await waitFor(async () => { const { json } = await call(ctx, `/api/network/jobs/${jobId}`); return json.children.length === 1 && json.children; }, 'sub-job made');
  win.location.hash = `#/network/activity/${jobId}`;
  await until(() => $(`#network-approve-${childId}`), 'the sub-job tree with its approval request');
  const view = $('#network-activity-job');
  assert.match(view.textContent, /Started byYou/);
  assert.match(view.textContent, /Waiting for sub-jobs.*Waiting for 1 of its 1 delegated sub-jobs/s);
  assert.match(view.querySelector('.network-handoff-tree').textContent, /Waiting for your approval.*Helper.*delegated by the agent · depth 1/s);
  await until(() => $('#network-handoff-messages')?.textContent.includes('Check the numbers.'), 'the request message');
  assert.match($('#network-handoff-messages').textContent, /RequestLead → Helper/);
  // The timeline names the handoff without its text.
  await until(() => [...$('#network-activity-job-events').querySelectorAll('li')].some(item => /delegated sub-jobs/.test(item.textContent)), 'handoff event');
  assert.ok(![...$('#network-activity-job-events').querySelectorAll('li')].some(item => item.textContent.includes('Check the numbers')), 'no task text in an event');
  $(`#network-approve-${childId}`).click();
  await until(async () => (await job(ctx, jobId)).status === 'completed', 'the parent goes on and completes');
  await until(() => /ResultHelper → Lead/.test($('#network-handoff-messages')?.textContent || '') && /Report for: Check the numbers\./.test($('#network-handoff-messages').textContent), 'the result came back');
  // The sub-job's record links back to its parent.
  win.location.hash = `#/network/activity/${childId}`;
  await until(() => $('#network-job-parent'), 'child record');
  assert.match($('#network-activity-job').textContent, new RegExp(`Started byDelegated by the agent of job ${jobId.slice(4, 10)} · depth 1`));
  $('#network-job-parent').click();
  await until(() => win.location.hash === `#/network/activity/${jobId}`, 'back to the parent');
  // The queue row of an open sub-job names its parent.
  asks.set('Second.', { promptboard: { delegate: [{ agentId: helper.id, task: 'More numbers.' }] } });
  const second = (await call(ctx, '/api/network/jobs', 'POST', { agentId: lead.id, input: { text: 'Second.' }, networkId: network.id })).json.jobId;
  win.location.hash = '#/network/activity';
  await until(() => [...$('#network-activity-queue').querySelectorAll('li')].some(item => new RegExp(`sub-job of job ${second.slice(4, 10)}`).test(item.textContent)), 'queue row origin');
});

test('Activity: a question is answered from the job’s record; a live redraw keeps the typed answer; read marks and notes', async t => {
  const worker = fakeWorker({ text: job => (job.handoff?.context ? 'Final plan.' : 'Draft plan.'), json: job => (job.handoff?.context ? null : { promptboard: { needs_input: { question: 'Which market first?' } } }) });
  const ctx = await setup(t, { hash: '#/network/activity', networkWorker: worker, executor: null }), { $, win } = ctx;
  const lead = await agent(ctx, 'lead', 'Lead');
  await call(ctx, '/api/network/delegation', 'PATCH', { expectedRevision: 0, askOwner: true });
  const { json: { jobId } } = await call(ctx, '/api/network/jobs', 'POST', { agentId: lead.id, input: { text: 'Plan the launch.' } });
  await until(async () => (await job(ctx, jobId)).status === 'waiting_for_input', 'waiting');
  win.location.hash = `#/network/activity/${jobId}`;
  await until(() => $('#network-handoff-answer') && /Which market first\?/.test($('#network-handoff-question')?.textContent || ''), 'question shown');
  assert.match($('#network-handoff-read').textContent, /Mark 1 message as read/);
  $('#network-handoff-answer').value = 'Germany first.';
  $('#network-handoff-answer').focus();
  // A note (and its event) redraws the record: the answer being typed stays, and so does the focus.
  assert.equal($('#network-handoff-notes').open, false, 'the note form is folded away');
  $('#network-handoff-notes').open = true;
  $('#network-handoff-note').value = 'Keep it short.';
  submitForm(ctx, '#network-handoff-notes form');
  await until(() => /Review noteYou → Lead/.test($('#network-handoff-messages')?.textContent || ''), 'note listed');
  assert.equal($('#network-handoff-answer').value, 'Germany first.');
  $('#network-handoff-read').click();
  await until(() => !$('#network-handoff-read') && !$('#network-handoff-messages .network-handoff-unread'), 'read');
  assert.equal((await job(ctx, jobId)).status, 'waiting_for_input', 'a read mark changes nothing about the job');
  submitForm(ctx, '#network-handoff-answer');
  await until(async () => (await job(ctx, jobId)).status === 'completed', 'answered and completed');
  await until(() => /ResultYou → Lead/.test($('#network-handoff-messages')?.textContent || ''), 'answer recorded');
  assert.ok(!$('#network-handoff-question'), 'no question once it is answered');
});

test('Activity: Schedules — new (off), switched on after a confirmation, Run now, an edit that switches it off, delete', async t => {
  const ctx = await setup(t, { hash: '#/network/activity', executor: null }), { $, win } = ctx;
  await agent(ctx, 'lead', 'Lead');
  await until(() => $('#network-schedules') && /No schedules\./.test($('#network-schedules').textContent), 'empty list');
  assert.match($('#network-schedules').textContent, /Times are this computer’s \(.+\)\. A schedule starts nothing until you switch it on at this computer/);
  $('#network-schedule-new').click();
  await until(() => $('#network-handoff-dialog')?.open && win.document.activeElement?.id === 'network-schedule-name', 'editor');
  assert.deepEqual([$('#network-schedule-repeat').value, $('#network-schedule-time').value, $('.network-schedule-days').hidden], ['daily', '02:00', true]);
  ctx.choose('#network-schedule-repeat', 'weekly');
  assert.equal($('.network-schedule-days').hidden, false);
  submitForm(ctx, '.network-schedule-form');
  await until(() => /Name the schedule\./.test($('#network-handoff-dialog').textContent), 'validation');
  $('#network-schedule-name').value = 'Weekly digest'; $('#network-schedule-text').value = 'Summarise the week.';
  submitForm(ctx, '.network-schedule-form');
  await until(() => !$('#network-handoff-dialog').open && $('#network-schedules-list li'), 'saved');
  const item = () => $('#network-schedules-list li');
  assert.match(item().textContent, /Weekly digest–OffLead · Every Mon at 02:00/);
  const [{ id }] = (await call(ctx, '/api/network/schedules')).json.schedules;
  assert.equal((await call(ctx, '/api/network/jobs')).json.total, 0, 'saving started nothing');
  $(`#network-schedule-toggle-${id}`).click();
  await until(() => $('#network-schedule-confirm'), 'confirmation');
  assert.match($('#network-handoff-dialog').textContent, /It will start a job for Lead every mon at 02:00 .* without asking you each time/);
  $('#network-schedule-confirm').click();
  await until(() => /✓On/.test(item()?.textContent || '') && /next /.test(item().textContent), 'switched on');
  $(`#network-schedule-run-${id}`).click();
  await until(async () => (await call(ctx, '/api/network/jobs')).json.total === 1, 'Run now');
  await until(() => [...$('#network-activity-queue').querySelectorAll('li')].some(row => /from a schedule/.test(row.textContent)), 'queue row from a schedule');
  $(`#network-schedule-edit-${id}`).click();
  await until(() => $('#network-schedule-text')?.value === 'Summarise the week.', 'edit form');
  assert.match($('#network-handoff-dialog').textContent, /switches it off until you switch it on again at this computer/);
  $('#network-schedule-text').value = 'Summarise the week, briefly.';
  submitForm(ctx, '.network-schedule-form');
  await until(() => /–Off/.test(item()?.textContent || ''), 'switched off by the edit');
  assert.match($('#network-status').textContent, /It is off until you switch it on again\./);
  $(`#network-schedule-delete-${id}`).click();
  await until(() => $('#network-schedule-delete-confirm'), 'delete confirmation');
  $('#network-schedule-delete-confirm').click();
  await until(() => /No schedules\./.test($('#network-schedules').textContent), 'deleted');
  assert.equal((await call(ctx, '/api/network/jobs')).json.total, 1, 'its job stays');
  assert.ok(byText(win.document, 'New schedule'));
});
