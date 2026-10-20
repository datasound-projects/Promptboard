import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board, normalizeSource, prerequisiteMet, projectColumns } from '../src/board.mjs';
import { resolveConfig } from '../src/agents.mjs';

const project = { workflowMode: 'pipeline', pipeline: { columns: [{ id: 'todo', role: 'todo' }, { id: 'finished', role: 'done' }] } };
const card = extra => ({ column: 'finished', ...extra });
const CASES = [
  [{ completion: { kind: 'merged' } }, true],
  [{ completion: { kind: 'no_changes' } }, true],
  [{ completion: null }, true, 'a Done card from before completions were recorded'],
  [{ completion: { kind: 'unmerged', branch: null } }, true, 'a card that never had a worktree has no code'],
  [{ workspace: { branch: 'task/a' }, completion: { kind: 'unmerged', branch: 'task/a' } }, false],
  [{ workspace: null, completion: { kind: 'unmerged', branch: 'task/a' } }, false, 'Remove worktree does not merge the code'],
  [{ workspace: null, completion: { kind: 'pull_request', mergedAt: null, url: 'https://github.com/o/r/pull/1' } }, false, 'an open pull request'],
  [{ workspace: { branch: 'task/a' }, completion: { kind: 'pull_request', mergedAt: null } }, false],
  [{ workspace: null, completion: { kind: 'pull_request', mergedAt: 1 } }, true],
  [{ workspace: { branch: 'task/a' }, completion: { kind: 'closed', branch: 'task/a' } }, false, 'an unknown kind with code on a branch'],
  [{ column: 'todo', completion: { kind: 'merged' } }, false],
];

test('a prerequisite counts only when its code is on the target branch, also after its worktree is removed', () => {
  for (const [extra, met, label] of CASES) assert.equal(prerequisiteMet(project, card(extra)), met, label || JSON.stringify(extra));
});

test('the page applies the board’s prerequisite rule to the same cards, on pipeline and legacy boards', async () => {
  // public/app.js keeps its own copy of the rule for card badges; it runs here on the server's cases.
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('const cardDone = '), end = source.indexOf('\n', source.indexOf('const prerequisiteMet = '));
  const page = new Function('projectColumnsOf', `${source.slice(start, end)}\nreturn prerequisiteMet;`)(board => board.columns);
  const legacy = { workflowMode: 'legacy' };
  for (const [board, done] of [[project, 'finished'], [legacy, 'done']]) for (const [extra, met, label] of CASES) {
    const entry = { column: done, ...extra, ...(extra.column ? { column: extra.column } : {}) };
    assert.equal(prerequisiteMet(board, entry), met, label);
    assert.equal(page({ ...board, columns: projectColumns(board) }, entry), met, `page: ${label || JSON.stringify(extra)}`);
  }
});

test('the page normalizes a card source as the board does; only the board keeps a saved prompt link', async () => {
  // public/app.js keeps its own copy for Compose results; it runs here with its own helpers on the same inputs.
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), line = start => source.slice(source.indexOf(start), source.indexOf('\n', source.indexOf(start)));
  const body = source.slice(source.indexOf('function normalizeSource(source) {'), source.indexOf('\n}\n', source.indexOf('function normalizeSource(source) {')) + 2);
  const page = new Function(`${line('const MAX_PROMPT_BYTES = ')}\n${line('const KNOWN_PROVIDERS = ')}\n${line('function safeText(')}\n${body}\nreturn normalizeSource;`)();
  const long = 'x'.repeat(300), link = { projectId: 'p1', promptId: 'q1', promptRevision: 2 };
  for (const input of [null, undefined, 'text', 7, {}, { historyId: long, provider: 'claude', model: long, effort: long, reportedModels: ['a', 3, long, ...Array(30).fill('m')], language: 'pl', quality: 'fast', verification: 'checks-passed', generatedAt: 5 },
    { provider: 'other', language: 'fr', quality: 'slow', verification: 'passed', generatedAt: Infinity, reportedModels: 'a' }, { generatedAt: '5', historyId: 3 }, { ...link }, { ...link, promptRevision: 0 }]) {
    const { projectId, promptId, promptRevision, ...shared } = normalizeSource(input) || {};
    assert.deepEqual(page(input), normalizeSource(input) && shared, JSON.stringify(input));
  }
  assert.deepEqual(Object.keys(normalizeSource(link)).slice(-3), ['projectId', 'promptId', 'promptRevision']);
});

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
async function temp(t, prefix) { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return dir; }
/** A linked board whose executor validates configurations without a CLI and starts nothing unless a test says so. */
async function world(t, workflowMode) {
  const root = await temp(t, 'pb-audit-repo-'), board = new Board({ dataDir: await temp(t, 'pb-audit-data-') });
  git(root, 'init', '-q', '-b', 'trunk'); git(root, 'config', 'user.email', 't@example.com'); git(root, 'config', 'user.name', 'T'); git(root, 'commit', '-q', '--allow-empty', '-m', 'init');
  const created = await board.createProject({ name: 'Audit', workflowMode });
  await board.linkRepository(created.id, { path: root, expectedRevision: created.revision });
  const hooks = { validate: async () => {}, start: async () => {} };
  board.executor = { validate: async ({ stage, config }) => { await hooks.validate(); return resolveConfig(stage, config); }, start: payload => hooks.start(payload) };
  const projectNow = async () => (await board.state()).projects[0];
  const task = async id => (await projectNow()).tasks.find(item => item.id === id);
  // The supervisor's failed-start path: the run fails before its session begins.
  const failStart = async run => { await board.updateRun(run.id, { status: 'failed', reason: 'The CLI disappeared.' }); await board.runFailedToStart(run.id); };
  return { board, hooks, projectId: created.id, projectNow, task, failStart };
}

