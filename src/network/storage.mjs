/**
 * File discipline for every Network domain (docs/network/architecture.md §4.2): versioned JSON documents under
 * <dataDir>/network/, written through durable.mjs. A mutable document keeps a `.bak`; a damaged copy is set aside when
 * the other one loads; no usable copy, or a copy saved by a newer version, is refused and never rewritten. Immutable
 * documents are written once under a name that carries the SHA-256 of their exact bytes and are checked on every read.
 * Also the input rules every Network domain shares: strict objects, expected revisions, paging and owner text.
 */
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { redactLocal } from '../compose-local.mjs';
import { noPaths } from '../coordinator.mjs';
import { readWithBackup, setAside, syncDir, writeAtomic } from '../durable.mjs';

export class NetworkError extends Error {
  constructor(message, code = 'INVALID_INPUT', status = 400, details) { super(message); this.code = code; this.status = status; if (details) this.details = details; }
}
export const fail = (message, code, status, details) => { throw new NetworkError(message, code, status, details); };
/** `<prefix>_` + 20 lowercase hex characters: server-generated, so it is safe in a file name. */
export const newId = prefix => `${prefix}_${randomBytes(10).toString('hex')}`;
export const sha256 = text => createHash('sha256').update(text).digest('hex');

export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const conflict = what => fail(`${what} changed since you loaded it. Reload and try again.`, 'REVISION_CONFLICT', 409);
export function requireRevision(input) { if (!Number.isSafeInteger(input.expectedRevision)) fail('Reload, then send the revision you loaded as expectedRevision.', 'REVISION_REQUIRED'); }
/** Strict input: a field this model does not own is refused, so nothing from Base is ever copied into Network. */
export function only(input, allowed, what) {
  if (!object(input)) fail(`Send ${what} as a JSON object.`);
  const extra = Object.keys(input).find(key => !allowed.includes(key));
  if (extra === undefined) return;
  const base = ['provider', 'model', 'effort', 'instructions', 'tools', 'prompt', 'skills'].includes(extra) ? ' Provider, model, instructions and tools come from the Base agent: change them in Base.' : '';
  fail(`"${extra.slice(0, 40)}" is not a field of ${what}.${base}`);
}
export const PAGE_LIMIT = 200;
export function page(items, offset = 0, limit = 50, key) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_LIMIT) fail(`Choose an offset of 0 or more and a limit of 1 to ${PAGE_LIMIT}.`);
  return { total: items.length, offset, limit, next: offset + limit < items.length ? offset + limit : null, [key]: items.slice(offset, offset + limit) };
}
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
/**
 * Long owner text (memory, reports) as it is saved and shown: line breaks normalised, control characters dropped, local
 * folders cut to their last name and secret-looking values masked (as Project memory does, src/lessons.mjs), because it
 * can reach a cloud-backed CLI or an export.
 */
export const cleanText = value => redactLocal(noPaths(String(value).replace(/\r\n?/g, '\n').replace(CONTROL, ''))).trim();
/** Line breaks (also the Unicode ones) and tabs: refused in one-line owner text (names, labels, keys), so none can start a prompt line. */
export const LINE_BREAK = /[\t\n\r\u0085\u2028\u2029]/;
/** Owner text placed on one line of a prompt: cleaned, every run of white space one space. */
export const oneLine = value => cleanText(value).replace(/[\s\u0085]+/g, ' ');
/**
 * Multi-line text placed inside a delimited prompt section (memory records; Task 07: the job input and instructions):
 * every line indented two spaces, so no line of it can close or forge a section delimiter.
 */
export const indent = value => String(value).split(/\r\n?|[\n\u0085\u2028\u2029]/).map(line => `  ${line}`).join('\n');

const NEWER = 'This Network data was saved by a newer Promptboard version. Update the app; nothing was changed.';

/**
 * A mutable document (the file, then its backup) whose `schema` matches, `version` equals `supported` and `valid(data)`
 * holds; undefined when neither exists. A damaged copy is set aside once the other loads; with no usable copy the read
 * fails (`NETWORK_DATA_DAMAGED`) and nothing is moved or written.
 */
