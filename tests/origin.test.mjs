import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../public/origin-model.js';
import { OriginStore, blueprintFileName, originFileName } from '../src/origin.mjs';
import { STATE_VERSION } from '../src/store.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const Model = globalThis.PromptboardOriginModel;
const temp = async t => { const dir = await mkdtemp(join(tmpdir(), 'pb-origin-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };

function sample() {
  const blueprint = Model.emptyBlueprint();
  Object.assign(blueprint.vision, { summary: 'Shared release notes', problem: 'Notes are scattered.', goal: 'One page.', users: 'Maintainers', inScope: 'Web app' });
  blueprint.sources.push({ id: 's1', title: 'Node.js releases', url: 'https://nodejs.org/en/about/previous-releases', type: 'documentation', verification: 'verified', accessedAt: '2026-10-07' },
    { id: 's2', title: 'Blog post', url: 'https://example.com/post', verification: 'unverified' });
  blueprint.technologies.push({ id: 't1', name: 'Node.js', version: '22', status: 'selected', sourceIds: ['s1'] }, { id: 't2', name: 'Redis', status: 'selected', sourceIds: ['s2'] });
  blueprint.components.push({ id: 'web', name: 'Web Client', type: 'client', purpose: 'UI', status: 'defined', technologyIds: [] },
    { id: 'api', name: 'API', type: 'api', purpose: 'Business rules', status: 'defined', technologyIds: ['t1'] },
    { id: 'db', name: 'PostgreSQL', type: 'database', purpose: 'Storage', status: 'defined', technologyIds: [] });
  blueprint.connections.push({ id: 'c1', from: 'web', to: 'api', label: 'calls', protocol: 'HTTPS' }, { id: 'c2', from: 'api', to: 'db', label: 'stores', protocol: 'SQL' });
  blueprint.requirements.push({ id: 'r1', key: 'REQ-001', title: 'Publish notes', type: 'functional', status: 'defined', acceptanceCriteria: '- A maintainer can publish\n- Readers see it', componentIds: ['api'] },
    { id: 'r2', key: 'REQ-002', title: 'Unrelated export', type: 'functional', status: 'defined', acceptanceCriteria: 'CSV export works', componentIds: ['web'] });
  blueprint.decisions.push({ id: 'd1', key: 'ADR-001', title: 'Database', decision: 'PostgreSQL', alternatives: 'MongoDB\nSQLite', reason: 'Relational model', status: 'accepted', date: '2026-10-07', componentIds: ['db', 'api'] });
  blueprint.milestones.push({ id: 'm1', title: 'Foundation', definitionOfDone: 'CI passes' }, { id: 'm2', title: 'Core' });
  blueprint.items.push({ id: 'i2', key: 'IMP-002', title: 'API', milestoneId: 'm2', dependsOn: ['i1'], requirementIds: ['r1'], componentIds: ['api'], acceptanceCriteria: 'Publishing works' },
    { id: 'i1', key: 'IMP-001', title: 'Repository structure', milestoneId: 'm1' });
  blueprint.sequence = { requirements: 2, decisions: 1, items: 2 };
  return blueprint;
}

test('normalization keeps structured records and removes unknown fields, unsafe URLs and broken relationships', () => {
  const input = sample();
  input.extra = 'dropped';
  input.components[0].innerHTML = '<img src=x onerror=alert(1)>';
  input.components[0].name = '<img src=x onerror=alert(1)>';
  input.connections.push({ id: 'c3', from: 'api', to: 'deleted-component' }, { id: 'c4', from: 'api', to: 'api' });
  input.sources.push({ id: 's3', title: 'Script', url: 'javascript:alert(1)' }, { id: 's4', title: 'Credentials', url: 'https://user:secret@example.com/' });
  input.requirements[0].componentIds.push('deleted-component');
  input.requirements.push({ id: '../escape', title: 'Invalid ID' }, { id: 'r1', title: 'Duplicate ID' });
  const { blueprint, repairs } = Model.normalizeBlueprint(input);
  assert.ok(repairs >= 7, `repairs ${repairs}`);
  assert.equal('extra' in blueprint, false);
  assert.equal('innerHTML' in blueprint.components[0], false);
  assert.equal(blueprint.components[0].name, '<img src=x onerror=alert(1)>', 'Text stays literal text; rendering decides safety.');
  assert.deepEqual(blueprint.connections.map(item => item.id), ['c1', 'c2']);
  assert.deepEqual(blueprint.sources.filter(item => ['s3', 's4'].includes(item.id)).map(item => item.url), ['', '']);
  assert.deepEqual(blueprint.requirements.map(item => item.id), ['r1', 'r2']);
  assert.deepEqual(blueprint.requirements[0].componentIds, ['api']);
  assert.equal(Model.normalizeBlueprint(blueprint).repairs, 0, 'Normalized blueprints are stable.');
});

test('display keys stay unique and are never reused after deletion', () => {
  const blueprint = sample();
  blueprint.requirements.push({ id: 'r3', key: 'REQ-001', title: 'Duplicate key' }, { id: 'r4', title: 'No key' });
  const first = Model.normalizeBlueprint(blueprint).blueprint;
  assert.deepEqual(first.requirements.map(item => item.key), ['REQ-001', 'REQ-002', 'REQ-003', 'REQ-004']);
  first.requirements.pop();
  assert.equal(Model.nextKey(first, 'requirements'), 'REQ-005');
  assert.throws(() => Model.normalizeBlueprint({ requirements: Array.from({ length: 501 }, (_, index) => ({ id: `r${index}` })) }), { code: 'ORIGIN_INVALID' });
});

test('verification comes from linked evidence, never from a URL alone', () => {
  const sources = [{ id: 'a', url: 'https://example.com', verification: 'unverified' }, { id: 'b', verification: 'verified' }, { id: 'c', verification: 'conflicting' }, { id: 'd', verification: 'outdated' }];
  assert.equal(Model.verification({ sourceIds: [] }, sources), 'unverified');
  assert.equal(Model.verification({ sourceIds: ['a'] }, sources), 'unverified');
  assert.equal(Model.verification({ sourceIds: ['d'] }, sources), 'outdated');
  assert.equal(Model.verification({ sourceIds: ['a', 'b'] }, sources), 'verified');
  assert.equal(Model.verification({ sourceIds: ['b', 'c'] }, sources), 'conflict');
});

test('issues distinguish system-detected problems from human-entered and AI-suggested risks', () => {
  const blueprint = Model.normalizeBlueprint(sample()).blueprint;
  blueprint.dependencies.push({ id: 'x1', name: 'react', type: 'package', requiredBy: [], dependsOn: [], sourceIds: [] }, { id: 'x2', name: 'React', type: 'package', requiredBy: [], dependsOn: [], sourceIds: [] });
  blueprint.decisions.push({ ...blueprint.decisions[0], id: 'd2', key: 'ADR-002', status: 'proposed', title: 'Cache' });
  blueprint.requirements.push({ ...blueprint.requirements[0], id: 'r3', key: 'REQ-003', type: 'security', status: 'draft', acceptanceCriteria: '' });
  blueprint.items[0].milestoneId = 'm1'; blueprint.items[1].milestoneId = 'm2'; // i2 now depends on a later item.
  blueprint.risks.push({ id: 'k1', title: 'Vendor lock-in', kind: 'risk', severity: 'high', status: 'open', origin: 'human', componentIds: [] },
    { id: 'k2', title: 'Consider rate limits', kind: 'missing', severity: 'low', status: 'open', origin: 'ai', componentIds: [] });
  const found = Model.issues(blueprint);
  const rules = found.map(issue => issue.rule);
  for (const rule of ['technology-unverified', 'technology-unused', 'dependency-unverified', 'duplicate-dependencies', 'decision-proposed', 'requirement-criteria', 'security-plan', 'testing-plan', 'plan-order', 'recorded'])
    assert.ok(rules.includes(rule), `missing rule ${rule}`);
  assert.equal(found.find(issue => issue.title.includes('Redis') && issue.rule === 'technology-unused').origin, 'system');
  assert.equal(found.find(issue => issue.title === 'Vendor lock-in').origin, 'human');
  assert.equal(found.find(issue => issue.title === 'Consider rate limits').origin, 'ai');
  assert.equal(found.find(issue => issue.title === 'Consider rate limits').blocking, false, 'AI suggestions never block readiness.');
  assert.equal(found.some(issue => issue.title.includes('Node.js') && issue.kind === 'unverified'), false, 'Verified evidence clears the check.');
  assert.equal(found.filter(issue => issue.kind === 'unverified').every(issue => !issue.blocking), true, 'Missing evidence is shown but never blocks on its own.');
});

test('readiness is explained by stored counts and semantic states', () => {
  assert.equal(Model.readiness(Model.emptyBlueprint()).state, 'not_started');
  const blueprint = Model.normalizeBlueprint(sample()).blueprint;
  let ready = Model.readiness(blueprint);
  assert.equal(ready.state, 'ready', JSON.stringify(ready.blocking));
  assert.deepEqual(Object.fromEntries(ready.rows.map(row => [row.id, row.value])), {
    requirements: '2 / 2 with done-when', components: '3 / 3 described', technologies: '1 / 2 verified', dependencies: '0 / 0 verified', decisions: '0 unresolved',
    assumptions: '0 open', sources: '1 not verified', testing: '0 areas defined', plan: '2 items · 0 sent to Kanban' });
  blueprint.requirements[1].acceptanceCriteria = '';
  ready = Model.readiness(blueprint);
  assert.equal(ready.state, 'attention');
  assert.deepEqual(ready.reasons, ['1 item with missing information remains.']);
  assert.equal(ready.rows[0].value, '1 / 2 with done-when');
  blueprint.requirements[1].acceptanceCriteria = 'CSV export works';
  ready = Model.readiness(blueprint);
  assert.equal(ready.state, 'ready', JSON.stringify(ready.blocking));
  blueprint.items = [];
  assert.equal(Model.readiness(blueprint).state, 'decompose');
  assert.equal(Model.readiness(blueprint).label, 'Ready for task decomposition');
  const states = Model.sectionStates(blueprint);
  assert.equal(states.architecture, 'defined'); assert.equal(states.data, 'empty'); assert.equal(states.overview, 'defined');
  blueprint.sections.data = { notApplicable: true };
  blueprint.decisions[0].status = 'proposed';
  assert.equal(Model.sectionStates(blueprint).data, 'na');
  assert.equal(Model.sectionStates(blueprint).decisions, 'decision');
});

test('Compose and Kanban handoffs carry targeted context and the Origin reference', () => {
  const blueprint = Model.normalizeBlueprint(sample()).blueprint;
  const spec = Model.composeSpec(blueprint, 'requirements', 'r1', 'Notes');
  assert.match(spec.text, /REQ-001 Publish notes/);
  assert.match(spec.text, /- A maintainer can publish/);
  assert.match(spec.text, /API \(API\): Business rules \[Node\.js\]/);
  assert.match(spec.text, /ADR-001 Database: PostgreSQL/);
  assert.doesNotMatch(spec.text, /Unrelated export/, 'Only the selected item and its relationships are included.');
  assert.match(Model.composeSpec(blueprint, 'components', 'api', 'Notes').text, /## Used by\n- Web Client \(calls, HTTPS\)/);
  assert.equal(Model.composeSpec(blueprint, 'components', 'missing'), null);
  const tasks = Model.kanbanTasks(blueprint, ['i2', 'i1'], 'Notes');
  assert.deepEqual(tasks.map(task => task.title), ['IMP-001 Repository structure', 'IMP-002 API'], 'Dependencies come first.');
  assert.match(tasks[1].prompt, /Origin reference: IMP-002 \(origin item i2\)/);
  assert.match(tasks[1].prompt, /## Depends on\n- IMP-001 Repository structure/);
  assert.match(tasks[1].prompt, /- A maintainer can publish/, 'Related requirement acceptance criteria are included.');
  blueprint.areas.push({ id: 'test1', origin: 'human', section: 'testing', area: 'integration', title: 'Publish flow', description: 'Runs against a disposable database.', status: 'defined', componentIds: [], requirementIds: ['r1'], technologyIds: [], baseResourceIds: [] });
  assert.match(Model.kanbanTasks(blueprint, ['i2'])[0].prompt, /## Planned tests\n- Integration tests: Publish flow — Runs against a disposable database\./, 'Testing plans carry into task generation.');
  assert.match(Model.composeSpec(blueprint, 'requirements', 'r1').text, /## Planned tests\n- Integration tests: Publish flow/);
});

test('Origin projects persist on their own, reject stale revisions and refuse unsafe IDs', async t => {
  const dir = await temp(t), store = new OriginStore(dir);
  assert.deepEqual(await store.list(), []);
  const atlas = await store.create({ name: '  Atlas  ', description: 'An internal API gateway.' });
  assert.match(atlas.id, /^[0-9a-f-]{36}$/); assert.equal(atlas.name, 'Atlas'); assert.equal(atlas.revision, 1); assert.equal(atlas.kanbanProjectId, null);
  assert.equal(atlas.blueprint.vision.summary, 'An internal API gateway.');
  const saved = await store.write(atlas.id, { expectedRevision: 1, blueprint: sample() });
  assert.equal(saved.revision, 2);
  await assert.rejects(store.write(atlas.id, { expectedRevision: 1, blueprint: sample() }), { code: 'ORIGIN_REVISION_CONFLICT', status: 409 });
  const beacon = await store.create({ name: 'Beacon' });
  const reloaded = new OriginStore(dir);
  assert.deepEqual((await reloaded.list()).map(record => record.name), ['Atlas', 'Beacon']);
  assert.equal((await reloaded.read(atlas.id)).blueprint.components.length, 3);
  assert.equal((await reloaded.read(beacon.id)).blueprint.components.length, 0, 'Each project has its own blueprint.');
  assert.equal(blueprintFileName('a_B'), 'blueprint-a___b.json'); assert.equal(originFileName('a_B'), 'project-a___b.json');
  for (const bad of ['../state', 'a/b', '', 'x'.repeat(101), 'a.b']) await assert.rejects(store.read(bad), { code: 'INVALID_PROJECT' });
  for (const name of ['', ' ', 'x'.repeat(81), 'nul\0']) await assert.rejects(store.create({ name }), { code: 'INVALID_INPUT' });
  const file = JSON.parse(await readFile(join(dir, 'origin', blueprintFileName(atlas.id)), 'utf8'));
  assert.deepEqual([file.schema, file.version, file.originId, file.project.name], ['promptboard.origin', 2, atlas.id, 'Atlas']);
  // Renaming and linking keep the blueprint; one Kanban project belongs to one Origin project.
  const renamed = await store.update(atlas.id, { expectedRevision: 2, name: 'Atlas gateway' });
  assert.equal(renamed.blueprint.components.length, 3);
  const linked = await store.link(atlas.id, { expectedRevision: 3, kanbanProjectId: 'k1' });
  assert.equal(linked.kanbanProjectId, 'k1');
  await assert.rejects(store.link(beacon.id, { expectedRevision: 1, kanbanProjectId: 'k1' }), { code: 'ALREADY_LINKED' });
  // Removal moves the file aside; a stale save cannot recreate it.
  await store.remove(beacon.id, { expectedRevision: 1 });
  assert.deepEqual((await store.list()).map(record => record.id), [atlas.id]);
  await assert.rejects(store.write(beacon.id, { expectedRevision: 1, blueprint: {} }), { code: 'NOT_FOUND', status: 404 });
  assert.equal((await readdir(join(dir, 'origin', 'deleted'))).length, 1);
});

test('damaged Origin files are contained and newer files are never overwritten', async t => {
  const dir = await temp(t), store = new OriginStore(dir);
  const created = await store.create({ name: 'Notes' }), path = join(dir, 'origin', blueprintFileName(created.id));
  await store.write(created.id, { expectedRevision: 1, blueprint: { idea: 'First' } });
  await store.write(created.id, { expectedRevision: 2, blueprint: { idea: 'Second' } });
  await writeFile(path, '{ "schema": "promptboard.origin", broken');
  const recovered = await store.read(created.id);
  assert.equal(recovered.blueprint.idea, 'First', 'The last good backup is used.');
  assert.equal(recovered.recovery.restoredFromBackup, true);
  assert.match(recovered.recovery.quarantined, /^blueprint-[a-z0-9_-]+\.corrupt-\d+-[a-f0-9]{8}\.json$/);
  assert.equal(await readFile(join(dir, 'origin', recovered.recovery.quarantined), 'utf8'), '{ "schema": "promptboard.origin", broken');
  assert.equal((await store.read(created.id)).recovery, null, 'The restored copy is saved.');
  await writeFile(path, 'not json'); await writeFile(`${path}.bak`, 'not json either');
  const lost = await store.read(created.id);
  assert.equal(lost.damaged, true); assert.equal(lost.recovery.restoredFromBackup, false);
  assert.deepEqual(await store.list(), [], 'A project with no good copy is kept aside, not shown.');
  const other = await store.create({ name: 'Newer' }), otherPath = join(dir, 'origin', blueprintFileName(other.id));
  const newer = JSON.stringify({ schema: 'promptboard.origin', version: 3, originId: other.id, project: { name: 'Newer' }, revision: 9, blueprint: {} });
  await writeFile(otherPath, newer);
  await assert.rejects(store.read(other.id), { code: 'ORIGIN_VERSION_UNSUPPORTED' });
  await assert.rejects(store.write(other.id, { expectedRevision: 9, blueprint: {} }), { code: 'ORIGIN_VERSION_UNSUPPORTED' });
  assert.equal(await readFile(otherPath, 'utf8'), newer);
});

test('a failed Origin write reports an error and keeps the previous file', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-origin-')), store = new OriginStore(dir);
  t.after(async () => { await chmod(join(dir, 'origin'), 0o700).catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  const created = await store.create({ name: 'Kept' }), path = join(dir, 'origin', blueprintFileName(created.id));
  await store.write(created.id, { expectedRevision: 1, blueprint: { idea: 'Kept' } });
  const before = await readFile(path, 'utf8');
  await chmod(join(dir, 'origin'), 0o500);
  await assert.rejects(store.write(created.id, { expectedRevision: 2, blueprint: { idea: 'Lost?' } }), { code: 'ORIGIN_WRITE_FAILED', status: 500 });
  await chmod(join(dir, 'origin'), 0o700);
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal((await store.read(created.id)).blueprint.idea, 'Kept');
});

test('version 1 blueprints migrate once with every ID kept, and the version 1 files stay for rollback', async t => {
  const dir = await temp(t);
  await mkdir(join(dir, 'origin'), { recursive: true });
  const legacy = { schema: 'promptboard.origin', version: 1, projectId: 'p1', revision: 4, createdAt: 10, updatedAt: 20, blueprint: sample() };
  const legacyText = JSON.stringify(legacy);
  await writeFile(join(dir, 'origin', originFileName('p1')), legacyText);
  await writeFile(join(dir, 'origin', originFileName('gone')), JSON.stringify({ ...legacy, projectId: 'gone', blueprint: { idea: 'Orphan' } }));
  await writeFile(join(dir, 'origin', originFileName('empty')), JSON.stringify({ ...legacy, projectId: 'empty', blueprint: {} }));
  await writeFile(join(dir, 'origin', originFileName('bad')), 'not json');
  const store = new OriginStore(dir, { kanbanProjects: async () => [{ id: 'p1', name: 'Notes' }] });
  const [gone, notes] = (await store.list()).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual([notes.id, notes.name, notes.kanbanProjectId, notes.revision], ['p1', 'Notes', 'p1', 4]);
  assert.deepEqual([gone.id, gone.name, gone.kanbanProjectId], ['gone', 'Orphan', null]);
  assert.deepEqual(notes.blueprint.requirements.map(item => [item.id, item.key]), [['r1', 'REQ-001'], ['r2', 'REQ-002']]);
  assert.deepEqual(notes.blueprint.items.map(item => [item.id, item.key, item.milestoneId]), [['i2', 'IMP-002', 'm2'], ['i1', 'IMP-001', 'm1']]);
  assert.deepEqual(notes.blueprint.milestones.map(item => item.id), ['m1', 'm2'], 'Milestone order is kept.');
  assert.equal(await readFile(join(dir, 'origin', originFileName('p1')), 'utf8'), legacyText, 'The version 1 file is untouched for rollback.');
  const marker = JSON.parse(await readFile(join(dir, 'origin', 'migration.json'), 'utf8'));
  // An empty blueprint whose Kanban project is gone is not brought over; its file stays.
  assert.deepEqual([marker.migrated.length, marker.skipped], [2, [originFileName('bad'), originFileName('empty')]]);
  // A migrated project that is deleted later is never resurrected from its version 1 file.
  await store.remove('p1', { expectedRevision: 4 });
  assert.deepEqual((await new OriginStore(dir, { kanbanProjects: async () => [{ id: 'p1', name: 'Notes' }] }).list()).map(record => record.id), ['gone']);
});

async function api(app, path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${app.url}${path}`, { method, headers: { ...(token === undefined ? {} : { 'X-STE-Token': token }), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}

test('Origin-only projects have no Kanban or Git side effects; linking and deletion use the board service', async t => {
  const app = await startTestServer(t, { port: 0, executor: null });
  const { token } = (await api(app, '/api/session')).data;
  const existing = await app.board.createProject({ name: 'Existing project' });
  await app.board.createTask({ projectId: existing.id, title: 'Existing task', prompt: 'Keep me.' });
  const statePath = join(app.board.store.dir, 'state.json'), projectsDir = join(app.board.store.dir, 'projects');
  const before = await readFile(statePath);
  assert.equal(JSON.parse(before).version, STATE_VERSION); assert.equal(STATE_VERSION, 12);
  assert.equal((await api(app, '/api/origin/projects')).status, 403, 'The session token is required.');
  assert.equal((await api(app, '/api/origin/projects/unknown', { token })).status, 404);
  assert.equal((await api(app, '/api/origin/projects/..%2Fstate', { token })).status, 404);
  // Origin only: the board file and the projects folder stay exactly as they were.
  const solo = await api(app, '/api/origin/projects', { method: 'POST', token, body: { name: 'Atlas', description: 'A gateway.', createKanban: false } });
  assert.equal(solo.status, 200); assert.equal(solo.data.project.kanban, null);
  assert.ok((await readFile(statePath)).equals(before), 'Origin-only creation never touches the board.');
  assert.equal(await readdir(projectsDir).then(entries => entries.length, () => 0), 0, 'No repository folder is created.');
  assert.equal((await api(app, '/api/origin/projects', { method: 'POST', token, body: { name: 'x'.repeat(81) } })).status, 400);
  // Saving the blueprint keeps the board byte-identical and rejects stale or invalid input.
  const id = solo.data.project.id;
  const saved = await api(app, `/api/origin/projects/${id}`, { method: 'PUT', token, body: { expectedRevision: 1, blueprint: sample() } });
  assert.equal(saved.status, 200); assert.equal(saved.data.revision, 2); assert.equal(saved.data.repairs, 0);
  assert.equal((await api(app, `/api/origin/projects/${id}`, { method: 'PUT', token, body: { expectedRevision: 1, blueprint: sample() } })).status, 409);
  assert.equal((await api(app, `/api/origin/projects/${id}`, { method: 'PUT', token, body: { expectedRevision: 2, blueprint: [] } })).status, 400);
  assert.equal((await api(app, `/api/origin/projects/${id}`, { method: 'PUT', token, body: { expectedRevision: 2, blueprint: { requirements: Array.from({ length: 501 }, (_, i) => ({ id: `r${i}` })) } } })).data.code, 'ORIGIN_INVALID');
  assert.ok((await readFile(statePath)).equals(before), 'Origin never rewrites the board state file.');
  // Creating with Kanban goes through the board's own project and repository service.
  const both = await api(app, '/api/origin/projects', { method: 'POST', token, body: { name: 'Beacon', createKanban: true } });
  assert.equal(both.status, 200, JSON.stringify(both.data)); assert.deepEqual([both.data.project.kanban.exists, both.data.project.kanban.name], [true, 'Beacon']);
  const kanbanBeacon = (await app.board.view()).projects.find(project => project.name === 'Beacon');
  assert.ok(kanbanBeacon.repository, 'The Kanban project has its repository.');
  // A name clash does not lose the Origin project; it can be linked later without a duplicate.
  const clash = await api(app, '/api/origin/projects', { method: 'POST', token, body: { name: 'Existing project', createKanban: true } });
  assert.equal(clash.status, 200); assert.equal(clash.data.project.kanban, null); assert.ok(clash.data.kanbanError.message);
  assert.equal((await app.board.view()).projects.filter(project => project.name === 'Existing project').length, 1);
  const link = await api(app, `/api/origin/projects/${clash.data.project.id}/link`, { method: 'POST', token, body: { expectedRevision: 1, kanbanProjectId: existing.id } });
  assert.equal(link.status, 200); assert.equal(link.data.project.kanban.name, 'Existing project');
  assert.equal((await api(app, `/api/origin/projects/${id}/link`, { method: 'POST', token, body: { expectedRevision: 2, kanbanProjectId: existing.id } })).data.code, 'ALREADY_LINKED');
  // Delete from Origin keeps Kanban work by default.
  assert.equal((await api(app, `/api/origin/projects/${clash.data.project.id}/delete`, { method: 'POST', token, body: { expectedRevision: 2 } })).status, 200);
  assert.ok((await app.board.view()).projects.some(project => project.id === existing.id), 'Linked Kanban work stays.');
  // Removing the linked Kanban project is a separate choice and uses Kanban's own checks.
  const staleKanban = await api(app, `/api/origin/projects/${both.data.project.id}/delete`, { method: 'POST', token, body: { expectedRevision: 2, deleteKanban: true, expectedKanbanRevision: kanbanBeacon.revision + 5 } });
  assert.equal(staleKanban.status, 409);
  assert.equal((await api(app, `/api/origin/projects/${both.data.project.id}`, { token })).status, 200, 'A refused Kanban deletion removes nothing.');
  const removed = await api(app, `/api/origin/projects/${both.data.project.id}/delete`, { method: 'POST', token, body: { expectedRevision: 2, deleteKanban: true, expectedKanbanRevision: kanbanBeacon.revision } });
  assert.deepEqual([removed.status, removed.data.kanbanDeleted], [200, true]);
  assert.equal((await app.board.view()).projects.some(project => project.name === 'Beacon'), false);
  assert.equal((await api(app, `/api/origin/projects/${both.data.project.id}`, { method: 'PUT', token, body: { expectedRevision: 2, blueprint: {} } })).status, 404, 'A stale autosave cannot recreate a deleted project.');
  assert.deepEqual((await api(app, '/api/origin/projects', { token })).data.projects.map(project => project.name), ['Atlas']);
});

test('boards from older versions keep their data while Origin starts empty', async t => {
  const legacy = { schema: 'promptboard.state', version: 6, revision: 3, settings: { execution: 'inactive' }, runs: [], sessions: [], migrations: [], base: { revision: 0, resources: [], approvedRoots: [] },
    projects: [{ id: 'legacy-project', name: 'Legacy', createdAt: 1, revision: 1, repository: null, targetBranch: null, workflowMode: 'legacy', workflow: {}, pendingImport: null,
      tasks: [{ id: 'legacy-task', title: 'Old card', prompt: 'Old prompt', source: null, checksOutdated: false, createdAt: 1, updatedAt: 1, column: 'todo', revision: 1, contentRevision: 1, planApproval: null, workspace: null, retainedBranches: [], transitions: [] }] }] };
  const app = await startTestServer(t, { port: 0, executor: null, initialState: legacy });
  const { token } = (await api(app, '/api/session')).data;
  assert.deepEqual((await api(app, '/api/origin/projects', { token })).data.projects, []);
  const board = (await api(app, '/api/board', { token })).data.board;
  assert.equal(board.projects[0].tasks[0].prompt, 'Old prompt');
  assert.equal(JSON.parse(await readFile(join(app.board.store.dir, 'state.json'), 'utf8')).version, STATE_VERSION);
});

test('Kanban handoff uses the existing task API: To Do cards, ordered, no agent run', async t => {
  const app = await startTestServer(t, { port: 0, executor: null });
  const { token } = (await api(app, '/api/session')).data;
  const project = await app.board.createProject({ name: 'Notes', workflowMode: 'pipeline' });
  const blueprint = Model.normalizeBlueprint(sample()).blueprint;
  for (const task of Model.kanbanTasks(blueprint, ['i1', 'i2'], project.name)) {
    const created = await api(app, '/api/tasks', { method: 'POST', token, body: { projectId: project.id, title: task.title, prompt: task.prompt } });
    assert.equal(created.status, 200, JSON.stringify(created.data));
  }
  const view = await app.board.view();
  const saved = view.projects[0];
  const todo = saved.pipeline.columns.find(column => column.role === 'todo').id;
  assert.deepEqual(saved.tasks.map(task => [task.title, task.column]), [['IMP-001 Repository structure', todo], ['IMP-002 API', todo]]);
  assert.match(saved.tasks[1].prompt, /origin item i2/);
  assert.equal(view.runs.length, 0, 'No agent starts.');
});
