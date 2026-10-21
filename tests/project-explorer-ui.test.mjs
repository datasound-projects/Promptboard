import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { setup as page, until } from './helpers/ui-harness.mjs';

const sources = await Promise.all(['dom.js', 'workspace-files.js', 'project-explorer.js'].map(name => readFile(new URL(`../public/${name}`, import.meta.url), 'utf8')));
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

test('the Project lane follows Done only for a linked project; it is not a card, not draggable, not counted and opens the explorer', async t => {
  const ctx = await page(t, { hash: '#/kanban' }), { $, win, app } = ctx;
  for (const source of sources.slice(1)) win.eval(source); // The harness loads dom.js and app.js; the page loads these two as well.
  win.CSS ??= { escape: value => value }; // jsdom has no CSS.escape; the sidebar's project button uses it once files exist.
  const { project } = await app.board.createProjectWithRepository({ name: 'Shop', folder: 'new' });
  await writeFile(join(project.repository.root, 'index.html'), '<h1>Shop</h1>\n');
  const card = await app.board.createTask({ projectId: project.id, title: 'Checkout', prompt: 'Build the checkout.' });
  await win.__pbTest.loadBoard(); ctx.pick(project.id); await ctx.idle();
  const columns = $('#kanban-columns'), lane = columns.lastElementChild;
  assert.equal(lane.className, 'project-lane');
  assert.equal(lane.previousElementSibling.dataset.column, 'done', 'The lane comes right after Done');
  assert.match(lane.textContent, /Project: Shop/); assert.match(lane.textContent, /Last mergedNo merged cards yet/);
  const branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: project.repository.root, encoding: 'utf8' }).trim();
  await until(() => lane.isConnected ? lane.querySelector('.project-card-facts dd:nth-of-type(2)').textContent === branch : $('.project-lane .project-card-facts dd:nth-of-type(2)')?.textContent === branch, 'branch from Git');
  // Not a card: no count, no drag, no drop, no task controls.
  assert.equal($('#board-count').textContent, '01');
  assert.equal([...columns.querySelectorAll('.kanban-column-count')].reduce((sum, count) => sum + Number(count.textContent), 0), 1);
  assert.equal($('.project-lane').querySelectorAll('.kanban-card, .kanban-cards, .kanban-count, [draggable]').length, 0);
  const drop = new win.Event('drop', { bubbles: true, cancelable: true }), over = new win.Event('dragover', { bubbles: true, cancelable: true });
  $('.project-lane').dispatchEvent(over); $('.project-lane').dispatchEvent(drop);
  assert.deepEqual([over.defaultPrevented, drop.defaultPrevented], [false, false], 'Nothing can be dropped on the lane');
  assert.equal((await app.board.view()).projects[0].tasks[0].column, card.column);
  // The last merged card is named with its number.
  await app.board.store.update(state => { Object.assign(state.projects[0].tasks[0], { column: 'done', completion: { kind: 'merged', at: Date.now(), summary: 'Merged' } }); });
  await win.__pbTest.loadBoard(); await ctx.idle();
  assert.match($('.project-lane').textContent, /Last merged#1 Checkout/);
  // Open project: the explorer opens in a large dialog with the checkout's files.
  [...$('.project-lane').querySelectorAll('button')].find(button => button.textContent === 'Open project').click();
  await until(() => $('.explorer-dialog')?.open && $('.explorer-dialog [data-path="index.html"]'), 'explorer tree');
  assert.equal($('.explorer-dialog .explorer-title').textContent, 'Project: Shop');
  $('.explorer-dialog').close();
  // Without a linked repository there is no lane.
  await app.board.linkRepository(project.id, { path: null, expectedRevision: (await app.board.state()).projects[0].revision });
  await win.__pbTest.loadBoard(); await ctx.idle();
  assert.equal($('.project-lane'), null);
  assert.equal($('#kanban-columns').lastElementChild.dataset.column, 'done');
});

