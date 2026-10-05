/** Bounded file access within explicitly linked project folders/worktrees. */
import { constants } from 'node:fs';
import { access, lstat, open, opendir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { git, listWorktrees } from './git.mjs';

export const FILE_LIMITS = Object.freeze({ bytes: 512 * 1024, lines: 20_000, entries: 5000, page: 250, depth: 64 });
export class WorkspaceFileError extends Error {
  constructor(message, code, status = 400) { super(message); this.code = code; this.status = status; }
}
const fail = (message, code, status) => { throw new WorkspaceFileError(message, code, status); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const inside = (root, path) => { const part = relative(root, path); return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep)); };
const protectedName = input => {
  const name = input.replace(/[. ]+$/, ''); // Windows aliases must not bypass protection.
  return name.toLowerCase() === '.git' || /^(?:\.env(?:\..+)?|\.npmrc|\.netrc|\.pypirc|credentials(?:\.json)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.+\.(?:pem|key|p12|pfx))$/i.test(name)
    && !/^\.env\.(?:example|sample|template)$/i.test(name);
};

function parsePath(value = '') {
  if (typeof value !== 'string' || value.length > 4096 || /[\\\x00-\x1f\x7f]/.test(value) || isAbsolute(value)) fail('Choose a relative project path.', 'FILE_PATH_INVALID');
  const parts = value ? value.split('/') : [];
  if (parts.length > FILE_LIMITS.depth || parts.some(p => !p || p === '.' || p === '..' || p.includes(':'))) fail('Choose a relative project path.', 'FILE_PATH_INVALID');
  if (parts.some(protectedName)) fail('Git internals and credential files are not available in the viewer.', 'FILE_PROTECTED', 403);
  return parts;
}

async function target(root, parts) {
  let path = root, info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) fail('The project folder changed. Relink it before inspection.', 'FILE_ROOT_CHANGED', 409);
  for (let i = 0; i < parts.length; i++) {
    path = join(path, parts[i]); info = await lstat(path);
    if (info.isSymbolicLink()) fail('Symbolic links are not followed by the viewer.', 'FILE_LINK_BLOCKED', 403);
    if (i < parts.length - 1 && !info.isDirectory()) fail('This folder is unavailable.', 'FILE_NOT_FOUND', 404);
  }
  if (!inside(root, await realpath(path))) fail('This path is outside the selected project.', 'FILE_PATH_INVALID', 403);
  return { path, info };
}

async function context(board, projectId, workspace) {
  // Store reads do not recover tasks, create worktrees, or mutate board state.
  const state = await board.store.read();
  const project = state.projects.find(p => p.id === projectId);
  if (!project) fail('This project no longer exists.', 'NOT_FOUND', 404);
  if (!project.repository?.root) fail('Link a local project folder before inspecting files.', 'REPOSITORY_REQUIRED', 409);
  const scopes = [{ id: '', name: 'Project checkout' }, ...project.tasks.filter(t => t.workspace?.status === 'ready').map(t => ({ id: t.id, name: `${t.title} · ${t.workspace.branch}` }))];
  const repositoryRoot = project.repository.root;
  const selected = project.repository.inspectionRoot || (project.repository.path ? await realpath(project.repository.path) : repositoryRoot);
  if (!isAbsolute(selected) || !inside(repositoryRoot, selected)) fail('Relink this project to a folder inside its repository.', 'FILE_ROOT_CHANGED', 409);
  let root = selected, scope = scopes[0];
  if (workspace) {
    const task = project.tasks.find(t => t.id === workspace && t.workspace?.status === 'ready');
    if (!task || task.workspace.repositoryRoot !== repositoryRoot || task.workspace.commonDir !== project.repository.commonDir) fail('This task worktree is unavailable.', 'FILE_WORKSPACE_UNAVAILABLE', 409);
    const registered = (await listWorktrees(repositoryRoot)).find(w => w.path === task.workspace.path && w.branch === task.workspace.branch);
    const physical = await realpath(task.workspace.path).catch(() => null);
    if (!registered || physical !== task.workspace.path) fail('This task worktree changed or was removed.', 'FILE_WORKSPACE_UNAVAILABLE', 409);
    const common = (await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: task.workspace.path })).trim();
    if (await realpath(common) !== project.repository.commonDir) fail('This folder belongs to another repository.', 'FILE_WORKSPACE_UNAVAILABLE', 409);
    root = join(task.workspace.path, relative(repositoryRoot, selected)); scope = scopes.find(s => s.id === workspace);
  }
  return { root, scopes, project: { id: project.id, name: project.name }, workspace: scope };
}

