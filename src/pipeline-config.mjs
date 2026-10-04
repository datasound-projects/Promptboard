/** Pure configuration for the forthcoming column lifecycle. Reading it never starts work. */
import { randomUUID } from 'node:crypto';

export class PipelineConfigError extends Error {
  constructor(message) { super(message); this.code = 'INVALID_PIPELINE_CONFIG'; this.status = 400; }
}
const fail = message => { throw new PipelineConfigError(message); };
const record = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const reserved = new Set(['__proto__', 'prototype', 'constructor']);
const idOf = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value) && !reserved.has(value) ? value : fail('Use a stable column, profile, or automation ID of at most 100 characters.');
const text = (value, max, label, required = false) => {
  if (typeof value !== 'string' || value.includes('\0') || value.length > max || (required && !value.trim())) fail(`${label} must be ${required ? 'nonempty ' : ''}text of at most ${max} characters without null characters.`);
  return value;
};
const nameOf = (value, label = 'Name') => text(value, 80, label, true).trim();
const bool = (value, label) => typeof value === 'boolean' ? value : fail(`${label} must be true or false.`);
const choice = (value, options, label) => options.includes(value) ? value : fail(`Choose a supported ${label}.`);
const keys = (value, allowed, label) => { if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(`${label} has an unsupported field.`); };
const STRATEGY_FIELDS = ['autoSpawn', 'agentOverride', 'modelOverride', 'effortOverride', 'permissionMode', 'handoffContext', 'sessionTarget', 'sessionSpawnStrategy', 'planExitTargetId'];
export const PIPELINE_STRATEGY_DEFAULTS = Object.freeze({ autoSpawn: true, agentOverride: null, modelOverride: null, effortOverride: null,
  permissionMode: null, handoffContext: false, sessionTarget: 'main', sessionSpawnStrategy: 'create_or_resume', planExitTargetId: null });
const PROVIDERS = ['claude', 'codex', 'gemini'];

/** Sparse values retain absent, cleared (null), and set as distinct states. */
export function normalizePipelineStrategy(input = {}) {
  keys(input, STRATEGY_FIELDS, 'Strategy');
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === null) { result[key] = null; continue; }
    if (['autoSpawn', 'handoffContext'].includes(key)) result[key] = bool(value, key);
    else if (key === 'agentOverride') result[key] = choice(value, PROVIDERS, 'agent');
    else if (key === 'modelOverride') result[key] = typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,99}$/.test(value) ? value : fail('Use a model ID without spaces or command flags.');
    else if (key === 'effortOverride') result[key] = choice(value, ['low', 'medium', 'high', 'xhigh', 'max'], 'effort');
    else if (key === 'permissionMode') result[key] = choice(value, ['default', 'plan', 'acceptEdits', 'workspace-write', 'auto_edit'], 'permission mode');
    else if (key === 'sessionTarget') result[key] = choice(value, ['main', 'isolated'], 'session target');
    else if (key === 'sessionSpawnStrategy') result[key] = choice(value, ['create_or_resume', 'always_spawn_new'], 'session spawn strategy');
    else result[key] = idOf(value);
  }
  return result;
}

