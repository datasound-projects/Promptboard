/**
 * GitHub connection through the official GitHub CLI (gh). Promptboard never sees, stores, or
 * forwards a GitHub token: gh keeps it in the system keychain and runs every request itself.
 * Commands run without a shell. Nothing here force-pushes, resets, or deletes a branch.
 *
 * A GitHub project works on a managed local clone in Promptboard's data folder. Agents use
 * task worktrees of that clone, exactly as for a local repository.
 */
import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from './git.mjs';
import { trackPid, untrackPid } from './providers.mjs';

export class GitHubError extends Error {
  constructor(message, code, status = 409) { super(message); this.code = code; this.status = status; }
}
const fail = (message, code, status) => new GitHubError(message, code, status);
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,255}$/;
const DEVICE_URL = 'https://github.com/login/device';

/** GitHub CLI without a shell or prompts. Rejects with { missing, stderr } on failure. */
export function gh(args, { cwd, timeoutMs = 120000, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer, env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout, stderr) => error ? reject(Object.assign(new Error('gh failed'), { missing: error.code === 'ENOENT', stderr: String(stderr) })) : resolve(String(stdout)));
  });
}

const authProblem = stderr => /auth login|not logged in|bad credentials|401|authentication/i.test(stderr || '');
const networkProblem = stderr => /could not resolve host|no such host|dial tcp|network is unreachable|timed? ?out|connection refused/i.test(stderr || '');

/** { installed, state: 'connected' | 'not_connected' | 'needs_attention', user, message }. */
export async function githubStatus() {
  try { await gh(['--version'], { timeoutMs: 10000 }); }
  catch (error) { return { installed: false, state: 'not_connected', user: '', message: error.missing ? 'Install the GitHub CLI (gh) to connect GitHub.' : 'The GitHub CLI did not start.' }; }
  try {
    const user = JSON.parse(await gh(['api', 'user'], { timeoutMs: 20000 }));
    const login = typeof user?.login === 'string' && LOGIN.test(user.login) ? user.login : '';
    return { installed: true, state: login ? 'connected' : 'needs_attention', user: login, message: login ? '' : 'GitHub returned no user name.' };
  } catch (error) {
    // Not signed in at all is "not connected"; an expired sign-in or no network needs attention.
    const signedIn = await gh(['auth', 'status', '--hostname', 'github.com'], { timeoutMs: 15000 }).then(() => true, () => false);
    if (!signedIn) return { installed: true, state: 'not_connected', user: '', message: 'The GitHub CLI is not signed in.' };
    return { installed: true, state: 'needs_attention', user: '', message: networkProblem(error.stderr) ? 'GitHub could not be reached. Check your network, then check again.' : authProblem(error.stderr) ? 'The GitHub sign-in expired or was revoked. Connect GitHub again.' : 'GitHub did not answer. Check again later.' };
  }
}

/**
 * Official browser sign-in: gh auth login --web in a terminal session. Promptboard reads only
 * the one-time code that gh prints for the user, answers gh's Enter prompt, and declines the
 * global Git credential setup (managed clones get a repository-local helper instead).
 */
export class GitHubLogin {
  constructor({ ptyLoader }) { this.ptyLoader = ptyLoader; this.state = { status: 'idle' }; this.proc = null; }

  snapshot() { return { ...this.state }; }

