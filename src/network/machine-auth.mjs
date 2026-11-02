/**
 * Machine clients (docs/network/architecture.md §4.3, §5 MachineClient, §6.4, §10.3, §11.1–11.2, §22): narrow principals
 * for apps and MCP hosts on this computer. A client is scoped to listed agents, networks and projects and to listed
 * permissions; it never gets owner access. Its bearer token `pbm_<clientId>_<43 base64url characters>` (32 random bytes)
 * is shown once, when it is made or rotated; only its SHA-256 is stored (a slow hash adds nothing for 256 random bits)
 * and compared in constant time. Revoking is final; rotating replaces the token of the same client (its jobs stay its own).
 *
 * Storage (storage.mjs discipline), created on the first change: <dataDir>/network/clients.json
 * (promptboard.network-clients v1, with .bak) = { revision, listener: { enabled, port }, clients: [MachineClient] }.
 * Reading creates nothing, so an install that never turns external clients on has no file and no listener.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { serial } from '../durable.mjs';
import { cleanText, conflict, fail, LINE_BREAK, newId, object, only, readSettings, requireRevision, sha256, writeDocument } from './storage.mjs';

const SCHEMA = 'promptboard.network-clients';
export const MACHINE_PERMISSIONS = Object.freeze(['read_agents', 'submit_jobs', 'read_job_result', 'cancel_own_jobs', 'read_scoped_memory']);
/** `api` clients use /machine/v1 (REST and MCP); `a2a` callers (Task 13) use only the A2A endpoint, for agents published for A2A. */
export const CLIENT_KINDS = Object.freeze(['api', 'a2a']);
/** Resource ceilings, not product limits. */
export const MACHINE_LIMITS = Object.freeze({ activeClients: 100, name: 60, scope: 200, expiryDays: 365, lastUsedMs: 10 * 60_000 });
export const LISTENER_DEFAULTS = Object.freeze({ enabled: false, port: 4330 });
export const MACHINE_TOKEN = /^pbm_(cli_[0-9a-f]{20})_[A-Za-z0-9_-]{43}$/;
const CLIENT_ID = /^cli_[0-9a-f]{20}$/, AGENT_ID = /^agt_[0-9a-f]{20}$/, NETWORK_ID = /^net_[0-9a-f]{20}$/, PROJECT_ID = /^[A-Za-z0-9_-]{1,100}$/, SHA = /^[0-9a-f]{64}$/;
const DAY = 86_400_000;
const time = value => Number.isSafeInteger(value) && value >= 0;
const nullable = check => value => value === null || check(value);
const ids = (list, pattern) => Array.isArray(list) && list.length <= MACHINE_LIMITS.scope && list.every(id => typeof id === 'string' && pattern.test(id));

const storedClient = row => object(row) && CLIENT_ID.test(row.id) && CLIENT_KINDS.includes(row.kind) && typeof row.name === 'string' && SHA.test(row.tokenSha256) && typeof row.tokenHint === 'string'
  && time(row.createdAt) && [row.lastUsedAt, row.expiresAt, row.revokedAt, row.rotatedAt].every(nullable(time)) && Number.isSafeInteger(row.revision) && object(row.scopes)
  && ids(row.scopes.agents, AGENT_ID) && ids(row.scopes.networks, NETWORK_ID) && ids(row.scopes.projects, PROJECT_ID) && Array.isArray(row.scopes.permissions) && row.scopes.permissions.every(item => MACHINE_PERMISSIONS.includes(item));
const stored = data => Number.isSafeInteger(data.revision) && object(data.listener) && typeof data.listener.enabled === 'boolean' && Number.isSafeInteger(data.listener.port)
  && Array.isArray(data.clients) && data.clients.every(storedClient);

/** A list of IDs from the owner: unique, well formed, at most 200. */
function idList(value, pattern, what) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MACHINE_LIMITS.scope || value.some(id => typeof id !== 'string' || !pattern.test(id))) fail(`List at most ${MACHINE_LIMITS.scope} ${what} by their IDs.`);
  return [...new Set(value)];
}

export class MachineClients {
  /** `registry` is the NetworkRegistry: agents, networks and the board's projects are checked through it when a client is made. */
  constructor({ dataDir, registry, events = null, now = Date.now }) {
    Object.assign(this, { path: join(dataDir, 'network', 'clients.json'), registry, events, now });
  }
  #serial = serial();
  #loading = null;
  #doc = null;
  #used = new Map(); // id → lastUsedAt not yet saved (saved at most every 10 minutes per client).
  #revoked = new Set(); // Listeners told when a client's current token stops working (revoke, rotate).

