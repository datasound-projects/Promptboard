// GitHub connection with a SIMULATED GitHub CLI (a fake gh on PATH). No real GitHub account,
// token, or network is used. The "remote" is a disposable bare repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from '../src/board.mjs';
import { clonePath, fastForward, fetchAndCompare, GitHubLogin, githubRepositoryOf, githubStatus, listRepositories } from '../src/github.mjs';
import { startServer } from '../src/server.mjs';
import { fakeGh } from './fixtures/fake-gh.mjs';

const skip = process.platform === 'win32';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
async function temp(t, prefix) { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return dir; }

test('connection status: signed in, not signed in, expired, offline, and gh missing; no token is ever returned', { skip }, async t => {
  const gh = await fakeGh(t);
  assert.deepEqual(await githubStatus(), { installed: true, state: 'connected', user: 'octo', message: '' });
  await gh.setMode('none');
  assert.equal((await githubStatus()).state, 'not_connected');
  await gh.setMode('expired');
  assert.match(JSON.stringify(await githubStatus()), /needs_attention.*expired/);
  await gh.setMode('offline');
  assert.match((await githubStatus()).message, /could not be reached/);
  const oldPath = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try { assert.deepEqual(await githubStatus(), { installed: false, state: 'not_connected', user: '', message: 'Install the GitHub CLI (gh) to connect GitHub.' }); }
  finally { process.env.PATH = oldPath; }
});

test('repository search lists accessible repositories and drops invalid names', { skip }, async t => {
  await fakeGh(t);
  const rows = await listRepositories();
  assert.deepEqual(rows.map(row => [row.nameWithOwner, row.private, row.defaultBranch]), [['acme/app', true, 'main'], ['acme/docs', false, 'trunk']]);
});

test('connect: managed clone in the data folder, linked, target branch set; fetch, sync state, fast-forward, disconnect keeps work', { skip, timeout: 60000 }, async t => {
  const gh = await fakeGh(t);
  const dataDir = await temp(t, 'pb-gh-data-');
  const board = new Board({ dataDir });
  const project = await board.createProject({ name: 'App' });
  await assert.rejects(board.connectGitHub(project.id, { repository: 'acme/private', expectedRevision: 1 }), { code: 'GH_FAILED' });
  await assert.rejects(board.connectGitHub(project.id, { repository: '--help', expectedRevision: 1 }), { code: 'INVALID_REPOSITORY' });
  const connected = await board.connectGitHub(project.id, { repository: 'acme/app', expectedRevision: 1 });
  const path = clonePath(dataDir, 'acme/app');
  assert.equal(path, join(dataDir, 'clones', 'acme', 'app'));
  assert.equal(connected.repository.root, path);
  assert.equal(connected.targetBranch.name, 'main');
  assert.equal(connected.github.nameWithOwner, 'acme/app');
  assert.equal(connected.github.private, true);
  assert.match(git(path, 'config', '--get-all', 'credential.https://github.com.helper'), /!gh auth git-credential/, 'The credential helper is set for this clone only.');
  // No credential is stored anywhere in the board.
  const saved = await readFile(join(dataDir, 'board.json'), 'utf8').catch(async () => JSON.stringify(await board.state()));
  assert.doesNotMatch(saved, /gho_|ghp_|token/i);
  // Fetch: up to date. Then the remote moves ahead: behind by 1; fast-forward brings it level.
  let project2 = await board.fetchGitHub(project.id);
  assert.equal(project2.github.sync.sync, 'up_to_date');
  assert.ok(project2.github.lastFetchAt);
  await writeFile(join(gh.seed, 'a.txt'), 'two\n'); git(gh.seed, 'commit', '-q', '-am', 'two'); git(gh.seed, 'push', '-q', gh.bare, 'main');
  project2 = await board.fetchGitHub(project.id);
  assert.deepEqual([project2.github.sync.sync, project2.github.sync.behind], ['behind', 1]);
  await assert.rejects(board.updateTargetFromGitHub(project.id, {}), { code: 'CONFIRMATION_REQUIRED' });
  const updated = await board.updateTargetFromGitHub(project.id, { confirm: true });
  assert.equal(updated.github.sync.sync, 'up_to_date');
  assert.equal(updated.targetBranch.commit, git(gh.seed, 'rev-parse', 'HEAD'));
  // A local commit plus a remote commit: diverged. Promptboard reports it and changes nothing.
  git(path, 'config', 'user.email', 't@example.com'); git(path, 'config', 'user.name', 'Tester');
  await writeFile(join(path, 'b.txt'), 'local\n'); git(path, 'add', '.'); git(path, 'commit', '-q', '-m', 'local');
  const local = git(path, 'rev-parse', 'HEAD');
  await writeFile(join(gh.seed, 'a.txt'), 'three\n'); git(gh.seed, 'commit', '-q', '-am', 'three'); git(gh.seed, 'push', '-q', gh.bare, 'main');
  project2 = await board.fetchGitHub(project.id);
  assert.equal(project2.github.sync.sync, 'needs_attention');
  await assert.rejects(board.updateTargetFromGitHub(project.id, { confirm: true }), { code: 'NOT_FAST_FORWARD' });
  assert.equal(git(path, 'rev-parse', 'HEAD'), local, 'The local commit is kept.');
  // Network failure: a recoverable error, local work untouched.
  git(path, 'config', 'url./nonexistent/repo.git.insteadOf', 'https://github.com/acme/app.git');
  git(path, 'config', '--unset', `url.${gh.bare}.insteadOf`);
  await assert.rejects(board.fetchGitHub(project.id), error => error.code === 'FETCH_FAILED' && /local work is safe/.test(error.message));
  assert.equal(git(path, 'rev-parse', 'HEAD'), local);
  // Reconnecting reuses the clone; disconnecting forgets GitHub but keeps the clone and the link.
  const again = await board.disconnectGitHub(project.id, { expectedRevision: (await board.state()).projects[0].revision });
  assert.equal(again.github, null);
  assert.equal(again.repository.root, path);
  assert.equal(git(path, 'rev-parse', 'HEAD'), local);
  const reused = await board.connectGitHub(project.id, { repository: 'acme/app', expectedRevision: again.revision });
  assert.equal(reused.repository.root, path);
  assert.equal((await gh.log()).filter(args => args[0] === 'repo' && args[1] === 'clone').length, 1, 'The clone is made once.');
  assert.ok(!(await gh.log()).some(args => args.includes('logout')), 'Disconnecting never signs gh out.');
});

