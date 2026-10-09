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

test('a successful saved-board migration preserves projects and tasks without a corruption warning', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-ui-migration-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const savedBoard = new Board({ dataDir });
  const project = await savedBoard.createProject({ name: 'Existing project' });
  const task = await savedBoard.createTask({ projectId: project.id, title: 'Existing task', prompt: 'Keep this exact task.\r\n' });
  const path = join(dataDir, 'state.json');
  const previous = JSON.parse(await readFile(path, 'utf8'));
  previous.version = 6;
  delete previous.projects[0].nextTaskNumber;
  delete previous.projects[0].tasks[0].number;
  const original = JSON.stringify(previous);
  await writeFile(path, original);
  const ctx = await setup(t, { dataDir, executor: null, hash: '#/kanban' });
  await ctx.win.__pbTest.loadBoard(); await ctx.idle({ requireComplete: true });
  assert.equal(ctx.app.board.store.recovery.migratedFromVersion, 6);
  assert.equal(ctx.$('#kanban-load-warning').hidden, true);
  const saved = await ctx.app.board.state();
  assert.equal(saved.projects[0].id, project.id);
  assert.equal(saved.projects[0].tasks[0].id, task.id);
  assert.equal(saved.projects[0].tasks[0].prompt, task.prompt);
  assert.equal(await readFile(join(dataDir, ctx.app.board.store.recovery.migrationBackup), 'utf8'), original);
});

test('board recovery warnings distinguish real corruption, missing primary and healthy migration', async t => {
  const ctx = await setup(t, { executor: null, hash: '#/kanban' });
  const cases = [
    [{ quarantined: 'state.corrupt-test.json', restoredFromBackup: true, migratedFromVersion: 6 }, /damaged, so the last good copy was restored/],
    [{ quarantined: 'state.corrupt-test.json', restoredFromBackup: false }, /damaged and no good copy was found/],
    [{ quarantined: null, restoredFromBackup: true }, /missing, so the last good copy was restored/],
    [{ migratedFromVersion: 6, migrationBackup: 'state.pre-migration-test.json' }, null],
    [null, null],
  ];
  for (const [recovery, expected] of cases) {
    ctx.app.board.store.recovery = recovery;
    await ctx.win.__pbTest.loadBoard(); await ctx.idle({ requireComplete: true });
    const warning = ctx.$('#kanban-load-warning');
    assert.equal(warning.hidden, expected === null);
    if (expected) assert.match(warning.textContent, expected);
  }
});

test('owned UI teardown closes its page and server before deleting the disposable data folder', async t => {
  const ctx = await setup(t, { executor: null }), close = ctx.app.close; let closes = 0;
  ctx.app.close = async (...args) => {
    closes++; await access(ctx.dataDir);
    assert.equal(ctx.win.document, undefined, 'The owned page is closed before its server.');
    return close(...args);
  };
  t.after(async () => { assert.equal(closes, 1); await assert.rejects(access(ctx.dataDir), { code: 'ENOENT' }); });
});

test('repository change polling preserves editor drafts and applies only after a fresh explicit review', async t => {
  const ctx = await setup(t, { executor: null, hash: '#/kanban' });
  Object.defineProperty(ctx.win.document, 'hidden', { configurable: true, value: false });
  const { project } = await ctx.app.board.createProjectWithRepository({ name: 'Watched draft', folder: 'new' }), pipeline = defaultPipelineConfig();
  for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  await ctx.app.board.setPipeline(project.id, { pipeline, expectedRevision: project.revision, confirm: true });
  const task = await ctx.app.board.createTask({ projectId: project.id, title: 'Split', prompt: '  Exact 😀\r\n' }), team = repositoryPipelineDefinition(pipeline);
  await writeFile(join(project.repository.root, 'promptboard.json'), JSON.stringify(team));
  await ctx.app.board.applyRepositoryPipeline(project.id, { ...await ctx.app.board.previewRepositoryPipeline(project.id), confirm: true });
  await ctx.win.__pbTest.loadBoard(); await ctx.idle({ requireComplete: true });
  ctx.$('#columns-open').click(); ctx.$('#column-name').value = 'My unsaved draft'; ctx.$('#column-name').dispatchEvent(new ctx.win.Event('input')); ctx.$('#column-name').focus();
  const before = structuredClone(await ctx.app.board.state());
  team.columns[2].description = '<img src=x onerror=evil> new external configuration'; await writeFile(join(project.repository.root, 'promptboard.json'), JSON.stringify(team));
  await ctx.win.__pbTest.refreshRepositoryPipelineStatus({ force: true });
  assert.equal(ctx.$('#repository-pipeline-warning').hidden, false); assert.equal(ctx.$('#column-name').value, 'My unsaved draft'); assert.equal(ctx.win.document.activeElement.id, 'column-name'); assert.equal(ctx.$('#repository-pipeline-warning img'), null);
  assert.deepEqual(await ctx.app.board.state(), before);
  ctx.$('#repository-pipeline-warning-review').click(); await until(() => !ctx.$('#repository-pipeline-apply').disabled, 'fresh review from detected change');
  assert.equal(ctx.$('#column-name').value, 'My unsaved draft'); assert.equal(ctx.$('#repository-pipeline-dialog').open, true); assert.equal(ctx.$('#repository-pipeline-preview img'), null);
  ctx.$('#repository-pipeline-cancel').click(); assert.equal(ctx.$('#column-name').value, 'My unsaved draft'); assert.deepEqual(await ctx.app.board.state(), before);
  ctx.$('#repository-pipeline-warning-review').click(); await until(() => !ctx.$('#repository-pipeline-apply').disabled, 'explicit second review');
  ctx.$('#repository-pipeline-apply').click(); await until(() => !ctx.$('#columns-dialog').open, 'explicit apply'); await ctx.idle({ requireComplete: true }); await ctx.win.__pbTest.refreshRepositoryPipelineStatus({ force: true });
  assert.equal(ctx.$('#repository-pipeline-warning').hidden, true); const saved = (await ctx.app.board.state()).projects[0]; assert.equal(saved.pipeline.columns[2].description, team.columns[2].description); assert.equal(saved.tasks[0].prompt, task.prompt); assert.deepEqual((await ctx.app.board.state()).runs, []);
});

test('a late repository status response cannot show another project’s warning; hidden and Compose views make no status request', async t => {
  const ctx = await setup(t, { executor: null, hash: '#/kanban' });
  Object.defineProperty(ctx.win.document, 'hidden', { configurable: true, value: false });
  const { project } = await ctx.app.board.createProjectWithRepository({ name: 'Watch A', folder: 'new' }), pipeline = defaultPipelineConfig();
  for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  await ctx.app.board.setPipeline(project.id, { pipeline, expectedRevision: project.revision, confirm: true });
  await writeFile(join(project.repository.root, 'promptboard.json'), JSON.stringify(repositoryPipelineDefinition(pipeline)));
  await ctx.app.board.applyRepositoryPipeline(project.id, { ...await ctx.app.board.previewRepositoryPipeline(project.id), confirm: true });
  const second = await ctx.app.board.createProject({ name: 'Watch B' });
  await ctx.win.__pbTest.loadBoard(); await ctx.idle({ requireComplete: true });
  const original = ctx.win.fetch, held = Promise.withResolvers(); let polls = 0;
  ctx.win.fetch = (url, options) => { if (url.endsWith('/repository-pipeline-status')) { polls++; return held.promise; } return original(url, options); };
  const pending = ctx.win.__pbTest.refreshRepositoryPipelineStatus({ force: true }); await until(() => polls === 1, 'owned status request');
  const status = await ctx.app.board.repositoryPipelineStatus(project.id);
  ctx.pick(second.id); held.resolve(Response.json({ ...status, changed: true })); await pending;
  assert.equal(ctx.$('#repository-pipeline-warning').hidden, true); assert.equal(ctx.shown(), second.id);
  ctx.pick(project.id); await ctx.win.__pbTest.refreshRepositoryPipelineStatus({ force: true }); const before = polls;
  ctx.win.location.hash = '#/'; await ctx.win.__pbTest.refreshRepositoryPipelineStatus({ force: true }); assert.equal(polls, before);
  ctx.win.location.hash = '#/kanban'; Object.defineProperty(ctx.win.document, 'hidden', { configurable: true, value: true }); await ctx.win.__pbTest.refreshRepositoryPipelineStatus({ force: true }); assert.equal(polls, before);
  Object.defineProperty(ctx.win.document, 'hidden', { configurable: true, value: false }); ctx.win.fetch = original;
});

