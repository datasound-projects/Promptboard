/**
 * Durable local files for every store that keeps its own JSON in the data folder: an atomic replace that
 * keeps the previous file as a backup, a read that falls back to that backup, and a one-at-a-time queue.
 * Callers keep their own error classes and messages.
 */
import { randomBytes } from 'node:crypto';
import { copyFile, link, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Flush a folder's entries (after a rename) to disk. Some systems (Windows) cannot; that is ignored. */
export async function syncDir(dir) {
  try { const handle = await open(dir, 'r'); try { await handle.sync(); } finally { await handle.close(); } } catch {}
}

const temporary = path => `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;

/**
 * Keep `path` as `${path}.bak`. A hard link costs nothing at any file size, and the rename that follows
 * replaces only the name `path`, so the backup keeps the previous bytes. Where links are not possible
 * (some file systems, Windows quirks) the file is copied as before. The new backup is made under a
 * temporary name and renamed over the old one, so a crash never leaves no backup; a missing `path`
 * (a damaged file set aside) leaves the existing backup, then the only good copy, as it is.
 */
async function keepBackup(path) {
  const next = temporary(path);
  try {
    try { await link(path, next); } catch (error) { if (error.code === 'ENOENT') return; await copyFile(path, next); }
    await rename(next, `${path}.bak`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  finally { await rm(next, { force: true }).catch(() => {}); } // Left when the backup already was this file.
}

/**
 * Replace `path` with `bytes`: a new private temporary file, fsync, the old file kept as `.bak` (unless
 * `backup: false`), rename, then fsync the folder. On failure the temporary file is removed and the error
 * is thrown; the old file is unchanged.
 */
export async function writeAtomic(path, bytes, { backup = true } = {}) {
  const tmp = temporary(path);
  try {
    const handle = await open(tmp, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    if (backup) await keepBackup(path);
    await rename(tmp, path);
  } catch (error) { await rm(tmp, { force: true }).catch(() => {}); throw error; }
  await syncDir(dirname(path));
}

/**
 * The first of `paths` (a file, then its backup) that `parse(bytes, path)` accepts, or undefined. `parse` returns
 * undefined for a damaged file and may throw to stop. Only a missing file is skipped: any other read error
 * is thrown, so a failing disk is never taken for "no data" that the next save would overwrite.
 */
export async function readWithBackup(paths, parse) {
  for (const path of paths) {
    let bytes;
    try { bytes = await readFile(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const value = await parse(bytes, path);
    if (value !== undefined) return value;
  }
}

/**
 * Set damaged files (those `parse` refused in `readWithBackup`) aside as `<file>.corrupt-<time>-<random>`, so
 * the next save never makes one the backup in place of the only good copy. A file already gone is skipped.
 */
export async function setAside(files) {
  for (const file of files) await rename(file, `${file}.corrupt-${Date.now()}-${randomBytes(4).toString('hex')}`).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

/** A queue: each `run(work)` starts after the previous one settles, whatever its outcome. */
export function serial() {
  let queue = Promise.resolve();
  return work => { const next = queue.then(work, work); queue = next.catch(() => {}); return next; };
}
