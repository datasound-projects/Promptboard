import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { pickProject, shownProject } from './helpers/projects.mjs';
import { startTestServer } from './helpers/test-server.mjs';
import { defaultPipelineConfig } from '../src/pipeline-config.mjs';

async function fixture(t) {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] }), project = await app.board.createProject({ name: 'Bulk archive' }), pipeline = defaultPipelineConfig();
  for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  await app.board.setPipeline(project.id, { pipeline, expectedRevision: project.revision, confirm: true });
  const tasks = [];
  for (const title of ['One', 'Two', 'Three']) {
    const task = await app.board.createTask({ projectId: project.id, title, prompt: '  Composer 😀\r\n  ' });
    await app.board.transition(task.id, { column: 'done', expectedRevision: task.revision, transitionId: `archive-${task.id}` }); tasks.push(task);
  }
  await app.board.store.update(state => { for (const [index, task] of state.projects[0].tasks.entries()) { task.archivedAt = Date.UTC(2020, 0, index+1); task.revision++; } });
  app.board.executor = { start() { assert.fail('Manual restores must not start agents.'); }, validate() { assert.fail('Stale settings must not probe a provider.'); }, cancel() { assert.fail('These fixtures have no agents to signal.'); } };
  const browser = await launch(); if (!browser) { t.skip('Chrome did not start.'); return null; } t.after(() => browser.close());
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    const nativeFetch=window.fetch; window.__moves=[];
    window.fetch=async function(...args) {
      if(typeof args[0]==='string' && args[0].endsWith('/move') && args[1]?.method==='POST') {
        window.__moves.push({path:args[0],body:JSON.parse(args[1].body)});
        if(window.__moves.length===1) await new Promise(resolve=>window.__releaseMove=resolve);
      }
      const response=await Reflect.apply(nativeFetch,this,args);
      if(window.__loseReply && typeof args[0]==='string' && args[0].endsWith('/move') && window.__moves.length===1) throw new Error('Fixture lost the first reply after the server completed it.');
      return response;
    };
  ` });
  const enter = async selector => { await browser.eval(`const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'center'});n.focus();`);
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); };
  await browser.send('Page.bringToFront'); await browser.goto(`${app.url}/#/kanban`);
  await browser.until(`document.querySelector('.kanban-done-all')`, 'archive loaded'); await enter('.kanban-done-all');
  await browser.until(`document.getElementById('done-dialog').open && document.querySelectorAll('#archive-rows tr').length===3`, 'archive opened');
  const begin = async () => { await enter('#archive-select-visible'); await browser.eval(`document.getElementById('archive-bulk-target').value='executing';`); await enter('#archive-restore-selected'); await browser.until(`window.__moves.length===1 && window.__releaseMove`, 'first restore held'); };
  const finish = async () => { await browser.eval(`window.__releaseMove();`); await browser.until(`document.getElementById('archive-stop-remaining').hidden`, 'bulk finished'); };
  return { app, project, pipeline, tasks, browser, enter, begin, finish };
}

test('bulk restore keeps selection order, reports a stale card separately and never retries or duplicates requests; controls work in both themes and widths', { skip: !await findChrome(), timeout: 90000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const { app, project, tasks, browser, enter } = f;
  await browser.eval(`document.querySelector('#archive-rows input[type="checkbox"]').focus();`); await browser.key(' ', 'Space', 32);
  assert.equal(await browser.eval(`return document.getElementById('archive-restore-selected').textContent;`),'Restore selected (1)');
  await enter('#archive-clear-selection');
  await enter('#archive-select-visible');
  for (const width of [1280, 390]) for (const theme of ['light','dark']) {
    await browser.resize(width, 900); await browser.eval(`document.documentElement.dataset.theme=${JSON.stringify(theme)};const n=document.getElementById('archive-restore-selected');n.scrollIntoView({block:'center'});n.focus();`);
    assert.equal(await browser.layout(`const d=document.getElementById('done-dialog').getBoundingClientRect(),r=document.activeElement.getBoundingClientRect(),b=document.getElementById('archive-bulk');return d.left>=-1&&d.right<=innerWidth+1&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&b.scrollWidth<=b.clientWidth;`), true);
    if(process.env.PB_BROWSER_SHOTS) {await mkdir(process.env.PB_BROWSER_SHOTS,{recursive:true});await writeFile(join(process.env.PB_BROWSER_SHOTS,`bulk-${width}-${theme}.png`),await browser.screenshot());}
  }
  await browser.eval(`const filter=document.getElementById('archive-filter');filter.value='One';filter.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('archive-bulk-target').value='executing';`);
  assert.equal(await browser.eval(`return document.getElementById('archive-restore-selected').textContent;`),'Restore selected (3)');
  await enter('#archive-restore-selected'); await browser.until(`window.__releaseMove`, 'first held');
  await enter('#archive-restore-selected'); assert.equal(await browser.eval(`return window.__moves.length;`), 1);
  const second=(await app.board.state()).projects.find(p=>p.id===project.id).tasks.find(task=>task.id===tasks[1].id);
  await app.board.updateTask(second.id,{title:'Two changed',prompt:second.prompt,expectedRevision:second.revision});
  await f.finish();
  const moves=await browser.eval(`return window.__moves;`); assert.deepEqual(moves.map(move=>move.path),tasks.toReversed().map(task=>`/api/tasks/${task.id}/move`)); assert.equal(new Set(moves.map(move=>move.body.transitionId)).size,3);
  const state=await app.board.state(), cards=state.projects.find(p=>p.id===project.id).tasks;
  assert.equal(cards.find(task=>task.id===tasks[0].id).column,'executing'); assert.equal(cards.find(task=>task.id===tasks[2].id).column,'executing'); assert.equal(cards.find(task=>task.id===tasks[1].id).column,'done');
  assert.ok(cards.every(task=>task.prompt==='  Composer 😀\r\n  ')); assert.deepEqual(state.runs,[]); assert.deepEqual(state.sessions,[]);
  assert.deepEqual(await browser.eval(`return [...document.querySelectorAll('#archive-bulk-results li')].map(n=>n.textContent.split(':')[0]);`),['Three','Two','One']);
  assert.equal(await browser.eval(`return document.getElementById('archive-bulk-progress').textContent;`),'2 restored · 1 need review · 0 not started');
  assert.deepEqual(browser.consoleMessages.filter(message=>message.startsWith('EXCEPTION')),[]);
});

