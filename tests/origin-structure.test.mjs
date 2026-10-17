// The project's own Origin structure: categories, pages and fields that the person creates, renames, moves, copies
// and removes; blank and template starts; and research that follows the structure.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/origin-model.js';

const M = globalThis.PromptboardOriginModel;
const ids = () => { let n = 0; return () => `n${++n}`; };
const sections = bp => M.phaseList(bp).map(phase => [phase.label, phase.sections]);

test('a blueprint saved before structures existed shows exactly what it showed, without a repair', () => {
  const old = M.emptyBlueprint(); delete old.structure;
  old.customSections.push({ id: 'pricing', origin: 'human', phase: 'decide', title: 'Pricing', description: '', notApplicable: false });
  const { blueprint, repairs } = M.normalizeBlueprint(old);
  assert.equal(repairs, 0);
  assert.deepEqual(sections(blueprint), [['Define', ['vision', 'requirements']], ['Design', ['architecture', 'technology', 'dependencies', 'data', 'ai']],
    ['Operate', ['security', 'testing', 'deployment', 'observability']], ['Decide', ['research', 'decisions', 'pricing']], ['Build', ['plan']]]);
  assert.equal(M.normalizeBlueprint(blueprint).repairs, 0, 'stable once saved');
});

test('a blank project has no categories or pages, nothing to resolve, and research is told there is nowhere to write', () => {
  const blank = M.normalizeBlueprint(M.emptyBlueprint({ blank: true })).blueprint;
  blank.idea = 'A recipe app';
  assert.deepEqual(M.phaseList(blank), []);
  assert.deepEqual(M.sectionStates(blank), { overview: 'defined' });
  assert.deepEqual([M.issues(blank), M.readiness(blank).rows], [[], []]);
  assert.deepEqual(M.researchTargets(blank).map(option => option.value.kind), ['project']);
  const guide = M.researchGuide(blank);
  assert.match(guide, /no pages yet/); assert.doesNotMatch(guide, /New records|topic answer|New block/);
  assert.throws(() => M.validateResearchSuggestion(blank, { target: { kind: 'add', collection: 'technologies' }, value: { name: 'Postgres' } }), /no Technology page/);
  assert.throws(() => M.validateResearchSuggestion(blank, { target: { kind: 'vision', field: 'goal' }, value: 'Cook more' }), /does not exist/);
});

test('categories are added, renamed, moved, copied and removed with their pages', () => {
  const bp = M.emptyBlueprint(), newId = ids();
  const marketing = M.addCategory(bp, { id: 'mkt', title: 'Marketing', index: 0 });
  assert.equal(marketing.ok, true);
  M.addPage(bp, { phase: 'mkt', id: 'launch', title: 'Launch plan' });
  bp.questions.push({ id: 'q1', origin: 'human', scope: 'section', sectionId: 'launch', text: 'Who is it for?' }); bp.answers.q1 = 'Makers';
  M.renameCategory(bp, 'define', 'Start'); M.renameCategory(bp, 'mkt', 'Go to market');
  assert.deepEqual(M.phaseList(bp).slice(0, 2).map(phase => phase.label), ['Go to market', 'Start']);
  M.renameCategory(bp, 'define', '');
  assert.equal(M.phaseList(bp)[1].label, 'Define', 'clearing a built-in name brings its own back');
  M.moveCategory(bp, 'mkt', 99);
  assert.equal(M.phaseList(bp).at(-1).id, 'mkt');
  const copy = M.duplicateCategory(bp, 'mkt', newId);
  assert.deepEqual([copy.copied, M.phaseList(bp).at(-1).label], [1, 'Go to market (copy)']);
  const copiedPage = M.phaseList(bp).at(-1).sections[0], copiedQuestion = bp.questions.find(question => question.sectionId === copiedPage);
  assert.equal(bp.answers[copiedQuestion.id], 'Makers', 'a copied page keeps its questions and answers');
  // Removing a category removes its pages and what is on them.
  M.removeCategory(bp, 'mkt');
  assert.equal(bp.customSections.some(entry => entry.id === 'launch'), false);
  assert.equal(bp.answers.q1, undefined);
  for (const id of ['define', 'design', 'operate', 'decide', 'build']) M.removeCategory(bp, id);
  M.removeCategory(bp, copy.id);
  const after = M.normalizeBlueprint(bp);
  assert.deepEqual([M.phaseList(after.blueprint), after.blueprint.structure.sections], [[], []], 'every default category can go');
  assert.throws(() => M.normalizeBlueprint({ ...bp, structure: { phases: Array.from({ length: 31 }, (_, i) => ({ id: `p${i}`, title: 'x' })), sections: [] } }), /at most 30 categories/);
});

