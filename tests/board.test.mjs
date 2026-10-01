import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board, canTransition, COLUMNS } from '../src/board.mjs';
import { Store } from '../src/store.mjs';
import { initRepository, validateRepository } from '../src/git.mjs';
import { startServer } from '../src/server.mjs';

const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
const exists = path => access(path).then(() => true, () => false);

async function temp(t, prefix) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
/** A repository whose only branch is "trunk", with one commit. */
async function repo(t) {
  const dir = await temp(t, 'pb-repo-');
  run(dir, 'init', '-q', '-b', 'trunk');
  run(dir, 'config', 'user.email', 'test@example.com'); run(dir, 'config', 'user.name', 'Test');
  await writeFile(join(dir, 'README.md'), 'hello\n');
  run(dir, 'add', '.'); run(dir, 'commit', '-q', '-m', 'Initial commit');
  return dir;
}
async function linkedBoard(t, options = {}) {
  const dataDir = await temp(t, 'pb-data-');
  const root = await repo(t);
  const board = new Board({ dataDir, ...options });
  const project = await board.createProject({ name: 'App' });
  await board.linkRepository(project.id, { path: root, expectedRevision: 1 });
  await board.setTargetBranch(project.id, { branch: 'trunk', expectedRevision: 2 });
  return { board, root, dataDir, projectId: project.id };
}
const taskIn = async (board, id) => (await board.view()).projects.flatMap(project => project.tasks).find(task => task.id === id);

test('the seven fixed columns and the transition matrix of the stage contract; every other pair is refused', () => {
  assert.deepEqual(COLUMNS.map(column => column.title), ['To Do', 'Planning', 'Executing', 'Code Review', 'Testing', 'Merge', 'Done']);
  assert.deepEqual(COLUMNS.filter(column => !column.agent).map(column => column.id), ['todo', 'done']);
  const allowed = new Set(['todo>planning', 'todo>executing', 'planning>executing', 'planning>todo', 'executing>code_review', 'executing>todo',
    'code_review>testing', 'code_review>executing', 'testing>merge', 'testing>executing', 'testing>done', 'merge>done', 'merge>executing', 'merge>code_review']);
  const ids = COLUMNS.map(column => column.id);
  for (const from of ids) for (const to of ids) if (from !== to) assert.equal(canTransition(from, to), allowed.has(`${from}>${to}`), `${from} -> ${to}`);
  assert.equal(canTransition('todo', 'nowhere'), false);
  assert.equal(canTransition('nowhere', 'todo'), false);
});

test('the store serializes writes, replaces the file atomically, and recovers from corruption', async t => {
  const dir = await temp(t, 'pb-store-');
  const store = new Store(dir);
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.update(state => { state.projects.push({ id: `p${i}`, tasks: [] }); })));
  assert.equal((await store.read()).projects.length, 20);
  assert.equal((await store.read()).revision, 20);
  const saved = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
  assert.equal(saved.projects.length, 20);
  assert.equal(saved.version, 2);
  assert.deepEqual((await readdir(dir)).filter(name => name.includes('.tmp-')), []);
  // A failed change leaves both memory and disk unchanged.
  await assert.rejects(store.update(state => { state.projects = []; throw new Error('boom'); }), /boom/);
  assert.equal((await store.read()).projects.length, 20);
  // A corrupt file is quarantined and the backup (the previous good write) is used.
  await writeFile(join(dir, 'state.json'), '{"schema":"promptboard.state",');
  const recovered = new Store(dir);
  assert.equal((await recovered.read()).projects.length, 19);
  assert.equal(recovered.recovery.restoredFromBackup, true);
  assert.ok((await readdir(dir)).some(name => name.startsWith('state.corrupt-')));
  // A newer format is refused and left untouched.
  const future = JSON.stringify({ schema: 'promptboard.state', version: 99, projects: [], runs: [] });
  await writeFile(join(dir, 'state.json'), future);
  await assert.rejects(new Store(dir).read(), { code: 'STATE_VERSION_UNSUPPORTED' });
  assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), future);
});

