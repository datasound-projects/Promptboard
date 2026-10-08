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
async function world(t, { instruct = [] } = {}) {
  const dataDir = await temp(t), root = await temp(t), board = new Board({ dataDir });
  git(root, 'init', '-q', '-b', 'trunk'); git(root, 'config', 'user.email', 'fixture@example.test'); git(root, 'config', 'user.name', 'Fixture');
  await writeFile(join(root, 'README.md'), 'main\n'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'Fixture');
  const project = await board.createProject({ name: 'Pipeline', workflowMode: 'pipeline' });
  await board.linkRepository(project.id, { path: root, expectedRevision: project.revision });
  board.executor = { validate: async ({ stage, config }) => resolveConfig(stage, config), start: async () => {},
    suspend: async id => board.updateRun(id, { status: 'suspended' }), cancel: async id => board.updateRun(id, { status: 'cancelled' }) };
  const config = defaultPipelineConfig();
  for (const id of instruct) config.columns.find(column => column.id === id).automations.onEnter.push({ name: 'Autopilot instruction', type: 'send_message', mode: 'deferred', message: `Do the ${id} step.` });
  await board.setPipeline(project.id, { pipeline: config, expectedRevision: (await board.state()).projects[0].revision });
  const projectNow = async () => (await board.state()).projects[0];
  const live = async taskId => (await board.state()).runs.filter(run => run.taskId === taskId && ['queued', 'running', 'waiting_for_input'].includes(run.status)).at(-1);
  // Simulate the agent finishing one more turn and settling.
  const finishTurn = async taskId => { const run = await live(taskId); if (run.status === 'queued') await board.updateRun(run.id, { status: 'running' }); await board.updateRun(run.id, { status: 'waiting_for_input', turnComplete: true, turns: (run.turns || 0) + 1, activity: { phase: 'idle', ready: true } }); };
  const autopilot = new Autopilot(board);
  const tick = async (times = 1) => { for (let index = 0; index < times; index++) await autopilot.tick(); };
  return { board, project, projectNow, live, finishTurn, tick };
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
  state = await projectNow();
  assert.equal(state.tasks.find(task => task.id === first.id).column, 'done');
  assert.equal(state.autopilot.status, 'running', 'moving its own card to Done does not pause Autopilot');
  await tick(2);
  assert.equal((await projectNow()).tasks.find(task => task.id === second.id).column, 'executing', 'then the next card');
  await finishTurn(second.id); await tick(2); await finishTurn(second.id); await tick(4);
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
  await board.store.update(draft => { draft.projects[0].autopilot.current.step = 'working'; });
  await board.beginSuspension(run.id);
  assert.equal((await projectNow()).autopilot.status, 'paused');
});