test('pages are added (own or built-in), renamed, moved between categories, copied and removed with their content', () => {
  const bp = M.emptyBlueprint(), newId = ids();
  assert.match(M.addPage(bp, { phase: 'design', kind: 'technology' }).error, /already part/);
  M.addPage(bp, { phase: 'design', id: 'ux', title: 'UX research', index: 0 });
  assert.deepEqual(M.phaseList(bp)[1].sections, ['ux', 'architecture', 'technology', 'dependencies', 'data', 'ai']);
  M.movePage(bp, 'ux', { phase: 'build', index: 0 });
  assert.deepEqual([M.phaseList(bp)[1].sections.includes('ux'), M.phaseList(bp)[4].sections], [false, ['ux', 'plan']]);
  assert.equal(bp.customSections.find(entry => entry.id === 'ux').phase, 'build', 'the page knows its category');
  M.movePage(bp, 'technology', { phase: 'define' });
  assert.deepEqual(M.phaseList(bp)[0].sections, ['vision', 'requirements', 'technology']);
  M.renamePage(bp, 'technology', 'Stack'); M.renamePage(bp, 'ux', 'User research');
  assert.deepEqual([M.sectionTitle(bp, 'technology'), M.sectionTitle(bp, 'ux')], ['Stack', 'User research']);
  // A built-in page goes with its records; links to them are dropped on save, not left dangling.
  bp.technologies.push({ id: 't1', origin: 'human', name: 'Postgres', category: 'database', purpose: '', version: '', status: 'selected', reason: '', alternatives: '', sourceIds: [] });
  bp.components.push({ id: 'c1', origin: 'human', name: 'API', type: 'api', purpose: 'Orders', responsibilities: '', technologyIds: ['t1'], interfaces: '', dataHandled: '', status: 'draft', notes: '', sourceIds: [], x: 0, y: 0, layerId: null, answers: {} });
  assert.deepEqual(M.pageContent(bp, 'technology').records, 1);
  const removed = M.removePage(bp, 'technology');
  assert.deepEqual([removed.removed.records, bp.technologies.length, M.hasPage(bp, 'technology')], [1, 0, false]);
  const saved = M.normalizeBlueprint(bp).blueprint;
  assert.deepEqual(saved.components[0].technologyIds, []);
  assert.equal(saved.labels.sections.technology, undefined);
  // Added back from "Add page": empty, in the category chosen.
  M.addPage(saved, { phase: 'operate', kind: 'technology', index: 1 });
  assert.deepEqual(M.phaseList(saved)[2].sections.slice(0, 3), ['security', 'technology', 'testing']);
  assert.match(M.duplicatePage(saved, 'technology', newId).error, /built-in page exists once/);
  assert.match(M.removePage(saved, 'overview').error, /cannot be removed/);
});

