// Offline Claude-compatible interactive fixture. No model, credentials or network.
const { spawnSync } = require('node:child_process');
const { appendFileSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const args = process.argv.slice(2), flag = name => args[args.indexOf(name) + 1];
const nativeId = flag('--session-id'), hooks = JSON.parse(flag('--settings')).hooks;
const report = process.env.FAKE_NATIVE_MESSAGE_REPORT;
if (!report || !nativeId) throw new Error('This offline fixture requires an owned capture path and native ID.');
const history = join(require('node:path').dirname(report), nativeId + '.jsonl');
const user = text => ({ type: 'user', sessionId: nativeId, message: { role: 'user', content: text } });
const record = row => appendFileSync(report, JSON.stringify(row) + '\n');
const emit = (name, extra = {}) => {
  for (const group of hooks[name] || []) for (const hook of group.hooks)
    spawnSync(hook.command, hook.args, { input: JSON.stringify({ hook_event_name: name, session_id: nativeId,
      transcript_path: history, cwd: process.cwd(), ...extra }) });
};
const trustMarker = join(require('node:path').dirname(report), 'trusted-fixture');
let trusted = !process.env.FAKE_NATIVE_STARTUP_TRUST || existsSync(trustMarker), selected = 'no';
const redraw = () => process.stdout.write('\x1b[2J\x1b[HAccessing workspace:\r\n/private/disposable\r\n'
  + `${selected === 'no' ? '❯' : ' '} No, exit\r\n${selected === 'yes' ? '❯' : ' '} Yes, I trust this folder\r\nEnter to confirm · Esc to cancel`);
const activate = () => {
  writeFileSync(history, JSON.stringify(user(args.at(-1))) + '\n');
  record({ kind: 'initial', text: args.at(-1), args });
  emit('SessionStart'); emit('UserPromptSubmit'); emit('Stop', { last_assistant_message: 'Original task finished.', background_tasks: [], session_crons: [] });
  process.stdout.write('\x1b[?2004h');
};
process.stdin.setRawMode?.(true);
const startup = Date.now();
if (trusted) activate();
else { record({ kind: 'startup' }); redraw(); }
let buffer = ''; const decoder = new StringDecoder('utf8');
process.stdin.on('data', chunk => {
  const input = decoder.write(chunk);
  if (!trusted) {
    if (input === '\x1b[B') {
      selected = selected === 'no' ? 'yes' : 'no'; record({ kind: 'navigation', selected }); redraw();
      // Reproduce startup remount: an early arrow changes Yes, then resets No.
      if (Date.now() - startup < 700) setTimeout(() => { selected = 'no'; record({ kind: 'reset' }); redraw(); }, 20);
    } else if (input === '\r') {
      record({ kind: 'trust-confirmation', selected });
      if (selected !== 'yes') process.exit(1);
      writeFileSync(trustMarker, 'trusted'); trusted = true; activate();
    }
    return;
  }
  buffer += input;
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
