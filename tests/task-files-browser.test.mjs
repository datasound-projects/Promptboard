import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';
const chrome = await findChrome(), exact = '  Composer 雪\r\n{{attachments}}\r\n  ';
const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=';
async function key(b, selector) { await b.until(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e&&!e.disabled&&e.getClientRects().length>0;})()`, 'enabled file control'); await b.eval(`const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});e.focus();`); await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); }
async function setup(t, width, theme, old = false) {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] }), project = await app.board.createProject({ name: 'File authoring', workflowMode: 'pipeline' }), task = await app.board.createTask({ projectId: project.id, title: 'Exact Composer', prompt: exact });
  const b = await launch({ width, height: 900 }); assert.ok(b); t.after(() => b.close());
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('ste-prompt-engineer.theme',${JSON.stringify(theme)});localStorage.setItem('promptboard.kanban.project',${JSON.stringify(project.id)});${old ? "const nativeFetch=window.fetch;window.fetch=async (...args)=>{const response=await nativeFetch(...args);if(String(args[0]).endsWith('/api/session')){const data=await response.json();delete data.capabilities.taskFiles;return new Response(JSON.stringify(data),{status:response.status,headers:response.headers});}return response;};" : ''}` });
  await b.goto(app.url + '/#/kanban'); await b.resize(width, 900); await b.until(`document.querySelector('[data-id="${task.id}"]')`, 'attachment board'); return { app, project, task, b, owner: async () => (await app.board.state()).projects[0] };
}
async function file(b, prefix, mode = 'change', name = 'context.txt', base64 = Buffer.from('exact attachment').toString('base64')) {
  await b.eval(`const host=document.getElementById(${JSON.stringify(prefix + '-files')}), target=document.getElementById(${JSON.stringify(prefix + '-prompt')}), transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(atob(${JSON.stringify(base64)}),ch=>ch.charCodeAt(0))],${JSON.stringify(name)}));if(${JSON.stringify(mode)}==='change'){const input=host.querySelector('input[type=file]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));}else if(${JSON.stringify(mode)}==='paste'){target.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));}else{host.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));}`);
  await b.until(`document.querySelector('#${prefix}-files .task-file-list')?.textContent.includes(${JSON.stringify(name)}) && document.querySelector('#${prefix}-files input[type=file]').disabled===false`, 'attachment upload');
}
for (const width of [1280, 390]) for (const theme of ['light', 'dark']) test(`attachments author, preview and remove without changing exact Composer text in ${width}/${theme}`, { skip: !chrome, timeout: 60000 }, async t => {
  const w = await setup(t, width, theme), { b } = w;
  await b.eval(`openCard(${JSON.stringify(w.task.id)});`); await b.until('document.getElementById("card-dialog").open', 'file editor');
  await file(b, 'card'); await file(b, 'card', 'paste', 'screenshot.png', image);
  await b.eval(`document.querySelector('#card-files li:nth-child(2) button').click();`); await b.until('document.querySelector("#card-files img")?.naturalWidth===1', 'safe raster preview');
  assert.equal(await b.eval('return document.querySelectorAll("#card-files iframe,#card-files script,#card-files object").length;'), 0);
  await key(b, '#card-save'); await b.until('!document.getElementById("card-dialog").open', 'save attachments'); let task = (await w.owner()).tasks.find(row => row.id === w.task.id);
  assert.equal(task.prompt, exact); assert.equal(task.column, 'todo'); assert.equal(task.attachments.length, 2); assert.equal(task.contentRevision, 2); assert.deepEqual((await w.app.board.state()).runs, []);
  await b.eval(`openCard(${JSON.stringify(w.task.id)});`); await b.eval(`document.querySelector('#card-files li:first-child button:last-child').click();`); await key(b, '#card-save'); await b.until('!document.getElementById("card-dialog").open', 'remove assignment'); task = (await w.owner()).tasks[0]; assert.equal(task.attachments.length, 1); assert.equal(task.prompt, exact);
  await b.eval(`openCard(${JSON.stringify(w.task.id)});`); await rm((await w.app.board.taskFiles.read(w.project.id, task.attachments[0])).path); await b.eval(`document.querySelector('#card-files li:first-child button:first-of-type').click();`); await b.until('!document.querySelector("#card-files .inline-error").hidden', 'explicit missing attachment'); assert.match(await b.eval('return document.querySelector("#card-files .inline-error").textContent;'), /missing/);
  assert.equal(await b.layout('return document.documentElement.scrollWidth<=innerWidth;'), true);
});
test('Backlog dropped files survive promotion and keyboard @ references use the linked project boundary', { skip: !chrome, timeout: 60000 }, async t => {
  const w = await setup(t, 390, 'dark'), { b } = w;
  await key(b, '#view-backlog'); await key(b, '#backlog-new'); await file(b, 'backlog', 'drop', 'log.txt');
  await b.eval(`document.getElementById('backlog-title').value='Dropped draft';document.getElementById('backlog-prompt').value='exact draft';`); await key(b, '#backlog-form button[type=submit]'); await b.until('!document.getElementById("backlog-dialog").open', 'saved file draft'); let owner = await w.owner(); assert.equal(owner.backlog[0].attachments.length, 1); assert.deepEqual((await w.app.board.state()).runs, []);
  const promoted = await w.app.board.promoteBacklogItem(w.project.id, owner.backlog[0].id, { expectedRevision: 1, expectedBacklogRevision: owner.backlogRevision }); assert.equal(promoted.attachments[0].name, 'log.txt');
  const { project: created } = await w.app.board.createProjectWithRepository({ name: 'Reference project', workflowMode: 'pipeline', folder: 'new' });
  // A repository is created by the explicit New project API; references never invent roots.
  await writeFile(join(created.repository.inspectionRoot || created.repository.root, 'context.txt'), 'reference');
  await b.eval(`await loadBoard();savePref(SELECTED_PROJECT_KEY,${JSON.stringify(created.id)});renderBoard();openCard();document.getElementById('card-title').value='Reference task';const p=document.getElementById('card-prompt');p.value='Read @cont';p.focus();p.setSelectionRange(p.value.length,p.value.length);p.dispatchEvent(new Event('input',{bubbles:true}));`);
  await b.until('!document.querySelector("#card-files .task-file-suggestions").hidden', 'file autocomplete'); await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await b.until('document.querySelector("#card-files .task-file-list").textContent.includes("@context.txt")', 'reference selected'); await key(b, '#card-save'); await b.until('!document.getElementById("card-dialog").open', 'reference saved'); owner = (await w.app.board.state()).projects.find(row => row.id === created.id); assert.deepEqual(owner.tasks[0].fileReferences, ['context.txt']); assert.equal(owner.tasks[0].prompt, 'Read @context.txt '); assert.equal(owner.tasks[0].column, 'todo'); assert.deepEqual((await w.app.board.state()).runs, []);
});
test('older servers hide file authoring controls and preserve exact task text', { skip: !chrome, timeout: 60000 }, async t => {
  const w = await setup(t, 1280, 'light', true); await w.b.eval(`openCard(${JSON.stringify(w.task.id)});`); assert.equal(await w.b.eval('return document.getElementById("card-files").hidden;'), true); await key(w.b, '#card-save'); await w.b.until('!document.getElementById("card-dialog").open', 'old server save'); assert.equal((await w.owner()).tasks[0].prompt, exact); assert.equal((await w.owner()).tasks[0].contentRevision, 1);
});
