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
  prompt = args.at(-1).startsWith('-') ? '' : args.at(-1);
  emit = (name, extra = {}) => {
    for (const group of hooks[name] || []) for (const hook of group.hooks) {
      spawnSync(hook.command, hook.args, { input: JSON.stringify({ hook_event_name: name, session_id: flag('--session-id'), cwd: process.cwd(), ...extra }) });
    }
  };
} else if (provider === 'codex') {
  const notify = JSON.parse(args[args.indexOf('-c') + 1].slice('notify='.length));
  prompt = args.at(-1);
  emit = (name, extra = {}) => {
    if (name !== 'Stop') return;
    spawnSync(notify[0], [...notify.slice(1), JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'thread-1', 'last-assistant-message': extra.last_assistant_message })]);
  };
} else if (provider === 'gemini') {
  const settings = JSON.parse(readFileSync(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, 'utf8'));
  prompt = JSON.parse(flag('--prompt-interactive').split('\n').slice(1).join('\n'));
  const map = { SessionStart: 'SessionStart', UserPromptSubmit: 'BeforeAgent', Stop: 'AfterAgent', PermissionRequest: 'Notification' };
  emit = (name, extra = {}) => {
    const event = map[name];
    for (const group of settings.hooks[event] || []) for (const hook of group.hooks) {
      spawnSync('/bin/sh', ['-c', hook.command], { input: JSON.stringify({ hook_event_name: event, session_id: 'gemini-session', prompt_response: extra.last_assistant_message, notification_type: name === 'PermissionRequest' ? 'ToolPermission' : undefined }) });
    }
  };
}

process.stdout.write(`fake ${provider} started in ${process.cwd()}\r\n`);
// Report terminal size changes so tests can see resizes reach the process.
process.on('SIGWINCH', () => process.stdout.write(`size ${process.stdout.columns}x${process.stdout.rows}\r\n`));
if (prompt.includes('FLOOD')) { for (let i = 0; i < 40000; i++) process.stdout.write(`flood line ${i} ${'x'.repeat(80)}\r\n`); }
if (prompt.includes('HTML_PAYLOAD')) process.stdout.write('<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>\r\n');
emit('SessionStart');
function turn(text) {
  emit('UserPromptSubmit');
  process.stdout.write(`working on ${text.length} characters\r\n`);
  if (text.includes('BILLING')) { emit('StopFailure', { error: 'billing_error', last_assistant_message: 'API Error: billing' }); return; }
  // Real CLIs enforce read-only planning (plan mode, read-only tools or sandbox, deny policy).
  // The fake models that: it only writes when no read-only flag was passed.
  const readOnly = args.includes('plan') || args.includes('read-only');
  if (text.includes('WRITE_FILE')) {
    if (readOnly) process.stdout.write('write denied: read-only planning session\r\n');
    else writeFileSync(join(process.cwd(), 'agent-output.txt'), 'written by the agent\n');
  }
  if (text.includes('EXIT_NOW')) process.exit(0);
  const plan = args.includes('plan') || args.includes('read-only');
  // Review requests carry the diff; answer with the findings format the review stage asks for.
  const review = text.includes('=== DIFF:') ? '```json\n' + JSON.stringify(text.includes('REVIEW_FAIL')
    ? { verdict: 'changes_required', findings: [{ severity: 'high', file: 'feature.txt', line: 1, explanation: 'The value is wrong.' }] }
    : { verdict: 'no_issues', findings: [] }) + '\n```' : null;
  emit('Stop', { last_assistant_message: review || (plan ? `PLAN\n1. Change the code.\nsaw ${text.length} chars` : 'Implemented the change.') });
  process.stdout.write('turn complete\r\n');
}
if (prompt.includes('ASK_PERMISSION')) {
  emit('PermissionRequest', { tool_name: 'Bash' });
  process.stdout.write('Allow Bash? (y/n)\r\n');
}
else turn(prompt);
if (process.env.FAKE_AGENT_PROMPT_FILE) writeFileSync(process.env.FAKE_AGENT_PROMPT_FILE, prompt);
process.stdin.setRawMode?.(true);
let line = '';
process.stdin.on('data', chunk => {
  line += chunk.toString();
  if (!/[\r\n]/.test(line)) return;
  const text = line.trim(); line = '';
  process.stdout.write(`you said: ${text}\r\n`);
  if (text === 'quit') process.exit(0);
  turn(text === 'y' ? prompt : text);
});
setInterval(() => {}, 1000);
