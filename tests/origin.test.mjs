import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../public/origin-model.js';
import { OriginStore, originFileName } from '../src/origin.mjs';
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
  for (const rule of ['technology-unverified', 'technology-unused', 'dependency-unverified', 'duplicate-dependencies', 'decision-proposed', 'requirement-draft', 'requirement-criteria', 'security-plan', 'testing-plan', 'plan-order', 'recorded'])
    assert.ok(rules.includes(rule), `missing rule ${rule}`);
  assert.equal(found.find(issue => issue.title.includes('Redis') && issue.rule === 'technology-unused').origin, 'system');
  assert.equal(found.find(issue => issue.title === 'Vendor lock-in').origin, 'human');
  assert.equal(found.find(issue => issue.title === 'Consider rate limits').origin, 'ai');
  assert.equal(found.find(issue => issue.title === 'Consider rate limits').blocking, false, 'AI suggestions never block readiness.');
  assert.equal(found.some(issue => issue.title.includes('Node.js') && issue.kind === 'unverified'), false, 'Verified evidence clears the check.');
});

test('readiness is explained by stored counts and semantic states', () => {
  assert.equal(Model.readiness(Model.emptyBlueprint()).state, 'not_started');
  const blueprint = Model.normalizeBlueprint(sample()).blueprint;
  let ready = Model.readiness(blueprint);
  assert.equal(ready.state, 'attention');
  assert.deepEqual(Object.fromEntries(ready.rows.map(row => [row.id, row.value])), {
    requirements: '2 / 2 defined', components: '3 / 3 described', technologies: '1 / 2 verified', dependencies: '0 / 0 verified', decisions: '0 unresolved',
    assumptions: '0 open', sources: '1 not verified', testing: '0 areas defined', plan: '2 items · 0 sent to Kanban' });
  assert.deepEqual(ready.reasons, ['1 unverified technology or dependency remains.']);
  blueprint.technologies[1].sourceIds = ['s1'];
  blueprint.technologies[1].status = 'rejected';
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
});

test('blueprint files initialize safely, persist per project and reject stale revisions', async t => {
  const dir = await temp(t), store = new OriginStore(dir);
  assert.deepEqual(await store.read('p1'), { exists: false, revision: 0, createdAt: null, updatedAt: null, blueprint: null, repairs: 0, recovery: null });
  const saved = await store.write('p1', { expectedRevision: 0, blueprint: sample() });
  assert.equal(saved.revision, 1);
  await assert.rejects(store.write('p1', { expectedRevision: 0, blueprint: sample() }), { code: 'ORIGIN_REVISION_CONFLICT', status: 409 });
  await store.write('P1', { expectedRevision: 0, blueprint: { idea: 'Other project' } });
  const reloaded = new OriginStore(dir);
  assert.equal((await reloaded.read('p1')).blueprint.components.length, 3);
  assert.equal((await reloaded.read('P1')).blueprint.idea, 'Other project');
  assert.deepEqual((await readdir(join(dir, 'origin'))).sort(), ['project-_p1.json', 'project-p1.json']);
  assert.equal(originFileName('a_B'), 'project-a___b.json');
  for (const bad of ['../state', 'a/b', '', 'x'.repeat(101), 'a.b']) await assert.rejects(store.read(bad), { code: 'INVALID_PROJECT' });
  const file = JSON.parse(await readFile(join(dir, 'origin', 'project-p1.json'), 'utf8'));
  assert.equal(file.schema, 'promptboard.origin'); assert.equal(file.version, 1); assert.equal(file.projectId, 'p1');
});

test('damaged blueprint files are contained and newer files are never overwritten', async t => {
  const dir = await temp(t), store = new OriginStore(dir), path = join(dir, 'origin', 'project-p1.json');
  await store.write('p1', { expectedRevision: 0, blueprint: { idea: 'First' } });
  await store.write('p1', { expectedRevision: 1, blueprint: { idea: 'Second' } });
  await writeFile(path, '{ "schema": "promptboard.origin", broken');
  const recovered = await store.read('p1');
  assert.equal(recovered.blueprint.idea, 'First', 'The last good backup is used.');
  assert.equal(recovered.recovery.restoredFromBackup, true);
  assert.match(recovered.recovery.quarantined, /^project-p1\.corrupt-\d+-[a-f0-9]{8}\.json$/);
  assert.equal(await readFile(join(dir, 'origin', recovered.recovery.quarantined), 'utf8'), '{ "schema": "promptboard.origin", broken');
  await writeFile(path, 'not json'); await writeFile(`${path}.bak`, 'not json either');
  const empty = await store.read('p1');
  assert.equal(empty.exists, false); assert.equal(empty.recovery.restoredFromBackup, false);
  assert.equal((await store.write('p1', { expectedRevision: 0, blueprint: { idea: 'Fresh' } })).revision, 1);
  const newer = JSON.stringify({ schema: 'promptboard.origin', version: 2, projectId: 'p1', revision: 9, blueprint: {} });
  await writeFile(path, newer);
  await assert.rejects(store.read('p1'), { code: 'ORIGIN_VERSION_UNSUPPORTED' });
  await assert.rejects(store.write('p1', { expectedRevision: 9, blueprint: {} }), { code: 'ORIGIN_VERSION_UNSUPPORTED' });
  assert.equal(await readFile(path, 'utf8'), newer);
});

