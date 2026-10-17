// Five projects at once, SIMULATED agents (tests/fixtures/fake-agent.cjs stands in for the CLIs): each card runs in
// its own project's worktree, at the same time, and nothing crosses into another project's repository or board.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Board } from '../src/board.mjs';
import { Supervisor } from '../src/supervisor.mjs';

const skip = process.platform === 'win32';
const fake = fileURLToPath(new URL('./fixtures/fake-agent.cjs', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
async function temp(t, prefix) { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return dir; }
async function until(fn, label, ms = 30000) { for (const end = Date.now() + ms; ;) { const value = await fn(); if (value) return value; if (Date.now() > end) assert.fail(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 50)); } }

test('five projects share the agent slots: four run at once, the fifth starts when one frees; each agent stays in its own project', { skip, timeout: 120000 }, async t => {
  const bin = await temp(t, 'pb-iso-bin-'), report = join(bin, 'report.jsonl');
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\nrequire(${JSON.stringify(fake)});\n`); await chmod(join(bin, 'claude'), 0o755);
  const oldPath = process.env.PATH, oldReport = process.env.FAKE_AGENT_REPORT;
  process.env.PATH = `${bin}:${oldPath}`; process.env.FAKE_AGENT_REPORT = report;
  const dataDir = await temp(t, 'pb-iso-data-');
  const board = new Board({ dataDir }), supervisor = new Supervisor({ board, dataDir });
  board.executor = supervisor;
  t.after(async () => { await supervisor.shutdown(500); process.env.PATH = oldPath; if (oldReport === undefined) delete process.env.FAKE_AGENT_REPORT; else process.env.FAKE_AGENT_REPORT = oldReport; });
  await board.setSettings({ maxConcurrentRuns: 4 }); // The app's maximum.
  const projects = [];
  for (let n = 1; n <= 5; n++) {
    const root = await temp(t, `pb-iso-repo${n}-`);
    git(root, 'init', '-q', '-b', 'trunk'); git(root, 'config', 'user.email', 't@e'); git(root, 'config', 'user.name', 'T');
    await writeFile(join(root, 'README.md'), `project ${n}\n`); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'init');
    const project = await board.createProject({ name: `Project ${n}` });
    await board.linkRepository(project.id, { path: root, expectedRevision: 1 });
    await board.setTargetBranch(project.id, { branch: 'trunk', expectedRevision: 2 });
    const card = await board.createTask({ projectId: project.id, title: `Task ${n}`, prompt: `Write the file for project ${n}. WRITE_FILE:p${n}.txt` });
    await board.moveTask(card.id, { column: 'executing', expectedRevision: 1 });
    projects.push({ n, root, project, card });
  }
  // All five are asked for together: four agents run at once, the fifth waits for a slot.
  const runs = await Promise.all(projects.map(entry => board.requestRun(entry.card.id, { stage: 'executing', consent: true })));
  let peak = 0;
  const probe = setInterval(() => { peak = Math.max(peak, supervisor.activeCount()); }, 10);
  t.after(() => clearInterval(probe));
  const done = async () => { const state = await board.state(); return runs.filter(run => state.runs.find(row => row.id === run.id)?.turnComplete); };
  await until(async () => (await done()).length === 4, 'four finished turns');
  assert.equal(supervisor.queue.length, 1, 'the fifth waits in the queue');
  // Ending one session frees its slot and the waiting card starts.
  await supervisor.cancel((await done())[0].id);
  await until(async () => (await done()).length === 5 || (await board.state()).runs.filter(row => runs.some(run => run.id === row.id) && row.turnComplete).length === 5, 'the fifth finished its turn');
  clearInterval(probe);
  assert.equal(peak, 4, 'never more agents than the limit');
  const state = await board.state();
  const started = (await readFile(report, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(started.length, 5, 'one agent per card, no duplicates');
  for (const { n, root, project, card } of projects) {
    const workspace = state.projects.find(row => row.id === project.id).tasks.find(row => row.id === card.id).workspace;
    assert.equal(workspace.repositoryRoot, root, `project ${n} works in its own repository`);
    assert.ok(started.some(entry => entry.cwd === workspace.path), `project ${n}'s agent ran in its own worktree`);
    assert.equal(await readFile(join(workspace.path, `p${n}.txt`), 'utf8'), 'written by the agent\n');
    // Its repository knows only its own worktree, and its main checkout is untouched.
    const worktrees = git(root, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
    assert.deepEqual(worktrees.sort(), [root, workspace.path].sort());
    assert.equal(git(root, 'status', '--porcelain'), '');
    for (const other of projects.filter(entry => entry.n !== n)) assert.equal(git(workspace.path, 'ls-files', '--others', '--exclude-standard').includes(`p${other.n}.txt`), false);
    // Its board holds only its own card.
    assert.deepEqual(state.projects.find(row => row.id === project.id).tasks.map(row => row.title), [`Task ${n}`]);
  }
  for (const run of runs) await supervisor.cancel(run.id).catch(() => {});
});
