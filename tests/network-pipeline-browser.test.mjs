// Network → Pipelines in headless Chrome with the real Cytoscape canvas under the unchanged CSP and the deterministic fake
// job worker behind the real server: the MVP pipeline built from the template, a step dragged and an arrow connected by
// mouse, Validate (valid and refused) without moving the canvas, publish, the run confirmation, the live run view, approve
// from the step, the saved report; step shapes and execution arrows that differ from Graph's dashed relations; light and
// dark at 1440 px and the ordered list → one step at 390 px. The second test measures a 200-step pipeline.
// PB_NETWORK_SCREENSHOTS=<folder> saves the screenshots; PB_NETWORK_PERF_LOG=<file> saves the measurements as JSON.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';
import { fakeWorker } from './helpers/network-worker.mjs';

const chrome = await findChrome();
const J = JSON.stringify;
const PCY = `document.querySelector('#network-pipeline-canvas')?._cyreg?.cy`, RCY = `document.querySelector('#network-run-canvas')?._cyreg?.cy`, GCY = `document.querySelector('#network-canvas')?._cyreg?.cy`;
const pad = n => String(n).padStart(12, '0');

async function open(t, app) {
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = async (path, method = 'GET', body) => { const response = await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: J(body) } : {}) }); return response.json(); };
  const browser = await launch({ width: 1440, height: 1000 }); assert.ok(browser); t.after(() => browser.close());
  const ev = code => browser.eval(code), wait = (expression, label, ms = 25000) => browser.until(expression, label, ms);
  const shots = process.env.PB_NETWORK_SCREENSHOTS;
  const shot = async name => { if (shots) { await mkdir(shots, { recursive: true }); await writeFile(join(shots, `${name}.png`), await browser.screenshot()); } };
  // resize() first: Cytoscape caches where its container is on the page and refreshes that only some time after a scroll.
  const point = (cy, id) => ev(`const cy = ${cy}; cy.resize(); const box = cy.container().getBoundingClientRect(), at = cy.getElementById(${J(id)}).renderedPosition(); return { x: Math.round(box.left + at.x), y: Math.round(box.top + at.y) };`);
  const mouse = (type, { x, y }, buttons = 0) => browser.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
  async function drag(cy, id, dx, dy) {
    const from = await point(cy, id);
    await mouse('mousePressed', from, 1);
    for (let step = 1; step <= 6; step++) await mouse('mouseMoved', { x: from.x + (dx * step) / 6, y: from.y + (dy * step) / 6 }, 1);
    await mouse('mouseReleased', { x: from.x + dx, y: from.y + dy });
  }
  const tap = async (cy, id) => { const at = await point(cy, id); await mouse('mousePressed', at, 1); await mouse('mouseReleased', at); };
  return { call, browser, ev, wait, shot, drag, tap };
}
/** Three Claude agents in the network “Desk” (with one share_result relation), published as version 1. */
async function seed(app, call) {
  const agents = [];
  for (const [index, name] of ['Scout', 'Analyst', 'Editor'].entries()) {
    await app.board.base.create({ id: `b${index}`, kind: 'profile', name, configuration: { agent: { provider: 'claude' } } });
    agents.push((await call('/api/network/agents', 'POST', { baseResourceId: `b${index}`, expectedRevision: index })).agent);
  }
  const { network } = await call('/api/network/networks', 'POST', { name: 'Desk', nodes: agents.map((agent, i) => ({ id: `n_${pad(i + 1)}`, type: 'agent', agentId: agent.id, position: { x: i * 220, y: 0 } })),
    edges: [{ id: `e_${pad(1)}`, from: `n_${pad(1)}`, to: `n_${pad(3)}`, relation: 'share_result' }] });
  await call(`/api/network/networks/${network.id}/publish`, 'POST', { expectedRevision: 1 });
  return { agents, network };
}

