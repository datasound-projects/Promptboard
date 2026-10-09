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
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { redactLocal } from './compose-local.mjs';
import { serial, writeAtomic } from './durable.mjs';

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
export const escapeId = id => id.replace(/[A-Z_]/g, character => `_${character === '_' ? '_' : character.toLowerCase()}`);
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
    this.queue = serial();
    this.ready = null;
    this.recoveries = new Map(); // A restore found while listing is reported when the project is opened.
  }

  // ponytail: one queue for all Origin files; per-project queues if saves ever contend.
  #serial(work) {
    return this.queue(async () => {
      this.ready ??= (async () => {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        // Temporary files from an interrupted write are never valid files.
        for (const name of await readdir(this.dir)) if (name.includes('.json.tmp-')) await rm(join(this.dir, name), { force: true });
        await this.#migrate();
      })().catch(error => { this.ready = null; throw error; });
      await this.ready;
      return work();
    });
  }

  async #atomic(path, data, failure) {
    try { await writeAtomic(path, `${JSON.stringify(data, null, 1)}\n`); } catch { throw new OriginError(failure, 'ORIGIN_WRITE_FAILED', 500); }
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

  /** `report: false` (Project Context) leaves a pending recovery notice for the project's own page. */
  read(originId, { report = true } = {}) {
    try { validId(originId); } catch (error) { return Promise.reject(error); }
    return this.#serial(async () => {
      const record = await this.#read(originId), pending = this.recoveries.get(originId);
      if (!report) return record;
      this.recoveries.delete(originId);
      return record && pending ? { ...record, recovery: pending } : record;
    });
  }

  /**
   * Create an Origin project. A Kanban link is added separately, so a failed link never loses the design.
   * A shared project can pass its existing Kanban ID as `id` (with `kanbanProjectId`), so the project
   * keeps one ID in Origin and Kanban.
   */
  create({ name, description: text = '', id, kanbanProjectId = null } = {}) {
    let meta;
    try {
      meta = { name: projectName(name), description: description(text) };
      if (id !== undefined) validId(id); if (kanbanProjectId !== null) validId(kanbanProjectId, 'Choose a valid Kanban project.');
    } catch (error) { return Promise.reject(error); }
    return this.#serial(async () => {
      const all = await this.#list();
      if (all.length >= PROJECT_LIMIT) throw new OriginError(`Origin can hold at most ${PROJECT_LIMIT} projects.`, 'LIMIT', 409);
      if (id !== undefined && (all.some(other => other.id === id) || await readFile(join(this.dir, blueprintFileName(id))).then(() => true, () => false))) throw new OriginError('An Origin project with this ID already exists.', 'ID_TAKEN', 409);
      if (kanbanProjectId && all.some(other => other.kanbanProjectId === kanbanProjectId)) throw new OriginError('That Kanban project is already linked to another Origin project.', 'ALREADY_LINKED', 409);
      const blueprint = Model.emptyBlueprint();
      if (meta.description) { blueprint.idea = meta.description; blueprint.vision.summary = meta.description; }
      const now = Date.now(), record = { id: id ?? randomUUID(), ...meta, kanbanProjectId, revision: 1, createdAt: now, updatedAt: now, blueprint };
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

  /** Task context from the saved revision only, so a preview never describes unsaved edits. */
  context(originId, { expectedRevision, itemIds } = {}) {
    try {
      validId(originId); expected(expectedRevision);
      if (!Array.isArray(itemIds) || !itemIds.length || itemIds.length > 100) throw new OriginError('Choose 1 to 100 tasks.', 'INVALID_INPUT');
      for (const id of itemIds) validId(id, 'Choose a valid task.');
    } catch (error) { return Promise.reject(error); }
    return this.#serial(async () => {
      const record = await this.#require(originId);
      if (record.revision !== expectedRevision) throw new OriginError('The blueprint has newer changes. Let it save, then try again.', 'ORIGIN_REVISION_CONFLICT', 409);
      const tasks = [...new Set(itemIds)].map(id => buildContext(record, id) || (() => { throw new OriginError('A selected task no longer exists. Reload the project.', 'NOT_FOUND', 404); })());
      return { record, tasks };
    });
  }

  /** Save the approved context of one task as an immutable snapshot; references alone cannot rebuild an older revision. */
  snapshot(originId, built, revision) {
    return this.#serial(async () => {
      const dir = join(this.dir, 'snapshots', escapeId(validId(originId)));
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const id = randomUUID(), snapshot = { schema: 'promptboard.origin-snapshot', version: 1, id, originId, itemId: built.itemId, key: built.key, revision, createdAt: Date.now(),
        instruction: built.instruction, context: built.context, body: built.body, included: built.included, omitted: built.omitted, hash: built.hash };
      try {
        const handle = await open(join(dir, `${escapeId(id)}.json`), 'wx', 0o600);
        try { await handle.writeFile(`${JSON.stringify(snapshot, null, 1)}\n`); await handle.sync(); } finally { await handle.close(); }
      } catch { throw new OriginError('The task context could not be saved. Check free disk space and folder permissions. Nothing was sent.', 'ORIGIN_WRITE_FAILED', 500); }
      return { id, hash: built.hash };
    });
  }

  /** A saved snapshot, or null when it is missing; snapshots are never changed. */
  readSnapshot(originId, snapshotId) {
    if (!snapshotId) return Promise.resolve(null);
    return this.#serial(async () => {
      try { return JSON.parse(await readFile(join(this.dir, 'snapshots', escapeId(validId(originId)), `${escapeId(validId(snapshotId))}.json`), 'utf8')); } catch { return null; }
    });
  }

  /** Record which card each task became. Only handoff fields change, so unrelated edits are never lost. */
  recordHandoff(originId, links) {
    return this.#serial(async () => {
      const record = await this.#require(originId), blueprint = structuredClone(record.blueprint);
      let changed = false;
      for (const link of links) {
        const item = blueprint.items.find(entry => entry.id === link.itemId);
        if (!item) continue;
        const same = item.handoff?.projectId === link.projectId && item.handoff.taskId === link.taskId;
        const next = { projectId: link.projectId, taskId: link.taskId, at: same ? item.handoff.at : Date.now(), snapshotId: link.snapshotId || (same ? item.handoff.snapshotId : ''), hash: link.hash || (same ? item.handoff.hash : ''),
          keptHash: !link.hash && same ? item.handoff.keptHash || '' : '' };
        if (JSON.stringify(next) !== JSON.stringify(item.handoff)) { item.handoff = next; changed = true; }
      }
      return changed ? this.#save(record, { blueprint }) : record;
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

/**
 * Context for one task from a saved blueprint. The task's own words are kept exactly; the context part
 * has recognizable secrets removed, as for other model-bound text. The hash covers both and nothing
 * cosmetic (no positions or labels), so it changes only when what the task would receive changes.
 */
export function buildContext(record, itemId) {
  const built = Model.taskContext(record.blueprint, itemId, { projectName: record.name });
  if (!built) return null;
  const context = redactLocal(built.context);
  const warnings = redactLocal(built.instruction) === built.instruction ? built.warnings : [...built.warnings, 'The task text looks like it contains a secret. Remove it before sending.'];
  const hash = createHash('sha256').update(`${built.instruction}\u0000${context}`).digest('hex');
  return { ...built, context, warnings, hash, body: built.tooLarge ? '' : Model.taskBody({ ...built, context }, { projectName: record.name }) };
}

/** The first dependency loop reachable from these tasks, as display keys; prerequisites must be acyclic. */
function loopFrom(items, ids) {
  const path = [], explored = new Set();
  const visit = id => {
    if (path.includes(id)) return [...path.slice(path.indexOf(id)), id];
    if (explored.has(id) || !items.has(id)) return null;
    path.push(id);
    for (const next of items.get(id).dependsOn) { const loop = visit(next); if (loop) return loop; }
    path.pop(); explored.add(id); return null;
  };
  for (const id of ids) { const loop = visit(id); if (loop) return loop.map(entry => items.get(entry).key); }
  return null;
}

/**
 * Send tasks to the linked Kanban project's To Do. Context is rebuilt from the saved revision and saved as
 * a snapshot; one board write creates the cards, prerequisites first, each carrying its Origin identity.
 * A card that already exists for a task is returned instead of creating another. Prerequisites without a
 * card are added only when asked, and a card deleted in Kanban is recreated only when asked. Nothing starts.
 */
async function handoff({ origin, board, originId, input }) {
  const record = await origin.read(originId);
  if (!record || record.damaged) throw new OriginError('This Origin project no longer exists. Choose another project.', 'NOT_FOUND', 404);
  if (record.revision !== input.expectedRevision) throw new OriginError('The blueprint has newer changes. Let it save, then send again.', 'ORIGIN_REVISION_CONFLICT', 409);
  const destination = record.kanbanProjectId ? (await board.state()).projects.find(project => project.id === record.kanbanProjectId) : null;
  if (!destination) throw new OriginError('Connect this project to a Kanban project first.', 'NOT_LINKED', 409);
  const blueprint = record.blueprint, items = new Map(blueprint.items.map(item => [item.id, item]));
  const wanted = Array.isArray(input.itemIds) ? [...new Set(input.itemIds)] : [];
  if (!wanted.length || wanted.length > 100 || wanted.some(id => !items.has(id))) throw new OriginError('Choose 1 to 100 tasks that still exist. Reload the project.', 'INVALID_INPUT');
  const cards = new Map(destination.tasks.map(task => [task.id, task]));
  const cardOf = item => destination.tasks.find(task => task.originSource?.originProjectId === originId && task.originSource.originTaskId === item.id)
    || (item.handoff?.projectId === destination.id ? cards.get(item.handoff.taskId) : null) || null;
  const loop = loopFrom(items, wanted);
  if (loop) throw new OriginError(`These tasks wait for each other: ${loop.join(' → ')}. Remove one prerequisite first.`, 'PLAN_CYCLE', 409);
  const selection = new Set(wanted), missingNow = () => [...new Set([...selection].flatMap(id => items.get(id).dependsOn).filter(id => !selection.has(id) && !cardOf(items.get(id))))];
  let missing = missingNow();
  if (missing.length && input.includePrerequisites !== true) {
    return { status: 409, body: { error: 'Some prerequisites have no card yet. Include them, or send them first.', code: 'PREREQUISITES_MISSING',
      prerequisites: missing.map(id => ({ itemId: id, key: items.get(id).key, title: items.get(id).title })) } };
  }
  while (missing.length) { for (const id of missing) selection.add(id); missing = missingNow(); }
  const recreate = new Set(Array.isArray(input.recreate) ? input.recreate : []);
  const removed = [...selection].filter(id => items.get(id).handoff?.projectId === destination.id && !cardOf(items.get(id)) && !recreate.has(id));
  if (removed.length) {
    return { status: 409, body: { error: 'Some cards were deleted in Kanban. Choose to create them again, or leave those tasks out.', code: 'CARDS_REMOVED',
      removed: removed.map(id => ({ itemId: id, key: items.get(id).key, title: items.get(id).title })) } };
  }
  const ordered = Model.orderItems(blueprint, [...selection]), built = new Map();
  for (const id of ordered) {
    if (cardOf(items.get(id))) continue;
    const context = buildContext(record, id);
    if (context.tooLarge) throw new OriginError(context.error, 'CONTEXT_TOO_LARGE', 409);
    built.set(id, context);
  }
  const snapshots = new Map();
  for (const [id, context] of built) snapshots.set(id, await origin.snapshot(originId, context, record.revision));
  const entries = [...built.keys()].map(id => {
    const item = items.get(id), snapshot = snapshots.get(id), before = item.dependsOn.map(dep => items.get(dep));
    return { originTaskId: id, key: item.key, title: `${item.key} ${item.title.trim() || 'Untitled task'}`.slice(0, 120), prompt: built.get(id).body, snapshotId: snapshot.id, hash: snapshot.hash,
      dependsOnTaskIds: before.filter(dep => !built.has(dep.id)).map(dep => cardOf(dep).id), dependsOnOrigin: before.filter(dep => built.has(dep.id)).map(dep => dep.id) };
  });
  const made = new Map((entries.length ? await board.createOriginTasks(destination.id, { originProjectId: originId, tasks: entries }) : []).map(result => [result.originTaskId, result]));
  const results = ordered.map(id => {
    const item = items.get(id), existing = cardOf(item);
    if (existing && !built.has(id)) return { itemId: id, key: item.key, status: 'existing', taskId: existing.id, number: existing.number, title: existing.title };
    const result = made.get(id);
    return { itemId: id, key: item.key, status: result.status, taskId: result.taskId || '', number: result.number || null, title: result.title || item.title, error: result.error || '',
      snapshotId: result.status === 'created' ? snapshots.get(id).id : '', hash: result.status === 'created' ? snapshots.get(id).hash : '' };
  });
  // The Origin side records each link; a link lost by an interrupted handoff is restored from the card.
  const saved = await origin.recordHandoff(originId, results.filter(result => result.taskId).map(result => ({ itemId: result.itemId, projectId: destination.id, taskId: result.taskId, snapshotId: result.snapshotId || '', hash: result.hash || '' })));
  return { status: 200, body: { revision: saved.revision, blueprint: saved.blueprint, destination: { id: destination.id, name: destination.name }, results } };
}

/** What a card was sent with: the saved body, or (for older snapshots) the same body rebuilt from the snapshot. */
const sentBody = (snapshot, record, itemId) => (!snapshot ? null : snapshot.body ?? Model.taskBody({ ...snapshot, itemId }, { projectName: record.name }));
const todoOf = project => (project.workflowMode === 'pipeline' ? project.pipeline.columns.find(column => column.role === 'todo')?.id : 'todo');

/**
 * Which sent tasks would now receive different context. Only relevant content counts (the same hash as
 * the snapshot), so unrelated edits and diagram moves change nothing. Kanban progress is only read.
 */
async function contextStatus({ origin, board, originId, input }) {
  const record = await origin.read(originId);
  if (!record || record.damaged) throw new OriginError('This Origin project no longer exists. Choose another project.', 'NOT_FOUND', 404);
  if (record.revision !== input.expectedRevision) throw new OriginError('The blueprint has newer changes. Let it save, then check again.', 'ORIGIN_REVISION_CONFLICT', 409);
  const projects = (await board.state()).projects, tasks = [];
  for (const item of record.blueprint.items.filter(entry => entry.handoff)) {
    const destination = projects.find(project => project.id === item.handoff.projectId), card = destination?.tasks.find(task => task.id === item.handoff.taskId);
    if (!card) { tasks.push({ itemId: item.id, key: item.key, status: 'card-removed' }); continue; }
    const built = buildContext(record, item.id), snapshot = await origin.readSnapshot(originId, item.handoff.snapshotId);
    const sent = item.handoff.hash || card.originSource?.hash || '', body = sentBody(snapshot, record, item.id);
    const before = new Set((snapshot?.included || []).map(entry => entry.name)), after = new Set(built.included.map(entry => entry.name));
    tasks.push({ itemId: item.id, key: item.key, status: !sent ? 'unknown' : built.hash === sent ? 'current' : built.hash === item.handoff.keptHash ? 'kept' : 'changed',
      hash: built.hash, sentHash: sent, cardId: card.id, cardNumber: card.number, cardRevision: card.revision, idle: card.column === todoOf(destination), edited: body !== null && card.prompt !== body,
      added: [...after].filter(name => !before.has(name)), removed: snapshot ? [...before].filter(name => !after.has(name)) : [],
      sent: snapshot ? `${snapshot.instruction}\n\n${snapshot.context}` : '', now: built.tooLarge ? '' : `${built.instruction}\n\n${built.context}`, error: built.error || '' });
  }
  return { status: 200, body: { revision: record.revision, tasks } };
}

/**
 * Give one sent card the task's current context, after review. The design and the card must be what the
 * person saw; only an idle card in To Do changes; a prompt edited in Kanban is replaced only when they
 * confirm. Earlier snapshots stay for history.
 */
async function updateContext({ origin, board, originId, input }) {
  const record = await origin.read(originId);
  if (!record || record.damaged) throw new OriginError('This Origin project no longer exists. Choose another project.', 'NOT_FOUND', 404);
  if (record.revision !== input.expectedRevision) throw new OriginError('The blueprint has newer changes. Let it save, then review again.', 'ORIGIN_REVISION_CONFLICT', 409);
  const item = record.blueprint.items.find(entry => entry.id === input.itemId);
  if (!item?.handoff) throw new OriginError('This task has no Kanban card to update.', 'NOT_FOUND', 404);
  const destination = (await board.state()).projects.find(project => project.id === item.handoff.projectId), card = destination?.tasks.find(task => task.id === item.handoff.taskId);
  if (!card) throw new OriginError('Its Kanban card was deleted. Send the task again to create a new one.', 'CARD_REMOVED', 409);
  const built = buildContext(record, item.id);
  if (built.tooLarge) throw new OriginError(built.error, 'CONTEXT_TOO_LARGE', 409);
  if (built.hash !== input.expectedHash) throw new OriginError('The design changed again. Review the new context first.', 'CONTEXT_CHANGED_AGAIN', 409);
  if (card.revision !== input.expectedCardRevision) throw new OriginError('The card changed in Kanban. Review it again.', 'REVISION_CONFLICT', 409);
  const body = sentBody(await origin.readSnapshot(originId, item.handoff.snapshotId), record, item.id);
  if (body !== null && card.prompt !== body && input.replaceEdited !== true) throw new OriginError('The card’s prompt was edited in Kanban. Compare both, then confirm to replace it.', 'CARD_EDITED', 409);
  const snapshot = await origin.snapshot(originId, built, record.revision);
  const task = await board.refreshOriginTask(card.id, { prompt: built.body, snapshotId: snapshot.id, hash: snapshot.hash, expectedRevision: card.revision });
  const saved = await origin.recordHandoff(originId, [{ itemId: item.id, projectId: destination.id, taskId: card.id, snapshotId: snapshot.id, hash: snapshot.hash }]);
  return { status: 200, body: { revision: saved.revision, blueprint: saved.blueprint, task: { id: task.id, number: task.number, revision: task.revision } } };
}

/** The project as the page sees it: its Kanban link is resolved against the current board. */
function view(record, kanban) {
  const linked = record.kanbanProjectId ? kanban.find(project => project.id === record.kanbanProjectId) : null;
  return { id: record.id, name: record.name, description: record.description, kanbanProjectId: record.kanbanProjectId, revision: record.revision,
    createdAt: record.createdAt, updatedAt: record.updatedAt,
    kanban: record.kanbanProjectId ? (linked ? { exists: true, name: linked.name, revision: linked.revision } : { exists: false }) : null };
}

/** Kanban side effects go only through the board service, never by writing state.json. */
async function createKanban(board, name, id) {
  // The board takes the Origin project's ID when it is free, so the shared project keeps one ID.
  const free = id && !(await board.state()).projects.some(project => project.id === id);
  try { return { project: (await board.createProjectWithRepository({ name, folder: 'new', workflowMode: 'pipeline', ...(free ? { id } : {}) })).project }; }
  catch (error) { return { error: { message: error.message || 'The Kanban project could not be created.', code: error.code || 'KANBAN_FAILED' } }; }
}

/**
 * /api/origin/projects: list and create. /api/origin/projects/:id: read, save the blueprint (PUT), rename
 * (PATCH). /link connects a Kanban project; /delete removes the Origin project and, only when asked,
 * the linked Kanban project through Kanban's own deletion checks.
 */
export async function originRoute({ origin, contexts, board, req, res, pathname, jsonBody, send }) {
  const kanban = async () => (await board.state()).projects;
  const body = async () => {
    const value = await jsonBody(req, BODY_LIMIT);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OriginError('Send a JSON object.', 'INVALID_REQUEST');
    return value;
  };
  if (pathname === '/api/origin/projects') {
    if (req.method === 'GET') { const projects = await kanban(); return send(res, 200, { projects: (await origin.list()).map(record => view(record, projects)) }); }
    if (req.method !== 'POST') return send(res, 404, { error: 'This Origin route does not exist.' });
    const input = await body(), name = typeof input.name === 'string' ? input.name.trim().toLocaleLowerCase() : '';
    // One project per name across Origin, Compose and Kanban. A board of this name that no Origin project
    // uses already is this project's board: the Origin project takes the board's ID and links to it.
    const records = await origin.list(), boards = await kanban();
    if (name && records.some(record => record.name.toLocaleLowerCase() === name)) throw new OriginError('A project with this name already exists. Choose it from the project list.', 'NAME_TAKEN', 409);
    const joined = name && boards.find(project => project.name.toLocaleLowerCase() === name && !records.some(record => record.kanbanProjectId === project.id || record.id === project.id));
    if (joined) {
      const adopted = await origin.create({ name: input.name, description: input.description, id: joined.id, kanbanProjectId: joined.id });
      return send(res, 200, { project: view(adopted, await kanban()), blueprint: adopted.blueprint, joinedKanban: true });
    }
    const created = await origin.create({ name: input.name, description: input.description });
    if (input.createKanban !== true) return send(res, 200, { project: view(created, await kanban()), blueprint: created.blueprint });
    const made = await createKanban(board, created.name, created.id);
    if (made.error) return send(res, 200, { project: view(created, await kanban()), blueprint: created.blueprint, kanbanError: made.error });
    const linked = await origin.link(created.id, { expectedRevision: created.revision, kanbanProjectId: made.project.id });
    return send(res, 200, { project: view(linked, await kanban()), blueprint: linked.blueprint });
  }
  const match = pathname.match(/^\/api\/origin\/projects\/([A-Za-z0-9_-]{1,100})(?:\/(link|delete|context|handoff|context-status|update-context))?$/);
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
      const made = await createKanban(board, typeof input.name === 'string' && input.name.trim() ? input.name : record.name, record.id);
      if (made.error) throw new OriginError(made.error.message, made.error.code, 409);
      kanbanProjectId = made.project.id;
    } else if (kanbanProjectId !== null && !(await kanban()).some(project => project.id === kanbanProjectId)) {
      throw new OriginError('That Kanban project no longer exists. Choose another one.', 'NOT_FOUND', 404);
    }
    const saved = await origin.link(originId, { expectedRevision: input.expectedRevision, kanbanProjectId });
    return send(res, 200, { project: view(saved, await kanban()), revision: saved.revision });
  }
  if (action === 'context' && req.method === 'POST') {
    const input = await body();
    const { record, tasks } = await origin.context(originId, { expectedRevision: input.expectedRevision, itemIds: input.itemIds });
    return send(res, 200, { revision: record.revision, tasks: tasks.map(({ itemId, key, title, body: text, instruction, context, included, omitted, warnings, tooLarge, error, hash, size }) =>
      ({ itemId, key, title, body: text, instruction, context, included, omitted, warnings, tooLarge, error: error || '', hash, size })) });
  }
  if ((action === 'context-status' || action === 'update-context') && req.method === 'POST') {
    const { status, body: result } = await (action === 'context-status' ? contextStatus : updateContext)({ origin, board, originId, input: await body() });
    return send(res, status, result);
  }
  if (action === 'handoff' && req.method === 'POST') {
    const { status, body: result } = await handoff({ origin, board, originId, input: await body() });
    return send(res, status, result);
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
    await contexts?.archive(originId).catch(() => {}); // Kept in origin/deleted/; Base copies stay usable.
    return send(res, 200, { deleted: true, kanbanDeleted });
  }
  return send(res, 404, { error: 'This Origin route does not exist.' });
}
