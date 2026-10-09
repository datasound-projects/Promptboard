import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { startServer } from '../src/server.mjs';
import { fakeGh } from './fixtures/fake-gh.mjs';
import { VERSION } from '../src/version.mjs';
import { defaultPipelineConfig } from '../src/pipeline-config.mjs';
import { repositoryPipelineDefinition } from '../src/pipeline-repository.mjs';
import { Board } from '../src/board.mjs';
import { parseAgyModels } from '../src/models.mjs';
import { pickProject, shownProject } from './helpers/projects.mjs';
import { gitIn, catalogs, until, fakeAuth, setup, report, HISTORY_KEY, KANBAN_KEY, serverBoard, serverTasks, column, titles, byText, submitForm, cardItem, goTo, savedStageProject, newCard, click, importFile, gitRepo, fakeExecutor, linkedKanban, unlink, link, moveBy, agentFixture, agentRows } from './helpers/ui-harness.mjs';

test('Kanban model selection keeps CLI default while discovery is pending and ignores replies after switching to inheritance', { skip: process.platform === 'win32' }, async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const ctx = await linkedKanban(t, { catalogReader: async provider => {
    if (provider === 'claude') await pending;
    return { provider, ...catalogs[provider] };
  } });
  const { $, choose, win } = ctx;
  t.after(() => release());
  await ctx.app.board.setWorkflow(ctx.project.id, { workflow: {}, agentDefaults: { provider: 'claude', model: 'saved-model' }, expectedRevision: (await serverBoard(ctx)).projects[0].revision });
  await win.__pbTest.loadBoard();
  assert.equal($('#project-agent-fields [data-field="model"]').value, '__custom__');
  choose('#project-agent-fields [data-field="model"]', '');
  release(); await ctx.idle();
  assert.equal($('#project-agent-fields [data-field="model"]').value, '', 'Discovery must not restore the saved model after the user chooses CLI default.');
  choose('#project-agent-fields [data-field="provider"]', 'codex');
  choose('#project-agent-fields [data-field="provider"]', '');
  await ctx.idle();
  assert.equal($('#project-agent-fields [data-field="provider"]').value, '');
  assert.equal($('#project-agent-fields [data-field="model"]').value, '');
  assert.equal($('#project-agent-fields .model-field').hidden, true);
  assert.equal($('#project-agent-fields [data-field="model-custom"]').value, '', 'Switching provider clears its custom model.');
});

test('ended agent output is available after a restart and remains readable without terminal graphics', { skip: process.platform === 'win32' }, async t => {
  const ctx = await linkedKanban(t);
  const { $, win } = ctx;
  await link(ctx);
  // xterm exists, but its CSP-compatible renderer is unavailable: it must use text.
  win.Terminal = class { constructor() { assert.fail('Do not use the invisible DOM renderer without WebGL.'); } };
  const task = await ctx.app.board.createTask({ projectId: ctx.project.id, title: 'Old Codex run', prompt: 'Fix it.' });
  const now = Date.now();
  await ctx.app.board.store.update(state => state.runs.push({ id: 'old-codex', taskId: task.id, projectId: ctx.project.id, stage: 'executing', status: 'interrupted', createdAt: now, updatedAt: now,
    config: { provider: 'codex', model: 'codex-one' }, branch: 'promptboard/old-task', workspacePath: '/tmp/old-worktree', artifactsDir: 'runs/old-codex' }));
  ctx.executor.artifact = async () => 'Reading parser.mjs\nChanged parser.mjs\nTests passed\n<img src=x onerror="window.__pwned=1">';
  await win.__pbTest.loadBoard(); await ctx.idle();
  cardItem(ctx, 'Old Codex run').querySelector('.kanban-terminal').click(); await ctx.idle();
  const session = win.promptboardDock.sessions.get('old-codex');
  await until(() => session.pre?.textContent.includes('Changed parser.mjs'), 'saved output rendered');
  assert.match($('#dock-details').textContent, /Codex CLI · codex-one/);
  assert.match($('#dock-connection').textContent, /Saved output/);
  assert.equal($('#dock-stop').hidden, true);
  assert.equal($('#dock-copy').hidden, true);
  assert.equal($('#dock-terminals img'), null);
  assert.equal(win.__pwned, undefined);
  assert.equal(ctx.executor.started.length, 0, 'Reading old output never restarts the agent.');
});

// ---- Settings ----

test('every visible setting is stored and changes the app; global settings stay separate from project workflow', { skip: process.platform === 'win32' }, async t => {
  const ctx = await agentFixture(t);
  const { $, win } = ctx;
  const change = (id, value) => { const el = $(id); if (el.type === 'checkbox') el.checked = value; else el.value = value; el.dispatchEvent(new win.Event('change')); };
  assert.equal($('#app-settings-open').getAttribute('aria-label'), 'Settings');
  $('#app-settings-open').click(); await ctx.idle();
  assert.equal($('#app-settings').open, true);
  assert.equal($('#set-project-name').textContent, 'Flow');
  // Theme.
  change('#set-theme', 'dark');
  assert.equal(win.document.documentElement.dataset.theme, 'dark');
  assert.equal(win.localStorage.getItem('ste-prompt-engineer.theme'), 'dark');
  change('#set-theme', 'light');
  assert.equal(win.document.documentElement.dataset.theme, 'light');
  // Global server settings.
  change('#set-max-runs', '3'); await ctx.idle();
  assert.equal((await ctx.app.board.state()).settings.maxConcurrentRuns, 3);
  // The default agent fills stages without their own provider, in every project, but never a stage a project set.
  await ctx.app.board.setWorkflow(ctx.other.id, { workflow: { executing: { policy: 'ask', provider: 'claude', model: 'haiku' } }, expectedRevision: (await ctx.app.board.state()).projects[1].revision });
  change('#set-agent-provider', 'codex'); await ctx.idle();
  change('#set-agent-model', '__custom__'); change('#set-agent-model-custom', 'gpt-test');
  $('#set-agent-save').click(); await ctx.idle();
  const view = await ctx.app.board.view();
  assert.deepEqual((await ctx.app.board.state()).settings.defaultAgent, { provider: 'codex', model: 'gpt-test', effort: '' });
  assert.equal(view.projects[0].effectiveWorkflow.executing.agentSource, 'global');
  assert.equal(view.projects[1].effectiveWorkflow.executing.agentSource, 'stage');
  assert.equal(view.projects[0].effectiveWorkflow.executing.provider, 'codex');
  assert.equal(view.projects[0].effectiveWorkflow.planning.model, 'gpt-test');
  assert.equal(view.projects[1].effectiveWorkflow.executing.provider, 'claude', 'A project stage keeps its own agent.');
  assert.equal(view.projects[1].effectiveWorkflow.executing.model, 'haiku');
  assert.equal(view.projects[1].effectiveWorkflow.planning.provider, 'codex');
  change('#set-agent-model-custom', 'bad model'); $('#set-agent-save').click(); await ctx.idle();
  assert.match($('#app-settings-error').textContent, /model ID/);
  assert.equal((await ctx.app.board.state()).settings.defaultAgent.model, 'gpt-test', 'An invalid value is refused and not stored.');
  // Browser preferences.
  change('#set-start', 'kanban'); change('#set-open-terminal', false); change('#set-keep-tabs', false); change('#set-term-font', '14'); change('#set-dock-start', 'open');
  assert.equal(win.localStorage.getItem('promptboard.settings.start-page'), 'kanban');
  assert.equal(win.localStorage.getItem('promptboard.settings.terminal-font'), '14');
  // Keep tabs off: a run that ends closes its tab (the run history stays on the board).
  win.promptboardDock.selected = 'activity';
  await ctx.app.board.updateRun('run-a', { status: 'succeeded', endedAt: Date.now() });
  await win.__pbTest.loadBoard(); await ctx.idle();
  assert.equal($('#dock-tab-run-a'), null);
  assert.equal((await ctx.app.board.run('run-a')).status, 'succeeded');
  // Close finished tabs.
  change('#set-keep-tabs', true);
  await ctx.app.board.updateRun('run-b', { status: 'cancelled' });
  await win.__pbTest.loadBoard(); await ctx.idle();
  assert.ok($('#dock-tab-run-b'));
  $('#set-clear-tabs').click();
  assert.equal($('#dock-tab-run-b'), null);
  assert.ok($('#dock-tab-run-c'), 'Live runs keep their tab.');
  // Project settings open for the current project only.
  $('#set-workflow').click(); await ctx.idle();
  assert.equal($('#app-settings').open, false);
  assert.equal($('#workflow-dialog').open, true);
  assert.match($('#workflow-dialog-project').textContent, /Flow/i);
});