/** Validation accepts definitions only. Execution belongs to the automation service. */
export function normalizePipelineAutomations(input = {}) {
  keys(input, ['onEnter', 'onExit'], 'Automations');
  const names = new Set(), ids = new Set(), result = { onEnter: [], onExit: [] };
  for (const group of Object.keys(result)) {
    const rows = input[group] ?? [];
    if (!Array.isArray(rows) || rows.length > 40) fail('An automation group can have at most 40 rows.');
    result[group] = rows.map(row => {
      if (!record(row)) fail('An automation must be an object.');
      const type = choice(row.type, ['send_message', 'run_script', 'webhook', 'notify'], 'automation type');
      const fields = { send_message: ['message', 'mode'], run_script: ['script', 'timeoutMinutes'], webhook: ['url', 'method', 'body', 'headers'], notify: ['title', 'body'] }[type];
      keys(row, ['id', 'name', 'type', 'enabled', ...fields], 'Automation');
      const name = nameOf(row.name, 'Automation name'), id = row.id === undefined ? randomUUID() : idOf(row.id);
      if (ids.has(id) || names.has(name.toLowerCase())) fail('Automation IDs and names must be unique within a column.');
      ids.add(id); names.add(name.toLowerCase());
      const out = { id, name, type, enabled: row.enabled === undefined ? true : bool(row.enabled, 'Enabled') };
      if (type === 'send_message') Object.assign(out, { message: text(row.message, 64 * 1024, 'Message', true), mode: choice(row.mode ?? 'immediate', ['immediate', 'deferred'], 'delivery mode') });
      else if (type === 'run_script') {
        const timeoutMinutes = row.timeoutMinutes ?? 10;
        if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 120) fail('Script timeout must be 1 to 120 whole minutes.');
        Object.assign(out, { script: text(row.script, 64 * 1024, 'Script', true), timeoutMinutes });
      } else if (type === 'webhook') {
        const url = text(row.url, 8192, 'Webhook URL', true);
        // Templates are checked again after rendering; credentials in URLs are never accepted.
        let parsed; try { parsed = new URL(url.replace(/\{\{[^{}]+\}\}/g, 'template')); } catch { fail('Use an HTTP or HTTPS webhook URL.'); }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) fail('Use an HTTP or HTTPS webhook URL without embedded credentials.');
        const headers = row.headers ?? {};
        if (!record(headers) || Object.keys(headers).length > 30) fail('Webhook headers must be an object with at most 30 fields.');
        for (const [key, value] of Object.entries(headers)) {
          if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || reserved.has(key) || ['host', 'content-length', 'connection', 'transfer-encoding', 'idempotency-key'].includes(key.toLowerCase())) fail('Webhook header name is invalid or reserved.');
          if (typeof value !== 'string' || /[\r\n\0]/.test(value) || value.length > 8192) fail('Webhook header values must be bounded text without line breaks.');
        }
        Object.assign(out, { url, method: choice(row.method ?? 'POST', ['GET', 'POST', 'PUT'], 'webhook method'), body: text(row.body ?? '', 64 * 1024, 'Webhook body'), headers: { ...headers } });
      } else Object.assign(out, { title: text(row.title ?? '{{title}}', 500, 'Notification title'), body: text(row.body ?? '{{toColumn}}', 4000, 'Notification body') });
      return out;
    });
  }
  return result;
}

export function defaultPipelineConfig() {
  const seeds = [['todo', 'To Do', 'gray', 'todo'], ['planning', 'Planning', 'violet'], ['executing', 'Executing', 'blue'],
    ['code_review', 'Code Review', 'amber'], ['testing', 'Testing', 'teal'], ['merge', 'Merge', 'pink'], ['done', 'Done', 'green', 'done']];
  return normalizePipelineConfig({ version: 1, columns: seeds.map(([id, name, color, role]) => ({ id, name, color, ...(role ? { role } : {}),
    strategy: id === 'planning' ? { permissionMode: 'plan', planExitTargetId: 'executing' } : {}, automations: {} })) });
}