test('Pipelines in Chrome: the MVP from the template, drag and connect by mouse, validate without moving the canvas, publish, run with the fake worker, approve, the report; Graph and Pipeline edges differ; both themes at 1440 and 390 px', { skip: !chrome, timeout: 300000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, networkWorker: fakeWorker({ text: job => `Done: ${job.request.instructions.split('.')[0]}.` }) });
  const { call, browser, ev, wait, shot, drag, tap } = await open(t, app);
  const { agents, network } = await seed(app, call);
  const noSideways = `document.documentElement.scrollWidth <= document.documentElement.clientWidth`;
  await browser.goto(`${app.url}/#/network/graph/${network.id}`);
  await ev(`localStorage.setItem('ste-prompt-engineer.theme', 'light');`); await browser.reload(); await browser.resize(1440, 1000);

  // Graph: relations are dashed curves named by their type, and the page says they are not execution order.
  await wait(`${GCY}?.edges().length === 1`, 'graph canvas');
  const relation = await ev(`const edge = ${GCY}.edges()[0]; return { line: edge.style('line-style'), curve: edge.style('curve-style'), label: edge.style('label'), relation: edge.data('relation'), port: edge.data('port') ?? null };`);
  assert.deepEqual(relation, { line: 'dashed', curve: 'bezier', label: 'Share result', relation: 'share_result', port: null });
  assert.match(await ev(`return document.querySelector('#network-graph-inert').textContent;`), /Relations are permissions and intent, not execution order/);

  // Pipelines: the template becomes a draft on the canvas, with a shape per step type and solid arrows labelled by port.
  await ev(`location.hash = '#/network/pipelines';`); await wait(`document.querySelector('#network-pipelines-template') && !document.querySelector('#network-panel-pipelines').hidden`, 'pipelines');
  await shot('pipelines-list-1440-light-empty');
  await ev(`document.querySelector('#network-pipelines-template').click();`);
  await wait(`document.querySelector('#network-template-review')?.value === ${J(agents[2].id)}`, 'template dialog');
  await shot('pipelines-template-1440-light');
  await ev(`document.querySelector('#network-pipeline-form-submit').click();`);
  await wait(`document.querySelector('#network-pipeline-heading')?.textContent === 'Research report' && ${PCY}?.nodes().length === 6 && ${PCY}.edges().length === 6`, 'designer canvas');
  const pipelineId = await ev(`return location.hash.split('/')[3];`);
  assert.match(await ev(`return document.querySelector('#network-pipeline-semantics').textContent;`), /arrows are execution order.*not Graph relations, which record permissions and intent and never move data/);
  const shapes = await ev(`return Object.fromEntries(${PCY}.nodes().map(node => [node.data('type'), node.style('shape')]));`);
  assert.deepEqual(shapes, { agent: 'rectangle', join: 'hexagon', approval: 'octagon', output: 'cut-rectangle' });
  const arrows = await ev(`return ${PCY}.edges().map(edge => ({ line: edge.style('line-style'), curve: edge.style('curve-style'), arrow: edge.style('target-arrow-shape'), label: edge.style('label'), port: edge.data('port'), relation: edge.data('relation') ?? null }));`);
  assert.ok(arrows.every(edge => edge.line === 'solid' && edge.curve === 'taxi' && edge.arrow === 'triangle-backcurve' && edge.label === edge.port && edge.relation === null), J(arrows));
  assert.deepEqual([...new Set(arrows.map(edge => edge.port))].sort(), ['done', 'text']);
  await ev(`document.querySelector('#network-pipeline-canvas').scrollIntoView({ block: 'center' });`);
  await shot('pipeline-designer-1440-light');

  // Drag a step and connect a new Parallel step to Research A by canvas taps; the save keeps both.
  const ids = Object.fromEntries((await call(`/api/network/pipelines/${pipelineId}`)).pipeline.nodes.map(node => [node.label, node.id]));
  const before = await ev(`return ${PCY}.getElementById(${J(ids.Reviewer)}).position();`);
  await drag(PCY, ids.Reviewer, 40, 110);
  await wait(`(() => { const at = ${PCY}.getElementById(${J(ids.Reviewer)}).position(); return Math.abs(at.y - ${before.y}) > 30; })() && document.querySelector('#network-pipeline-dirty')`, 'dragged');
  await ev(`document.querySelector('#network-pipeline-add-parallel').click();`);
  await wait(`${PCY}.nodes().length === 7 && document.querySelector('#network-pipeline-detail-heading')?.textContent === 'Parallel'`, 'parallel added');
  const parallel = await ev(`return ${PCY}.nodes().filter(node => node.data('type') === 'parallel')[0].id();`);
  await ev(`${PCY}.fit(undefined, 60);`);
  await ev(`document.querySelector('#network-pipeline-connect').click();`);
  await wait(`document.querySelector('#network-pipeline-connect').getAttribute('aria-pressed') === 'true'`, 'connect mode');
  await tap(PCY, parallel); await wait(`!document.querySelector('#network-pipeline-port').closest('label').hidden && document.querySelector('#network-pipeline-port').value === 'done'`, 'source chosen with its port');
  await tap(PCY, ids['Research A']);
  await wait(`${PCY}.edges().some(edge => edge.data('source') === ${J(parallel)} && edge.data('target') === ${J(ids['Research A'])} && edge.data('port') === 'done')`, 'connected by taps');
  await ev(`document.querySelector('#network-pipeline-save').click();`);
  await wait(`!document.querySelector('#network-pipeline-dirty') && document.querySelector('#network-pipeline-save').disabled`, 'saved');
  const saved = (await call(`/api/network/pipelines/${pipelineId}`)).pipeline;
  const canvasReviewer = await ev(`const at = ${PCY}.getElementById(${J(ids.Reviewer)}).position(); return { x: Math.round(at.x), y: Math.round(at.y) };`);
  assert.deepEqual(saved.nodes.find(node => node.id === ids.Reviewer).position, canvasReviewer, 'the dragged position was saved');
  assert.ok(saved.edges.some(edge => edge.from === parallel && edge.to === ids['Research A'] && edge.fromPort === 'done'));

  // Validate, valid and refused: the canvas never moves; the refusal marks the step on the canvas and in the side panel.
  const canvasTop = `Math.round(document.querySelector('#network-pipeline-canvas').getBoundingClientRect().top + scrollY)`;
  const top = await ev(`return ${canvasTop};`);
  await ev(`document.querySelector('#network-pipeline-validate').click();`); await wait(`document.querySelector('#network-pipeline-valid')`, 'valid');
  assert.equal(await browser.layout(`return ${canvasTop};`, top), top, 'Validate (valid) did not move the canvas');
  await call(`/api/network/agents/${agents[1].id}`, 'PATCH', { expectedRevision: agents[1].revision, enabled: false });
  await ev(`document.querySelector('#network-pipeline-validate').click();`); await wait(`document.querySelector('#network-pipeline-invalid')`, 'refused');
  assert.equal(await browser.layout(`return ${canvasTop};`, top), top, 'a refusal did not move the canvas');
  assert.equal(await ev(`return ${PCY}.getElementById(${J(ids['Research B'])}).hasClass('problem');`), true, 'the refused step is marked on the canvas');
  assert.equal(await ev(`return ${PCY}.getElementById(${J(ids['Research B'])}).style('border-color');`), await ev(`return ${PCY}.nodes().filter(node => node.hasClass('problem'))[0].style('border-color');`));
  await ev(`document.querySelector('#network-pipeline-check').scrollIntoView({ block: 'center' });`);
  await shot('pipeline-validate-refused-1440-light');
  await call(`/api/network/agents/${agents[1].id}`, 'PATCH', { expectedRevision: agents[1].revision + 1, enabled: true });

  // Publish, then the run confirmation, then the live run view.
  await ev(`window.scrollTo(0, 0); document.querySelector('#network-pipeline-publish').click();`); await wait(`document.querySelector('#network-dialog-heading')?.textContent === 'Publish version 1?'`, 'publish dialog');
  await shot('pipeline-publish-1440-light');
  await ev(`document.querySelector('#network-confirm').click();`); await wait(`/Version 1 latest/.test(document.querySelector('#network-pipeline-meta').textContent)`, 'published');
  assert.equal((await call('/api/network/jobs')).total, 0, 'nothing ran before the run');
  await ev(`document.querySelector('#network-pipeline-run').click();`); await wait(`document.querySelector('#network-run-start') && !document.querySelector('#network-run-start').disabled`, 'run confirmation');
  assert.match(await ev(`return document.querySelector('#network-run-facts').textContent;`), /CostNot enforced, and unknown before it runs/);
  await ev(`document.querySelector('#network-run-input').value = 'Cargo bikes in cities.';`);
  await shot('pipeline-run-confirm-1440-light');
  await ev(`document.querySelector('#network-run-start').click();`);
  await wait(`/^#\\/network\\/runs\\/run_/.test(location.hash) && ${RCY}?.nodes().length === 7`, 'run view canvas');
  const runId = await ev(`return location.hash.split('/')[3];`);
  await wait(`${RCY}.getElementById(${J(ids['Your approval'])}).hasClass('s-waiting_for_approval') && ${RCY}.getElementById(${J(ids.Reviewer)}).hasClass('s-completed')`, 'live states on the canvas');
  assert.equal(await ev(`return ${RCY}.getElementById(${J(ids.Report)}).style('shape');`), 'cut-rectangle');
  const runTop = `Math.round(document.querySelector('#network-run-canvas').getBoundingClientRect().top + scrollY)`, runCanvasTop = await ev(`return ${runTop};`);
  await shot('run-waiting-1440-light');
  // Approve from the step (a click on its canvas node, then its button), then the report.
  await tap(RCY, ids['Your approval']);
  await wait(`document.querySelector('#network-run-approve')`, 'approval details');
  await shot('run-approval-1440-light');
  await ev(`document.querySelector('#network-run-approve').click();`);
  await wait(`document.querySelector('#network-run-status')?.textContent === 'Completed' && ${RCY}.getElementById(${J(ids.Report)}).hasClass('s-completed')`, 'completed');
  assert.equal(await browser.layout(`return ${runTop};`, runCanvasTop), runCanvasTop, 'live updates did not move the run canvas');
  await tap(RCY, ids.Report); await wait(`document.querySelector('#network-run-show-report')`, 'report step');
  await ev(`document.querySelector('#network-run-show-report').click();`); await wait(`document.querySelector('#network-run-report')`, 'report');
  const report = await readFile(join(app.board.dataDir, 'network', 'pipeline-runs', `run__${runId.slice(4)}`, 'reports', 'report.md'), 'utf8');
  assert.match(report, /^# Research report\n\n## Research A\n\nDone: Research the topic in the run input\./);
  assert.match(await ev(`return document.querySelector('#network-run-report').textContent;`), /Done: Review both research results/);
  await ev(`document.querySelector('#network-run-report').scrollIntoView({ block: 'center' });`);
  await shot('run-report-1440-light');

  // Both themes at 1440 (canvas beside the lists) and 390 px (the ordered steps, then one step; never a canvas).
  const colors = {};
  for (const theme of ['light', 'dark']) {
    await ev(`localStorage.setItem('ste-prompt-engineer.theme', ${J(theme)}); location.hash = '#/network/runs/${runId}';`); await browser.resize(1440, 1000); await browser.reload();
    await wait(`${RCY}?.nodes().length === 7 && document.querySelector('#network-run-status')?.textContent === 'Completed'`, `${theme} run view`);
    assert.equal(await browser.layout(`const canvas = document.querySelector('#network-run-canvas').getBoundingClientRect(), side = document.querySelector('#network-run-view .network-graph-side').getBoundingClientRect(); return ${noSideways} && canvas.width > 600 && side.left >= canvas.right;`), true, `${theme}: run canvas beside the steps`);
    colors[theme] = await ev(`return ${RCY}.nodes()[0].style('background-color');`);
    await shot(`run-1440-${theme}`);
    await ev(`location.hash = '#/network/pipelines/${pipelineId}';`); await wait(`${PCY}?.nodes().length === 7`, `${theme} designer`);
    await shot(`pipeline-designer-1440-${theme}`);
    await ev(`location.hash = '#/network/pipelines';`); await wait(`document.querySelectorAll('#network-pipelines-list [data-pipeline-id]').length === 1 && document.querySelector('#network-pipelines-runs [data-run-id]')`, `${theme} list`);
    await shot(`pipelines-list-1440-${theme}`);
    await browser.resize(390, 844);
    await ev(`location.hash = '#/network/runs/${runId}';`);
    await wait(`document.querySelectorAll('#network-run-steps [data-step-id]').length === 7 && document.querySelector('#network-run-status')?.textContent === 'Completed'`, `${theme} run at 390`);
    assert.equal(await browser.layout(`return ${noSideways} && !(${RCY}) && getComputedStyle(document.querySelector('#network-run-view .network-canvas-box')).display === 'none' && getComputedStyle(document.querySelector('#network-run-details')).display === 'none';`), true, `${theme}: ordered steps, no canvas at 390`);
    await shot(`run-390-${theme}-list`);
    const row = await ev(`const node = document.querySelector('#network-run-steps [data-step-id="${ids['Your approval']}"]'); node.scrollIntoView({ block: 'center' }); const r = node.getBoundingClientRect(); return { x: r.left + 40, y: r.top + 15 };`);
    await browser.click(row.x, row.y);
    await wait(`document.activeElement?.id === 'network-run-detail-heading' && document.querySelector('#network-panel-pipelines').dataset.view === 'detail'`, `${theme}: one step at 390`);
    assert.equal(await browser.layout(`return ${noSideways} && getComputedStyle(document.querySelector('#network-run-view .network-graph-lists')).display === 'none';`), true);
    await shot(`run-390-${theme}-detail`);
    await ev(`document.querySelector('#network-run-back').click();`); await wait(`document.activeElement?.dataset.stepId === ${J(ids['Your approval'])}`, 'back to the row');
    await ev(`location.hash = '#/network/pipelines/${pipelineId}';`);
    await wait(`document.querySelectorAll('#network-pipeline-steps [data-step-id]').length === 7`, `${theme} designer at 390`);
    assert.equal(await browser.layout(`return ${noSideways} && !(${PCY}) && getComputedStyle(document.querySelector('#network-pipeline-designer .network-canvas-box')).display === 'none';`), true, `${theme}: designer list at 390`);
    await shot(`pipeline-390-${theme}-list`);
    await ev(`document.querySelector('#network-pipeline-steps [data-step-id="${ids.Reviewer}"]').click();`);
    await wait(`document.activeElement?.id === 'network-pipeline-detail-heading'`, 'one step');
    assert.equal(await browser.layout(`return ${noSideways} && document.querySelector('#network-pipeline-connect-add').getBoundingClientRect().right <= innerWidth;`), true);
    await shot(`pipeline-390-${theme}-detail`);
    await ev(`document.querySelector('#network-pipeline-back').click();`);
  }
  assert.notEqual(colors.light, colors.dark, 'the run canvas follows the theme');
  const resources = await ev(`return performance.getEntriesByType('resource').map(entry => entry.name);`);
  assert.deepEqual(resources.filter(name => !name.startsWith(app.url)), [], 'no outside request');
  assert.equal(await ev(`return document.querySelectorAll('style').length;`), 0, 'no <style> element was inserted');
  assert.deepEqual(browser.consoleMessages.filter(message => /EXCEPTION|Uncaught|Content Security Policy|Refused|Warning|style property/i.test(message)), []);
});

