// Open a project's folder in a code editor installed on this computer. Editors are found where they install
// themselves (macOS app bundles, Windows program folders, PATH on Linux and WSL) or added by the person with the
// full path of their program. One starts without a shell, with the folder as its argument. The folder always comes
// from the stored project or task, never from the page, and nothing in the repository is changed.
import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, isAbsolute, join, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeAtomic } from './durable.mjs';

const fail = (message, code, status = 400) => Object.assign(new Error(message), { code, status });
// Built-in editors: macOS app names, Windows programs (under %LOCALAPPDATA% or %ProgramFiles%) and PATH commands.
// A JetBrains IDE's Windows folder carries its version ("IntelliJ IDEA 2026.2"), so it is matched by prefix.
const JETBRAINS = [['idea', 'IntelliJ IDEA', ['IntelliJ IDEA', 'IntelliJ IDEA Ultimate', 'IntelliJ IDEA CE', 'IntelliJ IDEA Community Edition'], 'idea64.exe', ['idea', 'intellij-idea-ultimate', 'intellij-idea-community']],
  ['pycharm', 'PyCharm', ['PyCharm', 'PyCharm Professional Edition', 'PyCharm CE', 'PyCharm Community Edition'], 'pycharm64.exe', ['pycharm', 'pycharm-professional', 'pycharm-community']],
  ['webstorm', 'WebStorm', ['WebStorm'], 'webstorm64.exe', ['webstorm']], ['goland', 'GoLand', ['GoLand'], 'goland64.exe', ['goland']],
  ['phpstorm', 'PhpStorm', ['PhpStorm'], 'phpstorm64.exe', ['phpstorm']], ['rubymine', 'RubyMine', ['RubyMine'], 'rubymine64.exe', ['rubymine']],
  ['clion', 'CLion', ['CLion'], 'clion64.exe', ['clion']], ['rider', 'Rider', ['Rider'], 'rider64.exe', ['rider']],
  ['rustrover', 'RustRover', ['RustRover'], 'rustrover64.exe', ['rustrover']], ['android-studio', 'Android Studio', ['Android Studio'], 'studio64.exe', ['studio', 'android-studio']]];
export const EDITORS = [
  { id: 'vscode', name: 'Visual Studio Code', mac: ['Visual Studio Code', 'Visual Studio Code - Insiders'], win: [['Programs/Microsoft VS Code', 'Code.exe'], ['Programs/Microsoft VS Code Insiders', 'Code - Insiders.exe'], ['Microsoft VS Code', 'Code.exe']], bin: ['code', 'code-insiders'] },
  { id: 'cursor', name: 'Cursor', mac: ['Cursor'], win: [['Programs/cursor', 'Cursor.exe']], bin: ['cursor'] },
  // Windsurf became Devin Desktop; older installs keep the Windsurf name.
  { id: 'devin', name: 'Devin Desktop', mac: ['Devin'], win: [['Programs/Devin', 'Devin.exe']], bin: ['devin-desktop'] },
  { id: 'windsurf', name: 'Windsurf', mac: ['Windsurf'], win: [['Programs/Windsurf', 'Windsurf.exe']], bin: ['windsurf'] },
  { id: 'trae', name: 'TRAE', mac: ['Trae', 'Trae CN'], win: [['Programs/Trae', 'Trae.exe'], ['Programs/Trae CN', 'Trae CN.exe']], bin: ['trae'] },
  { id: 'zed', name: 'Zed', mac: ['Zed', 'Zed Preview'], win: [['Programs/Zed', 'Zed.exe']], bin: ['zed', 'zeditor'] },
  { id: 'sublime', name: 'Sublime Text', mac: ['Sublime Text'], win: [['Sublime Text', 'sublime_text.exe']], bin: ['subl'] },
  ...JETBRAINS.map(([id, name, mac, exe, bin]) => ({ id, name, mac, win: [[`JetBrains/${name}`, exe, true], [`Programs/${name}`, exe, true]], bin })),
];
const LIMITS = { custom: 20, name: 60, path: 1024, args: 10, arg: 200 };
const exists = path => access(path).then(() => true, () => false);
const executable = path => access(path, constants.X_OK).then(() => true, () => false);
const isDir = path => stat(path).then(info => info.isDirectory(), () => false);

