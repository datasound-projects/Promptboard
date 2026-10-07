/**
 * Agentic Kanban service (PB-01). Owns the column model, validated task transitions,
 * the run records, browser-board migration, import/export, repository links, and task
 * worktrees. See docs/agentic-kanban-contract.md.
 *
 * Nothing here launches an agent. Runs need an executor (PB-02); without one, run
 * requests are refused before any worktree is created.
 */
import { randomUUID } from 'node:crypto';
import { attachSession, attachResumedRun, LIVE_SESSION_STATUSES, recoverSessions, synchronizeSession } from './sessions.mjs';
import { access, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { Store } from './store.mjs';
import { taskPriority } from './task-priority.mjs';
import { taskLabels, taskLabelIds, labelRevision } from './task-labels.mjs';
import { BACKLOG_LIMIT, backlogItems, backlogPrompt, backlogRevision, backlogTitle, validateBacklogs } from './backlog.mjs';
import { assignTaskNumbers, allocateTaskNumber, validateTaskNumbers } from './task-numbers.mjs';
import { branchExists, commitExists, git, GitError, initRepository, listWorktrees, repositoryIdentity, validateRepository } from './git.mjs';
import { ADAPTERS, resolveConfig, validateResumeId } from './agents.mjs';
import { Delivery } from './delivery.mjs';
import { ensureClone, fastForward, fetchAndCompare, viewRepository } from './github.mjs';
import { githubIssueSource, listGitHubBacklogIssues } from './backlog-github.mjs';
import { BacklogCache } from './backlog-cache.mjs';
import { backlogImportSources, backlogImportLedger, externalIssueSource, IMPORT_IDENTITY_LIMIT, validateBacklogImports } from './backlog-imports.mjs';
import { buildTimeline } from './timeline.mjs';
import { Base, normalizeBinding, listTargets, remapBaseScopes } from './base.mjs';
import { checkBaseRevocations, deliveryFor, profileDefaults, resolveBase } from './base-resolver.mjs';
import { defaultPipelineConfig, normalizePipelineConfig, normalizePipelineTaskSelection, resolvePipelineStrategy } from './pipeline-config.mjs';
import { renderPipelineSpawnPrompt } from './pipeline-templates.mjs';
import { PipelineJournal } from './pipeline-journal.mjs';
import { PipelineAutomations } from './pipeline-automations.mjs';
import { PipelineActions } from './pipeline-actions.mjs';
import { NativeMessageScheduler } from './native-message-scheduler.mjs';
import { readRepositoryPipeline, resolveRepositoryPipeline, RepositoryPipelineError } from './pipeline-repository.mjs';

export const COLUMNS = Object.freeze([
  { id: 'todo', title: 'To Do', agent: false },
  { id: 'planning', title: 'Planning', agent: true },
  { id: 'executing', title: 'Executing', agent: true },
  { id: 'code_review', title: 'Code Review', agent: true },
  { id: 'testing', title: 'Testing', agent: true },
  { id: 'merge', title: 'Merge', agent: true },
  { id: 'done', title: 'Done', agent: false },
]);
const COLUMN_IDS = COLUMNS.map(column => column.id);
export const RUN_STATUSES = Object.freeze(['queued', 'running', 'waiting_for_input', 'suspended', 'succeeded', 'failed', 'cancelled', 'interrupted']);
export const ACTIVE_RUN_STATUSES = Object.freeze(['queued', 'running', 'waiting_for_input']);
// Succeeded is reached only through an explicit user confirmation (supervisor.confirm).
const RUN_NEXT = { queued: ['running', 'cancelled', 'failed', 'interrupted', 'suspended'], running: ['waiting_for_input', 'succeeded', 'failed', 'cancelled', 'interrupted', 'suspended'],
  waiting_for_input: ['running', 'succeeded', 'cancelled', 'failed', 'interrupted', 'suspended'] };
// Stages that can run an agent. To Do and Done never do.
const EXECUTABLE_STAGES = new Set(['planning', 'executing', 'code_review', 'testing', 'merge']);
// Per-stage workflow settings. Projects store overrides; defaults apply otherwise.
// To Do, Merge, and Done have no run policy: To Do and Done never run, and a merge always needs confirmation.
export const WORKFLOW_STAGES = Object.freeze(['planning', 'executing', 'code_review', 'testing', 'merge']);
const POLICIES = ['manual', 'ask', 'start'];
export const DEFAULT_STAGE_SETTINGS = Object.freeze({ policy: 'start', provider: 'claude', model: '', effort: '', permissionMode: '', instructions: '' });
const RUN_FIELDS = ['hasReview', 'startedAt', 'endedAt', 'providerSessionId', 'waitingReason', 'errorCode', 'exitCode', 'hasPlan', 'planExcerpt', 'turns', 'lifecycle', 'turnComplete', 'usage', 'activity', 'planRoutes'];
// Stages whose first authorized run may create the task branch and worktree.
const WORKSPACE_STAGES = new Set(['planning', 'executing']);

const PROJECT_LIMIT = 200;
const TASK_LIMIT = 1000;
const MAX_PROMPT = 2 * 1024 * 1024;
const TRANSITION_ID = /^[A-Za-z0-9_-]{8,100}$/;
const TRANSITION_LOG_LIMIT = 100; // ponytail: per-task cap; move history to its own file if audits need more.
const PROVIDERS = ['codex', 'claude', 'gemini', 'agy'];

export class BoardError extends Error {
  constructor(message, code, status = 400) { super(message); this.code = code; this.status = status; }
}
const conflict = (message, code = 'REVISION_CONFLICT') => new BoardError(message, code, 409);

// ---- Validation shared by migration, import, and the HTTP API ----

function text(value, max, label) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result || result.length > max) throw new BoardError(`${label} needs 1 to ${max} characters.`, 'INVALID_INPUT');
  return result;
}
function promptText(value, label, allowBlank = false) {
  // The prompt is kept exactly as given, including whitespace and line endings.
  if (typeof value !== 'string' || (!allowBlank && !value.trim()) || value.length > MAX_PROMPT) throw new BoardError(`${label} needs ${allowBlank ? 'a text prompt of at most' : 'a prompt of 1 to'} ${MAX_PROMPT.toLocaleString('en-US')} characters.`, 'INVALID_INPUT');
  return value;
}
const clip = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const time = value => Number.isFinite(value) ? value : Date.now();

const RECORD_ID = /^[A-Za-z0-9_-]{1,100}$/;
/** Where a card came from in Origin. A repeated handoff finds the card by it instead of adding another. */
export function originSourceOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !RECORD_ID.test(value.originProjectId) || !RECORD_ID.test(value.originTaskId)) throw new BoardError('The Origin reference is not valid.', 'INVALID_INPUT');
  return { originProjectId: value.originProjectId, originTaskId: value.originTaskId, snapshotId: RECORD_ID.test(value.snapshotId) ? value.snapshotId : '',
    hash: typeof value.hash === 'string' && /^[a-f0-9]{64}$/.test(value.hash) ? value.hash : '', key: typeof value.key === 'string' ? value.key.slice(0, 20) : '' };
}
/** Prerequisite cards: other cards of the same project that must be done before this one starts. */
function prerequisiteIds(value, ids, selfId) {
  if (!Array.isArray(value) || value.length > 50) throw new BoardError('A card can have at most 50 prerequisites.', 'INVALID_INPUT');
  const list = [...new Set(value)];
  if (list.some(id => typeof id !== 'string' || id === selfId || !ids.has(id))) throw new BoardError('A prerequisite refers to a card that does not exist on this board.', 'INVALID_INPUT');
  return list;
}

export function normalizeSource(source) {
  if (!source || typeof source !== 'object') return null;
  return {
    historyId: clip(source.historyId, 80), provider: PROVIDERS.includes(source.provider) ? source.provider : '',
    model: clip(source.model, 100), effort: clip(source.effort, 20),
    reportedModels: Array.isArray(source.reportedModels) ? source.reportedModels.filter(model => typeof model === 'string').map(model => model.slice(0, 100)).slice(0, 20) : [],
    language: ['en', 'de', 'pl'].includes(source.language) ? source.language : '', quality: ['reviewed', 'fast'].includes(source.quality) ? source.quality : '',
    verification: ['checks-passed', 'needs-review'].includes(source.verification) ? source.verification : 'none',
    generatedAt: Number.isFinite(source.generatedAt) ? source.generatedAt : null,
  };
}

/** Validate a browser board (v1) or a backup (v1 kanban-backup, v2 promptboard-backup). */
export function parseBackup(data) {
  try { return parseBackupData(data); }
  catch (error) { throw error instanceof BoardError || ['INVALID_PIPELINE_CONFIG', 'INVALID_TASK_PRIORITY', 'INVALID_TASK_LABELS', 'INVALID_BACKLOG', 'INVALID_BACKLOG_IMPORT'].includes(error.code) ? new BoardError(error.message, 'INVALID_BACKUP') : error; }
}
function parseBackupData(data) {
  const v1 = data?.version === 1 && (data.kind === undefined || data.kind === 'kanban-backup');
  const v2 = [2, 3, 4, 5, 6, 7, 8, 9, 10].includes(data?.version) && data.kind === 'promptboard-backup';
  const v3 = [3, 4, 5, 6, 7, 8, 9, 10].includes(data?.version) && data.kind === 'promptboard-backup';
  if (!data || typeof data !== 'object' || (!v1 && !v2) || !Array.isArray(data.projects)) throw new BoardError('The data is not a Promptboard or version 1 Kanban board.', 'INVALID_BACKUP');
  if (data.projects.length > PROJECT_LIMIT) throw new BoardError(`A board can have at most ${PROJECT_LIMIT} projects.`, 'INVALID_BACKUP');
  const ids = new Set();
  const unique = (value, label) => {
    if (typeof value !== 'string' || !value || value.length > 100 || ids.has(value)) throw new BoardError(`${label} needs a unique ID.`, 'INVALID_BACKUP');
    ids.add(value);
    return value;
  };
  const names = new Set();
  const projects = data.projects.map((project, index) => {
    const label = `Project ${index + 1}`;
    if (!project || typeof project !== 'object') throw new BoardError(`${label} is not valid.`, 'INVALID_BACKUP');
    const cards = v1 ? project.cards : project.tasks;
    if (!Array.isArray(cards) || cards.length > TASK_LIMIT) throw new BoardError(`${label} needs a card list with at most ${TASK_LIMIT} cards.`, 'INVALID_BACKUP');
    const name = text(project.name, 80, `${label} name`);
    if (names.has(name.toLowerCase())) throw new BoardError(`${label} repeats the project name “${name}”.`, 'INVALID_BACKUP');
    names.add(name.toLowerCase());
    if ([4, 5, 6, 7, 8, 9, 10].includes(data.version) && project.workflowMode !== undefined && !['legacy', 'pipeline'].includes(project.workflowMode)) throw new BoardError('Unknown backup workflow mode.', 'INVALID_BACKUP');
    const pipeline = [4, 5, 6, 7, 8, 9, 10].includes(data.version) && project.workflowMode === 'pipeline' ? normalizePipelineConfig(project.pipeline) : null;
    if (data.version >= 8 && (!Array.isArray(project.labels) || cards.some(card => !Array.isArray(card?.labelIds)))) throw new BoardError('Label metadata is missing from this backup.', 'INVALID_BACKUP');
    const labels = data.version >= 8 ? taskLabels(project.labels) : [];
    const columnLayout = !pipeline && v2 && Array.isArray(project.columnLayout) && project.columnLayout.length ? normalizeColumns(project.columnLayout) : null;
    const columnIds = new Set(pipeline ? pipeline.columns.map(column => column.id) : [...COLUMN_IDS, ...(columnLayout || []).filter(entry => entry.custom).map(entry => entry.id)]);
    return {
      id: unique(project.id, label), name, createdAt: time(project.createdAt), labels,
      backlog: data.version >= 9 ? backlogItems(project.backlog, labels).map(item => ({ ...item, id: unique(item.id, label + ' backlog item'), source: normalizeSource(item.source) })) : [], backlogRevision: 0,
      backlogSources: data.version >= 10 ? backlogImportSources(project.backlogSources) : [], backlogImported: data.version >= 10 ? backlogImportLedger(project.backlogImported) : [],
      ...(data.version >= 6 ? { nextTaskNumber: project.nextTaskNumber } : {}),
      columnLayout,
      pipeline,
      agentDefaults: v2 && project.agentDefaults?.provider ? normalizeAgent(project.agentDefaults) : null,
      ...(v3 ? backupBaseScopes(project, false, columnIds) : {}),
      repositoryPath: v2 && typeof project.repository?.path === 'string' ? project.repository.path.slice(0, 4096) : null,
      targetBranch: v2 && typeof project.targetBranch?.name === 'string' ? project.targetBranch.name.slice(0, 255) : null,
      // Imported workflow settings (including legacy automation) are kept for confirmation only.
      workflow: v2 && project.workflow && typeof project.workflow === 'object' ? project.workflow : v2 && project.automation?.autoRun === true ? { executing: { policy: 'start' } } : null,
      // Imported test commands never run until the user confirms them.
      testCommands: v2 && Array.isArray(project.testCommands) && project.testCommands.length ? project.testCommands.slice(0, 20) : null,
      // The user's timeline notes. Malformed entries are dropped; system events are rebuilt from the board.
      timelineNotes: v2 && Array.isArray(project.timelineNotes) ? project.timelineNotes.slice(0, 500).flatMap(note => note && typeof note.title === 'string' && note.title.trim() && Number.isFinite(note.at)
        ? [{ id: typeof note.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(note.id) ? note.id : randomUUID(), title: note.title.trim().slice(0, 120), text: typeof note.text === 'string' ? note.text.slice(0, 2000) : '', at: note.at, taskId: typeof note.taskId === 'string' ? note.taskId : null, createdAt: time(note.createdAt) }] : []) : [],
      tasks: cards.map((card, cardIndex) => {
        const cardLabel = `${label}, card ${cardIndex + 1}`;
        if (!card || typeof card !== 'object') throw new BoardError(`${cardLabel} is not valid.`, 'INVALID_BACKUP');
        if (pipeline && !columnIds.has(card.column)) throw new BoardError(`${cardLabel} refers to a missing pipeline column.`, 'INVALID_BACKUP');
        if ((!pipeline || ![5, 6, 7, 8, 9, 10].includes(data.version)) && (card.profileId != null || card.agentOverride != null)) throw new BoardError('Task pipeline settings require a version 5 or newer pipeline backup.', 'INVALID_BACKUP');
        return { id: unique(card.id, cardLabel), title: text(card.title, 120, `${cardLabel} title`), prompt: promptText(card.prompt, cardLabel, Boolean(pipeline)),
          createdAt: time(card.createdAt), updatedAt: time(card.updatedAt ?? card.createdAt), checksOutdated: card.checksOutdated === true,
          ...(data.version >= 6 ? { number: card.number } : {}),
          labelIds: data.version >= 8 ? taskLabelIds(card.labelIds, labels) : [],
          priority: data.version >= 7 ? taskPriority(card.priority) : 0, source: normalizeSource(card.source), ...(data.version >= 10 && card.externalSource !== undefined ? { externalSource: externalIssueSource(card.externalSource) } : {}),
          ...(data.version >= 10 && card.originSource !== undefined ? { originSource: originSourceOf(card.originSource) } : {}), ...(data.version >= 10 && card.dependsOn !== undefined ? { dependsOn: card.dependsOn } : {}), column: v2 && columnIds.has(card.column) ? card.column : 'todo', ...(v3 ? backupBaseScopes(card, true, columnIds) : {}),
          ...(pipeline && [5, 6, 7, 8, 9, 10].includes(data.version) ? normalizePipelineTaskSelection(pipeline, { profileId: card.profileId, agentOverride: card.agentOverride }) : {}) };
      }),
    };
  });
  // Prerequisites point only at cards of the same project in the backup.
  for (const project of projects) {
    const ids = new Set(project.tasks.map(task => task.id));
    for (const task of project.tasks) if (task.dependsOn !== undefined) {
      try { task.dependsOn = prerequisiteIds(task.dependsOn, ids, task.id); } catch { throw new BoardError(`${project.name || 'A project'}: a card refers to a missing prerequisite.`, 'INVALID_BACKUP'); }
    }
  }
  validateBacklogs(projects.map(project => ({ ...project, workflowMode: project.pipeline ? 'pipeline' : 'legacy' })));
  validateBacklogImports(projects.map(project => ({ ...project, backlogImportRevision: 0, workflowMode: project.pipeline ? 'pipeline' : 'legacy' })));
  for (const project of projects) {
    try { validateTaskNumbers(project, { required: data.version >= 6 }); assignTaskNumbers(project); }
    catch (error) { throw new BoardError(error.message, 'INVALID_BACKUP'); }
  }
  return { projects, ...(v3 ? { base: data.base, baseGlobal: backupBaseScopes(data.baseGlobal || {}) } : {}) };
}

function backupBaseScopes(entity, task = false, columnIds) {
  const result = {};
  if (!entity || typeof entity !== 'object' || Array.isArray(entity)) throw new BoardError('Base assignment data is invalid.', 'INVALID_BACKUP');
  if (task && (entity.agentProfileId || Object.values(entity.baseColumns || {}).some(entry => entry?.profileId))) throw new BoardError('Task Base overrides cannot select an agent provider profile.', 'INVALID_BACKUP');
  if (entity.baseBinding) result.baseBinding = normalizeBinding(entity.baseBinding);
  if (!task && entity.agentProfileId) {
    if (typeof entity.agentProfileId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(entity.agentProfileId)) throw new BoardError('A Base profile reference is invalid.', 'INVALID_BACKUP');
    result.agentProfileId = entity.agentProfileId;
  }
  if (entity.baseColumns) {
    if (typeof entity.baseColumns !== 'object' || Array.isArray(entity.baseColumns) || Object.keys(entity.baseColumns).length > 30) throw new BoardError('Base column references are invalid.', 'INVALID_BACKUP');
    result.baseColumns = Object.fromEntries(Object.entries(entity.baseColumns).map(([id, value]) => {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !value || typeof value !== 'object') throw new BoardError('A Base column reference is invalid.', 'INVALID_BACKUP');
      if (columnIds && !columnIds.has(id)) throw new BoardError('A Base binding refers to a column absent from this backup.', 'INVALID_BACKUP');
      return [id, { binding: normalizeBinding(value.binding), ...(!task && value.profileId ? { profileId: text(value.profileId, 100, 'Profile ID') } : {}) }];
    }));
  }
  return result;
}

function newProject({ id = randomUUID(), name, createdAt = Date.now(), nextTaskNumber = 1, labels = [], backlog = [], backlogSources = [], backlogImported = [] }) {
  return { id, name, createdAt, nextTaskNumber, labels: taskLabels(labels), labelRevision: 0, backlog: backlogItems(backlog, labels), backlogRevision: 0, backlogSources: backlogImportSources(backlogSources), backlogImported: backlogImportLedger(backlogImported), backlogImportRevision: 0, revision: 1, repository: null, targetBranch: null, workflowMode: 'legacy', workflow: {}, pendingImport: null, tasks: [] };
}
function newTask({ id = randomUUID(), title, prompt, source = null, checksOutdated = false, createdAt = Date.now(), updatedAt = createdAt, column = 'todo', number, priority = 0, labelIds = [], externalSource, originSource, dependsOn }) {
  // contentRevision changes only when the title or prompt changes; plan approvals refer to it.
  return { id, title, prompt, source, ...(externalSource === undefined ? {} : { externalSource: externalIssueSource(externalSource) }),
    ...(originSource === undefined ? {} : { originSource: originSourceOf(originSource) }), ...(dependsOn?.length ? { dependsOn: [...dependsOn] } : {}), checksOutdated, createdAt, updatedAt, column, ...(number === undefined ? {} : { number }), priority: taskPriority(priority), labelIds: taskLabelIds(labelIds), revision: 1, contentRevision: 1, planApproval: null, workspace: null, retainedBranches: [], transitions: [] };
}

// Autopilot routes: stages a card visits, in board order. Executing is required (it does the work).
export const ROUTE_STAGES = Object.freeze(['planning', 'executing', 'code_review', 'testing', 'merge']);
export function normalizeRoute(route, finish = 'merge') {
  if (!Array.isArray(route) || route.some(stage => !ROUTE_STAGES.includes(stage))) throw new BoardError('A route lists stages from Planning to Merge.', 'INVALID_AUTOPILOT');
  const clean = ROUTE_STAGES.filter(stage => route.includes(stage));
  if (!clean.includes('executing')) throw new BoardError('A route must include Executing: that is where the agent does the work.', 'INVALID_AUTOPILOT');
  // The route follows the stage contract: Testing needs Code Review, and Merge needs both, because
  // merged code must be reviewed and tested for the same commit (reviewed = tested = HEAD).
  if (clean.includes('testing') && !clean.includes('code_review')) throw new BoardError('A route with Testing must include Code Review: tests run on the reviewed commit.', 'INVALID_AUTOPILOT');
  if (clean.includes('merge') && !(clean.includes('code_review') && clean.includes('testing'))) throw new BoardError('A route that ends in Merge must include Code Review and Testing: the merge needs an accepted review and passing tests for the same commit.', 'INVALID_AUTOPILOT');
  return clean;
}

/** Validate workflow overrides. Unknown stages and fields are dropped; invalid values are refused. */
export function normalizeWorkflow(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BoardError('Send workflow settings as an object.', 'INVALID_WORKFLOW');
  const result = {};
  for (const stage of WORKFLOW_STAGES) {
    const value = input[stage];
    if (!value || typeof value !== 'object') continue;
    const settings = { ...DEFAULT_STAGE_SETTINGS, ...value };
    if (!POLICIES.includes(settings.policy)) throw new BoardError('Choose Manual, Ask on entry, or Start on entry.', 'INVALID_WORKFLOW');
    if (typeof settings.instructions !== 'string' || settings.instructions.length > 4000) throw new BoardError('Stage instructions can have at most 4,000 characters.', 'INVALID_WORKFLOW');
    // "Ask" from earlier versions is "Start": dragging a card is the instruction.
    const entry = { policy: settings.policy === 'ask' ? 'start' : settings.policy, instructions: settings.instructions };
    if (value.permissionMode) {
      if (!['auto', 'approve_edit', 'acceptEdits', 'default', 'workspace-write', 'auto_edit', 'plan'].includes(value.permissionMode)) throw new BoardError('Choose a supported permission mode.', 'INVALID_WORKFLOW');
      entry.permissionMode = value.permissionMode;
    }
    // A stage stores an agent only when it overrides the project and global defaults.
    if (EXECUTABLE_STAGES.has(stage) && value.provider) { // Only a provider the request names; the defaults never pin one.
      try { Object.assign(entry, resolveConfig(stage, settings)); }
      catch (error) { throw new BoardError(error.message, 'INVALID_WORKFLOW'); }
    }
    result[stage] = entry;
  }
  return result;
}

/** Validate one level of the agent hierarchy ({ provider, model, effort }). Empty provider = inherit. */
export function normalizeAgent(input) {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new BoardError('Send the agent as an object.', 'INVALID_INPUT');
  if (!input.provider) return null;
  try { const agent = resolveConfig('executing', input); return { provider: agent.provider, model: agent.model, effort: agent.effort, ...(input.permissionMode ? { permissionMode: agent.permissionMode } : {}) }; }
  catch (error) { throw new BoardError(error.message, 'INVALID_INPUT'); }
}

/**
 * Settings for each stage. The agent comes from the most specific level that names a provider:
 * the stage override, then the project default, then the global default (Settings), then Claude
 * Code with its CLI defaults. Model and effort come from that same level, because they belong to
 * one provider. `agentSource` says which level applied.
 */
export function effectiveWorkflow(project, globalAgent = null, state = null, task = null) {
  if (project?.workflowMode === 'pipeline') return Object.fromEntries(project.pipeline.columns.map(column => {
    const strategy = resolvePipelineStrategy(project.pipeline, column.id, task || {});
    const global = state ? profileDefaults(state, state.settings?.agentProfileId, globalAgent || {}) : globalAgent;
    const defaults = state ? profileDefaults(state, project.agentProfileId, project.agentDefaults || {}) : project.agentDefaults;
    const local = state ? profileDefaults(state, project.baseColumns?.[column.id]?.profileId) : null;
    const inherited = local?.provider ? local : defaults?.provider ? defaults : global || {};
    const agent = strategy.agentOverride ? { provider: strategy.agentOverride } : inherited;
    return [column.id, { provider: agent.provider || 'claude', model: strategy.modelOverride ?? agent.model ?? '', effort: strategy.effortOverride ?? agent.effort ?? '',
      permissionMode: strategy.permissionMode ?? agent.permissionMode ?? '', pipeline: true, instructions: '', policy: strategy.autoSpawn ? 'start' : 'manual', agentSource: 'pipeline' }];
  }));
  const global = state ? profileDefaults(state, state.settings?.agentProfileId, globalAgent || {}) : globalAgent;
  const projectAgent = state ? profileDefaults(state, project?.agentProfileId, project?.agentDefaults || {}) : project?.agentDefaults;
  const columnAgent = (id, own) => state ? profileDefaults(state, project?.baseColumns?.[id]?.profileId, own) : own;
  return Object.fromEntries(WORKFLOW_STAGES.map(stage => {
    const own = project?.workflow?.[stage] || {};
    const levels = [['stage', columnAgent(stage, own)], ['project', projectAgent], ['global', global]];
    const [agentSource, agent] = levels.find(([, value]) => value?.provider) || ['default', {}];
    // Merge stays manual unless a project turns on automatic merging.
    const base = { ...DEFAULT_STAGE_SETTINGS, ...(stage === 'merge' ? { policy: 'manual' } : {}) };
    const picked = { provider: agent.provider || 'claude', model: agent.model || '', effort: agent.effort || '', permissionMode: own.permissionMode || agent.permissionMode || '' };
    let resolved = picked;
    // An effort the stage's provider does not accept is dropped rather than failing every run.
    try { resolved = resolveConfig(stage, picked); } catch { try { resolved = resolveConfig(stage, { ...picked, effort: '' }); } catch {} }
    const policy = own.policy === 'ask' ? 'start' : own.policy || base.policy;
    return [stage, { ...base, policy, instructions: own.instructions || '', ...resolved, agentSource }];
  }).concat((project?.columnLayout || []).filter(entry => entry.custom).map(entry => {
    // A custom column's agent writes in the task worktree (like Executing) with the column's instructions.
    const [agentSource, agent] = [['stage', columnAgent(entry.id, entry.agent || {})], ['project', projectAgent], ['global', global]].find(([, value]) => value?.provider) || ['default', {}];
    let resolved = { provider: agent.provider || 'claude', model: agent.model || '', effort: agent.effort || '', permissionMode: entry.agent?.permissionMode || agent.permissionMode || '' };
    try { resolved = resolveConfig(entry.id, resolved); } catch { try { resolved = resolveConfig(entry.id, { ...resolved, effort: '' }); } catch {} }
    return [entry.id, { ...DEFAULT_STAGE_SETTINGS, policy: entry.agent?.enabled ? (entry.agent.policy === 'ask' ? 'start' : entry.agent.policy) : 'manual', instructions: entry.agent?.instructions || '', ...resolved, agentSource, custom: true, agentEnabled: entry.agent?.enabled === true }];
  })));
}

/**
 * The only allowed column changes (docs/agentic-kanban-contract.md). The destination alone decides
 * what runs; skipped stages never run. Done is final: a card leaves it only through Reopen.
 * The UI receives this table with the board and offers only these moves.
 */
export const TRANSITIONS = Object.freeze({
  todo: ['planning', 'executing'],
  planning: ['executing', 'todo'],
  executing: ['code_review', 'todo'],
  code_review: ['testing', 'executing'],
  testing: ['merge', 'executing', 'done'],
  merge: ['done', 'executing', 'code_review'],
  done: [],
});
export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}