test('stored settings apply on the next page load: start page, dock state, and open-terminal on run start', { skip: process.platform === 'win32' }, async t => {
  const ctx = await linkedKanban(t, { hash: '', prefs: { 'promptboard.settings.start-page': 'kanban', 'promptboard.settings.dock-start': 'open', 'promptboard.settings.open-terminal': '0' } });
  const { $, win } = ctx;
  assert.equal($('#kanban-view').hidden, false, 'The start page is Kanban.');
  assert.equal(win.location.hash, '#/kanban');
  assert.equal(win.promptboardDock.state, 'open', 'The dock opens as set.');
  await link(ctx);
  await newCard(ctx, 'Parser', 'Fix the parser.');
  win.PromptboardDock.setState('collapsed');
  await moveBy(ctx, 'Parser', 'executing'); await ctx.idle();
  assert.equal(ctx.executor.started.length, 1);
  await until(() => $(`#dock-tab-${ctx.executor.started[0].id}`), 'tab for the new run');
  assert.equal(win.promptboardDock.state, 'collapsed', 'With "open terminal" off, the dock stays collapsed.');
});

test('GitHub in Settings: status, repository search, connect a managed clone, fetch, and disconnect without signing out', { skip: process.platform === 'win32' }, async t => {
  const gh = await fakeGh(t);
  const ctx = await linkedKanban(t);
  const { $, win } = ctx;
  $('#app-settings-open').click();
  await until(() => /Connected as @octo/.test($('#set-github-group').textContent), 'GitHub status');
  assert.doesNotMatch($('#set-github-group').textContent, /Connect GitHub/, 'No sign-in button while connected.');
  const search = $('#github-search');
  search.value = 'app'; search.dispatchEvent(new win.Event('input'));
  await until(() => $('#set-github-group .github-result'), 'search results');
  assert.deepEqual(Array.from($('#set-github-group').querySelectorAll('.github-result'), b => b.textContent), ['acme/app · private · main']);
  $('#set-github-group .github-result').click();
  assert.equal($('#github-branch').value, 'main');
  byText($('#set-github-group'), 'Connect repository').click();
  await until(() => /GitHub: acme\/app \(private\) · Target: main · Remote: origin · Sync: Not fetched yet/.test($('#set-github-group').textContent), 'connected repository');
  const project = (await serverBoard(ctx)).projects[0];
  assert.match(project.repository.root, /\/clones\/acme\/app$/);
  byText($('#set-github-group'), 'Fetch').click();
  await until(() => /Sync: Up to date/.test($('#set-github-group').textContent), 'fetched');
  byText($('#set-github-group'), 'Disconnect…').click();
  byText($('#set-github-group'), 'Disconnect').click();
  await until(() => $('#github-search'), 'disconnected');
  assert.equal((await serverBoard(ctx)).projects[0].github, null);
  assert.ok(!(await gh.log()).some(args => args.includes('logout')));
  // Signed out: the sign-in button appears. Without a terminal library here, it explains the terminal command.
  await gh.setMode('none');
  byText($('#set-github-group'), 'Check connection').click();
  await until(() => byText($('#set-github-group'), 'Connect GitHub'), 'connect button');
  assert.match($('#set-github-group').textContent, /Status: Not connected/);
  assert.equal(win.localStorage.length >= 0 && Object.keys(win.localStorage).some(key => /github|token/i.test(win.localStorage.getItem(key) || '')), false, 'Nothing about GitHub is kept in browser storage.');
});

test('the dock shows usage only as the CLI reported it; context is labelled as context, not progress', { skip: process.platform === 'win32' }, async t => {
  const ctx = await agentFixture(t);
  const { $, win } = ctx;
  win.PromptboardDock.open('run-a'); await ctx.idle();
  assert.match($('#dock-details').textContent, /Usage: not reported yet/);
  assert.doesNotMatch($('#dock-details').textContent, /%/, 'No percentage without a real number.');
  await ctx.app.board.updateRun('run-a', { usage: { source: 'claude-transcript', model: 'claude-opus-5-5', inputTokens: 124000, cachedTokens: 80000, outputTokens: 19000, contextTokens: 42000, contextWindow: 0, updatedAt: Date.now() } });
  await ctx.app.board.updateRun('run-b', { usage: { source: 'codex-rollout', model: 'gpt-5.5', inputTokens: 8000, cachedTokens: 7000, outputTokens: 99, contextTokens: 15000, contextWindow: 200000, rateLimit: { usedPercent: 40 }, updatedAt: Date.now() } });
  await win.__pbTest.loadBoard(); await ctx.idle();
  assert.match($('#dock-details').textContent, /Input 124k · Cached 80k · Output 19k · Context 42k tokens · Reported model claude-opus-5-5/);
  win.PromptboardDock.open('run-b'); await ctx.idle();
  assert.match($('#dock-details').textContent, /Context 8% \(15k of 200k\) · Plan usage 40%/);
  assert.doesNotMatch($('#dock-details').textContent, /Reported model/, 'The reported model equals the requested one.');
});

test('Timeline view: one project, real events grouped by day, completed order, open the task, and add, edit, and remove notes', { skip: process.platform === 'win32' }, async t => {
  const ctx = await agentFixture(t);
  const { $, win } = ctx;
  const board = ctx.app.board;
  await board.updateRun('run-b', { status: 'cancelled', endedAt: Date.now() });
  await board.completeTask(ctx.tasks.b, { kind: 'no_changes', details: {} });
  await win.__pbTest.loadBoard(); await ctx.idle();
  $('#view-timeline').click();
  await until(() => $('#timeline-track .timeline-event'), 'timeline events');
  assert.equal($('#timeline').hidden, false);
  assert.equal($('#kanban-columns').hidden, true);
  assert.equal($('#view-timeline').getAttribute('aria-selected'), 'true');
  assert.equal($('#card-new').hidden, true);
  const text = $('#timeline-track').textContent;
  assert.match(text, /Auth middleware/);
  assert.doesNotMatch(text, /Review docs/, 'Another project’s tasks never appear.');
  assert.match(text, /Executing · Agent run/);
  assert.match(text, /Claude Code · opus · high/);
  assert.match(text, /Completed: no changes required/);
  assert.equal($('#timeline-track .timeline-order').textContent, '#1');
  assert.match($('#timeline-summary').textContent, /2 tasks · 1 completed · 2 agent runs · 0 commits/);
  assert.ok($('#timeline-track .timeline-date'));
  // Completed only.
  $('#timeline-filter').value = 'completed'; $('#timeline-filter').dispatchEvent(new win.Event('change'));
  assert.equal($('#timeline-track').querySelectorAll('.timeline-event').length, 1);
  $('#timeline-filter').value = 'key'; $('#timeline-filter').dispatchEvent(new win.Event('change'));
  // Open the related task.
  byText($('#timeline-track'), 'API tests').click(); await ctx.idle();
  assert.equal($('#task-dialog').open, true);
  $('#task-dialog').close();
  // Add a note linked to a task, edit it, remove it.
  $('#timeline-note-new').click();
  $('#note-title').value = 'Design review';
  $('#note-text').value = 'Agreed on the API.';
  $('#note-task').value = ctx.tasks.a;
  submitForm(ctx, '#timeline-note-form');
  await until(() => /Design review/.test($('#timeline-track').textContent), 'note shown');
  const noteCard = () => Array.from($('#timeline-track').querySelectorAll('.timeline-event[data-kind="note"]'))[0];
  assert.match(noteCard().textContent, /Auth middleware/);
  byText(noteCard(), 'Edit').click();
  assert.equal($('#note-title').value, 'Design review');
  $('#note-title').value = 'Design review, final';
  submitForm(ctx, '#timeline-note-form');
  await until(() => /Design review, final/.test($('#timeline-track').textContent), 'note edited');
  byText(noteCard(), 'Remove').click();
  byText(noteCard(), 'Remove note').click();
  await until(() => !noteCard(), 'note removed');
  assert.equal((await board.state()).projects[0].timelineNotes.length, 0);
  // System events cannot be edited.
  assert.equal(byText($('#timeline-track'), 'Edit'), undefined);
  // The view choice persists; Board brings the columns back.
  assert.equal(win.localStorage.getItem('promptboard.project-view'), 'timeline');
  $('#view-board').click();
  assert.equal($('#kanban-columns').hidden, false);
  assert.equal($('#timeline').hidden, true);
});

