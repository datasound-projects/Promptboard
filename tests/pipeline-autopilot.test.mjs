import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from '../src/board.mjs';
import { Autopilot } from '../src/autopilot.mjs';
import { defaultPipelineConfig } from '../src/pipeline-config.mjs';
import { resolveConfig } from '../src/agents.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } }).trim();
async function temp(t) { const path = await realpath(await mkdtemp(join(tmpdir(), 'pb-autopilot-'))); t.after(() => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return path; }

/** A pipeline board with a stub executor: runs are recorded, and agent turns are simulated through updateRun. */
async function world(t, { instruct = [], profiles = [] } = {}) {
  const dataDir = await temp(t), root = await temp(t), board = new Board({ dataDir });
  git(root, 'init', '-q', '-b', 'trunk'); git(root, 'config', 'user.email', 'fixture@example.test'); git(root, 'config', 'user.name', 'Fixture');
  await writeFile(join(root, 'README.md'), 'main\n'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'Fixture');
  const project = await board.createProject({ name: 'Pipeline', workflowMode: 'pipeline' });
  await board.linkRepository(project.id, { path: root, expectedRevision: project.revision });
  const starts = [];
  board.executor = { validate: async ({ stage, config }) => resolveConfig(stage, config), start: async payload => { starts.push(payload.run.id); },
    suspend: async id => board.updateRun(id, { status: 'suspended' }), cancel: async id => board.updateRun(id, { status: 'cancelled' }) };
  const config = defaultPipelineConfig(); config.profiles = profiles;
  for (const id of instruct) config.columns.find(column => column.id === id).automations.onEnter.push({ name: 'Autopilot instruction', type: 'send_message', mode: 'deferred', message: `Do the ${id} step.` });
  await board.setPipeline(project.id, { pipeline: config, expectedRevision: (await board.state()).projects[0].revision });
  const projectNow = async () => (await board.state()).projects[0];
  const live = async taskId => (await board.state()).runs.filter(run => run.taskId === taskId && ['queued', 'running', 'waiting_for_input'].includes(run.status)).at(-1);
  // Simulate the agent finishing one more turn and settling.
  const finishTurn = async taskId => { const run = await live(taskId); if (run.status === 'queued') await board.updateRun(run.id, { status: 'running' }); await board.updateRun(run.id, { status: 'waiting_for_input', turnComplete: true, turns: (run.turns || 0) + 1, activity: { phase: 'idle', ready: true } }); };
  const autopilot = new Autopilot(board);
  const tick = async (times = 1) => { for (let index = 0; index < times; index++) await autopilot.tick(); };
  return { board, project, projectNow, live, finishTurn, tick, starts };
}

test('pipeline Autopilot settings: active columns only, and every later column needs an instruction', async t => {
  const { board, project, projectNow } = await world(t);
  const card = await board.createTask({ projectId: project.id, title: 'Card' });
  await assert.rejects(board.setAutopilot(project.id, { route: ['todo'], queue: [card.id], expectedRevision: (await projectNow()).revision }), { code: 'INVALID_AUTOPILOT' });
  // Executing → Code Review: Code Review would receive nothing new, so Autopilot refuses to start.
  await board.setAutopilot(project.id, { route: ['code_review', 'executing'], queue: [card.id], expectedRevision: (await projectNow()).revision });
  assert.deepEqual((await projectNow()).autopilot.route, ['executing', 'code_review'], 'kept in board order');
  await assert.rejects(board.controlAutopilot(project.id, { action: 'start', confirm: true }), error => error.code === 'AUTOPILOT_INSTRUCTION_MISSING' && /“Code Review”/.test(error.message));
  await assert.rejects(board.controlAutopilot(project.id, { action: 'start' }), { code: 'CONFIRMATION_REQUIRED' });
  // Planning → Executing is fine: the approved plan itself moves the card on with its instruction.
  await board.setAutopilot(project.id, { route: ['planning', 'executing'], queue: [card.id], expectedRevision: (await projectNow()).revision });
  assert.equal((await board.controlAutopilot(project.id, { action: 'start', confirm: true })).autopilot.status, 'running');
});

test('pipeline Autopilot takes each queued card through its columns to Done, one at a time, without merging', async t => {
  const { board, project, projectNow, live, finishTurn, tick } = await world(t, { instruct: ['code_review'] });
  const first = await board.createTask({ projectId: project.id, title: 'First' }), second = await board.createTask({ projectId: project.id, title: 'Second' });
  await board.setAutopilot(project.id, { route: ['executing', 'code_review'], queue: [first.id, second.id], expectedRevision: (await projectNow()).revision });
  await board.controlAutopilot(project.id, { action: 'start', confirm: true });
  await tick(2);
  let state = await projectNow();
  assert.equal(state.tasks.find(task => task.id === first.id).column, 'executing'); assert.equal(state.autopilot.current.step, 'working');
  assert.equal(state.tasks.find(task => task.id === second.id).column, 'todo', 'one card at a time');
  assert.equal((await live(first.id)).trigger, 'automation');
  await tick(3);
  assert.equal((await projectNow()).tasks.find(task => task.id === first.id).column, 'executing', 'waits until the agent finishes its turn');
  await finishTurn(first.id); await tick(2);
  state = await projectNow();
  assert.equal(state.tasks.find(task => task.id === first.id).column, 'code_review');
  // Code Review waits for its instruction to be delivered and for a new finished turn.
  await board.store.update(draft => { draft.projects[0].tasks.find(task => task.id === first.id).pendingAutomationMessages = [{ projectId: project.id, taskId: first.id, transitionId: 'pending-message' }]; });
  await tick(3);
  assert.equal((await projectNow()).tasks.find(task => task.id === first.id).column, 'code_review');
  await board.store.update(draft => { delete draft.projects[0].tasks.find(task => task.id === first.id).pendingAutomationMessages; });
  await tick(2);
  assert.equal((await projectNow()).tasks.find(task => task.id === first.id).column, 'code_review', 'an earlier finished turn does not count');
  await finishTurn(first.id); await tick(3);
  // This stub has no native transport, so the Code Review instruction never reached the agent:
  // Autopilot says so instead of calling the column finished, and Resume continues without it.
  state = await projectNow();
  assert.equal(state.tasks.find(task => task.id === first.id).column, 'code_review');
  assert.equal(state.autopilot.status, 'paused'); assert.match(state.autopilot.reason, /Code Review instruction for “First” did not reach its agent/);
  await board.controlAutopilot(project.id, { action: 'resume' }); await tick(4);
  state = await projectNow();
  assert.equal(state.tasks.find(task => task.id === first.id).column, 'done');
  assert.equal(state.autopilot.status, 'running', 'moving its own card to Done does not pause Autopilot');
  await tick(2);
  assert.equal((await projectNow()).tasks.find(task => task.id === second.id).column, 'executing', 'then the next card');
  await finishTurn(second.id); await tick(2); await finishTurn(second.id); await tick(4);
  assert.equal((await projectNow()).autopilot.status, 'paused', 'each undelivered instruction is reported once');
  await board.controlAutopilot(project.id, { action: 'resume' }); await tick(6);
  state = await projectNow();
  assert.deepEqual(state.tasks.map(task => task.column), ['done', 'done']);
  assert.equal(state.autopilot.status, 'finished');
  assert.ok(state.autopilot.log.some(entry => /all columns finished/.test(entry.text)));
  assert.equal(state.tasks.every(task => !task.completion), true, 'nothing was merged');
});

test('pipeline Autopilot follows an approved plan, and pauses for a hand move or a stopped agent', async t => {
  const { board, project, projectNow, live, finishTurn, tick } = await world(t);
  const card = await board.createTask({ projectId: project.id, title: 'Planned' });
  await board.setAutopilot(project.id, { route: ['planning', 'executing'], queue: [card.id], expectedRevision: (await projectNow()).revision });
  await board.controlAutopilot(project.id, { action: 'start', confirm: true });
  await tick(2);
  assert.equal((await projectNow()).tasks[0].column, 'planning');
  // A finished planning turn alone does not move the card: the plan needs your approval.
  await finishTurn(card.id); await tick(3);
  assert.equal((await projectNow()).tasks[0].column, 'planning');
  // The approved plan moves the card (as routeApprovedPlan does); Autopilot continues from there.
  await board.transition(card.id, { column: 'executing', expectedRevision: (await projectNow()).tasks[0].revision, trigger: 'automation' });
  await tick();
  let ap = (await projectNow()).autopilot;
  assert.equal(ap.current.stage, 'executing'); assert.equal(ap.status, 'running');
  // A move by hand to a column outside the route pauses Autopilot.
  await board.transition(card.id, { column: 'testing', expectedRevision: (await projectNow()).tasks[0].revision });
  await tick();
  ap = (await projectNow()).autopilot;
  assert.equal(ap.status, 'paused'); assert.match(ap.reason, /moved to Testing by hand/);
  // Resume from a route column; an agent that stopped pauses again with the reason.
  await board.transition(card.id, { column: 'executing', expectedRevision: (await projectNow()).tasks[0].revision });
  await board.controlAutopilot(project.id, { action: 'resume' }); await tick();
  const run = await live(card.id); await board.updateRun(run.id, { status: 'running' }); await board.updateRun(run.id, { status: 'failed', reason: 'quota' });
  await tick();
  ap = (await projectNow()).autopilot;
  assert.equal(ap.status, 'paused'); assert.match(ap.reason, /Executing agent for “Planned” failed/);
  assert.ok(finishTurn);
});

test('only a pause you cause stops Autopilot; system handoffs and its own Done move do not', async t => {
  const { board, project, projectNow, live, tick } = await world(t);
  const card = await board.createTask({ projectId: project.id, title: 'Card' });
  await board.setAutopilot(project.id, { route: ['executing'], queue: [card.id], expectedRevision: (await projectNow()).revision });
  await board.controlAutopilot(project.id, { action: 'start', confirm: true });
  await tick(2);
  const run = await live(card.id), session = (await board.state()).sessions.find(item => item.id === run.sessionId);
  assert.ok(session);
  await board.beginSuspension(run.id, { intent: 'system' });
  assert.equal((await projectNow()).autopilot.status, 'running');
  await board.store.update(draft => { draft.projects[0].autopilot.current.step = 'finishing'; });
  await board.beginSuspension(run.id);
  assert.equal((await projectNow()).autopilot.status, 'running');
  // Pausing another card's agent (for example by moving it to Done) leaves Autopilot running.
  await board.store.update(draft => { draft.projects[0].autopilot.current.step = 'working'; draft.projects[0].autopilot.current.taskId = 'another-card'; });
  await board.beginSuspension(run.id);
  assert.equal((await projectNow()).autopilot.status, 'running', 'another card does not pause Autopilot');
  await board.store.update(draft => { draft.projects[0].autopilot.current.taskId = card.id; });
  await board.beginSuspension(run.id);
  const paused = (await projectNow()).autopilot;
  assert.equal(paused.status, 'paused');
  assert.equal(paused.log.at(-1).text, 'Paused: The task agent was paused by you.', 'the pause is logged');
});

test('resume starts a stopped column agent again', async t => {
  const { board, project, projectNow, live, tick, starts } = await world(t);
  const card = await board.createTask({ projectId: project.id, title: 'Card' });
  await board.setAutopilot(project.id, { route: ['executing'], queue: [card.id], expectedRevision: (await projectNow()).revision });
  await board.controlAutopilot(project.id, { action: 'start', confirm: true });
  await tick(2);
  const first = await live(card.id);
  await board.controlAutopilot(project.id, { action: 'pause' });
  await board.updateRun(first.id, { status: 'cancelled' });
  await board.controlAutopilot(project.id, { action: 'resume' });
  await tick(2);
  const again = await live(card.id);
  assert.ok(again && again.id !== first.id, 'a new run in the same column'); assert.equal(again.stage, 'executing'); assert.equal(again.trigger, 'automation');
  assert.deepEqual(starts, [first.id, again.id]);
  assert.equal((await projectNow()).autopilot.status, 'running');
});

test('a card profile without a plan route: Autopilot needs an instruction, then moves on from Planning after its turn', async t => {
  const profiles = [{ id: 'fast', name: 'Fast', columns: { planning: { planExitTargetId: null, permissionMode: null } } }];
  const setup = async (instruct) => {
    const w = await world(t, { profiles, instruct });
    const card = await w.board.createTask({ projectId: w.project.id, title: 'Card', pipelineSettings: { profileId: 'fast' }, expectedProjectRevision: (await w.projectNow()).revision });
    await w.board.setAutopilot(w.project.id, { route: ['planning', 'executing'], queue: [card.id], expectedRevision: (await w.projectNow()).revision });
    return { ...w, card };
  };
  const bare = await setup([]);
  await assert.rejects(bare.board.controlAutopilot(bare.project.id, { action: 'start', confirm: true }), error => error.code === 'AUTOPILOT_INSTRUCTION_MISSING' && /“Executing”/.test(error.message));
  const { board, project, projectNow, card, finishTurn, tick } = await setup(['executing']);
  await board.controlAutopilot(project.id, { action: 'start', confirm: true });
  await tick(2);
  assert.equal((await projectNow()).tasks[0].column, 'planning');
  await finishTurn(card.id); await tick(3);
  assert.equal((await projectNow()).tasks[0].column, 'executing', 'no plan approval is waited for');
});

test('a blocked column automation pauses Autopilot and refuses new agent starts instead of parking them', async t => {
  const { board, project, projectNow, live, tick, starts } = await world(t);
  const card = await board.createTask({ projectId: project.id, title: 'Card' });
  await board.setAutopilot(project.id, { route: ['executing'], queue: [card.id], expectedRevision: (await projectNow()).revision });
  await board.controlAutopilot(project.id, { action: 'start', confirm: true });
  await tick(2);
  const run = await live(card.id);
  // A move whose cleanup is unconfirmed stays blocked until “Stop automations”.
  const key = { projectId: project.id, taskId: card.id, transitionId: 'blocked-move' };
  board.automationMoves.set(card.id, { key, controller: new AbortController(), blocked: true, deferNativeStart: true, done: Promise.resolve() });
  await board.store.update(draft => { draft.projects[0].tasks[0].automationMove = { ...key, status: 'blocked', phase: 'enter' }; });
  await tick();
  const ap = (await projectNow()).autopilot;
  assert.equal(ap.status, 'paused'); assert.match(ap.reason, /automations of “Card” are blocked/);
  await board.updateRun(run.id, { status: 'cancelled' });
  await assert.rejects(board.requestRun(card.id, { stage: 'executing', consent: true }), { code: 'AUTOMATIONS_ACTIVE' });
  assert.equal(await live(card.id), undefined, 'no queued run is left behind'); assert.deepEqual(starts, [run.id]);
});

test('a Skip while a step is under way is not overwritten by that step', async t => {
  const { board, project, projectNow, tick } = await world(t);
  const first = await board.createTask({ projectId: project.id, title: 'First' }), second = await board.createTask({ projectId: project.id, title: 'Second' });
  await board.setAutopilot(project.id, { route: ['executing'], queue: [first.id, second.id], expectedRevision: (await projectNow()).revision });
  await board.controlAutopilot(project.id, { action: 'start', confirm: true });
  await tick();
  const transition = board.transition;
  board.transition = async (...args) => { const result = await transition.apply(board, args); await board.controlAutopilot(project.id, { action: 'skip' }); return result; };
  await tick();
  board.transition = transition;
  let ap = (await projectNow()).autopilot;
  assert.equal(ap.current, null); assert.deepEqual(ap.done, [first.id]);
  await tick(2);
  ap = (await projectNow()).autopilot;
  assert.equal(ap.current.taskId, second.id); assert.deepEqual(ap.done, [first.id]);
  assert.equal(ap.log.some(entry => /deleted/.test(entry.text)), false);
});
