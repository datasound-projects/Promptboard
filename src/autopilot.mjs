/**
 * Autopilot: an optional, per-project engine that takes queued To Do cards one at a time
 * through their route (for example Planning → Executing → Code Review → Testing → Merge).
 *
 * It only uses the board's normal, checked operations: agent runs in the task worktree, the
 * confirmed stage, a commit with the user's Git identity, accepting a review with no issues,
 * Promptboard's own test run, and the gated fast-forward merge or a pull request. It never
 * passes bypass flags. Anything unexpected pauses Autopilot with the reason; the user
 * resumes, skips the card, or stops. One card at a time, so each merge lands before the next
 * card starts from the target branch.
 */

const TICK_MS = 1000;
const done = new Set(['failed', 'cancelled', 'interrupted']);
const title = stage => ({ planning: 'Planning', executing: 'Executing', code_review: 'Code Review', testing: 'Testing', merge: 'Merge' })[stage] || stage;

export class Autopilot {
  constructor(board, { tickMs = TICK_MS } = {}) { this.board = board; this.tickMs = tickMs; this.busy = false; }

  start() { this.timer = setInterval(() => this.tick().catch(() => {}), this.tickMs); this.timer.unref?.(); }
  stop() { clearInterval(this.timer); }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.board.advanceFlows?.().catch(() => {});
      const state = await this.board.state();
      for (const project of state.projects) {
        if (project.autopilot?.status !== 'running') continue;
        try { await this.step(project.id); }
        catch (error) { await this.pause(project.id, error.message || 'Autopilot stopped on an unexpected error.'); }
      }
    } finally { this.busy = false; }
  }

  async pause(projectId, reason) {
    await this.board.updateAutopilot(projectId, (ap, log) => { if (ap.status !== 'running') return; ap.status = 'paused'; ap.reason = reason; log(`Paused: ${reason}`); });
  }

  async set(projectId, change) { return this.board.updateAutopilot(projectId, change); }

  route(ap, taskId) { return ap.routes?.[taskId] || ap.route; }

  /** One small step for one project. Each call does at most one thing that takes time. */
  async step(projectId) {
    const state = await this.board.state();
    const project = state.projects.find(item => item.id === projectId);
    const ap = project?.autopilot;
    if (!ap || ap.status !== 'running') return;
    if (!ap.current) return this.next(project);
    const task = project.tasks.find(item => item.id === ap.current.taskId);
    if (!task) return this.set(projectId, (a, log) => { log('The current card was deleted; moving on.'); a.done = [...(a.done || []), a.current.taskId]; a.current = null; });
    const cur = ap.current;
    const route = this.route(ap, task.id);
    if (task.column === 'done') return this.finish(projectId, task, 'The card is in Done.');
    // After a resume, continue from wherever the card is now (the user may have moved it).
    if (cur.step === 'resume') {
      const stage = task.column === 'todo' ? null : task.column;
      if (stage && !route.includes(stage)) return this.pause(projectId, `“${task.title}” is in ${title(stage)}, which is not in its route. Move it to a stage on its route, or skip it.`);
      return this.set(projectId, a => { a.current = { ...a.current, stage, step: 'start', runId: null, testsId: null }; });
    }
    if (task.column === 'todo' || !cur.stage) return this.enter(projectId, task, route[0], task.column === 'todo' ? 'todo' : task.column);
    if (task.column !== cur.stage) return this.pause(projectId, `“${task.title}” was moved to ${title(task.column)} by hand. Resume to continue from there, or skip it.`);
    if (cur.stage === 'testing') return this.testing(projectId, project, task, cur, route);
    if (cur.stage === 'merge') return this.merge(projectId, project, task, cur, route, ap);
    return this.agentStage(projectId, task, cur, route, ap);
  }

  async next(project) {
    const ap = project.autopilot;
    const handled = new Set(ap.done || []);
    const task = ap.queue.map(id => project.tasks.find(item => item.id === id)).find(item => item && !handled.has(item.id) && item.column === 'todo');
    if (!task) return this.set(project.id, (a, log) => { a.status = 'finished'; a.reason = ''; log('Every queued card has been through its route.'); });
    // A new card branches from the target as it is now, including the cards merged before it.
    if (!task.workspace && project.targetBranch) await this.board.setTargetBranch(project.id, { branch: project.targetBranch.name, expectedRevision: project.revision });
    return this.set(project.id, (a, log) => { a.current = { taskId: task.id, stage: null, step: 'start', attempts: 0, runId: null, testsId: null }; log(`Started “${task.title}” (route: ${this.route(a, task.id).map(title).join(' → ')}).`); });
  }

  /** Move the card straight to the route's next stage. Stages the route skips are never entered. */
  async enter(projectId, task, stage, from) {
    if (from !== stage) await this.move(task, stage);
    return this.set(projectId, (a, log) => { a.current = { ...a.current, stage, step: 'start', runId: null, testsId: null }; log(`“${task.title}” → ${title(stage)}.`); });
  }

  async advance(projectId, task, stage, route) {
    const next = route[route.indexOf(stage) + 1];
    if (!next) return this.finish(projectId, task, `Route finished in ${title(stage)}.`);
    return this.enter(projectId, task, next, stage);
  }

  /** The board's own transition, with its checks; Autopilot starts each stage's work itself. */
  async move(task, column) {
    const fresh = this.board.state().then(state => state.projects.flatMap(project => project.tasks).find(item => item.id === task.id));
    return this.board.transition(task.id, { column, expectedRevision: (await fresh).revision, decision: 'move', trigger: 'automation' });
  }

  async finish(projectId, task, text) {
    return this.set(projectId, (a, log) => { a.done = [...(a.done || []), task.id]; a.current = null; log(`“${task.title}”: ${text}`); });
  }

  /** Send the card back to Executing with notes, within the rework limit. */
  async rework(projectId, task, cur, ap, why) {
    if ((cur.attempts || 0) >= ap.maxRework) return this.pause(projectId, `“${task.title}”: ${why} after ${cur.attempts || 0} rework ${cur.attempts === 1 ? 'round' : 'rounds'}. Fix it by hand, then resume, or skip the card.`);
    // The move back records the findings or test output for the next Executing run (board.transition).
    await this.move(task, 'executing');
    return this.set(projectId, (a, log) => { a.current = { ...a.current, stage: 'executing', step: 'start', runId: null, testsId: null, attempts: (a.current.attempts || 0) + 1 }; log(`“${task.title}”: ${why}; sent back to Executing (rework ${a.current.attempts}/${a.maxRework}).`); });
  }

  /** Planning, Executing, and Code Review: run the agent, confirm its finished turn, then act on the result. */
  async agentStage(projectId, task, cur, route, ap) {
    const stage = cur.stage;
    if (cur.step === 'start') {
      const run = await this.board.requestRun(task.id, { stage, consent: true, trigger: 'automation' });
      return this.set(projectId, a => { a.current = { ...a.current, step: 'running', runId: run.id }; });
    }
    if (cur.step === 'running') {
      const run = await this.board.run(cur.runId);
      if (done.has(run.status)) return this.pause(projectId, `The ${title(stage)} agent for “${task.title}” ${run.status}${run.reason ? `: ${run.reason}` : ''}.`);
      if (run.status === 'succeeded') return this.set(projectId, a => { a.current = { ...a.current, step: 'after' }; });
      // Advance only on a finished turn, never while the agent asks for permission or an answer.
      if (run.status !== 'waiting_for_input' || !run.turnComplete || !run.turns) return;
      await this.board.executor.confirm(run.id);
      return this.set(projectId, a => { a.current = { ...a.current, step: 'after' }; });
    }
    // step 'after'
    const delivery = this.board.delivery;
    if (stage === 'executing') {
      let rev = await delivery.revision(task.id);
      if (rev.merging) return this.pause(projectId, `A merge is in progress in the worktree of “${task.title}”. Commit or abort it, then resume.`);
      if (!rev.clean) rev = await delivery.commit(task.id, { message: task.title, confirm: true });
      if (!rev.ahead) return this.pause(projectId, `The Executing agent made no changes for “${task.title}”. Check the task, then resume, or skip it.`);
    }
    if (stage === 'code_review') {
      const review = (await this.board.state()).projects.find(item => item.id === projectId).tasks.find(item => item.id === task.id).evidence?.review;
      if (review?.verdict === 'changes_required') {
        return this.rework(projectId, task, cur, ap, 'the review asked for changes');
      }
      if (review?.verdict !== 'no_issues') return this.pause(projectId, `The review of “${task.title}” could not be read as a clear verdict. Check it in the task details, then resume or skip.`);
      await delivery.acceptReview(task.id);
    }
    return this.advance(projectId, task, stage, route);
  }

  /** Testing: the agent assesses the task first, then independent command exit codes decide. */
  async testing(projectId, project, task, cur, route) {
    const delivery = this.board.delivery;
    if (cur.step === 'start') {
      if (!(project.testCommands || []).length) return this.pause(projectId, 'The route includes Testing, but this project has no test commands. Add them in Workflow settings, then resume.');
      const run = await this.board.requestRun(task.id, { stage: 'testing', consent: true, trigger: 'automation' });
      return this.set(projectId, a => { a.current = { ...a.current, step: 'agent', runId: run.id }; });
    }
    if (cur.step === 'agent') {
      const run = await this.board.run(cur.runId);
      if (done.has(run.status)) return this.pause(projectId, `The Testing agent for “${task.title}” ${run.status}.`);
      if (run.status !== 'succeeded') {
        if (run.status !== 'waiting_for_input' || !run.turnComplete || !run.turns) return;
        await this.board.executor.confirm(run.id);
      }
      const rev = await delivery.revision(task.id);
      if (!rev.clean) return this.rework(projectId, task, cur, project.autopilot, 'the testing agent changed files that need review');
      const fresh = (await this.board.state()).projects.find(item => item.id === projectId).tasks.find(item => item.id === task.id);
      if (!fresh.evidence?.tests) return this.pause(projectId, fresh.flow?.reason || 'Testing could not start the configured commands.');
      return this.set(projectId, a => { a.current = { ...a.current, step: 'running', testsId: fresh.evidence.tests.id }; });
    }
    const tests = task.evidence?.tests;
    if (!tests || tests.id !== cur.testsId) return this.set(projectId, a => { a.current = { ...a.current, step: 'start' }; });
    if (tests.status === 'running') {
      // Tests that were running when the app stopped never finish; run them again.
      if (!delivery.testsRunning.has(task.id)) return this.set(projectId, a => { a.current = { ...a.current, step: 'start' }; });
      return;
    }
    if (tests.status === 'passed') return this.advance(projectId, task, 'testing', route);
    return this.rework(projectId, task, cur, project.autopilot, `the tests ${tests.status === 'invalid' ? 'were invalidated' : 'failed'}`);
  }

  /** Merge: the gated fast-forward merge, or a pull request. A moved target is brought in first. */
  async merge(projectId, project, task, cur, route, ap) {
    const delivery = this.board.delivery;
    if (ap.finish === 'pull_request') {
      const review = task.evidence?.review, tests = task.evidence?.tests;
      const body = [`Task: ${task.title}`, '', `Code review: ${review ? `${review.status} (${review.verdict})` : 'not in the route'}`, `Tests: ${tests ? tests.status : 'not in the route'}`, '', 'Opened by Promptboard Autopilot.'].join('\n');
      const updated = await delivery.openPullRequest(task.id, { confirm: true, title: task.title, body });
      return this.finish(projectId, task, `pull request opened: ${updated.evidence?.pullRequest?.url || ''}`);
    }
    if (cur.step === 'resolving') {
      // The merge agent resolved conflicts; commit the merge, then review and test again.
      const run = await this.board.run(cur.runId);
      if (done.has(run.status)) return this.pause(projectId, `The merge agent for “${task.title}” ${run.status}. Resolve the merge in the task details, then resume.`);
      if (run.status !== 'succeeded') {
        if (run.status !== 'waiting_for_input' || !run.turnComplete || !run.turns) return;
        await this.board.executor.confirm(run.id);
      }
      const rev = await delivery.revision(task.id);
      if (rev.unresolved.length) return this.pause(projectId, `Conflict markers remain in ${rev.unresolved.join(', ')} for “${task.title}”. Resolve them in the worktree, then resume.`);
      if (rev.merging || !rev.clean) await delivery.commit(task.id, { message: `Merge ${project.targetBranch.name} into ${task.workspace.branch}`, confirm: true });
      return this.recheck(projectId, task, route, 'the target branch was merged in');
    }
    const preview = await delivery.mergePreview(task.id);
    if (preview.eligible) {
      await delivery.merge(task.id, { confirm: true, taskCommit: preview.taskCommit, targetCommit: preview.targetCommit, trigger: 'automation' });
      return this.finish(projectId, task, `merged into ${preview.targetBranch} (fast-forward).`);
    }
    if (!preview.fastForward && !preview.merging) {
      if ((cur.attempts || 0) >= ap.maxRework) return this.pause(projectId, `${preview.targetBranch} keeps moving while “${task.title}” is checked. Merge it by hand, or resume to try again.`);
      try {
        await delivery.updateBranch(task.id, { confirm: true });
        return this.recheck(projectId, task, route, `${preview.targetBranch} had moved on and was merged in cleanly`);
      } catch (error) {
        if (error.code !== 'MERGE_CONFLICT') throw error;
        const run = await this.board.requestRun(task.id, { stage: 'merge', consent: true, trigger: 'automation' });
        return this.set(projectId, (a, log) => { a.current = { ...a.current, step: 'resolving', runId: run.id }; log(`“${task.title}”: ${preview.targetBranch} conflicts with the task; the merge agent is resolving it.`); });
      }
    }
    return this.pause(projectId, `“${task.title}” cannot be merged yet: ${preview.problems.join(' ')}`);
  }

  /** After the task commit changed in Merge, review and tests must run again for the new commit. */
  async recheck(projectId, task, route, why) {
    // Merge → Code Review: a route that merges always includes Code Review (normalizeRoute).
    const back = 'code_review';
    await this.move(task, back);
    return this.set(projectId, (a, log) => { a.current = { ...a.current, stage: back, step: 'start', runId: null, testsId: null, attempts: (a.current.attempts || 0) + 1 }; log(`“${task.title}”: ${why}; back to ${title(back)} for the new commit.`); });
  }
}
