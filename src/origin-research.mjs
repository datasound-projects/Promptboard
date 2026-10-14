// Origin Research: chats about one Origin project, run through the user's own CLI. Research is read-only: it never
// writes the blueprint. Suggestions are stored with the chat and applied only by the page, after the user approves.
import '../public/origin-model.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ORIGIN_DIR, escapeId } from './origin.mjs';
import { serial, writeAtomic } from './durable.mjs';
import { redactLocal } from './compose-local.mjs';
import { FAILURE_MESSAGES } from './providers.mjs';
import { chatPrompt, swarmPrompt } from './research-prompts.mjs';
import { SOURCE_LIMIT, citationsOf, gatherSources, sourceOf, sourcesBlock } from './research-sources.mjs';

const Model = globalThis.PromptboardOriginModel;
export const RESEARCH_DIR = 'research';
export const RESEARCH_PROVIDERS = ['claude', 'codex'];
export const MODES = ['chat', 'swarm', 'decision', 'audit'];
export const LIMITS = Object.freeze({ chats: 200, messages: 400, message: 100_000, question: 8000, title: 120, proposals: 300, sources: 12, targets: 8, search: 200 });
export const SWARM_CONCURRENCY = 3; // Independent agents at the same time; more wait in a queue.
const SCHEMA = 'promptboard.origin-research', VERSION = 1;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class ResearchError extends Error {
  constructor(message, code = 'INVALID_INPUT', status = 400) { super(message); this.code = code; this.status = status; }
}
const invalid = message => new ResearchError(message);
const text = (value, max, label, { empty = true } = {}) => {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw invalid(`${label} can have at most ${max.toLocaleString('en-US')} characters.`);
  if (!empty && !value.trim()) throw invalid(`Enter ${label.toLowerCase()}.`);
  return value;
};
const id = (value, label = 'ID') => { if (typeof value !== 'string' || !ID.test(value)) throw invalid(`Invalid ${label}.`); return value; };
export const chatId = value => { if (typeof value !== 'string' || !CHAT_ID.test(value)) throw new ResearchError('This chat does not exist.', 'NOT_FOUND', 404); return value; };

/**
 * What a research run is about. Only stable IDs: renaming a section or a question never changes a scope.
 * project | section <id> | record <collection> <id> | question <key>.
 */
export function scopeOf(value) {
  if (value === undefined || value === null) return { kind: 'project' };
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid('Choose what to research.');
  if (value.kind === 'project') return { kind: 'project' };
  if (value.kind === 'section') return { kind: 'section', id: id(value.id, 'section') };
  if (value.kind === 'record') {
    if (!Object.hasOwn(Model.LIMITS, value.collection) || ['questions', 'customSections'].includes(value.collection)) throw invalid('Choose a blueprint record to research.');
    return { kind: 'record', collection: value.collection, id: id(value.id, 'record') };
  }
  if (value.kind === 'question') {
    const key = typeof value.key === 'string' ? value.key : '';
    if (!/^(vision:[A-Za-z]{1,40}|topic:[a-z_]{1,40}:[a-z_]{1,40}|question:[A-Za-z0-9_-]{1,100}|component:[A-Za-z0-9_-]{1,100}:[A-Za-z0-9_-]{1,100})$/.test(key)) throw invalid('Choose a question to research.');
    return { kind: 'question', key };
  }
  throw invalid('Choose what to research.');
}

/** The run settings the page sends with each message. Only Claude Code and Codex can research for now. */
export function settingsOf(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Send research settings.');
  if (!RESEARCH_PROVIDERS.includes(value.provider)) throw invalid('Research uses Claude Code or Codex. Choose one of them.');
  const model = value.model ?? '', effort = value.effort ?? '';
  if (typeof model !== 'string' || (model && !/^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,99}$/.test(model))) throw invalid('Use a model ID or alias with no spaces.');
  if (typeof effort !== 'string' || !/^[a-z]{0,10}$/.test(effort)) throw invalid('Choose a supported effort level.');
  const mode = value.mode ?? 'chat';
  if (!MODES.includes(mode)) throw invalid('Choose Chat, Swarm, Decision Lab or Blueprint Audit.');
  // CLI skills: Claude Code's own installed skills, as instructions only (no shell, so their scripts cannot run).
  const targets = mode === 'swarm' ? (Array.isArray(value.targets) ? value.targets : []).map(scopeOf) : [];
  if (mode === 'swarm' && (!targets.length || targets.length > LIMITS.targets)) throw invalid(`Choose 1 to ${LIMITS.targets} parts for the swarm to research.`);
  if (new Set(targets.map(target => JSON.stringify(target))).size !== targets.length) throw invalid('Choose each part only once.');
  return { provider: value.provider, model, effort, mode, web: value.web === true, skills: value.provider === 'claude' && value.skills === true, scope: scopeOf(value.scope), ...(mode === 'swarm' ? { targets } : {}) };
}