test('rapid drops and repeated clicks start exactly one run', { skip: process.platform === 'win32' }, async t => {
  const ctx = await linkedKanban(t);
  const { $, win } = ctx;
  await link(ctx);
  await newCard(ctx, 'Fast', 'Drop me twice.');
  await newCard(ctx, 'Clicked', 'Start me once.');
  // Two drops of the same card send one move and start one run.
  for (let i = 0; i < 2; i++) {
    cardItem(ctx, 'Fast').dispatchEvent(new win.Event('dragstart', { bubbles: true }));
    column($, 'executing').dispatchEvent(new win.Event('drop', { bubbles: true, cancelable: true }));
  }
  await ctx.idle();
  assert.deepEqual(titles($, 'executing'), ['Fast']);
  assert.equal(ctx.executor.started.length, 1);
  assert.equal((await serverTasks(ctx)).find(task => task.title === 'Fast').transitions.length, 1);
  // Two clicks on a card's Start button: one run (the second is refused because the card has an active run).
  await ctx.app.board.setWorkflow(ctx.project.id, { workflow: { planning: { policy: 'manual' } }, expectedRevision: (await serverBoard(ctx)).projects[0].revision });
  await win.__pbTest.loadBoard(); await ctx.idle();
  await moveBy(ctx, 'Clicked', 'planning'); await ctx.idle();
  const start = cardItem(ctx, 'Clicked').querySelector('.kanban-start');
  start.click(); start.click();
  await ctx.idle();
  assert.equal(ctx.executor.started.length, 2);
  assert.deepEqual(ctx.executor.started.map(run => run.stage), ['executing', 'planning']);
});

test('“How your data is used” describes the current app in four short sections', async t => {
  const { $ } = await setup(t);
  $('#privacy-help').click();
  assert.equal($('#help-dialog').open, true);
  assert.deepEqual(Array.from($('#dialog-content').querySelectorAll('h3'), heading => heading.textContent), ['Saved on this computer', 'Sent to your AI provider', 'Accounts and costs', 'What Promptboard does not do']);
  const text = $('#dialog-content').textContent;
  assert.match(text, /when you approve a stage \(or it starts automatically\), the agent CLI gets the card text/);
  assert.doesNotMatch(text, /not active yet|does not send cards/, 'No outdated statement about agent runs.');
});

test('a cancelled split cannot overwrite a new split with a late result or error', async t => {
  const ctx = await setup(t, { executor: null });
  const { $, win } = ctx;
  ctx.quality('fast'); $('#prompt-input').value = 'Add a test.'; ctx.submit();
  await until(() => !$('#split-button').disabled, 'generated prompt');
  const originalFetch = win.fetch;
  for (const outcome of ['result', 'error']) {
    const pending = [];
    win.fetch = (url, options) => url === '/api/split'
      ? new Promise((resolve, reject) => pending.push({ resolve, reject, signal: options.signal }))
      : originalFetch(url, options);
    $('#split-button').click(); await until(() => pending.length === 1, 'first split request');
    $('#split-close').click(); assert.equal(pending[0].signal.aborted, true);
    $('#split-button').click(); await until(() => pending.length === 2, 'replacement split request');
    $('#split-dialog').dispatchEvent(new win.Event('close'));
    assert.equal(pending[1].signal.aborted, false, 'A queued native close from the previous dialog cannot abort its replacement.');
    if (outcome === 'result') pending[0].resolve(Response.json({ tasks: [{ title: 'Stale task', prompt: 'Stale prompt.' }] }));
    else pending[0].reject(new Error('Old request failed late.'));
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal($('#split-list').children.length, 0);
    assert.match($('#split-status').textContent, /is splitting the prompt/);
    assert.equal($('#split-error').hidden, true);
    pending[1].resolve(Response.json({ tasks: [{ title: 'Current task', prompt: 'Add a test.' }], coverage: { status: 'pass', protectedCount: 0, issues: [] } }));
    await until(() => $('#split-list').children.length === 1, 'current split result');
    assert.equal($('#split-list .split-title').value, 'Current task');
    $('#split-close').click();
  }
  win.fetch = originalFetch;
});

test('Split into tasks (optional): ordered, editable tasks become To Do cards, then Autopilot opens with them first', { skip: process.platform === 'win32' }, async t => {
  const tasks = [{ title: 'Add the parser', prompt: 'Add `src/parser.ts`.' }, { title: 'Test the parser', prompt: 'Test `src/parser.ts`.' }, { title: 'Write docs', prompt: 'Document the parser.' }];
  const ctx = await linkedKanban(t, { hash: '', runner: request => ({ text: request.prompt.startsWith('# Task split') ? JSON.stringify({ tasks }) : 'Add, test, and document `src/parser.ts`.', reportedModels: ['m'] }) });
  const { $, win, submit, calls } = ctx;
  await goTo(ctx, '#/');
  $('#prompt-input').value = 'Build a parser with tests and docs.'; submit();
  await until(() => $('#prompt-output').textContent.includes('src/parser.ts') && !$('#split-button').disabled, 'prompt');
  $('#prompt-edit').click();
  const editedPrompt = '  Add, test, and document `src/parser.ts`.\nPreserve this edited requirement.  ';
  $('#prompt-edit-text').value = editedPrompt; $('#prompt-edit-save').click();
  $('#split-button').click();
  await until(() => $('#split-list').children.length === 3, 'task list');
  assert.equal(calls.filter(call => call.prompt.startsWith('# Task split')).length, 1, 'One CLI call.');
  assert.equal(JSON.parse(calls.find(call => call.prompt.startsWith('# Task split')).prompt.split('# Source data\n')[1]).prompt, editedPrompt, 'Split receives the saved edited prompt exactly.');
  assert.match($('#split-status').textContent, /3 tasks, in the order they run/);
  // Reorder: "Write docs" first; leave out "Test the parser"; edit a title.
  $('#split-list').children[2].querySelector('.split-up').click();
  $('#split-list').children[1].querySelector('.split-up').click();
  const items = () => [...$('#split-list').children];
  assert.deepEqual(items().map(item => item.querySelector('.split-title').value), ['Write docs', 'Add the parser', 'Test the parser']);
  const exclude = items()[2].querySelector('input[type="checkbox"]'); exclude.checked = false; exclude.dispatchEvent(new win.Event('change'));
  const title = items()[1].querySelector('.split-title'); title.value = 'Add the parser module'; title.dispatchEvent(new win.Event('input'));
  assert.match($('#split-add').textContent, /Add 2 cards to To Do/);
  submitForm(ctx, '#split-form');
  await until(() => $('#autopilot-dialog').open, 'Autopilot opened');
  const cards = (await serverTasks(ctx)).filter(task => task.column === 'todo');
  assert.deepEqual(cards.map(card => card.title), ['Write docs', 'Add the parser module']);
  assert.equal(cards[1].prompt, 'Add `src/parser.ts`.');
  assert.equal(cards[0].source.provider, 'codex', 'Each card keeps its Compose source.');
  // Autopilot lists the new cards first, included, in that order; nothing starts without consent.
  const queue = [...$('#autopilot-queue').querySelectorAll('.autopilot-item')];
  assert.deepEqual(queue.map(item => item.querySelector('.autopilot-title').textContent).slice(0, 2), ['Write docs', 'Add the parser module']);
  assert.ok(queue.slice(0, 2).every(item => item.querySelector('input[type="checkbox"]').checked));
  assert.equal((await serverBoard(ctx)).projects[0].autopilot?.status ?? 'off', 'off');
});

