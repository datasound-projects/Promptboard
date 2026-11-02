// Remote access: the same Promptboard, opened from a paired phone through Tailscale Serve or a Twingate Resource.
// It is off by default and the local app on 127.0.0.1 never changes. Remote requests arrive on a second listener
// that requires a paired device for every request: a one-time pairing code shown on the computer gives the phone
// an HttpOnly session cookie, stored here only as a hash and revocable at any time. Agents, CLIs, Git and every
// task keep running on this computer; a phone that sleeps or loses its connection stops nothing.
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { readWithBackup, serial, setAside, writeAtomic } from './durable.mjs';
import { commandOnPath } from './providers.mjs';

export const REMOTE_METHODS = ['local', 'tailscale', 'twingate'];
export const REMOTE_LIMITS = Object.freeze({ sessions: 20, sessionDays: 30, pairMinutes: 10, attempts: 8, name: 60, host: 253 });
const FILE = 'remote-access.json', SCHEMA = 'promptboard.remote-access', VERSION = 1, COOKIE = 'pb_remote';
const DEFAULTS = Object.freeze({ method: 'local', port: 4319, bind: '127.0.0.1', host: '', cert: '', key: '' });
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No 0/O or 1/I: the code is read off one screen and typed on another.
const hash = text => createHash('sha256').update(String(text)).digest('hex');
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class RemoteError extends Error {
  constructor(message, code = 'REMOTE_INVALID', status = 400) { super(message); this.code = code; this.status = status; }
}
const invalid = (message, code) => new RemoteError(message, code);

/** Loopback, private (RFC 1918), CGNAT (Tailscale addresses) and unique-local IPv6 only: never a public or wildcard address. */
export function privateAddress(address) {
  const kind = isIP(address);
  if (kind === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (kind === 6) { const lower = address.toLowerCase(); return lower === '::1' || /^f[cd][0-9a-f]{2}:/.test(lower); }
  return false;
}
const HOSTNAME = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** Checked settings. The method decides where the listener binds; a Twingate host is the name the phone opens. */
export function remoteSettings(input = {}, { localPort } = {}) {
  const value = { ...DEFAULTS, ...input };
  if (!REMOTE_METHODS.includes(value.method)) throw invalid('Choose Local only, Tailscale or Twingate.');
  if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || value.port === localPort) throw invalid('Choose a remote port from 1024 to 65535 that the local app does not use.');
  const bind = String(value.bind || '').trim();
  if (!privateAddress(bind)) throw invalid('Listen only on 127.0.0.1 or a private address of this computer (for example 192.168.x.x or 10.x.x.x). Public and wildcard addresses are refused.');
  if (isIP(bind) === 6) throw invalid('Use an IPv4 address of this computer (for example 192.168.x.x).');
  if (value.method === 'tailscale' && bind !== '127.0.0.1') throw invalid('Tailscale Serve reaches Promptboard on 127.0.0.1.');
  const host = String(value.host || '').trim().toLowerCase();
  if (host && !(HOSTNAME.test(host) || isIP(host))) throw invalid('Enter the private name or address the phone opens, without http:// or a port.');
  const cert = String(value.cert || '').trim(), key = String(value.key || '').trim();
  if (Boolean(cert) !== Boolean(key)) throw invalid('Give both the certificate and the key file for HTTPS, or neither.');
  if (value.method === 'tailscale' && (cert || key)) throw invalid('Tailscale Serve provides HTTPS itself; leave the certificate empty.');
  return { method: value.method, port: value.port, bind, host, cert, key };
}

