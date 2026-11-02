/**
 * Network job schedules (docs/network/architecture.md §4.1, §4.4, §11.4, §14 item 7, §23): a saved job (an agent with its
 * input) or a published pipeline version, run daily, on weekdays, weekly, monthly or only on demand. The repeat and its slot
 * arithmetic are Kanban's (src/schedules.mjs: normalizeCadence, nextFire, dueSlot, since), in this computer's local time;
 * the IANA zone is recorded when the schedule is made and confirmed, and a schedule never fires while the computer's zone
 * differs from it (the owner confirms it again).
 *
 * A schedule starts switched off. Only the owner's Confirm at the computer (a local-only route) switches it on; a change of
 * what it runs or when switches it off again; saving, editing, importing or restoring never starts anything. Slots count from
 * the confirmation, so nothing before it is caught up. Of the slots missed while the app was closed only the latest fires
 * (one job, never one per slot); a slot whose previous job (or run) is still open is skipped and used up (no pile-up); a
 * used slot is recorded, and a job slot is also its idempotency key `slot:<time>`, so a restart never starts one twice.
 * Run now starts one job at once through the same path (an explicit owner action).
 *
 * Storage: <dataDir>/network/schedules.json (promptboard.network-schedules v1, with .bak), created on the first schedule.
 */
import { join } from 'node:path';
import { serial } from '../durable.mjs';
import { dueSlot, nextFire, normalizeCadence, since } from '../schedules.mjs';
import { jobSubmission } from './jobs.mjs';
import { cleanText, conflict, fail, LINE_BREAK, NetworkError, newId, object, only, readSettings, requireRevision, writeDocument } from './storage.mjs';

const SCHEMA = 'promptboard.network-schedules', KIB = 1024;
/** Resource ceilings (architecture §4.2 rule 8), not product limits. */
export const SCHEDULE_LIMITS = Object.freeze({ schedules: 100, name: 80, maxWaitMs: 60_000 });
const SCHEDULE_ID = /^sch_[0-9a-f]{20}$/, PIPELINE_ID = /^pip_[0-9a-f]{20}$/, ZONE = /^[A-Za-z0-9_+\-/]{1,64}$/, KEY = /^[^\u0000-\u001f\u007f]{1,200}$/;
const JOB_TARGET = ['agentId', 'input', 'instructions', 'tools', 'permissions', 'limits', 'requireApproval', 'projectId', 'networkId'];
const ENDED = new Set(['completed', 'failed', 'cancelled']); // Jobs and runs alike: anything else is open (needs the owner, or still running).
const time = value => Number.isSafeInteger(value) && value >= 0;
const nullable = check => value => value === null || check(value);
const systemZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
/** Kanban's slot counting, from the owner's confirmation (not from the last edit) and the last slot used. */
const counting = row => ({ cadence: row.cadence, lastSlot: row.lastSlot, updatedAt: row.confirmedAt, createdAt: row.confirmedAt });
const due = row => row.enabled && row.cadence.kind !== 'on_demand';

