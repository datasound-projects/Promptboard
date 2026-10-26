/**
 * Network registry (docs/network/architecture.md §3–§5, §9): agent registrations that reference Base agents by ID, and
 * networks — agent and sub-network nodes with positions, typed relation edges — kept as an editable draft plus
 * immutable published versions.
 *
 * Storage (storage.mjs discipline): <dataDir>/network/agents.json, networks/<id>.json (drafts) and
 * networks/<id>/v<n>-<sha256>.json (published versions, never rewritten or deleted). The folder appears on the first
 * save. Base is only read (Base.list), so provider, model and instructions always come from Base, and state.json is
 * never written. A relation edge records allowed intent only: saving, publishing or importing starts nothing, sends no
 * message and shares no data.
 */
import { randomBytes } from 'node:crypto';
import { readdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ADAPTERS } from '../agents.mjs';
import { primaryAgent } from '../base-resolver.mjs';
import { redactLocal } from '../compose-local.mjs';
import { noPaths } from '../coordinator.mjs';
import { serial, syncDir } from '../durable.mjs';
import { escapeId } from '../origin.mjs';
import { NetworkMemory } from './memory.mjs';
import { NetworkPosts } from './posts.mjs';
import { conflict, fail, LINE_BREAK, newId, NetworkError, object, only, page, PAGE_LIMIT, readDocument, readImmutable, requireRevision as revision, sha256, writeDocument, writeImmutable } from './storage.mjs';

const SCHEMA = { agents: 'promptboard.network-agents', draft: 'promptboard.network-draft', version: 'promptboard.network-version' };
export const NETWORK_LIMITS = Object.freeze({ agents: 5000, nodes: 5000, edges: 20000, draftBytes: 8 * 1024 * 1024, name: 80, description: 2000, labels: 20, label: 40, projects: 200, page: PAGE_LIMIT, coordinate: 1e7 });
export const RELATIONS = Object.freeze(['message', 'delegate', 'share_result']);
const LIMITS = NETWORK_LIMITS, AGENT_KINDS = ['profile', 'agentProfile'];
const REGISTRATION_FIELDS = ['displayName', 'tags', 'capabilities', 'enabled', 'visibility', 'projectAllowlist'];
const AGENT_ID = /^agt_[0-9a-f]{20}$/, NETWORK_ID = /^net_[0-9a-f]{20}$/, NODE_ID = /^n_[0-9a-f]{12}$/, EDGE_ID = /^e_[0-9a-f]{12}$/;
const EXTERNAL_ID = /^[A-Za-z0-9_-]{1,100}$/, SHA = /^[0-9a-f]{64}$/, CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const invalidFile = () => fail('This is not a valid Promptboard Network export. Nothing was imported.', 'NETWORK_IMPORT_INVALID');
const byCreated = (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1);
/**
 * Owner text, trimmed; a local folder in it is cut to its last name and a credential masked before it is saved, as
 * architecture §4.2 rule 9 asks of text that leaves the app (an export carries it as saved). Names and labels are one
 * line (they reach prompts as a line of their own, see memory.mjs), so a line break or tab inside them is refused; only
 * `multiline` text (a description) keeps them.
 */
function text(value, max, label, { required = false, nullable = false, multiline = false } = {}) {
  if (!required && (value === undefined || value === null || value === '')) return nullable ? null : '';
  if (typeof value !== 'string' || CONTROL.test(value)) fail(`${label} must be text.`);
  if (!multiline && LINE_BREAK.test(value.trim())) fail(`${label} must be one line, without line breaks or tabs.`);
  const clean = redactLocal(noPaths(value.trim()));
  if ((required && !clean) || clean.length > max) fail(`${label} must contain ${required ? 1 : 0} to ${max} characters.`);
  return clean || (nullable ? null : '');
}
function labels(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > LIMITS.labels) fail(`${label}: choose at most ${LIMITS.labels}.`);
  return [...new Set(value.map(item => text(item, LIMITS.label, label, { required: true })))];
}
function time(value) { if (!Number.isSafeInteger(value) || value < 0) invalidFile(); return value; }
const accepts = check => { try { check(); return true; } catch { return false; } };
/** A stored row or draft is used only when it is exactly what this module writes; anything else counts as damaged. */
const storedRow = row => object(row) && AGENT_ID.test(row.id) && typeof row.baseResourceId === 'string' && EXTERNAL_ID.test(row.baseResourceId) && Number.isSafeInteger(row.revision)
  && ['tags', 'capabilities', 'projectAllowlist'].every(key => Array.isArray(row[key])) && typeof row.enabled === 'boolean';
const storedDraft = data => NETWORK_ID.test(data.id) && typeof data.name === 'string' && typeof data.description === 'string' && Number.isSafeInteger(data.revision) && Number.isSafeInteger(data.createdAt)
  && Array.isArray(data.publishedVersions) && data.publishedVersions.every((entry, index) => entry?.version === index + 1 && SHA.test(entry.sha256))
  && (data.archived === undefined || data.archived === true) && accepts(() => edgesOf(data.edges, nodesOf(data.nodes)));

/** The fields an owner sets on a registration; `previous` fills the ones a change leaves out. */
function registrationFields(input, previous = {}) {
  const has = key => Object.hasOwn(input, key);
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') fail('Enabled must be true or false.');
  if (input.visibility !== undefined && input.visibility !== 'private') fail('Registrations are private in this version.');
  const projects = input.projectAllowlist;
  if (has('projectAllowlist') && (!Array.isArray(projects) || projects.length > LIMITS.projects || projects.some(id => typeof id !== 'string' || !EXTERNAL_ID.test(id)))) fail('Choose projects from this board.');
  return { displayName: has('displayName') ? text(input.displayName, LIMITS.name, 'Display name', { nullable: true }) : previous.displayName ?? null,
    tags: has('tags') ? labels(input.tags, 'Tags') : previous.tags ?? [], capabilities: has('capabilities') ? labels(input.capabilities, 'Capabilities') : previous.capabilities ?? [],
    enabled: input.enabled ?? previous.enabled ?? true, visibility: 'private', projectAllowlist: has('projectAllowlist') ? [...new Set(projects)] : previous.projectAllowlist ?? [] };
}

