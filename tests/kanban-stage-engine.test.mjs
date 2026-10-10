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
  t.after(async () => { await supervisor.shutdown(500); process.env.PATH = old.PATH; for (const [key, value] of [['FAKE_AGENT_STATE', old.FAKE_AGENT_STATE], ['GEMINI_CLI_SYSTEM_SETTINGS_PATH', old.GEMINI]]) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const project = await board.createProject({ name: 'Typed', workflowMode: 'pipeline' });
  await board.linkRepository(project.id, { path: root, expectedRevision: project.revision });
  const projectNow = async () => (await board.state()).projects[0];
  await board.setTargetBranch(project.id, { branch: 'trunk', expectedRevision: (await projectNow()).revision });
  const config = defaultPipelineConfig();
  for (const [id, provider] of Object.entries(agents)) config.columns.find(column => column.id === id).strategy.agentOverride = provider;
  await board.setPipeline(project.id, { pipeline: config, expectedRevision: (await projectNow()).revision });
  await board.delivery.setTestCommands(project.id, { commands: [{ command: testCommand }], expectedRevision: (await projectNow()).revision });
  const task = async id => (await projectNow()).tasks.find(item => item.id === id);
  const go = async (id, column) => board.transition(id, { column, expectedRevision: (await task(id)).revision });
  const finished = runId => until(async () => { const run = await board.run(runId); return run.status === 'waiting_for_input' && run.turnComplete && (run.activity ? run.activity.ready !== false : true) && run; }, 'finished turn');
  const outcome = (id, status) => until(async () => { await board.advanceFlows(); const card = await task(id); return card.stageOutcome?.status === status && card.stageOutcome; }, `outcome ${status}`);
  return { board, supervisor, root, dataDir, state, project, projectNow, task, go, finished, outcome };
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
  assert.match(project.autopilot.log.map(entry => entry.text).join('\n'), /back to Executing \(rework 1\/2\)/);
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
  assert.match(paused.reason, /REWORK_LIMIT_REACHED after 1 rework round/);
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
