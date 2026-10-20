// Open in IDE: editors are found where they install, start without a shell with the stored folder, and an editor
// added by hand is a full path to a program. A paired phone neither lists nor starts editors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { detectEditors, editorLaunch, editorList, editorPreferences, openInEditor } from '../src/editors.mjs';
import { startTestServer } from './helpers/test-server.mjs';

async function temp(t) { const dir = await realpath(await mkdtemp(join(tmpdir(), 'pb-editors-'))); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })); return dir; }
async function program(path) { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, '#!/bin/sh\n'); await chmod(path, 0o755); return path; }
const launcher = calls => (command, args, options) => { calls.push([command, args, options.shell]); const child = new EventEmitter(); child.unref = () => {}; setImmediate(() => child.emit('spawn')); return child; };

test('editors are found as macOS apps, on PATH (and in JetBrains Toolbox scripts) on Linux, and in program folders on Windows', async t => {
  const dir = await temp(t);
  await mkdir(join(dir, 'apps', 'Visual Studio Code.app'), { recursive: true }); await mkdir(join(dir, 'apps', 'Zed.app'), { recursive: true });
  await writeFile(join(dir, 'apps', 'Cursor.app'), 'not a bundle');
  const mac = await detectEditors({ platform: 'darwin', env: {}, home: dir, appDirs: [join(dir, 'apps')] });
  assert.deepEqual(mac.editors.map(editor => [editor.id, editor.path]), [['vscode', join(dir, 'apps', 'Visual Studio Code.app')], ['zed', join(dir, 'apps', 'Zed.app')]]);
  if (process.platform !== 'win32') {
    await program(join(dir, 'bin', 'cursor')); await writeFile(join(dir, 'bin', 'zed'), 'not executable');
    await program(join(dir, '.local/share/JetBrains/Toolbox/scripts', 'pycharm'));
    const linux = await detectEditors({ platform: 'linux', env: { PATH: join(dir, 'bin') }, home: dir });
    assert.deepEqual([linux.wsl, linux.editors.map(editor => editor.id)], [false, ['cursor', 'pycharm']]);
    assert.equal((await detectEditors({ platform: 'linux', env: { PATH: join(dir, 'bin'), WSL_DISTRO_NAME: 'Ubuntu' }, home: dir })).wsl, true);
  }
});

test('Windows: program folders, a JetBrains IDE in its versioned folder, and an .exe on PATH; never a .cmd', { skip: process.platform !== 'win32' }, async t => {
  const dir = await temp(t);
  await writeFile(await (async () => { await mkdir(join(dir, 'local', 'Programs', 'cursor'), { recursive: true }); return join(dir, 'local', 'Programs', 'cursor', 'Cursor.exe'); })(), '');
  await mkdir(join(dir, 'pf', 'JetBrains', 'IntelliJ IDEA 2026.2', 'bin'), { recursive: true }); await writeFile(join(dir, 'pf', 'JetBrains', 'IntelliJ IDEA 2026.2', 'bin', 'idea64.exe'), '');
  await mkdir(join(dir, 'path'), { recursive: true }); await writeFile(join(dir, 'path', 'zed.exe'), ''); await writeFile(join(dir, 'path', 'code.cmd'), '');
  const found = await detectEditors({ platform: 'win32', env: { LOCALAPPDATA: join(dir, 'local'), ProgramFiles: join(dir, 'pf'), PATH: join(dir, 'path') }, home: dir });
  assert.deepEqual(found.editors.map(editor => editor.id), ['cursor', 'zed', 'idea']);
});

