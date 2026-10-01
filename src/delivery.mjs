/**
 * Review, testing, merge, and Done (PB-04). Deterministic Git operations on a task's own
 * worktree and branch. Evidence (review and test results) is tied to the task commit,
 * the target commit, and the prompt revision, so any change makes it stale.
 *
 * Never: force, reset, stash, clean, rebase, or resolve conflicts automatically. The only push is
 * the confirmed "Open pull request" action, which pushes the task branch without --force.
 */
import { execFile, spawn } from 'node:child_process';
import { gh } from './github.mjs';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git, lines, listWorktrees } from './git.mjs';
import { killPidGroup, trackPid, untrackPid } from './providers.mjs';

const OUTPUT_TAIL = 20 * 1024;
const OUTPUT_FILE = 5 * 1024 * 1024;
const DIFF_LIMIT = 200 * 1024;

export class DeliveryError extends Error {
  constructor(message, code, status = 409) { super(message); this.code = code; this.status = status; }
}
const fail = (message, code, status) => new DeliveryError(message, code, status);

/** Split a command line into argv without a shell: spaces separate, quotes group, no expansion. */
export function parseCommand(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 2000 || input.includes('\0')) throw fail('Enter a command of at most 2,000 characters.', 'INVALID_COMMAND', 400);
  const argv = [];
  let current = '', quote = null, started = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && i + 1 < input.length) current += input[++i];
      else current += char;
    } else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) { argv.push(current); current = ''; started = false; } }
    else { current += char; started = true; }
  }
  if (quote) throw fail('A quote in this command is not closed.', 'INVALID_COMMAND', 400);
  if (started) argv.push(current);
  if (argv.length > 50) throw fail('A command can have at most 50 arguments.', 'INVALID_COMMAND', 400);
  return argv;
}

/** Findings from a review message: the last ```json block with { verdict, findings }. */
export function parseFindings(text) {
  const blocks = [...String(text || '').matchAll(/```json\s*([\s\S]*?)```/g)];
  for (const block of blocks.reverse()) {
    try {
      const data = JSON.parse(block[1]);
      if (!data || !Array.isArray(data.findings)) continue;
      const findings = data.findings.slice(0, 100).filter(item => item && typeof item === 'object').map(item => ({
        severity: ['critical', 'high', 'medium', 'low'].includes(item.severity) ? item.severity : 'medium',
        file: typeof item.file === 'string' ? item.file.slice(0, 300) : '',
        line: Number.isInteger(item.line) && item.line > 0 ? item.line : null,
        explanation: typeof item.explanation === 'string' ? item.explanation.slice(0, 2000) : '',
      }));
      return { parsed: true, verdict: data.verdict === 'no_issues' && !findings.length ? 'no_issues' : 'changes_required', findings };
    } catch {}
  }
  return { parsed: false, verdict: 'unknown', findings: [] };
}

export class Delivery {
  constructor(board) {
    this.board = board;
    this.locks = new Map();
    this.testsRunning = new Map(); // taskId -> { pids }
  }