test('an ordinary project edit cannot start duplicate repository polls or accept a stale status result', async t => {
  const ctx = await setup(t, { executor: null, hash: '#/kanban' });
  Object.defineProperty(ctx.win.document, 'hidden', { configurable: true, value: false });
  const { project } = await ctx.app.board.createProjectWithRepository({ name: 'Watch revision', folder: 'new' }), pipeline = defaultPipelineConfig();
  for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  await ctx.app.board.setPipeline(project.id, { pipeline, expectedRevision: project.revision, confirm: true });
  await writeFile(join(project.repository.root, 'promptboard.json'), JSON.stringify(repositoryPipelineDefinition(pipeline)));
  await ctx.app.board.applyRepositoryPipeline(project.id, { ...await ctx.app.board.previewRepositoryPipeline(project.id), confirm: true });
  await ctx.win.__pbTest.loadBoard(); await ctx.idle({ requireComplete: true });
  const original = ctx.win.fetch, held = Promise.withResolvers(), old = await ctx.app.board.repositoryPipelineStatus(project.id); let polls = 0;
  ctx.win.fetch = (url, options) => { if (url.endsWith('/repository-pipeline-status')) { polls++; return held.promise; } return original(url, options); };
  const pending = ctx.win.__pbTest.refreshRepositoryPipelineStatus({ force: true }); await until(() => polls === 1, 'single owned poll');
  await ctx.app.board.renameProject(project.id, { name: 'Ordinary name edit', expectedRevision: old.expectedProjectRevision }); await ctx.win.__pbTest.loadBoard();
  assert.equal(polls, 1, 'A project revision cannot bypass the existing in-flight request.');
  held.resolve(Response.json({ ...old, changed: true })); await pending;
  assert.equal(ctx.$('#repository-pipeline-warning').hidden, true, 'The old revision cannot display its change result.');
  ctx.win.fetch = original; await ctx.win.__pbTest.refreshRepositoryPipelineStatus({ force: true }); assert.equal(ctx.$('#repository-pipeline-warning').hidden, true); assert.deepEqual((await ctx.app.board.state()).runs, []);
});

test('repository status failures are literal, preserve the saved board and clear after the source recovers', async t => {
  const ctx = await setup(t, { executor: null, hash: '#/kanban' });
  Object.defineProperty(ctx.win.document, 'hidden', { configurable: true, value: false });
  const { project } = await ctx.app.board.createProjectWithRepository({ name: 'Watch errors', folder: 'new' }), pipeline = defaultPipelineConfig();
  for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  await ctx.app.board.setPipeline(project.id, { pipeline, expectedRevision: project.revision, confirm: true });
  const bytes = JSON.stringify(repositoryPipelineDefinition(pipeline)); await writeFile(join(project.repository.root, 'promptboard.json'), bytes);
  await ctx.app.board.applyRepositoryPipeline(project.id, { ...await ctx.app.board.previewRepositoryPipeline(project.id), confirm: true });
  await ctx.win.__pbTest.loadBoard(); await ctx.idle({ requireComplete: true }); const before = structuredClone(await ctx.app.board.state());
  await writeFile(join(project.repository.root, 'promptboard.json'), 'PRIVATE <img src=x>'); await ctx.win.__pbTest.refreshRepositoryPipelineStatus({ force: true });
  assert.equal(ctx.$('#repository-pipeline-warning').hidden, false); assert.ok(ctx.$('#repository-pipeline-warning-text').textContent.includes('could not be checked')); assert.ok(!ctx.$('#repository-pipeline-warning').textContent.includes('PRIVATE')); assert.equal(ctx.$('#repository-pipeline-warning img'), null);
  await writeFile(join(project.repository.root, 'promptboard.json'), bytes); await ctx.win.__pbTest.refreshRepositoryPipelineStatus({ force: true }); assert.equal(ctx.$('#repository-pipeline-warning').hidden, true);
  const original = ctx.win.fetch; ctx.win.fetch = (url, options) => url.endsWith('/repository-pipeline-status') ? Promise.resolve(Response.json({ error: '<img src=x> PRIVATE' }, { status: 503 })) : original(url, options);
  await ctx.win.__pbTest.refreshRepositoryPipelineStatus({ force: true }); assert.equal(ctx.$('#repository-pipeline-warning').hidden, false); assert.ok(!ctx.$('#repository-pipeline-warning').textContent.includes('PRIVATE')); assert.equal(ctx.$('#repository-pipeline-warning img'), null);
  ctx.win.fetch = original; await ctx.win.__pbTest.refreshRepositoryPipelineStatus({ force: true }); assert.equal(ctx.$('#repository-pipeline-warning').hidden, true); assert.deepEqual(await ctx.app.board.state(), before);
});

test('repository configuration review preserves Column Manager drafts and applies literal shared/local definitions without starting agents', async t => {
  const ctx = await setup(t, { executor: null, hash: '#/kanban' });
  const { project } = await ctx.app.board.createProjectWithRepository({ name: 'Repository review', folder: 'new' }), pipeline = defaultPipelineConfig();
  for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  await ctx.app.board.setPipeline(project.id, { pipeline, expectedRevision: project.revision, confirm: true });
  const task = await ctx.app.board.createTask({ projectId: project.id, title: 'Exact', prompt: '  Composer 😀\r\n' });
  const team = repositoryPipelineDefinition(pipeline), name = 'Build <img src=x onerror=evil>';
  team.columns[2].name = name; team.columns[1].strategy.planExitTarget = name;
  await writeFile(join(project.repository.root, 'promptboard.json'), JSON.stringify(team));
  await writeFile(join(project.repository.root, 'promptboard.local.json'), JSON.stringify({ version: 1, columns: [{ name, color: 'green' }] }));
  await ctx.win.__pbTest.loadBoard(); ctx.$('#columns-open').click(); ctx.$('#column-name').value = 'Unsaved'; ctx.$('#column-name').dispatchEvent(new ctx.win.Event('input'));
  ctx.$('#columns-repository-read').click(); await until(() => !ctx.$('#repository-pipeline-apply').disabled, 'reviewed config ready');
  assert.ok(ctx.$('#repository-pipeline-preview').textContent.includes(name)); assert.equal(ctx.$('#repository-pipeline-preview img'), null);
  assert.equal((await ctx.app.board.state()).projects[0].pipeline.columns[2].name, 'Executing'); assert.equal(ctx.$('#column-name').value, 'Unsaved');
  ctx.$('#repository-pipeline-apply').click(); await until(() => !ctx.$('#repository-pipeline-dialog').open, 'applied review closed');
  const saved = (await ctx.app.board.state()).projects[0]; assert.equal(saved.pipeline.columns[2].name, name); assert.equal(saved.pipeline.columns[2].color, 'green');
  assert.equal(saved.tasks[0].prompt, task.prompt); assert.deepEqual((await ctx.app.board.state()).runs, []); assert.equal(ctx.$('#columns-dialog').open, false);
});

