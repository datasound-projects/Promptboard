/** Discovery-only process ownership bridge. MCP framing/initialization remain in the SDK. */
import { spawn, execFile } from 'node:child_process';

const [command, ...args] = JSON.parse(process.argv[2]);
const child = spawn(command, args, { shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: process.env, windowsHide: true });
let stopping = false, escalation;
function kill(signal) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      // End the owned tree while its parent still exists; killing the parent first would
      // lose the tree relationship before taskkill can discover descendants.
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    } else process.kill(-child.pid, signal);
  } catch {}
}
function stop() {
  if (stopping) return;
  stopping = true; child.stdin?.end(); kill('SIGTERM');
  escalation = setTimeout(() => { kill('SIGKILL'); process.exit(0); }, 500);
}
child.on('error', () => { stop(); process.exitCode = 1; });
child.on('exit', () => { if (!stopping) stop(); });
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.stdin.on('error', () => {});
process.stdin.on('end', stop);
process.stdin.on('error', stop);
process.stdout.on('error', stop);
process.stderr.on('error', stop);
process.on('SIGTERM', stop); process.on('SIGINT', stop);
process.on('exit', () => { clearTimeout(escalation); kill('SIGKILL'); });
