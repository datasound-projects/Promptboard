// Network → Graph and Library in headless Chrome with the real Cytoscape canvas (/vendor/cytoscape.min.js under the
// unchanged CSP): a 3-agent network with a nested 2-agent network built with the mouse (drag, connect taps), saved,
// reloaded with the same positions and relations, published as v1, edited with v1 unchanged, a cycle refused with its
// message, lazy expansion of the nested network, both themes at 1440 px, and the list → details fallback at 390 px.
// The second test is the stress fixture: 1,000 drawn nodes, lazy expansion of a 500-node version, and the view cap.
// PB_NETWORK_SCREENSHOTS=<folder> saves the screenshots; PB_NETWORK_PERF_LOG=<file> saves the measurements as JSON.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const chrome = await findChrome();
const J = JSON.stringify;
const CY = `document.querySelector('#network-canvas')?._cyreg?.cy`;

async function open(t, app) {
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = async (path, method = 'GET', body) => { const response = await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: J(body) } : {}) }); return response.json(); };
  const browser = await launch({ width: 1440, height: 1000 }); assert.ok(browser); t.after(() => browser.close());
  const ev = code => browser.eval(code), wait = (expression, label, ms = 20000) => browser.until(expression, label, ms);
  const shots = process.env.PB_NETWORK_SCREENSHOTS;
  const shot = async name => { if (shots) { await mkdir(shots, { recursive: true }); await writeFile(join(shots, `${name}.png`), await browser.screenshot()); } };
  /** The page point of a canvas element (its rendered position plus the canvas's place on the page). */
  const point = id => ev(`const cy = ${CY}, box = document.querySelector('#network-canvas').getBoundingClientRect(), at = cy.getElementById(${J(id)}).renderedPosition(); return { x: Math.round(box.left + at.x), y: Math.round(box.top + at.y) };`);
  const mouse = (type, { x, y }, buttons = 0) => browser.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
  async function drag(id, dx, dy) {
    const from = await point(id);
    await mouse('mousePressed', from, 1);
    for (let step = 1; step <= 6; step++) await mouse('mouseMoved', { x: from.x + (dx * step) / 6, y: from.y + (dy * step) / 6 }, 1);
    await mouse('mouseReleased', { x: from.x + dx, y: from.y + dy });
  }
  const tap = async id => { const at = await point(id); await mouse('mousePressed', at, 1); await mouse('mouseReleased', at); };
  return { token, call, browser, ev, wait, shot, drag, tap };
}