test('stale repository review stays visible and cannot retry with newer revisions; closing it keeps the unsaved column draft', async t => {
  const ctx = await setup(t, { executor: null, hash: '#/kanban' });
  const { project } = await ctx.app.board.createProjectWithRepository({ name: 'Stale config', folder: 'new' }), pipeline = defaultPipelineConfig();
  for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  await ctx.app.board.setPipeline(project.id, { pipeline, expectedRevision: project.revision, confirm: true });
  const team = repositoryPipelineDefinition(pipeline); await writeFile(join(project.repository.root, 'promptboard.json'), JSON.stringify(team));
  await ctx.win.__pbTest.loadBoard(); ctx.$('#columns-open').click(); ctx.$('#column-name').value = 'My draft'; ctx.$('#column-name').dispatchEvent(new ctx.win.Event('input'));
  ctx.$('#columns-repository-read').click(); await until(() => !ctx.$('#repository-pipeline-apply').disabled, 'first review');
  team.columns[2].description = 'New external definition'; await writeFile(join(project.repository.root, 'promptboard.json'), JSON.stringify(team));
  ctx.$('#repository-pipeline-apply').click(); await until(() => !ctx.$('#repository-pipeline-error').hidden, 'stale review rejected');
  assert.equal(ctx.$('#repository-pipeline-dialog').open, true); assert.equal(ctx.$('#repository-pipeline-apply').disabled, true);
  assert.ok(ctx.$('#repository-pipeline-error').textContent.includes('changed after review')); assert.equal((await ctx.app.board.state()).projects[0].pipeline.columns[2].description, '');
  ctx.$('#repository-pipeline-cancel').click(); assert.equal(ctx.$('#columns-dialog').open, true); assert.equal(ctx.$('#column-name').value, 'My draft');
  ctx.$('#columns-repository-read').click();
  // A native close event from the old dialog can arrive after showModal reopens it.
  ctx.$('#repository-pipeline-dialog').dispatchEvent(new ctx.win.Event('close'));
  await until(() => !ctx.$('#repository-pipeline-apply').disabled, 'fresh explicit review survives the queued old close');
  ctx.$('#repository-pipeline-apply').click(); await until(() => !ctx.$('#repository-pipeline-dialog').open, 'fresh review applied');
  assert.equal((await ctx.app.board.state()).projects[0].pipeline.columns[2].description, 'New external definition'); assert.deepEqual((await ctx.app.board.state()).runs, []);
});

test('a pipeline revision conflict after an exit webhook never creates an automatic new move or repeats its effect', async t => {
  const ctx = await setup(t, { executor: null, hash: '#/kanban' }), pipeline = defaultPipelineConfig();
  const project = await ctx.app.board.createProject({ name: 'No replay' });
  for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  pipeline.columns[0].automations.onExit = [{ id: 'exit-fixture', name: 'Recorded effect', type: 'webhook', enabled: true, url: 'https://example.test/never-contacted' }];
  await ctx.app.board.setPipeline(project.id, { pipeline, expectedRevision: 1, confirm: true });
  const task = await ctx.app.board.createTask({ projectId: project.id, title: 'Original', prompt: 'Exact Composer body' });
  let effects = 0;
  ctx.app.board.automations.actions.fetcher = async () => {
    effects++;
    if (effects === 1) await ctx.app.board.updateTask(task.id, { title: 'Edited during exit', expectedRevision: 1 });
    return new Response(null, { status: 204 });
  };
  await ctx.win.__pbTest.loadBoard(); await ctx.idle({ requireComplete: true });
  const selector = ctx.$(`[data-id="${task.id}"] .kanban-move-to`); assert.ok(selector);
  selector.value = 'code_review'; selector.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
  // Settle the actual request/journal writes before the UI assertion deadline.
  // This fixture already gives request completion its own bounded failure check.
  await ctx.idle({ requireComplete: true });
  await until(() => effects === 1 && ctx.$('#announcement').textContent.includes('changed since'), 'visible conflicted move');
  assert.equal(effects, 1); const saved = (await ctx.app.board.state()).projects[0].tasks[0];
  assert.equal(saved.column, 'todo'); assert.equal(saved.title, 'Edited during exit'); assert.equal(saved.prompt, task.prompt);
  const history = await ctx.app.board.automationRuns(task.id); assert.equal(history.length, 1); assert.equal(history[0].actions[0].status, 'succeeded'); assert.equal(history[0].lifecycle.status, 'failed');
});

