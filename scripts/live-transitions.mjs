#!/usr/bin/env node
/**
 * Live check of the card workflow with a real agent CLI, through the same transition calls the
 * board uses (approval, hand-off, commit, start). A disposable repository and data folder only.
 *   node scripts/live-transitions.mjs --provider claude --model haiku [--timeout 300] [--keep]
 * Route: To Do → Planning → Executing → Code Review → Executing (rework) → Code Review
 *        → (app restart) → Code Review again → Testing → Merge (one click) → Done. No confirmation dialogs.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from '../src/board.mjs';
import { Supervisor } from '../src/supervisor.mjs';

const arg = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 ? process.argv[at + 1] : fallback; };
const provider = arg('provider', 'claude'), model = arg('model', ''), timeoutMs = Number(arg('timeout', '300')) * 1000;
const log = (...parts) => console.error(`[live] ${parts.join(' ')}`);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const base = await mkdtemp(join(tmpdir(), 'pb-live-transitions-'));
const root = join(base, 'repo'), dataDir = join(base, 'data');
execFileSync('mkdir', ['-p', root]);
git(root, 'init', '-q', '-b', 'trunk'); git(root, 'config', 'user.email', 'live@example.invalid'); git(root, 'config', 'user.name', 'Live Test');
await writeFile(join(root, 'notes.txt'), 'alpha\n'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'Add notes');

let board, supervisor;
const open = () => { board = new Board({ dataDir }); supervisor = new Supervisor({ board, dataDir }); board.executor = supervisor; };
open();
const report = { provider, model: model || '(CLI default)', steps: [] };
const step = (name, data = {}) => { report.steps.push({ name, ...data }); log(name, JSON.stringify(data).slice(0, 400)); };
const task = async () => (await board.view()).projects[0].tasks[0];

/** Wait for a finished turn, answering only the CLI's folder-trust and hooks-review prompts (as the user would). */
async function waitTurn(runId, stage) {
  const started = Date.now(), answered = new Set();
  for (;;) {
    const run = await board.run(runId);
    if (run.status === 'waiting_for_input' && run.turnComplete && run.turns > 0) { step(`${stage} turn finished`, { seconds: Math.round((Date.now() - started) / 1000) }); return run; }
    if (['failed', 'cancelled', 'interrupted'].includes(run.status)) throw new Error(`${stage} run ${run.status}: ${run.reason || run.errorCode}`);
    if (Date.now() - started > timeoutMs) throw new Error(`${stage} run timed out (${run.status}, ${run.waitingReason || ''})`);
    const text = (await supervisor.artifact(runId, 'output')).replace(/\x1b\[[0-9;?<>]*[A-Za-z]/g, '').replace(/\s+/g, '');
    if (!answered.has('folder') && /trustthisfolder/i.test(text)) {
      answered.add('folder'); log('answering the folder-trust prompt as the user');
      if (provider === 'claude') { supervisor.input(runId, '\x1b[B'); await new Promise(r => setTimeout(r, 400)); }
      supervisor.input(runId, '\r');
    } else if (!answered.has('hooks') && /Hooksneedreview/i.test(text)) {
      answered.add('hooks'); supervisor.input(runId, '\x1b[B'); await new Promise(r => setTimeout(r, 300)); supervisor.input(runId, '\x1b[B'); await new Promise(r => setTimeout(r, 300)); supervisor.input(runId, '\r');
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

/** Drag: one request moves the card and starts the stage. The same drop again starts nothing. */
async function drag(column) {
  const card = await task();
  const request = { column, expectedRevision: card.revision, transitionId: `live-${column}-${Date.now()}` };
  const result = await board.transition(card.id, request);
  const repeat = await board.transition(card.id, request);
  if (!repeat.duplicate) throw new Error('A repeated drop was not recognized as a duplicate.');
  step(`drag → ${column}`, { run: result.run ? `${result.run.stage} (${result.run.config.provider}/${result.run.config.model || 'default'})` : null, tests: result.tests?.id || null, merge: result.merge?.state || null, column: result.task?.column });
  return result;
}

let failed = null;
try {
  const project = await board.createProject({ name: 'Live transitions' });
  await board.linkRepository(project.id, { path: root, expectedRevision: 1 });
  await board.setTargetBranch(project.id, { branch: 'trunk', expectedRevision: 2 });
  // Project default agent: every stage inherits it; nothing asks for the model again.
  await board.setWorkflow(project.id, { workflow: {}, agentDefaults: { provider, model, effort: '' }, expectedRevision: 3 });
  await board.delivery.setTestCommands(project.id, { commands: [{ command: `${process.execPath} -e "process.exit(require('fs').readFileSync('notes.txt','utf8').includes('beta') ? 0 : 1)"`, label: 'notes contain beta' }], expectedRevision: 4 });
  await board.createTask({ projectId: project.id, title: 'Append beta', prompt: 'Append one line with the word beta to notes.txt. Do not change any other file. Reply with one short sentence when done.' });

  const planning = await drag('planning');
  await waitTurn(planning.run.id, 'planning');
  const executing = await drag('executing'); // Approves the plan and starts Executing in one step.
  await waitTurn(executing.run.id, 'executing');
  const ws = (await task()).workspace;
  step('work in the task worktree only', { worktree: git(ws.path, 'status', '--porcelain'), mainCheckout: git(root, 'status', '--porcelain') || '(clean)' });
  const review = await drag('code_review'); // Confirms the turn, commits (card title), starts the review.
  await waitTurn(review.run.id, 'code_review');
  // Rework: back to Executing with the review, then review the result again.
  const rework = await drag('executing');
  await waitTurn(rework.run.id, 'executing (rework)');
  const review2 = await drag('code_review');
  await waitTurn(review2.run.id, 'code_review (again)');

  // App restart while the review agent waits: the run is interrupted; card, worktree, and commits stay.
  await supervisor.shutdown(3000);
  open();
  const after = await task();
  const interrupted = (await board.view()).runs.find(run => run.id === review2.run.id);
  step('restart', { column: after.column, reviewRun: interrupted.status, sameWorktree: after.workspace.path === ws.path, commits: git(ws.path, 'rev-list', '--count', 'trunk..HEAD') });
  // The user starts the review again from the card (the card's own Start button).
  const review3 = await board.requestRun(after.id, { stage: 'code_review', consent: true });
  await waitTurn(review3.id, 'code_review (after restart)');

  // Code Review → Testing: the hand-off records the review. If the review asks for changes, the user accepts it here.
  const card = await task();
  let testing;
  try { testing = await drag('testing'); }
  catch (error) {
    if (error.code !== 'STAGE_NOT_READY') throw error;
    step('review needs a decision', { reason: error.message.slice(0, 200) });
    await board.delivery.acceptReview(card.id);
    testing = await drag('testing');
  }
  let tests;
  for (let i = 0; i < 120 && (tests = (await task()).evidence?.tests)?.status !== 'passed' && tests?.status !== 'failed'; i++) await new Promise(r => setTimeout(r, 500));
  step('tests (started by the drag)', { status: tests?.status });
  if (tests?.status !== 'passed') throw new Error('The tests did not pass.');
  const entered = await drag('merge'); // Verifies review and tests for the current commit; shows one button.
  if (entered.merge?.state !== 'ready') throw new Error(`Merge was not ready: ${entered.merge?.message}`);
  const done = await board.mergeNow((await task()).id); // The one click.
  step('one-click merge', { merged: done.merged, column: done.task.column, worktreeRemoved: done.task.workspace === null });
  const runs = (await board.view()).runs;
  const finalCard = await task();
  step('done', {
    column: finalCard.column, completion: finalCard.completion.kind, trunkHasBeta: (await readFile(join(root, 'notes.txt'), 'utf8')).includes('beta'),
    runs: runs.map(run => `${run.stage}:${run.status}`), oneBranch: new Set(runs.map(run => run.branch)).size === 1, oneWorktree: new Set(runs.map(run => run.workspacePath)).size === 1,
    models: [...new Set(runs.map(run => `${run.config.provider}/${run.config.model || 'default'}`))], liveProcesses: [...supervisor.sessions.values()].filter(session => session.proc).length,
    path: finalCard.transitions.map(move => move.to).join(' → '),
  });
  if (runs.filter(run => run.status === 'queued' || run.status === 'running').length) throw new Error('A run is still active.');
} catch (error) {
  failed = error.message;
  log('FAILED:', error.message);
} finally {
  await supervisor.shutdown(1000);
  if (!process.argv.includes('--keep')) await rm(base, { recursive: true, force: true });
}
report.result = failed ? `FAIL: ${failed}` : 'PASS';
console.log(JSON.stringify(report, null, 2));
process.exitCode = failed ? 1 : 0;