const emptyChat = (originId, settings) => {
  const now = Date.now();
  return { schema: SCHEMA, version: VERSION, id: randomUUID(), originId, title: '', createdAt: now, updatedAt: now, settings, native: null, sources: [], messages: [], proposals: [] };
};
/** A short, readable summary for the history list. */
export const summary = chat => ({ id: chat.id, title: chat.title || 'New research', createdAt: chat.createdAt, updatedAt: chat.updatedAt, mode: chat.settings?.mode || 'chat',
  provider: chat.settings?.provider || '', messages: chat.messages.length, pending: chat.proposals.filter(proposal => proposal.status === 'pending').length });

/** Research chats, one file per chat, beside the Origin project files. Every change is atomic and serialized. */
export class ResearchStore {
  constructor(dataDir) {
    this.dir = join(dataDir, ORIGIN_DIR, RESEARCH_DIR);
    this.queues = new Map();
  }
  #folder(originId) { return join(this.dir, escapeId(id(originId, 'project'))); }
  /** “Delete from Origin”: running research of the project stops; its chats move to origin/deleted/, as Project Context does. */
  async archive(originId) {
    const own = () => [...activeRuns].filter(([key]) => key.startsWith(`${originId}/`));
    for (const [, control] of own()) control.stopAll();
    for (let wait = 0; own().length && wait < 100; wait++) await new Promise(resolve => setTimeout(resolve, 50)); // A stopped run saves what it produced first.
    return this.#serial(originId, async () => {
      const folder = this.#folder(originId);
      try { await stat(folder); } catch { return false; }
      const deleted = join(this.dir, '..', 'deleted');
      await mkdir(deleted, { recursive: true, mode: 0o700 });
      await rename(folder, join(deleted, `research-${escapeId(originId)}.deleted-${Date.now()}`));
      return true;
    });
  }
  /** The empty working folder of a project's research runs. CLI sessions are tied to it, so it never changes. */
  async workspace(originId) { const path = join(this.#folder(originId), 'workspace'); await mkdir(path, { recursive: true, mode: 0o700 }); return path; }
  #file(originId, chat) { return join(this.#folder(originId), `${escapeId(chatId(chat))}.json`); }
  #serial(originId, work) {
    if (!this.queues.has(originId)) this.queues.set(originId, serial());
    return this.queues.get(originId)(work);
  }
  async #read(originId, chat) {
    let value;
    try { value = JSON.parse(await readFile(this.#file(originId, chat), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) throw new ResearchError('This chat does not exist.', 'NOT_FOUND', 404); throw error; }
    if (value?.schema !== SCHEMA || value.version !== VERSION || value.id !== chat || value.originId !== originId) throw new ResearchError('This chat does not exist.', 'NOT_FOUND', 404);
    return value;
  }
  async #write(chat) {
    await mkdir(this.#folder(chat.originId), { recursive: true, mode: 0o700 });
    await writeAtomic(this.#file(chat.originId, chat.id), JSON.stringify(chat), { backup: false });
    return chat;
  }
  async #all(originId) {
    let names;
    try { names = await readdir(this.#folder(originId)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const chats = [];
    for (const name of names) {
      // File names are escaped chat IDs (lowercase hex and dashes need no escaping).
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
      try { chats.push(await this.#read(originId, name.slice(0, -5))); } catch {}
    }
    return chats.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  list(originId, { query = '' } = {}) {
    const words = text(query, LIMITS.search, 'Search').toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return this.#serial(originId, async () => (await this.#all(originId))
      .filter(chat => !words.length || words.every(word => `${chat.title}\n${chat.messages.map(message => message.text).join('\n')}`.toLocaleLowerCase().includes(word)))
      .map(summary));
  }
  read(originId, chat) { return this.#serial(originId, () => this.#read(originId, chatId(chat))); }
  create(originId, settings) {
    return this.#serial(originId, async () => {
      if ((await this.#all(originId)).length >= LIMITS.chats) throw new ResearchError(`A project can keep at most ${LIMITS.chats} research chats. Delete old chats first.`, 'LIMIT', 409);
      return this.#write(emptyChat(id(originId, 'project'), settingsOf(settings)));
    });
  }
  /** Change one chat under the queue. `change` mutates the chat; the file is replaced atomically. */
  update(originId, chat, change) {
    return this.#serial(originId, async () => {
      const value = await this.#read(originId, chatId(chat));
      await change(value);
      value.messages = value.messages.slice(-LIMITS.messages);
      value.proposals = value.proposals.slice(-LIMITS.proposals);
      value.updatedAt = Date.now();
      return this.#write(value);
    });
  }
  remove(originId, chat) {
    return this.#serial(originId, async () => {
      await this.#read(originId, chatId(chat));
      await rm(this.#file(originId, chat), { force: true });
      return { removed: true };
    });
  }
}

const sha = text => createHash('sha256').update(text).digest('hex');
const titleFrom = text => { const line = text.trim().split('\n')[0].replace(/\s+/g, ' '); return line.length > 60 ? `${line.slice(0, 59)}…` : line; };
/** A message the page can show. Provider details stay on the server; only fixed messages leave it. */
export function publicError(error) {
  if (error instanceof ResearchError) return { code: error.code, message: error.message };
  if (typeof error?.code === 'string' && Object.hasOwn(FAILURE_MESSAGES, error.code)) return { code: error.code, message: FAILURE_MESSAGES[error.code] };
  if (error?.code === 'NOT_INSTALLED' || error?.code === 'OUTPUT_LIMIT' || error?.code === 'INVALID_OUTPUT' || error?.code === 'SPAWN_FAILED') return { code: error.code, message: error.message };
  return { code: 'RESEARCH_FAILED', message: 'Research failed. The blueprint is unchanged; try again.' };
}
/** Earlier turns for a CLI without a resumable session: the newest that fit, oldest first. */
export function boundedHistory(messages, budget = 16_000) {
  const picked = [];
  let used = 0;
  for (const message of [...messages].reverse()) {
    if (!['user', 'assistant'].includes(message.role) || !message.text) continue;
    const text = message.text.length > 4000 ? `${message.text.slice(0, 3999)}…` : message.text;
    if (used + text.length > budget) break;
    used += text.length; picked.unshift({ role: message.role, text });
  }
  return picked;
}
/**
 * Read-only context for one scope of the saved blueprint (see researchContext in origin-model.js), with
 * recognizable secrets removed. `missing` is true when the chosen part no longer exists.
 */
export function researchContext(record, scope, { limit = 24000 } = {}) {
  const built = Model.researchContext(record.blueprint, scope, { projectName: record.name, limit });
  return { ...built, text: redactLocal(built.text), missing: scope.kind !== 'project' && built.label === 'the whole project' };
}

/** Web pages and attached sources the answer cites. Web citations carry the research date as their access date. */
export function citations(text, evidence = []) {
  const today = new Date().toISOString().slice(0, 10), found = new Map();
  for (const match of text.matchAll(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,2000})\)|(?<![(\w])(https?:\/\/[^\s)<>\]]{4,2000})/g)) {
    const url = (match[2] || match[3]).replace(/[.,;:]+$/, '');
    if (!found.has(url)) found.set(url, { title: (match[1] || url).slice(0, 200), url, accessedAt: today });
  }
  return [...citationsOf(evidence, text), ...[...found.values()].slice(0, 40)];
}