test('an editor starts with the folder as its argument: open -a on macOS, the program itself elsewhere, a Windows path for a Windows program from WSL', async () => {
  assert.deepEqual(await editorLaunch({ path: '/Applications/Zed.app' }, '/work/app', { platform: 'darwin', wsl: false }), { command: 'open', args: ['-a', '/Applications/Zed.app', '/work/app'], wait: true });
  assert.deepEqual(await editorLaunch({ path: '/usr/bin/cursor' }, '/work/my app', { platform: 'linux', wsl: false }), { command: '/usr/bin/cursor', args: ['/work/my app'], wait: false });
  const exec = async (command, args) => ({ ok: command === 'wslpath' && args[0] === '-w', stdout: `\\\\wsl.localhost\\Ubuntu${args[1].replaceAll('/', '\\')}\n` });
  assert.deepEqual((await editorLaunch({ path: '/mnt/c/Program Files/JetBrains/IntelliJ IDEA/bin/idea64.exe' }, '/home/me/app', { platform: 'linux', wsl: true, exec })).args, ['\\\\wsl.localhost\\Ubuntu\\home\\me\\app']);
  assert.deepEqual((await editorLaunch({ path: '/mnt/c/Users/me/AppData/Local/Programs/Microsoft VS Code/bin/code' }, '/home/me/app', { platform: 'linux', wsl: true, exec })).args, ['/home/me/app'], 'VS Code’s own WSL launcher takes the Linux path');
  assert.deepEqual((await editorLaunch({ command: '/opt/nova/nova', args: ['--new-window', '{path}', '--wait'] }, '/work/app', { platform: 'linux', wsl: false })).args, ['--new-window', '/work/app', '--wait']);
});

test('opening uses the stored project folder or a task’s worktree, reports a missing folder or editor, and remembers the editor', async t => {
  const dir = await temp(t), preferences = editorPreferences(dir), calls = [];
  await mkdir(join(dir, 'apps', 'Zed.app'), { recursive: true });
  const repo = join(dir, 'repo'), tree = join(dir, 'tree');
  await mkdir(repo); execFileSync('git', ['init', '-q', repo]);
  await mkdir(tree); await writeFile(join(tree, '.git'), 'gitdir: elsewhere');
  const project = { repository: { root: repo, path: repo }, tasks: [{ id: 't1', workspace: { path: tree } }, { id: 't2', workspace: null }] };
  const options = { preferences, platform: 'darwin', env: {}, home: dir, appDirs: [join(dir, 'apps')], exec: async (command, args) => { calls.push([command, ...args]); return { ok: true, stdout: '' }; } };
  assert.deepEqual(await openInEditor(project, { editor: 'zed' }, options), { opened: 'zed', name: 'Zed', folder: 'repo', worktree: false, remembered: true });
  await openInEditor(project, { editor: 'zed', taskId: 't1' }, options);
  assert.deepEqual(calls, [['open', '-a', join(dir, 'apps', 'Zed.app'), repo], ['open', '-a', join(dir, 'apps', 'Zed.app'), tree]]);
  assert.equal((await preferences.read()).preferred, 'zed');
  await assert.rejects(openInEditor(project, { editor: 'zed', taskId: 't2' }, options), { code: 'WORKTREE_MISSING' });
  await assert.rejects(openInEditor(project, { editor: 'cursor' }, options), { code: 'EDITOR_NOT_FOUND' });
  await assert.rejects(openInEditor({ repository: { root: join(dir, 'gone') }, tasks: [] }, { editor: 'zed' }, options), { code: 'FOLDER_MISSING' });
  await assert.rejects(openInEditor({ repository: null, tasks: [] }, { editor: 'zed' }, options), { code: 'REPOSITORY_REQUIRED' });
  await assert.rejects(openInEditor(project, { editor: 'zed' }, { ...options, exec: async () => ({ ok: false, stdout: '' }) }), { code: 'OPEN_FAILED' }, 'a failing open -a is reported');
});

test('an editor that opened is reported as opened when its choice cannot be saved; a damaged preferences file falls back to its backup', async t => {
  const dir = await temp(t), preferences = editorPreferences(dir), calls = [];
  await mkdir(join(dir, 'apps', 'Zed.app'), { recursive: true }); await mkdir(join(dir, 'apps', 'Cursor.app'));
  const project = { repository: { root: dir }, tasks: [] }, options = { preferences, platform: 'darwin', env: {}, home: dir, appDirs: [join(dir, 'apps')], exec: async (command, args) => { calls.push(args.at(-1)); return { ok: true, stdout: '' }; } };
  assert.equal((await openInEditor(project, { editor: 'zed' }, options)).remembered, true);
  // The backup's name is taken by a folder, so the next save fails (as in a read-only data folder).
  await mkdir(join(dir, 'editors.json.bak', 'taken'), { recursive: true });
  assert.deepEqual(await openInEditor(project, { editor: 'cursor' }, options), { opened: 'cursor', name: 'Cursor', folder: basename(dir), worktree: false, remembered: false });
  assert.deepEqual([calls.length, (await preferences.read()).preferred], [2, 'zed']);
  // A damaged file is not "no editors": the backup is read, and the next save keeps the editors added by hand.
  await rm(join(dir, 'editors.json.bak'), { recursive: true });
  const nova = process.platform === 'win32' ? null : await program(join(dir, 'nova'));
  if (!nova) return;
  await preferences.update({ custom: [{ name: 'Nova', command: nova }] }, { platform: 'linux' });
  await preferences.update({ preferred: 'zed' });
  await writeFile(join(dir, 'editors.json'), '{"version":1,"custom":[{"id":');
  assert.deepEqual((await preferences.read()).custom.map(item => item.name), ['Nova']);
  // The damaged file is set aside, so the next save keeps the good backup instead of making the damaged file the backup.
  assert.equal((await readdir(dir)).filter(name => name.startsWith('editors.json.corrupt-')).length, 1);
  await preferences.remember('cursor');
  assert.deepEqual((await preferences.read()).custom.map(item => item.name), ['Nova']);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'editors.json.bak'), 'utf8')).custom.map(item => item.name), ['Nova']);
});

