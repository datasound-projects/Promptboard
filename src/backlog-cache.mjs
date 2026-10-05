/** Machine-local preview snapshots. A sync never writes board tasks or import identities. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { githubIssuePreview, githubIssueSource } from './backlog-github.mjs';
import { GitHubError } from './github.mjs';

const MAX_BYTES = 16 * 1024 * 1024, MAX_PAGES = 12, SYNC_PAGES = 20;
const fail = (message, code = 'BACKLOG_CACHE_INVALID', status = 409) => { throw new GitHubError(message, code, status); };
const integer = value => Number.isSafeInteger(value) && value >= 0 && Number.isFinite(new Date(value).getTime());
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;

export class BacklogCache {
  constructor(dataDir, { now = Date.now } = {}) { this.dir = join(dataDir, 'backlog-preview-cache'); this.now = now; this.locks = new Map(); }
  #path(projectId, source) {
    if (!validId(projectId) || !validId(source.id)) fail('Choose a saved source.');
    const normalized = githubIssueSource(source.repository);
    if (source.provider !== normalized.provider || source.repository !== normalized.repository) fail('Choose a valid saved source.');
    return join(this.dir, createHash('sha256').update(JSON.stringify([projectId, source.id])).digest('hex') + '.json');
  }
  async #directory() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const info = await lstat(this.dir);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('The preview cache folder is unavailable.', 'BACKLOG_CACHE_UNAVAILABLE');
    return info;
  }
  #empty(projectId, source) { return { version: 1, projectId, sourceId: source.id, repository: source.repository, cursor: null, syncedAt: null, pages: [] }; }
  async #read(path, projectId, source) {
    const directory = await this.#directory(); let handle;
    try {
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_BYTES) fail('The preview cache file is unavailable.', 'BACKLOG_CACHE_UNAVAILABLE');
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || !same(before, stat) || !same(directory, await lstat(this.dir))) fail('The preview cache changed while reading.', 'BACKLOG_CACHE_UNAVAILABLE');
      const buffer = Buffer.alloc(MAX_BYTES + 1); let length = 0;
      while (length < buffer.length) { const read = await handle.read(buffer, length, buffer.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
      if (length > MAX_BYTES) fail('The preview cache exceeds its size limit.');
      const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
      if (data?.version > 1) fail('This preview cache needs a newer Promptboard version.', 'BACKLOG_CACHE_VERSION_UNSUPPORTED');
      if (data?.version !== 1 || data.projectId !== projectId || data.sourceId !== source.id || data.repository !== source.repository
        || data.cursor !== null && !integer(data.cursor) || data.syncedAt !== null && !integer(data.syncedAt) || !Array.isArray(data.pages) || data.pages.length > MAX_PAGES) fail('The saved preview cache is invalid.');
      const keys = new Set();
      data.pages = data.pages.map(entry => {
        const key = `${entry?.state}:${entry?.page}`;
        if (!entry || !['open', 'closed', 'all'].includes(entry.state) || !Number.isSafeInteger(entry.page) || entry.page < 1 || entry.page > 1000 || !integer(entry.checkedAt) || keys.has(key)) fail('The saved preview cache is invalid.');
        keys.add(key); return { state: entry.state, page: entry.page, checkedAt: entry.checkedAt, result: githubIssuePreview(entry.result, source.repository, entry.state, entry.page) };
      });
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return this.#empty(projectId, source);
      if (error instanceof GitHubError) throw error;
      if (error instanceof SyntaxError || error instanceof TypeError) fail('The saved preview cache is invalid. Refresh page 1 to rebuild it.');
      fail('The saved preview cache could not be read.', 'BACKLOG_CACHE_UNAVAILABLE');
    } finally { await handle?.close(); }
  }
  async #write(path, data, guard) {
    const directory = await this.#directory(), text = JSON.stringify(data);
    if (Buffer.byteLength(text) > MAX_BYTES) fail('The preview cache exceeds its size limit.', 'BACKLOG_CACHE_LIMIT');
    const tmp = path + '.tmp-' + randomUUID();
    try {
      const handle = await open(tmp, 'wx', 0o600);
      try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
      await guard();
      if (!same(directory, await lstat(this.dir))) fail('The preview cache folder changed.', 'BACKLOG_CACHE_UNAVAILABLE');
      await rename(tmp, path);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      if (error instanceof GitHubError || error.status) throw error;
      fail('The preview cache could not be saved. Your previous preview remains available.', 'BACKLOG_CACHE_WRITE_FAILED', 500);
    }
    try { const handle = await open(this.dir, 'r'); try { await handle.sync(); } finally { await handle.close(); } } catch {}
  }
  #locked(path, work) {
    const previous = this.locks.get(path) || Promise.resolve();
    const next = previous.catch(() => {}).then(work); this.locks.set(path, next);
    return next.finally(() => { if (this.locks.get(path) === next) this.locks.delete(path); });
  }
  #view(data, entry, cached, changed = null) { return { ...entry.result, cache: { cached, checkedAt: entry.checkedAt, syncedAt: data.syncedAt, changed } }; }
  #put(data, entry) {
    data.pages = data.pages.filter(row => row.state !== entry.state || row.page !== entry.page); data.pages.push(entry);
    while (data.pages.length > MAX_PAGES || Buffer.byteLength(JSON.stringify(data)) > MAX_BYTES) {
      if (data.pages.length === 1) fail('This source page exceeds the cache size limit.', 'BACKLOG_CACHE_LIMIT');
      data.pages.shift();
    }
  }
  async preview(projectId, source, { state = 'all', page = 1, refresh = false } = {}, read, guard) {
    if (!['open', 'closed', 'all'].includes(state) || !Number.isSafeInteger(page) || page < 1 || page > 1000 || typeof refresh !== 'boolean') fail('Choose a valid source page.', 'INVALID_BACKLOG_SOURCE', 400);
    const path = this.#path(projectId, source);
    return this.#locked(path, async () => {
      await guard(); let data;
      try { data = await this.#read(path, projectId, source); }
      catch (error) {
        if (!refresh || state !== 'all' || page !== 1 || error.code !== 'BACKLOG_CACHE_INVALID') throw error;
        // Rebuild only derived snapshots, never board data or a newer cache format.
        data = this.#empty(projectId, source);
      }
      const entry = data.pages.find(row => row.state === state && row.page === page);
      if (entry && !refresh) { await guard(); return this.#view(data, entry, true); }
      const checkedAt = this.now();
      const result = githubIssuePreview(await read({ repository: source.repository, state, page }), source.repository, state, page);
      const fresh = { state, page, checkedAt, result };
      if (refresh && state === 'all' && page === 1) { data.pages = []; data.cursor = checkedAt; data.syncedAt = null; }
      data.cursor ??= checkedAt;
      this.#put(data, fresh); await this.#write(path, data, guard); return this.#view(data, fresh, false);
    });
  }
  async sync(projectId, source, read, guard) {
    const path = this.#path(projectId, source);
    return this.#locked(path, async () => {
      await guard(); const data = await this.#read(path, projectId, source), startedAt = this.now();
      if (data.cursor !== null && startedAt < data.cursor) fail('The clock moved backwards. Synchronize again when it reaches the previous check time.', 'BACKLOG_SYNC_CLOCK');
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(new GitHubError('Source synchronization timed out. The previous cache and cursor were preserved.', 'BACKLOG_SYNC_TIMEOUT', 504)), 30000);
      const request = input => {
        const operation = Promise.resolve().then(() => read({ ...input, signal: controller.signal }));
        return new Promise((resolve, reject) => {
          const aborted = () => finish(reject, controller.signal.reason);
          const finish = (fn, value) => { controller.signal.removeEventListener('abort', aborted); fn(value); };
          controller.signal.addEventListener('abort', aborted, { once: true });
          operation.then(value => finish(resolve, value), error => finish(reject, error));
          if (controller.signal.aborted) aborted();
        });
      };
      try {
        const changed = new Map(); let deltaBytes = 0;
        if (data.cursor !== null) {
          const since = new Date(Math.max(0, Math.floor(data.cursor / 1000) * 1000 - 1000)).toISOString().replace('.000Z', 'Z');
          for (let page = 1; ; page++) {
            const result = githubIssuePreview(await request({ repository: source.repository, state: 'all', page, since }), source.repository, 'all', page);
            if (result.unavailable.length) fail('Some changed issues have unsupported metadata. The synchronization cursor was preserved.', 'BACKLOG_SYNC_INCOMPLETE');
            for (const item of result.items) {
              if (changed.has(item.sourceKey)) fail('Source pages changed during synchronization. The cursor was preserved; retry explicitly.', 'BACKLOG_SYNC_INCOMPLETE');
              deltaBytes += Buffer.byteLength(JSON.stringify(item));
              if (deltaBytes > MAX_BYTES) fail('Changed issue metadata exceeds the synchronization size limit. The previous cache and cursor were preserved.', 'BACKLOG_SYNC_LIMIT');
              changed.set(item.sourceKey, item);
            }
            if (!result.nextPage) break;
            if (page === SYNC_PAGES) fail('Too many source rows changed for one incremental sync. The previous cache and cursor were preserved. Refresh page 1 to start a new baseline.', 'BACKLOG_SYNC_LIMIT');
          }
        }
        // Known metadata retains labeled snapshot positions; unseen identities need a fresh baseline.
        let entry = data.pages.find(row => row.state === 'all' && row.page === 1), cached = Boolean(entry);
        const known = new Set(data.pages.flatMap(row => row.result.items.map(item => item.sourceKey)));
        if (!entry || [...changed.keys()].some(key => !known.has(key))) {
          const result = githubIssuePreview(await request({ repository: source.repository, state: 'all', page: 1 }), source.repository, 'all', 1);
          entry = { state: 'all', page: 1, checkedAt: startedAt, result }; data.pages = [entry]; cached = false;
        } else if (changed.size) {
          // Filtered snapshots may change membership when an issue closes or reopens.
          data.pages = data.pages.filter(row => row.state === 'all').map(row => ({ ...row,
            result: { ...row.result, items: row.result.items.map(item => changed.get(item.sourceKey) || item) } }));
          entry = data.pages.find(row => row.page === 1);
        }
        controller.signal.throwIfAborted(); data.cursor = startedAt; data.syncedAt = startedAt;
        await this.#write(path, data, async () => { controller.signal.throwIfAborted(); await guard(); controller.signal.throwIfAborted(); });
        return this.#view(data, entry, cached, changed.size);
      } finally { clearTimeout(timeout); }
    });
  }
}
