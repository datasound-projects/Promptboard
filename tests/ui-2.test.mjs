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

test('page navigation keeps unsaved prompt input, settings, and the current result', async t => {
  const ctx = await setup(t, { generationResponse: { prompt: 'Add a test.', verification: report() } });
  const { $, win, submit, requests } = ctx;
  $('#prompt-input').value = 'First request.'; submit();
  await until(() => requests.length === 1 && !$('#generate-button').disabled, 'result');
  $('#prompt-input').value = 'Unsaved next idea.';
  $('#terminology').value = 'FastAPI';
  // jsdom does not follow link clicks, so navigate the same way a link does: by hash.
  assert.equal($('.brand').getAttribute('href'), '#/');
  await goTo(ctx, $('.page-nav a[href="#/kanban"]').getAttribute('href'));
  assert.equal($('#prompt-view').hidden, true);
  assert.equal($('.page-nav a[href="#/kanban"]').getAttribute('aria-current'), 'page');
  assert.equal($('.page-nav a[href="#/"]').hasAttribute('aria-current'), false);
  assert.match(win.document.title, /Kanban/);
  await savedStageProject(ctx, 'Alpha');
  $('#card-new').click();
  // Shortcuts from Kanban fields never start a generation or clear the prompt form.
  $('#card-prompt').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  win.document.body.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'n', bubbles: true }));
  $('#card-cancel').click();
  assert.equal(requests.length, 1);
  await goTo(ctx, $('.page-nav a[href="#/"]').getAttribute('href'));
  assert.equal($('.page-nav a[href="#/"]').getAttribute('aria-current'), 'page');
  assert.equal($('#prompt-input').value, 'Unsaved next idea.');
  assert.equal($('#terminology').value, 'FastAPI');
  assert.equal($('#prompt-output').textContent, 'Add a test.');
  // A reload on the Kanban address opens the Kanban page with the server's board.
  const reloaded = await setup(t, { hash: '#/kanban', dataDir: ctx.dataDir });
  await reloaded.idle();
  assert.equal(reloaded.$('#kanban-view').hidden, false);
  assert.equal(reloaded.shownName(), 'Alpha');
});

test('Add to Kanban stores an exact prompt snapshot in To Do; card edits never change history', async t => {
  const exact = '  Leading spaces stay.\r\nCRLF line.\n\n\tTabbed <script>alert(1)</script> — ünïcødé ✓ 🚀\n' + 'Long line. '.repeat(80) + '\n  trailing  \n';
  let result = { prompt: exact, provider: 'codex', reportedModels: ['actual-model'], verification: report({ status: 'needs-review' }) };
  const ctx = await setup(t, { generationResponse: () => result });
  const { $, win, submit, requests, choose, radio, copied } = ctx;
  choose('#model', 'codex-one'); choose('#effort', 'high'); radio('de');
  $('#prompt-input').value = 'Build   the\nexport endpoint with tests.'; submit();
  await until(() => requests.length === 1 && !$('#generate-button').disabled, 'result');
  const entry = JSON.parse(win.localStorage.getItem(HISTORY_KEY))[0];
  $('#kanban-button').click();
  assert.equal($('#add-dialog').open, true);
  assert.equal($('#add-project').value, '');
  assert.equal($('#add-project-name-field').hidden, false);
  assert.equal($('#add-title').value, 'Build the export endpoint with tests.');
  assert.equal($('#add-preview').textContent, exact);
  assert.match($('#add-note').textContent, /exact prompt/);
  submitForm(ctx, '#add-form'); await ctx.idle();
  assert.match($('#add-error').textContent, /project name/);
  assert.equal((await serverBoard(ctx)).projects.length, 0);
  $('#add-project-name').value = 'Alpha';
  submitForm(ctx, '#add-form'); await ctx.idle();
  assert.equal($('#add-dialog').open, false);
  const [card] = await serverTasks(ctx);
  assert.equal(card.prompt, exact);
  assert.equal(card.column, 'todo');
  assert.equal(card.title, 'Build the export endpoint with tests.');
  assert.deepEqual(card.source, { historyId: entry.id, provider: 'codex', model: 'codex-one', effort: 'high', reportedModels: ['actual-model'], language: 'de', quality: 'reviewed', verification: 'needs-review', generatedAt: entry.createdAt });
  assert.equal(card.checksOutdated, false);
  assert.equal(win.localStorage.getItem(KANBAN_KEY), null, 'The browser no longer stores the board.');
  // A second prompt goes to the preselected existing project.
  result = { prompt: 'Second prompt.', provider: 'codex', verification: report() };
  submit(); await until(() => requests.length === 2 && !$('#generate-button').disabled, 'second result');
  $('#kanban-button').click();
  assert.equal($('#add-project').value, (await serverBoard(ctx)).projects[0].id);
  assert.equal($('#add-project-name-field').hidden, true);
  submitForm(ctx, '#add-form'); await ctx.idle();
  assert.equal((await serverBoard(ctx)).projects.length, 1);
  assert.deepEqual((await serverBoard(ctx)).runs, [], 'Adding a card never starts a run.');
  await goTo(ctx, '#/kanban');
  const [draft, passed] = column($, 'todo').children;
  assert.ok(draft.classList.contains('needs-review'));
  assert.equal(draft.querySelector('.kanban-status').textContent, 'Draft—review needed');
  assert.equal(draft.querySelector('.kanban-meta').textContent, 'Prompt source: Codex · codex-one · Deutsch');
  assert.ok(draft.querySelector('.kanban-preview').textContent.length <= 400);
  assert.equal($('#kanban-columns script'), null);
  assert.equal(passed.querySelector('.kanban-status').textContent, 'Checks complete—review before use');
  draft.querySelector('.kanban-copy').click();
  await until(() => copied() === exact, 'exact copy');
  // Open and save without changes: the stored text and status stay the same.
  draft.querySelector('.kanban-open').click();
  assert.match($('#card-note').textContent, /marks the previous checks as outdated/);
  assert.match($('#card-source-list').textContent, /Models reported: actual-model/);
  submitForm(ctx, '#card-form'); await ctx.idle();
  assert.equal((await serverTasks(ctx))[0].prompt, exact);
  assert.equal((await serverTasks(ctx))[0].checksOutdated, false);
  // A real edit marks the old checks as outdated and leaves history alone.
  column($, 'todo').querySelector('.kanban-open').click();
  $('#card-prompt').value = 'Edited prompt.';
  submitForm(ctx, '#card-form'); await ctx.idle();
  const edited = (await serverTasks(ctx))[0];
  assert.equal(edited.prompt, 'Edited prompt.');
  assert.equal(edited.checksOutdated, true);
  assert.equal(edited.source.verification, 'needs-review');
  assert.equal(column($, 'todo').querySelector('.kanban-status').textContent, 'Edited—previous checks outdated');
  assert.deepEqual(JSON.parse(win.localStorage.getItem(HISTORY_KEY)).find(item => item.id === entry.id), entry);
});

test('projects keep separate boards; names are validated; deletion needs confirmation', async t => {
  const history = [{ id: 'h1', input: 'Old request.', prompt: 'Old prompt.', provider: 'codex' }];
  const ctx = await setup(t, { storage: history });
  const { $, win, choose } = ctx;
  await goTo(ctx, '#/kanban');
  assert.match($('#board-empty').textContent, /Create a project to start planning/);
  assert.match($('#project-form-note').textContent, /Promptboard\/projects.*existing code.*Open folder.*stays at its current location/);
  assert.equal($('#card-new').disabled, true);
  assert.equal($('#workspace-list').children.length, 0);
  assert.equal($('#kanban-columns').hidden, true);
  await savedStageProject(ctx, 'Alpha');
  const alpha = ctx.shown();
  await newCard(ctx, 'A1', 'Prompt A1'); await newCard(ctx, 'A2', 'Prompt A2');
  await savedStageProject(ctx, 'Beta');
  assert.notEqual(ctx.shown(), alpha);
  assert.deepEqual(titles($), []);
  assert.equal($('#board-empty').hidden, true, 'An empty project shows its columns, not a message.');
  await newCard(ctx, 'B1', 'Prompt B1');
  ctx.pick(alpha);
  assert.deepEqual(titles($), ['A1', 'A2']);
  assert.equal($('#board-count').textContent, '02');
  // On Kanban the sidebar is the project workspace, not prompt history; it switches boards too.
  assert.equal($('#history-panel').hidden, true);
  assert.equal($('#workspace-panel').hidden, false);
  assert.equal($('#sidebar').getAttribute('aria-label'), 'Projects');
  const items = () => [...$('#workspace-list').querySelectorAll('.workspace-item')];
  assert.deepEqual(items().map(item => item.querySelector('.workspace-name').textContent), ['Alpha', 'Beta']);
  assert.match(items()[0].querySelector('.workspace-meta').textContent, /^Alpha → \S+ · 2 cards$/, 'A new project has its own Git repository.');
  assert.equal(items()[0].getAttribute('aria-current'), 'true');
  items()[1].click(); await ctx.idle();
  assert.deepEqual(titles($), ['B1']);
  assert.equal(ctx.shownName(), 'Beta');
  assert.equal(items()[1].getAttribute('aria-current'), 'true');
  items()[0].click(); await ctx.idle();
  assert.deepEqual(titles($), ['A1', 'A2']);
  // Each project is managed from the sidebar: ⋯ → Rename (inline) or Delete (inline confirm). Repository and workflow are in Project settings.
  const entry = name => items().find(item => item.querySelector('.workspace-name').textContent === name).closest('li');
  const menu = async (name, label) => { entry(name).querySelector('.workspace-menu-toggle').click(); await ctx.idle(); [...entry(name).querySelectorAll('.workspace-menu button')].find(button => button.textContent === label).click(); await ctx.idle(); };
  await menu('Beta', 'Rename');
  const rename = entry('Beta').querySelector('.workspace-rename');
  rename.querySelector('input').value = 'Alpha';
  rename.dispatchEvent(new win.Event('submit', { cancelable: true })); await ctx.idle();
  assert.match(entry('Beta').querySelector('.workspace-menu').textContent, /already exists/);
  entry('Beta').querySelector('.workspace-rename input').value = 'Beta two';
  entry('Beta').querySelector('.workspace-rename').dispatchEvent(new win.Event('submit', { cancelable: true })); await ctx.idle();
  assert.deepEqual(items().map(item => item.querySelector('.workspace-name').textContent), ['Alpha', 'Beta two']);
  await menu('Beta two', 'Delete…');
  assert.match(entry('Beta two').querySelector('.workspace-menu').textContent, /Delete “Beta two” and its 1 card\? This cannot be undone/);
  [...entry('Beta two').querySelectorAll('.workspace-menu button')].find(button => button.textContent === 'Keep').click(); await ctx.idle();
  assert.equal(entry('Beta two').querySelector('.workspace-menu'), null);
  entry('Beta two').querySelector('.workspace-menu-toggle').click(); await ctx.idle();
  assert.deepEqual([...entry('Beta two').querySelectorAll('.workspace-menu button')].map(button => button.textContent), ['Rename', 'Delete…']);
  entry('Beta two').querySelector('.workspace-menu-toggle').click(); await ctx.idle();
  await menu('Beta two', 'Rename');
  entry('Beta two').querySelector('.workspace-rename input').value = 'Beta';
  entry('Beta two').querySelector('.workspace-rename').dispatchEvent(new win.Event('submit', { cancelable: true })); await ctx.idle();
  items()[0].click(); await ctx.idle();
  $('#workspace-new').click(); $('#project-name').value = ' beta '; submitForm(ctx, '#project-form'); await ctx.idle();
  assert.match($('#project-error').textContent, /already exists/);
  $('#project-name').value = '   '; submitForm(ctx, '#project-form');
  assert.match($('#project-error').textContent, /Enter a project name/);
  $('#project-cancel').click();
  assert.equal((await serverBoard(ctx)).projects.length, 2);
  await menu('Alpha', 'Rename');
  assert.equal(entry('Alpha').querySelector('.workspace-rename input').value, 'Alpha');
  entry('Alpha').querySelector('.workspace-rename input').value = 'Alpha renamed';
  entry('Alpha').querySelector('.workspace-rename').dispatchEvent(new win.Event('submit', { cancelable: true })); await ctx.idle();
  assert.equal(ctx.shownName(), 'Alpha renamed');
  await menu('Alpha renamed', 'Delete…');
  assert.match(entry('Alpha renamed').querySelector('.workspace-menu').textContent, /Delete “Alpha renamed” and its 2 cards\? This cannot be undone/);
  byText(entry('Alpha renamed').querySelector('.workspace-menu'), 'Keep').click(); await ctx.idle();
  assert.equal((await serverBoard(ctx)).projects.length, 2);
  await menu('Alpha renamed', 'Delete…');
  await click(ctx, byText(entry('Alpha renamed').querySelector('.workspace-menu'), 'Delete project'));
  const board = await serverBoard(ctx);
  assert.deepEqual(board.projects.map(project => project.name), ['Beta']);
  assert.deepEqual(board.projects[0].tasks.map(card => card.title), ['B1']);
  assert.deepEqual(titles($), ['B1']);
  assert.equal(win.localStorage.getItem(HISTORY_KEY), JSON.stringify(history));
});

