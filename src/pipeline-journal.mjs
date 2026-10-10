/** Durable move intent. This module never executes or automatically retries an action. */
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizePipelineAutomations } from './pipeline-config.mjs';

const SCHEMA = 'promptboard.automation-move', VERSION = 2, LIMIT = 4096;
const TYPES = ['send_message', 'run_script', 'webhook', 'notify'];
const TERMINAL = ['succeeded', 'failed', 'cancelled', 'timed_out', 'unconfirmed', 'skipped', 'interrupted', 'scheduled'];
const DELIVERY_ACTIVE = ['queued', 'dispatching', 'submitted', 'accepted'];
const DELIVERY_TERMINAL = ['confirmed', 'failed', 'cancelled', 'timed_out', 'unconfirmed', 'interrupted'];
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
function outcome(value, allowed = TERMINAL.filter(status => !['interrupted', 'scheduled'].includes(status))) {
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
function deliveryScope(value) {
  if (!keys(value, ['provider', 'sessionId', 'runId', 'mode', 'messageHash']) || !['claude', 'codex', 'gemini'].includes(value.provider)
    || !id(value.sessionId) || !id(value.runId) || !['immediate', 'deferred'].includes(value.mode) || typeof value.messageHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.messageHash)) fail('A queued message needs its exact session/run scope and rendered message hash.', 'JOURNAL_DELIVERY_INVALID');
  return structuredClone(value);
}
function deliveryOutcome(value, recovery = false) {
  if (!keys(value, ['status', 'reason', 'errorCode', 'durationMs'])) fail('Use a bounded message receipt without raw conversation content.', 'JOURNAL_DELIVERY_INVALID');
  return outcome(value, DELIVERY_TERMINAL.filter(status => recovery || status !== 'interrupted'));
}
function validateDelivery(value) {
  if (!keys(value, ['provider', 'sessionId', 'runId', 'mode', 'messageHash', 'status', 'queuedAt', 'dispatchStartedAt', 'submittedAt', 'acceptedAt', 'finishedAt', 'outcome'])) throw new Error();
  deliveryScope(Object.fromEntries(['provider', 'sessionId', 'runId', 'mode', 'messageHash'].map(key => [key, value[key]])));
  if (![...DELIVERY_ACTIVE, ...DELIVERY_TERMINAL].includes(value.status) || !integer(value.queuedAt)
    || ['dispatchStartedAt', 'submittedAt', 'acceptedAt', 'finishedAt'].some(key => value[key] !== undefined && !integer(value[key]))
    || value.submittedAt !== undefined && value.dispatchStartedAt === undefined || value.acceptedAt !== undefined && value.submittedAt === undefined
    || value.status === 'queued' && ['dispatchStartedAt', 'submittedAt', 'acceptedAt'].some(key => value[key] !== undefined)
    || value.status === 'dispatching' && (value.dispatchStartedAt === undefined || value.submittedAt !== undefined || value.acceptedAt !== undefined)
    || value.status === 'submitted' && (value.submittedAt === undefined || value.acceptedAt !== undefined)
    || value.status === 'accepted' && value.acceptedAt === undefined
    || value.status === 'confirmed' && value.submittedAt === undefined
    || DELIVERY_ACTIVE.includes(value.status) && (value.finishedAt !== undefined || value.outcome !== undefined)
    || DELIVERY_TERMINAL.includes(value.status) && (value.finishedAt === undefined || value.outcome?.status !== value.status)) throw new Error();
  if (value.outcome) deliveryOutcome(value.outcome, true);
}
const hasPendingDelivery = move => move.actions.some(action => action.delivery && DELIVERY_ACTIVE.includes(action.delivery.status));
const unfinished = move => move.phase !== 'complete' || hasPendingDelivery(move);
// ponytail: each renewal is one journal revision, so at TTL/3 the 4,096-revision cap allows ~22 h of
// continuous ownership per move. Move heartbeats to a side file if a move must stay active longer.
const LEASE_MS = 60000;
// A PID can be reused, even by a later Promptboard process. A per-process instance ID tells this
// process's own moves from those of an earlier process that had the same PID.
export const OWNER_INSTANCE = randomUUID();
/** This process owns the move: same PID and instance, and an unexpired lease. Moves saved without a lease keep the PID/instance check. */
export const ownsMove = move => move?.ownerPid === process.pid && (move.ownerInstance === undefined || move.ownerInstance === OWNER_INSTANCE)
  && (move.leaseExpiresAt === undefined || move.leaseExpiresAt > Date.now());
