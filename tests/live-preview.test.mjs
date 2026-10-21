// Live preview with a fixture web project: a temporary Git repository whose dev server is a tiny Node HTTP server.
// No npm install and no real dev server run; setup is a fake command that makes node_modules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from '../src/board.mjs';
import { findAddress, lastErrorLine, LivePreviews, PREVIEW_LIMIT, previewSettings, suggestPreview } from '../src/live-preview.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
const exists = path => access(path).then(() => true, () => false);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function until(fn, label, ms = 20000) { const end = Date.now() + ms; for (;;) { const value = await fn(); if (value) return value; if (Date.now() > end) assert.fail(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 50)); } }

// print: listens on a port of its own and prints it in colour, as Vite does. quiet: listens on PORT and prints no address.
// hang: never listens. crash: exits with an error.
const SERVER = `const http = require('node:http');
const mode = process.argv[2] || 'print';
console.log('pid=' + process.pid + ' env PORT=' + process.env.PORT + ' HOST=' + process.env.HOST + ' BROWSER=' + process.env.BROWSER);
if (mode === 'crash') { console.error("Error: Cannot find module 'vite'"); console.log('npm notice: see the log'); process.exit(1); }
if (mode === 'hang') setInterval(() => {}, 1000);
if (mode === 'print' || mode === 'quiet') {
  const server = http.createServer((req, res) => res.end('preview ok'));
  server.listen(mode === 'quiet' ? Number(process.env.PORT) : 0, process.env.HOST, () => {
    if (mode === 'print') console.log('  Local:   \\x1b[36mhttp://127.0.0.1:\\x1b[1m' + server.address().port + '\\x1b[22m/\\x1b[39m');
  });
}
`;
const SETUP = `const fs = require('node:fs'); fs.mkdirSync('node_modules', { recursive: true }); fs.appendFileSync(process.argv[2], 'setup\\n'); console.log('installed');`;

async function world(t, options = {}) {
  const dirs = [];
  let board;
  // Previews end before their folders go (on Windows a folder in use cannot be deleted).
  t.after(async () => {
    if (board) await Promise.all([...board.previews.items.keys()].map(id => board.previews.stop(id)));
    for (const dir of dirs) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const temp = async prefix => { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); dirs.push(dir); return dir; };
  const root = await temp('pb-preview-repo-');
  git(root, 'init', '-q', '-b', 'trunk'); git(root, 'config', 'user.email', 't@example.com'); git(root, 'config', 'user.name', 'Tester');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'web', scripts: { dev: 'node server.js' } }));
  await writeFile(join(root, 'server.js'), SERVER);
  await writeFile(join(root, 'setup.js'), SETUP);
  await writeFile(join(root, '.gitignore'), 'node_modules/\n');
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'init');
  board = new Board({ dataDir: await temp('pb-preview-data-') });
  board.previews = new LivePreviews(board, { pollMs: 50, ...options });
  let project = await board.createProject({ name: 'Web' });
  await board.linkRepository(project.id, { path: root, expectedRevision: 1 });
  project = await board.setTargetBranch(project.id, { branch: 'trunk', expectedRevision: 2 });
  const projectNow = async () => (await board.view()).projects[0];
  const card = async title => {
    const created = await board.createTask({ projectId: project.id, title, prompt: `Build ${title}.` });
    await board.moveTask(created.id, { column: 'executing', expectedRevision: 1 });
    await board.ensureTaskWorktree(created.id);
    return created.id;
  };
  const configure = async (command, setup = []) => board.previews.setSettings(project.id, { command, setup, expectedRevision: (await projectNow()).revision });
  const settled = (id, label = 'the preview settles') => until(async () => { const { preview } = await board.previews.status(id); return preview && !['installing', 'starting'].includes(preview.status) && preview; }, label);
  const pidOf = preview => Number(preview.output.join('\n').match(/pid=(\d+)/)?.[1]);
  return { board, root, temp, projectId: project.id, projectNow, card, configure, settled, pidOf, task: async id => (await projectNow()).tasks.find(item => item.id === id) };
}

