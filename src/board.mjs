/**
 * Agentic Kanban service (PB-01). Owns the column model, validated task transitions,
 * the run records, browser-board migration, import/export, repository links, and task
 * worktrees. See docs/agentic-kanban-contract.md.
 *
 * Nothing here launches an agent. Runs need an executor (PB-02); without one, run
 * requests are refused before any worktree is created.
 */
import { randomUUID } from 'node:crypto';
import { access, mkdir, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { Store } from './store.mjs';
import { branchExists, commitExists, git, GitError, listWorktrees, validateRepository } from './git.mjs';
import { resolveConfig } from './agents.mjs';
import { Delivery } from './delivery.mjs';

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
export const RUN_STATUSES = Object.freeze(['queued', 'running', 'waiting_for_input', 'succeeded', 'failed', 'cancelled', 'interrupted']);
export const ACTIVE_RUN_STATUSES = Object.freeze(['queued', 'running', 'waiting_for_input']);
// Succeeded is reached only through an explicit user confirmation (supervisor.confirm).
const RUN_NEXT = { queued: ['running', 'cancelled', 'failed', 'interrupted'], running: ['waiting_for_input', 'succeeded', 'failed', 'cancelled', 'interrupted'],
  waiting_for_input: ['running', 'succeeded', 'cancelled', 'failed', 'interrupted'] };
// Stages the PB-02 executor implements. Code Review, Testing, and Merge arrive in PB-04.
const EXECUTABLE_STAGES = new Set(['planning', 'executing', 'code_review']);
// Per-stage workflow settings. Projects store overrides; defaults apply otherwise.
// To Do, Merge, and Done have no run policy: To Do and Done never run, and a merge always needs confirmation.
export const WORKFLOW_STAGES = Object.freeze(['planning', 'executing', 'code_review', 'testing', 'merge']);
const POLICIES = ['manual', 'ask', 'start'];
export const DEFAULT_STAGE_SETTINGS = Object.freeze({ policy: 'ask', provider: 'claude', model: '', effort: '', permissionMode: '', instructions: '' });
const RUN_FIELDS = ['hasReview', 'startedAt', 'endedAt', 'providerSessionId', 'waitingReason', 'errorCode', 'exitCode', 'hasPlan', 'planExcerpt', 'turns', 'lifecycle'];
// Stages whose first authorized run may create the task branch and worktree.
const WORKSPACE_STAGES = new Set(['planning', 'executing']);

const PROJECT_LIMIT = 200;
const TASK_LIMIT = 1000;
const MAX_PROMPT = 2 * 1024 * 1024;
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
function promptText(value, label) {
  // The prompt is kept exactly as given, including whitespace and line endings.
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_PROMPT) throw new BoardError(`${label} needs a prompt of 1 to ${MAX_PROMPT.toLocaleString('en-US')} characters.`, 'INVALID_INPUT');
  return value;
}
const clip = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const time = value => Number.isFinite(value) ? value : Date.now();

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
  catch (error) { throw error instanceof BoardError ? new BoardError(error.message, 'INVALID_BACKUP') : error; }
}
function parseBackupData(data) {
  const v1 = data?.version === 1 && (data.kind === undefined || data.kind === 'kanban-backup');
  const v2 = data?.version === 2 && data.kind === 'promptboard-backup';
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
    return {
      id: unique(project.id, label), name, createdAt: time(project.createdAt),
      repositoryPath: v2 && typeof project.repository?.path === 'string' ? project.repository.path.slice(0, 4096) : null,
      targetBranch: v2 && typeof project.targetBranch?.name === 'string' ? project.targetBranch.name.slice(0, 255) : null,
      // Imported workflow settings (including legacy automation) are kept for confirmation only.
      workflow: v2 && project.workflow && typeof project.workflow === 'object' ? project.workflow : v2 && project.automation?.autoRun === true ? { executing: { policy: 'start' } } : null,
      // Imported test commands never run until the user confirms them.
      testCommands: v2 && Array.isArray(project.testCommands) && project.testCommands.length ? project.testCommands.slice(0, 20) : null,
      tasks: cards.map((card, cardIndex) => {
        const cardLabel = `${label}, card ${cardIndex + 1}`;
        if (!card || typeof card !== 'object') throw new BoardError(`${cardLabel} is not valid.`, 'INVALID_BACKUP');
        return { id: unique(card.id, cardLabel), title: text(card.title, 120, `${cardLabel} title`), prompt: promptText(card.prompt, cardLabel),
          createdAt: time(card.createdAt), updatedAt: time(card.updatedAt ?? card.createdAt), checksOutdated: card.checksOutdated === true,
          source: normalizeSource(card.source), column: v2 && COLUMN_IDS.includes(card.column) ? card.column : 'todo' };
      }),
    };
  });
  return { projects };
}

