/**
 * Compose Batch: Origin tasks engineered into prompts in parallel, reviewed one by one, and sent to Kanban
 * only once approved. One batch per Origin project, keyed by Origin task ID, so sending the same tasks again
 * never duplicates them. Each task is its own file and its own run: an immutable source snapshot, its own
 * settings, a fresh Compose pipeline (one temporary folder and one stateless CLI call per stage, no tools),
 * its own versions, findings and approval. Runs share nothing but a bounded worker pool. Prompt generation
 * is parallel; Kanban keeps the Origin prerequisites, so implementation order is unchanged.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import '../public/origin-model.js';
import { buildContext, escapeId, loopFrom } from './origin.mjs';
import { readWithBackup, serial, setAside, writeAtomic } from './durable.mjs';
import { redactLocal } from './compose-local.mjs';
import { CONTEXT_CHARS } from './compose-grounding.mjs';
import { COMPOSE_PROMPT_CHARS } from './compose-limits.mjs';
import { lintPrompt, validateRequest } from './engine.mjs';
import { buildReviewPrompt, parseReview, STOP_CODES } from './pipeline.mjs';
import { assessPrompt, taskInput } from './prompt-integrity.mjs';
import { buildSplitPrompt, parseSplit, splitCoverage } from './split.mjs';
import { verifyPrompt } from './verification.mjs';
import { FAILURE_MESSAGES, makeTempDir, removeTempDir } from './providers.mjs';

const Model = globalThis.PromptboardOriginModel;
export const BATCH_DIR = 'compose-batches';
export const BATCH_LIMITS = Object.freeze({ items: 500, concurrency: 8, global: 8, versions: 12, timeoutMs: 20 * 60_000, instructions: 2_000 });
const FIELDS = ['provider', 'model', 'effort', 'language', 'quality', 'detail', 'task', 'terminology'];
const OPTIONS = ['acceptanceChecks', 'planFirst', 'edgeCases', 'securityReview'];
const KEY_LIKE = /^[A-Za-z]{1,8}-?\d{1,6}$/;
const hash = text => createHash('sha256').update(text).digest('hex');

export class BatchError extends Error {
  constructor(message, code = 'INVALID_INPUT', status = 400) { super(message); this.code = code; this.status = status; }
}
const conflict = (message, code = 'BATCH_CONFLICT') => new BatchError(message, code, 409);
const id = (value, message = 'Choose a valid task.') => { if (typeof value !== 'string' || !Model.ID.test(value)) throw new BatchError(message); return value; };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const parseObject = bytes => { try { const value = JSON.parse(bytes); return plain(value) ? value : undefined; } catch { return undefined; } };

// ---- Settings: Compose defaults → this batch → this task ----

/** The Compose settings sent by the page, normalized by Compose's own request validator. */
export function normalizeDefaults(value = {}) {
  const picked = plain(value) ? Object.fromEntries([...FIELDS, 'options'].filter(key => value[key] !== undefined).map(key => [key, value[key]])) : {};
  if (plain(picked.options)) picked.options = Object.fromEntries(OPTIONS.filter(key => typeof picked.options[key] === 'boolean').map(key => [key, picked.options[key]]));
  try { const { input, grounding, ...rest } = validateRequest({ ...picked, input: 'x' }); return rest; }
  catch (error) { throw new BatchError(error.message); }
}

/** A partial override; only the fields it names change, everything else is inherited. */
export function normalizeOverrides(value) {
  if (value === undefined || value === null) return {};
  if (!plain(value) || Object.keys(value).some(key => ![...FIELDS, 'options', 'includeContext', 'instructions'].includes(key))) throw new BatchError('These settings contain an unknown field.');
  const out = {};
  for (const key of FIELDS) if (value[key] !== undefined) {
    try { out[key] = validateRequest({ input: 'x', [key]: value[key] })[key]; } catch (error) { throw new BatchError(error.message); }
  }
  if (value.options !== undefined) {
    if (!plain(value.options) || Object.entries(value.options).some(([key, flag]) => !OPTIONS.includes(key) || typeof flag !== 'boolean')) throw new BatchError('Choose valid prompt aids.');
    if (Object.keys(value.options).length) out.options = { ...value.options };
  }
  if (value.includeContext !== undefined) { if (typeof value.includeContext !== 'boolean') throw new BatchError('Choose whether to include the Origin context.'); out.includeContext = value.includeContext; }
  if (value.instructions !== undefined) {
    const text = value.instructions;
    if (typeof text !== 'string' || text.length > BATCH_LIMITS.instructions || text.includes('\0')) throw new BatchError(`Instructions must contain at most ${BATCH_LIMITS.instructions.toLocaleString('en-US')} characters.`);
    if (redactLocal(text) !== text) throw new BatchError('These instructions look like they contain a secret. Remove it first.', 'SECRET_IN_INPUT');
    if (text.trim()) out.instructions = text.trim();
  }
  return out;
}

/** Each field with the level it comes from. A level that picks another CLI resets the model and effort it does not name. */
export function resolveSettings(defaults, batch = {}, task = {}) {
  const value = { ...normalizeDefaults(defaults), includeContext: true, instructions: '' }, from = {};
  for (const key of [...FIELDS, 'includeContext', 'instructions', ...OPTIONS.map(name => `options.${name}`)]) from[key] = 'defaults';
  value.options = { ...value.options };
  for (const [level, layer] of [['batch', batch], ['task', task]]) {
    if (layer.provider !== undefined && layer.provider !== value.provider) for (const key of ['model', 'effort']) if (layer[key] === undefined) { value[key] = ''; from[key] = level; }
    for (const [key, setting] of Object.entries(layer)) {
      if (key === 'options') for (const [name, flag] of Object.entries(setting)) { value.options[name] = flag; from[`options.${name}`] = level; }
      else { value[key] = setting; from[key] = level; }
    }
  }
  return { value, from };
}

// ---- Source snapshots ----

