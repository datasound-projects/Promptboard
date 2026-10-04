import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';
import { defaultPipelineConfig } from '../src/pipeline-config.mjs';

test('title-only pipeline cards save by keyboard across themes/widths and refine their title in Composer; legacy bodies stay required', { skip: !await findChrome(), timeout: 90000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] }), pipeline = defaultPipelineConfig();
  for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  pipeline.columns[0].id = 'inbox';
  const project = await app.board.createProject({ name: 'Title-only' }), legacy = await app.board.createProject({ name: 'Legacy' });
  await app.board.setPipeline(project.id, { pipeline, expectedRevision: project.revision, confirm: true });
  const browser = await launch(); if (!browser) { t.skip('Chrome did not start.'); return; } t.after(() => browser.close());
  const enter = async id => { await browser.eval(`const n=document.getElementById(${JSON.stringify(id)});n.scrollIntoView({block:'center'});n.focus();`);
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); };
  const select = async id => browser.eval(`const s=document.getElementById('project-select');s.value=${JSON.stringify(id)};s.dispatchEvent(new Event('change',{bubbles:true}));`);
  await browser.send('Page.bringToFront'); await browser.goto(`${app.url}/#/kanban`); await browser.until(`document.querySelector('#project-select option[value="${project.id}"]')`, 'projects loaded'); await select(project.id);
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    await browser.resize(width, 900); await browser.eval(`document.documentElement.dataset.theme=${JSON.stringify(theme)};`);
    await enter('card-new'); await browser.until(`document.getElementById('card-dialog').open`, 'new card opened');
    assert.equal(await browser.layout(`const d=document.getElementById('card-dialog').getBoundingClientRect(),p=document.getElementById('card-prompt'),r=p.getBoundingClientRect();return document.activeElement.id==='card-title' && !p.required && document.getElementById('card-prompt-label').textContent==='Prompt (optional)' && d.left>=-1 && d.right<=innerWidth+1 && r.left>=0 && r.right<=innerWidth;`), true);
    const title = `Task ${width} ${theme}`; await browser.type(title);
    if (process.env.PB_BROWSER_SHOTS) { await mkdir(process.env.PB_BROWSER_SHOTS, { recursive: true }); await writeFile(join(process.env.PB_BROWSER_SHOTS, `title-only-${width}-${theme}.png`), await browser.screenshot()); }
    await enter('card-save'); await browser.until(`!document.getElementById('card-dialog').open`, 'title-only saved');
    const task = (await app.board.state()).projects.find(p=>p.id===project.id).tasks.at(-1); assert.equal(task.title, title); assert.equal(task.prompt, ''); assert.equal(task.column, 'inbox');
  }
  await enter('card-new'); await browser.until(`document.getElementById('card-dialog').open`, 'refine task opened');
  await browser.type('Fix the parser'); await enter('card-refine');
  await browser.until(`!document.getElementById('prompt-view').hidden && document.getElementById('prompt-input').value==='Fix the parser'`, 'title inserted into Composer');
  assert.equal((await app.board.state()).projects.find(p=>p.id===project.id).tasks.length, 4, 'Refining a draft cannot create a task or start work.');
  await browser.eval(`location.hash='#/kanban';`); await browser.until(`!document.getElementById('kanban-view').hidden`, 'return to board'); await select(legacy.id);
  await enter('card-new'); await browser.until(`document.getElementById('card-dialog').open`, 'legacy editor');
  assert.equal(await browser.eval(`return document.getElementById('card-prompt').required && document.getElementById('card-prompt-label').textContent==='Prompt';`), true);
  await browser.type('Legacy task'); await enter('card-save'); await browser.until(`!document.getElementById('card-error').hidden`, 'legacy empty body rejected');
  assert.deepEqual((await app.board.state()).runs, []); assert.deepEqual((await app.board.state()).sessions, []);
  assert.deepEqual(browser.consoleMessages.filter(message=>message.startsWith('EXCEPTION')), []);
});

test('an older server session keeps a pipeline prompt required without offering unsupported title-only creation', { skip: !await findChrome(), timeout: 90000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] }), pipeline = defaultPipelineConfig();
  for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  const project = await app.board.createProject({ name: 'Older session' });
  await app.board.setPipeline(project.id, { pipeline, expectedRevision: project.revision, confirm: true });
  const browser = await launch(); if (!browser) { t.skip('Chrome did not start.'); return; } t.after(() => browser.close());
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    const nativeFetch = window.fetch;
    window.__taskPosts = 0;
    window.fetch = async function (...args) {
      if (args[0] === '/api/tasks' && args[1]?.method === 'POST') window.__taskPosts++;
      const response = await Reflect.apply(nativeFetch, this, args);
      if (args[0] !== '/api/session') return response;
      const data = await response.json();
      delete data.capabilities;
      return new Response(JSON.stringify(data), { status: response.status, headers: response.headers });
    };
  ` });
  await browser.goto(`${app.url}/#/kanban`);
  await browser.until(`document.querySelector('#project-select option[value="${project.id}"]')`, 'older session loaded');
  await browser.eval(`document.getElementById('card-new').click();`);
  await browser.until(`document.getElementById('card-dialog').open`, 'older session editor');
  assert.equal(await browser.eval(`return document.getElementById('card-prompt').required && document.getElementById('card-prompt-label').textContent==='Prompt';`), true);
  await browser.eval(`document.getElementById('card-title').value='Title draft';document.getElementById('card-save').click();`);
  await browser.until(`!document.getElementById('card-error').hidden`, 'body required on older session');
  assert.equal(await browser.eval(`return window.__taskPosts;`), 0);
  assert.deepEqual((await app.board.state()).projects[0].tasks, []);
  assert.deepEqual(browser.consoleMessages.filter(message=>message.startsWith('EXCEPTION')), []);
});
