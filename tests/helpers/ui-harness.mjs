/** Shared jsdom page harness for the ui*.test.mjs files. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { startServer } from '../../src/server.mjs';
import { fakeGh } from '../fixtures/fake-gh.mjs';
import { VERSION } from '../../src/version.mjs';
import { defaultPipelineConfig } from '../../src/pipeline-config.mjs';
import { repositoryPipelineDefinition } from '../../src/pipeline-repository.mjs';
import { Board } from '../../src/board.mjs';
import { parseAgyModels } from '../../src/models.mjs';
import { pickProject, shownProject } from './projects.mjs';

// Git output for assertions (the file's local helpers take other argument shapes).
export const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
export const catalogs = {
  codex: { source: 'cli', defaultModel: 'codex-one', defaultEffort: 'medium', models: [{ id: 'codex-one', name: 'Codex One', efforts: ['low', 'medium', 'high', 'xhigh'] }, { id: 'codex-two', name: 'Codex Two', efforts: ['low'] }] },
  claude: { source: 'cli', models: [{ id: 'opus', name: 'Opus', efforts: ['low', 'medium', 'high', 'max'] }, { id: 'haiku', name: 'Haiku', efforts: [] }] },
  gemini: { source: 'cli', models: [{ id: 'gemini-one', name: 'Gemini One', efforts: [] }] },
  agy: { source: 'cli', models: parseAgyModels('gemini-agy-high\tGemini AGY (High)\ngemini-agy-low\tGemini AGY (Low)\n') },
};
export async function until(fn, label, ms = 10000) {
  const deadline = Date.now() + ms;
  while (!await fn()) { if (Date.now() > deadline) assert.fail(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 10)); }
}
// Fixture auth adapter: never runs a real CLI, and records every mutation.
export function fakeAuth(overrides = {}) {
  const log = [];
  return { log, installed: async () => true, status: async provider => { log.push(['status', provider]); return { state: 'signed-in', method: 'fixture' }; },
    login: async (provider, options) => { log.push(['login', provider, options.method]); options.onUpdate({ authUrl: 'https://auth.example/start' }); return { state: 'signed-in' }; },
    logout: async provider => { log.push(['logout', provider]); return { state: 'signed-out' }; }, ...overrides };
}
export async function setup(t, { catalogReader = async id => ({ provider: id, ...catalogs[id], note: 'Native model options.' }), storage, prefs = {}, kanban, hash = '', generationResponse, authAdapter = fakeAuth(), runner, dataDir, executor = 'auto', folderPicker, usageReader } = {}) {
  // Every page gets a private board folder unless a test shares one to simulate a reload.
  const ownsDataDir = !dataDir;
  if (!dataDir) dataDir = await mkdtemp(join(tmpdir(), 'pb-ui-'));
  let app, win, pending = 0;
  const intervals = [];
  // One ordered teardown owns the page, server and folder, including setup failures.
  // Windows cannot delete a checkout while an in-flight Git process holds its cwd.
  t.after(async () => {
    try {
      if (win) {
        for (const { id } of intervals) win.clearInterval(id);
        // Some scenarios intentionally hold a model lookup; keep teardown bounded.
        for (let idle = 0, end = Date.now() + 3000; idle < 3 && Date.now() < end;) { await new Promise(resolve => setTimeout(resolve, 10)); idle = pending ? 0 : idle + 1; }
        for (const session of win.promptboardDock?.sessions.values() || []) { session.closed = true; session.abort?.abort(); }
        win.close();
      }
    } finally {
      try { await app?.close(); }
      finally { if (ownsDataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    }
  });
  const calls = [];
  const requests = [];
  app = await startServer({ port: 0, dataDir, executor, authAdapter, usageReader, ...(folderPicker ? { folderPicker } : {}), detector: async () => Object.keys(catalogs).map(id => ({ id, available: true })), catalogReader,
    runner: runner ? async request => { calls.push(request); return runner(request); } : async request => { calls.push(request); return { text: request.prompt.includes('prose in Polish') ? 'Dodaj test.' : request.prompt.includes('prose in German') ? 'Füge einen Test hinzu.' : 'Add a test.', reportedModels: ['actual-model'], durationMs: 3 }; } });
  const dom = new JSDOM(await readFile(new URL('../../public/index.html', import.meta.url), 'utf8'), { url: app.url + hash, runScripts: 'outside-only' });
  win = dom.window;
  const nativeInterval = win.setInterval.bind(win);
  win.setInterval = (fn, ms, ...args) => { const id = nativeInterval(fn, ms, ...args); intervals.push({ fn, ms, id }); return id; };
  win.fetch = (url, options) => {
    pending++;
    const done = response => { pending--; return response; };
    const fail = error => { pending--; throw error; };
    if (url === '/api/generate') {
      const request = JSON.parse(options.body);
      requests.push(request);
      if (generationResponse) return Promise.resolve(Response.json(typeof generationResponse === 'function' ? generationResponse(request) : generationResponse)).then(done, fail);
    }
    return fetch(new URL(url, app.url), options).then(done, fail);
  };
  win.TextEncoder = TextEncoder;
  win.TextDecoder = TextDecoder;
  win.AbortController = AbortController;
  win.scrollTo = () => {};
  win.HTMLElement.prototype.scrollIntoView = () => {};
  const downloads = [], blobs = [];
  win.Blob = Blob;
  win.URL.createObjectURL = blob => { blobs.push(blob); return `blob:test-${blobs.length}`; };
  win.URL.revokeObjectURL = () => {};
  win.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
  if (storage) win.localStorage.setItem('ste-prompt-engineer.history.v1', JSON.stringify(storage));
  for (const [key, value] of Object.entries(prefs)) win.localStorage.setItem(key, value);
  if (kanban !== undefined) win.localStorage.setItem('ste-prompt-engineer.kanban.v1', typeof kanban === 'string' ? kanban : JSON.stringify(kanban));
  // jsdom has <dialog> without showModal/close.
  win.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  win.HTMLDialogElement.prototype.close = function () { this.open = false; };
  let copied;
  Object.defineProperty(win.navigator, 'clipboard', { value: { writeText: async text => { copied = text; } } });
  // Same order as the page: prefs.js runs in <head>, app.js is deferred.
  win.eval(await readFile(new URL('../../public/prefs.js', import.meta.url), 'utf8'));
  win.eval(await readFile(new URL('../../public/dom.js', import.meta.url), 'utf8'));
  win.eval(await readFile(new URL('../../public/base.js', import.meta.url), 'utf8'));
  // Browsers share one global scope across classic scripts; jsdom's eval does not, so evaluate them together.
  // Test-only export appended by the harness (not part of the app): reload the board and read the token.
  win.eval(`${await readFile(new URL('../../public/app.js', import.meta.url), 'utf8')}\n${await readFile(new URL('../../public/dock.js', import.meta.url), 'utf8')}\nwindow.__pbTest = { loadBoard, refreshRepositoryPipelineStatus, get token() { return token; } };`);
  const $ = selector => win.document.querySelector(selector);
  const choose = (id, value) => { $(id).value = value; $(id).dispatchEvent(new win.Event('change', { bubbles: true })); };
  const radio = language => { $(`input[name="language"][value="${language}"]`).checked = true; $(`input[name="language"][value="${language}"]`).dispatchEvent(new win.Event('change')); };
  const submit = () => $('#prompt-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => !$('#generate-button').disabled, 'initial model discovery');
  const quality = value => { $(`input[name="quality"][value="${value}"]`).checked = true; $(`input[name="quality"][value="${value}"]`).dispatchEvent(new win.Event('change')); };
  // Some scenarios intentionally hold model requests. Saves/moves can instead
  // require completion so a bounded settle never masquerades as an idle page.
  const idle = async ({ requireComplete = false } = {}) => {
    const end = Date.now() + (requireComplete ? 15000 : 5000);
    for (let quiet = 0; quiet < 3;) {
      if (Date.now() > end) {
        if (requireComplete) assert.fail(`The page still has ${pending} pending request(s); it is not idle.`);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 10)); quiet = pending ? 0 : quiet + 1;
    }
  };
  // Projects are switched through the sidebar project list, as a person does.
  const pick = id => win.eval(pickProject(id)), shown = () => win.eval(shownProject), shownName = () => $('#workspace-list .current .workspace-name')?.textContent;
  return { win, intervals, $, choose, radio, quality, submit, calls, requests, downloads, blobs, copied: () => copied, authAdapter, app, dataDir, idle, pick, shown, shownName };
}
export function report(overrides = {}) {
  return {
    status: 'checks-passed', mode: 'reviewed',
    automatic: { status: 'pass', checks: [{ id: 'protected-literals', status: 'pass', count: 1 }], issues: [], protectedCount: 1, matchedCount: 1, reviewRequired: true },
    review: { status: 'pass', requirements: [{ id: 'S1', sourceQuote: 'Add a test.', promptQuote: 'Add a test.', status: 'covered', note: 'The requirement is preserved.' }], criteria: ['meaning', 'constraints', 'no-invention', 'conflicts', 'language', 'scope', 'clarity'].map(criterion => ({ criterion, status: 'pass', note: 'No issue found.' })), issues: [] },
    repaired: false, repairFailed: false, calls: 2, engineVersion: '0.3.0', promptHash: 'prompt-hash', inputHash: 'input-hash', instructionsHash: 'instructions-hash',
    repairReasons: [], stages: [{ stage: 'draft', reportedModels: ['model-one'], durationMs: 250, status: 'complete', inputBytes: 5000, outputBytes: 300 }, { stage: 'review', reportedModels: ['model-one'], durationMs: 250, status: 'complete', inputBytes: 2048, outputBytes: 200 }],
    timings: { totalMs: 530, modelMs: 500, checksMs: 30 }, reviewRequired: true, ...overrides,
  };
}
// Kanban page. The board lives on the server; the browser only shows it.
export const HISTORY_KEY = 'ste-prompt-engineer.history.v1';
export const KANBAN_KEY = 'ste-prompt-engineer.kanban.v1';
export const serverBoard = ctx => ctx.app.board.view();
export const serverTasks = async (ctx, name) => (await serverBoard(ctx)).projects.find(project => !name || project.name === name).tasks;
export const column = ($, id) => $(`#kanban-columns .kanban-cards[data-column="${id}"]`);
export const titles = ($, id = 'todo') => Array.from(column($, id)?.querySelectorAll('.kanban-open') || [], button => button.textContent);
export const byText = (root, text) => Array.from(root.querySelectorAll('button')).find(button => button.textContent === text);
export const submitForm = ({ $, win }, selector) => $(selector).dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
export const cardItem = ({ $ }, title) => Array.from($('#kanban-columns').querySelectorAll('.kanban-card')).find(item => item.querySelector('.kanban-open').textContent === title);
export async function goTo({ $, win, idle }, hash) {
  win.location.hash = hash;
  await until(() => $('#kanban-view').hidden === (hash !== '#/kanban'), `page ${hash}`);
  await idle();
}
// Stage-specific scenarios begin with a saved legacy board. New-default creation
// is covered separately through authenticated HTTP and the actual browser form.
export async function savedStageProject(ctx, name) {
  const { project } = await ctx.app.board.createProjectWithRepository({ name, folder: 'new', workflowMode: 'legacy' });
  await ctx.win.__pbTest.loadBoard();
  ctx.pick(project.id);
  if (ctx.$('#project-body').hidden) ctx.$('#project-toggle').click();
  await ctx.idle();
}
export async function newCard(ctx, title, prompt) { ctx.$('#card-new').click(); ctx.$('#card-title').value = title; ctx.$('#card-prompt').value = prompt; submitForm(ctx, '#card-form'); await ctx.idle(); }
export async function click(ctx, element) { element.click(); await ctx.idle(); }
export async function importFile(ctx, text) {
  const { $, win } = ctx;
  $('#project-detail').replaceChildren(); $('#project-detail').hidden = true;
  Object.defineProperty($('#import-file'), 'files', { value: [new File([text], 'backup.json', { type: 'application/json' })], configurable: true });
  $('#import-file').dispatchEvent(new win.Event('change'));
  await until(() => !$('#project-detail').hidden, 'import result');
  await ctx.idle();
}
export async function gitRepo(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pb-ui-repo-')));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-q', '-b', 'trunk'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  await writeFile(join(dir, 'a.txt'), 'a\n'); git('add', '.'); git('commit', '-q', '-m', 'init');
  return dir;
}
export function fakeExecutor() {
  const providers = {
    claude: { name: 'Claude Code', planning: { supported: true, how: 'Plan mode, read-only tools.' }, execution: { supported: true, how: 'Edits in the task worktree.' }, permissionModes: ['acceptEdits', 'default'] },
    codex: { name: 'Codex CLI', planning: { supported: true, how: 'Read-only sandbox.' }, execution: { supported: true, how: 'Workspace-write sandbox.' }, permissionModes: ['workspace-write'] },
  };
  const executor = {
    started: [],
    describe: async () => ({ available: true, setupMessage: '', providers }),
    validate: async ({ stage, config }) => ({ provider: config.provider || 'claude', model: config.model || '', effort: config.effort || '', permissionMode: stage === 'planning' ? 'plan' : config.permissionMode || providers[config.provider || 'claude'].permissionModes[0] }),
    start: async ({ run }) => { executor.started.push(run); },
    activeCount: () => 0,
    subscribe: () => null,
    async confirm(runId) { const run = await executor.board.run(runId); if (run.stage === 'planning') await executor.board.approvePlan(run.taskId, { runId }); if (run.status === 'queued') await executor.board.updateRun(runId, { status: 'running' }); await executor.board.updateRun(runId, { status: 'succeeded' }); if (['executing', 'testing'].includes(run.stage)) await executor.board.recordStageResult(run, 'Verified the task results.'); },
    async cancel(runId) { await executor.board.updateRun(runId, { status: 'cancelled' }); },
    async suspend(runId) { await executor.board.beginSuspension(runId); await executor.board.updateRun(runId, { status: 'suspended' }); },
    artifact: async () => 'PLAN\n1. Change the parser.',
  };
  return executor;
}
export async function linkedKanban(t, options = {}) {
  const executor = fakeExecutor();
  const ctx = await setup(t, { executor, hash: '#/kanban', ...options });
  executor.board = ctx.app.board;
  const repo = await gitRepo(t);
  await ctx.idle();
  await savedStageProject(ctx, 'Flow');
  const project = (await serverBoard(ctx)).projects[0];
  return { ...ctx, executor, repo, project };
}
/** Remove the repository link of the selected project, to test what an unlinked project does. */
export async function unlink(ctx) {
  const id = ctx.shown();
  await ctx.app.board.linkRepository(id, { path: null, expectedRevision: (await ctx.app.board.state()).projects.find(project => project.id === id).revision });
  await ctx.win.__pbTest.loadBoard(); await ctx.idle();
}
export async function link(ctx) {
  // New projects already have their own repository; these tests link a prepared one with a "trunk" branch.
  const revision = async () => (await ctx.app.board.state()).projects.find(project => project.id === ctx.project.id).revision;
  await ctx.app.board.linkRepository(ctx.project.id, { path: ctx.repo, expectedRevision: await revision() });
  await ctx.app.board.setTargetBranch(ctx.project.id, { branch: 'trunk', expectedRevision: await revision() });
  await ctx.win.__pbTest.loadBoard(); await ctx.idle();
}
export const moveBy = async (ctx, title, column) => { const menu = cardItem(ctx, title).querySelector('.kanban-move-to'); menu.value = column; menu.dispatchEvent(new ctx.win.Event('change')); };
export async function agentFixture(t) {
  const ctx = await linkedKanban(t);
  ctx.executor.subscribe = (_runId, _after, sink) => {
    // Keep the fake session live, but flush the response with a harmless heartbeat.
    // Otherwise each fixture waits for the server's 15s keepalive before fetch resolves.
    sink.write({ ping: true });
    return () => {};
  };
  await savedStageProject(ctx, 'Other');
  const board = ctx.app.board;
  const [flow, other] = (await serverBoard(ctx)).projects;
  const task = async (project, title) => (await board.createTask({ projectId: project.id, title, prompt: `Do ${title}.` })).id;
  const tasks = { a: await task(flow, 'Auth middleware'), b: await task(flow, 'API tests'), c: await task(other, 'Review docs') };
  const now = Date.now();
  const run = (id, taskId, projectId, stage, status, config) => ({ id, taskId, projectId, stage, status, createdAt: now - 5000, updatedAt: now, startedAt: now - 5000, turns: 0,
    config, branch: `promptboard/${id}`, workspacePath: `/tmp/wt-${id}`, artifactsDir: `runs/${id}` });
  await board.store.update(draft => {
    draft.runs.push(run('run-a', tasks.a, flow.id, 'executing', 'running', { provider: 'claude', model: 'opus', effort: 'high' }),
      run('run-b', tasks.b, flow.id, 'code_review', 'waiting_for_input', { provider: 'codex', model: 'gpt-5.5', effort: '' }),
      run('run-c', tasks.c, other.id, 'planning', 'queued', { provider: 'claude', model: '', effort: '' }));
  });
  // Show the Flow project.
  await ctx.win.__pbTest.loadBoard(); ctx.pick(flow.id); await ctx.idle();
  return { ...ctx, tasks, flow, other };
}
export const agentRows = ({ $ }) => Array.from($('#agents-list').querySelectorAll('.agent-item'));
