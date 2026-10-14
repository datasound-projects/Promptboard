// Streaming, read-only research runs of Claude Code and Codex. Output is read line by line as the CLI writes it, so
// the page shows text while it is produced. A run has no shell and no file writes. Web search and MCP tools are
// added only when the chat turns them on. Provider failures map to the same fixed messages as other model calls.
import { isAbsolute } from 'node:path';
import { ProviderError, SAFE_MODEL, classifyProviderFailure, codexMcpOverride, resolveExecutable, spawnOwned, stopProcess, validateEffort } from './providers.mjs';

const MAX_PROMPT = 2 * 1024 * 1024, MAX_STDOUT = 16 * 1024 * 1024, MAX_STDERR = 64 * 1024, MAX_TEXT = 100_000;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
export const WEB_TOOLS = ['WebSearch', 'WebFetch'];

/**
 * CLI arguments for one research turn. `session` is { id, resume }: Claude uses the ID as its session ID (new) or
 * resumes it; Codex resumes a thread ID it reported earlier (new threads get their ID from the CLI).
 * `tools` are extra Claude tool names (approved MCP tools, `Skill`); `mcpConfig` is Claude's MCP JSON;
 * `codexArgs` are extra Codex config arguments for approved MCP servers.
 */
export function researchArgs({ provider, model = '', effort = '', web = false, session = null, tools = [], mcpConfig = '{"mcpServers":{}}', codexArgs = [] }) {
  if (provider === 'claude') {
    const allowed = [...(web ? WEB_TOOLS : []), ...tools];
    const args = ['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--strict-mcp-config', '--mcp-config', mcpConfig,
      '--disable-slash-commands', '--tools', allowed.join(','), ...(allowed.length ? ['--allowedTools', allowed.join(',')] : []), '--max-turns', allowed.length ? '30' : '1'];
    if (session) args.push(session.resume ? '--resume' : '--session-id', session.id);
    if (effort) args.push('--effort', effort);
    if (model) args.push('--model', model);
    return args;
  }
  // `exec resume` has no --sandbox flag; the same policy is set as configuration for new and resumed threads.
  const args = ['exec', ...(session?.resume ? ['resume', session.id] : []), '--json', '--skip-git-repo-check',
    '--config', 'sandbox_mode="read-only"', '--config', 'approval_policy="never"', '--config', `web_search="${web ? 'live' : 'disabled'}"`,
    '--config', 'features.apps=false', '--config', 'features.plugins=false', '--config', 'features.hooks=false',
    '--disable', 'shell_tool', '--disable', 'unified_exec', ...codexArgs];
  if (effort) args.push('--config', `model_reasoning_effort="${effort}"`);
  if (model) args.push('--model', model);
  return args;
}

const fail = (message, code, extra = {}) => Object.assign(new ProviderError(message, code), extra);
const short = (value, max = 160) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };

/** Live events from one parsed CLI line. Returns what to keep: session ID, final text, errors. */
function readLine(provider, event, state, onEvent) {
  if (provider === 'claude') {
    if (event.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string') state.session = event.session_id;
    else if (event.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta' && typeof event.event.delta.text === 'string') {
      state.streamed += event.event.delta.text; onEvent({ type: 'delta', text: event.event.delta.text });
    } else if (event.type === 'stream_event' && event.event?.type === 'message_start' && state.streamed && !state.streamed.endsWith('\n\n')) {
      // A new assistant turn after a tool call: keep the turns apart in the live text.
      state.streamed += '\n\n'; onEvent({ type: 'delta', text: '\n\n' });
    } else if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue;
        const input = block.input || {};
        const kind = block.name === 'WebSearch' ? 'search' : block.name === 'WebFetch' ? 'fetch' : block.name === 'Skill' ? 'skill' : 'tool';
        onEvent({ type: 'activity', kind, label: short(kind === 'search' ? input.query : kind === 'fetch' ? input.url : kind === 'skill' ? input.skill || input.name : block.name.replace(/^mcp__/, '').replaceAll('__', ' · ')) });
      }
    } else if (event.type === 'result') {
      if (typeof event.session_id === 'string') state.session = event.session_id;
      state.final = typeof event.result === 'string' ? event.result : state.final;
      state.error = event.is_error === true;
    }
    return;
  }
  if (event.type === 'thread.started' && typeof event.thread_id === 'string') state.session = event.thread_id;
  else if ((event.type === 'item.started' || event.type === 'item.completed') && event.item) {
    const item = event.item;
    if (item.type === 'agent_message' && event.type === 'item.completed' && typeof item.text === 'string') {
      const text = (state.streamed ? '\n\n' : '') + item.text;
      state.streamed += text; state.final = item.text; onEvent({ type: 'delta', text });
    } else if (item.type === 'web_search' && event.type === 'item.started') onEvent({ type: 'activity', kind: 'search', label: short(item.query || item.action?.query || 'web') });
    else if (item.type === 'mcp_tool_call' && event.type === 'item.started') onEvent({ type: 'activity', kind: 'tool', label: short(`${item.server || ''} · ${item.tool || ''}`) });
  } else if (event.type === 'error' || event.type === 'turn.failed') state.error = true;
}

