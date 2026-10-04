import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import http from 'node:http';
import { startTestServer } from './helpers/test-server.mjs';
import { emptyState, STATE_VERSION } from '../src/store.mjs';
import { defaultPipelineConfig } from '../src/pipeline-config.mjs';
import { repositoryPipelineDefinition } from '../src/pipeline-repository.mjs';

const detector = async () => [{ id: 'codex', name: 'Codex', available: true, version: 'test fixture' }];
async function open(t, runner = async () => ({ text: 'Add the route. Do the tests.', provider: 'codex', durationMs: 15 })) {
  const app = await startTestServer(t, { port: 0, runner, detector });
  const { token } = await fetch(app.url + '/api/session').then(r => r.json());
  const post = (data, extra = {}) => fetch(app.url + '/api/generate', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-ste-token': token, ...extra }, body: JSON.stringify({ quality: 'fast', ...data }),
  });
  return { ...app, post };
}

test('the endpoint transforms text through a runner and removes the temporary folder', async t => {
  let folder;
  const app = await open(t, async request => {
    folder = request.cwd;
    await access(folder);
    assert.match(request.prompt, /Add a status route/);
    assert.equal(request.provider, 'codex');
    return { text: 'Add a status route. Do the tests.', provider: 'codex', durationMs: 7 };
  });
  const response = await app.post({ input: 'Add a status route', provider: 'codex' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.prompt, 'Add a status route. Do the tests.');
  assert.equal(body.lint.reviewRequired, true);
  assert.ok(body.durationMs >= 0);
  assert.equal(body.verification.calls, 1);
  await assert.rejects(access(folder));
});

test('the endpoint rejects cross-site access, invalid tokens, and rebinding hosts', async t => {
  let calls = 0;
  const app = await open(t, async () => { calls++; return { text: 'No call expected.' }; });
  assert.equal((await app.post({ input: 'Hello' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await app.post({ input: 'Hello' }, { 'x-ste-token': 'wrong' })).status, 403);
  const rebound = await new Promise((resolve, reject) => {
    const req = http.get(app.url + '/api/session', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(rebound, 403);
  assert.equal((await fetch(app.url + '/api/session', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal(calls, 0);
});

test('validation rejects invalid fields before calling a CLI', async t => {
  let calls = 0;
  const app = await open(t, async () => { calls++; return { text: 'No call expected.' }; });
  for (const request of [{ input: '' }, { input: 'Hi', provider: 'sh' }, { input: 'Hi', model: '--unsafe' }, { input: 'Hi', options: { planFirst: 'yes' } }]) {
    assert.equal((await app.post(request)).status, 400);
  }
  assert.equal(calls, 0);
});

test('runner failures do not expose private CLI diagnostics and always clean up', async t => {
  let folder;
  const app = await open(t, async request => { folder = request.cwd; throw new Error('SECRET_API_KEY and private file data'); });
  const response = await app.post({ input: 'Check the route.' });
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /SECRET_API_KEY/);
  await assert.rejects(access(folder));
});

test('only one generation can run at a time', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const app = await open(t, async () => { entered(); await gate; return { text: 'Write one prompt.' }; });
  const first = app.post({ input: 'A request.' });
  await started;
  // 409, not 429: a local busy state must not look like a provider rate limit.
  const second = await app.post({ input: 'A second request.' });
  assert.equal(second.status, 409);
  assert.equal((await second.json()).code, 'BUSY');
  release();
  assert.equal((await first).status, 200);
});

test('browser cancellation reaches the runner', async t => {
  let entered, cancelled;
  const started = new Promise(resolve => { entered = resolve; });
  const stopped = new Promise(resolve => { cancelled = resolve; });
  const app = await open(t, ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { cancelled(); reject(new Error('Cancelled')); }, { once: true });
    entered();
  }));
  const { token } = await fetch(app.url + '/api/session').then(r => r.json());
  const controller = new AbortController();
  const response = fetch(app.url + '/api/generate', { method: 'POST', signal: controller.signal,
    headers: { 'content-type': 'application/json', 'x-ste-token': token }, body: JSON.stringify({ input: 'A request.' }) });
  const rejected = assert.rejects(response, { name: 'AbortError' });
  await started;
  controller.abort();
  await rejected;
  await Promise.race([stopped, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Cancel did not propagate')), 2000); timer.unref(); })]);
});

test('static assets have local security headers and cannot expose source files', async t => {
  const app = await open(t);
  const response = await fetch(app.url + '/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(app.url + '/src/server.mjs')).status, 404);
  const prefs = await fetch(app.url + '/prefs.js');
  assert.equal(prefs.status, 200);
  assert.match(prefs.headers.get('content-type'), /^text\/javascript/);
  const providers = await fetch(app.url + '/api/providers').then(r => r.json());
  assert.equal(providers.providers[0].available, true);
});

test('model lookup is token protected, cached, and validates requested effort before generation', async t => {
  let lookups = 0, calls = 0, last;
  const catalogReader = async provider => {
    lookups++;
    return { provider, source: 'cli', defaultModel: 'test-model', models: [{ id: 'test-model', name: 'Test', efforts: ['low', 'high'] }] };
  };
  const app = await startTestServer(t, { port: 0, detector, catalogReader, runner: async request => { calls++; last = request; return { text: 'Dodaj test.', reportedModels: ['resolved-test-model'] }; } });
  const { token } = await fetch(app.url + '/api/session').then(r => r.json());
  const headers = { 'x-ste-token': token };
  assert.equal((await fetch(app.url + '/api/models?provider=codex')).status, 403);
  assert.equal((await fetch(app.url + '/api/models?provider=sh', { headers })).status, 400);
  assert.equal((await fetch(app.url + '/api/models?provider=codex', { headers })).status, 200);
  await fetch(app.url + '/api/models?provider=codex', { headers });
  assert.equal(lookups, 1);
  await fetch(app.url + '/api/models?provider=codex&refresh=1', { headers });
  assert.equal(lookups, 2);
  const post = effort => fetch(app.url + '/api/generate', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ input: 'Add a test.', quality: 'fast', model: 'test-model', provider: 'codex', effort, language: 'pl' }) });
  assert.equal((await post('medium')).status, 400);
  assert.equal(calls, 0);
  const response = await post('high');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(last.model, 'test-model');
  assert.equal(last.effort, 'high');
  assert.match(last.prompt, /Write all headings and prose in Polish/);
  assert.equal(result.language, 'pl');
  assert.deepEqual(result.reportedModels, ['resolved-test-model']);
  assert.equal(result.lint.warnings[0].rule, 'language-review');
  assert.equal(lookups, 2);
  // Generate reuses the catalog the UI already loaded, even after the 60 s list refresh window.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 10 * 60_000 });
  assert.equal((await post('high')).status, 200);
  assert.equal(lookups, 2);
  await fetch(app.url + '/api/models?provider=codex', { headers });
  assert.equal(lookups, 3);
});

test('automation history and scoped Stop require authentication, expose receipts without executable content, and never replay input', async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const { token } = await fetch(app.url + '/api/session').then(response => response.json());
  const headers = { 'content-type': 'application/json', 'x-ste-token': token };
  const project = await app.board.createProject({ name: 'Offline actions' }), pipeline = defaultPipelineConfig();
  for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  pipeline.columns[3].automations.onEnter = [{ id: 'fixture-webhook', name: 'Local fixture', type: 'webhook', enabled: true,
    url: 'https://example.test/PRIVATE_ENDPOINT', body: 'PRIVATE_BODY', headers: { Authorization: 'PRIVATE_TOKEN' } }];
  await app.board.setPipeline(project.id, { pipeline, expectedRevision: 1, confirm: true });
  const task = await app.board.createTask({ projectId: project.id, title: 'Exact title', prompt: 'PRIVATE_COMPOSER_PROMPT' });
  let calls = 0; app.board.automations.actions.fetcher = async () => { calls++; return new Response(null, { status: 204 }); };
  const path = `/api/tasks/${task.id}`, nonce = 'same-http-move';
  for (const action of ['automations', 'cancel-automations']) {
    const options = action === 'automations' ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"confirm":true}' };
    assert.equal((await fetch(app.url + path + '/' + action, options)).status, 403);
  }
  const move = () => fetch(app.url + path + '/move', { method: 'POST', headers, body: JSON.stringify({ column: 'code_review', expectedRevision: 1, transitionId: nonce }) });
  assert.equal((await move()).status, 200); assert.equal(calls, 1);
  const history = await fetch(app.url + path + '/automations', { headers }).then(response => response.json());
  assert.equal(history.moves[0].status, 'completed'); assert.equal(history.moves[0].actions[0].status, 'succeeded');
  assert.doesNotMatch(JSON.stringify(history), /PRIVATE_|script|nativeHistoryPath/);
  assert.equal((await move()).status, 200); assert.equal(calls, 1);
  assert.equal((await fetch(app.url + path + '/cancel-automations', { method: 'POST', headers, body: '{}' })).status, 400);
  assert.equal((await fetch(app.url + path + '/cancel-automations', { method: 'POST', headers, body: '{"confirm":true}' })).status, 200);
  assert.equal(calls, 1); assert.equal((await app.board.state()).runs.length, 0);
  assert.equal((await fetch(app.url + '/api/tasks/missing/automations', { headers })).status, 404);
  assert.equal((await fetch(app.url + path + '/message', { method: 'POST', headers, body: '{"message":"NEVER_TYPE"}' })).status, 404);
});

test('background server polling migrates only its disposable test data without a board request', async t => {
  const legacy = { ...emptyState(), version: 2, projects: [{ id: 'isolated-fixture', name: 'Fixture', tasks: [] }] };
  delete legacy.base;
  const app = await startTestServer(t, { port: 0, detector, initialState: legacy });
  const deadline = Date.now() + 5000;
  while (!app.board.store.state && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(app.board.store.state, 'Autopilot can load state even when this test never requests the board.');
  const saved = JSON.parse(await readFile(app.board.store.path, 'utf8'));
  assert.equal(saved.version, STATE_VERSION); assert.equal(saved.projects[0].id, 'isolated-fixture');
  assert.match(app.board.dataDir, /pb-server-fixture-/);
});

test('task pipeline settings require local authentication and exact revisions, and never execute on save', async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const { token } = await fetch(app.url + '/api/session').then(response => response.json());
  const project = await app.board.createProject({ name: 'Task settings' }), pipeline = defaultPipelineConfig();
  pipeline.profiles = [{ id: 'profile', name: 'Profile', columns: {} }];
  await app.board.setPipeline(project.id, { pipeline, expectedRevision: 1, confirm: true });
  const task = await app.board.createTask({ projectId: project.id, title: 'Exact', prompt: '  Exact Composer\r\n' });
  const url = app.url + `/api/tasks/${task.id}/pipeline-settings`, data = { profileId: 'profile', expectedRevision: 1, expectedProjectRevision: 2 };
  const post = (body = data, extra = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ste-token': token, ...extra }, body: JSON.stringify(body) });
  assert.equal((await post(data, { 'x-ste-token': '' })).status, 403);
  assert.equal((await post(data, { Origin: 'https://foreign.test' })).status, 403);
  assert.equal((await post({ ...data, expectedProjectRevision: 1 })).status, 409);
  assert.equal((await post({ ...data, agentOverride: { agentOverride: 'codex' } })).status, 400);
  const response = await post(); assert.equal(response.status, 200); const saved = await response.json();
  assert.equal(saved.task.profileId, 'profile'); assert.equal(saved.task.prompt, task.prompt); assert.equal(saved.task.contentRevision, 1); assert.deepEqual(saved.board.runs, []);
  assert.equal((await post()).status, 409); assert.equal((await app.board.state()).projects[0].tasks[0].revision, 2);
});

test('repository change status is authenticated, contains no definition text and never applies or starts work', async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const { token } = await fetch(`${app.url}/api/session`).then(response => response.json());
  const { project } = await app.board.createProjectWithRepository({ name: 'Watched files', folder: 'new' }), pipeline = defaultPipelineConfig();
  for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  await app.board.setPipeline(project.id, { pipeline, expectedRevision: project.revision, confirm: true });
  await writeFile(join(project.repository.root, 'promptboard.json'), JSON.stringify(repositoryPipelineDefinition(pipeline)));
  await app.board.applyRepositoryPipeline(project.id, { ...await app.board.previewRepositoryPipeline(project.id), confirm: true });
  const url = `${app.url}/api/projects/${project.id}/repository-pipeline-status`, headers = { 'x-ste-token': token };
  assert.equal((await fetch(url)).status, 403); assert.equal((await fetch(url, { headers: { ...headers, origin: 'https://evil.example' } })).status, 403);
  const before = structuredClone(await app.board.state());
  assert.equal((await fetch(url, { headers }).then(response => response.json())).changed, false);
  await writeFile(join(project.repository.root, 'promptboard.local.json'), JSON.stringify({ version: 1, columns: [{ name: 'Executing', description: 'SECRET_CONFIG_TEXT', strategy: { autoSpawn: true } }] }));
  const response = await fetch(url + '?path=outside.json', { headers }); assert.equal(response.status, 200);
  const data = await response.json(); assert.equal(data.changed, true); assert.equal(data.errorCode, null); assert.ok(!JSON.stringify(data).includes('SECRET_CONFIG_TEXT')); assert.equal(data.pipeline, undefined);
  assert.equal((await fetch(url, { method: 'POST', headers })).status, 404);
  assert.deepEqual(await app.board.state(), before);
});

test('repository board review and apply enforce authentication, local origin, reviewed revisions and confirmation', async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const { token } = await fetch(app.url + '/api/session').then(response => response.json());
  const { project } = await app.board.createProjectWithRepository({ name: 'Config fixture', folder: 'new' }), pipeline = defaultPipelineConfig();
  for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  await app.board.setPipeline(project.id, { pipeline, expectedRevision: project.revision, confirm: true });
  await writeFile(join(project.repository.root, 'promptboard.json'), JSON.stringify(repositoryPipelineDefinition(pipeline)));
  const url = `${app.url}/api/projects/${project.id}/repository-pipeline`, headers = { 'x-ste-token': token };
  assert.equal((await fetch(url)).status, 403); assert.equal((await fetch(url, { headers: { ...headers, origin: 'https://foreign.test' } })).status, 403);
  const response = await fetch(url, { headers }); assert.equal(response.status, 200); const reviewed = await response.json();
  const post = body => fetch(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post(reviewed)).status, 409); assert.equal((await post({ ...reviewed, confirm: true, expectedProjectRevision: 99 })).status, 409);
  assert.equal((await post({ ...reviewed, confirm: true })).status, 200); assert.deepEqual((await app.board.state()).runs, []);
  assert.equal((await post({ ...reviewed, confirm: true })).status, 409);
});
