#!/usr/bin/env node
/**
 * OPT-IN live Kanban end-to-end run with real, signed-in CLIs. Consumes provider usage. Works only in a disposable
 * repository and data folder it creates (and deletes unless --keep). It never answers anything in a terminal: the
 * board's own Full Autopilot preset (workspace trust included) must get every card from To Do to Done.
 *
 *   node scripts/live-kanban.mjs [--tasks 2] [--plan codex] [--exec codex] [--review claude] [--test claude]
 *     [--claude-model haiku] [--codex-model ''] [--minutes 30] [--keep] [--no-test-commands] [--scenario portal]
 *
 * --no-test-commands leaves Testing without a configured command: the Testing agent must find and run the tests itself.
 * --scenario portal: five Origin-style cards in a prerequisite chain; the first carries the whole project's design. Each
 * merge's actual diff is compared with the files its own card allows (`scope` in the report).
 *
 * Reports, as JSON on stdout: the queue order Autopilot followed, every stage outcome with its provider, each merge,
 * the final target branch and its test result, and every moment an agent waited for a person (permission prompts,
 * questions, not-ready input). A clean run has zero such waits.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from '../src/board.mjs';
import { Supervisor } from '../src/supervisor.mjs';
import { Autopilot } from '../src/autopilot.mjs';
import { defaultPipelineConfig } from '../src/pipeline-config.mjs';

const option = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at > 0 ? process.argv[at + 1] : fallback; };
const scenario = option('scenario', 'math'), tasks = Number(option('tasks', scenario === 'portal' ? '5' : '2')), minutes = Number(option('minutes', '30')), keep = process.argv.includes('--keep'), agentTests = process.argv.includes('--no-test-commands');
const agents = { planning: option('plan', 'codex'), executing: option('exec', 'codex'), code_review: option('review', 'claude'), testing: option('test', 'claude') };
const models = { claude: option('claude-model', 'haiku'), codex: option('codex-model', ''), gemini: option('gemini-model', '') };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const log = (...args) => console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...args);

const root = await realpath(await mkdtemp(join(tmpdir(), 'pb-live-kanban-repo-')));
const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'pb-live-kanban-data-')));
git(root, 'init', '-q', '-b', 'trunk');
git(root, 'config', 'user.email', 'live@example.invalid'); git(root, 'config', 'user.name', 'Live Kanban');
// A tiny project whose test command checks exactly what each card asks for.
if (scenario === 'portal') await writeFile(join(root, 'test.js'), "'use strict';\nconst assert = require('node:assert/strict');\nconst checks = require('./checks.json');\nfor (const [file, name, args, expected] of checks) assert.deepEqual(require(`./${file}`)[name](...args), expected, `${file} ${name}`);\nconsole.log(`${checks.length} checks passed`);\n");
else {
  await writeFile(join(root, 'math.js'), "'use strict';\n\nmodule.exports = {};\n");
  await writeFile(join(root, 'test.js'), "'use strict';\nconst math = require('./math.js');\nconst assert = require('node:assert/strict');\nconst checks = require('./checks.json');\nfor (const [name, args, expected] of checks) assert.equal(math[name](...args), expected, name);\nconsole.log(`${checks.length} checks passed`);\n");
}
await writeFile(join(root, 'checks.json'), '[]\n');
// As in a real project: folders the user's CLI tools write on their own (for example a Serena MCP server's .serena/) are ignored.
await writeFile(join(root, '.gitignore'), '.serena/\n');
git(root, 'add', '.'); git(root, 'commit', '-q', '-m', scenario === 'portal' ? 'Start the notes portal' : 'Start the math library');
const work = [
  ['Add an add function', 'In math.js, export a function add(a, b) that returns the sum of two numbers. Add the check ["add", [2, 3], 5] to checks.json (keep the JSON array valid). Change nothing else.'],
  ['Add a multiply function', 'In math.js, export a function multiply(a, b) that returns the product of two numbers, keeping every existing export. Add the check ["multiply", [4, 5], 20] to checks.json (keep the JSON array valid and keep existing checks). Change nothing else.'],
  ['Add a negate function', 'In math.js, export a function negate(a) that returns -a, keeping every existing export. Add the check ["negate", [7], -7] to checks.json (keep the JSON array valid and keep existing checks). Change nothing else.'],
].slice(0, tasks);
// The portal: one design, five tasks that each own their files. Task 1's text carries the whole design on purpose.
const DESIGN = '# Context from the Origin design\nA notes portal for a small team: a foundation (src/app.js), in-memory storage (src/store.js), password checks (src/auth.js), request handlers (src/api.js) and a text UI (src/ui.js). Plain Node.js, CommonJS, no dependencies.';
const portal = [
  ['Application foundation', 'src/app.js', 'Create src/app.js exporting createApp(), which returns { name: "notes", version: "0.1.0" }. Add the check ["src/app.js", "createApp", [], { "name": "notes", "version": "0.1.0" }] to checks.json.'],
  ['Storage', 'src/store.js', 'Create src/store.js exporting createStore(), whose result has add(text) returning the new note { id, text } (ids 1, 2, …) and list() returning every note. Add the check ["src/store.js", "count", ["a", "b"], 2] to checks.json and export count(...texts) that adds them to a new store and returns list().length.'],
  ['Authentication', 'src/auth.js', 'Create src/auth.js exporting checkPassword(password), true only for a string of at least 8 characters with a digit. Add the checks ["src/auth.js", "checkPassword", ["abcdefg1"], true] and ["src/auth.js", "checkPassword", ["short1"], false] to checks.json.'],
  ['Request handlers', 'src/api.js', 'Create src/api.js exporting handle(method, path, body) using src/store.js: POST /notes adds { text } and returns { status: 201, note }, GET /notes returns { status: 200, notes }. Export demo(), which posts "hi" to a new store and returns the GET status. Add the check ["src/api.js", "demo", [], 200] to checks.json.'],
  ['Text UI', 'src/ui.js', 'Create src/ui.js exporting render(notes), one line "#<id> <text>" per note joined by "\\n". Add the check ["src/ui.js", "render", [[{ "id": 1, "text": "hi" }]], "#1 hi"] to checks.json.'],
].slice(0, tasks);

const board = new Board({ dataDir }), supervisor = new Supervisor({ board, dataDir });
board.executor = supervisor;
const report = { scenario, agents, models, tasks: (scenario === 'portal' ? portal : work).map(([title]) => title), order: [], outcomes: [], merges: [], waits: [], trunk: null, verdict: 'unknown' };
const seenWaits = new Set();
try {
  const project = await board.createProject({ name: 'Live Kanban', workflowMode: 'pipeline' });
  await board.linkRepository(project.id, { path: root, expectedRevision: project.revision });
  const now = async () => (await board.state()).projects[0];
  await board.setTargetBranch(project.id, { branch: 'trunk', expectedRevision: (await now()).revision });
  const config = defaultPipelineConfig();
  for (const [id, provider] of Object.entries(agents)) Object.assign(config.columns.find(column => column.id === id).strategy, { agentOverride: provider, ...(models[provider] ? { modelOverride: models[provider] } : {}) });
  await board.setPipeline(project.id, { pipeline: config, expectedRevision: (await now()).revision });
  if (!agentTests) await board.delivery.setTestCommands(project.id, { commands: [{ command: 'node test.js', label: scenario === 'portal' ? 'portal checks' : 'math checks' }], expectedRevision: (await now()).revision });
  await board.applyFullAutopilot(project.id, { expectedRevision: (await now()).revision, confirm: true });
  const cards = [];
  if (scenario === 'portal') {
    // As Origin sends them: one card per task, each after the one before, each with the design context.
    const made = await board.createOriginTasks(project.id, { originProjectId: 'live-portal', tasks: portal.map(([title, file, todo], index) => ({ originTaskId: `t${index + 1}`, key: `IMP-00${index + 1}`, title: `IMP-00${index + 1} ${title}`,
      prompt: `# IMP-00${index + 1} ${title}\n\n## What to do\n${todo}\n\n## Done when\n\`node test.js\` passes with the new check, and only ${file} and checks.json changed.\n\n---\n${DESIGN}`, ...(index ? { dependsOnOrigin: [`t${index}`] } : {}) })) });
    for (const row of made) cards.push((await now()).tasks.find(task => task.id === row.taskId));
  } else for (const [title, prompt] of work) cards.push(await board.createTask({ projectId: project.id, title, prompt }));
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
      const waiting = (run.status === 'waiting_for_input' && !run.turnComplete) || ['initial-input-not-ready', 'no-events-yet'].includes(run.lifecycle) || run.activity?.permissionPending;
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
    report.outcomes.push({ card: task.title, column: task.column, tests: task.evidence?.tests && { source: task.evidence.tests.source || 'promptboard', status: task.evidence.tests.status, commands: task.evidence.tests.results?.map(item => `${item.label} → ${item.exitCode}`) }, stages: (task.stageHistory || []).map(item => `${item.columnId}:${item.provider || 'promptboard'}:${item.status}${item.code ? `(${item.code})` : ''}`) });
    if (task.completion?.kind === 'merged') report.merges.push({ card: task.title, commit: task.completion.mergedCommit.slice(0, 12), squash: task.completion.squash, onto: task.completion.previousTarget.slice(0, 12) });
  }
  report.autopilotLog = final.autopilot.log.map(entry => entry.text);
  if (scenario === 'portal') {
    // Scope as Git shows it: each merge may touch only its card's own file and checks.json.
    const state = await board.state();
    report.scope = await Promise.all(cards.map(async (card, index) => {
      const task = final.tasks.find(item => item.id === card.id), allowed = [portal[index][1], 'checks.json'];
      const files = task.completion?.kind === 'merged' ? git(root, 'diff', '--name-only', task.completion.previousTarget, task.completion.mergedCommit).split('\n').filter(Boolean) : [];
      const exec = state.runs.filter(run => run.taskId === card.id && run.stageKind === 'executing')[0];
      const prompt = exec ? await readFile(join(dataDir, exec.artifactsDir, 'prompt.md'), 'utf8').catch(() => '') : '';
      return { card: task.title, merged: task.completion?.kind === 'merged', files, outOfScope: files.filter(file => !allowed.includes(file)),
        told: (/\(task \d+ of \d+ planned in Origin\)/.exec(prompt) || [''])[0], boundary: prompt.includes('do not authorize work assigned to other tasks') };
    }));
  }
  report.trunk = git(root, 'log', '--format=%h %s', 'trunk').split('\n');
  try { report.trunkTests = execFileSync(process.execPath, ['test.js'], { cwd: root, encoding: 'utf8' }).trim(); } catch (error) { report.trunkTests = `FAILED: ${String(error.stdout || error.message).trim()}`; }
} catch (error) { report.verdict = `error: ${error.code || ''} ${error.message}`; }
finally {
  await supervisor.shutdown(3000).catch(() => {});
  if (!keep) { await rm(root, { recursive: true, force: true }); await rm(dataDir, { recursive: true, force: true }); } else Object.assign(report, { root, dataDir });
  console.log(JSON.stringify(report, null, 2));
}
