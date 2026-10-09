import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';
import { defaultPipelineConfig } from '../src/pipeline-config.mjs';
import { attachSession } from '../src/sessions.mjs';

test('pipeline completed table sorts archive dates, filters literal titles and shows exact latest usage without running agents; keyboard restore retains context', { skip: !await findChrome(), timeout: 90000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] }), pipeline = defaultPipelineConfig();
  for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  pipeline.columns.find(column => column.role === 'done').id = 'finished';
  const project = await app.board.createProject({ name: 'Archived pipeline' }), legacy = await app.board.createProject({ name: 'Legacy archive' });
  await app.board.setPipeline(project.id, { pipeline, expectedRevision: project.revision, confirm: true });
  const tasks = [];
  for (const title of ['Zulu', 'Alpha <img src=x onerror="window.__archivePwned=1">', 'Middle', 'Empty']) {
    const task = await app.board.createTask({ projectId: project.id, title, prompt: 'Exact source\r\n' });
    await app.board.transition(task.id, { column: 'finished', expectedRevision: task.revision, transitionId: `archive-${task.id}` }); tasks.push(task);
  }
  await app.board.createTask({ projectId: project.id, title: 'Unfinished', prompt: 'To Do' });
  const old = await app.board.createTask({ projectId: legacy.id, title: 'Legacy completed', prompt: 'Required body' });
  await app.board.store.update(state => {
    for (const [index, task] of state.projects.find(p => p.id === project.id).tasks.entries()) {
      if (task.column !== 'finished') continue;
      task.archivedAt = Date.UTC(2020, 0, index + 1); task.updatedAt = index === 0 ? Date.UTC(2040, 0, 1) : task.archivedAt; task.revision++;
    }
    state.projects.find(p => p.id === legacy.id).tasks[0].column = 'done';
    const run = { id: 'archive-run-one', taskId: tasks[0].id, projectId: project.id, stage: 'executing', status: 'suspended', createdAt: 1,
      config: { provider: 'claude', model: 'fixture', pipeline: true }, providerSessionId: 'archive-native', usage: { inputTokens: 10, cachedTokens: 5, outputTokens: 2 } };
    state.runs.push(run); const session = attachSession(state, run, 'archive-session');
    const resumed = { ...run, id: 'archive-run-two', createdAt: 2, usage: { inputTokens: 20, cachedTokens: 10, outputTokens: 4 } };
    state.runs.push(resumed); session.runIds.push(resumed.id); session.currentRunId = resumed.id;
    state.runs.push({ ...run, id: 'partial-usage', taskId: tasks[2].id, sessionId: undefined, usage: { inputTokens: 0, outputTokens: 0 } });
  });
  const before = structuredClone(await app.board.state());
  const browser = await launch(); if (!browser) { t.skip('Chrome did not start.'); return; } t.after(() => browser.close());
  const enter = async selector => { await browser.eval(`const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'center'});n.focus();`);
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); };
  await browser.send('Page.bringToFront'); await browser.goto(`${app.url}/#/kanban`);
  await browser.until(`document.querySelector('[data-column="finished"] .kanban-done-all')`, 'completed column');
  assert.equal(await browser.eval(`return document.querySelector('.kanban-done-drop').textContent.includes('archives the task') && !document.querySelector('.kanban-done-drop').textContent.includes('Testing or Merge');`), true);
  await enter('[data-column="finished"] .kanban-done-all'); await browser.until(`document.getElementById('done-dialog').open && document.querySelectorAll('#archive-rows tr').length===4`, 'archive table');
  const ids = () => browser.eval(`return [...document.querySelectorAll('#archive-rows tr')].map(row=>row.dataset.archiveTask);`);
  assert.deepEqual(await ids(), tasks.toReversed().map(task => task.id));
  assert.equal(await browser.eval(`return document.querySelector('[data-archive-task="${tasks[0].id}"] td:last-child').textContent;`), 'Input 20 · Cached 10 · Output 4');
  assert.equal(await browser.eval(`return document.querySelector('[data-archive-task="${tasks[1].id}"] td:last-child').textContent;`), 'Unavailable');
  assert.equal(await browser.eval(`return document.querySelector('[data-archive-task="${tasks[2].id}"] td:last-child').textContent;`), 'Unavailable');
  assert.equal(await browser.eval(`return document.querySelector('#archive-rows img')===null && !window.__archivePwned;`), true);
  await enter('#archive-sort-date');
  assert.deepEqual(await ids(), tasks.map(task => task.id));
  assert.equal(await browser.eval(`return document.getElementById('archive-date-header').getAttribute('aria-sort');`), 'ascending');
  await enter('#archive-sort-title');
  assert.deepEqual(await ids(), [tasks[1].id, tasks[3].id, tasks[2].id, tasks[0].id]);
  await enter('#archive-sort-title'); assert.deepEqual(await ids(), [tasks[0].id, tasks[2].id, tasks[3].id, tasks[1].id]);
  assert.equal(await browser.eval(`return document.getElementById('archive-title-header').getAttribute('aria-sort');`), 'descending');
  await enter('#archive-sort-title'); await browser.eval(`document.getElementById('archive-filter').focus();`);
  await browser.type(' alpha '); await browser.until(`document.querySelectorAll('#archive-rows tr').length===1`, 'literal title filter');
  assert.deepEqual(await ids(), [tasks[1].id]); assert.equal(await browser.eval(`return document.activeElement.id;`), 'archive-filter');
  await browser.eval(`const input=document.getElementById('archive-filter');input.value='No match';input.dispatchEvent(new Event('input',{bubbles:true}));`);
  assert.equal(await browser.eval(`return !document.getElementById('archive-empty').hidden && document.getElementById('archive-count').textContent==='0 of 4 tasks';`), true);
  await browser.eval(`const input=document.getElementById('archive-filter');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));`);
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    await browser.resize(width, 900); await browser.eval(`document.documentElement.dataset.theme=${JSON.stringify(theme)};const n=document.querySelector('.archive-table-scroll');n.scrollIntoView({block:'center'});n.focus();`);
    assert.equal(await browser.layout(`const d=document.getElementById('done-dialog').getBoundingClientRect(),r=document.querySelector('.archive-table-scroll').getBoundingClientRect();return document.activeElement.className==='archive-table-scroll' && d.left>=-1 && d.right<=innerWidth+1 && r.left>=0 && r.right<=innerWidth && document.querySelector('.archive-table-scroll').scrollWidth>=document.querySelector('.archive-table-scroll').clientWidth;`), true);
    assert.equal(await browser.layout(`return [...document.querySelectorAll('.archive-title')].every(button=>button.getBoundingClientRect().width<=button.closest('td').getBoundingClientRect().width && button.scrollWidth<=button.clientWidth+1) && (innerWidth<720 || document.querySelector('.archive-table-scroll').scrollWidth<=document.querySelector('.archive-table-scroll').clientWidth+1);`), true);
    if (process.env.PB_BROWSER_SHOTS) { await mkdir(process.env.PB_BROWSER_SHOTS, { recursive: true }); await writeFile(join(process.env.PB_BROWSER_SHOTS, `archive-${width}-${theme}.png`), await browser.screenshot()); }
  }
  assert.deepEqual(await app.board.state(), before, 'Opening, sorting and filtering must change no task, session or run.');
  await browser.eval(`const input=document.getElementById('archive-filter');input.value='Middle';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-archive-action="details"]').focus();`);
  // An already-running refresh can legitimately hold the previous board revision.
  // Capture that case explicitly; awaiting its coalesced promise is not a new read.
  await browser.eval(`window.__archiveFetch=window.fetch;window.__archiveHoldNext=true;window.fetch=async (...args)=>{
    const response=await window.__archiveFetch(...args);
    if(window.__archiveHoldNext&&String(args[0]).endsWith('/api/board')){
      window.__archiveHoldNext=false;window.__archiveHeld=true;await new Promise(resolve=>window.__archiveRelease=resolve);
    }return response;
  };window.__archiveRead=loadBoard();`);
  await browser.until(`window.__archiveHeld===true`, 'captured earlier board read');
  const middle = (await app.board.state()).projects.find(p=>p.id===project.id).tasks.find(task=>task.id===tasks[2].id);
  await app.board.updateTask(middle.id, { title: 'Middle edited', prompt: middle.prompt, expectedRevision: middle.revision });
  // Read the title in the same task as the held read; the app's 2 s poll may render the newer board right after.
  assert.equal(await browser.eval(`window.__archiveRelease();await window.__archiveRead;const title=document.querySelector('.archive-title').textContent;window.fetch=window.__archiveFetch;return title;`), 'Middle', 'The earlier read cannot include the later server edit.');
  await browser.until(`(async()=>{await loadBoard();return document.querySelector('.archive-title')?.textContent==='Middle edited';})()`, 'edited archive revision rendered');
  assert.equal(await browser.eval(`return document.getElementById('archive-filter').value==='Middle' && document.getElementById('archive-sort').value==='title' && document.activeElement.dataset.archiveAction==='details' && document.activeElement.closest('tr').dataset.archiveTask===${JSON.stringify(middle.id)} && document.querySelector('.archive-title').textContent==='Middle edited';`), true);
  await browser.eval(`const input=document.getElementById('archive-filter');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));`);
  await browser.eval(`const restore=document.querySelector('[data-archive-task="${tasks[0].id}"] select');restore.value='executing';restore.dispatchEvent(new Event('change',{bubbles:true}));`);
  await browser.until(`document.querySelector('[data-column="executing"] [data-id="${tasks[0].id}"]')`, 'manual column restoration');
  const after = await app.board.state(), restored = after.projects.find(p=>p.id===project.id).tasks.find(task=>task.id===tasks[0].id);
  assert.equal(restored.sessionId, 'archive-session'); assert.equal(restored.archivedAt, undefined); assert.equal(after.sessions.find(session=>session.id==='archive-session').nativeSessionId, 'archive-native'); assert.equal(after.runs.length, before.runs.length);
  await enter('[data-column="finished"] .kanban-done-all');
  await enter('#archive-cards');
  assert.equal(await browser.eval(`return !document.getElementById('done-dialog-list').hidden && document.getElementById('pipeline-archive').hidden && document.activeElement.classList.contains('kanban-open') && document.querySelector('#done-dialog-list .kanban-copy') && document.querySelector('#done-dialog-list .kanban-duplicate') && document.querySelector('#done-dialog-list .kanban-delete') ? true : false;`), true);
  await browser.eval(`const select=document.getElementById('project-select');select.value=${JSON.stringify(legacy.id)};select.dispatchEvent(new Event('change',{bubbles:true}));`);
  await browser.until(`!document.getElementById('done-dialog').open`, 'old project archive closed');
  await browser.until(`document.querySelector('[data-id="${old.id}"]')`, 'legacy project selected'); await enter('.kanban-done-all');
  assert.equal(await browser.eval(`return !document.getElementById('done-dialog-list').hidden && document.getElementById('pipeline-archive').hidden;`), true);
  assert.deepEqual(browser.consoleMessages.filter(message=>message.startsWith('EXCEPTION')), []);
});
