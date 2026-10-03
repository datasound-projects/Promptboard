/** Read-only native submission evidence. This module never writes input or retries it. */
import { constants } from 'node:fs';
import { lstat, open, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';

const FILE_LIMIT = 16 * 1024 * 1024, LINE_LIMIT = 1024 * 1024, TEXT_LIMIT = 256 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const result = (status, reason) => ({ status, ...(reason ? { reason } : {}) });
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
class EvidenceError extends Error { constructor(reason) { super('Native submission evidence is unavailable.'); this.reason = reason; } }
const fail = reason => { throw new EvidenceError(reason); };

async function snapshot(path, legacy) {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) fail('file_unavailable');
  const handle = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK));
  try {
    const start = await handle.stat({ bigint: true });
    if (!start.isFile() || !sameFile(before, start)) fail('file_changed');
    if (start.size > BigInt(FILE_LIMIT)) fail('size_limit');
    const bytes = Buffer.alloc(Number(start.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) fail('file_changed');
      offset += read.bytesRead;
    }
    const [end, current] = await Promise.all([handle.stat({ bigint: true }), stat(path, { bigint: true })]);
    if (!sameFile(start, current) || end.size < start.size || current.size < start.size) fail('file_changed');
    if (end.size > BigInt(FILE_LIMIT) || current.size > BigInt(FILE_LIMIT)) fail('size_limit');
    if (legacy && (end.size !== start.size || end.mtimeNs !== start.mtimeNs || end.ctimeNs !== start.ctimeNs)) fail('write_in_progress');
    return { bytes, file: start };
  } finally { await handle.close(); }
}

function lines(bytes, completeRequired = false) {
  const end = bytes.lastIndexOf(10);
  const pending = end !== bytes.length - 1;
  if (completeRequired && pending) fail('write_in_progress');
  // A partially appended last line is not a receipt. It can be checked again.
  if ((pending ? bytes.length - end - 1 : 0) > LINE_LIMIT) fail('size_limit');
  const records = [];
  let start = 0;
  while (start <= end) {
    const stop = bytes.indexOf(10, start);
    if (stop - start > LINE_LIMIT || records.length >= 100000) fail('size_limit');
    const line = bytes.subarray(start, stop);
    if (!line.length) fail('record_invalid');
    let record;
    try { record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
    catch { fail('record_invalid'); }
    if (!object(record)) fail('record_invalid');
    records.push(record); start = stop + 1;
  }
  return { records, pending };
}

function textParts(value, type) {
  if (typeof value === 'string') return type === 'input_text' ? null : value;
  if (!Array.isArray(value) || !value.length) return null;
  const parts = [];
  for (const part of value) {
    if (type === 'gemini' && typeof part === 'string') parts.push(part);
    else if (object(part) && typeof part.text === 'string' && (type === 'gemini'
      ? Object.keys(part).every(key => key === 'text') : part.type === type)) parts.push(part.text);
    else return null; // Tools and attachments are not plain automation input.
  }
  return parts.join('');
}

function validateIdentity(provider, nativeId, records) {
  if (!records.length) fail('identity_missing');
  if (provider === 'claude') {
    if (!records.some(record => record.sessionId === nativeId && record.isSidechain !== true)) fail('identity_missing');
    if (records.some(record => record.sessionId !== undefined && record.sessionId !== nativeId && record.isSidechain !== true)) fail('identity_changed');
  } else if (provider === 'codex') {
    const first = records[0];
    if (first.type !== 'session_meta' || first.payload?.id !== nativeId || first.payload.source !== undefined && first.payload.source !== 'cli') fail('identity_missing');
    if (records.some(record => record.type === 'session_meta' && record.payload?.id !== nativeId)) fail('identity_changed');
  } else {
    if (records[0].sessionId !== nativeId || records[0].kind !== undefined && records[0].kind !== 'main' || records[0].messages !== undefined) fail('identity_missing');
    for (const record of records) {
      if ('$set' in record && !object(record.$set)) fail('record_invalid');
      const metadata = record.$set || record;
      if (metadata.sessionId !== undefined && metadata.sessionId !== nativeId || metadata.kind !== undefined && metadata.kind !== 'main') fail('identity_changed');
    }
  }
}

function legacyGemini(bytes, nativeId) {
  let data;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('write_in_progress'); }
  if (!object(data) || data.sessionId !== nativeId || data.kind !== undefined && data.kind !== 'main' || !Array.isArray(data.messages) || data.messages.length > 100000) fail('identity_missing');
  if (data.messages.some(message => !object(message) || !identifier(message.id))) fail('record_invalid');
  if (new Set(data.messages.map(message => message.id)).size !== data.messages.length) fail('record_invalid');
  return data.messages;
}

