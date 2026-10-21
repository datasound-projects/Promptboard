/**
 * Docker mode for card agents (docs/docker-sandbox.md). A project can run its card agents in a container that sees only
 * the card's worktree, the repository's Git data, the run's own folder and Promptboard's code (read-only). The docker
 * client runs in the agent's terminal in place of the CLI. Every path inside is the host's own path, so workspace trust,
 * the lifecycle hooks, usage files and resume work unchanged. A failed check ends the run's start; there is never a
 * silent fallback to running on this computer.
 */
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { access, lstat, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentError, HOOK_SCRIPT } from './agents.mjs';
import { writeAtomic } from './durable.mjs';
import { git, lines } from './git.mjs';
import { commandOnPath, execute, resolveExecutable, spawnOwned, stopProcess } from './providers.mjs';

export const DOCKERFILE = fileURLToPath(new URL('../docker/sandbox/Dockerfile', import.meta.url));
const APP_DIR = dirname(dirname(HOOK_SCRIPT)); // The hooks and the status line run from here, with the image's node.
const IMAGE_REPOSITORY = 'promptboard-sandbox';
const IMAGE_NAME = /^[a-z0-9][a-z0-9._/-]{0,199}(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;
const BUILD_LINES = 200;

export const SANDBOX_MESSAGES = Object.freeze({
  SANDBOX_UNSUPPORTED_PLATFORM: 'Docker mode runs on macOS and Linux.',
  SANDBOX_DOCKER_MISSING: 'Docker is not installed: there is no docker command on PATH. Install Docker Desktop or Colima, then try again.',
  SANDBOX_DOCKER_STOPPED: 'Docker is installed but not running. Start it (for Colima: colima start), then try again.',
  SANDBOX_IMAGE_MISSING: 'The Docker image for the CLI versions on this computer is not built yet. Build it in Settings → Docker sandbox, then start the card again.',
  SANDBOX_MOUNT_HIDDEN: 'Docker cannot see this folder. Share it with your Docker machine.',
  SANDBOX_START_FAILED: 'Docker could not start a container for this card. Run docker info in your terminal to see why.',
  SANDBOX_PATH_UNSUPPORTED: 'Docker cannot share a folder whose path contains a colon. Move the project or the Promptboard data folder.',
  SANDBOX_NOT_WORKTREE: 'This card’s workspace is not a Git worktree that Docker mode can protect. Remove the worktree in Details, then start the card again.',
  SANDBOX_BUILD_RUNNING: 'The image is already being built. Wait for it or cancel it.',
  SANDBOX_NO_CLI: 'Install Claude Code or Codex on this computer first: the image gets the same versions.',
  SANDBOX_INVALID_IMAGE: 'Enter an image name such as my-sandbox:1, or leave it empty for Promptboard’s image.',
  SANDBOX_INVALID_TOKEN: 'Paste the whole token that claude setup-token printed, with no spaces.',
});
const SIGN_IN = {
  claude: 'Claude Code needs its own sign-in inside Docker. Run claude setup-token in your terminal and paste the token in Settings → Docker sandbox.',
  codex: 'Codex is not signed in on this computer. Run codex login in your terminal, then start the card again.',
};
const fail = (code, message = SANDBOX_MESSAGES[code]) => new AgentError(message, code, 409);
const exists = path => access(path).then(() => true, () => false);

/** The folder that keeps a conversation's CLI home: its first run's, so a resumed conversation finds its own history. */
export function conversationHome(dataDir, runs, run) {
  const seen = new Set([run.id]);
  let root = run;
  for (let next; root.resumeFrom && (next = runs.find(item => item.id === root.resumeFrom.runId)) && !seen.has(next.id);) { seen.add(next.id); root = next; }
  return join(dataDir, root.artifactsDir, 'sandbox-home');
}

/**
 * Codex's own sandbox cannot start in a container: it needs bubblewrap, which needs user namespaces that Docker's default
 * security profile blocks. So the container is the boundary: what Codex was given as its sandbox decides the mounts, and
 * Codex runs unsandboxed inside. A strict read-only stage (Claude's Read/Grep/Glob session, Codex's read-only sandbox)
 * gets the worktree and Git data read-only.
 */
export function containerSession(provider, args) {
  const end = args.includes('--') ? args.indexOf('--') : args.length;
  const option = name => { const at = args.indexOf(name); return at >= 0 && at < end ? at : -1; };
  if (provider === 'codex' && option('--sandbox') >= 0) return { readOnly: args[option('--sandbox') + 1] === 'read-only', args: args.with(option('--sandbox') + 1, 'danger-full-access') };
  return { readOnly: provider === 'claude' && option('--tools') >= 0 && args[option('--tools') + 1] === 'Read,Grep,Glob', args };
}

/**
 * The files of a worktree's own Git folder that decide where Git reads settings and hooks (commondir; config.worktree when
 * the repository enables it), which worktree the folder belongs to (gitdir) and which branch it is on (HEAD). The folder
 * stays writable for the index and logs, so each file is mounted read-only on top of it. A missing config.worktree is
 * created empty first: a mount cannot protect a file that does not exist yet.
 */
export const PROTECTED_GIT_FILES = Object.freeze(['commondir', 'gitdir', 'HEAD', 'config.worktree']);
const isInside = (child, parent) => { const path = relative(parent, child); return Boolean(path) && !path.startsWith('..') && !isAbsolute(path); };

/**
 * What a card agent's container mounts, as [source (its real path), path inside, read-only]. Each place is { path, real }:
 * the path inside is the spelling Promptboard and Git use on this computer, so the hooks, usage files, `codex --cd` and
 * Git's own pointers resolve inside exactly as they do here, even under a symlinked data folder.
 */
export function sandboxMounts({ workspace, gitDir, commonDir, runDir, home, app, codexAuth = null, readOnly = false }) {
  const mount = (place, ro, name = '') => [join(place.real, name), join(place.path, name), ro];
  return [
    mount(workspace, readOnly), mount(workspace, true, '.git'), // The worktree, and its pointer to its Git folder.
    mount(commonDir, true), mount(commonDir, readOnly, 'objects'), // Branches, settings and hooks stay read-only; objects take git add.
    mount(gitDir, readOnly), ...PROTECTED_GIT_FILES.map(name => mount(gitDir, true, name)), // This worktree's index and logs.
    mount(runDir, false), ...(isInside(home.path, runDir.path) ? [] : [mount(home, false)]), mount(app, true),
    ...(codexAuth ? [[codexAuth.real, join(home.path, 'codex', 'auth.json'), true]] : []),
  ];
}

/**
 * The docker run arguments for one card agent. `names` pass the client's own values (`-e NAME`), so the CLI's settings and
 * sign-in never appear in argv or ps; `values` are the container's folders, which the client must not use itself.
 */
export function dockerRunArgs({ runId, label, user, workdir, mounts, image, command, args, names, values }) {
  return ['run', '--rm', '-it', '--init', '--name', `pb-run-${runId}`, '--label', `promptboard.run=${runId}`, '--label', `promptboard.data=${label}`,
    '--user', user, '-w', workdir, ...mounts.flatMap(([source, target, ro]) => ['-v', `${source}:${target}${ro ? ':ro' : ''}`]), ...names.flatMap(name => ['-e', name]),
    ...Object.entries(values).flatMap(([name, value]) => ['-e', `${name}=${value}`]), image, command, ...args];
}

/** A linked worktree's own Git folder and the repository's, spelled as Git finds them from the worktree's .git file. */
async function gitFolders(workspace) {
  const pointer = (await readFile(join(workspace, '.git'), 'utf8').catch(() => '')).match(/^gitdir: (.+)$/m)?.[1].trim();
  const gitDir = pointer && resolve(workspace, pointer);
  const common = gitDir && (await readFile(join(gitDir, 'commondir'), 'utf8').catch(() => '')).trim();
  if (!common) throw fail('SANDBOX_NOT_WORKTREE');
  return { gitDir, commonDir: resolve(gitDir, common) };
}

/**
 * Git repositories inside a worktree, which Git treats as submodules: staged gitlinks whose folder holds a .git, and
 * untracked folders that are repositories (Git lists those with a trailing slash and never looks inside). Listing them
 * runs nothing in them, but status, diff or add would run their own settings (fsmonitor, filters) on this computer.
 */
export async function nestedRepositories(workspace) {
  const [staged, others] = await Promise.all([git(['ls-files', '--stage', '-z'], { cwd: workspace }), git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: workspace })]);
  const found = [];
  for (const path of staged.split('\0').filter(entry => entry.startsWith('160000 ')).map(entry => entry.slice(entry.indexOf('\t') + 1)))
    if (await lstat(join(workspace, path, '.git')).then(() => true, () => false)) found.push(path);
  return [...found, ...others.split('\0').filter(path => path.endsWith('/')).map(path => path.slice(0, -1))];
}

