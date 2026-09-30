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
  const turn = runId => until(async () => { const run = await board.run(runId); return run.status === 'waiting_for_input' && run.turnComplete && run; }, 'finished turn');
  return { board, supervisor, root, dataDir, project, revision, current, go, turn };
}

test('drag = start: To Do → Executing starts the agent at once; dragging on hands off the turn, commits, and starts review once, in the same worktree', { skip, timeout: 60000 }, async t => {
  const w = await world(t);
  // Project default agent: every stage inherits it without asking again.
  await w.board.setWorkflow(w.project.id, { workflow: {}, agentDefaults: { provider: 'claude', model: 'haiku', effort: 'low' }, expectedRevision: await w.revision() });
  const task = await w.board.createTask({ projectId: w.project.id, title: 'Feature', prompt: 'Change it. WRITE_FILE:feature.txt' });
  // To Do → Executing (Planning skipped): the agent starts immediately, with the inherited model.
  const started = await w.go(task.id, 'executing');
  const execRun = started.run;
  assert.deepEqual([started.task.column, execRun.stage, execRun.config.model, execRun.config.effort, execRun.trigger], ['executing', 'executing', 'haiku', 'low', 'user']);
  assert.equal(started.task.lastTransition.runId, execRun.id, 'The card and its run were saved together.');
  await w.turn(execRun.id);
  const ws = (await w.current(task.id)).workspace;
  assert.equal(await readFile(join(ws.path, 'feature.txt'), 'utf8'), 'written by the agent\n');
  // Executing → Code Review: the finished turn is confirmed, its work committed (the card title), review starts.
  const reviewed = await w.go(task.id, 'code_review', { transitionId: 'drag-review-0001' });
  assert.equal((await w.board.run(execRun.id)).status, 'succeeded', 'The finished turn was confirmed.');
  assert.equal(git(ws.path, 'log', '-1', '--format=%s'), 'Feature');
  assert.equal(git(ws.path, 'status', '--porcelain'), '', 'The work was committed, never discarded.');
  assert.deepEqual([reviewed.task.column, reviewed.run.stage, reviewed.run.workspacePath, reviewed.run.branch], ['code_review', 'code_review', ws.path, ws.branch]);
  assert.equal(reviewed.run.review.taskCommit, git(ws.path, 'rev-parse', 'HEAD'), 'The review is tied to the exact commit.');
  // The same drop delivered again starts nothing new.
  const again = await w.board.transition(task.id, { column: 'code_review', expectedRevision: 1, transitionId: 'drag-review-0001' });
  assert.equal(again.duplicate, true);
  assert.equal(again.run.id, reviewed.run.id);
  assert.deepEqual((await w.board.view()).runs.map(run => run.stage), ['executing', 'code_review']);
  // An agent that is still working is not interrupted by a drag.
  await assert.rejects(w.go(task.id, 'executing'), { code: 'RUN_ACTIVE' });
  // Restart: the active review run becomes interrupted; the card, worktree, commit, and history stay.
  const restarted = new Board({ dataDir: w.dataDir });
  const view = await restarted.view();
  assert.equal(view.runs.find(run => run.id === reviewed.run.id).status, 'interrupted');
  assert.deepEqual([view.projects[0].tasks[0].column, view.projects[0].tasks[0].workspace.path], ['code_review', ws.path]);
});

