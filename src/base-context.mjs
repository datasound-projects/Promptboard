/** Bounded source capture and portable delivery. No state writes and no model calls. */
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { readFile, readdir, realpath, stat, mkdir, writeFile, rm, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, relative, isAbsolute, extname, join } from 'node:path';
import { BaseDeliveryError, assertBaseReady, checkBaseRevocations, baseDependencies } from './base-resolver.mjs';

const MAX_FILE = 256_000, MAX_TOTAL = 2_000_000;
const TEXT = new Set(['.md', '.mdx', '.txt', '.rst', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.yaml', '.yml', '.toml', '.css', '.html', '.py', '.go', '.rs', '.java', '.sh', '.sql']);
const OMIT = /^(?:\.git|\.env(?:\..*)?|\.ssh|\.aws|\.codex|\.claude|\.gemini|node_modules|vendor|dist|build|coverage|\.next|target|credentials(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore))$/i;
const digest = text => createHash('sha256').update(text).digest('hex');
const aborted = signal => { if (signal?.aborted) throw new BaseDeliveryError('Base preparation was cancelled.', 'ABORTED'); };
const contained = (root, target) => { const path = relative(root, target); return path === '' || (!path.startsWith('..') && !isAbsolute(path)); };
const blockedPath = path => path.split(/[\\/]/).some(part => OMIT.test(part));
async function cancellable(promise, signal) {
  aborted(signal); if (!signal) return promise;
  let cancel;
  try { return await Promise.race([promise, new Promise((_, reject) => { cancel = () => reject(new BaseDeliveryError('Source capture was cancelled or timed out.', 'ABORTED')); signal.addEventListener('abort', cancel, { once: true }); })]); }
  finally { signal.removeEventListener('abort', cancel); }
}

export function isPublicAddress(address) {
  if (address.startsWith('::ffff:')) return isPublicAddress(address.slice(7));
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && [0, 168].includes(b) || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19].includes(b));
  }
  if (isIP(address) === 6) return !/^(?:0*:0*:0*:0*:0*:0*:0*:0*[01]$|::|f[cd]|fe[89ab])/i.test(address);
  return false;
}

/** Resolve and pin a public address on every redirect; no cookies, auth, proxy, or private networks. */
export async function fetchDocument(value, { signal, maxBytes = MAX_FILE, lookupFn = lookup, requestFn = null } = {}) {
  const timeout = AbortSignal.timeout(12000), boundedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let url;
  try { url = new URL(value); } catch { throw new BaseDeliveryError('Use an absolute HTTP or HTTPS document URL.', 'BASE_INVALID_URL'); }
  for (let redirects = 0; redirects <= 3; redirects++) {
    aborted(boundedSignal);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search) throw new BaseDeliveryError('Document URLs must use HTTP(S), with no credentials or query parameters.', 'BASE_INVALID_URL');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    let addresses;
    try { addresses = await cancellable(lookupFn(hostname, { all: true, verbatim: true }), boundedSignal); } catch (error) { if (error.code === 'ABORTED') throw error; throw new BaseDeliveryError('The document host could not be resolved.', 'BASE_NETWORK_ERROR'); }
    if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new BaseDeliveryError('Document imports cannot contact local or private networks.', 'BASE_PRIVATE_NETWORK');
    const address = addresses[0];
    const result = await new Promise((done, reject) => {
      const req = (requestFn || (url.protocol === 'https:' ? httpsRequest : httpRequest))(url, { signal: boundedSignal, method: 'GET', headers: { Accept: 'text/plain, text/markdown, text/html;q=0.8', 'User-Agent': 'Promptboard-Base/1' }, lookup: (_host, options, callback) => options?.all ? callback(null, [address]) : callback(null, address.address, address.family) }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400) { res.resume(); if (!res.headers.location) reject(new BaseDeliveryError('Invalid document redirect.', 'BASE_HTTP_ERROR')); else done({ redirect: res.headers.location }); return; }
        if (res.statusCode !== 200) { res.resume(); reject(new BaseDeliveryError('The document server returned an error.', 'BASE_HTTP_ERROR')); return; }
        if (!/^(?:text\/|application\/(?:json|xml))/.test(res.headers['content-type'] || 'text/plain')) { res.resume(); reject(new BaseDeliveryError('This document format is unsupported; import Markdown or text.', 'BASE_UNSUPPORTED_FORMAT')); return; }
        let size = 0; const chunks = [];
        res.on('data', chunk => { size += chunk.length; if (size > Math.min(maxBytes, MAX_FILE)) req.destroy(new BaseDeliveryError('Document exceeds the source size limit.', 'BASE_SOURCE_LIMIT')); else chunks.push(chunk); });
        res.on('end', () => done({ text: Buffer.concat(chunks).toString('utf8'), contentType: res.headers['content-type'] || 'text/plain' }));
        res.on('error', reject);
      });
      req.on('error', error => reject(error instanceof BaseDeliveryError ? error : new BaseDeliveryError(boundedSignal.aborted ? 'Document request was cancelled or timed out.' : 'Document request failed.', boundedSignal.aborted ? 'ABORTED' : 'BASE_NETWORK_ERROR')));
      req.end();
    });
    if (result.redirect) { url = new URL(result.redirect, url); continue; }
    if (result.redirect === '') throw new BaseDeliveryError('Invalid document redirect.', 'BASE_HTTP_ERROR');
    // HTML is retained only as inert plain text. The UI never inserts this text as HTML.
    const text = result.contentType?.includes('text/html') ? result.text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ') : result.text;
    return { id: digest(url.href).slice(0, 24), name: url.pathname.split('/').pop() || url.hostname, text, provenance: { url: url.href, retrievedAt: Date.now(), contentHash: digest(text), format: result.contentType } };
  }
  throw new BaseDeliveryError('Document redirected too many times.', 'BASE_HTTP_ERROR');
}