/** Promptboard inside WSL: Windows editors take Windows paths. */
async function inWsl(env, platform) {
  if (platform !== 'linux') return false;
  if (env.WSL_DISTRO_NAME) return true;
  return /microsoft/i.test(await readFile('/proc/version', 'utf8').catch(() => ''));
}
async function onPath(names, env, platform) {
  const dirs = (env.PATH || '').split(platform === 'win32' ? win32.delimiter : delimiter).filter(Boolean);
  for (const name of names) for (const dir of dirs) { const path = join(dir, name); if (await executable(path) && !(await isDir(path))) return path; }
  return null;
}
async function findWindows(entries, env) {
  const roots = [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean);
  for (const [folder, exe, prefixed] of entries) for (const root of roots) {
    if (!prefixed) { const path = win32.join(root, ...folder.split('/'), exe); if (await exists(path)) return path; continue; }
    // "JetBrains/IntelliJ IDEA" matches "JetBrains\IntelliJ IDEA 2026.2\bin\idea64.exe" (the newest name sorts last).
    const parts = folder.split('/'), parent = win32.join(root, ...parts.slice(0, -1)), prefix = parts.at(-1);
    const names = (await readdir(parent).catch(() => [])).filter(name => name === prefix || name.startsWith(`${prefix} `)).sort();
    for (const name of names.reverse()) { const path = win32.join(parent, name, 'bin', exe); if (await exists(path)) return path; }
  }
  return null;
}
async function findMac(names, dirs) {
  for (const name of names) for (const dir of dirs) {
    const path = join(dir, `${name}.app`); if (await isDir(path)) return path;
  }
  return null;
}

/** The editors found on this computer, each with how it is started. */
export async function detectEditors({ platform = process.platform, env = process.env, home = homedir(), appDirs = ['/Applications', join(home, 'Applications'), '/Applications/Setapp'] } = {}) {
  const wsl = await inWsl(env, platform), found = [];
  for (const editor of EDITORS) {
    // On Windows an editor on PATH counts as its .exe only: a .cmd launcher would need a shell.
    const path = platform === 'darwin' ? await findMac(editor.mac, appDirs)
      : platform === 'win32' ? await findWindows(editor.win, env) || await onPath(editor.bin.map(name => `${name}.exe`), env, platform)
      : await onPath(editor.bin, { ...env, PATH: [env.PATH, join(home, '.local/share/JetBrains/Toolbox/scripts')].filter(Boolean).join(delimiter) }, platform);
    if (path) found.push({ id: editor.id, name: editor.name, path });
  }
  return { platform, wsl, editors: found };
}

// ---- Preferences: the editor chosen last and editors added by hand, in the app data folder ----
const FILE = 'editors.json';
const clean = value => (typeof value === 'string' ? value.trim() : '');
/** An editor added by hand: a name and the full path of its program (on macOS also an .app). */
async function customEditor(input, platform, previous) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('Describe the editor with a name and the path of its program.', 'INVALID_EDITOR');
  const name = clean(input.name).slice(0, LIMITS.name), command = clean(input.command);
  if (!name) throw fail('Give the editor a name.', 'INVALID_EDITOR');
  const absolute = platform === 'win32' ? win32.isAbsolute(command) : isAbsolute(command);
  if (!command || command.length > LIMITS.path || !absolute || command.includes('\0')) throw fail('Enter the full path of the editor’s program, for example /Applications/Nova.app or C:\\Program Files\\Editor\\editor.exe.', 'INVALID_EDITOR');
  // A .cmd or .bat file needs a shell, where a folder name could become a command: the program itself is required.
  if (platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(command)) throw fail('Choose the editor’s .exe file. Scripts (.cmd, .bat) need a shell and are not started.', 'INVALID_EDITOR');
  const app = platform === 'darwin' && /\.app\/?$/i.test(command);
  if (app ? !(await isDir(command)) : !(await executable(command)) || await isDir(command)) throw fail(`No program was found at ${command}.`, 'EDITOR_NOT_FOUND', 404);
  const args = Array.isArray(input.args) ? input.args.map(clean).filter(Boolean) : [];
  if (args.length > LIMITS.args || args.some(arg => arg.length > LIMITS.arg || arg.includes('\0'))) throw fail(`An editor takes at most ${LIMITS.args} arguments of ${LIMITS.arg} characters.`, 'INVALID_EDITOR');
  return { id: typeof input.id === 'string' && previous.some(item => item.id === input.id) ? input.id : `custom-${randomUUID()}`, name, command, args };
}
export function editorPreferences(dataDir) {
  const path = join(dataDir, FILE);
  let queue = Promise.resolve();
  const read = async () => {
    try {
      const data = JSON.parse(await readFile(path, 'utf8'));
      return { preferred: typeof data.preferred === 'string' ? data.preferred : null, custom: Array.isArray(data.custom) ? data.custom.filter(item => item && typeof item.id === 'string' && typeof item.command === 'string').slice(0, LIMITS.custom) : [] };
    } catch { return { preferred: null, custom: [] }; }
  };
  const write = next => writeAtomic(path, `${JSON.stringify({ version: 1, ...next }, null, 1)}\n`);
  const serial = run => { const next = queue.then(run, run); queue = next.catch(() => {}); return next; };
  return {
    read,
    /** Replace the editors added by hand and/or the preferred editor. */
    update: ({ preferred, custom } = {}, { platform = process.platform } = {}) => serial(async () => {
      const current = await read();
      const next = { ...current };
      if (custom !== undefined) {
        if (!Array.isArray(custom) || custom.length > LIMITS.custom) throw fail(`Add at most ${LIMITS.custom} editors.`, 'INVALID_EDITOR');
        next.custom = [];
        for (const item of custom) next.custom.push(await customEditor(item, platform, current.custom));
      }
      if (preferred !== undefined) next.preferred = typeof preferred === 'string' && preferred ? preferred.slice(0, 100) : null;
      await write(next);
      return next;
    }),
    remember: preferred => serial(async () => { const current = await read(); if (current.preferred !== preferred) await write({ ...current, preferred }); }),
  };
}

