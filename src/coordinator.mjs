/**
 * Coordinator: a persistent, read-only observer for one project. Kanban cards stay the single source of
 * truth for task execution; the Coordinator never copies their prompts, Compose history or agent logs.
 *
 * Knowledge: a compact index per project in <dataDir>/coordinator/<project>.json.gz holding references and
 * small facts (card number, column, branch, saved-prompt and Origin links, run status, review and test
 * results, commit IDs) plus the project's timeline events, de-duplicated by their stable IDs and kept with
 * their original timestamps. It is updated deterministically from existing board, timeline and Git data,
 * only when the panel is viewed or a question is asked; there are no timers and no model calls. While the
 * Coordinator is off, nothing is updated; turning it on reconciles what happened in the meantime.
 *
 * Chat: read-only. Evidence is chosen deterministically (a card's own text only when asking about that
 * card; Origin only for design questions), then one CLI call without tools answers with references such as
 * [T12], [run:…] or [commit:…]. The same question on the same evidence is answered from the cache.
 */
import '../public/origin-model.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { buildTimeline } from './timeline.mjs';
import { escapeId } from './origin.mjs';

const Model = globalThis.PromptboardOriginModel;
const SCHEMA = 'promptboard.coordinator', CHAT_SCHEMA = 'promptboard.coordinator-chat', VERSION = 1;
const LIMITS = { events: 3000, snapshots: 200, messages: 200, cache: 50, question: 2000, cardText: 4000, lastMessage: 1500, detail: 300 };
const RECONCILE_MS = 5000; // ponytail: at most one Git read per project every 5 s while the board changes; raise if boards get huge.
const LIVE = ['queued', 'running', 'waiting_for_input'];
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const sha = text => createHash('sha256').update(text).digest('hex');
const clip = (text, max) => { const value = String(text ?? '').replace(/\s+/g, ' ').trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };

export class CoordinatorError extends Error { constructor(message, code, status = 400) { super(message); this.code = code; this.status = status; } }

