// Regression for the interrupted session's last security finding: a backup can undo a revoke, a removal or an off switch.
// Real owner API and listener, disposable data, fake worker, local SDK peer; no provider or external service runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, request } from './helpers/network-machine.mjs';
import { mockPeer } from './helpers/a2a-peer.mjs';
import { setup, until } from './helpers/ui-harness.mjs';
import { readSettings } from '../src/network/storage.mjs';

for (const damage of ['torn', 'missing']) test(`settings recovered from a ${damage} primary cannot revive access or automation, including after another restart`, async t => {
  const ctx = await fixture(t);
  const ok = async pending => { const a = await pending; assert.ok(a.status < 300, a.text); return a.json; };
  const lead = await ctx.register('lead');
  await ctx.on();
  const { client, token } = await ctx.client({ agents: [lead.id] });
  await ok(ctx.owner(`/api/network/clients/${client.id}`, 'DELETE', {}));
  let { policy } = await ok(ctx.owner('/api/network/delegation'));
  ({ policy } = await ok(ctx.owner('/api/network/delegation', 'PATCH', { expectedRevision: policy.revision, askOwner: true, delegate: true, requireApproval: false })));
  await ok(ctx.owner('/api/network/delegation', 'PATCH', { expectedRevision: policy.revision, askOwner: false, delegate: false, requireApproval: true }));
  const made = await ok(ctx.owner('/api/network/schedules', 'POST', { expectedRevision: 0, name: 'Recovered schedule', target: { agentId: lead.id, input: { text: 'Do not run automatically.' } }, cadence: { kind: 'daily', time: '23:59' } }));
  const confirmed = await ok(ctx.owner(`/api/network/schedules/${made.schedule.id}/confirm`, 'POST', { expectedRevision: made.schedule.revision, confirm: true }));
  await ok(ctx.owner(`/api/network/schedules/${made.schedule.id}`, 'PATCH', { expectedRevision: confirmed.schedule.revision, enabled: false }));
  const peer = await mockPeer(t);
  let fed = await ok(ctx.owner('/api/network/federation'));
  fed = await ok(ctx.owner('/api/network/federation/outbound', 'PATCH', { expectedRevision: fed.revision, enabled: true }));
  const { preview } = await ok(ctx.owner('/api/network/federation/peers/preview', 'POST', { url: peer.cardUrl, localTest: true }));
  const trusted = await ok(ctx.owner('/api/network/federation/peers', 'POST', { expectedRevision: fed.revision, url: peer.cardUrl, localTest: true, cardSha256: preview.cardSha256 }));
  fed = await ok(ctx.owner('/api/network/federation/inbound', 'PATCH', { expectedRevision: trusted.revision, enabled: true, agents: [{ agentId: lead.id }] }));
  const caller = await ctx.client({ agents: [lead.id] }, { kind: 'a2a' });
  // Exercise backups that undo either kind of revocation (a2a for torn, api for missing).
  let restoredToken = token;
  if (damage === 'missing') {
    const api = await ctx.client({ agents: [lead.id] }); restoredToken = api.token;
    await ok(ctx.owner(`/api/network/clients/${api.client.id}`, 'DELETE', {}));
  } else await ok(ctx.owner(`/api/network/clients/${caller.client.id}`, 'DELETE', {}));
  await ok(ctx.owner(`/api/network/federation/peers/${trusted.peer.id}`, 'DELETE', { expectedRevision: trusted.peer.revision }));
  await ok(ctx.owner(`/api/network/agents/${lead.id}`, 'PATCH', { expectedRevision: lead.revision, enabled: false, projectAllowlist: [] }));
  await ctx.app.close();
  const files = ['agents.json', 'clients.json', 'delegation.json', 'schedules.json', 'federation.json'];
  const lost = new Map();
  for (const file of files) {
    const path = join(ctx.dataDir, 'network', file);
    lost.set(file, JSON.parse(await readFile(path, 'utf8')));
    await readFile(`${path}.bak`); // Prove this is a restore, not a reset of missing data.
    if (damage === 'missing') await rm(path); else await writeFile(path, '{torn');
  }
  const restored = await fixture(t, { dataDir: ctx.dataDir });
  const get = async path => { const a = await restored.owner(path); assert.equal(a.status, 200, a.text); return a.json; };
  const agents = await get('/api/network/agents');
  assert.equal(agents.agents[0].enabled, false);
  const clients = await get('/api/network/clients');
  assert.ok(clients.clients.every(row => row.status === 'revoked'));
  assert.equal((await get('/api/network/listener')).listener.listening, false);
  assert.equal((await get('/api/network/delegation')).policy.delegate, false);
  assert.equal((await get('/api/network/delegation')).policy.askOwner, false);
  assert.equal((await get('/api/network/delegation')).policy.requireApproval, true);
  assert.ok((await get('/api/network/schedules')).schedules.every(row => !row.enabled && row.confirmedAt === null));
  fed = await get('/api/network/federation');
  assert.equal(fed.outbound.enabled, false); assert.equal(fed.inbound.enabled, false);
  assert.deepEqual(fed.inbound.agents, []); assert.ok(fed.peers.every(row => !row.enabled && row.credential === null));
  assert.equal((await get('/api/network/jobs')).total, 0);
  for (const file of files) {
    const saved = JSON.parse(await readFile(join(ctx.dataDir, 'network', file), 'utf8'));
    assert.equal(saved.recovery.code, 'SETTINGS_RECOVERED');
    assert.ok(saved.revision > lost.get(file).revision, `${file}: stale collection revisions are refused`);
    if (damage === 'torn') assert.ok((await readdir(join(ctx.dataDir, 'network'))).some(name => name.startsWith(`${file}.corrupt-`)));
  }
  assert.equal((await get('/api/network/events?after=0&limit=200')).events.filter(e => e.type === 'settings.recovered').length, 5);
  // Even explicitly reopening the listener does not revive either kind of recovered bearer credential.
  await restored.on();
  assert.equal((await restored.machine(restoredToken, '/agents')).status, 401);
  assert.equal((await restored.machine(caller.token, '/agents')).status, 401);
  assert.equal((await request(restored.machinePort, '/.well-known/agent-card.json')).status, 404);
  await restored.app.close();
  const again = await fixture(t, { dataDir: ctx.dataDir });
  const after = await again.owner('/api/network/clients');
  assert.ok(after.json.clients.every(row => row.status === 'revoked'));
  assert.equal(after.json.recovery.code, 'SETTINGS_RECOVERED');
  assert.equal((await again.owner('/api/network/agents')).json.agents[0].enabled, false);
  const events = (await again.owner('/api/network/events?after=0&limit=200')).json.events;
  assert.equal(events.filter(e => e.type === 'settings.recovered').length, 5, 'intact sanitized primaries do not recover again');
  if (damage === 'torn') {
    await again.app.close();
    const ui = await setup(t, { dataDir: ctx.dataDir, executor: null, hash: '#/network' });
    const notice = selector => ui.$(selector)?.querySelector('[data-network-recovery]');
    await until(() => notice('#network-panel-agents'), 'agent recovery notice');
    ui.win.location.hash = '#/network/settings';
    await until(() => notice('#network-panel-settings') && ui.$('#network-handoff-save')?.parentElement.querySelector('[data-network-recovery]'), 'client and handoff recovery notices');
    assert.equal(notice('#network-panel-settings').getAttribute('role'), 'status');
    ui.win.location.hash = '#/network/federation';
    await until(() => notice('#network-panel-federation'), 'federation recovery notice');
    ui.win.location.hash = '#/network/activity';
    await until(() => notice('#network-schedules'), 'schedule recovery notice');
    assert.ok(!ui.win.document.body.textContent.includes(caller.token));
  }
});

