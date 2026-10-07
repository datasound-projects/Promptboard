/**
 * Origin persistence. Every Origin project is one versioned JSON file in <dataDir>/origin/: its own
 * stable ID, name, description, an optional link to a Kanban project, and its blueprint. Origin never
 * changes state.json; Kanban work is created only through the board service. Writes are serialized and
 * atomic (temp file + fsync + rename), keep the previous good file as a backup, and quarantine a damaged
 * file instead of overwriting it. Origin never starts agents and never writes Base or repository data.
 *
 * Version 1 kept one blueprint per Kanban project in project-<kanbanId>.json. The first start of this
 * version copies each of them once into an Origin project with the same ID (so every link, key and record
 * ID is kept), records that in migration.json, and leaves the version 1 files unchanged for rollback.
 */
import '../public/origin-model.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

const Model = globalThis.PromptboardOriginModel;
export const ORIGIN_DIR = 'origin';
const BODY_LIMIT = 4 * 1024 * 1024;
const MIGRATION_FILE = 'migration.json';
const PROJECT_LIMIT = 200;

export class OriginError extends Error {
  constructor(message, code, status = 400) { super(message); this.code = code; this.status = status; }
}

// Uppercase letters and "_" are escaped so IDs that differ only in case never share a file on
// case-insensitive file systems; the prefix avoids reserved device names on Windows.
const escapeId = id => id.replace(/[A-Z_]/g, character => `_${character === '_' ? '_' : character.toLowerCase()}`);
function validId(id, message = 'Choose a valid project.') {
  if (typeof id !== 'string' || !Model.ID.test(id)) throw new OriginError(message, 'INVALID_PROJECT');
  return id;
}
/** Version 1 file of a Kanban project's blueprint (read only, for migration and rollback). */
export function originFileName(projectId) { return `project-${escapeId(validId(projectId))}.json`; }
/** Version 2 file of an Origin project. */
export function blueprintFileName(originId) { return `blueprint-${escapeId(validId(originId))}.json`; }

const time = value => (Number.isSafeInteger(value) && value > 0 ? value : null);
function projectName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 80 || name.includes('\0')) throw new OriginError('A project name needs 1 to 80 characters.', 'INVALID_INPUT');
  return name;
}
function description(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > 20000 || value.includes('\0')) throw new OriginError('A description can have at most 20,000 characters.', 'INVALID_INPUT');
  return value.trim();
}
function expected(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new OriginError('Reload the project before saving.', 'INVALID_REVISION');
  return value;
}

export class OriginStore {
  /** `kanbanProjects()` reads the board's projects; only names and IDs are used, for migration. */
  constructor(dataDir, { kanbanProjects = async () => [] } = {}) {
    this.dir = join(dataDir, ORIGIN_DIR);
    this.kanbanProjects = kanbanProjects;
    this.queue = Promise.resolve();
    this.ready = null;
    this.recoveries = new Map(); // A restore found while listing is reported when the project is opened.
  }

