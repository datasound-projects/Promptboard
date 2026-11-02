/**
 * Job messages (docs/network/architecture.md §4.1, §11.4, §23): the inspectable record of a job's handoffs — the question
 * an agent asked and its answer, the sub-tasks it delegated and what came back — plus short notes from the owner or the
 * external client that submitted the job. Messages are records, never a channel: no agent can post one, no message starts,
 * approves or changes anything, and a later attempt of the same job reads the thread only as data. Agents never see
 * another job's messages.
 *
 * Storage (storage.mjs discipline), created on the first message: <dataDir>/network/jobs/<jobId>/messages.json
 * (promptboard.network-messages v1, with .bak) = { jobId, revision, messages: [Message] }. Bounded: 500 messages per job
 * (at most 200 of them notes from the owner or a client), text and json 16 KiB each. Removed with its job. A read receipt
 * (`readAt`) says the owner or the client it is addressed to marked it read; it is never set for an agent and never says
 * anything about execution (a job's status and attempts are the execution receipts).
 */
import { join } from 'node:path';
import { serial } from '../durable.mjs';
import { escapeId } from '../origin.mjs';
import { cleanText, fail, newId, object, only, oneLine, readDocument, writeDocument } from './storage.mjs';

const SCHEMA = 'promptboard.network-messages', KIB = 1024;
export const MESSAGE_KINDS = Object.freeze(['request', 'result', 'review', 'needs_input', 'blocked']);
/** Kinds the owner or a client may post: notes for the record (and for the job's next attempt, as data). */
export const POSTED_KINDS = Object.freeze(['review', 'request']);
/** Resource ceilings (architecture §4.2 rule 8), not product limits. */
export const MESSAGE_LIMITS = Object.freeze({ textBytes: 16 * KIB, jsonBytes: 16 * KIB, perJob: 500, posted: 200, thread: 64 * KIB });
const AGENT_ID = /^agt_[0-9a-f]{20}$/, CLIENT_ID = /^cli_[0-9a-f]{20}$/, JOB_ID = /^job_[0-9a-f]{20}$/, ATTEMPT_ID = /^att_[0-9a-f]{20}$/, MESSAGE_ID = /^msg_[0-9a-f]{20}$/;
const NODE_ID = /^n_[0-9a-f]{12}(?:\/n_[0-9a-f]{12}){0,4}$/;
const time = value => Number.isSafeInteger(value) && value >= 0;
const bytes = text => Buffer.byteLength(text);

/**
 * One party of a message: `{ agentId }`, `{ owner: true }`, `{ clientId }`, or (as a sender only) `{ app: true }` for what
 * Promptboard itself records, such as a refused request: attributing that to the agent or the owner would be false.
 */
