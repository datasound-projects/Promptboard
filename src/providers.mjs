import { spawn } from 'node:child_process';
import { constants, rmSync } from 'node:fs';
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

// A model ID or alias: no spaces, and it cannot start like a command flag.
export const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,99}$/;

function validateModel(model) {
  if (model === undefined || model === null || model === '') return '';
  if (typeof model !== 'string' || !SAFE_MODEL.test(model)) {
    throw new ProviderError('Use a model ID or alias with no spaces or command flags.', 'INVALID_MODEL');
  }
  return model;
}

/** Build arguments only. A Gemini policy file is supplied by runProvider. */
export function buildCommand({ provider, model, effort = '', policyPath } = {}) {
  validateProvider(provider);
  model = validateModel(model);
  validateEffort(provider, effort);
  if (provider === 'agy' && effort) {
    const pinned = model.match(/-(low|medium|high)$/)?.[1];
    if (pinned && effort !== pinned) throw new ProviderError('This Antigravity model fixes its effort level. Choose the matching effort or CLI default.', 'INVALID_EFFORT');
  }
  let args;
  if (provider === 'codex') {
    args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never',
      '--config', 'approval_policy="never"', '--config', 'web_search="disabled"',
      '--config', 'features.apps=false', '--config', 'features.plugins=false', '--config', 'features.hooks=false',
      '--disable', 'shell_tool', '--disable', 'unified_exec', '--json'];
  } else if (provider === 'claude') {
    // stream-json exposes documented rate_limit_event and assistant error codes.
    args = ['--print', '--output-format', 'stream-json', '--verbose', '--tools', '', '--disallowedTools', '*',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands',
      '--no-session-persistence', '--max-turns', '1'];
  } else if (provider === 'agy') {
    args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--sandbox'];
  } else {
    // This adds a deny rule without replacing the user's settings or auth files.
    // Plan mode is experimental in stable Gemini releases. The wildcard policy
    // denies tools in default mode too, without requiring a user setting change.
    args = ['--output-format', 'json', '--approval-mode', 'default', '--extensions', 'none',
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

// Only processes and folders created by this app are tracked, so shutdown never
// signals an unrelated process (for example, one that holds the same port).
const ownedChildren = new Set();
const ownedDirs = new Set();
export function trackChild(child) {
  ownedChildren.add(child);
  child.once('exit', () => ownedChildren.delete(child));
  child.once('error', () => ownedChildren.delete(child));
  return child;
}
// Terminal sessions (node-pty) are tracked by process ID; each runs in its own session/group.
const ownedPids = new Set();
export function trackPid(pid) { if (Number.isInteger(pid) && pid > 0) ownedPids.add(pid); }
export function untrackPid(pid) { ownedPids.delete(pid); }
export function killPidGroup(pid, signal = 'SIGTERM') {
  const killRoot = () => { try { process.kill(pid, signal); } catch {} };
  if (process.platform === 'win32') {
    // No process groups: end the tree while its root exists (killing the root first hides its
    // descendants). Detached, so it also completes when the app exits right after.
    try { spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { detached: true, windowsHide: true, stdio: 'ignore' }).on('error', killRoot).unref(); }
    catch { killRoot(); }
    return;
  }
  try { process.kill(-pid, signal); }
  catch { killRoot(); }
}
export function killOwnedProcesses(signal = 'SIGKILL') {
  for (const child of ownedChildren) stopProcess(child, signal);
  for (const pid of ownedPids) killPidGroup(pid, signal);
  return ownedChildren.size + ownedPids.size;
}
export async function makeTempDir(prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  ownedDirs.add(path);
  return path;
}
export async function removeTempDir(path) {
  await rm(path, { recursive: true, force: true });
  ownedDirs.delete(path);
}
export function removeOwnedTempDirsSync() {
  for (const path of ownedDirs) { try { rmSync(path, { recursive: true, force: true }); } catch {} }
  ownedDirs.clear();
}

/** Spawn a tracked CLI process in its own process group (POSIX). */
export function spawnOwned(command, args, { cwd, env = {} } = {}) {
  return trackChild(spawn(command, args, { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env, NO_COLOR: '1', FORCE_COLOR: '0' } }));
}