test('fields: topics and vision questions are hidden, restored and ordered; own questions and blocks move, copy and change type', () => {
  const bp = M.emptyBlueprint(), newId = ids();
  bp.areas.push({ id: 'a1', origin: 'human', section: 'security', area: 'secrets', title: 'Vault', description: '', status: 'defined', componentIds: [], requirementIds: [], technologyIds: [], baseResourceIds: [] });
  assert.equal(M.removeTopic(bp, 'security', 'secrets').removed, 1);
  assert.equal(M.topicsOf(bp, 'security').some(([id]) => id === 'secrets'), false);
  assert.equal(bp.areas.length, 0, 'the topic’s answers go with it');
  assert.throws(() => M.validateResearchSuggestion(bp, { target: { kind: 'topic', section: 'security', area: 'secrets' }, value: 'Vault' }), /does not exist/);
  M.restoreTopic(bp, 'security', 'secrets'); M.moveTopic(bp, 'security', 'secrets', -1);
  assert.deepEqual(M.topicsOf(bp, 'security').slice(-2).map(([id]) => id), ['secrets', 'network_exposure']);
  bp.vision.constraints = 'Two weeks';
  M.removeVisionField(bp, 'constraints');
  assert.deepEqual([M.visionFields(bp).includes('constraints'), bp.vision.constraints], [false, '']);
  M.restoreVisionField(bp, 'constraints'); M.moveVisionField(bp, 'constraints', -8);
  assert.match(M.moveVisionField(bp, 'constraints', -1).error, /cannot move/);
  assert.equal(M.visionFields(bp)[0], 'constraints');
  // Own questions and blocks.
  M.addPage(bp, { phase: 'design', id: 'ux', title: 'UX' });
  bp.questions.push({ id: 'q1', origin: 'human', scope: 'section', sectionId: 'ux', text: 'Who tests it?' }, { id: 'q2', origin: 'human', scope: 'section', sectionId: 'ux', text: 'Where?' });
  bp.answers.q1 = 'Five users';
  M.moveQuestion(bp, 'q2', { step: -1 });
  assert.deepEqual(bp.questions.map(question => question.id), ['q2', 'q1']);
  M.moveQuestion(bp, 'q1', { section: 'security' });
  assert.equal(bp.questions.find(question => question.id === 'q1').sectionId, 'security');
  assert.match(M.moveQuestion(bp, 'q1', { section: 'removed-page' }).error, /page of this project/);
  const copy = M.duplicateQuestion(bp, 'q1', newId);
  assert.equal(bp.answers[copy.id], 'Five users');
  const notes = M.questionToNotes(bp, 'q1', newId);
  assert.deepEqual([bp.blocks.find(block => block.id === notes.id).text, bp.answers.q1, bp.questions.some(question => question.id === 'q1')], ['Five users', undefined, false]);
  const back = M.notesToQuestion(bp, notes.id, newId);
  assert.equal(bp.answers[back.id], 'Five users');
  bp.blocks.push({ id: 'b1', origin: 'human', sectionId: 'ux', type: 'checklist', title: 'Checks', checks: [] });
  assert.equal(M.changeBlockType(bp, 'b1', 'table').ok, true);
  assert.equal(bp.blocks.find(block => block.id === 'b1').type, 'table');
  bp.blocks.find(block => block.id === 'b1').columns.push({ id: 'k1', name: 'Name' });
  bp.blocks.find(block => block.id === 'b1').rows.push({ id: 'r1', cells: { k1: 'x' } });
  assert.match(M.changeBlockType(bp, 'b1', 'notes').error, /Only an empty block/);
  M.moveBlockTo(bp, 'b1', 'security');
  const dup = M.duplicateBlock(bp, 'b1', newId);
  assert.deepEqual(bp.blocks.find(block => block.id === dup.id).rows[0].cells, { k1: 'x' });
  assert.equal(M.normalizeBlueprint(bp).repairs, 0);
});

