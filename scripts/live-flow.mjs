#!/usr/bin/env node
/**
 * OPT-IN live end-to-end flow with a real, signed-in CLI. Consumes provider usage.
 * Works only in a disposable repository it creates and deletes.
 *
 *   node scripts/live-flow.mjs --provider claude [--model haiku] [--effort low] [--timeout 240]
 *
 * To Do -> Executing (real agent) -> commit -> Code Review (real agent, read-only)
 * -> accept -> Testing (real command) -> Merge (confirmed fast-forward) -> Done.
 * CLI startup prompts (folder trust, hook review) are answered as a user would.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from '../src/board.mjs';
import { Supervisor } from '../src/supervisor.mjs';

const option = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at > 0 ? process.argv[at + 1] : fallback; };
const provider = option('provider', 'claude');
const config = { provider, model: option('model', ''), effort: option('effort', '') };
const timeoutMs = Number(option('timeout', '240')) * 1000;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const log = (...args) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);

const root = await realpath(await mkdtemp(join(tmpdir(), 'pb-flow-repo-')));
const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'pb-flow-data-')));
git(root, 'init', '-q', '-b', 'trunk');
await writeFile(join(root, 'notes.txt'), 'alpha\n');
git(root, 'add', '.');
git(root, '-c', 'user.email=live@example.invalid', '-c', 'user.name=Live Test', 'commit', '-q', '-m', 'Add notes');
git(root, 'config', 'user.email', 'live@example.invalid'); git(root, 'config', 'user.name', 'Live Test');

const board = new Board({ dataDir });
const supervisor = new Supervisor({ board, dataDir });
board.executor = supervisor;
const report = { provider, steps: [] };
const step = (name, data = {}) => { report.steps.push({ name, ...data }); log(name, JSON.stringify(data).slice(0, 300)); };
let failed = null;
try {
  const project = await board.createProject({ name: 'Live flow' });
  await board.linkRepository(project.id, { path: root, expectedRevision: 1 });
  await board.setTargetBranch(project.id, { branch: 'trunk', expectedRevision: 2 });
  await board.delivery.setTestCommands(project.id, { commands: [{ command: `${process.execPath} -e "const t=require('fs').readFileSync('notes.txt','utf8'); process.exit(t.includes('beta') ? 0 : 1)"`, label: 'notes contain beta' }], expectedRevision: 3 });
  const created = await board.createTask({ projectId: project.id, title: 'Append beta', prompt: 'Append the line "beta" to notes.txt. Do not change any other file. Reply with one short sentence when done.' });
  const current = async () => (await board.view()).projects[0].tasks[0];
  const move = async column => board.moveTask(created.id, { column, expectedRevision: (await current()).revision });

  const runStage = async stage => {
    const run = await board.requestRun(created.id, { stage, consent: true, config });
    const started = Date.now();
    const answered = new Set();
    for (;;) {
      const state = await board.run(run.id);
      if (state.status === 'waiting_for_input' && state.turns > 0) { step(`${stage} turn complete`, { seconds: Math.round((Date.now() - started) / 1000), status: state.status }); return run; }
      if (['failed', 'cancelled', 'interrupted'].includes(state.status)) throw new Error(`${stage} run ${state.status}: ${state.reason || state.errorCode}`);
      if (Date.now() - started > timeoutMs) throw new Error(`${stage} run timed out (${state.status}, ${state.waitingReason || ''})`);
      const text = (await supervisor.artifact(run.id, 'output')).replace(/\x1b\[[0-9;?<>]*[A-Za-z]/g, '').replace(/\s+/g, '');
      if (!answered.has('folder') && /trustthisfolder|Trustthisfolder\?/i.test(text)) {
        answered.add('folder'); log('answering the folder-trust prompt as the user');
        if (provider === 'claude') { supervisor.input(run.id, '\x1b[B'); await new Promise(r => setTimeout(r, 400)); }
        supervisor.input(run.id, '\r');
      } else if (!answered.has('hooks') && /Hooksneedreview/i.test(text)) {
        answered.add('hooks'); log('answering "hooks need review": continue without trusting');
        supervisor.input(run.id, '\x1b[B'); await new Promise(r => setTimeout(r, 300)); supervisor.input(run.id, '\x1b[B'); await new Promise(r => setTimeout(r, 300)); supervisor.input(run.id, '\r');
      }
      await new Promise(r => setTimeout(r, 500));
    }
  };

  step('To Do is inert', { refused: await board.requestRun(created.id, { stage: 'todo', consent: true }).then(() => 'NO', error => error.code) });
  await move('executing');
  const exec = await runStage('executing');
  await supervisor.confirm(exec.id);
  const ws = (await current()).workspace;
  step('executing confirmed', { worktreeChanges: git(ws.path, 'status', '--porcelain'), mainCheckoutChanges: git(root, 'status', '--porcelain'), notes: await readFile(join(ws.path, 'notes.txt'), 'utf8') });
  const committed = await board.delivery.commit(created.id, { message: 'Append beta to notes', confirm: true });
  step('committed', { taskCommit: committed.taskCommit.slice(0, 12), ahead: committed.ahead });
  await move('code_review');
  const review = await runStage('code_review');
  await supervisor.confirm(review.id);
  const evidence = (await current()).evidence.review;
  step('review recorded', { verdict: evidence.verdict, parsed: evidence.parsed, findings: evidence.findings.length, worktreeUnchanged: git(ws.path, 'status', '--porcelain') === '' });
  await board.delivery.acceptReview(created.id);
  await move('testing');
  await board.delivery.runTests(created.id, { confirm: true });
  let tests;
  for (let i = 0; i < 120 && (tests = (await current()).evidence.tests).status === 'running'; i++) await new Promise(r => setTimeout(r, 500));
  step('tests', { status: tests.status, exitCodes: tests.results.map(result => result.exitCode) });
  await move('merge');
  const preview = await board.delivery.mergePreview(created.id);
  step('merge preview', { eligible: preview.eligible, problems: preview.problems, commits: preview.commits.length });
  const done = await board.delivery.merge(created.id, { confirm: true, taskCommit: preview.taskCommit, targetCommit: preview.targetCommit });
  step('merged', { column: done.column, kind: done.completion.kind, trunk: git(root, 'rev-parse', 'trunk').slice(0, 12), mainNotes: await readFile(join(root, 'notes.txt'), 'utf8') });
  const leftover = [...supervisor.sessions.values()].filter(session => session.proc).length;
  step('no live agent processes', { leftover });
} catch (error) {
  failed = error.message;
  log('FAILED:', error.message);
} finally {
  await supervisor.shutdown(1000);
  if (!process.argv.includes('--keep')) { await rm(root, { recursive: true, force: true }); await rm(dataDir, { recursive: true, force: true }); }
}
report.result = failed ? `FAIL: ${failed}` : 'PASS';
console.log(JSON.stringify(report, null, 2));
process.exitCode = failed ? 1 : 0;
