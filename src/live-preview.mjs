/**
 * Live preview: a card's own development server, started in its worktree on this computer, with a link to open it.
 * The command is the project's (argv, no shell, checked like test commands). Nothing here is stored: a preview stops
 * with Stop, when the card's worktree goes (Board.removeTaskWorktree and restoreTaskWorktree call stop) and when the
 * app stops, so none survives a restart. Every process is tracked and killed as a group, like test commands.
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { join } from 'node:path';
import { installed, parseCommand, startArgv } from './delivery.mjs';
import { git } from './git.mjs';
import { detectCommands } from './project-run.mjs';
import { killPidGroup, trackPid, untrackPid } from './providers.mjs';

export const PREVIEW_LIMIT = 3;
const OUTPUT_TAIL = 20 * 1024, OUTPUT_FILE = 5 * 1024 * 1024, OUTPUT_LINES = 40, SETUP_LIMIT = 5;
const RUNNING = ['installing', 'starting', 'ready'];
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export class PreviewError extends Error { constructor(message, code, status = 409) { super(message); this.code = code; this.status = status; } }

const exists = path => access(path).then(() => true, () => false);
const quoted = argv => argv.map(arg => /[\s"']/.test(arg) ? JSON.stringify(arg) : arg).join(' ');
const outputLines = text => String(text).replace(ANSI, '').split(/\r\n|\n|\r/).map(line => line.trimEnd()).filter(Boolean);

/** The first local address in a dev server's output: http(s)://localhost:N, 127.0.0.1:N or [::1]:N. Null when none. */
export function findAddress(text) {
  // A bare host:port counts too, but not one inside another address (ws://127.0.0.1:9229 is a debugger).
  const match = String(text).replace(ANSI, '').match(/(?:\b(https?):\/\/|(?<![\w/.:@-]))(localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})(?!\d)/);
  const port = Number(match?.[3]);
  return port > 0 && port < 65536 ? `${match[1] || 'http'}://${match[2]}:${port}/` : null;
}

/** The line that best says why a command stopped: the last one that names an error, else the last line. */
export function lastErrorLine(text) {
  const lines = outputLines(text);
  return (lines.findLast(line => /error|err!|failed|cannot|not found|exception|EADDRINUSE/i.test(line)) || lines.at(-1) || '').trim().slice(0, 300);
}

/** Stored preview settings (from the API, a backup or an older data folder): clean argv lists, or null. */
export function previewSettings(value) {
  const argv = list => Array.isArray(list) && list.length && list.length <= 50 && list.every(arg => typeof arg === 'string' && arg.length <= 1000 && !arg.includes('\0')) ? [...list] : null;
  const command = argv(value?.argv);
  return command ? { argv: command, setup: (Array.isArray(value.setup) ? value.setup : []).map(argv).filter(Boolean).slice(0, SETUP_LIMIT) } : null;
}

/** What the card's own files suggest: the start command, and an install step for Node projects (npm ci with a lockfile). */
export async function suggestPreview(folder) {
  const names = new Set(await readdir(folder).catch(() => []));
  const read = name => readFile(join(folder, name), 'utf8').then(text => text.length > 256 * 1024 ? '' : text, () => '');
  const commands = await detectCommands({ names, read });
  // Previews run on this computer, never in Docker.
  const start = commands.find(entry => entry.label.startsWith('Start') && !/Docker/.test(entry.label));
  if (!start) return null;
  const install = names.has('package.json') && commands.find(entry => entry.label === 'Install dependencies');
  return { command: start.command, setup: !install ? '' : install.command === 'npm install' && names.has('package-lock.json') ? 'npm ci' : install.command };
}

/** A port nobody uses right now, for the PORT variable. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer().unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

/** Whether the address answers HTTP at all; any status counts. Local dev certificates are not checked. */
function answers(url, timeoutMs = 2000) {
  return new Promise(resolve => {
    const request = (url.startsWith('https:') ? https : http).get(url, { timeout: timeoutMs, rejectUnauthorized: false }, response => { response.resume(); request.destroy(); resolve(true); });
    request.once('timeout', () => request.destroy());
    request.once('error', () => resolve(false));
  });
}

async function checkedCommand(text, label) {
  const argv = parseCommand(text);
  if (!argv.length || argv.some(arg => arg.length > 1000)) throw new PreviewError(`${label} is not valid.`, 'INVALID_COMMAND', 400);
  // A sentence typed here would start a program called “Start”; say so now instead of at every start.
  if (!(await installed(argv[0]))) throw new PreviewError(`“${argv[0].slice(0, 60)}” is not a program installed on this computer, so ${label.toLowerCase()} cannot run. Enter a command such as npm run dev.`, 'COMMAND_NOT_FOUND', 400);
  return argv;
}

