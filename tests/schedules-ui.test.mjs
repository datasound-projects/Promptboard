// The Schedules dialog (public/schedules.js) in jsdom, against the real schedule service and board, without HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
// schedules.mjs loads before board.mjs here (schedules.test.mjs loads them the other way): the two import each other.
import { Schedules, scheduleRoute } from '../src/schedules.mjs';
import { Board } from '../src/board.mjs';

process.env.TZ = 'Europe/Warsaw';
const domSource = await readFile(new URL('../public/dom.js', import.meta.url), 'utf8');
const source = await readFile(new URL('../public/schedules.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(fn, label) { for (let n = 0; n < 400; n++) { if (fn()) return; await tick(); } assert.fail(`Timed out: ${label}`); }
const NOW = new Date(2026, 9, 21, 12).getTime(); // Wednesday 21 October 2026, 12:00.

async function setup(t, { linked = false } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-schedules-ui-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const board = new Board({ dataDir }), schedules = new Schedules(board, { now: () => NOW, setTimer: () => null, clearTimer: () => {} });
  let project = await board.createProject({ name: 'Shop' });
  await board.setLabels(project.id, { labels: [{ id: 'deps', name: 'Dependencies', color: '#2563eb' }], expectedLabelRevision: 0 });
  if (linked) await board.store.update(state => { state.projects[0].repository = { path: '/repo', root: '/repo', commonDir: '/repo/.git' }; state.projects[0].revision++; });
  const refresh = async () => { project = (await board.view()).projects[0]; };
  await refresh();
  const requests = [];
  // The page's api(): the real route handler with the real service, answering as the server does.
  const api = async (path, { method = 'GET', body } = {}) => {
    requests.push({ method, path, body });
    const url = new URL(path, 'http://127.0.0.1'), [, projectId, scheduleId, run] = url.pathname.match(/^\/api\/projects\/([^/]+)\/schedules(?:\/([^/]+)(\/run)?)?$/);
    let data;
    try {
      await scheduleRoute(schedules, { method, projectId, scheduleId, run: Boolean(run), body: async () => body, json: value => { data = value; }, view: async value => { data = { ...value, board: await board.view() }; }, searchParams: url.searchParams });
      return { response: { ok: true, status: 200 }, data };
    } catch (error) { return { response: { ok: false, status: error.status }, data: { error: error.message, code: error.code } }; }
  };
  const dom = new JSDOM('<button id="schedules-open">Schedules</button><p id="announce"></p>', { url: 'http://127.0.0.1/', runScripts: 'outside-only' });
  const win = dom.window, $ = selector => win.document.querySelector(selector), $$ = selector => [...win.document.querySelectorAll(selector)];
  const errors = [];
  win.addEventListener('error', event => errors.push(event.error));
  win.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  win.HTMLDialogElement.prototype.close = function () { this.open = false; };
  t.after(() => win.close());
  win.eval(domSource); win.eval(source);
  const view = win.PromptboardSchedules.create({ api, announce: text => { $('#announce').textContent = text; }, project: () => project, acceptBoard: next => { project = next.projects[0]; } });
  const byText = text => $$('#schedules-dialog button').find(button => button.textContent === text);
  const submit = () => $('.schedule-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  const set = (selector, value) => { $(selector).value = value; $(selector).dispatchEvent(new win.Event('change', { bubbles: true })); };
  const open = async () => { $('#schedules-open').click(); await until(() => !$('.schedules-body').textContent.includes('Loading'), 'list loaded'); };
  return { win, $, $$, byText, submit, set, open, view, board, schedules, requests, errors, refresh, project: () => project };
}

test('the dialog starts from a quick start, shows the repeat in words with the next time, and Run now reports the new card', async t => {
  const ui = await setup(t);
  await ui.open();
  assert.equal(ui.$('#schedules-dialog').open, true);
  assert.equal(ui.$('#schedules-dialog .eyebrow').textContent, 'SHOP · SCHEDULES');
  assert.deepEqual(ui.$$('.schedule-quick button').map(button => button.textContent), ['Nightly dependency update', 'Weekly docs sweep', 'Weekly security sweep']);
  ui.byText('Nightly dependency update').click();
  assert.equal(ui.win.document.activeElement.id, 'schedule-title', 'the editor opens with focus on the title');
  assert.equal(ui.$('#schedule-title').value, 'Nightly dependency update');
  assert.match(ui.$('#schedule-prompt').value, /^Check this project's dependencies[\s\S]*change nothing and say so\.$/);
  assert.deepEqual([ui.$('#schedule-kind').value, ui.$('#schedule-time').value, ui.$('.schedule-days').hidden], ['daily', '02:00', true]);
  ui.$('.schedule-more').open = true;
  ui.set('#schedule-priority', '2');
  ui.$('#schedule-label-deps').checked = true;
  ui.submit();
  await until(() => ui.$('.schedule-item'), 'saved');
  const [saved] = ui.project().schedules;
  assert.deepEqual([saved.title, saved.priority, saved.labelIds, saved.cadence, saved.autopilot], ['Nightly dependency update', 2, ['deps'], { kind: 'daily', time: '02:00' }, false]);
  assert.equal(ui.$('.schedule-title').textContent, 'Nightly dependency update');
  assert.equal(ui.$('.schedule-when').textContent, 'Every day at 02:00 · Next Thu 22 Oct, 02:00');
  assert.equal(ui.$('.schedule-last').textContent, 'No card yet');
  assert.equal(ui.$('.schedules-status').textContent, '“Nightly dependency update” saved. Its next card comes Thu 22 Oct, 02:00.');
  assert.equal(ui.$('.schedules-status').getAttribute('role'), 'status');
  ui.byText('Run now').click();
  await until(() => ui.$('.schedule-last').textContent === 'Created #1', 'card made');
  assert.equal(ui.$('#announce').textContent, 'Created #1 “Nightly dependency update” in To Do.');
  assert.equal(ui.win.document.activeElement.id, `schedule-run-${saved.id}`, 'focus stays on Run now');
  assert.equal(ui.project().tasks[0].scheduleId, saved.id, 'the board the page shows has the card at once');
  assert.equal(ui.$('.schedule-when').textContent, 'Every day at 02:00 · Next Thu 22 Oct, 02:00', 'Run now keeps the next time');
  assert.deepEqual(ui.errors, []);
});

test('Run with Autopilot needs a code folder, and a one-time confirm before agents may work on the cards', async t => {
  const plain = await setup(t);
  await plain.open();
  plain.byText('New schedule').click();
  assert.equal(plain.$('#schedule-autopilot').disabled, true);
  assert.match(plain.$('.schedule-autopilot small').textContent, /Connect a code folder in Project settings first/);
  const ui = await setup(t, { linked: true });
  await ui.open();
  ui.byText('Weekly security sweep').click();
  assert.match(ui.$('.schedule-autopilot small').textContent, /^Agents then work on each new card on their own, without asking you\.$/);
  const toggle = ui.$('#schedule-autopilot');
  toggle.checked = true; toggle.dispatchEvent(new ui.win.Event('change'));
  assert.deepEqual([toggle.checked, ui.$('.schedule-consent').hidden], [false, false], 'nothing is switched on before the confirm');
  ui.byText('Keep it off').click();
  assert.deepEqual([toggle.checked, ui.$('.schedule-consent').hidden, ui.win.document.activeElement.id], [false, true, 'schedule-autopilot']);
  toggle.checked = true; toggle.dispatchEvent(new ui.win.Event('change'));
  ui.byText('Turn on Autopilot').click();
  assert.equal(toggle.checked, true);
  ui.submit();
  await until(() => ui.$('.schedule-item'), 'saved');
  assert.equal(ui.requests.find(request => request.method === 'POST').body.confirmAutopilot, true, 'the confirm is sent as the owner’s consent');
  assert.equal(ui.$('.schedule-when').textContent, 'Every Wednesday at 03:00 · Next Wed 28 Oct, 03:00 · With Autopilot');
  // Already on: editing it asks nothing again.
  ui.byText('Edit').click();
  assert.equal(ui.$('#schedule-autopilot').checked, true);
  ui.$('#schedule-title').value = 'Security sweep';
  ui.submit();
  await until(() => ui.$('.schedule-title')?.textContent === 'Security sweep', 'edited');
  assert.equal(ui.requests.at(-1).body.confirmAutopilot, undefined);
  assert.deepEqual(ui.errors, []);
});

test('weekly asks for days and monthly for a day of the month; the switch, the last result and Delete with its confirm work from the list', async t => {
  const ui = await setup(t);
  await ui.open();
  ui.byText('New schedule').click();
  ui.$('#schedule-title').value = 'Release notes';
  ui.$('#schedule-prompt').value = 'Write the release notes.';
  ui.set('#schedule-kind', 'weekly');
  assert.deepEqual([ui.$('.schedule-days').hidden, ui.$('#schedule-month-day').closest('label').hidden], [false, true]);
  ui.$('#schedule-day-1').checked = false;
  ui.submit();
  assert.equal(ui.$('.schedule-form .inline-error').textContent, 'Pick at least one day.');
  ui.set('#schedule-kind', 'monthly');
  assert.deepEqual([ui.$('.schedule-days').hidden, ui.$('#schedule-month-day').closest('label').hidden], [true, false]);
  ui.set('#schedule-month-day', '1');
  ui.set('#schedule-time', '08:30');
  ui.submit();
  await until(() => ui.$('.schedule-item'), 'saved');
  assert.equal(ui.$('.schedule-when').textContent, 'On the 1st of every month at 08:30 · Next Sun 1 Nov, 08:30');
  // A skipped slot is shown as a warning, with the reason.
  await ui.board.store.update(state => { state.projects[0].schedules[0].lastSkip = { at: NOW, reason: 'previous card #4 is still open' }; });
  await ui.refresh();
  ui.$('#schedules-dialog').open = false;
  await ui.open();
  assert.equal(ui.$('.schedule-last').textContent, 'Skipped: previous card #4 is still open');
  assert.equal(ui.$('.schedule-last').classList.contains('warn'), true);
  // Switch off: no next time.
  const toggle = ui.$('.schedule-item input[role="switch"]');
  assert.equal(toggle.getAttribute('aria-label'), '“Release notes” makes cards');
  toggle.checked = false; toggle.dispatchEvent(new ui.win.Event('change'));
  await until(() => ui.$('.schedule-when')?.textContent.endsWith('· Off'), 'switched off');
  assert.equal(ui.$('.schedules-status').textContent, '“Release notes” is off. It makes no cards until you switch it on.');
  // Delete asks first; Cancel keeps it.
  ui.$$('.schedule-actions button').find(button => button.textContent === 'Delete').click();
  assert.equal(ui.$('.schedule-confirm p').textContent, 'Delete “Release notes”? The cards it made stay on the board.');
  ui.byText('Cancel').click();
  assert.equal(ui.project().schedules.length, 1);
  ui.$$('.schedule-actions button').find(button => button.textContent === 'Delete').click();
  ui.byText('Delete schedule').click();
  await until(() => ui.$('.schedule-empty'), 'deleted');
  assert.equal(ui.project().schedules.length, 0);
  assert.equal(ui.win.document.activeElement.id, 'schedule-new');
  assert.deepEqual(ui.errors, []);
});

test('the repeat reads as words', async t => {
  const { win } = await setup(t);
  const text = win.PromptboardSchedules.repeatText;
  assert.equal(text({ kind: 'daily', time: '02:00' }), 'Every day at 02:00');
  assert.equal(text({ kind: 'weekdays', time: '02:00' }), 'Every weekday at 02:00');
  assert.equal(text({ kind: 'weekly', days: [1], time: '09:00' }), 'Every Monday at 09:00');
  assert.equal(text({ kind: 'weekly', days: [0, 1, 3, 5], time: '09:00' }), 'Every Mon, Wed, Fri and Sun at 09:00', 'Monday first, Sunday last');
  assert.equal(text({ kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time: '07:00' }), 'Every day at 07:00');
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 28].map(day => text({ kind: 'monthly', day, time: '01:00' }).split(' ')[2]), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '28th']);
});
