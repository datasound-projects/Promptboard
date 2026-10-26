// Network registry (src/network/registry.mjs): registrations reference Base agents by ID only, networks keep a draft and
// immutable published versions, containment cycles are refused, damaged and newer files fail closed, and export/import
// remaps references safely. Real Base and Store on temporary data folders; nothing here starts a process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Base } from '../src/base.mjs';
import { Store } from '../src/store.mjs';
import { NetworkRegistry } from '../src/network/registry.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pad = n => String(n).padStart(12, '0');
const agentNode = (n, agentId) => ({ id: `n_${pad(n)}`, type: 'agent', agentId, position: { x: n * 100, y: 0 } });
const subNode = (n, networkId, version) => ({ id: `n_${pad(n)}`, type: 'subnetwork', networkId, version, position: { x: n * 100, y: 200 } });
const edge = (n, from, to, relation = 'message') => ({ id: `e_${pad(n)}`, from: `n_${pad(from)}`, to: `n_${pad(to)}`, relation });
const STORED = ['baseResourceId', 'capabilities', 'createdAt', 'displayName', 'enabled', 'id', 'projectAllowlist', 'revision', 'tags', 'updatedAt', 'visibility'];

/** A data folder with a real Base: two agents, an agent profile led by `lead`, and a knowledge resource (not an agent). */
async function fixture(t, { projects = ['p1', 'p2'] } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-network-registry-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const base = new Base({ store: new Store(dataDir) });
  await base.create({ id: 'lead', kind: 'profile', name: 'Lead', configuration: { agent: { provider: 'claude', model: 'sonnet', instructions: 'Lead the research.' } } });
  await base.create({ id: 'reviewer', kind: 'profile', name: 'Reviewer', configuration: { agent: { provider: 'codex', effort: 'low' } } });
  await base.create({ id: 'team', kind: 'agentProfile', name: 'Team', configuration: { agents: [{ resourceId: 'lead', role: 'primary' }, { resourceId: 'reviewer', role: 'supporting' }] } });
  await base.create({ id: 'notes', kind: 'knowledge', name: 'Notes', content: { body: 'Facts.' } });
  // A restart: new Store, Base and registry instances on the same folder.
  const open = ({ fresh = false } = {}) => new NetworkRegistry({ dataDir, base: fresh ? new Base({ store: new Store(dataDir) }) : base, projects: async () => projects });
  return { dataDir, base, open, registry: open(), file: (...parts) => join(dataDir, 'network', ...parts) };
}
const register = (registry, baseResourceId, expectedRevision, extra = {}) => registry.registerAgent({ baseResourceId, expectedRevision, ...extra }).then(result => result.agent);
const draftFile = (file, id) => file('networks', `${id.replace('_', '__')}.json`);
const versionFile = (file, id, number, hash) => file('networks', id.replace('_', '__'), `v${number}-${hash}.json`);

test('registering a Base agent and an agent profile keeps only the Base ID; Base and state.json are untouched', async t => {
  const { dataDir, base, registry, file } = await fixture(t);
  const stateBefore = await readFile(join(dataDir, 'state.json')), baseRevision = (await base.list()).revision;
  const lead = await register(registry, 'lead', 0, { displayName: '  Research lead ', tags: ['research', 'research'], capabilities: ['web'], projectAllowlist: ['p1'] });
  assert.match(lead.id, /^agt_[0-9a-f]{20}$/);
  assert.deepEqual([lead.displayName, lead.tags, lead.capabilities, lead.enabled, lead.visibility, lead.projectAllowlist, lead.revision], ['Research lead', ['research'], ['web'], true, 'private', ['p1'], 1]);
  assert.deepEqual([lead.base.kind, lead.base.name, lead.base.provider, lead.base.model, lead.base.stale], ['profile', 'Lead', 'claude', 'sonnet', false]);
  const team = await register(registry, 'team', 1);
  assert.deepEqual([team.base.kind, team.base.provider, team.base.model, team.base.stale], ['agentProfile', 'claude', 'sonnet', false], 'an agent profile shows its primary agent');
  const text = await readFile(file('agents.json'), 'utf8'), stored = JSON.parse(text);
  assert.deepEqual([stored.schema, stored.version, stored.revision], ['promptboard.network-agents', 1, 2]);
  assert.deepEqual(stored.rows.map(row => Object.keys(row).sort()), [STORED, STORED], 'only Network fields are stored');
  assert.doesNotMatch(text, /sonnet|claude|Lead the research/, 'nothing of the Base definition is copied');
  assert.deepEqual(await readFile(join(dataDir, 'state.json')), stateBefore, 'state.json is byte-identical');
  assert.equal((await base.list()).revision, baseRevision, 'Base revision unchanged');
  // The same Base agent may back a second registration (another scope); Base settings are never accepted here.
  assert.equal((await register(registry, 'lead', 2, { projectAllowlist: ['p2'] })).baseResourceId, 'lead');
  await assert.rejects(registry.registerAgent({ baseResourceId: 'lead', expectedRevision: 3, model: 'opus' }), { code: 'INVALID_INPUT', message: /come from the Base agent/ });
  await assert.rejects(registry.registerAgent({ baseResourceId: 'lead', expectedRevision: 3, visibility: 'public' }), { code: 'INVALID_INPUT' });
  await assert.rejects(registry.registerAgent({ baseResourceId: 'lead', expectedRevision: 3, projectAllowlist: ['gone'] }), { code: 'PROJECT_NOT_FOUND' });
  await assert.rejects(registry.registerAgent({ baseResourceId: 'lead' }), { code: 'REVISION_REQUIRED' });
  await assert.rejects(registry.updateAgent(lead.id, { expectedRevision: 1, baseResourceId: 'reviewer' }), { code: 'INVALID_INPUT' }, 'a registration keeps its Base agent');
  assert.equal(JSON.parse(await readFile(file('agents.json'), 'utf8')).revision, 3, 'refused changes wrote nothing');
});