test('research follows the structure: renamed and new pages are offered, removed ones are refused, stale suggestions do not land', () => {
  const bp = M.emptyBlueprint();
  M.addCategory(bp, { id: 'biz', title: 'Business' }); M.addPage(bp, { phase: 'biz', id: 'pricing', title: 'Pricing' });
  bp.questions.push({ id: 'qp', origin: 'human', scope: 'section', sectionId: 'pricing', text: 'What does it cost?' });
  bp.blocks.push({ id: 'tiers', origin: 'human', sectionId: 'pricing', type: 'table', title: 'Tiers', columns: [{ id: 'k1', name: 'Tier' }, { id: 'k2', name: 'Price' }], rows: [] });
  M.renamePage(bp, 'pricing', 'Pricing model');
  const scopes = M.researchTargets(bp).filter(option => option.value.kind === 'section').map(option => option.label);
  assert.ok(scopes.includes('Business › Pricing model'));
  const guide = M.researchGuide(bp, { kind: 'section', id: 'pricing' });
  assert.match(guide, /Pricing model \[section pricing\]/); assert.match(guide, /qp \(What does it cost\?\)/); assert.match(guide, /Tiers/);
  // New fields take research.
  const answer = M.validateResearchSuggestion(bp, { target: { kind: 'answer', questionId: 'qp' }, value: '$9 a month' });
  const row = M.validateResearchSuggestion(bp, { target: { kind: 'blockAdd', block: 'tiers' }, value: { Tier: 'Pro', Price: '$9' } });
  assert.equal(M.applyResearchSuggestion(bp, answer).ok, true);
  assert.equal(M.applyResearchSuggestion(bp, row, { newId: ids() }).ok, true);
  assert.equal(bp.answers.qp, '$9 a month');
  // A suggestion made before a page was removed does not bring the page or its records back.
  const tech = M.validateResearchSuggestion(bp, { target: { kind: 'add', collection: 'technologies' }, value: { name: 'Stripe', category: 'cloud' } });
  const toPricing = M.validateResearchSuggestion(bp, { target: { kind: 'answer', questionId: 'qp' }, value: '$12 a month' });
  M.removePage(bp, 'technology'); M.removePage(bp, 'pricing');
  assert.deepEqual(M.applyResearchSuggestion(bp, tech, { newId: ids() }), { conflict: 'The page for this suggestion was removed from the project.', missing: true });
  assert.equal(M.applyResearchSuggestion(bp, toPricing).missing, true);
  assert.equal(bp.technologies.length, 0);
  assert.doesNotMatch(M.researchGuide(bp), /technologies/i, 'the guide no longer offers a removed page');
  assert.equal(M.researchTargets(bp).some(option => option.value.id === 'pricing'), false);
});

test('a template copies another project’s structure, questions and empty blocks, never its records or answers; the default comes back without losing anything', () => {
  const source = M.emptyBlueprint(), newId = ids();
  M.removePage(source, 'ai'); M.addCategory(source, { id: 'biz', title: 'Business' }); M.addPage(source, { phase: 'biz', id: 'pricing', title: 'Pricing' });
  source.questions.push({ id: 'qp', origin: 'human', scope: 'section', sectionId: 'pricing', text: 'What does it cost?' }); source.answers.qp = '$9';
  source.blocks.push({ id: 'tiers', origin: 'human', sectionId: 'pricing', type: 'table', title: 'Tiers', columns: [{ id: 'k1', name: 'Tier' }], rows: [{ id: 'r1', cells: { k1: 'Pro' } }] });
  source.requirements.push({ id: 'r1', origin: 'human', key: 'REQ-001', title: 'Sign in', description: '', type: 'functional', priority: 'must', status: 'draft', acceptanceCriteria: '', componentIds: [], sourceIds: [] });
  const made = M.structureTemplate(source, newId);
  assert.deepEqual(M.phaseList(made).map(phase => phase.label), ['Define', 'Design', 'Operate', 'Decide', 'Build', 'Business']);
  assert.equal(M.hasPage(made, 'ai'), false);
  const page = M.phaseList(made).at(-1).sections[0];
  assert.notEqual(page, 'pricing', 'its own pages get new IDs');
  assert.deepEqual([made.questions.map(question => question.text), Object.keys(made.answers), made.requirements.length], [['What does it cost?'], [], 0]);
  assert.deepEqual([made.blocks[0].columns.map(column => column.name), made.blocks[0].rows], [['Tier'], []]);
  // Restoring the default adds back what is missing and keeps the project's own categories and pages.
  M.restoreDefaultStructure(made);
  assert.equal(M.hasPage(made, 'ai'), true);
  assert.deepEqual(M.phaseList(made).at(-1).sections, [page]);
});
