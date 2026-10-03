import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';
import { attachSession } from '../src/sessions.mjs';

const chrome = await findChrome();
test('column pipeline conversion and editing work by keyboard in both themes and narrow Chrome viewports', { skip: !chrome, timeout: 30000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const project = await app.board.createProject({ name: 'Pipeline UI' });
  const prompt = '  Composer split task\r\nconst x = 1;  \r\n';
  const card = await app.board.createTask({ projectId: project.id, title: 'Engineered prompt', prompt });
  const browser = await launch({ width: 1280, height: 900 });
  if (!browser) { t.skip('Chrome did not start.'); return; }
  t.after(() => browser.close());
  // Native button activation requires a character event; the shared raw-key helper is for terminals.
  const enter = async () => {
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  };
  await browser.goto(`${app.url}/#/kanban`);
  await browser.until(`document.querySelector('[data-id="${card.id}"]')`, 'Composer task displayed');
  await browser.send('Page.bringToFront');
  await browser.eval(`document.querySelector('#columns-open').focus();`); await enter();
  await browser.until(`document.querySelector('#columns-dialog').open`, 'Column Manager opened by keyboard').catch(async error => {
    throw new Error(`${error.message}; console ${JSON.stringify(browser.consoleMessages)}; focus ${await browser.eval('return document.activeElement?.outerHTML;')}`);
  });
  await browser.eval(`document.querySelector('#columns-use-pipeline').focus();`); await enter();
  await browser.until(`document.querySelector('#column-auto-spawn')`, 'pipeline column fields');
  for (const width of [1280, 390]) {
    await browser.resize(width, 900);
    for (const theme of ['light', 'dark']) {
      await browser.eval(`document.documentElement.dataset.theme = '${theme}'; document.querySelector('#column-name').focus();`);
      assert.equal(await browser.layout(`const dialog = document.querySelector('#columns-dialog').getBoundingClientRect(); const field = document.activeElement.getBoundingClientRect(); return dialog.left >= -1 && dialog.right <= innerWidth + 1 && field.left >= 0 && field.right <= innerWidth && document.activeElement.id === 'column-name';`), true);
      if (process.env.PB_BROWSER_SHOTS) { await mkdir(process.env.PB_BROWSER_SHOTS, { recursive: true }); await writeFile(join(process.env.PB_BROWSER_SHOTS, `pipeline-columns-${width}-${theme}.png`), await browser.screenshot()); }
    }
  }
  await browser.eval(`const input = document.querySelector('#column-name'); input.value = 'Build'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#columns-form button[type="submit"]').focus();`);
  await enter();
  await browser.until(`!document.querySelector('#columns-dialog').open && document.querySelector('#column-executing')?.textContent.includes('Build')`, 'conversion saved');
  let saved = (await app.board.state()).projects[0];
  assert.equal(saved.workflowMode, 'pipeline'); assert.equal(saved.tasks[0].prompt, prompt); assert.equal(saved.tasks[0].column, 'todo'); assert.deepEqual((await app.board.state()).runs, []);
  assert.equal(await browser.eval(`return document.querySelector('#autopilot-open').hidden;`), true);
  await browser.eval(`document.querySelector('#columns-open').click();`);
  await browser.until(`document.querySelector('#column-auto-spawn')`, 'saved pipeline editor reopened');
  await browser.eval(`document.querySelector('[aria-label="Move right: Build"]').click(); document.querySelector('#columns-add').click();`);
  await browser.until(`document.querySelector('#column-name')?.value.startsWith('New column')`, 'new active column');
  await browser.eval(`const input = document.querySelector('#column-name'); input.value = 'Triage'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#columns-form button[type="submit"]').click();`);
  await browser.until(`!document.querySelector('#columns-dialog').open && [...document.querySelectorAll('.kanban-column h3')].some(node => node.textContent.includes('Triage'))`, 'new column saved');
  saved = (await app.board.state()).projects[0];
  assert.equal(saved.pipeline.columns.findIndex(column => column.id === 'executing'), 3);
  assert.equal(saved.pipeline.columns.find(column => column.name === 'Triage').strategy.autoSpawn, false);
  assert.equal(saved.tasks[0].prompt, prompt); assert.deepEqual((await app.board.state()).runs, []);
  await app.board.transition(card.id, { column: 'done', expectedRevision: saved.tasks[0].revision });
  await browser.reload(); await browser.until(`document.querySelector('[data-id="${card.id}"] .kanban-restore')`, 'archived task restoration control');
  await browser.eval(`document.querySelector('[data-id="${card.id}"]').scrollIntoView({ block: 'nearest', inline: 'center' }); document.querySelector('[data-id="${card.id}"] .kanban-more-toggle').focus();`); await enter();
  for (const theme of ['light', 'dark']) {
    await browser.eval(`document.documentElement.dataset.theme = '${theme}'; document.querySelector('[data-id="${card.id}"] .kanban-restore').focus();`);
    assert.equal(await browser.layout(`const r = document.activeElement.getBoundingClientRect(); return document.activeElement.classList.contains('kanban-restore') && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;`), true);
  }
  const triage = saved.pipeline.columns.find(column => column.name === 'Triage').id;
  await browser.eval(`const select = document.querySelector('[data-id="${card.id}"] .kanban-restore'); select.value = '${triage}'; select.dispatchEvent(new Event('change', { bubbles: true }));`);
  await browser.until(`document.querySelector('[data-column="${triage}"] [data-id="${card.id}"]')`, 'manual column restored without agent');
  saved = (await app.board.state()).projects[0]; assert.equal(saved.tasks[0].archivedAt, undefined); assert.equal(saved.tasks[0].prompt, prompt); assert.deepEqual((await app.board.state()).runs, []);
  await browser.eval(`document.querySelector('#columns-open').click();`);
  await browser.until(`document.querySelector('#columns-dialog').open`, 'draft opened before concurrent settings change');
  const concurrent = structuredClone(saved.pipeline); concurrent.columns.find(column => column.id === triage).name = 'Other editor';
  await app.board.setPipeline(project.id, { pipeline: concurrent, expectedRevision: saved.revision });
  await browser.eval(`await loadBoard(); document.querySelector('#columns-form button[type="submit"]').click();`);
  await browser.until(`!document.querySelector('#columns-error').hidden && document.querySelector('#columns-error').textContent.includes('changed since')`, 'stale draft rejected after background refresh');
  assert.equal((await app.board.state()).projects[0].pipeline.columns.find(column => column.id === triage).name, 'Other editor');
  await browser.eval(`document.querySelector('#columns-dialog').close();`);
  await app.board.store.update(state => {
    const run = { id: 'activity-display-fixture', taskId: card.id, projectId: project.id, stage: triage, status: 'waiting_for_input',
      createdAt: Date.now(), config: { provider: 'claude', pipeline: true }, turnComplete: true,
      waitingReason: 'The agent finished its response.', activity: { phase: 'working', tools: 2, subagents: 1, background: 1, scheduled: 1, ready: false } };
    state.runs.push(run); attachSession(state, run);
  });
  await browser.eval(`await loadBoard(); document.querySelector('[data-id="${card.id}"]').scrollIntoView({ block: 'nearest', inline: 'center' });`);
  await browser.until(`document.querySelector('[data-id="${card.id}"]').textContent.includes('2 tools')`, 'outstanding activity displayed separately from response completion');
  assert.equal(await browser.eval(`return agentState(board.runs.find(run => run.id === 'activity-display-fixture'));`), 'active');
  for (const theme of ['light', 'dark']) {
    await browser.eval(`document.documentElement.dataset.theme = '${theme}';`);
    assert.equal(await browser.layout(`const r = document.querySelector('[data-id="${card.id}"] .run-activity').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth;`), true);
  }
  await app.board.updateRun('activity-display-fixture', { activity: { phase: 'waiting', permissionPending: true, ready: false } });
  await browser.eval(`await loadBoard();`);
  assert.equal(await browser.eval(`return agentState(board.runs.find(run => run.id === 'activity-display-fixture'));`), 'awaits_you');
  assert.ok((await browser.eval(`return document.querySelector('[data-id="${card.id}"]').textContent;`)).includes('needs your answer'));
  for (const theme of ['light', 'dark']) for (const status of ['suspended', 'cancelled']) {
    const text = await browser.eval(`document.documentElement.dataset.theme = '${theme}'; movedAnnouncement(findTask('${card.id}'), 'code_review', { run: { id: 'cancelled-before-queue', status: '${status}' } }); return document.querySelector('#announcement').textContent;`);
    assert.match(text, status === 'suspended' ? /paused before starting/ : /stopped before starting/);
    assert.doesNotMatch(text, /started the/);
  }
  assert.ok(!browser.consoleMessages.some(message => message.startsWith('EXCEPTION')), browser.consoleMessages.join('\n'));
});
