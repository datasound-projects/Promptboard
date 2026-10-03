import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PipelineActions } from '../src/pipeline-actions.mjs';

async function temp(t) { const dir = await realpath(await mkdtemp(join(tmpdir(), 'pb-actions-'))); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return dir; }
const row = (type, fields = {}) => ({ id: 'row-id', name: 'Fixture', type, enabled: true, ...fields });
const context = (actionId = 'persisted-action-id', cwd = null) => ({ actionId, cwd,
  task: { id: 'task-id', number: 17, title: 'Title "& `$(private)` {{projectName}}\r\n', prompt: 'PRIVATE TASK BODY', labels: ['one', 'two'], workspace: { path: cwd, branch: 'task/17' } },
  project: { id: 'project-id', name: 'Fixture project', repository: { root: cwd }, targetBranch: { name: 'main' } },
  move: { column: 'Build', fromColumn: 'Planning', toColumn: 'Build', trigger: 'enter' } });
const shellQuote = text => process.platform === 'win32' ? `'${text.replaceAll("'", "''")}'` : `'${text.replaceAll("'", "'\\''")}'`;
const nodeScript = file => `${process.platform === 'win32' ? '& ' : ''}${shellQuote(process.execPath)} ${shellQuote(file)}`;
async function until(fn) { const end = Date.now() + 10000; for (;;) { const value = await fn(); if (value) return value; if (Date.now() > end) assert.fail('Action fixture did not become ready.'); await new Promise(resolve => setTimeout(resolve, 40)); } }
async function server(t, handler) {
  const app = createServer(handler); await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.closeAllConnections(); app.close(resolve); })); return `http://127.0.0.1:${app.address().port}`;
}

test('scripts receive exact metadata and a literal native file invocation in a spaced, quoted working directory', async t => {
  const root = await temp(t), cwd = join(root, "quoted space & ' $"), worker = join(root, 'worker.mjs'); await mkdir(cwd);
  await writeFile(worker, `import { writeFileSync } from 'node:fs'; writeFileSync('observed.json', JSON.stringify({cwd:process.cwd(), title:process.env.PROMPTBOARD_TITLE, description:process.env.PROMPTBOARD_DESCRIPTION, task:process.env.PROMPTBOARD_TASK_ID, trigger:process.env.PROMPTBOARD_TRIGGER})); process.stdout.write('x'.repeat(6*1024*1024));`);
  const actions = new PipelineActions(); t.after(() => actions.shutdown());
  const ctx = context('literal-script', cwd), result = await actions.run(row('run_script', { script: nodeScript(worker) }), ctx);
  assert.equal(result.status, 'succeeded'); assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(await readFile(join(cwd, 'observed.json'), 'utf8')), { cwd, title: ctx.task.title, description: ': PRIVATE TASK BODY', task: 'task-id', trigger: 'enter' });
  assert.equal(actions.jobs.size, 0);
});

