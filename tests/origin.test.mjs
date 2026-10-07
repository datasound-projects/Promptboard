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
    assumptions: '0 open', sources: '1 not verified', testing: '0 areas defined', plan: '2 tasks · 0 in Kanban' });
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
  assert.deepEqual(Model.orderItems(blueprint, ['i2', 'i1']), ['i1', 'i2'], 'Prerequisites come first.');
  const built = Model.taskContext(blueprint, 'i2', { projectName: 'Notes' });
  assert.match(Model.taskBody(built, { projectName: 'Notes' }), /Origin reference: IMP-002 \(origin task i2\) in Notes/);
  assert.match(built.context, /## Starts after\n- IMP-001 Repository structure/);
  assert.match(built.context, /- A maintainer can publish/, 'Related requirement acceptance criteria are included.');
  blueprint.areas.push({ id: 'test1', origin: 'human', section: 'testing', area: 'integration', title: 'Publish flow', description: 'Runs against a disposable database.', status: 'defined', componentIds: [], requirementIds: ['r1'], technologyIds: [], baseResourceIds: [] });
  assert.match(Model.taskContext(blueprint, 'i2').context, /## Planned tests\n- Integration tests: Publish flow — Runs against a disposable database\./, 'Testing plans carry into task context.');
  assert.match(Model.composeSpec(blueprint, 'requirements', 'r1').text, /## Planned tests\n- Integration tests: Publish flow/);
});

test('projects reword phases, sections and questions; behaviour follows IDs and answers stay with their question', () => {
  const blueprint = sample();
  Object.assign(blueprint, {
    labels: { phases: { define: 'Discover', bogus: 'x' }, sections: { requirements: 'Must-haves', nope: 'x' } },
    customSections: [{ id: 'cs1', phase: 'design', title: 'Accessibility', description: 'WCAG AA' }, { id: 'requirements', phase: 'define', title: 'Clash' }, { id: 'cs2', phase: 'nowhere', title: 'Later' }],
    questions: [{ id: 'q1', scope: 'section', sectionId: 'cs1', text: 'Which screen readers?' }, { id: 'q2', scope: 'component', text: 'Who owns it?' }, { id: 'q3', scope: 'section', sectionId: 'gone', text: 'Orphan' }],
    answers: { q1: 'VoiceOver and NVDA', q2: 'wrong scope', q9: 'unknown' },
    questionText: { 'section:requirements': 'What must it do?', 'vision:goal': 'Why now?', 'bad key': 'x' },
  });
  blueprint.components[1].answers = { q2: 'Platform team', q1: 'wrong scope' };
  const { blueprint: clean, repairs } = Model.normalizeBlueprint(blueprint);
  assert.deepEqual(clean.labels, { phases: { define: 'Discover' }, sections: { requirements: 'Must-haves' } });
  assert.deepEqual(clean.customSections.map(entry => [entry.id, entry.phase]), [['cs1', 'design'], ['cs2', 'define']], 'A custom section never takes a built-in ID.');
  assert.deepEqual(clean.questions.map(entry => entry.id), ['q1', 'q2']);
  assert.deepEqual([clean.answers, clean.components[1].answers], [{ q1: 'VoiceOver and NVDA' }, { q2: 'Platform team' }], 'Answers only belong to questions of their own scope.');
  assert.deepEqual(Object.keys(clean.questionText), ['section:requirements', 'vision:goal']);
  assert.ok(repairs >= 9, `every dropped entry is counted (${repairs})`);
  assert.deepEqual([Model.sectionTitle(clean, 'requirements'), Model.sectionTitle(clean, 'cs1'), Model.sectionTitle(clean, 'vision'), Model.phaseTitle(clean, 'define')], ['Must-haves', 'Accessibility', 'Vision & Scope', 'Discover']);
  assert.deepEqual(Model.phaseList(clean).map(phase => phase.sections.at(-1)), ['cs2', 'cs1', 'observability', 'decisions', 'plan']);
  assert.equal(Model.questionText(clean, 'vision:goal', 'What is the goal?'), 'Why now?');
  // Renaming changes no checks: issues and readiness are those of the unrenamed blueprint.
  const plain = Model.normalizeBlueprint(sample()).blueprint, shape = list => list.map(issue => [issue.id, issue.kind, issue.blocking]);
  assert.deepEqual(shape(Model.issues(clean)), shape(Model.issues(plain)));
  assert.equal(Model.readiness(clean).state, Model.readiness(plain).state);
  // Rewording a question keeps its answer; a new unanswered question shows the section in progress.
  clean.questions[0].text = 'Which assistive tech?';
  assert.equal(Model.normalizeBlueprint(clean).blueprint.answers.q1, 'VoiceOver and NVDA');
  assert.deepEqual([Model.sectionStates(clean).cs1, Model.sectionStates(clean).cs2], ['defined', 'empty']);
  assert.doesNotMatch(Model.taskContext(clean, 'i1', { projectName: 'Notes' }).context, /Accessibility|VoiceOver/, 'Custom notes are not assumed to apply to every task.');
  clean.questions.push({ id: 'q4', origin: 'human', scope: 'section', sectionId: 'cs1', text: 'Contrast?' });
  assert.equal(Model.sectionStates(clean).cs1, 'progress');
  clean.customSections[0].notApplicable = true;
  assert.equal(Model.sectionStates(clean).cs1, 'na');
});

test('tasks live with their first component, its layer, their own layer or the project, and keep notes of removed links', () => {
  const blueprint = sample();
  blueprint.layers = [{ id: 'L1', name: 'Backend', technologyIds: ['t1', 'missing'] }];
  blueprint.components[1].layerId = 'L1';
  blueprint.items.push({ id: 'i3', key: 'IMP-003', title: 'Logging', layerId: 'L1' }, { id: 'i4', key: 'IMP-004', title: 'Orphaned', componentIds: ['gone'],
    lostLinks: [{ collection: 'components', name: 'Queue' }, { collection: 'layers', name: 'x' }, 'bad'] });
  const { blueprint: clean } = Model.normalizeBlueprint(blueprint);
  assert.deepEqual(clean.layers[0].technologyIds, ['t1']);
  const homes = Object.fromEntries(clean.items.map(item => [item.id, Model.taskHome(clean, item)]));
  assert.deepEqual(homes, { i2: { componentId: 'api', layerId: 'L1' }, i1: { componentId: '', layerId: '' }, i3: { componentId: '', layerId: 'L1' }, i4: { componentId: '', layerId: '' } });
  assert.deepEqual(clean.items.find(item => item.id === 'i4').lostLinks, [{ collection: 'components', name: 'Queue' }], 'Only well-formed component notes are kept.');
  const missing = Model.issues(clean).filter(issue => issue.rule === 'task-link-missing');
  assert.deepEqual(missing.map(issue => [issue.title, issue.blocking]), [['IMP-004 Orphaned lost its link to the removed component “Queue”.', false]]);
  assert.deepEqual(Model.readiness(clean).rows.find(row => row.id === 'plan'), { id: 'plan', label: 'Tasks', value: '4 tasks · 0 in Kanban', section: 'plan' });
});

function contextSample() {
  const blueprint = sample();
  Object.assign(blueprint.vision, { outOfScope: 'Mobile apps', constraints: 'EU hosting only' });
  blueprint.technologies.push({ id: 't3', name: 'MongoDB', status: 'rejected' }, { id: 't4', name: 'Valkey', status: 'candidate' });
  blueprint.layers = [{ id: 'L1', name: 'Backend', technologyIds: ['t1', 't3', 't4'], constraints: 'Validate every input' }];
  blueprint.components[1].layerId = 'L1';
  blueprint.components[1].interfaces = 'REST /notes';
  blueprint.requirements.push({ id: 'r3', key: 'REQ-003', title: 'Fast pages', type: 'performance', acceptanceCriteria: 'p95 under 200 ms' });
  blueprint.decisions.push({ id: 'd2', key: 'ADR-002', title: 'Cache', status: 'proposed', componentIds: ['api'] }, { id: 'd3', key: 'ADR-003', title: 'Logging', decision: 'JSON lines', status: 'accepted' });
  blueprint.areas = [{ id: 'a1', section: 'security', area: 'secrets', title: 'Vault for keys', componentIds: ['api'] }, { id: 'a2', section: 'deployment', area: 'hosting', title: 'Fly.io', componentIds: ['api'] },
    { id: 'a3', section: 'observability', area: 'logs', title: 'Not linked' }];
  blueprint.sections = { deployment: { notApplicable: true } };
  blueprint.customSections = [{ id: 'cs1', phase: 'design', title: 'Accessibility', description: 'WCAG AA' }];
  blueprint.questions = [{ id: 'q1', scope: 'section', sectionId: 'cs1', text: 'Screen readers?' }];
  blueprint.answers = { q1: 'VoiceOver' };
  blueprint.items[0].description = 'Add POST /notes.\n  Keep it small — not MongoDB.';
  blueprint.items.push({ id: 'i3', key: 'IMP-003', title: 'Request logging', layerId: 'L1' });
  return blueprint;
}

test('task context is chosen from the task’s own links, keeps its words exactly, and never sends the whole blueprint', () => {
  const blueprint = Model.normalizeBlueprint(contextSample()).blueprint;
  const built = Model.taskContext(blueprint, 'i2', { projectName: 'Notes' });
  assert.equal(built.instruction, '# IMP-002 API\n\n## What to do\nAdd POST /notes.\n  Keep it small — not MongoDB.\n\n## Done when\nPublishing works', 'The task text is kept exactly.');
  for (const expected of [/## Out of scope\nMobile apps/, /## Project constraints\nEU hosting only/, /Stack: Node\.js 22, Valkey \(candidate — not decided\)/, /## Shared rules for Backend\nValidate every input/,
    /## Connections of API\n- ← Web Client \(Client\) — calls, HTTPS\n- → PostgreSQL \(Database\) — stores, SQL/, /Accepted when:\n- A maintainer can publish\n- Readers see it/,
    /## Requirement REQ-003 Fast pages \(project-wide\)/, /## Starts after\n- IMP-001 Repository structure/, /ADR-001 Database: PostgreSQL/, /Security · Secrets: Vault for keys/, /Node\.js releases <https:\/\/nodejs\.org[^>]*> — verified/]) {
    assert.match(built.context, expected);
  }
  for (const absent of [/MongoDB \(/, /REQ-002/, /Fly\.io/, /Not linked/, /ADR-003/, /Accessibility/, /Repository structure — done when/]) assert.doesNotMatch(built.context, absent);
  assert.deepEqual(built.warnings, ['ADR-002 Cache is still open.', 'The task mentions MongoDB, which was rejected.', 'The task mentions “MongoDB”, an alternative that ADR-001 did not choose.']);
  // Explicit links add exactly what was linked; a layer-level task gets its layer without components.
  blueprint.items.find(item => item.id === 'i2').contextIds = [{ collection: 'customSections', id: 'cs1' }, { collection: 'decisions', id: 'd3' }];
  const linked = Model.taskContext(blueprint, 'i2', { projectName: 'Notes' });
  assert.match(linked.context, /## Notes: Accessibility\nWCAG AA\n- Screen readers\? → VoiceOver/);
  assert.match(linked.context, /ADR-003 Logging: JSON lines/);
  assert.match(Model.taskContext(blueprint, 'i3').context, /## Layer: Backend[\s\S]*## Shared rules for Backend/);
  // Deterministic, and blind to layout.
  blueprint.layout.map.nodes = { vision: { x: 10, y: 10 } }; blueprint.components[1].x = 999;
  assert.equal(Model.taskContext(blueprint, 'i2', { projectName: 'Notes' }).context, linked.context);
  // Too large: optional parts go first; essentials are never cut, and an oversized essential part is refused.
  const small = Model.taskContext(blueprint, 'i2', { projectName: 'Notes', limit: 900 });
  assert.equal(small.tooLarge, false);
  assert.ok(small.omitted.length > 0 && /Left out for size/.test(small.context));
  assert.match(small.context, /Accepted when:\n- A maintainer can publish/);
  const tiny = Model.taskContext(blueprint, 'i2', { projectName: 'Notes', limit: 100 });
  assert.equal(tiny.tooLarge, true);
  assert.match(tiny.error, /over the 100 limit/);
  assert.equal(Model.taskContext(blueprint, 'missing'), null);
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

test('Send to Kanban creates each card once, prerequisites first, with its Origin identity, and starts nothing', async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const { token } = (await api(app, '/api/session')).data;
  const kanban = await app.board.createProject({ name: 'Notes', workflowMode: 'pipeline' });
  const store = new OriginStore(app.board.store.dir);
  let record = await store.create({ name: 'Notes design' });
  record = await store.link(record.id, { expectedRevision: record.revision, kanbanProjectId: kanban.id });
  record = await store.write(record.id, { expectedRevision: record.revision, blueprint: sample() });
  const send = (body, revision = record.revision) => api(app, `/api/origin/projects/${record.id}/handoff`, { method: 'POST', token, body: { expectedRevision: revision, ...body } });
  const cards = async () => (await app.board.view()).projects[0].tasks;
  // A prerequisite without a card is neither left out silently nor added without asking.
  let response = await send({ itemIds: ['i2'] });
  assert.deepEqual([response.status, response.data.code, response.data.prerequisites.map(entry => entry.key)], [409, 'PREREQUISITES_MISSING', ['IMP-001']]);
  assert.equal((await send({ itemIds: ['i1'] }, record.revision - 1)).data.code, 'ORIGIN_REVISION_CONFLICT');
  assert.equal((await cards()).length, 0);
  response = await send({ itemIds: ['i2'], includePrerequisites: true });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.deepEqual(response.data.results.map(result => [result.key, result.status]), [['IMP-001', 'created'], ['IMP-002', 'created']]);
  const view = await app.board.view(), todo = view.projects[0].pipeline.columns.find(column => column.role === 'todo').id;
  let [first, second] = view.projects[0].tasks;
  assert.deepEqual([first.title, first.column, second.title, second.column], ['IMP-001 Repository structure', todo, 'IMP-002 API', todo]);
  assert.deepEqual(second.dependsOn, [first.id]);
  assert.deepEqual([second.originSource.originProjectId, second.originSource.originTaskId, second.originSource.key], [record.id, 'i2', 'IMP-002']);
  assert.match(second.prompt, /^# IMP-002 API\n\n## Done when\nPublishing works\n\n---\n\n# Context from the Origin design/);
  assert.match(second.prompt, /## Starts after\n- IMP-001 Repository structure/);
  assert.equal(view.runs.length, 0, 'No agent starts.');
  record = await store.read(record.id);
  const handed = record.blueprint.items.find(item => item.id === 'i2').handoff;
  assert.deepEqual([handed.projectId, handed.taskId, handed.hash, second.originSource.snapshotId], [kanban.id, second.id, second.originSource.hash, handed.snapshotId]);
  const snapshot = JSON.parse(await readFile(join(app.board.store.dir, 'origin', 'snapshots', record.id, `${handed.snapshotId}.json`), 'utf8'));
  assert.ok(second.prompt.startsWith(snapshot.instruction) && second.prompt.includes(snapshot.context), 'The card carries exactly the approved snapshot.');
  // Repeated and concurrent sends return the existing cards.
  const [a, b] = await Promise.all([send({ itemIds: ['i1', 'i2'] }), send({ itemIds: ['i1', 'i2'] })]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.ok([...a.data.results, ...b.data.results].every(result => result.status === 'existing'));
  assert.equal((await cards()).length, 2);
  // An interrupted handoff (card created, Origin link lost) is repaired from the card.
  record.blueprint.items.forEach(item => { item.handoff = null; });
  record = await store.write(record.id, { expectedRevision: record.revision, blueprint: record.blueprint });
  response = await send({ itemIds: ['i2'] });
  assert.deepEqual(response.data.results.map(result => [result.key, result.status, result.taskId]), [['IMP-002', 'existing', second.id]]);
  assert.equal((await store.read(record.id)).blueprint.items.find(item => item.id === 'i2').handoff.taskId, second.id);
  record = await store.read(record.id);
  // A card deleted in Kanban is created again only when asked.
  await app.board.deleteTask(second.id, { expectedRevision: second.revision });
  response = await send({ itemIds: ['i2'] });
  assert.deepEqual([response.status, response.data.code, response.data.removed.map(entry => entry.key)], [409, 'CARDS_REMOVED', ['IMP-002']]);
  response = await send({ itemIds: ['i2'], recreate: ['i2'] });
  assert.deepEqual(response.data.results.map(result => [result.key, result.status]), [['IMP-002', 'created']]);
  [first, second] = await cards();
  assert.deepEqual([second.dependsOn, (await cards()).length], [[first.id], 2]);
});

test('a card with prerequisites starts only after they are done; a deleted prerequisite can be cleared; backups and copies keep the right fields', async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const { token } = (await api(app, '/api/session')).data;
  const kanban = await app.board.createProject({ name: 'Notes', workflowMode: 'pipeline' });
  const [first, second] = await app.board.createOriginTasks(kanban.id, { originProjectId: 'o1', tasks: [
    { originTaskId: 'a', key: 'IMP-001', title: 'IMP-001 Schema', prompt: 'Schema' }, { originTaskId: 'b', key: 'IMP-002', title: 'IMP-002 API', prompt: 'API', dependsOnOrigin: ['a'] }] });
  assert.deepEqual([first.status, second.status], ['created', 'created']);
  const columns = (await app.board.view()).projects[0].pipeline.columns;
  const active = columns.find(column => column.role === 'active').id, done = columns.find(column => column.role === 'done').id;
  const card = async id => (await app.board.view()).projects[0].tasks.find(task => task.id === id);
  const move = async (id, column) => api(app, `/api/tasks/${id}/move`, { method: 'POST', token, body: { column, expectedRevision: (await card(id)).revision } });
  let response = await move(second.taskId, active);
  assert.deepEqual([response.status, response.data.code], [409, 'PREREQUISITES_PENDING']);
  assert.match(response.data.error, /Finish its prerequisites first: #1 IMP-001 Schema \(/);
  assert.equal((await card(second.taskId)).column, columns.find(column => column.role === 'todo').id, 'The card stays in To Do.');
  // Copies are new cards: no Origin identity, same prerequisites. Backups keep both fields.
  const copy = await app.board.duplicateTask(second.taskId);
  assert.deepEqual([copy.originSource, copy.dependsOn], [undefined, [first.taskId]]);
  const backup = await app.board.exportBackup();
  const exported = backup.projects[0].tasks.find(task => task.id === second.taskId);
  assert.deepEqual([exported.originSource.originTaskId, exported.dependsOn], ['b', [first.taskId]]);
  await app.board.deleteTask(copy.id, { expectedRevision: copy.revision });
  // Done prerequisites let the card start (here it then stops for lack of an agent, not for prerequisites).
  assert.equal((await move(first.taskId, done)).status, 200);
  response = await move(second.taskId, active);
  assert.notEqual(response.data.code, 'PREREQUISITES_PENDING');
  // A deleted prerequisite blocks the start until it is cleared explicitly.
  const third = (await app.board.createOriginTasks(kanban.id, { originProjectId: 'o1', tasks: [{ originTaskId: 'c', key: 'IMP-003', title: 'IMP-003 UI', prompt: 'UI', dependsOnTaskIds: [first.taskId] }] }))[0];
  await app.board.deleteTask(first.taskId, { expectedRevision: (await card(first.taskId)).revision });
  response = await move(third.taskId, active);
  assert.match(response.data.error, /a prerequisite card that was deleted/);
  response = await api(app, `/api/tasks/${third.taskId}/prerequisites`, { method: 'POST', token, body: { prerequisiteId: first.taskId, expectedRevision: (await card(third.taskId)).revision } });
  assert.equal(response.status, 200);
  assert.equal((await card(third.taskId)).dependsOn, undefined);
  // Invalid identities and foreign prerequisites are refused.
  const bad = await app.board.createOriginTasks(kanban.id, { originProjectId: 'o1', tasks: [{ originTaskId: 'd', key: 'IMP-004', title: 'IMP-004 X', prompt: 'X', dependsOnTaskIds: ['not-a-card'] }] });
  assert.deepEqual([bad[0].status, bad[0].code], ['failed', 'INVALID_INPUT']);
});

test('the context endpoint builds from the saved revision, removes secrets from context and saves immutable snapshots', async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const store = new OriginStore(app.board.store.dir);
  const created = await store.create({ name: 'Notes' });
  const blueprint = contextSample();
  blueprint.components[1].interfaces = 'REST /notes with api_key=sk-live-123456';
  blueprint.items[0].acceptanceCriteria = 'Publishing works\npassword: hunter2';
  const saved = await store.write(created.id, { expectedRevision: 1, blueprint });
  const token = (await api(app, '/api/session')).data.token;
  const stale = await api(app, `/api/origin/projects/${created.id}/context`, { method: 'POST', token, body: { expectedRevision: 1, itemIds: ['i2'] } });
  assert.deepEqual([stale.status, stale.data.code], [409, 'ORIGIN_REVISION_CONFLICT'], 'Unsaved edits are never described.');
  const { status, data } = await api(app, `/api/origin/projects/${created.id}/context`, { method: 'POST', token, body: { expectedRevision: saved.revision, itemIds: ['i2'] } });
  assert.equal(status, 200);
  const [task] = data.tasks;
  assert.match(task.context, /api_key=\[redacted\]/);
  assert.doesNotMatch(task.context, /sk-live-123456/);
  assert.match(task.instruction, /password: hunter2/, 'The task’s own words are not rewritten.');
  assert.ok(task.warnings.includes('The task text looks like it contains a secret. Remove it before sending.'));
  assert.ok(task.body.startsWith(task.instruction) && task.body.includes('# Context from the Origin design') && /^[a-f0-9]{64}$/.test(task.hash));
  assert.equal((await api(app, `/api/origin/projects/${created.id}/context`, { method: 'POST', token, body: { expectedRevision: saved.revision, itemIds: ['nope'] } })).status, 404);
  // Layout changes keep the hash; content changes move it.
  const record = await store.read(created.id);
  record.blueprint.layout.map.nodes = { vision: { x: 5, y: 5 } };
  const moved = await store.write(created.id, { expectedRevision: record.revision, blueprint: record.blueprint });
  const again = (await api(app, `/api/origin/projects/${created.id}/context`, { method: 'POST', token, body: { expectedRevision: moved.revision, itemIds: ['i2'] } })).data.tasks[0];
  assert.equal(again.hash, task.hash);
  moved.blueprint.requirements[0].acceptanceCriteria += '\nAnd an RSS feed';
  const edited = await store.write(created.id, { expectedRevision: moved.revision, blueprint: moved.blueprint });
  assert.notEqual((await store.context(created.id, { expectedRevision: edited.revision, itemIds: ['i2'] })).tasks[0].hash, task.hash);
  // A snapshot is written once and never overwritten.
  const snap = await store.snapshot(created.id, { ...task, omitted: [] }, saved.revision);
  const file = JSON.parse(await readFile(join(app.board.store.dir, 'origin', 'snapshots', created.id, `${snap.id}.json`), 'utf8'));
  assert.deepEqual([file.schema, file.itemId, file.hash, file.instruction, file.revision], ['promptboard.origin-snapshot', 'i2', task.hash, task.instruction, saved.revision]);
  assert.notEqual((await store.snapshot(created.id, { ...task, omitted: [] }, saved.revision)).id, snap.id);
});
