import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cases } from '../evals/cases.mjs';
import { verifyPrompt } from '../src/verification.mjs';
import { validateRequest } from '../src/engine.mjs';
import { parseEvaluationArgs, runEvaluation } from '../scripts/evaluate.mjs';

test('the corpus spans all supported tasks, languages, detail levels, and both splits', () => {
  assert.equal(new Set(cases.map(item => item.id)).size, cases.length);
  assert.deepEqual(new Set(cases.map(item => item.task)), new Set(['build', 'debug', 'refactor', 'review', 'architecture', 'agent-workflow', 'research']));
  assert.deepEqual(new Set(cases.map(item => item.language)), new Set(['en', 'de', 'pl']));
  assert.deepEqual(new Set(cases.map(item => item.detail)), new Set(['super-short', 'concise', 'detailed', 'extremely-detailed']));
  assert.deepEqual(new Set(cases.map(item => item.split)), new Set(['dev', 'holdout']));
  for (const item of cases) {
    validateRequest({ input: item.input, language: item.language, task: item.task, detail: item.detail });
    assert.ok(item.expected.humanChecks.length);
    assert.ok(item.expected.badFailure);
  }
});

test('authored reference candidates expose both literal detection and semantic blind spots', () => {
  for (const item of cases) {
    const good = verifyPrompt(item.input, item.goodCandidate, item.language);
    const bad = verifyPrompt(item.input, item.badCandidate, item.language);
    assert.equal(good.status, item.expected.goodMechanical, `${item.id}: good candidate`);
    assert.equal(bad.status, item.expected.badMechanical, `${item.id}: bad candidate`);
    assert.equal(good.reviewRequired, true);
    assert.equal(bad.reviewRequired, true);
  }
  assert.ok(cases.some(item => item.expected.badMechanical === 'pass'));
  assert.ok(cases.some(item => item.expected.badMechanical === 'issues'));
});

test('live evaluation requires explicit valid settings; help never requires a provider', () => {
  assert.deepEqual(parseEvaluationArgs([]), { help: true });
  assert.deepEqual(parseEvaluationArgs(['--help']), { help: true });
  assert.throws(() => parseEvaluationArgs(['--split', 'dev']), /Select --provider/);
  assert.throws(() => parseEvaluationArgs(['--provider', 'shell']), /provider/);
  assert.throws(() => parseEvaluationArgs(['--provider', 'codex', '--split', 'all']), /split/);
  assert.throws(() => parseEvaluationArgs(['--provider', 'codex', '--quality', 'perfect']), /quality/);
  assert.throws(() => parseEvaluationArgs(['--provider', 'codex', '--unknown', 'x']), /Unknown/);
  assert.throws(() => parseEvaluationArgs(['--provider', 'codex', '--provider', 'claude']), /only once/);
  assert.equal(parseEvaluationArgs(['--provider', 'codex']).quality, 'reviewed');
  const execution = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/evaluate.mjs', import.meta.url))], { encoding: 'utf8' });
  assert.equal(execution.status, 0);
  assert.match(execution.stdout, /Required to make model calls/);
  assert.equal(execution.stderr, '');
});

test('the harness runs only selected cases sequentially without sending reference answers', async () => {
  let active = 0, peak = 0;
  const seen = [];
  const options = parseEvaluationArgs(['--provider', 'codex', '--split', 'holdout', '--quality', 'fast']);
  const report = await runEvaluation(options, { generateFn: async request => {
    active++; peak = Math.max(peak, active);
    seen.push(request);
    await Promise.resolve();
    active--;
    return { prompt: 'Test draft.', verification: { status: 'needs-review', automatic: { status: 'pass' }, review: { status: 'skipped' }, calls: 1 },
      lint: { warnings: [] }, reportedModels: ['test-model'], durationMs: 1 };
  } });
  assert.equal(peak, 1);
  assert.equal(seen.length, cases.filter(item => item.split === 'holdout').length);
  assert.ok(seen.every(request => request.quality === 'fast'));
  assert.ok(seen.every(request => !('expected' in request) && !('goodCandidate' in request) && !('badCandidate' in request)));
  assert.equal(report.counts.modelCalls, seen.length);
  assert.equal(report.counts.modelReviewSkipped, seen.length);
  assert.equal(report.counts.needsReview, seen.length);
  assert.ok(!('accuracy' in report) && !('score' in report));
});

test('the harness sanitizes provider errors and stops after cancellation', async () => {
  const options = parseEvaluationArgs(['--provider', 'codex', '--split', 'holdout']);
  const errors = await runEvaluation(options, { generateFn: async () => { throw new Error('PRIVATE_CLI_DIAGNOSTIC'); } });
  assert.equal(errors.counts.errors, cases.filter(item => item.split === 'holdout').length);
  assert.doesNotMatch(JSON.stringify(errors), /PRIVATE_CLI_DIAGNOSTIC/);
  const controller = new AbortController();
  let calls = 0;
  const aborted = await runEvaluation(options, { signal: controller.signal, generateFn: async () => {
    calls++; controller.abort(); throw new Error('private');
  } });
  assert.equal(calls, 1);
  assert.equal(aborted.interrupted, true);
  assert.equal(aborted.counts.cancelled, 1);
});