export async function captureSources(definition, { workspacePath, approvedRoots = [], signal, readRevision, resources = [] } = {}) {
  const result = [], omitted = []; let bytes = 0, walked = 0;
  const limit = Math.min(100, definition.configuration?.maxFiles || 30);
  async function local(root, selection, source) {
    if (!root) throw new BaseDeliveryError('Choose a repository or approved external root for this context source.', 'BASE_SOURCE_UNAVAILABLE');
    const rootPath = await realpath(root), start = resolve(rootPath, selection || '.');
    if (!contained(rootPath, start) || blockedPath(selection || '')) throw new BaseDeliveryError('Context source path is outside its root or contains excluded secret/generated files.', 'BASE_SOURCE_FORBIDDEN');
    async function visit(path) {
      aborted(signal);
      if (++walked > 4000) { omitted.push('Folder traversal limit reached.'); return; }
      const rel = relative(rootPath, path);
      if (blockedPath(rel)) { omitted.push(rel); return; }
      const actual = await realpath(path);
      if (!contained(rootPath, actual) || blockedPath(relative(rootPath, actual))) throw new BaseDeliveryError('A context source symlink escapes the approved root or points to an excluded file.', 'BASE_SOURCE_FORBIDDEN');
      const info = await stat(actual);
      if (info.isDirectory()) {
        if (path !== start && actual !== path) { omitted.push(`${rel} (directory symlink)`); return; }
        const children = await readdir(actual, { withFileTypes: true });
        for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
          if (walked >= 4000 || result.length >= limit) { omitted.push(`${rel || '.'} (selection limit)`); break; }
          await visit(join(actual, child.name));
        }
      } else if (info.isFile()) {
        if (!TEXT.has(extname(actual).toLowerCase()) && !/^(?:README|LICENSE|Makefile)$/i.test(actual.split(/[\\/]/).pop())) { omitted.push(rel); return; }
        if (info.size > MAX_FILE || bytes + info.size > MAX_TOTAL || result.length >= limit) { omitted.push(rel); return; }
        // Open the resolved file without following a final symlink; compare identity and
        // re-check containment after opening to catch common replacement races.
        const handle = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        let text;
        try {
          const opened = await handle.stat(), latest = await realpath(path);
          if (latest !== actual || !contained(rootPath, latest) || opened.dev !== info.dev || opened.ino !== info.ino || opened.size > MAX_FILE || bytes + opened.size > MAX_TOTAL) throw new BaseDeliveryError('The source changed during capture; retry after it is stable.', 'BASE_SOURCE_CHANGED');
          const buffer = Buffer.alloc(MAX_FILE + 1); const read = await handle.read(buffer, 0, buffer.length, 0); aborted(signal);
          if (read.bytesRead > MAX_FILE) throw new BaseDeliveryError('Source grew beyond the file limit.', 'BASE_SOURCE_LIMIT');
          text = buffer.subarray(0, read.bytesRead).toString('utf8');
        } finally { await handle.close(); }
        if (text.includes('\0')) { omitted.push(rel); return; }
        bytes += Buffer.byteLength(text);
        result.push({ id: digest(`${source.kind}:${source.rootId || ''}:${rel}`).slice(0, 24), name: rel, text, provenance: { kind: source.kind, path: rel, ...(source.rootId ? { rootId: source.rootId } : {}), retrievedAt: Date.now(), contentHash: digest(text) } });
      }
    }
    await visit(start);
  }
  const configuredSources = definition.configuration?.sources || [];
  for (const [sourceIndex, source] of configuredSources.entries()) {
    aborted(signal);
    if (source.kind === 'repository') await local(workspacePath, source.path, source);
    else if (source.kind === 'external') {
      const approved = approvedRoots.find(root => root.id === source.rootId && root.enabled !== false);
      if (!approved) throw new BaseDeliveryError('External root approval is missing or revoked.', 'BASE_ROOT_NOT_APPROVED');
      await local(approved.path, source.path, source);
    } else if (source.kind === 'url') { const doc = await fetchDocument(source.url, { signal }); if (bytes + Buffer.byteLength(doc.text) > MAX_TOTAL) omitted.push(source.url); else { bytes += Buffer.byteLength(doc.text); result.push(doc); } }
    else if (source.kind === 'knowledge') {
      const resource = resources.find(value => value.id === source.resourceId || value.resourceId === source.resourceId);
      if (!resource || !readRevision) throw new BaseDeliveryError('Knowledge source is unavailable.', 'BASE_SOURCE_UNAVAILABLE');
      const loaded = await readRevision(resource.revisionRef);
      for (const page of loaded.content?.pages || []) {
        if (source.pageId && page.id !== source.pageId) continue;
        const size = Buffer.byteLength(page.markdown);
        if (result.length >= limit || size > MAX_FILE || bytes + size > MAX_TOTAL) { omitted.push(page.id); continue; }
        bytes += size; result.push({ id: page.id, name: page.title, text: page.markdown, provenance: { resourceId: source.resourceId, revision: loaded.revision, section: page.id, contentHash: digest(page.markdown), retrievedAt: Date.now() } });
      }
      if (source.pageId && !loaded.content?.pages?.some(page => page.id === source.pageId)) throw new BaseDeliveryError('The selected knowledge page is unavailable.', 'BASE_SOURCE_UNAVAILABLE');
      if (loaded.content?.body && !source.pageId) {
        const size = Buffer.byteLength(loaded.content.body);
        if (result.length >= limit || size > MAX_FILE || bytes + size > MAX_TOTAL) omitted.push(loaded.id);
        else { bytes += size; result.push({ id: loaded.id, name: loaded.name, text: loaded.content.body, provenance: { resourceId: loaded.id, revision: loaded.revision, contentHash: digest(loaded.content.body), retrievedAt: Date.now() } }); }
      }
    }
    if (result.length >= limit) { omitted.push(...configuredSources.slice(sourceIndex + 1).map(item => item.path || item.url || item.resourceId || 'source')); break; }
  }
  return { sources: result.slice(0, limit), omitted, bytes, warnings: [] };
}

