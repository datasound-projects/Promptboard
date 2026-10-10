/** Repository definitions are read-only here. Applying them never dispatches work. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizePipelineConfig, normalizePipelineStrategy } from './pipeline-config.mjs';

export const PIPELINE_CONFIG_FILES = Object.freeze(['promptboard.json', 'promptboard.local.json']);
const MAX_FILE = 4 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const record = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export class RepositoryPipelineError extends Error {
  constructor(message, code = 'INVALID_REPOSITORY_PIPELINE', status = 400) { super(message); this.code = code; this.status = status; }
}
const invalid = message => { throw new RepositoryPipelineError(message); };
const keys = (value, allowed, label) => { if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid(`${label} has an unsupported field.`); };
const folded = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const nameOf = value => { if (typeof value !== 'string' || !value.trim() || value.length > 80 || value.includes('\0')) invalid('Configuration names need 1 to 80 characters without null characters.'); return value.trim(); };
const generatedId = (kind, name) => `cfg_${hash(`${kind}:${folded(name)}`).slice(0, 32)}`;
const identity = stat => [String(stat.dev), String(stat.ino), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)];
const equalIdentity = (a, b) => JSON.stringify(identity(a)) === JSON.stringify(identity(b));

/** Fixed root filenames, bounded fatal UTF-8, no symlinks, and stable descriptor custody. */
export async function readRepositoryPipeline(root) {
  const canonical = await realpath(root).catch(() => null);
  const beforeRoot = await lstat(root, { bigint: true }).catch(() => null);
  if (canonical !== root || !beforeRoot?.isDirectory() || beforeRoot.isSymbolicLink()) throw new RepositoryPipelineError('The linked repository root is no longer available.', 'REPOSITORY_PIPELINE_ROOT_CHANGED', 409);
  const files = [], stats = new Map();
  for (const name of PIPELINE_CONFIG_FILES) {
    const path = join(root, name);
    let before;
    try { before = await lstat(path, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') { files.push({ name, hash: null, data: null }); continue; } throw new RepositoryPipelineError(`Could not read ${name}.`, 'REPOSITORY_PIPELINE_READ_FAILED'); }
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_FILE) || before.nlink !== 1n) invalid(`${name} must be a regular, single-link file of at most 4 MiB.`);
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const opened = await handle.stat({ bigint: true });
      if (!equalIdentity(before, opened)) throw new RepositoryPipelineError('Configuration changed while being read. Review it again.', 'REPOSITORY_PIPELINE_CHANGED', 409);
      const bytes = Buffer.alloc(Number(opened.size) + 1); let length = 0;
      while (length < bytes.length) { const result = await handle.read(bytes, length, bytes.length - length, null); if (!result.bytesRead) break; length += result.bytesRead; }
      const after = await handle.stat({ bigint: true }), present = await lstat(path, { bigint: true });
      if (length !== Number(opened.size) || !equalIdentity(opened, after) || !equalIdentity(after, present) || present.isSymbolicLink()) throw new RepositoryPipelineError('Configuration changed while being read. Review it again.', 'REPOSITORY_PIPELINE_CHANGED', 409);
      let data;
      try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))); }
      catch { invalid(`${name} must contain valid UTF-8 JSON.`); }
      files.push({ name, hash: hash(bytes.subarray(0, length)), data });
      stats.set(name, after);
    } catch (error) {
      if (error instanceof RepositoryPipelineError) throw error;
      throw new RepositoryPipelineError(`Could not safely read ${name}.`, 'REPOSITORY_PIPELINE_READ_FAILED');
    } finally { await handle?.close(); }
  }
  for (const file of files) {
    const present = await lstat(join(root, file.name), { bigint: true }).catch(error => { if (error.code === 'ENOENT') return null; throw new RepositoryPipelineError('Could not recheck repository configuration.', 'REPOSITORY_PIPELINE_READ_FAILED'); });
    if (file.hash === null ? present !== null : !present || present.isSymbolicLink() || !equalIdentity(stats.get(file.name), present)) throw new RepositoryPipelineError('Configuration changed while being read. Review it again.', 'REPOSITORY_PIPELINE_CHANGED', 409);
  }
  const afterRoot = await lstat(root, { bigint: true }).catch(() => null);
  if (!afterRoot?.isDirectory() || afterRoot.isSymbolicLink() || beforeRoot.dev !== afterRoot.dev || beforeRoot.ino !== afterRoot.ino || await realpath(root).catch(() => null) !== root) throw new RepositoryPipelineError('The linked repository root changed while reading configuration.', 'REPOSITORY_PIPELINE_ROOT_CHANGED', 409);
  return { files, sourceRevision: hash(JSON.stringify([root, String(afterRoot.dev), String(afterRoot.ino), files.map(file => [file.name, file.hash])])) };
}