test('Column Manager: add, name, colour, reorder, and remove custom columns; built-in stages stay fixed; the board and moves follow', { skip: process.platform === 'win32' }, async t => {
  const ctx = await linkedKanban(t);
  const { $, win } = ctx;
  await link(ctx);
  await newCard(ctx, 'Card', 'Do it.');
  await click(ctx, $('#columns-open'));
  assert.equal($('#columns-dialog').open, true);
  const rows = () => [...$('#columns-list').querySelectorAll('.columns-item span')].map(item => item.textContent);
  assert.deepEqual(rows(), ['To Do', 'Planning', 'Executing', 'Code Review', 'Testing', 'Merge', 'Done']);
  assert.equal($('#columns-list').querySelectorAll('.columns-lock').length, 7, 'Built-in stages are fixed.');
  // Select Executing, add a column after it, name it, pick a colour, turn on its agent.
  [...$('#columns-list').querySelectorAll('.columns-item')][2].click();
  $('#columns-add').click();
  const name = $('#column-name'); name.value = 'Blocked'; name.dispatchEvent(new win.Event('input'));
  const red = $('#columns-editor input[value="red"]'); red.checked = true; red.dispatchEvent(new win.Event('change'));
  assert.match($('#columns-editor').textContent, /Cards reach this column from Executing/);
  $('#columns-add').click();
  const second = $('#column-name'); second.value = 'Docs'; second.dispatchEvent(new win.Event('input'));
  const agent = $('#column-agent'); agent.checked = true; agent.dispatchEvent(new win.Event('change'));
  const instructions = $('#column-instructions'); instructions.value = 'Update the docs.'; instructions.dispatchEvent(new win.Event('input'));
  assert.deepEqual(rows(), ['To Do', 'Planning', 'Executing', 'Blocked', 'Docs', 'Code Review', 'Testing', 'Merge', 'Done']);
  // Reorder: Docs to the left of Blocked. Hide Planning.
  [...$('#columns-list').querySelectorAll('.columns-row')][4].querySelector('button[aria-label^="Move left"]').click();
  assert.deepEqual(rows().slice(3, 5), ['Docs', 'Blocked']);
  [...$('#columns-list').querySelectorAll('.columns-item')][1].click();
  const show = $('#column-show'); show.checked = false; show.dispatchEvent(new win.Event('change'));
  submitForm(ctx, '#columns-form'); await ctx.idle();
  assert.equal($('#columns-dialog').open, false);
  const project = (await serverBoard(ctx)).projects[0];
  assert.deepEqual(project.columns.map(column => column.title), ['To Do', 'Executing', 'Docs', 'Blocked', 'Code Review', 'Testing', 'Merge', 'Done']);
  assert.deepEqual([...$('#kanban-columns').querySelectorAll('.kanban-column')].map(column => column.querySelector('h3').textContent), ['To Do', 'Executing', 'Docs', 'Blocked', 'Code Review', 'Testing', 'Merge', 'Done']);
  assert.ok([...$('#kanban-columns').querySelectorAll('.kanban-column')][3].classList.contains('col-red'));
  // The stage menu follows the moves: from To Do only Executing (Planning is hidden).
  assert.deepEqual(Array.from(cardItem(ctx, 'Card').querySelectorAll('.kanban-move-to option'), item => item.textContent), ['Move to…', 'Executing']);
  // Removing a column that holds a card is refused with the reason.
  const card = (await serverTasks(ctx))[0];
  await ctx.app.board.moveTask(card.id, { column: 'executing', expectedRevision: card.revision });
  const blocked = project.columns.find(column => column.title === 'Blocked').id;
  const moved = (await serverTasks(ctx))[0];
  await ctx.app.board.moveTask(moved.id, { column: blocked, expectedRevision: moved.revision });
  await win.__pbTest.loadBoard(); await ctx.idle();
  await click(ctx, $('#columns-open'));
  [...$('#columns-list').querySelectorAll('.columns-item')].find(item => item.textContent.startsWith('Blocked')).click();
  $('#columns-remove').click();
  submitForm(ctx, '#columns-form'); await ctx.idle();
  assert.match($('#columns-error').textContent, /Move the cards out first \(1 in Blocked\)/);
  assert.equal($('#columns-dialog').open, true);
});

test('Start over in task details: says exactly what happens, takes a reason, and can start Executing at once', { skip: process.platform === 'win32' }, async t => {
  const ctx = await linkedKanban(t);
  const { $ } = ctx;
  await link(ctx);
  const board = ctx.app.board;
  await board.setWorkflow(ctx.project.id, { workflow: { executing: { policy: 'manual' } }, expectedRevision: (await serverBoard(ctx)).projects[0].revision });
  const created = await board.createTask({ projectId: ctx.project.id, title: 'Redo', prompt: 'Do it again.' });
  await board.moveTask(created.id, { column: 'executing', expectedRevision: 1 });
  const ws = await board.ensureTaskWorktree(created.id);
  await writeFile(join(ws.path, 'a.txt'), 'first try\n');
  await ctx.win.__pbTest.loadBoard(); await ctx.idle();
  cardItem(ctx, 'Redo').querySelector('.kanban-details').click();
  await until(() => $('#task-details .start-over-open'), 'Start over section');
  await click(ctx, $('#task-details .start-over-open'));
  const text = $('#task-details').textContent;
  assert.match(text, new RegExp(`The branch ${ws.branch.replace(/[/.]/g, '\\$&')} stays exactly as it is \\(0 commits\\)\\. It is not deleted, reset, or pushed\\.`));
  assert.match(text, /1 uncommitted change will be committed to that branch first, so nothing is lost\./);
  assert.match(text, /The card goes to To Do\. Its next run starts a new branch from the current trunk\./);
  $('#start-over-reason').value = 'Wrong file.';
  $('#start-over-now').checked = true;
  await click(ctx, $('#task-details .start-over-confirm'));
  await until(() => !$('#task-dialog').open, 'dialog closed');
  const card = (await serverTasks(ctx))[0];
  assert.deepEqual([card.column, card.previousAttempts[0].reason, card.previousAttempts[0].branch], ['executing', 'Wrong file.', ws.branch]);
  assert.equal(ctx.executor.started.length, 1, 'Start Executing right away started one run.');
  assert.notEqual(ctx.executor.started[0].branch, ws.branch);
  assert.match($('#announcement').textContent, /Started “Redo” over\. Executing started on a fresh branch/);
});

test('To Do prompt entry creates an exact task and optionally sends a draft to Composer', async t => {
  const ctx = await setup(t, { hash: '#/kanban' });
  const { $, win } = ctx;
  await savedStageProject(ctx, 'Prompt entry');
  $('.kanban-add-task').click();
  assert.equal(win.document.activeElement.id, 'card-prompt');
  submitForm(ctx, '#card-form'); await ctx.idle();
  assert.equal($('#card-error').hidden, false);
  const prompt = '  Add a search field.\nKeep keyboard navigation.  ';
  $('#card-prompt').value = prompt;
  submitForm(ctx, '#card-form'); await ctx.idle();
  const cards = await serverTasks(ctx);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].prompt, prompt);
  assert.equal(cards[0].column, 'todo');
  $('.kanban-add-task').click();
  $('#card-prompt').value = 'Refine this request.';
  $('#card-refine').click(); await ctx.idle();
  assert.equal($('#kanban-view').hidden, true);
  assert.equal($('#prompt-input').value, 'Refine this request.');
  assert.equal($('#card-dialog').open, false);
  assert.equal((await serverTasks(ctx)).length, 1);
  ctx.submit();
  await until(() => !$('#generate-button').disabled && ctx.requests.length === 1, 'refinement');
  assert.equal(ctx.requests[0].input, 'Refine this request.');
});

test('Composer saves optional exact edits to history and Kanban, and cancels or rejects empty edits', async t => {
  const ctx = await setup(t);
  const { $, win } = ctx;
  $('#prompt-input').value = 'Make a feature.'; ctx.submit();
  await until(() => !$('#generate-button').disabled && ctx.requests.length === 1, 'generated');
  const original = $('#prompt-output').textContent;
  $('#prompt-edit').click(); $('#prompt-edit-text').value = 'discard me'; $('#prompt-edit-cancel').click();
  assert.equal($('#prompt-output').textContent, original);
  $('#prompt-edit').click(); $('#prompt-edit-text').value = '   '; $('#prompt-edit-save').click();
  assert.equal($('#prompt-edit-error').hidden, false);
  assert.equal($('#kanban-button').disabled, true);
  const edited = '  My exact version.\nKeep `src/a.ts`.  ';
  $('#prompt-edit-text').value = edited; $('#prompt-edit-save').click();
  assert.equal($('#prompt-output').textContent, edited);
  assert.equal($('#verification-report').hidden, true);
  const stored = JSON.parse(win.localStorage.getItem('ste-prompt-engineer.history.v1'));
  assert.equal(stored[0].prompt, edited);
  assert.equal(stored[0].verification, null);
  $('#kanban-button').click();
  assert.equal($('#add-preview').textContent, edited);
  $('#add-project-name').value = 'Edited prompts';
  submitForm(ctx, '#add-form'); await ctx.idle();
  assert.equal((await serverTasks(ctx))[0].prompt, edited);
  $('.history-restore').click(); await ctx.idle();
  assert.equal($('#prompt-output').textContent, edited);
});

