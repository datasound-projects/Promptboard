import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';
import { defaultPipelineConfig } from '../src/pipeline-config.mjs';
const chrome = await findChrome();
const exact = '  Engineered 雪\r\n{{title}}\r\n  ';
async function enter(browser, selector) {
  await browser.until(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e&&!e.disabled&&e.getClientRects().length>0;})()`, 'available column-promotion keyboard target');
  await browser.eval(`const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});e.focus();`);
  assert.equal(await browser.eval(`return document.activeElement===document.querySelector(${JSON.stringify(selector)});`), true);
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}
const select = (browser, value) => browser.eval(`const e=document.getElementById('backlog-target');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));`);
async function fixture(t, { width = 1280, theme = 'light', older = false, autoSpawn = false, held = false } = {}) {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const project = await app.board.createProject({ name: 'Column choices', workflowMode: 'pipeline' });
  const config = defaultPipelineConfig(); for (const column of config.columns) column.strategy.autoSpawn = autoSpawn;
  await app.board.setPipeline(project.id, { pipeline: config, expectedRevision: project.revision, confirm: true });
  const items = [];
  for (const title of ['First draft', 'Second draft']) items.push(await app.board.createBacklogItem(project.id, { title, prompt: exact, priority: 3, expectedLabelRevision: 0, expectedBacklogRevision: items.length }));
  const card = await app.board.createTask({ projectId: project.id, title: 'Composer To Do', prompt: exact });
  const browser = await launch({ width, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('ste-prompt-engineer.theme',${JSON.stringify(theme)});window.__requests=[];window.__release=null;const nativeFetch=window.fetch;window.fetch=async function(...args){
    if(args[1]?.method==='POST'&&(String(args[0]).endsWith('/promote')||String(args[0]).endsWith('/promote-to-column'))){window.__requests.push({url:args[0],body:JSON.parse(args[1].body)});if(${held}&&window.__requests.length===1)await new Promise(resolve=>window.__release=resolve);}
    const r=await Reflect.apply(nativeFetch,this,args);if(${older}&&args[0]==='/api/session'){const d=await r.json();delete d.capabilities.pipelineBacklogColumns;return new Response(JSON.stringify(d),{status:r.status,headers:r.headers});}return r;};` });
  await browser.goto(app.url + '/#/kanban'); await browser.resize(width, 900); await enter(browser, '#view-backlog');
  await browser.until('document.querySelectorAll("#backlog-list > li").length===2', 'column draft rows');
  return { app, project, items, card, browser };
}
for (const width of [1280, 390]) for (const theme of ['light', 'dark']) test(`chosen-column single/manual and bulk/Done promotion preserve exact drafts in ${width}/${theme}`, { skip: !chrome, timeout: 90000 }, async t => {
  const w = await fixture(t, { width, theme }), before = await w.app.board.state();
  assert.equal(await w.browser.eval('return innerWidth;'), width); assert.equal(await w.browser.eval("return document.documentElement.dataset.theme||'light';"), theme);
  await w.browser.eval('document.getElementById("backlog-target").focus();'); await w.browser.type('Code Review');
  await w.browser.key('Tab', 'Tab', 9);
  assert.equal(await w.browser.eval('return document.getElementById("backlog-target").value;'), 'code_review');
  assert.deepEqual(await w.app.board.state(), before, 'Choosing a column is inert.');
  if (width === 390) assert.equal(await w.browser.layout('const o=document.getElementById("backlog-sort").getBoundingClientRect(),d=document.getElementById("backlog-target").getBoundingClientRect();return o.width>0&&d.width>0&&Math.abs(o.top-d.top)<1;'), true, 'Phone order and destination controls share one row.');
  assert.equal(await w.browser.layout('const r=document.getElementById("backlog-target").getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth&&document.documentElement.scrollWidth<=innerWidth;'), true);
  if (process.env.PB_BROWSER_SHOTS) { await mkdir(process.env.PB_BROWSER_SHOTS, { recursive: true }); await writeFile(join(process.env.PB_BROWSER_SHOTS, `backlog-columns-${width}-${theme}.png`), await w.browser.screenshot()); }
  await enter(w.browser, `[data-backlog-id="${w.items[0].id}"] [data-backlog-action=promote]`);
  await w.browser.until(`!document.querySelector('[data-backlog-id="${w.items[0].id}"]')&&!document.getElementById('backlog-new').disabled`, 'single manual-column arrival');
  let state = await w.app.board.state(), owner = state.projects[0], task = owner.tasks.find(row => row.id === w.items[0].id);
  assert.equal(task.column, 'code_review'); assert.equal(task.prompt, exact); assert.equal(task.createdAt, w.items[0].createdAt); assert.equal(task.priority, 3); assert.equal(task.number, 2);
  const request = await w.browser.eval('return window.__requests[0];'); assert.ok(request.url.endsWith('/promote-to-column')); assert.equal(request.body.column, 'code_review'); assert.equal(request.body.expectedProjectRevision, before.projects[0].revision);
  await select(w.browser, 'done'); await enter(w.browser, '#backlog-select-visible'); await enter(w.browser, '#backlog-promote-selected');
  await w.browser.until('document.getElementById("backlog-stop-remaining").hidden&&document.querySelectorAll("#backlog-list > li").length===0', 'bulk Done arrival');
  state = await w.app.board.state(); owner = state.projects[0]; task = owner.tasks.find(row => row.id === w.items[1].id);
  assert.equal(task.column, 'done'); assert.ok(task.archivedAt); assert.equal(task.prompt, exact); assert.equal(task.number, 3);
  assert.equal(owner.tasks.find(row => row.id === w.card.id).column, 'todo'); assert.equal(owner.tasks.find(row => row.id === w.card.id).prompt, exact);
  assert.deepEqual(state.runs, []); assert.deepEqual(state.sessions, []); assert.equal(await w.browser.eval('return window.__requests.length;'), 2);
  assert.deepEqual(w.browser.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);
});

