// A SIMULATED GitHub CLI for tests: a fake gh on PATH and a disposable bare repository as the remote.
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
async function temp(t, prefix) { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return dir; }

/** A fake gh. Its mode file selects: ok | none (not signed in) | expired | offline. */
export async function fakeGh(t) {
  const base = await temp(t, 'pb-gh-');
  const bare = join(base, 'app.git');
  const seed = join(base, 'seed');
  git(base, 'init', '-q', '-b', 'main', seed);
  git(seed, 'config', 'user.email', 't@example.com'); git(seed, 'config', 'user.name', 'Tester');
  await writeFile(join(seed, 'a.txt'), 'one\n'); git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'init');
  git(base, 'clone', '-q', '--bare', seed, bare);
  const bin = join(base, 'bin');
  execFileSync('mkdir', [bin]);
  const mode = join(base, 'mode');
  await writeFile(mode, 'ok');
  await writeFile(join(bin, 'gh'), `#!${process.execPath}
const fs = require('fs'); const { execFileSync } = require('child_process');
const a = process.argv.slice(2); const mode = fs.readFileSync(${JSON.stringify(mode)}, 'utf8').trim();
fs.appendFileSync(${JSON.stringify(join(base, 'log'))}, JSON.stringify(a) + '\\n');
const out = s => { process.stdout.write(s + '\\n'); process.exit(0); };
const err = (s, code = 1) => { process.stderr.write(s + '\\n'); process.exit(code); };
if (a[0] === '--version') out('gh version 2.96.0');
if (a[0] === 'auth' && a[1] === 'status') mode === 'none' ? err('You are not logged into any GitHub hosts. To log in, run: gh auth login') : out('github.com ok');
if (mode === 'none') err('To get started with GitHub CLI, please run:  gh auth login');
if (mode === 'expired') err('HTTP 401: Bad credentials (https://api.github.com/user)');
if (mode === 'offline') err('error connecting to api.github.com: dial tcp: lookup api.github.com: no such host');
if (a[0] === 'api' && a[1] === 'user') out(JSON.stringify({ login: 'octo', id: 1 }));
if (a[0] === 'api' && a[1] === '--paginate') out([{ full_name: 'acme/app', private: true, default_branch: 'main', html_url: 'https://github.com/acme/app', description: 'App' },
  { full_name: 'acme/docs', private: false, default_branch: 'trunk', html_url: 'https://github.com/acme/docs', description: '' }, { full_name: 'bad name/x' }].map(r => JSON.stringify(r)).join('\\n'));
if (a[0] === 'repo' && a[1] === 'view') {
  if (a[2] !== 'acme/app') err('GraphQL: Could not resolve to a Repository with the name ' + a[2] + '.');
  out(JSON.stringify({ nameWithOwner: 'acme/app', isPrivate: true, defaultBranchRef: { name: 'main' }, url: 'https://github.com/acme/app', description: 'App' }));
}
if (a[0] === 'repo' && a[1] === 'clone') {
  execFileSync('git', ['clone', '-q', ${JSON.stringify(bare)}, a[3]]);
  execFileSync('git', ['-C', a[3], 'remote', 'set-url', 'origin', 'https://github.com/acme/app.git']);
  // The "GitHub" URL resolves to the local bare repository for this clone.
  execFileSync('git', ['-C', a[3], 'config', 'url.' + ${JSON.stringify(bare)} + '.insteadOf', 'https://github.com/acme/app.git']);
  process.exit(0);
}
err('unexpected ' + a.join(' '), 2);
`);
  await chmod(join(bin, 'gh'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  return { base, bare, seed, setMode: value => writeFile(mode, value), log: async () => (await readFile(join(base, 'log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) };
}

