/**
 * Git access for project linking and task worktrees. Commands run without a shell, with
 * no terminal prompts, and without inherited GIT_DIR-style variables that could redirect
 * them to another repository. It never runs reset, stash, clean, or any --force operation.
 * `initRepository` (init plus one empty commit) runs only on the user's explicit confirmation.
 */
import { execFile } from 'node:child_process';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export class GitError extends Error {
  constructor(message, code, status = 400) { super(message); this.code = code; this.status = status; }
}

export const GIT_MESSAGES = Object.freeze({
  INVALID_PATH: 'Enter the absolute path of the project folder.',
  PATH_NOT_FOUND: 'This folder does not exist.',
  NOT_A_DIRECTORY: 'This path is a file, not a folder.',
  GIT_MISSING: 'Git was not found. Install Git and make sure the git command is on PATH, then try again.',
  NOT_A_REPOSITORY: 'This folder is not a Git repository yet. Promptboard does not create repositories on its own: choose “Set up Git here” to initialize it, or pick another folder.',
  BARE_REPOSITORY: 'This is a bare repository. It has no working folder, so agents cannot run in it. Choose a normal checkout or a linked worktree.',
  NOT_A_WORKTREE: 'This folder is inside Git\'s internal directory. Choose the project\'s working folder instead.',
  NO_COMMITS: 'This repository has no commits yet, so task branches have nothing to start from. Promptboard does not create commits on its own: choose “Set up Git here” to add an empty first commit, or commit something yourself.',
  ALREADY_A_REPOSITORY: 'This folder is already a Git repository with commits. Link it instead.',
  IDENTITY_REQUIRED: 'Git needs your name and email for the first commit. Run git config --global user.name "Your Name" and git config --global user.email you@example.com, then try again. Git was initialized; nothing else changed.',
  INIT_FAILED: 'Git could not initialize this folder. Check that you can write to it, then try again.',
  GIT_FAILED: 'Git could not read this repository. Run git status in that folder to see the problem.',
});

const fail = code => new GitError(GIT_MESSAGES[code], code);

function gitEnv() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', LANG: 'C' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES']) delete env[name];
  return env;
}

/** Run git. `config` adds -c overrides (for example, disabled hooks). Resolves stdout; rejects with {code, stderr}. */
export function git(args, { cwd, config = [], timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', [...config.flatMap(item => ['-c', item]), ...args], { cwd, env: gitEnv(), shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) { resolve(stdout); return; }
        reject(Object.assign(new Error('git failed'), { code: error.code === 'ENOENT' ? 'GIT_MISSING' : 'GIT_FAILED', exitCode: error.code, stderr: String(stderr) }));
      });
  });
}

export const lines = text => text.split('\n').map(line => line.trimEnd()).filter(Boolean);

/**
 * Validate a folder for linking. Returns the repository root, the common Git directory
 * (valid for linked worktrees, where .git is a file), and the local branches.
 */
export async function validateRepository(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 4096 || input.includes('\0') || !isAbsolute(input.trim())) throw fail('INVALID_PATH');
  const path = input.trim();
  let info;
  try { info = await stat(path); } catch { throw fail('PATH_NOT_FOUND'); }
  if (!info.isDirectory()) throw fail('NOT_A_DIRECTORY');
  try { await git(['--version']); } catch (error) { throw fail(error.code === 'GIT_MISSING' ? 'GIT_MISSING' : 'GIT_FAILED'); }
  let bare, inside;
  try { [bare, inside] = lines(await git(['rev-parse', '--is-bare-repository', '--is-inside-work-tree'], { cwd: path })); }
  catch (error) { throw fail(/not a git repository/i.test(error.stderr || '') ? 'NOT_A_REPOSITORY' : 'GIT_FAILED'); }
  if (bare === 'true') throw fail('BARE_REPOSITORY');
  if (inside !== 'true') throw fail('NOT_A_WORKTREE');
  let root, commonDir, gitDir;
  try { [root, commonDir, gitDir] = lines(await git(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--absolute-git-dir'], { cwd: path })); }
  catch { throw fail('GIT_FAILED'); }
  [root, commonDir, gitDir] = await Promise.all([root, commonDir, gitDir].map(item => realpath(item)));
  const branches = await listBranches(root);
  let hasHead = true;
  try { await git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: root }); } catch { hasHead = false; }
  if (!hasHead && !branches.length) throw fail('NO_COMMITS');
  let currentBranch = null;
  try { currentBranch = lines(await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root }))[0] || null; } catch {}
  return { root, commonDir, gitDir, linkedWorktree: gitDir !== commonDir, currentBranch, branches };
}

/**
 * Set up a folder for linking, on the user's explicit confirmation only: create the folder if it
 * does not exist, run git init if it is not a repository, and add one empty first commit so task
 * branches have a base. No files are added, staged, or committed.
 */
export async function initRepository(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 4096 || input.includes('\0') || !isAbsolute(input.trim())) throw fail('INVALID_PATH');
  const path = input.trim();
  let state = 'missing';
  try { await validateRepository(path); state = 'ready'; }
  catch (error) { if (!['PATH_NOT_FOUND', 'NOT_A_REPOSITORY', 'NO_COMMITS'].includes(error.code)) throw error; state = error.code; }
  if (state === 'ready') throw fail('ALREADY_A_REPOSITORY');
  const created = state === 'PATH_NOT_FOUND';
  if (created) { try { await mkdir(path, { recursive: true }); } catch { throw fail('INIT_FAILED'); } }
  if (state !== 'NO_COMMITS') { try { await git(['init'], { cwd: path }); } catch { throw fail('INIT_FAILED'); } }
  try { await git(['commit', '--allow-empty', '--no-verify', '-m', 'Initial commit'], { cwd: path }); }
  catch (error) { throw fail(/tell me who you are|user\.(name|email)|identity/i.test(error.stderr || '') ? 'IDENTITY_REQUIRED' : 'INIT_FAILED'); }
  return { createdFolder: created, initialized: state !== 'NO_COMMITS' };
}

export async function listBranches(root) {
  try {
    return lines(await git(['for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/heads'], { cwd: root }))
      .map(line => { const [name, commit] = line.split('\t'); return { name, commit }; });
  } catch { throw fail('GIT_FAILED'); }
}

export async function branchExists(root, name) {
  try { await git(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { cwd: root }); return true; } catch { return false; }
}

export async function commitExists(root, commit) {
  try { await git(['cat-file', '-e', `${commit}^{commit}`], { cwd: root }); return true; } catch { return false; }
}

/** Registered worktrees as [{ path, branch }], with real paths for comparison. */
export async function listWorktrees(root) {
  const entries = [];
  let current = null;
  for (const line of lines(await git(['worktree', 'list', '--porcelain'], { cwd: root }))) {
    if (line.startsWith('worktree ')) { current = { path: line.slice(9), branch: null }; entries.push(current); }
    else if (line.startsWith('branch ') && current) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  return Promise.all(entries.map(async entry => ({ ...entry, path: await realpath(entry.path).catch(() => entry.path) })));
}
