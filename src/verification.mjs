/**
 * Deterministic checks for recognizable exact source literals.
 * These checks do not establish meaning, requirement coverage, or STE compliance.
 * Wrap important text in backticks or double quotes to make its boundary explicit.
 */

import { COMPOSE_PROMPT_CHARS, VERIFICATION_OUTPUT_CHARS } from './compose-limits.mjs';
const MAX_SOURCE = COMPOSE_PROMPT_CHARS;
const MAX_OUTPUT = VERIFICATION_OUTPUT_CHARS;
const FILE_EXTENSIONS = new Set(('astro bash bat c cc cfg cjs clj cmake cmd conf cpp cs css csv cts doc docx env fish fs fsx gif go gql graphql gz h hpp htm html ico ini ipynb java jpeg jpg js json json5 jsonl jsx kt kts less lock log lua m map md mdx mjs mm mts php pl png proto ps1 py pyi r rb res rs sass scala scss sh sql svelte svg swift tar tex toml ts tsv tsx txt vue wasm webp xml yaml yml zip zsh').split(' '));
const FILE_NAMES = new Set(['Dockerfile', 'Containerfile', 'Makefile', 'Gemfile', 'Rakefile', 'Procfile', 'LICENSE', 'COPYING', '.env', '.gitignore', '.gitattributes', '.gitmodules', '.editorconfig', '.npmrc', '.nvmrc', '.prettierrc', '.eslintrc']);
const DIRECTORY_NAMES = new Set(['src', 'lib', 'app', 'apps', 'api', 'bin', 'build', 'dist', 'doc', 'docs', 'examples', 'include', 'packages', 'public', 'scripts', 'test', 'tests', 'vendor', 'node_modules', '.github', '.git', '.config']);
const DELIMITED_KINDS = new Set(['fenced-code', 'inline-code', 'quoted-text']);

function sourceText(input) {
  if (typeof input !== 'string') throw new TypeError('The source must be text.');
  if (input.length > MAX_SOURCE) throw new RangeError(`The source must contain at most ${MAX_SOURCE.toLocaleString('en-US')} characters.`);
  if (input.includes('\0')) throw new TypeError('The source must not contain a null character.');
  return input.replace(/\r\n/g, '\n');
}

function escapedAt(text, index) {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) count++;
  return count % 2 === 1;
}

