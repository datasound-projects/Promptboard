/**
 * Token usage from the provider CLIs' own structured session files. Nothing is estimated:
 * - Claude Code: the session transcript (path from its hook payload). Each assistant message
 *   carries message.model and message.usage; streamed blocks repeat one message ID.
 * - Codex CLI: the session rollout file for the thread. token_count events carry totals, the
 *   last request's tokens, the model context window, and rate limits; turn_context has the model.
 * - Gemini CLI: its hooks give no usage, so none is reported.
 * Only numbers and model IDs are read; message text is never kept.
 */
import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';

const READ_LIMIT = 16 * 1024 * 1024;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,99}$/;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** Read complete JSON lines added since the last call. */
export async function readNewLines(tail) {
  const handle = await open(tail.path, 'r').catch(() => null);
  if (!handle) return [];
  try {
    const { size } = await handle.stat();
    if (size < tail.offset) tail.offset = 0; // Replaced file: read it again.
    if (size <= tail.offset) return [];
    const buffer = Buffer.alloc(Math.min(size - tail.offset, READ_LIMIT));
    await handle.read(buffer, 0, buffer.length, tail.offset);
    const end = buffer.lastIndexOf(10);
    if (end < 0) return [];
    tail.offset += end + 1;
    return buffer.subarray(0, end).toString('utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  } finally { await handle.close(); }
}

export function newUsage(source) { return { source, model: '', inputTokens: 0, outputTokens: 0, cachedTokens: 0, contextTokens: 0, contextWindow: 0, messages: new Map() }; }

/** Claude transcript line. Totals are summed per unique message ID. */
export function addClaudeRecord(acc, record) {
  const message = record?.type === 'assistant' ? record.message : null;
  if (!message?.usage || typeof message.id !== 'string') return;
  const usage = message.usage;
  const input = count(usage.input_tokens), cacheRead = count(usage.cache_read_input_tokens), cacheWrite = count(usage.cache_creation_input_tokens);
  acc.messages.set(message.id, { input: input + cacheWrite, cached: cacheRead, output: count(usage.output_tokens) });
  if (typeof message.model === 'string' && SAFE_MODEL.test(message.model) && message.model !== '<synthetic>') acc.model = message.model;
  // The latest request's full prompt size is the context in use.
  acc.contextTokens = input + cacheRead + cacheWrite;
  let inputTokens = 0, cachedTokens = 0, outputTokens = 0;
  for (const row of acc.messages.values()) { inputTokens += row.input; cachedTokens += row.cached; outputTokens += row.output; }
  Object.assign(acc, { inputTokens, cachedTokens, outputTokens });
}

/** Codex rollout line. token_count carries running totals; the newest one wins. */
export function addCodexRecord(acc, record) {
  const payload = record?.payload;
  if (record?.type === 'turn_context' && typeof payload?.model === 'string' && SAFE_MODEL.test(payload.model)) acc.model = payload.model;
  if (payload?.type !== 'token_count') return;
  const total = payload.info?.total_token_usage, last = payload.info?.last_token_usage;
  if (total) Object.assign(acc, { inputTokens: count(total.input_tokens) - count(total.cached_input_tokens), cachedTokens: count(total.cached_input_tokens), outputTokens: count(total.output_tokens) });
  if (last) acc.contextTokens = count(last.input_tokens) + count(last.output_tokens);
  if (payload.info?.model_context_window) acc.contextWindow = count(payload.info.model_context_window);
  const primary = payload.rate_limits?.primary;
  if (primary && Number.isFinite(primary.used_percent)) {
    acc.rateLimit = { usedPercent: Math.max(0, Math.min(100, primary.used_percent)), ...(count(primary.resets_at) ? { resetsAt: new Date(primary.resets_at * 1000).toISOString() } : {}) };
  }
}

/** The run record's usage (plain data, no message map). */
export function usageSummary(acc) {
  const { messages, ...rest } = acc;
  return { ...rest, updatedAt: Date.now() };
}

/** Claude reports its transcript path; accept it only for the session ID Promptboard assigned. */
export function claudeTranscript(path, sessionId) {
  return typeof path === 'string' && isAbsolute(path) && !path.includes('\0') && basename(path) === `${sessionId}.jsonl` ? path : null;
}

/** Find Codex's rollout file for a thread: sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl. */
export async function findCodexRollout(threadId, startedAt, home = process.env.CODEX_HOME || join(homedir(), '.codex')) {
  if (typeof threadId !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(threadId)) return null;
  const days = new Set([startedAt, Date.now()].map(time => { const d = new Date(time); return join(String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')); }));
  for (const day of days) {
    const dir = join(home, 'sessions', day);
    const names = await readdir(dir).catch(() => []);
    const name = names.find(item => item.startsWith('rollout-') && item.endsWith(`-${threadId}.jsonl`));
    if (name) return join(dir, name);
  }
  return null;
}
