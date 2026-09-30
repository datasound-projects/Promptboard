// Stage transitions (docs/agentic-kanban-contract.md) with real Git and the real supervisor.
// Agents are SIMULATED by tests/fixtures/fake-agent.cjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Board, effectiveWorkflow } from '../src/board.mjs';
import { Supervisor } from '../src/supervisor.mjs';

const skip = process.platform === 'win32';
const fake = fileURLToPath(new URL('./fixtures/fake-agent.cjs', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
async function temp(t, prefix) { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return dir; }
async function until(fn, label, ms = 15000) { const end = Date.now() + ms; for (;;) { const value = await fn(); if (value) return value; if (Date.now() > end) assert.fail(`Timed out: ${label}`); await new Promise(r => setTimeout(r, 50)); } }

async function world(t, { resolver } = {}) {
  const bin = await temp(t, 'pb-tr-bin-');
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\nrequire(${JSON.stringify(fake)});\n`); await chmod(join(bin, 'claude'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  const root = await temp(t, 'pb-tr-repo-');
  git(root, 'init', '-q', '-b', 'trunk'); git(root, 'config', 'user.email', 't@example.com'); git(root, 'config', 'user.name', 'Tester');
  await writeFile(join(root, 'feature.txt'), 'one\n'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'init');
  const dataDir = await temp(t, 'pb-tr-data-');
  const board = new Board({ dataDir });
  const supervisor = new Supervisor({ board, dataDir, ...(resolver ? { resolver } : {}) });
  board.executor = supervisor;
  t.after(async () => { await supervisor.shutdown(500); process.env.PATH = oldPath; });
  const project = await board.createProject({ name: 'Flow' });
  await board.linkRepository(project.id, { path: root, expectedRevision: 1 });
  await board.setTargetBranch(project.id, { branch: 'trunk', expectedRevision: 2 });
  const revision = async () => (await board.view()).projects[0].revision;
  await board.delivery.setTestCommands(project.id, { commands: [{ command: `${process.execPath} -e "process.exit(0)"` }], expectedRevision: await revision() });
  const current = async id => (await board.view()).projects[0].tasks.find(item => item.id === id);
  const go = async (id, column, extra = {}) => board.transition(id, { column, expectedRevision: (await current(id)).revision, ...extra });
  const approve = (id, approval, extra = {}) => board.transition(id, { column: approval.to, expectedRevision: approval.expectedRevision, transitionId: approval.transitionId, handoffRunId: approval.handoff?.runId || null, decision: 'start', ...extra });
  const turn = runId => until(async () => { const run = await board.run(runId); return run.status === 'waiting_for_input' && run.turnComplete && run; }, 'finished turn');
  return { board, supervisor, root, dataDir, project, revision, current, go, approve, turn };
}

test('one approval hands off a finished turn, commits the work, and starts the next stage once, in the same worktree and branch', { skip, timeout: 60000 }, async t => {
  const w = await world(t);
  // Project default agent: every stage inherits it without asking again.
  await w.board.setWorkflow(w.project.id, { workflow: {}, agentDefaults: { provider: 'claude', model: 'haiku', effort: 'low' }, expectedRevision: await w.revision() });
  const task = await w.board.createTask({ projectId: w.project.id, title: 'Feature', prompt: 'Change it. WRITE_FILE:feature.txt' });
  // To Do → Executing ("Ask"): one approval with the resolved agent; nothing changes yet.
  const first = await w.go(task.id, 'executing');
  assert.deepEqual(first.approval.agent, { provider: 'claude', model: 'haiku', effort: 'low', permissionMode: 'acceptEdits', source: 'project' });
  assert.deepEqual([(await w.current(task.id)).column, (await w.current(task.id)).workspace, (await w.board.view()).runs], ['todo', null, []]);
  const started = await w.approve(task.id, first.approval);
  const execRun = started.run;
  assert.deepEqual([started.task.column, execRun.stage, execRun.config.model, execRun.config.effort], ['executing', 'executing', 'haiku', 'low']);
  assert.equal(started.task.lastTransition.runId, execRun.id, 'The card and its run were saved together.');
  await w.turn(execRun.id);
  const ws = (await w.current(task.id)).workspace;
  assert.equal(await readFile(join(ws.path, 'feature.txt'), 'utf8'), 'written by the agent\n');
  // Executing → Code Review while the agent waits after its turn with uncommitted work: one approval covers it.
  const second = await w.go(task.id, 'code_review');
  assert.deepEqual([second.approval.handoff, second.approval.commit.count, second.approval.action], [{ runId: execRun.id, stage: 'executing' }, 1, 'agent']);
  assert.equal((await w.board.run(execRun.id)).status, 'waiting_for_input', 'Asking changed nothing.');
  await assert.rejects(w.approve(task.id, second.approval, { handoffRunId: 'someone-else' }), { code: 'TRANSITION_STALE' });
  const reviewed = await w.approve(task.id, second.approval, { commitMessage: 'Change the feature' });
  assert.equal((await w.board.run(execRun.id)).status, 'succeeded', 'The finished turn was confirmed.');
  assert.equal(git(ws.path, 'log', '-1', '--format=%s'), 'Change the feature');
  assert.equal(git(ws.path, 'status', '--porcelain'), '', 'The work was committed, never discarded.');
  assert.deepEqual([reviewed.task.column, reviewed.run.stage, reviewed.run.workspacePath, reviewed.run.branch], ['code_review', 'code_review', ws.path, ws.branch]);
  assert.equal(reviewed.run.review.taskCommit, git(ws.path, 'rev-parse', 'HEAD'), 'The review is tied to the exact commit.');
  // The same approved request delivered again starts nothing new.
  const again = await w.approve(task.id, second.approval, { commitMessage: 'Change the feature' });
  assert.equal(again.duplicate, true);
  assert.equal(again.run.id, reviewed.run.id);
  assert.deepEqual((await w.board.view()).runs.map(run => run.stage), ['executing', 'code_review']);
  // Restart: the active review run becomes interrupted; the card, worktree, commit, and history stay.
  const restarted = new Board({ dataDir: w.dataDir });
  const view = await restarted.view();
  assert.equal(view.runs.find(run => run.id === reviewed.run.id).status, 'interrupted');
  assert.deepEqual([view.projects[0].tasks[0].column, view.projects[0].tasks[0].workspace.path], ['code_review', ws.path]);
});

test('a stage that cannot start never shows the card in that stage', { skip, timeout: 60000 }, async t => {
  // The CLI is found when the move is checked and the run is prepared (2 lookups), then is gone when the session starts.
  let lookups = 0;
  const w = await world(t, { resolver: async () => (lookups++ < 2 ? { command: '/bin/sh', prefix: [] } : null) });
  await w.board.setWorkflow(w.project.id, { workflow: { executing: { policy: 'start' } }, expectedRevision: await w.revision() });
  const task = await w.board.createTask({ projectId: w.project.id, title: 'Broken start', prompt: 'x' });
  const result = await w.go(task.id, 'executing');
  const run = await until(async () => { const found = await w.board.run(result.run.id); return found.status === 'failed' && found; }, 'failed start');
  const back = await until(async () => { const found = await w.current(task.id); return found.column === 'todo' && found; }, 'card back in To Do');
  assert.match(back.transitions.at(-1).reason, /could not start/);
  assert.equal(back.transitions.at(-1).by, 'system');
  assert.equal(run.errorCode, 'NOT_INSTALLED');
  // An agent that cannot start at all: automatic start refuses the move; Ask can still just move.
  const other = await w.board.createTask({ projectId: w.project.id, title: 'No agent', prompt: 'y' });
  await w.board.setWorkflow(w.project.id, { workflow: { executing: { policy: 'start', provider: 'codex' }, planning: { policy: 'ask', provider: 'codex' } }, expectedRevision: await w.revision() });
  await assert.rejects(w.go(other.id, 'executing'), { message: /cannot start automatically/ });
  assert.equal((await w.current(other.id)).column, 'todo');
  const asked = await w.go(other.id, 'planning');
  assert.match(asked.approval.agentError, /Codex CLI is not installed/);
  await assert.rejects(w.approve(other.id, asked.approval), { message: /not installed/ });
  const moved = await w.board.transition(other.id, { column: 'planning', expectedRevision: asked.approval.expectedRevision, transitionId: asked.approval.transitionId, decision: 'move' });
  assert.equal(moved.task.column, 'planning');
  assert.equal((await w.board.view()).runs.filter(item => item.taskId === other.id).length, 0);
});

test('evidence gates: reviewed = tested = HEAD; failed tests go back with their output; dirty work is never carried into Merge', { skip, timeout: 60000 }, async t => {
  const w = await world(t);
  await w.board.setWorkflow(w.project.id, { workflow: { executing: { policy: 'manual' }, code_review: { policy: 'manual' }, testing: { policy: 'manual' } }, expectedRevision: await w.revision() });
  const task = await w.board.createTask({ projectId: w.project.id, title: 'Gate', prompt: 'x' });
  await w.go(task.id, 'executing');
  const ws = (await w.board.ensureTaskWorktree(task.id)).path;
  await writeFile(join(ws, 'a.txt'), 'a\n');
  await w.board.delivery.commit(task.id, { message: 'a', confirm: true });
  await w.go(task.id, 'code_review');
  await assert.rejects(w.go(task.id, 'testing'), { code: 'STAGE_NOT_READY', message: /Run Code Review/ });
  const head = git(ws, 'rev-parse', 'HEAD');
  await w.board.delivery.recordReview({ id: 'r1', taskId: task.id, review: { taskCommit: head }, promptRevision: 1 }, '```json\n{"verdict":"changes_required","findings":[{"severity":"high","file":"a.txt","line":1,"explanation":"Wrong."}]}\n```');
  await assert.rejects(w.go(task.id, 'testing'), { message: /asked for changes/ });
  // Code Review → Executing carries the findings; the old review can never authorize the new commit.
  await w.go(task.id, 'executing');
  let card = await w.current(task.id);
  assert.match(card.reworkNotes, /\[high\] a\.txt:1 Wrong\./);
  assert.equal(card.evidence.review.status, 'changes_requested');
  await writeFile(join(ws, 'a.txt'), 'fixed\n');
  await w.board.delivery.commit(task.id, { message: 'fix', confirm: true });
  await w.go(task.id, 'code_review');
  await assert.rejects(w.go(task.id, 'testing'), { message: /older commit/ });
  await w.board.delivery.recordReview({ id: 'r2', taskId: task.id, review: { taskCommit: git(ws, 'rev-parse', 'HEAD') }, promptRevision: 1 }, '```json\n{"verdict":"no_issues","findings":[]}\n```');
  await w.go(task.id, 'testing');
  await assert.rejects(w.go(task.id, 'merge'), { message: /Passing tests for the current commit/ });
  // Failing tests: Testing → Executing gets the output.
  await w.board.delivery.setTestCommands(w.project.id, { commands: [{ command: `${process.execPath} -e "console.error('boom 42'); process.exit(1)"` }], expectedRevision: await w.revision() });
  await w.board.delivery.runTests(task.id, { confirm: true });
  await until(async () => (await w.current(task.id)).evidence.tests.status === 'failed', 'tests failed');
  await w.go(task.id, 'executing');
  assert.match((await w.current(task.id)).reworkNotes, /boom 42/);
  // Back through Review and Testing, with passing tests; then the testing agent leaves a change behind.
  await w.go(task.id, 'code_review');
  await w.go(task.id, 'testing');
  await w.board.delivery.setTestCommands(w.project.id, { commands: [{ command: `${process.execPath} -e "0"` }], expectedRevision: await w.revision() });
  await w.board.delivery.runTests(task.id, { confirm: true });
  await until(async () => (await w.current(task.id)).evidence.tests.status === 'passed', 'tests passed');
  await writeFile(join(ws, 'extra.txt'), 'untested\n');
  await assert.rejects(w.go(task.id, 'merge'), { message: /uncommitted changes .* Send the card back to Executing/ });
  assert.equal(await readFile(join(ws, 'extra.txt'), 'utf8'), 'untested\n', 'The change is kept.');
  await rm(join(ws, 'extra.txt'));
  // Merge → Done by drag: one confirmation, then the verified fast-forward merge.
  await w.go(task.id, 'merge');
  const asked = await w.go(task.id, 'done');
  assert.deepEqual([asked.approval.action, asked.approval.canMoveOnly, asked.approval.merge.commits], ['merge', false, 2]);
  await assert.rejects(w.board.transition(task.id, { column: 'done', expectedRevision: asked.approval.expectedRevision, decision: 'move' }), { code: 'CONFIRMATION_REQUIRED' });
  const done = await w.approve(task.id, asked.approval);
  assert.deepEqual([done.task.column, done.task.completion.kind, done.merged], ['done', 'merged', true]);
  assert.equal(git(w.root, 'rev-parse', 'trunk'), git(ws, 'rev-parse', 'HEAD'));
  card = await w.current(task.id);
  assert.deepEqual(card.transitions.map(move => move.to), ['executing', 'code_review', 'executing', 'code_review', 'testing', 'executing', 'code_review', 'testing', 'merge', 'done']);
});

test('the task worktree is verified before each stage: a deleted folder is rebuilt from the branch; a switched or deleted branch stops with the reason', { skip, timeout: 60000 }, async t => {
  const w = await world(t);
  await w.board.setWorkflow(w.project.id, { workflow: { executing: { policy: 'manual' }, code_review: { policy: 'manual' } }, expectedRevision: await w.revision() });
  const task = await w.board.createTask({ projectId: w.project.id, title: 'Repair', prompt: 'x' });
  await w.go(task.id, 'executing');
  const ws = await w.board.ensureTaskWorktree(task.id);
  await writeFile(join(ws.path, 'kept.txt'), 'kept\n');
  await w.board.delivery.commit(task.id, { message: 'kept', confirm: true });
  // Deleted folder: rebuilt from the task branch; the commit is there.
  await rm(ws.path, { recursive: true, force: true });
  await w.go(task.id, 'code_review');
  assert.equal(await readFile(join(ws.path, 'kept.txt'), 'utf8'), 'kept\n');
  assert.ok((await w.current(task.id)).workspace.recoveredAt);
  // Switched branch: refused, nothing changed.
  git(ws.path, 'switch', '-q', '-c', 'elsewhere');
  await assert.rejects(w.go(task.id, 'executing'), { code: 'BRANCH_MISMATCH', message: /git switch/ });
  assert.equal(git(ws.path, 'branch', '--show-current'), 'elsewhere');
  git(ws.path, 'switch', '-q', ws.branch);
  // Folder and branch both deleted: the commits cannot be found, so Promptboard stops and explains.
  await rm(ws.path, { recursive: true, force: true });
  git(w.root, 'worktree', 'prune');
  git(w.root, 'branch', '-D', ws.branch);
  await assert.rejects(w.go(task.id, 'executing'), { code: 'WORKTREE_BRANCH_MISSING' });
  assert.equal((await w.current(task.id)).column, 'code_review');
});

test('the agent comes from the stage, else the project default, else the global default, with model and effort from that level', () => {
  const project = { agentDefaults: { provider: 'codex', model: 'gpt-p', effort: 'high' }, workflow: { planning: { policy: 'ask', provider: 'claude', model: 'opus', effort: 'max' } } };
  const global = { provider: 'claude', model: 'haiku', effort: 'low' };
  const wf = effectiveWorkflow(project, global);
  assert.deepEqual([wf.planning.provider, wf.planning.model, wf.planning.effort, wf.planning.agentSource], ['claude', 'opus', 'max', 'stage']);
  assert.deepEqual([wf.executing.provider, wf.executing.model, wf.executing.effort, wf.executing.agentSource], ['codex', 'gpt-p', 'high', 'project']);
  const noProject = effectiveWorkflow({ workflow: {} }, global);
  assert.deepEqual([noProject.code_review.provider, noProject.code_review.model, noProject.code_review.agentSource], ['claude', 'haiku', 'global']);
  const none = effectiveWorkflow({ workflow: {} }, null);
  assert.deepEqual([none.executing.provider, none.executing.model, none.executing.agentSource], ['claude', '', 'default']);
  // An effort the provider does not accept is dropped instead of breaking every run.
  const odd = effectiveWorkflow({ agentDefaults: { provider: 'gemini', model: '', effort: 'high' }, workflow: {} }, null);
  assert.deepEqual([odd.executing.provider, odd.executing.effort], ['gemini', '']);
});

test('Code Review → Executing with a finished review turn: one approval records the review and sends its findings to the new run', { skip, timeout: 60000 }, async t => {
  const w = await world(t);
  await w.board.setWorkflow(w.project.id, { workflow: { executing: { policy: 'manual' } }, expectedRevision: await w.revision() });
  const task = await w.board.createTask({ projectId: w.project.id, title: 'Rework', prompt: 'Set the value. REVIEW_FAIL' });
  await w.go(task.id, 'executing');
  const ws = (await w.board.ensureTaskWorktree(task.id)).path;
  await writeFile(join(ws, 'feature.txt'), 'two\n');
  await w.board.delivery.commit(task.id, { message: 'two', confirm: true });
  const review = await w.approve(task.id, (await w.go(task.id, 'code_review')).approval);
  await w.turn(review.run.id);
  await w.board.setWorkflow(w.project.id, { workflow: {}, expectedRevision: await w.revision() });
  const asked = await w.go(task.id, 'executing');
  assert.deepEqual([asked.approval.handoff.stage, asked.approval.notes, asked.approval.action], ['code_review', 'review', 'agent']);
  const promptFile = join(ws, '..', 'rework-prompt.txt');
  process.env.FAKE_AGENT_PROMPT_FILE = promptFile;
  t.after(() => { delete process.env.FAKE_AGENT_PROMPT_FILE; });
  const back = await w.approve(task.id, asked.approval);
  const card = await w.current(task.id);
  assert.deepEqual([card.column, card.evidence.review.status, card.evidence.review.verdict], ['executing', 'changes_requested', 'changes_required']);
  assert.match(card.reworkNotes, /\[high\] feature\.txt:1 The value is wrong\./);
  await w.turn(back.run.id);
  assert.match(await readFile(promptFile, 'utf8'), /=== REVIEW FINDINGS TO FIX ===\n- \[high\] feature\.txt:1/);
  assert.equal(back.run.workspacePath, review.run.workspacePath);
});
