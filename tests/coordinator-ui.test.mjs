import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const domSource = await readFile(new URL('../public/dom.js', import.meta.url), 'utf8');
const source = await readFile(new URL('../public/coordinator.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(fn, label) { for (let n = 0; n < 200; n++) { if (fn()) return; await tick(); } assert.fail(`Timed out: ${label}`); }
const overview = (chat = []) => ({ enabled: true, agents: [], progress: { done: 0, total: 1 }, blockers: [], recent: [], columns: [{ name: 'To Do', count: 1 }], chat });

function setup(t) {
  const dom = new JSDOM('<div id="coordinator" hidden></div><button id="coordinator-toggle" hidden></button>', { url: 'http://127.0.0.1/', runScripts: 'outside-only' });
  const win = dom.window, $ = selector => win.document.querySelector(selector);
  const errors = [];
  win.addEventListener('error', event => errors.push(event.error));
  t.after(() => win.close());
  const asks = [], reads = new Map();
  const api = (path, options = {}) => {
    const id = decodeURIComponent(path.split('/')[3]);
    if (path.endsWith('/ask')) return new Promise(resolve => asks.push({ id, question: options.body.question, answer: chat => resolve({ response: { ok: true }, data: { chat } }) }));
    return Promise.resolve({ response: { ok: true }, data: reads.get(id) || overview() });
  };
  const projects = { a: { id: 'a', tasks: [{ id: 'ta', number: 1, title: 'One', workspace: { branch: 'feature/a' } }] }, b: { id: 'b', tasks: [] } };
  let current = projects.a;
  win.eval(domSource); win.eval(source);
  const view = win.PromptboardCoordinator.create({ api, announce: () => {}, project: () => current, runs: () => [], openTask: () => {}, copy: () => {}, composeSettings: () => ({ provider: 'codex' }) });
  const show = (id, revision = 1) => { current = projects[id]; view.sync(current, revision); };
  const type = text => { const area = $('#coordinator-question'); area.value = text; area.dispatchEvent(new win.Event('input', { bubbles: true })); return area; };
  return { win, $, view, show, asks, reads, errors, type };
}

test('a Coordinator answer stays with the project it was asked in, and the other project never looks busy', async t => {
  const { win, $, show, view, asks, reads, errors, type } = setup(t);
  show('a');
  view.askAbout(null);
  await until(() => $('.coordinator-grid') && $('#coordinator-question'), 'project A open with chat');
  type('What is left?');
  $('.coordinator-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => asks.length === 1 && $('.coordinator-thinking'), 'asking A');
  // Switch to B before A answers. B has no data yet when the answer lands.
  reads.set('b', overview());
  win.localStorage.setItem('promptboard.coordinator.b', 'open');
  show('b');
  assert.equal($('#coordinator-question'), null, 'B starts without the chat');
  asks[0].answer([{ role: 'user', text: 'What is left?', at: 1 }, { role: 'coordinator', text: 'Only card one.', at: 2, refs: [] }]);
  await until(() => $('.coordinator-grid'), 'B overview');
  await tick();
  assert.deepEqual(errors, []);
  view.askAbout(null);
  assert.equal($('.coordinator-thinking'), null, 'B is not busy with A’s question');
  assert.equal($('.coordinator-message'), null, 'A’s answer is not in B’s chat');
  type('And here?');
  assert.equal($('#coordinator-send').disabled, false, 'B can ask its own question');
});

test('board renders leave the open chat in place: caret, open target menu and scroll are kept', async t => {
  const { $, show, view } = setup(t);
  show('a');
  view.askAbout({ kind: 'task', id: 'ta' });
  await until(() => $('.coordinator-grid') && $('#coordinator-question'), 'chat open');
  const area = $('#coordinator-question'), target = $('#coordinator-target'), log = $('.coordinator-messages');
  area.value = 'Where does this stand'; area.focus(); area.setSelectionRange(5, 5);
  // Agents running: the board renders several times a second.
  for (let revision = 2; revision < 6; revision++) { show('a', revision); await tick(); }
  show('a', 5); show('a', 5);
  assert.equal($('#coordinator-question'), area, 'the same question field');
  assert.equal($('#coordinator-target'), target, 'the same target menu');
  assert.equal($('.coordinator-messages'), log, 'the same message log');
  assert.equal(area.ownerDocument.activeElement, area);
  assert.equal(area.selectionStart, 5, 'the caret did not move');
  assert.equal($('#coordinator').lastElementChild, $('.coordinator-chat'), 'the chat stays below the overview');
  assert.ok($('.coordinator-grid'), 'the overview is still drawn');
});