test('Graph in Chrome: build a 3-agent network with a nested 2-agent network by mouse, save, reload, publish v1, edit, refuse a cycle; both themes; 390 px lists', { skip: !chrome, timeout: 300000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null });
  const { call, browser, ev, wait, shot, drag, tap } = await open(t, app);
  const agents = [];
  for (const [index, name] of ['Lead', 'Reviewer', 'Writer', 'Researcher', 'Checker'].entries()) {
    await app.board.base.create({ id: `b${index}`, kind: 'profile', name, configuration: { agent: { provider: index % 2 ? 'codex' : 'claude' } } });
    agents.push((await call('/api/network/agents', 'POST', { baseResourceId: `b${index}`, expectedRevision: index, enabled: index !== 4 })).agent);
  }
  const names = `[...document.querySelectorAll('#network-graph-nodes [data-node-id]')].map(node => node.querySelector('strong').textContent)`;
  const nodeOf = name => ev(`return [...document.querySelectorAll('#network-graph-nodes [data-node-id]')].find(node => node.querySelector('strong').textContent === ${J(name)}).dataset.nodeId;`);
  const editor = name => wait(`document.querySelector('#network-graph-heading')?.textContent === ${J(name)} && ${CY}?.nodes().length >= 0 && !document.querySelector('.network-graph-body').hidden`, `${name} in Graph`);
  async function create(name) {
    await ev(`location.hash = '#/network/library';`); await wait(`!document.querySelector('#network-panel-library').hidden`, 'Library');
    await ev(`document.querySelector('#network-library-new').click();`); await wait(`document.querySelector('#network-name-input')`, 'new network dialog');
    await ev(`document.querySelector('#network-name-input').value = ${J(name)}; document.querySelector('#network-name-submit').click();`);
    await editor(name);
    return ev(`return location.hash.split('/')[3];`);
  }
  async function addAgent(name) {
    await ev(`document.querySelector('#network-graph-add-agent').click();`);
    await wait(`[...document.querySelectorAll('#network-pick-list [data-agent-id]')].some(node => node.querySelector('strong').textContent === ${J(name)})`, `${name} offered`);
    await ev(`[...document.querySelectorAll('#network-pick-list [data-agent-id]')].find(node => node.querySelector('strong').textContent === ${J(name)}).click();`);
    await wait(`${names}.includes(${J(name)}) && ${CY}.nodes().length >= ${names}.length`, `${name} on the canvas`);
  }
  async function save() { await ev(`document.querySelector('#network-graph-save').click();`); await wait(`!document.querySelector('#network-graph-dirty') && document.querySelector('#network-graph-save').disabled`, 'saved'); }
  async function publish(n) {
    await ev(`document.querySelector('#network-graph-publish').click();`); await wait(`document.querySelector('#network-confirm')`, 'publish dialog');
    await ev(`document.querySelector('#network-confirm').click();`); await wait(`document.querySelector('#network-graph-versions [data-version="${n}"]')?.textContent === 'v${n} · latest'`, `v${n} published`);
  }

  await browser.goto(`${app.url}/#/network/library`);
  await ev(`localStorage.setItem('ste-prompt-engineer.theme', 'light');`); await browser.reload(); await browser.resize(1440, 1000);
  // The child: two agents and a relation, from the dialogs and the keyboard form; published as version 1.
  const childId = await create('Review pair');
  await addAgent('Researcher'); await addAgent('Checker');
  await ev(`document.querySelector('[data-node-id="${await nodeOf('Researcher')}"]').click();`);
  await ev(`const to = document.querySelector('#network-graph-connect-to'); to.value = ${J(await nodeOf('Checker'))}; to.dispatchEvent(new Event('change')); const relation = document.querySelector('#network-graph-connect-relation'); relation.value = 'share_result'; relation.dispatchEvent(new Event('change')); document.querySelector('#network-graph-connect-add').click();`);
  await wait(`${CY}.edges().length === 1`, 'child relation');
  await save(); await publish(1);

  // The parent: three agents and the child as a sub-network; placed by dragging, connected by canvas taps.
  const parentId = await create('Research team');
  for (const name of ['Lead', 'Reviewer', 'Writer']) await addAgent(name);
  await ev(`document.querySelector('#network-graph-add-subnetwork').click();`); await wait(`document.querySelector('#network-pick-network')`, 'sub-network dialog');
  await ev(`document.querySelector('#network-pick-add').click();`); await wait(`${names}.includes('Review pair') && ${CY}.nodes().length === 4`, 'sub-network on the canvas');
  const ids = Object.fromEntries(await Promise.all(['Lead', 'Reviewer', 'Writer', 'Review pair'].map(async name => [name, await nodeOf(name)])));
  await ev(`${CY}.fit(undefined, 60); document.querySelector('#network-canvas').scrollIntoView({ block: 'center' });`);
  await ev(`document.querySelector('#network-graph-grid').click(); ${CY}.fit(undefined, 80);`);
  for (const [name, dx, dy] of [['Lead', -120, 90], ['Writer', 60, 130], ['Review pair', 140, -40]]) {
    const before = await ev(`return ${CY}.getElementById(${J(ids[name])}).position();`);
    await drag(ids[name], dx, dy);
    await wait(`(() => { const at = ${CY}.getElementById(${J(ids[name])}).position(); return Math.abs(at.x - ${before.x}) > 20 || Math.abs(at.y - ${before.y}) > 20; })()`, `${name} dragged`);
  }
  const dragged = await ev(`const cy = ${CY}; return ${J(['Lead', 'Writer', 'Review pair'])}.map(name => ({ Lead: ${J(ids.Lead)}, Writer: ${J(ids.Writer)}, 'Review pair': ${J(ids['Review pair'])} })[name]).map(id => [id, Math.round(cy.getElementById(id).position('x')), Math.round(cy.getElementById(id).position('y'))]);`);
  // Connect by mouse: the relation select, Connect, then the two nodes. A tap on the same node twice is no relation.
  for (const [from, to, relation] of [['Lead', 'Reviewer', 'delegate'], ['Lead', 'Writer', 'message'], ['Writer', 'Review pair', 'share_result']]) {
    await ev(`const relation = document.querySelector('#network-graph-relation'); relation.value = ${J(relation)}; relation.dispatchEvent(new Event('change')); ${CY}.elements(':selected').unselect();`);
    await ev(`document.querySelector('[data-node-id="${ids[from]}"]').click();`);
    await ev(`document.querySelector('#network-graph-connect').click();`);
    await wait(`document.querySelector('#network-graph-connect').getAttribute('aria-pressed') === 'true'`, 'connect mode');
    await tap(ids[to]);
    await wait(`${CY}.edges().some(edge => edge.data('source') === ${J(ids[from])} && edge.data('target') === ${J(ids[to])} && edge.data('relation') === ${J(relation)})`, `${from} ${relation} ${to}`);
  }
  await ev(`document.querySelector('#network-canvas').focus(); document.querySelector('#network-canvas').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
  await ev(`document.querySelector('#network-graph-connect').click();`); await tap(ids.Lead); await tap(ids.Lead);
  await wait(`/A relation joins two different nodes\\./.test(document.querySelector('#network-status').textContent)`, 'no self-relation');
  await ev(`document.querySelector('#network-graph-connect').click();`);
  assert.equal(await ev(`return ${CY}.edges().length;`), 3);
  await save();
  const saved = (await call(`/api/network/networks/${parentId}`)).network;
  const canvasNow = () => ev(`const cy = ${CY}; return { nodes: cy.nodes().map(node => [node.id(), Math.round(node.position('x')), Math.round(node.position('y'))]).sort(), edges: cy.edges().map(edge => [edge.id(), edge.data('source'), edge.data('target'), edge.data('relation')]).sort() };`);
  const expected = { nodes: saved.nodes.map(node => [node.id, node.position.x, node.position.y]).sort(), edges: saved.edges.map(edge => [edge.id, edge.from, edge.to, edge.relation]).sort() };
  assert.deepEqual(await canvasNow(), expected, 'the canvas is what was saved');
  assert.deepEqual(dragged.map(([id]) => expected.nodes.find(node => node[0] === id)), dragged, 'the dragged positions were saved');

  // Reload the page: the same positions and typed relations come back.
  await browser.reload(); await editor('Research team'); await wait(`${CY}.nodes().length === 4`, 'reloaded canvas');
  assert.deepEqual(await canvasNow(), expected, 'positions and relations after a reload');
  await publish(1);
  const v1 = (await call(`/api/network/networks/${parentId}/versions/1`)).version;
  // Edit the draft: move a node and disconnect a relation; v1 stays exactly as published.
  await drag(ids.Reviewer, 80, 60);
  await ev(`document.querySelector('[data-disconnect="${saved.edges.find(edge => edge.relation === 'message').id}"]').click();`);
  await wait(`${CY}.edges().length === 2 && document.querySelector('#network-graph-dirty')`, 'draft edited');
  await save();
  assert.deepEqual((await call(`/api/network/networks/${parentId}/versions/1`)).version, v1, 'v1 unchanged');
  assert.equal((await call(`/api/network/networks/${parentId}`)).network.edges.length, 2);
  // Lazy expansion: the child's pinned version is drawn inside its node, read only; the switched-off agent is marked.
  await ev(`document.querySelector('[data-node-id="${ids['Review pair']}"]').click();`); await wait(`document.querySelector('#network-graph-expand')`, 'sub-network details');
  await ev(`document.querySelector('#network-graph-expand').click();`);
  await wait(`${CY}.nodes().length === 6 && ${CY}.getElementById(${J(ids['Review pair'])}).isParent()`, 'expanded');
  assert.deepEqual(await ev(`const cy = ${CY}; return cy.nodes('[?inner]').map(node => [node.data('label').split('\\n')[0], node.hasClass('disabled'), node.grabbable()]).sort();`), [['Checker', true, false], ['Researcher', false, false]]);
  await ev(`${CY}.fit(undefined, 40);`);
  await shot('graph-1440-light-expanded');
  // A cycle: the child cannot contain its parent. The message names the loop; nothing is saved.
  await ev(`location.hash = '#/network/graph/${childId}';`); await editor('Review pair');
  await ev(`document.querySelector('#network-graph-add-subnetwork').click();`); await wait(`document.querySelector('#network-pick-network')`, 'sub-network dialog');
  await ev(`const pick = document.querySelector('#network-pick-network'); pick.value = ${J(parentId)}; pick.dispatchEvent(new Event('change')); document.querySelector('#network-pick-add').click();`);
  await wait(`${CY}.nodes().length === 3`, 'parent added to the child');
  await ev(`document.querySelector('#network-graph-save').click();`);
  await wait(`!document.querySelector('#network-graph-alert').hidden`, 'refused');
  assert.match(await ev(`return document.querySelector('#network-graph-alert').textContent;`), /A network cannot contain itself: Review pair → Research team → Review pair\./);
  assert.equal(await ev(`return ${CY}.getElementById(${J(await nodeOf('Research team'))}).hasClass('problem');`), true, 'the node that closes the loop is marked on the canvas');
  await shot('graph-1440-light-cycle');
  assert.equal((await call(`/api/network/networks/${childId}`)).network.nodes.length, 2, 'the child draft is unchanged');
  await ev(`document.querySelector('#network-graph-discard').click();`); await wait(`document.querySelector('#network-confirm')`, 'discard dialog');
  await ev(`document.querySelector('#network-confirm').click();`); await wait(`!document.querySelector('#network-graph-dirty') && ${CY}.nodes().length === 2`, 'discarded');

  // Both themes at 1440 (canvas beside the lists) and 390 px (lists, then one node; no canvas at all).
  const noSideways = `document.documentElement.scrollWidth <= document.documentElement.clientWidth`;
  const colors = {};
  for (const theme of ['light', 'dark']) {
    await ev(`localStorage.setItem('ste-prompt-engineer.theme', ${J(theme)});`); await browser.reload(); await browser.resize(1440, 1000);
    await ev(`location.hash = '#/network/graph/${parentId}';`); await editor('Research team'); await wait(`${CY}.nodes().length === 4`, `${theme} canvas`);
    assert.equal(await browser.layout(`const canvas = document.querySelector('#network-canvas').getBoundingClientRect(), side = document.querySelector('.network-graph-side').getBoundingClientRect();
      return ${noSideways} && canvas.width > 600 && canvas.height >= 400 && side.left >= canvas.right && getComputedStyle(document.querySelector('#network-canvas')).position === 'relative';`), true, `${theme}: canvas beside the lists`);
    colors[theme] = await ev(`return ${CY}.nodes()[0].style('background-color');`);
    await shot(`graph-1440-${theme}`);
    await ev(`location.hash = '#/network/library/${childId}';`); await wait(`document.querySelector('#network-library-heading')?.textContent === 'Review pair'`, 'library');
    await shot(`library-1440-${theme}`);
    await browser.resize(390, 844);
    await ev(`location.hash = '#/network/graph/${parentId}';`); await wait(`document.querySelector('#network-graph-heading')?.textContent === 'Research team' && document.querySelectorAll('#network-graph-nodes [data-node-id]').length === 4`, `${theme} at 390`);
    assert.equal(await browser.layout(`return ${noSideways} && getComputedStyle(document.querySelector('.network-canvas-box')).display === 'none' && !(${CY}) && getComputedStyle(document.querySelector('#network-graph-details')).display === 'none' && document.querySelector('#network-graph-nodes').getBoundingClientRect().width > 300;`), true, `${theme}: lists, no canvas at 390`);
    await shot(`graph-390-${theme}-list`);
    const row = await ev(`const node = document.querySelector('[data-node-id="${ids.Lead}"]'); node.scrollIntoView({ block: 'center' }); const r = node.getBoundingClientRect(); return { x: r.left + 40, y: r.top + 15 };`);
    await browser.click(row.x, row.y);
    await wait(`document.activeElement?.id === 'network-graph-detail-heading' && document.querySelector('#network-panel-graph').dataset.view === 'detail'`, `${theme}: details at 390`);
    assert.equal(await browser.layout(`return ${noSideways} && getComputedStyle(document.querySelector('.network-graph-lists')).display === 'none' && document.querySelector('#network-graph-connect-add').getBoundingClientRect().right <= innerWidth;`), true, `${theme}: one node at 390`);
    await shot(`graph-390-${theme}-detail`);
    await ev(`document.querySelector('#network-graph-back').click();`);
    await wait(`document.activeElement?.dataset.nodeId === ${J(ids.Lead)}`, 'back to the row');
    await ev(`location.hash = '#/network/library/${parentId}';`); await wait(`document.querySelector('#network-library-heading')?.textContent === 'Research team'`, 'library at 390');
    assert.equal(await browser.layout(`return ${noSideways} && getComputedStyle(document.querySelector('#network-panel-library .network-list-panel')).display === 'none';`), true);
    await shot(`library-390-${theme}`);
  }
  assert.notEqual(colors.light, colors.dark, 'the canvas follows the theme');
  // CSP and loading: Cytoscape came from /vendor/, no style element was injected, nothing left the computer.
  const resources = await ev(`return performance.getEntriesByType('resource').map(entry => entry.name);`);
  assert.ok(resources.some(name => name.endsWith('/vendor/cytoscape.min.js')), 'loaded from /vendor/');
  assert.deepEqual(resources.filter(name => !name.startsWith(app.url)), [], 'no CDN or outside request');
  assert.equal(await ev(`return document.querySelectorAll('style').length;`), 0, 'no <style> element was inserted');
  assert.deepEqual(browser.consoleMessages.filter(message => /EXCEPTION|Uncaught|Content Security Policy|Refused/i.test(message)), []);
});

test('Graph stress fixture in Chrome: 1,000 drawn nodes, pan and zoom, lazy expansion of a 500-node version, and the view-cap notice', { skip: !chrome, timeout: 300000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null });
  await app.board.base.create({ id: 'lead', kind: 'profile', name: 'Lead', configuration: { agent: { provider: 'claude' } } });
  // 1,101 registrations of one Base agent, written in the registry's own format before the app first reads it.
  const at = Date.now(), rows = Array.from({ length: 1101 }, (_, index) => ({ id: `agt_${randomBytes(10).toString('hex')}`, baseResourceId: 'lead', displayName: `Agent ${index}`, tags: [], capabilities: [], enabled: true, visibility: 'private', projectAllowlist: [], createdAt: at, updatedAt: at, revision: 1 }));
  await mkdir(join(app.board.dataDir, 'network'), { recursive: true });
  await writeFile(join(app.board.dataDir, 'network', 'agents.json'), J({ schema: 'promptboard.network-agents', version: 1, revision: 1, rows }));
  const { call, browser, ev, wait, shot } = await open(t, app);
  const hex = n => n.toString(16).padStart(12, '0'), RELATIONS = ['message', 'delegate', 'share_result'];
  const grid = (count, offset = 0) => ({
    nodes: Array.from({ length: count }, (_, index) => ({ id: `n_${hex(index + 1)}`, type: 'agent', agentId: rows[offset + index].id, position: { x: (index % 40) * 200, y: Math.floor(index / 40) * 100 } })),
    edges: Array.from({ length: count - 1 }, (_, index) => ({ id: `e_${hex(index + 1)}`, from: `n_${hex(index + 1)}`, to: `n_${hex(index + 2)}`, relation: RELATIONS[index % 3] })),
  });
  const big = (await call('/api/network/networks', 'POST', { name: 'Thousand', ...grid(1000) })).network;
  assert.equal(big.nodes.length, 1000);
  const five = (await call('/api/network/networks', 'POST', { name: 'Five hundred', ...grid(500) })).network; await call(`/api/network/networks/${five.id}/publish`, 'POST', { expectedRevision: 1 });
  const six = (await call('/api/network/networks', 'POST', { name: 'Six hundred', ...grid(600, 500) })).network; await call(`/api/network/networks/${six.id}/publish`, 'POST', { expectedRevision: 1 });
  const lazy = (await call('/api/network/networks', 'POST', { name: 'Lazy', nodes: [...grid(10, 1090).nodes, { id: `n_${hex(11)}`, type: 'subnetwork', networkId: five.id, version: 1, position: { x: 0, y: 400 } }, { id: `n_${hex(12)}`, type: 'subnetwork', networkId: six.id, version: 1, position: { x: 1200, y: 400 } }], edges: [] })).network;

  const heap = async () => { await browser.send('HeapProfiler.collectGarbage'); return (await browser.send('Runtime.getHeapUsage')).usedSize; };
  await browser.goto(`${app.url}/#/network/library`); await browser.resize(1440, 1000);
  await wait(`document.querySelectorAll('#network-library-list [data-network-id]').length === 4`, 'library');
  const heapBefore = await heap();
  // First render: from choosing the network to the canvas holding every node, after two painted frames.
  const firstRender = await ev(`const t0 = performance.now(); location.hash = '#/network/graph/${big.id}';
    for (;;) { await new Promise(requestAnimationFrame); const cy = ${CY}; if (cy && cy.nodes().length === 1000 && cy.edges().length === 999) break; if (performance.now() - t0 > 30000) throw new Error('no render'); }
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); return Math.round(performance.now() - t0);`);
  const heapAfter = await heap();
  await shot('stress-1000');
  // Pan and zoom steps, each measured to the next painted frame.
  const steps = await ev(`const cy = ${CY}, times = [];
    for (const [zoom, dx, dy] of [[1.6, 120, 40], [0.7, -200, 90], [2.2, 60, -150], [0.5, -40, 30], [1.3, 300, 0]]) {
      const t0 = performance.now(); cy.zoom({ level: cy.zoom() * zoom, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }); cy.panBy({ x: dx, y: dy });
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); times.push(Math.round(performance.now() - t0));
    } return times;`);
  // Choosing a node from the list (details, list and canvas selection redrawn) and fitting the whole graph.
  const choose = await ev(`const t0 = performance.now(); document.querySelector('#network-graph-nodes [data-node-id]').click(); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); return Math.round(performance.now() - t0);`);
  const fit = await ev(`const t0 = performance.now(); document.querySelector('#network-graph-fit').click(); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); return Math.round(performance.now() - t0);`);
  assert.equal(await ev(`return document.querySelector('#network-graph-notice').textContent;`), '', 'exactly 1,000 nodes: no view-cap notice');
  // Lazy expansion: 12 nodes drawn; expanding the 500-node version reads it then; the 600-node one would pass the cap.
  await ev(`location.hash = '#/network/graph/${lazy.id}';`); await wait(`${CY}?.nodes().length === 12`, 'lazy network');
  const expandFive = await ev(`const t0 = performance.now(); document.querySelector('[data-node-id="n_${hex(11)}"]').click(); document.querySelector('#network-graph-expand').click();
    for (;;) { await new Promise(requestAnimationFrame); if (${CY}.nodes().length === 512) break; if (performance.now() - t0 > 30000) throw new Error('no expansion'); }
    await new Promise(requestAnimationFrame); return Math.round(performance.now() - t0);`);
  await ev(`document.querySelector('[data-node-id="n_${hex(12)}"]').click(); document.querySelector('#network-graph-expand').click();`);
  await wait(`document.querySelector('#network-graph-notice .network-cap-notice')`, 'cap notice');
  const capNotice = await ev(`return document.querySelector('#network-graph-notice').textContent;`);
  assert.match(capNotice, /Not expanded: “Six hundred” has 600 nodes, and the canvas would then draw 1,112, more than the 1,000-node view limit\./);
  assert.equal(await ev(`return ${CY}.nodes().length;`), 512, 'nothing more was drawn');
  await shot('stress-lazy-cap');
  // A draft above the cap itself says so (the canvas still draws it; sub-networks then stay collapsed).
  await call(`/api/network/networks/${big.id}`, 'PATCH', { expectedRevision: 1, nodes: [...big.nodes, { id: `n_${hex(1001)}`, type: 'agent', agentId: rows[1000].id, position: { x: 0, y: 2600 } }] });
  await ev(`location.hash = '#/network/library';`); await wait(`!document.querySelector('#network-panel-library').hidden`, 'library');
  await ev(`location.hash = '#/network/graph/${big.id}';`); await wait(`${CY}?.nodes().length === 1001`, '1,001 nodes');
  assert.match(await ev(`return document.querySelector('#network-graph-notice').textContent;`), /This network has 1,001 nodes, more than the 1,000-node view limit\./);

  const numbers = { nodes: 1000, edges: 999, firstRenderMs: firstRender, panZoomStepMs: steps, chooseNodeMs: choose, fitMs: fit, expand500Ms: expandFive, heapBeforeMB: +(heapBefore / 2 ** 20).toFixed(1), heapAfterMB: +(heapAfter / 2 ** 20).toFixed(1), heapDeltaMB: +((heapAfter - heapBefore) / 2 ** 20).toFixed(1) };
  t.diagnostic(`Network graph stress: ${J(numbers)}`);
  if (process.env.PB_NETWORK_PERF_LOG) await writeFile(process.env.PB_NETWORK_PERF_LOG, `${J(numbers, null, 1)}\n`);
  // The target is under 3 s on the test machine (measured alone, logged above and in implementation-progress.md); the
  // suite only trips on a gross regression, because CI runners draw the canvas in software under load.
  assert.ok(firstRender < 10000, `first render of 1,000 nodes (target under 3 s; was ${firstRender} ms)`);
  assert.deepEqual(browser.consoleMessages.filter(message => /EXCEPTION|Uncaught|Content Security Policy|Refused/i.test(message)), []);
});