function nameOf(value) {
  if (typeof value !== 'string' || LINE_BREAK.test(value)) fail('Name the schedule in one line.');
  const name = cleanText(value).slice(0, SCHEDULE_LIMITS.name);
  if (!name) fail('Name the schedule.');
  return name;
}
function cadenceOf(value) {
  if (object(value) && value.kind === 'on_demand') { only(value, ['kind'], 'a repeat'); return { kind: 'on_demand' }; }
  try { return normalizeCadence(value); } catch (error) { return fail(`${error.message} Or choose On demand.`, 'INVALID_SCHEDULE'); }
}
/** What a schedule runs: a job for one agent (the job submission's own rules) or a published pipeline version. */
function targetOf(value) {
  if (!object(value)) fail('Choose what the schedule runs: an agent with its input, or a published pipeline version.');
  if (Object.hasOwn(value, 'pipelineId')) {
    only(value, ['pipelineId', 'version', 'input'], 'a pipeline target');
    if (typeof value.pipelineId !== 'string' || !PIPELINE_ID.test(value.pipelineId)) fail('Choose a pipeline.');
    if (!Number.isSafeInteger(value.version) || value.version < 1) fail('Choose a published version of the pipeline.');
    if (value.input !== undefined) {
      only(value.input, ['text', 'json'], 'the run input');
      if ((value.input.text !== undefined && typeof value.input.text !== 'string') || (value.input.json !== undefined && !object(value.input.json))) fail('The run input is { text?, json? }.');
    }
    return { pipelineId: value.pipelineId, version: value.version, ...(value.input !== undefined ? { input: value.input } : {}) };
  }
  only(value, JOB_TARGET, 'a job target');
  const spec = jobSubmission(value); // Cleaned and bounded exactly as a submitted job is.
  return { agentId: spec.agentId, input: spec.input, instructions: spec.instructions, tools: spec.tools, permissions: spec.permissions,
    ...(spec.timeoutMs !== null ? { limits: { timeoutMs: spec.timeoutMs } } : {}), requireApproval: spec.requireApproval, projectId: spec.projectId, networkId: spec.networkId };
}
const storedRow = row => object(row) && SCHEDULE_ID.test(row.id) && typeof row.name === 'string' && object(row.target) && object(row.cadence) && typeof row.timeZone === 'string'
  && typeof row.enabled === 'boolean' && [row.confirmedAt, row.lastSlot, row.lastFiredAt].every(nullable(time)) && time(row.createdAt) && Number.isSafeInteger(row.revision)
  && (row.lastSkip === null || object(row.lastSkip));
const stored = data => Number.isSafeInteger(data.revision) && Array.isArray(data.schedules) && data.schedules.every(storedRow);

export class NetworkSchedules {
  /**
   * `jobs` (NetworkJobs) submits a schedule's job; `runs` (PipelineRunner) starts a pipeline run; `registry` checks agents.
   * `now`, `zone` (the computer's IANA zone) and the timer functions are injectable for tests.
   */
  constructor({ dataDir, jobs, runs = null, registry, events = null, now = Date.now, zone = systemZone, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { path: join(dataDir, 'network', 'schedules.json'), jobs, runs, registry, events, now, zone, setTimer, clearTimer });
  }
  #serial = serial();
  #doc = null;
  #timer = null;
  #stopped = true;
  #busy = false;
  #again = false;