test('seven stages render; cards are created, edited, duplicated, deleted, and reordered; the order persists', async t => {
  const ctx = await setup(t);
  const { $, win, copied } = ctx;
  await goTo(ctx, '#/kanban');
  await savedStageProject(ctx, 'Work');
  assert.deepEqual(Array.from($('#kanban-columns').querySelectorAll('h3'), heading => heading.textContent), ['To Do', 'Planning', 'Executing', 'Code Review', 'Testing', 'Merge', 'Done']);
  assert.match($('#kanban-columns [data-column="todo"] .kanban-column-note').textContent, /Never runs an agent/);
  assert.match($('#kanban-columns [data-column="done"] .kanban-column-note').textContent, /never runs an agent/);
  $('#card-new').click(); submitForm(ctx, '#card-form'); await ctx.idle();
  assert.match($('#card-error').textContent, /title/);
  $('#card-title').value = 'Only a title'; submitForm(ctx, '#card-form'); await ctx.idle();
  assert.match($('#card-error').textContent, /prompt/);
  $('#card-cancel').click();
  assert.equal((await serverTasks(ctx)).length, 0);
  await newCard(ctx, 'One', 'Prompt one'); await newCard(ctx, 'Two', 'Prompt two'); await newCard(ctx, 'Three', 'Prompt three');
  assert.deepEqual(titles($), ['One', 'Two', 'Three']);
  assert.equal(cardItem(ctx, 'One').querySelector('.kanban-status').textContent, 'Manual card—not checked');
  assert.equal(cardItem(ctx, 'One').querySelector('.kanban-move-up').disabled, true);
  assert.equal(cardItem(ctx, 'Three').querySelector('.kanban-move-down').disabled, true);
  assert.equal(cardItem(ctx, 'One').querySelector('.kanban-move-down').getAttribute('aria-label'), 'Move down: One');
  // The stage menu offers only valid moves: Planning, or Executing directly.
  assert.deepEqual(Array.from(cardItem(ctx, 'One').querySelectorAll('.kanban-move-to option'), item => item.value), ['', 'planning', 'executing']);
  // Keyboard reorder keeps focus on the moved card.
  await click(ctx, cardItem(ctx, 'One').querySelector('.kanban-move-down'));
  assert.deepEqual(titles($), ['Two', 'One', 'Three']);
  assert.equal(win.document.activeElement, cardItem(ctx, 'One').querySelector('.kanban-move-down'));
  assert.match($('#announcement').textContent, /Moved “One” to position 2 of 3/);
  await click(ctx, cardItem(ctx, 'One').querySelector('.kanban-move-down'));
  assert.deepEqual(titles($), ['Two', 'Three', 'One']);
  assert.equal(win.document.activeElement, cardItem(ctx, 'One').querySelector('.kanban-move-up'));
  await click(ctx, cardItem(ctx, 'One').querySelector('.kanban-move-up'));
  assert.deepEqual(titles($), ['Two', 'One', 'Three']);
  // Drag-and-drop: drop "Three" on "Two".
  cardItem(ctx, 'Three').dispatchEvent(new win.Event('dragstart', { bubbles: true }));
  const over = new win.Event('dragover', { bubbles: true, cancelable: true });
  cardItem(ctx, 'Two').dispatchEvent(over);
  assert.equal(over.defaultPrevented, true);
  cardItem(ctx, 'Two').dispatchEvent(new win.Event('drop', { bubbles: true, cancelable: true }));
  await ctx.idle();
  assert.deepEqual(titles($), ['Three', 'Two', 'One']);
  assert.deepEqual((await serverTasks(ctx)).map(card => card.title), ['Three', 'Two', 'One']);
  // An unlinked project keeps cards in To Do and explains why.
  await unlink(ctx);
  const menu = cardItem(ctx, 'One').querySelector('.kanban-move-to');
  menu.value = 'planning'; menu.dispatchEvent(new win.Event('change')); await ctx.idle();
  assert.match($('#project-detail').textContent, /Link this project to a Git repository/);
  assert.deepEqual(titles($), ['Three', 'Two', 'One']);
  // Edit a manual card.
  cardItem(ctx, 'Two').querySelector('.kanban-open').click();
  assert.equal($('#card-prompt').value, 'Prompt two');
  $('#card-title').value = 'Two edited'; $('#card-prompt').value = 'Prompt two, edited.';
  submitForm(ctx, '#card-form'); await ctx.idle();
  const editedCard = (await serverTasks(ctx))[1];
  assert.equal(editedCard.title, 'Two edited'); assert.equal(editedCard.prompt, 'Prompt two, edited.'); assert.equal(editedCard.checksOutdated, false);
  // Duplicate goes right after the original.
  await click(ctx, cardItem(ctx, 'Two edited').querySelector('.kanban-duplicate'));
  assert.deepEqual(titles($), ['Three', 'Two edited', 'Two edited (copy)', 'One']);
  const cards = await serverTasks(ctx);
  assert.notEqual(cards[2].id, cards[1].id);
  assert.equal(cards[2].prompt, cards[1].prompt);
  // Delete needs a confirmation.
  cardItem(ctx, 'Two edited (copy)').querySelector('.kanban-delete').click();
  assert.match($('#kanban-columns').textContent, /Delete “Two edited \(copy\)”\? This cannot be undone/);
  byText($('#kanban-columns'), 'Keep card').click();
  assert.equal((await serverTasks(ctx)).length, 4);
  cardItem(ctx, 'Two edited (copy)').querySelector('.kanban-delete').click();
  await click(ctx, byText($('#kanban-columns'), 'Delete card'));
  assert.deepEqual(titles($), ['Three', 'Two edited', 'One']);
  cardItem(ctx, 'One').querySelector('.kanban-copy').click();
  await until(() => copied() === 'Prompt one', 'copy');
  // Reload: projects and order come back from the app, not the browser.
  const reloaded = await setup(t, { dataDir: ctx.dataDir });
  await goTo(reloaded, '#/kanban');
  assert.deepEqual(titles(reloaded.$), ['Three', 'Two edited', 'One']);
  assert.equal(reloaded.shownName(), 'Work');
});

test('a linked repository enables stage moves; invalid folders explain the problem; nothing runs', { skip: process.platform === 'win32' }, async t => {
  const ctx = await setup(t);
  const { $, win } = ctx;
  const repo = await gitRepo(t);
  await goTo(ctx, '#/kanban');
  await savedStageProject(ctx, 'Linked');
  await newCard(ctx, 'Feature', 'Build the feature.');
  // The new project comes with its own Git repository in the projects folder.
  assert.match($('#repo-state').textContent, /Linked to \S+\/projects\/Linked\./);
  assert.equal(gitIn((await serverBoard(ctx)).projects[0].repository.root, 'log', '--format=%s'), 'Initial commit');
  $('#repo-path').value = join(repo, 'missing'); submitForm(ctx, '#repo-form'); await ctx.idle();
  assert.equal($('#repo-message').textContent, 'This folder does not exist.');
  $('#repo-path').value = tmpdir(); submitForm(ctx, '#repo-form'); await ctx.idle();
  assert.match($('#repo-message').textContent, /not a Git repository yet/);
  assert.equal($('#repo-setup').hidden, false, 'Setting up Git is offered, not done.');
  $('#repo-path').value = repo; submitForm(ctx, '#repo-form'); await ctx.idle();
  assert.match($('#repo-state').textContent, new RegExp(`Linked to ${repo}`));
  assert.deepEqual(Array.from($('#target-branch').options, item => item.value), ['', 'trunk']);
  $('#target-branch').value = 'trunk';
  await click(ctx, $('#branch-save'));
  assert.match($('#branch-state').textContent, /Target branch: trunk at [0-9a-f]{12}/);
  // Manual: the drag only moves (this test runs the real supervisor, so no agent may start).
  const linkedProject = (await serverBoard(ctx)).projects[0];
  await ctx.app.board.setWorkflow(linkedProject.id, { workflow: { executing: { policy: 'manual' } }, expectedRevision: linkedProject.revision });
  await ctx.win.__pbTest.loadBoard(); await ctx.idle();
  const menu = cardItem(ctx, 'Feature').querySelector('.kanban-move-to');
  menu.value = 'executing'; menu.dispatchEvent(new win.Event('change')); await ctx.idle();
  assert.deepEqual(titles($, 'executing'), ['Feature']);
  assert.match($('#announcement').textContent, /Moved “Feature” to Executing\. Nothing was started/);
  const board = await serverBoard(ctx);
  assert.equal(board.projects[0].tasks[0].column, 'executing');
  assert.equal(board.projects[0].tasks[0].workspace, null);
  assert.deepEqual(board.runs, []);
  assert.equal(board.execution.available, true);
  assert.match($('#kanban-columns [data-column="executing"] .kanban-column-note').textContent, /Manual · start from the card/);
  assert.match($('#kanban-columns [data-column="code_review"] .kanban-column-note').textContent, /Starts when a card arrives/);
  assert.match($('#kanban-columns [data-column="merge"] .kanban-column-note').textContent, /One click merges when verified/);
  // Project settings collapse to a one-line summary and remember the choice.
  $('#project-toggle').click();
  assert.equal($('#project-body').hidden, true);
  assert.equal($('#project-toggle').getAttribute('aria-expanded'), 'false');
  assert.match($('#project-summary').textContent, /Not linked|→/);
  assert.equal(ctx.win.localStorage.getItem('promptboard.project-panel'), 'collapsed');
  $('#project-toggle').click();
  assert.equal($('#project-body').hidden, false);
  // Copy, duplicate, and delete sit behind the card's "⋯" button.
  const card = $('#kanban-columns .kanban-card');
  assert.equal(card.querySelector('.kanban-more').hidden, true);
  card.querySelector('.kanban-more-toggle').click();
  assert.equal(card.querySelector('.kanban-more').hidden, false);
  assert.equal(card.querySelector('.kanban-more-toggle').getAttribute('aria-expanded'), 'true');
  // The ‹ › board buttons only appear when the stages overflow the window (never in jsdom, which has no layout).
  assert.equal($('#board-left').hidden && $('#board-right').hidden, true);
});

