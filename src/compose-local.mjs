/** Explicitly selected local folders; read-only, bounded, secret-filtered and symlink-free. */
import { opendir, realpath, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, relative, extname } from 'node:path';
import { homedir } from 'node:os';
import { invalid, object, string } from './compose-grounding.mjs';
import { buildIndex, chunkPages, search } from './compose-retrieval.mjs';

const SKIP = new Set(['.git', 'node_modules', 'vendor', '.venv', 'venv', 'dist', 'build', 'coverage', '.next', '.cache', '.aws', '.ssh', '.gnupg', '__pycache__']);
const TEXT = new Set(['.md', '.txt', '.json', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.toml', '.yaml', '.yml', '.rs', '.go', '.java', '.sql', '.html', '.css', '.cs', '.rb', '.php', '.sh', '.mod', '.c', '.h', '.cpp', '.kt', '.swift', '.vue', '.svelte']);
const SECRET_FILE = /(^|\/)(\.env(?:\..*)?|\.npmrc|\.pypirc|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa.*|id_ed25519.*|.*\.(?:pem|key|p12|pfx)|.*\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i;
export function validateLocal(source) {
  object(source, ['type', 'name', 'path', 'kind', 'purpose'], 'local folder');
  if (source.type !== 'local' || !['repository', 'knowledge'].includes(source.kind)) invalid('Choose a repository or documentation folder.');
  string(source.path, 2000, 'local folder path'); string(source.name, 80, 'local source name');
  if (!isAbsolute(source.path) || source.path === '/' || source.path.replace(/\/$/, '') === homedir() || /^[A-Za-z]:[\\/]?$/.test(source.path)) invalid('Choose a specific project or documentation folder, not a home or filesystem root.');
  if (source.purpose !== undefined && !['reference', 'target'].includes(source.purpose)) invalid('Choose Reference or Target project.');
  if (source.kind === 'knowledge' && source.purpose === 'target') invalid('Knowledge folders are reference material.');
  return { ...source, purpose: source.purpose ?? 'reference' };
}
export function redactLocal(text) {
  return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[private key omitted]')
    .replace(/((?:api[_-]?key|secret|password|token|authorization|access[_-]?key)\s*["']?\s*[:=]\s*)["']?[^\s,;"'\n]+["']?/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@');
}
const inside = (root, path) => { const rel = relative(root, path); return rel !== '..' && !/^\.\.[\\/]/.test(rel) && !isAbsolute(rel); };
export class ComposeLocal {
  cache = new Map();
  close() { this.cache.clear(); }
  async index(source, { signal, refresh = false } = {}) {
    const cfg = validateLocal(source); signal?.throwIfAborted();
    const root = await realpath(cfg.path);
    if (root === homedir() || relative(root, join(root, '..')) === '') invalid('Choose a specific local folder.');
    if (!(await lstat(root)).isDirectory()) invalid('Choose a local folder.');
    const cached = this.cache.get(root);
    if (!refresh && cached && Date.now() - cached.at < 30_000) return cached.value;
    const files = []; let entries = 0, truncated = false;
    const walk = async (dir, depth) => {
      signal?.throwIfAborted();
      if (depth > 8 || entries >= 1500) { truncated = true; return; }
      const children = [];
      for await (const child of await opendir(dir)) { children.push(child); if (children.length >= 1500 - entries) { truncated = true; break; } }
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        signal?.throwIfAborted();
        if (++entries > 1500) { truncated = true; break; }
        const path = join(dir, child.name), rel = relative(root, path).replaceAll('\\', '/');
        if (child.isSymbolicLink() || SKIP.has(child.name) || SECRET_FILE.test(rel)) continue;
        if (child.isDirectory()) { if (!child.name.startsWith('.') || ['.agents', '.claude', '.codex'].includes(child.name)) await walk(path, depth + 1); }
        else if (child.isFile() && (TEXT.has(extname(child.name).toLowerCase()) || ['Dockerfile', 'Makefile'].includes(child.name))) files.push({ path, rel });
      }
    };
    await walk(root, 0);
    const priority = row => /(^|\/)(package.json|pyproject.toml|Cargo.toml|go.mod|README.md|AGENTS.md|SKILL.md|requirements.txt|docker-compose.yml|compose.yaml)$/i.test(row.rel) ? 0 : 1;
    files.sort((a, b) => priority(a) - priority(b) || a.rel.localeCompare(b.rel));
    let bytes = 0; const rows = [], inventory = files.map(row => row.rel).slice(0, 300);
    for (const row of files.slice(0, 120)) {
      signal?.throwIfAborted();
      if (bytes >= 1_500_000) { truncated = true; break; }
      let handle;
      try {
        if (!inside(root, await realpath(row.path))) continue;
        handle = await open(row.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 100_000 || stat.size > 1_500_000 - bytes) { truncated = true; continue; }
        const bounded = Buffer.alloc(100_001);
        const { bytesRead } = await handle.read(bounded, 0, bounded.length, 0);
        signal?.throwIfAborted();
        if (bytesRead > 100_000) { truncated = true; continue; }
        const buffer = bounded.subarray(0, bytesRead); bytes += buffer.length;
        if (buffer.includes(0)) continue;
        let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { continue; }
        text = redactLocal(text);
        if (text.trim()) rows.push(...chunkPages([{ page: 1, section: row.rel, text }]).map(chunk => ({ ...chunk, file: row.rel })));
      } catch (error) { if (signal?.aborted) throw signal.reason; }
      finally { await handle?.close(); }
    }
    const value = { index: buildIndex(rows), inventory, bytes, files: Math.min(files.length, 120), truncated: truncated || files.length > 120 };
    if (this.cache.size >= 4) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(root, { at: Date.now(), value }); return value;
  }
  async retrieve(source, queries, options = {}) {
    const value = await this.index(source, options), results = [];
    for (const query of queries) {
      // Manifest/README establish the actual environment before library research.
      const rows = search(value.index, query.query);
      if (source.kind === 'repository' && /framework|dependencies|architecture|project|repository|existing|manifest/i.test(query.query)) {
        for (const row of value.index.rows.filter(row => /(^|\/)(package.json|pyproject.toml|Cargo.toml|README.md|AGENTS.md)$/i.test(row.file)).slice(0, 3)) if (!rows.some(item => item.file === row.file && item.start === row.start)) rows.push({ ...row, score: 10 });
      }
      if (!rows.length && query.allowPreview) rows.push(...value.index.rows.slice(0, 1).map(row => ({ ...row, text: row.text.slice(0, 1200), score: 0, provisional: true })));
      for (const row of rows.slice(0, 5)) {
        const file = row.file.length > 260 ? `${row.file.slice(0, 100)}…${row.file.slice(-159)}` : row.file;
        results.push({ sourceType: source.kind === 'repository' ? 'repository' : 'knowledge', purpose: source.purpose ?? 'reference', source: source.name,
          locator: `${file} · characters ${row.start + 1}–${row.end}`, query: query.query, text: row.text, score: row.score, questionIds: query.questionIds || [query.questionId], ...(row.provisional ? { provisional: true } : {}) });
      }
    }
    return { evidence: results, truncated: value.truncated, inventory: value.inventory };
  }
}
