import test from 'node:test';
import assert from 'node:assert/strict';
import { ComposeContext } from '../src/compose-context.mjs';
import { validateResearchPlan, validateResearchReview, researchGrounding, buildResearchPrompt } from '../src/compose-research.mjs';
import { validateRequest, buildPrompt } from '../src/engine.mjs';
import { validateLocal } from '../src/compose-local.mjs';
import { ProviderError } from '../src/providers.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { budgetEvidence } from '../src/compose-retrieval.mjs';
import { runPipeline, REVIEW_CRITERIA } from '../src/pipeline.mjs';
import { researchPlan, researchReview, questText } from './helpers/compose-fixtures.mjs';

const question = (id, query, sourceHint = 'all', kind = 'fact') => ({ id, question: `Determine ${query}`, reason: 'Material to the requested result.', sourceHint, libraryHint: '', query, kind });
const planFor = (input, questions, overrides = {}) => ({ ...researchPlan(input, overrides), questions, unverified: [] });
const reviewer = plan => async call => ({ text: JSON.stringify(call.prompt.startsWith('# Compose context preparation') ? plan : researchReview(call.prompt)) });

test('explicitly disabled grounding ignores retained document, local, expert and MCP selections with zero preparation work', async t => {
  const context = new ComposeContext({ mcp: { retrieve: () => assert.fail('Disabled MCP') }, local: { retrieve: () => assert.fail('Disabled local read'), close() {} } }); t.after(() => context.close());
  const result = await context.prepare({ request: { input: 'Write a clear announcement.' }, autonomous: false, sources: [
    { type: 'mcp', preset: 'context7' }, { type: 'document', id: 'expired' }, { type: 'expert', name: 'Guide', text: 'Announcements use short sentences.' },
    { type: 'local', kind: 'repository', name: 'Reference', path: process.cwd() },
  ] }, { runner: () => assert.fail('Disabled planning') });
  assert.equal(result.calls, 0); assert.deepEqual(result.grounding, {}); assert.deepEqual(result.sources, []);
});

test('simple rewriting uses selected style guidance without any external research or a question quota', async t => {
  const context = new ComposeContext({ mcp: { retrieve: () => assert.fail('No external research for this task') } }); t.after(() => context.close());
  const input = 'Rewrite the announcement using the selected style guide.';
  const plan = planFor(input, [question('r4', 'direct voice short sentences', 's1')], { complexity: 'simple', research: 'none', entities: ['announcement'] });
  const result = await context.prepare({ request: { input }, sources: [{ type: 'expert', name: 'Style guide', text: 'Use direct voice and short sentences. Avoid inflated language.' }, { type: 'mcp', preset: 'context7' }] }, { runner: reviewer(plan) });
  assert.equal(result.assessment.research, 'none'); assert.ok(result.evidence.some(row => row.source === 'Style guide')); assert.ok(result.research.lookups <= 2); assert.equal(result.calls, 2);
  const empty = planFor('Write a friendly announcement.', [], { complexity: 'simple', research: 'none' });
  const minimal = await context.prepare({ request: { input: empty.assessment.goal }, sources: [] }, { runner: reviewer(empty) });
  assert.equal(minimal.calls, 1); assert.equal(minimal.research.questions, 0);
});

test('translated targeted queries can use supplied documents without exact task-token overlap', async t => {
  const context = new ComposeContext(); t.after(() => context.close());
  const doc = await context.documents.add(Buffer.from('Use direct voice and short sentences. Avoid inflated language.'), { name: 'guide.md' });
  const input = 'Przeredaguj wiadomość zgodnie z wybranym poradnikiem.';
  const plan = planFor(input, [question('r7', 'direct voice short sentences', 'document')], { complexity: 'simple', research: 'light', entities: ['wiadomość'] });
  const result = await context.prepare({ request: { input, language: 'pl' }, sources: [{ type: 'document', id: doc.id }] }, { runner: reviewer(plan) });
  assert.ok(result.evidence.some(row => row.locator && row.source === 'guide.md')); assert.deepEqual(result.evidence[0].questionIds, ['r7']);
});

