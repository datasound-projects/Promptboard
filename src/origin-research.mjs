// Origin Research: chats about one Origin project, run through the user's own CLI. Research is read-only: it never
// writes the blueprint. Suggestions are stored with the chat and applied only by the page, after the user approves.
import '../public/origin-model.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ORIGIN_DIR, escapeId } from './origin.mjs';
import { serial, writeAtomic } from './durable.mjs';
import { redactLocal } from './compose-local.mjs';
import { FAILURE_MESSAGES } from './providers.mjs';
import { chatPrompt } from './research-prompts.mjs';

const Model = globalThis.PromptboardOriginModel;
export const RESEARCH_DIR = 'research';
export const RESEARCH_PROVIDERS = ['claude', 'codex'];
export const MODES = ['chat', 'swarm', 'decision', 'audit'];
export const LIMITS = Object.freeze({ chats: 200, messages: 400, message: 100_000, question: 8000, title: 120, proposals: 300, sources: 12, targets: 8, search: 200 });
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
  return { provider: value.provider, model, effort, mode, web: value.web === true, scope: scopeOf(value.scope) };
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
/** Read-only context for one scope of the saved blueprint, with recognizable secrets removed. */
function researchContext(record, scope) {
  const blueprint = record.blueprint, vision = blueprint.vision || {};
  const text = [`Project: ${record.name}`, blueprint.idea && `Idea: ${blueprint.idea}`, ...Model.VISION.filter(key => vision[key]).map(key => `${Model.VISION_QUESTIONS[key]} ${vision[key]}`)].filter(Boolean).join('\n');
  return { text: redactLocal(text), label: 'the whole project', scope };
}

/**
 * One Chat turn: store the question, stream the CLI's answer as events, store the answer. A resumed CLI session
 * gets only the new question (and the context again when it changed). When a session cannot continue, one new
 * session starts with this chat's bounded history. A stopped run keeps the text it produced.
 */
export async function runChat({ research, origin, originId, chat, settings, question, runner, signal, emit }) {
  const record = await origin.read(originId, { report: false });
  if (!record || record.damaged) throw new ResearchError('This Origin project no longer exists. Choose another project.', 'NOT_FOUND', 404);
  const saved = await research.read(originId, chat);
  const context = researchContext(record, settings.scope), contextHash = sha(`${JSON.stringify(settings.scope)}\n${context.text}`);
  const native = saved.native?.provider === settings.provider && saved.native.sessionId ? saved.native : null;
  const fresh = () => chatPrompt({ question, context: context.text, history: boundedHistory(saved.messages), web: settings.web, scopeLabel: context.label });
  const prompt = native ? chatPrompt({ question, context: native.contextHash === contextHash ? null : context.text, followUp: true, scopeLabel: context.label }) : fresh();
  const asked = { id: randomUUID(), role: 'user', text: question, at: Date.now(), mode: 'chat', scope: settings.scope };
  await research.update(originId, chat, value => { value.messages.push(asked); value.settings = settings; if (!value.title) value.title = titleFrom(question); });
  emit({ type: 'message', message: asked });
  emit({ type: 'start', mode: 'chat', agents: [{ id: 'main', label: '' }] });
  const workspace = await research.workspace(originId), started = Date.now();
  const onEvent = event => emit({ ...event, agent: 'main' });
  const call = (input, session) => runner({ provider: settings.provider, model: settings.model, effort: settings.effort, web: settings.web, cwd: workspace, signal, onEvent, prompt: input, session });
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
  const stopped = failure?.code === 'ABORTED';
  const answer = { id: randomUUID(), role: 'assistant', at: Date.now(), mode: 'chat', provider: settings.provider, model: settings.model, durationMs: Date.now() - started,
    text: result?.text ?? failure?.partial ?? '', status: result ? 'done' : stopped ? 'stopped' : 'failed', ...(failure && !stopped ? { error: publicError(failure) } : {}) };
  const updated = await research.update(originId, chat, value => {
    value.messages.push(answer);
    if (result?.session) value.native = { provider: settings.provider, sessionId: result.session, contextHash };
    else if (failure?.resumeFailed) value.native = null;
  });
  emit({ type: 'message', message: answer });
  emit({ type: 'done', chat: updated });
  return updated;
}

/**
 * HTTP for chats. GET/POST /api/origin/research/:origin/chats, GET/PATCH/DELETE …/chats/:chat, and
 * POST …/chats/:chat/run, which streams NDJSON events while the CLI works. A run uses the shared one-job slot,
 * so it never overlaps Compose, the Coordinator or a sign-in change. Closing the request stops the run.
 */
export async function researchRoute({ research, origin, runner, claim, track, req, res, pathname, searchParams, jsonBody, send }) {
  const match = pathname.match(/^\/api\/origin\/research\/([A-Za-z0-9_-]{1,100})\/chats(?:\/([0-9a-f-]{36})(?:\/(run))?)?$/);
  if (!match) return send(res, 404, { error: 'This research route does not exist.' });
  const [, originId, chat, action] = match;
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
    if (settings.mode !== 'chat') throw invalid('Swarm, Decision Lab and Audit are not available yet. Use Chat.');
    await research.read(originId, chat); // A missing chat is reported before the job slot is taken.
    const claimed = await claim('research', settings.provider), { job } = claimed;
    job.stage = `research-${settings.mode}`;
    const abort = () => { if (!res.writableEnded) job.controller.abort(); };
    res.once('close', abort); if (res.destroyed) job.controller.abort();
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const emit = event => { if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(event)}\n`); };
    const ping = setInterval(() => emit({ ping: true }), 15000); ping.unref();
    try { await track(runChat({ research, origin, originId, chat, settings, question, runner, signal: job.controller.signal, emit })); }
    catch (error) { emit({ type: 'error', ...publicError(error) }); }
    finally { clearInterval(ping); res.off('close', abort); if (!res.writableEnded) res.end(); claimed.release(); }
    return;
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
