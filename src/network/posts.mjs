/**
 * Profile posts (docs/network/architecture.md §3, §5): reports the owner writes on an agent's profile, in limited
 * Markdown, with optional source references. A post is the owner's own note, shown as a "Report": it is never an event,
 * a job or evidence that anything ran, and nothing here creates one from memory or activity. Posts from external agents
 * need the machine gateway (Task 11) and are refused until then; a job reference waits for the job engine (Task 06).
 *
 * Storage: <dataDir>/network/posts/<agentId>.json (storage.mjs discipline), text cleaned by cleanText before it is saved.
 * The page renders the Markdown with public/markdown-view.js, which shows raw HTML as text and loads nothing.
 */
import { join } from 'node:path';
import { serial } from '../durable.mjs';
import { escapeId } from '../origin.mjs';
import { cleanText, conflict, fail, LINE_BREAK, newId, object, only, page, readDocument, requireRevision, writeDocument } from './storage.mjs';

const SCHEMA = 'promptboard.network-posts';
export const POST_LIMITS = Object.freeze({ markdownBytes: 16 * 1024, posts: 2000, references: 10, reference: 300 });
const LIMITS = POST_LIMITS, POST_ID = /^pst_[0-9a-f]{20}$/;
const time = value => Number.isSafeInteger(value) && value >= 0;
const storedPost = (post, agentId) => object(post) && POST_ID.test(post.id) && post.agentId === agentId && typeof post.markdown === 'string'
  && Array.isArray(post.references) && post.references.length <= LIMITS.references && post.references.every(item => typeof item === 'string')
  && post.jobId === null && object(post.source) && post.source.kind === 'owner' && Number.isSafeInteger(post.revision) && time(post.createdAt) && (post.editedAt === null || time(post.editedAt));
const newest = (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1);

/** Markdown and references of a new post or an edit; `previous` keeps what an edit leaves out. */
function postFields(input, previous) {
  // Network jobs do not exist yet, so a job reference cannot be checked: refused rather than stored unverified.
  if (input.jobId !== undefined && input.jobId !== null) fail('Job references arrive with Network jobs. Leave jobId out for now.', 'JOB_NOT_FOUND');
  let markdown = previous?.markdown;
  if (Object.hasOwn(input, 'markdown') || !previous) {
    if (typeof input.markdown !== 'string') fail('Write the report as Markdown text.');
    if (Buffer.byteLength(input.markdown) > LIMITS.markdownBytes) fail('A report holds at most 16 KiB of Markdown.', 'NETWORK_LIMIT', 413);
    markdown = cleanText(input.markdown);
    if (!markdown) fail('Write the report.');
  }
  let references = previous?.references ?? [];
  if (Object.hasOwn(input, 'references')) {
    const list = input.references;
    if (!Array.isArray(list) || list.length > LIMITS.references || list.some(item => typeof item !== 'string' || item.length > LIMITS.reference)) fail(`Add at most ${LIMITS.references} source references of up to ${LIMITS.reference} characters each.`);
    if (list.some(item => LINE_BREAK.test(item.trim()))) fail('Each source reference is one line, without line breaks or tabs.');
    references = [...new Set(list.map(item => cleanText(item).replace(/\s+/g, ' ')).filter(Boolean))];
  }
  return { markdown, references };
}

export class NetworkPosts {
  /** `registry` answers whether the agent is registered (NetworkRegistry.agent); nothing else is read from it. */
  constructor({ dataDir, registry, now = Date.now }) { this.dir = join(dataDir, 'network', 'posts'); this.registry = registry; this.now = now; }
  // ponytail: one queue and one file per agent rewritten on each post (≤ 2,000 × 16 KiB); split by month if reports grow.
  #serial = serial();
  #docs = new Map(); // agentId → its document after the first good read.

  #path(agentId) { return join(this.dir, `${escapeId(agentId)}.json`); }
  async #load(agentId) {
    await this.registry.agent(agentId); // NOT_FOUND for an unknown or malformed ID, before it reaches a file name.
    if (!this.#docs.has(agentId)) this.#docs.set(agentId, await readDocument(this.#path(agentId), { schema: SCHEMA, label: 'This agent’s reports',
      valid: data => data.agentId === agentId && Number.isSafeInteger(data.revision) && Array.isArray(data.posts) && data.posts.every(post => storedPost(post, agentId)) })
      ?? { schema: SCHEMA, version: 1, agentId, revision: 0, posts: [] });
    return this.#docs.get(agentId);
  }
  async #save(doc, posts) {
    const next = { ...doc, revision: doc.revision + 1, posts };
    await writeDocument(this.#path(doc.agentId), next);
    this.#docs.set(doc.agentId, next);
    return next;
  }
  #post(doc, id) {
    const post = typeof id === 'string' && POST_ID.test(id) && doc.posts.find(item => item.id === id);
    if (!post) fail('This report does not exist.', 'NOT_FOUND', 404);
    return post;
  }

  async list(agentId, { offset, limit } = {}) {
    return this.#serial(async () => { const doc = await this.#load(agentId); return { revision: doc.revision, ...page([...doc.posts].sort(newest), offset, limit, 'posts') }; });
  }
  async create(agentId, input) {
    only(input, ['expectedRevision', 'markdown', 'references', 'jobId'], 'a report');
    requireRevision(input);
    const fields = postFields(input);
    return this.#serial(async () => {
      const doc = await this.#load(agentId);
      if (input.expectedRevision !== doc.revision) conflict('These reports');
      if (doc.posts.length >= LIMITS.posts) fail(`An agent holds at most ${LIMITS.posts.toLocaleString('en-US')} reports. Delete some first.`, 'NETWORK_LIMIT', 409);
      const post = { id: newId('pst'), agentId, ...fields, jobId: null, source: { kind: 'owner' }, createdAt: this.now(), editedAt: null, revision: 1 };
      const saved = await this.#save(doc, [...doc.posts, post]);
      return { revision: saved.revision, post };
    });
  }
  async update(agentId, postId, input) {
    only(input, ['expectedRevision', 'markdown', 'references', 'jobId'], 'a report');
    requireRevision(input);
    return this.#serial(async () => {
      const doc = await this.#load(agentId), post = this.#post(doc, postId);
      if (input.expectedRevision !== post.revision) conflict('This report');
      const fields = postFields(input, post);
      if (fields.markdown === post.markdown && JSON.stringify(fields.references) === JSON.stringify(post.references)) return { revision: doc.revision, post };
      const next = { ...post, ...fields, editedAt: this.now(), revision: post.revision + 1 };
      const saved = await this.#save(doc, doc.posts.map(item => (item.id === postId ? next : item)));
      return { revision: saved.revision, post: next };
    });
  }
  async remove(agentId, postId, input) {
    only(input, ['expectedRevision'], 'a report deletion');
    requireRevision(input);
    return this.#serial(async () => {
      const doc = await this.#load(agentId), post = this.#post(doc, postId);
      if (input.expectedRevision !== post.revision) conflict('This report');
      const saved = await this.#save(doc, doc.posts.filter(item => item.id !== postId));
      return { revision: saved.revision, deleted: postId };
    });
  }
}