function scan(provider, nativeId, records, expected, priorIds) {
  let matched = false, accepted = false;
  const candidates = new Set(), newIds = new Set();
  for (const record of records) {
    if (provider === 'claude') {
      if (record.sessionId !== nativeId || record.isSidechain === true || record.isMeta === true) continue;
      if (record.type === 'queue-operation' && record.operation === 'enqueue' && record.content === expected) accepted = true;
      if (record.type === 'queue-operation' && record.operation === 'remove') accepted = false;
      if (record.type === 'user' && record.message?.role === 'user' && textParts(record.message.content, 'text') === expected) matched = true;
    } else if (provider === 'codex') {
      if (record.type === 'response_item' && record.payload?.type === 'message' && record.payload.role === 'user'
        && textParts(record.payload.content, 'input_text') === expected) matched = true;
      if (record.type === 'event_msg' && record.payload?.type === 'user_message' && record.payload.message === expected) matched = true;
    } else {
      if (identifier(record.id) && !priorIds.has(record.id)) {
        if (newIds.has(record.id)) fail('record_invalid');
        newIds.add(record.id);
      }
      if ('$rewindTo' in record) fail('history_rewritten');
      if (record.$set?.messages !== undefined) fail('history_rewritten');
      if ('$patch' in record) {
        const patch = record.$patch;
        if (!object(patch) || patch.removeIds !== undefined || patch.orderIds !== undefined) fail('history_rewritten');
        const updates = patch.updates ?? [patch];
        if (!Array.isArray(updates) || updates.some(update => !object(update))) fail('record_invalid');
        if (updates.some(update => candidates.has(update.id) && update.content !== undefined)) fail('history_rewritten');
      }
      if (record.type === 'user' && identifier(record.id) && !priorIds.has(record.id) && textParts(record.content, 'gemini') === expected) {
        candidates.add(record.id); matched = true;
      }
    }
  }
  return matched ? result('confirmed') : accepted ? result('accepted', 'native_queue') : result('pending');
}

export class NativeMessageReceipts {
  #tickets = new WeakMap();
  #closed = false;
  constructor({ provider, nativeSessionId, runId, getInputEpoch, maxAgeMs = 150000 }) {
    if (!['claude', 'codex', 'gemini'].includes(provider) || !identifier(nativeSessionId) || !identifier(runId) || typeof getInputEpoch !== 'function'
      || !Number.isFinite(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 150000)
      throw new TypeError('Use an owned native session and an input epoch reader.');
    this.provider = provider; this.nativeId = nativeSessionId; this.runId = runId; this.getInputEpoch = getInputEpoch; this.maxAgeMs = maxAgeMs;
    Object.freeze(this);
  }

  #epoch() {
    let epoch;
    try { epoch = this.getInputEpoch(); } catch { fail('input_changed'); }
    if (this.#closed || !Number.isSafeInteger(epoch) || epoch < 0) fail('input_changed');
    return epoch;
  }

  close() { this.#closed = true; }
  cancel(ticket) {
    const saved = object(ticket) ? this.#tickets.get(ticket) : null;
    if (!saved || saved.finished) return false;
    saved.finished = 'cancelled'; return true;
  }

  async checkpoint(path) {
    try {
      if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) fail('path_invalid');
      const name = basename(path), legacy = this.provider === 'gemini' && name.endsWith('.json');
      if (this.provider === 'claude' && name !== `${this.nativeId}.jsonl`
        || this.provider === 'codex' && (!name.startsWith('rollout-') || !name.endsWith(`-${this.nativeId}.jsonl`))
        || this.provider === 'gemini' && !/^session-.*\.jsonl?$/.test(name)) fail('path_invalid');
      const epoch = this.#epoch(), captured = await snapshot(path, legacy);
      const records = legacy ? legacyGemini(captured.bytes, this.nativeId) : lines(captured.bytes, true).records;
      if (!legacy) validateIdentity(this.provider, this.nativeId, records);
      if (this.#epoch() !== epoch) fail('input_changed');
      const ticket = Object.freeze({});
      this.#tickets.set(ticket, { path, epoch, legacy, capturedAt: performance.now(), file: captured.file,
        offset: captured.bytes.length, prefixHash: digest(captured.bytes), provider: this.provider, nativeId: this.nativeId, runId: this.runId,
        priorIds: new Set(records.map(record => record.id).filter(identifier)),
        messages: legacy ? records.map(record => digest(JSON.stringify(record))) : null });
      return { status: 'ready', ticket };
    } catch (error) { return result('unavailable', error instanceof EvidenceError ? error.reason : 'file_unavailable'); }
  }

