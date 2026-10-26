/**
 * The MCP server for external hosts (docs/network/architecture.md §10.3, §22): `node bin/ste.mjs --mcp` serves MCP over
 * stdio with the official v2 SDK (@modelcontextprotocol/server 2.3.1, serveStdio) and calls Promptboard's machine
 * listener (rest.mjs) with one client token. It holds no other credential and no Promptboard state, so it can do exactly
 * what that client may do over REST and nothing more. The token comes from PROMPTBOARD_MACHINE_TOKEN or the file named by
 * PROMPTBOARD_MACHINE_TOKEN_FILE, never from argv; PROMPTBOARD_MACHINE_URL must be a loopback http address (default
 * http://127.0.0.1:4330), so the token is never sent off this computer. Nothing is written to stdout but MCP messages, and
 * no message carries the token.
 *
 * Tools: agents_list, agents_get, jobs_submit (answers the jobId at once and never waits for the run, so a host calling
 * Promptboard while a job of the same provider runs only queues work), jobs_get, jobs_cancel and artifacts_get (a
 * completed job's result in windows of at most 60 KB). Input schemas are strict (unknown fields refused); tool annotations
 * are hints for the host only: the machine listener decides every call.
 */
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { VERSION } from '../version.mjs';
import { MACHINE_TOKEN } from './machine-auth.mjs';

export const MCP_LIMITS = Object.freeze({ answerBytes: 60_000, requestMs: 15_000, inputChars: 200_000 });
const AGENT_ID = /^agt_[0-9a-f]{20}$/, JOB_ID = /^job_[0-9a-f]{20}$/, NETWORK_ID = /^net_[0-9a-f]{20}$/, PROJECT_ID = /^[A-Za-z0-9_-]{1,100}$/, KEY = /^[\x20-\x7e]{1,200}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const SETUP = 'Create a client in Promptboard → Network → Settings and give its token to this server as PROMPTBOARD_MACHINE_TOKEN (or a file named by PROMPTBOARD_MACHINE_TOKEN_FILE).';

/** The listener address and token from the environment; every refusal names what to fix and never repeats the token. */
export function bridgeConfig(env = process.env) {
  let token = env.PROMPTBOARD_MACHINE_TOKEN?.trim();
  if (!token && env.PROMPTBOARD_MACHINE_TOKEN_FILE) {
    try { token = readFileSync(env.PROMPTBOARD_MACHINE_TOKEN_FILE, 'utf8').trim(); } catch { throw new Error(`PROMPTBOARD_MACHINE_TOKEN_FILE cannot be read. ${SETUP}`); }
  }
  if (!token) throw new Error(`No Promptboard client token. ${SETUP}`);
  if (!MACHINE_TOKEN.test(token)) throw new Error(`The Promptboard client token is not valid. ${SETUP}`);
  let url;
  try { url = new URL(env.PROMPTBOARD_MACHINE_URL || 'http://127.0.0.1:4330'); } catch { url = null; }
  if (!url || url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PROMPTBOARD_MACHINE_URL must be the machine listener on this computer, for example http://127.0.0.1:4330.');
  }
  return { url: url.origin, token };
}

const text = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });
const refusal = message => ({ ...text(message), isError: true });
/** One answer as tool text, refused when it would pass the response limit. */
function answer(value) {
  const body = JSON.stringify(value);
  return Buffer.byteLength(body) > MCP_LIMITS.answerBytes ? refusal('The answer is larger than this server returns in one call.') : text(body);
}
/** The end of a window of `chars` characters from `offset` within `bytes` bytes that never splits a surrogate pair. */
function windowEnd(full, offset, chars, bytes) {
  let end = Math.min(full.length, offset + chars);
  while (end > offset && Buffer.byteLength(full.slice(offset, end)) > bytes) end = offset + Math.floor((end - offset) * 0.8);
  if (end < full.length && end > offset && /[\ud800-\udbff]/.test(full[end - 1])) end--;
  return end;
}

