// Simulated interactive coding-agent CLI for tests. It is NOT a real provider.
// It reads the lifecycle configuration the adapter passes (Claude --settings hooks,
// Codex -c notify, Gemini system-settings hooks) and invokes it the same way the real
// CLIs document. Scenario words in the task text choose the behavior.
const { spawnSync } = require('node:child_process');
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const { basename, join } = require('node:path');

const provider = basename(process.argv[1]).replace(/\.cjs$/, '');
const args = process.argv.slice(2);
const flag = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const report = process.env.FAKE_AGENT_REPORT;
if (report) appendFileSync(report, JSON.stringify({ provider, pid: process.pid, cwd: process.cwd(), args }) + '\n');

let prompt = '';
let emit = () => {};
if (provider === 'claude') {
  const hooks = JSON.parse(flag('--settings')).hooks;
  prompt = flag('--resume') ? (args.includes('--') ? args[args.indexOf('--') + 1] : '') : args.at(-1).startsWith('-') ? '' : args.at(-1);
  emit = (name, extra = {}) => {
    for (const group of hooks[name] || []) for (const hook of group.hooks) {
      spawnSync(hook.command, hook.args, { input: JSON.stringify({ hook_event_name: name, session_id: flag('--resume') || flag('--session-id'), cwd: process.cwd(), ...extra }) });
    }
  };
} else if (provider === 'codex') {
  const notify = JSON.parse(args[args.indexOf('-c') + 1].slice('notify='.length));
  prompt = args[0] === 'resume' ? (args.includes('--') ? args[args.indexOf('--') + 1] : '') : args.at(-1);
  emit = (name, extra = {}) => {
    if (name !== 'Stop') return;
    spawnSync(notify[0], [...notify.slice(1), JSON.stringify({ type: 'agent-turn-complete', 'thread-id': args[0] === 'resume' ? args[1] : 'thread-1', 'last-assistant-message': extra.last_assistant_message })]);
  };
} else if (provider === 'gemini') {
  const settings = JSON.parse(readFileSync(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, 'utf8'));
  prompt = flag('--prompt-interactive') ? JSON.parse(flag('--prompt-interactive').split('\n').slice(1).join('\n')) : '';
  const map = { SessionStart: 'SessionStart', UserPromptSubmit: 'BeforeAgent', Stop: 'AfterAgent', PermissionRequest: 'Notification', PreToolUse: 'BeforeTool', PostToolUse: 'AfterTool', SessionEnd: 'SessionEnd' };
  emit = (name, extra = {}) => {
    const event = map[name];
    const { tool_use_id, ...geminiExtra } = extra; // Gemini's documented tool hooks have no Claude tool-use ID.
    for (const group of settings.hooks[event] || []) for (const hook of group.hooks) {
      spawnSync('/bin/sh', ['-c', hook.command], { input: JSON.stringify({ ...geminiExtra, hook_event_name: event, session_id: flag('--resume') || 'gemini-session', prompt_response: extra.last_assistant_message, notification_type: name === 'PermissionRequest' ? 'ToolPermission' : undefined }) });
    }
  };
}

