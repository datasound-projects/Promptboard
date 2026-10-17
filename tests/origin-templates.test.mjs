// The blueprint library: 20 distinct templates, each applied as the project's own editable copy, understood by
// research, mixable section by section, and saved personal blueprints. No template decides anything for the person.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/origin-model.js';
import '../public/origin-templates.js';
import { startTestServer } from './helpers/test-server.mjs';

const M = globalThis.PromptboardOriginModel, T = globalThis.PromptboardOriginTemplates;
const ids = () => { let n = 0; return () => `n${++n}`; };
const make = (id, newId = ids()) => M.blueprintFromTemplate(T.get(id), { modules: T.MODULES, newId });

test('the library has 20 templates in six categories, each with its own categories, sections, questions and research', () => {
  assert.equal(T.TEMPLATES.length, 20);
  assert.deepEqual([...new Set(T.TEMPLATES.map(template => template.category))].sort(), T.CATEGORIES.map(([id]) => id).sort());
  const layouts = new Set();
  for (const template of T.TEMPLATES) {
    const own = T.templateSections(template).filter(entry => entry.own && !T.MODULES[entry.module]);
    assert.ok(own.length >= 3, `${template.id} has sections of its own`);
    assert.ok(own.reduce((sum, entry) => sum + entry.section.questions.length, 0) >= 8, `${template.id} asks specialised questions`);
    assert.ok(template.research.length >= 3 && template.summary && template.description, `${template.id} has research topics and descriptions`);
    const layout = template.categories.map(category => category.title).join('|');
    assert.ok(!layouts.has(layout), `${template.id} has a category layout of its own`); layouts.add(layout);
    // Guidance, not decisions: no template names a vendor product as its choice.
    assert.doesNotMatch(JSON.stringify(template.categories), /\b(?:React|Angular|Vue|Postgres(?:QL)?|MySQL|MongoDB|Kafka|AWS|Azure|GCP|Electron|Tauri|Flutter|Terraform)\b/, `${template.id} prescribes no technology`);
  }
});

test('every template becomes a project of its own: valid, complete, editable, and isolated from other projects', () => {
  for (const template of T.TEMPLATES) {
    const first = make(template.id), second = make(template.id, (() => { let n = 0; return () => `m${++n}`; })());
    assert.equal(M.normalizeBlueprint(first).repairs, 0, template.id);
    assert.deepEqual(M.phaseList(first).map(phase => phase.label), template.categories.map(category => category.title), template.id);
    for (const entry of T.templateSections(template)) {
      if (entry.own) assert.ok(first.customSections.some(section => section.title === entry.title), `${template.id}: ${entry.title}`);
      else assert.ok(M.hasPage(first, entry.key), `${template.id}: ${entry.key}`);
    }
    assert.deepEqual([first.template.id, first.template.version, first.template.research.length], [template.id, template.version, template.research.length]);
    // A fresh project has nothing written yet: its own sections start "not started", with the template's explanation as guiding text.
    const states = M.sectionStates(first);
    assert.ok(first.customSections.every(section => states[section.id] === 'empty' && !section.description && first.questionText[`section:${section.id}`]), `${template.id} sections start empty`);
    assert.match(M.researchGuide(first), new RegExp(`Typical research for a ${template.name.replace(/[/()]/g, '.')}`));
    assert.match(M.researchContext(first, { kind: 'project' }, { projectName: 'X' }).text, new RegExp(`Project type: ${template.name.replace(/[/()]/g, '.')}`));
    // Two projects from one template share no section, question or block IDs of their own.
    const own = blueprint => [...blueprint.customSections, ...blueprint.questions, ...blueprint.blocks].map(entry => entry.id);
    assert.equal(own(first).filter(id => own(second).includes(id)).length, 0, template.id);
    // Fully editable: the first category goes, a section of the project's own is added, a section moves.
    const [firstPhase, secondPhase] = M.phaseList(first);
    M.removeCategory(first, firstPhase.id);
    const edited = M.normalizeBlueprint(first).blueprint, newId = ids();
    assert.equal(M.addPage(edited, { phase: secondPhase.id, id: newId(), title: 'Our own' }).ok, true);
    assert.equal(M.movePage(edited, M.phaseList(edited)[0].sections[0], { phase: M.phaseList(edited).at(-1).id }).ok, true);
    assert.equal(M.normalizeBlueprint(edited).repairs, 0, `${template.id} after edits`);
    assert.equal(M.phaseList(edited).some(phase => phase.label === firstPhase.label), false, 'a deleted category stays deleted');
  }
});