/** The explorer on a fake server: `files` maps folders to entries, `disk` maps files to text. */
function explorer(t, { files, disk, status = {}, editors = { editors: [], preferred: null } } = {}) {
  const dom = new JSDOM('<body></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://127.0.0.1:4318/' });
  t.after(() => dom.window.close());
  const win = dom.window, calls = [], versions = new Map();
  win.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  win.HTMLDialogElement.prototype.close = function () { this.open = false; };
  win.AbortController = AbortController;
  for (const source of sources) win.eval(source);
  const version = path => `${path}:${disk[path]}`;
  const request = async (url, signal, { method = 'GET', body } = {}) => {
    const parsed = new URL(url, 'http://local'), action = parsed.pathname.split('/').pop(), path = parsed.searchParams.get('path');
    calls.push({ method, action, path, body: body && JSON.parse(JSON.stringify(body)) }); // A plain copy of the page's object.
    const refuse = (message, code) => { throw Object.assign(new Error(message), { code }); };
    if (action === 'git-status') return { project: { id: 'p1', name: 'Shop' }, folder: 'shop', branch: 'main', target: 'main', head: { subject: 'Add the cart', at: Date.now() - 60000 }, mergeBlocked: false, status: { entries: [] }, scopeVersion: 'scope', ...status };
    if (action === 'editors') return editors;
    if (action === 'open') return { opened: body.editor, name: 'The editor', folder: 'shop' };
    if (action === 'files' && method === 'POST') {
      if (files[body.path.split('/').slice(0, -1).join('/')]?.some(entry => entry.name === body.path.split('/').pop())) refuse('A file or folder with this name already exists.', 'FILE_EXISTS');
      const dir = body.path.split('/').slice(0, -1).join('/'), name = body.path.split('/').pop();
      files[dir] = [...files[dir], { name, kind: body.kind, blocked: false }];
      if (body.kind === 'file') disk[body.path] = ''; else files[body.path] = [];
      return { path: body.path, kind: body.kind, created: true };
    }
    if (action === 'files') return { scopeVersion: 'scope', entries: files[path], next: null, truncated: false };
    if (method === 'PUT') {
      if (body.version !== version(body.path)) refuse('This file changed on disk or the project was relinked. Your draft is kept.', 'FILE_CONFLICT');
      disk[body.path] = body.text; return { version: version(body.path), scopeVersion: 'scope' };
    }
    if (typeof disk[path] !== 'string') refuse(disk[path].message, disk[path].code);
    const current = version(path);
    return parsed.searchParams.get('version') === current ? { version: current, scopeVersion: 'scope', unchanged: true } : { version: current, scopeVersion: 'scope', text: disk[path], unchanged: false };
  };
  const ui = win.PromptboardExplorer.create({ request });
  ui.open({ id: 'p1', name: 'Shop', repository: { root: '/projects/shop' }, tasks: [] });
  const $ = selector => win.document.querySelector(selector), $$ = selector => [...win.document.querySelectorAll(selector)];
  const row = path => $(`[data-path="${path}"]`);
  const key = (target, key, extra = {}) => target.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
  const type = text => { const editor = $('.explorer .file-editor'); editor.value = text; editor.dispatchEvent(new win.Event('input', { bubbles: true })); };
  const press = label => { const button = $$('.explorer button').find(item => item.textContent === label || item.getAttribute('aria-label') === label); assert.ok(button, label); button.click(); };
  return { win, $, $$, row, key, type, press, calls, disk, files };
}
const shop = () => ({
  files: { '': [{ name: '.git', kind: 'directory', blocked: true }, { name: 'dist', kind: 'directory', blocked: false }, { name: 'src', kind: 'directory', blocked: false }, { name: '.env.example', kind: 'file', blocked: false }, { name: 'readme.md', kind: 'file', blocked: false }, { name: 'logo.png', kind: 'file', blocked: false }],
    src: [{ name: 'cart.js', kind: 'file', blocked: false }, { name: 'tax.js', kind: 'file', blocked: false }], dist: [{ name: 'out.js', kind: 'file', blocked: false }] },
  disk: { 'readme.md': '# Shop\n', 'src/cart.js': 'export const total = 1;\n', 'src/tax.js': 'export const tax = 0.2;\n', 'logo.png': { message: 'Binary files are not displayed by this viewer.', code: 'FILE_UNSUPPORTED' } },
});