/** The suggestions block at the end of an answer, if any, and the answer without it. */
export function extractSuggestions(text) {
  const match = [...text.matchAll(/```(?:origin-suggestions|json)\s*\n([\s\S]*?)\n```\s*$/g)].at(-1) || [...text.matchAll(/```origin-suggestions\s*\n([\s\S]*?)(?:\n```|$)/g)].at(-1);
  if (!match) return { text, raw: [] };
  let parsed;
  try { parsed = JSON.parse(match[1]); } catch { return { text: text.slice(0, match.index).trimEnd(), raw: [], unreadable: true }; }
  const raw = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.suggestions) ? parsed.suggestions : null;
  if (!raw) return { text, raw: [] };
  return { text: text.slice(0, match.index).trimEnd(), raw: raw.slice(0, 40) };
}
/**
 * Suggestions checked against the saved blueprint. Each keeps the value it would replace and the blueprint revision,
 * so the page can refuse to overwrite a field that changed since. Invalid suggestions are dropped and counted.
 */
export function proposalsFor(record, raw, { messageId, agent = null }) {
  const proposals = [];
  let dropped = 0;
  // References between new records are local to one answer: prefix them so two agents' "@n1" never meet.
  const scope = messageId.slice(0, 8), local = value => `${scope}.${value}`;
  const scoped = raw.map(entry => {
    if (!entry || typeof entry !== 'object') return entry;
    const copy = { ...entry, ...(typeof entry.ref === 'string' ? { ref: local(entry.ref) } : {}) };
    const relink = given => (typeof given === 'string' && given.startsWith('@') ? `@${local(given.slice(1))}` : Array.isArray(given) ? given.map(relink) : given);
    if (copy.value && typeof copy.value === 'object' && !Array.isArray(copy.value)) copy.value = Object.fromEntries(Object.entries(copy.value).map(([key, given]) => [key, relink(given)]));
    else copy.value = relink(copy.value);
    return copy;
  });
  const refs = new Map(scoped.filter(entry => entry?.target?.kind === 'add' && typeof entry.ref === 'string').map(entry => [entry.ref, entry.target.collection]));
  for (const entry of scoped) {
    try {
      const valid = Model.validateResearchSuggestion(record.blueprint, entry, { refs });
      if (proposals.some(other => other.key === valid.key && JSON.stringify(other.value) === JSON.stringify(valid.value))) continue;
      proposals.push({ id: randomUUID(), messageId, ...valid, baseRevision: record.revision, status: 'pending', updatedAt: Date.now(), ...(agent ? { agent } : {}) });
    } catch { dropped++; }
  }
  return { proposals: proposals.slice(0, 40), dropped };
}
/** Swarm results reviewed together: the same change from several agents once; different values for one field marked. */
export function mergeProposals(proposals) {
  const merged = [];
  for (const proposal of proposals) {
    const same = merged.find(other => other.key === proposal.key && proposal.op === 'set' && JSON.stringify(other.value) === JSON.stringify(proposal.value));
    if (same) { same.alsoFrom = [...new Set([...(same.alsoFrom || []), proposal.agent?.label].filter(Boolean))]; continue; }
    merged.push({ ...proposal });
  }
  for (const proposal of merged) if (proposal.op === 'set' && merged.some(other => other !== proposal && other.op === 'set' && other.key === proposal.key)) proposal.disagree = true;
  return merged;
}

