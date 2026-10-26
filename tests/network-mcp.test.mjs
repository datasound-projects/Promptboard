// The MCP server for external hosts (src/network/mcp.mjs, `node bin/ste.mjs --mcp`) driven by the real
// @modelcontextprotocol/client 2.3.1 Client over StdioClientTransport, against the real server's machine listener:
// tools and strict schemas; list the allowed agent, submit (jobId at once), poll, read the result in bounded windows,
// cancel; an unauthorized agent refused; a submit while a job of the same provider runs only queues (no deadlock); the
// token only from the environment or a file (never argv), only to a loopback address, never in an answer or a log.
// Jobs run through the deterministic fake worker; no CLI or model runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { bridgeConfig, MCP_LIMITS } from '../src/network/mcp.mjs';
import { fakeWorker } from './helpers/network-worker.mjs';
import { fixture, until } from './helpers/network-machine.mjs';

const STE = fileURLToPath(new URL('../bin/ste.mjs', import.meta.url));
const TOOLS = ['agents_get', 'agents_list', 'artifacts_get', 'jobs_cancel', 'jobs_get', 'jobs_submit'];

/** A real MCP client that starts `node bin/ste.mjs --mcp` with `env` (and only the SDK's default inherited variables). */
async function connect(t, env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [STE, '--mcp'], env, stderr: 'pipe' });
  const log = { stderr: '' };
  transport.stderr?.on('data', chunk => { log.stderr += chunk; });
  const client = new Client({ name: 'promptboard-test-host', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close().catch(() => {}));
  const answers = [];
  const call = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); answers.push(JSON.stringify(result)); return result; };
  const json = async (name, args) => { const result = await call(name, args); assert.ok(!result.isError, `${name}: ${result.content?.[0]?.text}`); return JSON.parse(result.content[0].text); };
  return { client, call, json, log, answers };
}
const env = (ctx, token) => ({ PROMPTBOARD_MACHINE_URL: `http://127.0.0.1:${ctx.machinePort}`, PROMPTBOARD_MACHINE_TOKEN: token });
/** `node bin/ste.mjs --mcp …` run to its end with `env` and stdin closed: { code, stdout, stderr }. */
const run = (args, extraEnv) => new Promise(resolve => {
  const child = execFile(process.execPath, [STE, ...args], { env: { PATH: process.env.PATH, ...extraEnv }, timeout: 20_000 }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  child.stdin.end();
});

test('a real MCP client over stdio lists the tools and the allowed agent, submits (jobId at once), polls until completed, reads the result in bounded windows and cancels its own job; an unauthorized agent is refused', async t => {
  const long = 'Ünïcode line of the long report.\n'.repeat(5000); // About 170 KB, with two-byte characters.
  const ctx = await fixture(t, { worker: fakeWorker({ text: job => (job.request.input.text === 'Write the long report.' ? long : `Report for: ${job.request.input.text}`) }) });
  const lead = await ctx.register('lead'), scout = await ctx.register('scout');
  await ctx.on();
  const { token } = await ctx.client({ agents: [lead.id] });
  const host = await connect(t, env(ctx, token));
  const { tools } = await host.client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), TOOLS);
  for (const tool of tools) assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} is strict`);
  assert.equal(tools.find(tool => tool.name === 'jobs_submit').annotations.readOnlyHint, false);

  const { agents } = await host.json('agents_list');
  assert.deepEqual(agents.map(agent => [agent.id, agent.name, agent.provider]), [[lead.id, 'Lead', 'claude']]);
  assert.equal((await host.json('agents_get', { agentId: lead.id })).agent.id, lead.id);
  const started = Date.now();
  const submitted = await host.json('jobs_submit', { agentId: lead.id, input: 'Summarise the release notes.', idempotencyKey: 'mcp-1' });
  assert.ok(Date.now() - started < 3000, 'answered at once');
  assert.match(submitted.jobId, /^job_[0-9a-f]{20}$/);
  assert.deepEqual([submitted.status, submitted.deduplicated], ['queued', false]);
  const done = await until(async () => { const { job } = await host.json('jobs_get', { jobId: submitted.jobId }); return job.status === 'completed' && job; }, 'completed');
  assert.deepEqual([done.outcome, done.result.chars], ['completed', 'Report for: Summarise the release notes.'.length]);
  const artifact = await host.call('artifacts_get', { jobId: submitted.jobId });
  assert.deepEqual(JSON.parse(artifact.content[0].text), { jobId: submitted.jobId, offset: 0, nextOffset: null, totalChars: done.result.chars });
  assert.equal(artifact.content[1].text, 'Report for: Summarise the release notes.');
  assert.equal((await host.json('jobs_submit', { agentId: lead.id, input: 'Summarise the release notes.', idempotencyKey: 'mcp-1' })).jobId, submitted.jobId, 'a retried submit is the same job');

  // A long result comes in windows within the response limit and reads back whole.
  const big = await host.json('jobs_submit', { agentId: lead.id, input: 'Write the long report.' });
  await until(async () => (await host.json('jobs_get', { jobId: big.jobId })).job.status === 'completed', 'long completed');
  let text = '', offset = 0, windows = 0;
  for (; offset !== null; windows++) {
    const result = await host.call('artifacts_get', { jobId: big.jobId, offset, maxChars: 60_000 });
    assert.ok(Buffer.byteLength(result.content.map(item => item.text).join('')) <= MCP_LIMITS.answerBytes, 'within the limit');
    text += result.content[1].text; offset = JSON.parse(result.content[0].text).nextOffset;
  }
  assert.ok(windows >= 3);
  assert.equal(text, long);

  // Cancel its own job before it runs (it waits for the owner's approval).
  const waiting = await host.json('jobs_submit', { agentId: lead.id, input: 'Needs a yes.', requireApproval: true });
  assert.equal(waiting.status, 'waiting_for_approval');
  const cancelled = await host.json('jobs_cancel', { jobId: waiting.jobId });
  assert.deepEqual([cancelled.cancelled, cancelled.job.status], [true, 'cancelled']);

  // Refusals come back as tool errors: an agent outside the scope, another's job, memory, unknown or malformed arguments.
  for (const [name, args, pattern] of [['jobs_submit', { agentId: scout.id, input: 'Not mine.' }, /AGENT_NOT_ALLOWED/], ['agents_get', { agentId: scout.id }, /AGENT_NOT_ALLOWED/],
    ['jobs_submit', { agentId: lead.id, input: 'Memory.', memory: 'agent' }, /MEMORY_NOT_ALLOWED/], ['jobs_get', { jobId: `job_${'0'.repeat(20)}` }, /NOT_FOUND/],
    ['jobs_get', { jobId: submitted.jobId, extra: true }, /Unrecognized key|validation/i], ['jobs_submit', { agentId: lead.id, input: '' }, /validation|too_small|>=1/i],
    ['jobs_submit', { agentId: 'admin', input: 'x' }, /validation|Invalid/i], ['artifacts_get', { jobId: waiting.jobId }, /no result|NOT_FOUND/]]) {
    const result = await host.call(name, args);
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(result.content[0].text, pattern, `${name} ${JSON.stringify(args)}`);
  }
  assert.equal((await ctx.owner('/api/network/jobs?limit=200')).json.total, 3, 'no refused call made a job');
  const all = [...host.answers, host.log.stderr].join('\n');
  assert.ok(!all.includes(token) && !all.includes(token.slice(-43)) && !all.includes(ctx.session), 'no token in any answer or log');
});

test('same-provider nesting: an MCP submit while a job of the same provider runs answers at once and queues; nothing blocks; it runs when the slot frees', async t => {
  const worker = fakeWorker({ mode: 'manual' });
  const ctx = await fixture(t, { worker });
  const lead = await ctx.register('lead');
  await ctx.owner('/api/network/settings', 'PATCH', { expectedRevision: 0, maxConcurrentJobs: 1 });
  await ctx.on();
  const { token } = await ctx.client({ agents: [lead.id] });
  // The owner's job of the same provider (Claude) holds the only slot, as a host's own Claude session would.
  let next = worker.next();
  const outer = (await ctx.owner('/api/network/jobs', 'POST', { agentId: lead.id, input: { text: 'The outer job.' } })).json.jobId;
  const running = await next;
  await running.own.launching(); await running.own.spawned({ pid: 11 });
  const host = await connect(t, env(ctx, token));
  const started = Date.now();
  const inner = await host.json('jobs_submit', { agentId: lead.id, input: 'The nested job.' });
  const submitTook = Date.now() - started;
  assert.ok(submitTook < 3000, `submit answered in ${submitTook} ms`);
  assert.equal(inner.status, 'queued');
  for (let i = 0; i < 5; i++) {
    const { job } = await host.json('jobs_get', { jobId: inner.jobId });
    assert.deepEqual([job.status, job.waiting.for, job.waiting.position], ['queued', 'slot', 1], 'queued behind the running job, not blocked');
  }
  assert.equal((await ctx.owner(`/api/network/jobs/${outer}`)).json.job.status, 'running', 'the outer job keeps running');
  // The outer job ends; the nested one runs and completes.
  next = worker.next();
  await running.own.finish({ status: 'completed', exitCode: 0, result: { text: 'Outer done.' } }); running.end();
  const nested = await next;
  assert.equal(nested.own.jobId, inner.jobId);
  await nested.own.launching(); await nested.own.spawned({ pid: 12 });
  await nested.own.finish({ status: 'completed', exitCode: 0, result: { text: 'Nested done.' } }); nested.end();
  await until(async () => (await host.json('jobs_get', { jobId: inner.jobId })).job.status === 'completed', 'nested completed');
  assert.equal((await host.call('artifacts_get', { jobId: inner.jobId })).content[1].text, 'Nested done.');
});

test('the bridge takes the token only from its environment or a file, never from argv; only a loopback listener; refusals never repeat the token; stdout carries only MCP', async t => {
  const ctx = await fixture(t, { worker: null });
  const lead = await ctx.register('lead');
  await ctx.on();
  const { client, token } = await ctx.client({ agents: [lead.id] });
  // argv is refused before anything starts, so a token can never sit in a process list.
  for (const [args, pattern] of [[['--mcp', '--token', token], /Unknown option: --token/], [['--mcp', token], /Unknown option: a Promptboard client token/], [['--mcp', '--gui'], /--mcp takes no other option/]]) {
    const result = await run(args, { PROMPTBOARD_MACHINE_TOKEN: token });
    assert.equal(result.code, 1, args.join(' '));
    assert.match(result.stderr, pattern);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes(token), 'the refusal does not echo it');
  }
  for (const [extra, pattern] of [[{}, /No Promptboard client token/], [{ PROMPTBOARD_MACHINE_TOKEN: 'pbm_nope' }, /not valid/], [{ PROMPTBOARD_MACHINE_TOKEN_FILE: '/nonexistent/token' }, /cannot be read/],
    [{ PROMPTBOARD_MACHINE_TOKEN: token, PROMPTBOARD_MACHINE_URL: 'http://example.com:4330' }, /on this computer/], [{ PROMPTBOARD_MACHINE_TOKEN: token, PROMPTBOARD_MACHINE_URL: 'https://127.0.0.1:4330' }, /on this computer/],
    [{ PROMPTBOARD_MACHINE_TOKEN: token, PROMPTBOARD_MACHINE_URL: 'http://user:pass@127.0.0.1:4330' }, /on this computer/]]) {
    const result = await run(['--mcp'], extra);
    assert.equal(result.code, 1, JSON.stringify(Object.keys(extra)));
    assert.match(result.stderr, pattern);
    assert.equal(result.stdout, '', 'nothing but MCP on stdout');
    assert.ok(!result.stderr.includes(token));
  }
  assert.deepEqual(bridgeConfig({ PROMPTBOARD_MACHINE_TOKEN: ` ${token}\n` }), { url: 'http://127.0.0.1:4330', token });
  assert.deepEqual(bridgeConfig({ PROMPTBOARD_MACHINE_TOKEN: token, PROMPTBOARD_MACHINE_URL: 'http://localhost:5000/' }).url, 'http://localhost:5000');
  assert.throws(() => bridgeConfig({ PROMPTBOARD_MACHINE_TOKEN: token, PROMPTBOARD_MACHINE_URL: 'http://127.0.0.1:4330/machine' }), /on this computer/);
  // A token file works (the snippet for hosts that do not expand variables).
  const folder = await mkdtemp(join(tmpdir(), 'pb-mcp-token-')); t.after(() => rm(folder, { recursive: true, force: true }));
  await writeFile(join(folder, 'token'), `${token}\n`, { mode: 0o600 });
  const fromFile = await connect(t, { PROMPTBOARD_MACHINE_URL: `http://127.0.0.1:${ctx.machinePort}`, PROMPTBOARD_MACHINE_TOKEN_FILE: join(folder, 'token') });
  assert.deepEqual((await fromFile.json('agents_list')).agents.map(agent => agent.id), [lead.id]);
  // Revoked: every call is a tool error that names the code and never the token. The listener turned off: a clear error.
  await ctx.owner(`/api/network/clients/${client.id}`, 'DELETE', {});
  const revoked = await fromFile.call('agents_list');
  assert.equal(revoked.isError, true);
  assert.match(revoked.content[0].text, /MACHINE_UNAUTHORIZED/);
  const other = await ctx.client({ agents: [lead.id] });
  const host = await connect(t, env(ctx, other.token));
  await ctx.owner('/api/network/listener', 'PATCH', { enabled: false });
  const off = await host.call('agents_list');
  assert.equal(off.isError, true);
  assert.match(off.content[0].text, /did not answer.*Network → Settings/);
  const everything = [...fromFile.answers, ...host.answers, fromFile.log.stderr, host.log.stderr].join('\n');
  for (const secret of [token, other.token]) assert.ok(!everything.includes(secret) && !everything.includes(secret.slice(-43)));
});