test('the tree lists folders first, opens folders lazily, filters, dims hidden and ignored entries and shows Git markers', async t => {
  const { $, $$, row, calls, win } = explorer(t, { ...shop(), status: { status: { entries: [['src/cart.js', 'M'], ['src/tax.js', 'U'], ['readme.md', 'A'], ['dist', 'I']] } } });
  await settle();
  assert.deepEqual($$('.explorer-row').map(item => item.dataset.path), ['dist', 'src', '.env.example', 'readme.md', 'logo.png'], 'Git’s own folder is not shown');
  assert.equal(calls.filter(call => call.action === 'files').length, 1, 'Only the top folder is read');
  assert.equal(row('dist').classList.contains('is-dim'), true); assert.equal(row('.env.example').classList.contains('is-dim'), true); assert.equal(row('src').classList.contains('is-dim'), false);
  assert.equal(row('readme.md').querySelector('.explorer-mark').textContent, 'A');
  assert.equal(row('src').querySelector('.explorer-mark').textContent, '•', 'A folder with changes inside has a dot');
  assert.equal(row('src').getAttribute('aria-expanded'), 'false');
  row('src').click(); await settle();
  assert.equal(row('src').getAttribute('aria-expanded'), 'true');
  assert.deepEqual([row('src/cart.js').querySelector('.explorer-mark').textContent, row('src/tax.js').querySelector('.explorer-mark').textContent], ['M', 'U']);
  assert.equal(row('src/cart.js').getAttribute('aria-level'), '2');
  const filter = $('.explorer-filter'); filter.value = 'TAX'; filter.dispatchEvent(new win.Event('input'));
  assert.deepEqual($$('.explorer-row').map(item => item.dataset.path), ['src', 'src/tax.js']);
  filter.value = ''; filter.dispatchEvent(new win.Event('input'));
  row('src').click(); assert.equal(row('src/cart.js'), null, 'Collapsed again');
});

test('arrow keys move through the tree, Right and Left open and close folders, and Enter opens a file in the editor', async t => {
  const { $, row, key, win } = explorer(t, shop());
  await settle();
  row('dist').focus(); key(row('dist'), 'ArrowDown');
  assert.equal(win.document.activeElement, row('src'));
  key(row('src'), 'ArrowRight'); await settle();
  assert.equal(row('src').getAttribute('aria-expanded'), 'true');
  key(row('src'), 'ArrowRight'); assert.equal(win.document.activeElement, row('src/cart.js'));
  key(row('src/cart.js'), 'ArrowLeft'); assert.equal(win.document.activeElement, row('src'));
  key(row('src'), 'ArrowLeft'); assert.equal(row('src').getAttribute('aria-expanded'), 'false');
  key(row('src'), 'End'); assert.equal(win.document.activeElement, row('logo.png'));
  key(row('logo.png'), 'ArrowUp'); key(row('readme.md'), 'Enter'); await settle();
  assert.equal($('.explorer-tab-name').textContent, 'readme.md');
  assert.equal(win.document.activeElement, $('.explorer .file-editor'));
});

test('a file opens in a tab with line numbers; an edit marks the tab unsaved and Cmd+S saves it', async t => {
  const { $, row, key, type, calls, disk } = explorer(t, shop());
  await settle(); row('src').click(); await settle(); row('src/cart.js').click(); await settle();
  assert.equal($('.explorer-path').textContent, 'src/cart.js');
  assert.equal($('.explorer .file-line-number').textContent, '1'); assert.ok($('.explorer .file-token-keyword'));
  assert.equal($('.explorer-dot'), null);
  type('export const total = 2;\n');
  assert.ok($('.explorer-dot'), 'Unsaved dot'); assert.match($('.explorer-status').textContent, /Not saved/);
  assert.equal(disk['src/cart.js'], 'export const total = 1;\n', 'Nothing saves on its own');
  key($('.explorer .file-editor'), 's', { metaKey: true }); await settle();
  assert.equal(disk['src/cart.js'], 'export const total = 2;\n');
  assert.deepEqual(calls.filter(call => call.method === 'PUT').map(call => call.body), [{ path: 'src/cart.js', workspace: '', text: 'export const total = 2;\n', version: 'src/cart.js:export const total = 1;\n', scopeVersion: 'scope' }]);
  assert.equal($('.explorer-dot'), null); assert.equal($('.explorer-status').textContent, 'Saved.');
  row('src/tax.js').click(); await settle();
  type('changed'); key($('.explorer .file-editor'), 's', { ctrlKey: true }); await settle();
  assert.equal(disk['src/tax.js'], 'changed', 'Ctrl+S saves too');
});

