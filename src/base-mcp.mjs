/** Explicit MCP discovery uses the maintained SDK; never called on save/import/page load. */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { BaseDeliveryError } from './base-resolver.mjs';

export const CONTEXT7_PRESET = Object.freeze({
  kind: 'mcp', name: 'Context7', description: 'Optional current library documentation over Streamable HTTP. Requires internet access. This preset uses an authenticated Authorization header; no setup command is run.', enabled: false, trust: 'untrusted',
  configuration: { transport: 'streamable-http', endpoint: 'https://mcp.context7.com/mcp', headers: { Authorization: 'CONTEXT7_AUTHORIZATION' }, env: {}, auth: { required: true, description: 'Set CONTEXT7_AUTHORIZATION to the complete value Bearer YOUR_API_KEY in the environment that starts Promptboard. Obtain the key from Context7; it is never saved in Base. For documented anonymous access at lower limits, remove this header reference and uncheck authentication required.' } },
});

function resolveReferences(mapping = {}, environment) {
  return Object.fromEntries(Object.entries(mapping).map(([name, reference]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference) || !environment[reference]) throw new BaseDeliveryError('A declared environment reference is missing. Set it before testing this server.', 'BASE_AUTH_REQUIRED');
    return [name, environment[reference]];
  }));
}

/** Endpoint authorization is deliberately separate from public-document fetching. */
function validateMcpEndpoint(value) {
  let url; try { url = new URL(value); } catch { throw new BaseDeliveryError('Use a valid MCP HTTP(S) endpoint.', 'BASE_INVALID_MCP'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new BaseDeliveryError('MCP endpoints must use HTTP(S), without embedded credentials or fragments.', 'BASE_INVALID_MCP');
  return url;
}

export async function testMcp(definition, { signal, timeoutMs = 15000, environment = process.env } = {}) {
  if (definition.kind !== 'mcp' || definition.trust !== 'trusted') throw new BaseDeliveryError('Trust this MCP definition before explicitly testing its connection. Stdio testing executes the configured program.', 'BASE_UNTRUSTED');
  const cfg = definition.configuration || {}, controller = new AbortController();
  const secrets = [...new Set([...Object.values(cfg.env || {}), ...Object.values(cfg.headers || {})].map(name => environment[name]).filter(value => typeof value === 'string' && value.length > 2))];
  const redact = value => secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), String(value));
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let transport, client, outputBytes = 0;
  const timer = setTimeout(() => controller.abort(), Math.min(30000, Math.max(100, timeoutMs)));
  const stop = () => { void client?.close().catch(() => {}); };
  combined.addEventListener('abort', stop, { once: true });
  const startedAt = Date.now();
  try {
    if (combined.aborted) throw new BaseDeliveryError('MCP test was cancelled.', 'ABORTED');
    if (cfg.transport === 'stdio') {
      transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./mcp-process.mjs', import.meta.url)), JSON.stringify([cfg.command, ...(cfg.args || [])])], env: resolveReferences(cfg.env, environment), stderr: 'pipe', maxBufferSize: 1_000_000 });
      transport.stderr?.on('data', chunk => { outputBytes += chunk.length; if (outputBytes > 65536) controller.abort(); });
    } else if (cfg.transport === 'streamable-http') {
      const url = validateMcpEndpoint(cfg.endpoint);
      const headers = resolveReferences(cfg.headers, environment);
      if (cfg.auth?.required && !Object.keys(headers).length) throw new BaseDeliveryError('Explicit connection tests need declared authentication headers. CLI-managed OAuth remains with the CLI.', 'BASE_AUTH_REQUIRED');
      transport = new StreamableHTTPClientTransport(url, { requestInit: { headers }, fetch: async (target, options) => {
        if (new URL(target).origin !== url.origin) throw new BaseDeliveryError('Cross-origin MCP redirects are not permitted.', 'BASE_MCP_REDIRECT');
        const response = await fetch(target, { ...options, signal: options?.signal ? AbortSignal.any([options.signal, combined]) : combined, redirect: 'error' });
        if (response.status === 401 || response.status === 403) throw new BaseDeliveryError('MCP authentication was rejected.', 'BASE_AUTH_REQUIRED');
        if (!response.body) return response;
        let bytes = 0;
        return new Response(response.body.pipeThrough(new TransformStream({ transform(chunk, out) { bytes += chunk.byteLength; if (bytes > 1_000_000) { out.error(new BaseDeliveryError('MCP response exceeds the discovery limit.', 'BASE_MCP_LIMIT')); controller.abort(); } else out.enqueue(chunk); } })), { status: response.status, statusText: response.statusText, headers: response.headers });
      } });
    } else throw new BaseDeliveryError('This MCP transport is unsupported.', 'BASE_INVALID_MCP');
    client = new Client({ name: 'promptboard-base-discovery', version: '1.0.0' });
    await client.connect(transport, { signal: combined, timeout: Math.min(timeoutMs, 30000) });
    const capabilities = client.getServerCapabilities() || {};
    const result = { status: 'connected', testedAt: Date.now(), durationMs: Date.now() - startedAt, server: { name: redact(client.getServerVersion()?.name || '').slice(0, 160), version: redact(client.getServerVersion()?.version || '').slice(0, 80) }, tools: [], resources: [], prompts: [] };
    for (const [kind, method] of [['tools', 'listTools'], ['resources', 'listResources'], ['prompts', 'listPrompts']]) {
      if (!capabilities[kind]) continue;
      let cursor;
      for (let page = 0; page < 5; page++) {
        const listed = await client[method]({ ...(cursor ? { cursor } : {}) }, { signal: combined, timeout: Math.min(timeoutMs, 30000) });
        for (const entry of listed[kind] || []) {
          if (result[kind].length >= 200) { result.partial = true; break; }
          // Discovery names/identities only. Untrusted descriptions, schemas, or server instructions
          // may contain secrets or injection, and are not persisted in diagnostics.
          const identity = redact(entry.name || '').replace(/[^A-Za-z0-9_.:/-]/g, '').slice(0, 160);
          if (identity) result[kind].push({ name: identity });
        }
        cursor = listed.nextCursor;
        if (!cursor || result[kind].length >= 200) break;
        if (page === 4) result.partial = true;
      }
    }
    return result;
  } catch (error) {
    if (error instanceof BaseDeliveryError) throw error;
    throw new BaseDeliveryError(combined.aborted ? 'MCP discovery was cancelled or exceeded its time/output limit.' : 'MCP initialization or discovery failed. Check the server, transport, and authentication references.', combined.aborted ? 'ABORTED' : 'BASE_MCP_FAILED');
  } finally {
    clearTimeout(timer); combined.removeEventListener('abort', stop);
    // A bounded DELETE closes HTTP sessions; close owns/reaps only this test's stdio process.
    if (transport instanceof StreamableHTTPClientTransport) await Promise.race([transport.terminateSession().catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]);
    await client?.close().catch(() => {});
    if (!client) await transport?.close().catch(() => {});
  }
}
