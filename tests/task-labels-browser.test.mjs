import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const chrome = await findChrome(), malicious = '<img src=x onerror=window.__labelsInjected=true>';
async function keyboard(browser) {
  const key = async (key, code, windowsVirtualKeyCode) => {
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, text: key === 'Enter' ? '\r' : ' ' });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
  };
  const focus = async selector => {
    await browser.until(`document.querySelector(${JSON.stringify(selector)})`, 'keyboard label target');
    await browser.eval(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'});`);
    assert.equal(await browser.layout(`const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return getComputedStyle(e).visibility==='visible' && r.width>0 && r.left>=0 && r.right<=innerWidth;`), true);
    assert.equal(await browser.eval(`const e=document.querySelector(${JSON.stringify(selector)});e.focus();return document.activeElement===e;`), true);
  };
  return {
    enter: async selector => { await focus(selector); await key('Enter', 'Enter', 13); },
    space: async selector => { await focus(selector); await key(' ', 'Space', 32); },
    type: async (selector, text) => { await focus(selector); await browser.eval(`document.querySelector(${JSON.stringify(selector)}).select();`); await browser.type(text); },
  };
}
async function setup(t) {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const project = await app.board.createProject({ name: 'Shared labels', workflowMode: 'pipeline' });
  await app.board.setLabels(project.id, { labels: [{ id: 'bug', name: 'Bug', color: '#c93451' }, { id: 'ui', name: malicious, color: '#4585aa' }], expectedLabelRevision: 0 });
  const exact = '  Composer 雪\r\n{{title}}  ', task = await app.board.createTask({ projectId: project.id, title: 'Engineered task', prompt: exact,
    source: { provider: 'codex', quality: 'reviewed', verification: 'checks-passed' } });
  const browser = await launch(); assert.ok(browser); t.after(() => browser.close());
  t.after(() => { for (const error of browser.consoleMessages.filter(line => line.startsWith('EXCEPTION'))) t.diagnostic(error.slice(0, 1500)); });
  await browser.send('Page.bringToFront');
  return { app, project, task, exact, browser, keys: await keyboard(browser), current: async () => (await app.board.state()).projects[0] };
}

