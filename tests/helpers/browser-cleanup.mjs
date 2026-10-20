import { execFile } from 'node:child_process';
import { readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const lifetimes = new WeakMap(), owned = new Set();
// A child outlives its parent: an uncaught error, process.exit (also --test-force-exit after a timed-out
// test) or a signal from the test runner would leave Chrome running. Kill every owned Chrome on the way out;
// a signal then ends the process as it would have without this listener.
const killOwned = () => { for (const chrome of owned) try { chrome.kill('SIGKILL'); } catch {} };
const stopOnSignal = signal => { killOwned(); if (!process.listenerCount(signal)) process.kill(process.pid, signal); };
let hooked = false;
export function trackChrome(chrome) {
  const lifetime = { closed: false };
  owned.add(chrome);
  chrome.once('close', () => { lifetime.closed = true; owned.delete(chrome); });
  lifetimes.set(chrome, lifetime);
  if (!hooked) { hooked = true; process.on('exit', killOwned); for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, stopOnSignal); }
  return chrome;
}

// Only stop the child launched by this fixture. Never remove its profile until
// close confirms that the process has released it; Windows may release locks later.
export async function closeChrome(chrome, profile, { timeout = 5000, remove = rm } = {}) {
  // Chrome subprocesses can inherit stderr. Close our reader so an inherited pipe
  // cannot keep ChildProcess.close pending after the owned browser has exited.
  chrome.stderr?.destroy();
  const lifetime = lifetimes.get(chrome);
  if (lifetime ? !lifetime.closed : chrome.exitCode === null && chrome.signalCode === null) {
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer);
        chrome.off('close', closed);
        error ? reject(error) : resolve();
      };
      const closed = () => finish();
      const timer = setTimeout(() => finish(new Error('Owned Chrome did not close; its profile was retained.')), timeout);
      chrome.once('close', closed);
      if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill('SIGKILL');
    });
  }
  await remove(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

const listProcesses = () => new Promise(resolve => execFile('ps', ['-A', '-ww', '-o', 'pid=,ppid=,args='], { maxBuffer: 64 << 20 }, (error, stdout) =>
  resolve(error ? null : stdout.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean).map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command })))));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

/** A test process that was killed (SIGKILL, a crash) never stops its Chrome. Before the first launch, stop the helper's
 * Chromes whose owner is gone and remove profiles nobody owns. Only main processes of this helper match (headless, port 0,
 * a pb-chrome- profile in this temp folder, no --type=): never another Chrome, never a Chrome whose test still runs.
 * Profiles are named pb-chrome-<owner pid>-; older unnamed ones count as orphaned under PID 1 or after 10 idle minutes. */
export async function sweepChromes({ tmp = tmpdir(), list = listProcesses } = {}) {
  if (process.platform === 'win32') return; // ponytail: no ps on Windows; the exit and signal handlers cover it there.
  const prefix = join(tmp, 'pb-chrome-'), owner = profile => Number(/^(\d+)-/.exec(profile.slice(prefix.length))?.[1]) || 0;
  const chromes = processes => processes.flatMap(({ pid, ppid, command }) => {
    const profile = command.includes('--headless=new') && command.includes('--remote-debugging-port=0') && !command.includes(' --type=') ? / --user-data-dir=(.+?)(?= --|$)/.exec(command)?.[1] : '';
    return profile?.startsWith(prefix) ? [{ pid, ppid, profile }] : [];
  });
  const before = await list();
  if (!before) return;
  const orphans = chromes(before).filter(({ ppid, profile }) => owner(profile) ? !alive(owner(profile)) : ppid === 1);
  for (const { pid } of orphans) try { process.kill(pid, 'SIGKILL'); } catch {}
  for (let tries = 50; tries-- && orphans.some(({ pid }) => alive(pid));) await delay(100);
  const after = await list();
  if (!after) return;
  const used = new Set(chromes(after).map(({ profile }) => profile)), stopped = new Set(orphans.map(({ profile }) => profile));
  for (const name of await readdir(tmp).catch(() => [])) {
    const profile = join(tmp, name), pid = owner(profile);
    if (!profile.startsWith(prefix) || used.has(profile) || (pid ? alive(pid) : !stopped.has(profile) && (await stat(profile).catch(() => null))?.mtimeMs > Date.now() - 600000)) continue;
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
}
