/**
 * Network pipelines (docs/network/architecture.md §5, §9, §20): execution DAGs that belong to one network and pin one
 * published version of it, kept as an editable draft plus immutable published versions. Their steps are agent,
 * subnetwork (a published pipeline of a contained network), condition, parallel, join, approval and output; their
 * execution edges carry ports and data and are stored here, never in the network's Graph, whose relation edges stay a
 * separate type that no pipeline reads.
 *
 * Storage (storage.mjs discipline), created on the first save: <dataDir>/network/pipelines/<id>.json (drafts, with .bak)
 * and pipelines/<id>/v<n>-<sha256>.json (published versions: written once, hash-checked on every read, never deleted).
 * Saving, validating or publishing never starts anything: a run starts only through the runner's explicit start.
 */
import { randomBytes } from 'node:crypto';
import { readdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { serial, syncDir } from '../durable.mjs';
import { escapeId } from '../origin.mjs';
import { compilePipeline, order, RULE_PATH } from './pipeline-compiler.mjs';
import { cleanText, conflict, fail, LINE_BREAK, newId, NetworkError, object, only, page, readDocument, readImmutable, requireRevision, sha256, writeDocument, writeImmutable } from './storage.mjs';

const SCHEMA = { draft: 'promptboard.pipeline-draft', version: 'promptboard.pipeline-version' };
const KIB = 1024, MINUTE = 60_000, HOUR = 60 * MINUTE;
/** Resource ceilings (architecture §4.2 rule 8): fixed errors, not product limits; the number of pipelines is unbounded. */
export const PIPELINE_LIMITS = Object.freeze({ nodes: 500, edges: 2000, draftBytes: 4096 * KIB, name: 80, description: 2000, label: 80, instructionsBytes: 32 * KIB, prompt: 2000,
  rules: 20, include: 50, inValues: 50, value: 1000, maxParallel: 4, minDeadlineMs: MINUTE, maxDeadlineMs: 24 * HOUR, retries: 2, minTimeoutMs: 1000, maxTimeoutMs: 120 * MINUTE, coordinate: 1e7 });
export const PIPELINE_SETTINGS = Object.freeze({ maxParallel: 2, deadlineMs: 2 * HOUR, failurePolicy: 'stop' });
export const STEP_TYPES = Object.freeze(['agent', 'subnetwork', 'condition', 'parallel', 'join', 'approval', 'output']);
/** The ports each step type sends on; every edge arrives on `input`. An output step sends nothing: it ends its pipeline. */
export const PORTS = Object.freeze({ agent: ['text', 'json'], subnetwork: ['text'], condition: ['true', 'false'], parallel: ['done'], join: ['done'], approval: ['done'], output: [] });
export const OPERATORS = Object.freeze(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'exists', 'contains']);
const LIMITS = PIPELINE_LIMITS;
const PIPELINE_ID = /^pip_[0-9a-f]{20}$/, NETWORK_ID = /^net_[0-9a-f]{20}$/, AGENT_ID = /^agt_[0-9a-f]{20}$/, NODE_ID = /^n_[0-9a-f]{12}$/, EDGE_ID = /^e_[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/, STEM = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/;

const whole = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const accepts = check => { try { check(); return true; } catch { return false; } };
const byCreated = (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1);
/** One-line owner text (names, labels), cleaned as the registry cleans it; a line break or tab is refused. */
function line(value, max, label, required = false) {
  if (!required && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || LINE_BREAK.test(value.trim())) fail(`${label} must be one line of text.`);
  const clean = cleanText(value);
  if ((required && !clean) || clean.length > max) fail(`${label} must contain ${required ? 1 : 0} to ${max} characters.`);
  return clean;
}
function long(value, label, max, inBytes = false) {
  if (value === undefined) return '';
  if (typeof value !== 'string') fail(`${label} must be text.`);
  if ((inBytes ? Buffer.byteLength(value) : value.length) > max) fail(`${label} holds at most ${inBytes ? `${max / KIB} KiB` : `${max} characters`}.`, 'NETWORK_LIMIT', 413);
  return cleanText(value);
}
const scalar = value => value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= LIMITS.value);

