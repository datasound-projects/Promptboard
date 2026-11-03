// Network graphs and the Library (src/network/registry.mjs, http.mjs; Task 05): a 3-agent network with a pinned
// 2-agent sub-network saved and read back after a restart, one sub-network version reused by two parents as a reference
// only, indirect containment cycles refused with the path and the draft unchanged, delete refused while anything uses or
// may pin a network (archive instead), duplicate and rename, issues for agents that cannot take work and for outdated or
// unreadable pins, and the routes over the real server. Real Base and Store on temporary data folders; nothing runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Base } from '../src/base.mjs';
import { Store } from '../src/store.mjs';
import { NetworkRegistry } from '../src/network/registry.mjs';
import { startServer } from '../src/server.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pad = n => String(n).padStart(12, '0');
const agentNode = (n, agentId, x = n * 180, y = 40) => ({ id: `n_${pad(n)}`, type: 'agent', agentId, position: { x, y } });
const subNode = (n, networkId, version, x = n * 180, y = 260) => ({ id: `n_${pad(n)}`, type: 'subnetwork', networkId, version, position: { x, y } });
const edge = (n, from, to, relation = 'message') => ({ id: `e_${pad(n)}`, from: `n_${pad(from)}`, to: `n_${pad(to)}`, relation });

/** A data folder with a real Base of five agents, each registered once; `open()` is a restart on the same folder. */
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-network-graph-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const base = new Base({ store: new Store(dataDir) });
  for (const [index, name] of ['Lead', 'Reviewer', 'Writer', 'Researcher', 'Checker'].entries()) await base.create({ id: `b${index}`, kind: 'profile', name, configuration: { agent: { provider: index % 2 ? 'codex' : 'claude', instructions: `SECRET-PROMPT-${name}` } } });
  const open = () => new NetworkRegistry({ dataDir, base: new Base({ store: new Store(dataDir) }), projects: async () => [] });
  const registry = open(), agents = [];
  for (const index of [0, 1, 2, 3, 4]) agents.push((await registry.registerAgent({ baseResourceId: `b${index}`, expectedRevision: index })).agent);
  const file = (...parts) => join(dataDir, 'network', ...parts);
  return { dataDir, base, open, registry, agents, file, draftFile: id => file('networks', `${id.replace('_', '__')}.json`) };
}
/** A published 2-agent network (Researcher → Checker) and a draft of 3 agents that pins it. */
async function nested(registry, agents) {
  const child = (await registry.createNetwork({ name: 'Review pair', nodes: [agentNode(1, agents[3].id, 0, 0), agentNode(2, agents[4].id, 220, 0)], edges: [edge(1, 1, 2, 'share_result')] })).network;
  await registry.publishNetwork(child.id, { expectedRevision: 1 });
  const nodes = [agentNode(1, agents[0].id, 10, 20), agentNode(2, agents[1].id, 270.5, -80), agentNode(3, agents[2].id, 270, 95), subNode(4, child.id, 1, 560, 0)];
  const edges = [edge(1, 1, 2, 'delegate'), edge(2, 1, 3, 'message'), edge(3, 3, 4, 'share_result'), edge(4, 2, 1, 'message')];
  const parent = await registry.createNetwork({ name: 'Research team', description: 'Three agents and a review pair.', nodes, edges });
  return { child, parent, nodes, edges };
}

