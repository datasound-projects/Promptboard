/** Owner-initiated MCP credentials. Private local storage is separate from portable Base definitions. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { lstat, mkdir, open, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { auth } from '@modelcontextprotocol/client';
import { writeAtomic } from './durable.mjs';
import { isPublicAddress } from './base-context.mjs';

const fail = (message, code = 'BASE_AUTH_REQUIRED', status = 409) => { throw Object.assign(new Error(message), { code, status }); };
const digest = value => createHash('sha256').update(value).digest('hex');
const binding = definition => digest(JSON.stringify([definition.configuration?.transport, definition.configuration?.endpoint, definition.configuration?.command, definition.configuration?.args, definition.configuration?.auth, definition.configuration?.env, definition.configuration?.headers]));
const validId = id => { if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) fail('Invalid MCP connection.', 'BASE_INVALID_INPUT', 400); return id; };
const declared = definition => [...new Set([...Object.values(definition.configuration?.env || {}), ...Object.values(definition.configuration?.headers || {})])];

/** OAuth discovery may contact public identity providers, or the explicitly selected MCP origin. Never follows redirects. */
export function mcpOAuthFetch(endpoint, { lookupFn = lookup } = {}) {
  const selected = new URL(endpoint);
  return async (target, options = {}) => {
    const url = new URL(typeof target === 'string' || target instanceof URL ? target : target.url);
    if (url.username || url.password || url.hash || url.href.length > 8192 || !['https:', 'http:'].includes(url.protocol)
      || url.protocol === 'http:' && url.origin !== selected.origin) fail('The OAuth provider uses an unsafe address.', 'BASE_AUTH_ADDRESS', 400);
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(15000)].filter(Boolean));
    signal.throwIfAborted();
    let timer;
    const addresses = await Promise.race([lookupFn(url.hostname.replace(/^\[|\]$/g, ''), { all: true, verbatim: true }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS timeout')), 5000); timer.unref(); })]).finally(() => clearTimeout(timer));
    signal.throwIfAborted();
    if (!addresses.length || url.origin !== selected.origin && addresses.some(a => !isPublicAddress(a.address))) fail('The OAuth provider resolved to a private address.', 'BASE_AUTH_ADDRESS', 400);
    const address = addresses[0], body = options.body == null ? null : String(options.body);
    if (body && Buffer.byteLength(body) > 256000) fail('OAuth request is too large.', 'BASE_AUTH_LIMIT', 400);
    return new Promise((resolve, reject) => {
      const headers = Object.fromEntries(new Headers(options.headers)); delete headers.host; delete headers.cookie; delete headers['proxy-authorization'];
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: options.method || 'GET', signal, headers, agent: false,
        lookup: (_host, opts, cb) => opts?.all ? cb(null, [address]) : cb(null, address.address, address.family) }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400) { res.destroy(); reject(new Error('OAuth redirects are refused')); return; }
        const chunks = []; let size = 0;
        res.on('data', chunk => { size += chunk.length; if (size > 256000) { reject(new Error('OAuth answer too large')); res.destroy(); } else chunks.push(chunk); });
        res.on('aborted', () => reject(new Error('OAuth response interrupted')));
        res.on('error', reject); res.on('end', () => resolve(new Response([204, 205, 304].includes(res.statusCode) ? null : Buffer.concat(chunks), { status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).filter(([, v]) => v !== undefined).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v])) })));
      }); req.on('error', reject); req.end(body);
    });
  };
}

