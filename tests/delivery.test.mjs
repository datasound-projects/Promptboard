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
import { parseCommand, parseFindings } from '../src/delivery.mjs';

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

test('full flow: commit, review, send back, fix, accept, test, and a confirmed fast-forward merge into a clean checkout', { skip, timeout: 120000 }, async t => {
  const w = await world(t);
  const task = await w.task('Change value', 'Set the value to two. REVIEW_FAIL');
  const path = await w.workspace(task.id);
  // Review and tests need a clean, committed revision.
  await writeFile(join(path, 'feature.txt'), 'two\n');
  await w.move(task.id, 'code_review');
  await assert.rejects(w.board.requestRun(task.id, { stage: 'code_review', consent: true }), { code: 'UNCOMMITTED_CHANGES' });
  await w.board.delivery.setTestCommands(w.project.id, { commands: [{ command: `${process.execPath} -e "process.exit(0)"`, label: 'unit' }], expectedRevision: (await w.board.view()).projects[0].revision });
  await assert.rejects(w.delivery.runTests(task.id, { confirm: true }), { code: 'UNCOMMITTED_CHANGES' });
  const preview = await w.delivery.uncommitted(task.id);
  assert.deepEqual(preview.changes, [' M feature.txt']);
  assert.match(preview.diff, /-one\n\+two/);
  await assert.rejects(w.delivery.commit(task.id, { message: 'Set two' }), { code: 'CONFIRMATION_REQUIRED' });
  const committed = await w.delivery.commit(task.id, { message: 'Set two', confirm: true });
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
  // Send the findings back to Executing; the next run receives them.
  await w.delivery.sendBack(task.id, {});
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
  // Done cannot be reached by moving the card.
  await assert.rejects(w.move(task.id, 'done'), { code: 'DONE_REQUIRES_MERGE' });
  await assert.rejects(w.delivery.merge(task.id, { taskCommit: mergeView.taskCommit, targetCommit: mergeView.targetCommit }), { code: 'CONFIRMATION_REQUIRED' });
  await assert.rejects(w.delivery.merge(task.id, { confirm: true, taskCommit: 'f'.repeat(40), targetCommit: mergeView.targetCommit }), { code: 'MERGE_STALE' });
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
  assert.match(await w.delivery.testLog(task.id, 0), /fine/);
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

test('Done: only a merge or an explicit no-change completion; cleanup is optional and ownership-checked', { skip, timeout: 60000 }, async t => {
  const w = await world(t);
  const task = await w.task('Nothing to do', 'Check whether a change is needed.');
  await w.move(task.id, 'code_review');
  await assert.rejects(w.move(task.id, 'done'), { code: 'TRANSITION_NOT_ALLOWED' });
  await w.move(task.id, 'testing'); await w.move(task.id, 'merge');
  await assert.rejects(w.move(task.id, 'done'), { code: 'DONE_REQUIRES_MERGE' });
  await assert.rejects(w.delivery.completeNoChanges(task.id, {}), { code: 'CONFIRMATION_REQUIRED' });
  const done = await w.delivery.completeNoChanges(task.id, { confirm: true });
  assert.equal(done.column, 'done');
  assert.equal(done.completion.kind, 'no_changes', 'A no-change completion is not described as a merge.');
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
  // Reopening Done clears the completion, so reaching Done again needs a new merge or confirmation.
  const reopened = await w.move(task.id, 'todo');
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

test('automatic merge: only when the project turns it on and every check holds for the current commits', { skip, timeout: 120000 }, async t => {
  const w = await world(t);
  const revision = async () => (await w.board.view()).projects[0].revision;
  await w.delivery.setTestCommands(w.project.id, { commands: [{ command: `${process.execPath} -e "process.exit(0)"` }], expectedRevision: await revision() });
  const transition = async (id, column) => w.board.transition(id, { column, expectedRevision: (await w.current(id)).revision });
  const ready = async title => {
    const task = await w.task(title, 'Change the feature.');
    await writeFile(join(await w.workspace(task.id), `${title}.txt`), 'x\n');
    await w.delivery.commit(task.id, { message: title, confirm: true });
    await w.move(task.id, 'code_review');
    return task;
  };
  // Default: entering Merge does nothing, even when everything passed.
  assert.equal((await w.board.view()).projects[0].effectiveWorkflow.merge.policy, 'manual');
  const first = await ready('first');
  await w.review(first.id); await w.delivery.acceptReview(first.id);
  await w.move(first.id, 'testing'); await w.tests(first.id);
  const manual = await transition(first.id, 'merge');
  assert.equal(manual.task.column, 'merge');
  assert.equal(manual.merged, undefined);
  // Turned on: a card without an accepted review is not merged, and the reason is returned.
  await w.board.setWorkflow(w.project.id, { workflow: { merge: { policy: 'start' } }, expectedRevision: await revision() });
  const unreviewed = await ready('unreviewed');
  await w.move(unreviewed.id, 'testing');
  const refused = await transition(unreviewed.id, 'merge');
  assert.equal(refused.task.column, 'merge');
  assert.equal(refused.automation.code, 'MERGE_NOT_ELIGIBLE');
  assert.match(refused.automation.message, /accepted code review/);
  // Turned on and every check passed for the current commits: fast-forward merge, recorded as automatic.
  const second = await ready('second');
  await w.review(second.id); await w.delivery.acceptReview(second.id);
  await w.move(second.id, 'testing'); await w.tests(second.id);
  const before = git(w.remote, 'rev-parse', 'trunk');
  const merged = await transition(second.id, 'merge');
  assert.equal(merged.merged, true);
  assert.equal(merged.task.column, 'done');
  assert.equal(merged.task.completion.trigger, 'automation');
  assert.equal(git(w.root, 'rev-parse', 'trunk'), merged.task.completion.mergedCommit);
  assert.equal(git(w.remote, 'rev-parse', 'trunk'), before, 'Nothing is pushed.');
});
