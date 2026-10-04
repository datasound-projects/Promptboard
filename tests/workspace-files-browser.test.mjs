import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, findChrome } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const chrome = await findChrome();
test('Workspace inspection in real Chrome: import, nested tree, multiple viewers, refresh, keyboard, themes and mobile', { skip: !chrome, timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pb-file-browser-')); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await mkdir(join(root, 'src', 'nested'), { recursive: true });
  const filename = 'index.js', original = 'const value = "hello 🐕";\n// manual review\n'.repeat(100);
  await writeFile(join(root, 'src', 'nested', filename), original);
  await writeFile(join(root, 'readme.md'), '# Imported project\n<img src=x onerror="window.INJECTED=true">');
  await writeFile(join(root, 'binary.png'), Buffer.from([0, 1, 2, 3]));
  const deepParts = ['deep', ...Array.from({ length: 16 }, (_, i) => `level-${i}`)];
  await mkdir(join(root, ...deepParts), { recursive: true }); await writeFile(join(root, ...deepParts, 'leaf.txt'), 'Nested file');
  let calls = 0;
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [], folderPicker: async () => ({ path: root }), runner: async () => { calls++; throw new Error('File inspection cannot run a model.'); } });
  const browser = await launch(); assert.ok(browser); t.after(() => browser.close());
  const enter = async () => { await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' }); await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); };
  await browser.goto(app.url + '#/kanban');
  await browser.until('!document.querySelector("#workspace-open").disabled', 'workspace ready');
  await browser.eval('document.querySelector("#workspace-open").click();');
  await browser.until('!!document.querySelector(".workspace-files")', 'imported project files');
  const before = await app.board.store.read(), project = before.projects[0];
  assert.ok(project.repository);
  await browser.eval('document.querySelector(".file-tree-toggle").click();');
  await browser.until('!!document.querySelector("[data-file-path=src]")', 'root directory');
  for (let i = 1; i <= deepParts.length; i++) {
    const selector = `[data-file-path="${deepParts.slice(0, i).join('/')}"]`;
    await browser.until(`!!document.querySelector(${JSON.stringify(selector)})`, 'deep folder');
    await browser.eval(`document.querySelector(${JSON.stringify(selector)}).click();`);
  }
  const leaf = `[data-file-path="${deepParts.join('/')}/leaf.txt"]`;
  await browser.until(`!!document.querySelector(${JSON.stringify(leaf)})`, 'deep leaf');
  assert.equal(await browser.layout(`return document.querySelector(${JSON.stringify(leaf)}).getBoundingClientRect().width >= 120;`), true);
  assert.equal(await browser.layout('const el = document.querySelector(".workspace-files-body"); return el.scrollWidth > el.clientWidth;'), true);
  await browser.eval('document.querySelector("[data-file-path=deep]").click();');
  // Native keyboard activation of expansion and file opening.
  await browser.eval('document.querySelector("[data-file-path=src]").focus();');
  assert.equal(await browser.eval('return document.activeElement.dataset.filePath;'), 'src');
  await browser.eval('window.__fileEvents = []; for (const type of ["keydown", "keyup", "click"]) document.addEventListener(type, e => window.__fileEvents.push([type, e.key, e.target.dataset.filePath, e.defaultPrevented]), true);');
  await enter();
  try { await browser.until('!!document.querySelector("[data-file-path=\\"src/nested\\"]")', 'nested directory'); }
  catch (error) { throw new Error(`${error.message}; ${JSON.stringify(await browser.eval('return { events: window.__fileEvents, active: document.activeElement.outerHTML, tree: document.querySelector(".workspace-files").outerHTML, dialogs: [...document.querySelectorAll("dialog[open]")].map(d => d.id), errors: document.querySelector(".file-tree-note").textContent };'))}`); }
  await browser.eval('document.querySelector("[data-file-path=\\"src/nested\\"]").focus();'); await enter();
  await browser.until('!!document.querySelector("[data-file-path=\\"src/nested/index.js\\"]")', 'nested file');
  await browser.eval('document.querySelector("[data-file-path=\\"src/nested/index.js\\"]").focus();'); await enter();
  await browser.until('!!document.querySelector(".file-token-keyword")', 'highlighted code');
  assert.equal(await browser.eval('return document.querySelector("#workspace-file-title").textContent;'), project.name);
  assert.match(await browser.eval('return document.querySelector(".file-location").textContent;'), /Project checkout \/ src\/nested\/index\.js/);
  assert.equal(await browser.eval('return [...document.querySelectorAll(".file-line-text")].map(n => n.textContent).join("\\n");'), original);
  await browser.eval('document.querySelector(".file-code").scrollTop = 220;');
  await writeFile(join(root, 'src', 'nested', filename), original.replaceAll('hello', 'world'));
  await browser.until('document.querySelector(".file-line-text").textContent.includes("world")', 'live file update', 15_000);
  assert.equal(await browser.eval('return document.querySelector(".file-code").scrollTop;'), 220);
  assert.equal(await browser.eval('return document.querySelector("[data-file-path=src]").getAttribute("aria-expanded");'), 'true');
  await browser.eval('document.querySelector("[aria-label=\\"Minimize file viewer\\"]").click();');
  assert.equal(await browser.eval('return document.querySelector("#workspace-file-viewer").open;'), false);
  await browser.eval('document.querySelector("[data-file-path=\\"readme.md\\"]").click();');
  await browser.until('document.querySelector(".file-code").textContent.includes("Imported project")', 'second file');
  assert.equal(await browser.eval('return window.INJECTED || false;'), false);
  await browser.eval('document.querySelector(".file-viewer-tabs").children[0].click();');
  await browser.until('document.querySelector(".file-viewer-tabs").children.length === 2', 'two open files');
  assert.match(await browser.eval('return document.querySelector(".file-location").textContent;'), /src\/nested\/index\.js/);
  for (const theme of ['light', 'dark']) for (const width of [1280, 390]) {
    await browser.resize(width, 900);
    await browser.eval(`document.documentElement.dataset.theme = ${JSON.stringify(theme)};`);
    assert.equal(await browser.layout('const r = document.querySelector("#workspace-file-viewer").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;'), true);
    if (process.env.PB_FILE_SCREENSHOTS) {
      await mkdir('test-results/workspace-files', { recursive: true });
      await writeFile(`test-results/workspace-files/${theme}-${width}.png`, await browser.screenshot());
    }
  }
  await browser.key('Escape', 'Escape', 27);
  await browser.until('document.querySelector(".file-location").textContent.includes("readme.md")', 'remaining viewer after Escape');
  await browser.key('Escape', 'Escape', 27);
  await browser.until('!document.querySelector("#workspace-file-viewer").open', 'all viewers closed');
  // New/deleted filesystem entries refresh without collapsing expanded ancestors.
  await writeFile(join(root, 'src', 'nested', 'new.txt'), 'Observed new file');
  await browser.until('!!document.querySelector("[data-file-path=\\"src/nested/new.txt\\"]")', 'new file in expanded directory', 15_000);
  await rm(join(root, 'src', 'nested', 'new.txt'));
  await browser.until('!document.querySelector("[data-file-path=\\"src/nested/new.txt\\"]")', 'deleted file disappears', 15_000);
  // A binary failure cannot display the previous file or modify any state.
  await browser.eval('document.querySelector("[data-file-path=\\"binary.png\\"]").click();');
  await browser.until('document.querySelector(".file-status").classList.contains("file-error")', 'unsupported file notice');
  assert.equal(await browser.eval('return document.querySelector(".file-code").textContent;'), '');
  await browser.eval('document.querySelector("[aria-label=\\"Minimize file viewer\\"]").click(); location.hash = "#/";');
  await browser.until('document.documentElement.dataset.page === "compose"', 'Compose route unaffected');
  assert.equal(await browser.eval('return document.querySelector(".file-viewer-tray").hidden;'), true);
  await browser.eval('location.hash = "#/kanban";');
  await browser.until('!document.querySelector(".file-viewer-tray").hidden', 'minimized viewer retained');
  assert.deepEqual(await app.board.store.read(), before);
  assert.equal(await readFile(join(root, 'src', 'nested', filename), 'utf8'), original.replaceAll('hello', 'world'));
  assert.equal(calls, 0); assert.deepEqual(browser.consoleMessages.filter(m => m.includes('EXCEPTION')), []);
});
