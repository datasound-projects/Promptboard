// A stand-in for the headless Claude Code, Codex and Gemini CLIs (named by the file it is installed as): it prints their
// documented machine-readable output and records each run, so Network job tests never start a real CLI. Markers in the
// prompt choose a scenario: [[hang]] (starts a helper process in its own group, then waits for ever), [[noresult]] (exit 0
// without the structured final answer), [[rate]] (a structured rate limit), [[auth]] (signed out), [[crash]] (exit 3), [[big]] (output over the
// limit), [[usage]] (token counts and cost), [[nosession]] (no session or thread ID), [[json]] (a fenced json block),
// [[slow:<ms>]] (a pause before answering), [[barrier:<name>:<n>]] (wait until n runs carrying it have started, so a test proves
// they ran at the same time without timing; exit 4 after 30 s), [[delegate:<agt_id>]] (Task 12: the report ends with a delegation
// request for that agent, unless the prompt carries earlier work on the job, when it answers finally), [[ask]] (the same with one
// question for whoever submitted the job). FAKE_HEADLESS_LOG names a folder for one <pid>.json per run and <pid>.end.
import { spawn } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const cli = basename(process.argv[1]), args = process.argv.slice(2), log = process.env.FAKE_HEADLESS_LOG;
const out = event => process.stdout.write(`${JSON.stringify(event)}\n`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
if (cli === 'codex' && args[0] === 'mcp') { out([{ name: 'ambient', enabled: true, transport: { type: 'stdio', command: 'DO_NOT_START' } }]); process.exit(0); }
let input = ''; for await (const chunk of process.stdin) input += chunk;
const has = name => input.includes(`[[${name}]]`);
const record = extra => log && writeFileSync(join(log, `${process.pid}.json`), JSON.stringify({ cli, args, cwd: process.cwd(), entries: readdirSync(process.cwd()), input, pid: process.pid, at: Date.now(), ...extra }));
let helper = null;
if (has('hang')) helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).pid; // Same process group as this CLI.
record(helper ? { helper } : {});
const barrier = /\[\[barrier:([a-z]+):(\d+)\]\]/.exec(input), tag = barrier && `barrier-${barrier[1]}-`;
if (barrier && log) {
  writeFileSync(join(log, `${tag}${process.pid}`), '');
  for (const until = Date.now() + 30000; readdirSync(log).filter(name => name.startsWith(tag)).length < Number(barrier[2]); await pause(20)) if (Date.now() > until) { process.stderr.write('barrier timeout'); process.exit(4); }
}
const slow = /\[\[slow:(\d+)\]\]/.exec(input);
if (slow) await pause(Number(slow[1]));
const delegateTo = /\[\[delegate:(agt_[0-9a-f]{20})\]\]/.exec(input)?.[1], continuing = input.includes('=== EARLIER WORK ON THIS JOB');
const request = continuing ? null : delegateTo ? { delegate: [{ agentId: delegateTo, task: 'Check the figures.' }] } : has('ask') ? { needs_input: { question: 'Which region?' } } : null;
const handoff = request ? `\n\n\`\`\`json\n${JSON.stringify({ promptboard: request })}\n\`\`\`` : '';
const text = continuing ? `Final answer from ${cli}, with what came back.` : `Answer from ${cli}.${has('json') ? '\n\n```json\n{ "verdict": "ok", "items": [1, 2] }\n```' : ''}${handoff}`;
// Exits once everything written has reached the pipe (macOS pipes are asynchronous); `await end()` stops the script there.
const end = code => new Promise(() => { if (log) writeFileSync(join(log, `${process.pid}.end`), String(Date.now())); process.stdout.write('', () => process.exit(code)); });
const hang = async () => { await new Promise(() => setInterval(() => {}, 1000)); };

if (cli === 'claude') {
  if (has('rate')) { out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1900000000 } }); out({ type: 'result', is_error: true, result: '' }); await end(1); }
  if (has('crash')) { process.stderr.write('unexpected failure'); await end(3); }
  if (has('auth')) { out({ type: 'assistant', error: 'authentication_failed', message: { content: [] } }); out({ type: 'result', is_error: true, result: 'Not logged in' }); await end(1); }
  if (!has('nosession')) out({ type: 'system', subtype: 'init', session_id: 'claude-session-1' });
  if (args[args.indexOf('--tools') + 1].includes('WebSearch')) out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebSearch', input: { query: 'release notes /Users/someone/private' } }] } });
  if (has('hang')) await hang();
  if (has('big')) { const chunk = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x'.repeat(65536) } } }); for (let i = 0; i < 270; i++) process.stdout.write(`${chunk}\n`); }
  for (const part of text.split(/(?<=\.)/)) out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: part } } });
  if (!has('noresult')) out({ type: 'result', subtype: 'success', is_error: false, result: text, ...(has('nosession') ? {} : { session_id: 'claude-session-1' }),
    ...(has('usage') ? { usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 7 }, total_cost_usd: 0.0123 } : {}) });
  await end(0);
} else if (cli === 'codex') {
  if (has('rate')) { out({ type: 'error', message: 'unexpected status 429 Too Many Requests' }); out({ type: 'turn.failed', error: { message: 'unexpected status 429 Too Many Requests' } }); await end(1); }
  if (has('crash')) await end(3);
  if (!has('nosession')) out({ type: 'thread.started', thread_id: 'codex-thread-1' });
  out({ type: 'turn.started' });
  if (args.includes('web_search="live"')) { out({ type: 'item.started', item: { id: 'w1', type: 'web_search', query: '' } }); out({ type: 'item.completed', item: { id: 'w1', type: 'web_search', query: 'release notes', action: { type: 'search', query: 'release notes' } } }); }
  if (has('hang')) await hang();
  out({ type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'HIDDEN REASONING' } });
  if (!has('noresult')) out({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text } });
  out({ type: 'turn.completed', usage: has('usage') ? { input_tokens: 90, cached_input_tokens: 40, output_tokens: 12 } : {} });
  await end(0);
} else {
  if (has('rate')) { process.stdout.write(JSON.stringify({ error: { type: 'RetryableQuotaError', message: 'quota' } })); await end(1); }
  if (has('crash')) await end(3);
  if (has('hang')) await hang();
  if (has('noresult')) { process.stdout.write('Loaded cached credentials.\n'); await end(0); }
  process.stdout.write(JSON.stringify({ response: has('big') ? 'y'.repeat(2_200_000) : text, stats: { models: { 'gemini-2.5-flash': {} } } }));
  await end(0);
}