test('a dev server address is found in coloured output, a bare host:port counts, and a debugger address does not', () => {
  assert.equal(findAddress('  ➜  Local:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n'), 'http://localhost:5173/');
  assert.equal(findAddress('ready - started server on 127.0.0.1:3000, url: http://127.0.0.1:3000'), 'http://127.0.0.1:3000/');
  assert.equal(findAddress('Serving at https://[::1]:8443/app'), 'https://[::1]:8443/');
  assert.equal(findAddress('Debugger listening on ws://127.0.0.1:9229/abc\nCompiled.'), null, 'Not a web address.');
  assert.equal(findAddress('Listening on 0.0.0.0:3000 and http://example.com:80'), null, 'Only this computer’s own addresses.');
  assert.equal(findAddress('http://localhost:99999'), null);
  assert.equal(lastErrorLine('starting\nError: Cannot find module \'vite\'\n    at load\nnpm notice done\n'), 'Error: Cannot find module \'vite\'');
  assert.equal(lastErrorLine('\x1b[31mone\x1b[39m\r\ntwo\r'), 'two', 'Without an error word, the last line.');
});

test('the card folder suggests npm run dev, with npm ci when there is a lockfile and nothing to install without dependencies', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pb-preview-suggest-'))); t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await suggestPreview(dir), null, 'An empty folder suggests nothing.');
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', test: 'vitest' }, devDependencies: { vite: '7' } }));
  assert.deepEqual(await suggestPreview(dir), { command: 'npm run dev', setup: 'npm install' });
  await writeFile(join(dir, 'package-lock.json'), '{}');
  assert.deepEqual(await suggestPreview(dir), { command: 'npm run dev', setup: 'npm ci' });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node server.js' } }));
  assert.deepEqual(await suggestPreview(dir), { command: 'npm start', setup: '' });
  await rm(join(dir, 'package.json')); await writeFile(join(dir, 'compose.yaml'), 'services: {}\n');
  assert.equal(await suggestPreview(dir), null, 'Previews never run in Docker.');
});

test('the preview command and setup commands are checked like test commands, saved with the project revision, and an empty command removes them', async t => {
  const { board, projectNow, configure, projectId } = await world(t);
  assert.equal((await projectNow()).preview, undefined, 'An older data folder has no preview setting.');
  await assert.rejects(configure('promptboard-no-such-program --dev'), { code: 'COMMAND_NOT_FOUND', status: 400 });
  await assert.rejects(configure('node "unclosed'), { code: 'INVALID_COMMAND' });
  await assert.rejects(configure('node server.js', ['node a', 'node b', 'node c', 'node d', 'node e', 'node f']), { code: 'INVALID_INPUT' });
  await assert.rejects(configure('node server.js', ['nonexistent-setup-tool install']), { code: 'COMMAND_NOT_FOUND' });
  await assert.rejects(board.previews.setSettings(projectId, { command: 'node server.js', setup: [], expectedRevision: (await projectNow()).revision - 1 }), { code: 'REVISION_CONFLICT' });
  const before = (await projectNow()).revision;
  await configure('node server.js "two words"', ['node setup.js', '  ']);
  const project = await projectNow();
  assert.deepEqual(project.preview, { argv: ['node', 'server.js', 'two words'], setup: [['node', 'setup.js']] });
  assert.equal(project.revision, before + 1);
  await configure('  ');
  assert.equal((await projectNow()).preview, null);
  assert.equal(previewSettings({ argv: ['node', 'a\0b'] }), null, 'Damaged stored settings are dropped.');
});

