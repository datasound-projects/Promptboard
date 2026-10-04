import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';
import { defaultPipelineConfig } from '../src/pipeline-config.mjs';

const chrome = await findChrome();
test('Notify me editing, explicit permission, display receipts and task clicks work by keyboard across themes and widths', { skip: !chrome, timeout: 90000 }, async t => {
  t.diagnostic('Notification fixture starting.');
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] }), config = defaultPipelineConfig();
  for (const column of config.columns) column.strategy.autoSpawn = false;
  const other = await app.board.createProject({ name: 'Other project' }), project = await app.board.createProject({ name: 'Notification project' });
  await app.board.setPipeline(project.id, { pipeline: config, expectedRevision: 1, confirm: true });
  const task = await app.board.createTask({ projectId: project.id, title: 'Literal <img src=x>', prompt: '  Exact Composer split\r\n' });
  t.diagnostic('Notification board fixture ready.');
  const browser = await launch({ width: 1280, height: 900 }); if (!browser) { t.skip('Chrome did not start.'); return; } t.after(() => browser.close());
  t.diagnostic('Notification browser ready.');
  // Replace the API before any page scripts execute: no real OS alerts or permission dialogs.
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__alerts=[]; window.__permissionRequests=0;
    class FakeNotification {
      static permission='default'; static async requestPermission(){window.__permissionRequests++; return this.permission='granted';}
      constructor(title,options){this.title=title;this.options=options;this.closed=false;window.__alerts.push(this);}
      close(){this.closed=true; this.onclose?.();}
    }
    Object.defineProperty(window,'Notification',{value:FakeNotification,configurable:true});
  ` });
  const enter = async () => { await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); };
  await browser.goto(`${app.url}/#/kanban`); await browser.until(`document.querySelector('#project-select option[value="${project.id}"]')`, 'projects loaded'); await browser.send('Page.bringToFront');
  t.diagnostic('Notification page loaded.');
  await browser.eval(`const select=document.querySelector('#project-select');select.value='${project.id}';select.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#columns-open').focus();`); await enter();
  await browser.until(`document.querySelector('#columns-dialog').open`, 'columns opened');
  await browser.eval(`[...document.querySelectorAll('.columns-item')].find(button=>button.textContent==='Executing').click(); document.querySelector('[data-trigger="onEnter"] .automation-add').focus();`); await enter();
  await browser.eval(`const type=document.querySelector('.automation-row [data-field="type"]'); type.value='notify';type.dispatchEvent(new Event('change',{bubbles:true}));`);
  for (const width of [1280, 390]) {
    await browser.resize(width, 900);
    for (const theme of ['light', 'dark']) {
      await browser.eval(`document.documentElement.dataset.theme='${theme}';const input=document.querySelector('[data-field="body"]');input.scrollIntoView({block:'center'});input.focus();`);
      assert.equal(await browser.layout(`const r=document.activeElement.getBoundingClientRect(),d=document.querySelector('#columns-dialog').getBoundingClientRect(); return document.activeElement.dataset.field==='body' && r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight && d.left>=-1 && d.right<=innerWidth+1;`), true);
      if (process.env.PB_BROWSER_SHOTS) { await mkdir(process.env.PB_BROWSER_SHOTS, { recursive: true }); await writeFile(join(process.env.PB_BROWSER_SHOTS, `pipeline-notify-editor-${width}-${theme}.png`), await browser.screenshot()); }
    }
  }
  await browser.eval(`const name=document.querySelector('.automation-row [data-field="name"]');name.value='Arrived';name.dispatchEvent(new Event('input',{bubbles:true}));const body=document.querySelector('[data-field="body"]');body.value='{{projectName}} · {{toColumn}}';body.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#columns-form button[type="submit"]').click();`);
  await browser.until(`!document.querySelector('#columns-dialog').open`, 'notification definition saved');
  t.diagnostic('Notification definition saved after both theme/viewport checks.');
  assert.equal(await browser.eval(`return window.__alerts.length+window.__permissionRequests;`), 0); assert.equal((await app.board.automationRuns(task.id)).length, 0);
  await browser.eval(`document.querySelector('#app-settings-open').focus();`); await enter(); await browser.until(`document.querySelector('#app-settings').open`, 'settings opened');
  for (const width of [1280, 390]) {
    await browser.resize(width, 900);
    for (const theme of ['light', 'dark']) {
      await browser.eval(`document.documentElement.dataset.theme='${theme}';const button=document.querySelector('#set-notifications-enable');button.scrollIntoView({block:'center'});button.focus();`);
      assert.equal(await browser.layout(`const r=document.activeElement.getBoundingClientRect(),d=document.querySelector('#app-settings').getBoundingClientRect();return document.activeElement.id==='set-notifications-enable' && r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight && d.left>=-1 && d.right<=innerWidth+1;`), true);
      if (process.env.PB_BROWSER_SHOTS) await writeFile(join(process.env.PB_BROWSER_SHOTS, `pipeline-notify-settings-${width}-${theme}.png`), await browser.screenshot());
    }
  }
  await enter(); await browser.until(`document.querySelector('#set-notifications-status').textContent.startsWith('Connected.')`, 'explicit opt-in receiver connected'); assert.equal(await browser.eval(`return window.__permissionRequests;`), 1);
  await browser.eval(`document.querySelector('#app-settings-close').click();const select=document.querySelector('#project-select');select.value='${other.id}';select.dispatchEvent(new Event('change',{bubbles:true}));`);
  t.diagnostic('Notification permission and receiver connected.');
  const moving = app.board.transition(task.id, { column: 'executing', expectedRevision: 1 });
  await browser.until(`window.__alerts.length===1`, 'mock native notification constructed');
  let completed = false; moving.then(() => { completed = true; }); assert.equal(completed, false);
  assert.equal(await browser.eval(`return window.__alerts[0].title;`), task.title); assert.equal(await browser.eval(`return window.__alerts[0].options.body;`), 'Notification project · Executing');
  t.diagnostic('First notification constructed; acknowledging display.');
  await browser.eval(`window.__alerts[0].onshow();`); await moving;
  t.diagnostic('First notification move and display receipt completed.');
  assert.equal((await app.board.automationRuns(task.id))[0].actions[0].status, 'succeeded');
  await browser.eval(`window.__alerts[0].onclick();`);
  await browser.until(`document.querySelector('#task-dialog').open && document.querySelector('#task-dialog').dataset.taskId==='${task.id}'`, 'alert opened exact task in its project');
  assert.equal(await browser.eval(`return document.querySelector('#project-select').value;`), project.id);
  assert.equal(await browser.eval(`return document.querySelector('#task-dialog-heading').textContent;`), task.title);
  assert.equal(await browser.eval(`return document.querySelector('#task-dialog img')===null && window.__alerts[0].closed;`), true);
  t.diagnostic('Notification click opened the exact task.');
  const removed = await app.board.createTask({ projectId: project.id, title: 'Removed alert task', prompt: 'Exact removed task' });
  const removedMove = app.board.transition(removed.id, { column: 'executing', expectedRevision: 1 });
  await browser.until(`window.__alerts.length===2`, 'second owned alert received'); await browser.eval(`window.__alerts[1].onshow();`); await removedMove;
  t.diagnostic('Second notification move and receipt completed.');
  await app.board.deleteTask(removed.id, { expectedRevision: (await app.board.state()).projects.find(p=>p.id===project.id).tasks.find(card=>card.id===removed.id).revision });
  await browser.eval(`window.__alerts[1].onclick();`);
  await browser.until(`document.querySelector('#announcement').textContent.includes('notification task is no longer available')`, 'removed task announced without side effects');
  await browser.eval(`document.querySelector('#task-dialog').close();document.querySelector('#app-settings-open').click();`);
  await browser.until(`document.querySelector('#app-settings').open`, 'settings reopened');
  await browser.eval(`const button=document.querySelector('#set-notifications-disable');button.scrollIntoView({block:'center'});button.focus();`); await enter();
  await browser.until(`document.querySelector('#set-notifications-status').textContent.includes('off for this browser')`, 'notification opt-out');
  assert.equal(await browser.eval(`return localStorage.getItem('promptboard:browser-notifications');`), '0');
  await browser.eval(`document.querySelector('#set-notifications-enable').click();`);
  await browser.until(`document.querySelector('#set-notifications-status').textContent.startsWith('Connected.')`, 'explicit reconnect without another permission prompt');
  assert.equal(await browser.eval(`return window.__permissionRequests;`), 1);
  await browser.eval(`window.dispatchEvent(new StorageEvent('storage',{key:'promptboard:browser-notifications',newValue:'0'}));`);
  await browser.until(`document.querySelector('#set-notifications-status').textContent.includes('off for this browser')`, 'other window opt-out revokes receiver');
  t.diagnostic('Notification opt-out/reconnect/storage revocation completed.');
  const saved = (await app.board.state()).projects.find(p=>p.id===project.id); assert.equal(saved.tasks[0].prompt, task.prompt); assert.deepEqual((await app.board.state()).runs, []);
  assert.ok(!browser.consoleMessages.some(message=>message.startsWith('EXCEPTION')),browser.consoleMessages.join('\n'));
  t.diagnostic('Notification assertions completed; owned cleanup follows.');
});
