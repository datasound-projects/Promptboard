import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { pickProject } from './helpers/projects.mjs';
import { startTestServer } from './helpers/test-server.mjs';
import { customPipelineConfig } from './helpers/pipeline.mjs';

test('stable task numbers survive deletion, keyboard edits and archive restoration across both themes and widths without changing prompt bytes', { skip: !await findChrome(), timeout: 90000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const project = await app.board.createProject({ name: 'Numbered tasks' }), pipeline = customPipelineConfig();
  for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  await app.board.setPipeline(project.id, { pipeline, expectedRevision: project.revision, confirm: true });
  const create = title => app.board.createTask({ projectId: project.id, title, prompt: '  Original\r\n雪\n' });
  const a = await create('A long task title '.repeat(6)), deleted = await create('Deleted'), b = await create('#30 <img src=x onerror="window.__numberPwned=1">');
  await app.board.store.update(state => { state.projects[0].nextTaskNumber = Number.MAX_SAFE_INTEGER - 1; });
  const c = await create('Archived');
  await app.board.deleteTask(deleted.id, { expectedRevision: deleted.revision });
  for (const task of [b, c]) await app.board.transition(task.id, { column: 'done', expectedRevision: task.revision, transitionId: `number-${task.id}` });
  const browser = await launch(); t.after(() => browser.close());
  const enter = async selector => { await browser.eval(`document.querySelector(${JSON.stringify(selector)}).focus();`); await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' }); await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); };
  await browser.goto(`${app.url}/#/kanban`); await browser.until(`document.querySelector('#workspace-list [data-project-id="${project.id}"]')`, 'project loaded');
  await browser.eval(pickProject(project.id));
  await browser.until(`document.querySelector('[data-id="${a.id}"] .task-number')`, 'task number rendered');
  const before = structuredClone(await app.board.state());
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    await browser.resize(width, 900); await browser.eval(`document.documentElement.dataset.theme=${JSON.stringify(theme)};`);
    assert.equal(await browser.eval(`return document.querySelector('[data-id="${a.id}"] .task-number').textContent;`), '#1');
    assert.equal(await browser.layout(`const card=document.querySelector('[data-id="${a.id}"]'),h=card.querySelector('h4'),n=h.querySelector('.task-number'),b=h.querySelector('.kanban-open');return h.scrollWidth<=h.clientWidth+1 && n.getAttribute('aria-label')==='Task number 1' && b.textContent===${JSON.stringify(a.title)};`), true);
    await enter(`[data-id="${a.id}"] .kanban-open`); await browser.until(`document.getElementById('card-dialog').open`, 'edit dialog');
    assert.equal(await browser.eval(`return document.getElementById('card-dialog-project').textContent.startsWith('#1 · ') && document.getElementById('card-title').value===${JSON.stringify(a.title)} && document.getElementById('card-prompt').value===${JSON.stringify(a.prompt.replace(/\r\n/g, '\n'))};`), true);
    await browser.key('Escape', 'Escape', 27); await browser.until(`!document.getElementById('card-dialog').open`, 'editor closed');
    await enter('[data-column="done"] .kanban-done-all'); await browser.until(`document.getElementById('done-dialog').open`, 'archive opened');
    await browser.eval(`const f=document.getElementById('archive-filter');f.focus();f.value='';f.dispatchEvent(new Event('input',{bubbles:true}));`); await browser.type('#3');
    await browser.until(`document.querySelectorAll('#archive-rows tr').length===1`, 'exact number filtered');
    assert.equal(await browser.eval(`return document.querySelector('#archive-rows tr').dataset.archiveTask===${JSON.stringify(b.id)} && document.querySelector('#archive-rows .task-number').textContent==='#3' && document.querySelector('.archive-title').textContent===${JSON.stringify(b.title)} && !document.querySelector('#archive-rows img') && !window.__numberPwned;`), true);
    assert.equal(await browser.layout(`const d=document.getElementById('done-dialog').getBoundingClientRect(),h=document.querySelector('.archive-task-heading');return d.left>=-1 && d.right<=innerWidth+1 && h.scrollWidth<=h.clientWidth+1;`), true);
    await browser.eval(`const f=document.getElementById('archive-filter');f.value='#${c.number}';f.dispatchEvent(new Event('input',{bubbles:true}));`);
    assert.equal(await browser.layout(`const h=document.querySelector('.archive-task-heading'),n=h.querySelector('.task-number');return h.closest('tr').dataset.archiveTask===${JSON.stringify(c.id)} && n.textContent==='#${c.number}' && n.scrollWidth<=n.clientWidth+1 && h.scrollWidth<=h.clientWidth+1;`), true);
    if (process.env.PB_BROWSER_SHOTS) { await mkdir(process.env.PB_BROWSER_SHOTS, { recursive: true }); await writeFile(join(process.env.PB_BROWSER_SHOTS, `numbers-${width}-${theme}.png`), await browser.screenshot()); }
    await browser.eval(`const f=document.getElementById('archive-filter');f.value='#2';f.dispatchEvent(new Event('input',{bubbles:true}));`);
    assert.equal(await browser.eval(`return document.querySelectorAll('#archive-rows tr').length===0 && !document.getElementById('archive-empty').hidden;`), true);
    await enter('#done-dialog-close'); await browser.until(`!document.getElementById('done-dialog').open`, 'archive closed');
  }
  assert.deepEqual(await app.board.state(), before, 'Inspecting numbers never changes tasks or starts agents.');
  await enter('[data-column="done"] .kanban-done-all');
  await browser.eval(`const f=document.getElementById('archive-filter');f.value='#3';f.dispatchEvent(new Event('input',{bubbles:true}));`);
  await enter('[data-archive-action="details"]'); await browser.until(`document.getElementById('task-dialog').open`, 'details');
  assert.equal(await browser.eval(`return document.getElementById('task-dialog-stage').textContent.startsWith('#3 · ');`), true); await browser.key('Escape', 'Escape', 27);
  await enter('[data-column="done"] .kanban-done-all');
  await browser.eval(`const f=document.getElementById('archive-filter');f.value='#3';f.dispatchEvent(new Event('input',{bubbles:true}));`);
  await enter('#archive-select-visible');
  assert.equal(await browser.eval(`return document.getElementById('archive-bulk-target').value;`), 'todo');
  await enter('#archive-restore-selected');
  await browser.until(`document.querySelector('[data-column="todo"] [data-id="${b.id}"] .task-number')`, 'number preserved after keyboard restore');
  assert.equal(await browser.eval(`return document.querySelector('[data-id="${b.id}"] .task-number').textContent;`), '#3');
  const restored = (await app.board.state()).projects[0].tasks.find(task=>task.id===b.id); assert.equal(restored.number, 3); assert.equal(restored.prompt, b.prompt);
  assert.equal((await app.board.state()).runs.length, 0); assert.deepEqual(browser.consoleMessages.filter(message=>message.startsWith('EXCEPTION')), []);
});

