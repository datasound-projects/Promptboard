// Network → Graph and Network → Library (public/network-graph.js inside network.js and app.js) in jsdom against the real
// server. jsdom has no canvas, so these drive the keyboard lists beside the canvas, which edit the same draft: a 3-agent
// network with a nested 2-agent network built from the dialogs, saved, reopened in a new page, published, edited with v1
// unchanged; an indirect cycle refused with its path; unsaved changes guarded on navigation; a revision conflict kept as
// a new network; undo; Library browse, rename, duplicate, archive, delete (refused with the reason), export, import and
// network memory; labels and the phone list → details flow. Nothing here starts a job, a run or a model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, until } from './helpers/ui-harness.mjs';

const pad = n => String(n).padStart(12, '0');
async function call(ctx, path, method = 'GET', body) {
  const response = await fetch(`${ctx.app.url}${path}`, { method, headers: { 'X-STE-Token': ctx.win.__pbTest.token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, json: await response.json() };
}
/** Five Base agents, each registered in Network; the fifth is switched off in Network. */
async function seed(ctx) {
  const agents = [];
  for (const [index, name] of ['Lead', 'Reviewer', 'Writer', 'Researcher', 'Checker'].entries()) {
    await ctx.app.board.base.create({ id: `b${index}`, kind: 'profile', name, configuration: { agent: { provider: index % 2 ? 'codex' : 'claude' } } });
    const { json } = await call(ctx, '/api/network/agents', 'POST', { baseResourceId: `b${index}`, expectedRevision: index, enabled: index !== 4 });
    agents.push(json.agent);
  }
  return agents;
}
async function network(ctx, name, nodes = [], edges = [], publish = false) {
  const { json } = await call(ctx, '/api/network/networks', 'POST', { name, nodes, edges });
  if (publish) await call(ctx, `/api/network/networks/${json.network.id}/publish`, 'POST', { expectedRevision: 1 });
  return json.network;
}
const agentNode = (n, agentId, x = n * 200, y = 0) => ({ id: `n_${pad(n)}`, type: 'agent', agentId, position: { x, y } });
const subNode = (n, networkId, version) => ({ id: `n_${pad(n)}`, type: 'subnetwork', networkId, version, position: { x: n * 200, y: 200 } });
function requestLog(ctx) {
  const log = [], original = ctx.win.fetch;
  ctx.win.fetch = (url, options = {}) => { log.push([options.method || 'GET', String(url)]); return original(url, options); };
  return log;
}
async function visit(ctx, hash, check) { ctx.win.location.hash = hash; await until(check, `page ${hash}`); await ctx.idle(); }
const choose = (ctx, selector, value) => { const node = ctx.$(selector); node.value = value; node.dispatchEvent(new ctx.win.Event('change', { bubbles: true })); };
const submit = ctx => ctx.$('#network-dialog form').dispatchEvent(new ctx.win.Event('submit', { bubbles: true, cancelable: true }));
const byText = (root, text) => [...root.querySelectorAll('button')].find(node => node.textContent === text);
const nodeRows = ctx => [...ctx.$('#network-graph-nodes').querySelectorAll('[data-node-id]')].map(node => node.querySelector('strong').textContent);
const edgeRows = ctx => [...ctx.$('#network-graph-edges').querySelectorAll('[data-edge-id]')].map(node => `${node.querySelector('strong').textContent} (${node.querySelector('.network-relation').textContent})`);
const editorReady = (ctx, name) => until(() => ctx.$('#network-graph-heading')?.textContent === name && !ctx.$('#network-panel-graph').hidden && !ctx.$('.network-graph-body').hidden, `${name} open in Graph`);
const nodeId = (ctx, name) => [...ctx.$('#network-graph-nodes').querySelectorAll('[data-node-id]')].find(node => node.querySelector('strong').textContent === name).dataset.nodeId;
async function addAgent(ctx, name) {
  ctx.$('#network-graph-add-agent').click();
  await until(() => [...ctx.$('#network-pick-list').querySelectorAll('[data-agent-id]')].some(node => node.querySelector('strong').textContent === name), `${name} offered`);
  [...ctx.$('#network-pick-list').querySelectorAll('[data-agent-id]')].find(node => node.querySelector('strong').textContent === name).click();
  await until(() => nodeRows(ctx).includes(name) && ctx.win.document.activeElement?.id === 'network-graph-detail-heading', `${name} added and its details focused`);
}
async function connect(ctx, from, to, relation) {
  ctx.$(`[data-node-id="${nodeId(ctx, from)}"]`).click();
  await until(() => ctx.$('#network-graph-detail-heading')?.textContent === from, `${from} chosen`);
  choose(ctx, '#network-graph-connect-to', nodeId(ctx, to)); choose(ctx, '#network-graph-connect-relation', relation);
  ctx.$('#network-graph-connect-add').click();
}
async function save(ctx) { ctx.$('#network-graph-save').click(); await until(() => !ctx.$('#network-graph-dirty') && ctx.$('#network-graph-save').disabled, 'saved'); await ctx.idle(); }

test('the lists build a 3-agent network with a nested 2-agent network; it saves, reopens in a new page, publishes v1, and an edit leaves v1 unchanged', async t => {
  const ctx = await setup(t, { hash: '#/' }); const { $, win } = ctx;
  const agents = await seed(ctx);
  const child = await network(ctx, 'Review pair', [agentNode(1, agents[2].id), agentNode(2, agents[3].id)], [{ id: `e_${pad(1)}`, from: `n_${pad(1)}`, to: `n_${pad(2)}`, relation: 'share_result' }], true);
  const log = requestLog(ctx);
  await visit(ctx, '#/network/library', () => !$('#network-panel-library').hidden && $('#network-library-list [data-network-id]'));
  $('#network-library-new').click(); await until(() => $('#network-name-input'), 'new network dialog');
  $('#network-name-input').value = 'Research team'; $('#network-description-input').value = 'Three agents and a review pair.'; submit(ctx);
  await editorReady(ctx, 'Research team');
  const id = win.location.hash.split('/')[3];
  assert.match(id, /^net_[0-9a-f]{20}$/);
  assert.match($('#network-graph-notice').textContent, /The canvas could not load in this browser\. The lists below show and edit the same network\./, 'without Cytoscape the lists are the editor');
  assert.match($('#network-graph-inert').textContent, /starts nothing.*grants no permission, sends no message and shares no data/);
  // Add agents from the dialog: the switched-off one is marked; the same agent is never offered twice.
  $('#network-graph-add-agent').click(); await until(() => $('#network-pick-list [data-agent-id]'), 'agents offered');
  assert.match([...$('#network-pick-list').querySelectorAll('[data-agent-id]')].find(node => node.dataset.agentId === agents[4].id).textContent, /Switched off/);
  $('#network-dialog .kanban-dialog-actions button').click();
  for (const name of ['Lead', 'Reviewer', 'Checker']) await addAgent(ctx, name);
  $('#network-graph-add-agent').click(); await until(() => $(`#network-pick-list [data-agent-id="${agents[0].id}"]`)?.disabled, 'Lead is already in the network');
  $('#network-dialog .kanban-dialog-actions button').click();
  // Add the published 2-agent network as a sub-network: a pin of version 1.
  $('#network-graph-add-subnetwork').click(); await until(() => $('#network-pick-network'), 'sub-network dialog');
  assert.deepEqual([$('#network-pick-network').value, $('#network-pick-version').value], [child.id, '1']);
  assert.ok(![...$('#network-pick-network').options].some(option => option.value === id), 'a network is never offered inside itself');
  $('#network-pick-add').click();
  await until(() => nodeRows(ctx).includes('Review pair'), 'sub-network added');
  assert.match($('#network-graph-details').textContent, /Sub-network · version 1 of 1/);
  // Typed relations from the keyboard form; a duplicate is refused, and no node is offered as its own target.
  await connect(ctx, 'Lead', 'Reviewer', 'delegate');
  await connect(ctx, 'Lead', 'Checker', 'message');
  await connect(ctx, 'Checker', 'Review pair', 'share_result');
  assert.ok(![...$('#network-graph-connect-to').options].some(option => option.value === nodeId(ctx, 'Checker')), 'no self-relation offered');
  await connect(ctx, 'Lead', 'Reviewer', 'delegate');
  await until(() => /This relation already exists\./.test($('#network-status').textContent), 'duplicate refused');
  assert.deepEqual(edgeRows(ctx), ['Lead → Reviewer (Delegate)', 'Lead → Checker (Message)', 'Checker → Review pair (Share result)']);
  $('#network-graph-grid').click();
  assert.ok($('#network-graph-dirty') && !$('#network-graph-save').disabled, 'unsaved changes are shown');
  await save(ctx);
  const saved = (await call(ctx, `/api/network/networks/${id}`)).json;
  assert.deepEqual(saved.network.nodes.map(node => [node.type, node.agentId || node.networkId, node.version]), [['agent', agents[0].id, undefined], ['agent', agents[1].id, undefined], ['agent', agents[4].id, undefined], ['subnetwork', child.id, 1]]);
  assert.deepEqual(saved.network.nodes.map(node => node.position), [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 400, y: 0 }, { x: 0, y: 100 }], 'grid positions saved in one batch');
  assert.deepEqual(saved.network.edges.map(edge => edge.relation), ['delegate', 'message', 'share_result']);
  // The switched-off agent is an issue with what to do about it.
  await until(() => /“Checker” is switched off in Network\. Switch it on in its profile, or remove it from this network\./.test($('#network-graph-issues').textContent), 'issue shown');
  assert.ok($(`#network-graph-nodes [data-node-id="${nodeId(ctx, 'Checker')}"]`).closest('li').dataset.state === 'disabled');

  // Reopen in a new page: the same nodes, positions and relations come back from the server.
  const again = await setup(t, { dataDir: ctx.dataDir, hash: `#/network/graph/${id}` });
  await editorReady(again, 'Research team');
  assert.deepEqual(nodeRows(again), ['Lead', 'Reviewer', 'Checker', 'Review pair']);
  assert.deepEqual(edgeRows(again), ['Lead → Reviewer (Delegate)', 'Lead → Checker (Message)', 'Checker → Review pair (Share result)']);
  again.$(`[data-node-id="${nodeId(again, 'Checker')}"]`).click();
  await until(() => /Position400,0/.test(again.$('#network-graph-details').textContent.replace(/\s+/g, '')), 'position kept');
  // Publish v1, then edit the draft and publish v2: v1 stays byte-for-byte the same.
  again.$('#network-graph-publish').click(); await until(() => again.$('#network-confirm'), 'publish dialog');
  assert.match(again.$('#network-dialog').textContent, /never changes and is never deleted/);
  again.$('#network-confirm').click();
  await until(() => again.$('#network-graph-versions [data-version="1"]')?.textContent === 'v1 · latest', 'v1 published');
  const v1 = (await call(again, `/api/network/networks/${id}/versions/1`)).json.version;
  again.$(`[data-disconnect="${saved.network.edges[1].id}"]`).click();
  await until(() => again.$('#network-graph-dirty') && edgeRows(again).length === 2, 'relation removed');
  await save(again);
  assert.deepEqual((await call(again, `/api/network/networks/${id}/versions/1`)).json.version, v1, 'v1 is unchanged after a draft edit');
  again.$('#network-graph-publish').click(); await until(() => again.$('#network-confirm'), 'publish dialog'); again.$('#network-confirm').click();
  await until(() => again.$('#network-graph-versions [data-version="2"]')?.textContent === 'v2 · latest' && again.$('#network-graph-versions [data-version="1"]').textContent === 'v1', 'v1 and v2, the latest marked');
  // A published version opens read only.
  again.$('#network-graph-versions [data-version="1"]').click();
  await editorReady(again, 'Research team · version 1');
  assert.deepEqual([edgeRows(again).length, again.$('#network-graph-save').hidden, again.$('.network-graph-tools').hidden, again.$('#network-graph-edit-draft').hidden], [3, true, true, false]);
  assert.equal(again.$('[data-disconnect]'), null, 'nothing in a version can be changed');
  // Library: the versions and where the child is used.
  await visit(again, `#/network/library/${child.id}`, () => again.$('#network-library-heading')?.textContent === 'Review pair');
  assert.match(again.$('#network-library-used-by').textContent, /Research team.*its draft pins version 1; its version 1 pins version 1; its version 2 pins version 1/);
  await visit(again, `#/network/library/${id}`, () => again.$('#network-library-heading')?.textContent === 'Research team');
  assert.deepEqual([...again.$('#network-library-versions').children].map(item => [item.dataset.version, /Latest/.test(item.textContent)]), [['2', true], ['1', false]]);
  // Only reads and the graph routes: no job, run or generation request; no model call.
  assert.ok(log.every(([method, url]) => method === 'GET' || /^\/api\/network\/networks(\/net_[0-9a-f]{20}(\/publish)?)?$/.test(url)), JSON.stringify(log.filter(([method]) => method !== 'GET')));
  assert.ok(!log.some(([, url]) => /generate|\/runs|\/jobs|research/.test(url)));
  assert.deepEqual([ctx.calls.length, again.calls.length], [0, 0]);
});

test('an indirect cycle added in the editor is refused with its path and a fix; the saved draft is unchanged and the edits stay', async t => {
  const ctx = await setup(t, { hash: '#/' }); const { $ } = ctx;
  const agents = await seed(ctx);
  const a = await network(ctx, 'A', [agentNode(1, agents[0].id)], [], true);
  const c = await network(ctx, 'C', [subNode(1, a.id, 1)], [], true);
  const b = await network(ctx, 'B', [subNode(1, c.id, 1)], [], true);
  const before = (await call(ctx, `/api/network/networks/${a.id}`)).json.network;
  await visit(ctx, `#/network/graph/${a.id}`, () => $('#network-graph-heading')?.textContent === 'A');
  await editorReady(ctx, 'A');
  $('#network-graph-add-subnetwork').click(); await until(() => $('#network-pick-network'), 'sub-network dialog');
  choose(ctx, '#network-pick-network', b.id); $('#network-pick-add').click();
  await until(() => nodeRows(ctx).includes('B'), 'B added');
  $('#network-graph-save').click();
  await until(() => !$('#network-graph-alert').hidden, 'save refused');
  assert.match($('#network-graph-alert').textContent, /A network cannot contain itself: A → B → C → A\. Remove the sub-network “B” from this network/);
  assert.match($('#network-graph-alert').textContent, /The draft was not saved; your changes are kept\./);
  assert.ok($('#network-graph-dirty') && $(`[data-node-id="${nodeId(ctx, 'B')}"]`).classList.contains('is-problem'), 'the node that closes the loop is marked; the edits stay');
  assert.deepEqual((await call(ctx, `/api/network/networks/${a.id}`)).json.network, before, 'the saved draft is unchanged');
  $(`[data-remove-node="${nodeId(ctx, 'B')}"]`).click();
  await until(() => $('#network-graph-alert').hidden && !nodeRows(ctx).includes('B'), 'removed from the alert');
  $('#network-graph-undo').click(); await until(() => nodeRows(ctx).includes('B'), 'undo brings it back');
  $('#network-graph-undo').click(); await until(() => !nodeRows(ctx).includes('B') && !$('#network-graph-dirty'), 'undo back to the saved draft');
  assert.equal($('#network-graph-undo').disabled, true);
});

test('unsaved changes ask before navigation and on unload; a revision conflict offers reloading or keeping the edits as a new network', async t => {
  const ctx = await setup(t, { hash: '#/' }); const { $, win } = ctx;
  const agents = await seed(ctx);
  const net = await network(ctx, 'Team', [agentNode(1, agents[0].id)]);
  await visit(ctx, `#/network/graph/${net.id}`, () => $('#network-graph-heading')?.textContent === 'Team'); await editorReady(ctx, 'Team');
  const unload = () => { const event = new win.Event('beforeunload', { cancelable: true }); win.dispatchEvent(event); return event.defaultPrevented; };
  assert.equal(unload(), false, 'nothing to lose, nothing asked');
  await addAgent(ctx, 'Reviewer');
  assert.equal(unload(), true, 'closing the tab asks while there are unsaved changes');
  const asked = []; win.confirm = text => { asked.push(text); return false; };
  win.location.hash = '#/network';
  await until(() => win.location.hash === `#/network/graph/${net.id}` && !$('#network-panel-graph').hidden, 'kept editing');
  await ctx.idle();
  assert.deepEqual([asked, nodeRows(ctx)], [['Discard your unsaved changes to “Team”?'], ['Lead', 'Reviewer']]);
  win.location.hash = '#/base';
  await until(() => win.location.hash === `#/network/graph/${net.id}` && !$('#network-view').hidden, 'leaving the page asks too');
  assert.equal(asked.length, 2);
  win.confirm = () => true;
  await visit(ctx, '#/network', () => !$('#network-panel-agents').hidden);
  await visit(ctx, `#/network/graph/${net.id}`, () => $('#network-graph-heading')?.textContent === 'Team'); await editorReady(ctx, 'Team');
  assert.deepEqual([nodeRows(ctx), Boolean($('#network-graph-dirty'))], [['Lead'], false], 'discarded: the saved draft is shown');
  // A save over someone else's newer save is refused; nothing is overwritten; "Save mine" keeps the edits elsewhere.
  await addAgent(ctx, 'Writer');
  await call(ctx, `/api/network/networks/${net.id}`, 'PATCH', { expectedRevision: 1, description: 'Changed in another window' });
  $('#network-graph-save').click();
  await until(() => $('#network-graph-reload') && $('#network-graph-save-new'), 'conflict choices');
  assert.match($('#network-graph-alert').textContent, /changed since you loaded it.*Nothing was overwritten/);
  $('#network-graph-save-new').click();
  await until(() => $('#network-graph-heading')?.textContent === 'Team (my changes)' && !$('.network-graph-body').hidden, 'my edits as a new network');
  assert.deepEqual(nodeRows(ctx), ['Lead', 'Writer']);
  const original = (await call(ctx, `/api/network/networks/${net.id}`)).json.network;
  assert.deepEqual([original.description, original.nodes.length, original.revision], ['Changed in another window', 1, 2]);
  // Load the saved draft instead: the edits are dropped and the newer draft shows.
  const mine = win.location.hash;
  await addAgent(ctx, 'Reviewer');
  const current = (await call(ctx, `/api/network/networks/${mine.split('/')[3]}`)).json.network;
  await call(ctx, `/api/network/networks/${current.id}`, 'PATCH', { expectedRevision: current.revision, description: 'Again' });
  $('#network-graph-save').click(); await until(() => $('#network-graph-reload'), 'conflict');
  $('#network-graph-reload').click();
  await until(() => !$('#network-graph-dirty') && nodeRows(ctx).join() === 'Lead,Writer' && $('#network-graph-alert').hidden, 'saved draft loaded');
});

test('Library: browse and search, rename, duplicate, archive and restore, delete refused with the reason or done, export, import, and network memory', async t => {
  const ctx = await setup(t, { hash: '#/' }); const { $, win } = ctx;
  const agents = await seed(ctx);
  const child = await network(ctx, 'Review pair', [agentNode(1, agents[2].id)], [], true);
  const parent = await network(ctx, 'Research team', [agentNode(1, agents[0].id), subNode(2, child.id, 1)]);
  const lone = await network(ctx, 'Lone', [], [], true);
  const scratch = await network(ctx, 'Scratch');
  await visit(ctx, '#/network/library', () => $('#network-library-list [data-network-id]'));
  const listed = () => [...$('#network-library-list').querySelectorAll('[data-network-id]')].map(node => node.querySelector('strong').textContent);
  assert.deepEqual(listed(), ['Review pair', 'Research team', 'Lone', 'Scratch']);
  $('#network-library-search').value = 'pair'; $('#network-library-search').dispatchEvent(new win.Event('input'));
  await until(() => listed().join() === 'Review pair', 'searched on the server');
  $('#network-library-search').value = ''; $('#network-library-search').dispatchEvent(new win.Event('input'));
  await until(() => listed().length === 4, 'search cleared');
  // Delete is refused, with the reason, for a network another one uses and for a published one.
  $(`[data-network-id="${child.id}"]`).click();
  await until(() => $('#network-library-heading')?.textContent === 'Review pair', 'child detail');
  assert.deepEqual([$('#network-library-delete').disabled, $('#network-library-delete').getAttribute('aria-describedby')], [true, 'network-library-delete-reason']);
  assert.match($('#network-library-delete-reason').textContent, /cannot be deleted: it is a sub-network of “Research team”\. Remove it there first, or archive it\./);
  await visit(ctx, `#/network/library/${lone.id}`, () => $('#network-library-heading')?.textContent === 'Lone');
  assert.match($('#network-library-delete-reason').textContent, /published versions, which later runs may pin\. Archive it instead/);
  // Archive hides it from the list; Show archived brings it back; Restore.
  $('#network-library-archive').click();
  await until(() => $('#network-library-archive')?.textContent === 'Restore' && !listed().includes('Lone'), 'archived');
  assert.equal(win.document.activeElement, $('#network-library-archive'), 'focus stays on the button');
  $('#network-library-archived').checked = true; $('#network-library-archived').dispatchEvent(new win.Event('change'));
  await until(() => listed().includes('Lone') && /Archived/.test($(`[data-network-id="${lone.id}"]`).textContent), 'shown when asked');
  $('#network-library-archive').click(); await until(() => $('#network-library-archive')?.textContent === 'Archive', 'restored');
  // Rename; a conflicting save in the dialog offers Reload and saves nothing.
  await visit(ctx, `#/network/library/${scratch.id}`, () => $('#network-library-heading')?.textContent === 'Scratch');
  $('#network-library-rename').click(); await until(() => $('#network-name-input'), 'rename dialog');
  $('#network-name-input').value = 'Sketch'; submit(ctx);
  await until(() => $('#network-library-heading')?.textContent === 'Sketch' && listed().includes('Sketch'), 'renamed');
  $('#network-library-rename').click(); await until(() => $('#network-name-input'), 'rename dialog');
  await call(ctx, `/api/network/networks/${scratch.id}`, 'PATCH', { expectedRevision: 2, description: 'Elsewhere' });
  $('#network-name-input').value = 'Overwrite'; submit(ctx);
  await until(() => byText($('#network-dialog'), 'Reload'), 'conflict in the dialog');
  byText($('#network-dialog'), 'Reload').click();
  await until(() => !$('#network-dialog').open && /Elsewhere/.test($('#network-library-detail').textContent), 'reloaded');
  assert.equal((await call(ctx, `/api/network/networks/${scratch.id}`)).json.network.name, 'Sketch');
  // Delete an unused, unpublished draft.
  assert.equal($('#network-library-delete').disabled, false);
  $('#network-library-delete').click(); await until(() => $('#network-confirm'), 'delete dialog');
  assert.match($('#network-dialog').textContent, /never published and no network contains it/);
  $('#network-confirm').click();
  await until(() => win.location.hash === '#/network/library' && !listed().includes('Sketch'), 'deleted');
  assert.equal((await call(ctx, `/api/network/networks/${scratch.id}`)).status, 404);
  // Duplicate: a new unpublished draft with the same references.
  await visit(ctx, `#/network/library/${parent.id}`, () => $('#network-library-heading')?.textContent === 'Research team');
  $('#network-library-duplicate').click(); await until(() => $('#network-name-input'), 'duplicate dialog');
  assert.equal($('#network-name-input').value, 'Research team (copy)');
  submit(ctx);
  await until(() => $('#network-library-heading')?.textContent === 'Research team (copy)', 'duplicate shown');
  assert.match($('#network-library-detail').textContent, /Not published/);
  const copy = (await call(ctx, `/api/network/networks/${win.location.hash.split('/')[3]}`)).json.network;
  assert.deepEqual(copy.nodes, parent.nodes);
  // Export downloads the Network file; importing it adds copies, agents arrive switched off, nothing runs.
  $('#network-library-export').click();
  await until(() => ctx.downloads.length === 1, 'downloaded');
  assert.match(ctx.downloads[0], /^promptboard-network-\d{4}-\d{2}-\d{2}\.json$/);
  const exported = JSON.parse(await ctx.blobs.at(-1).text());
  assert.deepEqual([exported.kind, exported.networks.length, exported.agents.length], ['promptboard-network', 4, 5]);
  Object.defineProperty($('#network-library-file'), 'files', { value: [new File([JSON.stringify(exported)], 'network.json', { type: 'application/json' })], configurable: true });
  $('#network-library-file').dispatchEvent(new win.Event('change'));
  await until(() => /Imported 4 networks, 2 published versions and 5 agents \(switched off until you enable them\)\. Nothing ran\./.test($('#network-status').textContent), 'imported');
  await until(() => listed().length === 8, 'copies listed');
  Object.defineProperty($('#network-library-file'), 'files', { value: [new File(['not json'], 'bad.json')], configurable: true });
  $('#network-library-file').dispatchEvent(new win.Event('change'));
  await until(() => /This file is not JSON/.test($('#network-error').textContent), 'a bad file is refused');
  // Network memory lives in the Library detail, through the existing memory routes.
  await visit(ctx, `#/network/library/${child.id}`, () => $('#network-library-heading')?.textContent === 'Review pair');
  await until(() => /No memory yet\./.test($('#network-memory-empty').textContent), 'empty network memory');
  assert.equal($('.network-preview-section').hidden, true, 'no job preview for a network');
  $('#network-memory-add').click(); await until(() => $('#network-memory-form-text'), 'memory form');
  $('#network-memory-form-text').value = 'The pair reviews in English.'; submit(ctx);
  await until(() => $('#network-memory-list .network-record')?.dataset.status === 'proposed', 'proposed');
  $('#network-memory-list [id$="-approve"]').click();
  await until(() => $('#network-memory-list .network-record')?.dataset.status === 'approved', 'approved');
  const memory = (await call(ctx, `/api/network/networks/${child.id}/memory`)).json;
  assert.deepEqual(memory.records.map(record => [record.scope, record.status, record.text]), [[{ kind: 'network', networkId: child.id }, 'approved', 'The pair reviews in English.']]);
});

test('keyboard and phone: every Graph and Library control is named, a phone shows the lists then one node with Back, and the canvas keys work on the draft', async t => {
  const ctx = await setup(t, { hash: '#/' }); const { $, win } = ctx;
  const agents = await seed(ctx);
  const child = await network(ctx, 'Pair', [agentNode(1, agents[2].id)], [], true);
  const net = await network(ctx, 'Team', [agentNode(1, agents[0].id), agentNode(2, agents[1].id), subNode(3, child.id, 1)], [{ id: `e_${pad(1)}`, from: `n_${pad(1)}`, to: `n_${pad(2)}`, relation: 'delegate' }]);
  const named = root => {
    for (const control of root.querySelectorAll('input, select, textarea')) assert.ok(control.labels?.length || control.getAttribute('aria-label'), `${control.id || control.outerHTML.slice(0, 80)} has a label`);
    for (const node of root.querySelectorAll('button')) assert.ok((node.textContent.trim() || node.getAttribute('aria-label') || '').length > 0, `${node.outerHTML.slice(0, 80)} has a name`);
    for (const node of root.querySelectorAll('button:disabled')) assert.ok(node.title || node.getAttribute('aria-describedby'), `${node.id || node.textContent} is disabled with a reason`);
  };
  await visit(ctx, `#/network/library/${net.id}`, () => $('#network-library-heading')?.textContent === 'Team');
  named($('#network-panel-library'));
  await visit(ctx, `#/network/graph/${net.id}`, () => $('#network-graph-heading')?.textContent === 'Team'); await editorReady(ctx, 'Team');
  named($('#network-panel-graph'));
  assert.equal($('#network-tab-graph').getAttribute('aria-controls'), 'network-panel-graph');
  assert.equal($('#network-panel-graph').getAttribute('aria-labelledby'), 'network-tab-graph');
  // A row by keyboard: Enter on a button activates it; focus moves to the details, which name the node and its relations.
  $(`[data-node-id="n_${pad(1)}"]`).focus(); $(`[data-node-id="n_${pad(1)}"]`).click();
  await until(() => win.document.activeElement?.id === 'network-graph-detail-heading' && $('#network-graph-detail-heading').textContent === 'Lead', 'details focused');
  named($('#network-panel-graph'));
  assert.match($('#network-graph-details').textContent, /Delegate → Reviewer/);
  // Canvas keys act on the chosen node even without a drawn canvas: arrows move it, Delete removes it, undo restores.
  const key = name => $('#network-canvas').dispatchEvent(new win.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  key('ArrowRight'); key('ArrowDown');
  await until(() => /Position210,10/.test($('#network-graph-details').textContent.replace(/\s+/g, '')), 'nudged');
  key('Delete'); await until(() => !nodeRows(ctx).includes('Lead') && edgeRows(ctx).length === 0, 'removed with its relation');
  $('#network-graph-undo').click(); await until(() => nodeRows(ctx).includes('Lead') && edgeRows(ctx).length === 1, 'undone');
  // Search narrows the lists; a relation type can be hidden.
  $('#network-graph-search').value = 'rev'; $('#network-graph-search').dispatchEvent(new win.Event('input'));
  await until(() => nodeRows(ctx).join() === 'Reviewer' && $('#network-graph-nodes-title').textContent === 'Nodes (1 of 3)', 'searched');
  $('#network-graph-search').value = ''; $('#network-graph-search').dispatchEvent(new win.Event('input'));
  await until(() => nodeRows(ctx).length === 3, 'search cleared');
  const delegate = $('[data-relation-filter="delegate"]'); delegate.checked = false; delegate.dispatchEvent(new win.Event('change', { bubbles: true }));
  await until(() => edgeRows(ctx).length === 0 && $('#network-graph-edges-title').textContent === 'Relations (0 of 1)', 'delegate hidden');
  delegate.checked = true; delegate.dispatchEvent(new win.Event('change', { bubbles: true }));
  await until(() => edgeRows(ctx).length === 1, 'delegate shown again');
  // What is inside a sub-network, read lazily from its pinned version.
  $(`[data-node-id="n_${pad(3)}"]`).click(); await until(() => $('#network-graph-inside'), 'sub-network details');
  $('#network-graph-inside').click();
  await until(() => /Version 1: 1 node and 0 relations, read only\./.test($('#network-graph-details').textContent) && /Writer/.test($('#network-graph-inside-list').textContent), 'inside shown');
  // Phone width: the lists, then one node's details with Back, which returns focus to its row.
  Object.defineProperty(win, 'innerWidth', { value: 390, configurable: true });
  $(`[data-node-id="n_${pad(2)}"]`).click();
  await until(() => $('#network-panel-graph').dataset.view === 'detail' && win.document.activeElement?.id === 'network-graph-detail-heading', 'details only on a phone');
  $('#network-graph-back').click();
  await until(() => $('#network-panel-graph').dataset.view === 'list' && win.document.activeElement?.dataset.nodeId === `n_${pad(2)}`, 'back to the row');
});