test('a Base edit shows through the reference at once; agents.json is not rewritten', async t => {
  const { base, registry, file } = await fixture(t);
  const lead = await register(registry, 'lead', 0), team = await register(registry, 'team', 1);
  const before = await readFile(file('agents.json'));
  await base.update('lead', { configuration: { agent: { provider: 'claude', model: 'opus', effort: 'high' } } }, { expectedRevision: 1 });
  const view = (await registry.agent(lead.id)).agent;
  assert.deepEqual([view.base.model, view.base.effort, view.base.revision], ['opus', 'high', 2]);
  assert.equal((await registry.agent(team.id)).agent.base.model, 'opus', 'the profile follows its primary agent');
  assert.deepEqual(await readFile(file('agents.json')), before);
});

test('missing or non-agent Base resources are refused; disabled, untrusted and deleted ones make a registration stale, never removed', async t => {
  const { base, registry, file } = await fixture(t);
  for (const id of ['ghost', 'notes', '../lead', 7]) await assert.rejects(registry.registerAgent({ baseResourceId: id, expectedRevision: 0 }), { code: 'BASE_PROFILE_INVALID' }, String(id));
  const lead = await register(registry, 'lead', 0), team = await register(registry, 'team', 1), reviewer = await register(registry, 'reviewer', 2);
  await base.create({ id: 'temp', kind: 'profile', name: 'Temp', configuration: { agent: { provider: 'claude' } } });
  const temp = await register(registry, 'temp', 3);
  await base.update('lead', { enabled: false }, { expectedRevision: 1 });
  await base.update('reviewer', { trust: 'untrusted' }, { expectedRevision: 1 });
  await base.remove('temp', { expectedRevision: 1 });
  const reasons = Object.fromEntries((await registry.listAgents()).agents.map(agent => [agent.id, [agent.base.stale, agent.base.staleReason]]));
  assert.deepEqual(reasons, { [lead.id]: [true, 'disabled'], [team.id]: [true, 'primary-agent-disabled'], [reviewer.id]: [true, 'untrusted'], [temp.id]: [true, 'missing'] });
  assert.equal((await registry.listAgents({ status: 'stale' })).total, 4);
  assert.equal(JSON.parse(await readFile(file('agents.json'), 'utf8')).rows.length, 4, 'every registration is kept');
  // A disabled Base agent can still be registered (nothing runs); it shows as stale until Base enables it.
  const later = await register(registry, 'lead', 4);
  assert.deepEqual([later.base.stale, later.base.staleReason], [true, 'disabled']);
  await base.update('lead', { enabled: true }, { expectedRevision: 2 });
  assert.equal((await registry.agent(later.id)).agent.base.stale, false);
});