function position(value) {
  if (!object(value) || Object.keys(value).length !== 2 || ![value.x, value.y].every(n => Number.isFinite(n) && Math.abs(n) <= LIMITS.coordinate)) fail('Each node needs a position { x, y } of finite numbers.');
  return { x: value.x, y: value.y };
}
/** Nodes in a fixed key order (a published version's bytes, and so its hash, depend on it). */
function nodesOf(value) {
  if (!Array.isArray(value) || value.length > LIMITS.nodes) fail(`A network holds at most ${LIMITS.nodes} nodes.`);
  const ids = new Set(), members = new Set();
  return value.map(node => {
    if (!object(node) || !['agent', 'subnetwork'].includes(node.type)) fail('A node is an agent or a sub-network.');
    const agent = node.type === 'agent', member = agent ? node.agentId : node.networkId;
    only(node, ['id', 'type', ...(agent ? ['agentId'] : ['networkId', 'version']), 'position', 'collapsed'], `${agent ? 'an agent' : 'a sub-network'} node`);
    if (typeof node.id !== 'string' || !NODE_ID.test(node.id) || ids.has(node.id)) fail('Each node needs its own ID: n_ and 12 hexadecimal characters.');
    ids.add(node.id);
    if (typeof member !== 'string' || !(agent ? AGENT_ID : NETWORK_ID).test(member)) fail(agent ? 'An agent node names a registered agent.' : 'A sub-network node names a network.');
    if (members.has(member)) fail(agent ? 'Each agent appears once in a network.' : 'Each network appears once as a sub-network.');
    members.add(member);
    if (!agent && (!Number.isSafeInteger(node.version) || node.version < 1)) fail('A sub-network node pins one published version number.');
    if (node.collapsed !== undefined && typeof node.collapsed !== 'boolean') fail('Collapsed must be true or false.');
    return { id: node.id, type: node.type, ...(agent ? { agentId: member } : { networkId: member, version: node.version }), position: position(node.position), ...(node.collapsed ? { collapsed: true } : {}) };
  });
}
function edgesOf(value, nodes) {
  if (!Array.isArray(value) || value.length > LIMITS.edges) fail(`A network holds at most ${LIMITS.edges} relations.`);
  const nodeIds = new Set(nodes.map(node => node.id)), ids = new Set(), pairs = new Set();
  return value.map(edge => {
    only(edge, ['id', 'from', 'to', 'relation'], 'a relation');
    if (typeof edge.id !== 'string' || !EDGE_ID.test(edge.id) || ids.has(edge.id)) fail('Each relation needs its own ID: e_ and 12 hexadecimal characters.');
    ids.add(edge.id);
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to) || edge.from === edge.to) fail('A relation connects two different nodes of this network.');
    if (!RELATIONS.includes(edge.relation)) fail(`A relation is ${RELATIONS.join(', ')}.`);
    const key = `${edge.from}>${edge.to}>${edge.relation}`;
    if (pairs.has(key)) fail('This relation already exists.');
    pairs.add(key);
    return { id: edge.id, from: edge.from, to: edge.to, relation: edge.relation };
  });
}
/** Name, description, nodes and edges; `previous` keeps what a change leaves out. Changed nodes re-check every edge. */
function networkContent(input, previous = { description: '', nodes: [], edges: [] }) {
  const has = key => Object.hasOwn(input, key), nodes = has('nodes') ? nodesOf(input.nodes) : previous.nodes;
  return { name: has('name') || previous.name === undefined ? text(input.name, LIMITS.name, 'Network name', { required: true }) : previous.name,
    description: has('description') ? text(input.description, LIMITS.description, 'Description', { multiline: true }) : previous.description,
    nodes, edges: has('nodes') || has('edges') ? edgesOf(has('edges') ? input.edges : previous.edges, nodes) : previous.edges };
}
/** The exact bytes of a published version, in a fixed key order: the same content always has the same hash. */
const versionText = ({ networkId, number, publishedAt, name, description, nodes, edges }) => JSON.stringify({ schema: SCHEMA.version, version: 1, networkId, number, publishedAt, name, description, nodes, edges });

const breathe = () => new Promise(resolve => setImmediate(resolve));
/**
 * The containment path from `rootId` back to itself through pinned published versions, or null. Pins name published
 * versions only, so drafts are reached only as the root. Depth first with one shared path: each version is walked once,
 * O(versions + pins); `within(networkId)` may leave out networks that cannot lead back. Every 1,000 versions it lets the
 * event loop run, so a large walk never holds the server.
 */
async function containmentCycle(rootId, nodes, versionOf, within = () => true) {
  const walked = new Set(), path = [rootId];
  const walk = async children => {
    for (const node of children) {
      if (node.type !== 'subnetwork') continue;
      if (node.networkId === rootId) return [...path, rootId];
      const key = `${node.networkId}@${node.version}`;
      if (walked.has(key) || !within(node.networkId)) continue;
      walked.add(key);
      if (walked.size % 1000 === 0) await breathe();
      path.push(node.networkId);
      const found = await walk((await versionOf(node.networkId, node.version)).nodes);
      if (found) return found;
      path.pop();
    }
    return null;
  };
  return walk(nodes);
}
/**
 * The networks that can lie on a loop of pins (network A has a graph pinning a version of B, and so on back to A): what
 * is left after taking away, again and again, every network nothing left pins, then every network that pins nothing
 * left (Kahn's peeling, both ways), O(networks + pins). Any network that contains itself is on such a loop.
 */
function looped(pins) {
  const left = new Set(pins.keys());
  for (const forward of [true, false]) {
    const count = new Map([...left].map(id => [id, 0])), next = new Map([...left].map(id => [id, []]));
    for (const id of left) for (const to of pins.get(id)) if (left.has(to)) { const [a, b] = forward ? [id, to] : [to, id]; count.set(b, count.get(b) + 1); next.get(a).push(b); }
    const queue = [...left].filter(id => !count.get(id));
    for (const id of queue) { left.delete(id); for (const b of next.get(id)) { count.set(b, count.get(b) - 1); if (!count.get(b)) queue.push(b); } }
  }
  return left;
}

/** Why a stale Base agent cannot be used, as a graph issue says it (the registration view's `staleReason`). */
const STALE_TEXT = { missing: 'its Base agent no longer exists', 'wrong-kind': 'its Base resource is no longer an agent', disabled: 'its Base agent is switched off',
  untrusted: 'its Base agent is not trusted', revoked: 'trust in its Base agent was revoked', 'no-primary-agent': 'its agent profile has no primary agent switched on',
  'primary-agent-disabled': 'its profile’s primary agent is switched off', 'primary-agent-untrusted': 'its profile’s primary agent is not trusted', 'primary-agent-revoked': 'trust in its profile’s primary agent was revoked' };
