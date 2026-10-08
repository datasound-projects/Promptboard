import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { chunkPages, buildIndex } from './compose-retrieval.mjs';
import { invalid } from './compose-grounding.mjs';

export const UPLOAD_BYTES = 20 * 1024 * 1024;
const TTL = 30 * 60_000, CACHE_CHARS = 4_000_000;
export function pageRange(from, to) {
  if (from === undefined && to === undefined) return {};
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from || to - from >= 200) invalid('Choose a valid page range of at most 200 pages.');
  return { from, to };
}
export function documentMeta({ name, type = '', from, to }) {
  if (typeof name !== 'string' || name.length > 160 || !name.trim() || /[\/\\\x00-\x1f]/.test(name) || !/\.(pdf|txt|md)$/i.test(name)) invalid('Choose a PDF, .txt, or .md file with a valid filename.');
  const pdf = /\.pdf$/i.test(name);
  if (!(pdf ? ['', 'application/pdf'] : ['', 'text/plain', 'text/markdown', 'text/x-markdown']).includes(type.split(';')[0])) invalid('The file type does not match its extension.');
  const range = pageRange(from, to);
  if (!pdf && range.from) invalid('Page ranges apply only to PDFs.');
  return { name, pdf, ...range };
}
export function extractPdf(bytes, range, { signal, timeoutMs = 30_000 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./compose-pdf-worker.mjs', import.meta.url), { workerData: { bytes, ...range }, resourceLimits: { maxOldGenerationSizeMb: 128 } });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      void worker.terminate().then(() => error ? reject(error) : resolve(result));
    };
    const abort = () => finish(signal.reason || new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('PDF extraction timed out. Select fewer pages or continue without this document.')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', result => finish(result.error ? new Error(result.error) : null, result));
    worker.once('error', () => finish(new Error('PDF extraction failed. Select fewer pages or continue without this document.')));
    worker.once('exit', () => { if (!settled) finish(new Error('PDF extraction stopped. Continue without this document.')); });
  });
}

/** Markdown cut at its headings (outside code fences), so evidence can name the section it came from. */
export function markdownSections(text) {
  const pages = []; let fence = null, offset = 0, start = 0, section = '';
  const push = end => { const slice = text.slice(start, end); if (slice.trim()) pages.push({ page: 1, text: slice, offset: start, section }); };
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const plain = line.replace(/\n$/, ''), marker = plain.match(/^ {0,3}(`{3,}|~{3,})(.*)$/), heading = !fence && !marker && plain.match(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/);
    if (fence) { if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null; }
    else if (marker) fence = marker[1];
    if (heading) { push(offset); start = offset; section = heading[1].replace(/\\(.)/g, '$1').slice(0, 120); }
    offset += line.length;
  }
  push(text.length);
  return pages.length ? pages : [{ page: 1, text }];
}

/** Server-session cache; raw bytes are never stored or written to disk. */
export class ComposeDocuments {
  entries = new Map();
  constructor({ extractor = extractPdf } = {}) { this.extractor = extractor; }
  prune() { for (const [id, row] of this.entries) if (Date.now() - row.used > TTL) this.entries.delete(id); }
  get(id) { this.prune(); const row = this.entries.get(id); if (!row) invalid('This document expired. Add it again or continue without it.'); row.used = Date.now(); return row; }
  delete(id) { return this.entries.delete(id); }
  close() { this.entries.clear(); }
  async add(bytes, metadata, { signal } = {}) {
    const meta = documentMeta(metadata);
    if (!bytes.length || bytes.length > UPLOAD_BYTES) invalid('Choose a nonempty document up to 20 MiB.');
    if (meta.pdf && !bytes.subarray(0, 8).toString().startsWith('%PDF-')) invalid('This file is not a PDF.');
    const key = createHash('sha256').update(bytes).update(JSON.stringify([meta.from, meta.to, meta.name])).digest('hex');
    this.prune();
    for (const row of this.entries.values()) if (row.key === key) { row.used = Date.now(); return this.summary(row); }
    signal?.throwIfAborted();
    let extracted;
    if (meta.pdf) extracted = await this.extractor(bytes, { from: meta.from, to: meta.to }, { signal });
    else {
      if (bytes.length > 2_000_000) invalid('Text documents must be at most 2 MB.');
      let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { invalid('Use a UTF-8 text document.'); }
      if (!text.trim() || text.includes('\0')) invalid('This document has no usable text.');
      extracted = { pages: /\.md$/i.test(meta.name) ? markdownSections(text) : [{ page: 1, text }], pageCount: 1 };
    }
    signal?.throwIfAborted();
    const chars = extracted.pages.reduce((sum, page) => sum + page.text.length, 0);
    const row = { id: randomUUID(), key, name: meta.name, sourceType: meta.pdf ? 'pdf' : 'document', pages: extracted.pages, pageCount: extracted.pageCount,
      index: buildIndex(chunkPages(extracted.pages)), chars, used: Date.now() };
    while (this.entries.size >= 8 || [...this.entries.values()].reduce((sum, item) => sum + item.chars, 0) + chars > CACHE_CHARS) {
      const oldest = [...this.entries.values()].sort((a, b) => a.used - b.used)[0];
      if (!oldest) invalid('Document exceeds the cache limit.');
      this.entries.delete(oldest.id);
    }
    this.entries.set(row.id, row);
    return this.summary(row);
  }
  summary(row) { return { id: row.id, name: row.name, sourceType: row.sourceType, from: row.pages[0]?.page, to: row.pages.at(-1)?.page, pageCount: row.pageCount, chunks: row.index.rows.length }; }
}