test('a save over a newer disk version is refused, then Reload or Keep mine is the owner’s explicit choice', async t => {
  const { $, row, type, press, calls, disk } = explorer(t, shop());
  await settle(); row('readme.md').click(); await settle();
  type('# My shop\n'); disk['readme.md'] = '# Shop, merged by an agent\n';
  press('Save'); await settle();
  assert.equal(disk['readme.md'], '# Shop, merged by an agent\n', 'Nothing was overwritten');
  assert.equal($('.explorer-confirm').hidden, false); assert.match($('.explorer-confirm').textContent, /changed on disk/);
  assert.equal($('.explorer-save').disabled, true); assert.equal($('.explorer .file-editor').value, '# My shop\n', 'The draft is kept');
  press('Keep mine and save anyway'); await settle();
  assert.equal(disk['readme.md'], '# My shop\n');
  assert.equal($('.explorer-confirm').hidden, true);
  // Reload takes the disk version instead.
  type('# Draft\n'); disk['readme.md'] = '# Newer again\n';
  press('Save'); await settle();
  const puts = calls.filter(call => call.method === 'PUT').length;
  press('Reload'); await settle();
  assert.equal($('.explorer .file-editor').value, '# Newer again\n');
  assert.equal(calls.filter(call => call.method === 'PUT').length, puts, 'Reload never saves');
  assert.equal($('.explorer-dot'), null);
});

test('closing an unsaved tab asks first; binary and oversized files open read only with a note', async t => {
  const { $, $$, row, type, press } = explorer(t, shop());
  await settle(); row('readme.md').click(); await settle();
  type('draft');
  press('Close readme.md');
  assert.match($('.explorer-confirm').textContent, /without saving/); assert.equal($$('.explorer-tab').length, 1);
  press('Keep editing'); assert.equal($('.explorer-confirm').hidden, true); assert.equal($('.explorer .file-editor').value, 'draft');
  press('Close readme.md'); press('Close without saving');
  assert.equal($$('.explorer-tab').length, 0); assert.equal($('.explorer-empty').hidden, false);
  row('logo.png').click(); await settle();
  assert.equal($('.explorer-readonly').hidden, false); assert.match($('.explorer-readonly').textContent, /Binary files are not displayed/);
  assert.equal($('.explorer-surface').hidden, true); assert.equal($('.explorer-save').disabled, true);
  assert.equal($('.explorer-status').textContent, 'Read only');
});

test('New file asks for a name in the tree, creates it in the chosen folder with the folder identity and opens it', async t => {
  const { $, row, press, key, calls, win } = explorer(t, shop());
  await settle(); row('src').click(); await settle();
  press('New file');
  const input = $('.explorer-create input');
  assert.equal(win.document.activeElement, input); assert.equal(input.getAttribute('aria-label'), 'Name of the new file');
  input.value = 'cart.js'; input.dispatchEvent(new win.Event('input')); key(input, 'Enter'); await settle();
  assert.match($('.explorer-message').textContent, /already exists/); assert.ok($('.explorer-create input'), 'The name stays for a fix');
  $('.explorer-create input').value = 'discount.js'; $('.explorer-create input').dispatchEvent(new win.Event('input')); key($('.explorer-create input'), 'Enter'); await settle();
  assert.deepEqual(calls.filter(call => call.method === 'POST').at(-1).body, { path: 'src/discount.js', kind: 'file', scopeVersion: 'scope' });
  assert.ok(row('src/discount.js')); assert.equal($('.explorer-tab-name.explorer-tab-name').textContent, 'discount.js');
  press('New folder'); key($('.explorer-create input'), 'Escape');
  assert.equal($('.explorer-create'), null, 'Escape cancels the name');
});