  #ready() { return this.#loading ??= this.#load().catch(error => { this.#loading = null; throw error; }); }
  async #load() {
    this.#doc = await readSettings(this.path, { schema: SCHEMA, label: 'The Network clients file', valid: stored, now: this.now, events: this.events,
      reset: (data, at) => ({ ...data, listener: { ...data.listener, enabled: false }, clients: data.clients.map(row => ({ ...row, revokedAt: row.revokedAt || at || 1, revision: row.revision + 2 })) }) })
      ?? { schema: SCHEMA, version: 1, revision: 0, listener: { ...LISTENER_DEFAULTS }, clients: [] };
  }
  async #write(next) { await writeDocument(this.path, next); this.#doc = next; return next; }
  #row(id) {
    const row = typeof id === 'string' && CLIENT_ID.test(id) ? this.#doc.clients.find(client => client.id === id) : null;
    if (!row) fail('This client does not exist.', 'NOT_FOUND', 404);
    return row;
  }
  /** What the owner sees: never the hash. */
  #view(row) {
    const { tokenSha256, ...fields } = row, now = this.now();
    return { ...fields, lastUsedAt: this.#used.get(row.id) ?? row.lastUsedAt, status: row.revokedAt ? 'revoked' : row.expiresAt !== null && row.expiresAt <= now ? 'expired' : 'active' };
  }
  #token(id) { const token = `pbm_${id}_${randomBytes(32).toString('base64url')}`; return { token, tokenSha256: sha256(token), tokenHint: token.slice(-4) }; }
  #notify(id) { for (const listener of this.#revoked) { try { listener(id); } catch {} } }
  /** `listener(clientId)` hears every revoke and rotation; answers the function that stops it. */
  onRevoke(listener) { this.#revoked.add(listener); return () => this.#revoked.delete(listener); }

  async #scopes(input) {
    if (!object(input)) fail('Send the scopes as { agents, networks, projects, permissions }.');
    only(input, ['agents', 'networks', 'projects', 'permissions'], 'the client scopes');
    const agents = idList(input.agents, AGENT_ID, 'agents'), networks = idList(input.networks, NETWORK_ID, 'networks'), projects = idList(input.projects, PROJECT_ID, 'projects');
    if (!agents.length) fail('Choose at least one agent the client may use.');
    if (!Array.isArray(input.permissions) || !input.permissions.length || input.permissions.some(item => !MACHINE_PERMISSIONS.includes(item))) fail(`Choose permissions from ${MACHINE_PERMISSIONS.join(', ')}.`);
    for (const id of agents) await this.registry.agent(id).catch(error => { if (error.code === 'NOT_FOUND') fail('An agent you chose is not registered in Network.', 'AGENT_NOT_FOUND', 409, { agentId: id }); throw error; });
    for (const id of networks) await this.registry.network(id).catch(error => { if (error.code === 'NOT_FOUND') fail('A network you chose does not exist.', 'NETWORK_NOT_FOUND', 409, { networkId: id }); throw error; });
    const board = new Set(await this.registry.projects()), missing = projects.find(id => !board.has(id));
    if (missing) fail('A project you chose is not on the board.', 'PROJECT_NOT_FOUND', 409, { projectId: missing });
    return { agents, networks, projects, permissions: MACHINE_PERMISSIONS.filter(item => input.permissions.includes(item)) };
  }

  async list() {
    await this.#ready();
    return { revision: this.#doc.revision, ...(this.#doc.recovery ? { recovery: this.#doc.recovery } : {}), clients: this.#doc.clients.map(row => this.#view(row)).sort((a, b) => b.createdAt - a.createdAt), permissions: MACHINE_PERMISSIONS };
  }
  /**
   * A new client and its token, shown this once (local-only route). `kind: 'a2a'` makes an A2A caller: its agents must be
   * published for A2A now, and it names no network or project (inbound tasks carry none).
   */
  async create(input) {
    only(input, ['name', 'scopes', 'expiresInDays', 'kind'], 'a client');
    const kind = input.kind ?? 'api';
    if (!CLIENT_KINDS.includes(kind)) fail('A client is of kind api or a2a.');
    if (typeof input.name !== 'string' || LINE_BREAK.test(input.name)) fail('Name the client in one line.');
    const name = cleanText(input.name).slice(0, MACHINE_LIMITS.name);
    if (!name) fail('Name the client.');
    const days = input.expiresInDays ?? null;
    if (days !== null && (!Number.isSafeInteger(days) || days < 1 || days > MACHINE_LIMITS.expiryDays)) fail(`Choose an expiry of 1 to ${MACHINE_LIMITS.expiryDays} days, or none.`);
    const scopes = await this.#scopes(input.scopes);
    if (kind === 'a2a') {
      const published = new Set((await this.registry.federation.inbound()).agents.map(entry => entry.agentId));
      if (scopes.networks.length || scopes.projects.length) fail('An A2A caller names no networks or projects: its tasks carry none.');
      if (scopes.agents.some(id => !published.has(id))) fail('An A2A caller may only use agents published for A2A. Publish them in Federation first.', 'AGENT_NOT_PUBLISHED', 409);
    }
    await this.#ready();
    return this.#serial(async () => {
      const now = this.now();
      if (this.#doc.clients.filter(row => !row.revokedAt && (row.expiresAt === null || row.expiresAt > now)).length >= MACHINE_LIMITS.activeClients) fail(`At most ${MACHINE_LIMITS.activeClients} clients can be active. Revoke one first.`, 'NETWORK_LIMIT', 409);
      const id = newId('cli'), { token, ...secret } = this.#token(id);
      const row = { id, kind, name, ...secret, createdAt: now, lastUsedAt: null, expiresAt: days === null ? null : now + days * DAY, revokedAt: null, rotatedAt: null, revision: 1, scopes };
      await this.#write({ ...this.#doc, revision: this.#doc.revision + 1, clients: [...this.#doc.clients, row] });
      return { client: this.#view(row), token };
    });
  }
  /** Revoke for good (allowed from a paired device: it only removes access). Idempotent; open streams end at once. */
  async revoke(id, input = {}) {
    only(input, [], 'a revoke request');
    await this.#ready();
    const result = await this.#serial(async () => {
      const row = this.#row(id);
      if (row.revokedAt) return { client: this.#view(row), revoked: false };
      const next = { ...row, revokedAt: this.now(), revision: row.revision + 1 };
      await this.#write({ ...this.#doc, revision: this.#doc.revision + 1, clients: this.#doc.clients.map(item => (item.id === id ? next : item)) });
      return { client: this.#view(next), revoked: true };
    });
    this.#notify(id);
    return result;
  }
  /** A new token for the same client and scopes; the old one stops working at once (local-only route). */
  async rotate(id, input) {
    only(input, ['expectedRevision'], 'a rotation');
    requireRevision(input);
    await this.#ready();
    const result = await this.#serial(async () => {
      const row = this.#row(id), now = this.now();
      if (row.revokedAt) fail('This client was revoked. Create a new client instead.', 'CLIENT_REVOKED', 409);
      if (row.expiresAt !== null && row.expiresAt <= now) fail('This client has expired. Create a new client instead.', 'CLIENT_EXPIRED', 409);
      if (input.expectedRevision !== row.revision) conflict('This client');
      const { token, ...secret } = this.#token(id), next = { ...row, ...secret, rotatedAt: now, revision: row.revision + 1 };
      await this.#write({ ...this.#doc, revision: this.#doc.revision + 1, clients: this.#doc.clients.map(item => (item.id === id ? next : item)) });
      return { client: this.#view(next), token };
    });
    this.#notify(id);
    return result;
  }

  /**
   * The active client whose current token is in `header` (`Bearer pbm_…`), or null: unknown, revoked, expired or a
   * wrong token all look the same to the caller.
   */
  async authenticate(header, kind = 'api') {
    const token = /^Bearer\s+(\S{1,200})$/i.exec(String(header || ''))?.[1], match = token && MACHINE_TOKEN.exec(token);
    if (!match) return null;
    await this.#ready();
    const row = this.#doc.clients.find(client => client.id === match[1]), now = this.now();
    // A client works only on its own kind of endpoint: an A2A caller's token is refused on /machine/v1, and the reverse.
    if (!row || row.kind !== kind || row.revokedAt || (row.expiresAt !== null && row.expiresAt <= now)) return null;
    if (!timingSafeEqual(Buffer.from(sha256(token), 'hex'), Buffer.from(row.tokenSha256, 'hex'))) return null;
    this.#used.set(row.id, now);
    if (now - (row.lastUsedAt ?? 0) > MACHINE_LIMITS.lastUsedMs) void this.#serial(async () => { // Last used, without a write per request.
      const current = this.#doc.clients.find(client => client.id === row.id);
      if (current && !current.revokedAt && now - (current.lastUsedAt ?? 0) > MACHINE_LIMITS.lastUsedMs) await this.#write({ ...this.#doc, clients: this.#doc.clients.map(item => (item.id === row.id ? { ...item, lastUsedAt: now } : item)) });
    }).catch(() => {});
    return row;
  }

  /** The machine listener's saved settings: off by default, port 4330. */
  async listener() { await this.#ready(); return { ...this.#doc.listener }; }
  async setListener(settings) {
    await this.#ready();
    return this.#serial(async () => (await this.#write({ ...this.#doc, revision: this.#doc.revision + 1, listener: { enabled: settings.enabled, port: settings.port } })).listener);
  }
}