test('failed auto-spawn arrival keeps its published card, reports review and stops remaining bulk drafts', { skip: !chrome, timeout: 60000 }, async t => {
  const w = await fixture(t, { autoSpawn: true }); await select(w.browser, 'executing'); await enter(w.browser, '#backlog-select-visible'); await enter(w.browser, '#backlog-promote-selected');
  await w.browser.until('document.getElementById("backlog-stop-remaining").hidden&&document.getElementById("backlog-bulk-progress").textContent.includes("1 need review")', 'failed arrival review');
  const state = await w.app.board.state(), owner = state.projects[0];
  assert.equal(owner.tasks.find(row => row.id === w.items[0].id).column, 'todo'); assert.equal(owner.tasks.find(row => row.id === w.items[0].id).prompt, exact);
  assert.deepEqual(owner.backlog.map(row => row.id), [w.items[1].id]); assert.equal(owner.nextTaskNumber, 3); assert.deepEqual(state.runs, []);
  assert.equal(await w.browser.eval('return window.__requests.length;'), 1); assert.ok(await w.browser.eval('return document.getElementById("backlog-bulk-results").textContent.includes("Card added to the board; column arrival failed");'));
  await select(w.browser, 'code_review'); assert.equal(await w.browser.eval('return window.__requests.length;'), 1, 'Changing a choice never replays a failed arrival.');
});

test('a bulk batch retains its captured destination when the disabled select is changed programmatically', { skip: !chrome, timeout: 60000 }, async t => {
  const w = await fixture(t, { held: true }); await select(w.browser, 'code_review'); await enter(w.browser, '#backlog-select-visible'); await enter(w.browser, '#backlog-promote-selected');
  await w.browser.until('window.__requests.length===1&&typeof window.__release==="function"', 'held captured destination');
  assert.equal(await w.browser.eval('return document.getElementById("backlog-target").disabled;'), true);
  await select(w.browser, 'done'); await w.browser.eval('window.__release();');
  await w.browser.until('document.getElementById("backlog-stop-remaining").hidden', 'captured batch settled');
  const requests = await w.browser.eval('return window.__requests;'); assert.equal(requests.length, 2); assert.deepEqual(requests.map(row => row.body.column), ['code_review', 'code_review']);
  const owner = (await w.app.board.state()).projects[0]; assert.ok(w.items.every(item => owner.tasks.find(row => row.id === item.id)?.column === 'code_review')); assert.deepEqual(owner.backlog, []);
});

test('older servers hide destination controls and preserve existing To Do promotion', { skip: !chrome, timeout: 60000 }, async t => {
  const w = await fixture(t, { older: true }), before = await w.app.board.state();
  assert.equal(await w.browser.eval('return document.getElementById("backlog-target-field").hidden;'), true); await select(w.browser, 'executing'); assert.deepEqual(await w.app.board.state(), before);
  await enter(w.browser, `[data-backlog-id="${w.items[0].id}"] [data-backlog-action=promote]`); await w.browser.until(`!document.querySelector('[data-backlog-id="${w.items[0].id}"]')`, 'old capability To Do promotion');
  const request = await w.browser.eval('return window.__requests[0];'); assert.ok(request.url.endsWith('/promote')); assert.equal(request.body.column, undefined);
  assert.equal((await w.app.board.state()).projects[0].tasks.find(row => row.id === w.items[0].id).column, 'todo'); assert.deepEqual((await w.app.board.state()).runs, []);
});

test('unrelated refresh retains a focused destination choice before it is committed', { skip: !chrome, timeout: 60000 }, async t => {
  const w = await fixture(t), before = await w.app.board.state();
  assert.equal(await w.browser.eval('const e=document.getElementById("backlog-target");e.focus();e.value="code_review";renderBoard();return document.activeElement===e&&e.value==="code_review";'), true);
  assert.deepEqual(await w.app.board.state(), before); assert.equal(await w.browser.eval('return window.__requests.length;'), 0);
  await w.browser.eval('document.getElementById("backlog-target").dispatchEvent(new Event("change",{bubbles:true}));');
  assert.ok(await w.browser.eval('return document.querySelector("[data-backlog-action=promote]").textContent.includes("Code Review");'));
});

test('long renamed destination labels stay literal and within the phone viewport', { skip: !chrome, timeout: 60000 }, async t => {
  const w = await fixture(t, { width: 390 }), before = (await w.app.board.state()).projects[0], name = 'X'.repeat(60);
  const config = structuredClone(before.pipeline); config.columns.find(column => column.id === 'code_review').name = name;
  await w.app.board.setPipeline(w.project.id, { pipeline: config, expectedRevision: before.revision, confirm: true });
  await w.browser.until(`document.querySelector('#backlog-target option[value=code_review]')?.textContent===${JSON.stringify(name)}`, 'renamed destination choices');
  await select(w.browser, 'code_review'); await enter(w.browser, '#backlog-select-visible');
  assert.ok(await w.browser.eval(`return document.getElementById('backlog-promote-selected').textContent.includes(${JSON.stringify(name)});`));
  assert.equal(await w.browser.layout('return document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll("[data-backlog-action=promote],#backlog-promote-selected")].every(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth;});'), true);
  assert.equal(await w.browser.eval('return window.__requests.length;'), 0); assert.deepEqual((await w.app.board.state()).runs, []);
});
