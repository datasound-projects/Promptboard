/**
 * Federation settings and trusted peers (docs/network/architecture.md §3, §10.4, §11.5, §24). Two switches, both off by
 * default: outbound (Promptboard may call peers the owner approved) and inbound (A2A callers may submit to agents the owner
 * published for A2A, on the machine listener). A peer is added only by the owner: preview a card URL (one guarded fetch,
 * nothing saved), review it, approve it with the hash of exactly what was reviewed. Only the card's public fields are kept,
 * bounded and cleaned (no HTML is ever interpreted; URLs other than the one JSON-RPC endpoint are dropped), plus the NAME of
 * an environment variable that holds the credential — never its value.
 *
 * Storage (storage.mjs discipline), created on the first change: <dataDir>/network/federation.json
 * (promptboard.network-federation v1, with .bak) = { revision, outbound: { enabled }, inbound: { enabled, agents: [{ agentId,
 * description, requireApproval, publishedAt }] }, peers: [Peer] }. Reading creates nothing.
 */
import { isIP } from 'node:net';
import { join } from 'node:path';
import { serial } from '../durable.mjs';
import { A2A_LIMITS, checkUrl, guardedFetch, privateRange } from './a2a-client.mjs';
import { conflict, fail, LINE_BREAK, newId, NetworkError, object, only, readSettings, requireRevision, sha256, writeDocument } from './storage.mjs';

const SCHEMA = 'promptboard.network-federation';
/** Resource ceilings, not product limits. */
export const FEDERATION_LIMITS = Object.freeze({ peers: 100, published: 50, cardBytes: 64 * 1024, description: 300, skills: 50 });
export const PEER_ID = /^peer_[0-9a-f]{20}$/;
const AGENT_ID = /^agt_[0-9a-f]{20}$/, ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/, SHA = /^[0-9a-f]{64}$/, SCHEME_NAME = /^[A-Za-z0-9_.-]{1,64}$/, HEADER = /^[A-Za-z0-9-]{1,64}$/;
/**
 * A credential is read only from a variable with this prefix (review 4, P4-8), so no other variable of the app (a provider's
 * key, PATH) can be sent to a peer. ENV_NAME is what older versions stored: such a peer still loads, but is refused until renamed.
 */
const CREDENTIAL_ENV = /^PROMPTBOARD_A2A_[A-Z0-9_]{1,48}$/;
const MODE = /^[A-Za-z0-9.+_-]{1,60}(?:\/[A-Za-z0-9.+_*-]{1,60})?$/, TENANT = /^[A-Za-z0-9._~-]{0,100}$/;
/** Headers a card may not ask Promptboard to put its credential in. */
const RESERVED = new Set(['host', 'cookie', 'content-type', 'content-length', 'transfer-encoding', 'connection', 'accept', 'a2a-version', 'a2a-extensions', 'proxy-authorization', 'te', 'upgrade']);
// Every format character (bidi controls, zero-width, ALM, soft hyphen, BOM, …) and the Unicode tag block (invisible text).
const INVISIBLE = /[\p{Cf}\u{E0000}-\u{E007F}]/gu, CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const WARNINGS = {
  shortened: 'Some text in the card was longer than Promptboard keeps and was shortened.',
  dropped: 'Fields Promptboard does not use were left out: icon and documentation links, the provider link, extensions and signatures. Nothing in the card is ever opened or run.',
  markup: 'The card contains markup such as HTML tags. It is shown as plain text only.',
  skills: 'The card lists more skills than Promptboard keeps; only the first ones are shown.',
  origin: 'The card names an endpoint on another origin than the card itself. Both origins are allowed for this peer.',
  unsigned: 'Promptboard does not verify card signatures: the address you entered is what you trust.',
  security: 'The card asks for a credential. Name the environment variable that holds it, or calls will be refused by the peer.',
};