// Hash-keyed local lexical cache: bounded, no model/embedding calls and no repeated indexing on render.
const indexes = new Map();
export function searchSources(sources, query = '', { budgetChars = 24000 } = {}) {
  const terms = [...new Set(String(query).toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || [])];
  const chunks = [], skipped = sources.slice(100).map(source => ({ sourceId: source.id, reason: 'index source limit' }));
  let indexedBytes = 0;
  for (const source of sources.slice(0, 100)) {
    const size = Buffer.byteLength(source.text || '');
    if (indexedBytes + size > MAX_TOTAL) { skipped.push({ sourceId: source.id, reason: 'index byte limit' }); continue; }
    indexedBytes += size;
    const hash = digest(source.text || ''); let index = indexes.get(hash);
    if (!index) { index = (source.text || '').match(/[\s\S]{1,1800}(?:\n|$)|[\s\S]{1,1800}/g)?.map((text, i) => ({ text, section: i + 1, lower: text.toLowerCase() })) || []; indexes.set(hash, index); if (indexes.size > 64) indexes.delete(indexes.keys().next().value); }
    for (const part of index) chunks.push({ ...part, sourceId: source.id, name: source.name, provenance: { ...(source.provenance || {}), contentHash: hash, section: part.section }, score: terms.reduce((n, term) => n + (part.lower.split(term).length - 1), 0) });
  }
  chunks.sort((a, b) => b.score - a.score);
  let used = 0; const selected = [], omitted = skipped;
  for (const { lower: _lower, ...part } of chunks) {
    if (used + part.text.length > budgetChars) { omitted.push({ sourceId: part.sourceId, section: part.section, chars: part.text.length }); continue; }
    selected.push(part); used += part.text.length;
  }
  return { selected, omitted, chars: used, estimatedTokens: Math.ceil(used / 4), tokenCountIsEstimate: true };
}