test('Agents toolbar configures each project, column overrides, custom agents, and a shared model', async t => {
  const ctx = await linkedKanban(t);
  const { $, choose, win } = ctx;
  await link(ctx);
  const projectId = (await serverBoard(ctx)).projects[0].id;
  await savedStageProject(ctx, 'Independent');
  const otherBefore = (await serverBoard(ctx)).projects.find(project => project.id !== projectId);
  // Return to the linked project and add an agent column.
  const project = (await serverBoard(ctx)).projects.find(project => project.id === projectId);
  const columns = ['todo', 'planning', 'executing', 'code_review', 'testing', 'merge', 'done'].map(id => ({ id }));
  columns.splice(3, 0, { id: 'c_docs0001', custom: true, title: 'Docs', agent: { enabled: true, policy: 'manual', instructions: 'Write docs.' } });
  await ctx.app.board.setColumns(projectId, { columns, expectedRevision: project.revision });
  await win.__pbTest.loadBoard(); await ctx.idle();
  // Select using the workspace control so the test follows the real project selection path.
  const workspace = [...$('#workspace-list').querySelectorAll('button')].find(button => button.textContent.includes(project.name));
  workspace.click(); await ctx.idle();
  $('#agents-open').click(); await ctx.idle();
  const defaults = '#workflow-stages .workflow-defaults';
  choose(`${defaults} [data-field="provider"]`, 'codex'); await ctx.idle();
  choose(`${defaults} [data-field="model"]`, 'codex-one');
  const review = '#workflow-stages [data-stage="code_review"]';
  choose(`${review} [data-field="provider"]`, 'codex'); await ctx.idle();
  choose(`${review} [data-field="model"]`, 'codex-two');
  const custom = '#workflow-stages [data-stage="c_docs0001"]';
  choose(`${custom} [data-field="provider"]`, 'claude'); await ctx.idle();
  choose(`${custom} [data-field="model"]`, 'haiku');
  submitForm(ctx, '#workflow-form'); await ctx.idle();
  let saved = (await serverBoard(ctx)).projects.find(project => project.id === projectId);
  assert.equal(saved.effectiveWorkflow.executing.model, 'codex-one');
  assert.equal(saved.effectiveWorkflow.code_review.model, 'codex-two');
  assert.equal(saved.effectiveWorkflow.c_docs0001.provider, 'claude');
  assert.equal(saved.effectiveWorkflow.c_docs0001.model, 'haiku');
  assert.equal(saved.effectiveWorkflow.c_docs0001.agentSource, 'stage');
  assert.match($('#project-agent-summary').textContent, /Stage overrides:.*Docs/);
  assert.deepEqual((await serverBoard(ctx)).projects.find(project => project.id !== projectId), otherBefore);
  $('#kanban-columns [data-column="c_docs0001"] .column-agent').click(); await ctx.idle();
  assert.equal(win.document.activeElement, $(`${custom} [data-field="provider"]`));
  $('#workflow-use-project-agent').click();
  submitForm(ctx, '#workflow-form'); await ctx.idle();
  saved = (await serverBoard(ctx)).projects.find(project => project.id === projectId);
  for (const id of ['planning', 'executing', 'code_review', 'testing', 'merge', 'c_docs0001']) {
    assert.equal(saved.effectiveWorkflow[id].provider, 'codex');
    assert.equal(saved.effectiveWorkflow[id].model, 'codex-one');
    assert.equal(saved.effectiveWorkflow[id].agentSource, 'project');
  }
  assert.equal(saved.effectiveWorkflow.c_docs0001.policy, 'manual');
  assert.equal(saved.effectiveWorkflow.c_docs0001.instructions, 'Write docs.');
  const reload = await setup(t, { executor: ctx.executor, hash: '#/kanban', dataDir: ctx.dataDir });
  assert.equal((await serverBoard(reload)).projects.find(project => project.id === projectId).effectiveWorkflow.c_docs0001.model, 'codex-one');
});

test('Task card menu edits content and saves independent display preferences with keyboard dismissal', async t => {
  const ctx = await setup(t, { hash: '#/kanban' });
  const { $, win } = ctx;
  await savedStageProject(ctx, 'Card design');
  await newCard(ctx, 'Minimal task', 'Original prompt.');
  await newCard(ctx, 'Another task', 'Keep this card unchanged.');
  let card = cardItem(ctx, 'Minimal task');
  const id = card.dataset.id;
  assert.equal(card.querySelector('.kanban-more').hidden, true);
  assert.ok(card.querySelector('.kanban-more .kanban-move-to'));
  assert.ok(card.querySelector('.kanban-more .kanban-details'));
  assert.ok(card.querySelector('.kanban-more .card-workspace'));
  card.querySelector('.kanban-more-toggle').click();
  for (const field of ['preview', 'agent', 'comfortable']) card.querySelector(`[data-card-display="${field}"]`).click();
  assert.ok(card.classList.contains('hide-preview'));
  assert.ok(card.classList.contains('show-agent'));
  assert.ok(card.classList.contains('comfortable'));
  assert.equal(cardItem(ctx, 'Another task').classList.contains('hide-preview'), false);
  card.querySelector('.card-appearance').open = true;
  card.querySelector('[data-card-display="preview"]').focus();
  await win.__pbTest.loadBoard(); await ctx.idle();
  card = cardItem(ctx, 'Minimal task');
  assert.equal(card.querySelector('.card-appearance').open, true);
  assert.equal(win.document.activeElement.dataset.cardDisplay, 'preview');
  card.querySelector('.kanban-edit').click();
  $('#card-title').value = 'Edited task'; $('#card-prompt').value = '  Exact edited prompt.  ';
  submitForm(ctx, '#card-form'); await ctx.idle();
  card = cardItem(ctx, 'Edited task');
  assert.equal((await serverTasks(ctx)).find(task => task.id === id).prompt, '  Exact edited prompt.  ');
  assert.ok(card.classList.contains('hide-preview'));
  card.querySelector('.kanban-more').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(card.querySelector('.kanban-more').hidden, true);
  assert.equal(win.document.activeElement, card.querySelector('.kanban-more-toggle'));
  const key = `promptboard.card-appearance.${id}`;
  const reload = await setup(t, { hash: '#/kanban', dataDir: ctx.dataDir, prefs: { [key]: win.localStorage.getItem(key) } });
  await reload.idle();
  const restored = cardItem(reload, 'Edited task');
  assert.ok(restored.classList.contains('hide-preview'));
  assert.ok(restored.classList.contains('comfortable'));
  restored.querySelector('.kanban-more-toggle').click();
  restored.querySelector('[data-card-display="preview"]').click();
  assert.equal(restored.classList.contains('hide-preview'), false);
});

test('Shared Settings uses live model catalogs, explicit saves, and model-specific effort', async t => {
  let catalogReads = 0;
  const ctx = await setup(t, { catalogReader: async provider => { catalogReads++; return { provider, ...catalogs[provider] }; } });
  const { $, choose } = ctx;
  $('#app-settings-open').click(); await ctx.idle();
  choose('#set-agent-provider', 'claude'); await ctx.idle();
  choose('#set-agent-model', 'haiku');
  assert.equal($('#set-agent-effort').disabled, true, 'Haiku reports no effort choices.');
  assert.equal((await serverBoard(ctx)).settings.defaultAgent ?? null, null, 'Draft choices do not save automatically.');
  $('#set-agent-save').click(); await ctx.idle();
  assert.equal((await serverBoard(ctx)).settings.defaultAgent.model, 'haiku');
  choose('#set-agent-provider', 'codex'); await ctx.idle();
  choose('#set-agent-model', 'codex-two'); choose('#set-agent-effort', 'low');
  const before = catalogReads;
  $('#set-agent-fields .agent-refresh-models').click(); await ctx.idle();
  assert.ok(catalogReads > before, 'Refresh rereads the CLI catalog.');
  assert.equal($('#set-agent-model').value, 'codex-two');
  assert.equal($('#set-agent-effort').value, 'low');
  $('#set-agent-save').click(); await ctx.idle();
  assert.deepEqual((await serverBoard(ctx)).settings.defaultAgent, { provider: 'codex', model: 'codex-two', effort: 'low' });
  choose('#set-agent-provider', ''); $('#set-agent-save').click(); await ctx.idle();
  assert.equal((await serverBoard(ctx)).settings.defaultAgent, null);
  assert.equal($('#set-agent-fields .model-field').hidden, true);
});

