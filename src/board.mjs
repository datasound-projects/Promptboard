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
import { Store, draftsToCards } from './store.mjs';
import { taskPriority } from './task-priority.mjs';
import { taskLabels, taskLabelIds, labelRevision } from './task-labels.mjs';
import { assignTaskNumbers, allocateTaskNumber, validateTaskNumbers } from './task-numbers.mjs';
import { branchExists, commitExists, git, GitError, initRepository, listWorktrees, repositoryIdentity, validateRepository } from './git.mjs';
import { ADAPTERS, resolveConfig, validateResumeId } from './agents.mjs';
import { Delivery } from './delivery.mjs';
import { ensureClone, fastForward, fetchAndCompare, viewRepository } from './github.mjs';
import { externalIssueSource } from './external-source.mjs';
import { buildTimeline } from './timeline.mjs';
import { Base, normalizeBinding, listTargets, remapBaseScopes } from './base.mjs';
import { checkBaseRevocations, deliveryFor, profileDefaults, resolveBase } from './base-resolver.mjs';
import { defaultPipelineConfig, KIND_STAGES, normalizeExecutionPolicy, normalizePipelineConfig, normalizePipelineTaskSelection, resolveExecutionPolicy, resolvePipelineStrategy, withSeededKinds } from './pipeline-config.mjs';
import { renderPipelineSpawnPrompt } from './pipeline-templates.mjs';
import { ownsMove, PipelineJournal } from './pipeline-journal.mjs';
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
const BACKUP_VERSION = 12; // 12 adds column types; 11 dropped Backlog (older backups still import, with drafts added to To Do).
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
const findingLines = findings => findings.map(item => `- [${item.severity}] ${item.file}${item.line ? `:${item.line}` : ''} ${item.explanation}`).join('\n');

/**
 * The stage contract of a column: a legacy board's own stage ID, the stage of a pipeline column's kind
 * (Planning, Executing, Code Review, Testing, Merge), or null for custom pipeline columns and To Do/Done.
 * Manual moves and Autopilot both decide stage behaviour through this, never through a column's name.
 */
export function columnStage(project, columnId) {
  if (project?.workflowMode !== 'pipeline') return EXECUTABLE_STAGES.has(columnId) ? columnId : null;
  const column = project.pipeline.columns.find(item => item.id === columnId);
  return column?.role === 'active' ? KIND_STAGES[column.kind] || null : null;
}
/** The stage a run works on: the stage engine records it next to the pipeline column ID. */
export const runStage = run => run?.stageKind || run?.stage;
// Stage-engine outcomes. `next` tells Autopilot (and the board view) what follows; nothing moves by itself.
const OUTCOME_STATUSES = new Set(['working', 'verifying', 'succeeded', 'changes_required', 'failed']);
const time = value => Number.isFinite(value) ? value : Date.now();

const RECORD_ID = /^[A-Za-z0-9_-]{1,100}$/;
const recordId = value => typeof value === 'string' && RECORD_ID.test(value); // RegExp.test(undefined) tests "undefined".
/** Where a card came from in Origin. A repeated handoff finds the card by it instead of adding another. */
export function originSourceOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !recordId(value.originProjectId) || !recordId(value.originTaskId)) throw new BoardError('The Origin reference is not valid.', 'INVALID_INPUT');
  return { originProjectId: value.originProjectId, originTaskId: value.originTaskId, snapshotId: recordId(value.snapshotId) ? value.snapshotId : '',
    hash: typeof value.hash === 'string' && /^[a-f0-9]{64}$/.test(value.hash) ? value.hash : '', key: typeof value.key === 'string' ? value.key.slice(0, 20) : '' };
}
// Export keeps going past a malformed reference saved by an older version; it just leaves it out.
const validOrigin = value => { try { return value !== undefined && Boolean(originSourceOf(value)); } catch { return false; } };
/** Prerequisite cards: other cards of the same project that must be done before this one starts. */
function prerequisiteIds(value, ids, selfId) {
  if (!Array.isArray(value) || value.length > 50) throw new BoardError('A card can have at most 50 prerequisites.', 'INVALID_INPUT');
  const list = [...new Set(value)];
  if (list.some(id => typeof id !== 'string' || id === selfId || !ids.has(id))) throw new BoardError('A prerequisite refers to a card that does not exist on this board.', 'INVALID_INPUT');
  return list;
}

/** A pipeline Autopilot route: active columns only, each once, in board order. */
export function pipelineAutopilotRoute(project, route) {
  const active = project.pipeline.columns.filter(column => column.role === 'active').map(column => column.id);
  if (!Array.isArray(route) || !route.length || new Set(route).size !== route.length || route.some(id => !active.includes(id))) throw new BoardError('Choose the active columns Autopilot goes through.', 'INVALID_AUTOPILOT');
  const clean = active.filter(id => route.includes(id));
  // Typed columns follow the stage contract: tests run on the reviewed commit, and a merge needs both.
  const stages = clean.map(id => columnStage(project, id));
  const first = stage => stages.indexOf(stage), present = stage => stages.includes(stage);
  if (present('code_review') && !present('executing')) throw new BoardError('A route with a Code Review column needs an Executing column before it: review needs work to review.', 'INVALID_AUTOPILOT');
  if (present('testing') && !(present('code_review') && first('code_review') < first('testing'))) throw new BoardError('A route with a Testing column needs a Code Review column before it: tests run on the reviewed commit.', 'INVALID_AUTOPILOT');
  if (present('merge') && !(present('testing') && first('testing') < first('merge'))) throw new BoardError('A route that merges needs Code Review and Testing columns before Merge: the merge needs an accepted review and passing tests for the same commit.', 'INVALID_AUTOPILOT');
  return clean;
}
/** Later route columns without an instruction: an enabled deferred "on enter" message, or the plan route that leads there (with each card's profile). */
export function pipelineAutopilotGaps(project, route, tasks = []) {
  const columns = new Map(project.pipeline.columns.map(column => [column.id, column]));
  return route.slice(1).filter((id, index) => {
    // Typed columns start their own session with stage instructions; they need no "on enter" message.
    if (columnStage(project, id)) return false;
    const instructed = columns.get(id).automations.onEnter.some(row => row.enabled && row.type === 'send_message' && row.mode === 'deferred');
    return !instructed && (tasks.length ? tasks : [{}]).some(task => resolvePipelineStrategy(project.pipeline, route[index], task).planExitTargetId !== id);
  }).map(id => `“${columns.get(id).name}”`);
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
    // A card made from a saved project prompt keeps which prompt revision it received.
    ...(typeof source.projectId === 'string' && RECORD_ID.test(source.projectId) && typeof source.promptId === 'string' && RECORD_ID.test(source.promptId)
      && Number.isSafeInteger(source.promptRevision) && source.promptRevision > 0 ? { projectId: source.projectId, promptId: source.promptId, promptRevision: source.promptRevision } : {}),
  };
}

