// Insights from hand-built boards: rework, time in columns, cost per merged card, and the cards that fail review most.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cardCost, computeInsights, roundsOf, staysOf } from '../src/insights.mjs';
import { defaultPipelineConfig } from '../src/pipeline-config.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const H = 3600000, D = 24 * H, NOW = Date.UTC(2026, 9, 21, 12);
const move = (at, from, to, by = 'user') => ({ at, from, to, by });
const history = (at, stage, status, extra = {}) => ({ columnId: stage, stage, runId: 'r', provider: 'claude', status, at, ...extra });
const run = (id, taskId, stage, provider, startedAt, usage, extra = {}) => ({ id, taskId, projectId: 'p', stage, stageKind: stage, status: 'succeeded', createdAt: startedAt, startedAt, updatedAt: startedAt + H,
  config: { provider, model: extra.model || '' }, ...(usage ? { usage } : {}), ...(extra.session ? { providerSessionId: extra.session } : {}) });
const card = (id, number, title, column, createdAt, extra = {}) => ({ id, number, title, prompt: 'Do it.', column, createdAt, updatedAt: createdAt, labelIds: [], transitions: [], ...extra });

/** A column pipeline with six cards, plus older ones for the range filter. */
function pipelineState() {
  const a0 = NOW - 5 * D, b0 = NOW - 3 * D, c0 = NOW - 4 * D;
  const tasks = [
    // A: from an Origin blueprint; the review sent it back once, then the tests failed once; a moved target is no round.
    card('a', 1, 'Login form', 'done', a0, { originSource: { originProjectId: 'o1', originTaskId: 't1' },
      transitions: [move(a0 + H, 'todo', 'executing'), move(a0 + 3 * H, 'executing', 'code_review'), move(a0 + 4 * H, 'code_review', 'executing', 'automation'), move(a0 + 6 * H, 'executing', 'code_review'),
        move(a0 + 7 * H, 'code_review', 'testing'), move(a0 + 8 * H, 'testing', 'merge'), move(a0 + 9 * H, 'merge', 'done', 'merged')],
      stageHistory: [history(a0 + 3 * H, 'executing', 'succeeded'), history(a0 + 4 * H, 'code_review', 'changes_required', { reason: '2 findings to fix.' }), history(a0 + 6 * H, 'executing', 'succeeded'),
        history(a0 + 7.5 * H, 'testing', 'changes_required', { code: 'TESTS_FAILED', reason: 'Tests failed: npm test exited 1' }), history(a0 + 8.5 * H, 'merge', 'changes_required', { code: 'TARGET_MOVED' })],
      completion: { kind: 'merged', at: a0 + 9 * H } }),
    // B: from a saved prompt, merged through a pull request with no rework.
    card('b', 2, 'Search', 'done', b0, { source: { projectId: 'p', promptId: 'pr1', promptRevision: 1 }, transitions: [move(b0 + H, 'todo', 'executing'), move(b0 + 2 * H, 'executing', 'done', 'pull_request')],
      stageHistory: [history(b0 + 2 * H, 'executing', 'succeeded')], completion: { kind: 'pull_request', at: b0 + 2 * H } }),
    // C: its Origin project was removed; one review round.
    card('c', 3, 'Profile page', 'done', c0, { originSource: { originProjectId: 'o-gone', originTaskId: 't2' }, transitions: [move(c0 + H, 'todo', 'executing'), move(c0 + 5 * H, 'executing', 'done', 'merged')],
      stageHistory: [history(c0 + 3 * H, 'code_review', 'changes_required', { reason: 'Missing input validation.' })], completion: { kind: 'merged', at: c0 + 5 * H } }),
    // E: still in Code Review, with a review round two hours ago.
    card('e', 5, 'Checkout', 'code_review', NOW - 10 * H, { transitions: [move(NOW - 9 * H, 'todo', 'executing'), move(NOW - 2 * H, 'executing', 'code_review')],
      stageHistory: [history(NOW - 5 * H, 'code_review', 'changes_required', { reason: 'Handle an empty cart.' })] }),
    // F: done without merging and without any run.
    card('f', 6, 'Docs', 'done', NOW - 2 * D, { transitions: [move(NOW - D, 'todo', 'done', 'unmerged')], completion: { kind: 'unmerged', at: NOW - D } }),
    // Older finished cards: 60 days (inside 90) and 200 days (only in All).
    card('d', 4, 'Old merge', 'done', NOW - 61 * D, { completion: { kind: 'merged', at: NOW - 60 * D } }),
    card('o', 7, 'Ancient', 'done', NOW - 201 * D, { completion: { kind: 'unmerged', at: NOW - 200 * D } }),
  ];
  const runs = [
    run('r1', 'a', 'executing', 'claude', a0 + H, { model: 'claude-opus', inputTokens: 1000, outputTokens: 200, cachedTokens: 5000, costUSD: 0.5 }, { session: 's1' }),
    run('r2', 'a', 'code_review', 'codex', a0 + 3 * H, { model: 'gpt-5', inputTokens: 300, outputTokens: 50, cachedTokens: 100 }, { session: 'c1' }),
    // The same Claude conversation resumed: its usage is cumulative, so it replaces r1's numbers instead of adding to them.
    run('r3', 'a', 'executing', 'claude', a0 + 4.5 * H, { model: 'claude-opus', inputTokens: 1500, outputTokens: 300, cachedTokens: 8000, costUSD: 0.8 }, { session: 's1' }),
    run('r4', 'b', 'executing', 'codex', b0 + H, { model: 'gpt-5', inputTokens: 4000, outputTokens: 400, cachedTokens: 1000 }, { session: 'c2' }),
    run('r5', 'c', 'executing', 'claude', c0 + H, { model: 'claude-sonnet', inputTokens: 100, outputTokens: 20, cachedTokens: 0, costUSD: 0.3 }, { session: 's2', model: 'sonnet' }),
    run('r6', 'e', 'executing', 'claude', NOW - 9 * H, { model: 'claude-opus', inputTokens: 10, outputTokens: 1 }, { session: 's3' }),
    run('r7', 'd', 'executing', 'claude', NOW - 61 * D, { model: 'claude-opus', inputTokens: 50, outputTokens: 5, costUSD: 0.1 }, { session: 's4' }),
    run('other', 'x', 'executing', 'claude', NOW - D, { inputTokens: 999999, outputTokens: 1 }),
  ];
  runs.at(-1).projectId = 'elsewhere';
  return { projects: [{ id: 'p', name: 'Shop', workflowMode: 'pipeline', pipeline: defaultPipelineConfig(), tasks }], runs };
}
const lookups = { originLookup: new Map([['o1', 'SaaS web app']]), promptLookup: new Map([['pr1', 'Search prompt']]) };
const byLabel = rows => Object.fromEntries(rows.map(({ label, ...row }) => [label, row]));