test('Settings connects Composer and Kanban, with universal display defaults and per-card overrides', async t => {
  const ctx = await setup(t, { hash: '#/kanban' });
  const { $, win, choose } = ctx;
  await savedStageProject(ctx, 'Shared settings'); await newCard(ctx, 'Task', 'Do this.');
  $('#app-settings-open').click(); await ctx.idle();
  $('#set-card-preview').click(); $('#set-card-spacing').click();
  let card = cardItem(ctx, 'Task');
  assert.ok(card.classList.contains('hide-preview')); assert.ok(card.classList.contains('comfortable'));
  $('#app-settings-close').click();
  card.querySelector('.kanban-more-toggle').click(); card.querySelector('[data-card-display="preview"]').click();
  assert.equal(card.classList.contains('hide-preview'), false);
  $('#app-settings-open').click(); await ctx.idle();
  $('#set-card-agent').click();
  card = cardItem(ctx, 'Task'); assert.equal(card.classList.contains('hide-preview'), false);
  assert.ok(card.classList.contains('show-agent'));
  $('#app-settings-close').click(); card.querySelector('.card-display-reset').click();
  assert.ok(card.classList.contains('hide-preview'));
  $('#app-settings-open').click(); await ctx.idle(); $('#set-columns').click();
  assert.equal($('#columns-dialog').open, true); $('#columns-close').click();
  $('#app-settings-open').click(); await ctx.idle(); $('#set-compose').click();
  assert.equal($('#prompt-view').hidden, false); assert.equal($('#settings-body').hidden, false);
  assert.equal(win.document.activeElement.id, 'settings-toggle');
  assert.equal($('#view-board').getAttribute('aria-controls'), 'kanban-columns');
  $('#app-settings-open').click(); await ctx.idle();
  choose('#set-max-runs', '2'); choose('#set-max-runs', '4'); await ctx.idle();
  assert.equal((await serverBoard(ctx)).settings.maxConcurrentRuns, 4);
  const reload = await setup(t, { dataDir: ctx.dataDir, hash: '#/kanban', prefs: {
    'promptboard.settings.card-preview': '0', 'promptboard.settings.card-spacing': '1', 'promptboard.settings.terminal-font': 'bad',
  } }); await reload.idle();
  assert.ok(cardItem(reload, 'Task').classList.contains('hide-preview'));
  assert.ok(cardItem(reload, 'Task').classList.contains('comfortable'));
});

test('Task saves ignore repeated submits and Split retries only unsaved cards', async t => {
  const tasks = [{ title: 'First split task', prompt: 'Implement it.' }, { title: 'Second split task', prompt: 'Test it.' }];
  const ctx = await setup(t, { hash: '#/kanban', runner: request => ({ text: request.prompt.startsWith('# Task split') ? JSON.stringify({ tasks }) : 'Implement and test it.', reportedModels: ['m'] }) });
  const { $, win } = ctx;
  await savedStageProject(ctx, 'Retry tasks');
  $('.kanban-add-task').click(); $('#card-prompt').value = 'Create once.';
  submitForm(ctx, '#card-form'); submitForm(ctx, '#card-form'); await ctx.idle();
  assert.equal((await serverTasks(ctx)).length, 1);
  await goTo(ctx, '#/'); ctx.quality('fast'); $('#prompt-input').value = 'Implement and test.'; ctx.submit();
  await until(() => !$('#split-button').disabled, 'generated prompt');
  $('#kanban-button').click(); submitForm(ctx, '#add-form'); submitForm(ctx, '#add-form'); await ctx.idle();
  assert.equal((await serverTasks(ctx)).length, 2);
  $('#split-button').click(); await until(() => $('#split-list').children.length === 2, 'split result');
  $('#split-autopilot').checked = false;
  const originalFetch = win.fetch;
  let creates = 0;
  win.fetch = (url, options) => {
    if (url === '/api/tasks' && options?.method === 'POST' && ++creates === 2) return Promise.resolve(Response.json({ error: 'Temporary save failure.' }, { status: 500 }));
    return originalFetch(url, options);
  };
  submitForm(ctx, '#split-form'); submitForm(ctx, '#split-form');
  await until(() => !$('#split-error').hidden && $('#split-form').getAttribute('aria-busy') === 'false', 'partial failure');
  assert.equal((await serverTasks(ctx)).filter(task => task.title === 'First split task').length, 1);
  assert.equal($('#split-list').children.length, 1);
  assert.match($('#split-error').textContent, /Only unsaved tasks remain/);
  submitForm(ctx, '#split-form'); await ctx.idle();
  assert.equal($('#split-dialog').open, false);
  const saved = await serverTasks(ctx);
  assert.equal(saved.filter(task => task.title === 'First split task').length, 1);
  assert.equal(saved.filter(task => task.title === 'Second split task').length, 1);
});

test('Composer installation status and model availability follow the latest connection check', async t => {
  let installed = true;
  const ctx = await setup(t, { authAdapter: fakeAuth({ installed: async () => installed }) });
  const { $ } = ctx;
  installed = false;
  $('#auth-check').click(); await ctx.idle();
  assert.match($('#provider option:checked').textContent, /not installed/);
  assert.equal($('#connection-install').textContent, 'CLI not installed');
  assert.equal($('#generate-button').disabled, true);
  installed = true;
  $('#auth-check').click(); await ctx.idle();
  assert.doesNotMatch($('#provider option:checked').textContent, /not installed/);
  assert.match($('#connection-install').textContent, /CLI installed/);
  assert.equal($('#generate-button').disabled, false);
  assert.ok($('#model option[value="codex-one"]'));
  assert.match($('#cli-status-label').textContent, /installed/);
});

test('Composer starts with an empty input and no bundled example feature', async t => {
  const { $, submit, calls } = await setup(t);
  assert.equal($('#prompt-input').value, '');
  assert.equal($('#prompt-input').getAttribute('placeholder'), null);
  assert.equal($('#load-example'), null);
  const script = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /load-example|Build a small FastAPI service/);
  $('#prompt-input').value = 'Review my task.';
  submit();
  await until(() => !$('#generate-button').disabled && calls.length > 0, 'generation without example control');
  assert.ok($('#prompt-output').textContent.trim());
});

test('interrupted dirty cards and completed cards delete through HTTP and stay deleted after reload', async t => {
  const ctx = await setup(t);
  await goTo(ctx, '#/kanban'); await savedStageProject(ctx, 'Deletion');
  await newCard(ctx, 'Interrupted work', 'Keep my files.');
  const task = (await serverTasks(ctx))[0];
  const workspace = await ctx.app.board.ensureTaskWorktree(task.id);
  await writeFile(join(workspace.path, 'unfinished.txt'), 'keep this');
  await ctx.app.board.store.update(state => { state.runs.push({ id: 'interrupted-delete', projectId: state.projects[0].id, taskId: task.id, status: 'interrupted', stage: 'executing', updatedAt: Date.now(), config: { provider: 'codex' } }); });
  await ctx.win.__pbTest.loadBoard(); await ctx.idle();
  cardItem(ctx, 'Interrupted work').querySelector('.kanban-delete').click();
  await ctx.win.__pbTest.loadBoard(); await ctx.idle();
  assert.match(ctx.$('#kanban-columns').textContent, /Files and branch are kept/);
  assert.equal(ctx.win.document.activeElement.textContent, 'Keep card');
  byText(ctx.$('#kanban-columns'), 'Keep card').click();
  assert.equal(ctx.$('.kanban-confirm'), null);
  cardItem(ctx, 'Interrupted work').querySelector('.kanban-delete').click();
  await click(ctx, byText(ctx.$('#kanban-columns'), 'Delete card'));
  assert.equal((await serverTasks(ctx)).length, 0);
  assert.equal(await readFile(join(workspace.path, 'unfinished.txt'), 'utf8'), 'keep this');
  assert.equal(ctx.$('#agents-list').children.length, 0);
  await newCard(ctx, 'Completed work', 'Done.');
  const completed = (await serverTasks(ctx))[0];
  await ctx.app.board.store.update(state => { state.projects[0].tasks.find(item => item.id === completed.id).column = 'done'; });
  await ctx.win.__pbTest.loadBoard(); await ctx.idle();
  ctx.$('.kanban-done-all').click();
  ctx.$('#done-dialog .kanban-delete').click();
  byText(ctx.$('#done-dialog'), 'Keep card').click();
  assert.equal(ctx.$('#done-dialog .kanban-confirm'), null);
  ctx.$('#done-dialog .kanban-delete').click();
  await click(ctx, byText(ctx.$('#done-dialog'), 'Delete card'));
  assert.equal(ctx.$('#done-dialog').open, false);
  const fresh = await setup(t, { dataDir: ctx.dataDir });
  assert.equal((await serverTasks(fresh)).length, 0);
});

