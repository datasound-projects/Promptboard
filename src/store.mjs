/**
 * Server-owned board state: one versioned JSON file in a local application-data folder.
 * Writes are serialized, atomic (temp file + fsync + rename), and keep the previous good
 * file as a backup. Logs and artifacts belong in separate folders, never in this file.
 */
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { migrateSessions } from './sessions.mjs';
import { normalizePipelineConfig, normalizePipelineTaskSelection } from './pipeline-config.mjs';
import { assignTaskNumbers, validateTaskNumbers } from './task-numbers.mjs';
import { taskPriority } from './task-priority.mjs';
import { taskLabels, taskLabelIds, labelRevision } from './task-labels.mjs';
import { externalIssueSource } from './external-source.mjs';
import { serial, writeAtomic } from './durable.mjs';

export const STATE_SCHEMA = 'promptboard.state';
export const STATE_VERSION = 13;
const STATE_FILE = 'state.json';

export function defaultDataDir(env = process.env, platform = process.platform) {
  if (env.PROMPTBOARD_DATA_DIR) return env.PROMPTBOARD_DATA_DIR;
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Promptboard');
  if (platform === 'win32') return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Promptboard');
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'promptboard');
}

/** User-visible repositories created by New project. Existing imported folders stay in place. */
export function defaultProjectsDir(env = process.env, home = homedir()) {
  return env.PROMPTBOARD_PROJECTS_DIR || join(home, 'Promptboard', 'projects');
}

export function emptyState() {
  return { schema: STATE_SCHEMA, version: STATE_VERSION, revision: 0, settings: { execution: 'inactive' }, projects: [], runs: [], sessions: [], migrations: [], base: { revision: 0, resources: [], approvedRoots: [] } };
}

export class StoreError extends Error {
  constructor(message, code, status = 500) { super(message); this.code = code; this.status = status; }
}

function checkShape(data) {
  if (!data || typeof data !== 'object' || data.schema !== STATE_SCHEMA) throw new Error('Unknown state file.');
  if (data.version > STATE_VERSION) throw new StoreError('The board was saved by a newer Promptboard version. Update the app; the file was not changed.', 'STATE_VERSION_UNSUPPORTED');
  if (![2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, STATE_VERSION].includes(data.version) || !Array.isArray(data.projects) || !Array.isArray(data.runs)) throw new Error('Unsupported state shape.');
  if (data.version >= 3 && (!data.base || !Array.isArray(data.base.resources) || !Array.isArray(data.base.approvedRoots) || !Number.isSafeInteger(data.base.revision) || data.base.revision < 0)) throw new Error('Invalid Base registry shape.');
  if (data.version >= 4 && (!Array.isArray(data.sessions) || data.sessions.some(session => !session || typeof session !== 'object'
    || typeof session.id !== 'string' || !session.id || typeof session.taskId !== 'string' || typeof session.projectId !== 'string'
    || !['queued', 'running', 'waiting_for_input', 'suspended', 'exited', 'orphaned'].includes(session.status)
    || !Array.isArray(session.runIds) || session.runIds.some(id => typeof id !== 'string') || !Array.isArray(session.artifacts)))) throw new Error('Invalid session registry shape.');
  if (data.version >= 5) for (const project of data.projects) {
    if (project.workflowMode !== undefined && !['legacy', 'pipeline'].includes(project.workflowMode)) throw new Error('Invalid project workflow mode.');
    if (project.workflowMode === 'pipeline') {
      const config = normalizePipelineConfig(project.pipeline);
      if (project.tasks.some(task => !config.columns.some(column => column.id === task.column))) throw new Error('Task refers to a missing pipeline column.');
      for (const task of project.tasks) normalizePipelineTaskSelection(config, { profileId: task.profileId, agentOverride: task.agentOverride });
    }
    if (data.version >= 7) validateTaskNumbers(project);
    if (data.version >= 9) for (const task of project.tasks) taskPriority(task.priority);
    if (data.version >= 10) {
      if (!Array.isArray(project.labels) || project.tasks.some(task => !Array.isArray(task.labelIds))) throw new Error('Missing task label metadata.');
      const labels = taskLabels(project.labels); labelRevision(project.labelRevision);
      for (const task of project.tasks) taskLabelIds(task.labelIds, labels);
    }
    if (data.version >= 6) for (const task of project.tasks) {
      const validKey = key => key && typeof key === 'object' && key.projectId === project.id && key.taskId === task.id
        && typeof key.transitionId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(key.transitionId);
      if (data.version >= 8 && task.pendingAutomationMessages !== undefined && (!Array.isArray(task.pendingAutomationMessages)
        || task.pendingAutomationMessages.length > 1000
        || task.pendingAutomationMessages.some(key => !validKey(key) || Object.keys(key).some(name => !['projectId', 'taskId', 'transitionId'].includes(name)))
        || new Set(task.pendingAutomationMessages.map(key => key.transitionId)).size !== task.pendingAutomationMessages.length)) throw new Error('Invalid pending message references.');
      if (task.automationMoves !== undefined && (!Array.isArray(task.automationMoves) || task.automationMoves.length > 100
        || task.automationMoves.some(key => !validKey(key) || Object.keys(key).some(name => !['projectId', 'taskId', 'transitionId'].includes(name)))
        || new Set(task.automationMoves.map(key => key.transitionId)).size !== task.automationMoves.length)) throw new Error('Invalid task automation history.');
      if (task.automationMove !== undefined && (!validKey(task.automationMove)
        || !['pending', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'blocked'].includes(task.automationMove.status)
        || !['exit', 'lifecycle', 'enter', 'complete'].includes(task.automationMove.phase)
        || task.automationMove.updatedAt !== undefined && (!Number.isSafeInteger(task.automationMove.updatedAt) || task.automationMove.updatedAt < 0)
        || task.automationMove.reason !== undefined && (typeof task.automationMove.reason !== 'string' || task.automationMove.reason.length > 500)
        || task.automationMove.errorCode !== undefined && (typeof task.automationMove.errorCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(task.automationMove.errorCode))
        || !(task.automationMoves || []).some(key => key.transitionId === task.automationMove.transitionId)
        || Object.keys(task.automationMove).some(name => !['projectId', 'taskId', 'transitionId', 'status', 'phase', 'updatedAt', 'reason', 'errorCode'].includes(name)))) throw new Error('Invalid task automation move.');
    }
  }
  // Cards imported from GitHub before version 13 keep their issue link.
  if (data.version >= 13) for (const project of data.projects) for (const task of project.tasks) if (task.externalSource !== undefined) externalIssueSource(task.externalSource);
  return { ...emptyState(), ...data };
}

