// A finished project says where it is and how to start it; the project menu copies its path and opens its folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const skip = !(await findChrome());
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();

test('when every card is done, Kanban shows how to run the project; the menu copies the path and opens the folder', { skip, timeout: 120000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pb-run-ui-')));
  git(root, 'init', '-q', '-b', 'trunk'); git(root, 'config', 'user.email', 't@e'); git(root, 'config', 'user.name', 'T');
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' }, dependencies: { vite: '7' } }));
  await writeFile(join(root, 'README.md'), '# Shop\n\n## Getting started\n\nOpen http://localhost:5173 after starting it.\n');
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'init');
  const opened = [], editorCalls = [];
  await mkdir(join(root, '.apps', 'Zed.app'), { recursive: true });
  // Editors found in a folder of the test's own and started through a recorder: no editor opens on this computer.
  const editorOptions = { platform: 'darwin', env: {}, home: root, appDirs: [join(root, '.apps')], exec: async (command, args) => { editorCalls.push(args.at(-1)); return { ok: true, stdout: '' }; } };
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [], editorOptions, projectOpener: async (project, target) => { opened.push(target); return { opened: target }; } });
  // Removed after the app has closed: on Windows a folder the app still watches cannot be deleted.
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
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
  assert.deepEqual(await ev(`return [...document.querySelectorAll('.workspace-menu [role="menuitem"]')].map(b => b.textContent)`), ['Rename', 'Copy path', `Open in ${opener}`, 'Open in IDE…', 'How to run…', 'Delete…']);
  // Open in IDE: the editors found on the computer; the one chosen is offered directly next time.
  await ev(`[...document.querySelectorAll('.workspace-menu [role="menuitem"]')].find(b => b.textContent === 'Open in IDE…').click();`);
  await wait(`[...document.querySelectorAll('.workspace-menu .workspace-editor')].map(b => b.textContent).join() === 'ZZed'`, 'editor list');
  await ev(`document.querySelector('.workspace-menu .workspace-editor').click();`);
  await wait(`/Zed opened Shop/.test(document.querySelector('#announcement').textContent)`, 'opened in Zed');
  assert.deepEqual(editorCalls, [root]);
  await ev(`document.querySelector('.workspace-menu-toggle').click();`);
  await wait(`[...document.querySelectorAll('.workspace-menu [role="menuitem"]')].some(b => b.textContent === 'Open in Zed')`, 'the last editor is offered directly');
  assert.ok((await ev(`return [...document.querySelectorAll('.workspace-menu [role="menuitem"]')].map(b => b.textContent)`)).includes('Open in another IDE…'));
  // A task's worktree opens in the same editor from its card.
  await ev(`document.querySelector('.workspace-menu-toggle').click();`);
  const tree = join(root, '.trees', 'catalog');
  await writeFile(join(root, '.git', 'info', 'exclude'), '.trees/\n'); git(root, 'worktree', 'add', '-q', '-b', 'pb/catalog', tree);
  const taskId = (await app.board.view()).projects[0].tasks[0].id;
  await app.board.store.update(state => { const task = state.projects[0].tasks.find(item => item.id === taskId); task.workspace = { status: 'ready', branch: 'pb/catalog', path: tree, repositoryRoot: root, targetBranch: 'trunk' }; task.revision++; });
  await browser.reload();
  await wait(`!!document.querySelector('[data-id="${taskId}"] .kanban-more-toggle')`, 'card');
  await ev(`document.querySelector('[data-id="${taskId}"] .kanban-more-toggle').click();`);
  await wait(`!!document.querySelector('[data-id="${taskId}"] .kanban-details')`, 'card menu');
  await ev(`document.querySelector('[data-id="${taskId}"] .kanban-details').click();`);
  await wait(`document.querySelector('#task-dialog .task-open-editor')?.textContent === 'Open worktree in Zed'`, 'worktree button in the task');
  await ev(`document.querySelector('#task-dialog .task-open-editor').click();`);
  await wait(`/Zed opened the task’s worktree/.test(document.querySelector('#announcement').textContent)`, 'worktree opened');
  assert.deepEqual(editorCalls, [root, tree]);
  // An editor that opened says so, also when its choice cannot be saved (here a folder takes the preferences backup's name).
  await mkdir(join(root, '.apps', 'Cursor.app')); await mkdir(join(app.board.dataDir, 'editors.json.bak', 'taken'), { recursive: true });
  await ev(`document.querySelector('#task-dialog').close();`); await browser.reload();
  await wait(`!!document.querySelector('.workspace-menu-toggle')`, 'board after adding an editor');
  await ev(`document.querySelector('.workspace-menu-toggle').click();`);
  await wait(`[...document.querySelectorAll('.workspace-menu [role="menuitem"]')].some(b => b.textContent === 'Open in another IDE…')`, 'menu with the last editor');
  await ev(`[...document.querySelectorAll('.workspace-menu [role="menuitem"]')].find(b => b.textContent === 'Open in another IDE…').click();`);
  await wait(`[...document.querySelectorAll('.workspace-menu .workspace-editor')].some(b => b.textContent === 'CCursor')`, 'Cursor listed');
  await ev(`[...document.querySelectorAll('.workspace-menu .workspace-editor')].find(b => b.textContent === 'CCursor').click();`);
  await wait(`/Cursor opened Shop\\. Promptboard could not save this choice/.test(document.querySelector('#announcement').textContent)`, 'opened, choice not saved');
  assert.deepEqual(editorCalls, [root, tree, root]);
  await ev(`document.querySelector('.workspace-menu-toggle').click();`);
  await wait(`[...document.querySelectorAll('.workspace-menu [role="menuitem"]')].some(b => b.textContent === 'How to run…')`, 'menu again');
  await ev(`[...document.querySelectorAll('.workspace-menu [role="menuitem"]')].find(b => b.textContent === 'How to run…').click();`);
  await wait(`!document.querySelector('#project-run').hidden && /run Shop|How to run Shop/.test(document.querySelector('#project-run h3').textContent)`, 'shown on request');
  assert.deepEqual(browser.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);
});