test('pipeline action editing preserves literal definitions, validates headers, and saves without executing or losing dormant messages', async t => {
  const ctx = await setup(t, { executor: null, hash: '#/kanban' }), pipeline = defaultPipelineConfig();
  const project = await ctx.app.board.createProject({ name: 'Action editor' });
  for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  const savedMessage = { id: 'dormant-message', name: 'Future message', type: 'send_message', enabled: false, message: '  Preserve {{title}}\r\n', mode: 'deferred' };
  pipeline.columns[3].automations.onEnter = [savedMessage]; await ctx.app.board.setPipeline(project.id, { pipeline, expectedRevision: 1, confirm: true });
  await ctx.app.board.createTask({ projectId: project.id, title: 'Composer', prompt: '  Exact edited split task\r\n' });
  let effects = 0; ctx.app.board.automations.actions.fetcher = async () => { effects++; return new Response(null, { status: 204 }); };
  await ctx.win.__pbTest.loadBoard(); await ctx.idle({ requireComplete: true }); ctx.$('#columns-open').click();
  [...ctx.win.document.querySelectorAll('.columns-item')].find(button => button.textContent === 'Code Review').click();
  const input = (row, key, value, event = 'input') => { const field = row.querySelector(`[data-field="${key}"]`); field.value = value; field.dispatchEvent(new ctx.win.Event(event, { bubbles: true })); return field; };
  const exit = () => ctx.$('[data-trigger="onExit"]');
  exit().querySelector('.automation-add').click(); let script = exit().querySelector('.automation-row');
  const scriptId = script.dataset.automationId; input(script, 'name', 'Literal script'); input(script, 'script', 'printf "%s" "$PROMPTBOARD_TITLE"\nexit 7'); input(script, 'timeoutMinutes', '12');
  exit().querySelector('.automation-add').click(); let hook = exit().querySelectorAll('.automation-row')[1], hookId = hook.dataset.automationId;
  input(hook, 'type', 'webhook', 'change'); hook = ctx.$(`[data-automation-id="${hookId}"]`);
  const malicious = 'Hook <img src=x onerror="window.__actionPwned=1">'; input(hook, 'name', malicious);
  input(hook, 'url', 'https://example.test/?title={{title}}'); input(hook, 'method', 'PUT', 'change'); input(hook, 'body', '{"title":"{{title}}"}');
  const headers = input(hook, 'headers', '{'); assert.equal(headers.checkValidity(), false);
  hook.querySelector('button[aria-label^="Move up automation"]').click(); hook = ctx.$(`[data-automation-id="${hookId}"]`);
  assert.equal(hook.querySelector('[data-field="headers"]').value, '{'); assert.equal(hook.querySelector('[data-field="headers"]').checkValidity(), false);
  submitForm(ctx, '#columns-form'); await ctx.idle({ requireComplete: true }); assert.equal(ctx.$('#columns-dialog').open, true);
  input(hook, 'headers', '{"X-Task":"{{taskId}}","Authorization":"PRIVATE_TOKEN"}'); assert.equal(hook.querySelector('[data-field="headers"]').checkValidity(), true);
  hook.querySelector('input[type="checkbox"]').click();
  assert.equal(exit().querySelector('.automation-row').dataset.automationId, hookId);
  const future = ctx.$('[data-automation-id="dormant-message"]'); assert.equal(future.querySelector('input[type="checkbox"]').disabled, true);
  assert.equal(future.querySelector('[data-field="type"] option[value="notify"]').disabled, false);
  assert.equal(future.querySelector('[data-field="type"] option[value="send_message"]').disabled, true);
  // Changing arrival policy updates eligibility without mutating a saved message.
  const automatic = ctx.$('#column-auto-spawn'); automatic.checked = true; automatic.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
  let currentMessage = ctx.$('[data-automation-id="dormant-message"]');
  assert.equal(currentMessage.querySelector('input[type="checkbox"]').disabled, false);
  assert.equal(currentMessage.querySelector('input[type="checkbox"]').checked, false);
  assert.equal(currentMessage.querySelector('[data-field="type"] option[value="send_message"]').disabled, false);
  const off = ctx.$('#column-auto-spawn'); off.checked = false; off.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
  currentMessage = ctx.$('[data-automation-id="dormant-message"]');
  assert.equal(currentMessage.querySelector('input[type="checkbox"]').disabled, true);
  assert.equal(currentMessage.querySelector('input[type="checkbox"]').checked, false);
  assert.equal(currentMessage.querySelector('[data-field="message"]').value, savedMessage.message.replaceAll('\r\n', '\n'));

  assert.equal(ctx.$('#columns-editor img'), null); assert.equal(ctx.win.__actionPwned, undefined);
  exit().querySelector('.automation-add').click(); const added = exit().querySelectorAll('.automation-row')[2];
  added.querySelector('.danger').click(); assert.equal(exit().querySelectorAll('.automation-row').length, 2);
  submitForm(ctx, '#columns-form'); await ctx.idle({ requireComplete: true }); assert.equal(ctx.$('#columns-dialog').open, false);
  const saved = (await ctx.app.board.state()).projects[0], review = saved.pipeline.columns[3];
  assert.deepEqual(review.automations.onExit.map(row => row.id), [hookId, scriptId]); assert.equal(review.automations.onExit[0].enabled, false);
  assert.equal(review.automations.onExit[0].name, malicious); assert.deepEqual(review.automations.onExit[0].headers, { 'X-Task': '{{taskId}}', Authorization: 'PRIVATE_TOKEN' });
  assert.equal(review.automations.onExit[1].script, 'printf "%s" "$PROMPTBOARD_TITLE"\nexit 7'); assert.equal(review.automations.onExit[1].timeoutMinutes, 12);
  assert.deepEqual(review.automations.onEnter[0], savedMessage); assert.equal(effects, 0); assert.equal((await ctx.app.board.state()).runs.length, 0);
  assert.equal(saved.tasks[0].prompt, '  Exact edited split task\r\n'); assert.equal(saved.tasks[0].column, 'todo');
  ctx.$('#columns-open').click(); [...ctx.win.document.querySelectorAll('.columns-item')].find(button => button.textContent === 'Done').click();
  assert.ok(ctx.$('[data-trigger="onExit"]')); assert.equal(ctx.$('[data-trigger="onEnter"]'), null);
  [...ctx.win.document.querySelectorAll('.columns-item')].find(button => button.textContent === 'Code Review').click();
  const copy = ctx.$(`[data-automation-id="${hookId}"] select[aria-label^="Copy automation"]`); assert.equal([...copy.options].some(option => option.value === 'done/onEnter'), false);
  copy.value = 'done/onExit'; copy.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
  assert.equal(ctx.$('#column-name').value, 'Done'); submitForm(ctx, '#columns-form'); await ctx.idle({ requireComplete: true });
  const copied = (await ctx.app.board.state()).projects[0].pipeline.columns.at(-1).automations.onExit[0];
  assert.notEqual(copied.id, hookId); assert.equal(copied.enabled, false); assert.equal(copied.url, review.automations.onExit[0].url); assert.deepEqual(copied.headers, review.automations.onExit[0].headers); assert.equal(effects, 0);
});

test('notification drafts retain literal templates, switches and independent copies without permission or dispatch', async t => {
  const ctx = await setup(t, { executor: null, hash: '#/kanban' }), pipeline = defaultPipelineConfig();
  const project = await ctx.app.board.createProject({ name: 'Notification drafts' });
  for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  await ctx.app.board.setPipeline(project.id, { pipeline, expectedRevision: 1, confirm: true });
  const task = await ctx.app.board.createTask({ projectId: project.id, title: 'Composer', prompt: '  Exact split\r\n' });
  let dispatches = 0; ctx.app.board.automations.actions.notifier = () => { dispatches++; throw new Error('Draft dispatched.'); };
  await ctx.win.__pbTest.loadBoard(); await ctx.idle({ requireComplete: true }); ctx.$('#columns-open').click();
  [...ctx.win.document.querySelectorAll('.columns-item')].find(button => button.textContent === 'Executing').click();
  ctx.$('[data-trigger="onEnter"] .automation-add').click(); let row = ctx.$('.automation-row'), id = row.dataset.automationId;
  const input = (key, value, event = 'input') => { const field = row.querySelector(`[data-field="${key}"]`); field.value = value; field.dispatchEvent(new ctx.win.Event(event, { bubbles: true })); };
  input('type', 'notify', 'change'); row = ctx.$(`[data-automation-id="${id}"]`);
  const title = '  {{title}} <img src=x> {{unknown}}', body = 'Literal 😀\n{{toColumn}} · {{projectName}}';
  input('name', 'Literal alert'); input('title', title); input('body', body);
  assert.equal(row.querySelector('[data-field="title"]').maxLength, 500); assert.equal(row.querySelector('[data-field="body"]').maxLength, 4000);
  row.querySelector('input[type="checkbox"]').click();
  const copy = row.querySelector('select[aria-label^="Copy automation"]'); copy.value = 'done/onExit'; copy.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
  submitForm(ctx, '#columns-form'); await ctx.idle({ requireComplete: true }); assert.equal(ctx.$('#columns-dialog').open, false);
  const saved = (await ctx.app.board.state()).projects[0], original = saved.pipeline.columns[2].automations.onEnter[0], duplicate = saved.pipeline.columns.at(-1).automations.onExit[0];
  assert.deepEqual(original, { id, name: 'Literal alert', type: 'notify', enabled: false, title, body });
  assert.notEqual(duplicate.id, id); assert.equal(duplicate.name, 'Literal alert (copy)'); assert.equal(duplicate.title, title); assert.equal(duplicate.body, body); assert.equal(duplicate.enabled, false);
  assert.equal(dispatches, 0); assert.equal((await ctx.app.board.automationRuns(task.id)).length, 0); assert.equal((await ctx.app.board.state()).runs.length, 0);
  assert.equal(saved.tasks[0].prompt, task.prompt); assert.equal(saved.tasks[0].column, 'todo');
  ctx.$('#app-settings-open').click(); await ctx.idle({ requireComplete: true }); assert.equal(ctx.$('#set-notifications-enable').disabled, true);
});

