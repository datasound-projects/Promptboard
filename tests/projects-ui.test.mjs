import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../public/projects.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(fn, label) { for (let n = 0; n < 200; n++) { if (fn()) return; await tick(); } assert.fail(`Timed out: ${label}`); }

test('saved prompts cannot be opened while Compose is running, and say why instead of doing nothing', async t => {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1/', runScripts: 'outside-only' }), win = dom.window, $ = selector => win.document.querySelector(selector);
  t.after(() => win.close());
  win.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  win.localStorage.setItem('promptboard.compose.sidebar', 'projects');
  win.localStorage.setItem('promptboard.compose.project', 'p1');
  const calls = [], said = [], opened = [];
  const prompt = { id: 'q1', title: 'Checkout prompt', current: 1, revision: 1, updatedAt: Date.now(), cards: [], origin: [] };
  const api = async path => {
    calls.push(path);
    if (path === '/api/shared-projects') return { response: { ok: true }, data: { projects: [{ id: 'p1', name: 'Shop', prompts: 1 }] } };
    if (path.endsWith('/prompts')) return { response: { ok: true }, data: { prompts: [prompt] } };
    return { response: { ok: true }, data: { project: { id: 'p1', name: 'Shop' }, prompt: { ...prompt, input: 'in', prompt: 'out', settings: {} } } };
  };
  let running = false;
  win.eval(source);
  const view = win.PromptboardProjects.create({ api, announce: text => said.push(text), running: () => running, getResult: () => null, openInCompose: (...args) => opened.push(args) });
  await until(() => $('.project-prompt'), 'saved prompt listed');
  assert.equal($('.project-prompt').disabled, false);
  // Compose starts: the app re-renders the link bar, which also disables the saved prompts.
  running = true; view.renderBar();
  assert.equal($('.project-prompt').disabled, true);
  const before = calls.length;
  await view.openPrompt('p1', 'q1');
  assert.equal(calls.length, before, 'nothing was fetched or opened');
  assert.match(said.at(-1), /Compose is writing a prompt/);
  running = false; view.renderBar();
  assert.equal($('.project-prompt').disabled, false);
  $('.project-prompt').click();
  await until(() => opened.length === 1, 'opened once Compose is idle');
});
