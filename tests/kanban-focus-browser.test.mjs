import test from 'node:test';
import assert from 'node:assert/strict';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

test('background board updates retain keyboard focus on the same card action and its open menu', { skip: !await findChrome(), timeout: 60000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const project = await app.board.createProject({ name: 'Card focus', workflowMode: 'pipeline' });
  const task = await app.board.createTask({ projectId: project.id, title: 'Keyboard task', prompt: 'Exact\r\nComposer text' });
  const browser = await launch(); assert.ok(browser); t.after(() => browser.close());
  await browser.goto(app.url + '/#/kanban'); await browser.until(`document.querySelector('[data-id="${task.id}"]')`, 'focus task');
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    await browser.resize(width, 900); await browser.eval(`document.documentElement.dataset.theme=${JSON.stringify(theme)};const item=document.querySelector('[data-id="${task.id}"]');if(item.querySelector('.kanban-more').hidden)item.querySelector('.kanban-more-toggle').click();item.querySelector('.kanban-details').scrollIntoView({block:'center'});item.querySelector('.kanban-details').focus();`);
    const current = (await app.board.state()).projects[0].tasks[0], priority = current.priority === 1 ? 2 : 1;
    await app.board.updateTask(task.id, { priority, expectedRevision: current.revision });
    await browser.until(`document.querySelector('[data-id="${task.id}"] .task-priority')?.textContent===${JSON.stringify(priority === 1 ? 'Low' : 'Medium')}`, 'background revision rendered');
    assert.equal(await browser.eval(`return document.activeElement===document.querySelector('[data-id="${task.id}"] .kanban-details') && !document.querySelector('[data-id="${task.id}"] .kanban-more').hidden;`), true, `${width}/${theme}: card action must retain focus after actual background refresh.`);
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await browser.until(`document.querySelector('#details-pipeline-profile')`, 'focused action opens task settings');
    await browser.eval(`document.getElementById('task-dialog').close();`);
  }
  const saved = (await app.board.state()).projects[0].tasks[0]; assert.equal(saved.prompt, task.prompt); assert.equal(saved.contentRevision, 1);
  assert.deepEqual((await app.board.state()).runs, []); assert.deepEqual(browser.consoleMessages.filter(message => message.startsWith('EXCEPTION')), []);
});