test('pipeline card Stop cancels owned automation work and Details shows escaped durable results without retrying', async t => {
  const ctx = await setup(t, { executor: null, hash: '#/kanban' }), pipeline = defaultPipelineConfig();
  const project = await ctx.app.board.createProject({ name: 'Scoped Stop' });
  for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  const malicious = 'Pending <img src=x onerror="window.__receiptPwned=1">';
  pipeline.columns[0].automations.onExit = [{ id: 'pending-hook', name: malicious, type: 'webhook', enabled: true, url: 'https://example.test/never-contacted', headers: { Authorization: 'PRIVATE_TOKEN' } }];
  await ctx.app.board.setPipeline(project.id, { pipeline, expectedRevision: 1, confirm: true });
  const task = await ctx.app.board.createTask({ projectId: project.id, title: 'Stop this task', prompt: 'Exact Composer body' });
  let calls = 0, cancelled = false;
  ctx.app.board.automations.actions.fetcher = (_url, { signal }) => new Promise((_resolve, reject) => {
    calls++; const abort = () => { cancelled = true; reject(new Error('Owned fixture stopped.')); };
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  });
  await ctx.win.__pbTest.loadBoard(); await ctx.idle({ requireComplete: true });
  const menu = ctx.$(`[data-id="${task.id}"] .kanban-move-to`); menu.value = 'code_review'; menu.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
  await until(() => calls === 1, 'owned webhook pending'); await ctx.win.__pbTest.loadBoard();
  const stop = ctx.$(`[data-id="${task.id}"] .kanban-stop-automations`); assert.ok(stop); stop.click();
  await until(async () => (await ctx.app.board.automationRuns(task.id))[0].status === 'cancelled', 'durable cancellation'); await ctx.idle({ requireComplete: true });
  assert.equal(cancelled, true); assert.equal(calls, 1); assert.equal((await ctx.app.board.state()).projects[0].tasks[0].column, 'todo');
  ctx.$(`[data-id="${task.id}"] .kanban-details`).click();
  await until(() => ctx.$('.automation-history').textContent.includes(malicious), 'recorded history');
  assert.match(ctx.$('.automation-history').textContent, /Session change: cancelled/); assert.match(ctx.$('.automation-history').textContent, /On exit.*cancelled/);
  assert.equal(ctx.$('.automation-history img'), null); assert.equal(ctx.win.__receiptPwned, undefined); assert.doesNotMatch(ctx.$('.automation-history').textContent, /PRIVATE_TOKEN|Exact Composer body/);
  ctx.$('.automation-history').parentElement.querySelector('button').click(); await ctx.idle({ requireComplete: true }); assert.equal(calls, 1);
});

test('UI sends selected model, effort, and language through HTTP, then restores history and copies output', async t => {
  const { $, choose, radio, quality, submit, calls, requests, copied, win } = await setup(t);
  assert.equal($('input[name="language"]:checked').value, 'en');
  assert.equal($('input[name="quality"]:checked').value, 'reviewed');
  quality('fast');
  assert.match($('#model').options[0].textContent, /codex-one/);
  choose('#model', 'codex-one'); choose('#effort', 'xhigh'); radio('pl');
  $('#prompt-input').value = 'Add a test.';
  submit();
  await until(() => !$('#generate-button').disabled && calls.length === 1, 'first result');
  assert.equal(calls[0].model, 'codex-one'); assert.equal(calls[0].effort, 'xhigh');
  assert.equal(requests[0].quality, 'fast');
  assert.match(calls[0].prompt, /prose in Polish/);
  assert.equal($('#prompt-output').textContent, 'Dodaj test.');
  assert.match($('#output-meta').textContent, /actual-model/);
  $('#copy-button').click(); await until(() => copied(), 'copy'); assert.equal(copied(), 'Dodaj test.');
  await until(() => $('#copy-label').textContent === 'Copied!', 'copy feedback');
  assert.equal($('#copy-cheer'), null);
  $('#new-prompt').click(); assert.equal($('input[name="language"]:checked').value, 'en');
  assert.equal($('input[name="quality"]:checked').value, 'reviewed');
  $('.history-restore').click();
  await until(() => !$('#generate-button').disabled, 'restore model discovery');
  assert.equal($('#model').value, 'codex-one'); assert.equal($('#effort').value, 'xhigh'); assert.equal($('input[name="language"]:checked').value, 'pl');
  assert.equal($('input[name="quality"]:checked').value, 'fast');
  const entry = JSON.parse(win.localStorage.getItem('ste-prompt-engineer.history.v1'))[0];
  assert.equal(entry.model, 'codex-one'); assert.equal(entry.language, 'pl');
  choose('#model', 'codex-two'); assert.equal($('#effort').value, '');
  assert.deepEqual(Array.from($('#effort').options, x => x.value), ['', 'low']);
  choose('#provider', 'claude'); await until(() => !$('#model').disabled, 'Claude catalog');
  choose('#model', 'opus'); choose('#effort', 'max'); radio('de'); submit();
  await until(() => calls.length === 2 && !$('#generate-button').disabled, 'German result');
  assert.equal(calls[1].provider, 'claude'); assert.equal(calls[1].effort, 'max'); assert.match(calls[1].prompt, /prose in German/);
  choose('#model', 'haiku'); assert.equal($('#effort').disabled, true); assert.equal($('#effort').value, '');
  choose('#provider', 'gemini'); await until(() => !$('#model').disabled, 'Gemini catalog');
  choose('#model', 'gemini-one'); assert.equal($('#effort').disabled, true);
  choose('#provider', 'agy'); await until(() => !$('#model').disabled, 'AGY catalog');
  choose('#model', 'gemini-agy-high');
  assert.deepEqual(Array.from($('#effort').options, x => x.value), ['', 'high']);
  choose('#effort', 'high'); submit();
  await until(() => calls.length === 3 && !$('#generate-button').disabled, 'AGY result');
  assert.equal(calls[2].provider, 'agy'); assert.equal(calls[2].effort, 'high');
  choose('#model', 'gemini-agy-low');
  assert.deepEqual(Array.from($('#effort').options, x => x.value), ['', 'low']);
  assert.equal($('#effort').value, '');
  assert.equal($('#generate-button').disabled, false);
});

test('UI ignores stale model responses when the provider changes quickly', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { $, choose } = await setup(t, { catalogReader: async provider => {
    if (provider === 'claude') await gate;
    return { provider, ...catalogs[provider] };
  } });
  choose('#provider', 'claude');
  choose('#provider', 'agy');
  await until(() => !$('#model').disabled, 'newest provider catalog');
  assert.ok(Array.from($('#model').options, x => x.value).includes('gemini-agy-high'));
  release(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal($('#provider').value, 'agy');
  assert.ok(!Array.from($('#model').options, x => x.value).includes('opus'));
});