test('bounded semantic previews are reviewed, never blindly inserted after an empty or failed review', async t => {
  const context = new ComposeContext(); t.after(() => context.close());
  const doc = await context.documents.add(Buffer.from('Prefer active voice. Address readers directly. Use plain language.'), { name: 'notes.md' });
  const input = 'Improve the tone of my announcement.';
  const plan = planFor(input, [question('r3', 'concise audience-friendly wording', 's1')], { complexity: 'simple', research: 'none' });
  let previews;
  const result = await context.prepare({ request: { input }, sources: [{ type: 'document', id: doc.id }] }, { runner: async call => {
    if (call.prompt.startsWith('# Compose context preparation')) { previews = JSON.parse(call.prompt.split('# Preparation data\n')[1]).sources; return { text: JSON.stringify(plan) }; }
    const data = JSON.parse(call.prompt.split('# Research data\n')[1]); assert.match(data.evidence[0].text, /active voice/);
    return { text: JSON.stringify(researchReview(call.prompt, { findings: [] })) };
  } });
  assert.ok(previews[0].preview.length <= 1200); assert.deepEqual(result.evidence, []); assert.ok(result.grounding.unresolvedQuestions.length);
});

test('retrieval association alone and malformed synthesis never resolve research questions', () => {
  const plan = planFor('Set up ingestion.', [question('r4', 'retry delivery semantics')]);
  const evidence = [{ sourceType: 'mcp', source: 'Docs', locator: '/docs', text: 'The client sends rows.', query: 'retry delivery', questionIds: ['r4'] }];
  for (const review of [null, { findings: [], unverified: [], assumptions: [], answers: [] }]) {
    assert.match(researchGrounding(plan, evidence, review).unresolvedQuestions.join(' '), /retry delivery semantics/);
  }
});

test('supported resolutions require known stable question IDs and matching quoted findings; choices remain unresolved', () => {
  const plan = planFor('Ingest market data.', [question('r7', 'timestamp API'), question('r2', 'desired financial instruments', 'all', 'choice')]);
  const evidence = [{ sourceType: 'mcp', source: 'Docs', locator: '/api', text: 'Specify the designated timestamp.', query: 'timestamp API', questionIds: ['r7', 'r2'] }];
  const review = { findings: [{ evidenceId: 'e1', statement: 'Specify the designated timestamp.', quote: evidence[0].text }], questions: [], assumptions: [], unverified: [], continueResearch: false, reason: 'One fact supported; instruments are user-owned.',
    answers: [{ questionId: 'r7', status: 'supported', evidenceIds: ['e1'], note: 'The timestamp is explicitly designated.' }, { questionId: 'r2', status: 'choice', evidenceIds: [], note: 'Do not invent the desired instruments.' }] };
  const accepted = validateResearchReview(JSON.stringify(review), evidence, { questions: plan.questions });
  const grounding = researchGrounding(plan, evidence, accepted);
  assert.equal(grounding.unresolvedQuestions.some(q => q.includes('timestamp API')), false); assert.match(grounding.unresolvedQuestions.join(' '), /instruments/);
  for (const mutate of [r => r.answers[0].questionId = 'r1', r => r.answers[0].evidenceIds = ['e8'], r => r.answers[0].evidenceIds = [], r => r.findings = [], r => r.answers.push(r.answers[0]), r => { r.answers[1].status = 'supported'; r.answers[1].evidenceIds = ['e1']; }]) {
    const bad = structuredClone(review); mutate(bad); assert.throws(() => validateResearchReview(JSON.stringify(bad), evidence, { questions: plan.questions }));
  }
});

