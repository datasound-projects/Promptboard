/** Local Base registry. The caller injects Board's Store; this module never opens state.json. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, posix } from 'node:path';
import { resolveConfig } from './agents.mjs';
import { normalizeAvatarImage } from './base-avatar.mjs';

export const BASE_KINDS = Object.freeze(['skill', 'mcp', 'knowledge', 'context', 'tool', 'profile', 'pack']);
export const BASE_EXPORT_VERSION = 1;
export const BASE_LIMITS = Object.freeze({ resources: 2000, documentChars: 256 * 1024, contentBytes: 4 * 1024 * 1024, definitionBytes: 4 * 1024 * 1024 + 512 * 1024, importBytes: 12 * 1024 * 1024, refs: 200, files: 200 });
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const ENV = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const BUILTIN_COLUMNS = ['todo', 'planning', 'executing', 'code_review', 'testing', 'merge', 'done'];
const active = run => ['queued', 'running', 'waiting_for_input'].includes(run.status);
const hash = value => createHash('sha256').update(value).digest('hex');
export class BaseError extends Error {
  constructor(message, code = 'BASE_INVALID_INPUT', status = 400, details) { super(message); this.code = code; this.status = status; if (details) this.details = details; }
}
const fail = message => { throw new BaseError(message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function string(value, max, label, required = false) {
  if (value === undefined || value === null) { if (required) fail(`${label} is required.`); return ''; }
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (required && !value.trim())) fail(`${label} must contain ${required ? '1' : '0'} to ${max} characters.`);
  return value;
}
function id(value, label = 'Resource ID') { if (typeof value !== 'string' || !ID.test(value)) fail(`${label} is invalid.`); return value; }
function strings(input, max, length, label) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > max) fail(`${label} is too large.`);
  return [...new Set(input.map(value => string(value, length, label, true)))];
}
function argumentsList(input = []) {
  if (!Array.isArray(input) || input.length > 100) fail('At most 100 command arguments are supported.');
  return input.map(value => string(value, 4096, 'Command argument'));
}
export function normalizeReferences(input = []) {
  if (!Array.isArray(input) || input.length > BASE_LIMITS.refs) fail('Select at most 200 resource references.');
  const refs = new Map();
  for (const value of input) {
    const entry = typeof value === 'string' ? { resourceId: value, required: true } : value;
    if (!object(entry) || (entry.required !== undefined && typeof entry.required !== 'boolean')) fail('Resource references need an ID and a required flag.');
    refs.set(id(entry.resourceId), { resourceId: entry.resourceId, required: entry.required !== false });
  }
  return [...refs.values()];
}
export function normalizeBinding(input = { mode: 'inherit' }) {
  if (!object(input) || !['inherit', 'extend', 'replace'].includes(input.mode)) fail('Choose Inherit, Extend, or Replace for Base resources.');
  const include = normalizeReferences(input.include);
  const exclude = strings(input.exclude, BASE_LIMITS.refs, 100, 'Excluded resources').map(value => id(value));
  if (input.mode === 'inherit' && (include.length || exclude.length)) fail('Inherit cannot contain additions or exclusions. Choose Extend.');
  return { mode: input.mode, include, exclude };
}
export function remapBinding(binding, remap) {
  if (!binding) return undefined;
  const mapped = normalizeBinding(binding);
  const lookup = value => { if (!Object.hasOwn(remap, value)) fail(`The imported reference ${value} is missing from the Base bundle.`); return id(remap[value]); };
  return { ...mapped, include: mapped.include.map(ref => ({ ...ref, resourceId: lookup(ref.resourceId) })), exclude: mapped.exclude.map(lookup) };
}
/** Return only Base-specific fields; missing IDs are refused instead of rebound to this installation. */
export function remapBaseScopes(entity, remap) {
  const out = {};
  if (entity?.baseBinding) out.baseBinding = remapBinding(entity.baseBinding, remap);
  if (entity?.agentProfileId) { if (!Object.hasOwn(remap, entity.agentProfileId)) fail('The imported agent profile is missing.'); out.agentProfileId = id(remap[entity.agentProfileId]); }
  if (entity?.baseColumns) {
    if (!object(entity.baseColumns) || Object.keys(entity.baseColumns).length > 32) fail('Invalid imported column resources.');
    out.baseColumns = Object.fromEntries(Object.entries(entity.baseColumns).map(([columnId, entry]) => {
      id(columnId, 'Column ID');
      const scope = { binding: remapBinding(entry.binding || { mode: 'inherit' }, remap), baseRevision: 1 };
      if (entry.profileId) { if (!Object.hasOwn(remap, entry.profileId)) fail('The imported column profile is missing.'); scope.profileId = id(remap[entry.profileId]); }
      return [columnId, scope];
    }));
  }
  if (Object.keys(out).length) out.baseRevision = 1;
  return out;
}
function envReferences(value, label, headers = false) {
  if (value === undefined) return {};
  if (!object(value) || Object.keys(value).length > 40) fail(`${label} must map names to environment-variable names.`);
  const out = {};
  for (const [key, reference] of Object.entries(value)) {
    if (!(headers ? /^[A-Za-z0-9-]{1,100}$/ : ENV).test(key) || !ENV.test(reference) || ['__proto__', 'constructor', 'prototype'].includes(key)) fail(`${label} accepts environment-variable references, never credential values.`);
    out[key] = reference;
  }
  return out;
}
function endpoint(value, label) {
  const raw = string(value, 4096, label, true);
  let url; try { url = new URL(raw); } catch { fail(`${label} must be an HTTP or HTTPS URL.`); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => /token|secret|password|api.?key|authorization/i.test(key))) fail(`${label} must not include credentials. Use environment references.`);
  return url.href;
}
function integer(value, fallback, min, max, label) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label} must be between ${min} and ${max}.`);
  return value;
}
function filePath(value) {
  const path = string(value, 500, 'Supporting file path', true).replaceAll('\\', '/');
  if (isAbsolute(path) || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..') || posix.normalize(path) !== path) fail('Supporting files must use contained relative paths.');
  if (path.split('/').some(part => /^(?:\.env(?:\..*)?|\.git|node_modules|id_rsa|id_ed25519|credentials?(?:\..*)?)$/i.test(part))) fail('Secret files and dependency folders cannot be imported.');
  return path;
}
function provenance(value = {}) {
  if (!object(value)) fail('Source provenance must be an object.');
  return { ...(value.path ? { path: string(value.path, 4096, 'Source path') } : {}), ...(value.url ? { url: endpoint(value.url, 'Source URL') } : {}),
    ...(value.section ? { section: string(value.section, 200, 'Source section') } : {}), ...(Number.isFinite(value.retrievedAt) ? { retrievedAt: value.retrievedAt } : {}),
    ...(typeof value.hash === 'string' && /^[a-f0-9]{64}$/.test(value.hash) ? { hash: value.hash } : {}),
    ...(typeof value.contentHash === 'string' && /^[a-f0-9]{64}$/.test(value.contentHash) ? { contentHash: value.contentHash } : {}),
    ...(value.resourceId ? { resourceId: id(value.resourceId) } : {}), ...(value.rootId ? { rootId: id(value.rootId) } : {}),
    ...(value.kind ? { kind: string(value.kind, 40, 'Source kind') } : {}), ...(Number.isSafeInteger(value.revision) && value.revision > 0 ? { revision: value.revision } : {}),
    ...(Number.isFinite(value.generatedAt) ? { generatedAt: value.generatedAt } : {}), ...(value.sourceIds ? { sourceIds: strings(value.sourceIds, 200, 100, 'Source IDs').map(sourceId => id(sourceId)) } : {}),
    ...(['paste', 'user-selected-file', 'refresh'].includes(value.method) ? { method: value.method } : {}), ...(typeof value.capturedAt === 'string' && value.capturedAt.length <= 40 && Number.isFinite(Date.parse(value.capturedAt)) ? { capturedAt: new Date(value.capturedAt).toISOString() } : {}),
    ...(value.sources ? { sources: (() => { if (!Array.isArray(value.sources) || value.sources.length > 200) fail('Too many provenance sources.'); return value.sources.map(source => {
      if (!object(source)) fail('Invalid provenance source.');
      const { sources, ...flat } = source; return { ...(source.id ? { id: id(source.id) } : {}), ...provenance(flat) };
    }); })() } : {}) };
}
export function normalizeContent(input = {}) {
  if (!object(input)) fail('Resource content must be an object.');
  const result = { body: string(input.body, BASE_LIMITS.documentChars, 'Instructions'), files: [], pages: [], sources: [] };
  if (input.avatar !== undefined) result.avatar = normalizeAvatarImage(input.avatar);
  for (const key of ['files', 'pages', 'sources']) if (input[key] !== undefined && (!Array.isArray(input[key]) || input[key].length > BASE_LIMITS.files)) fail(`Too many ${key}.`);
  const paths = new Set();
  for (const file of input.files || []) {
    if (!object(file)) fail('Supporting files need a path and text.');
    const path = filePath(file.path); if (paths.has(path)) fail('Supporting file paths must be unique.'); paths.add(path);
    const text = string(file.text, BASE_LIMITS.documentChars, 'Supporting file text'); result.files.push({ path, text, hash: hash(text) });
  }
  for (const page of input.pages || []) {
    if (!object(page)) fail('Wiki pages need a title and Markdown.');
    const markdown = string(page.markdown, BASE_LIMITS.documentChars, 'Page Markdown');
    result.pages.push({ id: id(page.id || randomUUID(), 'Page ID'), title: string(page.title, 160, 'Page title', true), markdown,
      links: strings(page.links, 100, 100, 'Page links').map(link => id(link, 'Linked page ID')), provenance: provenance(page.provenance), hash: hash(markdown) });
  }
  if (new Set(result.pages.map(page => page.id)).size !== result.pages.length) fail('Wiki page IDs must be unique.');
  for (const source of input.sources || []) {
    if (!object(source)) fail('Sources need a name and text.');
    const text = string(source.text, BASE_LIMITS.documentChars, 'Source text');
    result.sources.push({ id: id(source.id || randomUUID(), 'Source ID'), name: string(source.name || 'Source', 160, 'Source name', true), text, provenance: provenance(source.provenance), hash: hash(text) });
  }
  if (Buffer.byteLength(JSON.stringify(result)) > BASE_LIMITS.contentBytes) fail('Resource content exceeds the 4 MiB limit.');
  return result;
}
function configuration(kind, value = {}) {
  if (!object(value)) fail('Resource configuration must be an object.');
  if (kind === 'skill') return { format: 'instruction', entrypoint: filePath(value.entrypoint || 'SKILL.md') };
  if (kind === 'knowledge' && value.sources === undefined) return {};
  if (kind === 'pack') return { resources: normalizeReferences(value.resources) };
  if (kind === 'profile') {
    if (value.agent !== undefined && !object(value.agent)) fail('Profile agent settings must be an object.');
    const agent = value.agent?.provider ? resolveConfig('executing', value.agent) : {};
    let avatar;
    if (value.avatar !== undefined) {
      if (!object(value.avatar) || value.avatar.version !== 2 || !/^[a-f0-9]{64}$/.test(value.avatar.contentHash || '')) fail('Choose a valid generated agent avatar.');
      avatar = { version: 2, contentHash: value.avatar.contentHash, model: string(value.avatar.model, 120, 'Image model', true), prompt: string(value.avatar.prompt, 2000, 'Avatar prompt'), contentStatus: value.avatar.contentStatus === 'omitted' ? 'omitted' : 'available' };
    }
    return { agent: { ...agent, instructions: string(value.agent?.instructions, 4000, 'Profile stage instructions') }, binding: normalizeBinding(value.binding), ...(avatar ? { avatar } : {}) };
  }
  if (kind === 'mcp') {
    const transport = value.transport || 'stdio';
    if (!['stdio', 'streamable-http'].includes(transport)) fail('MCP transport must be stdio or Streamable HTTP.');
    const auth = value.auth || {};
    const common = { transport, env: envReferences(value.env, 'Environment'), headers: envReferences(value.headers, 'Headers', true), auth: { required: auth.required === true || value.authRequired === true, description: string(auth.description, 500, 'Authentication description') } };
    return transport === 'stdio' ? { ...common, command: string(value.command, 4096, 'MCP command', true), args: argumentsList(value.args) } : { ...common, endpoint: endpoint(value.endpoint, 'MCP endpoint') };
  }
  if (kind === 'tool') {
    if (value.delivery === 'mcp') return { delivery: 'mcp', serverId: id(value.serverId, 'Parent MCP server'), toolName: string(value.toolName, 200, 'Discovered tool name', true) };
    if (value.delivery && value.delivery !== 'command-recipe') fail('Supported tool delivery is a command recipe or an MCP tool reference.');
    return { delivery: 'command-recipe', command: string(value.command, 4096, 'Recipe command', true), args: argumentsList(value.args) };
  }
  if (!Array.isArray(value.sources) || value.sources.length > 100) fail('Context needs a bounded source list.');
  return { sources: value.sources.map(source => {
    if (!object(source) || !['repository', 'external', 'knowledge', 'url'].includes(source.kind)) fail('Choose a supported context source.');
    if (source.kind === 'knowledge') return { kind: source.kind, resourceId: id(source.resourceId), ...(source.pageId ? { pageId: id(source.pageId) } : {}) };
    if (source.kind === 'url') return { kind: source.kind, url: endpoint(source.url, 'Documentation URL') };
    return { kind: source.kind, path: !source.path || source.path === '.' ? '.' : filePath(source.path), ...(source.kind === 'external' ? { rootId: id(source.rootId, 'Approved root ID') } : {}) };
  }), budgetChars: integer(value.budgetChars, 24000, 1000, 100000, 'Context budget'), maxFiles: integer(value.maxFiles, 30, 1, 100, 'File limit'), query: string(value.query, 500, 'Retrieval query') };
}
/** References used for graph validation and dependency closure; bindings remain distinct from provider settings. */
export function resourceReferences(resource) {
  const refs = [...(resource.dependencies || [])];
  if (resource.kind === 'pack') refs.push(...(resource.configuration?.resources || []));
  if (resource.kind === 'profile') refs.push(...(resource.configuration?.binding?.include || []));
  if (resource.kind === 'tool' && resource.configuration?.delivery === 'mcp') refs.push({ resourceId: resource.configuration.serverId, required: true });
  if (['context', 'knowledge'].includes(resource.kind)) for (const source of resource.configuration?.sources || []) if (source.kind === 'knowledge') refs.push({ resourceId: source.resourceId, required: true });
  return refs;
}
export function validateResourceGraph(resources) {
  const byId = new Map(resources.map(resource => [resource.id, resource]));
  if (byId.size !== resources.length) fail('Resource IDs must be unique.');
  const visited = new Set(), visiting = new Set();
  function visit(resource) {
    if (visiting.has(resource.id)) throw new BaseError('Resource dependencies contain a cycle.', 'BASE_DEPENDENCY_CYCLE');
    if (visited.has(resource.id)) return;
    visiting.add(resource.id);
    for (const ref of resourceReferences(resource)) {
      const dependency = byId.get(ref.resourceId);
      if (!dependency) throw new BaseError(`Resource “${resource.name}” refers to a missing resource.`, 'BASE_DEPENDENCY_MISSING');
      if (resource.kind === 'pack' && ['pack', 'profile'].includes(dependency.kind)) fail('Packs cannot contain other packs or agent profiles.');
      if (resource.kind === 'tool' && resource.configuration?.delivery === 'mcp' && ref.resourceId === resource.configuration.serverId && dependency.kind !== 'mcp') fail('An MCP tool must reference an MCP server.');
      if (['context', 'knowledge'].includes(resource.kind) && resource.configuration?.sources?.some(source => source.resourceId === ref.resourceId) && dependency.kind !== 'knowledge') fail('A knowledge context source must reference a knowledge collection.');
      visit(dependency);
    }
    visiting.delete(resource.id); visited.add(resource.id);
  }
  resources.forEach(visit);
  // Containers cannot be smuggled into a pack through an ordinary member's dependencies.
  for (const pack of resources.filter(resource => resource.kind === 'pack')) {
    const seen = new Set();
    const inspect = resource => {
      if (seen.has(resource.id)) return;
      seen.add(resource.id);
      for (const ref of resourceReferences(resource)) {
        const dependency = byId.get(ref.resourceId);
        if (['pack', 'profile'].includes(dependency.kind)) fail('Packs cannot contain other packs or agent profiles, including through dependencies.');
        inspect(dependency);
      }
    };
    inspect(pack);
  }
  return true;
}
function normalizeResource(input, previous, { imported = false, omitted = false } = {}) {
  if (!object(input)) fail('Choose a supported Base resource type.');
  const requestedKind = input.kind || (input.type === 'agent' ? 'profile' : input.type) || previous?.kind;
  if (!BASE_KINDS.includes(requestedKind)) fail('Choose a supported Base resource type.');
  const kind = requestedKind;
  const type = kind === 'profile' ? 'agent' : kind;
  if (input.type !== undefined && input.type !== type) fail('Resource type must match its stored kind.');
  if (previous && previous.kind !== kind) fail('A resource type cannot change. Create a new resource instead.');
  const content = normalizeContent(input.content ?? previous?.content);
  const config = configuration(kind, input.configuration ?? previous?.configuration);
  if (kind === 'profile' && config.avatar && config.avatar.contentStatus !== 'omitted' && !omitted && content.avatar?.contentHash !== config.avatar.contentHash) fail('Avatar content does not match this profile’s saved face.');
  if (kind === 'skill' && !omitted && !content.body.trim() && !content.files.some(file => file.path === config.entrypoint && file.text.trim())) fail('An instruction skill needs instructions or a SKILL.md file.');
  const trust = imported ? 'untrusted' : input.trust ?? previous?.trust ?? (['mcp', 'tool'].includes(kind) ? 'untrusted' : 'trusted');
  if (!['trusted', 'untrusted', 'revoked'].includes(trust)) fail('Trust must be trusted, untrusted, or revoked.');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') fail('Availability must be a boolean.');
  const now = Date.now();
  return { id: previous?.id || id(input.id || randomUUID()), kind, type, name: string(input.name ?? previous?.name, 120, 'Resource name', true).trim(),
    description: string(input.description ?? previous?.description, 2000, 'Resource description'), tags: strings(input.tags ?? previous?.tags, 30, 80, 'Tags'),
    enabled: imported ? false : input.enabled ?? previous?.enabled ?? true, trust, revision: (previous?.revision || 0) + 1,
    createdAt: previous?.createdAt || now, updatedAt: now, configuration: config, dependencies: normalizeReferences(input.dependencies ?? previous?.dependencies),
    contentStatus: omitted ? 'omitted' : 'available', content,
    ...(previous?.connectionTest ? { connectionTest: previous.connectionTest } : {}) };
}

/** Existing configuration targets, never live/recent run IDs. */
export function listTargets(state) {
  const scopes = [{ target: { scope: 'global' }, name: 'Global agents', entity: state.settings, binding: state.settings.baseBinding, profileId: state.settings.agentProfileId }];
  for (const project of state.projects) {
    scopes.push({ target: { scope: 'project', projectId: project.id }, name: project.name, entity: project, binding: project.baseBinding, profileId: project.agentProfileId });
    const columnIds = project.workflowMode === 'pipeline' ? project.pipeline.columns.map(column => column.id) : [...new Set([...BUILTIN_COLUMNS, ...(project.columnLayout || []).map(column => column.id)])];
    for (const columnId of columnIds) {
      const column = (project.workflowMode === 'pipeline' ? project.pipeline.columns : project.columnLayout)?.find(item => item.id === columnId), saved = project.baseColumns?.[columnId] || {};
      scopes.push({ target: { scope: 'column', projectId: project.id, columnId }, name: `${project.name} / ${column?.name || column?.title || columnId}`, entity: saved, binding: saved.binding, profileId: saved.profileId,
        inactive: project.workflowMode === 'pipeline' ? column.role !== 'active' : ['todo', 'done'].includes(columnId) || (column?.custom && !column.agent?.enabled) });
    }
    for (const task of project.tasks) {
      scopes.push({ target: { scope: 'task', projectId: project.id, taskId: task.id }, name: `${project.name} / ${task.title}`, entity: task, binding: task.baseBinding });
      for (const columnId of columnIds) {
        const saved = task.baseColumns?.[columnId] || {};
        scopes.push({ target: { scope: 'task-column', projectId: project.id, taskId: task.id, columnId }, name: `${project.name} / ${task.title} / ${columnId}`, entity: saved, binding: saved.binding });
      }
    }
  }
  return scopes.map(({ entity, ...scope }) => ({ ...scope, binding: scope.binding || { mode: 'inherit', include: [], exclude: [] }, profileId: scope.profileId || null, baseRevision: entity?.baseRevision || 0 }));
}
export function usedBy(state, resourceId) {
  const uses = [];
  for (const resource of state.base.resources) if (resource.id !== resourceId && (resourceReferences(resource).some(ref => ref.resourceId === resourceId) || resource.configuration?.binding?.exclude?.includes(resourceId))) uses.push({ kind: 'resource', id: resource.id, name: resource.name });
  for (const scope of listTargets(state)) if (scope.profileId === resourceId || scope.binding.include?.some(ref => ref.resourceId === resourceId) || scope.binding.exclude?.includes(resourceId)) uses.push({ kind: 'assignment', target: scope.target, name: scope.name });
  const pendingUse = (scope, name, target) => {
    if (!scope) return;
    const bindings = [scope.baseBinding, ...Object.values(scope.baseColumns || {}).map(entry => entry.binding)];
    if (scope.agentProfileId === resourceId || Object.values(scope.baseColumns || {}).some(entry => entry.profileId === resourceId) || bindings.some(binding => binding?.include?.some(ref => ref.resourceId === resourceId) || binding?.exclude?.includes(resourceId))) uses.push({ kind: 'pending-assignment', target, name });
  };
  pendingUse(state.settings.pendingBaseImport, 'Imported global settings (awaiting confirmation)', { scope: 'global' });
  for (const project of state.projects) pendingUse(project.pendingImport, `${project.name} imported settings (awaiting confirmation)`, { scope: 'project', projectId: project.id });
  for (const run of state.runs) if ([...(run.baseManifest?.resources || run.baseManifest?.configured || run.baseSnapshot?.resources || []), ...(run.baseManifest?.profiles || [])].some(ref => (ref.resourceId || ref.id) === resourceId)) uses.push({ kind: 'run', id: run.id, name: `${run.stage} run`, historical: !active(run) });
  return uses;
}
function expected(base, revision) { if (revision !== undefined && base.revision !== revision) throw new BaseError('Base changed. Reload and review your changes.', 'BASE_REVISION_CONFLICT', 409); }
function validateDiscoveredTool(resource, resources) {
  if (resource.kind !== 'tool' || resource.configuration.delivery !== 'mcp') return;
  const server = resources.find(item => item.id === resource.configuration.serverId);
  if (!server?.connectionTest?.tools?.some(tool => tool.name === resource.configuration.toolName)) throw new BaseError('Choose a tool returned by an explicit connection test of its parent MCP server.', 'BASE_TOOL_NOT_DISCOVERED');
}
function validateSelection(state, binding, profileId) {
  const resources = new Map(state.base.resources.map(resource => [resource.id, resource]));
  for (const resourceId of [...binding.include.map(ref => ref.resourceId), ...binding.exclude]) if (!resources.has(resourceId)) throw new BaseError('A selected Base resource no longer exists.', 'BASE_NOT_FOUND', 404);
  if (profileId && resources.get(profileId)?.kind !== 'profile') fail('Choose an existing agent profile.');
}
function targetEntity(state, target, create = false) {
  if (!object(target)) fail('Choose an existing configuration target.');
  if (target.scope === 'global') return { entity: state.settings, bindingKey: 'baseBinding', profileKey: 'agentProfileId' };
  const project = state.projects.find(item => item.id === target.projectId);
  if (!project) throw new BaseError('The project no longer exists.', 'BASE_TARGET_NOT_FOUND', 404);
  if (target.scope === 'project') return { entity: project, bindingKey: 'baseBinding', profileKey: 'agentProfileId' };
  if (['column', 'task-column'].includes(target.scope) && (project.workflowMode === 'pipeline' ? !project.pipeline.columns.some(column => column.id === target.columnId) : !BUILTIN_COLUMNS.includes(target.columnId) && !project.columnLayout?.some(column => column.id === target.columnId))) throw new BaseError('The column no longer exists.', 'BASE_TARGET_NOT_FOUND', 404);
  let entity = project;
  if (['task', 'task-column'].includes(target.scope)) {
    entity = project.tasks.find(task => task.id === target.taskId);
    if (!entity) throw new BaseError('The task no longer exists.', 'BASE_TARGET_NOT_FOUND', 404);
    if (target.scope === 'task') return { entity, bindingKey: 'baseBinding', profileKey: null };
  }
  if (!['column', 'task-column'].includes(target.scope)) fail('Unknown Base assignment scope.');
  if (create) { entity.baseColumns ??= {}; entity.baseColumns[target.columnId] ??= {}; }
  return { entity: entity.baseColumns?.[target.columnId] || {}, bindingKey: 'binding', profileKey: target.scope === 'column' ? 'profileId' : null };
}

export class Base {
  constructor({ store }) { if (!store?.update || !store?.read) throw new TypeError('Base requires the existing Board Store.'); this.store = store; this.dir = join(store.dir, 'base'); }
  async list() { const state = await this.store.read(); return { revision: state.base.revision, resources: state.base.resources.map(resource => ({ ...resource, type: resource.kind === 'profile' ? 'agent' : resource.kind, usedBy: usedBy(state, resource.id) })), approvedRoots: state.base.approvedRoots }; }
  async detail(resourceId, { revision } = {}) {
    const state = await this.store.read(), current = state.base.resources.find(resource => resource.id === resourceId);
    if (!current) throw new BaseError('This Base resource no longer exists.', 'BASE_NOT_FOUND', 404);
    const ref = revision ? current.revisions?.find(item => item.revision === Number(revision)) : current.revisionRef;
    if (!ref) throw new BaseError('This resource revision does not exist.', 'BASE_NOT_FOUND', 404);
    return { ...await this.readRevision(ref), usedBy: usedBy(state, resourceId), revisions: current.revisions || [current.revisionRef] };
  }
  async readRevision(ref) {
    if (!ref || !ID.test(ref.id) || !Number.isSafeInteger(ref.revision) || ref.revision < 1 || !/^[a-f0-9]{64}$/.test(ref.hash)) fail('Invalid immutable resource reference.');
    let text; try {
      const path = join(this.dir, 'revisions', ref.id, `${ref.revision}-${ref.hash}.json`);
      if ((await stat(path)).size > BASE_LIMITS.definitionBytes) throw new Error('Oversized resource');
      text = await readFile(path, 'utf8');
    }
    catch { throw new BaseError('The pinned resource content is unavailable.', 'BASE_CONTENT_UNAVAILABLE', 409); }
    if (Buffer.byteLength(text) > BASE_LIMITS.definitionBytes || hash(text) !== ref.hash) throw new BaseError('The pinned resource content failed its integrity check.', 'BASE_CONTENT_INVALID', 409);
    return { ...JSON.parse(text), revisionRef: ref };
  }
  async #writeDefinition(definition, previous) {
    const { revisionRef: ignored, revisions: ignoredHistory, ...immutable } = definition;
    const text = JSON.stringify(immutable), ref = { id: definition.id, revision: definition.revision, hash: hash(text) };
    if (Buffer.byteLength(text) > BASE_LIMITS.definitionBytes) throw new BaseError('The resource definition exceeds its storage limit.', 'BASE_CONTENT_LIMIT');
    const dir = join(this.dir, 'revisions', ref.id);
    const path = join(dir, `${ref.revision}-${ref.hash}.json`), temp = `${path}.tmp-${randomUUID()}`;
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
      await rename(temp, path);
      try { const directory = await open(dir, 'r'); try { await directory.sync(); } finally { await directory.close(); } } catch {}
    } catch { await rm(temp, { force: true }).catch(() => {}); throw new BaseError('Resource content could not be saved. The registry was not changed.', 'BASE_CONTENT_WRITE_FAILED', 500); }
    const { content, ...metadata } = immutable;
    return { ...metadata, revisionRef: ref, revisions: [...(previous?.revisions || []), ref] };
  }
  async create(input, { expectedBaseRevision } = {}) {
    const state = await this.store.read(); expected(state.base, expectedBaseRevision);
    if (state.base.resources.length >= BASE_LIMITS.resources) fail('The Base library has reached its resource limit.');
    const definition = normalizeResource(input);
    validateDiscoveredTool(definition, state.base.resources);
    validateResourceGraph([...state.base.resources, definition]);
    const resource = await this.#writeDefinition(definition);
    return this.store.update(draft => { expected(draft.base, expectedBaseRevision); validateResourceGraph([...draft.base.resources, resource]); draft.base.resources.push(resource); draft.base.revision++; return resource; });
  }
  async update(resourceId, input, { expectedRevision, expectedBaseRevision } = {}) {
    const state = await this.store.read(); expected(state.base, expectedBaseRevision);
    const previous = state.base.resources.find(resource => resource.id === resourceId);
    if (!previous) throw new BaseError('This Base resource no longer exists.', 'BASE_NOT_FOUND', 404);
    if (expectedRevision !== previous.revision) throw new BaseError('The resource changed. Reload before saving.', 'RESOURCE_REVISION_CONFLICT', 409);
    const definition = normalizeResource(input, await this.readRevision(previous.revisionRef), { omitted: input.content === undefined && previous.contentStatus === 'omitted' });
    validateDiscoveredTool(definition, state.base.resources);
    // Connection results describe one definition only; edits cannot claim an older definition was tested.
    if (input.configuration !== undefined || input.content !== undefined) delete definition.connectionTest;
    validateResourceGraph(state.base.resources.map(resource => resource.id === resourceId ? definition : resource));
    const resource = await this.#writeDefinition(definition, previous);
    return this.store.update(draft => {
      expected(draft.base, expectedBaseRevision);
      if (draft.base.resources.find(item => item.id === resourceId)?.revision !== expectedRevision) throw new BaseError('The resource changed. Reload before saving.', 'RESOURCE_REVISION_CONFLICT', 409);
      const updated = draft.base.resources.map(item => item.id === resourceId ? resource : item); validateResourceGraph(updated);
      draft.base.resources = updated; draft.base.revision++; return resource;
    });
  }
  async apply({ changes, expectedBaseRevision } = {}) {
    if (!Array.isArray(changes) || !changes.length || changes.length > 500) fail('Select between 1 and 500 assignment targets.');
    const normalized = changes.map(change => ({ ...change, binding: normalizeBinding(change.binding) }));
    return this.store.update(state => {
      expected(state.base, expectedBaseRevision);
      const seen = new Set();
      for (const change of normalized) {
        const key = ['scope', 'projectId', 'taskId', 'columnId'].map(field => change.target?.[field] || '').join(':'); if (seen.has(key)) fail('Each assignment target can appear only once.'); seen.add(key);
        const scope = targetEntity(state, change.target, true);
        if (change.expectedRevision !== undefined && (scope.entity.baseRevision || 0) !== change.expectedRevision) throw new BaseError('A target changed. Reload the assignment preview.', 'BASE_TARGET_REVISION_CONFLICT', 409);
        if (change.profileId !== undefined && !scope.profileKey) fail('Task resource overrides do not change provider profiles.');
        validateSelection(state, change.binding, change.profileId);
        scope.entity[scope.bindingKey] = change.binding;
        if (change.profileId !== undefined) scope.entity[scope.profileKey] = change.profileId ? id(change.profileId) : null;
        scope.entity.baseRevision = (scope.entity.baseRevision || 0) + 1;
      }
      state.base.revision++; return { revision: state.base.revision, changed: normalized.length };
    });
  }
  async approveRoot(path, { confirm = false, expectedBaseRevision } = {}) {
    if (!confirm) throw new BaseError('Approve this external filesystem root explicitly.', 'CONFIRMATION_REQUIRED', 409);
    string(path, 4096, 'External folder path', true);
    if (!isAbsolute(path || '')) fail('Choose an absolute external folder.');
    let actual, info;
    try { actual = await realpath(path); info = await stat(actual); }
    catch { throw new BaseError('The external folder is unavailable. Check that it exists and is readable.', 'BASE_ROOT_UNAVAILABLE', 409); }
    if (!info.isDirectory()) fail('Choose a folder.');
    return this.store.update(state => { expected(state.base, expectedBaseRevision); const existing = state.base.approvedRoots.find(root => root.path === actual); if (existing) return existing;
      if (state.base.approvedRoots.length >= 100) fail('At most 100 external roots may be approved. Revoke unused roots first.');
      const root = { id: randomUUID(), path: actual, approvedAt: Date.now() }; state.base.approvedRoots.push(root); state.base.revision++; return root; });
  }
  async revokeRoot(rootId, { expectedBaseRevision } = {}) {
    id(rootId, 'Approved root ID');
    return this.store.update(state => {
      expected(state.base, expectedBaseRevision);
      if (!state.base.approvedRoots.some(root => root.id === rootId)) throw new BaseError('This external root is not approved.', 'BASE_NOT_FOUND', 404);
      state.base.approvedRoots = state.base.approvedRoots.filter(root => root.id !== rootId); state.base.revision++;
      return { revoked: rootId, revision: state.base.revision };
    });
  }
  async recordConnectionTest(resourceId, result, { expectedRevision } = {}) {
    const state = await this.store.read(), previous = state.base.resources.find(resource => resource.id === resourceId);
    if (!previous || previous.kind !== 'mcp') fail('Choose an MCP server to test.');
    if (previous.revision !== expectedRevision) throw new BaseError('The MCP definition changed during the test.', 'RESOURCE_REVISION_CONFLICT', 409);
    const definition = await this.readRevision(previous.revisionRef);
    const clean = { status: result.status === 'connected' ? 'connected' : 'failed', checkedAt: Date.now(), testedRevision: previous.revision + 1,
      code: string(result.code, 80, 'Connection result'), tools: (result.tools || []).slice(0, 500).map(tool => ({ name: string(tool.name, 200, 'Tool name', true), description: string(tool.description, 2000, 'Tool description') })),
      resources: integer(Array.isArray(result.resources) ? result.resources.length : result.resources, 0, 0, 10000, 'Discovered resource count'),
      prompts: integer(Array.isArray(result.prompts) ? result.prompts.length : result.prompts, 0, 0, 10000, 'Discovered prompt count'),
      durationMs: integer(result.durationMs === undefined ? undefined : Math.round(result.durationMs), 0, 0, 120000, 'Connection test duration'), partial: result.partial === true,
      ...(result.server ? { server: { name: string(result.server.name, 200, 'Server name'), version: string(result.server.version, 100, 'Server version') } } : {}) };
    const metadata = await this.#writeDefinition({ ...definition, revision: previous.revision + 1, updatedAt: Date.now(), connectionTest: clean }, previous);
    return this.store.update(draft => { if (draft.base.resources.find(resource => resource.id === resourceId)?.revision !== expectedRevision) throw new BaseError('The MCP definition changed during the test.', 'RESOURCE_REVISION_CONFLICT', 409);
      draft.base.resources = draft.base.resources.map(resource => resource.id === resourceId ? metadata : resource); draft.base.revision++; return metadata; });
  }

  /** Delete metadata only. Immutable definitions referenced by historical runs remain readable. */
  async remove(resourceId, { expectedRevision, expectedBaseRevision, detach = false } = {}) {
    const snapshot = await this.store.read(); expected(snapshot.base, expectedBaseRevision);
    const resource = snapshot.base.resources.find(item => item.id === resourceId);
    if (!resource) throw new BaseError('This Base resource no longer exists.', 'BASE_NOT_FOUND', 404);
    if (expectedRevision !== resource.revision) throw new BaseError('The resource changed. Reload before deleting.', 'RESOURCE_REVISION_CONFLICT', 409);
    const references = usedBy(snapshot, resourceId), blocking = references.filter(ref => !ref.historical);
    if (blocking.some(ref => ref.kind === 'run')) throw new BaseError('Stop active runs before deleting their Base resources.', 'BASE_RESOURCE_IN_USE', 409, { usedBy: references });
    if (blocking.length && !detach) throw new BaseError('Detach this resource from its dependencies and assignments before deleting it.', 'BASE_RESOURCE_IN_USE', 409, { usedBy: references });
    const replacements = new Map();
    const without = binding => ({ ...binding, include: (binding.include || []).filter(ref => ref.resourceId !== resourceId), exclude: (binding.exclude || []).filter(value => value !== resourceId) });
    for (const ref of blocking.filter(item => item.kind === 'resource')) {
      const previous = snapshot.base.resources.find(item => item.id === ref.id), definition = await this.readRevision(previous.revisionRef);
      if (definition.kind === 'tool' && definition.configuration.delivery === 'mcp' && definition.configuration.serverId === resourceId) throw new BaseError('Delete the discovered MCP tool references before deleting their server.', 'BASE_RESOURCE_IN_USE', 409, { usedBy: references });
      definition.dependencies = definition.dependencies.filter(item => item.resourceId !== resourceId);
      if (definition.kind === 'pack') definition.configuration.resources = definition.configuration.resources.filter(item => item.resourceId !== resourceId);
      if (definition.kind === 'profile') definition.configuration.binding = without(definition.configuration.binding);
      if (['context', 'knowledge'].includes(definition.kind) && definition.configuration.sources) definition.configuration.sources = definition.configuration.sources.filter(item => item.resourceId !== resourceId);
      definition.revision++; definition.updatedAt = Date.now();
      replacements.set(definition.id, await this.#writeDefinition(definition, previous));
    }
    return this.store.update(state => {
      // Async revision writes must not detach changes made since the deletion preview.
      expected(state.base, snapshot.base.revision);
      if (usedBy(state, resourceId).some(ref => ref.kind === 'run' && !ref.historical)) throw new BaseError('Stop active runs before deleting their resources.', 'BASE_RESOURCE_IN_USE', 409);
      for (const scope of listTargets(state)) {
        if (scope.profileId !== resourceId && !scope.binding.include.some(ref => ref.resourceId === resourceId) && !scope.binding.exclude.includes(resourceId)) continue;
        const target = targetEntity(state, scope.target, true); target.entity[target.bindingKey] = without(scope.binding);
        if (target.profileKey && target.entity[target.profileKey] === resourceId) target.entity[target.profileKey] = null;
        target.entity.baseRevision = (target.entity.baseRevision || 0) + 1;
      }
      for (const pending of [state.settings.pendingBaseImport, ...state.projects.map(project => project.pendingImport)].filter(Boolean)) {
        if (pending.baseBinding) pending.baseBinding = without(pending.baseBinding);
        if (pending.agentProfileId === resourceId) pending.agentProfileId = null;
        for (const entry of Object.values(pending.baseColumns || {})) {
          if (entry.binding) entry.binding = without(entry.binding);
          if (entry.profileId === resourceId) entry.profileId = null;
        }
      }
      state.base.resources = state.base.resources.filter(item => item.id !== resourceId).map(item => replacements.get(item.id) || item);
      validateResourceGraph(state.base.resources); state.base.revision++;
      return { deleted: resourceId, detached: blocking.length, retainedRevisions: resource.revisions?.length || 1 };
    });
  }

  async export({ ids, includeContent = false } = {}) {
    const state = await this.store.read(), byId = new Map(state.base.resources.map(resource => [resource.id, resource])), selected = new Set();
    const add = resourceId => {
      if (selected.has(resourceId)) return;
      const resource = byId.get(resourceId); if (!resource) throw new BaseError('An exported resource no longer exists.', 'BASE_NOT_FOUND', 404);
      selected.add(resourceId); resourceReferences(resource).forEach(ref => add(ref.resourceId));
      // Exclusions need portable IDs too, even when they do not cause delivery.
      for (const excluded of resource.configuration?.binding?.exclude || []) add(excluded);
    };
    for (const resourceId of ids === undefined ? byId.keys() : strings(ids, BASE_LIMITS.resources, 100, 'Exported resources')) add(resourceId);
    const resources = [];
    for (const resourceId of selected) {
      const resource = byId.get(resourceId), { revisionRef, revisions, connectionTest, ...metadata } = resource;
      if (!includeContent && metadata.kind === 'profile' && metadata.configuration.avatar) metadata.configuration = { ...metadata.configuration, avatar: { ...metadata.configuration.avatar, contentStatus: 'omitted' } };
      resources.push({ ...metadata, ...(includeContent ? { content: (await this.readRevision(revisionRef)).content } : {}), contentStatus: includeContent || !['skill', 'knowledge'].includes(resource.kind) ? resource.contentStatus : 'omitted' });
    }
    const bundle = { kind: 'promptboard-base', version: BASE_EXPORT_VERSION, exportedAt: new Date().toISOString(), includesContent: includeContent, resources };
    if (Buffer.byteLength(JSON.stringify(bundle)) > BASE_LIMITS.importBytes) fail('The selected export exceeds 12 MiB. Export smaller packs.');
    return bundle;
  }

  #validateImport(bundle, suppliedRemap) {
    if (!object(bundle) || bundle.kind !== 'promptboard-base' || bundle.version !== BASE_EXPORT_VERSION || !Array.isArray(bundle.resources) || bundle.resources.length > BASE_LIMITS.resources) fail('Choose a supported promptboard-base export.');
    if (Buffer.byteLength(JSON.stringify(bundle)) > BASE_LIMITS.importBytes) fail('The import exceeds 12 MiB.');
    const ids = bundle.resources.map(resource => id(resource?.id)); if (new Set(ids).size !== ids.length) fail('Imported resource IDs must be unique.');
    const remap = Object.fromEntries(ids.map(resourceId => [resourceId, suppliedRemap && Object.hasOwn(suppliedRemap, resourceId) ? id(suppliedRemap[resourceId]) : randomUUID()]));
    if (new Set(Object.values(remap)).size !== ids.length || Object.values(remap).some(value => ids.includes(value))) fail('Imports require fresh unique IDs; existing resources are never overwritten.');
    const lookup = resourceId => { if (!Object.hasOwn(remap, resourceId)) fail('The import is missing a referenced dependency.'); return remap[resourceId]; };
    const warnings = [], resources = bundle.resources.map(input => {
      const omitted = ['skill', 'knowledge'].includes(input.kind) && (input.contentStatus === 'omitted' || !input.content);
      if (omitted && ['skill', 'knowledge'].includes(input.kind)) warnings.push(`“${input.name}” has no exported document content. Add content before enabling it.`);
      const definition = normalizeResource({ ...input, id: remap[input.id], content: input.content || {} }, undefined, { imported: true, omitted });
      definition.dependencies = definition.dependencies.map(ref => ({ ...ref, resourceId: lookup(ref.resourceId) }));
      if (definition.kind === 'pack') definition.configuration.resources = definition.configuration.resources.map(ref => ({ ...ref, resourceId: lookup(ref.resourceId) }));
      if (definition.kind === 'profile') definition.configuration.binding = remapBinding(definition.configuration.binding, remap);
      if (definition.kind === 'tool' && definition.configuration.delivery === 'mcp') definition.configuration.serverId = lookup(definition.configuration.serverId);
      if (['context', 'knowledge'].includes(definition.kind) && definition.configuration.sources) definition.configuration.sources = definition.configuration.sources.map(source => {
        if (source.kind === 'knowledge') return { ...source, resourceId: lookup(source.resourceId) };
        // An exported root ID is not an access grant on this machine, even when imported here again.
        if (source.kind === 'external') return { ...source, rootId: randomUUID() };
        return source;
      });
      return definition;
    });
    validateResourceGraph(resources);
    return { resources, remap, warnings: [...warnings, 'Imported resources are inactive and untrusted. Assignments, external-root approvals, installation, and connection tests are never imported.'] };
  }
  async previewImport(bundle) {
    const prepared = this.#validateImport(bundle);
    const state = await this.store.read();
    return { revision: state.base.revision, remap: prepared.remap, warnings: prepared.warnings, resources: prepared.resources.map(({ content, ...metadata }) => metadata) };
  }
  /** Write content first, then let a caller publish it alongside a board backup in one Store update. */
  async prepareImport(bundle, { remap, expectedBaseRevision } = {}) {
    const state = await this.store.read(); expected(state.base, expectedBaseRevision);
    const prepared = this.#validateImport(bundle, remap);
    if (state.base.resources.length + prepared.resources.length > BASE_LIMITS.resources) fail('The imported library would exceed 2,000 resources.');
    const resources = [];
    for (const definition of prepared.resources) resources.push(await this.#writeDefinition(definition));
    return { ...prepared, resources, expectedBaseRevision: state.base.revision };
  }
  publishPreparedImport(state, prepared) {
    expected(state.base, prepared.expectedBaseRevision);
    if (state.base.resources.length + prepared.resources.length > BASE_LIMITS.resources) fail('The imported library would exceed 2,000 resources.');
    validateResourceGraph([...state.base.resources, ...prepared.resources]);
    state.base.resources.push(...prepared.resources); state.base.revision++;
    return { revision: state.base.revision, resources: prepared.resources, remap: prepared.remap, warnings: prepared.warnings };
  }
  async import(bundle, options = {}) {
    const prepared = await this.prepareImport(bundle, options);
    return this.store.update(state => this.publishPreparedImport(state, prepared));
  }

  /** Only parse SKILL.md here; importing it never executes scripts or follows file references. */
  async importSkill({ markdown, files = [], name, description, tags = [] }, options = {}) {
    string(markdown, BASE_LIMITS.documentChars, 'SKILL.md', true);
    const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) fail('SKILL.md needs a YAML frontmatter block with name and description.');
    // Accept the documented scalar metadata subset. Complex YAML is rejected, never evaluated.
    const meta = {};
    for (const line of match[1].split(/\r?\n/)) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const field = line.match(/^([a-z][a-z0-9-]*):\s*(.*?)\s*$/i);
      if (!field || /[&*!]|^\s*[{[]/.test(field[2]) || ['|', '>'].includes(field[2])) fail('SKILL.md imports support plain scalar frontmatter. Use the editable instruction form for complex metadata.');
      meta[field[1]] = field[2].replace(/^(?:"(.*)"|'(.*)')$/, (_, double, single) => double ?? single);
    }
    if (!meta.name || !meta.description || !markdown.slice(match[0].length).trim()) fail('SKILL.md needs name, description, and instruction text.');
    return this.create({ kind: 'skill', name: name || meta.name, description: description || meta.description, tags, enabled: false, trust: 'untrusted', configuration: { format: 'instruction', entrypoint: 'SKILL.md' }, content: { body: markdown.slice(match[0].length), files: [{ path: 'SKILL.md', text: markdown }, ...files] } }, options);
  }
}
