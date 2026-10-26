/**
 * Network jobs (docs/network/architecture.md §4.1, §5, §6.1–6.2, §7.4, §11.3): general-purpose work for one registered
 * agent, outside Kanban. A job never needs a card, a branch, a worktree or a repository, and nothing here writes
 * state.json, Base, lessons or a project.
 *
 * Storage (storage.mjs discipline), created on the first submit: <dataDir>/network/jobs/<jobId>/request.json (the accepted
 * snapshot, written once; job.json keeps its SHA-256 and every read checks it), jobs/<jobId>/job.json (status, attempts,
 * outcome, history; with .bak), jobs/<jobId>/attempts/<attemptId>/result.md, result.json, late-result.md (bounded outputs,
 * never inside job.json), and network/settings.json. The index lives in memory, built by one scan at start.
 *
 * Execution belongs to an injected worker: claim(job, ownership), start(job, ownership), cancel(ownership) and
 * getStatus(ownership) → { process: 'none' | 'running' | 'ended' | 'unknown' } (synchronous). Without a worker, jobs stay
 * queued and inert, and their view says so. The engine claims FIFO within settings.maxConcurrentJobs, saves the attempt
 * before the worker hears of it, keeps the lease token in memory only, and applies a worker report only while that lease
 * owns the job's current attempt; any other write is ignored. It never infers success: `completed` needs the worker's
 * result text from a running attempt, saved to result.md before the status. An attempt that may have run and has no
 * trusted receipt ends `interrupted` or `unknown` and waits for the owner (retry with confirmation, or close): nothing is
 * replayed on its own, after a restart, or when job.json had to be read from its backup.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { access, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { primaryAgent, resolveBase } from '../base-resolver.mjs';
import { serial } from '../durable.mjs';
import { escapeId } from '../origin.mjs';
import { MEMORY_MODES } from './memory.mjs';
import { cleanText, conflict, fail, LINE_BREAK, newId, NetworkError, object, oneLine, only, page, readDocument, requireRevision, sha256, writeDocument, writeImmutable } from './storage.mjs';

const SCHEMA = { job: 'promptboard.network-job', request: 'promptboard.network-job-request', settings: 'promptboard.network-settings' };
const KIB = 1024, MINUTE = 60_000, DAY = 86_400_000;
/** Resource ceilings (architecture §4.2 rule 8, §7.4), not product limits: the number of saved jobs is unbounded. */
export const JOB_LIMITS = Object.freeze({ inputBytes: 256 * KIB, jsonBytes: 64 * KIB, instructionsBytes: 32 * KIB, resultBytes: 1024 * KIB, submitBody: 1024 * KIB,
  reason: 500, idempotencyKey: 200, minTimeoutMs: 1000, maxTimeoutMs: 120 * MINUTE, prepareTimeoutMs: 45_000, stopMs: 3000, history: 200, sweep: 500, scan: 16, retryMs: 5000 });
export const JOB_SETTINGS = Object.freeze({ maxConcurrentJobs: 2, defaultTimeoutMs: 20 * MINUTE, outputRetentionDays: 30 });
const SETTING_RANGES = { maxConcurrentJobs: [1, 4], defaultTimeoutMs: [MINUTE, JOB_LIMITS.maxTimeoutMs], outputRetentionDays: [1, 3650] };
export const JOB_STATUSES = Object.freeze(['queued', 'waiting_for_approval', 'preparing', 'running', 'waiting_for_input', 'completed', 'failed', 'cancelled', 'interrupted', 'unknown']);
/** The transition table (architecture §6.1): every status change goes through #move, which refuses anything else. */
export const JOB_TRANSITIONS = Object.freeze({
  queued: ['preparing', 'failed', 'cancelled', 'interrupted'], waiting_for_approval: ['queued', 'cancelled', 'interrupted'],
  preparing: ['running', 'failed', 'unknown', 'cancelled', 'interrupted'], running: ['completed', 'failed', 'unknown', 'waiting_for_input', 'cancelled', 'interrupted'],
  waiting_for_input: ['queued', 'cancelled', 'interrupted'], interrupted: ['queued', 'failed'], unknown: ['queued', 'failed'], completed: [], failed: [], cancelled: [] });
const LIMITS = JOB_LIMITS, NEXT = JOB_TRANSITIONS, TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const ATTEMPT_STATUSES = ['claimed', 'launching', 'running', 'completed', 'failed', 'cancelled', 'unknown', 'interrupted'], ATTEMPT_ENDED = new Set(ATTEMPT_STATUSES.slice(3));
const OUTCOMES = ['completed', 'failed', 'cancelled', 'uncertain', 'not_started'];
const JOB_ID = /^job_[0-9a-f]{20}$/, ATTEMPT_ID = /^att_[0-9a-f]{20}$/, AGENT_ID = /^agt_[0-9a-f]{20}$/, NETWORK_ID = /^net_[0-9a-f]{20}$/;
/** A pipeline run and one step of its compiled plan (a sub-pipeline step is namespaced `<subnode>/<step>`, at most 4 deep). */
export const RUN_ID = /^run_[0-9a-f]{20}$/, PLAN_NODE_ID = /^n_[0-9a-f]{12}(?:\/n_[0-9a-f]{12}){0,4}$/;
const EXTERNAL_ID = /^[A-Za-z0-9_-]{1,100}$/, CODE = /^[A-Z][A-Z0-9_]{1,59}$/, KEY = /^[^\u0000-\u001f\u007f]{1,200}$/, SHA = /^[0-9a-f]{64}$/;
const OWNER = Object.freeze({ kind: 'owner', id: null });
const SOURCE = { owner: 'owner', machine: 'machine', pipeline: 'pipeline', job: 'delegation', schedule: 'schedule', a2a: 'a2a' };
const NO_WORKER = 'No job worker is available in this version of Promptboard, so this job stays queued and nothing runs.';
const ACTIVITY = ['turn', 'tool', 'web', 'mcp', 'text', 'status'], COUNTS = ['inputTokens', 'outputTokens', 'cachedTokens'];

/**
 * The Base resolution manifest of a job (architecture §7.2 step 2, R2): the registration's own layer only, resolved as a
 * strict read-only stage, so Base MCP servers, command recipes and native subagents are not delivered (a required one is
 * an error, an optional one is listed as omitted). `base` is Base's list(): { revision, resources, approvedRoots }.
 */
export const jobManifest = (base, { registrationId, baseResourceId, provider }) =>
  resolveBase({ state: { base }, columnId: 'planning', provider, layers: [[`network:agent:${registrationId}`, null, baseResourceId]] });