export async function inspectWorkspace(board, projectId, { path = '', workspace = '', file = false, offset = '0', version = '' } = {}) {
  const parts = parsePath(path);
  if (typeof workspace !== 'string' || workspace.length > 100 || !/^[A-Za-z0-9_-]*$/.test(workspace)) fail('Choose a project checkout or task worktree.', 'FILE_WORKSPACE_INVALID');
  if (!/^\d{1,4}$/.test(String(offset)) || Number(offset) >= FILE_LIMITS.entries) fail('Invalid directory page.', 'FILE_PAGE_INVALID');
  if (typeof version !== 'string' || version && !/^[a-f0-9]{64}$/.test(version)) fail('Invalid file version.', 'FILE_VERSION_INVALID');
  try {
    const ctx = await context(board, projectId, workspace), item = await target(ctx.root, parts);
    const identity = { project: ctx.project, workspace: ctx.workspace, path, scopeVersion: createHash('sha256').update(ctx.root).digest('hex') };
    if (!file) {
      if (!item.info.isDirectory()) fail('This path is not a folder.', 'FILE_NOT_DIRECTORY');
      const entries = [], directory = await opendir(item.path);
      let truncated = false;
      for await (const entry of directory) {
        if (entries.length === FILE_LIMITS.entries) { truncated = true; break; }
        const kind = entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'unsupported';
        const blocked = protectedName(entry.name) || /[\\:\x00-\x1f\x7f]/.test(entry.name) || ['link', 'unsupported'].includes(kind);
        entries.push({ name: entry.name, kind, blocked });
      }
      const checked = await target(ctx.root, parts);
      if (!same(item.info, checked.info)) fail('This folder changed during inspection. Refresh to try again.', 'FILE_CHANGED', 409);
      entries.sort((a, b) => (a.kind !== 'directory') - (b.kind !== 'directory') || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const start = Number(offset), page = entries.slice(start, start + FILE_LIMITS.page);
      return { ...identity, scopes: ctx.scopes, entries: page, next: start + page.length < entries.length ? start + page.length : null, truncated };
    }
    if (!parts.length || !item.info.isFile()) fail('Only regular text files can be opened.', 'FILE_UNSUPPORTED', 415);
    if (item.info.size > FILE_LIMITS.bytes) fail('This file exceeds the 512 KiB viewer limit. Open it in your editor.', 'FILE_TOO_LARGE', 413);
    const handle = await open(item.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
      const before = await handle.stat(), checked = await target(ctx.root, parts);
      if (!before.isFile() || !same(before, item.info) || !same(before, checked.info)) fail('This file changed during inspection. Try again.', 'FILE_CHANGED', 409);
      const bytes = Buffer.alloc(FILE_LIMITS.bytes + 1);
      let size = 0;
      while (size < bytes.length) { const read = await handle.read(bytes, size, bytes.length - size, size); if (!read.bytesRead) break; size += read.bytesRead; }
      if (size > FILE_LIMITS.bytes) fail('This file exceeds the 512 KiB viewer limit. Open it in your editor.', 'FILE_TOO_LARGE', 413);
      const after = await handle.stat(), final = await target(ctx.root, parts);
      if (!same(before, final.info) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.size !== final.info.size || after.mtimeMs !== final.info.mtimeMs || after.ctimeMs !== final.info.ctimeMs) fail('This file is being updated. Refresh to read a stable version.', 'FILE_CHANGED', 409);
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size)); } catch { fail('This file is not UTF-8 text. Open it in your editor.', 'FILE_UNSUPPORTED', 415); }
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) fail('Binary files are not displayed by this viewer.', 'FILE_UNSUPPORTED', 415);
      if (text.split('\n').length > FILE_LIMITS.lines) fail('This file has too many lines for the viewer. Open it in your editor.', 'FILE_TOO_LARGE', 413);
      const revision = createHash('sha256').update(bytes.subarray(0, size)).digest('hex');
      return { ...identity, version: revision, bytes: size, modifiedAt: after.mtimeMs, unchanged: revision === version, ...(revision === version ? {} : { text }) };
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof WorkspaceFileError) throw error;
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) fail('This file or folder was removed or is unavailable.', 'FILE_NOT_FOUND', 404);
    fail('This file or folder could not be inspected. Check its permissions and project link.', 'FILE_UNAVAILABLE', 403);
  }
}

