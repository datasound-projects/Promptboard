import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceEntry, inspectWorkspace, saveWorkspaceFile } from '../src/workspace-files.mjs';
import { parseStatus, projectStatus } from '../src/project-explorer.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
/** A repository on `main` with one commit, linked as a project; `folder` selects a subfolder as the project folder. */
async function fixture(t, { folder = '' } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pb-explorer-')));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.email', 't@example.com'); git(root, 'config', 'user.name', 'Tester');
  const base = join(root, folder);
  await mkdir(join(base, 'src'), { recursive: true });
  await writeFile(join(base, 'src', 'cart.js'), 'export const total = 1;\n'); await writeFile(join(base, 'readme.md'), '# Shop\n'); await writeFile(join(base, '.gitignore'), 'build\n');
  if (folder) await writeFile(join(root, 'outside.txt'), 'Another project\n');
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'Add the cart');
  const project = { id: 'p_shop', name: 'Shop', repository: { root, path: base, inspectionRoot: base }, targetBranch: { name: 'main' }, tasks: [] };
  return { root, base, project, board: { store: { read: async () => ({ projects: [project] }) } } };
}

test('Git status gives M, A and U markers and ignored folders, relative to the project folder', async t => {
  const { base, board } = await fixture(t);
  await writeFile(join(base, 'src', 'cart.js'), 'export const total = 2;\n');
  await writeFile(join(base, 'src', 'tax.js'), 'export const tax = 0.2;\n');
  await mkdir(join(base, 'notes')); await writeFile(join(base, 'notes', 'todo.md'), '- ship\n');
  await writeFile(join(base, 'staged.js'), ''); git(base, 'add', 'staged.js');
  await mkdir(join(base, 'build')); await writeFile(join(base, 'build', 'out.js'), '');
  const status = await projectStatus(board, 'p_shop');
  assert.deepEqual(Object.fromEntries(status.status.entries), { 'src/cart.js': 'M', 'staged.js': 'A', 'src/tax.js': 'U', notes: 'U', build: 'I' });
  assert.deepEqual([status.folder, status.branch, status.target, status.head.subject, status.project.name], [base.split(/[\\/]/).at(-1), 'main', 'main', 'Add the cart', 'Shop']);
  assert.ok(Math.abs(status.head.at - Date.now()) < 120000);
});

test('a project folder inside a larger repository sees only its own changes, without the folder prefix', async t => {
  const { root, base, board } = await fixture(t, { folder: join('apps', 'shop') });
  await writeFile(join(base, 'src', 'cart.js'), 'changed\n'); await writeFile(join(root, 'outside.txt'), 'changed too\n');
  const status = await projectStatus(board, 'p_shop');
  assert.deepEqual(status.status.entries, [['src/cart.js', 'M']]);
  // Both changes are in the checkout, so both stop a merge into it.
  assert.equal(status.mergeBlocked, true);
});

test('porcelain parsing keeps renamed files under their new name and skips their old one, in the index and in the work tree', async t => {
  assert.deepEqual(parseStatus('R  new.js\0old.js\0 M a.js\0?? dir/\0'), { entries: [['new.js', 'A'], ['a.js', 'M'], ['dir', 'U']], tracked: 2, truncated: false });
  assert.deepEqual(parseStatus(' R b.txt\0a.txt\0 C copy.js\0src.js\0'), { entries: [['b.txt', 'A'], ['copy.js', 'A']], tracked: 2, truncated: false });
  // The real case: a moved file whose new name is marked with git add -N is a work-tree rename.
  const { base, board } = await fixture(t);
  await rename(join(base, 'readme.md'), join(base, 'intro.md')); git(base, 'add', '-N', 'intro.md');
  assert.equal(execFileSync('git', ['status', '--porcelain=v1'], { cwd: base, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }), ' R readme.md -> intro.md\n');
  assert.deepEqual((await projectStatus(board, 'p_shop')).status.entries, [['intro.md', 'A']]);
  assert.deepEqual(parseStatus(' M app/a.js\0 M other/b.js\0', 'app').entries, [['a.js', 'M']]);
});

