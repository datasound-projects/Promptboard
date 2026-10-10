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
const STRATEGY_FIELDS = ['autoSpawn', 'agentOverride', 'modelOverride', 'effortOverride', 'permissionMode', 'handoffContext', 'sessionTarget', 'sessionSpawnStrategy', 'planExitTargetId',
  'interaction', 'filesystem', 'completion'];
// interaction/filesystem/completion are null (inherit the project's execution policy) unless a layer sets them.
export const PIPELINE_STRATEGY_DEFAULTS = Object.freeze({ autoSpawn: true, agentOverride: null, modelOverride: null, effortOverride: null,
  permissionMode: null, handoffContext: false, sessionTarget: 'main', sessionSpawnStrategy: 'create_or_resume', planExitTargetId: null,
  interaction: null, filesystem: null, completion: null });
const PROVIDERS = ['claude', 'codex', 'gemini'];
// Task-wide pins: the agent tuple plus the execution policy fields.
const TASK_OVERRIDE_FIELDS = ['agentOverride', 'modelOverride', 'effortOverride', 'permissionMode', 'interaction', 'filesystem', 'completion'];

/**
 * What an active column does, independent of its display name. `custom` keeps the column-pipeline behaviour (one
 * conversation that continues across compatible columns). The other kinds run Promptboard's stage engine: each
 * arrival starts a fresh agent session in the task's own worktree, with a handoff built from the task's recorded
 * stage results, and the stage's checks (plan, checkpoint commit, review verdict, test exit codes, merge).
 */
export const COLUMN_KINDS = Object.freeze(['planning', 'execution', 'review', 'testing', 'merge', 'custom']);
/** The stage contract each kind follows (the legacy stage names used by the shared engine and agent instructions). */
export const KIND_STAGES = Object.freeze({ planning: 'planning', execution: 'executing', review: 'code_review', testing: 'testing', merge: 'merge' });
export const INTERACTIONS = Object.freeze(['ask', 'autonomous']);
export const FILESYSTEMS = Object.freeze(['read_only', 'workspace_write', 'full']);
export const COMPLETIONS = Object.freeze(['manual', 'automatic']);
/** Provider-independent defaults: ask before risky actions, write only in the task workspace, confirm stages yourself. */
export const EXECUTION_DEFAULTS = Object.freeze({ interaction: 'ask', filesystem: 'workspace_write', completion: 'manual', maxRework: 2 });
const SEEDED_KINDS = Object.freeze({ planning: 'planning', executing: 'execution', code_review: 'review', testing: 'testing', merge: 'merge' });

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
    else if (key === 'interaction') result[key] = choice(value, INTERACTIONS, 'interaction mode');
    else if (key === 'filesystem') result[key] = choice(value, FILESYSTEMS, 'workspace access');
    else if (key === 'completion') result[key] = choice(value, COMPLETIONS, 'completion mode');
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

/** New boards use the stage engine in every active column: Planning → Executing → Code Review → Testing → Merge. */
export function defaultPipelineConfig() {
  const seeds = [['todo', 'To Do', 'gray', 'todo'], ['planning', 'Planning', 'violet'], ['executing', 'Executing', 'blue'],
    ['code_review', 'Code Review', 'amber'], ['testing', 'Testing', 'teal'], ['merge', 'Merge', 'pink'], ['done', 'Done', 'green', 'done']];
  return normalizePipelineConfig({ version: 1, columns: seeds.map(([id, name, color, role]) => ({ id, name, color, ...(role ? { role } : { kind: SEEDED_KINDS[id] }),
    strategy: {}, automations: {} })) });
}

/**
 * Give the seeded columns of an older column pipeline their stage kinds (a preset the user applies explicitly).
 * Columns with other IDs keep their kind. The returned configuration is normalized; nothing runs.
 */
export function withSeededKinds(config) {
  const clean = normalizePipelineConfig(config);
  return normalizePipelineConfig({ ...clean, columns: clean.columns.map(column => column.role === 'active' && SEEDED_KINDS[column.id] && column.kind === 'custom'
    ? { ...column, kind: SEEDED_KINDS[column.id], strategy: column.id === 'planning' ? { ...column.strategy, planExitTargetId: null } : column.strategy } : column) });
}

