// The Insights dialog in a page (JSDOM), fed by the real computeInsights output of small hand-built boards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { computeInsights } from '../src/insights.mjs';
import { defaultPipelineConfig } from '../src/pipeline-config.mjs';

const domSource = await readFile(new URL('../public/dom.js', import.meta.url), 'utf8');
const source = await readFile(new URL('../public/insights.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(fn, label) { for (let n = 0; n < 200; n++) { if (fn()) return; await tick(); } assert.fail(`Timed out: ${label}`); }
const H = 3600000, NOW = Date.UTC(2026, 9, 21, 12);

/** One merged Claude card with a review round, one merged Codex card, and a card still in Code Review. */
function busyBoard() {
  const t0 = NOW - 2 * 24 * H, move = (h, from, to) => ({ at: t0 + h * H, from, to, by: 'user' });
  const task = (id, number, title, column, extra) => ({ id, number, title, column, createdAt: t0, updatedAt: t0, transitions: [], labelIds: [], ...extra });
  const run = (id, taskId, provider, usage) => ({ id, taskId, projectId: 'p', stage: 'executing', stageKind: 'executing', status: 'succeeded', createdAt: t0 + H, startedAt: t0 + H, config: { provider, model: '' }, providerSessionId: id, usage });
  return {
    projects: [{ id: 'p', name: 'Shop', workflowMode: 'pipeline', pipeline: defaultPipelineConfig(), tasks: [
      task('a', 1, 'Login form', 'done', { transitions: [move(1, 'todo', 'executing'), move(3, 'executing', 'code_review'), move(4, 'code_review', 'done')], completion: { kind: 'merged', at: t0 + 4 * H },
        stageHistory: [{ stage: 'code_review', status: 'changes_required', at: t0 + 2 * H, reason: 'Validate the email field.' }] }),
      task('b', 2, 'Search', 'done', { transitions: [move(1, 'todo', 'executing'), move(2, 'executing', 'done')], completion: { kind: 'merged', at: t0 + 2 * H } }),
      task('c', 3, 'Checkout', 'code_review', { transitions: [move(1, 'todo', 'code_review')] }),
    ] }],
    runs: [run('r1', 'a', 'claude', { model: 'claude-opus', inputTokens: 2000, outputTokens: 500, cachedTokens: 9000, costUSD: 0.42 }), run('r2', 'b', 'codex', { model: 'gpt-5', inputTokens: 800, outputTokens: 100, cachedTokens: 0 })],
  };
}
const quiet = () => ({ projects: [{ id: 'q', name: 'Quiet', tasks: [] }], runs: [] });

function setup(t, { projects = [{ id: 'p', name: 'Shop' }], current = projects[0], fail = null } = {}) {
  const dom = new JSDOM('<button id="insights-open" type="button">Insights</button>', { url: 'http://127.0.0.1/', runScripts: 'outside-only' });
  const win = dom.window, $ = selector => win.document.querySelector(selector), $$ = selector => [...win.document.querySelectorAll(selector)];
  win.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  win.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new win.Event('close')); };
  const errors = [], calls = [], opened = [];
  win.addEventListener('error', event => errors.push(event.error));
  t.after(() => win.close());
  const boards = { p: busyBoard(), q: quiet() };
  const api = async path => {
    calls.push(path);
    const [, id, days] = path.match(/^\/api\/projects\/([^/]+)\/insights\?days=(.+)$/);
    if (fail) return { response: { ok: false }, data: { error: fail } };
    return { response: { ok: true }, data: { insights: computeInsights(boards[id], id, { days: days === 'all' ? null : Number(days), now: NOW, originLookup: new Map(), promptLookup: new Map() }) } };
  };
  win.eval(domSource); win.eval(source);
  win.PromptboardInsights.create({ api, projects: () => projects, currentProject: () => current, ensureBoard: async () => {}, openTask: (projectId, taskId) => opened.push([projectId, taskId]) });
  const open = async () => { $('#insights-open').click(); await until(() => $('#insights-dialog').open && !/Counting/.test($('.insights-status').textContent), 'loaded'); };
  return { win, $, $$, calls, opened, errors, open };
}
const headings = $$ => $$('.insights-section h3').map(node => node.textContent);