/** Validate a browser board (v1) or a backup (v1 kanban-backup, v2 promptboard-backup). */
export function parseBackup(data) {
  try { return parseBackupData(data); }
  catch (error) { throw error instanceof BoardError || ['INVALID_PIPELINE_CONFIG', 'INVALID_TASK_PRIORITY', 'INVALID_TASK_LABELS', 'INVALID_EXTERNAL_SOURCE'].includes(error.code) || error.message === 'Invalid backlog draft.' || error.message === 'Invalid backlog drafts.' ? new BoardError(error.message, 'INVALID_BACKUP') : error; }
}
function parseBackupData(data) {
  const v1 = data?.version === 1 && (data.kind === undefined || data.kind === 'kanban-backup');
  const v2 = Number.isInteger(data?.version) && data.version >= 2 && data.version <= BACKUP_VERSION && data.kind === 'promptboard-backup';
  const v3 = v2 && data.version >= 3;
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
    if (v2 && data.version >= 4 && project.workflowMode !== undefined && !['legacy', 'pipeline'].includes(project.workflowMode)) throw new BoardError('Unknown backup workflow mode.', 'INVALID_BACKUP');
    const pipeline = v2 && data.version >= 4 && project.workflowMode === 'pipeline' ? normalizePipelineConfig(project.pipeline) : null;
    if (data.version >= 8 && (!Array.isArray(project.labels) || cards.some(card => !Array.isArray(card?.labelIds)))) throw new BoardError('Label metadata is missing from this backup.', 'INVALID_BACKUP');
    const labels = data.version >= 8 ? taskLabels(project.labels) : [];
    const columnLayout = !pipeline && v2 && Array.isArray(project.columnLayout) && project.columnLayout.length ? normalizeColumns(project.columnLayout) : null;
    const columnIds = new Set(pipeline ? pipeline.columns.map(column => column.id) : [...COLUMN_IDS, ...(columnLayout || []).filter(entry => entry.custom).map(entry => entry.id)]);
    return {
      id: unique(project.id, label), name, createdAt: time(project.createdAt), labels,
      // Backups from before version 11 may hold Backlog drafts; they are added to To Do once the cards are checked.
      drafts: v2 && data.version >= 9 && data.version <= 10 && Array.isArray(project.backlog) ? project.backlog.map(item => ({ ...item, id: unique(item?.id, label + ' backlog item'), source: normalizeSource(item?.source) })) : [],
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
        if ((!pipeline || data.version < 5) && (card.profileId != null || card.agentOverride != null)) throw new BoardError('Task pipeline settings require a version 5 or newer pipeline backup.', 'INVALID_BACKUP');
        return { id: unique(card.id, cardLabel), title: text(card.title, 120, `${cardLabel} title`), prompt: promptText(card.prompt, cardLabel, Boolean(pipeline)),
          createdAt: time(card.createdAt), updatedAt: time(card.updatedAt ?? card.createdAt), checksOutdated: card.checksOutdated === true,
          ...(data.version >= 6 ? { number: card.number } : {}),
          labelIds: data.version >= 8 ? taskLabelIds(card.labelIds, labels) : [],
          priority: data.version >= 7 ? taskPriority(card.priority) : 0, source: normalizeSource(card.source), ...(data.version >= 10 && card.externalSource !== undefined ? { externalSource: externalIssueSource(card.externalSource) } : {}),
          ...(data.version >= 10 && card.originSource !== undefined ? { originSource: originSourceOf(card.originSource) } : {}), ...(data.version >= 10 && card.dependsOn !== undefined ? { dependsOn: card.dependsOn } : {}), column: v2 && columnIds.has(card.column) ? card.column : 'todo', ...(v3 ? backupBaseScopes(card, true, columnIds) : {}),
          ...(pipeline && data.version >= 5 ? normalizePipelineTaskSelection(pipeline, { profileId: card.profileId, agentOverride: card.agentOverride }) : {}) };
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
  for (const project of projects) {
    try { validateTaskNumbers(project, { required: data.version >= 6 }); assignTaskNumbers(project); }
    catch (error) { throw new BoardError(error.message, 'INVALID_BACKUP'); }
    if (project.tasks.length + project.drafts.length > TASK_LIMIT) throw new BoardError(`${project.name}: its cards and drafts exceed ${TASK_LIMIT} cards.`, 'INVALID_BACKUP');
    draftsToCards(project, project.drafts, Boolean(project.pipeline));
    delete project.drafts;
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

function newProject({ id = randomUUID(), name, createdAt = Date.now(), nextTaskNumber = 1, labels = [] }) {
  return { id, name, createdAt, nextTaskNumber, labels: taskLabels(labels), labelRevision: 0, revision: 1, repository: null, targetBranch: null, workflowMode: 'legacy', workflow: {}, pendingImport: null, tasks: [] };
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
    const settings = { provider: agent.provider || 'claude', model: strategy.modelOverride ?? agent.model ?? '', effort: strategy.effortOverride ?? agent.effort ?? '',
      permissionMode: strategy.permissionMode ?? agent.permissionMode ?? '', pipeline: true, instructions: '', policy: strategy.autoSpawn ? 'start' : 'manual', agentSource: 'pipeline' };
    if (column.role !== 'active') return [column.id, settings];
    // Typed columns, and any column whose execution policy someone chose, launch through the policy. A custom column
    // nobody configured keeps its saved permission mode exactly as before.
    const execution = resolveExecutionPolicy(project.pipeline, column.id, task || {}, project.execution);
    const explicit = execution.kind !== 'custom' || Object.values(execution.sources).some(source => source !== 'default');
    return [column.id, { ...settings, kind: execution.kind, completion: execution.completion,
      ...(explicit ? { interaction: execution.interaction, filesystem: execution.filesystem } : {}), ...(execution.stage ? { stageEngine: true } : {}),
      ...(project.execution?.workspaceTrust === 'task_workspaces' ? { trustWorkspace: true } : {}) }];
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
      const shown = name || base.title;
      if (!(entry.hidden === true && entry.id === 'planning')) {
        if (names.has(shown.toLowerCase())) throw new BoardError(`Two columns are called “${shown}”. Use different names.`, 'INVALID_COLUMNS');
        names.add(shown.toLowerCase());
      }
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
  constructor({ dataDir, executor = null, projectsDir = join(dataDir, 'projects'), automationActions = new PipelineActions() }) {
    this.dataDir = dataDir;
    this.projectsDir = projectsDir; // Where "New project" creates each project's own Git repository.
    this.store = new Store(dataDir);
    this.base = new Base({ store: this.store });
    this.worktreeRoot = join(dataDir, 'worktrees');
    this.hooksDir = join(dataDir, 'no-hooks'); // Empty: git worktree add runs no repository hooks.
    this.executor = executor; // PB-02 registers one. Null means execution is inactive.
    this.locks = new Map();
    this.recoveryPromise = null;
    this.delivery = new Delivery(this);
    this.automationJournal = new PipelineJournal(dataDir, { onLeaseLost: key => this.#automationLeaseLost(key) });
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

  /** Everything createProject refuses. createProjectWithRepository checks it before any Git command runs. */
  #newProjectError(state, { name, workflowMode, id }) {
    if (!['legacy', 'pipeline'].includes(workflowMode)) throw new BoardError('Choose a legacy stage board or a column pipeline.', 'INVALID_INPUT');
    if (id !== undefined && !(typeof id === 'string' && RECORD_ID.test(id))) throw new BoardError('Choose a valid project ID.', 'INVALID_INPUT');
    if (state.projects.length >= PROJECT_LIMIT) throw new BoardError(`A board can have at most ${PROJECT_LIMIT} projects.`, 'LIMIT');
    this.#nameError(state, name);
    if (id !== undefined && state.projects.some(project => project.id === id)) throw conflict('A Kanban project with this ID already exists.', 'ID_TAKEN');
  }

  // ---- Projects ----

  /** `id` (optional) lets a shared project keep one ID across Origin and Kanban; it must be unused. */
  async createProject({ name, workflowMode = 'legacy', id }) {
    const clean = text(name, 80, 'Project name');
    return this.store.update(state => {
      this.#newProjectError(state, { name: clean, workflowMode, id });
      const project = newProject({ ...(id === undefined ? {} : { id }), name: clean });
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
  async createProjectWithRepository({ name, folder, workflowMode = 'legacy', id }) {
    const clean = text(name, 80, 'Project name');
    // Refuse before any folder or Git change; createProject checks again inside its update.
    this.#newProjectError(await this.state(), { name: clean, workflowMode, id });
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
      const project = await this.createProject({ name: clean, workflowMode, id });
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
    if (this.#project(await this.state(), id).workflowMode === 'pipeline') return this.#setPipelineAutopilot(id, { route, queue, expectedRevision });
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

  /**
   * Pipeline Autopilot settings: the active columns each queued card goes through (in board order), then
   * Done. Each later column needs an instruction (its "on enter" agent message), because a card that moves
   * on keeps the same agent conversation and receives nothing new otherwise.
   */
  #setPipelineAutopilot(id, { route, queue = [], expectedRevision }) {
    if (!Array.isArray(queue) || queue.length > TASK_LIMIT || new Set(queue).size !== queue.length) return Promise.reject(new BoardError('The Autopilot queue must list each card once.', 'INVALID_AUTOPILOT'));
    return this.store.update(state => {
      const project = this.#project(state, id);
      checkRevision(project, expectedRevision, 'This project');
      if (project.autopilot?.status === 'running') throw conflict('Pause or stop Autopilot before you change its settings.', 'AUTOPILOT_RUNNING');
      const cleanRoute = pipelineAutopilotRoute(project, route), ids = new Set(project.tasks.map(task => task.id));
      if (queue.some(taskId => !ids.has(taskId))) throw new BoardError('The Autopilot queue lists a card that is not in this project.', 'INVALID_AUTOPILOT');
      const previous = project.autopilot || {};
      project.autopilot = { status: previous.status === 'paused' ? 'paused' : 'off', ...previous, route: cleanRoute, finish: 'done', maxRework: 0, queue, routes: {}, updatedAt: Date.now() };
      project.revision++;
      return project;
    });
  }

  /** Start (confirmed), pause, resume, stop, or skip the current card. The engine does the work. */
  async controlAutopilot(id, { action, confirm }) {
    const project = this.#project(await this.state(), id);
    if (project.workflowMode === 'pipeline' && (action === 'start' || action === 'resume')) {
      if (action === 'start' && confirm !== true) throw new BoardError('Confirm what Autopilot will do before you start it.', 'CONFIRMATION_REQUIRED');
      if (!project.repository) throw new BoardError('Link a repository first.', 'REPOSITORY_REQUIRED', 409);
      if (!this.executor) throw new BoardError('Agent execution is not available.', 'EXECUTION_UNAVAILABLE', 503);
      if (action === 'start' && !project.autopilot?.queue?.length) throw new BoardError('Choose at least one To Do card for the Autopilot queue.', 'AUTOPILOT_EMPTY');
      const queued = (project.autopilot?.queue || []).map(taskId => project.tasks.find(task => task.id === taskId)).filter(Boolean);
      const missing = pipelineAutopilotGaps(project, pipelineAutopilotRoute(project, project.autopilot?.route), queued);
      if (missing.length) throw conflict(`Give ${missing.join(', ')} an instruction (an “on enter” agent message) so its agent knows what to do there.`, 'AUTOPILOT_INSTRUCTION_MISSING');
    }
    if (project.workflowMode !== 'pipeline' && action === 'start') {
      if (confirm !== true) throw new BoardError('Confirm what Autopilot will do before you start it.', 'CONFIRMATION_REQUIRED');
      if (!project.repository || !project.targetBranch) throw new BoardError('Link a repository and choose the target branch first.', 'REPOSITORY_REQUIRED', 409);
      if (!this.executor) throw new BoardError('Agent execution is not available.', 'EXECUTION_UNAVAILABLE', 503);
      if (!project.autopilot?.queue?.length) throw new BoardError('Choose at least one To Do card for the Autopilot queue.', 'AUTOPILOT_EMPTY');
    }
    // Routes saved by an earlier version are checked against the current stage contract before they run.
    if (project.workflowMode !== 'pipeline' && (action === 'start' || action === 'resume') && project.autopilot) {
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

  /**
   * The project's execution policy (Kanban settings): how agents ask, where they may write, how stages complete, and
   * how many automatic rework rounds a card gets. `applyToAllColumns` removes the columns' and profiles' own
   * interaction/access/completion overrides so every column inherits this policy. Saving starts nothing.
   */
  async setExecutionPolicy(id, { policy = {}, applyToAllColumns = false, expectedRevision } = {}) {
    let clean;
    try { clean = normalizeExecutionPolicy(policy); } catch (error) { throw new BoardError(error.message, 'INVALID_EXECUTION_POLICY'); }
    return this.store.update(state => {
      const project = this.#project(state, id);
      checkRevision(project, expectedRevision, 'This project');
      if (project.workflowMode !== 'pipeline') throw conflict('Execution permissions apply to column pipelines. Switch this board in Columns first.', 'PIPELINE_REQUIRED');
      if (project.autopilot?.status === 'running') throw conflict('Pause Autopilot before you change execution permissions.', 'AUTOPILOT_RUNNING');
      const previous = { execution: project.execution, pipeline: project.pipeline };
      project.execution = clean;
      if (applyToAllColumns) project.pipeline = this.#withoutPolicyOverrides(project.pipeline);
      // Every column must still be able to launch with the new policy (for example, a provider without an autonomous mode).
      try {
        for (const column of project.pipeline.columns.filter(item => item.role === 'active')) for (const task of [null, ...project.pipeline.profiles.map(profile => ({ profileId: profile.id })), ...project.tasks.filter(task => task.agentOverride)])
          resolveConfig(column.id, effectiveWorkflow(project, state.settings.defaultAgent, state, task)[column.id]);
      } catch (error) { Object.assign(project, previous); throw new BoardError(error.message, error.code || 'EXECUTION_POLICY_UNSUPPORTED', 409); }
      project.revision++;
      return project;
    });
  }

  #withoutPolicyOverrides(pipeline) {
    const strip = strategy => Object.fromEntries(Object.entries(strategy || {}).filter(([key]) => !['interaction', 'filesystem', 'completion'].includes(key)));
    return normalizePipelineConfig({ ...pipeline, columns: pipeline.columns.map(column => ({ ...column, strategy: strip(column.strategy) })),
      profiles: pipeline.profiles.map(profile => ({ ...profile, columns: Object.fromEntries(Object.entries(profile.columns).map(([columnId, strategy]) => [columnId, strip(strategy)])) })) });
  }

  /**
   * The "Full Autopilot" preset, applied explicitly: the seeded columns become typed stage columns, every column
   * inherits autonomous workspace access with automatic completion and two rework rounds, merges are squashed,
   * and Autopilot's route is every active column in board order. Individual columns can override it afterwards.
   * Nothing starts; Planning and Code Review stay read-only by their type.
   */
  async applyFullAutopilot(id, { expectedRevision, confirm = false } = {}) {
    if (confirm !== true) throw new BoardError('Confirm the Full Autopilot preset: agents will act without asking inside each task worktree.', 'CONFIRMATION_REQUIRED');
    const project = this.#project(await this.state(), id);
    if (project.workflowMode !== 'pipeline') throw conflict('Switch this board to a column pipeline in Columns first.', 'PIPELINE_REQUIRED');
    const typed = this.#withoutPolicyOverrides(withSeededKinds(project.pipeline));
    const saved = await this.#setPipeline(id, { pipeline: typed, expectedRevision });
    await this.setExecutionPolicy(id, { policy: { interaction: 'autonomous', filesystem: 'workspace_write', completion: 'automatic', maxRework: 2, mergeMethod: 'squash', workspaceTrust: 'task_workspaces' }, expectedRevision: saved.revision });
    return this.store.update(state => {
      const current = this.#project(state, id);
      const previous = current.autopilot || {};
      current.autopilot = { status: previous.status === 'paused' ? 'paused' : 'off', ...previous, route: current.pipeline.columns.filter(column => column.role === 'active').map(column => column.id),
        finish: 'done', maxRework: 2, queue: previous.queue || [], routes: {}, updatedAt: Date.now() };
      pipelineAutopilotRoute(current, current.autopilot.route);
      current.revision++;
      return current;
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
    // Any move of this card replaces an approved plan's move that still waits for the agent's turn to end.
    this.executor?.abortPlanRoute?.(id);
    return this.#locked(`transition:${id}`, () => this.#transition(id, request));
  }

  async #transition(id, { column, index, expectedRevision, expectedProjectRevision = null, transitionId, decision, commitMessage, config = {}, trigger = 'user' } = {}) {
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
    const startAction = Boolean(plan.action) && decision !== 'move' && (decision === 'start' || plan.policy !== 'manual' || plan.action === 'merge-prepare');
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
  async #prepareMerge(id, { auto = false, runLocked = false, retried = false } = {}) {
    const { project, task } = this.#task(await this.state(), id);
    const pipeline = project.workflowMode === 'pipeline';
    // The stage engine records merge progress as the Merge column's outcome (there is no agent run unless conflicts need one).
    const mergeRun = { id: null, stage: task.column, stageKind: 'merge', config: {} };
    const rev = await this.delivery.revision(id);
    const review = task.evidence?.review, tests = task.evidence?.tests;
    const blocked = async message => {
      await this.#setFlow(id, { kind: 'blocked', reason: message });
      if (pipeline) await this.#recordOutcome(id, mergeRun, 'failed', { code: 'MERGE_BLOCKED', reason: message });
      return { state: 'blocked', message };
    };
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
        // The conflict resolver runs in the card's own Merge column (pipeline) or the Merge stage (legacy).
        // A pipeline move already holds this card's run lock; taking it again would wait for itself.
        const startResolver = () => this.#startRun(id, { stage: pipeline ? task.column : 'merge', consent: true, trigger: 'automation' });
        const run = runLocked ? await startResolver() : await this.#locked(`run:${id}`, startResolver);
        // Pipelines complete the resolver through the stage engine (#finishStageRun); legacy boards through this flow.
        await this.#setFlow(id, pipeline ? null : { kind: 'merge-resolve', runId: run.id, auto });
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
      if (pipeline) await this.#recordOutcome(id, mergeRun, 'working', { reason: `The task branch now contains the current ${preview.targetBranch}; the tests run again on it.` });
      return { state: 'testing', message: `The task branch now contains the current ${preview.targetBranch}. The tests are running again on it.` };
    }
    if (!preview.eligible) return blocked(preview.problems.join(' '));
    if (!auto) {
      await this.#setFlow(id, { kind: 'ready', targetBranch: preview.targetBranch });
      if (pipeline) await this.#recordOutcome(id, mergeRun, 'working', { reason: `Ready to merge into ${preview.targetBranch}. Choose Merge.` });
      return { state: 'ready', message: `Ready to merge into ${preview.targetBranch}.` };
    }
    // Stage-engine boards squash the task's checkpoint commits into one commit with the reviewed and tested tree.
    let done;
    try { done = await this.delivery.merge(id, { confirm: true, taskCommit: preview.taskCommit, targetCommit: preview.targetCommit, trigger: 'automation', squash: pipeline && (project.execution?.mergeMethod ?? 'squash') === 'squash' }); }
    catch (error) {
      // The target moved between preview and merge: prepare once more on the new target (bring it in, test again).
      if (error.code === 'TARGET_CHANGED' && !retried) return this.#prepareMerge(id, { auto, runLocked, retried: true });
      return blocked(`${error.message}${error.code ? ` (${error.code})` : ''}`);
    }
    return { state: 'merged', message: `Merged into ${preview.targetBranch}.`, task: done };
  }

  /** The Merge button: one click merges a verified card (preparing it first when the target moved). */
  mergeNow(id) {
    return this.#locked(`transition:${id}`, async () => {
      const { project, task } = this.#task(await this.state(), id);
      if (columnStage(project, task.column) !== 'merge') throw conflict('Move the card to Merge first.', 'STAGE_MISMATCH');
      if (this.#activeRun(await this.state(), id)) throw conflict('An agent is still working on this card.', 'RUN_ACTIVE');
      const preview = await this.delivery.mergePreview(id);
      const squash = project.workflowMode === 'pipeline' && (project.execution?.mergeMethod ?? 'squash') === 'squash';
      if (preview.eligible) return { task: await this.delivery.merge(id, { confirm: true, taskCommit: preview.taskCommit, targetCommit: preview.targetCommit, trigger: 'user', squash }), merged: true };
      const merge = await this.#prepareMerge(id, { auto: true });
      if (merge.state === 'blocked') throw conflict(merge.message, 'MERGE_NOT_READY');
      return { task: merge.task || await this.#taskNow(id), merged: merge.state === 'merged', merge };
    });
  }

  /**
   * Follow-up work the board does by itself (called every second): tests that finished during a merge
   * preparation, a merge agent that finished resolving, and open pull requests (checked once a minute).
   * Each card is handled under its transition lock.
   */
  async advanceFlows() {
    const state = await this.state();
    // A crashed owner's lease outlives it by at most one TTL; its move is recovered here once that lease expires.
    for (const key of this.automationJournal.pendingRecoveries())
      if ((await this.automationJournal.recoverInterrupted(key).catch(() => [])).length) await this.#publishAutomationMove(key).catch(() => {});
    await this.#advanceStageEngine(state);
    for (const project of state.projects) {
      // Legacy Autopilot drives its own card's flows. Pipeline Autopilot reads the board's outcomes instead.
      const autopilotCard = project.workflowMode !== 'pipeline' && project.autopilot?.status === 'running' ? project.autopilot.current?.taskId : null;
      for (const task of project.tasks) {
        if (task.id === autopilotCard) continue; // Autopilot drives its own card.
        const flow = task.flow;
        const pr = task.evidence?.pullRequest;
        const polling = task.column === 'merge' && pr?.url && pr.state === 'OPEN' && Date.now() - (this.prChecks?.get(task.id) || 0) > 60000;
        if (!['merge-tests', 'merge-resolve'].includes(flow?.kind) && !polling) continue;
        await this.#locked(`transition:${task.id}`, () => this.#advanceFlow(task.id, polling)).catch(error => this.#setFlow(task.id, { kind: 'blocked', reason: error.message }).catch(() => {}));
      }
    }
  }

  async #advanceFlow(id, polling) {
    const state = await this.state();
    const { project, task } = this.#task(state, id);
    if (polling) { (this.prChecks ??= new Map()).set(id, Date.now()); await this.delivery.pullRequestStatus(id).catch(() => {}); }
    const flow = task.flow, tests = task.evidence?.tests;
    const pipeline = project.workflowMode === 'pipeline';
    const mergeRun = { id: null, stage: task.column, stageKind: 'merge', config: {} };
    if (flow?.kind === 'merge-tests') {
      if (tests?.id !== flow.testsId) return this.#setFlow(id, null);
      if (tests.status === 'running') {
        if (!this.delivery.testsRunning.has(id)) {
          await this.#setFlow(id, { kind: 'blocked', reason: 'The test run stopped (the app restarted). Move the card again to run them.' });
          if (pipeline) await this.#recordOutcome(id, mergeRun, 'failed', { code: 'VERIFICATION_INTERRUPTED', reason: 'The test run stopped (the app restarted). Move the card to Merge again.' });
        }
        return;
      }
      if (tests.status !== 'passed') {
        await this.#setFlow(id, { kind: 'blocked', reason: `The tests failed on the task branch with the current target. Send the card back to Executing; the failing output goes with it.` });
        // The combined code (task + moved target) fails: it goes back to Executing with the failing output.
        if (pipeline) await this.#recordOutcome(id, mergeRun, 'changes_required', { code: 'VERIFICATION_FAILED', next: 'executing', reason: 'The tests failed on the task branch combined with the current target.' });
        return;
      }
      return this.#prepareMerge(id, { auto: flow.auto });
    }
    if (flow?.kind === 'merge-resolve') {
      const run = state.runs.find(item => item.id === flow.runId);
      if (!run || ['failed', 'cancelled', 'interrupted', 'suspended'].includes(run.status)) return this.#setFlow(id, { kind: 'blocked', reason: `The merge agent ${run?.status || 'stopped'}${run?.reason ? `: ${run.reason.replace(/[.\s]+$/, '')}` : ''}. Resolve the conflicts in the task worktree, or send the card back to Executing.` });
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
    const plan = { from, to, handoff, commit: null, action: null, policy: settings?.policy || 'manual', settings };
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
        try { await this.executor.validate({ stage: to, config: this.#requestedAgent(settings, requestedConfig) }); }
        catch (error) { plan.agentError = { message: `${title(to)} cannot start: ${error.message}`, code: error.code || 'AGENT_UNAVAILABLE' }; }
      }
    }
    return plan;
  }

  /** What the next Executing run must fix, from the stage the card leaves. Null when there is nothing. */
  async #reworkNotes(taskId, from) {
    const { task } = this.#task(await this.state(), taskId);
    const review = task.evidence?.review, tests = task.evidence?.tests;
    if (from === 'code_review' && review?.status === 'completed' && review.verdict !== 'no_issues') {
      return { review: true, text: review.findings?.length ? findingLines(review.findings) : review.text || '' };
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
  startOver(id, { expectedRevision, reason = '', startExecuting = false, confirm = false } = {}) {
    if (typeof reason !== 'string' || reason.length > 4000) throw new BoardError('The reason can have at most 4,000 characters.', 'INVALID_INPUT');
    return this.#locked(`transition:${id}`, async () => {
      const state = await this.state();
      const { project, task } = this.#task(state, id);
      const pipeline = project.workflowMode === 'pipeline';
      const todo = pipeline ? project.pipeline.columns.find(column => column.role === 'todo').id : 'todo';
      // A pipeline reset is the destructive Reset task choice; it needs an explicit confirmation.
      if (pipeline && confirm !== true) throw new BoardError('Confirm resetting this task’s workspace: a new branch starts from the current target branch.', 'CONFIRMATION_REQUIRED');
      checkRevision(task, expectedRevision, 'This card');
      if (task.column === 'done' || (pipeline && project.pipeline.columns.find(column => column.id === task.column)?.role === 'done')) throw conflict('This card is done. Reopen it first; then you can start over.', 'NOT_ALLOWED_IN_DONE');
      if (task.workspace?.status !== 'ready') throw conflict('This card has no task branch yet, so there is nothing to start over.', 'NOTHING_TO_START_OVER');
      if (this.#activeRun(state, id)) throw conflict('An agent is still working on this card. Stop it first.', 'RUN_ACTIVE');
      if (this.delivery.testsRunning.has(id)) throw conflict('Tests are running for this card. Wait for them to finish.', 'TESTS_RUNNING');
      if (project.autopilot?.status === 'running' && project.autopilot.current?.taskId === id) throw conflict('Autopilot is working on this card. Pause Autopilot or skip the card first.', 'AUTOPILOT_ACTIVE');
      const workspace = await this.ensureTaskWorktree(id, { recover: true }); // Start over is explicit: a deleted folder is rebuilt from the branch first.
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
      const findings = attempt.review?.findings?.length ? findingLines(attempt.review.findings) : '';
      const task2 = await this.store.update(draft => {
        const { project: owner, task: current } = this.#task(draft, id);
        current.previousAttempts = [...(current.previousAttempts || []), attempt].slice(-10);
        current.restartNote = [attempt.reason && `Reason: ${attempt.reason}`, findings && `Review findings on the discarded attempt:\n${findings}`,
          `The discarded attempt is kept on branch ${attempt.branch} (${attempt.head.slice(0, 12)}). Start again from the current target branch; do not copy that attempt unless the reason says so.`].filter(Boolean).join('\n\n');
        Object.assign(current, { evidence: {}, stageResults: {}, flow: null, reworkNotes: '', lastTransition: null });
        if (pipeline) Object.assign(current, { sessionId: null, stageOutcome: null, planApproval: null });
        if (current.column !== todo) {
          current.transitions = [...current.transitions, { at: Date.now(), from: current.column, to: todo, by: 'start-over', ...(attempt.reason ? { reason: clip(attempt.reason, 300) } : {}) }].slice(-TRANSITION_LOG_LIMIT);
          current.column = todo;
          owner.tasks = [...owner.tasks.filter(item => item !== current)];
          const firstLater = owner.tasks.findIndex(item => item.column !== todo);
          owner.tasks.splice(firstLater < 0 ? owner.tasks.length : firstLater, 0, current); // Last card of To Do.
        }
        current.revision++;
        return current;
      });
      const result = { task: task2, attempt };
      const executingColumn = pipeline ? project.pipeline.columns.find(column => columnStage(project, column.id) === 'executing')?.id : 'executing';
      if (startExecuting && executingColumn) {
        const started = await this.#transition(id, { column: executingColumn, expectedRevision: task2.revision, decision: 'start' });
        Object.assign(result, { task: started.task, run: started.run });
      }
      return result;
    });
  }

  /**
   * Reset task, the non-destructive choice: stop the card's agent and forget its current conversations, so the next
   * run starts a fresh session. The branch, worktree, files, commits, evidence and history all stay; the card does
   * not move. (The destructive choice is startOver: a new branch from the current target.)
   */
  restartTaskSessions(id, { expectedRevision } = {}) {
    return this.#locked(`transition:${id}`, async () => {
      const state = await this.state(), { project, task } = this.#task(state, id);
      checkRevision(task, expectedRevision, 'This card');
      if (project.autopilot?.status === 'running' && project.autopilot.current?.taskId === id) throw conflict('Autopilot is working on this card. Pause Autopilot or skip the card first.', 'AUTOPILOT_ACTIVE');
      this.#requireAutomationsStopped(task);
      const active = this.#activeRun(state, id);
      if (active) await this.#locked(`run:${id}`, () => this.executor.cancel(active.id));
      return this.store.update(draft => {
        const current = this.#task(draft, id).task;
        if (this.#activeRun(draft, id)) throw conflict('The agent has not stopped yet. Try again.', 'RUN_ACTIVE');
        Object.assign(current, { sessionId: null, stageOutcome: null });
        current.transitions = [...current.transitions, { at: Date.now(), from: current.column, to: current.column, by: 'restart-sessions' }].slice(-TRANSITION_LOG_LIMIT);
        current.revision++;
        return current;
      });
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
    if (recorded.taskId !== run.taskId || recorded.status !== 'succeeded' || !['executing', 'testing'].includes(runStage(recorded))) throw conflict('Confirm the task’s finished stage before saving its results.', 'STAGE_NOT_CONFIRMED');
    run = recorded;
    await this.updateTaskEvidence(run.taskId, task => {
      task.stageResults = { ...(task.stageResults || {}), [runStage(run)]: { runId: run.id, columnId: run.stage, promptRevision: run.promptRevision, summary: String(summary || '').slice(0, 20000), at: Date.now() } };
    });
    if (runStage(run) !== 'testing') return;
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
          if (project.tasks.some(task => task.workspace)) throw conflict('Tasks in this project have worktrees in the current repository. Remove them before you change the link.', 'WORKSPACES_EXIST');
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
      for (const task of project.tasks) {
        const ids = task.labelIds.filter(id => kept.has(id));
        if (ids.length !== task.labelIds.length) Object.assign(task, { labelIds: ids, revision: task.revision + 1, updatedAt: Date.now() });
      }
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
    if (!recordId(originProjectId) || !Array.isArray(tasks) || !tasks.length || tasks.length > 100) return Promise.reject(new BoardError('Choose 1 to 100 Origin tasks.', 'INVALID_INPUT'));
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
      this.#requireIdleInTodo(state, project, task, 'Only an idle card in To Do can take new context. Stop its work and move it back to To Do first.');
      const next = promptText(prompt, 'The task', project.workflowMode === 'pipeline');
      Object.assign(task, { prompt: next, updatedAt: Date.now(), revision: task.revision + 1, contentRevision: (task.contentRevision ?? 1) + 1, checksOutdated: task.checksOutdated || Boolean(task.source),
        originSource: originSourceOf({ ...task.originSource, snapshotId, hash }) });
      return task;
    });
  }

  #requireIdleInTodo(state, project, task, message) {
    const todo = project.workflowMode === 'pipeline' ? project.pipeline.columns.find(column => column.role === 'todo')?.id : 'todo';
    const moving = task.automationMove && !['completed', 'failed', 'cancelled', 'interrupted'].includes(task.automationMove.status);
    if (task.column !== todo || this.#activeRun(state, task.id) || moving) throw conflict(message, 'CARD_BUSY');
  }

  /**
   * Replace a card's instructions with a refined prompt from Compose. Like Origin context updates, only an
   * idle card in To Do changes, so an agent's active instructions are never overwritten; the card's revision
   * must match what the person refined. `source` records the saved prompt revision, when there is one.
   */
  refineTask(taskId, { prompt, source, expectedRevision } = {}) {
    return this.store.update(state => {
      const { project, task } = this.#task(state, taskId);
      checkRevision(task, expectedRevision, 'This card');
      this.#requireIdleInTodo(state, project, task, 'Only an idle card in To Do can take a refined prompt, so a running agent keeps its instructions. Create a new card instead, or stop its work and move it back to To Do.');
      const next = promptText(prompt, 'The task', project.workflowMode === 'pipeline');
      if (next === task.prompt && source === undefined) return task;
      Object.assign(task, { prompt: next, updatedAt: Date.now(), revision: task.revision + 1, contentRevision: (task.contentRevision ?? 1) + 1,
        ...(source !== undefined ? { source: normalizeSource(source), checksOutdated: false } : { checksOutdated: task.checksOutdated || Boolean(task.source) }) });
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

  #createTask(state, { projectId, title, prompt = '', source = null, pipelineSettings, expectedProjectRevision, priority = 0, labelIds, expectedLabelRevision }) {
    const task = newTask({ title: text(title, 120, 'Title'), prompt, source: normalizeSource(source), priority, labelIds });
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
    return this.store.update(state => {
      let projects = 0, cards = 0, skipped = 0;
      const taskIds = new Set(state.projects.flatMap(project => project.tasks.map(task => task.id)));
      for (const incoming of parsed.projects) {
        let project = state.projects.find(item => item.id === incoming.id);
        if (!project) {
          if (state.projects.length >= PROJECT_LIMIT) throw new BoardError(`A board can have at most ${PROJECT_LIMIT} projects.`, 'LIMIT');
          let name = incoming.name;
          for (let n = 2; state.projects.some(item => item.name.toLowerCase() === name.toLowerCase()); n++) name = `${incoming.name.slice(0, 74)} (${n})`;
          project = newProject({ id: incoming.id, name, createdAt: incoming.createdAt, labels: incoming.labels });
          project.timelineNotes = incoming.timelineNotes;
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
    return { application: 'Promptboard', kind: 'promptboard-backup', version: BACKUP_VERSION, exportedAt: new Date().toISOString(),
      base, baseGlobal: backupBaseScopes(state.settings.pendingBaseImport || state.settings),
      projects: state.projects.map(project => ({ id: project.id, name: project.name, createdAt: project.createdAt, nextTaskNumber: project.nextTaskNumber, labels: taskLabels(project.labels),
        ...(project.workflowMode === 'pipeline' ? { workflowMode: 'pipeline', pipeline: project.pipelineImport || project.pipeline } : {}),
        ...backupBaseScopes({ ...project.pendingImport, ...project, ...(project.baseBinding ? {} : project.pendingImport?.baseBinding ? { baseBinding: project.pendingImport.baseBinding } : {}) }),
        repository: project.repository ? { path: project.repository.path } : null, targetBranch: project.targetBranch ? { name: project.targetBranch.name } : null,
        agentDefaults: project.agentDefaults || null, workflow: project.workflow || {}, testCommands: project.testCommands || [], timelineNotes: project.timelineNotes || [], columnLayout: project.columnLayout || [],
        // Workspaces and runs are machine-specific and are not exported.
        tasks: project.tasks.map(task => ({ id: task.id, number: task.number, title: task.title, prompt: task.prompt, priority: taskPriority(task.priority), labelIds: taskLabelIds(task.labelIds, project.labels), source: task.source, ...(task.externalSource === undefined ? {} : { externalSource: externalIssueSource(task.externalSource) }),
          ...(validOrigin(task.originSource) ? { originSource: originSourceOf(task.originSource) } : {}), ...(task.dependsOn?.length ? { dependsOn: [...task.dependsOn] } : {}), checksOutdated: task.checksOutdated,
          createdAt: task.createdAt, updatedAt: task.updatedAt, column: task.column, ...backupBaseScopes(task, true),
          ...(project.workflowMode === 'pipeline' ? normalizePipelineTaskSelection(project.pipelineImport || project.pipeline, { profileId: task.profileId, agentOverride: task.agentOverride }) : {}) })) })) };
  }

  #importRefusal(state, replace) {
    if (state.projects.length && !replace) throw conflict('Confirm that the import replaces the current board.', 'CONFIRMATION_REQUIRED');
    if (this.#hasWorkspaceOrRun(state)) throw conflict('Tasks on the current board own worktrees or runs. Remove those worktrees before you replace the board.', 'WORKSPACES_EXIST');
  }

  /**
   * Replace the board with a backup. Execution state is not imported; repository paths
   * and automation settings wait for confirmation per project. Nothing runs.
   */
  async importBackup(data, { replace = false } = {}) {
    const parsed = parseBackup(data);
    // Refuse before Base writes revision files for the import; the update checks again.
    this.#importRefusal(await this.state(), replace);
    const preparedBase = parsed.base ? await this.base.prepareImport(parsed.base) : null;
    if (data.version >= 3 && !preparedBase) throw new BoardError('This backup is missing its Base resource library.', 'INVALID_BACKUP');
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
      this.#importRefusal(state, replace);
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
   * Check that the task worktree exists, belongs to this repository, is registered with Git, and is on the task
   * branch. Every run and stage check goes through this and fails closed with the exact problem. A deleted folder
   * is recreated from the task branch only on an explicit restore (`recover`): the commits are on the branch, but
   * uncommitted files that were in the folder are gone, and the person should know that before work continues.
   */
  async #verifyWorktree(taskId, repository, ws, { recover = false } = {}) {
    if (ws.commonDir && ws.commonDir !== repository.commonDir) throw conflict(`The task worktree belongs to another repository (${ws.repositoryRoot}). Link the project to that repository again, or start the task over.`, 'WORKTREE_REPOSITORY_MISMATCH');
    const found = await this.#registered(repository.root, ws.path);
    const exists = await access(ws.path).then(() => true, () => false);
    if (found && exists) {
      if (found.branch !== ws.branch) throw conflict(`The task worktree at ${ws.path} is on ${found.branch || 'a detached HEAD'}, not on the task branch ${ws.branch}. Switch it back (git switch ${ws.branch}) in that folder; Promptboard does not switch branches for you.`, 'WORKTREE_BRANCH_MISMATCH');
      return ws;
    }
    if (exists) throw conflict(`The folder ${ws.path} exists, but Git does not list it as a worktree. Check it with git worktree list; Promptboard does not change it.`, 'WORKTREE_MISSING');
    if (!(await branchExists(repository.root, ws.branch))) throw conflict(`The task worktree and its branch ${ws.branch} were deleted, so the task's commits cannot be found. Restore the branch (git branch ${ws.branch} <commit>) or remove the task.`, 'WORKTREE_BRANCH_MISSING');
    if (!recover) throw conflict(`The task worktree folder ${ws.path} was deleted. Its branch ${ws.branch} still has every commit; uncommitted files are gone. Choose Restore worktree on the card to recreate it from the branch.`, 'WORKTREE_MISSING');
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
  ensureTaskWorktree(taskId, { recover = false } = {}) {
    return this.#locked(`task:${taskId}`, async () => {
      const state = await this.state();
      const { project, task } = this.#task(state, taskId);
      const repository = await this.#checkedRepository(project);
      if (task.workspace?.status === 'ready') return this.#verifyWorktree(taskId, repository, task.workspace, { recover });
      if (recover) throw conflict('This task has no worktree to restore.', 'NOTHING_TO_RESTORE');
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

  /** The explicit Restore worktree action: recreate a deleted task worktree folder from its branch (never automatic). */
  async restoreTaskWorktree(taskId) {
    const { task } = this.#task(await this.state(), taskId);
    if (task.workspace?.status !== 'ready') throw conflict('This task has no worktree to restore.', 'NOTHING_TO_RESTORE');
    return this.ensureTaskWorktree(taskId, { recover: true });
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
      const project = state.projects.find(item => item.id === run.projectId), ap = project?.autopilot;
      // Only a pause you cause on Autopilot's own card stops it: not a system handoff, not Autopilot moving
      // its card to Done, and not another card you move or pause meanwhile.
      const ownMove = ap?.current?.taskId === run.taskId && ap.current.step === 'finishing';
      if (ap?.status === 'running' && intent === 'user' && ap.current?.taskId === run.taskId && !ownMove) {
        ap.status = 'paused'; ap.reason = 'The task agent was paused by you.';
        ap.log = [...(ap.log || []), { at: Date.now(), text: `Paused: ${ap.reason}` }].slice(-200);
      }
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
      // A typed column resumes its own stage conversation (same provider, same stage); custom columns resume the pipeline conversation.
      if (project.workflowMode === 'pipeline' && !columnStage(project, task.column)) return this.#pipelineStart(taskId, { column: task.column, requireResume: true, continuation: message });
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
          ...(previous.stageKind ? { stageKind: previous.stageKind, startCommit: previous.startCommit } : {}),
          ...(previous.review ? { review: structuredClone(previous.review) } : {}), ...(previous.planRunId ? { planRunId: previous.planRunId } : {}) };
        draft.runs.push(record); attachResumedRun(draft, record, saved);
        if (previous.stageKind) current.stageOutcome = { columnId: previous.stage, stage: previous.stageKind, runId: id, status: 'working', at: now };
        const ap = this.#project(draft, project.id).autopilot;
        if (ap?.status === 'paused' && ap.current?.runId === previous.id) { ap.current.runId = id; ap.current.step = 'running'; }
        return record;
      });
      await this.executor.start({ run, task: { id: task.id, title: task.title, prompt: task.prompt }, workspace, continuation: message });
      return run;
    });
  }

  /** With `move`, the card enters the stage in the same write that records the run (see transition). */
  async #startRun(taskId, { stage, consent = false, config = {}, trigger = 'user', move = null, note = '', continuation = '' } = {}) {
    {
      let state = await this.state();
      let { project, task } = this.#task(state, taskId);
      const pipeline = project.workflowMode === 'pipeline';
      // `stage` is the column ID. `semantic` is the stage contract it follows (null: a custom pipeline column).
      const semantic = columnStage(project, stage);
      if (pipeline && !semantic) {
        if (consent !== true) throw new BoardError('Starting an agent needs your explicit confirmation.', 'CONSENT_REQUIRED');
        if (Object.keys(config || {}).length) throw new BoardError('Configure the pipeline agent in Column Manager before starting it.', 'PIPELINE_SETTINGS_REQUIRED');
        // A continuation is what a resumed conversation receives; a fresh one receives its task.
        return this.#pipelineStart(taskId, { column: stage, move, trigger, continuation: typeof continuation === 'string' ? continuation : '' });
      }
      if (pipeline && Object.keys(config || {}).length) throw new BoardError('Configure the pipeline agent in Column Manager before starting it.', 'PIPELINE_SETTINGS_REQUIRED');
      const column = projectColumns(project).find(item => item.id === stage);
      if (!column) throw new BoardError('Choose a valid stage.', 'INVALID_COLUMN');
      if (!column.agent) throw new BoardError(`${column.title} never runs an agent.`, 'STAGE_NOT_RUNNABLE');
      if (!move && task.column !== stage) throw conflict(`The card is in ${columnTitleIn(project, task.column)}, not ${column.title}.`, 'STAGE_MISMATCH');
      if (this.#activeRun(state, taskId)) throw conflict('This card already has an active run.', 'RUN_ACTIVE');
      if (consent !== true) throw new BoardError('Starting an agent needs your explicit confirmation.', 'CONSENT_REQUIRED');
      if (!project.repository) throw new BoardError('Link this project to a Git repository first.', 'REPOSITORY_REQUIRED', 409);
      if (!this.executor) throw new BoardError('Agent execution is not available. Cards can be planned and moved, but no agent runs.', 'EXECUTION_UNAVAILABLE', 503);
      if (pipeline && this.automationMoves.get(taskId)?.blocked) throw conflict('This card’s column automations are blocked. Stop them from the card before starting its agent.', 'AUTOMATIONS_ACTIVE');
      await this.#defaultTargetBranch(taskId);
      state = await this.state();
      ({ project, task } = this.#task(state, taskId));
      if (!project.targetBranch) throw new BoardError('Choose the local target branch first.', 'TARGET_BRANCH_REQUIRED', 409);
      const legacyCustom = !pipeline && column.custom;
      if (!semantic && !legacyCustom) throw conflict(`${column.title} runs are not available yet.`, 'STAGE_NOT_IMPLEMENTED');
      // Explicit request values override the project's workflow settings for this run only.
      const settingsOf = (current, draft) => effectiveWorkflow(current, draft.settings.defaultAgent, draft, pipeline ? this.#task(draft, taskId).task : null)[stage];
      const settings = settingsOf(project, state);
      const merged = this.#requestedAgent(settings, config);
      // A pipeline column's instructions are its enabled "on enter" agent messages; the stage engine sends them with the task.
      if (pipeline) merged.instructions = this.#columnInstructions(project, stage);
      if (typeof merged.instructions !== 'string' || merged.instructions.length > (pipeline ? 64 * 1024 : 4000)) throw new BoardError('Stage instructions can have at most 4,000 characters.', 'INVALID_WORKFLOW');
      const resolved = { ...(await this.executor.validate({ stage: semantic || stage, config: merged })), instructions: merged.instructions };
      const baseManifest = this.#basePreflight(state, project, task, stage, resolved.provider);
      if (!WORKSPACE_STAGES.has(semantic) && !legacyCustom && task.workspace?.status !== 'ready') throw new BoardError('Run Planning or Executing first to create the task worktree.', 'WORKSPACE_REQUIRED', 409);
      const workspace = await this.ensureTaskWorktree(taskId);
      const plan = semantic === 'executing' ? this.#approvedPlan(state, task) : null;
      // Review reads the actual diff of a clean, committed revision. Executing gets requested fixes.
      const review = semantic === 'code_review' ? await this.delivery.reviewContext(taskId) : null;
      // Testing gets the configured test commands; Merge first brings the target branch in
      // (git merge --no-commit), leaving any conflicts for the agent to resolve.
      const merge = semantic === 'merge' ? await this.delivery.prepareMergeRun(taskId) : null;
      const testing = semantic === 'testing' ? await this.delivery.testingContext(taskId) : '';
      const restart = ['planning', 'executing'].includes(semantic) && task.restartNote ? `=== WHY THE PREVIOUS ATTEMPT WAS DISCARDED ===\n${task.restartNote}\n=== END ===` : '';
      const result = task.stageResults?.executing;
      const execution = ['code_review', 'testing'].includes(semantic) && result?.promptRevision === (task.contentRevision ?? 1) && result;
      const executionContext = execution ? `=== EXECUTION RESULTS FOR THIS TASK (${task.id}, run ${execution.runId}) ===\n${execution.summary}\n=== END EXECUTION RESULTS ===` : '';
      // The stage engine hands over task state, never another agent's conversation.
      const handoff = pipeline ? await this.#handoffSummary(project, task, workspace) : '';
      const extra = [handoff, review ? review.text : merge ? merge.text : testing || (semantic === 'executing' && task.reworkNotes ? `=== REVIEW FINDINGS TO FIX ===\n${task.reworkNotes}\n=== END FINDINGS ===` : ''), executionContext, restart, note].filter(Boolean).join('\n\n');
      const startCommit = pipeline ? (await this.delivery.revision(taskId)).taskCommit : null;
      const run = await this.store.update(draft => {
        if (this.#activeRun(draft, taskId)) throw conflict('This card already has an active run.', 'RUN_ACTIVE');
        const current = this.#task(draft, taskId);
        if ((draft.base?.revision || 0) !== (state.base?.revision || 0)) throw conflict('Base changed while the run was being prepared. Start again to use the current selection.', 'BASE_REVISION_CONFLICT');
        if ((current.task.contentRevision ?? 1) !== (task.contentRevision ?? 1)) throw conflict('The task text changed while the run was being prepared. Start again.', 'REVISION_CONFLICT');
        const latest = this.#requestedAgent(settingsOf(current.project, draft), config);
        if (pipeline) latest.instructions = this.#columnInstructions(current.project, stage);
        if (JSON.stringify(latest) !== JSON.stringify(merged)) throw conflict('Agent settings changed while the run was being prepared. Start again.', 'REVISION_CONFLICT');
        if (pipeline && (current.task.column !== task.column || current.project.revision !== project.revision)) throw conflict('The card or board changed while the run was being prepared. Start again.', 'REVISION_CONFLICT');
        const now = Date.now();
        const id = randomUUID();
        const record = { id, taskId, projectId: project.id, stage, ...(pipeline ? { stageKind: semantic, startCommit } : {}), status: 'queued', createdAt: now, updatedAt: now,
          promptRevision: task.contentRevision ?? 1, config: resolved, trigger: trigger === 'automation' ? 'automation' : 'user', workspacePath: workspace.path, branch: workspace.branch,
          planRunId: plan?.runId || null, artifactsDir: join('runs', id), turns: 0, baseManifest: { ...baseManifest, acceptedAt: now, deliveryState: 'configured' },
          ...(plan ? { planBaseChanged: baseSignature(draft.runs.find(item => item.id === plan.runId)?.baseManifest) !== baseSignature(baseManifest) } : {}),
          ...(review ? { review: { taskCommit: review.taskCommit, targetCommit: review.targetCommit } } : {}),
          ...(move ? { transition: { id: move.transitionId, from: move.from } } : {}) };
        if (move) { const placed = this.#place(draft, taskId, { ...move, runId: id }); if (pipeline) delete placed.archivedAt; }
        draft.runs.push(record);
        attachSession(draft, record);
        if (pipeline) current.task.stageOutcome = { columnId: stage, stage: semantic, runId: id, status: 'working', at: now };
        // The reason for a start over goes to the new attempt's first Executing run only.
        if (semantic === 'executing' && restart) this.#task(draft, taskId).task.restartNote = '';
        return record;
      });
      const payload = { run, task: { id: task.id, title: task.title, prompt: task.prompt }, workspace, planRunId: plan?.runId || null, extra };
      // A start inside a column move with enter automations waits until those automations are done (as for custom columns).
      const job = this.automationMoves.get(taskId);
      if (pipeline && job?.deferNativeStart && !job.blocked) this.deferredPipelineStarts.set(run.id, payload);
      else await this.executor.start(payload);
      return run;
    }
  }

  /** A typed pipeline column's instructions: its enabled "on enter" agent messages, in order. */
  #columnInstructions(project, columnId) {
    const column = project.pipeline?.columns.find(item => item.id === columnId);
    return (column?.automations.onEnter || []).filter(row => row.enabled && row.type === 'send_message').map(row => row.message.trim()).filter(Boolean).join('\n\n');
  }

  /**
   * The compact task state the next stage agent receives instead of an earlier agent's conversation: the branch and its
   * commits, and each recorded stage result (who ran it, how it ended, its checkpoint). Bounded; never a transcript.
   */
  async #handoffSummary(project, task, workspace) {
    const rev = await this.delivery.revision(task.id).catch(() => null);
    const lines = [`Task branch: ${workspace.branch} (worktree ${workspace.path})`, `Target branch: ${workspace.targetBranch} at ${(rev?.targetCommit || workspace.baseCommit || '').slice(0, 12)}`,
      ...(rev ? [`Task commit: ${rev.taskCommit.slice(0, 12)}, ${rev.ahead} ${rev.ahead === 1 ? 'commit' : 'commits'} ahead of the target${rev.clean ? '' : `, ${rev.changes.length} uncommitted ${rev.changes.length === 1 ? 'change' : 'changes'}`}`] : [])];
    const history = (task.stageHistory || []).slice(-12).map(item => `- ${columnTitleIn(project, item.columnId)} (${item.stage}, ${item.provider || 'agent'}): ${item.status}${item.checkpointCommit ? `, checkpoint ${item.checkpointCommit.slice(0, 12)}` : ''}${item.reason ? ` — ${item.reason}` : ''}`);
    return [`=== TASK STATE (from Promptboard, not from another agent) ===`, ...lines, ...(history.length ? ['Stage results so far:', ...history] : []), `=== END TASK STATE ===`].join('\n');
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
    const onExit = from.automations.onExit, onEnter = to.automations.onEnter;
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
      // A typed column sends its "on enter" agent messages with the task as column instructions, never a second time.
      const enters = await this.automations.runGroup({ key, trigger: 'enter', rows: onEnter, context: enterContext, signal,
        canMessage: to.role === 'active' && !columnStage(project, to.id) && Boolean(this.#activeRun(await this.state(), taskId)),
        suppressMessages: from.role === 'done' || Boolean(columnStage(project, to.id)),
        ...(columnStage(project, to.id) && from.role !== 'done' ? { suppressReason: 'Typed columns send this message with the task as a column instruction.' } : {}),
        onProgress: () => this.#publishAutomationMove(key) });
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
      if (!ownsMove(move)) {
        await this.automationJournal.recoverInterrupted(key);
        const recovered = await this.automationJournal.read(key);
        if (recovered?.phase !== 'complete') throw conflict(recovered?.leaseExpiresAt === undefined ? 'This move belongs to another live application process.'
          : `This move belongs to another live application process. Its lease expires at ${new Date(recovered.leaseExpiresAt).toISOString()} unless that process renews it; the move is then recovered without replay.`, 'AUTOMATION_OWNER_ACTIVE');
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

  /** Another process recovered a move after this process's lease lapsed: stop its owned work. Nothing is replayed. */
  #automationLeaseLost(key) {
    const job = this.automationMoves.get(key.taskId);
    if (job?.key.transitionId === key.transitionId) { job.controller.abort('lease lost'); this.automations.cancel(key); }
    for (const message of this.messageScheduler?.jobs.values() || []) if (message.key.taskId === key.taskId && message.key.transitionId === key.transitionId) message.controller.abort('lease lost');
  }

  async shutdownAutomations() {
    this.automationsStopping = true;
    const jobs = [...this.automationMoves.values()];
    for (const job of jobs) job.controller.abort('shutdown');
    await this.messageScheduler?.shutdown();
    await this.automations.shutdown();
    await Promise.allSettled(jobs.map(job => job.done));
    this.automationJournal.stopRenewals();
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
        if (target.role === 'done') await this.executor.suspend(active.id, { withinAutomationMove, reason: 'The card moved to Done. The conversation, worktree and output are kept.' });
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
    // Typed columns (and leaving a stage-engine run) follow the stage engine: fresh sessions, checks and handoffs.
    if (columnStage(project, column) || active?.stageKind) {
      return this.#stageColumnTransition(taskId, { project, task, target, move, active, expectedRevision, decision, trigger, signal });
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

  /**
   * A pipeline move into a typed column, or out of a stage-engine run. The same path serves a drag and Autopilot.
   * - A finished turn of the stage the card leaves is completed first (the move is the confirmation). An agent that is
   *   still working, or asking something, blocks the move.
   * - Each typed column then starts a fresh agent session in the task's own worktree; nothing resumes across columns,
   *   so the next column may use any provider.
   * - The destination's checks apply before anything starts: Code Review needs committed changes, Testing an accepted
   *   review of the current commit, Merge also passing tests of that commit.
   */
  async #stageColumnTransition(taskId, { project, task, target, move, active, expectedRevision, decision, trigger, signal }) {
    const semantic = columnStage(project, target.id), from = columnStage(project, task.column);
    const name = id => columnTitleIn(project, id);
    if (active) {
      const finished = active.status === 'waiting_for_input' && active.turnComplete && active.turns > 0 && (active.activity ? active.activity.ready !== false : true);
      if (!finished) throw conflict(`The ${name(task.column)} agent is still working or waiting for your answer. Let it finish its turn, or pause it, before moving the card.`, 'RUN_ACTIVE');
      if (active.stageKind) {
        const outcome = await this.#finishStageRun(taskId, active.id, { by: trigger === 'automation' ? 'automation' : 'move' });
        if (outcome?.status === 'failed') throw conflict(`${name(task.column)} did not complete: ${outcome.reason}`, outcome.code || 'STAGE_FAILED');
      } else {
        // A custom column's conversation is kept (paused) when the card enters the stage engine.
        await this.executor.suspend(active.id, { withinAutomationMove: this.automationMoves.get(taskId)?.key.transitionId, reason: 'The card moved to a typed column. This conversation, the worktree and the output are kept.' });
      }
    }
    if (signal?.aborted) throw conflict('The automatic move was cancelled.', 'PLAN_ROUTE_CANCELLED');
    // The card's revision was checked when the move began; completing the stage above only added its own records.
    const state = await this.state(), current = this.#task(state, taskId);
    if (current.task.column !== task.column || current.project.revision !== project.revision) throw conflict('The card or board changed during this move.', 'REVISION_CONFLICT');
    if (this.#activeRun(state, taskId)) throw conflict('This card already has an active run.', 'RUN_ACTIVE');
    const strategy = resolvePipelineStrategy(current.project.pipeline, target.id, current.task);
    const policy = resolveExecutionPolicy(current.project.pipeline, target.id, current.task, current.project.execution);
    if (!semantic) {
      // Leaving the stage engine for a custom column: a new conversation starts there, as on a first arrival.
      if (decision !== 'move' && (strategy.autoSpawn || decision === 'start')) return { task: await this.#taskNow(taskId), run: await this.#pipelineStart(taskId, { column: target.id, move, trigger }) };
      return { task: await this.store.update(draft => { const result = this.#place(draft, taskId, move); delete result.archivedAt; result.stageOutcome = null; return result; }) };
    }
    const hasWorkspace = current.task.workspace?.status === 'ready';
    if (hasWorkspace) await this.ensureTaskWorktree(taskId);
    const rev = hasWorkspace ? await this.delivery.revision(taskId) : null;
    const needWorkspace = () => { if (!rev) throw new BoardError(`${name(target.id)} needs the task worktree. Run a Planning or Executing column first.`, 'WORKSPACE_REQUIRED', 409); };
    if (semantic === 'code_review') {
      needWorkspace();
      if (rev.unresolved.length) throw conflict(`These files still contain conflict markers: ${rev.unresolved.slice(0, 10).join(', ')}. Resolve them first.`, 'CONFLICT_MARKERS');
      if (!rev.clean || rev.merging) await this.delivery.commit(taskId, { message: this.#checkpointMessage(current.project, current.task, task.column, rev.merging), confirm: true });
      else if (!rev.ahead) throw conflict('The task branch has no changes to review.', 'NO_CHANGES');
    }
    if (semantic === 'testing' || semantic === 'merge') {
      needWorkspace();
      if (rev.merging) throw conflict('A merge is in progress in the task worktree. Commit or abort it first.', 'MERGE_IN_PROGRESS');
      const gate = await this.#evidenceGate(taskId, semantic);
      if (gate.problems.length) throw new BoardError(`${name(target.id)} is not ready: ${gate.problems.join(' ')}`, 'STAGE_NOT_READY', 409);
      if (gate.acceptReview) await this.delivery.acceptReview(taskId);
    }
    if (semantic === 'executing') {
      const notes = await this.#reworkNotes(taskId, from);
      if (notes) await this.updateTaskEvidence(taskId, item => {
        item.reworkNotes = notes.text.slice(0, 20000);
        if (notes.review && item.evidence?.review) item.evidence.review = { ...item.evidence.review, status: 'changes_requested' };
      });
    }
    const start = decision !== 'move' && (strategy.autoSpawn || decision === 'start');
    if (semantic === 'merge') {
      const placed = await this.store.update(draft => { const result = this.#place(draft, taskId, move); delete result.archivedAt; result.stageOutcome = null; return result; });
      if (!start) return { task: placed };
      // Merge is Promptboard's own Git operation; an agent runs only to resolve conflicts.
      const merge = await this.#prepareMerge(taskId, { auto: policy.completion === 'automatic', runLocked: true });
      return { task: merge.task || await this.#taskNow(taskId), merge, merged: merge.state === 'merged' };
    }
    if (!start) {
      const placed = await this.store.update(draft => { const result = this.#place(draft, taskId, move); delete result.archivedAt; result.stageOutcome = null; return result; });
      return { task: placed };
    }
    const run = await this.#startRun(taskId, { stage: target.id, consent: true, trigger: trigger === 'automation' ? 'automation' : 'user', move });
    return { task: await this.#taskNow(taskId), run };
  }

  #checkpointMessage(project, task, columnId, merging = false) {
    const ref = Number.isInteger(task.number) ? `#${task.number}` : task.id.slice(0, 8);
    return merging ? `promptboard(${ref}): merge ${project.targetBranch?.name || 'target'} into the task branch` : `promptboard(${ref}): ${columnTitleIn(project, columnId)} checkpoint\n\n${task.title}`;
  }

  /** Save the stage engine's outcome on the card and in its bounded stage history. */
  async #recordOutcome(taskId, run, status, { code = '', reason = '', findings, checkpointCommit, testsId, next } = {}) {
    if (!OUTCOME_STATUSES.has(status)) throw new BoardError('Unknown stage outcome.', 'INVALID_OUTCOME', 500);
    return this.store.update(state => {
      const { task } = this.#task(state, taskId);
      const outcome = { columnId: run.stage, stage: run.stageKind, runId: run.id, status, at: Date.now(), ...(code ? { code } : {}), ...(reason ? { reason: clip(reason, 2000) } : {}),
        ...(findings?.length ? { findings: findings.slice(0, 50) } : {}), ...(checkpointCommit ? { checkpointCommit } : {}), ...(testsId ? { testsId } : {}), ...(next ? { next } : {}) };
      task.stageOutcome = outcome;
      if (!['working', 'verifying'].includes(status)) task.stageHistory = [...(task.stageHistory || []), { columnId: run.stage, stage: run.stageKind, runId: run.id, provider: run.config?.provider || '',
        status, at: outcome.at, ...(code ? { code } : {}), ...(reason ? { reason: clip(reason, 300) } : {}), ...(checkpointCommit ? { checkpointCommit } : {}) }].slice(-50);
      task.revision++;
      return outcome;
    });
  }

  /** A run can be completed when its turn is finished and nothing is outstanding (tools, questions, unconfirmed input). */
  #turnFinished(run) {
    return run?.status === 'waiting_for_input' && run.turnComplete === true && run.turns > 0 && (run.activity ? run.activity.ready !== false : true);
  }

  /**
   * Complete a stage-engine run: the same steps for the Complete button, a move, automatic completion and Autopilot.
   * Planning must leave a plan and an unchanged worktree; Executing gets a checkpoint commit; Code Review's verdict is
   * read from its structured result; Testing hands over to Promptboard's own test run; a merge agent's resolution is
   * committed and sent back to review. Returns the recorded outcome.
   */
  async #finishStageRun(taskId, runId, { by = 'user' } = {}) {
    let state = await this.state();
    let run = state.runs.find(item => item.id === runId && item.taskId === taskId);
    if (!run?.stageKind) throw conflict('This run does not belong to a typed column.', 'NOT_A_STAGE_RUN');
    const { task } = this.#task(state, taskId);
    if (run.status === 'succeeded') return task.stageOutcome?.runId === runId ? task.stageOutcome : null;
    if (!this.#turnFinished(run)) throw conflict('Complete the stage after the agent has finished its turn and nothing is waiting for an answer.', 'NOT_CONFIRMABLE');
    const stage = run.stageKind;
    if (stage === 'planning') {
      const rev = await this.delivery.revision(taskId);
      if (!rev.clean || rev.taskCommit !== run.startCommit) {
        await this.executor.cancel(runId).catch(() => {});
        return this.#recordOutcome(taskId, run, 'failed', { code: 'PLAN_MODIFIED_WORKSPACE', reason: 'The planning agent changed the task worktree, which Planning must never do. Review the changes in the worktree before continuing.' });
      }
      if (!run.hasPlan) return this.#recordOutcome(taskId, run, 'failed', { code: 'PLAN_MISSING', reason: 'The planning agent finished its turn without a plan. Continue in its terminal, then complete the stage again.' });
    }
    await this.executor.confirm(runId);
    state = await this.state(); run = state.runs.find(item => item.id === runId);
    const reasonBy = by === 'automatic' ? 'Completed automatically.' : by === 'automation' ? 'Completed by Autopilot.' : 'Completed by you.';
    if (stage === 'planning') return this.#recordOutcome(taskId, run, 'succeeded', { reason: `Plan accepted. ${reasonBy}` });
    if (stage === 'executing') {
      let rev = await this.delivery.revision(taskId);
      if (rev.merging) return this.#recordOutcome(taskId, run, 'failed', { code: 'MERGE_IN_PROGRESS', reason: 'A merge is in progress in the task worktree. Commit or abort it, then complete the stage again.' });
      if (!rev.clean) rev = await this.delivery.commit(taskId, { message: this.#checkpointMessage(this.#project(state, run.projectId), task, run.stage), confirm: true });
      if (!rev.ahead) return this.#recordOutcome(taskId, run, 'failed', { code: 'NO_CHANGES', reason: 'The agent made no changes to the task branch.' });
      return this.#recordOutcome(taskId, run, 'succeeded', { checkpointCommit: rev.taskCommit, reason: reasonBy });
    }
    if (stage === 'code_review') {
      const review = this.#task(state, taskId).task.evidence?.review;
      if (review?.runId !== runId || review.verdict === 'unknown' || !review.parsed) return this.#recordOutcome(taskId, run, 'failed', { code: 'INVALID_REVIEW_RESULT', reason: 'The review did not end with a valid JSON verdict ({"verdict", "findings"}). Ask the reviewer to finish with the structured result, or review again.' });
      if (review.verdict === 'no_issues') { await this.delivery.acceptReview(taskId); return this.#recordOutcome(taskId, run, 'succeeded', { reason: `No issues found. ${reasonBy}` }); }
      return this.#recordOutcome(taskId, run, 'changes_required', { findings: review.findings, next: 'executing', reason: `${review.findings.length} ${review.findings.length === 1 ? 'finding' : 'findings'} to fix.` });
    }
    if (stage === 'testing') {
      const rev = await this.delivery.revision(taskId);
      // Name the files: a tool folder (for example an MCP server's .serena/) belongs in .gitignore, not in the task.
      if (!rev.clean) return this.#recordOutcome(taskId, run, 'changes_required', { next: 'executing', code: 'TESTER_CHANGED_FILES', reason: `The testing agent changed files (${rev.changes.slice(0, 5).map(line => line.slice(3)).join(', ')}${rev.changes.length > 5 ? ', …' : ''}). They go back to Executing so they are committed, reviewed and tested; files a tool writes on its own belong in the repository's .gitignore.` });
      const tests = this.#task(await this.state(), taskId).task.evidence?.tests;
      // recordStageResult (during confirm) started Promptboard's own test run of the configured commands.
      if (tests?.status === 'running' && tests.taskCommit === rev.taskCommit) return this.#recordOutcome(taskId, run, 'verifying', { testsId: tests.id, reason: 'Promptboard is running the configured test commands.' });
      const project = this.#project(state, run.projectId);
      if (!(project.testCommands || []).length) return this.#recordOutcome(taskId, run, 'failed', { code: 'NO_TEST_COMMANDS', reason: 'Testing needs the project’s test commands. Add them in the Kanban settings; only their exit codes decide.' });
      const started = await this.delivery.runTests(taskId, { confirm: true }).catch(error => ({ error }));
      if (started.error) return this.#recordOutcome(taskId, run, 'failed', { code: started.error.code || 'VERIFICATION_FAILED', reason: started.error.message });
      return this.#recordOutcome(taskId, run, 'verifying', { testsId: started.id, reason: 'Promptboard is running the configured test commands.' });
    }
    if (stage === 'merge') {
      const rev = await this.delivery.revision(taskId);
      if (rev.unresolved.length) return this.#recordOutcome(taskId, run, 'failed', { code: 'MERGE_CONFLICT_UNRESOLVED', reason: `Conflict markers remain in ${rev.unresolved.slice(0, 10).join(', ')}.` });
      let checkpoint = rev.taskCommit;
      if (rev.merging || !rev.clean) checkpoint = (await this.delivery.commit(taskId, { message: this.#checkpointMessage(this.#project(state, run.projectId), task, run.stage, rev.merging), confirm: true })).taskCommit;
      return this.#recordOutcome(taskId, run, 'changes_required', { next: 'code_review', checkpointCommit: checkpoint, reason: 'The conflicts were resolved. The new commit is reviewed and tested again before it merges.' });
    }
    return this.#recordOutcome(taskId, run, 'succeeded', { reason: reasonBy });
  }

  /** The Complete button of a typed column (manual completion). Same steps as automatic completion and Autopilot. */
  completeStage(taskId, { runId } = {}) {
    return this.#locked(`transition:${taskId}`, async () => {
      const state = await this.state(), { task } = this.#task(state, taskId);
      const run = state.runs.find(item => item.id === (runId || task.stageOutcome?.runId) && item.taskId === taskId);
      if (!run) throw conflict('This card has no stage run to complete.', 'NOT_CONFIRMABLE');
      return { task: await this.#taskNow(taskId), outcome: await this.#finishStageRun(taskId, run.id, { by: 'user' }) };
    });
  }

  /**
   * Board-side follow-up of the stage engine (each tick, for every typed column; Autopilot uses the same outcomes):
   * automatic completion of finished turns, the end of Promptboard's test runs, and runs that stopped.
   */
  async #advanceStageEngine(state) {
    for (const project of state.projects) {
      if (project.workflowMode !== 'pipeline') continue;
      for (const task of project.tasks) {
        const outcome = task.stageOutcome;
        // A reported question that was answered: the same live run works again, so its stage continues.
        if (outcome?.status === 'failed' && outcome.code === 'PERMISSION_REQUIRED' && outcome.columnId === task.column) {
          const run = state.runs.find(item => item.id === outcome.runId);
          if (run && ACTIVE_RUN_STATUSES.includes(run.status) && !(run.status === 'waiting_for_input' && !run.turnComplete)) await this.#locked(`transition:${task.id}`, () => this.#recordOutcome(task.id, run, 'working', { reason: 'The question was answered; the stage continues.' })).catch(() => {});
          continue;
        }
        if (!outcome || !['working', 'verifying'].includes(outcome.status) || !columnStage(project, task.column) || outcome.columnId !== task.column) continue;
        await this.#locked(`transition:${task.id}`, async () => {
          const fresh = await this.state(), { project: owner, task: card } = this.#task(fresh, task.id), current = card.stageOutcome;
          if (!current || current.runId !== outcome.runId || current.status !== outcome.status) return;
          const run = fresh.runs.find(item => item.id === current.runId);
          if (!run) return;
          if (current.status === 'verifying') {
            const tests = card.evidence?.tests;
            if (!tests || tests.id !== current.testsId) return this.#recordOutcome(task.id, run, 'failed', { code: 'VERIFICATION_FAILED', reason: 'The test run record is missing. Move the card to Testing again.' });
            if (tests.status === 'running') {
              if (!this.delivery.testsRunning.has(task.id)) return this.#recordOutcome(task.id, run, 'failed', { code: 'VERIFICATION_INTERRUPTED', reason: 'The test run stopped (the app restarted). Move the card to Testing again.' });
              return;
            }
            if (tests.status === 'passed') return this.#recordOutcome(task.id, run, 'succeeded', { reason: 'Every configured test command passed.' });
            const failed = (tests.results || []).filter(result => result.status !== 'passed').map(result => `${result.argv.join(' ')}: ${result.reason || `exit ${result.exitCode}`}`).join('; ');
            return this.#recordOutcome(task.id, run, 'changes_required', { code: 'VERIFICATION_FAILED', next: 'executing', reason: tests.status === 'invalid' ? 'The task commit changed while the tests ran.' : `Tests failed: ${failed || tests.status}` });
          }
          if (['failed', 'cancelled', 'interrupted'].includes(run.status)) return this.#recordOutcome(task.id, run, 'failed', { code: run.errorCode || (run.status === 'interrupted' ? 'AGENT_INTERRUPTED' : 'AGENT_STOPPED'), reason: run.reason || `The agent ${run.status}.` });
          const policy = resolveExecutionPolicy(owner.pipeline, card.column, card, owner.execution);
          // An autonomous column should never wait for a person. A question or permission prompt that persists is
          // reported (Autopilot pauses on it); answering it in the terminal lets the stage continue.
          const asking = run.status === 'waiting_for_input' && !run.turnComplete && (run.activity?.permissionPending || /answer|permission|asking/i.test(run.waitingReason || ''));
          if (policy.interaction === 'autonomous' && asking) {
            const since = (this.askingSince ??= new Map()).get(run.id) ?? Date.now(); this.askingSince.set(run.id, since);
            if (Date.now() - since >= 5000) return this.#recordOutcome(task.id, run, 'failed', { code: 'PERMISSION_REQUIRED', reason: `The ${policy.stage.replace('_', ' ')} agent is waiting for an answer in its terminal although this column is autonomous: ${run.waitingReason || 'a permission prompt'}. Answer it there; the stage continues by itself.` });
            return;
          }
          this.askingSince?.delete(run.id);
          if (policy.completion === 'automatic' && this.#turnFinished(run)) await this.#finishStageRun(task.id, run.id, { by: 'automatic' });
        }).catch(async error => {
          const latest = (await this.state()).runs.find(item => item.id === outcome.runId);
          if (latest) await this.#recordOutcome(task.id, latest, 'failed', { code: error.code || 'STAGE_FAILED', reason: error.message }).catch(() => {});
        });
      }
    }
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
    // A blocked move never releases its deferred starts: a run parked there would stay queued until Stop automations.
    if (this.automationMoves.get(taskId)?.blocked) throw conflict('This card’s column automations are blocked. Stop them from the card before starting its agent.', 'AUTOMATIONS_ACTIVE');
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
    const job = this.automationMoves.get(taskId);
    if (job?.deferNativeStart && !job.blocked) this.deferredPipelineStarts.set(run.id, payload);
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
      const run = state.runs.find(item => item.id === runId && item.taskId === taskId && runStage(item) === 'planning');
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