/**
 * One Chat turn: store the question, stream the CLI's answer as events, store the answer. A resumed CLI session
 * gets only the new question (and the context again when it changed). When a session cannot continue, one new
 * session starts with this chat's bounded history. A stopped run keeps the text it produced.
 */
export async function runChat({ research, origin, originId, chat, settings, question, runner, signal, emit, sources: services = {} }) {
  const record = await origin.read(originId, { report: false });
  if (!record || record.damaged) throw new ResearchError('This Origin project no longer exists. Choose another project.', 'NOT_FOUND', 404);
  const saved = await research.read(originId, chat);
  const context = researchContext(record, settings.scope), contextHash = sha(`${JSON.stringify(settings.scope)}\n${context.text}`);
  const native = saved.native?.provider === settings.provider && saved.native.sessionId ? saved.native : null;
  // Attached sources: passages relevant to this question only, as cited data.
  const found = await gatherSources(saved.sources, `${question} ${context.label}`.trim(), { ...services, signal });
  const block = sourcesBlock(found.evidence);
  const mode = settings.mode, lastMode = [...saved.messages].reverse().find(message => message.role === 'assistant')?.mode;
  const fresh = () => chatPrompt({ question, context: context.text, history: boundedHistory(saved.messages), web: settings.web, scopeLabel: context.label, sources: block, mode });
  const prompt = native ? chatPrompt({ question, context: native.contextHash === contextHash ? null : context.text, followUp: true, scopeLabel: context.label, sources: block, mode, modeChanged: lastMode !== mode }) : fresh();
  const asked = { id: randomUUID(), role: 'user', text: question || { decision: 'Compare the options for this part.', audit: 'Audit this part of the blueprint.' }[mode], at: Date.now(), mode, scope: settings.scope };
  await research.update(originId, chat, value => { value.messages.push(asked); value.settings = settings; if (!value.title) value.title = titleFrom(question); });
  emit({ type: 'message', message: asked });
  emit({ type: 'start', mode, agents: [{ id: 'main', label: '' }] });
  if (context.missing) emit({ type: 'activity', agent: 'main', kind: 'note', label: 'The selected part no longer exists. The whole project is used.' });
  for (const warning of found.warnings) emit({ type: 'activity', agent: 'main', kind: 'note', label: warning });
  if (found.evidence.length) emit({ type: 'activity', agent: 'main', kind: 'sources', label: `${found.evidence.length} passages from attached sources` });
  const workspace = await research.workspace(originId), started = Date.now();
  const onEvent = event => emit({ ...event, agent: 'main' });
  const call = (input, session) => runner({ provider: settings.provider, model: settings.model, effort: settings.effort, web: settings.web, tools: settings.skills ? ['Skill'] : [], cwd: workspace, signal, onEvent, prompt: input, session });
  const newSession = () => (settings.provider === 'claude' ? { id: randomUUID(), resume: false } : null);
  let result, failure;
  try { result = await call(prompt, native ? { id: native.sessionId, resume: true } : newSession()); }
  catch (error) {
    failure = error;
    if (error.resumeFailed && !signal?.aborted) {
      onEvent({ type: 'activity', kind: 'note', label: 'The earlier CLI session could not continue. A new session starts with this chat’s history.' });
      try { result = await call(fresh(), newSession()); failure = null; } catch (again) { failure = again; }
    }
  }
  const stopped = failure?.code === 'ABORTED', answerId = randomUUID();
  const extracted = extractSuggestions(result?.text ?? failure?.partial ?? '');
  const { proposals, dropped } = result ? proposalsFor(record, extracted.raw, { messageId: answerId }) : { proposals: [], dropped: 0 };
  const warnings = [...found.warnings, ...(dropped ? [`${dropped} suggestion${dropped === 1 ? ' was' : 's were'} left out because ${dropped === 1 ? 'it' : 'they'} did not match this blueprint.`] : []),
    ...(extracted.unreadable ? ['The suggestions block could not be read, so no suggestions are shown.'] : [])];
  const answer = { id: answerId, role: 'assistant', at: Date.now(), mode, provider: settings.provider, model: settings.model, durationMs: Date.now() - started,
    text: extracted.text, status: result ? 'done' : stopped ? 'stopped' : 'failed', ...(failure && !stopped ? { error: publicError(failure) } : {}),
    citations: citations(extracted.text, found.evidence), ...(warnings.length ? { warnings: warnings.slice(0, 12) } : {}) };
  const updated = await research.update(originId, chat, value => {
    value.messages.push(answer);
    value.proposals.push(...proposals);
    if (result?.session) value.native = { provider: settings.provider, sessionId: result.session, contextHash };
    else if (failure?.resumeFailed) value.native = null;
  });
  emit({ type: 'message', message: answer });
  if (proposals.length) emit({ type: 'proposals', proposals });
  emit({ type: 'done', chat: updated });
  return updated;
}

