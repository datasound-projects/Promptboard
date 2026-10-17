/**
 * How to run a project: the commands its own files show (package.json scripts, Makefile targets, Python, Go, Rust,
 * Docker Compose, a static index.html) and its README's run section. Files are read from the target branch, where the
 * finished work is, so this also works while the folder has another branch checked out. Nothing here runs a command;
 * opening the folder, a terminal or index.html happens only on request, with the path the project already has.
 */
import { spawn } from 'node:child_process';
import { relative, posix, win32 } from 'node:path';
import { git } from './git.mjs';

const MAX_FILE = 256 * 1024;
const run = (label, command) => ({ label, command });

/** A file of the project folder as the target branch has it ('' when missing or too large). */
async function reader(root, folder, target) {
  const prefix = relative(root, folder).split(/[\\/]+/).filter(Boolean).join('/');
  const listing = target ? await git(['ls-tree', '--name-only', `${target}:${prefix}`], { cwd: root }).catch(() => '') : '';
  const names = new Set(listing.split('\n').filter(Boolean));
  const read = async name => {
    if (target && !names.has(name)) return '';
    const text = await git(['show', `${target}:${prefix ? `${prefix}/` : ''}${name}`], { cwd: root }).catch(() => '');
    return text.length > MAX_FILE ? '' : text;
  };
  return { names, read };
}

/** Commands found in the project's own files, in the order a person would run them. */
export async function detectCommands({ names, read }) {
  const commands = [];
  const has = name => names.has(name);
  if (has('package.json')) {
    let pkg = {};
    try { pkg = JSON.parse(await read('package.json')) || {}; } catch {}
    const manager = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
    const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    const script = name => (manager === 'npm' ? (['start', 'test'].includes(name) ? `npm ${name}` : `npm run ${name}`) : manager === 'yarn' ? `yarn ${name}` : `${manager} run ${name}`);
    if (Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length) commands.push(run('Install dependencies', `${manager} install`));
    const start = ['dev', 'start', 'serve', 'preview'].find(name => typeof scripts[name] === 'string');
    if (start) commands.push(run(start === 'dev' ? 'Start the development server' : 'Start it', script(start)));
    else if (typeof pkg.main === 'string' && /^[\w./-]+\.(?:c|m)?js$/.test(pkg.main)) commands.push(run('Start it', `node ${pkg.main}`));
    else if (typeof pkg.bin === 'string' && /^[\w./-]+\.(?:c|m)?js$/.test(pkg.bin)) commands.push(run('Start it', `node ${pkg.bin}`));
    if (typeof scripts.test === 'string' && !/no test specified/.test(scripts.test)) commands.push(run('Run the tests', script('test')));
  }
  if (has('requirements.txt')) commands.push(run('Install dependencies', 'python3 -m pip install -r requirements.txt'));
  else if (has('pyproject.toml')) commands.push(run('Install it', 'python3 -m pip install -e .'));
  if (has('manage.py')) commands.push(run('Start the server', 'python3 manage.py runserver'));
  else for (const file of ['app.py', 'main.py', 'server.py']) if (has(file)) { commands.push(run('Start it', `python3 ${file}`)); break; }
  if (has('go.mod')) commands.push(run('Start it', 'go run .'));
  if (has('Cargo.toml')) commands.push(run('Start it', 'cargo run'));
  if (has('Makefile')) {
    const targets = [...(await read('Makefile')).matchAll(/^(run|dev|start|serve):/gm)].map(match => match[1]);
    if (targets.length) commands.push(run('Start it with make', `make ${targets[0]}`));
  }
  const compose = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'].find(has);
  if (compose) commands.push(run('Start it with Docker', 'docker compose up'));
  // Several kinds of start commands are kept; the same command twice is not.
  return commands.filter((entry, index) => commands.findIndex(other => other.command === entry.command) === index).slice(0, 8);
}

/** The README section that says how to run or install the project (its first heading that matches), shortened. */
export function readmeRunSection(text) {
  const lines = String(text || '').split('\n');
  const start = lines.findIndex(line => /^#{1,4}\s+.*\b(run|running|start|starting|usage|getting started|quick ?start|install|installation|setup|development)\b/i.test(line));
  if (start < 0) return null;
  const level = lines[start].match(/^#+/)[0].length;
  const end = lines.findIndex((line, index) => index > start && new RegExp(`^#{1,${level}}\\s`).test(line));
  const body = lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
  return body ? { heading: lines[start].replace(/^#+\s*/, '').trim().slice(0, 120), text: body.slice(0, 2000) } : null;
}

/** What the finished-project panel shows. */
export async function runInfo(project) {
  const repository = project.repository;
  if (!repository) return { linked: false };
  const root = repository.root, folder = repository.path || root, target = project.targetBranch?.name || '';
  const files = await reader(root, folder, target);
  const folderBranch = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: folder }).catch(() => '')).trim();
  const readme = ['README.md', 'readme.md', 'README.markdown', 'README'].find(name => files.names.has(name));
  return {
    linked: true, path: folder, target, folderBranch, onTarget: Boolean(target) && folderBranch === target,
    commands: await detectCommands(files), readme: readme ? readmeRunSection(await files.read(readme)) : null,
    staticSite: files.names.has('index.html') && !files.names.has('package.json'),
  };
}

const OPENERS = {
  darwin: { folder: path => ['open', [path]], terminal: path => ['open', ['-a', 'Terminal', path]], index: path => ['open', [posix.join(path, 'index.html')]] },
  win32: { folder: path => ['explorer.exe', [path]], index: path => ['explorer.exe', [win32.join(path, 'index.html')]] },
  linux: { folder: path => ['xdg-open', [path]], index: path => ['xdg-open', [posix.join(path, 'index.html')]] },
};
/** What this computer can open: the folder everywhere, a terminal on macOS, index.html for static sites. */
export const openTargets = (platform = process.platform) => Object.keys(OPENERS[platform] || {});

/** Open the project folder (file manager), a terminal there, or its index.html, on this computer. */
export async function openProject(project, target, { platform = process.platform, launch = spawn } = {}) {
  const make = OPENERS[platform]?.[target];
  const folder = project.repository?.path || project.repository?.root;
  if (!folder) throw Object.assign(new Error('Link this project to a folder first.'), { code: 'REPOSITORY_REQUIRED', status: 409 });
  if (!make) throw Object.assign(new Error('This computer cannot open that from Promptboard.'), { code: 'OPEN_UNSUPPORTED', status: 400 });
  const [command, args] = make(folder);
  return new Promise((resolve, reject) => {
    let child;
    try { child = launch(command, args, { detached: true, stdio: 'ignore', shell: false, windowsHide: false }); }
    catch { reject(Object.assign(new Error('The folder could not be opened.'), { code: 'OPEN_FAILED', status: 500 })); return; }
    child.once('error', () => reject(Object.assign(new Error('The folder could not be opened.'), { code: 'OPEN_FAILED', status: 500 })));
    child.once('spawn', () => { child.unref(); resolve({ opened: target }); });
  });
}
