// Offline interactive Codex queue fixture. No credentials, model or network.
const { spawnSync } = require('node:child_process');
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 0.157.0'); process.exit(0); }
const report = process.env.FAKE_NATIVE_MESSAGE_REPORT, home = process.env.CODEX_HOME;
if (!report || !home) throw new Error('Use owned offline capture and Codex directories.');
const notify = JSON.parse(args.find(arg => arg.startsWith('notify=')).slice(7));
const nativeId = randomUUID(), now = new Date();
const folder = join(home, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
mkdirSync(folder, { recursive: true });
const history = join(folder, `rollout-${now.toISOString().slice(0, 19).replaceAll(':', '-')}-${nativeId}.jsonl`);
const append = row => appendFileSync(history, JSON.stringify(row) + '\n');
const capture = row => appendFileSync(report, JSON.stringify(row) + '\n');
const event = payload => append({ type: 'event_msg', payload });
writeFileSync(history, JSON.stringify({ type: 'session_meta', payload: { id: nativeId, source: 'cli' } }) + '\n');
let active = null, queued = null;
const begin = text => {
  active = randomUUID(); event({ type: 'task_started', turn_id: active });
  append({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
};
const complete = text => {
  event({ type: 'task_complete', turn_id: active, last_agent_message: text }); active = null;
  spawnSync(notify[0], [...notify.slice(1), JSON.stringify({ type: 'agent-turn-complete', 'thread-id': nativeId, 'last-assistant-message': text })]);
  process.stdout.write('Completed owned fixture turn\r\n');
  if (queued) { const text = queued; queued = null; begin(text); setTimeout(() => complete('PB_BUSY_NEXT'), 100); }
};
begin(args.at(-1)); capture({ kind: 'initial', text: args.at(-1) }); complete('PB_NATIVE_FIRST');
process.stdout.write('\x1b[?2004h'); process.stdin.setRawMode?.(true);
const busyReply = Array.from({ length: 160 }, (_, n) => 'PB_BUSY_LINE_' + String(n + 1).padStart(3, '0')).concat('PB_BUSY_END').join('\n');
let buffer = '', earlyCompletion = false; const decoder = new StringDecoder('utf8');
process.stdin.on('data', bytes => {
  buffer += decoder.write(bytes);
  while (buffer.startsWith('\x1b[200~')) {
    const end = buffer.indexOf('\x1b[201~'); if (end < 0) return;
    if (buffer.length <= end + 6) {
      if (process.env.FAKE_CODEX_QUEUE_ENDS_AFTER_PASTE && active && !earlyCompletion) {
        earlyCompletion = true; capture({ kind: 'completed-before-key', text: buffer.slice(6, end) });
        setTimeout(() => complete(busyReply), 100);
      }
      return;
    }
    const key = buffer[end + 6], text = buffer.slice(6, end); buffer = buffer.slice(end + 7);
    capture({ kind: 'submitted', text, key, busy: Boolean(active) });
    if (key === '\t' && active) {
      if (process.env.FAKE_CODEX_QUEUE_STEERS) {
        append({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
      } else queued = text;
      // Success holds the owned busy turn until its queue key is accepted.
      // The separate early-completion variant exercises refusal before that key.
      setTimeout(() => complete(busyReply), 100);
    } else if (key === '\r' && !active) {
      begin(text);
    } else throw new Error('Unexpected owned fixture input.');
  }
});
setInterval(() => {}, 1000);
