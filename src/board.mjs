/**
 * Agentic Kanban service (PB-01). Owns the column model, validated task transitions,
 * the run records, browser-board migration, import/export, repository links, and task
 * worktrees. See docs/agentic-kanban-contract.md.
 *
 * Nothing here launches an agent. Runs need an executor (PB-02); without one, run
 * requests are refused before any worktree is created.
 */
import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { Store } from './store.mjs';
import { branchExists, commitExists, git, GitError, initRepository, listWorktrees, validateRepository } from './git.mjs';
import { resolveConfig } from './agents.mjs';
import { Delivery } from './delivery.mjs';
import { ensureClone, fastForward, fetchAndCompare, viewRepository } from './github.mjs';
import { buildTimeline } from './timeline.mjs';

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
// Stages that can run an agent. To Do and Done never do.
const EXECUTABLE_STAGES = new Set(['planning', 'executing', 'code_review', 'testing', 'merge']);
// Per-stage workflow settings. Projects store overrides; defaults apply otherwise.
// To Do, Merge, and Done have no run policy: To Do and Done never run, and a merge always needs confirmation.
export const WORKFLOW_STAGES = Object.freeze(['planning', 'executing', 'code_review', 'testing', 'merge']);
const POLICIES = ['manual', 'ask', 'start'];
export const DEFAULT_STAGE_SETTINGS = Object.freeze({ policy: 'ask', provider: 'claude', model: '', effort: '', permissionMode: '', instructions: '' });
const RUN_FIELDS = ['hasReview', 'startedAt', 'endedAt', 'providerSessionId', 'waitingReason', 'errorCode', 'exitCode', 'hasPlan', 'planExcerpt', 'turns', 'lifecycle', 'turnComplete', 'usage'];
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
    const columnLayout = v2 && Array.isArray(project.columnLayout) && project.columnLayout.length ? normalizeColumns(project.columnLayout) : null;
    const columnIds = new Set([...COLUMN_IDS, ...(columnLayout || []).filter(entry => entry.custom).map(entry => entry.id)]);
    return {
      id: unique(project.id, label), name, createdAt: time(project.createdAt),
      columnLayout,
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
        return { id: unique(card.id, cardLabel), title: text(card.title, 120, `${cardLabel} title`), prompt: promptText(card.prompt, cardLabel),
          createdAt: time(card.createdAt), updatedAt: time(card.updatedAt ?? card.createdAt), checksOutdated: card.checksOutdated === true,
          source: normalizeSource(card.source), column: v2 && columnIds.has(card.column) ? card.column : 'todo' };
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
    const entry = { policy: settings.policy, instructions: settings.instructions };
    // A stage stores an agent only when it overrides the project and global defaults.
    if (EXECUTABLE_STAGES.has(stage) && settings.provider) {
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
  try { const { provider, model, effort } = resolveConfig('executing', { provider: input.provider, model: input.model, effort: input.effort }); return { provider, model, effort }; }
  catch (error) { throw new BoardError(error.message, 'INVALID_INPUT'); }
}

/**
 * Settings for each stage. The agent comes from the most specific level that names a provider:
 * the stage override, then the project default, then the global default (Settings), then Claude
 * Code with its CLI defaults. Model and effort come from that same level, because they belong to
 * one provider. `agentSource` says which level applied.
 */
export function effectiveWorkflow(project, globalAgent = null) {
  return Object.fromEntries(WORKFLOW_STAGES.map(stage => {
    const own = project?.workflow?.[stage] || {};
    const levels = [['stage', own.provider ? own : null], ['project', project?.agentDefaults], ['global', globalAgent]];
    const [agentSource, agent] = levels.find(([, value]) => value?.provider) || ['default', {}];
    // Merge stays manual unless a project turns on automatic merging.
    const base = { ...DEFAULT_STAGE_SETTINGS, ...(stage === 'merge' ? { policy: 'manual' } : {}) };
    const picked = { provider: agent.provider || 'claude', model: agent.model || '', effort: agent.effort || '', permissionMode: agentSource === 'stage' ? own.permissionMode || '' : '' };
    let resolved = picked;
    // An effort the stage's provider does not accept is dropped rather than failing every run.
    try { resolved = resolveConfig(stage, picked); } catch { try { resolved = resolveConfig(stage, { ...picked, effort: '', permissionMode: '' }); } catch {} }
    return [stage, { ...base, policy: own.policy || base.policy, instructions: own.instructions || '', ...resolved, agentSource }];
  }).concat((project?.columnLayout || []).filter(entry => entry.custom).map(entry => {
    // A custom column's agent writes in the task worktree (like Executing) with the column's instructions.
    const [agentSource, agent] = [['project', project?.agentDefaults], ['global', globalAgent]].find(([, value]) => value?.provider) || ['default', {}];
    let resolved = { provider: agent.provider || 'claude', model: agent.model || '', effort: agent.effort || '' };
    try { resolved = resolveConfig(entry.id, resolved); } catch { try { resolved = resolveConfig(entry.id, { ...resolved, effort: '' }); } catch {} }
    return [entry.id, { ...DEFAULT_STAGE_SETTINGS, policy: entry.agent?.enabled ? entry.agent.policy : 'manual', instructions: entry.agent?.instructions || '', ...resolved, agentSource, custom: true }];
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
  testing: ['merge', 'executing'],
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
    const agent = entry.agent?.enabled === true ? { enabled: true, policy: POLICIES.includes(entry.agent.policy) ? entry.agent.policy : 'ask',
      instructions: typeof entry.agent.instructions === 'string' ? entry.agent.instructions.slice(0, 4000) : '' } : { enabled: false };
    out.push({ id: entry.id, custom: true, title: name, color, description: typeof entry.description === 'string' ? entry.description.trim().slice(0, 200) : '', agent });
  }
  if (out.filter(entry => !entry.custom).map(entry => entry.id).join() !== COLUMN_IDS.join()) throw new BoardError('The built-in stages keep their order: To Do, Planning, Executing, Code Review, Testing, Merge, Done.', 'INVALID_COLUMNS');
  if (out[0].id !== 'todo' || out.at(-1).id !== 'done') throw new BoardError('Custom columns go between To Do and Done.', 'INVALID_COLUMNS');
  if (out.filter(entry => entry.custom).length > CUSTOM_LIMIT) throw new BoardError(`A board can have at most ${CUSTOM_LIMIT} custom columns.`, 'INVALID_COLUMNS');
  return out;
}

/** The columns a project shows, in order. A custom column records its anchor stage. */
export function projectColumns(project) {
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
  constructor({ dataDir, executor = null, projectsDir = join(dataDir, 'projects') }) {
    this.dataDir = dataDir;
    this.projectsDir = projectsDir; // Where "New project" creates each project's own Git repository.
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
    return { revision: state.revision, columns: COLUMNS, transitions: TRANSITIONS, settings: state.settings, runs: state.runs.slice(-500),
      projects: state.projects.map(project => ({ ...project, columns: projectColumns(project), transitions: projectTransitions(project), effectiveWorkflow: effectiveWorkflow(project, state.settings.defaultAgent) })),
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

  /**
   * A project that is ready for agents: every project made in the app has a Git repository.
   * `folder: 'new'` creates a folder in the projects folder; an absolute path uses that existing
   * folder. A folder that is not a repository yet gets `git init` and one empty first commit
   * (its files are never added). Then the project is linked to it.
   */
  async createProjectWithRepository({ name, folder }) {
    const clean = text(name, 80, 'Project name');
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
      const repository = await validateRepository(path).catch(async error => {
        if (!['NOT_A_REPOSITORY', 'NO_COMMITS'].includes(error.code)) throw error;
        await initRepository(path, { fallbackIdentity: true });
        return null;
      });
      const project = await this.createProject({ name: clean });
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
      if (this.#hasWorkspaceOrRun(state, [project])) throw conflict('Remove the task worktrees in this project first. Promptboard never deletes worktrees with a whole project.', 'WORKSPACES_EXIST');
      state.projects = state.projects.filter(item => item.id !== id);
      state.runs = state.runs.filter(run => run.projectId !== id);
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
    return this.store.update(state => {
      const project = this.#project(state, id);
      checkRevision(project, expectedRevision, 'This project');
      if (project.tasks.some(task => task.workspace)) throw conflict('Tasks in this project have worktrees in the current repository. Remove them before you change the link.', 'WORKSPACES_EXIST');
      project.repository = repository && { path: path.trim(), root: repository.root, commonDir: repository.commonDir, linkedWorktree: repository.linkedWorktree, validatedAt: Date.now() };
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
      project.revision++;
      return project;
    });
  }

  async setWorkflow(id, { workflow, agentDefaults, expectedRevision }) {
    const clean = normalizeWorkflow(workflow);
    const defaults = agentDefaults === undefined ? undefined : normalizeAgent(agentDefaults);
    return this.store.update(state => {
      const project = this.#project(state, id);
      checkRevision(project, expectedRevision, 'This project');
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
   * `decision` is absent for a first request: the answer can be `{ approval }` instead of a move.
   * With `decision: 'start'` or `'move'` the user approved that approval (`handoffRunId` and
   * `commitMessage` repeat what it asked for). `transitionId` makes a repeated request idempotent.
   */
  transition(id, request = {}) {
    return this.#locked(`transition:${id}`, () => this.#transition(id, request));
  }

  async #transition(id, { column, index, expectedRevision, transitionId, decision, commitMessage, config = {}, handoffRunId = null, trigger = 'user' } = {}) {
    if (transitionId !== undefined && (typeof transitionId !== 'string' || !TRANSITION_ID.test(transitionId))) throw new BoardError('Send a valid transition ID.', 'INVALID_INPUT');
    if (decision !== undefined && decision !== 'start' && decision !== 'move') throw new BoardError('Choose start or move.', 'INVALID_INPUT');
    const automation = trigger === 'automation';
    const state = await this.state();
    const { project, task } = this.#task(state, id);
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
    const plan = await this.#prepareTransition(state, project, task, column);
    const id2 = transitionId || randomUUID();
    const needsApproval = !automation && decision === undefined && Boolean(plan.handoff || plan.commit || plan.confirmAction || (plan.policy === 'ask' && plan.action));
    if (needsApproval) return { approval: this.#approvalView(project, task, plan, id2) };
    if (plan.handoff && handoffRunId !== plan.handoff.id) throw conflict('The agent session of this card changed. Drag the card again to see the current state.', 'TRANSITION_STALE');
    if (plan.commit && !(typeof commitMessage === 'string' && commitMessage.trim())) throw conflict(`The task worktree has ${plan.commit.changes.length} uncommitted ${plan.commit.changes.length === 1 ? 'change' : 'changes'}. Commit them first, or move with the approval that commits them.`, 'UNCOMMITTED_CHANGES');
    if (column === 'done' && decision !== 'start') throw new BoardError('Done needs the verified merge. Choose Merge and complete.', 'CONFIRMATION_REQUIRED');
    // "Move only" never starts anything; otherwise the policy or the approval decides.
    const startAction = Boolean(plan.action) && decision !== 'move' && (plan.policy === 'start' || decision === 'start' || plan.confirmAction);
    if (startAction && plan.agentError) throw new BoardError(plan.agentError.message, plan.agentError.code, 409);

    // Hand off: confirm the finished turn (this approves a plan or records a review), then commit.
    if (plan.handoff) await this.executor.confirm(plan.handoff.id);
    if (plan.commit) await this.delivery.commit(id, { message: commitMessage.trim(), confirm: true });
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
    if (column === 'done') return this.#completeByTransition(id, plan, move);
    if (startAction && plan.action === 'agent') {
      // A run started by the "Start on entry" setting is recorded as automatic; an approved one as the user's.
      const runTrigger = automation || (plan.policy === 'start' && decision !== 'start') ? 'automation' : 'user';
      const run = await this.#locked(`run:${id}`, () => this.#startRun(id, { stage: column, consent: true, config, trigger: runTrigger, move }));
      return { task: await this.#taskNow(id), run };
    }
    const placed = await this.#placeStored(id, move);
    const result = { task: placed };
    if (!startAction || !plan.action) return result;
    if (plan.action === 'tests') {
      try { result.tests = await this.delivery.runTests(id, { confirm: true }); }
      catch (error) { await this.#placeStored(id, { from: column, column: from, transitionId: `${id2}-undo`, by: 'system', reason: error.message }); throw error; }
    } else if (plan.action === 'auto-merge') {
      // Merge automatically: only when every check holds for the current commits (the same gate as a confirmed merge).
      try {
        const preview = await this.delivery.mergePreview(id);
        if (!preview.eligible) throw new BoardError(`Not merged automatically: ${preview.problems.join(' ')}`, 'MERGE_NOT_ELIGIBLE');
        result.task = await this.delivery.merge(id, { confirm: true, taskCommit: preview.taskCommit, targetCommit: preview.targetCommit, trigger: 'automation' });
        result.merged = true;
      } catch (error) { result.automation = { started: false, code: error.code || 'FAILED', message: error.message }; }
    }
    return result;
  }

  /** A move that never starts a stage action, with every check of transition() (for scripts and tests). */
  async moveTask(id, { column, index, expectedRevision }) {
    return (await this.transition(id, { column, index, expectedRevision, decision: 'move' })).task;
  }

  async #taskNow(id) { return this.#task(await this.state(), id).task; }

  /** What the move needs, checked without changing anything. Throws when the move cannot happen. */
  async #prepareTransition(state, project, task, to) {
    const from = task.column;
    const active = this.#activeRun(state, task.id);
    let handoff = null;
    if (active) {
      // A finished turn of the stage the card leaves is handed off (confirmed) as part of the move.
      const finished = active.stage === from && active.status === 'waiting_for_input' && active.turnComplete && active.turns > 0;
      if (!finished || to === 'todo') throw conflict('This card has an active run. Wait for it to finish or cancel it first.', 'RUN_ACTIVE');
      handoff = active;
    }
    const settings = effectiveWorkflow(project, state.settings.defaultAgent)[to] || null;
    const plan = { from, to, handoff, commit: null, notes: null, action: null, confirmAction: false, policy: settings?.policy || 'manual', settings };
    const hasWorkspace = task.workspace?.status === 'ready';
    if (hasWorkspace) await this.ensureTaskWorktree(task.id); // Verifies the worktree and branch, and repairs a deleted folder.
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
      const pr = task.evidence?.pullRequest;
      if (pr?.url) { plan.action = 'pull-request'; plan.confirmAction = true; plan.pullRequest = pr; }
      else {
        const preview = await this.delivery.mergePreview(task.id);
        if (!preview.eligible) throw new BoardError(`Not ready to merge: ${preview.problems.join(' ')}`, 'MERGE_NOT_ELIGIBLE', 409);
        Object.assign(plan, { action: 'merge', confirmAction: true, merge: { targetBranch: preview.targetBranch, taskCommit: preview.taskCommit, targetCommit: preview.targetCommit, commits: preview.commits.length } });
      }
      return plan;
    }
    // The stage action, by project policy. Manual moves only.
    if (['planning', 'executing', 'code_review'].includes(to) || settings?.custom) plan.action = plan.policy === 'manual' ? null : 'agent';
    else if (to === 'testing') plan.action = plan.policy === 'manual' ? null : (project.testCommands || []).length ? 'tests' : 'agent';
    else if (to === 'merge') plan.action = plan.policy === 'start' ? 'auto-merge' : null;
    if (plan.action === 'agent') {
      if (!this.executor) { if (plan.policy === 'start') throw new BoardError('Agent execution is not available, so this stage cannot start automatically. Set it to Manual or Ask.', 'EXECUTION_UNAVAILABLE', 503); plan.action = null; }
      else {
        // An agent that cannot start blocks an automatic start; with Ask, the card can still just move.
        try { plan.config = await this.executor.validate({ stage: to, config: settings }); }
        catch (error) {
          if (plan.policy === 'start') throw new BoardError(`${title(to)} cannot start automatically: ${error.message}`, error.code || 'AGENT_UNAVAILABLE', 409);
          plan.agentError = { message: error.message, code: error.code || 'AGENT_UNAVAILABLE' };
        }
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
    if (to !== 'testing' && to !== 'merge') return { problems, acceptReview };
    const { task } = this.#task(await this.state(), taskId);
    const rev = await this.delivery.revision(taskId);
    const review = task.evidence?.review, tests = task.evidence?.tests;
    if (!rev.clean) problems.push(to === 'merge' ? 'The task worktree has uncommitted changes (for example from the testing agent). Send the card back to Executing so they are committed, reviewed, and tested.' : 'The task worktree has uncommitted changes. Send the card back to Executing.');
    const reviewed = review && review.taskCommit === rev.taskCommit;
    if (!reviewed) problems.push(review ? 'The code review is for an older commit. Run Code Review again.' : 'Run Code Review for the current commit first.');
    else if (review.status === 'completed' && review.verdict === 'no_issues' && to === 'testing') acceptReview = true;
    else if (review.status !== 'accepted') problems.push(review.status === 'changes_requested' || review.verdict === 'changes_required' ? 'The review asked for changes. Send the card back to Executing, or accept the review in the task details.' : 'Accept the review in the task details first.');
    if (to === 'merge') {
      if (tests?.status === 'running') problems.push('Tests are still running.');
      else if (tests?.status !== 'passed' || tests.taskCommit !== rev.taskCommit) problems.push(tests?.status === 'passed' ? 'The passing tests are for an older commit. Run the tests again.' : 'Passing tests for the current commit are required.');
    }
    return { problems, acceptReview };
  }

  /** The approval the UI shows: one decision with everything the move will do. */
  #approvalView(project, task, plan, transitionId) {
    const config = plan.config || (plan.settings && { provider: plan.settings.provider, model: plan.settings.model, effort: plan.settings.effort, permissionMode: plan.settings.permissionMode });
    return { transitionId, taskId: task.id, from: plan.from, to: plan.to, policy: plan.policy, action: plan.action,
      agent: plan.action === 'agent' ? { ...config, source: plan.settings?.agentSource || 'default' } : null,
      handoff: plan.handoff ? { runId: plan.handoff.id, stage: plan.handoff.stage } : null, agentError: plan.agentError?.message || null,
      commit: plan.commit ? { changes: plan.commit.changes.slice(0, 50), count: plan.commit.changes.length, message: plan.commit.message.slice(0, 200) } : null,
      notes: plan.notesKind || null,
      approvedPlan: plan.approvedPlan ?? null, merge: plan.merge || null, pullRequest: plan.pullRequest ? { url: plan.pullRequest.url, number: plan.pullRequest.number } : null,
      canMoveOnly: plan.to !== 'done' && !plan.confirmAction, branch: task.workspace?.branch || null, expectedRevision: task.revision };
  }

  /** Merge → Done: the verified fast-forward merge, or a merged pull request. */
  async #completeByTransition(id, plan, move) {
    let task;
    if (plan.action === 'pull-request') {
      task = await this.delivery.pullRequestStatus(id);
      if (task.column !== 'done') throw conflict(`Pull request ${plan.pullRequest.number ? `#${plan.pullRequest.number} ` : ''}is ${String(task.evidence?.pullRequest?.state || 'open').toLowerCase()}. The card moves to Done when it is merged.`, 'PULL_REQUEST_NOT_MERGED');
    } else {
      task = await this.delivery.merge(id, { confirm: true, taskCommit: plan.merge.taskCommit, targetCommit: plan.merge.targetCommit, trigger: move.by === 'automation' ? 'automation' : 'user' });
    }
    return { task: await this.store.update(state => { const { task: current } = this.#task(state, id); current.lastTransition = { id: move.transitionId, to: 'done', at: Date.now() }; return current; }), merged: plan.action === 'merge' };
  }

  /** Done → To Do: a new cycle. Earlier completions, commits, evidence, and runs are kept. */
  async reopenTask(id, { expectedRevision } = {}) {
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

  /** Into Done through a verified merge, a merged pull request, or an explicit no-change completion. */
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
   * Put a card in a column at a position, in one state update. Only transition() calls this for a
   * column change; the checks there decide whether the change is allowed.
   */
  #place(state, id, { from, column, index, transitionId = null, by = 'user', reason = '', runId = null }) {
    const { project, task } = this.#task(state, id);
    if (task.column !== from) throw conflict(`The card moved to ${title(task.column)} meanwhile. Reload the board.`, 'REVISION_CONFLICT');
    if (task.column !== column && this.#activeRun(state, id)) throw conflict('This card has an active run. Wait for it to finish or cancel it first.', 'RUN_ACTIVE');
    const others = project.tasks.filter(item => item !== task);
    const inColumn = others.filter(item => item.column === column);
    const position = Number.isInteger(index) ? Math.max(0, Math.min(index, inColumn.length)) : inColumn.length;
    const before = inColumn[position];
    const at = before ? others.indexOf(before) : (inColumn.length ? others.indexOf(inColumn.at(-1)) + 1 : others.length);
    if (task.column !== column) {
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
          project.timelineNotes = incoming.timelineNotes;
          if (incoming.columnLayout) project.columnLayout = incoming.columnLayout;
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
        workflow: project.workflow || {}, testCommands: project.testCommands || [], timelineNotes: project.timelineNotes || [], columnLayout: project.columnLayout || [],
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
        if (incoming.columnLayout) project.columnLayout = incoming.columnLayout;
        project.timelineNotes = incoming.timelineNotes.map(note => ({ ...note, taskId: project.tasks.some(task => task.id === note.taskId) ? note.taskId : null }));
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

  /** With `move`, the card enters the stage in the same write that records the run (see transition). */
  async #startRun(taskId, { stage, consent = false, config = {}, trigger = 'user', move = null } = {}) {
    {
      await this.#defaultTargetBranch(taskId);
      const state = await this.state();
      const { project, task } = this.#task(state, taskId);
      const column = projectColumns(project).find(item => item.id === stage);
      if (!column) throw new BoardError('Choose a valid stage.', 'INVALID_COLUMN');
      if (!column.agent) throw new BoardError(`${column.title} never runs an agent.`, 'STAGE_NOT_RUNNABLE');
      if (!move && task.column !== stage) throw conflict(`The card is in ${title(task.column)}, not ${column.title}.`, 'STAGE_MISMATCH');
      if (this.#activeRun(state, taskId)) throw conflict('This card already has an active run.', 'RUN_ACTIVE');
      if (consent !== true) throw new BoardError('Starting an agent needs your explicit confirmation.', 'CONSENT_REQUIRED');
      if (!project.repository) throw new BoardError('Link this project to a Git repository first.', 'REPOSITORY_REQUIRED', 409);
      if (!project.targetBranch) throw new BoardError('Choose the local target branch first.', 'TARGET_BRANCH_REQUIRED', 409);
      if (!this.executor) throw new BoardError('Agent execution is not available. Cards can be planned and moved, but no agent runs.', 'EXECUTION_UNAVAILABLE', 503);
      if (!EXECUTABLE_STAGES.has(stage) && !column.custom) throw conflict(`${column.title} runs are not available yet.`, 'STAGE_NOT_IMPLEMENTED');
      // Explicit request values override the project's workflow settings for this run only.
      const settings = effectiveWorkflow(project, state.settings.defaultAgent)[stage];
      const requested = Object.fromEntries(Object.entries(config || {}).filter(([key, value]) => ['provider', 'model', 'effort', 'permissionMode', 'instructions'].includes(key) && value !== undefined && value !== null));
      // Model, effort, and permission mode belong to one provider; a different provider starts from its own defaults.
      const inherited = requested.provider && requested.provider !== settings.provider ? { policy: settings.policy, instructions: settings.instructions, provider: requested.provider } : settings;
      const merged = { ...inherited, ...requested };
      if (typeof merged.instructions !== 'string' || merged.instructions.length > 4000) throw new BoardError('Stage instructions can have at most 4,000 characters.', 'INVALID_WORKFLOW');
      const resolved = { ...(await this.executor.validate({ stage, config: merged })), instructions: merged.instructions };
      if (!WORKSPACE_STAGES.has(stage) && !column.custom && task.workspace?.status !== 'ready') throw new BoardError('Run Planning or Executing first to create the task worktree.', 'WORKSPACE_REQUIRED', 409);
      const workspace = await this.ensureTaskWorktree(taskId);
      const plan = stage === 'executing' ? this.#approvedPlan(state, task) : null;
      // Review reads the actual diff of a clean, committed revision. Executing gets requested fixes.
      const review = stage === 'code_review' ? await this.delivery.reviewContext(taskId) : null;
      // Testing gets the configured test commands; Merge first brings the target branch in
      // (git merge --no-commit), leaving any conflicts for the agent to resolve.
      const merge = stage === 'merge' ? await this.delivery.prepareMergeRun(taskId) : null;
      const testing = stage === 'testing' ? await this.delivery.testingContext(taskId) : '';
      const extra = review ? review.text : merge ? merge.text : testing || (stage === 'executing' && task.reworkNotes ? `=== REVIEW FINDINGS TO FIX ===\n${task.reworkNotes}\n=== END FINDINGS ===` : '');
      const run = await this.store.update(draft => {
        if (this.#activeRun(draft, taskId)) throw conflict('This card already has an active run.', 'RUN_ACTIVE');
        const now = Date.now();
        const id = randomUUID();
        const record = { id, taskId, projectId: project.id, stage, status: 'queued', createdAt: now, updatedAt: now,
          promptRevision: task.contentRevision ?? 1, config: resolved, trigger: trigger === 'automation' ? 'automation' : 'user', workspacePath: workspace.path, branch: workspace.branch,
          planRunId: plan?.runId || null, artifactsDir: join('runs', id), turns: 0, ...(review ? { review: { taskCommit: review.taskCommit, targetCommit: review.targetCommit } } : {}),
          ...(move ? { transition: { id: move.transitionId, from: move.from } } : {}) };
        if (move) this.#place(draft, taskId, { ...move, runId: id });
        draft.runs.push(record);
        return record;
      });
      await this.executor.start({ run, task: { id: task.id, title: task.title, prompt: task.prompt }, workspace, planRunId: plan?.runId || null, extra });
      return run;
    }
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
