// Project memory in a real browser: a merged card's suggestion is approved in its details and shows in Project memory.
// The model is SIMULATED (a fake runner); the server, worker, routes and page are real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const chrome = await findChrome();
const LESSONS = [
  { kind: 'command', text: 'Run the suite with npm test before you finish.', evidence: 'npm test exited 0 on the merged commit.' },
  { kind: 'gotcha', text: 'Prices are integers in cents; format them only in the view.', evidence: 'The review asked to move the rounding.' },
];

test('a merged card’s suggested lesson is approved in its details and then shows in Project memory, on a desktop and a phone', { skip: !chrome, timeout: 180000 }, async t => {
  const calls = [];
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [{ id: 'claude', available: true }], authAdapter: { installed: async () => true, status: async () => ({ state: 'signed-in' }) },
    runner: async call => { calls.push(call); return { text: JSON.stringify(LESSONS) }; } });
  const project = await app.board.createProject({ name: 'Shop', workflowMode: 'pipeline' });
  const card = await app.board.createTask({ projectId: project.id, title: 'Checkout flow', prompt: 'Build checkout.' });
  // Every merge path ends here; the app's own worker then suggests lessons once.
  await app.board.completeTask(card.id, { kind: 'merged', details: { targetBranch: 'main', commits: 2 } });
  for (const end = Date.now() + 15000; ;) {
    const view = await app.board.lessons.view(project.id);
    if (view.jobs[0]?.status === 'done') break;
    if (Date.now() > end) assert.fail(`The suggestion did not finish: ${JSON.stringify(view.jobs)}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.deepEqual([calls.length, calls[0].provider, calls[0].model], [1, 'claude', 'haiku']);
  const browser = await launch({ width: 1440, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('promptboard.kanban.project', ${JSON.stringify(project.id)});` });
  const ev = code => browser.eval(code), wait = (expression, label) => browser.until(expression, label, 15000);
  const shots = async name => { if (!process.env.PB_BROWSER_SHOTS) return; await mkdir(process.env.PB_BROWSER_SHOTS, { recursive: true }); await writeFile(join(process.env.PB_BROWSER_SHOTS, `${name}.png`), await browser.screenshot()); };
  await browser.goto(`${app.url}/#/kanban`);
  await wait(`[...document.querySelectorAll('.kanban-card')].some(item => item.textContent.includes('Checkout flow'))`, 'card on the board');
  await ev(`[...document.querySelectorAll('.kanban-card')].find(item => item.textContent.includes('Checkout flow')).querySelector('.kanban-details').click();`);
  await wait(`document.querySelector('#task-dialog').open && document.querySelectorAll('#task-lessons .lesson').length === 2`, 'two suggestions in the details');
  assert.deepEqual(await ev(`return [...document.querySelectorAll('#task-lessons .lesson-text')].map(node => node.textContent);`), LESSONS.map(item => item.text));
  await shots('lessons-details');
  // Approve the first one with the keyboard (Space on the focused button).
  assert.equal(await ev(`const node = document.querySelector('#task-lessons .lesson-approve'); node.scrollIntoView({ block: 'center' }); node.focus(); return document.activeElement === node;`), true);
  await browser.key(' ', 'Space', 32);
  await wait(`document.querySelectorAll('#task-lessons .lesson').length === 1 && /1 approved lesson from this card/.test(document.querySelector('#task-lessons').textContent)`, 'approved');
  const stored = (await app.board.lessons.view(project.id)).lessons;
  assert.deepEqual(stored.map(item => [item.text, item.status]), [[LESSONS[0].text, 'approved'], [LESSONS[1].text, 'suggested']]);
  // Project memory lists it under its kind, with the switch on.
  await ev(`[...document.querySelectorAll('#task-lessons button')].find(node => node.textContent === 'Open Project memory').click();`);
  await wait(`document.querySelector('#lessons-dialog')?.open && document.querySelector('#lessons-dialog .lessons-list .lesson-text')`, 'Project memory open');
  // Focus starts on Close, as in the other dialogs; the heading, focused only by script, shows no box.
  assert.equal(await ev(`return document.activeElement?.id;`), 'lessons-close');
  assert.equal(await ev(`const heading = document.querySelector('#lessons-heading'); heading.focus(); const style = getComputedStyle(heading).outlineStyle; document.querySelector('#lessons-close').focus(); return style;`), 'none');
  assert.deepEqual(await ev(`return { kinds: [...document.querySelectorAll('#lessons-dialog h4')].map(node => node.textContent), lessons: [...document.querySelectorAll('#lessons-dialog .lesson[data-status="approved"] .lesson-text')].map(node => node.textContent), on: document.querySelector('#lessons-enabled').checked, pending: document.querySelector('.lessons-card-link').textContent };`),
    { kinds: ['Commands that worked'], lessons: [LESSONS[0].text], on: true, pending: '#1 Checkout flow' });
  await shots('lessons-memory');
  // The project settings row says the same, after a reload too.
  await browser.reload();
  await wait(`document.querySelector('#lessons-summary')?.textContent === '1 lesson · 1 new'`, 'settings row');
  // A phone: the dialog fits without sideways scrolling.
  await browser.resize(390, 844);
  await ev(`document.querySelector('#lessons-open').click();`);
  await wait(`document.querySelector('#lessons-dialog')?.open && document.querySelector('#lessons-dialog .lesson-text')`, 'open on a phone');
  assert.equal(await browser.layout(`const box = document.querySelector('#lessons-dialog').getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;`), true);
  await shots('lessons-memory-phone');
  assert.equal(calls.length, 1, 'viewing and approving never call a model');
  assert.deepEqual(browser.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);
});
