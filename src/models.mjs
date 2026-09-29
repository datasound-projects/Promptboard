/** Query installed CLI metadata. No user prompt or inference turn is sent. */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildCommand, closedWithin, execute, makeTempDir, removeTempDir, resolveExecutable, spawnOwned, stopProcess, validateEffort, ProviderError } from './providers.mjs';
import { VERSION } from './version.mjs';

const IDS = ['codex', 'claude', 'gemini', 'agy'];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/@+\[\]-]{0,99}$/;
const text = (value, max = 160) => typeof value === 'string' ? value.slice(0, max) : '';
const levels = values => Array.isArray(values) ? [...new Set(values.filter(x => ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(x)))] : [];

export function normalizeModels(provider, rows) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  return rows.slice(0, 500).flatMap(row => {
    const id = row?.model || row?.value || row?.modelId || row?.id;
    if (typeof id !== 'string' || !SAFE_ID.test(id) || row.hidden || seen.has(id)) return [];
    seen.add(id);
    let efforts = levels(provider === 'codex' ? row.supportedReasoningEfforts?.map(e => e.reasoningEffort) : row.supportedEffortLevels);
    if (provider === 'agy') efforts = ['low', 'medium', 'high'];
    if (provider === 'gemini' || row.supportsEffort === false) efforts = [];
    return [{ id, name: text(row.displayName || row.name || id), resolvedModel: text(row.resolvedModel, 100), efforts,
      defaultEffort: text(row.defaultReasoningEffort || row.defaultEffort, 20), isDefault: row.isDefault === true }];
  });
}

export function parseAgyModels(stdout) {
  // `agy models` is a documented two-column plain-text list, not a JSON API.
  const clean = stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  return normalizeModels('agy', clean.split(/\r?\n/).flatMap(line => {
    const match = line.trim().match(/^([A-Za-z0-9][A-Za-z0-9_.:/@+-]*-[A-Za-z0-9_.:/@+-]+)\s{2,}(.+)$/);
    return match ? [{ id: match[1], name: match[2] }] : [];
  }));
}

/** Bounded JSON-lines transaction. Closing it terminates the process group. */
export async function metadataSession(executable, args, cwd, transact, { signal, timeoutMs = 12000, onNotification } = {}) {
  if (signal?.aborted) throw new ProviderError('Model lookup cancelled.', 'ABORTED');
  const child = spawnOwned(executable.command, [...executable.prefix, ...args], { cwd });
  let buffer = '', size = 0, nextId = 0, closed = false, failure;
  const pending = new Map();
  let rejectFailed;
  // Rejects when the session fails for any reason, so long waits (such as sign-in) end too.
  const failed = new Promise((_, reject) => { rejectFailed = reject; });
  failed.catch(() => {});
  const fail = error => { if (!failure) { failure = error; rejectFailed(error); } for (const { reject } of pending.values()) reject(error); pending.clear(); stopProcess(child, 'SIGKILL'); };
  const timer = setTimeout(() => fail(new ProviderError('Model lookup timed out.', 'TIMEOUT')), timeoutMs);
  const abort = () => fail(new ProviderError('Model lookup cancelled.', 'ABORTED'));
  signal?.addEventListener('abort', abort, { once: true });
  child.once('close', () => { closed = true; fail(new ProviderError('Model metadata is unavailable.', 'CATALOG_FAILED')); });
  const ended = closedWithin(child);
  child.on('error', () => fail(new ProviderError('Could not start model lookup.', 'CATALOG_FAILED')));
  child.stdin.on('error', () => fail(new ProviderError('Model lookup input failed.', 'CATALOG_FAILED')));
  const send = message => { if (failure) throw failure; child.stdin.write(JSON.stringify(message) + '\n'); };
  child.stderr.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) fail(new ProviderError('Model metadata is too large.', 'OUTPUT_LIMIT')); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    size += Buffer.byteLength(chunk);
    if (size > 1024 * 1024) { fail(new ProviderError('Model metadata is too large.', 'OUTPUT_LIMIT')); return; }
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let event; try { event = JSON.parse(line); } catch { continue; }
      const control = event.type === 'control_response' ? event.response : null;
      const id = control?.request_id ?? event.id;
      const waiter = pending.get(id);
      if (waiter) {
        pending.delete(id);
        if (event.error || control?.subtype === 'error') waiter.reject(new ProviderError('The CLI rejected model discovery.', 'CATALOG_FAILED'));
        else waiter.resolve(control ? control.response : event.result);
      } else if (event.method && event.id !== undefined) {
        // Do not grant filesystem, tool, authentication, or permission requests.
        try { send({ jsonrpc: '2.0', id: event.id, error: { code: -32601, message: 'This client only reads model metadata.' } }); } catch {}
      } else if (event.method && event.id === undefined) {
        try { onNotification?.(event.method, event.params); } catch {}
      } else if (event.type === 'control_request') {
        try { send({ type: 'control_response', response: { subtype: 'error', request_id: event.request_id, error: 'No tools are allowed during model discovery.' } }); } catch {}
      }
    }
  });
  const request = (method, params, control = false) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = control ? `ste-${++nextId}` : ++nextId;
    pending.set(id, { resolve, reject });
    try { send(control ? { type: 'control_request', request_id: id, request: { subtype: method, ...params } } : { jsonrpc: '2.0', id, method, params }); }
    catch (error) { pending.delete(id); reject(error); }
  });
  try {
    if (signal?.aborted) abort();
    return await transact({ request, send, failed });
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    if (!closed) { child.stdin.end(); stopProcess(child, 'SIGKILL'); }
    await ended;
  }
}