test('unavailable catalogs keep explicit custom IDs usable; old history defaults to English', async t => {
  const storage = [{ id: 'old', input: 'Add a test.', prompt: 'Add a test.', provider: 'codex', model: 'old-model' }];
  const { $, choose, quality, submit, calls } = await setup(t, { storage, catalogReader: async provider => ({ provider, models: [], source: 'unavailable', note: 'Update your CLI.' }) });
  assert.match($('#model-note').textContent, /Update/);
  $('.history-restore').click(); await until(() => !$('#model').disabled, 'old history');
  assert.equal($('input[name="language"]:checked').value, 'en');
  assert.equal($('input[name="quality"]:checked').value, 'reviewed');
  assert.match($('#verification-status').textContent, /no verification report/);
  assert.equal($('#verification-report').hidden, true);
  assert.equal($('#report-button').disabled, true);
  assert.equal($('#model').value, '__custom__'); assert.equal($('#custom-model').value, 'old-model');
  quality('fast');
  choose('#effort', 'high'); submit();
  await until(() => calls.length === 1 && !$('#generate-button').disabled, 'custom ID result');
  assert.equal(calls[0].model, 'old-model'); assert.equal(calls[0].effort, 'high');
});

test('reviewed mode shows bounded usage, report evidence, JSON export, and restored verification', async t => {
  const verification = report();
  const { $, submit, requests, downloads, blobs, win, copied } = await setup(t, { generationResponse: { prompt: 'Add a test.', provider: 'codex', verification } });
  assert.match($('#quality-note').textContent, /2 CLI calls; up to 4/);
  assert.ok($('.sidebar-footer').textContent.endsWith(`v${VERSION}`), 'The footer shows the package version.');
  $('#prompt-input').value = 'Add a test.';
  submit();
  await until(() => !$('#generate-button').disabled && requests.length === 1, 'reviewed result');
  assert.equal(requests[0].quality, 'reviewed');
  assert.equal($('#verification-status').textContent, 'Checks complete—review before use');
  assert.equal($('#verification-report').hidden, false);
  assert.equal($('#verification-report').open, false);
  assert.match($('#verification-limits').textContent, /Model review can miss errors/);
  assert.match($('#automatic-checks').textContent, /protected literals: pass \(1\)/);
  assert.equal($('#requirement-ledger').children.length, 1);
  assert.match($('#requirement-ledger').textContent, /Covered/);
  assert.equal($('#review-criteria').children.length, 7);
  assert.match($('#review-criteria').textContent, /no invention: pass/);
  assert.match($('#verification-stages').textContent, /models reported: model-one/);
  assert.match($('#verification-stages').textContent, /review: complete · 0\.3s · in 2\.0 KB, out 0\.2 KB/);
  assert.match($('#verification-overview').textContent, /1 of 1 detected protected items matched/);
  $('#copy-button').click(); await until(() => copied(), 'copy without report');
  assert.equal(copied(), 'Add a test.');
  $('#report-button').click();
  assert.match(downloads[0], /^ste-check-report-.*\.json$/);
  const exported = JSON.parse(await blobs[0].text());
  assert.equal(exported.request.input, 'Add a test.');
  assert.equal(exported.prompt, 'Add a test.');
  assert.deepEqual(exported.verification, verification);
  const stored = JSON.parse(win.localStorage.getItem('ste-prompt-engineer.history.v1'));
  assert.deepEqual(stored[0].verification, verification);
  const restored = await setup(t, { storage: stored });
  restored.$('.history-restore').click();
  await until(() => !restored.$('#model').disabled, 'saved report restore');
  assert.equal(restored.$('#verification-status').textContent, 'Checks complete—review before use');
  assert.equal(restored.$('#requirement-ledger').children.length, 1);
  assert.equal(restored.$('#report-button').disabled, false);
});

