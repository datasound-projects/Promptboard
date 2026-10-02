/** Pure Base assignment resolution, shared by previews and run acceptance. */
import { ADAPTERS } from './agents.mjs';

const refs = values => (values || []).map(value => typeof value === 'string' ? { resourceId: value, required: true } : value);
const resourcesOf = state => new Map((state?.base?.resources || []).map(resource => [resource.id, resource]));
export class BaseDeliveryError extends Error {
  constructor(message, code = 'BASE_UNAVAILABLE', details = undefined) { super(message); this.code = code; this.status = 409; this.details = details; }
}

/** Profile defaults stay at their configuration scope. An explicit provider replaces its tuple. */
export function profileDefaults(state, profileId, explicit = {}) {
  const profile = resourcesOf(state).get(profileId);
  // Show the configured tuple even after revocation; preflight blocks it instead of silently
  // switching providers. Trust is a launch decision, not a settings mutation.
  const defaults = profile?.kind === 'profile' ? profile.configuration?.agent || {} : {};
  return explicit?.provider ? { ...defaults, ...explicit, provider: explicit.provider, model: explicit.model || '', effort: explicit.effort || '', permissionMode: explicit.permissionMode || '' } : { ...defaults, ...(explicit || {}) };
}

export function baseDependencies(resource) {
  const result = refs(resource?.dependencies);
  if (resource?.kind === 'tool' && resource.configuration?.delivery === 'mcp') result.push({ resourceId: resource.configuration.serverId, required: true });
  if (['context', 'knowledge'].includes(resource?.kind)) for (const source of resource.configuration?.sources || []) if (source.kind === 'knowledge') result.push({ resourceId: source.resourceId, required: true });
  return result;
}
const dependencies = baseDependencies;

export function deliveryFor(resource, provider, columnId, capabilities = null) {
  const adapter = capabilities?.[provider] || ADAPTERS[provider];
  const readOnly = ['planning', 'code_review'].includes(columnId);
  const supported = adapter?.capabilities?.[readOnly ? 'planning' : 'execution']?.supported;
  if (!supported) return { delivery: 'unavailable', issue: 'This provider does not support this Kanban stage.' };
  if (['pack', 'profile'].includes(resource.kind)) return { delivery: 'configuration' };
  if (resource.kind === 'mcp' || (resource.kind === 'tool' && resource.configuration?.delivery === 'mcp')) {
    if (readOnly) return { delivery: 'native-mcp', issue: 'Base MCP servers are unavailable in read-only Planning and Code Review.' };
    if (provider === 'codex' && resource.kind === 'mcp' && resource.configuration?.transport === 'stdio' && Object.entries(resource.configuration.env || {}).some(([name, reference]) => name !== reference)) return { delivery: 'native-mcp', issue: 'Codex stdio MCP delivery requires matching environment-variable names; aliases are unsupported without exposing credentials in CLI arguments.' };
    if (!adapter.capabilities.base?.mcp?.includes(resource.kind === 'mcp' ? resource.configuration?.transport : 'tool-reference')) return { delivery: 'native-mcp', issue: 'This adapter cannot deliver this MCP transport.' };
    return { delivery: resource.kind === 'tool' ? 'mcp-tool-reference' : 'native-mcp' };
  }
  if (resource.kind === 'tool') return readOnly ? { delivery: 'command-recipe', issue: 'Command recipes are unavailable in read-only Planning and Code Review.' } : { delivery: 'command-recipe' };
  return { delivery: resource.kind === 'skill' ? 'instruction' : 'context' };
}

