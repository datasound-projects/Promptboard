import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRequest } from './engine.mjs';
import { runPipeline } from './pipeline.mjs';
import { detectProviders, FAILURE_MESSAGES, killOwnedProcesses, ProviderError, resolveExecutable, runProvider, validateEffort } from './providers.mjs';
import { AUTH_CAPABILITIES, logout, readAuthStatus, startLogin } from './auth.mjs';
import { discoverModels, checkModelEffort } from './models.mjs';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/prefs.js', ['prefs.js', 'text/javascript; charset=utf-8']],
  ['/nerd.png', ['nerd.png', 'image/png']],
  ['/kanban-mascot.png', ['kanban-mascot.png', 'image/png']],
]);

function send(res, code, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function jsonBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
    throw Object.assign(new Error('Send JSON with Content-Type: application/json.'), { status: 415 });
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_048_576) throw Object.assign(new Error('The request is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('The request is not valid JSON.'), { status: 400 }); }
}

// Wait for a shared promise, but stop waiting when this request is cancelled.
function abortable(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new ProviderError('Generation was cancelled.', 'ABORTED'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export async function generate(request, { runner = runProvider, signal, catalogReader = discoverModels, onStage } = {}) {
  const value = validateRequest(request);
  try { validateEffort(value.provider, value.effort); } catch (error) { throw Object.assign(error, { status: 400 }); }
  if (value.effort) {
    onStage?.('models');
    checkModelEffort(value.provider, value.model, value.effort, await abortable(catalogReader(value.provider, { signal }), signal));
  }
  return runPipeline(value, { runner, signal, onStage });
}

// Map internal codes to HTTP statuses. Message text always comes from fixed strings.
const STATUS = { ABORTED: 499, TIMEOUT: 504, BUSY: 409, AUTH_IN_PROGRESS: 409, NOT_INSTALLED: 409, UNSUPPORTED: 400, INVALID_PROVIDER: 400 };
function failureBody(error, fallback) {
  const known = typeof error?.code === 'string' && Object.hasOwn(FAILURE_MESSAGES, error.code);
  if (error?.status && error.status < 500 && error.status !== 499) return { status: error.status, body: { error: error.message, code: error.code || 'INVALID_REQUEST' } };
  if (known) return { status: STATUS[error.code] || 502, body: { error: FAILURE_MESSAGES[error.code], code: error.code, ...(error.resetsAt ? { resetsAt: error.resetsAt } : {}) } };
  if (error?.name === 'TimeoutError') return { status: 504, body: { error: FAILURE_MESSAGES.TIMEOUT, code: 'TIMEOUT' } };
  if (error?.name === 'AbortError') return { status: 499, body: { error: FAILURE_MESSAGES.ABORTED, code: 'ABORTED' } };
  return { status: 502, body: { error: fallback, code: 'UNKNOWN' } };
}

const auth = { installed: async provider => Boolean(await resolveExecutable(provider)), status: readAuthStatus, login: startLogin, logout };

export async function startServer({ port = 4318, runner = runProvider, detector = detectProviders, catalogReader = discoverModels, authAdapter = auth } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('The port must be 0–65535.');
  const token = randomBytes(32).toString('hex');
  const catalogAbort = new AbortController();
  const catalogs = new Map(), lookups = new Map();
  const getCatalog = (provider, { refresh = false } = {}) => {
    if (!['codex', 'claude', 'gemini', 'agy'].includes(provider)) throw Object.assign(new Error('Choose a valid provider.'), { status: 400 });
    const cached = catalogs.get(provider);
    if (!refresh && cached && Date.now() - cached.time < 60000) return Promise.resolve(cached.value);
    if (lookups.has(provider)) return lookups.get(provider);
    const pending = Promise.resolve().then(() => catalogReader(provider, { signal: catalogAbort.signal }))
      .then(value => { catalogs.set(provider, { value, time: Date.now() }); return value; })
      .finally(() => lookups.delete(provider));
    lookups.set(provider, pending);
    return pending;
  };
  // One CLI operation at a time: a generation or an auth change. `busy` is always
  // cleared in a finally block, so a failed or cancelled job cannot block the next one.
  let busy = null;
  let authOperation = null; // Public snapshot of the latest sign-in attempt.
  const tasks = new Set();
  const track = promise => { tasks.add(promise); promise.finally(() => tasks.delete(promise)).catch(() => {}); return promise; };
  const authStates = new Map(); // Last read per provider, shown while another CLI job runs.
  const invalidate = provider => { catalogs.delete(provider); authStates.delete(provider); };
  const claim = async (kind, provider) => {
    // A just-cancelled generation may still be stopping its CLI. Wait briefly for it.
    if (busy?.controller.signal.aborted) await Promise.race([busy.done, new Promise(resolve => setTimeout(resolve, 5000).unref())]);
    if (busy) {
      throw Object.assign(new ProviderError(busy.kind === 'auth' ? 'A sign-in change is in progress. Finish or cancel it first.' : 'A prompt is already in progress. Wait or cancel that prompt.', busy.kind === 'auth' ? 'AUTH_IN_PROGRESS' : 'BUSY'), { status: 409 });
    }
    let release;
    const done = new Promise(resolve => { release = resolve; });
    busy = { kind, provider, stage: 'starting', startedAt: Date.now(), controller: new AbortController(), done };
    const job = busy;
    return { job, release: () => { if (busy === job) busy = null; release(); } };
  };
  let closing = false;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (closing) { res.setHeader('Connection', 'close'); return send(res, 503, { error: 'The app is shutting down.', code: 'SHUTTING_DOWN' }); }
    const actualPort = server.address()?.port;
    const allowedHosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
    const allowedOrigins = allowedHosts.map(host => `http://${host}`);
    if (!allowedHosts.includes(req.headers.host)) return send(res, 403, { error: 'This server accepts local requests only.' });
    if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) return send(res, 403, { error: 'This origin is not allowed.' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: 'Cross-site requests are not allowed.' });
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = requestUrl.pathname;
    const isApi = pathname.startsWith('/api/') && pathname !== '/api/session' && pathname !== '/api/providers';
    if (isApi && req.headers['x-ste-token'] !== token) return send(res, 403, { error: 'Reload this page before you try again.' });
    if (req.method === 'GET' && pathname === '/api/session') return send(res, 200, { token });
    if (req.method === 'GET' && pathname === '/api/providers') {
      try { return send(res, 200, { providers: await detector() }); }
      catch { return send(res, 500, { error: 'Cannot check the installed CLIs. Restart this app from your terminal.' }); }
    }
    if (req.method === 'GET' && pathname === '/api/status') {
      return send(res, 200, { busy: busy ? { kind: busy.kind, provider: busy.provider, stage: busy.stage, elapsedMs: Date.now() - busy.startedAt } : null, auth: authOperation });
    }
    if (req.method === 'GET' && pathname === '/api/models') {
      try { return send(res, 200, await getCatalog(requestUrl.searchParams.get('provider'), { refresh: requestUrl.searchParams.get('refresh') === '1' })); }
      catch (error) { return send(res, error.status || 502, { error: error.status === 400 ? error.message : 'Cannot read CLI models. Check sign-in and update your CLI.' }); }
    }
    if (req.method === 'GET' && pathname === '/api/auth') {
      const provider = requestUrl.searchParams.get('provider');
      if (!Object.hasOwn(AUTH_CAPABILITIES, provider)) return send(res, 400, { error: 'Choose a valid provider.', code: 'INVALID_PROVIDER' });
      const installed = await authAdapter.installed(provider);
      let status = { state: 'unknown' };
      // Status reads also start CLI processes; do not overlap them with a running job.
      if (installed && busy) status = { ...(authStates.get(provider) || status), stale: true };
      else if (installed) {
        try { status = await track(authAdapter.status(provider, { signal: catalogAbort.signal })); authStates.set(provider, status); } catch { status = { state: 'unknown' }; }
      }
      return send(res, 200, { provider, installed, ...status, capabilities: AUTH_CAPABILITIES[provider], operation: authOperation?.provider === provider ? authOperation : null });
    }
    if (req.method === 'POST' && pathname === '/api/auth/login') {
      let claimed;
      try {
        const body = await jsonBody(req);
        if (!Object.hasOwn(AUTH_CAPABILITIES, body?.provider) || !['browser', 'device'].includes(body?.method ?? 'browser')) throw Object.assign(new Error('Choose a valid provider and sign-in method.'), { status: 400, code: 'INVALID_REQUEST' });
        claimed = await claim('auth', body.provider);
        const { job, release } = claimed;
        job.stage = 'sign-in';
        const id = randomBytes(8).toString('hex');
        authOperation = { id, provider: body.provider, method: body.method ?? 'browser', state: 'starting' };
        let ready;
        const readySignal = new Promise(resolve => { ready = resolve; });
        const run = track(authAdapter.login(body.provider, { method: body.method ?? 'browser', signal: job.controller.signal,
          onUpdate: update => { if (authOperation?.id === id) authOperation = { ...authOperation, ...update, state: 'waiting' }; ready(); } }))
          .then(() => { if (authOperation?.id === id) authOperation = { id, provider: body.provider, method: authOperation.method, state: 'succeeded' }; },
            error => { if (authOperation?.id === id) authOperation = { id, provider: body.provider, method: authOperation.method, state: job.controller.signal.aborted ? 'cancelled' : 'failed', code: ['TIMEOUT', 'UNSUPPORTED', 'NOT_INSTALLED'].includes(error?.code) ? error.code : 'AUTH_FAILED' }; })
          .finally(() => { invalidate(body.provider); release(); ready(); });
        claimed = null;
        await Promise.race([readySignal, run]);
        const status = authOperation?.code === 'UNSUPPORTED' ? 400 : authOperation?.state === 'failed' ? 502 : 202;
        return send(res, status, { operation: authOperation });
      } catch (error) {
        claimed?.release();
        const { status, body } = failureBody(error, 'Could not start sign-in.');
        return send(res, status, body);
      }
    }
    if (req.method === 'POST' && pathname === '/api/auth/cancel') {
      try { await jsonBody(req); } catch (error) { return send(res, error.status || 400, { error: error.message }); }
      if (busy?.kind === 'auth') busy.controller.abort();
      return send(res, 200, { operation: authOperation });
    }
    if (req.method === 'POST' && pathname === '/api/auth/logout') {
      let claimed;
      try {
        const body = await jsonBody(req);
        if (!Object.hasOwn(AUTH_CAPABILITIES, body?.provider)) throw Object.assign(new Error('Choose a valid provider.'), { status: 400, code: 'INVALID_PROVIDER' });
        // Sign-out can affect every session that shares this CLI configuration.
        if (body.confirm !== true) throw Object.assign(new Error('Confirm sign-out first.'), { status: 400, code: 'CONFIRMATION_REQUIRED' });
        claimed = await claim('auth', body.provider);
        claimed.job.stage = 'sign-out';
        const result = await track(authAdapter.logout(body.provider, { signal: claimed.job.controller.signal }));
        invalidate(body.provider);
        return send(res, 200, { provider: body.provider, ...result });
      } catch (error) {
        const { status, body } = failureBody(error, 'The CLI could not sign out. Run its sign-out command in your terminal.');
        return send(res, status, body);
      } finally { claimed?.release(); }
    }
    if (req.method === 'POST' && pathname === '/api/generate') {
      let claimed;
      const abort = () => { if (!res.writableEnded) claimed?.job.controller.abort(); };
      res.once('close', abort);
      try {
        claimed = await claim('generate', null);
        const { job } = claimed;
        const body = await jsonBody(req);
        let value;
        try { value = validateRequest(body); }
        catch (error) { throw Object.assign(error, { status: 400 }); }
        job.provider = value.provider;
        const result = await track(generate(value, { runner, signal: job.controller.signal, catalogReader: provider => getCatalog(provider),
          onStage: stage => { job.stage = stage; } }));
        send(res, 200, result);
      } catch (error) {
        // CLI stderr can contain provider diagnostics. Never include it in HTTP responses.
        const { status, body } = failureBody(error, FAILURE_MESSAGES.CLI_FAILED);
        send(res, status, body);
      } finally {
        res.off('close', abort);
        claimed?.release();
      }
      return;
    }
    if (req.method === 'GET' && assets.has(pathname)) {
      const [name, mime] = assets.get(pathname);
      try { const file = await readFile(join(publicDir, name)); res.writeHead(200, { 'Content-Type': mime }); res.end(file); }
      catch { send(res, 404, { error: 'The file is not available.' }); }
      return;
    }
    send(res, 404, { error: 'This route does not exist.' });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 2_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  let closed;
  // Idempotent and bounded: stop accepting, cancel owned work, close sockets, then
  // SIGKILL any owned CLI process group that is still alive.
  const close = ({ graceMs = 4000 } = {}) => closed ??= (async () => {
    closing = true;
    const listening = new Promise(resolve => server.close(() => resolve()));
    busy?.controller.abort();
    catalogAbort.abort();
    server.closeIdleConnections();
    const settle = Promise.allSettled([...tasks, ...lookups.values(), busy?.done].filter(Boolean));
    await Promise.race([settle, new Promise(resolve => setTimeout(resolve, graceMs).unref())]);
    killOwnedProcesses('SIGKILL');
    server.closeAllConnections();
    await listening;
  })();
  return { server, url: `http://127.0.0.1:${server.address().port}`, close };
}