function document(value, local) {
  keys(value, local ? ['version', 'columns'] : ['version', 'columns', 'profiles'], local ? 'Personal board configuration' : 'Team board configuration');
  if (value.version !== 1 || !Array.isArray(value.columns) || value.columns.length > 30) invalid('Repository board configuration needs version 1 and at most 30 columns.');
  const names = new Set(), ids = new Set();
  for (const column of value.columns) {
    keys(column, ['id', 'name', 'role', 'kind', 'color', 'description', 'strategy', 'automations'], 'Repository column');
    const name = nameOf(column.name);
    if (names.has(folded(name)) || column.id !== undefined && ids.has(column.id)) invalid('Repository column names and IDs must be unique.');
    names.add(folded(name)); if (column.id !== undefined) ids.add(column.id);
  }
  return value;
}

function strategy(input, columns) {
  if (input === undefined) return {};
  if (!record(input)) invalid('Repository strategy must be an object.');
  const { planExitTarget, ...own } = input;
  if (Object.hasOwn(input, 'planExitTarget')) {
    if (Object.hasOwn(input, 'planExitTargetId')) invalid('Use one native plan target, by name or ID.');
    if (planExitTarget === null) own.planExitTargetId = null;
    else {
      const target = columns.find(column => folded(column.name) === folded(nameOf(planExitTarget)));
      if (!target) invalid('A native plan target names a missing column.');
      own.planExitTargetId = target.id;
    }
  }
  return normalizePipelineStrategy(own);
}

