import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { ComposeContext } from '../src/compose-context.mjs';
import { CONTEXT_CHARS } from '../src/compose-grounding.mjs';
import { startTestServer } from './helpers/test-server.mjs';
import { researchPlan, researchReview, questTask, questText, pdfFixture } from './helpers/compose-fixtures.mjs';

async function httpApp(t, options = {}) {
  const app = await startTestServer(t, { port: 0, detector: async () => [], ...options });
  const { token } = await fetch(app.url + '/api/session').then(r => r.json());
  const post = (path, body, extra = {}) => fetch(app.url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ste-token': token }, body: JSON.stringify(body), ...extra });
  return { ...app, post, token };
}
const runner = calls => async call => {
  calls.push(call);
  return { text: call.prompt.startsWith('# Compose context preparation') ? JSON.stringify(researchPlan())
    : call.prompt.startsWith('# Compose research review') ? JSON.stringify(researchReview(call.prompt)) : questTask + ' Keep the timestamp explicit; inspect the actual environment.' };
};
const mcp = queries => ({ retrieve: async (source, plan) => { queries.push(...plan); return plan.map(query => ({ sourceType: 'mcp', source: 'Context7 / QuestDB', locator: '/questdb/questdb', query: query.query, questionId: query.questionId, text: questText })); } });

test('HTTP task → internal research → compression → existing generation; no user answers', async t => {
  const calls = [], queries = [];
  const app = await httpApp(t, { runner: runner(calls), composeMcp: mcp(queries) });
  const upload = await fetch(app.url + '/api/compose/sources/document?name=guide.pdf&from=40&to=55', { method: 'POST', headers: { 'x-ste-token': app.token, 'content-type': 'application/pdf' }, body: pdfFixture(Array.from({ length: 65 }, (_, i) => i >= 39 && i <= 54 ? questText : 'EXCLUDED CSS layout only.')) });
  assert.equal(upload.status, 200); const { document } = await upload.json();
  const response = await app.post('/api/compose/prepare', { request: { input: questTask }, autonomous: true, sources: [{ type: 'mcp', preset: 'context7' }, { type: 'document', id: document.id }, { type: 'expert', name: 'Architecture', text: questText }] });
  assert.equal(response.status, 200); const prepared = await response.json();
  assert.equal(prepared.state, 'ready'); assert.equal(prepared.calls, 2); assert.equal(prepared.questions, undefined);
  assert.ok(queries.every(query => query.libraryHint === 'QuestDB' && query.query.includes('ingestion')));
  assert.ok(prepared.grounding.evidence.length); assert.ok(JSON.stringify(prepared.grounding.evidence).length < CONTEXT_CHARS);
  assert.ok(prepared.grounding.evidence.every(row => row.text.length < 1200));
  assert.doesNotMatch(JSON.stringify(prepared.grounding), /EXCLUDED/); assert.ok(prepared.evidence.some(row => row.alsoFrom?.length));
  assert.deepEqual(prepared.grounding.userAnswers, []);
  const generated = await app.post('/api/generate', { input: questTask, quality: 'fast', grounding: prepared.grounding }); assert.equal(generated.status, 200);
  assert.equal(calls.length, 3); assert.match(calls[2].prompt, /ASD-STE100/); assert.match(calls[2].prompt, /Never ask the user clarification/);
  assert.doesNotMatch(calls[0].prompt, /ILP over HTTP/); // No raw source material before intent assessment.
  for (const call of calls) await assert.rejects(access(call.cwd));
});

test('disabled research adds zero calls; obvious non-actionable inputs never generate or retrieve', async t => {
  let calls = 0, mcpCalls = 0;
  const app = await httpApp(t, { runner: async () => { calls++; return { text: 'Rename Save to Apply.' }; }, composeMcp: { retrieve: async () => { mcpCalls++; throw new Error('Must not run'); } } });
  assert.equal((await app.post('/api/generate', { input: 'Rename Save to Apply.', quality: 'fast' })).status, 200);
  assert.equal((await (await app.post('/api/compose/prepare', { request: { input: 'Rename Save to Apply.' }, autonomous: false, sources: [] })).json()).calls, 0);
  for (const input of ['dog', 'QuestDB', 'asdf', '!!!', 'hello']) {
    const prepared = await (await app.post('/api/compose/prepare', { request: { input }, sources: [{ type: 'mcp', preset: 'context7' }] })).json();
    assert.equal(prepared.state, 'non-actionable'); assert.equal(prepared.calls, 0);
    assert.equal((await app.post('/api/generate', { input, quality: 'fast' })).status, 422);
  }
  assert.equal(calls, 1); assert.equal(mcpCalls, 0);
});

test('simple tasks and irrelevant queries/documents never invoke MCP or force evidence', async () => {
  const queries = [], context = new ComposeContext({ mcp: mcp(queries) });
  const simple = researchPlan('Create a website about dogs.', { complexity: 'simple', research: 'none', entities: ['dogs'] }); simple.questions = [];
  const result = await context.prepare({ request: { input: simple.assessment.goal }, sources: [{ type: 'mcp', preset: 'context7' }] }, { runner: async () => ({ text: JSON.stringify(simple) }) });
  assert.equal(result.calls, 1); assert.deepEqual(result.evidence, []); assert.equal(queries.length, 0); assert.equal(result.research.lookups, 0);
  const file = await context.documents.add(Buffer.from('CSS layout grid columns colors margin spacing font styles.'.repeat(1000)), { name: 'css.md' });
  const unrelated = await context.prepare({ request: { input: questTask }, sources: [{ type: 'document', id: file.id }] }, { runner: runner([]) });
  assert.deepEqual(unrelated.evidence, []); assert.equal(unrelated.calls, 1); assert.equal(unrelated.sources[0].status, 'no-relevant-context');
  const wrong = researchPlan(); wrong.questions.forEach(q => { q.query = 'dinosaur fossils paleontology'; });
  const gated = await context.prepare({ request: { input: questTask }, sources: [{ type: 'mcp', preset: 'context7' }] }, { runner: async () => ({ text: JSON.stringify(wrong) }) });
  assert.equal(gated.research.lookups, 0); assert.equal(queries.length, 0);
});

test('source failure still permits generation; malformed assessment never invents a goal', async () => {
  const context = new ComposeContext({ mcp: { retrieve: async () => { throw new Error('MCP unavailable'); } } });
  const body = { request: { input: questTask }, sources: [{ type: 'mcp', preset: 'context7' }] };
  const result = await context.prepare(body, { runner: runner([]) });
  assert.equal(result.state, 'ready'); assert.match(result.warnings.join(' '), /unavailable/); assert.ok(result.grounding.unresolvedQuestions.length);
  for (const model of [async () => ({ text: 'HACKED' }), async () => { throw new Error('SECRET_CLI_DIAGNOSTIC'); }]) {
    const failed = await context.prepare(body, { runner: model }); assert.equal(failed.state, 'ready'); assert.equal(failed.calls, 1); assert.deepEqual(failed.grounding, {}); assert.equal(failed.evidence.length, 0); assert.match(failed.warnings.join(' '), /assessment was unavailable or invalid/); assert.doesNotMatch(JSON.stringify(failed), /SECRET_CLI/);
  }
  const topic = researchPlan('financial data'); Object.assign(topic.assessment, { actionable: false, goal: '', research: 'none', needsProject: false }); topic.questions = [];
  const noGoal = await context.prepare({ request: { input: 'financial data' }, sources: body.sources }, { runner: async () => ({ text: JSON.stringify(topic) }) });
  assert.equal(noGoal.state, 'non-actionable'); assert.equal(noGoal.evidence.length, 0);
});

test('Compose endpoints enforce token/origin, strict validation and bounded raw uploads', async t => {
  const app = await httpApp(t); const body = { request: { input: questTask }, autonomous: true, sources: [] };
  assert.equal((await app.post('/api/compose/prepare', body, { headers: { 'content-type': 'application/json' } })).status, 403);
  assert.equal((await app.post('/api/compose/prepare', body, { headers: { 'x-ste-token': app.token, origin: 'https://evil.test' } })).status, 403);
  for (const data of [{ ...body, autonomous: 'true' }, { ...body, unexpected: true }, { ...body, sources: [{ type: 'shell' }] }, { ...body, request: { input: questTask, unexpected: true } }]) assert.equal((await app.post('/api/compose/prepare', data)).status, 400);
  for (const query of ['name=..%2Ffile.pdf', 'name=guide.pdf&from=55&to=40', 'name=file.exe']) assert.equal((await fetch(app.url + '/api/compose/sources/document?' + query, { method: 'POST', headers: { 'x-ste-token': app.token, 'content-type': 'application/pdf' }, body: 'small' })).status, 400);
  assert.equal((await fetch(app.url + '/api/compose/sources/document?name=large.txt', { method: 'POST', headers: { 'x-ste-token': app.token, 'content-type': 'text/plain' }, body: 'x'.repeat(21 * 1024 * 1024) })).status, 413);
  const scan = await fetch(app.url + '/api/compose/sources/document?name=scan.pdf', { method: 'POST', headers: { 'x-ste-token': app.token, 'content-type': 'application/pdf' }, body: pdfFixture(['']) }); assert.equal(scan.status, 422); assert.match(await scan.text(), /scanned/);
});

test('disconnect cancels research and frees the generation slot', async t => {
  let entered, aborted; const start = new Promise(resolve => { entered = resolve; }), stop = new Promise(resolve => { aborted = resolve; });
  const app = await httpApp(t, { runner: async ({ signal, prompt }) => {
    if (!prompt.startsWith('# Compose context')) return { text: 'Rename Save to Apply.' };
    entered(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted(); reject(signal.reason); }, { once: true }));
  } });
  const control = new AbortController();
  const pending = app.post('/api/compose/prepare', { request: { input: questTask }, sources: [] }, { signal: control.signal });
  await start; control.abort(); await assert.rejects(pending); await stop;
  assert.equal((await app.post('/api/generate', { input: 'Rename Save to Apply.', quality: 'fast' })).status, 200);
});