test('a failed blueprint write reports an error and keeps the previous file', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-origin-')), store = new OriginStore(dir), path = join(dir, 'origin', 'project-p1.json');
  t.after(async () => { await chmod(join(dir, 'origin'), 0o700).catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  await store.write('p1', { expectedRevision: 0, blueprint: { idea: 'Kept' } });
  const before = await readFile(path, 'utf8');
  await chmod(join(dir, 'origin'), 0o500);
  await assert.rejects(store.write('p1', { expectedRevision: 1, blueprint: { idea: 'Lost?' } }), { code: 'ORIGIN_WRITE_FAILED', status: 500 });
  await chmod(join(dir, 'origin'), 0o700);
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal((await store.read('p1')).blueprint.idea, 'Kept');
});

async function api(app, path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${app.url}${path}`, { method, headers: { ...(token === undefined ? {} : { 'X-STE-Token': token }), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}

test('the Origin API is authenticated, project-scoped and leaves board state byte-identical', async t => {
  const app = await startTestServer(t, { port: 0, executor: null });
  const { token } = (await api(app, '/api/session')).data;
  const project = await app.board.createProject({ name: 'Existing project' });
  await app.board.createTask({ projectId: project.id, title: 'Existing task', prompt: 'Keep me.' });
  const statePath = join(app.board.store.dir, 'state.json');
  const before = await readFile(statePath);
  const stateFiles = async () => (await readdir(app.board.store.dir)).filter(name => name.startsWith('state')).sort();
  const filesBefore = await stateFiles();
  assert.equal(JSON.parse(before).version, STATE_VERSION); assert.equal(STATE_VERSION, 12);
  assert.equal((await api(app, `/api/origin/projects/${project.id}`)).status, 403, 'The session token is required.');
  assert.equal((await api(app, '/api/origin/projects/unknown', { token })).status, 404);
  assert.equal((await api(app, '/api/origin/projects/..%2Fstate', { token })).status, 404);
  const empty = await api(app, `/api/origin/projects/${project.id}`, { token });
  assert.equal(empty.status, 200); assert.equal(empty.data.exists, false); assert.equal(empty.data.blueprint, null);
  const saved = await api(app, `/api/origin/projects/${project.id}`, { method: 'PUT', token, body: { expectedRevision: 0, blueprint: sample() } });
  assert.equal(saved.status, 200); assert.equal(saved.data.revision, 1); assert.equal(saved.data.repairs, 0);
  assert.equal((await api(app, `/api/origin/projects/${project.id}`, { method: 'PUT', token, body: { expectedRevision: 0, blueprint: sample() } })).status, 409);
  assert.equal((await api(app, `/api/origin/projects/${project.id}`, { method: 'PUT', token, body: { expectedRevision: 1, blueprint: [] } })).status, 400);
  assert.equal((await api(app, `/api/origin/projects/${project.id}`, { method: 'PUT', token, body: { expectedRevision: 1, blueprint: { requirements: Array.from({ length: 501 }, (_, i) => ({ id: `r${i}` })) } } })).data.code, 'ORIGIN_INVALID');
  const loaded = await api(app, `/api/origin/projects/${project.id}`, { token });
  assert.equal(loaded.data.blueprint.requirements[0].key, 'REQ-001');
  const after = await readFile(statePath);
  assert.ok(after.equals(before), 'Origin never rewrites the board state file.');
  assert.deepEqual(await stateFiles(), filesBefore, 'No board backup or migration file is created by Origin.');
  // A deleted project leaves an orphaned blueprint file; Origin reports the missing project without failing.
  await app.board.deleteProject(project.id, { expectedRevision: project.revision });
  assert.equal((await api(app, `/api/origin/projects/${project.id}`, { token })).status, 404);
  assert.ok((await readdir(join(app.board.store.dir, 'origin'))).includes(originFileName(project.id)));
});

test('projects from older board versions open in Origin without a blueprint and keep their board data', async t => {
  const legacy = { schema: 'promptboard.state', version: 6, revision: 3, settings: { execution: 'inactive' }, runs: [], sessions: [], migrations: [], base: { revision: 0, resources: [], approvedRoots: [] },
    projects: [{ id: 'legacy-project', name: 'Legacy', createdAt: 1, revision: 1, repository: null, targetBranch: null, workflowMode: 'legacy', workflow: {}, pendingImport: null,
      tasks: [{ id: 'legacy-task', title: 'Old card', prompt: 'Old prompt', source: null, checksOutdated: false, createdAt: 1, updatedAt: 1, column: 'todo', revision: 1, contentRevision: 1, planApproval: null, workspace: null, retainedBranches: [], transitions: [] }] }] };
  const app = await startTestServer(t, { port: 0, executor: null, initialState: legacy });
  const { token } = (await api(app, '/api/session')).data;
  const read = await api(app, '/api/origin/projects/legacy-project', { token });
  assert.equal(read.status, 200); assert.equal(read.data.exists, false);
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