test('failed recovery writes expose no authority; newer and wholly damaged settings are preserved', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-settings-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'settings.json'), schema = 'test.settings';
  const options = { schema, label: 'Test settings', valid: data => typeof data.enabled === 'boolean', reset: data => ({ ...data, enabled: false }) };
  const bytes = JSON.stringify({ schema, version: 1, revision: 3, enabled: true });
  await writeFile(`${path}.bak`, bytes); await mkdir(path);
  await assert.rejects(readSettings(path, options));
  assert.equal(await readFile(`${path}.bak`, 'utf8'), bytes);
  await rm(path, { recursive: true });
  await writeFile(path, JSON.stringify({ schema, version: 2, revision: 4, enabled: true }));
  await assert.rejects(readSettings(path, options), { code: 'NETWORK_VERSION_UNSUPPORTED' });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 2);
  await writeFile(path, '{bad'); await writeFile(`${path}.bak`, '{also bad');
  await assert.rejects(readSettings(path, options), { code: 'NETWORK_DATA_DAMAGED' });
  assert.equal(await readFile(path, 'utf8'), '{bad');
  // A valid backup exists but replacing the primary is impossible: recovery must fail before returning enabled data.
  await writeFile(`${path}.bak`, bytes); await rm(path);
  const reset = data => { mkdirSync(path); return { ...data, enabled: false }; }; // Actual atomic rename cannot replace a directory.
  await assert.rejects(readSettings(path, { ...options, reset }), { code: 'NETWORK_WRITE_FAILED' });
  assert.equal(await readFile(`${path}.bak`, 'utf8'), bytes);
  await rm(path, { recursive: true });
  const recovered = await readSettings(path, options);
  assert.equal(recovered.enabled, false);
  assert.equal((await readSettings(path, options)).recovery.at, recovered.recovery.at);
});