test('Pipeline performance in Chrome: a 200-step pipeline draws, selects, arranges and validates within bounds', { skip: !chrome, timeout: 300000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null });
  const { call, browser, ev, wait, shot } = await open(t, app);
  const { agents, network } = await seed(app, call);
  // Ten chains of agent steps (199 in all) into one report: 200 steps and 199 arrows.
  const nodes = [], edges = [], hex = n => n.toString(16).padStart(12, '0');
  for (let n = 0; n < 199; n++) {
    const chain = n % 10, column = Math.floor(n / 10);
    nodes.push({ id: `n_${hex(n + 1)}`, type: 'agent', label: `Step ${n + 1}`, position: { x: column * 240, y: chain * 112 }, config: { agentId: agents[n % 3].id } });
    if (n >= 10) edges.push({ id: `e_${hex(n + 1)}`, from: `n_${hex(n - 9)}`, to: `n_${hex(n + 1)}`, fromPort: 'text' });
  }
  const last = Array.from({ length: 10 }, (_, chain) => nodes.filter((_, n) => n % 10 === chain).at(-1).id);
  nodes.push({ id: `n_${hex(500)}`, type: 'output', label: 'Report', position: { x: 20 * 240, y: 500 }, config: { include: last } });
  for (const [index, from] of last.entries()) edges.push({ id: `e_${hex(600 + index)}`, from, to: `n_${hex(500)}`, fromPort: 'text' });
  const { pipeline } = await call('/api/network/pipelines', 'POST', { networkId: network.id, networkVersion: 1, name: 'Two hundred', nodes, edges });
  assert.deepEqual([pipeline.nodes.length, pipeline.edges.length], [200, 199]);

  const heap = async () => { await browser.send('HeapProfiler.collectGarbage'); return (await browser.send('Runtime.getHeapUsage')).usedSize; };
  await browser.goto(`${app.url}/#/network/pipelines`); await browser.resize(1440, 1000);
  await wait(`document.querySelectorAll('#network-pipelines-list [data-pipeline-id]').length === 1`, 'list');
  const heapBefore = await heap();
  const firstRender = await ev(`const t0 = performance.now(); location.hash = '#/network/pipelines/${pipeline.id}';
    for (;;) { await new Promise(requestAnimationFrame); const cy = ${PCY}; if (cy && cy.nodes().length === 200 && cy.edges().length === 199 && document.querySelectorAll('#network-pipeline-steps [data-step-id]').length === 200) break; if (performance.now() - t0 > 30000) throw new Error('no render'); }
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); return Math.round(performance.now() - t0);`);
  const heapAfter = await heap();
  await shot('pipeline-200-steps');
  const frame = `await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);`;
  const choose = await ev(`const t0 = performance.now(); document.querySelector('#network-pipeline-steps [data-step-id="n_${hex(150)}"]').click(); ${frame} return Math.round(performance.now() - t0);`);
  const label = await ev(`const t0 = performance.now(); const input = document.querySelector('#network-pipeline-label'); input.value = 'Renamed'; input.dispatchEvent(new Event('change')); ${frame} return Math.round(performance.now() - t0);`);
  const arrange = await ev(`const t0 = performance.now(); document.querySelector('#network-pipeline-arrange').click(); ${frame} return Math.round(performance.now() - t0);`);
  const validate = await ev(`const t0 = performance.now(); document.querySelector('#network-pipeline-validate').click();
    for (;;) { await new Promise(requestAnimationFrame); if (document.querySelector('#network-pipeline-valid, #network-pipeline-invalid')) break; if (performance.now() - t0 > 30000) throw new Error('no validation'); } return Math.round(performance.now() - t0);`);
  assert.match(await ev(`return document.querySelector('#network-pipeline-valid').textContent;`), /200 steps after sub-pipelines are expanded, 199 agent jobs/);
  const numbers = { steps: 200, arrows: 199, firstRenderMs: firstRender, chooseStepMs: choose, editLabelMs: label, arrangeMs: arrange, saveAndValidateMs: validate, heapDeltaMB: +((heapAfter - heapBefore) / 2 ** 20).toFixed(1) };
  t.diagnostic(`Network pipeline 200 steps: ${J(numbers)}`);
  if (process.env.PB_NETWORK_PERF_LOG) await writeFile(process.env.PB_NETWORK_PERF_LOG, `${J(numbers, null, 1)}\n`);
  // Targets (measured alone, logged in implementation-progress.md) are far lower; the suite only trips on a gross regression.
  assert.ok(firstRender < 10000, `first render of 200 steps (was ${firstRender} ms)`);
  assert.ok(choose < 3000 && label < 3000 && arrange < 3000, J(numbers));
  assert.deepEqual(browser.consoleMessages.filter(message => /EXCEPTION|Uncaught|Content Security Policy|Refused/i.test(message)), []);
});