test('an editor added by hand is a full path to a program; scripts that need a shell are refused', async t => {
  const dir = await temp(t), preferences = editorPreferences(dir);
  const refused = async (input, code, platform = 'linux') => assert.rejects(preferences.update({ custom: [input] }, { platform }), { code });
  await refused({ name: '', command: '/bin/sh' }, 'INVALID_EDITOR');
  await refused({ name: 'Rel', command: 'nova' }, 'INVALID_EDITOR');
  await refused({ name: 'Gone', command: join(dir, 'missing') }, 'EDITOR_NOT_FOUND');
  await refused({ name: 'Script', command: 'C:\\Tools\\editor.cmd' }, 'INVALID_EDITOR', 'win32');
  if (process.platform === 'win32') return;
  const nova = await program(join(dir, 'nova'));
  const saved = await preferences.update({ custom: [{ name: 'Nova', command: nova, args: ['{path}'] }] }, { platform: 'linux' });
  const list = await editorList(preferences, { platform: 'linux', env: { PATH: '' }, home: dir });
  assert.deepEqual(list.editors, [{ id: saved.custom[0].id, name: 'Nova', custom: true }]);
  const calls = [];
  await openInEditor({ repository: { root: dir }, tasks: [] }, { editor: saved.custom[0].id }, { preferences, platform: 'linux', env: { PATH: '' }, home: dir, launch: launcher(calls) });
  assert.deepEqual(calls, [[nova, [dir], false]]);
  assert.equal((await editorList(preferences, { platform: 'linux', env: { PATH: '' }, home: dir })).preferred, saved.custom[0].id);
});

test('the routes list editors and open the stored folder; the page cannot name a folder or a program', async t => {
  const dir = await temp(t), calls = [];
  await mkdir(join(dir, 'apps', 'Visual Studio Code.app'), { recursive: true });
  const repo = join(dir, 'repo'); await mkdir(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-q', '-b', 'main'); git('-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init');
  const app = await startTestServer(t, { port: 0, executor: null, editorOptions: { platform: 'darwin', env: {}, home: dir, appDirs: [join(dir, 'apps')], exec: async (command, args) => { calls.push([command, ...args]); return { ok: true, stdout: '' }; } } });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = (path, method = 'GET', body) => fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async r => ({ status: r.status, json: await r.json() }));
  assert.deepEqual((await call('/api/editors')).json.editors, [{ id: 'vscode', name: 'Visual Studio Code', custom: false }]);
  const project = await app.board.createProject({ name: 'Shop' });
  await app.board.linkRepository(project.id, { path: repo, expectedRevision: 1 });
  const opened = await call(`/api/projects/${project.id}/open`, 'POST', { target: 'editor', editor: 'vscode', path: '/etc', command: '/bin/sh' });
  assert.deepEqual([opened.status, opened.json.opened], [200, 'vscode']);
  assert.deepEqual(calls, [['open', '-a', join(dir, 'apps', 'Visual Studio Code.app'), repo]], 'the stored folder, never one from the request');
  assert.equal((await call('/api/editors')).json.preferred, 'vscode');
  assert.equal((await call(`/api/projects/${project.id}/open`, 'POST', { target: 'editor', editor: 'nope' })).json.code, 'EDITOR_NOT_FOUND');
  assert.equal((await call('/api/editors', 'PUT', { custom: [{ name: 'Shell', command: 'sh' }] })).status, 400);
});