/** Stable IDs connect profiles and plan targets; display names carry no stage behavior. */
export function normalizePipelineConfig(input) {
  keys(input, ['version', 'columns', 'profiles'], 'Pipeline configuration');
  if (input.version !== 1) fail('Unsupported pipeline configuration version.');
  if (!Array.isArray(input.columns) || input.columns.length < 2 || input.columns.length > 30) fail('A pipeline needs 2 to 30 columns, including To Do and Done roles.');
  const ids = new Set(), names = new Set();
  const columns = input.columns.map(column => {
    keys(column, ['id', 'name', 'role', 'kind', 'color', 'description', 'strategy', 'automations'], 'Column');
    const id = idOf(column.id), name = nameOf(column.name, 'Column name');
    if (ids.has(id) || names.has(name.toLowerCase())) fail('Column IDs and names must be unique.');
    ids.add(id); names.add(name.toLowerCase());
    const role = choice(column.role ?? 'active', ['todo', 'active', 'done'], 'column role');
    const color = choice(column.color ?? 'gray', ['gray', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink'], 'column color');
    const strategy = normalizePipelineStrategy(column.strategy), automations = normalizePipelineAutomations(column.automations);
    if (role !== 'active' && automations.onEnter.length) fail('To Do and Done roles support exit automations only.');
    // Columns saved before kinds existed keep their exact behaviour: they are `custom`.
    if (role !== 'active' && column.kind != null) fail('To Do and Done roles have no column type.');
    const kind = role === 'active' ? choice(column.kind ?? 'custom', COLUMN_KINDS, 'column type') : undefined;
    return { id, name, role, ...(kind ? { kind } : {}), color, description: text(column.description ?? '', 4000, 'Column description'), strategy, automations };
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
    keys(agentOverride, TASK_OVERRIDE_FIELDS, 'Task-wide agent override');
    const own = normalizePipelineStrategy(agentOverride);
    if (!own.agentOverride) fail('Choose the agent for a task-wide override.');
    return { profileId: null, agentOverride: Object.fromEntries(TASK_OVERRIDE_FIELDS.filter(key => own[key] != null).map(key => [key, own[key]])) };
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
    keys(agentOverride, TASK_OVERRIDE_FIELDS, 'Task-wide agent override');
    const own = normalizePipelineStrategy(agentOverride);
    // Task-wide pins replace the column's agent tuple, including absent optional pins.
    for (const key of ['agentOverride', 'modelOverride', 'effortOverride', 'permissionMode']) resolved[key] = own[key] ?? PIPELINE_STRATEGY_DEFAULTS[key];
    // Execution policy pins are sparse: an absent field keeps the column/profile value.
    for (const key of ['interaction', 'filesystem', 'completion']) if (own[key] != null) resolved[key] = own[key];
  }
  if (column.role !== 'active') resolved.autoSpawn = false;
  return resolved;
}

/** The project-wide execution policy (Kanban settings). Missing fields use EXECUTION_DEFAULTS. */
export function normalizeExecutionPolicy(input = {}) {
  keys(input, ['interaction', 'filesystem', 'completion', 'maxRework', 'mergeMethod'], 'Execution policy');
  const result = {};
  if (input.mergeMethod != null) result.mergeMethod = choice(input.mergeMethod, ['squash', 'fast_forward'], 'merge method');
  if (input.interaction != null) result.interaction = choice(input.interaction, INTERACTIONS, 'interaction mode');
  if (input.filesystem != null) result.filesystem = choice(input.filesystem, FILESYSTEMS, 'workspace access');
  if (input.completion != null) result.completion = choice(input.completion, COMPLETIONS, 'completion mode');
  if (input.maxRework != null) {
    if (!Number.isInteger(input.maxRework) || input.maxRework < 0 || input.maxRework > 5) fail('Allow 0 to 5 automatic rework rounds.');
    result.maxRework = input.maxRework;
  }
  return result;
}

/**
 * The one place that decides how an agent may act in a column. Precedence, most specific first:
 * task-wide override → board profile → column → project execution policy → defaults. Planning and Review
 * columns are always read-only, whatever any layer says. The legacy `permissionMode: 'plan'` of a custom
 * column still means read-only when no layer chose a workspace access.
 */
export function resolveExecutionPolicy(config, columnId, task = {}, projectPolicy = {}) {
  const column = config.columns.find(item => item.id === columnId);
  if (!column) fail('The task refers to a missing column.');
  const strategy = resolvePipelineStrategy(config, columnId, task);
  const global = projectPolicy || {};
  const pick = key => strategy[key] ?? global[key] ?? EXECUTION_DEFAULTS[key];
  const source = key => strategy[key] != null ? 'column' : global[key] != null ? 'project' : 'default';
  const kind = column.role === 'active' ? column.kind || 'custom' : null;
  let filesystem = pick('filesystem'), filesystemSource = source('filesystem');
  if (kind === 'planning' || kind === 'review') { filesystem = 'read_only'; filesystemSource = 'column type'; }
  else if (kind === 'custom' && strategy.permissionMode === 'plan' && strategy.filesystem == null) { filesystem = 'read_only'; filesystemSource = 'column'; }
  return { kind, stage: KIND_STAGES[kind] || null, interaction: pick('interaction'), filesystem, completion: pick('completion'),
    maxRework: global.maxRework ?? EXECUTION_DEFAULTS.maxRework, sources: { interaction: source('interaction'), filesystem: filesystemSource, completion: source('completion') } };
}
