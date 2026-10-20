import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, headBranch, ignoredFiles, repositoryIdentity, validateRepository } from '../src/git.mjs';

async function temp(t) { const dir = await realpath(await mkdtemp(join(tmpdir(), 'pb-git-errors-'))); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return dir; }
async function repository(t) {
  const dir = await temp(t), run = (...args) => execFileSync('git', args, { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  run('init', '-q', '-b', 'main'); run('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

test('a failed Git command says which command failed and Git’s own reason; a command that hangs is GIT_TIMEOUT', async t => {
  const dir = await temp(t); // Removed with retries: Windows frees a killed process's folder late.
  await assert.rejects(git(['rev-parse', '--verify', 'HEAD'], { cwd: dir }), error => error.code === 'GIT_FAILED' && /^git rev-parse failed: fatal: not a git repository/.test(error.message));
  // hash-object --stdin waits for input that never comes.
  await assert.rejects(git(['hash-object', '--stdin'], { cwd: dir, timeoutMs: 300 }), error => error.code === 'GIT_TIMEOUT' && /^git hash-object failed: it did not finish within 300 ms/.test(error.message));
});

test('a folder that no longer exists is PATH_NOT_FOUND with its path, not a missing Git', async t => {
  const gone = join(await temp(t), 'deleted worktree');
  await assert.rejects(git(['status'], { cwd: gone }), error => error.code === 'PATH_NOT_FOUND' && error.message === `git status failed: the folder ${gone} does not exist`);
  await assert.rejects(repositoryIdentity(gone), { code: 'PATH_NOT_FOUND' });
});

test('branch names are exact even when a tag has the same name', async t => {
  const dir = await repository(t);
  await git(['tag', 'main'], { cwd: dir });
  const repo = await validateRepository(dir);
  assert.equal(repo.currentBranch, 'main');
  assert.deepEqual(repo.branches.map(branch => branch.name), ['main']);
  assert.equal(await headBranch(dir), 'main');
});

test('ignored files are listed with their real names, also non-ASCII ones', async t => {
  const dir = await repository(t);
  await writeFile(join(dir, '.gitignore'), '*.log\nbuild/\n');
  await writeFile(join(dir, 'café notes.log'), 'x'); await mkdir(join(dir, 'build')); await writeFile(join(dir, 'build', 'out.js'), 'x');
  assert.deepEqual((await ignoredFiles(dir)).sort(), ['build/', 'café notes.log']);
});
