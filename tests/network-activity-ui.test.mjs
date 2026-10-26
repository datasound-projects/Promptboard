// Network → Activity and the agent profile's Activity tab (public/network-activity.js inside app.js) in jsdom against
// the real server: usable with no event at all; job statuses that move live without a reload (queued, running, waiting
// for input, unknown, each distinct); the CLI coverage note; no percentage and no cost unless reported; reconnecting
// shows every event once; a job's record with its history and events; filters and search; older pages; Kanban runs read
// only with Open in Kanban; the agent tab follows the stream. Jobs run through the deterministic fake worker; worker
// activity and pipeline events are synthetic appends. No CLI runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, until } from './helpers/ui-harness.mjs';
import { fakeWorker } from './helpers/network-worker.mjs';

async function call(ctx, path, method = 'GET', body) {
  const response = await fetch(`${ctx.app.url}${path}`, { method, headers: { 'X-STE-Token': ctx.win.__pbTest.token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, json: await response.json() };
}
async function agent(ctx, id, name, provider) {
  await ctx.app.board.base.create({ id, kind: 'profile', name, configuration: { agent: { provider } } });
  const { json: list } = await call(ctx, '/api/network/agents');
  const { status, json } = await call(ctx, '/api/network/agents', 'POST', { baseResourceId: id, expectedRevision: list.revision });
  assert.equal(status, 200, JSON.stringify(json));
  return json.agent;
}
const submit = async (ctx, agentId, extra = {}) => (await call(ctx, '/api/network/jobs', 'POST', { agentId, input: { text: 'Collect the release notes.' }, ...extra })).json.jobId;
const live = ctx => until(() => ctx.$('#network-activity-live')?.dataset.state === 'live', 'live');
const seqs = (ctx, selector = '#network-activity-feed') => [...(ctx.$(selector)?.querySelectorAll('[data-seq]') || [])].map(node => Number(node.dataset.seq));
const card = (ctx, agentId) => ctx.$(`#network-activity-agents [data-agent-id="${agentId}"]`);
const journal = async ctx => (await call(ctx, '/api/network/events?after=0&limit=200')).json.events.map(event => event.seq);

test('Activity with no event is usable, then follows jobs live: queued, running, waiting for input and unknown look different, with the CLI’s coverage and no invented progress or cost', async t => {
  const worker = fakeWorker({ mode: 'manual' });
  const ctx = await setup(t, { hash: '#/network/activity', networkWorker: worker, executor: null }); const { $, win } = ctx;
  await live(ctx); await ctx.idle();
  win.__samePage = true;
  // Nothing yet: every part says so, and nothing looks broken.
  assert.deepEqual([$('#network-panel-activity').hidden, $('#network-panel-soon').hidden, $('#network-tab-activity').getAttribute('aria-selected')], [false, true, 'true']);
  assert.match($('#network-activity-feed-empty').textContent, /No activity yet\./);
  assert.match($('#network-activity-agents-empty').textContent, /No agents registered yet\./);
  assert.match($('#network-panel-activity').textContent, /No open jobs\./);
  assert.match($('#network-panel-activity').textContent, /No Kanban runs of registered agents\./);
  assert.equal($('#network-activity-live').getAttribute('role'), 'status');
  assert.equal($('#network-activity-older').hidden, true);
  $('#network-activity-agents-empty button').click();
  await until(() => win.location.hash === '#/network' && !$('#network-panel-agents').hidden, 'Go to Agents');
  win.location.hash = '#/network/activity'; await live(ctx);

  const lead = await agent(ctx, 'lead', 'Lead', 'claude'), scout = await agent(ctx, 'scout', 'Scout', 'codex');
  await call(ctx, '/api/network/settings', 'PATCH', { expectedRevision: 0, maxConcurrentJobs: 1 });
  let next = worker.next();
  const first = await submit(ctx, lead.id);
  const a = await next;
  await until(() => card(ctx, lead.id)?.dataset.status === 'running', 'Lead preparing shows as running');
  await a.own.launching(); await a.own.spawned({ pid: 9 });
  const second = await submit(ctx, scout.id); // Behind the one slot.
  await until(() => card(ctx, scout.id)?.dataset.status === 'queued', 'Scout queued');
  const row = $(`#network-activity-queue [data-open-job="${second}"]`).closest('li');
  assert.match(row.textContent, /Waiting for one of 1 job slots\. · position 1/);
  assert.match(row.textContent, /Usage: not reported/);
  assert.match($(`#network-activity-queue [data-open-job="${first}"]`).closest('li').textContent, /running since .* · reports tool activity/);
  // The worker's activity (a synthetic Task 07 event) appears as it is written.
  const { seq } = await ctx.app.networkEvents.append({ type: 'job.activity', jobId: first, agentId: lead.id, kind: 'web', label: 'Searching: release notes' });
  await until(() => $(`#network-activity-feed [data-seq="${seq}"]`), 'activity event');
  assert.match($(`#network-activity-feed [data-seq="${seq}"]`).textContent, /Lead Job .* · Web search.*Searching: release notes/);
  // Live redraws keep the keyboard where it was.
  $(`#network-activity-queue [data-open-job="${first}"]`).focus();
  const later = await ctx.app.networkEvents.append({ type: 'job.activity', jobId: first, agentId: lead.id, kind: 'tool', label: 'Reading the notes' });
  await until(() => $(`#network-activity-feed [data-seq="${later.seq}"]`), 'another event');
  await new Promise(resolve => setTimeout(resolve, 400)); // The status is read again after events (300 ms) and redrawn.
  assert.deepEqual([win.document.activeElement.dataset.focusKey, win.document.activeElement.isConnected], [`queue:${first}`, true]);
  // Lead asks for input; Scout runs and ends unknown.
  next = worker.next();
  await a.own.finish({ status: 'waiting_for_input', result: { text: 'Which year?' } }); a.end();
  const b = await next;
  await b.own.launching(); await b.own.finish({ status: 'unknown' }); b.end();
  await until(() => card(ctx, lead.id)?.dataset.status === 'waiting_for_input' && card(ctx, scout.id)?.dataset.status === 'unknown', 'waiting and unknown');
  const chip = id => card(ctx, id).querySelector('.network-state');
  assert.deepEqual([chip(lead.id).dataset.state, chip(lead.id).textContent], ['waiting', '⏸Waiting for input']);
  assert.deepEqual([chip(scout.id).dataset.state, chip(scout.id).textContent], ['unknown', '?Unknown: needs your decision']);
  assert.match(card(ctx, scout.id).querySelector('summary').textContent, /Codex · Limited activity/);
  assert.match(card(ctx, scout.id).querySelector('.network-coverage').textContent, /only its web searches and MCP calls/);
  assert.match(card(ctx, lead.id).querySelector('summary').textContent, /Claude Code · Tool activity/);
  // Every journaled event shows once, newest first, and the page never reloaded.
  await until(async () => JSON.stringify(seqs(ctx).slice().reverse()) === JSON.stringify(await journal(ctx)), 'feed equals the journal');
  assert.equal(win.__samePage, true);
  const panel = $('#network-panel-activity').textContent;
  assert.ok(!panel.includes('%'), 'no percentage');
  assert.ok(!panel.includes('$'), 'no cost: none was reported');
  assert.equal(win.document.querySelectorAll('#network-panel-activity [role="progressbar"], #network-panel-activity progress').length, 0);
  // Labels: every control in the panel is named.
  for (const control of $('#network-panel-activity').querySelectorAll('input, select')) assert.ok(control.labels?.length, `${control.id} has a label`);
  for (const node of $('#network-panel-activity').querySelectorAll('button')) assert.ok((node.textContent.trim() || node.getAttribute('aria-label') || '').length > 0, node.outerHTML.slice(0, 80));
});

test('a dropped stream reconnects with its last seq: every event shows exactly once, also those written while it was away', async t => {
  const ctx = await setup(t, { hash: '#/network/activity', executor: null }); const { $ } = ctx;
  await live(ctx);
  const append = async n => { for (let i = 0; i < n; i++) await ctx.app.networkEvents.append({ type: 'pipeline.node', pipelineRunId: 'run_' + 'a'.repeat(20), nodeId: `n_${String(i).padStart(12, '0')}`, status: 'running' }); };
  await append(3);
  await until(() => seqs(ctx).length === 3, 'three live events');
  const states = new Set(), watch = setInterval(() => states.add($('#network-activity-live').dataset.state), 2);
  ctx.app.server.closeAllConnections(); // The stream (and anything else open) drops.
  await append(3);
  await until(() => states.has('reconnecting'), 'it noticed');
  await live(ctx);
  clearInterval(watch);
  await append(2);
  await until(() => seqs(ctx).length === 8, 'eight events');
  assert.deepEqual(seqs(ctx), [8, 7, 6, 5, 4, 3, 2, 1], 'each once, newest first');
  assert.deepEqual(seqs(ctx).slice().reverse(), await journal(ctx));
});

test('a job’s record, filters and search, catching up after leaving, Kanban runs that open their card, and the agent’s own Activity tab', async t => {
  const ctx = await setup(t, { hash: '#/network/activity', networkWorker: fakeWorker(), executor: null }); const { $, win } = ctx;
  await live(ctx);
  const lead = await agent(ctx, 'lead', 'Lead', 'claude'), gem = await agent(ctx, 'gem', 'Gem', 'gemini');
  const done = await submit(ctx, lead.id);
  await until(async () => (await call(ctx, `/api/network/jobs/${done}`)).json.job.status === 'completed', 'completed');
  await ctx.app.networkEvents.append({ type: 'pipeline.run', pipelineRunId: 'run_' + 'b'.repeat(20), status: 'running', message: 'Release pipeline started.' });
  await ctx.app.networkEvents.append({ type: 'job.activity', agentId: gem.id, jobId: 'job_' + 'c'.repeat(20), kind: 'text', label: 'Drafting the summary' });
  const project = await ctx.app.board.createProject({ name: 'Site' }), task = await ctx.app.board.createTask({ projectId: project.id, title: 'Fix the login form', prompt: 'Fix it.' });
  await ctx.app.board.store.update(draft => { draft.runs.push({ id: 'run-k1', taskId: task.id, projectId: project.id, stage: 'executing', status: 'succeeded', createdAt: Date.now() - 9000, updatedAt: Date.now() - 5000, config: { provider: 'claude' }, baseManifest: { profiles: [{ resourceId: 'lead', revision: 1 }] }, usage: { inputTokens: 900, outputTokens: 120, costUSD: 0.042 } }); });
  await until(() => seqs(ctx).length === 6 && $('#network-activity-kanban [data-kanban-run="run-k1"]'), 'events and the Kanban run');
  // Filters and search narrow the timeline; Clear filters brings it back.
  const choose = (selector, value) => { $(selector).value = value; $(selector).dispatchEvent(new win.Event('change', { bubbles: true })); };
  choose('#network-activity-agent', gem.id);
  assert.deepEqual(seqs(ctx).length, 1);
  choose('#network-activity-agent', ''); choose('#network-activity-kind', 'pipeline');
  assert.match($('#network-activity-feed').textContent, /^▶Pipeline run bbbbbb: Running/);
  assert.equal(seqs(ctx).length, 1);
  choose('#network-activity-kind', 'job.status');
  assert.equal(seqs(ctx).length, 4);
  $('#network-activity-search').value = 'no such thing'; $('#network-activity-search').dispatchEvent(new win.Event('input'));
  await until(() => /No events match\./.test($('#network-activity-feed-empty').textContent), 'nothing matches');
  [...$('#network-activity-feed-empty').querySelectorAll('button')].find(node => node.textContent === 'Clear filters').click();
  assert.equal(seqs(ctx).length, 6);
  $('#network-activity-search').value = 'summary'; $('#network-activity-search').dispatchEvent(new win.Event('input'));
  await until(() => seqs(ctx).length === 1, 'search');
  $('#network-activity-search').value = ''; $('#network-activity-search').dispatchEvent(new win.Event('input'));
  await until(() => seqs(ctx).length === 6, 'search cleared');

  // One job's record: history, attempts, usage not reported, its events; Back returns focus to the button that opened it.
  const details = $(`#network-activity-feed [data-open-job="${done}"]`);
  details.focus(); details.click();
  await until(() => win.location.hash === `#/network/activity/${done}` && win.document.activeElement?.id === 'network-activity-job-heading', 'job record');
  const record = $('#network-activity-job');
  assert.equal($('#network-activity-overview').hidden, true);
  assert.match(record.textContent, /Job [0-9a-f]{6}✓Completed/);
  assert.equal(record.querySelectorAll('.network-history-list li').length, 4);
  assert.match(record.textContent, /Attempt 1 · Claude Code/);
  assert.match(record.textContent, /Usage: not reported/);
  assert.match(record.textContent, /Saved result: \d+ characters\./);
  assert.deepEqual(seqs(ctx, '#network-activity-job-events'), [4, 3, 2, 1]);
  $('#network-activity-back').click();
  await until(() => win.location.hash === '#/network/activity' && win.document.activeElement?.dataset.openJob === done, 'focus back');

  // Leaving and coming back keeps what the page showed and catches up from its last seq.
  win.location.hash = '#/network'; await until(() => !$('#network-panel-agents').hidden, 'Agents');
  const away = await ctx.app.networkEvents.append({ type: 'job.activity', agentId: gem.id, jobId: 'job_' + 'c'.repeat(20), kind: 'tool', label: 'While away' });
  win.location.hash = '#/network/activity'; await live(ctx);
  await until(() => seqs(ctx)[0] === away.seq && seqs(ctx).length === 7, 'caught up');

  // Kanban: read only, reported usage and cost shown as reported, Open in Kanban opens the card.
  const run = $('#network-activity-kanban [data-kanban-run="run-k1"]').closest('li');
  assert.match(run.textContent, /✓SucceededFix the login form/);
  assert.match(run.textContent, /900 in · 120 out tokens · cost \$0\.0420 \(reported by the CLI\)/);
  $('#network-activity-kanban [data-kanban-run="run-k1"]').click();
  await until(() => win.location.hash === '#/kanban' && $('#task-dialog').open && /Fix the login form/.test($('#task-dialog').textContent), 'the card opens');
  $('#task-dialog').close();

  // The agent's Activity tab: its status, coverage, Kanban runs and events, kept live.
  win.location.hash = `#/network/agents/${lead.id}`;
  await until(() => $('#network-detail-heading')?.textContent === 'Lead', 'profile');
  $('#network-profile-tab-activity').click();
  const tab = () => $('#network-profile-panel-activity');
  await until(() => !tab().hidden && seqs(ctx, '#network-agent-activity-feed').length === 4 && /Claude Code · Tool activity/.test(tab().textContent), 'agent activity');
  assert.match(tab().textContent, /No open Network job\./);
  assert.match(tab().textContent, /Fix the login form/);
  await live(ctx);
  const { seq } = await ctx.app.networkEvents.append({ type: 'job.activity', agentId: lead.id, jobId: done, kind: 'tool', label: 'A late note' });
  await until(() => seqs(ctx, '#network-agent-activity-feed')[0] === seq, 'live in the agent tab');
  assert.deepEqual(seqs(ctx, '#network-agent-activity-feed'), [seq, 4, 3, 2, 1], 'only this agent’s events');
  // Another agent's tab shows only its own.
  win.location.hash = `#/network/agents/${gem.id}`;
  await until(() => $('#network-detail-heading')?.textContent === 'Gem' && seqs(ctx, '#network-agent-activity-feed').length === 2, 'Gem’s own events');
  assert.match($('#network-profile-panel-activity').textContent, /Gemini CLI · Final result only/);
});

test('Show older events pages back through the journal; a gap left by retention is said plainly', async t => {
  const ctx = await setup(t, { hash: '#/', executor: null, networkEventOptions: { segmentBytes: 8000, maxSegments: 3 } }); const { $, win } = ctx;
  for (let i = 0; i < 220; i++) await ctx.app.networkEvents.append({ type: 'pipeline.run', pipelineRunId: 'run_' + 'd'.repeat(20), status: 'running', message: `Step ${i}` });
  const kept = await journal(ctx);
  assert.ok(kept[0] > 1 && kept.length > 100 && kept.length < 200, `retention removed the oldest (kept ${kept.length})`);
  win.location.hash = '#/network/activity'; await live(ctx);
  await until(() => seqs(ctx).length === 100, 'the newest page');
  assert.equal(seqs(ctx)[0], 220);
  assert.deepEqual([$('#network-activity-older').hidden, $('.network-gap').hidden], [false, true]);
  $('#network-activity-older').focus(); $('#network-activity-older').click();
  await until(() => seqs(ctx).length === kept.length, 'older page');
  assert.equal(win.document.activeElement, $('#network-activity-feed'), 'focus stays in the timeline');
  assert.deepEqual(seqs(ctx).slice().reverse(), kept);
  assert.equal($('#network-activity-older').hidden, true);
  assert.equal($('.network-gap').hidden, false, 'older events were removed by the size limit');
});
