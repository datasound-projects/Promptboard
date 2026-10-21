// Docker mode in the page (JSDOM): Settings → Docker sandbox with a scripted API, and the project setting, the card tag
// and the agent line in the real app. Nothing here uses Docker or starts an agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { resolveConfig } from '../src/agents.mjs';
import { cardItem, fakeExecutor, gitRepo, goTo, setup, submitForm, until } from './helpers/ui-harness.mjs';

const domSource = await readFile(new URL('../public/dom.js', import.meta.url), 'utf8');
const source = await readFile(new URL('../public/sandbox.js', import.meta.url), 'utf8');
const TOKEN = 'sk-ant-oat01-PAGE-FIXTURE-0123456789abcdef';
const status = (over = {}) => ({ docker: 'running', image: { name: 'promptboard-sandbox:abc123def456', custom: false, ready: false }, signIn: { claude: false, codex: true }, build: { status: 'idle', lines: [] }, ...over });

function section(t, answer) {
  const dom = new JSDOM(`<dialog id="app-settings" open><button id="app-settings-open"></button><details class="settings-section" id="settings-sandbox-section" open><summary>Docker sandbox</summary>
    <fieldset class="settings-group" id="set-sandbox-group"><legend class="sr-only">Docker sandbox</legend></fieldset></details></dialog>`, { url: 'http://127.0.0.1/', runScripts: 'outside-only' });
  const win = dom.window, $ = selector => win.document.querySelector(selector), calls = [], said = [], errors = [];
  win.addEventListener('error', event => errors.push(event.error));
  t.after(() => win.close());
  const api = async (path, options = {}) => { calls.push({ path, method: options.method || 'GET', body: options.body }); const [code, data] = await answer(path, options); return { response: { ok: code < 400, status: code }, data }; };
  win.eval(domSource); win.eval(source);
  const view = win.PromptboardSandbox.create({ api, announce: text => said.push(text) });
  const text = () => $('#set-sandbox-group').textContent;
  return { win, $, view, calls, said, errors, text, click: selector => $(selector).click(), byText: label => [...win.document.querySelectorAll('#set-sandbox-group button')].find(node => node.textContent === label) };
}

test('Settings shows what Docker mode still needs, builds the image with live progress, and keeps the Claude Code token out of the page', async t => {
  let current = status(), polls = 0;
  const page = section(t, async (path, { method = 'GET', body } = {}) => {
    if (path === '/api/sandbox' && method === 'GET') return [200, { sandbox: current }];
    if (path === '/api/sandbox/build' && method === 'POST') { current = status({ build: { status: 'running', lines: ['Step 1/3 : FROM node:22-bookworm-slim'] } }); return [200, { sandbox: current }]; }
    if (path === '/api/sandbox/build' && method === 'GET') {
      polls++;
      if (polls === 1) return [200, { build: { status: 'running', lines: ['Step 1/3 : FROM node:22-bookworm-slim', 'Step 2/3 : RUN apt-get install git'] } }];
      current = status({ image: { ...current.image, ready: true }, build: { status: 'succeeded', lines: [] } });
      return [200, { build: current.build }];
    }
    if (path === '/api/sandbox/claude-token' && method === 'PUT') {
      if (body.token.includes(' ')) return [409, { error: 'Paste the whole token that claude setup-token printed, with no spaces.', code: 'SANDBOX_INVALID_TOKEN' }];
      current = { ...current, signIn: { ...current.signIn, claude: true } }; return [200, { sandbox: current }];
    }
    if (path === '/api/sandbox/claude-token' && method === 'DELETE') { current = { ...current, signIn: { ...current.signIn, claude: false } }; return [200, { sandbox: current }]; }
    return [404, { error: 'Not found.' }];
  });
  const { $, win, text } = page;
  await page.view.load();
  assert.equal($('[role="status"]').textContent, 'Not ready yet. The list below says what is missing.');
  assert.deepEqual([...win.document.querySelectorAll('.sandbox-checks li')].map(item => item.dataset.ok), ['true', 'false', 'true', 'false']);
  assert.match(text(), /The image is not built yet\..*Codex uses this computer’s Codex sign-in, read-only\..*Claude Code needs a token/);
  // Build image: progress lines appear while it runs, then the status is read again.
  page.click('#set-sandbox-build');
  await until(() => $('#set-sandbox-cancel'), 'build running');
  assert.match($('.sandbox-log').textContent, /Step 1\/3/);
  const token = $('#set-sandbox-token');
  token.value = 'not a token'; token.dispatchEvent(new win.Event('input'));
  await until(() => /Step 2\/3/.test($('.sandbox-log')?.textContent || ''), 'live progress', 5000);
  assert.equal($('#set-sandbox-token'), token, 'A progress update leaves the token field alone.');
  await until(() => /Image ready: promptboard-sandbox:abc123def456/.test(text()), 'image ready', 5000);
  assert.ok(page.said.includes('The Docker image is built.'));
  assert.equal($('[role="status"]').textContent, 'Ready: card agents can run in Docker.');
  assert.equal(page.byText('Build again').className, 'secondary-button');
  // A refused token says why; a saved one is never shown again.
  page.click('#set-sandbox-token-save');
  await until(() => /Paste the whole token/.test(text()), 'refusal shown');
  $('#set-sandbox-token').value = TOKEN; $('#set-sandbox-token').dispatchEvent(new win.Event('input'));
  page.click('#set-sandbox-token-save');
  await until(() => page.byText('Remove Claude Code token'), 'token saved');
  assert.deepEqual(JSON.parse(JSON.stringify(page.calls.filter(call => call.method === 'PUT').at(-1))), { path: '/api/sandbox/claude-token', method: 'PUT', body: { token: TOKEN } }); // The page’s objects come from another realm.
  assert.ok(!win.document.body.innerHTML.includes(TOKEN), 'The token is not in the page.');
  assert.equal($('#set-sandbox-token'), null);
  page.byText('Remove Claude Code token').click();
  await until(() => $('#set-sandbox-token'), 'token removed');
  assert.equal($('#set-sandbox-token').value, '', 'The field starts empty again.');
  assert.deepEqual(page.errors, []);
});