/** Origin context split into evidence excerpts for the prompt writer, within Compose's grounding budget. */
export function evidenceOf(context) {
  const rows = [], skipped = [];
  for (const block of String(context || '').split(/\n(?=## )/)) {
    const match = block.match(/^## (.+)\n([\s\S]*)$/);
    if (!match || !match[2].trim()) continue;
    const title = match[1].trim(), body = match[2].trim(), parts = [];
    for (let at = 0; at < body.length; at += 4800) parts.push(body.slice(at, at + 4800));
    const next = parts.map((text, index) => ({ sourceType: 'knowledge', source: 'Origin design', locator: (parts.length > 1 ? `${title} (part ${index + 1})` : title).slice(0, 300), query: '', text }));
    if (rows.length + next.length <= 40 && JSON.stringify([...rows, ...next]).length <= CONTEXT_CHARS) rows.push(...next); else skipped.push(title);
  }
  return { rows, skipped };
}

/** What one Origin task says now: its words, its context (secrets removed), its prerequisites and the hash Kanban uses. */
export function snapshotSource(record, itemId) {
  const built = buildContext(record, itemId);
  if (!built) return null;
  const blueprint = record.blueprint, item = blueprint.items.find(entry => entry.id === itemId), input = taskInput(item);
  const prerequisites = new Set(item.dependsOn);
  const { rows, skipped } = built.tooLarge ? { rows: [], skipped: [] } : evidenceOf(built.context);
  return { revision: record.revision, hash: built.hash, key: item.key, title: item.title, input, context: built.context, tooLarge: built.tooLarge, error: built.error || '',
    evidence: rows, notGrounded: skipped, warnings: built.warnings, dependsOn: [...item.dependsOn], secret: redactLocal(input) !== input,
    rejected: blueprint.technologies.filter(entry => entry.status === 'rejected' && entry.name.trim()).map(entry => entry.name.trim()).slice(0, 50),
    otherKeys: blueprint.items.filter(entry => entry.id !== itemId && !prerequisites.has(entry.id) && KEY_LIKE.test(entry.key)).map(entry => entry.key).slice(0, 500), takenAt: Date.now() };
}

/** The first line of what the task says to do, for the queue: the line after its title, unless that is a Done when. */
export function hintOf(input = '') {
  const line = String(input).split('\n').slice(1).map(text => text.trim()).find(Boolean) || '';
  return line.startsWith('Done when:') ? '' : line.length > 160 ? `${line.slice(0, 159)}…` : line;
}
/** The Compose request for one task: its own words as the request, its context as evidence, its instructions as user answers. */
export function requestFor(source, settings) {
  const { includeContext, instructions, ...compose } = settings;
  const evidence = includeContext ? source.evidence : [];
  const userAnswers = instructions ? [{ question: 'Additional instruction for this task', answer: instructions }] : [];
  return { input: source.input, ...compose, ...(evidence.length || userAnswers.length ? { grounding: { userAnswers, evidence, unresolvedQuestions: [] } } : {}) };
}

// ---- Status ----

function versionFindings(item, version, origin) {
  const dynamic = [];
  if (origin === 'missing') dynamic.push({ severity: 'blocking', code: 'origin-missing', message: 'This task no longer exists in Origin. Remove it from the batch.' });
  else if (origin === 'changed') dynamic.push({ severity: 'blocking', code: 'origin-changed', message: 'The Origin task changed after it was added. Regenerate to use the current task.' });
  if (version && version.sourceHash !== item.source.hash) dynamic.push({ severity: 'blocking', code: 'source-old', message: 'This prompt was made from an older version of the Origin task. Regenerate it.' });
  if (item.source.tooLarge) dynamic.push({ severity: 'blocking', code: 'context-too-large', message: item.source.error });
  if (item.source.secret) dynamic.push({ severity: 'blocking', code: 'secret', message: 'The task text looks like it contains a secret. Remove it in Origin, then regenerate.' });
  return [...dynamic, ...(version?.integrity.findings || [])];
}
const severityStatus = findings => findings.some(row => row.severity === 'blocking') ? 'blocked' : findings.some(row => row.severity === 'warning') ? 'attention' : 'pass';
const current = item => item.versions.find(version => version.id === item.current) || null;
const approvedNow = (item, version) => Boolean(item.approval && version && item.approval.versionId === version.id && item.approval.promptHash === version.promptHash && item.approval.sourceHash === item.source.hash);
const childApproved = child => Boolean(child.approval && child.approval.promptHash === hash(child.prompt));

/** One state per task, in the words the page shows. */
function stateOf(item, origin, card) {
  if (item.run) return item.run.state;
  if (item.rejected) return 'rejected';
  if (card) return 'sent';
  const version = current(item);
  // A failed review or split keeps the prompt it was about; only a failed generation makes the task Failed.
  if (item.error && (!version || item.error.kind === 'generate')) return 'failed';
  if (!version) return 'pending';
  if (item.split?.state === 'accepted') return origin === 'current' && item.split.fromVersionId === version.id && item.split.coverage.status !== 'issues' && item.split.children.every(childApproved) ? 'approved' : 'review';
  if (approvedNow(item, version) && origin === 'current') return 'approved';
  return severityStatus(versionFindings(item, version, origin)) === 'pass' ? 'generated' : 'review';
}

function failureOf(error, closing) {
  if (closing) return { code: 'INTERRUPTED', message: 'The app stopped while this task was running. Run it again.' };
  if (error?.name === 'TimeoutError') return { code: 'TIMEOUT', message: FAILURE_MESSAGES.TIMEOUT };
  if (error?.code === 'BATCH_WRITE_FAILED') return { code: error.code, message: error.message }; // The disk, not the CLI.
  if (typeof error?.code === 'string' && Object.hasOwn(FAILURE_MESSAGES, error.code)) return { code: error.code, message: FAILURE_MESSAGES[error.code] };
  // Validation and intent errors carry fixed, user-facing text. CLI output is never shown.
  if (error?.status === 400 || error?.statusCode === 400 || error?.status === 422) return { code: error.code || 'INVALID_INPUT', message: String(error.message).slice(0, 400) };
  return { code: 'FAILED', message: 'The CLI could not complete this prompt. Run it again, or check the CLI in your terminal.' };
}

// ---- The service ----

export class ComposeBatches {
  #serial = serial();
  #cache = new Map();
  #originCache = new Map();
  #loading = new Map();
  #queue = [];
  #active = new Map();
  #timings = new Map(); // Recent run times per batch, in memory only: the page estimates progress and time left from them.
  #closing = false;
  instance = randomUUID();

  /**
   * `generate(request, { signal, onStage })` is Compose's own generation (validation, effort check, pipeline);
   * `call({ provider, model, effort, prompt, cwd, signal })` runs one isolated CLI call for a review or a split.
   */
  constructor({ dataDir, origin, board, generate, call, track = promise => promise, timeoutMs = BATCH_LIMITS.timeoutMs, authBusy = () => false }) {
    Object.assign(this, { dir: join(dataDir, BATCH_DIR), origin, board, generate, call, track, timeoutMs, authBusy });
  }

  /** Running and queued tasks: a sign-in change must not start while any of them would still call a CLI. */
  activeCount() { return this.#active.size + this.#queue.length; }

  // ---- Persistence: one meta file per batch, one file per task; all changes in one queue ----
  #path(batchId, itemId) { return itemId ? join(this.dir, escapeId(batchId), 'items', `${escapeId(itemId)}.json`) : join(this.dir, escapeId(batchId), 'batch.json'); }
  async #write(path, value) {
    try { await writeAtomic(path, `${JSON.stringify(value)}\n`); }
    catch { throw new BatchError('The batch could not be saved. Check free disk space and folder permissions. Nothing was changed.', 'BATCH_WRITE_FAILED', 500); }
  }
  /** One cached copy per batch: concurrent first reads share one load, so no change can land on a second copy. */
  #load(batchId) {
    if (this.#cache.has(batchId)) return Promise.resolve(this.#cache.get(batchId));
    if (!this.#loading.has(batchId)) this.#loading.set(batchId, this.#read(batchId).finally(() => this.#loading.delete(batchId)));
    return this.#loading.get(batchId);
  }
  /** A file, or its backup when the file is damaged; a damaged one is set aside. */
  async #readFile(path) {
    const damaged = [], value = await readWithBackup([path, `${path}.bak`], (bytes, file) => { const value = parseObject(bytes); if (value === undefined) damaged.push(file); return value; });
    await setAside(damaged);
    return value;
  }
  async #read(batchId) {
    const meta = await this.#readFile(this.#path(batchId));
    if (!meta) return null;
    const items = new Map();
    for (const itemId of meta.order) {
      const item = await this.#readFile(this.#path(batchId, itemId));
      if (!item) continue;
      // Runs live only in this process. A run saved by an earlier process stopped with it: never restart it on its own.
      if (item.run) {
        const started = item.run.state === 'running', run = item.run;
        item.run = null;
        if (started) item.error = { code: 'INTERRUPTED', message: 'The app stopped while this task was running. Run it again.', kind: run.kind, at: Date.now() };
        await this.#write(this.#path(batchId, itemId), item);
      }
      items.set(itemId, item);
    }
    meta.order = meta.order.filter(itemId => items.has(itemId));
    const batch = { meta, items };
    this.#cache.set(batchId, batch);
    return batch;
  }
  async #require(batchId) {
    const batch = await this.#load(id(batchId, 'Choose a valid batch.'));
    if (!batch) throw new BatchError('This batch does not exist. Send tasks from Origin first.', 'NOT_FOUND', 404);
    return batch;
  }
  /** Change one task: a copy is changed and saved, then it replaces the cached task. A failed save changes nothing. */
  async #saveItem(batch, item) {
    item.revision = (item.revision || 0) + 1;
    await this.#write(this.#path(batch.meta.id, item.id), item);
    batch.items.set(item.id, item);
    // The batch revision only tells the page that something moved; it is saved with the next batch change.
    batch.meta = { ...batch.meta, revision: batch.meta.revision + 1, updatedAt: Date.now() };
  }
  async #touch(batch, change = {}) {
    const meta = { ...batch.meta, ...change, revision: batch.meta.revision + 1, updatedAt: Date.now() };
    await this.#write(this.#path(meta.id), meta);
    batch.meta = meta;
  }
  #item(batch, itemId) {
    const item = batch.items.get(id(itemId));
    if (!item) throw new BatchError('This task is not in the batch. Reload it.', 'NOT_FOUND', 404);
    return structuredClone(item);
  }

  // ---- Origin and Kanban, as read now ----
  async #record(originId) {
    const record = await this.origin.read(originId);
    return record && !record.damaged ? record : null;
  }
  /** Whether each task still says in Origin what it said when its prompt was made. Rebuilt only after Origin or the task changes. */
  #originStates(batch, record) {
    const states = new Map();
    for (const item of batch.items.values()) {
      const key = `${batch.meta.id}:${item.id}`, cached = this.#originCache.get(key);
      if (cached && cached.revision === record?.revision && cached.hash === item.source.hash) { states.set(item.id, cached.state); continue; }
      const built = record && buildContext(record, item.id), state = !built ? 'missing' : built.hash === item.source.hash ? 'current' : 'changed';
      this.#originCache.set(key, { revision: record?.revision, hash: item.source.hash, state });
      states.set(item.id, state);
    }
    return states;
  }
  async #cards(batchId, record) {
    const destination = record?.kanbanProjectId ? (await this.board.state()).projects.find(project => project.id === record.kanbanProjectId) : null;
    const cards = new Map();
    for (const task of destination?.tasks || []) if (task.originSource?.originProjectId === batchId) cards.set(task.originSource.originTaskId, task);
    // As Origin's own Send to Kanban: its handoff record, else (a split task whose record was lost) its last part.
    const items = new Set(destination ? record.blueprint.items.map(item => item.id) : []);
    for (const item of destination ? record.blueprint.items : []) {
      const card = cards.get(item.id) || (item.handoff?.projectId === destination.id ? destination.tasks.find(task => task.id === item.handoff.taskId) : null) || Model.splitCard(destination.tasks, batchId, item.id, id => items.has(id));
      if (card) cards.set(item.id, card);
    }
    return { destination, cards };
  }

  // ---- Import from Origin ----
  add(input) {
    return this.#serial(async () => {
      const originId = id(input?.originId, 'Choose a valid Origin project.');
      const record = await this.#record(originId);
      if (!record) throw new BatchError('This Origin project no longer exists.', 'NOT_FOUND', 404);
      if (record.revision !== input.expectedRevision) throw conflict('The blueprint has newer changes. Let it save, then send again.', 'ORIGIN_REVISION_CONFLICT');
      const wanted = Array.isArray(input.itemIds) ? [...new Set(input.itemIds)] : [];
      if (!wanted.length || wanted.length > BATCH_LIMITS.items) throw new BatchError(`Choose 1 to ${BATCH_LIMITS.items} tasks.`);
      for (const itemId of wanted) if (!record.blueprint.items.some(entry => entry.id === id(itemId))) throw new BatchError('A selected task no longer exists. Reload the project.', 'NOT_FOUND', 404);
      const defaults = normalizeDefaults(input.defaults);
      let batch = await this.#load(originId);
      if (!batch) {
        batch = { meta: { schema: 'promptboard.compose-batch', version: 1, id: originId, name: record.name, createdAt: Date.now(), updatedAt: Date.now(), revision: 0,
          settings: {}, defaults, concurrency: 3, order: [], notice: null }, items: new Map() };
        await mkdir(join(this.dir, escapeId(originId), 'items'), { recursive: true, mode: 0o700 });
      }
      const fresh = wanted.filter(itemId => !batch.items.has(itemId));
      if (batch.items.size + fresh.length > BATCH_LIMITS.items) throw new BatchError(`A batch holds at most ${BATCH_LIMITS.items} tasks. Remove some first.`);
      for (const itemId of fresh) {
        const item = { id: itemId, key: '', title: '', addedAt: Date.now(), revision: 0, source: snapshotSource(record, itemId), overrides: {}, versions: [], current: null, approval: null, rejected: false, run: null, error: null, split: null };
        Object.assign(item, { key: item.source.key, title: item.source.title });
        await this.#write(this.#path(originId, itemId), item);
        batch.items.set(itemId, item);
      }
      // Build order follows the Origin prerequisites, so the queue reads in the order Kanban will run.
      const order = Model.orderItems(record.blueprint, [...batch.items.keys()].filter(itemId => record.blueprint.items.some(entry => entry.id === itemId)));
      const meta = { ...batch.meta, name: record.name, defaults, order: [...order, ...batch.meta.order.filter(itemId => !order.includes(itemId)), ...fresh.filter(itemId => !order.includes(itemId))] };
      meta.order = [...new Set(meta.order)];
      batch.meta = meta;
      this.#cache.set(originId, batch);
      await this.#touch(batch);
      return { added: fresh.length, existing: wanted.length - fresh.length };
    });
  }

  // ---- Views ----
  /** True when neither the batch nor its Origin project changed since the page last read them. */
  async unchanged(batchId, since, originRevision, instance) {
    const batch = await this.#require(batchId);
    if (instance !== this.instance || batch.meta.revision !== since || [...batch.items.values()].some(item => item.run)) return false;
    return (await this.#record(batch.meta.id))?.revision === originRevision;
  }
  async list() {
    let names = [];
    try { names = await readdir(this.dir); } catch {}
    const out = [];
    for (const name of names) {
      // The same files and backup a batch loads from, so a batch that opens is also listed.
      const meta = await readWithBackup([join(this.dir, name, 'batch.json'), join(this.dir, name, 'batch.json.bak')], parseObject).catch(() => null);
      if (meta?.id) out.push({ id: meta.id, name: meta.name, count: meta.order.length, updatedAt: meta.updatedAt });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** The queue: one compact row per task. Prompts and reports are read one task at a time with `item()`. */
  async view(batchId) {
    const batch = await this.#require(batchId), record = await this.#record(batch.meta.id);
    const origin = this.#originStates(batch, record), { destination, cards } = await this.#cards(batch.meta.id, record);
    const items = batch.meta.order.map(itemId => batch.items.get(itemId)).filter(Boolean).map(item => {
      const version = current(item), findings = versionFindings(item, item.split?.state === 'accepted' ? null : version, origin.get(item.id)), card = cards.get(item.id);
      return { id: item.id, key: item.key, title: item.title, hint: hintOf(item.source.input), revision: item.revision, state: stateOf(item, origin.get(item.id), card), stage: this.#active.get(item.run?.id)?.stage || '',
        startedAt: item.run?.state === 'running' ? item.run.startedAt || null : null,
        error: item.error, origin: origin.get(item.id), dependsOn: item.source.dependsOn, versions: item.versions.length, current: item.current || '', card: card ? { id: card.id, number: card.number } : null,
        findings: { blocking: findings.filter(row => row.severity === 'blocking').length, warning: findings.filter(row => row.severity === 'warning').length },
        split: item.split ? { state: item.split.state, children: item.split.children.map(child => ({ id: child.id, title: child.title, approved: childApproved(child), card: cards.get(child.originTaskId) ? { number: cards.get(child.originTaskId).number } : null })) } : null };
    });
    const counts = {};
    for (const item of items) counts[item.state] = (counts[item.state] || 0) + 1;
    const known = new Map((record?.blueprint.items || []).map(item => [item.id, item]));
    const loop = loopFrom(known, items.filter(item => known.has(item.id)).map(item => item.id));
    return { id: batch.meta.id, name: batch.meta.name, revision: batch.meta.revision, instance: this.instance, originRevision: record?.revision ?? null, settings: batch.meta.settings, defaults: batch.meta.defaults,
      concurrency: batch.meta.concurrency, notice: batch.meta.notice, counts, items, cycle: loop || null, inherited: resolveSettings(batch.meta.defaults), typicalMs: this.#typical(batch.meta.id),
      kanban: destination ? { id: destination.id, name: destination.name } : null, keys: Object.fromEntries([...known.values()].map(item => [item.id, item.key])) };
  }

  /** Everything about one task: source, versions with their findings and trace, settings and where each comes from. */
  async item(batchId, itemId) {
    const batch = await this.#require(batchId), item = this.#item(batch, itemId), record = await this.#record(batch.meta.id);
    const origin = this.#originStates(batch, record).get(item.id), { cards } = await this.#cards(batch.meta.id, record);
    const resolved = resolveSettings(batch.meta.defaults, batch.meta.settings, item.overrides);
    const latest = current(item);
    return { ...item, origin, state: stateOf(item, origin, cards.get(item.id)), settings: resolved, inherited: resolveSettings(batch.meta.defaults, batch.meta.settings), approved: approvedNow(item, latest), stage: this.#active.get(item.run?.id)?.stage || '',
      findings: versionFindings(item, latest, origin), card: cards.get(item.id) ? { id: cards.get(item.id).id, number: cards.get(item.id).number } : null,
      split: item.split ? { ...item.split, children: item.split.children.map(child => ({ ...child, approved: childApproved(child) })) } : null };
  }

  // ---- Settings ----
  configure(batchId, { settings, concurrency, expectedRevision } = {}) {
    return this.#serial(async () => {
      const batch = await this.#require(batchId);
      if (expectedRevision !== undefined && expectedRevision !== batch.meta.revision) throw conflict('The batch changed. Review it again.');
      const change = {};
      if (settings !== undefined) change.settings = normalizeOverrides(settings);
      if (concurrency !== undefined) {
        if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > BATCH_LIMITS.concurrency) throw new BatchError(`Choose 1 to ${BATCH_LIMITS.concurrency} parallel runs.`);
        change.concurrency = concurrency;
      }
      await this.#touch(batch, change);
      this.#pump();
    });
  }

  /** A task-level change: settings overrides, an edited prompt, reject or restore, or an edited split task. */
  update(batchId, itemId, input = {}) {
    return this.#serial(async () => {
      const batch = await this.#require(batchId), item = this.#item(batch, itemId);
      if (item.run) throw conflict('This task is running. Wait for it or cancel it first.', 'TASK_RUNNING');
      if ((input.prompt !== undefined || input.child !== undefined) && (await this.#cards(batch.meta.id, await this.#record(batch.meta.id))).cards.has(item.id)) throw conflict('This task is already on Kanban. Change its card there.', 'TASK_SENT');
      if (input.overrides !== undefined) item.overrides = normalizeOverrides(input.overrides);
      if (input.rejected !== undefined) { item.rejected = input.rejected === true; if (item.rejected) item.approval = null; }
      if (input.prompt !== undefined) this.#edit(batch, item, input);
      if (input.child !== undefined) this.#editChild(item, input.child);
      await this.#saveItem(batch, item);
    });
  }
  #edit(batch, item, { prompt, baseVersionId }) {
    const base = current(item);
    if (!base || base.id !== baseVersionId) throw conflict('A newer version of this prompt exists. Review it first.', 'VERSION_CONFLICT');
    if (item.split) throw conflict('Undo the split before you edit the parent prompt.', 'SPLIT_ACTIVE');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > COMPOSE_PROMPT_CHARS || prompt.includes('\0')) throw new BatchError(`Enter a prompt of at most ${COMPOSE_PROMPT_CHARS.toLocaleString('en-US')} characters.`);
    if (prompt === base.prompt) return;
    const language = base.settings.language;
    // The edit keeps the last review for reference only; repair notes and call details belong to the generated text.
    const verification = { automatic: verifyPrompt(item.source.input, prompt, language), review: base.verification?.review, reviewStale: true };
    this.#addVersion(item, { kind: 'edited', prompt, settings: base.settings, sourceHash: base.sourceHash, verification, lint: lintPrompt(prompt, language), basedOn: base.id });
  }
  #editChild(item, { childId, prompt }) {
    const child = item.split?.children.find(entry => entry.id === childId);
    if (!child) throw new BatchError('This split task does not exist.', 'NOT_FOUND', 404);
    if (child.sent) throw conflict('This split task is already on Kanban.', 'TASK_SENT');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > COMPOSE_PROMPT_CHARS || prompt.includes('\0')) throw new BatchError(`Enter a prompt of at most ${COMPOSE_PROMPT_CHARS.toLocaleString('en-US')} characters.`);
    Object.assign(child, { prompt: prompt.trim(), approval: null, edited: true });
    const parent = current(item);
    item.split.coverage = splitCoverage(parent.prompt, item.split.children, parent.settings.language);
  }
  #addVersion(item, version) {
    const integrity = assessPrompt({ source: item.source, prompt: version.prompt, verification: version.verification, language: version.settings.language, reviewStale: Boolean(version.verification?.reviewStale) });
    const entry = { id: randomUUID(), n: (item.versions.at(-1)?.n || 0) + 1, createdAt: Date.now(), promptHash: hash(version.prompt), ...version, integrity };
    item.versions = [...item.versions, entry].slice(-BATCH_LIMITS.versions);
    item.current = entry.id; item.approval = null; item.error = null;
    return entry;
  }

  remove(batchId, itemId) {
    return this.#serial(async () => {
      const batch = await this.#require(batchId), item = this.#item(batch, itemId);
      if (item.run) throw conflict('This task is running. Cancel it first.', 'TASK_RUNNING');
      await this.#touch(batch, { order: batch.meta.order.filter(entry => entry !== item.id) });
      batch.items.delete(item.id);
      await rm(this.#path(batch.meta.id, item.id), { force: true });
      await rm(`${this.#path(batch.meta.id, item.id)}.bak`, { force: true });
    });
  }

  /** Remove the whole batch. Origin tasks and Kanban cards are untouched. */
  removeBatch(batchId) {
    return this.#serial(async () => {
      const batch = await this.#require(batchId);
      if ([...batch.items.values()].some(item => item.run)) throw conflict('Tasks are running. Cancel them first.', 'TASK_RUNNING');
      // The cached copy goes last, so a read during the removal never caches a half-deleted folder.
      await rm(join(this.dir, escapeId(batch.meta.id)), { recursive: true, force: true });
      this.#cache.delete(batch.meta.id);
    });
  }

  // ---- Runs ----
  /**
   * Queue work for tasks. `kind` is generate, review (check the current prompt again) or split. A task that is
   * already queued or running is skipped, so repeated clicks never start a second run. Nothing else starts.
   */
  run(batchId, { itemIds, kind = 'generate', defaults, all = false } = {}) {
    return this.#serial(async () => {
      if (this.#closing) throw conflict('The app is shutting down.', 'SHUTTING_DOWN');
      if (this.authBusy()) throw conflict('A sign-in change is in progress. Finish or cancel it first.', 'AUTH_IN_PROGRESS');
      if (!['generate', 'review', 'split'].includes(kind)) throw new BatchError('Choose a valid run.');
      const batch = await this.#require(batchId), record = await this.#record(batch.meta.id);
      if (defaults !== undefined) await this.#touch(batch, { defaults: normalizeDefaults(defaults), notice: null });
      else if (batch.meta.notice) await this.#touch(batch, { notice: null });
      const { cards } = await this.#cards(batch.meta.id, record);
      // Run all: tasks without a prompt and tasks whose generation failed; a failed check or split keeps its prompt.
      const ids = all ? batch.meta.order.filter(itemId => { const item = batch.items.get(itemId); return item && (!item.versions.length || item.error?.kind === 'generate'); }) : (Array.isArray(itemIds) ? [...new Set(itemIds)] : []);
      if (!ids.length) return { queued: 0, skipped: [] };
      for (const itemId of ids) this.#item(batch, itemId); // An unknown task refuses the whole request before any is queued.
      let queued = 0; const skipped = [];
      // A save that fails part-way still starts what was queued before it.
      try { for (const itemId of ids) {
        const item = this.#item(batch, itemId), skip = reason => skipped.push({ id: item.id, key: item.key, reason });
        if (item.run) { skip('Already running.'); continue; }
        if (cards.has(item.id)) { skip('Already on Kanban.'); continue; }
        if (item.rejected) { skip('Rejected. Restore it first.'); continue; }
        if (kind !== 'generate' && !current(item)) { skip('Generate a prompt first.'); continue; }
        if (kind === 'generate') {
          if (item.split?.children.some(child => child.sent)) { skip('Some parts of its split are already on Kanban.'); continue; }
          // A regenerated prompt always uses the task as Origin has it now.
          const fresh = record && snapshotSource(record, item.id);
          if (!fresh) { skip('The task no longer exists in Origin.'); continue; }
          if (fresh.hash !== item.source.hash) Object.assign(item, { source: fresh, key: fresh.key, title: fresh.title, split: null });
        } else if (current(item).sourceHash !== item.source.hash) { skip('The task changed since this prompt was made. Regenerate it first.'); continue; }
        // Every run sends the task's words to a CLI: never one that looks like it holds a secret.
        if (item.source.secret) { skip('The task text looks like it contains a secret.'); await this.#saveItem(batch, item); continue; }
        if (item.source.tooLarge) { skip(item.source.error); await this.#saveItem(batch, item); continue; }
        if (kind === 'split' && severityStatus(versionFindings(item, current(item), 'current')) === 'blocked') { skip('Resolve the blocking findings before you split.'); continue; }
        if (kind === 'generate') item.split = null;
        if (kind === 'split' && item.split?.state === 'accepted') { skip('Undo the split first.'); continue; }
        // The effective settings are fixed when the task is queued and saved with the version it produces.
        const settings = resolveSettings(batch.meta.defaults, batch.meta.settings, item.overrides).value;
        Object.freeze(settings.options); Object.freeze(settings);
        item.run = { id: randomUUID(), kind, state: 'queued', queuedAt: Date.now() };
        item.approval = null; item.error = null;
        await this.#saveItem(batch, item);
        this.#queue.push({ batchId: batch.meta.id, itemId: item.id, runId: item.run.id, kind, settings, controller: new AbortController(), stage: '' });
        queued++;
      } } finally { this.#pump(); }
      return { queued, skipped };
    });
  }

  /** Cancel queued and running work. A late answer from a cancelled run is ignored. */
  cancel(batchId, { itemIds } = {}) {
    const wanted = Array.isArray(itemIds) ? new Set(itemIds) : null, match = job => job.batchId === batchId && (!wanted || wanted.has(job.itemId));
    // Running agents stop at once (their process group is ended), not after the changes queued before this one.
    let stopped = 0;
    for (const job of this.#active.values()) if (match(job) && !job.cancelled) { job.cancelled = true; job.controller.abort(); stopped++; }
    return this.#serial(async () => {
      const batch = await this.#require(batchId);
      let cancelled = stopped;
      // A run the queue started between the first pass and now is stopped here, so Cancel never misses one.
      for (const job of this.#active.values()) if (match(job) && !job.cancelled) { job.cancelled = true; job.controller.abort(); cancelled++; }
      for (const job of this.#queue.filter(match)) {
        this.#queue.splice(this.#queue.indexOf(job), 1);
        const item = structuredClone(batch.items.get(job.itemId));
        // The job has left the queue: a save the disk refuses still frees the task in memory, so it never waits without a worker.
        if (item?.run?.id === job.runId) { item.run = null; await this.#saveItem(batch, item).catch(() => this.#release(job, null)); }
        cancelled++;
      }
      return { cancelled };
    });
  }

  /** The typical time of one generation in this batch (its recent finished runs), or 0 before the first one. */
  #typical(batchId) {
    const times = this.#timings.get(batchId) || [];
    return times.length ? Math.round(times.reduce((sum, ms) => sum + ms, 0) / times.length) : 0;
  }

  #pump() {
    if (this.#closing) return;
    for (let index = 0; index < this.#queue.length && this.#active.size < BATCH_LIMITS.global;) {
      const job = this.#queue[index], limit = this.#cache.get(job.batchId)?.meta.concurrency || 1;
      if ([...this.#active.values()].filter(entry => entry.batchId === job.batchId).length >= limit) { index++; continue; }
      this.#queue.splice(index, 1);
      this.#start(job);
    }
  }

  #start(job) {
    this.#active.set(job.runId, job);
    const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(this.timeoutMs)]);
    const work = (async () => {
      const marked = await this.#apply(job, item => { item.run = { ...item.run, state: 'running', startedAt: Date.now() }; }).catch(error => { this.#release(job, failureOf(error, false)); return false; });
      if (!marked) return;
      try {
        const snapshot = structuredClone(this.#cache.get(job.batchId).items.get(job.itemId)); // This run's own copy; nothing it reads is shared.
        const started = Date.now(), outcome = await this.#work(job, snapshot, signal);
        if (job.kind === 'generate' && !job.cancelled) this.#timings.set(job.batchId, [...(this.#timings.get(job.batchId) || []), Date.now() - started].slice(-12));
        // Cancel can be queued behind other changes while the answer arrives: a cancelled run never adds its result.
        await this.#apply(job, item => { if (job.cancelled) item.run = null; else outcome(item); });
      } catch (error) {
        const failure = job.cancelled ? null : failureOf(error, this.#closing);
        // Called first: the queued tasks leave the queue at once, so another run ending meanwhile cannot start one.
        const stopping = failure && STOP_CODES.has(failure.code) ? this.#stopQueued(job.batchId, failure) : null;
        await this.#apply(job, item => { item.run = null; item.error = failure && { ...failure, kind: job.kind, at: Date.now() }; }).catch(() => this.#release(job, failure));
        await stopping?.catch(() => {});
      }
    })();
    this.track(work).finally(() => { this.#active.delete(job.runId); this.#pump(); }).catch(() => {});
  }

  /** Apply a run's result to its task, only while that run still owns the task. */
  #apply(job, change) {
    return this.#serial(async () => {
      const batch = this.#cache.get(job.batchId), stored = batch?.items.get(job.itemId);
      if (!stored || stored.run?.id !== job.runId) return false;
      const item = structuredClone(stored);
      change(item);
      await this.#saveItem(batch, item);
      return true;
    });
  }

  /**
   * The task of a run whose end could not be saved (disk full, permissions) is freed in this app's memory, so it
   * does not show as running forever and can run again. Its file still names the run: a restart reports it as interrupted.
   */
  #release(job, failure) {
    const batch = this.#cache.get(job.batchId), stored = batch?.items.get(job.itemId);
    if (stored?.run?.id !== job.runId) return;
    batch.items.set(job.itemId, { ...stored, run: null, error: failure && { ...failure, kind: job.kind, at: Date.now() } });
    batch.meta = { ...batch.meta, revision: batch.meta.revision + 1, updatedAt: Date.now() }; // A polling page sees the change.
  }

  /** After an account-level failure every queued call would fail the same way: put them back, do not spend more usage. */
  #stopQueued(batchId, failure) {
    const stopped = this.#queue.filter(entry => entry.batchId === batchId);
    for (const job of stopped) this.#queue.splice(this.#queue.indexOf(job), 1);
    return this.#serial(async () => {
      const batch = this.#cache.get(batchId);
      // The tasks taken out of the queue are freed even when the disk refuses the save.
      await this.#touch(batch, { notice: { code: failure.code, message: `${failure.message} Queued tasks were not started.`, at: Date.now() } }).catch(() => {});
      for (const job of stopped) {
        const item = structuredClone(batch.items.get(job.itemId));
        if (item?.run?.id === job.runId) { item.run = null; await this.#saveItem(batch, item).catch(() => this.#release(job, null)); }
      }
    });
  }

  /** The run itself. It returns how to change the task; the change is applied only if this run still owns it. */
  async #work(job, item, signal) {
    const { settings } = job, onStage = stage => { job.stage = stage; };
    const finish = change => target => { change(target); target.run = null; };
    if (job.kind === 'generate') {
      const request = requestFor(item.source, settings);
      const result = await this.generate(request, { signal, onStage });
      if (typeof result?.prompt !== 'string' || !result.prompt.trim()) throw new Error('Empty prompt.');
      return finish(target => this.#addVersion(target, { kind: 'generated', prompt: result.prompt, settings, sourceHash: item.source.hash, verification: result.verification, lint: result.lint, reportedModels: result.reportedModels || [] }));
    }
    const version = current(item), base = version.settings;
    if (job.kind === 'review') {
      onStage('review');
      const request = validateRequest(requestFor(item.source, base));
      let review;
      try { review = parseReview(await this.#once(base, buildReviewPrompt(request, version.prompt), signal), request, version.prompt); }
      catch (error) {
        signal.throwIfAborted();
        if (STOP_CODES.has(error?.code)) throw error;
        review = { status: 'unavailable', requirements: [], criteria: [], issues: [{ category: 'review', message: 'The model review failed or returned invalid evidence. Check the prompt manually.' }] };
      }
      return finish(target => {
        const entry = target.versions.find(row => row.id === version.id);
        if (!entry || target.current !== version.id) return;
        entry.verification = { ...entry.verification, review, reviewStale: false, checkedAt: Date.now() };
        entry.integrity = assessPrompt({ source: target.source, prompt: entry.prompt, verification: entry.verification, language: base.language });
        target.approval = null;
      });
    }
    onStage('split');
    const children = parseSplit(await this.#once(base, buildSplitPrompt(version.prompt, base.language), signal));
    const coverage = splitCoverage(version.prompt, children, base.language);
    return finish(target => {
      if (target.current !== version.id) return;
      target.split = { state: 'proposed', fromVersionId: version.id, createdAt: Date.now(), coverage,
        children: children.map((child, index) => ({ id: String(index + 1), originTaskId: `${target.id.slice(0, 90)}-s${index + 1}`, title: child.title, prompt: child.prompt, edited: false, approval: null })) };
    });
  }
  async #once(settings, prompt, signal) {
    const cwd = await makeTempDir('ste-batch-');
    try {
      let result;
      try { result = await this.call({ provider: settings.provider, model: settings.model, effort: settings.effort, prompt, cwd, signal, timeoutMs: null }); }
      catch (error) { signal.throwIfAborted(); throw error; } // A deadline reports a timeout, not a cancellation.
      signal.throwIfAborted();
      if (typeof result?.text !== 'string' || !result.text.trim()) throw new Error('The CLI returned no text.');
      return result.text;
    } finally { await removeTempDir(cwd); }
  }

  // ---- Split decisions ----
  decideSplit(batchId, itemId, { accept }) {
    return this.#serial(async () => {
      const batch = await this.#require(batchId), item = this.#item(batch, itemId);
      if (item.run) throw conflict('This task is running. Wait for it first.', 'TASK_RUNNING');
      if (!item.split) throw new BatchError('This task has no split.', 'NOT_FOUND', 404);
      if (accept === true) {
        if (item.split.state !== 'proposed') throw conflict('This split is already in use.');
        if (item.split.fromVersionId !== item.current) throw conflict('The prompt changed after this split was made. Split it again.', 'VERSION_CONFLICT');
        if (item.split.coverage.status === 'issues') throw conflict('Some exact values of the prompt are in no split task. Edit the tasks, or split again.', 'SPLIT_INCOMPLETE');
        item.split.state = 'accepted'; item.approval = null;
      } else {
        if (item.split.children.some(child => child.sent)) throw conflict('Some split tasks are already on Kanban.', 'TASK_SENT');
        item.split = null;
      }
      await this.#saveItem(batch, item);
    });
  }

  // ---- Approval ----
  /** Approve exact versions, or every task whose checks all pass (`passing`). Blocking findings are never approved. */
  approve(batchId, { items = [], passing = false, approve = true } = {}) {
    return this.#serial(async () => {
      const batch = await this.#require(batchId), record = await this.#record(batch.meta.id);
      const origin = this.#originStates(batch, record), { cards } = await this.#cards(batch.meta.id, record);
      const targets = passing ? batch.meta.order.map(itemId => ({ itemId })) : (Array.isArray(items) ? items : []);
      let approved = 0; const refused = [];
      for (const target of targets) {
        const item = this.#item(batch, target.itemId), version = current(item), refuse = reason => refused.push({ id: item.id, key: item.key, reason });
        if (item.run || cards.has(item.id) || item.rejected) { if (!passing) refuse('This task cannot be approved now.'); continue; }
        if (target.childId !== undefined) {
          const child = item.split?.state === 'accepted' && item.split.children.find(entry => entry.id === target.childId);
          if (!child) { refuse('Accept the split first.'); continue; }
          if (approve && item.split.coverage.status === 'issues') { refuse('Some exact values of the prompt are in no part. Edit the parts first.'); continue; }
          child.approval = approve ? { promptHash: hash(child.prompt), at: Date.now() } : null;
          await this.#saveItem(batch, item); approved++; continue;
        }
        if (!approve) { item.approval = null; await this.#saveItem(batch, item); approved++; continue; }
        if (item.split || !version) { if (!passing) refuse(item.split ? 'Approve the split tasks instead.' : 'Generate a prompt first.'); continue; }
        if (passing && item.error) continue;
        if (!passing && target.versionId !== version.id) { refuse('A newer version exists. Review it first.'); continue; }
        if (approvedNow(item, version)) continue;
        const status = severityStatus(versionFindings(item, version, origin.get(item.id)));
        if (status === 'blocked' || (passing && status !== 'pass')) { if (!passing) refuse('Resolve the blocking findings first.'); continue; }
        // Approving the current prompt also settles an earlier failed run of it.
        item.approval = { versionId: version.id, promptHash: version.promptHash, sourceHash: item.source.hash, at: Date.now() }; item.error = null;
        await this.#saveItem(batch, item); approved++;
      }
      return { approved, refused };
    });
  }

  // ---- Kanban ----
  /**
   * Send approved tasks to the linked Kanban project's To Do, prerequisites first. Each card carries the approved
   * prompt and the Origin context, and the Origin identity that keeps repeated sends from adding a second card.
   * A task whose prerequisite has no card and is not sent along is refused, never sent without it. Nothing starts.
   */
  export(batchId, { itemIds, recreate = [] } = {}) {
    return this.#serial(async () => {
      const batch = await this.#require(batchId), originId = batch.meta.id, record = await this.#record(originId);
      if (!record) throw new BatchError('This Origin project no longer exists.', 'NOT_FOUND', 404);
      const { destination, cards } = await this.#cards(originId, record);
      if (!destination) throw conflict('Connect the Origin project to a Kanban project first.', 'NOT_LINKED');
      const origin = this.#originStates(batch, record), items = new Map(record.blueprint.items.map(item => [item.id, item]));
      const chosen = (Array.isArray(itemIds) ? [...new Set(itemIds)] : batch.meta.order).filter(itemId => batch.items.has(itemId));
      const ready = [], problems = [];
      for (const itemId of chosen) {
        const item = batch.items.get(itemId), version = current(item);
        if (cards.has(itemId)) continue;
        const state = stateOf(item, origin.get(itemId), null);
        if (state !== 'approved') { if (Array.isArray(itemIds)) problems.push({ id: itemId, key: item.key, reason: 'Not approved.' }); continue; }
        if (!item.split && !approvedNow(item, version)) { problems.push({ id: itemId, key: item.key, reason: 'The approval is out of date.' }); continue; }
        ready.push(itemId);
      }
      if (!ready.length) return { status: 409, body: { error: problems.length ? 'Only approved tasks can go to Kanban.' : 'No approved tasks are waiting for Kanban.', code: 'NOTHING_APPROVED', problems } };
      const loop = loopFrom(items, ready);
      if (loop) return { status: 409, body: { error: `These tasks wait for each other: ${loop.join(' → ')}. Remove one prerequisite in Origin first.`, code: 'PLAN_CYCLE' } };
      const selection = new Set(ready);
      const missing = ready.flatMap(itemId => items.get(itemId).dependsOn.filter(dep => !selection.has(dep) && !cards.has(dep)).map(dep => ({ id: itemId, key: items.get(itemId).key, waitsFor: items.get(dep)?.key || dep, inBatch: batch.items.has(dep) })));
      if (missing.length) return { status: 409, body: { error: 'Some approved tasks wait for tasks that are neither on Kanban nor approved here. Approve those prerequisites, or send them from Origin first.', code: 'PREREQUISITES_MISSING', missing } };
      const removed = ready.filter(itemId => items.get(itemId).handoff?.projectId === destination.id && !recreate.includes(itemId));
      if (removed.length) return { status: 409, body: { error: 'Some of these tasks had a card that was deleted in Kanban. Choose to create them again, or leave them out.', code: 'CARDS_REMOVED', removed: removed.map(itemId => ({ id: itemId, key: items.get(itemId).key })) } };
      // Prerequisites first. A split task becomes its approved parts, in order; later tasks wait for its last part.
      const ordered = Model.orderItems(record.blueprint, ready), entries = [], links = [], lastOf = new Map();
      for (const itemId of ordered) {
        const item = batch.items.get(itemId), built = buildContext(record, itemId);
        if (built.tooLarge) return { status: 409, body: { error: built.error, code: 'CONTEXT_TOO_LARGE' } };
        const before = items.get(itemId).dependsOn.map(dep => (cards.has(dep) ? { card: cards.get(dep).id } : { origin: lastOf.get(dep) || dep }));
        const parts = item.split ? item.split.children.map(child => ({ originTaskId: child.originTaskId, key: `${item.key}.${child.id}`.slice(0, 20), title: child.title, prompt: child.prompt, childId: child.id, promptHash: hash(child.prompt) }))
          : [{ originTaskId: itemId, key: item.key, title: item.title.trim() || 'Untitled task', prompt: current(item).prompt, promptHash: current(item).promptHash }];
        let previous = null;
        for (const part of parts) {
          const body = Model.taskBody({ ...built, instruction: part.prompt }, { projectName: record.name, itemId });
          // The snapshot records what the card got, so Origin compares and protects the approved prompt, not the raw task.
          const snapshot = await this.origin.snapshot(originId, { ...built, instruction: part.prompt, body, compose: { batchId: originId, itemId, childId: part.childId || '', versionId: item.current, promptHash: part.promptHash } }, record.revision);
          entries.push({ originTaskId: part.originTaskId, key: part.key, title: `${part.key} ${part.title}`.slice(0, 120), prompt: body, snapshotId: snapshot.id, hash: snapshot.hash,
            dependsOnTaskIds: previous ? [] : before.filter(row => row.card).map(row => row.card), dependsOnOrigin: previous ? [previous] : before.filter(row => row.origin).map(row => row.origin) });
          links.push({ itemId, childId: part.childId, snapshotId: snapshot.id, hash: snapshot.hash, originTaskId: part.originTaskId });
          previous = part.originTaskId;
        }
        lastOf.set(itemId, previous);
      }
      const results = [];
      for (let at = 0; at < entries.length; at += 100) results.push(...await this.board.createOriginTasks(destination.id, { originProjectId: originId, tasks: entries.slice(at, at + 100) }));
      const byTask = new Map(results.map(result => [result.originTaskId, result]));
      // Origin records the card of each task (a split task: its last part), so Origin itself never sends it again.
      const handoffs = ordered.map(itemId => ({ itemId, link: links.filter(row => row.itemId === itemId).at(-1) })).map(({ itemId, link }) => ({ itemId, result: byTask.get(link.originTaskId), link }))
        .filter(row => row.result?.taskId).map(row => ({ itemId: row.itemId, projectId: destination.id, taskId: row.result.taskId, snapshotId: row.result.status === 'created' ? row.link.snapshotId : '', hash: row.result.status === 'created' ? row.link.hash : '' }));
      if (handoffs.length) await this.origin.recordHandoff(originId, handoffs);
      for (const itemId of ordered) {
        const item = this.#item(batch, itemId);
        if (item.split) for (const child of item.split.children) { const result = byTask.get(child.originTaskId); if (result?.taskId) child.sent = { taskId: result.taskId, number: result.number, at: Date.now() }; }
        const last = byTask.get(links.filter(row => row.itemId === itemId).at(-1).originTaskId);
        if (last?.taskId) item.sent = { projectId: destination.id, taskId: last.taskId, number: last.number, at: Date.now(), versionId: item.current };
        await this.#saveItem(batch, item);
      }
      return { status: 200, body: { destination: { id: destination.id, name: destination.name }, results: results.map(result => ({ ...result, key: entries.find(entry => entry.originTaskId === result.originTaskId)?.key })) } };
    });
  }

  /** Stop everything: queued work is dropped, running work is cancelled and recorded as interrupted. */
  async close() {
    this.#closing = true;
    const queued = this.#queue.splice(0);
    for (const job of this.#active.values()) job.controller.abort();
    await this.#serial(async () => {
      for (const job of queued) {
        const batch = this.#cache.get(job.batchId), item = batch && structuredClone(batch.items.get(job.itemId));
        if (item?.run?.id === job.runId) { item.run = null; await this.#saveItem(batch, item).catch(() => {}); }
      }
    }).catch(() => {});
  }
}

