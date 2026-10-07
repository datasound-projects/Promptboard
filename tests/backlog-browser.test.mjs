import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';
const chrome = await findChrome();
const select = (browser, id, value) => browser.eval(`const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));`);
const search = (browser, value) => browser.eval(`const e=document.getElementById('board-search');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));`);
async function enter(browser, selector) {
  await browser.until(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e&&!e.disabled&&e.getClientRects().length>0;})()`, 'available backlog keyboard target').catch(async error => {
    const observed = await browser.eval(`const e=document.querySelector(${JSON.stringify(selector)});return { selector:${JSON.stringify(selector)}, exists:!!e, disabled:e?.disabled, visible:!!e?.getClientRects().length, active:document.activeElement?.dataset.backlogAction, confirmation:backlogDelete, operation:!!backlogOperation, view:$('#backlog').hidden, error:$('#backlog-error').hidden?null:$('#backlog-error').textContent.slice(0,500), events:window.__backlogKeyboardEvents };`);
    throw new Error(`${error.message}; keyboard diagnostics ${JSON.stringify(observed)}`);
  });
  await browser.eval(`const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});e.focus();`);
  assert.equal(await browser.eval(`return document.activeElement===document.querySelector(${JSON.stringify(selector)});`), true);
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}
const row = (id, action) => `[data-backlog-id="${id}"] [data-backlog-action="${action}"]`;
for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  test(`backlog drafts and shared search/filter/order/promotion use keyboard in ${width}/${theme}`, { skip: !chrome, timeout: 90000 }, async t => {
    const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
    const project = await app.board.createProject({ name: 'Local backlog', workflowMode: 'pipeline' });
    await app.board.setLabels(project.id, { labels: [{ id: 'bug', name: 'Literal <img src=x> 雪', color: '#123456' }], expectedLabelRevision: 0 });
    const exact = '  Engineered\r\n雪 {{title}}\r\n  ';
    const source = { provider: 'codex', language: 'en', quality: 'fast', verification: 'checks-passed', reportedModels: [] };
    const draft = async (title, labelIds = ['bug'], priority = 4) => {
      const owner = (await app.board.state()).projects[0];
      return app.board.createBacklogItem(project.id, { title, prompt: exact, labelIds, priority, source, expectedLabelRevision: 1, expectedBacklogRevision: owner.backlogRevision });
    };
    const first = await draft('First'), hidden = await draft('Hidden', [], 1), second = await draft('Second');
    const card = await app.board.createTask({ projectId: project.id, title: 'Composer card', prompt: exact, labelIds: ['bug'], priority: 4, expectedLabelRevision: 1, source });
    const baseline = await app.board.state();
    const browser = await launch({ width, height: 900 }); assert.ok(browser); t.after(() => browser.close());
    await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('ste-prompt-engineer.theme',${JSON.stringify(theme)});localStorage.setItem('promptboard.kanban.project',${JSON.stringify(project.id)});window.__backlogKeyboardEvents=[];for(const type of ['keydown','keypress','keyup','click','focusin'])document.addEventListener(type,event=>{if(event.target.closest?.('[data-backlog-id]')){window.__backlogKeyboardEvents.push({type,key:event.key,repeat:event.repeat,action:event.target.dataset.backlogAction,active:document.activeElement?.dataset.backlogAction});window.__backlogKeyboardEvents=window.__backlogKeyboardEvents.slice(-24);}},true);window.__writes=[];const nativeFetch=window.fetch;window.fetch=function(...args){if(args[1]?.method&&!['GET','HEAD'].includes(args[1].method))window.__writes.push({url:args[0],body:JSON.parse(args[1].body)});return Reflect.apply(nativeFetch,this,args);};` });
    await browser.goto(app.url + '/#/kanban'); await browser.resize(width, 900); await browser.until(`document.querySelector('[data-id="${card.id}"]')`, 'Composer board');
    assert.equal(await browser.eval('return innerWidth;'), width); assert.equal(await browser.eval("return document.documentElement.dataset.theme || 'light';"), theme);
    assert.equal(await browser.eval('return document.getElementById("board-filter-toolbar").hidden && document.getElementById("board-labels-toolbar").hidden;'), true, 'The Board shows no filter rows.');
    await enter(browser, '#view-backlog'); await browser.until(`document.querySelector('[data-backlog-id="${first.id}"]')`, 'backlog list');
    if (width === 390) assert.equal(await browser.layout('const p=document.getElementById("board-priority-filter").getBoundingClientRect(),s=document.getElementById("board-search").getBoundingClientRect();return p.width>0&&s.width>0&&Math.abs(p.top-s.top)<1&&p.left>=0&&s.right<=innerWidth;'), true, 'Phone filters share one row and leave room for the board.');
    assert.ok(await browser.eval(`return document.querySelector('[data-backlog-id="${first.id}"]').textContent.includes('Created');`));
    await select(browser, 'board-label-filter', 'label:bug'); await select(browser, 'board-priority-filter', '4'); await search(browser, 'ENGINEERED');
    assert.deepEqual(await browser.eval('return [...document.querySelectorAll("#backlog-list > li")].map(e=>e.dataset.backlogId);'), [first.id, second.id]);
    assert.equal(await browser.eval('return document.getElementById("board-count").textContent;'), '2/3');
    await search(browser, '<IMG SRC=X>'); assert.equal(await browser.eval('return document.querySelectorAll("#backlog-list > li").length;'), 2);
    assert.equal(await browser.eval('return !!document.querySelector("#backlog img");'), false);
    await enter(browser, '#view-board'); assert.ok(await browser.eval(`return !!document.querySelector('[data-id="${card.id}"]');`));
    await enter(browser, '#view-timeline'); assert.equal(await browser.eval('return document.getElementById("board-search-field").hidden;'), true);
    await enter(browser, '#view-backlog');
    await select(browser, 'backlog-sort', 'title'); assert.equal(await browser.eval(`return document.querySelector(${JSON.stringify(row(first.id, 'down'))}).disabled;`), true);
    await select(browser, 'backlog-sort', 'manual');
    assert.deepEqual(await app.board.state(), baseline, 'View/filter/search/sort choices are inert.');
    assert.deepEqual(await browser.eval('return window.__writes;'), []);
    await enter(browser, row(second.id, 'up')); await browser.until(`document.querySelector('#backlog-list > li')?.dataset.backlogId===${JSON.stringify(second.id)} && !document.getElementById('backlog-new').disabled`, 'filtered full-order move');
    let owner = (await app.board.state()).projects[0]; assert.deepEqual(owner.backlog.map(item => item.id), [second.id, first.id, hidden.id]);
    assert.deepEqual(await browser.eval('return window.__writes.at(-1).body.ids;'), [second.id, first.id, hidden.id]);
    await browser.eval(`const source=document.querySelector('[data-backlog-id="${first.id}"]'),target=document.querySelector('[data-backlog-id="${second.id}"]'),data=new DataTransfer();source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:data}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));source.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:data}));`);
    await browser.until(`document.querySelector('#backlog-list > li')?.dataset.backlogId===${JSON.stringify(first.id)} && !document.getElementById('backlog-new').disabled`, 'filtered pointer reorder');
    owner = (await app.board.state()).projects[0]; assert.deepEqual(owner.backlog.map(item => item.id), [first.id, second.id, hidden.id]);
    await enter(browser, row(first.id, 'edit')); await browser.until('document.getElementById("backlog-dialog").open', 'draft editor');
    assert.equal(await browser.eval('return document.getElementById("backlog-prompt").value;'), exact.replace(/\r\n/g, '\n'));
    await select(browser, 'backlog-priority', '3'); await enter(browser, '#backlog-form [type=submit]');
    await browser.until('!document.getElementById("backlog-dialog").open', 'metadata save');
    owner = (await app.board.state()).projects[0]; const saved = owner.backlog.find(item => item.id === first.id);
    assert.equal(saved.prompt, exact); assert.equal(saved.checksOutdated, false); assert.deepEqual(saved.source, first.source); assert.equal(saved.priority, 3);
    await select(browser, 'board-priority-filter', 'all'); await search(browser, '');
    if (process.env.PB_BROWSER_SHOTS) { await mkdir(process.env.PB_BROWSER_SHOTS, { recursive: true }); await writeFile(join(process.env.PB_BROWSER_SHOTS, `backlog-${width}-${theme}.png`), await browser.screenshot()); }
    assert.equal(await browser.layout('const r=document.getElementById("backlog-new").getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth;'), true);
    assert.equal(await browser.layout('return document.documentElement.scrollWidth<=innerWidth;'), true);
    await enter(browser, row(first.id, 'promote')); await browser.until(`!document.querySelector('[data-backlog-id="${first.id}"]') && !document.getElementById('backlog-new').disabled`, 'promoted draft');
    owner = (await app.board.state()).projects[0]; const promoted = owner.tasks.find(task => task.id === first.id);
    assert.equal(promoted.column, 'todo'); assert.equal(promoted.number, 2); assert.equal(promoted.createdAt, first.createdAt); assert.equal(promoted.prompt, exact); assert.deepEqual(promoted.labelIds, ['bug']); assert.equal(promoted.priority, 3); assert.deepEqual(promoted.source, first.source);
    assert.equal(owner.tasks.find(task => task.id === card.id).prompt, exact, 'Composer card stays exact and separate.');
    await enter(browser, '#backlog-new'); await browser.until('document.getElementById("backlog-dialog").open', 'new draft');
    await browser.eval('document.getElementById("backlog-title").focus();'); await browser.type('Title only'); await enter(browser, '#backlog-form [type=submit]');
    await browser.until('!document.getElementById("backlog-dialog").open', 'title-only draft saved');
    owner = (await app.board.state()).projects[0]; const titleOnly = owner.backlog.find(item => item.title === 'Title only'); assert.ok(titleOnly); assert.equal(titleOnly.prompt, ''); assert.equal(owner.nextTaskNumber, 3);
    await browser.until(`board?.projects.find(p=>p.id===${JSON.stringify(project.id)})?.backlogRevision===${owner.backlogRevision} && !document.getElementById('backlog-new').disabled`, 'published new draft visible before deletion');
    await select(browser, 'board-label-filter', 'all'); await enter(browser, row(titleOnly.id, 'delete')); await enter(browser, row(titleOnly.id, 'keep')); assert.ok((await app.board.state()).projects[0].backlog.some(item => item.id === titleOnly.id));
    await enter(browser, row(titleOnly.id, 'delete')); await enter(browser, row(titleOnly.id, 'confirm-delete')); await browser.until(`!document.querySelector('[data-backlog-id="${titleOnly.id}"]') && !document.getElementById('backlog-new').disabled`, 'explicit draft deletion').catch(async error => {
      const observed = await browser.eval('return { error:document.getElementById("backlog-error").textContent, hidden:document.getElementById("backlog-error").hidden, writes:window.__writes.slice(-3), revision:board?.revision, backlogRevision:board?.projects.find(p=>p.id===document.getElementById("project-select").value)?.backlogRevision };');
      throw new Error(`${error.message}; deletion diagnostics ${JSON.stringify(observed)}; saved backlog revision ${(await app.board.state()).projects[0].backlogRevision}`);
    });
    const state = await app.board.state(); assert.deepEqual(state.runs, []); assert.deepEqual(state.sessions, []); assert.equal(state.projects[0].revision, baseline.projects[0].revision);
    assert.deepEqual(browser.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);
  });
}