test('older or malformed number metadata renders no invented task number and completed card cancellation still works', { skip: !await findChrome(), timeout: 60000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] }), project = await app.board.createProject({ name: 'Older metadata' });
  const task = await app.board.createTask({ projectId: project.id, title: 'Legacy done', prompt: 'Exact' });
  await app.board.store.update(state => { state.projects[0].tasks[0].column = 'done'; });
  const original = app.board.view.bind(app.board); app.board.view = async () => { const view = structuredClone(await original()); delete view.projects[0].tasks[0].number; return view; };
  const browser = await launch(); t.after(() => browser.close());
  const enter = async selector => { await browser.eval(`document.querySelector(${JSON.stringify(selector)}).focus();`); await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' }); await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); };
  await browser.goto(`${app.url}/#/kanban`); await browser.until(`document.querySelector('[data-id="${task.id}"]')`, 'legacy card loaded');
  assert.equal(await browser.eval(`return document.querySelector('[data-id="${task.id}"] .task-number');`), null);
  await enter('.kanban-done-all'); await enter('#done-dialog-list .kanban-more-toggle'); await enter('#done-dialog-list .kanban-delete');
  await browser.eval(`[...document.querySelectorAll('#done-dialog-list button')].find(b=>b.textContent==='Keep card').dataset.keepNumberTest='true';`); await enter('[data-keep-number-test]');
  assert.equal(await browser.eval(`return document.querySelectorAll('#done-dialog-list .kanban-confirm').length===0 && !document.querySelector('#done-dialog-list .task-number');`), true);
  await browser.key('Escape', 'Escape', 27);
  app.board.view = async () => { const view = structuredClone(await original()); view.projects[0].tasks[0].number = '<img src=x onerror="window.__badNumber=1">'; return view; };
  await browser.eval(`await loadBoard();`);
  assert.equal(await browser.eval(`return !document.querySelector('[data-id="${task.id}"] .task-number') && !window.__badNumber;`), true);
  assert.equal((await app.board.state()).projects[0].tasks[0].id, task.id); assert.deepEqual(browser.consoleMessages.filter(message=>message.startsWith('EXCEPTION')), []);
});