function settingsOf(input = {}) {
  only(input, ['maxParallel', 'deadlineMs', 'failurePolicy'], 'the pipeline settings');
  const { maxParallel = PIPELINE_SETTINGS.maxParallel, deadlineMs = PIPELINE_SETTINGS.deadlineMs, failurePolicy = PIPELINE_SETTINGS.failurePolicy } = input;
  if (!whole(maxParallel, 1, LIMITS.maxParallel)) fail(`maxParallel is a whole number from 1 to ${LIMITS.maxParallel} (the job pool's ceiling).`);
  if (!whole(deadlineMs, LIMITS.minDeadlineMs, LIMITS.maxDeadlineMs)) fail('deadlineMs is from 1 minute to 24 hours.');
  if (!['stop', 'continue_independent'].includes(failurePolicy)) fail('failurePolicy is stop or continue_independent.');
  return { maxParallel, deadlineMs, failurePolicy };
}
/** A condition rule: a path into an upstream step's json result, a fixed operator and a typed value. */
function ruleOf(input) {
  only(input, ['path', 'op', 'value'], 'a condition rule');
  const { path, op, value } = input;
  if (typeof path !== 'string' || !RULE_PATH.test(path)) fail('A rule reads <stepId>.json.<field>… of a step before it: letters, digits, _ and -, at most 8 fields.');
  if (!OPERATORS.includes(op)) fail(`A rule's op is ${OPERATORS.join(', ')}.`);
  if (op === 'exists') { if (value !== undefined) fail('exists takes no value.'); return { path, op }; }
  const number = ['lt', 'lte', 'gt', 'gte'].includes(op);
  if (number ? typeof value !== 'number' || !Number.isFinite(value) : op === 'in' ? !Array.isArray(value) || !value.length || value.length > LIMITS.inValues || !value.every(scalar) : !scalar(value)) {
    fail(number ? `${op} compares with a number.` : op === 'in' ? `in takes a list of 1 to ${LIMITS.inValues} values.` : `${op} takes text (≤ ${LIMITS.value} characters), a number, true, false or null.`);
  }
  return { path, op, value };
}
/** Each step type's config, strict (an unknown key is refused) and in a fixed key order (a version's hash depends on it). */
function configOf(type, input) {
  if (!object(input)) fail('A step config is a JSON object.');
  if (type === 'agent') {
    only(input, ['agentId', 'instructions', 'tools', 'timeoutMs', 'retries'], 'an agent step');
    const { agentId, tools = 'none', timeoutMs = null, retries = 0 } = input;
    if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) fail('An agent step names a registered agent.');
    if (!['none', 'web'].includes(tools)) fail('Tools are none or web.');
    if (timeoutMs !== null && !whole(timeoutMs, LIMITS.minTimeoutMs, LIMITS.maxTimeoutMs)) fail('A step time limit (timeoutMs) is from 1 second to 120 minutes, or null for the job default.');
    if (!whole(retries, 0, LIMITS.retries)) fail(`retries is 0 to ${LIMITS.retries}: how many times a failed step is tried again.`);
    return { agentId, instructions: long(input.instructions, 'The step instructions', LIMITS.instructionsBytes, true), tools, timeoutMs, retries };
  }
  if (type === 'subnetwork') {
    only(input, ['pipelineId', 'version'], 'a sub-pipeline step');
    if (typeof input.pipelineId !== 'string' || !PIPELINE_ID.test(input.pipelineId) || !whole(input.version, 1, 1e9)) fail('A sub-pipeline step pins a published pipeline: pipelineId and version.');
    return { pipelineId: input.pipelineId, version: input.version };
  }
  if (type === 'condition') {
    only(input, ['all', 'any'], 'a condition step');
    const keys = Object.keys(input), list = input[keys[0]];
    if (keys.length !== 1 || !Array.isArray(list) || !list.length || list.length > LIMITS.rules) fail(`A condition has all or any: a list of 1 to ${LIMITS.rules} rules.`);
    return { [keys[0]]: list.map(ruleOf) };
  }
  if (type === 'join') {
    only(input, ['require'], 'a join step');
    const { require = 'all' } = input;
    if (!['all', 'any'].includes(require)) fail('A join requires all or any of the steps before it.');
    return { require };
  }
  if (type === 'approval') { only(input, ['prompt'], 'an approval step'); return { prompt: long(input.prompt, 'The approval prompt', LIMITS.prompt) }; }
  if (type === 'output') {
    only(input, ['name', 'include'], 'an output step');
    const { name = 'report', include } = input;
    if (typeof name !== 'string' || !STEM.test(name)) fail('An output name is a file name: letters, digits, _ and -, at most 60.');
    if (!Array.isArray(include) || !include.length || include.length > LIMITS.include || include.some(id => typeof id !== 'string' || !NODE_ID.test(id)) || new Set(include).size !== include.length) fail(`An output includes 1 to ${LIMITS.include} different steps, in order.`);
    return { name, include: [...include] };
  }
  only(input, [], 'a parallel step');
  return {};
}
function position(value) {
  if (!object(value) || Object.keys(value).length !== 2 || ![value.x, value.y].every(n => Number.isFinite(n) && Math.abs(n) <= LIMITS.coordinate)) fail('Each step needs a position { x, y } of finite numbers.');
  return { x: value.x, y: value.y };
}
function nodesOf(value) {
  if (!Array.isArray(value) || value.length > LIMITS.nodes) fail(`A pipeline holds at most ${LIMITS.nodes} steps.`, 'NETWORK_LIMIT', 413);
  const ids = new Set();
  return value.map(node => {
    if (!object(node) || !STEP_TYPES.includes(node.type)) fail(`A step is ${STEP_TYPES.join(', ')}.`);
    only(node, ['id', 'type', 'label', 'position', 'config'], 'a pipeline step');
    if (typeof node.id !== 'string' || !NODE_ID.test(node.id) || ids.has(node.id)) fail('Each step needs its own ID: n_ and 12 hexadecimal characters.');
    ids.add(node.id);
    return { id: node.id, type: node.type, label: line(node.label, LIMITS.label, 'A step label'), position: position(node.position), config: configOf(node.type, node.config ?? {}) };
  });
}
/** Execution edges: ports per step type, no self edge, no duplicate, and no loop (a pipeline runs each step once). */
function edgesOf(value, nodes) {
  if (!Array.isArray(value) || value.length > LIMITS.edges) fail(`A pipeline holds at most ${LIMITS.edges} execution edges.`, 'NETWORK_LIMIT', 413);
  const byId = new Map(nodes.map(node => [node.id, node])), ids = new Set(), keys = new Set();
  const edges = value.map(edge => {
    only(edge, ['id', 'from', 'to', 'fromPort', 'toPort'], 'an execution edge');
    if (typeof edge.id !== 'string' || !EDGE_ID.test(edge.id) || ids.has(edge.id)) fail('Each execution edge needs its own ID: e_ and 12 hexadecimal characters.');
    ids.add(edge.id);
    const from = byId.get(edge.from), to = byId.get(edge.to), where = { edgeId: edge.id };
    if (!from || !to || from === to) fail('An execution edge connects two different steps of this pipeline.', 'INVALID_INPUT', 400, where);
    if (!PORTS[from.type].includes(edge.fromPort)) fail(from.type === 'output' ? 'An output step ends its pipeline: nothing leaves it.' : `A ${from.type} step sends on ${PORTS[from.type].join(' or ')}.`, 'PIPELINE_PORT', 400, where);
    if ((edge.toPort ?? 'input') !== 'input') fail('Every step receives on its input port.', 'PIPELINE_PORT', 400, where);
    const key = `${edge.from}>${edge.fromPort}>${edge.to}`;
    if (keys.has(key)) fail('This execution edge already exists.', 'INVALID_INPUT', 400, where);
    keys.add(key);
    return { id: edge.id, from: edge.from, to: edge.to, fromPort: edge.fromPort, toPort: 'input' };
  });
  const loop = order(nodes.map(node => node.id), edges.map(edge => [edge.from, edge.to])).cycle;
  if (loop) fail('The execution edges form a loop. Pipelines run each step once: remove an edge of the loop (a step may retry instead).', 'PIPELINE_CYCLE', 400, { path: loop });
  for (const node of nodes) {
    const named = node.type === 'condition' ? (node.config.all || node.config.any).map(rule => RULE_PATH.exec(rule.path)[1]) : node.type === 'output' ? node.config.include : [];
    const missing = named.find(id => !byId.has(id) || id === node.id);
    if (missing) fail('A condition or output names a step that is not another step of this pipeline.', 'PIPELINE_REFERENCE_INVALID', 400, { nodeId: node.id, missing });
  }
  return edges;
}
/** Name, description, settings, steps and edges; `previous` keeps what a change leaves out. Changed steps re-check every edge. */
function content(input, previous = { description: '', settings: PIPELINE_SETTINGS, nodes: [], edges: [] }) {
  const has = key => Object.hasOwn(input, key), nodes = has('nodes') ? nodesOf(input.nodes) : previous.nodes;
  return { name: has('name') || previous.name === undefined ? line(input.name, LIMITS.name, 'Pipeline name', true) : previous.name,
    description: has('description') ? long(input.description, 'The description', LIMITS.description) : previous.description,
    settings: has('settings') ? settingsOf(input.settings) : previous.settings,
    nodes, edges: has('nodes') || has('edges') ? edgesOf(has('edges') ? input.edges : previous.edges, nodes) : previous.edges };
}
const storedDraft = data => PIPELINE_ID.test(data.id) && NETWORK_ID.test(data.networkId) && whole(data.networkVersion, 1, 1e9) && Number.isSafeInteger(data.revision) && Number.isSafeInteger(data.createdAt)
  && Array.isArray(data.publishedVersions) && data.publishedVersions.every((entry, index) => entry?.version === index + 1 && SHA.test(entry.sha256)) && accepts(() => content(data, {}));
