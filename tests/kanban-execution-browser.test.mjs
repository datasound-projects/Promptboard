// Real Chrome: execution permissions, column types, Full Autopilot and a typed board's Autopilot dialog, at desktop and
// phone widths, operated with the keyboard. Nothing in this test starts an agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const chrome = await findChrome();

test('typed board settings: permissions, column types, the Full Autopilot confirmation and Autopilot without instructions work by keyboard at desktop and phone width', { skip: !chrome, timeout: 150000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const project = await app.board.createProject({ name: 'Typed board', workflowMode: 'pipeline' });
  const first = await app.board.createTask({ projectId: project.id, title: 'First card' });
  const browser = await launch({ width: 1280, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  const ev = code => browser.eval(code), wait = (expression, label) => browser.until(expression, label, 15000);
  // Native button activation needs a character event (the shared raw-key helper is for terminals).
  const enter = async () => {
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  };
  await browser.goto(`${app.url}/#/kanban`);
  await wait(`document.querySelector('[data-id="${first.id}"]')`, 'board');
  // Column Manager opens on its Columns tab; a typed Code Review column is locked read-only (under More options).
  await ev(`document.querySelector('#columns-open').click();`);
  await wait(`document.querySelector('#columns-dialog').open && !document.querySelector('#columns-tabs').hidden && document.querySelector('#columns-execution').hidden`, 'columns tab');
  assert.deepEqual(await ev(`return ['interaction', 'filesystem', 'completion'].map(key => document.querySelector('#execution-' + key).value);`), ['', '', '']);
  await ev(`[...document.querySelectorAll('#columns-list .columns-item')].find(node => node.textContent === 'Code Review').click();`);
  await wait(`document.querySelector('#column-kind')?.value === 'review'`, 'review column');
  assert.equal(await ev(`return document.querySelector('#column-filesystem').disabled && document.querySelector('#column-filesystem').value === 'read_only' && !document.querySelector('[data-section="more"]').open;`), true);
  assert.equal(await ev(`return Boolean(document.querySelector('#column-plan-target'));`), false, 'A typed column has no native plan route.');
  // Keyboard: the How it runs tab shows Step by step (the defaults); Advanced holds every setting.
  await ev(`document.querySelector('#columns-tab-board').focus();`); await enter();
  await wait(`!document.querySelector('#columns-execution').hidden && document.querySelector('#columns-layout').hidden`, 'How it runs tab');
  assert.deepEqual(await ev(`return ['execution-preset', 'execution-step-by-step'].map(id => document.getElementById(id).getAttribute('aria-checked'));`), ['false', 'true']);
  await ev(`document.querySelector('[data-section="advanced"] > summary').focus();`); await enter();
  await wait(`document.querySelector('[data-section="advanced"]').open`, 'advanced open');
  await ev(`document.querySelector('#execution-interaction').focus();`);
  await browser.type('Autonomous'); await browser.key('Tab', 'Tab', 9);
  await wait(`document.querySelector('#execution-interaction').value === 'autonomous' && document.querySelector('.execution-warning')`, 'autonomous chosen by keyboard');
  assert.match(await ev(`return document.querySelector('.execution-warning').textContent;`), /Planning and Code Review stay read-only/);
  await ev(`const select = document.querySelector('#execution-completion'); select.value = 'automatic'; select.dispatchEvent(new Event('change'));`);
  await ev(`document.querySelector('#columns-form').requestSubmit();`);
  await wait(`!document.querySelector('#columns-dialog').open`, 'saved');
  let state = (await app.board.state()).projects[0];
  assert.deepEqual(state.execution, { interaction: 'autonomous', completion: 'automatic' });
  assert.deepEqual((await app.board.state()).runs, [], 'Saving starts nothing.');
  // Without automatic trust answers this is neither mode; Hands-off asks first, then applies the preset.
  await ev(`document.querySelector('#columns-open').click();`);
  await wait(`document.querySelector('#execution-preset')`, 'preset button');
  assert.deepEqual(await ev(`return ['execution-preset', 'execution-step-by-step'].map(id => document.getElementById(id).getAttribute('aria-checked'));`), ['false', 'false']);
  await ev(`document.querySelector('#execution-preset').click();`);
  await wait(`document.activeElement?.id === 'execution-preset-apply'`, 'confirmation focused');
  await enter();
  await wait(`!document.querySelector('#execution-preset-apply') && document.querySelector('#execution-preset')?.getAttribute('aria-checked') === 'true'`, 'preset applied');
  state = (await app.board.state()).projects[0];
  assert.equal(state.execution.workspaceTrust, 'task_workspaces'); assert.equal(state.execution.maxRework, 2);
  assert.deepEqual(state.autopilot.route, ['planning', 'executing', 'code_review', 'testing', 'merge']);
  await ev(`document.querySelector('#columns-cancel').click();`);
  // A typed board's Autopilot needs no column instructions, says it merges, and lists what is still missing.
  await ev(`document.querySelector('#autopilot-open').click();`);
  await wait(`document.querySelector('#autopilot-dialog').open`, 'autopilot dialog');
  assert.equal(await ev(`return document.querySelector('#autopilot-instructions').textContent.includes('needs an instruction');`), false);
  assert.match(await ev(`return document.querySelector('#autopilot-consent-detail').textContent;`), /merges each finished card into/);
  assert.deepEqual(await ev(`return [...document.querySelectorAll('#autopilot-ready .ready-item')].map(item => [item.classList.contains('ok'), item.textContent]);`).then(rows => rows.map(([ok, text]) => [ok, /code folder|test command|hands-off/i.exec(text)?.[0].toLowerCase()])),
    [[false, 'code folder'], [true, 'test command'], [true, 'hands-off']]); // No test command: the Testing agent finds the tests.
  assert.equal(await ev(`return document.querySelector('#autopilot-start').disabled;`), false);
  await ev(`document.querySelector('#autopilot-dialog .dialog-close').click();`);
  // Phone width: the permissions section stays inside the viewport without horizontal scrolling.
  await browser.resize(390, 844);
  await ev(`document.querySelector('#columns-open').click();`);
  await wait(`document.querySelector('#columns-dialog').open`, 'columns at phone width');
  await ev(`document.querySelector('#columns-tab-board').click();`);
  await browser.layout(`const box = document.querySelector('#columns-execution').getBoundingClientRect(); return box.width > 0 && box.right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1;`);
  assert.deepEqual(browser.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);
});