test('stale backlog edits retain typed content, explicit reload reads the current item, and requests remain project scoped', { skip: !chrome, timeout: 60000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const project = await app.board.createProject({ name: 'Draft owner', workflowMode: 'pipeline' });
  const other = await app.board.createProject({ name: 'Other project', workflowMode: 'pipeline' });
  const item = await app.board.createBacklogItem(project.id, { title: 'Original', prompt: 'exact\r\nbody', expectedBacklogRevision: 0, expectedLabelRevision: 0 });
  const browser = await launch(); assert.ok(browser); t.after(() => browser.close());
  await browser.goto(app.url + '/#/kanban'); await select(browser, 'project-select', project.id); await enter(browser, '#view-backlog'); await enter(browser, row(item.id, 'edit'));
  await browser.until('document.getElementById("backlog-dialog").open', 'owned editor');
  await browser.eval('document.getElementById("backlog-title").value="My draft";');
  await app.board.updateBacklogItem(project.id, item.id, { title: 'Concurrent title', expectedRevision: 1 });
  await enter(browser, '#backlog-form [type=submit]'); await browser.until('!document.getElementById("backlog-draft-error").hidden', 'stale draft conflict');
  assert.equal(await browser.eval('return document.getElementById("backlog-title").value;'), 'My draft'); assert.equal((await app.board.state()).projects[0].backlog[0].title, 'Concurrent title');
  await enter(browser, '#backlog-reload'); await browser.until('document.getElementById("backlog-title").value==="Concurrent title"', 'explicit reload');
  await browser.eval('document.getElementById("backlog-title").value="Owned edit";document.getElementById("project-select").value=' + JSON.stringify(other.id) + ';document.getElementById("project-select").dispatchEvent(new Event("change",{bubbles:true}));');
  await enter(browser, '#backlog-form [type=submit]'); await browser.until('!document.getElementById("backlog-dialog").open', 'captured owner save');
  let state = await app.board.state(); assert.equal(state.projects[0].backlog[0].title, 'Owned edit'); assert.deepEqual(state.projects[1].backlog, []);
  await select(browser, 'project-select', project.id); await enter(browser, row(item.id, 'edit')); await browser.until('document.getElementById("backlog-dialog").open', 'deleted draft editor');
  const current = state.projects[0]; await app.board.deleteBacklogItem(project.id, item.id, { expectedRevision: current.backlog[0].revision, expectedBacklogRevision: current.backlogRevision });
  await enter(browser, '#backlog-form [type=submit]'); await browser.until('!document.getElementById("backlog-draft-error").hidden', 'deleted draft refusal');
  state = await app.board.state(); assert.equal(state.projects[0].backlog.length, 0); assert.equal(state.projects[0].tasks.length, 0); assert.deepEqual(state.runs, []);
});