test('issues and unavailable reviews keep the draft visible, flag it, and render evidence as plain text', async t => {
  let result = {
    prompt: 'Add a test.', verification: report({ status: 'needs-review', repaired: true, calls: 4,
      automatic: { status: 'issues', checks: [{ id: 'protected-literals', status: 'issues' }], issues: [{ rule: 'missing-literal', message: 'A literal is absent.', excerpt: '<img src=x onerror=alert(1)>' }], protectedCount: 1, matchedCount: 0 },
      review: { status: 'issues', requirements: [{ sourceQuote: 'Keep <script> unchanged.', promptQuote: '', status: 'missing', note: 'The text is missing.' }], issues: [{ category: 'requirements', message: 'A requirement is missing.', sourceQuote: 'Keep <script> unchanged.' }] },
    }),
  };
  const { $, submit, requests } = await setup(t, { generationResponse: () => result });
  $('#prompt-input').value = 'Add a test.'; submit();
  await until(() => !$('#generate-button').disabled && requests.length === 1, 'flagged draft');
  assert.equal($('#prompt-output').hidden, false);
  assert.equal($('#copy-button').disabled, false);
  assert.equal($('#verification-status').textContent, 'Draft—review needed');
  assert.equal($('#verification-report').open, true);
  assert.match($('#verification-summary').textContent, /4 CLI calls · one repair/);
  assert.equal($('#verification-issues').children.length, 2);
  assert.match($('#verification-issues').textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal($('#verification-issues img'), null);
  assert.equal($('#requirement-ledger script'), null);
  assert.match($('#requirement-ledger').textContent, /Missing/);
  result = { prompt: 'Add a test.', verification: report({ status: 'needs-review', review: { status: 'unavailable', requirements: [], issues: [] } }) };
  submit(); await until(() => !$('#generate-button').disabled && requests.length === 2, 'unavailable review');
  assert.equal($('#verification-status').textContent, 'Draft—review needed');
  assert.match($('#requirement-note').textContent, /unavailable/);
  assert.equal($('#requirement-ledger').hidden, true);
  assert.equal($('#prompt-output').textContent, 'Add a test.');
});

test('fast mode clearly distinguishes automatic checks from skipped model review', async t => {
  const { $, quality, submit, requests } = await setup(t, { generationResponse: { prompt: 'Add a test.', verification: report({ mode: 'fast', calls: 1, review: { status: 'skipped', requirements: [], issues: [] } }) } });
  quality('fast');
  assert.match($('#quality-note').textContent, /1 CLI call/);
  assert.match($('#quality-note').textContent, /No model review or repair/);
  $('#prompt-input').value = 'Add a test.'; submit();
  await until(() => !$('#generate-button').disabled && requests.length === 1, 'fast result');
  assert.equal(requests[0].quality, 'fast');
  assert.match($('#verification-status').textContent, /model review skipped/);
  assert.match($('#requirement-note').textContent, /No requirement coverage claim/);
  assert.equal($('#requirement-ledger').hidden, true);
});

test('a failed repair, uncertain criterion, and language issue are visible with the retained draft', async t => {
  const verification = report({ status: 'needs-review', repairFailed: true, calls: 3,
    review: { ...report().review, status: 'issues', criteria: [{ criterion: 'meaning', status: 'uncertain', note: 'The constraint is ambiguous.' }] },
  });
  const { $, submit, requests, downloads, blobs } = await setup(t, { generationResponse: {
    prompt: 'Add a test.', verification, lint: { warnings: [{ rule: 'sentence-length', line: 1, message: 'Shorten this instruction.' }] },
  } });
  $('#prompt-input').value = 'Add a test.'; submit();
  await until(() => !$('#generate-button').disabled && requests.length === 1, 'failed repair report');
  assert.equal($('#verification-status').textContent, 'Draft—review needed');
  assert.equal($('#prompt-output').textContent, 'Add a test.');
  assert.match($('#verification-issues').textContent, /repair call failed/);
  assert.match($('#verification-issues').textContent, /Line 1: Shorten this instruction/);
  assert.match($('#review-criteria').textContent, /meaning: uncertain — The constraint is ambiguous/);
  $('#report-button').click();
  assert.equal(downloads.length, 1);
  const exported = JSON.parse(await blobs[0].text());
  assert.equal(exported.verification.repairFailed, true);
  assert.equal(exported.lint.warnings[0].rule, 'sentence-length');
});

test('full browser storage keeps the result usable and shows a persistent unsaved-history warning', async t => {
  const { $, win, submit, requests, copied, downloads } = await setup(t, { generationResponse: { prompt: 'Add a test.', verification: report() } });
  win.Storage.prototype.setItem = () => { throw new win.DOMException('Storage is full.', 'QuotaExceededError'); };
  $('#prompt-input').value = 'Add a test.'; submit();
  await until(() => !$('#generate-button').disabled && requests.length === 1, 'result despite full storage');
  assert.equal($('#prompt-output').textContent, 'Add a test.');
  assert.equal($('#prompt-output').hidden, false);
  assert.equal($('#storage-warning').hidden, false);
  assert.match($('#storage-warning').textContent, /History changes were not saved/);
  assert.match($('#announcement').textContent, /Browser history was not saved/);
  assert.equal(win.localStorage.getItem('ste-prompt-engineer.history.v1'), null);
  assert.equal($('#copy-button').disabled, false);
  $('#copy-button').click(); await until(() => copied(), 'copy unsaved prompt');
  assert.equal(copied(), 'Add a test.');
  $('#report-button').click(); assert.equal(downloads.length, 1);
  assert.equal($('#storage-warning').hidden, false);
  $('#new-prompt').click();
  assert.equal($('#storage-warning').hidden, false);
  assert.equal($('#history-list').children.length, 1);
});

test('progress shows the stage and elapsed time; cancel restores the form and keeps the input', async t => {
  let release;
  const { $, submit, calls } = await setup(t, { runner: ({ signal }) => new Promise((resolve, reject) => {
    release = () => resolve({ text: 'Add a test.' });
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }) });
  $('#prompt-input').value = 'Keep this request.';
  submit();
  await until(() => calls.length === 1, 'generation started');
  assert.equal($('#generate-button').disabled, true);
  assert.equal($('#cancel-button').hidden, false);
  await until(() => $('#progress-stage').textContent === 'Drafting prompt', 'stage label');
  assert.match($('#progress-elapsed').textContent, /^\d+:\d\d$/);
  submit(); // A duplicate submit while running is ignored.
  $('#cancel-button').click();
  await until(() => !$('#generate-button').disabled, 'form restored after cancel');
  assert.equal($('#cancel-button').hidden, true);
  assert.equal($('#prompt-input').value, 'Keep this request.');
  assert.match($('#announcement').textContent, /canceled/i);
  assert.equal(calls.length, 1);
});

test('provider failures show a stable message with a supplied reset time, keep input, and allow a retry', async t => {
  const { ProviderError } = await import('../src/providers.mjs');
  let fail = true;
  const { $, submit, calls, quality } = await setup(t, { runner: async () => {
    if (fail) throw Object.assign(new ProviderError('raw SECRET', 'RATE_LIMITED'), { resetsAt: '2026-10-01T12:00:00.000Z' });
    return { text: 'Add a test.' };
  } });
  quality('fast');
  $('#prompt-input').value = 'Keep this request.';
  submit();
  await until(() => !$('#generation-error').hidden && !$('#generate-button').disabled, 'error shown');
  assert.match($('#generation-error').textContent, /temporarily limiting/);
  assert.match($('#generation-error').textContent, /reset at/);
  assert.doesNotMatch($('#generation-error').textContent, /SECRET|exhausted/i);
  assert.doesNotMatch($('#generation-error').textContent, /nerd|glasses|tidy|goooo/i);
  assert.equal($('#prompt-input').value, 'Keep this request.');
  fail = false;
  submit();
  await until(() => calls.length === 2 && !$('#generate-button').disabled, 'retry result');
  assert.equal($('#prompt-output').textContent, 'Add a test.');
  assert.equal($('#generation-error').hidden, true);
});

test('top-bar CLI dialog owns connection controls without changing Compose selections or losing sign-in details', async t => {
  const { $, choose, win, calls, authAdapter, idle } = await setup(t);
  $('#prompt-input').value = 'Keep this exact Compose task.';
  choose('#model', 'codex-two'); await idle();
  assert.equal($('#prompt-form').contains($('#auth-login')), false);
  assert.equal($('#advanced-options').querySelector('#connection-heading'), null);
  assert.equal($('#help-dialog').contains($('#auth-login')), true);
  assert.equal($('#compose-general').contains($('#model-note')), true);
  $('#setup-help').click(); assert.equal($('#help-dialog').open, true);
  assert.equal($('#setup-help').getAttribute('aria-controls'), 'help-dialog');
  choose('#connection-provider', 'claude'); await until(() => $('#connection-auth').textContent === 'Signed in (fixture)', 'Claude connection state'); await idle();
  assert.equal($('#provider').value, 'codex'); assert.equal($('#model').value, 'codex-two'); assert.equal($('#prompt-input').value, 'Keep this exact Compose task.');
  assert.equal(calls.length, 0); assert.equal(authAdapter.log.some(row => row[0] === 'login' || row[0] === 'logout'), false);
  $('#auth-login').click(); assert.equal($('#auth-detail code').textContent, 'claude auth login');
  $('#close-dialog').click(); $('#privacy-help').click(); assert.equal($('#cli-connection').hidden, true);
  $('#close-dialog').click(); $('#setup-help').click(); assert.equal($('#cli-connection').hidden, false); assert.equal($('#auth-detail code').textContent, 'claude auth login');
  $('#close-dialog').click(); win.location.hash = '#/kanban'; await idle(); $('#setup-help').click();
  assert.equal($('#help-dialog').open, true); assert.equal($('#connection-provider').value, 'claude');
  assert.equal($('#provider').value, 'codex');
  $('#auth-logout').click(); [...win.document.querySelectorAll('#auth-detail button')].find(button => button.textContent === 'Sign out').click();
  await until(() => authAdapter.log.some(row => row[0] === 'logout'), 'selected account sign-out');
  assert.deepEqual(authAdapter.log.filter(row => row[0] === 'logout'), [['logout', 'claude']]); assert.equal($('#provider').value, 'codex');
});

test('closing the CLI dialog preserves a pending device sign-in and locks its account identity', async t => {
  let finish; const gate = new Promise(resolve => { finish = resolve; }); t.after(() => finish());
  const authAdapter = fakeAuth({ login: async (provider, options) => { authAdapter.log.push(['login', provider, options.method]); options.onUpdate({ userCode: 'FIXTURE-CODE', verificationUrl: 'https://auth.example/device' }); await gate; return { state: 'signed-in' }; } });
  const { $, choose } = await setup(t, { authAdapter });
  $('#setup-help').click(); $('#auth-device').click();
  await until(() => $('#auth-detail .auth-code')?.textContent === 'FIXTURE-CODE', 'device flow shown');
  assert.equal($('#connection-provider').disabled, true);
  $('#close-dialog').click(); choose('#provider', 'gemini'); $('#setup-help').click();
  assert.equal($('#connection-provider').value, 'codex'); assert.equal($('#auth-detail .auth-code').textContent, 'FIXTURE-CODE');
  assert.deepEqual(authAdapter.log.filter(row => row[0] === 'login'), [['login', 'codex', 'device']]);
  finish(); await until(() => /confirmed the sign-in/.test($('#auth-detail').textContent), 'device flow completes', 6000);
  assert.equal($('#provider').value, 'gemini'); assert.equal($('#connection-provider').value, 'codex');
});

test('connection panel separates install and sign-in, hands off terminal sign-in, and confirms sign-out', async t => {
  const authAdapter = fakeAuth({ status: async provider => (provider === 'codex' ? { state: 'signed-in', method: 'chatgpt' } : provider === 'claude' ? { state: 'signed-out' } : { state: 'unknown' }) });
  let lookups = 0;
  const { $, choose, win } = await setup(t, { authAdapter, catalogReader: async id => { lookups++; return { provider: id, ...catalogs[id] }; } });
  await until(() => /Signed in/.test($('#connection-auth').textContent), 'codex status');
  assert.match($('#connection-install').textContent, /CLI installed/);
  assert.equal($('#connection-auth').textContent, 'Signed in (chatgpt)');
  assert.equal($('#auth-login').textContent, 'Reauthenticate');
  assert.equal($('#auth-device').hidden, false);
  // Native sign-in: a link to the CLI's https page, then a refresh of state and models.
  const before = lookups;
  $('#auth-login').click();
  await until(() => authAdapter.log.some(entry => entry[0] === 'login'), 'login started');
  await until(() => /confirmed the sign-in/.test($('#auth-detail').textContent), 'login completion', 6000);
  await until(() => lookups > before, 'model refresh after sign-in');
  assert.ok(!authAdapter.log.some(entry => entry[0] === 'logout'), 'Reauthentication never signs out first.');
  // Terminal handoff for Claude, with the verified command.
  choose('#provider', 'claude');
  await until(() => $('#connection-auth').textContent === 'Signed out', 'claude status');
  assert.equal($('#auth-login').textContent, 'Connect / Sign in');
  assert.equal($('#auth-device').hidden, true);
  $('#auth-login').click();
  assert.equal($('#auth-detail code').textContent, 'claude auth login');
  assert.match($('#auth-detail').textContent, /Check again/);
  // Sign-out requires an explicit confirmation that explains shared sessions.
  $('#auth-logout').click();
  assert.match($('#auth-detail').textContent, /Other terminals, editors, and apps/);
  assert.ok(!authAdapter.log.some(entry => entry[0] === 'logout'));
  Array.from(win.document.querySelectorAll('#auth-detail button')).find(b => b.textContent === 'Keep me signed in').click();
  assert.equal($('#auth-detail').hidden, true);
  assert.ok(!authAdapter.log.some(entry => entry[0] === 'logout'));
  $('#auth-logout').click();
  Array.from(win.document.querySelectorAll('#auth-detail button')).find(b => b.textContent === 'Sign out').click();
  await until(() => authAdapter.log.some(entry => entry[0] === 'logout'), 'logout after confirmation');
  assert.deepEqual(authAdapter.log.filter(entry => entry[0] === 'logout'), [['logout', 'claude']]);
  // Gemini: status and sign-out are labelled as unsupported, not simulated.
  choose('#provider', 'gemini');
  await until(() => /not reported by this CLI/.test($('#connection-auth').textContent), 'gemini status');
  $('#auth-logout').click();
  assert.match($('#auth-detail').textContent, /not available here/);
  assert.equal(authAdapter.log.filter(entry => entry[0] === 'logout').length, 1);
});

test('saved theme and sidebar state apply before app code runs, persist, and survive storage failures', async t => {
  const { $, win } = await setup(t, { prefs: { 'ste-prompt-engineer.theme': 'dark', 'ste-prompt-engineer.sidebar': 'collapsed' } });
  const root = win.document.documentElement;
  assert.equal(root.dataset.theme, 'dark');
  assert.equal($('meta[name="color-scheme"]').content, 'dark');
  assert.equal($('#theme-toggle').getAttribute('aria-pressed'), 'true');
  assert.equal(root.dataset.sidebar, 'collapsed');
  assert.equal($('#menu-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal($('#menu-toggle').getAttribute('aria-label'), 'Show prompt history');
  $('#theme-toggle').click();
  assert.equal(root.dataset.theme, 'light');
  assert.equal($('#theme-toggle').getAttribute('aria-pressed'), 'false');
  assert.equal(win.localStorage.getItem('ste-prompt-engineer.theme'), 'light');
  $('#menu-toggle').click();
  assert.equal(root.dataset.sidebar, 'expanded');
  assert.equal($('#menu-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(win.localStorage.getItem('ste-prompt-engineer.sidebar'), 'expanded');
  win.Storage.prototype.setItem = () => { throw new win.DOMException('Storage is full.', 'QuotaExceededError'); };
  $('#theme-toggle').click();
  assert.equal(root.dataset.theme, 'dark');
  // Narrow screens: the same toggle opens a drawer; Escape closes it and returns focus to the toggle.
  Object.defineProperty(win, 'innerWidth', { value: 375, configurable: true });
  $('#menu-toggle').click();
  assert.ok($('#sidebar').classList.contains('open'));
  assert.equal($('#sidebar-scrim').hidden, false);
  assert.equal($('#menu-toggle').getAttribute('aria-expanded'), 'true');
  win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.ok(!$('#sidebar').classList.contains('open'));
  assert.equal($('#sidebar-scrim').hidden, true);
  assert.equal(win.document.activeElement, $('#menu-toggle'));
});

test('long history lists every entry, restores a selection, deletes one, and filters by search', async t => {
  const storage = Array.from({ length: 501 }, (_, index) => ({ id: `entry-${index}`, input: `Request number ${index}`, prompt: `Prompt ${index}`, createdAt: 1790000000000 - index, provider: 'codex' }));
  const { $, win } = await setup(t, { storage });
  assert.equal($('#history-list').children.length, 500, 'History keeps the newest 500 prompts.');
  assert.equal($('#history-count').textContent, '500');
  assert.equal($('#history-empty').hidden, true);
  win.document.querySelectorAll('.history-restore')[5].click();
  await until(() => !$('#model').disabled, 'restored entry');
  assert.equal($('#prompt-input').value, 'Request number 5');
  assert.equal($('.history-item.active .history-restore').getAttribute('aria-current'), 'true');
  $('.history-item.active .history-delete').click();
  assert.equal($('#history-list').children.length, 499);
  assert.equal($('.history-item.active'), null);
  const stored = JSON.parse(win.localStorage.getItem('ste-prompt-engineer.history.v1'));
  assert.equal(stored.length, 499);
  assert.ok(!stored.some(entry => entry.id === 'entry-5'));
  $('#history-search').value = 'no such request';
  $('#history-search').dispatchEvent(new win.Event('input'));
  assert.equal($('#history-list').children.length, 0);
  assert.equal($('#history-empty').hidden, false);
  assert.match($('#history-empty small').textContent, /Try another word/);
});

test('the skip link focuses the visible page and never changes the page', async t => {
  const { $, win } = await setup(t, { hash: '#/kanban' });
  await until(() => !$('#kanban-view').hidden, 'Kanban page');
  const skip = () => $('#skip-link').dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  skip();
  assert.equal(win.document.activeElement, $('#kanban-view'));
  assert.equal(win.location.hash, '#/kanban');
  win.location.hash = '#/';
  await until(() => $('#kanban-view').hidden, 'prompt page');
  skip();
  assert.equal(win.document.activeElement, $('#prompt-input'));
  assert.equal(win.location.hash, '#/');
});
