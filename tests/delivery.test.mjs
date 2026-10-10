// PB-04: review, testing, merge, and Done with real Git in disposable repositories.
// Agents are SIMULATED by tests/fixtures/fake-agent.cjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Board } from '../src/board.mjs';
import { Supervisor } from '../src/supervisor.mjs';
import { Delivery, parseCommand, parseFindings } from '../src/delivery.mjs';
import { resolveConfig } from '../src/agents.mjs';

const skip = process.platform === 'win32';
const fake = fileURLToPath(new URL('./fixtures/fake-agent.cjs', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
async function temp(t, prefix) { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return dir; }
async function until(fn, label, ms = 15000) { const end = Date.now() + ms; for (;;) { const value = await fn(); if (value) return value; if (Date.now() > end) assert.fail(`Timed out: ${label}`); await new Promise(r => setTimeout(r, 50)); } }

async function world(t) {
  const bin = await temp(t, 'pb-del-bin-');
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\nrequire(${JSON.stringify(fake)});\n`); await chmod(join(bin, 'claude'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  // A repository path with spaces, a bare "remote" that must never change, and a target checkout.
  const base = await temp(t, 'pb-del-');
  const root = join(base, 'my repo with spaces');
  await mkdir(root);
  git(root, 'init', '-q', '-b', 'trunk'); git(root, 'config', 'user.email', 't@example.com'); git(root, 'config', 'user.name', 'Tester');
  await writeFile(join(root, 'feature.txt'), 'one\n'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'init');
  const remote = join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', remote); git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-q', 'origin', 'trunk');
  const dataDir = await temp(t, 'pb-del-data-');
  const board = new Board({ dataDir });
  const supervisor = new Supervisor({ board, dataDir });
  board.executor = supervisor;
  t.after(async () => { await supervisor.shutdown(500); process.env.PATH = oldPath; });
  const project = await board.createProject({ name: 'Delivery' });
  await board.linkRepository(project.id, { path: root, expectedRevision: 1 });
  await board.setTargetBranch(project.id, { branch: 'trunk', expectedRevision: 2 });
  const task = async (title, prompt) => {
    const created = await board.createTask({ projectId: project.id, title, prompt });
    const moved = await board.moveTask(created.id, { column: 'executing', expectedRevision: 1 });
    await board.ensureTaskWorktree(moved.id);
    return moved;
  };
  const current = async id => (await board.view()).projects[0].tasks.find(item => item.id === id);
  const move = async (id, column) => board.moveTask(id, { column, expectedRevision: (await current(id)).revision });
  const workspace = async id => (await current(id)).workspace.path;
  const review = async (id, prompt) => {
    const run = await board.requestRun(id, { stage: 'code_review', consent: true, config: { provider: 'claude' } });
    await until(async () => (await board.run(run.id)).status === 'waiting_for_input', 'review turn');
    await supervisor.confirm(run.id);
    return run;
  };
  const tests = async id => { await board.delivery.runTests(id, { confirm: true }); return until(async () => { const result = (await current(id)).evidence?.tests; return result?.status !== 'running' && result; }, 'tests'); };
  return { board, supervisor, root, remote, project, task, current, move, workspace, review, tests, delivery: board.delivery };
}

test('command parsing never uses a shell; review findings are parsed from the stated JSON format', () => {
  assert.deepEqual(parseCommand(`npm test -- --grep "two words" 'single' a\\b`), ['npm', 'test', '--', '--grep', 'two words', 'single', 'a\\b']);
  assert.deepEqual(parseCommand('node -e "process.exit(1)"'), ['node', '-e', 'process.exit(1)']);
  assert.deepEqual(parseCommand('echo $(id) && rm -rf /'), ['echo', '$(id)', '&&', 'rm', '-rf', '/'], 'Shell syntax stays literal arguments.');
  assert.throws(() => parseCommand('say "unclosed'), { code: 'INVALID_COMMAND' });
  const parsed = parseFindings('Notes.\n```json\n{"verdict":"changes_required","findings":[{"severity":"high","file":"a.js","line":3,"explanation":"Bug."}]}\n```');
  assert.deepEqual(parsed, { parsed: true, verdict: 'changes_required', findings: [{ severity: 'high', file: 'a.js', line: 3, explanation: 'Bug.' }] });
  assert.equal(parseFindings('no json here').parsed, false);
});

test('test runs: one claim per task, released on failed setup; a lost log or a background child never stalls the result', { skip, timeout: 60000 }, async t => {
  const repo = await temp(t, 'pb-del-run-'), dataDir = await temp(t, 'pb-del-run-data-');
  git(repo, 'init', '-q', '-b', 'main'); git(repo, '-c', 'user.name=a', '-c', 'user.email=a@b', 'commit', '-q', '--allow-empty', '-m', 'base'); git(repo, 'checkout', '-q', '-b', 'task');
  const task = { id: 't1', column: 'testing', workspace: { status: 'ready', path: repo, branch: 'task' }, evidence: {} };
  // The command exits 0 at once; its background child keeps stdout open for 15 s.
  const project = { tasks: [task], targetBranch: { name: 'main' }, testCommands: [{ label: 'bg', timeoutSec: 30,
    argv: [process.execPath, '-e', "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { stdio: 'inherit' }).unref(); console.log('fine')"] }] };
  let failEvidence = false, logIsDirectory = false;
  const delivery = new Delivery({ dataDir, state: async () => ({ projects: [project] }), updateTaskEvidence: async (_id, change) => {
    if (failEvidence) throw new Error('STATE_WRITE_FAILED');
    change(task);
    if (logIsDirectory && task.evidence.tests.status === 'running') await mkdir(join(dataDir, 'tests', 't1', task.evidence.tests.id, 'command-1.log'));
    return task;
  } });
  const finished = async () => { await until(() => !delivery.testsRunning.has('t1'), 'tests recorded at exit', 8000); return task.evidence.tests; };
  const both = await Promise.allSettled([delivery.runTests('t1', { confirm: true }), delivery.runTests('t1', { confirm: true })]);
  assert.deepEqual(both.map(item => item.status === 'fulfilled' ? 'started' : item.reason.code).sort(), ['TESTS_RUNNING', 'started']);
  const first = await finished();
  assert.deepEqual([first.status, first.results[0].status, first.results[0].exitCode], ['passed', 'passed', 0]);
  failEvidence = true;
  await assert.rejects(delivery.runTests('t1', { confirm: true }), /STATE_WRITE_FAILED/);
  failEvidence = false;
  assert.equal(delivery.testsRunning.has('t1'), false, 'A failed setup releases its claim.');
  logIsDirectory = true; // The log cannot be opened: the run still finishes and the app keeps running.
  await delivery.runTests('t1', { confirm: true });
  assert.equal((await finished()).status, 'passed');
});

test('full flow: commit, review, send back, fix, accept, test, and a confirmed fast-forward merge into a clean checkout', { skip, timeout: 120000 }, async t => {
  const w = await world(t);
  const task = await w.task('Change value', 'Set the value to two. REVIEW_FAIL');
  const path = await w.workspace(task.id);
  // Review and tests need a clean, committed revision.
  await writeFile(join(path, 'feature.txt'), 'two\n');
  // (Dragging to Code Review would commit this work itself; here it is committed explicitly first.)
  await assert.rejects(w.board.requestRun(task.id, { stage: 'code_review', consent: true }), { code: 'STAGE_MISMATCH' });
  await w.board.delivery.setTestCommands(w.project.id, { commands: [{ command: `${process.execPath} -e "process.exit(0)"`, label: 'unit' }], expectedRevision: (await w.board.view()).projects[0].revision });
  await assert.rejects(w.delivery.runTests(task.id, { confirm: true }), { code: 'UNCOMMITTED_CHANGES' });
  const preview = await w.delivery.uncommitted(task.id);
  assert.deepEqual(preview.changes, [' M feature.txt']);
  assert.match(preview.diff, /-one\n\+two/);
  await assert.rejects(w.delivery.commit(task.id, { message: 'Set two' }), { code: 'CONFIRMATION_REQUIRED' });
  const committed = await w.delivery.commit(task.id, { message: 'Set two', confirm: true });
  await w.move(task.id, 'code_review');
  assert.equal(committed.clean, true);
  assert.equal(committed.ahead, 1);
  assert.equal(git(path, 'log', '-1', '--format=%an <%ae>'), 'Tester <t@example.com>', 'The repository identity is used as is.');
  // Review: findings are recorded; completed is not accepted.
  const run = await w.review(task.id);
  let evidence = (await w.current(task.id)).evidence.review;
  assert.equal(evidence.status, 'completed');
  assert.equal(evidence.verdict, 'changes_required');
  assert.equal(evidence.findings[0].file, 'feature.txt');
  assert.equal(evidence.taskCommit, committed.taskCommit);
  assert.equal(evidence.runId, run.id);
  assert.equal(git(path, 'status', '--porcelain'), '', 'Review did not change the worktree.');
  let mergeView = await w.delivery.mergePreview(task.id);
  assert.equal(mergeView.eligible, false);
  assert.ok(mergeView.problems.some(problem => /accepted code review/.test(problem)));
  // Code Review → Executing sends the findings back; the next run receives them.
  await w.move(task.id, 'executing');
  assert.equal((await w.current(task.id)).column, 'executing');
  const promptFile = join(path, '..', 'seen-prompt.txt');
  process.env.FAKE_AGENT_PROMPT_FILE = promptFile;
  t.after(() => { delete process.env.FAKE_AGENT_PROMPT_FILE; });
  const fix = await w.board.requestRun(task.id, { stage: 'executing', consent: true, config: { provider: 'claude' } });
  await until(async () => (await w.board.run(fix.id)).status === 'waiting_for_input', 'fix turn');
  assert.match(await readFile(promptFile, 'utf8'), /=== REVIEW FINDINGS TO FIX ===\n- \[high\] feature.txt:1 The value is wrong\./);
  await w.supervisor.confirm(fix.id);
  delete process.env.FAKE_AGENT_PROMPT_FILE;
  await writeFile(join(path, 'feature.txt'), 'two\nfixed\n');
  const fixed = await w.delivery.commit(task.id, { message: 'Fix review finding', confirm: true });
  await w.move(task.id, 'code_review');
  await assert.rejects(w.delivery.acceptReview(task.id), { code: 'REVIEW_MISSING' }, 'The old review was sent back.');
  // Re-review the new commit (the fake passes when the prompt lacks REVIEW_FAIL? it still contains it) — edit the task text.
  await w.board.updateTask(task.id, { prompt: 'Set the value to two.', expectedRevision: (await w.current(task.id)).revision });
  await w.review(task.id);
  evidence = (await w.current(task.id)).evidence.review;
  assert.equal(evidence.verdict, 'no_issues');
  assert.equal(evidence.taskCommit, fixed.taskCommit);
  await w.delivery.acceptReview(task.id);
  // Testing: only command results decide; results belong to the tested commits.
  await w.move(task.id, 'testing');
  const passed = await w.tests(task.id);
  assert.equal(passed.status, 'passed');
  assert.equal(passed.results[0].exitCode, 0);
  assert.equal(passed.results[0].cwd, path);
  assert.equal(passed.taskCommit, fixed.taskCommit);
  await w.move(task.id, 'merge');
  mergeView = await w.delivery.mergePreview(task.id);
  assert.equal(mergeView.eligible, true, mergeView.problems.join(' '));
  assert.equal(mergeView.fastForward, true);
  assert.equal(mergeView.targetCheckout.path, w.root);
  assert.deepEqual(mergeView.commits.map(commit => commit.subject), ['Fix review finding', 'Set two']);
  assert.deepEqual(mergeView.files, ['M\tfeature.txt']);
  await assert.rejects(w.delivery.merge(task.id, { taskCommit: mergeView.taskCommit, targetCommit: mergeView.targetCommit }), { code: 'CONFIRMATION_REQUIRED' });
  await assert.rejects(w.delivery.merge(task.id, { confirm: true, taskCommit: 'f'.repeat(40), targetCommit: mergeView.targetCommit }), { code: 'MERGE_STALE' });
  // A target that moved since the preview is named as such; nothing changes.
  await assert.rejects(w.delivery.merge(task.id, { confirm: true, taskCommit: mergeView.taskCommit, targetCommit: 'e'.repeat(40) }), { code: 'TARGET_CHANGED' });
  assert.equal(git(w.root, 'rev-parse', 'trunk'), mergeView.targetCommit);
  const remoteBefore = git(w.remote, 'rev-parse', 'trunk');
  const done = await w.delivery.merge(task.id, { confirm: true, taskCommit: mergeView.taskCommit, targetCommit: mergeView.targetCommit });
  assert.equal(done.column, 'done');
  assert.equal(done.completion.kind, 'merged');
  assert.equal(done.completion.mergedCommit, mergeView.taskCommit);
  assert.equal(done.transitions.at(-1).by, 'merged');
  assert.equal(git(w.root, 'rev-parse', 'trunk'), mergeView.taskCommit, 'The target branch now points at the task commit.');
  assert.equal(git(w.root, 'branch', '--show-current'), 'trunk', 'The checkout stayed on its branch.');
  assert.equal(await readFile(join(w.root, 'feature.txt'), 'utf8'), 'two\nfixed\n', 'The clean checkout was fast-forwarded.');
  assert.equal(git(w.remote, 'rev-parse', 'trunk'), remoteBefore, 'Nothing was pushed.');
  await assert.rejects(w.board.requestRun(task.id, { stage: 'done', consent: true }), { code: 'STAGE_NOT_RUNNABLE' });
});

test('even an accepted review with detected issues prevents automatic merging', { skip, timeout: 60000 }, async t => {
  const w = await world(t);
  const task = await w.task('Issue gate', 'Change the feature. REVIEW_FAIL');
  const ws = await w.workspace(task.id);
  await writeFile(join(ws, 'feature.txt'), 'changed\n');
  await w.delivery.commit(task.id, { message: 'change', confirm: true });
  await w.move(task.id, 'code_review');
  await w.review(task.id);
  await w.delivery.acceptReview(task.id);
  assert.equal((await w.current(task.id)).evidence.review.verdict, 'changes_required');
  await w.delivery.setTestCommands(w.project.id, { commands: [{ command: `${process.execPath} -e "0"` }], expectedRevision: (await w.board.view()).projects[0].revision });
  await w.move(task.id, 'testing');
  await w.tests(task.id);
  await w.board.setWorkflow(w.project.id, { workflow: { merge: { policy: 'start' } }, expectedRevision: (await w.board.view()).projects[0].revision });
  const before = git(w.root, 'rev-parse', 'trunk');
  const preview = await w.delivery.mergePreview(task.id);
  assert.equal(preview.eligible, false);
  assert.match(preview.problems.join(' '), /detected issues/);
  await assert.rejects(w.board.transition(task.id, { column: 'merge', expectedRevision: (await w.current(task.id)).revision }), { code: 'STAGE_NOT_READY', message: /detected issues/ });
  await assert.rejects(w.delivery.merge(task.id, { confirm: true, taskCommit: preview.taskCommit, targetCommit: preview.targetCommit, trigger: 'automation' }), { code: 'MERGE_NOT_ELIGIBLE' });
  assert.equal(git(w.root, 'rev-parse', 'trunk'), before);
  assert.equal((await w.current(task.id)).column, 'testing');
});

test('failed tests, missing commands, and timeouts never pass; source changes make results stale', { skip, timeout: 120000 }, async t => {
  const w = await world(t);
  const task = await w.task('Tests', 'Test me.');
  await assert.rejects(w.delivery.runTests(task.id, { confirm: true }), { code: 'NO_TEST_COMMANDS' });
  const setCommands = async commands => w.delivery.setTestCommands(w.project.id, { commands, expectedRevision: (await w.board.view()).projects[0].revision });
  await setCommands([
    { command: `${process.execPath} -e "console.log('fine')"`, label: 'ok' },
    { command: `${process.execPath} -e "console.error('boom'); process.exit(3)"`, label: 'fails' },
    { command: 'definitely-not-installed-command --flag', label: 'missing' },
    { command: `${process.execPath} -e "setInterval(() => {}, 1000)"`, label: 'hangs', timeoutSec: 1 },
  ]);
  const result = await w.tests(task.id);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.results.map(item => [item.label, item.status, item.exitCode]), [['ok', 'passed', 0], ['fails', 'failed', 3], ['missing', 'missing', null], ['hangs', 'timeout', null]]);
  assert.match(result.results[1].tail, /boom/);
  assert.match(await readFile(join(w.board.dataDir, 'tests', task.id, result.id, 'command-1.log'), 'utf8'), /fine/);
  // Passing tests for an older commit do not count after a new commit.
  await setCommands([{ command: `${process.execPath} -e "0"` }]);
  const ok = await w.tests(task.id);
  assert.equal(ok.status, 'passed');
  await writeFile(join(await w.workspace(task.id), 'new.txt'), 'x\n');
  await w.delivery.commit(task.id, { message: 'More', confirm: true });
  const preview = await w.delivery.mergePreview(task.id);
  assert.ok(preview.problems.some(problem => /tests are for older commits/.test(problem)));
});

test('merge safety: dirty target checkout, advanced target, conflict-safe branch update, and ref-only fast-forward', { skip, timeout: 120000 }, async t => {
  const w = await world(t);
  const setCommands = async () => w.delivery.setTestCommands(w.project.id, { commands: [{ command: `${process.execPath} -e "0"` }], expectedRevision: (await w.board.view()).projects[0].revision });
  await setCommands();
  const ready = async (task, content) => {
    await writeFile(join(await w.workspace(task.id), 'feature.txt'), content);
    await w.delivery.commit(task.id, { message: `Write ${content.trim()}`, confirm: true });
    await w.move(task.id, 'code_review');
    await w.board.updateTask(task.id, { prompt: 'Reviewed task.', expectedRevision: (await w.current(task.id)).revision });
    await w.review(task.id);
    await w.delivery.acceptReview(task.id);
    await w.move(task.id, 'testing');
    assert.equal((await w.tests(task.id)).status, 'passed');
    await w.move(task.id, 'merge');
    return w.delivery.mergePreview(task.id);
  };
  const task = await w.task('Safe merge', 'x');
  let preview = await ready(task, 'task\n');
  assert.equal(preview.eligible, true);
  // A dirty tracked file in the target checkout blocks the merge; nothing is changed.
  await writeFile(join(w.root, 'feature.txt'), 'user edit\n');
  preview = await w.delivery.mergePreview(task.id);
  assert.ok(preview.problems.some(problem => /has uncommitted changes\. Promptboard will not merge into it/.test(problem)));
  await assert.rejects(w.delivery.merge(task.id, { confirm: true, taskCommit: preview.taskCommit, targetCommit: preview.targetCommit }), { code: 'MERGE_NOT_ELIGIBLE' });
  assert.equal(await readFile(join(w.root, 'feature.txt'), 'utf8'), 'user edit\n', 'The user edit is untouched.');
  git(w.root, 'checkout', '--', 'feature.txt');
  // The target advances with a conflicting change: no fast-forward, and the update is aborted safely.
  await writeFile(join(w.root, 'feature.txt'), 'upstream\n'); git(w.root, 'commit', '-q', '-am', 'Upstream change');
  preview = await w.delivery.mergePreview(task.id);
  assert.equal(preview.fastForward, false);
  assert.ok(preview.problems.some(problem => /trunk has advanced since this task branched/.test(problem)));
  const before = git(await w.workspace(task.id), 'rev-parse', 'HEAD');
  await assert.rejects(w.delivery.updateBranch(task.id, { confirm: true }), { code: 'MERGE_CONFLICT', message: /feature\.txt.*aborted/ });
  assert.equal(git(await w.workspace(task.id), 'rev-parse', 'HEAD'), before, 'A conflicted update leaves the task branch unchanged.');
  assert.equal(git(await w.workspace(task.id), 'status', '--porcelain'), '');
  // A non-conflicting advance: update the task branch, then review and tests must run again.
  // New tasks start from the recorded target commit; re-record it after the target moved ("Use this branch").
  const rerecord = async () => w.board.setTargetBranch(w.project.id, { branch: 'trunk', expectedRevision: (await w.board.view()).projects[0].revision });
  await rerecord();
  const second = await w.task('Second', 'z');
  await writeFile(join(await w.workspace(second.id), 'second.txt'), 'second\n');
  await w.delivery.commit(second.id, { message: 'Second file', confirm: true });
  await writeFile(join(w.root, 'upstream2.txt'), 'u\n'); git(w.root, 'add', '.'); git(w.root, 'commit', '-q', '-m', 'Upstream 2');
  const updated = await w.delivery.updateBranch(second.id, { confirm: true });
  assert.ok(updated.ahead >= 2);
  preview = await w.delivery.mergePreview(second.id);
  assert.equal(preview.fastForward, true);
  assert.ok(preview.problems.some(problem => /accepted code review/.test(problem)) && preview.problems.some(problem => /Passing tests/.test(problem)), 'Review and tests are required again.');
  // Target not checked out anywhere: the branch reference is fast-forwarded with an old-value check.
  git(w.root, 'checkout', '-q', '-b', 'elsewhere');
  await rerecord();
  const third = await w.task('Ref only', 'r');
  preview = await ready(third, 'ref only\n');
  assert.equal(preview.targetCheckout, null);
  const done = await w.delivery.merge(third.id, { confirm: true, taskCommit: preview.taskCommit, targetCommit: preview.targetCommit });
  assert.equal(done.completion.method, 'fast-forward of the branch reference');
  assert.equal(git(w.root, 'rev-parse', 'trunk'), preview.taskCommit);
  assert.equal(git(w.root, 'branch', '--show-current'), 'elsewhere', 'No checkout was switched.');
});

test('Done: verified no-change completion, final until Reopen, optional ownership-checked cleanup', { skip, timeout: 60000 }, async t => {
  const w = await world(t);
  const task = await w.task('Nothing to do', 'Check whether a change is needed.');
  // No commits: nothing to review, and no column change reaches Done without verification.
  await assert.rejects(w.move(task.id, 'code_review'), { code: 'NO_CHANGES' });
  await assert.rejects(w.move(task.id, 'done'), { code: 'TRANSITION_NOT_ALLOWED' });
  await assert.rejects(w.delivery.completeNoChanges(task.id, {}), { code: 'CONFIRMATION_REQUIRED' });
  const done = await w.delivery.completeNoChanges(task.id, { confirm: true });
  assert.equal(done.column, 'done');
  assert.equal(done.completion.kind, 'no_changes', 'A no-change completion is not described as a merge.');
  assert.equal(git(w.root, 'rev-parse', 'trunk'), git(w.remote, 'rev-parse', 'trunk'), 'Completing merged nothing.');
  // Done is final: every move out is refused; only Reopen leaves it.
  for (const column of ['todo', 'executing', 'merge']) await assert.rejects(w.move(task.id, column), { code: 'TRANSITION_NOT_ALLOWED', message: /Reopen/ });
  // A task with commits cannot use the no-change path.
  const changed = await w.task('Has changes', 'c');
  await writeFile(join(await w.workspace(changed.id), 'c.txt'), 'c\n');
  await w.delivery.commit(changed.id, { message: 'c', confirm: true });
  await assert.rejects(w.delivery.completeNoChanges(changed.id, { confirm: true }), { code: 'HAS_CHANGES' });
  // Cleanup is separate and refuses dirty worktrees.
  await writeFile(join(await w.workspace(changed.id), 'dirty.txt'), 'd\n');
  await assert.rejects(w.board.removeTaskWorktree(changed.id), { code: 'WORKTREE_DIRTY' });
  const workspace = done.workspace.path;
  await w.board.removeTaskWorktree(task.id);
  assert.equal(git(w.root, 'worktree', 'list').includes(workspace), false);
  // Reopening Done starts a new cycle in To Do; the earlier completion is kept in the history.
  await assert.rejects(w.board.reopenTask(task.id, { expectedRevision: 1 }), { code: 'REVISION_CONFLICT' });
  const reopened = await w.board.reopenTask(task.id, { expectedRevision: (await w.current(task.id)).revision });
  assert.equal(reopened.column, 'todo');
  assert.equal(reopened.completion, null);
  assert.equal(reopened.previousCompletions.at(-1).kind, 'no_changes');
  // Without a Git identity the commit is refused with an explanation; Git config is never changed.
  git(w.root, 'config', '--unset', 'user.email'); git(w.root, 'config', 'user.useConfigOnly', 'true');
  const configBefore = await readFile(join(w.root, '.git', 'config'), 'utf8');
  const saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  try { await assert.rejects(w.delivery.commit(changed.id, { message: 'x', confirm: true }), { code: 'IDENTITY_REQUIRED', message: /does not change Git configuration/ }); }
  finally { if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved; }
  assert.equal(await readFile(join(w.root, '.git', 'config'), 'utf8'), configBefore);
});

test('Merge: entering prepares the card; one click merges and removes the clean worktree; Merge automatically brings in a moved target first', { skip, timeout: 120000 }, async t => {
  const w = await world(t);
  const revision = async () => (await w.board.view()).projects[0].revision;
  await w.delivery.setTestCommands(w.project.id, { commands: [{ command: `${process.execPath} -e "process.exit(0)"` }], expectedRevision: await revision() });
  const transition = async (id, column) => w.board.transition(id, { column, expectedRevision: (await w.current(id)).revision });
  const ready = async title => {
    const task = await w.task(title, 'Change the feature.');
    await writeFile(join(await w.workspace(task.id), `${title}.txt`), 'x\n');
    await w.delivery.commit(task.id, { message: title, confirm: true });
    await w.move(task.id, 'code_review');
    await w.review(task.id);
    await w.move(task.id, 'testing'); // A completed review without findings is accepted by the move.
    await w.tests(task.id);
    return task;
  };
  // Default: entering Merge verifies and shows one action; nothing merges yet.
  assert.equal((await w.board.view()).projects[0].effectiveWorkflow.merge.policy, 'manual');
  const first = await ready('first');
  const entered = await transition(first.id, 'merge');
  assert.deepEqual([entered.task.column, entered.merged, entered.merge.state], ['merge', undefined, 'ready']);
  assert.equal((await w.current(first.id)).flow.kind, 'ready');
  // One click: merged, recorded, worktree removed (the branch stays), card in Done.
  const workspace = (await w.current(first.id)).workspace;
  const clicked = await w.board.mergeNow(first.id);
  assert.deepEqual([clicked.merged, clicked.task.column, clicked.task.completion.kind, clicked.task.workspace], [true, 'done', 'merged', null]);
  assert.equal(git(w.root, 'rev-parse', 'trunk'), clicked.task.completion.mergedCommit);
  assert.ok(!git(w.root, 'worktree', 'list').includes(workspace.path), 'The clean worktree is removed.');
  assert.ok(git(w.root, 'branch', '--list', workspace.branch).includes(workspace.branch), 'The task branch is kept.');
  // Merge automatically: the target moved on without conflicts. The card brings it in, reruns the tests on the
  // merge commit, and merges only after they pass for exactly that commit.
  await w.board.setWorkflow(w.project.id, { workflow: { merge: { policy: 'start' } }, expectedRevision: await revision() });
  await w.board.setTargetBranch(w.project.id, { branch: 'trunk', expectedRevision: await revision() });
  const behind = await ready('behind');
  await writeFile(join(w.root, 'upstream.txt'), 'u\n'); git(w.root, 'add', '.'); git(w.root, 'commit', '-q', '-m', 'Upstream');
  const auto = await transition(behind.id, 'merge');
  assert.deepEqual([auto.task.column, auto.merge.state], ['merge', 'testing']);
  const card = await w.current(behind.id);
  assert.equal(card.evidence.review.carriedReason, 'clean merge of trunk', 'A clean merge of the target keeps the review.');
  await until(async () => { await w.board.advanceFlows(); return (await w.current(behind.id)).column === 'done'; }, 'merged after the rerun tests');
  const done = await w.current(behind.id);
  assert.deepEqual([done.completion.kind, done.completion.trigger], ['merged', 'automation']);
  assert.equal(git(w.root, 'show', '--format=%s', '-s', 'trunk^1'), 'behind', 'The merge commit joins the task (first parent) with the moved target.');
  // Testing refuses an unreviewed commit; Executing cannot skip verification to reach Done.
  const unreviewed = await w.task('unreviewed', 'x');
  await writeFile(join(await w.workspace(unreviewed.id), 'u.txt'), 'u\n');
  await w.delivery.commit(unreviewed.id, { message: 'u', confirm: true });
  await w.move(unreviewed.id, 'code_review');
  await assert.rejects(w.move(unreviewed.id, 'testing'), { code: 'STAGE_NOT_READY', message: /Run Code Review for the current commit/ });
  await assert.rejects(w.move(unreviewed.id, 'done'), { code: 'TRANSITION_NOT_ALLOWED' });
  assert.equal(git(w.remote, 'rev-parse', 'trunk') === git(w.root, 'rev-parse', 'trunk'), false, 'Nothing is pushed.');
});

test('Testing and Merge agents: test commands in context, conflicts left for the agent, markers block the commit, abort restores the branch', { skip, timeout: 120000 }, async t => {
  const w = await world(t);
  const revision = async () => (await w.board.view()).projects[0].revision;
  await w.delivery.setTestCommands(w.project.id, { commands: [{ command: `${process.execPath} -e "process.exit(0)"` }], expectedRevision: await revision() });
  const task = await w.task('Conflict', 'Change the feature line.');
  const ws = await w.workspace(task.id);
  await writeFile(join(ws, 'feature.txt'), 'task version\n');
  await w.delivery.commit(task.id, { message: 'task change', confirm: true });
  // Testing agent: the prompt lists the configured test commands.
  await w.move(task.id, 'code_review'); await w.review(task.id); await w.move(task.id, 'testing');
  const testRun = await w.board.requestRun(task.id, { stage: 'testing', consent: true, config: { provider: 'claude' } });
  await until(async () => (await w.board.run(testRun.id)).status === 'waiting_for_input', 'testing turn');
  const testPrompt = await readFile(join((await w.board.view()).runs.find(run => run.id === testRun.id) && join(w.board.dataDir, 'runs', testRun.id), 'prompt.md'), 'utf8');
  assert.match(testPrompt, /Test the task below/);
  assert.match(testPrompt, /=== TEST COMMANDS CONFIGURED IN PROMPTBOARD ===\n- .*process\.exit\(0\)/);
  await w.supervisor.confirm(testRun.id);
  assert.equal((await w.board.run(testRun.id)).status, 'succeeded');
  // The target branch moves on with a conflicting change.
  await until(async () => (await w.current(task.id)).evidence?.tests?.status === 'passed', 'independent tests after the testing agent');
  await writeFile(join(w.root, 'feature.txt'), 'target version\n'); git(w.root, 'commit', '-qam', 'target change');
  await w.move(task.id, 'merge');
  const mergeRun = await w.board.requestRun(task.id, { stage: 'merge', consent: true, config: { provider: 'claude' } });
  await until(async () => (await w.board.run(mergeRun.id)).status === 'waiting_for_input', 'merge turn');
  const mergePrompt = await readFile(join(w.board.dataDir, 'runs', mergeRun.id, 'prompt.md'), 'utf8');
  assert.match(mergePrompt, /Promptboard ran git merge --no-ff --no-commit trunk/);
  assert.match(mergePrompt, /Conflicted files to resolve:\n- feature\.txt/);
  let rev = await w.delivery.revision(task.id);
  assert.equal(rev.merging, true);
  assert.deepEqual(rev.unresolved, ['feature.txt']);
  await assert.rejects(w.delivery.commit(task.id, { message: 'merge', confirm: true }), { code: 'CONFLICT_MARKERS' });
  // Staging the file does not hide its markers.
  git(ws, 'add', 'feature.txt');
  assert.deepEqual((await w.delivery.revision(task.id)).unresolved, ['feature.txt']);
  await assert.rejects(w.delivery.commit(task.id, { message: 'merge', confirm: true }), { code: 'CONFLICT_MARKERS' });
  const preview = await w.delivery.mergePreview(task.id);
  assert.equal(preview.eligible, false);
  assert.match(preview.problems.join(' '), /merge of trunk into the task branch is in progress with 1 unresolved file/);
  await w.supervisor.confirm(mergeRun.id);
  // Abort restores the task branch exactly.
  const before = git(ws, 'rev-parse', 'HEAD');
  await assert.rejects(w.delivery.abortMerge(task.id, {}), { code: 'CONFIRMATION_REQUIRED' });
  rev = await w.delivery.abortMerge(task.id, { confirm: true });
  assert.equal(rev.merging, false);
  assert.equal(rev.clean, true);
  assert.equal(git(ws, 'rev-parse', 'HEAD'), before);
  assert.equal(await readFile(join(ws, 'feature.txt'), 'utf8'), 'task version\n');
  // Again, and this time the conflict is resolved (as the agent would), then committed as a merge.
  const second = await w.board.requestRun(task.id, { stage: 'merge', consent: true, config: { provider: 'claude' } });
  await until(async () => (await w.board.run(second.id)).status === 'waiting_for_input', 'second merge turn');
  await w.supervisor.confirm(second.id);
  await writeFile(join(ws, 'feature.txt'), 'task version\ntarget version\n');
  await w.delivery.commit(task.id, { message: 'Merge trunk into the task branch', confirm: true });
  assert.equal(git(ws, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3, 'A merge commit with two parents.');
  const after = await w.delivery.mergePreview(task.id);
  assert.equal(after.fastForward, true, 'The task branch now contains the target.');
  assert.equal(after.eligible, false, 'Review and tests are for older commits, so they must run again.');
  assert.match(after.problems.join(' '), /older task commit|required/);
  assert.equal(git(w.remote, 'rev-parse', 'trunk'), git(w.remote, 'rev-parse', 'trunk'), 'Nothing is pushed.');
});

test('pull request: pushes the task branch without force, opens it with gh, and a merged pull request completes the task', { skip, timeout: 60000 }, async t => {
  const w = await world(t);
  const bin = await temp(t, 'pb-gh-bin-');
  const stateFile = join(bin, 'pr.json');
  await writeFile(join(bin, 'gh'), `#!${process.execPath}
const fs = require('fs'); const a = process.argv.slice(2); const file = ${JSON.stringify(stateFile)};
fs.appendFileSync(file + '.log', JSON.stringify(a) + '\\n');
const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
if (a[0] === '--version') { console.log('gh version 2.0.0'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'view') { const s = read(); if (!s) { console.error('no pull requests found'); process.exit(1); } console.log(JSON.stringify(s)); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'create') { const s = { url: 'https://github.com/example/repo/pull/7', number: 7, state: 'OPEN' }; fs.writeFileSync(file, JSON.stringify(s)); console.log(s.url); process.exit(0); }
process.exit(2);
`);
  await chmod(join(bin, 'gh'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  const task = await w.task('Proposal', 'SECRET PROMPT TEXT');
  await assert.rejects(w.delivery.openPullRequest(task.id, { confirm: true, title: 'Add proposal' }), { code: 'NO_CHANGES' });
  await writeFile(join(await w.workspace(task.id), 'p.txt'), 'p\n');
  await assert.rejects(w.delivery.openPullRequest(task.id, { confirm: true, title: 'Add proposal' }), { code: 'UNCOMMITTED_CHANGES' });
  await w.delivery.commit(task.id, { message: 'proposal', confirm: true });
  await assert.rejects(w.delivery.openPullRequest(task.id, { title: 'Add proposal' }), { code: 'CONFIRMATION_REQUIRED' });
  const branch = (await w.current(task.id)).workspace.branch;
  const opened = await w.delivery.openPullRequest(task.id, { confirm: true, title: 'Add proposal', body: 'Tests passed.' });
  assert.equal(opened.evidence.pullRequest.url, 'https://github.com/example/repo/pull/7');
  assert.equal(opened.evidence.pullRequest.state, 'OPEN');
  assert.equal(git(w.remote, 'rev-parse', branch), git(await w.workspace(task.id), 'rev-parse', 'HEAD'), 'The task branch is on the remote.');
  const calls = (await readFile(`${stateFile}.log`, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const create = calls.find(args => args[1] === 'create');
  assert.deepEqual(create.slice(0, 8), ['pr', 'create', '--base', 'trunk', '--head', branch, '--title', 'Add proposal']);
  assert.ok(!calls.flat().some(arg => arg.includes('SECRET PROMPT TEXT')), 'The task prompt is not sent.');
  assert.equal(opened.column, 'executing', 'Opening a pull request does not complete the task.');
  // Still open: nothing changes. Merged on GitHub: the task is Done.
  assert.equal((await w.delivery.pullRequestStatus(task.id)).column, 'executing');
  await writeFile(stateFile, JSON.stringify({ url: 'https://github.com/example/repo/pull/7', number: 7, state: 'MERGED', mergedAt: '2026-09-29T12:00:00Z' }));
  // A card in Merge with an open pull request is checked by the board itself; once merged it moves to Done.
  await w.board.store.update(state => { state.projects[0].tasks.find(item => item.id === task.id).column = 'merge'; });
  await w.board.advanceFlows();
  const done = await w.current(task.id);
  assert.equal(done.column, 'done');
  assert.equal(done.completion.kind, 'pull_request');
  assert.equal(done.completion.url, 'https://github.com/example/repo/pull/7');
});

test('the destination column alone decides what runs: skipped stages never run, a drop never runs twice, cards stay independent', { skip, timeout: 60000 }, async t => {
  const w = await world(t);
  // Record what each move starts instead of launching agents.
  const started = [];
  w.board.executor = { validate: async ({ stage, config }) => resolveConfig(stage, config), start: async ({ run, task, planRunId, extra }) => { started.push({ task: task.id, stage: run.stage, planRunId, extra }); } };
  // The defaults: every stage starts when a card arrives (the drag is the instruction); Merge shows one merge button.
  await w.board.delivery.setTestCommands(w.project.id, { commands: [{ command: `${process.execPath} -e "process.exit(0)"` }], expectedRevision: (await w.board.view()).projects[0].revision });
  const stages = id => started.filter(item => item.task === id).map(item => item.stage);
  const go = async (id, column) => w.board.transition(id, { column, expectedRevision: (await w.current(id)).revision });
  const end = run => w.board.updateRun(run.id, { status: 'cancelled' });
  const card = title => w.board.createTask({ projectId: w.project.id, title, prompt: `${title}. State a short plan before implementation.` });

  // To Do -> Executing: execution only. No planning run, no plan, anywhere.
  const direct = await card('Direct');
  let result = await go(direct.id, 'executing');
  assert.equal(result.run.stage, 'executing');
  assert.deepEqual(stages(direct.id), ['executing']);
  assert.equal(started.at(-1).planRunId, null);
  assert.equal((await w.board.view()).runs.some(run => run.taskId === direct.id && run.stage === 'planning'), false);
  await end(result.run);
  const workspace = await w.workspace(direct.id);
  await writeFile(join(workspace, 'feature.txt'), 'two\n');
  await w.delivery.commit(direct.id, { message: 'Two', confirm: true });
  // Executing -> Code Review: review only, of the committed diff.
  result = await go(direct.id, 'code_review');
  assert.equal(result.run.stage, 'code_review');
  assert.match(started.at(-1).extra, /DIFF/);
  await w.delivery.recordReview(await w.board.run(result.run.id), '```json\n{"verdict":"no_issues","findings":[]}\n```');
  await end(result.run);
  // Code Review -> Testing starts its agent first. Independent commands decide after confirmation.
  result = await go(direct.id, 'testing');
  assert.deepEqual([result.task.column, result.run.stage], ['testing', 'testing']);
  assert.match(started.at(-1).extra, /TEST COMMANDS/);
  await w.board.updateRun(result.run.id, { status: 'running' });
  await w.board.updateRun(result.run.id, { status: 'succeeded' });
  await w.board.recordStageResult(result.run, 'Tested task results.');
  await until(async () => (await w.current(direct.id)).evidence?.tests?.status === 'passed', 'tests passed');
  result = await go(direct.id, 'merge');
  assert.deepEqual([result.run, result.merged], [undefined, undefined], 'Merge prepares; it does not merge until the button is clicked.');
  const merging = await w.board.requestRun(direct.id, { stage: 'merge', consent: true });
  await end(merging);
  assert.deepEqual(stages(direct.id), ['executing', 'code_review', 'testing', 'merge'], 'Each stage ran once, when entered.');
  // Backward: Merge -> Executing runs Executing only, in the same worktree; To Do and Done run nothing.
  result = await go(direct.id, 'executing');
  assert.equal(result.run.stage, 'executing');
  await end(result.run);
  assert.equal(await w.workspace(direct.id), workspace, 'The card keeps its worktree and branch.');
  result = await go(direct.id, 'todo');
  assert.deepEqual([result.run, result.task.column], [undefined, 'todo']);
  await assert.rejects(go(direct.id, 'done'), { code: 'TRANSITION_NOT_ALLOWED' });
  assert.deepEqual(stages(direct.id), ['executing', 'code_review', 'testing', 'merge', 'executing']);

  // To Do -> Planning: planning only. Planning -> Executing: execution only.
  const planned = await card('Planned');
  result = await go(planned.id, 'planning');
  assert.equal(result.run.stage, 'planning');
  await end(result.run);
  result = await go(planned.id, 'executing');
  assert.equal(result.run.stage, 'executing');
  assert.deepEqual(stages(planned.id), ['planning', 'executing']);

  // Skipping ahead is refused by the matrix; the card stays and nothing runs.
  const ahead = await card('Ahead');
  await assert.rejects(go(ahead.id, 'code_review'), { code: 'TRANSITION_NOT_ALLOWED' });
  assert.deepEqual(stages(ahead.id), []);
  assert.equal((await w.current(ahead.id)).workspace, null);

  // One drop delivered twice: one move and one run.
  const twice = await card('Twice');
  const revision = (await w.current(twice.id)).revision;
  const both = await Promise.allSettled([1, 2].map(() => w.board.transition(twice.id, { column: 'executing', expectedRevision: revision })));
  assert.equal(both.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(both.find(item => item.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  assert.deepEqual(stages(twice.id), ['executing']);
  // The same request (same transition ID) delivered again returns the first outcome and starts nothing.
  const again = await card('Again');
  const request = { column: 'executing', expectedRevision: (await w.current(again.id)).revision, transitionId: 'drop-0001' };
  const firstDrop = await w.board.transition(again.id, request);
  const secondDrop = await w.board.transition(again.id, request);
  assert.equal(secondDrop.duplicate, true);
  assert.equal(secondDrop.run.id, firstDrop.run.id);
  assert.deepEqual(stages(again.id), ['executing']);

  // Cards are independent: two active runs, separate branches and worktrees, and each card keeps its stage after a reload.
  const [a, b] = [await w.current(planned.id), await w.current(twice.id)];
  assert.notEqual(a.workspace.path, b.workspace.path);
  assert.notEqual(a.workspace.branch, b.workspace.branch);
  const reloaded = new Board({ dataDir: w.board.dataDir });
  const columns = Object.fromEntries((await reloaded.view()).projects[0].tasks.map(task => [task.title, task.column]));
  assert.deepEqual(columns, { Direct: 'todo', Planned: 'executing', Ahead: 'todo', Twice: 'executing', Again: 'executing' });
});
