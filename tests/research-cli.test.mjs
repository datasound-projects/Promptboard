import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { researchArgs, streamResearch } from '../src/research-cli.mjs';

// Fake Claude Code and Codex that write their documented streaming events with pauses, so streaming is observable.
const FAKE = `#!${process.execPath}
import { basename } from 'node:path';
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2), cli = basename(process.argv[1]);
if (args[0] === 'mcp') { process.stdout.write(JSON.stringify([{ name: 'ambient', enabled: true, transport: { type: 'stdio', command: 'DO_NOT_START' } }])); process.exit(0); }
let input = ''; for await (const chunk of process.stdin) input += chunk;
if (process.env.FAKE_ARGS) writeFileSync(process.env.FAKE_ARGS, JSON.stringify({ args, input, cwd: process.cwd() }));
const out = event => process.stdout.write(JSON.stringify(event) + '\\n');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const value = name => args[args.indexOf(name) + 1];
if (cli === 'claude') {
  const session = args.includes('--resume') ? value('--resume') : value('--session-id');
  if (session === 'missing-session') { process.stderr.write('No conversation found with session ID: missing-session'); process.exit(1); }
  if (input.includes('RATE')) { out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1900000000 } }); out({ type: 'result', is_error: true, result: '' }); process.exit(1); }
  out({ type: 'system', subtype: 'init', session_id: session });
  if (value('--tools')?.includes('WebSearch')) out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebSearch', input: { query: 'postgres license' } }] } });
  for (const text of ['Postgres ', 'fits ', 'well.']) { out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }); await pause(input.includes('HANG') ? 0 : 150); if (input.includes('HANG')) { setInterval(() => {}, 1000); await new Promise(() => {}); } }
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Postgres fits well.', session_id: session });
} else {
  const thread = args[1] === 'resume' ? args[2] : 'thread-1';
  if (thread === 'missing-thread') { out({ type: 'error', message: 'thread not found' }); process.exit(1); }
  out({ type: 'thread.started', thread_id: thread }); out({ type: 'turn.started' });
  if (args.includes('web_search="live"')) { out({ type: 'item.started', item: { id: 'w1', type: 'web_search', query: '', action: { type: 'other' } } }); out({ type: 'item.completed', item: { id: 'w1', type: 'web_search', query: 'kafka vs rabbitmq', action: { type: 'search', query: 'kafka vs rabbitmq' } } }); }
  await pause(150);
  out({ type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'HIDDEN REASONING' } });
  out({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Use RabbitMQ.' } });
  out({ type: 'turn.completed', usage: {} });
}
`;

async function fakes(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pb-research-cli-')), oldPath = process.env.PATH;
  for (const name of ['claude', 'codex']) { await writeFile(join(dir, name), FAKE); await chmod(join(dir, name), 0o700); }
  await writeFile(join(dir, 'package.json'), '{"type":"module"}');
  process.env.PATH = dir; process.env.FAKE_ARGS = join(dir, 'args.json');
  t.after(async () => { process.env.PATH = oldPath; delete process.env.FAKE_ARGS; await rm(dir, { recursive: true, force: true }); });
  return { dir, seen: async () => JSON.parse(await readFile(join(dir, 'args.json'), 'utf8')) };
}

test('research arguments are read-only, web search is off unless asked for, and sessions resume by ID', () => {
  const claude = researchArgs({ provider: 'claude', session: { id: 's1', resume: false } });
  assert.deepEqual(claude.slice(claude.indexOf('--tools'), claude.indexOf('--tools') + 2), ['--tools', ''], 'no tools by default');
  assert.ok(!claude.includes('--allowedTools') && claude.includes('--strict-mcp-config') && claude.includes('--disable-slash-commands') && claude.includes('--include-partial-messages'));
  assert.deepEqual(claude.slice(-2), ['--session-id', 's1']);
  const web = researchArgs({ provider: 'claude', web: true, session: { id: 's1', resume: true } });
  assert.deepEqual(web.slice(web.indexOf('--tools'), web.indexOf('--tools') + 4), ['--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch,WebFetch']);
  assert.deepEqual(web.slice(-2), ['--resume', 's1']);
  const codex = researchArgs({ provider: 'codex' }), resumed = researchArgs({ provider: 'codex', web: true, session: { id: 't1', resume: true } });
  for (const flag of ['sandbox_mode="read-only"', 'approval_policy="never"', 'web_search="disabled"', 'shell_tool', 'unified_exec']) assert.ok(codex.includes(flag), flag);
  assert.deepEqual(resumed.slice(0, 3), ['exec', 'resume', 't1']);
  assert.ok(resumed.includes('web_search="live"'));
  for (const args of [claude, web, codex, resumed]) assert.ok(!args.some(arg => /dangerously|bypass|full-auto|--yolo|skip-permissions/.test(arg)), 'never bypasses approvals or the sandbox');
});

