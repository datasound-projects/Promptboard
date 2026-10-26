// Network → Pipelines (public/network-pipeline.js inside network.js and app.js) in jsdom against the real server with the
// deterministic fake job worker (tests/helpers/network-worker.mjs). jsdom has no canvas, so these drive the step and arrow
// lists and the details panel, which edit the same draft: the MVP template, a refused save and a refused validate marked
// on the step, the rule editor, publish, a confirmed run, approve and reject from the run view, the saved report, the job
// record, cancel with live states, a run that keeps its pinned version while the draft changes, a reload, the unsaved
// guard, a conflicting save kept as a new pipeline, the list's rename/duplicate/delete, labels, and the phone flow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, until } from './helpers/ui-harness.mjs';
import { fakeWorker } from './helpers/network-worker.mjs';

const pad = n => String(n).padStart(12, '0');
const slow = (fn, label) => until(fn, label, 25000);
async function call(ctx, path, method = 'GET', body) {
  const response = await fetch(`${ctx.app.url}${path}`, { method, headers: { 'X-STE-Token': ctx.win.__pbTest.token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, json: await response.json() };
}
/** Three Claude agents registered in Network and the network “Desk” holding them, published as version 1. */
async function seed(ctx) {
  const agents = [];
  for (const [index, name] of ['Scout', 'Analyst', 'Editor'].entries()) {
    await ctx.app.board.base.create({ id: `b${index}`, kind: 'profile', name, configuration: { agent: { provider: 'claude' } } });
    agents.push((await call(ctx, '/api/network/agents', 'POST', { baseResourceId: `b${index}`, expectedRevision: index })).json.agent);
  }
  const { json } = await call(ctx, '/api/network/networks', 'POST', { name: 'Desk', nodes: agents.map((agent, i) => ({ id: `n_${pad(i + 1)}`, type: 'agent', agentId: agent.id, position: { x: i * 200, y: 0 } })),
    edges: [{ id: `e_${pad(1)}`, from: `n_${pad(1)}`, to: `n_${pad(3)}`, relation: 'share_result' }] });
  await call(ctx, `/api/network/networks/${json.network.id}/publish`, 'POST', { expectedRevision: 1 });
  return { agents, network: json.network };
}
/** The MVP demo shape, built over the API (the first test builds the same from the UI template). */
function demo([a, b, r]) {
  const step = (n, type, label, config) => ({ id: `n_${pad(n)}`, type, label, position: { x: n * 200, y: 0 }, config });
  const edge = (n, from, to, fromPort) => ({ id: `e_${pad(n)}`, from: `n_${pad(from)}`, to: `n_${pad(to)}`, fromPort, toPort: 'input' });
  return { nodes: [step(1, 'agent', 'Research A', { agentId: a.id, instructions: 'Research the topic.' }), step(2, 'agent', 'Research B', { agentId: b.id, instructions: 'Research the risks.' }),
    step(3, 'join', 'Both researched', { require: 'all' }), step(4, 'agent', 'Reviewer', { agentId: r.id, instructions: 'Review both.' }), step(5, 'approval', 'Your approval', { prompt: 'Save the report?' }),
    step(6, 'output', 'Report', { name: 'report', include: [`n_${pad(1)}`, `n_${pad(2)}`, `n_${pad(4)}`] })],
  edges: [edge(1, 1, 3, 'text'), edge(2, 2, 3, 'text'), edge(3, 3, 4, 'done'), edge(4, 4, 5, 'text'), edge(5, 3, 5, 'done'), edge(6, 5, 6, 'done')] };
}
async function publishedDemo(ctx, { agents, network }, name = 'Market report') {
  const { json } = await call(ctx, '/api/network/pipelines', 'POST', { networkId: network.id, networkVersion: 1, name, ...demo(agents) });
  assert.equal((await call(ctx, `/api/network/pipelines/${json.pipeline.id}/publish`, 'POST', { expectedRevision: 1 })).status, 200);
  return json.pipeline;
}
function requestLog(ctx) {
  const log = [], original = ctx.win.fetch;
  ctx.win.fetch = (url, options = {}) => { log.push([options.method || 'GET', String(url)]); return original(url, options); };
  return log;
}
async function visit(ctx, hash, check) { ctx.win.location.hash = hash; await until(check, `page ${hash}`); await ctx.idle(); }
const choose = (ctx, selector, value) => { const node = ctx.$(selector); assert.ok(node, `${selector} exists`); node.value = value; node.dispatchEvent(new ctx.win.Event('change', { bubbles: true })); };
const submit = ctx => ctx.$('#network-dialog form').dispatchEvent(new ctx.win.Event('submit', { bubbles: true, cancelable: true }));
const text = (ctx, selector) => ctx.$(selector)?.textContent || '';
const stepNames = ctx => [...ctx.$('#network-pipeline-steps').querySelectorAll('[data-step-id]')].map(node => node.querySelector('strong').textContent);
const stepRow = (ctx, name) => [...ctx.$('#network-pipeline-steps').querySelectorAll('[data-step-id]')].find(node => node.querySelector('strong').textContent.replace(/^\d+\. /, '') === name);
const edgeNames = ctx => [...ctx.$('#network-pipeline-edges').querySelectorAll('[data-edge-id]')].map(node => `${node.querySelector('strong').textContent} (${node.querySelector('.network-port').textContent.split(' · ')[0]})`);
const runRow = (ctx, name) => [...ctx.$('#network-run-steps').querySelectorAll('[data-step-id]')].find(node => node.querySelector('strong').textContent === name);
const runStatus = (ctx, name) => runRow(ctx, name)?.querySelector('.base-status')?.textContent;
const designer = (ctx, name) => until(() => ctx.$('#network-pipeline-heading')?.textContent === name && !ctx.$('#network-pipeline-designer').hidden && !ctx.$('#network-pipeline-designer .network-graph-body').hidden && ctx.$('#network-pipeline-steps [data-step-id]'), `${name} in the designer`);
async function pickStep(ctx, name) { stepRow(ctx, name).click(); await until(() => ctx.$('#network-pipeline-detail-heading')?.textContent === name, `${name} chosen`); }
async function arrow(ctx, from, port, to) {
  await pickStep(ctx, from);
  choose(ctx, '#network-pipeline-connect-port', port); choose(ctx, '#network-pipeline-connect-to', stepRow(ctx, to).dataset.stepId);
  ctx.$('#network-pipeline-connect-add').click();
}
async function save(ctx) { ctx.$('#network-pipeline-save').click(); await until(() => !ctx.$('#network-pipeline-dirty') && ctx.$('#network-pipeline-save').disabled && !ctx.$('#network-pipeline-save').textContent.includes('…'), 'saved'); await ctx.idle(); }
async function startRun(ctx, input = '') {
  ctx.$('#network-pipeline-run').click();
  await until(() => ctx.$('#network-run-start') && !ctx.$('#network-run-start').disabled, 'run confirmation checked');
  if (input) ctx.$('#network-run-input').value = input;
  submit(ctx);
  await until(() => /^#\/network\/runs\/run_[0-9a-f]{20}$/.test(ctx.win.location.hash) && /run of version/.test(text(ctx, '#network-run-heading')), 'run view');
  return ctx.win.location.hash.split('/')[3];
}
const runFolder = (ctx, runId) => join(ctx.dataDir, 'network', 'pipeline-runs', `run__${runId.slice(4)}`);

test('the MVP template becomes a draft; a refused save and a refused validate are marked on the step; publish v1; a confirmed run through the real server; approve from the step; the saved report and the job record', async t => {
  const ctx = await setup(t, { hash: '#/', networkWorker: fakeWorker({ text: job => `Done: ${job.request.instructions.split('.')[0]}.` }) }); const { $, win } = ctx;
  const { agents } = await seed(ctx);
  const log = requestLog(ctx);
  await visit(ctx, '#/network/pipelines', () => !$('#network-panel-pipelines').hidden && /No pipelines yet\./.test(text(ctx, '#network-pipelines-view')));
  assert.deepEqual([$('#network-tab-pipelines').getAttribute('aria-selected'), $('#network-tab-pipelines').dataset.available, $('#network-panel-soon').hidden, $('#network-sections [aria-current="page"]').dataset.section], ['true', undefined, true, 'pipelines']);
  assert.match(text(ctx, '#network-pipeline-semantics'), /arrows are execution order.*not Graph relations, which record permissions and intent and never move data\..*only Run starts a run/);

  // The template: two research steps → join → reviewer → approval → report, with agents of the pinned version.
  $('#network-pipelines-template').click();
  await until(() => $('#network-template-review')?.value === agents[2].id, 'the template offers the version’s agents');
  assert.deepEqual([...$('#network-template-a').options].map(option => option.textContent), ['Scout', 'Analyst', 'Editor']);
  assert.deepEqual([$('#network-template-a').value, $('#network-template-b').value], [agents[0].id, agents[1].id]);
  submit(ctx);
  await designer(ctx, 'Research report');
  const id = win.location.hash.split('/')[3];
  assert.deepEqual(stepNames(ctx), ['1. Research A', '2. Research B', '3. Both researched', '4. Reviewer', '5. Your approval', '6. Report'], 'steps in execution order');
  assert.deepEqual(edgeNames(ctx).sort(), ['Both researched → Reviewer (done → input)', 'Both researched → Your approval (done → input)', 'Research A → Both researched (text → input)', 'Research B → Both researched (text → input)', 'Reviewer → Your approval (text → input)', 'Your approval → Report (done → input)'].sort());
  let draft = (await call(ctx, `/api/network/pipelines/${id}`)).json.pipeline;
  const ids = Object.fromEntries(draft.nodes.map(node => [node.label, node.id]));
  assert.deepEqual(draft.nodes.find(node => node.type === 'output').config, { name: 'report', include: [ids['Research A'], ids['Research B'], ids.Reviewer] });
  assert.deepEqual(draft.edges.map(edge => Object.keys(edge).sort().join()), Array(6).fill('from,fromPort,id,to,toPort'), 'execution edges carry ports, never a relation');
  assert.match(text(ctx, '#network-pipeline-notice'), /The canvas could not load in this browser\. The lists beside it show and edit the same pipeline\./);

  // A new condition step is not complete: Save refuses before anything is sent and marks the step.
  $('#network-pipeline-add-condition').click();
  await until(() => text(ctx, '#network-pipeline-detail-heading') === 'Condition' && win.document.activeElement === $('#network-pipeline-detail-heading'), 'condition added and focused');
  $('#network-pipeline-save').click();
  await until(() => !$('#network-pipeline-alert').hidden, 'save refused');
  assert.match(text(ctx, '#network-pipeline-alert'), /Not saved\. Finish 1 step first: Condition: Add at least one rule\./);
  assert.ok(stepRow(ctx, 'Condition').classList.contains('is-problem'), 'the step is marked');
  assert.equal((await call(ctx, `/api/network/pipelines/${id}`)).json.pipeline.revision, draft.revision, 'nothing was saved');
  assert.ok(!log.some(([method]) => method === 'PATCH'), 'no PATCH was sent');
  // The rule editor: Task 09's operators, typed values, messages, and the json port that must reach the condition.
  $('#network-pipeline-rule-add').click();
  await until(() => $('#network-pipeline-rule-0-step')?.value === ids['Research A'], 'a rule');
  choose(ctx, '#network-pipeline-rule-0-fields', 'result.score'); choose(ctx, '#network-pipeline-rule-0-op', 'gte'); choose(ctx, '#network-pipeline-rule-0-value', 'high');
  await until(() => text(ctx, '#network-pipeline-rule-0-error') === 'Write a number.', 'a number is required');
  assert.deepEqual([...$('#network-pipeline-rule-0-op').options].map(option => option.value), ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'exists', 'contains']);
  assert.match(text(ctx, '#network-pipeline-check'), /Condition: A rule is not complete/);
  choose(ctx, '#network-pipeline-rule-0-fields', 'result.$score');
  await until(() => /Fields are names or list positions/.test(text(ctx, '#network-pipeline-rule-0-error')), 'fields are checked');
  choose(ctx, '#network-pipeline-rule-0-fields', 'result.score'); choose(ctx, '#network-pipeline-rule-0-value', '0.7');
  await until(() => !$('#network-pipeline-rule-0-error') && /No json arrow from “Research A” reaches this condition yet/.test(text(ctx, '#network-pipeline-rules')), 'the rule is complete; its input does not reach yet');
  await arrow(ctx, 'Research A', 'json', 'Condition');
  await until(() => edgeNames(ctx).includes('Research A → Condition (json → input)'), 'json arrow');
  await pickStep(ctx, 'Condition');
  assert.match(text(ctx, '#network-pipeline-rules'), new RegExp(`Reads ${ids['Research A']}\\.json\\.result\\.score and checks that it is at least 0\\.7\\.`));
  assert.match(text(ctx, '#network-pipeline-ports'), /What reaches itResearch A \(json\)/);
  // A loop and an arrow out of an output are refused where they are made.
  await arrow(ctx, 'Reviewer', 'text', 'Research A');
  await until(() => /would make a loop/.test(text(ctx, '#network-status')), 'loop refused');
  assert.equal(edgeNames(ctx).length, 7);
  await pickStep(ctx, 'Report');
  assert.equal($('#network-pipeline-connect-add'), null, 'no arrow leaves an output');
  assert.match(text(ctx, '#network-pipeline-ports'), /Sends on: nothing\. An output ends its pipeline\./);
  await save(ctx);
  draft = (await call(ctx, `/api/network/pipelines/${id}`)).json.pipeline;
  const condition = draft.nodes.find(node => node.type === 'condition');
  assert.deepEqual(condition.config, { all: [{ path: `${ids['Research A']}.json.result.score`, op: 'gte', value: 0.7 }] });
  assert.ok(draft.edges.some(edge => edge.from === ids['Research A'] && edge.to === condition.id && edge.fromPort === 'json'));
  // Remove the condition again: its arrow goes with it.
  await pickStep(ctx, 'Condition'); $('#network-pipeline-node-remove').click();
  await until(() => !stepRow(ctx, 'Condition') && edgeNames(ctx).length === 6, 'condition removed');
  await save(ctx);

  // Validate refuses a switched-off agent: the message, the marked step and its details.
  await call(ctx, `/api/network/agents/${agents[1].id}`, 'PATCH', { expectedRevision: agents[1].revision, enabled: false });
  $('#network-pipeline-validate').click();
  await until(() => $('#network-pipeline-invalid'), 'validate refused');
  assert.match(text(ctx, '#network-pipeline-invalid'), /Validate refused it: “Analyst” is switched off in Network\./);
  assert.ok(stepRow(ctx, 'Research B').classList.contains('is-problem'));
  assert.ok(!stepRow(ctx, 'Research A').classList.contains('is-problem'));
  assert.match(text(ctx, '#network-status'), /^Not valid: “Analyst” is switched off/);
  $(`#network-pipeline-invalid [data-issue-step="${ids['Research B']}"]`).click();
  await until(() => text(ctx, '#network-pipeline-detail-heading') === 'Research B' && win.document.activeElement === $('#network-pipeline-detail-heading'), 'Show leads to the step');
  assert.match(text(ctx, '#network-pipeline-step-refused'), /Validate refused it: “Analyst” is switched off/);
  await call(ctx, `/api/network/agents/${agents[1].id}`, 'PATCH', { expectedRevision: agents[1].revision + 1, enabled: true });
  $('#network-pipeline-validate').click();
  await until(() => $('#network-pipeline-valid'), 'valid');
  assert.match(text(ctx, '#network-pipeline-valid'), /^Valid as saved \(revision \d+\): 6 steps after sub-pipelines are expanded, 3 agent jobs, 0 sub-pipelines\. Nothing ran\.$/);
  assert.deepEqual([(await call(ctx, '/api/network/jobs')).json.total, (await call(ctx, '/api/network/pipeline-runs')).json.total], [0, 0], 'saving and validating ran nothing');

  // Publish: validated first, then version 1 with its info; still nothing runs.
  assert.equal($('#network-pipeline-run').disabled, true, 'Run waits for a published version');
  $('#network-pipeline-publish').click();
  await until(() => text(ctx, '#network-dialog-heading') === 'Publish version 1?', 'publish dialog');
  assert.match(text(ctx, '#network-pipeline-diff'), /This is the first version\./);
  $('#network-confirm').click();
  await until(() => /Version 1 latest/.test(text(ctx, '#network-pipeline-meta')) && !$('#network-dialog').open, 'published');
  assert.ok($('#network-pipeline-versions [data-run-version="1"]'));
  assert.equal((await call(ctx, '/api/network/jobs')).json.total, 0, 'publishing ran nothing');

  // Run: the confirmation says what runs, with which permissions, how many at once, and that cost is not enforced.
  $('#network-pipeline-run').click();
  await until(() => $('#network-run-start') && !$('#network-run-start').disabled, 'run confirmation');
  const facts = text(ctx, '#network-run-facts');
  for (const pattern of [/1 of “Research report”, pinned with its exact sub-pipeline versions/, /6 steps after sub-pipelines are expanded; 3 agent jobs\./, /At most 2 agent steps at a time \(this pipeline allows 2; the app runs at most 2 Network jobs at once\)/,
    /read-only, in an empty folder, no project files or lessons, only the agent’s approved memory/, /Research A: no tools; Research B: no tools; Reviewer: no tools/, /CostNot enforced, and unknown before it runs/]) assert.match(facts, pattern);
  assert.doesNotMatch(facts, /No job worker/);
  $('#network-run-input').value = 'Electric bikes in Europe.'; submit(ctx);
  await until(() => /^#\/network\/runs\/run_/.test(win.location.hash) && text(ctx, '#network-run-heading') === 'Research report · run of version 1', 'run view');
  const runId = win.location.hash.split('/')[3];
  assert.equal($('#network-tab-pipelines').getAttribute('aria-selected'), 'true');
  assert.match(text(ctx, '#network-run-pinned'), /This run uses version 1 exactly as published/);
  await slow(() => /waiting for your approval of “Your approval”/.test(text(ctx, '#network-run-summary')), 'the run waits for the approval (live)');
  assert.deepEqual(['Research A', 'Research B', 'Both researched', 'Reviewer', 'Your approval', 'Report'].map(name => runStatus(ctx, name)), ['Completed', 'Completed', 'Completed', 'Completed', 'Waiting for you', 'Waiting']);
  assert.equal(text(ctx, '#network-run-status'), 'Waiting for your approval');
  // Approve from the step.
  runRow(ctx, 'Your approval').click();
  await until(() => $('#network-run-approve'), 'approval details');
  assert.match(text(ctx, '#network-run-details'), /It asks: “Read the review\. Approve to save the report, or reject to stop the run\.”/);
  $('#network-run-approve').click();
  await slow(() => text(ctx, '#network-run-status') === 'Completed' && runStatus(ctx, 'Report') === 'Completed', 'completed');
  assert.equal(win.document.activeElement, $('#network-run-detail-heading'));
  assert.equal($('#network-run-cancel').hidden, true, 'no Cancel once the run ended');
  // The saved report, read back through the run and checked against its hash.
  runRow(ctx, 'Report').click();
  await until(() => $('#network-run-show-report'), 'report step');
  $('#network-run-show-report').click();
  await until(() => $('#network-run-report'), 'report shown');
  const saved = await readFile(join(runFolder(ctx, runId), 'reports', 'report.md'), 'utf8');
  assert.equal(saved, '# Research report\n\n## Research A\n\nDone: Research the topic in the run input.\n\n## Research B\n\nDone: Research the same topic from another angle: risks, competitors and open questions.\n\n## Reviewer\n\nDone: Review both research results: where they agree, where they differ and what is missing.\n');
  assert.deepEqual([...$('#network-run-report').querySelectorAll('h2, h3')].map(node => node.textContent), ['Research report', 'Research A', 'Research B', 'Reviewer']);
  assert.match(text(ctx, '#network-run-report'), /Done: Review both research results/);
  $('#network-run-download-report').click();
  assert.deepEqual(ctx.downloads.at(-1), 'report.md');
  // A report changed on disk is not shown.
  await writeFile(join(runFolder(ctx, runId), 'reports', 'report.md'), `${saved}Injected.\n`);
  $('#network-run-show-report').click(); await until(() => !$('#network-run-report'), 'hidden');
  $('#network-run-show-report').click();
  await until(() => /missing or changed since it was written/.test(text(ctx, '#network-run-details')), 'tampered report refused');
  // The job record of a step, with its provider and inputs on the step.
  runRow(ctx, 'Reviewer').click();
  await until(() => $('#network-run-open-job'), 'reviewer details');
  assert.match(text(ctx, '#network-run-step-facts'), /ProviderClaude Code/);
  assert.match(text(ctx, '#network-run-step-facts'), /InputsResearch A \(text\), Research B \(text\)/);
  assert.match(text(ctx, '#network-run-step-facts'), /Resultattempts\/att__[0-9a-f]{20}\/result\.md · \d+ characters · sha256 [0-9a-f]{12}/);
  $('#network-run-open-job').click();
  await until(() => $('#network-job-json'), 'job JSON');
  const job = JSON.parse(text(ctx, '#network-job-json'));
  assert.deepEqual([job.job.pipelineRunId, job.job.nodeId, job.job.status, job.request.pipeline.runId], [runId, ids.Reviewer, 'completed', runId]);
  // One start and one approval were sent; saving, validating and publishing started nothing.
  assert.deepEqual(log.filter(([method, url]) => method === 'POST' && /\/runs$|\/approve$/.test(url)).map(([, url]) => url.replace(/[a-z]{3}_[0-9a-f]{20}/g, 'ID').replace(/n_[0-9a-f]{12}/, 'N')), ['/api/network/pipelines/ID/runs', '/api/network/pipeline-runs/ID/nodes/N/approve']);
  assert.equal((await call(ctx, '/api/network/pipeline-runs')).json.total, 1);
});

test('a run keeps its pinned version while the draft is edited, saved and republished; reject from the run view; a reload shows the same run and draft', async t => {
  const ctx = await setup(t, { hash: '#/', networkWorker: fakeWorker() }); const { $, win } = ctx;
  const seeded = await seed(ctx), pipeline = await publishedDemo(ctx, seeded);
  await visit(ctx, `#/network/pipelines/${pipeline.id}`, () => text(ctx, '#network-pipeline-heading') === 'Market report');
  await designer(ctx, 'Market report');
  const runId = await startRun(ctx);
  await slow(() => runStatus(ctx, 'Your approval') === 'Waiting for you', 'waiting for the approval');
  const pinned = (await call(ctx, `/api/network/pipeline-runs/${runId}`)).json, planBytes = await readFile(join(runFolder(ctx, runId), 'plan.json'), 'utf8');

  // Edit the draft while the run waits: rename a step, add one, save and publish version 2.
  $('#network-run-open-pipeline').click();
  await designer(ctx, 'Market report');
  await pickStep(ctx, 'Reviewer');
  choose(ctx, '#network-pipeline-label', 'Changed reviewer');
  await until(() => stepRow(ctx, 'Changed reviewer') && $('#network-pipeline-dirty'), 'renamed');
  $('#network-pipeline-add-parallel').click();
  await until(() => stepRow(ctx, 'Parallel'), 'parallel added');
  await save(ctx);
  $('#network-pipeline-publish').click();
  await until(() => text(ctx, '#network-dialog-heading') === 'Publish version 2?', 'publish v2');
  assert.equal(text(ctx, '#network-pipeline-diff'), 'Compared with version 1: 1 step added, 1 step changed.');
  $('#network-confirm').click();
  await until(() => /Version 2 latest/.test(text(ctx, '#network-pipeline-meta')), 'v2');
  assert.deepEqual([...$('#network-pipeline-versions').querySelectorAll('[data-run-version]')].map(node => node.dataset.runVersion), ['2', '1']);
  assert.equal(text(ctx, '#network-pipeline-runs [data-run-id] strong'), 'Market report · version 1');

  // The run view still shows version 1: its own steps and labels, and the same plan bytes.
  $(`#network-pipeline-runs [data-run-id="${runId}"]`).click();
  await until(() => text(ctx, '#network-run-heading') === 'Market report · run of version 1' && runRow(ctx, 'Reviewer'), 'back to the run');
  assert.deepEqual([...$('#network-run-steps').querySelectorAll('[data-step-id] strong')].map(node => node.textContent), ['Research A', 'Research B', 'Both researched', 'Reviewer', 'Your approval', 'Report']);
  assert.equal(runRow(ctx, 'Changed reviewer'), undefined);
  assert.equal(await readFile(join(runFolder(ctx, runId), 'plan.json'), 'utf8'), planBytes, 'plan.json byte-identical');
  assert.deepEqual((await call(ctx, `/api/network/pipeline-runs/${runId}`)).json.plan, pinned.plan);

  // Reject from the step: the steps after it do not run and nothing is saved as a report.
  runRow(ctx, 'Your approval').click();
  await until(() => $('#network-run-reject'), 'approval details');
  $('#network-run-reject').click();
  await slow(() => text(ctx, '#network-run-status') === 'Cancelled', 'cancelled by the rejection');
  assert.deepEqual([runStatus(ctx, 'Your approval'), runStatus(ctx, 'Report')], ['Cancelled', 'Cancelled']);
  assert.match(text(ctx, '#network-run-summary'), /You rejected “Your approval”/);
  assert.match(text(ctx, '#network-run-details'), /You rejected it/);
  assert.deepEqual((await readdir(runFolder(ctx, runId))).sort(), ['plan.json', 'run.json', 'run.json.bak'], 'no report');
  // A version that cannot start now (an agent switched off) is refused in the confirmation, with the reason; nothing starts.
  await call(ctx, `/api/network/agents/${seeded.agents[2].id}`, 'PATCH', { expectedRevision: seeded.agents[2].revision, enabled: false });
  await visit(ctx, `#/network/pipelines/${pipeline.id}`, () => text(ctx, '#network-pipeline-heading') === 'Market report' && stepRow(ctx, 'Changed reviewer'));
  $('#network-pipeline-run').click();
  await until(() => /This version cannot start now: “Editor” is switched off in Network\./.test(text(ctx, '#network-run-facts')), 'refused in the confirmation');
  assert.equal($('#network-run-start').disabled, true);
  assert.match($('#network-run-start').title, /cannot start now/);
  submit(ctx); await ctx.idle();
  assert.equal((await call(ctx, '/api/network/pipeline-runs')).json.total, 1, 'nothing started');
  $('#network-dialog .kanban-dialog-actions button').click();
  await call(ctx, `/api/network/agents/${seeded.agents[2].id}`, 'PATCH', { expectedRevision: seeded.agents[2].revision + 1, enabled: true });

  // Reload: a new page and server on the same data folder show the same run and the edited draft.
  const again = await setup(t, { dataDir: ctx.dataDir, hash: `#/network/runs/${runId}`, networkWorker: fakeWorker() });
  await until(() => again.$('#network-run-status')?.textContent === 'Cancelled' && again.$('#network-run-steps [data-step-id]'), 'the run after a reload');
  assert.deepEqual([...again.$('#network-run-steps').querySelectorAll('[data-step-id]')].map(node => [node.querySelector('strong').textContent, node.querySelector('.base-status').textContent]),
    [['Research A', 'Completed'], ['Research B', 'Completed'], ['Both researched', 'Completed'], ['Reviewer', 'Completed'], ['Your approval', 'Cancelled'], ['Report', 'Cancelled']]);
  await visit(again, `#/network/pipelines/${pipeline.id}`, () => again.$('#network-pipeline-heading')?.textContent === 'Market report' && again.$('#network-pipeline-steps [data-step-id]'));
  assert.ok(stepRow(again, 'Changed reviewer') && stepRow(again, 'Parallel'), 'the saved draft after a reload');
  assert.ok(win);
});

test('live states and cancel: running steps show as running, a finished one as completed; Cancel run stops their jobs; the designer guards unsaved changes and keeps a conflicting edit as a new pipeline', async t => {
  const worker = fakeWorker({ mode: 'manual' });
  const ctx = await setup(t, { hash: '#/', networkWorker: worker }); const { $, win } = ctx;
  const seeded = await seed(ctx), pipeline = await publishedDemo(ctx, seeded);
  await visit(ctx, `#/network/pipelines/${pipeline.id}`, () => text(ctx, '#network-pipeline-heading') === 'Market report');
  await designer(ctx, 'Market report');
  const runId = await startRun(ctx, 'Cargo bikes.');
  await slow(() => worker.attempts.size === 2 && runStatus(ctx, 'Research A') === 'Running' && runStatus(ctx, 'Research B') === 'Running', 'both research steps running');
  const [first] = [...worker.attempts.values()];
  await first.own.launching(); await first.own.spawned({ pid: 7 }); await first.own.finish({ status: 'completed', exitCode: 0, result: { text: 'First findings.' } }); first.end();
  const done = first.job.nodeId === `n_${pad(1)}` ? 'Research A' : 'Research B', open = done === 'Research A' ? 'Research B' : 'Research A';
  await slow(() => runStatus(ctx, done) === 'Completed' && runStatus(ctx, open) === 'Running', 'the finished step shows completed while the other runs');
  runRow(ctx, open).click();
  await until(() => /Job(preparing|running|queued)/.test(text(ctx, '#network-run-step-facts')), 'the running step’s job');
  assert.match(text(ctx, '#network-run-step-facts'), /Try1 of 1/);
  assert.equal($('#network-run-approve'), null, 'no approval buttons on an agent step');
  // Cancel: the run and its open steps are cancelled, and the job engine stops the running job.
  $('#network-run-cancel').click();
  await until(() => text(ctx, '#network-dialog-heading') === 'Cancel this run?', 'cancel dialog');
  $('#network-confirm').click();
  await slow(() => text(ctx, '#network-run-status') === 'Cancelled' && runStatus(ctx, open) === 'Cancelled', 'cancelled');
  await until(() => worker.cancels.length >= 1, 'the worker was told to stop');
  assert.equal(runStatus(ctx, done), 'Completed', 'a finished step stays completed');
  assert.equal($('#network-run-cancel').hidden, true);
  const jobs = (await call(ctx, `/api/network/jobs?pipelineRunId=${runId}`)).json.jobs;
  assert.deepEqual(jobs.map(job => job.status).sort(), ['cancelled', 'completed']);

  // Unsaved changes: closing the tab and leaving ask; declining keeps the editor and its address.
  await visit(ctx, `#/network/pipelines/${pipeline.id}`, () => text(ctx, '#network-pipeline-heading') === 'Market report');
  await designer(ctx, 'Market report');
  const unload = () => { const event = new win.Event('beforeunload', { cancelable: true }); win.dispatchEvent(event); return event.defaultPrevented; };
  assert.equal(unload(), false);
  await pickStep(ctx, 'Reviewer'); choose(ctx, '#network-pipeline-label', 'Mine');
  await until(() => $('#network-pipeline-dirty'), 'dirty');
  assert.equal(unload(), true);
  const asked = []; win.confirm = question => { asked.push(question); return false; };
  win.location.hash = '#/network/pipelines';
  await until(() => asked.length === 1 && win.location.hash === `#/network/pipelines/${pipeline.id}`, 'declined');
  await ctx.idle();
  assert.match(asked[0], /Discard your unsaved changes to “Market report”\?/);
  assert.ok(stepRow(ctx, 'Mine') && !$('#network-pipeline-designer').hidden, 'the editor and its edits stay');
  // A save over a newer draft overwrites nothing and offers both ways out; "Save mine" makes a new pipeline.
  const current = (await call(ctx, `/api/network/pipelines/${pipeline.id}`)).json.pipeline;
  await call(ctx, `/api/network/pipelines/${pipeline.id}`, 'PATCH', { expectedRevision: current.revision, description: 'Changed elsewhere.' });
  $('#network-pipeline-save').click();
  await until(() => $('#network-pipeline-reload') && $('#network-pipeline-save-new'), 'conflict');
  assert.match(text(ctx, '#network-pipeline-alert'), /Nothing was overwritten/);
  assert.equal($('#network-pipeline-save').disabled, true);
  $('#network-pipeline-save-new').click();
  await designer(ctx, 'Market report (my changes)');
  assert.ok(stepRow(ctx, 'Mine'));
  const theirs = (await call(ctx, `/api/network/pipelines/${pipeline.id}`)).json.pipeline;
  assert.deepEqual([theirs.description, theirs.nodes.find(node => node.id === `n_${pad(4)}`).label], ['Changed elsewhere.', 'Reviewer']);
  win.confirm = () => true;

  // A step whose job fails: the step shows Failed with the job's reason, the run stops, the other step is cancelled.
  const second = (await call(ctx, `/api/network/pipelines/${pipeline.id}/runs`, 'POST', { version: 1, confirm: true })).json.runId;
  await visit(ctx, `#/network/runs/${second}`, () => text(ctx, '#network-run-heading') === 'Market report · run of version 1');
  await slow(() => [...worker.attempts.values()].filter(entry => entry.job.pipelineRunId === second).length === 2, 'both steps of the second run started');
  const failing = [...worker.attempts.values()].find(entry => entry.job.pipelineRunId === second && entry.job.nodeId === `n_${pad(1)}`);
  await failing.own.launching(); await failing.own.spawned({ pid: 8 }); await failing.own.finish({ status: 'failed', errorCode: 'PROVIDER_ERROR', reason: 'The CLI failed.', exitCode: 1 }); failing.end();
  await slow(() => text(ctx, '#network-run-status') === 'Failed' && runStatus(ctx, 'Research A') === 'Failed' && runStatus(ctx, 'Research B') === 'Cancelled', 'failed');
  assert.match(text(ctx, '#network-run-summary'), /Step “Research A” failed \(PROVIDER_ERROR\), so the run stopped \(failure policy: stop\)\./);
  runRow(ctx, 'Research A').click();
  await until(() => $('#network-run-step-reason'), 'the reason');
  assert.match(text(ctx, '#network-run-step-reason'), /^PROVIDER_ERROR: Its job job_[0-9a-f]{20} failed \(PROVIDER_ERROR\)\. The CLI failed\.$/);
  assert.ok($('#network-run-step-reason').classList.contains('network-stale'), 'shown as a problem');
});

test('a nested pipeline built from the UI: a sub-network step pins a published pipeline of a contained network, collapsed with drill-in; the run shows it as one group to expand; its inner approval is approved from the UI; disabled agents are highlighted before any check', async t => {
  const ctx = await setup(t, { hash: '#/', networkWorker: fakeWorker({ text: job => `Done: ${job.request.instructions || 'no instructions'}` }) }); const { $, win } = ctx;
  const agents = [];
  for (const [index, name] of ['Scout', 'Analyst', 'Editor'].entries()) {
    await ctx.app.board.base.create({ id: `b${index}`, kind: 'profile', name, configuration: { agent: { provider: 'claude' } } });
    agents.push((await call(ctx, '/api/network/agents', 'POST', { baseResourceId: `b${index}`, expectedRevision: index })).json.agent);
  }
  // The inner network and its published pipeline: check facts → your approval → output “checked”.
  const inner = (await call(ctx, '/api/network/networks', 'POST', { name: 'Checkers', nodes: [{ id: `n_${pad(1)}`, type: 'agent', agentId: agents[1].id, position: { x: 0, y: 0 } }], edges: [] })).json.network;
  await call(ctx, `/api/network/networks/${inner.id}/publish`, 'POST', { expectedRevision: 1 });
  const child = (await call(ctx, '/api/network/pipelines', 'POST', { networkId: inner.id, networkVersion: 1, name: 'Fact check',
    nodes: [{ id: `n_${pad(1)}`, type: 'agent', label: 'Check facts', position: { x: 0, y: 0 }, config: { agentId: agents[1].id, instructions: 'Check the facts.' } },
      { id: `n_${pad(2)}`, type: 'approval', label: 'Inner approval', position: { x: 220, y: 0 }, config: { prompt: 'Are the facts right?' } },
      { id: `n_${pad(3)}`, type: 'output', label: 'Checked', position: { x: 440, y: 0 }, config: { name: 'checked', include: [`n_${pad(1)}`] } }],
    edges: [{ id: `e_${pad(1)}`, from: `n_${pad(1)}`, to: `n_${pad(2)}`, fromPort: 'text' }, { id: `e_${pad(2)}`, from: `n_${pad(2)}`, to: `n_${pad(3)}`, fromPort: 'done' }] })).json.pipeline;
  await call(ctx, `/api/network/pipelines/${child.id}/publish`, 'POST', { expectedRevision: 1 });
  // A pipeline of the inner network's version 2 is out of scope for a network that pins version 1, so it is never offered.
  await call(ctx, `/api/network/networks/${inner.id}`, 'PATCH', { expectedRevision: 2, description: 'Second version.' });
  assert.equal((await call(ctx, `/api/network/networks/${inner.id}/publish`, 'POST', { expectedRevision: 3 })).status, 200);
  const later = (await call(ctx, '/api/network/pipelines', 'POST', { networkId: inner.id, networkVersion: 2, name: 'Later check',
    nodes: [{ id: `n_${pad(1)}`, type: 'agent', label: 'Check', position: { x: 0, y: 0 }, config: { agentId: agents[1].id } }, { id: `n_${pad(2)}`, type: 'output', label: 'Out', position: { x: 220, y: 0 }, config: { include: [`n_${pad(1)}`] } }],
    edges: [{ id: `e_${pad(1)}`, from: `n_${pad(1)}`, to: `n_${pad(2)}`, fromPort: 'text' }] })).json.pipeline;
  assert.equal((await call(ctx, `/api/network/pipelines/${later.id}/publish`, 'POST', { expectedRevision: 1 })).status, 200);
  // The outer network contains Scout, Editor and the inner network at version 1.
  const outer = (await call(ctx, '/api/network/networks', 'POST', { name: 'Desk', nodes: [{ id: `n_${pad(1)}`, type: 'agent', agentId: agents[0].id, position: { x: 0, y: 0 } }, { id: `n_${pad(2)}`, type: 'agent', agentId: agents[2].id, position: { x: 200, y: 0 } },
    { id: `n_${pad(3)}`, type: 'subnetwork', networkId: inner.id, version: 1, position: { x: 400, y: 0 } }], edges: [] })).json.network;
  await call(ctx, `/api/network/networks/${outer.id}/publish`, 'POST', { expectedRevision: 1 });

  // Build it in the designer: New pipeline, an agent step, a sub-network step, an output; arrows from the forms.
  await visit(ctx, '#/network/pipelines', () => $('#network-pipelines-new') && !$('#network-pipelines-view').hidden && $('#network-pipelines-list [data-pipeline-id]'));
  $('#network-pipelines-new').click();
  await until(() => /1 agent in this version: Analyst\./.test(text(ctx, '#network-pipeline-members')), 'new pipeline dialog');
  choose(ctx, '#network-pipeline-network-input', outer.id);
  await until(() => /2 agents in this version: Scout, Editor\./.test(text(ctx, '#network-pipeline-members')), 'the chosen network’s agents');
  $('#network-pipeline-name-input').value = 'Nested'; submit(ctx);
  await designer(ctx, 'Nested').catch(() => {});
  await until(() => text(ctx, '#network-pipeline-heading') === 'Nested' && /No steps yet/.test(text(ctx, '#network-pipeline-steps')), 'empty designer');
  assert.match(text(ctx, '#network-pipeline-check'), /Add an output step/);
  $('#network-pipeline-add-agent').click();
  await until(() => $('#network-pipeline-pick-agents [data-agent-id]'), 'agents of the pinned version');
  assert.deepEqual([...$('#network-pipeline-pick-agents').querySelectorAll('[data-agent-id] strong')].map(node => node.textContent), ['Scout', 'Editor'], 'only members of the pinned network version');
  $(`#network-pipeline-pick-agents [data-agent-id="${agents[0].id}"]`).click();
  await until(() => stepRow(ctx, 'Scout'), 'agent step');
  choose(ctx, '#network-pipeline-instructions', 'Find the claims.');
  $('#network-pipeline-add-subnetwork').click();
  await until(() => $('#network-pipeline-pick-sub'), 'sub-pipeline choices');
  assert.deepEqual([...$('#network-pipeline-pick-sub').options].map(option => option.textContent), ['Fact check · version 1 (network “Checkers” version 1)']);
  $('#network-pipeline-pick-sub-add').click();
  await until(() => stepRow(ctx, 'Fact check'), 'sub-network step');
  assert.match(text(ctx, '#network-pipeline-details'), /Runs “Fact check” version 1, collapsed here\. A run expands it into its own steps\./);
  $('#network-pipeline-inside').click();
  await until(() => /“Fact check” version 1: 3 steps, read only\./.test(text(ctx, '#network-pipeline-inside-list')), 'drill-in: its steps');
  assert.match(text(ctx, '#network-pipeline-inside-list'), /Check facts · Agent.*Inner approval · Approval.*Checked · Output/);
  $('#network-pipeline-add-output').click();
  await until(() => stepRow(ctx, 'Output “report”'), 'output step');
  await arrow(ctx, 'Scout', 'text', 'Fact check');
  await until(() => edgeNames(ctx).includes('Scout → Fact check (text → input)'), 'scout to the sub-pipeline');
  await pickStep(ctx, 'Fact check');
  assert.deepEqual([...$('#network-pipeline-connect-port').options].map(option => option.value), ['text'], 'a sub-pipeline sends its report text');
  await arrow(ctx, 'Fact check', 'text', 'Output “report”');
  await until(() => edgeNames(ctx).includes('Fact check → Output “report” (text → input)'), 'sub-pipeline to the output');
  await pickStep(ctx, 'Output “report”');
  assert.equal($(`#network-pipeline-include-${stepRow(ctx, 'Fact check').dataset.stepId}`).checked, true, 'connecting a result to an output ticks it');
  await save(ctx);
  $('#network-pipeline-validate').click();
  await until(() => $('#network-pipeline-valid'), 'valid');
  assert.match(text(ctx, '#network-pipeline-valid'), /5 steps after sub-pipelines are expanded, 2 agent jobs, 1 sub-pipeline\./);
  $('#network-pipeline-publish').click(); await until(() => $('#network-confirm'), 'publish'); $('#network-confirm').click();
  await until(() => /Version 1 latest/.test(text(ctx, '#network-pipeline-meta')), 'published');
  const pipelineId = win.location.hash.split('/')[3], subStep = stepRow(ctx, 'Fact check').dataset.stepId;

  // Disabled agents are highlighted in the designer from the registrations, before Validate.
  const editor = (await call(ctx, `/api/network/agents/${agents[2].id}`)).json.agent;
  await call(ctx, `/api/network/agents/${agents[0].id}`, 'PATCH', { expectedRevision: agents[0].revision, enabled: false });
  await visit(ctx, '#/network/pipelines', () => !$('#network-pipelines-view').hidden);
  await visit(ctx, `#/network/pipelines/${pipelineId}`, () => text(ctx, '#network-pipeline-heading') === 'Nested' && stepRow(ctx, 'Scout'));
  assert.match(stepRow(ctx, 'Scout').textContent, /Check it/);
  assert.match(text(ctx, '#network-pipeline-check'), /Scout: “Scout” is switched off in Network\. Switch it on in its profile, or choose another agent\./);
  await call(ctx, `/api/network/agents/${agents[0].id}`, 'PATCH', { expectedRevision: agents[0].revision + 1, enabled: true });
  assert.ok(editor);
  await visit(ctx, '#/network/pipelines', () => !$('#network-pipelines-view').hidden);
  await visit(ctx, `#/network/pipelines/${pipelineId}`, () => text(ctx, '#network-pipeline-heading') === 'Nested' && stepRow(ctx, 'Scout') && !/Check it/.test(stepRow(ctx, 'Scout').textContent));

  // Run it: the sub-pipeline is one collapsed group; expanding it shows its steps; its inner approval is approved here.
  const runId = await startRun(ctx, 'Claims about cargo bikes.');
  const groupRow = () => $(`#network-run-steps [data-group-id="${subStep}"]`);
  await slow(() => groupRow() && /waiting for your approval of “Inner approval”/.test(text(ctx, '#network-run-summary')), 'the inner approval waits');
  assert.match(groupRow().textContent, /Fact check · version 1Sub-pipeline · 1 of 3 steps completedWaiting for you/);
  assert.equal(runRow(ctx, 'Inner approval'), undefined, 'collapsed: its steps are not listed');
  assert.deepEqual([...$('#network-run-steps').querySelectorAll('[data-step-id] strong, [data-group-id] strong')].map(node => node.textContent), ['Scout', 'Fact check · version 1', 'Output “report”']);
  $(`[data-toggle-group="${subStep}"]`).click();
  await until(() => runRow(ctx, 'Inner approval'), 'expanded');
  assert.equal($(`[data-toggle-group="${subStep}"]`).getAttribute('aria-expanded'), 'true');
  assert.deepEqual(['Check facts', 'Inner approval', 'Checked'].map(name => [runRow(ctx, name).closest('li').dataset.depth, runStatus(ctx, name)]), [['1', 'Completed'], ['1', 'Waiting for you'], ['1', 'Waiting']]);
  groupRow().click();
  await until(() => text(ctx, '#network-run-detail-heading') === 'Fact check', 'group details');
  assert.match(text(ctx, '#network-run-details'), /Sub-pipeline “Fact check”, version 1 \(sha256 [0-9a-f]{12}\), of network version 1\. Waiting for you\./);
  $(`#network-run-details [data-inner-step="${subStep}/n_${pad(2)}"]`).click();
  await until(() => $('#network-run-approve'), 'the inner approval');
  assert.match(text(ctx, '#network-run-details'), /Approval step inside “Fact check”\./);
  $('#network-run-approve').click();
  await slow(() => text(ctx, '#network-run-status') === 'Completed', 'completed');
  assert.match(groupRow().textContent, /3 of 3 steps completed/);
  const files = (await readdir(join(runFolder(ctx, runId), 'reports'))).sort();
  assert.deepEqual(files, [`${subStep}.checked.md`, 'report.md']);
  const report = await readFile(join(runFolder(ctx, runId), 'reports', 'report.md'), 'utf8');
  assert.match(report, /^# Nested\n\n## Fact check\n\n# Fact check\n\n## Check facts\n\nDone: Check the facts\./);
  const approvals = (await call(ctx, `/api/network/pipeline-runs/${runId}`)).json.run.nodes[`${subStep}/n_${pad(2)}`].approval;
  assert.deepEqual([approvals.decision, approvals.by], ['approved', 'owner']);
});

test('the list: rename, duplicate, delete only a never-published pipeline, the network filter; labels and keyboard paths; Graph and Pipeline explain their different edges, which never mix; the phone shows the ordered steps, then one step', async t => {
  const ctx = await setup(t, { hash: '#/', networkWorker: fakeWorker() }); const { $, win } = ctx;
  const seeded = await seed(ctx), published = await publishedDemo(ctx, seeded, 'Published one');
  const draft = (await call(ctx, '/api/network/pipelines', 'POST', { networkId: seeded.network.id, networkVersion: 1, name: 'Draft one' })).json.pipeline;
  const other = (await call(ctx, '/api/network/networks', 'POST', { name: 'Other', nodes: [{ id: `n_${pad(1)}`, type: 'agent', agentId: seeded.agents[0].id, position: { x: 0, y: 0 } }], edges: [] })).json.network;
  await call(ctx, `/api/network/networks/${other.id}/publish`, 'POST', { expectedRevision: 1 });
  await call(ctx, '/api/network/pipelines', 'POST', { networkId: other.id, networkVersion: 1, name: 'Elsewhere' });
  const rows = () => [...$('#network-pipelines-list').querySelectorAll('[data-pipeline-id] strong')].map(node => node.textContent);
  await visit(ctx, '#/network/pipelines', () => rows().length === 3);
  assert.deepEqual(rows(), ['Published one', 'Draft one', 'Elsewhere']);
  const action = (name, id) => $(`[data-action="${name}-${id}"]`);
  assert.equal(action('delete', published.id).disabled, true);
  assert.match(action('delete', published.id).title, /published versions/);
  assert.equal(action('delete', draft.id).disabled, false);
  choose(ctx, '#network-pipelines-network', seeded.network.id);
  await until(() => rows().join() === 'Published one,Draft one', 'filtered by network');
  // Rename, duplicate and delete.
  action('rename', draft.id).click(); await until(() => $('#network-pipeline-name-input'), 'rename dialog');
  $('#network-pipeline-name-input').value = 'Renamed draft'; submit(ctx);
  await until(() => rows().includes('Renamed draft') && win.document.activeElement?.dataset.pipelineId === draft.id, 'renamed, focus on its row');
  action('duplicate', published.id).click(); await until(() => $('#network-pipeline-name-input')?.value === 'Published one (copy)', 'duplicate dialog');
  submit(ctx);
  await until(() => rows().includes('Published one (copy)'), 'duplicated');
  const copy = (await call(ctx, `/api/network/pipelines?q=${encodeURIComponent('(copy)')}`)).json.pipelines[0];
  const original = (await call(ctx, `/api/network/pipelines/${published.id}`)).json.pipeline;
  assert.deepEqual([copy.publishedVersions, copy.stepCount, copy.networkVersion], [[], original.nodes.length, 1]);
  action('delete', draft.id).click(); await until(() => text(ctx, '#network-dialog-heading') === 'Delete pipeline?', 'delete dialog');
  $('#network-confirm').click();
  await until(() => !rows().includes('Renamed draft') && win.document.activeElement === $('#network-pipelines-new'), 'deleted');
  assert.equal((await call(ctx, `/api/network/pipelines/${draft.id}`)).status, 404);
  assert.equal((await call(ctx, `/api/network/pipelines/${published.id}`, 'DELETE', { expectedRevision: original.revision })).json.code, 'PIPELINE_PUBLISHED');

  // Every control in the list, the designer and the run dialog is named; disabled buttons say why.
  const named = root => {
    for (const control of root.querySelectorAll('input, select, textarea')) assert.ok(control.labels?.length || control.getAttribute('aria-label'), `${control.id || control.outerHTML.slice(0, 80)} has a label`);
    for (const node of root.querySelectorAll('button')) { assert.ok((node.textContent.trim() || node.getAttribute('aria-label') || '').length > 0, `${node.outerHTML.slice(0, 80)} has a name`); if (node.disabled && !node.hidden) assert.ok(node.title, `${node.id || node.textContent} says why it is disabled`); }
  };
  named($('#network-panel-pipelines'));
  await visit(ctx, `#/network/pipelines/${published.id}`, () => text(ctx, '#network-pipeline-heading') === 'Published one');
  await designer(ctx, 'Published one');
  assert.match(text(ctx, '#network-pipeline-detail-heading'), /Pipeline settings/);
  named($('#network-panel-pipelines'));
  // Keyboard paths: the palette adds, the connect form connects with a port, a select configures; all buttons and selects.
  $('#network-pipeline-add-join').focus(); $('#network-pipeline-add-join').click();
  await until(() => win.document.activeElement === $('#network-pipeline-detail-heading') && text(ctx, '#network-pipeline-detail-heading') === 'Join', 'join added');
  named($('#network-pipeline-details'));
  choose(ctx, '#network-pipeline-require', 'any');
  await until(() => /waits for the first/.test(stepRow(ctx, 'Join').textContent), 'configured');
  choose(ctx, '#network-pipeline-connect-port', 'done'); choose(ctx, '#network-pipeline-connect-to', stepRow(ctx, 'Report').dataset.stepId);
  $('#network-pipeline-connect-add').click();
  await until(() => edgeNames(ctx).includes('Join → Report (done → input)'), 'connected from the form');
  assert.equal(win.document.activeElement, $('#network-pipeline-connect-add'), 'focus stays on Add arrow');
  await pickStep(ctx, 'Research A');
  assert.deepEqual([...$('#network-pipeline-connect-port').options].map(option => option.value), ['text', 'json'], 'an agent sends on text and json');
  await pickStep(ctx, 'Your approval');
  assert.deepEqual([...$('#network-pipeline-connect-port').options].map(option => option.value), ['done']);
  // The canvas keys: arrows move the chosen step (Shift: 50), Delete removes it, Escape lets go of it.
  const key = (name, extra = {}) => $('#network-pipeline-canvas').dispatchEvent(new win.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...extra }));
  await pickStep(ctx, 'Join');
  const position = () => [...$('#network-pipeline-details').querySelectorAll('dt')].find(node => node.textContent === 'Position').nextSibling.textContent;
  const [x, y] = position().split(', ').map(Number);
  key('ArrowRight'); key('ArrowDown', { shiftKey: true });
  await until(() => position() === `${x + 10}, ${y + 50}`, 'moved by keys');
  key('Delete');
  await until(() => !stepRow(ctx, 'Join') && edgeNames(ctx).length === 6, 'deleted by key');
  $('#network-pipeline-undo').click();
  await until(() => stepRow(ctx, 'Join') && edgeNames(ctx).length === 7, 'undo brings it back with its arrow');
  await pickStep(ctx, 'Join'); key('Escape');
  await until(() => text(ctx, '#network-pipeline-detail-heading') === 'Pipeline settings', 'Escape lets go');
  for (let n = 0; n < 6; n++) $('#network-pipeline-undo').click();
  await until(() => !$('#network-pipeline-dirty') && !stepRow(ctx, 'Join'), 'undone to the saved draft');
  $('#network-pipeline-run').click();
  await until(() => $('#network-run-start') && !$('#network-run-start').disabled, 'run dialog');
  named($('#network-dialog'));
  $('#network-dialog .kanban-dialog-actions button').click();

  // Graph and Pipelines say what their edges mean; a relation is not an execution edge and is refused as one.
  assert.match(text(ctx, '#network-pipeline-semantics'), /not Graph relations, which record permissions and intent/);
  const saved = (await call(ctx, `/api/network/pipelines/${published.id}`)).json.pipeline;
  const pasted = await call(ctx, `/api/network/pipelines/${published.id}`, 'PATCH', { expectedRevision: saved.revision, edges: [...saved.edges, { id: `e_${pad(99)}`, from: `n_${pad(1)}`, to: `n_${pad(4)}`, relation: 'delegate' }] });
  assert.equal(pasted.status, 400, 'a graph relation cannot be pasted into a pipeline');
  const fresh = (await call(ctx, '/api/network/pipelines', 'POST', { networkId: seeded.network.id, networkVersion: 1, name: 'Fresh' })).json.pipeline;
  await visit(ctx, `#/network/pipelines/${fresh.id}`, () => text(ctx, '#network-pipeline-heading') === 'Fresh');
  await until(() => /Arrows \(0\)/.test(text(ctx, '#network-pipeline-edges-title')), 'fresh designer');
  assert.equal(edgeNames(ctx).length, 0, 'the network’s share_result relation is not an arrow here');
  await visit(ctx, `#/network/graph/${seeded.network.id}`, () => $('#network-graph-inert') && !$('#network-panel-graph').hidden);
  assert.match(text(ctx, '#network-graph-inert'), /Relations are permissions and intent, not execution order: what runs after what, and which results move, is drawn with a pipeline’s own arrows in Network → Pipelines\./);

  // The phone: the ordered step list, then one step's details with Back; the run view does the same.
  Object.defineProperty(win, 'innerWidth', { value: 390, configurable: true });
  await visit(ctx, `#/network/pipelines/${published.id}`, () => text(ctx, '#network-pipeline-heading') === 'Published one');
  await designer(ctx, 'Published one');
  assert.equal($('#network-panel-pipelines').dataset.view, 'list');
  assert.equal($('#network-pipeline-arrange').hidden, true, 'positions do not matter on a phone');
  stepRow(ctx, 'Reviewer').click();
  await until(() => $('#network-panel-pipelines').dataset.view === 'detail' && win.document.activeElement === $('#network-pipeline-detail-heading'), 'one step');
  $('#network-pipeline-back').click();
  await until(() => $('#network-panel-pipelines').dataset.view === 'list' && win.document.activeElement === stepRow(ctx, 'Reviewer'), 'back to its row');
  $('#network-pipeline-open-settings').click();
  await until(() => $('#network-panel-pipelines').dataset.view === 'detail' && text(ctx, '#network-pipeline-detail-heading') === 'Pipeline settings', 'settings on a phone');
  const runId = await startRun(ctx);
  await slow(() => runStatus(ctx, 'Your approval') === 'Waiting for you', 'the run waits');
  assert.equal($('#network-panel-pipelines').dataset.view, 'list');
  runRow(ctx, 'Your approval').click();
  await until(() => $('#network-panel-pipelines').dataset.view === 'detail' && $('#network-run-approve') && win.document.activeElement === $('#network-run-detail-heading'), 'approval on a phone');
  $('#network-run-approve').click();
  await slow(() => text(ctx, '#network-run-status') === 'Completed', 'approved on a phone');
  $('#network-run-back').click();
  await until(() => $('#network-panel-pipelines').dataset.view === 'list' && win.document.activeElement === runRow(ctx, 'Your approval'), 'back to the steps');
  assert.ok(runId);
});