  // ponytail: one queue for all Origin files; per-project queues if saves ever contend.
  #serial(work) {
    const run = async () => {
      this.ready ??= (async () => {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        // Temporary files from an interrupted write are never valid files.
        for (const name of await readdir(this.dir)) if (name.includes('.json.tmp-')) await rm(join(this.dir, name), { force: true });
        await this.#migrate();
      })().catch(error => { this.ready = null; throw error; });
      await this.ready;
      return work();
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  async #atomic(path, data, failure) {
    const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      const handle = await open(tmp, 'wx', 0o600);
      try { await handle.writeFile(`${JSON.stringify(data, null, 1)}\n`); await handle.sync(); }
      finally { await handle.close(); }
      try { await copyFile(path, `${path}.bak`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rename(tmp, path);
    } catch {
      await rm(tmp, { force: true }).catch(() => {});
      throw new OriginError(failure, 'ORIGIN_WRITE_FAILED', 500);
    }
    try { const dir = await open(this.dir, 'r'); try { await dir.sync(); } finally { await dir.close(); } } catch {}
  }

  // ---- Version 1 → 2, once ----
  async #migrate() {
    try { await readFile(join(this.dir, MIGRATION_FILE), 'utf8'); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const kanban = new Map((await this.kanbanProjects()).map(project => [project.id, project]));
    const migrated = [], skipped = [];
    for (const name of (await readdir(this.dir)).filter(entry => /^project-[a-z0-9_-]+\.json$/.test(entry)).sort()) {
      let data;
      try { data = JSON.parse(await readFile(join(this.dir, name), 'utf8')); } catch { skipped.push(name); continue; }
      if (data?.schema !== Model.SCHEMA || data.version !== 1 || typeof data.projectId !== 'string' || !Model.ID.test(data.projectId) || name !== originFileName(data.projectId)) { skipped.push(name); continue; }
      let blueprint;
      try { blueprint = Model.normalizeBlueprint(data.blueprint).blueprint; } catch { skipped.push(name); continue; }
      const linked = kanban.get(data.projectId);
      // An empty blueprint whose Kanban project is gone holds nothing; its v1 file stays for rollback.
      if (!linked && !Model.isStarted(blueprint)) { skipped.push(name); continue; }
      const target = join(this.dir, blueprintFileName(data.projectId));
      try { await readFile(target); continue; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await this.#atomic(target, { schema: Model.SCHEMA, version: Model.VERSION, originId: data.projectId,
        project: { name: linked?.name || blueprint.idea.split('\n')[0].trim().slice(0, 60) || `Blueprint ${data.projectId.slice(0, 8)}`, description: blueprint.vision.summary || blueprint.idea || '', kanbanProjectId: linked ? linked.id : null },
        revision: Number.isSafeInteger(data.revision) && data.revision > 0 ? data.revision : 1, createdAt: time(data.createdAt) || Date.now(), updatedAt: time(data.updatedAt) || Date.now(), blueprint },
      'The Origin blueprints could not be upgraded. Check free disk space and folder permissions. Nothing was changed.');
      migrated.push(name);
    }
    await this.#atomic(join(this.dir, MIGRATION_FILE), { schema: 'promptboard.origin-migration', version: 1, migratedAt: Date.now(), migrated, skipped },
      'The Origin blueprints could not be upgraded. Check free disk space and folder permissions.');
  }

  // ---- Reading ----
  async #parse(path, originId) {
    const data = JSON.parse(await readFile(path, 'utf8'));
    if (!data || typeof data !== 'object' || data.schema !== Model.SCHEMA || data.originId !== originId) throw new Error('Unknown Origin file.');
    if (typeof data.version === 'number' && data.version > Model.VERSION) {
      throw new OriginError('This Origin project was saved by a newer Promptboard version. Update the app; the file was not changed.', 'ORIGIN_VERSION_UNSUPPORTED', 409);
    }
    if (data.version !== Model.VERSION || !Number.isSafeInteger(data.revision) || data.revision < 1) throw new Error('Unsupported Origin file.');
    const project = data.project && typeof data.project === 'object' ? data.project : {};
    const meta = { name: projectName(project.name), description: description(project.description),
      kanbanProjectId: typeof project.kanbanProjectId === 'string' && Model.ID.test(project.kanbanProjectId) ? project.kanbanProjectId : null };
    const { blueprint, repairs } = Model.normalizeBlueprint(data.blueprint);
    return { id: originId, ...meta, revision: data.revision, createdAt: time(data.createdAt), updatedAt: time(data.updatedAt), blueprint, repairs };
  }

  /** A damaged file is kept aside and the last good backup is used; a missing file means no project. */
  async #read(originId) {
    const name = blueprintFileName(originId), path = join(this.dir, name);
    const damaged = error => !error.code || error.code === 'ORIGIN_INVALID' || error.code === 'INVALID_INPUT';
    try { return { ...(await this.#parse(path, originId)), recovery: null }; }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      if (!damaged(error)) throw error.code === 'ORIGIN_VERSION_UNSUPPORTED' ? error : new OriginError('The Origin project could not be read. Check folder permissions.', 'ORIGIN_READ_FAILED', 500);
      let result = null;
      try { result = await this.#parse(`${path}.bak`, originId); }
      catch (backupError) { if (backupError.code === 'ORIGIN_VERSION_UNSUPPORTED') throw backupError; }
      const quarantined = `${name.slice(0, -5)}.corrupt-${Date.now()}-${randomBytes(4).toString('hex')}.json`;
      await rename(path, join(this.dir, quarantined));
      if (result) {
        await this.#atomic(path, this.#file(result), 'The Origin project could not be restored. Nothing else was changed.');
        const recovery = { restoredFromBackup: true, quarantined };
        this.recoveries.set(originId, recovery);
        return { ...result, recovery };
      }
      return { id: originId, name: 'Damaged project', description: '', kanbanProjectId: null, revision: 0, createdAt: null, updatedAt: null, blueprint: Model.emptyBlueprint(), repairs: 0,
        recovery: { restoredFromBackup: false, quarantined }, damaged: true };
    }
  }

  #file(record) {
    return { schema: Model.SCHEMA, version: Model.VERSION, originId: record.id, project: { name: record.name, description: record.description, kanbanProjectId: record.kanbanProjectId },
      revision: record.revision, createdAt: record.createdAt, updatedAt: record.updatedAt, blueprint: record.blueprint };
  }

  async #list() {
    const records = [];
    for (const name of (await readdir(this.dir)).filter(entry => /^blueprint-[a-z0-9_-]+\.json$/.test(entry))) {
      const id = name.slice(10, -5).replace(/_(.)/g, (_, character) => (character === '_' ? '_' : character.toUpperCase()));
      if (!Model.ID.test(id) || blueprintFileName(id) !== name) continue;
      const record = await this.#read(id);
      if (record && !record.damaged) records.push(record);
    }
    return records.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.id.localeCompare(b.id));
  }

  async #require(originId) {
    const record = await this.#read(originId);
    if (!record || record.damaged) throw new OriginError('This Origin project no longer exists. Choose another project.', 'NOT_FOUND', 404);
    return record;
  }

  async #save(record, changes) {
    const now = Date.now();
    const next = { ...record, ...changes, revision: record.revision + 1, updatedAt: now };
    await this.#atomic(join(this.dir, blueprintFileName(record.id)), this.#file(next), 'The Origin project could not be saved. Check free disk space and folder permissions. Nothing else was changed.');
    return next;
  }

  list() { return this.#serial(() => this.#list()); }

  read(originId) {
    try { validId(originId); } catch (error) { return Promise.reject(error); }
    return this.#serial(async () => {
      const record = await this.#read(originId), pending = this.recoveries.get(originId);
      this.recoveries.delete(originId);
      return record && pending ? { ...record, recovery: pending } : record;
    });
  }

  /** Create an Origin project. A Kanban link is added separately, so a failed link never loses the design. */
  create({ name, description: text = '' } = {}) {
    let meta;
    try { meta = { name: projectName(name), description: description(text) }; } catch (error) { return Promise.reject(error); }
    return this.#serial(async () => {
      if ((await this.#list()).length >= PROJECT_LIMIT) throw new OriginError(`Origin can hold at most ${PROJECT_LIMIT} projects.`, 'LIMIT', 409);
      const blueprint = Model.emptyBlueprint();
      if (meta.description) { blueprint.idea = meta.description; blueprint.vision.summary = meta.description; }
      const now = Date.now(), record = { id: randomUUID(), ...meta, kanbanProjectId: null, revision: 1, createdAt: now, updatedAt: now, blueprint };
      await this.#atomic(join(this.dir, blueprintFileName(record.id)), this.#file(record), 'The Origin project could not be created. Check free disk space and folder permissions.');
      return { ...record, repairs: 0, recovery: null };
    });
  }

  /** Replace the blueprint when `expectedRevision` matches. A deleted project is never recreated. */
  write(originId, { expectedRevision, blueprint } = {}) {
    let normalized;
    try { validId(originId); expected(expectedRevision); normalized = Model.normalizeBlueprint(blueprint); } catch (error) { return Promise.reject(error); }
    return this.#serial(async () => {
      const record = await this.#require(originId);
      if (record.revision !== expectedRevision) throw new OriginError('This blueprint changed in another window. Reload it before saving.', 'ORIGIN_REVISION_CONFLICT', 409);
      const saved = await this.#save(record, { blueprint: normalized.blueprint });
      return { ...saved, repairs: normalized.repairs, recovery: record.recovery };
    });
  }

  /** Rename or describe the project. */
  update(originId, { expectedRevision, name, description: text } = {}) {
    const changes = {};
    try {
      validId(originId); expected(expectedRevision);
      if (name !== undefined) changes.name = projectName(name);
      if (text !== undefined) changes.description = description(text);
    } catch (error) { return Promise.reject(error); }
    return this.#serial(async () => {
      const record = await this.#require(originId);
      if (record.revision !== expectedRevision) throw new OriginError('This project changed in another window. Reload it first.', 'ORIGIN_REVISION_CONFLICT', 409);
      return this.#save(record, changes);
    });
  }

  /** Link to a Kanban project (or clear the link with null). One Kanban project belongs to one Origin project. */
  link(originId, { expectedRevision, kanbanProjectId } = {}) {
    try { validId(originId); expected(expectedRevision); if (kanbanProjectId !== null) validId(kanbanProjectId, 'Choose a valid Kanban project.'); } catch (error) { return Promise.reject(error); }
    return this.#serial(async () => {
      const record = await this.#require(originId);
      if (record.revision !== expectedRevision) throw new OriginError('This project changed in another window. Reload it first.', 'ORIGIN_REVISION_CONFLICT', 409);
      if (kanbanProjectId && (await this.#list()).some(other => other.id !== originId && other.kanbanProjectId === kanbanProjectId)) {
        throw new OriginError('That Kanban project is already linked to another Origin project.', 'ALREADY_LINKED', 409);
      }
      return this.#save(record, { kanbanProjectId });
    });
  }

  /** Remove the Origin project. The file moves to origin/deleted/; Kanban work and snapshots are untouched. */
  remove(originId, { expectedRevision } = {}) {
    try { validId(originId); expected(expectedRevision); } catch (error) { return Promise.reject(error); }
    return this.#serial(async () => {
      const record = await this.#require(originId);
      if (record.revision !== expectedRevision) throw new OriginError('This project changed in another window. Reload it first.', 'ORIGIN_REVISION_CONFLICT', 409);
      const deleted = join(this.dir, 'deleted');
      await mkdir(deleted, { recursive: true, mode: 0o700 });
      const name = blueprintFileName(originId);
      try { await rename(join(this.dir, name), join(deleted, `${name.slice(0, -5)}.deleted-${Date.now()}.json`)); }
      catch { throw new OriginError('The Origin project could not be removed. Check folder permissions. Nothing was changed.', 'ORIGIN_WRITE_FAILED', 500); }
      await rm(join(this.dir, `${name}.bak`), { force: true });
      return { id: originId, deleted: true };
    });
  }
}

