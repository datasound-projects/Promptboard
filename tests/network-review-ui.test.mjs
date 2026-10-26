// Phase-1 review fixes in the Graph and Library pages (public/network-graph.js inside network.js and app.js), in jsdom
// against the real server: a refused save or publish marks the node that leads to an unreadable version (P1-6). Nothing
// here starts a job, a run or a model call.
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