const time = value => Number.isSafeInteger(value) && value >= 0;
const nullable = check => value => value === null || check(value);
const bytes = text => Buffer.byteLength(text);
const clip = text => cleanText(text).slice(0, LIMITS.reason);
const tooBig = (label, max) => fail(`${label} holds at most ${max / KIB} KiB.`, 'NETWORK_LIMIT', 413);
const current = job => job?.attempts.find(attempt => attempt.id === job.currentAttemptId) || null;
const withAttempt = (job, id, changes) => ({ ...job, attempts: job.attempts.map(attempt => (attempt.id === id ? { ...attempt, ...changes } : attempt)) });
const exists = path => access(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const later = (work, ms) => { const timer = setTimeout(work, ms); timer.unref?.(); return timer; };

/** A stored job is used only when it has what this module writes; anything else counts as damaged (set aside, backup used). */
const storedAttempt = item => object(item) && ATTEMPT_ID.test(item.id) && Number.isSafeInteger(item.number) && ATTEMPT_STATUSES.includes(item.status) && time(item.claimedAt)
  && [item.launchingAt, item.spawnedAt, item.endedAt].every(nullable(time)) && nullable(value => Number.isSafeInteger(value) && value > 0)(item.pid);
const storedJob = job => JOB_ID.test(job.id) && Number.isSafeInteger(job.revision) && JOB_STATUSES.includes(job.status) && AGENT_ID.test(job.agentId) && SHA.test(job.requestSha256)
  && SHA.test(job.submissionSha256) && object(job.requester) && time(job.createdAt) && nullable(time)(job.queuedAt) && nullable(value => OUTCOMES.includes(value))(job.outcome)
  && Array.isArray(job.attempts) && job.attempts.every(storedAttempt) && (job.currentAttemptId === null || job.attempts.some(item => item.id === job.currentAttemptId))
  && Array.isArray(job.history) && nullable(id => typeof id === 'string' && JOB_ID.test(id))(job.parentJobId) && nullable(key => typeof key === 'string' && KEY.test(key))(job.idempotencyKey);
const storedSettings = data => Number.isSafeInteger(data.revision) && Object.entries(SETTING_RANGES).every(([key, [min, max]]) => Number.isSafeInteger(data[key]) && data[key] >= min && data[key] <= max);

/**
 * The caller's job, checked and cleaned (owner text as memory is: secrets masked, local folders cut). `timeoutMs` stays
 * null when not given, so the hash that recognises a repeated submission does not depend on the current settings.
 */
function submission(input) {
  only(input, ['agentId', 'input', 'instructions', 'tools', 'permissions', 'limits', 'requireApproval', 'projectId', 'networkId', 'parentJobId', 'idempotencyKey', 'pipeline'], 'a job');
  const { agentId, instructions = '', tools = 'none', requireApproval = false, projectId = null, networkId = null, parentJobId = null, idempotencyKey = null } = input;
  if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) fail('Choose an agent registered in Network.');
  only(input.input, ['text', 'json'], 'the job input');
  const { text: raw, json: rawJson } = input.input;
  if (typeof raw !== 'string') fail('Write the job input as text.');
  if (bytes(raw) > LIMITS.inputBytes) tooBig('The job input', LIMITS.inputBytes);
  const text = cleanText(raw);
  if (!text) fail('Write the job input.');
  let json;
  if (rawJson !== undefined) {
    if (!object(rawJson) && !Array.isArray(rawJson)) fail('The job input json is an object or a list.');
    const serialized = JSON.stringify(rawJson);
    if (bytes(serialized) > LIMITS.jsonBytes) tooBig('The job input json', LIMITS.jsonBytes);
    json = JSON.parse(serialized, (key, value) => (typeof value === 'string' ? cleanText(value) : value));
  }
  if (typeof instructions !== 'string') fail('Write the instructions as text.');
  if (bytes(instructions) > LIMITS.instructionsBytes) tooBig('The instructions', LIMITS.instructionsBytes);
  if (!['none', 'web'].includes(tools)) fail('Tools are none or web.');
  const permissions = input.permissions ?? {};
  only(permissions, ['filesystem', 'memory', 'projectLessons'], 'the job permissions');
  const { filesystem = 'read_only', memory = 'agent', projectLessons = false } = permissions;
  if (filesystem !== 'read_only') fail('Network jobs only read in this version: they cannot write files. Use a Kanban card for code changes.', 'EXECUTION_POLICY_UNSUPPORTED');
  if (!MEMORY_MODES.includes(memory)) fail(`Memory is ${MEMORY_MODES.join(', ')}.`);
  if (typeof projectLessons !== 'boolean') fail('projectLessons is true or false.');
  const limits = input.limits ?? {};
  only(limits, ['timeoutMs'], 'the job limits');
  const timeoutMs = limits.timeoutMs ?? null;
  if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs < LIMITS.minTimeoutMs || timeoutMs > LIMITS.maxTimeoutMs)) fail('Choose a time limit from 1 second to 120 minutes (timeoutMs).');
  if (typeof requireApproval !== 'boolean') fail('requireApproval is true or false.');
  if (projectId !== null && (typeof projectId !== 'string' || !EXTERNAL_ID.test(projectId))) fail('Choose a project from this board.');
  if (networkId !== null && (typeof networkId !== 'string' || !NETWORK_ID.test(networkId))) fail('Choose a saved network.');
  if (parentJobId !== null && (typeof parentJobId !== 'string' || !JOB_ID.test(parentJobId))) fail('The parent is a job ID.');
  if (idempotencyKey !== null && (typeof idempotencyKey !== 'string' || !KEY.test(idempotencyKey) || LINE_BREAK.test(idempotencyKey))) fail(`The idempotency key is 1 to ${LIMITS.idempotencyKey} printable characters.`);
  if (memory === 'agent+network' && !networkId) fail('Network memory needs the network the job runs in (networkId).');
  if (projectLessons && !projectId) fail('Project lessons need the project (projectId).');
  // The pipeline link (architecture §17 item 4): only present when given, so earlier submissions keep their hash.
  const pipeline = input.pipeline ?? null;
  if (pipeline !== null) {
    only(pipeline, ['runId', 'nodeId'], 'the pipeline link');
    if (typeof pipeline.runId !== 'string' || !RUN_ID.test(pipeline.runId) || typeof pipeline.nodeId !== 'string' || !PLAN_NODE_ID.test(pipeline.nodeId)) fail('The pipeline link names a run and one of its steps.');
  }
  return { agentId, input: { text, ...(json !== undefined ? { json } : {}) }, instructions: cleanText(instructions), tools, permissions: { filesystem, memory, projectLessons },
    timeoutMs, requireApproval, projectId, networkId, parentJobId, idempotencyKey, ...(pipeline ? { pipeline: { runId: pipeline.runId, nodeId: pipeline.nodeId } } : {}) };
}

/** What a worker reports at the end of an attempt. A malformed report is refused (400) and changes nothing. */
function report(input) {
  only(input, ['status', 'errorCode', 'reason', 'exitCode', 'result', 'sideEffects', 'coverage', 'usage', 'nativeSessionId'], 'a worker report');
  const { status, errorCode = null, reason = '', exitCode = null, result, sideEffects, coverage, usage, nativeSessionId = null } = input;
  if (!['completed', 'failed', 'unknown', 'waiting_for_input'].includes(status)) fail('A worker reports completed, failed, unknown or waiting_for_input.');
  if (errorCode !== null && (typeof errorCode !== 'string' || !CODE.test(errorCode))) fail('An error code is upper-case letters, digits and _.');
  if (typeof reason !== 'string' || (exitCode !== null && !Number.isSafeInteger(exitCode))) fail('Send the reason as text and the exit code as a whole number.');
  if (sideEffects !== undefined && !['none', 'read_only_web', 'external_unknown'].includes(sideEffects)) fail('sideEffects is none, read_only_web or external_unknown.');
  if (coverage !== undefined && !['tools', 'partial-tools', 'final-only'].includes(coverage)) fail('coverage is tools, partial-tools or final-only.');
  // Usage holds only numbers the CLI reported (architecture §17 item 3); the native session ID is one line for reference.
  if (usage !== undefined) {
    only(usage, ['reported', ...COUNTS, 'costUsd'], 'usage');
    if (typeof usage.reported !== 'boolean' || (!usage.reported && Object.keys(usage).length > 1) || COUNTS.some(key => usage[key] !== undefined && !(Number.isSafeInteger(usage[key]) && usage[key] >= 0))
      || (usage.costUsd !== undefined && !(Number.isFinite(usage.costUsd) && usage.costUsd >= 0))) fail('Usage is { reported } with the counts and cost the CLI reported.');
  }
  if (nativeSessionId !== null && (typeof nativeSessionId !== 'string' || !KEY.test(nativeSessionId) || LINE_BREAK.test(nativeSessionId))) fail('A native session ID is one line of at most 200 characters.');
  if (result !== undefined) {
    only(result, ['text', 'json'], 'a job result');
    if (typeof result.text !== 'string' || (result.json !== undefined && !object(result.json) && !Array.isArray(result.json))) fail('A result is text with an optional json object.');
  }
  return { status, errorCode, reason: clip(reason), exitCode, result, ...(sideEffects ? { sideEffects } : {}), ...(coverage ? { coverage } : {}), ...(usage ? { usage } : {}), ...(nativeSessionId ? { nativeSessionId } : {}) };
}

