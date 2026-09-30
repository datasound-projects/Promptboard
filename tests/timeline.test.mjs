// Project timeline from recorded board facts and real Git commits in a disposable repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from '../src/board.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
async function temp(t, prefix) { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return dir; }

test('the timeline shows only recorded events of one project, in time order, with runs, evidence, merges, commits, and notes', { skip: process.platform === 'win32' }, async t => {
  const root = await temp(t, 'pb-tl-repo-');
  git(root, 'init', '-q', '-b', 'trunk'); git(root, 'config', 'user.email', 't@e'); git(root, 'config', 'user.name', 'T');
  await writeFile(join(root, 'a.txt'), '1\n'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'init');
  const before = git(root, 'rev-parse', 'HEAD');
  await writeFile(join(root, 'a.txt'), '2\n'); git(root, 'commit', '-q', '-am', 'Add the parser');
  await writeFile(join(root, 'a.txt'), '3\n'); git(root, 'commit', '-q', '-am', 'Test the parser');
  const after = git(root, 'rev-parse', 'HEAD');
  const board = new Board({ dataDir: await temp(t, 'pb-tl-data-') });
  const project = await board.createProject({ name: 'Main' });
  const other = await board.createProject({ name: 'Other' });
  await board.linkRepository(project.id, { path: root, expectedRevision: 1 });
  const task = await board.createTask({ projectId: project.id, title: 'Parser', prompt: 'Build it.' });
  await board.createTask({ projectId: other.id, title: 'Elsewhere', prompt: 'Not here.' });
  await board.moveTask(task.id, { column: 'executing', expectedRevision: 1 });
  const now = Date.now();
  await board.store.update(state => {
    state.runs.push({ id: 'run-1', taskId: task.id, projectId: project.id, stage: 'executing', status: 'succeeded', createdAt: now, updatedAt: now + 5000, startedAt: now, endedAt: now + 65000,
      config: { provider: 'claude', model: 'opus', effort: 'high' }, trigger: 'user', usage: { model: 'claude-opus-5-5' } });
  });
  await board.updateTaskEvidence(task.id, current => { current.evidence = { tests: { id: 't1', status: 'passed', results: [{ status: 'passed' }, { status: 'passed' }], taskCommit: after, endedAt: now + 70000 } }; });
  await board.completeTask(task.id, { kind: 'merged', details: { targetBranch: 'trunk', previousTarget: before, mergedCommit: after, method: 'fast-forward', commits: 2, trigger: 'user' } });
  const note = await board.addTimelineNote(project.id, { title: 'Release 1.0', text: 'Shipped to users.', at: now + 100000, taskId: task.id });
  await assert.rejects(board.addTimelineNote(project.id, { title: '', at: now }), { code: 'INVALID_INPUT' });
  await assert.rejects(board.addTimelineNote(project.id, { title: 'x', taskId: 'not-a-task' }), { code: 'INVALID_INPUT' });

  const events = await board.timeline(project.id);
  assert.ok(events.every((event, i) => i === 0 || events[i - 1].at <= event.at), 'Events are in time order.');
  assert.ok(events.every(event => event.taskTitle !== 'Elsewhere'), 'Only this project.');
  const kinds = events.map(event => event.kind);
  for (const kind of ['created', 'moved', 'run', 'tests', 'completed', 'commit', 'note']) assert.ok(kinds.includes(kind), kind);
  const run = events.find(event => event.kind === 'run');
  assert.deepEqual([run.stage, run.status, run.endAt - run.at, run.agent], ['executing', 'succeeded', 65000, { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }]);
  const done = events.find(event => event.kind === 'completed');
  assert.deepEqual([done.title, done.commit, done.detail], ['Merged into trunk', after, '2 commits, fast-forward']);
  assert.deepEqual(events.filter(event => event.kind === 'commit').map(event => event.title), ['Add the parser', 'Test the parser'], 'The merged commits come from Git.');
  assert.equal(events.find(event => event.kind === 'tests').detail, '2 of 2 commands passed');
  assert.equal(events.filter(event => event.editable).length, 1, 'Only notes are editable.');
  // Notes: edit, then remove.
  // Notes travel with a backup; system events are rebuilt, never imported.
  const backup = await board.exportBackup();
  assert.equal(backup.projects[0].timelineNotes[0].title, 'Release 1.0');
  const restored = new Board({ dataDir: await temp(t, 'pb-tl-restore-') });
  await restored.importBackup(backup, { replace: true });
  const restoredNote = (await restored.timeline(project.id)).find(event => event.kind === 'note');
  assert.deepEqual([restoredNote.title, restoredNote.taskId], ['Release 1.0', task.id]);
  await board.updateTimelineNote(project.id, note.id, { title: 'Release 1.1' });
  assert.equal((await board.timeline(project.id)).find(event => event.kind === 'note').title, 'Release 1.1');
  await board.deleteTimelineNote(project.id, note.id);
  assert.ok(!(await board.timeline(project.id)).some(event => event.kind === 'note'));
  await assert.rejects(board.deleteTimelineNote(project.id, note.id), { code: 'NOT_FOUND' });
  // A project without history has no invented events.
  assert.deepEqual(await board.timeline(other.id).then(list => list.map(event => event.kind)), ['created']);
});
