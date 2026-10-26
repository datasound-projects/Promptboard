/**
 * File discipline for every Network domain (docs/network/architecture.md §4.2): versioned JSON documents under
 * <dataDir>/network/, written through durable.mjs. A mutable document keeps a `.bak`; a damaged copy is set aside when
 * the other one loads; no usable copy, or a copy saved by a newer version, is refused and never rewritten. Immutable
 * documents are written once under a name that carries the SHA-256 of their exact bytes and are checked on every read.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readWithBackup, setAside, syncDir, writeAtomic } from '../durable.mjs';

export class NetworkError extends Error {
  constructor(message, code = 'INVALID_INPUT', status = 400, details) { super(message); this.code = code; this.status = status; if (details) this.details = details; }
}
export const fail = (message, code, status, details) => { throw new NetworkError(message, code, status, details); };
/** `<prefix>_` + 20 lowercase hex characters: server-generated, so it is safe in a file name. */
export const newId = prefix => `${prefix}_${randomBytes(10).toString('hex')}`;
export const sha256 = text => createHash('sha256').update(text).digest('hex');
const NEWER = 'This Network data was saved by a newer Promptboard version. Update the app; nothing was changed.';

/**
 * A mutable document (the file, then its backup) whose `schema` matches, `version` equals `supported` and `valid(data)`
 * holds; undefined when neither exists. A damaged copy is set aside once the other loads; with no usable copy the read
 * fails (`NETWORK_DATA_DAMAGED`) and nothing is moved or written.
 */
export async function readDocument(path, { schema, supported = 1, valid, label }) {
  const damaged = [];
  const data = await readWithBackup([path, `${path}.bak`], (bytes, file) => {
    let value; try { value = JSON.parse(bytes.toString('utf8')); } catch {}
    if (value?.schema === schema && Number.isSafeInteger(value.version) && value.version > supported) fail(NEWER, 'NETWORK_VERSION_UNSUPPORTED', 409);
    if (value?.schema === schema && value.version === supported && valid(value)) return value;
    damaged.push(file);
  });
  if (data === undefined && damaged.length) fail(`${label} is damaged and has no usable backup. Nothing was changed; move the damaged file out of the data folder to start again.`, 'NETWORK_DATA_DAMAGED', 409);
  await setAside(damaged);
  return data;
}

/** Folders are private and recorded in their parents, so a power loss cannot lose a folder a saved file names. */
async function folder(dir) {
  const first = await mkdir(dir, { recursive: true, mode: 0o700 });
  if (first) for (let made = dir; ; made = dirname(made)) { await syncDir(dirname(made)); if (made === first || made === dirname(made)) break; }
}

export async function writeDocument(path, data) {
  try { await folder(dirname(path)); await writeAtomic(path, `${JSON.stringify(data, null, 1)}\n`); }
  catch { fail('Network data could not be saved. Check free disk space and folder permissions. Nothing was changed.', 'NETWORK_WRITE_FAILED', 500); }
}

/** Write `text` once, without a backup; the caller's name carries `sha256(text)`, so a second write is the same bytes. */
export async function writeImmutable(path, text) {
  try { await folder(dirname(path)); await writeAtomic(path, text, { backup: false }); }
  catch { fail('The published version could not be saved. Check free disk space and folder permissions. Nothing was changed.', 'NETWORK_WRITE_FAILED', 500); }
}

/** An immutable document whose bytes must still hash to `hash` and pass `valid`; anything else is refused, never repaired. */
export async function readImmutable(path, hash, { schema, supported = 1, valid }) {
  let text, value;
  try { text = await readFile(path, 'utf8'); } catch { fail('A published version cannot be read from the data folder. Nothing was changed.', 'NETWORK_CONTENT_UNAVAILABLE', 409); }
  try { value = JSON.parse(text); } catch {}
  const intact = sha256(text) === hash;
  if (intact && value?.schema === schema && Number.isSafeInteger(value.version) && value.version > supported) fail(NEWER, 'NETWORK_VERSION_UNSUPPORTED', 409);
  if (!intact || value?.schema !== schema || value.version !== supported || !valid(value)) fail('A published version failed its integrity check. It was left unchanged.', 'NETWORK_CONTENT_INVALID', 409);
  return value;
}
