/** Local CLI metrics only: never retain prompts, tool arguments, identities, or credentials. */
import { readdir, lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { metadataSession } from './models.mjs';
import { resolveExecutable, makeTempDir, removeTempDir } from './providers.mjs';
import { readNewLines } from './usage.mjs';
import { VERSION } from './version.mjs';

const DAY = 86400000;
const IDS = ['codex', 'claude', 'gemini', 'agy'];
const names = { codex: 'Codex', claude: 'Claude Code', gemini: 'Gemini CLI', agy: 'Antigravity' };
const number = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
const safe = s => typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/@+\[\]-]{0,149}$/.test(s) ? s : 'unknown';
export function limitWindows(data) {
  return Object.entries(data || {}).flatMap(([label, v]) => {
    const used = v?.usedPercent ?? v?.used_percentage;
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return [];
    const resetValue = v.resetsAt ?? v.resets_at;
    const reset = typeof resetValue === 'string' ? Date.parse(resetValue) / 1000 : resetValue;
    return [{ label: safe(label), usedPercent: used, remainingPercent: Math.max(0, 100 - used), resetsAt: typeof reset === 'number' && reset > 0 && reset < 8640000000000 ? new Date(reset * 1000).toISOString() : null, windowMinutes: number(v.windowDurationMins) || null }];
  });
}
export async function readCodexLimits({ signal } = {}) {
  const exe = await resolveExecutable('codex');
  if (!exe) return { status: 'unavailable', windows: [], note: 'Codex CLI is not installed.' };
  const cwd = await makeTempDir('pb-usage-');
  try {
    return await metadataSession(exe, ['app-server'], cwd, async ({ request, send }) => {
      await request('initialize', { clientInfo: { name: 'promptboard', version: VERSION } });
      send({ method: 'initialized', params: {} });
      const result = await request('account/rateLimits/read', {});
      const limits = result.rateLimitsByLimitId || { codex: result.rateLimits };
      const windows = Object.entries(limits).flatMap(([id, limits]) => limitWindows(limits).map(w => ({ ...w, label: `${safe(id)} · ${w.label}` })));
      return { status: windows.length ? 'live' : 'unavailable', windows, checkedAt: Date.now(), note: windows.length ? '' : 'This sign-in does not expose ChatGPT plan limits.' };
    }, { signal, timeoutMs: 10000 });
  } finally { await removeTempDir(cwd); }
}

/** Reduce a session to numeric records; repeated streaming messages replace earlier values. */
export function sessionMetrics(provider, records, fallbackTime, seed = null) {
  const rows = new Map((seed?.rows || []).map(r => [r.id, r])), tools = new Map((seed?.tools || []).map(t => [t.id, { name: t.name, at: t.at }]));
  let model = seed?._model || 'unknown', previous = seed?._previous || { input: 0, cached: 0, output: 0 }, sessionId = seed?.sessionId || '', limits = seed?.limits || null;
  const when = r => { const t = Date.parse(r.timestamp); return Number.isFinite(t) ? t : fallbackTime; };
  const putTool = (id, name, at) => { if (typeof id === 'string' && id.length < 300 && safe(name) !== 'unknown') tools.set(id, { name: safe(name), at }); };
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    if (provider === 'claude') {
      const m = r.type === 'assistant' && r.message;
      if (!m || typeof m.id !== 'string') continue;
      if (r.sessionId) sessionId = safe(r.sessionId);
      if (m.usage) rows.set(m.id, { id: m.id, model: safe(m.model), at: when(r), input: number(m.usage.input_tokens) + number(m.usage.cache_creation_input_tokens), cached: number(m.usage.cache_read_input_tokens), output: number(m.usage.output_tokens) });
      for (const block of Array.isArray(m.content) ? m.content : []) if (block?.type === 'tool_use') putTool(block.id, block.name, when(r));
    } else if (provider === 'codex') {
      const p = r.payload;
      if (r.type === 'session_meta') sessionId = safe(p?.id);
      if (r.type === 'turn_context') model = safe(p?.model);
      if (r.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(p?.type)) putTool(p.call_id, p.name, when(r));
      if (p?.type !== 'token_count') continue;
      if (p.rate_limits) limits = { windows: limitWindows(p.rate_limits), checkedAt: when(r), status: 'snapshot' };
      const u = p.info?.total_token_usage;
      if (!u) continue;
      const total = { input: Math.max(0, number(u.input_tokens) - number(u.cached_input_tokens)), cached: number(u.cached_input_tokens), output: number(u.output_tokens) };
      const delta = Object.fromEntries(Object.keys(total).map(key => [key, Math.max(0, total[key] - previous[key])]));
      if (Object.values(delta).some(Boolean)) rows.set(`${rows.size}`, { id: `${rows.size}`, model, at: when(r), ...delta });
      previous = total;
    } else if (provider === 'gemini') {
      if (r.sessionId) sessionId = safe(r.sessionId);
      if (r.type !== 'gemini' || typeof r.id !== 'string') continue;
      if (r.tokens) rows.set(r.id, { id: r.id, model: safe(r.model), at: when(r), input: Math.max(0, number(r.tokens.input) - number(r.tokens.cached)), cached: number(r.tokens.cached), output: number(r.tokens.output) + number(r.tokens.thoughts) });
      for (const tool of r.toolCalls || []) putTool(tool.id, tool.name, when(r));
    }
  }
  return { sessionId, rows: [...rows.values()], tools: [...tools.entries()].map(([id, t]) => ({ id, ...t })), limits, _model: model, _previous: previous };
}