test('the notice says plainly when uncommitted changes stop merges, or when another branch is checked out', async t => {
  const blocked = explorer(t, { ...shop(), status: { mergeBlocked: true } });
  await settle();
  assert.equal(blocked.$('.explorer-notice').textContent, 'You have changes here that are not committed. Promptboard will not merge cards into main until you commit or discard them.');
  assert.match(blocked.$('.explorer-meta').textContent, /shop · main · Add the cart · 1 minute ago/);
  const other = explorer(t, { ...shop(), status: { branch: 'experiment' } });
  await settle();
  assert.match(other.$('.explorer-notice').textContent, /has experiment checked out\. Cards merge into main/);
  const clean = explorer(t, shop());
  await settle();
  assert.equal(clean.$('.explorer-notice').hidden, true);
});

test('Open in IDE opens the remembered editor, or lets the owner choose one', async t => {
  const one = explorer(t, { ...shop(), editors: { editors: [{ id: 'code', name: 'Visual Studio Code' }, { id: 'zed', name: 'Zed' }], preferred: 'zed' } });
  await settle(); one.press('Open in IDE'); await settle();
  assert.deepEqual(one.calls.filter(call => call.action === 'open').map(call => call.body), [{ target: 'editor', editor: 'zed' }]);
  const choose = explorer(t, { ...shop(), editors: { editors: [{ id: 'code', name: 'Visual Studio Code' }, { id: 'zed', name: 'Zed' }], preferred: null } });
  await settle(); choose.press('Open in IDE'); await settle();
  assert.equal(choose.$('.explorer-menu').hidden, false);
  choose.press('Visual Studio Code'); await settle();
  assert.deepEqual(choose.calls.filter(call => call.action === 'open').map(call => call.body), [{ target: 'editor', editor: 'code' }]);
});

test('Refresh shows files a merge added, updates clean tabs and flags a changed file that has unsaved edits', async t => {
  const { $, row, type, press, files, disk } = explorer(t, shop());
  await settle(); row('src').click(); await settle();
  row('src/cart.js').click(); await settle(); row('readme.md').click(); await settle();
  type('# Mine\n');
  // A merge lands: a new file, a new version of a clean open file and of the edited one.
  files.src.push({ name: 'shipping.js', kind: 'file', blocked: false });
  disk['src/cart.js'] = 'export const total = 5;\n'; disk['readme.md'] = '# Merged\n';
  press('Refresh'); await settle();
  assert.ok(row('src/shipping.js'), 'The new file is in the tree, with its folder still open');
  assert.match($('.explorer-confirm').textContent, /changed on disk/); assert.equal($('.explorer .file-editor').value, '# Mine\n');
  press('cart.js'); await settle();
  assert.equal($('.explorer .file-editor').value, 'export const total = 5;\n');
  assert.equal($('.explorer-status').textContent, 'Updated from disk.');
});

test('the pop-out window says why when Promptboard gives it no session, instead of waiting on "Opening the project…"', async t => {
  const answers = [[{ status: 503, body: { error: 'The app is shutting down.', code: 'SHUTTING_DOWN' } }, 'The app is shutting down. Reload it in a moment.'],
    [{ status: 200, body: {} }, 'Promptboard did not return a session for this window. Reload it in a moment.'],
    [null, 'Promptboard isn’t responding. Check that it is still running, then reload.']];
  for (const [answer, text] of answers) {
    const dom = new JSDOM('<body><main id="project-explorer-page"><p>Opening the project…</p></main></body>', { runScripts: 'outside-only', url: 'http://127.0.0.1:4318/project.html?project=p1' });
    t.after(() => dom.window.close());
    dom.window.fetch = async () => { if (!answer) throw new TypeError('Failed to fetch'); return new Response(JSON.stringify(answer.body), { status: answer.status }); };
    for (const source of sources) dom.window.eval(source);
    await until(() => dom.window.document.querySelector('#project-explorer-page').textContent === text, text);
  }
});
