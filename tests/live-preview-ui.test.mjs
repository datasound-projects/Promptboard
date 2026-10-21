// The Preview section of a card's Details and the board card's preview button (public/live-preview.js) in jsdom,
// against a scripted stand-in for the preview routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const domSource = await readFile(new URL('../public/dom.js', import.meta.url), 'utf8');
const source = await readFile(new URL('../public/live-preview.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 2));
async function until(fn, label) { for (let n = 0; n < 500; n++) { if (fn()) return; await tick(); } assert.fail(`Timed out: ${label}`); }
const URL_A = 'http://127.0.0.1:5173/';

function setup(t, { remote = false, state: initial = {}, previews = [] } = {}) {
  const dom = new JSDOM('<main id="details"></main>', { url: 'http://127.0.0.1/', runScripts: 'outside-only' });
  const win = dom.window, $ = selector => win.document.querySelector(selector);
  t.after(() => win.close());
  // The page polls once a second while a preview starts; here a poll waits a few milliseconds.
  const nativeTimeout = win.setTimeout.bind(win);
  win.setTimeout = (fn, ms, ...args) => nativeTimeout(fn, Math.min(ms, 5), ...args);
  const errors = []; win.addEventListener('error', event => errors.push(event.error));
  const state = { preview: null, settings: { command: 'npm run dev', setup: [] }, suggestion: { command: 'npm run dev', setup: 'npm ci' }, workspace: true, running: [], ...initial };
  const calls = [], announced = [], opened = [];
  let steps = [];
  const shown = [];
  // `steps` are the statuses the next reads return, one per read, as a starting server goes through them.
  const answer = data => ({ response: { ok: !data.code }, data });
  const api = async (path, { method = 'GET', body } = {}) => {
    calls.push([method, path, body && JSON.parse(JSON.stringify(body))]); // Plain objects of this realm, for deepEqual.
    if (state.refuse && method === 'POST') { const refusal = state.refuse; state.refuse = null; return answer(refusal); }
    if (method === 'POST') state.preview = { taskId: path.split('/')[3], title: 'Landing', status: 'installing', url: null, output: ['added 1 package'] };
    if (method === 'DELETE') { const id = path.split('/')[3]; state.running = state.running.filter(item => item.taskId !== id); if (id === 't1') state.preview = null; }
    if (method === 'GET' && steps.length) state.preview = { ...state.preview, ...steps.shift() };
    const own = ['installing', 'starting', 'ready'].includes(state.preview?.status) ? [{ taskId: 't1', number: 1, title: 'Landing', status: state.preview.status, url: state.preview.url }] : [];
    return answer(structuredClone({ preview: state.preview, settings: state.settings, suggestion: state.suggestion, workspace: state.workspace, running: [...state.running, ...own] }));
  };
  const project = { id: 'p1', revision: 3 };
  const boardCall = async (method, path, body) => { calls.push([method, path, JSON.parse(JSON.stringify(body))]); state.settings = { command: body.command, setup: body.setup }; project.revision++; return {}; };
  win.eval(domSource); win.eval(source);
  const view = win.PromptboardPreview.create({ api, boardCall, announce: text => announced.push(text), remote: () => remote, project: () => project,
    previews: () => previews, showRunning: running => { shown.push(JSON.parse(JSON.stringify(running))); previews = running; }, openDetails: id => opened.push(id) });
  const make = (title, ...nodes) => { const box = win.document.createElement('section'); const heading = win.document.createElement('h3'); heading.textContent = title; box.append(heading, ...nodes); return box; };
  const mount = () => { $('#details').replaceChildren(view.section({ id: 't1', title: 'Landing' }, make)); };
  const buttons = () => [...$('#details').querySelectorAll('.preview-body button')].map(node => node.textContent);
  const press = text => [...$('#details').querySelectorAll('button')].find(node => node.textContent === text).click();
  const status = () => $('#details [role="status"]');
  return { win, $, view, state, calls, announced, opened, errors, mount, buttons, press, status, project, setSteps: list => { steps = list; }, shown };
}

test('a card without a preview command offers its suggestion in one click, then Start preview leads to Open preview and Stop', async t => {
  const page = setup(t, { state: { settings: null } });
  const { $, state, calls, mount, buttons, press, status } = page;
  mount();
  await until(() => status().textContent === 'Set a preview command.', 'the suggestion');
  assert.deepEqual(buttons(), ['Use npm run dev']);
  assert.match($('.preview-body').textContent, /installs dependencies first with npm ci when the folder has no node_modules/);
  press('Use npm run dev');
  await until(() => buttons().includes('Start preview'), 'the saved command');
  assert.deepEqual(calls.find(call => call[0] === 'PATCH'), ['PATCH', '/api/projects/p1/preview', { command: 'npm run dev', setup: ['npm ci'], expectedRevision: 3 }]);
  assert.match($('.preview-body').textContent, /Runs npm run dev in this card’s folder on this computer, after npm ci when node_modules is missing\./);
  assert.equal(page.announced.at(-1), 'Preview command saved: npm run dev.');
  page.setSteps([{ status: 'installing' }, { status: 'starting', output: ['added 1 package', 'VITE ready'] }, { status: 'ready', url: URL_A, output: ['added 1 package', 'VITE ready', `Local: ${URL_A}`] }]);
  press('Start preview');
  await until(() => status().textContent === 'Installing dependencies…', 'installing');
  assert.deepEqual(calls.find(call => call[0] === 'POST'), ['POST', '/api/tasks/t1/preview', { confirm: true }]);
  assert.deepEqual(buttons(), ['Stop']);
  await until(() => status().textContent === `Running at ${URL_A}`, 'ready');
  const open = $('.preview-open');
  assert.deepEqual([open.textContent, open.href, open.target, open.rel], ['Open preview', URL_A, '_blank', 'noopener noreferrer']);
  assert.equal($('.preview-output').hidden, false);
  assert.equal($('.preview-output pre').textContent, `added 1 package\nVITE ready\nLocal: ${URL_A}`);
  assert.equal(page.announced.at(-1), 'Preview ready for “Landing”.');
  assert.deepEqual(page.shown.at(-1), [{ taskId: 't1', number: 1, title: 'Landing', status: 'ready', url: URL_A }], 'The board’s cards learn of the running preview.');
  const reads = calls.filter(call => call[0] === 'GET').length;
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(calls.filter(call => call[0] === 'GET').length, reads, 'No polling once the preview is ready.');
  press('Stop');
  await until(() => buttons().includes('Start preview'), 'stopped');
  assert.deepEqual(calls.at(-1).slice(0, 2), ['DELETE', '/api/tasks/t1/preview']);
  assert.equal($('.preview-output').hidden, true);
  assert.deepEqual(page.shown.at(-1), []);
  assert.deepEqual(page.errors, []);
});

test('a refused fourth preview lists the running ones with Stop, and a failed preview says why in plain words', async t => {
  const page = setup(t, { state: { running: [{ taskId: 'a', number: 1, title: 'One' }, { taskId: 'b', number: 2, title: 'Two' }, { taskId: 'c', number: 3, title: 'Three' }],
    refuse: { error: 'Stop another preview first. Running now: #1 One, #2 Two, #3 Three.', code: 'PREVIEW_LIMIT' } } });
  const { $, calls, mount, press, status } = page;
  mount();
  await until(() => [...$('.preview-body').querySelectorAll('button')].some(node => node.textContent === 'Start preview'), 'ready to start');
  press('Start preview');
  await until(() => $('.preview-body .inline-error'), 'the refusal');
  assert.equal($('.preview-body .inline-error').textContent, 'Stop another preview first.');
  assert.deepEqual([...$('.preview-running').children].map(row => row.textContent), ['#1 One Stop', '#2 Two Stop', '#3 Three Stop']);
  $('.preview-running button[aria-label="Stop the preview of Two"]').click();
  await until(() => !$('.preview-running'), 'the list goes once one is stopped');
  assert.ok(calls.some(call => call[0] === 'DELETE' && call[1] === '/api/tasks/b/preview'));
  page.state.preview = { status: 'failed', message: 'The preview stopped: Error: Cannot find module \'vite\'', url: null, output: ['Error: Cannot find module \'vite\''] };
  mount();
  await until(() => status().textContent.startsWith('The preview stopped'), 'the failure');
  assert.equal(status().className, 'inline-error');
  assert.ok([...$('.preview-body').querySelectorAll('button')].some(node => node.textContent === 'Start preview'), 'It can start again.');
});

test('on a paired phone the section says to open the preview on the computer and offers no start or settings', async t => {
  const page = setup(t, { remote: true, state: { preview: { status: 'ready', url: URL_A, title: 'Landing', output: ['ready'] } } });
  const { $, mount, status, buttons } = page;
  mount();
  await until(() => status().textContent === 'Open the preview on the computer.', 'the remote note');
  assert.deepEqual(buttons(), []);
  assert.equal($('.preview-open'), null);
  assert.match($('.preview-body').textContent, /It runs there at http:\/\/127\.0\.0\.1:5173\//);
  assert.deepEqual([$('.preview-output').hidden, $('.preview-more').hidden], [true, true]);
});

test('the board card links to a running preview, and while it starts its button opens the card', async t => {
  const previews = [{ taskId: 't1', status: 'ready', url: URL_A }, { taskId: 't2', status: 'starting', url: null }];
  const page = setup(t, { previews });
  const ready = page.view.cardButton({ id: 't1', title: 'Landing' });
  assert.deepEqual([ready.tagName, ready.href, ready.target, ready.getAttribute('aria-label'), ready.title], ['A', URL_A, '_blank', 'Open preview: Landing', `Open preview (${URL_A})`]);
  assert.ok(ready.querySelector('svg'));
  const starting = page.view.cardButton({ id: 't2', title: 'Footer' });
  assert.deepEqual([starting.tagName, starting.classList.contains('is-starting'), starting.getAttribute('aria-label')], ['BUTTON', true, 'Preview starting: Footer']);
  starting.click();
  assert.deepEqual(page.opened, ['t2']);
  await until(() => page.calls.some(call => call[1] === '/api/tasks/t2/preview'), 'a starting preview is read again');
  assert.equal(page.view.cardButton({ id: 't3', title: 'None' }), null);
});

test('polling while a preview starts keeps keyboard focus on Stop and keeps a command being typed', async t => {
  const page = setup(t, { state: { preview: { status: 'starting', url: null, title: 'Landing', output: ['one'] } } });
  const { $, win, mount, setSteps } = page;
  setSteps([{ output: ['one', 'two'] }, { output: ['one', 'two', 'three'] }, { output: ['one', 'two', 'three', 'four'] }]);
  mount();
  await until(() => $('.preview-body button')?.textContent === 'Stop', 'Stop');
  const stop = $('.preview-body button'); stop.focus();
  const input = $('.preview-more input');
  input.value = 'npm run preview'; input.dispatchEvent(new win.Event('input', { bubbles: true }));
  await until(() => $('.preview-output pre').textContent === 'one\ntwo\nthree\nfour', 'new output');
  assert.equal(win.document.activeElement, stop, 'The same Stop button keeps focus.');
  assert.equal(input.value, 'npm run preview');
});