test('updating the clone never overwrites a file Git ignores there (a local .env): the refusal names it', { skip, timeout: 60000 }, async t => {
  const base = await temp(t, 'pb-gh-ff-');
  const seed = join(base, 'seed'), bare = join(base, 'remote.git'), clone = join(base, 'clone');
  git(base, 'init', '-q', '-b', 'main', seed); git(seed, 'config', 'user.email', 't@example.com'); git(seed, 'config', 'user.name', 'Tester');
  await writeFile(join(seed, '.gitignore'), '.env\n'); git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'ignore .env');
  git(base, 'clone', '-q', '--bare', seed, bare); git(seed, 'remote', 'add', 'origin', bare); git(base, 'clone', '-q', bare, clone);
  await writeFile(join(clone, '.env'), 'SECRET=mine\n');
  // Upstream starts tracking a .env of its own.
  await writeFile(join(seed, '.gitignore'), ''); await writeFile(join(seed, '.env'), 'SECRET=changeme\n'); git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'example env'); git(seed, 'push', '-q', 'origin', 'main');
  assert.equal((await fetchAndCompare(clone, 'main')).sync, 'behind');
  await assert.rejects(fastForward(clone, 'main'), { code: 'UNTRACKED_FILES', message: 'Updating main would overwrite files in the clone that Git does not track: .env. Promptboard does not replace them: move or rename them, then update again.' });
  assert.equal(await readFile(join(clone, '.env'), 'utf8'), 'SECRET=mine\n');
  assert.equal((await fetchAndCompare(clone, 'main')).sync, 'behind', 'Nothing moved.');
});

test('a rate limit is reported as one, and a repository name that reads like an error is still "not found"', { skip }, async t => {
  const gh = await fakeGh(t);
  const board = new Board({ dataDir: await temp(t, 'pb-gh-data-') });
  const project = await board.createProject({ name: 'App' });
  // gh repeats the name it could not find.
  for (const name of ['acme/authentication', 'acme/api-401', 'acme/timeout']) await assert.rejects(board.connectGitHub(project.id, { repository: name, expectedRevision: 1 }), { code: 'GH_FAILED' }, name);
  await gh.setMode('ratelimited');
  await assert.rejects(listRepositories(), { code: 'GH_RATE_LIMITED', message: /rate limit/ });
  await assert.rejects(board.connectGitHub(project.id, { repository: 'acme/app', expectedRevision: 1 }), { code: 'GH_RATE_LIMITED' });
  assert.deepEqual(await githubStatus(), { installed: true, state: 'needs_attention', user: '', message: 'GitHub’s rate limit for this account was reached. Wait a few minutes, then check again.' });
});

