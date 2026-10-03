/** Read-only exact-thread lookup. Never substitute a recent or related thread. */
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_ENTRIES = 30000, MAX_DIRECTORIES = 2048, HEAD_BYTES = 1024 * 1024;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;
const validDate = (value, rendered) => Number.isFinite(value.getTime()) && value.toISOString().slice(0, rendered.length) === rendered;
const dayFor = value => {
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? [String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')] : null;
};
const directory = async path => { const s = await lstat(path).catch(() => null); return Boolean(s?.isDirectory() && !s.isSymbolicLink()); };

async function mainThread(path, threadId) {
  const before = await lstat(path).catch(() => null);
  if (!before?.isFile() || before.isSymbolicLink()) return false;
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)).catch(() => null);
  if (!handle) return false;
  try {
    const owned = await handle.stat();
    if (!owned.isFile() || owned.dev !== before.dev || owned.ino !== before.ino) return false;
    const bytes = Buffer.alloc(Math.min(owned.size, HEAD_BYTES)), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const end = bytes.subarray(0, bytesRead).indexOf(10);
    if (end < 0) return false; // Metadata must be a complete bounded first record.
    const first = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, end)));
    return first?.type === 'session_meta' && first.payload?.id === threadId
      && (first.payload.source === undefined || first.payload.source === 'cli');
  } catch { return false; }
  finally { await handle.close(); }
}

export async function locateCodexRollout(threadId, startedAt, home, { maxEntries = MAX_ENTRIES, maxDirectories = MAX_DIRECTORIES } = {}) {
  if (typeof threadId !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(threadId) || typeof home !== 'string' || home.includes('\0')) return null;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ENTRIES
    || !Number.isSafeInteger(maxDirectories) || maxDirectories < 1 || maxDirectories > MAX_DIRECTORIES) return null;
  const resolved = await realpath(home).catch(() => null);
  if (!resolved) return null;
  const root = join(resolved, 'sessions');
  if (!await directory(root)) return null;
  const budget = { entries: 0, directories: 0 }, visited = new Set(), candidates = [];
  let invalid = false;
  const entries = async path => {
    if (++budget.directories > maxDirectories) throw new Error('Directory bound');
    if (!await directory(path)) return [];
    const dir = await opendir(path).catch(() => null);
    if (!dir) return [];
    const rows = [];
    try {
      for await (const entry of dir) {
        if (++budget.entries > maxEntries) throw new Error('Entry bound');
        rows.push(entry);
      }
    } finally { await dir.close().catch(() => {}); }
    return rows;
  };
  const scanDay = async parts => {
    const day = parts.join('-');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !validDate(new Date(`${day}T00:00:00Z`), day)) return;
    const path = join(root, ...parts);
    if (visited.has(path)) return;
    visited.add(path);
    if (!await directory(join(root, parts[0])) || !await directory(join(root, ...parts.slice(0, 2)))) return;
    for (const entry of await entries(path)) {
      const extension = entry.name.endsWith('.jsonl.zst') ? '.jsonl.zst' : entry.name.endsWith('.jsonl') ? '.jsonl' : null;
      if (!entry.name.startsWith('rollout-') || !extension) continue;
      const core = entry.name.slice(8, -extension.length);
      if (!timestamp.test(core.slice(0, 19)) || core[19] !== '-') continue;
      const stamp = core.slice(0, 19), iso = `${stamp.slice(0, 13)}:${stamp.slice(14, 16)}:${stamp.slice(17, 19)}`;
      if (!validDate(new Date(`${iso}Z`), iso)) continue;
      const ids = core.slice(20);
      if (ids !== threadId && !ids.startsWith(threadId + '_')) continue;
      // Revert preserves the thread ID but creates a distinct immutable rollout.
      // An authoritative active-rollout locator is required before choosing one.
      if (ids !== threadId || extension !== '.jsonl' || !entry.isFile() || entry.isSymbolicLink()) { invalid = true; return; }
      const candidate = join(path, entry.name);
      if (!await mainThread(candidate, threadId)) invalid = true;
      else candidates.push(candidate);
      if (invalid || candidates.length > 1) return; // At most two bounded metadata reads.
    }
  };
  try {
    for (const parts of [dayFor(startedAt), dayFor(Date.now())].filter(Boolean)) await scanDay(parts);
    if (invalid || candidates.length > 1) return null;
    // Resume keeps the original file date. Search canonical date directories
    // with a finite budget, including when a preferred date matched: another
    // immutable rollout can share the thread ID. Do not guess which is active.
    // Do not scan archives, credentials or arbitrary trees.
    for (const year of await entries(root)) {
      if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
      for (const month of await entries(join(root, year.name))) {
        if (!month.isDirectory() || !/^(0[1-9]|1[0-2])$/.test(month.name)) continue;
        for (const day of await entries(join(root, year.name, month.name))) {
          if (!day.isDirectory() || !/^(0[1-9]|[12]\d|3[01])$/.test(day.name)) continue;
          await scanDay([year.name, month.name, day.name]);
          if (invalid || candidates.length > 1) return null;
        }
      }
    }
    return candidates.length === 1 ? candidates[0] : null;
  } catch { return null; } // Exhaustion or unavailable I/O cannot choose a partial match.
}