  async #locked(key, work) {
    const previous = this.locks.get(key) || Promise.resolve();
    const current = previous.then(work, work);
    const tail = current.catch(() => {});
    this.locks.set(key, tail);
    try { return await current; } finally { if (this.locks.get(key) === tail) this.locks.delete(key); }
  }

  async #context(taskId, { working = false } = {}) {
    const state = await this.board.state();
    for (const project of state.projects) {
      const task = project.tasks.find(item => item.id === taskId);
      if (!task) continue;
      if (working && ['todo', 'done'].includes(task.column)) throw fail('To Do and Done do not perform task work. Move or reopen the task first.', 'STAGE_NOT_RUNNABLE');
      if (task.workspace?.status !== 'ready') throw fail('This task has no worktree yet. Run Executing first.', 'WORKSPACE_REQUIRED');
      if (!project.targetBranch) throw fail('Choose the target branch first.', 'TARGET_BRANCH_REQUIRED');
      return { state, project, task, ws: task.workspace, target: project.targetBranch.name };
    }
    throw fail('This task does not exist. Reload the board.', 'NOT_FOUND', 404);
  }

  async #rev(cwd, ref) { return lines(await git(['rev-parse', '--verify', `${ref}^{commit}`], { cwd }))[0]; }

  /** The task's reviewable revision and whether it is clean. */
  async revision(taskId) {
    const { task, ws, target } = await this.#context(taskId);
    const head = await this.#rev(ws.path, 'HEAD');
    let branch = '';
    try { branch = lines(await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: ws.path }))[0] || ''; } catch {}
    const status = lines(await git(['status', '--porcelain', '--untracked-files=all'], { cwd: ws.path }));
    const targetCommit = await this.#rev(ws.path, `refs/heads/${target}`);
    const ahead = Number(lines(await git(['rev-list', '--count', `${targetCommit}..${head}`], { cwd: ws.path }))[0] || 0);
    return { taskCommit: head, branch, branchOk: branch === ws.branch, clean: status.length === 0, changes: status.slice(0, 200), targetBranch: target, targetCommit, ahead, promptRevision: task.contentRevision ?? 1, ...(await this.#mergeState(ws.path)) };
  }

  /** A merge in progress in the worktree (MERGE_HEAD), its unmerged files, and those that still have conflict markers. */
  async #mergeState(cwd) {
    let merging = false;
    try { await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd }); merging = true; } catch {}
    if (!merging) return { merging: false, conflicts: [], unresolved: [] };
    const conflicts = lines(await git(['diff', '--name-only', '--diff-filter=U'], { cwd }).catch(() => ''));
    // An agent (or a person) may already have staged a file, so Git no longer lists it as
    // conflicted. Check every file the merge changes, not only the unmerged ones.
    const changed = lines(await git(['diff', '--name-only', 'HEAD'], { cwd }).catch(() => ''));
    const unresolved = [];
    for (const file of [...new Set([...conflicts, ...changed])].slice(0, 500)) {
      const text = await readFile(join(cwd, file), 'utf8').catch(() => null);
      if (text !== null && /^(<{7}|>{7})( |$)/m.test(text)) unresolved.push(file);
    }
    return { merging, conflicts, unresolved };
  }

  /** Preview of uncommitted work, for the Commit action. */
  async uncommitted(taskId) {
    const { ws } = await this.#context(taskId);
    const status = lines(await git(['status', '--porcelain', '--untracked-files=all'], { cwd: ws.path }));
    let diff = await git(['diff', 'HEAD', '--no-color', '--no-ext-diff'], { cwd: ws.path });
    // New files are not in `git diff`; read them directly (without staging) so the preview is complete.
    const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: ws.path })).split('\0').filter(Boolean);
    for (const file of untracked.slice(0, 200)) {
      if (diff.length > DIFF_LIMIT) break;
      const content = await readFile(join(ws.path, file)).catch(() => null);
      if (!content) continue;
      const text = content.includes(0) ? '(binary file)' : content.toString('utf8').slice(0, 20000).split('\n').map(line => `+${line}`).join('\n');
      diff += `\nnew file: ${file}\n${text}\n`;
    }
    const truncated = diff.length > DIFF_LIMIT;
    if (truncated) diff = diff.slice(0, DIFF_LIMIT);
    return { changes: status.slice(0, 500), diff, truncated };
  }

  /** Commit all task changes on the task branch with the repository's existing Git identity. */
  async commit(taskId, { message, confirm }) {
    if (confirm !== true) throw fail('Confirm the commit first.', 'CONFIRMATION_REQUIRED', 400);
    if (typeof message !== 'string' || !message.trim() || message.length > 2000) throw fail('Enter a commit message of 1 to 2,000 characters.', 'INVALID_INPUT', 400);
    return this.#locked(`task:${taskId}`, async () => {
      const rev = await this.revision(taskId);
      const { ws } = await this.#context(taskId, { working: true });
      if (!rev.branchOk) throw fail(`The task worktree is not on its task branch (${ws.branch}). Promptboard will not commit there.`, 'BRANCH_MISMATCH');
      if (rev.clean) throw fail('There are no changes to commit.', 'NOTHING_TO_COMMIT');
      // Staging a file with conflict markers would record it as resolved. Refuse instead.
      if (rev.unresolved.length) throw fail(`These files still contain conflict markers: ${rev.unresolved.slice(0, 10).join(', ')}. Resolve them (or let the merge agent do it), then commit.`, 'CONFLICT_MARKERS');
      await git(['add', '--all'], { cwd: ws.path });
      try { await git(['commit', '--no-edit', '-m', message.trim()], { cwd: ws.path, timeoutMs: 120000 }); }
      catch (error) {
        if (/tell me who you are|user\.email|user\.name/i.test(error.stderr || '')) throw fail('Git has no author identity for this repository. Set user.name and user.email with git config yourself; Promptboard does not change Git configuration.', 'IDENTITY_REQUIRED');
        throw fail('Git could not create the commit (a commit hook may have rejected it). Run git commit in the task worktree to see why.', 'COMMIT_FAILED');
      }
      return this.revision(taskId);
    });
  }

  /** Context for a review run: requires a clean, committed revision. */
  async reviewContext(taskId) {
    const rev = await this.revision(taskId);
    if (!rev.branchOk) throw fail('The task worktree is not on its task branch.', 'BRANCH_MISMATCH');
    if (!rev.clean) throw fail('Commit or remove the uncommitted changes before review.', 'UNCOMMITTED_CHANGES');
    if (!rev.ahead) throw fail('The task branch has no changes against the target. Use “Reviewed: no changes required” instead.', 'NO_CHANGES');
    const { ws } = await this.#context(taskId);
    let diff = await git(['diff', '--no-color', '--no-ext-diff', `${rev.targetCommit}...${rev.taskCommit}`], { cwd: ws.path });
    const truncated = diff.length > DIFF_LIMIT;
    if (truncated) diff = `${diff.slice(0, DIFF_LIMIT)}\n[Promptboard: the diff was cut at ${DIFF_LIMIT} bytes; inspect the remaining files in the worktree.]`;
    return { ...rev, text: `=== DIFF: task ${rev.taskCommit.slice(0, 12)} against ${rev.targetBranch} ${rev.targetCommit.slice(0, 12)} ===\n${diff}\n=== END DIFF ===`, truncated };
  }

  /** Record a confirmed review run's findings for the reviewed commits. */
  async recordReview(run, text) {
    const findings = parseFindings(text);
    return this.board.updateTaskEvidence(run.taskId, task => {
      task.evidence = { ...(task.evidence || {}), review: { status: 'completed', runId: run.id, taskCommit: run.review?.taskCommit, targetCommit: run.review?.targetCommit, promptRevision: run.promptRevision, ...findings, text: String(text || '').slice(0, 20000), at: Date.now() } };
    });
  }

  async acceptReview(taskId) {
    const rev = await this.revision(taskId);
    return this.board.updateTaskEvidence(taskId, task => {
      const review = task.evidence?.review;
      if (review?.status !== 'completed') throw fail('There is no completed review to accept.', 'REVIEW_MISSING');
      if (review.taskCommit !== rev.taskCommit || !rev.clean) throw fail('The task changed after this review. Review it again.', 'REVIEW_STALE');
      review.status = 'accepted';
      review.acceptedAt = Date.now();
    });
  }

  async setTestCommands(projectId, { commands, expectedRevision }) {
    if (!Array.isArray(commands) || commands.length > 20) throw fail('Configure at most 20 test commands.', 'INVALID_INPUT', 400);
    const clean = commands.map((item, index) => {
      const argv = Array.isArray(item.argv) ? item.argv.map(String) : parseCommand(item.command);
      if (!argv.length || argv.some(arg => arg.length > 1000 || arg.includes('\0'))) throw fail(`Test command ${index + 1} is not valid.`, 'INVALID_COMMAND', 400);
      const timeoutSec = Number.isInteger(item.timeoutSec) ? item.timeoutSec : 600;
      if (timeoutSec < 1 || timeoutSec > 3600) throw fail('A test timeout must be 1 to 3,600 seconds.', 'INVALID_INPUT', 400);
      return { label: typeof item.label === 'string' && item.label.trim() ? item.label.trim().slice(0, 80) : argv.join(' ').slice(0, 80), argv, timeoutSec };
    });
    return this.board.setTestCommands(projectId, { commands: clean, expectedRevision });
  }

  /**
   * Run the project's approved test commands in the task worktree, in the background.
   * Only exit codes decide the result. Missing commands, timeouts, and failures never pass.
   */
  async runTests(taskId, { confirm } = {}) {
    if (confirm !== true) throw fail('Confirm the test run first.', 'CONFIRMATION_REQUIRED', 400);
    if (this.testsRunning.has(taskId)) throw fail('Tests are already running for this task.', 'TESTS_RUNNING');
    const { project, ws } = await this.#context(taskId, { working: true });
    const commands = project.testCommands || [];
    if (!commands.length) throw fail('Add a test command in Workflow settings first. Promptboard only runs commands you configure.', 'NO_TEST_COMMANDS');
    const rev = await this.revision(taskId);
    if (!rev.branchOk) throw fail('The task worktree is not on its task branch.', 'BRANCH_MISMATCH');
    if (!rev.clean) throw fail('Commit or remove the uncommitted changes before testing.', 'UNCOMMITTED_CHANGES');
    const id = `tests-${Date.now()}`;
    const dir = join(this.board.dataDir, 'tests', taskId, id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const running = { pids: new Set() };
    this.testsRunning.set(taskId, running);
    await this.board.updateTaskEvidence(taskId, task => {
      task.evidence = { ...(task.evidence || {}), tests: { status: 'running', id, taskCommit: rev.taskCommit, targetCommit: rev.targetCommit, promptRevision: rev.promptRevision, results: [], startedAt: Date.now() } };
    });
    (async () => {
      const results = [];
      for (const [index, command] of commands.entries()) results.push(await this.#runCommand(command, ws.path, join(dir, `command-${index + 1}.log`), running));
      const after = await this.revision(taskId).catch(() => null);
      const changed = !after || after.taskCommit !== rev.taskCommit;
      const status = changed ? 'invalid' : results.every(result => result.status === 'passed') ? 'passed' : 'failed';
      await this.board.updateTaskEvidence(taskId, task => {
        if (task.evidence?.tests?.id !== id) return;
        task.evidence.tests = { ...task.evidence.tests, status, results, endedAt: Date.now(), ...(changed ? { note: 'The task commit changed while tests ran; run them again.' } : {}) };
      }).catch(() => {});
    })().finally(() => this.testsRunning.delete(taskId));
    return { id, status: 'running' };
  }

  #runCommand(command, cwd, logPath, running) {
    return new Promise(resolve => {
      const started = Date.now();
      const log = createWriteStream(logPath, { mode: 0o600 });
      let tail = '', written = 0, timedOut = false, settled = false;
      const done = result => { if (settled) return; settled = true; log.end(); resolve({ label: command.label, argv: command.argv, cwd, durationMs: Date.now() - started, tail: tail.slice(-OUTPUT_TAIL), ...result }); };
      let child;
      try { child = spawn(command.argv[0], command.argv.slice(1), { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } }); }
      catch { done({ status: 'error', exitCode: null, reason: 'The command could not start.' }); return; }
      if (child.pid) { trackPid(child.pid); running.pids.add(child.pid); }
      const collect = chunk => {
        const text = chunk.toString('utf8');
        tail = (tail + text).slice(-OUTPUT_TAIL);
        if (written < OUTPUT_FILE) { log.write(text); written += chunk.length; }
      };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const timer = setTimeout(() => { timedOut = true; killPidGroup(child.pid, 'SIGTERM'); setTimeout(() => killPidGroup(child.pid, 'SIGKILL'), 3000).unref(); }, command.timeoutSec * 1000);
      child.on('error', error => {
        clearTimeout(timer);
        done({ status: error.code === 'ENOENT' ? 'missing' : 'error', exitCode: null, reason: error.code === 'ENOENT' ? `Command not found: ${command.argv[0]}` : 'The command could not run.' });
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (child.pid) { untrackPid(child.pid); running.pids.delete(child.pid); }
        done(timedOut ? { status: 'timeout', exitCode: code, reason: `Stopped after ${command.timeoutSec} seconds.` }
          : { status: code === 0 ? 'passed' : 'failed', exitCode: code, ...(signal ? { reason: `Ended by signal ${signal}.` } : {}) });
      });
    });
  }

  /** Where the target branch is checked out, if anywhere, and whether that checkout is clean. */
  async #targetCheckout(root, target) {
    const entry = (await listWorktrees(root)).find(item => item.branch === target) || null;
    if (!entry) return null;
    const tracked = lines(await git(['status', '--porcelain', '--untracked-files=no'], { cwd: entry.path }));
    return { path: entry.path, clean: tracked.length === 0, changes: tracked.slice(0, 50) };
  }

  /** Merge preview and eligibility for the current task and target commits. */
  async mergePreview(taskId) {
    const { task, ws, target } = await this.#context(taskId);
    const rev = await this.revision(taskId);
    const commits = lines(await git(['log', '--format=%H%x09%s', '--max-count=100', `${rev.targetCommit}..${rev.taskCommit}`], { cwd: ws.path })).map(line => { const [sha, ...subject] = line.split('\t'); return { sha, subject: subject.join('\t') }; });
    const files = lines(await git(['diff', '--name-status', '--no-renames', `${rev.targetCommit}...${rev.taskCommit}`], { cwd: ws.path })).slice(0, 500);
    let fastForward = false;
    try { await git(['merge-base', '--is-ancestor', rev.targetCommit, rev.taskCommit], { cwd: ws.path }); fastForward = true; } catch {}
    const checkout = await this.#targetCheckout(ws.repositoryRoot, target);
    const review = task.evidence?.review, tests = task.evidence?.tests;
    const problems = [];
    if (!rev.branchOk) problems.push('The task worktree is not on its task branch.');
    if (rev.merging) problems.push(`A merge of ${target} into the task branch is in progress${rev.unresolved.length ? ` with ${rev.unresolved.length} unresolved ${rev.unresolved.length === 1 ? 'file' : 'files'}` : ''}. Commit it, then review and test again, or abort it.`);
    else if (!rev.clean) problems.push('The task worktree has uncommitted changes. Commit them first.');
    if (!rev.ahead) problems.push('The task branch has no commits to merge.');
    if (!fastForward) problems.push(`${target} has advanced since this task branched. Update the task branch, then review and test again.`);
    if (review?.status !== 'accepted' || review.taskCommit !== rev.taskCommit) problems.push(review?.status === 'accepted' ? 'The accepted review is for an older task commit. Review again.' : 'An accepted code review for the current commit is required.');
    if (review?.verdict !== 'no_issues' || review?.findings?.length) problems.push('The code review detected issues or has no clear verdict. Resolve them and review again before merging.');
    if (tests?.status !== 'passed' || tests.taskCommit !== rev.taskCommit || tests.targetCommit !== rev.targetCommit) problems.push(tests?.status === 'passed' ? 'The passing tests are for older commits. Run tests again.' : 'Passing tests for the current commits are required.');
    if (checkout && !checkout.clean) problems.push(`The checkout of ${target} at ${checkout.path} has uncommitted changes. Promptboard will not merge into it.`);
    return { sourceBranch: ws.branch, targetBranch: target, taskCommit: rev.taskCommit, targetCommit: rev.targetCommit, commits, files, fastForward,
      targetCheckout: checkout ? { path: checkout.path, clean: checkout.clean } : null, merging: rev.merging, conflicts: rev.conflicts, unresolved: rev.unresolved, eligible: problems.length === 0, problems };
  }

  /** Confirmed fast-forward-only merge, serialized per repository, rechecked immediately before. */
  async merge(taskId, { confirm, taskCommit, targetCommit, trigger = 'user' }) {
    if (confirm !== true) throw fail('Confirm the merge first.', 'CONFIRMATION_REQUIRED', 400);
    const { ws, target } = await this.#context(taskId, { working: true });
    return this.#locked(`repo:${ws.commonDir}`, async () => {
      const preview = await this.mergePreview(taskId);
      if (preview.taskCommit !== taskCommit || preview.targetCommit !== targetCommit) throw fail('The task or target branch changed since the preview. Review the new preview.', 'MERGE_STALE');
      if (!preview.eligible) throw fail(preview.problems.join(' '), 'MERGE_NOT_ELIGIBLE');
      const branchTip = await this.#rev(ws.path, `refs/heads/${ws.branch}`);
      if (branchTip !== taskCommit) throw fail('The task branch does not point at the previewed commit.', 'MERGE_STALE');
      let method;
      if (preview.targetCheckout) {
        // Fast-forward the checkout that has the target branch; never switch branches anywhere.
        await git(['merge', '--ff-only', '--no-edit', taskCommit], { cwd: preview.targetCheckout.path, timeoutMs: 120000 })
          .catch(() => { throw fail('Git refused the fast-forward in the target checkout. Nothing was changed.', 'MERGE_FAILED'); });
        method = `fast-forward in ${preview.targetCheckout.path}`;
      } else {
        // Not checked out anywhere: move the ref only if it still has the previewed value.
        await git(['update-ref', '-m', `promptboard: fast-forward ${target} to task ${taskId}`, `refs/heads/${target}`, taskCommit, targetCommit], { cwd: ws.repositoryRoot })
          .catch(() => { throw fail('Git refused to update the target branch. Nothing was changed.', 'MERGE_FAILED'); });
        method = 'fast-forward of the branch reference';
      }
      const result = await this.#rev(ws.repositoryRoot, `refs/heads/${target}`);
      if (result !== taskCommit) throw fail(`The merge could not be verified: ${target} is at ${result.slice(0, 12)}.`, 'MERGE_UNVERIFIED', 500);
      const done = await this.board.completeTask(taskId, { kind: 'merged', details: { targetBranch: target, previousTarget: targetCommit, mergedCommit: result, method, commits: preview.commits.length, trigger } });
      // The work is on the target branch now. Remove the clean task worktree; the task branch stays.
      return (await this.board.removeTaskWorktree(taskId).catch(() => null)) || done;
    });
  }

  /** Confirmed update of the task branch with the advanced target. Conflicts are aborted, not resolved. */
  async updateBranch(taskId, { confirm }) {
    if (confirm !== true) throw fail('Confirm the branch update first.', 'CONFIRMATION_REQUIRED', 400);
    return this.#locked(`task:${taskId}`, async () => {
      const rev = await this.revision(taskId);
      const { ws } = await this.#context(taskId, { working: true });
      if (!rev.branchOk) throw fail('The task worktree is not on its task branch.', 'BRANCH_MISMATCH');
      if (!rev.clean) throw fail('Commit the task changes before updating the branch.', 'UNCOMMITTED_CHANGES');
      try { await git(['merge', '--no-edit', '--no-ff', rev.targetCommit], { cwd: ws.path, timeoutMs: 120000 }); }
      catch {
        let conflicts = [];
        try { conflicts = lines(await git(['diff', '--name-only', '--diff-filter=U'], { cwd: ws.path })); } catch {}
        await git(['merge', '--abort'], { cwd: ws.path }).catch(() => {});
        if (!conflicts.length) throw fail('Git could not merge the target branch (a missing Git identity or a hook can cause this). The task branch is unchanged. Run git merge in the task worktree to see why.', 'MERGE_FAILED');
        throw fail(`The update has conflicts in ${conflicts.slice(0, 10).join(', ')}. The merge was aborted and the task branch is unchanged. Start the merge agent to resolve them, resolve them in the worktree yourself, or send the task back to Executing.`, 'MERGE_CONFLICT');
      }
      return this.revision(taskId);
    });
  }

  /** Test commands as text for an agent's context. */
  #commandsText(project) {
    const commands = project.testCommands || [];
    return commands.length ? commands.map(item => `- ${item.argv.map(arg => /[\s"']/.test(arg) ? JSON.stringify(arg) : arg).join(' ')}`).join('\n') : '- (none configured in Promptboard; use the project\'s usual test commands)';
  }

  /** Context for a Testing agent run. */
  async testingContext(taskId) {
    const { project } = await this.#context(taskId);
    return `=== TEST COMMANDS CONFIGURED IN PROMPTBOARD ===\n${this.#commandsText(project)}\n=== END TEST COMMANDS ===`;
  }

  /**
   * Before a merge agent starts: bring the target branch into the task branch with
   * `git merge --no-commit`, leaving any conflicts in the worktree for the agent. Nothing is
   * committed; the user commits the result (the marker check applies), or aborts it.
   */
  async prepareMergeRun(taskId) {
    return this.#locked(`task:${taskId}`, async () => {
      const { project, ws, target } = await this.#context(taskId, { working: true });
      let rev = await this.revision(taskId);
      if (!rev.branchOk) throw fail('The task worktree is not on its task branch.', 'BRANCH_MISMATCH');
      let note;
      if (rev.merging) note = `A merge of ${target} into the task branch is already in progress in this worktree.`;
      else {
        if (!rev.clean) throw fail('Commit the task changes before the merge agent starts.', 'UNCOMMITTED_CHANGES');
        if (!rev.ahead) throw fail('The task branch has no changes against the target. Use “Reviewed: no changes required” instead.', 'NO_CHANGES');
        let behind = true;
        try { await git(['merge-base', '--is-ancestor', rev.targetCommit, rev.taskCommit], { cwd: ws.path }); behind = false; } catch {}
        if (!behind) note = `The task branch already contains ${target} at ${rev.targetCommit.slice(0, 12)}, so no merge was needed. Check the combined result and run the tests.`;
        else {
          try { await git(['merge', '--no-ff', '--no-commit', rev.targetCommit], { cwd: ws.path, timeoutMs: 120000 }); }
          catch {
            const state = await this.#mergeState(ws.path);
            if (!state.merging) throw fail('Git could not start merging the target branch into the task branch. Run git merge in the task worktree to see why.', 'MERGE_FAILED');
          }
          note = `Promptboard ran git merge --no-ff --no-commit ${target} (${rev.targetCommit.slice(0, 12)}) in this worktree.`;
        }
        rev = await this.revision(taskId);
      }
      const conflicts = rev.conflicts.length ? rev.conflicts.map(file => `- ${file}`).join('\n') : '- none';
      return { revision: rev, text: `=== MERGE CONTEXT ===\nTarget branch: ${target} at ${rev.targetCommit.slice(0, 12)}\nTask branch: ${ws.branch}\n${note}\nConflicted files to resolve:\n${conflicts}\n=== END MERGE CONTEXT ===\n\n=== TEST COMMANDS CONFIGURED IN PROMPTBOARD ===\n${this.#commandsText(project)}\n=== END TEST COMMANDS ===` };
    });
  }

  /** Confirmed: abandon a merge in progress in the task worktree (git merge --abort). */
  async abortMerge(taskId, { confirm }) {
    if (confirm !== true) throw fail('Confirm that you want to abort the merge.', 'CONFIRMATION_REQUIRED', 400);
    return this.#locked(`task:${taskId}`, async () => {
      const { ws } = await this.#context(taskId, { working: true });
      const rev = await this.revision(taskId);
      if (!rev.merging) throw fail('No merge is in progress in the task worktree.', 'NO_MERGE');
      await git(['merge', '--abort'], { cwd: ws.path }).catch(() => { throw fail('Git could not abort the merge. Run git merge --abort in the task worktree.', 'ABORT_FAILED'); });
      return this.revision(taskId);
    });
  }

  /**
   * Confirmed: push the task branch (never with --force) and open a GitHub pull request with the
   * GitHub CLI. The title and body are the user's; the task prompt is not sent unless they add it.
   */
  async openPullRequest(taskId, { confirm, title, body = '' }) {
    if (confirm !== true) throw fail('Confirm the push and pull request first.', 'CONFIRMATION_REQUIRED', 400);
    if (typeof title !== 'string' || !title.trim() || title.length > 256) throw fail('Enter a pull request title of 1 to 256 characters.', 'INVALID_INPUT', 400);
    if (typeof body !== 'string' || body.length > 20000) throw fail('The pull request description can have at most 20,000 characters.', 'INVALID_INPUT', 400);
    return this.#locked(`task:${taskId}`, async () => {
      const { ws, target } = await this.#context(taskId, { working: true });
      const rev = await this.revision(taskId);
      if (!rev.branchOk) throw fail('The task worktree is not on its task branch.', 'BRANCH_MISMATCH');
      if (rev.merging || !rev.clean) throw fail('Commit or remove the uncommitted changes (or finish the merge) before opening a pull request.', 'UNCOMMITTED_CHANGES');
      if (!rev.ahead) throw fail('The task branch has no commits to propose.', 'NO_CHANGES');
      const remotes = lines(await git(['remote'], { cwd: ws.path }).catch(() => ''));
      const remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : null;
      if (!remote) throw fail(remotes.length ? `This repository has several remotes (${remotes.join(', ')}) and none is called origin. Promptboard pushes only to origin or a single remote.` : 'This repository has no remote. Add one (git remote add origin <url>), then try again.', 'NO_REMOTE');
      await gh(['--version'], ws.path).catch(error => { throw error.missing ? fail('Install the GitHub CLI (gh) and run gh auth login, then try again.', 'GH_MISSING') : fail('The GitHub CLI did not start.', 'GH_FAILED'); });
      await git(['push', '--set-upstream', remote, `refs/heads/${ws.branch}:refs/heads/${ws.branch}`], { cwd: ws.path, timeoutMs: 180000 })
        .catch(() => { throw fail(`Git could not push ${ws.branch} to ${remote}. Check your access to the remote, or whether the branch there has different commits. Nothing was forced.`, 'PUSH_FAILED'); });
      let pr = await gh(['pr', 'view', ws.branch, '--json', 'url,number,state'], ws.path).then(JSON.parse).catch(() => null);
      if (!pr || pr.state !== 'OPEN') {
        const out = await gh(['pr', 'create', '--base', target, '--head', ws.branch, '--title', title.trim(), '--body', body], ws.path)
          .catch(error => { throw fail(/base/i.test(error.stderr || '') ? `GitHub could not use ${target} as the base branch. Push ${target} to ${remote} first.` : /auth|login/i.test(error.stderr || '') ? 'The GitHub CLI is not signed in. Run gh auth login, then try again.' : 'The GitHub CLI could not create the pull request. Run gh pr create in the task worktree to see why.', 'PR_FAILED'); });
        const url = lines(out).reverse().find(line => /^https?:\/\//.test(line)) || '';
        pr = await gh(['pr', 'view', url || ws.branch, '--json', 'url,number,state'], ws.path).then(JSON.parse).catch(() => ({ url, number: null, state: 'OPEN' }));
      }
      return this.board.updateTaskEvidence(taskId, task => {
        task.evidence = { ...(task.evidence || {}), pullRequest: { url: pr.url, number: pr.number, state: pr.state, remote, branch: ws.branch, base: target, taskCommit: rev.taskCommit, at: Date.now() } };
      });
    });
  }

  /** Refresh the pull request state; a merged pull request completes the task (Done). */
  async pullRequestStatus(taskId) {
    const { task, ws } = await this.#context(taskId);
    const known = task.evidence?.pullRequest;
    if (!known?.url) throw fail('This task has no pull request yet.', 'NO_PULL_REQUEST');
    const pr = await gh(['pr', 'view', known.url, '--json', 'url,number,state,mergedAt'], ws.path).then(JSON.parse)
      .catch(error => { throw error.missing ? fail('Install the GitHub CLI (gh) to check the pull request.', 'GH_MISSING') : fail('The GitHub CLI could not read the pull request. Check gh auth status.', 'GH_FAILED'); });
    const updated = await this.board.updateTaskEvidence(taskId, current => { current.evidence.pullRequest = { ...current.evidence.pullRequest, state: pr.state, checkedAt: Date.now() }; });
    if (pr.state !== 'MERGED') return updated;
    return this.board.completeTask(taskId, { kind: 'pull_request', details: { url: pr.url, number: pr.number, base: known.base, mergedAt: pr.mergedAt || null } });
  }

  /** Separate, explicit completion for a task that needs no code change. Not a merge. */
  async completeNoChanges(taskId, { confirm }) {
    if (confirm !== true) throw fail('Confirm that no changes are required.', 'CONFIRMATION_REQUIRED', 400);
    const state = await this.board.state();
    const task = state.projects.flatMap(project => project.tasks).find(item => item.id === taskId);
    if (!task) throw fail('This task does not exist.', 'NOT_FOUND', 404);
    if (task.workspace?.status === 'ready') {
      const rev = await this.revision(taskId);
      if (!rev.clean || rev.ahead) throw fail('The task branch has changes. Merge them, or remove them before completing with no changes.', 'HAS_CHANGES');
    }
    return this.board.completeTask(taskId, { kind: 'no_changes', details: {} });
  }

  async testLog(taskId, index) {
    const state = await this.board.state();
    const task = state.projects.flatMap(project => project.tasks).find(item => item.id === taskId);
    const id = task?.evidence?.tests?.id;
    if (!id || !Number.isInteger(index) || index < 0 || index > 20) throw fail('There is no test log.', 'NOT_FOUND', 404);
    return (await readFile(join(this.board.dataDir, 'tests', taskId, id, `command-${index + 1}.log`), 'utf8').catch(() => '')).slice(-2 * 1024 * 1024);
  }

  stopAllTests() { for (const running of this.testsRunning.values()) for (const pid of running.pids) killPidGroup(pid, 'SIGKILL'); }
}
