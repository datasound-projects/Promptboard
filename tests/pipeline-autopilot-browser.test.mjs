import test from 'node:test';
import assert from 'node:assert/strict';
import { customPipelineConfig } from './helpers/pipeline.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const chrome = await findChrome();

test('the Autopilot button sits next to Columns on a pipeline board and sets up columns, instructions and the queue', { skip: !chrome, timeout: 120000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const project = await app.board.createProject({ name: 'Pipeline board', workflowMode: 'pipeline' });
  // Custom columns: one conversation continues, so each later column needs an instruction.
  await app.board.setPipeline(project.id, { pipeline: customPipelineConfig(), expectedRevision: project.revision });
  const first = await app.board.createTask({ projectId: project.id, title: 'First card' }), second = await app.board.createTask({ projectId: project.id, title: 'Second card' });
  const browser = await launch({ width: 1280, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  const ev = code => browser.eval(code), wait = (expression, label) => browser.until(expression, label, 15000);
  await browser.goto(`${app.url}/#/kanban`);
  await wait(`document.querySelector('[data-id="${first.id}"]')`, 'board');
  assert.equal(await ev(`const b = document.querySelector('#autopilot-open'); return !b.hidden && !b.disabled && b.previousElementSibling.id === 'columns-open';`), true);
  await ev(`document.querySelector('#autopilot-open').click();`);
  await wait(`document.querySelector('#autopilot-dialog').open`, 'dialog');
  // The board's own active columns, no merge or rework settings, both To Do cards queued.
  assert.deepEqual(await ev(`return [...document.querySelectorAll('#autopilot-route .route-chip span')].map(node => node.textContent);`), ['Planning', 'Executing', 'Code Review', 'Testing', 'Merge']);
  assert.equal(await ev(`return document.querySelector('#autopilot-dialog .select-grid').hidden && !document.querySelector('#autopilot-about-pipeline').hidden;`), true);
  assert.equal(await ev(`return document.querySelectorAll('#autopilot-queue .autopilot-item').length;`), 2);
  // Without instructions for the later columns, Autopilot cannot start.
  assert.match(await ev(`return document.querySelector('#autopilot-instructions').textContent;`), /Executing: “Proceed with implementing the approved plan\.”.*Code Review: needs an instruction/s);
  assert.equal(await ev(`return document.querySelector('#autopilot-start').disabled;`), true);
  await ev(`document.querySelector('#autopilot-add-instructions').click();`);
  await wait(`!document.querySelector('#autopilot-add-instructions') && !/needs an instruction/.test(document.querySelector('#autopilot-instructions').textContent)`, 'instructions added');
  const columns = (await app.board.state()).projects[0].pipeline.columns;
  assert.match(columns.find(column => column.id === 'code_review').automations.onEnter[0].message, /Review the changes/);
  assert.equal(columns.find(column => column.id === 'executing').automations.onEnter.length, 0, 'the plan route already instructs Executing');
  // Choose fewer columns and save; the queue keeps its order.
  await ev(`document.querySelector('#autopilot-route input[value="planning"]').click();`);
  await ev(`document.querySelector('#autopilot-route input[value="merge"]').click();`);
  if (process.env.PB_BROWSER_SHOTS) { await mkdir(process.env.PB_BROWSER_SHOTS, { recursive: true }); await writeFile(join(process.env.PB_BROWSER_SHOTS, 'pipeline-autopilot-dialog.png'), await browser.screenshot()); }
  await ev(`document.querySelector('#autopilot-save').click();`);
  await wait(`!document.querySelector('#autopilot-dialog').open`, 'saved');
  const saved = (await app.board.state()).projects[0].autopilot;
  assert.deepEqual(saved.route, ['executing', 'code_review', 'testing']); assert.deepEqual(saved.queue, [first.id, second.id]); assert.equal(saved.status, 'off');
  assert.deepEqual((await app.board.state()).runs, [], 'saving starts nothing');
  assert.deepEqual(browser.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);
});
