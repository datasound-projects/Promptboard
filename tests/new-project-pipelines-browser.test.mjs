import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const chrome=await findChrome();
test('new app pipeline exposes seven columns and keyboard title-only To Do creation across themes and widths', {skip:!chrome,timeout:90000}, async t=>{
  const app=await startTestServer(t,{port:0,executor:null,detector:async()=>[]});
  const {token}=await (await fetch(app.url+'/api/session')).json();
  const response=await fetch(app.url+'/api/projects',{method:'POST',headers:{'x-ste-token':token,'content-type':'application/json'},body:JSON.stringify({name:'API default'})});
  assert.equal(response.status,200); const {project}=await response.json(); assert.equal(project.workflowMode,'pipeline');
  const browser=await launch(); if(!browser){t.skip('Chrome did not start.');return;} t.after(()=>browser.close());
  const enter=async selector=>{await browser.eval(`const node=document.querySelector(${JSON.stringify(selector)});node.scrollIntoView({block:'center'});node.focus();`);
    await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
    await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});};
  await browser.send('Page.bringToFront'); await browser.goto(`${app.url}/#/kanban`);
  await browser.until(`document.querySelectorAll('.kanban-column').length===7`,'new pipeline ready');
  await browser.eval(`document.getElementById('workspace-new').click();`);
  await browser.until(`!document.getElementById('project-form').hidden`,'new project form');
  await browser.type('New default'); await enter('#project-form button[type="submit"]');
  await browser.until(`document.querySelector('#workspace-list .current .workspace-name')?.textContent==='New default' && document.getElementById('project-form').hidden`,'new UI pipeline selected');
  assert.deepEqual(await browser.eval(`return [...document.querySelectorAll('.kanban-column')].map(node=>node.dataset.column);`),['todo','planning','executing','code_review','testing','merge','done']);
  await enter('#columns-open'); await browser.until(`document.getElementById('columns-dialog').open`,'column editor');
  assert.equal(await browser.eval(`return document.getElementById('columns-use-pipeline').hidden;`),true); await enter('#columns-close');
  for(const width of [1280,390]) { await browser.resize(width,900); for(const theme of ['light','dark']) {
    await browser.eval(`document.documentElement.dataset.theme='${theme}';`); await enter('#card-new');
    await browser.until(`document.getElementById('card-dialog').open`,'title-only form');
    assert.equal(await browser.eval(`return document.getElementById('card-prompt').required;`),false);
    await browser.eval(`const input=document.getElementById('card-title');input.value='Title ${width} ${theme}';input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();`);
    assert.equal(await browser.layout(`const r=document.activeElement.getBoundingClientRect(),d=document.getElementById('card-dialog').getBoundingClientRect();return d.left>=-1&&d.right<=innerWidth+1&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;`),true);
    if(process.env.PB_BROWSER_SHOTS){await mkdir(process.env.PB_BROWSER_SHOTS,{recursive:true});await writeFile(join(process.env.PB_BROWSER_SHOTS,`new-pipeline-${width}-${theme}.png`),await browser.screenshot());}
    await enter('#card-form button[type="submit"]'); await browser.until(`!document.getElementById('card-dialog').open`,'title-only saved');
  } }
  const state=await app.board.state(), created=state.projects.find(row=>row.name==='New default');
  assert.equal(created.workflowMode,'pipeline'); assert.equal(created.tasks.length,4);
  assert.ok(created.tasks.every(task=>task.column==='todo'&&task.prompt===''&&task.workspace===null));
  assert.deepEqual(state.runs,[]);assert.deepEqual(state.sessions,[]);
  assert.deepEqual(browser.consoleMessages.filter(message=>message.startsWith('EXCEPTION')),[]);
});
