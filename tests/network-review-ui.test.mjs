// Phase-1 review fixes in the Graph and Library pages (public/network-graph.js inside network.js and app.js), in jsdom
// against the real server: a refused save or publish marks the node that leads to an unreadable version (P1-6); a publish
// refused by a newer save offers the conflict choices (P1-5). Nothing here starts a job, a run or a model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Base } from '../src/base.mjs';
import { Store } from '../src/store.mjs';
import { NetworkRegistry } from '../src/network/registry.mjs';
import { setup, until } from './helpers/ui-harness.mjs';

const pad = n => String(n).padStart(12, '0');
const sub = (n, networkId, version = 1) => ({ id: `n_${pad(n)}`, type: 'subnetwork', networkId, version, position: { x: n * 200, y: 200 } });
const nodeRows = ctx => [...ctx.$('#network-graph-nodes').querySelectorAll('[data-node-id]')].map(node => node.querySelector('strong').textContent);
const editorReady = (ctx, name) => until(() => ctx.$('#network-graph-heading')?.textContent === name && !ctx.$('#network-panel-graph').hidden && !ctx.$('.network-graph-body').hidden, `${name} open in Graph`);
const problems = ctx => [...ctx.$('#network-graph-nodes').querySelectorAll('.is-problem')].map(node => node.querySelector('strong').textContent);
const removeButtons = ctx => [...ctx.$('#network-graph-alert').querySelectorAll('[data-remove-node]')].map(node => node.textContent);

/** The app on a data folder prepared beforehand; the folder is removed after the app closed. */
async function appOn(t, dataDir, hash) {
  const ctx = await setup(t, { dataDir, hash });
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return ctx;
}
/** Networks prepared on disk before the app starts: C v1, B v1 pinning C v1, A pinning B v1 (draft), D empty; C v1 then damaged. */
async function damagedChain() {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-ui-review-'));
  const registry = new NetworkRegistry({ dataDir, base: new Base({ store: new Store(dataDir) }) });
  const c = (await registry.createNetwork({ name: 'C' })).network; await registry.publishNetwork(c.id, { expectedRevision: 1 });
  const b = (await registry.createNetwork({ name: 'B', nodes: [sub(1, c.id)] })).network; await registry.publishNetwork(b.id, { expectedRevision: 1 });
  const a = (await registry.createNetwork({ name: 'A', nodes: [sub(1, b.id)] })).network;
  const d = (await registry.createNetwork({ name: 'D' })).network;
  const folder = join(dataDir, 'network', 'networks', c.id.replace('_', '__')), [name] = (await readdir(folder)).filter(item => item.endsWith('.json'));
  await writeFile(join(folder, name), `${await readFile(join(folder, name), 'utf8')} `);
  return { dataDir, a, b, c, d };
}

test('P1-6: a save that adds a pin leading to an unreadable version names and marks that node, and offers to remove it', async t => {
  const { dataDir, b, d } = await damagedChain();
  const ctx = await appOn(t, dataDir, `#/network/graph/${d.id}`); const { $ } = ctx;
  await editorReady(ctx, 'D');
  $('#network-graph-add-subnetwork').click(); await until(() => $('#network-pick-network'), 'sub-network dialog');
  const pick = $('#network-pick-network'); pick.value = b.id; pick.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
  $('#network-pick-add').click(); await until(() => nodeRows(ctx).includes('B'), 'B added');
  $('#network-graph-save').click();
  await until(() => !$('#network-graph-alert').hidden, 'refused');
  assert.match($('#network-graph-alert').textContent, /failed its integrity check.*It is reached through the sub-network “B”: remove that node/);
  assert.deepEqual([problems(ctx), removeButtons(ctx)], [['B'], ['Remove “B”']]);
  $('#network-graph-alert [data-remove-node]').click();
  await until(() => !nodeRows(ctx).length && $('#network-graph-alert').hidden, 'removed');
});