test('Usage dashboard shows limits, model/tool totals, charts, minute refresh, errors, and focus return', async t => {
  let left = 75, failed = false, reads = 0;
  const provider = () => ({ id: 'codex', name: 'Codex', sessions: 2, inputTokens: 1200, cachedTokens: 100, outputTokens: 50, costUSD: null, costNote: 'Not reported', limits: { status: 'live', checkedAt: Date.now(), windows: [{ label: '5h', remainingPercent: left, usedPercent: 100-left }] }, models: [{ model: 'gpt-test', inputTokens: 1200, cachedTokens: 100, outputTokens: 50 }], tools: [{ name: 'exec_command', count: 3 }], daily: [{ day: '2026-10-02', tokens: 1350 }] });
  const ctx = await setup(t, { usageReader: { get: async () => { reads++; if (failed) throw new Error('private'); return { updatedAt: Date.now(), providers: [provider()] }; } } });
  Object.defineProperty(ctx.win.document, 'hidden', { configurable: true, value: false });
  ctx.$('#usage-open').click(); await ctx.idle();
  assert.match(ctx.$('#usage-providers').textContent, /75% left/);
  assert.equal(ctx.$('#usage-providers progress').value, 75);
  assert.equal(ctx.$('#usage-providers svg').getAttribute('role'), 'img');
  assert.match(ctx.$('#usage-providers').textContent, /gpt-test/);
  assert.match(ctx.$('#usage-providers').textContent, /exec_command · 3/);
  assert.match(ctx.$('#usage-providers').textContent, /Cost not reported/);
  ctx.$('#usage-providers details').open = true;
  left = 62;
  ctx.intervals.findLast(timer => timer.ms === 60000).fn(); await ctx.idle();
  assert.match(ctx.$('#usage-providers').textContent, /62% left/);
  assert.equal(ctx.$('#usage-providers details').open, true);
  failed = true; ctx.$('#usage-refresh').click(); await ctx.idle();
  assert.equal(ctx.$('#usage-error').hidden, false);
  assert.match(ctx.$('#usage-providers').textContent, /62% left/);
  ctx.$('#usage-close').click();
  assert.equal(ctx.win.document.activeElement.id, 'usage-open');
  const before = reads; ctx.intervals.findLast(timer => timer.ms === 60000).fn(); await ctx.idle();
  assert.equal(reads, before);
});

test('Base is the fourth global page, preserves Compose and project state, and supports direct links and browser history', async t => {
  const ctx = await setup(t, { hash: '#/base' }); const { $, win } = ctx;
  await ctx.idle();
  assert.deepEqual([...win.document.querySelectorAll('.page-nav a')].map(link => link.textContent), ['Origin', 'Compose', 'Kanban', 'Base']);
  assert.equal($('#base-view').hidden, false); assert.equal($('#prompt-view').hidden, true); assert.equal($('#kanban-view').hidden, true);
  assert.equal(win.document.title, 'Base · Promptboard');
  assert.equal($('.page-nav [aria-current="page"]').getAttribute('href'), '#/base');
  assert.equal($('#sidebar').hidden, false); assert.equal($('#menu-toggle').hidden, false);
  assert.equal($('#base-sidebar-panel').hidden, false); assert.equal($('#workspace-panel').hidden, true);
  assert.equal($('#sidebar').getAttribute('aria-label'), 'Base library');
  assert.equal($('#base-categories').closest('#base-sidebar-panel') !== null, true);
  assert.equal($('#base-error').hidden, true, $('#base-error').textContent);
  $('#skip-link').dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true })); assert.equal(win.document.activeElement.id, 'base-view'); assert.equal(win.location.hash, '#/base');
  await goTo(ctx, '#/'); $('#prompt-input').value = 'An unfinished Compose draft.';
  await goTo(ctx, '#/kanban'); await savedStageProject(ctx, 'Persistent selection');
  const selected = win.localStorage.getItem('promptboard.kanban.project');
  await goTo(ctx, '#/base'); await until(() => !$('#base-view').hidden, 'Base shown');
  assert.equal($('#prompt-input').value, 'An unfinished Compose draft.');
  assert.equal(win.localStorage.getItem('promptboard.kanban.project'), selected);
  win.history.back(); await until(() => !$('#kanban-view').hidden, 'Back to Kanban');
  win.history.forward(); await until(() => !$('#base-view').hidden, 'Forward to Base');
  $('#new-prompt').click(); await until(() => !$('#prompt-view').hidden, 'Compose action leaves Base');
  assert.equal(win.document.title, 'Compose · Promptboard');
});

test('Base start-page preference applies only without an explicit route', async t => {
  const saved = { 'promptboard.settings.start-page': 'base' };
  const first = await setup(t, { prefs: saved }); await first.idle();
  assert.equal(first.win.location.hash, '#/base'); assert.equal(first.$('#base-view').hidden, false);
  const explicit = await setup(t, { prefs: saved, hash: '#/kanban' }); await explicit.idle();
  assert.equal(explicit.$('#kanban-view').hidden, false); assert.equal(explicit.$('#base-view').hidden, true);
  explicit.$('#app-settings-open').click(); await explicit.idle();
  assert.equal(explicit.$('#set-start').value, 'base');
  assert.ok(explicit.$('#set-base-fields .base-picker'), 'Global agent settings use the shared Base picker.');
});

test('Base skill creation and project assignment persist through the actual authenticated interface', async t => {
  const ctx = await setup(t, { hash: '#/kanban' }); const { $, win } = ctx;
  await savedStageProject(ctx, 'Base project');
  const project = (await serverBoard(ctx)).projects[0];
  await goTo(ctx, '#/base'); await until(() => !$('#base-view').hidden && !$('#base-status').textContent.includes('Loading'), 'Base ready');
  $('#base-new-kind').value = 'skill'; byText($('#base-actions'), 'Create').click();
  $('#base-resource-name').value = 'UI instruction skill'; $('#base-skill-body').value = 'Keep the original task exactly.\n';
  submitForm(ctx, '.base-resource-form'); await ctx.idle();
  const resources = await ctx.app.board.base.list();
  const created = (resources.resources || resources).find(item => item.name === 'UI instruction skill'); assert.ok(created);
  const before = (await serverBoard(ctx)).projects[0]; assert.equal(before.baseBinding, undefined, 'Creating a skill never assigns it.');
  await goTo(ctx, '#/kanban'); $('#project-agent-toggle').click();
  $('#project-agent-fields .base-picker button').click(); await ctx.idle();
  const mode = $('[data-base-mode]'); mode.value = 'extend'; mode.dispatchEvent(new win.Event('change', { bubbles: true }));
  const include = $(`.base-binding-fields [data-resource="${created.id}"]`); include.checked = true; include.dispatchEvent(new win.Event('change', { bubbles: true }));
  submitForm(ctx, '#base-dialog-content form'); await ctx.idle();
  const after = (await serverBoard(ctx)).projects.find(item => item.id === project.id);
  assert.deepEqual(after.baseBinding.include, [{ resourceId: created.id, required: true }]);
  assert.equal(after.agentDefaults?.provider, before.agentDefaults?.provider, 'Resource selection does not change inherited provider.');
  assert.equal((await serverBoard(ctx)).runs.length, 0, 'Assignment never starts a run.');
});

test('Base saves a linked wiki and official MCP preset, then groups them in a pack without executing', async t => {
  const ctx = await setup(t, { hash: '#/base' }); const { $, win } = ctx; await ctx.idle({ requireComplete: true });
  $('#base-new-kind').value = 'knowledge'; byText($('#base-actions'), 'Create').click();
  $('#base-resource-name').value = 'Local wiki'; byText($('#base-detail'), 'Add page').click();
  $('#base-wiki-markdown').value = '# Manual wiki\nKeep this wording unchanged.';
  submitForm(ctx, '.base-resource-form'); await ctx.idle({ requireComplete: true });
  assert.equal($('.base-resource-form .inline-error').hidden, true, $('.base-resource-form .inline-error').textContent);
  let resources = (await ctx.app.board.base.list()).resources;
  const wiki = resources.find(item => item.name === 'Local wiki'); assert.ok(wiki);
  const detail = await ctx.app.board.base.detail(wiki.id); assert.equal(detail.content.pages[0].markdown, '# Manual wiki\nKeep this wording unchanged.');
  byText($('#base-actions'), 'Context7 preset').click(); await ctx.idle({ requireComplete: true });
  assert.equal($('#base-resource-enabled').checked, false); assert.equal($('#base-resource-trust').value, 'untrusted');
  submitForm(ctx, '.base-resource-form'); await ctx.idle({ requireComplete: true });
  resources = (await ctx.app.board.base.list()).resources;
  const mcp = resources.find(item => item.name === 'Context7'); assert.ok(mcp);
  assert.equal(mcp.configuration.headers.Authorization, 'CONTEXT7_AUTHORIZATION'); assert.equal(mcp.connectionTest, undefined);
  $('#base-new-kind').value = 'pack'; byText($('#base-actions'), 'Create').click(); $('#base-resource-name').value = 'Optional documentation';
  for (const id of [wiki.id, mcp.id]) { const input = $(`.base-resource-form [data-resource="${id}"]`); input.checked = true; input.dispatchEvent(new win.Event('change', { bubbles: true })); }
  submitForm(ctx, '.base-resource-form'); await ctx.idle({ requireComplete: true });
  await until(async () => (await ctx.app.board.base.list()).resources.some(item => item.name === 'Optional documentation'), 'pack publication', 15000);
  const pack = (await ctx.app.board.base.list()).resources.find(item => item.name === 'Optional documentation');
  assert.deepEqual(pack.configuration.resources.map(ref => ref.resourceId).sort(), [wiki.id, mcp.id].sort());
  assert.equal((await serverBoard(ctx)).runs.length, 0); assert.equal(ctx.calls.length, 0, 'Library edits never invoke the generation runner.');
});