test('a pipeline board: finished and merged cards, median time to merge, tokens and the reported price', () => {
  const { summary, runsCapped } = computeInsights(pipelineState(), 'p', { days: 30, now: NOW, ...lookups });
  assert.equal(runsCapped, false);
  // A merged 8 h after its first run, B 1 h, C 4 h: the median is 4 h.
  assert.deepEqual(summary, { finished: 4, merged: 3, tokens: 1800 + 350 + 4400 + 120, cachedTokens: 8100 + 1000, priceUSD: 0.3, pricedCards: 1, medianToMergeMs: 4 * H });
});

test('rework rate by agent, model and template counts finished cards, and each round goes to the agent whose work was sent back', () => {
  const { rework } = computeInsights(pipelineState(), 'p', { days: 30, now: NOW, ...lookups });
  // The Codex review of card A checked work; it did not produce any, so Codex is not charged for A's rounds.
  assert.deepEqual(byLabel(rework.agents), { 'Claude Code': { cards: 2, reworked: 2, rounds: 3 }, 'Codex CLI': { cards: 1, reworked: 0, rounds: 0 } });
  assert.deepEqual(byLabel(rework.models), { 'Claude Code · claude-opus': { cards: 1, reworked: 1, rounds: 2 }, 'Claude Code · claude-sonnet': { cards: 1, reworked: 1, rounds: 1 }, 'Codex CLI · gpt-5': { cards: 1, reworked: 0, rounds: 0 } });
  assert.deepEqual(byLabel(rework.templates), { 'SaaS web app': { cards: 1, reworked: 1, rounds: 2 }, 'Saved prompt: Search prompt': { cards: 1, reworked: 0, rounds: 0 },
    'Removed Origin project': { cards: 1, reworked: 1, rounds: 1 }, 'No template': { cards: 1, reworked: 0, rounds: 0 } });
});