test('repository validation explains each invalid case and accepts linked worktrees', { skip: process.platform === 'win32' }, async t => {
  const root = await repo(t);
  const outside = await temp(t, 'pb-plain-');
  await assert.rejects(validateRepository('relative/path'), { code: 'INVALID_PATH' });
  await assert.rejects(validateRepository(join(outside, 'missing')), { code: 'PATH_NOT_FOUND' });
  await writeFile(join(outside, 'file.txt'), 'x');
  await assert.rejects(validateRepository(join(outside, 'file.txt')), { code: 'NOT_A_DIRECTORY' });
  await assert.rejects(validateRepository(outside), { code: 'NOT_A_REPOSITORY', message: /does not create repositories on its own/ });
  const bare = await temp(t, 'pb-bare-');
  run(bare, 'init', '-q', '--bare');
  await assert.rejects(validateRepository(bare), { code: 'BARE_REPOSITORY' });
  const empty = await temp(t, 'pb-empty-');
  run(empty, 'init', '-q');
  await assert.rejects(validateRepository(empty), { code: 'NO_COMMITS', message: /does not create commits on its own/ });
  // Explicit setup: an empty first commit for a repository without commits, a new folder when it is
  // missing, and a refusal for a repository that already has commits.
  const identity = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e' };
  const saved = Object.fromEntries(Object.keys(identity).map(key => [key, process.env[key]]));
  Object.assign(process.env, identity);
  try {
    assert.deepEqual(await initRepository(empty), { createdFolder: false, initialized: false });
    assert.equal((await validateRepository(empty)).root, await realpath(empty));
    await assert.rejects(initRepository(empty), { code: 'ALREADY_A_REPOSITORY' });
    const fresh = join(outside, 'new', 'project');
    assert.deepEqual(await initRepository(fresh), { createdFolder: true, initialized: true });
    assert.ok((await validateRepository(fresh)).branches.length === 1);
  } finally { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await assert.rejects(validateRepository(join(root, '.git')), { code: 'NOT_A_WORKTREE' });
  const valid = await validateRepository(join(root, '.'));
  assert.equal(valid.root, root);
  assert.equal(valid.linkedWorktree, false);
  assert.deepEqual(valid.branches.map(branch => branch.name), ['trunk']);
  assert.equal(valid.currentBranch, 'trunk');
  // A linked worktree has a .git file, not a directory.
  const linked = join(await temp(t, 'pb-linked-'), 'wt');
  run(root, 'worktree', 'add', '-q', '-b', 'side', linked);
  const fromLinked = await validateRepository(linked);
  assert.equal(fromLinked.linkedWorktree, true);
  assert.equal(fromLinked.commonDir, valid.commonDir);
  assert.equal(fromLinked.root, await realpath(linked));
  // Missing Git is reported as such.
  const path = process.env.PATH;
  process.env.PATH = outside;
  try { await assert.rejects(validateRepository(root), { code: 'GIT_MISSING', message: /Git was not found/ }); }
  finally { process.env.PATH = path; }
  // Validation never initializes anything.
  assert.equal(await exists(join(outside, '.git')), false);
});

test('two tasks get different branches and folders from the recorded target commit; the checkout is untouched', { skip: process.platform === 'win32' }, async t => {
  const { board, root, dataDir, projectId } = await linkedBoard(t);
  const recorded = run(root, 'rev-parse', 'trunk');
  // The target branch moves after it was recorded; worktrees still use the recorded commit.
  await writeFile(join(root, 'later.txt'), 'later\n');
  run(root, 'add', '.'); run(root, 'commit', '-q', '-m', 'Later');
  await writeFile(join(root, 'README.md'), 'uncommitted user edit\n');
  const before = { head: run(root, 'rev-parse', 'HEAD'), branch: run(root, 'branch', '--show-current'), status: run(root, 'status', '--porcelain'), readme: await readFile(join(root, 'README.md'), 'utf8') };
  const one = await board.createTask({ projectId, title: 'Add login', prompt: 'Add login.' });
  const two = await board.createTask({ projectId, title: 'Add login', prompt: 'Same title, other task.' });
  const [a, b] = await Promise.all([board.ensureTaskWorktree(one.id), board.ensureTaskWorktree(two.id)]);
  assert.notEqual(a.branch, b.branch);
  assert.notEqual(a.path, b.path);
  for (const workspace of [a, b]) {
    assert.equal(workspace.status, 'ready');
    assert.equal(workspace.baseCommit, recorded);
    assert.equal(run(workspace.path, 'rev-parse', 'HEAD'), recorded);
    assert.ok(workspace.path.startsWith(await realpath(dataDir)), 'Worktrees live in the app data folder.');
    assert.ok(!workspace.path.startsWith(root));
  }
  assert.deepEqual({ head: run(root, 'rev-parse', 'HEAD'), branch: run(root, 'branch', '--show-current'), status: run(root, 'status', '--porcelain'), readme: await readFile(join(root, 'README.md'), 'utf8') }, before);
  // Repeated and concurrent requests reuse the same worktree.
  const again = await Promise.all([board.ensureTaskWorktree(one.id), board.ensureTaskWorktree(one.id), board.ensureTaskWorktree(one.id)]);
  assert.ok(again.every(workspace => workspace.path === a.path && workspace.branch === a.branch));
  const listed = run(root, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree '));
  assert.equal(listed.length, 3, 'The main checkout plus exactly one worktree per task.');
});

test('worktree cleanup refuses dirty and unowned worktrees and never deletes the branch', { skip: process.platform === 'win32' }, async t => {
  const { board, root, projectId } = await linkedBoard(t);
  const task = await board.createTask({ projectId, title: 'Clean me', prompt: 'x' });
  const workspace = await board.ensureTaskWorktree(task.id);
  await writeFile(join(workspace.path, 'work.txt'), 'unsaved\n');
  await assert.rejects(board.removeTaskWorktree(task.id), { code: 'WORKTREE_DIRTY' });
  assert.equal(await readFile(join(workspace.path, 'work.txt'), 'utf8'), 'unsaved\n');
  await assert.rejects(board.deleteTask(task.id, { expectedRevision: (await taskIn(board, task.id)).revision }), { code: 'WORKTREE_DIRTY' });
  assert.ok(await taskIn(board, task.id), 'A task with a dirty worktree is kept.');
  await rm(join(workspace.path, 'work.txt'));
  // A record that points outside the app folder is never removed.
  const other = await board.createTask({ projectId, title: 'Not ours', prompt: 'x' });
  const foreign = join(await temp(t, 'pb-foreign-'), 'wt');
  run(root, 'worktree', 'add', '-q', '-b', 'foreign', foreign);
  await board.store.update(state => { state.projects[0].tasks.find(item => item.id === other.id).workspace = { status: 'ready', branch: 'foreign', path: foreign, repositoryRoot: root }; });
  await assert.rejects(board.removeTaskWorktree(other.id), { code: 'WORKTREE_NOT_OWNED' });
  assert.equal(await exists(foreign), true);
  // A clean owned worktree is removed; its branch stays.
  await board.deleteTask(task.id, { expectedRevision: (await taskIn(board, task.id)).revision });
  assert.equal(await exists(workspace.path), false);
  assert.equal(run(root, 'branch', '--list', workspace.branch).replace('*', '').trim(), workspace.branch);
});

test('runs: To Do and Done never run; consent is required; without an executor nothing is created; runs reuse one worktree', { skip: process.platform === 'win32' }, async t => {
  const inactive = await linkedBoard(t);
  const idle = await inactive.board.createTask({ projectId: inactive.projectId, title: 'Idle', prompt: 'x' });
  await assert.rejects(inactive.board.requestRun(idle.id, { stage: 'todo', consent: true }), { code: 'STAGE_NOT_RUNNABLE' });
  await inactive.board.moveTask(idle.id, { column: 'planning', expectedRevision: 1 });
  await assert.rejects(inactive.board.requestRun(idle.id, { stage: 'planning', consent: true }), { code: 'EXECUTION_UNAVAILABLE' });
  assert.equal((await taskIn(inactive.board, idle.id)).workspace, null, 'No worktree without an executor.');
  assert.deepEqual((await inactive.board.view()).runs, []);

  const started = [];
  const executor = { validate: async ({ config }) => ({ provider: 'claude', model: '', effort: '', permissionMode: 'acceptEdits', ...config }), start: async context => { started.push(context); } };
  const { board, projectId, dataDir } = await linkedBoard(t, { executor });
  const task = await board.createTask({ projectId, title: 'Feature', prompt: 'Build it.' });
  await assert.rejects(board.requestRun(task.id, { stage: 'todo', consent: true }), { code: 'STAGE_NOT_RUNNABLE' });
  let revision = (await taskIn(board, task.id)).revision;
  await board.moveTask(task.id, { column: 'executing', expectedRevision: revision }); // Planning is optional.
  await assert.rejects(board.requestRun(task.id, { stage: 'planning', consent: true }), { code: 'STAGE_MISMATCH' });
  await assert.rejects(board.requestRun(task.id, { stage: 'executing' }), { code: 'CONSENT_REQUIRED' });
  assert.equal((await taskIn(board, task.id)).workspace, null, 'A refused request creates nothing.');
  // Duplicate requests create one run.
  const results = await Promise.allSettled([1, 2, 3].map(() => board.requestRun(task.id, { stage: 'executing', consent: true })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.code === 'RUN_ACTIVE'));
  const first = results.find(result => result.status === 'fulfilled').value;
  assert.equal(first.status, 'queued');
  assert.equal(first.promptRevision, 1);
  assert.equal(first.workspacePath, started[0].workspace.path);
  revision = (await taskIn(board, task.id)).revision;
  await assert.rejects(board.moveTask(task.id, { column: 'code_review', expectedRevision: revision }), { code: 'RUN_ACTIVE' });
  await board.updateRun(first.id, { status: 'running' });
  await assert.rejects(board.updateRun(first.id, { status: 'queued' }), { code: 'RUN_TRANSITION_NOT_ALLOWED' });
  await board.updateRun(first.id, { status: 'succeeded' });
  const second = await board.requestRun(task.id, { stage: 'executing', consent: true });
  assert.equal(started.length, 2);
  assert.equal(started[1].workspace.path, started[0].workspace.path);
  assert.equal(started[1].workspace.branch, started[0].workspace.branch);
  await board.updateRun(second.id, { status: 'cancelled' });
  await assert.rejects(board.moveTask(task.id, { column: 'code_review', expectedRevision: (await taskIn(board, task.id)).revision }), { code: 'NO_CHANGES' }, 'Review needs committed changes; the card stays.');
  assert.equal((await taskIn(board, task.id)).column, 'executing');
  await assert.rejects(board.requestRun(task.id, { stage: 'code_review', consent: true }), { code: 'STAGE_MISMATCH' });
  // A restart marks active runs interrupted and never calls the executor again.
  const third = await board.store.update(state => { const run = { ...state.runs[0], id: 'active-run', status: 'running' }; state.runs.push(run); return run; });
  const restarted = new Board({ dataDir, executor: { start: () => assert.fail('A restart must not start runs.') } });
  const runs = (await restarted.view()).runs;
  assert.equal(runs.find(item => item.id === third.id).status, 'interrupted');
  assert.equal(runs.find(item => item.id === first.id).status, 'succeeded');
});

test('linking defaults the target branch to the checked-out branch; projects without one still start agents', { skip: process.platform === 'win32' }, async t => {
  const dataDir = await temp(t, 'pb-data-');
  const root = await repo(t);
  const executor = { validate: async ({ config }) => ({ provider: 'claude', model: '', effort: '', permissionMode: 'plan', ...config }), start: async () => {} };
  const board = new Board({ dataDir, executor });
  const project = await board.createProject({ name: 'App' });
  const { project: linked } = await board.linkRepository(project.id, { path: root, expectedRevision: 1 });
  assert.equal(linked.targetBranch.name, 'trunk');
  // A project linked before the default existed has no target branch.
  await board.store.update(state => { state.projects.find(item => item.id === project.id).targetBranch = null; });
  const task = await board.createTask({ projectId: project.id, title: 'Plan it', prompt: 'x' });
  await board.moveTask(task.id, { column: 'planning', expectedRevision: 1 });
  assert.equal((await board.requestRun(task.id, { stage: 'planning', consent: true })).status, 'queued');
  assert.equal((await board.view()).projects[0].targetBranch.name, 'trunk');
});

test('plan approval is tied to the task text; editing the task makes it stale', async t => {
  const dataDir = await temp(t, 'pb-data-');
  const board = new Board({ dataDir });
  const project = await board.createProject({ name: 'Plans' });
  const task = await board.createTask({ projectId: project.id, title: 'T', prompt: 'Original.' });
  await board.store.update(state => { state.runs.push({ id: 'plan-1', taskId: task.id, projectId: project.id, stage: 'planning', status: 'waiting_for_input', promptRevision: 1, hasPlan: true, turns: 1 }); });
  await assert.rejects(board.approvePlan(task.id, { runId: 'missing' }), { code: 'PLAN_MISSING' });
  const approved = await board.approvePlan(task.id, { runId: 'plan-1' });
  assert.deepEqual([approved.planApproval.runId, approved.planApproval.contentRevision], ['plan-1', 1]);
  const moved = await board.updateTask(task.id, { title: 'T', prompt: 'Original.', expectedRevision: approved.revision });
  assert.equal(moved.changed, false);
  const edited = await board.updateTask(task.id, { prompt: 'Changed.', expectedRevision: approved.revision });
  assert.equal(edited.task.contentRevision, 2);
  assert.notEqual(edited.task.planApproval.contentRevision, edited.task.contentRevision, 'The old approval no longer matches the task text.');
  await assert.rejects(board.approvePlan(task.id, { runId: 'plan-1' }), { code: 'PLAN_STALE' });
});

test('card moves are validated, need a linked project, use revisions, and never create runs', async t => {
  const dataDir = await temp(t, 'pb-data-');
  const board = new Board({ dataDir });
  const project = await board.createProject({ name: 'Unlinked' });
  const task = await board.createTask({ projectId: project.id, title: 'T', prompt: 'P' });
  await assert.rejects(board.moveTask(task.id, { column: 'planning', expectedRevision: 1 }), { code: 'REPOSITORY_REQUIRED' });
  await assert.rejects(board.moveTask(task.id, { column: 'code_review', expectedRevision: 1 }), { code: 'TRANSITION_NOT_ALLOWED', message: /Allowed from To Do: Planning, Executing/ });
  await assert.rejects(board.moveTask(task.id, { column: 'done', expectedRevision: 1 }), { code: 'TRANSITION_NOT_ALLOWED' });
  await assert.rejects(board.moveTask(task.id, { column: 'nowhere', expectedRevision: 1 }), { code: 'INVALID_COLUMN' });
  await assert.rejects(board.updateTask(task.id, { title: 'New', expectedRevision: 7 }), { code: 'REVISION_CONFLICT' });
  await assert.rejects(board.updateTask(task.id, { title: 'New' }), { code: 'REVISION_REQUIRED' });
  const second = await board.createTask({ projectId: project.id, title: 'U', prompt: 'Q' });
  await board.moveTask(second.id, { column: 'todo', index: 0, expectedRevision: 1 });
  assert.deepEqual((await board.view()).projects[0].tasks.map(item => item.title), ['U', 'T']);
  assert.deepEqual((await board.view()).runs, []);
});

test('browser migration keeps IDs, order, exact text, sources, and flags, and is idempotent', async t => {
  const dataDir = await temp(t, 'pb-data-');
  const board = new Board({ dataDir });
  await board.createProject({ name: 'Alpha' }); // A name clash with a different project ID.
  const exact = '  Leading spaces\r\nCRLF\n\ttab <script>x</script> 🚀\n  ';
  const source = { historyId: 'h1', provider: 'codex', model: 'm', effort: 'high', reportedModels: ['r'], language: 'de', quality: 'reviewed', verification: 'needs-review', generatedAt: 5 };
  const browser = { version: 1, selectedProjectId: 'p1', projects: [
    { id: 'p1', name: 'Alpha', createdAt: 1, cards: [
      { id: 'c1', title: 'First', prompt: exact, createdAt: 1, updatedAt: 2, checksOutdated: true, source },
      { id: 'c2', title: 'Second', prompt: 'Two', createdAt: 3, updatedAt: 3, checksOutdated: false, source: null }] },
    { id: 'p2', name: 'Beta', createdAt: 2, cards: [] },
  ] };
  assert.deepEqual(await board.migrateBrowserBoard(browser), { projects: 2, cards: 2, skipped: 0 });
  assert.deepEqual(await board.migrateBrowserBoard(browser), { projects: 0, cards: 0, skipped: 2 });
  const view = await board.view();
  assert.equal(view.projects.length, 3);
  const migrated = view.projects.find(project => project.id === 'p1');
  assert.equal(migrated.name, 'Alpha (2)');
  assert.deepEqual(migrated.tasks.map(task => task.id), ['c1', 'c2']);
  assert.equal(migrated.tasks[0].prompt, exact);
  assert.deepEqual(migrated.tasks[0].source, source);
  assert.equal(migrated.tasks[0].checksOutdated, true);
  assert.equal(migrated.tasks[0].updatedAt, 2);
  assert.ok(migrated.tasks.every(task => task.column === 'todo' && task.workspace === null));
  assert.deepEqual(view.runs, []);
  await assert.rejects(board.migrateBrowserBoard({ version: 1, projects: [{ id: 'x', name: 'X', cards: [{ id: 'y', title: 'T', prompt: '' }] }] }), { code: 'INVALID_BACKUP' });
});

test('created and imported projects keep independent agent defaults and column layouts', async t => {
  const board = new Board({ dataDir: await temp(t, 'pb-isolation-') });
  const first = await board.createProject({ name: 'First' });
  const second = await board.createProject({ name: 'Second' });
  await board.setWorkflow(first.id, { agentDefaults: { provider: 'codex', model: 'first-model' }, workflow: {}, expectedRevision: 1 });
  await board.setWorkflow(second.id, { agentDefaults: { provider: 'claude', model: 'second-model' }, workflow: {}, expectedRevision: 1 });
  const layout = COLUMNS.map(column => ({ id: column.id, title: column.id === 'todo' ? 'Ideas' : column.title }));
  layout.splice(3, 0, { id: 'c_docs123', title: 'Documentation', color: 'blue' });
  await board.setColumns(first.id, { columns: layout, expectedRevision: 2 });
  let projects = (await board.view()).projects;
  assert.equal(projects[0].columns[0].title, 'Ideas');
  assert.equal(projects[1].columns[0].title, 'To Do');
  assert.deepEqual(projects.map(project => project.columns.length), [8, 7]);
  const imported = new Board({ dataDir: await temp(t, 'pb-isolation-import-') });
  await imported.importBackup(await board.exportBackup());
  projects = (await imported.view()).projects;
  assert.equal(projects[0].agentDefaults?.provider, undefined);
  assert.equal(projects[0].pendingImport.agentDefaults.model, 'first-model');
  for (const project of projects) await imported.confirmImport(project.id, { accept: true, expectedRevision: project.revision });
  projects = (await imported.view()).projects;
  assert.deepEqual(projects.map(project => project.agentDefaults.model), ['first-model', 'second-model']);
  assert.deepEqual(projects.map(project => project.columns[0].title), ['Ideas', 'To Do']);
  assert.deepEqual(projects.map(project => project.columns.length), [8, 7]);
  assert.equal(projects[0].columns[3].title, 'Documentation');
  assert.deepEqual((await imported.view()).runs, []);
});

test('import keeps execution inactive and waits for confirmation of paths and automation', { skip: process.platform === 'win32' }, async t => {
  const { board, root, projectId } = await linkedBoard(t);
  const task = await board.createTask({ projectId, title: 'Exported', prompt: 'Exact\r\ntext' });
  await board.moveTask(task.id, { column: 'planning', expectedRevision: 1 });
  const backup = await board.exportBackup();
  assert.equal(backup.kind, 'promptboard-backup');
  assert.equal(backup.projects[0].repository.path, root);
  assert.equal(JSON.stringify(backup).includes('workspace'), false);
  backup.projects[0].workflow = { executing: { policy: 'start', provider: 'codex' } };
  const other = new Board({ dataDir: await temp(t, 'pb-data-') });
  await other.createProject({ name: 'Existing' });
  await assert.rejects(other.importBackup(backup), { code: 'CONFIRMATION_REQUIRED' });
  await other.importBackup(backup, { replace: true });
  let project = (await other.view()).projects[0];
  assert.equal(project.repository, null, 'Imported paths are not linked automatically.');
  assert.deepEqual(project.workflow, {}, 'Imported automation is not active.');
  assert.equal(project.effectiveWorkflow.executing.policy, 'start', 'The default: dragging starts the stage. Imported settings wait.');
  assert.deepEqual(project.pendingImport, { repositoryPath: root, targetBranch: 'trunk', workflow: { executing: { policy: 'start', provider: 'codex' } }, testCommands: null });
  assert.equal(project.tasks[0].column, 'planning');
  assert.equal(project.tasks[0].prompt, 'Exact\r\ntext');
  assert.deepEqual((await other.view()).runs, []);
  await other.confirmImport(project.id, { accept: true, expectedRevision: project.revision });
  project = (await other.view()).projects[0];
  assert.equal(project.repository.root, root);
  assert.equal(project.targetBranch.name, 'trunk');
  assert.equal(project.pendingImport, null);
  assert.equal(project.workflow.executing.policy, 'start', 'Confirmed workflow settings apply.');
  assert.equal(project.workflow.executing.permissionMode, 'workspace-write');
  // A board whose tasks own worktrees cannot be replaced.
  await board.ensureTaskWorktree(task.id);
  await assert.rejects(board.importBackup(backup, { replace: true }), { code: 'WORKSPACES_EXIST' });
});

test('board HTTP routes need the page token, resolve paths on the server, and never start agents', { skip: process.platform === 'win32' }, async t => {
  const dataDir = await temp(t, 'pb-data-');
  const root = await repo(t);
  const app = await startServer({ port: 0, dataDir, detector: async () => [], executor: null });
  t.after(() => app.close());
  const { token } = await fetch(app.url + '/api/session').then(r => r.json());
  const call = (method, path, body) => fetch(app.url + path, { method, headers: { 'x-ste-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async r => ({ status: r.status, data: await r.json() }));
  assert.equal((await fetch(app.url + '/api/board')).status, 403);
  assert.equal((await fetch(app.url + '/api/projects', { method: 'POST', headers: { 'x-ste-token': token, 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{"name":"X"}' })).status, 403);
  const created = await call('POST', '/api/projects', { name: 'Web' });
  assert.equal(created.status, 200);
  const project = created.data.project;
  // A project made in the app gets its own folder with a Git repository, inside the projects folder.
  assert.equal(created.data.folder, join(await realpath(app.board.projectsDir), 'Web'));
  assert.equal(created.data.initialized, true);
  assert.ok(project.repository && project.targetBranch, 'Linked with a target branch at once.');
  const invalid = await call('POST', `/api/projects/${project.id}/repository`, { path: join(root, 'missing'), expectedRevision: project.revision });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.code, 'PATH_NOT_FOUND');
  const linked = await call('POST', `/api/projects/${project.id}/repository`, { path: root, expectedRevision: project.revision });
  assert.equal(linked.status, 200);
  assert.deepEqual(linked.data.repository.branches.map(branch => branch.name), ['trunk']);
  const revision = linked.data.project.revision;
  assert.equal((await call('POST', `/api/projects/${project.id}/target-branch`, { branch: 'main', expectedRevision: revision })).data.code, 'BRANCH_NOT_FOUND');
  assert.equal((await call('POST', `/api/projects/${project.id}/target-branch`, { branch: 'trunk', expectedRevision: revision })).status, 200);
  const task = (await call('POST', '/api/tasks', { projectId: project.id, title: 'T', prompt: 'P' })).data.task;
  assert.equal(task.column, 'todo');
  const moved = await call('POST', `/api/tasks/${task.id}/move`, { column: 'executing', expectedRevision: 1 });
  assert.equal(moved.data.task.column, 'executing');
  const stale = await call('POST', `/api/tasks/${task.id}/move`, { column: 'todo', expectedRevision: 1 });
  assert.equal(stale.status, 409);
  const refused = await call('POST', `/api/tasks/${task.id}/runs`, { stage: 'executing', consent: true });
  assert.equal(refused.status, 503);
  assert.equal(refused.data.code, 'EXECUTION_UNAVAILABLE');
  const view = (await call('GET', '/api/board')).data.board;
  assert.equal(view.execution.available, false);
  assert.deepEqual(view.runs, []);
  assert.equal(view.projects[0].tasks[0].workspace, null);
  assert.equal(run(root, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 1);
});

test('starting the server does not create or touch board files', async t => {
  const dataDir = join(await temp(t, 'pb-lazy-'), 'data');
  const app = await startServer({ port: 0, dataDir, detector: async () => [] });
  await app.close();
  assert.equal(await exists(dataDir), false);
  await mkdir(dataDir);
});

test('every project made in the app has a Git repository: new folders, existing folders, no identity, and safe clean-up', { skip: process.platform === 'win32' }, async t => {
  const dataDir = await temp(t, 'pb-data-');
  const projectsDir = join(dataDir, 'My Projects');
  const board = new Board({ dataDir, projectsDir });
  // No Git identity anywhere: the empty first commit still works; Git configuration is not changed.
  // user.useConfigOnly stops Git from guessing a name from the operating-system account.
  const env = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.useConfigOnly', GIT_CONFIG_VALUE_0: 'true' };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const first = await board.createProjectWithRepository({ name: 'Web: App/1', folder: 'new' });
  assert.equal(first.folder, join(await realpath(projectsDir), 'Web- App-1'), 'Unsafe folder characters are replaced.');
  assert.equal(execFileSync('git', ['log', '--format=%s %an'], { cwd: first.folder, encoding: 'utf8' }).trim(), 'Initial commit Promptboard');
  // `git config --get-regexp` exits with status 1 when nothing matches: no identity was written.
  assert.throws(() => execFileSync('git', ['config', '--local', '--get-regexp', '^user\\.'], { cwd: first.folder, stdio: 'pipe' }), { status: 1 });
  assert.ok(first.project.repository && first.project.targetBranch);
  // A folder with that name already exists: the next project gets its own folder.
  await mkdir(join(projectsDir, 'Two'));
  const second = await board.createProjectWithRepository({ name: 'Two', folder: 'new' });
  assert.equal(second.folder, join(await realpath(projectsDir), 'Two 2'));
  // A taken project name fails before any folder is made.
  await assert.rejects(board.createProjectWithRepository({ name: 'two', folder: 'new' }), { code: 'NAME_TAKEN' });
  assert.deepEqual((await readdir(projectsDir)).sort(), ['Two', 'Two 2', 'Web- App-1']);
  // An existing folder: git init and one empty commit; the user's files are not added.
  const existing = join(dataDir, 'existing');
  await mkdir(existing);
  await writeFile(join(existing, 'notes.txt'), 'mine\n');
  const opened = await board.createProjectWithRepository({ name: 'Existing', folder: existing });
  assert.equal(opened.initialized, true);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: existing, encoding: 'utf8' }).trim(), '?? notes.txt');
  await assert.rejects(board.createProjectWithRepository({ name: 'Missing', folder: join(dataDir, 'nope') }), { code: 'PATH_NOT_FOUND' });
  await assert.rejects(board.createProjectWithRepository({ name: 'Relative', folder: 'relative/path' }), { code: 'INVALID_PATH' });
});
