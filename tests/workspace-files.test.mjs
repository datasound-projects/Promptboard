import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { FILE_LIMITS, inspectWorkspace } from '../src/workspace-files.mjs';
import { startTestServer } from './helpers/test-server.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pb-file-inspector-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await mkdir(join(root, 'src', 'nested'), { recursive: true });
  await writeFile(join(root, 'src', 'index.js'), 'const message = "cześć 🐕";\nconsole.log(message);\n');
  await writeFile(join(root, 'readme.md'), '# Example\n');
  const { realpath } = await import('node:fs/promises'), canonical = await realpath(root);
  const project = { id: 'p_fixture', name: 'Example', repository: { root: canonical }, tasks: [] };
  return { root: canonical, project, board: { store: { read: async () => ({ projects: [project] }) } } };
}

test('lists the actual hierarchy lazily, folders first, including untracked and hidden files', async t => {
  const { root, board } = await fixture(t);
  await writeFile(join(root, '.gitignore'), 'build\n'); await mkdir(join(root, 'build'));
  const list = await inspectWorkspace(board, 'p_fixture');
  assert.deepEqual(list.entries.map(e => e.name), ['build', 'src', '.gitignore', 'readme.md']);
  assert.equal(list.entries.some(e => e.name === 'index.js'), false);
  const src = await inspectWorkspace(board, 'p_fixture', { path: 'src' });
  assert.deepEqual(src.entries.map(e => [e.name, e.kind]), [['nested', 'directory'], ['index.js', 'file']]);
  assert.equal((await inspectWorkspace(board, 'p_fixture', { path: 'src/nested' })).entries.length, 0);
});

test('reads Unicode exactly, hashes content, avoids repeat transfer and notices same-size edits', async t => {
  const { root, board } = await fixture(t), path = 'src/index.js';
  const initial = await inspectWorkspace(board, 'p_fixture', { path, file: true });
  assert.equal(initial.text, await readFile(join(root, path), 'utf8'));
  assert.equal(initial.project.name, 'Example'); assert.equal(initial.workspace.name, 'Project checkout');
  const unchanged = await inspectWorkspace(board, 'p_fixture', { path, file: true, version: initial.version });
  assert.equal(unchanged.unchanged, true); assert.equal(Object.hasOwn(unchanged, 'text'), false);
  await writeFile(join(root, path), initial.text.replace('message', 'example'));
  const changed = await inspectWorkspace(board, 'p_fixture', { path, file: true, version: initial.version });
  assert.equal(changed.unchanged, false); assert.notEqual(changed.version, initial.version);
});

test('rejects path traversal, absolute paths, Windows escapes, nulls and excessive depth', async t => {
  const { board } = await fixture(t);
  for (const path of ['../secret', '/etc/passwd', 'src/../readme.md', './readme.md', 'src//index.js', 'C:/secret', 'file.txt:stream', '.env::$DATA', '..\\secret', 'x\0y', Array(66).fill('x').join('/')]) {
    await assert.rejects(inspectWorkspace(board, 'p_fixture', { path, file: true }), error => error.code === 'FILE_PATH_INVALID');
  }
});

test('blocks credential files and Git internals but allows example configuration', async t => {
  const { root, board } = await fixture(t);
  for (const name of ['.env', '.env.local', '.npmrc', 'id_ed25519', 'secret.pem', 'credentials.json', '.git']) {
    await writeFile(join(root, name), 'SECRET');
    await assert.rejects(inspectWorkspace(board, 'p_fixture', { path: name, file: true }), error => error.code === 'FILE_PROTECTED');
  }
  assert.ok((await inspectWorkspace(board, 'p_fixture')).entries.filter(e => e.name !== 'src' && e.name !== 'readme.md').every(e => e.blocked));
  await writeFile(join(root, '.env.example'), 'EXAMPLE=value');
  assert.equal((await inspectWorkspace(board, 'p_fixture', { path: '.env.example', file: true })).text, 'EXAMPLE=value');
  for (const path of ['.git./config', '.git /config', '.npmrc.', '.npmrc ']) await assert.rejects(inspectWorkspace(board, 'p_fixture', { path, file: true }), error => error.code === 'FILE_PROTECTED');
});