/**
 * What the owner should fix or know about a graph's nodes, from `refs` (computed now, never stored): an agent that cannot
 * take work, a sub-network that cannot be read, is archived or pins an older version. Saving never depends on these.
 */
function issuesOf(nodes, refs) {
  const issues = [];
  for (const node of nodes) {
    const at = { nodeId: node.id };
    if (node.type === 'agent') {
      const ref = refs.agents[node.agentId], who = { ...at, agentId: node.agentId };
      if (ref.missing) issues.push({ code: 'AGENT_MISSING', ...who, message: 'An agent node names a registration that no longer exists. Remove the node.' });
      else if (ref.stale) issues.push({ code: 'AGENT_STALE', ...who, message: `“${ref.name}” cannot take work: ${STALE_TEXT[ref.staleReason] || 'its Base agent cannot be used'}. Fix it in Base, or remove it from this network.` });
      else if (!ref.enabled) issues.push({ code: 'AGENT_DISABLED', ...who, message: `“${ref.name}” is switched off in Network. Switch it on in its profile, or remove it from this network.` });
      continue;
    }
    const ref = refs.networks[node.networkId], which = { ...at, networkId: node.networkId, version: node.version };
    if (!ref.pinned) { issues.push({ code: 'SUBNETWORK_UNAVAILABLE', ...which, message: `${ref.name ? `“${ref.name}”` : 'A sub-network'} version ${node.version} cannot be read from the data folder. Remove the node, or restore the network’s files.` }); continue; }
    if (ref.archived) issues.push({ code: 'SUBNETWORK_ARCHIVED', ...which, message: `“${ref.name}” is archived. Its pinned version ${node.version} keeps working; restore it in the Library to change it.` });
    const latest = ref.versions.at(-1);
    if (latest > node.version) issues.push({ code: 'SUBNETWORK_OUTDATED', ...which, latest, message: `“${ref.name}” has version ${latest}; this network pins version ${node.version}. Choose the version in the node’s details to use the newer one.` });
  }
  return issues;
}

/**
 * What each CLI can do for Network, from the provider capability matrix (docs/network/architecture.md §8): 'yes',
 * 'partial', 'no' or 'unknown'; `jobTools` lists the Network job tool modes ([] = refused). A provider that is unset or
 * not in the matrix is unknown throughout, never assumed capable.
 */
const MATRIX = Object.freeze({
  claude: { jobTools: ['none', 'web'], toolEvents: 'yes', waitingEvents: 'yes', readOnly: 'yes', webSearch: 'yes', sessionId: 'yes', usage: 'unknown', dockerSandbox: 'yes', liveVerified: 'yes' },
  codex: { jobTools: ['none', 'web'], toolEvents: 'partial', waitingEvents: 'no', readOnly: 'yes', webSearch: 'yes', sessionId: 'yes', usage: 'unknown', dockerSandbox: 'yes', liveVerified: 'yes' },
  gemini: { jobTools: ['none'], toolEvents: 'partial', waitingEvents: 'yes', readOnly: 'yes', webSearch: 'no', sessionId: 'partial', usage: 'no', dockerSandbox: 'no', liveVerified: 'no' },
  agy: { jobTools: [], toolEvents: 'no', waitingEvents: 'no', readOnly: 'no', webSearch: 'no', sessionId: 'unknown', usage: 'no', dockerSandbox: 'no', liveVerified: 'partial' },
});
const UNKNOWN = Object.fromEntries(Object.keys(MATRIX.claude).map(key => [key, key === 'jobTools' ? null : 'unknown']));
const providerCapabilities = provider => ({ provider, known: Object.hasOwn(MATRIX, provider ?? ''), ...structuredClone(MATRIX[provider] || UNKNOWN) });
const SUMMARY = 280;

const unusable = resource => resource.enabled === false ? 'disabled' : resource.trust !== 'trusted' ? (resource.trust === 'revoked' ? 'revoked' : 'untrusted') : null;
/** What a registration shows of its Base agent, read now and never stored: a Base edit shows at once. */
function baseSummary(resources, id) {
  const resource = resources.get(id);
  if (!resource) return { kind: null, name: null, enabled: false, trust: null, revision: null, provider: null, model: null, effort: null, stale: true, staleReason: 'missing', instructions: { summary: '', chars: 0 }, usedBy: 0 };
  // An agent profile runs as its primary agent (as profileDefaults reads it), so that agent must be usable too.
  const agent = resource.kind === 'agentProfile' ? primaryAgent(resources, resource) : resource;
  const settings = agent?.kind === 'profile' ? agent.configuration?.agent || {} : {};
  const primary = resource.kind !== 'agentProfile' ? null : agent?.kind !== 'profile' ? 'no-primary-agent' : unusable(agent) && `primary-agent-${unusable(agent)}`;
  const reason = AGENT_KINDS.includes(resource.kind) ? unusable(resource) || primary || null : 'wrong-kind';
  // The instructions a run would get (profileDefaults order: the agent's own, then the profile's), as a short preview.
  const instructions = [settings.instructions, resource.kind === 'agentProfile' ? resource.configuration?.instructions : ''].filter(value => typeof value === 'string' && value.trim()).join('\n\n').trim();
  return { kind: resource.kind, name: resource.name, enabled: resource.enabled !== false, trust: resource.trust, revision: resource.revision,
    provider: settings.provider || null, model: settings.model || null, effort: settings.effort || null, stale: Boolean(reason), staleReason: reason,
    instructions: { summary: redactLocal(instructions.length > SUMMARY ? `${instructions.slice(0, SUMMARY - 1).trimEnd()}…` : instructions), chars: instructions.length },
    // Base's own "Used by" places (assignments, resources, active runs); Base lists them, Network only counts them.
    usedBy: (resource.usedBy || []).filter(use => !use.historical).length };
}
const search = value => { if (value !== undefined && (typeof value !== 'string' || value.length > 200)) fail('Search with at most 200 characters.'); return value?.toLocaleLowerCase(); };
function freeName(name, taken) {
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLocaleLowerCase()); n++) candidate = `${name.slice(0, LIMITS.name - String(n).length - 3)} (${n})`;
  taken.add(candidate.toLocaleLowerCase());
  return candidate;
}