test('changed tracked files in the target checkout block merges; new files alone do not, and another branch is named', async t => {
  const { base, board } = await fixture(t);
  assert.equal((await projectStatus(board, 'p_shop')).mergeBlocked, false);
  await writeFile(join(base, 'new.txt'), 'Not in Git yet\n');
  assert.equal((await projectStatus(board, 'p_shop')).mergeBlocked, false, 'Delivery.merge checks tracked files only');
  await writeFile(join(base, 'readme.md'), '# Edited by hand\n');
  assert.equal((await projectStatus(board, 'p_shop')).mergeBlocked, true);
  git(base, 'checkout', '-q', '-b', 'experiment');
  const other = await projectStatus(board, 'p_shop');
  assert.deepEqual([other.branch, other.target, other.mergeBlocked], ['experiment', 'main', false], 'Merges move main without this checkout');
});

test('new files and folders are created empty and never replace an existing name', async t => {
  const { base, board } = await fixture(t);
  const { scopeVersion } = await inspectWorkspace(board, 'p_shop');
  assert.deepEqual(await createWorkspaceEntry(board, 'p_shop', { path: 'src/new.js', kind: 'file', scopeVersion }), { path: 'src/new.js', kind: 'file', created: true });
  assert.equal(await readFile(join(base, 'src', 'new.js'), 'utf8'), '');
  await createWorkspaceEntry(board, 'p_shop', { path: 'docs', kind: 'directory', scopeVersion });
  assert.equal((await lstat(join(base, 'docs'))).isDirectory(), true);
  for (const [path, kind] of [['src/cart.js', 'file'], ['src', 'directory'], ['docs', 'file']]) await assert.rejects(createWorkspaceEntry(board, 'p_shop', { path, kind, scopeVersion }), { code: 'FILE_EXISTS', status: 409 });
  assert.equal(await readFile(join(base, 'src', 'cart.js'), 'utf8'), 'export const total = 1;\n', 'The existing file is untouched.');
});

test('creating refuses escapes, protected names, links, missing folders, Windows aliases and a relinked folder', async t => {
  const { root, base, board, project } = await fixture(t);
  const { scopeVersion } = await inspectWorkspace(board, 'p_shop');
  const before = await readdir(base);
  for (const path of ['../outside.js', '/tmp/outside.js', 'src/../x.js', './x.js', 'src//x.js', 'C:/x.js', 'x:stream', '..\\x.js', 'a\0b', '', 'name.', 'name ', 'CON', 'nul.txt',
    'a<b.js', 'a>b.js', 'a"b.js', 'a|b.js', 'a?b.js', 'a*b.js', 'CON .txt', 'aux .md', 'COM¹', 'lpt².log', 'com0', 'conin$']) {
    await assert.rejects(createWorkspaceEntry(board, 'p_shop', { path, kind: 'file', scopeVersion }), { code: 'FILE_PATH_INVALID' }, JSON.stringify(path));
  }
  for (const path of ['.env', '.git/hooks/x', 'keys/id_ed25519', 'server.pem']) await assert.rejects(createWorkspaceEntry(board, 'p_shop', { path, kind: 'file', scopeVersion }), { code: 'FILE_PROTECTED' }, path);
  await assert.rejects(createWorkspaceEntry(board, 'p_shop', { path: 'missing/x.js', kind: 'file', scopeVersion }), { code: 'FILE_NOT_FOUND' });
  await assert.rejects(createWorkspaceEntry(board, 'p_shop', { path: 'x.js', kind: 'link', scopeVersion }), { code: 'FILE_KIND_INVALID' });
  await assert.rejects(createWorkspaceEntry(board, 'p_shop', { path: 'x.js', kind: 'file' }), { code: 'FILE_VERSION_INVALID' });
  if (process.platform !== 'win32') {
    const elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'pb-explorer-elsewhere-'))); t.after(() => rm(elsewhere, { recursive: true, force: true }));
    await symlink(elsewhere, join(base, 'linked'));
    await assert.rejects(createWorkspaceEntry(board, 'p_shop', { path: 'linked/x.js', kind: 'file', scopeVersion }), { code: 'FILE_LINK_BLOCKED' });
    assert.deepEqual(await readdir(elsewhere), []);
    await rm(join(base, 'linked'));
  }
  // The project was relinked to another folder after the tree was read: nothing is created in either folder.
  await mkdir(join(root, 'other')); project.repository = { ...project.repository, path: join(root, 'other'), inspectionRoot: join(root, 'other') };
  await assert.rejects(createWorkspaceEntry(board, 'p_shop', { path: 'x.js', kind: 'file', scopeVersion }), { code: 'FILE_CONFLICT' });
  assert.deepEqual(await readdir(join(root, 'other')), []);
  assert.deepEqual((await readdir(base)).filter(name => name !== 'other'), before);
});

