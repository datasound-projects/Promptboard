import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { ComposeContext } from '../src/compose-context.mjs';
import { assembleGrounding, CONTEXT_CHARS } from '../src/compose-grounding.mjs';
import { startTestServer } from './helpers/test-server.mjs';
import { questPlan, questTask, questText, pdfFixture } from './helpers/compose-fixtures.mjs';

async function httpApp(t, options = {}) {
  const app = await startTestServer(t, { port: 0, detector: async () => [], ...options });
  const { token } = await fetch(app.url + '/api/session').then(r => r.json());
  const post = (path, body, extra = {}) => fetch(app.url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ste-token': token }, body: JSON.stringify(body), ...extra });
  return { ...app, post, token };
}

test('HTTP task → plan → mixed source retrieval → optional answers → existing pipeline', async t => {
  const calls = [], queries = [];
  const app = await httpApp(t, { runner: async call => {
    calls.push(call);
    return { text: call.prompt.startsWith('# Compose context preparation') ? JSON.stringify(questPlan) : questTask + ' Use event_time. Keep 150000 events/sec.' };
  }, composeMcp: { retrieve: async (source, plan) => { queries.push(...plan); return plan.map(query => ({ sourceType: 'mcp', source: 'Context7 / QuestDB', locator: '/questdb/questdb', query: query.query, questionId: query.questionId, text: questText })); } } });
  const upload = await fetch(app.url + '/api/compose/sources/document?name=guide.pdf&from=40&to=55', { method: 'POST', headers: { 'x-ste-token': app.token, 'content-type': 'application/pdf' }, body: pdfFixture(Array.from({ length: 65 }, (_, i) => i >= 39 && i <= 54 ? questText : 'EXCLUDED CSS layout only.')) });
  assert.equal(upload.status, 200); const { document } = await upload.json();
  const preparedResponse = await app.post('/api/compose/prepare', { request: { input: questTask }, clarify: true, sources: [{ type: 'mcp', preset: 'context7' }, { type: 'document', id: document.id }, { type: 'expert', name: 'Our architecture', text: questText }] });
  assert.equal(preparedResponse.status, 200); const prepared = await preparedResponse.json();
  assert.equal(prepared.calls, 1); assert.equal(calls.length, 1); assert.ok(queries.every(query => query.libraryHint === 'QuestDB' && query.query.includes('ingestion')));
  assert.ok(prepared.evidence.length); assert.ok(JSON.stringify(prepared.evidence).length <= CONTEXT_CHARS);
  assert.doesNotMatch(JSON.stringify(prepared.evidence), /EXCLUDED/); assert.ok(prepared.evidence.some(row => row.alsoFrom?.length));
  const grounding = assembleGrounding(prepared, { q1: '150000 events/sec', q3: 'Use event_time.' });
  assert.equal(grounding.userAnswers.length, 2); assert.deepEqual(grounding.unresolvedQuestions, []);
  const response = await app.post('/api/generate', { input: questTask, quality: 'fast', grounding }); assert.equal(response.status, 200);
  const result = await response.json(); assert.match(result.prompt, /event_time/);
  assert.equal(calls.length, 2); assert.match(calls[1].prompt, /ASD-STE100/); assert.match(calls[1].prompt, /userAnswers/);
  assert.doesNotMatch(calls[0].prompt, /ILP over HTTP/); // No raw source content in planner.
  for (const call of calls) await assert.rejects(access(call.cwd));
});

test('disabled context calls only the existing generation pipeline and leaves preparation inert', async t => {
  let calls = 0, mcpCalls = 0;
  const app = await httpApp(t, { runner: async () => { calls++; return { text: 'Rename Save to Apply.' }; }, composeMcp: { retrieve: async () => { mcpCalls++; throw new Error('Must not run'); } } });
  const response = await app.post('/api/generate', { input: 'Rename Save to Apply.', quality: 'fast' });
  assert.equal(response.status, 200); assert.equal(calls, 1); assert.equal(mcpCalls, 0);
  const prepared = await app.post('/api/compose/prepare', { request: { input: 'Rename Save to Apply.' }, clarify: false, sources: [] });
  assert.equal((await prepared.json()).calls, 0); assert.equal(calls, 1);
});

test('irrelevant tasks never open MCP; irrelevant CSS contributes no evidence', async () => {
  let connected = 0; const context = new ComposeContext({ mcp: { retrieve: async () => { connected++; throw new Error('Must not query'); } } });
  const empty = await context.prepare({ request: { input: 'Rename Save to Apply.' }, clarify: false, sources: [{ type: 'mcp', preset: 'context7' }] }, { runner: async () => ({ text: '{"questions":[]}' }) });
  assert.equal(connected, 0); assert.equal(empty.sources[0].status, 'not-needed');
  const file = await context.documents.add(Buffer.from('CSS layout grid columns colors margin spacing font styles.'.repeat(1000)), { name: 'css.md' });
  const result = await context.prepare({ request: { input: questTask }, clarify: true, sources: [{ type: 'document', id: file.id }] }, { runner: async () => ({ text: JSON.stringify(questPlan) }) });
  assert.deepEqual(result.evidence, []); assert.equal(result.sources[0].status, 'no-relevant-context');
});

test('skip all questions preserves unresolved decisions; planner and source failures degrade', async () => {
  const context = new ComposeContext({ mcp: { retrieve: async () => { throw new Error('MCP unavailable'); } } });
  const body = { request: { input: questTask }, clarify: true, sources: [{ type: 'mcp', preset: 'context7' }] };
  const result = await context.prepare(body, { runner: async () => ({ text: JSON.stringify(questPlan) }) });
  assert.match(result.warnings.join(' '), /unavailable/);
  const grounding = assembleGrounding(result); assert.deepEqual(grounding.userAnswers, []); assert.equal(grounding.unresolvedQuestions.length, 3);
  for (const runner of [async () => ({ text: 'HACKED' }), async () => { throw new Error('SECRET_CLI_DIAGNOSTIC'); }]) {
    const failed = await context.prepare(body, { runner }); assert.equal(failed.calls, 1); assert.ok(failed.warnings.length); assert.doesNotMatch(JSON.stringify(failed), /SECRET_CLI/);
  }
});

test('Compose endpoints enforce existing token/origin checks, validation and raw upload limits', async t => {
  const app = await httpApp(t);
  const body = { request: { input: questTask }, clarify: true, sources: [] };
  assert.equal((await app.post('/api/compose/prepare', body, { headers: { 'content-type': 'application/json' } })).status, 403);
  assert.equal((await app.post('/api/compose/prepare', body, { headers: { 'x-ste-token': app.token, origin: 'https://evil.test' } })).status, 403);
  for (const data of [{ ...body, clarify: 'true' }, { ...body, unexpected: true }, { ...body, sources: [{ type: 'shell' }] }, { ...body, request: { input: questTask, unexpected: true } }]) assert.equal((await app.post('/api/compose/prepare', data)).status, 400);
  for (const query of ['name=..%2Ffile.pdf', 'name=guide.pdf&from=55&to=40', 'name=file.exe']) {
    const response = await fetch(app.url + '/api/compose/sources/document?' + query, { method: 'POST', headers: { 'x-ste-token': app.token, 'content-type': 'application/pdf' }, body: 'small' }); assert.equal(response.status, 400);
  }
  const large = await fetch(app.url + '/api/compose/sources/document?name=large.txt', { method: 'POST', headers: { 'x-ste-token': app.token, 'content-type': 'text/plain' }, body: 'x'.repeat(21 * 1024 * 1024) }); assert.equal(large.status, 413);
  const scan = await fetch(app.url + '/api/compose/sources/document?name=scan.pdf', { method: 'POST', headers: { 'x-ste-token': app.token, 'content-type': 'application/pdf' }, body: pdfFixture(['']) }); assert.equal(scan.status, 422); assert.match(await scan.text(), /scanned/);
});

test('disconnect cancels planning and frees the generation slot without leaking the task', async t => {
  let entered, aborted; const start = new Promise(resolve => { entered = resolve; }), stop = new Promise(resolve => { aborted = resolve; });
  const app = await httpApp(t, { runner: async ({ signal, prompt }) => {
    if (!prompt.startsWith('# Compose context')) return { text: 'Rename Save to Apply.' };
    entered(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted(); reject(signal.reason); }, { once: true }));
  } });
  const control = new AbortController();
  const pending = app.post('/api/compose/prepare', { request: { input: questTask }, clarify: true, sources: [] }, { signal: control.signal });
  await start; control.abort(); await assert.rejects(pending); await stop;
  assert.equal((await app.post('/api/generate', { input: 'Rename Save to Apply.', quality: 'fast' })).status, 200);
});
