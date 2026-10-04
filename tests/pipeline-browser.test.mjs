import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';
import { attachSession } from '../src/sessions.mjs';
import { defaultPipelineConfig } from '../src/pipeline-config.mjs';
import { repositoryPipelineDefinition } from '../src/pipeline-repository.mjs';

const chrome = await findChrome();
test('external repository changes show a keyboard review banner across themes and widths without changing the board or an open draft', { skip: !chrome, timeout: 90000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const { project } = await app.board.createProjectWithRepository({ name: 'Watched browser', folder: 'new' }), pipeline = defaultPipelineConfig();
  for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  await app.board.setPipeline(project.id, { pipeline, expectedRevision: project.revision, confirm: true });
  const task = await app.board.createTask({ projectId: project.id, title: 'Exact Composer split', prompt: '  Original 😀\r\n' }), team = repositoryPipelineDefinition(pipeline), bytes = JSON.stringify(team);
  await writeFile(join(project.repository.root, 'promptboard.json'), bytes); await app.board.applyRepositoryPipeline(project.id, { ...await app.board.previewRepositoryPipeline(project.id), confirm: true });
  const browser = await launch(); if (!browser) { t.skip('Chrome did not start.'); return; } t.after(() => browser.close());
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__repositoryReads = []; window.__statusReads = 0;
    const nativeFetch = window.fetch;
    window.fetch = function (...args) {
      const result = Reflect.apply(nativeFetch, this, args);
      if (typeof args[0] === 'string' && args[0].endsWith('/repository-pipeline')) window.__repositoryReads.push(result.then(async response => ({ status: response.status, data: await response.clone().json() })).catch(error => ({ error: error.name })));
      if (typeof args[0] === 'string' && args[0].endsWith('/repository-pipeline-status')) result.then(response => response.clone().text()).catch(() => null).then(() => window.__statusReads++);
      return result;
    };
  ` });
  const enter = async id => { await browser.eval(`const node=document.getElementById(${JSON.stringify(id)}); node.scrollIntoView({block:'center'}); node.focus();`); await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); };
  const reviewed = async label => {
    const read = await browser.eval('return await window.__repositoryReads.at(-1);');
    assert.equal(read.status, 200, `${label}: ${JSON.stringify(read)}`);
    await browser.until(`!document.getElementById('repository-pipeline-apply').disabled`, label).catch(async error => {
      const state = await browser.eval(`return { open:document.getElementById('repository-pipeline-dialog').open, preview:document.getElementById('repository-pipeline-preview').textContent, error:document.getElementById('repository-pipeline-error').textContent, focus:document.activeElement.id };`);
      throw new Error(`${error.message}; state ${JSON.stringify(state)}; console ${JSON.stringify(browser.consoleMessages)}`);
    });
  };
  await browser.send('Page.bringToFront'); await browser.goto(`${app.url}/#/kanban`);
  await browser.until(`document.querySelector('[data-id="${task.id}"]') && window.__statusReads > 0`, 'accepted repository monitor ready');
  const before = structuredClone(await app.board.state());
  team.columns[2].description = '<img src=x onerror="window.__watchPwned=1">'; team.columns[2].strategy.autoSpawn = true;
  await writeFile(join(project.repository.root, 'promptboard.json'), JSON.stringify(team));
  await browser.until(`!document.getElementById('repository-pipeline-warning').hidden`, 'external edit detected without a board revision');
  for (const width of [1280, 390]) {
    await browser.resize(width, 900);
    for (const theme of ['light', 'dark']) {
      await browser.eval(`document.documentElement.dataset.theme='${theme}'; const button=document.getElementById('repository-pipeline-warning-review'); button.scrollIntoView({block:'center'}); button.focus();`);
      assert.equal(await browser.layout(`const banner=document.getElementById('repository-pipeline-warning'), r=banner.getBoundingClientRect(), b=document.activeElement.getBoundingClientRect(); return document.activeElement.id==='repository-pipeline-warning-review' && r.left>=-1 && r.right<=innerWidth+1 && banner.scrollWidth<=banner.clientWidth && b.left>=0 && b.right<=innerWidth && b.top>=0 && b.bottom<=innerHeight;`), true);
      if (process.env.PB_BROWSER_SHOTS) { await mkdir(process.env.PB_BROWSER_SHOTS, { recursive: true }); await writeFile(join(process.env.PB_BROWSER_SHOTS, `repository-watch-${width}-${theme}.png`), await browser.screenshot()); }
    }
  }
  assert.deepEqual(await app.board.state(), before);
  await enter('columns-open'); await browser.until(`document.getElementById('columns-dialog').open`, 'editor opened');
  await browser.eval(`const input=document.getElementById('column-name'); input.value='Unsaved keyboard draft'; input.dispatchEvent(new Event('input')); input.focus();`);
  await writeFile(join(project.repository.root, 'promptboard.json'), 'PRIVATE INVALID JSON');
  await browser.until(`document.getElementById('repository-pipeline-warning-text').textContent.includes('could not be checked')`, 'unreadable file reported');
  assert.equal(await browser.eval(`return document.getElementById('column-name').value==='Unsaved keyboard draft' && document.activeElement.id==='column-name' && !document.getElementById('repository-pipeline-warning').textContent.includes('PRIVATE');`), true);
  await writeFile(join(project.repository.root, 'promptboard.json'), JSON.stringify(team));
  await browser.until(`document.getElementById('repository-pipeline-warning-text').textContent.includes('configuration changed')`, 'recovered definition detected');
  // An open editor retains its draft during background reads and opens review
  // through its own repository button while the modal owns keyboard focus.
  await enter('columns-repository-read'); await browser.until(`window.__repositoryReads.length > 0`, 'fresh reviewed read dispatched'); await reviewed('fresh definition reviewed');
  assert.equal(await browser.eval(`return document.getElementById('column-name').value==='Unsaved keyboard draft' && !document.querySelector('#repository-pipeline-preview img') && !window.__watchPwned;`), true);
  await enter('repository-pipeline-cancel'); await enter('columns-close');
  await enter('repository-pipeline-warning-review'); await browser.until(`window.__repositoryReads.length === 2`, 'banner keyboard action dispatched'); await reviewed('banner opens fresh review');
  await enter('repository-pipeline-cancel'); await enter('columns-close');
  await writeFile(join(project.repository.root, 'promptboard.json'), bytes); await browser.until(`document.getElementById('repository-pipeline-warning').hidden`, 'unchanged original bytes clear banner');
  assert.deepEqual(await app.board.state(), before); assert.deepEqual(browser.consoleMessages.filter(message => message.startsWith('EXCEPTION')), []);
});