// Runs in progress, per chat: a way to stop one swarm agent while the others continue.
const activeRuns = new Map();

/**
 * Swarm: one independent agent per selected part, at most SWARM_CONCURRENCY at the same time. Each agent gets only its
 * own part's context, the project's constraints and the sources relevant to its own question; never another agent's
 * results. A failed or stopped agent does not discard the others. When all have finished, one summary is stored.
 */
export async function runSwarm({ research, origin, originId, chat, settings, question, runner, signal, emit, sources: services = {}, control = {} }) {
  const record = await origin.read(originId, { report: false });
  if (!record || record.damaged) throw new ResearchError('This Origin project no longer exists. Choose another project.', 'NOT_FOUND', 404);
  const saved = await research.read(originId, chat);
  // Each agent is named as the picker names its part (the project's own words), without the phase prefix.
  const names = new Map(Model.researchTargets(record.blueprint).map(option => [JSON.stringify(option.value), option.label.replace(/^[^›]*› /, '')]));
  const agents = settings.targets.map((target, index) => {
    const context = researchContext(record, target, { limit: 16000 });
    return { id: `a${index + 1}`, target, context, label: (names.get(JSON.stringify(target)) || context.label).slice(0, 120), controller: new AbortController(), status: 'queued' };
  });
  const asked = { id: randomUUID(), role: 'user', text: question || `Research ${agents.length} parts in parallel.`, at: Date.now(), mode: 'swarm', scope: settings.scope, targets: settings.targets };
  await research.update(originId, chat, value => { value.messages.push(asked); value.settings = settings; if (!value.title) value.title = titleFrom(question || `Swarm: ${agents.map(agent => agent.label).join(', ')}`); });
  emit({ type: 'message', message: asked });
  emit({ type: 'start', mode: 'swarm', agents: agents.map(agent => ({ id: agent.id, label: agent.label, status: 'queued' })) });
  control.stop = id => { const agent = agents.find(entry => entry.id === id); if (agent && ['queued', 'running'].includes(agent.status)) { agent.controller.abort(); return true; } return false; };
  const stopAll = () => { for (const agent of agents) agent.controller.abort(); };
  signal?.addEventListener('abort', stopAll, { once: true });
  const workspace = await research.workspace(originId), results = [], collected = [];
  const work = async agent => {
    if (agent.controller.signal.aborted || signal?.aborted) { agent.status = 'stopped'; emit({ type: 'agent', agent: agent.id, status: 'stopped' }); return; }
    agent.status = 'running'; emit({ type: 'agent', agent: agent.id, status: 'running' });
    const started = Date.now(), onEvent = event => emit({ ...event, agent: agent.id });
    if (agent.context.missing) onEvent({ type: 'activity', kind: 'note', label: 'This part no longer exists. The whole project is used.' });
    let found = { evidence: [], warnings: [] }, result, failure;
    try {
      found = await gatherSources(saved.sources, `${question} ${agent.context.label}`.trim(), { ...services, signal: agent.controller.signal });
      for (const warning of found.warnings) onEvent({ type: 'activity', kind: 'note', label: warning });
      result = await runner({ provider: settings.provider, model: settings.model, effort: settings.effort, web: settings.web, tools: settings.skills ? ['Skill'] : [], persist: false, session: null,
        cwd: workspace, signal: agent.controller.signal, onEvent, prompt: swarmPrompt({ request: question, context: agent.context.text, web: settings.web, targetLabel: agent.context.label, sources: sourcesBlock(found.evidence) }) });
    } catch (error) { failure = error; }
    const stopped = failure?.code === 'ABORTED' || (failure && agent.controller.signal.aborted);
    agent.status = result ? 'done' : stopped ? 'stopped' : 'failed';
    const messageId = randomUUID(), extracted = extractSuggestions(result?.text ?? failure?.partial ?? '');
    const own = result ? proposalsFor(record, extracted.raw, { messageId, agent: { id: agent.id, label: agent.label } }) : { proposals: [], dropped: 0 };
    collected.push(...own.proposals);
    const message = { id: messageId, role: 'agent', at: Date.now(), mode: 'swarm', provider: settings.provider, model: settings.model, durationMs: Date.now() - started,
      agent: { id: agent.id, label: agent.label, target: agent.target }, text: extracted.text, status: agent.status,
      ...(failure && !stopped ? { error: publicError(failure) } : {}), citations: citations(extracted.text, found.evidence),
      ...(own.dropped ? { warnings: [`${own.dropped} suggestion${own.dropped === 1 ? ' was' : 's were'} left out because ${own.dropped === 1 ? 'it' : 'they'} did not match this blueprint.`] } : {}) };
    results.push(message);
    await research.update(originId, chat, value => { value.messages.push(message); });
    emit({ type: 'agent', agent: agent.id, status: agent.status, ...(message.error ? { error: message.error } : {}) });
    emit({ type: 'message', message });
  };
  try {
    // A bounded pool: each worker takes the next queued agent.
    const queue = [...agents];
    await Promise.all(Array.from({ length: Math.min(SWARM_CONCURRENCY, agents.length) }, async () => { for (let agent = queue.shift(); agent; agent = queue.shift()) await work(agent); }));
  } finally { control.stop = () => false; signal?.removeEventListener('abort', stopAll); }
  // The combined result: built from the finished work only, with no extra model call.
  const done = agents.filter(agent => agent.status === 'done').length, mark = { done: '✓', failed: '✗', stopped: '■' };
  const summary = { id: randomUUID(), role: 'assistant', at: Date.now(), mode: 'swarm', provider: settings.provider, model: settings.model, status: 'done', summary: true,
    text: [`## Swarm summary`, `${done} of ${agents.length} agents finished.`, '', ...agents.map(agent => {
      const message = results.find(entry => entry.agent.id === agent.id);
      return `- ${mark[agent.status] || '•'} **${agent.label}**: ${agent.status === 'done' ? 'finished' : agent.status === 'stopped' ? 'stopped' : `failed (${message?.error?.message || 'no reason'})`}`;
    }), '', 'Each agent researched its part on its own. Read their findings above; suggestions from every agent are reviewed together.'].join('\n') };
  // Suggestions are combined only after every agent has finished: duplicates once, disagreements marked.
  const proposals = mergeProposals(collected), disagreements = new Set(proposals.filter(proposal => proposal.disagree).map(proposal => proposal.key)).size;
  if (proposals.length) summary.text += `\n\n${proposals.length} suggestion${proposals.length === 1 ? '' : 's'} to review${disagreements ? `; agents disagree on ${disagreements} field${disagreements === 1 ? '' : 's'}` : ''}.`;
  const updated = await research.update(originId, chat, value => { value.messages.push(summary); value.proposals.push(...proposals); });
  emit({ type: 'message', message: summary });
  if (proposals.length) emit({ type: 'proposals', proposals });
  emit({ type: 'done', chat: updated });
  return updated;
}