function newProject({ id = randomUUID(), name, createdAt = Date.now() }) {
  return { id, name, createdAt, revision: 1, repository: null, targetBranch: null, workflow: {}, pendingImport: null, tasks: [] };
}
function newTask({ id = randomUUID(), title, prompt, source = null, checksOutdated = false, createdAt = Date.now(), updatedAt = createdAt, column = 'todo' }) {
  // contentRevision changes only when the title or prompt changes; plan approvals refer to it.
  return { id, title, prompt, source, checksOutdated, createdAt, updatedAt, column, revision: 1, contentRevision: 1, planApproval: null, workspace: null, retainedBranches: [], transitions: [] };
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
    const entry = { policy: settings.policy, instructions: settings.instructions };
    if (EXECUTABLE_STAGES.has(stage)) {
      try { Object.assign(entry, resolveConfig(stage, settings)); }
      catch (error) { throw new BoardError(error.message, 'INVALID_WORKFLOW'); }
    }
    result[stage] = entry;
  }
  return result;
}

/** Defaults merged with a project's overrides. */
export function effectiveWorkflow(project) {
  return Object.fromEntries(WORKFLOW_STAGES.map(stage => {
    // Merge stays manual unless a project turns on automatic merging.
    const base = { ...DEFAULT_STAGE_SETTINGS, ...(stage === 'merge' ? { policy: 'manual' } : {}), ...(EXECUTABLE_STAGES.has(stage) ? resolveConfig(stage, {}) : {}) };
    return [stage, { ...base, ...(project?.workflow?.[stage] || {}) }];
  }));
}

/** Allowed column moves. Reordering inside a column is always allowed. */
export function canTransition(from, to) {
  const a = COLUMN_IDS.indexOf(from), b = COLUMN_IDS.indexOf(to);
  if (a < 0 || b < 0) return false;
  if (a === b) return true;
  if (from === 'done') return to === 'todo'; // Reopen only.
  if (b === a + 1) return true; // Forward one stage.
  if (from === 'todo' && to === 'executing') return true; // Planning is optional.
  return b < a; // Send back for rework.
}

function checkRevision(entity, expected, label) {
  if (!Number.isInteger(expected)) throw new BoardError('Include the expected revision.', 'REVISION_REQUIRED');
  if (entity.revision !== expected) throw conflict(`${label} changed since you loaded it. Reload the board and try again.`);
}