function ownerAlive(move) {
  // A live PID can belong to an unrelated process, so only an expired lease releases a leased move.
  if (move.leaseExpiresAt !== undefined) return move.leaseExpiresAt >= Date.now();
  if (move.ownerPid === process.pid) return ownsMove(move);
  try { process.kill(move.ownerPid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
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
  if (!keys(data, ['schema', 'version', 'revision', 'projectId', 'taskId', 'transitionId', 'taskRevision', 'projectRevision', 'from', 'to', 'ownerPid', 'ownerInstance', 'leaseId', 'heartbeatAt', 'leaseExpiresAt', 'status', 'phase', 'createdAt', 'updatedAt', 'finishedAt', 'actions', 'lifecycle'])
    || data.schema !== SCHEMA || ![1, VERSION].includes(data.version) || data.revision !== revision
    || Object.entries(key).some(([name, value]) => data[name] !== value)
    || !integer(data.taskRevision) || !integer(data.projectRevision) || !Number.isSafeInteger(data.ownerPid) || data.ownerPid < 1 || (data.ownerInstance !== undefined && !id(data.ownerInstance))
    || (['leaseId', 'heartbeatAt', 'leaseExpiresAt'].some(name => data[name] !== undefined) && (data.ownerInstance === undefined || !id(data.leaseId) || !integer(data.heartbeatAt) || !integer(data.leaseExpiresAt)))
    || !integer(data.createdAt) || !integer(data.updatedAt) || (data.finishedAt !== undefined && !integer(data.finishedAt))
    || !['pending', 'running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(data.status)
    || !['exit', 'lifecycle', 'enter', 'complete'].includes(data.phase) || !Array.isArray(data.actions) || data.actions.length > 80) fail('The automation journal is invalid; it was not changed.', 'JOURNAL_CORRUPT');
  try {
    column(data.from); column(data.to);
    const ids = new Set();
    for (const action of data.actions) {
      if (!keys(action, ['id', 'rowId', 'name', 'type', 'trigger', 'columnId', 'configHash', 'status', 'startedAt', 'finishedAt', 'attempts', 'outcome', ...(data.version === 2 ? ['delivery'] : [])])
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
      if (action.status === 'scheduled') {
        if (data.version !== 2 || action.type !== 'send_message' || action.trigger !== 'enter' || !action.delivery || data.lifecycle.status !== 'succeeded') throw new Error();
        validateDelivery(action.delivery);
        if (!keys(action.outcome, ['status', 'reason'])) throw new Error();
      } else if (action.delivery !== undefined) throw new Error();
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
    if (data.phase === 'complete' && hasPendingDelivery(data) && data.status !== 'completed') throw new Error();
    if (data.status === 'completed' && lifecycle.status !== 'succeeded') throw new Error();
    if (data.status === 'failed' && !['failed', 'cancelled'].includes(lifecycle.status)) throw new Error();
  } catch { fail('The automation journal is invalid; it was not changed.', 'JOURNAL_CORRUPT'); }
  return data;
}

export class PipelineJournal {
  #leases = new Map(); #waiting = new Map();
  /** `onLeaseLost(key)` runs when another process recovered a move this process still renewed. */
  constructor(dataDir, { leaseMs = LEASE_MS, onLeaseLost = null } = {}) {
    this.dir = join(dataDir, 'automations'); this.dataDir = dataDir; this.leaseMs = leaseMs; this.onLeaseLost = onLeaseLost;
  }

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
      this.#track(data);
      return true;
    } catch (error) {
      if (error instanceof PipelineJournalError) throw error;
      fail('The journal save was not acknowledged. Do not start or replay work.', 'JOURNAL_WRITE_FAILED');
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }

  // This journal still holds the lease, even past its expiry (for example after the computer slept), unless
  // recovery replaced its ID. The compare-and-swap write then decides between a late owner and a recoverer.
  #holds(move) {
    return move.ownerPid === process.pid && move.ownerInstance === OWNER_INSTANCE && move.leaseId !== undefined
      && this.#leases.get(folderName(move))?.leaseId === move.leaseId;
  }

  // One renewal per unfinished move this process owns, through the same compare-and-swap write.
  #track(move) {
    const name = folderName(move), held = this.#leases.get(name);
    if (move.leaseId !== undefined && (ownsMove(move) || this.#holds(move)) && unfinished(move)) {
      if (held) held.expiresAt = move.leaseExpiresAt;
      else this.#renewLater(name, { key: identity(move), leaseId: move.leaseId, expiresAt: move.leaseExpiresAt });
    } else if (held) { clearTimeout(held.timer); this.#leases.delete(name); }
  }

  #renewLater(name, held) {
    this.#leases.set(name, held);
    held.timer = setTimeout(() => this.#renew(name, held), Math.ceil(this.leaseMs / 3));
    held.timer.unref();
  }

  async #renew(name, held) {
    let renewed = true, lost = false;
    try {
      renewed = await this.#change(held.key, move => {
        if (!unfinished(move)) return { changed: false, value: false };
        const now = Date.now(); move.heartbeatAt = now; move.leaseExpiresAt = now + this.leaseMs;
        return { changed: true, value: true };
      });
    } catch (error) {
      // A failed save retries until the lease would lapse anyway; a lost lease is never renewed.
      lost = error.code === 'AUTOMATION_LEASE_LOST' || Date.now() > held.expiresAt;
    }
    if (this.#leases.get(name) !== held) return;
    if (renewed && !lost) return this.#renewLater(name, held);
    this.#leases.delete(name);
    if (lost) try { this.onLeaseLost?.(held.key); } catch {}
  }

  /** Shutdown: stop renewing. Leases left unfinished then expire, so a later process can recover them. */
  stopRenewals() { for (const held of this.#leases.values()) clearTimeout(held.timer); this.#leases.clear(); }

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
      taskRevision: input.taskRevision, projectRevision: input.projectRevision, ownerPid: process.pid, ownerInstance: OWNER_INSTANCE,
      leaseId: randomUUID(), heartbeatAt: now, leaseExpiresAt: now + this.leaseMs, status: 'pending', phase: 'exit', createdAt: now, updatedAt: now, actions, lifecycle: { status: 'pending' } };
    if (await this.#append(move)) return { created: true, move: structuredClone(move) };
    return { created: false, move: await this.read(key) };
  }

  async #change(input, apply, recovery = false) {
    const key = identity(input);
    for (let tries = 0; tries < LIMIT; tries++) {
      const current = await this.read(key);
      if (!current) fail('The move has not been recorded.', 'JOURNAL_NOT_FOUND');
      if (!recovery && !ownsMove(current) && !this.#holds(current)) {
        if (current.ownerPid === process.pid && current.ownerInstance === OWNER_INSTANCE) fail('This process no longer holds the lease on this move; another process may have recovered it. Its work stops without replay.', 'AUTOMATION_LEASE_LOST');
        fail('This move belongs to another application process; it cannot be replayed.', 'JOURNAL_OWNER_MISMATCH');
      }
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

  async scheduleMessage(key, actionId, scope) {
    const saved = deliveryScope(scope);
    return this.#change(key, move => {
      if (move.version !== 2) fail('This legacy move cannot schedule an asynchronous message. Use a new explicit request.', 'JOURNAL_VERSION_UNSUPPORTED');
      const action = move.actions.find(row => row.id === actionId);
      if (!action) fail('This move does not contain that action.', 'JOURNAL_ACTION_NOT_FOUND');
      if (action.status !== 'running') return { changed: false, value: { accepted: false, delivery: structuredClone(action.delivery ?? null) } };
      if (action.type !== 'send_message' || action.trigger !== 'enter' || move.phase !== 'enter' || move.lifecycle.status !== 'succeeded') fail('Only a started enter message may hand off to its session scheduler.', 'JOURNAL_ORDER');
      const now = Date.now();
      action.status = 'scheduled'; action.finishedAt = now;
      action.outcome = { status: 'scheduled', reason: 'The session scheduler owns this message; delivery is pending.' };
      action.delivery = { ...saved, status: 'queued', queuedAt: now };
      return { changed: true, value: { accepted: true, delivery: structuredClone(action.delivery) } };
    });
  }

  #deliveryChange(key, actionId, apply) {
    return this.#change(key, move => {
      const action = move.actions.find(row => row.id === actionId);
      if (!action?.delivery || action.status !== 'scheduled') fail('Schedule this enter message before dispatching it.', 'JOURNAL_DELIVERY_MISSING');
      return apply(action.delivery, move);
    });
  }

  startMessageDelivery(key, actionId) {
    return this.#deliveryChange(key, actionId, (delivery, move) => {
      if (delivery.status !== 'queued') return { changed: false, value: { accepted: false, delivery: structuredClone(delivery) } };
      if (move.lifecycle.status !== 'succeeded' || !['enter', 'complete'].includes(move.phase)) fail('The session lifecycle must finish before message dispatch.', 'JOURNAL_ORDER');
      delivery.status = 'dispatching'; delivery.dispatchStartedAt = Date.now();
      return { changed: true, value: { accepted: true, delivery: structuredClone(delivery) } };
    });
  }

  markMessageSubmitted(key, actionId) {
    return this.#deliveryChange(key, actionId, delivery => {
      if (delivery.status !== 'dispatching') return { changed: false, value: false };
      delivery.status = 'submitted'; delivery.submittedAt = Date.now();
      return { changed: true, value: true };
    });
  }

  markMessageAccepted(key, actionId) {
    return this.#deliveryChange(key, actionId, delivery => {
      if (DELIVERY_TERMINAL.includes(delivery.status) || delivery.status === 'accepted') return { changed: false, value: false };
      if (delivery.status !== 'submitted') fail('Record submission before native queue acceptance.', 'JOURNAL_ORDER');
      delivery.status = 'accepted'; delivery.acceptedAt = Date.now();
      return { changed: true, value: true };
    });
  }

  async finishMessageDelivery(key, actionId, result) {
    const saved = deliveryOutcome(result);
    return this.#deliveryChange(key, actionId, delivery => {
      if (DELIVERY_TERMINAL.includes(delivery.status)) return { changed: false, value: false };
      if (saved.status === 'confirmed' && !['submitted', 'accepted'].includes(delivery.status)) fail('Native confirmation requires a recorded submission.', 'JOURNAL_ORDER');
      delivery.status = saved.status; delivery.finishedAt = Date.now(); delivery.outcome = saved;
      return { changed: true, value: true };
    });
  }

  async finishQueuedMessageDelivery(key, actionId, result) {
    const saved = deliveryOutcome(result);
    if (saved.status === 'confirmed') fail('Queued input cannot supply native confirmation.', 'JOURNAL_ORDER');
    return this.#deliveryChange(key, actionId, delivery => {
      if (delivery.status !== 'queued') return { changed: false, value: false };
      delivery.status = saved.status; delivery.finishedAt = Date.now(); delivery.outcome = saved;
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
      if (hasPendingDelivery(move)) fail('Cancel queued message delivery and record its outcome first.', 'JOURNAL_WORK_ACTIVE');
      if (move.phase === 'complete') return { changed: false, value: false };
      if (move.lifecycle.status === 'running' || move.actions.some(action => action.status === 'running')) fail('Stop owned work and record its outcome before cancelling the remaining move.', 'JOURNAL_WORK_ACTIVE');
      const now = Date.now();
      for (const action of move.actions) if (action.status === 'pending') Object.assign(action, { status: 'skipped', finishedAt: now, outcome: { status: 'skipped', reason: 'The move was cancelled before this automation started.' } });
      if (move.lifecycle.status === 'pending') Object.assign(move.lifecycle, { status: 'cancelled', finishedAt: now, outcome: { status: 'cancelled', reason: 'The move was cancelled before its session lifecycle started.' } });
      move.status = 'cancelled'; move.phase = 'complete'; move.finishedAt = now;
      return { changed: true, value: true };
    });
  }

  async recoverInterrupted(key) {
    const recovered = [];
    // Runtime recovery inspects a task's persisted move reference without
    // depending on every other project's historical journal folder.
    const snapshots = [await this.read(key)].filter(Boolean), name = folderName(key);
    const skip = move => {
      if (!unfinished(move)) { this.#waiting.delete(name); return true; }
      if (!ownerAlive(move)) return false;
      // Another live owner, such as the unexpired lease of a crashed process: pendingRecoveries() lists it for a retry.
      if (!ownsMove(move)) this.#waiting.set(name, identity(move));
      return true;
    };
    for (const snapshot of snapshots) {
      if (skip(snapshot)) continue;
      const changed = await this.#change(snapshot, move => {
        if (skip(move)) return { changed: false, value: false };
        // A new lease ID revokes the old one: its late owner can neither renew nor write after this revision.
        if (move.leaseId !== undefined) move.leaseId = randomUUID();
        const result ={ status: 'interrupted', reason: 'The application stopped before this move finished. It will not be replayed.' };
        for (const action of move.actions) if (action.delivery && DELIVERY_ACTIVE.includes(action.delivery.status)) Object.assign(action.delivery, {
          status: 'interrupted', finishedAt: Date.now(), outcome: { status: 'interrupted', reason: 'The message scheduler stopped before delivery finished. Input will not be replayed.' } });
        // Placement can already be complete while its enter messages await delivery.
        if (move.phase === 'complete') return { changed: true, value: true };
        for (const action of move.actions) if (['pending', 'running'].includes(action.status)) Object.assign(action, { status: 'interrupted', finishedAt: Date.now(), outcome: result });
        if (['pending', 'running'].includes(move.lifecycle.status)) Object.assign(move.lifecycle, { status: 'interrupted', finishedAt: Date.now(), outcome: result });
        move.status = 'interrupted'; move.phase = 'complete'; move.finishedAt = Date.now();
        return { changed: true, value: true };
      }, true);
      if (changed) { this.#waiting.delete(name); recovered.push(await this.read(snapshot)); }
    }
    return recovered;
  }

  /** Moves whose recovery last found another live owner; retry them with recoverInterrupted(). */
  pendingRecoveries() { return [...this.#waiting.values()]; }
}
