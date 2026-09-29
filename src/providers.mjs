import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';

const PROVIDERS = Object.freeze({
  codex: { name: 'Codex CLI', packageEntry: ['@openai', 'codex', 'bin', 'codex.js'] },
  claude: { name: 'Claude Code', packageEntry: ['@anthropic-ai', 'claude-code', 'cli.js'] },
  agy: { name: 'Antigravity CLI', packageEntry: [] },
  gemini: { name: 'Gemini CLI', packageEntry: ['@google', 'gemini-cli', 'dist', 'index.js'] },
});
const MAX_INPUT = 2 * 1024 * 1024;
const MAX_STDOUT = 2 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;
const GEMINI_POLICY = '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n\n[[rule]]\ntoolName = "*"\nmcpName = "*"\ndecision = "deny"\npriority = 999\n';

export class ProviderError extends Error {
  constructor(message, code) { super(message); this.name = 'ProviderError'; this.code = code; }
}

function validateProvider(provider) {
  if (!Object.hasOwn(PROVIDERS, provider)) throw new ProviderError('Select Codex, Claude Code, Gemini CLI, or Antigravity CLI.', 'INVALID_PROVIDER');
}

function validateModel(model) {
  if (model === undefined || model === null || model === '') return '';
  if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,99}$/.test(model)) {
    throw new ProviderError('Use a model ID or alias with no spaces or command flags.', 'INVALID_MODEL');
  }
  return model;
}

/** Build arguments only. A Gemini policy file is supplied by runProvider. */
export function buildCommand({ provider, model, effort = '', policyPath } = {}) {
  validateProvider(provider);
  model = validateModel(model);
  validateEffort(provider, effort);
  let args;
  if (provider === 'codex') {
    args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never',
      '--config', 'approval_policy="never"', '--config', 'web_search="disabled"',
      '--disable', 'shell_tool', '--disable', 'unified_exec', '--json'];
  } else if (provider === 'claude') {
    args = ['--print', '--output-format', 'json', '--tools', '', '--disallowedTools', '*',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands',
      '--no-session-persistence', '--max-turns', '1'];
  } else if (provider === 'agy') {
    args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--sandbox'];
  } else {
    // This adds a deny rule without replacing the user's settings or auth files.
    args = ['--output-format', 'json', '--approval-mode', 'plan', '--extensions', 'none',
      '--allowed-mcp-server-names', '', '--allowed-tools', ''];
    if (typeof policyPath !== 'string' || !isAbsolute(policyPath) || policyPath.includes('\0')) {
      throw new ProviderError('Gemini needs an absolute deny-tools policy file path.', 'INVALID_POLICY');
    }
    args.push('--policy', policyPath);
  }
  if (effort) {
    if (provider === 'codex') args.push('--config', `model_reasoning_effort="${effort}"`);
    else args.push('--effort', effort);
  }
  if (model) args.push('--model', model);
  if (provider === 'codex') args.push('-');
  return { command: provider, args };
}

async function isExecutable(path) {
  try { await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return (await stat(path)).isFile(); }
  catch { return false; }
}

export async function resolveExecutable(provider) {
  // Ignore relative and empty PATH entries. Do not discover binaries in the request cwd.
  for (const dir of (process.env.PATH || '').split(delimiter).filter(isAbsolute)) {
    const path = join(dir, provider + (process.platform === 'win32' ? '.exe' : ''));
    if (await isExecutable(path)) return { command: path, prefix: [] };
    if (process.platform === 'win32' && PROVIDERS[provider].packageEntry.length) {
      // npm .cmd files need a shell. Use the known package's JS entry instead.
      const entry = join(dir, 'node_modules', ...PROVIDERS[provider].packageEntry);
      if (await isExecutable(entry)) return { command: process.execPath, prefix: [entry] };
    }
  }
  return null;
}

export function stopProcess(child, signal = 'SIGTERM') {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) { if (error.code !== 'ESRCH') { try { child.kill(signal); } catch {} } }
}

export function execute({ command, args, cwd, input = '', signal, timeoutMs, maxStdout = MAX_STDOUT, maxStderr = MAX_STDERR, env = {} }) {
  if (signal?.aborted) return Promise.reject(new ProviderError('Generation was cancelled.', 'ABORTED'));
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env, NO_COLOR: '1', FORCE_COLOR: '0' } });
    } catch { reject(new ProviderError('The CLI could not start. Check its installation.', 'SPAWN_FAILED')); return; }
    const out = [], err = [];
    let outSize = 0, errSize = 0, failure, killTimer, settled = false;
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); };
    const fail = (error) => {
      if (failure || settled) return;
      failure = error;
      stopProcess(child);
      killTimer = setTimeout(() => stopProcess(child, 'SIGKILL'), 1000);
      killTimer.unref();
    };
    const abort = () => fail(new ProviderError('Generation was cancelled.', 'ABORTED'));
    const timer = setTimeout(() => fail(new ProviderError('The CLI took too long. Try again or use a faster model.', 'TIMEOUT')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', chunk => {
      outSize += chunk.length;
      if (outSize > maxStdout) fail(new ProviderError('The CLI output exceeded the size limit.', 'OUTPUT_LIMIT'));
      else if (!failure) out.push(chunk);
    });
    child.stderr.on('data', chunk => {
      errSize += chunk.length;
      if (errSize > maxStderr) fail(new ProviderError('The CLI diagnostic output exceeded the size limit.', 'OUTPUT_LIMIT'));
      else if (!failure) err.push(chunk);
    });
    child.on('error', () => {
      if (settled) return;
      settled = true; cleanup();
      reject(failure || new ProviderError('The CLI could not start. Check its installation.', 'SPAWN_FAILED'));
    });
    child.on('close', (code) => {
      if (settled) return;
      // A child can exit on TERM before its descendants do. Complete group cleanup
      // before clearing the grace timer and returning cancellation to the caller.
      if (failure && process.platform !== 'win32') stopProcess(child, 'SIGKILL');
      settled = true; cleanup();
      if (failure) { reject(failure); return; }
      if (code !== 0) {
        // Do not send raw diagnostics (which can include secrets or request text) to the browser.
        reject(new ProviderError(`The CLI exited with code ${code ?? 'unknown'}. Check login, model access, CLI version, and policy in your terminal.`, 'CLI_FAILED'));
        return;
      }
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.on('error', (error) => {
      // A CLI can exit before consuming stdin. Its exit code is the useful error.
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') fail(new ProviderError('The CLI could not read the request.', 'INPUT_FAILED'));
    });
    child.stdin.end(input);
  });
}