/** Pure, explicit migration. Valid older data is never classified as corruption. */
export function migrateState(data) {
  let state = checkShape(data);
  if (state.version === STATE_VERSION) return state;
  state = structuredClone(state);
  state.migrations = Array.isArray(state.migrations) ? state.migrations : [];
  if (state.version === 2) {
    state.base = { revision: 0, resources: [], approvedRoots: [] };
    state.migrations.push({ kind: 'state-v2-to-v3', at: Date.now() });
  }
  if (state.version < 4) {
    migrateSessions(state);
    state.migrations.push({ kind: 'state-v3-to-v4', at: Date.now() });
  }
  if (state.version < 5) {
    for (const project of state.projects) project.workflowMode = 'legacy';
    state.migrations.push({ kind: 'state-v4-to-v5', at: Date.now() });
  }
  if (state.version < 6) state.migrations.push({ kind: 'state-v5-to-v6', at: Date.now() });
  if (state.version < 7) {
    for (const project of state.projects) assignTaskNumbers(project);
    state.migrations.push({ kind: 'state-v6-to-v7', at: Date.now() });
  }
  if (state.version < 8) state.migrations.push({ kind: 'state-v7-to-v8', at: Date.now() });
  if (state.version < 9) {
    for (const project of state.projects) for (const task of project.tasks) task.priority = taskPriority(task.priority);
    state.migrations.push({ kind: 'state-v8-to-v9', at: Date.now() });
  }
  if (state.version < 10) {
    for (const project of state.projects) {
      project.labels = []; project.labelRevision = 0;
      for (const task of project.tasks) task.labelIds = [];
    }
    state.migrations.push({ kind: 'state-v9-to-v10', at: Date.now() });
  }
  if (state.version < 11) state.migrations.push({ kind: 'state-v10-to-v11', at: Date.now() });
  if (state.version < 12) state.migrations.push({ kind: 'state-v11-to-v12', at: Date.now() });
  // Version 13 removes the Backlog. Drafts that were still waiting there become idle To Do cards, so no
  // saved work disappears; nothing starts. The exact earlier file is kept as a pre-migration backup.
  let moved = 0;
  for (const project of state.projects) {
    moved += draftsToCards(project, project.backlog);
    for (const key of ['backlog', 'backlogRevision', 'backlogSources', 'backlogImported', 'backlogImportRevision']) delete project[key];
  }
  state.migrations.push({ kind: 'state-v12-to-v13', at: Date.now(), draftsMovedToTodo: moved });
  state.version = STATE_VERSION;
  // New metadata must satisfy current invariants before any migrated bytes publish.
  return checkShape(state);
}

