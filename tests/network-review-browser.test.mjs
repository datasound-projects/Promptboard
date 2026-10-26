// Phase-1 review fixes on the real Cytoscape canvas in headless Chrome: a new node never lands on another (P1-4); an
// expanded sub-network's label sits inside its box and relations inside it are drawn above its nodes (P1-9); a status
// message, also Connect mode's instructions, never moves the canvas or the lists (P1-10). Light and dark at 1440 and 390 px.
// PB_NETWORK_SCREENSHOTS=<folder> saves the screenshots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const chrome = await findChrome();
const J = JSON.stringify;
const CY = `document.querySelector('#network-canvas')?._cyreg?.cy`;
const node = (n, agentId, x, y) => ({ id: `n_${String(n).padStart(12, '0')}`, type: 'agent', agentId, position: { x, y } });

test('P1-4, P1-9, P1-10 in Chrome: new nodes keep clear of others, the expanded label is inside its box, a status line never moves the page', { skip: !chrome, timeout: 300000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = async (path, method = 'GET', body) => (await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: J(body) } : {}) })).json();
  const agents = [];
  for (const [index, name] of ['Lead', 'Reviewer', 'Writer', 'Researcher', 'Checker'].entries()) {
    await app.board.base.create({ id: `b${index}`, kind: 'profile', name, configuration: { agent: { provider: 'claude' } } });
    agents.push((await call('/api/network/agents', 'POST', { baseResourceId: `b${index}`, expectedRevision: index })).agent);
  }
  const child = (await call('/api/network/networks', 'POST', { name: 'Review pair', nodes: [node(1, agents[3].id, 0, 0), node(2, agents[4].id, 220, 0)], edges: [{ id: 'e_000000000001', from: 'n_000000000001', to: 'n_000000000002', relation: 'share_result' }] })).network;
  await call(`/api/network/networks/${child.id}/publish`, 'POST', { expectedRevision: 1 });
  const parent = (await call('/api/network/networks', 'POST', { name: 'Team', nodes: [node(1, agents[0].id, 0, 0), node(2, agents[2].id, 0, 150), { id: 'n_000000000003', type: 'subnetwork', networkId: child.id, version: 1, position: { x: 0, y: 330 } }],
    edges: [{ id: 'e_000000000001', from: 'n_000000000001', to: 'n_000000000002', relation: 'message' }, { id: 'e_000000000002', from: 'n_000000000002', to: 'n_000000000003', relation: 'share_result' }] })).network;
  const browser = await launch({ width: 1440, height: 1000 }); assert.ok(browser); t.after(() => browser.close());
  const ev = code => browser.eval(code), wait = (expression, label, ms = 20000) => browser.until(expression, label, ms);
  const shots = process.env.PB_NETWORK_SCREENSHOTS;
  const shot = async name => { if (shots) { await mkdir(shots, { recursive: true }); await writeFile(join(shots, `${name}.png`), await browser.screenshot()); } };
  const top = selector => ev(`return Math.round(document.querySelector(${J(selector)}).getBoundingClientRect().top + scrollY);`);
  async function addAgent(expected) {
    await ev(`document.querySelector('#network-graph-add-agent').click();`); await wait(`document.querySelectorAll('#network-pick-list [data-agent-id]:not([disabled])').length > 0`, 'agent picker');
    await ev(`document.querySelector('#network-pick-list [data-agent-id]:not([disabled])').click();`);
    await wait(`document.querySelectorAll('#network-graph-nodes [data-node-id]').length === ${expected} && document.querySelector('#network-status').textContent.startsWith('Added')`, 'agent added');
  }

  await browser.goto(`${app.url}/#/network/library`);
  for (const theme of ['light', 'dark']) {
    await ev(`localStorage.setItem('ste-prompt-engineer.theme', ${J(theme)});`); await browser.reload(); await browser.resize(1440, 1000);
    // P1-4 and P1-10 at 1440: the view's centre 125 px beside the only node (as after a pan); the new node keeps clear of
    // it, and the status message that says so does not move the canvas.
    const lone = (await call('/api/network/networks', 'POST', { name: `Placement ${theme}`, nodes: [node(1, agents[0].id, 0, 0)] })).network;
    await ev(`location.hash = '#/network/graph/${lone.id}';`); await wait(`${CY}?.nodes().length === 1 && !document.querySelector('.network-graph-body').hidden`, 'one-node canvas');
    await ev(`window.scrollTo(0, 0); const cy = ${CY}; cy.zoom(1); cy.pan({ x: cy.width() / 2 - 125, y: cy.height() / 2 });`);
    assert.equal(await ev(`return document.querySelector('#network-status').textContent;`), '');
    const canvasTop = await top('#network-canvas');
    await addAgent(2);
    const placed = await ev(`const [a, b] = ${CY}.nodes(), A = a.boundingBox(), B = b.boundingBox(); return { gapX: Math.max(A.x1, B.x1) - Math.min(A.x2, B.x2), gapY: Math.max(A.y1, B.y1) - Math.min(A.y2, B.y2) };`);
    assert.ok(placed.gapX > 0 || placed.gapY > 0, `the new node overlaps the first one: ${J(placed)}`);
    assert.equal(await top('#network-canvas'), canvasTop, 'the status message did not move the canvas');
    await ev(`document.querySelector('#network-graph-connect').click();`); await wait(`/Escape stops/.test(document.querySelector('#network-status').textContent)`, 'connect mode');
    assert.equal(await top('#network-canvas'), canvasTop, 'entering Connect mode did not move the canvas under the pointer');
    await ev(`document.querySelector('#network-graph-connect').click();`); await wait(`document.querySelector('#network-status').textContent === 'Stopped connecting.'`, 'connect stopped');
    await ev(`${CY}.fit(undefined, 80);`); await shot(`placement-1440-${theme}`);
    await ev(`document.querySelector('#network-graph-discard').click();`); await wait(`document.querySelector('#network-confirm')`, 'discard'); await ev(`document.querySelector('#network-confirm').click();`);
    // P1-9: the expanded sub-network's one-line label is inside its box, below its top border and above its nodes; the
    // relation inside it is drawn on top of its nodes, so its label shows.
    await ev(`location.hash = '#/network/graph/${parent.id}';`); await wait(`${CY}?.nodes().length === 3`, 'parent canvas');
    await ev(`document.querySelector('[data-node-id="n_000000000003"]').click();`); await wait(`document.querySelector('#network-graph-expand')`, 'sub-network details');
    await ev(`document.querySelector('#network-graph-expand').click();`); await wait(`${CY}.nodes().length === 5`, 'expanded');
    const box = await ev(`const cy = ${CY}, p = cy.getElementById('n_000000000003'), body = p.boundingBox({ includeLabels: false, includeOverlays: false }), label = p.boundingBox({ includeNodes: false, includeEdges: false, includeLabels: true, includeOverlays: false });
      return { label: p.data('label'), body: [body.y1, body.y2], text: [label.y1, label.y2], inner: Math.min(...cy.nodes('[?inner]').map(n => n.boundingBox({ includeLabels: false }).y1)), depth: cy.edges('[?inner]').map(e => e.style('z-compound-depth')) };`);
    assert.equal(box.label, '▾ Review pair · version 1 · 2 nodes');
    assert.ok(box.text[0] > box.body[0] && box.text[1] < box.inner, `the label sits inside, above the inner nodes: ${J(box)}`);
    assert.deepEqual(box.depth, ['top']);
    await ev(`${CY}.fit(undefined, 40); document.querySelector('#network-canvas').scrollIntoView({ block: 'center' });`); await shot(`expanded-1440-${theme}`);
    // P1-10 at 390: no canvas; a status message does not move the editor below it.
    await browser.resize(390, 844); await ev(`location.hash = '#/network/graph/${lone.id}';`);
    await wait(`document.querySelector('#network-graph-heading')?.textContent === ${J(`Placement ${theme}`)} && !document.querySelector('#network-graph-dirty')`, 'phone editor');
    await ev(`document.querySelector('#network-status').textContent = ''; window.scrollTo(0, 0);`);
    const headingTop = await top('#network-graph-heading');
    await addAgent(2);
    assert.equal(await top('#network-graph-heading'), headingTop, 'the status message did not move the editor');
    await ev(`window.scrollTo(0, 0);`); await shot(`status-390-${theme}`);
    await ev(`document.querySelector('#network-graph-discard').click();`); await wait(`document.querySelector('#network-confirm')`, 'discard 390'); await ev(`document.querySelector('#network-confirm').click();`);
    await browser.resize(1440, 1000);
  }
  assert.deepEqual(browser.consoleMessages.filter(message => /Refused|Uncaught|EXCEPTION/i.test(message)), []);
});