test('time in each column: one row per column in board order, with the stay still going on counted up to now and marked', () => {
  const { columns } = computeInsights(pipelineState(), 'p', { days: 30, now: NOW, ...lookups });
  assert.deepEqual(columns.map(row => row.title), ['To Do', 'Planning', 'Executing', 'Code Review', 'Testing', 'Merge'], 'Done is where cards end, so it has no row.');
  const review = columns.find(row => row.id === 'code_review');
  // A: 1 h and 1 h; E: in Code Review for the last 2 h and still there.
  assert.deepEqual([review.stays, review.totalMs, review.medianMs, review.open], [3, 4 * H, H, 1]);
  assert.deepEqual(staysOf(pipelineState().projects[0].tasks.find(task => task.id === 'e'), NOW).at(-1), { column: 'code_review', ms: 2 * H, end: NOW, open: true });
  assert.equal(columns.find(row => row.id === 'planning').stays, 0);
});

test('cost per merged card: a resumed conversation counts once, at its highest numbers, and dollars only where Claude Code reported them', () => {
  const { cost } = computeInsights(pipelineState(), 'p', { days: 30, now: NOW, ...lookups });
  assert.deepEqual(cost.cards.map(row => [row.title, row.tokens, row.cachedTokens, row.usd, row.priceNote]), [
    ['Search', 4400, 1000, null, 'Codex does not report a price.'],
    ['Login form', 1800 + 350, 8100, null, 'Codex does not report a price.'],
    ['Profile page', 120, 0, 0.3, ''],
  ]);
  assert.equal(cost.medianTokens, 2150);
});

test('a Claude Code price is summed per conversation; Codex, Gemini and a Claude run without a report leave it unknown, with the reason', () => {
  const claude = (id, session, usd) => run(id, 't', 'executing', 'claude', 1, { inputTokens: 10, outputTokens: 1, ...(usd === undefined ? {} : { costUSD: usd }) }, { session });
  assert.deepEqual(cardCost([claude('1', 'a', 0.2), claude('2', 'a', 0.5), claude('3', 'b', 0.25)]), { tokens: 22, cachedTokens: 0, usd: 0.75, priceNote: '' });
  assert.deepEqual(cardCost([claude('1', 'a', 0.2), claude('2', 'b')]).priceNote, 'Claude Code reported no price for this conversation.');
  const gemini = run('g', 't', 'executing', 'gemini', 1, null);
  assert.deepEqual(cardCost([claude('1', 'a', 0.2), gemini]), { tokens: 11, cachedTokens: 0, usd: null, priceNote: 'Gemini CLI reports no tokens or price.' });
  assert.deepEqual(cardCost([]), { tokens: 0, cachedTokens: 0, usd: null, priceNote: 'No agent usage was recorded.' });
  // A run that never started spent nothing.
  assert.deepEqual(cardCost([{ ...gemini, startedAt: null }, claude('1', 'a', 0.2)]).usd, 0.2);
  // A run that worked but left no usage record: its tokens are missing, so the price is unknown, with the reason.
  const silent = { ...run('s', 't', 'executing', 'claude', 1, null), turns: 2, lifecycle: 'events-received' };
  assert.deepEqual(cardCost([claude('1', 'a', 0.2), silent]), { tokens: 11, cachedTokens: 0, usd: null, priceNote: 'Claude Code left no usage record for one of its runs, so tokens and price are incomplete.' });
  assert.equal(cardCost([claude('1', 'a', 0.2), { ...silent, turns: 0 }]).usd, null, 'Signs of its session are enough, even before a finished turn.');
  // One that never showed a sign of its session (a startup question, a failed start) spent nothing.
  assert.equal(cardCost([claude('1', 'a', 0.2), { ...silent, turns: 0, lifecycle: 'no-events-yet' }]).usd, 0.2);
});

test('stage history rounds: review findings and failed tests, a tester that changed or committed files, and tests failing again at Merge; a moved target or a resolved conflict is no round', () => {
  const task = { stageHistory: [history(1, 'code_review', 'changes_required'), history(2, 'testing', 'changes_required', { code: 'TESTER_CHANGED_FILES' }),
    history(3, 'testing', 'changes_required', { code: 'TESTER_COMMITTED' }), history(4, 'merge', 'changes_required', { code: 'VERIFICATION_FAILED' }),
    history(5, 'merge', 'changes_required', { code: 'TARGET_MOVED' }), history(6, 'merge', 'changes_required'), history(7, 'testing', 'failed', { code: 'TEST_COMMAND_NOT_FOUND' })] };
  const rounds = new Map(roundsOf({ workflowMode: 'pipeline' }, task).map(round => [round.at, round.kind]));
  assert.equal(rounds.get(2), 'tests', 'TESTER_CHANGED_FILES');
  assert.equal(rounds.get(3), 'tests', 'TESTER_COMMITTED');
  assert.equal(rounds.get(4), 'tests', 'merge-stage VERIFICATION_FAILED');
  assert.deepEqual([...rounds], [[1, 'review'], [2, 'tests'], [3, 'tests'], [4, 'tests']]);
});

