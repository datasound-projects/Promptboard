// Five Origin tasks end to end on a typed pipeline: Send to Kanban, then Autopilot takes each card through Planning,
// Executing, Code Review, Testing and Merge in prerequisite order. Real server, Git, supervisor and PTYs; simulated
// CLIs (tests/fixtures/fake-agent.cjs). Semantic scope compliance of real agents is checked by live runs, not here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../public/origin-model.js';
import { startServer } from '../src/server.mjs';

const Model = globalThis.PromptboardOriginModel;
const fake = fileURLToPath(new URL('./fixtures/fake-agent.cjs', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
async function temp(t, prefix) { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return dir; }
async function until(fn, label, ms) { const end = Date.now() + ms; for (;;) { const value = await fn(); if (value) return value; if (Date.now() > end) assert.fail(`Timed out: ${label}`); await new Promise(r => setTimeout(r, 200)); } }

const TASKS = [
  ['Application foundation', 'Build a complete customer portal with authentication, APIs, persistence and UI. For this task: the project structure, configuration and entry point.'],
  ['Database and persistence', 'Schema and data access.'],
  ['Authentication', 'Sign-in and sessions. REVIEW_FAIL_ONCE'],
  ['Backend APIs', 'Account and order endpoints.'],
  ['Frontend integration', 'Pages that use the APIs.'],
];

test('five Origin tasks run in prerequisite order through every typed stage; each knows its place, builds on the merged work, and records its own evidence', { skip: process.platform === 'win32', timeout: 420000 }, async t => {
  const bin = await temp(t, 'pb-5-bin-'), state = await temp(t, 'pb-5-state-');
  for (const name of ['claude', 'codex', 'gemini']) { await writeFile(join(bin, name), `#!${process.execPath}\nrequire(${JSON.stringify(fake)});\n`); await chmod(join(bin, name), 0o755); }
  const old = { PATH: process.env.PATH, FAKE_AGENT_STATE: process.env.FAKE_AGENT_STATE, GEMINI: process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH };
  process.env.PATH = `${bin}:${old.PATH}`; process.env.FAKE_AGENT_STATE = state; process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = join(state, 'none.json');
  const root = await temp(t, 'pb-5-repo-');
  git(root, 'init', '-q', '-b', 'trunk'); git(root, 'config', 'user.email', 't@example.com'); git(root, 'config', 'user.name', 'Tester');
  await writeFile(join(root, 'README.md'), 'portal\n'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'init');
  const dataDir = await temp(t, 'pb-5-data-');
  const app = await startServer({ port: 0, dataDir, detector: async () => [], catalogReader: async provider => ({ provider, source: 'fixture', models: [] }) });
  t.after(async () => { await app.close(); process.env.PATH = old.PATH; for (const [key, value] of [['FAKE_AGENT_STATE', old.FAKE_AGENT_STATE], ['GEMINI_CLI_SYSTEM_SETTINGS_PATH', old.GEMINI]]) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const { token } = await (await fetch(`${app.url}/api/session`)).json();
  const api = async (path, body, method = body ? 'POST' : 'GET') => { const response = await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, data: await response.json() }; };
  const board = app.board;

  // Kanban: a typed pipeline with the Full Autopilot policy and a real test command that fails once for task 4.
  const kanban = await board.createProject({ name: 'Customer Portal', workflowMode: 'pipeline' });
  const projectNow = async () => (await board.state()).projects.find(project => project.id === kanban.id);
  await board.linkRepository(kanban.id, { path: root, expectedRevision: kanban.revision });
  await board.setTargetBranch(kanban.id, { branch: 'trunk', expectedRevision: (await projectNow()).revision });
  const marker = join(state, 'tests-failed-once'), check = join(state, 'check.cjs');
  await writeFile(check, `const fs = require('fs');\nif (fs.existsSync('f4.txt') && !fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, ''); console.error('orders: expected 2, got 3'); process.exit(1); }\n`);
  await board.delivery.setTestCommands(kanban.id, { commands: [{ command: `${process.execPath} ${check}` }], expectedRevision: (await projectNow()).revision });
  await board.applyFullAutopilot(kanban.id, { expectedRevision: (await projectNow()).revision, confirm: true });

  // Origin: the project's design and five tasks, each after the one before; then Send to Kanban.
  let res = await api('/api/origin/projects', { name: 'Customer Portal design' });
  const originId = res.data.project.id;
  res = await api(`/api/origin/projects/${originId}/link`, { expectedRevision: res.data.project.revision, kanbanProjectId: kanban.id });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const bp = Model.emptyBlueprint();
  bp.vision.summary = 'A customer portal: sign-in, accounts, orders.';
  bp.items.push(...TASKS.map(([title, todo], index) => ({ id: `i${index + 1}`, key: `IMP-00${index + 1}`, title, description: `${todo} WRITE_FILE:f${index + 1}.txt TASK_KEY:t${index + 1}`,
    acceptanceCriteria: `Task ${index + 1} works.`, ...(index ? { dependsOn: [`i${index}`] } : {}) })));
  bp.sequence = { requirements: 0, items: 5 };
  res = await api(`/api/origin/projects/${originId}`, { expectedRevision: res.data.revision, blueprint: bp }, 'PUT');
  assert.equal(res.status, 200, JSON.stringify(res.data));
  res = await api(`/api/origin/projects/${originId}/handoff`, { expectedRevision: res.data.revision, itemIds: ['i1', 'i2', 'i3', 'i4', 'i5'] });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  let project = await projectNow();
  const cards = TASKS.map(([title]) => project.tasks.find(task => task.title.endsWith(title)));
  assert.deepEqual(cards.map(card => card.dependsOn || []), [[], [cards[0].id], [cards[1].id], [cards[2].id], [cards[3].id]], 'the prerequisites are the Origin dependencies, as card links');

  // Autopilot with the queue in reverse: each card waits for its prerequisite to be merged.
  await board.setAutopilot(kanban.id, { route: project.autopilot.route, queue: [...cards].reverse().map(card => card.id), expectedRevision: project.revision });
  await board.controlAutopilot(kanban.id, { action: 'start', confirm: true });
  const order = [];
  await until(async () => {
    project = await projectNow();
    const current = project.autopilot.current?.taskId;
    if (current && order.at(-1) !== current) order.push(current);
    assert.ok(project.tasks.filter(task => !['todo', 'done'].includes(task.column)).length <= 1, 'one card at a time');
    if (project.autopilot.status === 'paused') assert.fail(`Autopilot paused: ${project.autopilot.reason}`);
    return project.autopilot.status === 'finished';
  }, 'Autopilot finished', 400000);
  assert.deepEqual(order, cards.map(card => card.id), 'prerequisites first, whatever the queue order');

  const runs = (await board.state()).runs, done = id => project.tasks.find(task => task.id === id);
  for (const [index, card] of cards.entries()) {
    const now = done(card.id), own = runs.filter(run => run.taskId === card.id).sort((a, b) => a.createdAt - b.createdAt);
    // Done means merged, and says into which branch.
    assert.equal(now.completion.kind, 'merged', card.title);
    assert.ok(git(root, 'ls-tree', '--name-only', 'trunk').split('\n').includes(`f${index + 1}.txt`));
    // Each stage ran its own session and recorded its own result.
    const stages = new Set(now.stageHistory.map(item => `${item.stage}:${item.status}`));
    for (const stage of ['planning', 'executing', 'code_review', 'testing']) assert.ok(stages.has(`${stage}:succeeded`), `${card.title}: ${[...stages].join(' ')}`);
    assert.equal(new Set(own.map(run => run.sessionId)).size, own.length, 'a fresh session per stage run');
    assert.equal(now.evidence.review.status, 'accepted');
    assert.equal(now.evidence.tests.status, 'passed');
    assert.equal(now.evidence.tests.taskCommit, now.completion.taskCommit, 'the merged commit is the one that was tested');
    // The branch started from the target with every earlier task merged.
    const base = own[0].startCommit, files = git(root, 'ls-tree', '--name-only', base).split('\n');
    for (let earlier = 1; earlier <= index; earlier++) assert.ok(files.includes(`f${earlier}.txt`), `${card.title} starts with f${earlier}.txt`);
    assert.ok(!files.includes(`f${index + 1}.txt`));
    // What the Executing agent was told: the exact card text, its place, its job, the prerequisite's result, the rest for awareness.
    const prompt = await readFile(join(dataDir, own.find(run => run.stageKind === 'executing').artifactsDir, 'prompt.md'), 'utf8');
    assert.ok(prompt.includes(`=== TASK (exact text from the card) ===\n${now.prompt}\n=== END TASK ===`), 'the card text is passed unchanged');
    assert.match(prompt, new RegExp(`This task: #${now.number} [^\\n]*${TASKS[index][0]} \\(task ${index + 1} of 5 planned in Origin\\)\\nStage: Executing\\. Your job: implement this task only`));
    assert.match(prompt, /=== APPROVED PLAN ===\nPLAN\n1\. /);
    if (index) assert.match(prompt, new RegExp(`Prerequisites \\(must be complete before this task\\):\\n- #${done(cards[index - 1].id).number} [^\\n]*${TASKS[index - 1][0]}: Done, merged into trunk\\n  What it did: `));
    for (const [other, [title]] of TASKS.entries()) if (other !== index && other !== index - 1) assert.match(prompt, new RegExp(`Other tasks in this project[\\s\\S]*${title}`));
    assert.match(prompt, /do not authorize work assigned to other tasks/);
  }
  // Task 3: the review asked for changes once; the fix was reviewed again on a new commit.
  const third = done(cards[2].id).stageHistory.map(item => `${item.stage}:${item.status}`);
  assert.ok(third.includes('code_review:changes_required'), third.join(' '));
  const reviews = runs.filter(run => run.taskId === cards[2].id && run.stageKind === 'code_review');
  assert.equal(reviews.length, 2);
  assert.notEqual(reviews[0].review.taskCommit, reviews[1].review.taskCommit, 'the second review is bound to the corrected commit');
  // Task 4: the real test command failed once; the output reached Executing, then the corrected commit passed.
  const fourth = done(cards[3].id);
  assert.ok(fourth.stageHistory.some(item => item.stage === 'testing' && item.status === 'changes_required'));
  const reworked = runs.filter(run => run.taskId === cards[3].id && run.stageKind === 'executing').at(-1);
  assert.match(await readFile(join(dataDir, reworked.artifactsDir, 'prompt.md'), 'utf8'), /orders: expected 2, got 3/);
  // Five squash merges, nothing else on the target.
  assert.equal(git(root, 'rev-list', '--count', 'trunk'), '6');
});
