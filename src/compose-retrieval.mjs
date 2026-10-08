import { CONTEXT_CHARS } from './compose-grounding.mjs';

const stop = new Set('a an and are as at be by can do for from how i in is it of on or our should that the this to use using we what which with you your der die das ein eine und oder mit von für ist wie was wir czy i w z na do jest the service implement build create'.split(' '));
export function terms(text) { return (text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []).filter(word => word.length > 1 && !stop.has(word)); }

/** Page-local, paragraph-aware chunks. Character estimates avoid a tokenizer dependency. */
export function chunkPages(pages, { target = 2800, overlap = 280 } = {}) {
  const chunks = [];
  for (const page of pages) {
    const text = page.text.trim();
    // Pages cut from one longer text (Markdown sections) report offsets in that whole text.
    const shift = page.offset === undefined ? 0 : page.offset + page.text.length - page.text.trimStart().length;
    for (let start = 0; start < text.length;) {
      let end = Math.min(text.length, start + target);
      if (end < text.length) {
        const paragraph = text.lastIndexOf('\n\n', end), space = text.lastIndexOf(' ', end);
        if (paragraph > start + target / 2) end = paragraph;
        else if (space > start + target / 2) end = space;
        // Do not cut a surrogate pair.
        if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      }
      chunks.push({ text: text.slice(start, end).trim(), page: page.page, start: start + shift, end: end + shift, section: page.section || '' });
      if (end === text.length) break;
      start = Math.max(start + 1, end - overlap);
      if (/[\uDC00-\uDFFF]/.test(text[start])) start++;
    }
  }
  return chunks;
}

export function buildIndex(chunks) {
  const df = new Map();
  const rows = chunks.map((chunk, order) => {
    const words = terms(chunk.text + (chunk.file ? `\n${chunk.file}` : '')), tf = new Map();
    for (const word of words) tf.set(word, (tf.get(word) || 0) + 1);
    for (const word of tf.keys()) df.set(word, (df.get(word) || 0) + 1);
    return { ...chunk, order, tf, length: words.length };
  });
  return { rows, df, average: rows.reduce((sum, row) => sum + row.length, 0) / (rows.length || 1) || 1 };
}

export function search(index, query, limit = 4) {
  const words = [...new Set(terms(query))];
  if (!words.length) return [];
  return index.rows.map(row => {
    let score = 0, matched = 0;
    for (const word of words) {
      const count = row.tf.get(word) || 0;
      if (!count) continue;
      matched++;
      const idf = Math.log(1 + (index.rows.length - index.df.get(word) + .5) / (index.df.get(word) + .5));
      score += idf * count * 2.2 / (count + 1.2 * (.25 + .75 * row.length / index.average));
    }
    return { ...row, score: score * matched / words.length, matched };
  }).filter(row => row.matched >= Math.min(2, words.length) && row.matched / words.length >= .2)
    .sort((a, b) => b.score - a.score || a.order - b.order).slice(0, limit).map(({ tf, length, order, matched, ...row }) => row);
}

function similar(a, b) {
  if (a === b) return true;
  const left = new Set(terms(a)), right = new Set(terms(b));
  const intersection = [...left].filter(word => right.has(word)).length;
  return intersection / Math.max(1, left.size + right.size - intersection) > .82;
}

/** Rank, merge duplicate provenance and trim before anything reaches the model. */
export function budgetEvidence(candidates, budget = CONTEXT_CHARS) {
  const result = [];
  for (const row of [...candidates].sort((a, b) => b.score - a.score)) {
    const { score, start, end, page, section, ...item } = row;
    const existing = result.find(other => similar(other.text, item.text));
    if (existing) {
      const backup = JSON.stringify(existing);
      existing.questionIds = [...new Set([...(existing.questionIds || []), ...(item.questionIds || [])])].slice(0, 32);
      if (!item.provisional) delete existing.provisional;
      if (existing.source !== item.source || existing.locator !== item.locator || existing.sourceType !== item.sourceType || existing.purpose !== item.purpose) {
        const origin = { sourceType: item.sourceType, source: item.source, locator: item.locator, ...(item.purpose ? { purpose: item.purpose } : {}) };
        existing.alsoFrom ??= [];
        if (!existing.alsoFrom.some(o => JSON.stringify(o) === JSON.stringify(origin)) && existing.alsoFrom.length < 8) existing.alsoFrom.push(origin);
      }
      if (JSON.stringify(result).length > budget) result[result.indexOf(existing)] = JSON.parse(backup);
      continue;
    }
    if (result.length < 40 && JSON.stringify([...result, item]).length <= budget) result.push(item);
  }
  return result;
}