test('never follows file or directory symlinks, including links inside the project', { skip: process.platform === 'win32' }, async t => {
  const { root, board } = await fixture(t);
  await symlink(join(root, 'readme.md'), join(root, 'linked.md'));
  await symlink(join(root, 'src'), join(root, 'linked-dir'));
  assert.equal((await inspectWorkspace(board, 'p_fixture')).entries.find(e => e.name === 'linked.md').blocked, true);
  for (const path of ['linked.md', 'linked-dir/index.js']) await assert.rejects(inspectWorkspace(board, 'p_fixture', { path, file: true }), error => error.code === 'FILE_LINK_BLOCKED');
});

test('rejects binary, invalid UTF-8, oversized and excessive-line files; accepts empty text', async t => {
  const { root, board } = await fixture(t);
  for (const [name, content, code] of [['binary', Buffer.from([0, 1, 2]), 'FILE_UNSUPPORTED'], ['invalid', Buffer.from([255, 254]), 'FILE_UNSUPPORTED'], ['large', Buffer.alloc(FILE_LIMITS.bytes + 1, 65), 'FILE_TOO_LARGE'], ['lines', '\n'.repeat(FILE_LIMITS.lines), 'FILE_TOO_LARGE']]) {
    await writeFile(join(root, name), content);
    await assert.rejects(inspectWorkspace(board, 'p_fixture', { path: name, file: true }), error => error.code === code);
  }
  await writeFile(join(root, 'empty'), '');
  assert.equal((await inspectWorkspace(board, 'p_fixture', { path: 'empty', file: true })).text, '');
});

test('rejects FIFOs promptly without opening a blocking stream', { skip: process.platform === 'win32' }, async t => {
  const { root, board } = await fixture(t); execFileSync('mkfifo', [join(root, 'pipe')]);
  assert.equal((await inspectWorkspace(board, 'p_fixture')).entries.find(e => e.name === 'pipe').blocked, true);
  await assert.rejects(inspectWorkspace(board, 'p_fixture', { path: 'pipe', file: true }), error => error.code === 'FILE_UNSUPPORTED');
});

test('paginates large directories deterministically without recursively reading children', async t => {
  const { root, board } = await fixture(t);
  await mkdir(join(root, 'many'));
  await Promise.all(Array.from({ length: 270 }, (_, i) => writeFile(join(root, 'many', `${String(i).padStart(3, '0')}.txt`), '')));
  const first = await inspectWorkspace(board, 'p_fixture', { path: 'many' });
  assert.equal(first.entries.length, FILE_LIMITS.page); assert.equal(first.next, 250);
  const second = await inspectWorkspace(board, 'p_fixture', { path: 'many', offset: '250' });
  assert.equal(second.entries.length, 20); assert.equal(second.next, null);
  assert.equal(new Set([...first.entries, ...second.entries].map(e => e.name)).size, 270);
  for (const offset of ['-1', 'no', '5000']) await assert.rejects(inspectWorkspace(board, 'p_fixture', { offset }), error => error.code === 'FILE_PAGE_INVALID');
});

test('handles disappeared paths, wrong types, unknown projects and unlinked projects clearly', async t => {
  const { board, project } = await fixture(t);
  await assert.rejects(inspectWorkspace(board, 'p_fixture', { path: 'missing' }), error => error.status === 404);
  await assert.rejects(inspectWorkspace(board, 'p_fixture', { path: 'readme.md' }), error => error.code === 'FILE_NOT_DIRECTORY');
  await assert.rejects(inspectWorkspace(board, 'p_fixture', { path: 'src', file: true }), error => error.code === 'FILE_UNSUPPORTED');
  await assert.rejects(inspectWorkspace(board, 'unknown'), error => error.status === 404);
  project.repository = null;
  await assert.rejects(inspectWorkspace(board, 'p_fixture'), error => error.code === 'REPOSITORY_REQUIRED');
});

