// Docker mode tests. Everything here is SIMULATED: a fake docker client (tests/fixtures/fake-docker.cjs) and fake CLIs
// (tests/fixtures/fake-agent.cjs) stand in for Docker, Claude Code and Codex. No Docker, network or real CLI is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSession, HOOK_SCRIPT, resolveConfig } from '../src/agents.mjs';
import { Board, effectiveWorkflow } from '../src/board.mjs';
import { defaultPipelineConfig, normalizeExecutionPolicy } from '../src/pipeline-config.mjs';
import { git as hostGit } from '../src/git.mjs';
import { containerSession, conversationHome, dockerRunArgs, nestedRepositories, nestedRepositoryProblem, PROTECTED_GIT_FILES, Sandbox, sandboxMounts } from '../src/sandbox.mjs';
import { startServer } from '../src/server.mjs';
import { Supervisor } from '../src/supervisor.mjs';
import { customPipelineConfig } from './helpers/pipeline.mjs';

const skip = process.platform === 'win32'; // Docker mode runs on macOS and Linux only.
const fakeAgent = fileURLToPath(new URL('./fixtures/fake-agent.cjs', import.meta.url));
const fakeDocker = fileURLToPath(new URL('./fixtures/fake-docker.cjs', import.meta.url));
const APP_DIR = dirname(dirname(HOOK_SCRIPT));
const TOKEN = 'sk-ant-oat01-FIXTURE-TOKEN-never-shown-0123456789';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
async function temp(t, prefix) { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return dir; }
async function until(fn, label, ms = 20000) { const end = Date.now() + ms; for (;;) { const value = await fn(); if (value) return value; if (Date.now() > end) assert.fail(`Timed out: ${label}`); await new Promise(r => setTimeout(r, 50)); } }
// Each variable is restored once, to its value before the test, however often the test changes it.
const saved = new WeakMap();
function setEnv(t, key, value) {
  if (!saved.has(t)) { const original = new Map(); saved.set(t, original); t.after(() => { for (const [name, before] of original) if (before === undefined) delete process.env[name]; else process.env[name] = before; }); }
  if (!saved.get(t).has(key)) saved.get(t).set(key, process.env[key]);
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
const exists = path => stat(path).then(() => true, () => false);
const realpathSyncOf = path => realpathSync(path);
const jsonLines = async file => (await readFile(file, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

/** Fake docker and fake CLIs first on PATH. The CLIs answer --version as the real ones do (the image tag uses it). */
async function fakes(t, { docker = true } = {}) {
  const bin = await temp(t, 'pb-sandbox-bin-'), state = await temp(t, 'pb-sandbox-docker-');
  const script = (name, body) => writeFile(join(bin, name), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  for (const cli of ['claude', 'codex']) await script(cli, `if (process.argv[2] === '--version') { console.log('9.8.7'); process.exit(0); }\nrequire(${JSON.stringify(fakeAgent)});`);
  if (docker) await script('docker', `require(${JSON.stringify(fakeDocker)});`);
  setEnv(t, 'PATH', `${bin}${delimiter}${process.env.PATH}`);
  for (const [key, value] of Object.entries({ FAKE_DOCKER_BIN: bin, FAKE_DOCKER_STATE: state, FAKE_DOCKER_REPORT: join(state, 'calls.jsonl'), FAKE_AGENT_REPORT: join(state, 'agents.jsonl') })) setEnv(t, key, value);
  for (const key of ['FAKE_DOCKER_STOPPED', 'FAKE_DOCKER_HIDE', 'FAKE_DOCKER_CHECK_FAIL', 'FAKE_DOCKER_BUILD_MS', 'FAKE_DOCKER_BUILD_FAIL']) setEnv(t, key, undefined);
  const dockerState = async () => JSON.parse(await readFile(join(state, 'state.json'), 'utf8').catch(() => '{"images":[],"containers":[]}'));
  return { bin, state, calls: () => jsonLines(join(state, 'calls.jsonl')), agents: () => jsonLines(join(state, 'agents.jsonl')), dockerState,
    setState: value => writeFile(join(state, 'state.json'), JSON.stringify({ images: [], containers: [], ...value })) };
}

/** A pipeline project in Docker mode, with a linked repository, and the agent of every active column set to `provider`. */
async function boxed(t, { provider = 'codex', server = false, link = false } = {}) {
  // link: the data folder is reached through a symbolic link, as a moved or shared folder can be.
  let dataDir = await temp(t, 'pb-sandbox-data-');
  if (link) { const linked = join(await temp(t, 'pb-sandbox-link-'), 'data'); await symlink(dataDir, linked); dataDir = linked; }
  const root = await temp(t, 'pb-sandbox-repo-'), codexHome = await temp(t, 'pb-sandbox-codex-');
  git(root, 'init', '-q', '-b', 'trunk'); git(root, 'config', 'user.email', 't@e'); git(root, 'config', 'user.name', 'T');
  await writeFile(join(root, 'README.md'), 'main checkout\n'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'init');
  await writeFile(join(codexHome, 'auth.json'), '{"fixture":"codex sign-in"}\n', { mode: 0o600 });
  const app = server ? await startServer({ port: 0, dataDir, detector: async () => [] }) : null;
  const board = app ? app.board : new Board({ dataDir });
  const sandbox = app ? board.executor.sandbox : new Sandbox({ dataDir, codexHome });
  if (!app) board.executor = new Supervisor({ board, dataDir, sandbox });
  t.after(() => app ? app.close() : board.executor.shutdown(500));
  const project = await board.createProject({ name: 'Boxed', workflowMode: 'pipeline' });
  const now = async () => (await board.state()).projects.find(item => item.id === project.id);
  await board.linkRepository(project.id, { path: root, expectedRevision: (await now()).revision });
  await board.setTargetBranch(project.id, { branch: 'trunk', expectedRevision: (await now()).revision });
  const config = defaultPipelineConfig();
  for (const column of config.columns.filter(item => item.role === 'active')) column.strategy.agentOverride = provider;
  await board.setPipeline(project.id, { pipeline: config, expectedRevision: (await now()).revision });
  await board.setExecutionPolicy(project.id, { policy: { sandbox: 'docker' }, expectedRevision: (await now()).revision });
  const image = (await sandbox.defaultImage()).name;
  const start = async (title, prompt, column = 'executing') => {
    const task = await board.createTask({ projectId: project.id, title, prompt });
    return (await board.transition(task.id, { column, expectedRevision: task.revision })).run;
  };
  return { app, board, sandbox, dataDir, root, codexHome, project, now, image, start, run: id => board.run(id) };
}
const runCalls = calls => calls.filter(call => call.args[0] === 'run' && !call.args.includes('sh'));
const values = (args, flag) => args.flatMap((arg, at) => arg === flag ? [args[at + 1]] : []);
// The container's view, from docker run's -v list: the most specific mount decides, as Docker stacks nested mounts.
const mountsOf = args => values(args, '-v').map(spec => { const ro = spec.endsWith(':ro'), [source, target] = (ro ? spec.slice(0, -3) : spec).split(':'); return [source, target, ro]; });
const mountFor = (mounts, path) => mounts.filter(([, target]) => path === target || path.startsWith(target + sep)).sort((a, b) => b[1].length - a[1].length)[0];
const writable = (mounts, path) => { const mount = mountFor(mounts, path); return Boolean(mount) && !mount[2]; };
/** A write as a process in the container makes it: refused like EROFS where its mount is read-only or missing. */
async function containerWrite(mounts, path, text) {
  if (!writable(mounts, path)) throw Object.assign(new Error(`EROFS: read-only file system, open '${path}'`), { code: 'EROFS' });
  const [source, target] = mountFor(mounts, path);
  await mkdir(dirname(source + path.slice(target.length)), { recursive: true });
  await writeFile(source + path.slice(target.length), text);
}

test('Docker mode is a project setting that every active column carries, kept by Hands-off and in backups; Gemini is refused', async t => {
  const dataDir = await temp(t, 'pb-sandbox-setting-'), board = new Board({ dataDir });
  const project = await board.createProject({ name: 'Setting', workflowMode: 'pipeline' });
  const now = async () => (await board.state()).projects[0];
  // Old projects and projects that never chose it run on this computer.
  assert.equal(effectiveWorkflow(await now(), null).executing.sandbox, undefined);
  await board.setExecutionPolicy(project.id, { policy: { sandbox: 'docker', interaction: 'autonomous' }, expectedRevision: (await now()).revision });
  const workflow = effectiveWorkflow(await now(), null);
  assert.equal((await now()).execution.sandbox, 'docker');
  assert.equal(workflow.executing.sandbox, 'docker'); assert.equal(workflow.planning.sandbox, 'docker');
  assert.equal(workflow.todo.sandbox, undefined, 'To Do and Done run no agent.');
  assert.equal(resolveConfig('executing', workflow.executing).sandbox, 'docker', 'The run configuration keeps it.');
  assert.equal(resolveConfig('executing', { provider: 'claude' }).sandbox, undefined);
  assert.throws(() => normalizeExecutionPolicy({ sandbox: 'podman' }), /Choose a supported place to run agents/);
  assert.throws(() => resolveConfig('executing', { provider: 'gemini', sandbox: 'docker' }), { code: 'SANDBOX_PROVIDER_UNSUPPORTED', message: 'Docker mode supports Claude Code and Codex.' });
  // Saving is refused while a column would launch Gemini in Docker.
  const config = defaultPipelineConfig(); config.columns.find(column => column.id === 'testing').strategy.agentOverride = 'gemini';
  await assert.rejects(board.setPipeline(project.id, { pipeline: config, expectedRevision: (await now()).revision }), { message: 'Docker mode supports Claude Code and Codex.' });
  await board.setExecutionPolicy(project.id, { policy: {}, expectedRevision: (await now()).revision });
  await board.setPipeline(project.id, { pipeline: config, expectedRevision: (await now()).revision });
  await assert.rejects(board.setExecutionPolicy(project.id, { policy: { sandbox: 'docker' }, expectedRevision: (await now()).revision }), { code: 'SANDBOX_PROVIDER_UNSUPPORTED', message: 'Docker mode supports Claude Code and Codex.' });
  await board.setPipeline(project.id, { pipeline: defaultPipelineConfig(), expectedRevision: (await now()).revision });
  await board.setExecutionPolicy(project.id, { policy: { sandbox: 'docker' }, expectedRevision: (await now()).revision });
  // The Hands-off preset changes how agents work, not where they run.
  await board.applyFullAutopilot(project.id, { expectedRevision: (await now()).revision, confirm: true });
  assert.deepEqual([(await now()).execution.sandbox, (await now()).execution.interaction], ['docker', 'autonomous']);
  assert.equal((await board.exportBackup()).projects[0].execution.sandbox, 'docker', 'A backup carries the project setting.');
});

test('the container sees only the worktree, its Git data, the run folder and Promptboard’s code, at the paths used on this computer', { skip }, () => {
  const at = (path, real = path) => ({ path, real });
  const places = { workspace: at('/data/worktrees/p/t'), gitDir: at('/repo/.git/worktrees/t'), commonDir: at('/repo/.git'), runDir: at('/data/runs/r1'), home: at('/data/runs/r1/sandbox-home'),
    app: at(APP_DIR), codexAuth: at('/home/me/.codex/auth.json') };
  const args = dockerRunArgs({ runId: 'r1', label: 'abc', user: '501:20', workdir: places.workspace.path, mounts: sandboxMounts(places), image: 'promptboard-sandbox:1', command: 'codex',
    args: ['--sandbox', 'danger-full-access', '--', 'Do it'], names: ['TERM', 'PROMPTBOARD_RUN'], values: { HOME: '/data/runs/r1/sandbox-home', CODEX_HOME: '/data/runs/r1/sandbox-home/codex' } });
  assert.deepEqual(args.slice(0, 11), ['run', '--rm', '-it', '--init', '--name', 'pb-run-r1', '--label', 'promptboard.run=r1', '--label', 'promptboard.data=abc', '--user']);
  assert.equal(args[args.indexOf('-w') + 1], places.workspace.path);
  const gitFile = name => `/repo/.git/worktrees/t/${name}:/repo/.git/worktrees/t/${name}:ro`;
  assert.deepEqual(values(args, '-v'), ['/data/worktrees/p/t:/data/worktrees/p/t', '/data/worktrees/p/t/.git:/data/worktrees/p/t/.git:ro', '/repo/.git:/repo/.git:ro', '/repo/.git/objects:/repo/.git/objects',
    '/repo/.git/worktrees/t:/repo/.git/worktrees/t', gitFile('commondir'), gitFile('gitdir'), gitFile('HEAD'), gitFile('config.worktree'),
    '/data/runs/r1:/data/runs/r1', `${APP_DIR}:${APP_DIR}:ro`, '/home/me/.codex/auth.json:/data/runs/r1/sandbox-home/codex/auth.json:ro']);
  // Settings and secrets pass by name; only the container's own folders are written out.
  assert.deepEqual(values(args, '-e'), ['TERM', 'PROMPTBOARD_RUN', 'HOME=/data/runs/r1/sandbox-home', 'CODEX_HOME=/data/runs/r1/sandbox-home/codex']);
  assert.deepEqual(args.slice(args.indexOf('promptboard-sandbox:1')), ['promptboard-sandbox:1', 'codex', '--sandbox', 'danger-full-access', '--', 'Do it']);
  // A read-only stage cannot change the worktree or Git data; a resumed conversation mounts its first run's CLI home.
  const readOnly = values(dockerRunArgs({ runId: 'r1', label: 'abc', user: '501:20', workdir: '/w', mounts: sandboxMounts({ ...places, readOnly: true, home: at('/data/runs/r0/sandbox-home'), codexAuth: null }), image: 'i', command: 'codex', args: [], names: [], values: {} }), '-v');
  assert.deepEqual(readOnly, ['/data/worktrees/p/t:/data/worktrees/p/t:ro', '/data/worktrees/p/t/.git:/data/worktrees/p/t/.git:ro', '/repo/.git:/repo/.git:ro', '/repo/.git/objects:/repo/.git/objects:ro',
    '/repo/.git/worktrees/t:/repo/.git/worktrees/t:ro', gitFile('commondir'), gitFile('gitdir'), gitFile('HEAD'), gitFile('config.worktree'),
    '/data/runs/r1:/data/runs/r1', '/data/runs/r0/sandbox-home:/data/runs/r0/sandbox-home', `${APP_DIR}:${APP_DIR}:ro`]);
  // Under a symbolic link, the source is the real folder and the path inside keeps the spelling Promptboard uses.
  assert.deepEqual(sandboxMounts({ ...places, runDir: at('/link/runs/r1', '/real/runs/r1'), home: at('/link/runs/r1/sandbox-home', '/real/runs/r1/sandbox-home') }).find(([, target]) => target === '/link/runs/r1'), ['/real/runs/r1', '/link/runs/r1', false]);
});

test('inside the container Codex runs with its own sandbox off, and strict read-only stages are marked read-only', async t => {
  const runDir = await temp(t, 'pb-sandbox-args-');
  const build = async (provider, stage, extra = {}) => (await buildSession({ provider, stage, config: resolveConfig(stage, { provider, pipeline: true, stageEngine: true, sandbox: 'docker', ...extra }), message: '--sandbox read-only',
    runDir, eventsFile: join(runDir, 'events.jsonl'), sessionId: 's1', nodePath: 'node', ...(extra.resumeId ? { resumeId: extra.resumeId, workspacePath: '/w' } : {}) })).args;
  const codexPlan = containerSession('codex', await build('codex', 'planning'));
  assert.equal(codexPlan.readOnly, true);
  assert.deepEqual(codexPlan.args.slice(codexPlan.args.indexOf('--sandbox'), codexPlan.args.indexOf('--sandbox') + 2), ['--sandbox', 'danger-full-access']);
  assert.deepEqual(codexPlan.args.slice(-2), ['--', '--sandbox read-only'], 'The task text is never rewritten.');
  const codexWork = containerSession('codex', await build('codex', 'executing', { filesystem: 'workspace_write' }));
  assert.equal(codexWork.readOnly, false); assert.ok(codexWork.args.includes('danger-full-access'));
  assert.ok(codexWork.args.some(arg => arg.startsWith('notify=["node",')), 'The notify hook uses the image’s node.');
  const resumed = containerSession('codex', await build('codex', 'executing', { resumeId: 'thread-1' }));
  assert.deepEqual(resumed.args.slice(0, 4), ['resume', 'thread-1', '--cd', '/w']); assert.ok(resumed.args.includes('danger-full-access'));
  const claudePlan = containerSession('claude', await build('claude', 'planning')), claudeWork = containerSession('claude', await build('claude', 'executing'));
  assert.deepEqual([claudePlan.readOnly, claudeWork.readOnly], [true, false]);
  assert.equal(JSON.parse(claudeWork.args[claudeWork.args.indexOf('--settings') + 1]).hooks.Stop[0].hooks[0].command, 'node');
});

test('a resumed conversation keeps the CLI home of the run that started it', () => {
  const runs = [{ id: 'a', artifactsDir: join('runs', 'a') }, { id: 'b', artifactsDir: join('runs', 'b'), resumeFrom: { runId: 'a' } }, { id: 'c', artifactsDir: join('runs', 'c'), resumeFrom: { runId: 'b' } }];
  assert.equal(conversationHome('/data', runs, runs[2]), join('/data', 'runs', 'a', 'sandbox-home'));
  assert.equal(conversationHome('/data', runs, runs[0]), join('/data', 'runs', 'a', 'sandbox-home'));
  assert.equal(conversationHome('/data', [{ id: 'x', artifactsDir: join('runs', 'x'), resumeFrom: { runId: 'x' } }], { id: 'x', artifactsDir: join('runs', 'x'), resumeFrom: { runId: 'x' } }), join('/data', 'runs', 'x', 'sandbox-home'), 'A loop ends.');
});

test('every preflight failure has its own code and plain message, and the card returns without running anything on this computer', { skip, timeout: 120000 }, async t => {
  const docker = await fakes(t), w = await boxed(t);
  const worktree = async () => {
    const path = join(await temp(t, 'pb-sandbox-wt-'), 'wt');
    git(w.root, 'worktree', 'add', '-q', '-b', `check-${Date.now()}`, path, 'trunk');
    return realpath(path);
  };
  const runDir = join(w.dataDir, 'runs', 'p1'); await mkdir(runDir, { recursive: true });
  const prepare = async (provider, workspacePath = '/nowhere') => {
    const run = { id: 'p1', artifactsDir: join('runs', 'p1'), workspacePath, config: { provider, sandbox: 'docker' } };
    return w.sandbox.prepare({ run, runs: [run], runDir, built: { args: ['--', 'x'], env: { TERM: 'xterm-256color' } } });
  };
  const refused = (promise, code, message) => assert.rejects(promise, error => error.code === code && (message instanceof RegExp ? message.test(error.message) : error.message === message));
  setEnv(t, 'FAKE_DOCKER_STOPPED', '1');
  await refused(prepare('codex'), 'SANDBOX_DOCKER_STOPPED', 'Docker is installed but not running. Start it (for Colima: colima start), then try again.');
  setEnv(t, 'FAKE_DOCKER_STOPPED', undefined);
  await refused(prepare('codex'), 'SANDBOX_IMAGE_MISSING', /not built yet\. Build it in Settings → Docker sandbox/);
  await docker.setState({ images: [w.image] });
  await refused(prepare('claude'), 'SANDBOX_SIGNIN_MISSING', /run claude setup-token|Run claude setup-token/);
  await rm(join(w.codexHome, 'auth.json'));
  await refused(prepare('codex'), 'SANDBOX_SIGNIN_MISSING', /Codex is not signed in on this computer\. Run codex login/);
  await writeFile(join(w.codexHome, 'auth.json'), '{}');
  const path = await worktree();
  setEnv(t, 'FAKE_DOCKER_HIDE', join(path, '.git'));
  await refused(prepare('codex', path), 'SANDBOX_MOUNT_HIDDEN', `Docker cannot see this folder (${path}). Share it with your Docker machine.`);
  setEnv(t, 'FAKE_DOCKER_HIDE', undefined); setEnv(t, 'FAKE_DOCKER_CHECK_FAIL', '1');
  await refused(prepare('codex', path), 'SANDBOX_START_FAILED', /Docker could not start a container/);
  setEnv(t, 'FAKE_DOCKER_CHECK_FAIL', undefined);
  const launch = await prepare('codex', path);
  assert.equal(launch.command, join(docker.bin, 'docker'));
  // The folder check ran the real check script: each folder once, then it is remembered for this worktree.
  const checks = () => docker.calls().then(calls => calls.filter(call => call.args[0] === 'run' && call.args.includes('sh')).length);
  const before = await checks(); await prepare('codex', path); assert.equal(await checks(), before);
  // Docker missing: no docker command on PATH at all (only node's own folder is left).
  const withDocker = process.env.PATH;
  setEnv(t, 'PATH', dirname(process.execPath));
  await refused(prepare('codex', path), 'SANDBOX_DOCKER_MISSING', /Docker is not installed/);
  setEnv(t, 'PATH', withDocker);
  // Through the board: the run fails to start, the card goes back to To Do, and no CLI ran on this computer.
  await docker.setState({ images: [] });
  const run = await w.start('Needs the image', 'WRITE_FILE:host.txt');
  const failed = await until(async () => { const value = await w.run(run.id); return value.status === 'failed' && value; }, 'failed start');
  assert.equal(failed.errorCode, 'SANDBOX_IMAGE_MISSING'); assert.match(failed.reason, /Build it in Settings → Docker sandbox/);
  await until(async () => (await w.now()).tasks.find(task => task.id === failed.taskId).column === 'todo', 'card back in To Do');
  assert.deepEqual(await docker.agents(), [], 'No CLI ran, on this computer or in a container.');
});

test('a Codex card in Docker runs through the docker client: hooks run there, usage comes from its own Codex home, and pause, resume and stop keep working', { skip, timeout: 120000 }, async t => {
  const docker = await fakes(t), w = await boxed(t);
  await docker.setState({ images: [w.image] });
  const run = await w.start('Boxed edit', 'USAGE WRITE_FILE:inside.txt');
  const done = await until(async () => { const value = await w.run(run.id); return value.turnComplete && value; }, 'turn complete through the hook');
  const [call] = runCalls(await docker.calls());
  const home = join(w.dataDir, 'runs', run.id, 'sandbox-home');
  assert.equal(values(call.args, '--name')[0], `pb-run-${run.id}`);
  assert.deepEqual(values(call.args, '-v').filter(mount => mount.startsWith(run.workspacePath)), [`${run.workspacePath}:${run.workspacePath}`, `${join(run.workspacePath, '.git')}:${join(run.workspacePath, '.git')}:ro`]);
  assert.ok(values(call.args, '-v').includes(`${join(w.codexHome, 'auth.json')}:${join(home, 'codex', 'auth.json')}:ro`), 'The sign-in is mounted read-only, never copied.');
  assert.ok(values(call.args, '-e').includes(`CODEX_HOME=${join(home, 'codex')}`));
  assert.ok(call.args.includes('danger-full-access') && !call.args.some(arg => /dangerously/.test(arg)));
  assert.equal(await readFile(join(run.workspacePath, 'inside.txt'), 'utf8'), 'written by the agent\n', 'The agent’s edit is visible on this computer.');
  assert.equal(await readFile(join(home, 'codex', 'auth.json'), 'utf8'), '', 'Only an empty mount point is in the run folder.');
  assert.deepEqual([done.usage.inputTokens, done.usage.cachedTokens, done.usage.outputTokens, done.usage.model], [8000, 7000, 100, 'gpt-test'], 'Usage is read from the conversation’s own Codex home.');
  assert.deepEqual((await docker.agents()).map(agent => agent.cwd), [run.workspacePath]);
  // Typing in the terminal reaches the CLI inside the container.
  w.board.executor.input(run.id, 'one more thing\r');
  await until(async () => (await w.run(run.id)).turns === 2, 'a second turn from terminal input');
  assert.match(await w.board.executor.artifact(run.id, 'output'), /you said: one more thing/);
  // Pause removes the container; Resume continues the same Codex thread with the first run's home.
  await w.board.pauseRun(run.id, { confirm: true });
  await until(async () => (await docker.calls()).some(item => item.args.join(' ') === `rm -f pb-run-${run.id}`), 'Pausing removes the container, not only the docker client.');
  const resumed = await w.board.resumeTask(run.taskId, { consent: true, message: 'continue please' });
  await until(async () => (await w.run(resumed.id)).turnComplete, 'resumed turn');
  const second = runCalls(await docker.calls()).at(-1).args;
  assert.deepEqual(second.slice(second.indexOf('codex'), second.indexOf('codex') + 5), ['codex', 'resume', 'thread-1', '--cd', run.workspacePath]);
  assert.ok(values(second, '-v').includes(`${home}:${home}`) && values(second, '-e').includes(`HOME=${home}`));
  await w.board.executor.cancel(resumed.id);
  await until(async () => (await docker.calls()).some(item => item.args.join(' ') === `rm -f pb-run-${resumed.id}`), 'Stop removes the container');
  assert.equal((await w.run(resumed.id)).status, 'cancelled');
});

test('Claude Code in Docker gets the saved token by name only: never in argv, state, backups, logs or replies', { skip, timeout: 120000 }, async t => {
  const docker = await fakes(t), w = await boxed(t, { provider: 'claude', server: true });
  await docker.setState({ images: [w.image] });
  const token = (await (await fetch(`${w.app.url}/api/session`)).json()).token;
  const call = async (method, path, body) => { const response = await fetch(`${w.app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, text: await response.text() }; };
  const refused = await call('PUT', '/api/sandbox/claude-token', { token: 'has spaces in it, so it is not a token' });
  assert.equal(refused.status, 409); assert.match(refused.text, /Paste the whole token/);
  const saved = await call('PUT', '/api/sandbox/claude-token', { token: TOKEN });
  assert.equal(saved.status, 200); assert.equal(JSON.parse(saved.text).sandbox.signIn.claude, true); assert.ok(!saved.text.includes(TOKEN));
  const file = join(w.dataDir, 'sandbox', 'claude-token');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const run = await w.start('Boxed Claude', 'WRITE_FILE:claude.txt');
  await until(async () => (await w.run(run.id)).turnComplete, 'Claude turn in Docker');
  const [launch] = runCalls(await docker.calls());
  assert.equal(launch.token, TOKEN, 'The docker client has the token in its environment.');
  assert.ok(!launch.args.some(arg => arg.includes(TOKEN)), 'The token is not in argv.');
  assert.ok(values(launch.args, '-e').includes('CLAUDE_CODE_OAUTH_TOKEN'));
  const home = join(w.dataDir, 'runs', run.id, 'sandbox-home');
  assert.ok(values(launch.args, '-e').includes(`CLAUDE_CONFIG_DIR=${join(home, 'claude')}`));
  assert.equal(JSON.parse(await readFile(join(home, 'claude', '.claude.json'), 'utf8')).hasCompletedOnboarding, true, 'First-run setup is skipped.');
  for (const [path, label] of [['/api/sandbox', 'status'], ['/api/board', 'board'], ['/api/board/export', 'backup']]) assert.ok(!(await call('GET', path)).text.includes(TOKEN), label);
  assert.ok(!(await readFile(join(w.dataDir, 'state.json'), 'utf8')).includes(TOKEN), 'state.json');
  for (const name of await readdir(join(w.dataDir, 'runs', run.id))) if (name.includes('.')) assert.ok(!(await readFile(join(w.dataDir, 'runs', run.id, name), 'utf8')).includes(TOKEN), name);
  const removed = await call('DELETE', '/api/sandbox/claude-token');
  assert.equal(JSON.parse(removed.text).sandbox.signIn.claude, false);
  await assert.rejects(stat(file), { code: 'ENOENT' });
});

test('startup and shutdown remove only this data folder’s containers; a folder that never used Docker makes no docker call', { skip, timeout: 60000 }, async t => {
  const docker = await fakes(t);
  const fresh = await temp(t, 'pb-sandbox-fresh-');
  const app = await startServer({ port: 0, dataDir: fresh, detector: async () => [] });
  await app.close();
  assert.deepEqual(await docker.calls(), [], 'Never used here: no docker call at startup or shutdown.');
  const used = await temp(t, 'pb-sandbox-used-');
  await mkdir(join(used, 'sandbox'));
  await docker.setState({ containers: ['left-1', 'left-2'] });
  const label = new Sandbox({ dataDir: used }).label;
  const second = await startServer({ port: 0, dataDir: used, detector: async () => [] });
  await until(async () => (await docker.dockerState()).containers.length === 0, 'startup sweep');
  const calls = (await docker.calls()).map(call => call.args.join(' '));
  assert.deepEqual(calls, [`ps -aq --filter label=promptboard.data=${label}`, 'rm -f left-1 left-2']);
  await docker.setState({ containers: ['crashed-run'] });
  await second.close();
  assert.equal((await docker.calls()).at(-1).args.join(' '), 'rm -f crashed-run', 'Shutdown sweeps again.');
});

test('Build image streams progress, can be cancelled, tags the image with this computer’s CLI versions and replaces older images', { skip, timeout: 60000 }, async t => {
  const docker = await fakes(t), dataDir = await temp(t, 'pb-sandbox-build-'), sandbox = new Sandbox({ dataDir });
  const { name, versions } = await sandbox.defaultImage();
  assert.deepEqual(versions, { claude: '9.8.7', codex: '9.8.7' }); assert.match(name, /^promptboard-sandbox:[a-f0-9]{12}$/);
  await docker.setState({ images: ['promptboard-sandbox:older', 'someone-else:1'] });
  setEnv(t, 'FAKE_DOCKER_BUILD_MS', '400');
  assert.equal((await sandbox.startBuild()).status, 'running');
  await assert.rejects(sandbox.startBuild(), { code: 'SANDBOX_BUILD_RUNNING' });
  await until(() => sandbox.buildStatus().lines.some(line => line.startsWith('Step 2/3')), 'streamed progress');
  await until(() => sandbox.buildStatus().status === 'succeeded', 'build finished');
  const build = (await docker.calls()).find(call => call.args[0] === 'build').args;
  assert.deepEqual(values(build, '--build-arg'), ['CLAUDE_CODE_VERSION=9.8.7', 'CODEX_VERSION=9.8.7']);
  assert.equal(values(build, '-t')[0], name);
  await until(async () => !(await docker.dockerState()).images.includes('promptboard-sandbox:older'), 'older image removed');
  assert.deepEqual((await docker.dockerState()).images.sort(), [name, 'someone-else:1'].sort(), 'Only Promptboard’s own older images go.');
  assert.equal((await sandbox.status()).image.ready, true);
  // Cancel stops a running build; a failed build keeps its last lines.
  setEnv(t, 'FAKE_DOCKER_BUILD_MS', '5000');
  await sandbox.startBuild(); await until(() => sandbox.buildStatus().lines.length, 'first line');
  sandbox.cancelBuild();
  await until(() => sandbox.buildStatus().status === 'cancelled', 'cancelled');
  setEnv(t, 'FAKE_DOCKER_BUILD_MS', '0'); setEnv(t, 'FAKE_DOCKER_BUILD_FAIL', '1');
  await sandbox.startBuild();
  await until(() => sandbox.buildStatus().status === 'failed', 'failed');
  assert.ok(sandbox.buildStatus().lines.includes('npm ERR! network unavailable'));
});

test('Build image is claimed at once: a second request while Docker is checked is refused, and Cancel then means no docker build', { skip, timeout: 60000 }, async t => {
  const docker = await fakes(t), sandbox = new Sandbox({ dataDir: await temp(t, 'pb-sandbox-claim-') });
  const builds = async () => (await docker.calls()).filter(call => call.args[0] === 'build').length;
  setEnv(t, 'FAKE_DOCKER_BUILD_MS', '400');
  const both = await Promise.allSettled([sandbox.startBuild(), sandbox.startBuild()]);
  assert.deepEqual(both.map(item => item.value?.status ?? item.reason.code), ['running', 'SANDBOX_BUILD_RUNNING']);
  await until(() => sandbox.buildStatus().status === 'succeeded', 'build finished');
  assert.equal(await builds(), 1);
  // Cancel before the checks are done: docker build never starts.
  const starting = sandbox.startBuild();
  assert.equal(sandbox.cancelBuild().status, 'cancelled');
  assert.equal((await starting).status, 'cancelled');
  assert.equal(await builds(), 1);
  // A failed check gives the claim back.
  setEnv(t, 'FAKE_DOCKER_STOPPED', '1');
  await assert.rejects(sandbox.startBuild(), { code: 'SANDBOX_DOCKER_STOPPED' });
  assert.equal(sandbox.buildStatus().status, 'cancelled');
});

test('the Docker status says what is missing, and an image of your own replaces Promptboard’s', { skip, timeout: 60000 }, async t => {
  const docker = await fakes(t), dataDir = await temp(t, 'pb-sandbox-status-'), codexHome = await temp(t, 'pb-sandbox-status-codex-');
  const sandbox = new Sandbox({ dataDir, codexHome });
  assert.deepEqual(await sandbox.status().then(s => [s.docker, s.image.ready, s.image.custom, s.signIn, s.build.status]), ['running', false, false, { claude: false, codex: false }, 'idle']);
  setEnv(t, 'FAKE_DOCKER_STOPPED', '1');
  assert.equal((await sandbox.status()).docker, 'stopped');
  setEnv(t, 'FAKE_DOCKER_STOPPED', undefined);
  await assert.rejects(sandbox.setImage('--privileged'), { code: 'SANDBOX_INVALID_IMAGE' });
  await sandbox.setImage('my-tools/sandbox:2');
  await docker.setState({ images: ['my-tools/sandbox:2'] });
  assert.deepEqual((await sandbox.status()).image, { name: 'my-tools/sandbox:2', custom: true, ready: true });
  await sandbox.setImage('');
  assert.equal((await sandbox.status()).image.custom, false);
  setEnv(t, 'PATH', dirname(process.execPath));
  assert.equal((await sandbox.status()).docker, 'missing');
});

test('in Docker a Planning card gets a read-only worktree, and Workspace trust still answers the CLI’s folder-trust menu', { skip, timeout: 120000 }, async t => {
  const docker = await fakes(t), w = await boxed(t);
  await docker.setState({ images: [w.image] });
  await w.board.setExecutionPolicy(w.project.id, { policy: { sandbox: 'docker', workspaceTrust: 'task_workspaces' }, expectedRevision: (await w.now()).revision });
  const run = await w.start('Boxed plan', 'TRUST_SCREEN Plan the cart page.', 'planning');
  const planned = await until(async () => { const value = await w.run(run.id); return value.turnComplete && value; }, 'planned after the trust menu');
  assert.equal(planned.hasPlan, true);
  assert.match(await w.board.executor.artifact(run.id, 'output'), /Trust this folder\?[\s\S]*trusted/, 'The menu named the worktree and was answered.');
  const args = runCalls(await docker.calls())[0].args;
  assert.ok(values(args, '-v').includes(`${run.workspacePath}:${run.workspacePath}:ro`), 'The worktree is read-only for Planning.');
  assert.ok(values(args, '-v').filter(mount => mount.includes('.git')).every(mount => mount.endsWith(':ro')), 'So is all Git data.');
  assert.deepEqual(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 4), ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never']);
});

test('a paused conversation continues only where it started: after Docker mode is turned on, the next column starts fresh in Docker', { skip, timeout: 120000 }, async t => {
  const docker = await fakes(t), w = await boxed(t);
  await docker.setState({ images: [w.image] });
  const config = customPipelineConfig();
  for (const column of config.columns.filter(item => item.role === 'active')) column.strategy.agentOverride = 'codex';
  await w.board.setExecutionPolicy(w.project.id, { policy: {}, expectedRevision: (await w.now()).revision });
  await w.board.setPipeline(w.project.id, { pipeline: config, expectedRevision: (await w.now()).revision });
  const first = await w.start('Moves into Docker', 'Change the cart.');
  await until(async () => (await w.run(first.id)).turnComplete, 'first turn on this computer');
  assert.deepEqual(runCalls(await docker.calls()), [], 'Docker mode was off.');
  await w.board.pauseRun(first.id, { confirm: true });
  await w.board.setExecutionPolicy(w.project.id, { policy: { sandbox: 'docker' }, expectedRevision: (await w.now()).revision });
  const task = (await w.now()).tasks.find(item => item.id === first.taskId);
  const next = (await w.board.transition(task.id, { column: 'code_review', expectedRevision: task.revision })).run;
  assert.equal(next.resumeFrom, undefined, 'The conversation kept on this computer is not resumed in Docker.');
  await until(async () => runCalls(await docker.calls()).length === 1, 'a fresh run in Docker');
  assert.ok(!runCalls(await docker.calls())[0].args.includes('resume'));
});

test('an agent in Docker cannot point Git at settings of its own: every file that redirects Git is read-only, checked with real Git', { skip, timeout: 120000 }, async t => {
  const docker = await fakes(t), w = await boxed(t);
  await docker.setState({ images: [w.image] });
  const task = await w.board.createTask({ projectId: w.project.id, title: 'Redirect', prompt: 'x' });
  const ws = await w.board.ensureTaskWorktree(task.id);
  // Commits and a reset on this computer leave the per-worktree files Git normally keeps (index, logs, ORIG_HEAD).
  await writeFile(join(ws.path, 'one.txt'), '1\n'); git(ws.path, 'add', '.'); git(ws.path, 'commit', '-qm', 'one'); git(ws.path, 'reset', '-q', '--soft', 'HEAD~1'); git(ws.path, 'commit', '-qm', 'again');
  const runDir = join(w.dataDir, 'runs', 'redirect'); await mkdir(runDir, { recursive: true });
  const run = { id: 'redirect', artifactsDir: join('runs', 'redirect'), workspacePath: ws.path, config: { provider: 'codex', sandbox: 'docker' } };
  const mounts = mountsOf((await w.sandbox.prepare({ run, runs: [run], runDir, built: { args: ['--sandbox', 'workspace-write', '--', 'x'], env: { TERM: 'xterm-256color' } } })).args);
  const gitDir = git(ws.path, 'rev-parse', '--path-format=absolute', '--git-dir'), commonDir = git(ws.path, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  // Every entry of the worktree's own Git folder is either protected or plain data; a new kind of file needs a decision.
  const DATA = ['index', 'logs', 'ORIG_HEAD', 'COMMIT_EDITMSG', 'FETCH_HEAD', 'MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE', 'AUTO_MERGE', 'refs'];
  for (const name of await readdir(gitDir)) {
    if (PROTECTED_GIT_FILES.includes(name)) assert.equal(writable(mounts, join(gitDir, name)), false, name);
    else assert.ok(DATA.includes(name), `${name} in the worktree's Git folder is neither protected nor known data`);
  }
  assert.equal(await readFile(join(gitDir, 'config.worktree'), 'utf8'), '', 'A missing config.worktree is created empty, so it can be protected.');
  // What tells Git where its settings, hooks and branches are, or which branch the worktree is on, is read-only inside.
  for (const path of [join(ws.path, '.git'), ...PROTECTED_GIT_FILES.map(name => join(gitDir, name)), join(commonDir, 'config'), join(commonDir, 'hooks', 'pre-commit'),
    join(commonDir, 'info', 'attributes'), join(commonDir, 'refs', 'heads', 'trunk'), join(commonDir, 'packed-refs'), join(commonDir, 'worktrees', 'other', 'commondir')]) assert.equal(writable(mounts, path), false, path);
  // Staging stays possible: the files, the index (and its lock), logs and objects.
  for (const path of [join(ws.path, 'src', 'app.js'), join(gitDir, 'index'), join(gitDir, 'index.lock'), join(gitDir, 'logs', 'HEAD'), join(commonDir, 'objects', 'ab', 'cdef')]) assert.equal(writable(mounts, path), true, path);
  // Nothing else of this computer is visible: not the board, other runs, the main checkout or the Codex settings.
  for (const path of [join(w.dataDir, 'state.json'), join(w.dataDir, 'runs', 'other'), join(w.root, 'README.md'), join(w.codexHome, 'config.toml')]) assert.equal(mountFor(mounts, path), undefined, path);
  // The attack: a Git folder of the agent's own, whose fsmonitor is a command, and commondir pointed at it.
  const marker = join(await temp(t, 'pb-sandbox-marker-'), 'ran'), evil = join(ws.path, 'evil');
  git(ws.path, 'init', '-q', '--bare', evil); git(ws.path, '--git-dir', evil, 'config', 'core.bare', 'false'); git(ws.path, '--git-dir', evil, 'config', 'core.fsmonitor', `touch '${marker}'; false`);
  const attack = async view => {
    await rm(marker, { force: true });
    await containerWrite(view, join(gitDir, 'commondir'), `${evil}\n`).catch(error => { if (error.code !== 'EROFS') throw error; });
    await hostGit(['status', '--porcelain'], { cwd: ws.path }).catch(() => {}); // As Promptboard's next checkpoint does.
    const ran = await exists(marker);
    await writeFile(join(gitDir, 'commondir'), '../..\n');
    return ran;
  };
  assert.equal(await attack(mounts), false, 'commondir is read-only, so nothing of the agent’s runs on this computer.');
  assert.equal(await attack(mounts.filter(([, target]) => !PROTECTED_GIT_FILES.some(name => target === join(gitDir, name)))), true, 'With the earlier mounts the same attack runs the agent’s command.');
});

test('a Git repository the agent makes in its Docker workspace stops Promptboard’s own Git there, so its settings never run on this computer', { skip, timeout: 120000 }, async t => {
  const docker = await fakes(t), w = await boxed(t);
  await docker.setState({ images: [w.image] });
  const run = await w.start('Nested', 'WRITE_FILE:work.txt');
  await until(async () => (await w.run(run.id)).turnComplete, 'turn in Docker');
  await w.board.pauseRun(run.id, { confirm: true });
  // What the agent can make with the files it may write: a repository with a hostile fsmonitor, staged like a submodule.
  const marker = join(await temp(t, 'pb-sandbox-marker-'), 'ran'), nested = join(run.workspacePath, 'vendor', 'tool');
  git(run.workspacePath, 'init', '-q', nested); git(nested, '-c', 'user.email=a@b', '-c', 'user.name=A', 'commit', '-q', '--allow-empty', '-m', 'x');
  git(nested, 'config', 'core.fsmonitor', `touch '${marker}'; false`); await writeFile(join(nested, 'file.txt'), 'x\n');
  assert.deepEqual(await nestedRepositories(run.workspacePath), ['vendor/tool'], 'An untracked repository is found without running anything in it.');
  const refused = { code: 'NESTED_REPOSITORY', message: /^The agent made a Git repository inside this card’s workspace \(vendor\/tool\)\./ };
  for (const action of [() => w.board.delivery.revision(run.taskId), () => w.board.delivery.uncommitted(run.taskId), () => w.board.delivery.commit(run.taskId, { message: 'x', confirm: true }), () => w.board.removeTaskWorktree(run.taskId)])
    await assert.rejects(action(), refused);
  assert.equal(await exists(marker), false, 'None of the agent’s settings ran.');
  git(run.workspacePath, 'add', 'vendor/tool');
  assert.deepEqual(await nestedRepositories(run.workspacePath), ['vendor/tool'], 'Staged as a submodule, it is still found.');
  await assert.rejects(w.board.delivery.revision(run.taskId), refused);
  assert.equal(await exists(marker), false);
  git(run.workspacePath, 'status', '--porcelain');
  assert.equal(await exists(marker), true, 'Plain Git would have run the agent’s fsmonitor.');
  // A card that never ran in Docker is not checked: its agent could run commands here anyway.
  assert.equal(await nestedRepositoryProblem({ runs: [] }, run.taskId, run.workspacePath), '');
  // Once the repository is gone, Promptboard works again.
  git(run.workspacePath, 'restore', '--staged', 'vendor/tool'); await rm(nested, { recursive: true, force: true });
  assert.equal((await w.board.delivery.revision(run.taskId)).branchOk, true);
});

test('under a symlinked data folder every path the CLI is given is visible in the container at that same spelling', { skip, timeout: 120000 }, async t => {
  const docker = await fakes(t), w = await boxed(t, { link: true });
  await docker.setState({ images: [w.image] });
  const run = await w.start('Linked', 'WRITE_FILE:linked.txt');
  await until(async () => (await w.run(run.id)).turnComplete, 'turn complete under a linked data folder');
  const args = runCalls(await docker.calls())[0].args, mounts = mountsOf(args), cli = args.slice(args.indexOf(w.image) + 2);
  const notify = JSON.parse(cli[cli.indexOf('-c') + 1].slice('notify='.length));
  const paths = [args[args.indexOf('-w') + 1], ...notify.slice(1, 3), ...values(args, '-e').filter(value => value.includes('=')).map(value => value.slice(value.indexOf('=') + 1))];
  assert.ok(paths.some(path => path.startsWith(w.dataDir + sep)), 'The hooks and homes use the data folder as Promptboard spells it.');
  for (const path of paths) assert.ok(mountFor(mounts, path), `${path} is visible inside the container`);
  assert.equal(args[args.indexOf('-w') + 1], run.workspacePath, '-w and codex --cd use the stored worktree path.');
  assert.ok(mountsOf(args).some(([source, target]) => target === join(w.dataDir, 'runs', run.id) && source === join(realpathSyncOf(w.dataDir), 'runs', run.id)), 'The run folder is mounted from its real path.');
});
