import { performance } from 'node:perf_hooks';
import { buildPrompt, lintPrompt, validateRequest } from '../src/engine.mjs';
import { verifyPrompt } from '../src/verification.mjs';

const source = 'Update `src/api.ts`. Keep the API. Do not add a dependency.\n';
const input = source.repeat(Math.floor(24000 / source.length));
const request = validateRequest({ input });
const times = [];
for (let i = 0; i < 120; i++) {
  const start = performance.now();
  buildPrompt(request);
  verifyPrompt(input, input);
  lintPrompt(input);
  if (i >= 20) times.push(performance.now() - start);
}
times.sort((a, b) => a - b);
console.log(JSON.stringify({ description: 'Local prompt construction, literal checks, and prose lint only. No CLI/model calls.',
  platform: process.platform, node: process.version, sourceCharacters: input.length, iterations: times.length,
  medianMs: +times[Math.floor(times.length / 2)].toFixed(2), p95Ms: +times[Math.floor(times.length * 0.95)].toFixed(2),
  limitation: 'Synthetic repeated input on this machine; not an end-to-end or model quality benchmark.' }, null, 2));