/** The Tailscale CLI, read-only unless the person turns Serve on or off. Never touches Funnel. */
export const tailscaleCli = {
  async run(args, { timeoutMs = 8000 } = {}) {
    const command = await commandOnPath('tailscale') || (process.platform === 'darwin' ? '/Applications/Tailscale.app/Contents/MacOS/Tailscale' : '');
    if (!command) throw Object.assign(new Error('Tailscale is not installed.'), { missing: true });
    return new Promise((resolve, reject) => execFile(command, args, { shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => (error ? reject(Object.assign(error, { missing: error.code === 'ENOENT', stdout: String(stdout), stderr: String(stderr) })) : resolve(String(stdout)))));
  },
};

/**
 * What Tailscale reports for this computer and whether Serve forwards to Promptboard's remote port. The URL is the
 * one Tailscale reports, never built by hand. Funnel (public internet) is only detected, to warn; requests marked as
 * Funnel are refused by the listener anyway.
 */
export async function tailscaleState(port, cli = tailscaleCli) {
  let status;
  try { status = JSON.parse(await cli.run(['status', '--json'])); }
  catch (error) { return { installed: !error.missing, running: false, message: error.missing ? 'Tailscale is not installed on this computer.' : 'Tailscale did not answer. Open the Tailscale app.' }; }
  const name = String(status?.Self?.DNSName || '').replace(/\.$/, '').toLowerCase();
  const running = status?.BackendState === 'Running';
  const state = { installed: true, running, name, online: Boolean(status?.Self?.Online), message: running ? '' : 'Tailscale is not connected. Open the Tailscale app and connect.',
    https: Array.isArray(status?.CertDomains) && status.CertDomains.length > 0 }; // Serve needs HTTPS certificates for the tailnet.
  if (!running) return state;
  let serve = {};
  try { serve = JSON.parse(await cli.run(['serve', 'status', '--json']) || '{}') || {}; } catch {}
  const target = `http://127.0.0.1:${port}`;
  for (const [listener, config] of Object.entries(serve.Web || {})) {
    const proxy = Object.entries(config?.Handlers || {}).find(([path, handler]) => path === '/' && String(handler?.Proxy || '').replace(/\/$/, '') === target);
    if (!proxy) continue;
    const [hostName, listenPort] = listener.split(':');
    state.serving = true; state.servePort = Number(listenPort) || 443; state.url = `https://${hostName}${listenPort && listenPort !== '443' ? `:${listenPort}` : ''}`;
    state.funnel = Boolean(serve.AllowFunnel?.[listener]);
    // Browsers send cookies to every port of a host name: another service on this name would receive Promptboard's.
    state.shared = Object.keys(serve.Web || {}).some(other => other !== listener && other.split(':')[0] === hostName);
  }
  // Another service already answers at the root of 443: Promptboard then uses 8443; when both are taken it changes nothing.
  const taken = port => Object.entries(serve.Web || {}).some(([listener, config]) => listener.endsWith(`:${port}`) && config?.Handlers?.['/'] && String(config.Handlers['/'].Proxy || '').replace(/\/$/, '') !== target);
  state.httpsPort = !taken(443) ? 443 : !taken(8443) ? 8443 : null;
  // Off always names the port Promptboard is served on, which may not be the one it would choose today.
  if (state.serving) state.offCommand = `tailscale serve --bg --https=${state.servePort} ${target} off`;
  if (!state.httpsPort) { if (!state.serving) state.message = 'Tailscale Serve already uses ports 443 and 8443 for other services. Promptboard changes nothing; run tailscale serve yourself with another port.'; return state; }
  state.command = `tailscale serve --bg --https=${state.httpsPort} ${target}`;
  return state;
}

/** Remote access state, sessions and the remote listener. */
export class RemoteAccess {
  constructor({ dataDir, localPort, handle, cli = tailscaleCli, now = () => Date.now() }) {
    this.path = join(dataDir, FILE); this.localPort = localPort; this.handle = handle; this.cli = cli; this.now = now;
    this.settings = { ...DEFAULTS }; this.sessions = []; this.pairing = null; this.failures = []; this.server = null; this.error = '';
    this.queue = serial(); this.tailscale = null; this.lookup = null;
    this.changes = serial(); this.closed = false; // Listener changes run one at a time; none after shutdown.
    this.open = new Map(); // Session ID → its open responses (live streams), ended when the session is revoked.
  }
  async load() {
    const damaged = [], stored = await readWithBackup([this.path, `${this.path}.bak`], (bytes, file) => { try { const value = JSON.parse(bytes); if (value?.schema === SCHEMA) return value; } catch {} damaged.push(file); }).catch(() => null);
    await setAside(damaged).catch(() => {});
    try { this.settings = remoteSettings(stored?.settings || {}, { localPort: this.localPort }); } catch { this.settings = { ...DEFAULTS }; }
    const now = this.now();
    this.sessions = (Array.isArray(stored?.sessions) ? stored.sessions : []).filter(row => typeof row?.hash === 'string' && /^[a-f0-9]{64}$/.test(row.hash) && row.expiresAt > now).slice(-REMOTE_LIMITS.sessions);
    if (this.settings.method !== 'local') await this.changes(() => this.listen().catch(() => {}));
    return this;
  }
  #write() { return writeAtomic(this.path, JSON.stringify({ schema: SCHEMA, version: VERSION, settings: this.settings, sessions: this.sessions })); }
  #save() { return this.queue(() => this.#write()); }
  /** Changes settings or sessions one at a time; a change that cannot be saved is undone, so none comes back after a restart. */
  #commit(change) {
    return this.queue(async () => {
      const { settings, sessions } = this;
      if (change() === false) return;
      try { await this.#write(); }
      catch { this.settings = settings; this.sessions = sessions; throw new RemoteError('Remote access could not be saved. Check free disk space and folder permissions. Nothing was changed.', 'REMOTE_SAVE_FAILED', 500); }
    });
  }

  // ---- Settings and listener ----
  configure(input) {
    return this.changes(async () => {
      const next = remoteSettings({ ...this.settings, ...input }, { localPort: this.localPort });
      const changed = JSON.stringify(next) !== JSON.stringify(this.settings);
      await this.#commit(() => { this.settings = next; });
      // Saving again also retries a listener that could not start (a port that was busy).
      if (changed || (!this.server && next.method !== 'local')) { await this.close(); if (next.method !== 'local') await this.listen().catch(() => {}); }
      return this.status();
    });
  }
  /** At app shutdown: the listener closes after any change in progress, and none starts later. */
  shutdown() { this.closed = true; return this.changes(() => this.close()); }
  async listen() {
    if (this.closed) return;
    const { cert, key, port, bind } = this.settings;
    let server;
    try {
      server = cert ? https.createServer({ cert: await readFile(cert), key: await readFile(key) }) : http.createServer();
    } catch { this.error = 'The certificate or key file could not be read.'; throw new RemoteError(this.error, 'REMOTE_TLS'); }
    server.on('request', (req, res) => this.serve(req, res).catch(() => { if (res.headersSent) res.destroy(); else reply(res, 500, { error: 'The request failed. Nothing was changed.' }); }));
    server.requestTimeout = 30_000; server.headersTimeout = 15_000; server.keepAliveTimeout = 5_000;
    // Once listening, a server error (for example EMFILE on accept) is shown in Settings; unhandled, it would stop the whole app.
    const failed = error => { if (this.server === server) this.error = `The remote listener reported an error${/^[A-Z]+$/.test(error?.code || '') ? ` (${error.code})` : ''}. If the phone cannot connect, turn remote access off and on again.`; };
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, bind, () => { server.off('error', reject); server.on('error', failed); resolve(); }); })
      .catch(error => { this.error = error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Choose another remote port.` : error.code === 'EADDRNOTAVAIL' ? `${bind} is not an address of this computer.` : 'The remote listener could not start.'; throw new RemoteError(this.error, 'REMOTE_LISTEN', 409); });
    if (this.closed) { server.close(); return; }
    this.server = server; this.error = '';
  }
  async close() {
    const server = this.server; this.server = null; this.error = ''; // An earlier start failure is not shown once nothing should listen.
    if (!server) return;
    await new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections?.(); });
  }

  // ---- Pairing and sessions ----
  newPairing() {
    const code = Array.from(randomBytes(8), byte => ALPHABET[byte % ALPHABET.length]).join('');
    this.pairing = { hash: hash(code), expiresAt: this.now() + REMOTE_LIMITS.pairMinutes * 60000, attempts: 0 };
    return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt: this.pairing.expiresAt };
  }
  async pair(code, name = '') {
    const now = this.now();
    this.failures = this.failures.filter(at => now - at < 60000);
    if (this.failures.length >= 5) throw new RemoteError('Too many wrong codes. Wait a minute, then try again.', 'REMOTE_RATE_LIMITED', 429);
    const pairing = this.pairing, given = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!pairing || pairing.expiresAt <= now) { this.pairing = null; throw new RemoteError('There is no valid pairing code. Make a new one on the computer.', 'REMOTE_NO_PAIRING', 401); }
    if (!same(hash(given), pairing.hash)) {
      this.failures.push(now);
      if (++pairing.attempts >= REMOTE_LIMITS.attempts) this.pairing = null; // A code cannot be guessed by trying many times.
      throw new RemoteError('This code is not right. Check it on the computer.', 'REMOTE_WRONG_CODE', 401);
    }
    this.pairing = null; // One code pairs one device.
    const secret = randomBytes(32).toString('base64url');
    const session = { id: randomUUID(), hash: hash(secret), name: String(name || 'Phone').replace(/[\u0000-\u001f]/g, '').slice(0, REMOTE_LIMITS.name) || 'Phone',
      createdAt: now, lastSeenAt: now, expiresAt: now + REMOTE_LIMITS.sessionDays * 86400000 };
    let dropped = [];
    await this.#commit(() => { const all = [...this.sessions, session]; this.sessions = all.slice(-REMOTE_LIMITS.sessions); dropped = all.slice(0, -REMOTE_LIMITS.sessions); })
      .catch(error => { this.pairing ??= pairing; throw error; }); // Not paired: the same code can be tried again, unless a new one was made.
    for (const old of dropped) { for (const res of this.open.get(old.id) || []) res.destroy(); this.open.delete(old.id); }
    return { secret, session: publicSession(session) };
  }
  authenticate(req) {
    const secret = cookieValue(req.headers.cookie, COOKIE);
    if (!secret || secret.length > 200) return null;
    const digest = hash(secret), now = this.now(), session = this.sessions.find(row => same(row.hash, digest));
    if (!session || session.expiresAt <= now) return null;
    if (now - session.lastSeenAt > 10 * 60000) { session.lastSeenAt = now; void this.#save().catch(() => {}); } // Last seen, without a write per request.
    return session;
  }
  async revoke(id) {
    if (id === 'all') this.pairing = null; // A code shown earlier does not pair a device after Revoke all either.
    let gone = [];
    await this.#commit(() => { gone = this.sessions.filter(row => id === 'all' || row.id === id); this.sessions = this.sessions.filter(row => !gone.includes(row)); return gone.length > 0; });
    // Its live streams end at once: a revoked device sees nothing more.
    for (const row of gone) { for (const res of this.open.get(row.id) || []) res.destroy(); this.open.delete(row.id); }
    return gone.length;
  }

  // ---- What the Settings page shows ----
  async status({ refresh = false } = {}) {
    const { method, port, bind, host, cert, key } = this.settings, now = this.now();
    if (method === 'tailscale' && (refresh || !this.tailscale || this.now() - this.tailscale.at > 15000)) {
      // Requests that arrive together share one lookup; a refresh (after a Serve change) always reads again.
      if (refresh || this.lookup?.port !== port) this.lookup = { port, state: tailscaleState(port, this.cli) };
      const lookup = this.lookup;
      try { this.tailscale = { at: this.now(), state: await lookup.state }; } finally { if (this.lookup === lookup) this.lookup = null; }
    }
    const tailscale = method === 'tailscale' ? this.tailscale.state : null;
    const url = method === 'tailscale' ? tailscale?.url || '' : method === 'twingate' && (host || bind !== '127.0.0.1') ? `${cert ? 'https' : 'http'}://${host || bind}:${port}` : '';
    const warnings = [];
    if (method === 'twingate' && bind === '127.0.0.1') warnings.push(`On 127.0.0.1, a Twingate Resource that allows all ports also reaches Promptboard’s local port ${this.localPort} on this computer, without pairing. Listen on this computer’s private address instead (the local app never listens there), or limit the Resource to TCP port ${port} only. A Connector in Docker or on another computer cannot reach 127.0.0.1 at all.`);
    if (method === 'twingate' && !cert) warnings.push('Without a certificate, the last hop from the Connector to this computer is unencrypted on your network. Add a certificate and key for HTTPS.');
    if (tailscale?.shared) warnings.push('Another Tailscale Serve service uses this same address on a different port. Browsers send Promptboard’s device sign-in to it as well; keep it only if you trust that service.');
    if (tailscale?.funnel) warnings.push('Tailscale Funnel is on for this address: it is reachable from the public internet. Promptboard refuses those requests; turn Funnel off.');
    // The certificate paths come back (this route is local only), so saving another field keeps HTTPS.
    return { method, port, bind, host, tls: Boolean(cert), cert, key, listening: Boolean(this.server), error: this.error, url, tailscale, warnings, addresses: localAddresses(),
      pairing: this.pairing && this.pairing.expiresAt > now ? { expiresAt: this.pairing.expiresAt } : null,
      sessions: this.sessions.filter(row => row.expiresAt > now).map(publicSession) }; // An expired device has no access and is not listed.
  }
  async setServe(on) {
    if (this.settings.method !== 'tailscale') throw invalid('Choose Tailscale first.');
    const state = await tailscaleState(this.settings.port, this.cli);
    if (!state.running || (!state.httpsPort && !state.serving)) throw new RemoteError(state.message || 'Tailscale is not connected.', 'REMOTE_TAILSCALE', 409);
    if (!on && !state.serving) return this.status({ refresh: true });
    const target = `http://127.0.0.1:${this.settings.port}`;
    const args = on ? ['serve', '--bg', `--https=${state.httpsPort}`, target] : ['serve', '--bg', `--https=${state.servePort}`, target, 'off'];
    // Serve waits while it is not enabled for the tailnet; Promptboard stops waiting and shows Tailscale's own link.
    await this.cli.run(args, { timeoutMs: 15000 }).catch(error => {
      const output = `${error.stdout || ''}\n${error.stderr || ''}`, link = output.match(/https:\/\/login\.tailscale\.com\/[^\s]+/)?.[0] || '';
      if (/not enabled on your tailnet/i.test(output)) throw Object.assign(new RemoteError('Tailscale Serve and HTTPS are not enabled for your tailnet yet. Open the link from Tailscale as a tailnet admin, enable them, then choose Turn on again.', 'REMOTE_TAILSCALE_NOT_ENABLED', 409), { link });
      throw new RemoteError(/https|certificate|cert/i.test(output) ? 'Tailscale needs HTTPS certificates for your tailnet. Run the command in a terminal once and follow its link, then check again.' : 'Tailscale Serve could not be changed. Run the command in a terminal to see why.', 'REMOTE_TAILSCALE', 409);
    });
    return this.status({ refresh: true });
  }

  // ---- The remote listener: every request needs a paired device ----
  allowedHost(hostHeader) {
    const host = String(hostHeader || '').toLowerCase();
    const { method, port, bind } = this.settings;
    const names = new Set([`127.0.0.1:${port}`, `localhost:${port}`]); // A reverse proxy on this computer; pairing is still required.
    const tailscale = method === 'tailscale' ? this.tailscale?.state : null; // Also the port Serve forwards from, when it is not 443 or 8443.
    if (tailscale?.name) for (const suffix of ['', ':443', ':8443', ...(tailscale.serving ? [`:${tailscale.servePort}`] : [])]) names.add(`${tailscale.name}${suffix}`);
    if (method === 'twingate') { for (const name of [this.settings.host, bind].filter(Boolean)) { names.add(`${name}:${port}`); names.add(name); } }
    return names.has(host);
  }
  async serve(req, res) {
    secureHeaders(res);
    const { method } = this.settings;
    // Tailscale marks requests that came from the public internet through Funnel: never served.
    if (req.headers['tailscale-funnel-request']) return reply(res, 403, { error: 'Promptboard is never served on the public internet. Turn Tailscale Funnel off.', code: 'REMOTE_PUBLIC' });
    if (method === 'tailscale' && !this.tailscale?.state?.name) await this.status().catch(() => {});
    if (!this.allowedHost(req.headers.host)) return reply(res, 403, { error: 'This address is not allowed for remote access. Open the address shown in Promptboard’s Settings.', code: 'REMOTE_HOST' });
    const secure = Boolean(this.settings.cert) || method === 'tailscale';
    if (req.headers.origin) {
      let origin; try { origin = new URL(req.headers.origin); } catch {}
      if (!origin || origin.host.toLowerCase() !== String(req.headers.host).toLowerCase()) return reply(res, 403, { error: 'This origin is not allowed.', code: 'REMOTE_ORIGIN' });
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') return reply(res, 403, { error: 'Cross-site requests are not allowed.', code: 'REMOTE_ORIGIN' });
    let url; try { url = new URL(req.url, 'http://remote'); } catch { return reply(res, 400, { error: 'This request address is not valid.' }); }
    const path = url.pathname;
    if (req.method === 'GET' && PAIR_FILES[path]) { res.writeHead(200, { 'Content-Type': PAIR_FILES[path][1] }); return res.end(PAIR_FILES[path][0]); }
    if (req.method === 'POST' && path === '/api/remote/pair') {
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return reply(res, 415, { error: 'Send JSON.' });
      const body = await readJson(req, 4096).catch(() => null);
      if (!body) return reply(res, 400, { error: 'Send the pairing code.' });
      try {
        const { secret, session } = await this.pair(body.code, body.name);
        res.setHeader('Set-Cookie', `${COOKIE}=${secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${REMOTE_LIMITS.sessionDays * 86400}${secure ? '; Secure' : ''}`);
        return reply(res, 200, { paired: true, session });
      } catch (error) { if (!(error instanceof RemoteError)) throw error; return reply(res, error.status, { error: error.message, code: error.code }); }
    }
    const session = this.authenticate(req);
    if (!session) {
      if (path.startsWith('/api/')) return reply(res, 401, { error: 'Pair this device again in Promptboard’s Settings on the computer.', code: 'REMOTE_PAIRING_REQUIRED' });
      res.writeHead(302, { Location: '/remote' }); return res.end();
    }
    if (req.method === 'POST' && path === '/api/remote/logout') {
      await this.revoke(session.id);
      res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`);
      return reply(res, 200, { signedOut: true });
    }
    if (localOnly(req.method, path, req)) return reply(res, 403, { error: 'Do this on the computer that runs Promptboard. Remote devices cannot change remote access or sign-ins, or open dialogs on that screen.', code: 'REMOTE_LOCAL_ONLY' });
    req.promptboardRemote = { id: session.id, name: session.name };
    const open = this.open.get(session.id) || new Set(); this.open.set(session.id, open);
    open.add(res); res.once('close', () => open.delete(res));
    return this.handle(req, res, req.promptboardRemote);
  }
}

/**
 * Management on the local app only (the remote listener refuses /api/remote/* except pairing and sign-out):
 * GET /api/remote, POST /api/remote/settings, POST /api/remote/pairing, POST /api/remote/serve {on, confirm},
 * DELETE /api/remote/sessions/:id (or all).
 */
export async function remoteRoute(remote, req, res, pathname, { jsonBody, send }) {
  const answer = async () => send(res, 200, { remote: await remote.status() });
  try {
    if (req.method === 'GET' && pathname === '/api/remote') { const refresh = new URL(req.url, 'http://local').searchParams.get('refresh') === '1'; return send(res, 200, { remote: await remote.status({ refresh }) }); }
    if (req.method === 'POST' && pathname === '/api/remote/settings') { const input = await jsonBody(req, 16384); return send(res, 200, { remote: await remote.configure(input && typeof input === 'object' ? input : {}) }); }
    if (req.method === 'POST' && pathname === '/api/remote/pairing') {
      await jsonBody(req, 1024);
      if (remote.settings.method === 'local') throw new RemoteError('Turn on Tailscale or Twingate access first.', 'REMOTE_OFF', 409);
      return send(res, 200, { pairing: remote.newPairing(), remote: await remote.status() });
    }
    if (req.method === 'POST' && pathname === '/api/remote/serve') {
      const input = await jsonBody(req, 1024);
      // Changing the host's Tailscale configuration needs an explicit yes each time.
      if (input?.confirm !== true) throw new RemoteError('Confirm the Tailscale Serve change first.', 'CONFIRMATION_REQUIRED');
      return send(res, 200, { remote: await remote.setServe(input.on === true) });
    }
    const revoke = pathname.match(/^\/api\/remote\/sessions\/([0-9a-f-]{36}|all)$/);
    if (req.method === 'DELETE' && revoke) { await remote.revoke(revoke[1]); return answer(); }
    return send(res, 404, { error: 'This route does not exist.' });
  } catch (error) {
    const status = error.status || 500; // Expected refusals carry their own fixed text; anything else stays generic.
    return send(res, status, { error: status < 500 || error instanceof RemoteError ? error.message : 'Remote access could not be changed.', code: error.code || 'REMOTE_FAILED', ...(error.link ? { link: error.link } : {}) });
  }
}

/**
 * What needs someone at the computer: remote access itself, CLI and GitHub sign-in (they open a browser or terminal
 * there), native dialogs, opening a project folder, terminal or editor there, starting or stopping a card's live preview
 * (a dev server whose 127.0.0.1 link works only there), Base imports (Claude Desktop's own
 * configuration, a repository scan), and Network external clients: creating or rotating one (a new token) and the machine
 * listener (a new way in). Everything else is allowed: a paired device has the same control as the computer,
 * so Compose's MCP test and local folder sources stay allowed, like agents, test commands and Base MCP tests.
 * tests/remote-access.test.mjs walks every route against this list.
 */
function localOnly(method, path) {
  if (method === 'GET' || method === 'HEAD') return /^\/api\/remote(\/|$)/.test(path) || path === '/api/editors';
  return /^\/api\/remote(\/|$)/.test(path) || path === '/api/editors' || /^\/api\/auth\/(login|logout|cancel)$/.test(path) || /^\/api\/github\/login(\/cancel)?$/.test(path) || path === '/api/folder/choose' || /^\/api\/base\/(?:mcp\/import(?:\/preview)?|markdown\/(?:scan|import))$/.test(path)
    || /^\/api\/projects\/[^/]+\/open$/.test(path) // Opens a window on the computer's screen.
    || /^\/api\/tasks\/[^/]+\/preview$/.test(path) // Starts or stops a dev server whose link works only on the computer.
    || path === '/api/sandbox/claude-token' // A CLI sign-in, like the ones above: set or removed at the computer.
    || /^\/api\/network\/(?:clients(?:\/[^/]+\/rotate)?|listener)$/.test(path) // A new machine token is shown, or the machine listener opens (revoking stays allowed).
    || /^\/api\/network\/(?:delegation|schedules\/[^/]+\/confirm)$/.test(path) // Standing automation (Task 12): handoffs switched on, a schedule switched on.
    // Federation changes trust or exposure: previewing a card (an outbound request), approving or changing a peer, the
    // outbound and inbound switches. Reading it and removing a peer (which only removes trust) stay allowed.
    || /^\/api\/network\/federation\/(?:peers(?:\/preview)?|outbound|inbound)$/.test(path) || (method === 'PATCH' && /^\/api\/network\/federation\/peers\/[^/]+$/.test(path));
}
/** This computer's private addresses, offered as listening addresses for Twingate. */
function localAddresses() {
  return Object.values(networkInterfaces()).flat().filter(entry => entry && !entry.internal && privateAddress(entry.address)).map(entry => entry.address).slice(0, 8);
}
const publicSession = row => ({ id: row.id, name: row.name, createdAt: row.createdAt, lastSeenAt: row.lastSeenAt, expiresAt: row.expiresAt });
function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) { const [key, ...rest] = part.trim().split('='); if (key === name) return rest.join('='); }
  return '';
}
function secureHeaders(res) {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}
function reply(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', chunk => { size += chunk.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => { try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(value && typeof value === 'object' && !Array.isArray(value) ? value : null); } catch { resolve(null); } });
    req.on('error', reject);
  });
}

// The pairing page: plain HTML, its own script and styles (the CSP allows no inline code).
const PAIR_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="dark light"><title>Pair this device · Promptboard</title><link rel="stylesheet" href="/remote/pair.css"></head>
<body><main><h1>Pair this device</h1><p>On the computer that runs Promptboard, open <strong>Settings → Remote access</strong> and choose <strong>Pair a device</strong>. Enter the code it shows.</p>
<form id="pair"><label for="code">Pairing code</label><input id="code" name="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" inputmode="text" maxlength="9" placeholder="ABCD-EFGH" required>
<label for="name">Name for this device</label><input id="name" name="name" maxlength="60" placeholder="iPhone"><button type="submit">Pair</button><p id="message" role="alert"></p></form>
<p class="note">Promptboard keeps running on the computer. Closing Safari or locking the phone stops nothing.</p></main><script src="/remote/pair.js"></script></body></html>`;
const PAIR_JS = `document.getElementById('name').value = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad' : 'Phone';
document.getElementById('pair').addEventListener('submit', async event => {
  event.preventDefault();
  const message = document.getElementById('message'), button = event.target.querySelector('button'); button.disabled = true; message.textContent = '';
  try {
    const response = await fetch('/api/remote/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: document.getElementById('code').value, name: document.getElementById('name').value }) });
    const data = await response.json().catch(() => ({}));
    if (response.ok) { location.replace('/'); return; }
    message.textContent = data.error || 'Pairing failed. Try again.';
  } catch { message.textContent = 'The computer did not answer. Check the VPN connection, then try again.'; }
  button.disabled = false;
});`;
const PAIR_CSS = `:root{color-scheme:dark light;font:16px/1.5 -apple-system,system-ui,sans-serif;background:#0b0b10;color:#f2f2f5}main{max-width:420px;margin:0 auto;padding:max(32px,env(safe-area-inset-top)) 20px 40px}h1{font-size:26px;margin:0 0 8px}p{color:#b8b8c4}label{display:block;margin:18px 0 6px;font-weight:600}input{box-sizing:border-box;width:100%;min-height:48px;padding:0 14px;border:1px solid #3a3a46;border-radius:12px;background:#15151c;color:inherit;font:inherit;font-size:20px;letter-spacing:.08em}#name{font-size:17px;letter-spacing:0}button{width:100%;min-height:50px;margin-top:22px;border:0;border-radius:12px;background:#f2f2f5;color:#0b0b10;font:inherit;font-weight:700}button:disabled{opacity:.5}#message{color:#fb923c;min-height:1.5em}.note{font-size:14px;margin-top:28px}@media (prefers-color-scheme:light){:root{background:#f6f6f8;color:#111}input{background:#fff;border-color:#ccc}button{background:#111;color:#fff}p{color:#555}}`;
const PAIR_FILES = { '/remote': [PAIR_HTML, 'text/html; charset=utf-8'], '/remote/pair.js': [PAIR_JS, 'text/javascript; charset=utf-8'], '/remote/pair.css': [PAIR_CSS, 'text/css; charset=utf-8'] };
