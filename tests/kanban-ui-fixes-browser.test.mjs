// Kanban UI fixes in a real browser: dialogs and menus that outlive a background board change, board feedback, focus and phone layout.
// Agents are SIMULATED (tests/fixtures/fake-agent.cjs, or a fake runner); the server, routes and page are real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, launch } from './helpers/browser.mjs';
import { startServer } from '../src/server.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const chrome = await findChrome();
const fake = fileURLToPath(new URL('./fixtures/fake-agent.cjs', import.meta.url));
const exceptions = browser => browser.consoleMessages.filter(message => message.startsWith('EXCEPTION'));
const enter = async browser => {
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
};
const escape = browser => browser.key('Escape', 'Escape', 27);
async function open(t, options = {}, size = {}) {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [], ...options });
  const browser = await launch(size); assert.ok(browser); t.after(() => browser.close());
  if (size.width) await browser.resize(size.width, size.height);
  return { app, browser };
}
const linked = async (app, name, extra = {}) => (await app.board.createProjectWithRepository({ name, folder: 'new', ...extra })).project;
const fresh = async (app, id) => (await app.board.state()).projects.flatMap(project => project.tasks).find(task => task.id === id);
// A board change saved elsewhere reaches this page through its 2 s background poll.
const polled = async (app, browser) => browser.until(`board.revision === ${(await app.board.state()).revision}`, 'the poll took the newer board');

test('the Autopilot dialog keeps working after one of its To Do cards is deleted in another window', { skip: !chrome, timeout: 90000 }, async t => {
  const { app, browser } = await open(t);
  const project = await linked(app, 'Autopilot queue');
  await app.board.createTask({ projectId: project.id, title: 'Alpha', prompt: 'a' });
  const bravo = await app.board.createTask({ projectId: project.id, title: 'Bravo', prompt: 'b' });
  await browser.goto(`${app.url}/#/kanban`); await browser.until(`document.querySelector('[data-id="${bravo.id}"]')`, 'cards');
  await browser.eval(`document.querySelector('#autopilot-open').click();`);
  await browser.until(`document.querySelectorAll('#autopilot-queue .autopilot-head input').length === 2`, 'queue');
  await app.board.deleteTask(bravo.id, { expectedRevision: bravo.revision });
  await polled(app, browser);
  await browser.eval(`document.querySelector('#autopilot-queue .autopilot-head input').click();`);
  assert.deepEqual(await browser.eval(`return [...document.querySelectorAll('#autopilot-queue .autopilot-title')].map(node => node.textContent);`), ['Alpha']);
  assert.equal(await browser.eval(`return document.querySelector('#autopilot-queue-note').textContent;`), '0 of 1 To Do cards · top runs first');
  assert.deepEqual(exceptions(browser), []);
});

test('the pipeline Autopilot dialog keeps working after one of its route columns is removed in another window', { skip: !chrome, timeout: 90000 }, async t => {
  const { app, browser } = await open(t);
  const project = await linked(app, 'Autopilot route', { workflowMode: 'pipeline' });
  let current = (await app.board.state()).projects[0];
  const pipeline = structuredClone(current.pipeline);
  pipeline.columns.splice(pipeline.columns.findIndex(column => column.id === 'done'), 0, { id: 'c_polish', name: 'Polish', role: 'active', kind: 'custom', color: 'blue', description: '', strategy: { autoSpawn: true }, automations: { onEnter: [], onExit: [] } });
  await app.board.setPipeline(project.id, { pipeline, expectedRevision: current.revision, confirm: true });
  await app.board.createTask({ projectId: project.id, title: 'One' });
  await browser.goto(`${app.url}/#/kanban`); await browser.until(`document.querySelector('.kanban-card')`, 'card');
  await browser.eval(`document.querySelector('#autopilot-open').click();`);
  await browser.until(`document.querySelector('#autopilot-route input[aria-label="Polish"]')`, 'route with Polish');
  current = (await app.board.state()).projects[0];
  await app.board.setPipeline(project.id, { pipeline: { ...structuredClone(current.pipeline), columns: current.pipeline.columns.filter(column => column.id !== 'c_polish') }, expectedRevision: current.revision, confirm: true });
  await polled(app, browser);
  await browser.eval(`document.querySelector('#autopilot-queue .autopilot-head input').click();`);
  assert.equal(await browser.eval(`return Boolean(document.querySelector('#autopilot-route input[aria-label="Polish"]'));`), false);
  assert.deepEqual(exceptions(browser), []);
});