/** Former Backlog drafts appended to the project's To Do as idle cards (numbered after existing cards). */
export function draftsToCards(project, drafts, pipeline = project.workflowMode === 'pipeline') {
  if (drafts === undefined || drafts === null) return 0;
  if (!Array.isArray(drafts)) throw new Error('Invalid backlog drafts.');
  if (!drafts.length) return 0;
  const todo = pipeline ? normalizePipelineConfig(project.pipeline).columns.find(column => column.role === 'todo').id : 'todo';
  const ids = new Set(project.tasks.map(task => task.id)), labels = taskLabels(project.labels || []);
  for (const draft of drafts) {
    if (!draft || typeof draft !== 'object' || typeof draft.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(draft.id) || ids.has(draft.id)
      || typeof draft.title !== 'string' || !draft.title.trim() || draft.title.trim().length > 120 || typeof draft.prompt !== 'string' || draft.prompt.length > 2 * 1024 * 1024) throw new Error('Invalid backlog draft.');
    ids.add(draft.id);
    const now = Date.now(), time = value => (Number.isSafeInteger(value) && value >= 0 ? value : now);
    project.tasks.push({ id: draft.id, title: draft.title.trim(), prompt: draft.prompt, source: draft.source && typeof draft.source === 'object' && !Array.isArray(draft.source) ? draft.source : null,
      ...(draft.externalSource === undefined ? {} : { externalSource: externalIssueSource(draft.externalSource) }), checksOutdated: draft.checksOutdated === true,
      createdAt: time(draft.createdAt), updatedAt: time(draft.updatedAt), column: todo, priority: taskPriority(draft.priority), labelIds: taskLabelIds(Array.isArray(draft.labelIds) ? draft.labelIds : [], labels),
      revision: 1, contentRevision: 1, planApproval: null, workspace: null, retainedBranches: [], transitions: [] });
  }
  assignTaskNumbers(project);
  return drafts.length;
}

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.path = join(dir, STATE_FILE);
    this.state = null;
    this.recovery = null; // Public note when the file had to be recovered.
    this.queue = serial();
  }

  async #readFile(path) { return checkShape(JSON.parse(await readFile(path, 'utf8'))); }

  /** Load once. A corrupt file falls back to the backup; neither file is overwritten silently. */
  async load() {
    if (this.state) return this.state;
    this.loading ??= (async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      // Temporary files from an interrupted write are never valid state.
      for (const name of await readdir(this.dir)) if (name.startsWith(`${STATE_FILE}.tmp-`)) await rm(join(this.dir, name), { force: true });
      let state, source = this.path, corrupt = false;
      try { state = await this.#readFile(this.path); }
      catch (error) {
        if (error.code === 'STATE_VERSION_UNSUPPORTED') throw error;
        corrupt = error.code !== 'ENOENT';
        try { state = await this.#readFile(`${this.path}.bak`); source = `${this.path}.bak`; }
        catch (backupError) {
          // A newer backup is evidence of a newer installation, not corruption to overwrite.
          if (backupError.code === 'STATE_VERSION_UNSUPPORTED') throw backupError;
          state = emptyState();
        }
        if (corrupt) {
          const quarantined = `state.corrupt-${Date.now()}-${randomBytes(4).toString('hex')}.json`;
          await rename(this.path, join(this.dir, quarantined));
          this.recovery = { restoredFromBackup: source !== this.path, quarantined };
        } else if (source !== this.path) {
          this.recovery = { restoredFromBackup: true, quarantined: null };
        }
      }
      if (state.version < STATE_VERSION) {
        const previousVersion = state.version;
        try {
          // Preserve the exact original, including unknown fields, before publishing anything.
          const backup = `state.pre-migration-v${previousVersion}-${Date.now()}-${randomBytes(4).toString('hex')}.json`;
          await copyFile(source, join(this.dir, backup));
          // Windows FlushFileBuffers requires write access. r+ permits the flush
          // without truncating or changing the preserved pre-migration bytes.
          const handle = await open(join(this.dir, backup), 'r+'); try { await handle.sync(); } finally { await handle.close(); }
          const migrated = migrateState(state);
          await this.#write(migrated);
          state = migrated;
          this.recovery = { ...this.recovery, migratedFromVersion: previousVersion, migrationBackup: backup };
        } catch {
          throw new StoreError('The existing board could not be migrated safely. Its pre-migration data was preserved; check saved data, folder permissions and free disk space before retrying.', 'STATE_MIGRATION_FAILED');
        }
      }
      this.state = state;
      return state;
    })();
    try { return await this.loading; } finally { this.loading = null; }
  }

  async #write(state) { await writeAtomic(this.path, `${JSON.stringify(state, null, 1)}\n`); }

  /** Current state. Treat it as read-only; change it only through update(). */
  async read() { return this.load(); }

  /**
   * Serialized update. `change` receives a private copy; if it throws or the write fails,
   * the stored state is unchanged. Returns whatever `change` returns.
   */
  update(change) {
    const run = async () => {
      const current = await this.load();
      const draft = structuredClone(current);
      const result = await change(draft);
      draft.revision = current.revision + 1;
      try { await this.#write(draft); }
      catch (error) { throw new StoreError('The board could not be saved. Check free disk space and folder permissions.', 'STATE_WRITE_FAILED'); }
      this.state = draft;
      return result;
    };
    return this.queue(run);
  }
}
