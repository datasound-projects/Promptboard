#!/usr/bin/env node
/**
 * OPT-IN live Kanban end-to-end run with real, signed-in CLIs. Consumes provider usage. Works only in a disposable
 * repository and data folder it creates (and deletes unless --keep). It never answers anything in a terminal: the
 * board's own Full Autopilot preset (workspace trust included) must get every card from To Do to Done.
 *
 *   node scripts/live-kanban.mjs [--tasks 2] [--plan codex] [--exec codex] [--review claude] [--test claude]
 *     [--claude-model haiku] [--codex-model ''] [--minutes 30] [--keep]
 *
 * Reports, as JSON on stdout: the queue order Autopilot followed, every stage outcome with its provider, each merge,
 * the final target branch and its test result, and every moment an agent waited for a person (permission prompts,
 * questions, not-ready input). A clean run has zero such waits.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from '../src/board.mjs';
import { Supervisor } from '../src/supervisor.mjs';
import { Autopilot } from '../src/autopilot.mjs';
import { defaultPipelineConfig } from '../src/pipeline-config.mjs';

const option = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at > 0 ? process.argv[at + 1] : fallback; };
const tasks = Number(option('tasks', '2')), minutes = Number(option('minutes', '30')), keep = process.argv.includes('--keep');
const agents = { planning: option('plan', 'codex'), executing: option('exec', 'codex'), code_review: option('review', 'claude'), testing: option('test', 'claude') };
const models = { claude: option('claude-model', 'haiku'), codex: option('codex-model', ''), gemini: option('gemini-model', '') };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const log = (...args) => console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...args);

const root = await realpath(await mkdtemp(join(tmpdir(), 'pb-live-kanban-repo-')));
const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'pb-live-kanban-data-')));
git(root, 'init', '-q', '-b', 'trunk');
git(root, 'config', 'user.email', 'live@example.invalid'); git(root, 'config', 'user.name', 'Live Kanban');
// A tiny project whose test command checks exactly what each card asks for.
await writeFile(join(root, 'math.js'), "'use strict';\n\nmodule.exports = {};\n");
await writeFile(join(root, 'test.js'), "'use strict';\nconst math = require('./math.js');\nconst assert = require('node:assert/strict');\nconst checks = require('./checks.json');\nfor (const [name, args, expected] of checks) assert.equal(math[name](...args), expected, name);\nconsole.log(`${checks.length} checks passed`);\n");
await writeFile(join(root, 'checks.json'), '[]\n');
// As in a real project: folders the user's CLI tools write on their own (for example a Serena MCP server's .serena/) are ignored.
await writeFile(join(root, '.gitignore'), '.serena/\n');
git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'Start the math library');
const work = [
  ['Add an add function', 'In math.js, export a function add(a, b) that returns the sum of two numbers. Add the check ["add", [2, 3], 5] to checks.json (keep the JSON array valid). Change nothing else.'],
  ['Add a multiply function', 'In math.js, export a function multiply(a, b) that returns the product of two numbers, keeping every existing export. Add the check ["multiply", [4, 5], 20] to checks.json (keep the JSON array valid and keep existing checks). Change nothing else.'],
  ['Add a negate function', 'In math.js, export a function negate(a) that returns -a, keeping every existing export. Add the check ["negate", [7], -7] to checks.json (keep the JSON array valid and keep existing checks). Change nothing else.'],
].slice(0, tasks);

const board = new Board({ dataDir }), supervisor = new Supervisor({ board, dataDir });
board.executor = supervisor;
const report = { agents, models, tasks: work.map(([title]) => title), order: [], outcomes: [], merges: [], waits: [], trunk: null, verdict: 'unknown' };
const seenWaits = new Set();
try {
  const project = await board.createProject({ name: 'Live Kanban', workflowMode: 'pipeline' });
  await board.linkRepository(project.id, { path: root, expectedRevision: project.revision });
  const now = async () => (await board.state()).projects[0];
  await board.setTargetBranch(project.id, { branch: 'trunk', expectedRevision: (await now()).revision });
  const config = defaultPipelineConfig();
  for (const [id, provider] of Object.entries(agents)) Object.assign(config.columns.find(column => column.id === id).strategy, { agentOverride: provider, ...(models[provider] ? { modelOverride: models[provider] } : {}) });
  await board.setPipeline(project.id, { pipeline: config, expectedRevision: (await now()).revision });
  await board.delivery.setTestCommands(project.id, { commands: [{ command: 'node test.js', label: 'math checks' }], expectedRevision: (await now()).revision });
  await board.applyFullAutopilot(project.id, { expectedRevision: (await now()).revision, confirm: true });
  const cards = [];
  for (const [title, prompt] of work) cards.push(await board.createTask({ projectId: project.id, title, prompt }));
  const queue = cards.map(card => card.id).reverse(); // Deliberately not creation order: Autopilot must follow the queue.
  report.queue = queue.map(id => cards.find(card => card.id === id).title);
  await board.setAutopilot(project.id, { route: (await now()).autopilot.route, queue, expectedRevision: (await now()).revision });
  await board.controlAutopilot(project.id, { action: 'start', confirm: true });
  const autopilot = new Autopilot(board, { tickMs: 1e9 });
  const deadline = Date.now() + minutes * 60000;
  for (;;) {
    await autopilot.tick();
    const state = await board.state(), current = state.projects[0];
    const id = current.autopilot.current?.taskId;
    const title = id && current.tasks.find(task => task.id === id)?.title;
    if (title && report.order.at(-1) !== title) { report.order.push(title); log('card', title); }
    // Any moment an agent waits for a person is recorded once per run and reason.
    for (const run of state.runs.filter(item => ['running', 'waiting_for_input'].includes(item.status))) {
      const waiting = (run.status === 'waiting_for_input' && !run.turnComplete) || run.lifecycle === 'initial-input-not-ready' || run.activity?.permissionPending;
      const key = `${run.id}:${run.waitingReason || run.lifecycle}`;
      if (waiting && !seenWaits.has(key)) { seenWaits.add(key); report.waits.push({ card: current.tasks.find(task => task.id === run.taskId)?.title, column: run.stage, provider: run.config.provider, reason: run.waitingReason || run.lifecycle }); log('WAIT', run.config.provider, run.stage, run.waitingReason || run.lifecycle); }
    }
    if (current.autopilot.status === 'finished') { report.verdict = 'finished'; break; }
    if (current.autopilot.status === 'paused') { report.verdict = `paused: ${current.autopilot.reason}`; break; }
    if (Date.now() > deadline) { report.verdict = 'timeout'; break; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const final = await now();
  for (const task of final.tasks) {
    report.outcomes.push({ card: task.title, column: task.column, stages: (task.stageHistory || []).map(item => `${item.columnId}:${item.provider || 'promptboard'}:${item.status}${item.code ? `(${item.code})` : ''}`) });
    if (task.completion?.kind === 'merged') report.merges.push({ card: task.title, commit: task.completion.mergedCommit.slice(0, 12), squash: task.completion.squash, onto: task.completion.previousTarget.slice(0, 12) });
  }
  report.autopilotLog = final.autopilot.log.map(entry => entry.text);
  report.trunk = git(root, 'log', '--format=%h %s', 'trunk').split('\n');
  try { report.trunkTests = execFileSync(process.execPath, ['test.js'], { cwd: root, encoding: 'utf8' }).trim(); } catch (error) { report.trunkTests = `FAILED: ${String(error.stdout || error.message).trim()}`; }
} catch (error) { report.verdict = `error: ${error.code || ''} ${error.message}`; }
finally {
  await supervisor.shutdown(3000).catch(() => {});
  if (!keep) { await rm(root, { recursive: true, force: true }); await rm(dataDir, { recursive: true, force: true }); } else Object.assign(report, { root, dataDir });
  console.log(JSON.stringify(report, null, 2));
}