/** Untrusted card text: control, format and invisible characters removed, white space tidied, cut to `max` characters. */
function said(value, max, notes, lines = false) {
  if (typeof value !== 'string') return '';
  let clean = value.replace(/\r\n?/g, '\n').replace(INVISIBLE, '').replace(CONTROL, '');
  clean = (lines ? clean.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n') : clean.replace(/[\s\u0085\u2028\u2029]+/g, ' ')).trim();
  if (/<\/?[a-z!][^>]*>/i.test(clean)) notes.add('markup');
  const chars = [...clean];
  if (chars.length <= max) return clean;
  notes.add('shortened');
  return `${chars.slice(0, max - 1).join('')}…`;
}
const words = (list, count, max, notes) => (Array.isArray(list) ? list : []).slice(0, count).map(item => said(item, max, notes)).filter(Boolean);
const modes = list => (Array.isArray(list) ? list : []).filter(item => typeof item === 'string' && MODE.test(item)).slice(0, 20);
/** One security scheme, from A2A 1.0 proto-JSON (`httpAuthSecurityScheme`, …) or the JSON-Schema style (`type: 'http'`, …). */
function scheme(name, value, notes) {
  const http = value.httpAuthSecurityScheme ?? (value.type === 'http' ? value : null), key = value.apiKeySecurityScheme ?? (value.type === 'apiKey' ? value : null);
  const base = { name, description: said((http || key || Object.values(value)[0])?.description, 200, notes) };
  if (object(http)) return { ...base, type: /^bearer$/i.test(http.scheme || '') ? 'bearer' : 'http', scheme: said(http.scheme, 40, notes) };
  if (object(key)) {
    const where = String(key.location ?? key.in ?? '').toLowerCase(), header = where === 'header' && typeof key.name === 'string' && HEADER.test(key.name) && !RESERVED.has(key.name.toLowerCase()) ? key.name : null;
    return { ...base, type: 'apiKey', in: ['header', 'query', 'cookie'].includes(where) ? where : 'unknown', ...(header ? { header } : {}) };
  }
  const type = value.oauth2SecurityScheme || value.type === 'oauth2' ? 'oauth2' : value.openIdConnectSecurityScheme || value.type === 'openIdConnect' ? 'openIdConnect'
    : value.mtlsSecurityScheme || value.type === 'mutualTLS' ? 'mtls' : 'unknown';
  return { ...base, type };
}

/**
 * The public, bounded part of an Agent Card that Promptboard keeps (architecture §10.4): refused without a name or an A2A 1.x
 * JSON-RPC endpoint that the URL policy allows. Arrays, not keyed objects, so no card key can reach an object prototype.
 */
export function normalizeCard(raw, { cardUrl, localTest = false }) {
  if (!object(raw)) fail('The Agent Card is not a JSON object.', 'CARD_INVALID', 422);
  const notes = new Set();
  const name = said(raw.name, 120, notes);
  if (!name) fail('The Agent Card has no name.', 'CARD_INVALID', 422);
  const interfaces = (Array.isArray(raw.supportedInterfaces) ? raw.supportedInterfaces : []).slice(0, 20);
  const chosen = interfaces.find(item => object(item) && typeof item.protocolBinding === 'string' && /^jsonrpc$/i.test(item.protocolBinding) && typeof item.protocolVersion === 'string' && /^1\.\d{1,3}$/.test(item.protocolVersion));
  if (!chosen) fail('The Agent Card offers no A2A 1.x JSON-RPC endpoint, which is what Promptboard speaks. Nothing was saved.', 'CARD_UNSUPPORTED', 422);
  let endpoint;
  try { endpoint = checkUrl(chosen.url, { localTest }); } catch (error) { fail(`The card’s endpoint is refused: ${error.message}`, 'CARD_ENDPOINT_REFUSED', 422); }
  if (typeof (chosen.tenant ?? '') !== 'string' || !TENANT.test(chosen.tenant ?? '')) fail('The card’s endpoint names a tenant Promptboard cannot use.', 'CARD_INVALID', 422);
  const schemes = Object.entries(object(raw.securitySchemes) ? raw.securitySchemes : {}).slice(0, 10).filter(([key, value]) => SCHEME_NAME.test(key) && object(value)).map(([key, value]) => scheme(key, value, notes));
  const named = new Set(schemes.map(item => item.name)), required = [];
  for (const entry of [...(Array.isArray(raw.securityRequirements) ? raw.securityRequirements : []), ...(Array.isArray(raw.security) ? raw.security : [])].slice(0, 20)) {
    for (const key of Object.keys(object(entry?.schemes) ? entry.schemes : object(entry) ? entry : {})) if (named.has(key) && !required.includes(key)) required.push(key);
  }
  const skills = (Array.isArray(raw.skills) ? raw.skills : []).filter(object);
  if (skills.length > FEDERATION_LIMITS.skills) notes.add('skills');
  if (raw.documentationUrl || raw.iconUrl || raw.provider?.url || raw.capabilities?.extensions?.length || raw.signatures?.length) notes.add('dropped');
  const card = { name, description: said(raw.description, 2000, notes, true), version: said(raw.version, 40, notes), provider: object(raw.provider) && said(raw.provider.organization, 120, notes) || null,
    endpoint: { url: endpoint.href, protocolVersion: chosen.protocolVersion, tenant: chosen.tenant ?? '' },
    capabilities: { streaming: raw.capabilities?.streaming === true, pushNotifications: raw.capabilities?.pushNotifications === true },
    defaultInputModes: modes(raw.defaultInputModes), defaultOutputModes: modes(raw.defaultOutputModes), securitySchemes: schemes, security: required,
    skills: skills.slice(0, FEDERATION_LIMITS.skills).map(skill => ({ id: said(String(skill.id ?? ''), 100, notes), name: said(skill.name, 120, notes), description: said(skill.description, 1000, notes, true),
      tags: words(skill.tags, 20, 40, notes), examples: words(skill.examples, 5, 300, notes) })).filter(skill => skill.id || skill.name) };
  while (Buffer.byteLength(JSON.stringify(card)) > FEDERATION_LIMITS.cardBytes && card.skills.length) { card.skills.pop(); notes.add('skills'); }
  if (endpoint.origin !== new URL(cardUrl).origin) notes.add('origin');
  if (required.length) notes.add('security');
  notes.add('unsigned');
  return { card, warnings: [...notes].map(key => WARNINGS[key]) };
}

const time = value => Number.isSafeInteger(value) && value >= 0;
const storedPeer = row => object(row) && PEER_ID.test(row.id) && typeof row.cardUrl === 'string' && object(row.card) && object(row.card.endpoint) && typeof row.card.endpoint.url === 'string'
  && SHA.test(row.cardSha256) && typeof row.enabled === 'boolean' && typeof row.localTest === 'boolean' && (row.privateAddress === null || isIP(row.privateAddress) > 0)
  && (row.credential === null || (object(row.credential) && ENV_NAME.test(row.credential.env) && typeof row.credential.scheme === 'string')) && time(row.approvedAt) && Number.isSafeInteger(row.revision);
const storedPublished = row => object(row) && AGENT_ID.test(row.agentId) && typeof row.description === 'string' && typeof row.requireApproval === 'boolean' && time(row.publishedAt);
const stored = data => Number.isSafeInteger(data.revision) && typeof data.outbound?.enabled === 'boolean' && typeof data.inbound?.enabled === 'boolean'
  && Array.isArray(data.inbound.agents) && data.inbound.agents.every(storedPublished) && Array.isArray(data.peers) && data.peers.every(storedPeer);
const hashOf = card => sha256(JSON.stringify(card));

/** The owner's choice of a private address for a peer on a private network (https only): one exact IP of a private range. */
function privateAddressOf(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !privateRange(value)) fail('Allow one private network address (10.x, 172.16–31.x, 192.168.x, 100.64–127.x or fc00::/7, for example 10.0.0.5), or none. Loopback addresses need a local test peer instead.');
  return value;
}

