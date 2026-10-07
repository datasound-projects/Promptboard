/**
 * Origin blueprint persistence. Each Promptboard project has its own versioned JSON file in
 * <dataDir>/origin/, outside the board state: Origin never changes state.json, so a board stays
 * readable by Promptboard versions without Origin. Writes are serialized and atomic (temp file +
 * fsync + rename), keep the previous good file as a backup, and quarantine a damaged file instead
 * of overwriting it. Origin never starts agents and never writes board, Base or repository data.
 */
import '../public/origin-model.js';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

const Model = globalThis.PromptboardOriginModel;
export const ORIGIN_DIR = 'origin';
const BODY_LIMIT = 4 * 1024 * 1024;

export class OriginError extends Error {
  constructor(message, code, status = 400) { super(message); this.code = code; this.status = status; }
}

/**
 * File name from a validated project ID only. Uppercase letters and "_" are escaped so IDs that
 * differ only in case cannot share a file on case-insensitive file systems; the prefix avoids
 * reserved device names on Windows.
 */
export function originFileName(projectId) {
  if (typeof projectId !== 'string' || !Model.ID.test(projectId)) throw new OriginError('Choose a valid project.', 'INVALID_PROJECT');
  return `project-${projectId.replace(/[A-Z_]/g, character => `_${character === '_' ? '_' : character.toLowerCase()}`)}.json`;
}

export class OriginStore {
  constructor(dataDir) {
    this.dir = join(dataDir, ORIGIN_DIR);
    this.queue = Promise.resolve();
    this.ready = null;
  }

  // ponytail: one queue for all projects; per-project queues if blueprint saves ever contend.
  #serial(work) {
    const run = async () => {
      this.ready ??= (async () => {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        // Temporary files from an interrupted write are never valid blueprints.
        for (const name of await readdir(this.dir)) if (name.includes('.json.tmp-')) await rm(join(this.dir, name), { force: true });
      })().catch(error => { this.ready = null; throw error; });
      await this.ready;
      return work();
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  async #parse(path, projectId) {
    const data = JSON.parse(await readFile(path, 'utf8'));
    if (!data || typeof data !== 'object' || data.schema !== Model.SCHEMA || data.projectId !== projectId) throw new Error('Unknown Origin file.');
    if (typeof data.version === 'number' && data.version > Model.VERSION) {
      throw new OriginError('This blueprint was saved by a newer Promptboard version. Update the app; the file was not changed.', 'ORIGIN_VERSION_UNSUPPORTED', 409);
    }
    if (data.version !== Model.VERSION || !Number.isSafeInteger(data.revision) || data.revision < 1) throw new Error('Unsupported Origin file.');
    const { blueprint, repairs } = Model.normalizeBlueprint(data.blueprint);
    const time = value => (Number.isSafeInteger(value) && value > 0 ? value : null);
    return { exists: true, revision: data.revision, createdAt: time(data.createdAt), updatedAt: time(data.updatedAt), blueprint, repairs };
  }

