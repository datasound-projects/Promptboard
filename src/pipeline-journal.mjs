/** Durable move intent. This module never executes or automatically retries an action. */
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizePipelineAutomations } from './pipeline-config.mjs';

const SCHEMA = 'promptboard.automation-move', VERSION = 1, LIMIT = 4096;
const TYPES = ['send_message', 'run_script', 'webhook', 'notify'];
const TERMINAL = ['succeeded', 'failed', 'cancelled', 'timed_out', 'unconfirmed', 'skipped', 'interrupted'];
const OUTCOME_FIELDS = ['status', 'reason', 'errorCode', 'durationMs', 'httpStatus', 'attempts', 'exitCode', 'terminatedBy'];
const digest = value => createHash('sha256').update(value).digest('hex');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
const text = (value, max) => typeof value === 'string' && !value.includes('\0') && value.length <= max;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
export class PipelineJournalError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
const fail = (message, code = 'JOURNAL_INVALID') => { throw new PipelineJournalError(message, code); };
function identity(value) {
  if (!value || !['projectId', 'taskId', 'transitionId'].every(key => id(value[key]))) fail('A move needs stable project, task and transition IDs.');
  return Object.fromEntries(['projectId', 'taskId', 'transitionId'].map(key => [key, value[key]]));
}
function folderName(value) { const key = identity(value); return digest(JSON.stringify([key.projectId, key.taskId, key.transitionId])); }
function outcome(value, allowed = TERMINAL.filter(status => status !== 'interrupted')) {
  if (!keys(value, OUTCOME_FIELDS) || !allowed.includes(value.status)
    || (value.reason !== undefined && !text(value.reason, 500))
    || (value.errorCode !== undefined && (typeof value.errorCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(value.errorCode)))
    || (value.durationMs !== undefined && !integer(value.durationMs))
    || (value.httpStatus !== undefined && (!Number.isInteger(value.httpStatus) || value.httpStatus < 100 || value.httpStatus > 599))
    || (value.attempts !== undefined && (!integer(value.attempts) || value.attempts > 3))
    || (value.exitCode !== undefined && value.exitCode !== null && (!Number.isInteger(value.exitCode) || value.exitCode < -2147483648 || value.exitCode > 4294967295))
    || (value.terminatedBy !== undefined && (typeof value.terminatedBy !== 'string' || !/^SIG[A-Z0-9]{1,20}$/.test(value.terminatedBy)))) fail('Use a bounded automation outcome without raw diagnostics.');
  return structuredClone(value);
}
function column(value) {
  if (!keys(value, ['id', 'name']) || !id(value.id) || !text(value.name, 80) || !value.name.trim()) fail('A move needs its source and destination column identities.');
  return { id: value.id, name: value.name };
}
function ownerAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
async function readJson(path) {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) fail('The automation journal has an invalid record size.', 'JOURNAL_CORRUPT');
    const bytes = await handle.readFile();
    if (bytes.length > 1024 * 1024) fail('The automation journal is too large.', 'JOURNAL_CORRUPT');
    return JSON.parse(bytes.toString('utf8'));
  } finally { await handle.close(); }
}
async function syncDirectory(path) {
  let handle;
  try { handle = await open(path, 'r'); await handle.sync(); }
  catch (error) {
    // Directory flush is unavailable on some supported OS/filesystem combinations.
    if (!['EINVAL', 'EISDIR', 'ENOTSUP', ...(process.platform === 'win32' ? ['EPERM', 'EACCES', 'EBADF'] : [])].includes(error.code)) throw error;
  } finally { await handle?.close(); }
}