test('a create the file system refuses gets its own plain message, without the local path', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const { base, board } = await fixture(t);
  const { scopeVersion } = await inspectWorkspace(board, 'p_shop');
  await chmod(join(base, 'src'), 0o555);
  try {
    for (const path of ['src/locked.js', `${'n'.repeat(300)}.js`]) {
      const error = await createWorkspaceEntry(board, 'p_shop', { path, kind: 'file', scopeVersion }).then(() => null, failure => failure);
      assert.deepEqual([error?.code, error?.message], ['FILE_CREATE_FAILED', 'The file or folder could not be created. Check that you can write to this folder, or choose a shorter name.'], path.slice(0, 20));
    }
    await assert.rejects(lstat(join(base, 'src', 'locked.js')), { code: 'ENOENT' });
  } finally { await chmod(join(base, 'src'), 0o755); } // Before the folder is removed.
});

test('Git status refuses a project folder that was replaced by a link, like the file list does', { skip: process.platform === 'win32' }, async t => {
  const { root, board } = await fixture(t), moved = `${root}-original`;
  await rename(root, moved); t.after(() => rm(moved, { recursive: true, force: true }));
  await symlink(moved, root);
  await assert.rejects(inspectWorkspace(board, 'p_shop'), { code: 'FILE_ROOT_CHANGED' });
  await assert.rejects(projectStatus(board, 'p_shop'), { code: 'FILE_ROOT_CHANGED' });
});

test('a save over a file that changed on disk is refused; Keep mine saves once more from the newer version', async t => {
  const { base, board } = await fixture(t), path = join(base, 'src', 'cart.js');
  const opened = await inspectWorkspace(board, 'p_shop', { path: 'src/cart.js', file: true });
  await writeFile(path, 'export const total = 3; // Changed by an agent merge\n');
  const draft = { path: 'src/cart.js', workspace: '', text: 'export const total = 10;\n', version: opened.version, scopeVersion: opened.scopeVersion };
  await assert.rejects(saveWorkspaceFile(board, 'p_shop', draft), { code: 'FILE_CONFLICT' });
  assert.match(await readFile(path, 'utf8'), /Changed by an agent merge/);
  // "Keep mine and save anyway": read the version on disk now, then save the same draft against it.
  const current = await inspectWorkspace(board, 'p_shop', { path: 'src/cart.js', file: true });
  await saveWorkspaceFile(board, 'p_shop', { ...draft, version: current.version });
  assert.equal(await readFile(path, 'utf8'), 'export const total = 10;\n');
});

test('explorer routes need the session token, refuse other origins and leave the board unchanged; project.html is a protected page', async t => {
  const { base } = await fixture(t);
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const { project } = await app.board.createProjectWithRepository({ name: 'Shop', folder: base });
  const token = (await fetch(`${app.url}/api/session`).then(response => response.json())).token;
  const headers = { 'x-ste-token': token, 'content-type': 'application/json' }, url = `${app.url}/api/projects/${project.id}`;
  const before = await app.board.store.read();
  const { scopeVersion } = await fetch(`${url}/files`, { headers }).then(response => response.json());
  const create = extra => fetch(`${url}/files`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify({ path: 'added.js', kind: 'file', scopeVersion }) });
  assert.equal((await create({ 'x-ste-token': 'wrong' })).status, 403);
  assert.equal((await create({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(`${url}/git-status`)).status, 403);
  await assert.rejects(lstat(join(base, 'added.js')), { code: 'ENOENT' });
  assert.equal((await create()).status, 200);
  assert.equal((await create()).status, 409, 'A second create of the same name is refused');
  const status = await fetch(`${url}/git-status`, { headers }).then(response => response.json());
  assert.deepEqual(status.status.entries, [['added.js', 'U']]);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(base.replaceAll('\\', '\\\\')), 'No absolute local path in the answer');
  const escape = await fetch(`${url}/files`, { method: 'POST', headers, body: JSON.stringify({ path: '../x.js', kind: 'file', scopeVersion }) });
  assert.equal(escape.status, 400); assert.doesNotMatch(await escape.text(), new RegExp(base.replaceAll('\\', '\\\\')));
  assert.deepEqual(await app.board.store.read(), before);
  const page = await fetch(`${app.url}/project.html?project=${project.id}`);
  assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /project-explorer\.js/);
  assert.match((await fetch(`${app.url}/project-explorer.js`)).headers.get('content-type'), /^text\/javascript/);
});
