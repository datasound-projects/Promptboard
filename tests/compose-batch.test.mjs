import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import '../public/origin-model.js';
import { OriginStore } from '../src/origin.mjs';
import { REVIEW_CRITERIA } from '../src/pipeline.mjs';
import { normalizeOverrides, resolveSettings, evidenceOf } from '../src/compose-batch.mjs';
import { assessPrompt, taskInput, traceRequirements } from '../src/prompt-integrity.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const Model = globalThis.PromptboardOriginModel;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(app, path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}

/**
 * A stand-in prompt engineer: drafts keep every source line, reviews confirm every unit, splits make two parts.
 * It records each call, how many ran at once, and lets a test hold, fail or slow down chosen tasks.
 */
function engineer({ delay = 5, fail = () => null, hold = () => false, late = () => false, rewrite = text => text } = {}) {
  const calls = [];
  let active = 0;
  const runner = async call => {
    const entry = { ...call, at: Date.now() };
    calls.push(entry); active++; runner.max = Math.max(runner.max, active);
    try {
      if (call.prompt.includes('\n# Revision task\n')) return { text: JSON.parse(call.prompt.split('# Revision data\n')[1]).previousDraft }; // A repair that changes nothing.
      const request = call.prompt.startsWith('# Review task') ? null : JSON.parse(call.prompt.split('# Source data\n')[1] || 'null');
      const own = request?.request || request?.prompt || call.prompt;
      if (hold(own)) await new Promise((resolve, reject) => call.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
      if (late(own)) await wait(250); // Ignores Cancel and answers anyway.
      const failure = fail(own); if (failure) throw failure;
      await wait(delay);
      if (call.prompt.startsWith('# Review task')) {
        const data = JSON.parse(call.prompt.split('# Review data\n')[1]);
        return { text: JSON.stringify({ covered: data.units.map(unit => unit.id), requirements: [], criteria: Object.fromEntries(REVIEW_CRITERIA.map(name => [name, 'pass'])), issues: [] }) };
      }
      if (call.prompt.startsWith('# Task split')) return { text: JSON.stringify({ tasks: [{ title: 'Build the first part', prompt: `${request.prompt}\nPart one.` }, { title: 'Build the second part', prompt: 'Part two.' }] }) };
      const lines = request.request.split('\n');
      return { text: rewrite(`# Goal\n${lines.filter(line => !line.startsWith('Done when:')).join('\n')}\n\n# Acceptance checks\n${lines.filter(line => line.startsWith('Done when:')).map(line => `- ${line.slice(11)}`).join('\n')}`, request) };
    } finally { active--; }
  };
  runner.calls = calls; runner.max = 0;
  return runner;
}

/** An Origin project with `count` tasks linked to a pipeline board. `dependsOn(i)` gives each task's prerequisites. */
async function project(app, count, { dependsOn = () => [], link = true } = {}) {
  const store = new OriginStore(app.board.store.dir);
  let record = await store.create({ name: `Shop ${count}` });
  if (link) { const kanban = await app.board.createProject({ name: `Shop board ${count}`, workflowMode: 'pipeline' }); record = await store.link(record.id, { expectedRevision: record.revision, kanbanProjectId: kanban.id }); }
  const blueprint = Model.emptyBlueprint();
  Object.assign(blueprint.vision, { summary: 'A small shop', goal: 'Sell things' });
  blueprint.technologies.push({ id: 'tx', name: 'MongoDB', status: 'rejected' });
  for (let i = 1; i <= count; i++) blueprint.items.push({ id: `t${i}`, key: `IMP-${String(i).padStart(3, '0')}`, title: `Task ${i}`, description: `Implement feature ${i} with marker MARK${i} in \`src/f${i}.js\`.`, acceptanceCriteria: `Feature ${i} answers with status 200`, dependsOn: dependsOn(i) });
  blueprint.sequence = { items: count };
  record = await store.write(record.id, { expectedRevision: record.revision, blueprint });
  return { store, record };
}

async function setup(t, runner, options = {}) {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [{ id: 'codex', available: true }], runner, ...options });
  const { token } = (await api(app, '/api/session')).data;
  const call = (path, body, method = body ? 'POST' : 'GET') => api(app, `/api/compose/batches${path}`, { method, token, body });
  return { app, token, call };
}
const settle = async (call, id, done = batch => batch.items.every(item => !['queued', 'running'].includes(item.state)), timeout = 20000) => {
  const end = Date.now() + timeout;
  for (;;) { const { data } = await call(`/${id}`); if (done(data.batch)) return data.batch; if (Date.now() > end) throw new Error(`Batch did not settle: ${JSON.stringify(data.batch.counts)}`); await wait(20); }
};
const states = batch => Object.fromEntries(batch.items.map(item => [item.key, item.state]));

test('settings inherit from Compose defaults, then the batch, then the task; another CLI resets the model', () => {
  const defaults = { provider: 'codex', model: 'gpt-5.5', effort: 'high', language: 'en', detail: 'concise', quality: 'reviewed', task: 'build', options: { acceptanceChecks: true, planFirst: false } };
  const { value, from } = resolveSettings(defaults, { detail: 'detailed', options: { edgeCases: true } }, { provider: 'claude', instructions: 'Keep the public API.' });
  assert.deepEqual([value.provider, value.model, value.effort, value.detail, value.options.edgeCases, value.options.planFirst, value.instructions, value.includeContext],
    ['claude', '', '', 'detailed', true, false, 'Keep the public API.', true]);
  assert.deepEqual([from.provider, from.model, from.detail, from['options.edgeCases'], from['options.planFirst'], from.language], ['task', 'task', 'batch', 'batch', 'defaults', 'defaults']);
  assert.equal(resolveSettings(defaults, {}, { provider: 'claude', model: 'opus' }).value.model, 'opus');
  assert.throws(() => normalizeOverrides({ provider: 'nope' }), /valid provider/);
  assert.throws(() => normalizeOverrides({ secret: 1 }), /unknown field/);
  assert.throws(() => normalizeOverrides({ instructions: 'Call it with api_key=abcdef0123456789' }), /secret/);
});

