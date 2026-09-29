#!/usr/bin/env node
/**
 * Composer pipeline benchmark with a deterministic fake provider. No CLI or model calls.
 * Provider latency is simulated from a fixed cost model (process start, input read,
 * output generation), so the result shows pipeline structure: calls, sizes, repairs.
 */
import { pathToFileURL } from 'node:url';
import { runPipeline } from '../src/pipeline.mjs';
import { validateRequest } from '../src/engine.mjs';

// Simulated provider cost. Output tokens dominate model latency; ~4 bytes per token.
const COST = { startMs: 2500, inputMsPerKB: 15, outputMsPerToken: 20 };
const simulate = (inBytes, outBytes) => Math.round(COST.startMs + inBytes / 1024 * COST.inputMsPerKB + outBytes / 4 * COST.outputMsPerToken);

function reviewData(prompt) {
  const at = prompt.lastIndexOf('# Review data\n');
  return JSON.parse(prompt.slice(at + '# Review data\n'.length));
}

// Answer a review prompt in the format that prompt requests.
function answerReview(prompt, { uncertain = false } = {}) {
  const { units, draft } = reviewData(prompt);
  const criteria = ['meaning', 'constraints', 'no-invention', 'conflicts', 'language', 'scope', 'clarity'];
  const compact = prompt.includes('"covered":');
  if (compact) {
    const covered = units.map(u => u.id), requirements = [];
    if (uncertain) requirements.push({ id: covered.pop(), status: 'uncertain', promptQuote: '', note: 'Cannot tell whether the order is kept.' });
    return JSON.stringify({ covered, requirements, criteria: Object.fromEntries(criteria.map(c => [c, 'pass'])), issues: [] });
  }
  // Earlier format: one evidence row per unit, one criteria row per criterion.
  const quote = draft.slice(0, 80);
  return JSON.stringify({
    requirements: units.map((u, i) => ({ id: u.id, status: uncertain && i === units.length - 1 ? 'uncertain' : 'covered', promptQuote: uncertain && i === units.length - 1 ? '' : quote, note: 'The draft keeps this requirement.' })),
    criteria: criteria.map(criterion => ({ criterion, status: 'pass', note: 'No material issue.' })), issues: [] });
}

const clean = 'Update `src/api.ts`. Keep the public API. Do not add a dependency.';
const cases = [
  { name: 'fast', quality: 'fast', input: clean, drafts: [clean] },
  { name: 'reviewed-clean', input: clean, drafts: [clean] },
  { name: 'reviewed-advisory-lint', input: clean, drafts: [clean + '\nThe agent must keep the documented public interface and the existing module layout for all consumers in the repository right now.'] },
  { name: 'reviewed-uncertain', input: clean, drafts: [clean], uncertain: true },
  { name: 'reviewed-confirmed-defect', input: clean, drafts: ['Update the API file. Keep the public API. Do not add a dependency.', clean] },
  { name: 'reviewed-long-input', input: Array.from({ length: 300 }, (_, i) => `Keep \`src/m${i}.ts\` unchanged. Do not add a dependency for module ${i}.`).join('\n') },
  { name: 'reviewed-short-input', input: 'Fix `a.js`.', drafts: ['Fix `a.js`.'] },
];

export async function benchmark() {
  const rows = [];
  for (const item of cases) {
    const request = validateRequest({ input: item.input, quality: item.quality || 'reviewed' });
    const drafts = [...(item.drafts || [item.input])];
    const calls = [];
    const runner = async ({ prompt }) => {
      const isReview = prompt.includes('# Review data\n');
      const text = isReview ? answerReview(prompt, { uncertain: item.uncertain && !calls.some(c => c.review) }) : (drafts.length > 1 ? drafts.shift() : drafts[0]);
      const inBytes = Buffer.byteLength(prompt), outBytes = Buffer.byteLength(text);
      calls.push({ review: isReview, inBytes, outBytes, simulatedMs: simulate(inBytes, outBytes) });
      return { text, reportedModels: [] };
    };
    const result = await runPipeline(request, { runner });
    const v = result.verification;
    rows.push({ case: item.name, calls: v.calls, stages: v.stages.map(s => s.stage).join('>'), repaired: v.repaired,
      inputBytes: calls.reduce((n, c) => n + c.inBytes, 0), outputBytes: calls.reduce((n, c) => n + c.outBytes, 0),
      reviewOutputBytes: calls.filter(c => c.review).reduce((n, c) => n + c.outBytes, 0),
      simulatedModelMs: calls.reduce((n, c) => n + c.simulatedMs, 0), localChecksMs: v.timings.checksMs, status: v.status });
  }
  return { description: 'Composer pipeline with a fake provider. Latency is simulated, not measured model time.', costModel: COST, rows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await benchmark(), null, 2));
