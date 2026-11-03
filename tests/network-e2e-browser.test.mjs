// Task 14: the key Network path in headless Chrome, driven by the mouse and the keyboard only (every click is a real
// pointer event at the control's centre, after checking nothing covers it), against the real app with its default local
// job worker on the fake headless CLIs (the only programs on PATH besides node): the pipeline designer from the template,
// a step dragged on the canvas, save, publish, the run confirmation with typed input, the live run view, a page reload
// and an app restart while the approval waits, approve from the run canvas, and the saved report shown in the page.
// One job and one CLI run per agent step, one report. No real CLI, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.mjs';
import { findChrome, launch } from './helpers/browser.mjs';
import { installFakeClis, skipFakes, tick } from './helpers/network-e2e.mjs';

const chrome = await findChrome();
const fakes = await installFakeClis(['claude']);
const J = JSON.stringify;
const PCY = `document.querySelector('#network-pipeline-canvas')?._cyreg?.cy`, RCY = `document.querySelector('#network-run-canvas')?._cyreg?.cy`;
const pad = n => String(n).padStart(12, '0');

test('Network by mouse in Chrome on the real worker: template → drag → save → publish → run → reload and restart while the approval waits → approve on the canvas → the report; one job per step', { skip: !chrome || skipFakes, timeout: 300000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-network-e2e-browser-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  let app = null;
  const boot = async () => { app = await startServer({ port: 0, dataDir, executor: null, catalogReader: async provider => ({ provider, source: 'test fixture', models: [] }) }); }; // networkWorker unset: the real worker
  t.after(() => app?.close());
  await boot();
  const token = async () => (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = async (path, method = 'GET', body) => { const response = await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': await token(), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: J(body) } : {}) }); return response.json(); };
  // Three Claude agents in the published network "Desk" (seeded through the API; the e2e API test creates them over HTTP).
  const agents = [];
  for (const [index, name] of ['Scout', 'Analyst', 'Editor'].entries()) {
    await app.board.base.create({ id: `b${index}`, kind: 'profile', name, configuration: { agent: { provider: 'claude', model: 'haiku' } } });
    agents.push((await call('/api/network/agents', 'POST', { baseResourceId: `b${index}`, expectedRevision: index })).agent);
  }
  const { network } = await call('/api/network/networks', 'POST', { name: 'Desk', nodes: agents.map((agent, i) => ({ id: `n_${pad(i + 1)}`, type: 'agent', agentId: agent.id, position: { x: i * 220, y: 0 } })), edges: [] });
  await call(`/api/network/networks/${network.id}/publish`, 'POST', { expectedRevision: 1 });

  let browser = await launch({ width: 1440, height: 1000 }); assert.ok(browser); t.after(() => browser.close());
  const ev = code => browser.eval(code), wait = (expression, label, ms = 30000) => browser.until(expression, label, ms);
  const mouse = (type, { x, y }, buttons = 0) => browser.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
  /** A real click at the centre of `selector`, once it is visible and the topmost element there. */
  async function press(selector) {
    await wait(`(() => { const node = document.querySelector(${J(selector)}); return node && !node.disabled && node.getClientRects().length > 0; })()`, `${selector} is shown and enabled`);
    const at = await ev(`const node = document.querySelector(${J(selector)}); node.scrollIntoView({ block: 'center', inline: 'center' }); await new Promise(requestAnimationFrame);
      const box = node.getBoundingClientRect(), x = Math.round(box.left + box.width / 2), y = Math.round(box.top + box.height / 2), top = document.elementFromPoint(x, y);
      return { x, y, top: Boolean(top && (top === node || node.contains(top))), what: top ? top.id || top.className || top.tagName : null };`);
    assert.ok(at.top, `${selector} is not covered (found ${at.what})`);
    await browser.click(at.x, at.y);
  }
  const point = (cy, id) => ev(`const cy = ${cy}; cy.resize(); const box = cy.container().getBoundingClientRect(), at = cy.getElementById(${J(id)}).renderedPosition(); return { x: Math.round(box.left + at.x), y: Math.round(box.top + at.y) };`);
  const tap = async (cy, id) => { const at = await point(cy, id); await mouse('mousePressed', at, 1); await mouse('mouseReleased', at); };

  // The designer: New from template (the MVP shape), by mouse.
  await browser.goto(`${app.url}/#/network/pipelines`); await browser.resize(1440, 1000);
  await press('#network-pipelines-template');
  await wait(`document.querySelector('#network-template-review')?.value === ${J(agents[2].id)}`, 'template dialog with its agents');
  await press('#network-pipeline-form-submit');
  await wait(`document.querySelector('#network-pipeline-heading')?.textContent === 'Research report' && ${PCY}?.nodes().length === 6`, 'designer canvas');
  const pipelineId = await ev(`return location.hash.split('/')[3];`);
  const ids = Object.fromEntries((await call(`/api/network/pipelines/${pipelineId}`)).pipeline.nodes.map(node => [node.label, node.id]));
  // Drag the reviewer down on the canvas, then Save by mouse: the new position is what the server keeps.
  await ev(`document.querySelector('#network-pipeline-canvas').scrollIntoView({ block: 'center' });`);
  const from = await point(PCY, ids.Reviewer);
  await mouse('mousePressed', from, 1);
  for (let step = 1; step <= 6; step++) await mouse('mouseMoved', { x: from.x + (30 * step) / 6, y: from.y + (90 * step) / 6 }, 1);
  await mouse('mouseReleased', { x: from.x + 30, y: from.y + 90 });
  await wait(`document.querySelector('#network-pipeline-dirty')`, 'unsaved after the drag');
  await press('#network-pipeline-save');
  await wait(`!document.querySelector('#network-pipeline-dirty') && document.querySelector('#network-pipeline-save').disabled`, 'saved');
  const dragged = await ev(`const at = ${PCY}.getElementById(${J(ids.Reviewer)}).position(); return { x: Math.round(at.x), y: Math.round(at.y) };`);
  assert.deepEqual((await call(`/api/network/pipelines/${pipelineId}`)).pipeline.nodes.find(node => node.id === ids.Reviewer).position, dragged);

  // Publish by mouse (the dialog's confirm button), then Run: type the input, start.
  await press('#network-pipeline-publish');
  await wait(`document.querySelector('#network-dialog-heading')?.textContent === 'Publish version 1?'`, 'publish dialog');
  await press('#network-confirm');
  await wait(`/Version 1 latest/.test(document.querySelector('#network-pipeline-meta').textContent)`, 'published');
  assert.deepEqual([(await call('/api/network/jobs')).total, (await fakes.runs()).length], [0, 0], 'saving and publishing ran nothing');
  await press('#network-pipeline-run');
  await wait(`document.querySelector('#network-run-start') && !document.querySelector('#network-run-start').disabled`, 'run confirmation');
  assert.match(await ev(`return document.querySelector('#network-run-facts').textContent;`), /CostNot enforced/);
  await press('#network-run-input');
  await browser.type('Cargo bikes in cities.');
  assert.equal(await ev(`return document.querySelector('#network-run-input').value;`), 'Cargo bikes in cities.');
  await press('#network-run-start');
  await wait(`/^#\\/network\\/runs\\/run_/.test(location.hash) && ${RCY}?.nodes().length === 6`, 'run view');
  const runId = await ev(`return location.hash.split('/')[3];`);
  const waiting = `${RCY}?.getElementById(${J(ids['Your approval'])}).hasClass('s-waiting_for_approval') && ${RCY}.getElementById(${J(ids.Reviewer)}).hasClass('s-completed') && document.querySelector('#network-run-status')?.textContent === 'Waiting for your approval'`;
  await wait(waiting, 'the run view shows the steps done and the approval waiting', 60000);

  // Reload the page: the same states come back from the server. Restart the app: still waiting, nothing ran again.
  await browser.reload();
  await wait(waiting, 'after a reload');
  await browser.close().catch(() => {}); // The page's stream ends with the app; a fresh browser opens the restarted one.
  await app.close(); app = null;
  await boot();
  const before = browser.consoleMessages;
  browser = await launch({ width: 1440, height: 1000 }); assert.ok(browser);
  await browser.goto(`${app.url}/#/network/runs/${runId}`); await browser.resize(1440, 1000);
  await wait(waiting, 'after the app restarted');
  await tick(2500); // More than two passes of the runner.
  assert.deepEqual([(await call(`/api/network/jobs?pipelineRunId=${runId}`)).total, (await fakes.runs()).length], [3, 3], 'nothing ran again');

  // Approve on the run canvas, by mouse: the approval step, then its Approve button.
  await ev(`document.querySelector('#network-run-canvas').scrollIntoView({ block: 'center' });`);
  await tap(RCY, ids['Your approval']);
  await press('#network-run-approve');
  await wait(`document.querySelector('#network-run-status')?.textContent === 'Completed' && ${RCY}.getElementById(${J(ids.Report)}).hasClass('s-completed')`, 'completed', 60000);
  await ev(`document.querySelector('#network-run-canvas').scrollIntoView({ block: 'center' });`);
  await tap(RCY, ids.Report);
  await press('#network-run-show-report');
  await wait(`document.querySelector('#network-run-report')`, 'the report in the page');
  const reportDir = join(dataDir, 'network', 'pipeline-runs', `run__${runId.slice(4)}`, 'reports');
  const report = await readFile(join(reportDir, 'report.md'), 'utf8');
  assert.match(report, /^# Research report\n\n## Research A\n\nAnswer from claude\.\n/);
  const shown = await ev(`return document.querySelector('#network-run-report').textContent;`);
  for (const section of ['Research A', 'Research B', 'Reviewer']) assert.ok(shown.includes(section), `the page shows ${section}`);
  assert.ok(shown.includes('Answer from claude.'));
  // One job and one CLI run per agent step, each completed with one attempt; one report; the run's history is exact.
  const jobs = (await call(`/api/network/jobs?pipelineRunId=${runId}`)).jobs;
  assert.deepEqual([jobs.length, jobs.every(job => job.status === 'completed' && job.attempts.length === 1), (await fakes.runs()).length], [3, true, 3]);
  assert.deepEqual(await readdir(reportDir), ['report.md']);
  assert.deepEqual((await call(`/api/network/pipeline-runs/${runId}`)).run.history.map(entry => entry.status), ['running', 'waiting_for_approval', 'running', 'completed']);
  assert.deepEqual([...before, ...browser.consoleMessages].filter(message => /EXCEPTION|Uncaught|Content Security Policy|Refused/i.test(message)), []);
});