export class Federation {
  /**
   * `registry` is the NetworkRegistry (agents published for A2A must be registered); `env` holds credentials (process.env);
   * `lookup`, `transport` and `limits` reach the guarded fetch (tests inject a resolver and lower the limits).
   */
  constructor({ dataDir, registry, now = Date.now, events = null, env = process.env, lookup, transport, limits = {} }) {
    Object.assign(this, { path: join(dataDir, 'network', 'federation.json'), registry, now, events, env, net: { lookup, transport, limits: { ...A2A_LIMITS, ...limits } } });
  }
  #serial = serial();
  #doc = null;
  #listeners = new Set(); // Told after every saved change, so running peer jobs stop when trust is withdrawn (A2AWorker).
  async #ready() {
    return this.#doc ??= await readSettings(this.path, { schema: SCHEMA, label: 'The Network federation settings', valid: stored, now: this.now, events: this.events,
      reset: data => ({ ...data, outbound: { enabled: false }, inbound: { enabled: false, agents: [] }, peers: data.peers.map(row => ({ ...row, enabled: false, credential: null, revision: row.revision + 2 })) }) })
      ?? { schema: SCHEMA, version: 1, revision: 0, outbound: { enabled: false }, inbound: { enabled: false, agents: [] }, peers: [] };
  }
  async #write(next) {
    await writeDocument(this.path, next); this.#doc = next;
    for (const listener of this.#listeners) { try { listener(); } catch {} }
    return next;
  }
  /** `listener()` hears every saved change of the switches or peers; answers the function that stops it. */
  onChange(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  /** Whether a peer is still trusted as a job pinned it, now: outbound on, the peer there and switched on, the same card. */
  trusts(peerId, cardSha256) {
    const doc = this.#doc, row = doc?.peers.find(peer => peer.id === peerId);
    return Boolean(doc?.outbound.enabled && row?.enabled && row.cardSha256 === cardSha256);
  }
  #row(id) {
    const row = typeof id === 'string' && PEER_ID.test(id) ? this.#doc.peers.find(peer => peer.id === id) : null;
    if (!row) fail('This peer does not exist.', 'PEER_NOT_FOUND', 404);
    return row;
  }
  /** What the owner sees of a peer: whether its credential variable is set now, never its value. */
  #view(row) {
    const credential = row.credential && { ...row.credential, set: Boolean(this.env[row.credential.env]), ...(CREDENTIAL_ENV.test(row.credential.env) ? {} : { renameNeeded: true }) };
    return { ...row, name: row.card.name, origin: new URL(row.cardUrl).origin, credential };
  }
  #fetchFor(origins, { localTest, privateAddress }, extra = {}) { return guardedFetch({ origins: new Set(origins), localTest, privateAddress, lookup: this.net.lookup, transport: this.net.transport, limits: this.net.limits, ...extra }); }

  /** GET /api/network/federation: the switches, the peers and the agents published for A2A (with their names now). */
  async view() {
    const doc = await this.#ready(), agents = [];
    for (const entry of doc.inbound.agents) {
      let agent = null;
      try { ({ agent } = await this.registry.agent(entry.agentId)); } catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
      agents.push({ ...entry, name: agent ? agent.displayName || agent.base.name || agent.baseResourceId : null, available: Boolean(agent?.enabled && !agent.base.stale), missing: !agent });
    }
    return { revision: doc.revision, ...(doc.recovery ? { recovery: doc.recovery } : {}), outbound: doc.outbound, inbound: { enabled: doc.inbound.enabled, agents }, peers: doc.peers.map(row => this.#view(row)), limits: FEDERATION_LIMITS };
  }

  /** One guarded fetch of a card: `{ cardUrl, origin, card, cardSha256, warnings }`. Outbound must be on: off means no outbound call. */
  async #fetchCard({ url, localTest, privateAddress }) {
    if (!(await this.#ready()).outbound.enabled) fail('Outbound federation is off. Turn it on first; until then Promptboard contacts no peer.', 'FEDERATION_OFF', 409);
    const cardUrl = checkUrl(url, { localTest }), fetch = this.#fetchFor([cardUrl.origin], { localTest, privateAddress }, { maxBytes: FEDERATION_LIMITS.cardBytes });
    const response = await fetch(cardUrl.href, { headers: { Accept: 'application/json', 'A2A-Version': '1.0' } });
    let raw;
    try { raw = JSON.parse(await response.text()); } catch (error) { if (error instanceof NetworkError) throw error; fail('The card is not valid JSON.', 'CARD_INVALID', 422); }
    const { card, warnings } = normalizeCard(raw, { cardUrl: cardUrl.href, localTest });
    return { cardUrl: cardUrl.href, origin: cardUrl.origin, card, cardSha256: hashOf(card), warnings };
  }
  #options(input) {
    if (input.localTest !== undefined && typeof input.localTest !== 'boolean') fail('localTest is true or false.');
    const localTest = input.localTest === true, privateAddress = privateAddressOf(input.privateAddress);
    if (localTest && privateAddress) fail('A local test peer is on this computer only; it takes no private address.');
    return { localTest, privateAddress };
  }
  /** POST …/peers/preview (local-only): `{ url, localTest?, privateAddress? }` → what the card says; nothing is saved. */
  async preview(input) {
    only(input, ['url', 'localTest', 'privateAddress'], 'a peer preview');
    return { preview: await this.#fetchCard({ url: input.url, ...this.#options(input) }) };
  }
  /** The credential reference: the name of an environment variable and one of the card's bearer or header schemes. */
  #credential(input, card) {
    if (input.credentialEnv === undefined || input.credentialEnv === null || input.credentialEnv === '') return null;
    if (typeof input.credentialEnv !== 'string' || !CREDENTIAL_ENV.test(input.credentialEnv)) {
      fail('Name the environment variable that holds the credential: PROMPTBOARD_A2A_ and then capital letters, digits and _, for example PROMPTBOARD_A2A_ACME_TOKEN. Only such variables are ever sent to a peer. Never paste the credential itself.', 'CREDENTIAL_REFERENCE_INVALID');
    }
    const chosen = card.securitySchemes.find(item => item.name === input.credentialScheme);
    if (!chosen || !(chosen.type === 'bearer' || (chosen.type === 'apiKey' && chosen.header))) fail('Choose one of the card’s bearer-token or header API-key schemes for the credential. Other schemes are not supported.', 'CREDENTIAL_SCHEME_UNSUPPORTED');
    return { env: input.credentialEnv, scheme: chosen.name };
  }
  /** POST …/peers (local-only): approve exactly the card the owner reviewed (`cardSha256` from the preview), fetched again now. */
  async approve(input) {
    only(input, ['url', 'cardSha256', 'localTest', 'privateAddress', 'credentialEnv', 'credentialScheme', 'expectedRevision'], 'a peer approval');
    requireRevision(input);
    if (typeof input.cardSha256 !== 'string' || !SHA.test(input.cardSha256)) fail('Preview the card first and approve what you reviewed (cardSha256).');
    const options = this.#options(input), seen = await this.#fetchCard({ url: input.url, ...options });
    if (seen.cardSha256 !== input.cardSha256) fail('The card changed since you reviewed it. Preview it again before you approve it. Nothing was saved.', 'CARD_CHANGED', 409);
    const credential = this.#credential(input, seen.card);
    return this.#serial(async () => {
      const doc = await this.#ready();
      if (input.expectedRevision !== doc.revision) conflict('The federation settings');
      if (doc.peers.some(peer => peer.cardUrl === seen.cardUrl)) fail('This card URL is already a trusted peer. Refresh it there instead.', 'PEER_EXISTS', 409);
      if (doc.peers.length >= FEDERATION_LIMITS.peers) fail(`At most ${FEDERATION_LIMITS.peers} peers can be trusted.`, 'NETWORK_LIMIT', 409);
      const at = this.now(), row = { id: newId('peer'), cardUrl: seen.cardUrl, card: seen.card, cardSha256: seen.cardSha256, credential, ...options, enabled: true, approvedAt: at, refreshedAt: at, revision: 1 };
      await this.#write({ ...doc, revision: doc.revision + 1, peers: [...doc.peers, row] });
      return { peer: this.#view(row), revision: doc.revision + 1 };
    });
  }
  /**
   * PATCH …/peers/:id (local-only): `{ expectedRevision, enabled?, credentialEnv?, credentialScheme?, cardSha256? }`. With
   * `cardSha256` the card is fetched again and kept only when it is exactly what the owner reviewed in a fresh preview; when
   * it moves the endpoint to another origin, the credential reference is dropped unless the same change names it again.
   */
  async update(id, input) {
    only(input, ['expectedRevision', 'enabled', 'credentialEnv', 'credentialScheme', 'cardSha256'], 'a peer change');
    requireRevision(input);
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') fail('enabled is true or false.');
    await this.#ready();
    const current = this.#row(id);
    let refreshed = null;
    if (input.cardSha256 !== undefined) {
      if (typeof input.cardSha256 !== 'string' || !SHA.test(input.cardSha256)) fail('Preview the card again and send its cardSha256.');
      refreshed = await this.#fetchCard({ url: current.cardUrl, localTest: current.localTest, privateAddress: current.privateAddress });
      if (refreshed.cardSha256 !== input.cardSha256) fail('The card changed again since you reviewed it. Preview it again. Nothing was saved.', 'CARD_CHANGED', 409);
    }
    return this.#serial(async () => {
      const doc = await this.#ready(), row = this.#row(id);
      if (input.expectedRevision !== row.revision) conflict('This peer');
      const card = refreshed?.card ?? row.card, moved = new URL(card.endpoint.url).origin !== new URL(row.card.endpoint.url).origin;
      // The credential goes only to the endpoint's origin: a refresh that moves it keeps the credential only if named again here.
      const credential = Object.hasOwn(input, 'credentialEnv') ? this.#credential(input, card) : !moved && row.credential && card.securitySchemes.some(item => item.name === row.credential.scheme) ? row.credential : null;
      const next = { ...row, ...(refreshed ? { card, cardSha256: refreshed.cardSha256, refreshedAt: this.now() } : {}), credential, enabled: input.enabled ?? row.enabled, revision: row.revision + 1 };
      await this.#write({ ...doc, revision: doc.revision + 1, peers: doc.peers.map(peer => (peer.id === id ? next : peer)) });
      return { peer: this.#view(next), revision: doc.revision + 1 };
    });
  }
  /** DELETE …/peers/:id (allowed from a paired device: it only removes trust). Queued jobs for it fail at claim; running ones stop. */
  async remove(id, input) {
    only(input, ['expectedRevision'], 'a peer removal');
    requireRevision(input);
    return this.#serial(async () => {
      const doc = await this.#ready(), row = this.#row(id);
      if (input.expectedRevision !== row.revision) conflict('This peer');
      await this.#write({ ...doc, revision: doc.revision + 1, peers: doc.peers.filter(peer => peer.id !== id) });
      return { removed: { id, name: row.card.name }, revision: doc.revision + 1 };
    });
  }
  /** PATCH …/outbound (local-only): `{ expectedRevision, enabled }`. Off: no preview, no peer job is accepted or started. */
  async setOutbound(input) {
    only(input, ['expectedRevision', 'enabled'], 'the outbound switch');
    requireRevision(input);
    if (typeof input.enabled !== 'boolean') fail('enabled is true or false.');
    return this.#serial(async () => {
      const doc = await this.#ready();
      if (input.expectedRevision !== doc.revision) conflict('The federation settings');
      await this.#write({ ...doc, revision: doc.revision + 1, outbound: { enabled: input.enabled } });
      return this.view();
    });
  }
  /**
   * PATCH …/inbound (local-only): `{ expectedRevision, enabled?, agents? }`; `agents` = every agent published for A2A as
   * `{ agentId, description?, requireApproval? }` (registered agents only; the description is what callers read).
   */
  async setInbound(input) {
    only(input, ['expectedRevision', 'enabled', 'agents'], 'the inbound settings');
    requireRevision(input);
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') fail('enabled is true or false.');
    let agents = null;
    if (input.agents !== undefined) {
      if (!Array.isArray(input.agents) || input.agents.length > FEDERATION_LIMITS.published) fail(`Publish at most ${FEDERATION_LIMITS.published} agents for A2A.`);
      const seen = new Set();
      agents = [];
      for (const entry of input.agents) {
        only(entry, ['agentId', 'description', 'requireApproval'], 'a published agent');
        if (typeof entry.agentId !== 'string' || !AGENT_ID.test(entry.agentId) || seen.has(entry.agentId)) fail('Publish registered agents, each once.');
        seen.add(entry.agentId);
        await this.registry.agent(entry.agentId).catch(error => { if (error.code === 'NOT_FOUND') fail('An agent you chose is not registered in Network.', 'AGENT_NOT_FOUND', 409, { agentId: entry.agentId }); throw error; });
        if (entry.description !== undefined && (typeof entry.description !== 'string' || LINE_BREAK.test(entry.description.trim()))) fail('Describe a published agent in one line.');
        if (entry.requireApproval !== undefined && typeof entry.requireApproval !== 'boolean') fail('requireApproval is true or false.');
        agents.push({ agentId: entry.agentId, description: said(entry.description ?? '', FEDERATION_LIMITS.description, new Set()), requireApproval: entry.requireApproval === true });
      }
    }
    return this.#serial(async () => {
      const doc = await this.#ready(), at = this.now();
      if (input.expectedRevision !== doc.revision) conflict('The federation settings');
      const before = new Map(doc.inbound.agents.map(entry => [entry.agentId, entry]));
      const inbound = { enabled: input.enabled ?? doc.inbound.enabled, agents: agents ? agents.map(entry => ({ ...entry, publishedAt: before.get(entry.agentId)?.publishedAt ?? at })) : doc.inbound.agents };
      await this.#write({ ...doc, revision: doc.revision + 1, inbound });
      return this.view();
    });
  }

  /** A peer that may be called now: outbound on, the peer known and switched on. */
  async #usable(peerId) {
    const doc = await this.#ready();
    if (!doc.outbound.enabled) fail('Outbound federation is off, so remote peers are not called.', 'FEDERATION_OFF', 409);
    const row = typeof peerId === 'string' && PEER_ID.test(peerId) ? doc.peers.find(peer => peer.id === peerId) : null;
    if (!row) fail('This remote peer is no longer trusted.', 'PEER_NOT_FOUND', 409);
    if (!row.enabled) fail('This remote peer is switched off in Federation.', 'PEER_DISABLED', 409);
    if (row.credential && !CREDENTIAL_ENV.test(row.credential.env)) {
      fail(`This peer’s credential variable ${row.credential.env} must be renamed: Promptboard now sends a peer only variables named PROMPTBOARD_A2A_…. Rename it in this app’s environment and in Federation → Credential…. Nothing was sent.`, 'CREDENTIAL_REFERENCE_INVALID', 409);
    }
    return row;
  }
  /** At job acceptance (jobs.mjs): what the job pins — the peer and the hash of the card it was accepted with. */
  async pin(peerId) {
    const row = await this.#usable(peerId);
    return { peerId: row.id, peerRevision: row.revision, name: row.card.name, cardSha256: row.cardSha256, endpoint: row.card.endpoint.url };
  }
  /** At claim (jobs.mjs): still usable and still the accepted card; otherwise the job fails before anything is sent. */
  async check(pinned) {
    const row = await this.#usable(pinned?.peerId);
    if (row.cardSha256 !== pinned.cardSha256) fail('The peer’s card changed after the job was accepted. Nothing was sent: submit the job again.', 'PEER_CHANGED', 409);
  }
  /** For the worker: the peer and a guarded fetch to its endpoint origin only, with its credential read from the environment now. */
  async callable(peerId) {
    const row = await this.#usable(peerId), origin = new URL(row.card.endpoint.url).origin;
    let credential = null;
    if (row.credential) {
      const value = this.env[row.credential.env], chosen = row.card.securitySchemes.find(item => item.name === row.credential.scheme);
      if (!value) fail(`The environment variable ${row.credential.env} that should hold this peer’s credential is not set. Nothing was sent.`, 'CREDENTIAL_MISSING', 409);
      if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) fail(`The value of ${row.credential.env} cannot be sent as a header. Nothing was sent.`, 'CREDENTIAL_INVALID', 409);
      if (!chosen) fail('The peer’s card no longer offers the credential scheme you chose. Nothing was sent.', 'CREDENTIAL_SCHEME_UNSUPPORTED', 409);
      credential = chosen.type === 'bearer' ? { origin, header: 'authorization', value: `Bearer ${value}` } : { origin, header: chosen.header.toLowerCase(), value };
    }
    // Trust is asked again before every request, so nothing more is sent once the owner withdraws it (review 4, P4-2).
    return { peer: row, fetch: this.#fetchFor([origin], row, { credential, allowed: () => this.trusts(row.id, row.cardSha256) }) };
  }
  /** For Graph and pipelines: what each peer ID is now (name, origin, switched on), or `missing`. */
  async refs(ids) {
    const doc = await this.#ready(), out = {};
    for (const id of new Set(ids)) { const row = doc.peers.find(peer => peer.id === id); out[id] = row ? { name: row.card.name, origin: new URL(row.cardUrl).origin, enabled: row.enabled, outbound: doc.outbound.enabled } : { missing: true }; }
    return out;
  }
  /** For the inbound endpoint: whether it serves, and the agents published for A2A. */
  async inbound() { const doc = await this.#ready(); return { enabled: doc.inbound.enabled, agents: doc.inbound.agents }; }
}