test('an image of your own sits under More, and a stopped Docker offers no build', async t => {
  let current = status({ docker: 'stopped' });
  const page = section(t, async (path, { method = 'GET', body } = {}) => {
    if (path === '/api/sandbox' && method === 'GET') return [200, { sandbox: current }];
    if (path === '/api/sandbox/settings') { current = status({ image: { name: body.image, custom: true, ready: true } }); return [200, { sandbox: current }]; }
    return [404, { error: 'Not found.' }];
  });
  await page.view.load();
  assert.match(page.text(), /Docker is installed but not running\. Start it \(for Colima: colima start\)\./);
  assert.equal(page.$('#set-sandbox-build'), null, 'Building needs a running Docker.');
  const more = page.$('.sandbox-more');
  assert.equal(more.open, false, 'Extras are folded away.');
  page.$('#set-sandbox-image').value = 'my-tools/sandbox:2';
  page.byText('Save image name').click();
  await until(() => /Image ready: my-tools\/sandbox:2/.test(page.text()), 'own image');
  assert.equal(page.$('#set-sandbox-image').value, 'my-tools/sandbox:2');
  assert.equal(page.$('#set-sandbox-build'), null, 'Promptboard’s build is not offered for your own image.');
});

test('Columns → How agents work turns Docker mode on for the project, and the card and its agent line say In Docker', { skip: process.platform === 'win32' }, async t => {
  const executor = fakeExecutor();
  executor.validate = async ({ stage, config }) => resolveConfig(stage, config); // The real run configuration, Docker mode included.
  const ctx = await setup(t, { executor });
  const { $, win, app } = ctx;
  const repo = await gitRepo(t);
  const project = await app.board.createProject({ name: 'Boxed', workflowMode: 'pipeline' });
  const revision = async () => (await app.board.state()).projects.find(item => item.id === project.id).revision;
  await app.board.linkRepository(project.id, { path: repo, expectedRevision: await revision() });
  await app.board.setTargetBranch(project.id, { branch: 'trunk', expectedRevision: await revision() });
  await goTo(ctx, '#/kanban');
  await win.__pbTest.loadBoard(); ctx.pick(project.id); await ctx.idle();
  $('#columns-open').click(); await ctx.idle();
  $('#columns-tab-board').click(); await ctx.idle();
  const select = $('#execution-sandbox');
  assert.deepEqual([...select.options].map(item => [item.value, item.textContent]), [['', 'Default: No, on this computer'], ['docker', 'Yes: each agent sees only its card’s workspace']]);
  assert.match(select.closest('label').textContent, /^Run agents in Docker.*Claude Code and Codex only\. Set Docker up first in Settings → Docker sandbox\.$/);
  const grid = [...$('.execution-grid').children].map(node => node.querySelector('select, input')?.id);
  assert.equal(grid.indexOf('execution-sandbox'), grid.indexOf('execution-filesystem') + 1, 'Next to Workspace access.');
  select.value = 'docker'; select.dispatchEvent(new win.Event('change', { bubbles: true }));
  submitForm(ctx, '#columns-form'); await ctx.idle({ requireComplete: true });
  assert.equal((await app.board.state()).projects.find(item => item.id === project.id).execution.sandbox, 'docker');
  const task = await app.board.createTask({ projectId: project.id, title: 'Boxed card', prompt: 'Change the file.' });
  await app.board.transition(task.id, { column: 'executing', expectedRevision: task.revision });
  await win.__pbTest.loadBoard(); await ctx.idle();
  const card = cardItem(ctx, 'Boxed card');
  assert.equal(card.querySelector('.sandbox-tag')?.textContent, 'In Docker');
  assert.match(card.querySelector('.card-agent-info').textContent, /Run agent: Claude Code · CLI default model · In Docker/);
  assert.equal(executor.started.at(-1).config.sandbox, 'docker');
});
