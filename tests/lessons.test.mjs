// Project memory (src/lessons.mjs): lessons suggested after merges, decided by the owner, delivered to new agents.
// Model calls are SIMULATED (a fake runner); Git and the merges are real, in disposable repositories.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Board } from '../src/board.mjs';
import { composeMessage } from '../src/agents.mjs';
import { Lessons, choiceFor, lessonsPrompt, lessonsSection, parseLessons } from '../src/lessons.mjs';
import { escapeId } from '../src/origin.mjs';
import { FAILURE_MESSAGES, ProviderError } from '../src/providers.mjs';
import { Supervisor } from '../src/supervisor.mjs';
import { startTestServer } from './helpers/test-server.mjs';
import { customPipelineConfig } from './helpers/pipeline.mjs';

// Simulated CLIs (a fake gh, the fake agent in a PTY) are shebang scripts, which Windows does not run; the merge flows that
// use them skip there, as the other Git merge tests do. Everything else runs on every platform.
const shellSkip = process.platform === 'win32';
const fake = fileURLToPath(new URL('./fixtures/fake-agent.cjs', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
async function temp(t, prefix) { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return dir; }
async function until(fn, label, ms = 15000) { const end = Date.now() + ms; for (;;) { const value = await fn(); if (value) return value; if (Date.now() > end) assert.fail(`Timed out: ${label}`); await new Promise(r => setTimeout(r, 20)); } }
const fileOf = (dataDir, projectId) => join(dataDir, 'lessons', `${escapeId(projectId)}.json`);
const answer = items => ({ text: `Here they are:\n\`\`\`json\n${JSON.stringify(items)}\n\`\`\`` });
const LESSONS = [
  { kind: 'command', text: 'Run the tests with npm test.', evidence: 'npm test exited 0 before the merge.' },
  { kind: 'convention', text: 'Features live in one file per feature under src/.', evidence: 'The card added src/checkout.txt.' },
  { kind: 'gotcha', text: 'The review fails when a change has no test.', evidence: 'The first review asked for a test.' },
];
const slot = () => ({ job: { controller: new AbortController() }, release() {} });

/** A board on a disposable repository with project memory attached; the worker starts only when a test starts it. */
async function world(t, { workflowMode = 'legacy', runner = async () => answer(LESSONS), claim = async () => slot(), dataDir } = {}) {
  const root = await temp(t, 'pb-lessons-repo-');
  dataDir ??= await temp(t, 'pb-lessons-data-');
  git(root, 'init', '-q', '-b', 'trunk'); git(root, 'config', 'user.email', 't@example.com'); git(root, 'config', 'user.name', 'Tester');
  await writeFile(join(root, 'app.js'), 'one\n'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'init');
  const board = new Board({ dataDir }), calls = [], claims = [], retries = [];
  const lessons = new Lessons({ dataDir, board, claim: async (kind, provider) => { claims.push([kind, provider]); return claim(kind, provider); },
    runner: async call => { calls.push({ ...call, files: await readdir(call.cwd) }); return runner(call); }, schedule: fn => retries.push(fn) });
  board.lessons = lessons;
  t.after(() => { board.delivery.stopAllTests(); return lessons.close(); });
  const project = await board.createProject({ name: 'Shop', workflowMode });
  const current = async () => (await board.state()).projects.find(item => item.id === project.id);
  await board.linkRepository(project.id, { path: root, expectedRevision: (await current()).revision });
  await board.setTargetBranch(project.id, { branch: 'trunk', expectedRevision: (await current()).revision });
  const card = async id => (await current()).tasks.find(task => task.id === id);
  /** A card in `column` whose committed change has an accepted review and passing tests: ready to merge. */
  const ready = async (title, column = 'merge') => {
    const created = await board.createTask({ projectId: project.id, title, prompt: `Change ${title} as /Users/someone/private/shop/README.md says. api_key=sk-test-123456` });
    const ws = await board.ensureTaskWorktree(created.id);
    const file = `${title.toLowerCase().replace(/\W+/g, '-')}.txt`;
    await writeFile(join(ws.path, file), `${title}\n`); git(ws.path, 'add', '.'); git(ws.path, 'commit', '-q', '-m', title);
    const taskCommit = git(ws.path, 'rev-parse', 'HEAD'), targetCommit = git(root, 'rev-parse', 'trunk');
    await board.updateTaskEvidence(created.id, task => {
      task.column = column;
      task.stageResults = { executing: { runId: null, summary: `Added ${file}. npm test passes.`, at: Date.now() } };
      task.evidence = { review: { status: 'accepted', verdict: 'no_issues', findings: [], taskCommit, targetCommit, at: Date.now() },
        tests: { status: 'passed', id: `tests-${created.id}`, taskCommit, targetCommit, results: [{ label: 'unit', argv: ['npm', 'test'], status: 'passed', exitCode: 0, tail: 'ok' }], endedAt: Date.now() } };
    });
    return { id: created.id, taskCommit, targetCommit, file, branch: ws.branch };
  };
  /** A card completed as merged through Board.completeTask, as every merge path ends; no Git needed. */
  const merged = async title => {
    const created = await board.createTask({ projectId: project.id, title, prompt: `Change ${title}.` });
    await board.completeTask(created.id, { kind: 'merged', details: { targetBranch: 'trunk', commits: 1 } });
    await until(() => jobOf(created.id), 'the merge queued its job'); // Queued after the merge returns, never awaited by it.
    return { id: created.id };
  };
  const view = () => lessons.view(project.id);
  const jobOf = async id => (await view()).jobs.find(job => job.taskId === id);
  return { root, dataDir, board, lessons, project, current, card, ready, merged, view, jobOf, calls, claims, retries };
}
/** A fake gh on PATH whose `pr view` answers `state`. */
async function fakeGh(t, state) {
  const bin = await temp(t, 'pb-lessons-gh-');
  await writeFile(join(bin, 'gh'), `#!${process.execPath}\nconst a = process.argv.slice(2);\nif (a[0] === 'pr' && a[1] === 'view') { console.log(JSON.stringify(${JSON.stringify(state)})); process.exit(0); }\nprocess.exit(2);\n`);
  await chmod(join(bin, 'gh'), 0o755);
  const old = process.env.PATH; process.env.PATH = `${bin}${delimiter}${old}`; t.after(() => { process.env.PATH = old; });
}

test('every merge path queues one lessons job: Merge, Merge now, automatic merges on legacy and typed boards, and a merged pull request', { skip: shellSkip, timeout: 120000 }, async t => {
  const w = await world(t);
  // Merge (the route, and legacy Autopilot): Delivery.merge.
  const direct = await w.ready('Direct merge');
  await w.board.delivery.merge(direct.id, { confirm: true, taskCommit: direct.taskCommit, targetCommit: direct.targetCommit });
  // Merge now (the button, and pipeline Autopilot).
  const button = await w.ready('Merge button');
  assert.equal((await w.board.mergeNow(button.id)).merged, true);
  // A legacy board merges on entering Merge when Merge is set to merge automatically.
  await w.board.setWorkflow(w.project.id, { workflow: { merge: { policy: 'start' } }, expectedRevision: (await w.current()).revision });
  const automatic = await w.ready('Automatic merge', 'testing');
  assert.equal((await w.board.transition(automatic.id, { column: 'merge', expectedRevision: (await w.card(automatic.id)).revision })).merged, true);
  // A pull request merged on GitHub, found by the board's own check.
  const proposal = await w.ready('Pull request');
  await w.board.updateTaskEvidence(proposal.id, task => { task.evidence.pullRequest = { url: 'https://github.com/acme/shop/pull/7', number: 7, state: 'OPEN', base: 'trunk', branch: proposal.branch, taskCommit: proposal.taskCommit, at: Date.now() }; });
  await fakeGh(t, { url: 'https://github.com/acme/shop/pull/7', number: 7, state: 'MERGED', mergedAt: '2026-10-20T10:00:00Z' });
  await w.board.advanceFlows();
  assert.equal((await w.card(proposal.id)).completion.kind, 'pull_request');
  // The stage engine merges a typed board's card on entering Merge with automatic completion.
  const typed = await world(t, { workflowMode: 'pipeline' });
  await typed.board.setExecutionPolicy(typed.project.id, { policy: { completion: 'automatic' }, expectedRevision: (await typed.current()).revision });
  const engine = await typed.ready('Typed merge', 'testing');
  assert.equal((await typed.board.transition(engine.id, { column: 'merge', expectedRevision: (await typed.card(engine.id)).revision, decision: 'start' })).merged, true);
  for (const [scope, id] of [[w, direct.id], [w, button.id], [w, automatic.id], [w, proposal.id], [typed, engine.id]]) {
    await until(() => scope.jobOf(id), 'queued after the merge returned');
    const jobs = JSON.parse(await readFile(fileOf(scope.dataDir, scope.project.id), 'utf8')).jobs.filter(job => job.taskId === id);
    assert.deepEqual(jobs.map(job => [job.status, job.trigger, job.completedAt]), [['queued', 'merge', (await scope.card(id)).completion.at]], `one queued job for ${(await scope.card(id)).title}`);
  }
  assert.equal(w.calls.length + typed.calls.length, 0, 'queuing never calls a model');
  // Merge completions are written only through Board.completeTask, where the hook is: a path that writes one itself fails here.
  const src = fileURLToPath(new URL('../src/', import.meta.url));
  for (const name of (await readdir(src)).filter(file => file.endsWith('.mjs'))) {
    const rows = (await readFile(join(src, name), 'utf8')).replace(/\r\n/g, '\n').split('\n');
    for (const line of rows.filter(row => /\bcompletion = \{/.test(row))) assert.match(line, /completion = \{ kind(?:,|: 'unmerged')/, `${name}: ${line.trim()}`);
    for (const line of rows.filter(row => /kind: '(?:merged|pull_request)'/.test(row) && /complet/i.test(row))) assert.match(line, /completeTask\(/, `${name}: ${line.trim()}`);
  }
});

test('completions without a merge queue nothing: no code changes, Done without merging, an open pull request, and memory switched off', { skip: shellSkip, timeout: 60000 }, async t => {
  const w = await world(t);
  const empty = await w.board.createTask({ projectId: w.project.id, title: 'Nothing to change', prompt: 'Check the README.' });
  await w.board.ensureTaskWorktree(empty.id);
  await w.board.delivery.completeNoChanges(empty.id, { confirm: true });
  const unmerged = await w.ready('Keep on its branch', 'testing');
  await w.board.transition(unmerged.id, { column: 'done', expectedRevision: (await w.card(unmerged.id)).revision });
  assert.equal((await w.card(unmerged.id)).completion.kind, 'unmerged');
  const open = await w.ready('Still open');
  await w.board.updateTaskEvidence(open.id, task => { task.evidence.pullRequest = { url: 'https://github.com/acme/shop/pull/8', number: 8, state: 'OPEN', base: 'trunk', taskCommit: open.taskCommit, at: Date.now() }; });
  await fakeGh(t, { url: 'https://github.com/acme/shop/pull/8', number: 8, state: 'OPEN' });
  await w.board.advanceFlows();
  assert.equal((await w.card(open.id)).column, 'merge');
  await new Promise(resolve => setTimeout(resolve, 100)); // A queued job would be written by now.
  assert.deepEqual((await w.view()).jobs, []);
  // Off: a merge queues nothing. A click on Suggest lessons still asks once.
  await w.lessons.setSettings(w.project.id, { enabled: false, expectedRevision: (await w.view()).revision });
  const off = await w.ready('Merged while off');
  await w.board.mergeNow(off.id);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual((await w.view()).jobs, []);
  await w.lessons.suggestAgain(off.id, { expectedRevision: (await w.view()).revision });
  assert.deepEqual((await w.view()).jobs.map(job => [job.taskId, job.trigger, job.status]), [[off.id, 'owner', 'queued']]);
  await assert.rejects(w.lessons.suggestAgain(empty.id, { expectedRevision: (await w.view()).revision }), { code: 'NOT_MERGED' });
});

test('the worker takes the shared job slot, waits while it is busy, and then runs once with the card’s CLI and its smallest model, without local paths or secrets', { skip: shellSkip, timeout: 60000 }, async t => {
  let busy = true;
  const w = await world(t, { claim: async () => { if (busy) throw Object.assign(new ProviderError('A prompt is already in progress. Wait or cancel that prompt.', 'BUSY'), { status: 409 }); return slot(); } });
  const merged = await w.ready('Checkout flow');
  await w.board.delivery.merge(merged.id, { confirm: true, taskCommit: merged.taskCommit, targetCommit: merged.targetCommit });
  w.lessons.start();
  await until(() => w.retries.length === 1, 'a retry is scheduled while the slot is busy');
  assert.deepEqual([w.calls.length, (await w.jobOf(merged.id)).status], [0, 'queued'], 'the owner’s job is never taken over');
  busy = false;
  w.retries.shift()();
  await until(async () => (await w.jobOf(merged.id))?.status === 'done', 'job done');
  assert.deepEqual(w.claims.map(([kind]) => kind), ['lessons', 'lessons']);
  assert.equal(w.calls.length, 1);
  const [call] = w.calls;
  assert.deepEqual([call.provider, call.model, call.effort, call.timeoutMs], ['claude', 'haiku', '', 180000], 'no run recorded: Claude Code with Haiku');
  assert.deepEqual(call.files, [], 'an empty temporary folder');
  await assert.rejects(stat(call.cwd), { code: 'ENOENT' }, 'removed afterwards');
  assert.ok(call.prompt.includes('Checkout flow') && call.prompt.includes('checkout-flow.txt') && call.prompt.includes('unit: passed (exit 0)') && call.prompt.includes('merged into trunk, 1 commit'));
  assert.ok(call.prompt.length < 26000);
  assert.doesNotMatch(call.prompt, /\/Users\/someone|sk-test-123456/, 'local folders keep their last name; secrets are masked');
  assert.match(call.prompt, /…\/README\.md/);
  const view = await w.view(), number = (await w.card(merged.id)).number;
  assert.deepEqual(view.lessons.map(lesson => [lesson.kind, lesson.status, lesson.taskId, lesson.taskNumber]), LESSONS.map(lesson => [lesson.kind, 'suggested', merged.id, number]));
  assert.deepEqual([(await w.jobOf(merged.id)).found, (await w.jobOf(merged.id)).provider, (await w.jobOf(merged.id)).model], [3, 'claude', 'haiku']);
  // Nothing else runs: no loop, no retry.
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual([w.calls.length, w.retries.length], [1, 0]);
});

test('the CLI is the card’s executing CLI with its smallest model unless the owner chose one; Antigravity cannot suggest', () => {
  const task = { id: 't1', completion: { executionRunId: 'r2' } };
  const runs = [{ id: 'r1', taskId: 't1', stage: 'planning', config: { provider: 'gemini' } }, { id: 'r2', taskId: 't1', stage: 'executing', config: { provider: 'codex' } }];
  const none = { enabled: true, provider: '', model: '' };
  assert.deepEqual(choiceFor(none, task, runs), { provider: 'codex', model: '', effort: 'low' });
  assert.deepEqual(choiceFor(none, { id: 't1', completion: {} }, runs), { provider: 'codex', model: '', effort: 'low' }, 'the last executing run without a recorded one');
  assert.deepEqual(choiceFor(none, task, [{ ...runs[0], id: 'r2' }]), { provider: 'gemini', model: 'flash', effort: '' });
  assert.deepEqual(choiceFor(none, task, []), { provider: 'claude', model: 'haiku', effort: '' });
  assert.deepEqual(choiceFor({ enabled: true, provider: 'claude', model: 'sonnet' }, task, runs), { provider: 'claude', model: 'sonnet', effort: '' });
  assert.throws(() => choiceFor(none, task, [{ ...runs[1], config: { provider: 'agy' } }]), { code: 'PROVIDER_UNSUPPORTED', message: /Antigravity CLI cannot run without tools/ });
});

test('a restart resumes queued jobs and jobs that were running when the app stopped', { timeout: 60000 }, async t => {
  let release;
  const w = await world(t, { runner: call => new Promise((resolve, reject) => { release = () => resolve(answer(LESSONS.slice(0, 1))); call.signal.addEventListener('abort', () => reject(new ProviderError('Generation was cancelled.', 'ABORTED')), { once: true }); }) });
  const first = await w.merged('First card');
  w.lessons.start();
  await until(async () => (await w.jobOf(first.id))?.status === 'running' && release, 'running');
  // The app stops: the run is cancelled and the job is queued again.
  await w.lessons.close();
  assert.equal((await w.jobOf(first.id)).status, 'queued');
  // A crash leaves a job marked running; the next start queues it again too.
  const second = await w.merged('Second card');
  const saved = JSON.parse(await readFile(fileOf(w.dataDir, w.project.id), 'utf8'));
  saved.jobs.find(job => job.taskId === second.id).status = 'running';
  await writeFile(fileOf(w.dataDir, w.project.id), JSON.stringify(saved));
  const calls = [];
  const restarted = new Lessons({ dataDir: w.dataDir, board: new Board({ dataDir: w.dataDir }), claim: async () => slot(), runner: async call => { calls.push(call); return answer([{ kind: 'gotcha', text: `Lesson from ${call.prompt.includes('First card') ? 'the first' : 'the second'} card.`, evidence: '' }]); }, schedule: () => {} });
  t.after(() => restarted.close());
  restarted.start();
  await until(async () => (await restarted.view(w.project.id)).jobs.every(job => job.status === 'done'), 'both resumed');
  assert.equal(calls.length, 2);
  assert.deepEqual((await restarted.view(w.project.id)).lessons.map(lesson => lesson.text).sort(), ['Lesson from the first card.', 'Lesson from the second card.']);
});

test('a failed suggestion records a plain reason and is never retried on its own; Suggest again runs it once more', { timeout: 60000 }, async t => {
  const replies = [() => { throw Object.assign(new ProviderError(FAILURE_MESSAGES.AUTH_REQUIRED, 'AUTH_REQUIRED'), { details: 'raw CLI output with a token' }); }, () => ({ text: 'I think the code looks fine.' }), () => ({ text: '[]' })];
  const w = await world(t, { runner: async () => replies.shift()() });
  const merged = await w.merged('Login page');
  w.lessons.start();
  await until(async () => (await w.jobOf(merged.id))?.status === 'failed', 'failed');
  assert.equal((await w.jobOf(merged.id)).reason, FAILURE_MESSAGES.AUTH_REQUIRED);
  await new Promise(resolve => setTimeout(resolve, 50));
  w.lessons.kick();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual([w.calls.length, w.retries.length], [1, 0], 'no retry on its own');
  await assert.rejects(w.lessons.suggestAgain(merged.id, { expectedRevision: 0 }), { code: 'REVISION_CONFLICT' });
  await w.lessons.suggestAgain(merged.id, { expectedRevision: (await w.view()).revision });
  await until(async () => (await w.jobOf(merged.id))?.status === 'failed' && w.calls.length === 2, 'second failure');
  assert.equal((await w.jobOf(merged.id)).reason, 'The model did not answer with a list of lessons.');
  await w.lessons.suggestAgain(merged.id, { expectedRevision: (await w.view()).revision });
  await until(async () => (await w.jobOf(merged.id))?.status === 'done', 'no lessons is a valid answer');
  assert.deepEqual([(await w.jobOf(merged.id)).found, (await w.view()).lessons.length], [0, 0]);
  // A card executed by Antigravity fails with a plain reason before any CLI starts.
  await w.board.store.update(state => { state.runs.push({ id: 'run-agy-1', taskId: merged.id, projectId: w.project.id, stage: 'executing', status: 'succeeded', config: { provider: 'agy' }, createdAt: Date.now() }); });
  await w.lessons.suggestAgain(merged.id, { expectedRevision: (await w.view()).revision });
  await until(async () => (await w.jobOf(merged.id))?.status === 'failed', 'Antigravity refused');
  assert.match((await w.jobOf(merged.id)).reason, /Antigravity CLI cannot run without tools/);
  assert.equal(w.calls.length, 3);
});

test('answers are validated: at most six lessons of known kinds and lengths, no duplicates, and an empty list is a valid answer', () => {
  const many = [
    { kind: 'command', text: 'Run npm test.', evidence: 'exit 0' }, { kind: 'command', text: 'run NPM test', evidence: 'the same, differently written' },
    { kind: 'tip', text: 'Unknown kind.' }, { kind: 'gotcha', text: 'x'.repeat(301) }, { kind: 'gotcha', text: '   ' }, { kind: 'convention', text: 'Known already.' },
    { kind: 'convention', text: 'Use ESM modules.', evidence: 'e'.repeat(400) }, ...['a', 'b', 'c', 'd', 'e'].map(letter => ({ kind: 'failed_approach', text: `Approach ${letter} failed.` })),
  ];
  const parsed = parseLessons(`Sure!\n\`\`\`json\n${JSON.stringify(many)}\n\`\`\``, ['known already']);
  assert.deepEqual(parsed.map(item => item.text), ['Run npm test.', 'Use ESM modules.', 'Approach a failed.', 'Approach b failed.', 'Approach c failed.', 'Approach d failed.']);
  assert.equal(parsed[1].evidence.length, 200);
  assert.deepEqual(parseLessons('[]'), []);
  assert.deepEqual(parseLessons('Nothing new [none] here: []'), [], 'the last list in the text is read');
  assert.throws(() => parseLessons('The work looks fine.'), { code: 'INVALID_OUTPUT' });
  assert.throws(() => parseLessons('{"kind":"command"}'), { code: 'INVALID_OUTPUT' });
  assert.deepEqual(parseLessons(JSON.stringify([{ kind: 'gotcha', text: 'Build in /Users/me/work/shop first; token=abc123 is in .env', evidence: '' }]))[0].text, 'Build in …/shop first; token=[redacted] is in .env');
});

test('the owner approves, edits and rejects lessons on the current revision; caps drop the oldest suggestions and rejections, never approved lessons', { timeout: 60000 }, async t => {
  const w = await world(t);
  const merged = await w.merged('Search page');
  w.lessons.start();
  await until(async () => (await w.jobOf(merged.id))?.status === 'done', 'suggested');
  let view = await w.view();
  const [command, convention, gotcha] = view.lessons;
  await assert.rejects(w.lessons.decide(w.project.id, command.id, { status: 'approved', expectedRevision: view.revision - 1 }), { code: 'REVISION_CONFLICT' });
  await assert.rejects(w.lessons.decide(w.project.id, command.id, { text: 'x'.repeat(301), expectedRevision: view.revision }), { code: 'INVALID_INPUT' });
  await w.lessons.decide(w.project.id, command.id, { status: 'approved', expectedRevision: view.revision });
  await w.lessons.decide(w.project.id, convention.id, { text: 'Each feature has its own file in src/.', kind: 'gotcha', expectedRevision: (await w.view()).revision });
  await w.lessons.decide(w.project.id, gotcha.id, { status: 'rejected', expectedRevision: (await w.view()).revision });
  view = await w.view();
  assert.deepEqual(view.lessons.map(lesson => [lesson.kind, lesson.status, Boolean(lesson.edited)]), [['command', 'approved', false], ['gotcha', 'suggested', true]]);
  assert.equal(view.rejected, 1);
  await w.lessons.approve(w.project.id, { ids: [convention.id], expectedRevision: view.revision });
  assert.deepEqual((await w.view()).lessons.map(lesson => lesson.status), ['approved', 'approved']);
  // A rejected lesson is not suggested again.
  await w.lessons.suggestAgain(merged.id, { expectedRevision: (await w.view()).revision });
  await until(async () => (await w.jobOf(merged.id))?.status === 'done' && w.calls.length === 2, 'again');
  assert.equal((await w.jobOf(merged.id)).found, 0, 'all three are known: approved, edited or rejected');
  // Caps: 100 suggestions and 200 rejected keep the newest; 200 approved refuse more instead of dropping one.
  const saved = JSON.parse(await readFile(fileOf(w.dataDir, w.project.id), 'utf8'));
  const make = (status, n, at) => Array.from({ length: n }, (_, i) => ({ id: `${status}-${i}`, kind: 'gotcha', text: `${status} ${i}`, evidence: '', taskId: merged.id, taskNumber: 1, status, createdAt: at + i, ...(status === 'suggested' ? {} : { decidedAt: at + i }) }));
  saved.lessons = [...make('approved', 199, 1000), ...make('suggested', 100, 2000), ...make('rejected', 200, 3000)];
  await writeFile(fileOf(w.dataDir, w.project.id), JSON.stringify(saved));
  await w.lessons.suggestAgain(merged.id, { expectedRevision: saved.revision });
  await until(async () => (await w.jobOf(merged.id))?.status === 'done' && w.calls.length === 3, 'over the caps');
  view = await w.view();
  const suggested = view.lessons.filter(lesson => lesson.status === 'suggested');
  assert.equal(suggested.length, 100);
  assert.ok(!suggested.some(lesson => ['suggested-0', 'suggested-1', 'suggested-2'].includes(lesson.id)) && suggested.some(lesson => lesson.text === LESSONS[0].text), 'the oldest suggestions make room');
  await w.lessons.decide(w.project.id, 'suggested-50', { status: 'approved', expectedRevision: view.revision });
  await assert.rejects(w.lessons.decide(w.project.id, 'suggested-51', { status: 'approved', expectedRevision: (await w.view()).revision }), { code: 'LESSONS_FULL' });
  assert.equal((await w.view()).lessons.filter(lesson => lesson.status === 'approved').length, 200, 'no approved lesson was dropped');
  await w.lessons.decide(w.project.id, 'suggested-51', { status: 'rejected', expectedRevision: (await w.view()).revision });
  const rejected = JSON.parse(await readFile(fileOf(w.dataDir, w.project.id), 'utf8')).lessons.filter(lesson => lesson.status === 'rejected');
  assert.deepEqual([rejected.length, rejected.some(lesson => lesson.id === 'rejected-0'), rejected.some(lesson => lesson.id === 'suggested-51')], [200, false, true]);
});

test('approved lessons reach the prompt as one bounded section, newest first and grouped by kind; without them there is no section', async t => {
  const lesson = (kind, text, decidedAt, status = 'approved') => ({ id: text, kind, text, evidence: '', status, createdAt: 1, decidedAt });
  const section = lessonsSection([lesson('gotcha', 'Old gotcha.', 1), lesson('command', 'npm test', 3), lesson('convention', 'ESM only.', 2), lesson('command', 'Not approved.', 4, 'suggested'), lesson('failed_approach', 'Rejected.', 5, 'rejected')]);
  assert.equal(section, ['=== PROJECT LESSONS (approved by the owner from earlier finished cards) ===', 'Commands that worked:', '- npm test', 'Conventions:', '- ESM only.', 'Gotchas:', '- Old gotcha.', '=== END PROJECT LESSONS ==='].join('\n'));
  assert.equal(lessonsSection([lesson('command', 'Suggested only.', 1, 'suggested')]), '');
  // Many long lessons: the newest fill the 8,000 characters.
  const long = Array.from({ length: 60 }, (_, i) => lesson('gotcha', `${String(i).padStart(2, '0')} ${'x'.repeat(290)}`, i));
  const bounded = lessonsSection(long);
  assert.ok(bounded.length <= 8000 && bounded.includes('59 ') && !bounded.includes('\n- 00 '));
  assert.ok(composeMessage('executing', 'Do it.', null, '', '', '', section).includes(`=== END TASK ===\n\n${section}`));
  assert.doesNotMatch(composeMessage('executing', 'Do it.'), /PROJECT LESSONS/);
  // The file on disk is read without changing it; a damaged or missing file gives no section.
  const dataDir = await temp(t, 'pb-lessons-prompt-');
  assert.equal(await lessonsPrompt(dataDir, 'p1'), '');
  await mkdir(join(dataDir, 'lessons'));
  await writeFile(fileOf(dataDir, 'p1'), JSON.stringify({ schema: 'promptboard.lessons', version: 1, projectId: 'p1', revision: 3, lessons: [lesson('command', 'npm test', 3)] }));
  assert.match(await lessonsPrompt(dataDir, 'p1'), /Commands that worked:\n- npm test/);
  await writeFile(fileOf(dataDir, 'p1'), '{"schema":');
  assert.equal(await lessonsPrompt(dataDir, 'p1'), '');
  assert.equal(await lessonsPrompt(dataDir, '../p1'), '');
});

test('a new agent run receives the approved lessons in its first message; a project without lessons gets none', { skip: shellSkip, timeout: 60000 }, async t => {
  const bin = await temp(t, 'pb-lessons-bin-');
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\nrequire(${JSON.stringify(fake)});\n`); await chmod(join(bin, 'claude'), 0o755);
  const old = process.env.PATH; process.env.PATH = `${bin}${delimiter}${old}`;
  const w = await world(t), supervisor = new Supervisor({ board: w.board, dataDir: w.dataDir });
  w.board.executor = supervisor;
  t.after(async () => { await supervisor.shutdown(500); process.env.PATH = old; });
  const prompt = run => readFile(join(w.dataDir, run.artifactsDir, 'prompt.md'), 'utf8');
  const started = async run => { await until(async () => (await w.board.run(run.id)).turns, 'first turn'); const text = await prompt(run); await supervisor.cancel(run.id); return text; };
  await w.lessons.restore([{ id: w.project.id, lessons: { settings: {}, lessons: [{ id: 'l1', kind: 'command', text: 'Run node --test before you finish.', evidence: '', taskNumber: 1 }] } }]);
  const card = await w.board.createTask({ projectId: w.project.id, title: 'Add a field', prompt: 'Add the field.' });
  const text = await started((await w.board.transition(card.id, { column: 'executing', expectedRevision: card.revision })).run);
  assert.match(text, /=== END TASK ===\n[\s\S]*=== PROJECT LESSONS \(approved by the owner from earlier finished cards\) ===\nCommands that worked:\n- Run node --test before you finish\.\n=== END PROJECT LESSONS ===/);
  // A custom pipeline column sends its own envelope, then the lessons. A project without lessons gets no section.
  const root = await temp(t, 'pb-lessons-repo2-');
  git(root, 'init', '-q', '-b', 'trunk'); git(root, 'config', 'user.email', 't@example.com'); git(root, 'config', 'user.name', 'Tester'); git(root, 'commit', '-q', '--allow-empty', '-m', 'init');
  const blog = await w.board.createProject({ name: 'Blog', workflowMode: 'pipeline' });
  const now = async () => (await w.board.state()).projects.find(item => item.id === blog.id);
  await w.board.linkRepository(blog.id, { path: root, expectedRevision: (await now()).revision });
  await w.board.setTargetBranch(blog.id, { branch: 'trunk', expectedRevision: (await now()).revision });
  await w.board.setPipeline(blog.id, { pipeline: customPipelineConfig(), expectedRevision: (await now()).revision });
  const plain = await w.board.createTask({ projectId: blog.id, title: 'Plain post', prompt: 'Write the post.' });
  assert.doesNotMatch(await started((await w.board.transition(plain.id, { column: 'executing', expectedRevision: plain.revision, decision: 'start' })).run), /PROJECT LESSONS/);
  await w.lessons.restore([{ id: blog.id, lessons: { lessons: [{ kind: 'gotcha', text: 'The pipeline gotcha.' }] } }]);
  const next = await w.board.createTask({ projectId: blog.id, title: 'Next post', prompt: 'Write the next post.' });
  const custom = await started((await w.board.transition(next.id, { column: 'executing', expectedRevision: next.revision, decision: 'start' })).run);
  assert.ok(custom.includes('Write the next post.') && custom.indexOf('Write the next post.') < custom.indexOf('=== PROJECT LESSONS'), 'after the task envelope');
  assert.match(custom, /Gotchas:\n- The pipeline gotcha\./);
  assert.doesNotMatch(custom, /node --test/, 'only this project’s lessons');
});

test('a backup carries approved lessons and settings, never suggestions or jobs, and the import restores them', { timeout: 60000 }, async t => {
  const w = await world(t);
  const merged = await w.merged('Profile page');
  w.lessons.start();
  await until(async () => (await w.jobOf(merged.id))?.status === 'done', 'suggested');
  const [first] = (await w.view()).lessons;
  await w.lessons.decide(w.project.id, first.id, { status: 'approved', text: 'Run npm test before a merge.', expectedRevision: (await w.view()).revision });
  await w.lessons.setSettings(w.project.id, { enabled: false, provider: 'codex', model: 'gpt-5-mini', expectedRevision: (await w.view()).revision });
  const backup = await w.board.exportBackup();
  const saved = backup.projects.find(project => project.id === w.project.id).lessons;
  assert.deepEqual(saved.settings, { enabled: false, provider: 'codex', model: 'gpt-5-mini' });
  assert.deepEqual(saved.lessons.map(lesson => [lesson.kind, lesson.text, lesson.edited]), [['command', 'Run npm test before a merge.', true]]);
  assert.equal(JSON.stringify(backup).includes(LESSONS[1].text), false, 'suggestions stay out');
  assert.equal(JSON.stringify(backup).includes('"jobs"'), false);
  // Restored on another computer: the same lessons reach that project's agents.
  const dataDir = await temp(t, 'pb-lessons-restore-'), board = new Board({ dataDir }), restored = new Lessons({ dataDir, board, claim: async () => slot(), runner: async () => answer([]) });
  board.lessons = restored;
  await board.importBackup(JSON.parse(JSON.stringify(backup)), { replace: true });
  const view = await restored.view(w.project.id);
  assert.deepEqual([view.settings, view.lessons.map(lesson => [lesson.status, lesson.text]), view.jobs], [{ enabled: false, provider: 'codex', model: 'gpt-5-mini' }, [['approved', 'Run npm test before a merge.']], []]);
  assert.match(await lessonsPrompt(dataDir, w.project.id), /- Run npm test before a merge\./);
  // Malformed entries are dropped; older backups without lessons import as before.
  backup.projects[0].lessons = { settings: { provider: 'sh', model: '--flag' }, lessons: [{ kind: 'tip', text: 'x' }, { kind: 'command', text: 'Keep me.' }, { kind: 'gotcha', text: '' }] };
  await board.importBackup(backup, { replace: true });
  assert.deepEqual([(await restored.view(w.project.id)).settings, (await restored.view(w.project.id)).lessons.map(lesson => lesson.text)], [{ enabled: true, provider: '', model: '' }, ['Keep me.']]);
  delete backup.projects[0].lessons;
  await board.importBackup(backup, { replace: true });
  assert.deepEqual((await restored.view(w.project.id)).lessons.map(lesson => lesson.text), ['Keep me.']);
});

test('HTTP routes: views and changes need the session token and the current revision, unknown projects are refused, owner work takes the slot first, and deleting a project removes its memory', { timeout: 60000 }, async t => {
  let held = null;
  const runner = async call => {
    if (!call.prompt.startsWith('# Promptboard project memory')) return { text: 'Not a split.' };
    if (held) return answer(LESSONS.slice(0, 2));
    return new Promise((resolve, reject) => { held = call; call.signal.addEventListener('abort', () => reject(new ProviderError('Generation was cancelled.', 'ABORTED')), { once: true }); });
  };
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [], runner });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = async (path, method = 'GET', body) => { const response = await fetch(`${app.url}${path}`, { method, headers: { 'x-ste-token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, json: await response.json() }; };
  const project = await app.board.createProject({ name: 'Shop' });
  const card = await app.board.createTask({ projectId: project.id, title: 'Merged card', prompt: 'Done already.' });
  assert.equal((await fetch(`${app.url}/api/projects/${project.id}/lessons`)).status, 403, 'the session token is required');
  assert.deepEqual([(await call('/api/projects/missing/lessons')).status, (await call('/api/projects/missing/lessons/settings', 'PATCH', { enabled: false, expectedRevision: 0 })).status], [404, 404]);
  const fresh = await call(`/api/projects/${project.id}/lessons`);
  assert.deepEqual([fresh.status, fresh.json.revision, fresh.json.settings, fresh.json.lessons], [200, 0, { enabled: true, provider: '', model: '' }, []]);
  assert.equal((await call(`/api/projects/${project.id}/lessons/settings`, 'PATCH', { enabled: false })).json.code, 'REVISION_REQUIRED');
  assert.equal((await call(`/api/projects/${project.id}/lessons/settings`, 'PATCH', { provider: 'agy', expectedRevision: 0 })).status, 400);
  assert.equal((await call(`/api/projects/${project.id}/lessons/settings`, 'PATCH', { model: 'haiku', expectedRevision: 0 })).json.code, 'INVALID_INPUT', 'a model needs a CLI');
  assert.equal((await call(`/api/tasks/${card.id}/lessons`, 'POST', { expectedRevision: 0 })).json.code, 'NOT_MERGED');
  await app.board.store.update(state => { Object.assign(state.projects[0].tasks[0], { column: 'done', completion: { kind: 'merged', at: Date.now(), targetBranch: 'trunk', commits: 1 } }); });
  const queued = await call(`/api/tasks/${card.id}/lessons`, 'POST', { expectedRevision: 0 });
  assert.deepEqual([queued.status, ['queued', 'running'].includes(queued.json.jobs[0].status), queued.json.jobs[0].trigger], [200, true, 'owner']);
  await until(() => held, 'the lessons run holds the slot');
  // The owner's own Compose work takes the slot; the lessons job is queued again instead of making them wait.
  const split = await call('/api/split', 'POST', { prompt: 'Split this task into two.', provider: 'claude' });
  assert.notEqual(split.status, 409, JSON.stringify(split.json));
  await until(async () => (await call(`/api/projects/${project.id}/lessons`)).json.jobs[0].status === 'queued', 'queued again');
  // The next start (here: a click) runs it.
  await app.board.lessons.kick();
  await until(async () => (await call(`/api/projects/${project.id}/lessons`)).json.jobs[0].status === 'done', 'done');
  let view = (await call(`/api/projects/${project.id}/lessons`)).json;
  assert.equal(view.lessons.length, 2);
  assert.equal((await call(`/api/projects/${project.id}/lessons/${view.lessons[0].id}`, 'PATCH', { status: 'approved', expectedRevision: view.revision - 1 })).status, 409);
  view = (await call(`/api/projects/${project.id}/lessons/${view.lessons[0].id}`, 'PATCH', { status: 'approved', expectedRevision: view.revision })).json;
  assert.equal(view.lessons[0].status, 'approved');
  view = (await call(`/api/projects/${project.id}/lessons/approve`, 'POST', { ids: [view.lessons[1].id], expectedRevision: view.revision })).json;
  assert.deepEqual(view.lessons.map(lesson => lesson.status), ['approved', 'approved']);
  assert.equal((await call(`/api/projects/${project.id}/lessons/nope`, 'PATCH', { status: 'approved', expectedRevision: view.revision })).status, 404);
  view = (await call(`/api/projects/${project.id}/lessons/settings`, 'PATCH', { enabled: false, provider: 'gemini', model: 'gemini-2.5-flash', expectedRevision: view.revision })).json;
  assert.deepEqual(view.settings, { enabled: false, provider: 'gemini', model: 'gemini-2.5-flash' });
  // Deleting the project deletes its memory.
  await stat(fileOf(app.board.dataDir, project.id));
  const removed = await fetch(`${app.url}/api/projects/${project.id}?expectedRevision=${(await app.board.state()).projects[0].revision}`, { method: 'DELETE', headers: { 'x-ste-token': token } });
  assert.equal(removed.status, 200);
  await assert.rejects(stat(fileOf(app.board.dataDir, project.id)), { code: 'ENOENT' });
});