test('a folder that is not a clone of the repository is never reused or changed', { skip }, async t => {
  await fakeGh(t);
  const dataDir = await temp(t, 'pb-gh-data-');
  const path = clonePath(dataDir, 'acme/app');
  execFileSync('mkdir', ['-p', path]);
  git(path, 'init', '-q');
  git(path, 'remote', 'add', 'origin', 'https://github.com/someone/else.git');
  const board = new Board({ dataDir });
  const project = await board.createProject({ name: 'App' });
  await assert.rejects(board.connectGitHub(project.id, { repository: 'acme/app', expectedRevision: 1 }), { code: 'CLONE_CONFLICT' });
  assert.equal(git(path, 'config', '--get', 'remote.origin.url'), 'https://github.com/someone/else.git');
});

test('browser sign-in runs gh auth login --web, shows only the one-time code, answers its prompts, and can be cancelled', async () => {
  const writes = [];
  let onData, onExit, killed = false, spawned;
  const pty = { spawn: (command, args) => { spawned = [command, ...args]; return { pid: 999999, write: data => writes.push(data), kill: () => { killed = true; }, onData: fn => { onData = fn; }, onExit: fn => { onExit = fn; } }; } };
  const login = new GitHubLogin({ ptyLoader: async () => ({ pty }) });
  assert.equal((await login.start()).status, 'starting');
  assert.deepEqual(spawned, ['gh', 'auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https', '--skip-ssh-key']);
  onData('! First copy your one-time code: AB12-CD34\r\nPress Enter to open https://github.com/login/device in your browser... ');
  assert.deepEqual(login.snapshot(), { status: 'waiting', code: 'AB12-CD34', url: 'https://github.com/login/device', startedAt: login.snapshot().startedAt });
  assert.deepEqual(writes, ['\r']);
  onData('? Authenticate Git with your GitHub credentials? (Y/n) ');
  assert.deepEqual(writes, ['\r', 'n\r'], 'The global Git credential setup is declined.');
  onExit({ exitCode: 0 });
  assert.equal(login.snapshot().status, 'done');
  await login.start();
  login.cancel();
  assert.equal(killed, true);
  assert.equal(login.snapshot().status, 'cancelled');
  const none = new GitHubLogin({ ptyLoader: async () => ({ pty: null }) });
  await assert.rejects(none.start(), { code: 'LOGIN_UNAVAILABLE' });
});

test('concurrent Connect starts one sign-in, and a cancelled one exiting late cannot end the next', async () => {
  const procs = [];
  const pty = { spawn: () => { const proc = { pid: 999990 + procs.length, write: () => {}, kill: () => {}, onData: () => {}, onExit: fn => { proc.exit = fn; } }; procs.push(proc); return proc; } };
  const login = new GitHubLogin({ ptyLoader: async () => ({ pty }) });
  await Promise.all([login.start(), login.start()]);
  assert.equal(procs.length, 1, 'Only one gh auth login runs.');
  login.cancel(); await login.start();
  assert.equal(procs.length, 2); assert.equal(login.proc, procs[1]);
  procs[0].exit({ exitCode: 1 });
  assert.equal(login.proc, procs[1]); assert.equal(login.snapshot().status, 'starting');
  procs[1].exit({ exitCode: 0 });
  assert.equal(login.snapshot().status, 'done'); assert.equal(login.proc, null);
  login.cancel();
});

test('GitHub routes need the session token and never return a token', { skip }, async t => {
  await fakeGh(t);
  const dataDir = await temp(t, 'pb-gh-data-');
  const app = await startServer({ port: 0, dataDir, executor: null, githubPty: async () => ({ pty: null }) });
  t.after(() => app.close());
  assert.equal((await fetch(app.url + '/api/github/status')).status, 403);
  const { token } = await fetch(app.url + '/api/session').then(r => r.json());
  const headers = { 'x-ste-token': token, 'content-type': 'application/json' };
  const status = await fetch(app.url + '/api/github/status', { headers }).then(r => r.json());
  assert.equal(status.github.user, 'octo');
  const repos = await fetch(app.url + '/api/github/repos?q=DOC', { headers }).then(r => r.json());
  assert.deepEqual(repos.repositories.map(row => row.nameWithOwner), ['acme/docs']);
  const login = await fetch(app.url + '/api/github/login', { method: 'POST', headers, body: '{}' });
  assert.equal(login.status, 409);
  assert.match((await login.json()).error, /gh auth login --web/);
  const all = JSON.stringify([status, repos]);
  assert.doesNotMatch(all, /gho_|ghp_|token/i);
});