export async function readDocument(path, { schema, supported = 1, valid, label, recover }) {
  const damaged = []; let source;
  const data = await readWithBackup([path, `${path}.bak`], (bytes, file) => {
    let value; try { value = JSON.parse(bytes.toString('utf8')); } catch {}
    if (value?.schema === schema && Number.isSafeInteger(value.version) && value.version > supported) fail(NEWER, 'NETWORK_VERSION_UNSUPPORTED', 409);
    if (value?.schema === schema && value.version === supported && valid(value)) { source = file; return value; }
    damaged.push(file);
  });
  if (data === undefined && damaged.length) fail(`${label} is damaged and has no usable backup. Nothing was changed; move the damaged file out of the data folder to start again.`, 'NETWORK_DATA_DAMAGED', 409);
  await setAside(damaged);
  return data !== undefined && source !== path && recover ? recover(data) : data;
}

const settingsReads = new Map();
/**
 * A settings backup may predate a revoke, a narrower scope or switching automation off. Persist the caller's safe reset
 * before returning any authority, also when the primary is missing. Keep the backup and damaged bytes for inspection.
 * The marker survives restarts; recovery is not repeated on an intact primary. Failed writes grant no authority.
 */
export function readSettings(path, { reset, now = Date.now, events, recoveryMessage, ...options }) {
  if (settingsReads.has(path)) return settingsReads.get(path);
  const pending = readDocument(path, { ...options, recover: async data => {
    const recovery = { at: now(), code: 'SETTINGS_RECOVERED', message: recoveryMessage || `${options.label} was read from a backup. Access and automation were switched off. Review the recovered settings before enabling them again.` };
    const next = { ...await reset(data, recovery.at), revision: data.revision + 2, recovery };
    await writeDocument(path, next);
    try { await events?.append({ type: 'settings.recovered', status: 'off', errorCode: recovery.code, message: recovery.message }); } catch {} // Observability never grants authority.
    return next;
  } }).finally(() => { if (settingsReads.get(path) === pending) settingsReads.delete(path); });
  settingsReads.set(path, pending);
  return pending;
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

/**
 * Write `text` once, without a backup; the caller's name (or record) carries `sha256(text)`, so a second write is the same
 * bytes. `what` names it in the error.
 */
export async function writeImmutable(path, text, what = 'The published version') {
  try { await folder(dirname(path)); await writeAtomic(path, text, { backup: false }); }
  catch { fail(`${what} could not be saved. Check free disk space and folder permissions. Nothing was changed.`, 'NETWORK_WRITE_FAILED', 500); }
}

/**
 * A draft read from its backup (its own file was damaged and set aside, or is missing) is the save before the last one,
 * which may have been a publish: its `publishedVersions` then lacks a version whose immutable file is still in `dir`, so
 * that version would read as missing and the next publish would reuse its number for other content. Answers the draft with
 * every `v<n>-<sha256>.json` it does not list yet that still hashes to its name, is its version `n` (`mine(body)`) and
 * continues the list in order, as `entry(body, sha256)`. A draft read from its own file is answered as it is.
 */
export async function withVersionsOnDisk(path, draft, dir, mine, entry) {
  if (await access(path).then(() => true, () => false)) return draft;
  let names = [];
  try { names = await readdir(dir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const listed = new Set(draft.publishedVersions.map(item => item.version)), found = [];
  for (const name of names) {
    const [, number, hash] = /^v(\d+)-([0-9a-f]{64})\.json$/.exec(name) ?? [];
    if (!hash || listed.has(Number(number))) continue;
    let body = null;
    try { const text = await readFile(join(dir, name), 'utf8'); if (sha256(text) === hash) body = JSON.parse(text); } catch {}
    if (body?.version === 1 && body.number === Number(number) && mine(body)) { found.push(entry(body, hash)); listed.add(body.number); }
  }
  // Only the versions that continue the list in order: a saved list is always 1, 2, 3, … (a gap would make the draft unreadable).
  const next = [...draft.publishedVersions];
  for (const item of found.sort((a, b) => a.version - b.version)) if (item.version === next.length + 1) next.push(item);
  return next.length > draft.publishedVersions.length ? { ...draft, publishedVersions: next } : draft;
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
