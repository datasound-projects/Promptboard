#!/usr/bin/env node
/**
 * OPT-IN live smoke test for board execution. It uses your installed, signed-in CLI and
 * consumes provider usage. It runs only in a disposable repository it creates itself.
 *
 *   node scripts/live-agents.mjs --provider claude --stage planning [--model MODEL] [--timeout 180]
 *
 * It reports lifecycle events, whether the worktree and main checkout changed, and
 * whether the agent process was stopped. It never touches your own repositories.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from '../src/board.mjs';
import { Supervisor } from '../src/supervisor.mjs';

const option = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at > 0 ? process.argv[at + 1] : fallback; };
const provider = option('provider', 'claude');
const stage = option('stage', 'planning');
const model = option('model', '');
const effort = option('effort', '');
const timeoutMs = Number(option('timeout', '180')) * 1000;
const keep = process.argv.includes('--keep');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const root = await realpath(await mkdtemp(join(tmpdir(), 'pb-live-repo-')));
const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'pb-live-data-')));
git(root, 'init', '-q', '-b', 'trunk');
git(root, '-c', 'user.email=live@example.invalid', '-c', 'user.name=Live Test', 'commit', '-q', '--allow-empty', '-m', 'empty');
await writeFile(join(root, 'notes.txt'), 'alpha\n');
git(root, 'add', '.');
git(root, '-c', 'user.email=live@example.invalid', '-c', 'user.name=Live Test', 'commit', '-q', '-m', 'Add notes');

const board = new Board({ dataDir });
const supervisor = new Supervisor({ board, dataDir });
board.executor = supervisor;
const project = await board.createProject({ name: 'Live smoke' });
await board.linkRepository(project.id, { path: root, expectedRevision: 1 });
await board.setTargetBranch(project.id, { branch: 'trunk', expectedRevision: 2 });
const prompt = option('prompt', '') || (stage === 'planning'
  ? 'Read notes.txt. Propose a two-step plan to append the line "beta" to it. Keep the plan under 60 words. Do not change any file.'
  : 'Append the line "beta" to notes.txt. Do not change any other file. Reply with one short sentence when done.');
const created = await board.createTask({ projectId: project.id, title: 'Live smoke', prompt });
const task = await board.moveTask(created.id, { column: stage, expectedRevision: 1 });

const started = Date.now();
const run = await board.requestRun(task.id, { stage, consent: true, config: { provider, model, effort } });
console.log(`run ${run.id} ${provider}/${stage} queued`);
let last = '', result;
const answered = new Set();
const screen = async () => (await supervisor.artifact(run.id, 'output')).replace(/\x1b\[[0-9;?<>]*[A-Za-z]/g, '').replace(/\s+/g, '');
for (;;) {
  const current = await board.run(run.id);
  // --answer-trust plays the user's part for CLI startup prompts, choosing the safest option:
  // trust this disposable folder, and run no hooks that are not already trusted.
  if (process.argv.includes('--answer-trust')) {
    const text = await screen();
    if (!answered.has('folder') && /trustthisfolder|Trustthisfolder\?/i.test(text)) {
      answered.add('folder'); console.log('answering the folder-trust prompt as the user');
      if (provider === 'claude') { supervisor.input(run.id, '\x1b[B'); await new Promise(r => setTimeout(r, 400)); }
      supervisor.input(run.id, '\r');
    } else if (!answered.has('hooks') && /Hooksneedreview/i.test(text)) {
      answered.add('hooks'); console.log('answering "hooks need review" as the user: continue without trusting');
      supervisor.input(run.id, '\x1b[B'); await new Promise(r => setTimeout(r, 300)); supervisor.input(run.id, '\x1b[B'); await new Promise(r => setTimeout(r, 300)); supervisor.input(run.id, '\r');
    }
  }
  if (current.status !== last) { console.log(`${((Date.now() - started) / 1000).toFixed(1)}s status=${current.status}${current.waitingReason ? ` (${current.waitingReason})` : ''}${current.errorCode ? ` error=${current.errorCode}` : ''}`); last = current.status; }
  if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(current.status) || (current.status === 'waiting_for_input' && (current.turns > 0 || process.argv.includes('--stop-on-wait')))) { result = current; break; }
  if (Date.now() - started > timeoutMs) { result = { ...current, timedOut: true }; break; }
  await new Promise(resolve => setTimeout(resolve, 500));
}
// --settle N: keep observing for N more seconds to record any later lifecycle events.
const settle = Number(option('settle', '0')) * 1000;
if (settle) { await new Promise(resolve => setTimeout(resolve, settle)); result = await board.run(run.id); }
const workspace = (await board.view()).projects[0].tasks[0].workspace;
const events = await readFile(join(dataDir, run.artifactsDir, 'events.jsonl'), 'utf8').catch(() => '');
console.log('raw events:', events.trim().split('\n').filter(Boolean).map(line => { const e = JSON.parse(line); return `${e.name}: ${(e.message || '').slice(0, 120).replace(/\n/g, ' ')}`; }));
const summary = {
  provider, stage, status: result.status, timedOut: Boolean(result.timedOut), turns: result.turns || 0, lifecycle: result.lifecycle,
  events: events.trim().split('\n').filter(Boolean).map(line => JSON.parse(line).name),
  planExcerpt: result.planExcerpt?.slice(0, 400) || null,
  worktreeChanges: workspace ? git(workspace.path, 'status', '--porcelain') : null,
  mainCheckoutChanges: git(root, 'status', '--porcelain'),
  notesInWorktree: workspace ? await readFile(join(workspace.path, 'notes.txt'), 'utf8') : null,
  outputTail: (await supervisor.artifact(run.id, 'output')).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(-600),
};
const pid = supervisor.sessions.get(run.id)?.proc?.pid;
if (['waiting_for_input', 'running', 'queued'].includes(result.status)) await supervisor.cancel(run.id).catch(() => {});
await new Promise(resolve => setTimeout(resolve, 3500));
summary.processStopped = pid ? (() => { try { process.kill(pid, 0); return false; } catch { return true; } })() : true;
summary.finalStatus = (await board.run(run.id)).status;
console.log(JSON.stringify(summary, null, 2));
await supervisor.shutdown(1000);
if (!keep) { await rm(root, { recursive: true, force: true }); await rm(dataDir, { recursive: true, force: true }); }