/** Bounded scans of known session directories. Symlinks and credentials are never followed. */
async function sessionFiles(root, match, budget, depth = 0) {
  if (depth > 7 || budget.visited > 20000) { budget.partial = true; return []; }
  const info = await lstat(root).catch(() => null);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) return [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => { budget.partial = true; return []; });
  const files = [];
  for (const e of entries) {
    if (++budget.visited > 20000) { budget.partial = true; break; }
    if (e.isDirectory()) files.push(...await sessionFiles(join(root, e.name), match, budget, depth + 1));
    else if (e.isFile() && match(e.name)) files.push(join(root, e.name));
  }
  return files;
}
export class UsageDashboard {
  constructor({ dataDir, roots, limitReader = readCodexLimits, now = Date.now } = {}) {
    this.dataDir = dataDir; this.now = now; this.limitReader = limitReader;
    this.roots = roots || { claude: [join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')], codex: [join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions'), join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'archived_sessions')], gemini: [join(homedir(), '.gemini', 'tmp')] };
    this.cache = new Map(); this.abort = new AbortController();
  }
  close() { clearInterval(this.timer); this.abort.abort(); }
  async get({ refresh = false } = {}) {
    if (!this.timer) { this.timer = setInterval(() => this.refresh().catch(() => {}), 60000); this.timer.unref?.(); }
    if (!this.snapshot || (refresh && this.now() - this.snapshot.updatedAt >= 10000)) await this.refresh();
    if (this.pending) await this.pending;
    return this.snapshot;
  }
  refresh() {
    if (this.pending) return this.pending;
    this.pending = this.collect().finally(() => { this.pending = null; });
    return this.pending;
  }
  async collect() {
    const now = this.now(), since = Date.parse(new Date(now - 29 * DAY).toISOString().slice(0, 10));
    const native = this.limitReader({ signal: this.abort.signal }).catch(() => ({ status: 'unavailable', windows: [], note: 'Could not refresh plan limits. Check Codex sign-in.' }));
    const providers = [];
    const seenFiles = new Set();
    for (const id of IDS) {
      const p = { id, name: names[id], models: [], daily: [], tools: [], sessions: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUSD: null, costNote: 'Not reported by this CLI.', limits: { status: 'unavailable', windows: [], note: id === 'claude' ? 'Plan limits appear after a new Claude session in Promptboard reports them. Use /usage in Claude for an account check.' : id === 'gemini' ? 'Use /stats model in Gemini for current account quota.' : 'This CLI does not expose a supported usage interface.' }, partial: false };
      const budget = { visited: 0, partial: false }, files = [];
      for (const root of this.roots[id] || []) files.push(...await sessionFiles(root, name => id === 'codex' ? /^rollout-.*\.jsonl$/.test(name) : id === 'gemini' ? /^session-.*\.jsonl?$/.test(name) : name.endsWith('.jsonl'), budget));
      const models = new Map(), days = new Map(), tools = new Map(), sessions = new Set(), messages = new Set(), calls = new Set();
      let bytesRead = 0, fileCount = 0;
      for (const path of files) {
        const stat = await lstat(path).catch(() => null);
        if (!stat?.isFile() || stat.mtimeMs < since) continue;
        if (++fileCount > 5000) { p.partial = true; break; } // Old files never use up the cap.
        seenFiles.add(path);
        let entry = this.cache.get(path);
        if (path.endsWith('.jsonl')) {
          // Tail complete records, including large rollouts, over bounded refreshes.
          if (!entry || stat.size < entry.size || entry.ino !== stat.ino) entry = { tail: { path, offset: 0 }, metrics: null };
          if (entry.tail.offset < stat.size && bytesRead < 128 * 1024 * 1024) {
            const before = entry.tail.offset;
            try {
              const records = await readNewLines(entry.tail);
              bytesRead += entry.tail.offset - before;
              entry.metrics = sessionMetrics(id, records, stat.mtimeMs, entry.metrics);
              // An individual oversized record cannot be buffered; skip its chunk and label coverage.
              if (entry.tail.offset === before && stat.size - before >= 16 * 1024 * 1024) { entry.tail.offset += 16 * 1024 * 1024; entry.incomplete = true; bytesRead += 16 * 1024 * 1024; }
            } catch { p.partial = true; }
          }
          entry.size = stat.size; entry.ino = stat.ino;
          p.partial ||= entry.tail.offset < stat.size || Boolean(entry.incomplete);
          this.cache.set(path, entry);
          if (!entry.metrics) continue;
        } else {
          if (stat.size > 32 * 1024 * 1024) { p.partial = true; continue; }
          if (!entry || entry.mtime !== stat.mtimeMs || entry.size !== stat.size) {
            if (bytesRead + stat.size > 128 * 1024 * 1024) { p.partial = true; continue; }
            bytesRead += stat.size;
            try {
              const value = JSON.parse(await readFile(path, 'utf8'));
              const records = [{ sessionId: value.sessionId }, ...(value.messages || [])];
              entry = { mtime: stat.mtimeMs, size: stat.size, metrics: sessionMetrics(id, records, stat.mtimeMs) };
              this.cache.set(path, entry);
            } catch { p.partial = true; continue; }
          }
        }
        const metrics = entry.metrics, session = metrics.sessionId || path;
        if (metrics.limits?.windows.length && (!p.limits.checkedAt || metrics.limits.checkedAt > p.limits.checkedAt)) p.limits = metrics.limits;
        for (const r of metrics.rows) {
          if (r.at < since || r.at > now || messages.has(`${session}:${r.id}`)) continue;
          messages.add(`${session}:${r.id}`); sessions.add(session);
          const m = models.get(r.model) || { model: r.model, inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
          for (const [key, source] of [['inputTokens', 'input'], ['cachedTokens', 'cached'], ['outputTokens', 'output']]) { m[key] += r[source]; p[key] += r[source]; }
          models.set(r.model, m);
          const day = new Date(r.at).toISOString().slice(0, 10); days.set(day, (days.get(day) || 0) + r.input + r.cached + r.output);
        }
        for (const tool of metrics.tools) if (tool.at >= since && tool.at <= now && !calls.has(`${session}:${tool.id}`)) { calls.add(`${session}:${tool.id}`); tools.set(tool.name, (tools.get(tool.name) || 0) + 1); }
      }
      p.sessions = sessions.size; p.models = [...models.values()]; p.tools = [...tools].map(([name, count]) => ({ name, count })).sort((a,b) => b.count-a.count);
      p.daily = Array.from({ length: 30 }, (_, i) => { const day = new Date(now - (29-i)*DAY).toISOString().slice(0,10); return { day, tokens: days.get(day) || 0 }; });
      p.partial ||= budget.partial;
      providers.push(p);
    }
    for (const key of this.cache.keys()) if (!seenFiles.has(key)) this.cache.delete(key);
    // Status-line snapshots contain only whitelisted numeric usage, from our own runs.
    const claude = providers.find(p => p.id === 'claude');
    const budget = { visited: 0, partial: false };
    const costs = new Map();
    for (const file of await sessionFiles(join(this.dataDir, 'runs'), name => name === 'usage-status.json', budget)) {
      try {
        const stat = await lstat(file); if (stat.size > 65536) continue;
        const v = JSON.parse(await readFile(file, 'utf8'));
        if (v.at < since || v.at > now) continue;
        if (v.windows?.length && (!claude.limits.checkedAt || v.at > claude.limits.checkedAt)) claude.limits = { status: 'snapshot', windows: limitWindows(Object.fromEntries(v.windows.map(w => [w.label, w]))), checkedAt: v.at, note: 'Last reported by a Promptboard Claude session; not a live account query.' };
        if (typeof v.costUSD === 'number' && Number.isFinite(v.costUSD) && v.costUSD >= 0 && typeof v.sessionId === 'string') costs.set(v.sessionId, Math.max(costs.get(v.sessionId) || 0, v.costUSD));
      } catch {}
    }
    if (costs.size) { claude.costUSD = [...costs.values()].reduce((a,b) => a+b,0); claude.costNote = 'CLI estimate for reporting Promptboard sessions; not your bill or all-account spend.'; }
    const codex = providers.find(p => p.id === 'codex'), live = await native;
    if (live.status === 'live') codex.limits = live;
    else if (codex.limits.windows.length) codex.limits = { ...codex.limits, status: 'stale', note: live.note };
    else {
      const previous = this.snapshot?.providers.find(p => p.id === 'codex')?.limits;
      codex.limits = previous?.windows.length ? { ...previous, status: 'stale', note: live.note } : live;
    }
    this.snapshot = { updatedAt: now, refreshMs: 60000, since, scope: 'Local CLI sessions · last 30 days · this machine', providers };
    return this.snapshot;
  }
}
