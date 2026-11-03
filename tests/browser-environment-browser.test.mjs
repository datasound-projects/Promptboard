import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';

const chrome = await findChrome();
test('Chrome launch keeps host utilities while the app PATH contains only test CLIs', { skip: !chrome || process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pb-chrome-env-'));
  const originalPath = process.env.PATH, originalChrome = process.env.CHROME_PATH;
  t.after(async () => {
    process.env.PATH = originalPath;
    if (originalChrome === undefined) delete process.env.CHROME_PATH; else process.env.CHROME_PATH = originalChrome;
    await rm(directory, { recursive: true, force: true });
  });
  const wrapper = join(directory, 'chrome');
  const quotedChrome = `'${chrome.replaceAll("'", "'\\''")}'`;
  // Linux's installed google-chrome is a shell wrapper that needs these host programs.
  await writeFile(wrapper, `#!/bin/sh\nfor utility in readlink dirname mkdir cat; do\n  command -v "$utility" >/dev/null || exit 91\ndone\nexec ${quotedChrome} "$@"\n`);
  await chmod(wrapper, 0o700);
  process.env.CHROME_PATH = wrapper;
  process.env.PATH = directory;
  const browser = await launch();
  assert.ok(browser);
  t.after(() => browser.close());
  assert.equal(await browser.eval('return location.href;'), 'about:blank');
  assert.equal(process.env.PATH, directory, 'the application still cannot find real provider CLIs');
});