/** Stable IDs connect profiles and plan targets; display names carry no stage behavior. */
export function normalizePipelineConfig(input) {
  keys(input, ['version', 'columns', 'profiles'], 'Pipeline configuration');
  if (input.version !== 1) fail('Unsupported pipeline configuration version.');
  if (!Array.isArray(input.columns) || input.columns.length < 2 || input.columns.length > 30) fail('A pipeline needs 2 to 30 columns, including To Do and Done roles.');
  const ids = new Set(), names = new Set();
  const columns = input.columns.map(column => {
    keys(column, ['id', 'name', 'role', 'color', 'description', 'strategy', 'automations'], 'Column');
    const id = idOf(column.id), name = nameOf(column.name, 'Column name');
    if (ids.has(id) || names.has(name.toLowerCase())) fail('Column IDs and names must be unique.');
    ids.add(id); names.add(name.toLowerCase());
    const role = choice(column.role ?? 'active', ['todo', 'active', 'done'], 'column role');
    const color = choice(column.color ?? 'gray', ['gray', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink'], 'column color');
    const strategy = normalizePipelineStrategy(column.strategy), automations = normalizePipelineAutomations(column.automations);
    if (role !== 'active' && automations.onEnter.length) fail('To Do and Done roles support exit automations only.');
    return { id, name, role, color, description: text(column.description ?? '', 4000, 'Column description'), strategy, automations };
  });
  if (columns.filter(column => column.role === 'todo').length !== 1 || columns.filter(column => column.role === 'done').length !== 1) fail('A pipeline must have exactly one To Do role and one Done role.');
  if (columns[0].role !== 'todo' || columns.at(-1).role !== 'done') fail('The To Do role must be first and the Done role last.');
  const checkTarget = (strategy, sourceId) => {
    if (strategy.planExitTargetId && (!ids.has(strategy.planExitTargetId) || strategy.planExitTargetId === sourceId || columns.find(column => column.id === strategy.planExitTargetId).role !== 'active')) fail('A plan exit target must be another active column.');
  };
  for (const column of columns) checkTarget(column.strategy, column.id);
  const profiles = input.profiles ?? [];
  if (!Array.isArray(profiles) || profiles.length > 30) fail('A pipeline can have at most 30 profiles.');
  const profileIds = new Set(), profileNames = new Set();
  const normalizedProfiles = profiles.map(profile => {
    keys(profile, ['id', 'name', 'columns'], 'Profile');
    const id = idOf(profile.id), name = nameOf(profile.name, 'Profile name');
    if (profileIds.has(id) || profileNames.has(name.toLowerCase()) || name.toLowerCase() === 'default') fail('Profile IDs and names must be unique; Default is reserved.');
    profileIds.add(id); profileNames.add(name.toLowerCase());
    if (!record(profile.columns) || Object.keys(profile.columns).length > columns.length) fail('Profile columns must be a strategy map.');
    const overrides = Object.fromEntries(Object.entries(profile.columns).map(([columnId, value]) => {
      if (!ids.has(columnId)) fail('A profile refers to a missing column.');
      const strategy = normalizePipelineStrategy(value); checkTarget(strategy, columnId); return [columnId, strategy];
    }));
    return { id, name, columns: overrides };
  });
  return { version: 1, columns, profiles: normalizedProfiles };
}

/** One task selection; validating or saving this definition never starts an agent. */
export function normalizePipelineTaskSelection(config, input = {}) {
  keys(input, ['profileId', 'agentOverride'], 'Task pipeline settings');
  const profileId = input.profileId === undefined || input.profileId === null ? null : idOf(input.profileId);
  const agentOverride = input.agentOverride === undefined || input.agentOverride === null ? null : input.agentOverride;
  if (profileId && agentOverride) fail('Choose a board profile or a task-wide agent override, not both.');
  if (profileId && !config.profiles.some(profile => profile.id === profileId)) fail('Choose an existing board profile.');
  if (agentOverride !== null) {
    keys(agentOverride, ['agentOverride', 'modelOverride', 'effortOverride', 'permissionMode'], 'Task-wide agent override');
    const own = normalizePipelineStrategy(agentOverride);
    if (!own.agentOverride) fail('Choose the agent for a task-wide override.');
    return { profileId: null, agentOverride: Object.fromEntries(['agentOverride', 'modelOverride', 'effortOverride', 'permissionMode'].filter(key => own[key] != null).map(key => [key, own[key]])) };
  }
  return { profileId, agentOverride: null };
}

/** Profiles change strategy only; task-wide agent pins and a profile are mutually exclusive. */
export function resolvePipelineStrategy(config, columnId, { profileId = null, agentOverride = null } = {}) {
  const column = config.columns.find(column => column.id === columnId);
  if (!column) fail('The task refers to a missing column.');
  if (profileId && agentOverride) fail('Choose a board profile or a task-wide agent override, not both.');
  const profile = profileId ? config.profiles.find(profile => profile.id === profileId) : null;
  if (profileId && !profile) fail('The task refers to a missing board profile.');
  const resolved = { ...PIPELINE_STRATEGY_DEFAULTS };
  for (const layer of [column.strategy, profile?.columns[columnId]]) for (const [key, value] of Object.entries(layer || {})) resolved[key] = value === null ? PIPELINE_STRATEGY_DEFAULTS[key] : value;
  if (agentOverride) {
    keys(agentOverride, ['agentOverride', 'modelOverride', 'effortOverride', 'permissionMode'], 'Task-wide agent override');
    const own = normalizePipelineStrategy(agentOverride);
    // Task-wide pins replace the column's agent tuple, including absent optional pins.
    for (const key of ['agentOverride', 'modelOverride', 'effortOverride', 'permissionMode']) resolved[key] = own[key] ?? PIPELINE_STRATEGY_DEFAULTS[key];
  }
  if (column.role !== 'active') resolved.autoSpawn = false;
  return resolved;
}
