/**
 * Network events (docs/network/architecture.md §4.3, §10.1, §14 item 1, §17 item 1, §19): an append-only journal of what
 * Network jobs and pipelines did, for the Activity view. Events are observability, never authority: job and pipeline state
 * come only from job.json / run.json, nothing reads this journal to decide anything, and no route appends to it (only the
 * server's own modules call append(): the job engine, the worker's activity, the pipeline runner).
 *
 * Storage, created on the first append: <dataDir>/network/events/<16-digit first seq>.jsonl. A segment's first line is
 * the header {"schema":"promptboard.network-events","version":1,"first":<seq>}; every other line is one event
 * { seq, id, at, type, …known fields } of at most 4 KiB. `seq` strictly increases across segments and restarts (the next
 * one is the newest segment's last seq + 1, or its `first` when it holds none). A line that does not parse or does not
 * continue the sequence is skipped and counted, never repaired; a torn last line (a crash during a write) is closed with
 * a line break on load, so it becomes such a skipped line and later events stay whole. A segment rolls over past
 * `segmentBytes` (8 MiB); only the newest `maxSegments` (16) are kept. Cursors are sequence numbers, so retention never
 * breaks one: a cursor older than the oldest kept event reads from there with `gap: true`. A segment saved by a newer
 * version makes the whole journal unavailable (NETWORK_VERSION_UNSUPPORTED): nothing is read from or written to it.
 */
import { appendFile, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { serial } from '../durable.mjs';
import { fail, newId, oneLine, PAGE_LIMIT } from './storage.mjs';

const SCHEMA = 'promptboard.network-events', VERSION = 1, MIB = 1024 * 1024;
/** Resource ceilings (architecture §4.2 rule 8, §10.1), not product limits. */
export const EVENT_LIMITS = Object.freeze({ lineBytes: 4096, message: 500, scan: 50_000, streamsPerClient: 4, streams: 32, streamBuffer: MIB, replayBuffer: 1000, replayPage: 200 });
const SEGMENT = /^(\d{16})\.jsonl$/, ID = /^[A-Za-z0-9_-]{1,100}$/, NODE = /^[A-Za-z0-9_-]{1,64}(?:\/[A-Za-z0-9_-]{1,64}){0,7}$/;
const TYPE = /^[a-z]{1,20}\.[a-z_]{1,30}$/, WORD = /^[a-z][a-z_-]{0,39}$/, CODE = /^[A-Z][A-Z0-9_]{1,59}$/, REF = /^(?![/.])(?!.*\.\.)[A-Za-z0-9_./-]{1,200}$/;
/** The fields an event may carry and the shape each must have; anything else is left out (never copied). */
const FIELDS = { jobId: ID, attemptId: ID, agentId: ID, pipelineRunId: ID, networkId: ID, projectId: ID, nodeId: NODE, status: WORD, from: WORD, by: WORD, kind: WORD,
  errorCode: CODE, coverage: WORD, artifactRef: REF };
export const EVENT_FILTERS = ['agentId', 'jobId', 'networkId', 'pipelineRunId'];
const time = value => Number.isSafeInteger(value) && value >= 0;
const NEWER = 'The Network activity journal was saved by a newer Promptboard version. Update the app; nothing was changed.';

/**
 * What an event becomes on disk: a known type (not kanban.*, which is derived and never journaled), known fields of the
 * right shape, and a one-line message of at most 500 characters with local folders cut and secret-looking values masked.
 * `label` (a worker activity's text) counts as the message. Null when the type is unusable.
 */
export function normalizeEvent(input, now) {
  if (!input || typeof input !== 'object' || typeof input.type !== 'string' || !TYPE.test(input.type) || input.type.startsWith('kanban.')) return null;
  const event = { at: time(input.at) ? input.at : now, type: input.type };
  for (const [key, pattern] of Object.entries(FIELDS)) if (typeof input[key] === 'string' && pattern.test(input[key])) event[key] = input[key];
  const text = typeof input.message === 'string' ? input.message : typeof input.label === 'string' ? input.label : '';
  const message = text && oneLine(text).slice(0, EVENT_LIMITS.message);
  if (message) event.message = message;
  return event;
}
/** One stored line as an event, or null: an object with a sequence above `after`, an evt_ ID, a time and a known type. */
function storedEvent(line, after) {
  let value; try { value = JSON.parse(line); } catch { return null; }
  return value && typeof value === 'object' && Number.isSafeInteger(value.seq) && value.seq > after && /^evt_[0-9a-f]{20}$/.test(value.id) && time(value.at) && TYPE.test(value.type ?? '') ? value : null;
}
async function firstLine(path) {
  const handle = await open(path, 'r');
  try { const { buffer, bytesRead } = await handle.read(Buffer.alloc(512), 0, 512, 0); return buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0]; }
  finally { await handle.close(); }
}
const headerOf = line => { try { const value = JSON.parse(line); return value?.schema === SCHEMA ? value : null; } catch { return null; } };
const cursor = (value, name) => { if (value !== undefined && !(Number.isSafeInteger(value) && value >= 0)) fail(`${name} is a sequence number (0 or more).`); return value; };

