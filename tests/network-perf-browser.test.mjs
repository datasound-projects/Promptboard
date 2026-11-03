// Task 14 performance in headless Chrome at suite size (tests/fixtures/network-perf.mjs: 1,100 registrations, 50 published
// teams of 20 agents pinned by one "Org" network, a 1,000-node draft): the agent directory opened cold and a search; the
// collapsed Org graph's first render, expanding and collapsing one team, then five; the 1,000-node graph arranged, saved
// and reloaded with the same positions; the JS heap after garbage collection along the way. Times are measured to the
// second painted frame and logged (t.diagnostic; PB_NETWORK_PERF_LOG=<file> writes JSON); only gross regressions fail.
// The 200-step pipeline is measured by tests/network-pipeline-browser.test.mjs and the 1,000-node pan/zoom by
// tests/network-graph-browser.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';
import { buildGraphs, SIZES, writeOffline } from './fixtures/network-perf.mjs';
import { installFakeClis } from './helpers/network-e2e.mjs';

const chrome = await findChrome();
await installFakeClis([]); // PATH holds only node: the page's provider and sign-in checks find no CLI, so none starts and none is waited for.
const J = JSON.stringify;
const CY = `document.querySelector('#network-canvas')?._cyreg?.cy`;
const frames = 'await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);';

