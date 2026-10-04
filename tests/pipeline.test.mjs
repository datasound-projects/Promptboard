import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPrompt } from '../src/verification.mjs';
import { COMPOSE_PROMPT_CHARS } from '../src/compose-limits.mjs';
import { access } from 'node:fs/promises';
import { buildPrompt, lintPrompt, validateRequest } from '../src/engine.mjs';
import { runPipeline, parseReview, sourceUnits, REVIEW_CRITERIA, buildRepairPrompt, buildReviewPrompt, repairReasons } from '../src/pipeline.mjs';

const request = validateRequest({ input: 'Keep `src/api.ts`.\nDo not add a dependency.' });
const good = 'Keep `src/api.ts`. Do not add a dependency.';
function reviewFor(req, draft, overrides = {}) {
  return JSON.stringify({ covered: sourceUnits(req.input).map(unit => unit.id), requirements: [],
    criteria: Object.fromEntries(REVIEW_CRITERIA.map(criterion => [criterion, 'pass'])), issues: [], ...overrides });
}
// A review that marks the last unit as missing: a confirmed, specific defect.
const missingLast = req => { const ids = sourceUnits(req.input).map(unit => unit.id); return { covered: ids.slice(0, -1), requirements: [{ id: ids.at(-1), status: 'missing', promptQuote: '', note: 'The exclusion is missing.' }] }; };
function sequence(texts, folders = []) {
  let calls = 0;
  return async ({ cwd, model, effort }) => {
    await access(cwd); folders.push(cwd);
    assert.equal(model, request.model); assert.equal(effort, request.effort);
    const text = texts[calls++];
    if (text instanceof Error) throw text;
    assert.notEqual(text, undefined, 'No unexpected model calls');
    return { text, reportedModels: ['fixture-model'] };
  };
}

test('reviewed default needs two calls and an evidence-linked complete review', async () => {
  const folders = [];
  const result = await runPipeline(request, { runner: sequence([good, reviewFor(request, good)], folders) });
  assert.equal(result.verification.status, 'checks-passed');
  assert.equal(result.verification.calls, 2);
  assert.equal(result.verification.review.requirements.length, 2);
  assert.equal(result.verification.reviewRequired, true);
  assert.match(result.verification.promptHash, /^[a-f0-9]{64}$/);
  assert.equal(new Set(folders).size, 2);
  for (const folder of folders) await assert.rejects(access(folder));
});

test('one repair runs new checks and a fresh review, with four calls at most', async () => {
  const bad = 'Keep `src/wrong.ts`. Do not add a dependency.';
  const result = await runPipeline(request, { runner: sequence([bad, reviewFor(request, bad), good, reviewFor(request, good)]) });
  assert.equal(result.prompt, good);
  assert.equal(result.verification.repaired, true);
  assert.equal(result.verification.status, 'checks-passed');
  assert.equal(result.verification.calls, 4);
});

test('persistent literal loss stays a flagged draft even when both model reviews pass', async () => {
  const bad = 'Change a file. Do not add a dependency.';
  const result = await runPipeline(request, { runner: sequence([bad, reviewFor(request, bad), bad, reviewFor(request, bad)]) });
  assert.equal(result.verification.status, 'needs-review');
  assert.ok(result.verification.automatic.issues.length);
  assert.equal(result.verification.calls, 4);
  assert.deepEqual(result.verification.repairReasons, ['automatic:1']);
});

test('malformed review never passes or causes an unbounded retry', async () => {
  const result = await runPipeline(request, { runner: sequence([good, '{"pass":true}']) });
  assert.equal(result.verification.status, 'needs-review');
  assert.equal(result.verification.review.status, 'unavailable');
  assert.equal(result.verification.calls, 2);
});

test('failed repair retains original evidence and is reported', async () => {
  const bad = 'Change the file.';
  const result = await runPipeline(request, { runner: sequence([bad, reviewFor(request, bad), new Error('private diagnostics')]) });
  assert.equal(result.prompt, bad);
  assert.equal(result.verification.repairFailed, true);
  assert.equal(result.verification.status, 'needs-review');
  assert.doesNotMatch(JSON.stringify(result), /private diagnostics/);
});

test('invalid repaired review cannot reuse a passing review of the previous draft', async () => {
  const bad = 'Change the file.';
  const result = await runPipeline(request, { runner: sequence([bad, reviewFor(request, bad), good, 'not JSON']) });
  assert.equal(result.verification.review.status, 'unavailable');
  assert.equal(result.verification.status, 'needs-review');
});

test('fast mode makes one call and explicitly skips semantic review', async () => {
  const result = await runPipeline({ ...request, quality: 'fast' }, { runner: sequence([good]) });
  assert.equal(result.verification.calls, 1);
  assert.equal(result.verification.review.status, 'skipped');
  assert.equal(result.verification.reviewRequired, true);
});