test('backups: export round-trips, import validates, asks before replacing, and keeps imported settings pending', async t => {
  const exact = 'Line 1\r\n  indented <b>x</b>\n';
  const legacy = { application: 'AI Prompt Engineer', kind: 'kanban-backup', version: 1, selectedProjectId: 'p2', projects: [
    { id: 'p1', name: 'One', createdAt: 1, cards: [{ id: 'c1', title: 'Card 1', prompt: exact, createdAt: 1, updatedAt: 1, checksOutdated: false,
      source: { historyId: 'h', provider: 'claude', model: 'opus', effort: '', reportedModels: [], language: 'pl', quality: 'fast', verification: 'checks-passed', generatedAt: 1 } }] },
    { id: 'p2', name: 'Two', createdAt: 2, cards: [] },
  ] };
  const ctx = await setup(t);
  const { $, choose, downloads, blobs } = ctx;
  await goTo(ctx, '#/kanban');
  await savedStageProject(ctx, 'Current');
  await newCard(ctx, 'Keep me', 'Keep.');
  const before = JSON.stringify((await serverBoard(ctx)).projects);
  const withCard = changes => JSON.stringify({ ...legacy, projects: [{ ...legacy.projects[0], cards: [{ ...legacy.projects[0].cards[0], ...changes }] }] });
  for (const [text, message] of [
    ['not json', /not valid JSON/],
    [JSON.stringify({ ...legacy, kind: 'other' }), /not a Promptboard or Kanban backup/],
    [JSON.stringify({ ...legacy, version: 3 }), /not a Promptboard or version 1 Kanban board/],
    [withCard({ prompt: '' }), /card 1 needs a prompt/],
    [withCard({ title: 'x'.repeat(121) }), /title needs 1 to 120/],
    [JSON.stringify({ ...legacy, projects: [legacy.projects[0], { ...legacy.projects[1], id: 'p1' }] }), /unique ID/],
  ]) {
    await importFile(ctx, text);
    if (/Replace the current board/.test($('#project-detail').textContent)) await click(ctx, byText($('#project-detail'), 'Replace board'));
    assert.match($('#project-detail').textContent, /Import failed\. Your board is unchanged\./);
    assert.match($('#project-detail').textContent, message);
    assert.equal(JSON.stringify((await serverBoard(ctx)).projects), before);
  }
  await importFile(ctx, JSON.stringify(legacy));
  assert.match($('#project-detail').textContent, /Replace the current board \(1 project, 1 card\) with this backup \(2 projects, 1 card\)\?/);
  byText($('#project-detail'), 'Keep current board').click();
  assert.equal(JSON.stringify((await serverBoard(ctx)).projects), before);
  await importFile(ctx, JSON.stringify(legacy));
  await click(ctx, byText($('#project-detail'), 'Replace board'));
  assert.match($('#project-detail').textContent, /No agent runs were started/);
  const board = await serverBoard(ctx);
  assert.deepEqual(board.projects.map(project => project.name), ['One', 'Two']);
  assert.equal(ctx.shown(), 'p2');
  assert.equal(board.projects[0].tasks[0].prompt, exact);
  ctx.pick('p1');
  assert.equal(column($, 'todo').querySelector('.kanban-status').textContent, 'Automatic checks only—review before use');
  assert.equal(column($, 'todo').querySelector('.kanban-meta').textContent, 'Prompt source: Claude Code · opus · Polski');
  await click(ctx, $('#export-board'));
  assert.match(downloads.at(-1), /^promptboard-backup-\d{4}-\d\d-\d\d\.json$/);
  const exported = JSON.parse(await blobs.at(-1).text());
  assert.equal(exported.kind, 'promptboard-backup');
  assert.equal(exported.projects[0].tasks[0].prompt, exact);
  // A version 2 backup with a repository path and automation waits for confirmation.
  exported.projects[0].repository = { path: '/nowhere/repo' };
  exported.projects[0].workflow = { executing: { policy: 'start' } };
  const fresh = await setup(t);
  await goTo(fresh, '#/kanban');
  await importFile(fresh, JSON.stringify(exported));
  assert.match(fresh.$('#project-detail').textContent, /Backup imported: 2 projects, 1 card\. No agent runs were started\. Imported repository paths and workflow settings wait for your confirmation/);
  fresh.pick('p1');
  assert.equal(fresh.$('#import-pending').hidden, false);
  assert.match(fresh.$('#import-pending-text').textContent, /repository \/nowhere\/repo, workflow settings \(automatic runs in Executing\)/);
  const project = (await serverBoard(fresh)).projects.find(item => item.id === 'p1');
  assert.equal(project.repository, null);
  assert.deepEqual(project.workflow, {});
  assert.equal(project.effectiveWorkflow.executing.policy, 'start', 'The default; imported settings wait.');
  await click(fresh, fresh.$('#import-confirm'));
  assert.equal(fresh.$('#repo-message').textContent, 'This folder does not exist.');
  await click(fresh, fresh.$('#import-dismiss'));
  assert.equal(fresh.$('#import-pending').hidden, true);
  assert.deepEqual((await serverBoard(fresh)).runs, []);
});

test('the browser board migrates once with exact text; unreadable data and failed saves stay visible', { skip: process.platform === 'win32' }, async t => {
  const exact = '  Spaces\r\nCRLF 🚀\n';
  const browser = { version: 1, selectedProjectId: 'b', projects: [
    { id: 'a', name: 'Alpha', createdAt: 1, cards: [{ id: 'c1', title: 'First', prompt: exact, createdAt: 1, updatedAt: 2, checksOutdated: true, source: { provider: 'codex', verification: 'checks-passed', quality: 'reviewed' } }, { id: 'c2', title: 'Second', prompt: 'Two', createdAt: 3, updatedAt: 3 }] },
    { id: 'b', name: 'Beta', createdAt: 2, cards: [] },
  ] };
  const ctx = await setup(t, { kanban: browser, hash: '#/kanban' });
  await ctx.idle();
  let board = await serverBoard(ctx);
  assert.deepEqual(board.projects.map(project => project.id), ['a', 'b']);
  assert.deepEqual(board.projects[0].tasks.map(task => [task.id, task.prompt, task.checksOutdated, task.column]), [['c1', exact, true, 'todo'], ['c2', 'Two', false, 'todo']]);
  assert.equal(ctx.shown(), 'b');
  assert.equal(ctx.win.localStorage.getItem(KANBAN_KEY), JSON.stringify(browser), 'The browser copy is kept.');
  assert.ok(ctx.win.localStorage.getItem(`${KANBAN_KEY}.migrated`));
  assert.match(ctx.$('#announcement').textContent, /Moved 2 projects and 2 cards/);
  // The same browser data on a fresh page (marker cleared) adds no duplicates.
  const again = await setup(t, { kanban: browser, hash: '#/kanban', dataDir: ctx.dataDir });
  await again.idle();
  board = await serverBoard(again);
  assert.equal(board.projects.length, 2);
  assert.equal(board.projects[0].tasks.length, 2);
  // Unreadable browser data is reported, kept, and not sent anywhere.
  const raw = '{"version":1,"projects":[{"id":"p"';
  const broken = await setup(t, { kanban: raw, hash: '#/kanban' });
  await broken.idle();
  assert.equal(broken.$('#kanban-load-warning').hidden, false);
  assert.match(broken.$('#kanban-load-warning').textContent, /could not be read, so it was not moved/);
  assert.equal(broken.win.localStorage.getItem(`${KANBAN_KEY}.unreadable`), raw);
  assert.equal(broken.win.localStorage.getItem(KANBAN_KEY), raw);
  assert.equal((await serverBoard(broken)).projects.length, 0);
  // A failed server write is visible and the board keeps its last saved state.
  await chmod(ctx.dataDir, 0o500);
  t.after(() => chmod(ctx.dataDir, 0o700).catch(() => {}));
  await goTo(ctx, '#/kanban');
  ctx.pick('a');
  await newCard(ctx, 'Unsaved', 'Not written.');
  assert.match(ctx.$('#card-error').textContent, /could not be saved/);
  assert.equal(ctx.$('#kanban-view .board-warning').hidden, false);
  assert.deepEqual(titles(ctx.$), ['First', 'Second']);
  await chmod(ctx.dataDir, 0o700);
});

test('the settings step collapses and expands, is remembered, and reopens for an invalid field', async t => {
  const { $, win } = await setup(t);
  const toggle = $('#settings-toggle');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.textContent, '−');
  toggle.click();
  assert.equal($('#settings-body').hidden, true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.textContent, '+');
  assert.equal(toggle.getAttribute('aria-label'), 'Expand settings');
  assert.equal(win.localStorage.getItem('ste-prompt-engineer.settings'), 'collapsed');
  const restored = await setup(t, {});
  assert.equal(restored.$('#settings-body').hidden, false, 'A fresh browser storage starts expanded.');
  $('#custom-model').dispatchEvent(new win.Event('invalid', { cancelable: true }));
  assert.equal($('#settings-body').hidden, false);
  assert.equal($('#compose-general').open, true, 'An invalid input is reachable inside its settings category.');
  toggle.click(); toggle.click();
  assert.equal($('#settings-body').hidden, false);
  assert.equal(win.localStorage.getItem('ste-prompt-engineer.settings'), 'expanded');
});