export class NetworkJobs {
  /**
   * `registry` is the NetworkRegistry (registrations, networks, Base and the board's project IDs are read through it);
   * `worker` the injected worker or null; `authBusy()` whether a sign-in change holds the CLI slot (jobs then wait).
   * Attempts are not in the server's shared task list (a Compose cancel waits for that list): close() stops them.
   * `events` (optional, the NetworkEvents journal) hears one job.status event after every saved status change.
   */
  constructor({ dataDir, registry, worker = null, authBusy = () => false, now = Date.now, prepareTimeoutMs = LIMITS.prepareTimeoutMs, events = null }) {
    Object.assign(this, { dir: join(dataDir, 'network'), registry, worker, authBusy, now, prepareTimeoutMs, events });
  }
  instance = randomUUID(); // This process: each attempt records it as its workerInstance.
  /** Set by the pipeline runner: `holds(job)` is true while an open run needs the job, so its logs stay and it cannot be deleted. */
  holds = null;
  // ponytail: one queue for every job change; per-job queues if many workers ever contend for it.
  #serial = serial();
  #loading = null;
  #started = false; // The pool claims only after start() (the server calls it once it listens).
  #closing = false;
  #settings = null;
  #jobs = new Map(); // id → job.json as last saved (memory always equals disk: it changes only after a write succeeds).
  #unavailable = new Map(); // id → { code, message } of a job.json that cannot be read.
  #keys = new Map(); // `${requester kind}:${requester id}:${idempotency key}` → jobId.
  #live = new Map(); // attemptId → { jobId, lease, own, controller, request, timer, stopping, endedByEngine } of attempts this process owns.
  #claiming = new Set(); // job IDs the pump is claiming now.
  #lastQueued = 0;
  #retry = null;

  #folder(id) { return join(this.dir, 'jobs', escapeId(id)); }
  #attemptFile(own, name) { return join(this.#folder(own.jobId), 'attempts', escapeId(own.attemptId), name); }
  /** FIFO stamps strictly increase, so jobs queued within one millisecond keep their order, also after a restart. */
  #stamp() { return this.#lastQueued = Math.max(this.now(), this.#lastQueued + 1); }
  #key(requester, key) { return key && `${requester.kind}:${requester.id ?? ''}:${key}`; }