test('older servers and legacy projects fall back from a saved Backlog view without hiding cards', { skip: !chrome, timeout: 60000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const project = await app.board.createProject({ name: 'Old capability', workflowMode: 'pipeline' });
  const card = await app.board.createTask({ projectId: project.id, title: 'Visible' });
  const legacy = await app.board.createProject({ name: 'Legacy', workflowMode: 'legacy' }); const old = await app.board.createTask({ projectId: legacy.id, title: 'Legacy visible', prompt: 'Required' });
  const baseline = await app.board.state();
  const browser = await launch(); assert.ok(browser); t.after(() => browser.close());
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('promptboard.project-view','backlog');const nativeFetch=window.fetch;window.fetch=async function(...args){const r=await Reflect.apply(nativeFetch,this,args);if(args[0]!=='/api/session')return r;const d=await r.json();delete d.capabilities.pipelineBacklog;return new Response(JSON.stringify(d),{status:r.status,headers:r.headers});};` });
  await browser.goto(app.url + '/#/kanban'); await browser.until(`document.querySelector('[data-id="${card.id}"]')`, 'old capability fallback');
  assert.equal(await browser.eval('return document.getElementById("view-backlog").hidden;'), true); assert.equal(await browser.eval('return document.getElementById("board-search-field").hidden;'), true); assert.equal(await browser.eval('return document.getElementById("kanban-columns").hidden;'), false);
  await select(browser, 'project-select', legacy.id); await browser.until(`document.querySelector('[data-id="${old.id}"]')`, 'legacy fallback'); assert.equal(await browser.eval('return document.getElementById("view-backlog").hidden;'), true);
  assert.deepEqual(await app.board.state(), baseline);
});

test('shared text search follows project label names and exact descriptions, and completed search retains number lookup', { skip: !chrome, timeout: 60000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const project = await app.board.createProject({ name: 'Shared search', workflowMode: 'pipeline' });
  const other = await app.board.createProject({ name: 'Separate search', workflowMode: 'pipeline' });
  await app.board.setLabels(project.id, { labels: [{ id: 'label', name: 'Original label', color: '#123456' }], expectedLabelRevision: 0 });
  const item = await app.board.createBacklogItem(project.id, { title: 'Draft', prompt: 'Unique description 雪', labelIds: ['label'], expectedBacklogRevision: 0, expectedLabelRevision: 1 });
  const task = await app.board.createTask({ projectId: project.id, title: 'Card', prompt: 'Unique description 雪', labelIds: ['label'], expectedLabelRevision: 1 });
  await app.board.transition(task.id, { column: 'done', expectedRevision: task.revision });
  const otherTask = await app.board.createTask({ projectId: other.id, title: 'Other' });
  const browser = await launch(); assert.ok(browser); t.after(() => browser.close()); await browser.goto(app.url + '/#/kanban');
  await select(browser, 'project-select', project.id); await enter(browser, '#view-backlog'); await search(browser, 'Unique description'); assert.ok(await browser.eval(`return !!document.querySelector('[data-backlog-id="${item.id}"]');`));
  await search(browser, 'Original label');
  await app.board.setLabels(project.id, { labels: [{ id: 'label', name: 'Renamed label', color: '#654321' }], expectedLabelRevision: 1 });
  await browser.until('document.querySelectorAll("#backlog-list > li").length===0', 'search reflects renamed labels');
  await search(browser, 'Renamed label'); assert.ok(await browser.eval(`return !!document.querySelector('[data-backlog-id="${item.id}"]');`));
  await select(browser, 'project-select', other.id); await enter(browser, '#view-board'); assert.equal(await browser.eval('return document.getElementById("board-search").value;'), ''); assert.ok(await browser.eval(`return !!document.querySelector('[data-id="${otherTask.id}"]');`));
  await select(browser, 'project-select', project.id); assert.equal(await browser.eval('return document.getElementById("board-search").value;'), 'Renamed label');
  await enter(browser, '[data-column=done] .kanban-done-all'); await browser.until('document.getElementById("done-dialog").open && document.querySelector("#archive-rows input")', 'searched archive');
  await browser.eval('const e=document.querySelector("#archive-rows input");e.checked=true;e.dispatchEvent(new Event("change",{bubbles:true}));');
  for (const query of ['Unique description', 'Renamed label', '#' + task.number]) {
    await browser.eval(`const e=document.getElementById('archive-filter');e.value=${JSON.stringify(query)};e.dispatchEvent(new Event('input',{bubbles:true}));`);
    assert.equal(await browser.eval('return document.getElementById("archive-count").textContent;'), '1 of 1 tasks'); assert.equal(await browser.eval('return document.querySelector("#archive-rows input").checked;'), true);
  }
  await browser.eval('const e=document.getElementById("archive-filter");e.value="absent";e.dispatchEvent(new Event("input",{bubbles:true}));'); assert.equal(await browser.eval('return document.getElementById("archive-count").textContent;'), '0 of 1 tasks');
  await browser.eval('const e=document.getElementById("archive-filter");e.value="Renamed label";e.dispatchEvent(new Event("input",{bubbles:true}));');
  await app.board.setLabels(project.id, { labels: [], expectedLabelRevision: 2 });
  await browser.until('document.getElementById("archive-count").textContent==="0 of 1 tasks"', 'archive responds to shared label text removal');
  await enter(browser, '#done-dialog-close'); await search(browser, ''); assert.ok(await browser.eval(`return !!document.querySelector('[data-id="${task.id}"]');`));
  const state = await app.board.state(); assert.equal(state.projects[0].backlog[0].prompt, 'Unique description 雪'); assert.equal(state.projects[0].tasks[0].prompt, 'Unique description 雪'); assert.deepEqual(state.runs, []); assert.deepEqual(state.sessions, []);
});

test('a stale new draft refreshes list and label choices explicitly while retaining typed work', { skip: !chrome, timeout: 60000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const project = await app.board.createProject({ name: 'New draft conflicts', workflowMode: 'pipeline' });
  await app.board.setLabels(project.id, { labels: [{ id: 'keep', name: 'Keep', color: '#123456' }, { id: 'remove', name: 'Remove', color: '#654321' }], expectedLabelRevision: 0 });
  const browser = await launch(); assert.ok(browser); t.after(() => browser.close()); await browser.goto(app.url + '/#/kanban');
  await enter(browser, '#view-backlog'); await enter(browser, '#backlog-new'); await browser.until('document.getElementById("backlog-dialog").open', 'new conflict editor');
  await browser.eval('document.getElementById("backlog-title").value="My unsaved draft";document.getElementById("backlog-prompt").value="typed 雪";for(const e of document.querySelectorAll("#backlog-label-choices input")){e.checked=true;e.dispatchEvent(new Event("change",{bubbles:true}));}');
  await select(browser, 'backlog-priority', '3');
  await app.board.createBacklogItem(project.id, { title: 'Other draft', expectedBacklogRevision: 0, expectedLabelRevision: 1 });
  await enter(browser, '#backlog-form [type=submit]'); await browser.until('!document.getElementById("backlog-draft-error").hidden', 'new list conflict');
  await app.board.setLabels(project.id, { labels: [{ id: 'keep', name: 'Renamed keep', color: '#abcdef' }], expectedLabelRevision: 1 });
  await enter(browser, '#backlog-reload'); await browser.until('document.querySelector("#backlog-label-choices input[data-label-id=keep]")?.checked && document.getElementById("backlog-draft-error").hidden', 'explicit new choices refresh');
  assert.equal(await browser.eval('return document.getElementById("backlog-title").value;'), 'My unsaved draft'); assert.equal(await browser.eval('return document.getElementById("backlog-prompt").value;'), 'typed 雪'); assert.equal(await browser.eval('return document.getElementById("backlog-priority").value;'), '3');
  assert.equal(await browser.eval('return document.querySelectorAll("#backlog-label-choices input").length;'), 1);
  await enter(browser, '#backlog-form [type=submit]'); await browser.until('!document.getElementById("backlog-dialog").open', 'refreshed new draft save');
  const state = await app.board.state(); assert.equal(state.projects[0].backlog.length, 2); const saved = state.projects[0].backlog[1]; assert.equal(saved.title, 'My unsaved draft'); assert.equal(saved.prompt, 'typed 雪'); assert.equal(saved.priority, 3); assert.deepEqual(saved.labelIds, ['keep']); assert.deepEqual(state.projects[0].tasks, []); assert.deepEqual(state.runs, []);
});

test('queued backlog dialog close preserves later row focus and a reopened draft', { skip: !chrome, timeout: 60000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const project = await app.board.createProject({ name: 'Backlog dialog ownership', workflowMode: 'pipeline' });
  const item = await app.board.createBacklogItem(project.id, { title: 'Keep this draft', prompt: 'exact\r\nbody', expectedBacklogRevision: 0, expectedLabelRevision: 0 });
  const browser = await launch(); assert.ok(browser); t.after(() => browser.close());
  await browser.goto(app.url + '/#/kanban'); await enter(browser, '#view-backlog');
  await browser.until(`document.querySelector(${JSON.stringify(row(item.id, 'delete'))})`, 'owned draft row');
  const baseline = await app.board.state();
  assert.equal(await browser.eval(`return new Promise(resolve => {
    const dialog=$('#backlog-dialog');openBacklogDraft(${JSON.stringify(project.id)});
    dialog.addEventListener('close',()=>resolve(document.activeElement.dataset.backlogAction),{once:true});
    dialog.close();document.querySelector(${JSON.stringify(row(item.id, 'delete'))}).focus();
  });`), 'delete', 'A queued close must not redirect the next Enter to New draft.');
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  assert.equal(await browser.eval(`return document.activeElement===document.querySelector(${JSON.stringify(row(item.id, 'keep'))});`), true, 'Deletion still defaults to Keep draft.');
  await enter(browser, row(item.id, 'keep'));
  assert.deepEqual(await browser.eval(`return new Promise(resolve => {
    const dialog=$('#backlog-dialog');openBacklogDraft(${JSON.stringify(project.id)});
    dialog.addEventListener('close',()=>resolve({open:dialog.open,id:backlogDraft?.item?.id,focus:dialog.contains(document.activeElement)}),{once:true});
    dialog.close();openBacklogDraft(${JSON.stringify(project.id)},${JSON.stringify(item.id)});
  });`), { open: true, id: item.id, focus: true }, 'An old close event cannot discard or defocus a reopened editor.');
  await browser.eval(`return new Promise(resolve=>{$('#backlog-dialog').addEventListener('close',resolve,{once:true});$('#backlog-dialog').close();});`);
  assert.deepEqual(await app.board.state(), baseline);
  assert.deepEqual(browser.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);
});