/** The MCP server for one client: each tool is one call to the machine listener. */
export function bridgeServer({ url, token, fetch = globalThis.fetch }) {
  async function call(path, { method = 'GET', body, key } = {}) {
    let response;
    try {
      response = await fetch(`${url}/machine/v1${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(MCP_LIMITS.requestMs),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new Error(`Promptboard did not answer at ${url}. Turn on External clients in Promptboard → Network → Settings and check the port.`); }
    let data = null;
    try { data = await response.json(); } catch {}
    if (!response.ok) throw new Error(`${typeof data?.error === 'string' ? data.error.slice(0, 500) : `Promptboard answered ${response.status}.`}${typeof data?.code === 'string' ? ` (${data.code.slice(0, 60)})` : ''}`);
    return data;
  }
  const tool = run => async input => { try { return await run(input); } catch (error) { return refusal(error.message); } };
  const server = new McpServer({ name: 'promptboard-network', version: VERSION });
  const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  server.registerTool('agents_list', { title: 'List agents', description: 'The Promptboard agents this client may use, with their provider and the tool modes their jobs support.', inputSchema: z.object({}).strict(), annotations: read },
    tool(async () => answer(await call('/agents'))));
  server.registerTool('agents_get', { title: 'Get an agent', description: 'One Promptboard agent this client may use.', inputSchema: z.object({ agentId: z.string().regex(AGENT_ID) }).strict(), annotations: read },
    tool(async ({ agentId }) => answer(await call(`/agents/${agentId}`))));
  server.registerTool('jobs_submit', {
    title: 'Submit a job',
    description: 'Queue a read-only job for one Promptboard agent. Answers its jobId at once and never waits for the run: call jobs_get until the status is completed, failed or cancelled, then artifacts_get. A job may wait for a free slot or for the owner’s approval. Reuse idempotencyKey when you retry a submit, so it never makes a second job.',
    inputSchema: z.object({
      agentId: z.string().regex(AGENT_ID), input: z.string().min(1).max(MCP_LIMITS.inputChars), instructions: z.string().max(32_000).optional(), tools: z.enum(['none', 'web']).optional(),
      projectId: z.string().regex(PROJECT_ID).optional(), networkId: z.string().regex(NETWORK_ID).optional(), memory: z.enum(['none', 'agent', 'agent+network']).optional(),
      projectLessons: z.boolean().optional(), timeoutMinutes: z.number().int().min(1).max(120).optional(), requireApproval: z.boolean().optional(), idempotencyKey: z.string().regex(KEY).optional(),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, tool(async ({ agentId, input, instructions, tools, projectId, networkId, memory, projectLessons, timeoutMinutes, requireApproval, idempotencyKey }) => {
    const permissions = { ...(memory ? { memory } : {}), ...(projectLessons !== undefined ? { projectLessons } : {}) };
    const body = { agentId, input: { text: input }, ...(instructions ? { instructions } : {}), ...(tools ? { tools } : {}), ...(projectId ? { projectId } : {}), ...(networkId ? { networkId } : {}),
      ...(Object.keys(permissions).length ? { permissions } : {}), ...(timeoutMinutes ? { limits: { timeoutMs: timeoutMinutes * 60_000 } } : {}), ...(requireApproval !== undefined ? { requireApproval } : {}) };
    const { jobId, status, deduplicated } = await call('/jobs', { method: 'POST', body, key: idempotencyKey });
    return answer({ jobId, status, deduplicated });
  }));
  server.registerTool('jobs_get', { title: 'Get a job', description: 'The status of a job this client submitted: queued, waiting_for_approval, preparing, running, completed, failed, cancelled, unknown or interrupted (the last two wait for the owner’s decision).', inputSchema: z.object({ jobId: z.string().regex(JOB_ID) }).strict(), annotations: read },
    tool(async ({ jobId }) => answer(await call(`/jobs/${jobId}`))));
  server.registerTool('jobs_cancel', { title: 'Cancel a job', description: 'Cancel a job this client submitted that has not ended.', inputSchema: z.object({ jobId: z.string().regex(JOB_ID) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
  tool(async ({ jobId }) => answer(await call(`/jobs/${jobId}/cancel`, { method: 'POST', body: {} }))));
  server.registerTool('artifacts_get', {
    title: 'Get a job result',
    description: 'The result text of a completed job this client submitted, in windows: pass nextOffset back as offset until it is null.',
    inputSchema: z.object({ jobId: z.string().regex(JOB_ID), offset: z.number().int().min(0).optional(), maxChars: z.number().int().min(1).max(MCP_LIMITS.answerBytes).optional() }).strict(), annotations: read,
  }, tool(async ({ jobId, offset = 0, maxChars = 30_000 }) => {
    const { text: full, json, chars } = await call(`/jobs/${jobId}/result`);
    // The result's json comes with the first window when it is small (at most 16 KB); the whole answer stays within the limit.
    const start = Math.min(offset, full.length), small = start === 0 && json !== null && Buffer.byteLength(JSON.stringify(json)) <= 16_000;
    const end = windowEnd(full, start, maxChars, MCP_LIMITS.answerBytes - 17_000);
    const meta = { jobId, offset: start, nextOffset: end < full.length ? end : null, totalChars: chars, ...(small ? { json } : json !== null && start === 0 ? { json: 'too large for this answer; fetch it over REST' } : {}) };
    return { content: [{ type: 'text', text: JSON.stringify(meta) }, { type: 'text', text: full.slice(start, end) }] };
  }));
  return server;
}

/** `bin/ste.mjs --mcp`: stdio until the host closes stdin. */
export function serveMcp(env = process.env) {
  const config = bridgeConfig(env);
  const handle = serveStdio(() => bridgeServer(config));
  process.stdin.once('end', () => { void handle.close().finally(() => process.exit(0)); }); // The host closed the pipe: exit, also with idle sockets open.
  return handle;
}