test('integrity: exact literals, confirmed review findings and edits gate approval; the trace links requirement, section and check', () => {
  const input = taskInput({ key: 'IMP-001', title: 'Login', description: 'Add `POST /login` with a 30 s timeout.', acceptanceCriteria: '- A user can sign in with email\n- Wrong passwords return 401' });
  assert.equal(input, 'IMP-001 Login\nAdd `POST /login` with a 30 s timeout.\nDone when: A user can sign in with email\nDone when: Wrong passwords return 401');
  const source = { input, otherKeys: ['IMP-009'], rejected: ['MongoDB'], warnings: [] };
  const good = '# Goal\nImplement IMP-001 Login: add `POST /login` with a 30 s timeout.\n\n# Acceptance checks\n- A user can sign in with email.\n- Wrong passwords return 401.';
  const review = { status: 'pass', requirements: [], criteria: REVIEW_CRITERIA.map(criterion => ({ criterion, status: 'pass' })), issues: [] };
  let result = assessPrompt({ source, prompt: good, verification: { review } });
  assert.deepEqual([result.status, result.findings], ['pass', []]);
  const trace = traceRequirements(input, good, review);
  assert.deepEqual(trace.map(row => [row.id, row.kind, row.section, row.check !== '']), [['S1', 'task', 'Goal', false], ['S2', 'task', 'Goal', false], ['S3', 'done-when', 'Acceptance checks', true], ['S4', 'done-when', 'Acceptance checks', true]]);
  // A fence closes only with its own character, as verification reads it: a ``` line and a # line inside ~~~ are code.
  const fenced = '# Goal\nImplement IMP-001 Login: add `POST /login` with a 30 s timeout.\n~~~\n```\n# Not a heading\n~~~\n\n# Acceptance checks\n- A user can sign in with email.\n- Wrong passwords return 401.';
  assert.deepEqual(traceRequirements(input, fenced, review).map(row => row.section), ['Goal', 'Goal', 'Acceptance checks', 'Acceptance checks']);
  assert.deepEqual(traceRequirements(input, '# Goal\n~~~\n```\n# Acceptance checks\n- A user can sign in with email.\n~~~', review).map(row => row.check), ['', '', '', '']);
  // A dropped literal and a dropped check are found without a model.
  result = assessPrompt({ source, prompt: '# Goal\nAdd a login endpoint.\n\n# Acceptance checks\n- A user can sign in with email.', verification: { review: { ...review, status: 'skipped' } } });
  assert.equal(result.status, 'blocked');
  assert.ok(result.findings.some(row => row.code === 'literal' && /POST \/login|30 s/.test(row.message + row.excerpt)));
  assert.ok(result.findings.some(row => row.code === 'acceptance-untraced' && /401/.test(row.message)));
  assert.ok(result.findings.some(row => row.code === 'review-skipped' && row.severity === 'warning'));
  // Another task's key, a rejected technology and a confirmed review finding.
  result = assessPrompt({ source, prompt: `${good}\nReuse IMP-009 and store sessions in MongoDB.`, verification: { review: { ...review, status: 'issues', requirements: [{ id: 'S4', status: 'missing', note: 'No 401 check', sourceQuote: 'Wrong passwords return 401', promptQuote: '' }], issues: [] } } });
  assert.deepEqual(result.findings.map(row => [row.severity, row.code]).sort(), [['blocking', 'requirement-missing'], ['warning', 'other-task'], ['warning', 'rejected-technology']]);
  // An edit is checked again for literals; it cannot clear a review that found problems.
  assert.equal(assessPrompt({ source, prompt: good, verification: { review: { ...review, status: 'issues', requirements: [], issues: [{ category: 'scope', message: 'x' }] } }, reviewStale: true }).findings[0].code, 'recheck-required');
  assert.deepEqual(assessPrompt({ source, prompt: good, verification: { review }, reviewStale: true }).findings.map(row => row.code), ['edit-unreviewed']);
  // Origin context becomes bounded evidence excerpts.
  const { rows, skipped } = evidenceOf(`## Project\nShop\n\n## Huge\n${'x'.repeat(30000)}\n\n## Starts after\n- IMP-000`);
  assert.deepEqual([rows.map(row => row.locator), skipped], [['Project', 'Starts after'], ['Huge']]);
});

test('Origin tasks enter the batch once, in build order, and nothing runs until asked', async t => {
  const runner = engineer();
  const { app, call } = await setup(t, runner);
  const { record } = await project(app, 4, { dependsOn: i => (i === 1 ? ['t3'] : []) });
  let { status, data } = await call('', { originId: record.id, expectedRevision: record.revision, itemIds: ['t1', 't2', 't3'], defaults: { provider: 'codex' } });
  assert.equal(status, 200, JSON.stringify(data));
  assert.deepEqual([data.added, data.existing, data.batch.items.map(item => item.key)], [3, 0, ['IMP-003', 'IMP-001', 'IMP-002']]);
  assert.deepEqual(new Set(data.batch.items.map(item => item.state)), new Set(['pending']));
  ({ data } = await call('', { originId: record.id, expectedRevision: record.revision, itemIds: ['t1', 't2', 't4'] }));
  assert.deepEqual([data.added, data.existing, data.batch.items.length], [1, 2, 4]);
  assert.equal((await call('', { originId: record.id, expectedRevision: record.revision - 1, itemIds: ['t1'] })).data.code, 'ORIGIN_REVISION_CONFLICT');
  assert.equal(runner.calls.length, 0, 'Sending to Compose never starts a model call.');
  assert.deepEqual((await call('')).data.batches.map(batch => [batch.id, batch.count]), [[record.id, 4]]);
});