test('the top bar icon opens Insights for the current project with the four sections, as bars and plain numbers', async t => {
  const { $, $$, calls, errors, open } = setup(t);
  await open();
  assert.deepEqual(calls, ['/api/projects/p/insights?days=30'], 'Last 30 days by default.');
  assert.equal($('.insights-project').hidden, true, 'One project needs no picker.');
  assert.equal($('.insights-dialog .eyebrow').textContent, 'SHOP');
  assert.deepEqual(headings($$), ['Rework', 'Time in each column', 'Cost per merged card', 'Cards that fail review most']);
  assert.deepEqual($$('.insights-tile strong').map(node => node.textContent), ['2', '2', '2.0 h', '3k', '$0.42'], 'finished, merged, median time, tokens, and the price Claude Code reported');
  assert.match($('.insights-tiles').textContent, /for 1 of 2 cards/);
  assert.match($('.insights-section').textContent, /Claude Code.*100% reworked.*1\.0 rounds per card.*1 card/s);
  // Each bar is as long as its share; it is decoration, the text carries the number.
  assert.equal($('.insights-section .insights-bar > span').style.width, '100%');
  assert.equal($('.insights-bar').getAttribute('aria-hidden'), 'true');
  const review = $$('.insights-section')[1].querySelectorAll('.insights-row')[3];
  assert.match(review.textContent, /Code Review.*median 24 h · total 2 days.*1 still here/s, 'The card still in Code Review counts up to now and is marked.');
  // Unknown price: a dash with the reason, readable by keyboard and screen readers.
  const unknown = $('.insights-unknown');
  assert.deepEqual([unknown.textContent, unknown.title, unknown.tabIndex], ['—', 'Codex does not report a price.', 0]);
  assert.match(unknown.getAttribute('aria-label'), /Price unknown\. Codex does not report a price\./);
  assert.match($$('.insights-section')[3].textContent, /#1 Login form.*1 round · 1 from review.*Validate the email field\./s);
  assert.equal($('.insights-status').getAttribute('role'), 'status');
  assert.deepEqual(errors, []);
});

test('rework switches between agent, model and template; the range asks again; a card opens its details', async t => {
  const { win, $, $$, calls, opened, open } = setup(t);
  await open();
  const pressed = selector => $$(`${selector} button`).map(node => node.getAttribute('aria-pressed'));
  assert.deepEqual(pressed('.insights-range'), ['true', 'false', 'false']);
  assert.deepEqual(pressed('.insights-group'), ['true', 'false', 'false']);
  $$('.insights-group button')[1].click();
  assert.match($$('.insights-section')[0].textContent, /Claude Code · claude-opus.*Codex CLI · gpt-5/s);
  $$('.insights-group button')[2].click();
  assert.match($$('.insights-section')[0].textContent, /No template.*50% reworked.*2 cards/s);
  $$('.insights-range button')[2].click();
  await until(() => calls.length === 2, 'All');
  assert.equal(calls[1], '/api/projects/p/insights?days=all');
  await until(() => $('.insights-range button[aria-pressed="true"]').textContent === 'All', 'range pressed');
  $$('.insights-card').find(node => node.textContent === '#1 Login form').click();
  assert.deepEqual(opened, [['p', 'a']]);
  assert.equal($('#insights-dialog').open, false, 'The dialog closes so the card details show.');
  assert.equal(win.document.activeElement, $('#insights-open'));
});

test('empty states use plain words, the picker switches projects, and a failed read says so', async t => {
  const { $, $$, calls, open } = setup(t, { projects: [{ id: 'p', name: 'Shop' }, { id: 'q', name: 'Quiet' }], current: { id: 'q' } });
  await open();
  assert.equal($('.insights-project').hidden, false);
  assert.equal($('#insights-project').value, 'q');
  assert.deepEqual(headings($$), ['Time in each column', 'Cards that fail review most']);
  assert.match($('.insights-body').textContent, /No finished cards in the last 30 days\./);
  assert.match($('.insights-body').textContent, /No cards moved in the last 30 days\./);
  assert.match($('.insights-body').textContent, /No review or test failures in the last 30 days\./);
  $$('.insights-range button')[2].click();
  await until(() => /No finished cards yet\./.test($('.insights-body').textContent), 'All, empty');
  const picker = $('#insights-project'); picker.value = 'p'; picker.dispatchEvent(new picker.ownerDocument.defaultView.Event('change'));
  await until(() => $$('.insights-section').length === 4, 'other project');
  assert.equal(calls.at(-1), '/api/projects/p/insights?days=all', 'The chosen range stays.');

  const failing = setup(t, { fail: 'This project does not exist. Reload the board.' });
  await failing.open();
  assert.equal(failing.$('.inline-error').hidden, false);
  assert.equal(failing.$('.inline-error').textContent, 'This project does not exist. Reload the board.');
  assert.equal(failing.$('.inline-error').getAttribute('role'), 'alert');

  const none = setup(t, { projects: [], current: null });
  none.$('#insights-open').click();
  await until(() => none.$('#insights-dialog').open, 'open without projects');
  assert.equal(none.$('.insights-status').textContent, 'Create a project on the Kanban page first.');
  assert.deepEqual(none.calls, [], 'Nothing to read.');
});