test('the cards that fail review most: rounds in the range, finished or not, with the latest reason and a template grouping', () => {
  const { failing } = computeInsights(pipelineState(), 'p', { days: 30, now: NOW, ...lookups });
  assert.deepEqual(failing.cards.map(row => [row.number, row.review, row.tests, row.total, row.reason, row.template]), [
    [1, 1, 1, 2, 'Tests failed: npm test exited 1', 'SaaS web app'],
    [5, 1, 0, 1, 'Handle an empty cart.', 'No template'],
    [3, 1, 0, 1, 'Missing input validation.', 'Removed Origin project'],
  ]);
  assert.deepEqual(failing.templates.map(row => [row.label, row.rounds, row.cards]), [['SaaS web app', 2, 1], ['No template', 1, 1], ['Removed Origin project', 1, 1]]);
  // When every one of them has the same template, a grouping says nothing and is left out.
  const state = pipelineState();
  state.projects[0].tasks.find(task => task.id === 'e').originSource = { originProjectId: 'o1', originTaskId: 't3' };
  const one = computeInsights(state, 'p', { days: 30, now: NOW, originLookup: new Map([['o1', 'Same'], ['o-gone', 'Same']]), promptLookup: new Map() });
  assert.deepEqual([one.failing.cards.length, one.failing.templates], [3, []]);
});

test('the range: 30 days, 90 days or all, by when a card was completed', () => {
  const state = pipelineState(), at = days => computeInsights(state, 'p', { days, now: NOW, ...lookups }).summary;
  assert.deepEqual([at(30).finished, at(90).finished, at(null).finished], [4, 5, 6]);
  assert.deepEqual([at(30).merged, at(90).merged, at(null).merged], [3, 4, 4]);
  assert.equal(at(90).priceUSD, 0.4);
  const old = computeInsights(state, 'p', { days: null, now: NOW, ...lookups });
  assert.equal(old.days, null);
  assert.equal(old.rework.templates.find(row => row.label === 'No template').cards, 3);
});

test('a legacy board counts moves from Code Review or Testing back to Executing, never a run that could not start', () => {
  const t0 = NOW - 3 * D;
  const task = card('l1', 1, 'Parser', 'done', t0, { transitions: [move(t0 + H, 'todo', 'executing'), move(t0 + 2 * H, 'executing', 'code_review'), move(t0 + 2.5 * H, 'code_review', 'executing'),
    move(t0 + 3 * H, 'executing', 'code_review'), move(t0 + 3.1 * H, 'code_review', 'executing', 'system'), move(t0 + 4 * H, 'executing', 'testing'), move(t0 + 5 * H, 'testing', 'executing'),
    move(t0 + 6 * H, 'executing', 'merge'), move(t0 + 7 * H, 'merge', 'done', 'merged')], completion: { kind: 'merged', at: t0 + 7 * H } });
  const project = { id: 'p', name: 'Tools', tasks: [task], columnLayout: [] };
  assert.deepEqual(roundsOf(project, task).map(round => round.kind), ['review', 'tests']);
  const state = { projects: [project], runs: [run('g1', 'l1', 'executing', 'gemini', t0 + H, null), run('g2', 'l1', 'executing', 'gemini', t0 + 5 * H, null)] };
  const insights = computeInsights(state, 'p', { days: 30, now: NOW });
  assert.deepEqual(byLabel(insights.rework.agents), { 'Gemini CLI': { cards: 1, reworked: 1, rounds: 2 } });
  assert.deepEqual(insights.columns.map(row => row.id), ['todo', 'planning', 'executing', 'code_review', 'testing', 'merge']);
  assert.equal(insights.columns.find(row => row.id === 'executing').stays, 4);
  assert.deepEqual([insights.cost.cards[0].tokens, insights.cost.cards[0].usd, insights.cost.cards[0].priceNote], [0, null, 'Gemini CLI reports no tokens or price.']);
  assert.equal(insights.summary.medianToMergeMs, 6 * H);
});