test('Claude Code text streams while the CLI works; sessions, web activity and the final text are reported', { skip: process.platform === 'win32' }, async t => {
  const { dir, seen } = await fakes(t);
  const events = [], started = Date.now();
  const result = await streamResearch({ provider: 'claude', prompt: 'Which database?', cwd: dir, web: true, session: { id: 'session-1', resume: false }, onEvent: event => events.push({ ...event, at: Date.now() - started }) });
  assert.deepEqual(result.text, 'Postgres fits well.');
  assert.equal(result.session, 'session-1');
  const deltas = events.filter(event => event.type === 'delta');
  assert.deepEqual(deltas.map(event => event.text), ['Postgres ', 'fits ', 'well.']);
  assert.ok(deltas[2].at - deltas[0].at >= 200, 'the first text arrives before the run ends, not all at once');
  assert.deepEqual(events.find(event => event.type === 'activity'), { type: 'activity', kind: 'search', label: 'postgres license', at: events.find(event => event.type === 'activity').at });
  const { args, input, cwd } = await seen();
  assert.equal(input, 'Which database?');
  assert.equal(cwd.endsWith(dir.split('/').pop()), true);
  assert.ok(args.includes('WebSearch,WebFetch'));
});

test('Codex research streams messages and web activity, never its reasoning, and resumes threads', { skip: process.platform === 'win32' }, async t => {
  const { dir, seen } = await fakes(t);
  const events = [];
  const result = await streamResearch({ provider: 'codex', prompt: 'Queue?', cwd: dir, web: true, onEvent: event => events.push(event) });
  assert.deepEqual([result.text, result.session], ['Use RabbitMQ.', 'thread-1']);
  assert.deepEqual(events.map(event => [event.type, event.label]), [['activity', 'kafka vs rabbitmq'], ['delta', undefined]]);
  assert.ok(!JSON.stringify(events).includes('HIDDEN REASONING'));
  const { args } = await seen();
  assert.ok(args.includes('--config') && args.some(arg => arg.startsWith('mcp_servers={"ambient"={enabled=false')), 'MCP servers from the user’s configuration are disabled');
  assert.equal(args.at(-1), '-');
  await streamResearch({ provider: 'codex', prompt: 'And?', cwd: dir, session: { id: 'thread-1', resume: true } });
  assert.deepEqual((await seen()).args.slice(0, 3), ['exec', 'resume', 'thread-1']);
});

test('research runs stop at once, keep the text produced so far, classify provider failures and report a session that cannot resume', { skip: process.platform === 'win32' }, async t => {
  const { dir } = await fakes(t);
  const controller = new AbortController(), events = [];
  const run = streamResearch({ provider: 'claude', prompt: 'HANG', cwd: dir, session: { id: 'session-2', resume: false }, signal: controller.signal, onEvent: event => { events.push(event); if (event.type === 'delta') controller.abort(); } });
  await assert.rejects(run, error => error.code === 'ABORTED' && error.partial === 'Postgres ');
  await assert.rejects(streamResearch({ provider: 'claude', prompt: 'RATE', cwd: dir, session: { id: 'session-3', resume: false } }), { code: 'RATE_LIMITED' });
  await assert.rejects(streamResearch({ provider: 'claude', prompt: 'Again?', cwd: dir, session: { id: 'missing-session', resume: true } }), error => error.resumeFailed === true);
  await assert.rejects(streamResearch({ provider: 'codex', prompt: 'Again?', cwd: dir, session: { id: 'missing-thread', resume: true } }), error => error.resumeFailed === true);
  await assert.rejects(streamResearch({ provider: 'gemini', prompt: 'x', cwd: dir }), { code: 'INVALID_PROVIDER' });
  await assert.rejects(streamResearch({ provider: 'claude', prompt: 'x', cwd: dir, model: '--dangerously-skip-permissions' }), { code: 'INVALID_MODEL' });
});

test('Stop pressed while the CLI is still being looked up stops the research before the CLI answers', { skip: process.platform === 'win32' }, async t => {
  const { dir } = await fakes(t);
  const controller = new AbortController(), started = Date.now();
  const run = streamResearch({ provider: 'claude', prompt: 'Compare queues', cwd: dir, session: { id: 'session-9', resume: false }, signal: controller.signal });
  controller.abort(); // The run is past its first check and awaiting the CLI lookup.
  await assert.rejects(run, { code: 'ABORTED' });
  assert.ok(Date.now() - started < 3500, 'stopped, not run to the end');
});
