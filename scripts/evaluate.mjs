#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { cases, CORPUS_VERSION } from '../evals/cases.mjs';
import { validateRequest } from '../src/engine.mjs';
import { generate } from '../src/server.mjs';
import { VERSION } from '../src/version.mjs';

export const help = `Live prompt evaluation · Promptboard ${VERSION}

This command makes model calls only when you explicitly select a provider.
Your CLI sign-in, model access, usage limits, and charges apply.

  npm run eval:live -- --provider codex --split dev
  npm run eval:live -- --provider claude --model MODEL_ID --effort high --split holdout

Options:
  --provider codex|claude|gemini|agy  Required to make model calls
  --model ID                        Default: the CLI default
  --effort LEVEL                    Default: the CLI default
  --split dev|holdout               Default: dev
  --quality reviewed|fast           Default: reviewed
  --help                            Print help without model calls

Cases run sequentially. Reviewed mode can use up to four calls per case.
The JSON report is written to stdout. Redirect it to a file if needed.
Human review is required. Check counts are not an overall quality score.
Exit codes: 0 completed, 1 configuration or generation errors, 130 interrupted.
See evals/README.md for the rubric and limitations.
`;

export function parseEvaluationArgs(args) {
  if (!args.length || args.includes('--help')) return { help: true };
  const result = { model: '', effort: '', split: 'dev', quality: 'reviewed' };
  const accepted = new Set(['provider', 'model', 'effort', 'split', 'quality']);
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const key = args[index].replace(/^--/, '');
    if (!args[index].startsWith('--') || !accepted.has(key)) throw new Error('Unknown evaluation option. Use --help.');
    if (seen.has(key)) throw new Error(`Use --${key} only once.`);
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Set a value for --${key}.`);
    result[key] = args[++index];
    seen.add(key);
  }
  if (!result.provider) throw new Error('Select --provider explicitly to allow model calls. Use --help.');
  if (!['dev', 'holdout'].includes(result.split)) throw new Error('Choose --split dev or holdout.');
  validateRequest({ input: 'Validate evaluation settings.', provider: result.provider, model: result.model,
    effort: result.effort, quality: result.quality });
  return result;
}

/** Only request fields reach the model. Reference candidates and rubrics stay local. */
export async function runEvaluation(options, { generateFn = generate, signal } = {}) {
  const selected = cases.filter(item => item.split === options.split);
  const results = [];
  let interrupted = false;
  for (const item of selected) {
    if (signal?.aborted) { interrupted = true; break; }
    const request = { input: item.input, language: item.language, task: item.task, detail: item.detail,
      provider: options.provider, model: options.model, effort: options.effort, quality: options.quality };
    const started = performance.now();
    try {
      const result = await generateFn(request, { signal });
      results.push({ id: item.id, language: item.language, task: item.task, detail: item.detail,
        status: 'complete', prompt: result.prompt, verification: result.verification, lint: result.lint,
        reportedModels: result.reportedModels, durationMs: result.durationMs,
        humanChecks: item.expected.humanChecks });
    } catch {
      const aborted = signal?.aborted === true;
      results.push({ id: item.id, status: aborted ? 'cancelled' : 'error',
        durationMs: Math.round(performance.now() - started),
        error: aborted ? 'Evaluation interrupted.' : 'Generation failed. Check CLI sign-in, access, settings, and quota.' });
      if (aborted) { interrupted = true; break; }
    }
  }
  const completed = results.filter(item => item.status === 'complete');
  return { schemaVersion: 1, engineVersion: VERSION, corpusVersion: CORPUS_VERSION,
    generatedAt: new Date().toISOString(), selection: { ...options }, interrupted,
    interpretation: 'These are app check outcomes, not measured semantic accuracy or STE certification. Apply the human rubric to each prompt.',
    counts: { selected: selected.length, completed: completed.length,
      errors: results.filter(item => item.status === 'error').length,
      cancelled: results.filter(item => item.status === 'cancelled').length,
      automaticPass: completed.filter(item => item.verification?.automatic?.status === 'pass').length,
      automaticIssues: completed.filter(item => item.verification?.automatic?.status === 'issues').length,
      modelReviewPass: completed.filter(item => item.verification?.review?.status === 'pass').length,
      modelReviewIssues: completed.filter(item => item.verification?.review?.status === 'issues').length,
      modelReviewUnavailable: completed.filter(item => item.verification?.review?.status === 'unavailable').length,
      modelReviewSkipped: completed.filter(item => item.verification?.review?.status === 'skipped').length,
      needsReview: completed.filter(item => item.verification?.status === 'needs-review').length,
      modelCalls: completed.reduce((sum, item) => sum + (item.verification?.calls || 0), 0) }, results };
}

async function main() {
  const options = parseEvaluationArgs(process.argv.slice(2));
  if (options.help) return process.stdout.write(help);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const report = await runEvaluation(options, { signal: controller.signal });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exitCode = report.interrupted ? 130 : report.counts.errors ? 1 : 0;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