  async verify(ticket, expected) {
    const saved = object(ticket) ? this.#tickets.get(ticket) : null;
    if (!saved) return result('uncertain', 'checkpoint_invalid');
    if (saved.finished) return result('uncertain', saved.finished);
    if (typeof expected !== 'string' || !expected.length || Buffer.byteLength(expected) > TEXT_LIMIT || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(expected)) return result('unsupported', 'message_invalid');
    if (expected.trimStart().startsWith('/') || this.provider === 'codex' && /^<(?:environment_context|user_instructions)>/.test(expected)) return result('unsupported', 'command_unverified');
    if (saved.busy) return result('pending', 'verification_in_progress');
    saved.busy = true;
    try {
      if (this.provider !== saved.provider || this.nativeId !== saved.nativeId || this.runId !== saved.runId || this.#epoch() !== saved.epoch) fail('input_changed');
      if (performance.now() - saved.capturedAt > this.maxAgeMs) fail('checkpoint_expired');
      // Bind the checkpoint to one exact transport text, including whitespace.
      const expectedHash = digest(expected);
      if (saved.expectedHash && saved.expectedHash !== expectedHash) fail('message_changed');
      saved.expectedHash = expectedHash;
      const current = await snapshot(saved.path, saved.legacy);
      let records, pending = false;
      if (saved.legacy) {
        const messages = legacyGemini(current.bytes, this.nativeId);
        if (messages.length < saved.messages.length || saved.messages.some((hash, index) => hash !== digest(JSON.stringify(messages[index])))) fail('history_rewritten');
        records = messages.slice(saved.messages.length);
      } else {
        if (!sameFile(saved.file, current.file) || current.bytes.length < saved.offset || digest(current.bytes.subarray(0, saved.offset)) !== saved.prefixHash) fail('history_rewritten');
        const appended = lines(current.bytes.subarray(saved.offset)); records = appended.records; pending = appended.pending;
        // New metadata must never redirect a proof into another conversation.
        for (const record of records) {
          if (this.provider === 'claude' && record.sessionId !== undefined && record.sessionId !== this.nativeId && record.isSidechain !== true) fail('identity_changed');
          if (this.provider === 'codex' && record.type === 'session_meta') fail('identity_changed');
          if (this.provider === 'gemini') {
            if ('$set' in record && !object(record.$set)) fail('record_invalid');
            const metadata = record.$set || record;
            if (metadata.sessionId !== undefined && metadata.sessionId !== this.nativeId || metadata.kind !== undefined && metadata.kind !== 'main') fail('identity_changed');
          }
        }
      }
      const found = scan(this.provider, this.nativeId, records, expected, saved.priorIds);
      if (this.#epoch() !== saved.epoch) fail('input_changed');
      if (saved.finished) fail(saved.finished);
      if (performance.now() - saved.capturedAt > this.maxAgeMs) fail('checkpoint_expired');
      // A torn final append can be completed later; it grants no receipt yet.
      if (pending) return result('pending', 'write_in_progress');
      if (found.status === 'confirmed') saved.finished = 'checkpoint_used';
      return found;
    } catch (error) {
      const reason = saved.finished || (this.#closed ? 'input_changed' : error instanceof EvidenceError ? error.reason : 'file_unavailable');
      if (reason === 'write_in_progress') return result('pending', reason);
      saved.finished = reason;
      return result('uncertain', reason);
    } finally { saved.busy = false; }
  }
}
