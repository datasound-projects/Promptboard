// The typed-column stage engine end to end: real Git, the real supervisor and PTYs, simulated CLIs
// (tests/fixtures/fake-agent.cjs installed as claude, codex and gemini). One engine serves drags and Autopilot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Board } from '../src/board.mjs';
import { Supervisor } from '../src/supervisor.mjs';
import { Autopilot } from '../src/autopilot.mjs';
import { defaultPipelineConfig } from '../src/pipeline-config.mjs';
import { parseTestVerdict } from '../src/delivery.mjs';

const skip = process.platform === 'win32';
const fake = fileURLToPath(new URL('./fixtures/fake-agent.cjs', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
async function temp(t, prefix) { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return dir; }
async function until(fn, label, ms = 20000) { const end = Date.now() + ms; for (;;) { const value = await fn(); if (value) return value; if (Date.now() > end) assert.fail(`Timed out: ${label}`); await new Promise(r => setTimeout(r, 50)); } }

/** A typed pipeline board on a disposable repository. `agents` picks the provider per column. */
async function world(t, { agents = {}, testCommand = `${process.execPath} -e "process.exit(0)"` } = {}) {
  const bin = await temp(t, 'pb-se-bin-'), state = await temp(t, 'pb-se-state-');
  for (const name of ['claude', 'codex', 'gemini']) { await writeFile(join(bin, name), `#!${process.execPath}\nrequire(${JSON.stringify(fake)});\n`); await chmod(join(bin, name), 0o755); }
  const old = { PATH: process.env.PATH, FAKE_AGENT_STATE: process.env.FAKE_AGENT_STATE, GEMINI: process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH };
  process.env.PATH = `${bin}:${old.PATH}`; process.env.FAKE_AGENT_STATE = state;
  process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = join(state, 'no-gemini-admin-settings.json');
  const root = await temp(t, 'pb-se-repo-');
  git(root, 'init', '-q', '-b', 'trunk'); git(root, 'config', 'user.email', 't@example.com'); git(root, 'config', 'user.name', 'Tester');
  await writeFile(join(root, 'feature.txt'), 'one\n'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'init');
  const dataDir = await temp(t, 'pb-se-data-');
  const board = new Board({ dataDir }), supervisor = new Supervisor({ board, dataDir });
  board.executor = supervisor;
  t.after(async () => { board.delivery.stopAllTests(); await supervisor.shutdown(500); process.env.PATH = old.PATH; for (const [key, value] of [['FAKE_AGENT_STATE', old.FAKE_AGENT_STATE], ['GEMINI_CLI_SYSTEM_SETTINGS_PATH', old.GEMINI]]) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const project = await board.createProject({ name: 'Typed', workflowMode: 'pipeline' });
  await board.linkRepository(project.id, { path: root, expectedRevision: project.revision });
  const projectNow = async (b = board) => (await b.state()).projects[0];
  await board.setTargetBranch(project.id, { branch: 'trunk', expectedRevision: (await projectNow()).revision });
  const config = defaultPipelineConfig();
  for (const [id, provider] of Object.entries(agents)) config.columns.find(column => column.id === id).strategy.agentOverride = provider;
  await board.setPipeline(project.id, { pipeline: config, expectedRevision: (await projectNow()).revision });
  // testCommand null: no configured commands, so the Testing agent finds and runs the tests and its verdict decides.
  if (testCommand !== null) await board.delivery.setTestCommands(project.id, { commands: [{ command: testCommand }], expectedRevision: (await projectNow()).revision });
  // `b` is another Board on the same data folder: the app after a restart.
  const task = async (id, b = board) => (await projectNow(b)).tasks.find(item => item.id === id);
  const go = async (id, column, b = board) => b.transition(id, { column, expectedRevision: (await task(id, b)).revision });
  const finished = runId => until(async () => { const run = await board.run(runId); return run.status === 'waiting_for_input' && run.turnComplete && (run.activity ? run.activity.ready !== false : true) && run; }, 'finished turn');
  const outcome = (id, status, b = board) => until(async () => { await b.advanceFlows(); const card = await task(id, b); return card.stageOutcome?.status === status && card.stageOutcome; }, `outcome ${status}`);
  // Someone else's work lands on the target branch.
  const moveTarget = async file => { await writeFile(join(root, file), 'x\n'); git(root, 'add', file); git(root, 'commit', '-q', '-m', `add ${file}`); };
  /** Automatic completion through Executing, Code Review (with any review rework) and Testing. */
  const throughTesting = async id => {
    await board.setExecutionPolicy(project.id, { policy: { completion: 'automatic' }, expectedRevision: (await projectNow()).revision });
    await go(id, 'executing'); await outcome(id, 'succeeded');
    await go(id, 'code_review');
    const review = await until(async () => { await board.advanceFlows(); const card = await task(id); return ['succeeded', 'changes_required'].includes(card.stageOutcome?.status) && card.stageOutcome; }, 'review');
    if (review.status === 'changes_required') { await go(id, 'executing'); await outcome(id, 'succeeded'); await go(id, 'code_review'); await outcome(id, 'succeeded'); }
    await go(id, 'testing'); await outcome(id, 'succeeded');
  };
  /** A second app process on the same data folder (after the first one stopped). */
  const restart = t2 => { const b = new Board({ dataDir }), s = new Supervisor({ board: b, dataDir }); b.executor = s; t2.after(() => { b.delivery.stopAllTests(); return s.shutdown(500); }); return b; };
  return { board, supervisor, root, dataDir, state, project, projectNow, task, go, finished, outcome, moveTarget, throughTesting, restart };
}

test('manual moves through typed columns: fresh sessions per provider, one worktree, plan handoff, checkpoint, verdict, real test exit codes and a squash merge', { skip, timeout: 120000 }, async t => {
  const w = await world(t, { agents: { planning: 'codex', executing: 'codex', code_review: 'claude', testing: 'gemini' } });
  const card = await w.board.createTask({ projectId: w.project.id, title: 'Typed feature', prompt: 'Change the feature. WRITE_FILE:feature.txt' });
  // Planning with Codex: no native plan-approval event exists; the plan is the final message of a read-only session.
  const planning = (await w.go(card.id, 'planning')).run;
  assert.deepEqual([planning.stage, planning.stageKind, planning.config.provider, planning.config.permissionMode], ['planning', 'planning', 'codex', 'plan']);
  await w.finished(planning.id);
  assert.equal((await w.task(card.id)).stageOutcome.status, 'working', 'Manual completion waits: nothing completes on its own.');
  await w.board.advanceFlows();
  assert.equal((await w.board.run(planning.id)).status, 'waiting_for_input');
  // Dragging on completes the stage (the move is the confirmation) and starts a fresh Executing session.
  const executing = (await w.go(card.id, 'executing')).run;
  assert.equal((await w.board.run(planning.id)).status, 'succeeded');
  assert.equal((await w.task(card.id)).planApproval.runId, planning.id, 'The plan was accepted for this task text.');
  assert.notEqual(executing.sessionId, planning.sessionId, 'A fresh session, not a resumed planning conversation.');
  assert.equal(executing.resumeFrom, undefined);
  const ws = (await w.task(card.id)).workspace;
  await w.finished(executing.id);
  const prompt = await readFile(join(w.dataDir, executing.artifactsDir, 'prompt.md'), 'utf8');
  assert.match(prompt, /=== APPROVED PLAN ===\nPLAN/); assert.match(prompt, /=== TASK STATE \(from Promptboard, not from another agent\) ===/);
  assert.match(prompt, /Planning \(planning, codex\): succeeded/);
  // Code Review with a different provider: checkpoint commit first, then a fresh read-only session on the same worktree.
  const review = (await w.go(card.id, 'code_review')).run;
  assert.equal(git(ws.path, 'status', '--porcelain'), '');
  assert.match(git(ws.path, 'log', '-1', '--format=%s'), /^promptboard\(#\d+\): Executing checkpoint$/);
  assert.deepEqual([review.config.provider, review.workspacePath, review.branch, review.config.permissionMode], ['claude', ws.path, ws.branch, 'plan']);
  await w.finished(review.id);
  // Testing (Gemini): the review verdict is read from its structured result; the agent cannot certify the tests.
  const testing = (await w.go(card.id, 'testing')).run;
  assert.equal((await w.task(card.id)).evidence.review.status, 'accepted');
  await w.finished(testing.id);
  const tested = await w.board.completeStage(card.id, {});
  assert.equal(tested.outcome.status, 'verifying', 'Promptboard runs the configured commands itself.');
  await w.outcome(card.id, 'succeeded');
  assert.equal((await w.task(card.id)).evidence.tests.status, 'passed');
  // Merge, manual completion: ready, then one Merge click squashes the reviewed and tested tree onto trunk.
  const entered = await w.go(card.id, 'merge');
  assert.equal(entered.merge.state, 'ready');
  const taskCommit = git(ws.path, 'rev-parse', 'HEAD'), before = git(w.root, 'rev-parse', 'trunk');
  const merged = await w.board.mergeNow(card.id);
  assert.equal(merged.merged, true);
  assert.equal(git(w.root, 'rev-parse', 'trunk^'), before, 'One commit on top of the previous target.');
  assert.equal(git(w.root, 'rev-parse', 'trunk^{tree}'), git(w.root, 'rev-parse', `${taskCommit}^{tree}`), 'Exactly the tested tree.');
  assert.match(git(w.root, 'log', '-1', '--format=%s'), /^Typed feature$/);
  const done = await w.task(card.id);
  assert.equal(done.column, 'done'); assert.equal(done.completion.kind, 'merged'); assert.equal(done.completion.squash, true);
  // Every agent run of the task used the same branch and worktree, with fresh sessions and three providers.
  const runs = (await w.board.state()).runs.filter(run => run.taskId === card.id);
  assert.deepEqual([...new Set(runs.map(run => run.workspacePath))], [ws.path]); assert.deepEqual([...new Set(runs.map(run => run.branch))], [ws.branch]);
  assert.deepEqual(runs.map(run => run.config.provider), ['codex', 'codex', 'claude', 'gemini']);
  assert.equal(new Set(runs.map(run => run.sessionId)).size, runs.length);
  assert.deepEqual(done.stageHistory.map(item => [item.columnId, item.status]), [['planning', 'succeeded'], ['executing', 'succeeded'], ['code_review', 'succeeded'], ['testing', 'succeeded']]);
});

test('Full Autopilot: strict queue order, automatic completion, review and test rework loops, merges, and each next card starts from the merged target', { skip, timeout: 180000 }, async t => {
  const marker = join(tmpdir(), `pb-se-tests-${process.pid}-${Date.now()}`);
  t.after(() => rm(marker, { force: true }));
  // The configured test command fails once, then passes: only its exit code decides.
  const testCommand = `${process.execPath} -e "const f=require('fs');if(f.existsSync('${marker}'))process.exit(0);f.writeFileSync('${marker}','');process.exit(1)"`;
  const w = await world(t, { agents: { planning: 'codex', executing: 'codex', code_review: 'claude', testing: 'gemini' }, testCommand });
  const first = await w.board.createTask({ projectId: w.project.id, title: 'First', prompt: 'First change. WRITE_FILE:first.txt REVIEW_FAIL_ONCE TASK_KEY:first' });
  const second = await w.board.createTask({ projectId: w.project.id, title: 'Second', prompt: 'Second change. WRITE_FILE:second.txt TASK_KEY:second' });
  const third = await w.board.createTask({ projectId: w.project.id, title: 'Third', prompt: 'Third change. WRITE_FILE:third.txt TASK_KEY:third' });
  await assert.rejects(w.board.applyFullAutopilot(w.project.id, { expectedRevision: (await w.projectNow()).revision }), { code: 'CONFIRMATION_REQUIRED' });
  await w.board.applyFullAutopilot(w.project.id, { expectedRevision: (await w.projectNow()).revision, confirm: true });
  let project = await w.projectNow();
  assert.deepEqual(project.execution, { interaction: 'autonomous', filesystem: 'workspace_write', completion: 'automatic', maxRework: 2, mergeMethod: 'squash', workspaceTrust: 'task_workspaces' });
  // The user's order, not the creation order: Third, First, Second.
  await w.board.setAutopilot(w.project.id, { route: project.autopilot.route, queue: [third.id, first.id, second.id], expectedRevision: project.revision });
  await w.board.controlAutopilot(w.project.id, { action: 'start', confirm: true });
  const autopilot = new Autopilot(w.board, { tickMs: 1e9 });
  const order = [];
  await until(async () => {
    await autopilot.tick();
    project = await w.projectNow();
    const current = project.autopilot.current?.taskId;
    if (current && order.at(-1) !== current) order.push(current);
    // Only one card is ever outside To Do and Done.
    assert.ok(project.tasks.filter(item => !['todo', 'done'].includes(item.column)).length <= 1, 'One card at a time.');
    if (project.autopilot.status === 'paused') assert.fail(`Autopilot paused: ${project.autopilot.reason}`);
    return project.autopilot.status === 'finished';
  }, 'Autopilot finished', 150000);
  assert.deepEqual(order, [third.id, first.id, second.id], 'Exact queue order.');
  project = await w.projectNow();
  for (const id of [first.id, second.id, third.id]) assert.equal(project.tasks.find(item => item.id === id).column, 'done');
  // Each card's branch started from the target as merged by the card before it.
  const merged = Object.fromEntries(project.tasks.map(item => [item.id, item.completion]));
  const runs = (await w.board.state()).runs;
  // A card's first run records the commit its new branch started from.
  const branchBase = id => runs.filter(run => run.taskId === id).sort((a, b) => a.createdAt - b.createdAt)[0].startCommit;
  assert.equal(branchBase(first.id), merged[third.id].mergedCommit, 'First started from the target containing Third.');
  assert.equal(branchBase(second.id), merged[first.id].mergedCommit, 'Second started from the target containing First.');
  for (const file of ['first.txt', 'second.txt', 'third.txt']) assert.ok(git(w.root, 'ls-tree', '--name-only', 'trunk', file), `${file} is on trunk`);
  assert.equal(git(w.root, 'rev-list', '--count', 'trunk'), '4', 'One squash commit per card on top of init.');
  // First: the review asked for changes once and the tests failed once; both went back to Executing within the limit.
  const history = project.tasks.find(item => item.id === first.id).stageHistory.map(item => `${item.columnId}:${item.status}`);
  assert.ok(history.includes('code_review:changes_required'), history.join(' '));
  const thirdHistory = project.tasks.find(item => item.id === third.id).stageHistory.map(item => `${item.columnId}:${item.status}`);
  assert.ok(thirdHistory.includes('testing:changes_required'), `The first test run failed for the first card: ${thirdHistory.join(' ')}`);
  // Zero prompts: Codex wrote under the never-ask policy and planned read-only; Claude reviewed in plan mode.
  const firstRuns = runs.filter(run => run.taskId === first.id);
  assert.ok(firstRuns.filter(run => run.stageKind === 'executing').length >= 2, 'Executing ran again for rework.');
  for (const run of firstRuns.filter(run => run.config.provider === 'codex' && run.stageKind === 'executing')) assert.equal(run.config.interaction, 'autonomous');
  assert.match(project.autopilot.log.map(entry => entry.text).join('\n'), /back to Executing \(rework round 1\)/);
});

test('stage checks fail closed: a planner that writes, an unreadable review verdict, the rework limit and a missing worktree pause with a reason', { skip, timeout: 120000 }, async t => {
  const w = await world(t, { agents: { planning: 'claude', executing: 'claude', code_review: 'claude', testing: 'claude' } });
  await w.board.setExecutionPolicy(w.project.id, { policy: { completion: 'automatic', maxRework: 1 }, expectedRevision: (await w.projectNow()).revision });
  // A planning CLI that ignores its read-only mode: PLAN_MODIFIED_WORKSPACE, and the plan is not accepted.
  const writer = await w.board.createTask({ projectId: w.project.id, title: 'Writer', prompt: 'Plan it. WRITE_ANYWAY' });
  const run = (await w.go(writer.id, 'planning')).run;
  const failed = await w.outcome(writer.id, 'failed');
  assert.equal(failed.code, 'PLAN_MODIFIED_WORKSPACE');
  assert.equal((await w.task(writer.id)).planApproval, null);
  assert.notEqual((await w.board.run(run.id)).status, 'succeeded');
  // A review without the structured verdict is not read as a pass.
  const vague = await w.board.createTask({ projectId: w.project.id, title: 'Vague', prompt: 'Do it. WRITE_FILE:vague.txt REVIEW_GARBAGE' });
  await w.go(vague.id, 'executing'); await w.outcome(vague.id, 'succeeded');
  await w.go(vague.id, 'code_review');
  assert.equal((await w.outcome(vague.id, 'failed')).code, 'INVALID_REVIEW_RESULT');
  await assert.rejects(w.go(vague.id, 'testing'), { code: 'STAGE_NOT_READY' });
  // Autopilot stops at the rework limit instead of looping.
  const stubborn = await w.board.createTask({ projectId: w.project.id, title: 'Stubborn', prompt: 'Do it. WRITE_FILE:stubborn.txt REVIEW_FAIL' });
  const project = await w.projectNow();
  await w.board.setAutopilot(w.project.id, { route: ['executing', 'code_review'], queue: [stubborn.id], expectedRevision: project.revision });
  await w.board.controlAutopilot(w.project.id, { action: 'start', confirm: true });
  const autopilot = new Autopilot(w.board, { tickMs: 1e9 });
  const paused = await until(async () => { await autopilot.tick(); const now = await w.projectNow(); return now.autopilot.status === 'paused' && now.autopilot; }, 'Autopilot paused', 90000);
  assert.match(paused.reason, /REWORK_LIMIT_REACHED, the same problem came back 1 time/);
  await w.board.controlAutopilot(w.project.id, { action: 'stop' });
  // A deleted worktree is never recreated silently: the next move fails closed until Restore worktree.
  const ws = (await w.task(stubborn.id)).workspace;
  await rm(ws.path, { recursive: true, force: true });
  await assert.rejects(w.go(stubborn.id, 'executing'), { code: 'WORKTREE_MISSING' });
  await w.board.restoreTaskWorktree(stubborn.id);
  assert.ok((await w.task(stubborn.id)).workspace.recoveredAt);
});

test('Reset task: restarting sessions keeps the branch and files; a workspace reset needs confirmation and keeps the old branch', { skip, timeout: 60000 }, async t => {
  const w = await world(t);
  const card = await w.board.createTask({ projectId: w.project.id, title: 'Resettable', prompt: 'Do it. WRITE_FILE:reset.txt' });
  const run = (await w.go(card.id, 'executing')).run;
  await w.finished(run.id);
  const ws = (await w.task(card.id)).workspace;
  const restarted = await w.board.restartTaskSessions(card.id, { expectedRevision: (await w.task(card.id)).revision });
  assert.equal(restarted.sessionId, null); assert.equal(restarted.column, 'executing'); assert.equal(restarted.workspace.path, ws.path);
  assert.equal((await w.board.run(run.id)).status, 'cancelled');
  assert.match(await readFile(join(ws.path, 'reset.txt'), 'utf8'), /written by the agent/, 'Files stay.');
  await assert.rejects(w.board.startOver(card.id, { expectedRevision: restarted.revision }), { code: 'CONFIRMATION_REQUIRED' });
  const reset = await w.board.startOver(card.id, { expectedRevision: restarted.revision, confirm: true, reason: 'Try again' });
  assert.equal(reset.task.column, 'todo'); assert.equal(reset.task.workspace, null); assert.equal(reset.attempt.branch, ws.branch);
  assert.ok(git(w.root, 'branch', '--list', ws.branch), 'The old branch is kept.');
});

test('recovery: an app restart mid-stage interrupts the run and Autopilot restarts that stage fresh in the same worktree; an autonomous column reports a waiting prompt', { skip, timeout: 150000 }, async t => {
  const w = await world(t, { agents: { executing: 'claude', code_review: 'claude', testing: 'claude' } });
  await w.board.setExecutionPolicy(w.project.id, { policy: { interaction: 'autonomous', completion: 'automatic' }, expectedRevision: (await w.projectNow()).revision });
  const card = await w.board.createTask({ projectId: w.project.id, title: 'Survives a restart', prompt: 'Do it. WRITE_FILE:restart.txt HANG_ONCE TASK_KEY:restart' });
  await w.board.setAutopilot(w.project.id, { route: ['executing', 'code_review', 'testing', 'merge'], queue: [card.id], expectedRevision: (await w.projectNow()).revision });
  await w.board.controlAutopilot(w.project.id, { action: 'start', confirm: true });
  let autopilot = new Autopilot(w.board, { tickMs: 1e9 });
  const hung = await until(async () => { await autopilot.tick(); return (await w.board.state()).runs.find(run => run.taskId === card.id && run.status === 'running'); }, 'first Executing run');
  // Restart only once that agent is really mid-turn (it received the task and is working).
  await until(() => readFile(join(w.state, 'hang-restart'), 'utf8').then(() => true, () => false), 'the first agent is mid-turn');
  const ws = (await w.task(card.id)).workspace;
  // The app stops: its agents end; a new process reads the same data folder.
  await w.supervisor.shutdown(500);
  const board = new Board({ dataDir: w.dataDir }), supervisor = new Supervisor({ board, dataDir: w.dataDir }); board.executor = supervisor;
  t.after(() => supervisor.shutdown(500));
  assert.equal((await board.run(hung.id)).status, 'interrupted');
  autopilot = new Autopilot(board, { tickMs: 1e9 });
  const paused = await until(async () => { await autopilot.tick(); const project = (await board.state()).projects[0]; return project.autopilot.status === 'paused' && project.autopilot; }, 'Autopilot pauses on the interrupted stage');
  assert.match(paused.reason, /Executing failed \(AGENT_INTERRUPTED\)/);
  await board.controlAutopilot(w.project.id, { action: 'resume' });
  await until(async () => { await autopilot.tick(); return (await board.state()).projects[0].autopilot.status === 'finished'; }, 'Autopilot finished after the restart', 120000).catch(async error => {
    const state = await board.state(), item = state.projects[0];
    throw new Error(`${error.message}: ${JSON.stringify({ autopilot: { status: item.autopilot.status, reason: item.autopilot.reason, current: item.autopilot.current, log: item.autopilot.log.slice(-6).map(entry => entry.text) }, card: item.tasks.find(task => task.id === card.id)?.stageOutcome, column: item.tasks.find(task => task.id === card.id)?.column, runs: state.runs.filter(run => run.taskId === card.id).map(run => [run.stage, run.status, run.turnComplete, run.activity?.ready, run.lifecycle]) })}`);
  });
  const done = (await board.state()).projects[0].tasks.find(item => item.id === card.id);
  assert.equal(done.completion.kind, 'merged');
  const runs = (await board.state()).runs.filter(run => run.taskId === card.id);
  assert.deepEqual([...new Set(runs.map(run => run.workspacePath))], [ws.path], 'The restarted stage used the same worktree.');
  assert.ok(runs.filter(run => run.stageKind === 'executing').length >= 2);
  // An autonomous column whose agent stops at a permission prompt is reported, and continues once answered.
  const asking = await board.createTask({ projectId: w.project.id, title: 'Asks permission', prompt: 'Do it. WRITE_FILE:ask.txt ASK_PERMISSION' });
  const run = (await board.transition(asking.id, { column: 'executing', expectedRevision: asking.revision })).run;
  const reported = await until(async () => { await board.advanceFlows(); const item = (await board.state()).projects[0].tasks.find(task => task.id === asking.id); return item.stageOutcome?.code === 'PERMISSION_REQUIRED' && item.stageOutcome; }, 'PERMISSION_REQUIRED', 30000);
  assert.match(reported.reason, /waiting for an answer in its terminal although this column is autonomous/);
  supervisor.input(run.id, 'y\r');
  await until(async () => { await board.advanceFlows(); return (await board.state()).projects[0].tasks.find(task => task.id === asking.id).stageOutcome?.status === 'succeeded'; }, 'the answered stage completed', 30000);
});

test('a testing agent that changes files sends the card back with the file names (TESTER_CHANGED_FILES)', { skip, timeout: 120000 }, async t => {
  const w = await world(t, { agents: { executing: 'claude', code_review: 'claude', testing: 'claude' } });
  await w.board.setExecutionPolicy(w.project.id, { policy: { completion: 'automatic' }, expectedRevision: (await w.projectNow()).revision });
  const card = await w.board.createTask({ projectId: w.project.id, title: 'Tester writes', prompt: 'Do it. WRITE_FILE:tested.txt TESTER_WRITES' });
  await w.go(card.id, 'executing'); await w.outcome(card.id, 'succeeded');
  await w.go(card.id, 'code_review'); await w.outcome(card.id, 'succeeded');
  await w.go(card.id, 'testing');
  const outcome = await w.outcome(card.id, 'changes_required');
  assert.equal(outcome.code, 'TESTER_CHANGED_FILES'); assert.equal(outcome.next, 'executing');
  assert.match(outcome.reason, /tested\.txt/); assert.match(outcome.reason, /\.gitignore/);
});

test('a planner that ends its turn without a plan pauses Autopilot (PLAN_MISSING); after help in the terminal, Resume checks the stage again', { skip, timeout: 120000 }, async t => {
  const w = await world(t, { agents: { planning: 'claude', executing: 'claude' } });
  await w.board.setExecutionPolicy(w.project.id, { policy: { completion: 'automatic' }, expectedRevision: (await w.projectNow()).revision });
  const card = await w.board.createTask({ projectId: w.project.id, title: 'Silent planner', prompt: 'Plan it. NO_PLAN_ONCE TASK_KEY:silent' });
  await w.board.setAutopilot(w.project.id, { route: ['planning', 'executing'], queue: [card.id], expectedRevision: (await w.projectNow()).revision });
  await w.board.controlAutopilot(w.project.id, { action: 'start', confirm: true });
  const autopilot = new Autopilot(w.board, { tickMs: 1e9 });
  const paused = await until(async () => { await autopilot.tick(); const project = await w.projectNow(); return project.autopilot.status === 'paused' && project.autopilot; }, 'PLAN_MISSING pause', 60000);
  assert.match(paused.reason, /PLAN_MISSING/);
  const run = (await w.board.state()).runs.find(item => item.taskId === card.id && item.stageKind === 'planning');
  assert.equal((await w.board.run(run.id)).status, 'waiting_for_input', 'The planner keeps running for the person.');
  // The person asks again in the terminal; the next turn carries a plan.
  w.supervisor.input(run.id, 'Please write the plan now.\r');
  await until(async () => { const value = await w.board.run(run.id); return value.turns >= 2 && value.hasPlan && value.activity?.ready; }, 'second planning turn with a plan', 30000);
  await w.board.controlAutopilot(w.project.id, { action: 'resume' });
  await until(async () => { await autopilot.tick(); const item = await w.task(card.id); return item.column === 'executing' && item.stageHistory.some(entry => entry.columnId === 'planning' && entry.status === 'succeeded'); }, 'the stage was checked again and accepted', 60000);
});

test('the testing agent verdict: a pass needs listed commands that all exited 0; anything else is invalid, never a pass', () => {
  const block = value => `Ran the tests.\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
  assert.equal(parseTestVerdict(block({ verdict: 'passed', commands: [{ command: 'npm test', exitCode: 0 }], failures: [] })).verdict, 'passed');
  const failed = parseTestVerdict(block({ verdict: 'failed', commands: [{ command: 'pytest', exitCode: 1, output: 'E   assert 2 == 3' }], failures: [{ file: 'a.py', line: 3, explanation: 'Off by one.' }], summary: 'One test fails.' }));
  assert.deepEqual([failed.verdict, failed.failures[0].file, failed.commands[0].output, failed.summary], ['failed', 'a.py', 'E   assert 2 == 3', 'One test fails.']);
  for (const [value, problem] of [[{ verdict: 'passed', commands: [] }, /without listing any command/], [{ verdict: 'passed', commands: [{ command: 'npm test', exitCode: 1 }] }, /did not exit with 0/],
    [{ verdict: 'passed', commands: [{ command: 'npm test' }] }, /did not exit with 0/], [{ verdict: 'passed', commands: [{ command: 'npm test', exitCode: 0 }], failures: [{ explanation: 'x' }] }, /together with failures/]]) {
    const result = parseTestVerdict(block(value)); assert.equal(result.verdict, 'invalid'); assert.match(result.problem, problem);
  }
  assert.equal(parseTestVerdict('All good, trust me.').verdict, 'invalid');
  assert.equal(parseTestVerdict(block({ verdict: 'maybe', commands: [] })).parsed, false);
  // The last valid block wins, as for review verdicts.
  assert.equal(parseTestVerdict(`${block({ verdict: 'failed', commands: [{ command: 'a', exitCode: 1 }] })}\n${block({ verdict: 'passed', commands: [{ command: 'a', exitCode: 0 }] })}`).verdict, 'passed');
});

test('without test commands the Testing agent finds and runs the tests: its verdict decides, a failure goes back through Executing, review and testing, and the card merges', { skip, timeout: 180000 }, async t => {
  const w = await world(t, { agents: { planning: 'codex', executing: 'codex', code_review: 'claude', testing: 'claude' }, testCommand: null });
  assert.deepEqual((await w.projectNow()).testCommands || [], []);
  const flaky = await w.board.createTask({ projectId: w.project.id, title: 'Flaky', prompt: 'Change it. WRITE_FILE:flaky.txt TEST_FAIL_ONCE TASK_KEY:flaky' });
  const plain = await w.board.createTask({ projectId: w.project.id, title: 'Plain', prompt: 'Change it too. WRITE_FILE:plain.txt TASK_KEY:plain' });
  await w.board.applyFullAutopilot(w.project.id, { expectedRevision: (await w.projectNow()).revision, confirm: true });
  let project = await w.projectNow();
  await w.board.setAutopilot(w.project.id, { route: project.autopilot.route, queue: [flaky.id, plain.id], expectedRevision: project.revision });
  await w.board.controlAutopilot(w.project.id, { action: 'start', confirm: true });
  const autopilot = new Autopilot(w.board, { tickMs: 1e9 });
  await until(async () => {
    await autopilot.tick(); project = await w.projectNow();
    if (project.autopilot.status === 'paused') assert.fail(`Autopilot paused: ${project.autopilot.reason}`);
    return project.autopilot.status === 'finished';
  }, 'Autopilot finished', 150000);
  for (const id of [flaky.id, plain.id]) assert.equal(project.tasks.find(item => item.id === id).column, 'done');
  for (const file of ['flaky.txt', 'plain.txt']) assert.ok(git(w.root, 'ls-tree', '--name-only', 'trunk', file), `${file} is on trunk`);
  // The first verdict failed: back to Executing with the agent's findings, then review and testing again.
  const history = project.tasks.find(item => item.id === flaky.id).stageHistory;
  const failedTest = history.find(item => item.columnId === 'testing' && item.status === 'changes_required');
  assert.ok(failedTest, history.map(item => `${item.columnId}:${item.status}`).join(' '));
  assert.equal(failedTest.code, 'TESTS_FAILED');
  const after = history.slice(history.indexOf(failedTest) + 1).map(item => `${item.columnId}:${item.status}`);
  assert.deepEqual(after.slice(0, 3), ['executing:succeeded', 'code_review:succeeded', 'testing:succeeded'], after.join(' '));
  const runs = (await w.board.state()).runs.filter(run => run.taskId === flaky.id && run.stageKind === 'executing');
  assert.ok(runs.length >= 2, 'Executing ran again to fix the failing test.');
  const fix = runs.sort((x, y) => x.createdAt - y.createdAt)[1];
  assert.match(await readFile(join(w.dataDir, fix.artifactsDir, 'prompt.md'), 'utf8'), /Testing failed[\s\S]*off by one[\s\S]*npm test/, 'The rework run got the failing verdict.');
  // The merged evidence is the agent's own passing verdict for the merged commit.
  const tests = project.tasks.find(item => item.id === flaky.id).evidence.tests;
  assert.deepEqual([tests.source, tests.status, tests.results[0].label], ['agent', 'passed', 'npm test']);
  assert.match(project.autopilot.log.map(entry => entry.text).join('\n'), /back to Executing/);
});

test('a testing agent without a structured verdict fails closed with INVALID_TEST_RESULT instead of passing', { skip, timeout: 120000 }, async t => {
  const w = await world(t, { agents: { planning: 'claude', executing: 'claude', code_review: 'claude', testing: 'claude' }, testCommand: null });
  await w.board.setExecutionPolicy(w.project.id, { policy: { completion: 'automatic' }, expectedRevision: (await w.projectNow()).revision });
  const card = await w.board.createTask({ projectId: w.project.id, title: 'Vague tester', prompt: 'Change it. WRITE_FILE:vague.txt TEST_NO_VERDICT' });
  await w.go(card.id, 'executing'); await w.outcome(card.id, 'succeeded');
  await w.go(card.id, 'code_review'); await w.outcome(card.id, 'succeeded');
  await w.go(card.id, 'testing');
  const outcome = await w.outcome(card.id, 'failed');
  assert.equal(outcome.code, 'INVALID_TEST_RESULT'); assert.match(outcome.reason, /JSON test verdict/);
  assert.notEqual((await w.task(card.id)).evidence.tests.status, 'passed');
});

test('a failed re-test on the moved target sends its failing output to Executing, not earlier review findings', { skip, timeout: 150000 }, async t => {
  const w = await world(t, { testCommand: `${process.execPath} -e "process.exit(require('fs').existsSync('BREAK')?1:0)"` });
  const card = await w.board.createTask({ projectId: w.project.id, title: 'Rework', prompt: 'Do it. WRITE_FILE:rework.txt REVIEW_FAIL_ONCE TASK_KEY:rw' });
  await w.throughTesting(card.id);
  await w.moveTarget('BREAK');
  await w.go(card.id, 'merge');
  assert.equal((await w.outcome(card.id, 'changes_required')).code, 'VERIFICATION_FAILED');
  const run = (await w.go(card.id, 'executing')).run;
  const prompt = await until(() => readFile(join(w.dataDir, run.artifactsDir, 'prompt.md'), 'utf8').catch(() => ''), 'prompt');
  assert.match(prompt, /=== FINDINGS TO FIX ===\nThe project's tests failed[\s\S]*exit 1/);
  const current = prompt.slice(prompt.indexOf('=== FINDINGS TO FIX ==='), prompt.indexOf('=== END FINDINGS ==='));
  assert.doesNotMatch(current, /The value is wrong/, 'The review findings fixed in the earlier round are not sent again as work to do…');
  assert.match(prompt, /=== EARLIER ROUNDS OF THIS TASK ===[\s\S]*The value is wrong/, '…only as history.');
});

test('without test commands, a target that moved sends the card back to the Testing agent (TARGET_MOVED), then it merges', { skip, timeout: 150000 }, async t => {
  const w = await world(t, { testCommand: null });
  const card = await w.board.createTask({ projectId: w.project.id, title: 'Agent tested', prompt: 'Do it. WRITE_FILE:agent.txt TASK_KEY:at' });
  await w.throughTesting(card.id);
  await w.moveTarget('other.txt');
  await w.go(card.id, 'merge');
  const moved = (await w.task(card.id)).stageOutcome;
  assert.deepEqual([moved.status, moved.code, moved.next], ['changes_required', 'TARGET_MOVED', 'testing']);
  await w.go(card.id, 'testing'); await w.outcome(card.id, 'succeeded');
  const merged = await w.go(card.id, 'merge');
  assert.equal(merged.merged, true, JSON.stringify(merged.merge));
  assert.ok(git(w.root, 'ls-tree', '--name-only', 'trunk', 'other.txt') && git(w.root, 'ls-tree', '--name-only', 'trunk', 'agent.txt'));
});

test('a restart during the Merge re-test: Merge runs the tests again instead of waiting for a run that no longer exists', { skip, timeout: 150000 }, async t => {
  const w = await world(t, { testCommand: `${process.execPath} -e "if(require('fs').existsSync('SLOW'))setTimeout(()=>{},120000)"` });
  const card = await w.board.createTask({ projectId: w.project.id, title: 'Restarted', prompt: 'Do it. WRITE_FILE:r.txt TASK_KEY:rs' });
  await w.throughTesting(card.id);
  await w.moveTarget('SLOW');
  assert.equal((await w.go(card.id, 'merge')).merge.state, 'testing');
  w.board.delivery.stopAllTests(); await w.supervisor.shutdown(500);
  const board = w.restart(t);
  assert.equal((await w.outcome(card.id, 'failed', board)).code, 'VERIFICATION_INTERRUPTED');
  const again = await board.mergeNow(card.id);
  assert.equal(again.merge.state, 'testing'); assert.equal(board.delivery.testsRunning.has(card.id), true, 'The tests run again.');
  board.delivery.stopAllTests();
});

test('a stage confirmed just before the app stopped is completed after the restart, without waiting forever', { skip, timeout: 150000 }, async t => {
  const w = await world(t);
  const card = await w.board.createTask({ projectId: w.project.id, title: 'Crash window', prompt: 'Do it. WRITE_FILE:c.txt TASK_KEY:cw' });
  await w.board.setExecutionPolicy(w.project.id, { policy: { completion: 'automatic' }, expectedRevision: (await w.projectNow()).revision });
  // The app stops right after the run was saved as succeeded, before the stage outcome is written.
  const real = w.supervisor.confirm.bind(w.supervisor);
  w.supervisor.confirm = async id => { await real(id); return new Promise(() => {}); };
  const runId = (await w.go(card.id, 'executing')).run.id;
  await until(async () => { w.board.advanceFlows(); return (await w.board.run(runId)).status === 'succeeded'; }, 'confirmed');
  await w.supervisor.shutdown(500);
  const board = w.restart(t);
  const done = await w.outcome(card.id, 'succeeded', board);
  assert.equal(done.runId, runId); assert.ok(done.checkpointCommit, 'The Executing checkpoint commit was made.');
});

test('an autonomous agent stuck on an unrecognized startup menu is reported, and continues once answered in its terminal', { skip, timeout: 120000 }, async t => {
  const w = await world(t);
  await w.board.setExecutionPolicy(w.project.id, { policy: { interaction: 'autonomous', completion: 'automatic' }, expectedRevision: (await w.projectNow()).revision });
  w.board.startupStallMs = 1500;
  const card = await w.board.createTask({ projectId: w.project.id, title: 'Hooks menu', prompt: 'Do it. WRITE_FILE:h.txt HOOKS_SCREEN' });
  const run = (await w.go(card.id, 'executing')).run;
  const stuck = await w.outcome(card.id, 'failed');
  assert.equal(stuck.code, 'PERMISSION_REQUIRED'); assert.match(stuck.reason, /has not started its session[\s\S]*startup question/);
  w.supervisor.input(run.id, '\r');
  assert.equal((await w.outcome(card.id, 'succeeded')).runId, run.id, 'Answered in the terminal, the same run finishes the stage.');
});

test('an Enter on an empty prompt after a finished turn still lets the stage complete automatically', { skip, timeout: 120000 }, async t => {
  for (const provider of ['claude', 'codex', 'gemini']) await t.test(provider, async t => {
    const w = await world(t, { agents: { executing: provider } });
    const card = await w.board.createTask({ projectId: w.project.id, title: 'Stray Enter', prompt: 'Change it. WRITE_FILE:feature.txt EMPTY_ENTER_IGNORED' });
    const run = (await w.go(card.id, 'executing')).run;
    await w.finished(run.id);
    w.supervisor.input(run.id, '\r'); // The CLI ignores it: no hook, no turn.
    await w.board.setExecutionPolicy(w.project.id, { policy: { completion: 'automatic' }, expectedRevision: (await w.projectNow()).revision });
    assert.equal((await w.outcome(card.id, 'succeeded')).runId, run.id);
  });
});

test('a diff with a terminal control character reaches each typed Code Review CLI exactly', { skip, timeout: 120000 }, async t => {
  for (const provider of ['claude', 'codex', 'gemini']) await t.test(provider, async t => {
    const w = await world(t, { agents: { code_review: provider } }), received = join(w.state, 'received-prompt.txt'), old = process.env.FAKE_AGENT_PROMPT_FILE;
    process.env.FAKE_AGENT_PROMPT_FILE = received;
    t.after(() => { if (old === undefined) delete process.env.FAKE_AGENT_PROMPT_FILE; else process.env.FAKE_AGENT_PROMPT_FILE = old; });
    const card = await w.board.createTask({ projectId: w.project.id, title: 'Page break', prompt: 'Edit page.c. WRITE_FILE:feature.txt' });
    const executing = (await w.go(card.id, 'executing')).run;
    await w.finished(executing.id);
    // C, Python and Emacs Lisp sources can hold a form feed (a page break).
    await writeFile(join(executing.workspacePath, 'page.c'), 'int a;\n\x0c\nint b;\n');
    const review = (await w.go(card.id, 'code_review')).run;
    await w.finished(review.id);
    const prompt = await readFile(join(w.dataDir, review.artifactsDir, 'prompt.md'), 'utf8');
    assert.ok(prompt.includes('+\x0c\n'));
    await until(async () => await readFile(received, 'utf8').catch(() => '') === prompt, 'the CLI received the exact message');
  });
});

test('an autonomous long prompt still waiting for its CLI to show readiness is reported as a startup stall too', { skip, timeout: 120000 }, async t => {
  const w = await world(t);
  await w.board.setExecutionPolicy(w.project.id, { policy: { interaction: 'autonomous', completion: 'automatic' }, expectedRevision: (await w.projectNow()).revision });
  w.board.startupStallMs = 1500;
  const card = await w.board.createTask({ projectId: w.project.id, title: 'Long prompt menu', prompt: 'Do it. HOOKS_SCREEN' });
  const run = (await w.go(card.id, 'executing')).run;
  await until(async () => (await w.board.run(run.id)).status === 'running' && w.supervisor.sessions.get(run.id)?.watchdog, 'agent started');
  // What the supervisor records when a pasted prompt has had no readiness sign for 60 s (docs/initial-prompt-ownership.md),
  // after its 10 s no-events-yet note, which is skipped here.
  clearTimeout(w.supervisor.sessions.get(run.id).watchdog);
  await w.board.updateRun(run.id, { lifecycle: 'initial-input-not-ready', errorCode: 'CLI_INPUT_NOT_READY', waitingReason: 'The CLI has not shown that it is ready.', turnComplete: false });
  const stuck = await w.outcome(card.id, 'failed');
  assert.equal(stuck.code, 'PERMISSION_REQUIRED'); assert.match(stuck.reason, /has not started its session/);
});

test('Autopilot runs a prerequisite queued lower first, and explains a queue that only waits for unfinished prerequisites', { skip, timeout: 180000 }, async t => {
  const w = await world(t);
  const base = await w.board.createTask({ projectId: w.project.id, title: 'Base', prompt: 'Base change. WRITE_FILE:base.txt TASK_KEY:base' });
  const app = await w.board.createTask({ projectId: w.project.id, title: 'App', prompt: 'App change. WRITE_FILE:app.txt TASK_KEY:app' });
  await w.board.store.update(state => { state.projects[0].tasks.find(item => item.id === app.id).dependsOn = [base.id]; });
  await w.board.applyFullAutopilot(w.project.id, { expectedRevision: (await w.projectNow()).revision, confirm: true });
  let project = await w.projectNow();
  // The dependent card is queued first; its prerequisite must still go first.
  await w.board.setAutopilot(w.project.id, { route: project.autopilot.route, queue: [app.id, base.id], expectedRevision: project.revision });
  await w.board.controlAutopilot(w.project.id, { action: 'start', confirm: true });
  const autopilot = new Autopilot(w.board, { tickMs: 1e9 });
  await until(async () => { await autopilot.tick(); project = await w.projectNow(); if (project.autopilot.status === 'paused') assert.fail(project.autopilot.reason); return project.autopilot.status === 'finished'; }, 'Autopilot finished', 150000);
  assert.deepEqual(git(w.root, 'log', '--format=%s', 'trunk').split('\n').slice(0, 2), ['App', 'Base'], 'Base merged before App.');
  // Only a card whose prerequisite is not Done (and not queued) remains: Autopilot pauses and says why.
  const lone = await w.board.createTask({ projectId: w.project.id, title: 'Lone', prompt: 'x' }), later = await w.board.createTask({ projectId: w.project.id, title: 'Later', prompt: 'y' });
  await w.board.store.update(state => { state.projects[0].tasks.find(item => item.id === later.id).dependsOn = [lone.id]; });
  project = await w.projectNow();
  await w.board.setAutopilot(w.project.id, { route: project.autopilot.route, queue: [later.id], expectedRevision: project.revision });
  await w.board.controlAutopilot(w.project.id, { action: 'start', confirm: true });
  await autopilot.tick();
  project = await w.projectNow();
  assert.equal(project.autopilot.status, 'paused'); assert.match(project.autopilot.reason, /“Later” waits for its prerequisites, which are not complete: #\d+ Lone/);
});

test('a test command that cannot start fails clearly (TEST_COMMAND_NOT_FOUND) without spending rework rounds', { skip, timeout: 120000 }, async t => {
  const w = await world(t, { testCommand: './no-such-test-runner --all' });
  const card = await w.board.createTask({ projectId: w.project.id, title: 'Missing runner', prompt: 'Do it. WRITE_FILE:m.txt' });
  await w.board.setExecutionPolicy(w.project.id, { policy: { completion: 'automatic' }, expectedRevision: (await w.projectNow()).revision });
  await w.go(card.id, 'executing'); await w.outcome(card.id, 'succeeded');
  await w.go(card.id, 'code_review'); await w.outcome(card.id, 'succeeded');
  await w.go(card.id, 'testing');
  const outcome = await w.outcome(card.id, 'failed');
  assert.equal(outcome.code, 'TEST_COMMAND_NOT_FOUND'); assert.match(outcome.reason, /\.\/no-such-test-runner is not an installed program[\s\S]*leave it empty/);
});

test('rework goes on while each round brings a new problem, only nitpicks never block, and Executing sees earlier rounds', { skip, timeout: 180000 }, async t => {
  const w = await world(t);
  const card = await w.board.createTask({ projectId: w.project.id, title: 'Progressing', prompt: 'Do it. WRITE_FILE:p.txt REVIEW_VARIED TASK_KEY:prog' });
  const nits = await w.board.createTask({ projectId: w.project.id, title: 'Nitpicked', prompt: 'Do it. WRITE_FILE:n.txt REVIEW_NITS_ONLY TASK_KEY:nits' });
  await w.board.applyFullAutopilot(w.project.id, { expectedRevision: (await w.projectNow()).revision, confirm: true });
  let project = await w.projectNow();
  // One repeat allowed: a counter of rounds would stop after the first rework; progress keeps it going.
  await w.board.setExecutionPolicy(w.project.id, { policy: { ...project.execution, maxRework: 1 }, expectedRevision: project.revision });
  project = await w.projectNow();
  await w.board.setAutopilot(w.project.id, { route: project.autopilot.route, queue: [card.id, nits.id], expectedRevision: project.revision });
  await w.board.controlAutopilot(w.project.id, { action: 'start', confirm: true });
  const autopilot = new Autopilot(w.board, { tickMs: 1e9 });
  await until(async () => { await autopilot.tick(); project = await w.projectNow(); if (project.autopilot.status === 'paused') assert.fail(project.autopilot.reason); return project.autopilot.status === 'finished'; }, 'Autopilot finished', 170000);
  for (const id of [card.id, nits.id]) assert.equal(project.tasks.find(item => item.id === id).column, 'done');
  const reviews = project.tasks.find(item => item.id === card.id).stageHistory.filter(item => item.columnId === 'code_review').map(item => item.status);
  assert.deepEqual(reviews, ['changes_required', 'changes_required', 'succeeded']);
  const runs = (await w.board.state()).runs.filter(run => run.taskId === card.id && run.stageKind === 'executing').sort((x, y) => x.createdAt - y.createdAt);
  const third = await readFile(join(w.dataDir, runs[2].artifactsDir, 'prompt.md'), 'utf8');
  assert.match(third, /=== FINDINGS TO FIX ===\n- \[high\] other\.txt:1 A different problem\.[\s\S]*=== EARLIER ROUNDS OF THIS TASK ===[\s\S]*Round 1:\n- \[high\] feature\.txt:1 The value is wrong\./);
  assert.doesNotMatch(third, /Optional naming nit/, 'Suggestions are not sent as work to do.');
  // The nitpicked card went through review once: low findings are notes.
  const nitsCard = project.tasks.find(item => item.id === nits.id);
  assert.deepEqual(nitsCard.stageHistory.filter(item => item.columnId === 'code_review').map(item => item.status), ['succeeded']);
});