/** The exact bytes of a published version, in a fixed key order: the same content always has the same hash. */
const versionText = ({ pipelineId, number, publishedAt, networkId, networkVersion, name, description, settings, nodes, edges }) =>
  JSON.stringify({ schema: SCHEMA.version, version: 1, pipelineId, number, publishedAt, networkId, networkVersion, name, description, settings, nodes, edges });
const summary = plan => ({ steps: plan.nodes.length, agentSteps: plan.nodes.filter(step => step.type === 'agent').length, groups: plan.groups.length, order: plan.nodes.map(step => step.id), pins: plan.pins });

export class NetworkPipelines {
  /** `registry` is the NetworkRegistry: networks, their published versions and agent registrations are read through it. */
  constructor({ dataDir, registry, now = Date.now }) { Object.assign(this, { dir: join(dataDir, 'network', 'pipelines'), registry, now }); }
  // ponytail: one queue for every pipeline draft; per-file queues if owner edits ever contend.
  #serial = serial();
  #drafts = null; // id → draft, or { id, unavailable, message } for a draft that cannot be read.
  #versions = new Map(); // `${id}@${n}` → verified published version (immutable, so safe to keep).

  #draftPath(id) { return join(this.dir, `${escapeId(id)}.json`); }
  #versionPath(id, number, hash) { return join(this.dir, escapeId(id), `v${number}-${hash}.json`); }
  // ponytail: the first read loads every draft one after another; bounded concurrency past ~1,000 pipelines.
  async #loadDrafts() {
    if (this.#drafts) return this.#drafts;
    let names = [];
    try { names = await readdir(this.dir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const ids = [...new Set(names.map(name => /^pip__([0-9a-f]{20})\.json(?:\.bak)?$/.exec(name)?.[1]).filter(Boolean))].sort().map(hex => `pip_${hex}`), drafts = new Map();
    for (const id of ids) {
      try {
        const draft = await readDocument(this.#draftPath(id), { schema: SCHEMA.draft, label: 'A saved pipeline', valid: data => data.id === id && storedDraft(data) });
        if (draft) drafts.set(id, draft);
      } catch (error) { if (!(error instanceof NetworkError)) throw error; drafts.set(id, { id, unavailable: error.code, message: error.message }); }
    }
    return this.#drafts = drafts;
  }
  async #draft(id) {
    const draft = typeof id === 'string' && PIPELINE_ID.test(id) ? (await this.#loadDrafts()).get(id) : null;
    if (!draft) fail('This pipeline does not exist.', 'NOT_FOUND', 404);
    if (draft.unavailable) fail(draft.message, draft.unavailable, 409);
    return draft;
  }
  async #version(id, number) {
    const key = `${id}@${number}`;
    if (this.#versions.has(key)) return this.#versions.get(key);
    const entry = (await this.#draft(id)).publishedVersions.find(item => item.version === number);
    if (!entry) fail('This published pipeline version does not exist.', 'NOT_FOUND', 404);
    const body = await readImmutable(this.#versionPath(id, number, entry.sha256), entry.sha256, { schema: SCHEMA.version,
      valid: data => data.pipelineId === id && data.number === number && NETWORK_ID.test(data.networkId) && whole(data.networkVersion, 1, 1e9) && accepts(() => content(data, {})) });
    const version = { ...body, sha256: entry.sha256 };
    this.#versions.set(key, version);
    return version;
  }
  async #save(draft) {
    if (Buffer.byteLength(JSON.stringify(draft)) > LIMITS.draftBytes) fail(`A pipeline holds at most ${LIMITS.draftBytes / KIB / KIB} MiB. Move steps into a sub-pipeline.`, 'NETWORK_LIMIT', 413);
    await writeDocument(this.#draftPath(draft.id), draft);
    (await this.#loadDrafts()).set(draft.id, draft);
    return draft;
  }
  /** The network version a pipeline pins must be published; its network is fixed when the pipeline is created. */
  async #checkNetwork(networkId, networkVersion) {
    if (typeof networkId !== 'string' || !NETWORK_ID.test(networkId) || !whole(networkVersion, 1, 1e9)) fail('A pipeline belongs to a network and pins one of its published versions (networkId, networkVersion).');
    await this.registry.version(networkId, networkVersion).catch(error => { if (error.code === 'NOT_FOUND') fail('Choose a published version of a saved network. Publish the network in Graph first.', 'PIPELINE_NETWORK_INVALID', 409, { networkId, networkVersion }); throw error; });
  }
  #uniqueName(drafts, { name, networkId }, id) {
    const key = name.toLocaleLowerCase();
    if ([...drafts.values()].some(draft => draft.id !== id && !draft.unavailable && draft.networkId === networkId && draft.name.toLocaleLowerCase() === key)) fail('Another pipeline of this network already has this name.', 'PIPELINE_NAME_TAKEN', 409);
  }

  /**
   * The plan of a definition (a published version, or a draft for validate): see pipeline-compiler.mjs. Sub-pipelines and
   * network versions are read as published (hash-checked); agents as the registry shows them now.
   */
  async compile(root) {
    return compilePipeline(root, {
      pipeline: (id, number) => this.#version(id, number).catch(error => { if (error.code === 'NOT_FOUND') fail('A sub-pipeline step names a pipeline version that is not published.', 'PIPELINE_REFERENCE_INVALID', 400, { pipelineId: id, version: number }); throw error; }),
      network: async (id, number) => (await this.registry.version(id, number).catch(error => { if (error.code === 'NOT_FOUND') fail('A pipeline pins a network version that is not published.', 'PIPELINE_NETWORK_INVALID', 409, { networkId: id, networkVersion: number }); throw error; })).version,
      agent: async id => (await this.registry.agent(id)).agent,
    });
  }
  #root(source, version = null) {
    return { pipelineId: source.pipelineId ?? source.id, version, sha256: version ? source.sha256 : null, name: source.name, networkId: source.networkId, networkVersion: source.networkVersion, settings: source.settings, nodes: source.nodes, edges: source.edges };
  }

  async list({ q, networkId, offset, limit } = {}) {
    if (q !== undefined && (typeof q !== 'string' || q.length > 200)) fail('Search with at most 200 characters.');
    if (networkId !== undefined && !NETWORK_ID.test(networkId)) fail('Filter by a valid network ID.');
    const query = q?.toLocaleLowerCase();
    return this.#serial(async () => {
      const drafts = [...(await this.#loadDrafts()).values()];
      const items = drafts.filter(draft => !draft.unavailable && (!networkId || draft.networkId === networkId) && (!query || `${draft.name}\n${draft.description}`.toLocaleLowerCase().includes(query))).sort(byCreated)
        .map(({ id, name, description, networkId: network, networkVersion, revision, createdAt, updatedAt, nodes, edges, publishedVersions }) => ({ id, name, description, networkId: network, networkVersion, revision, createdAt, updatedAt, stepCount: nodes.length, edgeCount: edges.length, publishedVersions }));
      return { ...page(items, offset, limit, 'pipelines'), unavailable: drafts.filter(draft => draft.unavailable).map(({ id, unavailable }) => ({ id, code: unavailable })) };
    });
  }
  async get(id) { return this.#serial(async () => ({ pipeline: await this.#draft(id) })); }
  async version(id, number) { return this.#serial(async () => ({ version: await this.#version(id, number) })); }
  async create(input) {
    only(input, ['networkId', 'networkVersion', 'name', 'description', 'settings', 'nodes', 'edges'], 'a pipeline');
    const fields = content(input);
    await this.#checkNetwork(input.networkId, input.networkVersion);
    return this.#serial(async () => {
      const id = newId('pip'), at = this.now();
      this.#uniqueName(await this.#loadDrafts(), { name: fields.name, networkId: input.networkId }, id);
      return { pipeline: await this.#save({ schema: SCHEMA.draft, version: 1, id, networkId: input.networkId, networkVersion: input.networkVersion, ...fields, revision: 1, createdAt: at, updatedAt: at, publishedVersions: [] }) };
    });
  }
  /** Save the draft. Published versions are separate files and never change; runs keep their own compiled plan. */
  async update(id, input) {
    only(input, ['expectedRevision', 'name', 'description', 'networkVersion', 'settings', 'nodes', 'edges'], 'a pipeline');
    requireRevision(input);
    return this.#serial(async () => {
      const draft = await this.#draft(id);
      if (input.expectedRevision !== draft.revision) conflict('This pipeline');
      const fields = content(input, draft), networkVersion = input.networkVersion ?? draft.networkVersion;
      if (networkVersion !== draft.networkVersion) await this.#checkNetwork(draft.networkId, networkVersion);
      this.#uniqueName(await this.#loadDrafts(), { name: fields.name, networkId: draft.networkId }, id);
      return { pipeline: await this.#save({ ...draft, ...fields, networkVersion, revision: draft.revision + 1, updatedAt: this.now() }) };
    });
  }
  /** Delete a pipeline that was never published (no run or other pipeline can name it); its files are set aside, not erased. */
  async remove(id, input) {
    only(input, ['expectedRevision'], 'a delete request');
    requireRevision(input);
    return this.#serial(async () => {
      const draft = await this.#draft(id);
      if (input.expectedRevision !== draft.revision) conflict('This pipeline');
      if (draft.publishedVersions.length) fail(`“${draft.name}” has published versions, which runs and other pipelines may pin, so it cannot be deleted. Nothing was deleted.`, 'PIPELINE_PUBLISHED', 409);
      const file = this.#draftPath(id), stamp = `${this.now()}-${randomBytes(4).toString('hex')}`;
      try {
        for (const path of [`${file}.bak`, file]) await rename(path, `${path}.deleted-${stamp}`).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await syncDir(dirname(file));
      } catch { fail('The pipeline could not be deleted. Check folder permissions and try again.', 'NETWORK_WRITE_FAILED', 500); }
      (await this.#loadDrafts()).delete(id);
      return { deleted: { id, name: draft.name } };
    });
  }
  /**
   * Compile the draft (or `{ version }`) as a run would, without running it: `{ valid: true, summary }`, or `{ valid: false,
   * error: { code, message, details } }` for what the owner must fix.
   */
  async validate(id, input = {}) {
    only(input, ['version'], 'a validate request');
    if (input.version !== undefined && !whole(input.version, 1, 1e9)) fail('Choose a published version number, or none for the draft.');
    const source = input.version ? await this.#serial(() => this.#version(id, input.version)) : await this.#serial(() => this.#draft(id));
    try { return { valid: true, summary: summary(await this.compile(this.#root(source, input.version ?? null))) }; }
    catch (error) { if (!(error instanceof NetworkError) || error.status >= 500) throw error; return { valid: false, error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }; }
  }
  /** Publish the draft as the next immutable version, only when it compiles now: its file first, then the draft names it. */
  async publish(id, input) {
    only(input, ['expectedRevision'], 'a publish request');
    requireRevision(input);
    return this.#serial(async () => {
      const draft = await this.#draft(id);
      if (input.expectedRevision !== draft.revision) conflict('This pipeline');
      const plan = await this.compile(this.#root(draft));
      const number = (draft.publishedVersions.at(-1)?.version || 0) + 1, publishedAt = this.now();
      const text = versionText({ pipelineId: id, number, publishedAt, networkId: draft.networkId, networkVersion: draft.networkVersion, name: draft.name, description: draft.description, settings: draft.settings, nodes: draft.nodes, edges: draft.edges });
      const hash = sha256(text);
      await writeImmutable(this.#versionPath(id, number, hash), text, 'The published pipeline version');
      const published = { version: number, sha256: hash, publishedAt, networkVersion: draft.networkVersion };
      return { pipeline: await this.#save({ ...draft, revision: draft.revision + 1, updatedAt: publishedAt, publishedVersions: [...draft.publishedVersions, published] }), published, summary: summary(plan) };
    });
  }
  /** The plan of a published version, compiled now (agents as they are now): what a run starts from. */
  async plan(id, number) {
    const version = await this.#serial(() => this.#version(id, number));
    return this.compile(this.#root(version, number));
  }
}
