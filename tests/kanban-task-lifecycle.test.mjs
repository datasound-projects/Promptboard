// Task completion, prerequisites and stage checks on typed pipeline boards: real Git, the real supervisor and PTYs,
// simulated CLIs (tests/fixtures/fake-agent.cjs installed as claude, codex and gemini).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Board, prerequisiteMet } from '../src/board.mjs';
import { Supervisor } from '../src/supervisor.mjs';
import { defaultPipelineConfig } from '../src/pipeline-config.mjs';

const skip = process.platform === 'win32';
const fake = fileURLToPath(new URL('./fixtures/fake-agent.cjs', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
async function temp(t, prefix) { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return dir; }
async function until(fn, label, ms = 20000) { const end = Date.now() + ms; for (;;) { const value = await fn(); if (value) return value; if (Date.now() > end) assert.fail(`Timed out: ${label}`); await new Promise(r => setTimeout(r, 50)); } }

/** A typed pipeline board (or `pipeline`, a custom one) on a disposable repository. */
async function world(t, { agentState = true, pipeline = defaultPipelineConfig() } = {}) {
  const bin = await temp(t, 'pb-lc-bin-'), state = await temp(t, 'pb-lc-state-');
  for (const name of ['claude', 'codex', 'gemini']) { await writeFile(join(bin, name), `#!${process.execPath}\nrequire(${JSON.stringify(fake)});\n`); await chmod(join(bin, name), 0o755); }
  const old = { PATH: process.env.PATH, FAKE_AGENT_STATE: process.env.FAKE_AGENT_STATE, GEMINI: process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH };
  process.env.PATH = `${bin}:${old.PATH}`;
  // With a state folder the simulated agent writes new content each round; without it a second write changes nothing.
  if (agentState) process.env.FAKE_AGENT_STATE = state; else delete process.env.FAKE_AGENT_STATE;
  process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = join(state, 'no-gemini-admin-settings.json');
  const root = await temp(t, 'pb-lc-repo-');
  git(root, 'init', '-q', '-b', 'trunk'); git(root, 'config', 'user.email', 't@example.com'); git(root, 'config', 'user.name', 'Tester');
  await writeFile(join(root, 'feature.txt'), 'one\n'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'init');
  const dataDir = await temp(t, 'pb-lc-data-');
  const board = new Board({ dataDir }), supervisor = new Supervisor({ board, dataDir });
  board.executor = supervisor;
  t.after(async () => { board.delivery.stopAllTests(); await supervisor.shutdown(500); process.env.PATH = old.PATH; for (const [key, value] of [['FAKE_AGENT_STATE', old.FAKE_AGENT_STATE], ['GEMINI_CLI_SYSTEM_SETTINGS_PATH', old.GEMINI]]) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  await board.setSettings({ maxConcurrentRuns: 4 });
  const project = await board.createProject({ name: 'Lifecycle', workflowMode: 'pipeline' });
  await board.linkRepository(project.id, { path: root, expectedRevision: project.revision });
  const projectNow = async () => (await board.state()).projects[0];
  await board.setTargetBranch(project.id, { branch: 'trunk', expectedRevision: (await projectNow()).revision });
  await board.setPipeline(project.id, { pipeline, expectedRevision: (await projectNow()).revision });
  await board.delivery.setTestCommands(project.id, { commands: [{ command: `${process.execPath} -e "process.exit(0)"` }], expectedRevision: (await projectNow()).revision });
  const task = async id => (await projectNow()).tasks.find(item => item.id === id);
  const go = async (id, column) => board.transition(id, { column, expectedRevision: (await task(id)).revision });
  const finished = runId => until(async () => { const run = await board.run(runId); return run.status === 'waiting_for_input' && run.turnComplete && (run.activity ? run.activity.ready !== false : true) && run; }, 'finished turn');
  const settled = (id, runId) => until(async () => { await board.advanceFlows(); const card = await task(id); return (!runId || card.stageOutcome?.runId === runId) && ['succeeded', 'changes_required', 'failed'].includes(card.stageOutcome?.status) && card.stageOutcome; }, 'stage outcome', 60000);
  const automatic = async () => board.setExecutionPolicy(project.id, { policy: { completion: 'automatic' }, expectedRevision: (await projectNow()).revision });
  const prompt = async run => (await until(() => readFile(join(dataDir, run.artifactsDir, 'prompt.md'), 'utf8').catch(() => ''), 'prompt written'));
  const origin = tasks => board.createOriginTasks(project.id, { originProjectId: 'origin1', tasks }).then(rows => rows.map(row => row.taskId));
  return { board, root, dataDir, project, task, go, finished, settled, automatic, prompt, origin };
}

test('Done records how a card was completed; a prerequisite counts only when its code is on the target branch', { skip, timeout: 120000 }, async t => {
  const w = await world(t);
  const [plan, afterPlan, code, afterCode] = await w.origin([
    { originTaskId: 'a', title: 'Decide naming', prompt: 'Agree on names.' },
    { originTaskId: 'b', title: 'Use the names', prompt: 'Use them. WRITE_FILE:b.txt', dependsOnOrigin: ['a'] },
    { originTaskId: 'c', title: 'Write the code', prompt: 'Code it. WRITE_FILE:c.txt' },
    { originTaskId: 'd', title: 'Build on it', prompt: 'Extend it. WRITE_FILE:d.txt', dependsOnOrigin: ['c'] },
  ]);
  // A card that never ran has no code to merge: its dependent may start.
  await w.go(plan, 'done');
  assert.deepEqual([(await w.task(plan)).completion.kind, (await w.task(plan)).completion.branch], ['unmerged', null]);
  assert.ok((await w.go(afterPlan, 'executing')).run);
  // A card moved to Done from Executing is completed without merging, with its branch, commit and uncommitted work named.
  await w.finished((await w.go(code, 'executing')).run.id);
  const trunk = git(w.root, 'rev-parse', 'trunk');
  await w.go(code, 'done');
  const done = await w.task(code);
  assert.equal(done.completion.kind, 'unmerged');
  assert.equal(done.completion.branch, done.workspace.branch);
  assert.match(done.completion.taskCommit, /^[0-9a-f]{40}$/);
  assert.equal(done.completion.uncommittedChanges, 1);
  assert.equal(done.stageOutcome, null, 'the Executing stage it left never finished');
  assert.equal(git(w.root, 'rev-parse', 'trunk'), trunk, 'nothing merged');
  // Its dependent waits: the prerequisite's code is not on the target branch.
  await assert.rejects(w.go(afterCode, 'executing'), error => error.code === 'PREREQUISITES_PENDING' && /Write the code \(Done, completed without merging; its code is not on the target branch: merge it, or clear the prerequisite\)/.test(error.message));
});

test('a dependent starts from the target with its merged prerequisite, knows what it did, and a restored card starts a new completion', { skip, timeout: 180000 }, async t => {
  const w = await world(t);
  const [first, second] = await w.origin([
    { originTaskId: 'a', title: 'Foundation', prompt: '# IMP-001 Foundation\n\n## What to do\nSet up the project. WRITE_FILE:a.txt\n' },
    { originTaskId: 'b', title: 'Database', prompt: '# IMP-002 Database\n\n## What to do\nAdd storage. WRITE_FILE:b.txt\n', dependsOnOrigin: ['a'] },
  ]);
  await w.automatic();
  for (const column of ['executing', 'code_review', 'testing']) { const run = (await w.go(first, column)).run; assert.equal((await w.settled(first, run.id)).status, 'succeeded', column); }
  await w.go(first, 'merge');
  await until(async () => (await w.task(first)).completion?.kind === 'merged' && true, 'merged');
  assert.ok(git(w.root, 'ls-tree', '--name-only', 'trunk').split('\n').includes('a.txt'));
  // Started by hand (not Autopilot): the worktree branches from the target as it is now.
  const run = (await w.go(second, 'executing')).run;
  const card = await w.task(second);
  assert.equal(card.workspace.baseCommit, git(w.root, 'rev-parse', 'trunk'));
  assert.ok(git(card.workspace.path, 'ls-files').split('\n').includes('a.txt'), 'the prerequisite\'s code is there');
  const text = await w.prompt(run);
  assert.match(text, /=== TASK \(exact text from the card\) ===\n# IMP-002 Database\n/);
  assert.match(text, /=== WHERE THIS TASK FITS[^\n]*\nProject: Lifecycle\nThis task: #2 Database \(task 2 of 2 planned in Origin\)\nStage: Executing\. Your job: implement this task only/);
  assert.match(text, /Prerequisites \(must be complete before this task\):\n- #1 Foundation: Done, merged into trunk\n  What it did: Implemented the change\./);
  assert.match(text, /the next column is Code Review\), merging and Done\. Do not merge, move or complete cards, or start another task\./);
  // Restored and moved to Done again without a merge: the old "merged" record becomes history, not the current state.
  await w.go(first, 'todo');
  assert.equal((await w.task(first)).completion, null);
  await w.go(first, 'done');
  const again = await w.task(first);
  assert.deepEqual([again.completion.kind, again.previousCompletions.map(item => item.kind)], ['unmerged', ['merged']]);
});

test('a custom column after a typed stage starts its own conversation with the task, never the typed stage\'s session', { skip, timeout: 120000 }, async t => {
  const column = (id, name, kind) => ({ id, name, ...(kind ? { kind } : {}), strategy: {}, automations: {} });
  const w = await world(t, { pipeline: { version: 1, columns: [{ id: 'todo', name: 'To Do', role: 'todo', strategy: {}, automations: {} }, column('draft', 'Draft', 'custom'),
    column('executing', 'Executing', 'execution'), column('polish', 'Polish', 'custom'), { id: 'done', name: 'Done', role: 'done', strategy: {}, automations: {} }] } });
  const card = await w.board.createTask({ projectId: w.project.id, title: 'Tidy', prompt: 'Tidy it. WRITE_FILE:feature.txt' });
  await w.finished((await w.go(card.id, 'draft')).run.id);
  await w.finished((await w.go(card.id, 'executing')).run.id);
  const polish = (await w.go(card.id, 'polish')).run;
  assert.equal(polish.resumeFrom, undefined);
  assert.match(await w.prompt(polish), /^<task>\n  <title>Tidy<\/title>/);
});

test('an automatic plan needs numbered steps; the approved plan is frozen, and Executing refuses a plan that is gone', { skip, timeout: 180000 }, async t => {
  const w = await world(t);
  await w.automatic();
  // A question is not a plan: nobody approved it, so it is not passed to Executing.
  const asks = await w.board.createTask({ projectId: w.project.id, title: 'Asks', prompt: 'Add storage. PLAN_IS_QUESTION' });
  const asked = await w.settled(asks.id, (await w.go(asks.id, 'planning')).run.id);
  assert.deepEqual([asked.status, asked.code], ['failed', 'PLAN_MISSING']);
  assert.equal((await w.task(asks.id)).planApproval, null);
  // A real plan is accepted and frozen; a later rewrite of plan.md does not change what Executing gets.
  const plans = await w.board.createTask({ projectId: w.project.id, title: 'Plans', prompt: 'Add storage. WRITE_FILE:s.txt' });
  const planRun = (await w.go(plans.id, 'planning')).run;
  assert.equal((await w.settled(plans.id, planRun.id)).status, 'succeeded');
  assert.match((await w.task(plans.id)).planApproval.sha256, /^[0-9a-f]{64}$/);
  await writeFile(join(w.dataDir, planRun.artifactsDir, 'plan.md'), 'TAMPERED');
  const exec = (await w.go(plans.id, 'executing')).run;
  assert.match(await w.prompt(exec), /=== APPROVED PLAN ===\nPLAN\n1\. Change the code\./);
  // Without the frozen copy, Executing does not start without its plan.
  const lost = await w.board.createTask({ projectId: w.project.id, title: 'Lost', prompt: 'Add storage.' });
  const lostPlan = (await w.go(lost.id, 'planning')).run;
  await w.settled(lost.id, lostPlan.id);
  await unlink(join(w.dataDir, lostPlan.artifactsDir, 'approved-plan.md'));
  const failed = (await w.go(lost.id, 'executing')).run;
  const ended = await until(async () => { const run = await w.board.run(failed.id); return run.status === 'failed' && run; }, 'run failed');
  assert.equal(ended.errorCode, 'PLAN_UNAVAILABLE');
});

test('a rework round with no new changes fails instead of sending the same commit to review again', { skip, timeout: 180000 }, async t => {
  const w = await world(t, { agentState: false });
  const card = await w.board.createTask({ projectId: w.project.id, title: 'Rework', prompt: 'Do it. WRITE_FILE:feature.txt REVIEW_FAIL' });
  await w.automatic();
  assert.equal((await w.settled(card.id, (await w.go(card.id, 'executing')).run.id)).status, 'succeeded');
  assert.equal((await w.settled(card.id, (await w.go(card.id, 'code_review')).run.id)).status, 'changes_required');
  const round = await w.settled(card.id, (await w.go(card.id, 'executing')).run.id);
  assert.deepEqual([round.status, round.code], ['failed', 'NO_NEW_CHANGES']);
});

test('a commit made by the testing agent is reviewed and tested again', { skip, timeout: 180000 }, async t => {
  const w = await world(t);
  const card = await w.board.createTask({ projectId: w.project.id, title: 'Tested', prompt: 'Do it. WRITE_FILE:feature.txt TESTER_COMMITS' });
  await w.automatic();
  for (const column of ['executing', 'code_review']) assert.equal((await w.settled(card.id, (await w.go(card.id, column)).run.id)).status, 'succeeded', column);
  const outcome = await w.settled(card.id, (await w.go(card.id, 'testing')).run.id);
  assert.deepEqual([outcome.status, outcome.code, outcome.next], ['changes_required', 'TESTER_COMMITTED', 'code_review']);
  await assert.rejects(w.go(card.id, 'merge'), { code: 'STAGE_NOT_READY' });
});

test('on a column pipeline the merge route merges only from the Merge column', async t => {
  const { startTestServer } = await import('./helpers/test-server.mjs');
  const app = await startTestServer(t, { port: 0, executor: null });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const project = await app.board.createProject({ name: 'Merge route', workflowMode: 'pipeline' });
  const card = await app.board.createTask({ projectId: project.id, title: 'Not ready', prompt: 'x' });
  const response = await fetch(`${app.url}/api/tasks/${card.id}/merge`, { method: 'POST', headers: { 'X-STE-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true, taskCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40) }) });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'STAGE_MISMATCH');
});

test('Autopilot\'s start check names custom columns whose instruction can never reach the agent', async () => {
  const { pipelineAutopilotGaps } = await import('../src/board.mjs');
  const { normalizePipelineConfig } = await import('../src/pipeline-config.mjs');
  const message = (text, enabled = true) => ({ onEnter: [{ name: 'i', type: 'send_message', mode: 'deferred', enabled, message: text }] });
  const column = (id, automations = {}, strategy = {}) => ({ id, name: id, kind: 'custom', strategy, automations });
  const pipeline = normalizePipelineConfig({ version: 1, columns: [{ id: 'todo', name: 'To Do', role: 'todo', strategy: {}, automations: {} }, column('first'),
    column('slash', message('/compact')), column('pr', message('{{prUrl}}')), column('off', message('Do the thing', false)), column('ok', message('Review {{title}} for typos.')),
    column('plan', message('Plan the change.'), { planExitTargetId: 'afterplan' }), column('afterplan'), { id: 'done', name: 'Done', role: 'done', strategy: {}, automations: {} }] });
  const project = { workflowMode: 'pipeline', pipeline }, route = ['first', 'slash', 'pr', 'off', 'ok', 'plan', 'afterplan'];
  assert.deepEqual(pipelineAutopilotGaps(project, route, [{}], () => 'claude'), ['“slash”', '“pr”', '“off”'], 'a Claude plan approval moves the card on');
  assert.deepEqual(pipelineAutopilotGaps(project, route, [{}], () => 'codex'), ['“slash”', '“pr”', '“off”', '“afterplan”'], 'Codex has no native plan approval to move it');
});

test('a backup whose prerequisites form a loop is refused at import', async () => {
  const { parseBackup } = await import('../src/board.mjs');
  const card = (id, number, dependsOn) => ({ id, number, title: id, prompt: 'x', labelIds: [], column: 'todo', dependsOn, createdAt: 1, updatedAt: 1 });
  const backup = tasks => ({ kind: 'promptboard-backup', version: 10, base: { version: 1, resources: [] }, projects: [{ id: 'p1', name: 'P', nextTaskNumber: 4, labels: [], tasks }] });
  assert.throws(() => parseBackup(backup([card('a', 1, ['c']), card('b', 2, ['a']), card('c', 3, ['b'])])), error => error.code === 'INVALID_BACKUP' && /prerequisites form a loop/.test(error.message));
  for (const dependsOn of [['a'], ['../b'], 'b']) assert.throws(() => parseBackup(backup([card('a', 1, dependsOn)])), error => error.code === 'INVALID_BACKUP' && /prerequisites are not valid/.test(error.message));
  assert.deepEqual(parseBackup(backup([card('a', 1, []), card('b', 2, ['a']), card('c', 3, ['a', 'b'])])).projects[0].tasks.map(task => task.dependsOn), [[], ['a'], ['a', 'b']]);
});

test('a backup made after a prerequisite card was deleted restores, and its dependent still waits for the deleted card', async t => {
  const source = new Board({ dataDir: await temp(t, 'pb-lc-deleted-') });
  const project = await source.createProject({ name: 'Shop', workflowMode: 'pipeline' });
  const [first, second] = await source.createOriginTasks(project.id, { originProjectId: 'origin1', tasks: [
    { originTaskId: 'a', title: 'Schema', prompt: 'Add the schema' }, { originTaskId: 'b', title: 'API', prompt: 'Add the API', dependsOnOrigin: ['a'] }] });
  await source.deleteTask(first.taskId, { expectedRevision: 1 });
  const target = new Board({ dataDir: await temp(t, 'pb-lc-deleted-import-') });
  await target.importBackup(await source.exportBackup());
  const card = (await target.state()).projects[0].tasks.find(task => task.id === second.taskId);
  assert.deepEqual(card.dependsOn, [first.taskId]);
  await assert.rejects(target.transition(card.id, { column: 'executing', expectedRevision: card.revision }), error => error.code === 'PREREQUISITES_PENDING' && /a prerequisite card that was deleted/.test(error.message));
});

test('a prerequisite completed without merging still holds its dependent after a backup round trip', { skip }, async t => {
  const root = await temp(t, 'pb-lc-repo-');
  git(root, 'init', '-q', '-b', 'trunk'); git(root, 'config', 'user.email', 't@example.com'); git(root, 'config', 'user.name', 'Tester'); git(root, 'commit', '-q', '--allow-empty', '-m', 'init');
  const board = new Board({ dataDir: await temp(t, 'pb-lc-data-') });
  const project = await board.createProject({ name: 'Shop', workflowMode: 'pipeline' });
  await board.linkRepository(project.id, { path: root, expectedRevision: project.revision });
  const [plan, code] = (await board.createOriginTasks(project.id, { originProjectId: 'o1', tasks: [{ originTaskId: 'a', title: 'Plan', prompt: 'x' }, { originTaskId: 'b', title: 'Code', prompt: 'y' }] })).map(row => row.taskId);
  await board.ensureTaskWorktree(code); // Its work happened on a task branch.
  for (const id of [plan, code]) await board.transition(id, { column: 'done', expectedRevision: (await board.state()).projects[0].tasks.find(task => task.id === id).revision, decision: 'move' });
  const restore = async backup => { const target = new Board({ dataDir: await temp(t, 'pb-lc-restored-') }); await target.importBackup(backup); return (await target.state()).projects[0]; };
  const backup = await board.exportBackup(), restored = await restore(backup), met = id => prerequisiteMet(restored, restored.tasks.find(task => task.id === id));
  assert.deepEqual([met(plan), met(code)], [true, false], 'a card that never had a worktree has no code; the other one is not merged');
  assert.deepEqual(Object.keys(restored.tasks.find(task => task.id === code).completion).sort(), ['at', 'branch', 'kind', 'taskCommit']);
  // Only a known kind with short details is kept: no summary, run ID, long or nested value.
  const [first, second] = backup.projects[0].tasks;
  first.completion = { kind: 'merged', at: 5, targetBranch: 'trunk', number: 3, squash: true, summary: 'What the agent said', executionRunId: 'run-1', branch: 'b'.repeat(3000), base: { deep: [[[]]] } };
  second.completion = { kind: 'invented', branch: 'task/x' };
  const checked = await restore(backup);
  assert.deepEqual(checked.tasks.map(task => task.completion), [{ kind: 'merged', at: 5, targetBranch: 'trunk', number: 3, squash: true }, undefined]);
  // A backup from before completions were exported restores as it did: a Done card counts.
  for (const task of backup.projects[0].tasks) delete task.completion;
  const older = await restore(backup);
  assert.equal(prerequisiteMet(older, older.tasks.find(task => task.id === code)), true);
});
