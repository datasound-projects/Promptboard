import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const chrome = await findChrome();
test('Project card in Chrome: open a file from the tree, edit, Cmd+S writes it to disk, and Pop out shows the same tree on its own page', { skip: !chrome, timeout: 120_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pb-explorer-browser-')));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const git = (...args) => execFileSync('git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'Tester');
  await mkdir(join(root, 'src')); await writeFile(join(root, 'src', 'app.js'), 'export const greeting = "hello";\n'); await writeFile(join(root, 'readme.md'), '# Shop\n');
  git('add', '.'); git('commit', '-q', '-m', 'First page');
  let calls = 0;
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [], runner: async () => { calls++; throw new Error('The explorer never runs a model.'); } });
  const { project } = await app.board.createProjectWithRepository({ name: 'Shop', folder: root });
  const browser = await launch({ width: 1440, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  const ev = code => browser.eval(code), wait = (expression, label) => browser.until(expression, label, 15000);
  const click = selector => ev(`document.querySelector(${JSON.stringify(selector)}).click();`);
  const tree = scope => ev(`return [...document.querySelectorAll(${JSON.stringify(`${scope} [role="treeitem"]`)})].map(row => row.dataset.path + (row.querySelector('.explorer-mark')?.textContent || ''));`);

  await browser.goto(`${app.url}/#/kanban`);
  await wait(`document.querySelector('.project-lane .project-card-facts')?.textContent.includes('First page')`, 'Project card with the latest commit');
  assert.match(await ev(`return document.querySelector('.project-lane').textContent;`), /Project: Shop.*Branchmain/);
  await click('.project-card-open');
  await wait(`document.querySelector('.explorer-dialog[open] [data-path="src"]')`, 'explorer tree');
  await click('.explorer-dialog [data-path="src"]');
  await wait(`document.querySelector('.explorer-dialog [data-path="src/app.js"]')`, 'src opened');
  await click('.explorer-dialog [data-path="src/app.js"]');
  await wait(`document.querySelector('.explorer-dialog .file-token-keyword') && document.activeElement === document.querySelector('.explorer-dialog .file-editor')`, 'file open for typing');
  // Native typing at the end of the file, then the save shortcut.
  await ev(`const editor = document.activeElement; editor.selectionStart = editor.selectionEnd = editor.value.length;`);
  await browser.type('// saved');
  await wait(`document.querySelector('.explorer-dialog .explorer-dot')`, 'unsaved dot');
  const modifiers = process.platform === 'darwin' ? 4 : 2; // ⌘ on macOS, Ctrl elsewhere.
  await browser.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers });
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers });
  await wait(`document.querySelector('.explorer-dialog .explorer-status').textContent === 'Saved.' && !document.querySelector('.explorer-dialog .explorer-dot')`, 'saved');
  assert.equal(await readFile(join(root, 'src', 'app.js'), 'utf8'), 'export const greeting = "hello";\n// saved');
  await wait(`document.querySelector('.explorer-dialog [data-path="src/app.js"] .explorer-mark')?.textContent === 'M'`, 'modified marker');
  const inside = await tree('.explorer-dialog');

  // Pop out: its own page with the same tree, which works without the board page.
  await ev(`window.open = (...args) => { window.__opened = args; return null; };`);
  await click('.explorer-dialog [aria-label="Pop out to its own window"]');
  const [url, target, features] = await ev('return window.__opened;');
  assert.deepEqual([url, target], [`/project.html?project=${project.id}`, '_blank']);
  assert.match(features, /noopener/);
  assert.equal(await ev(`return document.querySelector('.explorer-dialog').open;`), false);
  await browser.goto(app.url + url);
  await wait(`document.querySelector('[data-path="src"]') && document.title === 'Shop — Promptboard'`, 'standalone explorer');
  await click('[data-path="src"]');
  await wait(`document.querySelector('[data-path="src/app.js"]')`, 'standalone src opened');
  assert.deepEqual(await tree('.explorer'), inside);
  await click('[data-path="src/app.js"]');
  await wait(`document.querySelector('.file-editor').value.endsWith('// saved')`, 'saved file in the window');
  for (const theme of ['light', 'dark']) {
    await browser.resize(390, 800);
    await ev(`document.documentElement.dataset.theme = ${JSON.stringify(theme)};`);
    assert.equal(await browser.layout('return document.documentElement.scrollWidth <= innerWidth && document.querySelector(".explorer-tree").getBoundingClientRect().width > 300;'), true, theme);
  }
  assert.equal(calls, 0);
  assert.deepEqual(browser.consoleMessages.filter(message => message.includes('EXCEPTION')), []);
});