test('Compose exposes three quiet settings groups, restores its summary, and keeps result actions discoverable', async t => {
  const { $, win, choose, submit, idle } = await setup(t);
  const groups = [...win.document.querySelectorAll('#settings-body > details')];
  assert.deepEqual(groups.map(group => group.querySelector('summary > span').textContent), ['General settings', 'Context grounding', 'More settings']);
  assert.deepEqual([...$('#task').options].map(item => [item.value, item.textContent]), [
    ['unspecified', 'No specification'], ['build', 'Build something'], ['feature', 'Add a feature'], ['debug', 'Debug a problem'],
    ['refactor', 'Refactor code'], ['review', 'Review code'], ['architecture', 'Design architecture'],
    ['integration', 'Integrate a service or API'], ['ui-ux', 'Change UI or UX'], ['data', 'Change data or database'],
    ['testing', 'Create or improve tests'], ['security', 'Improve security'], ['performance', 'Optimize performance'],
    ['migration', 'Migrate or upgrade'], ['dependencies', 'Update dependencies'], ['devops', 'Configure CI/CD or infrastructure'],
    ['automation', 'Automate a workflow'], ['documentation', 'Write documentation'],
    ['agent-workflow', 'Create an agent workflow'], ['research', 'Research an approach'],
  ]);
  assert.equal($('#task').value, 'build');
  assert.ok(groups.every(group => !group.open));
  assert.equal($('#prompt-view .step'), null); assert.equal($('#prompt-view img'), null);
  choose('#provider', 'claude'); await idle();
  $('input[name="detail"][value="detailed"]').checked = true;
  $('input[name="detail"][value="detailed"]').dispatchEvent(new win.Event('change', { bubbles: true }));
  assert.equal($('#compose-general-summary').textContent, 'Claude Code · Detailed');
  $('#prompt-input').value = 'Build a simple page.'; submit(); await idle();
  assert.equal($('#output-tools').hidden, false); assert.equal($('#output-info').open, false);
  assert.ok($('#output-tools').contains($('#split-button'))); assert.ok($('#output-tools').contains($('#export-button')));
  assert.equal($('#copy-button').disabled, false); assert.equal($('#prompt-edit-actions').hidden, false);
  $('#output-tools').open = true; $('#output-tools > summary').focus();
  $('#output-tools').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal($('#output-tools').open, false); assert.equal(win.document.activeElement, $('#output-tools > summary'));
  $('#output-tools').open = true; $('#copy-button').click();
  assert.equal($('#output-tools').open, false);
  $('#new-prompt').click(); $('#provider').value = 'codex';
  $('.history-restore').click(); await idle();
  assert.equal($('#compose-general-summary').textContent, 'Claude Code · Detailed');
});

test('the Kanban sidebar owns one quiet collapsible project settings panel', async t => {
  const { $ } = await setup(t);
  assert.equal($('#project-toggle').getAttribute('aria-controls'), 'project-settings');
  assert.ok($('#workspace-panel').contains($('#project-toggle')));
  assert.ok($('#workspace-panel').contains($('#project-settings')));
  assert.ok($('#project-settings').contains($('#project-body')));
  assert.equal($('.kanban-board').contains($('#project-settings')), false);
  if ($('#project-settings').hidden) $('#project-toggle').click();
  assert.equal($('#project-settings').hidden, false);
  assert.equal($('#project-select'), null, 'The sidebar list is the one project picker.');
  assert.equal($('#project-settings .project-backup').open, false);
  $('#project-settings-close').click();
  assert.equal($('#project-settings').hidden, true);
  assert.equal($('#project-toggle').getAttribute('aria-expanded'), 'false');
});

test('missing agent terminal support shows setup steps; the prompt editor still works', async t => {
  const executor = { describe: async () => ({ available: false, setupMessage: 'Agent terminals need the node-pty package. Run npm install in the Promptboard folder, then restart.' }), activeCount: () => 0 };
  const ctx = await setup(t, { executor, generationResponse: { prompt: 'Add a test.', verification: report() } });
  const { $, submit, requests } = ctx;
  $('#prompt-input').value = 'Still works.'; submit();
  await until(() => requests.length === 1 && !$('#generate-button').disabled, 'prompt result');
  assert.equal($('#prompt-output').textContent, 'Add a test.');
  await goTo(ctx, '#/kanban');
  assert.equal($('#execution-status').hidden, false);
  assert.match($('#execution-status').textContent, /Agent runs are unavailable\. Agent terminals need the node-pty package\. Run npm install/);
  await savedStageProject(ctx, 'Setup');
  assert.match($('#kanban-columns [data-column="executing"] .kanban-column-note').textContent, /not set up/);
});

// ---- PB-03: transitions, workflow settings, consent, and task details ----

test('Kanban Pause and Resume preserve the conversation and keep Composer cards in To Do', { skip: process.platform === 'win32' }, async t => {
  const ctx = await linkedKanban(t);
  await link(ctx);
  await newCard(ctx, 'Unstarted', 'Exact To Do text.');
  const card = await ctx.app.board.createTask({ projectId: ctx.project.id, title: 'Conversation', prompt: 'Original task.' });
  await ctx.app.board.moveTask(card.id, { column: 'executing', expectedRevision: 1 });
  const run = await ctx.app.board.requestRun(card.id, { stage: 'executing', consent: true });
  await ctx.app.board.updateRun(run.id, { status: 'running', providerSessionId: 'native-conversation' });
  await ctx.win.__pbTest.loadBoard(); await ctx.idle();
  const pause = cardItem(ctx, 'Conversation').querySelector('.kanban-pause');
  assert.match(pause.getAttribute('aria-label'), /Pause agent.*Conversation/);
  pause.focus(); assert.equal(ctx.win.document.activeElement, pause);
  await click(ctx, pause);
  assert.equal((await ctx.app.board.run(run.id)).status, 'suspended');
  const resume = cardItem(ctx, 'Conversation').querySelector('.kanban-resume');
  assert.match(resume.getAttribute('aria-label'), /Resume conversation.*Conversation/);
  assert.match(cardItem(ctx, 'Conversation').textContent, /Paused/);
  assert.equal(cardItem(ctx, 'Unstarted').querySelector('.kanban-resume'), null);
  await click(ctx, resume);
  const resumed = ctx.executor.started.at(-1);
  assert.equal(resumed.sessionId, run.sessionId);
  assert.equal(resumed.providerSessionId, 'native-conversation');
  assert.deepEqual(resumed.resumeFrom, { runId: run.id, nativeSessionId: 'native-conversation' });
  assert.deepEqual(titles(ctx.$, 'todo'), ['Unstarted']);
  assert.equal((await serverTasks(ctx)).find(task => task.title === 'Unstarted').prompt, 'Exact To Do text.');
});