export function resolveBase({ state, project, task, columnId, provider, capabilities = null }) {
  const registry = resourcesOf(state), selected = new Map(), excluded = new Set();
  const exclusions = [], warnings = [], errors = [], profiles = [];
  const canExpand = resource => resource?.enabled && resource.trust === 'trusted' && resource.contentStatus !== 'omitted' && !deliveryFor(resource, provider, columnId, capabilities).issue;
  const layers = [
    ['global', state?.settings?.baseBinding, state?.settings?.agentProfileId],
    [`project:${project?.id || ''}`, project?.baseBinding, project?.agentProfileId],
    [`column:${columnId}`, project?.baseColumns?.[columnId]?.binding, project?.baseColumns?.[columnId]?.profileId],
    [`task:${task?.id || ''}`, task?.baseBinding, null],
    [`task-column:${task?.id || ''}:${columnId}`, task?.baseColumns?.[columnId]?.binding, null],
  ];
  function select(ref, origin, rank, explicit = true, stack = []) {
    if (!ref?.resourceId) return;
    const id = ref.resourceId, resource = registry.get(id);
    if (stack.includes(id)) { errors.push({ resourceId: id, code: 'BASE_CYCLE', message: 'Resource dependencies contain a cycle.' }); return; }
    const prior = selected.get(id);
    const entry = prior || { resourceId: id, required: false, origins: [], rank, explicitRank: -1 };
    entry.origins = [...new Set([...entry.origins, origin])];
    if (explicit) {
      // Only a more-specific scope may lower a requirement. Within one scope,
      // pack expansion and explicit selections must not depend on array order.
      if (rank > entry.explicitRank) entry.required = ref.required === true;
      else entry.required ||= ref.required === true;
      entry.explicitRank = Math.max(entry.explicitRank, rank); excluded.delete(id);
    }
    else if (entry.explicitRank <= rank) entry.required ||= ref.required === true;
    entry.rank = Math.max(entry.rank, rank);
    selected.set(id, entry);
    // A disabled/untrusted pack is not a back door to its members. Independently
    // selected members remain separate and can still be delivered.
    if (resource?.kind === 'pack' && resource.enabled && resource.trust === 'trusted' && resource.contentStatus !== 'omitted') for (const child of refs(resource.configuration?.resources)) select({ ...child, required: entry.required || child.required }, `${origin}/pack:${id}`, rank, explicit, [...stack, id]);
  }
  function apply(binding, origin, rank) {
    const mode = binding?.mode || 'inherit';
    if (mode === 'inherit') return;
    if (mode === 'replace') {
      for (const id of selected.keys()) exclusions.push({ resourceId: id, origin, reason: 'replace' });
      selected.clear(); excluded.clear();
    }
    for (const ref of refs(binding?.include)) select(ref, origin, rank);
    const remove = (id, stack = []) => {
      if (stack.includes(id)) return;
      selected.delete(id); excluded.add(id); exclusions.push({ resourceId: id, origin, reason: 'excluded' });
      const resource = registry.get(id);
      if (resource?.kind === 'pack') for (const child of refs(resource.configuration?.resources)) remove(child.resourceId, [...stack, id]);
    };
    for (const id of binding?.exclude || []) remove(typeof id === 'string' ? id : id.resourceId);
  }
  for (const [rank, [origin, binding, profileId]] of layers.entries()) {
    if (profileId) {
      const profile = registry.get(profileId);
      profiles.push({ resourceId: profileId, revision: profile?.revision || 0, revisionRef: profile?.revisionRef ? { ...profile.revisionRef } : null, origin });
      if (!profile || profile.kind !== 'profile' || !profile.enabled || profile.trust !== 'trusted') errors.push({ resourceId: profileId, code: 'BASE_PROFILE_UNAVAILABLE', message: 'A selected agent profile is missing, disabled, or untrusted. Change the profile configuration explicitly.' });
      if (profile?.kind === 'profile') apply(profile.configuration?.binding, `${origin}/profile:${profileId}`, rank);
      select({ resourceId: profileId, required: true }, `${origin}/profile`, rank);
    }
    apply(binding, origin, rank);
  }
  const visiting = new Set(), visited = new Set();
  function expand(id) {
    if (visiting.has(id)) { errors.push({ resourceId: id, code: 'BASE_CYCLE', message: 'Resource dependencies contain a cycle.' }); return; }
    if (visited.has(id)) return;
    const entry = selected.get(id); if (!entry) return;
    const definition = registry.get(id);
    if (!canExpand(definition)) { visited.add(id); return; }
    visiting.add(id);
    for (const dep of dependencies(definition)) {
      if (excluded.has(dep.resourceId)) { (entry.dependencyIssues ||= []).push(`Dependency ${dep.resourceId} was explicitly excluded.`); continue; }
      select({ ...dep, required: entry.required || dep.required }, `dependency:${id}`, entry.rank, false);
      expand(dep.resourceId);
    }
    visiting.delete(id); visited.add(id);
  }
  for (const id of selected.keys()) expand(id);
  // Converge required status after graph expansion: a shared dependency can be reached
  // later from a required parent. A more-specific explicit choice still takes priority.
  for (let pass = 0; pass < selected.size; pass++) {
    let changed = false;
    for (const entry of selected.values()) for (const dep of (canExpand(registry.get(entry.resourceId)) ? dependencies(registry.get(entry.resourceId)) : [])) {
      const child = selected.get(dep.resourceId);
      if (child && child.explicitRank <= entry.rank && !child.required && (entry.required || dep.required)) { child.required = true; changed = true; }
    }
    if (!changed) break;
  }
  const resources = [...selected.values()].map(entry => {
    const resource = registry.get(entry.resourceId), issues = [...(entry.dependencyIssues || [])];
    if (!resource) issues.push('Resource was deleted or is unavailable.');
    else {
      if (!resource.enabled) issues.push('Resource is disabled.');
      if (resource.trust !== 'trusted') issues.push(resource.trust === 'revoked' ? 'Resource trust was revoked.' : 'Resource is not trusted.');
      if (resource.contentStatus === 'omitted') issues.push('Document content was omitted from the imported definition.');
      for (const source of resource.configuration?.sources || []) if (source.kind === 'external' && !state?.base?.approvedRoots?.some(root => root.id === source.rootId && root.enabled !== false)) issues.push('The external source root is not approved or its approval was revoked.');
      if (resource.kind === 'tool' && resource.configuration?.delivery === 'mcp' && !registry.get(resource.configuration.serverId)?.connectionTest?.tools?.some(tool => tool.name === resource.configuration.toolName)) issues.push('The parent MCP server has not discovered this tool. Run an explicit connection test before attaching it.');
    }
    const result = resource ? deliveryFor(resource, provider, columnId, capabilities) : { delivery: 'unavailable' };
    if (resource?.kind === 'knowledge' && entry.origins.every(origin => origin.startsWith('dependency:'))) result.delivery = 'dependency-definition';
    if (result.issue) issues.push(result.issue);
    return { resourceId: entry.resourceId, revision: resource?.revision || 0, revisionRef: resource?.revisionRef ? { ...resource.revisionRef } : null, kind: resource?.kind || 'missing', name: resource?.name || entry.resourceId, required: entry.required, origins: entry.origins, delivery: result.delivery, status: issues.length ? 'omitted' : 'ready', issues };
  });
  // A parent cannot be supplied if one of its declared dependencies was omitted.
  for (let i = 0; i <= resources.length; i++) {
    let changed = false;
    for (const entry of resources.filter(value => value.status === 'ready')) {
      for (const dep of dependencies(registry.get(entry.resourceId))) if (dep.required !== false && resources.find(value => value.resourceId === dep.resourceId)?.status !== 'ready') {
        entry.status = 'omitted'; entry.issues.push(`Dependency ${dep.resourceId} cannot be supplied.`); changed = true; break;
      }
    }
    if (!changed) break;
  }
  for (const entry of resources) for (const message of entry.issues) (entry.required ? errors : warnings).push({ resourceId: entry.resourceId, code: 'BASE_RESOURCE_UNAVAILABLE', message });
  if (resources.some(entry => entry.delivery === 'native-mcp') && provider === 'codex') warnings.push({ code: 'BASE_AMBIENT_CONFIGURATION', message: 'Base-managed MCP servers supplement external Codex configuration; Base does not isolate ambient MCPs.' });
  if (ADAPTERS[provider]?.notLiveVerified && resources.length) warnings.push({ code: 'BASE_NOT_LIVE_VERIFIED', message: 'This provider adapter is covered by simulated checks, not authenticated live verification.' });
  const externalRoots = [...new Set(resources.filter(entry => entry.status === 'ready').flatMap(entry => (registry.get(entry.resourceId)?.configuration?.sources || []).filter(source => source.kind === 'external').map(source => source.rootId)))].map(id => ({ id, approvedAt: state?.base?.approvedRoots?.find(root => root.id === id)?.approvedAt || null }));
  return { version: 1, baseRevision: state?.base?.revision || 0, provider, columnId, profiles, resources, externalRoots, exclusions, warnings, errors, configuredAt: null, supplied: [], observed: [] };
}