export class NetworkEvents {
  constructor({ dataDir, now = Date.now, segmentBytes = 8 * MIB, maxSegments = 16, pingMs = 15_000 }) {
    Object.assign(this, { dir: join(dataDir, 'network', 'events'), now, segmentBytes, maxSegments, pingMs });
  }
  #serial = serial();
  #loading = null;
  #segments = []; // [{ name, first }], oldest first.
  #last = 0; // The highest sequence number written (or reserved by a failed write).
  #size = 0; // Bytes in the newest segment.
  #torn = false; // A write failed part-way: close its line before the next one.
  #unavailable = null; // { code, message } once a newer segment was found.
  #failures = 0;
  #listeners = new Set();
  #streams = new Map(); // client key → open streams.
  #parsed = new Map(); // segment name → { size, page }: the segments read last, oldest first (see #read).

  #ready() { return this.#loading ??= this.#load().catch(error => { this.#loading = null; throw error; }); }
  async #load() {
    let names = [];
    try { names = await readdir(this.dir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const segments = names.filter(name => SEGMENT.test(name)).sort().map(name => ({ name, first: Number(name.slice(0, 16)) }));
    for (const segment of segments) {
      const header = headerOf(await firstLine(join(this.dir, segment.name)));
      if (Number.isSafeInteger(header?.version) && header.version > VERSION) this.#unavailable = { code: 'NETWORK_VERSION_UNSUPPORTED', message: NEWER };
    }
    this.#segments = segments;
    const newest = segments.at(-1);
    if (!newest || this.#unavailable) return;
    const path = join(this.dir, newest.name), read = await readFile(path, 'utf8'), torn = Boolean(read) && !read.endsWith('\n');
    // A torn last line: close it so it stays one skipped line and the next event starts on a line of its own.
    if (torn) await appendFile(path, '\n');
    const text = torn ? `${read}\n` : read;
    this.#last = this.#parse(text, newest).events.at(-1)?.seq ?? newest.first - 1;
    this.#size = Buffer.byteLength(text);
  }
  /** The events of one segment's text, in order; the header and the unfinished part after the last line break are not lines. */
  #parse(text, segment) {
    const lines = text.split('\n'), events = [];
    lines.pop(); // After the last line break: empty, or a line still being written.
    let skipped = 0, after = segment.first - 1;
    lines.forEach((line, index) => {
      if (index === 0 && headerOf(line)) return;
      const event = storedEvent(line, after);
      if (event) { events.push(event); after = event.seq; } else skipped++;
    });
    return { events, skipped };
  }
  /**
   * One segment's events. A segment only grows (append only, never rewritten), so a parse is reused while the file keeps
   * the size it was parsed at: a replay reads each segment once, not once per page. Callers never change what it answers.
   */
  async #read(segment) {
    const path = join(this.dir, segment.name);
    try {
      const { size } = await stat(path), hit = this.#parsed.get(segment.name);
      if (hit?.size === size) { this.#parsed.delete(segment.name); this.#parsed.set(segment.name, hit); return hit.page; }
      const bytes = await readFile(path), page = this.#parse(bytes.toString('utf8'), segment);
      // ponytail: the 2 segments read last stay parsed (at most ~2 × 8 MiB of events); a seq → offset index if memory matters.
      this.#parsed.delete(segment.name); this.#parsed.set(segment.name, { size: bytes.length, page });
      if (this.#parsed.size > 2) this.#parsed.delete(this.#parsed.keys().next().value);
      return page;
    } catch (error) { if (error.code === 'ENOENT') return { events: [], skipped: 0 }; throw error; } // Removed by retention meanwhile.
  }
  #available() { if (this.#unavailable) fail(this.#unavailable.message, this.#unavailable.code, 409); }

  /**
   * Append one event (§17 item 1) and answer `{ seq, id }`, or null when it was refused or could not be written; it never
   * throws, so a full disk or a damaged journal never breaks the transition that reported it. Listeners hear an event only
   * after it is written, in sequence order.
   */
  append(input) {
    return this.#serial(async () => {
      try {
        await this.#ready();
        this.#available();
        const fields = normalizeEvent(input, this.now());
        if (!fields) fail('Unknown event.', 'EVENT_INVALID');
        const seq = this.#last + 1, event = { seq, id: newId('evt'), ...fields }, line = `${JSON.stringify(event)}\n`, bytes = Buffer.byteLength(line);
        if (bytes > EVENT_LIMITS.lineBytes) fail('The event is too large.', 'EVENT_INVALID');
        try {
          let segment = this.#segments.at(-1);
          if (!segment || (this.#size + bytes > this.segmentBytes && seq > segment.first)) segment = await this.#roll(seq);
          const path = join(this.dir, segment.name);
          if (this.#torn) { await appendFile(path, '\n'); this.#torn = false; }
          try { await appendFile(path, line, { mode: 0o600 }); } catch (error) { this.#torn = true; throw error; }
          this.#size += bytes;
        } finally { this.#last = seq; } // Readers see a seq only once its write ended; a failed one is never used again.
        for (const listener of this.#listeners) { try { listener(event); } catch {} }
        return { seq, id: event.id };
      } catch { this.#failures++; return null; }
    });
  }
  /** A new segment named by its first sequence number, then retention: only the newest `maxSegments` stay. */
  async #roll(seq) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const segment = { name: `${String(seq).padStart(16, '0')}.jsonl`, first: seq }, header = `${JSON.stringify({ schema: SCHEMA, version: VERSION, first: seq })}\n`;
    await writeFile(join(this.dir, segment.name), header, { flag: 'wx', mode: 0o600 });
    this.#segments.push(segment); this.#size = Buffer.byteLength(header); this.#torn = false;
    while (this.#segments.length > this.maxSegments) await rm(join(this.dir, this.#segments.shift().name), { force: true });
    return segment;
  }
  /** Hear every event once it is written; answers the function that stops it. */
  subscribe(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  /** last: the newest seq; oldest: the first seq still kept; failures: appends refused or not written since the start. */
  async status() {
    try { await this.#ready(); } catch { return { last: null, oldest: null, failures: this.#failures, unavailable: 'NETWORK_DATA_UNREADABLE' }; }
    return { last: this.#last, oldest: this.#segments[0]?.first ?? this.#last + 1, failures: this.#failures, unavailable: this.#unavailable?.code ?? null };
  }

  /**
   * A page of events in sequence order. `after`: the next events after that seq (`next` continues; `gap` when retention
   * removed some after it; `reset` when it is past the newest, as after a journal was removed). Otherwise the newest ones
   * before `before` (default: all), with `prev` to continue to older ones (null at the oldest). Filters match exact IDs.
   * At most `limit` (1–200) events, and at most 50,000 lines are looked at per call, so a narrow filter answers with an
   * empty page and a cursor rather than reading the whole journal. `skipped`: damaged lines in the segments read.
   * `view(event)` (server code only, e.g. a machine client's own jobs): what a caller sees of an event, null to leave it out.
   */
  async read({ after, before, limit = 100, view = null, ...filters } = {}) {
    cursor(after, 'after'); cursor(before, 'before');
    if (after !== undefined && before !== undefined) fail('Use after or before, not both.');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_LIMIT) fail(`Choose a limit of 1 to ${PAGE_LIMIT}.`);
    for (const key of Object.keys(filters)) {
      if (!EVENT_FILTERS.includes(key)) fail(`Filter events by ${EVENT_FILTERS.join(', ')}.`);
      if (filters[key] !== undefined && !ID.test(filters[key])) fail('Filter events by valid IDs.');
    }
    await this.#ready();
    this.#available();
    const wanted = Object.entries(filters).filter(([, value]) => value !== undefined), match = event => wanted.every(([key, value]) => event[key] === value) && (view ? view(event) : event);
    const last = this.#last, segments = [...this.#segments], oldest = segments[0]?.first ?? last + 1, events = [];
    const at = seq => { let index = -1; segments.forEach((segment, i) => { if (segment.first <= seq) index = i; }); return index; };
    let skipped = 0, scanned = 0;
    if (after !== undefined) {
      if (after > last) return { events, last, oldest, next: last, prev: null, more: false, gap: false, reset: true, skipped };
      let next = after, done = true;
      for (let i = Math.max(0, at(after + 1)); i < segments.length; i++) {
        const page = await this.#read(segments[i]);
        skipped += page.skipped;
        for (const event of page.events) {
          if (event.seq <= next || event.seq > last) continue;
          if (events.length >= limit || scanned >= EVENT_LIMITS.scan) { done = false; break; }
          scanned++; next = event.seq;
          const shown = match(event);
          if (shown) events.push(shown);
        }
        if (!done) break;
      }
      if (done) next = last;
      return { events, last, oldest, next, prev: null, more: next < last, gap: after + 1 < oldest, reset: false, skipped };
    }
    const end = Math.min(before ?? last + 1, last + 1);
    let prev = null;
    for (let i = at(end - 1); i >= 0; i--) {
      const page = await this.#read(segments[i]);
      skipped += page.skipped;
      for (const event of page.events.toReversed()) {
        if (event.seq >= end || (prev !== null && event.seq >= prev)) continue;
        if (events.length >= limit || scanned >= EVENT_LIMITS.scan) { i = -1; break; }
        scanned++; prev = event.seq;
        const shown = match(event);
        if (shown) events.push(shown);
      }
      if (i === 0) prev = null; // Read to the oldest segment: nothing older is left.
    }
    return { events: events.reverse(), last, oldest, next: last, prev, more: prev !== null, gap: false, reset: false, skipped };
  }

  /**
   * GET /api/network/events/stream?after=<seq>: NDJSON (architecture §14 item 1). Replays the events after `after` (all
   * kept ones from 0; none without `after`), then `{"live":true,"last":seq}`, then each new event as it is written, and
   * `{"ping":true}` every 15 s. `{"gap":true,"oldest":seq}` when retention removed events after the cursor; `{"reset":true,
   * "last":seq}` when the cursor is past the newest (the journal was removed): the reader reloads. A reader keeps the last
   * seq it saw and reconnects with it, so each event reaches it once. Ceilings: 4 open streams per client (the computer, or
   * one paired device) and 32 in all (429 STREAM_LIMIT); a reader that leaves 1 MiB unread, or 1,000 events pile up while
   * it replays, is disconnected and comes back with its last seq. A revoked paired device's streams are destroyed by remote
   * access itself (src/remote-access.mjs); every close tears the stream down here. `view` as in read(): a skipped event
   * still moves the reader's sequence, so a reconnect never repeats one.
   */
  async stream({ res, after, client, view = null }) {
    cursor(after, 'after');
    await this.#ready();
    this.#available();
    const open = [...this.#streams.values()].reduce((sum, count) => sum + count, 0), mine = this.#streams.get(client) ?? 0;
    if (mine >= EVENT_LIMITS.streamsPerClient || open >= EVENT_LIMITS.streams) fail('Too many live Activity views are open. Close one, then reload this one.', 'STREAM_LIMIT', 429);
    this.#streams.set(client, mine + 1);
    let closed = false, replaying = true, last = after ?? this.#last;
    const waiting = [];
    const write = item => {
      if (closed || res.writableEnded || res.destroyed) return;
      res.write(`${JSON.stringify(item)}\n`);
      if (res.writableLength > EVENT_LIMITS.streamBuffer) res.destroy(); // A reader that stopped reading reconnects with its last seq.
    };
    const deliver = event => { if (event.seq > last) { last = event.seq; const shown = view ? view(event) : event; if (shown) write(shown); } };
    const unsubscribe = this.subscribe(event => { if (!replaying) deliver(event); else if (waiting.push(event) > EVENT_LIMITS.replayBuffer) res.destroy(); });
    const ping = setInterval(() => write({ ping: true }), this.pingMs); ping.unref?.();
    const teardown = () => {
      if (closed) return;
      closed = true; clearInterval(ping); unsubscribe();
      const left = (this.#streams.get(client) ?? 1) - 1;
      if (left > 0) this.#streams.set(client, left); else this.#streams.delete(client);
    };
    res.once('close', teardown); // Also when remote access destroys a revoked device's response.
    if (res.destroyed) return teardown(); // The reader left while the journal was loading.
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    try {
      if (after !== undefined) {
        for (let more = true; more && !closed;) {
          const page = await this.read({ after: last, limit: EVENT_LIMITS.replayPage });
          // The page is unfiltered (deliver applies the view), so its `next` moves past events this reader does not see.
          if (page.reset) { write({ reset: true, last: page.last }); last = page.last; break; }
          if (page.gap) write({ gap: true, oldest: page.oldest });
          for (const event of page.events) deliver(event);
          last = Math.max(last, page.next); more = page.more;
          if (res.writableLength > 256 * 1024 && !closed) await Promise.race([once(res, 'drain'), once(res, 'close')]);
        }
      }
      replaying = false;
      for (const event of waiting.splice(0)) deliver(event);
      write({ live: true, last });
    } catch { res.destroy(); } // Headers are sent: the reader sees the end and reconnects with its last seq.
  }
  /** Open streams per client key. */
  streams() { return Object.fromEntries(this.#streams); }
}