test('findings dropped by the final context budget cannot resolve questions', () => {
  const qs = Array.from({ length: 16 }, (_, i) => question(`r${i + 1}`, `material decision ${i + 1}`));
  const plan = planFor('Explain the requested workflow.', qs, { research: 'deep', complexity: 'complex' });
  const evidence = qs.map((q, i) => ({ sourceType: 'document', source: 'Guide', locator: `section ${i + 1}`, query: q.query, text: `Fact ${i + 1}: ` + 'x'.repeat(1100), questionIds: [q.id] }));
  const review = validateResearchReview(JSON.stringify({ findings: evidence.map((e, i) => ({ evidenceId: `e${i + 1}`, statement: `Relevant fact ${i + 1}.`, quote: e.text })),
    answers: qs.map((q, i) => ({ questionId: q.id, status: 'supported', evidenceIds: [`e${i + 1}`], note: 'The quoted passage supports this decision.' })),
    questions: [], assumptions: [], unverified: [], continueResearch: false, reason: 'Sufficient context.' }), evidence, { questions: qs });
  const grounding = researchGrounding(plan, evidence, review);
  assert.ok(JSON.stringify(grounding.evidence).length <= 16_000); assert.ok(grounding.evidence.length < evidence.length);
  for (const q of qs) assert.equal(grounding.unresolvedQuestions.includes(`Verify for this task: ${q.question}`), !grounding.evidence.some(e => e.questionIds.includes(q.id)));
});

test('reference repositories retain their role through validation and final prompt boundaries', () => {
  const config = { type: 'local', kind: 'repository', name: 'Example', path: process.cwd() };
  assert.equal(validateLocal(config).purpose, 'reference'); assert.equal(validateLocal({ ...config, purpose: 'target' }).purpose, 'target'); assert.throws(() => validateLocal({ ...config, purpose: 'execute' }));
  const evidence = { sourceType: 'repository', purpose: 'reference', source: 'Example', locator: 'package.json', query: '', text: 'This example uses React.' };
  const prompt = buildPrompt({ input: 'Build a new Vue app using the example only as reference.', grounding: { evidence: [evidence] } });
  assert.match(prompt, /"purpose":"reference"/); assert.match(prompt, /reference.*(?:must not|do not|not).*target/i);
});

test('research reads the full task/settings without supplying host environment facts', () => {
  const input = 'Keep `BEGIN`.\n' + 'Preserve the supplied constraint.\n'.repeat(2800) + 'Keep `MIDDLE` and `END`.';
  const request = validateRequest({ input, language: 'pl', detail: 'detailed', task: 'research', terminology: 'BEGIN,MIDDLE,END', provider: 'claude', model: 'opus', effort: 'high', options: { planFirst: false } });
  const data = JSON.parse(buildResearchPrompt(request, []).split('# Preparation data\n')[1]);
  assert.equal(data.request, input); assert.equal(data.host, undefined); assert.equal(data.settings.detail, 'detailed'); assert.equal(data.settings.options.planFirst, false);
});

test('actionable provider/account failures remain failures instead of falling through to generation', async t => {
  const context = new ComposeContext(); t.after(() => context.close());
  for (const code of ['AUTH_REQUIRED', 'RATE_LIMITED', 'MODEL_UNAVAILABLE']) {
    await assert.rejects(context.prepare({ request: { input: 'Explain a useful algorithm.' }, sources: [] }, { runner: async () => { throw new ProviderError('Provider needs attention.', code); } }), error => error.code === code);
  }
});

test('two material questions share one lookup while retaining both evidence associations', async t => {
  const looked = [], context = new ComposeContext({ mcp: { retrieve: async (source, queries) => { looked.push(...queries); return queries.map(q => ({ source: 'Context7 / QuestDB', locator: '/questdb', text: questText, query: q.query, questionId: q.questionId })); } } }); t.after(() => context.close());
  const input = 'Set up QuestDB ingestion.', plan = planFor(input, [question('r7', 'QuestDB designated timestamp ingestion', 'context7'), question('r2', 'QuestDB designated timestamp ingestion', 'context7')]);
  const result = await context.prepare({ request: { input }, sources: [{ type: 'mcp', preset: 'context7' }] }, { runner: reviewer(plan) });
  assert.equal(looked.length, 1); assert.equal(result.research.lookups, 1); assert.deepEqual([...result.evidence[0].questionIds].sort(), ['r2', 'r7']);
  assert.equal(result.sources[0].status, 'retrieved');
});

