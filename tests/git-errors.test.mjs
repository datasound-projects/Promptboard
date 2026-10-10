import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/git.mjs';

test('a failed Git command says which command failed and Git’s own reason; a command that hangs is GIT_TIMEOUT', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pb-git-errors-'))); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); // Windows frees a killed process's folder late.
  await assert.rejects(git(['rev-parse', '--verify', 'HEAD'], { cwd: dir }), error => error.code === 'GIT_FAILED' && /^git rev-parse failed: fatal: not a git repository/.test(error.message));
  // hash-object --stdin waits for input that never comes.
  await assert.rejects(git(['hash-object', '--stdin'], { cwd: dir, timeoutMs: 300 }), error => error.code === 'GIT_TIMEOUT' && /^git hash-object failed: it did not finish within 300 ms/.test(error.message));
});
