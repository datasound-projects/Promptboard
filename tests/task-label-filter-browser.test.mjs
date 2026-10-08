import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const chrome = await findChrome();
const select = (browser, id, value) => browser.eval(`const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));`);
async function enter(browser, selector) {
  await browser.until(`document.querySelector(${JSON.stringify(selector)})`, 'filter keyboard target');
  await browser.eval(`const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});e.focus();`);
  assert.equal(await browser.eval(`return document.activeElement===document.querySelector(${JSON.stringify(selector)});`), true);
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}

test('label filters combine priority/search in the archive, keep archive selections, and never hide Board cards', { skip: !chrome, timeout: 90000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const project = await app.board.createProject({ name: 'Label filters', workflowMode: 'pipeline' });
  await app.board.setLabels(project.id, { labels: [{ id: 'bug', name: 'Bug', color: '#123456' }, { id: 'none', name: 'UI 雪'.repeat(12), color: '#abcdef' }], expectedLabelRevision: 0 });
  const exact = '  Composer\r\n雪 {{title}}  ';
  const task = (title, labelIds, priority = 4) => app.board.createTask({ projectId: project.id, title, prompt: exact, labelIds, expectedLabelRevision: 1, priority });
  const first = await task('First bug', ['bug']), hidden = await task('Hidden UI', ['none']), second = await task('Second bug', ['bug']);
  const unlabeled = await task('Unlabeled task', [], 1), lowBug = await task('Low bug', ['bug'], 1);
  const archived = [];
  for (let n = 0; n < 8; n++) {
    const card = await task(n === 0 ? 'Oldest bug archive' : `Archive ${n}`, n === 0 ? ['bug'] : n === 7 ? [] : ['none'], n === 7 ? 1 : 4);
    await app.board.transition(card.id, { column: 'done', expectedRevision: card.revision }); archived.push(card);
  }
  const other = await app.board.createProject({ name: 'Other', workflowMode: 'pipeline' });
  const otherTask = await app.board.createTask({ projectId: other.id, title: 'Other task' });
  const original = await app.board.state();
  const browser = await launch(); assert.ok(browser); t.after(() => browser.close());
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('promptboard.kanban.project',${JSON.stringify(project.id)});const nativeFetch=window.fetch;window.__writes=[];window.fetch=function(...args){if(/^\\/api\\/(tasks|projects)(?:\\/|$)/.test(args[0])&&args[1]?.method&&!['GET','HEAD'].includes(args[1].method))window.__writes.push({url:args[0],body:JSON.parse(args[1].body||'{}')});return Reflect.apply(nativeFetch,this,args);};` });
  await browser.goto(app.url + '/#/kanban'); await browser.until(`document.querySelector('[data-id="${first.id}"]')`, 'label filter board');
  const todo = () => browser.eval('return [...document.querySelectorAll("[data-column=todo] .kanban-card")].map(e=>e.dataset.id);');
  const all = [first.id, hidden.id, second.id, unlabeled.id, lowBug.id];
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    t.diagnostic(`Label filters ${width}/${theme}.`);
    await browser.resize(width, 900); await browser.eval(`document.documentElement.dataset.theme=${JSON.stringify(theme)};`);
    assert.equal(await browser.eval('return document.querySelector("#board-filter-toolbar, #board-labels-toolbar, #board-search");'), null, 'The Board has no filter row.');
    assert.deepEqual(await todo(), all);
    assert.equal(await browser.eval('return document.querySelector("[data-column=todo] .kanban-column-count").textContent;'), '5');
    if (process.env.PB_BROWSER_SHOTS) { await mkdir(process.env.PB_BROWSER_SHOTS, { recursive: true }); await writeFile(join(process.env.PB_BROWSER_SHOTS, `label-filter-board-${width}-${theme}.png`), await browser.screenshot()); }
    await enter(browser, '[data-column=done] .kanban-done-all'); await browser.until('document.getElementById("done-dialog").open && document.querySelector("#archive-rows input")', 'completed table');
    await select(browser, 'archive-priority-filter', '4'); await select(browser, 'archive-label-filter', 'all');
    await browser.eval('document.getElementById("archive-label-filter").focus();'); await browser.type('b');
    await browser.until(`document.getElementById('archive-label-filter').value==='label:bug' && document.querySelector('#archive-rows [data-archive-task="${archived[0].id}"]')`, 'native label typeahead');
    assert.equal(await browser.eval('return document.getElementById("archive-count").textContent;'), '1 of 8 tasks');
    await browser.eval('const e=document.querySelector("#archive-rows input[type=checkbox]");e.checked=true;e.dispatchEvent(new Event("change",{bubbles:true}));');
    await select(browser, 'archive-label-filter', 'label:none');
    assert.equal(await browser.eval('return document.getElementById("archive-label-filter").value;'), 'label:none', 'A real label whose ID is none is distinct from Unlabeled.');
    assert.equal(await browser.eval('return document.getElementById("archive-count").textContent;'), '6 of 8 tasks');
    await select(browser, 'archive-label-filter', 'label:bug');
    assert.equal(await browser.eval('return document.querySelector("#archive-rows input[type=checkbox]").checked;'), true, 'Hidden selected rows remain selected.');
    await browser.eval(`const e=document.getElementById('archive-filter');e.value='#${archived[0].number}';e.dispatchEvent(new Event('input',{bubbles:true}));`);
    assert.equal(await browser.eval('return document.getElementById("archive-count").textContent;'), '1 of 8 tasks');
    await browser.eval('const e=document.getElementById("archive-filter");e.value="missing";e.dispatchEvent(new Event("input",{bubbles:true}));');
    assert.equal(await browser.eval('return document.getElementById("archive-empty").hidden;'), false);
    await browser.eval('const e=document.getElementById("archive-filter");e.value="";e.dispatchEvent(new Event("input",{bubbles:true}));');
    await select(browser, 'archive-priority-filter', 'all'); await select(browser, 'archive-label-filter', 'none');
    assert.ok(await browser.eval(`return !!document.querySelector('#archive-rows [data-archive-task="${archived[7].id}"]');`));
    assert.equal(await browser.layout(`const r=document.getElementById('archive-label-filter').getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth;`), true);
    if (process.env.PB_BROWSER_SHOTS) await writeFile(join(process.env.PB_BROWSER_SHOTS, `label-filter-archive-${width}-${theme}.png`), await browser.screenshot());
    await enter(browser, '#done-dialog-close');
    assert.deepEqual(await todo(), all, 'A saved filter never hides Board cards.');
  }
  assert.deepEqual(await app.board.state(), original, 'View changes must not write task, queue, session or project state.');
  assert.deepEqual(await browser.eval('return window.__writes;'), []);
  // Keyboard reordering moves past the real neighbour in the full column.
  await enter(browser, `[data-id="${second.id}"] .kanban-more-toggle`); await enter(browser, `[data-id="${second.id}"] .kanban-move-up`);
  await browser.until(`document.querySelectorAll('[data-column=todo] .kanban-card')[1]?.dataset.id===${JSON.stringify(second.id)} && !document.querySelector('.kanban-card.pending')`, 'keyboard move');
  const ordered = (await app.board.state()).projects.find(p => p.id === project.id).tasks.filter(card => card.column === 'todo');
  assert.deepEqual(ordered.map(card => card.id), [first.id, second.id, hidden.id, unlabeled.id, lowBug.id]);
  assert.ok(ordered.every(card => card.prompt === exact)); assert.equal(await browser.eval('return window.__writes.at(-1).body.index;'), 1);
  // Saved per project; Timeline and Board stay unfiltered.
  assert.deepEqual(await browser.eval(`return [localStorage.getItem('promptboard.label-filter.${project.id}'), localStorage.getItem('promptboard.label-filter.${other.id}')];`), ['none', null]);
  await select(browser, 'project-select', other.id); await browser.until(`document.querySelector('[data-id="${otherTask.id}"]')`, 'other label project');
  await select(browser, 'project-select', project.id); await browser.reload(); await browser.until(`document.querySelector('[data-id="${second.id}"]')`, 'saved label preference');
  await enter(browser, '#view-timeline'); await browser.until('!document.getElementById("timeline").hidden', 'unfiltered timeline');
  assert.equal(await browser.eval('return document.getElementById("board-count").textContent;'), '13');
  await enter(browser, '#view-board'); await browser.until('document.querySelectorAll("[data-column=todo] .kanban-card").length===5', 'Board unfiltered again');
  assert.deepEqual((await app.board.state()).runs, []); assert.deepEqual((await app.board.state()).sessions, []);
  assert.deepEqual(browser.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);
});

test('label rename retains stable filter identity; removing the selected definition returns both views to All without losing tasks', { skip: !chrome, timeout: 60000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const project = await app.board.createProject({ name: 'Changing labels', workflowMode: 'pipeline' });
  await app.board.setLabels(project.id, { labels: [{ id: 'bug', name: 'Bug', color: '#123456' }], expectedLabelRevision: 0 });
  const card = await app.board.createTask({ projectId: project.id, title: 'Assigned', labelIds: ['bug'], expectedLabelRevision: 1 });
  const other = await app.board.createTask({ projectId: project.id, title: 'Unlabeled' });
  const done = await app.board.createTask({ projectId: project.id, title: 'Archived' }); await app.board.transition(done.id, { column: 'done', expectedRevision: done.revision });
  const browser = await launch(); assert.ok(browser); t.after(() => browser.close());
  await browser.goto(app.url + '/#/kanban'); await browser.until(`document.querySelector('[data-id="${card.id}"]')`, 'changing label board');
  await enter(browser, '[data-column=done] .kanban-done-all');
  await browser.until('document.getElementById("done-dialog").open', 'changing label archive open');
  await select(browser, 'archive-label-filter', 'label:bug');
  await app.board.setLabels(project.id, { labels: [{ id: 'bug', name: '<img src=x>', color: '#654321' }], expectedLabelRevision: 1 });
  await browser.until('document.querySelector("#archive-label-filter option:checked").textContent==="<img src=x>"', 'renamed stable filter');
  assert.equal(await browser.eval('return document.getElementById("archive-label-filter").value;'), 'label:bug');
  assert.equal(await browser.eval('return !!document.querySelector("#archive-label-filter img");'), false);
  const before = await app.board.state(); await app.board.setLabels(project.id, { labels: [], expectedLabelRevision: 2 });
  await browser.until(`document.getElementById('archive-label-filter').value==='all' && document.querySelector('[data-id="${other.id}"]') && document.querySelector('#archive-rows [data-archive-task="${done.id}"]')`, 'deleted filter reset');
  assert.equal(await browser.eval(`return localStorage.getItem('promptboard.label-filter.${project.id}');`), 'all');
  const after = await app.board.state(); assert.equal(after.revision, before.revision + 1, 'Only the explicit catalog removal writes state.');
  assert.equal(after.projects[0].tasks.length, 3); assert.deepEqual(after.runs, []); assert.deepEqual(after.sessions, []);
});

test('older capabilities, malformed or foreign saved label filters and legacy projects never hide tasks', { skip: !chrome, timeout: 60000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const project = await app.board.createProject({ name: 'Old label capability', workflowMode: 'pipeline' });
  await app.board.setLabels(project.id, { labels: [{ id: 'bug', name: 'Bug', color: '#123456' }], expectedLabelRevision: 0 });
  const card = await app.board.createTask({ projectId: project.id, title: 'Visible unlabeled' });
  const done = await app.board.createTask({ projectId: project.id, title: 'Visible archive' }); await app.board.transition(done.id, { column: 'done', expectedRevision: done.revision });
  const legacy = await app.board.createProject({ name: 'Legacy', workflowMode: 'legacy' });
  const old = await app.board.createTask({ projectId: legacy.id, title: 'Legacy visible', prompt: 'Required legacy prompt' });
  const original = await app.board.state();
  const browser = await launch(); assert.ok(browser); t.after(() => browser.close());
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('promptboard.kanban.project',${JSON.stringify(project.id)});localStorage.setItem('promptboard.label-filter.${project.id}','label:bug');const nativeFetch=window.fetch;window.fetch=async function(...args){const r=await Reflect.apply(nativeFetch,this,args);if(args[0]!=='/api/session')return r;const d=await r.json();delete d.capabilities.taskLabels;return new Response(JSON.stringify(d),{status:r.status,headers:r.headers});};` });
  await browser.goto(app.url + '/#/kanban'); await browser.until(`document.querySelector('[data-id="${card.id}"]')`, 'older visible labels');
  await enter(browser, '[data-column=done] .kanban-done-all');
  await browser.until('document.getElementById("done-dialog").open', 'older archive open');
  assert.equal(await browser.eval('return document.getElementById("archive-label-field").hidden;'), true);
  assert.ok(await browser.eval(`return !!document.querySelector('#archive-rows [data-archive-task="${done.id}"]');`));
  for (const value of ['invalid', 'label:foreign']) {
    await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('promptboard.label-filter.${project.id}',${JSON.stringify(value)});window.fetch=async function(...args){return Reflect.apply(nativeFetch,this,args);};` });
    await browser.reload(); await browser.until(`document.querySelector('[data-id="${card.id}"]')`, 'board after label preference');
    await enter(browser, '[data-column=done] .kanban-done-all');
    await browser.until(`document.getElementById('done-dialog').open && document.getElementById('archive-label-filter').value==='all' && document.querySelector('#archive-rows [data-archive-task="${done.id}"]')`, 'invalid label preference fallback');
  }
  await browser.eval('document.getElementById("done-dialog").close();');
  await select(browser, 'project-select', legacy.id); await browser.until(`document.querySelector('[data-id="${old.id}"]')`, 'legacy visible');
  assert.deepEqual(await app.board.state(), original);
});
