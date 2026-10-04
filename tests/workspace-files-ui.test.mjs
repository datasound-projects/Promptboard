import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const script = await readFile(new URL('../public/workspace-files.js', import.meta.url), 'utf8');
const project = (id, name = id) => ({ id, name, repository: { root: '/projects/' + id }, tasks: [] });
async function settle() { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)); }
function setup(t, adapter) {
  const dom = new JSDOM('<body><aside></aside></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close()); const win = dom.window, ticks = [], calls = [];
  win.setInterval = callback => ticks.push(callback); win.AbortController = AbortController;
  win.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  win.HTMLDialogElement.prototype.close = function () { this.open = false; };
  win.eval(script);
  const ui = win.PromptboardFiles.create({ request: async (url, signal) => {
    calls.push({ url, signal });
    const parsed = new URL(url, 'http://local'), id = parsed.pathname.split('/')[3], path = parsed.searchParams.get('path'), workspace = parsed.searchParams.get('workspace');
    if (adapter) return adapter({ parsed, id, path, workspace, signal });
    const base = { project: { id, name: id }, path, workspace: { id: workspace, name: workspace ? 'Task checkout' : 'Project checkout' } };
    if (parsed.pathname.endsWith('/files')) return { ...base, scopes: [{ id: '', name: 'Project checkout' }, { id: 'task_1', name: 'Actual task branch' }], entries: path ? [{ name: 'index.js', kind: 'file', blocked: false }] : [{ name: 'src', kind: 'directory', blocked: false }, { name: 'readme.md', kind: 'file', blocked: false }], next: null, truncated: false };
    return { ...base, version: id + path, text: `const value = "${id}";\n// Read-only\n`, unchanged: false };
  } });
  const $ = selector => win.document.querySelector(selector);
  const mount = p => { $('aside').append(ui.mount(p)); ui.setVisible(true); return $('aside').lastChild; };
  return { ui, win, $, ticks, calls, mount };
}

test('loads only explicitly expanded folders; keeps tree DOM and keyboard focus on board refresh', async t => {
  const { ui, mount, calls, $ } = setup(t), p = project('p_one');
  const host = mount(p); assert.equal(calls.length, 0);
  host.querySelector('.file-tree-toggle').click(); await settle();
  assert.equal(calls.length, 1); assert.equal(new URL(calls[0].url, 'http://local').searchParams.get('path'), '');
  host.querySelector('[data-file-path="src"]').click(); await settle();
  const file = $('[data-file-path="src/index.js"]'); assert.ok(file); file.focus();
  ui.sync([p]); assert.equal(ui.mount(p), host); assert.equal($.call(null, ':focus'), file);
  assert.equal(calls.some(c => c.url.includes('/file?')), false);
});

test('multiple project/file identities minimize, restore, switch, close and Escape independently', async t => {
  const { ui, mount, $ , win } = setup(t), one = project('p_one'), two = project('p_two');
  const first = mount(one), second = mount(two); ui.sync([one, two]);
  first.querySelector('.file-tree-toggle').click(); second.querySelector('.file-tree-toggle').click(); await settle();
  first.querySelector('[data-file-path="readme.md"]').click(); await settle();
  assert.equal($('#workspace-file-title').textContent, 'p_one');
  $('[aria-label="Minimize file viewer"]').click(); assert.equal($('#workspace-file-viewer').open, false);
  assert.equal($('.file-viewer-chip button').textContent, 'p_one · readme.md');
  second.querySelector('[data-file-path="readme.md"]').click(); await settle();
  $('.file-viewer-tabs').children[0].click(); await settle();
  assert.equal($('.file-viewer-tabs').children.length, 2);
  assert.equal($('#workspace-file-title').textContent, 'p_one');
  $('.file-viewer-tabs').children[1].click(); assert.equal($('#workspace-file-title').textContent, 'p_two');
  $('#workspace-file-viewer').dispatchEvent(new win.Event('cancel', { cancelable: true }));
  assert.equal($('#workspace-file-title').textContent, 'p_one');
  $('[aria-label="Close file viewer"]').click(); assert.equal($('#workspace-file-viewer').open, false);
  assert.equal($('.file-viewer-tray').hidden, true);
});

test('source and filenames remain inert text, with exact visible code, line numbers and lexical colors', async t => {
  const filename = '<img onerror=alert(1)>.js', source = 'const html = "<script>window.HACKED = true</script>";\n// comment';
  const { mount, $, win } = setup(t, async ({ parsed, id }) => parsed.pathname.endsWith('/files')
    ? { scopes: [{ id: '', name: 'Project checkout' }], entries: [{ name: filename, kind: 'file' }], next: null }
    : { project: { id, name: '<script>Project</script>' }, text: source, version: 'a' });
  const host = mount(project('p_one')); host.querySelector('button').click(); await settle();
  host.querySelector('.file-tree-row').click(); await settle();
  assert.equal(win.HACKED, undefined); assert.equal($('img'), null); assert.equal($('script'), null);
  assert.equal([...win.document.querySelectorAll('.file-line-text')].map(el => el.textContent).join('\n'), source);
  assert.equal(win.document.querySelectorAll('.file-line-number').length, 2);
  assert.ok($('.file-token-keyword')); assert.ok($('.file-token-string')); assert.ok($('.file-token-comment'));
});

test('refreshes file contents without losing scroll, selected file, expanded folders or focus', async t => {
  let revision = 1;
  const { mount, $, ticks } = setup(t, async ({ parsed, id, path }) => parsed.pathname.endsWith('/files')
    ? { scopes: [{ id: '', name: 'Project checkout' }], entries: path ? [{ name: 'index.js', kind: 'file' }] : [{ name: 'src', kind: 'directory' }], next: null }
    : { project: { id, name: id }, text: `const revision = ${revision};\n`.repeat(100), version: String(revision) });
  const host = mount(project('p_one')); host.querySelector('button').click(); await settle();
  $('[data-file-path="src"]').click(); await settle(); $('[data-file-path="src/index.js"]').click(); await settle();
  $('.file-code').scrollTop = 150; $('.file-code').scrollLeft = 20; revision = 2;
  await ticks[0](); await settle();
  assert.match($('.file-line-text').textContent, /revision = 2/);
  assert.equal($('.file-code').scrollTop, 150); assert.equal($('.file-code').scrollLeft, 20);
  assert.equal($('[data-file-path="src"]').getAttribute('aria-expanded'), 'true');
  assert.equal($('[data-file-path="src/index.js"]').classList.contains('selected'), true);
  assert.match($('.file-status').textContent, /Updated since opening/);
});

test('switching checkout resets only that tree; file requests use the selected task ID', async t => {
  const { mount, $, calls, win } = setup(t); const host = mount(project('p_one'));
  host.querySelector('button').click(); await settle();
  $('.file-scope').value = 'task_1'; $('.file-scope').dispatchEvent(new win.Event('change')); await settle();
  $('[data-file-path="readme.md"]').click(); await settle();
  assert.ok(calls.filter(c => c.url.includes('/file?')).every(c => new URL(c.url, 'http://local').searchParams.get('workspace') === 'task_1'));
  assert.match($('.file-location').textContent, /Actual task branch/);
});

test('unavailable refreshed files retain the last snapshot with a clear notice; unsupported files show no previous text', async t => {
  let failed = false;
  const { mount, $, ticks } = setup(t, async ({ parsed, id, path }) => {
    if (parsed.pathname.endsWith('/files')) return { scopes: [{ id: '', name: 'Project checkout' }], entries: [{ name: 'good.js', kind: 'file' }, { name: 'binary.png', kind: 'file' }], next: null };
    if (failed || path === 'binary.png') throw new Error('File unavailable.');
    return { project: { id, name: id }, version: 'one', text: 'const good = true;' };
  });
  const host = mount(project('p_one')); host.querySelector('button').click(); await settle();
  $('[data-file-path="good.js"]').click(); await settle(); failed = true; await ticks[0](); await settle();
  assert.match($('.file-status').textContent, /Showing the last read version/); assert.match($('.file-code').textContent, /const good/);
  $('[aria-label="Minimize file viewer"]').click(); $('[data-file-path="binary.png"]').click(); await settle();
  assert.match($('.file-status').textContent, /File unavailable/); assert.equal($('.file-code').textContent, '');
});

test('page changes abort work, hide viewers and restore minimized files only in Kanban; deletion closes snapshots', async t => {
  const { ui, mount, $, calls, ticks } = setup(t), p = project('p_one');
  const host = mount(p); host.querySelector('button').click(); await settle(); $('[data-file-path="readme.md"]').click(); await settle();
  ui.setVisible(false); assert.equal($('#workspace-file-viewer').open, false); assert.equal($('.file-viewer-tray').hidden, true);
  const count = calls.length; await ticks[0](); await settle(); assert.equal(calls.length, count);
  ui.setVisible(true); assert.equal($('.file-viewer-tray').hidden, false);
  $('.file-viewer-chip button').click(); await settle(); assert.equal($('#workspace-file-viewer').open, true);
  ui.sync([]); assert.equal($('#workspace-file-viewer').open, false); assert.equal($('.file-viewer-tray').hidden, true);
});

test('aborted old directory responses cannot repopulate a replacement project root', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { ui, mount, $ } = setup(t, async () => { await gate; return { scopes: [], entries: [{ name: 'old-secret.js', kind: 'file' }], next: null }; });
  const p = project('p_one'); const host = mount(p); host.querySelector('button').click(); await settle();
  const replaced = { ...p, repository: { root: '/projects/replaced' } }; ui.sync([replaced]); mount(replaced);
  release(); await settle(); assert.equal($('.workspace-files:last-child').textContent.includes('old-secret'), false);
});