test('board profile editor shares structure and automations, retains sparse values, and saves task choices without changing exact prompts', async t => {
  const ctx = await setup(t, { executor: null, hash: '#/kanban' }), pipeline = defaultPipelineConfig();
  const project = await ctx.app.board.createProject({ name: 'Profiles UI' });
  for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  pipeline.columns[2].strategy.modelOverride = 'column-pin';
  pipeline.columns[2].automations.onEnter = [{ id: 'shared', name: 'Shared notification', type: 'notify', enabled: false, title: '{{title}}', body: 'Literal body' }];
  await ctx.app.board.setPipeline(project.id, { pipeline, expectedRevision: 1, confirm: true });
  const prompt = '  Exact Composer split <literal>\r\n😀  ';
  const task = await ctx.app.board.createTask({ projectId: project.id, title: 'Exact task', prompt });
  await ctx.win.__pbTest.loadBoard(); await ctx.idle({ requireComplete: true });
  ctx.$('#columns-open').click(); ctx.$('#columns-profile-new').click();
  const malicious = 'Economy <img src=x>'; ctx.$('#columns-profile-name').value = malicious; ctx.$('#columns-profile-name').dispatchEvent(new ctx.win.Event('input'));
  assert.equal(ctx.$('#columns-add').disabled, true); assert.equal(ctx.$('#column-name').disabled, true); assert.equal(ctx.$('#columns-remove').disabled, true);
  assert.equal(ctx.$('#columns-editor img'), null); assert.ok([...ctx.win.document.querySelectorAll('#columns-editor .column-automations input, #columns-editor .column-automations button')].every(control => control.disabled));
  ctx.choose('#profile-modelOverride-mode', 'default'); ctx.choose('#profile-effortOverride-mode', 'override'); ctx.choose('#profile-effortOverride-value', 'low');
  ctx.choose('#profile-autoSpawn-mode', 'override'); ctx.choose('#profile-autoSpawn-value', 'false');
  ctx.choose('#profile-agentOverride-mode', 'override'); ctx.choose('#profile-agentOverride-value', 'codex');
  submitForm(ctx, '#columns-form'); await ctx.idle({ requireComplete: true }); assert.equal(ctx.$('#columns-dialog').open, false);
  let saved = (await ctx.app.board.state()).projects[0], profile = saved.pipeline.profiles[0];
  assert.equal(profile.name, malicious); assert.deepEqual(profile.columns.executing, { autoSpawn: false, agentOverride: 'codex', modelOverride: null, effortOverride: 'low' });
  assert.deepEqual(saved.pipeline.columns[2].automations, pipeline.columns[2].automations); assert.equal(saved.pipeline.columns[2].strategy.modelOverride, 'column-pin');
  ctx.$(`[data-id="${task.id}"] .kanban-open`).click(); ctx.choose('#card-pipeline-profile', profile.id);
  submitForm(ctx, '#card-form'); await ctx.idle({ requireComplete: true });
  let card = (await ctx.app.board.state()).projects[0].tasks[0]; assert.equal(card.profileId, profile.id); assert.equal(card.contentRevision, 1); assert.equal(card.prompt, prompt); assert.equal(card.checksOutdated, false);
  ctx.$(`[data-id="${task.id}"] .kanban-open`).click(); ctx.$('#card-pipeline-mode-override').click();
  assert.equal(ctx.$('#card-pipeline-profile').value, ''); assert.equal(ctx.$('#card-pipeline-profile').disabled, true);
  ctx.choose('#card-pipeline-agentOverride', 'codex'); ctx.$('#card-pipeline-modelOverride').value = 'whole-task'; ctx.$('#card-pipeline-modelOverride').dispatchEvent(new ctx.win.Event('input'));
  ctx.choose('#card-pipeline-permissionMode', 'workspace-write'); submitForm(ctx, '#card-form'); await ctx.idle({ requireComplete: true });
  card = (await ctx.app.board.state()).projects[0].tasks[0]; assert.equal(card.profileId, null); assert.deepEqual(card.agentOverride, { agentOverride: 'codex', modelOverride: 'whole-task', permissionMode: 'workspace-write' }); assert.equal(card.prompt, prompt); assert.equal(card.contentRevision, 1);
  ctx.$('#columns-open').click(); ctx.choose('#columns-profile', profile.id); ctx.$('#columns-profile-duplicate').click();
  const duplicateId = ctx.$('#columns-profile').value; assert.notEqual(duplicateId, profile.id);
  ctx.choose('#profile-modelOverride-mode', 'inherit'); submitForm(ctx, '#columns-form'); await ctx.idle({ requireComplete: true });
  saved = (await ctx.app.board.state()).projects[0]; assert.equal(Object.hasOwn(saved.pipeline.profiles[1].columns.executing, 'modelOverride'), false); assert.equal(saved.pipeline.profiles[0].columns.executing.modelOverride, null);
  ctx.$('#card-new').click(); ctx.$('#card-title').value = 'New profile task'; ctx.$('#card-prompt').value = 'New literal'; ctx.choose('#card-pipeline-profile', duplicateId);
  submitForm(ctx, '#card-form'); await ctx.idle({ requireComplete: true }); const newCard = (await ctx.app.board.state()).projects[0].tasks[1]; assert.equal(newCard.profileId, duplicateId); assert.equal(newCard.column, 'todo');
  ctx.$('#columns-open').click(); ctx.choose('#columns-profile', duplicateId); ctx.$('#columns-profile-delete').click(); ctx.$('#columns-profile-delete-confirm').click();
  submitForm(ctx, '#columns-form'); await ctx.idle({ requireComplete: true }); assert.equal((await ctx.app.board.state()).projects[0].tasks[1].profileId, null);
  assert.deepEqual((await ctx.app.board.state()).runs, []); assert.equal((await ctx.app.board.automationRuns(task.id)).length, 0); assert.equal(ctx.$('#columns-profiles img'), null);
});

test('board profile task drafts retain choices on stale revisions and legacy cards keep the original editor', async t => {
  const ctx = await setup(t, { executor: null, hash: '#/kanban' }), pipeline = defaultPipelineConfig();
  const project = await ctx.app.board.createProject({ name: 'Stale profiles' });
  for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  pipeline.profiles = [{ id: 'profile', name: 'Profile', columns: {} }]; await ctx.app.board.setPipeline(project.id, { pipeline, expectedRevision: 1, confirm: true });
  const task = await ctx.app.board.createTask({ projectId: project.id, title: 'Old title', prompt: '  Keep exact\r\n' });
  await ctx.win.__pbTest.loadBoard(); await ctx.idle({ requireComplete: true }); ctx.$(`[data-id="${task.id}"] .kanban-open`).click(); ctx.choose('#card-pipeline-profile', 'profile');
  await ctx.app.board.updateTask(task.id, { title: 'Concurrent title', expectedRevision: 1 }); await ctx.win.__pbTest.loadBoard();
  submitForm(ctx, '#card-form'); await ctx.idle({ requireComplete: true }); assert.equal(ctx.$('#card-dialog').open, true); assert.equal(ctx.$('#card-pipeline-profile').value, 'profile'); assert.match(ctx.$('#card-error').textContent, /changed/);
  assert.equal((await ctx.app.board.state()).projects[0].tasks[0].title, 'Concurrent title'); assert.equal((await ctx.app.board.state()).projects[0].tasks[0].profileId, undefined);
  ctx.$('#card-cancel').click(); const legacy = await ctx.app.board.createProject({ name: 'Legacy' }); await ctx.win.__pbTest.loadBoard(); await ctx.idle({ requireComplete: true });
  [...ctx.win.document.querySelectorAll('#workspace-list .workspace-item')].find(button => button.textContent.includes(legacy.name)).click(); ctx.$('#card-new').click(); assert.equal(ctx.$('#card-pipeline-settings').children.length, 0);
});