/** Everything the page shows: found and added editors (never their paths on another device), and the preferred one. */
export async function editorList(preferences, options = {}) {
  const [found, saved] = await Promise.all([detectEditors(options), preferences.read()]);
  const editors = [...found.editors.map(({ id, name }) => ({ id, name, custom: false })), ...saved.custom.map(({ id, name }) => ({ id, name, custom: true }))];
  return { platform: found.platform, wsl: found.wsl, editors, preferred: editors.some(item => item.id === saved.preferred) ? saved.preferred : null,
    custom: saved.custom.map(({ id, name, command, args }) => ({ id, name, command, args })) };
}

/** The folder to open: the project's own, or one of its task's worktree. Both come from stored state and must exist. */
export async function editorFolder(project, taskId) {
  if (taskId) {
    const task = project.tasks?.find(item => item.id === taskId), path = task?.workspace?.path;
    if (!path) throw fail('This task has no worktree.', 'WORKTREE_MISSING', 404);
    if (!(await isDir(path)) || !(await exists(join(path, '.git')))) throw fail(`The task’s worktree is missing: ${path}`, 'WORKTREE_MISSING', 409);
    return path;
  }
  const folder = project.repository?.path || project.repository?.root;
  if (!folder) throw fail('Link this project to a folder first.', 'REPOSITORY_REQUIRED', 409);
  if (!(await isDir(folder))) throw fail(`The project folder is missing: ${folder}`, 'FOLDER_MISSING', 409);
  return folder;
}

const run = (command, args, options = {}) => new Promise(resolve => {
  execFile(command, args, { timeout: 15000, windowsHide: true, ...options }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout || '') }));
});
/** How one editor starts with a folder on this platform: a command and its arguments, never a shell line. */
export async function editorLaunch(editor, folder, { platform, wsl, exec = run }) {
  if (platform === 'darwin' && /\.app\/?$/i.test(editor.command || editor.path)) {
    const app = editor.command || editor.path, extra = editor.args?.length ? ['--args', ...editor.args.filter(arg => arg !== '{path}')] : [];
    return { command: 'open', args: ['-a', app, folder, ...extra], wait: true };
  }
  const program = editor.command || editor.path;
  // From WSL a Windows program (.exe under /mnt) takes a Windows path; the VS Code-style launchers handle WSL themselves.
  let target = folder;
  if (wsl && program.startsWith('/mnt/') && /\.exe$/i.test(program)) {
    const converted = await exec('wslpath', ['-w', folder]);
    if (!converted.ok || !converted.stdout.trim()) throw fail('The folder could not be turned into a Windows path for this editor.', 'OPEN_FAILED', 500);
    target = converted.stdout.trim();
  }
  const args = editor.args?.length ? editor.args.map(arg => (arg === '{path}' ? target : arg)) : [];
  if (!args.includes(target)) args.push(target);
  return { command: program, args, wait: false };
}

/** Open the project's folder (or a task's worktree) in an editor found on this computer or added by hand. */
export async function openInEditor(project, { editor: id, taskId } = {}, { preferences, platform = process.platform, env = process.env, home = homedir(), appDirs, launch = spawn, exec = run } = {}) {
  const folder = await editorFolder(project, taskId);
  const found = await detectEditors({ platform, env, home, appDirs }), saved = await preferences.read();
  const editor = found.editors.find(item => item.id === id) || saved.custom.find(item => item.id === id);
  if (!editor) throw fail('That editor is not on this computer any more. Choose another one.', 'EDITOR_NOT_FOUND', 404);
  const how = await editorLaunch(editor, folder, { platform, wsl: found.wsl, exec });
  if (how.wait) {
    // macOS `open` returns once the app has the folder, so a damaged or removed app is reported.
    const result = await exec(how.command, how.args);
    if (!result.ok) throw fail(`${editor.name} could not open the folder.`, 'OPEN_FAILED', 500);
  } else {
    await new Promise((resolve, reject) => {
      let child;
      try { child = launch(how.command, how.args, { detached: true, stdio: 'ignore', shell: false, windowsHide: false }); }
      catch { reject(fail(`${editor.name} could not be started.`, 'OPEN_FAILED', 500)); return; }
      child.once('error', () => reject(fail(`${editor.name} could not be started.`, 'OPEN_FAILED', 500)));
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  }
  await preferences.remember(editor.id);
  return { opened: editor.id, name: editor.name, folder: basename(folder), worktree: Boolean(taskId) };
}