test('script nonzero and missing cwd outcomes fail without exposing script text or raw diagnostics', async t => {
  const cwd = await temp(t), actions = new PipelineActions(); t.after(() => actions.shutdown());
  const result = await actions.run(row('run_script', { script: 'echo PRIVATE DIAGNOSTIC\nexit 7' }), context('nonzero', cwd));
  assert.equal(result.status, 'failed'); assert.equal(result.exitCode, 7); assert.equal(result.errorCode, 'SCRIPT_FAILED'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  const missing = await actions.run(row('run_script', { script: 'echo NEVER RUN' }), context('missing-cwd', join(cwd, 'absent')));
  assert.equal(missing.status, 'failed'); assert.equal(missing.errorCode, 'SCRIPT_SPAWN_FAILED'); assert.equal(actions.jobs.size, 0);
  await assert.rejects(actions.run(row('run_script', { script: 'echo NEVER RUN' }), context('relative', 'relative')), { code: 'ACTION_CONTEXT_INVALID' });
});

test('script cancellation kills its child tree and leaves a separate action working; shutdown only stops owned jobs', async t => {
  const root = await temp(t), worker = join(root, 'tree.mjs'), actions = new PipelineActions(); t.after(() => actions.shutdown());
  await writeFile(worker, `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'; if(process.argv[2]==='child'){setInterval(()=>writeFileSync('heartbeat.txt',String(Date.now())),30)}else{spawn(process.execPath,[import.meta.filename,'child'],{stdio:'ignore'});setInterval(()=>{},1000)}`);
  const first = join(root, 'first'), second = join(root, 'second'); await mkdir(first); await mkdir(second);
  const a = actions.run(row('run_script', { script: nodeScript(worker) }), context('first-tree', first));
  const b = actions.run(row('run_script', { script: nodeScript(worker) }), context('second-tree', second));
  await until(async () => (await readFile(join(first, 'heartbeat.txt'), 'utf8').catch(() => null)) && (await readFile(join(second, 'heartbeat.txt'), 'utf8').catch(() => null)));
  await assert.rejects(actions.run(row('run_script', { script: 'exit 0' }), context('first-tree', first)), { code: 'ACTION_ACTIVE' });
  assert.equal(actions.cancel('first-tree'), true); assert.equal((await a).status, 'cancelled');
  const stopped = await readFile(join(first, 'heartbeat.txt'), 'utf8'), alive = await readFile(join(second, 'heartbeat.txt'), 'utf8');
  await until(async () => (await readFile(join(second, 'heartbeat.txt'), 'utf8')) !== alive);
  await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(await readFile(join(first, 'heartbeat.txt'), 'utf8'), stopped);
  await actions.shutdown(); assert.equal((await b).status, 'cancelled'); assert.equal(actions.jobs.size, 0);
  const last = await readFile(join(second, 'heartbeat.txt'), 'utf8'); await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(await readFile(join(second, 'heartbeat.txt'), 'utf8'), last);
  await assert.rejects(actions.run(row('run_script', { script: 'exit 0' }), context('after-shutdown', first)), { code: 'ACTION_SHUTTING_DOWN' });
});

test('script deadlines stop running work and pre-cancelled actions never start', async t => {
  const cwd = await temp(t), worker = join(cwd, 'busy.mjs'); await writeFile(worker, `import { writeFileSync } from 'node:fs'; writeFileSync('started.txt','started'); setInterval(()=>{},1000);`);
  const actions = new PipelineActions(); t.after(() => actions.shutdown());
  const work = actions.run(row('run_script', { script: nodeScript(worker) }), context('deadline-script', cwd), { timeoutMs: 2500 });
  await until(async () => readFile(join(cwd, 'started.txt'), 'utf8').catch(() => null)); const timed = await work; assert.equal(timed.status, 'timed_out', JSON.stringify(timed));
  const controller = new AbortController(); controller.abort();
  const result = await actions.run(row('run_script', { script: 'echo NEVER RUN' }), context('pre-cancelled', cwd), { signal: controller.signal });
  assert.equal(result.status, 'cancelled'); assert.equal(actions.jobs.size, 0);
});

test('webhooks send encoded URLs, JSON-safe bodies and protected idempotency keys to a local receiver', async t => {
  const seen = [], url = await server(t, (request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => { seen.push({ path: request.url, headers: request.headers, body, method: request.method }); response.writeHead(204); response.end(); });
  }), actions = new PipelineActions(); t.after(() => actions.shutdown());
  const ctx = context(), result = await actions.run(row('webhook', { url: `${url}/?title={{title}}`, body: '{"title":"{{title}}"}', headers: { 'X-Task': '{{taskId}}' } }), ctx);
  assert.equal(result.status, 'succeeded'); assert.equal(result.attempts, 1); assert.equal(seen[0].headers['idempotency-key'], ctx.actionId);
  assert.equal(seen[0].headers['x-task'], 'task-id'); assert.equal(new URL(seen[0].path, url).searchParams.get('title'), ctx.task.title);
  assert.deepEqual(JSON.parse(seen[0].body), { title: ctx.task.title });
  await actions.run(row('webhook', { url }), context('default-envelope'));
  const payload = JSON.parse(seen[1].body); assert.equal(payload.task.number, 17); assert.equal(payload.task.title, ctx.task.title); assert.deepEqual(payload.task.labels, ['one', 'two']); assert.doesNotMatch(seen[1].body, /PRIVATE TASK BODY/);
  await actions.run(row('webhook', { url, method: 'GET', body: 'ignored' }), context('get-envelope')); assert.equal(seen[2].method, 'GET'); assert.equal(seen[2].body, '');
});