test('two concurrent changes with the same expected revision: one is saved, the other is a conflict', async t => {
  const { registry, open, file } = await fixture(t);
  const { id } = await register(registry, 'lead', 0);
  const results = await Promise.allSettled([registry.updateAgent(id, { expectedRevision: 1, displayName: 'One' }), registry.updateAgent(id, { expectedRevision: 1, displayName: 'Two' })]);
  assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  const winner = results.find(result => result.status === 'fulfilled').value.agent, loser = results.find(result => result.status === 'rejected').reason;
  assert.deepEqual([loser.code, loser.status], ['REVISION_CONFLICT', 409]);
  let stored = JSON.parse(await readFile(file('agents.json'), 'utf8'));
  assert.deepEqual([stored.revision, stored.rows.length, stored.rows[0].displayName, stored.rows[0].revision], [2, 1, winner.displayName, 2], 'exactly one change on disk');
  // The collection revision guards registrations the same way.
  const both = await Promise.allSettled([register(registry, 'reviewer', 2), register(registry, 'team', 2)]);
  assert.deepEqual(both.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  stored = JSON.parse(await readFile(file('agents.json'), 'utf8'));
  assert.deepEqual([stored.revision, stored.rows.length], [3, 2]);
  assert.equal((await open({ fresh: true }).listAgents()).total, 2, 'a restart reads the same');
});

test('a draft saves and publishes; later edits and publishes never change an earlier version', async t => {
  const { registry, file } = await fixture(t);
  const lead = await register(registry, 'lead', 0), reviewer = await register(registry, 'reviewer', 1);
  const { network } = await registry.createNetwork({ name: 'Research', description: 'Two agents', nodes: [agentNode(1, lead.id), agentNode(2, reviewer.id)], edges: [edge(1, 1, 2, 'delegate'), edge(2, 2, 1, 'share_result')] });
  assert.match(network.id, /^net_[0-9a-f]{20}$/);
  assert.deepEqual([network.revision, network.publishedVersions], [1, []]);
  const first = await registry.publishNetwork(network.id, { expectedRevision: 1 });
  assert.deepEqual([first.published.version, first.network.revision], [1, 2]);
  const v1Path = versionFile(file, network.id, 1, first.published.sha256), v1Bytes = await readFile(v1Path);
  assert.equal(sha(v1Bytes), first.published.sha256, 'the file name carries the hash of its bytes');
  await registry.updateNetwork(network.id, { expectedRevision: 2, description: 'One agent', nodes: [agentNode(1, lead.id)], edges: [] });
  await assert.rejects(registry.updateNetwork(network.id, { expectedRevision: 2, name: 'Stale' }), { code: 'REVISION_CONFLICT' });
  const second = await registry.publishNetwork(network.id, { expectedRevision: 3 });
  assert.equal(second.published.version, 2);
  assert.deepEqual(await readFile(v1Path), v1Bytes, 'version 1 bytes unchanged');
  const v1 = (await registry.version(network.id, 1)).version, v2 = (await registry.version(network.id, 2)).version;
  assert.deepEqual([v1.number, v1.sha256, v1.description, v1.nodes.length, v1.edges.map(item => item.relation)], [1, first.published.sha256, 'Two agents', 2, ['delegate', 'share_result']]);
  assert.deepEqual([v2.number, v2.description, v2.nodes.length, v2.edges.length], [2, 'One agent', 1, 0]);
  assert.deepEqual((await readdir(join(file('networks'), network.id.replace('_', '__')))).sort(), [`v1-${first.published.sha256}.json`, `v2-${second.published.sha256}.json`].sort());
  assert.deepEqual((await registry.network(network.id)).network.publishedVersions.map(item => item.version), [1, 2]);
  await assert.rejects(registry.version(network.id, 3), { code: 'NOT_FOUND' });
});

test('containment cycles are refused with their path: self, A→B→A and A→B→C→A, through pinned published versions', async t => {
  const { registry } = await fixture(t);
  const lead = await register(registry, 'lead', 0);
  const create = async (name, nodes = []) => { const { network } = await registry.createNetwork({ name, nodes }); await registry.publishNetwork(network.id, { expectedRevision: 1 }); return network.id; };
  const a = await create('A', [agentNode(1, lead.id)]);
  const cycle = async (nodes, path) => {
    const error = await registry.updateNetwork(a, { expectedRevision: 2, nodes }).then(() => null, reason => reason);
    assert.deepEqual([error?.code, error?.details?.path], ['NETWORK_CYCLE', path]);
    return error;
  };
  await cycle([subNode(1, a, 1)], [a, a]);
  const b = await create('B', [subNode(1, a, 1)]);
  assert.match((await cycle([subNode(1, b, 1)], [a, b, a])).message, /A → B → A/);
  const c = await create('C', [subNode(1, a, 1)]);
  await registry.updateNetwork(b, { expectedRevision: 2, nodes: [subNode(1, c, 1)] });
  await registry.publishNetwork(b, { expectedRevision: 3 });
  await cycle([subNode(1, b, 2)], [a, b, c, a]);
  // B's draft no longer contains A, but its pinned version 1 still does.
  await cycle([subNode(1, b, 1)], [a, b, a]);
  // Containing the same chain from another network is fine; nesting is not a cycle.
  const { network: d } = await registry.createNetwork({ name: 'D', nodes: [subNode(1, b, 2), subNode(2, c, 1), agentNode(3, lead.id)], edges: [edge(1, 3, 1, 'delegate')] });
  assert.equal(d.nodes.length, 3);
  // References must resolve: a registered agent, a published version of an existing network.
  await assert.rejects(registry.createNetwork({ name: 'E', nodes: [subNode(1, b, 9)] }), { code: 'NETWORK_REFERENCE_INVALID' });
  await assert.rejects(registry.createNetwork({ name: 'E', nodes: [subNode(1, `net_${'0'.repeat(20)}`, 1)] }), { code: 'NETWORK_REFERENCE_INVALID' });
  await assert.rejects(registry.createNetwork({ name: 'E', nodes: [agentNode(1, `agt_${'0'.repeat(20)}`)] }), { code: 'NETWORK_REFERENCE_INVALID' });
  assert.equal((await registry.listNetworks()).total, 4, 'refused saves wrote nothing');
});

test('network content is strict: typed nodes and relations, unique IDs, positions, names unique ignoring case', async t => {
  const { registry } = await fixture(t);
  const lead = await register(registry, 'lead', 0), reviewer = await register(registry, 'reviewer', 1);
  const nodes = [agentNode(1, lead.id), agentNode(2, reviewer.id)];
  const refused = [
    { name: '' }, { name: 'x'.repeat(81) }, { name: 'X', nodes: [{ ...nodes[0], type: 'pipeline' }] }, { name: 'X', nodes: [nodes[0], { ...nodes[1], id: nodes[0].id }] },
    { name: 'X', nodes: [nodes[0], agentNode(2, lead.id)] }, { name: 'X', nodes: [{ ...nodes[0], position: { x: Infinity, y: 0 } }] }, { name: 'X', nodes: [{ ...nodes[0], model: 'opus' }] },
    { name: 'X', nodes, edges: [{ ...edge(1, 1, 2), relation: 'execute' }] }, { name: 'X', nodes, edges: [edge(1, 1, 1)] }, { name: 'X', nodes, edges: [edge(1, 1, 3)] },
    { name: 'X', nodes, edges: [edge(1, 1, 2), edge(2, 1, 2)] }, { name: 'X', nodes, edges: [edge(1, 1, 2), edge(1, 2, 1)] }, { name: 'X', owner: 'me' },
  ];
  for (const input of refused) await assert.rejects(registry.createNetwork(input), { code: 'INVALID_INPUT' }, JSON.stringify(input).slice(0, 120));
  const { network } = await registry.createNetwork({ name: 'Team', nodes, edges: [edge(1, 1, 2), edge(2, 1, 2, 'delegate')] });
  await assert.rejects(registry.createNetwork({ name: 'TEAM' }), { code: 'NETWORK_NAME_TAKEN' });
  // Removing a node without its relations is refused rather than leaving a dangling edge.
  await assert.rejects(registry.updateNetwork(network.id, { expectedRevision: 1, nodes: [nodes[0]] }), { code: 'INVALID_INPUT' });
  assert.equal((await registry.updateNetwork(network.id, { expectedRevision: 1, name: 'team' })).network.name, 'team', 'renaming itself is not a clash');
});

test('a restart on the same folder keeps IDs, revisions, scopes, drafts and versions', async t => {
  const { registry, open } = await fixture(t);
  const lead = await register(registry, 'lead', 0, { tags: ['lead'], projectAllowlist: ['p1', 'p2'] });
  await registry.updateAgent(lead.id, { expectedRevision: 1, enabled: false });
  const { network } = await registry.createNetwork({ name: 'Research', nodes: [agentNode(1, lead.id)] });
  await registry.publishNetwork(network.id, { expectedRevision: 1 });
  await registry.updateNetwork(network.id, { expectedRevision: 2, description: 'Draft edit' });
  const before = { agents: await registry.listAgents(), network: await registry.network(network.id), version: await registry.version(network.id, 1) };
  const again = open({ fresh: true });
  assert.deepEqual({ agents: await again.listAgents(), network: await again.network(network.id), version: await again.version(network.id, 1) }, before);
  assert.deepEqual([before.agents.agents[0].revision, before.agents.agents[0].enabled, before.agents.agents[0].projectAllowlist, before.agents.agents[0].networks], [2, false, ['p1', 'p2'], [network.id]]);
});

test('damaged and newer files fail closed: a backup is used and the damaged file set aside; nothing is overwritten', async t => {
  const { registry, open, file } = await fixture(t);
  await register(registry, 'lead', 0);
  await register(registry, 'reviewer', 1); // agents.json now holds revision 2, its backup revision 1.
  await writeFile(file('agents.json'), '{"schema":"promptboard.network-agents",');
  const recovered = open({ fresh: true });
  assert.deepEqual([(await recovered.listAgents()).revision, (await recovered.listAgents()).total], [1, 1], 'the backup loads');
  const names = await readdir(file());
  assert.ok(names.some(name => /^agents\.json\.corrupt-\d+-[0-9a-f]{8}$/.test(name)) && !names.includes('agents.json'), 'the damaged file is set aside');
  await register(recovered, 'team', 1);
  assert.equal(JSON.parse(await readFile(file('agents.json.bak'), 'utf8')).revision, 1, 'the good backup survived the next save');
  // Both copies damaged: refused, nothing moved or written.
  await writeFile(file('agents.json'), 'not json'); await writeFile(file('agents.json.bak'), '[]');
  const listing = (await readdir(file())).sort();
  const damaged = open({ fresh: true });
  await assert.rejects(damaged.listAgents(), { code: 'NETWORK_DATA_DAMAGED', status: 409 });
  await assert.rejects(damaged.registerAgent({ baseResourceId: 'lead', expectedRevision: 0 }), { code: 'NETWORK_DATA_DAMAGED' });
  assert.deepEqual((await readdir(file())).sort(), listing);
  assert.equal(await readFile(file('agents.json'), 'utf8'), 'not json');
  // A newer version: refused with 409 and never rewritten.
  const newer = JSON.stringify({ schema: 'promptboard.network-agents', version: 2, revision: 9, rows: [] });
  await writeFile(file('agents.json'), newer);
  const future = open({ fresh: true });
  await assert.rejects(future.listAgents(), { code: 'NETWORK_VERSION_UNSUPPORTED', status: 409 });
  await assert.rejects(future.registerAgent({ baseResourceId: 'lead', expectedRevision: 9 }), { code: 'NETWORK_VERSION_UNSUPPORTED' });
  assert.equal(await readFile(file('agents.json'), 'utf8'), newer);
});

test('an unreadable network draft is listed as unavailable and refused; the other networks keep working', async t => {
  const { registry, open, file } = await fixture(t);
  const lead = await register(registry, 'lead', 0);
  const good = (await registry.createNetwork({ name: 'Good', nodes: [agentNode(1, lead.id)] })).network;
  const broken = (await registry.createNetwork({ name: 'Broken' })).network, future = (await registry.createNetwork({ name: 'Future' })).network;
  await registry.updateNetwork(broken.id, { expectedRevision: 1, description: 'second save keeps a backup' });
  await writeFile(draftFile(file, broken.id), '{'); await writeFile(`${draftFile(file, broken.id)}.bak`, '{');
  await writeFile(draftFile(file, future.id), JSON.stringify({ ...future, version: 3 }));
  const again = open({ fresh: true }), list = await again.listNetworks();
  assert.deepEqual(list.networks.map(item => item.name), ['Good']);
  assert.deepEqual(list.unavailable.sort((x, y) => x.code.localeCompare(y.code)), [{ id: broken.id, code: 'NETWORK_DATA_DAMAGED' }, { id: future.id, code: 'NETWORK_VERSION_UNSUPPORTED' }]);
  await assert.rejects(again.network(broken.id), { code: 'NETWORK_DATA_DAMAGED' });
  await assert.rejects(again.updateNetwork(future.id, { expectedRevision: 1, name: 'Overwrite' }), { code: 'NETWORK_VERSION_UNSUPPORTED' });
  await assert.rejects(again.export(), { code: 'NETWORK_DATA_DAMAGED' }, 'an export would be incomplete');
  assert.equal((await again.updateNetwork(good.id, { expectedRevision: 1, description: 'still editable' })).network.revision, 2);
  // A draft that is not exactly what the registry writes counts as damaged: a version hash that is not a hash (it would
  // name another file), a node of an unknown type.
  const edited = [(await registry.createNetwork({ name: 'Edited hash' })).network, (await registry.createNetwork({ name: 'Edited node' })).network];
  await writeFile(draftFile(file, edited[0].id), JSON.stringify({ ...edited[0], publishedVersions: [{ version: 1, sha256: '../../../state', publishedAt: 1 }] }));
  await writeFile(draftFile(file, edited[1].id), JSON.stringify({ ...edited[1], nodes: [{ id: `n_${pad(1)}`, type: 'shell', position: { x: 0, y: 0 } }] }));
  assert.deepEqual((await open({ fresh: true }).listNetworks()).unavailable.filter(item => edited.some(network => network.id === item.id)).map(item => item.code), ['NETWORK_DATA_DAMAGED', 'NETWORK_DATA_DAMAGED']);
  // A damaged draft whose backup is good (the save above kept revision 1 as the backup) loads from the backup.
  await writeFile(draftFile(file, good.id), 'x');
  assert.deepEqual([(await open({ fresh: true }).network(good.id)).network.revision, (await readdir(file('networks'))).some(name => name.startsWith(`${good.id.replace('_', '__')}.json.corrupt-`))], [1, true]);
});

test('a published version whose bytes no longer match its hash is refused, also as a sub-network pin', async t => {
  const { registry, open, file } = await fixture(t);
  const { network } = await registry.createNetwork({ name: 'Child' });
  const { published } = await registry.publishNetwork(network.id, { expectedRevision: 1 });
  const path = versionFile(file, network.id, 1, published.sha256), tampered = (await readFile(path, 'utf8')).replace('"Child"', '"Other"');
  await writeFile(path, tampered);
  const again = open({ fresh: true });
  await assert.rejects(again.version(network.id, 1), { code: 'NETWORK_CONTENT_INVALID', status: 409 });
  await assert.rejects(again.createNetwork({ name: 'Parent', nodes: [subNode(1, network.id, 1)] }), { code: 'NETWORK_CONTENT_INVALID' });
  assert.equal(await readFile(path, 'utf8'), tampered, 'never repaired or deleted');
});

test('export and import: identical graph in an empty folder, remapped references on collision, unresolved Base IDs refused whole', async t => {
  const source = await fixture(t), { registry } = source;
  const lead = await register(registry, 'lead', 0, { displayName: 'Lead', projectAllowlist: ['p1'] }), team = await register(registry, 'team', 1);
  const child = (await registry.createNetwork({ name: 'Child', nodes: [agentNode(1, lead.id)] })).network;
  await registry.publishNetwork(child.id, { expectedRevision: 1 });
  const parent = (await registry.createNetwork({ name: 'Parent', nodes: [agentNode(1, lead.id), agentNode(2, team.id), subNode(3, child.id, 1)], edges: [edge(1, 1, 2, 'delegate'), edge(2, 2, 3, 'share_result')] })).network;
  await registry.publishNetwork(parent.id, { expectedRevision: 1 });
  await registry.updateNetwork(parent.id, { expectedRevision: 2, description: 'Edited after v1' });
  const exported = await registry.export(), text = JSON.stringify(exported);
  assert.deepEqual(Object.keys(exported), ['application', 'kind', 'version', 'exportedAt', 'agents', 'networks', 'versions']);
  assert.deepEqual([exported.agents.length, exported.networks.length, exported.versions.length], [2, 2, 2]);
  assert.ok(!text.includes(source.dataDir) && !text.includes(tmpdir()) && !/token|job|lease|session|"schema"/i.test(text), 'no path, credential, job or file schema in the export');

  // An empty folder with the same Base: the same IDs, graph and version hashes; registrations come back disabled.
  const target = await fixture(t, { projects: [] });
  const result = await target.registry.import({ data: exported, expectedRevision: 0 });
  assert.deepEqual([result.imported, result.remapped], [{ agents: 2, networks: 2, versions: 2 }, { agents: {}, networks: {} }]);
  assert.match(result.warnings.join(' '), /projects that are not on this board/);
  const copy = await target.registry.export(), strip = ({ updatedAt, revision, enabled, projectAllowlist, ...rest }) => rest;
  assert.deepEqual(copy.agents.map(strip), exported.agents.map(strip));
  assert.deepEqual(copy.agents.map(row => [row.enabled, row.projectAllowlist]), [[false, []], [false, []]]);
  assert.deepEqual(copy.networks.map(strip), exported.networks.map(strip));
  assert.deepEqual(copy.versions, exported.versions, 'versions and their hashes are identical');
  const v1 = exported.versions.find(item => item.networkId === parent.id);
  assert.deepEqual(await readFile(versionFile(target.file, parent.id, 1, v1.sha256)), await readFile(versionFile(source.file, parent.id, 1, v1.sha256)));

  // Importing into the folder it came from: every ID collides, so every one is new and every reference follows.
  const again = await registry.import({ data: exported, expectedRevision: 2 });
  assert.deepEqual(Object.keys(again.remapped.agents).sort(), [lead.id, team.id].sort());
  assert.deepEqual(Object.keys(again.remapped.networks).sort(), [child.id, parent.id].sort());
  const newParent = again.remapped.networks[parent.id], newChild = again.remapped.networks[child.id];
  const draft = (await registry.network(newParent)).network, version = (await registry.version(newParent, 1)).version;
  assert.deepEqual([draft.name, draft.description], ['Parent (2)', 'Edited after v1']);
  for (const nodes of [draft.nodes, version.nodes]) assert.deepEqual(nodes.map(node => node.agentId || `${node.networkId}@${node.version}`), [again.remapped.agents[lead.id], again.remapped.agents[team.id], `${newChild}@1`]);
  assert.deepEqual(version.edges, exported.versions.find(item => item.networkId === parent.id).edges);
  assert.notEqual(version.sha256, v1.sha256, 'a remapped version has its own hash, checked on read');
  assert.equal((await registry.agent(again.remapped.agents[lead.id])).agent.enabled, false);
  assert.deepEqual((await registry.listNetworks()).networks.map(item => item.name).sort(), ['Child', 'Child (2)', 'Parent', 'Parent (2)']);

  // Refused whole: an unknown Base ID, a tampered hash, a missing reference, a cycle, a newer file. Nothing is written.
  const listing = async () => JSON.stringify([await readdir(target.file()), await readdir(target.file('networks'))]);
  const before = await listing(), revision = (await target.registry.listAgents()).revision;
  const variants = [
    [{ ...exported, agents: [{ ...exported.agents[0], baseResourceId: 'ghost' }, exported.agents[1]] }, 'NETWORK_IMPORT_UNRESOLVED', error => assert.deepEqual(error.details.baseResourceIds, ['ghost'])],
    [{ ...exported, agents: [exported.agents[0], { ...exported.agents[1], baseResourceId: 'notes' }] }, 'NETWORK_IMPORT_UNRESOLVED'],
    [{ ...exported, versions: exported.versions.map(item => ({ ...item, description: 'tampered' })) }, 'NETWORK_CONTENT_INVALID'],
    [{ ...exported, agents: exported.agents.slice(0, 1) }, 'NETWORK_IMPORT_UNRESOLVED'],
    [{ ...exported, networks: exported.networks.map(item => item.id === child.id ? { ...item, nodes: [subNode(1, parent.id, 1)] } : item) }, 'NETWORK_CYCLE'],
    [{ ...exported, version: 2 }, 'NETWORK_VERSION_UNSUPPORTED'],
    [{ ...exported, jobs: [] }, 'INVALID_INPUT'],
    [{ ...exported, kind: 'promptboard-backup' }, 'NETWORK_IMPORT_INVALID'],
  ];
  for (const [data, code, check] of variants) {
    const error = await target.registry.import({ data, expectedRevision: revision }).then(() => null, reason => reason);
    assert.equal(error?.code, code, code);
    check?.(error);
  }
  assert.equal(await listing(), before);
  assert.equal((await target.registry.listAgents()).revision, revision);
});

test('lists filter and page; reading never creates the network folder', async t => {
  const { registry, file } = await fixture(t);
  assert.deepEqual([(await registry.listAgents()).total, (await registry.listNetworks()).total], [0, 0]);
  await assert.rejects(readdir(file()), { code: 'ENOENT' }, 'no network folder until the first save');
  const rows = [];
  for (let n = 0; n < 5; n++) rows.push(await register(registry, n % 2 ? 'reviewer' : 'lead', n, { displayName: `Agent ${n}`, tags: n < 3 ? ['alpha'] : ['beta'], capabilities: n === 4 ? ['web'] : [], projectAllowlist: n === 1 ? ['p2'] : [] }));
  const page1 = await registry.listAgents({ tag: 'alpha', limit: 2 }), page2 = await registry.listAgents({ tag: 'alpha', limit: 2, offset: page1.next });
  assert.deepEqual([page1.total, page1.agents.map(item => item.displayName), page1.next, page2.agents.map(item => item.displayName), page2.next], [3, ['Agent 0', 'Agent 1'], 2, ['Agent 2'], null]);
  assert.deepEqual((await registry.listAgents({ q: 'AGENT 4' })).agents.map(item => item.id), [rows[4].id]);
  assert.deepEqual((await registry.listAgents({ capability: 'web' })).agents.map(item => item.id), [rows[4].id]);
  assert.deepEqual((await registry.listAgents({ baseResourceId: 'reviewer' })).agents.map(item => item.id), [rows[1].id, rows[3].id]);
  assert.deepEqual((await registry.listAgents({ projectId: 'p2' })).agents.map(item => item.id), [rows[1].id]);
  await registry.updateAgent(rows[0].id, { expectedRevision: 1, enabled: false });
  assert.equal((await registry.listAgents({ status: 'disabled' })).total, 1);
  const { network } = await registry.createNetwork({ name: 'Pair', description: 'Search me', nodes: [agentNode(1, rows[2].id)] });
  await registry.createNetwork({ name: 'Other' });
  assert.deepEqual((await registry.listAgents({ networkId: network.id })).agents.map(item => item.id), [rows[2].id]);
  assert.deepEqual((await registry.listNetworks({ q: 'search' })).networks.map(item => [item.id, item.nodeCount, item.edgeCount]), [[network.id, 1, 0]]);
  assert.deepEqual((await registry.listNetworks({ agentId: rows[2].id })).networks.map(item => item.id), [network.id]);
  assert.deepEqual((await registry.listNetworks({ limit: 1 })).next, 1);
  for (const query of [{ limit: 0 }, { limit: 201 }, { offset: -1 }, { limit: Number.NaN }, { status: 'busy' }]) await assert.rejects(registry.listAgents(query), { code: 'INVALID_INPUT' }, JSON.stringify(query));
});

test('the directory view: role and provider filters, capability facets, provider capabilities (unknown where unknown), an instructions preview and Base use', async t => {
  const { base, registry } = await fixture(t);
  const secret = 'api_key=sk-live-0123456789abcdef';
  await base.create({ id: 'writer', kind: 'profile', name: 'Writer', configuration: { agent: { provider: 'gemini', instructions: `${secret}\n${'Write clearly. '.repeat(40)}` } } });
  await base.create({ id: 'plain', kind: 'profile', name: 'Plain', configuration: { agent: {} } });
  await base.update('team', { configuration: { agents: [{ resourceId: 'lead', role: 'primary' }], instructions: 'Report to the owner.' } }, { expectedRevision: 1 });
  const lead = await register(registry, 'lead', 0, { capabilities: ['research', 'web'] }), team = await register(registry, 'team', 1, { capabilities: ['review'] });
  const reviewer = await register(registry, 'reviewer', 2), writer = await register(registry, 'writer', 3), plain = await register(registry, 'plain', 4);
  const ids = query => registry.listAgents(query).then(result => result.agents.map(agent => agent.id));
  assert.deepEqual(await ids({ kind: 'agentProfile' }), [team.id], 'role = the Base kind');
  assert.deepEqual(await ids({ kind: 'profile' }), [lead.id, reviewer.id, writer.id, plain.id]);
  assert.deepEqual(await ids({ provider: 'claude' }), [lead.id, team.id], 'an agent profile runs as its primary agent');
  assert.deepEqual(await ids({ provider: 'codex', kind: 'profile' }), [reviewer.id]);
  assert.deepEqual(await ids({ provider: 'agy' }), []);
  for (const query of [{ kind: 'knowledge' }, { provider: 'openai' }]) await assert.rejects(registry.listAgents(query), { code: 'INVALID_INPUT' }, JSON.stringify(query));
  assert.deepEqual((await registry.listAgents({ status: 'disabled' })).facets, { capabilities: ['research', 'review', 'web'] }, 'facets ignore the filters');

  const view = id => registry.agent(id).then(result => result.agent);
  const claude = (await view(lead.id)).providerCapabilities;
  assert.deepEqual(claude, { provider: 'claude', known: true, jobTools: ['none', 'web'], toolEvents: 'yes', waitingEvents: 'yes', readOnly: 'yes', webSearch: 'yes', sessionId: 'yes', usage: 'unknown', dockerSandbox: 'yes', liveVerified: 'yes' });
  assert.deepEqual([(await view(reviewer.id)).providerCapabilities.waitingEvents, (await view(writer.id)).providerCapabilities.jobTools], ['no', ['none']]);
  const unknown = (await view(plain.id)).providerCapabilities;
  assert.deepEqual([unknown.provider, unknown.known, unknown.jobTools], [null, false, null]);
  assert.ok(Object.entries(unknown).filter(([key]) => !['provider', 'known', 'jobTools'].includes(key)).every(([, value]) => value === 'unknown'), 'no evidence: every capability unknown');
  claude.jobTools.push('write');
  assert.deepEqual((await view(lead.id)).providerCapabilities.jobTools, ['none', 'web'], 'the matrix is not shared with callers');

  assert.deepEqual((await view(lead.id)).base.instructions, { summary: 'Lead the research.', chars: 18 });
  assert.deepEqual((await view(team.id)).base.instructions, { summary: 'Lead the research.\n\nReport to the owner.', chars: 40 }, 'the agent’s own, then the profile’s');
  const long = (await view(writer.id)).base.instructions;
  assert.ok(long.summary.length <= 280 && long.summary.startsWith('api_key=[redacted]\nWrite clearly.') && long.summary.endsWith('…') && long.chars > 600, JSON.stringify(long));
  assert.doesNotMatch(JSON.stringify(await registry.listAgents()), /sk-live/, 'a credential never reaches the preview');
  assert.deepEqual((await view(plain.id)).base.instructions, { summary: '', chars: 0 });
  assert.equal((await view(lead.id)).base.usedBy, 1, 'Base counts the agent profile that uses it');
  await base.remove('plain', { expectedRevision: 1 });
  assert.deepEqual([(await view(plain.id)).base.instructions, (await view(plain.id)).base.usedBy, (await view(plain.id)).providerCapabilities.known], [{ summary: '', chars: 0 }, 0, false]);
});
