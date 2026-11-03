/** Private, durable conversations. Chat has no write interface to workspace services. */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { serial, writeAtomic } from './durable.mjs';
import { ChatError } from './chat-knowledge.mjs';
import { SAFE_MODEL, validateEffort } from './providers.mjs';

export const CHAT_LIMITS = Object.freeze({ conversations: 200, messages: 200, question: 8000, title: 120, historyChars: 16000, answerChars: 18000, bodyBytes: 1024 * 1024, browserHistory: 30 });
export const CHAT_MODES = Object.freeze(['workspace', 'guide']);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SCHEMA = 'promptboard.chat', VERSION = 1;
export const chatId = value => { if (typeof value !== 'string' || !ID.test(value)) throw new ChatError('This conversation does not exist.', 'NOT_FOUND', 404); return value; };
export function chatText(value, max, label, { empty = false } = {}) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (!empty && !value.trim())) throw new ChatError(`${label} needs ${empty ? '0' : '1'}–${max.toLocaleString('en-US')} characters.`);
  return value.trim();
}
export function onlyChatFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw new ChatError('Send only the supported conversation fields.');
  return value;
}
export function chatSettings(value = {}) {
  onlyChatFields(value, ['provider', 'model', 'effort']);
  const provider = value.provider ?? 'claude', model = value.model ?? '', effort = value.effort ?? '';
  if (!['claude', 'codex', 'gemini'].includes(provider)) throw new ChatError('Chat needs Claude Code, Codex or Gemini CLI with tools disabled.');
  if (typeof model !== 'string' || (model && !SAFE_MODEL.test(model))) throw new ChatError('Use a model ID without spaces or command flags.');
  if (typeof effort !== 'string') throw new ChatError('Choose a supported effort level.');
  try { validateEffort(provider, effort); } catch { throw new ChatError('This CLI does not support that effort setting.'); }
  return { provider, model, effort };
}
const summary = chat => ({ id: chat.id, mode: chat.mode, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt, messages: chat.messages.length });

export class ChatStore {
  constructor(dataDir) { this.dir = join(dataDir, 'chat'); this.queue = serial(); }
  #path(id) { return join(this.dir, `${chatId(id)}.json`); }
  async #read(id) {
    let value;
    try {
      const bytes = await readFile(this.#path(id));
      if (bytes.length > 16 * 1024 * 1024) throw new Error('oversized');
      value = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw new ChatError('This conversation does not exist.', 'NOT_FOUND', 404);
      if (error.code && !['EISDIR'].includes(error.code)) throw error;
      throw new ChatError('This conversation cannot be read. It was left unchanged.', 'CHAT_UNREADABLE', 409);
    }
    if (value?.schema !== SCHEMA || value.version !== VERSION || value.id !== id || !CHAT_MODES.includes(value.mode) || !Array.isArray(value.messages)) throw new ChatError('This conversation cannot be read. It was left unchanged.', 'CHAT_UNREADABLE', 409);
    return value;
  }
  async #write(chat) {
    const bytes = JSON.stringify(chat);
    if (Buffer.byteLength(bytes) > 12 * 1024 * 1024 || chat.messages.length > CHAT_LIMITS.messages) throw new ChatError('This conversation is full. Start a new conversation; the existing history is kept.', 'CHAT_LIMIT', 409);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeAtomic(this.#path(chat.id), bytes, { backup: false });
    return chat;
  }
  async #names() { try { return (await readdir(this.dir)).filter(name => ID.test(name.slice(0, -5)) && name.endsWith('.json')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } }
  list(mode) {
    if (mode !== undefined && !CHAT_MODES.includes(mode)) throw new ChatError('Choose Workspace or App guide.');
    return this.queue(async () => {
      const chats = [];
      for (const name of await this.#names()) {
        try { const chat = await this.#read(name.slice(0, -5)); if (!mode || chat.mode === mode) chats.push(summary(chat)); }
        catch (error) { if (error.code !== 'CHAT_UNREADABLE' && error.code !== 'NOT_FOUND') throw error; }
      }
      return chats.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    });
  }
  read(id) { return this.queue(() => this.#read(chatId(id))); }
  create(input) {
    onlyChatFields(input, ['mode', 'settings']);
    if (!CHAT_MODES.includes(input.mode)) throw new ChatError('Choose Workspace or App guide.');
    const settings = chatSettings(input.settings);
    return this.queue(async () => {
      if ((await this.#names()).length >= CHAT_LIMITS.conversations) throw new ChatError('Delete an old conversation before creating another.', 'CHAT_LIMIT', 409);
      const now = Date.now();
      return this.#write({ schema: SCHEMA, version: VERSION, id: randomUUID(), mode: input.mode, settings, title: 'New conversation', createdAt: now, updatedAt: now, messages: [] });
    });
  }
  update(id, change) {
    return this.queue(async () => {
      const chat = await this.#read(chatId(id)); await change(chat);
      chat.updatedAt = Date.now();
      return this.#write(chat);
    });
  }
  remove(id) { return this.queue(async () => { await this.#read(chatId(id)); await rm(this.#path(id)); return { removed: true }; }); }
}