export class Coordinator {
  constructor({ dataDir, board, origin = null }) {
    this.dir = join(dataDir, 'coordinator'); this.board = board; this.origin = origin;
    this.queue = Promise.resolve(); this.checked = new Map(); this.asking = new Set();
  }
  // ponytail: one queue for every project's Coordinator files; per-project queues if they ever contend.
  #serial(work) { const next = this.queue.then(work, work); this.queue = next.catch(() => {}); return next; }
  #path(projectId, kind = 'index') { if (!ID.test(projectId)) throw new CoordinatorError('Choose a valid project.', 'INVALID_PROJECT'); return join(this.dir, `${escapeId(projectId)}${kind === 'chat' ? '.chat' : ''}.json.gz`); }
  async #load(projectId, kind = 'index') {
    const fresh = kind === 'chat' ? { schema: CHAT_SCHEMA, version: VERSION, projectId, messages: [], cache: [] }
      : { schema: SCHEMA, version: VERSION, projectId, enabled: true, createdAt: Date.now(), updatedAt: null, boardRevision: null, tasks: {}, events: [], snapshots: [] };
    for (const path of [this.#path(projectId, kind), `${this.#path(projectId, kind)}.bak`]) {
      let data; try { data = JSON.parse(gunzipSync(await readFile(path)).toString('utf8')); } catch { continue; }
      if (data?.schema === fresh.schema && data.version > VERSION) throw new CoordinatorError('This Coordinator data was saved by a newer Promptboard version. Update the app; nothing was changed.', 'COORDINATOR_VERSION_UNSUPPORTED', 409);
      if (data?.schema === fresh.schema && data.version === VERSION && data.projectId === projectId) return data;
    }
    return fresh;
  }
  async #save(data, kind = 'index') {
    const path = this.#path(data.projectId, kind), tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      const handle = await open(tmp, 'wx', 0o600);
      try { await handle.writeFile(gzipSync(JSON.stringify(data))); await handle.sync(); } finally { await handle.close(); }
      try { await copyFile(path, `${path}.bak`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rename(tmp, path);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      throw new CoordinatorError('Coordinator data could not be saved. Check free disk space. Project data is unchanged.', 'COORDINATOR_WRITE_FAILED', 500);
    }
  }
  async #project(projectId) {
    const state = await this.board.state(), project = state.projects.find(item => item.id === projectId);
    if (!project) throw new CoordinatorError('This project no longer exists.', 'NOT_FOUND', 404);
    return { state, project, runs: state.runs.filter(run => run.projectId === projectId) };
  }

  /** Bring the index up to date from existing records. Deterministic; never calls a model. */
  reconcile(projectId, { force = false } = {}) {
    return this.#serial(async () => {
      const index = await this.#load(projectId);
      if (!index.enabled) return { index, added: 0, updated: 0 };
      const { state, project, runs } = await this.#project(projectId);
      const last = this.checked.get(projectId);
      if (!force && last && last.revision === state.revision && Date.now() - last.at < RECONCILE_MS * 12) return { index, added: 0, updated: 0 };
      if (!force && last && Date.now() - last.at < RECONCILE_MS) return { index, added: 0, updated: 0 };
      const columns = columnsOf(project), known = new Map(index.events.map(event => [event.id, event]));
      let added = 0, updated = 0;
      for (const event of await buildTimeline(project, runs)) {
        const compact = { id: event.id, at: event.at, kind: event.kind, task: event.taskId || null, stage: event.stage || '', title: clip(event.title, 200), status: event.status || '', detail: clip(event.detail, LIMITS.detail),
          ...(event.runId ? { run: event.runId } : {}), ...(event.commit ? { commit: event.commit } : {}), ...(event.pr?.url ? { pr: event.pr.url } : {}), ...(event.endAt ? { endAt: event.endAt } : {}) };
        const before = known.get(compact.id);
        if (!before) { known.set(compact.id, compact); added++; }
        else if (JSON.stringify(before) !== JSON.stringify(compact)) { known.set(compact.id, compact); updated++; }
      }
      index.events = [...known.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)).slice(-LIMITS.events);
      const tasks = Object.fromEntries(project.tasks.map(task => [task.id, taskFacts(task, columns, runs)]));
      const changed = Object.keys(tasks).filter(id => JSON.stringify(tasks[id]) !== JSON.stringify(index.tasks[id])).length + Object.keys(index.tasks).filter(id => !tasks[id]).length;
      index.tasks = tasks; index.boardRevision = state.revision; index.updatedAt = Date.now();
      if (added || updated || changed) index.snapshots = [...index.snapshots, { at: Date.now(), boardRevision: state.revision, added, updated, tasksChanged: changed }].slice(-LIMITS.snapshots);
      this.checked.set(projectId, { revision: state.revision, at: Date.now() });
      await this.#save(index);
      return { index, added, updated };
    });
  }

  /** What the panel shows: live status from the board plus the stored index. */
  async view(projectId) {
    const { index, added } = await this.reconcile(projectId);
    const chat = await this.#serial(() => this.#load(projectId, 'chat'));
    const base = { enabled: index.enabled, knowledge: { since: index.createdAt, updatedAt: index.updatedAt, events: index.events.length, tasks: Object.keys(index.tasks).length, snapshots: index.snapshots.length, reconciled: added },
      chat: chat.messages.slice(-30) };
    if (!index.enabled) return base;
    const { project, runs } = await this.#project(projectId);
    return { ...base, ...overview(project, runs, index) };
  }

  /** Turn coordination on or off. Knowledge, history and chat are kept either way. */
  setEnabled(projectId, enabled) {
    if (typeof enabled !== 'boolean') return Promise.reject(new CoordinatorError('Choose on or off.', 'INVALID_INPUT'));
    return this.#serial(async () => {
      const index = await this.#load(projectId);
      if (index.enabled !== enabled) { index.enabled = enabled; index.updatedAt = Date.now(); this.checked.delete(projectId); await this.#save(index); }
      return index.enabled;
    }).then(async on => { if (on) await this.reconcile(projectId, { force: true }); return this.view(projectId); });
  }

  /** A read-only answer from relevant evidence. The only place the Coordinator uses a model. */
  async ask(projectId, input, { runner, signal } = {}) {
    const question = typeof input?.question === 'string' ? input.question.trim() : '';
    if (!question || question.length > LIMITS.question) throw new CoordinatorError(`Ask a question of 1 to ${LIMITS.question} characters.`, 'INVALID_INPUT');
    const scope = scopeOf(input.scope);
    if ((await this.#serial(() => this.#load(projectId))).enabled === false) throw new CoordinatorError('Turn the Coordinator on to ask it questions. Project knowledge is kept while it is off.', 'COORDINATOR_OFF', 409);
    if (this.asking.has(projectId)) throw new CoordinatorError('The Coordinator is already answering a question for this project.', 'COORDINATOR_BUSY', 409);
    this.asking.add(projectId);
    try {
      const { index } = await this.reconcile(projectId, { force: true });
      const evidence = await this.#evidence(projectId, index, question, scope);
      const key = sha(JSON.stringify([question.toLocaleLowerCase(), scope, evidence.text]));
      const chat = await this.#serial(() => this.#load(projectId, 'chat'));
      const cached = chat.cache.find(entry => entry.key === key);
      let answer, cachedAnswer = Boolean(cached);
      if (cached) answer = cached.answer;
      else {
        const cwd = await mkdtemp(join(tmpdir(), 'pb-coordinator-'));
        try { answer = (await runner({ provider: input.provider, model: input.model || '', effort: input.effort || '', prompt: promptFor(question, scope, evidence.text), cwd, signal, timeoutMs: 180000 })).text.trim(); }
        finally { await rm(cwd, { recursive: true, force: true }).catch(() => {}); }
      }
      const refs = [...new Set([...answer.matchAll(/\[((?:T\d+|run:[A-Za-z0-9-]{4,}|commit:[0-9a-f]{7,40}))\]/g)].map(match => match[1]))].filter(ref => evidence.refs.has(ref)).map(ref => evidence.refs.get(ref));
      const now = Date.now();
      return this.#serial(async () => {
        const fresh = await this.#load(projectId, 'chat');
        fresh.messages = [...fresh.messages, { id: randomUUID(), at: now, role: 'user', text: question, scope }, { id: randomUUID(), at: now, role: 'coordinator', text: answer, refs, cached: cachedAnswer, evidence: evidence.count }].slice(-LIMITS.messages);
        if (!cachedAnswer) fresh.cache = [...fresh.cache.filter(entry => entry.key !== key), { key, answer, at: now }].slice(-LIMITS.cache);
        await this.#save(fresh, 'chat');
        return { answer, refs, cached: cachedAnswer, evidence: evidence.count, chat: fresh.messages.slice(-30) };
      });
    } finally { this.asking.delete(projectId); }
  }

  /** Deterministic evidence for one question: references and short facts, never whole histories. */
  async #evidence(projectId, index, question, scope) {
    const { state, project, runs } = await this.#project(projectId);
    const columns = columnsOf(project), byId = new Map(project.tasks.map(task => [task.id, task])), refs = new Map(), lines = [];
    const taskRef = task => { const ref = `T${task.number ?? 0}`; refs.set(ref, { ref, kind: 'task', taskId: task.id, number: task.number ?? null, title: task.title }); return ref; };
    const runRef = run => { const ref = `run:${run.id.slice(0, 8)}`; refs.set(ref, { ref, kind: 'run', runId: run.id, taskId: run.taskId }); return ref; };
    const eventLine = event => {
      const task = event.task ? byId.get(event.task) : null;
      if (event.commit && event.kind === 'commit') refs.set(`commit:${event.commit.slice(0, 7)}`, { ref: `commit:${event.commit.slice(0, 7)}`, kind: 'commit', commit: event.commit, taskId: event.task });
      const own = event.kind === 'commit' ? `[commit:${event.commit.slice(0, 7)}] ` : event.run ? `[${runRef(runs.find(run => run.id === event.run) || { id: event.run, taskId: event.task })}] ` : '';
      return `- ${new Date(event.at).toISOString()} ${own}${task ? `[${taskRef(task)}] ` : ''}${event.kind}: ${event.title}${event.status ? ` (${event.status})` : ''}${event.detail ? ` — ${event.detail}` : ''}`;
    };
    const factLine = task => {
      const facts = index.tasks[task.id] || taskFacts(task, columns, runs);
      return `- [${taskRef(task)}] “${clip(task.title, 160)}” · column ${facts.column} · ${facts.state}${facts.branch ? ` · branch ${facts.branch}` : ''}${facts.review ? ` · review ${facts.review}` : ''}${facts.tests ? ` · tests ${facts.tests}` : ''}${facts.completion ? ` · completed: ${facts.completion}` : ''}${facts.prompt ? ` · from saved prompt revision ${facts.prompt.revision}` : ''}${facts.originKey ? ` · Origin task ${facts.originKey}` : ''}`;
    };
    const over = overview(project, runs, index);
    lines.push(`Project “${project.name}”. Columns: ${over.columns.map(column => `${column.name} ${column.count}`).join(', ')}. ${over.progress.done} of ${over.progress.total} cards done.`);
    lines.push('Active agents:', ...(over.agents.length ? over.agents.map(agent => `- [${runRef(runs.find(run => run.id === agent.runId))}] on [${taskRef(byId.get(agent.taskId))}] in ${agent.column}: ${agent.status}${agent.needsYou ? ' (waiting for the user)' : ''}`) : ['- none']));
    lines.push('Blockers:', ...(over.blockers.length ? over.blockers.map(blocker => `- ${blocker.taskId ? `[${taskRef(byId.get(blocker.taskId))}] ` : ''}${blocker.text}`) : ['- none']));
    const taskEvents = taskId => index.events.filter(event => event.task === taskId);
    const detail = async task => {
      // The card is the authoritative task text; read it only when the question is about this card.
      lines.push(`Card [${taskRef(task)}] text (authoritative, first ${LIMITS.cardText} characters):`, clip(task.prompt, LIMITS.cardText) || '(no text)');
      lines.push(`Events of [${taskRef(task)}]:`, ...taskEvents(task.id).slice(-40).map(eventLine));
      const finished = runs.filter(run => run.taskId === task.id).slice(-3);
      for (const run of finished) {
        lines.push(`- [${runRef(run)}] ${run.stage} run ${run.status}${run.reason ? `: ${clip(run.reason, 200)}` : ''}${run.errorCode ? ` (${run.errorCode})` : ''} · ${run.config?.provider || ''} · turns ${run.turns ?? 0}`);
        const message = run.artifactsDir ? await readFile(join(this.board.dataDir, run.artifactsDir, 'last-message.md'), 'utf8').catch(() => '') : '';
        if (message) lines.push(`  Last agent message (excerpt): ${clip(message, LIMITS.lastMessage)}`);
      }
    };
    if (scope.kind === 'task') { const task = byId.get(scope.id) || fail('Choose a card of this project.', 'NOT_FOUND', 404); lines.push('Question scope: one card.'); await detail(task); }
    else if (scope.kind === 'agent') { const run = runs.find(item => item.id === scope.id) || fail('Choose an agent run of this project.', 'NOT_FOUND', 404); lines.push('Question scope: one agent run.'); await detail(byId.get(run.taskId)); }
    else if (scope.kind === 'branch') {
      const tasks = project.tasks.filter(task => task.workspace?.branch === scope.id);
      if (!tasks.length) fail('Choose a task branch of this project.', 'NOT_FOUND', 404);
      lines.push(`Question scope: branch ${scope.id}.`);
      for (const task of tasks) { lines.push(factLine(task)); lines.push(...taskEvents(task.id).filter(event => event.kind === 'commit' || event.kind === 'tests' || event.kind === 'review').slice(-40).map(eventLine)); }
    } else {
      // Project: the cards the question names or matches best, then the latest activity.
      const words = [...new Set(question.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) || [])];
      const named = new Set([...question.matchAll(/#(\d{1,6})\b/g)].map(match => Number(match[1])));
      const score = task => (named.has(task.number) ? 100 : 0) + words.filter(word => task.title.toLocaleLowerCase().includes(word)).length;
      const ranked = project.tasks.map(task => [score(task), task]).filter(([value]) => value > 0).sort((a, b) => b[0] - a[0]).slice(0, 8).map(([, task]) => task);
      lines.push('Cards:', ...(ranked.length ? ranked : project.tasks.slice(-15)).map(factLine));
      for (const task of ranked.slice(0, 3)) lines.push(`Events of [${taskRef(task)}]:`, ...taskEvents(task.id).slice(-8).map(eventLine));
      lines.push('Recent project activity:', ...index.events.slice(-15).map(eventLine));
      // Origin only for design questions, and only names and decisions.
      if (/architect|component|design|layer|decision|origin|stack|technolog|requirement/i.test(question)) lines.push(...await this.#origin(project));
    }
    return { text: lines.join('\n'), refs, count: lines.length };
  }
  async #origin(project) {
    if (!this.origin) return [];
    const records = await this.origin.list().catch(() => []);
    const found = records.find(entry => entry.kanbanProjectId === project.id || entry.id === project.id);
    const record = found && await this.origin.read(found.id, { report: false }).catch(() => null);
    if (!record?.blueprint) return ['Origin: this project has no Origin blueprint.'];
    const bp = record.blueprint, name = (collection, id) => Model.itemName(bp, collection, id);
    return [`Origin blueprint “${record.name}” (revision ${record.revision}):`,
      `- Layers: ${bp.layers.map(layer => layer.name).join(', ') || 'none'}`,
      `- Components: ${bp.components.map(component => `${component.name}${component.layerId ? ` (${bp.layers.find(layer => layer.id === component.layerId)?.name || ''})` : ''}`).join(', ') || 'none'}`,
      `- Accepted decisions: ${bp.decisions.filter(decision => decision.status === 'accepted').map(decision => `${name('decisions', decision.id)}: ${clip(decision.decision, 160)}`).join('; ') || 'none'}`,
      `- Requirements: ${bp.requirements.map(requirement => name('requirements', requirement.id)).slice(0, 40).join('; ') || 'none'}`];
  }
}