if (prompt.includes('IGNORE_TERM')) process.on('SIGTERM', () => {});
process.stdout.write(`fake ${provider} started in ${process.cwd()}\r\n`);
// Report terminal size changes so tests can see resizes reach the process.
process.on('SIGWINCH', () => process.stdout.write(`size ${process.stdout.columns}x${process.stdout.rows}\r\n`));
if (prompt.includes('FLOOD')) { for (let i = 0; i < 40000; i++) process.stdout.write(`flood line ${i} ${'x'.repeat(80)}\r\n`); }
if (prompt.includes('HTML_PAYLOAD')) process.stdout.write('<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>\r\n');
// USAGE: write the CLI's own session file (Claude transcript / Codex rollout) with token counts.
let transcript;
if (prompt.includes('USAGE') && provider === 'claude') {
  transcript = join(process.env.FAKE_CLAUDE_PROJECTS, `${flag('--resume') || flag('--session-id')}.jsonl`);
  const line = (id, input, read, write, output) => JSON.stringify({ type: 'assistant', message: { id, model: 'claude-test-model', usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: output } } });
  // The same message appears twice (streamed blocks): it must count once.
  writeFileSync(transcript, [line('m1', 10, 1000, 200, 50), line('m1', 10, 1000, 200, 50), line('m2', 5, 1200, 0, 70), JSON.stringify({ type: 'user', message: { content: 'secret text' } })].join('\n') + '\n');
}
if (prompt.includes('USAGE') && provider === 'codex') {
  const d = new Date();
  const dir = join(process.env.CODEX_HOME, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  require('node:fs').mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'rollout-2026-01-01T00-00-00-thread-1.jsonl'), [JSON.stringify({ type: 'session_meta', payload: { id: 'thread-1', source: 'cli' } }), JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-test', effort: 'low' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 15000, cached_input_tokens: 7000, output_tokens: 100 }, last_token_usage: { input_tokens: 15000, output_tokens: 100 }, model_context_window: 200000 }, rate_limits: { primary: { used_percent: 40, resets_at: 1791048036 } } } })].join('\n') + '\n');
}
const baseEmit = emit;
emit = (name, extra = {}) => baseEmit(name, { ...(transcript ? { transcript_path: transcript } : {}), ...(flag('--resume') && process.env.FAKE_AGENT_RESUME_ID ? { session_id: process.env.FAKE_AGENT_RESUME_ID } : {}), ...extra });
emit('SessionStart');
let planApprovalSequence = 0;
function turn(text) {
  if (prompt.includes('ACTIVITY_FIXTURE') && text.startsWith('activity-')) {
    const tool = provider === 'gemini' ? 'exit_plan_mode' : 'ExitPlanMode';
    if (text === 'activity-start') {
      emit('PreToolUse', { tool_name: 'Bash', tool_use_id: 'main-tool' });
      emit('SubagentStart', { agent_id: 'child' });
      emit('PreToolUse', { agent_id: 'child', tool_name: 'Read', tool_use_id: 'child-tool' });
      emit('Stop', { agent_id: 'child', last_assistant_message: 'Child response must not replace parent output.' });
      emit('Stop', { last_assistant_message: 'Parent response with outstanding work.', background_tasks: [{ command: 'PRIVATE COMMAND' }], session_crons: [{ prompt: 'PRIVATE CRON' }] });
    } else if (text === 'activity-finish') {
      emit('PostToolUse', { tool_name: 'Bash', tool_use_id: 'main-tool' });
      emit('PostToolUse', { agent_id: 'child', tool_name: 'Read', tool_use_id: 'child-tool' });
      emit('SubagentStop', { agent_id: 'child', background_tasks: [], session_crons: [] });
      emit('Stop', { last_assistant_message: 'All work finished.', background_tasks: [], session_crons: [] });
    } else if (text === 'activity-plan-request') {
      emit('PreToolUse', { tool_name: tool, tool_use_id: 'plan-tool' });
      emit('PermissionRequest', { tool_name: tool });
    } else if (text === 'activity-unrelated-results') {
      emit('PostToolUse', { tool_name: 'Read', tool_use_id: 'unrelated-main' });
      emit('PostToolUse', { agent_id: 'other-child', tool_name: 'Read', tool_use_id: 'unrelated-child' });
    } else if (text === 'activity-child-permission') {
      emit('SubagentStart', { agent_id: 'child' });
      emit('PermissionRequest', { agent_id: 'child', tool_name: 'Bash' });
      emit('Stop', { last_assistant_message: 'Parent finished while child awaits permission.' });
    } else if (text === 'activity-plan-reject') {
      if (provider === 'gemini') emit('PostToolUse', { tool_name: tool, tool_response: { returnDisplay: 'Rejected (no feedback)' } });
      else emit('PostToolUseFailure', { tool_name: tool, tool_use_id: 'plan-tool' });
    } else if (text === 'activity-plan-approve' || text === 'activity-plan-approve-working') {
      emit('PostToolUse', { tool_name: tool, tool_use_id: `approved-plan-tool-${++planApprovalSequence}`, tool_response: { returnDisplay: 'Plan approved: /fixture/plan.md' } });
      if (text === 'activity-plan-approve-working') {
        // Native approval already starts implementation; routing must not
        // wait for Stop or inject another task/continuation into this turn.
        emit('PreToolUse', { tool_name: 'Bash', tool_use_id: 'main-tool' });
        writeFileSync(join(process.cwd(), 'native-implementation.txt'), 'Native approved implementation is still running.\n');
      } else emit('Stop', { last_assistant_message: 'Approved plan.', background_tasks: [], session_crons: [] });
    } else if (text === 'activity-enter-plan') {
      const enter = provider === 'gemini' ? 'enter_plan_mode' : 'EnterPlanMode';
      emit('PreToolUse', { tool_name: enter, tool_use_id: 'enter-plan-tool' });
      emit('PostToolUse', { tool_name: enter, tool_use_id: 'enter-plan-tool', tool_response: { returnDisplay: 'Switching to Plan mode' } });
      emit('Stop', { last_assistant_message: 'Planning again.', background_tasks: [], session_crons: [] });
    } else if (text === 'activity-child-failure') {
      emit('StopFailure', { agent_id: 'child', error: 'billing_error' });
    }
    process.stdout.write(`${text} emitted\r\n`); return;
  }
  emit('UserPromptSubmit');
  process.stdout.write(`working on ${text.length} characters\r\n`);
  if (text.includes('BILLING')) { emit('StopFailure', { error: 'billing_error', last_assistant_message: 'API Error: billing' }); return; }
  // Real CLIs enforce read-only planning (plan mode, read-only tools or sandbox, deny policy).
  // The fake models that: it only writes when no read-only flag was passed.
  const readOnly = args.includes('plan') || args.includes('read-only');
  // FAKE_AGENT_WRITE=1 (demo recordings): every writing session adds its own file, named after the worktree.
  if (process.env.FAKE_AGENT_WRITE === '1' && !readOnly && !text.includes('=== DIFF:')) writeFileSync(join(process.cwd(), `work-${basename(process.cwd()).slice(0, 8)}.txt`), `${text.split('\n').find(line => line.trim() && !line.startsWith('==='))?.slice(0, 80) || 'work'}\n`, { flag: 'a' });
  // WRITE_FILE is implementation work: a well-behaved testing agent (stage instructions "Test the task below") does
  // not write it; TESTER_WRITES makes the tester change files anyway.
  const tester = text.startsWith('Test the task below');
  if (text.includes('WRITE_FILE') && (!tester || text.includes('TESTER_WRITES'))) {
    if (readOnly) process.stdout.write('write denied: read-only planning session\r\n');
    else writeFileSync(join(process.cwd(), (text.match(/WRITE_FILE:([\w.-]+)/) || [])[1] || 'agent-output.txt'), `written by the agent${process.env.FAKE_AGENT_STATE ? ` ${Date.now()}` : ''}\n`);
  }
  // A misbehaving CLI that ignores its read-only mode (the stage engine must catch it).
  if (text.includes('WRITE_ANYWAY') && readOnly && !text.includes('=== DIFF:')) writeFileSync(join(process.cwd(), 'planner-wrote-this.txt'), 'should not exist\n');
  if (text.includes('EXIT_NOW')) process.exit(0);
  const plan = args.includes('plan') || args.includes('read-only');
  // Review requests carry the diff; answer with the findings format the review stage asks for.
  // REVIEW_FAIL_ONCE fails the first review of the task, using a marker in FAKE_AGENT_STATE (outside the worktree).
  let failOnce = false;
  if (text.includes('=== DIFF:') && text.includes('REVIEW_FAIL_ONCE') && process.env.FAKE_AGENT_STATE) {
    const marker = join(process.env.FAKE_AGENT_STATE, `review-${(text.match(/TASK_KEY:(\w+)/) || [])[1] || 'task'}`);
    try { readFileSync(marker); } catch { writeFileSync(marker, 'failed once\n'); failOnce = true; }
  }
  const review = text.includes('=== DIFF:') ? (text.includes('REVIEW_GARBAGE') ? 'Looks fine to me, no structured verdict.' : '```json\n' + JSON.stringify((text.includes('REVIEW_FAIL') && !text.includes('REVIEW_FAIL_ONCE')) || failOnce
    ? { verdict: 'changes_required', findings: [{ severity: 'high', file: 'feature.txt', line: 1, explanation: 'The value is wrong.' }] }
    : { verdict: 'no_issues', findings: [] }) + '\n```') : null;
  emit('Stop', { last_assistant_message: review || (plan ? `PLAN\n1. Change the code.\nsaw ${text.length} chars` : 'Implemented the change.') });
  process.stdout.write('turn complete\r\n');
}
// Codex asks through its terminal title, not a hook; answering it continues the turn.
let codexQuestion = prompt.includes('CODEX_QUESTION');
if (codexQuestion) process.stdout.write('\x1b]0;[ ! ] Action Required | thread-1\x07Allow this command? (y)\r\n\x1b]0;[ . ] Action Required | thread-1\x07');
else if (prompt.includes('ASK_PERMISSION')) {
  emit('PermissionRequest', { tool_name: 'Bash' });
  process.stdout.write('Allow Bash? (y/n)\r\n');
}
else if (prompt) turn(prompt);
if (process.env.FAKE_AGENT_PROMPT_FILE) writeFileSync(process.env.FAKE_AGENT_PROMPT_FILE, prompt);
process.stdin.setRawMode?.(true);
let line = '';
process.stdin.on('data', chunk => {
  line += chunk.toString();
  if (!/[\r\n]/.test(line)) return;
  const text = line.trim(); line = '';
  process.stdout.write(`you said: ${text}\r\n`);
  if (codexQuestion) { codexQuestion = false; process.stdout.write('\x1b]0;\u280b thread-1\x07'); }
  if (text === 'quit') process.exit(0);
  turn(text === 'y' ? prompt : text);
});
setInterval(() => {}, 1000);
