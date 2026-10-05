/** Immutable, project-scoped attachments. Prompt text never contains file bytes. */
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { resolveWorkspaceReference, validateWorkspaceReference } from './workspace-files.mjs';

export const TASK_FILE_LIMITS = Object.freeze({ count: 20, bytes: 4 * 1024 * 1024, total: 24 * 1024 * 1024 });
export class TaskFileError extends Error {
  constructor(message, code = 'INVALID_TASK_FILES', status = 400) { super(message); this.code = code; this.status = status; }
}
const fail = (message, code, status) => { throw new TaskFileError(message, code, status); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
function filename(name) {
  if (typeof name !== 'string' || !name.isWellFormed() || !name || Buffer.byteLength(name) > 100 || /[\\/:<>"|?*\x00-\x1f\x7f]/.test(name)
    || /[. ]$/.test(name) || name === '.' || name === '..' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) fail('Use a filename without path components or reserved characters.');
  return name;
}
export function taskFileFields(value = {}) {
  const result = {};
  if (value.attachments !== undefined) {
    if (!Array.isArray(value.attachments) || value.attachments.length > TASK_FILE_LIMITS.count) fail('A task accepts up to 20 attachments.');
    let size = 0; const ids = new Set();
    result.attachments = value.attachments.map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['id', 'name', 'size', 'sha256'].includes(key))
        || !/^[a-f0-9]{64}$/.test(row.sha256) || row.id !== `${row.sha256}-${hash(filename(row.name))}`
        || !Number.isSafeInteger(row.size) || row.size < 0 || row.size > TASK_FILE_LIMITS.bytes || ids.has(row.id)) fail('An attachment descriptor is invalid.');
      ids.add(row.id); size += row.size; return { id: row.id, name: row.name, size: row.size, sha256: row.sha256 };
    });
    if (size > TASK_FILE_LIMITS.total) fail('A task accepts up to 24 MiB of attachments.', 'TASK_FILES_LIMIT', 413);
  }
  if (value.fileReferences !== undefined) {
    if (!Array.isArray(value.fileReferences) || value.fileReferences.length > TASK_FILE_LIMITS.count || new Set(value.fileReferences).size !== value.fileReferences.length) fail('Use up to 20 unique project file references.');
    result.fileReferences = value.fileReferences.map(validateWorkspaceReference);
  }
  return result;
}
export const taskFilesEqual = (a, b) => JSON.stringify({ attachments: a.attachments || [], fileReferences: a.fileReferences || [] }) === JSON.stringify({ attachments: b.attachments || [], fileReferences: b.fileReferences || [] });
export function decodeAttachment(input) {
  if (!input || typeof input !== 'object' || typeof input.base64 !== 'string' || input.base64.length > Math.ceil(TASK_FILE_LIMITS.bytes / 3) * 4
    || input.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64)) fail('Send a bounded, canonical base64 attachment.', 'TASK_FILES_LIMIT', 413);
  const bytes = Buffer.from(input.base64, 'base64'), name = filename(input.name);
  if (bytes.length > TASK_FILE_LIMITS.bytes || bytes.toString('base64') !== input.base64) fail('This attachment exceeds 4 MiB.', 'TASK_FILES_LIMIT', 413);
  const sha256 = hash(bytes); return { bytes, descriptor: { id: `${sha256}-${hash(name)}`, name, size: bytes.length, sha256 } };
}
export class TaskFiles {
  constructor(dataDir) { this.dataDir = dataDir; }
  async directory(projectId, create = false) {
    if (typeof projectId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(projectId)) fail('Choose an existing project.');
    if (create) await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const root = await realpath(this.dataDir), rootInfo = await lstat(this.dataDir);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail('Attachment storage is unavailable.', 'TASK_FILES_STORAGE', 409);
    let path = root;
    for (const part of ['task-files', hash(projectId)]) {
      path = join(path, part); if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) fail('Attachment storage changed.', 'TASK_FILES_STORAGE', 409);
    }
    return path;
  }
  async upload(projectId, input) {
    const { bytes, descriptor } = decodeAttachment(input), dir = await this.directory(projectId, true), path = join(dir, `${descriptor.id}-${descriptor.name}`);
    let handle;
    try {
      handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
      await handle.writeFile(bytes); await handle.sync();
    } catch (error) {
      if (error.code !== 'EEXIST') { if (handle) await unlink(path).catch(() => {}); throw error; }
    } finally { await handle?.close(); }
    await this.read(projectId, descriptor); return descriptor;
  }
  async read(projectId, descriptor) {
    taskFileFields({ attachments: [descriptor] });
    try {
      const dir = await this.directory(projectId), path = join(dir, `${descriptor.id}-${descriptor.name}`), before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== descriptor.size) fail('Attachment bytes changed. Restore the file or attach it under a new name.', 'TASK_FILES_CHANGED', 409);
      const parent = await lstat(dir);
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
      try {
        const opened = await handle.stat(); if (!same(before, opened)) fail('Attachment storage changed.', 'TASK_FILES_CHANGED', 409);
        const bytes = Buffer.alloc(descriptor.size + 1); let size = 0;
        while (size < bytes.length) { const read = await handle.read(bytes, size, bytes.length - size, size); if (!read.bytesRead) break; size += read.bytesRead; }
        const after = await handle.stat(), final = await lstat(path);
        if (!same(opened, final) || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs
          || after.size !== final.size || after.ctimeMs !== final.ctimeMs || final.isSymbolicLink() || final.nlink !== 1 || size !== descriptor.size || hash(bytes.subarray(0, size)) !== descriptor.sha256)
          fail('Attachment bytes changed. Restore the file or attach it under a new name.', 'TASK_FILES_CHANGED', 409);
        if (!same(parent, await lstat(await this.directory(projectId)))) fail('Attachment storage changed.', 'TASK_FILES_CHANGED', 409);
        return { path, bytes: bytes.subarray(0, size) };
      } finally { await handle.close(); }
    } catch (error) {
      if (error.code === 'ENOENT') fail(`Attachment “${descriptor.name}” is missing. Reattach it before starting an agent.`, 'TASK_FILE_MISSING', 409);
      throw error;
    }
  }
  async resolve(board, projectId, task, workspace = '') {
    const fields = taskFileFields(task), paths = [];
    for (const descriptor of fields.attachments || []) paths.push((await this.read(projectId, descriptor)).path);
    for (const path of fields.fileReferences || []) paths.push(await resolveWorkspaceReference(board, projectId, path, workspace));
    return paths;
  }
}