export class McpConnections {
  constructor({ dataDir, readResource, fetchFactory = mcpOAuthFetch }) { this.dir = join(dataDir, 'base-connections'); this.readResource = readResource; this.fetchFactory = fetchFactory; this.pending = new Map(); this.epochs = new Map(); this.writes = new Map(); this.refreshes = new Map(); }
  epoch(id) { return this.epochs.get(id) || 0; }
  async serialized(id, work) {
    const previous = this.writes.get(id) || Promise.resolve(), next = previous.catch(() => {}).then(work);
    this.writes.set(id, next);
    try { return await next; } finally { if (this.writes.get(id) === next) this.writes.delete(id); }
  }
  path(id) { return join(this.dir, `${validId(id)}.json`); }
  async read(definition) {
    let handle;
    try {
      const path = this.path(definition.id), before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 1024 * 1024) fail('The private connection record is invalid.', 'BASE_AUTH_STORAGE');
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
      const stat = await handle.stat(), current = await lstat(path);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024 || current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino || before.dev !== stat.dev || before.ino !== stat.ino) fail('The private connection record is invalid.', 'BASE_AUTH_STORAGE');
      const value = JSON.parse(await handle.readFile('utf8'));
      return value.binding === binding(definition) ? value : { binding: binding(definition), values: {} };
    } catch (error) { if (error.code === 'ENOENT') return { binding: binding(definition), values: {} }; fail('The private connection record could not be read. Disconnect it and configure authentication again.', 'BASE_AUTH_STORAGE'); }
    finally { await handle?.close(); }
  }
  async save(definition, record, epoch = this.epoch(definition.id)) {
    const bytes = JSON.stringify({ ...record, binding: binding(definition) }); if (bytes.length > 1024 * 1024) fail('The private connection record is too large.', 'BASE_AUTH_STORAGE');
    return this.serialized(definition.id, async () => {
      const current = await this.readResource(definition.id);
      if (epoch !== this.epoch(definition.id) || binding(current) !== binding(definition) || current.trust !== 'trusted') fail('The MCP connection changed. Review it again.', 'BASE_AUTH_CHANGED');
      await mkdir(this.dir, { recursive: true, mode: 0o700 }); await writeAtomic(this.path(definition.id), bytes, { backup: false });
    });
  }
  async definition(id) { const d = await this.readResource(validId(id)); if (d.kind !== 'mcp' || d.trust !== 'trusted') fail('Review and trust this MCP connection first.', 'BASE_TRUST_REQUIRED'); return d; }
  async status(id) {
    const d = await this.readResource(validId(id)), record = await this.read(d), pending = this.pending.get(id);
    if (d.kind !== 'mcp') fail('Choose an MCP connection.', 'BASE_INVALID_INPUT', 400);
    return { mode: d.configuration?.auth?.mode || 'environment', pending: Boolean(pending), expiresAt: record.expiresAt || null,
      signedIn: Boolean(record.tokens?.access_token && (!record.expiresAt || record.expiresAt > Date.now())),
      references: declared(d).map(name => ({ name, ready: Boolean(Object.hasOwn(record.values || {}, name) && record.values[name] || Object.hasOwn(process.env, name) && process.env[name]) })), ...(record.lastError ? { error: record.lastError } : {}) };
  }
  async credentials(id, values, expectedRevision) {
    const d = await this.definition(id); if (d.revision !== expectedRevision) fail('The connection changed. Reload it.', 'RESOURCE_REVISION_CONFLICT');
    const names = new Set([...declared(d), ...(d.configuration.auth?.mode === 'oauth' ? ['oauth_client_secret'] : [])]);
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length > 40) fail('Invalid credentials.', 'BASE_INVALID_INPUT', 400);
    this.cancel(id); const epoch = this.epoch(id), record = await this.read(d);
    record.values = Object.assign(Object.create(null), record.values || {});
    for (const [name, value] of Object.entries(values)) {
      if (!names.has(name) || typeof value !== 'string' || value.length > 16384 || /[\0\r\n]/.test(value)) fail('Invalid credential field.', 'BASE_INVALID_INPUT', 400);
      if (value) (record.values ||= {})[name] = value; else delete record.values?.[name];
    }
    if (d.configuration.auth?.mode === 'oauth' && Object.hasOwn(values, 'oauth_client_secret')) { delete record.tokens; delete record.expiresAt; delete record.client; }
    await this.save(d, record, epoch); return this.status(id);
  }
  provider(d, record, flow) {
    const epoch = flow.epoch ?? this.epoch(d.id), persist = () => this.save(d, record, epoch), clientId = d.configuration.auth?.clientId, secret = record.values?.oauth_client_secret;
    return {
      redirectUrl: flow.redirectUrl || record.redirectUrl,
      clientMetadata: { client_name: 'Promptboard', redirect_uris: [flow.redirectUrl || record.redirectUrl], response_types: ['code'], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: secret ? 'client_secret_post' : 'none' },
      state: () => flow.state,
      clientInformation: () => clientId ? { ...(record.client?.client_id === clientId ? record.client : {}), client_id: clientId, ...(secret ? { client_secret: secret } : {}) } : record.client,
      saveClientInformation: async value => { record.client = value; await persist(); },
      tokens: () => record.tokens,
      saveTokens: async value => {
        if (String(value.token_type).toLowerCase() !== 'bearer') fail('This connection requires a bearer-token OAuth provider.', 'BASE_AUTH_UNSUPPORTED');
        if ([value.access_token, ...(value.refresh_token === undefined ? [] : [value.refresh_token])].some(token => typeof token !== 'string' || !token || token.length > 16384 || /[\0\r\n]/.test(token)) || value.expires_in !== undefined && (!Number.isFinite(value.expires_in) || value.expires_in < 0)) fail('The provider returned invalid OAuth credentials.', 'BASE_AUTH_UNSUPPORTED');
        record.tokens = value; record.expiresAt = value.expires_in === undefined ? null : Date.now() + value.expires_in * 1000; delete record.lastError; await persist();
      },
      redirectToAuthorization: value => { const u = new URL(value); if (u.protocol !== 'https:' && u.origin !== new URL(d.configuration.endpoint).origin || u.username || u.password) fail('The authorization link is unsafe.', 'BASE_AUTH_ADDRESS'); if (!flow.state) fail('Sign in again from Base → MCP.', 'BASE_AUTH_REQUIRED'); flow.url = u.href; },
      saveCodeVerifier: value => { flow.verifier = value; }, codeVerifier: () => flow.verifier,
      saveDiscoveryState: value => { flow.discovery = value; }, discoveryState: () => flow.discovery,
      invalidateCredentials: async scope => { if (['all', 'tokens'].includes(scope)) delete record.tokens; if (['all', 'client'].includes(scope)) delete record.client; await persist(); },
    };
  }
  async start(id, expectedRevision) {
    const d = await this.definition(id); if (d.revision !== expectedRevision) fail('The connection changed. Reload it.', 'RESOURCE_REVISION_CONFLICT');
    if (d.configuration.transport !== 'streamable-http' || d.configuration.auth?.mode !== 'oauth') fail('Choose browser sign-in for an HTTP MCP connection.', 'BASE_AUTH_UNSUPPORTED');
    this.cancel(id); if (this.pending.size >= 10) fail('Too many sign-in windows are open. Finish or cancel one first.', 'BASE_AUTH_BUSY');
    const epoch = this.epoch(id), flow = { epoch, state: randomBytes(32).toString('base64url'), used: false, controller: new AbortController() };
    this.pending.set(id, flow);
    const record = await this.read(d).catch(error => { if (this.pending.get(id) === flow) this.cancel(id); throw error; });
    // A new browser authorization uses a new ephemeral callback port. Dynamic clients must
    // register that callback, and an explicit sign-in must not silently reuse the previous account.
    delete record.tokens; delete record.expiresAt; delete record.lastError;
    if (!d.configuration.auth.clientId) delete record.client;
    await this.save(d, record, epoch).catch(error => { if (this.pending.get(id) === flow) this.cancel(id); throw error; });
    const request = (target, options = {}) => this.fetchFactory(d.configuration.endpoint)(target, { ...options, signal: AbortSignal.any([flow.controller.signal, options.signal].filter(Boolean)) });
    flow.server = createServer(async (req, res) => {
      const finish = (status, message) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'" }); res.end(message); };
      try {
        if (req.method !== 'GET' || req.headers.host !== new URL(flow.redirectUrl).host) { finish(400, 'Invalid callback.'); return; }
        const url = new URL(req.url, flow.redirectUrl), state = url.searchParams.get('state') || '';
        if (url.pathname !== '/callback' || flow.used || state.length !== flow.state.length || !timingSafeEqual(Buffer.from(state), Buffer.from(flow.state))) { finish(400, 'Invalid or expired sign-in.'); return; }
        flow.used = true;
        const current = await this.definition(id); if (current.revision !== d.revision) fail('The connection changed during sign-in.', 'BASE_AUTH_CHANGED');
        const code = url.searchParams.get('code'); if (!code || code.length > 4096 || url.searchParams.has('error')) fail('Authorization was declined.');
        await auth(flow.provider, { serverUrl: d.configuration.endpoint, authorizationCode: code, ...(url.searchParams.has('iss') ? { iss: url.searchParams.get('iss') } : {}), fetchFn: request });
        finish(200, 'Connected to Promptboard. You can close this tab and return to Base → MCP.');
      } catch { record.lastError = 'Sign-in could not be completed. Check the provider’s settings and try again.'; await this.save(d, record, epoch).catch(() => {}); finish(400, record.lastError); }
      finally { if (flow.used && this.pending.get(id) === flow) this.cancel(id); }
    });
    await new Promise((resolve, reject) => { flow.server.once('error', reject); flow.server.listen(0, '127.0.0.1', resolve); }).catch(error => { if (this.pending.get(id) === flow) this.cancel(id); throw error; });
    if (this.epoch(id) !== epoch) { flow.server.close(); fail('Sign-in was cancelled.', 'ABORTED'); }
    flow.redirectUrl = `http://127.0.0.1:${flow.server.address().port}/callback`; record.redirectUrl = flow.redirectUrl;
    flow.provider = this.provider(d, record, flow); flow.timer = setTimeout(() => { if (this.pending.get(id) === flow) this.cancel(id); }, 300000); flow.timer.unref();
    try {
      const result = await auth(flow.provider, { serverUrl: d.configuration.endpoint, fetchFn: request, forceReauthorization: true, ...(d.configuration.auth.scope ? { scope: d.configuration.auth.scope } : {}) });
      if (result === 'AUTHORIZED') { this.cancel(id); return { connected: true }; }
      if (!flow.url) fail('This provider did not supply a sign-in link.');
      return { url: flow.url, expiresAt: Date.now() + 300000, redirectUrl: flow.redirectUrl };
    } catch { if (this.pending.get(id) === flow) this.cancel(id); fail('Sign-in could not start. This provider may require a registered Client ID. Check its OAuth configuration.', 'BASE_AUTH_SETUP'); }
  }
  cancel(id) { validId(id); this.epochs.set(id, this.epoch(id) + 1); this.refreshes.get(id)?.controller.abort(); const flow = this.pending.get(id); if (flow) { clearTimeout(flow.timer); flow.controller.abort(); flow.server?.close(); flow.server?.closeIdleConnections?.(); this.pending.delete(id); } }
  async disconnect(id) { validId(id); this.cancel(id); await this.serialized(id, () => rm(this.path(id), { force: true })); }
  async delivery(definition) {
    const d = definition, epoch = this.epoch(d.id), cfg = structuredClone(d.configuration); let record = await this.read(d);
    const env = Object.assign(Object.create(null), process.env, record.values || {});
    if (cfg.auth?.mode === 'oauth') delete env.oauth_client_secret;
    if (cfg.auth?.mode === 'oauth') {
      if (!record.tokens || record.expiresAt && record.expiresAt <= Date.now() + 30000) {
        if (!record.tokens?.refresh_token) fail('Sign in to this MCP server in Base → MCP.');
        let refresh = this.refreshes.get(d.id);
        if (!refresh) {
          refresh = { controller: new AbortController() }; this.refreshes.set(d.id, refresh);
          const request = (target, options = {}) => this.fetchFactory(cfg.endpoint)(target, { ...options, signal: AbortSignal.any([refresh.controller.signal, options.signal].filter(Boolean)) });
          refresh.promise = Promise.resolve().then(async () => {
            const latest = await this.read(d);
            if (epoch !== this.epoch(d.id)) fail('MCP authentication changed.', 'BASE_AUTH_CHANGED');
            if (latest.tokens?.access_token && (!latest.expiresAt || latest.expiresAt > Date.now() + 30000)) return 'AUTHORIZED';
            return auth(this.provider(d, latest, { epoch }), { serverUrl: cfg.endpoint, fetchFn: request });
          })
            .finally(() => { if (this.refreshes.get(d.id) === refresh) this.refreshes.delete(d.id); });
        }
        try { await refresh.promise; record = await this.read(d); } catch { fail('The MCP session expired. Sign in again in Base → MCP.'); }
      }
      if (!record.tokens?.access_token) fail('Sign in to this MCP server in Base → MCP.');
      const reference = `PB_MCP_${digest(d.id).slice(0, 16).toUpperCase()}_AUTHORIZATION`;
      cfg.headers = Object.fromEntries(Object.entries(cfg.headers || {}).filter(([name]) => name.toLowerCase() !== 'authorization'));
      cfg.headers.Authorization = reference; env[reference] = `Bearer ${record.tokens.access_token}`;
    }
    // HTTP credentials with identical reference names belong to separate connections. Never let
    // one attachment overwrite another attachment's private value in a shared CLI environment.
    for (const [name, reference] of Object.entries(cfg.headers || {})) {
      const alias = `PB_MCP_${digest(`${d.id}:${name}`).slice(0, 24).toUpperCase()}`;
      if (env[reference] !== undefined) { env[alias] = env[reference]; cfg.headers[name] = alias; }
    }
    if (epoch !== this.epoch(d.id)) fail('MCP authentication changed during preparation. Try again.', 'BASE_AUTH_CHANGED');
    return { definition: { ...d, configuration: cfg }, environment: env };
  }
  close() { for (const id of new Set([...this.pending.keys(), ...this.refreshes.keys()])) this.cancel(id); }
}
