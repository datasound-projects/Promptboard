import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

test('the full runner keeps exclusive browser resources serial, executes both phases and propagates failures', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pb-test-runner-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await mkdir(join(directory, 'scripts')); await mkdir(join(directory, 'tests', 'helpers'), { recursive: true });
  await copyFile(new URL('../scripts/test.mjs', import.meta.url), join(directory, 'scripts', 'test.mjs'));
  await writeFile(join(directory, 'tests', 'helpers', 'browser.mjs'), `
    import { open, rm, appendFile } from 'node:fs/promises';
    export async function exclusive() {
      const lock = new URL('../../exclusive.lock', import.meta.url), handle = await open(lock, 'wx');
      try { await new Promise(resolve => setTimeout(resolve, 100)); await appendFile(new URL('../../completed.txt', import.meta.url), 'browser\\n'); }
      finally { await handle.close(); await rm(lock); }
    }
  `);
  for (const name of ['a', 'b']) await writeFile(join(directory, 'tests', `${name}.test.mjs`), `
    import test from 'node:test'; import { exclusive } from './helpers/browser.mjs';
    test('exclusive fixture', exclusive);
  `);
  const plain = join(directory, 'tests', 'c.test.mjs');
  const run = () => new Promise((resolve, reject) => {
    // This owns a separate runner process, not a nested node:test invocation.
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [join(directory, 'scripts', 'test.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    child.once('error', reject); child.once('close', code => resolve({ code, output }));
  });
  await writeFile(plain, `import test from 'node:test'; test('plain fixture', () => {});`);
  const good = await run(); assert.equal(good.code, 0, good.output); assert.match(good.output, /plain fixture/);
  assert.equal(await readFile(join(directory, 'completed.txt'), 'utf8'), 'browser\nbrowser\n');
  await rm(join(directory, 'completed.txt'));
  await writeFile(plain, `import test from 'node:test'; test('plain failure', () => { throw new Error('Expected fixture failure'); });`);
  const bad = await run(); assert.equal(bad.code, 1); assert.match(bad.output, /Expected fixture failure/);
  assert.equal(await readFile(join(directory, 'completed.txt'), 'utf8'), 'browser\nbrowser\n', 'A failed non-browser phase cannot omit browser coverage.');
});
