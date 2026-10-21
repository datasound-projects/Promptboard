import test from 'node:test';
import assert from 'node:assert/strict';
import { findChrome, launch } from './helpers/browser.mjs';
import { pickProject } from './helpers/projects.mjs';
import { startTestServer } from './helpers/test-server.mjs';

// The words the page shows, in this computer's time zone (the browser and the server share it here).
const when = at => new Date(at).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

test('a schedule made in the Schedules dialog shows its next time, and Run now puts a Scheduled card in To Do, at both widths and in both themes', { skip: !await findChrome(), timeout: 90000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const project = await app.board.createProject({ name: 'Nightly jobs', workflowMode: 'pipeline' });
  const browser = await launch(); if (!browser) { t.skip('Chrome did not start.'); return; } t.after(() => browser.close());
  await browser.goto(`${app.url}/#/kanban`);
  await browser.until(`document.querySelector('#workspace-list [data-project-id="${project.id}"]')`, 'project listed');
  await browser.eval(pickProject(project.id));
  await browser.until(`!document.getElementById('schedules-open').disabled && !document.getElementById('schedules-open').hidden`, 'Schedules button');

  // Board actions → Schedules → a quick start → Save.
  await browser.eval(`document.getElementById('schedules-open').click();`);
  await browser.until(`document.getElementById('schedules-dialog').open && document.querySelector('.schedule-quick')`, 'empty list with quick starts');
  await browser.eval(`[...document.querySelectorAll('.schedule-quick button')].find(button => button.textContent === 'Weekly docs sweep').click();`);
  await browser.until(`document.activeElement.id === 'schedule-title' && document.getElementById('schedule-title').value === 'Weekly docs sweep'`, 'editor prefilled');
  await browser.eval(`const time = document.getElementById('schedule-time'); time.value = '07:15'; time.dispatchEvent(new Event('input', { bubbles: true }));`);
  await browser.eval(`document.getElementById('schedule-save').click();`);
  await browser.until(`document.querySelector('.schedule-item .schedule-when')`, 'saved');
  const [saved] = (await app.board.schedules.list(project.id)).schedules;
  assert.deepEqual([saved.cadence, new Date(saved.next).getDay(), new Date(saved.next).getHours(), new Date(saved.next).getMinutes()], [{ kind: 'weekly', days: [1], time: '07:15' }, 1, 7, 15]);
  assert.equal(await browser.eval(`return document.querySelector('.schedule-when').textContent;`), `Every Monday at 07:15 · Next ${when(saved.next)}`);
  assert.equal(await browser.eval(`return document.querySelector('.schedules-status').textContent;`), `“Weekly docs sweep” saved. Its next card comes ${when(saved.next)}.`);

  // Run now: the card lands in To Do with the Scheduled marker, and its details say which schedule made it.
  await browser.eval(`document.getElementById('schedule-run-${saved.id}').click();`);
  await browser.until(`document.querySelector('.schedule-last')?.textContent === 'Created #1'`, 'card made');
  const card = (await app.board.state()).projects[0].tasks[0];
  assert.equal(card.scheduleId, saved.id);
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    await browser.resize(width, 900);
    await browser.eval(`document.documentElement.dataset.theme = ${JSON.stringify(theme)};`);
    assert.equal(await browser.layout(`const d = document.getElementById('schedules-dialog').getBoundingClientRect(), item = document.querySelector('.schedule-item');
      return d.left >= -1 && d.right <= innerWidth + 1 && item.scrollWidth <= item.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth;`), true, `${width} ${theme}`);
  }
  await browser.key('Escape', 'Escape', 27);
  await browser.until(`!document.getElementById('schedules-dialog').open`, 'dialog closed');
  await browser.until(`document.querySelector('[data-id="${card.id}"] .schedule-tag')?.textContent === 'Scheduled'`, 'marker on the card');
  await browser.eval(`openTaskDetails(${JSON.stringify(card.id)});`);
  await browser.until(`document.getElementById('task-dialog').open`, 'details');
  assert.equal(await browser.eval(`return [...document.querySelectorAll('#task-details section')].find(section => section.querySelector('h3').textContent === 'Scheduled')?.querySelector('p').textContent;`),
    `Made by the schedule “Weekly docs sweep”, for ${when(card.scheduledFor)}.`);
  assert.equal((await app.board.state()).runs.length, 0, 'nothing ran');
  assert.deepEqual(browser.consoleMessages.filter(message => message.startsWith('EXCEPTION')), []);
});