test('A nested pipeline in Chrome: the sub-network step is a barrel on the designer canvas; in the run it is one collapsed node that expands into its steps, and its inner approval is approved from the canvas', { skip: !chrome, timeout: 300000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, networkWorker: fakeWorker() });
  const { call, browser, ev, wait, shot, tap } = await open(t, app);
  const { agents } = await seed(app, call);
  const inner = (await call('/api/network/networks', 'POST', { name: 'Checkers', nodes: [{ id: `n_${pad(1)}`, type: 'agent', agentId: agents[1].id, position: { x: 0, y: 0 } }], edges: [] })).network;
  await call(`/api/network/networks/${inner.id}/publish`, 'POST', { expectedRevision: 1 });
  const child = (await call('/api/network/pipelines', 'POST', { networkId: inner.id, networkVersion: 1, name: 'Fact check',
    nodes: [{ id: `n_${pad(1)}`, type: 'agent', label: 'Check facts', position: { x: 0, y: 0 }, config: { agentId: agents[1].id, instructions: 'Check the facts.' } },
      { id: `n_${pad(2)}`, type: 'approval', label: 'Inner approval', position: { x: 220, y: 0 }, config: { prompt: 'Are the facts right?' } },
      { id: `n_${pad(3)}`, type: 'output', label: 'Checked', position: { x: 440, y: 0 }, config: { name: 'checked', include: [`n_${pad(1)}`] } }],
    edges: [{ id: `e_${pad(1)}`, from: `n_${pad(1)}`, to: `n_${pad(2)}`, fromPort: 'text' }, { id: `e_${pad(2)}`, from: `n_${pad(2)}`, to: `n_${pad(3)}`, fromPort: 'done' }] })).pipeline;
  await call(`/api/network/pipelines/${child.id}/publish`, 'POST', { expectedRevision: 1 });
  const outer = (await call('/api/network/networks', 'POST', { name: 'Outer', nodes: [{ id: `n_${pad(1)}`, type: 'agent', agentId: agents[0].id, position: { x: 0, y: 0 } }, { id: `n_${pad(2)}`, type: 'subnetwork', networkId: inner.id, version: 1, position: { x: 300, y: 0 } }], edges: [] })).network;
  await call(`/api/network/networks/${outer.id}/publish`, 'POST', { expectedRevision: 1 });
  const S = `n_${pad(10)}`, SUB = `n_${pad(11)}`, OUT = `n_${pad(12)}`;
  const parent = (await call('/api/network/pipelines', 'POST', { networkId: outer.id, networkVersion: 1, name: 'Nested',
    nodes: [{ id: S, type: 'agent', label: 'Scout', position: { x: 0, y: 0 }, config: { agentId: agents[0].id, instructions: 'Find the claims.' } }, { id: SUB, type: 'subnetwork', label: 'Fact check', position: { x: 260, y: 0 }, config: { pipelineId: child.id, version: 1 } },
      { id: OUT, type: 'output', label: 'Report', position: { x: 520, y: 0 }, config: { include: [SUB] } }],
    edges: [{ id: `e_${pad(10)}`, from: S, to: SUB, fromPort: 'text' }, { id: `e_${pad(11)}`, from: SUB, to: OUT, fromPort: 'text' }] })).pipeline;
  await call(`/api/network/pipelines/${parent.id}/publish`, 'POST', { expectedRevision: 1 });
  await browser.goto(`${app.url}/#/network/pipelines/${parent.id}`); await browser.resize(1440, 1000);
  await wait(`${PCY}?.nodes().length === 3`, 'designer');
  assert.equal(await ev(`return ${PCY}.getElementById(${J(SUB)}).style('shape');`), 'barrel', 'a sub-network step is drawn collapsed as one barrel');
  const { runId } = await call(`/api/network/pipelines/${parent.id}/runs`, 'POST', { version: 1, confirm: true });
  await ev(`location.hash = '#/network/runs/${runId}';`);
  await wait(`${RCY}?.nodes().length === 3 && ${RCY}.getElementById(${J(SUB)}).hasClass('s-waiting_for_approval')`, 'collapsed group waiting');
  await shot('run-nested-collapsed-1440-light');
  await ev(`${RCY}.getElementById(${J(SUB)}).emit('dbltap');`);
  await wait(`${RCY}.nodes().length === 6 && ${RCY}.getElementById(${J(SUB)}).isParent() && ${RCY}.getElementById(${J(`${SUB}/n_${pad(2)}`)}).hasClass('s-waiting_for_approval')`, 'expanded into its steps');
  assert.deepEqual(await ev(`return ${RCY}.getElementById(${J(SUB)}).children().map(node => node.id()).sort();`), [1, 2, 3].map(n => `${SUB}/n_${pad(n)}`));
  await ev(`${RCY}.fit(undefined, 60);`);
  const overlaps = await ev(`const boxes = ${RCY}.nodes().filter(node => !node.isParent()).map(node => node.boundingBox()); let count = 0;
    for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1)) if (a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2) count++; return count;`);
  assert.equal(overlaps, 0, 'an expanded group moves what lies beside it, so no two steps overlap');
  assert.ok(await ev(`return ${RCY}.getElementById(${J(OUT)}).boundingBox().x1 > ${RCY}.getElementById(${J(SUB)}).boundingBox().x2;`), 'the report moved right of the expanded group');
  await tap(RCY, `${SUB}/n_${pad(2)}`);
  await wait(`document.querySelector('#network-run-approve')`, 'inner approval details');
  await shot('run-nested-expanded-1440-light');
  await ev(`document.querySelector('#network-run-approve').click();`);
  await wait(`document.querySelector('#network-run-status')?.textContent === 'Completed' && ${RCY}.getElementById(${J(OUT)}).hasClass('s-completed')`, 'completed');
  await ev(`document.querySelector('#network-run-collapse').click();`);
  await wait(`${RCY}.nodes().length === 3 && ${RCY}.getElementById(${J(SUB)}).hasClass('s-completed')`, 'collapsed again');
  assert.equal(await ev(`return document.querySelector('#network-run-collapse').disabled;`), true, 'Collapse all has nothing left to do');
  assert.deepEqual(browser.consoleMessages.filter(message => /EXCEPTION|Uncaught|Content Security Policy|Refused|Warning|style property/i.test(message)), []);
});