const inside = (parent, child) => { const rel = relative(parent, child); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
const slug = value => value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';

export class Board {
  constructor({ dataDir, executor = null }) {
    this.dataDir = dataDir;
    this.store = new Store(dataDir);
    this.worktreeRoot = join(dataDir, 'worktrees');
    this.hooksDir = join(dataDir, 'no-hooks'); // Empty: git worktree add runs no repository hooks.
    this.executor = executor; // PB-02 registers one. Null means execution is inactive.
    this.locks = new Map();
    this.recovered = false;
    this.delivery = new Delivery(this);
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
    const state = await this.store.read();
    if (!this.recovered) {
      this.recovered = true;
      if (state.runs.some(run => ACTIVE_RUN_STATUSES.includes(run.status))) {
        await this.store.update(draft => {
          for (const run of draft.runs) if (ACTIVE_RUN_STATUSES.includes(run.status)) Object.assign(run, { status: 'interrupted', updatedAt: Date.now(), reason: 'The app stopped while this run was active.' });
        });
      }
    }
    return this.store.read();
  }

  async view() {
    const state = await this.state();
    return { revision: state.revision, columns: COLUMNS, settings: state.settings, runs: state.runs.slice(-500),
      projects: state.projects.map(project => ({ ...project, effectiveWorkflow: effectiveWorkflow(project) })),
      execution: this.executor?.describe ? await this.executor.describe() : { available: Boolean(this.executor) }, recovery: this.store.recovery };
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

  async createProject({ name }) {
    const clean = text(name, 80, 'Project name');
    return this.store.update(state => {
      if (state.projects.length >= PROJECT_LIMIT) throw new BoardError(`A board can have at most ${PROJECT_LIMIT} projects.`, 'LIMIT');
      this.#nameError(state, clean);
      const project = newProject({ name: clean });
      state.projects.push(project);
      return project;
    });
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
      if (this.#hasWorkspaceOrRun(state, [project])) throw conflict('Remove the task worktrees in this project first. Promptboard never deletes worktrees with a whole project.', 'WORKSPACES_EXIST');
      state.projects = state.projects.filter(item => item.id !== id);
      state.runs = state.runs.filter(run => run.projectId !== id);
    });
  }

  /** Validate a repository path without saving it. */
  validateRepository(path) { return validateRepository(path); }

  async linkRepository(id, { path, expectedRevision }) {
    const repository = path === null ? null : await validateRepository(path);
    return this.store.update(state => {
      const project = this.#project(state, id);
      checkRevision(project, expectedRevision, 'This project');
      if (project.tasks.some(task => task.workspace)) throw conflict('Tasks in this project have worktrees in the current repository. Remove them before you change the link.', 'WORKSPACES_EXIST');
      project.repository = repository && { path: path.trim(), root: repository.root, commonDir: repository.commonDir, linkedWorktree: repository.linkedWorktree, validatedAt: Date.now() };
      // A different repository makes the recorded target branch meaningless.
      if (!repository || project.targetBranch?.root !== repository.root) project.targetBranch = null;
      project.revision++;
      return { project, repository };
    });
  }

  async setWorkflow(id, { workflow, expectedRevision }) {
    const clean = normalizeWorkflow(workflow);
    return this.store.update(state => {
      const project = this.#project(state, id);
      checkRevision(project, expectedRevision, 'This project');
      project.workflow = clean; // Applies to future runs only; active runs keep their snapshot.
      project.revision++;
      return project;
    });
  }

  /**
   * The shared move path for drag-and-drop and keyboard moves. The move is recorded first.
   * Only then, for a Planning or Executing column set to "Start on entry", a run is
   * requested as a separate, recorded event. "Ask on entry" returns a question for the UI.
   */
  async transition(id, { column, index, expectedRevision }) {
    const before = this.#task(await this.state(), id);
    const from = before.task.column;
    const task = await this.moveTask(id, { column, index, expectedRevision });
    const result = { task };
    if (from === column || !WORKFLOW_STAGES.includes(column)) return result;
    const settings = effectiveWorkflow(before.project)[column];
    if (settings.policy === 'ask') result.ask = { stage: column };
    if (settings.policy === 'start') {
      // Testing runs the project's approved commands; Merge merges only when every check holds for
      // the current commits (the same gate as a confirmed merge); the agent stages request a run.
      try {
        if (column === 'testing') result.tests = await this.delivery.runTests(id, { confirm: true });
        else if (column === 'merge') {
          const preview = await this.delivery.mergePreview(id);
          if (!preview.eligible) throw new BoardError(`Not merged automatically: ${preview.problems.join(' ')}`, 'MERGE_NOT_ELIGIBLE');
          result.task = await this.delivery.merge(id, { confirm: true, taskCommit: preview.taskCommit, targetCommit: preview.targetCommit, trigger: 'automation' });
          result.merged = true;
        } else result.run = await this.requestRun(id, { stage: column, consent: true, trigger: 'automation' });
      } catch (error) { result.automation = { started: false, code: error.code || 'FAILED', message: error.message }; }
    }
    return result;
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

  /** The only path into Done: a verified merge or an explicit no-change completion. */
  async completeTask(id, { kind, details }) {
    return this.store.update(state => {
      const { project, task } = this.#task(state, id);
      if (this.#activeRun(state, id)) throw conflict('This card has an active run.', 'RUN_ACTIVE');
      task.completion = { kind, at: Date.now(), ...details };
      task.transitions = [...task.transitions, { at: Date.now(), from: task.column, to: 'done', by: kind }].slice(-TRANSITION_LOG_LIMIT);
      task.column = 'done';
      project.tasks = [...project.tasks.filter(item => item !== task), task];
      task.revision++;
      return task;
    });
  }

  /** Re-read the linked repository's local branches. */
  async listProjectBranches(id) {
    const project = this.#project(await this.state(), id);
    if (!project.repository) throw new BoardError('Link a Git repository first.', 'REPOSITORY_REQUIRED');
    return validateRepository(project.repository.root);
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
      if (accept) {
        if (repository) {
          project.repository = { path: pending.repositoryPath, root: repository.root, commonDir: repository.commonDir, linkedWorktree: repository.linkedWorktree, validatedAt: Date.now() };
          const branch = repository.branches.find(item => item.name === pending.targetBranch);
          project.targetBranch = branch ? { name: branch.name, commit: branch.commit, root: repository.root, recordedAt: Date.now() } : null;
        }
        if (pending.workflow) project.workflow = normalizeWorkflow(pending.workflow);
        if (pending.testCommands) project.testCommands = pending.testCommands.filter(item => Array.isArray(item?.argv) && item.argv.length && item.argv.every(arg => typeof arg === 'string' && arg.length <= 1000 && !arg.includes('\0'))).slice(0, 20).map(item => ({ label: String(item.label || item.argv.join(' ')).slice(0, 80), argv: item.argv.slice(0, 50), timeoutSec: Number.isInteger(item.timeoutSec) && item.timeoutSec >= 1 && item.timeoutSec <= 3600 ? item.timeoutSec : 600 }));
      }
      project.pendingImport = null;
      project.revision++;
      return project;
    });
  }

  // ---- Tasks ----

  async createTask({ projectId, title, prompt, source = null }) {
    const task = newTask({ title: text(title, 120, 'Title'), prompt: promptText(prompt, 'The task'), source: normalizeSource(source) });
    return this.store.update(state => {
      const project = this.#project(state, projectId);
      if (project.tasks.length >= TASK_LIMIT) throw new BoardError(`A project can have at most ${TASK_LIMIT} cards.`, 'LIMIT');
      project.tasks.push(task); // New cards always start in To Do and never start a run.
      return task;
    });
  }

  async updateTask(id, { title, prompt, expectedRevision }) {
    return this.store.update(state => {
      const { task } = this.#task(state, id);
      checkRevision(task, expectedRevision, 'This card');
      const nextTitle = title === undefined ? task.title : text(title, 120, 'Title');
      const nextPrompt = prompt === undefined ? task.prompt : promptText(prompt, 'The task');
      if (nextTitle === task.title && nextPrompt === task.prompt) return { task, changed: false };
      // Checks from generation apply only to the original text.
      // A content change also makes any earlier plan approval stale.
      Object.assign(task, { title: nextTitle, prompt: nextPrompt, updatedAt: Date.now(), checksOutdated: task.checksOutdated || Boolean(task.source), revision: task.revision + 1, contentRevision: (task.contentRevision ?? 1) + 1 });
      return { task, changed: true };
    });
  }

  async duplicateTask(id) {
    return this.store.update(state => {
      const { project, task } = this.#task(state, id);
      if (project.tasks.length >= TASK_LIMIT) throw new BoardError(`A project can have at most ${TASK_LIMIT} cards.`, 'LIMIT');
      const copy = newTask({ title: `${task.title.slice(0, 113)} (copy)`, prompt: task.prompt, source: structuredClone(task.source), checksOutdated: task.checksOutdated });
      project.tasks.splice(project.tasks.indexOf(task) + 1, 0, copy); // A copy starts in To Do with no workspace.
      return copy;
    });
  }

  /**
   * Move a task to a column and a position in that column. A move records a transition;
   * it never proves that a stage succeeded and never starts a run.
   */
  async moveTask(id, { column, index, expectedRevision }) {
    return this.store.update(state => {
      const { project, task } = this.#task(state, id);
      checkRevision(task, expectedRevision, 'This card');
      if (!COLUMN_IDS.includes(column)) throw new BoardError('Choose a valid column.', 'INVALID_COLUMN');
      if (!canTransition(task.column, column)) throw new BoardError(`A card cannot move from ${title(task.column)} to ${title(column)}.`, 'TRANSITION_NOT_ALLOWED');
      if (task.column !== column && this.#activeRun(state, id)) throw conflict('This card has an active run. Wait for it to finish or cancel it first.', 'RUN_ACTIVE');
      if (task.column === 'todo' && column !== 'todo' && !project.repository) throw new BoardError('Link this project to a Git repository before cards leave To Do.', 'REPOSITORY_REQUIRED');
      // Done means merged and verified, or explicitly completed with no changes. A drag cannot skip that.
      if (column === 'done' && task.column !== 'done') throw new BoardError('A card reaches Done only through a confirmed merge or “Reviewed: no changes required”.', 'DONE_REQUIRES_MERGE');
      if (task.column === 'done' && column !== 'done' && task.completion) { task.previousCompletions = [...(task.previousCompletions || []), task.completion].slice(-10); task.completion = null; }
      const others = project.tasks.filter(item => item !== task);
      const inColumn = others.filter(item => item.column === column);
      const position = Number.isInteger(index) ? Math.max(0, Math.min(index, inColumn.length)) : inColumn.length;
      const before = inColumn[position];
      const at = before ? others.indexOf(before) : (inColumn.length ? others.indexOf(inColumn.at(-1)) + 1 : others.length);
      if (task.column !== column) {
        task.transitions = [...task.transitions, { at: Date.now(), from: task.column, to: column, by: 'user' }].slice(-TRANSITION_LOG_LIMIT);
        task.column = column;
      }
      others.splice(at, 0, task);
      project.tasks = others;
      task.revision++;
      return task;
    });
  }

  async deleteTask(id, { expectedRevision }) {
    const { task } = this.#task(await this.state(), id);
    checkRevision(task, expectedRevision, 'This card');
    let revision = expectedRevision;
    // A task that owns a worktree is removed only after that worktree is removed safely.
    if (task.workspace) revision = (await this.removeTaskWorktree(id)).revision;
    return this.store.update(state => {
      const { project, task: current } = this.#task(state, id);
      checkRevision(current, revision, 'This card');
      if (this.#activeRun(state, id)) throw conflict('This card has an active run.', 'RUN_ACTIVE');
      project.tasks = project.tasks.filter(item => item.id !== id);
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
          project = newProject({ id: incoming.id, name, createdAt: incoming.createdAt });
          state.projects.push(project);
          projects++;
        }
        for (const card of incoming.tasks) {
          if (taskIds.has(card.id)) { skipped++; continue; }
          if (project.tasks.length >= TASK_LIMIT) throw new BoardError(`A project can have at most ${TASK_LIMIT} cards.`, 'LIMIT');
          project.tasks.push(newTask({ ...card, column: 'todo' }));
          taskIds.add(card.id);
          cards++;
        }
      }
      state.migrations.push({ kind: 'browser-kanban-v1', at: Date.now(), projects, cards, skipped });
      return { projects, cards, skipped };
    });
  }

  async exportBackup() {
    const state = await this.state();
    return { application: 'Promptboard', kind: 'promptboard-backup', version: 2, exportedAt: new Date().toISOString(),
      projects: state.projects.map(project => ({ id: project.id, name: project.name, createdAt: project.createdAt,
        repository: project.repository ? { path: project.repository.path } : null, targetBranch: project.targetBranch ? { name: project.targetBranch.name } : null,
        workflow: project.workflow || {}, testCommands: project.testCommands || [],
        // Workspaces and runs are machine-specific and are not exported.
        tasks: project.tasks.map(task => ({ id: task.id, title: task.title, prompt: task.prompt, source: task.source, checksOutdated: task.checksOutdated,
          createdAt: task.createdAt, updatedAt: task.updatedAt, column: task.column })) })) };
  }

  /**
   * Replace the board with a backup. Execution state is not imported; repository paths
   * and automation settings wait for confirmation per project. Nothing runs.
   */
  async importBackup(data, { replace = false } = {}) {
    const parsed = parseBackup(data);
    return this.store.update(state => {
      if (state.projects.length && !replace) throw conflict('Confirm that the import replaces the current board.', 'CONFIRMATION_REQUIRED');
      if (this.#hasWorkspaceOrRun(state)) throw conflict('Tasks on the current board own worktrees or runs. Remove those worktrees before you replace the board.', 'WORKSPACES_EXIST');
      state.projects = parsed.projects.map(incoming => {
        const project = newProject(incoming);
        project.tasks = incoming.tasks.map(task => newTask(task));
        if (incoming.repositoryPath || incoming.targetBranch || incoming.workflow || incoming.testCommands) {
          project.pendingImport = { repositoryPath: incoming.repositoryPath, targetBranch: incoming.targetBranch, workflow: incoming.workflow, testCommands: incoming.testCommands };
        }
        return project;
      });
      state.runs = [];
      return { projects: state.projects.length, cards: state.projects.reduce((sum, project) => sum + project.tasks.length, 0) };
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
   * Return the task's worktree, creating it once from the recorded target commit.
   * Concurrent and repeated calls get the same branch and folder.
   */
  ensureTaskWorktree(taskId) {
    return this.#locked(`task:${taskId}`, async () => {
      const state = await this.state();
      const { project, task } = this.#task(state, taskId);
      const repository = await this.#checkedRepository(project);
      if (task.workspace?.status === 'ready') {
        const found = await this.#registered(repository.root, task.workspace.path);
        if (!found) throw new BoardError('The task worktree is missing or no longer registered with Git. Check it with git worktree list.', 'WORKTREE_MISSING', 409);
        return task.workspace;
      }
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
  requestRun(taskId, { stage, consent = false, config = {}, trigger = 'user' } = {}) {
    return this.#locked(`run:${taskId}`, async () => {
      const state = await this.state();
      const { project, task } = this.#task(state, taskId);
      const column = COLUMNS.find(item => item.id === stage);
      if (!column) throw new BoardError('Choose a valid stage.', 'INVALID_COLUMN');
      if (!column.agent) throw new BoardError(`${column.title} never runs an agent.`, 'STAGE_NOT_RUNNABLE');
      if (task.column !== stage) throw conflict(`The card is in ${title(task.column)}, not ${column.title}.`, 'STAGE_MISMATCH');
      if (this.#activeRun(state, taskId)) throw conflict('This card already has an active run.', 'RUN_ACTIVE');
      if (consent !== true) throw new BoardError('Starting an agent needs your explicit confirmation.', 'CONSENT_REQUIRED');
      if (!project.repository) throw new BoardError('Link this project to a Git repository first.', 'REPOSITORY_REQUIRED', 409);
      if (!project.targetBranch) throw new BoardError('Choose the local target branch first.', 'TARGET_BRANCH_REQUIRED', 409);
      if (!this.executor) throw new BoardError('Agent execution is not available. Cards can be planned and moved, but no agent runs.', 'EXECUTION_UNAVAILABLE', 503);
      if (!EXECUTABLE_STAGES.has(stage)) throw conflict(`${column.title} runs are not available yet.`, 'STAGE_NOT_IMPLEMENTED');
      // Explicit request values override the project's workflow settings for this run only.
      const settings = effectiveWorkflow(project)[stage];
      const requested = Object.fromEntries(Object.entries(config || {}).filter(([key, value]) => ['provider', 'model', 'effort', 'permissionMode', 'instructions'].includes(key) && value !== undefined && value !== null));
      // Model, effort, and permission mode belong to one provider; a different provider starts from its own defaults.
      const inherited = requested.provider && requested.provider !== settings.provider ? { policy: settings.policy, instructions: settings.instructions, provider: requested.provider } : settings;
      const merged = { ...inherited, ...requested };
      if (typeof merged.instructions !== 'string' || merged.instructions.length > 4000) throw new BoardError('Stage instructions can have at most 4,000 characters.', 'INVALID_WORKFLOW');
      const resolved = { ...(await this.executor.validate({ stage, config: merged })), instructions: merged.instructions };
      if (!WORKSPACE_STAGES.has(stage) && task.workspace?.status !== 'ready') throw new BoardError('Run Planning or Executing first to create the task worktree.', 'WORKSPACE_REQUIRED', 409);
      const workspace = await this.ensureTaskWorktree(taskId);
      const plan = stage === 'executing' ? this.#approvedPlan(state, task) : null;
      // Review reads the actual diff of a clean, committed revision. Executing gets requested fixes.
      const review = stage === 'code_review' ? await this.delivery.reviewContext(taskId) : null;
      const extra = review ? review.text : stage === 'executing' && task.reworkNotes ? `=== REVIEW FINDINGS TO FIX ===\n${task.reworkNotes}\n=== END FINDINGS ===` : '';
      const run = await this.store.update(draft => {
        if (this.#activeRun(draft, taskId)) throw conflict('This card already has an active run.', 'RUN_ACTIVE');
        const now = Date.now();
        const id = randomUUID();
        const record = { id, taskId, projectId: project.id, stage, status: 'queued', createdAt: now, updatedAt: now,
          promptRevision: task.contentRevision ?? 1, config: resolved, trigger: trigger === 'automation' ? 'automation' : 'user', workspacePath: workspace.path, branch: workspace.branch,
          planRunId: plan?.runId || null, artifactsDir: join('runs', id), turns: 0, ...(review ? { review: { taskCommit: review.taskCommit, targetCommit: review.targetCommit } } : {}) };
        draft.runs.push(record);
        return record;
      });
      await this.executor.start({ run, task: { id: task.id, title: task.title, prompt: task.prompt }, workspace, planRunId: plan?.runId || null, extra });
      return run;
    });
  }

  #approvedPlan(state, task) {
    const approval = task.planApproval;
    // An approval counts only for the task text it was given for.
    if (!approval || approval.contentRevision !== (task.contentRevision ?? 1)) return null;
    return state.runs.find(run => run.id === approval.runId && run.hasPlan) ? approval : null;
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
      return run;
    });
  }

  async setSettings({ maxConcurrentRuns }) {
    if (!Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1 || maxConcurrentRuns > 4) throw new BoardError('Allow 1 to 4 agent sessions at the same time.', 'INVALID_INPUT');
    return this.store.update(state => { state.settings = { ...state.settings, maxConcurrentRuns }; return state.settings; });
  }

  async run(runId) {
    const run = (await this.state()).runs.find(item => item.id === runId);
    if (!run) throw new BoardError('This run does not exist.', 'NOT_FOUND', 404);
    return run;
  }
}

function title(column) { return COLUMNS.find(item => item.id === column)?.title || column; }