/** Remove likely sentence punctuation, but retain balanced URL/path parentheses. */
function trimToken(token) {
  const balance = { ')': 0, ']': 0, '}': 0 };
  const pairs = { '(': ')', '[': ']', '{': '}' };
  for (const character of token) {
    if (Object.hasOwn(pairs, character)) balance[pairs[character]]--;
    else if (Object.hasOwn(balance, character)) balance[character]++;
  }
  let end = token.length;
  while (end > 0) {
    const character = token[end - 1];
    if (/[.,;:!?([{]/u.test(character)) end--; // Also a link's opening bracket: [path](url
    else if (balance[character] > 0) { balance[character]--; end--; }
    else break;
  }
  return token.slice(0, end);
}

function recognizedPath(text) {
  if (/^(?:[A-Za-z]:[\\/]|\\\\|~\/|\.{1,2}\/|\/)/u.test(text)) return text.length > 1;
  const segments = text.split(/[\\/]/u);
  if (segments.length < 2) return false;
  if (segments.some(segment => segment === '')) return false;
  const filename = segments.at(-1);
  return segments.length >= 3 || DIRECTORY_NAMES.has(segments[0])
    || /\.[\p{L}][\p{L}\p{N}_-]{0,15}$/u.test(filename);
}

function recognizedFilename(text) {
  if (FILE_NAMES.has(text)) return true;
  const extension = text.match(/\.([A-Za-z][A-Za-z0-9]*)$/u)?.[1]?.toLowerCase();
  return FILE_EXTENSIONS.has(extension);
}

/**
 * Return unique literal contents in source order. Delimiters are not contents.
 * Recognized categories: fenced code, inline code, double-quoted text, HTTP(S)
 * URLs, and recognizable file paths/names. Nested tokens are not counted twice.
 * Fence delimiter line breaks are excluded; all internal whitespace is retained.
 * Bare paths with spaces, arbitrary identifiers, numbers, and natural-language
 * requirements need explicit delimiters or human/model review.
 */
export function extractProtectedLiterals(input) {
  return extractFromNormalized(sourceText(input));
}

function extractFromNormalized(source) {
  const masked = source.split('');
  const occupied = new Uint8Array(source.length);
  const spans = [];
  let fencePrefix;

  function add(kind, text, start, end) {
    for (let index = start; index < end; index++) {
      occupied[index] = 1;
      if (masked[index] !== '\n') masked[index] = ' ';
    }
    if (text.trim()) spans.push({ kind, text, start });
  }
  function intersects(start, end) {
    return fencePrefix[end] !== fencePrefix[start];
  }

  // Fence parsing is line based so a longer closing fence and Unicode bodies work.
  const lines = source.split('\n');
  const offsets = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  for (let index = 0; index < lines.length; index++) {
    const opening = lines[index].match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (!opening || (opening[1][0] === '`' && opening[2].includes('`'))) continue;
    let closing = index + 1;
    for (; closing < lines.length; closing++) {
      const candidate = lines[closing].match(/^ {0,3}(`+|~+)[ \t]*$/u);
      if (candidate && candidate[1][0] === opening[1][0] && candidate[1].length >= opening[1].length) break;
    }
    const bodyStart = offsets[index] + lines[index].length + 1;
    const bodyEnd = closing < lines.length ? offsets[closing] : source.length;
    let body = source.slice(bodyStart, bodyEnd);
    if (closing < lines.length && body.endsWith('\n')) body = body.slice(0, -1);
    const spanEnd = closing < lines.length ? offsets[closing] + lines[closing].length : source.length;
    add('fenced-code', body, offsets[index], spanEnd);
    index = closing;
  }

  // The first enclosing delimiter wins: quote contents can contain inline code,
  // and inline code can contain quotes, without creating duplicate requirements.
  let remaining = masked.join('');
  fencePrefix = new Uint32Array(source.length + 1);
  for (let index = 0; index < source.length; index++) fencePrefix[index + 1] = fencePrefix[index] + occupied[index];
  const ticks = [...remaining.matchAll(/`+/gu)];
  const nextTick = new Map();
  const nextLength = new Map();
  for (let index = ticks.length - 1; index >= 0; index--) {
    const tick = ticks[index];
    nextTick.set(tick.index, { size: tick[0].length, closing: nextLength.get(tick[0].length) ?? -1 });
    nextLength.set(tick[0].length, tick.index);
  }
  const quotes = new Map(['"', '“', '”'].map(character => [character, []]));
  for (const match of remaining.matchAll(/["“”]/gu)) {
    if (!escapedAt(source, match.index)) quotes.get(match[0]).push(match.index);
  }
  function nextQuote(character, after) {
    const positions = quotes.get(character);
    let low = 0;
    let high = positions.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (positions[middle] <= after) low = middle + 1;
      else high = middle;
    }
    return positions[low] ?? remaining.length;
  }
  for (let index = 0; index < remaining.length; index++) {
    const character = remaining[index];
    if (character === '`') {
      const { size, closing: found } = nextTick.get(index);
      if (escapedAt(source, index)) { index += size - 1; continue; }
      if (found !== -1 && !intersects(index, found + size)) {
        add('inline-code', source.slice(index + size, found), index, found + size);
        index = found + size - 1;
      } else index += size - 1;
      continue;
    }
    if (!['"', '“', '„'].includes(character) || escapedAt(source, index)) continue;
    if (character === '"' && /[\p{L}\p{N}_]/u.test(source[index - 1] || '')) continue;
    const closingCharacters = character === '"' ? ['"'] : character === '“' ? ['”'] : ['“', '”'];
    const closing = Math.min(...closingCharacters.map(close => nextQuote(close, index)));
    if (closing < remaining.length && !intersects(index, closing + 1)) {
      add('quoted-text', source.slice(index + 1, closing), index, closing + 1);
      index = closing;
    }
  }

  remaining = masked.join('');
  for (const match of remaining.matchAll(/\bhttps?:\/\/[^\s<>`"“”„]+/giu)) {
    let text = trimToken(match[0]);
    if (source[match.index - 1] === "'" && text.endsWith("'")) text = text.slice(0, -1);
    try {
      const url = new URL(text);
      if (!url.hostname || !['http:', 'https:'].includes(url.protocol)) continue;
    } catch { continue; }
    add('url', text, match.index, match.index + text.length);
  }

  remaining = masked.join('');
  const pathPattern = /(?<![\p{L}\p{N}_.@+:/\\-])(?:[A-Za-z]:[\\/]|\\\\|~\/|\.{1,2}\/|\/|[\p{L}\p{N}_@.-]+[\\/])[^\s<>`"“”„]+/gu;
  for (const match of remaining.matchAll(pathPattern)) {
    let text = trimToken(match[0]);
    if (source[match.index - 1] === "'" && text.endsWith("'")) text = text.slice(0, -1);
    if (recognizedPath(text)) add('path', text, match.index, match.index + text.length);
  }
  remaining = masked.join('');
  for (const match of remaining.matchAll(/(?<![\p{L}\p{N}_.@+:/\\-])[\p{L}\p{N}_.-]+/gu)) {
    const text = trimToken(match[0]);
    if (recognizedFilename(text)) add('path', text, match.index, match.index + text.length);
  }

  const unique = new Map();
  for (const { kind, text } of spans.sort((a, b) => a.start - b.start)) {
    const previous = unique.get(text);
    if (!previous || (DELIMITED_KINDS.has(kind) && !DELIMITED_KINDS.has(previous.kind))) {
      unique.set(text, { kind, text });
    }
  }
  return [...unique.values()];
}

function shortExcerpt(text) {
  return text.length <= 160 ? text : text.slice(0, 157) + '…';
}

function hasExactLiteral(output, literal) {
  let cursor = 0;
  while (cursor <= output.length - literal.text.length) {
    const index = output.indexOf(literal.text, cursor);
    if (index === -1) return false;
    // A path/URL prefix inside a changed token is not an unchanged token.
    const before = output[index - 1] || '';
    const after = output[index + literal.text.length] || '';
    const afterNext = output[index + literal.text.length + 1] || '';
    const attachedBefore = /[\p{L}\p{N}_./\\@+%=-]/u.test(before);
    const attachedAfter = /[\p{L}\p{N}_/\\@+%=&~#-]/u.test(after)
      || (/[.?:]/u.test(after) && /[^\s<>`"'“”„)\]}]/u.test(afterNext) && afterNext !== '');
    if (!attachedBefore && !attachedAfter) return true;
    cursor = index + 1;
  }
  return false;
}

/**
 * A pass means only that output bounds and recognized literal checks passed.
 * It never means that every requirement survived or that the output follows STE.
 * Explicit source literals need a complete matching delimited output span. A
 * command extended inside the same code span is not the unchanged original.
 */
export function verifyPrompt(input, output, language = 'en') {
  const literals = extractProtectedLiterals(input);
  const isText = typeof output === 'string';
  const withinBounds = isText && output.length <= MAX_OUTPUT;
  const nonempty = isText && output.trim().length > 0;
  const noNull = isText && !output.includes('\0');
  const validOutput = withinBounds && nonempty && noNull;
  const normalized = validOutput ? output.replace(/\r\n/g, '\n') : '';
  const outputDelimited = new Set(validOutput ? extractFromNormalized(normalized)
    .filter(literal => DELIMITED_KINDS.has(literal.kind)).map(literal => literal.text) : []);
  const missing = validOutput ? literals.filter(literal => DELIMITED_KINDS.has(literal.kind)
    ? !outputDelimited.has(literal.text) : !hasExactLiteral(normalized, literal)) : literals;
  const issues = [];
  if (!isText || !nonempty) issues.push({ rule: 'output-content', message: 'The model must return a nonempty text prompt.' });
  if (isText && !withinBounds) issues.push({ rule: 'output-size', message: `The model output must contain at most ${MAX_OUTPUT.toLocaleString('en-US')} characters.` });
  if (isText && !noNull) issues.push({ rule: 'output-null', message: 'The model output must not contain a null character.' });
  if (validOutput) {
    for (const literal of missing) {
      issues.push({
        rule: 'protected-literal',
        message: DELIMITED_KINDS.has(literal.kind)
          ? `The output does not preserve this ${literal.kind} literal as a complete code or quoted span. Keep its exact original contents in delimiters, even when requesting a change.`
          : `The output does not preserve this ${literal.kind} literal exactly. Keep the original text as context even when requesting a change.`,
        excerpt: shortExcerpt(literal.text),
      });
    }
  }
  const checks = [
    { id: 'output-content', status: nonempty ? 'pass' : 'fail' },
    { id: 'output-size', status: withinBounds ? 'pass' : 'fail' },
    { id: 'output-null', status: noNull ? 'pass' : 'fail' },
    { id: 'protected-literals', status: !validOutput || !literals.length ? 'not-applicable' : missing.length ? 'fail' : 'pass', count: literals.length },
    { id: 'meaning-and-requirements', status: 'not-applicable' },
    { id: language === 'en' ? 'full-ste-compliance' : 'english-ste-not-applicable', status: 'not-applicable' },
  ];
  return {
    status: issues.length ? 'issues' : 'pass',
    checks,
    issues,
    protectedCount: literals.length,
    matchedCount: validOutput ? literals.length - missing.length : 0,
    reviewRequired: true,
  };
}
