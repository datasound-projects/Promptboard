// A finished project says where it is and how to start it; the project menu copies its path and opens its folder.
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

test('when every card is done, Kanban shows how to run the project; the menu copies the path and opens the folder', { skip, timeout: 120000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pb-run-ui-'))); t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'trunk'); git(root, 'config', 'user.email', 't@e'); git(root, 'config', 'user.name', 'T');
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' }, dependencies: { vite: '7' } }));
  await writeFile(join(root, 'README.md'), '# Shop\n\n## Getting started\n\nOpen http://localhost:5173 after starting it.\n');
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'init');
  const opened = [];
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [], projectOpener: async (project, target) => { opened.push(target); return { opened: target }; } });
  const project = await app.board.createProject({ name: 'Shop' });
  await app.board.linkRepository(project.id, { path: root, expectedRevision: 1 });
  await app.board.setTargetBranch(project.id, { branch: 'trunk', expectedRevision: 2 });
  for (const title of ['Catalog', 'Checkout']) await app.board.createTask({ projectId: project.id, title, prompt: `Build the ${title}.` });
  const platform = (await (await fetch(`${app.url}/api/session`)).json()).platform;
  const opener = platform === 'darwin' ? 'Finder' : platform === 'win32' ? 'Explorer' : 'file manager';
  const browser = await launch({ width: 1280, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  const ev = code => browser.eval(code), wait = (expression, label, ms = 20000) => browser.until(expression, label, ms);
  await browser.goto(`${app.url}/#/kanban`);
  await wait(`!!document.querySelector('#kanban-columns [data-column="todo"] .kanban-card')`, 'board');
  assert.equal(await ev(`return document.querySelector('#project-run').hidden`), true, 'not while cards are open');
  // Both cards done (as merges leave them): the panel appears with the folder and the commands from the project's files.
  await app.board.store.update(state => { for (const task of state.projects[0].tasks) { task.column = 'done'; task.completion = { kind: 'merged', at: Date.now() }; task.revision++; } });
  await ev(`window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange'));`);
  await ev(`location.hash = '#/'; setTimeout(() => { location.hash = '#/kanban'; }, 50);`);
  await wait(`!document.querySelector('#project-run').hidden && /npm run dev/.test(document.querySelector('#project-run').textContent)`, 'run panel');
  const text = await ev(`return document.querySelector('#project-run').textContent`);
  assert.match(text, /All 2 cards done: run Shop/);
  assert.match(text, new RegExp(`The finished code is on trunk, in ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(text, /npm install/); assert.match(text, /Getting started/);
  assert.equal(await ev(`return [...document.querySelectorAll('#project-run code')][0].textContent`), `cd "${root}"`);
  await ev(`[...document.querySelectorAll('#project-run button')].find(b => b.textContent === 'Open in ${opener}').click();`);
  await wait(`/opened in|Terminal opened/.test(document.querySelector('#announcement').textContent)`, 'opened');
  assert.deepEqual(opened, ['folder']);
  // Closed: it stays closed after a reload, until more cards are done.
  await ev(`[...document.querySelectorAll('#project-run button')].find(b => b.textContent === 'Close').click();`);
  await wait(`document.querySelector('#project-run').hidden`, 'closed');
  await browser.reload();
  await wait(`!!document.querySelector('#kanban-columns [data-column="done"]')`, 'board after reload');
  assert.equal(await ev(`return document.querySelector('#project-run').hidden`), true);
  // The project menu: copy the path, open the folder, and show how to run it any time.
  await ev(`document.querySelector('.workspace-menu-toggle').click();`);
  await wait(`!!document.querySelector('.workspace-menu [role="menuitem"]')`, 'menu');
  assert.deepEqual(await ev(`return [...document.querySelectorAll('.workspace-menu [role="menuitem"]')].map(b => b.textContent)`), ['Rename', 'Copy path', `Open in ${opener}`, 'How to run…', 'Delete…']);
  await ev(`[...document.querySelectorAll('.workspace-menu [role="menuitem"]')].find(b => b.textContent === 'How to run…').click();`);
  await wait(`!document.querySelector('#project-run').hidden && /run Shop|How to run Shop/.test(document.querySelector('#project-run h3').textContent)`, 'shown on request');
  assert.deepEqual(browser.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);
});