  async start() {
    if (this.proc) return this.snapshot();
    const { pty } = await this.ptyLoader();
    if (!pty) throw fail('Promptboard cannot run the sign-in here. Run gh auth login --web in your terminal, then choose Check connection.', 'LOGIN_UNAVAILABLE');
    let proc;
    try {
      proc = pty.spawn('gh', ['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https', '--skip-ssh-key'],
        { name: 'xterm-256color', cols: 120, rows: 30, cwd: process.cwd(), env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' } });
    } catch { throw fail('The GitHub CLI could not start. Install gh, then try again.', 'GH_MISSING'); }
    this.proc = proc;
    trackPid(proc.pid); // Shutdown stops it with the other owned processes.
    this.state = { status: 'starting', code: '', url: DEVICE_URL, startedAt: Date.now() };
    let output = '', entered = false, declined = false;
    // Listen before anything else so a fast exit is never missed.
    proc.onData(data => {
      output = (output + data).slice(-8000);
      const code = output.match(/one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/);
      if (code && !this.state.code) this.state = { ...this.state, status: 'waiting', code: code[1] };
      if (!entered && /Press Enter/i.test(output)) { entered = true; proc.write('\r'); }
      if (!declined && /Authenticate Git with your GitHub credentials/i.test(output)) { declined = true; proc.write('n\r'); }
    });
    proc.onExit(({ exitCode }) => {
      untrackPid(proc.pid);
      this.proc = null;
      clearTimeout(this.timer);
      if (this.state.status === 'cancelled') return;
      this.state = exitCode === 0 ? { status: 'done', finishedAt: Date.now() }
        : { status: 'failed', message: /already logged in/i.test(output) ? 'The GitHub CLI is already signed in.' : 'The sign-in did not finish. Try again, or run gh auth login --web in your terminal.' };
    });
    // The device code expires after 15 minutes.
    this.timer = setTimeout(() => this.cancel('The sign-in timed out. Try again.'), 15 * 60 * 1000);
    this.timer.unref?.();
    return this.snapshot();
  }

  cancel(message = 'Sign-in cancelled.') {
    clearTimeout(this.timer);
    if (this.proc) { this.state = { status: 'cancelled', message }; try { this.proc.kill(); } catch {} this.proc = null; }
    return this.snapshot();
  }
}

const repoRow = row => ({ nameWithOwner: row.full_name ?? row.nameWithOwner, private: Boolean(row.private ?? row.isPrivate),
  defaultBranch: row.default_branch ?? row.defaultBranchRef?.name ?? '', url: row.html_url ?? row.url ?? '', description: String(row.description || '').slice(0, 200) });

/** Repositories the signed-in account can access (owned, collaborator, organization member). */
export async function listRepositories() {
  const out = await gh(['api', '--paginate', 'user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member',
    '--jq', '.[] | {full_name, private, default_branch, html_url, description}'], { timeoutMs: 60000 })
    .catch(error => { throw ghFailure(error, 'GitHub could not list your repositories.'); });
  return out.split('\n').filter(Boolean).slice(0, 2000).flatMap(line => { try { const row = repoRow(JSON.parse(line)); return REPO.test(row.nameWithOwner) ? [row] : []; } catch { return []; } });
}

export async function viewRepository(name) {
  if (!REPO.test(name)) throw fail('Enter a repository as owner/name.', 'INVALID_REPOSITORY', 400);
  const data = await gh(['repo', 'view', name, '--json', 'nameWithOwner,isPrivate,defaultBranchRef,url,description'], { timeoutMs: 30000 })
    .catch(error => { throw ghFailure(error, `GitHub could not find ${name}, or this account cannot access it.`); });
  return repoRow(JSON.parse(data));
}

function ghFailure(error, fallback) {
  if (error.missing) return fail('Install the GitHub CLI (gh) to use GitHub.', 'GH_MISSING');
  if (authProblem(error.stderr)) return fail('The GitHub CLI is not signed in, or its sign-in expired. Connect GitHub in Settings.', 'GH_AUTH');
  if (networkProblem(error.stderr)) return fail('GitHub could not be reached. Check your network, then try again. Your local work is safe.', 'GH_NETWORK');
  return fail(fallback, 'GH_FAILED');
}

/** The managed clone's folder, inside Promptboard's data folder (never inside a user repository). */
export function clonePath(dataDir, nameWithOwner) {
  const [owner, name] = nameWithOwner.split('/');
  return join(dataDir, 'clones', owner.toLowerCase(), name.toLowerCase());
}

/** Clone once; an existing clone of the same repository is reused, anything else is refused. */
export async function ensureClone(dataDir, repo) {
  const path = clonePath(dataDir, repo.nameWithOwner);
  const exists = await stat(path).then(() => true, () => false);
  if (exists) {
    const origin = await git(['config', '--get', 'remote.origin.url'], { cwd: path }).then(out => out.trim(), () => '');
    const matches = new RegExp(`github\\.com[:/]${repo.nameWithOwner.replace(/[.]/g, '\\.')}(?:\\.git)?$`, 'i').test(origin);
    if (!matches) throw fail(`The folder ${path} exists but is not a clone of ${repo.nameWithOwner}. Promptboard does not change it.`, 'CLONE_CONFLICT');
    return { path, reused: true };
  }
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  await gh(['repo', 'clone', repo.nameWithOwner, path], { timeoutMs: 600000 })
    .catch(error => { throw ghFailure(error, `GitHub could not clone ${repo.nameWithOwner}. Check that this account can read it.`); });
  // HTTPS remotes use gh as the credential helper for this clone only; the global Git setup is unchanged.
  const origin = await git(['config', '--get', 'remote.origin.url'], { cwd: path }).then(out => out.trim(), () => '');
  if (origin.startsWith('https://github.com/')) {
    await git(['config', '--local', '--add', 'credential.https://github.com.helper', ''], { cwd: path });
    await git(['config', '--local', '--add', 'credential.https://github.com.helper', '!gh auth git-credential'], { cwd: path });
  }
  return { path, reused: false };
}

/** Fetch origin and compare the target branch with origin's copy. Never changes a local branch. */
export async function fetchAndCompare(path, branch) {
  if (!BRANCH.test(branch)) throw fail('The target branch name is not valid.', 'INVALID_BRANCH', 400);
  await git(['fetch', '--prune', 'origin'], { cwd: path, timeoutMs: 180000 })
    .catch(error => { throw fail(/could not resolve host|unable to access|network is unreachable|timed out|does not appear to be a git repository/i.test(error.stderr || '') ? 'GitHub could not be reached. Your local work is safe. Check your network, then fetch again.' : /not found|repository .* does not exist/i.test(error.stderr || '') ? 'The GitHub repository was not found. It may have been deleted or renamed. Your local work is safe.' : 'Git could not fetch from GitHub. Check your GitHub connection. Your local work is safe.', 'FETCH_FAILED'); });
  return compare(path, branch);
}

export async function compare(path, branch) {
  const remoteRef = `refs/remotes/origin/${branch}`;
  const hasRemote = await git(['rev-parse', '--verify', '--quiet', remoteRef], { cwd: path }).then(() => true, () => false);
  if (!hasRemote) return { sync: 'needs_attention', ahead: 0, behind: 0, message: `origin has no branch ${branch}.` };
  const counts = await git(['rev-list', '--left-right', '--count', `refs/heads/${branch}...${remoteRef}`], { cwd: path }).catch(() => null);
  if (!counts) return { sync: 'needs_attention', ahead: 0, behind: 0, message: `There is no local branch ${branch}.` };
  const [ahead, behind] = counts.trim().split(/\s+/).map(Number);
  return { sync: ahead && behind ? 'needs_attention' : behind ? 'behind' : ahead ? 'ahead' : 'up_to_date', ahead, behind,
    message: ahead && behind ? `${branch} and origin/${branch} have different commits. Promptboard does not merge or reset them; resolve this in the clone.` : '' };
}

/** Fast-forward the local target branch to origin's. Refuses anything that is not a fast-forward. */
export async function fastForward(path, branch) {
  const state = await compare(path, branch);
  if (state.sync !== 'behind') throw fail(state.sync === 'up_to_date' ? `${branch} is already up to date.` : state.message || `${branch} is not only behind origin, so it cannot be fast-forwarded.`, 'NOT_FAST_FORWARD');
  const current = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: path }).then(out => out.trim(), () => '');
  if (current === branch) {
    const dirty = (await git(['status', '--porcelain'], { cwd: path })).trim();
    if (dirty) throw fail(`The clone has uncommitted changes on ${branch}. Promptboard does not discard them.`, 'UNCOMMITTED_CHANGES');
    await git(['merge', '--ff-only', `refs/remotes/origin/${branch}`], { cwd: path, timeoutMs: 60000 });
  } else {
    // Without a leading +, this refspec only fast-forwards.
    await git(['fetch', '.', `refs/remotes/origin/${branch}:refs/heads/${branch}`], { cwd: path, timeoutMs: 60000 });
  }
  return compare(path, branch);
}
