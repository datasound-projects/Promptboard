import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';
import { defaultPipelineConfig } from '../src/pipeline-config.mjs';
import { resolveConfig } from '../src/agents.mjs';

const chrome = await findChrome();
for (const olderServer of [false, true]) test(`column message editor ${olderServer ? 'preserves unavailable controls on older servers' : 'saves deferred rows and stops pending delivery'} across themes and widths`, { skip: !chrome, timeout: 90000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const { project } = await app.board.createProjectWithRepository({ name: 'Messages UI', folder: 'new' });
  const pipeline = defaultPipelineConfig();
  for (const column of pipeline.columns) if (column.role === 'active') column.strategy.agentOverride = 'claude';
  await app.board.setPipeline(project.id, { pipeline, expectedRevision: project.revision, confirm: true });
  const task = await app.board.createTask({ projectId: project.id, title: 'Exact Composer split', prompt: '  Original\r\n雪' });
  const browser = await launch(); if (!browser) { t.skip('Chrome did not start.'); return; } t.after(() => browser.close());
  if (olderServer) await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    const originalFetch = window.fetch;
    window.fetch = async (...args) => { const response = await originalFetch(...args);
      if (args[0] !== '/api/session') return response;
      const data = await response.json(); delete data.capabilities.pipelineDeferredMessages;
      return new Response(JSON.stringify(data), { status: response.status, headers: response.headers }); };
  ` });
  const enter = async selector => {
    await browser.eval(`const node=document.querySelector(${JSON.stringify(selector)}); node.scrollIntoView({block:'center'}); node.focus();`);
    await browser.send('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
    await browser.send('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  };
  await browser.send('Page.bringToFront'); await browser.goto(`${app.url}/#/kanban`); await browser.until(`document.querySelector('[data-id="${task.id}"]')`, 'task loaded');
  await enter('#columns-open'); await browser.until(`document.getElementById('columns-dialog').open`, 'column editor ready').catch(async error=>{ throw new Error(error.message+' '+JSON.stringify(await browser.eval(`return {focus:document.activeElement.id,columns:[...document.querySelectorAll('.columns-item')].map(node=>node.textContent),errors:document.querySelector('[role=alert]')?.textContent};`))+' '+JSON.stringify(browser.consoleMessages)); });
  await browser.eval(`const button=[...document.querySelectorAll('.columns-item')].find(node=>node.textContent==='Code Review'); button.focus();`); await browser.send('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'}); await browser.send('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await enter('[data-trigger="onEnter"] .automation-add');
  assert.equal(await browser.eval(`return document.querySelector('[data-trigger="onEnter"] [data-field="type"] option[value="send_message"]').disabled;`), olderServer);
  assert.equal(await browser.eval(`return document.querySelector('[data-trigger="onExit"] .automation-add')!==null;`), true);
  if (olderServer) {
    for (const width of [1280, 390]) { await browser.resize(width, 900); for (const theme of ['light', 'dark']) {
      await browser.eval(`document.documentElement.dataset.theme='${theme}';`);
      assert.equal(await browser.eval(`return document.querySelector('[data-trigger="onEnter"] [data-field="type"] option[value="send_message"]').disabled;`), true);
    } }
    assert.equal((await app.board.state()).runs.length, 0); await enter('#columns-close'); return;
  }
  await browser.eval(`const type=document.querySelector('[data-trigger="onEnter"] [data-field="type"]'); type.value='send_message'; type.dispatchEvent(new Event('change',{bubbles:true}));`);
  const literal = 'Review {{taskNumber}} <img src=x onerror="window.__messagePwned=1"> 雪';
  await browser.eval(`const input=document.querySelector('[data-field="message"]'); input.value=${JSON.stringify(literal)}; input.dispatchEvent(new Event('input',{bubbles:true}));`);
  assert.equal(await browser.eval(`return document.querySelector('[data-field="mode"]').value==='deferred' && document.querySelector('[data-field="mode"] option[value="immediate"]').disabled;`), true);
  await browser.eval(`document.getElementById('column-auto-spawn').focus();`); await browser.key(' ', 'Space', 32);
  await browser.until(`document.querySelector('[data-trigger="onEnter"] .automation-row input[type="checkbox"]').disabled`, 'manual-column message off');
  assert.equal(await browser.eval(`return document.querySelector('[data-trigger="onEnter"] .automation-row input[type="checkbox"]').checked;`), false);
  await browser.key(' ', 'Space', 32);
  await browser.until(`!document.querySelector('[data-trigger="onEnter"] .automation-row input[type="checkbox"]').disabled`, 'automatic arrival restores eligibility');
  assert.equal(await browser.eval(`return document.querySelector('[data-field="message"]').value;`), literal);
  for (const width of [1280, 390]) {
    await browser.resize(width, 900);
    for (const theme of ['light', 'dark']) {
      await browser.eval(`document.documentElement.dataset.theme='${theme}'; const input=document.querySelector('[data-field="message"]'); input.scrollIntoView({block:'center'}); input.focus();`);
      assert.equal(await browser.layout(`const r=document.activeElement.getBoundingClientRect(),d=document.getElementById('columns-dialog').getBoundingClientRect(); return d.left>=-1 && d.right<=innerWidth+1 && r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight;`), true);
      if (process.env.PB_BROWSER_SHOTS) { await mkdir(process.env.PB_BROWSER_SHOTS, { recursive: true }); await writeFile(join(process.env.PB_BROWSER_SHOTS, `column-message-${width}-${theme}.png`), await browser.screenshot()); }
    }
  }
  await enter('#columns-form button[type="submit"]'); await browser.until(`!document.getElementById('columns-dialog').open`, 'message saved');
  const saved=(await app.board.state()).projects[0].pipeline.columns.find(column=>column.id==='code_review').automations.onEnter[0];
  assert.equal(saved.message,literal); assert.equal(saved.mode,'deferred'); assert.equal(saved.enabled,true);
  assert.equal((await app.board.state()).runs.length,0);
  const waiting=Promise.withResolvers(); let writes=0;
  app.board.executor = {
    validate: async ({ stage, config })=>resolveConfig(stage,config),
    start: async ({run})=>app.board.updateRun(run.id,{status:'running',providerSessionId:'native-ui-fixture'}),
    sendNativeMessage: async (_id,request)=> { waiting.resolve(); await new Promise(resolve=>{
      request.signal.addEventListener('abort',resolve,{once:true}); if(request.signal.aborted)resolve(); }); return {status:'cancelled',confirmed:false}; },
    cancel: async ()=>{ writes++; },
    subscribe: ()=>()=>{}, artifact: async ()=>'', resize: ()=>{},
  };
  const started=await app.board.transition(task.id,{column:'executing',expectedRevision:task.revision});
  const current=(await app.board.state()).projects[0].tasks[0];
  const moved=await app.board.transition(task.id,{column:'code_review',expectedRevision:current.revision}); await waiting.promise;
  assert.equal(moved.automationMove.status,'completed');
  await browser.until(`document.querySelector('[data-id="${task.id}"] .kanban-stop-automations')`, 'completed placement still offers Stop');
  await enter(`[data-id="${task.id}"] .kanban-stop-automations`);
  await browser.until(`!document.querySelector('[data-id="${task.id}"] .kanban-stop-automations')`, 'pending message stopped');
  assert.equal((await app.board.run(started.run.id)).status,'running'); assert.equal(writes,0);
  await browser.eval(`document.querySelector('[data-id="${task.id}"] .kanban-details').click();`);
  await browser.until(`document.querySelector('.automation-history')?.textContent.includes('Agent message: cancelled')`, 'separate input receipt shown');
  assert.equal(await browser.eval(`return !document.querySelector('.automation-history img') && !window.__messagePwned;`),true);
  assert.equal((await app.board.state()).projects[0].tasks[0].prompt,task.prompt);
  assert.deepEqual(browser.consoleMessages.filter(row=>row.startsWith('EXCEPTION')),[]);
});
