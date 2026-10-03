/** Compose retrieval only. Server instructions and executable schemas never reach a model. */
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { invalid, object, string, list } from './compose-grounding.mjs';

const REF = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function validateMcp(source) {
  object(source, ['type', 'name', 'preset', 'transport', 'endpoint', 'command', 'args', 'headers', 'env', 'allowStart'], 'MCP source');
  if (source.type !== 'mcp') invalid('Invalid MCP source.');
  if (source.preset === 'context7') {
    if (Object.keys(source).some(key => !['type', 'name', 'preset'].includes(key))) invalid('The Context7 preset cannot override its endpoint.');
    return { type: 'mcp', name: 'Context7', preset: 'context7', transport: 'streamable-http', endpoint: 'https://mcp.context7.com/mcp' };
  }
  if (source.preset !== undefined) invalid('Unknown MCP preset.');
  string(source.name, 80, 'MCP name');
  if (!['streamable-http', 'stdio'].includes(source.transport)) invalid('Choose HTTP or stdio MCP.');
  for (const map of [source.headers, source.env]) {
    if (map === undefined) continue;
    if (!map || typeof map !== 'object' || Array.isArray(map) || Object.keys(map).length > 10) invalid('Use at most ten environment references.');
    for (const [key, ref] of Object.entries(map)) if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(key) || typeof ref !== 'string' || !REF.test(ref)) invalid('MCP credentials must reference environment variable names.');
  }
  if (source.transport === 'stdio') {
    string(source.command, 500, 'MCP command');
    list(source.args ?? [], 30, 'MCP arguments').forEach(arg => string(arg, 500, 'MCP argument', true));
    if (source.allowStart !== true) invalid('Allow starting this local MCP program before using it.');
    if (source.endpoint || source.headers) invalid('Stdio MCP uses command and environment references.');
  } else {
    string(source.endpoint, 1000, 'MCP URL');
    let url; try { url = new URL(source.endpoint); } catch { invalid('Use a valid MCP URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) invalid('Use an HTTP(S) MCP URL without credentials, query parameters, or fragments.');
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) invalid('Remote MCP connections must use HTTPS.');
    if (source.command || source.args || source.env) invalid('HTTP MCP uses a URL and header references.');
  }
  return { ...source };
}