for (const width of [1280, 390]) for (const theme of ['light', 'dark']) test(`keyboard label assignment and shared names/colors fit ${width}/${theme} with exact Composer text and no agents`, { skip: !chrome, timeout: 90000 }, async t => {
  const w = await setup(t), { browser, keys } = w;
  const done = await w.app.board.createTask({ projectId: w.project.id, title: 'Completed labels', labelIds: ['ui'], expectedLabelRevision: 1 });
  await w.app.board.transition(done.id, { column: 'done', expectedRevision: done.revision });
  await browser.goto(w.app.url + '/#/kanban'); await browser.until(`document.querySelector('[data-id="${w.task.id}"] .kanban-open')`, 'labeled board');
  t.diagnostic(`Labels ${width}/${theme}.`);
  await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }); await browser.eval(`document.documentElement.dataset.theme=${JSON.stringify(theme)};`);
  await keys.enter(`[data-id="${w.task.id}"] .kanban-open`);
  await browser.until('document.getElementById("card-dialog").open', 'label card editor');
  assert.equal(await browser.eval('return document.getElementById("card-labels-field").hidden;'), false);
  await keys.space('#card-label-choices input[data-label-id="bug"]');
  await keys.enter('#card-save'); await browser.until('!document.getElementById("card-dialog").open', 'label assigned');
  assert.equal(await browser.eval(`return !!document.querySelector('[data-id="${w.task.id}"] .task-label[data-label-id="bug"]');`), true);
  const before = (await w.current()).tasks.find(task => task.id === w.task.id);
  await keys.enter(`[data-id="${w.task.id}"] .kanban-open`); await keys.enter('#card-labels-manage');
  await browser.until('document.getElementById("labels-dialog").open', 'nested shared editor');
  const name = `Bug ${width} ${theme}`;
  await keys.type('#label-definition-list [data-label-id="bug"] [data-label-field="name"]', name);
  await keys.type('#label-definition-list [data-label-id="bug"] [data-label-field="color"]', '#abcdef');
  assert.equal(await browser.layout(`const d=document.getElementById('labels-dialog');return d.scrollWidth<=d.clientWidth+1 && [...d.querySelectorAll('.label-definition input')].every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;});`), true);
  if (process.env.PB_BROWSER_SHOTS) { await mkdir(process.env.PB_BROWSER_SHOTS, { recursive: true }); await writeFile(join(process.env.PB_BROWSER_SHOTS, `labels-manager-${width}-${theme}.png`), await browser.screenshot()); }
  await keys.enter('#labels-save'); await browser.until('!document.getElementById("labels-dialog").open && document.getElementById("card-dialog").open', 'shared labels saved');
  await browser.until(`document.querySelector('#card-label-choices .task-label[data-label-id="bug"]').textContent===${JSON.stringify(name)}`, 'new shared name');
  assert.equal(await browser.eval('return document.querySelector("#card-label-choices input[data-label-id=bug]").checked;'), true);
  await keys.enter('#card-save'); await browser.until('!document.getElementById("card-dialog").open', 'unchanged task saved');
  const after = (await w.current()).tasks.find(task => task.id === w.task.id); assert.deepEqual(after, before);
  assert.equal(after.prompt, w.exact); assert.equal(after.contentRevision, 1); assert.equal(after.checksOutdated, false); assert.deepEqual(after.source, w.task.source);
  assert.equal(await browser.eval(`return document.querySelector('[data-id="${w.task.id}"] .task-label').style.getPropertyValue('--task-label-color');`), '#abcdef');
  if (await browser.eval(`return document.querySelector('[data-id="${w.task.id}"] .kanban-more-toggle').getAttribute('aria-expanded')!=='true';`)) await keys.enter(`[data-id="${w.task.id}"] .kanban-more-toggle`);
  await browser.until(`document.querySelector('[data-id="${w.task.id}"] .kanban-more-toggle').getAttribute('aria-expanded')==='true'`, 'card actions expanded');
  await keys.enter(`[data-id="${w.task.id}"] .kanban-details`);
  await browser.until('document.getElementById("task-dialog").open && document.querySelector("#task-details-labels .task-label")', 'label details');
  assert.equal(await browser.eval('return document.querySelector("#task-details-labels .task-label").textContent;'), name);
  const detailProject = await w.current(), detailColor = theme === 'light' ? '#102030' : '#405060';
  await w.app.board.setLabels(detailProject.id, { labels: detailProject.labels.map(label => label.id === 'bug' ? { ...label, color: detailColor } : label), expectedLabelRevision: detailProject.labelRevision });
  await browser.until(`document.querySelector('#task-details-labels .task-label').style.getPropertyValue('--task-label-color')===${JSON.stringify(detailColor)}`, 'live detail recoloring');
  assert.deepEqual((await w.current()).tasks.find(task => task.id === w.task.id), after);
  await keys.enter('#task-dialog-close');
  if (process.env.PB_BROWSER_SHOTS) await writeFile(join(process.env.PB_BROWSER_SHOTS, `labels-board-${width}-${theme}.png`), await browser.screenshot());
  await keys.enter('[data-column="done"] .kanban-done-all'); await browser.until('document.getElementById("done-dialog").open && document.querySelector("#archive-rows .task-label")', 'completed labels');
  assert.equal(await browser.eval('return document.querySelector("#archive-rows .task-label").textContent;'), malicious);
  assert.equal(await browser.eval('return !!document.querySelector(".task-label img") || !!window.__labelsInjected;'), false);
  assert.equal(await browser.layout(`const h=document.querySelector('.archive-task-heading');return h.scrollWidth<=h.clientWidth+1;`), true);
  if (await browser.eval('return document.querySelector("#archive-rows input[type=checkbox]").checked;')) await keys.space('#archive-rows input[type=checkbox]');
  await keys.space('#archive-rows input[type=checkbox]');
  const archivedBefore = (await w.current()).tasks.find(task => task.id === done.id), color = theme === 'light' ? '#123456' : '#654321';
  const currentProject = await w.current();
  await w.app.board.setLabels(currentProject.id, { labels: currentProject.labels.map(label => label.id === 'ui' ? { ...label, color } : label), expectedLabelRevision: currentProject.labelRevision });
  await browser.until(`document.querySelector('#archive-rows .task-label[data-label-id="ui"]').style.getPropertyValue('--task-label-color')===${JSON.stringify(color)}`, 'shared archive recoloring');
  assert.equal(await browser.eval('return document.querySelector("#archive-rows input[type=checkbox]").checked;'), true);
  assert.deepEqual((await w.current()).tasks.find(task => task.id === done.id), archivedBefore);
  if (process.env.PB_BROWSER_SHOTS) await writeFile(join(process.env.PB_BROWSER_SHOTS, `labels-archive-${width}-${theme}.png`), await browser.screenshot());
  await keys.enter('#done-dialog-close'); await keys.enter(`[data-id="${w.task.id}"] .kanban-open`);
  await keys.space('#card-label-choices input[data-label-id="bug"]'); await keys.enter('#card-save'); await browser.until('!document.getElementById("card-dialog").open', 'label cleared');
  await keys.enter('#card-new'); await keys.type('#card-title', 'New labeled task'); await keys.enter('#card-labels-manage');
  await keys.enter('#label-add'); await browser.type('Fresh 🌿'); await keys.enter('#labels-save');
  await browser.until('!document.getElementById("labels-dialog").open && document.getElementById("card-dialog").open', 'new shared label');
  const fresh = (await w.current()).labels.find(label => label.name === 'Fresh 🌿'); assert.ok(fresh);
  await keys.space(`#card-label-choices input[data-label-id="${fresh.id}"]`); await keys.enter('#card-save'); await browser.until('!document.getElementById("card-dialog").open', 'new labeled task saved');
  const created = (await w.current()).tasks.at(-1); assert.equal(created.title, 'New labeled task'); assert.deepEqual(created.labelIds, [fresh.id]); assert.equal(created.column, 'todo'); assert.equal(created.prompt, '');
  const state = await w.app.board.state(); assert.deepEqual(state.runs, []); assert.deepEqual(state.sessions, []); assert.deepEqual(browser.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);
});

