// Origin Research: chats about one Origin project, run through the user's own CLI. Research is read-only: it never
// writes the blueprint. Suggestions are stored with the chat and applied only by the page, after the user approves.
import '../public/origin-model.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ORIGIN_DIR, escapeId } from './origin.mjs';
import { serial, writeAtomic } from './durable.mjs';

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

/**
 * HTTP for chats. GET/POST /api/origin/research/:origin/chats, GET/PATCH/DELETE …/chats/:chat.
 * Running research (…/chats/:chat/run) is added by the streaming milestone.
 */
export async function researchRoute({ research, origin, req, res, pathname, searchParams, jsonBody, send }) {
  const match = pathname.match(/^\/api\/origin\/research\/([A-Za-z0-9_-]{1,100})\/chats(?:\/([0-9a-f-]{36}))?$/);
  if (!match) return send(res, 404, { error: 'This research route does not exist.' });
  const [, originId, chat] = match;
  // The Origin project must exist; this also rejects IDs that are not projects.
  const project = await origin.read(originId, { report: false });
  if (!project || project.damaged) throw new ResearchError('This Origin project no longer exists. Choose another project.', 'NOT_FOUND', 404);
  const body = async () => {
    const value = await jsonBody(req, 64 * 1024);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Send a JSON object.');
    return value;
  };
  if (!chat && req.method === 'GET') return send(res, 200, { chats: await research.list(originId, { query: searchParams?.get('q') || '' }) });
  if (!chat && req.method === 'POST') return send(res, 200, { chat: await research.create(originId, (await body()).settings) });
  if (chat && req.method === 'GET') return send(res, 200, { chat: await research.read(originId, chat) });
  if (chat && req.method === 'PATCH') {
    const input = await body();
    const title = text(input.title, LIMITS.title, 'A title').trim();
    return send(res, 200, { chat: summary(await research.update(originId, chat, value => { value.title = title; })) });
  }
  if (chat && req.method === 'DELETE') return send(res, 200, await research.remove(originId, chat));
  return send(res, 404, { error: 'This research route does not exist.' });
}
