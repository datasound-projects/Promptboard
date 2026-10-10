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

import { EXECUTION_DEFAULTS, resolvePipelineStrategy } from './pipeline-config.mjs';
import { columnStage } from './board.mjs';

const TICK_MS = 1000;
const RESUME_MESSAGE = 'Promptboard Autopilot restarted this session. Continue the current step of this card from where you stopped; if it is already complete, say what you did and stop.';
const done = new Set(['failed', 'cancelled', 'interrupted', 'suspended']);
const title = stage => ({ planning: 'Planning', executing: 'Executing', code_review: 'Code Review', testing: 'Testing', merge: 'Merge' })[stage] || stage;

export class Autopilot {
  constructor(board, { tickMs = TICK_MS } = {}) { this.board = board; this.tickMs = tickMs; this.busy = false; this.taskIds = new Map(); }

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
        this.taskIds.set(project.id, project.autopilot.current?.taskId ?? null);
        try { await (project.workflowMode === 'pipeline' ? this.pipelineStep(project.id) : this.step(project.id)); }
        catch (error) { await this.pause(project.id, error.message || 'Autopilot stopped on an unexpected error.'); }
      }
    } finally { this.busy = false; }
  }

  async pause(projectId, reason, current = null) {
    await this.board.updateAutopilot(projectId, (ap, log) => { if (ap.status !== 'running') return; ap.status = 'paused'; ap.reason = reason; if (current) ap.current = { ...ap.current, ...current }; log(`Paused: ${reason}`); });
  }

  /** The newest move into this column whose on-enter agent message ended without reaching the agent. */
  async undeliveredInstruction(task, column) {
    const move = (await this.board.automationRuns(task.id).catch(() => [])).filter(row => row.to?.id === column).at(-1);
    const action = move?.actions.find(row => row.type === 'send_message' && row.trigger === 'enter' && row.status !== 'skipped');
    const delivery = action?.delivery;
    if (!action || ['confirmed', 'accepted'].includes(delivery?.status)) return null;
    return { transitionId: move.transitionId, reason: delivery?.outcome?.reason || action.outcome?.reason || 'it was not delivered.' };
  }

  /** A step's write applies only while Autopilot still runs the card the step began with (not after Stop or Skip). */
  async set(projectId, change) {
    const taskId = this.taskIds.get(projectId);
    return this.board.updateAutopilot(projectId, (a, log, project) => { if (a.status === 'running' && (a.current?.taskId ?? null) === taskId) change(a, log, project); });
  }

  route(ap, taskId) { return ap.routes?.[taskId] || ap.route; }

  // ---- Column pipelines ----
  // Each queued card goes through the chosen active columns in order, then Done, strictly one card at a time in
  // the queue's order. Autopilot only decides movement; every move is the board's own transition (as a drag).
  // - Typed columns (Planning, Executing, Code Review, Testing, Merge kinds): the board's stage engine runs the
  //   column and records its outcome. Succeeded → next column; changes required → back to the Executing (or
  //   Code Review) column, within the rework limit; failed → pause with the reason. A Merge column merges the
  //   task into the target branch and the card reaches Done; the next card then starts from the new target.
  // - Custom columns keep one conversation: entering the first column starts its agent with the task; each later
  //   column's "on enter" message is the next instruction. A custom column is finished when its agent has
  //   completed a new turn since the card arrived and is idle. A plan column waits for your approval.
  async pipelineStep(projectId) {
    const state = await this.board.state();
    const project = state.projects.find(item => item.id === projectId), ap = project?.autopilot;
    if (!ap || ap.status !== 'running') return;
    const columns = project.pipeline.columns, name = id => columns.find(column => column.id === id)?.name || id;
    const todo = columns.find(column => column.role === 'todo').id, done = columns.find(column => column.role === 'done').id;
    if (!ap.current) {
      const handled = new Set(ap.done || []);
      const task = ap.queue.map(id => project.tasks.find(item => item.id === id)).find(item => item && !handled.has(item.id) && item.column === todo);
      if (!task) return this.set(projectId, (a, log) => { a.status = 'finished'; a.reason = ''; log('Every queued card has been through its columns.'); });
      // A new card branches from the target as it is now, including earlier cards' work if it was merged.
      if (!task.workspace && project.targetBranch) await this.board.setTargetBranch(projectId, { branch: project.targetBranch.name, expectedRevision: project.revision });
      return this.set(projectId, (a, log) => { a.current = { taskId: task.id, stage: null, step: 'enter', turns: 0 }; log(`Started “${task.title}” (columns: ${a.route.map(name).join(' → ')}).`); });
    }
    const cur = ap.current, task = project.tasks.find(item => item.id === cur.taskId);
    if (!task) return this.set(projectId, (a, log) => { log('The current card was deleted; moving on.'); a.done = [...(a.done || []), a.current.taskId]; a.current = null; });
    const route = ap.route, runs = state.runs.filter(run => run.taskId === task.id), live = runs.filter(run => ['queued', 'running', 'waiting_for_input'].includes(run.status)).at(-1);
    if (task.column === done) return this.finish(projectId, task, cur.step === 'finishing' ? 'moved to Done.' : 'The card is in Done.');
    if (cur.step === 'finishing') return this.pipelineMove(task, done);
    if (cur.step === 'resume') {
      // Continue from wherever the card is now (the person may have moved it).
      if (task.column === todo) return this.set(projectId, a => { a.current = { ...a.current, stage: null, step: 'enter' }; });
      if (!route.includes(task.column)) return this.pause(projectId, `“${task.title}” is in ${name(task.column)}, which is not in the Autopilot columns. Move it to one of them, or skip it.`);
      if (columnStage(project, task.column)) {
        // A typed column: a final outcome is acted on; otherwise the stage runs again with a fresh session.
        const outcome = task.stageOutcome?.columnId === task.column ? task.stageOutcome : null;
        if (live || (outcome && outcome.status !== 'failed')) return this.set(projectId, a => { a.current = { ...a.current, stage: task.column, step: 'working', enteredAt: outcome?.at ?? Date.now() }; });
        // Merge is Promptboard's own operation: run it again (it brings in a moved target and merges when eligible).
        if (columnStage(project, task.column) === 'merge') await this.board.mergeNow(task.id);
        else await this.board.requestRun(task.id, { stage: task.column, consent: true, trigger: 'automation' });
        return this.set(projectId, a => { a.current = { ...a.current, stage: task.column, step: 'working', enteredAt: Date.now() - 1 }; });
      }
      if (!live) {
        // No agent in this column (for example it was stopped, or the app restarted): start it here again. A resumed
        // conversation is told to carry on; without input it would sit idle and this column would never finish.
        await this.board.requestRun(task.id, { stage: task.column, consent: true, trigger: 'automation', continuation: RESUME_MESSAGE });
        const fresh = (await this.board.state()).runs.filter(run => run.taskId === task.id && ['queued', 'running', 'waiting_for_input'].includes(run.status)).at(-1);
        return this.set(projectId, a => { a.current = { ...a.current, stage: task.column, step: 'working', turns: fresh?.turns ?? 0 }; });
      }
      // An agent that is already idle has finished its turn in this column.
      return this.set(projectId, a => { a.current = { ...a.current, stage: task.column, step: 'working', turns: live.turnComplete ? live.turns - 1 : live.turns }; });
    }
    if (cur.step === 'enter') {
      const next = cur.stage ? route[route.indexOf(cur.stage) + 1] : route[0];
      if (!next) {
        await this.set(projectId, (a, log) => { a.current = { ...a.current, step: 'finishing' }; log(`“${task.title}”: all columns finished.`); });
        return this.pipelineMove(task, done);
      }
      const enteredAt = Date.now() - 1;
      await this.pipelineMove(task, next, 'start');
      const fresh = (await this.board.state()).runs.filter(run => run.taskId === task.id && ['queued', 'running', 'waiting_for_input'].includes(run.status)).at(-1);
      return this.set(projectId, (a, log) => { a.current = { ...a.current, stage: next, step: 'working', turns: fresh?.turns ?? 0, enteredAt }; log(`“${task.title}” → ${name(next)}.`); });
    }
    // step 'working'
    if (columnStage(project, cur.stage) && task.column === cur.stage) return this.stageStep(projectId, project, task, cur, route, runs, live, name);
    if (task.column !== cur.stage) {
      // An approved plan moves the card on by itself; any later Autopilot column is accepted.
      if (route.indexOf(task.column) > route.indexOf(cur.stage)) return this.set(projectId, (a, log) => { a.current = { ...a.current, stage: task.column, step: 'working', turns: live?.turns ?? 0 }; log(`“${task.title}” → ${name(task.column)} (approved plan).`); });
      return this.pause(projectId, `“${task.title}” was moved to ${name(task.column)} by hand. Resume to continue from there, or skip it.`);
    }
    if (task.automationMove?.status === 'blocked') return this.pause(projectId, `The column automations of “${task.title}” are blocked: their cleanup is unconfirmed. Stop them from the card, then resume, or skip the card.`);
    if (!live) {
      const last = runs.at(-1);
      return this.pause(projectId, `The ${name(cur.stage)} agent for “${task.title}” ${last ? `${last.status}${last.reason ? `: ${last.reason.replace(/[.\s]+$/, '')}` : ''}` : 'is not running'}. Start it again from the card, then resume, or skip the card.`);
    }
    if (task.pendingAutomationMessages?.length || (task.automationMove && !['completed', 'failed', 'cancelled', 'interrupted'].includes(task.automationMove.status))) return;
    const finished = live.status === 'waiting_for_input' && live.turnComplete && (live.activity ? live.activity.ready : true) && live.turns > cur.turns;
    if (!finished) return;
    // A column whose instruction never reached the agent is not finished. Say so once; Resume continues without it.
    const undelivered = await this.undeliveredInstruction(task, cur.stage);
    if (undelivered && cur.undelivered !== undelivered.transitionId)
      return this.pause(projectId, `The ${name(cur.stage)} instruction for “${task.title}” did not reach its agent: ${undelivered.reason} Send it yourself in the terminal, then resume.`, { undelivered: undelivered.transitionId });
    // A plan column moves on only through your approval of the plan in the terminal.
    if (resolvePipelineStrategy(project.pipeline, cur.stage, task).planExitTargetId) return;
    return this.set(projectId, (a, log) => { a.current = { ...a.current, step: 'enter' }; log(`“${task.title}”: ${name(cur.stage)} finished.`); });
  }

  /** A typed column: act on the board's recorded outcome for this column (never on agent prose or a quiet terminal). */
  async stageStep(projectId, project, task, cur, route, runs, live, name) {
    if (task.automationMove?.status === 'blocked') return this.pause(projectId, `The column automations of “${task.title}” are blocked: their cleanup is unconfirmed. Stop them from the card, then resume, or skip the card.`);
    if (task.automationMove && !['completed', 'failed', 'cancelled', 'interrupted'].includes(task.automationMove.status)) return;
    const outcome = task.stageOutcome;
    if (!outcome || outcome.columnId !== cur.stage || outcome.at < (cur.enteredAt || 0)) {
      if (live) return;
      const last = runs.at(-1);
      return this.pause(projectId, `The ${name(cur.stage)} column of “${task.title}” has no running agent${last ? ` (last run ${last.status}${last.reason ? `: ${last.reason.replace(/[.\s]+$/, '')}` : ''})` : ''}. Start it from the card, then resume, or skip the card.`);
    }
    if (outcome.status === 'working' || outcome.status === 'verifying') return;
    if (outcome.status === 'succeeded') return this.set(projectId, (a, log) => { a.current = { ...a.current, step: 'enter' }; log(`“${task.title}”: ${name(cur.stage)} finished.`); });
    if (outcome.status === 'changes_required') return this.stageRework(projectId, project, task, cur, route, outcome, name);
    return this.pause(projectId, `“${task.title}”: ${name(cur.stage)} failed${outcome.code ? ` (${outcome.code})` : ''}: ${(outcome.reason || 'no reason was recorded').replace(/[.\s]+$/, '')}. Fix it, then resume, or skip the card.`);
  }

  /** Review findings, failing tests or a resolved merge send the card back along its route, within the rework limit. */
  async stageRework(projectId, project, task, cur, route, outcome, name) {
    const maxRework = project.execution?.maxRework ?? EXECUTION_DEFAULTS.maxRework;
    const wanted = outcome.next === 'code_review' ? 'code_review' : 'executing';
    const before = route.slice(0, route.indexOf(cur.stage) + 1).reverse();
    const target = before.find(id => columnStage(project, id) === wanted) || route.find(id => columnStage(project, id) === wanted);
    if (!target) return this.pause(projectId, `“${task.title}”: ${name(cur.stage)} needs ${wanted === 'executing' ? 'an Executing' : 'a Code Review'} column for rework, and the Autopilot route has none. Fix it by hand, then resume, or skip the card.`);
    // Every rework round counts, including a resolved merge going back to review, so nothing can loop forever.
    const attempts = cur.attempts || 0;
    if (attempts >= maxRework) return this.pause(projectId, `“${task.title}”: REWORK_LIMIT_REACHED after ${attempts} rework ${attempts === 1 ? 'round' : 'rounds'} (${(outcome.reason || '').replace(/[.\s]+$/, '')}). Fix it by hand, then resume, or skip the card.`);
    const enteredAt = Date.now() - 1;
    await this.pipelineMove(task, target, 'start');
    return this.set(projectId, (a, log) => {
      a.current = { ...a.current, stage: target, step: 'working', enteredAt, attempts: attempts + 1 };
      log(`“${task.title}”: ${(outcome.reason || name(cur.stage)).replace(/[.\s]+$/, '')}; back to ${name(target)} (rework ${attempts + 1}/${maxRework}).`);
    });
  }

  /** The board's own pipeline move, with its checks and column automations; marked as Autopilot's. */
  async pipelineMove(task, column, decision) {
    const fresh = (await this.board.state()).projects.flatMap(project => project.tasks).find(item => item.id === task.id);
    return this.board.transition(task.id, { column, expectedRevision: fresh.revision, ...(decision ? { decision } : {}), trigger: 'automation' });
  }

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
      // An agent still working in this stage is followed, not started a second time.
      const live = stage && state.runs.findLast(run => run.taskId === task.id && run.stage === stage && ['queued', 'running', 'waiting_for_input'].includes(run.status));
      return this.set(projectId, a => { a.current = { ...a.current, stage, step: live ? { testing: 'agent', merge: 'resolving' }[stage] || 'running' : 'start', runId: live?.id || null, testsId: null }; });
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
      if (done.has(run.status)) return this.pause(projectId, `The ${title(stage)} agent for “${task.title}” ${run.status}${run.reason ? `: ${run.reason.replace(/[.\s]+$/, '')}` : ''}.`);
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