test('stale label drafts stay editable and explicit reload works; own removal refreshes only metadata while concurrent edits remain guarded', { skip: !chrome, timeout: 90000 }, async t => {
  const w = await setup(t), { browser, keys } = w;
  await w.app.board.updateTask(w.task.id, { labelIds: ['bug'], expectedLabelRevision: 1, expectedRevision: 1 });
  await browser.goto(w.app.url + '/#/kanban'); await browser.until(`document.querySelector('[data-id="${w.task.id}"] .kanban-open')`, 'stale-label board');
  await keys.enter(`[data-id="${w.task.id}"] .kanban-open`); await keys.enter('#card-labels-manage'); await keys.type('#label-definition-list [data-label-id="bug"] [data-label-field="name"]', 'Unsaved draft');
  let project = await w.current(); await w.app.board.setLabels(project.id, { labels: project.labels.map(label => label.id === 'bug' ? { ...label, name: 'Concurrent label' } : label), expectedLabelRevision: project.labelRevision });
  await keys.enter('#labels-save'); await browser.until('!document.getElementById("labels-error").hidden', 'stale catalog refused');
  assert.equal(await browser.eval('return document.getElementById("labels-dialog").open && document.querySelector("#label-definition-list [data-label-id=bug] input").value;'), 'Unsaved draft');
  assert.equal((await w.current()).labels[0].name, 'Concurrent label');
  await keys.enter('#labels-reload'); await browser.until('document.querySelector("#label-definition-list [data-label-id=bug] input").value==="Concurrent label"', 'explicit label reload');
  await keys.enter('#labels-cancel'); await keys.enter('#card-cancel');
  await keys.enter(`[data-id="${w.task.id}"] .kanban-open`); await keys.enter('#card-labels-manage');
  await keys.enter('#label-definition-list [data-label-id="bug"] button'); await keys.enter('#labels-save');
  await browser.until('!document.getElementById("labels-dialog").open && !document.querySelector("#card-label-choices input[data-label-id=bug]")', 'assigned label removed');
  await keys.enter('#card-save'); await browser.until('!document.getElementById("card-dialog").open', 'own catalog removal keeps editor usable');
  let card = (await w.current()).tasks.find(task => task.id === w.task.id); assert.deepEqual(card.labelIds, []); assert.equal(card.prompt, w.exact); assert.equal(card.contentRevision, 1);
  project = await w.current(); await w.app.board.setLabels(project.id, { labels: [...project.labels, { id: 'bug', name: 'Bug', color: '#c93451' }], expectedLabelRevision: project.labelRevision });
  project = await w.current(); card = (await w.app.board.updateTask(card.id, { labelIds: ['bug'], expectedLabelRevision: project.labelRevision, expectedRevision: card.revision })).task;
  await browser.reload(); await browser.until(`document.querySelector('[data-id="${w.task.id}"] .task-label[data-label-id=bug]')`, 'restored label view');
  await keys.enter(`[data-id="${w.task.id}"] .kanban-open`); await keys.enter('#card-labels-manage');
  await w.app.board.updateTask(card.id, { priority: 4, expectedRevision: card.revision });
  await keys.enter('#label-definition-list [data-label-id="bug"] button'); await keys.enter('#labels-save'); await browser.until('!document.getElementById("labels-dialog").open', 'concurrent catalog removal saved');
  await keys.enter('#card-save'); await browser.until('!document.getElementById("card-error").hidden', 'concurrent card change refused');
  card = (await w.current()).tasks.find(task => task.id === w.task.id); assert.equal(card.priority, 4); assert.equal(card.prompt, w.exact); assert.equal(card.contentRevision, 1); assert.deepEqual(card.labelIds, []);
  assert.deepEqual((await w.app.board.state()).runs, []); assert.deepEqual(browser.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);
});

