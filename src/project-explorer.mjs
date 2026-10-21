/**
 * Project card and explorer: the project checkout's branch, latest commit and Git status. Read only: Git runs without
 * optional locks, so a status read never waits for or blocks a merge. Paths come from the same checks as the file viewer.
 */
import { basename, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { git, headBranch } from './git.mjs';
import { FILE_LIMITS, SAVE_TEMP, workspaceRoot } from './workspace-files.mjs';

/**
 * `git status --porcelain=v1 -z` as [path, letter] pairs relative to `prefix` (the project folder inside its repository):
 * M modified, A added, U untracked, I ignored. A folder Git reports as a whole (untracked or ignored) has no trailing slash.
 * `tracked` counts changed tracked files in the whole checkout: those are what stop a merge into it.
 */
export function parseStatus(output, prefix = '') {
  const entries = [], fields = output.split('\0');
  let tracked = 0, truncated = false;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.length < 4) continue;
    // A rename or copy, in the index (R ) or in the work tree ( R, after git add -N), is followed by its original path.
    const code = field.slice(0, 2), moved = /[RC]/.test(code), letter = code === '??' ? 'U' : code === '!!' ? 'I' : code[0] === 'A' || moved ? 'A' : 'M';
    if (moved) i++;
    if (letter === 'M' || letter === 'A') tracked++;
    let path = field.slice(3).replace(/\/$/, '');
    if (prefix) { if (!path.startsWith(`${prefix}/`)) continue; path = path.slice(prefix.length + 1); }
    if (letter === 'U' && SAVE_TEMP.test(path.split('/').at(-1))) continue;
    if (entries.length === FILE_LIMITS.entries) { truncated = true; continue; }
    entries.push([path, letter]);
  }
  return { entries, tracked, truncated };
}

/** What the Project card and the explorer show about the checkout where merges land. */
export async function projectStatus(board, projectId) {
  const ctx = await workspaceRoot(board, projectId);
  const prefix = relative(ctx.repositoryRoot, ctx.root).split(sep).filter(Boolean).join('/');
  const [branch, head, status] = await Promise.all([
    headBranch(ctx.root),
    git(['log', '-1', '--format=%ct%x00%s'], { cwd: ctx.root }).then(out => { const [at, subject] = out.trim().split('\0'); return { at: Number(at) * 1000, subject: subject.slice(0, 200) }; }, () => null),
    git(['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=normal'], { cwd: ctx.root }).then(out => parseStatus(out, prefix), () => null),
  ]);
  return {
    project: ctx.project, folder: basename(ctx.root), branch, target: ctx.target, head,
    // Delivery.merge refuses a target checkout with changed tracked files (Promptboard never stashes or discards them).
    mergeBlocked: Boolean(ctx.target) && branch === ctx.target && status?.tracked > 0,
    status: status && { entries: status.entries, truncated: status.truncated },
    scopeVersion: createHash('sha256').update(ctx.root).digest('hex'),
  };
}
