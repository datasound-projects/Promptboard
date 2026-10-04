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

test('delayed usage dialog close events preserve subsequent project settings focus', { skip: !await findChrome(), timeout: 60000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  await app.board.createProject({ name: 'Dialog focus', workflowMode: 'pipeline' });
  const browser = await launch(); assert.ok(browser); t.after(() => browser.close());
  await browser.goto(app.url + '/#/kanban');
  await browser.until(`document.querySelector('#workspace-count').textContent === '01'`, 'project navigation loaded');
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    await browser.resize(width, 844);
    await browser.eval(`document.documentElement.dataset.theme=${JSON.stringify(theme)}; if(innerWidth<=730&&!document.querySelector('#sidebar').classList.contains('open'))document.querySelector('#menu-toggle').click();`);
    assert.equal(await browser.layout(`const sidebar=document.querySelector('#sidebar'),r=sidebar.getBoundingClientRect();return getComputedStyle(sidebar).visibility==='visible' && r.left>=0 && r.right<=innerWidth;`), true, 'The project drawer is painted and visible before focusing its controls.');
    assert.deepEqual(await browser.eval(`return new Promise(resolve => {
      const dialog = document.querySelector('#usage-dialog');
      document.querySelector('#usage-open').click();
      let buttonFocused, actionFocused;
      dialog.addEventListener('close', () => resolve({ buttonFocused, actionFocused, final: document.activeElement.id }), { once: true });
      document.querySelector('#usage-close').click();
      if(document.querySelector('#project-settings').hidden)document.querySelector('#project-toggle').click();
      document.querySelector('#project-settings-close').focus();
      buttonFocused = document.activeElement.id === 'project-settings-close';
      document.querySelector('#project-settings-close').click();
      actionFocused = document.activeElement.id === 'project-toggle';
    });`), { buttonFocused: true, actionFocused: true, final: 'project-toggle' }, `${width}/${theme}: queued close must not steal focus from the next action.`);
    assert.equal(await browser.eval(`return document.querySelector('#project-settings').hidden;`), true);
    assert.equal(await browser.eval(`return new Promise(resolve => {
      const dialog = document.querySelector('#usage-dialog');
      document.querySelector('#usage-open').click();
      dialog.addEventListener('close', () => resolve(document.activeElement.id), { once: true });
      document.querySelector('#usage-close').click();
    });`), 'usage-open', 'Closing normally still returns to Usage.');
    assert.equal(await browser.eval(`return new Promise(resolve => {
      const dialog = document.querySelector('#usage-dialog');
      document.querySelector('#usage-open').click();
      dialog.addEventListener('close', () => resolve(dialog.contains(document.activeElement)), { once: true });
      dialog.close(); dialog.showModal();
    });`), true, 'A stale close event must not take focus out of a reopened modal.');
    await browser.eval(`return new Promise(resolve => { const dialog=document.querySelector('#usage-dialog');dialog.addEventListener('close',resolve,{once:true});dialog.close(); });`);
  }
  assert.deepEqual((await app.board.state()).runs, []);
  assert.deepEqual(browser.consoleMessages.filter(message => message.startsWith('EXCEPTION')), []);
});