test('a run that fails to start after a move out of Done returns the card to Done with its completion, so its unmerged code still counts', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, 'pipeline');
  const created = await w.board.createTask({ projectId: w.projectId, title: 'Unmerged work', prompt: 'Change it.' });
  await w.board.ensureTaskWorktree(created.id);
  await w.board.transition(created.id, { column: 'done', expectedRevision: (await w.task(created.id)).revision });
  const done = await w.task(created.id);
  assert.equal(done.completion.kind, 'unmerged'); assert.equal(prerequisiteMet(await w.projectNow(), done), false);
  w.hooks.start = ({ run }) => w.failStart(run);
  const { run } = await w.board.transition(created.id, { column: 'executing', expectedRevision: done.revision });
  const back = await w.task(created.id);
  assert.equal((await w.board.run(run.id)).status, 'failed');
  assert.equal(back.column, 'done');
  assert.deepEqual(back.completion, done.completion, 'the completion the move archived is current again');
  assert.deepEqual(back.previousCompletions || [], []);
  assert.ok(back.archivedAt);
  assert.equal(prerequisiteMet(await w.projectNow(), back), false, 'a dependent still waits for the unmerged code');
});

test('a column removed while a move is prepared refuses the move, and a failed start never returns a card to a removed column', { skip: process.platform === 'win32' }, async t => {
  const w = await world(t, 'legacy');
  const layout = custom => [{ id: 'todo' }, ...(custom ? [{ id: 'c_triage01', title: 'Triage' }] : []), { id: 'planning' }, { id: 'executing' }, ...(custom ? [{ id: 'c_qa000001', title: 'QA', agent: { enabled: true } }] : []), { id: 'code_review' }, { id: 'testing' }, { id: 'merge' }, { id: 'done' }];
  await w.board.setColumns(w.projectId, { columns: layout(true), expectedRevision: (await w.projectNow()).revision });
  const created = await w.board.createTask({ projectId: w.projectId, title: 'Moving card', prompt: 'Do it.' });
  await w.board.store.update(state => { state.projects[0].tasks[0].column = 'executing'; });
  // The QA column is removed while the move into it waits for the agent check.
  let release; const gate = new Promise(resolve => { release = resolve; });
  let checking; const checked = new Promise(resolve => { checking = resolve; });
  w.hooks.validate = () => { checking(); return gate; };
  const move = w.board.transition(created.id, { column: 'c_qa000001', expectedRevision: (await w.task(created.id)).revision, decision: 'move' });
  await checked;
  await w.board.setColumns(w.projectId, { columns: layout(true).filter(entry => entry.id !== 'c_qa000001'), expectedRevision: (await w.projectNow()).revision });
  release();
  await assert.rejects(move, { code: 'REVISION_CONFLICT' });
  assert.equal((await w.task(created.id)).column, 'executing', 'the card stays visible where it was');
  // A card leaves Triage for Planning; Triage is removed before its run fails to start.
  w.hooks.validate = async () => {};
  await w.board.store.update(state => { state.projects[0].tasks[0].column = 'c_triage01'; });
  let failing; const started = new Promise(resolve => { w.hooks.start = ({ run }) => { failing = run; resolve(); }; });
  await w.board.transition(created.id, { column: 'planning', expectedRevision: (await w.task(created.id)).revision });
  await started;
  await w.board.setColumns(w.projectId, { columns: layout(false), expectedRevision: (await w.projectNow()).revision });
  await w.failStart(failing);
  assert.equal((await w.task(created.id)).column, 'planning', 'the card stays in a column that exists, with its failed run');
});