test('a memory backup cannot restore an approval the owner withdrew', async t => {
  const ctx = await fixture(t), lead = await ctx.register('lead');
  const root = `/api/network/agents/${lead.id}/memory`;
  const proposed = (await ctx.owner(root, 'POST', { expectedRevision: 0, kind: 'preference', text: 'Recovered sensitive guidance.' })).json;
  assert.ok(proposed.record);
  const approved = (await ctx.owner(`${root}/${proposed.record.id}/approve`, 'POST', { expectedRevision: proposed.record.revision, decision: 'approve' })).json;
  const rejected = await ctx.owner(`${root}/${proposed.record.id}/approve`, 'POST', { expectedRevision: approved.record.revision, decision: 'reject' });
  assert.equal(rejected.status, 200, rejected.text);
  await ctx.app.close();
  const dir = join(ctx.dataDir, 'network', 'memory');
  const file = (await readdir(dir)).find(name => name.endsWith('.json'));
  await writeFile(join(dir, file), '{torn');
  const restored = await fixture(t, { dataDir: ctx.dataDir });
  const memory = await restored.owner(root);
  assert.equal(memory.json.records[0].status, 'proposed');
  assert.equal(memory.json.counts.approved, 0);
  assert.equal(memory.json.recovery.code, 'SETTINGS_RECOVERED');
  const preview = await restored.owner(`${root}/preview?memory=agent`);
  assert.equal(preview.status, 200, preview.text);
  assert.ok(!JSON.stringify(preview.json).includes('Recovered sensitive guidance.'));
  await restored.app.close();
  const again = await fixture(t, { dataDir: ctx.dataDir });
  assert.equal((await again.owner(root)).json.records[0].status, 'proposed');
});