/** Detection checks executable presence and version; it does not log in or call a model. */
export async function detectProviders() {
  return Promise.all(Object.entries(PROVIDERS).map(async ([id, definition]) => {
    const resolved = await resolveExecutable(id);
    if (!resolved) return { id, name: definition.name, available: false, reason: 'Install this CLI and add it to PATH.' };
    try {
      const result = await execute({ command: resolved.command, args: [...resolved.prefix, '--version'], timeoutMs: 5000, maxStdout: 8192, maxStderr: 8192 });
      return { id, name: definition.name, available: true, version: result.stdout.trim().slice(0, 160) || 'Installed' };
    } catch {
      return { id, name: definition.name, available: false, reason: 'The CLI version check failed. Check its installation.' };
    }
  }));
}

export function parseProviderOutput(provider, stdout) {
  validateProvider(provider);
  let text;
  try {
    if (provider === 'codex') {
      const events = stdout.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
      if (events.some(event => event.type === 'error' || event.type === 'turn.failed')) throw new Error('CLI error');
      const messages = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message');
      text = messages.at(-1)?.item?.text;
    } else {
      const result = provider === 'agy' ? stdout.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)).filter(e => e.event === 'result').at(-1)?.result : JSON.parse(stdout);
      if (!result || (provider === 'agy' && result.status !== 'SUCCESS')) throw new Error('Incomplete result');
      if (result.error || result.is_error) throw new Error('CLI error');
      text = provider === 'claude' ? result.result : result.response;
    }
    if (typeof text !== 'string' || !text.trim()) throw new Error('Missing response');
    return text.trim();
  } catch { throw new ProviderError('The CLI did not return a valid final answer. Check its version and try again.', 'INVALID_OUTPUT'); }
}

function prepareInput(provider, prompt) {
  if (provider === 'agy') return JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n';
  if (provider !== 'gemini') return prompt;
  // Gemini runs @file and slash-command preprocessing even in headless mode.
  // Encode @, preserve the original text as JSON, and avoid a leading slash.
  const encoded = JSON.stringify(prompt).replaceAll('@', '\\u0040');
  return `Decode the JSON string below. Use its text as your request. Keep all literal text from that request.\n${encoded}`;
}

export async function runProvider({ provider, model, effort = '', prompt, cwd, signal, timeoutMs = 120000 } = {}) {
  validateProvider(provider);
  model = validateModel(model);
  validateEffort(provider, effort);
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > MAX_INPUT) {
    throw new ProviderError('Provide a non-empty prompt at most 2 MiB.', 'INVALID_INPUT');
  }
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new ProviderError('Use an isolated absolute working directory.', 'INVALID_CWD');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 600000) throw new ProviderError('Timeout must be 10–600000 milliseconds.', 'INVALID_TIMEOUT');
  if (signal?.aborted) throw new ProviderError('Generation was cancelled.', 'ABORTED');
  const executable = await resolveExecutable(provider);
  if (!executable) throw new ProviderError(`${PROVIDERS[provider].name} was not found. Install it and sign in from your terminal.`, 'NOT_INSTALLED');
  const started = Date.now();
  let policyDir;
  try {
    let policyPath;
    if (provider === 'gemini') {
      policyDir = await mkdtemp(join(tmpdir(), 'ste-policy-'));
      policyPath = join(policyDir, 'deny-tools.toml');
      await writeFile(policyPath, GEMINI_POLICY, { mode: 0o600 });
    }
    const { args } = buildCommand({ provider, model, effort, policyPath });
    const result = await execute({ command: executable.command, args: [...executable.prefix, ...args], cwd, input: prepareInput(provider, prompt), signal, timeoutMs, env: provider === 'claude' && effort ? { CLAUDE_CODE_EFFORT_LEVEL: effort } : {} });
    return { text: parseProviderOutput(provider, result.stdout), provider, model: model || '', effort, ...parseRunMetadata(provider, result.stdout), durationMs: Date.now() - started };
  } finally { if (policyDir) await rm(policyDir, { recursive: true, force: true }); }
}

export function validateEffort(provider, effort = '') {
  const levels = { codex: ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'], claude: ['', 'low', 'medium', 'high', 'xhigh', 'max'], agy: ['', 'low', 'medium', 'high'], gemini: [''] };
  if (!levels[provider]?.includes(effort)) throw new ProviderError('This CLI does not support that effort setting.', 'INVALID_EFFORT');
}

export function parseRunMetadata(provider, stdout) {
  try {
    if (provider === 'claude') {
      const result = JSON.parse(stdout);
      return { reportedModels: Object.keys(result.modelUsage || {}) };
    }
    if (provider === 'gemini') return { reportedModels: Object.keys(JSON.parse(stdout).stats?.models || {}) };
  } catch {}
  return { reportedModels: [] };
}
