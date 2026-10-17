import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectCommands, openProject, readmeRunSection, runInfo } from '../src/project-run.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
const files = map => ({ names: new Set(Object.keys(map)), read: async name => map[name] ?? '' });

test('start commands come from the project’s own files, in the order a person runs them', async () => {
  const pkg = JSON.stringify({ scripts: { dev: 'vite', test: 'vitest' }, dependencies: { react: '19' } });
  assert.deepEqual((await detectCommands(files({ 'package.json': pkg }))).map(entry => entry.command), ['npm install', 'npm run dev', 'npm test']);
  assert.deepEqual((await detectCommands(files({ 'package.json': pkg, 'pnpm-lock.yaml': '' }))).map(entry => entry.command), ['pnpm install', 'pnpm run dev', 'pnpm run test']);
  assert.deepEqual((await detectCommands(files({ 'package.json': JSON.stringify({ scripts: { start: 'node server.js', test: 'echo "Error: no test specified" && exit 1' } }) }))).map(entry => entry.command), ['npm start']);
  assert.deepEqual((await detectCommands(files({ 'package.json': JSON.stringify({ main: 'index.js' }) }))).map(entry => entry.command), ['node index.js']);
  assert.deepEqual((await detectCommands(files({ 'requirements.txt': 'flask', 'app.py': '' }))).map(entry => entry.command), ['python3 -m pip install -r requirements.txt', 'python3 app.py']);
  assert.deepEqual((await detectCommands(files({ 'manage.py': '', 'pyproject.toml': '' }))).map(entry => entry.command), ['python3 -m pip install -e .', 'python3 manage.py runserver']);
  assert.deepEqual((await detectCommands(files({ 'go.mod': '', Makefile: 'build:\n\tgo build\nrun:\n\tgo run .\n', 'compose.yaml': '' }))).map(entry => entry.command), ['go run .', 'make run', 'docker compose up']);
  assert.deepEqual(await detectCommands(files({ 'package.json': '{ broken', 'README.md': '' })), [], 'a broken package.json suggests nothing');
});

test('the README’s run section is shown, shortened, under its own heading', () => {
  const readme = '# Shop\nA shop.\n\n## Getting started\n\n```sh\nnpm install\nnpm run dev\n```\n\n### Notes\nPort 5173.\n\n## License\nMIT\n';
  assert.deepEqual(readmeRunSection(readme), { heading: 'Getting started', text: '```sh\nnpm install\nnpm run dev\n```\n\n### Notes\nPort 5173.' });
  assert.equal(readmeRunSection('# Shop\nJust words.\n'), null);
});

test('files are read from the target branch, so a folder on another branch still gets the finished project’s commands', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pb-run-'))); t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'trunk'); git(root, 'config', 'user.email', 't@e'); git(root, 'config', 'user.name', 'T');
  await writeFile(join(root, 'README.md'), '# App\n\n## Run\nnpm start\n'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'init');
  git(root, 'branch', 'old');
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { start: 'node app.js' } })); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'app');
  git(root, 'switch', '-q', 'old');
  const info = await runInfo({ repository: { root, path: root }, targetBranch: { name: 'trunk' } });
  assert.deepEqual([info.path, info.target, info.folderBranch, info.onTarget], [root, 'trunk', 'old', false]);
  assert.deepEqual(info.commands.map(entry => entry.command), ['npm start']);
  assert.deepEqual(info.readme, { heading: 'Run', text: 'npm start' });
  assert.equal(info.staticSite, false);
  assert.deepEqual(await runInfo({ repository: null }), { linked: false });
});

test('opening uses the project’s own folder: Finder or a Terminal on macOS, Explorer on Windows, the file manager on Linux', async () => {
  const calls = [];
  const launch = (command, args, options) => { calls.push([command, args, options.shell]); const child = new EventEmitter(); child.unref = () => {}; setImmediate(() => child.emit('spawn')); return child; };
  const project = { repository: { root: '/work/app', path: '/work/app/web' } };
  await openProject(project, 'folder', { platform: 'darwin', launch });
  await openProject(project, 'terminal', { platform: 'darwin', launch });
  await openProject(project, 'folder', { platform: 'win32', launch });
  await openProject(project, 'index', { platform: 'linux', launch });
  assert.deepEqual(calls, [['open', ['/work/app/web'], false], ['open', ['-a', 'Terminal', '/work/app/web'], false], ['explorer.exe', ['/work/app/web'], false], ['xdg-open', ['/work/app/web/index.html'], false]]);
  await openProject({ repository: { root: 'C:\\work\\app' } }, 'index', { platform: 'win32', launch });
  assert.deepEqual(calls.at(-1), ['explorer.exe', ['C:\\work\\app\\index.html'], false], 'paths join the way the computer opening them writes them');
  await assert.rejects(openProject(project, 'terminal', { platform: 'win32', launch }), { code: 'OPEN_UNSUPPORTED' });
  await assert.rejects(openProject({ repository: null }, 'folder', { platform: 'darwin', launch }), { code: 'REPOSITORY_REQUIRED' });
});

test('the run-info and open routes use the stored project; the page cannot name a path', async t => {
  const opened = [];
  const app = await startTestServer(t, { port: 0, executor: null, projectOpener: async (project, target) => { opened.push([project.id, project.repository?.path, target]); return { opened: target }; } });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = (path, method = 'GET', body) => fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async r => ({ status: r.status, json: await r.json() }));
  const project = await app.board.createProject({ name: 'Plain' });
  assert.deepEqual((await call(`/api/projects/${project.id}/run-info`)).json.run.linked, false);
  const opened1 = await call(`/api/projects/${project.id}/open`, 'POST', { target: 'folder', path: '/etc' });
  assert.equal(opened1.status, 200);
  assert.deepEqual(opened, [[project.id, undefined, 'folder']], 'the path in the request is ignored');
  assert.equal((await call('/api/projects/nope/open', 'POST', { target: 'folder' })).status, 404);
  assert.equal(typeof (await (await fetch(`${app.url}/api/session`)).json()).platform, 'string');
});