test('restored graph relations remain visible but grant no delegation until the owner confirms them', async t => {
  const ctx = await fixture(t, { worker: null }), lead = await ctx.register('lead'), scout = await ctx.register('scout');
  const ok = async pending => { const a = await pending; assert.ok(a.status < 300, a.text); return a.json; };
  const nodes = [{ id: 'n_000000000001', type: 'agent', agentId: lead.id, position: { x: 0, y: 0 } }, { id: 'n_000000000002', type: 'agent', agentId: scout.id, position: { x: 100, y: 0 } }];
  const edges = [{ id: 'e_000000000001', from: nodes[0].id, to: nodes[1].id, relation: 'delegate' }];
  const { network } = await ok(ctx.owner('/api/network/networks', 'POST', { name: 'Recovered permissions', nodes, edges }));
  const { policy } = await ok(ctx.owner('/api/network/delegation'));
  await ok(ctx.owner('/api/network/delegation', 'PATCH', { expectedRevision: policy.revision, delegate: true }));
  await ctx.on();
  const { token } = await ctx.client({ agents: [lead.id, scout.id], networks: [network.id] });
  const { jobId } = await ok(ctx.machine(token, '/jobs', { method: 'POST', body: { agentId: lead.id, networkId: network.id, input: { text: 'Parent' } } }));
  await ok(ctx.owner(`/api/network/networks/${network.id}`, 'PATCH', { expectedRevision: network.revision, edges: [] }));
  await ctx.app.close();
  await writeFile(join(ctx.dataDir, 'network', 'networks', `${network.id.replace('_', '__')}.json`), '{torn');
  const restored = await fixture(t, { dataDir: ctx.dataDir, worker: null });
  await restored.on();
  const recovered = (await ok(restored.owner(`/api/network/networks/${network.id}`))).network;
  assert.equal(recovered.delegationReviewRequired, true);
  assert.deepEqual(recovered.edges, edges, 'recovered graph content is preserved for review');
  const delegate = () => restored.machine(token, `/jobs/${jobId}/children`, { method: 'POST', body: { agentId: scout.id, task: 'Review this' } });
  const refused = await delegate();
  assert.equal(refused.status, 403, refused.text);
  assert.equal(refused.json.code, 'DELEGATION_NOT_ALLOWED');
  const renamed = await ok(restored.owner(`/api/network/networks/${network.id}`, 'PATCH', { expectedRevision: recovered.revision, name: 'Still needs review' }));
  assert.equal(renamed.network.delegationReviewRequired, true, 'renaming does not confirm permissions');
  assert.equal((await delegate()).json.code, 'DELEGATION_NOT_ALLOWED');
  const exported = await ok(restored.owner('/api/network/export'));
  assert.ok(exported.networks.every(row => row.recovery === undefined && row.delegationReviewRequired === undefined), 'local recovery metadata stays out of definition exports');
  const registrations = await ok(restored.owner('/api/network/agents'));
  const imported = await ok(restored.owner('/api/network/import', 'POST', { expectedRevision: registrations.revision, data: exported }));
  assert.equal(imported.imported.networks, 1, 'a recovered graph still round-trips through the strict import schema');
  const afterImport = await ok(restored.owner('/api/network/agents'));
  assert.ok(afterImport.agents.filter(row => ![lead.id, scout.id].includes(row.id)).every(row => !row.enabled), 'imported registrations still arrive disabled');
  const duplicate = await ok(restored.owner(`/api/network/networks/${network.id}/duplicate`, 'POST', {}));
  assert.equal(duplicate.network.delegationReviewRequired, true, 'duplicating a recovered graph does not confirm its permissions');
  await restored.app.close();
  const ui = await setup(t, { dataDir: ctx.dataDir, executor: null, hash: `#/network/graph/${network.id}` });
  await until(() => [...ui.win.document.querySelectorAll('button')].some(button => button.textContent === 'Confirm recovered relations'), 'recovered graph confirmation');
  const confirm = [...ui.win.document.querySelectorAll('button')].find(button => button.textContent === 'Confirm recovered relations');
  assert.equal(confirm.disabled, false);
  confirm.click();
  await until(() => confirm.textContent === 'Save draft', 'recovered graph saved explicitly');
  const session = ui.win.__pbTest.token;
  const status = await fetch(`${ui.app.url}/api/network/listener`, { headers: { 'X-STE-Token': session } }).then(r => r.json());
  const port = Number(new URL(status.listener.url).port);
  const accepted = await request(port, `/machine/v1/jobs/${jobId}/children`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: { agentId: scout.id, task: 'Review this' } });
  assert.equal(accepted.status, 202, accepted.text);
});