export function validateFileText(text) {
  if (typeof text !== 'string') fail('Provide UTF-8 file contents.', 'FILE_TEXT_INVALID');
  if (Buffer.byteLength(text, 'utf8') > FILE_LIMITS.bytes || text.split('\n').length > FILE_LIMITS.lines) fail('The edited file exceeds the viewer limits.', 'FILE_TOO_LARGE', 413);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) fail('Provide valid UTF-8 text without binary control characters.', 'FILE_TEXT_INVALID');
  return text;
}

const saves = new Map();
/** Optimistic conflict checking, serialized saves and atomic replacement; never create files. */
export async function saveWorkspaceFile(board, projectId, value, { signal } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Provide a file edit.', 'FILE_TEXT_INVALID');
  const { path, workspace = '', version, scopeVersion, text } = value;
  validateFileText(text);
  if (!/^[a-f0-9]{64}$/.test(version || '') || !/^[a-f0-9]{64}$/.test(scopeVersion || '')) fail('Read the current file before saving.', 'FILE_VERSION_INVALID');
  const parts = parsePath(path);
  if (!parts.length) fail('Choose an existing file.', 'FILE_PATH_INVALID');
  const ctx = await context(board, projectId, workspace), lock = join(ctx.root, ...parts);
  if (createHash('sha256').update(ctx.root).digest('hex') !== scopeVersion) fail('The project folder changed. Reload this file before saving.', 'FILE_CONFLICT', 409);
  const previous = saves.get(lock) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    let temp;
    try {
      signal?.throwIfAborted();
      const current = await inspectWorkspace(board, projectId, { path, workspace, file: true });
      if (current.version !== version || current.scopeVersion !== scopeVersion) fail('This file changed on disk or the project was relinked. Your draft is kept. Reload and reconcile before saving.', 'FILE_CONFLICT', 409);
      const item = await target(ctx.root, parts), parent = await lstat(dirname(item.path));
      if (!item.info.isFile() || item.info.nlink !== 1) fail('Only regular files without hard links can be saved.', 'FILE_UNSUPPORTED', 415);
      if (!(item.info.mode & 0o222) || !await access(item.path, constants.W_OK).then(() => true, () => false)) fail('This file is read-only. Your draft is kept.', 'FILE_READ_ONLY', 403);
      temp = join(dirname(item.path), `.promptboard-save-${randomUUID()}.tmp`);
      const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
      try { await handle.writeFile(text, 'utf8'); await handle.chmod(item.info.mode & 0o777); await handle.sync(); } finally { await handle.close(); }
      signal?.throwIfAborted();
      // Recheck custody and bytes immediately before replacement. External editors do not share our lock.
      const latest = await inspectWorkspace(board, projectId, { path, workspace, file: true });
      const checked = await target(ctx.root, parts);
      if (latest.version !== version || latest.scopeVersion !== scopeVersion || !same(item.info, checked.info)
        || !same(parent, await lstat(dirname(item.path)))) fail('This file changed while saving. Your draft is kept. Reload and reconcile before saving.', 'FILE_CONFLICT', 409);
      await rename(temp, item.path); temp = null;
      return { ...current, text, version: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text), unchanged: false, saved: true };
    } catch (error) {
      if (error instanceof WorkspaceFileError || signal?.aborted) throw error;
      fail('The file could not be saved. Your draft is kept. Check permissions and the project link.', 'FILE_SAVE_FAILED', 409);
    } finally { if (temp) await unlink(temp).catch(() => {}); }
  });
  saves.set(lock, pending);
  try { return await pending; } finally { if (saves.get(lock) === pending) saves.delete(lock); }
}

/** References share the viewer's selected-folder, credential and symlink boundaries. */
export function validateWorkspaceReference(path) {
  const parts = parsePath(path);
  if (!parts.length) fail('Choose a project file or folder.', 'FILE_PATH_INVALID');
  return path;
}
export async function resolveWorkspaceReference(board, projectId, path, workspace = '') {
  const parts = parsePath(validateWorkspaceReference(path));
  try {
    const ctx = await context(board, projectId, workspace), item = await target(ctx.root, parts);
    if (!item.info.isFile() && !item.info.isDirectory()) fail('Only regular files and folders can be referenced.', 'FILE_UNSUPPORTED', 415);
    if (item.info.isFile() && item.info.nlink !== 1) fail('Hard-linked files cannot be referenced.', 'FILE_LINK_BLOCKED', 403);
    const checked = await target(ctx.root, parts);
    if (!same(item.info, checked.info)) fail('This reference changed. Select it again.', 'FILE_CHANGED', 409);
    return item.path;
  } catch (error) {
    if (error.code === 'ENOENT') fail(`Referenced path “${path}” is missing. Restore or remove it before starting an agent.`, 'TASK_FILE_MISSING', 409);
    throw error;
  }
}
