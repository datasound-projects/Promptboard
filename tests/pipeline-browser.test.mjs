import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';
import { attachSession } from '../src/sessions.mjs';
import { defaultPipelineConfig } from '../src/pipeline-config.mjs';

const chrome = await findChrome();
test('automation editing, Stop and receipt history work by keyboard in light/dark and desktop/narrow Chrome', { skip: !chrome, timeout: 90000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] }), pipeline = defaultPipelineConfig();
  const project = await app.board.createProject({ name: 'Actions UI' });
  for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  await app.board.setPipeline(project.id, { pipeline, expectedRevision: 1, confirm: true });
  const task = await app.board.createTask({ projectId: project.id, title: 'Literal task', prompt: '  Exact Composer\r\n' });
  const browser = await launch({ width: 1280, height: 900 }); if (!browser) { t.skip('Chrome did not start.'); return; } t.after(() => browser.close());
  const enter = async () => { await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); };
  await browser.goto(`${app.url}/#/kanban`); await browser.until(`document.querySelector('[data-id="${task.id}"]')`, 'task ready'); await browser.send('Page.bringToFront');
  await browser.eval(`document.querySelector('#columns-open').focus();`); await enter(); await browser.until(`document.querySelector('#columns-dialog').open`, 'editor opened');
  await browser.eval(`[...document.querySelectorAll('.columns-item')].find(button => button.textContent === 'To Do').focus();`); await enter();
  await browser.eval(`document.querySelector('[data-trigger="onExit"] .automation-add').scrollIntoView({block:'center'}); document.querySelector('[data-trigger="onExit"] .automation-add').focus();`); await enter();
  await browser.until(`document.querySelector('.automation-row [data-field="script"]')`, 'script row created');
  await browser.eval(`const type = document.querySelector('.automation-row [data-field="type"]'); type.value = 'webhook'; type.dispatchEvent(new Event('change',{bubbles:true}));`);
  await browser.eval(`const name = document.querySelector('.automation-row [data-field="name"]'); name.value = 'Recorded <img src=x onerror="window.__historyPwned=1">'; name.dispatchEvent(new Event('input',{bubbles:true})); const url = document.querySelector('.automation-row [data-field="url"]'); url.value = 'https://example.test/offline'; url.dispatchEvent(new Event('input',{bubbles:true}));`);
  for (const width of [1280, 390]) {
    await browser.resize(width, 900);
    for (const theme of ['light', 'dark']) {
      await browser.eval(`document.documentElement.dataset.theme = '${theme}'; const input = document.querySelector('.automation-row [data-field="headers"]'); input.scrollIntoView({block:'center'}); input.focus();`);
      assert.equal(await browser.layout(`const d=document.querySelector('#columns-dialog').getBoundingClientRect(),r=document.activeElement.getBoundingClientRect(); return document.activeElement.dataset.field === 'headers' && d.left >= -1 && d.right <= innerWidth+1 && r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight;`), true);
      await browser.eval(`const button = document.querySelector('.automation-row .danger'); button.scrollIntoView({block:'center'}); button.focus();`);
      assert.equal(await browser.layout(`const r=document.activeElement.getBoundingClientRect(); return document.activeElement.textContent === 'Delete action' && r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight;`), true);
      if (process.env.PB_BROWSER_SHOTS) { await mkdir(process.env.PB_BROWSER_SHOTS, { recursive: true }); await writeFile(join(process.env.PB_BROWSER_SHOTS, `pipeline-actions-${width}-${theme}.png`), await browser.screenshot()); }
    }
  }
  await browser.eval(`const save = document.querySelector('#columns-form button[type="submit"]'); save.scrollIntoView({block:'center'}); save.focus();`); await enter();
  await browser.until(`!document.querySelector('#columns-dialog').open`, 'saved without executing');
  assert.equal((await app.board.state()).runs.length, 0); assert.equal((await app.board.automationRuns(task.id)).length, 0);
  let calls = 0;
  app.board.automations.actions.fetcher = (_url, { signal }) => new Promise((_resolve, reject) => { calls++; const abort = () => reject(new Error('Owned fixture stopped.')); signal.addEventListener('abort', abort, { once:true }); if (signal.aborted) abort(); });
  const moving = app.board.transition(task.id, { column: 'code_review', expectedRevision: 1 }), cancelled = assert.rejects(moving, { code: 'AUTOMATION_MOVE_CANCELLED' });
  await browser.until(`document.querySelector('[data-id="${task.id}"] .kanban-stop-automations')`, 'poll displays owned pending work'); assert.equal(calls, 1);
  for (const theme of ['light', 'dark']) {
    await browser.eval(`document.documentElement.dataset.theme='${theme}'; const stop = document.querySelector('[data-id="${task.id}"] .kanban-stop-automations'); stop.scrollIntoView({block:'center',inline:'center'}); stop.focus();`);
    assert.equal(await browser.layout(`const r=document.activeElement.getBoundingClientRect(); return document.activeElement.classList.contains('kanban-stop-automations') && r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight;`), true);
  }
  await enter(); await cancelled;
  await browser.until(`!document.querySelector('[data-id="${task.id}"] .kanban-stop-automations')`, 'Stop acknowledged');
  await browser.eval(`document.querySelector('[data-id="${task.id}"] .kanban-more-toggle').click(); document.querySelector('[data-id="${task.id}"] .kanban-details').focus();`); await enter();
  await browser.until(`document.querySelector('.automation-history')?.textContent.includes('On exit')`, 'durable results loaded');
  assert.equal(await browser.eval(`return document.querySelector('.automation-history img')===null && !window.__historyPwned;`), true);
  for (const theme of ['light', 'dark']) {
    await browser.eval(`document.documentElement.dataset.theme='${theme}'; const summary=document.querySelector('.automation-history summary'); summary.scrollIntoView({block:'center'}); summary.focus();`);
    assert.equal(await browser.layout(`const r=document.activeElement.getBoundingClientRect(); return document.activeElement.tagName==='SUMMARY' && r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight;`), true);
  }
  await enter(); assert.equal(await browser.eval(`return document.querySelector('.automation-history details').open;`), true);
  assert.equal(calls, 1); assert.equal((await app.board.state()).projects[0].tasks[0].prompt, task.prompt);
  assert.ok(!browser.consoleMessages.some(message=>message.startsWith('EXCEPTION')),browser.consoleMessages.join('\n'));
});
// This scenario includes cold Chrome startup and sequential persisted edits,
// keyboard actions and layout checks. Individual readiness waits remain bounded;
// allow the complete scenario to finish on slower hosted macOS runners.
test('column pipeline conversion and editing work by keyboard in both themes and narrow Chrome viewports', { skip: !chrome, timeout: 90000 }, async t => {
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
      await browser.eval(`document.querySelector('#column-plan-target').focus();`);
      assert.equal(await browser.layout(`const r = document.activeElement.getBoundingClientRect(); return document.activeElement.id === 'column-plan-target' && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;`), true);
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
  await browser.eval(`[...document.querySelectorAll('.columns-item')].find(button => button.textContent === 'Planning').focus();`); await enter();
  assert.equal(await browser.eval(`return document.querySelector('#column-plan-target').value;`), 'executing');
  await browser.eval(`document.querySelector('#column-plan-target').focus();`);
  await browser.type('Testing'); await browser.key('Tab', 'Tab', 9);
  assert.equal(await browser.eval(`return document.querySelector('#column-plan-target').value;`), 'testing');
  assert.equal(await browser.eval(`return document.querySelector('#columns-dialog').open;`), true);
  await browser.eval(`[...document.querySelectorAll('.columns-item')].find(button => button.textContent === 'Build').focus();`); await enter();
  await browser.eval(`document.querySelector('[aria-label="Move right: Build"]').click(); document.querySelector('#columns-add').click();`);
  await browser.until(`document.querySelector('#column-name')?.value.startsWith('New column')`, 'new active column');
  await browser.eval(`const input = document.querySelector('#column-name'); input.value = 'Triage'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#columns-form button[type="submit"]').click();`);
  await browser.until(`!document.querySelector('#columns-dialog').open && [...document.querySelectorAll('.kanban-column h3')].some(node => node.textContent.includes('Triage'))`, 'new column saved');
  saved = (await app.board.state()).projects[0];
  assert.equal(saved.pipeline.columns.findIndex(column => column.id === 'executing'), 3);
  assert.equal(saved.pipeline.columns.find(column => column.id === 'planning').strategy.planExitTargetId, 'testing');
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
    const run = { id: 'activity-display-fixture', taskId: card.id, projectId: project.id, stage: 'planning', status: 'waiting_for_input',
      createdAt: Date.now(), config: { provider: 'claude', pipeline: true }, turnComplete: true,
      waitingReason: 'The agent finished its response.', activity: { phase: 'working', tools: 2, subagents: 1, background: 1, scheduled: 1, ready: false } };
    state.runs.push(run); attachSession(state, run);
  });
  await browser.eval(`await loadBoard(); document.querySelector('[data-id="${card.id}"]').scrollIntoView({ block: 'nearest', inline: 'center' });`);
  await browser.until(`document.querySelector('[data-id="${card.id}"]').textContent.includes('2 tools')`, 'outstanding activity displayed separately from response completion');
  assert.equal(await browser.eval(`return agentState(board.runs.find(run => run.id === 'activity-display-fixture'));`), 'active');
  assert.ok((await browser.eval(`return document.querySelector('.agent-item[data-run-id="activity-display-fixture"]').textContent;`)).includes('Other editor'));
  for (const theme of ['light', 'dark']) {
    await browser.eval(`document.documentElement.dataset.theme = '${theme}';`);
    assert.equal(await browser.layout(`const r = document.querySelector('[data-id="${card.id}"] .run-activity').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth;`), true);
  }
  await app.board.updateRun('activity-display-fixture', { activity: { phase: 'waiting', permissionPending: true, ready: false } });
  await browser.eval(`await loadBoard();`);
  assert.equal(await browser.eval(`return agentState(board.runs.find(run => run.id === 'activity-display-fixture'));`), 'awaits_you');
  assert.ok((await browser.eval(`return document.querySelector('[data-id="${card.id}"]').textContent;`)).includes('needs your answer'));
  for (const status of ['pending', 'failed', 'interrupted']) {
    await app.board.updateRun('activity-display-fixture', { planRoutes: [{ id: 'route-ui', toColumn: 'executing', status, reason: '<img src=x onerror="window.__routePwned=1"> Move explicitly.' }] });
    await browser.eval(`await loadBoard();`);
    const routeText = await browser.eval(`return document.querySelector('[data-id="${card.id}"] .plan-route').textContent;`);
    assert.match(routeText, status === 'pending' ? /Plan approved.*Build.*turn settles/ : /Move explicitly/);
    assert.equal(await browser.eval(`return document.querySelector('[data-id="${card.id}"] .plan-route img') === null && !window.__routePwned;`), true);
    for (const theme of ['light', 'dark']) {
      await browser.eval(`document.documentElement.dataset.theme = '${theme}';`);
      assert.equal(await browser.layout(`const r = document.querySelector('[data-id="${card.id}"] .plan-route').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth;`), true);
    }
  }
  for (const theme of ['light', 'dark']) for (const status of ['suspended', 'cancelled']) {
    const text = await browser.eval(`document.documentElement.dataset.theme = '${theme}'; movedAnnouncement(findTask('${card.id}'), 'code_review', { run: { id: 'cancelled-before-queue', status: '${status}' } }); return document.querySelector('#announcement').textContent;`);
    assert.match(text, status === 'suspended' ? /paused before starting/ : /stopped before starting/);
    assert.doesNotMatch(text, /started the/);
  }
  assert.ok(!browser.consoleMessages.some(message => message.startsWith('EXCEPTION')), browser.consoleMessages.join('\n'));
});