export async function discoverModels(provider, { signal } = {}) {
  if (!IDS.includes(provider)) throw new ProviderError('Choose a valid provider.', 'INVALID_PROVIDER');
  const fallback = { provider, source: 'unavailable', models: [], defaultModel: '', defaultEffort: '',
    note: 'Could not read models from this CLI. Check sign-in, update the CLI, then refresh. You can use its default or enter a custom model ID.' };
  const executable = await resolveExecutable(provider);
  if (!executable) return { ...fallback, note: 'Install and sign in to this CLI, then refresh the model list.' };
  const cwd = await makeTempDir('ste-models-');
  try {
    let models = [], defaultModel = '', defaultEffort = '';
    if (provider === 'agy') {
      const result = await execute({ command: executable.command, args: [...executable.prefix, 'models'], cwd, signal, timeoutMs: 12000, maxStdout: 128000 });
      models = parseAgyModels(result.stdout);
    } else if (provider === 'codex') {
      await metadataSession(executable, ['app-server'], cwd, async ({ request, send }) => {
        await request('initialize', { clientInfo: { name: 'promptboard', version: VERSION } });
        send({ method: 'initialized', params: {} });
        let cursor;
        const seen = new Set();
        do {
          const page = await request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
          models.push(...normalizeModels(provider, page?.data));
          cursor = page?.nextCursor;
          if (cursor && seen.has(cursor)) throw new Error('Repeated cursor');
          seen.add(cursor);
        } while (cursor && models.length < 500);
        try {
          const result = await request('config/read', { includeLayers: false });
          defaultModel = text(result?.config?.model, 100);
          defaultEffort = text(result?.config?.model_reasoning_effort, 20);
        } catch { /* Older CLIs can still provide a useful model list. */ }
      }, { signal });
      defaultModel ||= models.find(m => m.isDefault)?.id || '';
    } else if (provider === 'claude') {
      const { args } = buildCommand({ provider });
      args[args.indexOf('--output-format') + 1] = 'stream-json';
      args.push('--input-format', 'stream-json');
      const result = await metadataSession(executable, args, cwd, ({ request }) => request('initialize', { hooks: null }, true), { signal });
      models = normalizeModels(provider, result?.models);
      defaultModel = text(result?.model, 100);
    } else {
      const policyPath = join(cwd, 'deny.toml');
      await writeFile(policyPath, '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n');
      const { args } = buildCommand({ provider, policyPath });
      args.splice(args.indexOf('--output-format'), 2);
      args.push('--experimental-acp');
      const result = await metadataSession(executable, args, cwd, async ({ request }) => {
        await request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'promptboard', version: VERSION } });
        return request('session/new', { cwd, mcpServers: [] });
      }, { signal });
      models = normalizeModels(provider, result?.models?.availableModels);
      defaultModel = text(result?.models?.currentModelId, 100);
    }
    if (!models.length) return fallback;
    defaultEffort ||= models.find(m => m.id === defaultModel)?.defaultEffort || '';
    return { provider, source: 'cli', models, defaultModel, defaultEffort,
      note: provider === 'gemini' ? 'Models reported by Gemini CLI. This CLI adapter has no per-run effort switch; it keeps your CLI thinking settings.' : 'Models reported by your installed CLI. Access and limits depend on your account. Custom IDs are also supported.' };
  } catch (error) {
    if (signal?.aborted) throw error;
    return fallback;
  } finally { await removeTempDir(cwd); }
}

export function checkModelEffort(provider, model, effort, catalog) {
  try { validateEffort(provider, effort); } catch (error) { throw Object.assign(error, { status: 400 }); }
  if (!effort) return;
  const selected = catalog?.models?.find(m => m.id === (model || catalog.defaultModel));
  if (selected && !selected.efforts.includes(effort)) {
    throw Object.assign(new ProviderError('This model does not report support for that effort. Refresh models and choose an available level.', 'INVALID_EFFORT'), { status: 400 });
  }
}