  #ready() { return this.#loading ??= this.#load().catch(error => { this.#loading = null; throw error; }); }
  async #load() {
    this.#settings = await readDocument(join(this.dir, 'settings.json'), { schema: SCHEMA.settings, label: 'The Network job settings', valid: storedSettings })
      ?? { schema: SCHEMA.settings, version: 1, revision: 0, ...JOB_SETTINGS };
    let names = [];
    try { names = await readdir(join(this.dir, 'jobs')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const ids = names.map(name => /^job__([0-9a-f]{20})$/.exec(name)?.[1]).filter(Boolean).map(hex => `job_${hex}`), loaded = [];
    // ponytail: the start scan is O(jobs) (16 at a time); keep a compact index file past ~10,000 jobs (architecture §4.3).
    let next = 0;
    await Promise.all(Array.from({ length: LIMITS.scan }, async () => {
      while (next < ids.length) {
        const id = ids[next++], path = join(this.#folder(id), 'job.json');
        try {
          const job = await readDocument(path, { schema: SCHEMA.job, label: 'A saved Network job', valid: data => data.id === id && storedJob(data) });
          // A damaged job.json is set aside when its backup loads, so a missing file now means the backup was used.
          if (job) loaded.push({ job, restored: !(await exists(path)) });
        } catch (error) { if (!(error instanceof NetworkError)) throw error; this.#unavailable.set(id, { code: error.code, message: error.message }); }
      }
    }));
    for (const { job } of loaded) {
      this.#jobs.set(job.id, job);
      if (job.idempotencyKey) this.#keys.set(this.#key(job.requester, job.idempotencyKey), job.id);
      this.#lastQueued = Math.max(this.#lastQueued, job.queuedAt ?? 0);
    }
    await this.#serial(async () => {
      for (const { job, restored } of loaded) await this.#reconcile(job, restored).catch(() => {}); // A failed save leaves it for the next start.
      await this.#sweep().catch(() => {});
    });
  }
  /**
   * After a restart nothing owns an attempt any more: one that may have started becomes interrupted (uncertain), one that
   * had not, interrupted (not started). A job read from its backup may have moved on since that copy, so it never runs
   * again by itself either. Queued and waiting jobs keep their state.
   */
  async #reconcile(job, restored) {
    if (restored && ['queued', 'waiting_for_approval', 'waiting_for_input', 'preparing', 'running'].includes(job.status)) {
      return this.#save(this.#end(job, 'interrupted', { outcome: 'uncertain', errorCode: 'RESTORED_FROM_BACKUP', reason: 'This job was read from its backup copy, so it may have run after that copy was made. Nothing was started again: retry or close it.' }, 'app'));
    }
    if (job.status === 'preparing' || job.status === 'running') {
      const attempt = current(job), started = Boolean(attempt?.launchingAt);
      const reason = started ? `Promptboard stopped while this job ran. It may have finished its work${attempt.pid ? `, and process ${attempt.pid} may still be running` : ''}. Nothing was started again: retry or close it.` : 'Promptboard stopped before this job started. Nothing ran: retry or close it.';
      return this.#save(this.#end(job, 'interrupted', { errorCode: 'APP_RESTARTED', reason }, 'app'));
    }
  }
  /**
   * Retention (architecture §4.5), once per start: a finished job's large attempt logs (stream.jsonl, output.log) go after
   * outputRetentionDays, at most 500 jobs per start, never while its parent job is still open. Metadata, the request and
   * results stay until the owner deletes the job.
   */
  async #sweep() {
    const cutoff = this.now() - this.#settings.outputRetentionDays * DAY;
    const old = [...this.#jobs.values()].filter(job => TERMINAL.has(job.status) && job.attempts.length && !job.outputsRemovedAt && job.updatedAt <= cutoff
      && !(job.parentJobId && this.#jobs.has(job.parentJobId) && !TERMINAL.has(this.#jobs.get(job.parentJobId).status)) && !this.holds?.(job)).sort((a, b) => a.updatedAt - b.updatedAt);
    for (const job of old.slice(0, LIMITS.sweep)) {
      for (const attempt of job.attempts) for (const name of ['stream.jsonl', 'output.log']) await rm(this.#attemptFile({ jobId: job.id, attemptId: attempt.id }, name), { force: true });
      await this.#save({ ...job, outputsRemovedAt: this.now() });
    }
  }

  /** The job with `status`, checked against the transition table and recorded in its history. */
  #move(job, status, changes = {}, by = 'owner') {
    if (!NEXT[job.status].includes(status)) fail(`A ${job.status.replaceAll('_', ' ')} job cannot become ${status.replaceAll('_', ' ')}.`, 'JOB_STATE', 409);
    return { ...job, ...changes, status, history: [...job.history, { at: this.now(), status, by }].slice(-LIMITS.history) };
  }
  /** The job ended as `status`, its current attempt with it (if one is open); the outcome says whether work may have happened. */
  #end(job, status, { outcome, errorCode = null, reason = '', attempt: changes = {}, result } = {}, by = 'owner') {
    const attempt = current(job), open = attempt && !ATTEMPT_ENDED.has(attempt.status), started = Boolean(attempt?.launchingAt);
    const next = open ? withAttempt(job, attempt.id, { status: status === 'waiting_for_input' ? 'completed' : status, endedAt: this.now(), errorCode, ...changes }) : job;
    outcome ??= status === 'interrupted' ? (started ? 'uncertain' : 'not_started') : ({ completed: 'completed', failed: 'failed', cancelled: 'cancelled', unknown: 'uncertain' })[status] ?? null;
    return this.#move(next, status, { outcome, errorCode, reason, ...(result !== undefined ? { result } : {}) }, by);
  }
  async #save(job) {
    const next = { ...job, revision: job.revision + 1, updatedAt: this.now() }, before = this.#jobs.get(job.id);
    await writeDocument(join(this.#folder(job.id), 'job.json'), next);
    this.#jobs.set(next.id, next);
    if (before?.status !== next.status) this.#emit(next, before?.status ?? null);
    return next;
  }
  /**
   * One job.status event for a saved status change (architecture §17 item 2). Not awaited, and every failure of the sink
   * is swallowed: the journal is observability, so it can never hold up or undo a transition that is already saved.
   */
  #emit(job, from) {
    const attempt = current(job);
    const event = { type: 'job.status', jobId: job.id, attemptId: attempt?.id, agentId: job.agentId, projectId: job.projectId, networkId: job.networkId, pipelineRunId: job.pipelineRunId,
      nodeId: job.nodeId, status: job.status, from, by: job.history.at(-1)?.by, errorCode: job.errorCode, message: job.reason, coverage: attempt?.coverage, artifactRef: job.status === 'completed' ? job.result?.textRef : undefined };
    try { Promise.resolve(this.events?.append(event)).catch(() => {}); } catch {}
  }
  #job(id) {
    if (typeof id !== 'string' || !JOB_ID.test(id)) fail('This job does not exist.', 'NOT_FOUND', 404);
    const unavailable = this.#unavailable.get(id);
    if (unavailable) fail(unavailable.message, unavailable.code, 409);
    const job = this.#jobs.get(id);
    if (!job) fail('This job does not exist.', 'NOT_FOUND', 404);
    return job;
  }
  /** The accepted snapshot, only when its bytes still hash to what job.json recorded. */
  async #request(job) {
    let text;
    try { text = await readFile(join(this.#folder(job.id), 'request.json'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let value; try { value = JSON.parse(text); } catch {}
    if (text === undefined || sha256(text) !== job.requestSha256 || value?.schema !== SCHEMA.request || value.version !== 1 || value.jobId !== job.id) fail('The accepted request of this job is missing or failed its integrity check. Nothing was run.', 'REQUEST_INVALID', 409);
    return value;
  }
  #order() { return [...this.#jobs.values()].filter(job => job.status === 'queued').sort((a, b) => a.queuedAt - b.queuedAt || (a.id < b.id ? -1 : 1)); }
  #positions() { return new Map(this.#order().map((job, index) => [job.id, index + 1])); }
  /** What the owner sees: no schema fields, no lease; whether this process runs it now; what a queued job waits for. */
  #view(job, positions = null) {
    const { schema, version, ...fields } = job, live = job.currentAttemptId ? this.#live.get(job.currentAttemptId) : null;
    let status = null;
    if (live) { try { status = this.worker?.getStatus(live.own) ?? null; } catch {} }
    return { ...fields, live: live ? { process: status?.process ?? 'unknown', ...(status?.coverage ? { coverage: status.coverage } : {}) } : null, lastActivity: live?.lastActivity ?? null, waiting: this.#waiting(job, positions) };
  }
  #waiting(job, positions) {
    if (job.status === 'waiting_for_approval') return { for: 'approval', message: 'Waiting for your approval. Nothing runs until you approve it.' };
    if (job.status === 'interrupted' || job.status === 'unknown') return { for: 'decision', message: job.outcome === 'not_started' ? 'Nothing ran. Retry it or close it.' : 'It may have done its work already. Retry it (confirming that) or close it.' };
    if (job.status !== 'queued') return null;
    const position = (positions || this.#positions()).get(job.id) ?? null;
    if (!this.worker) return { for: 'worker', position, message: NO_WORKER };
    if (this.authBusy()) return { for: 'sign-in', position, message: 'Waiting for the sign-in change to finish.' };
    return { for: 'slot', position, message: `Waiting for one of ${this.#settings.maxConcurrentJobs} job slots.` };
  }

  /** Read the registration and Base now and pin them into the request; a job that could never run is refused here. */
  async #pin(spec) {
    let view;
    try { ({ agent: view } = await this.registry.agent(spec.agentId)); }
    catch (error) { if (error.code === 'NOT_FOUND') fail('This agent is not registered in Network. Nothing was submitted.', 'AGENT_NOT_FOUND', 409); throw error; }
    if (!view.enabled) fail('This agent is switched off in Network. Switch it on in its profile first. Nothing was submitted.', 'REGISTRATION_DISABLED', 409);
    if (view.base.stale) fail(`This agent’s Base definition cannot be used (${view.base.staleReason}). Fix it in Base first. Nothing was submitted.`, 'REGISTRATION_STALE', 409, { staleReason: view.base.staleReason });
    const tools = view.providerCapabilities.jobTools;
    if (!tools?.length) fail('Network jobs cannot run this agent’s provider. Choose an agent that runs Claude Code, Codex or Gemini. Nothing was submitted.', 'PROVIDER_UNSUPPORTED', 409);
    if (!tools.includes(spec.tools)) fail(`This agent’s provider cannot use ${spec.tools} tools in a Network job. Nothing was submitted.`, 'TOOLS_UNSUPPORTED', 409);
    if (spec.projectId) {
      if (!(await this.registry.projects()).includes(spec.projectId)) fail('Choose a project from this board. Nothing was submitted.', 'PROJECT_NOT_FOUND', 409);
      if (spec.permissions.projectLessons && !view.projectAllowlist.includes(spec.projectId)) fail('This agent may not read that project’s lessons: add the project to its projects first. Nothing was submitted.', 'PROJECT_NOT_ALLOWED', 409);
    }
    if (spec.networkId) await this.registry.network(spec.networkId).catch(error => { if (error.code === 'NOT_FOUND') fail('Choose a saved network. Nothing was submitted.', 'NETWORK_NOT_FOUND', 409); throw error; });
    if (spec.parentJobId && !this.#jobs.has(spec.parentJobId)) fail('The parent job does not exist. Nothing was submitted.', 'JOB_NOT_FOUND', 409);
    const listed = await this.registry.base.list(), resources = new Map(listed.resources.map(resource => [resource.id, resource]));
    const resource = resources.get(view.baseResourceId), primary = resource?.kind === 'agentProfile' ? primaryAgent(resources, resource) : null;
    if (resource?.revision !== view.base.revision) fail('The Base agent changed while the job was submitted. Try again.', 'BASE_CHANGED', 409);
    // Pinned now with the revision references of everything it delivers; the worker supplies exactly these revisions.
    const manifest = jobManifest(listed, { registrationId: view.id, baseResourceId: view.baseResourceId, provider: view.base.provider });
    if (manifest.errors.length) {
      const names = [...new Set(manifest.errors.map(error => oneLine(manifest.resources.find(entry => entry.resourceId === error.resourceId)?.name || error.resourceId).slice(0, 80)))];
      fail(`This agent needs Base resources a Network job cannot be given: ${names.map(name => `“${name}”`).join(', ')}. Network jobs only read: Base MCP servers, command recipes and supporting agents are not supplied. Make them optional for this agent in Base, or run the work on a Kanban card. Nothing was submitted.`,
        'BASE_REQUIRED_UNAVAILABLE', 409, { errors: manifest.errors.map(({ resourceId = null, code }) => ({ resourceId, code })) });
    }
    return { registrationId: view.id, registrationRevision: view.revision, baseResourceId: view.baseResourceId, baseKind: resource.kind, baseRevisionRef: resource.revisionRef ?? null,
      primaryAgent: primary ? { resourceId: primary.id, revisionRef: primary.revisionRef ?? null } : null, provider: view.base.provider, model: view.base.model, effort: view.base.effort, manifest };
  }

  /**
   * Accept a job: request.json, then job.json, then the answer `{ jobId, status }` — queued, or waiting_for_approval with
   * `requireApproval`; never completed. The same idempotency key from the same requester answers the existing job
   * (`deduplicated: true`), or `IDEMPOTENCY_CONFLICT` when the submission differs; keys of other requesters never match.
   */
  async submit(input, { requester = OWNER } = {}) {
    if (!object(requester) || !Object.hasOwn(SOURCE, requester.kind)) fail('Unknown requester.');
    const spec = submission(input), submissionSha256 = sha256(JSON.stringify({ ...spec, idempotencyKey: undefined }));
    if (spec.pipeline && (requester.kind !== 'pipeline' || requester.id !== spec.pipeline.runId)) fail('Only the pipeline runner links a job to its run. Nothing was submitted.', 'PIPELINE_LINK_REFUSED', 403);
    await this.#ready();
    return this.#serial(async () => {
      const key = this.#key(requester, spec.idempotencyKey), existing = key ? this.#jobs.get(this.#keys.get(key)) : null;
      if (existing) {
        if (existing.submissionSha256 !== submissionSha256) fail('This idempotency key was already used for a different job. Nothing was submitted.', 'IDEMPOTENCY_CONFLICT', 409, { jobId: existing.id });
        return { jobId: existing.id, status: existing.status, deduplicated: true, job: this.#view(existing) };
      }
      if (this.#closing) fail('The app is shutting down. Nothing was submitted.', 'SHUTTING_DOWN', 503);
      const agent = await this.#pin(spec), id = newId('job'), at = this.now(), status = spec.requireApproval ? 'waiting_for_approval' : 'queued';
      const request = { schema: SCHEMA.request, version: 1, jobId: id, acceptedAt: at, input: spec.input, instructions: spec.instructions, tools: spec.tools, permissions: spec.permissions,
        limits: { timeoutMs: spec.timeoutMs ?? this.#settings.defaultTimeoutMs, maxOutputBytes: LIMITS.resultBytes }, requireApproval: spec.requireApproval,
        projectId: spec.projectId, networkId: spec.networkId, parentJobId: spec.parentJobId, ...(spec.pipeline ? { pipeline: spec.pipeline } : {}), agent };
      const text = `${JSON.stringify(request)}\n`;
      const job = { schema: SCHEMA.job, version: 1, id, revision: 1, status, source: SOURCE[requester.kind], requester: { kind: requester.kind, id: requester.id ?? null },
        agentId: spec.agentId, projectId: spec.projectId, networkId: spec.networkId, pipelineRunId: spec.pipeline?.runId ?? null, nodeId: spec.pipeline?.nodeId ?? null, parentJobId: spec.parentJobId,
        idempotencyKey: spec.idempotencyKey, submissionSha256, requestSha256: sha256(text), createdAt: at, updatedAt: at, acceptedAt: at, queuedAt: status === 'queued' ? this.#stamp() : null,
        attempts: [], currentAttemptId: null, outcome: null, errorCode: null, reason: '', result: null, history: [{ at, status, by: requester.kind }], outputsRemovedAt: null };
      try { await writeImmutable(join(this.#folder(id), 'request.json'), text, 'The job'); await writeDocument(join(this.#folder(id), 'job.json'), job); }
      catch (error) { await rm(this.#folder(id), { recursive: true, force: true }).catch(() => {}); throw error; } // Nothing half-made stays.
      this.#jobs.set(id, job);
      this.#emit(job, null);
      if (key) this.#keys.set(key, id);
      this.#pump();
      return { jobId: id, status, deduplicated: false, job: this.#view(job) };
    });
  }

  async list({ status, agentId, projectId, networkId, parentJobId, pipelineRunId, offset, limit } = {}) {
    if (status !== undefined && !JOB_STATUSES.includes(status)) fail(`Filter the status by ${JOB_STATUSES.join(', ')}.`);
    for (const [value, pattern] of [[agentId, AGENT_ID], [projectId, EXTERNAL_ID], [networkId, NETWORK_ID], [parentJobId, JOB_ID], [pipelineRunId, RUN_ID]]) if (value !== undefined && !pattern.test(value)) fail('Filter by valid IDs.');
    await this.#ready();
    const items = [...this.#jobs.values()].filter(job => (!status || job.status === status) && (!agentId || job.agentId === agentId) && (!projectId || job.projectId === projectId)
      && (!networkId || job.networkId === networkId) && (!parentJobId || job.parentJobId === parentJobId) && (!pipelineRunId || job.pipelineRunId === pipelineRunId)).sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
    const result = page(items, offset, limit, 'jobs'), positions = this.#positions();
    return { ...result, jobs: result.jobs.map(job => this.#view(job, positions)), worker: Boolean(this.worker), unavailable: [...this.#unavailable].map(([id, { code }]) => ({ id, code })) };
  }
  /** A completed job's result: its text (and json), read back only when the bytes still hash to what job.json recorded. */
  async result(id) {
    await this.#ready();
    const job = this.#job(id);
    if (!job.result) fail('This job has no result.', 'NOT_FOUND', 404);
    const read = ref => readFile(join(this.#folder(id), ...ref.split('/')), 'utf8').catch(() => fail('The result of this job cannot be read from the data folder.', 'NETWORK_CONTENT_UNAVAILABLE', 409));
    const text = await read(job.result.textRef);
    if (sha256(text) !== job.result.sha256) fail('The result of this job failed its integrity check. It was left unchanged.', 'NETWORK_CONTENT_INVALID', 409);
    let json = null;
    if (job.result.jsonRef) try { json = JSON.parse(await read(job.result.jsonRef)); } catch (error) { if (error instanceof NetworkError) throw error; }
    return { jobId: id, attemptId: job.currentAttemptId, text, json, chars: job.result.chars };
  }
  /** One job with its accepted request (null with `requestError` when that file fails its check) and its child jobs. */
  async read(id) {
    await this.#ready();
    const job = this.#job(id);
    let request = null, requestError = null;
    try { request = await this.#request(job); } catch (error) { if (!(error instanceof NetworkError)) throw error; requestError = error.code; }
    return { job: this.#view(job), request, ...(requestError ? { requestError } : {}), children: [...this.#jobs.values()].filter(other => other.parentJobId === id).map(other => other.id) };
  }

  /**
   * Claim one queued job for this process: the claim-time checks (registration on and usable, project still there, request
   * intact; a job that fails them fails without a process), then the attempt with a new ID and the `preparing` status are
   * saved before anything else happens. Answers the ownership (lease in memory only) or null when the job was not queued.
   */
  async claim(jobId) {
    await this.#ready();
    return this.#serial(async () => {
      const job = this.#jobs.get(jobId);
      if (!job || job.status !== 'queued' || this.#closing) return null;
      let request;
      try {
        request = await this.#request(job);
        let view;
        try { ({ agent: view } = await this.registry.agent(job.agentId)); } catch (error) { if (error.code === 'NOT_FOUND') fail('The agent registration no longer exists. Nothing ran.', 'REGISTRATION_MISSING', 409); throw error; }
        if (!view.enabled) fail('The agent was switched off in Network before the job started. Nothing ran.', 'REGISTRATION_DISABLED', 409);
        if (view.base.stale) fail(`The agent’s Base definition can no longer be used (${view.base.staleReason}). Nothing ran.`, 'BASE_REVOKED', 409);
        if (job.projectId && !(await this.registry.projects()).includes(job.projectId)) fail('The job’s project is no longer on the board. Nothing ran.', 'PROJECT_NOT_FOUND', 409);
      } catch (error) {
        if (!(error instanceof NetworkError) || error.code === 'NETWORK_DATA_DAMAGED') throw error; // Unreadable data: the job waits, it is not failed.
        await this.#save(this.#move(job, 'failed', { outcome: 'failed', errorCode: error.code, reason: error.message }, 'app'));
        return null;
      }
      const attempt = { id: newId('att'), number: job.attempts.length + 1, status: 'claimed', workerInstance: this.instance, claimedAt: this.now(), launchingAt: null, spawnedAt: null,
        endedAt: null, pid: null, provider: request.agent.provider, model: request.agent.model, effort: request.agent.effort, nativeSessionId: null, exitCode: null, errorCode: null,
        coverage: null, sideEffects: request.tools === 'web' ? 'read_only_web' : 'none', usage: { reported: false }, lateResult: null };
      await this.#save(this.#move({ ...job, attempts: [...job.attempts, attempt] }, 'preparing', { currentAttemptId: attempt.id, outcome: null, errorCode: null, reason: '' }, 'app'));
      const controller = new AbortController(), own = { jobId, attemptId: attempt.id, lease: randomBytes(32).toString('base64url'), signal: controller.signal };
      Object.assign(own, { launching: () => this.launching(own), spawned: details => this.spawned(own, details), activity: item => this.activity(own, item), finish: outcome => this.finish(own, outcome) });
      const live = { jobId, lease: own.lease, own, controller, request, timer: null, stopping: null, endedByEngine: false, lastActivity: null };
      live.timer = later(() => this.#stop(live, 'failed', { errorCode: 'PREPARE_TIMEOUT', reason: `The job did not start within ${Math.round(this.prepareTimeoutMs / 1000)} seconds.` }).catch(() => {}), this.prepareTimeoutMs);
      this.#live.set(attempt.id, live);
      return own;
    });
  }
  /** The live attempt `own` holds, or JOB_OWNERSHIP_LOST: a stale, forged or ended ownership changes nothing. */
  #owned(own) {
    const live = this.#live.get(own?.attemptId), job = this.#jobs.get(own?.jobId), attempt = current(job);
    if (!live || live.lease !== own.lease || live.jobId !== own.jobId || attempt?.id !== own.attemptId || ATTEMPT_ENDED.has(attempt.status)) fail('This attempt no longer owns the job. Nothing was changed.', 'JOB_OWNERSHIP_LOST', 409);
    return { live, job, attempt };
  }
  /** Saved before the worker starts a process; the worker must not start one when this throws. */
  async launching(own) {
    return this.#serial(async () => {
      const { live, job, attempt } = this.#owned(own);
      if (live.stopping || attempt.status !== 'claimed') fail('This attempt can no longer start. Nothing was changed.', 'JOB_OWNERSHIP_LOST', 409);
      const saved = await this.#save(withAttempt(job, attempt.id, { status: 'launching', launchingAt: this.now() }));
      clearTimeout(live.timer);
      const limit = live.request.limits.timeoutMs;
      live.timer = later(() => this.#stop(live, 'failed', { errorCode: 'TIMEOUT', reason: `The job ran longer than its ${limit >= MINUTE ? `${Math.round(limit / MINUTE)}-minute` : `${Math.round(limit / 1000)}-second`} limit and was stopped.` }).catch(() => {}), limit);
      return { applied: true, job: this.#view(saved) };
    });
  }
  /** The process is running. When this cannot be saved the process is stopped (it would run off the record). */
  async spawned(own, { pid = null } = {}) {
    if (pid !== null && (!Number.isSafeInteger(pid) || pid < 1)) fail('A process ID is a positive whole number.');
    try {
      return await this.#serial(async () => {
        const { job, attempt } = this.#owned(own);
        if (attempt.status !== 'launching') fail('Report launching before the process starts.', 'JOB_STATE', 409);
        return { applied: true, job: this.#view(await this.#save(this.#move(withAttempt(job, attempt.id, { status: 'running', spawnedAt: this.now(), pid }), 'running', {}, 'worker'))) };
      });
    } catch (error) {
      if (error.code === 'NETWORK_WRITE_FAILED') await Promise.resolve().then(() => this.worker?.cancel(own)).catch(() => {});
      throw error;
    }
  }
  /**
   * What an attempt this process owns is doing now (architecture §17 item 3): `{ kind, label }`, the label one line of at most
   * 160 characters, cleaned like owner text. Kept in memory only, as the job view's `lastActivity` (job.json is not written),
   * and passed to the event journal when there is one.
   */
  activity(own, item) {
    const { live, job } = this.#owned(own);
    only(item, ['kind', 'label'], 'an activity');
    if (!ACTIVITY.includes(item.kind) || typeof item.label !== 'string') fail(`Activity is { kind: ${ACTIVITY.join(' | ')}, label }.`);
    const label = oneLine(item.label).slice(0, 160);
    live.lastActivity = { at: this.now(), kind: item.kind, label };
    let coverage; try { coverage = this.worker?.getStatus(own)?.coverage; } catch {}
    const event = { type: 'job.activity', jobId: job.id, attemptId: own.attemptId, agentId: job.agentId, projectId: job.projectId, networkId: job.networkId, status: job.status, ...(coverage ? { coverage } : {}), message: label };
    Promise.resolve().then(() => this.events?.append(event)).catch(() => {}); // The journal never holds the attempt up.
    return { applied: true };
  }
  /**
   * The worker's end of an attempt. Applied only while `own` holds the current attempt: then `completed` needs a running
   * attempt and result text (written to result.md first), `unknown` needs a launched one, and anything less becomes
   * unknown (it may have run) or failed (it did not). A report after the engine ended the attempt (cancel, timeout,
   * shutdown) changes no status; its result is kept as late-result.md. Every other report is ignored.
   */
  async finish(own, outcome) {
    const end = report(outcome);
    return this.#serial(async () => {
      const live = this.#live.get(own?.attemptId);
      if (!live || live.lease !== own.lease || live.jobId !== own.jobId) return { applied: false, reason: 'JOB_OWNERSHIP_LOST' };
      let job = this.#jobs.get(own.jobId);
      const attempt = job.attempts.find(item => item.id === own.attemptId);
      if (job.currentAttemptId !== own.attemptId || ATTEMPT_ENDED.has(attempt.status)) {
        if (!live.endedByEngine || !end.result?.text || bytes(end.result.text) > LIMITS.resultBytes) return { applied: false, reason: 'ALREADY_ENDED' };
        await writeImmutable(this.#attemptFile(own, 'late-result.md'), end.result.text, 'The late result');
        job = await this.#save(withAttempt(job, attempt.id, { lateResult: { chars: end.result.text.length, sha256: sha256(end.result.text), at: this.now() } }));
        return { applied: false, reason: 'ALREADY_ENDED', lateResult: true, job: this.#view(job) };
      }
      let { status, errorCode, reason } = end;
      const started = Boolean(attempt.launchingAt), running = attempt.status === 'running', json = end.result?.json === undefined ? undefined : JSON.stringify(end.result.json);
      if (end.result && (bytes(end.result.text) > LIMITS.resultBytes || (json && bytes(json) > LIMITS.jsonBytes))) [status, errorCode, reason] = ['failed', 'OUTPUT_LIMIT', 'The result was larger than the 1 MiB limit (64 KiB for its json) and was not kept.'];
      if ((status === 'completed' && (!running || !end.result?.text.trim())) || (status === 'waiting_for_input' && !running)) [status, errorCode] = [started ? 'unknown' : 'failed', errorCode || 'NO_RESULT'];
      if (status === 'unknown' && !started) status = 'failed';
      let result;
      if (status === 'completed') {
        const folder = `attempts/${escapeId(attempt.id)}`;
        await writeImmutable(this.#attemptFile(own, 'result.md'), end.result.text, 'The job result');
        if (json) await writeImmutable(this.#attemptFile(own, 'result.json'), json, 'The job result');
        result = { textRef: `${folder}/result.md`, ...(json ? { jsonRef: `${folder}/result.json` } : {}), chars: end.result.text.length, sha256: sha256(end.result.text) };
      }
      const changes = { exitCode: end.exitCode, ...(end.sideEffects ? { sideEffects: end.sideEffects } : {}), ...(end.coverage ? { coverage: end.coverage } : {}), ...(end.usage ? { usage: end.usage } : {}),
        ...(end.nativeSessionId ? { nativeSessionId: end.nativeSessionId } : {}) };
      const saved = await this.#save(this.#end(job, status, { errorCode, reason, attempt: changes, result }, 'worker'));
      clearTimeout(live.timer);
      return { applied: true, job: this.#view(saved) };
    });
  }
  /**
   * End an attempt this process owns (cancel, timeout, shutdown): stop the worker (bounded to 3 s), then save `status`
   * unless the worker's own report was saved first. One stop per attempt; a failed save can be tried again.
   */
  #stop(live, status, details) {
    return live.stopping ??= (async () => {
      clearTimeout(live.timer);
      live.controller.abort();
      let timer;
      await Promise.race([Promise.resolve().then(() => this.worker?.cancel(live.own)).catch(() => {}), new Promise(resolve => { timer = later(resolve, LIMITS.stopMs); })]);
      clearTimeout(timer);
      try {
        return await this.#serial(async () => {
          const job = this.#jobs.get(live.jobId), attempt = current(job);
          if (attempt?.id !== live.own.attemptId || ATTEMPT_ENDED.has(attempt.status)) return job;
          const saved = await this.#save(this.#end(job, status, details, status === 'cancelled' ? 'owner' : 'app'));
          live.endedByEngine = true;
          later(() => this.#release(live), LIMITS.stopMs); // A worker that never returns still frees its slot.
          return saved;
        });
      } catch (error) { live.stopping = null; throw error; }
    })();
  }
  #release(live) { clearTimeout(live.timer); if (this.#live.get(live.own.attemptId) === live) this.#live.delete(live.own.attemptId); this.#pump(); }
  /** A worker that returned without a terminal report never counts as success: unknown when it may have started, failed when not. */
  async #settle(live, error) {
    await this.#serial(async () => {
      const job = this.#jobs.get(live.jobId), attempt = current(job);
      if (live.stopping || attempt?.id !== live.own.attemptId || ATTEMPT_ENDED.has(attempt.status)) return;
      const code = CODE.test(error?.code ?? '') ? error.code : null;
      if (attempt.launchingAt) await this.#save(this.#end(job, 'unknown', { errorCode: code || 'NO_RESULT', reason: 'The worker ended without a result after the job started, so what it did is not known. Retry or close it.' }, 'app'));
      else await this.#save(this.#end(job, 'failed', { errorCode: code || 'WORKER_ENDED', reason: error?.message ? clip(error.message) : 'The worker ended before the job started. Nothing ran.' }, 'app'));
    }).catch(() => {}); // Unsaved: the job keeps its last saved state, and the next start reconciles it.
  }
  /** One attempt: claim, hand it to the worker, settle what the worker left open, free the slot. */
  async #run(jobId) {
    let own;
    try { own = await this.claim(jobId); }
    catch { this.#retry ??= later(() => { this.#retry = null; this.#pump(); }, LIMITS.retryMs); return; } // Storage failed: the job stays queued.
    finally { this.#claiming.delete(jobId); }
    if (!own) return this.#pump();
    const live = this.#live.get(own.attemptId), job = { ...this.#view(this.#jobs.get(jobId)), request: structuredClone(live.request) };
    let error = null;
    try {
      await this.worker.claim(job, own);
      if (!own.signal.aborted) await this.worker.start(job, own);
    } catch (caught) { error = caught; }
    await this.#settle(live, error);
    this.#release(live);
  }
  #pump() {
    if (!this.worker || !this.#started || this.#closing || this.authBusy()) return;
    for (const job of this.#order()) {
      if (this.activeCount() >= this.#settings.maxConcurrentJobs) break;
      if (this.#claiming.has(job.id)) continue;
      this.#claiming.add(job.id);
      this.#run(job.id).catch(() => {}); // #run settles every failure itself; nothing may go unhandled.
    }
  }

  /** Attempts this process is claiming or owns (a process may be alive): sign-in changes wait for these (architecture R3). */
  activeCount() { return this.#claiming.size + this.#live.size; }
  /** Called when a sign-in change ends: queued jobs may start. */
  wake() { this.#pump(); }
  /** Begin after the server listens: load, reconcile, sweep, then start queued jobs when a worker exists. */
  async start() { await this.#ready(); this.#started = true; this.#pump(); }
  /** Shutdown: claim nothing more, stop owned attempts and save them as interrupted (architecture §7.4). */
  async close() {
    this.#closing = true;
    clearTimeout(this.#retry);
    await this.#loading?.catch(() => {});
    await Promise.allSettled([...this.#live.values()].map(live => this.#stop(live, 'interrupted', { errorCode: 'APP_STOPPED', reason: 'Promptboard stopped while this job ran. Nothing was started again: retry or close it.' })));
  }

  /** Cancel a job that has not ended. A queued or waiting job is cancelled at once; a running attempt is stopped first. */
  async cancel(id, input = {}) {
    only(input, [], 'a cancel request');
    await this.#ready();
    const first = await this.#serial(async () => {
      const job = this.#job(id);
      if (TERMINAL.has(job.status)) fail(`This job already ended as ${job.status}. Nothing was cancelled.`, 'JOB_FINISHED', 409);
      if (!NEXT[job.status].includes('cancelled')) fail('This job needs your decision instead: retry it or close it.', 'JOB_STATE', 409);
      const live = job.currentAttemptId && this.#live.get(job.currentAttemptId);
      return live ? { live } : { job: await this.#save(this.#end(job, 'cancelled', { reason: 'Cancelled by you.' })) };
    });
    const job = first.job ?? await this.#stop(first.live, 'cancelled', { reason: 'Cancelled by you.' });
    return { job: this.#view(job), cancelled: job.status === 'cancelled' };
  }
  /** `decision: 'approve'` queues a job that waits for approval; 'reject' cancels it. Only the owner's routes call this. */
  async approve(id, input) {
    only(input, ['expectedRevision', 'decision'], 'an approval');
    requireRevision(input);
    if (!['approve', 'reject'].includes(input.decision)) fail('Choose approve or reject.');
    await this.#ready();
    return this.#serial(async () => {
      const job = this.#job(id);
      if (job.status !== 'waiting_for_approval') fail('This job is not waiting for approval.', 'JOB_STATE', 409);
      if (input.expectedRevision !== job.revision) conflict('This job');
      const saved = await this.#save(input.decision === 'approve' ? this.#move(job, 'queued', { queuedAt: this.#stamp() }) : this.#end(job, 'cancelled', { reason: 'Rejected by you before it ran.' }));
      this.#pump();
      return { job: this.#view(saved) };
    });
  }
  /**
   * Queue an interrupted or unknown job again as a new attempt: `confirm: true`, and `confirmUncertain: true` when the last
   * attempt may have done its work or could reach outside (external effects are not guaranteed exactly once).
   */
  async retry(id, input) {
    only(input, ['expectedRevision', 'confirm', 'confirmUncertain'], 'a retry');
    requireRevision(input);
    await this.#ready();
    return this.#serial(async () => {
      const job = this.#job(id);
      if (!['interrupted', 'unknown'].includes(job.status)) fail('Only an interrupted or unknown job can be retried.', 'JOB_STATE', 409);
      if (input.expectedRevision !== job.revision) conflict('This job');
      if (input.confirm !== true) fail('Confirm the retry: it runs the job again as a new attempt.', 'CONFIRMATION_REQUIRED');
      const last = job.attempts.at(-1);
      if ((job.outcome === 'uncertain' || (last && last.sideEffects !== 'none')) && input.confirmUncertain !== true) {
        fail('The last attempt may have done its work already. Confirm that running it again is safe (confirmUncertain): external effects are not guaranteed to happen only once.', 'UNCERTAIN_CONFIRMATION_REQUIRED');
      }
      const saved = await this.#save(this.#move(job, 'queued', { queuedAt: this.#stamp(), currentAttemptId: null, outcome: null, errorCode: null, reason: '' }));
      this.#pump();
      return { job: this.#view(saved) };
    });
  }
  /** Close an interrupted or unknown job as failed without running it again; the outcome (uncertain or not started) stays. */
  async closeJob(id, input) {
    only(input, ['expectedRevision'], 'a close request');
    requireRevision(input);
    await this.#ready();
    return this.#serial(async () => {
      const job = this.#job(id);
      if (!['interrupted', 'unknown'].includes(job.status)) fail('Only an interrupted or unknown job can be closed.', 'JOB_STATE', 409);
      if (input.expectedRevision !== job.revision) conflict('This job');
      return { job: this.#view(await this.#save(this.#move(job, 'failed', { errorCode: 'CLOSED_BY_OWNER', reason: 'Closed by you without running it again.' }))) };
    });
  }
  /** Delete a finished job and its files, unless an open job names it as its parent or its process is still stopping. */
  async remove(id, input) {
    only(input, ['expectedRevision'], 'a delete request');
    requireRevision(input);
    await this.#ready();
    return this.#serial(async () => {
      const job = this.#job(id);
      if (!TERMINAL.has(job.status)) fail('Only a finished job can be deleted. Cancel it first.', 'JOB_STATE', 409);
      if (input.expectedRevision !== job.revision) conflict('This job');
      if (job.currentAttemptId && this.#live.has(job.currentAttemptId)) fail('This job is still stopping. Try again in a few seconds.', 'JOB_BUSY', 409);
      const users = [...this.#jobs.values()].filter(other => other.parentJobId === id && !TERMINAL.has(other.status)).map(other => other.id);
      if (users.length) fail('Open jobs name this job as their parent. Nothing was deleted.', 'JOB_IN_USE', 409, { jobIds: users });
      if (this.holds?.(job)) fail('A pipeline run that is still open uses this job’s result. Nothing was deleted.', 'JOB_IN_USE', 409, { pipelineRunId: job.pipelineRunId });
      const folder = this.#folder(id), gone = `${folder}.deleted-${this.now()}-${randomBytes(4).toString('hex')}`;
      try { await rename(folder, gone); } catch { fail('The job could not be deleted. Check folder permissions and try again.', 'NETWORK_WRITE_FAILED', 500); }
      await rm(gone, { recursive: true, force: true }).catch(() => {}); // Renamed first, so the job is gone even if this is cut short.
      this.#jobs.delete(id);
      if (job.idempotencyKey) this.#keys.delete(this.#key(job.requester, job.idempotencyKey));
      return { deleted: id };
    });
  }

  async settings() {
    await this.#ready();
    const { schema, version, ...settings } = this.#settings;
    return { settings, ranges: SETTING_RANGES, limits: LIMITS, worker: Boolean(this.worker) };
  }
  async updateSettings(input) {
    only(input, ['expectedRevision', ...Object.keys(SETTING_RANGES)], 'the Network job settings');
    requireRevision(input);
    for (const [key, [min, max]] of Object.entries(SETTING_RANGES)) if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || input[key] < min || input[key] > max)) fail(`${key} is a whole number from ${min} to ${max}.`);
    await this.#ready();
    await this.#serial(async () => {
      if (input.expectedRevision !== this.#settings.revision) conflict('The Network job settings');
      const { expectedRevision, ...changes } = input, next = { ...this.#settings, ...changes, revision: this.#settings.revision + 1 };
      await writeDocument(join(this.dir, 'settings.json'), next);
      this.#settings = next;
    });
    this.#pump(); // A higher limit starts queued jobs now.
    return this.settings();
  }
}
