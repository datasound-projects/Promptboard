// Autopilot with real Git and real PTY sessions. Agents are SIMULATED by tests/fixtures/fake-agent.cjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Board, normalizeRoute } from '../src/board.mjs';
import { Supervisor } from '../src/supervisor.mjs';
import { Autopilot } from '../src/autopilot.mjs';

const skip = process.platform === 'win32';
const fake = fileURLToPath(new URL('./fixtures/fake-agent.cjs', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
async function temp(t, prefix) { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return dir; }
async function until(fn, label, ms = 60000) { const end = Date.now() + ms; for (;;) { const value = await fn(); if (value) return value; if (Date.now() > end) assert.fail(`Timed out: ${label}`); await new Promise(r => setTimeout(r, 50)); } }

async function world(t, testCommand = `${process.execPath} -e "process.exit(0)"`) {
  const bin = await temp(t, 'pb-ap-bin-');
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\nrequire(${JSON.stringify(fake)});\n`); await chmod(join(bin, 'claude'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  const root = await temp(t, 'pb-ap-repo-');
  git(root, 'init', '-q', '-b', 'trunk'); git(root, 'config', 'user.email', 't@example.com'); git(root, 'config', 'user.name', 'Tester');
  await writeFile(join(root, 'readme.txt'), 'hello\n'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'init');
  const dataDir = await temp(t, 'pb-ap-data-');
  const board = new Board({ dataDir });
  const supervisor = new Supervisor({ board, dataDir });
  board.executor = supervisor;
  const autopilot = new Autopilot(board, { tickMs: 50 });
  t.after(async () => { autopilot.stop(); await supervisor.shutdown(500); process.env.PATH = oldPath; });
  const project = await board.createProject({ name: 'Auto' });
  await board.linkRepository(project.id, { path: root, expectedRevision: 1 });
  await board.setTargetBranch(project.id, { branch: 'trunk', expectedRevision: 2 });
  await board.delivery.setTestCommands(project.id, { commands: [{ command: testCommand }], expectedRevision: 3 });
  const view = async () => (await board.view()).projects[0];
  const card = async (title, prompt) => (await board.createTask({ projectId: project.id, title, prompt })).id;
  return { board, supervisor, autopilot, root, project, view, card };
}

test('routes: stages in board order, Executing required, and the stage contract: Testing needs Code Review, Merge needs both', () => {
  assert.deepEqual(normalizeRoute(['merge', 'executing', 'code_review', 'testing']), ['executing', 'code_review', 'testing', 'merge']);
  assert.throws(() => normalizeRoute(['planning', 'code_review']), { code: 'INVALID_AUTOPILOT', message: /must include Executing/ });
  assert.throws(() => normalizeRoute(['executing', 'merge'], 'merge'), { message: /must include Code Review and Testing/ });
  assert.throws(() => normalizeRoute(['executing', 'merge'], 'pull_request'), { message: /must include Code Review and Testing/ });
  assert.throws(() => normalizeRoute(['executing', 'testing']), { message: /Testing must include Code Review/ });
  assert.deepEqual(normalizeRoute(['executing', 'code_review']), ['executing', 'code_review']);
  assert.throws(() => normalizeRoute(['executing', 'done']), { code: 'INVALID_AUTOPILOT' });
});

test('Autopilot takes queued cards one at a time through their own routes, in the chosen order, and merges each', { skip, timeout: 180000 }, async t => {
  const w = await world(t);
  const first = await w.card('First', 'Add the first file. WRITE_FILE:first.txt');
  const second = await w.card('Second', 'Add the second file. WRITE_FILE:second.txt');
  const skipped = await w.card('Not queued', 'Stay in To Do.');
  // Order: Second before First. First skips Planning (its own route).
  const route = ['planning', 'executing', 'code_review', 'testing', 'merge'];
  await w.board.setAutopilot(w.project.id, { route, finish: 'merge', maxRework: 1, queue: [second, first], routes: { [first]: ['executing', 'code_review', 'testing', 'merge'] }, expectedRevision: (await w.view()).revision });
  await assert.rejects(w.board.controlAutopilot(w.project.id, { action: 'start' }), { code: 'CONFIRMATION_REQUIRED' });
  await w.board.controlAutopilot(w.project.id, { action: 'start', confirm: true });
  await assert.rejects(w.board.setAutopilot(w.project.id, { route, queue: [], expectedRevision: (await w.view()).revision }), { code: 'AUTOPILOT_RUNNING' });
  w.autopilot.start();
  const ap = await until(async () => { const value = (await w.view()).autopilot; return ['finished', 'paused'].includes(value.status) && value; }, 'Autopilot finished', 150000);
  assert.equal(ap.status, 'finished', ap.reason);
  const tasks = (await w.view()).tasks;
  const byId = id => tasks.find(task => task.id === id);
  assert.equal(byId(second).column, 'done');
  assert.equal(byId(first).column, 'done');
  assert.equal(byId(second).completion.kind, 'merged');
  assert.equal(byId(first).completion.trigger, 'automation');
  assert.equal(byId(skipped).column, 'todo', 'Cards outside the queue are never touched.');
  // Both changes are on trunk, and the order was Second, then First.
  assert.deepEqual(git(w.root, 'ls-tree', '--name-only', 'trunk').split('\n').sort(), ['first.txt', 'readme.txt', 'second.txt']);
  const order = ap.log.map(entry => entry.text).filter(text => text.startsWith('Started'));
  assert.match(order[0], /^Started “Second” \(route: Planning → Executing → Code Review → Testing → Merge\)/);
  assert.match(order[1], /^Started “First” \(route: Executing → Code Review → Testing → Merge\)/);
  const runs = (await w.board.view()).runs;
  assert.deepEqual(runs.filter(run => run.taskId === first).map(run => run.stage), ['executing', 'code_review'], 'First never ran Planning.');
  assert.deepEqual(runs.filter(run => run.taskId === second).map(run => run.stage), ['planning', 'executing', 'code_review']);
  assert.ok(runs.every(run => run.trigger === 'automation' && run.status === 'succeeded'));
  // The second card branched from trunk after the first merge, so no extra update round was needed.
  assert.ok(!ap.log.some(entry => /moved on/.test(entry.text)), ap.log.map(entry => entry.text).join('\n'));
});

test('failing tests go back to Executing with the output, then Autopilot pauses at the rework limit; pause, skip, and stop are explicit', { skip, timeout: 180000 }, async t => {
  const w = await world(t, `${process.execPath} -e "console.error('boom: expected 2, got 3'); process.exit(1)"`);
  const task = await w.card('Broken', 'Change it. WRITE_FILE:broken.txt');
  await w.board.setAutopilot(w.project.id, { route: ['executing', 'code_review', 'testing', 'merge'], finish: 'merge', maxRework: 1, queue: [task], expectedRevision: (await w.view()).revision });
  await w.board.controlAutopilot(w.project.id, { action: 'start', confirm: true });
  w.autopilot.start();
  const ap = await until(async () => { const value = (await w.view()).autopilot; return value.status === 'paused' && value; }, 'paused at the rework limit', 150000);
  assert.match(ap.reason, /“Broken”: the tests failed after 1 rework round/);
  const current = (await w.view()).tasks[0];
  assert.equal(current.column, 'testing', 'The card stays where it stopped; nothing is merged.');
  assert.match(current.reworkNotes, /boom: expected 2, got 3/, 'The next Executing run gets the failing output.');
  assert.ok(ap.log.some(entry => /the tests failed; sent back to Executing \(rework 1\/1\)/.test(entry.text)));
  const runs = (await w.board.view()).runs.filter(run => run.stage === 'executing');
  assert.equal(runs.length, 2, 'One original run and one rework run.');
  // Skip leaves the card in place and finishes the queue.
  await w.board.controlAutopilot(w.project.id, { action: 'skip' });
  const finished = await until(async () => { const value = (await w.view()).autopilot; return value.status === 'finished' && value; }, 'finished after skip');
  assert.equal((await w.view()).tasks[0].column, 'testing');
  assert.ok(finished.log.some(entry => /Skipped the current card/.test(entry.text)));
  await w.board.controlAutopilot(w.project.id, { action: 'stop' });
  assert.equal((await w.view()).autopilot.status, 'off');
});

test('a permission prompt holds Autopilot until the agent finishes its turn', { skip, timeout: 120000 }, async t => {
  const w = await world(t);
  const task = await w.card('Asks', 'Please run a command. ASK_PERMISSION');
  await w.board.setAutopilot(w.project.id, { route: ['executing'], finish: 'pull_request', maxRework: 0, queue: [task], expectedRevision: (await w.view()).revision });
  await w.board.controlAutopilot(w.project.id, { action: 'start', confirm: true });
  w.autopilot.start();
  const run = await until(async () => { const found = (await w.board.view()).runs.find(item => item.taskId === task); return found?.status === 'waiting_for_input' && found; }, 'waiting for permission');
  assert.equal(run.turnComplete, false);
  await new Promise(r => setTimeout(r, 600));
  assert.equal((await w.board.run(run.id)).status, 'waiting_for_input', 'Autopilot does not confirm a stage while the agent waits for an answer.');
  assert.equal((await w.view()).autopilot.current.step, 'running');
  // The user answers in the terminal; the turn finishes; only now does Autopilot continue.
  w.supervisor.input(run.id, 'yes\r');
  await until(async () => (await w.board.run(run.id)).status === 'succeeded', 'confirmed after the turn');
});