/** Team identity/order, sparse local values, whole automation replacement; no effects. */
export function resolveRepositoryPipeline(snapshot, current) {
  const baseline = normalizePipelineConfig(current), teamData = snapshot.files[0].data, localData = snapshot.files[1].data;
  if (teamData === null && localData === null) throw new RepositoryPipelineError('No promptboard.json or promptboard.local.json was found in the linked repository.', 'REPOSITORY_PIPELINE_NOT_FOUND', 404);
  const team = teamData === null ? null : document(teamData, false), local = localData === null ? null : document(localData, true);
  const shared = local ? team ? resolveRepositoryPipeline({ files: [snapshot.files[0], { data: null }] }, baseline).pipeline : baseline : null;
  const canonical = Boolean(team?.columns.length && team.columns.every(column => column.id !== undefined));
  const columns = canonical ? [] : structuredClone(baseline.columns);
  const provided = new Map();
  const merge = (column, isLocal) => {
    const named = columns.find(item => folded(item.name) === folded(column.name));
    const existing = column.id !== undefined ? columns.find(item => item.id === column.id) || baseline.columns.find(item => item.id === column.id) : named || baseline.columns.find(item => folded(item.name) === folded(column.name));
    if (isLocal && column.id !== undefined && named && named.id !== column.id) invalid('Personal column identity conflicts with the team column.');
    if (isLocal && existing && folded(existing.name) !== folded(column.name)) invalid('Personal overrides must keep the shared column name.');
    const id = column.id ?? existing?.id ?? generatedId('column', column.name);
    const out = { ...(existing || { id, role: 'active', color: 'gray', description: '', strategy: {}, automations: { onEnter: [], onExit: [] } }), ...structuredClone(column), id, name: nameOf(column.name) };
    // An absent strategy is inherited, and explicit null field values remain null.
    out.strategy = { ...(existing?.strategy || {}), ...(column.strategy || {}) };
    if (column.strategy !== undefined && !record(column.strategy)) invalid('Repository strategy must be an object.');
    if (Object.hasOwn(column.strategy || {}, 'planExitTarget') && Object.hasOwn(column.strategy || {}, 'planExitTargetId')) invalid('Use one native plan target, by name or ID.');
    if (Object.hasOwn(column.strategy || {}, 'planExitTarget')) delete out.strategy.planExitTargetId;
    if (Object.hasOwn(column.strategy || {}, 'planExitTargetId')) delete out.strategy.planExitTarget;
    if (!isLocal && team.columns.some(item => Object.hasOwn(item, 'automations')) && !Object.hasOwn(column, 'automations')) out.automations = {};
    const index = columns.findIndex(item => item.id === id);
    if (index < 0) columns.push(out); else columns[index] = out;
    provided.set(id, out.strategy);
  };
  for (const column of team?.columns || []) merge(column, false);
  for (const column of local?.columns || []) merge(column, true);
  for (const role of ['todo', 'done']) if (!columns.some(column => column.role === role)) columns.push(structuredClone(baseline.columns.find(column => column.role === role)));
  const ordered = [...columns.filter(column => column.role === 'todo'), ...columns.filter(column => !['todo', 'done'].includes(column.role)), ...columns.filter(column => column.role === 'done')];
  for (const column of ordered) {
    column.strategy = strategy(provided.get(column.id) ?? column.strategy, ordered);
    if (record(column.automations)) for (const group of ['onEnter', 'onExit']) if (Array.isArray(column.automations[group])) column.automations[group] = column.automations[group].map(row => record(row) && row.id === undefined
      ? { ...row, id: generatedId('automation', `${column.id}:${group}:${row.name}`) } : row);
  }
  let profiles = structuredClone(baseline.profiles);
  if (team && Object.hasOwn(team, 'profiles')) {
    if (!Array.isArray(team.profiles) || team.profiles.length > 30) invalid('Team configuration supports at most 30 board profiles.');
    profiles = team.profiles.map(profile => {
      keys(profile, ['id', 'name', 'columns'], 'Team board profile');
      if (!record(profile.columns)) invalid('Profile columns must be a map of column names to strategies.');
      const name = nameOf(profile.name), existing = baseline.profiles.find(item => profile.id !== undefined ? item.id === profile.id : folded(item.name) === folded(name));
      const references = new Set();
      return { id: profile.id ?? existing?.id ?? generatedId('profile', name), name, columns: Object.fromEntries(Object.entries(profile.columns).map(([name, input]) => {
        const column = ordered.find(item => folded(item.name) === folded(nameOf(name)));
        if (!column) invalid('A board profile names a missing column.');
        if (references.has(column.id)) invalid('A board profile names the same column more than once.');
        references.add(column.id);
        return [column.id, strategy(input, ordered)];
      })) };
    });
  }
  const pipeline = normalizePipelineConfig({ version: 1, columns: ordered, profiles });
  return { pipeline, canonical, shared: shared || pipeline };
}

/** A portable team definition; profiles and plan targets refer to display names. */
export function repositoryPipelineDefinition(input) {
  const pipeline = normalizePipelineConfig(input), names = new Map(pipeline.columns.map(column => [column.id, column.name]));
  const byName = input => {
    const out = { ...input }; if (Object.hasOwn(out, 'planExitTargetId')) { out.planExitTarget = out.planExitTargetId === null ? null : names.get(out.planExitTargetId); delete out.planExitTargetId; } return out;
  };
  return { version: 1, columns: pipeline.columns.map(column => ({ ...column, strategy: byName(column.strategy) })),
    profiles: pipeline.profiles.map(profile => ({ ...profile, columns: Object.fromEntries(Object.entries(profile.columns).map(([id, own]) => [names.get(id), byName(own)])) })) };
}