/**
 * /api/compose/batches: list (GET) and add Origin tasks (POST). /:id: the queue (GET, `since` + `origin`
 * answer `unchanged` when nothing moved), remove the batch (DELETE); /:id/{settings,run,cancel,approve,export}
 * (POST); /:id/items/:itemId: one task (GET), change it (PATCH), remove it (DELETE); …/split (POST) accepts or
 * discards a proposed split. Every change answers with the new queue.
 */
export async function batchRoute({ batches, req, res, pathname, searchParams, jsonBody, send }) {
  const match = pathname.match(/^\/api\/compose\/batches(?:\/([A-Za-z0-9_-]{1,100})(?:\/items\/([A-Za-z0-9_-]{1,100}))?(?:\/([a-z]+))?)?$/);
  if (!match) return send(res, 404, { error: 'This batch route does not exist.' });
  const [, batchId, itemId, action] = match, method = req.method;
  const body = async () => { const value = await jsonBody(req, 4 * 1024 * 1024); if (!plain(value)) throw new BatchError('Send a JSON object.'); return value; };
  const answer = async (extra = {}) => send(res, 200, { ...extra, batch: await batches.view(batchId || extra.id) });
  if (!batchId) {
    if (method === 'GET') return send(res, 200, { batches: await batches.list() });
    if (method === 'POST') { const input = await body(); return answer({ ...await batches.add(input), id: input.originId }); }
  } else if (!itemId && !action) {
    if (method === 'GET') {
      const since = searchParams.get('since'), origin = searchParams.get('origin');
      if (since !== null && await batches.unchanged(batchId, Number(since), origin === null ? null : Number(origin), searchParams.get('instance'))) return send(res, 200, { unchanged: true });
      return send(res, 200, { batch: await batches.view(batchId) });
    }
    if (method === 'DELETE') { await batches.removeBatch(batchId); return send(res, 200, { removed: true }); }
  } else if (!itemId && method === 'POST') {
    const input = await body();
    if (action === 'settings') { await batches.configure(batchId, input); return answer(); }
    if (action === 'run') return answer(await batches.run(batchId, input));
    if (action === 'cancel') return answer(await batches.cancel(batchId, input));
    if (action === 'approve') return answer(await batches.approve(batchId, input));
    if (action === 'export') { const { status, body: result } = await batches.export(batchId, input); return status === 200 ? answer(result) : send(res, status, result); }
  } else if (itemId && !action) {
    if (method === 'GET') return send(res, 200, { item: await batches.item(batchId, itemId) });
    if (method === 'PATCH') { await batches.update(batchId, itemId, await body()); return send(res, 200, { item: await batches.item(batchId, itemId), batch: await batches.view(batchId) }); }
    if (method === 'DELETE') { await batches.remove(batchId, itemId); return answer(); }
  } else if (itemId && action === 'split' && method === 'POST') {
    await batches.decideSplit(batchId, itemId, await body());
    return send(res, 200, { item: await batches.item(batchId, itemId), batch: await batches.view(batchId) });
  }
  return send(res, 404, { error: 'This batch route does not exist.' });
}