test('target checkpoint preserves nonsequential IDs and allocates follow-up IDs without collisions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pb-grounding-roles-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'README.md'), 'The existing application uses FastAPI authentication middleware.');
  const input = 'Fix authentication in this app.', plan = planFor(input, [question('r7', 'existing project authentication framework', 'repository'), question('r2', 'authentication API compatibility', 'context7')], { needsProject: true, entities: ['authentication'] });
  const looked = [], context = new ComposeContext({ mcp: { retrieve: async (s, qs) => { looked.push(...qs); return qs.map(q => ({ source: 'Docs', locator: '/fastapi', text: 'FastAPI authentication middleware uses token verification.', query: q.query, questionId: q.questionId })); } } }); t.after(() => context.close());
  const checkpoints = [];
  await context.prepare({ request: { input }, sources: [{ type: 'local', kind: 'repository', purpose: 'target', name: 'App', path: root }, { type: 'mcp', preset: 'context7' }] }, { runner: async call => {
    if (call.prompt.startsWith('# Compose context preparation')) return { text: JSON.stringify(plan) };
    const data = JSON.parse(call.prompt.split('# Research data\n')[1]); checkpoints.push(data.priorQuestions.map(q => q.id));
    return { text: JSON.stringify(researchReview(call.prompt, checkpoints.length === 1 ? { continueResearch: true, questions: [question('r7', 'FastAPI authentication token verification', 'context7')] } : {})) };
  } });
  assert.ok(checkpoints.every(ids => ids.includes('r7') && ids.includes('r2') && new Set(ids).size === ids.length));
  assert.equal(looked[0].questionId, 'r1'); assert.ok(checkpoints.at(-1).includes('r1'));
});

test('reference repositories cannot establish an unknown target, even when the same framework appears in reference text', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pb-grounding-reference-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'README.md'), 'Reference application uses React authentication middleware.');
  const context = new ComposeContext({ mcp: { retrieve: () => assert.fail('An unrelated reference cannot establish the target stack') } }); t.after(() => context.close());
  const input = 'Fix authentication in my existing Vue project, using the selected example only as reference.';
  const plan = planFor(input, [question('r7', 'React authentication middleware', 'repository')], { needsProject: true, entities: ['Vue', 'authentication'] });
  const result = await context.prepare({ request: { input }, sources: [{ type: 'local', kind: 'repository', name: 'Example', path: root }, { type: 'mcp', preset: 'context7' }] }, { runner: reviewer(plan) });
  assert.ok(result.evidence.every(row => row.purpose !== 'target')); assert.match(result.grounding.unresolvedQuestions.join(' '), /actual project framework/);
  assert.match(buildPrompt({ input, grounding: result.grounding }), /existing Vue project/);
});

test('fresh preparation sees local edits immediately and retains target/reference provenance on duplicate passages', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pb-grounding-fresh-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'README.md'), input = 'Inspect the selected project authentication configuration.';
  const context = new ComposeContext(); t.after(() => context.close());
  const body = { request: { input }, sources: [{ type: 'local', kind: 'repository', purpose: 'target', name: 'App', path: root }] };
  const plan = planFor(input, [question('r5', 'authentication project configuration', 'repository')]);
  await writeFile(path, 'Authentication project configuration uses old middleware.'); const first = await context.prepare(body, { runner: reviewer(plan) }); assert.match(JSON.stringify(first.evidence), /old middleware/);
  await writeFile(path, 'Authentication project configuration uses new middleware.'); const second = await context.prepare(body, { runner: reviewer(plan) }); assert.match(JSON.stringify(second.evidence), /new middleware/); assert.doesNotMatch(JSON.stringify(second.evidence), /old middleware/);
  const duplicate = budgetEvidence(['target', 'reference'].map((purpose, i) => ({ sourceType: 'repository', purpose, source: 'Same source', locator: 'README.md', text: 'Authentication project configuration.', query: '', score: 2 - i, questionIds: ['r5'] })));
  assert.equal(duplicate.length, 1); assert.equal(duplicate[0].purpose, 'target'); assert.equal(duplicate[0].alsoFrom[0].purpose, 'reference');
});