export function isReadOnlyTool(tool) {
  return tool?.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true
    && !/(delete|drop|remove|write|create|update|insert|execute|exec|shell|deploy|send|email|account|purchase|install|mutat)/i.test(tool.name || '')
    && /(?:read|get|search|query|lookup|fetch|resolve|list|documentation|docs)/i.test(tool.name || '');
}
function supports(tool, fields) {
  const schema = tool?.inputSchema;
  return schema?.type === 'object' && fields.every(name => schema.properties?.[name]?.type === 'string')
    && (schema.required || []).every(name => fields.includes(name));
}
function textResult(result) {
  if (result?.isError || !Array.isArray(result?.content)) throw new Error('MCP returned no usable documentation.');
  const text = result.content.filter(item => item.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n');
  if (!text.trim() || text.length > 100_000 || text.includes('\0')) throw new Error('MCP returned invalid or oversized documentation.');
  return text;
}

export function selectContext7Library(text, libraryHint, query) {
  const normalize = value => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const hint = normalize(libraryHint);
  const languages = ['python', 'rust', 'java', 'javascript', 'typescript', 'golang', 'ruby', 'php', 'dotnet'];
  const wanted = languages.filter(language => new RegExp(`\\b${language}\\b`, 'i').test(query));
  const candidates = text.split(/-{3,}/).map((block, order) => {
    const id = block.match(/(?:Context7-compatible library ID|Library ID):\s*(\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)/i)?.[1];
    const title = block.match(/(?:^|\n)\s*-?\s*Title:\s*([^\n]+)/i)?.[1] || '';
    // Matching an owner alone selects unrelated clients (e.g. a C client for Python).
    if (!id || !(normalize(title).includes(hint) || normalize(id.split('/').at(-1)) === hint)) return null;
    const titleLanguages = languages.filter(language => new RegExp(`\\b${language}\\b`, 'i').test(title));
    const score = (normalize(title) === hint ? 10 : 0) + wanted.filter(language => titleLanguages.includes(language)).length * 30
      - titleLanguages.filter(language => !wanted.includes(language)).length * 20;
    return { id, score, order };
  }).filter(Boolean).sort((a, b) => b.score - a.score || a.order - b.order);
  return candidates[0]?.id;
}

export class ComposeMcp {
  cache = new Map();
  close() { this.cache.clear(); }
  async retrieve(source, queries, { signal, timeoutMs = 30_000, environment = process.env, discoveryOnly = false } = {}) {
    const cfg = validateMcp(source), local = new AbortController();
    const combined = signal ? AbortSignal.any([signal, local.signal]) : local.signal;
    const refs = mapping => Object.fromEntries(Object.entries(mapping || {}).map(([key, ref]) => {
      if (!environment[ref]) throw new Error('An MCP environment reference is missing. Set it before starting Promptboard.');
      return [key, environment[ref]];
    }));
    const headers = cfg.preset === 'context7' ? (environment.CONTEXT7_API_KEY ? { CONTEXT7_API_KEY: environment.CONTEXT7_API_KEY } : {}) : refs(cfg.headers);
    const env = refs(cfg.env), secrets = [...Object.values(headers), ...Object.values(env)].filter(value => value.length > 2);
    const redact = text => secrets.reduce((result, secret) => result.replaceAll(secret, '[redacted]'), text);
    const prefix = createHash('sha256').update(JSON.stringify([cfg, headers, env])).digest('hex');
    const results = [], pending = [];
    for (const query of queries) {
      const key = prefix + JSON.stringify([query.libraryHint, query.query]);
      const cached = this.cache.get(key);
      if (cached && Date.now() - cached.at < 600_000) results.push({ ...cached.value, questionId: query.questionId });
      else pending.push(query);
    }
    if (!pending.length && !discoveryOnly) return results;
    let client, transport;
    const timer = setTimeout(() => local.abort(), timeoutMs);
    const stop = () => { void client?.close().catch(() => {}); };
    combined.addEventListener('abort', stop, { once: true });
    try {
      combined.throwIfAborted();
      if (cfg.transport === 'stdio') {
        transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./mcp-process.mjs', import.meta.url)), JSON.stringify([cfg.command, ...(cfg.args || [])])], env, stderr: 'pipe', maxBufferSize: 1_000_000 });
        let bytes = 0;
        transport.stderr?.on('data', chunk => { bytes += chunk.length; if (bytes > 65_536) local.abort(); });
      } else {
        const url = new URL(cfg.endpoint);
        transport = new StreamableHTTPClientTransport(url, { requestInit: { headers }, fetch: async (target, options) => {
          if (new URL(target).origin !== url.origin) throw new Error('MCP redirect rejected.');
          const response = await fetch(target, { ...options, redirect: 'error', signal: options?.signal ? AbortSignal.any([combined, options.signal]) : combined });
          if (!response.body) return response;
          let bytes = 0;
          return new Response(response.body.pipeThrough(new TransformStream({ transform(chunk, out) {
            bytes += chunk.byteLength;
            if (bytes > 1_000_000) { local.abort(); out.error(new Error('MCP response limit exceeded.')); } else out.enqueue(chunk);
          } })), { status: response.status, statusText: response.statusText, headers: response.headers });
        } });
      }
      client = new Client({ name: 'promptboard-compose', version: '1.0.0' });
      const options = { signal: combined, timeout: timeoutMs };
      await client.connect(transport, options);
      const tools = []; let cursor;
      if (client.getServerCapabilities()?.tools) for (let page = 0; page < 3; page++) {
        const response = await client.listTools(cursor ? { cursor } : {}, options);
        tools.push(...response.tools.slice(0, 100 - tools.length)); cursor = response.nextCursor;
        if (!cursor || tools.length >= 100) break;
      }
      const safe = tools.filter(isReadOnlyTool);
      if (discoveryOnly) return { tools: safe.map(tool => redact(tool.name).slice(0, 160)), note: 'Only annotated read-only retrieval tools are eligible.' };
      const callCache = new Map();
      const call = async (tool, args) => {
        const key = JSON.stringify([tool.name, args]);
        if (!callCache.has(key)) callCache.set(key, redact(textResult(await client.callTool({ name: tool.name, arguments: args }, undefined, options))));
        return callCache.get(key);
      };
      for (const query of pending.slice(0, 24)) {
        combined.throwIfAborted();
        let text, locator;
        if (cfg.preset === 'context7') {
          const resolve = safe.find(tool => tool.name === 'resolve-library-id' && supports(tool, ['libraryName', 'query']));
          const docs = safe.find(tool => tool.name === 'query-docs' && supports(tool, ['libraryId', 'query']));
          if (!resolve || !docs) throw new Error('Context7 capabilities changed. Expected read-only resolve-library-id and query-docs with compatible schemas.');
          if (!query.libraryHint) continue;
          const libraries = await call(resolve, { libraryName: query.libraryHint, query: query.query });
          locator = selectContext7Library(libraries, query.libraryHint, query.query);
          if (!locator) throw new Error('Context7 returned no matching library. Refine the task or continue without this source.');
          text = await call(docs, { libraryId: locator, query: query.query });
        } else {
          const eligible = safe.filter(tool => supports(tool, ['query'])).sort((a, b) => a.name.localeCompare(b.name));
          if (!eligible.length) throw new Error('This MCP has no compatible read-only retrieval tool with a string query input.');
          // Ambiguous selection must be explicit rather than guessing what an API does.
          if (eligible.length > 1) throw new Error('This MCP exposes multiple retrieval tools. Use a server exposing one query tool for Compose.');
          locator = eligible[0].name;
          text = await call(eligible[0], { query: query.query });
        }
        const value = { sourceType: 'mcp', source: cfg.name + (cfg.preset ? ` / ${query.libraryHint}` : ''), locator, query: query.query, text };
        results.push({ ...value, questionId: query.questionId });
        const key = prefix + JSON.stringify([query.libraryHint, query.query]);
        if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(key, { at: Date.now(), value });
      }
      return results;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      // A slow later lookup must not erase documentation already retrieved.
      // Missing question IDs remain unresolved in the final grounding payload.
      if (results.length) {
        results.warning = 'Some MCP lookups could not finish. Only returned documentation is available; remaining details must be verified during implementation.';
        return results;
      }
      if (combined.aborted) throw new Error('MCP retrieval exceeded its time or output limit. Retry or continue without this source.');
      const known = /^(Context7|This MCP|MCP returned)/.test(error.message);
      throw new Error(known ? error.message : 'MCP server is unavailable. Check the connection and environment references, retry, or continue without this source.');
    } finally {
      clearTimeout(timer); combined.removeEventListener('abort', stop);
      if (transport instanceof StreamableHTTPClientTransport) await Promise.race([transport.terminateSession().catch(() => {}), new Promise(resolve => setTimeout(resolve, 500).unref())]);
      await client?.close().catch(() => {});
      if (!client) await transport?.close().catch(() => {});
    }
  }
}
