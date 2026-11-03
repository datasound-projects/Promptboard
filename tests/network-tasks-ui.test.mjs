// An agent's Tasks tab (public/network.js) in jsdom against the real server, with the deterministic fake job worker
// (tests/helpers/network-worker.mjs), so no process starts: the "Run a job" form and its preview, the confirmation and the
// exact request it sends, the job list read again while a job is open, live activity and coverage, a result rendered as
// Markdown with HTML kept as text, usage only when reported, and the cancel, retry, close and approve actions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, until } from './helpers/ui-harness.mjs';
import { fakeWorker } from './helpers/network-worker.mjs';

async function call(ctx, path, method = 'GET', body) {
  const response = await fetch(`${ctx.app.url}${path}`, { method, headers: { 'X-STE-Token': ctx.win.__pbTest.token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, json: await response.json() };
}
async function register(ctx, baseResourceId, extra = {}) {
  const { json: list } = await call(ctx, '/api/network/agents');
  return (await call(ctx, '/api/network/agents', 'POST', { baseResourceId, expectedRevision: list.revision, ...extra })).json.agent;
}
const jobs = async (ctx, agent) => (await call(ctx, `/api/network/jobs?agentId=${agent.id}&limit=200`)).json.jobs;
const item = (ctx, id) => ctx.$(`#network-job-${id}`);
const key = (ctx, node, name) => node.dispatchEvent(new ctx.win.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
// The list reads itself again every 10 seconds when no job is open; choosing the tab again reads it at once.
const refresh = ctx => ctx.$('#network-profile-tab-tasks').click();
async function openTasks(ctx, agent) {
  ctx.win.location.hash = `#/network/agents/${agent.id}`;
  await until(() => ctx.$('#network-profile-tab-tasks'), 'profile');
  ctx.$('#network-profile-tab-tasks').click();
  await until(() => !ctx.$('#network-profile-panel-tasks').hidden && ctx.$('#network-job-list')?.getAttribute('aria-busy') === 'false', 'tasks loaded');
  await ctx.idle();
}

test('Tasks: run a job after a confirmation that says what it may use; the list follows it live, shows coverage and activity, renders the result safely, and cancel works', async t => {
  const worker = fakeWorker({ mode: 'manual' });
  const ctx = await setup(t, { hash: '#/', networkWorker: worker }); const { $, win } = ctx;
  const site = await ctx.app.board.createProject({ name: 'Site' }); await win.__pbTest.loadBoard();
  await ctx.app.board.base.create({ id: 'lead', kind: 'profile', name: 'Lead', configuration: { agent: { provider: 'claude', model: 'haiku', instructions: 'Lead the research.' } } });
  const lead = await register(ctx, 'lead', { projectAllowlist: [site.id] });
  await mkdir(join(ctx.dataDir, 'lessons'), { recursive: true });
  await writeFile(join(ctx.dataDir, 'lessons', `${site.id}.json`), JSON.stringify({ schema: 'promptboard.lessons', version: 1, projectId: site.id, revision: 2, settings: { enabled: true, provider: '', model: '' },
    lessons: [{ id: 'l1', kind: 'command', text: 'Run npm test first.', evidence: '', taskId: 't1', taskNumber: 1, status: 'approved', createdAt: 1, decidedAt: 2 }], jobs: [] }));
  const sent = [], original = win.fetch;
  win.fetch = (url, options = {}) => { if ((options.method || 'GET') !== 'GET') sent.push([options.method, String(url), options.body ? JSON.parse(options.body) : null]); return original(url, options); };
  await openTasks(ctx, lead);
  assert.match($('#network-job-empty').textContent, /No jobs yet\./);
  assert.deepEqual([...$('#network-job-tools').options].map(option => [option.value, option.disabled]), [['none', false], ['web', false]], 'Claude can search the web read-only');
  // The preview answers what the job would receive with these choices, as the Memory tab does.
  $('#network-job-project').value = site.id; $('#network-job-project').dispatchEvent(new win.Event('change'));
  await until(() => !$('#network-job-lessons').disabled, 'lessons can be allowed once a project is chosen');
  $('#network-job-lessons').checked = true; $('#network-job-lessons').dispatchEvent(new win.Event('change'));
  await until(() => /Project lessons of Site: its approved lessons/.test($('#network-job-reasons').textContent) && /Run npm test first\./.test($('#network-job-preview-text').textContent), 'preview with lessons');
  // An empty job is refused in the form; nothing is sent.
  $('#network-job-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  assert.deepEqual([$('#network-job-form-error').hidden, $('#network-job-form-error').textContent, win.document.activeElement], [false, 'Write what the job should do.', $('#network-job-input')]);
  // The confirmation lists everything the job may use; Cancel sends nothing.
  $('#network-job-input').value = 'Summarise the release notes.\nKeep it short.'; $('#network-job-tools').value = 'web'; $('#network-job-timeout').value = '5';
  $('#network-job-run').focus(); $('#network-job-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => $('#network-job-confirm'), 'confirmation');
  const summary = $('#network-dialog').textContent;
  for (const text of ['Run this job?', 'Lead', 'Claude Code · haiku', 'Web search and reading web pages (read only)', 'Read only: an empty folder of its own', 'This agent’s approved memory', 'Approved lessons of Site', '5 minutes', 'Not limited. Usage is shown afterwards only if the CLI reports it.']) assert.ok(summary.includes(text), `confirmation says ${text}`);
  assert.equal(win.document.activeElement, $('#network-job-confirm'));
  key(ctx, $('#network-dialog'), 'Escape');
  assert.deepEqual([$('#network-dialog').open, win.document.activeElement, sent.length], [false, $('#network-job-run'), 0], 'Escape cancels and returns focus; nothing sent');
  // Run it: exactly this request, then the job in the list.
  const started = worker.next();
  $('#network-job-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => $('#network-job-confirm'), 'confirmation again');
  $('#network-job-confirm').click();
  await until(() => !$('#network-dialog').open && $('#network-job-list .network-job'), 'job listed');
  const [, url, body] = sent.at(-1);
  assert.equal(url, '/api/network/jobs');
  assert.match(body.idempotencyKey, /^ui-[0-9a-f]{32}$/); delete body.idempotencyKey;
  assert.deepEqual(body, { agentId: lead.id, input: { text: 'Summarise the release notes.\nKeep it short.' }, tools: 'web', permissions: { memory: 'agent', projectLessons: true }, limits: { timeoutMs: 300000 }, projectId: site.id });
  assert.equal($('#network-job-input').value, '', 'the form is ready for the next job');
  const [job] = await jobs(ctx, lead);
  assert.match($('#network-status').textContent, /Job (queued|accepted)/);
  await until(() => item(ctx, job.id)?.querySelector('.network-job-title')?.textContent === 'Summarise the release notes.', 'the job’s first line is its title');
  // Live: the page reads the list again by itself while the job is open.
  const entry = await started;
  await entry.own.launching(); entry.process = 'running'; await entry.own.spawned({ pid: 4321 }); entry.own.activity({ kind: 'web', label: 'Searched the web.' });
  await until(() => item(ctx, job.id)?.dataset.status === 'running' && /Process: running\. Last: Searched the web\./.test(item(ctx, job.id).textContent), 'running with activity, without a click', 8000);
  assert.match(item(ctx, job.id).textContent, /Running/);
  // Completed: coverage, reported usage, and the result as Markdown with HTML shown as text.
  await entry.own.finish({ status: 'completed', exitCode: 0, coverage: 'tools', usage: { reported: true, inputTokens: 1200, outputTokens: 80, costUsd: 0.0042 }, nativeSessionId: 'claude-session-9',
    result: { text: '# Release\n\n**Three** points.\n\n<script>window.hacked = true</script><img src=x onerror="window.hacked = true">', json: { points: 3 } } });
  entry.end();
  await until(() => item(ctx, job.id)?.dataset.status === 'completed', 'completed', 8000);
  const done = item(ctx, job.id);
  assert.match(done.textContent, /Tool-level activity reported/);
  assert.match(done.textContent, /Reported by the CLI: 1,200 input tokens · 80 output tokens · \$0\.0042\./);
  assert.equal(done.querySelector('#network-job-' + job.id + '-cancel'), null, 'a finished job has no Cancel');
  const details = done.querySelector('details'); details.open = true; details.dispatchEvent(new win.Event('toggle'));
  await until(() => item(ctx, job.id).querySelector('.network-job-result strong')?.textContent === 'Three', 'result rendered');
  const result = item(ctx, job.id).querySelector('.network-job-result');
  assert.equal(result.querySelector('script, img'), null, 'no HTML element from the result');
  assert.match(result.textContent, /<script>window\.hacked = true<\/script>/);
  assert.equal(win.hacked, undefined);
  assert.match(item(ctx, job.id).textContent, /"points": 3/);
  assert.match(item(ctx, job.id).textContent, /claude-session-9/);
  // The result stays open across the next reads of the list.
  await ctx.idle();
  assert.equal(item(ctx, job.id).querySelector('details').open, true);

  // Cancel a running job from its row: the worker is told and the row says Cancelled.
  const second = worker.next();
  await call(ctx, '/api/network/jobs', 'POST', { agentId: lead.id, input: { text: 'A second job.' } });
  const running = await second; await running.own.launching(); running.process = 'running'; await running.own.spawned({ pid: 4322 });
  const secondId = (await jobs(ctx, lead)).find(entry => entry.status === 'running').id;
  refresh(ctx);
  await until(() => item(ctx, secondId)?.querySelector(`#network-job-${secondId}-cancel`), 'cancel offered', 8000);
  $(`#network-job-${secondId}-cancel`).click();
  await until(() => item(ctx, secondId)?.dataset.status === 'cancelled', 'cancelled');
  assert.deepEqual([worker.cancels.includes(running.own.attemptId), running.killed], [true, true]);
  assert.match($('#network-status').textContent, /Cancelled\. Its process was stopped\./);
  assert.ok(sent.every(([, path]) => /^\/api\/network\/jobs(\/job_[0-9a-f]{20}\/cancel)?$/.test(path)), JSON.stringify(sent.map(([, path]) => path)));
});

test('Tasks: a disabled agent cannot start a job and says why; Gemini offers no web search; approve, retry with the uncertainty confirmation, and close work from the list', async t => {
  const worker = fakeWorker({ mode: 'manual' });
  const ctx = await setup(t, { hash: '#/', networkWorker: worker }); const { $, win } = ctx;
  await ctx.app.board.base.create({ id: 'gem', kind: 'profile', name: 'Gem', configuration: { agent: { provider: 'gemini' } } });
  await ctx.app.board.base.create({ id: 'off', kind: 'profile', name: 'Off', configuration: { agent: { provider: 'claude' } } });
  const gem = await register(ctx, 'gem'), off = await register(ctx, 'off', { enabled: false });
  await openTasks(ctx, off);
  assert.match($('#network-job-blocked').textContent, /No new job can start\. The registration is switched off in Network\./);
  for (const id of ['#network-job-input', '#network-job-run', '#network-job-tools']) assert.deepEqual([$(id).disabled, $(id).getAttribute('aria-describedby')], [true, 'network-job-blocked'], `${id} disabled with its reason`);
  await openTasks(ctx, gem);
  assert.equal($('#network-job-blocked').hidden, true);
  const web = $('#network-job-tools').querySelector('option[value="web"]');
  assert.deepEqual([web.disabled, web.textContent, $('#network-job-tools').value], [true, 'Web search (not available for Gemini CLI)', 'none']);
  // Approve a job that waits for approval.
  const approval = (await call(ctx, '/api/network/jobs', 'POST', { agentId: gem.id, input: { text: 'Needs a yes.' }, requireApproval: true })).json.jobId;
  const queued = worker.next();
  refresh(ctx);
  await until(() => $(`#network-job-${approval}-approve`), 'approve offered', 8000);
  $(`#network-job-${approval}-approve`).click();
  const entry = await queued;
  // It ran and its worker ended without a result after launch: unknown, so retry needs the uncertainty confirmation.
  await entry.own.launching(); entry.process = 'running'; await entry.own.spawned({ pid: 77 }); entry.end();
  await until(() => item(ctx, approval)?.dataset.status === 'unknown', 'unknown', 8000);
  assert.match(item(ctx, approval).textContent, /May have run/);
  $(`#network-job-${approval}-retry`).click();
  await until(() => $('#network-job-uncertain'), 'retry dialog');
  assert.deepEqual([$('#network-job-dialog-confirm').disabled, win.document.activeElement], [true, $('#network-job-uncertain')], 'Run again waits for the confirmation');
  $('#network-job-uncertain').checked = true; $('#network-job-uncertain').dispatchEvent(new win.Event('change'));
  const again = worker.next();
  $('#network-job-dialog-confirm').click();
  await until(() => !$('#network-dialog').open, 'retried');
  const retried = await again;
  assert.equal((await call(ctx, `/api/network/jobs/${approval}`)).json.job.attempts.length, 2, 'a new attempt');
  await retried.own.launching(); retried.end(); // Unknown again.
  await until(() => item(ctx, approval)?.dataset.status === 'unknown' && $(`#network-job-${approval}-close`), 'unknown again', 8000);
  $(`#network-job-${approval}-close`).click();
  await until(() => $('#network-job-dialog-confirm')?.textContent === 'Close job', 'close dialog');
  $('#network-job-dialog-confirm').click();
  await until(() => item(ctx, approval)?.dataset.status === 'failed' && /Closed by you/.test(item(ctx, approval).textContent), 'closed');
  assert.equal(win.document.activeElement?.closest?.('.network-job')?.id, `network-job-${approval}`, 'focus stays on the job');
});
