// Offline PTY fixture: acknowledge bracketed paste only after its explicit Enter.
const { spawnSync } = require('node:child_process');
const { writeFileSync, appendFileSync } = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const args = process.argv.slice(2), flag = name => args[args.indexOf(name) + 1];
const settings = JSON.parse(flag('--settings'));
const emit = (name, extra = {}) => {
  for (const group of settings.hooks[name] || []) for (const hook of group.hooks) {
    spawnSync(hook.command, hook.args, { input: JSON.stringify({ hook_event_name: name, session_id: flag('--session-id'), ...extra }) });
  }
};
const report = process.env.FAKE_INITIAL_INPUT_FILE;
if (!report) throw new Error('This fixture requires its disposable capture path.');
writeFileSync(report, JSON.stringify({ kind: 'ready', args }) + '\n');
emit('SessionStart');
process.stdin.setRawMode?.(true);
let buffer = '', submissions = 0; const decoder = new StringDecoder('utf8');
process.stdin.on('data', chunk => {
  buffer += decoder.write(chunk);
  const end = buffer.indexOf('\x1b[201~');
  if (!buffer.startsWith('\x1b[200~') || end < 0 || buffer[end + 6] !== '\r') return;
  const text = buffer.slice(6, end); buffer = buffer.slice(end + 7); submissions++;
  appendFileSync(report, JSON.stringify({ kind: 'submitted', text, submissions }) + '\n');
  emit('UserPromptSubmit'); emit('Stop', { last_assistant_message: 'The exact initial envelope was received.' });
  process.stdout.write('Initial envelope accepted\r\n');
});
setInterval(() => {}, 1000);