test('runs are parallel within the limit, isolated per task, and keep their own settings and versions', async t => {
  const runner = engineer({ delay: 40 });
  const { app, call } = await setup(t, runner);
  const { record } = await project(app, 20);
  await call('', { originId: record.id, expectedRevision: record.revision, itemIds: record.blueprint.items.map(item => item.id) });
  await call(`/${record.id}/settings`, { concurrency: 3, settings: { detail: 'detailed' } });
  await call(`/${record.id}/items/t7`, { overrides: { provider: 'claude', model: 'opus' } }, 'PATCH');
  const run = await call(`/${record.id}/run`, { all: true, defaults: { provider: 'codex', model: 'gpt-5.5', quality: 'reviewed' } });
  assert.equal(run.data.queued, 20);
  const again = await call(`/${record.id}/run`, { itemIds: ['t1', 't2'] });
  assert.deepEqual(again.data.skipped.map(row => row.reason), ['Already running.', 'Already running.'], 'A second click never starts a second run.');
  const batch = await settle(call, record.id);
  assert.deepEqual(new Set(batch.items.map(item => item.state)), new Set(['generated']), JSON.stringify(batch.items.filter(item => item.state !== 'generated')));
  assert.equal(runner.max, 3, 'At most three calls ran at once, and they did run at once.');
  assert.equal(runner.calls.length, 40, 'One draft and one review per task, no repairs.');
  // Isolation: each call carries only its own task, in its own temporary folder.
  for (const entry of runner.calls) {
    const own = entry.prompt.match(/MARK(\d+)/g) || [];
    assert.equal(new Set(own).size, 1, 'No call contains another task.');
  }
  assert.equal(new Set(runner.calls.map(entry => entry.cwd)).size, 40);
  assert.deepEqual([...new Set(runner.calls.filter(entry => entry.prompt.includes('MARK7')).map(entry => `${entry.provider}/${entry.model}`))], ['claude/opus']);
  assert.deepEqual([...new Set(runner.calls.filter(entry => !entry.prompt.includes('MARK7')).map(entry => `${entry.provider}/${entry.model}`))], ['codex/gpt-5.5']);
  const { data } = await call(`/${record.id}/items/t7`);
  assert.deepEqual([data.item.versions.length, data.item.versions[0].settings.provider, data.item.versions[0].settings.detail, data.item.settings.from.provider, data.item.settings.from.detail], [1, 'claude', 'detailed', 'task', 'batch']);
  assert.match(data.item.versions[0].prompt, /MARK7/);
  assert.doesNotMatch(data.item.versions[0].prompt, /MARK(?!7\b)\d/);
  const files = await readdir(join(app.board.store.dir, 'compose-batches'), { recursive: true });
  assert.equal(files.filter(name => name.endsWith('.json') && name.includes('items')).length, 20, 'One file per task.');
});

test('a failing task leaves the others alone and retries alone; a rate limit stops the queue without spending more', async t => {
  let limit = false;
  const runner = engineer({ delay: 15, fail: text => (/MARK3\b/.test(text) ? Object.assign(new Error('boom: /secret/path'), { code: 'CLI_FAILED' }) : limit && /MARK6\b/.test(text) ? Object.assign(new Error('429'), { code: 'RATE_LIMITED' }) : null) });
  const { app, call } = await setup(t, runner);
  const { record } = await project(app, 10);
  await call('', { originId: record.id, expectedRevision: record.revision, itemIds: ['t1', 't2', 't3', 't4'] });
  await call(`/${record.id}/settings`, { concurrency: 2 });
  await call(`/${record.id}/run`, { all: true });
  let batch = await settle(call, record.id);
  assert.deepEqual(states(batch), { 'IMP-001': 'generated', 'IMP-002': 'generated', 'IMP-003': 'failed', 'IMP-004': 'generated' });
  const failed = batch.items.find(item => item.key === 'IMP-003');
  assert.equal(failed.error.code, 'CLI_FAILED');
  assert.doesNotMatch(JSON.stringify(batch), /secret\/path/, 'CLI output never reaches the page.');
  const before = runner.calls.length;
  assert.equal((await call(`/${record.id}/run`, { all: true })).data.queued, 1, 'Run all retries only pending and failed tasks.');
  await settle(call, record.id);
  assert.deepEqual(runner.calls.slice(before).map(entry => entry.prompt.match(/MARK\d+/)[0]), ['MARK3']);
  // Rate limit: the failing call stops every queued task of the batch.
  limit = true;
  const { data } = await call('', { originId: record.id, expectedRevision: record.revision, itemIds: ['t5', 't6', 't7', 't8', 't9', 't10'] });
  assert.equal(data.added, 6);
  await call(`/${record.id}/settings`, { concurrency: 1 });
  const mark = runner.calls.length;
  await call(`/${record.id}/run`, { itemIds: ['t5', 't6', 't7', 't8', 't9', 't10'] });
  batch = await settle(call, record.id);
  assert.equal(batch.notice.code, 'RATE_LIMITED');
  assert.deepEqual(['IMP-005', 'IMP-006', 'IMP-007', 'IMP-010'].map(key => states(batch)[key]), ['generated', 'failed', 'pending', 'pending']);
  assert.deepEqual(runner.calls.slice(mark).map(entry => entry.prompt.match(/MARK\d+/)[0]), ['MARK5', 'MARK5', 'MARK6'], 'Nothing ran after the limit.');
});