/**
 * HTTP for chats. GET/POST /api/origin/research/:origin/chats, GET/PATCH/DELETE …/chats/:chat, and
 * POST …/chats/:chat/run, which streams NDJSON events while the CLI works. A run uses the shared one-job slot,
 * so it never overlaps Compose, the Coordinator or a sign-in change. Closing the request stops the run.
 */
export async function researchRoute({ research, origin, runner, claim, track, sources: services, req, res, pathname, searchParams, jsonBody, send }) {
  const match = pathname.match(/^\/api\/origin\/research\/([A-Za-z0-9_-]{1,100})\/chats(?:\/([0-9a-f-]{36})(?:\/(run|stop|sources|agents|proposals)(?:\/([0-9a-f-]{36}|a[0-9]{1,2})(?:\/(stop))?)?)?)?$/);
  if (!match) return send(res, 404, { error: 'This research route does not exist.' });
  const [, originId, chat, action, sourceId, verb] = match;
  // The Origin project must exist; this also rejects IDs that are not projects.
  const project = await origin.read(originId, { report: false });
  if (!project || project.damaged) throw new ResearchError('This Origin project no longer exists. Choose another project.', 'NOT_FOUND', 404);
  const body = async () => {
    const value = await jsonBody(req, 64 * 1024);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Send a JSON object.');
    return value;
  };
  if (action === 'run' && req.method === 'POST') {
    const input = await body();
    const settings = settingsOf(input.settings);
    const question = text(input.text, LIMITS.question, 'A question', { empty: settings.mode !== 'chat' }).trim();
    await research.read(originId, chat); // A missing chat is reported before the job slot is taken.
    const claimed = await claim('research', settings.provider), { job } = claimed;
    job.stage = `research-${settings.mode}`;
    const abort = () => { if (!res.writableEnded) job.controller.abort(); };
    res.once('close', abort); if (res.destroyed) job.controller.abort();
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const emit = event => { if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(event)}\n`); };
    const ping = setInterval(() => emit({ ping: true }), 15000); ping.unref();
    const run = settings.mode === 'swarm' ? runSwarm : runChat, key = `${originId}/${chat}`;
    // Stop through the server: the run ends, stores what it produced and the stream reports it before closing.
    const control = { stopAll: () => job.controller.abort(), stop: () => false };
    activeRuns.set(key, control);
    try { await track(run({ research, origin, originId, chat, settings, question, runner, signal: job.controller.signal, emit, sources: await services?.(), control })); }
    catch (error) { emit({ type: 'error', ...publicError(error) }); }
    finally { if (activeRuns.get(key) === control) activeRuns.delete(key); clearInterval(ping); res.off('close', abort); if (!res.writableEnded) res.end(); claimed.release(); }
    return;
  }
  if (action === 'stop' && !sourceId && req.method === 'POST') {
    const control = activeRuns.get(`${originId}/${chat}`);
    if (!control) return send(res, 409, { error: 'Nothing is running in this chat.', code: 'NOT_RUNNING' });
    control.stopAll();
    return send(res, 200, { stopped: true });
  }
  if (action === 'agents' && verb === 'stop' && req.method === 'POST') {
    // Stop one swarm agent; the others continue.
    const stopped = activeRuns.get(`${originId}/${chat}`)?.stop(sourceId) || false;
    return send(res, stopped ? 200 : 409, stopped ? { stopped: true } : { error: 'This agent is not running.', code: 'NOT_RUNNING' });
  }
  if (action === 'proposals' && sourceId && req.method === 'PATCH') {
    // The page records what the person did with a suggestion. Applying happens in the page, through Origin's own
    // revision-checked save; this only keeps the review state with the chat.
    const input = await body();
    if (!['applied', 'rejected', 'pending', 'conflict'].includes(input.status)) throw invalid('Send applied, rejected, pending or conflict.');
    const updated = await research.update(originId, chat, value => {
      const proposal = value.proposals.find(entry => entry.id === sourceId);
      if (!proposal) throw new ResearchError('This suggestion is not in the chat.', 'NOT_FOUND', 404);
      proposal.status = input.status; proposal.updatedAt = Date.now();
      if (input.status === 'applied') {
        proposal.appliedAt = Date.now();
        if (Number.isSafeInteger(input.revision)) proposal.appliedRevision = input.revision;
        if (input.edited === true) proposal.edited = true;
        // The new record's ID: later suggestions that reference it (@ref) resolve to it.
        if (typeof input.createdId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(input.createdId)) proposal.createdId = input.createdId;
      }
    });
    return send(res, 200, { proposals: updated.proposals });
  }
  if (action === 'sources') {
    // Add: documents must be loaded, Base resources usable, MCP servers reachable with an eligible read-only tool.
    if (!sourceId && req.method === 'POST') {
      const tools = await services?.();
      let input = (await body()).source;
      // A Base MCP server is used only while it is enabled and trusted; its connection is mapped to Compose's form.
      if (input?.type === 'mcp' && typeof input.resourceId === 'string') {
        const resource = (await tools.base.list()).resources.find(entry => entry.id === input.resourceId);
        if (!resource || resource.kind !== 'mcp' || !resource.enabled || resource.trust !== 'trusted') throw new ResearchError('Choose an enabled, trusted Base MCP server.', 'INVALID_SOURCE');
        const config = resource.configuration || {}, refs = map => (map && Object.keys(map).length ? { ...map } : undefined);
        input = { type: 'mcp', config: config.transport === 'streamable-http' ? { type: 'mcp', name: resource.name.slice(0, 80), transport: 'streamable-http', endpoint: config.endpoint, ...(refs(config.headers) ? { headers: refs(config.headers) } : {}) }
          : { type: 'mcp', name: resource.name.slice(0, 80), transport: 'stdio', command: config.command, args: config.args || [], ...(refs(config.env) ? { env: refs(config.env) } : {}), allowStart: true } };
      }
      const source = sourceOf(input);
      const current = await research.read(originId, chat);
      if (current.sources.length >= SOURCE_LIMIT) throw new ResearchError(`A chat can have at most ${SOURCE_LIMIT} sources. Remove one first.`, 'LIMIT', 409);
      if (source.type === 'document') { try { if (!tools.documents.get(source.documentId)) throw new Error(); } catch { throw new ResearchError('This document is no longer loaded. Attach it again.', 'INVALID_SOURCE'); } }
      if (source.type === 'base') {
        const resource = (await tools.base.list()).resources.find(entry => entry.id === source.resourceId);
        if (!resource || !resource.enabled || resource.trust !== 'trusted' || !['knowledge', 'context', 'skill'].includes(resource.kind)) throw new ResearchError('Choose an enabled, trusted Base knowledge, context or skill resource.', 'INVALID_SOURCE');
      }
      if (source.type === 'mcp') {
        // Discovery connects to the server (a local program starts only with explicit permission). It shares the one-job slot.
        const claimed = await claim('research-source', null);
        try { source.tools = (await track(tools.mcp.retrieve(source.config, [], { discoveryOnly: true, signal: claimed.job.controller.signal }))).tools; }
        catch (error) { throw new ResearchError(error instanceof ResearchError ? error.message : (error.message || 'The MCP server is not available.').slice(0, 300), 'INVALID_SOURCE'); }
        finally { claimed.release(); }
        if (!source.tools.length) throw new ResearchError('This MCP server has no read-only retrieval tool, so research cannot use it.', 'INVALID_SOURCE');
      }
      const updated = await research.update(originId, chat, value => { value.sources.push(source); });
      return send(res, 200, { source, sources: updated.sources });
    }
    if (sourceId && req.method === 'PATCH') {
      const input = await body();
      if (typeof input.enabled !== 'boolean') throw invalid('Send enabled: true or false.');
      const updated = await research.update(originId, chat, value => { const source = value.sources.find(entry => entry.id === sourceId); if (!source) throw new ResearchError('This source is not in the chat.', 'NOT_FOUND', 404); source.enabled = input.enabled; });
      return send(res, 200, { sources: updated.sources });
    }
    if (sourceId && req.method === 'DELETE') {
      const updated = await research.update(originId, chat, value => { const before = value.sources.length; value.sources = value.sources.filter(entry => entry.id !== sourceId); if (value.sources.length === before) throw new ResearchError('This source is not in the chat.', 'NOT_FOUND', 404); });
      return send(res, 200, { sources: updated.sources });
    }
    return send(res, 404, { error: 'This research route does not exist.' });
  }
  if (!chat && req.method === 'GET') return send(res, 200, { chats: await research.list(originId, { query: searchParams?.get('q') || '' }) });
  if (!chat && req.method === 'POST') return send(res, 200, { chat: await research.create(originId, (await body()).settings) });
  if (action) return send(res, 404, { error: 'This research route does not exist.' });
  if (chat && req.method === 'GET') return send(res, 200, { chat: await research.read(originId, chat) });
  if (chat && req.method === 'PATCH') {
    const input = await body();
    const title = text(input.title, LIMITS.title, 'A title').trim();
    return send(res, 200, { chat: summary(await research.update(originId, chat, value => { value.title = title; })) });
  }
  if (chat && req.method === 'DELETE') return send(res, 200, await research.remove(originId, chat));
  return send(res, 404, { error: 'This research route does not exist.' });
}
