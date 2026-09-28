import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPrompt } from '../src/verification.mjs';
import { access } from 'node:fs/promises';
import { buildPrompt, lintPrompt, validateRequest } from '../src/engine.mjs';
import { runPipeline, parseReview, sourceUnits, REVIEW_CRITERIA, buildRepairPrompt, buildReviewPrompt } from '../src/pipeline.mjs';

const request = validateRequest({ input: 'Keep `src/api.ts`.\nDo not add a dependency.' });
const good = 'Keep `src/api.ts`. Do not add a dependency.';
function reviewFor(req, draft, overrides = {}) {
  return JSON.stringify({ requirements: sourceUnits(req.input).map(unit => ({ id: unit.id, status: 'covered', promptQuote: draft, note: '' })),
    criteria: REVIEW_CRITERIA.map(criterion => ({ criterion, status: 'pass', note: '' })), issues: [], ...overrides });
}
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

test('review parser rejects missing units, invented quotes, duplicates and omitted criteria', () => {
  const valid = JSON.parse(reviewFor(request, good));
  const cases = [
    { ...valid, requirements: [] },
    { ...valid, requirements: [valid.requirements[0], valid.requirements[0]] },
    { ...valid, requirements: valid.requirements.map(row => ({ ...row, promptQuote: 'This never appeared.' })) },
    { ...valid, requirements: valid.requirements.map(row => ({ ...row, promptQuote: '' })) },
    { ...valid, criteria: [] }, { ...valid, extra: 'ignore' },
    { ...valid, issues: [{ category: 'meaning', message: 'Issue', sourceQuote: 'invented source', promptQuote: '' }] },
  ];
  for (const value of cases) assert.throws(() => parseReview(JSON.stringify(value), request, good));
  assert.equal(parseReview('```json\n' + JSON.stringify(valid) + '\n```', request, good).status, 'pass');
});

test('uncertainty and criteria-only defects trigger repair, not a pass', async () => {
  const criteria = REVIEW_CRITERIA.map(criterion => ({ criterion, status: criterion === 'meaning' ? 'uncertain' : 'pass', note: 'Check this.' }));
  const review = reviewFor(request, good, { criteria });
  assert.equal(parseReview(review, request, good).status, 'issues');
  const result = await runPipeline(request, { runner: sequence([good, review, good, review]) });
  assert.equal(result.verification.status, 'needs-review');
  assert.equal(result.verification.calls, 4);
});

test('all source lines are represented with bounded units', () => {
  const source = Array.from({ length: 400 }, (_, i) => `Requirement ${i}`).join('\n');
  const units = sourceUnits(source);
  assert.ok(units.length <= 64);
  assert.equal(units.map(unit => unit.text).join('\n'), source);
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
  await assert.rejects(runPipeline(request, { runner: async () => { calls++; return { text: 'a'.repeat(32001) }; } }), /too large/);
  assert.equal(calls, 1);
});


test('repair feedback stays within transport limits for thousands of missing literals', () => {
  const input = Array.from({ length: 1800 }, (_, i) => '`field' + i + '`').join(' ');
  const req = validateRequest({ input });
  const draft = 'Use the fields.';
  const review = { status: 'unavailable', requirements: [], criteria: [], issues: [] };
  const prompt = buildRepairPrompt(buildPrompt(req), draft, verifyPrompt(input, draft), lintPrompt(draft), review);
  assert.ok(Buffer.byteLength(prompt) < 256 * 1024);
  assert.match(prompt, /automaticCount/);
  assert.match(prompt, /recheck the entire original source/);
});

test('review input does not duplicate the entire source', () => {
  const req = validateRequest({ input: '界'.repeat(24000) });
  assert.ok(Buffer.byteLength(buildReviewPrompt(req, '界'.repeat(32000))) < 256 * 1024);
});