test('cancel stops running work; a late answer is ignored; a restart never re-runs interrupted tasks', async t => {
  const runner = engineer({ hold: text => /MARK1\b/.test(text), late: text => /MARK3\b/.test(text) });
  const { app, call } = await setup(t, runner);
  const { record } = await project(app, 3);
  await call('', { originId: record.id, expectedRevision: record.revision, itemIds: ['t1', 't2', 't3'] });
  await call(`/${record.id}/settings`, { concurrency: 1 });
  await call(`/${record.id}/run`, { all: true });
  await settle(call, record.id, batch => batch.items.find(item => item.key === 'IMP-001').state === 'running');
  assert.equal((await call(`/${record.id}/cancel`, { itemIds: ['t1'] })).data.cancelled, 1);
  let batch = await settle(call, record.id, view => view.items.find(item => item.key === 'IMP-003').state === 'running');
  await call(`/${record.id}/cancel`, { itemIds: ['t3'] });
  batch = await settle(call, record.id);
  await wait(400); // The cancelled call answers late; its prompt must not appear.
  batch = (await call(`/${record.id}`)).data.batch;
  assert.deepEqual(states(batch), { 'IMP-001': 'pending', 'IMP-002': 'generated', 'IMP-003': 'pending' });
  assert.equal((await call(`/${record.id}/items/t3`)).data.item.versions.length, 0);
  // Restart while one task runs and one waits: the running one is reported interrupted, the waiting one is pending, nothing runs again.
  const dataDir = app.board.store.dir;
  await call(`/${record.id}/run`, { itemIds: ['t1', 't2'] });
  await settle(call, record.id, view => view.items.find(item => item.key === 'IMP-001').state === 'running');
  const raw = JSON.parse(await readFile(join(dataDir, 'compose-batches', record.id, 'items', 't2.json'), 'utf8'));
  assert.equal(raw.run.state, 'queued', 'Queued work is saved, so a restart can see it.');
  const second = engineer();
  const { ComposeBatches } = await import('../src/compose-batch.mjs');
  const restarted = new ComposeBatches({ dataDir, origin: new OriginStore(dataDir), board: app.board, generate: async () => { throw new Error('must not run'); }, call: second });
  const view = await restarted.view(record.id);
  assert.deepEqual([states(view)['IMP-001'], view.items[0].error.code, states(view)['IMP-002']], ['failed', 'INTERRUPTED', 'generated']);
  assert.equal(second.calls.length, 0);
});

test('a damaged batch or task file is set aside when its backup loads, so the next save keeps the good backup', async t => {
  const { app, call } = await setup(t, engineer());
  const { record } = await project(app, 1);
  await call('', { originId: record.id, expectedRevision: record.revision, itemIds: ['t1'] });
  await call(`/${record.id}/items/t1`, { overrides: { quality: 'fast' } }, 'PATCH');
  await call(`/${record.id}/settings`, { concurrency: 2 });
  const dataDir = app.board.store.dir, folder = join(dataDir, 'compose-batches', record.id), files = [join(folder, 'batch.json'), join(folder, 'items', 't1.json')];
  for (const file of files) await writeFile(file, '{"damaged":');
  const { ComposeBatches } = await import('../src/compose-batch.mjs');
  const restarted = new ComposeBatches({ dataDir, origin: new OriginStore(dataDir), board: app.board, generate: async () => { throw new Error('must not run'); }, call: engineer() });
  assert.deepEqual((await restarted.view(record.id)).items.map(item => item.key), ['IMP-001'], 'The backups load.');
  for (const file of files) assert.equal((await readdir(join(file, '..'))).filter(name => name.startsWith(`${file.split('/').at(-1)}.corrupt-`)).length, 1, `${file} is kept aside`);
  await restarted.update(record.id, 't1', { overrides: { quality: 'reviewed' } }); await restarted.configure(record.id, { concurrency: 3 });
  for (const file of files) assert.ok(JSON.parse(await readFile(`${file}.bak`, 'utf8')).id, `${file}.bak is still a good copy`);
});