test('webhooks retry only transport/408/429/5xx failures at most three times with one identity; permanent failures and redirects stop', async () => {
  for (const status of [408, 429, 500, 503, 599, 'transport', 400, 401, 404, 301]) {
    const seen = [], actions = new PipelineActions({ fetcher: async (_url, options) => {
      seen.push(options.headers.get('Idempotency-Key')); assert.equal(options.redirect, 'manual');
      if (status === 'transport') throw new Error('PRIVATE NETWORK DIAGNOSTIC');
      return new Response(null, { status, headers: { 'Retry-After': '0' } });
    } });
    const result = await actions.run(row('webhook', { url: 'https://example.test/' }), context('one-identity'));
    const retry = status === 'transport' || [408, 429, 500, 503, 599].includes(status);
    assert.equal(result.status, 'failed'); assert.equal(seen.length, retry ? 3 : 1); assert.ok(seen.every(id => id === 'one-identity')); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
});

test('webhook retries respect Retry-After and the total deadline; cancellation during backoff never starts another attempt', async t => {
  const url = await server(t, (_request, response) => { response.writeHead(429, { 'Retry-After': '20' }); response.end(); });
  const attempts = [], actions = new PipelineActions(); t.after(() => actions.shutdown());
  const timed = await actions.run(row('webhook', { url }), { ...context('retry-deadline'), onAttempt: n => attempts.push(n) }, { timeoutMs: 100 });
  assert.equal(timed.status, 'timed_out'); assert.deepEqual(attempts, [1]);
  const controller = new AbortController(), observed = [];
  const pending = actions.run(row('webhook', { url }), { ...context('retry-cancel'), onAttempt: n => observed.push(n) }, { signal: controller.signal });
  await until(() => observed.length); controller.abort(); assert.equal((await pending).status, 'cancelled'); assert.deepEqual(observed, [1]);
});

test('attempt intent must persist before a webhook can fire, including timeout while persistence is held', async t => {
  const url = await server(t, (_request, response) => response.end('ok')), actions = new PipelineActions(); t.after(() => actions.shutdown());
  let release, calls = 0; const held = new Promise(resolve => { release = resolve; });
  const realFetch = actions.fetcher; actions.fetcher = (...args) => { calls++; return realFetch(...args); };
  const pending = actions.run(row('webhook', { url }), { ...context('held-intent'), onAttempt: () => held }, { timeoutMs: 100 });
  assert.equal((await pending).status, 'timed_out'); assert.equal(calls, 0); release();
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(calls, 0);
  const failed = await actions.run(row('webhook', { url }), { ...context('failed-intent'), onAttempt: () => { throw new Error('PRIVATE WRITE ERROR'); } });
  assert.equal(failed.status, 'failed'); assert.equal(calls, 0); assert.doesNotMatch(JSON.stringify(failed), /PRIVATE/);
});

test('rendered header injection fails before transport; disabled rows and unsupported message delivery have no side effects', async () => {
  let calls = 0; const actions = new PipelineActions({ fetcher: () => { calls++; throw new Error('Must not call'); } });
  const result = await actions.run(row('webhook', { url: 'https://example.test', headers: { 'X-Title': '{{title}}' } }), context());
  assert.equal(result.errorCode, 'WEBHOOK_HEADERS_INVALID'); assert.equal(calls, 0);
  const disabled = await actions.run(row('send_message', { enabled: false, message: 'NEVER SEND' }), null); assert.equal(disabled.status, 'skipped');
  await assert.rejects(actions.run(row('send_message', { message: 'NEVER SEND' }), context()), { code: 'MESSAGE_SCHEDULER_REQUIRED' });
  await assert.rejects(actions.run(row('webhook', { url: 'https://example.test', headers: { 'Idempotency-Key': 'override' } }), context()), { code: 'INVALID_PIPELINE_CONFIG' });
});

test('notifications preserve literal template text and task identity, with explicit unconfirmed delivery', async () => {
  const seen = [], ctx = context(), actions = new PipelineActions({ notifier: async message => { seen.push(message); return { confirmed: true }; } });
  const result = await actions.run(row('notify', { title: '{{title}}', body: '{{toColumn}} {{unknown}}' }), ctx);
  assert.equal(result.status, 'succeeded'); assert.deepEqual(seen[0], { id: ctx.actionId, taskId: ctx.task.id, projectId: ctx.project.id, title: ctx.task.title, body: 'Build {{unknown}}' });
  assert.equal((await new PipelineActions().run(row('notify'), context('no-receiver'))).status, 'unconfirmed');
  assert.equal((await new PipelineActions({ notifier: () => ({ confirmed: false }) }).run(row('notify'), context('unconfirmed'))).status, 'unconfirmed');
});

test('Retry-After HTTP dates are honored and expired dates permit immediate bounded retries', async () => {
  for (const future of [false, true]) {
    let calls = 0; const actions = new PipelineActions({ fetcher: async () => { calls++; return new Response(null, { status: 503,
      headers: { 'Retry-After': new Date(Date.now() + (future ? 10000 : -10000)).toUTCString() } }); } });
    const result = await actions.run(row('webhook', { url: 'https://example.test/' }), context('date-backoff'), { timeoutMs: 750 });
    assert.equal(result.status, future ? 'timed_out' : 'failed'); assert.equal(calls, future ? 1 : 3);
  }
});

test('a webhook that never answers respects the total timeout and explicit cancellation without another request', async t => {
  let requests = 0; const url = await server(t, () => { requests++; }), actions = new PipelineActions(); t.after(() => actions.shutdown());
  const timed = await actions.run(row('webhook', { url }), context('hung-timeout'), { timeoutMs: 250 });
  assert.equal(timed.status, 'timed_out'); assert.equal(requests, 1);
  const pending = actions.run(row('webhook', { url }), context('hung-cancel'));
  await until(() => requests === 2); actions.cancel('hung-cancel'); assert.equal((await pending).status, 'cancelled'); assert.equal(requests, 2);
});

test('notification cancellation and timeout do not invent confirmation; rendered text and webhook fields stay bounded', async t => {
  const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
  let calls = 0; const actions = new PipelineActions({ notifier: () => { calls++; return new Promise(() => {}); } }); t.after(() => actions.shutdown());
  const pending = actions.run(row('notify'), context('hung-notification')); await until(() => calls === 1);
  actions.cancel('hung-notification'); assert.equal((await pending).status, 'cancelled');
  assert.equal((await actions.run(row('notify'), context('notification-timeout'), { timeoutMs: 50 })).status, 'timed_out');
  let message; const bounded = new PipelineActions({ notifier: value => { message = value; return { confirmed: true }; }, fetcher: () => assert.fail('Oversize fields must fail before transport.') });
  const ctx = context('bounded-fields'); ctx.task.title = 'a'.repeat(9000); ctx.task.prompt = 'b'.repeat(5000);
  assert.equal((await bounded.run(row('notify', { body: '{{description}}' }), ctx)).status, 'succeeded'); assert.equal(message.title.length, 500); assert.equal(message.body.length, 4000);
  assert.equal((await bounded.run(row('webhook', { url: 'https://example.test/?title={{title}}' }), ctx)).errorCode, 'WEBHOOK_URL_INVALID');
  assert.equal((await bounded.run(row('webhook', { url: 'https://example.test/', headers: { 'X-Title': '{{title}}' } }), ctx)).errorCode, 'WEBHOOK_HEADERS_INVALID');
});
