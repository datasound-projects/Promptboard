import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { git as runGit, repositoryIdentity, validateRepository } from '../src/git.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' } });
async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pb-repository-identity-')));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const root = join(dir, 'checkout'); await mkdir(root);
  git(root, 'init', '-q', '-b', 'trunk'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.test');
  git(root, '-c', 'core.hooksPath=' + dir, 'commit', '-q', '--allow-empty', '-m', 'Fixture');
  return { dir, root: await realpath(root) };
}

test('narrow repository identity retains exact canonical root/common directory for ordinary and linked worktrees', async t => {
  const { root, dir } = await fixture(t), original = await validateRepository(root);
  assert.deepEqual(await repositoryIdentity(root), { root: original.root, commonDir: original.commonDir });
  const nested = join(root, 'nested'); await mkdir(nested); assert.deepEqual(await repositoryIdentity(nested), { root: original.root, commonDir: original.commonDir });
  const linked = join(dir, 'linked'); git(root, '-c', 'core.hooksPath=' + dir, 'worktree', 'add', '-q', '--detach', linked, 'HEAD');
  const worktree = await validateRepository(linked); assert.equal(worktree.linkedWorktree, true);
  assert.deepEqual(await repositoryIdentity(linked), { root: worktree.root, commonDir: original.commonDir });
});

test('repository identity rejects invalid/non-worktree paths and ignores inherited repository redirection', async t => {
  const { root, dir } = await fixture(t);
  for (const input of [null, '', 'relative', root + '\0']) await assert.rejects(repositoryIdentity(input), { code: 'INVALID_PATH' });
  const empty = join(dir, 'empty'); await mkdir(empty); await assert.rejects(repositoryIdentity(empty), { code: 'GIT_FAILED' });
  const bare = join(dir, 'bare'); git(dir, 'init', '-q', '--bare', bare); await assert.rejects(repositoryIdentity(bare), { code: 'GIT_FAILED' });
  const before = new Map(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'].map(key => [key, process.env[key]]));
  try {
    process.env.GIT_DIR = bare; process.env.GIT_WORK_TREE = empty; process.env.GIT_COMMON_DIR = bare;
    const identity = await repositoryIdentity(root); assert.equal(identity.root, root); assert.equal(identity.commonDir, await realpath(join(root, '.git')));
  } finally { for (const [key, value] of before) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

test('a git program in the repository folder never shadows Git on PATH', { skip: process.platform === 'win32' }, async t => {
  const { root } = await fixture(t), marker = join(root, 'shadow-ran');
  await writeFile(join(root, 'git'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\necho shadow\n`); await chmod(join(root, 'git'), 0o755);
  const path = process.env.PATH; process.env.PATH = `.${delimiter}${path}`;
  try { assert.match(await runGit(['--version'], { cwd: root }), /^git version/); }
  finally { process.env.PATH = path; }
  assert.equal(await access(marker).then(() => true, () => false), false, 'Relative PATH entries are ignored.');
});