/**
 * Why Promptboard must not run Git in a task's worktree, or ''. Only a worktree a container wrote is checked: an agent on
 * this computer can run commands here anyway. A worktree that cannot be listed is left to the Git command that follows.
 */
export async function nestedRepositoryProblem(state, taskId, workspace) {
  if (!(state.runs || []).some(run => run.taskId === taskId && run.config?.sandbox === 'docker')) return '';
  const nested = await nestedRepositories(workspace).catch(() => []);
  return nested.length ? `The agent made a Git repository inside this card’s workspace (${nested.slice(0, 3).join(', ')}${nested.length > 3 ? ', …' : ''}). Git would run that repository’s own settings on this computer, so Promptboard runs no Git in this workspace until you delete it. Do not run Git there yourself either.` : '';
}

export class Sandbox {
  constructor({ dataDir, codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), uid = process.getuid?.(), gid = process.getgid?.() }) {
    this.dataDir = dataDir;
    this.dir = join(dataDir, 'sandbox'); // Exists once Docker mode was used here: only then do startup and shutdown look for containers.
    this.codexHome = codexHome;
    this.user = `${uid}:${gid}`;
    // Labels every container this data folder starts, so a sweep never touches another Promptboard's containers.
    this.label = createHash('sha256').update((() => { try { return realpathSync(dataDir); } catch { return dataDir; } })()).digest('hex').slice(0, 16);
    this.visible = new Set(); // Worktrees (with image and Git data) a container was seen to show.
    this.versions = new Map();
    this.job = null;
    this.sweeping = null;
  }

  async #docker(args, { signal, timeoutMs = 15000 } = {}) {
    const command = await commandOnPath('docker');
    if (!command) throw fail('SANDBOX_DOCKER_MISSING');
    return execute({ command, args, signal, timeoutMs, maxStdout: 1024 * 1024 });
  }

  async #running(signal) {
    if (process.platform === 'win32') throw fail('SANDBOX_UNSUPPORTED_PLATFORM');
    try { await this.#docker(['version', '--format', '{{.Server.Version}}'], { signal, timeoutMs: 10000 }); }
    catch (error) { signal?.throwIfAborted(); throw error.code === 'SANDBOX_DOCKER_MISSING' ? error : fail('SANDBOX_DOCKER_STOPPED'); }
  }

  async #hasImage(name, signal) { return this.#docker(['image', 'inspect', '--format', '{{.Id}}', name], { signal, timeoutMs: 10000 }).then(() => true, () => false); }

  /** The installed CLI's version, read once per executable file. */
  async #version(provider) {
    const found = await resolveExecutable(provider);
    if (!found) return '';
    const file = await realpath(found.prefix[0] || found.command).catch(() => found.command);
    const key = `${file}:${(await stat(file).catch(() => null))?.mtimeMs}`;
    if (!this.versions.has(key)) {
      const out = await execute({ command: found.command, args: [...found.prefix, '--version'], timeoutMs: 15000, maxStdout: 8192, maxStderr: 8192 }).then(result => result.stdout, () => '');
      const version = out.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?\b/)?.[0];
      if (!version) return '';
      this.versions.set(key, version);
    }
    return this.versions.get(key);
  }

  /** Promptboard's image for this computer's CLI versions: the tag changes when the Dockerfile or a version does. */
  async defaultImage() {
    const versions = { claude: await this.#version('claude'), codex: await this.#version('codex') };
    const hash = createHash('sha256').update(await readFile(DOCKERFILE)).update(JSON.stringify(versions)).digest('hex').slice(0, 12);
    return { name: `${IMAGE_REPOSITORY}:${hash}`, versions };
  }

  async #settings() { try { return JSON.parse(await readFile(join(this.dir, 'settings.json'), 'utf8')) || {}; } catch { return {}; } }
  async image() { const own = (await this.#settings()).image; return own ? { name: own, custom: true } : { ...(await this.defaultImage()), custom: false }; }

  async setImage(name) {
    const image = typeof name === 'string' ? name.trim() : '';
    if (name !== undefined && name !== null && typeof name !== 'string' || image && !IMAGE_NAME.test(image)) throw fail('SANDBOX_INVALID_IMAGE');
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeAtomic(join(this.dir, 'settings.json'), JSON.stringify(image ? { image } : {}));
    this.visible.clear();
  }

  // Claude Code's sign-in token for containers: a private file in the data folder, never in state.json, a backup or a reply.
  #tokenFile() { return join(this.dir, 'claude-token'); }
  async #token() { return (await readFile(this.#tokenFile(), 'utf8').catch(() => '')).trim(); }
  async setClaudeToken(token) {
    const value = typeof token === 'string' ? token.trim() : '';
    if (!/^[\x21-\x7e]{20,4096}$/.test(value)) throw fail('SANDBOX_INVALID_TOKEN');
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeAtomic(this.#tokenFile(), value, { backup: false });
  }
  async clearClaudeToken() { await rm(this.#tokenFile(), { force: true }); }

  async status() {
    const docker = await commandOnPath('docker');
    let state = process.platform === 'win32' ? 'unsupported' : docker ? 'running' : 'missing';
    if (state === 'running') await this.#running().catch(() => { state = 'stopped'; });
    const image = await this.image();
    return { docker: state, image: { name: image.name, custom: image.custom, ready: state === 'running' && await this.#hasImage(image.name) },
      signIn: { claude: Boolean(await this.#token()), codex: await exists(join(this.codexHome, 'auth.json')) }, build: this.buildStatus() };
  }

  buildStatus() {
    const job = this.job;
    return job ? { status: job.status, image: job.image, startedAt: job.startedAt, endedAt: job.endedAt || null, lines: job.lines.slice(-40) } : { status: 'idle', lines: [] };
  }

  /** Build Promptboard's image with the versions installed here. Progress is kept for the Settings page; Cancel stops it. */
  async startBuild() {
    if (this.job?.status === 'running') throw fail('SANDBOX_BUILD_RUNNING');
    await this.#running();
    const { name, versions } = await this.defaultImage();
    if (!versions.claude && !versions.codex) throw fail('SANDBOX_NO_CLI');
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const job = this.job = { status: 'running', image: name, startedAt: Date.now(), lines: [] };
    const child = job.child = spawnOwned(await commandOnPath('docker'), ['build', '-t', name, '--label', 'promptboard.sandbox=1', '--build-arg', `CLAUDE_CODE_VERSION=${versions.claude}`,
      '--build-arg', `CODEX_VERSION=${versions.codex}`, '-f', DOCKERFILE, dirname(DOCKERFILE)], { cwd: dirname(DOCKERFILE) });
    let partial = '';
    const take = chunk => {
      const text = partial + chunk.toString('utf8'), rows = text.split(/\r?\n|\r/);
      partial = rows.pop();
      job.lines.push(...rows.filter(row => row.trim()).map(row => row.slice(0, 400)));
      if (job.lines.length > BUILD_LINES) job.lines.splice(0, job.lines.length - BUILD_LINES);
    };
    child.stdout.on('data', take); child.stderr.on('data', take);
    child.stdin.end();
    const finish = async code => {
      if (job.status !== 'running') return;
      if (partial.trim()) job.lines.push(partial.slice(0, 400));
      job.status = job.cancelled ? 'cancelled' : code === 0 ? 'succeeded' : 'failed'; job.endedAt = Date.now(); job.child = null;
      if (job.status === 'succeeded') await this.#removeOldImages(name).catch(() => {});
    };
    child.once('error', () => finish(null));
    child.once('close', finish);
    return this.buildStatus();
  }

  cancelBuild() {
    const job = this.job;
    if (job?.status !== 'running' || !job.child) return this.buildStatus();
    job.cancelled = true;
    const child = job.child;
    stopProcess(child);
    setTimeout(() => { if (job.child === child) stopProcess(child, 'SIGKILL'); }, 3000).unref();
    return this.buildStatus();
  }

  /** Promptboard's own older images (earlier CLI versions). An image a container still uses is kept. */
  async #removeOldImages(current) {
    const old = lines((await this.#docker(['image', 'ls', IMAGE_REPOSITORY, '--format', '{{.Repository}}:{{.Tag}}'])).stdout).filter(name => name !== current && name.startsWith(`${IMAGE_REPOSITORY}:`));
    if (old.length) await this.#docker(['image', 'rm', ...old]).catch(() => {});
  }

  /**
   * Check Docker for one run and return what the terminal spawns in place of the CLI: the docker client, its arguments
   * and the environment it passes on by name. Each failure has its own code and plain message.
   */
  async prepare({ run, runs, runDir, built, signal }) {
    await this.sweeping;
    const provider = run.config.provider; // Claude Code or Codex: resolveConfig refuses Docker mode for the others.
    await this.#running(signal);
    const { name: image } = await this.image();
    if (!await this.#hasImage(image, signal)) { signal?.throwIfAborted(); throw fail('SANDBOX_IMAGE_MISSING'); }
    const token = provider === 'claude' ? await this.#token() : '';
    const codexAuth = provider === 'codex' ? await realpath(join(this.codexHome, 'auth.json')).catch(() => null) : null;
    if (provider === 'claude' ? !token : !codexAuth) throw fail('SANDBOX_SIGNIN_MISSING', SIGN_IN[provider]);
    const folders = await gitFolders(run.workspacePath);
    const home = conversationHome(this.dataDir, runs, run), cliHome = join(home, provider === 'codex' ? 'codex' : 'claude');
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await mkdir(cliHome, { recursive: true, mode: 0o700 });
    // Every protected Git file must exist before it is mounted (Docker would create a folder in its place).
    await writeFile(join(folders.gitDir, 'config.worktree'), '', { flag: 'a' });
    if (!(await Promise.all(PROTECTED_GIT_FILES.map(name => lstat(join(folders.gitDir, name)).then(info => info.isFile(), () => false)))).every(Boolean)) throw fail('SANDBOX_NOT_WORKTREE');
    const place = async path => ({ path, real: await realpath(path) });
    const [workspace, gitDir, commonDir, runPlace, homePlace, app] = await Promise.all([run.workspacePath, folders.gitDir, folders.commonDir, runDir, home, APP_DIR].map(place));
    const codexPlace = codexAuth && { path: join(this.codexHome, 'auth.json'), real: codexAuth };
    if ([workspace, gitDir, commonDir, runPlace, homePlace, app, codexPlace].some(item => item && `${item.path}${item.real}`.includes(':'))) throw fail('SANDBOX_PATH_UNSUPPORTED');
    // A fresh CLI home: Codex does not offer updates (the image is rebuilt instead); Claude Code skips its first-run setup.
    const seed = (file, text) => writeFile(join(cliHome, file), text, { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    if (provider === 'codex') { await seed('config.toml', 'check_for_update_on_startup = false\n'); await seed('auth.json', ''); } // auth.json: the mount point of the sign-in.
    else await seed('.claude.json', `${JSON.stringify({ hasCompletedOnboarding: true })}\n`);
    // Each check names the folder to share. The run folder lives in the data folder, so the worktree's check covers later runs.
    const shown = [workspace, commonDir, runPlace, app, ...(codexPlace ? [{ path: dirname(codexPlace.path), real: dirname(codexPlace.real) }] : [])];
    await this.#checkVisible(image, JSON.stringify([image, workspace, commonDir, codexAuth]), shown, [['-f', join(workspace.path, '.git'), workspace.path], ['-d', join(commonDir.path, 'objects'), dirname(commonDir.path)],
      ['-d', runPlace.path, runPlace.path], ['-f', join(app.path, 'src', 'agent-hook.mjs'), app.path], ...(codexPlace ? [['-f', codexPlace.path, dirname(codexPlace.path)]] : [])], signal);
    const env = { ...built.env, ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}) };
    const values = { HOME: home, ...(provider === 'codex' ? { CODEX_HOME: cliHome } : { CLAUDE_CONFIG_DIR: cliHome }) };
    const session = containerSession(provider, built.args);
    const mounts = sandboxMounts({ workspace, gitDir, commonDir, runDir: runPlace, home: homePlace, app, codexAuth: codexPlace, readOnly: session.readOnly });
    return { command: await commandOnPath('docker'), env, codexHome: provider === 'codex' ? cliHome : null,
      args: dockerRunArgs({ runId: run.id, label: this.label, user: this.user, workdir: workspace.path, mounts, image, command: provider, args: session.args, names: Object.keys(env), values }) };
  }

  /** A folder the Docker machine does not share mounts as an empty one, without an error: a tiny container checks them once per worktree. */
  async #checkVisible(image, key, folders, checks, signal) {
    if (this.visible.has(key)) return;
    try {
      await this.#docker(['run', '--rm', '--name', `pb-check-${randomUUID().slice(0, 8)}`, '--label', `promptboard.data=${this.label}`, '--user', this.user,
        ...folders.flatMap(folder => ['-v', `${folder.real}:${folder.path}:ro`]), image, 'sh', '-c', 'while [ $# -gt 1 ]; do test "$1" "$2" || { printf %s "$2"; exit 3; }; shift 2; done', 'sh',
        ...checks.flatMap(([type, path]) => [type, path])], { signal, timeoutMs: 30000 });
    } catch (error) {
      signal?.throwIfAborted();
      const hidden = error.details?.exitCode === 3 && checks.find(([, path]) => path === error.details.stdout);
      throw hidden ? fail('SANDBOX_MOUNT_HIDDEN', SANDBOX_MESSAGES.SANDBOX_MOUNT_HIDDEN.replace('this folder', `this folder (${hidden[2]})`)) : fail('SANDBOX_START_FAILED');
    }
    this.visible.add(key);
  }

  /** Stop one run's container (the terminal only holds the docker client). */
  remove(runId) { return this.#docker(['rm', '-f', `pb-run-${runId}`], { timeoutMs: 20000 }).catch(() => {}); }

  /** Remove every container this data folder started: at startup (left by a crash) and at shutdown. */
  sweep() {
    return this.sweeping = (async () => {
      if (!await exists(this.dir) || !await commandOnPath('docker')) return 0;
      const ids = lines((await this.#docker(['ps', '-aq', '--filter', `label=promptboard.data=${this.label}`], { timeoutMs: 10000 }).catch(() => ({ stdout: '' }))).stdout);
      if (ids.length) await this.#docker(['rm', '-f', ...ids], { timeoutMs: 20000 }).catch(() => {});
      return ids.length;
    })();
  }
}

/** /api/sandbox routes: status, the image build, the optional image name, and Claude Code's token (set or removed only). */
export async function sandboxRoute({ sandbox, req, res, pathname, jsonBody, send }) {
  if (!sandbox) return send(res, 503, { error: 'The Docker sandbox is not available in this app.', code: 'SANDBOX_UNAVAILABLE' });
  const method = req.method, reply = async () => send(res, 200, { sandbox: await sandbox.status() });
  if (method === 'GET' && pathname === '/api/sandbox') return reply();
  if (method === 'GET' && pathname === '/api/sandbox/build') return send(res, 200, { build: sandbox.buildStatus() });
  if (method === 'POST' && pathname === '/api/sandbox/build') { await jsonBody(req, 1024); await sandbox.startBuild(); return reply(); }
  if (method === 'POST' && pathname === '/api/sandbox/build/cancel') { await jsonBody(req, 1024); return send(res, 200, { build: sandbox.cancelBuild() }); }
  if (method === 'PUT' && pathname === '/api/sandbox/settings') { await sandbox.setImage((await jsonBody(req, 4096))?.image); return reply(); }
  if (method === 'PUT' && pathname === '/api/sandbox/claude-token') { await sandbox.setClaudeToken((await jsonBody(req, 16384))?.token); return reply(); }
  if (method === 'DELETE' && pathname === '/api/sandbox/claude-token') { await sandbox.clearClaudeToken(); return reply(); }
  return send(res, 404, { error: 'This route does not exist.' });
}
