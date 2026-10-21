// Live preview in a real browser: a card's Details start its fixture dev server, link to it, and the board card links to
// it while it runs. The fixture's package.json names its server as `main`, so the suggestion is `node server.js` (no npm).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const skip = !(await findChrome());
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();

test('Start preview in a card’s Details shows Open preview, the board card links to it, and Stop ends it', { skip, timeout: 120000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pb-preview-ui-')));
  git(root, 'init', '-q', '-b', 'trunk'); git(root, 'config', 'user.email', 't@e'); git(root, 'config', 'user.name', 'T');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'shop', main: 'server.js' }));
  await writeFile(join(root, 'server.js'), `require('node:http').createServer((req, res) => res.end('shop preview')).listen(Number(process.env.PORT), process.env.HOST, () => console.log('Listening on http://127.0.0.1:' + process.env.PORT));\n`);
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'init');
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  // Removed after the app has closed (and its preview with it): on Windows a folder in use cannot be deleted.
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  let project = await app.board.createProject({ name: 'Shop' });
  await app.board.linkRepository(project.id, { path: root, expectedRevision: 1 });
  project = await app.board.setTargetBranch(project.id, { branch: 'trunk', expectedRevision: 2 });
  const card = await app.board.createTask({ projectId: project.id, title: 'Checkout page', prompt: 'Build the checkout page.' });
  await app.board.moveTask(card.id, { column: 'executing', expectedRevision: 1 });
  await app.board.ensureTaskWorktree(card.id);
  const browser = await launch({ width: 1280, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  const ev = code => browser.eval(code), wait = (expression, label, ms = 30000) => browser.until(expression, label, ms);
  const press = text => ev(`[...document.querySelectorAll('#task-dialog .task-preview button')].find(b => b.textContent === ${JSON.stringify(text)}).click();`);
  const openDetails = async () => {
    await ev(`document.querySelector('[data-id="${card.id}"] .kanban-more-toggle').click();`);
    await wait(`!!document.querySelector('[data-id="${card.id}"] .kanban-details')`, 'card menu');
    await ev(`document.querySelector('[data-id="${card.id}"] .kanban-details').click();`);
    await wait(`!!document.querySelector('#task-dialog[open] .task-preview')`, 'the Preview section');
  };
  await browser.goto(`${app.url}/#/kanban`);
  await wait(`!!document.querySelector('[data-id="${card.id}"] .kanban-more-toggle')`, 'board');
  assert.equal(await ev(`return document.querySelector('[data-id="${card.id}"] .preview-card')`), null, 'No preview button before a preview runs.');
  await openDetails();
  await wait(`document.querySelector('#task-dialog .task-preview [role="status"]').textContent === 'Set a preview command.'`, 'no command yet');
  await press('Use node server.js');
  await wait(`[...document.querySelectorAll('#task-dialog .task-preview button')].some(b => b.textContent === 'Start preview')`, 'Start preview');
  await press('Start preview');
  const href = await wait(`document.querySelector('#task-dialog .preview-open')?.href`, 'Open preview');
  assert.match(href, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.deepEqual(await ev(`const a = document.querySelector('#task-dialog .preview-open'); return [a.textContent, a.target, a.rel];`), ['Open preview', '_blank', 'noopener noreferrer']);
  assert.equal(await (await fetch(href)).text(), 'shop preview', 'The link answers.');
  assert.equal(await ev(`return document.querySelector('#task-dialog .task-preview [role="status"]').textContent`), `Running at ${href}`);
  // The board card links to the running preview, so it is easy to find again.
  await ev(`document.querySelector('#task-dialog').close();`);
  assert.equal(await wait(`document.querySelector('[data-id="${card.id}"] a.preview-card')?.href`, 'the card’s preview link'), href);
  await openDetails();
  await wait(`!!document.querySelector('#task-dialog .preview-open')`, 'Open preview again');
  await press('Stop');
  await wait(`[...document.querySelectorAll('#task-dialog .task-preview button')].some(b => b.textContent === 'Start preview')`, 'stopped');
  await wait(`!document.querySelector('[data-id="${card.id}"] .preview-card')`, 'the card’s preview button goes');
  await assert.rejects(fetch(href), 'The server is gone.');
  assert.deepEqual(browser.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);
});