test('Start preview runs the command in the card worktree with PORT, HOST and BROWSER set, and links to the address it printed', async t => {
  const { board, card, configure, settled, pidOf, projectId } = await world(t);
  const id = await card('Landing page');
  let status = await board.previews.status(id);
  assert.deepEqual([status.workspace, status.settings, status.preview, status.suggestion], [true, null, null, { command: 'npm run dev', setup: '' }]);
  await assert.rejects(board.previews.start(id, { confirm: true }), { code: 'NO_PREVIEW_COMMAND' });
  await configure('node server.js print');
  await assert.rejects(board.previews.start(id, {}), { code: 'CONFIRMATION_REQUIRED' });
  status = await board.previews.start(id, { confirm: true });
  assert.ok(['starting', 'ready'].includes(status.preview.status));
  assert.deepEqual(status.settings, { command: 'node server.js print', setup: [] });
  const again = await board.previews.start(id, { confirm: true });
  assert.equal(board.previews.items.size, 1, 'A second start shows the first preview; one per card.');
  assert.equal(again.preview.startedAt, status.preview.startedAt);
  const ready = await settled(id);
  assert.equal(ready.status, 'ready');
  assert.match(ready.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.notEqual(ready.url, `http://127.0.0.1:${ready.port}/`, 'The printed address wins over the PORT.');
  assert.equal(await (await fetch(ready.url)).text(), 'preview ok');
  assert.ok(ready.output.some(line => line === `pid=${pidOf(ready)} env PORT=${ready.port} HOST=127.0.0.1 BROWSER=none`));
  assert.ok(ready.output.some(line => line.includes(`Local:   ${ready.url.slice(0, -1)}/`)), 'Colour codes are removed from the output.');
  assert.deepEqual((await board.view()).previews, [{ taskId: id, projectId, number: 1, title: 'Landing page', status: 'ready', url: ready.url }]);
  const log = await readFile(join(board.dataDir, 'previews', `${id}.log`), 'utf8');
  assert.match(log, /Local:/);
  const pid = pidOf(ready);
  await board.previews.stop(id);
  assert.equal((await board.previews.status(id)).preview, null);
  await until(() => !alive(pid), 'the server process ended');
});

test('without a printed address the preview falls back to the PORT it was given', async t => {
  const { board, card, configure, settled } = await world(t);
  const id = await card('Quiet');
  await configure('node server.js quiet');
  await board.previews.start(id, { confirm: true });
  const ready = await settled(id);
  assert.deepEqual([ready.status, ready.url], ['ready', `http://127.0.0.1:${ready.port}/`]);
});

test('a server that never answers fails after the wait with a plain reason, and its process is stopped', async t => {
  const { board, card, configure, settled, pidOf } = await world(t, { readyMs: 600 });
  const id = await card('Hangs');
  await configure('node server.js hang');
  await board.previews.start(id, { confirm: true });
  const failed = await settled(id);
  assert.deepEqual([failed.status, failed.message, failed.url], ['failed', 'No address appeared within 2 minutes.', null]);
  await until(() => !alive(pidOf(failed)), 'the hanging server was stopped');
  await Promise.all(board.previews.items.get(id).closing);
  assert.equal((await board.previews.status(id)).preview.message, 'No address appeared within 2 minutes.', 'The exit that follows does not replace the reason.');
  assert.deepEqual(board.previews.list(), [], 'A failed preview does not count as running.');
});

test('a crash shows the last error line, and the next start replaces the failed preview', async t => {
  const { board, card, configure, settled } = await world(t);
  const id = await card('Crashes');
  await configure('node server.js crash');
  await board.previews.start(id, { confirm: true });
  const failed = await settled(id);
  assert.deepEqual([failed.status, failed.message], ['failed', 'The preview stopped: Error: Cannot find module \'vite\'']);
  assert.ok(failed.output.includes('npm notice: see the log'), 'The output stays readable under Output.');
  await configure('node server.js quiet');
  await board.previews.start(id, { confirm: true });
  assert.equal((await settled(id)).status, 'ready');
});

test('setup runs only when node_modules is missing, an install failure says so, and a folder that does not ignore node_modules is refused', async t => {
  const { board, card, configure, settled, temp, task } = await world(t);
  const id = await card('With setup');
  const log = join(await temp('pb-preview-setup-'), 'setup.log');
  await configure('node server.js quiet', [`node setup.js '${log}'`]);
  await board.previews.start(id, { confirm: true });
  assert.equal((await settled(id)).status, 'ready');
  assert.equal(await readFile(log, 'utf8'), 'setup\n');
  assert.ok(await exists(join((await task(id)).workspace.path, 'node_modules')));
  await board.previews.stop(id);
  await board.previews.start(id, { confirm: true });
  assert.equal((await settled(id)).status, 'ready');
  assert.equal(await readFile(log, 'utf8'), 'setup\n', 'node_modules exists now: no second install.');
  await board.previews.stop(id);
  // A failing install, on a fresh card (a fresh worktree never has node_modules).
  const other = await card('Install fails');
  await configure('node server.js quiet', ['node -e "console.error(\'npm ERR! network timeout\'); process.exit(3)"']);
  await board.previews.start(other, { confirm: true });
  const install = await settled(other);
  assert.deepEqual([install.status, install.message], ['failed', 'Install failed: npm ERR! network timeout']);
  // A card branch without node_modules in .gitignore would add every dependency to its changes.
  const unignored = await card('No gitignore');
  const tree = (await task(unignored)).workspace.path;
  // -f: on Windows the board's checkout has CRLF line ends, which this Git (without the system config) sees as a change.
  git(tree, 'rm', '-q', '-f', '.gitignore'); git(tree, 'commit', '-q', '-m', 'Drop the ignore file');
  await configure('node server.js quiet', [`node setup.js '${log}'`]);
  await board.previews.start(unignored, { confirm: true });
  const refused = await settled(unignored);
  assert.equal(refused.status, 'failed');
  assert.match(refused.message, /^Install failed: node_modules is not in \.gitignore/);
  assert.equal(await exists(join(tree, 'node_modules')), false);
  assert.equal(await readFile(log, 'utf8'), 'setup\n');
});

test('at most three previews run at once: a fourth is refused with the list of running ones', async t => {
  const { board, card, configure } = await world(t);
  const ids = [];
  for (const title of ['One', 'Two', 'Three', 'Four']) ids.push(await card(title));
  await configure('node server.js hang');
  for (const id of ids.slice(0, PREVIEW_LIMIT)) await board.previews.start(id, { confirm: true });
  await assert.rejects(board.previews.start(ids[3], { confirm: true }), error => error.code === 'PREVIEW_LIMIT' && error.message === 'Stop another preview first. Running now: #1 One, #2 Two, #3 Three.');
  const status = await board.previews.status(ids[3]);
  assert.deepEqual(status.running.map(item => item.title), ['One', 'Two', 'Three']);
  assert.equal(status.preview, null);
  await board.previews.stop(ids[0]);
  assert.equal((await board.previews.start(ids[3], { confirm: true })).preview.status, 'starting', 'Room again after a stop.');
});

test('removing the worktree, deleting the card or restoring its worktree stops the card’s preview first', async t => {
  const { board, card, configure, settled, pidOf, task } = await world(t);
  await configure('node server.js quiet');
  const removed = await card('Removed');
  await board.previews.start(removed, { confirm: true });
  const pid = pidOf(await settled(removed));
  const folder = (await task(removed)).workspace.path;
  await board.removeTaskWorktree(removed);
  assert.equal((await task(removed)).workspace, null);
  assert.equal(await exists(folder), false);
  assert.equal(board.previews.items.has(removed), false);
  assert.equal(alive(pid), false, 'The server ended before Git removed its folder.');
  // Deleting a card that keeps its files still ends its preview: the card is gone.
  const deleted = await card('Deleted');
  await board.previews.start(deleted, { confirm: true });
  const deletedPid = pidOf(await settled(deleted));
  await board.deleteTask(deleted, { expectedRevision: (await task(deleted)).revision, keepFiles: true });
  assert.deepEqual([board.previews.list(), alive(deletedPid)], [[], false]);
  if (process.platform === 'win32') return; // Windows cannot delete a folder a running server uses.
  const restored = await card('Restored');
  await board.previews.start(restored, { confirm: true });
  const restoredPid = pidOf(await settled(restored));
  await rm((await task(restored)).workspace.path, { recursive: true, force: true });
  await board.restoreTaskWorktree(restored);
  assert.deepEqual([board.previews.items.has(restored), alive(restoredPid)], [false, false]);
});

test('a merge stops the card’s preview before its worktree goes', async t => {
  const { board, card, configure, settled, pidOf, task, root } = await world(t);
  await configure('node server.js quiet');
  const id = await card('Merged');
  const tree = (await task(id)).workspace.path;
  await writeFile(join(tree, 'page.html'), '<h1>New</h1>\n'); git(tree, 'add', '.'); git(tree, 'commit', '-q', '-m', 'Add the page');
  await board.previews.start(id, { confirm: true });
  const pid = pidOf(await settled(id));
  const rev = await board.delivery.revision(id);
  await board.updateTaskEvidence(id, current => { current.evidence = { review: { status: 'accepted', verdict: 'no_issues', findings: [], taskCommit: rev.taskCommit }, tests: { status: 'passed', taskCommit: rev.taskCommit, targetCommit: rev.targetCommit } }; });
  await board.delivery.merge(id, { confirm: true, taskCommit: rev.taskCommit, targetCommit: rev.targetCommit });
  assert.equal((await task(id)).completion.kind, 'merged');
  assert.equal(git(root, 'rev-parse', 'trunk'), rev.taskCommit);
  assert.equal((await task(id)).workspace, null, 'The merged worktree was removed.');
  assert.deepEqual([board.previews.list(), alive(pid)], [[], false]);
});

test('a backup carries the preview command, which waits for confirmation before it applies', async t => {
  const { board, configure, projectNow, temp } = await world(t);
  await configure('node server.js', ['node setup.js']);
  const backup = await board.exportBackup();
  assert.deepEqual(backup.projects[0].preview, { argv: ['node', 'server.js'], setup: [['node', 'setup.js']] });
  const other = new Board({ dataDir: await temp('pb-preview-import-') });
  await other.importBackup(structuredClone(backup));
  let project = (await other.view()).projects[0];
  assert.equal(project.preview, undefined, 'An imported command never runs before you confirm it.');
  assert.deepEqual(project.pendingImport.preview, { argv: ['node', 'server.js'], setup: [['node', 'setup.js']] });
  await other.confirmImport(project.id, { accept: true, expectedRevision: project.revision });
  project = (await other.view()).projects[0];
  assert.deepEqual(project.preview, (await projectNow()).preview);
  // A damaged preview in a backup is dropped, not refused.
  backup.projects[0].preview = { argv: 'node server.js' };
  await other.importBackup(backup, { replace: true });
  assert.equal((await other.view()).projects[0].pendingImport?.preview, undefined);
});

test('over HTTP: start needs the token and confirm, a stop answers with the status, and shutdown leaves no server running', async t => {
  const { root } = await world(t);
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = (path, method = 'GET', body) => fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async response => ({ status: response.status, json: await response.json() }));
  let project = await app.board.createProject({ name: 'Http' });
  await app.board.linkRepository(project.id, { path: root, expectedRevision: 1 });
  project = await app.board.setTargetBranch(project.id, { branch: 'trunk', expectedRevision: 2 });
  const ids = [];
  for (const title of ['Alpha', 'Beta']) {
    const created = await app.board.createTask({ projectId: project.id, title, prompt: 'Do it.' });
    await app.board.moveTask(created.id, { column: 'executing', expectedRevision: 1 });
    await app.board.ensureTaskWorktree(created.id);
    ids.push(created.id);
  }
  assert.equal((await fetch(`${app.url}/api/tasks/${ids[0]}/preview`)).status, 403, 'The token is required.');
  const saved = await call(`/api/projects/${project.id}/preview`, 'PATCH', { command: 'node server.js quiet', setup: [], expectedRevision: project.revision });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.board.projects[0].preview, { argv: ['node', 'server.js', 'quiet'], setup: [] });
  assert.deepEqual([(await call(`/api/tasks/${ids[0]}/preview`, 'POST', {})).json.code], ['CONFIRMATION_REQUIRED']);
  for (const id of ids) assert.equal((await call(`/api/tasks/${id}/preview`, 'POST', { confirm: true })).status, 200);
  const ready = await until(async () => { const views = await Promise.all(ids.map(id => call(`/api/tasks/${id}/preview`))); return views.every(view => view.json.preview?.status === 'ready') && views.map(view => view.json.preview); }, 'both previews ready');
  const pids = ready.map(preview => Number(preview.output.join('\n').match(/pid=(\d+)/)[1]));
  assert.deepEqual((await app.board.view()).previews.map(item => item.status), ['ready', 'ready']);
  const stopped = await call(`/api/tasks/${ids[0]}/preview`, 'DELETE');
  assert.deepEqual([stopped.status, stopped.json.preview, stopped.json.running.length], [200, null, 1]);
  await until(() => !alive(pids[0]), 'the stopped server ended');
  assert.equal(alive(pids[1]), true);
  await app.close();
  await until(() => !alive(pids[1]), 'shutdown ended the other server');
  assert.equal(app.board.previews.items.size, 0);
});