/** A Network export, checked whole before anything is written: strict fields, references inside the file, hashes, no cycle. */
async function parseBundle(data) {
  if (!object(data) || data.application !== 'Promptboard' || data.kind !== 'promptboard-network') fail('Choose a Promptboard Network export file. Nothing was imported.', 'NETWORK_IMPORT_INVALID');
  if (Number.isSafeInteger(data.version) && data.version > 1) fail('This Network export was made by a newer Promptboard version. Update the app; nothing was imported.', 'NETWORK_VERSION_UNSUPPORTED', 409);
  if (data.version !== 1 || !['agents', 'networks', 'versions'].every(key => Array.isArray(data[key]))) invalidFile();
  only(data, ['application', 'kind', 'version', 'exportedAt', 'agents', 'networks', 'versions'], 'a Network export');
  const unique = (ids, pattern) => { if (ids.some(id => typeof id !== 'string' || !pattern.test(id)) || new Set(ids).size !== ids.length) invalidFile(); };
  const agents = data.agents.map(row => {
    only(row, ['id', 'baseResourceId', ...REGISTRATION_FIELDS, 'createdAt', 'updatedAt', 'revision'], 'an agent registration');
    if (typeof row.baseResourceId !== 'string' || !EXTERNAL_ID.test(row.baseResourceId)) invalidFile();
    return { id: row.id, baseResourceId: row.baseResourceId, ...registrationFields(row), createdAt: time(row.createdAt), updatedAt: time(row.updatedAt), revision: 1 };
  });
  unique(agents.map(row => row.id), AGENT_ID);
  const networks = data.networks.map(draft => {
    only(draft, ['id', 'name', 'description', 'revision', 'createdAt', 'updatedAt', 'nodes', 'edges', 'publishedVersions', 'archived'], 'a network');
    if (!Array.isArray(draft.publishedVersions) || ![undefined, true].includes(draft.archived)) invalidFile();
    const publishedVersions = draft.publishedVersions.map((entry, index) => {
      only(entry, ['version', 'sha256', 'publishedAt'], 'a published version entry');
      if (entry.version !== index + 1 || typeof entry.sha256 !== 'string' || !SHA.test(entry.sha256)) invalidFile();
      return { version: entry.version, sha256: entry.sha256, publishedAt: time(entry.publishedAt) };
    });
    return { id: draft.id, ...networkContent(draft), createdAt: time(draft.createdAt), publishedVersions, ...(draft.archived ? { archived: true } : {}) };
  });
  unique(networks.map(draft => draft.id), NETWORK_ID);
  const listed = new Map(networks.flatMap(draft => draft.publishedVersions.map(entry => [`${draft.id}@${entry.version}`, entry.sha256])));
  const versions = new Map();
  for (const item of data.versions) {
    only(item, ['networkId', 'number', 'sha256', 'publishedAt', 'name', 'description', 'nodes', 'edges'], 'a published version');
    if (typeof item.sha256 !== 'string' || !SHA.test(item.sha256) || !Number.isSafeInteger(item.number)) invalidFile();
    const nodes = nodesOf(item.nodes), key = `${item.networkId}@${item.number}`;
    const body = { networkId: item.networkId, number: item.number, publishedAt: time(item.publishedAt), name: text(item.name, LIMITS.name, 'Network name', { required: true }),
      description: text(item.description, LIMITS.description, 'Description', { multiline: true }), nodes, edges: edgesOf(item.edges, nodes) };
    if (listed.get(key) !== item.sha256 || versions.has(key)) invalidFile();
    if (sha256(versionText(body)) !== item.sha256) fail('A published version in this file does not match its hash. Nothing was imported.', 'NETWORK_CONTENT_INVALID', 409);
    versions.set(key, body);
  }
  if (versions.size !== listed.size) invalidFile();
  // References resolve inside the file: an export always carries the registrations and versions its networks name.
  const agentIds = new Set(agents.map(row => row.id)), graphs = [...networks.map(draft => [draft.id, draft.nodes]), ...[...versions.values()].map(body => [body.networkId, body.nodes])];
  const missingAgents = [...new Set(graphs.flatMap(([, nodes]) => nodes.filter(node => node.type === 'agent' && !agentIds.has(node.agentId)).map(node => node.agentId)))];
  const missingVersions = [...new Set(graphs.flatMap(([, nodes]) => nodes.filter(node => node.type === 'subnetwork' && !versions.has(`${node.networkId}@${node.version}`)).map(node => `${node.networkId}@${node.version}`)))];
  if (missingAgents.length || missingVersions.length) fail('The file names agents or published versions it does not contain. Nothing was imported.', 'NETWORK_IMPORT_UNRESOLVED', 409, { agentIds: missingAgents, versions: missingVersions });
  // Every draft and version is a root, so a crafted loop that no saved network reaches is caught too. Only networks on a
  // loop of pins can contain themselves, so only their graphs are walked, and only through each other (none in a file
  // the app wrote, unless two networks pin versions of each other); the rest costs O(networks + pins).
  // ponytail: a crafted file whose networks all pin each other in loops is walked once per root (O(roots × versions)),
  // yielding to the event loop; keep a per-loop reachability index if such files ever matter.
  const pins = new Map(networks.map(draft => [draft.id, new Set()]));
  for (const [id, nodes] of graphs) for (const node of nodes) if (node.type === 'subnetwork') pins.get(id).add(node.networkId);
  const loops = looped(pins);
  for (const [id, nodes] of graphs) {
    if (!loops.has(id)) continue;
    await breathe();
    const cycle = await containmentCycle(id, nodes, (networkId, number) => versions.get(`${networkId}@${number}`), networkId => loops.has(networkId));
    if (cycle) fail(`A network in the file contains itself: ${cycle.join(' → ')}. Nothing was imported.`, 'NETWORK_CYCLE', 400, { path: cycle });
  }
  return { agents, networks, versions: [...versions.values()] };
}

export class NetworkRegistry {
  /**
   * `base` is Board's Base, only ever read through list(); `projects()` returns the board's project IDs. `memory` and
   * `posts` keep each agent's (and network's) notes and reports in their own files (memory.mjs, posts.mjs).
   */
  constructor({ dataDir, base, projects = async () => [], now = Date.now }) {
    this.dir = join(dataDir, 'network'); this.base = base; this.projects = projects; this.now = now;
    this.memory = new NetworkMemory({ dataDir, registry: this, now }); this.posts = new NetworkPosts({ dataDir, registry: this, now });
  }
  // ponytail: one queue for the whole registry, reads included; per-file queues if owner edits ever contend.
  #serial = serial();
  #agents = null; // agents.json after its first good read; memory always equals disk (set only after a save).
  #drafts = null; // id → draft, or { id, unavailable: code, message } for a draft that cannot be read.
  #versions = new Map(); // `${id}@${n}` → verified published version (immutable, so safe to keep).