test('a stage that cannot start never shows the card in that stage; Manual only moves', { skip, timeout: 60000 }, async t => {
  // The CLI is found when the move is checked and the run is prepared (2 lookups), then is gone when the session starts.
  let lookups = 0;
  const w = await world(t, { resolver: async () => (lookups++ < 2 ? { command: '/bin/sh', prefix: [] } : null) });
  const task = await w.board.createTask({ projectId: w.project.id, title: 'Broken start', prompt: 'x' });
  const result = await w.go(task.id, 'executing');
  const run = await until(async () => { const found = await w.board.run(result.run.id); return found.status === 'failed' && found; }, 'failed start');
  const back = await until(async () => { const found = await w.current(task.id); return found.column === 'todo' && found; }, 'card back in To Do');
  assert.match(back.transitions.at(-1).reason, /could not start/);
  assert.equal(back.transitions.at(-1).by, 'system');
  assert.equal(run.errorCode, 'NOT_INSTALLED');
  // An agent that is not installed is a real blocker: the drag is refused with the reason and the card stays.
  const other = await w.board.createTask({ projectId: w.project.id, title: 'No agent', prompt: 'y' });
  await w.board.setWorkflow(w.project.id, { workflow: { executing: { policy: 'start', provider: 'codex' }, planning: { policy: 'manual', provider: 'codex' } }, expectedRevision: await w.revision() });
  await assert.rejects(w.go(other.id, 'executing'), { message: /Executing cannot start: Codex CLI is not installed/ });
  assert.equal((await w.current(other.id)).column, 'todo');
  // Manual only moves: nothing starts, so the missing agent does not matter.
  const moved = await w.go(other.id, 'planning');
  assert.deepEqual([moved.task.column, moved.run], ['planning', undefined]);
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
  // Merge: entering verifies the current commit; dragging on to Done performs the verified merge.
  const verified = git(ws, 'rev-parse', 'HEAD');
  const entered = await w.go(task.id, 'merge');
  assert.equal(entered.merge.state, 'ready');
  await assert.rejects(w.board.transition(task.id, { column: 'done', expectedRevision: (await w.current(task.id)).revision, decision: 'move' }), { code: 'MERGE_REQUIRED' });
  const done = await w.go(task.id, 'done');
  assert.deepEqual([done.task.column, done.task.completion.kind, done.merged], ['done', 'merged', true]);
  assert.equal(git(w.root, 'rev-parse', 'trunk'), verified);
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

test('Code Review → Executing with a finished review turn: the drag records the review and sends its findings to the new run', { skip, timeout: 60000 }, async t => {
  const w = await world(t);
  await w.board.setWorkflow(w.project.id, { workflow: { executing: { policy: 'manual' } }, expectedRevision: await w.revision() });
  const task = await w.board.createTask({ projectId: w.project.id, title: 'Rework', prompt: 'Set the value. REVIEW_FAIL' });
  await w.go(task.id, 'executing');
  const ws = (await w.board.ensureTaskWorktree(task.id)).path;
  await writeFile(join(ws, 'feature.txt'), 'two\n');
  await w.board.delivery.commit(task.id, { message: 'two', confirm: true });
  const review = await w.go(task.id, 'code_review');
  await w.turn(review.run.id);
  await w.board.setWorkflow(w.project.id, { workflow: {}, expectedRevision: await w.revision() });
  const promptFile = join(ws, '..', 'rework-prompt.txt');
  process.env.FAKE_AGENT_PROMPT_FILE = promptFile;
  t.after(() => { delete process.env.FAKE_AGENT_PROMPT_FILE; });
  const back = await w.go(task.id, 'executing');
  const card = await w.current(task.id);
  assert.deepEqual([card.column, card.evidence.review.status, card.evidence.review.verdict], ['executing', 'changes_requested', 'changes_required']);
  assert.match(card.reworkNotes, /\[high\] feature\.txt:1 The value is wrong\./);
  await w.turn(back.run.id);
  assert.match(await readFile(promptFile, 'utf8'), /=== REVIEW FINDINGS TO FIX ===\n- \[high\] feature\.txt:1/);
  assert.equal(back.run.workspacePath, review.run.workspacePath);
});

test('custom columns: layout rules, moves along the stage on their left, an agent in the card’s own worktree, and safe removal', { skip, timeout: 60000 }, async t => {
  const { normalizeColumns, projectColumns, projectTransitions } = await import('../src/board.mjs');
  const builtins = ['todo', 'planning', 'executing', 'code_review', 'testing', 'merge', 'done'];
  const layout = (...extra) => [...builtins.slice(0, 3), ...extra, ...builtins.slice(3)].map(id => typeof id === 'string' ? { id } : id);
  const blocked = { id: 'c_blocked01', custom: true, title: 'Blocked', color: 'red' };
  const docs = { id: 'c_docs0001', custom: true, title: 'Docs', agent: { enabled: true, policy: 'ask', instructions: 'Update the README for this change. DOCS_AGENT' } };
  // Built-ins keep their order; custom columns sit between To Do and Done; names are unique.
  assert.throws(() => normalizeColumns([{ id: 'executing' }, ...builtins.filter(id => id !== 'executing').map(id => ({ id }))]), { message: /keep their order/ });
  assert.throws(() => normalizeColumns([...builtins.map(id => ({ id })), blocked]), { message: /between To Do and Done/ });
  assert.throws(() => normalizeColumns(layout({ ...blocked, title: 'Executing' })), { message: /Two columns are called/ });
  assert.throws(() => normalizeColumns(layout({ ...blocked, id: 'bad id' })), { message: /invalid ID/ });
  // Moves: Blocked and Docs are attached to Executing.
  const table = projectTransitions({ columnLayout: normalizeColumns(layout(blocked, docs)) });
  assert.deepEqual(table.executing, ['code_review', 'todo', 'c_blocked01', 'c_docs0001']);
  assert.deepEqual(table.c_blocked01, ['executing', 'code_review', 'todo', 'c_docs0001']);
  // Hiding Planning removes it from every move.
  const hidden = projectTransitions({ columnLayout: normalizeColumns(layout().map(entry => entry.id === 'planning' ? { id: 'planning', hidden: true } : entry)) });
  assert.deepEqual([hidden.todo, hidden.planning], [['executing'], undefined]);
  assert.equal(projectColumns({ columnLayout: [{ id: 'todo' }, { id: 'planning', hidden: true }] }).some(column => column.id === 'planning'), false);

  const w = await world(t);
  await w.board.setWorkflow(w.project.id, { workflow: { executing: { policy: 'manual' } }, agentDefaults: { provider: 'claude', model: 'haiku' }, expectedRevision: await w.revision() });
  await w.board.setColumns(w.project.id, { columns: layout(blocked, docs), expectedRevision: await w.revision() });
  const view = (await w.board.view()).projects[0];
  assert.deepEqual(view.columns.map(column => column.id), ['todo', 'planning', 'executing', 'c_blocked01', 'c_docs0001', 'code_review', 'testing', 'merge', 'done']);
  assert.deepEqual([view.effectiveWorkflow.c_docs0001.policy, view.effectiveWorkflow.c_docs0001.model, view.effectiveWorkflow.c_blocked01.policy], ['start', 'haiku', 'manual']);
  const task = await w.board.createTask({ projectId: w.project.id, title: 'With docs', prompt: 'Change it. WRITE_FILE:feature.txt' });
  await assert.rejects(w.go(task.id, 'c_blocked01'), { code: 'TRANSITION_NOT_ALLOWED' });
  await w.board.setWorkflow(w.project.id, { workflow: { executing: { policy: 'manual' } }, agentDefaults: { provider: 'claude', model: 'haiku' }, expectedRevision: await w.revision() });
  await w.go(task.id, 'executing');
  const ws = await w.board.ensureTaskWorktree(task.id);
  // A manual custom column: the card moves, nothing starts.
  assert.equal((await w.go(task.id, 'c_blocked01')).task.column, 'c_blocked01');
  // An agent column: the drag starts its agent in the same worktree with the column instructions and the inherited model.
  const promptFile = join(ws.path, '..', 'docs-prompt.txt');
  process.env.FAKE_AGENT_PROMPT_FILE = promptFile;
  t.after(() => { delete process.env.FAKE_AGENT_PROMPT_FILE; });
  const started = await w.go(task.id, 'c_docs0001');
  assert.deepEqual([started.run.stage, started.run.workspacePath, started.run.branch, started.run.config.model], ['c_docs0001', ws.path, ws.branch, 'haiku']);
  await w.turn(started.run.id);
  assert.match(await readFile(promptFile, 'utf8'), /DOCS_AGENT/);
  assert.equal(await readFile(join(ws.path, 'feature.txt'), 'utf8'), 'written by the agent\n', 'It writes in the task worktree.');
  // A column that holds a card cannot be removed.
  await assert.rejects(w.board.setColumns(w.project.id, { columns: layout(blocked), expectedRevision: await w.revision() }), { code: 'COLUMN_NOT_EMPTY', message: /1 in Docs/ });
  // Leaving the column along Executing's moves: the finished turn is handed off and its changes committed.
  const toReview = await w.go(task.id, 'code_review', { decision: 'move', commitMessage: 'Docs' });
  assert.equal(toReview.task.column, 'code_review');
  assert.equal((await w.board.run(started.run.id)).status, 'succeeded');
  assert.equal(git(ws.path, 'log', '-1', '--format=%s'), 'Docs');
  await w.board.setColumns(w.project.id, { columns: layout(blocked), expectedRevision: await w.revision() });
  assert.deepEqual((await w.board.view()).projects[0].columns.filter(column => column.custom).map(column => column.title), ['Blocked']);
  // The history keeps the custom stage; the run record stays.
  assert.ok((await w.current(task.id)).transitions.some(move => move.to === 'c_docs0001'));
});

test('Merge with a conflicting target: the merge agent starts by itself, its resolution is committed, and the card goes back to Code Review', { skip, timeout: 90000 }, async t => {
  const w = await world(t);
  const task = await w.board.createTask({ projectId: w.project.id, title: 'Conflicting', prompt: 'Change it.' });
  await w.board.setWorkflow(w.project.id, { workflow: { executing: { policy: 'manual' }, code_review: { policy: 'manual' } }, expectedRevision: await w.revision() });
  await w.go(task.id, 'executing');
  const ws = (await w.board.ensureTaskWorktree(task.id)).path;
  await writeFile(join(ws, 'feature.txt'), 'task version\n');
  await w.go(task.id, 'code_review'); // Commits the work itself (the card title).
  await w.board.delivery.recordReview({ id: 'r', taskId: task.id, review: { taskCommit: git(ws, 'rev-parse', 'HEAD') }, promptRevision: 1 }, '```json\n{"verdict":"no_issues","findings":[]}\n```');
  const testing = await w.go(task.id, 'testing'); // Starts the tests at once.
  assert.ok(testing.tests.id);
  await until(async () => (await w.current(task.id)).evidence.tests.status === 'passed', 'tests passed');
  // The target moves on with a conflicting change.
  await writeFile(join(w.root, 'feature.txt'), 'target version\n'); git(w.root, 'commit', '-qam', 'target change');
  const entered = await w.go(task.id, 'merge');
  assert.equal(entered.merge.state, 'resolving');
  const card = await w.current(task.id);
  assert.equal(card.flow.kind, 'merge-resolve');
  const mergeRun = await w.board.run(card.flow.runId);
  assert.deepEqual([mergeRun.stage, mergeRun.trigger, mergeRun.workspacePath], ['merge', 'automation', ws]);
  assert.match(await readFile(join(ws, 'feature.txt'), 'utf8'), /<<<<<<</);
  // The agent resolves the conflict in the task worktree (simulated here) and finishes its turn.
  await w.turn(mergeRun.id);
  await writeFile(join(ws, 'feature.txt'), 'task version\ntarget version\n');
  await w.board.advanceFlows();
  const back = await w.current(task.id);
  assert.deepEqual([back.column, back.flow], ['code_review', null], 'Resolving changed code, so it is reviewed again.');
  assert.equal(git(ws, 'log', '-1', '--format=%s'), 'Merge trunk into ' + back.workspace.branch);
  assert.equal(git(ws, 'status', '--porcelain'), '');
  // The old review never authorizes the merge commit: Testing needs a new review.
  await assert.rejects(w.go(task.id, 'testing'), { message: /older commit/ });
});

test('Testing: the optional testing agent starts by itself when the project tests fail', { skip, timeout: 60000 }, async t => {
  const w = await world(t);
  await w.board.setWorkflow(w.project.id, { workflow: { executing: { policy: 'manual' }, code_review: { policy: 'manual' }, testing: { policy: 'start', agentOnFailure: true } }, expectedRevision: await w.revision() });
  await w.board.delivery.setTestCommands(w.project.id, { commands: [{ command: `${process.execPath} -e "console.error('expected 2, got 3'); process.exit(1)"` }], expectedRevision: await w.revision() });
  const task = await w.board.createTask({ projectId: w.project.id, title: 'Tested', prompt: 'x' });
  await w.go(task.id, 'executing');
  const ws = (await w.board.ensureTaskWorktree(task.id)).path;
  await writeFile(join(ws, 'a.txt'), 'a\n');
  await w.go(task.id, 'code_review');
  await w.board.delivery.recordReview({ id: 'r', taskId: task.id, review: { taskCommit: git(ws, 'rev-parse', 'HEAD') }, promptRevision: 1 }, '```json\n{"verdict":"no_issues","findings":[]}\n```');
  const promptFile = join(ws, '..', 'testing-prompt.txt');
  process.env.FAKE_AGENT_PROMPT_FILE = promptFile;
  t.after(() => { delete process.env.FAKE_AGENT_PROMPT_FILE; });
  await w.go(task.id, 'testing');
  const run = await until(async () => { await w.board.advanceFlows(); return (await w.board.view()).runs.find(item => item.taskId === task.id && item.stage === 'testing'); }, 'testing agent started');
  assert.equal(run.trigger, 'automation');
  await w.turn(run.id);
  assert.match(await readFile(promptFile, 'utf8'), /=== FAILED TESTS TO FIX ===[\s\S]*expected 2, got 3/);
});