/**
 * Resolve once the child's stdio closes. A descendant outside the process group can
 * keep a pipe open after the child exits; destroy the pipes after a short grace period.
 */
export function closedWithin(child, graceMs = 2000) {
  return new Promise(resolve => {
    if (child.exitCode !== null && child.stdout?.destroyed !== false && child.stderr?.destroyed !== false) { resolve(); return; }
    let timer;
    const done = () => { clearTimeout(timer); resolve(); };
    child.once('close', done);
    child.once('error', done);
    const destroy = () => { for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy(); setImmediate(done); };
    const arm = () => { timer = setTimeout(destroy, graceMs); timer.unref(); };
    if (child.exitCode !== null || child.signalCode !== null) arm(); else child.once('exit', arm);
  });
}

export function execute({ command, args, cwd, input = '', signal, timeoutMs, maxStdout = MAX_STDOUT, maxStderr = MAX_STDERR, env = {} }) {
  if (signal?.aborted) return Promise.reject(new ProviderError('Generation was cancelled.', 'ABORTED'));
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnOwned(command, args, { cwd, env });
    } catch { reject(new ProviderError('The CLI could not start. Check its installation.', 'SPAWN_FAILED')); return; }
    const out = [], err = [];
    let outSize = 0, errSize = 0, failure, killTimer, hardTimer, settled = false;
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); clearTimeout(hardTimer); signal?.removeEventListener('abort', abort); };
    const fail = (error) => {
      if (failure || settled) return;
      failure = error;
      stopProcess(child);
      killTimer = setTimeout(() => stopProcess(child, 'SIGKILL'), 1000);
      killTimer.unref();
      // If a pipe stays open after SIGKILL, settle anyway so the caller is never stuck.
      hardTimer = setTimeout(() => { for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy(); finish(null); }, 3000);
      hardTimer.unref();
    };
    const abort = () => fail(new ProviderError('Generation was cancelled.', 'ABORTED'));
    // Compose explicitly passes null: a healthy CLI runs until completion or Cancel.
    // Detection/authentication and other callers retain their bounded timeouts.
    const timer = timeoutMs === null ? undefined : setTimeout(() => fail(new ProviderError('The CLI took too long. Try again or use a faster model.', 'TIMEOUT')), timeoutMs);
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
    const finish = (code) => {
      if (settled) return;
      // A child can exit on TERM before its descendants do. Complete group cleanup
      // before clearing the grace timer and returning cancellation to the caller.
      if (failure && process.platform !== 'win32') stopProcess(child, 'SIGKILL');
      settled = true; cleanup();
      if (failure) { reject(failure); return; }
      const stdout = Buffer.concat(out).toString('utf8'), stderr = Buffer.concat(err).toString('utf8');
      if (code !== 0) {
        // Do not send raw diagnostics (which can include secrets or request text) to the browser.
        // The private details are kept off the enumerable fields for local classification only.
        const error = new ProviderError(`The CLI exited with code ${code ?? 'unknown'}. Check login, model access, CLI version, and policy in your terminal.`, 'CLI_FAILED');
        Object.defineProperty(error, 'details', { value: { stdout, stderr, exitCode: code }, enumerable: false });
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    };
    child.on('close', finish);
    // A descendant that escaped the process group can hold stdout open after the
    // CLI exits. Do not wait for it indefinitely.
    child.once('exit', () => { const timer = setTimeout(() => { for (const stream of [child.stdout, child.stderr]) stream?.destroy(); }, 2000); timer.unref(); child.once('close', () => clearTimeout(timer)); });
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

const jsonLines = stdout => stdout.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
// Claude uses stream-json; accept one JSON result object from older fixtures too.
const claudeResult = stdout => { const trimmed = stdout.trim(); return trimmed.startsWith('{') && !trimmed.includes('\n') ? JSON.parse(trimmed) : jsonLines(stdout).filter(e => e.type === 'result' || (e.type === undefined && 'result' in e)).at(-1); };

export function parseProviderOutput(provider, stdout) {
  validateProvider(provider);
  let text;
  try {
    if (provider === 'codex') {
      const events = jsonLines(stdout);
      if (events.some(event => event.type === 'error' || event.type === 'turn.failed')) throw new Error('CLI error');
      const messages = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message');
      text = messages.at(-1)?.item?.text;
    } else {
      const result = provider === 'agy' ? jsonLines(stdout).filter(e => e.event === 'result').at(-1)?.result : provider === 'claude' ? claudeResult(stdout) : JSON.parse(stdout);
      if (!result || (provider === 'agy' && result.status !== 'SUCCESS')) throw new Error('Incomplete result');
      if (result.error || result.is_error) throw new Error('CLI error');
      text = provider === 'claude' ? result.result : result.response;
    }
    if (typeof text !== 'string' || !text.trim()) throw new Error('Missing response');
    return text.trim();
  } catch { throw new ProviderError('The CLI did not return a valid final answer. Check its version and try again.', 'INVALID_OUTPUT'); }
}

/**
 * Stable, user-facing failure codes. Messages are fixed text: provider output is
 * inspected locally for structured fields but never returned to the browser.
 */
export const FAILURE_MESSAGES = Object.freeze({
  QUOTA_EXHAUSTED: 'Your CLI account reports that its included usage is used up. Check your plan or add usage in the provider account, then try again.',
  RATE_LIMITED: 'The provider is temporarily limiting requests for this account. Wait, then try again.',
  AUTH_REQUIRED: 'The CLI is not signed in, or its sign-in expired. Use Connect / Sign in, then try again.',
  MODEL_UNAVAILABLE: 'The selected model is not available to this CLI account. Refresh models or choose another model.',
  PROVIDER_UNAVAILABLE: 'The provider service is overloaded or unavailable. Try again later.',
  NETWORK_ERROR: 'The CLI could not reach its provider. Check your network connection, then try again.',
  POLICY_DENIED: 'A provider, CLI, sandbox, or organization policy blocked this request.',
  ACCOUNT_UNAVAILABLE: 'The provider reports a billing or account problem. Check the account in the provider console.',
  CLIENT_UNSUPPORTED: 'The provider no longer supports this CLI for the current account. Check the provider’s supported clients and sign-in options, then try again.',
  TIMEOUT: 'The CLI took too long. Try again or use a faster model.',
  ABORTED: 'Generation was cancelled.',
  CLI_FAILED: 'The CLI failed for an unrecognized reason. Run the CLI in your terminal to see its diagnostics.',
});

const failure = (code, extra = {}) => Object.assign(new ProviderError(FAILURE_MESSAGES[code], code), extra);
// Provider reset times are epoch seconds (Claude) or milliseconds; return ISO or nothing.
const resetTime = value => {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const date = new Date(value < 1e12 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};
const safeLines = text => { try { return jsonLines(text); } catch { return text.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); } };
const firstJson = text => { const trimmed = text.trim(); try { return JSON.parse(trimmed); } catch {} const at = trimmed.indexOf('{'); try { return at >= 0 ? JSON.parse(trimmed.slice(at)) : undefined; } catch { return undefined; } };

// Claude error types (result and StopFailure hook) -> failure codes.
export const CLAUDE_ERRORS = Object.freeze({ authentication_failed: 'AUTH_REQUIRED', cloud_credential_error: 'AUTH_REQUIRED', oauth_org_not_allowed: 'POLICY_DENIED',
  account_on_hold: 'ACCOUNT_UNAVAILABLE', billing_error: 'ACCOUNT_UNAVAILABLE', rate_limit: 'RATE_LIMITED', overloaded: 'PROVIDER_UNAVAILABLE',
  server_error: 'PROVIDER_UNAVAILABLE', model_not_found: 'MODEL_UNAVAILABLE' });
const GEMINI_ERRORS = { TerminalQuotaError: 'QUOTA_EXHAUSTED', RetryableQuotaError: 'RATE_LIMITED', FatalAuthenticationError: 'AUTH_REQUIRED',
  UnauthorizedError: 'AUTH_REQUIRED', ForbiddenError: 'POLICY_DENIED', ModelNotFoundError: 'MODEL_UNAVAILABLE', FatalSandboxError: 'POLICY_DENIED', FetchError: 'NETWORK_ERROR' };
const httpCode = status => status === 401 ? 'AUTH_REQUIRED' : status === 403 ? 'POLICY_DENIED' : status === 429 ? 'RATE_LIMITED'
  : status === 529 || (status >= 500 && status < 600) ? 'PROVIDER_UNAVAILABLE' : undefined;

/**
 * Classify a failed run from structured provider fields first. Text patterns are
 * used only where the CLI documents no structured code (Codex exec, Antigravity).
 * Returns null when the failure is not recognized.
 */
export function classifyProviderFailure(provider, { stdout = '', stderr = '', exitCode } = {}) {
  if (provider === 'claude') {
    const events = safeLines(stdout);
    const rejected = events.filter(e => e.type === 'rate_limit_event' && e.rate_limit_info?.status === 'rejected').at(-1)?.rate_limit_info;
    if (rejected) {
      // credits_required is Claude's documented signal that included subscription usage is exhausted.
      return failure(rejected.errorCode === 'credits_required' ? 'QUOTA_EXHAUSTED' : 'RATE_LIMITED', { resetsAt: resetTime(rejected.resetsAt) });
    }
    const assistantError = events.filter(e => e.type === 'assistant' && typeof e.error === 'string').at(-1)?.error;
    if (CLAUDE_ERRORS[assistantError]) return failure(CLAUDE_ERRORS[assistantError]);
    const result = events.filter(e => e.type === 'result').at(-1) || firstJson(stdout);
    if (result?.stop_reason === 'refusal' || events.some(e => e.type === 'assistant' && e.message?.stop_reason === 'refusal')) return failure('POLICY_DENIED');
    const code = httpCode(result?.api_error_status);
    return code ? failure(code) : null;
  }
  if (provider === 'gemini') {
    for (const text of [stdout, stderr]) {
      const type = firstJson(text)?.error?.type;
      if (GEMINI_ERRORS[type]) return failure(GEMINI_ERRORS[type]);
    }
    // Gemini can reject the client during Google account setup, before its JSON
    // error formatter starts. Match the backend reason in the CLI diagnostic.
    if (/\bIneligibleTierError\b/.test(stderr) && /reasonCode:\s*['"]UNSUPPORTED_CLIENT['"]/.test(stderr)) return failure('CLIENT_UNSUPPORTED');
    if (exitCode === 41) return failure('AUTH_REQUIRED'); // Documented FATAL_AUTHENTICATION_ERROR exit code.
    if (exitCode === 44) return failure('POLICY_DENIED'); // Documented sandbox error exit code.
    return null;
  }
  if (provider === 'codex') {
    // `codex exec --json` reports only a message string for errors. Match known CLI texts narrowly.
    const messages = safeLines(stdout).flatMap(e => e.type === 'error' ? [e.message] : e.type === 'turn.failed' ? [e.error?.message] : [])
      .filter(x => typeof x === 'string').concat(stderr).join('\n');
    if (/you['’]ve hit your usage limit/i.test(messages)) return failure('QUOTA_EXHAUSTED');
    if (/(?:last status|unexpected status):? 429\b|429 Too Many Requests/i.test(messages)) return failure('RATE_LIMITED');
    if (/(?:last status|unexpected status):? 401\b|\bNot logged in\b/i.test(messages)) return failure('AUTH_REQUIRED');
    if (/(?:last status|unexpected status):? 5\d\d\b/i.test(messages)) return failure('PROVIDER_UNAVAILABLE');
    if (/stream disconnected before completion|error sending request/i.test(messages)) return failure('NETWORK_ERROR');
    if (/The ['’][^'’\n]{1,100}['’] model is not supported when using Codex|model ['’][^'’\n]{1,100}['’] (?:was not found|does not exist|is not available)/i.test(messages)) return failure('MODEL_UNAVAILABLE');
    return null;
  }
  if (provider === 'agy') {
    // Antigravity documents this text for an unauthenticated non-interactive run.
    const status = safeLines(stdout).filter(e => e.event === 'result').at(-1)?.result;
    if (/authentication required/i.test(`${JSON.stringify(status?.error ?? '')}\n${stderr}`)) return failure('AUTH_REQUIRED');
    return null;
  }
  return null;
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
  if (timeoutMs !== null && (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 600000)) throw new ProviderError('Timeout must be null or 10–600000 milliseconds.', 'INVALID_TIMEOUT');
  if (signal?.aborted) throw new ProviderError('Generation was cancelled.', 'ABORTED');
  const executable = await resolveExecutable(provider);
  if (!executable) throw new ProviderError(`${PROVIDERS[provider].name} was not found. Install it and sign in from your terminal.`, 'NOT_INSTALLED');
  const started = Date.now();
  let policyDir;
  try {
    let policyPath;
    if (provider === 'gemini') {
      policyDir = await makeTempDir('ste-policy-');
      policyPath = join(policyDir, 'deny-tools.toml');
      await writeFile(policyPath, GEMINI_POLICY, { mode: 0o600 });
    }
    const { args } = buildCommand({ provider, model, effort, policyPath });
    if (provider === 'codex') {
      // Read configuration names only; `mcp list` does not connect to servers.
      // Disable inherited MCPs for this invocation, without editing user config.
      // Compose's selected read-only sources are retrieved by its own adapter.
      const metadata = await execute({ command: executable.command, args: [...executable.prefix, 'mcp', 'list', '--json'], cwd, signal, timeoutMs: 5000, maxStdout: 128_000 });
      let servers;
      try { servers = JSON.parse(metadata.stdout); } catch { throw failure('POLICY_DENIED'); }
      if (!Array.isArray(servers) || servers.length > 100 || servers.some(row => typeof row?.name !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(row.name) || !['stdio', 'streamable_http'].includes(row.transport?.type))) throw failure('POLICY_DENIED');
      // Each override layer must contain a complete transport to pass Codex's
      // bootstrap validation. Use inert placeholders, never credentials in argv.
      if (servers.length) args.push('--config', `mcp_servers={${servers.map(server => `${JSON.stringify(server.name)}={enabled=false,${server.transport.type === 'stdio' ? `command=${JSON.stringify(process.execPath)}` : 'url="https://127.0.0.1/"'}}`).join(',')}}`);
    }
    let result;
    try {
      result = await execute({ command: executable.command, args: [...executable.prefix, ...args], cwd, input: prepareInput(provider, prompt), signal, timeoutMs, env: provider === 'claude' && effort ? { CLAUDE_CODE_EFFORT_LEVEL: effort } : {} });
    } catch (error) {
      throw (error.code === 'CLI_FAILED' && classifyProviderFailure(provider, error.details)) || error;
    }
    let text;
    try { text = parseProviderOutput(provider, result.stdout); }
    catch (error) { throw classifyProviderFailure(provider, { ...result, exitCode: 0 }) || error; }
    return { text, provider, model: model || '', effort, ...parseRunMetadata(provider, result.stdout), durationMs: Date.now() - started };
  } finally { if (policyDir) await removeTempDir(policyDir); }
}

export function validateEffort(provider, effort = '') {
  const levels = { codex: ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], claude: ['', 'low', 'medium', 'high', 'xhigh', 'max'], agy: ['', 'low', 'medium', 'high'], gemini: [''] };
  if (!levels[provider]?.includes(effort)) throw new ProviderError('This CLI does not support that effort setting.', 'INVALID_EFFORT');
}

export function parseRunMetadata(provider, stdout) {
  try {
    if (provider === 'claude') return { reportedModels: Object.keys(claudeResult(stdout)?.modelUsage || {}) };
    if (provider === 'gemini') return { reportedModels: Object.keys(JSON.parse(stdout).stats?.models || {}) };
  } catch {}
  return { reportedModels: [] };
}