test('GitHub remotes are recognized in HTTPS and SSH form; anything else is not GitHub', () => {
  for (const url of ['https://github.com/acme/app.git', 'https://github.com/acme/app', 'git@github.com:acme/app.git', 'ssh://git@github.com/acme/app.git', 'https://user@github.com/acme/app.git']) assert.equal(githubRepositoryOf(url), 'acme/app', url);
  for (const url of ['https://gitlab.com/acme/app.git', 'https://github.com.evil.example/acme/app', '/srv/git/app.git', 'https://github.com/acme', '', 'https://github.com/acme/app/extra']) assert.equal(githubRepositoryOf(url), '', url);
});

test('connect a linked folder that is already a clone (nothing cloned or changed), or clone into a folder the person chose', { skip, timeout: 60000 }, async t => {
  const gh = await fakeGh(t);
  const dataDir = await temp(t, 'pb-gh-data-'), mine = await temp(t, 'pb-gh-mine-');
  const board = new Board({ dataDir });
  // An existing clone of the user's own: linked as a local folder, then connected as it is.
  const own = join(mine, 'own-app');
  git(mine, 'clone', '-q', gh.bare, own);
  git(own, 'remote', 'set-url', 'origin', 'git@github.com:acme/app.git');
  git(own, 'config', `url.${gh.bare}.insteadOf`, 'git@github.com:acme/app.git');
  const first = await board.createProject({ name: 'Own' });
  const linked = await board.linkRepository(first.id, { path: own, expectedRevision: first.revision });
  const withBranch = await board.setTargetBranch(first.id, { branch: 'main', expectedRevision: linked.project.revision });
  assert.equal(await board.githubRemote(first.id), 'acme/app');
  const before = git(own, 'config', '--list', '--local');
  const connected = await board.connectGitHub(first.id, { existing: true, expectedRevision: withBranch.revision });
  assert.deepEqual([connected.github.nameWithOwner, connected.github.clonePath, connected.github.managed, connected.repository.root], ['acme/app', own, false, own]);
  assert.equal(git(own, 'config', '--list', '--local'), before, 'the folder’s Git config is not changed');
  assert.equal((await board.fetchGitHub(first.id)).github.sync.sync, 'up_to_date');
  assert.equal((await gh.log()).filter(args => args[0] === 'repo' && args[1] === 'clone').length, 0, 'nothing is cloned');
  // A folder with a remote that is not on GitHub is refused.
  const plain = join(mine, 'plain'); git(mine, 'init', '-q', plain); git(plain, 'remote', 'add', 'origin', 'https://gitlab.com/acme/app.git');
  git(plain, '-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'x');
  const second = await board.createProject({ name: 'Plain' });
  const plainLinked = await board.linkRepository(second.id, { path: plain, expectedRevision: second.revision });
  assert.equal(await board.githubRemote(second.id), '');
  await assert.rejects(board.connectGitHub(second.id, { existing: true, expectedRevision: plainLinked.project.revision }), { code: 'NO_GITHUB_REMOTE' });
  // Clone into a chosen folder: <folder>/<name>, linked like the managed clone.
  const third = await board.createProject({ name: 'Chosen' });
  await assert.rejects(board.connectGitHub(third.id, { repository: 'acme/app', parent: 'relative/path', expectedRevision: third.revision }), { code: 'INVALID_FOLDER' });
  const chosen = await board.connectGitHub(third.id, { repository: 'acme/app', parent: mine, expectedRevision: third.revision });
  assert.deepEqual([chosen.repository.root, chosen.github.managed, chosen.targetBranch.name], [join(mine, 'app'), false, 'main']);
  assert.match(git(join(mine, 'app'), 'config', '--get-all', 'credential.https://github.com.helper'), /!gh auth git-credential/);
  // A plain folder inside a clone is never taken for that clone.
  const fourth = await board.createProject({ name: 'Nested' });
  execFileSync('mkdir', ['-p', join(own, 'nested', 'app')]);
  await assert.rejects(board.connectGitHub(fourth.id, { repository: 'acme/app', parent: join(own, 'nested'), expectedRevision: fourth.revision }), { code: 'CLONE_CONFLICT' });
});