test('review parser rejects missing, duplicate, and unknown units, invented evidence, and invalid criteria', () => {
  const valid = JSON.parse(reviewFor(request, good));
  const row = { id: 'S2', status: 'missing', promptQuote: '', note: 'Missing.' };
  const cases = [
    { ...valid, covered: [] },
    { ...valid, covered: ['S1'] },
    { ...valid, covered: ['S1', 'S1'] },
    { ...valid, covered: ['S1', 'S9'] },
    { ...valid, covered: ['S1', 'S2'], requirements: [row] },
    { ...valid, covered: ['S1'], requirements: [{ ...row, status: 'covered' }] },
    { ...valid, covered: ['S1'], requirements: [{ ...row, status: 'maybe' }] },
    { ...valid, covered: ['S1'], requirements: [{ ...row, note: '' }] },
    { ...valid, covered: ['S1'], requirements: [{ ...row, status: 'changed', promptQuote: '' }] },
    { ...valid, covered: ['S1'], requirements: [{ ...row, promptQuote: 'This never appeared.' }] },
    { ...valid, criteria: {} }, { ...valid, criteria: { ...valid.criteria, meaning: 'ok' } }, { ...valid, criteria: { ...valid.criteria, extra: 'pass' } },
    { ...valid, criteria: { ...valid.criteria, meaning: 'issues' } },
    { ...valid, extra: 'ignore' },
    { ...valid, issues: [{ category: 'meaning', message: 'Issue', sourceQuote: 'invented source', promptQuote: '' }] },
  ];
  for (const value of cases) assert.throws(() => parseReview(JSON.stringify(value), request, good), JSON.stringify(value));
  assert.throws(() => parseReview('{"covered":', request, good));
  assert.throws(() => parseReview('x'.repeat(64_001), request, good));
  const parsed = parseReview('```json\n' + JSON.stringify(valid) + '\n```', request, good);
  assert.equal(parsed.status, 'pass');
  assert.deepEqual(parsed.requirements.map(r => [r.id, r.status, r.sourceQuote]), [['S1', 'covered', 'Keep `src/api.ts`.'], ['S2', 'covered', 'Do not add a dependency.']]);
  assert.equal(parsed.criteria.length, REVIEW_CRITERIA.length);
});

test('a clean compact review is much smaller than one evidence row per unit', () => {
  const req = validateRequest({ input: Array.from({ length: 60 }, (_, i) => `Keep \`src/m${i}.ts\` unchanged.`).join('\n') });
  const compact = reviewFor(req, good);
  const verbose = JSON.stringify({ requirements: sourceUnits(req.input).map(unit => ({ id: unit.id, status: 'covered', promptQuote: unit.text, note: 'The draft keeps this requirement.' })),
    criteria: REVIEW_CRITERIA.map(criterion => ({ criterion, status: 'pass', note: 'No material issue.' })), issues: [] });
  assert.ok(compact.length * 4 < verbose.length, `${compact.length} vs ${verbose.length}`);
  assert.equal(parseReview(compact, req, good).status, 'pass');
});

test('reviewer uncertainty is reported but never repaired automatically', async () => {
  const criteria = Object.fromEntries(REVIEW_CRITERIA.map(criterion => [criterion, criterion === 'meaning' ? 'uncertain' : 'pass']));
  const ids = sourceUnits(request.input).map(unit => unit.id);
  for (const review of [reviewFor(request, good, { criteria }),
    reviewFor(request, good, { covered: ids.slice(1), requirements: [{ id: ids[0], status: 'uncertain', promptQuote: '', note: 'Cannot tell.' }] })]) {
    assert.equal(parseReview(review, request, good).status, 'uncertain');
    const result = await runPipeline(request, { runner: sequence([good, review]) });
    assert.equal(result.verification.status, 'needs-review');
    assert.equal(result.verification.calls, 2);
    assert.equal(result.verification.repaired, false);
    assert.deepEqual(result.verification.repairReasons, []);
  }
});

test('advisory prose warnings alone do not start a repair', async () => {
  const wordy = good + '\nThe agent must keep the documented public interface and the existing module layout for all consumers in the repository right now.';
  assert.ok(lintPrompt(wordy).warnings.length);
  const result = await runPipeline(request, { runner: sequence([wordy, reviewFor(request, wordy)]) });
  assert.equal(result.verification.calls, 2);
  assert.equal(result.verification.repaired, false);
  assert.equal(result.verification.status, 'needs-review');
  assert.ok(result.lint.warnings.length);
});

test('a confirmed missing requirement repairs once and records the reason', async () => {
  const result = await runPipeline(request, { runner: sequence([good, reviewFor(request, good, missingLast(request)), good, reviewFor(request, good)]) });
  assert.equal(result.verification.calls, 4);
  assert.equal(result.verification.repaired, true);
  assert.deepEqual(result.verification.repairReasons, ['requirements:1']);
  assert.equal(result.verification.status, 'checks-passed');
  assert.deepEqual(result.verification.stages.map(s => s.stage), ['draft', 'review', 'repair', 'repair-review']);
  for (const stage of result.verification.stages) assert.ok(stage.inputBytes > 0 && stage.outputBytes > 0);
});

