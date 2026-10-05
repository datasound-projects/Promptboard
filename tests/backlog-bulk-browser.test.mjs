import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';
const chrome = await findChrome();
async function enter(browser, selector) {
  await browser.until(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e&&!e.disabled&&e.getClientRects().length>0;})()`, 'available bulk keyboard target');
  await browser.eval(`const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});e.focus();`);
  assert.equal(await browser.eval(`return document.activeElement===document.querySelector(${JSON.stringify(selector)});`), true);
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}
const select = (browser, id, value) => browser.eval(`const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));`);
async function fixture(t, { width = 1280, theme = 'light', older = false } = {}) {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const project = await app.board.createProject({ name: 'Bulk backlog', workflowMode: 'pipeline' });
  await app.board.setLabels(project.id, { labels: [{ id: 'bug', name: 'Literal <img src=x> 雪', color: '#123456' }], expectedLabelRevision: 0 });
  const exact = '  Composer\r\n雪 {{title}}  ', items = [];
  for (const [index, title] of ['First', 'Hidden second', 'Third'].entries()) items.push(await app.board.createBacklogItem(project.id, { title, prompt: exact, priority: 4, labelIds: index === 1 ? [] : ['bug'], expectedLabelRevision: 1, expectedBacklogRevision: index }));
  const browser = await launch(); assert.ok(browser); t.after(() => browser.close());
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    localStorage.setItem('ste-prompt-engineer.theme',${JSON.stringify(theme)});window.__requests=[];
    const nativeFetch=window.fetch;window.fetch=async function(...args){
      const owned=typeof args[0]==='string'&&args[0].includes('/backlog/')&&['POST','DELETE'].includes(args[1]?.method);
      if(owned){window.__requests.push({url:args[0],method:args[1].method,body:JSON.parse(args[1].body)});if(window.__requests.length===1)await new Promise(resolve=>window.__release=resolve);}
      const response=await Reflect.apply(nativeFetch,this,args);
      if(owned&&window.__loseReply){window.__loseReply=false;await response.text();return new Response(JSON.stringify({error:'The completed reply was lost. Check the board.'}),{status:502,headers:{'Content-Type':'application/json'}});}
      if(args[0]==='/api/session'&&${JSON.stringify(older)}){const data=await response.json();delete data.capabilities.pipelineBacklogBulk;return new Response(JSON.stringify(data),{status:response.status,headers:response.headers});}
      return response;
    };` });
  await browser.goto(app.url + '/#/kanban'); await browser.resize(width, 900); await enter(browser, '#view-backlog'); await browser.until('document.querySelectorAll("#backlog-list > li").length===3', 'bulk rows');
  const begin = async () => { await enter(browser, '#backlog-select-visible'); await enter(browser, '#backlog-promote-selected'); await browser.until('window.__requests.length===1&&typeof window.__release==="function"', 'held first promotion'); };
  const finish = async () => { await browser.eval('window.__release();'); await browser.until('document.getElementById("backlog-stop-remaining").hidden', 'bulk settled'); };
  return { app, project, items, exact, browser, begin, finish };
}
for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  test(`bulk promotion retains hidden selection, captured order and exact metadata in ${width}/${theme}`, { skip: !chrome, timeout: 90000 }, async t => {
    const w = await fixture(t, { width, theme }), baseline = await w.app.board.state();
    assert.equal(await w.browser.eval('return innerWidth;'), width); assert.equal(await w.browser.eval("return document.documentElement.dataset.theme||'light';"), theme);
    await w.browser.eval('document.querySelector("#backlog-list input[type=checkbox]").focus();');
    await w.browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    await w.browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    assert.equal(await w.browser.eval('return document.querySelector("#backlog-list input[type=checkbox]").checked;'), true);
    await enter(w.browser, '#backlog-clear-selection'); await enter(w.browser, '#backlog-select-visible'); await select(w.browser, 'board-label-filter', 'label:bug');
    assert.equal(await w.browser.eval('return document.querySelectorAll("#backlog-list > li").length;'), 2);
    assert.equal(await w.browser.eval('return document.getElementById("backlog-promote-selected").textContent;'), 'Add selected to To Do (3)');
    await select(w.browser, 'backlog-sort', 'title'); assert.deepEqual(await w.app.board.state(), baseline, 'Selection/filter/sort do not write saved state.');
    assert.equal(await w.browser.layout('return document.documentElement.scrollWidth<=innerWidth;'), true);
    if (process.env.PB_BROWSER_SHOTS) { await mkdir(process.env.PB_BROWSER_SHOTS, { recursive: true }); await writeFile(join(process.env.PB_BROWSER_SHOTS, `backlog-bulk-${width}-${theme}.png`), await w.browser.screenshot()); }
    await enter(w.browser, '#backlog-promote-selected'); await w.browser.until('window.__requests.length===1&&typeof window.__release==="function"', 'captured promotion');
    assert.equal(await w.browser.eval('return document.getElementById("backlog-promote-selected").disabled&&document.getElementById("backlog-new").disabled;'), true);
    await w.finish();
    const requests = await w.browser.eval('return window.__requests;'); assert.equal(requests.length, 3); assert.deepEqual(requests.map(request => request.body.expectedBacklogRevision), [3, 4, 5]); assert.deepEqual(requests.map(request => request.body.expectedRevision), [1, 1, 1]);
    const state = await w.app.board.state(), owner = state.projects[0]; assert.deepEqual(owner.backlog, []); assert.deepEqual(owner.tasks.map(task => task.id), w.items.map(item => item.id)); assert.deepEqual(owner.tasks.map(task => task.number), [1, 2, 3]);
    for (const [index, task] of owner.tasks.entries()) { assert.equal(task.prompt, w.exact); assert.equal(task.column, 'todo'); assert.equal(task.priority, 4); assert.deepEqual(task.labelIds, w.items[index].labelIds); assert.equal(task.createdAt, w.items[index].createdAt); }
    assert.equal(await w.browser.eval('return document.getElementById("backlog-bulk-progress").textContent;'), '3 completed · 0 need review · 0 not started'); assert.deepEqual(state.runs, []); assert.deepEqual(state.sessions, []); assert.equal(owner.revision, baseline.projects[0].revision);
    assert.deepEqual(w.browser.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);
  });
}