test('repository board review works by keyboard in both themes and narrow Chrome without running agents', { skip: !chrome, timeout: 90000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const { project } = await app.board.createProjectWithRepository({ name: 'Config browser', folder: 'new' }), pipeline = defaultPipelineConfig();
  for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  await app.board.setPipeline(project.id, { pipeline, expectedRevision: project.revision, confirm: true });
  const task = await app.board.createTask({ projectId: project.id, title: 'Exact Composer', prompt: '  Literal 😀\r\n' }), team = repositoryPipelineDefinition(pipeline);
  team.columns[2].description = '<img src=x onerror="window.__configPwned=1">'; await writeFile(join(project.repository.root, 'promptboard.json'), JSON.stringify(team));
  const browser = await launch(); if (!browser) { t.skip('Chrome did not start.'); return; } t.after(() => browser.close());
  // Observe this request's completion rather than spending the 10s DOM deadline
  // on Git validation. The app still owns its unchanged 20s abort deadline.
  // Return the original fetch promise/response, so the observation cannot change it.
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__repositoryReads = [];
    const nativeFetch = window.fetch;
    window.fetch = function (...args) {
      const result = Reflect.apply(nativeFetch, this, args);
      if (typeof args[0] === 'string' && /^\\/api\\/projects\\/[^/]+\\/repository-pipeline$/.test(args[0]) && (!args[1]?.method || args[1].method === 'GET'))
        window.__repositoryReads.push(result.then(response => response.clone().text()).catch(() => null));
      return result;
    };
  ` });
  const enter = async id => { if (id) await browser.eval(`const node=document.getElementById(${JSON.stringify(id)}); node.scrollIntoView({block:'center'}); node.focus();`); await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); };
  const read = async () => {
    const count = await browser.eval('return window.__repositoryReads.length;');
    await enter('columns-repository-read');
    await browser.until(`window.__repositoryReads.length === ${count + 1}`, 'owned repository read dispatched');
    await browser.eval(`await window.__repositoryReads[${count}]; return true;`);
  };
  await browser.goto(`${app.url}/#/kanban`); await browser.until(`document.querySelector('[data-id="${task.id}"]')`, 'task ready'); await enter('columns-open');
  for (const width of [1280, 390]) {
    await browser.resize(width, 900);
    for (const theme of ['light', 'dark']) {
      await browser.eval(`document.documentElement.dataset.theme='${theme}';`); await read();
      await browser.until(`!document.getElementById('repository-pipeline-apply').disabled`, `repository definition read at ${width}px ${theme}`).catch(async error => {
        const state = await browser.eval(`return { columnsOpen:document.getElementById('columns-dialog').open, reviewOpen:document.getElementById('repository-pipeline-dialog').open, focus:document.activeElement.id, error:document.getElementById('repository-pipeline-error').textContent, preview:document.getElementById('repository-pipeline-preview').textContent };`);
        throw new Error(`${error.message}; state ${JSON.stringify(state)}; console ${JSON.stringify(browser.consoleMessages)}`);
      });
      await browser.eval(`document.querySelector('#repository-pipeline-preview summary').focus();`); await enter();
      await browser.until(`document.querySelector('#repository-pipeline-preview details').open`, 'definition opened by keyboard');
      assert.equal(await browser.layout(`const dialog=document.getElementById('repository-pipeline-dialog'); const r=dialog.getBoundingClientRect(); return r.left>=-1 && r.right<=innerWidth+1 && dialog.scrollWidth<=dialog.clientWidth && document.querySelector('#repository-pipeline-preview img')===null && !window.__configPwned;`), true);
      await browser.eval(`const pre=document.querySelector('#repository-pipeline-preview pre'); pre.scrollIntoView({block:'center'}); pre.focus();`);
      assert.equal(await browser.eval(`return document.activeElement.tagName==='PRE' && document.activeElement.textContent.includes('onerror');`), true);
      if (process.env.PB_BROWSER_SHOTS) { await mkdir(process.env.PB_BROWSER_SHOTS, { recursive: true }); await writeFile(join(process.env.PB_BROWSER_SHOTS, `repository-config-${width}-${theme}.png`), await browser.screenshot()); }
      await enter('repository-pipeline-cancel'); await browser.until(`!document.getElementById('repository-pipeline-dialog').open`, 'review closed');
    }
  }
  await read(); await browser.until(`!document.getElementById('repository-pipeline-apply').disabled`, 'final review'); await enter('repository-pipeline-apply');
  await browser.until(`!document.getElementById('columns-dialog').open && !document.getElementById('repository-pipeline-dialog').open`, 'review applied');
  const saved=(await app.board.state()).projects[0]; assert.equal(saved.tasks[0].prompt, task.prompt); assert.equal(saved.pipeline.columns[2].description, team.columns[2].description); assert.deepEqual((await app.board.state()).runs, []);
  assert.deepEqual(browser.consoleMessages.filter(message=>message.startsWith('EXCEPTION')), []);
});

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
  const dispatched = Promise.withResolvers();
  app.board.automations.actions.fetcher = (_url, { signal }) => new Promise((_resolve, reject) => { calls++; dispatched.resolve(); const abort = () => reject(new Error('Owned fixture stopped.')); signal.addEventListener('abort', abort, { once:true }); if (signal.aborted) abort(); });
  const moving = app.board.transition(task.id, { column: 'code_review', expectedRevision: 1 }), cancelled = assert.rejects(moving, { code: 'AUTOMATION_MOVE_CANCELLED' });
  await browser.until(`document.querySelector('[data-id="${task.id}"] .kanban-stop-automations')`, 'poll displays owned pending work');
  // Pending intent is visible before dispatch. This scenario tests cancelling an
  // active webhook, so observe the owned fetch itself before asserting or stopping.
  await dispatched.promise; assert.equal(calls, 1);
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
  // A joined background poll can still contain the previous working snapshot.
  // Observe the exact new native wait and its rendered message before asserting.
  await browser.until(`board.runs.find(run => run.id === 'activity-display-fixture')?.activity?.phase === 'waiting' && document.querySelector('[data-id="${card.id}"]').textContent.includes('needs your answer')`, 'current permission wait rendered');
  assert.equal(await browser.eval(`return agentState(board.runs.find(run => run.id === 'activity-display-fixture'));`), 'awaits_you');
  assert.ok((await browser.eval(`return document.querySelector('[data-id="${card.id}"]').textContent;`)).includes('needs your answer'));
  for (const status of ['pending', 'failed', 'interrupted']) {
    await app.board.updateRun('activity-display-fixture', { planRoutes: [{ id: 'route-ui', toColumn: 'executing', status, reason: '<img src=x onerror="window.__routePwned=1"> Move explicitly.' }] });
    await browser.eval(`await loadBoard();`);
    // loadBoard can join a background poll that captured the prior snapshot.
    // Wait for this exact status and its rendered text, not an unrelated refresh.
    await browser.until(`board.runs.find(run => run.id === 'activity-display-fixture')?.planRoutes?.at(-1)?.status === ${JSON.stringify(status)} && document.querySelector('[data-id="${card.id}"] .plan-route')?.textContent.includes(${JSON.stringify(status === 'pending' ? 'turn settles' : 'Move explicitly')})`, `current ${status} plan route rendered`);
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

test('board profiles and task agent choices work by keyboard in both themes and narrow Chrome without starting agents', { skip: !chrome, timeout: 90000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] }), pipeline = defaultPipelineConfig();
  const project = await app.board.createProject({ name: 'Profile browser' }); for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  pipeline.columns[2].strategy.modelOverride = 'column-pin';
  pipeline.columns[2].automations.onEnter = [{ id: 'shared', name: 'Shared alert', type: 'notify', enabled: false, title: '{{title}}', body: 'Literal body' }];
  await app.board.setPipeline(project.id, { pipeline, expectedRevision: 1, confirm: true });
  const prompt = '  Exact Composer <literal>\r\n😀  ', task = await app.board.createTask({ projectId: project.id, title: 'Profile task', prompt });
  const browser = await launch(); if (!browser) { t.skip('Chrome did not start.'); return; } t.after(() => browser.close());
  const enter = async selector => {
    await browser.eval(`const button = document.querySelector(${JSON.stringify(selector)}); button.scrollIntoView({block:'center'}); button.focus();`);
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  };
  const choose = (selector, value) => browser.eval(`const node = document.querySelector(${JSON.stringify(selector)}); node.value = ${JSON.stringify(value)}; node.dispatchEvent(new Event('change',{bubbles:true}));`);
  const shot = async name => { if (process.env.PB_BROWSER_SHOTS) { await mkdir(process.env.PB_BROWSER_SHOTS, { recursive: true }); await writeFile(join(process.env.PB_BROWSER_SHOTS, name+'.png'), await browser.screenshot()); } };
  await browser.goto(app.url+'/#/kanban'); await browser.until(`document.querySelector('[data-id="${task.id}"]')`, 'task displayed');
  await enter('#columns-open'); await enter('#columns-profile-new');
  await browser.eval(`const name = document.querySelector('#columns-profile-name'); name.value = 'Economy <img src=x>'; name.dispatchEvent(new Event('input',{bubbles:true}));`);
  assert.equal(await browser.eval(`return document.querySelector('#column-name').disabled && document.querySelector('#columns-add').disabled && document.querySelector('#columns-remove').disabled && [...document.querySelectorAll('.column-automations input, .column-automations button')].every(control=>control.disabled) && !document.querySelector('#columns-profiles img');`), true);
  await choose('#profile-modelOverride-mode','default'); await choose('#profile-effortOverride-mode','override'); await choose('#profile-effortOverride-value','low');
  for (const width of [1280,390]) for (const theme of ['light','dark']) {
    await browser.resize(width,900); await browser.eval(`document.documentElement.dataset.theme='${theme}'; const field=document.querySelector('#profile-modelOverride-mode'); field.scrollIntoView({block:'center'}); field.focus();`);
    assert.equal(await browser.layout(`const d=document.querySelector('#columns-dialog'), r=document.activeElement.getBoundingClientRect(); return d.scrollWidth<=d.clientWidth && r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight && document.activeElement.id==='profile-modelOverride-mode';`), true);
    await shot('board-profile-'+width+'-'+theme);
  }
  await enter('#columns-form button[type="submit"]'); await browser.until(`!document.querySelector('#columns-dialog').open`, 'profile saved');
  const profile = (await app.board.state()).projects[0].pipeline.profiles[0]; assert.equal(profile.columns.executing.modelOverride,null); assert.equal(profile.columns.executing.effortOverride,'low');
  await enter(`[data-id="${task.id}"] .kanban-open`); await choose('#card-pipeline-profile',profile.id);
  for (const width of [1280,390]) for (const theme of ['light','dark']) {
    await browser.resize(width,900); await browser.eval(`document.documentElement.dataset.theme='${theme}'; const field=document.querySelector('#card-pipeline-profile'); field.scrollIntoView({block:'center'}); field.focus();`);
    assert.equal(await browser.layout(`const d=document.querySelector('#card-dialog'),r=document.activeElement.getBoundingClientRect(); return d.scrollWidth<=d.clientWidth && r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight;`),true); await shot('task-profile-'+width+'-'+theme);
  }
  await enter('#card-save'); await browser.until(`!document.querySelector('#card-dialog').open`, 'task profile saved');
  assert.equal((await app.board.state()).projects[0].tasks[0].profileId,profile.id);
  await enter(`[data-id="${task.id}"] .kanban-more-toggle`); await enter(`[data-id="${task.id}"] .kanban-details`);
  await browser.until(`document.querySelector('#details-pipeline-profile')`, 'task settings shown');
  await browser.eval(`const radio=document.querySelector('#details-pipeline-mode-override'); radio.focus();`); await browser.key(' ','Space',32);
  await browser.until(`document.querySelector('#details-pipeline-mode-override').checked`, 'exclusive override selected');
  await choose('#details-pipeline-agentOverride','codex'); await choose('#details-pipeline-permissionMode','workspace-write');
  await enter('#task-pipeline-save'); await browser.until(`document.querySelector('[data-id="${task.id}"] .pipeline-task-choice')?.textContent==='Task-wide agent override'`, 'saved task override');
  const saved = (await app.board.state()).projects[0].tasks[0]; assert.equal(saved.profileId,null); assert.equal(saved.agentOverride.agentOverride,'codex'); assert.equal(saved.agentOverride.permissionMode,'workspace-write'); assert.equal(saved.prompt,prompt); assert.equal(saved.contentRevision,1);
  assert.deepEqual((await app.board.state()).runs,[]); assert.equal((await app.board.automationRuns(task.id)).length,0);
  assert.equal(await browser.eval(`const ids=[...document.querySelectorAll('#card-dialog [id], #task-dialog [id], #columns-dialog [id]')].map(node=>node.id); return new Set(ids).size===ids.length;`),true);
  assert.deepEqual(browser.consoleMessages.filter(message=>message.startsWith('EXCEPTION')),[]);
});