export function party(value, { app = false } = {}) {
  if (!object(value) || Object.keys(value).length !== 1) return false;
  const [key] = Object.keys(value);
  return (key === 'agentId' && AGENT_ID.test(value.agentId)) || (key === 'owner' && value.owner === true) || (key === 'clientId' && CLIENT_ID.test(value.clientId)) || (app && key === 'app' && value.app === true);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** "the owner", "agent agt_…", "client cli_…", "Promptboard": for event summaries and the thread a later attempt reads. */
export const partyName = value => (value.owner ? 'the owner' : value.app ? 'Promptboard' : value.agentId ? `agent ${value.agentId}` : `client ${value.clientId}`);

const storedMessage = item => object(item) && MESSAGE_ID.test(item.id) && MESSAGE_KINDS.includes(item.kind) && party(item.from, { app: true }) && party(item.to) && typeof item.text === 'string'
  && time(item.createdAt) && (item.readAt === null || time(item.readAt)) && (item.json === undefined || object(item.json) || Array.isArray(item.json))
  && (item.jobId === undefined || JOB_ID.test(item.jobId)) && (item.attemptId === undefined || ATTEMPT_ID.test(item.attemptId)) && (item.task === undefined || (Number.isSafeInteger(item.task) && item.task >= 0))
  && (item.nodeId === undefined || NODE_ID.test(item.nodeId));
const stored = data => typeof data.jobId === 'string' && Number.isSafeInteger(data.revision) && Array.isArray(data.messages) && data.messages.length <= MESSAGE_LIMITS.perJob && data.messages.every(storedMessage);

/** Text cut to at most `max` UTF-8 bytes; a character cut in half is dropped. */
export const cut = (text, max) => (bytes(text) <= max ? text : Buffer.from(text).subarray(0, max).toString('utf8').replace(/�$/, ''));

/**
 * The thread as a later attempt of the job reads it (data, inside a delimited and indented prompt section): the report the
 * agent wrote when it handed off, then the messages oldest first. Bounded to 64 KiB: the newest messages are kept and the
 * number left out is said.
 */
export function threadText(report, messages) {
  const lines = messages.map(message => {
    const about = [message.jobId ? `sub-job ${message.jobId}` : '', Number.isSafeInteger(message.task) ? `sub-task ${message.task + 1}` : ''].filter(Boolean).join(', ');
    return `- ${message.kind} from ${partyName(message.from)} to ${partyName(message.to)}${about ? ` (${about})` : ''}, ${new Date(message.createdAt).toISOString()}:\n${message.text.split('\n').map(line => `    ${line}`).join('\n')}`;
  });
  const head = report ? `Your report from your previous attempt, when you handed off:\n${cut(report, MESSAGE_LIMITS.textBytes).split('\n').map(line => `    ${line}`).join('\n')}\n` : '';
  let kept = [], size = bytes(head);
  for (const line of lines.reverse()) { if (size + bytes(line) + 1 > MESSAGE_LIMITS.thread) break; kept.unshift(line); size += bytes(line) + 1; }
  const left = lines.length - kept.length;
  return `${head}Messages of this job, oldest first${left ? ` (${left} older ${left === 1 ? 'message' : 'messages'} left out)` : ''}:\n${kept.join('\n') || '- none'}`;
}

export class JobMessages {
  /** `dir` is <dataDir>/network; `events` (optional) hears one job.message event per message: IDs and kinds, never its text. */
  constructor({ dir, now = Date.now, events = null }) { Object.assign(this, { dir, now, events }); }
  #serial = serial(); // ponytail: one queue for every job's messages; per-job queues if posting ever contends.
  #file(jobId) { return join(this.dir, 'jobs', escapeId(jobId), 'messages.json'); }
  async #read(jobId) {
    return await readDocument(this.#file(jobId), { schema: SCHEMA, label: 'The messages of this job', valid: data => data.jobId === jobId && stored(data) })
      ?? { schema: SCHEMA, version: 1, jobId, revision: 0, messages: [] };
  }

  /** The job's messages, oldest first, and how many addressed to `reader` are unread. The caller checks the job exists. */
  async list(jobId, { reader = null } = {}) {
    const doc = await this.#read(jobId);
    return { revision: doc.revision, messages: doc.messages, unread: reader ? doc.messages.filter(message => !message.readAt && same(message.to, reader)).length : 0 };
  }

  /**
   * Append one message. `kind`, `from`, `to` and the bounds are checked here for every caller; text and json are cleaned as
   * owner text is (secrets masked, local folders cut). The owner and clients may hold at most 200 notes per job.
   * `agentId` (the job's agent) and a pipeline step job's `pipelineRunId`/`nodeId` only label the event.
   */
  async post(jobId, input, { agentId, pipelineRunId, nodeId } = {}) {
    only(input, ['kind', 'from', 'to', 'text', 'json', 'nodeId', 'jobId', 'attemptId', 'task'], 'a message');
    const { kind, from, to, json } = input;
    if (!MESSAGE_KINDS.includes(kind)) fail(`A message is one of ${MESSAGE_KINDS.join(', ')}.`);
    if (!party(from, { app: true }) || !party(to)) fail('A message names one sender and one recipient.');
    if (typeof input.text !== 'string') fail('Write the message as text.');
    if (bytes(input.text) > MESSAGE_LIMITS.textBytes) fail('A message holds at most 16 KiB of text.', 'NETWORK_LIMIT', 413);
    const text = cleanText(input.text);
    if (!text) fail('Write the message.');
    let cleanJson;
    if (json !== undefined) {
      if (!object(json) && !Array.isArray(json)) fail('A message json is an object or a list.');
      const serialized = JSON.stringify(json);
      if (bytes(serialized) > MESSAGE_LIMITS.jsonBytes) fail('A message holds at most 16 KiB of json.', 'NETWORK_LIMIT', 413);
      cleanJson = JSON.parse(serialized, (key, value) => (typeof value === 'string' ? cleanText(value) : value));
    }
    for (const [key, pattern] of [['nodeId', NODE_ID], ['jobId', JOB_ID], ['attemptId', ATTEMPT_ID]]) if (input[key] !== undefined && (typeof input[key] !== 'string' || !pattern.test(input[key]))) fail(`${key} is not valid.`);
    if (input.task !== undefined && !(Number.isSafeInteger(input.task) && input.task >= 0)) fail('task is a sub-task number.');
    // Only notes count against the 200: an answer to the job's question (a `result`, at most one per handoff) always fits.
    const note = message => (message.from.owner || message.from.clientId) && POSTED_KINDS.includes(message.kind);
    return this.#serial(async () => {
      const doc = await this.#read(jobId), posted = doc.messages.filter(note).length;
      if (doc.messages.length >= MESSAGE_LIMITS.perJob) fail(`A job keeps at most ${MESSAGE_LIMITS.perJob} messages. Nothing was added.`, 'NETWORK_LIMIT', 409);
      if (note(input) && posted >= MESSAGE_LIMITS.posted) fail(`A job keeps at most ${MESSAGE_LIMITS.posted} notes from you and clients. Nothing was added.`, 'NETWORK_LIMIT', 409);
      const message = { id: newId('msg'), kind, from, to, text, ...(cleanJson !== undefined ? { json: cleanJson } : {}), ...Object.fromEntries(['nodeId', 'jobId', 'attemptId', 'task'].filter(key => input[key] !== undefined).map(key => [key, input[key]])),
        createdAt: this.now(), readAt: null };
      await writeDocument(this.#file(jobId), { ...doc, revision: doc.revision + 1, messages: [...doc.messages, message] });
      const summary = oneLine(`${kind.replace('_', ' ')} from ${partyName(from)} to ${partyName(to)}${message.jobId ? ` (sub-job ${message.jobId})` : ''}`);
      try { Promise.resolve(this.events?.append({ type: 'job.message', jobId, agentId, pipelineRunId, nodeId, kind, message: summary })).catch(() => {}); } catch {}
      return message;
    });
  }

  /** Read receipts: the messages addressed to `reader` (all unread ones, or those in `ids`) get `readAt`. Execution is untouched. */
  async markRead(jobId, ids, reader) {
    return this.#serial(async () => {
      const doc = await this.#read(jobId), at = this.now(), wanted = ids ? new Set(ids) : null;
      let marked = 0;
      const messages = doc.messages.map(message => {
        if (message.readAt || !same(message.to, reader) || (wanted && !wanted.has(message.id))) return message;
        marked++;
        return { ...message, readAt: at };
      });
      if (marked) await writeDocument(this.#file(jobId), { ...doc, revision: doc.revision + 1, messages });
      return { marked, unread: messages.filter(message => !message.readAt && same(message.to, reader)).length };
    });
  }
}
