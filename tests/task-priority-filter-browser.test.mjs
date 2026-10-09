import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

test('priority filters live in the archive; the Board shows every card and reorders the full column', { skip: !await findChrome(), timeout: 90000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  t.diagnostic('Filter fixture server started.');
  const project = await app.board.createProject({ name: 'Filtered pipeline', workflowMode: 'pipeline' });
  const exact = '  Composer\r\n🐕 {{title}}  ';
  const first = await app.board.createTask({ projectId: project.id, title: 'Urgent first', priority: 4, prompt: exact });
  const hidden = await app.board.createTask({ projectId: project.id, title: 'Hidden low', priority: 1, prompt: exact });
  const second = await app.board.createTask({ projectId: project.id, title: 'Urgent second', priority: 4, prompt: exact });
  const archived = [];
  for (let n = 0; n < 8; n++) {
    const task = await app.board.createTask({ projectId: project.id, title: n === 0 ? 'Oldest urgent archive' : `Archive ${n}`, priority: n === 0 ? 4 : n === 7 ? 1 : 0 });
    await app.board.transition(task.id, { column: 'done', expectedRevision: task.revision }); archived.push(task);
  }
  const other = await app.board.createProject({ name: 'Other pipeline', workflowMode: 'pipeline' });
  const otherTask = await app.board.createTask({ projectId: other.id, title: 'Other low', priority: 1 });
  const original = await app.board.state();
  t.diagnostic('Filter tasks and archive fixture created.');
  const browser = await launch(); assert.ok(browser); t.after(() => browser.close());
  t.diagnostic('Filter browser launched.');
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('promptboard.kanban.project',${JSON.stringify(project.id)});const fetchOriginal=window.fetch;window.__taskWrites=[];window.fetch=function(...args){if(/^\\/api\\/(tasks|projects)(?:\\/|$)/.test(args[0])&&args[1]?.method&&!['GET','HEAD'].includes(args[1].method))window.__taskWrites.push({url:args[0],body:JSON.parse(args[1].body||'{}')});return Reflect.apply(fetchOriginal,this,args);};` });
  const enter = async selector => { await browser.eval(`const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});e.focus();`);
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); };
  const select = async (id, value) => browser.eval(`const s=document.getElementById(${JSON.stringify(id)});s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));`);
  t.diagnostic('Filter browser initialization script registered.');
  await browser.goto(app.url + '/#/kanban'); await browser.until(`document.querySelector('[data-id="${first.id}"]')`, 'initial tasks');
  t.diagnostic('Filter initial tasks rendered.');
  const todo = () => browser.eval(`return [...document.querySelectorAll('[data-column="todo"] .kanban-card')].map(e=>e.dataset.id);`);
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    t.diagnostic(`Filter layout ${width}/${theme}.`);
    await browser.resize(width, 900); await browser.eval(`document.documentElement.dataset.theme=${JSON.stringify(theme)};`);
    // The Board has no filter rows and shows every card, whatever filter is saved.
    assert.equal(await browser.eval(`return document.querySelector('#board-filter-toolbar, #board-labels-toolbar, #board-search');`), null);
    assert.deepEqual(await todo(), [first.id, hidden.id, second.id]);
    assert.equal(await browser.eval(`return document.querySelector('[data-column="todo"] .kanban-column-count').textContent;`), '3');
    await enter('[data-column="done"] .kanban-done-all'); await browser.until(`document.getElementById('done-dialog').open`, 'archive');
    await browser.eval(`const s=document.getElementById('archive-priority-filter');s.value='all';s.dispatchEvent(new Event('change',{bubbles:true}));s.focus();`); await browser.type('u');
    await browser.until(`document.getElementById('archive-priority-filter').value==='4' && document.querySelector('#archive-rows [data-archive-task="${archived[0].id}"]')`, 'native urgent filter');
    assert.equal(await browser.eval(`return document.getElementById('archive-count').textContent;`), '1 of 8 tasks');
    await browser.eval(`document.getElementById('archive-filter').focus();`); await browser.type('no match');
    await browser.until(`!document.getElementById('archive-empty').hidden`, 'combined title and priority filter');
    await browser.eval(`const s=document.getElementById('archive-filter');s.value='';s.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('archive-priority-filter').focus();`); await browser.type('l');
    await browser.until(`document.getElementById('archive-priority-filter').value==='1' && document.querySelector('#archive-rows [data-archive-task="${archived[7].id}"]')`, 'Low filter');
    assert.equal(await browser.layout(`const r=document.getElementById('archive-priority-filter').getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth;`), true);
    if (process.env.PB_BROWSER_SHOTS) { await mkdir(process.env.PB_BROWSER_SHOTS, { recursive: true }); await writeFile(join(process.env.PB_BROWSER_SHOTS, `priority-filter-archive-${width}-${theme}.png`), await browser.screenshot()); }
    await enter('#done-dialog-close'); await browser.until(`!document.getElementById('done-dialog').open`, 'archive closed');
    assert.deepEqual(await todo(), [first.id, hidden.id, second.id], 'A saved filter never hides Board cards.');
  }
  assert.deepEqual(await app.board.state(), original, 'Filtering must make no saved task/configuration changes.');
  assert.deepEqual(await browser.eval('return window.__taskWrites;'), []);
  // Keyboard reordering moves past the real neighbour in the full column.
  await enter(`[data-id="${second.id}"] .kanban-more-toggle`); await enter(`[data-id="${second.id}"] .kanban-move-up`);
  await browser.until(`document.querySelectorAll('[data-column="todo"] .kanban-card')[1]?.dataset.id===${JSON.stringify(second.id)} && !document.querySelector('.kanban-card.pending')`, 'keyboard move');
  const reordered = (await app.board.state()).projects.find(p => p.id === project.id).tasks.filter(task => task.column === 'todo');
  assert.deepEqual(reordered.map(task => task.id), [first.id, second.id, hidden.id]);
  assert.ok(reordered.every(task => task.prompt === exact));
  assert.equal(await browser.eval(`return window.__taskWrites.at(-1).body.index;`), 1);
  // The filter is saved per project; the Board and Timeline stay unfiltered.
  assert.deepEqual(await browser.eval(`return [localStorage.getItem('promptboard.priority-filter.${project.id}'), localStorage.getItem('promptboard.priority-filter.${other.id}')];`), ['1', null]);
  await select('project-select', other.id); await browser.until(`document.querySelector('[data-id="${otherTask.id}"]')`, 'other project');
  await select('project-select', project.id); await browser.until(`document.querySelector('[data-id="${hidden.id}"]')`, 'back to the project');
  await browser.reload(); await browser.until(`document.querySelector('[data-id="${hidden.id}"]')`, 'Board after reload');
  await enter('#view-timeline'); await browser.until(`!document.getElementById('timeline').hidden`, 'timeline view');
  assert.equal(await browser.eval(`return document.getElementById('board-count').textContent;`), '11');
  await enter('#view-board'); await browser.until(`document.querySelector('[data-id="${hidden.id}"]')`, 'Board unfiltered again');
  assert.deepEqual((await app.board.state()).runs, []); assert.deepEqual((await app.board.state()).sessions, []);
  assert.deepEqual(browser.consoleMessages.filter(message => message.startsWith('EXCEPTION')), []);
});

test('malformed saved filters never hide cards', { skip: !await findChrome(), timeout: 60000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  t.diagnostic('Filter fixture server started.');
  const project = await app.board.createProject({ name: 'Saved filter', workflowMode: 'pipeline' });
  const task = await app.board.createTask({ projectId: project.id, title: 'Visible None' });
  const archived = await app.board.createTask({ projectId: project.id, title: 'Visible completed' }); await app.board.transition(archived.id, { column: 'done', expectedRevision: archived.revision });
  const browser = await launch(); assert.ok(browser); t.after(() => browser.close());
  t.diagnostic('Filter browser launched.');
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('promptboard.priority-filter.${project.id}','invalid');` });
  await browser.goto(app.url + '/#/kanban');
  t.diagnostic('Saved filter page loaded.');
  await browser.until(`document.querySelector('[data-id="${task.id}"]')`, 'malformed filter fallback');
  await browser.eval(`document.querySelector('[data-column="done"] .kanban-done-all').click();`);
  await browser.until(`document.getElementById('done-dialog').open && document.getElementById('archive-priority-filter').value==='all' && document.querySelector('#archive-rows [data-archive-task="${archived.id}"]')`, 'malformed filter shows every archived card');
  assert.deepEqual((await app.board.state()).runs, []);
});
