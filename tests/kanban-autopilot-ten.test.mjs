// Ten ordered cards through the typed-column stage engine with Full Autopilot: real Git, the real supervisor and PTYs, simulated CLIs
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

test('Autopilot runs ten cards strictly in the chosen order, one at a time through every column, each from the target containing the previous card', { skip, timeout: 300000 }, async t => {
  const w = await world(t, { agents: { executing: 'codex', code_review: 'claude', testing: 'codex' } });
  await w.board.applyFullAutopilot(w.project.id, { expectedRevision: (await w.projectNow()).revision, confirm: true });
  const cards = [];
  for (let index = 1; index <= 10; index++) cards.push(await w.board.createTask({ projectId: w.project.id, title: `Card ${index}`, prompt: `Card ${index}. WRITE_FILE:card-${index}.txt` }));
  // A shuffled queue: Autopilot must follow it exactly, not the creation order.
  const queue = [7, 2, 9, 1, 10, 4, 6, 3, 8, 5].map(number => cards[number - 1].id);
  let project = await w.projectNow();
  await w.board.setAutopilot(w.project.id, { route: ['executing', 'code_review', 'testing', 'merge'], queue, expectedRevision: project.revision });
  await w.board.controlAutopilot(w.project.id, { action: 'start', confirm: true });
  const autopilot = new Autopilot(w.board, { tickMs: 1e9 }), order = [];
  await until(async () => {
    await autopilot.tick();
    project = await w.projectNow();
    const current = project.autopilot.current?.taskId;
    if (current && order.at(-1) !== current) order.push(current);
    assert.ok(project.tasks.filter(item => !['todo', 'done'].includes(item.column)).length <= 1, 'One card at a time.');
    if (project.autopilot.status === 'paused') assert.fail(`Autopilot paused: ${project.autopilot.reason}`);
    return project.autopilot.status === 'finished';
  }, 'ten cards finished', 280000);
  assert.deepEqual(order, queue, 'Exact queue order.');
  const runs = (await w.board.state()).runs, merged = Object.fromEntries(project.tasks.map(item => [item.id, item.completion]));
  for (const [index, id] of queue.entries()) {
    const card = project.tasks.find(item => item.id === id);
    assert.equal(card.column, 'done'); assert.equal(card.completion.kind, 'merged');
    assert.deepEqual(card.stageHistory.map(item => item.columnId), ['executing', 'code_review', 'testing'], `${card.title} visited every agent column (Merge is Promptboard's own step).`);
    const first = runs.filter(run => run.taskId === id).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (index > 0) assert.equal(first.startCommit, merged[queue[index - 1]].mergedCommit, `${card.title} started from the target containing the card before it.`);
  }
  assert.equal(git(w.root, 'rev-list', '--count', 'trunk'), '11', 'One squash commit per card.');
  for (let index = 1; index <= 10; index++) assert.ok(git(w.root, 'ls-tree', '--name-only', 'trunk', `card-${index}.txt`), `card-${index}.txt is on trunk`);
});