export class LivePreviews {
  constructor(board, { readyMs = 120000, setupMs = 600000, pollMs = 250 } = {}) {
    this.board = board;
    this.readyMs = readyMs; this.setupMs = setupMs; this.pollMs = pollMs;
    this.items = new Map(); // taskId -> the card's preview, while it runs or after it failed
  }

  async #find(taskId) {
    for (const project of (await this.board.state()).projects) {
      const task = project.tasks.find(item => item.id === taskId);
      if (task) return { project, task };
    }
    throw new PreviewError('This card does not exist. Reload the board.', 'NOT_FOUND', 404);
  }

  #view(item) {
    if (!item) return null;
    const { taskId, projectId, number, title, status, url, port, message, startedAt, readyAt } = item;
    return { taskId, projectId, number, title, status, url, port, message, startedAt, readyAt, output: outputLines(item.tail).slice(-OUTPUT_LINES) };
  }

  /** The running previews, for the board's cards and the "stop another one first" list. */
  list() {
    return [...this.items.values()].filter(item => RUNNING.includes(item.status)).map(({ taskId, projectId, number, title, status, url }) => ({ taskId, projectId, number, title, status, url }));
  }

  /** Everything the card's Preview section shows. */
  async status(taskId) {
    const { project, task } = await this.#find(taskId);
    const folder = task.workspace?.status === 'ready' && await exists(task.workspace.path) ? task.workspace.path : null;
    const settings = previewSettings(project.preview);
    return { preview: this.#view(this.items.get(taskId)), workspace: Boolean(folder), running: this.list(),
      settings: settings && { command: quoted(settings.argv), setup: settings.setup.map(quoted) }, suggestion: folder ? await suggestPreview(folder) : null };
  }

  /** Check and save the project's preview command and setup commands. An empty command removes the setting. */
  async setSettings(projectId, { command, setup = [], expectedRevision } = {}) {
    if (typeof command !== 'string') throw new PreviewError('Enter the preview command as text.', 'INVALID_INPUT', 400);
    if (!Array.isArray(setup) || setup.length > SETUP_LIMIT || setup.some(line => typeof line !== 'string')) throw new PreviewError(`Enter at most ${SETUP_LIMIT} setup commands, one per line.`, 'INVALID_INPUT', 400);
    let preview = null;
    if (command.trim()) {
      const steps = [];
      for (const [index, line] of setup.entries()) if (line.trim()) steps.push(await checkedCommand(line, `Setup command ${index + 1}`));
      preview = { argv: await checkedCommand(command, 'The preview command'), setup: steps };
    }
    return this.board.setPreview(projectId, { preview, expectedRevision });
  }

  /** Start the card's preview in the background: setup when node_modules is missing, then the command. */
  async start(taskId, { confirm } = {}) {
    if (confirm !== true) throw new PreviewError('Confirm the preview start first.', 'CONFIRMATION_REQUIRED', 400);
    const { project, task } = await this.#find(taskId);
    const ws = task.workspace;
    if (ws?.status !== 'ready' || !(await exists(ws.path))) throw new PreviewError('This card has no worktree yet. A preview runs the card’s own copy of the code.', 'WORKSPACE_REQUIRED');
    const settings = previewSettings(project.preview);
    if (!settings) throw new PreviewError('Set a preview command for this project first.', 'NO_PREVIEW_COMMAND');
    const logs = join(this.board.dataDir, 'previews');
    await mkdir(logs, { recursive: true, mode: 0o700 });
    // Claimed with no await between the check and the claim: two clicks never start two servers.
    if (RUNNING.includes(this.items.get(taskId)?.status)) return this.status(taskId);
    const running = this.list();
    if (running.length >= PREVIEW_LIMIT) throw new PreviewError(`Stop another preview first. Running now: ${running.map(item => `${Number.isInteger(item.number) ? `#${item.number} ` : ''}${item.title}`).join(', ')}.`, 'PREVIEW_LIMIT');
    const item = { taskId, projectId: project.id, number: task.number, title: task.title, status: 'starting', url: null, port: null, message: '', startedAt: Date.now(), readyAt: null, tail: '', written: 0, pids: new Set(), closing: [], stopped: false,
      log: createWriteStream(join(logs, `${taskId}.log`), { mode: 0o600 }).on('error', () => {}) }; // A lost log never stops the preview.
    this.items.set(taskId, item);
    this.#run(item, ws.path, settings).catch(() => this.#fail(item, 'The preview could not start.'));
    return this.status(taskId);
  }

  async #run(item, cwd, { argv, setup }) {
    item.port = await freePort();
    if (setup.length && !(await exists(join(cwd, 'node_modules')))) {
      // Installing into a folder Git does not ignore would add every dependency to the card's changes.
      if (!(await git(['check-ignore', '-q', 'node_modules/'], { cwd }).then(() => true, () => false))) return this.#fail(item, 'Install failed: node_modules is not in .gitignore, so installing would add every dependency to this card’s changes. Add node_modules to .gitignore, or remove the setup command.');
      item.status = 'installing';
      for (const command of setup) {
        if (item.stopped) return;
        const result = await this.#spawn(item, command, cwd, this.setupMs).done;
        if (item.stopped) return;
        if (result.code !== 0) return this.#fail(item, result.timedOut ? `Install failed: ${quoted(command)} did not finish within ${Math.round(this.setupMs / 60000)} minutes.` : `Install failed: ${lastErrorLine(item.tail) || `${quoted(command)} exited with ${result.code ?? result.signal}.`}`);
      }
    }
    if (item.stopped) return;
    item.status = 'starting';
    const server = this.#spawn(item, argv, cwd);
    let exited = false;
    server.done.then(result => {
      exited = true;
      if (!item.stopped && this.items.get(item.taskId) === item) this.#fail(item, `The preview stopped: ${lastErrorLine(item.tail) || `${quoted(argv)} exited with ${result.code ?? result.signal}.`}`);
    });
    const deadline = Date.now() + this.readyMs;
    while (!item.stopped && !exited) {
      const printed = findAddress(item.tail), url = printed || `http://127.0.0.1:${item.port}/`;
      if (await answers(url)) {
        if (item.stopped || exited) return;
        Object.assign(item, { status: 'ready', url, readyAt: Date.now() });
        return;
      }
      if (Date.now() > deadline) {
        this.#fail(item, printed ? `${printed} did not answer within 2 minutes.` : 'No address appeared within 2 minutes.');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, this.pollMs));
    }
  }

  /** One command in the card folder, in its own process group, with output kept as a tail and a log. */
  #spawn(item, argv, cwd, timeoutMs = 0) {
    let child, timer, timedOut = false;
    const done = new Promise(resolve => {
      const command = startArgv(argv);
      try {
        child = spawn(command[0], command.slice(1), { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, PORT: String(item.port), HOST: '127.0.0.1', BROWSER: 'none' } });
      } catch { resolve({ code: null, signal: null }); return; }
      if (child.pid) { trackPid(child.pid); item.pids.add(child.pid); }
      const collect = chunk => {
        item.tail = (item.tail + chunk.toString('utf8')).slice(-OUTPUT_TAIL);
        if (item.written < OUTPUT_FILE && !item.log.writableEnded) { item.log.write(chunk); item.written += chunk.length; }
      };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      if (timeoutMs) timer = setTimeout(() => { timedOut = true; killPidGroup(child.pid, 'SIGKILL'); }, timeoutMs);
      child.once('error', error => { if (error.code === 'ENOENT') item.tail += `\nCommand not found: ${argv[0]}\n`; });
      // A background child can keep the pipes open after the command exits: stop waiting for it.
      child.once('exit', () => setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, 2000).unref());
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        // What the command left running in its process group goes with it ("The preview stopped" means stopped). The group
        // only, never the bare ID: the command has exited, so that ID may be another program's by now. Windows has no groups.
        if (child.pid && process.platform !== 'win32') try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        if (child.pid) { untrackPid(child.pid); item.pids.delete(child.pid); }
        resolve({ code: timedOut ? null : code, signal, timedOut });
      });
    });
    item.closing.push(done);
    return { done };
  }

  /** The first failure is the reason shown; the exit it causes (or a later one) does not replace it. */
  #fail(item, message) {
    if (item.stopped || item.status === 'failed' || this.items.get(item.taskId) !== item) return;
    Object.assign(item, { status: 'failed', message, url: null });
    for (const pid of item.pids) killPidGroup(pid, 'SIGKILL');
    item.log.end();
  }

  /** Stop the card's preview and wait (up to 5 s) until its processes have exited, so its folder is free. */
  async stop(taskId) {
    const item = this.items.get(taskId);
    if (!item) return;
    this.items.delete(taskId);
    item.stopped = true;
    for (const pid of item.pids) {
      killPidGroup(pid, 'SIGTERM');
      setTimeout(() => killPidGroup(pid, 'SIGKILL'), 3000).unref();
    }
    let timer;
    await Promise.race([Promise.allSettled(item.closing), new Promise(resolve => { timer = setTimeout(resolve, 5000); timer.unref(); })]);
    clearTimeout(timer);
    item.log.end();
  }

  /** App shutdown: every preview ends now. */
  stopAll() {
    for (const item of this.items.values()) { item.stopped = true; for (const pid of item.pids) killPidGroup(pid, 'SIGKILL'); item.log.end(); }
    this.items.clear();
  }
}