  #draftPath(id) { return join(this.dir, 'networks', `${escapeId(id)}.json`); }
  #versionPath(id, number, hash) { return join(this.dir, 'networks', escapeId(id), `v${number}-${hash}.json`); }
  async #loadAgents() {
    return this.#agents ??= await readDocument(join(this.dir, 'agents.json'), { schema: SCHEMA.agents, label: 'The Network agent registry',
      valid: data => Number.isSafeInteger(data.revision) && Array.isArray(data.rows) && data.rows.every(storedRow) })
      ?? { schema: SCHEMA.agents, version: 1, revision: 0, rows: [] };
  }
  // ponytail: the first read loads every draft one after another; read them with bounded concurrency past ~1,000 networks.
  async #loadDrafts() {
    if (this.#drafts) return this.#drafts;
    let names = [];
    try { names = await readdir(join(this.dir, 'networks')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // A draft whose damaged file was set aside lives on in its backup, so backups name networks too.
    const ids = [...new Set(names.map(name => /^net__([0-9a-f]{20})\.json(?:\.bak)?$/.exec(name)?.[1]).filter(Boolean))].sort().map(hex => `net_${hex}`);
    const drafts = new Map();
    for (const id of ids) {
      try {
        const draft = await readDocument(this.#draftPath(id), { schema: SCHEMA.draft, label: 'A saved network', valid: data => data.id === id && storedDraft(data) });
        if (draft) drafts.set(id, draft);
      } catch (error) { if (!(error instanceof NetworkError)) throw error; drafts.set(id, { id, unavailable: error.code, message: error.message }); }
    }
    return this.#drafts = drafts;
  }
  async #draft(id) {
    const draft = typeof id === 'string' && NETWORK_ID.test(id) ? (await this.#loadDrafts()).get(id) : null;
    if (!draft) fail('This network does not exist.', 'NOT_FOUND', 404);
    if (draft.unavailable) fail(draft.message, draft.unavailable, 409);
    return draft;
  }
  async #version(id, number) {
    const key = `${id}@${number}`;
    if (this.#versions.has(key)) return this.#versions.get(key);
    const entry = (await this.#draft(id)).publishedVersions.find(item => item.version === number);
    if (!entry) fail('This published version does not exist.', 'NOT_FOUND', 404);
    const body = await readImmutable(this.#versionPath(id, number, entry.sha256), entry.sha256, { schema: SCHEMA.version,
      valid: data => data.networkId === id && data.number === number && Array.isArray(data.nodes) && Array.isArray(data.edges) });
    const version = { ...body, sha256: entry.sha256 };
    this.#versions.set(key, version);
    return version;
  }
  async #resources() { return new Map((await this.base.list()).resources.map(resource => [resource.id, resource])); }
  async #views(rows) {
    const resources = await this.#resources(), projects = new Set(await this.projects()), memberOf = new Map();
    for (const draft of (await this.#loadDrafts()).values()) for (const node of draft.nodes || []) if (node.type === 'agent') memberOf.set(node.agentId, [...(memberOf.get(node.agentId) || []), draft.id]);
    return rows.map(row => { const base = baseSummary(resources, row.baseResourceId); return { ...row, base, providerCapabilities: providerCapabilities(base.provider), networks: memberOf.get(row.id) || [], missingProjects: row.projectAllowlist.filter(id => !projects.has(id)) }; });
  }
  #row(agents, id) {
    const row = typeof id === 'string' && AGENT_ID.test(id) && agents.rows.find(item => item.id === id);
    if (!row) fail('This agent is not registered in Network.', 'NOT_FOUND', 404);
    return row;
  }
  /** Only projects a change adds must exist, so a project deleted later never blocks unrelated edits. */
  async #checkProjects(ids, kept = []) {
    const added = ids.filter(id => !kept.includes(id)), projects = added.length ? new Set(await this.projects()) : null;
    if (added.some(id => !projects.has(id))) fail('Choose projects that exist on the board.', 'PROJECT_NOT_FOUND');
  }
  async #saveAgents(agents, rows) {
    const next = { ...agents, revision: agents.revision + 1, rows };
    await writeDocument(join(this.dir, 'agents.json'), next);
    this.#agents = next;
    return next;
  }
  async #saveDraft(draft) {
    if (Buffer.byteLength(JSON.stringify(draft)) > LIMITS.draftBytes) fail('This network is larger than 8 MiB. Split it into sub-networks.', 'NETWORK_LIMIT', 413);
    await writeDocument(this.#draftPath(draft.id), draft);
    (await this.#loadDrafts()).set(draft.id, draft);
    return draft;
  }
  #uniqueName(drafts, name, id) {
    const key = name.toLocaleLowerCase();
    if ([...drafts.values()].some(draft => draft.id !== id && !draft.unavailable && draft.name.toLocaleLowerCase() === key)) fail('Another network already has this name.', 'NETWORK_NAME_TAKEN', 409);
  }
  /** Every agent node names a registration, every sub-network a published version, and no network contains itself. */
  async #checkReferences(id, { name, nodes }) {
    const registered = new Set((await this.#loadAgents()).rows.map(row => row.id));
    const agentIds = nodes.filter(node => node.type === 'agent' && !registered.has(node.agentId)).map(node => node.agentId);
    if (agentIds.length) fail('An agent node names an agent that is not registered in Network.', 'NETWORK_REFERENCE_INVALID', 400, { agentIds });
    const pinned = (networkId, number) => this.#version(networkId, number).catch(error => {
      if (error.code === 'NOT_FOUND') fail('A sub-network node pins a version that is not published.', 'NETWORK_REFERENCE_INVALID', 400, { networkId, version: number });
      throw error;
    });
    const path = await containmentCycle(id, nodes, pinned);
    if (!path) return;
    const drafts = await this.#loadDrafts(), names = path.map(item => item === id ? name : drafts.get(item)?.name || item);
    fail(`A network cannot contain itself: ${names.join(' → ')}. Remove the sub-network “${names[1]}” from this network, or pin a version of it that does not contain this network.`, 'NETWORK_CYCLE', 400, { path });
  }
  /**
   * What a graph's nodes point at, read now and never stored: an agent's name and whether it can take work, a
   * sub-network's name, published versions and the size of the pinned one (null when that version cannot be read).
   */
  async #refs(nodes) {
    const rows = new Map((await this.#loadAgents()).rows.map(row => [row.id, row])), drafts = await this.#loadDrafts();
    const resources = nodes.some(node => node.type === 'agent') ? await this.#resources() : new Map(), refs = { agents: {}, networks: {} };
    for (const node of nodes) {
      if (node.type === 'agent') {
        const row = rows.get(node.agentId), base = row && baseSummary(resources, row.baseResourceId);
        refs.agents[node.agentId] = row ? { name: row.displayName || base.name || row.baseResourceId, kind: base.kind, provider: base.provider, enabled: row.enabled, stale: base.stale, staleReason: base.staleReason } : { missing: true };
        continue;
      }
      const child = drafts.get(node.networkId);
      const pinned = await this.#version(node.networkId, node.version).then(version => ({ nodes: version.nodes.length, edges: version.edges.length }), error => { if (error instanceof NetworkError) return null; throw error; });
      refs.networks[node.networkId] = child && !child.unavailable ? { name: child.name, archived: Boolean(child.archived), versions: child.publishedVersions.map(entry => entry.version), pinned } : { name: null, archived: false, versions: [], pinned };
    }
    return refs;
  }
  /**
   * Every other network whose draft or published versions contain `id` as a sub-network, and the networks that could not
   * be read to tell (`unknown`). Published versions never change, so a use there lasts for good.
   * ponytail: reads every published version once (then cached); keep a reverse index if installs reach thousands of versions.
   */
  async #usedBy(id) {
    const usedBy = [], unknown = [], pins = nodes => nodes.find(node => node.type === 'subnetwork' && node.networkId === id);
    for (const draft of (await this.#loadDrafts()).values()) {
      if (draft.id === id) continue;
      if (draft.unavailable) { unknown.push(draft.id); continue; }
      try {
        const versions = [];
        for (const entry of draft.publishedVersions) { const pin = pins((await this.#version(draft.id, entry.version)).nodes); if (pin) versions.push({ version: entry.version, pins: pin.version }); }
        const pin = pins(draft.nodes);
        if (pin || versions.length) usedBy.push({ networkId: draft.id, name: draft.name, archived: Boolean(draft.archived), draft: pin ? pin.version : null, versions });
      } catch (error) { if (!(error instanceof NetworkError)) throw error; unknown.push(draft.id); }
    }
    return { usedBy, unknown };
  }
  /** A draft with what the editor and the Library show beside it: references, issues and where it is used. */
  async #detail(draft) {
    const refs = await this.#refs(draft.nodes), { usedBy, unknown } = await this.#usedBy(draft.id);
    return { network: draft, refs, issues: issuesOf(draft.nodes, refs), usedBy, usedByUnknown: unknown };
  }

  /** `kind` is the role in Base (an Agent or an Agent profile); `facets` lists every declared capability, unfiltered. */
  async listAgents({ q, tag, capability, status, kind, provider, baseResourceId, projectId, networkId, offset, limit } = {}) {
    if (status !== undefined && !['enabled', 'disabled', 'stale'].includes(status)) fail('Filter the status by enabled, disabled or stale.');
    if (kind !== undefined && !AGENT_KINDS.includes(kind)) fail('Filter the role by profile or agentProfile.');
    if (provider !== undefined && !Object.hasOwn(ADAPTERS, provider)) fail(`Filter the provider by ${Object.keys(ADAPTERS).join(', ')}.`);
    const query = search(q);
    return this.#serial(async () => {
      const agents = await this.#loadAgents(), views = await this.#views(agents.rows);
      const items = views.filter(view => (!query || [view.displayName, view.base.name, ...view.tags, ...view.capabilities].some(value => value?.toLocaleLowerCase().includes(query)))
        && (!tag || view.tags.includes(tag)) && (!capability || view.capabilities.includes(capability))
        && (!status || (status === 'stale' ? view.base.stale : view.enabled === (status === 'enabled')))
        && (!kind || view.base.kind === kind) && (!provider || view.base.provider === provider)
        && (!baseResourceId || view.baseResourceId === baseResourceId) && (!projectId || view.projectAllowlist.includes(projectId)) && (!networkId || view.networks.includes(networkId)));
      const capabilities = [...new Set(views.flatMap(view => view.capabilities))].sort((a, b) => a.localeCompare(b));
      return { revision: agents.revision, ...page(items, offset, limit, 'agents'), facets: { capabilities } };
    });
  }
  async agent(id) {
    return this.#serial(async () => { const agents = await this.#loadAgents(); return { revision: agents.revision, agent: (await this.#views([this.#row(agents, id)]))[0] }; });
  }
  /** Register a Base agent or agent profile: only its ID is kept; Base is read, never written. */
  async registerAgent(input) {
    only(input, ['baseResourceId', 'expectedRevision', ...REGISTRATION_FIELDS], 'an agent registration');
    revision(input);
    const fields = registrationFields(input);
    return this.#serial(async () => {
      const agents = await this.#loadAgents();
      if (input.expectedRevision !== agents.revision) conflict('Network agents');
      if (agents.rows.length >= LIMITS.agents) fail(`Network holds at most ${LIMITS.agents} agent registrations.`, 'NETWORK_LIMIT', 409);
      const resource = typeof input.baseResourceId === 'string' && EXTERNAL_ID.test(input.baseResourceId) ? (await this.#resources()).get(input.baseResourceId) : null;
      if (!AGENT_KINDS.includes(resource?.kind)) fail('Choose an existing Base agent or agent profile.', 'BASE_PROFILE_INVALID');
      await this.#checkProjects(fields.projectAllowlist);
      const at = this.now(), row = { id: newId('agt'), baseResourceId: resource.id, ...fields, createdAt: at, updatedAt: at, revision: 1 };
      const saved = await this.#saveAgents(agents, [...agents.rows, row]);
      return { revision: saved.revision, agent: (await this.#views([row]))[0] };
    });
  }
  async updateAgent(id, input) {
    only(input, ['expectedRevision', ...REGISTRATION_FIELDS], 'an agent registration');
    revision(input);
    return this.#serial(async () => {
      const agents = await this.#loadAgents(), row = this.#row(agents, id);
      if (input.expectedRevision !== row.revision) conflict('This agent registration');
      const fields = registrationFields(input, row);
      await this.#checkProjects(fields.projectAllowlist, row.projectAllowlist);
      const next = { ...row, ...fields, updatedAt: this.now(), revision: row.revision + 1 };
      const saved = await this.#saveAgents(agents, agents.rows.map(item => item.id === id ? next : item));
      return { revision: saved.revision, agent: (await this.#views([next]))[0] };
    });
  }

  /** Archived networks are left out unless `archived` is 'true'. */
  async listNetworks({ q, agentId, archived, offset, limit } = {}) {
    const query = search(q);
    if (![undefined, 'true', 'false'].includes(archived)) fail('Choose archived=true to include archived networks.');
    return this.#serial(async () => {
      const drafts = [...(await this.#loadDrafts()).values()];
      const items = drafts.filter(draft => !draft.unavailable && (archived === 'true' || !draft.archived)).sort(byCreated)
        .filter(draft => (!query || draft.name.toLocaleLowerCase().includes(query) || draft.description.toLocaleLowerCase().includes(query)) && (!agentId || draft.nodes.some(node => node.agentId === agentId)))
        .map(({ id, name, description, revision, createdAt, updatedAt, nodes, edges, publishedVersions, archived: shelved }) => ({ id, name, description, revision, createdAt, updatedAt, nodeCount: nodes.length, edgeCount: edges.length, publishedVersions, archived: Boolean(shelved) }));
      return { ...page(items, offset, limit, 'networks'), unavailable: drafts.filter(draft => draft.unavailable).map(({ id, unavailable }) => ({ id, code: unavailable })) };
    });
  }
  async network(id) { return this.#serial(async () => ({ network: await this.#draft(id) })); }
  /** The draft with its references, issues and uses (GET /networks/:id). */
  async networkDetail(id) { return this.#serial(async () => this.#detail(await this.#draft(id))); }
  async createNetwork(input) {
    only(input, ['name', 'description', 'nodes', 'edges'], 'a network');
    const content = networkContent(input);
    return this.#serial(async () => {
      const id = newId('net'), at = this.now();
      this.#uniqueName(await this.#loadDrafts(), content.name, id);
      await this.#checkReferences(id, content);
      return this.#detail(await this.#saveDraft({ schema: SCHEMA.draft, version: 1, id, name: content.name, description: content.description, revision: 1, createdAt: at, updatedAt: at,
        nodes: content.nodes, edges: content.edges, publishedVersions: [] }));
    });
  }
  /**
   * A new, unpublished draft with the same nodes, relations and pins: agents and sub-networks stay references (IDs and
   * pinned version numbers), so nothing is copied by value. The name gets " (copy)" unless one is given.
   */
  async duplicateNetwork(id, input) {
    only(input, ['name'], 'a duplicate request');
    return this.#serial(async () => {
      const source = await this.#draft(id), drafts = await this.#loadDrafts(), at = this.now();
      const name = input.name === undefined ? freeName(`${source.name.slice(0, LIMITS.name - 7)} (copy)`, new Set([...drafts.values()].filter(draft => !draft.unavailable).map(draft => draft.name.toLocaleLowerCase()))) : text(input.name, LIMITS.name, 'Network name', { required: true });
      const copy = { schema: SCHEMA.draft, version: 1, id: newId('net'), name, description: source.description, revision: 1, createdAt: at, updatedAt: at, nodes: structuredClone(source.nodes), edges: structuredClone(source.edges), publishedVersions: [] };
      this.#uniqueName(drafts, name, copy.id);
      await this.#checkReferences(copy.id, copy); // Every pin must still be published and readable.
      return this.#detail(await this.#saveDraft(copy));
    });
  }
  /**
   * Delete a draft that was never published and that no other network uses; anything else is refused with the reason
   * (a published version may be pinned by a later run, and a parent's version pins it for good): archive it instead. The
   * files are set aside as `<file>.deleted-<time>-<random>` (never read again, recoverable by hand); its memory file stays.
   */
  async deleteNetwork(id, input) {
    only(input, ['expectedRevision'], 'a delete request');
    revision(input);
    return this.#serial(async () => {
      const draft = await this.#draft(id);
      if (input.expectedRevision !== draft.revision) conflict('This network');
      const { usedBy, unknown } = await this.#usedBy(id);
      if (unknown.length) fail('Some saved networks cannot be read, so Promptboard cannot tell whether they use this one. Nothing was deleted.', 'NETWORK_DATA_DAMAGED', 409, { networkIds: unknown });
      if (usedBy.length) {
        const where = usedBy.map(use => `“${use.name}” (${[use.draft ? 'draft' : '', ...use.versions.map(item => `v${item.version}`)].filter(Boolean).join(', ')})`).join(', ');
        const forGood = usedBy.some(use => use.versions.length);
        fail(`“${draft.name}” is a sub-network of ${where}. ${forGood ? 'Published versions never change, so it can only be archived.' : 'Remove it from those drafts first, or archive it.'} Nothing was deleted.`, 'NETWORK_IN_USE', 409, { usedBy });
      }
      if (draft.publishedVersions.length) fail(`“${draft.name}” has published versions, which later runs may pin, so it cannot be deleted. Archive it instead: it leaves the lists and every version stays readable. Nothing was deleted.`, 'NETWORK_PUBLISHED', 409);
      const file = this.#draftPath(id), stamp = `${this.now()}-${randomBytes(4).toString('hex')}`;
      try {
        // The backup first: a draft whose backup remains would come back from it.
        for (const path of [`${file}.bak`, file]) await rename(path, `${path}.deleted-${stamp}`).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await syncDir(dirname(file));
      } catch { fail('The network could not be deleted. Check folder permissions and try again.', 'NETWORK_WRITE_FAILED', 500); }
      (await this.#loadDrafts()).delete(id);
      return { deleted: { id, name: draft.name } };
    });
  }
  /** Save the draft. Published versions are separate files and never change. */
  async updateNetwork(id, input) {
    only(input, ['expectedRevision', 'name', 'description', 'nodes', 'edges', 'archived'], 'a network');
    revision(input);
    if (input.archived !== undefined && typeof input.archived !== 'boolean') fail('Archived must be true or false.');
    return this.#serial(async () => {
      const draft = await this.#draft(id);
      if (input.expectedRevision !== draft.revision) conflict('This network');
      const content = networkContent(input, draft);
      this.#uniqueName(await this.#loadDrafts(), content.name, id);
      await this.#checkReferences(id, content);
      const { archived, ...rest } = draft, shelved = input.archived ?? Boolean(archived); // Archived only hides it from lists: pins of it keep working.
      return this.#detail(await this.#saveDraft({ ...rest, ...content, revision: draft.revision + 1, updatedAt: this.now(), ...(shelved ? { archived: true } : {}) }));
    });
  }
  /** Publish the draft as the next immutable version: its file first, so the draft never names a version that was not saved. */
  async publishNetwork(id, input) {
    only(input, ['expectedRevision'], 'a publish request');
    revision(input);
    return this.#serial(async () => {
      const draft = await this.#draft(id);
      if (input.expectedRevision !== draft.revision) conflict('This network');
      await this.#checkReferences(id, draft); // A pinned version may have become unreadable since the draft was saved.
      const number = (draft.publishedVersions.at(-1)?.version || 0) + 1, publishedAt = this.now();
      const content = versionText({ networkId: id, number, publishedAt, name: draft.name, description: draft.description, nodes: draft.nodes, edges: draft.edges }), hash = sha256(content);
      await writeImmutable(this.#versionPath(id, number, hash), content);
      const published = { version: number, sha256: hash, publishedAt };
      return { ...await this.#detail(await this.#saveDraft({ ...draft, revision: draft.revision + 1, updatedAt: publishedAt, publishedVersions: [...draft.publishedVersions, published] })), published };
    });
  }
  /** A published version, with what its nodes point at now (`refs`, computed, not part of the immutable version). */
  async version(id, number) { return this.#serial(async () => { const version = await this.#version(id, number); return { version, refs: await this.#refs(version.nodes) }; }); }

  /** Registrations, drafts and every published version. Memory and reports stay out: private text (architecture §4.4). */
  async export() {
    return this.#serial(async () => {
      const agents = await this.#loadAgents(), drafts = [...(await this.#loadDrafts()).values()], unavailable = drafts.filter(draft => draft.unavailable).map(draft => draft.id);
      if (unavailable.length) fail('Some saved networks cannot be read, so an export would be incomplete. Nothing was exported.', 'NETWORK_DATA_DAMAGED', 409, { networkIds: unavailable });
      const networks = drafts.sort(byCreated).map(({ schema, version, ...draft }) => draft), versions = [];
      for (const draft of networks) for (const entry of draft.publishedVersions) { const { schema, version, ...body } = await this.#version(draft.id, entry.version); versions.push(body); }
      return { application: 'Promptboard', kind: 'promptboard-network', version: 1, exportedAt: new Date(this.now()).toISOString(), agents: agents.rows, networks, versions };
    });
  }
  /**
   * Add an export's registrations and networks. The whole file is checked first and nothing is written unless all of it
   * is valid and every Base ID resolves here. Free IDs are kept; a taken ID gets a new one and every reference follows.
   * Registrations arrive disabled; nothing runs.
   */
  async import(input) {
    only(input, ['data', 'expectedRevision'], 'an import');
    revision(input);
    const bundle = await parseBundle(input.data);
    return this.#serial(async () => {
      const agents = await this.#loadAgents(), drafts = await this.#loadDrafts(), resources = await this.#resources();
      if (input.expectedRevision !== agents.revision) conflict('Network agents');
      const unresolved = [...new Set(bundle.agents.filter(row => !AGENT_KINDS.includes(resources.get(row.baseResourceId)?.kind)).map(row => row.baseResourceId))];
      if (unresolved.length) fail('Some agents in this file are not Base agents here. Restore the board backup that carries them first, then import again. Nothing was imported.', 'NETWORK_IMPORT_UNRESOLVED', 409, { baseResourceIds: unresolved });
      if (agents.rows.length + bundle.agents.length > LIMITS.agents) fail(`Network holds at most ${LIMITS.agents} agent registrations. Nothing was imported.`, 'NETWORK_LIMIT', 409);
      const taken = new Set(agents.rows.map(row => row.id)), agentIds = new Map(bundle.agents.map(row => [row.id, taken.has(row.id) ? newId('agt') : row.id]));
      const networkIds = new Map(bundle.networks.map(draft => [draft.id, drafts.has(draft.id) ? newId('net') : draft.id]));
      const remap = nodes => nodes.map(node => node.type === 'agent' ? { ...node, agentId: agentIds.get(node.agentId) } : { ...node, networkId: networkIds.get(node.networkId) });
      const projects = new Set(await this.projects()), warnings = [], at = this.now();
      const rows = bundle.agents.map(row => {
        const allowed = row.projectAllowlist.filter(id => projects.has(id));
        if (allowed.length < row.projectAllowlist.length) warnings.push(`${row.displayName || agentIds.get(row.id)}: projects that are not on this board were removed from its access list.`);
        return { ...row, id: agentIds.get(row.id), enabled: false, projectAllowlist: allowed, updatedAt: at };
      });
      // Re-serialised in the fixed order: a version whose IDs were kept keeps its hash; a remapped one gets a new one.
      const versions = bundle.versions.map(item => { const body = { ...item, networkId: networkIds.get(item.networkId), nodes: remap(item.nodes) }, content = versionText(body); return { ...body, content, sha256: sha256(content) }; });
      const hashes = new Map(versions.map(item => [`${item.networkId}@${item.number}`, item.sha256]));
      const names = new Set([...drafts.values()].filter(draft => !draft.unavailable).map(draft => draft.name.toLocaleLowerCase()));
      const networks = bundle.networks.map(draft => {
        const id = networkIds.get(draft.id), name = freeName(draft.name, names);
        if (name !== draft.name) warnings.push(`The network "${draft.name}" was imported as "${name}".`);
        return { schema: SCHEMA.draft, version: 1, id, name, description: draft.description, revision: 1, createdAt: draft.createdAt, updatedAt: at, nodes: remap(draft.nodes), edges: draft.edges,
          publishedVersions: draft.publishedVersions.map(entry => ({ ...entry, sha256: hashes.get(`${id}@${entry.version}`) })), ...(draft.archived ? { archived: true } : {}) };
      });
      // Registrations first, then versions, then drafts: a saved draft never names a missing agent or file.
      const saved = rows.length ? await this.#saveAgents(agents, [...agents.rows, ...rows]) : agents;
      for (const item of versions) await writeImmutable(this.#versionPath(item.networkId, item.number, item.sha256), item.content);
      for (const draft of networks) await this.#saveDraft(draft);
      const changed = ids => Object.fromEntries([...ids].filter(([from, to]) => from !== to));
      return { revision: saved.revision, imported: { agents: rows.length, networks: networks.length, versions: versions.length }, remapped: { agents: changed(agentIds), networks: changed(networkIds) }, warnings };
    });
  }
}