test('Stop remaining leaves the current request to finish and sends none of the unstarted restores', { skip: !await findChrome(), timeout: 90000 }, async t => {
  const f=await fixture(t);if(!f)return;await f.begin();await f.enter('#archive-stop-remaining');
  assert.equal(await f.browser.eval(`return document.getElementById('archive-stop-remaining').disabled&&document.getElementById('archive-stop-remaining').textContent==='Remaining stopped';`),true);
  await f.finish();
  assert.equal(await f.browser.eval(`return window.__moves.length;`),1);
  const tasks=(await f.app.board.state()).projects[0].tasks;assert.equal(tasks.filter(task=>task.column==='executing').length,1);assert.equal(tasks.filter(task=>task.column==='done').length,2);
  assert.equal(await f.browser.eval(`return document.getElementById('archive-bulk-progress').textContent;`),'1 restored · 0 need review · 2 not started');
});

test('changed column settings reject every captured bulk request before provider probes or actions', { skip: !await findChrome(), timeout: 90000 }, async t => {
  const f=await fixture(t);if(!f)return;await f.begin();
  const project=(await f.app.board.state()).projects[0],changed=structuredClone(f.pipeline);changed.columns[2].strategy.autoSpawn=true;
  await f.app.board.setPipeline(project.id,{pipeline:changed,expectedRevision:project.revision,confirm:true});await f.finish();
  assert.equal(await f.browser.eval(`return window.__moves.length;`),3);
  const state=await f.app.board.state();assert.ok(state.projects[0].tasks.every(task=>task.column==='done'));assert.deepEqual(state.runs,[]);
  assert.equal(await f.browser.eval(`return [...document.querySelectorAll('#archive-bulk-results li')].every(n=>n.textContent.includes('board settings changed'));`),true);
});

test('a lost completed reply stays reviewable and is never retried while the other selected tasks restore once', { skip: !await findChrome(), timeout: 90000 }, async t => {
  const f=await fixture(t);if(!f)return;await f.browser.eval(`window.__loseReply=true;`);await f.begin();await f.finish();
  assert.equal(await f.browser.eval(`return window.__moves.length;`),3);
  const state=await f.app.board.state();assert.ok(state.projects[0].tasks.every(task=>task.column==='executing'));assert.deepEqual(state.runs,[]);
  assert.equal(await f.browser.eval(`return document.getElementById('archive-bulk-progress').textContent;`),'2 restored · 1 need review · 0 not started');
});

test('closing a project archive during a request stops unstarted restores and cannot change the newly selected project', { skip: !await findChrome(), timeout: 90000 }, async t => {
  const f=await fixture(t);if(!f)return;await f.begin();
  const other=await f.app.board.createProject({name:'Other project'});
  await f.browser.eval(`await loadBoard();${pickProject(other.id)}`);
  await f.browser.until(`!document.getElementById('done-dialog').open`,'old archive closed');
  await f.browser.eval(`window.__releaseMove();`);await f.browser.until(`!archiveBulkJob.running`,'old request finished');
  const state=await f.app.board.state();assert.deepEqual(state.projects.find(project=>project.id===other.id).tasks,[]);
  assert.equal(state.projects.find(project=>project.id===f.project.id).tasks.filter(task=>task.column==='executing').length,1);
  assert.equal(await f.browser.eval(`return window.__moves.length;`),1);assert.equal(await f.browser.eval(`return ${shownProject};`),other.id);
  assert.deepEqual(state.runs,[]);
});