// ---- Column layout per project ----
// Built-in stages keep their order (the transition contract and its evidence gates depend on it);
// they can be renamed and coloured, and Planning can be hidden. Custom columns go anywhere between
// To Do and Done. Each custom column is attached to the built-in stage on its left (its anchor):
// a card reaches it from that stage and leaves it along that stage's moves. The evidence gates still
// apply to every stage a card enters, so work done in a custom column cannot skip review or tests.
export const COLUMN_COLORS = Object.freeze(['gray', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink']);
const CUSTOM_ID = /^c_[a-z0-9]{6,24}$/;
const CUSTOM_LIMIT = 12;

export function normalizeColumns(input) {
  if (!Array.isArray(input) || input.length > COLUMNS.length + CUSTOM_LIMIT) throw new BoardError(`A board can have at most ${CUSTOM_LIMIT} custom columns.`, 'INVALID_COLUMNS');
  const seen = new Set(), names = new Set(), out = [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || seen.has(entry.id)) throw new BoardError('Each column must appear once.', 'INVALID_COLUMNS');
    seen.add(entry.id);
    const color = entry.color || '';
    if (color && !COLUMN_COLORS.includes(color)) throw new BoardError('Choose a colour from the list.', 'INVALID_COLUMNS');
    const name = entry.title ? text(entry.title, 40, 'A column name') : '';
    const base = COLUMNS.find(column => column.id === entry.id);
    if (base) {
      if (!(entry.hidden === true && entry.id === 'planning')) names.add((name || base.title).toLowerCase());
      out.push({ id: entry.id, ...(name && name !== base.title ? { title: name } : {}), ...(color ? { color } : {}), ...(entry.id === 'planning' && entry.hidden === true ? { hidden: true } : {}) });
      continue;
    }
    if (!CUSTOM_ID.test(entry.id)) throw new BoardError('A custom column has an invalid ID.', 'INVALID_COLUMNS');
    if (!name) throw new BoardError('A custom column needs a name.', 'INVALID_COLUMNS');
    if (names.has(name.toLowerCase())) throw new BoardError(`Two columns are called “${name}”. Use different names.`, 'INVALID_COLUMNS');
    names.add(name.toLowerCase());
    const agent = entry.agent?.enabled === true ? { enabled: true, ...normalizeWorkflow({ executing: {
      ...entry.agent, policy: entry.agent.policy === 'manual' ? 'manual' : 'start',
      instructions: typeof entry.agent.instructions === 'string' ? entry.agent.instructions.slice(0, 4000) : '',
    } }).executing } : { enabled: false };
    out.push({ id: entry.id, custom: true, title: name, color, description: typeof entry.description === 'string' ? entry.description.trim().slice(0, 200) : '', agent });
  }
  if (out.filter(entry => !entry.custom).map(entry => entry.id).join() !== COLUMN_IDS.join()) throw new BoardError('The built-in stages keep their order: To Do, Planning, Executing, Code Review, Testing, Merge, Done.', 'INVALID_COLUMNS');
  if (out[0].id !== 'todo' || out.at(-1).id !== 'done') throw new BoardError('Custom columns go between To Do and Done.', 'INVALID_COLUMNS');
  if (out.filter(entry => entry.custom).length > CUSTOM_LIMIT) throw new BoardError(`A board can have at most ${CUSTOM_LIMIT} custom columns.`, 'INVALID_COLUMNS');
  return out;
}

/** The columns a project shows, in order. A custom column records its anchor stage. */
export function projectColumns(project) {
  if (project?.workflowMode === 'pipeline') return project.pipeline.columns.map(column => ({ ...column, title: column.name,
    agent: column.role === 'active', custom: true, builtin: false, anchor: null }));
  const layout = project?.columnLayout?.length ? project.columnLayout : COLUMN_IDS.map(id => ({ id }));
  let anchor = 'todo';
  const result = [];
  for (const entry of layout) {
    const base = COLUMNS.find(column => column.id === entry.id);
    if (base) {
      if (entry.hidden) continue;
      anchor = entry.id;
      result.push({ ...base, title: entry.title || base.title, color: entry.color || '', builtin: true });
    } else result.push({ id: entry.id, title: entry.title, agent: Boolean(entry.agent?.enabled), custom: true, color: entry.color || '', description: entry.description || '', anchor });
  }
  return result;
}

/** The transition table of one project: TRANSITIONS without hidden stages, plus each custom column's moves. */
export function projectTransitions(project) {
  const columns = projectColumns(project);
  if (project?.workflowMode === 'pipeline') return Object.fromEntries(columns.map(column => [column.id, columns.filter(other => other.id !== column.id).map(other => other.id)]));
  const visible = new Set(columns.map(column => column.id));
  const table = {};
  for (const [from, targets] of Object.entries(TRANSITIONS)) if (visible.has(from)) table[from] = targets.filter(to => visible.has(to));
  const customs = columns.filter(column => column.custom);
  for (const column of customs) {
    table[column.anchor].push(column.id);
    table[column.id] = [column.anchor, ...table[column.anchor].filter(to => !customs.some(other => other.id === to)), ...customs.filter(other => other.anchor === column.anchor && other.id !== column.id).map(other => other.id)];
  }
  return table;
}

const columnTitleIn = (project, id) => projectColumns(project).find(column => column.id === id)?.title || title(id);

function checkRevision(entity, expected, label) {
  if (!Number.isInteger(expected)) throw new BoardError('Include the expected revision.', 'REVISION_REQUIRED');
  if (entity.revision !== expected) throw conflict(`${label} changed since you loaded it. Reload the board and try again.`);
}

const inside = (parent, child) => { const rel = relative(parent, child); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
const slug = value => value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';

export class Board {
  constructor({ dataDir, executor = null, projectsDir = join(dataDir, 'projects'), automationActions = new PipelineActions(), githubIssueReader = listGitHubBacklogIssues }) {
    this.dataDir = dataDir;
    this.projectsDir = projectsDir; // Where "New project" creates each project's own Git repository.
    this.store = new Store(dataDir);
    this.base = new Base({ store: this.store });
    this.worktreeRoot = join(dataDir, 'worktrees');
    this.hooksDir = join(dataDir, 'no-hooks'); // Empty: git worktree add runs no repository hooks.
    this.executor = executor; // PB-02 registers one. Null means execution is inactive.
    this.githubIssueReader = githubIssueReader;
    this.backlogCache = new BacklogCache(dataDir);
    this.locks = new Map();
    this.recoveryPromise = null;
    this.delivery = new Delivery(this);
    this.automationJournal = new PipelineJournal(dataDir);
    this.messageScheduler = null;
    this.automations = new PipelineAutomations({ journal: this.automationJournal, actions: automationActions,
      scheduleEnterMessage: (request, options) => this.#scheduleColumnMessage(request, options) });
    this.automationMoves = new Map();
    this.deferredPipelineStarts = new Map();
    this.automationsStopping = false;
  }

  /** Serialize work per key (task or repository) inside this process. */
  async #locked(key, work) {
    const previous = this.locks.get(key) || Promise.resolve();
    const current = previous.then(work, work);
    const tail = current.catch(() => {});
    this.locks.set(key, tail);
    try { return await current; } finally { if (this.locks.get(key) === tail) this.locks.delete(key); }
  }

  /** First load: any run left active by a previous process becomes interrupted. Never relaunched. */
  async state() {
    this.recoveryPromise ||= (async () => {
      const state = await this.store.read();
      for (const project of state.projects) for (const task of project.tasks) for (const key of [
        ...(task.pendingAutomationMessages || []),
        ...(task.automationMove && !['completed', 'failed', 'cancelled', 'interrupted'].includes(task.automationMove.status)
          && !(task.pendingAutomationMessages || []).some(key => key.transitionId === task.automationMove.transitionId)
          ? [{ projectId: project.id, taskId: task.id, transitionId: task.automationMove.transitionId }] : [])]) {
        // Completed placement can still contain an unfinished asynchronous receipt.
        try {
          await this.automationJournal.recoverInterrupted(key);
          const move = await this.automationJournal.read(key);
          if (!move) throw new BoardError('The recorded automation journal is missing.', 'AUTOMATION_JOURNAL_MISSING');
          await this.#publishAutomationMove(key);
        } catch (error) {
          await this.store.update(draft => {
            const current = this.#task(draft, task.id).task;
            if (current.automationMove?.transitionId === key.transitionId) Object.assign(current.automationMove, {
              status: 'blocked', errorCode: /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code || '') ? error.code : 'AUTOMATION_RECOVERY_FAILED',
              reason: 'The move journal is unavailable. No automation was replayed.' });
          });
        }
      }
      if (state.runs.some(run => ACTIVE_RUN_STATUSES.includes(run.status) || run.planRoutes?.some(route => route.status === 'pending')) || state.sessions.some(session => LIVE_SESSION_STATUSES.has(session.status))) {
        await this.store.update(draft => {
          const now = Date.now();
          for (const run of draft.runs) if (ACTIVE_RUN_STATUSES.includes(run.status)) {
            Object.assign(run, { status: 'interrupted', updatedAt: now, reason: 'The app stopped while this run was active.' });
            synchronizeSession(draft, run);
          }
          for (const run of draft.runs) for (const route of run.planRoutes || []) if (route.status === 'pending') {
            Object.assign(route, { status: 'interrupted', endedAt: now, reason: 'The app stopped during the approved-plan move. It was not replayed.' });
          }
          recoverSessions(draft, now);
        });
      }
    })();
    try { await this.recoveryPromise; }
    catch (error) { this.recoveryPromise = null; throw error; }
    return this.store.read();
  }

  async view() {
    const state = await this.state();
    return { revision: state.revision, columns: COLUMNS, transitions: TRANSITIONS, settings: state.settings, runs: state.runs.slice(-500), sessions: state.sessions.slice(-500),
      baseRevision: state.base?.revision || 0,
      projects: state.projects.map(project => ({ ...project, columns: projectColumns(project), transitions: projectTransitions(project), effectiveWorkflow: effectiveWorkflow(project, state.settings.defaultAgent, state),
        ...(project.workflowMode === 'pipeline' ? { tasks: project.tasks.map(task => ({ ...task, pipelineAgent: effectiveWorkflow(project, state.settings.defaultAgent, state, task)[task.column] })) } : {}) })),
      execution: this.executor?.describe ? await this.executor.describe() : { available: Boolean(this.executor) }, recovery: this.store.recovery };
  }

  /** Base metadata is fetched separately; board polling never includes library document bodies. */
  async baseView() {
    const state = await this.state();
    const library = await this.base.list();
    const execution = this.executor?.describe ? await this.executor.describe() : { available: false, providers: Object.fromEntries(Object.entries(ADAPTERS).map(([id, adapter]) => [id, { name: adapter.name, ...adapter.capabilities, notLiveVerified: Boolean(adapter.notLiveVerified) }])) };
    const targets = listTargets(state).map(item => {
      const target = item.target;
      const project = target.projectId ? this.#project(state, target.projectId) : null;
      const task = target.taskId ? this.#task(state, target.taskId).task : null;
      const columnId = target.columnId || 'executing';
      const settings = effectiveWorkflow(project || {}, state.settings.defaultAgent, state, task)[columnId];
      const column = project && projectColumns(project).find(entry => entry.id === columnId);
      return { ...item, label: item.name, revision: item.baseRevision, provider: settings?.provider || 'claude', columnActive: target.columnId ? column?.agent === true : true };
    });
    const resources = library.resources.map(resource => ({ ...resource, compatibility: Object.fromEntries(Object.keys(execution.providers || {}).map(provider => [provider, {
      execution: deliveryFor(resource, provider, 'executing'), readOnly: deliveryFor(resource, provider, 'planning'), notLiveVerified: Boolean(execution.providers[provider].notLiveVerified),
    }])) }));
    return { ...library, resources, targets, providers: execution.providers || {}, approvedRoots: state.base?.approvedRoots || [], pendingGlobalBaseImport: state.settings.pendingBaseImport || null };
  }

  async previewBase({ target, binding, profileId } = {}) {
    const state = structuredClone(await this.state());
    if (!target || !listTargets(state).some(item => JSON.stringify(item.target) === JSON.stringify(target) ||
      item.target.scope === target.scope && item.target.projectId === target.projectId && item.target.taskId === target.taskId && item.target.columnId === target.columnId)) throw new BoardError('Choose an existing Base assignment target.', 'BASE_TARGET_INVALID');
    const project = target.projectId ? this.#project(state, target.projectId) : null;
    const task = target.taskId ? this.#task(state, target.taskId).task : null;
    let entity = task || project || state.settings;
    if (target.columnId) entity = (entity.baseColumns ??= {})[target.columnId] ??= {};
    if (binding !== undefined) entity[target.columnId ? 'binding' : 'baseBinding'] = normalizeBinding(binding);
    if (profileId !== undefined) {
      if (task) throw new BoardError('Task overrides select resources, not another provider hierarchy.', 'BASE_TARGET_INVALID');
      if (profileId && !state.base.resources.some(resource => resource.id === profileId && resource.kind === 'profile')) throw new BoardError('Choose an existing agent profile.', 'BASE_PROFILE_INVALID');
      entity[target.columnId ? 'profileId' : 'agentProfileId'] = profileId || null;
    }
    const columnId = target.columnId || task?.column || 'executing';
    const settings = effectiveWorkflow(project || {}, state.settings.defaultAgent, state, task)[columnId] || effectiveWorkflow(project || {}, state.settings.defaultAgent, state, task).executing;
    return { provider: settings.provider, manifest: resolveBase({ state, project, task, columnId, provider: settings.provider }) };
  }

  #requestedAgent(settings, config = {}) {
    const requested = Object.fromEntries(Object.entries(config || {}).filter(([key, value]) => ['provider', 'model', 'effort', 'permissionMode', 'instructions'].includes(key) && value !== undefined && value !== null));
    const inherited = requested.provider && requested.provider !== settings.provider ? { policy: settings.policy, instructions: settings.instructions, provider: requested.provider } : settings;
    return { ...inherited, ...requested };
  }

  #basePreflight(state, project, task, columnId, provider) {
    const manifest = resolveBase({ state, project, task, columnId, provider });
    if (manifest.errors.length) throw new BoardError(`Base resources cannot be supplied: ${manifest.errors.map(error => typeof error === 'string' ? error : error.message || error.reason || error.code).join(' ').slice(0, 1800)}`, 'BASE_REQUIRED_UNAVAILABLE', 409);
    return manifest;
  }

  #project(state, id) {
    const project = state.projects.find(item => item.id === id);
    if (!project) throw new BoardError('This project does not exist. Reload the board.', 'NOT_FOUND', 404);
    return project;
  }
  #task(state, id) {
    for (const project of state.projects) {
      const task = project.tasks.find(item => item.id === id);
      if (task) return { project, task };
    }
    throw new BoardError('This task does not exist. Reload the board.', 'NOT_FOUND', 404);
  }
  #activeRun(state, taskId) { return state.runs.find(run => run.taskId === taskId && ACTIVE_RUN_STATUSES.includes(run.status)); }
  #hasWorkspaceOrRun(state, projects = state.projects) {
    return projects.some(project => project.tasks.some(task => task.workspace || this.#activeRun(state, task.id)));
  }
  #nameError(state, name, exceptId) {
    if (state.projects.some(project => project.id !== exceptId && project.name.toLowerCase() === name.toLowerCase())) throw conflict('A project with this name already exists.', 'NAME_TAKEN');
  }

  // ---- Projects ----

  async createProject({ name, workflowMode = 'legacy' }) {
    const clean = text(name, 80, 'Project name');
    if (!['legacy', 'pipeline'].includes(workflowMode)) throw new BoardError('Choose a legacy stage board or a column pipeline.', 'INVALID_INPUT');
    return this.store.update(state => {
      if (state.projects.length >= PROJECT_LIMIT) throw new BoardError(`A board can have at most ${PROJECT_LIMIT} projects.`, 'LIMIT');
      this.#nameError(state, clean);
      const project = newProject({ name: clean });
      if (workflowMode === 'pipeline') Object.assign(project, { workflowMode, pipeline: defaultPipelineConfig() });
      state.projects.push(project);
      return project;
    });
  }

  /**
   * A project that is ready for agents: every project made in the app has a Git repository.
   * `folder: 'new'` creates a folder in the projects folder; an absolute path uses that existing
   * folder. A folder that is not a repository yet gets `git init` and one empty first commit
   * (its files are never added). Then the project is linked to it.
   */
  async createProjectWithRepository({ name, folder, workflowMode = 'legacy' }) {
    const clean = text(name, 80, 'Project name');
    if (!['legacy', 'pipeline'].includes(workflowMode)) throw new BoardError('Choose a legacy stage board or a column pipeline.', 'INVALID_INPUT');
    this.#nameError(await this.state(), clean);
    let path, created = false;
    if (folder === 'new') {
      await mkdir(this.projectsDir, { recursive: true });
      const base = clean.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/^[.\s-]+|[.\s]+$/g, '').slice(0, 80) || 'project';
      for (let n = 1; ; n++) {
        if (n > 100) throw new BoardError('Could not find a free folder name for this project.', 'FOLDER_UNAVAILABLE', 409);
        path = join(await realpath(this.projectsDir), n === 1 ? base : `${base} ${n}`);
        if (!(await access(path).then(() => true, () => false))) break;
      }
      await mkdir(path);
      created = true;
    } else {
      if (typeof folder !== 'string' || !isAbsolute(folder.trim())) throw new BoardError('Choose the absolute path of the project folder.', 'INVALID_PATH');
      path = folder.trim();
      const info = await stat(path).catch(() => null);
      if (!info?.isDirectory()) throw new BoardError(info ? 'This path is a file, not a folder.' : 'This folder does not exist.', info ? 'NOT_A_DIRECTORY' : 'PATH_NOT_FOUND');
    }
    try {
      // An app-created empty folder is its own project, even when the projects
      // container accidentally has a Git repository. Never inherit that parent.
      if (created) await git(['init'], { cwd: path });
      const repository = await validateRepository(path).catch(async error => {
        if (!['NOT_A_REPOSITORY', 'NO_COMMITS'].includes(error.code)) throw error;
        await initRepository(path, { fallbackIdentity: true });
        return null;
      });
      const project = await this.createProject({ name: clean, workflowMode });
      const linked = await this.linkRepository(project.id, { path, expectedRevision: project.revision });
      return { project: linked.project, folder: path, initialized: !repository, createdFolder: created };
    } catch (error) {
      // Remove only a folder this call created, and only while it holds nothing but its new repository.
      if (created && (await readdir(path).catch(() => [])).every(entry => entry === '.git')) await rm(path, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async renameProject(id, { name, expectedRevision }) {
    const clean = text(name, 80, 'Project name');
    return this.store.update(state => {
      const project = this.#project(state, id);
      checkRevision(project, expectedRevision, 'This project');
      this.#nameError(state, clean, id);
      Object.assign(project, { name: clean, revision: project.revision + 1 });
      return project;
    });
  }

  async deleteProject(id, { expectedRevision }) {
    return this.store.update(state => {
      const project = this.#project(state, id);
      checkRevision(project, expectedRevision, 'This project');
      for (const task of project.tasks) this.#requireAutomationsStopped(task);
      if (this.#hasWorkspaceOrRun(state, [project])) throw conflict('Remove the task worktrees in this project first. Promptboard never deletes worktrees with a whole project.', 'WORKSPACES_EXIST');
      state.projects = state.projects.filter(item => item.id !== id);
      state.runs = state.runs.filter(run => run.projectId !== id);
      state.sessions = state.sessions.filter(session => session.projectId !== id);
    });
  }

  /** Validate a repository path without saving it. */
  validateRepository(path) { return validateRepository(path); }

  /** Confirmed: make the folder a repository with an empty first commit, then link it. */
  async initAndLinkRepository(id, { path, confirm, expectedRevision }) {
    if (confirm !== true) throw new BoardError('Confirm the Git setup first.', 'CONFIRMATION_REQUIRED');
    // Check what linking will check before anything changes on disk.
    const project = this.#project(await this.state(), id);
    checkRevision(project, expectedRevision, 'This project');
    if (project.tasks.some(task => task.workspace)) throw conflict('Tasks in this project have worktrees in the current repository. Remove them before you change the link.', 'WORKSPACES_EXIST');
    const setup = await initRepository(path);
    return { ...(await this.linkRepository(id, { path, expectedRevision })), setup };
  }

  async linkRepository(id, { path, expectedRevision }) {
    const repository = path === null ? null : await validateRepository(path);
    const inspectionRoot = repository ? await realpath(path.trim()) : null;
    return this.store.update(state => {
      const project = this.#project(state, id);
      checkRevision(project, expectedRevision, 'This project');
      if (project.tasks.some(task => task.workspace)) throw conflict('Tasks in this project have worktrees in the current repository. Remove them before you change the link.', 'WORKSPACES_EXIST');
      project.repository = repository && { path: path.trim(), inspectionRoot, root: repository.root, commonDir: repository.commonDir, linkedWorktree: repository.linkedWorktree, validatedAt: Date.now() };
      // A different repository makes the recorded target branch meaningless.
      if (!repository || project.targetBranch?.root !== repository.root) project.targetBranch = null;
      // Default to the checked-out branch so agents can start right away; the user can change it.
      const current = !project.targetBranch && repository?.branches.find(item => item.name === repository.currentBranch);
      if (current) project.targetBranch = { name: current.name, commit: current.commit, root: repository.root, recordedAt: Date.now() };
      project.revision++;
      return { project, repository };
    });
  }

  // ---- Timeline ----

  async timeline(id) {
    const state = await this.state();
    const project = this.#project(state, id);
    return buildTimeline(project, state.runs.filter(run => run.projectId === id));
  }

  #note(input, project) {
    const title = text(input?.title, 120, 'The note title');
    const body = typeof input?.text === 'string' ? input.text.trim().slice(0, 2000) : '';
    const at = input?.at === undefined ? Date.now() : input.at;
    if (!Number.isFinite(at) || at < 0 || at > Date.now() + 366 * 86400000) throw new BoardError('Choose a valid date and time for the note.', 'INVALID_INPUT');
    const taskId = input?.taskId || null;
    if (taskId !== null && !project.tasks.some(task => task.id === taskId)) throw new BoardError('The linked task is not in this project.', 'INVALID_INPUT');
    return { title, text: body, at: Math.round(at), taskId };
  }

  /** Notes are the only timeline entries a user writes, edits, or removes. */
  async addTimelineNote(id, input) {
    return this.store.update(state => {
      const project = this.#project(state, id);
      const notes = project.timelineNotes || [];
      if (notes.length >= 500) throw new BoardError('A project can have at most 500 timeline notes.', 'LIMIT');
      const note = { id: randomUUID(), ...this.#note(input, project), createdAt: Date.now() };
      project.timelineNotes = [...notes, note];
      return note;
    });
  }
  async updateTimelineNote(id, noteId, input) {
    return this.store.update(state => {
      const project = this.#project(state, id);
      const note = (project.timelineNotes || []).find(item => item.id === noteId);
      if (!note) throw new BoardError('This note does not exist. Reload the timeline.', 'NOT_FOUND', 404);
      Object.assign(note, this.#note({ ...note, ...input }, project), { updatedAt: Date.now() });
      return note;
    });
  }
  async deleteTimelineNote(id, noteId) {
    return this.store.update(state => {
      const project = this.#project(state, id);
      const before = (project.timelineNotes || []).length;
      project.timelineNotes = (project.timelineNotes || []).filter(item => item.id !== noteId);
      if (project.timelineNotes.length === before) throw new BoardError('This note does not exist. Reload the timeline.', 'NOT_FOUND', 404);
    });
  }

  // ---- GitHub (managed clone) ----

  /**
   * Connect a GitHub repository: clone it once into the data folder, link that clone as this
   * project's repository, and select the target branch. Credentials stay with the GitHub CLI.
   */
  async connectGitHub(id, { repository, branch = '', expectedRevision }) {
    const project = this.#project(await this.state(), id);
    checkRevision(project, expectedRevision, 'This project');
    if (project.tasks.some(task => task.workspace)) throw conflict('Tasks in this project have worktrees in the current repository. Remove them before you change the repository.', 'WORKSPACES_EXIST');
    const repo = await viewRepository(typeof repository === 'string' ? repository.trim() : '');
    const clone = await this.#locked(`clone:${repo.nameWithOwner.toLowerCase()}`, () => ensureClone(this.dataDir, repo));
    const target = branch || repo.defaultBranch;
    const linked = await this.linkRepository(id, { path: clone.path, expectedRevision });
    if (target && linked.project.targetBranch?.name !== target) await this.setTargetBranch(id, { branch: target, expectedRevision: linked.project.revision });
    return this.store.update(state => {
      const current = this.#project(state, id);
      const [owner, name] = repo.nameWithOwner.split('/');
      current.github = { owner, name, nameWithOwner: repo.nameWithOwner, url: repo.url, private: repo.private, defaultBranch: repo.defaultBranch,
        clonePath: clone.path, remote: 'origin', connectedAt: Date.now(), lastFetchAt: null, sync: null };
      current.revision++;
      return current;
    });
  }

  /** Forget the GitHub link. The clone, its repository link, and all local work stay. gh stays signed in. */
  async disconnectGitHub(id, { expectedRevision }) {
    return this.store.update(state => {
      const project = this.#project(state, id);
      checkRevision(project, expectedRevision, 'This project');
      project.github = null;
      project.revision++;
      return project;
    });
  }

  async #github(id) {
    const project = this.#project(await this.state(), id);
    if (!project.github) throw new BoardError('This project is not connected to GitHub.', 'GITHUB_NOT_CONNECTED', 409);
    if (!project.targetBranch) throw new BoardError('Choose the target branch first.', 'TARGET_BRANCH_REQUIRED', 409);
    return project;
  }
  async #recordSync(id, sync, fetched) {
    return this.store.update(state => {
      const project = this.#project(state, id);
      if (project.github) project.github = { ...project.github, sync, ...(fetched ? { lastFetchAt: Date.now() } : {}) };
      return project;
    });
  }

  /** Fetch origin and report whether the target branch is up to date, behind, or ahead. */
  async fetchGitHub(id) {
    const project = await this.#github(id);
    const sync = await this.#locked(`repo:${project.repository.commonDir}`, () => fetchAndCompare(project.repository.root, project.targetBranch.name));
    return this.#recordSync(id, sync, true);
  }

  /** Fast-forward the local target branch to origin's. Never a merge, reset, or force. */
  async updateTargetFromGitHub(id, { confirm }) {
    if (confirm !== true) throw new BoardError('Confirm the update of the target branch first.', 'CONFIRMATION_REQUIRED');
    const project = await this.#github(id);
    const sync = await this.#locked(`repo:${project.repository.commonDir}`, () => fastForward(project.repository.root, project.targetBranch.name));
    const updated = await this.#recordSync(id, sync, false);
    return this.setTargetBranch(id, { branch: project.targetBranch.name, expectedRevision: updated.revision });
  }

  /**
   * Autopilot settings: which To Do cards run, in which order, and which stages each visits.
   * Settings change only while Autopilot is not running.
   */
  async setAutopilot(id, { route, finish = 'merge', maxRework = 2, queue = [], routes = {}, expectedRevision }) {
    const cleanRoute = normalizeRoute(route, finish);
    if (!['merge', 'pull_request'].includes(finish)) throw new BoardError('Choose a local merge or a pull request.', 'INVALID_AUTOPILOT');
    if (!Number.isInteger(maxRework) || maxRework < 0 || maxRework > 3) throw new BoardError('Allow 0 to 3 automatic rework rounds.', 'INVALID_AUTOPILOT');
    if (!Array.isArray(queue) || queue.length > TASK_LIMIT || new Set(queue).size !== queue.length) throw new BoardError('The Autopilot queue must list each card once.', 'INVALID_AUTOPILOT');
    if (!routes || typeof routes !== 'object' || Array.isArray(routes)) throw new BoardError('Send per-card routes as an object.', 'INVALID_AUTOPILOT');
    return this.store.update(state => {
      const project = this.#project(state, id);
      checkRevision(project, expectedRevision, 'This project');
      if (project.autopilot?.status === 'running') throw conflict('Pause or stop Autopilot before you change its settings.', 'AUTOPILOT_RUNNING');
      if (project.workflowMode === 'pipeline') throw conflict('Legacy Autopilot is unavailable for column pipelines.', 'PIPELINE_AUTOPILOT_UNAVAILABLE');
      const ids = new Set(project.tasks.map(task => task.id));
      if (queue.some(taskId => !ids.has(taskId))) throw new BoardError('The Autopilot queue lists a card that is not in this project.', 'INVALID_AUTOPILOT');
      const perCard = {};
      for (const [taskId, value] of Object.entries(routes)) if (queue.includes(taskId) && value) perCard[taskId] = normalizeRoute(value, finish);
      if (!projectColumns(project).some(column => column.id === 'planning') && [cleanRoute, ...Object.values(perCard)].some(item => item.includes('planning'))) throw new BoardError('Planning is hidden on this board. Take it out of the route, or show it in Columns.', 'INVALID_AUTOPILOT');
      const previous = project.autopilot || {};
      project.autopilot = { status: previous.status === 'paused' ? 'paused' : 'off', ...previous, route: cleanRoute, finish, maxRework, queue, routes: perCard, updatedAt: Date.now() };
      project.revision++;
      return project;
    });
  }

  /** Start (confirmed), pause, resume, stop, or skip the current card. The engine does the work. */
  async controlAutopilot(id, { action, confirm }) {
    const project = this.#project(await this.state(), id);
    if (project.workflowMode === 'pipeline') throw conflict('Legacy Autopilot is unavailable for column pipelines.', 'PIPELINE_AUTOPILOT_UNAVAILABLE');
    if (action === 'start') {
      if (confirm !== true) throw new BoardError('Confirm what Autopilot will do before you start it.', 'CONFIRMATION_REQUIRED');
      if (!project.repository || !project.targetBranch) throw new BoardError('Link a repository and choose the target branch first.', 'REPOSITORY_REQUIRED', 409);
      if (!this.executor) throw new BoardError('Agent execution is not available.', 'EXECUTION_UNAVAILABLE', 503);
      if (!project.autopilot?.queue?.length) throw new BoardError('Choose at least one To Do card for the Autopilot queue.', 'AUTOPILOT_EMPTY');
    }
    // Routes saved by an earlier version are checked against the current stage contract before they run.
    if ((action === 'start' || action === 'resume') && project.autopilot) {
      for (const route of [project.autopilot.route, ...Object.values(project.autopilot.routes || {})]) if (route) normalizeRoute(route, project.autopilot.finish);
    }
    return this.store.update(state => {
      const current = this.#project(state, id);
      const ap = current.autopilot;
      if (!ap) throw new BoardError('Save the Autopilot settings first.', 'AUTOPILOT_EMPTY');
      const log = text => { ap.log = [...(ap.log || []), { at: Date.now(), text: clip(text, 500) }].slice(-200); };
      if (action === 'start') Object.assign(ap, { status: 'running', current: null, done: [], reason: '', startedAt: Date.now() }), log('Autopilot started by you.');
      else if (action === 'pause') { if (ap.status !== 'running') throw conflict('Autopilot is not running.', 'AUTOPILOT_NOT_RUNNING'); ap.status = 'paused'; ap.reason = 'Paused by you.'; log('Paused by you.'); }
      else if (action === 'resume') { if (ap.status !== 'paused') throw conflict('Autopilot is not paused.', 'AUTOPILOT_NOT_PAUSED'); ap.status = 'running'; ap.reason = ''; if (ap.current) ap.current.step = 'resume'; log('Resumed by you.'); }
      else if (action === 'skip') {
        if (!ap.current) throw conflict('No card is in progress.', 'AUTOPILOT_IDLE');
        ap.done = [...(ap.done || []), ap.current.taskId]; log('Skipped the current card; it stays where it is.'); ap.current = null;
        if (ap.status === 'paused') { ap.status = 'running'; ap.reason = ''; }
      } else if (action === 'stop') { ap.status = 'off'; ap.current = null; ap.reason = ''; log('Stopped by you. Cards stay where they are.'); }
      else throw new BoardError('Choose start, pause, resume, skip, or stop.', 'INVALID_AUTOPILOT');
      current.revision++;
      return current;
    });
  }

  /** Engine-only change of the Autopilot state (status, current card, log). */
  async updateAutopilot(id, change) {
    return this.store.update(state => {
      const project = this.#project(state, id);
      if (!project.autopilot) return null;
      change(project.autopilot, text => { project.autopilot.log = [...(project.autopilot.log || []), { at: Date.now(), text: clip(text, 500) }].slice(-200); }, project);
      return project.autopilot;
    });
  }

  /** Save the column layout. A column that still holds cards cannot be removed or hidden. */
  async setColumns(id, { columns, expectedRevision }) {
    const layout = normalizeColumns(columns);
    return this.store.update(state => {
      const project = this.#project(state, id);
      if (project.workflowMode === 'pipeline') throw conflict('Use the pipeline column settings for this board.', 'PIPELINE_SETTINGS_REQUIRED');
      checkRevision(project, expectedRevision, 'This project');
      const visible = new Set(projectColumns({ columnLayout: layout }).map(column => column.id));
      const stranded = [...new Set(project.tasks.filter(task => !visible.has(task.column)).map(task => task.column))];
      if (stranded.length) {
        const where = stranded.map(column => `${project.tasks.filter(task => task.column === column).length} in ${columnTitleIn(project, column)}`).join(', ');
        throw conflict(`Move the cards out first (${where}). A column is removed or hidden only when it is empty.`, 'COLUMN_NOT_EMPTY');
      }
      const ap = project.autopilot;
      if (ap && !visible.has('planning') && [ap.route, ...Object.values(ap.routes || {})].some(route => route?.includes('planning'))) throw conflict('Autopilot’s route uses Planning. Take Planning out of the route first.', 'AUTOPILOT_ROUTE');
      project.columnLayout = layout;
      // Stable column IDs survive rename/reorder. Removed IDs cannot retain invisible assignments.
      const present = new Set(layout.map(entry => entry.id));
      let detached = false;
      for (const entity of [project, ...project.tasks]) for (const id of Object.keys(entity.baseColumns || {})) if (!present.has(id)) {
        delete entity.baseColumns[id]; entity.baseRevision = (entity.baseRevision || 0) + 1; detached = true;
      }
      // Imported settings awaiting confirmation cannot resurrect a removed column's references.
      for (const id of Object.keys(project.pendingImport?.baseColumns || {})) if (!present.has(id)) {
        delete project.pendingImport.baseColumns[id]; detached = true;
      }
      if (detached) state.base.revision++;
      project.revision++;
      return project;
    });
  }

  /** Explicit conversion/configuration; saving settings never dispatches agents. */
  setPipeline(id, input = {}) { return this.#setPipeline(id, input); }

  async #setPipeline(id, { pipeline = defaultPipelineConfig(), expectedRevision, confirm = false } = {}, sourceGuard = null) {
    const clean = normalizePipelineConfig(pipeline);
    for (const column of clean.columns) if (column.automations.onExit.some(row => row.enabled && row.type === 'send_message')
      || column.automations.onEnter.some(row => row.enabled && row.type === 'send_message' && row.mode !== 'deferred'))
      throw new BoardError('Agent messages currently support deferred delivery on entry only.', 'PIPELINE_FEATURE_PENDING', 409);
    for (const column of clean.columns) for (const options of [{}, ...clean.profiles.map(profile => ({ profileId: profile.id }))]) {
      const strategy = resolvePipelineStrategy(clean, column.id, options);
      if (strategy.sessionTarget !== 'main' || strategy.sessionSpawnStrategy !== 'create_or_resume' || strategy.handoffContext) throw new BoardError('Isolated sessions, forced fresh sessions, and provider handoff are not available in this checkpoint.', 'PIPELINE_FEATURE_PENDING', 409);
    }
    return this.store.update(async state => {
      const project = this.#project(state, id);
      checkRevision(project, expectedRevision, 'This project');
      let repositoryShared = null;
      if (sourceGuard) {
        if (project.workflowMode !== 'pipeline' || project.repository?.root !== sourceGuard.root) throw conflict('The linked pipeline project changed. Review its configuration again.', 'REPOSITORY_PIPELINE_CHANGED');
        const snapshot = await readRepositoryPipeline(sourceGuard.root);
        if (snapshot.sourceRevision !== sourceGuard.sourceRevision) throw conflict('Repository configuration changed after review. Read and review it again.', 'REPOSITORY_PIPELINE_CHANGED');
        const resolved = resolveRepositoryPipeline(snapshot, project.repositoryPipeline?.shared || project.pipeline);
        if (JSON.stringify(resolved.pipeline) !== JSON.stringify(clean)) throw conflict('The reviewed definition no longer matches this board.', 'REPOSITORY_PIPELINE_CHANGED');
        repositoryShared = resolved.shared;
      }
      if (project.workflowMode !== 'pipeline' && confirm !== true) throw new BoardError('Confirm switching this project from stage rules to a column pipeline.', 'CONFIRMATION_REQUIRED', 409);
      if (project.workflowMode === 'pipeline' && ['todo', 'done'].some(role => project.pipeline.columns.find(column => column.role === role).id !== clean.columns.find(column => column.role === role).id)) throw conflict('Rename the system columns without changing their stable IDs or roles.', 'PIPELINE_SYSTEM_ROLE_CHANGED');
      if (project.tasks.some(task => this.automationMoves.has(task.id) || task.pendingAutomationMessages?.length
        || task.automationMove && !['completed', 'failed', 'cancelled', 'interrupted'].includes(task.automationMove.status))) throw conflict('Stop the project’s active automations before changing its pipeline configuration.', 'AUTOMATIONS_ACTIVE');
      if (project.tasks.some(task => this.#activeRun(state, task.id))) throw conflict('Pause the project’s agents before changing its pipeline configuration.', 'RUN_ACTIVE');
      if (project.autopilot?.status === 'running') throw conflict('Pause Autopilot before switching workflow mode.', 'AUTOPILOT_ACTIVE');
      const present = new Set(clean.columns.map(column => column.id));
      if (project.tasks.some(task => !present.has(task.column))) throw conflict('Move every card out of columns being removed first.', 'COLUMN_NOT_EMPTY');
      const removedProfiles = new Set((project.pipeline?.profiles || []).filter(profile => !clean.profiles.some(item => item.id === profile.id)).map(profile => profile.id));
      for (const task of project.tasks) {
        if (removedProfiles.has(task.profileId)) { task.profileId = null; task.revision++; task.updatedAt = Date.now(); }
        normalizePipelineTaskSelection(clean, { profileId: task.profileId, agentOverride: task.agentOverride });
        resolvePipelineStrategy(clean, task.column, task);
      }
      project.workflowMode = 'pipeline'; project.pipeline = clean;
      for (const column of clean.columns.filter(column => column.role === 'active')) {
        for (const task of [null, ...clean.profiles.map(profile => ({ profileId: profile.id })), ...project.tasks.filter(task => task.agentOverride)]) {
          resolveConfig(column.id, effectiveWorkflow(project, state.settings.defaultAgent, state, task)[column.id]);
        }
      }
      delete project.pipelineImport;
      for (const entity of [project, ...project.tasks]) for (const columnId of Object.keys(entity.baseColumns || {})) if (!present.has(columnId)) {
        delete entity.baseColumns[columnId]; entity.baseRevision = (entity.baseRevision || 0) + 1; state.base.revision++;
      }
      for (const columnId of Object.keys(project.pendingImport?.baseColumns || {})) if (!present.has(columnId)) { delete project.pendingImport.baseColumns[columnId]; state.base.revision++; }
      project.revision++;
      if (sourceGuard) project.repositoryPipeline = { sourceRevision: sourceGuard.sourceRevision, appliedAt: Date.now(), shared: repositoryShared };
      else delete project.repositoryPipeline;
      return project;
    });
  }

  /** A read-only, bounded repository snapshot for explicit review. */
  async previewRepositoryPipeline(id) {
    const project = this.#project(await this.state(), id);
    if (project.workflowMode !== 'pipeline') throw conflict('Switch this project to a column pipeline before reading repository configuration.', 'PIPELINE_SETTINGS_REQUIRED');
    if (!project.repository) throw conflict('Link this project to a repository first.', 'REPOSITORY_REQUIRED');
    const root = project.repository.root, revision = project.revision;
    const repository = await repositoryIdentity(root);
    if (repository.root !== root || repository.commonDir !== project.repository.commonDir) throw conflict('The linked repository changed. Review its link first.', 'REPOSITORY_PIPELINE_ROOT_CHANGED');
    const snapshot = await readRepositoryPipeline(root), result = resolveRepositoryPipeline(snapshot, project.repositoryPipeline?.shared || project.pipeline);
    const current = this.#project(await this.state(), id);
    if (current.revision !== revision || current.repository?.root !== root) throw conflict('The project changed while configuration was read. Review it again.', 'REPOSITORY_PIPELINE_CHANGED');
    const before = project.pipeline, present = new Set(result.pipeline.columns.map(column => column.id));
    const removed = before.columns.filter(column => !present.has(column.id));
    return { sourceRevision: snapshot.sourceRevision, expectedProjectRevision: revision, canonical: result.canonical,
      files: snapshot.files.map(({ name, hash }) => ({ name, present: hash !== null })), pipeline: result.pipeline,
      changes: { added: result.pipeline.columns.filter(column => !before.columns.some(item => item.id === column.id)).map(column => column.name),
        removed: removed.map(column => column.name), renamed: result.pipeline.columns.filter(column => before.columns.some(item => item.id === column.id && item.name !== column.name)).map(column => column.name),
        profiles: result.pipeline.profiles.map(profile => profile.name) },
      conflicts: removed.filter(column => current.tasks.some(task => task.column === column.id)).map(column => `Move tasks out of ${column.name} before applying its removal.`) };
  }

  /** Detect external changes to a previously accepted source without changing state. */
  async repositoryPipelineStatus(id) {
    const project = this.#project(await this.state(), id), applied = project.repositoryPipeline?.sourceRevision;
    if (project.workflowMode !== 'pipeline' || !project.repository || typeof applied !== 'string' || !/^[a-f0-9]{64}$/.test(applied)) return { projectId: id, watching: false };
    const root = project.repository.root, revision = project.revision;
    let snapshot, errorCode = null;
    try {
      snapshot = await readRepositoryPipeline(root);
      resolveRepositoryPipeline(snapshot, project.repositoryPipeline.shared || project.pipeline);
    } catch (error) {
      if (!(error instanceof RepositoryPipelineError) && error.code !== 'INVALID_PIPELINE_CONFIG') throw error;
      errorCode = error.code;
    }
    const current = this.#project(await this.state(), id);
    if (current.revision !== revision || current.repository?.root !== root || current.repositoryPipeline?.sourceRevision !== applied) throw conflict('The project changed while configuration was checked. Check it again.', 'REPOSITORY_PIPELINE_CHANGED');
    return { projectId: id, watching: true, expectedProjectRevision: revision, appliedSourceRevision: applied,
      checkedSourceRevision: snapshot?.sourceRevision || null, changed: snapshot ? snapshot.sourceRevision !== applied : null,
      files: snapshot?.files.map(({ name, hash }) => ({ name, present: hash !== null })) || [], errorCode };
  }

  async applyRepositoryPipeline(id, { sourceRevision, expectedProjectRevision, confirm = false } = {}) {
    if (confirm !== true) throw new BoardError('Review and confirm applying repository configuration.', 'CONFIRMATION_REQUIRED', 409);
    if (typeof sourceRevision !== 'string' || !/^[a-f0-9]{64}$/.test(sourceRevision)) throw new RepositoryPipelineError('Include the exact reviewed configuration revision.');
    const reviewed = await this.previewRepositoryPipeline(id);
    if (reviewed.sourceRevision !== sourceRevision || reviewed.expectedProjectRevision !== expectedProjectRevision) throw conflict('Configuration or project changed after review. Read and review it again.', 'REPOSITORY_PIPELINE_CHANGED');
    const root = this.#project(await this.state(), id).repository.root;
    return this.#setPipeline(id, { pipeline: reviewed.pipeline, expectedRevision: expectedProjectRevision }, { root, sourceRevision });
  }

  async setWorkflow(id, { workflow, agentDefaults, expectedRevision }) {
    const clean = normalizeWorkflow(workflow);
    const defaults = agentDefaults === undefined ? undefined : normalizeAgent(agentDefaults);
    return this.store.update(state => {
      const project = this.#project(state, id);
      checkRevision(project, expectedRevision, 'This project');
      // Custom agent columns use the same validation as Executing and keep their layout.
      const columnLayout = (project.columnLayout || []).map(entry => {
        if (!entry.custom || !entry.agent?.enabled || !workflow[entry.id]) return entry;
        const agent = normalizeWorkflow({ executing: workflow[entry.id] }).executing;
        return { ...entry, agent: { enabled: true, ...agent } };
      });
      if (project.columnLayout) project.columnLayout = columnLayout;
      project.workflow = clean; // Applies to future runs only; active runs keep their snapshot.
      if (defaults !== undefined) project.agentDefaults = defaults;
      project.revision++;
      return project;
    });
  }

  // ---- Stage transitions (docs/agentic-kanban-contract.md) ----

  /**
   * The one move path for drag-and-drop, the stage menu, the task-details buttons, and Autopilot:
   * request → validate → prepare → approve if required → execute → persist. The card enters the
   * new column only when the stage action succeeded (or when no action is due), in the same write
   * that records the run. A refused or failed move leaves the card where it was.
   *
   * The drag is the instruction: there is no approval step. The destination's stage starts when its
   * policy is Start (the default); Manual only moves. `decision: 'move'` (Autopilot, scripts) only moves;
   * `decision: 'start'` starts even under Manual. A finished agent turn in the stage the card leaves is
   * confirmed, and its uncommitted work is committed with `commitMessage` (default: the card title).
   * `transitionId` makes a repeated request idempotent.
   */
  transition(id, request = {}) {
    return this.#locked(`transition:${id}`, () => this.#transition(id, request));
  }

  async #transition(id, { column, index, expectedRevision, expectedProjectRevision = null, transitionId, decision, commitMessage, config = {}, handoffRunId = null, trigger = 'user' } = {}) {
    if (transitionId !== undefined && (typeof transitionId !== 'string' || !TRANSITION_ID.test(transitionId))) throw new BoardError('Send a valid transition ID.', 'INVALID_INPUT');
    if (decision !== undefined && decision !== 'start' && decision !== 'move') throw new BoardError('Choose start or move.', 'INVALID_INPUT');
    if (expectedProjectRevision !== null && (!Number.isSafeInteger(expectedProjectRevision) || expectedProjectRevision < 0)) throw new BoardError('Send a valid board settings revision.', 'INVALID_INPUT');
    const automation = trigger === 'automation';
    const state = await this.state();
    const { project, task } = this.#task(state, id);
    if (project.workflowMode === 'pipeline') {
      if (Object.keys(config || {}).length) throw new BoardError('Configure the pipeline agent in Column Manager before moving this card.', 'PIPELINE_SETTINGS_REQUIRED');
      return this.#locked(`run:${id}`, () => this.#pipelineTransition(id, { column, index, expectedRevision, expectedProjectRevision, transitionId, decision, trigger }));
    }
    if (expectedProjectRevision !== null) throw new BoardError('Board settings revisions apply to column pipelines.', 'PIPELINE_REQUIRED');
    // The same request delivered twice (a double drop, a retried request) returns the first outcome.
    if (transitionId && task.lastTransition?.id === transitionId) {
      return { task, duplicate: true, ...(task.lastTransition.runId ? { run: state.runs.find(run => run.id === task.lastTransition.runId) } : {}) };
    }
    checkRevision(task, expectedRevision, 'This card');
    const table = projectTransitions(project);
    if (!Object.hasOwn(table, column)) throw new BoardError('Choose a valid column.', 'INVALID_COLUMN');
    const from = task.column;
    if (from === column) return { task: await this.#placeStored(id, { from, column, index }) }; // Reorder only.
    const name = value => columnTitleIn(project, value);
    if (!table[from]?.includes(column)) {
      throw new BoardError(from === 'done' ? `“${task.title}” is done. Use Reopen to start a new cycle; its history stays.`
        : `A card cannot move from ${name(from)} to ${name(column)}. Allowed from ${name(from)}: ${(table[from] || []).map(name).join(', ') || 'none'}.`, 'TRANSITION_NOT_ALLOWED');
    }
    if (from === 'todo' && !project.repository) throw new BoardError('Link this project to a Git repository before cards leave To Do.', 'REPOSITORY_REQUIRED');
    if (from === 'todo') this.#checkPrerequisites(project, task);
    const plan = await this.#prepareTransition(state, project, task, column, config);
    const id2 = transitionId || randomUUID();
    // Done only saves a completion record. Merging is a separate, optional Merge-stage action.
    const startAction = Boolean(plan.action) && decision !== 'move' && (decision === 'start' || plan.policy !== 'manual' || plan.action === 'merge-prepare' || column === 'done');
    if (startAction && plan.agentError) throw new BoardError(plan.agentError.message, plan.agentError.code, 409);
    // Required Base failures must precede plan approval or commits. A move-only action stays permitted.
    if (startAction && plan.action === 'agent') {
      // CLI/worktree validation above is asynchronous. Re-read Base and the actual agent
      // before approving the outgoing turn or committing anything on its behalf.
      let fresh = await this.state(), current = this.#task(fresh, id);
      if ((current.task.contentRevision ?? 1) !== (task.contentRevision ?? 1)) throw conflict('The task text changed while this move was prepared. Try the move again.', 'REVISION_CONFLICT');
      if (!projectColumns(current.project).some(item => item.id === column && item.agent)) throw conflict('The destination agent changed while this move was prepared. Try the move again.', 'REVISION_CONFLICT');
      let requested = this.#requestedAgent(effectiveWorkflow(current.project, fresh.settings.defaultAgent, fresh)[column], config);
      if (JSON.stringify(requested) !== JSON.stringify(this.#requestedAgent(plan.settings, config))) {
        await this.executor.validate({ stage: column, config: requested });
        fresh = await this.state(); current = this.#task(fresh, id);
        const latest = this.#requestedAgent(effectiveWorkflow(current.project, fresh.settings.defaultAgent, fresh)[column], config);
        if ((current.task.contentRevision ?? 1) !== (task.contentRevision ?? 1) || JSON.stringify(latest) !== JSON.stringify(requested)) throw conflict('Task or agent settings changed while this move was prepared. Try the move again.', 'REVISION_CONFLICT');
        requested = latest;
      }
      this.#basePreflight(fresh, current.project, current.task, column, requested.provider);
    }

    // Hand off: confirm the finished turn (this approves a plan or records a review), then commit its work.
    if (plan.handoff) await this.executor.confirm(plan.handoff.id);
    if (plan.commit) await this.delivery.commit(id, { message: (typeof commitMessage === 'string' && commitMessage.trim()) || plan.commit.message, confirm: true });
    // Evidence gates run on the state after the hand-off: a review or test for another commit never counts.
    const gate = await this.#evidenceGate(id, column);
    if (gate.problems.length) throw new BoardError(`${title(column)} is not ready: ${gate.problems.join(' ')}`, 'STAGE_NOT_READY', 409);
    if (gate.acceptReview) await this.delivery.acceptReview(id);
    const notes = column === 'executing' ? await this.#reworkNotes(id, from) : null;
    if (notes) await this.updateTaskEvidence(id, current => {
      current.reworkNotes = notes.text.slice(0, 20000);
      if (notes.review && current.evidence?.review) current.evidence.review = { ...current.evidence.review, status: 'changes_requested' };
    });

    const move = { from, column, index, transitionId: id2, by: automation ? 'automation' : 'user' };
    if (column === 'done') {
      const saved = await this.completeTask(id, { kind: 'unmerged', details: { branch: task.workspace?.branch, taskCommit: plan.completionCommit }, transitionId: move.transitionId });
      return { task: saved, merged: false };
    }
    if (startAction && plan.action === 'agent') {
      const run = await this.#locked(`run:${id}`, () => this.#startRun(id, { stage: column, consent: true, config, trigger: automation ? 'automation' : 'user', move }));
      return { task: await this.#taskNow(id), run };
    }
    const placed = await this.#placeStored(id, move);
    const result = { task: placed, ...(plan.notice && decision !== 'move' ? { notice: plan.notice } : {}) };
    if (!startAction) return result;
    if (plan.action === 'merge-prepare') {
      result.merge = await this.#prepareMerge(id, { auto: plan.policy === 'start' });
      if (result.merge.state === 'merged') { result.task = result.merge.task; result.merged = true; }
    }
    return result;
  }

  // ---- Merge preparation and follow-up (the Merge stage) ----

  async #setFlow(id, flow) {
    return this.store.update(state => { const { task } = this.#task(state, id); task.flow = flow ? { ...flow, at: Date.now() } : null; return task; });
  }

  /**
   * Bring the card to a verified merge state: the accepted review and passing tests belong to the task
   * commit, the task branch contains the target, and the target checkout is clean. Then merge when `auto`.
   * - The target moved and merges in cleanly: the merge commit keeps the review (a clean merge adds no
   *   task changes) and the tests run again on it.
   * - It conflicts: the merge agent starts in the task worktree (#advanceFlows commits its result and sends
   *   the card back to Code Review, because resolving conflicts changes code).
   * Returns { state: merged | ready | testing | resolving | blocked, message }.
   */
  async #prepareMerge(id, { auto = false } = {}) {
    const { task } = this.#task(await this.state(), id);
    const rev = await this.delivery.revision(id);
    const review = task.evidence?.review, tests = task.evidence?.tests;
    const blocked = async message => { await this.#setFlow(id, { kind: 'blocked', reason: message }); return { state: 'blocked', message }; };
    if (!rev.clean || rev.merging) return blocked(rev.merging ? 'A merge is in progress in the task worktree. Let the merge agent finish, or abort it in the task details.' : 'The task worktree has uncommitted changes. Send the card back to Executing so they are reviewed and tested.');
    if (review?.status !== 'accepted' || review.taskCommit !== rev.taskCommit || review.verdict !== 'no_issues' || review.findings?.length) return blocked('An accepted code review without issues for the current commit is required. Send the card back to Code Review.');
    if (tests?.status === 'running') return { state: 'testing', message: 'Tests are running.' };
    if (tests?.status !== 'passed' || tests.taskCommit !== rev.taskCommit) return blocked('Passing tests for the current commit are required. Send the card back to Testing.');
    let preview = await this.delivery.mergePreview(id);
    if (!preview.fastForward) {
      try { await this.delivery.updateBranch(id, { confirm: true }); }
      catch (error) {
        if (error.code !== 'MERGE_CONFLICT') return blocked(error.message);
        if (!this.executor) return blocked(`${preview.targetBranch} conflicts with the task, and no merge agent can run here. Resolve the conflicts in the task worktree.`);
        const run = await this.#locked(`run:${id}`, () => this.#startRun(id, { stage: 'merge', consent: true, trigger: 'automation' }));
        await this.#setFlow(id, { kind: 'merge-resolve', runId: run.id, auto });
        return { state: 'resolving', message: `${preview.targetBranch} conflicts with the task. The merge agent is resolving the conflicts.`, run };
      }
      // A clean merge of the target adds no task changes: the review carries over to the merge commit.
      const merged = await this.delivery.revision(id);
      await this.updateTaskEvidence(id, current => { current.evidence.review = { ...current.evidence.review, taskCommit: merged.taskCommit, carriedFrom: rev.taskCommit, carriedReason: `clean merge of ${preview.targetBranch}` }; });
    }
    preview = await this.delivery.mergePreview(id);
    const current = this.#task(await this.state(), id).task.evidence?.tests;
    if (current?.taskCommit !== preview.taskCommit || current?.targetCommit !== preview.targetCommit) {
      const started = await this.delivery.runTests(id, { confirm: true }).catch(error => ({ error }));
      if (started.error) return blocked(started.error.message);
      await this.#setFlow(id, { kind: 'merge-tests', testsId: started.id, auto });
      return { state: 'testing', message: `The task branch now contains the current ${preview.targetBranch}. The tests are running again on it.` };
    }
    if (!preview.eligible) return blocked(preview.problems.join(' '));
    if (!auto) { await this.#setFlow(id, { kind: 'ready', targetBranch: preview.targetBranch }); return { state: 'ready', message: `Ready to merge into ${preview.targetBranch}.` }; }
    const done = await this.delivery.merge(id, { confirm: true, taskCommit: preview.taskCommit, targetCommit: preview.targetCommit, trigger: 'automation' });
    return { state: 'merged', message: `Merged into ${preview.targetBranch}.`, task: done };
  }

  /** The Merge button: one click merges a verified card (preparing it first when the target moved). */
  mergeNow(id) {
    return this.#locked(`transition:${id}`, async () => {
      const { task } = this.#task(await this.state(), id);
      if (task.column !== 'merge') throw conflict('Move the card to Merge first.', 'STAGE_MISMATCH');
      if (this.#activeRun(await this.state(), id)) throw conflict('An agent is still working on this card.', 'RUN_ACTIVE');
      const preview = await this.delivery.mergePreview(id);
      if (preview.eligible) return { task: await this.delivery.merge(id, { confirm: true, taskCommit: preview.taskCommit, targetCommit: preview.targetCommit, trigger: 'user' }), merged: true };
      const merge = await this.#prepareMerge(id, { auto: true });
      if (merge.state === 'blocked') throw conflict(merge.message, 'MERGE_NOT_READY');
      return { task: merge.task || await this.#taskNow(id), merged: merge.state === 'merged', merge };
    });
  }

  /**
   * Follow-up work the board does by itself (called every second): tests that finished during a merge
   * preparation, a merge agent that finished resolving, the optional testing agent, and open pull
   * requests (checked once a minute). Each card is handled under its transition lock.
   */
  async advanceFlows() {
    const state = await this.state();
    for (const project of state.projects) {
      const autopilotCard = project.autopilot?.status === 'running' ? project.autopilot.current?.taskId : null;
      for (const task of project.tasks) {
        if (task.id === autopilotCard) continue; // Autopilot drives its own card.
        const flow = task.flow;
        const pr = task.evidence?.pullRequest;
        const polling = task.column === 'merge' && pr?.url && pr.state === 'OPEN' && Date.now() - (this.prChecks?.get(task.id) || 0) > 60000;
        if (!['merge-tests', 'merge-resolve', 'testing-agent'].includes(flow?.kind) && !polling) continue;
        await this.#locked(`transition:${task.id}`, () => this.#advanceFlow(task.id, polling)).catch(error => this.#setFlow(task.id, { kind: 'blocked', reason: error.message }).catch(() => {}));
      }
    }
  }

  async #advanceFlow(id, polling) {
    const state = await this.state();
    const { task } = this.#task(state, id);
    if (polling) { (this.prChecks ??= new Map()).set(id, Date.now()); await this.delivery.pullRequestStatus(id).catch(() => {}); }
    const flow = task.flow, tests = task.evidence?.tests;
    if (flow?.kind === 'merge-tests' || flow?.kind === 'testing-agent') {
      if (tests?.id !== flow.testsId) return this.#setFlow(id, null);
      if (tests.status === 'running') { if (!this.delivery.testsRunning.has(id)) await this.#setFlow(id, { kind: 'blocked', reason: 'The test run stopped (the app restarted). Move the card again to run them.' }); return; }
      if (flow.kind === 'testing-agent') {
        await this.#setFlow(id, null);
        if (tests.status === 'passed' || task.column !== 'testing' || !this.executor) return;
        const output = (tests.results || []).filter(result => result.status !== 'passed').map(result => `$ ${result.argv.join(' ')}\n${result.reason || `exit ${result.exitCode}`}\n${(result.tail || '').slice(-4000)}`).join('\n\n');
        return this.#locked(`run:${id}`, () => this.#startRun(id, { stage: 'testing', consent: true, trigger: 'automation', note: `=== FAILED TESTS TO FIX ===\n${output}\n=== END FAILED TESTS ===` }));
      }
      if (tests.status !== 'passed') return this.#setFlow(id, { kind: 'blocked', reason: `The tests failed on the task branch with the current target. Send the card back to Executing; the failing output goes with it.` });
      return this.#prepareMerge(id, { auto: flow.auto });
    }
    if (flow?.kind === 'merge-resolve') {
      const run = state.runs.find(item => item.id === flow.runId);
      if (!run || ['failed', 'cancelled', 'interrupted', 'suspended'].includes(run.status)) return this.#setFlow(id, { kind: 'blocked', reason: `The merge agent ${run?.status || 'stopped'}${run?.reason ? `: ${run.reason}` : ''}. Resolve the conflicts in the task worktree, or send the card back to Executing.` });
      if (run.status === 'waiting_for_input' && run.turnComplete && run.turns > 0) await this.executor.confirm(run.id);
      else if (run.status !== 'succeeded') return;
      const rev = await this.delivery.revision(id);
      if (rev.unresolved.length) return this.#setFlow(id, { kind: 'blocked', reason: `Conflict markers remain in ${rev.unresolved.slice(0, 10).join(', ')}. Resolve them in the task worktree, or send the card back to Executing.` });
      if (rev.merging || !rev.clean) await this.delivery.commit(id, { message: `Merge ${rev.targetBranch} into ${rev.branch}`, confirm: true });
      await this.#setFlow(id, null);
      // Resolving conflicts changed code: it is reviewed again (the review starts on entry).
      const fresh = this.#task(await this.state(), id).task;
      return this.#transition(id, { column: 'code_review', expectedRevision: fresh.revision, decision: 'start', trigger: 'automation' });
    }
  }

  /** A move that never starts a stage action, with every check of transition() (for scripts and tests). */
  async moveTask(id, { column, index, expectedRevision }) {
    return (await this.transition(id, { column, index, expectedRevision, decision: 'move' })).task;
  }

  async #taskNow(id) { return this.#task(await this.state(), id).task; }

  /** What the move needs, checked without changing anything. Throws when the move cannot happen. */
  async #prepareTransition(state, project, task, to, requestedConfig = {}) {
    const from = task.column;
    const active = this.#activeRun(state, task.id);
    let handoff = null;
    if (active) {
      // A finished turn of the stage the card leaves is handed off (confirmed) as part of the move.
      const finished = active.stage === from && active.status === 'waiting_for_input' && active.turnComplete && active.turns > 0;
      if (!finished || to === 'todo') throw conflict('This card has an active run. Wait for it to finish or cancel it first.', 'RUN_ACTIVE');
      handoff = active;
    }
    const settings = effectiveWorkflow(project, state.settings.defaultAgent, state)[to] || null;
    const plan = { from, to, handoff, commit: null, notes: null, action: null, policy: settings?.policy || 'manual', settings };
    const hasWorkspace = task.workspace?.status === 'ready';
    if (hasWorkspace && to !== 'done') await this.ensureTaskWorktree(task.id); // Done never repairs or starts task work.
    const rev = hasWorkspace ? await this.delivery.revision(task.id) : null;
    const needWorkspace = () => { if (!rev) throw new BoardError(`${title(to)} needs the task worktree. Run Planning or Executing first.`, 'WORKSPACE_REQUIRED', 409); };
    if (to === 'code_review') {
      needWorkspace();
      if (rev.unresolved.length) throw conflict(`These files still contain conflict markers: ${rev.unresolved.slice(0, 10).join(', ')}. Resolve them first.`, 'CONFLICT_MARKERS');
      if (!rev.clean || rev.merging) plan.commit = { changes: rev.changes, message: rev.merging ? `Merge ${rev.targetBranch} into ${task.workspace.branch}` : task.title };
      else if (!rev.ahead) throw conflict('The task branch has no changes to review. If nothing needs to change, use “Reviewed: no changes required” in the task details.', 'NO_CHANGES');
    }
    if (to === 'testing' || to === 'merge') {
      needWorkspace();
      if (rev.merging) throw conflict('A merge is in progress in the task worktree. Commit or abort it first.', 'MERGE_IN_PROGRESS');
      // A finished turn is confirmed first; the evidence is checked again after that (#evidenceGate).
      if (!handoff) { const gate = await this.#evidenceGate(task.id, to); if (gate.problems.length) throw new BoardError(`${title(to)} is not ready: ${gate.problems.join(' ')}`, 'STAGE_NOT_READY', 409); }
    }
    // Findings, failing test output, or merge conflicts travel with a card sent back to Executing.
    // They are read after the hand-off (#reworkNotes): a confirmed review turn records its findings first.
    if (to === 'executing') {
      const review = task.evidence?.review, tests = task.evidence?.tests;
      plan.notesKind = from === 'code_review' && (handoff?.stage === 'code_review' || (review?.status === 'completed' && review.verdict !== 'no_issues')) ? 'review'
        : from === 'testing' && tests && ['failed', 'invalid'].includes(tests.status) ? 'tests' : from === 'merge' && rev?.merging ? 'merge' : null;
    }
    if (to === 'done') {
      needWorkspace();
      plan.completionCommit = rev.taskCommit;
      return plan;
    }
    // The stage's action. Whether it runs is decided in #transition: the policy (Manual only moves), or an explicit decision.
    if (['planning', 'executing', 'code_review', 'testing'].includes(to) || settings?.agentEnabled) plan.action = 'agent';
    else if (to === 'merge') plan.action = 'merge-prepare';
    if (plan.action === 'agent') {
      // No agent runtime at all (terminal support missing): the card moves and the reason is shown.
      if (!this.executor) { plan.action = null; plan.notice = 'Agent terminals are not set up, so no agent started. Run npm install, then restart Promptboard.'; }
      else {
        // An agent that cannot start (not installed, not signed in) is a real blocker for starting; a plain move still works.
        try { plan.config = await this.executor.validate({ stage: to, config: this.#requestedAgent(settings, requestedConfig) }); }
        catch (error) { plan.agentError = { message: `${title(to)} cannot start: ${error.message}`, code: error.code || 'AGENT_UNAVAILABLE' }; }
      }
      if (plan.action && to === 'executing') plan.approvedPlan = Boolean(this.#approvedPlan(state, task));
    }
    return plan;
  }

  /** What the next Executing run must fix, from the stage the card leaves. Null when there is nothing. */
  async #reworkNotes(taskId, from) {
    const { task } = this.#task(await this.state(), taskId);
    const review = task.evidence?.review, tests = task.evidence?.tests;
    if (from === 'code_review' && review?.status === 'completed' && review.verdict !== 'no_issues') {
      return { review: true, text: review.findings?.length ? review.findings.map(item => `- [${item.severity}] ${item.file}${item.line ? `:${item.line}` : ''} ${item.explanation}`).join('\n') : review.text || '' };
    }
    if (from === 'testing' && tests && ['failed', 'invalid'].includes(tests.status)) {
      const output = (tests.results || []).filter(result => result.status !== 'passed').map(result => `$ ${result.argv.join(' ')}\n${result.reason || `exit ${result.exitCode}`}\n${(result.tail || '').slice(-4000)}`).join('\n\n');
      return { text: `The project's tests failed. Fix the cause (not the tests, unless they are wrong):\n${output || tests.note || tests.status}` };
    }
    if (from === 'merge') {
      const rev = await this.delivery.revision(taskId);
      if (rev.merging) return { text: `A merge of ${rev.targetBranch} into the task branch is in progress. Resolve the conflicts in: ${rev.conflicts.join(', ') || '(no files listed)'}. Keep both the task's intent and the target branch's changes, and remove every conflict marker.` };
    }
    return null;
  }

  /** Review and test evidence must belong to the task commit that moves on (reviewed = tested = HEAD). */
  async #evidenceGate(taskId, to) {
    const problems = [];
    let acceptReview = false;
    if (!['testing', 'merge', 'done'].includes(to)) return { problems, acceptReview };
    const { task } = this.#task(await this.state(), taskId);
    const rev = await this.delivery.revision(taskId);
    const review = task.evidence?.review, tests = task.evidence?.tests;
    if (!rev.clean) problems.push(to === 'merge' ? 'The task worktree has uncommitted changes (for example from the testing agent). Send the card back to Executing so they are committed, reviewed, and tested.' : 'The task worktree has uncommitted changes. Send the card back to Executing.');
    const reviewed = review && review.taskCommit === rev.taskCommit;
    if (!rev.branchOk || rev.merging || rev.unresolved.length) problems.push('The task branch is incorrect or a merge is unresolved. Resolve it before advancing.');
    if (!reviewed) problems.push(review ? 'The code review is for an older commit. Run Code Review again.' : 'Run Code Review for the current commit first.');
    else if (review.status === 'completed' && review.verdict === 'no_issues' && to === 'testing') acceptReview = true;
    else if (review.status !== 'accepted') problems.push(review.status === 'changes_requested' || review.verdict === 'changes_required' ? 'The review asked for changes. Send the card back to Executing, or accept the review in the task details.' : 'Accept the review in the task details first.');
    if (to === 'merge' && (review?.verdict !== 'no_issues' || review?.findings?.length)) problems.push('The review detected issues. Resolve them and run Code Review again before merging.');
    if (to === 'merge' || to === 'done') {
      if (tests?.status === 'running') problems.push('Tests are still running.');
      else if (tests?.status !== 'passed' || tests.taskCommit !== rev.taskCommit) problems.push(tests?.status === 'passed' ? 'The passing tests are for an older commit. Run the tests again.' : 'Passing tests for the current commit are required.');
    }
    return { problems, acceptReview };
  }

  /**
   * Start over: retire the current attempt and run the same task again from a fresh branch.
   * The old branch is kept exactly as it is (never deleted, renamed, reset, or pushed); uncommitted
   * work is committed to it first. The clean worktree is removed, the attempt (branch, head, review,
   * tests, pull request, reason) is recorded in `previousAttempts`, and the card returns to To Do.
   * The next Planning or Executing run creates a new branch from the target branch's current tip and
   * gets the reason. With `startExecuting`, the normal To Do → Executing transition follows.
   */
  startOver(id, { expectedRevision, reason = '', startExecuting = false } = {}) {
    if (typeof reason !== 'string' || reason.length > 4000) throw new BoardError('The reason can have at most 4,000 characters.', 'INVALID_INPUT');
    return this.#locked(`transition:${id}`, async () => {
      const state = await this.state();
      const { project, task } = this.#task(state, id);
      if (project.workflowMode === 'pipeline') throw conflict('Pipeline worktree reset is not available yet. Move the task to To Do to stop its agent and retain files.', 'PIPELINE_FEATURE_PENDING');
      checkRevision(task, expectedRevision, 'This card');
      if (task.column === 'done') throw conflict('This card is done. Reopen it first; then you can start over.', 'NOT_ALLOWED_IN_DONE');
      if (task.workspace?.status !== 'ready') throw conflict('This card has no task branch yet, so there is nothing to start over.', 'NOTHING_TO_START_OVER');
      if (this.#activeRun(state, id)) throw conflict('An agent is still working on this card. Stop it first.', 'RUN_ACTIVE');
      if (this.delivery.testsRunning.has(id)) throw conflict('Tests are running for this card. Wait for them to finish.', 'TESTS_RUNNING');
      if (project.autopilot?.status === 'running' && project.autopilot.current?.taskId === id) throw conflict('Autopilot is working on this card. Pause Autopilot or skip the card first.', 'AUTOPILOT_ACTIVE');
      const workspace = await this.ensureTaskWorktree(id); // Verifies the worktree (and rebuilds a deleted folder).
      let rev = await this.delivery.revision(id);
      if (rev.merging) throw conflict('A merge is in progress in the task worktree. Abort it in the task details first.', 'MERGE_IN_PROGRESS');
      if (!rev.branchOk) throw conflict(`The task worktree is not on its branch ${workspace.branch}. Switch it back first.`, 'BRANCH_MISMATCH');
      // Keep uncommitted work on the old branch (never discarded).
      let savedChanges = 0;
      if (!rev.clean) {
        savedChanges = rev.changes.length;
        rev = await this.delivery.commit(id, { message: 'Start over: keep uncommitted work', confirm: true });
      }
      const before = this.#task(await this.state(), id).task;
      const attempt = { branch: workspace.branch, head: rev.taskCommit, baseCommit: workspace.baseCommit, targetBranch: workspace.targetBranch, archivedAt: Date.now(),
        reason: reason.trim(), fromColumn: before.column, savedChanges, commitsAhead: rev.ahead,
        review: before.evidence?.review ? { status: before.evidence.review.status, verdict: before.evidence.review.verdict || '', taskCommit: before.evidence.review.taskCommit, findings: (before.evidence.review.findings || []).slice(0, 20) } : null,
        tests: before.evidence?.tests ? { status: before.evidence.tests.status, taskCommit: before.evidence.tests.taskCommit } : null,
        pullRequest: before.evidence?.pullRequest ? { url: before.evidence.pullRequest.url, number: before.evidence.pullRequest.number ?? null, state: before.evidence.pullRequest.state } : null };
      // The worktree is clean now; removing it keeps the branch (removeTaskWorktree never removes dirty ones).
      await this.removeTaskWorktree(id);
      // The next attempt branches from the target branch as it is now.
      const fresh = this.#project(await this.state(), project.id);
      if (fresh.targetBranch) await this.setTargetBranch(project.id, { branch: fresh.targetBranch.name, expectedRevision: fresh.revision }).catch(() => {});
      const findings = attempt.review?.findings?.length ? attempt.review.findings.map(item => `- [${item.severity}] ${item.file}${item.line ? `:${item.line}` : ''} ${item.explanation}`).join('\n') : '';
      const task2 = await this.store.update(draft => {
        const { project: owner, task: current } = this.#task(draft, id);
        current.previousAttempts = [...(current.previousAttempts || []), attempt].slice(-10);
        current.restartNote = [attempt.reason && `Reason: ${attempt.reason}`, findings && `Review findings on the discarded attempt:\n${findings}`,
          `The discarded attempt is kept on branch ${attempt.branch} (${attempt.head.slice(0, 12)}). Start again from the current target branch; do not copy that attempt unless the reason says so.`].filter(Boolean).join('\n\n');
        Object.assign(current, { evidence: {}, stageResults: {}, flow: null, reworkNotes: '', lastTransition: null });
        if (current.column !== 'todo') {
          current.transitions = [...current.transitions, { at: Date.now(), from: current.column, to: 'todo', by: 'start-over', ...(attempt.reason ? { reason: clip(attempt.reason, 300) } : {}) }].slice(-TRANSITION_LOG_LIMIT);
          current.column = 'todo';
          owner.tasks = [...owner.tasks.filter(item => item !== current)];
          const firstLater = owner.tasks.findIndex(item => item.column !== 'todo');
          owner.tasks.splice(firstLater < 0 ? owner.tasks.length : firstLater, 0, current); // Last card of To Do.
        }
        current.revision++;
        return current;
      });
      const result = { task: task2, attempt };
      if (startExecuting) {
        const started = await this.#transition(id, { column: 'executing', expectedRevision: task2.revision, decision: 'start' });
        Object.assign(result, { task: started.task, run: started.run });
      }
      return result;
    });
  }

  /** Done → To Do: a new cycle. Earlier completions, commits, evidence, and runs are kept. */
  async reopenTask(id, { expectedRevision } = {}) {
    const current = this.#task(await this.state(), id);
    if (current.project.workflowMode === 'pipeline') {
      if (current.project.pipeline.columns.find(column => column.id === current.task.column)?.role !== 'done') throw conflict('Only an archived task can be restored.', 'NOT_DONE');
      return (await this.transition(id, { column: current.project.pipeline.columns.find(column => column.role === 'todo').id, expectedRevision })).task;
    }
    return this.store.update(state => {
      const { task } = this.#task(state, id);
      checkRevision(task, expectedRevision, 'This card');
      if (task.column !== 'done') throw conflict('Only a card in Done can be reopened.', 'NOT_DONE');
      if (task.completion) task.previousCompletions = [...(task.previousCompletions || []), task.completion].slice(-10);
      task.completion = null;
      task.transitions = [...task.transitions, { at: Date.now(), from: 'done', to: 'todo', by: 'reopen' }].slice(-TRANSITION_LOG_LIMIT);
      task.column = 'todo';
      task.revision++;
      return task;
    });
  }

  /** A run that a move started failed before its session began: the card returns to where it was. */
  async runFailedToStart(runId) {
    return this.store.update(state => {
      const run = state.runs.find(item => item.id === runId);
      if (!run?.transition) return null;
      const { task } = this.#task(state, run.taskId);
      if (task.column !== run.stage || task.lastTransition?.id !== run.transition.id) return null;
      task.transitions = [...task.transitions, { at: Date.now(), from: run.stage, to: run.transition.from, by: 'system', reason: clip(`The ${title(run.stage)} agent could not start: ${run.reason || run.errorCode || 'unknown error'}`, 300) }].slice(-TRANSITION_LOG_LIMIT);
      task.column = run.transition.from;
      task.lastTransition = { ...task.lastTransition, reverted: true };
      task.revision++;
      return task;
    });
  }

  /** Change a task's evidence or notes in one serialized write. */
  async updateTaskEvidence(taskId, change) {
    return this.store.update(async state => {
      const { task } = this.#task(state, taskId);
      await change(task);
      task.revision++;
      return task;
    });
  }

  async setTestCommands(id, { commands, expectedRevision }) {
    return this.store.update(state => {
      const project = this.#project(state, id);
      checkRevision(project, expectedRevision, 'This project');
      project.testCommands = commands;
      project.revision++;
      return project;
    });
  }

  /** Save completion, optionally without merging; this method never starts task work. */
  async completeTask(id, { kind, details, transitionId }) {
    return this.store.update(state => {
      const { project, task } = this.#task(state, id);
      this.#requireAutomationsStopped(task);
      if (this.#activeRun(state, id)) throw conflict('This card has an active run.', 'RUN_ACTIVE');
      const done = project.workflowMode === 'pipeline' ? project.pipeline.columns.find(column => column.role === 'done').id : 'done';
      task.completion = { kind, at: Date.now(), summary: task.stageResults?.executing?.summary || '', executionRunId: task.stageResults?.executing?.runId || null, ...details };
      task.flow = null;
      if (transitionId) task.lastTransition = { id: transitionId, to: done, at: Date.now() };
      task.transitions = [...task.transitions, { at: Date.now(), from: task.column, to: done, by: kind }].slice(-TRANSITION_LOG_LIMIT);
      task.column = done;
      if (project.workflowMode === 'pipeline') task.archivedAt = Date.now();
      project.tasks = [...project.tasks.filter(item => item !== task), task];
      task.revision++;
      return task;
    });
  }

  /** Save same-task stage output. Testing agents do not self-certify: configured commands decide. */
  async recordStageResult(run, summary) {
    const recorded = await this.run(run.id);
    if (recorded.taskId !== run.taskId || recorded.status !== 'succeeded' || !['executing', 'testing'].includes(recorded.stage)) throw conflict('Confirm the task’s finished stage before saving its results.', 'STAGE_NOT_CONFIRMED');
    run = recorded;
    await this.updateTaskEvidence(run.taskId, task => {
      task.stageResults = { ...(task.stageResults || {}), [run.stage]: { runId: run.id, promptRevision: run.promptRevision, summary: String(summary || '').slice(0, 20000), at: Date.now() } };
    });
    if (run.stage !== 'testing') return;
    const { project } = this.#task(await this.state(), run.taskId);
    if (!(project.testCommands || []).length) {
      await this.#setFlow(run.taskId, { kind: 'blocked', reason: 'Testing agent finished. Configure test commands to verify exit codes before merging or completing.' });
      return;
    }
    try { await this.delivery.runTests(run.taskId, { confirm: true }); }
    catch (error) { await this.#setFlow(run.taskId, { kind: 'blocked', reason: error.message }); }
  }

  /** Re-read the linked repository's local branches. */
  async listProjectBranches(id) {
    const project = this.#project(await this.state(), id);
    if (!project.repository) throw new BoardError('Link a Git repository first.', 'REPOSITORY_REQUIRED');
    return validateRepository(project.repository.root);
  }

  /** A linked project without a target branch (linked before the default existed) uses the checked-out branch. */
  async #defaultTargetBranch(taskId) {
    const { project } = this.#task(await this.state(), taskId);
    if (!project.repository || project.targetBranch) return;
    const { currentBranch } = await validateRepository(project.repository.root).catch(() => ({}));
    if (currentBranch) await this.setTargetBranch(project.id, { branch: currentBranch, expectedRevision: project.revision }).catch(() => {});
  }

  /** Select the local target branch and record its current commit. Any branch name is allowed. */
  async setTargetBranch(id, { branch, expectedRevision }) {
    const state = await this.state();
    const project = this.#project(state, id);
    if (!project.repository) throw new BoardError('Link a Git repository first.', 'REPOSITORY_REQUIRED');
    const repository = await validateRepository(project.repository.root);
    const found = repository.branches.find(item => item.name === branch);
    if (!found) throw new BoardError('This local branch does not exist. Refresh the branch list.', 'BRANCH_NOT_FOUND');
    return this.store.update(draft => {
      const current = this.#project(draft, id);
      checkRevision(current, expectedRevision, 'This project');
      current.targetBranch = { name: found.name, commit: found.commit, root: repository.root, recordedAt: Date.now() };
      current.revision++;
      return current;
    });
  }

  /** Apply settings that came from an import only after the user confirms them. */
  async confirmImport(id, { accept, expectedRevision }) {
    const state = await this.state();
    const pending = this.#project(state, id).pendingImport;
    if (!pending) throw new BoardError('There are no imported settings to confirm.', 'NOTHING_PENDING');
    const repository = accept && pending.repositoryPath ? await validateRepository(pending.repositoryPath) : null;
    return this.store.update(draft => {
      const project = this.#project(draft, id);
      checkRevision(project, expectedRevision, 'This project');
      if (JSON.stringify(project.pendingImport) !== JSON.stringify(pending)) throw conflict('The imported settings changed. Reload before confirming.', 'REVISION_CONFLICT');
      if (accept) {
        const hasBase = pending.baseBinding || pending.baseColumns || pending.agentProfileId;
        if (hasBase && ((project.baseRevision || 0) !== (pending.baseTargetRevision || 0) || Object.values(project.baseColumns || {}).some(entry => entry.baseRevision))) throw conflict('Base settings were configured after import. Discard the imported selection to keep them.', 'BASE_TARGET_REVISION_CONFLICT');
        if (repository) {
          project.repository = { path: pending.repositoryPath, root: repository.root, commonDir: repository.commonDir, linkedWorktree: repository.linkedWorktree, validatedAt: Date.now() };
          const branch = repository.branches.find(item => item.name === pending.targetBranch);
          project.targetBranch = branch ? { name: branch.name, commit: branch.commit, root: repository.root, recordedAt: Date.now() } : null;
        }
        if (pending.workflow) project.workflow = normalizeWorkflow(pending.workflow);
        if (pending.agentDefaults) project.agentDefaults = normalizeAgent(pending.agentDefaults);
        if (pending.baseBinding) project.baseBinding = pending.baseBinding;
        if (pending.baseColumns) project.baseColumns = pending.baseColumns;
        if (pending.agentProfileId) project.agentProfileId = pending.agentProfileId;
        if (pending.baseBinding || pending.baseColumns || pending.agentProfileId) {
          project.baseRevision = (project.baseRevision || 0) + 1;
          draft.base.revision++;
        }
        if (pending.testCommands) project.testCommands = pending.testCommands.filter(item => Array.isArray(item?.argv) && item.argv.length && item.argv.every(arg => typeof arg === 'string' && arg.length <= 1000 && !arg.includes('\0'))).slice(0, 20).map(item => ({ label: String(item.label || item.argv.join(' ')).slice(0, 80), argv: item.argv.slice(0, 50), timeoutSec: Number.isInteger(item.timeoutSec) && item.timeoutSec >= 1 && item.timeoutSec <= 3600 ? item.timeoutSec : 600 }));
      }
      project.pendingImport = null;
      project.revision++;
      return project;
    });
  }

  // ---- Tasks ----

  /** Label metadata has its own revision and never invalidates agent configuration. */
  async setLabels(projectId, { labels, expectedLabelRevision }) {
    if (!Array.isArray(labels)) taskLabels(null);
    const clean = taskLabels(labels); labelRevision(expectedLabelRevision);
    return this.store.update(state => {
      const project = this.#project(state, projectId);
      this.#checkLabels(project, expectedLabelRevision);
      if (JSON.stringify(project.labels) === JSON.stringify(clean)) return project;
      if (project.labelRevision === Number.MAX_SAFE_INTEGER) throw conflict('The label revision limit has been reached.', 'LIMIT');
      const kept = new Set(clean.map(row => row.id));
      let backlogChanged = false;
      for (const task of [...project.tasks, ...project.backlog]) {
        const ids = task.labelIds.filter(id => kept.has(id));
        if (ids.length !== task.labelIds.length) {
          if (project.backlog.includes(task) && task.revision === Number.MAX_SAFE_INTEGER) throw conflict('The backlog item revision limit has been reached.', 'LIMIT');
          Object.assign(task, { labelIds: ids, revision: task.revision + 1, updatedAt: Date.now() });
          if (project.backlog.includes(task)) backlogChanged = true;
        }
      }
      if (backlogChanged) this.#advanceBacklog(project);
      project.labels = clean; project.labelRevision++;
      return project;
    });
  }

  #checkLabels(project, expected) {
    labelRevision(expected);
    if (project.labelRevision !== expected) throw conflict('Project labels changed. Reload the labels before saving.', 'LABEL_REVISION_CONFLICT');
  }

  createTask(input) { return this.store.update(state => this.#createTask(state, input)); }

  /**
   * Origin handoff: one board write creates To Do cards for tasks prepared in Origin, prerequisites first.
   * A card that already carries the same Origin identity is returned instead, so repeated clicks, retries
   * and concurrent requests never add a second card. The identity is saved with the card itself. Nothing
   * starts: no agent, automation, script or worktree. A failed card does not undo the others.
   */
  createOriginTasks(projectId, { originProjectId, tasks }) {
    if (!RECORD_ID.test(originProjectId) || !Array.isArray(tasks) || !tasks.length || tasks.length > 100) return Promise.reject(new BoardError('Choose 1 to 100 Origin tasks.', 'INVALID_INPUT'));
    return this.store.update(state => {
      const project = this.#project(state, projectId), results = [], failed = new Set();
      const byOrigin = new Map(project.tasks.filter(task => task.originSource?.originProjectId === originProjectId).map(task => [task.originSource.originTaskId, task]));
      for (const entry of tasks) {
        const existing = byOrigin.get(entry.originTaskId);
        if (existing) { results.push({ originTaskId: entry.originTaskId, status: 'existing', taskId: existing.id, number: existing.number, title: existing.title }); continue; }
        try {
          if ((entry.dependsOnOrigin || []).some(id => failed.has(id))) throw new BoardError('A prerequisite could not be sent, so this task waits for it.', 'PREREQUISITE_FAILED');
          const origin = originSourceOf({ originProjectId, originTaskId: entry.originTaskId, snapshotId: entry.snapshotId, hash: entry.hash, key: entry.key });
          const linked = [...(entry.dependsOnTaskIds || []), ...(entry.dependsOnOrigin || []).map(id => byOrigin.get(id)?.id)];
          if (linked.some(id => !id)) throw new BoardError('A prerequisite has no card yet.', 'PREREQUISITE_MISSING');
          const dependsOn = prerequisiteIds(linked, new Set(project.tasks.map(task => task.id)));
          const task = this.#createTask(state, { projectId, title: entry.title, prompt: entry.prompt });
          task.originSource = origin;
          if (dependsOn.length) task.dependsOn = dependsOn;
          byOrigin.set(entry.originTaskId, task);
          results.push({ originTaskId: entry.originTaskId, status: 'created', taskId: task.id, number: task.number, title: task.title });
        } catch (error) {
          failed.add(entry.originTaskId);
          results.push({ originTaskId: entry.originTaskId, status: 'failed', error: error.message || 'The card could not be created.', code: error.code || 'FAILED' });
        }
      }
      return results;
    });
  }

  /**
   * Give an Origin card newly approved context. Only an idle card in To Do changes, so running work is never
   * fed new input; the card's own revision must match what the person reviewed. Nothing starts.
   */
  refreshOriginTask(taskId, { prompt, snapshotId, hash, expectedRevision } = {}) {
    return this.store.update(state => {
      const { project, task } = this.#task(state, taskId);
      checkRevision(task, expectedRevision, 'This card');
      if (!task.originSource) throw new BoardError('This card did not come from Origin.', 'INVALID_INPUT');
      const todo = project.workflowMode === 'pipeline' ? project.pipeline.columns.find(column => column.role === 'todo')?.id : 'todo';
      const moving = task.automationMove && !['completed', 'failed', 'cancelled', 'interrupted'].includes(task.automationMove.status);
      if (task.column !== todo || this.#activeRun(state, taskId) || moving) throw conflict('Only an idle card in To Do can take new context. Stop its work and move it back to To Do first.', 'CARD_BUSY');
      const next = promptText(prompt, 'The task', project.workflowMode === 'pipeline');
      Object.assign(task, { prompt: next, updatedAt: Date.now(), revision: task.revision + 1, contentRevision: (task.contentRevision ?? 1) + 1, checksOutdated: task.checksOutdated || Boolean(task.source),
        originSource: originSourceOf({ ...task.originSource, snapshotId, hash }) });
      return task;
    });
  }

  /** Remove one prerequisite from a card, for example one whose card was deleted. Only this explicit action changes the list. */
  clearPrerequisite(taskId, { prerequisiteId, expectedRevision } = {}) {
    return this.store.update(state => {
      const { task } = this.#task(state, taskId);
      checkRevision(task, expectedRevision, 'This card');
      if (!(task.dependsOn || []).includes(prerequisiteId)) throw new BoardError('That prerequisite is no longer on this card.', 'NOT_FOUND', 404);
      task.dependsOn = task.dependsOn.filter(id => id !== prerequisiteId);
      if (!task.dependsOn.length) delete task.dependsOn;
      task.revision++; task.updatedAt = Date.now();
      return task;
    });
  }

  // A card starts only when every prerequisite card is done. Card order alone never enforces this, and
  // nothing is merged to satisfy it: a prerequisite counts once its card has reached Done.
  #checkPrerequisites(project, task) {
    if (!task.dependsOn?.length) return;
    const cards = new Map(project.tasks.map(entry => [entry.id, entry]));
    const done = id => (project.workflowMode === 'pipeline' ? project.pipeline.columns.find(column => column.id === cards.get(id)?.column)?.role === 'done' : cards.get(id)?.column === 'done');
    const path = [], explored = new Set(), visit = id => {
      if (path.includes(id)) return [...path.slice(path.indexOf(id)), id];
      if (explored.has(id)) return null;
      path.push(id);
      for (const next of cards.get(id)?.dependsOn || []) { const loop = visit(next); if (loop) return loop; }
      path.pop(); explored.add(id); return null;
    };
    const loop = visit(task.id);
    if (loop) throw new BoardError(`Its prerequisites form a loop (${loop.map(id => `#${cards.get(id)?.number ?? '?'}`).join(' → ')}). Clear one prerequisite in the card's details.`, 'PREREQUISITES_CYCLE', 409);
    const pending = task.dependsOn.filter(id => !done(id));
    if (!pending.length) return;
    const describe = id => (cards.has(id) ? `#${cards.get(id).number} ${cards.get(id).title} (${columnTitleIn(project, cards.get(id).column)})` : 'a prerequisite card that was deleted — clear it in the card\'s details');
    throw new BoardError(`Finish its prerequisites first: ${pending.map(describe).join('; ')}.`, 'PREREQUISITES_PENDING', 409);
  }

  #createTask(state, { projectId, title, prompt = '', source = null, pipelineSettings, expectedProjectRevision, priority = 0, labelIds, expectedLabelRevision }, identity = {}) {
    const task = newTask({ ...identity, title: text(title, 120, 'Title'), prompt, source: normalizeSource(source), priority, labelIds });
    const project = this.#project(state, projectId);
    if (labelIds !== undefined) { this.#checkLabels(project, expectedLabelRevision); task.labelIds = taskLabelIds(labelIds, project.labels); }
    task.prompt = promptText(prompt, 'The task', project.workflowMode === 'pipeline');
    if (project.tasks.length >= TASK_LIMIT) throw new BoardError(`A project can have at most ${TASK_LIMIT} cards.`, 'LIMIT');
    if (pipelineSettings !== undefined) Object.assign(task, this.#taskPipelineSettings(state, project, pipelineSettings, expectedProjectRevision));
    if (project.workflowMode === 'pipeline') task.column = project.pipeline.columns.find(column => column.role === 'todo').id;
    assignTaskNumbers(project); task.number = allocateTaskNumber(project);
    project.tasks.push(task); // Composer/new cards always enter the To Do role without a run.
    return task;
  }

  #backlogProject(state, id, expected) {
    const project = this.#project(state, id);
    if (project.workflowMode !== 'pipeline') throw conflict('Backlog items require a column pipeline.', 'PIPELINE_SETTINGS_REQUIRED');
    if (expected !== undefined) {
      backlogRevision(expected);
      if (project.backlogRevision !== expected) throw conflict('The backlog changed. Reload before saving.', 'BACKLOG_REVISION_CONFLICT');
    }
    return project;
  }
  #advanceBacklog(project) {
    if (project.backlogRevision === Number.MAX_SAFE_INTEGER) throw conflict('The backlog revision limit has been reached.', 'LIMIT');
    project.backlogRevision++;
  }
  async createBacklogItem(projectId, { title, prompt = '', priority = 0, labelIds = [], source = null, expectedLabelRevision, expectedBacklogRevision }) {
    backlogRevision(expectedBacklogRevision);
    const item = { id: randomUUID(), title: backlogTitle(title), prompt: backlogPrompt(prompt), priority: taskPriority(priority), labelIds: taskLabelIds(labelIds),
      source: normalizeSource(source), checksOutdated: false, createdAt: Date.now(), updatedAt: Date.now(), revision: 1 };
    return this.store.update(state => {
      const project = this.#backlogProject(state, projectId, expectedBacklogRevision);
      this.#checkLabels(project, expectedLabelRevision); item.labelIds = taskLabelIds(labelIds, project.labels);
      if (project.backlog.length >= BACKLOG_LIMIT) throw conflict(`A project can have at most ${BACKLOG_LIMIT} backlog items.`, 'LIMIT');
      project.backlog.push(item); this.#advanceBacklog(project); return item;
    });
  }
  #checkBacklogImports(project, expected) {
    backlogRevision(expected);
    if (project.backlogImportRevision !== expected) throw conflict('Import sources changed. Reload before importing.', 'BACKLOG_IMPORT_REVISION_CONFLICT');
  }
  #advanceBacklogImports(project) {
    if (project.backlogImportRevision === Number.MAX_SAFE_INTEGER) throw conflict('The import revision limit has been reached.', 'LIMIT');
    project.backlogImportRevision++;
  }
  async connectBacklogGitHubSource(projectId, { repository, expectedImportRevision }) {
    const source = githubIssueSource(repository), captured = this.#backlogProject(await this.state(), projectId);
    this.#checkBacklogImports(captured, expectedImportRevision);
    // Verify access through the existing non-interactive CLI before saving a source.
    await this.githubIssueReader({ repository: source.repository, state: 'all', page: 1 });
    return this.store.update(state => {
      const project = this.#backlogProject(state, projectId); this.#checkBacklogImports(project, expectedImportRevision);
      const existing = project.backlogSources.find(row => row.repository === source.repository);
      if (existing) return existing;
      if (project.backlogSources.length >= 20) throw conflict('A project can save at most 20 import sources.', 'LIMIT');
      const entry = { id: randomUUID(), ...source, createdAt: Date.now() };
      project.backlogSources.push(entry); this.#advanceBacklogImports(project); return entry;
    });
  }
  removeBacklogImportSource(projectId, id, { expectedImportRevision }) {
    return this.store.update(state => {
      const project = this.#backlogProject(state, projectId); this.#checkBacklogImports(project, expectedImportRevision);
      if (!project.backlogSources.some(row => row.id === id)) throw new BoardError('This import source does not exist.', 'NOT_FOUND', 404);
      project.backlogSources = project.backlogSources.filter(row => row.id !== id);
      // Provenance and the duplicate ledger survive source removal/reconnection.
      this.#advanceBacklogImports(project); return true;
    });
  }
  async importGitHubBacklogIssues(projectId, sourceId, { keys, state: issueState = 'all', page = 1, titleOverrides = {}, expectedImportRevision, expectedBacklogRevision, expectedLabelRevision }) {
    backlogRevision(expectedBacklogRevision);
    if (!['open', 'closed', 'all'].includes(issueState) || !Number.isSafeInteger(page) || page < 1 || page > 1000) throw new BoardError('Choose a valid issue state and source page.', 'INVALID_BACKLOG_IMPORT');
    if (!Array.isArray(keys) || !keys.length || keys.length > 100 || new Set(keys).size !== keys.length || keys.some(key => typeof key !== 'string' || (!/^github:issue:[1-9][0-9]{0,15}$/.test(key) || !Number.isSafeInteger(Number(key.slice(13)))))
      || !titleOverrides || typeof titleOverrides !== 'object' || Array.isArray(titleOverrides) || Object.keys(titleOverrides).some(key => !keys.includes(key))) throw new BoardError('Select up to 100 unique issues from this source page.', 'INVALID_BACKLOG_IMPORT');
    for (const title of Object.values(titleOverrides)) backlogTitle(title);
    const captured = this.#backlogProject(await this.state(), projectId, expectedBacklogRevision);
    this.#checkBacklogImports(captured, expectedImportRevision); this.#checkLabels(captured, expectedLabelRevision);
    const source = captured.backlogSources.find(row => row.id === sourceId);
    if (!source) throw new BoardError('This import source does not exist.', 'NOT_FOUND', 404);
    const preview = await this.githubIssueReader({ repository: source.repository, state: issueState, page });
    if (!preview || preview.source?.repository !== source.repository || !Array.isArray(preview.items)) throw new BoardError('The source returned an inconsistent issue page.', 'INVALID_BACKLOG_IMPORT');
    const issues = keys.map(key => {
      const matches = preview.items.filter(row => row.sourceKey === key);
      if (matches.length !== 1) throw conflict('A selected issue changed or is unavailable. Read the source page again.', 'BACKLOG_IMPORT_ITEMS_CHANGED');
      const issue = matches[0];
      const externalSource = externalIssueSource({ provider: source.provider, repository: source.repository, id: issue.id, number: issue.number, url: issue.url,
        title: issue.title, assignees: issue.assignees, updatedAt: issue.updatedAt });
      if (key !== `github:issue:${externalSource.id}`) throw new BoardError('The issue identity is inconsistent.', 'INVALID_BACKLOG_IMPORT');
      return { key, issue, externalSource };
    });
    return this.store.update(saved => {
      const project = this.#backlogProject(saved, projectId, expectedBacklogRevision);
      this.#checkBacklogImports(project, expectedImportRevision); this.#checkLabels(project, expectedLabelRevision);
      if (!project.backlogSources.some(row => row.id === sourceId && row.repository === source.repository)) throw conflict('The source changed while importing.', 'BACKLOG_IMPORT_REVISION_CONFLICT');
      const created = [], skipped = [], beforeLabels = project.labels.length;
      for (const { key, issue, externalSource } of issues) {
        const duplicate = project.backlogImported.find(row => row.key === key);
        if (duplicate) { skipped.push({ key, taskId: duplicate.taskId }); continue; }
        if (project.backlog.length >= BACKLOG_LIMIT || project.backlogImported.length >= IMPORT_IDENTITY_LIMIT) throw conflict('The backlog or import identity limit has been reached.', 'LIMIT');
        if (!Object.hasOwn(titleOverrides, key) && issue.title.trim().length > 120) throw new BoardError(`Issue #${issue.number} needs an explicit title of at most 120 characters; its original title will be retained.`, 'BACKLOG_IMPORT_TITLE_REQUIRED');
        const title = backlogTitle(Object.hasOwn(titleOverrides, key) ? titleOverrides[key] : issue.title), prompt = backlogPrompt(issue.prompt);
        if (!Array.isArray(issue.labels) || issue.labels.length > 20) throw new BoardError('This issue needs at most 20 valid labels.', 'INVALID_BACKLOG_IMPORT');
        const labelIds = [];
        for (const label of issue.labels) {
          const normalized = taskLabels([{ id: 'preview', name: label?.name, color: label?.color }])[0];
          let existing = project.labels.find(row => row.name.normalize('NFC').toLowerCase() === normalized.name.normalize('NFC').toLowerCase());
          if (!existing) { existing = { ...normalized, id: randomUUID() }; project.labels.push(existing); taskLabels(project.labels); }
          if (labelIds.includes(existing.id)) throw new BoardError('The source repeats a label identity.', 'INVALID_BACKLOG_IMPORT');
          labelIds.push(existing.id);
        }
        const now = Date.now(), item = { id: randomUUID(), title, prompt, priority: 0, labelIds, source: null, externalSource, checksOutdated: false, createdAt: now, updatedAt: now, revision: 1 };
        project.backlog.push(item); project.backlogImported.push({ key, taskId: item.id, importedAt: now }); created.push(item);
      }
      if (created.length) {
        this.#advanceBacklog(project); this.#advanceBacklogImports(project);
        if (project.labels.length !== beforeLabels) {
          if (project.labelRevision === Number.MAX_SAFE_INTEGER) throw conflict('The label revision limit has been reached.', 'LIMIT');
          project.labelRevision++;
        }
      }
      return { created, skipped, backlogRevision: project.backlogRevision, importRevision: project.backlogImportRevision, labelRevision: project.labelRevision };
    });
  }
  async previewGitHubBacklogIssues(projectId, input) {
    this.#backlogProject(await this.state(), projectId);
    const result = await this.githubIssueReader(input);
    this.#backlogProject(await this.state(), projectId);
    return result;
  }
  async #savedBacklogSource(projectId, sourceId, expectedImportRevision) {
    const project = this.#backlogProject(await this.state(), projectId);
    if (expectedImportRevision !== undefined) this.#checkBacklogImports(project, expectedImportRevision);
    const source = project.backlogSources.find(row => row.id === sourceId);
    if (!source) throw new BoardError('This import source does not exist.', 'NOT_FOUND', 404);
    return source;
  }
  async previewBacklogSource(projectId, sourceId, input) {
    const source = await this.#savedBacklogSource(projectId, sourceId);
    const guard = async () => {
      const current = await this.#savedBacklogSource(projectId, sourceId);
      if (current.repository !== source.repository) throw conflict('The import source changed.', 'BACKLOG_IMPORT_REVISION_CONFLICT');
    };
    return this.backlogCache.preview(projectId, source, input, input => this.githubIssueReader(input), guard);
  }
  async syncBacklogSource(projectId, sourceId, { expectedImportRevision }) {
    backlogRevision(expectedImportRevision);
    const source = await this.#savedBacklogSource(projectId, sourceId, expectedImportRevision);
    const guard = async () => {
      const current = await this.#savedBacklogSource(projectId, sourceId, expectedImportRevision);
      if (current.repository !== source.repository) throw conflict('The import source changed.', 'BACKLOG_IMPORT_REVISION_CONFLICT');
    };
    return this.backlogCache.sync(projectId, source, input => this.githubIssueReader(input), guard);
  }
  updateBacklogItem(projectId, id, { title, prompt, priority, labelIds, expectedLabelRevision, expectedRevision }) {
    return this.store.update(state => {
      const project = this.#backlogProject(state, projectId), item = project.backlog.find(row => row.id === id);
      if (!item) throw new BoardError('This backlog item does not exist. Reload the backlog.', 'NOT_FOUND', 404);
      checkRevision(item, expectedRevision, 'This backlog item');
      if (labelIds !== undefined) this.#checkLabels(project, expectedLabelRevision);
      const next = { title: title === undefined ? item.title : backlogTitle(title), prompt: prompt === undefined ? item.prompt : backlogPrompt(prompt),
        priority: priority === undefined ? item.priority : taskPriority(priority), labelIds: labelIds === undefined ? item.labelIds : taskLabelIds(labelIds, project.labels) };
      const contentChanged = next.title !== item.title || next.prompt !== item.prompt;
      if (!contentChanged && next.priority === item.priority && JSON.stringify(next.labelIds) === JSON.stringify(item.labelIds)) return { item, changed: false };
      if (item.revision === Number.MAX_SAFE_INTEGER) throw conflict('The backlog item revision limit has been reached.', 'LIMIT');
      Object.assign(item, next, { revision: item.revision + 1, updatedAt: Date.now(), checksOutdated: item.checksOutdated || contentChanged && Boolean(item.source) });
      this.#advanceBacklog(project); return { item, changed: true };
    });
  }
  async deleteBacklogItem(projectId, id, { expectedRevision, expectedBacklogRevision }) {
    backlogRevision(expectedBacklogRevision);
    return this.store.update(state => {
      const project = this.#backlogProject(state, projectId, expectedBacklogRevision), item = project.backlog.find(row => row.id === id);
      if (!item) throw new BoardError('This backlog item does not exist. Reload the backlog.', 'NOT_FOUND', 404);
      checkRevision(item, expectedRevision, 'This backlog item');
      project.backlog = project.backlog.filter(row => row.id !== id); this.#advanceBacklog(project); return true;
    });
  }
  async reorderBacklog(projectId, { ids, expectedBacklogRevision }) {
    backlogRevision(expectedBacklogRevision);
    return this.store.update(state => {
      const project = this.#backlogProject(state, projectId, expectedBacklogRevision);
      if (!Array.isArray(ids) || ids.length !== project.backlog.length || ids.some(id => typeof id !== 'string' || !project.backlog.some(item => item.id === id)) || new Set(ids).size !== ids.length)
        throw new BoardError('List every backlog item once in its new order.', 'INVALID_BACKLOG');
      if (ids.every((id, index) => id === project.backlog[index].id)) return project;
      const items = new Map(project.backlog.map(item => [item.id, item])); project.backlog = ids.map(id => items.get(id)); this.#advanceBacklog(project); return project;
    });
  }
  async promoteBacklogItem(projectId, id, { expectedRevision, expectedBacklogRevision, column }) {
    backlogRevision(expectedBacklogRevision);
    return this.store.update(state => {
      const project = this.#backlogProject(state, projectId, expectedBacklogRevision), item = project.backlog.find(row => row.id === id);
      if (!item) throw new BoardError('This backlog item does not exist. Check the board before trying again.', 'NOT_FOUND', 404);
      checkRevision(item, expectedRevision, 'This backlog item');
      const todo = project.pipeline.columns.find(row => row.role === 'todo').id;
      if (column !== undefined && column !== todo) throw conflict('Choose the To Do column for backlog promotion.', 'BACKLOG_TARGET_UNSUPPORTED');
      return this.#publishBacklogTask(state, project, item);
    });
  }

  #publishBacklogTask(state, project, item) {
    if (state.projects.some(owner => owner.tasks.some(task => task.id === item.id))) throw conflict('This item already has a board card.', 'REVISION_CONFLICT');
    const task = this.#createTask(state, { ...item, projectId: project.id, expectedLabelRevision: project.labelRevision }, { id: item.id, createdAt: item.createdAt, checksOutdated: item.checksOutdated, ...(item.externalSource === undefined ? {} : { externalSource: item.externalSource }) });
    project.backlog = project.backlog.filter(row => row.id !== item.id); this.#advanceBacklog(project); return task;
  }

  /** Publish once, then use the existing arrival owner. Failed side effects never recreate a draft or replay promotion. */
  promoteBacklogToColumn(projectId, id, { column, expectedRevision, expectedBacklogRevision, expectedProjectRevision }) {
    backlogRevision(expectedBacklogRevision);
    if (typeof column !== 'string' || !Number.isSafeInteger(expectedProjectRevision) || expectedProjectRevision < 1)
      throw new BoardError('Choose a column and send the current board settings revision.', 'INVALID_INPUT');
    return this.#locked(`transition:${id}`, () => this.#locked(`run:${id}`, async () => {
      const task = await this.store.update(state => {
        const project = this.#backlogProject(state, projectId, expectedBacklogRevision), item = project.backlog.find(row => row.id === id);
        if (!item) throw new BoardError('This backlog item does not exist. Check the board before trying again.', 'NOT_FOUND', 404);
        checkRevision(item, expectedRevision, 'This backlog item'); checkRevision(project, expectedProjectRevision, 'This project');
        const target = project.pipeline.columns.find(row => row.id === column);
        if (!target) throw new BoardError('Choose a valid column.', 'INVALID_COLUMN');
        if (target.role !== 'todo' && project.pipelineImport) throw conflict('Review and save the imported board configuration before promoting into this column.', 'PIPELINE_IMPORT_PENDING');
        if (target.automations.onEnter.some(row => row.enabled && row.type === 'send_message' && row.mode !== 'deferred'))
          throw conflict('Agent messages currently support deferred delivery on entry only.', 'PIPELINE_FEATURE_PENDING');
        return this.#publishBacklogTask(state, project, item);
      });
      if (task.column === column) return { task, arrival: { status: 'completed' } };
      try {
        const result = await this.#pipelineTransition(id, { column, expectedRevision: task.revision, expectedProjectRevision, initialArrival: true, trigger: 'user' });
        return { ...result, arrival: { status: 'completed' } };
      } catch (error) {
        // Publication has already succeeded. Preserve its identity, artifacts and outcome for explicit review.
        return { task: await this.#taskNow(id), arrival: { status: 'failed', code: error.code || 'ARRIVAL_FAILED', reason: String(error.message || 'Column arrival failed.').slice(0, 500) } };
      }
    }));
  }

  updateTask(id, input) {
    return input.pipelineSettings === undefined ? this.#updateTask(id, input) : this.#locked(`run:${id}`, () => this.#updateTask(id, input));
  }

  #taskPipelineSettings(state, project, input, expectedProjectRevision) {
    if (project.workflowMode !== 'pipeline') throw new BoardError('Task pipeline settings require a column pipeline.', 'PIPELINE_SETTINGS_REQUIRED', 409);
    if (!Number.isSafeInteger(expectedProjectRevision) || expectedProjectRevision < 1) throw new BoardError('Send the project revision for task pipeline settings.', 'INVALID_INPUT');
    checkRevision(project, expectedProjectRevision, 'This project');
    const selection = normalizePipelineTaskSelection(project.pipeline, input);
    for (const column of project.pipeline.columns.filter(column => column.role === 'active')) resolveConfig(column.id, effectiveWorkflow(project, state.settings.defaultAgent, state, selection)[column.id]);
    return selection;
  }

  async #updateTask(id, { title, prompt, expectedRevision, pipelineSettings, expectedProjectRevision, priority, labelIds, expectedLabelRevision }) {
    if (priority !== undefined) taskPriority(priority);
    if (labelIds !== undefined) {
      const { project } = this.#task(await this.state(), id);
      this.#checkLabels(project, expectedLabelRevision); taskLabelIds(labelIds, project.labels);
    }
    if (this.messageScheduler?.ownsTask(id)) {
      const { project, task } = this.#task(await this.state(), id);
      checkRevision(task, expectedRevision, 'This card');
      const nextTitle = title === undefined ? task.title : text(title, 120, 'Title');
      const nextPrompt = prompt === undefined ? task.prompt : promptText(prompt, 'The task', project.workflowMode === 'pipeline');
      if (nextTitle !== task.title || nextPrompt !== task.prompt) {
        this.messageScheduler.cancelTask(id);
        await this.messageScheduler.waitTask(id);
        for (const key of task.pendingAutomationMessages || []) await this.#publishAutomationMove(key);
      }
    }
    return this.store.update(state => {
      const { project, task } = this.#task(state, id);
      checkRevision(task, expectedRevision, 'This card');
      if (labelIds !== undefined) this.#checkLabels(project, expectedLabelRevision);
      let selection, settingsChanged = false;
      if (pipelineSettings !== undefined) {
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new BoardError('Send the card revision for task pipeline settings.', 'INVALID_INPUT');
        selection = this.#taskPipelineSettings(state, project, pipelineSettings, expectedProjectRevision);
        const previous = normalizePipelineTaskSelection(project.pipeline, { profileId: task.profileId, agentOverride: task.agentOverride });
        settingsChanged = JSON.stringify(previous) !== JSON.stringify(selection);
        if (settingsChanged) {
          this.#requireAutomationsStopped(task);
          if (this.#activeRun(state, id)) throw conflict('Pause this card’s agent before changing its pipeline settings.', 'RUN_ACTIVE');
        }
      }
      const nextTitle = title === undefined ? task.title : text(title, 120, 'Title');
      const nextPrompt = prompt === undefined ? task.prompt : promptText(prompt, 'The task', project.workflowMode === 'pipeline');
      const nextPriority = priority === undefined ? taskPriority(task.priority) : taskPriority(priority);
      const nextLabels = taskLabelIds(labelIds === undefined ? task.labelIds : labelIds, project.labels);
      const contentChanged = nextTitle !== task.title || nextPrompt !== task.prompt;
      if (!contentChanged && !settingsChanged && nextPriority === taskPriority(task.priority) && JSON.stringify(nextLabels) === JSON.stringify(task.labelIds)) return { task, changed: false };
      // Checks from generation apply only to the original text.
      // A content change also makes any earlier plan approval stale.
      Object.assign(task, { title: nextTitle, prompt: nextPrompt, priority: nextPriority, labelIds: nextLabels, updatedAt: Date.now(), revision: task.revision + 1,
        ...(contentChanged ? { checksOutdated: task.checksOutdated || Boolean(task.source), contentRevision: (task.contentRevision ?? 1) + 1 } : {}), ...(settingsChanged ? selection : {}) });
      return { task, changed: true };
    });
  }

  async duplicateTask(id) {
    return this.store.update(state => {
      const { project, task } = this.#task(state, id);
      if (project.tasks.length >= TASK_LIMIT) throw new BoardError(`A project can have at most ${TASK_LIMIT} cards.`, 'LIMIT');
      // A copy is a new card: it keeps its prerequisites but not the Origin identity of the original.
      const copy = newTask({ title: `${task.title.slice(0, 113)} (copy)`, prompt: task.prompt, source: structuredClone(task.source), checksOutdated: task.checksOutdated, priority: task.priority, labelIds: task.labelIds, ...(task.dependsOn?.length ? { dependsOn: task.dependsOn } : {}), ...(task.externalSource === undefined ? {} : { externalSource: structuredClone(task.externalSource) }) });
      if (project.workflowMode === 'pipeline') copy.column = project.pipeline.columns.find(column => column.role === 'todo').id;
      if (project.workflowMode === 'pipeline' && (task.profileId || task.agentOverride)) Object.assign(copy, normalizePipelineTaskSelection(project.pipeline, { profileId: task.profileId, agentOverride: task.agentOverride }));
      if (task.baseBinding) copy.baseBinding = structuredClone(task.baseBinding);
      if (task.baseColumns) copy.baseColumns = structuredClone(task.baseColumns);
      assignTaskNumbers(project); copy.number = allocateTaskNumber(project);
      project.tasks.splice(project.tasks.indexOf(task) + 1, 0, copy); // A copy starts in To Do with no workspace.
      return copy;
    });
  }

  /**
   * Put a card in a column at a position, in one state update. Only transition() calls this for a
   * column change; the checks there decide whether the change is allowed.
   */
  #place(state, id, { from, column, index, transitionId = null, by = 'user', reason = '', runId = null }) {
    const { project, task } = this.#task(state, id);
    if (task.column !== from) throw conflict(`The card moved to ${title(task.column)} meanwhile. Reload the board.`, 'REVISION_CONFLICT');
    if (project.workflowMode !== 'pipeline' && task.column !== column && this.#activeRun(state, id)) throw conflict('This card has an active run. Wait for it to finish or cancel it first.', 'RUN_ACTIVE');
    const others = project.tasks.filter(item => item !== task);
    const inColumn = others.filter(item => item.column === column);
    const position = Number.isInteger(index) ? Math.max(0, Math.min(index, inColumn.length)) : inColumn.length;
    const before = inColumn[position];
    const at = before ? others.indexOf(before) : (inColumn.length ? others.indexOf(inColumn.at(-1)) + 1 : others.length);
    if (task.column !== column) {
      task.flow = null; // A follow-up belongs to the stage the card leaves.
      task.transitions = [...task.transitions, { at: Date.now(), from: task.column, to: column, by, ...(reason ? { reason } : {}) }].slice(-TRANSITION_LOG_LIMIT);
      task.column = column;
      if (transitionId) task.lastTransition = { id: transitionId, to: column, at: Date.now(), ...(runId ? { runId } : {}) };
    }
    others.splice(at, 0, task);
    project.tasks = others;
    task.revision++;
    return task;
  }
  #placeStored(id, move) { return this.store.update(state => this.#place(state, id, move)); }

  async deleteTask(id, { expectedRevision, keepFiles = false }) {
    this.#requireAutomationsStopped(this.#task(await this.state(), id).task);
    // Share the run-start lock so deletion cannot race with a queued agent launch.
    return this.#locked(`run:${id}`, async () => {
      const { task } = this.#task(await this.state(), id);
      this.#requireAutomationsStopped(task);
      checkRevision(task, expectedRevision, 'This card');
      let revision = expectedRevision;
      if (task.workspace && !keepFiles) revision = (await this.removeTaskWorktree(id)).revision;
      return this.store.update(state => {
        const { project, task: current } = this.#task(state, id);
        checkRevision(current, revision, 'This card');
        if (this.#activeRun(state, id)) throw conflict('Stop this card’s active run before deleting it.', 'RUN_ACTIVE');
        if (current.workspace && keepFiles) {
          // Keep a durable locator even when the card has never had a run.
          state.retainedWorkspaces ??= [];
          state.retainedWorkspaces.push({ taskId: id, projectId: project.id, title: current.title, ...current.workspace, retainedAt: Date.now() });
        }
        const ap = project.autopilot;
        if (ap) {
          ap.queue = (ap.queue || []).filter(taskId => taskId !== id);
          ap.done = (ap.done || []).filter(taskId => taskId !== id);
          if (ap.routes) delete ap.routes[id];
          if (ap.current?.taskId === id) {
            ap.current = null;
            if (ap.status !== 'off') { ap.status = 'paused'; ap.reason = 'The current card was deleted. Review the remaining queue before resuming.'; }
          }
        }
        project.tasks = project.tasks.filter(item => item.id !== id);
        project.revision++;
      });
    });
  }

  // ---- Migration, import, export ----

  /**
   * Import the browser's version 1 board once. IDs are kept, so a repeated migration
   * adds nothing. Cards keep their exact text, order, source details, and outdated flag.
   */
  async migrateBrowserBoard(data) {
    const parsed = parseBackup(data);
    if (parsed.projects.some(project => project.backlog.length || project.backlogSources.length || project.backlogImported.length)) throw new BoardError('Use portable import to retain backlog items.', 'INVALID_BACKUP');
    return this.store.update(state => {
      let projects = 0, cards = 0, skipped = 0;
      const taskIds = new Set(state.projects.flatMap(project => [...project.tasks, ...project.backlog].map(task => task.id)));
      for (const incoming of parsed.projects) {
        let project = state.projects.find(item => item.id === incoming.id);
        if (!project) {
          if (state.projects.length >= PROJECT_LIMIT) throw new BoardError(`A board can have at most ${PROJECT_LIMIT} projects.`, 'LIMIT');
          let name = incoming.name;
          for (let n = 2; state.projects.some(item => item.name.toLowerCase() === name.toLowerCase()); n++) name = `${incoming.name.slice(0, 74)} (${n})`;
          project = newProject({ id: incoming.id, name, createdAt: incoming.createdAt, labels: incoming.labels });
          project.timelineNotes = incoming.timelineNotes;
          project.backlog = []; // Browser migration keeps the existing legacy project policy.
          if (incoming.columnLayout) project.columnLayout = incoming.columnLayout;
          state.projects.push(project);
          projects++;
        }
        const additional = incoming.labels.filter(label => {
          const prior = project.labels.find(row => row.id === label.id);
          if (prior && JSON.stringify(prior) !== JSON.stringify(label)) throw conflict('Imported labels conflict with this project’s labels.', 'LABEL_REVISION_CONFLICT');
          return !prior;
        });
        if (additional.length) { project.labels = taskLabels([...project.labels, ...additional]); project.labelRevision++; }
        for (const card of incoming.tasks) {
          if (taskIds.has(card.id)) { skipped++; continue; }
          if (project.tasks.length >= TASK_LIMIT) throw new BoardError(`A project can have at most ${TASK_LIMIT} cards.`, 'LIMIT');
          assignTaskNumbers(project);
          project.tasks.push(newTask({ ...card, number: allocateTaskNumber(project), column: project.workflowMode === 'pipeline' ? project.pipeline.columns.find(column => column.role === 'todo').id : 'todo' }));
          taskIds.add(card.id);
          cards++;
        }
      }
      state.migrations.push({ kind: 'browser-kanban-v1', at: Date.now(), projects, cards, skipped });
      return { projects, cards, skipped };
    });
  }

  async exportBackup({ includeBaseContent = false } = {}) {
    const state = await this.state();
    const base = await this.base.export({ includeContent: includeBaseContent });
    if ((await this.state()).base.revision !== state.base.revision) throw conflict('Base changed while the backup was being prepared. Export it again.', 'BASE_REVISION_CONFLICT');
    return { application: 'Promptboard', kind: 'promptboard-backup', version: 10, exportedAt: new Date().toISOString(),
      base, baseGlobal: backupBaseScopes(state.settings.pendingBaseImport || state.settings),
      projects: state.projects.map(project => ({ id: project.id, name: project.name, createdAt: project.createdAt, nextTaskNumber: project.nextTaskNumber, labels: taskLabels(project.labels), backlog: backlogItems(project.backlog, project.labels), backlogSources: backlogImportSources(project.backlogSources), backlogImported: backlogImportLedger(project.backlogImported),
        ...(project.workflowMode === 'pipeline' ? { workflowMode: 'pipeline', pipeline: project.pipelineImport || project.pipeline } : {}),
        ...backupBaseScopes({ ...project.pendingImport, ...project, ...(project.baseBinding ? {} : project.pendingImport?.baseBinding ? { baseBinding: project.pendingImport.baseBinding } : {}) }),
        repository: project.repository ? { path: project.repository.path } : null, targetBranch: project.targetBranch ? { name: project.targetBranch.name } : null,
        agentDefaults: project.agentDefaults || null, workflow: project.workflow || {}, testCommands: project.testCommands || [], timelineNotes: project.timelineNotes || [], columnLayout: project.columnLayout || [],
        // Workspaces and runs are machine-specific and are not exported.
        tasks: project.tasks.map(task => ({ id: task.id, number: task.number, title: task.title, prompt: task.prompt, priority: taskPriority(task.priority), labelIds: taskLabelIds(task.labelIds, project.labels), source: task.source, ...(task.externalSource === undefined ? {} : { externalSource: externalIssueSource(task.externalSource) }),
          ...(task.originSource === undefined ? {} : { originSource: originSourceOf(task.originSource) }), ...(task.dependsOn?.length ? { dependsOn: [...task.dependsOn] } : {}), checksOutdated: task.checksOutdated,
          createdAt: task.createdAt, updatedAt: task.updatedAt, column: task.column, ...backupBaseScopes(task, true),
          ...(project.workflowMode === 'pipeline' ? normalizePipelineTaskSelection(project.pipelineImport || project.pipeline, { profileId: task.profileId, agentOverride: task.agentOverride }) : {}) })) })) };
  }

  /**
   * Replace the board with a backup. Execution state is not imported; repository paths
   * and automation settings wait for confirmation per project. Nothing runs.
   */
  async importBackup(data, { replace = false } = {}) {
    const parsed = parseBackup(data);
    const preparedBase = parsed.base ? await this.base.prepareImport(parsed.base) : null;
    if ([3, 4, 5, 6, 7, 8, 9, 10].includes(data.version) && !preparedBase) throw new BoardError('This backup is missing its Base resource library.', 'INVALID_BACKUP');
    if (preparedBase) {
      for (const incoming of parsed.projects) {
        Object.assign(incoming, remapBaseScopes(incoming, preparedBase.remap));
        for (const task of incoming.tasks) Object.assign(task, remapBaseScopes(task, preparedBase.remap));
      }
      parsed.baseGlobal = remapBaseScopes(parsed.baseGlobal, preparedBase.remap);
      const resourceKinds = new Map(preparedBase.resources.map(resource => [resource.id, resource.kind]));
      for (const scope of [parsed.baseGlobal, ...parsed.projects]) {
        const profiles = [scope.agentProfileId, ...Object.values(scope.baseColumns || {}).map(column => column.profileId)].filter(Boolean);
        if (profiles.some(profileId => resourceKinds.get(profileId) !== 'profile')) throw new BoardError('An imported agent profile reference points to another resource type.', 'INVALID_BACKUP');
      }
    }
    return this.store.update(state => {
      if (state.projects.length && !replace) throw conflict('Confirm that the import replaces the current board.', 'CONFIRMATION_REQUIRED');
      if (this.#hasWorkspaceOrRun(state)) throw conflict('Tasks on the current board own worktrees or runs. Remove those worktrees before you replace the board.', 'WORKSPACES_EXIST');
      if (preparedBase) this.base.publishPreparedImport(state, preparedBase);
      if (parsed.baseGlobal && Object.keys(parsed.baseGlobal).length) state.settings.pendingBaseImport = parsed.baseGlobal;
      else delete state.settings.pendingBaseImport;
      state.projects = parsed.projects.map(incoming => {
        const project = newProject(incoming);
        project.tasks = incoming.tasks.map(task => ({ ...newTask(task), ...backupBaseScopes(task, true),
          ...(incoming.pipeline ? normalizePipelineTaskSelection(incoming.pipeline, { profileId: task.profileId, agentOverride: task.agentOverride }) : {}) }));
        if (incoming.pipeline) {
          project.workflowMode = 'pipeline'; project.pipelineImport = incoming.pipeline;
          project.pipeline = structuredClone(incoming.pipeline);
          for (const column of project.pipeline.columns) {
            column.strategy.autoSpawn = false;
            for (const rows of Object.values(column.automations)) for (const row of rows) row.enabled = false;
          }
          for (const profile of project.pipeline.profiles) for (const strategy of Object.values(profile.columns)) strategy.autoSpawn = false;
          for (const task of project.tasks) if (project.pipeline.columns.find(column => column.id === task.column)?.role === 'done') task.archivedAt = task.updatedAt;
        }
        if (incoming.columnLayout) project.columnLayout = incoming.columnLayout;
        project.timelineNotes = incoming.timelineNotes.map(note => ({ ...note, taskId: project.tasks.some(task => task.id === note.taskId) ? note.taskId : null }));
        if (incoming.repositoryPath || incoming.targetBranch || incoming.workflow || incoming.testCommands || incoming.agentDefaults || incoming.baseBinding || incoming.baseColumns || incoming.agentProfileId) {
          project.pendingImport = { repositoryPath: incoming.repositoryPath, targetBranch: incoming.targetBranch, workflow: incoming.workflow, testCommands: incoming.testCommands };
          if (incoming.agentDefaults) project.pendingImport.agentDefaults = incoming.agentDefaults;
          Object.assign(project.pendingImport, backupBaseScopes(incoming));
          if (incoming.baseBinding || incoming.baseColumns || incoming.agentProfileId) project.pendingImport.baseTargetRevision = 0;
        }
        return project;
      });
      state.runs = [];
      state.sessions = [];
      return { projects: state.projects.length, cards: state.projects.reduce((sum, project) => sum + project.tasks.length, 0) };
    });
  }

  async restoreBaseGlobals({ confirm, expectedBaseRevision }) {
    if (confirm !== true) throw new BoardError('Confirm restoring the imported global Base selection.', 'CONFIRMATION_REQUIRED', 409);
    return this.store.update(state => {
      if (state.base.revision !== expectedBaseRevision) throw conflict('Base changed. Reload the imported selection.', 'BASE_REVISION_CONFLICT');
      const pending = state.settings.pendingBaseImport;
      if (!pending) throw new BoardError('There is no imported global Base selection.', 'NOTHING_PENDING');
      const previousBaseRevision = state.settings.baseRevision || 0;
      delete state.settings.baseBinding;
      delete state.settings.agentProfileId;
      Object.assign(state.settings, pending);
      delete state.settings.pendingBaseImport;
      state.settings.baseRevision = previousBaseRevision + 1;
      state.base.revision++;
      return state.settings;
    });
  }

  // ---- Worktrees ----

  async #checkedRepository(project) {
    if (!project.repository) throw new BoardError('Link this project to a Git repository first.', 'REPOSITORY_REQUIRED', 409);
    if (!project.targetBranch) throw new BoardError('Choose the local target branch first.', 'TARGET_BRANCH_REQUIRED', 409);
    const repository = await validateRepository(project.repository.root);
    if (repository.commonDir !== project.repository.commonDir) throw new BoardError('The linked folder now belongs to a different repository. Link it again.', 'REPOSITORY_CHANGED', 409);
    if (!(await commitExists(repository.root, project.targetBranch.commit))) throw new BoardError('The recorded target-branch commit no longer exists. Choose the target branch again.', 'TARGET_COMMIT_MISSING', 409);
    return repository;
  }

  async #registered(root, path) { return (await listWorktrees(root)).find(entry => entry.path === path) || null; }

  /**
   * Check that the task worktree exists, is registered with Git, and is on the task branch.
   * A deleted folder is recreated from the task branch: the commits are on the branch, so nothing
   * is lost that the folder still had. Anything else stops with the exact problem.
   */
  async #verifyWorktree(taskId, repository, ws) {
    const found = await this.#registered(repository.root, ws.path);
    const exists = await access(ws.path).then(() => true, () => false);
    if (found && exists) {
      if (found.branch !== ws.branch) throw conflict(`The task worktree at ${ws.path} is on ${found.branch || 'a detached HEAD'}, not on the task branch ${ws.branch}. Switch it back (git switch ${ws.branch}) in that folder; Promptboard does not switch branches for you.`, 'BRANCH_MISMATCH');
      return ws;
    }
    if (exists) throw conflict(`The folder ${ws.path} exists, but Git does not list it as a worktree. Check it with git worktree list; Promptboard does not change it.`, 'WORKTREE_MISSING');
    if (!(await branchExists(repository.root, ws.branch))) throw conflict(`The task worktree and its branch ${ws.branch} were deleted, so the task's commits cannot be found. Restore the branch (git branch ${ws.branch} <commit>) or remove the task.`, 'WORKTREE_BRANCH_MISSING');
    // `git worktree prune` removes only Git's records of worktree folders that no longer exist.
    await git(['worktree', 'prune'], { cwd: repository.root });
    await git(['worktree', 'add', ws.path, ws.branch], { cwd: repository.root, config: [`core.hooksPath=${this.hooksDir}`, 'core.fsmonitor=false'], timeoutMs: 120000 })
      .catch(() => { throw conflict(`The task worktree folder was deleted and Git could not recreate it from ${ws.branch}. Run git worktree list in the repository.`, 'WORKTREE_MISSING'); });
    return this.store.update(draft => {
      const { task: current } = this.#task(draft, taskId);
      current.workspace = { ...current.workspace, recoveredAt: Date.now() };
      current.revision++;
      return current.workspace;
    });
  }

  /**
   * Return the task's worktree, creating it once from the recorded target commit.
   * Concurrent and repeated calls get the same branch and folder.
   */
  ensureTaskWorktree(taskId) {
    return this.#locked(`task:${taskId}`, async () => {
      const state = await this.state();
      const { project, task } = this.#task(state, taskId);
      const repository = await this.#checkedRepository(project);
      if (task.workspace?.status === 'ready') return this.#verifyWorktree(taskId, repository, task.workspace);
      if (task.workspace) throw new BoardError('An earlier worktree creation for this task did not finish. Check the folder and branch manually.', 'WORKTREE_INCOMPLETE', 409);
      return this.#locked(`repo:${repository.commonDir}`, async () => {
        let branch = `promptboard/${slug(task.title)}-${task.id.slice(0, 8)}`;
        for (let n = 2; await branchExists(repository.root, branch); n++) {
          if (n > 50) throw new BoardError('Could not find a free branch name for this task.', 'BRANCH_NAME_UNAVAILABLE', 409);
          branch = `promptboard/${slug(task.title)}-${task.id.slice(0, 8)}-${n}`;
        }
        await mkdir(join(this.worktreeRoot, project.id), { recursive: true, mode: 0o700 });
        await mkdir(this.hooksDir, { recursive: true, mode: 0o700 });
        const path = join(await realpath(join(this.worktreeRoot, project.id)), task.id);
        if (inside(repository.root, path)) throw new BoardError('The worktree folder would be inside the repository. Choose a different app data folder.', 'WORKTREE_PATH_INVALID', 409);
        if (await access(path).then(() => true, () => false)) throw new BoardError('A folder already exists where this task worktree would go. Promptboard will not overwrite it.', 'WORKTREE_PATH_EXISTS', 409);
        const baseCommit = project.targetBranch.commit;
        // Record ownership before Git creates anything, so cleanup only touches what this app made.
        await this.store.update(draft => {
          const { task: current } = this.#task(draft, taskId);
          if (current.workspace) throw conflict('A worktree for this task is already being created.', 'WORKTREE_EXISTS');
          current.workspace = { status: 'creating', branch, path, baseCommit, targetBranch: project.targetBranch.name, repositoryRoot: repository.root, commonDir: repository.commonDir, createdAt: Date.now() };
          current.revision++;
        });
        try {
          await git(['worktree', 'add', '-b', branch, path, baseCommit], { cwd: repository.root, config: [`core.hooksPath=${this.hooksDir}`, 'core.fsmonitor=false'], timeoutMs: 120000 });
        } catch {
          const leftovers = await access(path).then(() => true, () => false) || await branchExists(repository.root, branch);
          await this.store.update(draft => {
            const { task: current } = this.#task(draft, taskId);
            current.workspace = leftovers ? { ...current.workspace, status: 'failed' } : null;
            current.revision++;
          });
          throw new BoardError('Git could not create the task worktree. Run git worktree list in the repository to check it.', 'WORKTREE_FAILED', 502);
        }
        return this.store.update(draft => {
          const { task: current } = this.#task(draft, taskId);
          current.workspace = { ...current.workspace, status: 'ready', readyAt: Date.now() };
          current.revision++;
          return current.workspace;
        });
      });
    });
  }

  /**
   * Remove a task worktree that this app created. Refuses dirty worktrees and anything
   * outside the app's worktree folder. The task branch is kept.
   */
  removeTaskWorktree(taskId) {
    return this.#locked(`task:${taskId}`, async () => {
      const { task } = this.#task(await this.state(), taskId);
      this.#requireAutomationsStopped(task);
      const workspace = task.workspace;
      if (!workspace) return null;
      if (this.#activeRun(await this.state(), taskId)) throw conflict('This card has an active run.', 'RUN_ACTIVE');
      const root = await realpath(this.worktreeRoot).catch(() => this.worktreeRoot);
      if (!inside(root, workspace.path) || workspace.path === root) throw new BoardError('This worktree is not in Promptboard\'s folder, so it is not removed.', 'WORKTREE_NOT_OWNED', 409);
      const registered = await this.#registered(workspace.repositoryRoot, workspace.path);
      if (!registered || registered.branch !== workspace.branch) throw new BoardError('Git does not list this worktree for the task branch, so nothing was removed.', 'WORKTREE_NOT_OWNED', 409);
      const status = await git(['status', '--porcelain', '--untracked-files=all'], { cwd: workspace.path });
      if (status.trim()) throw new BoardError('The task worktree has uncommitted changes. Commit or move them first; Promptboard never discards files.', 'WORKTREE_DIRTY', 409);
      await git(['worktree', 'remove', workspace.path], { cwd: workspace.repositoryRoot });
      return this.store.update(draft => {
        const { task: current } = this.#task(draft, taskId);
        current.retainedBranches = [...current.retainedBranches, { branch: workspace.branch, removedAt: Date.now() }];
        current.workspace = null;
        current.revision++;
        return current;
      });
    });
  }

  // ---- Runs ----

  /**
   * Authorize a run of the task's current stage. To Do and Done never run. A run needs
   * explicit consent. The first Planning or Executing run allocates the task worktree;
   * later runs reuse it. Duplicate requests are serialized per task and get one run.
   */
  requestRun(taskId, options = {}) {
    return this.#locked(`run:${taskId}`, () => this.#startRun(taskId, options));
  }

  /** Serialize pause with launch/deletion/resume for this task. Files and the native conversation stay. */
  async pauseRun(runId, { confirm = false } = {}) {
    const run = await this.run(runId);
    if (confirm !== true) throw new BoardError('Confirm that you want to pause this agent session.', 'CONFIRMATION_REQUIRED');
    this.abortAutomationTask(run.taskId);
    const cancelledHandoff = this.executor?.abortBoundary?.(runId);
    return this.#locked(`run:${run.taskId}`, async () => {
      if (!this.executor?.suspend) throw new BoardError('Session suspension is not available.', 'EXECUTION_UNAVAILABLE', 503);
      if (cancelledHandoff && run.sessionId) {
        const state = await this.state(), session = state.sessions.find(item => item.id === run.sessionId);
        if (session?.currentRunId && session.currentRunId !== runId) runId = session.currentRunId;
      }
      await this.executor.suspend(runId);
      // A user pause may cancel a system handoff after its owned process exited.
      // Preserve the user's intent even though suspend() now has no process to stop.
      await this.store.update(state => {
        const current = state.runs.find(item => item.id === runId);
        const session = state.sessions.find(item => item.currentRunId === runId);
        if (current?.status === 'suspended' && session) {
          session.pauseIntent = 'user'; session.suspensionRequestedAt = Date.now();
          delete session.suspensionToken; delete session.previousLifecycle;
        }
      });
      return this.run(runId);
    });
  }

  /** Supervisor-only: save pause intent before signalling an owned process. */
  async beginSuspension(runId, { intent = 'user', token = null, guard = null } = {}) {
    return this.store.update(state => {
      guard?.(state);
      const run = state.runs.find(item => item.id === runId);
      if (!run || !ACTIVE_RUN_STATUSES.includes(run.status)) throw conflict('This run is no longer active.', 'RUN_NOT_ACTIVE');
      const session = state.sessions.find(item => item.id === run.sessionId && item.currentRunId === run.id);
      if (!session) throw conflict('This run has no logical session.', 'SESSION_MISSING');
      session.pauseIntent = intent; session.suspensionRequestedAt = Date.now();
      if (token) { session.suspensionToken = token; session.previousLifecycle = run.lifecycle; }
      run.lifecycle = 'suspending';
      const project = state.projects.find(item => item.id === run.projectId);
      if (project?.autopilot?.status === 'running') { project.autopilot.status = 'paused'; project.autopilot.reason = 'The task agent was paused by you.'; }
    });
  }

  /** Undo only this system lease when fresh activity invalidates a boundary. */
  async abortSuspension(runId, token) {
    return this.store.update(state => {
      const run = state.runs.find(item => item.id === runId);
      const session = state.sessions.find(item => item.currentRunId === runId && item.suspensionToken === token && item.pauseIntent === 'system');
      if (!session || !ACTIVE_RUN_STATUSES.includes(run?.status)) return;
      run.lifecycle = session.previousLifecycle;
      session.pauseIntent = null;
      delete session.suspensionRequestedAt; delete session.suspensionToken; delete session.previousLifecycle;
    });
  }

  /** Explicit native resume of the current stage. No stage actions or original task text are replayed. */
  resumeTask(taskId, { consent = false, message = '' } = {}) {
    return this.#locked(`run:${taskId}`, async () => {
      if (consent !== true) throw new BoardError('Resuming an agent needs your explicit confirmation.', 'CONSENT_REQUIRED');
      if (typeof message !== 'string' || Buffer.byteLength(message) > 64 * 1024 || message.includes('\0')) throw new BoardError('Send a continuation of at most 64 KiB without null characters.', 'INVALID_INPUT');
      const state = await this.state(), { project, task } = this.#task(state, taskId);
      if (project.workflowMode === 'pipeline') return this.#pipelineStart(taskId, { column: task.column, requireResume: true, continuation: message });
      if (['todo', 'done'].includes(task.column) || task.archivedAt) throw conflict('Move or restore this task to an active column before resuming.', 'SESSION_NOT_RESUMABLE');
      if (this.#activeRun(state, taskId)) throw conflict('This card already has an active run.', 'RUN_ACTIVE');
      if (project.autopilot?.status === 'running') throw conflict('Pause Autopilot before resuming this conversation manually.', 'AUTOPILOT_ACTIVE');
      const session = state.sessions.find(item => item.id === task.sessionId && item.taskId === taskId && item.projectId === project.id);
      const previous = session && state.runs.find(item => item.id === session.currentRunId && item.taskId === taskId);
      if (!previous || !['suspended', 'orphaned', 'exited'].includes(session.status)) throw conflict('This card has no inactive conversation to resume.', 'SESSION_NOT_RESUMABLE');
      const nativeSessionId = validateResumeId(session.nativeSessionId);
      if (previous.stage !== task.column) throw conflict('This saved conversation belongs to another stage. Start this stage instead.', 'SESSION_STAGE_MISMATCH');
      if (previous.promptRevision !== (task.contentRevision ?? 1)) throw conflict('The task text changed after this conversation. Start a fresh run to supply the new text.', 'SESSION_PROMPT_STALE');
      if (!this.executor) throw new BoardError('Agent execution is not available.', 'EXECUTION_UNAVAILABLE', 503);
      const config = { ...await this.executor.validate({ stage: previous.stage, config: session.config }), instructions: session.config.instructions || '' };
      const baseManifest = structuredClone(previous.baseManifest || this.#basePreflight(state, project, task, previous.stage, config.provider));
      baseManifest.supplied = []; baseManifest.warnings = [];
      delete baseManifest.suppliedAt; delete baseManifest.preparedAt; delete baseManifest.preparationError;
      checkBaseRevocations(baseManifest, state.base.resources, state.base.approvedRoots);
      const workspace = await this.ensureTaskWorktree(taskId);
      if (workspace.path !== session.workspacePath) throw conflict('The saved conversation belongs to another workspace. Start a fresh run instead.', 'SESSION_WORKSPACE_MISMATCH');
      const run = await this.store.update(draft => {
        const current = this.#task(draft, taskId).task, saved = draft.sessions.find(item => item.id === session.id);
        if (this.#activeRun(draft, taskId) || current.sessionId !== session.id || saved?.currentRunId !== previous.id || saved.status !== session.status || current.column !== task.column || current.contentRevision !== task.contentRevision) throw conflict('This task or conversation changed. Reload before resuming.', 'REVISION_CONFLICT');
        checkBaseRevocations(baseManifest, draft.base.resources, draft.base.approvedRoots);
        const id = randomUUID(), now = Date.now();
        const record = { id, taskId, projectId: project.id, stage: previous.stage, status: 'queued', createdAt: now, updatedAt: now,
          promptRevision: previous.promptRevision, config, trigger: 'user', workspacePath: workspace.path, branch: workspace.branch,
          artifactsDir: join('runs', id), turns: 0, providerSessionId: nativeSessionId,
          resumeFrom: { runId: previous.id, nativeSessionId },
          baseManifest: { ...structuredClone(baseManifest), acceptedAt: now, deliveryState: 'configured' },
          ...(previous.review ? { review: structuredClone(previous.review) } : {}), ...(previous.planRunId ? { planRunId: previous.planRunId } : {}) };
        draft.runs.push(record); attachResumedRun(draft, record, saved);
        const ap = this.#project(draft, project.id).autopilot;
        if (ap?.status === 'paused' && ap.current?.runId === previous.id) { ap.current.runId = id; ap.current.step = 'running'; }
        return record;
      });
      await this.executor.start({ run, task: { id: task.id, title: task.title, prompt: task.prompt }, workspace, continuation: message });
      return run;
    });
  }

  /** With `move`, the card enters the stage in the same write that records the run (see transition). */
  async #startRun(taskId, { stage, consent = false, config = {}, trigger = 'user', move = null, note = '' } = {}) {
    {
      let state = await this.state();
      let { project, task } = this.#task(state, taskId);
      if (project.workflowMode === 'pipeline') {
        if (consent !== true) throw new BoardError('Starting an agent needs your explicit confirmation.', 'CONSENT_REQUIRED');
        if (Object.keys(config || {}).length) throw new BoardError('Configure the pipeline agent in Column Manager before starting it.', 'PIPELINE_SETTINGS_REQUIRED');
        return this.#pipelineStart(taskId, { column: stage, move, trigger });
      }
      const column = projectColumns(project).find(item => item.id === stage);
      if (!column) throw new BoardError('Choose a valid stage.', 'INVALID_COLUMN');
      if (!column.agent) throw new BoardError(`${column.title} never runs an agent.`, 'STAGE_NOT_RUNNABLE');
      if (!move && task.column !== stage) throw conflict(`The card is in ${title(task.column)}, not ${column.title}.`, 'STAGE_MISMATCH');
      if (this.#activeRun(state, taskId)) throw conflict('This card already has an active run.', 'RUN_ACTIVE');
      if (consent !== true) throw new BoardError('Starting an agent needs your explicit confirmation.', 'CONSENT_REQUIRED');
      if (!project.repository) throw new BoardError('Link this project to a Git repository first.', 'REPOSITORY_REQUIRED', 409);
      if (!this.executor) throw new BoardError('Agent execution is not available. Cards can be planned and moved, but no agent runs.', 'EXECUTION_UNAVAILABLE', 503);
      await this.#defaultTargetBranch(taskId);
      state = await this.state();
      ({ project, task } = this.#task(state, taskId));
      if (!project.targetBranch) throw new BoardError('Choose the local target branch first.', 'TARGET_BRANCH_REQUIRED', 409);
      if (!EXECUTABLE_STAGES.has(stage) && !column.custom) throw conflict(`${column.title} runs are not available yet.`, 'STAGE_NOT_IMPLEMENTED');
      // Explicit request values override the project's workflow settings for this run only.
      const settings = effectiveWorkflow(project, state.settings.defaultAgent, state)[stage];
      const merged = this.#requestedAgent(settings, config);
      if (typeof merged.instructions !== 'string' || merged.instructions.length > 4000) throw new BoardError('Stage instructions can have at most 4,000 characters.', 'INVALID_WORKFLOW');
      const resolved = { ...(await this.executor.validate({ stage, config: merged })), instructions: merged.instructions };
      const baseManifest = this.#basePreflight(state, project, task, stage, resolved.provider);
      if (!WORKSPACE_STAGES.has(stage) && !column.custom && task.workspace?.status !== 'ready') throw new BoardError('Run Planning or Executing first to create the task worktree.', 'WORKSPACE_REQUIRED', 409);
      const workspace = await this.ensureTaskWorktree(taskId);
      const plan = stage === 'executing' ? this.#approvedPlan(state, task) : null;
      // Review reads the actual diff of a clean, committed revision. Executing gets requested fixes.
      const review = stage === 'code_review' ? await this.delivery.reviewContext(taskId) : null;
      // Testing gets the configured test commands; Merge first brings the target branch in
      // (git merge --no-commit), leaving any conflicts for the agent to resolve.
      const merge = stage === 'merge' ? await this.delivery.prepareMergeRun(taskId) : null;
      const testing = stage === 'testing' ? await this.delivery.testingContext(taskId) : '';
      const restart = ['planning', 'executing'].includes(stage) && task.restartNote ? `=== WHY THE PREVIOUS ATTEMPT WAS DISCARDED ===\n${task.restartNote}\n=== END ===` : '';
      const result = task.stageResults?.executing;
      const execution = ['code_review', 'testing'].includes(stage) && result?.promptRevision === (task.contentRevision ?? 1) && result;
      const executionContext = execution ? `=== EXECUTION RESULTS FOR THIS TASK (${task.id}, run ${execution.runId}) ===\n${execution.summary}\n=== END EXECUTION RESULTS ===` : '';
      const extra = [review ? review.text : merge ? merge.text : testing || (stage === 'executing' && task.reworkNotes ? `=== REVIEW FINDINGS TO FIX ===\n${task.reworkNotes}\n=== END FINDINGS ===` : ''), executionContext, restart, note].filter(Boolean).join('\n\n');
      const run = await this.store.update(draft => {
        if (this.#activeRun(draft, taskId)) throw conflict('This card already has an active run.', 'RUN_ACTIVE');
        const current = this.#task(draft, taskId);
        if ((draft.base?.revision || 0) !== (state.base?.revision || 0)) throw conflict('Base changed while the run was being prepared. Start again to use the current selection.', 'BASE_REVISION_CONFLICT');
        if ((current.task.contentRevision ?? 1) !== (task.contentRevision ?? 1)) throw conflict('The task text changed while the run was being prepared. Start again.', 'REVISION_CONFLICT');
        if (JSON.stringify(this.#requestedAgent(effectiveWorkflow(current.project, draft.settings.defaultAgent, draft)[stage], config)) !== JSON.stringify(merged)) throw conflict('Agent settings changed while the run was being prepared. Start again.', 'REVISION_CONFLICT');
        const now = Date.now();
        const id = randomUUID();
        const record = { id, taskId, projectId: project.id, stage, status: 'queued', createdAt: now, updatedAt: now,
          promptRevision: task.contentRevision ?? 1, config: resolved, trigger: trigger === 'automation' ? 'automation' : 'user', workspacePath: workspace.path, branch: workspace.branch,
          planRunId: plan?.runId || null, artifactsDir: join('runs', id), turns: 0, baseManifest: { ...baseManifest, acceptedAt: now, deliveryState: 'configured' },
          ...(plan ? { planBaseChanged: baseSignature(draft.runs.find(item => item.id === plan.runId)?.baseManifest) !== baseSignature(baseManifest) } : {}),
          ...(review ? { review: { taskCommit: review.taskCommit, targetCommit: review.targetCommit } } : {}),
          ...(move ? { transition: { id: move.transitionId, from: move.from } } : {}) };
        if (move) this.#place(draft, taskId, { ...move, runId: id });
        draft.runs.push(record);
        attachSession(draft, record);
        // The reason for a start over goes to the new attempt's first Executing run only.
        if (stage === 'executing' && restart) this.#task(draft, taskId).task.restartNote = '';
        return record;
      });
      await this.executor.start({ run, task: { id: task.id, title: task.title, prompt: task.prompt }, workspace, planRunId: plan?.runId || null, extra });
      return run;
    }
  }

  /** Main-session pipeline moves. Names carry no review, commit, test, or merge action. */
  async #pipelineTransition(taskId, request) {
    const state = await this.state(), { project, task } = this.#task(state, taskId);
    const transitionId = request.transitionId || randomUUID(), key = { projectId: project.id, taskId, transitionId };
    if (request.transitionId) {
      const previous = await this.automationJournal.read(key);
      if (previous) return { task, duplicate: true, automationMove: previous };
    }
    if (task.column === request.column) return this.#pipelineLifecycleTransition(taskId, request);
    checkRevision(task, request.expectedRevision, 'This card');
    const from = project.pipeline.columns.find(column => column.id === task.column), to = project.pipeline.columns.find(column => column.id === request.column);
    if (!to) throw new BoardError('Choose a valid column.', 'INVALID_COLUMN');
    if (to.role === 'active' && from?.role !== 'active') this.#checkPrerequisites(project, task);
    const onExit = request.initialArrival ? [] : from.automations.onExit, onEnter = to.automations.onEnter;
    if (task.automationMove && !['completed', 'failed', 'cancelled', 'interrupted'].includes(task.automationMove.status)) throw conflict('Stop or resolve this card’s existing automation move first.', 'AUTOMATION_MOVE_ACTIVE');
    if (!onExit.length && !onEnter.length) return this.#pipelineLifecycleTransition(taskId, request);
    if (this.automationsStopping) throw conflict('The application is shutting down. No column automation was started.', 'AUTOMATIONS_SHUTTING_DOWN');
    if (request.signal?.aborted) throw conflict('The automatic plan move was cancelled.', 'PLAN_ROUTE_CANCELLED');
    if (request.expectedProjectRevision != null && project.revision !== request.expectedProjectRevision) throw conflict('The board settings changed after this move was requested.', 'REVISION_CONFLICT');
    if (project.pipelineImport) throw conflict('Review and save the imported board configuration before running its automations.', 'PIPELINE_IMPORT_PENDING');
    if (onExit.some(row => row.enabled && row.type === 'send_message') || onEnter.some(row => row.enabled && row.type === 'send_message' && row.mode !== 'deferred'))
      throw conflict('Agent messages currently support deferred delivery on entry only.', 'PIPELINE_FEATURE_PENDING');
    const active = this.#activeRun(state, taskId), controller = new AbortController();
    if (request.requiredRunId && active?.id !== request.requiredRunId) throw conflict('The approved conversation was stopped or replaced. The automatic move was cancelled.', 'PLAN_ROUTE_CANCELLED');
    if (request.requiredApproval && JSON.stringify(active?.activity?.planApproval) !== JSON.stringify(request.requiredApproval)) throw conflict('Native plan approval changed before the move.', 'PLAN_APPROVAL_STALE');
    const signal = AbortSignal.any([controller.signal, ...(request.signal ? [request.signal] : [])]);
    const { promise: done, resolve: settled } = Promise.withResolvers();
    const job = { key, controller, activeRunId: active?.id, queuedHold: null, blocked: false, deferNativeStart: true, done };
    if (active?.status === 'queued' && this.executor?.holdQueued) job.queuedHold = this.executor.holdQueued(active.id);
    this.automationMoves.set(taskId, job);
    let moveCreated = false, groupEntered = false, lifecycleGranted = false, lifecycleFinished = false;
    try {
      signal.throwIfAborted();
      const created = await this.automationJournal.beginMove({ ...key, taskRevision: task.revision, projectRevision: project.revision,
        from: { id: from.id, name: from.name }, to: { id: to.id, name: to.name }, onExit, onEnter });
      if (!created.created) return { task: await this.#taskNow(taskId), duplicate: true, automationMove: created.move };
      moveCreated = true;
      await this.store.update(draft => {
        const current = this.#task(draft, taskId); checkRevision(current.task, request.expectedRevision, 'This card');
        if (current.project.revision !== project.revision) throw conflict('The board changed before automation acceptance.', 'REVISION_CONFLICT');
        current.task.automationMoves = [...(current.task.automationMoves || []), key].slice(-100);
        current.task.automationMove = { ...key, status: 'pending', phase: 'exit' };
      });
      const context = await this.#automationContext(taskId, onExit, { task, project }, request);
      groupEntered = true;
      const exits = await this.automations.runGroup({ key, trigger: 'exit', rows: onExit, context, signal,
        onProgress: () => this.#publishAutomationMove(key) });
      if (!exits.safeToAdvance) {
        job.blocked = !exits.cancelled || this.#automationWorkOwned(key);
        if (!job.blocked) await this.automationJournal.cancelMove(key);
        await this.#publishAutomationMove(key, job.blocked ? 'blocked' : null);
        throw conflict(job.blocked ? 'Automation cleanup is unconfirmed. Stop its owned work before moving this card.' : 'This automation move was cancelled.', job.blocked ? 'AUTOMATION_CLEANUP_UNCONFIRMED' : 'AUTOMATION_MOVE_CANCELLED');
      }
      signal.throwIfAborted();
      await this.automationJournal.advance(key);
      lifecycleGranted = await this.automationJournal.startLifecycle(key);
      if (!lifecycleGranted) throw conflict('The session lifecycle already has an owner. It cannot be replayed.', 'AUTOMATION_LIFECYCLE_OWNED');
      await this.#publishAutomationMove(key);
      const fresh = await this.state(), current = this.#task(fresh, taskId);
      checkRevision(current.task, request.expectedRevision, 'This card');
      if (current.project.revision !== project.revision) throw conflict('The board changed during exit automations.', 'REVISION_CONFLICT');
      const result = await this.#pipelineLifecycleTransition(taskId, { ...request, transitionId, signal });
      if (!(await this.automationJournal.finishLifecycle(key, { status: 'succeeded' }))) throw conflict('The lifecycle save was not acknowledged. No enter automation may run.', 'AUTOMATION_LIFECYCLE_UNSAVED');
      lifecycleFinished = true;
      await this.#publishAutomationMove(key);
      const entered = this.#task(await this.state(), taskId);
      const enterContext = await this.#automationContext(taskId, onEnter, entered);
      const enters = await this.automations.runGroup({ key, trigger: 'enter', rows: onEnter, context: enterContext, signal,
        canMessage: to.role === 'active' && Boolean(this.#activeRun(await this.state(), taskId)),
        suppressMessages: from.role === 'done', onProgress: () => this.#publishAutomationMove(key) });
      if (!enters.safeToAdvance) {
        job.blocked = !enters.cancelled || this.#automationWorkOwned(key);
        if (!job.blocked) await this.automationJournal.cancelMove(key);
        await this.#publishAutomationMove(key, job.blocked ? 'blocked' : null);
        throw conflict(job.blocked ? 'Automation cleanup is unconfirmed. Stop its owned work before moving this card.' : 'The remaining enter automations were cancelled.', job.blocked ? 'AUTOMATION_CLEANUP_UNCONFIRMED' : 'AUTOMATION_MOVE_CANCELLED');
      }
      signal.throwIfAborted();
      await this.#automationContext(taskId, [], entered);
      await this.automationJournal.advance(key);
      await this.#publishAutomationMove(key);
      const pending = [...this.deferredPipelineStarts.entries()].filter(([, payload]) => payload.run.taskId === taskId);
      for (const [runId, payload] of pending) {
        signal.throwIfAborted();
        if ((await this.run(runId)).status === 'queued') await this.executor.start(payload);
        this.deferredPipelineStarts.delete(runId);
      }
      return { ...result, task: await this.#taskNow(taskId), automationMove: await this.automationJournal.read(key) };
    } catch (error) {
      if (!job.blocked) {
        try {
          if (lifecycleGranted && !lifecycleFinished) await this.automationJournal.finishLifecycle(key, { status: signal.aborted ? 'cancelled' : 'failed', reason: 'The session lifecycle stopped before its outcome was confirmed.' });
          else if (moveCreated) {
            this.messageScheduler?.cancelTask(taskId);
            await this.messageScheduler?.waitTask(taskId);
            await this.automationJournal.cancelMove(key);
          }
          await this.#publishAutomationMove(key);
        } catch { job.blocked = groupEntered || lifecycleGranted; await this.#publishAutomationMove(key, 'blocked').catch(() => {}); }
        for (const [runId, payload] of this.deferredPipelineStarts) if (payload.run.taskId === taskId) {
          await Promise.resolve(this.executor?.cancel?.(runId, { withinAutomationMove: transitionId })).catch(() => {});
          this.deferredPipelineStarts.delete(runId);
        }
      }
      throw error;
    } finally {
      if (!job.blocked) {
        if (job.queuedHold) this.executor?.releaseQueued?.(job.activeRunId, job.queuedHold);
        if (this.automationMoves.get(taskId) === job) this.automationMoves.delete(taskId);
      }
      settled();
    }
  }

  async #automationContext(taskId, rows, snapshot, request = {}) {
    const { project, task } = structuredClone(snapshot);
    const checkCurrent = async () => {
      const state = await this.state(), current = this.#task(state, taskId);
      checkRevision(current.task, task.revision, 'This card');
      if (current.project.revision !== project.revision) throw conflict('The board changed before its automation group.', 'REVISION_CONFLICT');
      const active = this.#activeRun(state, taskId);
      if (request.requiredRunId && active?.id !== request.requiredRunId) throw conflict('The approved conversation was stopped or replaced before its exit actions.', 'PLAN_ROUTE_CANCELLED');
      if (request.requiredApproval && JSON.stringify(active?.activity?.planApproval) !== JSON.stringify(request.requiredApproval)) throw conflict('Native plan approval changed before its exit actions.', 'PLAN_APPROVAL_STALE');
    };
    await checkCurrent();
    if (!rows.some(row => row.enabled && row.type === 'run_script')) return { task, project, cwd: null };
    const repository = await this.#checkedRepository(project);
    let cwd = repository.root;
    if (task.workspace) {
      const ws = task.workspace, registered = await this.#registered(repository.root, ws.path);
      if (ws.status !== 'ready' || ws.repositoryRoot !== repository.root || ws.commonDir !== repository.commonDir || !registered || registered.branch !== ws.branch || !(await stat(ws.path).catch(() => null))?.isDirectory()) throw conflict('The automation worktree is missing or is on another branch. Restore its recorded workspace before running scripts.', 'AUTOMATION_WORKSPACE_UNAVAILABLE');
      cwd = ws.path;
    }
    await checkCurrent();
    return { task, project, cwd };
  }

  #automationWorkOwned(key) {
    const group = this.automations.jobs.get(JSON.stringify([key.projectId, key.taskId]));
    return Boolean(group && [...group.started].some(id => this.automations.actions.jobs.has(id)));
  }

  #requireAutomationsStopped(task) {
    if (this.automationMoves.has(task.id) || task.pendingAutomationMessages?.length
      || task.automationMove && !['completed', 'failed', 'cancelled', 'interrupted'].includes(task.automationMove.status)) throw conflict('Stop or resolve this card’s column automations before removing its task, project or workspace, or recording a separate completion.', 'AUTOMATIONS_ACTIVE');
  }

  async #scheduleColumnMessage(request, options) {
    if (this.automationsStopping || typeof this.executor?.sendNativeMessage !== 'function') return { scheduled: false };
    const state = await this.state(), current = this.#task(state, request.taskId), run = this.#activeRun(state, request.taskId);
    if (!run || current.project.id !== request.projectId || request.key.taskId !== request.taskId || request.key.projectId !== request.projectId)
      return { scheduled: false };
    // Publish the recovery reference before a scheduler can grant native input.
    await this.store.update(draft => {
      const { task, project } = this.#task(draft, request.taskId);
      checkRevision(task, request.expectedTaskRevision, 'This card');
      checkRevision(project, request.expectedProjectRevision, 'This project');
      if (this.#activeRun(draft, task.id)?.id !== run.id) throw conflict('The message target changed before scheduling.', 'MESSAGE_TARGET_CHANGED');
      const pending = task.pendingAutomationMessages ||= [];
      if (!pending.some(key => key.transitionId === request.key.transitionId)) {
        if (pending.length >= 1000) throw conflict('Stop or resolve earlier message deliveries before scheduling more.', 'MESSAGE_QUEUE_FULL');
        pending.push(structuredClone(request.key));
      }
    });
    this.messageScheduler ||= new NativeMessageScheduler({ board: this, journal: this.automationJournal, supervisor: this.executor });
    const result = await this.messageScheduler.schedule({ ...request, runId: run.id }, options);
    this.messageScheduler.wait(request.key, request.actionId).then(() => this.#publishAutomationMove(request.key)).catch(() => {});
    return result;
  }

  async #publishAutomationMove(key, status = null) {
    const move = await this.automationJournal.read(key);
    if (!move) return;
    await this.store.update(state => {
      const task = this.#task(state, key.taskId).task;
      if (!move.actions.some(action => action.delivery && ['queued', 'dispatching', 'submitted', 'accepted'].includes(action.delivery.status)
        || action.type === 'send_message' && ['pending', 'running'].includes(action.status)))
        task.pendingAutomationMessages = (task.pendingAutomationMessages || []).filter(row => row.transitionId !== key.transitionId);
      if (task.automationMove?.transitionId !== key.transitionId) return;
      task.automationMove = { ...key, status: status || move.status, phase: move.phase, updatedAt: move.updatedAt };
    });
  }

  /** Revoke ongoing column work before waiting for task/run locks. */
  abortAutomationTask(taskId, { exceptTransitionId = null } = {}) {
    const messages = this.messageScheduler?.cancelTask(taskId, { exceptTransitionId }) || false;
    const job = this.automationMoves.get(taskId);
    if (!job || job.key.transitionId === exceptTransitionId) return messages;
    job.controller.abort('automation stopped'); this.automations.cancel(job.key);
    return true;
  }

  async automationRuns(taskId) {
    const task = this.#task(await this.state(), taskId).task;
    const moves = [];
    const keys = [...(task.automationMoves || [])];
    for (const key of task.pendingAutomationMessages || []) if (!keys.some(row => row.transitionId === key.transitionId)) keys.push(key);
    for (const key of keys) {
      const move = await this.automationJournal.read(key);
      if (!move) throw conflict('This automation history is unavailable. It cannot be replayed.', 'AUTOMATION_JOURNAL_MISSING');
      moves.push(move);
    }
    return moves.sort((left, right) => left.createdAt - right.createdAt);
  }

  async cancelAutomationMove(taskId, { confirm = false } = {}) {
    if (confirm !== true) throw new BoardError('Confirm stopping this card’s automations.', 'CONFIRMATION_REQUIRED');
    this.abortAutomationTask(taskId);
    return this.#locked(`run:${taskId}`, async () => {
      const task = this.#task(await this.state(), taskId).task, job = this.automationMoves.get(taskId);
      await this.messageScheduler?.waitTask(taskId);
      for (const pending of task.pendingAutomationMessages || []) await this.#publishAutomationMove(pending);
      const key = job?.key || (task.automationMove && { projectId: task.automationMove.projectId, taskId, transitionId: task.automationMove.transitionId });
      if (!key) return task;
      const group = this.automations.jobs.get(JSON.stringify([key.projectId, taskId]));
      if (group) this.automations.cancel(key);
      for (const id of group?.started || []) await this.automations.actions.stop?.(id);
      if (group && [...group.started].some(id => this.automations.actions.jobs.has(id))) throw conflict('An owned script has not confirmed termination. Stop again after cleanup; no move will be replayed.', 'AUTOMATION_CLEANUP_UNCONFIRMED');
      const move = await this.automationJournal.read(key);
      if (!move) throw conflict('This automation journal is missing. No owned work or move can be inferred from it.', 'AUTOMATION_JOURNAL_MISSING');
      if (move?.ownerPid !== process.pid) {
        await this.automationJournal.recoverInterrupted(key);
        const recovered = await this.automationJournal.read(key);
        if (recovered?.phase !== 'complete') throw conflict('This move belongs to another live application process.', 'AUTOMATION_OWNER_ACTIVE');
      } else if (move && move.phase !== 'complete') {
        for (const action of move.actions.filter(row => row.status === 'running')) await this.automationJournal.finishAction(key, action.id, { status: 'unconfirmed', reason: 'Owned work stopped without a confirmed result. It will not be replayed.' });
        if (move.lifecycle.status === 'running') await this.automationJournal.finishLifecycle(key, { status: 'cancelled', reason: 'The lifecycle stopped without a confirmed result. It will not be replayed.' });
        else await this.automationJournal.cancelMove(key);
      }
      for (const [runId, payload] of this.deferredPipelineStarts) if (payload.run.taskId === taskId) {
        await this.executor?.cancel?.(runId, { withinAutomationMove: key.transitionId }); this.deferredPipelineStarts.delete(runId);
      }
      await this.#publishAutomationMove(key);
      if (job?.queuedHold) this.executor?.releaseQueued?.(job.activeRunId, job.queuedHold);
      if (job) this.automationMoves.delete(taskId);
      return this.#taskNow(taskId);
    });
  }

  async shutdownAutomations() {
    this.automationsStopping = true;
    const jobs = [...this.automationMoves.values()];
    for (const job of jobs) job.controller.abort('shutdown');
    await this.messageScheduler?.shutdown();
    await this.automations.shutdown();
    await Promise.allSettled(jobs.map(job => job.done));
  }

  async #pipelineLifecycleTransition(taskId, { column, index, expectedRevision, transitionId, decision, trigger, continuation = '', requiredRunId = null, requiredApproval = null, expectedProjectRevision = null, signal = null }) {
    const state = await this.state(), { project, task } = this.#task(state, taskId);
    if (signal?.aborted) throw conflict('The automatic plan move was cancelled.', 'PLAN_ROUTE_CANCELLED');
    if (transitionId && task.lastTransition?.id === transitionId) return { task, duplicate: true };
    checkRevision(task, expectedRevision, 'This card');
    if (expectedProjectRevision !== null && project.revision !== expectedProjectRevision) throw conflict('The board settings changed after this move was requested.', 'REVISION_CONFLICT');
    const target = project.pipeline.columns.find(item => item.id === column);
    if (!target) throw new BoardError('Choose a valid column.', 'INVALID_COLUMN');
    const move = { from: task.column, column, index, transitionId: transitionId || randomUUID(), by: trigger === 'automation' ? 'automation' : 'user' };
    if (task.column === column) return { task: await this.#placeStored(taskId, move) };
    const active = this.#activeRun(state, taskId);
    if (requiredRunId && active?.id !== requiredRunId) throw conflict('The approved conversation was stopped or replaced. The automatic move was cancelled.', 'PLAN_ROUTE_CANCELLED');
    if (requiredApproval && JSON.stringify(active?.activity?.planApproval) !== JSON.stringify(requiredApproval)) throw conflict('Native plan approval changed before the move.', 'PLAN_APPROVAL_STALE');
    if (target.role !== 'active') {
      this.messageScheduler?.cancelTask(taskId);
      await this.messageScheduler?.waitTask(taskId);
      for (const key of task.pendingAutomationMessages || []) await this.#publishAutomationMove(key);
      if (active) {
        if (!this.executor) throw new BoardError('The owned agent cannot be stopped.', 'EXECUTION_UNAVAILABLE', 503);
        const withinAutomationMove = this.automationMoves.get(taskId)?.key.transitionId;
        if (target.role === 'done') await this.executor.suspend(active.id, { withinAutomationMove });
        else await this.executor.cancel(active.id, { withinAutomationMove });
      }
      const saved = await this.store.update(draft => {
        const current = this.#task(draft, taskId);
        checkRevision(current.task, expectedRevision, 'This card');
        if (current.project.revision !== project.revision || this.#activeRun(draft, taskId)) throw conflict('The board or agent changed during this move.', 'REVISION_CONFLICT');
        const result = this.#place(draft, taskId, move);
        if (target.role === 'todo') { result.sessionId = null; delete result.archivedAt; }
        else result.archivedAt = Date.now();
        return result;
      });
      return { task: saved };
    }
    const settings = effectiveWorkflow(project, state.settings.defaultAgent, state, task)[column];
    const strategy = resolvePipelineStrategy(project.pipeline, column, task);
    if (active) {
      if (!strategy.autoSpawn && decision !== 'start') {
        if (!this.executor?.suspend) throw new BoardError('The owned agent cannot be paused.', 'EXECUTION_UNAVAILABLE', 503);
        await this.executor.suspend(active.id, { withinAutomationMove: this.automationMoves.get(taskId)?.key.transitionId });
        const parked = await this.store.update(draft => {
          const current = this.#task(draft, taskId);
          checkRevision(current.task, expectedRevision, 'This card');
          if (current.project.revision !== project.revision || this.#activeRun(draft, taskId)) throw conflict('The board or agent changed while parking this card.', 'REVISION_CONFLICT');
          const result = this.#place(draft, taskId, move); delete result.archivedAt; return result;
        });
        return { task: parked, suspendedRunId: active.id };
      }
      const resolved = resolveConfig(column, settings);
      const manifest = this.#basePreflight(state, project, task, column, resolved.provider);
      // Native permissions can change inside the CLI (notably on plan approval).
      // Launch flags are historical; permission-only moves keep that live choice.
      // Empty model/effort overrides preserve the existing live settings.
      const changed = (active.status === 'queued'
        ? JSON.stringify(resolved) !== JSON.stringify(Object.fromEntries(Object.entries(active.config).filter(([key]) => key !== 'instructions')))
        : ['provider', 'pipeline', 'model', 'effort'].some(key => (key === 'model' || key === 'effort' ? Boolean(resolved[key]) : true) && resolved[key] !== active.config[key]))
        || baseSignature(manifest) !== baseSignature(active.baseManifest);
      if (changed && active.status === 'queued') {
        const run = await this.#pipelineRetargetQueued(taskId, { state, project, task, active, column, settings, move, expectedRevision });
        return { task: await this.#taskNow(taskId), run, retargetedRunId: run.id };
      }
      if (changed) {
        const run = await this.#pipelineReconfigureLive(taskId, { state, project, task, active, column, settings, move, expectedRevision, trigger, continuation, requiredApproval, signal });
        return { task: await this.#taskNow(taskId), run, resumedRunId: run.id };
      }
      const saved = await this.store.update(draft => {
        const current = this.#task(draft, taskId);
        checkRevision(current.task, expectedRevision, 'This card');
        if (current.project.revision !== project.revision || this.#activeRun(draft, taskId)?.id !== active.id || draft.base.revision !== state.base.revision) throw conflict('The board, agent, or Base selection changed during this move.', 'REVISION_CONFLICT');
        if (signal?.aborted) throw conflict('The automatic plan move was cancelled.', 'PLAN_ROUTE_CANCELLED');
        if (requiredApproval && JSON.stringify(draft.runs.find(run => run.id === active.id)?.activity?.planApproval) !== JSON.stringify(requiredApproval)) throw conflict('Native plan approval changed before accepting the move.', 'PLAN_APPROVAL_STALE');
        const result = this.#place(draft, taskId, { ...move, runId: active.id });
        delete result.archivedAt;
        return result;
      });
      return { task: saved, continuedRunId: active.id };
    }
    if (decision !== 'move' && (strategy.autoSpawn || decision === 'start')) {
      const run = await this.#pipelineStart(taskId, { column, move, trigger, expectedRevision, handoffSignal: signal });
      return { task: await this.#taskNow(taskId), run };
    }
    const saved = await this.store.update(draft => {
      const current = this.#task(draft, taskId);
      checkRevision(current.task, expectedRevision, 'This card');
      if (current.project.revision !== project.revision || this.#activeRun(draft, taskId)) throw conflict('This board or agent changed during the move.', 'REVISION_CONFLICT');
      const result = this.#place(draft, taskId, move); delete result.archivedAt; return result;
    });
    return { task: saved };
  }

  async #pipelineReconfigureLive(taskId, { state, project, task, active, column, settings, move, expectedRevision, trigger, continuation = '', requiredApproval = null, signal = null }) {
    if (!this.executor?.suspendAtBoundary || settings.provider !== active.config.provider) throw conflict('Pause this agent before switching providers. Native conversation handoff is not available yet.', 'PIPELINE_RECONFIGURE_REQUIRED');
    const saved = state.sessions.find(item => item.id === task.sessionId && item.currentRunId === active.id);
    if (!saved?.nativeSessionId) throw conflict('This live agent has not captured a native conversation ID. Wait for startup or pause it before changing settings.', 'SESSION_NOT_RESUMABLE');
    const nativeSessionId = validateResumeId(saved.nativeSessionId);
    if (active.promptRevision !== (task.contentRevision ?? 1)) throw conflict('The task text changed after this conversation. Pause it and start a fresh run to supply the new text.', 'SESSION_PROMPT_STALE');
    if (saved.workspacePath !== task.workspace?.path || active.workspacePath !== saved.workspacePath) throw conflict('The conversation belongs to another workspace.', 'SESSION_WORKSPACE_MISMATCH');
    const guard = draft => {
      const current = this.#task(draft, taskId), session = draft.sessions.find(item => item.id === saved.id);
      checkRevision(current.task, expectedRevision ?? task.revision, 'This card');
      if (current.project.revision !== project.revision || current.task.column !== task.column || current.task.contentRevision !== task.contentRevision
        || current.task.workspace?.path !== task.workspace?.path || current.task.sessionId !== saved.id || session?.currentRunId !== active.id
        || session.nativeSessionId !== nativeSessionId || this.#activeRun(draft, taskId)?.id !== active.id
        || draft.base.revision !== state.base.revision || JSON.stringify(draft.settings.defaultAgent) !== JSON.stringify(state.settings.defaultAgent)) throw conflict('The task, agent settings, or Base changed while waiting for the current turn.', 'REVISION_CONFLICT');
    };
    return this.executor.suspendAtBoundary(active.id, { guard, currentGuard: () => guard(this.store.state), requiredApproval, signal,
      prepare: () => this.executor.validate({ stage: column, config: settings }),
      resume: handoffSignal => this.#pipelineStart(taskId, { column, move, trigger, expectedRevision: expectedRevision ?? task.revision, requireResume: true, acceptance: state, handoffSignal, continuation }) });
  }

  /** Supervisor-only native approval. Its persisted observation is the gate, never task prose or a turn end. */
  async routeApprovedPlan(runId, approval, { signal = null } = {}) {
    const observed = await this.run(runId);
    return this.#locked(`transition:${observed.taskId}`, () => this.#locked(`run:${observed.taskId}`, async () => {
      const state = await this.state(), run = state.runs.find(item => item.id === runId);
      const { project, task } = this.#task(state, run.taskId);
      const key = JSON.stringify(approval);
      if (!['claude', 'gemini'].includes(approval?.provider) || approval.provider !== run.config.provider
        || approval.source !== (approval.provider === 'claude' ? 'PostToolUse' : 'AfterTool') || !Number.isSafeInteger(approval.at)
        || JSON.stringify(run.activity?.planApproval) !== key || !run.config.pipeline || project.workflowMode !== 'pipeline') throw conflict('Native plan approval has not been observed for this run.', 'PLAN_APPROVAL_NOT_OBSERVED');
      const existing = run.planRoutes?.find(route => JSON.stringify(route.approval) === key);
      if (existing) return existing; // Failed/interrupted actions also require an explicit move, never replay.
      if ((run.planRoutes?.length || 0) >= 50) throw conflict('This run reached its automatic plan-route history limit. Move the card explicitly.', 'PLAN_ROUTE_LIMIT');
      const session = state.sessions.find(item => item.id === task.sessionId && item.currentRunId === runId);
      let reason = !session || this.#activeRun(state, task.id)?.id !== runId ? 'This approval belongs to an inactive conversation.'
        : run.promptRevision !== (task.contentRevision ?? 1) ? 'The task changed after this conversation started.' : '';
      const targetId = reason ? null : resolvePipelineStrategy(project.pipeline, task.column, task).planExitTargetId;
      reason ||= !targetId ? 'No plan exit target is configured for this column.' : '';
      const route = { id: randomUUID(), approval: structuredClone(approval), fromColumn: task.column, toColumn: targetId,
        status: reason ? 'ignored' : 'pending', createdAt: Date.now(), taskRevision: task.revision, ...(reason ? { reason, endedAt: Date.now() } : {}) };
      await this.updateRun(runId, { planRoutes: [...(run.planRoutes || []), route] });
      if (reason) return route;
      try {
        const result = await this.#pipelineTransition(task.id, { column: targetId, expectedRevision: task.revision,
          transitionId: route.id, trigger: 'automation', continuation: 'Proceed with implementing the approved plan.', requiredRunId: runId, requiredApproval: approval, expectedProjectRevision: project.revision, signal });
        Object.assign(route, { status: 'completed', endedAt: Date.now(), ...(result.run ? { destinationRunId: result.run.id } : {}) });
      } catch (error) {
        Object.assign(route, { status: 'failed', endedAt: Date.now(), errorCode: clip(error.code || 'PLAN_ROUTE_FAILED', 64),
          reason: clip(error.status ? error.message : 'The approved plan could not be routed. Move the card explicitly.', 500) });
      }
      // If this save fails, the pending record still prevents replay. Recovery
      // marks it interrupted even when its process already ended or resumed.
      await this.updateRun(runId, { planRoutes: [...(run.planRoutes || []), route] });
      return route;
    }));
  }

  async #pipelineRetargetQueued(taskId, { state, project, task, active, column, settings, move, expectedRevision }) {
    if (!this.executor?.retargetQueued) throw conflict('Pause this queued agent before changing its destination settings.', 'PIPELINE_RECONFIGURE_REQUIRED');
    return this.executor.retargetQueued(active.id, async () => {
      const config = { ...await this.executor.validate({ stage: column, config: settings }), pipeline: true, instructions: '' };
      if (active.resumeFrom && config.provider !== active.config.provider) throw conflict('Pause this queued native resume before switching providers.', 'PIPELINE_RECONFIGURE_REQUIRED');
      const manifest = this.#basePreflight(state, project, task, column, config.provider);
      const run = await this.store.update(draft => {
        const current = this.#task(draft, taskId), record = draft.runs.find(item => item.id === active.id);
        checkRevision(current.task, expectedRevision, 'This card');
        if (current.project.revision !== project.revision || current.task.column !== task.column || record?.status !== 'queued'
          || this.#activeRun(draft, taskId)?.id !== active.id || current.task.sessionId !== active.sessionId
          || record.promptRevision !== (current.task.contentRevision ?? 1) || current.task.workspace?.path !== active.workspacePath
          || draft.base.revision !== state.base.revision || JSON.stringify(draft.settings.defaultAgent) !== JSON.stringify(state.settings.defaultAgent)) throw conflict('The task, queue, settings or Base changed during retargeting.', 'REVISION_CONFLICT');
        const session = draft.sessions.find(item => item.id === record.sessionId);
        if (!session || session.currentRunId !== record.id || (!record.resumeFrom && session.nativeSessionId)) throw conflict('This queued conversation has changed.', 'REVISION_CONFLICT');
        const now = Date.now();
        Object.assign(record, { stage: column, config, updatedAt: now, transition: { id: move.transitionId, from: move.from },
          baseManifest: { ...manifest, acceptedAt: now, deliveryState: 'configured' } });
        if (record.resumeFrom) record.baseChanged = baseSignature(manifest) !== baseSignature(draft.runs.find(item => item.id === record.resumeFrom.runId)?.baseManifest);
        Object.assign(session, { provider: config.provider, config: structuredClone(config), updatedAt: now });
        const result = this.#place(draft, taskId, { ...move, runId: record.id }); delete result.archivedAt;
        return record;
      });
      return { run, payload: { task: { id: task.id, title: task.title, prompt: task.prompt },
        firstPrompt: renderPipelineSpawnPrompt({ task, project }) } };
    }, { hold: this.automationMoves.get(taskId)?.queuedHold });
  }

  async #pipelineStart(taskId, { column, move = null, trigger = 'user', expectedRevision, requireResume = false, continuation = '', acceptance = null, handoffSignal = null } = {}) {
    const checkHandoff = () => {
      if (handoffSignal?.aborted) throw conflict('The settings handoff was cancelled or expired. The saved conversation and files are kept.', handoffSignal.reason?.name === 'TimeoutError' ? 'PIPELINE_BOUNDARY_TIMEOUT' : 'PIPELINE_RECONFIGURE_CANCELLED');
    };
    checkHandoff();
    let state = await this.state(), { project, task } = this.#task(state, taskId);
    if (acceptance && (acceptance.projects.find(item => item.id === project.id)?.revision !== project.revision || acceptance.base.revision !== state.base.revision
      || JSON.stringify(acceptance.settings.defaultAgent) !== JSON.stringify(state.settings.defaultAgent))) throw conflict('The board or Base changed during the settings handoff. The original conversation is paused and kept.', 'REVISION_CONFLICT');
    const target = project.pipeline.columns.find(item => item.id === column);
    if (target?.role !== 'active') throw new BoardError('Only active columns run agents.', 'STAGE_NOT_RUNNABLE');
    if (!move && task.column !== column) throw conflict('Move this card to the requested column first.', 'STAGE_MISMATCH');
    if (expectedRevision !== undefined) checkRevision(task, expectedRevision, 'This card');
    if (this.#activeRun(state, taskId)) throw conflict('This card already has an active run.', 'RUN_ACTIVE');
    if (!project.repository) throw new BoardError('Link this project to a Git repository first.', 'REPOSITORY_REQUIRED', 409);
    if (!this.executor) throw new BoardError('Agent execution is not available.', 'EXECUTION_UNAVAILABLE', 503);
    await this.#defaultTargetBranch(taskId);
    state = await this.state(); ({ project, task } = this.#task(state, taskId));
    if (acceptance && (acceptance.projects.find(item => item.id === project.id)?.revision !== project.revision || acceptance.base.revision !== state.base.revision
      || JSON.stringify(acceptance.settings.defaultAgent) !== JSON.stringify(state.settings.defaultAgent))) throw conflict('The board or Base changed during the settings handoff. The original conversation is paused and kept.', 'REVISION_CONFLICT');
    const settings = effectiveWorkflow(project, state.settings.defaultAgent, state, task)[column];
    let onAbort;
    const validation = Promise.resolve().then(() => this.executor.validate({ stage: column, config: settings }));
    let resolved;
    try {
      resolved = await (handoffSignal ? Promise.race([validation, new Promise((_, reject) => {
        onAbort = () => { try { checkHandoff(); } catch (error) { reject(error); } };
        handoffSignal.addEventListener('abort', onAbort, { once: true }); if (handoffSignal.aborted) onAbort();
      })]) : validation);
    } finally { if (onAbort) handoffSignal.removeEventListener('abort', onAbort); }
    checkHandoff();
    const config = { ...resolved, pipeline: true, instructions: '' };
    const baseManifest = this.#basePreflight(state, project, task, column, config.provider);
    const saved = state.sessions.find(item => item.id === task.sessionId && item.taskId === taskId);
    const previous = saved && state.runs.find(item => item.id === saved.currentRunId);
    const resume = saved?.nativeSessionId && saved.provider === config.provider && previous?.promptRevision === (task.contentRevision ?? 1)
      && ['suspended', 'orphaned', 'exited'].includes(saved.status) && previous.config.pipeline === true;
    const nativeSessionId = resume ? validateResumeId(saved.nativeSessionId) : null;
    if (requireResume && !resume) throw conflict('This task has no unchanged native conversation to resume.', 'SESSION_NOT_RESUMABLE');
    const workspace = await this.ensureTaskWorktree(taskId);
    if (resume && workspace.path !== saved.workspacePath) throw conflict('The conversation belongs to another workspace.', 'SESSION_WORKSPACE_MISMATCH');
    const firstPrompt = renderPipelineSpawnPrompt({ task: { ...task, workspace }, project });
    const run = await this.store.update(draft => {
      checkHandoff();
      const current = this.#task(draft, taskId), session = saved && draft.sessions.find(item => item.id === saved.id);
      if (handoffSignal && acceptance) checkRevision(current.task, expectedRevision, 'This card');
      if (this.#activeRun(draft, taskId) || current.project.revision !== project.revision || current.task.contentRevision !== task.contentRevision || current.task.column !== task.column
        || current.task.workspace?.path !== workspace.path
        || draft.base.revision !== state.base.revision || JSON.stringify(draft.settings.defaultAgent) !== JSON.stringify(state.settings.defaultAgent)
        || current.task.sessionId !== task.sessionId || (resume && session?.currentRunId !== previous.id)) throw conflict('The task, agent settings, or Base changed while the run was prepared.', 'REVISION_CONFLICT');
      const now = Date.now(), id = randomUUID();
      const record = { id, taskId, projectId: project.id, stage: column, status: 'queued', createdAt: now, updatedAt: now,
        promptRevision: task.contentRevision ?? 1, config, trigger, workspacePath: workspace.path, branch: workspace.branch,
        artifactsDir: join('runs', id), turns: 0,
        baseManifest: { ...baseManifest, acceptedAt: now, deliveryState: 'configured' },
        ...(resume ? { providerSessionId: nativeSessionId, resumeFrom: { runId: previous.id, nativeSessionId }, baseChanged: baseSignature(baseManifest) !== baseSignature(previous.baseManifest) } : {}),
        ...(move ? { transition: { id: move.transitionId, from: move.from } } : {}) };
      if (move) this.#place(draft, taskId, { ...move, runId: id });
      delete current.task.archivedAt;
      draft.runs.push(record);
      if (resume) attachResumedRun(draft, record, session); else attachSession(draft, record);
      return record;
    });
    if (handoffSignal?.aborted) {
      // Acceptance is atomic. A cancellation during its disk write parks/stops
      // the newly published run before it can enter the process queue.
      if (handoffSignal.reason === 'shutdown') await this.updateRun(run.id, { status: 'interrupted', reason: 'The app stopped during the settings handoff. The conversation and files are kept.', endedAt: Date.now() });
      else if (handoffSignal.reason === 'stop') await this.executor.cancel(run.id);
      else await this.executor.suspend(run.id);
      return this.run(run.id);
    }
    const payload = { run, task: { id: task.id, title: task.title, prompt: task.prompt }, workspace, firstPrompt, continuation };
    if (this.automationMoves.get(taskId)?.deferNativeStart) this.deferredPipelineStarts.set(run.id, payload);
    else await this.executor.start(payload);
    return run;
  }

  #approvedPlan(state, task) {
    const approval = task.planApproval;
    // An approval counts only for the task text it was given for.
    if (!approval || approval.contentRevision !== (task.contentRevision ?? 1)) return null;
    return state.runs.find(run => run.id === approval.runId && run.taskId === task.id && run.promptRevision === (task.contentRevision ?? 1) && run.hasPlan) ? approval : null;
  }

  /** Record plan approval against the current task content. */
  async approvePlan(taskId, { runId }) {
    return this.store.update(state => {
      const { task } = this.#task(state, taskId);
      const run = state.runs.find(item => item.id === runId && item.taskId === taskId && item.stage === 'planning');
      if (!run?.hasPlan) throw new BoardError('This planning run has no plan to approve.', 'PLAN_MISSING', 409);
      if (run.promptRevision !== (task.contentRevision ?? 1)) throw conflict('The task changed after this plan was written. Run Planning again.', 'PLAN_STALE');
      task.planApproval = { runId, contentRevision: task.contentRevision ?? 1, approvedAt: Date.now() };
      task.revision++;
      return task;
    });
  }

  /** The supervisor reports status and lifecycle facts here. Only allowed transitions apply. */
  async updateRun(runId, { status, reason = '', ...fields } = {}) {
    return this.store.update(state => {
      const run = state.runs.find(item => item.id === runId);
      if (!run) throw new BoardError('This run does not exist.', 'NOT_FOUND', 404);
      if (status && status !== run.status && !RUN_NEXT[run.status]?.includes(status)) throw conflict(`A ${run.status} run cannot become ${status}.`, 'RUN_TRANSITION_NOT_ALLOWED');
      for (const key of RUN_FIELDS) if (fields[key] !== undefined) run[key] = typeof fields[key] === 'string' ? clip(fields[key], key === 'planExcerpt' ? 4000 : 500) : fields[key];
      Object.assign(run, { ...(status ? { status } : {}), updatedAt: Date.now(), ...(reason ? { reason: clip(reason, 500) } : {}) });
      synchronizeSession(state, run);
      return run;
    });
  }

  /** Supervisor-only delivery facts; immutable resource identities cannot be swapped after acceptance. */
  async recordBaseManifest(runId, manifest) {
    if (!manifest || Buffer.byteLength(JSON.stringify(manifest)) > 512 * 1024) throw new BoardError('The Base manifest exceeds its limit.', 'BASE_MANIFEST_INVALID');
    return this.store.update(state => {
      const run = state.runs.find(item => item.id === runId);
      if (!run || baseSignature(run.baseManifest) !== baseSignature(manifest)) throw conflict('The supplied Base manifest does not match this run.', 'BASE_MANIFEST_INVALID');
      run.baseManifest = structuredClone(manifest);
      if (run.planRunId && manifest.deliveryState === 'supplied') {
        const plan = state.runs.find(item => item.id === run.planRunId);
        run.planBaseChanged ||= suppliedSignature(plan?.baseManifest) !== suppliedSignature(manifest);
      }
      return run.baseManifest;
    });
  }

  /** Global settings. Each field is optional; project workflow settings stay with their project. */
  async setSettings({ maxConcurrentRuns, defaultAgent } = {}) {
    const change = {};
    if (maxConcurrentRuns !== undefined) {
      if (!Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1 || maxConcurrentRuns > 4) throw new BoardError('Allow 1 to 4 agent sessions at the same time.', 'INVALID_INPUT');
      change.maxConcurrentRuns = maxConcurrentRuns;
    }
    // The same validation as a stage setting: an agent provider, a safe model ID, and an effort it accepts.
    if (defaultAgent !== undefined) change.defaultAgent = normalizeAgent(defaultAgent);
    return this.store.update(state => { state.settings = { ...state.settings, ...change }; return state.settings; });
  }

  async run(runId) {
    const run = (await this.state()).runs.find(item => item.id === runId);
    if (!run) throw new BoardError('This run does not exist.', 'NOT_FOUND', 404);
    return run;
  }
}

function title(column) { return COLUMNS.find(item => item.id === column)?.title || column; }
function baseSignature(manifest) { return JSON.stringify({ resources: (manifest?.resources || []).map(item => [item.resourceId, item.revision]), profiles: (manifest?.profiles || []).map(item => [item.resourceId, item.revision]) }); }
function suppliedSignature(manifest) { return JSON.stringify((manifest?.supplied || []).map(item => [item.resourceId, item.revision, item.delivery, item.contentHash || null])); }
