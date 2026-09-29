/**
 * Server-owned board state: one versioned JSON file in a local application-data folder.
 * Writes are serialized, atomic (temp file + fsync + rename), and keep the previous good
 * file as a backup. Logs and artifacts belong in separate folders, never in this file.
 */
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const STATE_SCHEMA = 'promptboard.state';
export const STATE_VERSION = 2;
const STATE_FILE = 'state.json';

export function defaultDataDir(env = process.env, platform = process.platform) {
  if (env.PROMPTBOARD_DATA_DIR) return env.PROMPTBOARD_DATA_DIR;
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Promptboard');
  if (platform === 'win32') return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Promptboard');
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'promptboard');
}

export function emptyState() {
  return { schema: STATE_SCHEMA, version: STATE_VERSION, revision: 0, settings: { execution: 'inactive' }, projects: [], runs: [], migrations: [] };
}

export class StoreError extends Error {
  constructor(message, code, status = 500) { super(message); this.code = code; this.status = status; }
}

function checkShape(data) {
  if (!data || typeof data !== 'object' || data.schema !== STATE_SCHEMA) throw new Error('Unknown state file.');
  if (data.version > STATE_VERSION) throw new StoreError('The board was saved by a newer Promptboard version. Update the app; the file was not changed.', 'STATE_VERSION_UNSUPPORTED');
  if (data.version !== STATE_VERSION || !Array.isArray(data.projects) || !Array.isArray(data.runs)) throw new Error('Unsupported state shape.');
  return { ...emptyState(), ...data };
}

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.path = join(dir, STATE_FILE);
    this.state = null;
    this.recovery = null; // Public note when the file had to be recovered.
    this.queue = Promise.resolve();
  }

  async #readFile(path) { return checkShape(JSON.parse(await readFile(path, 'utf8'))); }

  /** Load once. A corrupt file falls back to the backup; neither file is overwritten silently. */
  async load() {
    if (this.state) return this.state;
    this.loading ??= (async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      // Temporary files from an interrupted write are never valid state.
      for (const name of await readdir(this.dir)) if (name.startsWith(`${STATE_FILE}.tmp-`)) await rm(join(this.dir, name), { force: true });
      let state;
      try { state = await this.#readFile(this.path); }
      catch (error) {
        if (error.code === 'STATE_VERSION_UNSUPPORTED') throw error;
        if (error.code === 'ENOENT') state = emptyState();
        else {
          const quarantined = `state.corrupt-${Date.now()}.json`;
          await rename(this.path, join(this.dir, quarantined));
          try { state = await this.#readFile(`${this.path}.bak`); this.recovery = { restoredFromBackup: true, quarantined }; }
          catch { state = emptyState(); this.recovery = { restoredFromBackup: false, quarantined }; }
        }
      }
      this.state = state;
      return state;
    })();
    try { return await this.loading; } finally { this.loading = null; }
  }

  async #write(state) {
    const tmp = `${this.path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    const handle = await open(tmp, 'w', 0o600);
    try { await handle.writeFile(`${JSON.stringify(state, null, 1)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    try { await copyFile(this.path, `${this.path}.bak`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rename(tmp, this.path);
    try { const dir = await open(this.dir, 'r'); try { await dir.sync(); } finally { await dir.close(); } } catch {}
  }

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
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }
}
