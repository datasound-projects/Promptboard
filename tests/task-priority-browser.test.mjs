import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

test('task priority is editable by keyboard in both themes and narrow Chrome without changing prompt bytes or starting agents', { skip: !await findChrome(), timeout: 90000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const project = await app.board.createProject({ name: 'Priority UI', workflowMode: 'pipeline' });
  const exact = '  Composer 🐕\r\n{{title}}  ';
  const original = await app.board.createTask({ projectId: project.id, title: 'Engineered task', prompt: exact, source: { provider: 'codex', quality: 'reviewed', verification: 'checks-passed' } });
  const archived = await app.board.createTask({ projectId: project.id, title: 'Saved completed priority', priority: 2 });
  await app.board.transition(archived.id, { column: 'done', expectedRevision: archived.revision });
  const browser = await launch(); assert.ok(browser); t.after(() => browser.close());
  const pressEnter = async () => {
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); };
  const enter = async id => { await browser.eval(`const e=document.getElementById(${JSON.stringify(id)});e.scrollIntoView({block:'center'});e.focus();`); await pressEnter(); };
  await browser.send('Page.bringToFront');
  await browser.goto(app.url + '/#/kanban'); await browser.until(`document.querySelector('[data-id="${original.id}"] .kanban-open')`, 'priority card loaded');
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    await browser.resize(width, 900); await browser.eval(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.querySelector('[data-id="${original.id}"] .kanban-open').click();`);
    await browser.until('document.getElementById("card-dialog").open', 'priority editor opened');
    assert.equal(await browser.layout(`const s=document.getElementById('card-priority'),r=s.getBoundingClientRect();return !document.getElementById('card-priority-field').hidden && r.left>=0 && r.right<=innerWidth;`), true);
    assert.deepEqual(await browser.eval(`return [...document.getElementById('card-priority').options].map(o=>o.textContent);`), ['None', 'Low', 'Medium', 'High', 'Urgent']);
    await browser.eval(`document.getElementById('card-priority').value='0';document.getElementById('card-priority').focus();`);
    await browser.type('u');
    await browser.until(`document.getElementById('card-priority').value==='4'`, 'native Urgent type-ahead');
    assert.equal(await browser.eval(`return document.getElementById('card-priority').value;`), '4');
    await enter('card-save'); try { await browser.until('!document.getElementById("card-dialog").open', 'priority saved'); } catch (error) { t.diagnostic(JSON.stringify(await browser.eval("return { active:document.activeElement.id,error:document.getElementById('card-error').textContent,busy:document.getElementById('card-form').getAttribute('aria-busy'),value:document.getElementById('card-priority').value };"))); t.diagnostic(JSON.stringify(browser.consoleMessages)); throw error; }
    await browser.until(`document.querySelector('[data-id="${original.id}"] .task-priority')?.textContent==='Urgent'`, 'urgent badge');
    const task = (await app.board.state()).projects[0].tasks[0]; assert.equal(task.priority, 4); assert.equal(task.prompt, exact); assert.equal(task.contentRevision, 1); assert.equal(task.checksOutdated, false);
    if (process.env.PB_BROWSER_SHOTS) { await mkdir(process.env.PB_BROWSER_SHOTS, { recursive: true }); await writeFile(join(process.env.PB_BROWSER_SHOTS, `priority-${width}-${theme}.png`), await browser.screenshot()); }
    await browser.eval(`document.querySelector('[data-id="${original.id}"] .kanban-open').click();`); await browser.until('document.getElementById("card-dialog").open', 'clear priority editor');
    await browser.eval(`document.getElementById('card-priority').value='0';`); await enter('card-save');
    await browser.until('!document.getElementById("card-dialog").open', 'None saved');
    assert.equal(await browser.eval(`return !!document.querySelector('[data-id="${original.id}"] .task-priority');`), false);
    await browser.eval(`document.querySelector('[data-column="done"] .kanban-done-all').focus();`); await pressEnter();
    await browser.until('document.getElementById("done-dialog").open && document.querySelector("#archive-rows .task-priority")', 'completed priority');
    assert.equal(await browser.eval(`return document.querySelector('#archive-rows .task-priority').getAttribute('aria-label');`), 'Priority: Medium');
    assert.equal(await browser.layout(`const h=document.querySelector('.archive-task-heading');return h.scrollWidth<=h.clientWidth+1;`), true);
    if (process.env.PB_BROWSER_SHOTS) await writeFile(join(process.env.PB_BROWSER_SHOTS, `priority-archive-${width}-${theme}.png`), await browser.screenshot());
    await enter('done-dialog-close'); await browser.until('!document.getElementById("done-dialog").open', 'priority archive closed');
  }
  await enter('card-new'); await browser.until('document.getElementById("card-dialog").open', 'new priority card');
  assert.equal(await browser.eval(`return document.getElementById('card-priority').value;`), '0');
  await browser.type('New high priority'); await browser.eval(`document.getElementById('card-priority').value='3';`); await enter('card-save');
  await browser.until('!document.getElementById("card-dialog").open', 'new priority card saved');
  const created = (await app.board.state()).projects[0].tasks.at(-1); assert.equal(created.priority, 3); assert.equal(created.column, 'todo'); assert.equal(created.prompt, '');
  assert.deepEqual((await app.board.state()).runs, []); assert.deepEqual((await app.board.state()).sessions, []);
  assert.deepEqual(browser.consoleMessages.filter(message=>message.startsWith('EXCEPTION')), []);
});
