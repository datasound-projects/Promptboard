// One Promptboard per data folder. Two apps on the same folder would each save the board from their own copy
// (one overwrites the other's changes) and both would run Autopilot on the same cards. The lock names the running
// app; a lock left behind by an app that stopped or crashed is replaced.
import { mkdir, open, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

export class DataDirInUse extends Error {
  constructor(message, url = '') { super(message); this.code = 'DATA_DIR_IN_USE'; this.url = url; }
}
const held = new Set(); // Locks this process holds: a second server here on the same folder is refused too.
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
/** A process ID can be reused after a crash: the lock counts only while that app still answers on its port. */
async function answers(port) {
  if (!Number.isInteger(port) || port <= 0) return false;
  try { const response = await fetch(`http://127.0.0.1:${port}/api/session`, { signal: AbortSignal.timeout(1500) }); return response.ok && typeof (await response.json()).token === 'string'; }
  catch { return false; }
}

/** Claim `dataDir` for this app. Returns { path, setPort(port), release() }; throws DataDirInUse while another app uses it. */
export async function lockDataDir(dataDir) {
  // A folder made only for the lock is removed again when it is still empty, so starting and stopping leaves nothing.
  const created = Boolean(await mkdir(dataDir, { recursive: true, mode: 0o700 }));
  const path = join(dataDir, 'instance.lock');
  if (held.has(path)) throw new DataDirInUse('Promptboard is already running with this data folder in this process.');
  for (let attempt = 0; ; attempt++) {
    const lock = { pid: process.pid, host: hostname(), startedAt: Date.now(), port: 0 };
    try {
      const handle = await open(path, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(lock)); } finally { await handle.close(); }
      held.add(path);
      let released = false;
      return {
        path,
        async setPort(port) { lock.port = port; await writeFile(path, JSON.stringify(lock), { mode: 0o600 }).catch(() => {}); },
        async release() {
          if (released) return; released = true; held.delete(path);
          // Only our own lock is removed, never one that a later app took over.
          const current = await readFile(path, 'utf8').then(JSON.parse, () => null);
          if (current?.pid === process.pid && current.startedAt === lock.startedAt) await rm(path, { force: true }).catch(() => {});
          if (created) await rmdir(dataDir).catch(() => {}); // Fails, as it should, once anything else is in it.
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST' || attempt > 0) throw error;
      const other = await readFile(path, 'utf8').then(JSON.parse, () => null);
      const url = other?.port ? `http://127.0.0.1:${other.port}` : '';
      const starting = other && other.port === 0 && Date.now() - other.startedAt < 30000;
      if (other && other.pid !== process.pid && alive(other.pid) && (starting || await answers(other.port))) {
        throw new DataDirInUse(`Promptboard is already running with this data folder${url ? ` at ${url}` : ''}. Open that one, or stop it first.`, url);
      }
      await rm(path, { force: true }); // Left by an app that is no longer running.
    }
  }
}