test('repair policy: blocking findings repair, advisory findings do not', () => {
  const pass = { status: 'pass', issues: [] }, review = { status: 'pass', requirements: [], criteria: [], issues: [] };
  assert.deepEqual(repairReasons(pass, review), []);
  assert.deepEqual(repairReasons({ status: 'issues', issues: [{}] }, review), ['automatic:1']);
  assert.deepEqual(repairReasons(pass, { ...review, status: 'issues', requirements: [{ status: 'changed' }] }), ['requirements:1']);
  assert.deepEqual(repairReasons(pass, { ...review, status: 'issues', issues: [{ category: 'no-invention' }] }), ['review-issues:1']);
  assert.deepEqual(repairReasons(pass, { ...review, status: 'uncertain', requirements: [{ status: 'uncertain' }] }), []);
});

test('provider stop codes and cancellation prevent every later model call', async () => {
  for (const code of ['QUOTA_EXHAUSTED', 'AUTH_REQUIRED', 'MODEL_UNAVAILABLE', 'RATE_LIMITED']) {
    const bad = 'Change the file.';
    const result = await runPipeline(request, { runner: sequence([bad, Object.assign(new Error('x'), { code })]) });
    assert.equal(result.verification.calls, 2, code);
    assert.equal(result.verification.repaired, false);
    assert.equal(result.verification.review.errorCode, code);
  }
  let calls = 0;
  await assert.rejects(runPipeline(request, { runner: async () => { calls++; throw Object.assign(new Error('x'), { code: 'QUOTA_EXHAUSTED' }); } }));
  assert.equal(calls, 1);
});


test('all source lines are represented with bounded units', () => {
  const source = Array.from({ length: 400 }, (_, i) => `Requirement ${i}`).join('\n');
  const units = sourceUnits(source);
  assert.ok(units.length <= 128);
  assert.equal(units.map(unit => unit.text).join('\n'), source);
});

test('source units split sentences and keep fenced code whole', () => {
  const units = sourceUnits('Use port 4318. Do not add a dependency. Keep `a.ts`.\n- Add tests. Keep the API.\n```js\nconst a = 1. B = 2;\n\nx();\n```\n1. Run `npm test`.');
  assert.deepEqual(units.map(unit => unit.text), ['Use port 4318.', 'Do not add a dependency.', 'Keep `a.ts`.', '- Add tests.', 'Keep the API.', '```js\nconst a = 1. B = 2;\n\nx();\n```', '1. Run `npm test`.']);
  const big = sourceUnits('Keep `x`. Add y. '.repeat(6000));
  assert.ok(big.length <= 128);
});

test('cancellation during review stops later stages and cleans every work folder', async () => {
  const controller = new AbortController();
  const folders = [];
  let calls = 0;
  await assert.rejects(runPipeline(request, { signal: controller.signal, runner: async ({ cwd, signal }) => {
    folders.push(cwd); calls++;
    if (calls === 1) return { text: good };
    controller.abort(); signal.throwIfAborted();
  } }), { name: 'AbortError' });
  assert.equal(calls, 2);
  for (const folder of folders) await assert.rejects(access(folder));
});

test('total deadline aborts a pending provider call', async () => {
  await assert.rejects(runPipeline(request, { timeoutMs: 25, runner: ({ signal }) => new Promise((resolve, reject) => {
    const keepAlive = setTimeout(() => resolve({ text: good }), 1000);
    signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(signal.reason); }, { once: true });
  }) }), { name: 'TimeoutError' });
});

test('an oversized initial draft is rejected before model review', async () => {
  let calls = 0;
  await assert.rejects(runPipeline(request, { runner: async () => { calls++; return { text: 'a'.repeat(COMPOSE_PROMPT_CHARS + 1) }; } }), /too large/);
  assert.equal(calls, 1);
});


test('repair feedback stays within transport limits for thousands of missing literals', () => {
  const input = Array.from({ length: 1800 }, (_, i) => '`field' + i + '`').join(' ');
  const req = validateRequest({ input });
  const draft = 'Use the fields.';
  const review = { status: 'unavailable', requirements: [], criteria: [], issues: [] };
  const prompt = buildRepairPrompt(buildPrompt(req), draft, verifyPrompt(input, draft), review);
  assert.ok(Buffer.byteLength(prompt) < 2 * 1024 * 1024);
  assert.match(prompt, /"automatic":\[/);
  assert.doesNotMatch(prompt, /"writing"/);
  assert.match(prompt, /recheck the entire original source/);
});

test('review input does not duplicate the entire source', () => {
  const req = validateRequest({ input: '界'.repeat(100000) });
  assert.ok(Buffer.byteLength(buildReviewPrompt(req, '界'.repeat(32000))) < 2 * 1024 * 1024);
});
