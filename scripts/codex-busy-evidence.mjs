/** Read-only evidence for the opt-in disposable Codex queue check. */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const CODEX_BUSY_MESSAGE = 'Output exactly 160 lines, numbered 001 through 160, each containing only PB_BUSY_LINE_ followed by that three-digit number. Then output PB_BUSY_END on its own final line. Do not use tools, change files, or ask questions.';
export const CODEX_QUEUED_MESSAGE = 'Reply exactly PB_BUSY_NEXT. Do not use tools or change any file.';
const limit = 4 * 1024 * 1024, hash = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = () => { throw new Error('The owned Codex queue evidence is unavailable.'); };
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);

function inputText(record) {
  const payload = record.payload;
  if (record.type === 'event_msg' && payload?.type === 'user_message' && typeof payload.message === 'string'
    && (!payload.images || Array.isArray(payload.images) && !payload.images.length)
    && (!payload.local_images || Array.isArray(payload.local_images) && !payload.local_images.length)) return payload.message;
  if (record.type !== 'response_item' || payload?.type !== 'message' || payload.role !== 'user'
    || !Array.isArray(payload.content) || !payload.content.length
    || !payload.content.every(part => part?.type === 'input_text' && typeof part.text === 'string')) return null;
  return payload.content.map(part => part.text).join('');
}

function completeReply(text) {
  if (typeof text !== 'string') return false;
  const lines = text.trim().split(/\r?\n/);
  if (lines.length !== 161 || lines[160] !== 'PB_BUSY_END') return false;
  // Both literal lines and matching numeric prefixes satisfy the numbered task.
  return lines.slice(0, 160).every((line, index) => {
    const number = String(index + 1).padStart(3, '0');
    return line === `PB_BUSY_LINE_${number}` || line === `${number} PB_BUSY_LINE_${number}`;
  });
}

export function codexBusyEvidence(records, nativeId) {
  if (!id(nativeId) || !Array.isArray(records) || !records.length || records.some(row => !row || typeof row !== 'object' || Array.isArray(row))
    || records[0].type !== 'session_meta' || records[0].payload?.id !== nativeId || records[0].payload.source !== 'cli'
    || records.some(row => row.type === 'session_meta' && (row.payload?.id !== nativeId || row.payload.source !== 'cli'))) invalid();
  const turns = new Map(); let active = null, busy = null, next = null, interrupted = false, duplicate = false;
  for (let index = 0; index < records.length; index++) {
    const row = records[index], event = row.type === 'event_msg' ? row.payload : null;
    if (event?.type === 'task_started') {
      if (active || !id(event.turn_id) || turns.has(event.turn_id)) invalid();
      active = { id: event.turn_id, started: index, completed: null, text: null, error: false };
      turns.set(active.id, active);
    } else if (event?.type === 'task_complete') {
      const turn = turns.get(event.turn_id);
      if (!turn || turn !== active || turn.completed !== null) invalid();
      Object.assign(turn, { completed: index, text: event.last_agent_message, error: Boolean(event.error) }); active = null;
    } else if (event?.type === 'turn_aborted' && busy) interrupted = true;
    const text = inputText(row);
    if (text === CODEX_BUSY_MESSAGE || text === CODEX_QUEUED_MESSAGE) {
      if (!active) invalid();
      if (text === CODEX_BUSY_MESSAGE) { if (busy && busy !== active) duplicate = true; busy ||= active; }
      else { if (next && next !== active) duplicate = true; next ||= active; }
    }
  }
  const steered = Boolean(busy && next && busy === next);
  const sequenceValid = Boolean(busy && next && !duplicate && !interrupted && !steered
    && busy.completed !== null && next.started > busy.completed);
  return { busy: Boolean(busy && busy === active && !duplicate && !interrupted), interrupted, steered,
    firstReplyComplete: Boolean(busy && !busy.error && completeReply(busy.text)), nextInputObserved: Boolean(next), sequenceValid,
    nextReplyComplete: Boolean(sequenceValid && next.completed !== null && !next.error && next.text?.trim() === 'PB_BUSY_NEXT') };
}

export class CodexBusyEvidenceReader {
  #previous = null;
  constructor(path, nativeId) { this.path = path; this.nativeId = nativeId; }
  async read() {
    const before = await lstat(this.path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(limit)) invalid();
    const handle = await open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK));
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > BigInt(limit)) invalid();
      const bytes = Buffer.alloc(Number(stat.size)); let offset = 0;
      while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) invalid(); offset += read.bytesRead; }
      const current = await lstat(this.path, { bigint: true });
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino || current.size < stat.size || current.size > BigInt(limit)) invalid();
      if (this.#previous && (this.#previous.dev !== stat.dev || this.#previous.ino !== stat.ino || bytes.length < this.#previous.size
        || hash(bytes.subarray(0, this.#previous.size)) !== this.#previous.hash)) invalid();
      const complete = bytes.subarray(0, bytes.lastIndexOf(10) + 1), text = new TextDecoder('utf-8', { fatal: true }).decode(complete);
      const lines = text.trimEnd().split('\n'); if (lines.some(line => !line || Buffer.byteLength(line) > 1024 * 1024)) invalid();
      const records = lines.map(line => JSON.parse(line)), evidence = codexBusyEvidence(records, this.nativeId);
      this.#previous = { dev: stat.dev, ino: stat.ino, size: bytes.length, hash: hash(bytes) };
      return evidence;
    } finally { await handle.close(); }
  }
}