export function lexicalSearch(sources, query, { limit = 20 } = {}) { return searchSources(sources, query, { budgetChars: Math.min(limit, 50) * 1800 }).selected.slice(0, limit); }

export async function prepareBase({ manifest, readRevision, currentResources = [], workspacePath, runDir, signal, approvedRoots = [], contextBudget = 48000, query = '' }) {
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
  assertBaseReady(manifest); checkBaseRevocations(manifest, currentResources, approvedRoots); aborted(signal);
  const prepared = structuredClone(manifest), sections = [], mcpServers = [];
  const owned = join(runDir, 'base-context'); let remaining = Math.max(0, Math.min(100000, contextBudget));
  // Captures are evidence artifacts, retained with the run. Only generated configuration is temporary.
  const cleanup = async ({ discardCaptures = false } = {}) => { await Promise.all([rm(join(runDir, 'base-claude-mcp.json'), { force: true }), rm(join(runDir, 'gemini-system-settings.json'), { force: true }), ...(discardCaptures ? [rm(owned, { recursive: true, force: true })] : [])]); };
  try {
    const definitions = new Map(), ordered = [], visited = new Set(); let definitionBytes = 0;
    for (const entry of prepared.resources || []) if (entry.status === 'ready') {
      aborted(signal);
      try {
        const definition = await cancellable(readRevision(entry.revisionRef), signal);
        const size = Buffer.byteLength(JSON.stringify(definition));
        if (definitionBytes + size > 8_000_000) throw new BaseDeliveryError('Selected Base definitions exceed the preparation size limit.', 'BASE_DEFINITION_LIMIT');
        definitionBytes += size; definitions.set(entry.resourceId, definition);
      }
      catch (error) {
        if (entry.required) throw error;
        entry.status = 'omitted'; entry.issues.push('Pinned resource content could not be loaded.');
        prepared.warnings.push({ resourceId: entry.resourceId, code: 'BASE_CONTENT_UNAVAILABLE', message: 'Pinned resource content could not be loaded.' });
      }
    }
    function order(entry) {
      if (visited.has(entry.resourceId)) return;
      visited.add(entry.resourceId);
      for (const dep of baseDependencies(definitions.get(entry.resourceId))) { const item = prepared.resources.find(value => value.resourceId === dep.resourceId); if (item) order(item); }
      ordered.push(entry);
    }
    for (const entry of prepared.resources || []) order(entry);
    for (const entry of ordered) {
      if (entry.status !== 'ready') continue;
      aborted(signal);
      try {
        const definition = definitions.get(entry.resourceId); aborted(signal);
        for (const dep of baseDependencies(definition)) if (dep.required !== false && prepared.resources.find(item => item.resourceId === dep.resourceId)?.status !== 'ready') throw new BaseDeliveryError('A dependency failed preparation; its dependent resource was not supplied.', 'BASE_DEPENDENCY_FAILED');
        const content = definition.content || {}, cfg = definition.configuration || {};
        let text = '', captures = [], omitted = [];
        if (entry.kind === 'mcp') {
          for (const ref of [...Object.values(cfg.env || {}), ...Object.values(cfg.headers || {})]) if (!process.env[ref]) throw new BaseDeliveryError('A declared MCP environment reference is unavailable.', 'BASE_AUTH_REQUIRED');
          mcpServers.push({ name: `pb_${entry.resourceId.replace(/[^A-Za-z0-9_]/g, '_')}`, resourceId: entry.resourceId, required: entry.required, configuration: cfg });
        } else if (entry.kind === 'skill') {
          text = content.body || content.files?.find(file => file.path === 'SKILL.md')?.text || '';
          if (!text) throw new BaseDeliveryError('Skill instructions are empty or unavailable.', 'BASE_CONTENT_UNAVAILABLE');
          for (const file of content.files || []) if (file.path !== 'SKILL.md') text += `\n\nSupporting file ${file.path} (reference text; scripts are not executed):\n${file.text}`;
        } else if (entry.kind === 'profile') text = cfg.agent?.instructions || '';
        else if (entry.kind === 'tool') text = cfg.delivery === 'mcp' ? `MCP tool reference: ${cfg.toolName} on ${cfg.serverId}. This reference does not filter out other tools from that server.` : `Command recipe (not a registered native tool; existing shell permissions apply):\n${JSON.stringify([cfg.command, ...(cfg.args || [])])}\n${content.body || ''}`;
        else if ((entry.kind === 'knowledge' && entry.delivery !== 'dependency-definition') || entry.kind === 'context') {
          let sources = [...(content.sources || []), ...(content.pages || []).map(page => ({ id: page.id, name: page.title, text: page.markdown, provenance: { ...(page.provenance || {}), resourceId: entry.resourceId, revision: entry.revision } }))];
          if (content.body) sources.unshift({ id: definition.id, name: definition.name, text: content.body, provenance: { resourceId: entry.resourceId, revision: entry.revision } });
          if (entry.kind === 'context') { const captured = await captureSources(definition, { workspacePath, approvedRoots, signal, readRevision, resources: prepared.resources }); sources = captured.sources; omitted.push(...captured.omitted); }
          const retrieved = searchSources(sources, cfg.query || query, { budgetChars: Math.min(remaining, cfg.budgetChars || 24000) });
          text = retrieved.selected.map(part => `Source: ${part.name} · section ${part.section}\n${part.text}`).join('\n\n');
          captures = retrieved.selected.map(part => ({ sourceId: part.sourceId, ...part.provenance, capturedAt: Date.now() })); omitted.push(...retrieved.omitted);
          if (!text && entry.required) throw new BaseDeliveryError('A required context resource has no material within the context budget.', 'BASE_CONTEXT_EMPTY');
        }
        if (text.length > remaining) throw new BaseDeliveryError('The Base context budget cannot fit this resource; task text and evidence were preserved.', 'BASE_CONTEXT_BUDGET');
        const supplied = { resourceId: entry.resourceId, revision: entry.revision, delivery: entry.delivery, captures, omitted, chars: text.length, estimatedTokens: Math.ceil(text.length / 4), tokenCountIsEstimate: true };
        if (text) {
          await mkdir(owned, { recursive: true, mode: 0o700 });
          const file = `${entry.resourceId}.txt`;
          if (!/^[A-Za-z0-9_-]+\.txt$/.test(file)) throw new BaseDeliveryError('Invalid pinned resource identifier.', 'BASE_INVALID_RESOURCE');
          await writeFile(join(owned, file), text, { mode: 0o600, signal });
          supplied.contextRef = `base-context/${file}`; supplied.contentHash = digest(text);
          sections.push(`--- ${entry.name} (${entry.delivery}; revision ${entry.revision}) ---\n${text}\n--- End resource ---`); remaining -= text.length;
        }
        if (text || entry.kind === 'mcp') prepared.supplied.push(supplied);
        if (omitted.length) prepared.warnings.push({ resourceId: entry.resourceId, code: 'BASE_CONTEXT_OMITTED', message: `${omitted.length} source sections/files were omitted by selection or budget.` });
      } catch (error) {
        if (signal?.aborted || error.code === 'ABORTED' || entry.required) throw error;
        entry.status = 'omitted'; const message = error instanceof BaseDeliveryError ? error.message : 'Resource preparation failed.';
        entry.issues.push(message); prepared.warnings.push({ resourceId: entry.resourceId, code: error.code || 'BASE_PREPARATION_FAILED', message });
      }
    }
    aborted(signal); prepared.preparedAt = Date.now();
    return { sections: sections.join('\n\n'), mcpServers, manifest: prepared, cleanup };
  } catch (error) { await cleanup({ discardCaptures: true }); throw error instanceof BaseDeliveryError ? error : new BaseDeliveryError('Base resource preparation failed.', signal?.aborted ? 'ABORTED' : 'BASE_PREPARATION_FAILED'); }
}