  async #load() {
    return this.#doc ??= await readSettings(this.path, { schema: SCHEMA, label: 'The Network schedules', valid: stored, now: this.now, events: this.events,
      reset: data => ({ ...data, schedules: data.schedules.map(row => ({ ...row, enabled: false, confirmedAt: null, revision: row.revision + 2 })) }) }) ?? { schema: SCHEMA, version: 1, revision: 0, schedules: [] };
  }
  async #write(next) { await writeDocument(this.path, next); this.#doc = next; return next; }
  /** A row's own change (firing, skipping) keeps the revisions, so an edit the owner has open never conflicts with a firing. */
  async #keep(row) { const doc = await this.#load(); await this.#write({ ...doc, schedules: doc.schedules.map(item => (item.id === row.id ? row : item)) }); return row; }
  #row(doc, id) {
    const row = typeof id === 'string' && SCHEDULE_ID.test(id) ? doc.schedules.find(item => item.id === id) : null;
    return row || fail('This schedule no longer exists. Reload the list.', 'NOT_FOUND', 404);
  }
  #view(row, now) {
    const mismatch = row.timeZone !== this.zone();
    return { ...row, next: due(row) && !mismatch ? nextFire(row.cadence, Math.max(since(counting(row), now), now)) : null, zoneMismatch: mismatch };
  }
  async #checkTarget(target) {
    if (target.pipelineId) {
      if (!this.runs) fail('Pipelines are not available in this app.', 'NOT_FOUND', 404);
      await this.runs.pipelines.version(target.pipelineId, target.version).catch(error => { if (error.code === 'NOT_FOUND') fail('Choose a published version of a saved pipeline.', 'PIPELINE_NOT_FOUND', 409); throw error; });
      return;
    }
    await this.registry.agent(target.agentId).catch(error => { if (error.code === 'NOT_FOUND') fail('Choose an agent registered in Network.', 'AGENT_NOT_FOUND', 409); throw error; });
  }
  #event(row, status, { jobId, runId, errorCode, message }) {
    try {
      Promise.resolve(this.events?.append({ type: 'schedule.run', scheduleId: row.id, agentId: row.target.agentId, networkId: row.target.networkId ?? undefined, jobId, pipelineRunId: runId, status, errorCode,
        message: `Schedule “${row.name}”: ${message}` })).catch(() => {});
    } catch {}
  }

  /** GET /api/network/schedules: each with its next time (null when off, on demand or in another zone) and the computer's zone. */
  async list() {
    const doc = await this.#serial(() => this.#load()), now = this.now();
    return { revision: doc.revision, ...(doc.recovery ? { recovery: doc.recovery } : {}), timeZone: this.zone(), schedules: doc.schedules.map(row => this.#view(row, now)), limits: SCHEDULE_LIMITS };
  }
  /** A new schedule, always switched off: nothing runs until the owner confirms it at the computer. */
  async create(input) {
    only(input, ['expectedRevision', 'name', 'target', 'cadence'], 'a schedule');
    requireRevision(input);
    const name = nameOf(input.name), target = targetOf(input.target), cadence = cadenceOf(input.cadence);
    await this.#checkTarget(target);
    return this.#serial(async () => {
      const doc = await this.#load(), at = this.now();
      if (input.expectedRevision !== doc.revision) conflict('Network schedules');
      if (doc.schedules.length >= SCHEDULE_LIMITS.schedules) fail(`Network keeps at most ${SCHEDULE_LIMITS.schedules} schedules. Delete one first.`, 'NETWORK_LIMIT', 409);
      const row = { id: newId('sch'), name, target, cadence, timeZone: this.zone(), enabled: false, confirmedAt: null, lastSlot: null, lastJobId: null, lastRunId: null, lastFiredAt: null, lastSkip: null,
        createdAt: at, updatedAt: at, revision: 1 };
      const saved = await this.#write({ ...doc, revision: doc.revision + 1, schedules: [...doc.schedules, row] });
      return { revision: saved.revision, schedule: this.#view(row, at) };
    });
  }
  /**
   * Edit a schedule (allowed from a paired phone): its name, what it runs, its repeat, or switch it off. It is never switched
   * on here; changing what an enabled schedule runs, or when, switches it off until it is confirmed again.
   */
  async update(id, input) {
    only(input, ['expectedRevision', 'name', 'target', 'cadence', 'enabled'], 'a schedule change');
    requireRevision(input);
    if (input.enabled !== undefined && input.enabled !== false) fail('Switch a schedule on with Confirm, at the computer that runs Promptboard.', 'CONFIRMATION_REQUIRED');
    const name = input.name === undefined ? null : nameOf(input.name), target = input.target === undefined ? null : targetOf(input.target), cadence = input.cadence === undefined ? null : cadenceOf(input.cadence);
    if (target) await this.#checkTarget(target);
    return this.#serial(async () => {
      const doc = await this.#load(), row = this.#row(doc, id), at = this.now();
      if (input.expectedRevision !== row.revision) conflict('This schedule');
      const changed = (target && JSON.stringify(target) !== JSON.stringify(row.target)) || (cadence && JSON.stringify(cadence) !== JSON.stringify(row.cadence));
      const off = input.enabled === false || (row.enabled && changed);
      const next = { ...row, ...(name ? { name } : {}), ...(target ? { target } : {}), ...(cadence ? { cadence } : {}), ...(off ? { enabled: false, confirmedAt: null } : {}), updatedAt: at, revision: row.revision + 1 };
      const saved = await this.#write({ ...doc, revision: doc.revision + 1, schedules: doc.schedules.map(item => (item.id === id ? next : item)) });
      return { revision: saved.revision, schedule: this.#view(next, at), switchedOff: row.enabled && !next.enabled };
    });
  }
  /** Delete a schedule; the jobs and runs it started stay. */
  async remove(id, input) {
    only(input, ['expectedRevision'], 'a delete request');
    requireRevision(input);
    return this.#serial(async () => {
      const doc = await this.#load(), row = this.#row(doc, id);
      if (input.expectedRevision !== row.revision) conflict('This schedule');
      const saved = await this.#write({ ...doc, revision: doc.revision + 1, schedules: doc.schedules.filter(item => item.id !== id) });
      return { revision: saved.revision, deleted: id };
    });
  }
  /**
   * Switch a schedule on (local-only route: standing automation is set up at the computer). Records the computer's zone and
   * the confirmation time, from which slots count, so nothing before it is caught up.
   */
  async confirm(id, input) {
    only(input, ['expectedRevision', 'confirm'], 'a confirmation');
    requireRevision(input);
    if (input.confirm !== true) fail('Confirm that this schedule may start jobs on its own (confirm: true).', 'CONFIRMATION_REQUIRED');
    const result = await this.#serial(async () => {
      const doc = await this.#load(), row = this.#row(doc, id), at = this.now();
      if (input.expectedRevision !== row.revision) conflict('This schedule');
      if (row.cadence.kind === 'on_demand') fail('An on-demand schedule runs only when you choose Run now, so it has nothing to switch on.', 'SCHEDULE_ON_DEMAND', 409);
      await this.#checkTarget(row.target);
      const next = { ...row, enabled: true, confirmedAt: at, timeZone: this.zone(), lastSkip: null, updatedAt: at, revision: row.revision + 1 };
      const saved = await this.#write({ ...doc, revision: doc.revision + 1, schedules: doc.schedules.map(item => (item.id === id ? next : item)) });
      return { revision: saved.revision, schedule: this.#view(next, at) };
    });
    this.wake();
    return result;
  }
  /** Run now: one job (or run) at once, even while the schedule is off or its previous job is open (the owner asked). */
  async runNow(id, input = {}) {
    only(input, ['idempotencyKey'], 'a run request');
    const key = input.idempotencyKey ?? null;
    if (key !== null && (typeof key !== 'string' || !KEY.test(key) || LINE_BREAK.test(key))) fail('The idempotency key is 1 to 200 printable characters.');
    return this.#serial(async () => {
      const row = this.#row(await this.#load(), id), at = this.now(), started = await this.#start(row, null, key && `run:${key}`);
      const saved = await this.#keep({ ...row, ...started.fields, lastFiredAt: at, lastSkip: null });
      this.#event(saved, 'started', { ...started, message: `started ${started.runId ? `run ${started.runId}` : `job ${started.jobId}`} (Run now).` });
      return { schedule: this.#view(saved, at), ...(started.runId ? { runId: started.runId } : { jobId: started.jobId, status: started.status, deduplicated: started.deduplicated }) };
    });
  }
  /** Start what the schedule runs: a job under the schedule's own requester and `key`, or a confirmed run of the pinned version. */
  async #start(row, slot, key) {
    if (row.target.pipelineId) {
      if (!this.runs) fail('Pipelines are not available in this app.', 'NOT_FOUND', 404);
      const { runId } = await this.runs.startRun(row.target.pipelineId, { version: row.target.version, confirm: true, ...(row.target.input ? { input: row.target.input } : {}) }, { by: 'schedule' });
      return { runId, fields: { lastRunId: runId, lastJobId: null } };
    }
    let accepted;
    try { accepted = await this.jobs.submit({ ...row.target, ...(key ? { idempotencyKey: key } : {}) }, { requester: { kind: 'schedule', id: row.id }, link: { schedule: { id: row.id, slot } } }); }
    catch (error) { if (error.code !== 'IDEMPOTENCY_CONFLICT' || !error.details?.jobId) throw error; accepted = { jobId: error.details.jobId, status: null, deduplicated: true }; } // That slot's job exists.
    return { jobId: accepted.jobId, status: accepted.status, deduplicated: accepted.deduplicated, fields: { lastJobId: accepted.jobId, lastRunId: null } };
  }
  /** The schedule's job or run that has not ended (also one that needs the owner's decision), or null. */
  async #openWork(row) {
    // ponytail: pages through the agent's jobs (or the pipeline's runs) per due slot; a requester index if schedules ever fire often.
    const [list, key, mine] = row.target.pipelineId ? [page => this.runs.list({ pipelineId: row.target.pipelineId, ...page }), 'runs', () => true]
      : [page => this.jobs.list({ agentId: row.target.agentId, ...page }), 'jobs', job => job.requester?.kind === 'schedule' && job.requester.id === row.id];
    for (let offset = 0; offset !== null;) {
      const page = await list({ offset, limit: 200 }), open = page[key].find(item => mine(item) && !ENDED.has(item.status));
      if (open) return { kind: key === 'runs' ? 'run' : 'job', id: open.id };
      offset = page.next;
    }
    return null;
  }
  /**
   * The slot `slot` of schedule `id` is due. Inside the queue, again: still on, same zone. The previous job or
   * run still open → the slot is skipped and used up. Otherwise a job is submitted under the key `slot:<slot>` (so a restart
   * between the submit and this save finds the same job), or a pipeline's slot is saved first and then its run starts (runs
   * have no idempotency key: a crash in between loses that one run rather than starting it twice). A refusal (agent switched
   * off, pipeline gone…) uses the slot up and says why; a storage failure, a shutdown or a Base change during the submit leaves
   * a job's slot for the next check.
   */
  async #fire(id, slot) {
    return this.#serial(async () => {
      let row = (await this.#load()).schedules.find(item => item.id === id);
      const at = this.now();
      // Still on and in the same zone (the owner may have changed it since the check). dueSlot already counts from lastSlot,
      // and a lastSlot written while the clock ran ahead is ignored as Kanban does (src/schedules.mjs `recorded`).
      if (!row || !due(row) || row.timeZone !== this.zone()) return null;
      // `slot` came from the row the tick read first; switched off and on again since, it counts from the new confirmation.
      if (dueSlot(counting(row), at) !== slot) return null;
      const open = await this.#openWork(row);
      if (open) {
        const saved = await this.#keep({ ...row, lastSlot: slot, lastSkip: { at, slot, code: 'PREVIOUS_OPEN', reason: `The previous ${open.kind} ${open.id} is still open, so this time was skipped.` } });
        this.#event(saved, 'skipped', { jobId: open.kind === 'job' ? open.id : undefined, runId: open.kind === 'run' ? open.id : undefined, errorCode: 'PREVIOUS_OPEN', message: `skipped a time: the previous ${open.kind} ${open.id} is still open.` });
        return null;
      }
      if (row.target.pipelineId) row = await this.#keep({ ...row, lastSlot: slot, lastRunId: null, lastJobId: null, lastFiredAt: at, lastSkip: null });
      try {
        const started = await this.#start(row, slot, `slot:${slot}`);
        const saved = await this.#keep({ ...row, ...started.fields, lastSlot: slot, lastFiredAt: at, lastSkip: null });
        this.#event(saved, 'started', { ...started, message: `started ${started.runId ? `run ${started.runId}` : `job ${started.jobId}`}${at - slot > 120_000 ? ' late (Promptboard was not running at its time; missed times run once)' : ''}.` });
        return started;
      } catch (error) {
        // "Try again" (shutting down, a storage failure, the Base changing during the submit) leaves a job's time for the next
        // check, also after a restart: its key slot:<time> finds the job if the submit did happen. A pipeline's time is saved above.
        if (!(error instanceof NetworkError) || ((error.status >= 500 || error.code === 'BASE_CHANGED') && !row.target.pipelineId)) throw error;
        const saved = await this.#keep({ ...row, lastSlot: slot, lastSkip: { at, slot, code: error.code, reason: error.message.slice(0, 300) } });
        this.#event(saved, 'failed', { errorCode: error.code, message: `could not start: ${error.message}` });
        return null;
      }
    });
  }

  start() { this.#stopped = false; this.#arm(1000); }
  stop() { this.#stopped = true; this.clearTimer(this.#timer); }
  /** Check again now, after a confirmation. */
  wake() { if (this.#busy) this.#again = true; else this.#arm(0); }
  #arm(ms) {
    this.clearTimer(this.#timer);
    if (this.#stopped) return;
    this.#timer = this.setTimer(() => { this.tick().catch(() => {}); }, Math.max(0, Math.min(SCHEDULE_LIMITS.maxWaitMs, ms)));
    this.#timer?.unref?.();
  }
  /** Fire what is due, then sleep until the earliest next slot (at most a minute, so sleep and clock changes are noticed). */
  async tick() {
    if (this.#busy) { this.#again = true; return; }
    this.#busy = true;
    let wait = SCHEDULE_LIMITS.maxWaitMs;
    try {
      const now = this.now();
      for (const row of (await this.#serial(() => this.#load())).schedules) {
        if (!due(row) || row.timeZone !== this.zone()) continue; // Another zone: shown as a warning, never fired.
        const slot = dueSlot(counting(row), now);
        if (slot !== null) await this.#fire(row.id, slot).catch(() => {});
        const next = nextFire(row.cadence, Math.max(since(counting(row), now), now));
        if (next !== null) wait = Math.min(wait, next - now);
      }
    } finally {
      this.#busy = false;
      this.#arm(this.#again ? 0 : wait);
      this.#again = false;
    }
  }

  /** The Network export's part (architecture §4.4): job schedules as definitions only — never on/off, confirmations or history. */
  async definitions() {
    const doc = await this.#serial(() => this.#load());
    return doc.schedules.filter(row => !row.target.pipelineId).map(({ id, name, target, cadence, timeZone, createdAt, updatedAt }) => ({ id, name, target, cadence, timeZone, createdAt, updatedAt }));
  }
  /** An export's schedule definitions, checked before anything of the import is written; every agent and network is in the file. */
  async checkImport(list, { agentIds, networkIds }) {
    if (list === undefined) return [];
    if (!Array.isArray(list)) fail('This file is not a valid Network export. Nothing was imported.', 'NETWORK_IMPORT_INVALID');
    const doc = await this.#serial(() => this.#load());
    if (doc.schedules.length + list.length > SCHEDULE_LIMITS.schedules) fail(`Network keeps at most ${SCHEDULE_LIMITS.schedules} schedules. Nothing was imported.`, 'NETWORK_LIMIT', 409);
    const definitions = list.map(item => {
      only(item, ['id', 'name', 'target', 'cadence', 'timeZone', 'createdAt', 'updatedAt'], 'a schedule definition');
      if (typeof item.id !== 'string' || !SCHEDULE_ID.test(item.id) || typeof item.timeZone !== 'string' || !ZONE.test(item.timeZone) || !object(item.target) || Object.hasOwn(item.target, 'pipelineId')) {
        fail('This file is not a valid Network export. Nothing was imported.', 'NETWORK_IMPORT_INVALID');
      }
      return { id: item.id, name: nameOf(item.name), target: targetOf(item.target), cadence: cadenceOf(item.cadence), timeZone: item.timeZone, createdAt: time(item.createdAt) ? item.createdAt : this.now() };
    });
    const missing = definitions.filter(({ target }) => !agentIds.has(target.agentId) || (target.networkId && !networkIds.has(target.networkId)));
    if (missing.length) fail('A schedule in the file names an agent or network the file does not contain. Nothing was imported.', 'NETWORK_IMPORT_UNRESOLVED', 409, { scheduleIds: missing.map(item => item.id) });
    return definitions;
  }
  /** Add checked definitions after the registry part of the import: references remapped, switched off, never fired. */
  async importDefinitions(definitions, { agents = {}, networks = {} }, projects) {
    if (!definitions.length) return { imported: 0, warnings: [] };
    return this.#serial(async () => {
      const doc = await this.#load(), taken = new Set(doc.schedules.map(row => row.id)), at = this.now(), warnings = [];
      const rows = definitions.map(item => {
        let target = { ...item.target, agentId: agents[item.target.agentId] ?? item.target.agentId, networkId: item.target.networkId ? networks[item.target.networkId] ?? item.target.networkId : null };
        if (target.projectId && !projects.has(target.projectId)) {
          warnings.push(`The schedule “${item.name}” names a project that is not on this board; it was removed from it.`);
          target = { ...target, projectId: null, permissions: { ...target.permissions, projectLessons: false } };
        }
        const id = taken.has(item.id) ? newId('sch') : item.id;
        taken.add(id);
        return { id, name: item.name, target, cadence: item.cadence, timeZone: item.timeZone, enabled: false, confirmedAt: null, lastSlot: null, lastJobId: null, lastRunId: null, lastFiredAt: null, lastSkip: null,
          createdAt: item.createdAt, updatedAt: at, revision: 1 };
      });
      await this.#write({ ...doc, revision: doc.revision + 1, schedules: [...doc.schedules, ...rows] });
      return { imported: rows.length, warnings };
    });
  }
}