test('short integration and long precise/nontechnical requests reach assessment intact and obey model-selected depth', async t => {
  const context = new ComposeContext(); t.after(() => context.close());
  const samples = [
    ['Set up QuestDB in Docker on this PC and ingest yfinance data with a suitable schema.', 'complex', 'deep', ['supported ingestion', 'designated timestamps', 'schema types', 'repeated ingestion']],
    ['Napisz serdeczne zaproszenie na spotkanie sąsiadów.', 'simple', 'none', []],
    ['Erkläre einem Kind, wie Regen entsteht.', 'simple', 'none', []],
    ['Preserve `BEGIN`.\n' + 'Keep each supplied wording requirement.\n'.repeat(1000) + 'Keep `MIDDLE`.\n' + 'Keep each supplied wording requirement.\n'.repeat(1000) + 'Keep `END`.', 'simple', 'none', []],
  ];
  for (const [input, complexity, research, gaps] of samples) {
    const plan = planFor(input, gaps.map((gap, i) => question(`r${i + 1}`, gap)), { complexity, research });
    if (input.length > 1200) plan.assessment.goal = 'Preserve all specified wording requirements and exact literals.'; // Compact assessment never replaces the full original input.
    const result = await context.prepare({ request: { input }, sources: [] }, { runner: async call => { const data = JSON.parse(call.prompt.split('# Preparation data\n')[1]); assert.equal(data.request, input); return { text: JSON.stringify(plan) }; } });
    assert.equal(result.calls, 1); assert.equal(result.research.lookups, 0); assert.equal(result.research.questions, gaps.length); assert.equal(result.assessment.research, research);
    assert.equal(result.evidence.length, 0); if (gaps.length) assert.equal(result.grounding.unresolvedQuestions.length, gaps.length);
  }
});

test('all providers, languages, detail modes and both quality modes keep settings through investigation and the existing pipeline', async t => {
  const context = new ComposeContext(); t.after(() => context.close());
  const efforts = { codex: 'max', claude: 'high', gemini: '', agy: 'high' }, details = ['super-short', 'concise', 'detailed', 'extremely-detailed'];
  let n = 0;
  for (const provider of Object.keys(efforts)) for (const detail of details) for (const quality of ['fast', 'reviewed']) {
    const language = ['en', 'de', 'pl'][n++ % 3], input = 'Preserve `BEGIN`, `MIDDLE`, and `END`. Explain the specified workflow.';
    const request = validateRequest({ input, provider, model: n % 2 ? '' : 'fixture', effort: efforts[provider], detail, quality, language, terminology: 'BEGIN,MIDDLE,END', task: 'research', options: { planFirst: false, edgeCases: true } });
    const seen = [];
    const runner = async call => {
      seen.push(call); assert.deepEqual([call.provider, call.model, call.effort, call.timeoutMs], [provider, request.model, efforts[provider], null]);
      if (call.prompt.startsWith('# Compose context preparation')) { const data = JSON.parse(call.prompt.split('# Preparation data\n')[1]); assert.equal(data.request, input); assert.deepEqual(data.settings.options, request.options); assert.equal(data.settings.detail, detail); return { text: JSON.stringify(planFor(input, [], { complexity: 'simple', research: 'none' })) }; }
      if (call.prompt.startsWith('# Review task')) { const data = JSON.parse(call.prompt.split('# Review data\n')[1]); assert.equal(data.settings.detail, detail); assert.equal(data.settings.language, language); return { text: JSON.stringify({ covered: data.units.map(u => u.id), requirements: [], criteria: Object.fromEntries(REVIEW_CRITERIA.map(k => [k, 'pass'])), issues: [] }) }; }
      assert.ok(call.prompt.includes(JSON.stringify(input))); return { text: input };
    };
    const prepared = await context.prepare({ request, sources: [] }, { runner }); const result = await runPipeline(validateRequest({ ...request, grounding: prepared.grounding }), { runner });
    assert.equal(result.prompt, input); assert.equal(seen.length, quality === 'fast' ? 2 : 3);
  }
});