test('approval: exact version only, never past blocking findings, bulk only for clean tasks, and edits need approval again', async t => {
  const runner = engineer({ rewrite: (text, request) => (request.request.includes('MARK2') ? text.replace('`src/f2.js`', 'the file') : text) });
  const { app, call } = await setup(t, runner);
  const { store, record } = await project(app, 3);
  await call('', { originId: record.id, expectedRevision: record.revision, itemIds: ['t1', 't2', 't3'] });
  await call(`/${record.id}/items/t3`, { overrides: { quality: 'fast' } }, 'PATCH');
  await call(`/${record.id}/run`, { all: true });
  let batch = await settle(call, record.id);
  assert.deepEqual(states(batch), { 'IMP-001': 'generated', 'IMP-002': 'review', 'IMP-003': 'review' });
  // Bulk approval takes only tasks whose every check passed.
  let { data } = await call(`/${record.id}/approve`, { passing: true });
  assert.deepEqual([data.approved, states(data.batch)['IMP-001'], states(data.batch)['IMP-002'], states(data.batch)['IMP-003']], [1, 'approved', 'review', 'review']);
  let item = (await call(`/${record.id}/items/t2`)).data.item;
  assert.ok(item.findings.some(row => row.severity === 'blocking' && row.code === 'literal'));
  ({ data } = await call(`/${record.id}/approve`, { items: [{ itemId: 't2', versionId: item.current }] }));
  assert.deepEqual([data.approved, data.refused[0].reason], [0, 'Resolve the blocking findings first.']);
  // Fixing the literal by hand creates a new version; its own literal check passes and approval is possible after reading.
  const fixed = item.versions[0].prompt.replace('the file', '`src/f2.js`');
  ({ data } = await call(`/${record.id}/items/t2`, { prompt: fixed, baseVersionId: item.current }, 'PATCH'));
  assert.deepEqual([data.item.versions.length, data.item.versions[1].kind, data.item.findings.map(row => row.code)], [2, 'edited', ['edit-unreviewed']]);
  assert.equal((await call(`/${record.id}/items/t2`, { prompt: 'x', baseVersionId: item.current }, 'PATCH')).data.code, 'VERSION_CONFLICT');
  item = data.item;
  ({ data } = await call(`/${record.id}/approve`, { passing: true }));
  assert.equal(data.approved, 0, 'An unreviewed edit is never bulk-approved.');
  ({ data } = await call(`/${record.id}/approve`, { items: [{ itemId: 't2', versionId: item.current }] }));
  assert.equal(states(data.batch)['IMP-002'], 'approved');
  // A model check of the edit makes it clean again.
  await call(`/${record.id}/run`, { itemIds: ['t2'], kind: 'review' });
  batch = await settle(call, record.id);
  assert.equal(states(batch)['IMP-002'], 'generated', 'Checking again invalidates the old approval.');
  // Fast mode has no model review: approve individually only.
  item = (await call(`/${record.id}/items/t3`)).data.item;
  assert.deepEqual(item.findings.map(row => row.code), ['review-skipped']);
  // Changing the task in Origin blocks its approval; regenerating uses the new text.
  const fresh = await store.read(record.id);
  fresh.blueprint.items.find(entry => entry.id === 't1').description += ' Also log MARK1EXTRA.';
  await store.write(record.id, { expectedRevision: fresh.revision, blueprint: fresh.blueprint });
  batch = (await call(`/${record.id}`)).data.batch;
  assert.deepEqual([states(batch)['IMP-001'], batch.items[0].origin], ['review', 'changed']);
  await call(`/${record.id}/run`, { itemIds: ['t1'] });
  batch = await settle(call, record.id);
  item = (await call(`/${record.id}/items/t1`)).data.item;
  assert.deepEqual([states(batch)['IMP-001'], item.origin, item.versions.length], ['generated', 'current', 2]);
  assert.match(item.versions[1].prompt, /MARK1EXTRA/);
});