test('a full move log has lost its oldest moves, so its first stay is left out instead of guessed', () => {
  const moves = Array.from({ length: 100 }, (_, index) => move(1000 + index, index % 2 ? 'executing' : 'todo', index % 2 ? 'todo' : 'executing'));
  const stays = staysOf(card('x', 1, 'Busy', 'todo', 0, { transitions: moves }), 5000);
  assert.equal(stays[0].ms, 1, 'The first stay starts at the first known move, not at creation.');
  assert.equal(stays.length, 100);
});

test('an empty project gives empty sections, and a missing project is refused', () => {
  const empty = computeInsights({ projects: [{ id: 'p', name: 'New', tasks: [] }], runs: [] }, 'p', { now: NOW });
  assert.deepEqual([empty.summary.finished, empty.summary.medianToMergeMs, empty.summary.priceUSD, empty.cost.cards.length, empty.failing.cards.length, empty.days], [0, null, null, 0, 0, 30]);
  assert.throws(() => computeInsights({ projects: [], runs: [] }, 'p'), { code: 'NOT_FOUND' });
});

test('GET /api/projects/:id/insights reads template names through Origin and saved prompts, and checks the range and the token', async t => {
  const app = await startTestServer(t, { port: 0, executor: null });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = (path, method = 'GET', body) => fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async response => ({ status: response.status, json: await response.json() }));
  const origin = (await call('/api/origin/projects', 'POST', { name: 'Churn model', start: { template: 'mlops' } })).json.project;
  const gone = (await call('/api/origin/projects', 'POST', { name: 'Gone' })).json.project;
  await call(`/api/origin/projects/${gone.id}/delete`, 'POST', { expectedRevision: gone.revision });
  const project = await app.board.createProject({ name: 'Board', workflowMode: 'pipeline' });
  const saved = (await call(`/api/shared-projects/${project.id}/prompts`, 'POST', { title: 'Add search', prompt: 'Add a search box.' })).json.prompt;
  const fromPrompt = (await call(`/api/shared-projects/${project.id}/prompts/${saved.id}/cards`, 'POST', { expectedRevision: saved.revision })).json.task;
  const fromOrigin = await app.board.createTask({ projectId: project.id, title: 'Train', prompt: 'Train it.' });
  const fromGone = await app.board.createTask({ projectId: project.id, title: 'Lost', prompt: 'Lost.' });
  const now = Date.now(), originOf = new Map([[fromOrigin.id, origin.id], [fromGone.id, gone.id]]);
  await app.board.store.update(state => {
    for (const task of state.projects.find(item => item.id === project.id).tasks) {
      Object.assign(task, { column: 'done', completion: { kind: 'merged', at: now - H }, archivedAt: now - H });
      if (originOf.has(task.id)) task.originSource = { originProjectId: originOf.get(task.id), originTaskId: 'item' };
    }
    state.runs.push({ ...run('r1', fromOrigin.id, 'executing', 'claude', now - 2 * H, { inputTokens: 5, outputTokens: 5, costUSD: 0.01 }, { session: 's' }), projectId: project.id });
  });
  const { status, json } = await call(`/api/projects/${project.id}/insights?days=30`);
  assert.equal(status, 200, JSON.stringify(json));
  assert.deepEqual(json.insights.rework.templates.map(row => row.label).sort(), ['Machine Learning / MLOps Platform', 'Removed Origin project', 'Saved prompt: Add search']);
  assert.deepEqual([json.insights.summary.finished, json.insights.summary.merged, json.insights.summary.priceUSD], [3, 3, 0.01]);
  assert.ok(fromPrompt.id);
  assert.equal((await call(`/api/projects/${project.id}/insights`)).json.insights.days, 30, 'Last 30 days by default.');
  assert.equal((await call(`/api/projects/${project.id}/insights?days=all`)).json.insights.days, null);
  assert.deepEqual([(await call(`/api/projects/${project.id}/insights?days=7`)).status, (await call(`/api/projects/${project.id}/insights?days=7`)).json.code], [400, 'INVALID_INPUT']);
  assert.equal((await call('/api/projects/missing/insights')).status, 404);
  assert.equal((await fetch(`${app.url}/api/projects/${project.id}/insights`)).status, 403, 'The session token is required.');
  assert.equal((await fetch(`${app.url}/insights.js`)).status, 200);
});