test('bulk deletion confirms captured hidden drafts and refuses a stale selection without deleting or replaying it', { skip: !chrome, timeout: 60000 }, async t => {
  const w = await fixture(t); await enter(w.browser, '#backlog-select-visible'); await select(w.browser, 'board-label-filter', 'label:bug');
  await enter(w.browser, '#backlog-delete-selected'); assert.ok(await w.browser.eval('return document.getElementById("backlog-bulk-confirm-text").textContent.includes("3 selected drafts, including hidden");'));
  await enter(w.browser, '#backlog-bulk-keep'); assert.equal((await w.app.board.state()).projects[0].backlog.length, 3);
  await enter(w.browser, '#backlog-delete-selected'); await w.app.board.updateBacklogItem(w.project.id, w.items[0].id, { title: 'Concurrent edit', expectedRevision: 1 });
  await enter(w.browser, '#backlog-bulk-confirm-delete'); await w.browser.until('window.__requests.length===1', 'held stale delete'); await w.finish();
  let state = await w.app.board.state(); assert.equal(state.projects[0].backlog.length, 3); assert.equal(state.projects[0].backlog[0].title, 'Concurrent edit'); assert.equal(await w.browser.eval('return window.__requests.length;'), 1);
  assert.ok(await w.browser.eval('return document.getElementById("backlog-bulk-progress").textContent.startsWith("0 completed · 1 need review · 2 not started");'));
  await w.browser.until(`document.querySelector('[data-backlog-id="${w.items[0].id}"] .kanban-open')?.textContent==='Concurrent edit'`, 'fresh snapshot before explicit new delete');
  await w.browser.eval('window.__requests=[];window.__release=null;'); await enter(w.browser, '#backlog-delete-selected'); await enter(w.browser, '#backlog-bulk-confirm-delete'); await w.browser.until('window.__requests.length===1&&typeof window.__release==="function"', 'new explicit delete'); await w.finish();
  state = await w.app.board.state(); assert.deepEqual(state.projects[0].backlog, []); assert.deepEqual(state.projects[0].tasks, []); assert.equal(await w.browser.eval('return window.__requests.length;'), 3); assert.deepEqual(state.runs, []);
});