test('Network at size in Chrome: the directory of 1,100 agents, the collapsed Org graph of 50 teams expanded and collapsed, and a 1,000-node graph saved and reloaded', { skip: !chrome, timeout: 300000 }, async t => {
  const sizes = { ...SIZES.suite, segments: 0, pipelineSteps: 200 };
  const app = await startTestServer(t, { port: 0, executor: null });
  await app.board.base.create({ id: 'lead', kind: 'profile', name: 'Lead', configuration: { agent: { provider: 'claude' } } });
  await app.board.base.create({ id: 'scout', kind: 'profile', name: 'Scout', configuration: { agent: { provider: 'codex' } } });
  const { rows } = await writeOffline(app.board.dataDir, sizes, ['lead', 'scout']); // Before anything reads Network.
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = async (path, method = 'GET', body) => { const response = await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: J(body) } : {}) }); const json = await response.json(); assert.ok(response.ok, `${path}: ${J(json)}`); return json; };
  const ids = await buildGraphs(call, rows, sizes);
  const browser = await launch({ width: 1440, height: 1000 }); assert.ok(browser); t.after(() => browser.close());
  const ev = code => browser.eval(code), wait = (expression, label, ms = 30000) => browser.until(expression, label, ms);
  const heap = async () => { await browser.send('HeapProfiler.collectGarbage'); return +((await browser.send('Runtime.getHeapUsage')).usedSize / 2 ** 20).toFixed(1); };
  const numbers = {};

  // Every page load notes, from the start of its navigation, when the directory's rows and the complete 1,000-node canvas were
  // first painted: checked on every frame inside the page (so the test's polling adds nothing), noted two frames later.
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__marks = {}; const seen = {}; const mark = () => {
    const cy = document.querySelector('#network-canvas')?._cyreg?.cy;
    for (const [name, ready] of [['rows', () => document.querySelectorAll('#network-list [data-agent-id]').length >= 20], ['canvas', () => cy && cy.nodes().length === ${sizes.bigGraph}]]) {
      if (seen[name] === undefined && ready()) seen[name] = 0; else if (seen[name] !== undefined && ++seen[name] === 2) __marks[name] = Math.round(performance.now());
    }
    requestAnimationFrame(mark); }; requestAnimationFrame(mark);` });
  // The directory: opened cold (the whole app starts, then the first page of 1,100 agents), then a search typed into the box.
  await browser.goto(`${app.url}/#/network`); await browser.resize(1440, 1000);
  numbers.directoryColdOpenMs = await wait(`window.__marks?.rows`, 'the directory rows');
  numbers.heapStartMB = await heap();
  numbers.directoryRows = await ev(`return document.querySelectorAll('#network-list [data-agent-id]').length;`);
  // How long the page's own requests took (resource timing), to tell server time from drawing time.
  const slowest = () => ev(`const [entry] = performance.getEntriesByType('resource').filter(item => item.name.includes('/api/')).sort((a, b) => b.duration - a.duration); performance.clearResourceTimings(); return entry ? { path: new URL(entry.name).pathname, ms: Math.round(entry.duration) } : null;`);
  numbers.directorySearchMs = await ev(`const input = document.querySelector('#network-search'), t0 = performance.now(); input.value = 'Agent 777'; input.dispatchEvent(new Event('input'));
    for (;;) { await new Promise(requestAnimationFrame); const rows = [...document.querySelectorAll('#network-list [data-agent-id]')]; if (rows.length === 1 && rows[0].textContent.includes('Agent 777')) break; if (performance.now() - t0 > 30000) throw new Error('no search'); } return Math.round(performance.now() - t0);`);
  numbers.directorySlowestRequest = await slowest();

  // The Org graph: 50 teams drawn collapsed (one node each) beside 50 agents; expand one team, collapse it, then expand five.
  const nodeIdOf = index => `n_${index.toString(16).padStart(12, '0')}`;
  numbers.orgFirstRenderMs = await ev(`const t0 = performance.now(); location.hash = '#/network/graph/${ids.orgId}';
    for (;;) { await new Promise(requestAnimationFrame); const cy = ${CY}; if (cy && cy.nodes().length === ${sizes.teams + 50}) break; if (performance.now() - t0 > 30000) throw new Error('no render'); } ${frames} return Math.round(performance.now() - t0);`);
  numbers.heapOrgMB = await heap();
  const toggle = async (index, expected) => ev(`const t0 = performance.now(); document.querySelector('#network-graph-nodes [data-node-id="${nodeIdOf(index)}"]').click(); ${frames}
    document.querySelector('#network-graph-expand').click();
    for (;;) { await new Promise(requestAnimationFrame); if (${CY}.nodes().filter(node => !node.isParent()).length === ${expected}) break; if (performance.now() - t0 > 30000) throw new Error('no toggle to ${expected}'); } ${frames} return Math.round(performance.now() - t0);`);
  const base = sizes.teams + 50, leaves = base - 1 + sizes.teamSize; // An expanded team is a parent box around its 20 agents.
  await wait(`document.querySelector('#network-graph-nodes [data-node-id="${nodeIdOf(1)}"]')`, 'the teams in the side list');
  numbers.expandOneTeamMs = await toggle(1, leaves);
  numbers.collapseOneTeamMs = await toggle(1, base - 1 + 1);
  const fiveTimes = [];
  for (let index = 1; index <= 5; index++) fiveTimes.push(await toggle(index, base + index * (sizes.teamSize - 1)));
  numbers.expandFiveTeamsMs = fiveTimes;
  numbers.orgExpandedNodes = await ev(`return ${CY}.nodes().filter(node => !node.isParent()).length;`);
  numbers.heapOrgFiveExpandedMB = await heap();
  numbers.orgSlowestRequest = await slowest();
  assert.equal(numbers.orgExpandedNodes, base + 5 * (sizes.teamSize - 1));

  // The 1,000-node draft: first render, arrange in layers (every position changes), save, reload: the same positions come back.
  numbers.bigFirstRenderMs = await ev(`const t0 = performance.now(); location.hash = '#/network/graph/${ids.bigId}';
    for (;;) { await new Promise(requestAnimationFrame); const cy = ${CY}; if (cy && cy.nodes().length === ${sizes.bigGraph} && cy.edges().length === ${sizes.bigGraph - 1}) break; if (performance.now() - t0 > 30000) throw new Error('no render'); } ${frames} return Math.round(performance.now() - t0);`);
  numbers.heapBigMB = await heap();
  const revision = (await call(`/api/network/networks/${ids.bigId}`)).network.revision;
  numbers.arrangeMs = await ev(`const t0 = performance.now(); document.querySelector('#network-graph-layered').click(); for (;;) { await new Promise(requestAnimationFrame); if (document.querySelector('#network-graph-dirty')) break; if (performance.now() - t0 > 30000) throw new Error('no arrange'); } ${frames} return Math.round(performance.now() - t0);`);
  numbers.saveMs = await ev(`const t0 = performance.now(); document.querySelector('#network-graph-save').click(); for (;;) { await new Promise(requestAnimationFrame); if (!document.querySelector('#network-graph-dirty') && document.querySelector('#network-graph-save').disabled) break; if (performance.now() - t0 > 30000) throw new Error('no save'); } return Math.round(performance.now() - t0);`);
  const saved = (await call(`/api/network/networks/${ids.bigId}`)).network;
  assert.equal(saved.revision, revision + 1, 'one save');
  const canvas = await ev(`return Object.fromEntries(${CY}.nodes().map(node => [node.id(), { x: Math.round(node.position('x')), y: Math.round(node.position('y')) }]));`);
  assert.deepEqual(Object.fromEntries(saved.nodes.map(node => [node.id, node.position])), canvas, 'the server holds what the canvas showed');
  await browser.reload();
  numbers.reloadMs = await wait(`window.__marks?.canvas`, 'the big graph after a reload');
  const reloaded = await ev(`return Object.fromEntries(${CY}.nodes().map(node => [node.id(), { x: Math.round(node.position('x')), y: Math.round(node.position('y')) }]));`);
  assert.deepEqual(reloaded, canvas, 'the reload draws the saved positions');
  numbers.heapAfterReloadMB = await heap();
  numbers.bigSlowestRequest = await slowest();

  numbers.loadAverage = loadavg().map(value => +value.toFixed(1)); // Other work on the machine slows every number above.
  t.diagnostic(`Network at size in Chrome: ${J(numbers)}`);
  if (process.env.PB_NETWORK_PERF_LOG) await writeFile(process.env.PB_NETWORK_PERF_LOG, `${J(numbers, null, 1)}\n`);
  // Gross regressions only: the canvas is drawn in software, and a loaded machine (other suites, other Chromes) stretched single
  // steps past 20 s while the same steps took under 0.9 s at a load average of 8 (docs/network/performance.md has the numbers).
  for (const [name, value] of Object.entries(numbers)) if (/Ms$/.test(name)) for (const ms of [value].flat()) assert.ok(ms < 60000, `${name}: ${ms} ms`);
  assert.ok(numbers.heapAfterReloadMB < 400, `heap ${numbers.heapAfterReloadMB} MB`);
  assert.deepEqual(browser.consoleMessages.filter(message => /EXCEPTION|Uncaught|Content Security Policy|Refused/i.test(message)), []);
});