const fail = (message, code, status) => { throw new CoordinatorError(message, code, status); };
function scopeOf(value) {
  const kind = value?.kind ?? 'project';
  if (!['project', 'task', 'agent', 'branch'].includes(kind)) fail('Choose Project, Task, Agent or Branch.', 'INVALID_INPUT');
  if (kind === 'project') return { kind };
  if (typeof value.id !== 'string' || !value.id || value.id.length > 200 || (kind !== 'branch' && !ID.test(value.id))) fail('Choose what to ask about.', 'INVALID_INPUT');
  return { kind, id: value.id };
}
function columnsOf(project) {
  return project.workflowMode === 'pipeline' ? project.pipeline.columns.map(column => ({ id: column.id, name: column.name, role: column.role }))
    : [...new Set(['todo', 'planning', 'executing', 'code_review', 'testing', 'merge', 'done', ...(project.columnLayout || []).map(column => column.id)])]
      .map(id => ({ id, name: (project.columnLayout || []).find(column => column.id === id)?.title || { todo: 'To Do', planning: 'Planning', executing: 'Executing', code_review: 'Code Review', testing: 'Testing', merge: 'Merge', done: 'Done' }[id] || id, role: id === 'todo' ? 'todo' : id === 'done' ? 'done' : 'active' }));
}
/** Small facts and references for one card; never its prompt or logs. */
function taskFacts(task, columns, runs) {
  const own = runs.filter(run => run.taskId === task.id), live = own.filter(run => LIVE.includes(run.status)).at(-1), last = own.at(-1);
  const state = live ? (live.status === 'waiting_for_input' && !live.turnComplete ? 'agent waiting for the user' : live.status === 'waiting_for_input' ? 'agent idle after its turn' : `agent ${live.status}`)
    : last ? `last run ${last.status}` : 'no agent run yet';
  return { number: task.number ?? null, title: clip(task.title, 160), column: columns.find(column => column.id === task.column)?.name || task.column, state, revision: task.revision, contentRevision: task.contentRevision ?? 1,
    branch: task.workspace?.branch || '', review: task.evidence?.review?.verdict || '', tests: task.evidence?.tests?.status || '', completion: task.completion?.kind || '',
    prompt: task.source?.promptId ? { id: task.source.promptId, revision: task.source.promptRevision } : null, originKey: task.originSource?.key || '', lastRun: last?.id || '' };
}
function overview(project, runs, index) {
  const columns = columnsOf(project), done = columns.find(column => column.role === 'done')?.id;
  const counts = columns.map(column => ({ id: column.id, name: column.name, role: column.role, count: project.tasks.filter(task => task.column === column.id).length }));
  const tasks = new Map(project.tasks.map(task => [task.id, task]));
  const agents = runs.filter(run => LIVE.includes(run.status) && tasks.has(run.taskId)).map(run => {
    const task = tasks.get(run.taskId);
    return { runId: run.id, taskId: task.id, number: task.number ?? null, title: task.title, column: columns.find(column => column.id === task.column)?.name || task.column, status: run.status,
      needsYou: run.status === 'waiting_for_input' && !run.turnComplete, reason: clip(run.waitingReason, 200), provider: run.config?.provider || '', startedAt: run.startedAt || run.createdAt };
  });
  const blockers = [];
  for (const task of project.tasks) {
    if (task.column === done) continue;
    const own = runs.filter(run => run.taskId === task.id), last = own.at(-1), base = { taskId: task.id, number: task.number ?? null, title: task.title };
    if (last && LIVE.includes(last.status) && last.status === 'waiting_for_input' && !last.turnComplete) blockers.push({ ...base, kind: 'needs-you', runId: last.id, text: `The agent is waiting for your answer${last.waitingReason ? `: ${clip(last.waitingReason, 160)}` : ''}.` });
    else if (last && ['failed', 'interrupted'].includes(last.status)) blockers.push({ ...base, kind: 'failed', runId: last.id, text: `The agent run ${last.status}${last.reason ? `: ${clip(last.reason, 160)}` : ''}.` });
    if (task.evidence?.review?.verdict === 'changes_required') blockers.push({ ...base, kind: 'review', text: 'The review asked for changes.' });
    if (task.evidence?.tests?.status === 'failed') blockers.push({ ...base, kind: 'tests', text: 'The tests failed.' });
    if (task.automationMove?.status === 'failed') blockers.push({ ...base, kind: 'automation', text: 'A column automation failed.' });
  }
  if (project.autopilot?.status === 'paused') blockers.push({ kind: 'autopilot', text: `Autopilot is paused: ${clip(project.autopilot.reason, 200)}` });
  const numbers = new Map(project.tasks.map(task => [task.id, task.number ?? null]));
  return { columns: counts, progress: { done: counts.find(column => column.role === 'done')?.count || 0, total: project.tasks.length }, agents, blockers,
    recent: index.events.filter(event => event.kind !== 'note').slice(-8).reverse().map(event => ({ ...event, number: event.task ? numbers.get(event.task) ?? null : null, taskTitle: event.task ? tasks.get(event.task)?.title || '' : '' })) };
}
function promptFor(question, scope, evidence) {
  return [
    '# Promptboard Coordinator',
    'You answer questions about one software project for its owner. You are read-only: you cannot and must not change code, cards, branches or agents, and you must not claim that you did.',
    'Answer only from the evidence below. Cite each fact with the reference in square brackets exactly as written there, for example [T12], [run:1a2b3c4d] or [commit:abc1234]. If the evidence does not answer the question, say what is missing instead of guessing.',
    'Keep the answer short and plain: what was implemented, what changed, what failed, what remains, as the question needs.',
    `Scope: ${scope.kind}${scope.id ? ` ${scope.id}` : ''}.`,
    '', '# Evidence', evidence, '', '# Question', question,
  ].join('\n');
}