export function assertBaseReady(manifest) {
  if (manifest.errors?.length) throw new BaseDeliveryError(manifest.errors[0].message, 'BASE_PREFLIGHT_FAILED', { errors: manifest.errors });
  return manifest;
}

/** Recheck only security/availability, keeping accepted definition revisions unchanged. */
export function checkBaseRevocations(manifest, currentResources = [], approvedRoots = undefined) {
  const current = new Map(currentResources.map(resource => [resource.id, resource]));
  for (const entry of [...(manifest.resources || []), ...(manifest.profiles || []).map(profile => ({ ...profile, status: 'ready', name: 'agent profile' }))]) if (entry.status === 'ready') {
    const resource = current.get(entry.resourceId);
    if (!resource || !resource.enabled || resource.trust !== 'trusted') throw new BaseDeliveryError(`Base resource “${entry.name}” was disabled, removed, or had trust revoked after this run was accepted.`, 'BASE_REVOKED');
  }
  if (approvedRoots) for (const pinned of manifest.externalRoots || []) {
    const root = approvedRoots.find(item => item.id === pinned.id && item.enabled !== false);
    if (!root || pinned.approvedAt && root.approvedAt !== pinned.approvedAt) throw new BaseDeliveryError('An external context root approval was revoked or changed after this run was accepted.', 'BASE_ROOT_NOT_APPROVED');
  }
}
