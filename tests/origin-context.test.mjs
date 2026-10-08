import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../public/origin-model.js';
import { ContextStore, DOCUMENT_BYTES, FIELDS, PAGE_BYTES, TOP_FIELDS, contextPages, exportProjectContext } from '../src/origin-context.mjs';
import { prepareBase } from '../src/base-context.mjs';
import { markdownSections } from '../src/compose-documents.mjs';
import { buildIndex, chunkPages } from '../src/compose-retrieval.mjs';
import { blueprintFileName } from '../src/origin.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const Model = globalThis.PromptboardOriginModel;
const temp = async t => { const dir = await mkdtemp(join(tmpdir(), 'pb-context-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };
const record = (blueprint, extra = {}) => ({ id: 'proj1', name: 'Notes', description: 'Release notes app', kanbanProjectId: null, revision: 3, blueprint: Model.normalizeBlueprint(blueprint).blueprint, ...extra });
const body = markdown => markdown.slice(markdown.indexOf('<a id="ctx-phase-define">'));

/** Every stored field holds a unique marker, so a field the exporter forgets is visible. */
function full() {
  const bp = Model.emptyBlueprint(), m = name => `«${name}»`;
  bp.idea = m('idea');
  for (const key of Model.VISION) bp.vision[key] = m(`vision.${key}`);
  bp.labels = { phases: { define: m('phase-label') }, sections: { requirements: m('section-label') } };
  bp.questionText = { 'section:security': m('section-question'), 'vision:goal': m('vision-wording'), 'topic:data:storage': m('topic-wording'), 'field:components:purpose': m('field-wording') };
  bp.sections = { ai: { notApplicable: true } };
  bp.customSections.push({ id: 'cs1', phase: 'operate', title: m('custom.title'), description: m('custom.description'), notApplicable: true });
  bp.questions.push({ id: 'q1', scope: 'section', sectionId: 'cs1', text: m('custom.question') }, { id: 'q2', scope: 'section', sectionId: 'testing', text: m('builtin.question') },
    { id: 'q3', scope: 'component', sectionId: '', text: m('component.question') });
  bp.answers = { q1: m('custom.answer'), q2: m('builtin.answer') };
  bp.sources.push({ id: 's1', title: m('sources.title'), url: 'https://example.com/a', type: 'standard', claim: m('sources.claim'), accessedAt: '2026-01-02', verification: 'verified', notes: m('sources.notes') });
  bp.technologies.push({ id: 't1', name: m('tech.name'), category: 'database', purpose: m('tech.purpose'), version: m('tech.version'), status: 'selected', reason: m('tech.reason'), alternatives: m('tech.alternatives'), sourceIds: ['s1'] },
    { id: 't2', name: m('tech.rejected'), status: 'rejected', reason: m('tech.rejected.reason') }, { id: 't3', name: m('tech.candidate'), status: 'candidate' });
  bp.layers.push({ id: 'L1', name: m('layer.name'), description: m('layer.description'), technologyIds: ['t1'], constraints: m('layer.rules') });
  bp.components.push({ id: 'web', name: m('web.name'), type: 'client', purpose: m('web.purpose'), responsibilities: m('web.responsibilities'), technologyIds: ['t1'], interfaces: m('web.interfaces'),
    dataHandled: m('web.data'), status: 'defined', notes: m('web.notes'), sourceIds: ['s1'], x: 11, y: 22, layerId: 'L1', answers: { q3: m('web.answer') } },
  { id: 'api', name: m('api.name'), type: 'api' });
  bp.connections.push({ id: 'c1', from: 'web', to: 'api', label: m('conn.label'), protocol: m('conn.protocol'), notes: m('conn.notes') }, { id: 'c2', from: 'api', to: 'web', label: 'back' });
  bp.requirements.push({ id: 'r1', key: 'REQ-001', title: m('req.title'), description: m('req.description'), type: 'security', priority: 'must', status: 'defined', acceptanceCriteria: m('req.criteria'), componentIds: ['web'], sourceIds: ['s1'] });
  bp.dependencies.push({ id: 'dep1', name: m('dep.name'), type: 'sdk', version: m('dep.version'), requiredBy: ['web'], dependsOn: ['dep2'], sourceIds: ['s1'], notes: m('dep.notes') }, { id: 'dep2', name: m('dep2.name') });
  bp.decisions.push({ id: 'd1', key: 'ADR-001', title: m('dec.title'), context: m('dec.context'), decision: m('dec.decision'), alternatives: m('dec.alternatives'), reason: m('dec.reason'), consequences: m('dec.consequences'),
    status: 'superseded', date: '2026-02-03', supersededBy: 'd2', componentIds: ['web'], technologyIds: ['t1'], requirementIds: ['r1'], dependencyIds: ['dep1'], sourceIds: ['s1'] }, { id: 'd2', key: 'ADR-002', title: m('dec2.title'), status: 'accepted' });
  bp.assumptions.push({ id: 'a1', statement: m('asm.statement'), reason: m('asm.reason'), impact: m('asm.impact'), status: 'converted', decisionId: 'd2', sourceIds: ['s1'] });
  bp.risks.push({ id: 'k1', title: m('risk.title'), description: m('risk.description'), kind: 'conflict', severity: 'high', mitigation: m('risk.mitigation'), status: 'accepted', componentIds: ['api'] });
  bp.areas.push({ id: 'ar1', section: 'data', area: 'storage', title: m('area.title'), description: m('area.description'), status: 'defined', componentIds: ['web'], requirementIds: ['r1'], technologyIds: ['t1'], baseResourceIds: ['base-res-1'] },
    { id: 'ar2', section: 'ai', area: 'models', title: m('na.area') });
  bp.milestones.push({ id: 'm1', title: m('ms.title'), goal: m('ms.goal'), definitionOfDone: m('ms.done') });
  bp.items.push({ id: 'i1', key: 'IMP-001', milestoneId: 'm1', workstream: m('item.workstream'), title: m('item.title'), description: m('item.refined'), acceptanceCriteria: m('item.criteria'),
    requirementIds: ['r1'], componentIds: ['web'], contextIds: [{ collection: 'decisions', id: 'd2' }], status: 'ready',
    handoff: { projectId: 'kb1', taskId: 'card1', at: 1790000000000, snapshotId: 'snap1', hash: 'a'.repeat(64), keptHash: 'b'.repeat(64) },
    refinement: { proposal: m('item.proposal'), proposedAt: 1790000000000, basis: m('item.basis'), originalDescription: m('item.original'), acceptedAt: 1790000001000 }, lostLinks: [{ collection: 'components', name: m('item.lost') }] },
  { id: 'i2', key: 'IMP-002', title: m('item2.title'), dependsOn: ['i1', 'i3'] }, { id: 'i3', key: 'IMP-003', title: m('item3.title'), dependsOn: ['i2'], refinement: { proposal: m('item3.pending'), proposedAt: 1790000000000, basis: '', originalDescription: '', acceptedAt: null } });
  bp.layout.map = { width: 900, height: 700, nodes: { center: { x: 1, y: 2 }, vision: { x: 3, y: 4 } }, links: [{ id: 'ml1', from: 'vision', to: 'security', label: m('map.link') }] };
  return bp;
}

test('every stored design field is exported, with its wording, IDs and explicit states', () => {
  const source = record(full()), { markdown, unsupported, redactions } = exportProjectContext(source, { generatedAt: 1791000000000 });
  // The exporter knows every field normalization can produce; a new schema field must be added to FIELDS.
  const normalized = source.blueprint;
  for (const name of Object.keys(normalized)) assert.ok(TOP_FIELDS.includes(name), `top-level ${name}`);
  for (const [collection, fields] of Object.entries(FIELDS)) for (const entry of normalized[collection]) for (const key of Object.keys(entry)) assert.ok(['id', 'origin', ...fields].includes(key), `${collection}.${key}`);
  const markers = JSON.stringify(full()).match(/«[^»]+»/g);
  for (const marker of new Set(markers)) assert.ok(markdown.includes(marker.replace(/[\\`*_[\]<>|]/g, '\\$&')) || markdown.includes(marker), `missing ${marker}`);
  assert.deepEqual(unsupported, []); assert.deepEqual(redactions, []);
  for (const id of ['r1', 'web', 'api', 'c1', 'd1', 'i1', 'ml1', 'q3', 'snap1', 'base-res-1']) assert.match(markdown, new RegExp(`\`${id}\``));
  assert.match(markdown, /Not applicable — marked as not needed/); assert.match(markdown, /«na\.area»/); assert.match(markdown, /«custom\.answer»/);
  assert.match(markdown, /#### Rejected\n\n##### «tech\.rejected»/); assert.match(markdown, /#### Candidates \(not decided\)\n\n##### «tech\.candidate»/);
  assert.match(markdown, /Original “What to do” \(before the accepted refinement\)\*\*\n\n«item\.original»/);
  assert.match(markdown, /Pending Compose proposal \(not accepted\)\*\*\n\n«item3\.pending»/);
  assert.match(markdown, /The card's current column is not part of this document/);
  assert.match(markdown, /Base resource IDs; their contents are not copied/);
  assert.match(markdown, /Linked pages were not fetched/);
  assert.match(markdown, /_Not provided: /);
});

test('diagrams keep direction, layers, labels and cycles; visual links and prerequisites stay separate', () => {
  const { markdown } = exportProjectContext(record(full()));
  const blocks = [...markdown.matchAll(/```mermaid\n([\s\S]*?)\n```/g)].map(match => match[1]);
  assert.equal(blocks.length, 2);
  const [architecture, prerequisites] = blocks;
  const q = text => `#171;${text}#187;`; // « and » are written as Mermaid entity codes
  assert.ok(architecture.startsWith(`flowchart LR\n  subgraph L_L1["${q('layer.name')}"]\n    C_web["${q('web.name')}"]\n  end\n  C_api["${q('api.name')}"]`));
  assert.ok(architecture.includes(`C_web -->|"${q('conn.label')} #183; ${q('conn.protocol')}"| C_api`)); assert.match(architecture, /C_api -->\|"back"\| C_web/);
  assert.doesNotMatch(architecture, /map\.link|T_i/);
  assert.match(prerequisites, /T_i1 --> T_i2/); assert.match(prerequisites, /T_i3 --> T_i2/); assert.match(prerequisites, /T_i2 --> T_i3/); // a cycle is kept as recorded
  assert.doesNotMatch(prerequisites, /C_web|map\.link/);
  assert.match(markdown, /These are visual relationships only\. They are not architecture dependencies or task prerequisites\.\n\n\| From \| To \| Label \| Link ID \|\n\| --- \| --- \| --- \| --- \|\n\| Vision & Scope \(`vision`\) \| Security \(`security`\) \| «map\.link» \| `ml1` \|/);
  assert.match(markdown, /\| `C_web` \| «web\.name» \(`web`\) \| «layer\.name» \(`L1`\) \| Client \|/);
  // Positions are layout data only, in their own appendix.
  const appendix = markdown.slice(markdown.indexOf('## Appendix B. Layout data'));
  assert.match(appendix, /not implementation requirements/); assert.match(appendix, /\| «web\.name» \(`web`\) \| 11 \| 22 \|/); assert.match(appendix, /900 × 700/);
  assert.doesNotMatch(markdown.slice(0, markdown.indexOf('## Appendix B')), /\| 11 \| 22 \|/);
});

test('hostile text cannot inject Markdown structure, HTML or Mermaid directives', () => {
  const bp = Model.emptyBlueprint();
  const hostile = '"]\n  click C_x call alert(1)\n%%{init: {"theme":"dark"}}%%\n<script>alert(1)</script>';
  bp.components.push({ id: 'a-b_c', name: hostile, purpose: '```\nend of fence\n````\n# Heading\n<img src=x onerror=alert(1)>' }, { id: 'ab', name: 'Plain 雪 ✓', purpose: '' });
  bp.connections.push({ id: 'c1', from: 'a-b_c', to: 'ab', label: '|"x"|; style C_ab fill:#f00', protocol: '' });
  bp.sources.push({ id: 's1', title: '<b>t</b>', url: 'https://example.com/a(b) c', claim: 'password: hunter2 and token=abc123' });
  bp.vision.summary = 'x'.repeat(20000);
  const { markdown, redactions } = exportProjectContext(record(bp));
  const mermaid = markdown.match(/```mermaid\n([\s\S]*?)\n```/)[1];
  for (const line of mermaid.split('\n').slice(1)) assert.match(line, /^ {2}(?:C_[A-Za-z0-9_]+\["[^"\n\]]*"\]|C_[A-Za-z0-9_]+ -->(?:\|"[^"|\n]*"\|)? C_[A-Za-z0-9_]+)$/, line);
  assert.match(mermaid, /C_a_hb__c\["/); assert.match(mermaid, /Plain 雪 #10003;/);
  assert.doesNotMatch(mermaid, /<script|%%\{|^\s*(?:click|style|classDef)\b/m);
  // Text that would change the document's structure is kept exactly inside a longer fence.
  assert.ok(markdown.includes('`````text\n```\nend of fence\n````\n# Heading\n<img src=x onerror=alert(1)>\n`````'));
  assert.ok(markdown.includes('x'.repeat(20000)));
  assert.match(markdown, /\\<b\\>t\\<\/b\\>/); assert.ok(markdown.includes('[https://example.com/a(b) c](https://example.com/a%28b%29%20c)'));
  assert.doesNotMatch(markdown, /hunter2|abc123/); assert.equal(redactions.length, 1); assert.match(markdown, /1 field contained text that looked like a secret/);
});

test('output is deterministic; only content changes the source hash, not time, revision or layout', () => {
  const base = record(full()), first = exportProjectContext(base, { generatedAt: 1 }), second = exportProjectContext({ ...base, revision: 9 }, { generatedAt: 2 });
  assert.equal(first.sourceHash, second.sourceHash);
  assert.equal(body(first.markdown).replace(/blueprint revision 3/, ''), body(second.markdown).replace(/blueprint revision 9/, ''));
  const moved = structuredClone(base); moved.blueprint.components[0].x = 999; moved.blueprint.layout.map.nodes.center.x = 50;
  assert.equal(exportProjectContext(moved).sourceHash, first.sourceHash);
  const edited = structuredClone(base); edited.blueprint.requirements[0].title = 'Changed';
  assert.notEqual(exportProjectContext(edited).sourceHash, first.sourceHash);
  // Stored values the format does not know are reported, never dropped.
  const extra = structuredClone(base); extra.blueprint.requirements[0].futureField = { a: 1 }; extra.blueprint.newCollection = [1];
  const reported = exportProjectContext(extra);
  assert.deepEqual(reported.unsupported, ['requirements.r1.futureField', 'newCollection']);
  assert.match(reported.markdown, /2 stored values are not supported by this export format/); assert.match(reported.markdown, /"requirements\.r1\.futureField": \{\n\s+"a": 1/);
});

test('a document above the size limit fails visibly instead of being cut', () => {
  const bp = Model.emptyBlueprint();
  for (let index = 0; index < 220; index++) bp.items.push({ id: `i${index}`, title: `Task ${index}`, description: 'd'.repeat(20000), acceptanceCriteria: 'c'.repeat(20000) });
  const started = Date.now();
  assert.throws(() => exportProjectContext(record(bp)), error => error.code === 'CONTEXT_TOO_LARGE' && error.status === 413);
  assert.ok(Date.now() - started < 5000, 'bounded processing');
  assert.equal(DOCUMENT_BYTES, 8 * 1024 * 1024);
});

test('the store keeps the baseline, edits, candidates and older versions separately and atomically', async t => {
  const dir = await temp(t), store = new ContextStore(dir), source = record(full());
  const created = await store.create('proj1', source);
  assert.equal(created.meta.revision, 1); assert.equal(created.version.sourceRevision, 3); assert.equal(created.existing, false);
  const folder = join(dir, 'origin', 'context', 'proj1');
  assert.deepEqual((await readdir(folder)).sort(), ['document.json', `${created.version.textHash}.md`].sort());
  assert.equal(await readFile(join(folder, `${created.version.textHash}.md`), 'utf8'), created.text);
  assert.equal((await store.create('proj1', source)).existing, true, 'one active document per project');
  // Edits keep the baseline; a stale revision is refused; saving identical text changes nothing.
  const edited = `${created.text}\nMy note.\n`;
  const saved = await store.saveText('proj1', { expectedRevision: 1, text: edited });
  assert.equal(saved.meta.revision, 2); assert.notEqual(saved.version.textHash, saved.version.baselineHash); assert.ok(saved.version.editedAt);
  await assert.rejects(store.saveText('proj1', { expectedRevision: 1, text: 'stale' }), { code: 'CONTEXT_REVISION_CONFLICT', status: 409 });
  assert.equal((await store.saveText('proj1', { expectedRevision: 2, text: edited })).meta.revision, 2);
  assert.equal((await readdir(folder)).filter(name => name.endsWith('.md')).length, 2);
  // Regeneration makes a candidate from Origin; the edited version is untouched until the person chooses.
  const changed = record(full(), { revision: 8 }); changed.blueprint.idea = 'New idea';
  const regenerated = await store.regenerate('proj1', changed, { expectedRevision: 2 });
  assert.match(regenerated.text, /New idea/); assert.doesNotMatch(regenerated.text, /My note\./);
  assert.equal((await store.read('proj1')).text, edited);
  await store.resolve('proj1', { expectedRevision: 3, use: false });
  assert.equal((await store.read('proj1')).meta.versions.length, 1);
  const again = await store.regenerate('proj1', changed, { expectedRevision: 4 });
  const used = await store.resolve('proj1', { expectedRevision: 5, use: true });
  assert.equal(used.activeVersionId, again.candidate.id); assert.equal(used.versions.length, 2);
  const old = await store.read('proj1', created.version.id);
  assert.equal(old.text, edited, 'the previous edited version is kept');
  await assert.rejects(store.resolve('proj1', { expectedRevision: 6, use: true }), { code: 'NO_CANDIDATE' });
  // A damaged metadata file falls back to the previous good copy (revision 5: the edited version was
  // still active and the candidate pending); leftover temporary files are ignored.
  await writeFile(join(folder, 'document.json.tmp-1-abcd'), '{');
  await writeFile(join(folder, 'document.json'), '{broken');
  const recovered = await new ContextStore(dir).read('proj1');
  assert.equal(recovered.meta.revision, 5); assert.equal(recovered.text, edited); assert.equal(recovered.meta.candidateVersionId, again.candidate.id);
  await assert.rejects(store.saveText('proj1', { expectedRevision: 5, text: 'x'.repeat(DOCUMENT_BYTES + 1) }), { code: 'CONTEXT_TOO_LARGE' });
  await assert.rejects(store.saveText('proj1', { expectedRevision: 5, text: 'a\0b' }), { code: 'INVALID_INPUT' });
  // Another project has its own document.
  assert.equal(await store.read('proj2'), null);
  assert.equal(await store.archive('proj1'), true); assert.equal(await store.read('proj1'), null);
  assert.equal((await readdir(join(dir, 'origin', 'deleted'))).filter(name => name.startsWith('context-proj1.deleted-')).length, 1);
});

async function api(app, path, { method = 'GET', body: payload, token } = {}) {
  const response = await fetch(`${app.url}${path}`, { method, headers: { ...(token ? { 'X-STE-Token': token } : {}), ...(payload ? { 'Content-Type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
  return { status: response.status, data: await response.json() };
}

test('HTTP: create from the saved revision only, edit without touching Origin, and see Origin changes', async t => {
  const app = await startTestServer(t, { port: 0, executor: null });
  const { token } = (await api(app, '/api/session')).data, call = (path, options = {}) => api(app, path, { token, ...options });
  const { project } = (await call('/api/origin/projects', { method: 'POST', body: { name: 'Context app' } })).data;
  const path = `/api/origin/projects/${project.id}`;
  let saved = (await call(path, { method: 'PUT', body: { expectedRevision: project.revision, blueprint: full() } })).data;
  assert.equal((await call(`${path}/document`)).data.document, null);
  // A stale blueprint revision creates nothing.
  assert.equal((await call(`${path}/document`, { method: 'POST', body: { expectedRevision: saved.revision - 1 } })).data.code, 'ORIGIN_REVISION_CONFLICT');
  assert.equal((await call(`${path}/document`)).data.document, null);
  const created = (await call(`${path}/document`, { method: 'POST', body: { expectedRevision: saved.revision } })).data;
  assert.equal(created.document.revision, 1); assert.equal(created.originChanged, false); assert.match(created.text, /«web\.name»/);
  const blueprintPath = join(app.board.store.dir, 'origin', blueprintFileName(project.id)), before = await readFile(blueprintPath, 'utf8');
  const edited = (await call(`${path}/document`, { method: 'PUT', body: { expectedRevision: 1, text: `${created.text}\n## Mine\n` } })).data;
  assert.equal(edited.document.revision, 2); assert.equal(edited.document.versions[0].edited, true);
  assert.equal(await readFile(blueprintPath, 'utf8'), before, 'editing the document leaves the blueprint file unchanged');
  assert.equal((await call(`${path}/document`, { method: 'PUT', body: { expectedRevision: 1, text: 'stale' } })).status, 409);
  // Layout moves do not count as an Origin change; content does, and the document stays as it was.
  const moved = structuredClone(saved.blueprint); moved.components[0].x = 500;
  saved = (await call(path, { method: 'PUT', body: { expectedRevision: saved.revision, blueprint: moved } })).data;
  assert.equal((await call(`${path}/document`)).data.originChanged, false);
  const content = structuredClone(saved.blueprint); content.idea = 'A different idea';
  saved = (await call(path, { method: 'PUT', body: { expectedRevision: saved.revision, blueprint: content } })).data;
  const status = (await call(`${path}/document`)).data;
  assert.equal(status.originChanged, true); assert.match(status.text, /## Mine/); assert.doesNotMatch(status.text, /A different idea/);
  // Regenerate → compare → use; the edited version stays readable.
  const candidate = (await call(`${path}/document/regenerate`, { method: 'POST', body: { expectedRevision: 2, expectedSourceRevision: saved.revision } })).data;
  assert.match(candidate.candidate.text, /A different idea/); assert.match(candidate.text, /## Mine/);
  const used = (await call(`${path}/document/candidate`, { method: 'POST', body: { expectedRevision: 3, use: true } })).data;
  assert.equal(used.originChanged, false); assert.match(used.text, /A different idea/);
  const first = used.document.versions.find(version => !version.active);
  assert.match((await call(`${path}/document/versions/${first.id}`)).data.text, /## Mine/);
  // Deleting the Origin project keeps the document files aside.
  await call(`${path}/delete`, { method: 'POST', body: { expectedRevision: saved.revision } });
  assert.ok((await readdir(join(app.board.store.dir, 'origin', 'deleted'))).some(name => name.startsWith('context-')));
});

test('Base pages join back to the exact file and follow section anchors outside code fences', () => {
  const { markdown } = exportProjectContext(record(full()));
  const pages = contextPages(markdown);
  assert.equal(pages.map(page => page.markdown).join(''), markdown);
  assert.deepEqual(pages.slice(0, 3).map(page => [page.id, page.title]), [['header', 'Project Context: Notes'], ['s-overview', 'Overview'], ['s-vision', 'Vision & Scope']]);
  assert.match(pages[1].markdown, /^<a id="ctx-phase-define"><\/a>\n## 1\. «phase-label»/, 'a phase heading travels with its first section');
  assert.ok(pages.some(page => page.id === 'report') && pages.at(-1).id === 'layout');
  const edited = 'Intro\n```\n<a id="ctx-section-fake"></a>\n```\n' + 'x'.repeat(10) + '\n' + ('y'.repeat(1000) + '\n').repeat(600);
  const parts = contextPages(edited);
  assert.equal(parts.map(page => page.markdown).join(''), edited); assert.ok(parts.length >= 3, 'large text is cut at line ends');
  assert.ok(parts.every(page => Buffer.byteLength(page.markdown) <= PAGE_BYTES)); assert.equal(parts.some(page => page.id.includes('fake')), false);
  assert.deepEqual(contextPages('# only text'), [{ id: 'header', title: 'only text', markdown: '# only text' }]);
});

async function linkedApp(t) {
  const app = await startTestServer(t, { port: 0, executor: null });
  const { token } = (await api(app, '/api/session')).data, call = (path, options = {}) => api(app, path, { token, ...options });
  const kanban = await app.board.createProject({ name: 'Board', workflowMode: 'pipeline' });
  const card = await app.board.createTask({ projectId: kanban.id, title: 'Build sign-in' }), other = await app.board.createTask({ projectId: kanban.id, title: 'Unrelated' });
  let { project } = (await call('/api/origin/projects', { method: 'POST', body: { name: 'Context app' } })).data;
  project = (await call(`/api/origin/projects/${project.id}/link`, { method: 'POST', body: { expectedRevision: project.revision, kanbanProjectId: kanban.id } })).data.project;
  const path = `/api/origin/projects/${project.id}`;
  const saved = (await call(path, { method: 'PUT', body: { expectedRevision: project.revision, blueprint: full() } })).data;
  const created = (await call(`${path}/document`, { method: 'POST', body: { expectedRevision: saved.revision } })).data;
  return { app, call, path, kanban, card, other, project, saved, created };
}

test('Save in Base keeps one complete Base-owned copy, assigns nothing and never duplicates a revision', async t => {
  const { app, call, path, saved, created } = await linkedApp(t);
  const first = (await call(`${path}/document/base`, { method: 'POST', body: { expectedRevision: 1 } })).data;
  assert.equal(first.existing, false); assert.equal(first.documentRevision, 1);
  const detail = await app.board.base.detail(first.resource.id);
  assert.equal(detail.kind, 'knowledge'); assert.equal(detail.content.pages.map(page => page.markdown).join(''), created.text);
  assert.deepEqual(detail.content.pages[0].provenance, { kind: 'origin-context', sourceIds: [created.document.originId, created.document.id], revision: 1, contentHash: created.document.versions[0].hash, generatedAt: created.document.versions[0].generatedAt, section: 'Project Context: Context app' });
  assert.deepEqual(detail.usedBy, [], 'saving assigns the copy to nothing');
  assert.deepEqual((await call(`${path}/document/base`, { method: 'POST', body: { expectedRevision: 1 } })).data, { ...first, existing: true });
  assert.equal((await app.board.state()).base.resources.length, 1);
  // A changed document asks before updating or adding a copy; a copy edited in Base is never replaced silently.
  await call(`${path}/document`, { method: 'PUT', body: { expectedRevision: 1, text: `${created.text}\nMore.\n` } });
  const asked = await call(`${path}/document/base`, { method: 'POST', body: { expectedRevision: 2 } });
  assert.equal(asked.status, 409); assert.equal(asked.data.code, 'BASE_COPY_EXISTS'); assert.deepEqual(asked.data.copies.map(copy => [copy.id, copy.documentRevision, copy.edited]), [[first.resource.id, 1, false]]);
  assert.equal((await call(`${path}/document/base`, { method: 'POST', body: { expectedRevision: 1 } })).data.code, 'CONTEXT_REVISION_CONFLICT');
  const current = await app.board.base.detail(first.resource.id);
  await app.board.base.update(first.resource.id, { content: { ...current.content, pages: current.content.pages.map((page, index) => index ? page : { ...page, markdown: `${page.markdown}Edited in Base.\n` }) } }, { expectedRevision: current.revision });
  assert.equal((await call(`${path}/document/base`, { method: 'POST', body: { expectedRevision: 2, mode: 'update', resourceId: first.resource.id } })).data.code, 'BASE_COPY_EDITED');
  const updated = (await call(`${path}/document/base`, { method: 'POST', body: { expectedRevision: 2, mode: 'update', resourceId: first.resource.id, replaceEdited: true } })).data;
  assert.equal(updated.resource.id, first.resource.id); assert.equal(updated.resource.revision, 3);
  const copy = (await call(`${path}/document/base`, { method: 'POST', body: { expectedRevision: 2, mode: 'copy' } })).data;
  assert.equal(copy.existing, true, 'the updated copy already holds this revision');
  // The Base copy stays usable after the Origin project is deleted and travels with Base content in backups.
  await call(`${path}/delete`, { method: 'POST', body: { expectedRevision: saved.revision } });
  assert.match((await app.board.base.detail(first.resource.id)).content.pages.map(page => page.markdown).join(''), /More\.\n$/);
  const backup = await app.board.exportBackup({ includeBaseContent: true });
  const exported = backup.base.resources.find(resource => resource.name === 'Project Context: Context app');
  assert.ok(exported.content.pages.length > 3); assert.equal(JSON.stringify(backup).includes('"blueprint"'), false, 'Origin data is not part of the board backup');
});

test('Use in Kanban supplies chosen sections only to the chosen scope, complete or not at all', async t => {
  const { app, call, path, kanban, card, other, created } = await linkedApp(t);
  const pages = contextPages(created.text), ids = pages.filter(page => ['s-requirements', 's-architecture'].includes(page.id)).map(page => page.id);
  const request = extra => ({ method: 'POST', body: { expectedRevision: 1, pageIds: ids, target: { scope: 'task', taskId: card.id }, ...extra } });
  const preview = (await call(`${path}/document/kanban`, request({ preview: true }))).data;
  assert.equal(preview.plan.copy.status, 'new'); assert.equal(preview.plan.selection.status, 'new'); assert.equal(preview.plan.full, false);
  assert.deepEqual(preview.plan.sections.map(section => section.id), ids); assert.equal(preview.alreadyAssigned, false);
  assert.equal((await app.board.state()).base.resources.length, 0, 'a preview changes nothing');
  const used = (await call(`${path}/document/kanban`, request())).data;
  assert.equal(used.assigned, true);
  let state = await app.board.state();
  const task = state.projects.find(project => project.id === kanban.id).tasks.find(entry => entry.id === card.id);
  assert.deepEqual(task.baseBinding, { mode: 'extend', include: [{ resourceId: used.resource.id, required: true }], exclude: [] });
  assert.equal(state.projects.find(project => project.id === kanban.id).tasks.find(entry => entry.id === other.id).baseBinding, undefined, 'other cards are unchanged');
  assert.equal(state.projects.find(project => project.id === kanban.id).baseBinding, undefined, 'the project assignment is unchanged');
  assert.equal(task.prompt, card.prompt);
  // Repeating it creates no duplicates.
  assert.equal((await call(`${path}/document/kanban`, request())).data.assigned, false);
  state = await app.board.state(); assert.equal(state.base.resources.length, 2);
  // The run receives exactly the chosen sections, in full, with the Base copy as a pinned dependency.
  const { manifest } = await app.board.previewBase({ target: { scope: 'task', projectId: kanban.id, taskId: card.id } });
  assert.deepEqual(manifest.resources.map(entry => [entry.resourceId, entry.delivery, entry.status]).sort(), [[used.copy.id, 'dependency-definition', 'ready'], [used.resource.id, 'context', 'ready']].sort());
  const runDir = await temp(t), readRevision = ref => app.board.base.readRevision(ref);
  const prepared = await prepareBase({ manifest, currentResources: state.base.resources, readRevision, runDir });
  const supplied = await readFile(join(runDir, 'base-context', `${used.resource.id}.txt`), 'utf8');
  for (const id of ids) for (const line of pages.find(page => page.id === id).markdown.split('\n').filter(line => line.length > 20)) assert.ok(supplied.includes(line), line);
  assert.equal(supplied.includes('«idea»'), false, 'unselected sections are not supplied');
  assert.ok(prepared.manifest.supplied.some(entry => entry.resourceId === used.resource.id && entry.captures.every(capture => capture.resourceId === used.copy.id)));
  await assert.rejects(prepareBase({ manifest, currentResources: state.base.resources, readRevision, runDir: await temp(t), contextBudget: 2000 }), { code: 'BASE_CONTEXT_BUDGET' });
  // Too much for one run is refused before anything changes; another column scope extends its own assignment only.
  const columnId = kanban.pipeline.columns.find(entry => entry.role === 'active').id;
  await call(`${path}/document`, { method: 'PUT', body: { expectedRevision: 1, text: `${created.text}${'Long appendix line.\n'.repeat(3000)}` } });
  const before = structuredClone((await app.board.state()).base);
  const tooLarge = await call(`${path}/document/kanban`, { method: 'POST', body: { expectedRevision: 2, pageIds: ['layout'], target: { scope: 'column', columnId } } });
  assert.equal(tooLarge.status, 409); assert.equal(tooLarge.data.code, 'CONTEXT_SELECTION_TOO_LARGE'); assert.ok(tooLarge.data.chars > 48000);
  assert.deepEqual((await app.board.state()).base, before, 'nothing changed');
  const column = (await call(`${path}/document/kanban`, { method: 'POST', body: { expectedRevision: 2, pageIds: [ids[0]], target: { scope: 'column', columnId } } })).data;
  assert.equal(column.assigned, true); assert.notEqual(column.copy.id, used.copy.id, 'an edited revision gets its own Base copy, stated in the preview');
  assert.equal((await call(`${path}/document/kanban`, { method: 'POST', body: { expectedRevision: 2, pageIds: ids, target: { scope: 'task', taskId: 'missing' } } })).status, 404);
});

test('Compose names the Markdown section of each excerpt and keeps whole-file character offsets', () => {
  const text = '# Project Context: A\n\nIntro.\n\n```\n# not a heading\n```\n\n## Requirements\n\nREQ text.\n\n### Sign in\n\nDetails here.\n';
  const sections = markdownSections(text);
  assert.deepEqual(sections.map(page => page.section), ['Project Context: A', 'Requirements', 'Sign in']);
  assert.equal(sections.map(page => page.text).join(''), text);
  const chunk = buildIndex(chunkPages(sections)).rows.find(row => row.text.includes('Details here.'));
  assert.equal(chunk.section, 'Sign in'); assert.equal(text.slice(chunk.start, chunk.end).trim(), chunk.text);
  assert.deepEqual(markdownSections('plain text'), [{ page: 1, text: 'plain text', offset: 0, section: '' }]);
});