test('a 3-agent network with a pinned 2-agent sub-network saves and reads back the same after a restart, with refs and no issues', async t => {
  const { registry, agents, open, draftFile } = await fixture(t);
  const { child, parent, nodes, edges } = await nested(registry, agents);
  assert.deepEqual([parent.network.nodes, parent.network.edges], [nodes, edges], 'positions (including a fraction), relations and IDs are kept exactly');
  assert.deepEqual(parent.refs.networks[child.id], { name: 'Review pair', archived: false, versions: [1], pinned: { nodes: 2, edges: 1 } });
  assert.deepEqual(Object.values(parent.refs.agents).map(ref => [ref.name, ref.provider, ref.enabled, ref.stale]), [['Lead', 'claude', true, false], ['Reviewer', 'codex', true, false], ['Writer', 'claude', true, false]]);
  assert.deepEqual([parent.issues, parent.usedBy], [[], []]);
  // Moving nodes is one save of the whole draft (the editor batches every drag into it).
  const moved = nodes.map((node, index) => ({ ...node, position: { x: node.position.x + index, y: node.position.y - index } }));
  const saved = await registry.updateNetwork(parent.network.id, { expectedRevision: 1, nodes: moved, edges });
  assert.equal(saved.network.revision, 2);
  const again = open(), reread = await again.networkDetail(parent.network.id);
  assert.deepEqual([reread.network.nodes, reread.network.edges, reread.network.revision], [moved, edges, 2], 'a restart reads the same positions and relations');
  assert.deepEqual(reread.refs, saved.refs);
  const stored = JSON.parse(await readFile(draftFile(parent.network.id), 'utf8'));
  assert.deepEqual([stored.nodes, stored.edges], [moved, edges]);
  // The version endpoint answers the immutable version plus refs that are computed, never stored in it.
  const { version, refs } = await again.version(child.id, 1);
  assert.deepEqual([version.nodes.length, Object.values(refs.agents).map(ref => ref.name)], [2, ['Researcher', 'Checker']]);
  assert.equal('refs' in JSON.parse(await readFile(join(draftFile(child.id).replace(/\.json$/, ''), (await readdir(draftFile(child.id).replace(/\.json$/, '')))[0]), 'utf8')), false);
});