test('Kanban receives only approved prompts, prerequisites first, once, with lineage; split tasks become ordered cards', async t => {
  const runner = engineer();
  const { app, call } = await setup(t, runner);
  const { store, record } = await project(app, 4, { dependsOn: i => (i === 2 ? ['t1'] : i === 3 ? ['t2'] : i === 4 ? ['t3'] : []) });
  await call('', { originId: record.id, expectedRevision: record.revision, itemIds: ['t1', 't2', 't3', 't4'] });
  await call(`/${record.id}/run`, { all: true });
  await settle(call, record.id);
  // Only approved tasks go; a prerequisite that is neither approved nor on Kanban stops its dependants.
  let response = await call(`/${record.id}/export`, {});
  assert.deepEqual([response.status, response.data.code], [409, 'NOTHING_APPROVED']);
  let item = (await call(`/${record.id}/items/t2`)).data.item;
  await call(`/${record.id}/approve`, { items: [{ itemId: 't2', versionId: item.current }] });
  response = await call(`/${record.id}/export`, {});
  assert.deepEqual([response.status, response.data.code, response.data.missing.map(row => [row.key, row.waitsFor])], [409, 'PREREQUISITES_MISSING', [['IMP-002', 'IMP-001']]]);
  // Split IMP-003 into two parts, approve both, then send everything.
  await call(`/${record.id}/run`, { itemIds: ['t3'], kind: 'split' });
  await settle(call, record.id);
  item = (await call(`/${record.id}/items/t3`)).data.item;
  assert.deepEqual([item.split.state, item.split.children.map(child => child.title)], ['proposed', ['Build the first part', 'Build the second part']]);
  ({ data: { batch: response } } = await call(`/${record.id}/items/t3/split`, { accept: true }));
  assert.equal(states(response)['IMP-003'], 'review', 'Accepted split tasks still need approval.');
  for (const child of item.split.children) await call(`/${record.id}/approve`, { items: [{ itemId: 't3', childId: child.id }] });
  await call(`/${record.id}/approve`, { passing: true });
  response = await call(`/${record.id}/export`, {});
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.deepEqual(response.data.results.map(row => [row.key, row.status]), [['IMP-001', 'created'], ['IMP-002', 'created'], ['IMP-003.1', 'created'], ['IMP-003.2', 'created'], ['IMP-004', 'created']]);
  const cards = (await app.board.view()).projects[0].tasks, byKey = Object.fromEntries(cards.map(card => [card.originSource.key, card]));
  assert.deepEqual(byKey['IMP-002'].dependsOn, [byKey['IMP-001'].id]);
  assert.deepEqual(byKey['IMP-003.1'].dependsOn, [byKey['IMP-002'].id]);
  assert.deepEqual(byKey['IMP-003.2'].dependsOn, [byKey['IMP-003.1'].id]);
  assert.deepEqual(byKey['IMP-004'].dependsOn, [byKey['IMP-003.2'].id], 'Work after a split task waits for its last part.');
  const approved = (await call(`/${record.id}/items/t2`)).data.item;
  assert.ok(byKey['IMP-002'].prompt.startsWith(approved.versions.at(-1).prompt), 'The card carries the approved prompt…');
  assert.match(byKey['IMP-002'].prompt, /# Context from the Origin design[\s\S]*## Starts after\n- IMP-001/, '…and the Origin context.');
  const snapshot = JSON.parse(await readFile(join(app.board.store.dir, 'origin', 'snapshots', record.id, `${byKey['IMP-002'].originSource.snapshotId}.json`), 'utf8'));
  assert.deepEqual([snapshot.compose.versionId, snapshot.compose.promptHash, snapshot.body], [approved.current, approved.versions.at(-1).promptHash, byKey['IMP-002'].prompt]);
  assert.equal(cards.length, 5);
  assert.equal((await app.board.view()).runs.length, 0, 'No agent starts.');
  // Sending again adds nothing; Origin knows the cards, so its own Send to Kanban does not duplicate them either.
  response = await call(`/${record.id}/export`, {});
  assert.equal(response.data.code, 'NOTHING_APPROVED');
  const batch = (await call(`/${record.id}`)).data.batch;
  assert.deepEqual(new Set(batch.items.map(entry => entry.state)), new Set(['sent']));
  const saved = await store.read(record.id);
  const { token } = (await api(app, '/api/session')).data;
  const origin = await api(app, `/api/origin/projects/${record.id}/handoff`, { method: 'POST', token, body: { expectedRevision: saved.revision, itemIds: ['t1', 't2', 't3', 't4'] } });
  assert.deepEqual(origin.data.results.map(row => row.status), ['existing', 'existing', 'existing', 'existing']);
  assert.equal((await app.board.view()).projects[0].tasks.length, 5);
  assert.equal((await call(`/${record.id}/run`, { itemIds: ['t1'] })).data.skipped[0].reason, 'Already on Kanban.');
});

test('large batches: 120 tasks share eight workers without lost updates, duplicate runs or leaks', async t => {
  const runner = engineer({ delay: 60 });
  const { app, call } = await setup(t, runner);
  const { record } = await project(app, 120);
  const ids = record.blueprint.items.map(item => item.id);
  await call('', { originId: record.id, expectedRevision: record.revision, itemIds: ids });
  await call(`/${record.id}/settings`, { concurrency: 8 });
  await call(`/${record.id}/run`, { itemIds: [], defaults: { quality: 'fast' } });
  const [a, b] = await Promise.all([call(`/${record.id}/run`, { all: true }), call(`/${record.id}/run`, { all: true })]);
  assert.equal(a.data.queued + b.data.queued, 120, 'Two concurrent Run all clicks queue each task once.');
  const batch = await settle(call, record.id, undefined, 60000);
  assert.equal(batch.counts.review, 120, JSON.stringify(batch.counts));
  assert.equal(runner.calls.length, 120);
  assert.ok(runner.max <= 8 && runner.max >= 4, `max ${runner.max}`);
  for (const itemId of ['t1', 't60', 't120']) {
    const { item } = (await call(`/${record.id}/items/${itemId}`)).data;
    assert.deepEqual([item.versions.length, item.revision > 1, item.versions[0].prompt.includes(`MARK${itemId.slice(1)} `)], [1, true, true]);
  }
  const { data } = await call(`/${record.id}/approve`, { passing: true });
  assert.equal(data.approved, 0, 'Fast-mode prompts have no model review, so none is bulk-approved.');
  assert.equal(app.server.listening, true);
});

test('cycles are reported; sign-in waits for running batch work; unknown routes are refused', async t => {
  const runner = engineer({ hold: text => /MARK1\b/.test(text) });
  const { app, call, token } = await setup(t, runner, { authAdapter: { installed: async () => true, status: async () => ({ state: 'signed-in' }), login: async () => ({}) } });
  const { record } = await project(app, 2, { dependsOn: i => (i === 1 ? ['t2'] : ['t1']) });
  await call('', { originId: record.id, expectedRevision: record.revision, itemIds: ['t1', 't2'] });
  let batch = (await call(`/${record.id}`)).data.batch;
  assert.ok(batch.cycle && batch.cycle.length === 3, JSON.stringify(batch.cycle));
  await call(`/${record.id}/run`, { itemIds: ['t1'] });
  await settle(call, record.id, view => view.items.some(item => item.state === 'running'));
  const login = await api(app, '/api/auth/login', { method: 'POST', token, body: { provider: 'codex' } });
  assert.deepEqual([login.status, login.data.code], [409, 'RUNS_ACTIVE']);
  await call(`/${record.id}/cancel`, {});
  batch = await settle(call, record.id);
  assert.equal((await call(`/${record.id}/nope`, {})).status, 404);
  assert.equal((await api(app, `/api/compose/batches/${record.id}`, { method: 'GET', token: 'wrong' })).status, 403);
});

test('review fixes: secrets never reach a check, engineered and split cards are protected in Origin, part coverage stays a gate', async t => {
  let splitFails = false, draftFails = false;
  const runner = engineer({ fail: text => (draftFails && /MARK3\b/.test(text) ? Object.assign(new Error('x'), { code: 'CLI_FAILED' }) : null) });
  const wrapped = async call => { if (splitFails && call.prompt.startsWith('# Task split')) return { text: 'not json' }; return runner(call); };
  wrapped.calls = runner.calls;
  const { app, call, token } = await setup(t, wrapped, { authAdapter: { installed: async () => true, status: async () => ({ state: 'signed-in' }), login: async (provider, { signal }) => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })) } });
  const { store, record } = await project(app, 3, { dependsOn: i => (i === 3 ? ['t2'] : []) });
  await call('', { originId: record.id, expectedRevision: record.revision, itemIds: ['t1', 't2', 't3'] });
  await call(`/${record.id}/run`, { all: true });
  await settle(call, record.id);
  // A secret pasted into Origin: neither Regenerate nor Check again sends it.
  let saved = await store.read(record.id);
  saved.blueprint.items.find(entry => entry.id === 't1').description += ' Use api_key=abcdef0123456789.';
  await store.write(record.id, { expectedRevision: saved.revision, blueprint: saved.blueprint });
  const before = runner.calls.length;
  assert.match((await call(`/${record.id}/run`, { itemIds: ['t1'] })).data.skipped[0].reason, /secret/);
  assert.match((await call(`/${record.id}/run`, { itemIds: ['t1'], kind: 'review' })).data.skipped[0].reason, /changed|secret/);
  assert.equal(runner.calls.length, before);
  assert.ok(runner.calls.every(entry => !entry.prompt.includes('abcdef0123456789')));
  // A failed split keeps its prompt and is not part of Run all; approving settles a failed run.
  splitFails = true;
  await call(`/${record.id}/run`, { itemIds: ['t2'], kind: 'split' });
  let batch = await settle(call, record.id);
  assert.deepEqual([states(batch)['IMP-002'], batch.items[1].error.kind], ['generated', 'split']);
  assert.equal((await call(`/${record.id}/run`, { all: true })).data.queued, 0, 'Run all does not regenerate a task whose split failed.');
  splitFails = false;
  // Split IMP-002, accept, then remove an exact value from a part: the part cannot be approved.
  await call(`/${record.id}/run`, { itemIds: ['t2'], kind: 'split' });
  await settle(call, record.id);
  await call(`/${record.id}/items/t2/split`, { accept: true });
  let item = (await call(`/${record.id}/items/t2`)).data.item;
  await call(`/${record.id}/items/t2`, { child: { childId: '1', prompt: 'Part one without the path.' } }, 'PATCH');
  let response = await call(`/${record.id}/approve`, { items: [{ itemId: 't2', childId: '1' }] });
  assert.match(response.data.refused[0].reason, /in no part/);
  await call(`/${record.id}/items/t2`, { child: { childId: '1', prompt: item.split.children[0].prompt } }, 'PATCH');
  for (const childId of ['1', '2']) assert.equal((await call(`/${record.id}/approve`, { items: [{ itemId: 't2', childId }] })).data.approved, 1);
  // A failed regeneration keeps the earlier prompt; approving that prompt settles the failure.
  draftFails = true;
  await call(`/${record.id}/run`, { itemIds: ['t3'] });
  batch = await settle(call, record.id);
  assert.equal(states(batch)['IMP-003'], 'failed');
  draftFails = false;
  item = (await call(`/${record.id}/items/t3`)).data.item;
  assert.equal((await call(`/${record.id}/approve`, { passing: true })).data.approved, 0, 'Bulk approval skips a task whose last run failed.');
  response = await call(`/${record.id}/approve`, { items: [{ itemId: 't3', versionId: item.current }] });
  assert.equal(states(response.data.batch)['IMP-003'], 'approved');
  response = await call(`/${record.id}/export`, { itemIds: ['t2', 't3'] });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  // Origin protects the approved prompts: Update context asks first, and refuses on a split part.
  saved = await store.read(record.id);
  for (const entry of saved.blueprint.items) if (entry.id !== 't1') entry.acceptanceCriteria += '\nIt logs one line.';
  saved.blueprint.items.find(entry => entry.id === 't1').description = 'Implement feature 1 with marker MARK1 in `src/f1.js`.';
  saved = await store.write(record.id, { expectedRevision: saved.revision, blueprint: saved.blueprint });
  const status = await api(app, `/api/origin/projects/${record.id}/context-status`, { method: 'POST', token, body: { expectedRevision: saved.revision } });
  const byItem = Object.fromEntries(status.data.tasks.map(row => [row.itemId, row]));
  assert.deepEqual([byItem.t3.status, byItem.t3.edited, byItem.t3.engineered, byItem.t2.splitPart], ['changed', true, true, true]);
  const update = (itemId, extra = {}) => api(app, `/api/origin/projects/${record.id}/update-context`, { method: 'POST', token, body: { expectedRevision: saved.revision, itemId, expectedHash: byItem[itemId].hash, expectedCardRevision: byItem[itemId].cardRevision, ...extra } });
  assert.equal((await update('t3')).data.code, 'CARD_ENGINEERED');
  assert.equal((await update('t2', { replaceEdited: true })).data.code, 'SPLIT_PART');
  const sent = JSON.parse(await readFile(join(app.board.store.dir, 'origin', 'snapshots', record.id, `${saved.blueprint.items.find(entry => entry.id === 't3').handoff.snapshotId}.json`), 'utf8'));
  assert.equal(sent.instruction, item.versions.at(-1).prompt, 'Origin compares against what the card got.');
  // No batch run starts during a sign-in change.
  const login = api(app, '/api/auth/login', { method: 'POST', token, body: { provider: 'codex' } });
  await wait(100);
  assert.equal((await call(`/${record.id}/run`, { itemIds: ['t1'] })).data.code, 'AUTH_IN_PROGRESS');
  await api(app, '/api/auth/cancel', { method: 'POST', token, body: {} });
  await login;
});