/** The project as the page sees it: its Kanban link is resolved against the current board. */
function view(record, kanban) {
  const linked = record.kanbanProjectId ? kanban.find(project => project.id === record.kanbanProjectId) : null;
  return { id: record.id, name: record.name, description: record.description, kanbanProjectId: record.kanbanProjectId, revision: record.revision,
    createdAt: record.createdAt, updatedAt: record.updatedAt,
    kanban: record.kanbanProjectId ? (linked ? { exists: true, name: linked.name, revision: linked.revision } : { exists: false }) : null };
}

/** Kanban side effects go only through the board service, never by writing state.json. */
async function createKanban(board, name) {
  try { return { project: (await board.createProjectWithRepository({ name, folder: 'new', workflowMode: 'pipeline' })).project }; }
  catch (error) { return { error: { message: error.message || 'The Kanban project could not be created.', code: error.code || 'KANBAN_FAILED' } }; }
}

/**
 * /api/origin/projects: list and create. /api/origin/projects/:id: read, save the blueprint (PUT), rename
 * (PATCH). /link connects a Kanban project; /delete removes the Origin project and, only when asked,
 * the linked Kanban project through Kanban's own deletion checks.
 */
export async function originRoute({ origin, board, req, res, pathname, jsonBody, send }) {
  const kanban = async () => (await board.state()).projects;
  const body = async () => {
    const value = await jsonBody(req, BODY_LIMIT);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OriginError('Send a JSON object.', 'INVALID_REQUEST');
    return value;
  };
  if (pathname === '/api/origin/projects') {
    if (req.method === 'GET') { const projects = await kanban(); return send(res, 200, { projects: (await origin.list()).map(record => view(record, projects)) }); }
    if (req.method !== 'POST') return send(res, 404, { error: 'This Origin route does not exist.' });
    const input = await body();
    const created = await origin.create({ name: input.name, description: input.description });
    if (input.createKanban !== true) return send(res, 200, { project: view(created, await kanban()), blueprint: created.blueprint });
    const made = await createKanban(board, created.name);
    if (made.error) return send(res, 200, { project: view(created, await kanban()), blueprint: created.blueprint, kanbanError: made.error });
    const linked = await origin.link(created.id, { expectedRevision: created.revision, kanbanProjectId: made.project.id });
    return send(res, 200, { project: view(linked, await kanban()), blueprint: linked.blueprint });
  }
  const match = pathname.match(/^\/api\/origin\/projects\/([A-Za-z0-9_-]{1,100})(?:\/(link|delete))?$/);
  if (!match) return send(res, 404, { error: 'This Origin route does not exist.' });
  const [, originId, action] = match;
  if (!action && req.method === 'GET') {
    const record = await origin.read(originId);
    if (!record) throw new OriginError('This Origin project no longer exists. Choose another project.', 'NOT_FOUND', 404);
    if (record.damaged) throw new OriginError(`This project file was damaged and no good copy was found. It was kept in the app data folder as ${record.recovery.quarantined}.`, 'ORIGIN_DAMAGED', 404);
    return send(res, 200, { project: view(record, await kanban()), revision: record.revision, blueprint: record.blueprint, repairs: record.repairs, recovery: record.recovery });
  }
  if (!action && req.method === 'PUT') {
    const input = await body();
    if (!input.blueprint || typeof input.blueprint !== 'object' || Array.isArray(input.blueprint)) throw new OriginError('Send a blueprint object and its expected revision.', 'INVALID_REQUEST');
    const saved = await origin.write(originId, { expectedRevision: input.expectedRevision, blueprint: input.blueprint });
    return send(res, 200, { project: view(saved, await kanban()), revision: saved.revision, blueprint: saved.blueprint, repairs: saved.repairs, recovery: saved.recovery });
  }
  if (!action && req.method === 'PATCH') {
    const input = await body();
    const saved = await origin.update(originId, { expectedRevision: input.expectedRevision, name: input.name, description: input.description });
    return send(res, 200, { project: view(saved, await kanban()), revision: saved.revision });
  }
  if (action === 'link' && req.method === 'POST') {
    const input = await body();
    const record = await origin.read(originId);
    if (!record || record.damaged) throw new OriginError('This Origin project no longer exists. Choose another project.', 'NOT_FOUND', 404);
    let kanbanProjectId = input.kanbanProjectId;
    if (input.createKanban === true) {
      const made = await createKanban(board, typeof input.name === 'string' && input.name.trim() ? input.name : record.name);
      if (made.error) throw new OriginError(made.error.message, made.error.code, 409);
      kanbanProjectId = made.project.id;
    } else if (kanbanProjectId !== null && !(await kanban()).some(project => project.id === kanbanProjectId)) {
      throw new OriginError('That Kanban project no longer exists. Choose another one.', 'NOT_FOUND', 404);
    }
    const saved = await origin.link(originId, { expectedRevision: input.expectedRevision, kanbanProjectId });
    return send(res, 200, { project: view(saved, await kanban()), revision: saved.revision });
  }
  if (action === 'delete' && req.method === 'POST') {
    const input = await body();
    const record = await origin.read(originId);
    if (!record) throw new OriginError('This Origin project no longer exists.', 'NOT_FOUND', 404);
    if (record.revision !== input.expectedRevision) throw new OriginError('This project changed in another window. Reload it first.', 'ORIGIN_REVISION_CONFLICT', 409);
    let kanbanDeleted = false;
    if (input.deleteKanban === true) {
      if (!record.kanbanProjectId) throw new OriginError('This Origin project has no linked Kanban project.', 'NOT_LINKED', 409);
      // Kanban's own checks apply: active work and worktrees block the deletion, and nothing is removed.
      await board.deleteProject(record.kanbanProjectId, { expectedRevision: input.expectedKanbanRevision });
      kanbanDeleted = true;
    }
    await origin.remove(originId, { expectedRevision: record.revision });
    return send(res, 200, { deleted: true, kanbanDeleted });
  }
  return send(res, 404, { error: 'This Origin route does not exist.' });
}