test('older server capabilities hide labels and ordinary card saving omits unsupported fields', { skip: !chrome, timeout: 90000 }, async t => {
  const w = await setup(t), { browser, keys } = w;
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `const nativeFetch=window.fetch;window.__labelPosts=[];window.fetch=async function(...args){if(args[0]==='/api/tasks'&&args[1]?.method==='POST')window.__labelPosts.push(JSON.parse(args[1].body));const r=await Reflect.apply(nativeFetch,this,args);if(args[0]!=='/api/session')return r;const d=await r.json();delete d.capabilities.taskLabels;return new Response(JSON.stringify(d),{status:r.status,headers:r.headers});};` });
  await browser.goto(w.app.url + '/#/kanban'); await browser.until(`document.querySelector('[data-id="${w.task.id}"] .kanban-open')`, 'older label capability');
  await keys.enter('#card-new'); assert.equal(await browser.eval('return document.getElementById("card-labels-field").hidden;'), true);
  await keys.type('#card-title', 'Older server task'); await keys.enter('#card-save'); await browser.until('!document.getElementById("card-dialog").open', 'older labels save');
  assert.deepEqual(await browser.eval('return [Object.hasOwn(window.__labelPosts[0],"labelIds"),Object.hasOwn(window.__labelPosts[0],"expectedLabelRevision")];'), [false, false]);
  assert.deepEqual((await w.app.board.state()).runs, []);
});

test('a deleted card cannot be recreated by saving its open draft after nested label editing', { skip: !chrome, timeout: 90000 }, async t => {
  const w = await setup(t), { browser, keys } = w;
  await browser.goto(w.app.url + '/#/kanban'); await browser.until(`document.querySelector('[data-id="${w.task.id}"] .kanban-open')`, 'card before deletion');
  await keys.enter(`[data-id="${w.task.id}"] .kanban-open`); await keys.enter('#card-labels-manage');
  await browser.until('document.getElementById("labels-dialog").open', 'labels before deletion');
  const task = (await w.current()).tasks.find(row => row.id === w.task.id);
  await w.app.board.deleteTask(task.id, { expectedRevision: task.revision });
  await keys.enter('#labels-save'); await browser.until('!document.getElementById("labels-dialog").open && document.getElementById("card-dialog").open', 'deleted card draft retained');
  await keys.enter('#card-save'); await browser.until('!document.getElementById("card-dialog").open || !document.getElementById("card-error").hidden', 'deleted card save settled');
  assert.deepEqual((await w.current()).tasks, []);
  assert.equal(await browser.eval('return document.getElementById("card-dialog").open && !document.getElementById("card-error").hidden;'), true);
  assert.equal(await browser.eval('return document.getElementById("card-title").value;'), w.task.title);
  const state = await w.app.board.state(); assert.deepEqual(state.runs, []); assert.deepEqual(state.sessions, []);
});