test('the queue shows what each task asks and when its run started; Cancel all stops every running agent at once', async t => {
  const aborted = [];
  const runner = engineer({ hold: text => /MARK[2-4]\b/.test(text) });
  const watched = async call => { call.signal?.addEventListener('abort', () => aborted.push(Date.now()), { once: true }); return runner(call); };
  const { app, call } = await setup(t, watched);
  const { record } = await project(app, 4);
  await call('', { originId: record.id, expectedRevision: record.revision, itemIds: ['t1', 't2', 't3', 't4'] });
  await call(`/${record.id}/settings`, { concurrency: 1 });
  await call(`/${record.id}/run`, { itemIds: ['t1'] });
  let batch = await settle(call, record.id);
  assert.ok(batch.typicalMs > 0, 'a finished run gives the typical time');
  assert.match(batch.items[0].hint, /^Implement feature 1 with marker MARK1/);
  assert.equal(batch.items[0].startedAt, null, 'only running tasks carry a start time');
  assert.match(batch.items[0].current, /\S/, 'the current prompt version is named, so a new one is seen even when old versions are dropped');
  // In parallel: three agents at once, each with its own task.
  await call(`/${record.id}/settings`, { concurrency: 3 });
  const before = Date.now();
  await call(`/${record.id}/run`, { itemIds: ['t2', 't3', 't4'] });
  batch = await settle(call, record.id, view => view.items.filter(item => item.state === 'running').length === 3);
  assert.ok(batch.items.filter(item => item.state === 'running').every(item => item.startedAt >= before - 50));
  assert.equal(runner.max, 3);
  const stopped = Date.now();
  assert.equal((await call(`/${record.id}/cancel`, {})).data.cancelled, 3);
  assert.equal(aborted.length, 3, 'every running agent got its stop before Cancel answered');
  assert.ok(aborted.every(at => at - stopped < 200), `stops were immediate (${aborted.map(at => at - stopped).join(', ')} ms)`);
  batch = await settle(call, record.id);
  assert.deepEqual(states(batch), { 'IMP-001': 'generated', 'IMP-002': 'pending', 'IMP-003': 'pending', 'IMP-004': 'pending' });
});