/** HTTP: GET view, PATCH { enabled }, POST /ask { question, scope, provider, model, effort }. */
export async function coordinatorRoute({ coordinator, runner, track, claim, req, res, pathname, jsonBody, send }) {
  const match = pathname.match(/^\/api\/coordinator\/([A-Za-z0-9_-]{1,100})(?:\/(ask))?$/);
  if (!match) return send(res, 404, { error: 'This Coordinator route does not exist.' });
  const [, projectId, action] = match;
  if (!action && req.method === 'GET') return send(res, 200, await coordinator.view(projectId));
  if (!action && req.method === 'PATCH') { const body = await jsonBody(req); return send(res, 200, await coordinator.setEnabled(projectId, body?.enabled)); }
  if (action === 'ask' && req.method === 'POST') {
    // A question runs one CLI call, so it shares the one-job slot with Compose, sign-in and file proposals.
    const body = await jsonBody(req), claimed = await claim('coordinator', body?.provider), { job } = claimed, abort = () => { if (!res.writableEnded) job.controller.abort(); };
    job.stage = 'coordinator';
    res.once('close', abort);
    try { return send(res, 200, await track(coordinator.ask(projectId, body || {}, { runner: call => track(runner(call)), signal: job.controller.signal }))); }
    finally { res.off('close', abort); claimed.release(); }
  }
  return send(res, 404, { error: 'This Coordinator route does not exist.' });
}