function validate(data, key, revision) {
  if (data?.schema === SCHEMA && data.version > VERSION) fail('This automation journal needs a newer Promptboard version.', 'JOURNAL_VERSION_UNSUPPORTED');
  if (!keys(data, ['schema', 'version', 'revision', 'projectId', 'taskId', 'transitionId', 'taskRevision', 'projectRevision', 'from', 'to', 'ownerPid', 'status', 'phase', 'createdAt', 'updatedAt', 'finishedAt', 'actions', 'lifecycle'])
    || data.schema !== SCHEMA || data.version !== VERSION || data.revision !== revision
    || Object.entries(key).some(([name, value]) => data[name] !== value)
    || !integer(data.taskRevision) || !integer(data.projectRevision) || !Number.isSafeInteger(data.ownerPid) || data.ownerPid < 1
    || !integer(data.createdAt) || !integer(data.updatedAt) || (data.finishedAt !== undefined && !integer(data.finishedAt))
    || !['pending', 'running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(data.status)
    || !['exit', 'lifecycle', 'enter', 'complete'].includes(data.phase) || !Array.isArray(data.actions) || data.actions.length > 80) fail('The automation journal is invalid; it was not changed.', 'JOURNAL_CORRUPT');
  try {
    column(data.from); column(data.to);
    const ids = new Set();
    for (const action of data.actions) {
      if (!keys(action, ['id', 'rowId', 'name', 'type', 'trigger', 'columnId', 'configHash', 'status', 'startedAt', 'finishedAt', 'attempts', 'outcome'])
        || !id(action.id) || ids.has(action.id) || !id(action.rowId) || !text(action.name, 80) || !action.name.trim() || !TYPES.includes(action.type)
        || !['exit', 'enter'].includes(action.trigger) || action.columnId !== data[action.trigger === 'exit' ? 'from' : 'to'].id
        || !/^[a-f0-9]{64}$/.test(action.configHash) || !['pending', 'running', ...TERMINAL].includes(action.status)
        || !Array.isArray(action.attempts) || action.attempts.length > 3
        || action.attempts.some((attempt, index) => !keys(attempt, ['number', 'startedAt']) || attempt.number !== index + 1 || !integer(attempt.startedAt))
        || (action.type !== 'webhook' && action.attempts.length)
        || (action.startedAt !== undefined && !integer(action.startedAt)) || (action.finishedAt !== undefined && !integer(action.finishedAt))
        || (action.status === 'pending' && (action.startedAt !== undefined || action.attempts.length))
        || (action.status === 'running' && action.startedAt === undefined)
        || (TERMINAL.includes(action.status) && !['skipped', 'interrupted'].includes(action.status) && action.startedAt === undefined)
        || (TERMINAL.includes(action.status) && (action.finishedAt === undefined || action.outcome?.status !== action.status))
        || (['pending', 'running'].includes(action.status) && (action.finishedAt !== undefined || action.outcome !== undefined))) throw new Error();
      if (action.outcome) outcome(action.outcome, TERMINAL);
      ids.add(action.id);
    }
    const lifecycle = data.lifecycle;
    if (!keys(lifecycle, ['status', 'startedAt', 'finishedAt', 'outcome']) || !['pending', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(lifecycle.status)
      || (lifecycle.startedAt !== undefined && !integer(lifecycle.startedAt)) || (lifecycle.finishedAt !== undefined && !integer(lifecycle.finishedAt))
      || (lifecycle.status === 'pending' && lifecycle.startedAt !== undefined)
      || (lifecycle.status === 'running' && lifecycle.startedAt === undefined)
      || (TERMINAL.includes(lifecycle.status) && (lifecycle.finishedAt === undefined || lifecycle.outcome?.status !== lifecycle.status))
      || (['pending', 'running'].includes(lifecycle.status) && (lifecycle.finishedAt !== undefined || lifecycle.outcome !== undefined))) throw new Error();
    if (lifecycle.outcome) outcome(lifecycle.outcome, TERMINAL);
    if (data.actions.some(action => action.status === 'running' && action.trigger !== data.phase)) throw new Error();
    if (data.phase === 'exit' && lifecycle.status !== 'pending') throw new Error();
    if (data.phase === 'lifecycle' && !['pending', 'running'].includes(lifecycle.status)) throw new Error();
    if (data.phase !== 'exit' && data.actions.some(action => action.trigger === 'exit' && !TERMINAL.includes(action.status))) throw new Error();
    if (data.phase === 'enter' && lifecycle.status !== 'succeeded') throw new Error();
    if (data.phase === 'complete' && (data.finishedAt === undefined || !TERMINAL.includes(lifecycle.status) || data.actions.some(action => !TERMINAL.includes(action.status)))) throw new Error();
    if (data.phase !== 'complete' && (!['pending', 'running'].includes(data.status) || data.finishedAt !== undefined)) throw new Error();
    if (data.phase === 'complete' && !['completed', 'failed', 'cancelled', 'interrupted'].includes(data.status)) throw new Error();
    if (data.status === 'completed' && lifecycle.status !== 'succeeded') throw new Error();
    if (data.status === 'failed' && !['failed', 'cancelled'].includes(lifecycle.status)) throw new Error();
  } catch { fail('The automation journal is invalid; it was not changed.', 'JOURNAL_CORRUPT'); }
  return data;
}

export class PipelineJournal {
  constructor(dataDir) { this.dir = join(dataDir, 'automations'); this.dataDir = dataDir; }

  async read(input) {
    const key = identity(input), folder = join(this.dir, folderName(key));
    let names;
    try { names = (await readdir(folder)).filter(name => /^\d{8}\.json$/.test(name)).sort(); }
    catch (error) { if (error.code === 'ENOENT') return null; fail('The automation journal could not be read; no work may start.', 'JOURNAL_READ_FAILED'); }
    if (!names.length) return null;
    if (names.length > LIMIT || names.some((name, index) => Number(name.slice(0, 8)) !== index)) fail('The automation journal has missing or excessive revisions.', 'JOURNAL_CORRUPT');
    try {
      return validate(await readJson(join(folder, names.at(-1))), key, names.length - 1);
    } catch (error) {
      if (error instanceof PipelineJournalError) throw error;
      fail('The automation journal could not be read; it was not changed.', 'JOURNAL_CORRUPT');
    }
  }

  async #append(data) {
    if (data.revision >= LIMIT) fail('This move has reached its journal revision limit.', 'JOURNAL_LIMIT');
    const folder = join(this.dir, folderName(data)), temporary = join(folder, `.tmp-${process.pid}-${randomUUID()}`);
    try {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await syncDirectory(this.dataDir); await syncDirectory(this.dir);
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(`${JSON.stringify(data)}\n`); await handle.sync(); } finally { await handle.close(); }
      // Publishing a flushed immutable revision is a cross-process compare-and-swap.
      // No rename-overwrite fallback: a losing caller must reread the winning revision.
      try { await link(temporary, join(folder, `${String(data.revision).padStart(8, '0')}.json`)); }
      catch (error) { if (error.code === 'EEXIST') return false; throw error; }
      await syncDirectory(folder);
      return true;
    } catch (error) {
      if (error instanceof PipelineJournalError) throw error;
      fail('The journal save was not acknowledged. Do not start or replay work.', 'JOURNAL_WRITE_FAILED');
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }

  async beginMove(input) {
    const key = identity(input), previous = await this.read(key);
    if (previous) return { created: false, move: previous };
    if (!integer(input.taskRevision) || !integer(input.projectRevision)) fail('A move needs its task and project revisions.');
    const from = column(input.from), to = column(input.to);
    if (from.id === to.id) fail('A placement within one column does not create an automation move.');
    const actions = [];
    for (const trigger of ['exit', 'enter']) {
      const group = trigger === 'exit' ? 'onExit' : 'onEnter';
      const rows = normalizePipelineAutomations({ [group]: input[group] ?? [] })[group];
      for (const row of rows) actions.push({ id: randomUUID(), rowId: row.id, name: row.name, type: row.type, trigger,
        columnId: trigger === 'exit' ? from.id : to.id, configHash: digest(JSON.stringify(row)),
        status: row.enabled ? 'pending' : 'skipped', attempts: [], ...(!row.enabled ? { finishedAt: Date.now(), outcome: { status: 'skipped', reason: 'This automation is disabled.' } } : {}) });
    }
    const now = Date.now(), move = { schema: SCHEMA, version: VERSION, revision: 0, ...key, from, to,
      taskRevision: input.taskRevision, projectRevision: input.projectRevision, ownerPid: process.pid,
      status: 'pending', phase: 'exit', createdAt: now, updatedAt: now, actions, lifecycle: { status: 'pending' } };
    if (await this.#append(move)) return { created: true, move: structuredClone(move) };
    return { created: false, move: await this.read(key) };
  }

  async #change(input, apply, recovery = false) {
    const key = identity(input);
    for (let tries = 0; tries < LIMIT; tries++) {
      const current = await this.read(key);
      if (!current) fail('The move has not been recorded.', 'JOURNAL_NOT_FOUND');
      if (!recovery && current.ownerPid !== process.pid) fail('This move belongs to another application process; it cannot be replayed.', 'JOURNAL_OWNER_MISMATCH');
      const next = structuredClone(current), result = apply(next);
      if (!result.changed) return result.value;
      next.revision++; next.updatedAt = Date.now(); validate(next, key, next.revision);
      if (await this.#append(next)) return result.value;
    }
    fail('The move is busy; no execution was authorized.', 'JOURNAL_BUSY');
  }

  startAction(key, actionId) {
    return this.#change(key, move => {
      const index = move.actions.findIndex(action => action.id === actionId), action = move.actions[index];
      if (!action) fail('This move does not contain that action.', 'JOURNAL_ACTION_NOT_FOUND');
      if (action.status !== 'pending') return { changed: false, value: { accepted: false, action: structuredClone(action) } };
      if (move.phase !== action.trigger || move.actions.slice(0, index).some(row => row.trigger === action.trigger && !TERMINAL.includes(row.status))) fail('Actions must run in source-exit, lifecycle, destination-enter order.', 'JOURNAL_ORDER');
      action.status = 'running'; action.startedAt = Date.now(); move.status = 'running';
      return { changed: true, value: { accepted: true, action: structuredClone(action) } };
    });
  }

  recordAttempt(key, actionId, number) {
    return this.#change(key, move => {
      const action = move.actions.find(row => row.id === actionId);
      if (!action || action.type !== 'webhook' || action.status !== 'running' || number !== action.attempts.length + 1 || number > 3) fail('A webhook attempt needs fresh, persisted running intent.', 'JOURNAL_ATTEMPT_INVALID');
      action.attempts.push({ number, startedAt: Date.now() });
      return { changed: true, value: number };
    });
  }

  async finishAction(key, actionId, result) {
    const saved = outcome(result);
    return this.#change(key, move => {
      const action = move.actions.find(row => row.id === actionId);
      if (!action) fail('This move does not contain that action.', 'JOURNAL_ACTION_NOT_FOUND');
      if (action.status !== 'running') return { changed: false, value: false };
      if (saved.attempts !== undefined && (action.type !== 'webhook' || saved.attempts !== action.attempts.length)) fail('The outcome must match the persisted webhook attempts.', 'JOURNAL_ATTEMPT_INVALID');
      action.status = saved.status; action.outcome = saved; action.finishedAt = Date.now();
      return { changed: true, value: true };
    });
  }

  async skipAction(key, actionId, reason) {
    const saved = outcome({ status: 'skipped', reason });
    return this.#change(key, move => {
      const action = move.actions.find(row => row.id === actionId);
      if (!action) fail('This move does not contain that action.', 'JOURNAL_ACTION_NOT_FOUND');
      if (action.status !== 'pending') return { changed: false, value: false };
      if (move.phase !== action.trigger) fail('Only the current automation phase may be skipped.', 'JOURNAL_ORDER');
      action.status = 'skipped'; action.outcome = saved; action.finishedAt = Date.now();
      return { changed: true, value: true };
    });
  }

  advance(key) {
    return this.#change(key, move => {
      if (move.phase === 'complete') return { changed: false, value: move.phase };
      if (!['exit', 'enter'].includes(move.phase) || move.actions.some(action => action.trigger === move.phase && !TERMINAL.includes(action.status))) fail('Finish this move phase before advancing.', 'JOURNAL_ORDER');
      move.phase = move.phase === 'exit' ? 'lifecycle' : 'complete';
      if (move.phase === 'complete') { move.status = 'completed'; move.finishedAt = Date.now(); }
      return { changed: true, value: move.phase };
    });
  }

  startLifecycle(key) {
    return this.#change(key, move => {
      if (move.lifecycle.status !== 'pending') return { changed: false, value: false };
      if (move.phase !== 'lifecycle') fail('Exit actions must finish before the session lifecycle starts.', 'JOURNAL_ORDER');
      move.lifecycle = { status: 'running', startedAt: Date.now() }; move.status = 'running';
      return { changed: true, value: true };
    });
  }

  async finishLifecycle(key, result) {
    const saved = outcome(result, ['succeeded', 'failed', 'cancelled']);
    return this.#change(key, move => {
      if (move.lifecycle.status !== 'running') return { changed: false, value: false };
      move.lifecycle = { ...move.lifecycle, status: saved.status, finishedAt: Date.now(), outcome: saved };
      if (saved.status === 'succeeded') move.phase = 'enter';
      else {
        for (const action of move.actions) if (action.status === 'pending') Object.assign(action, { status: 'skipped', finishedAt: Date.now(), outcome: { status: 'skipped', reason: 'The session lifecycle did not complete.' } });
        move.status = saved.status; move.phase = 'complete'; move.finishedAt = Date.now();
      }
      return { changed: true, value: true };
    });
  }

  cancelMove(key) {
    return this.#change(key, move => {
      if (move.phase === 'complete') return { changed: false, value: false };
      if (move.lifecycle.status === 'running' || move.actions.some(action => action.status === 'running')) fail('Stop owned work and record its outcome before cancelling the remaining move.', 'JOURNAL_WORK_ACTIVE');
      const now = Date.now();
      for (const action of move.actions) if (action.status === 'pending') Object.assign(action, { status: 'skipped', finishedAt: now, outcome: { status: 'skipped', reason: 'The move was cancelled before this automation started.' } });
      if (move.lifecycle.status === 'pending') Object.assign(move.lifecycle, { status: 'cancelled', finishedAt: now, outcome: { status: 'cancelled', reason: 'The move was cancelled before its session lifecycle started.' } });
      move.status = 'cancelled'; move.phase = 'complete'; move.finishedAt = now;
      return { changed: true, value: true };
    });
  }

  async list() {
    let folders;
    try { folders = (await readdir(this.dir)).filter(name => /^[a-f0-9]{64}$/.test(name)).sort(); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const moves = [];
    for (const name of folders) {
      // The first immutable revision contains the identity needed to validate the latest.
      let first;
      try { first = await readJson(join(this.dir, name, '00000000.json')); }
      catch (error) {
        if (error instanceof PipelineJournalError) throw error;
        if (error.code === 'ENOENT' && !(await readdir(join(this.dir, name))).some(file => /^\d{8}\.json$/.test(file))) continue;
        fail('The automation move index is invalid.', 'JOURNAL_CORRUPT');
      }
      let key;
      try { key = identity(first); } catch { fail('The automation move index is invalid.', 'JOURNAL_CORRUPT'); }
      if (folderName(key) !== name) fail('The automation move index is invalid.', 'JOURNAL_CORRUPT');
      validate(first, key, 0);
      moves.push(await this.read(key));
    }
    return moves;
  }

  async recoverInterrupted() {
    const recovered = [];
    for (const snapshot of await this.list()) {
      if (snapshot.phase === 'complete' || ownerAlive(snapshot.ownerPid)) continue;
      const changed = await this.#change(snapshot, move => {
        if (move.phase === 'complete' || ownerAlive(move.ownerPid)) return { changed: false, value: false };
        const result = { status: 'interrupted', reason: 'The application stopped before this move finished. It will not be replayed.' };
        for (const action of move.actions) if (['pending', 'running'].includes(action.status)) Object.assign(action, { status: 'interrupted', finishedAt: Date.now(), outcome: result });
        if (['pending', 'running'].includes(move.lifecycle.status)) Object.assign(move.lifecycle, { status: 'interrupted', finishedAt: Date.now(), outcome: result });
        move.status = 'interrupted'; move.phase = 'complete'; move.finishedAt = Date.now();
        return { changed: true, value: true };
      }, true);
      if (changed) recovered.push(await this.read(snapshot));
    }
    return recovered;
  }
}