/**
 * Run one research turn. Calls `onEvent` with { type: 'delta' | 'activity', ... } while the CLI works and resolves
 * with { text, session, durationMs }. A cancelled or failed run rejects; its error carries the text produced so far
 * (`partial`) and `resumeFailed` when a resumed session could not continue before any text.
 */
export async function streamResearch({ provider, model = '', effort = '', prompt, cwd, signal, session = null, web = false, tools = [], mcpConfig, codexArgs = [], onEvent = () => {} } = {}) {
  if (!['claude', 'codex'].includes(provider)) throw fail('Research uses Claude Code or Codex.', 'INVALID_PROVIDER');
  if (model && (typeof model !== 'string' || !SAFE_MODEL.test(model))) throw fail('Use a model ID or alias with no spaces or command flags.', 'INVALID_MODEL');
  validateEffort(provider, effort);
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > MAX_PROMPT) throw fail('Provide a non-empty prompt at most 2 MiB.', 'INVALID_INPUT');
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw fail('Use an isolated absolute working directory.', 'INVALID_CWD');
  if (session && (!SESSION.test(session.id || '') || (provider === 'codex' && !session.resume))) throw fail('Invalid research session.', 'INVALID_INPUT');
  if (signal?.aborted) throw fail('Generation was cancelled.', 'ABORTED');
  const executable = await resolveExecutable(provider);
  if (!executable) throw fail(`${provider === 'claude' ? 'Claude Code' : 'Codex'} was not found. Install it and sign in from your terminal.`, 'NOT_INSTALLED');
  const args = researchArgs({ provider, model, effort, web, session, tools, mcpConfig, codexArgs });
  if (provider === 'codex') args.push(...await codexMcpOverride(executable, { cwd, signal }), '-');
  const started = Date.now();
  const state = { session: provider === 'claude' && session ? session.id : null, streamed: '', final: null, error: false };
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnOwned(executable.command, [...executable.prefix, ...args], { cwd, env: provider === 'claude' && effort ? { CLAUDE_CODE_EFFORT_LEVEL: effort } : {} }); }
    catch { reject(fail('The CLI could not start. Check its installation.', 'SPAWN_FAILED')); return; }
    let stdout = '', pending = '', stderr = '', failure = null, settled = false, killTimer, hardTimer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(killTimer); clearTimeout(hardTimer); signal?.removeEventListener('abort', abort);
      if (error) { error.partial = (state.final ?? state.streamed).slice(0, MAX_TEXT); error.session = state.session; reject(error); } else resolve(value);
    };
    const stop = error => {
      if (failure || settled) return;
      failure = error; stopProcess(child);
      killTimer = setTimeout(() => stopProcess(child, 'SIGKILL'), 1000); killTimer.unref();
      hardTimer = setTimeout(() => { for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy(); finish(failure); }, 3000); hardTimer.unref();
    };
    const abort = () => stop(fail('Research was stopped.', 'ABORTED'));
    signal?.addEventListener('abort', abort, { once: true });
    const line = text => {
      if (!text.trim()) return;
      let event; try { event = JSON.parse(text); } catch { return; }
      try { readLine(provider, event, state, onEvent); } catch {}
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (failure) return;
      stdout += chunk;
      if (stdout.length > MAX_STDOUT) { stop(fail('The CLI output exceeded the size limit.', 'OUTPUT_LIMIT')); return; }
      pending += chunk;
      const lines = pending.split('\n'); pending = lines.pop();
      for (const text of lines) line(text);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { if (stderr.length < MAX_STDERR) stderr += chunk.slice(0, MAX_STDERR - stderr.length); });
    child.on('error', () => finish(failure || fail('The CLI could not start. Check its installation.', 'SPAWN_FAILED')));
    child.on('close', code => {
      if (pending) line(pending);
      if (failure) { if (process.platform !== 'win32') stopProcess(child, 'SIGKILL'); finish(failure); return; }
      const text = (state.final ?? state.streamed).trim();
      if (code !== 0 || state.error || !text) {
        const known = classifyProviderFailure(provider, { stdout, stderr, exitCode: code });
        const error = known || fail(code === 0 && !state.error ? 'The CLI did not return an answer. Check its version and try again.' : 'The CLI failed for an unrecognized reason. Run the CLI in your terminal to see its diagnostics.', code === 0 && !state.error ? 'INVALID_OUTPUT' : 'CLI_FAILED');
        // A resumed session that ends before any text could not be continued (for example, it was removed).
        if (session?.resume && !state.streamed.trim()) error.resumeFailed = true;
        finish(error); return;
      }
      finish(null, { text: text.slice(0, MAX_TEXT), session: state.session, durationMs: Date.now() - started });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}
