import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRequest } from './engine.mjs';
import { runPipeline } from './pipeline.mjs';
import { detectProviders, runProvider, validateEffort } from './providers.mjs';
import { discoverModels, checkModelEffort } from './models.mjs';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/nerd.png', ['nerd.png', 'image/png']],
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
    if (size > 128_000) throw Object.assign(new Error('The request is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('The request is not valid JSON.'), { status: 400 }); }
}

export async function generate(request, { runner = runProvider, signal, catalogReader = discoverModels } = {}) {
  const value = validateRequest(request);
  try { validateEffort(value.provider, value.effort); } catch (error) { throw Object.assign(error, { status: 400 }); }
  if (value.effort) checkModelEffort(value.provider, value.model, value.effort, await catalogReader(value.provider, { signal }));
  return runPipeline(value, { runner, signal });
}

export async function startServer({ port = 4318, runner = runProvider, detector = detectProviders, catalogReader = discoverModels } = {}) {
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
  let active = null;
  let generationPending = false;
  let pendingDone = Promise.resolve();
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const actualPort = server.address()?.port;
    const allowedHosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
    const allowedOrigins = allowedHosts.map(host => `http://${host}`);
    if (!allowedHosts.includes(req.headers.host)) return send(res, 403, { error: 'This server accepts local requests only.' });
    if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) return send(res, 403, { error: 'This origin is not allowed.' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: 'Cross-site requests are not allowed.' });
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = requestUrl.pathname;
    if (req.method === 'GET' && pathname === '/api/session') return send(res, 200, { token });
    if (req.method === 'GET' && pathname === '/api/providers') {
      try { return send(res, 200, { providers: await detector() }); }
      catch { return send(res, 500, { error: 'Cannot check the installed CLIs. Restart this app from your terminal.' }); }
    }
    if (req.method === 'GET' && pathname === '/api/models') {
      if (req.headers['x-ste-token'] !== token) return send(res, 403, { error: 'Reload this page before you try again.' });
      try { return send(res, 200, await getCatalog(requestUrl.searchParams.get('provider'), { refresh: requestUrl.searchParams.get('refresh') === '1' })); }
      catch (error) { return send(res, error.status || 502, { error: error.status === 400 ? error.message : 'Cannot read CLI models. Check sign-in and update your CLI.' }); }
    }
    if (req.method === 'POST' && pathname === '/api/generate') {
      if (req.headers['x-ste-token'] !== token) return send(res, 403, { error: 'Reload this page before you try again.' });
      if (generationPending) return send(res, 429, { error: 'A prompt is already in progress. Wait or cancel that prompt.' });
      generationPending = true;
      let finishPending;
      pendingDone = new Promise(resolve => { finishPending = resolve; });
      const controller = new AbortController();
      active = controller;
      const abort = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', abort);
      try {
        const body = await jsonBody(req);
        let value;
        try { value = validateRequest(body); }
        catch (error) { throw Object.assign(error, { status: 400 }); }
        const result = await generate(value, { runner, signal: controller.signal, catalogReader: getCatalog });
        send(res, 200, result);
      } catch (error) {
        // CLI stderr can contain provider diagnostics. Never include it in HTTP responses.
        const status = error.status || (error.name === 'AbortError' ? 499 : 502);
        const message = status < 500 ? error.message : 'The CLI could not create the prompt. Check CLI sign-in, model access, quota, and policy settings. See docs/cli-adapters.md.';
        send(res, status, { error: message });
      } finally {
        res.off('close', abort);
        active = null;
        generationPending = false;
        finishPending();
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
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}`, close: async () => {
    active?.abort();
    catalogAbort.abort();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await pendingDone;
    await Promise.allSettled([...lookups.values()]);
  } };
}