test('Stop remaining finishes the current promotion once and leaves unstarted drafts saved', { skip: !chrome, timeout: 60000 }, async t => {
  const w = await fixture(t); await w.begin(); await enter(w.browser, '#backlog-stop-remaining'); assert.equal(await w.browser.eval('return document.getElementById("backlog-stop-remaining").disabled;'), true); await w.finish();
  const state = await w.app.board.state(); assert.equal(state.projects[0].tasks.length, 1); assert.equal(state.projects[0].backlog.length, 2); assert.equal(await w.browser.eval('return window.__requests.length;'), 1); assert.equal(await w.browser.eval('return document.getElementById("backlog-bulk-progress").textContent;'), '1 completed · 0 need review · 2 not started');
});

test('a lost completed promotion reply is reviewable, never replayed and stops all unstarted requests', { skip: !chrome, timeout: 60000 }, async t => {
  const w = await fixture(t); await w.browser.eval('window.__loseReply=true;'); await w.begin(); await w.finish();
  const state = await w.app.board.state(); assert.equal(state.projects[0].tasks.length, 1); assert.equal(state.projects[0].tasks[0].id, w.items[0].id); assert.equal(state.projects[0].nextTaskNumber, 2); assert.equal(state.projects[0].backlog.length, 2); assert.equal(await w.browser.eval('return window.__requests.length;'), 1);
  assert.ok(await w.browser.eval('return document.getElementById("backlog-bulk-progress").textContent.startsWith("0 completed · 1 need review · 2 not started");')); assert.deepEqual(state.runs, []);
});

test('project changes during a promotion stop remaining requests and cannot modify the newly selected project', { skip: !chrome, timeout: 60000 }, async t => {
  const w = await fixture(t), other = await w.app.board.createProject({ name: 'Other untouched', workflowMode: 'pipeline' }); await w.browser.until(`document.querySelector('#project-select option[value="${other.id}"]')`, 'other project option'); await w.begin(); await select(w.browser, 'project-select', other.id); await w.finish();
  const state = await w.app.board.state(); assert.equal(state.projects[0].tasks.length, 1); assert.equal(state.projects[0].backlog.length, 2); assert.deepEqual(state.projects[1].tasks, []); assert.deepEqual(state.projects[1].backlog, []); assert.equal(await w.browser.eval('return window.__requests.length;'), 1); assert.equal(await w.browser.eval('return document.getElementById("backlog-bulk-results").hidden;'), true);
});

test('older Backlog capability keeps single-draft controls but cannot submit hidden bulk actions', { skip: !chrome, timeout: 60000 }, async t => {
  const w = await fixture(t, { older: true }), baseline = await w.app.board.state(); assert.equal(await w.browser.eval('return document.getElementById("backlog-bulk").hidden;'), true); assert.equal(await w.browser.eval('return document.querySelectorAll("#backlog-list input[type=checkbox]").length;'), 0);
  await w.browser.eval('document.getElementById("backlog-select-visible").click();document.getElementById("backlog-promote-selected").click();'); assert.equal(await w.browser.eval('return window.__requests.length;'), 0); assert.deepEqual(await w.app.board.state(), baseline); assert.ok(await w.browser.eval('return !!document.querySelector("#backlog-list [data-backlog-action=promote]");'));
});