test('drag-and-drop and keyboard moves use the same transition; rejected moves roll back visibly with the reason', { skip: process.platform === 'win32' }, async t => {
  const ctx = await linkedKanban(t);
  const { $, win } = ctx;
  await newCard(ctx, 'Keyboard', 'Move me with the menu.');
  await newCard(ctx, 'Dragged', 'Move me with the mouse.');
  // Keyboard: the card stays in its column, marked "Moving to …", until the server answers; it never jumps first.
  await unlink(ctx);
  await moveBy(ctx, 'Keyboard', 'planning');
  assert.ok(cardItem(ctx, 'Keyboard').classList.contains('moving'), 'A move shows as pending until the server answers.');
  assert.match(cardItem(ctx, 'Keyboard').textContent, /Moving to Planning…/);
  assert.deepEqual(titles($, 'planning'), [], 'The card does not enter Planning before the server accepts the move.');
  await ctx.idle();
  assert.deepEqual(titles($, 'todo'), ['Keyboard', 'Dragged'], 'The refused move leaves the card in place.');
  assert.ok(cardItem(ctx, 'Keyboard').classList.contains('rejected'));
  assert.match($('#project-detail').textContent, /“Keyboard” stayed in To Do\. Link this project to a Git repository before cards leave To Do/);
  // Drag-and-drop onto the empty Planning column: the same transition and the same rejection.
  cardItem(ctx, 'Dragged').dispatchEvent(new win.Event('dragstart', { bubbles: true }));
  const planning = column($, 'planning');
  const over = new win.Event('dragover', { bubbles: true, cancelable: true });
  planning.dispatchEvent(over);
  assert.equal(over.defaultPrevented, true);
  planning.dispatchEvent(new win.Event('drop', { bubbles: true, cancelable: true }));
  await ctx.idle();
  assert.deepEqual(titles($, 'todo'), ['Keyboard', 'Dragged']);
  assert.match($('#project-detail').textContent, /“Dragged” stayed in To Do\. Link this project/);
  // After linking, both paths make the same transition (Executing set to Manual here, so nothing starts).
  await link(ctx);
  await ctx.app.board.setWorkflow(ctx.project.id, { workflow: { executing: { policy: 'manual' } }, expectedRevision: (await serverBoard(ctx)).projects[0].revision });
  await ctx.win.__pbTest.loadBoard(); await ctx.idle();
  await moveBy(ctx, 'Keyboard', 'executing'); await ctx.idle();
  cardItem(ctx, 'Dragged').dispatchEvent(new win.Event('dragstart', { bubbles: true }));
  column($, 'executing').dispatchEvent(new win.Event('drop', { bubbles: true, cancelable: true }));
  await ctx.idle();
  assert.deepEqual(titles($, 'executing'), ['Keyboard', 'Dragged']);
  const tasks = await serverTasks(ctx);
  assert.deepEqual(tasks.map(task => task.transitions.map(({ from, to, by }) => [from, to, by])), [[['todo', 'executing', 'user']], [['todo', 'executing', 'user']]]);
  // Done accepts a drop only from Merge (a verified merge). From Executing, the drop zone refuses the card.
  assert.match(column($, 'done').querySelector('.kanban-done-drop').textContent, /Complete from Testing or Merge · no merge/);
  cardItem(ctx, 'Dragged').dispatchEvent(new win.Event('dragstart', { bubbles: true }));
  const refused = new win.Event('dragover', { bubbles: true, cancelable: true });
  column($, 'done').querySelector('.kanban-done-drop').dispatchEvent(refused);
  assert.equal(refused.defaultPrevented, false, 'Done is not a drop target for a card in Executing.');
  column($, 'done').querySelector('.kanban-done-drop').dispatchEvent(new win.Event('drop', { bubbles: true, cancelable: true }));
  await ctx.idle();
  assert.deepEqual(titles($, 'executing'), ['Keyboard', 'Dragged']);
  // A verified completion (here: no changes required) lists the card in Done; Reopen starts a new cycle.
  const dragged = (await serverTasks(ctx)).find(task => task.title === 'Dragged');
  await ctx.app.board.delivery.completeNoChanges(dragged.id, { confirm: true });
  await win.__pbTest.loadBoard(); await ctx.idle();
  assert.match(column($, 'done').textContent, /Completed \(1\)/);
  assert.match(column($, 'done').querySelector('.kanban-done-card').textContent, /#\d+.*just now/s);
  column($, 'done').querySelector('.kanban-done-all').click();
  assert.equal($('#done-dialog').open, true);
  assert.deepEqual(Array.from($('#done-dialog-list').querySelectorAll('.kanban-open'), button => button.textContent), ['Dragged']);
  await click(ctx, $('#done-dialog-list .kanban-reopen'));
  assert.equal($('#done-dialog').open, false);
  assert.deepEqual(titles($, 'todo'), ['Dragged']);
  const reopened = (await serverTasks(ctx)).find(task => task.title === 'Dragged');
  assert.deepEqual([reopened.completion, reopened.previousCompletions.at(-1).kind, reopened.transitions.at(-1).by], [null, 'no_changes', 'reopen']);
  assert.equal(ctx.executor.started.length, 0, 'Manual moves start nothing.');
});

test('workflow settings: dragging starts the stage by default; Manual only moves; Merge shows one button unless it merges automatically; To Do stays inert', { skip: process.platform === 'win32' }, async t => {
  const ctx = await linkedKanban(t);
  const { $, win } = ctx;
  await link(ctx);
  await newCard(ctx, 'Alpha', 'First task.');
  await newCard(ctx, 'Beta', 'Second task.');
  assert.match($('#workflow-summary').textContent, /Planning: Start automatically · Executing: Start automatically/);
  $('#workflow-open').click();
  const stages = [...$('#workflow-stages').querySelectorAll('.workflow-stage[data-stage]')];
  assert.deepEqual(stages.map(box => box.dataset.stage), ['planning', 'executing', 'code_review', 'testing', 'merge'], 'To Do and Done have no workflow setting.');
  assert.deepEqual(Array.from(stages.at(-1).querySelectorAll('.segmented span'), span => span.textContent), ['Merge automatically', 'Merge button']);
  assert.equal(stages.at(-1).querySelector('input[value="manual"]').checked, true, 'Merge waits for the button by default.');
  assert.ok(stages.slice(0, -1).every(box => box.querySelector('input[value="start"]').checked), 'Every stage starts when a card arrives.');
  assert.equal(stages[0].querySelectorAll('input[type="radio"]').length, 2, 'No "Ask" setting.');
  assert.match(stages[0].querySelector('.workflow-preview').textContent, /Moving a card here starts it/);
  assert.match($('#workflow-stages').textContent, /Dragging a card is the instruction/);
  // Manual for Planning.
  $('#workflow-stages [data-stage="planning"] input[value="manual"]').checked = true;
  submitForm(ctx, '#workflow-form'); await ctx.idle();
  assert.equal($('#workflow-dialog').open, false);
  const project = (await serverBoard(ctx)).projects[0];
  assert.equal(project.workflow.planning.policy, 'manual');
  await moveBy(ctx, 'Beta', 'planning'); await ctx.idle();
  assert.deepEqual(titles($, 'planning'), ['Beta'], 'Manual only moves.');
  assert.equal(ctx.executor.started.length, 0);
  // The default: dropping on Executing starts the agent at once, with no question.
  await moveBy(ctx, 'Alpha', 'executing'); await ctx.idle();
  assert.equal(ctx.executor.started.length, 1, 'One run started by the drag.');
  const run = ctx.executor.started[0];
  assert.equal(run.trigger, 'user');
  const alpha = (await serverTasks(ctx)).find(task => task.title === 'Alpha');
  assert.deepEqual([alpha.column, alpha.lastTransition.runId], ['executing', run.id], 'The card and its run are saved together.');
  assert.match($('#announcement').textContent, /Moved “Alpha” to Executing and started the Executing agent/);
  // Settings changes apply to future runs only.
  $('#workflow-open').click();
  $('#workflow-stages [data-stage="executing"] [data-field="provider"]').value = 'codex';
  submitForm(ctx, '#workflow-form'); await ctx.idle();
  assert.equal((await ctx.app.board.run(run.id)).config.provider, 'claude', 'The active run keeps its configuration snapshot.');
  // To Do stays inert and cannot be targeted by a run.
  await ctx.app.board.updateRun(run.id, { status: 'cancelled' }); await win.__pbTest.loadBoard(); await ctx.idle();
  await moveBy(ctx, 'Alpha', 'todo'); await ctx.idle();
  assert.equal(ctx.executor.started.length, 1);
  const refused = await fetch(`${ctx.app.url}/api/tasks/${alpha.id}/runs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ste-token': win.__pbTest.token }, body: JSON.stringify({ stage: 'todo', consent: true }) });
  assert.equal((await refused.json()).code, 'STAGE_NOT_RUNNABLE');
});

test('the card’s Start button starts at once with the resolved agent; plan approval stays available; details show prompt, plan, and history', { skip: process.platform === 'win32' }, async t => {
  const ctx = await linkedKanban(t);
  const { $, win } = ctx;
  await link(ctx);
  await ctx.app.board.setWorkflow(ctx.project.id, { workflow: { planning: { policy: 'manual' } }, agentDefaults: { provider: 'claude', model: 'haiku' }, expectedRevision: (await serverBoard(ctx)).projects[0].revision });
  const created = await ctx.app.board.createTask({ projectId: ctx.project.id, title: 'Parser', prompt: 'Fix the parser.', source: { provider: 'codex', verification: 'needs-review', quality: 'reviewed' } });
  await ctx.app.board.moveTask(created.id, { column: 'planning', expectedRevision: 1 });
  await win.__pbTest.loadBoard(); await ctx.idle();
  assert.equal(ctx.executor.started.length, 0, 'Manual: nothing started on arrival.');
  assert.equal(cardItem(ctx, 'Parser').querySelector('.kanban-start').textContent, 'Start planning');
  await click(ctx, cardItem(ctx, 'Parser').querySelector('.kanban-start'));
  assert.equal(ctx.executor.started.length, 1, 'One click starts; no dialog.');
  const run = ctx.executor.started[0];
  assert.deepEqual([run.trigger, run.config.model, run.config.permissionMode], ['user', 'haiku', 'plan'], 'The inherited model; read-only planning.');
  // Simulate the plan turn the real supervisor records from provider events.
  await ctx.app.board.updateRun(run.id, { status: 'running' });
  await ctx.app.board.updateRun(run.id, { status: 'waiting_for_input', turns: 1, turnComplete: true, hasPlan: true, planExcerpt: 'PLAN' });
  await win.__pbTest.loadBoard(); await ctx.idle();
  assert.match(cardItem(ctx, 'Parser').querySelector('.run-badge').textContent, /Planning · AWAITS YOU/);
  assert.equal($('#workspace-list .workspace-live.waiting').textContent, '1 waiting', 'The sidebar shows which project needs attention.');
  cardItem(ctx, 'Parser').querySelector('.kanban-confirm-run').click(); await ctx.idle();
  assert.equal($('#task-dialog').open, true);
  const details = $('#task-details').textContent;
  assert.match(details, /Draft—review needed\. Task text revision 1/);
  assert.match(details, /Fix the parser\./);
  assert.match(details, /PLAN\n1\. Change the parser\./);
  assert.match(details, /Claude Code · haiku/);
  assert.match(details, /waiting for input/);
  await click(ctx, byText($('#task-details'), 'Approve plan'));
  const approved = (await serverTasks(ctx))[0];
  assert.equal(approved.planApproval.runId, run.id);
  assert.equal((await ctx.app.board.run(run.id)).status, 'succeeded');
  // Editing the task text makes the approval stale, and details say so.
  cardItem(ctx, 'Parser').querySelector('.kanban-open').click();
  $('#card-prompt').value = 'Fix the parser and the lexer.';
  submitForm(ctx, '#card-form'); await ctx.idle();
  cardItem(ctx, 'Parser').querySelector('.kanban-details').click(); await ctx.idle();
  assert.match($('#task-details').textContent, /Task text revision 2/);
  assert.match($('#task-details').textContent, /approval is stale: the task changed/);
});

test('Workflow permissions: Plan Mode is fixed; project and inherited stage settings persist; Codex never offers per-file approval', { skip: process.platform === 'win32' }, async t => {
  const ctx = await linkedKanban(t);
  const { $, win } = ctx;
  await link(ctx);
  $('#workflow-open').click();
  const defaults = $('#workflow-stages .workflow-defaults');
  const provider = defaults.querySelector('[data-field="provider"]');
  provider.value = 'claude'; provider.dispatchEvent(new win.Event('change', { bubbles: true }));
  defaults.querySelector('[data-field="permissionMode"]').value = 'approve_edit';
  const planning = $('#workflow-stages [data-stage="planning"] [data-field="permissionMode"]');
  assert.equal(planning.value, 'plan');
  assert.equal(planning.disabled, true);
  const executing = $('#workflow-stages [data-stage="executing"]');
  assert.equal(executing.querySelector('[data-field="provider"]').value, '');
  executing.querySelector('[data-field="permissionMode"]').value = 'auto';
  submitForm(ctx, '#workflow-form'); await ctx.idle();
  let project = (await serverBoard(ctx)).projects[0];
  assert.equal(project.agentDefaults.permissionMode, 'default');
  assert.equal(project.workflow.executing.permissionMode, 'auto');
  assert.equal(project.effectiveWorkflow.executing.permissionMode, 'acceptEdits');
  assert.equal(project.effectiveWorkflow.planning.permissionMode, 'plan');
  $('#workflow-open').click();
  const stageProvider = $('#workflow-stages [data-stage="executing"] [data-field="provider"]');
  stageProvider.value = 'codex'; stageProvider.dispatchEvent(new win.Event('change', { bubbles: true }));
  const permissions = $('#workflow-stages [data-stage="executing"] [data-field="permissionMode"]');
  assert.deepEqual([...permissions.options].map(item => item.value), ['', 'auto']);
  assert.match($('#workflow-stages [data-stage="executing"]').textContent, /no per-file Approve edit mode/);
  permissions.value = 'auto';
  submitForm(ctx, '#workflow-form'); await ctx.idle();
  project = (await serverBoard(ctx)).projects[0];
  assert.equal(project.effectiveWorkflow.executing.provider, 'codex');
  assert.equal(project.effectiveWorkflow.executing.permissionMode, 'workspace-write');
});

test('Done keeps accomplishments and evidence visible, offers no task-work controls, and does not merge', { skip: process.platform === 'win32' }, async t => {
  const ctx = await linkedKanban(t);
  const { $ } = ctx;
  await link(ctx);
  const board = ctx.app.board;
  const created = await board.createTask({ projectId: ctx.project.id, title: 'Keep unmerged', prompt: 'Add a file.' });
  // This test supplies its own review/test evidence. Do not also start stage agents,
  // whose confirmation can launch another test run while the Done assertion is underway.
  await board.moveTask(created.id, { column: 'executing', decision: 'move', expectedRevision: 1 });
  const ws = await board.ensureTaskWorktree(created.id);
  await writeFile(join(ws.path, 'unmerged.txt'), 'keep this change\n');
  await board.delivery.commit(created.id, { message: 'unmerged work', confirm: true });
  const current = async () => (await serverTasks(ctx)).find(task => task.id === created.id);
  await board.moveTask(created.id, { column: 'code_review', decision: 'move', expectedRevision: (await current()).revision });
  const head = (await board.delivery.revision(created.id)).taskCommit;
  await board.delivery.recordReview({ id: 'same-task-review', taskId: created.id, review: { taskCommit: head }, promptRevision: 1 }, '```json\n{"verdict":"no_issues","findings":[]}\n```');
  await board.moveTask(created.id, { column: 'testing', decision: 'move', expectedRevision: (await current()).revision });
  await board.delivery.setTestCommands(ctx.project.id, { commands: [{ command: `${process.execPath} -e "0"` }], expectedRevision: (await serverBoard(ctx)).projects[0].revision });
  await board.delivery.runTests(created.id, { confirm: true });
  await until(async () => (await current()).evidence?.tests?.status === 'passed', 'configured tests passed');
  await board.updateTaskEvidence(created.id, task => { task.stageResults = { executing: { runId: 'task-execution', promptRevision: 1, summary: 'Added unmerged.txt and verified it.' } }; });
  const before = (await board.delivery.revision(created.id)).targetCommit;
  await board.moveTask(created.id, { column: 'done', expectedRevision: (await current()).revision });
  await ctx.win.__pbTest.loadBoard(); await ctx.idle();
  column($, 'done').querySelector('.kanban-details').click();
  await until(() => /Accomplished/.test($('#task-details').textContent) && /Last run: passed/.test($('#task-details').textContent), 'saved accomplishments and evidence');
  assert.match($('#task-details').textContent, /Nothing was merged or pushed/);
  assert.match($('#task-details').textContent, /Added unmerged\.txt and verified it\./);
  assert.equal(byText($('#task-details'), 'Run tests…'), undefined);
  assert.equal(byText($('#task-details'), 'Commit task changes…'), undefined);
  assert.equal((await board.delivery.revision(created.id)).targetCommit, before);
});

test('PB-04 in the UI: commit, configured tests, accepted review, merge preview, confirmed merge', { skip: process.platform === 'win32', timeout: 60000 }, async t => {
  const ctx = await linkedKanban(t);
  const { $, win } = ctx;
  await link(ctx);
  const created = await ctx.app.board.createTask({ projectId: ctx.project.id, title: 'Ship it', prompt: 'Add a file.' });
  const task = await ctx.app.board.moveTask(created.id, { column: 'executing', expectedRevision: 1 });
  const workspace = await ctx.app.board.ensureTaskWorktree(task.id);
  await writeFile(join(workspace.path, 'shipped.txt'), 'shipped\n');
  await ctx.win.__pbTest.loadBoard(); await ctx.idle();
  const openDetails = async () => { cardItem(ctx, 'Ship it').querySelector('.kanban-details').click(); await until(() => !/Reading the task branch/.test($('#task-details').textContent) && /Task revision/.test($('#task-details').textContent), 'delivery details'); await ctx.idle(); };
  // Commit through the details view, with a diff preview and an inline confirmation.
  await openDetails();
  await until(() => /\+shipped/.test($('#task-details').textContent), 'diff preview');
  assert.match($('#task-details').textContent, /1 uncommitted change/);
  byText($('#task-details'), 'Commit task changes…').click();
  assert.match($('#task-details').textContent, /with your existing Git identity\?/);
  await click(ctx, byText($('#task-details'), 'Commit'));
  await until(() => /1 commit ahead of trunk/.test($('#task-details').textContent), 'committed');
  $('#task-dialog').close();
  // Test commands come from Workflow settings only.
  $('#workflow-open').click();
  $('#test-commands').value = `${process.execPath} -e "process.exit(0)"`;
  submitForm(ctx, '#workflow-form'); await ctx.idle();
  assert.deepEqual((await serverBoard(ctx)).projects[0].testCommands[0].argv, [process.execPath, '-e', 'process.exit(0)']);
  // Review evidence (recorded as the supervisor does after a confirmed review run), accepted in the UI.
  const tasks = () => serverTasks(ctx);
  await moveBy(ctx, 'Ship it', 'code_review'); await ctx.idle(); // The drag starts the review.
  const reviewRun = ctx.executor.started.at(-1);
  assert.equal(reviewRun.stage, 'code_review');
  assert.equal(reviewRun.config.permissionMode, 'plan', 'Review is read-only.');
  await ctx.app.board.updateRun(reviewRun.id, { status: 'running' });
  await ctx.app.board.updateRun(reviewRun.id, { status: 'succeeded' });
  await ctx.app.board.delivery.recordReview(reviewRun, '```json\n{"verdict":"no_issues","findings":[]}\n```');
  await ctx.win.__pbTest.loadBoard(); await ctx.idle();
  await openDetails();
  assert.match($('#task-details').textContent, /Review completed · verdict no issues/);
  await click(ctx, byText($('#task-details'), 'Accept review'));
  await until(async () => (await tasks())[0].evidence.review.status === 'accepted', 'accepted');
  $('#task-dialog').close();
  // Tests in Testing: only exit codes decide.
  await moveBy(ctx, 'Ship it', 'testing'); await ctx.idle();
  assert.equal(ctx.executor.started.at(-1).stage, 'testing');
  await ctx.executor.confirm(ctx.executor.started.at(-1).id);
  await until(async () => (await tasks())[0].evidence.tests?.status === 'passed', 'tests passed', 15000);
  // Merge: the task details also show the preview and can merge (the card has the one-click button).
  await moveBy(ctx, 'Ship it', 'merge'); await ctx.idle();
  // A revision-conflict retry can begin after idle's short quiet window. Wait for
  // the confirmed destination, not merely a gap between the asynchronous requests.
  await until(() => column($, 'merge').querySelector(`[data-id="${task.id}"]`), 'confirmed Merge column', 15000);
  assert.ok(Array.from(cardItem(ctx, 'Ship it').querySelectorAll('.kanban-move-to option'), item => item.value).includes('done'));
  cardItem(ctx, 'Ship it').querySelector('.kanban-details').click();
  await until(() => byText($('#task-details'), 'Confirm merge…'), 'merge preview', 15000);
  assert.match($('#task-details').textContent, /→ trunk:/);
  assert.match($('#task-details').textContent, /A\tshipped\.txt/);
  assert.match($('#task-details').textContent, /Nothing is pushed/);
  byText($('#task-details'), 'Confirm merge…').click();
  assert.match($('#task-details').textContent, /It is not pushed/);
  await click(ctx, byText($('#task-details'), 'Confirm merge'));
  await until(async () => (await tasks())[0].column === 'done', 'merged into Done');
  const done = (await tasks())[0];
  assert.equal(done.completion.kind, 'merged');
  assert.equal(execFileSync('git', ['rev-parse', 'trunk'], { cwd: ctx.repo, encoding: 'utf8' }).trim(), done.completion.mergedCommit);
  assert.deepEqual(titles($, 'done'), ['Ship it']);
  assert.ok(win.document.querySelector('#announcement').textContent.includes('Merged into trunk and verified'));
});

test('a folder that is not a Git repository is set up only after confirmation; its files are never committed', { skip: process.platform === 'win32' }, async t => {
  const saved = Object.fromEntries(['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' });
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pb-ui-plain-')));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await writeFile(join(dir, 'notes.txt'), 'private notes\n');
  const ctx = await setup(t);
  const { $ } = ctx;
  await goTo(ctx, '#/kanban');
  await savedStageProject(ctx, 'Fresh');
  $('#repo-path').value = dir; submitForm(ctx, '#repo-form'); await ctx.idle();
  const offer = $('#repo-setup');
  assert.match(offer.textContent, /run git init and make one empty commit named “Initial commit”/);
  assert.match(offer.textContent, /Your files are not added or committed/);
  await assert.rejects(readFile(join(dir, '.git', 'HEAD')), 'Nothing happens before the user confirms.');
  await click(ctx, [...offer.querySelectorAll('button')].find(button => button.textContent === 'Set up Git here'));
  assert.match($('#repo-state').textContent, new RegExp(`Linked to ${dir}`));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  assert.equal(git('rev-list', '--count', 'HEAD'), '1');
  assert.equal(git('log', '-1', '--format=%s'), 'Initial commit');
  assert.equal(git('ls-tree', '-r', '--name-only', 'HEAD'), '', 'The first commit is empty.');
  assert.equal(git('status', '--porcelain'), '?? notes.txt', 'User files stay untracked.');
});

test('when browser storage is full, the oldest prompts are dropped so the newest one is still saved', async t => {
  const storage = Array.from({ length: 30 }, (_, index) => ({ id: `old-${index}`, input: `Old request ${index} ${'x'.repeat(200)}`, prompt: `Old prompt ${index}`, createdAt: 1790000000000 - index, provider: 'codex' }));
  const { $, win, submit, requests } = await setup(t, { storage, generationResponse: { prompt: 'Add a test.', verification: report() } });
  const setItem = win.Storage.prototype.setItem;
  // Room for about ten entries.
  win.Storage.prototype.setItem = function (key, value) { if (key === 'ste-prompt-engineer.history.v1' && value.length > 3500) throw new win.DOMException('Storage is full.', 'QuotaExceededError'); return setItem.call(this, key, value); };
  $('#prompt-input').value = 'Add a test.'; submit();
  await until(() => !$('#generate-button').disabled && requests.length === 1, 'result');
  const saved = JSON.parse(win.localStorage.getItem('ste-prompt-engineer.history.v1'));
  assert.ok(saved.length > 1 && saved.length < 31, `Some older prompts were dropped (${saved.length} kept).`);
  assert.equal(saved[0].prompt, 'Add a test.', 'The newest prompt is kept.');
  assert.equal(saved.at(-1).id, `old-${saved.length - 2}`, 'The oldest prompts go first.');
  assert.equal($('#storage-warning').hidden, true);
  assert.match($('#announcement').textContent, new RegExp(`the ${31 - saved.length} oldest prompts were removed from history`));
  assert.equal($('#history-list').children.length, saved.length);
});

test('Open folder… turns a chosen folder into a linked project, sets up Git when needed without adding files, and reuses a known folder', { skip: process.platform === 'win32' }, async t => {
  const repo = await gitRepo(t);
  const plain = await realpath(await mkdtemp(join(tmpdir(), 'pb-ui-open-')));
  t.after(() => rm(plain, { recursive: true, force: true }));
  await writeFile(join(plain, 'mine.txt'), 'my file\n');
  const picks = [{ path: `${repo}/` }, { path: plain }, { cancelled: true }, { path: repo }];
  const ctx = await setup(t, { folderPicker: async () => picks.shift() });
  const { $, win } = ctx;
  await goTo(ctx, '#/kanban');
  const names = () => [...$('#workspace-list').querySelectorAll('.workspace-name')].map(item => item.textContent);
  // A Git repository becomes a linked project named after its folder.
  await click(ctx, $('#workspace-open'));
  await until(() => $('#repo-state').textContent.includes(`Linked to ${repo}`), 'project created and linked');
  const repoName = repo.split('/').pop();
  assert.deepEqual(names(), [repoName]);
  // A folder without Git becomes a linked project too: git init and one empty first commit. Its files are not added.
  await click(ctx, $('#workspace-open'));
  await until(() => names().length === 2 && $('#repo-state').textContent.includes(`Linked to ${plain}`), 'second project, Git set up');
  assert.equal(ctx.shownName(), plain.split('/').pop());
  assert.equal(gitIn(plain, 'log', '--format=%s'), 'Initial commit');
  assert.equal(gitIn(plain, 'status', '--porcelain'), '?? mine.txt', 'The user\'s file is not committed.');
  assert.match($('#announcement').textContent, /Git was set up there with an empty first commit; your files were not added/);
  // Cancelling the picker changes nothing; a folder that a project already uses is selected, not duplicated.
  await click(ctx, $('#workspace-open'));
  assert.equal(names().length, 2);
  await click(ctx, $('#workspace-open'));
  await until(() => ctx.shownName() === repoName, 'existing project selected');
  assert.equal(names().length, 2);
  assert.match($('#announcement').textContent, /already uses this folder/);
});

test('without a system folder picker, Open folder… asks for the path instead', { skip: process.platform === 'win32' }, async t => {
  const repo = await gitRepo(t);
  const { BoardError } = await import('../src/board.mjs');
  const ctx = await setup(t, { folderPicker: async () => { throw new BoardError('No picker.', 'PICKER_UNAVAILABLE', 501); } });
  const { $ } = ctx;
  await goTo(ctx, '#/kanban');
  await click(ctx, $('#workspace-open'));
  assert.equal($('#workspace-path-form').hidden, false);
  $('#workspace-path').value = 'relative/path'; submitForm(ctx, '#workspace-path-form'); await ctx.idle();
  assert.match($('#workspace-path-error').textContent, /absolute path/);
  $('#workspace-path').value = repo; submitForm(ctx, '#workspace-path-form');
  await until(() => $('#workspace-list').querySelectorAll('.workspace-item').length === 1, 'project from typed path');
  assert.equal($('#workspace-path-form').hidden, true);
  await until(() => $('#repo-state').textContent.includes(`Linked to ${repo}`), 'linked from typed path');
});

test('Testing starts its agent on arrival and verifies commands after confirmation; Merge needs its button; one click merges', { skip: process.platform === 'win32' }, async t => {
  const ctx = await linkedKanban(t);
  const { $, win } = ctx;
  await link(ctx);
  const board = ctx.app.board;
  const created = await board.createTask({ projectId: ctx.project.id, title: 'Checked', prompt: 'Add input checks.' });
  await board.moveTask(created.id, { column: 'executing', expectedRevision: 1 });
  const ws = (await board.ensureTaskWorktree(created.id)).path;
  await writeFile(join(ws, 'checks.txt'), 'checks\n');
  await board.delivery.commit(created.id, { message: 'checks', confirm: true });
  const current = async () => (await serverBoard(ctx)).projects[0].tasks.find(task => task.id === created.id);
  await board.moveTask(created.id, { column: 'code_review', expectedRevision: (await current()).revision });
  const head = (await board.delivery.revision(created.id)).taskCommit;
  await board.delivery.recordReview({ id: 'review-run', taskId: created.id, review: { taskCommit: head }, promptRevision: 1 }, '```json\n{"verdict":"no_issues","findings":[]}\n```');
  await board.delivery.setTestCommands(ctx.project.id, { commands: [{ command: `${process.execPath} -e "0"` }], expectedRevision: (await serverBoard(ctx)).projects[0].revision });
  // Dropping on Testing runs the project's tests at once.
  await win.__pbTest.loadBoard(); await ctx.idle();
  await moveBy(ctx, 'Checked', 'testing'); await ctx.idle();
  assert.match($('#announcement').textContent, /started the Testing agent/);
  assert.equal(ctx.executor.started.at(-1).stage, 'testing');
  await ctx.executor.confirm(ctx.executor.started.at(-1).id);
  await until(async () => (await current()).evidence?.tests?.status === 'passed', 'tests passed');
  await win.__pbTest.loadBoard(); await ctx.idle();
  const card = () => cardItem(ctx, 'Checked');
  assert.equal(card().querySelector('.kanban-deliver').textContent, 'Run tests again');
  assert.equal(card().querySelector('.kanban-start').textContent, 'Start testing agent');
  await click(ctx, card().querySelector('.kanban-start'));
  assert.equal(ctx.executor.started.at(-1).stage, 'testing');
  assert.equal(ctx.executor.started.at(-1).config.permissionMode, 'acceptEdits', 'The testing agent can edit in the worktree.');
  await board.updateRun(ctx.executor.started.at(-1).id, { status: 'running' });
  await ctx.executor.cancel(ctx.executor.started.at(-1).id);
  // Merge: entering verifies; the card shows one merge button and a pull request button.
  await win.__pbTest.loadBoard(); await ctx.idle();
  await moveBy(ctx, 'Checked', 'merge'); await ctx.idle({ requireComplete: true });
  await until(() => !card().textContent.includes('Moving to Merge'), 'merge arrival finished', 15000);
  assert.match(card().textContent, /Ready to merge into trunk\./);
  assert.equal(card().querySelector('.kanban-merge').textContent, 'Merge trunk');
  assert.equal(card().querySelector('.kanban-pr').textContent, 'Open pull request');
  await click(ctx, card().querySelector('.kanban-merge'));
  await ctx.idle({ requireComplete: true });
  await until(async () => (await current()).column === 'done', 'merge completion saved', 15000);
  const done = await current();
  assert.deepEqual([done.column, done.completion.kind, done.completion.trigger], ['done', 'merged', 'user']);
  assert.match($('#announcement').textContent, /Merged “Checked” into trunk\. The card is Done/);
});

test('Autopilot dialog: queue order, which cards, per-card routes, consent to start, and a live status bar', { skip: process.platform === 'win32' }, async t => {
  const ctx = await linkedKanban(t);
  const { $, win } = ctx;
  await link(ctx);
  for (const title of ['Alpha', 'Beta', 'Gamma']) await ctx.app.board.createTask({ projectId: ctx.project.id, title, prompt: `Do ${title}.` });
  await win.__pbTest.loadBoard(); await ctx.idle();
  $('#autopilot-open').click(); await ctx.idle();
  assert.equal($('#autopilot-dialog').open, true);
  const items = () => [...$('#autopilot-queue').querySelectorAll('.autopilot-item')];
  const names = () => items().map(item => item.querySelector('.autopilot-title').textContent);
  assert.deepEqual(names(), ['Alpha', 'Beta', 'Gamma'], 'To Do cards in board order, all included the first time.');
  // Gamma first; Beta left out; Alpha skips Planning and Testing via its own route (Merge becomes a pull request).
  items()[2].querySelector('.autopilot-up').click(); items()[1].querySelector('.autopilot-up').click();
  assert.deepEqual(names(), ['Gamma', 'Alpha', 'Beta']);
  const beta = items()[2].querySelector('input[type="checkbox"]'); beta.checked = false; beta.dispatchEvent(new win.Event('change'));
  $('#autopilot-finish').value = 'pull_request'; $('#autopilot-finish').dispatchEvent(new win.Event('change'));
  for (const stage of ['planning', 'testing']) { const chip = items()[1].querySelector(`.route-chip[data-stage="${stage}"] input`); chip.checked = false; chip.dispatchEvent(new win.Event('change')); }
  assert.equal(items()[1].querySelector('.autopilot-custom').textContent, 'Own route');
  assert.equal(items()[0].querySelector('.route-chip[data-stage="executing"] input').disabled, true, 'Executing is always in the route.');
  // Starting needs the explicit acknowledgment.
  submitForm(ctx, '#autopilot-form'); await ctx.idle();
  assert.match($('#autopilot-error').textContent, /Confirm that you understand/);
  $('#autopilot-consent').checked = true;
  // A route that merges without Testing breaks the stage contract, so the server refuses it with the reason.
  submitForm(ctx, '#autopilot-form'); await ctx.idle();
  assert.match($('#autopilot-error').textContent, /Merge must include Code Review and Testing/);
  assert.equal($('#autopilot-dialog').open, true);
  for (const [stage, on] of [['testing', true], ['merge', false]]) { const chip = items()[1].querySelector(`.route-chip[data-stage="${stage}"] input`); chip.checked = on; chip.dispatchEvent(new win.Event('change')); }
  submitForm(ctx, '#autopilot-form'); await ctx.idle();
  assert.equal($('#autopilot-dialog').open, false);
  const project = (await serverBoard(ctx)).projects[0];
  const id = title => project.tasks.find(task => task.title === title).id;
  assert.deepEqual(project.autopilot.queue, [id('Gamma'), id('Alpha')]);
  assert.deepEqual(project.autopilot.routes, { [id('Alpha')]: ['executing', 'code_review', 'testing'] });
  assert.equal(project.autopilot.finish, 'pull_request');
  assert.equal(project.autopilot.status, 'running');
  // The engine picks Gamma first; the bar and the card show it.
  await win.__pbTest.loadBoard(); await ctx.idle();
  for (const end = Date.now() + 10000; !/Autopilot is working on “Gamma”/.test($('#autopilot-bar').textContent);) {
    if (Date.now() > end) assert.fail(`Timed out: status bar (${$('#autopilot-bar').textContent})`);
    await new Promise(resolve => setTimeout(resolve, 200));
    await win.__pbTest.loadBoard(); await ctx.idle();
  }
  assert.equal(cardItem(ctx, 'Gamma').querySelector('.autopilot-tag').textContent, 'Autopilot · now');
  assert.equal(cardItem(ctx, 'Alpha').querySelector('.autopilot-tag').textContent, 'Autopilot · #1');
  assert.equal(cardItem(ctx, 'Beta').querySelector('.autopilot-tag'), null);
  // Pause from the bar; settings stay editable only while not running.
  [...$('#autopilot-bar').querySelectorAll('button')].find(button => button.textContent === 'Pause').click(); await ctx.idle();
  await until(() => /Autopilot paused: Paused by you/.test($('#autopilot-bar').textContent), 'paused bar');
  assert.ok([...$('#autopilot-bar').querySelectorAll('button')].some(button => button.textContent === 'Resume'));
});

// ---- Agents sidebar and dock tabs ----

test('the Agents sidebar shows real runs with provider, model, stage, and state; selecting one opens its project, card, and terminal', { skip: process.platform === 'win32' }, async t => {
  const ctx = await agentFixture(t);
  const { $, win } = ctx;
  assert.equal($('#workspace-panel').hidden, false);
  assert.equal($('#history-panel').hidden, true, 'Agents belong to the Kanban sidebar only.');
  // This project: the waiting agent first, then the active one.
  let rows = agentRows(ctx);
  assert.deepEqual(rows.map(row => row.querySelector('.agent-title').textContent), ['API tests', 'Auth middleware']);
  assert.match(rows[0].textContent, /Codex CLI · gpt-5\.5/);
  assert.match(rows[0].textContent, /Code Review · Awaits you/);
  assert.equal(rows[0].querySelector('.agent-icon').textContent, '!');
  assert.match(rows[0].getAttribute('aria-label'), /Awaits you/, 'State is in text and the accessible name, not colour alone.');
  assert.match(rows[1].textContent, /Claude Code · opus · high/);
  assert.match(rows[1].textContent, /Executing · Active/);
  assert.equal($('#agents-count').textContent, '02');
  assert.match(cardItem(ctx, 'API tests').textContent, /Code Review · AWAITS YOU/);
  assert.match(cardItem(ctx, 'Auth middleware').textContent, /Claude Code · opus · high/);
  assert.match(cardItem(ctx, 'Auth middleware').textContent, /Working…/);
  // All projects: the queued run of the other project is On hold and names its project.
  $('#agents-filter').value = 'all'; $('#agents-filter').dispatchEvent(new win.Event('change'));
  rows = agentRows(ctx);
  assert.equal(rows.length, 3);
  const queued = rows.find(row => row.dataset.runId === 'run-c');
  assert.match(queued.textContent, /Planning · On hold/);
  assert.match(queued.textContent, /Claude Code · CLI default model/);
  assert.match(queued.textContent, /Project: Other/);
  assert.equal(win.localStorage.getItem('promptboard.agents.filter'), 'all');
  // Selecting it switches project and opens its existing run in the dock. No run starts.
  queued.click(); await ctx.idle();
  assert.equal(ctx.shown(), ctx.other.id);
  assert.ok(cardItem(ctx, 'Review docs').classList.contains('agent-focus'));
  assert.equal(win.promptboardDock.selected, 'run-c');
  assert.equal(ctx.executor.started.length, 0, 'Selecting an agent never starts a run.');
  // A finished run becomes Inactive; a reload shows each run once.
  await ctx.app.board.updateRun('run-a', { status: 'succeeded', endedAt: Date.now() });
  await win.__pbTest.loadBoard(); await ctx.idle();
  await win.__pbTest.loadBoard(); await ctx.idle();
  rows = agentRows(ctx);
  assert.equal(rows.length, 3);
  assert.match(rows.find(row => row.dataset.runId === 'run-a').textContent, /Inactive · succeeded/);
  assert.equal($('#agents-count').textContent, '02');
});

test('dock tabs: one per run with state and model; switching never restarts; closing a tab never stops the agent', { skip: process.platform === 'win32' }, async t => {
  const ctx = await agentFixture(t);
  const { $, win } = ctx;
  const tabs = () => Array.from($('#dock-tabs').querySelectorAll('.dock-tab:not(#dock-tab-activity)'));
  assert.deepEqual(tabs().map(tab => tab.id).sort(), ['dock-tab-run-a', 'dock-tab-run-b', 'dock-tab-run-c']);
  const b = $('#dock-tab-run-b');
  assert.match(b.textContent, /API tests · Codex CLI · gpt-5\.5/);
  assert.equal(b.dataset.state, 'awaits_you');
  assert.match(b.getAttribute('aria-label'), /Codex CLI · gpt-5\.5: Awaits you/);
  assert.equal($('#dock-tab-run-a').dataset.state, 'active');
  assert.equal($('#dock-tab-run-c').dataset.state, 'on_hold');
  const sessionA = win.promptboardDock.sessions.get('run-a');
  $('#dock-tab-run-b').click(); $('#dock-tab-run-a').click(); await ctx.idle();
  assert.equal(win.promptboardDock.sessions.get('run-a'), sessionA, 'Switching tabs keeps the same session.');
  assert.match($('#dock-details .dock-run-summary').textContent, /Claude Code · opus · high · Executing · Active/);
  assert.match($('#dock-details .dock-location').textContent, /Task branchpromptboard\/run-a.*Worktree\/tmp\/wt-run-a/);
  assert.equal($('#dock-indicator').textContent, '1 waiting for you');
  // Close the active tab: the run keeps its status, the indicator still counts it, a reload does not reopen it.
  $('#dock-tab-run-a .tab-close').click(); await ctx.idle();
  assert.equal($('#dock-tab-run-a'), null);
  assert.equal((await ctx.app.board.run('run-a')).status, 'running', 'Closing a tab does not stop the agent.');
  await win.__pbTest.loadBoard(); await ctx.idle();
  assert.equal($('#dock-tab-run-a'), null);
  assert.equal(tabs().length, 2, 'Reloading the board does not duplicate tabs.');
  // Selecting the agent again reopens its tab.
  $('#agents-list [data-run-id="run-a"]').click(); await ctx.idle();
  assert.ok($('#dock-tab-run-a'));
  assert.equal(win.promptboardDock.selected, 'run-a');
  assert.equal(ctx.executor.started.length, 0);
});

test('Kanban project and stage agent selection is visible, persists, and launches the selected provider independently of Compose', { skip: process.platform === 'win32' }, async t => {
  const ctx = await linkedKanban(t);
  const { $, win, choose } = ctx;
  await link(ctx);
  if (!$('#project-body').hidden) $('#project-toggle').click();
  assert.equal($('#project-body').hidden, true);
  assert.equal($('#project-settings').hidden, true, 'All project controls collapse outside the board.');
  $('#project-toggle').click();
  assert.equal($('#project-settings').hidden, false);
  assert.ok($('#project-settings').contains($('#project-agent-form')));
  assert.ok(!$('.kanban-board').contains($('#project-settings')));
  assert.equal($('#project-agent-panel').hidden, true);
  assert.equal($('#project-location').hidden, true);
  $('#project-files-toggle').click();
  assert.equal($('#project-location').hidden, false);
  $('#project-agent-toggle').click();
  assert.equal($('#project-agent-panel').hidden, false);
  assert.match($('#project-location').textContent, new RegExp(ctx.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match($('#project-location').textContent, /Target branchtrunk/);
  choose('#project-agent-fields [data-field="provider"]', 'codex');
  await ctx.idle();
  choose('#project-agent-fields [data-field="model"]', 'codex-two');
  assert.deepEqual(Array.from($('#project-agent-fields [data-field="effort"]').options, item => item.value), ['', 'low']);
  choose('#project-agent-fields [data-field="effort"]', 'low');
  await win.__pbTest.loadBoard();
  assert.equal($('#project-agent-fields [data-field="model"]').value, 'codex-two', 'Background board refresh preserves unsaved selections.');
  submitForm(ctx, '#project-agent-form'); await ctx.idle();
  let project = (await serverBoard(ctx)).projects[0];
  assert.deepEqual(project.agentDefaults, { provider: 'codex', model: 'codex-two', effort: 'low' });
  assert.equal(project.effectiveWorkflow.executing.provider, 'codex');
  assert.match($('#kanban-columns [data-column="executing"] .column-agent').textContent, /Codex CLI · codex-two · low/);
  // Each stage has a direct settings shortcut, with an independent provider and model.
  $('#kanban-columns [data-column="code_review"] .column-agent').click(); await ctx.idle();
  const review = '#workflow-stages [data-stage="code_review"]';
  assert.equal(win.document.activeElement, $(`${review} [data-field="provider"]`));
  choose(`${review} [data-field="provider"]`, 'claude'); await ctx.idle();
  choose(`${review} [data-field="model"]`, 'haiku');
  assert.equal($(`${review} [data-field="effort"]`).disabled, true);
  submitForm(ctx, '#workflow-form'); await ctx.idle();
  project = (await serverBoard(ctx)).projects[0];
  assert.equal(project.effectiveWorkflow.code_review.provider, 'claude');
  assert.equal(project.effectiveWorkflow.code_review.model, 'haiku');
  assert.equal(project.effectiveWorkflow.executing.provider, 'codex');
  assert.match($('#project-agent-summary').textContent, /Stage overrides: Code Review/);
  // Compose can select Claude without changing the project's Codex agent.
  choose('#provider', 'claude'); await ctx.idle();
  await newCard(ctx, 'Selected agent', 'Build the feature.');
  await moveBy(ctx, 'Selected agent', 'executing'); await ctx.idle();
  const run = ctx.executor.started.at(-1);
  assert.deepEqual([run.config.provider, run.config.model, run.config.effort], ['codex', 'codex-two', 'low']);
  assert.match(cardItem(ctx, 'Selected agent').querySelector('.run-agent').textContent, /Run agent: Codex CLI · codex-two/);
  assert.match($(`#dock-tab-${run.id}`).textContent, /Codex CLI · codex-two/);
  assert.match($('#dock-details').textContent, /Codex CLI · codex-two/);
  assert.ok($('#dock-details').textContent.includes(ctx.repo));
  assert.ok($('#dock-details').textContent.includes(run.branch));
  assert.ok($('#dock-details').textContent.includes(run.workspacePath));
  cardItem(ctx, 'Selected agent').querySelector('.card-workspace').open = true;
  const facts = cardItem(ctx, 'Selected agent').querySelector('.task-location');
  assert.ok(facts.textContent.includes(run.workspacePath));
  const copy = [...facts.querySelectorAll('button')].find(button => button.textContent === 'Copy worktree');
  copy.click(); await ctx.idle();
  assert.equal(ctx.copied(), run.workspacePath);
  const taskItem = cardItem(ctx, 'Selected agent');
  taskItem.querySelector('.kanban-more-toggle').click();
  column($, 'executing').scrollTop = 81;
  await win.__pbTest.loadBoard(); await ctx.idle();
  assert.equal(cardItem(ctx, 'Selected agent').querySelector('.card-workspace').open, true, 'Board refresh keeps open file details.');
  assert.equal(cardItem(ctx, 'Selected agent').querySelector('.kanban-more').hidden, false, 'Board refresh keeps the action menu open.');
  assert.equal(column($, 'executing').scrollTop, 81, 'Board refresh does not jump to the first card.');
  // A new default affects future runs; the existing run still identifies Codex accurately.
  $('#project-agent-toggle').click();
  choose('#project-agent-fields [data-field="provider"]', 'claude'); await ctx.idle();
  submitForm(ctx, '#project-agent-form'); await ctx.idle();
  assert.equal((await ctx.app.board.run(run.id)).config.provider, 'codex');
  assert.match($(`#dock-tab-${run.id}`).textContent, /Codex CLI/);
  const reload = await setup(t, { executor: ctx.executor, hash: '#/kanban', dataDir: ctx.dataDir }); await reload.idle();
  assert.equal(reload.$('#project-agent-fields [data-field="provider"]').value, 'claude');
  assert.match(reload.$('#kanban-columns [data-column="code_review"] .column-agent').textContent, /haiku/);
});

test('Stop stays visible from a collapsed dock, survives refresh and tab switches, retries errors, and stops only the confirmed run', { skip: process.platform === 'win32' }, async t => {
  const ctx = await agentFixture(t);
  const { $, win } = ctx;
  const cancel = ctx.executor.cancel;
  let attempts = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  ctx.executor.cancel = async runId => {
    attempts++;
    if (attempts === 1) throw new Error('Simulated stop failure.');
    await gate;
    await cancel(runId);
  };
  $('#dock-tab-run-a').click();
  if (win.promptboardDock.state !== 'collapsed') $('#dock-toggle').click();
  $('#dock-stop').click();
  const prompt = $('#dock-stop-prompt');
  assert.equal(win.promptboardDock.state, 'open');
  assert.equal(prompt.hidden, false);
  assert.equal(prompt.querySelector('button'), win.document.activeElement);
  $('#dock-toggle').click();
  assert.equal(win.promptboardDock.state, 'collapsed');
  assert.equal(prompt.hidden, false, 'Collapsing during confirmation keeps the independent Stop controls.');
  await win.__pbTest.loadBoard(); await ctx.idle();
  assert.equal(prompt.hidden, false, 'Refreshing the board does not erase the confirmation.');
  $('#dock-tab-run-b').click();
  const originalConfirmation = prompt.querySelector('button');
  $('#dock-stop').click();
  assert.equal(prompt.querySelector('button'), originalConfirmation, 'Another Stop click cannot replace a pending confirmation after switching tabs.');
  prompt.querySelector('button').click();
  await until(() => prompt.querySelector('button').textContent === 'Retry stop', 'visible stop error');
  assert.equal(prompt.hidden, false);
  const retry = prompt.querySelector('button'); retry.click(); retry.click();
  await until(() => attempts === 2, 'one retry request');
  assert.equal(retry.disabled, true);
  release();
  await until(() => prompt.hidden, 'stop completed');
  assert.equal(attempts, 2, 'Repeated clicks do not send duplicate stop requests.');
  assert.equal((await ctx.app.board.run('run-a')).status, 'cancelled');
  assert.equal((await ctx.app.board.run('run-b')).status, 'waiting_for_input', 'Switching tabs never changes the confirmed stop target.');
  assert.equal(win.promptboardDock.sessions.get('run-a').ended, true);
});

test('Run details preserve immediate disclosure changes across refreshes and tab switches', { skip: process.platform === 'win32' }, async t => {
  const ctx = await agentFixture(t);
  const { $, win } = ctx;
  $('#dock-tab-run-a').click();
  $('#dock-details .dock-context').open = true;
  win.PromptboardDock.sync(); // Native toggle events have not fired yet.
  assert.equal($('#dock-details .dock-context').open, true);
  $('#dock-tab-run-b').click();
  assert.equal($('#dock-details .dock-context').open, false, 'Disclosure is per run.');
  $('#dock-tab-run-a').click();
  assert.equal($('#dock-details .dock-context').open, true);
  $('#dock-details .dock-context').open = false;
  win.PromptboardDock.sync();
  assert.equal($('#dock-details .dock-context').open, false);
});