test('a run naming a task that is not in the batch queues nothing, so no task waits without a worker', async t => {
  const runner = engineer();
  const { app, call } = await setup(t, runner);
  const { record } = await project(app, 3);
  await call('', { originId: record.id, expectedRevision: record.revision, itemIds: ['t1', 't2', 't3'], defaults: { provider: 'codex' } });
  const refused = await call(`/${record.id}/run`, { itemIds: ['t2', 'nope'] });
  assert.equal(refused.status, 404);
  assert.deepEqual(states((await call(`/${record.id}`)).data.batch), { 'IMP-001': 'pending', 'IMP-002': 'pending', 'IMP-003': 'pending' });
  assert.equal(runner.calls.length, 0);
  await call(`/${record.id}/run`, { itemIds: ['t2'] });
  const batch = await settle(call, record.id);
  assert.notEqual(states(batch)['IMP-002'], 'pending', 'the task runs when asked again');
});

test('tasks whose cancel cannot be saved are still freed and shown, so none stays queued or running without a worker', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const runner = engineer({ hold: text => /MARK1\b/.test(text) });
  const { app, call } = await setup(t, runner);
  const { record } = await project(app, 2);
  await call('', { originId: record.id, expectedRevision: record.revision, itemIds: ['t1', 't2'] });
  await call(`/${record.id}/settings`, { concurrency: 1 });
  await call(`/${record.id}/run`, { all: true });
  const seen = await settle(call, record.id, view => states(view)['IMP-001'] === 'running' && states(view)['IMP-002'] === 'queued');
  const items = join(app.board.store.dir, 'compose-batches', record.id, 'items');
  await chmod(items, 0o555); // The disk refuses every save.
  try {
    assert.equal((await call(`/${record.id}/cancel`, {})).data.cancelled, 2);
    await settle(call, record.id, view => Object.values(states(view)).every(state => state === 'pending'));
    // A page that polls with the revision it last saw learns that the tasks were freed.
    const poll = await call(`/${record.id}?since=${seen.revision}&origin=${seen.originRevision}&instance=${seen.instance}`);
    assert.notEqual(poll.data.unchanged, true);
  } finally { await chmod(items, 0o755); }
  assert.equal((await call(`/${record.id}/run`, { itemIds: ['t2'] })).data.queued, 1, 'the task can run again');
  assert.notEqual(states(await settle(call, record.id))['IMP-002'], 'pending');
});

test('a batch whose batch.json is damaged is still listed from its backup, as it still loads', async t => {
  const { app, call } = await setup(t, engineer());
  const { record } = await project(app, 1);
  await call('', { originId: record.id, expectedRevision: record.revision, itemIds: ['t1'] });
  await call(`/${record.id}/settings`, { concurrency: 2 }); // A second save keeps a backup of the first.
  await writeFile(join(app.board.store.dir, 'compose-batches', record.id, 'batch.json'), '{"id":');
  assert.deepEqual((await call('')).data.batches.map(entry => entry.id), [record.id]);
  assert.equal((await call(`/${record.id}`)).data.batch.items.length, 1);
});
