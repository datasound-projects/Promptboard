// Offline Claude-compatible interactive fixture. No model, credentials or network.
const { spawnSync } = require('node:child_process');
const { appendFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const args = process.argv.slice(2), flag = name => args[args.indexOf(name) + 1];
const nativeId = flag('--session-id'), hooks = JSON.parse(flag('--settings')).hooks;
const report = process.env.FAKE_NATIVE_MESSAGE_REPORT;
if (!report || !nativeId) throw new Error('This offline fixture requires an owned capture path and native ID.');
const history = join(require('node:path').dirname(report), nativeId + '.jsonl');
const user = text => ({ type: 'user', sessionId: nativeId, message: { role: 'user', content: text } });
writeFileSync(history, JSON.stringify(user(args.at(-1))) + '\n');
writeFileSync(report, JSON.stringify({ kind: 'initial', text: args.at(-1), args }) + '\n');
const emit = (name, extra = {}) => {
  for (const group of hooks[name] || []) for (const hook of group.hooks)
    spawnSync(hook.command, hook.args, { input: JSON.stringify({ hook_event_name: name, session_id: nativeId,
      transcript_path: history, cwd: process.cwd(), ...extra }) });
};
emit('SessionStart'); emit('UserPromptSubmit'); emit('Stop', { last_assistant_message: 'Original task finished.', background_tasks: [], session_crons: [] });
process.stdin.setRawMode?.(true); process.stdout.write('\x1b[?2004h');
let buffer = ''; const decoder = new StringDecoder('utf8');
process.stdin.on('data', chunk => {
  buffer += decoder.write(chunk);
  while (buffer.startsWith('\x1b[200~')) {
    const end = buffer.indexOf('\x1b[201~');
    if (end < 0 || buffer[end + 6] !== '\r') return;
    const text = buffer.slice(6, end); buffer = buffer.slice(end + 7);
    appendFileSync(report, JSON.stringify({ kind: 'submitted', text }) + '\n');
    appendFileSync(history, JSON.stringify(user(text)) + '\n');
    emit('UserPromptSubmit'); emit('Stop', { last_assistant_message: 'Continuation finished.', background_tasks: [], session_crons: [] });
    process.stdout.write('Continuation finished\r\n');
  }
});
setInterval(() => {}, 1000);