test('sections of a template can be added to another project; nothing already there is replaced', () => {
  const web = make('frontend-web'), newId = (() => { let n = 0; return () => `k${++n}`; })(), phase = M.phaseList(web).at(-1).id;
  web.questions.find(question => question.sectionId === 'testing') && (web.answers[web.questions.find(question => question.sectionId === 'testing').id] = 'Playwright on three browsers');
  const before = JSON.stringify(web.answers);
  const result = M.addTemplateSections(web, T.get('rag'), ['rag-eval', 'guardrails', 'testing', 'quality'], phase, { modules: T.MODULES, newId });
  assert.deepEqual([result.added.length, result.skipped.sort()], [2, ['quality', 'testing']], 'built-in Testing and the shared Quality Attributes section were already there');
  assert.equal(JSON.stringify(web.answers), before);
  assert.ok(web.customSections.some(section => section.title === 'Evaluation') && web.customSections.some(section => section.title === 'Guardrails & Safety'));
  assert.equal(M.addTemplateSections(web, T.get('rag'), ['rag-eval'], phase, { modules: T.MODULES, newId }).added.length, 0, 'adding the same section twice is prevented');
  assert.equal(M.normalizeBlueprint(web).repairs, 0);
  // A blank project can be built entirely from template sections.
  const blank = M.normalizeBlueprint(M.emptyBlueprint({ blank: true })).blueprint;
  M.addCategory(blank, { id: 'mine', title: 'Mine' });
  assert.equal(M.addTemplateSections(blank, T.get('mlops'), ['training', 'requirements'], 'mine', { modules: T.MODULES, newId }).added.length, 2);
  assert.deepEqual(M.phaseList(blank)[0].sections.length, 2);
});

test('creating from a template, saving a structure as a personal blueprint and starting from it', async t => {
  const app = await startTestServer(t, { port: 0, executor: null });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = (path, method = 'GET', body) => fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async response => ({ status: response.status, json: await response.json() }));
  const mlops = (await call('/api/origin/projects', 'POST', { name: 'Churn model', description: 'Predict churn', start: { template: 'mlops' }, preferences: 'Python, our existing warehouse' })).json;
  assert.deepEqual(M.phaseList(mlops.blueprint).map(phase => phase.label), T.get('mlops').categories.map(category => category.title));
  assert.equal(mlops.blueprint.vision.constraints, 'Technology preferences: Python, our existing warehouse');
  assert.equal(mlops.blueprint.template.id, 'mlops');
  assert.equal((await call('/api/origin/projects', 'POST', { name: 'Nope', start: { template: 'unknown' } })).status, 404);
  // The person answers a question, then saves the structure: the answer is not part of the blueprint.
  const blueprint = M.normalizeBlueprint(mlops.blueprint).blueprint, question = blueprint.questions[0];
  blueprint.answers[question.id] = 'Our secret plan';
  await call(`/api/origin/projects/${mlops.project.id}`, 'PUT', { expectedRevision: mlops.project.revision, blueprint });
  const saved = (await call(`/api/origin/projects/${mlops.project.id}/save-blueprint`, 'POST', { name: 'Our ML blueprint', description: 'For model projects' })).json.blueprint;
  assert.equal(saved.categories.length, T.get('mlops').categories.length);
  assert.equal((await call(`/api/origin/projects/${mlops.project.id}/save-blueprint`, 'POST', { name: 'our ml blueprint' })).status, 409, 'names are unique');
  assert.deepEqual((await call('/api/origin/blueprints')).json.blueprints.map(entry => entry.name), ['Our ML blueprint']);
  const reused = (await call('/api/origin/projects', 'POST', { name: 'Fraud model', start: { saved: saved.id } })).json.blueprint;
  assert.deepEqual([M.phaseList(reused).length, Object.keys(reused.answers).length, reused.template.id], [T.get('mlops').categories.length, 0, 'mlops']);
  assert.equal(JSON.stringify(reused).includes('Our secret plan'), false);
  assert.deepEqual((await call(`/api/origin/blueprints/${saved.id}`, 'DELETE')).json, { deleted: saved.id });
  assert.equal((await call('/api/origin/projects', 'POST', { name: 'Gone', start: { saved: saved.id } })).status, 404);
});
