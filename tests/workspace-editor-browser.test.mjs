import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch, findChrome } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const chrome = await findChrome();
test('IDE-style project folders and editor in Chrome: native typing, explicit save, drafts, conflict, AI review/cancel and mobile', { skip: !chrome, timeout: 120_000 }, async t => {
  const raw = await mkdtemp(join(tmpdir(), 'pb-editor-browser-')), root = await realpath(raw); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  for (const folder of ['one', 'two']) { await mkdir(join(root, folder, 'src'), { recursive: true }); await writeFile(join(root, folder, 'src', 'index.js'), `const project = "${folder}";\n`); }
  execFileSync('git', ['init', '-b', 'main'], { cwd: root }); execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'Initial'], { cwd: root });
  let calls = 0, mode = 'propose', cancelled = false;
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [], runner: async ({ signal }) => {
    calls++;
    if (mode === 'cancel') return new Promise((resolve, reject) => { signal.addEventListener('abort', () => { cancelled = true; reject(signal.reason); }, { once: true }); });
    return { text: JSON.stringify({ text: 'const project = "AI proposal";\n', summary: 'Changed the project label in this file only.' }) };
  } });
  // Use structured JSON, independent of shell escaping.
  const one = (await app.board.createProjectWithRepository({ name: 'One', folder: join(root, 'one') })).project;
  await app.board.createProjectWithRepository({ name: 'Two', folder: join(root, 'two') }); const before = await app.board.store.read();
  const browser = await launch(); assert.ok(browser); t.after(() => browser.close());
  await browser.goto(app.url + '#/kanban'); await browser.until('document.querySelectorAll(".workspace-files").length === 2', 'two separate projects');
  await browser.eval('for (const el of document.querySelectorAll(".file-tree-toggle")) el.click();');
  await browser.until('document.querySelectorAll("[data-file-path=src]").length === 2', 'project roots loaded');
  assert.equal(await browser.eval('return [...document.querySelectorAll("[data-file-path]")].some(e => ["one","two",".git"].includes(e.dataset.filePath));'), false);
  await browser.eval('document.querySelector("[data-file-path=src]").click();'); await browser.until('!!document.querySelector("[data-file-path=\\"src/index.js\\"]")', 'nested file');
  await browser.eval('document.querySelector("[data-file-path=\\"src/index.js\\"]").click();'); await browser.until('document.querySelector(".file-code").textContent.includes("one")', 'file preview');
  assert.equal(calls, 0); assert.equal(await browser.eval('return document.querySelector("#workspace-file-title").textContent;'), 'One');
  await browser.eval('document.querySelector("[aria-label=\\"Edit file\\"]").click(); const e = document.querySelector(".file-editor"); e.focus(); e.select();');
  const manual = 'const project = "manual 🐕";\n'; await browser.send('Input.insertText', { text: manual });
  await browser.until('!document.querySelector(".file-save").disabled', 'unsaved draft'); assert.notEqual(await readFile(join(root, 'one', 'src', 'index.js'), 'utf8'), manual);
  assert.equal(await browser.eval('return document.querySelector(".file-editor").value;'), manual);
  assert.equal(await browser.layout('const c=document.querySelector(".file-code"), e=document.querySelector(".file-editor"), text=document.querySelector(".file-line-text"); return Math.abs(e.getBoundingClientRect().left-text.getBoundingClientRect().left)<1 && getComputedStyle(c).font === getComputedStyle(e).font;'), true);
  // Native save shortcut is confined to this dialog.
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 's', code: 'KeyS', modifiers: 2, windowsVirtualKeyCode: 83 });
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', modifiers: 2, windowsVirtualKeyCode: 83 });
  await browser.until('document.querySelector(".file-status").textContent.includes("Saved")', 'saved file'); assert.equal(await readFile(join(root, 'one', 'src', 'index.js'), 'utf8'), manual);
  assert.equal(await readFile(join(root, 'two', 'src', 'index.js'), 'utf8'), 'const project = "two";\n');
  await browser.eval('const e=document.querySelector(".file-editor"); e.focus(); e.select();'); await browser.send('Input.insertText', { text: 'const project = "unsaved";\n' });
  await browser.eval('document.querySelector("[aria-label=\\"Minimize file viewer\\"]").click(); document.querySelector(".file-viewer-chip button").click();'); await browser.until('document.querySelector(".file-editor").value.includes("unsaved")', 'draft retained after minimize');
  await writeFile(join(root, 'one', 'src', 'index.js'), 'const project = "external";\n');
  await browser.until('!document.querySelector(".file-close-confirm").hidden', 'conflict detected', 15_000);
  assert.equal(await browser.eval('return document.querySelector(".file-editor").value;'), 'const project = "unsaved";\n'); assert.equal(await browser.eval('return document.querySelector(".file-save").disabled;'), true);
  await browser.eval('document.querySelector("[aria-label=\\"Discard draft and reload disk file\\"]").click();'); await browser.until('document.querySelector(".file-editor").value.includes("external")', 'explicit reload');
  await browser.eval('document.querySelector("[aria-label=\\"Show AI file panel\\"]").click(); document.querySelector("[aria-label=\\"Describe the change to this file\\"]").focus();'); await browser.send('Input.insertText', { text: 'Change the project label to AI proposal.' });
  await browser.eval('document.querySelector("[aria-label=\\"Propose changes to this file\\"]").click();');
  await browser.until('!document.querySelector("[aria-label=\\"Use AI proposal in draft\\"]").hidden', 'AI proposal ready'); assert.equal(calls, 1);
  assert.equal(await readFile(join(root, 'one', 'src', 'index.js'), 'utf8'), 'const project = "external";\n');
  assert.match(await browser.eval('return document.querySelector(".file-code").textContent;'), /AI proposal/);
  await browser.eval('document.querySelector("[aria-label=\\"Use AI proposal in draft\\"]").click();'); assert.equal(await browser.eval('return document.querySelector(".file-save").disabled;'), false);
  const screenshot = await browser.send('Page.captureScreenshot', { format: 'png' }); await writeFile('/private/tmp/promptboard-workspace-editor-desktop.png', Buffer.from(screenshot.data, 'base64'));
  await browser.eval('document.querySelector(".file-save").click();'); await browser.until('document.querySelector(".file-status").textContent.includes("Saved")', 'AI proposal explicitly saved');
  assert.equal(await readFile(join(root, 'one', 'src', 'index.js'), 'utf8'), 'const project = "AI proposal";\n');
  mode = 'cancel'; await browser.eval('document.querySelector("[aria-label=\\"Propose changes to this file\\"]").click();'); await browser.until('!document.querySelector("[aria-label=\\"Cancel file AI proposal\\"]").hidden', 'AI in progress');
  await browser.until('document.querySelector(".file-editor").readOnly', 'draft locked while AI runs');
  for (const end = Date.now() + 10_000; calls < 2 && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(calls, 2);
  await browser.eval('document.querySelector("[aria-label=\\"Cancel file AI proposal\\"]").click();');
  for (const end = Date.now() + 10_000; !cancelled && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(cancelled, true);
  await browser.until('!document.querySelector(".file-editor").readOnly', 'draft unlocked');
  assert.equal(await readFile(join(root, 'one', 'src', 'index.js'), 'utf8'), 'const project = "AI proposal";\n');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await browser.layout('const d=document.querySelector("#workspace-file-viewer").getBoundingClientRect(); return d.width<=390 && d.left>=0 && d.right<=390;'), true);
  await browser.eval('document.documentElement.dataset.theme="light";'); const mobile = await browser.send('Page.captureScreenshot', { format: 'png' }); await writeFile('/private/tmp/promptboard-workspace-editor-mobile.png', Buffer.from(mobile.data, 'base64'));
  assert.deepEqual(await app.board.store.read(), before); assert.deepEqual(browser.consoleMessages.filter(x => x.includes('EXCEPTION')), []); assert.equal(one.repository.root, root);
});