  /** A missing file means no blueprint yet. A damaged file is kept aside; the last good backup is used. */
  async #read(projectId) {
    const name = originFileName(projectId), path = join(this.dir, name);
    // Only content problems count as damage. Permission and I/O errors are reported, never "repaired".
    const damaged = error => !error.code || error.code === 'ORIGIN_INVALID';
    try { return { ...(await this.#parse(path, projectId)), recovery: null }; }
    catch (error) {
      if (!damaged(error) && error.code !== 'ENOENT') throw error.code === 'ORIGIN_VERSION_UNSUPPORTED' ? error : new OriginError('The blueprint could not be read. Check folder permissions.', 'ORIGIN_READ_FAILED', 500);
      let result = null;
      try { result = await this.#parse(`${path}.bak`, projectId); }
      catch (backupError) {
        // A newer backup is evidence of a newer installation, not damage to overwrite.
        if (backupError.code === 'ORIGIN_VERSION_UNSUPPORTED') throw backupError;
      }
      let recovery = result ? { restoredFromBackup: true, quarantined: null } : null;
      if (error.code !== 'ENOENT') {
        const quarantined = `${name.slice(0, -5)}.corrupt-${Date.now()}-${randomBytes(4).toString('hex')}.json`;
        await rename(path, join(this.dir, quarantined));
        recovery = { restoredFromBackup: Boolean(result), quarantined };
      }
      return result ? { ...result, recovery } : { exists: false, revision: 0, createdAt: null, updatedAt: null, blueprint: null, repairs: 0, recovery };
    }
  }

  async #write(projectId, data) {
    const path = join(this.dir, originFileName(projectId));
    const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      const handle = await open(tmp, 'wx', 0o600);
      try { await handle.writeFile(`${JSON.stringify(data, null, 1)}\n`); await handle.sync(); }
      finally { await handle.close(); }
      try { await copyFile(path, `${path}.bak`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rename(tmp, path);
    } catch {
      await rm(tmp, { force: true }).catch(() => {});
      throw new OriginError('The blueprint could not be saved. Check free disk space and folder permissions. Nothing else was changed.', 'ORIGIN_WRITE_FAILED', 500);
    }
    try { const dir = await open(this.dir, 'r'); try { await dir.sync(); } finally { await dir.close(); } } catch {}
  }

  read(projectId) {
    try { originFileName(projectId); } catch (error) { return Promise.reject(error); }
    return this.#serial(() => this.#read(projectId));
  }

  /** Replace the blueprint when `expectedRevision` matches the saved revision (0 before the first save). */
  write(projectId, { expectedRevision, blueprint } = {}) {
    try { originFileName(projectId); } catch (error) { return Promise.reject(error); }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return Promise.reject(new OriginError('Reload the blueprint before saving.', 'INVALID_REVISION'));
    let normalized;
    try { normalized = Model.normalizeBlueprint(blueprint); } catch (error) { return Promise.reject(error); }
    return this.#serial(async () => {
      const current = await this.#read(projectId);
      if (current.revision !== expectedRevision) throw new OriginError('This blueprint changed in another window. Reload it before saving.', 'ORIGIN_REVISION_CONFLICT', 409);
      const now = Date.now();
      const data = { schema: Model.SCHEMA, version: Model.VERSION, projectId, revision: current.revision + 1, createdAt: current.createdAt || now, updatedAt: now, blueprint: normalized.blueprint };
      await this.#write(projectId, data);
      return { exists: true, revision: data.revision, createdAt: data.createdAt, updatedAt: now, blueprint: normalized.blueprint, repairs: normalized.repairs, recovery: current.recovery };
    });
  }
}

/** GET/PUT /api/origin/projects/:id. The project must exist on the board; the board itself is only read. */
export async function originRoute({ origin, board, req, res, pathname, jsonBody, send }) {
  const match = pathname.match(/^\/api\/origin\/projects\/([A-Za-z0-9_-]{1,100})$/);
  if (!match || !['GET', 'PUT'].includes(req.method)) return send(res, 404, { error: 'This Origin route does not exist.' });
  const projectId = match[1];
  if (!(await board.state()).projects.some(project => project.id === projectId)) throw new OriginError('This project no longer exists. Choose another project.', 'NOT_FOUND', 404);
  if (req.method === 'GET') return send(res, 200, { projectId, ...(await origin.read(projectId)) });
  const body = await jsonBody(req, BODY_LIMIT);
  if (!body || typeof body !== 'object' || Array.isArray(body) || !body.blueprint || typeof body.blueprint !== 'object' || Array.isArray(body.blueprint)) {
    throw new OriginError('Send a blueprint object and its expected revision.', 'INVALID_REQUEST');
  }
  return send(res, 200, { projectId, ...(await origin.write(projectId, { expectedRevision: body.expectedRevision, blueprint: body.blueprint })) });
}