async function call(ctx, path, method = 'GET', body) {
  const response = await fetch(`${ctx.app.url}${path}`, { method, headers: { 'X-STE-Token': ctx.win.__pbTest.token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return response.json();
}
const dialogOpen = ctx => Boolean(ctx.$('#network-dialog')?.open);
async function publish(ctx) {
  ctx.$('#network-graph-publish').click(); await until(() => ctx.$('#network-confirm'), 'publish dialog');
  ctx.$('#network-confirm').click();
}

test('P1-5: a publish refused by a newer save closes the dialog and offers loading the saved draft or keeping this as a new network; Publish waits until then', async t => {
  const ctx = await setup(t, { hash: '#/' }); const { $ } = ctx;
  const solo = (await call(ctx, '/api/network/networks', 'POST', { name: 'Solo' })).network;
  ctx.win.location.hash = `#/network/graph/${solo.id}`; await editorReady(ctx, 'Solo');
  await call(ctx, `/api/network/networks/${solo.id}`, 'PATCH', { expectedRevision: 1, description: 'Saved in another tab' });
  await publish(ctx);
  await until(() => !dialogOpen(ctx) && $('#network-graph-reload') && $('#network-graph-save-new'), 'the conflict choices in the editor');
  assert.match($('#network-graph-alert').textContent, /changed since you loaded it.*so nothing was published\./);
  assert.deepEqual([$('#network-graph-publish').disabled, $('#network-graph-save').disabled], [true, true], 'Publish and Save wait for a choice');
  assert.match($('#network-graph-publish').title, /saved elsewhere: load the saved draft, or save yours as a new network, first/);
  assert.equal((await call(ctx, `/api/network/networks/${solo.id}`)).network.publishedVersions.length, 0);
  $('#network-graph-reload').click();
  await until(() => $('#network-graph-alert').hidden && !$('#network-graph-publish').disabled && $('#network-graph-meta').textContent.includes('revision 2'), 'the saved draft loaded');
  await publish(ctx);
  await until(() => $('#network-graph-versions [data-version="1"]')?.textContent === 'v1 · latest', 'published v1');
});

test('P1-6: a publish refused because a pinned version deep inside cannot be read marks the node that leads to it', async t => {
  const { dataDir, a } = await damagedChain();
  const ctx = await appOn(t, dataDir, `#/network/graph/${a.id}`); const { $ } = ctx;
  await editorReady(ctx, 'A');
  await publish(ctx);
  await until(() => !dialogOpen(ctx) && !$('#network-graph-alert').hidden, 'refused in the editor');
  assert.match($('#network-graph-alert').textContent, /It is reached through the sub-network “B”.*Nothing was published\./);
  assert.deepEqual([problems(ctx), removeButtons(ctx)], [['B'], ['Remove “B”']]);
});

test('Unconfirmed: Add sub-network searches past the first 200 networks; a version shows the name it was published with; declining the unsaved question adds no history entry', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-ui-review-'));
  let clock = 1_800_000_000_000;
  const registry = new NetworkRegistry({ dataDir, base: new Base({ store: new Store(dataDir) }), now: () => (clock += 1000) });
  const host = (await registry.createNetwork({ name: 'Host' })).network;
  for (let n = 0; n < 200; n++) await registry.createNetwork({ name: `Draft ${n}` });
  const needle = (await registry.createNetwork({ name: 'Needle' })).network;
  await registry.publishNetwork(needle.id, { expectedRevision: 1 });
  await registry.updateNetwork(needle.id, { expectedRevision: 2, name: 'Needle renamed' });
  const ctx = await appOn(t, dataDir, `#/network/graph/${host.id}`); const { $, win } = ctx;
  await editorReady(ctx, 'Host');
  // The first page (200 of 202) has no published network; the search finds the 202nd.
  $('#network-graph-add-subnetwork').click(); await until(() => $('#network-pick-network-search'), 'the dialog with a search');
  assert.equal($('#network-pick-network-status').textContent, 'The first 200 of 202 networks. Search to find the others.');
  assert.equal($('#network-pick-add').disabled, true, 'nothing on the first page can be added');
  const search = $('#network-pick-network-search'); search.value = 'needle'; search.dispatchEvent(new win.Event('input', { bubbles: true }));
  await until(() => $('#network-pick-network').value === needle.id, 'found by the server search');
  assert.deepEqual([$('#network-pick-version').value, $('#network-pick-add').disabled, $('#network-pick-network-status').textContent], ['1', false, '']);
  $('#network-pick-add').click(); await until(() => nodeRows(ctx).includes('Needle renamed'), 'added');
  // Declining the question: the editor's address comes back in place, so Back never leads to the declined page.
  const asked = []; win.confirm = text => { asked.push(text); return false; };
  const length = win.history.length;
  win.location.hash = '#/network/library';
  await until(() => win.location.hash === `#/network/graph/${host.id}` && !$('#network-panel-graph').hidden, 'kept editing');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual([asked.length, win.history.length, nodeRows(ctx)], [1, length + 1, ['Needle renamed']], 'only the navigation itself is in the history');
  win.confirm = () => true;
  // A published version keeps its own name, whatever the draft is called now.
  win.location.hash = `#/network/graph/${needle.id}/v1`;
  await until(() => $('#network-graph-heading')?.textContent === 'Needle · version 1', 'the version under its published name');
});