test('root replacement by a symlink cannot expose another folder', { skip: process.platform === 'win32' }, async t => {
  const { root, board } = await fixture(t), moved = root + '-original';
  await rename(root, moved); t.after(() => rm(moved, { recursive: true, force: true }));
  await symlink(moved, root);
  await assert.rejects(inspectWorkspace(board, 'p_fixture'), error => error.code === 'FILE_ROOT_CHANGED');
});

test('protected HTTP file routes leave repository and board state unchanged and start no providers', async t => {
  const { root } = await fixture(t); let calls = 0;
  const app = await startTestServer(t, { port: 0, executor: null, runner: async () => { calls++; throw new Error('Never run'); }, detector: async () => [] });
  const { project } = await app.board.createProjectWithRepository({ name: 'Imported', folder: root });
  const token = await fetch(app.url + '/api/session').then(r => r.json()).then(d => d.token);
  const route = `${app.url}/api/projects/${project.id}/file?path=src%2Findex.js`;
  assert.equal((await fetch(route)).status, 403);
  assert.equal((await fetch(route, { headers: { 'x-ste-token': token, origin: 'https://evil.example' } })).status, 403);
  const before = await app.board.store.read(), source = await readFile(join(root, 'src', 'index.js'));
  const response = await fetch(route, { headers: { 'x-ste-token': token } });
  assert.equal(response.status, 200); assert.equal((await response.json()).project.name, 'Imported');
  assert.deepEqual(await app.board.store.read(), before); assert.deepEqual(await readFile(join(root, 'src', 'index.js')), source); assert.equal(calls, 0);
  const invalid = await fetch(route.replace('src%2Findex.js', '..%2Fsecret'), { headers: { 'x-ste-token': token } });
  assert.equal(invalid.status, 400); assert.doesNotMatch(await invalid.text(), new RegExp(root));
  assert.equal((await fetch(route, { method: 'DELETE', headers: { 'x-ste-token': token } })).status, 404);
});

test('inspects the actual registered task worktree without creating or repairing one', async t => {
  const { root } = await fixture(t);
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const { project } = await app.board.createProjectWithRepository({ name: 'Worktree', folder: root });
  const task = await app.board.createTask({ projectId: project.id, title: 'Task branch', prompt: 'Implement the feature.' });
  const path = join(root, 'task-checkout');
  const branch = 'file-inspection-test';
  execFileSync('git', ['worktree', 'add', '-b', branch, path], { cwd: root });
  const { realpath } = await import('node:fs/promises'); const canonical = await realpath(path);
  await app.board.store.update(state => { state.projects[0].tasks[0].workspace = { status: 'ready', path: canonical, branch, repositoryRoot: project.repository.root, commonDir: project.repository.commonDir }; });
  await writeFile(join(path, 'task-only.txt'), 'Task checkout content');
  const before = await app.board.store.read();
  const file = await inspectWorkspace(app.board, project.id, { workspace: task.id, path: 'task-only.txt', file: true });
  assert.equal(file.text, 'Task checkout content'); assert.match(file.workspace.name, /file-inspection-test/);
  await assert.rejects(inspectWorkspace(app.board, project.id, { path: 'task-only.txt', file: true }), error => error.status === 404);
  await assert.rejects(inspectWorkspace(app.board, project.id, { workspace: 'wrong' }), error => error.code === 'FILE_WORKSPACE_UNAVAILABLE');
  assert.deepEqual(await app.board.store.read(), before);
  await rm(path, { recursive: true, force: true });
  await assert.rejects(inspectWorkspace(app.board, project.id, { workspace: task.id }), error => error.code === 'FILE_WORKSPACE_UNAVAILABLE');
  assert.deepEqual(await app.board.store.read(), before);
});