test('one sub-network version is reused by two parents as a reference: nothing of it is copied; Used by lists both; a duplicate keeps references', async t => {
  const { registry, agents, file, draftFile } = await fixture(t);
  const { child, parent } = await nested(registry, agents);
  const second = (await registry.createNetwork({ name: 'Writers', nodes: [agentNode(1, agents[2].id), subNode(2, child.id, 1)], edges: [edge(1, 1, 2, 'delegate')] })).network;
  await registry.publishNetwork(second.id, { expectedRevision: 1 });
  for (const id of [parent.network.id, second.id]) {
    const text = await readFile(draftFile(id), 'utf8'), stored = JSON.parse(text), pin = stored.nodes.find(node => node.type === 'subnetwork');
    assert.deepEqual(Object.keys(pin).sort(), ['id', 'networkId', 'position', 'type', 'version'], 'a pin holds only the network ID and the version number');
    assert.deepEqual([pin.networkId, pin.version], [child.id, 1]);
    for (const copied of [agents[3].id, agents[4].id, 'Review pair', 'Researcher', 'SECRET-PROMPT']) assert.doesNotMatch(text, new RegExp(copied), `${copied} is not copied into the parent`);
  }
  const versionFolders = (await readdir(file('networks'), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  assert.equal((await readdir(file('networks', child.id.replace('_', '__')))).length, 1, 'the child exists once: one version file');
  assert.equal(versionFolders.length, 2, 'only the child and the published parent have version folders');
  const detail = await registry.networkDetail(child.id);
  assert.deepEqual(detail.usedBy.map(use => [use.name, use.draft, use.versions]).sort(), [['Research team', 1, []], ['Writers', 1, [{ version: 1, pins: 1 }]]]);
  // Duplicate: a new unpublished draft with the same pins and agents (IDs only), a free name, nothing copied by value.
  const copy = await registry.duplicateNetwork(parent.network.id, {});
  assert.notEqual(copy.network.id, parent.network.id);
  assert.deepEqual([copy.network.name, copy.network.publishedVersions, copy.network.revision], ['Research team (copy)', [], 1]);
  assert.deepEqual([copy.network.nodes, copy.network.edges], [parent.network.nodes, parent.network.edges]);
  assert.equal((await registry.duplicateNetwork(parent.network.id, {})).network.name, 'Research team (copy) (2)');
  const published = await registry.duplicateNetwork(second.id, {});
  assert.deepEqual([published.network.publishedVersions, published.network.nodes], [[], second.nodes], 'a copy of a published network starts unpublished');
  await assert.rejects(registry.duplicateNetwork(parent.network.id, { name: 'writers' }), { code: 'NETWORK_NAME_TAKEN' });
  await assert.rejects(registry.duplicateNetwork(parent.network.id, { name: 'X', nodes: [] }), { code: 'INVALID_INPUT' });
  assert.equal((await registry.networkDetail(child.id)).usedBy.length, 5, 'the copies use the same child version');
  // Rename changes the draft only; the published version keeps the name it was published with.
  await registry.updateNetwork(second.id, { expectedRevision: 2, name: 'Writers room', description: 'Renamed' });
  assert.deepEqual([(await registry.network(second.id)).network.name, (await registry.version(second.id, 1)).version.name], ['Writers room', 'Writers']);
});

test('indirect containment cycles are refused with the path; the draft is unchanged; delete is refused while anything uses or may pin a network', async t => {
  const { registry, agents, file, draftFile, open } = await fixture(t);
  const make = async (name, nodes = []) => { const { network } = await registry.createNetwork({ name, nodes }); await registry.publishNetwork(network.id, { expectedRevision: 1 }); return network.id; };
  const a = await make('A', [agentNode(1, agents[0].id)]);
  const c = await make('C', [subNode(1, a, 1)]);            // C v1 contains A v1
  const b = await make('B', [subNode(1, c, 1)]);            // B v1 contains C v1
  const before = await readFile(draftFile(a));
  const error = await registry.updateNetwork(a, { expectedRevision: 2, nodes: [agentNode(1, agents[0].id), subNode(2, b, 1)] }).then(() => null, reason => reason);
  assert.deepEqual([error?.code, error?.status, error?.details], ['NETWORK_CYCLE', 400, { path: [a, b, c, a] }]);
  assert.match(error.message, /A network cannot contain itself: A → B → C → A\. Remove the sub-network “B” from this network/);
  assert.deepEqual(await readFile(draftFile(a)), before, 'the refused draft is byte-identical');
  await assert.rejects(registry.duplicateNetwork(a, {}).then(copy => registry.updateNetwork(copy.network.id, { expectedRevision: 1, nodes: [subNode(1, copy.network.id, 1)] })), { code: 'NETWORK_CYCLE', message: /A \(copy\) → A \(copy\)/ }, 'a copy cannot pin itself');

  // Delete: used by a parent's draft → refused, with where; used only by a published version → archive only.
  const used = await registry.networkDetail(c);
  const refused = await registry.deleteNetwork(c, { expectedRevision: used.network.revision }).then(() => null, reason => reason);
  assert.deepEqual([refused.code, refused.status, refused.details.usedBy.map(use => [use.networkId, use.draft, use.versions])], ['NETWORK_IN_USE', 409, [[b, 1, [{ version: 1, pins: 1 }]]]]);
  assert.match(refused.message, /“C” is a sub-network of “B” \(draft, v1\)\. Published versions never change, so it can only be archived\./);
  await registry.updateNetwork(b, { expectedRevision: 2, nodes: [] });
  const still = await registry.deleteNetwork(c, { expectedRevision: used.network.revision }).then(() => null, reason => reason);
  assert.deepEqual([still.code, still.details.usedBy[0].draft], ['NETWORK_IN_USE', null], 'the published B v1 keeps pinning C for good');
  // Published but unused → refused (a later run may pin it); a stale revision → conflict; an unpublished, unused draft → deleted.
  const lone = (await registry.createNetwork({ name: 'Lone' })).network;
  await registry.publishNetwork(lone.id, { expectedRevision: 1 });
  await assert.rejects(registry.deleteNetwork(lone.id, { expectedRevision: 2 }), { code: 'NETWORK_PUBLISHED', status: 409, message: /Archive it instead/ });
  const scratch = (await registry.createNetwork({ name: 'Scratch', nodes: [agentNode(1, agents[1].id)] })).network;
  await registry.updateNetwork(scratch.id, { expectedRevision: 1, description: 'second save makes a backup' });
  await registry.memory.propose('network', scratch.id, { expectedRevision: 0, kind: 'fact', text: 'Scratch memory stays.' });
  await assert.rejects(registry.deleteNetwork(scratch.id, { expectedRevision: 1 }), { code: 'REVISION_CONFLICT' });
  await assert.rejects(registry.deleteNetwork(scratch.id, {}), { code: 'REVISION_REQUIRED' });
  assert.deepEqual(await registry.deleteNetwork(scratch.id, { expectedRevision: 2 }), { deleted: { id: scratch.id, name: 'Scratch' } });
  const names = await readdir(file('networks'));
  assert.equal(names.some(name => name === `${scratch.id.replace('_', '__')}.json` || name === `${scratch.id.replace('_', '__')}.json.bak`), false, 'the draft and its backup are gone from where drafts are read');
  assert.equal(names.filter(name => name.startsWith(scratch.id.replace('_', '__')) && /\.deleted-\d+-[0-9a-f]{8}$/.test(name)).length, 2, 'both are set aside, recoverable by hand');
  assert.ok((await readdir(file('memory'))).some(name => name.includes(scratch.id.replace('_', '__'))), 'its memory file stays');
  await assert.rejects(registry.network(scratch.id), { code: 'NOT_FOUND' });
  await assert.rejects(open().network(scratch.id), { code: 'NOT_FOUND' }, 'a restart does not bring it back');
  assert.deepEqual((await open().listNetworks()).networks.map(item => item.name).sort(), ['A', 'A (copy)', 'B', 'C', 'Lone']);
  // A network that cannot be read might use it: delete fails closed.
  const other = (await registry.createNetwork({ name: 'Other' })).network;
  await writeFile(draftFile(lone.id), '{ damaged'); await writeFile(`${draftFile(lone.id)}.bak`, '{ damaged');
  await assert.rejects(open().deleteNetwork(other.id, { expectedRevision: 1 }), { code: 'NETWORK_DATA_DAMAGED', details: { networkIds: [lone.id] } });
});

test('archive hides a network from lists while every pin of it keeps working; restore, export and import keep the flag', async t => {
  const { registry, agents, open, base } = await fixture(t);
  const { child, parent } = await nested(registry, agents);
  const archived = await registry.updateNetwork(child.id, { expectedRevision: 2, archived: true });
  assert.equal(archived.network.archived, true);
  assert.deepEqual((await registry.listNetworks()).networks.map(item => item.name), ['Research team'], 'hidden from the default list');
  assert.deepEqual((await registry.listNetworks({ archived: 'true' })).networks.map(item => [item.name, item.archived]), [['Review pair', true], ['Research team', false]]);
  await assert.rejects(registry.listNetworks({ archived: 'yes' }), { code: 'INVALID_INPUT' });
  await assert.rejects(registry.updateNetwork(child.id, { expectedRevision: 3, archived: 'no' }), { code: 'INVALID_INPUT' });
  assert.equal((await registry.version(child.id, 1)).version.nodes.length, 2, 'its versions stay readable');
  const detail = await registry.updateNetwork(parent.network.id, { expectedRevision: 1, description: 'still saves with an archived pin' });
  assert.deepEqual(detail.issues.map(issue => [issue.code, issue.nodeId]), [['SUBNETWORK_ARCHIVED', `n_${pad(4)}`]]);
  assert.match(detail.issues[0].message, /“Review pair” is archived\. Its pinned version 1 keeps working/);
  const exported = await registry.export();
  assert.equal(exported.networks.find(item => item.id === child.id).archived, true);
  // Import into an empty folder with the same Base: the flag comes back; a value other than true is refused whole.
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-network-graph-import-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const target = new NetworkRegistry({ dataDir, base, projects: async () => [] });
  await assert.rejects(target.import({ data: { ...exported, networks: exported.networks.map(item => ({ ...item, archived: false })) }, expectedRevision: 0 }), { code: 'NETWORK_IMPORT_INVALID' });
  await target.import({ data: exported, expectedRevision: 0 });
  assert.deepEqual((await target.listNetworks({ archived: 'true' })).networks.map(item => [item.name, item.archived]), [['Review pair', true], ['Research team', false]]);
  const restored = await registry.updateNetwork(child.id, { expectedRevision: 3, archived: false });
  assert.equal('archived' in restored.network, false, 'restored drafts carry no flag');
  assert.deepEqual((await open().listNetworks()).networks.map(item => item.name), ['Review pair', 'Research team']);
});

test('issues name agents that cannot take work and pins that are outdated or unreadable; saving still works and starts nothing', async t => {
  const { dataDir, registry, agents, draftFile } = await fixture(t);
  const { child, parent } = await nested(registry, agents);
  await registry.updateNetwork(child.id, { expectedRevision: 2, description: 'v2' });
  await registry.publishNetwork(child.id, { expectedRevision: 3 });
  await registry.updateAgent(agents[1].id, { expectedRevision: 1, enabled: false });
  const writer = (await registry.base.list()).resources.find(item => item.id === 'b2');
  await registry.base.update('b2', { enabled: false }, { expectedRevision: writer.revision }); // The registry's own Base, as in the app.
  const detail = await registry.networkDetail(parent.network.id);
  assert.deepEqual(detail.issues.map(issue => [issue.code, issue.nodeId]), [['AGENT_DISABLED', `n_${pad(2)}`], ['AGENT_STALE', `n_${pad(3)}`], ['SUBNETWORK_OUTDATED', `n_${pad(4)}`]]);
  assert.match(detail.issues[0].message, /“Reviewer” is switched off in Network\. Switch it on in its profile, or remove it from this network\./);
  assert.match(detail.issues[1].message, /“Writer” cannot take work: its Base agent is switched off\. Fix it in Base, or remove it from this network\./);
  assert.deepEqual([detail.issues[2].latest, detail.issues[2].version], [2, 1]);
  assert.deepEqual([detail.refs.agents[agents[1].id].enabled, detail.refs.agents[agents[2].id].staleReason], [false, 'disabled']);
  // A pinned version whose file no longer matches its hash: the detail still answers and says so; a change that adds no
  // reference still saves (Phase-1 review P1-6), publishing is refused and names the node.
  const folder = draftFile(child.id).replace(/\.json$/, ''), v1 = (await readdir(folder)).find(name => name.startsWith('v1-'));
  await writeFile(join(folder, v1), (await readFile(join(folder, v1), 'utf8')).replace('Review pair', 'Tampered pair'));
  const fresh = new NetworkRegistry({ dataDir, base: registry.base, projects: async () => [] });
  const damaged = await fresh.networkDetail(parent.network.id);
  assert.deepEqual([damaged.refs.networks[child.id].pinned, damaged.issues.at(-1).code], [null, 'SUBNETWORK_UNAVAILABLE']);
  assert.equal((await fresh.updateNetwork(parent.network.id, { expectedRevision: 1, description: 'x' })).network.description, 'x');
  await assert.rejects(fresh.publishNetwork(parent.network.id, { expectedRevision: 2 }), { code: 'NETWORK_CONTENT_INVALID', details: { networkId: child.id, version: 1, path: [parent.network.id, child.id] } });
  assert.equal((await fresh.networkDetail(child.id)).usedByUnknown.length, 0);
});

test('graph routes over the real server: detail, duplicate, archive, delete and the version view; refusals are fixed messages; nothing runs', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-network-graph-http-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  let runs = 0;
  const app = await startServer({ port: 0, dataDir, executor: null, catalogReader: async provider => ({ provider, source: 'test fixture', models: [] }), runner: async () => { runs++; throw new Error('no CLI'); }, researchRunner: async () => { runs++; throw new Error('no CLI'); } });
  t.after(() => app.close());
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = async (path, method = 'GET', body, headers = { 'X-STE-Token': token }) => { const response = await fetch(`${app.url}${path}`, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, json: await response.json() }; };
  await app.board.base.create({ id: 'lead', kind: 'profile', name: 'Lead', configuration: { agent: { provider: 'claude' } } });
  await app.board.base.create({ id: 'checker', kind: 'profile', name: 'Checker', configuration: { agent: { provider: 'codex' } } });
  const lead = (await call('/api/network/agents', 'POST', { baseResourceId: 'lead', expectedRevision: 0 })).json.agent;
  const checker = (await call('/api/network/agents', 'POST', { baseResourceId: 'checker', expectedRevision: 1 })).json.agent;
  const stateBefore = await readFile(join(dataDir, 'state.json'));
  const child = (await call('/api/network/networks', 'POST', { name: 'Child', nodes: [agentNode(1, checker.id)] })).json;
  assert.deepEqual([child.issues, child.usedBy, Object.keys(child.refs.agents)], [[], [], [checker.id]], 'create answers the detail');
  assert.equal((await call(`/api/network/networks/${child.network.id}/publish`, 'POST', { expectedRevision: 1 })).json.published.version, 1);
  const parent = (await call('/api/network/networks', 'POST', { name: 'Parent', nodes: [agentNode(1, lead.id), subNode(2, child.network.id, 1)], edges: [edge(1, 1, 2, 'delegate')] })).json.network;
  const detail = await call(`/api/network/networks/${child.network.id}`);
  assert.deepEqual([detail.status, detail.json.usedBy.map(use => use.networkId)], [200, [parent.id]]);
  const version = await call(`/api/network/networks/${child.network.id}/versions/1`);
  assert.deepEqual([version.json.version.number, version.json.refs.agents[checker.id].name], [1, 'Checker']);
  // Delete refusals carry fixed messages and IDs only; a stale revision is a conflict; missing ones 404.
  const inUse = await call(`/api/network/networks/${child.network.id}`, 'DELETE', { expectedRevision: 2 });
  assert.deepEqual([inUse.status, inUse.json.code, inUse.json.details.usedBy[0].networkId], [409, 'NETWORK_IN_USE', parent.id]);
  assert.doesNotMatch(JSON.stringify(inUse.json), new RegExp(dataDir.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')), 'no data-folder path in an answer');
  assert.equal((await call(`/api/network/networks/${parent.id}`, 'DELETE', { expectedRevision: 9 })).json.code, 'REVISION_CONFLICT');
  assert.equal((await call(`/api/network/networks/net_${'0'.repeat(20)}`, 'DELETE', { expectedRevision: 1 })).status, 404);
  assert.equal((await call(`/api/network/networks/${parent.id}`, 'DELETE', { expectedRevision: 1 }, {})).status, 403, 'no token, no delete');
  assert.equal((await call(`/api/network/networks/${parent.id}/duplicate`, 'POST', {}, {})).status, 403);
  const copy = await call(`/api/network/networks/${parent.id}/duplicate`, 'POST', { name: 'Parent copy' });
  assert.deepEqual([copy.status, copy.json.network.name, copy.json.network.nodes], [200, 'Parent copy', parent.nodes]);
  assert.equal((await call(`/api/network/networks/${parent.id}/duplicate`, 'POST', { name: 'parent copy' })).json.code, 'NETWORK_NAME_TAKEN');
  assert.equal((await call(`/api/network/networks/${copy.json.network.id}`, 'DELETE', { expectedRevision: 1 })).json.deleted.id, copy.json.network.id);
  assert.equal((await call(`/api/network/networks/${parent.id}`, 'PATCH', { expectedRevision: 1, archived: true })).json.network.archived, true);
  assert.deepEqual((await call('/api/network/networks')).json.networks.map(item => item.name), ['Child']);
  assert.deepEqual((await call('/api/network/networks?archived=true')).json.networks.map(item => item.name), ['Child', 'Parent']);
  assert.equal((await call('/api/network/networks?archived=maybe')).status, 400);
  // Saving, publishing, duplicating, archiving and deleting graphs touched only network/: no job, run or model call.
  assert.equal(runs, 0);
  assert.deepEqual(await readFile(join(dataDir, 'state.json')), stateBefore, 'state.json is byte-identical');
  const files = (await readdir(join(dataDir, 'network'), { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => relative(join(dataDir, 'network'), join(entry.parentPath, entry.name)));
  assert.ok(files.every(name => /^(agents\.json|networks)/.test(name)), `only registrations and networks: ${files}`);
  assert.equal(sha(await readFile(join(dataDir, 'state.json'))), sha(stateBefore));
});
