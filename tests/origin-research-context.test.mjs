import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/origin-model.js';
import { researchContext as serverContext } from '../src/origin-research.mjs';

const M = globalThis.PromptboardOriginModel;
const base = { origin: 'human' };

/** A project with renamed parts, its own section and questions, component questions and a section marked not needed. */
function blueprint() {
  const bp = M.emptyBlueprint();
  bp.idea = 'A marketplace for handmade goods';
  Object.assign(bp.vision, { goal: 'Sell 1,000 items a month', inScope: 'Web shop\nPayments', outOfScope: 'Mobile apps', constraints: 'Must run on one small VM\nEU data only' });
  bp.labels.phases.design = 'Shape';
  bp.labels.sections.technology = 'Stack';
  bp.questionText['vision:goal'] = 'What does success look like?';
  bp.questionText['topic:security:secrets'] = 'Where do keys live?';
  bp.sections.observability = { notApplicable: true };
  bp.customSections.push({ id: 'pricing', phase: 'decide', title: 'Pricing model', description: 'How sellers pay us', notApplicable: false });
  bp.questions.push({ id: 'q_fee', scope: 'section', sectionId: 'pricing', text: 'Which fee model?' }, { id: 'q_scale', scope: 'component', sectionId: '', text: 'How does it scale?' });
  bp.answers.q_fee = 'A 5% commission per sale';
  bp.technologies.push({ ...base, id: 't_pg', name: 'PostgreSQL', category: 'database', purpose: 'Orders', version: '17', status: 'selected', reason: 'Relational orders', alternatives: '', sourceIds: [] },
    { ...base, id: 't_mongo', name: 'MongoDB', category: 'database', purpose: '', version: '', status: 'candidate', reason: '', alternatives: '', sourceIds: [] });
  bp.components.push({ ...base, id: 'c_api', name: 'Checkout API', type: 'api', purpose: 'Takes payments. token=sk_live_SECRETVALUE123', responsibilities: 'Charge cards', technologyIds: ['t_pg'], interfaces: 'REST', dataHandled: 'Orders', status: 'draft', notes: '', sourceIds: [], x: 0, y: 0, layerId: null, answers: { q_scale: 'Two instances behind a load balancer' } },
    { ...base, id: 'c_web', name: 'Storefront', type: 'client', purpose: 'Shows products', responsibilities: '', technologyIds: [], interfaces: '', dataHandled: '', status: 'draft', notes: '', sourceIds: [], x: 0, y: 0, layerId: null, answers: {} });
  bp.connections.push({ id: 'k1', from: 'c_web', to: 'c_api', label: 'calls', protocol: 'HTTPS', notes: '' });
  bp.requirements.push({ ...base, id: 'r1', key: 'REQ-001', title: 'Card payments', description: 'Accept Visa and Mastercard', type: 'functional', priority: 'must', status: 'draft', acceptanceCriteria: 'A test card is charged', componentIds: ['c_api'], sourceIds: [] });
  bp.decisions.push({ ...base, id: 'd1', key: 'ADR-001', title: 'Use PostgreSQL', context: '', decision: 'PostgreSQL for orders', alternatives: 'MongoDB', reason: 'Transactions', consequences: '', status: 'accepted', date: '', supersededBy: null, componentIds: [], technologyIds: ['t_pg'], requirementIds: [], dependencyIds: [], sourceIds: [] },
    { ...base, id: 'd2', key: 'ADR-002', title: 'Which queue', context: '', decision: '', alternatives: '', reason: '', consequences: '', status: 'proposed', date: '', supersededBy: null, componentIds: [], technologyIds: [], requirementIds: [], dependencyIds: [], sourceIds: [] });
  bp.areas.push({ ...base, id: 'a1', section: 'security', area: 'secrets', title: 'Environment variables in the VM', description: 'Loaded at start', status: 'draft', componentIds: [], requirementIds: [], technologyIds: [], baseResourceIds: [] });
  return M.normalizeBlueprint(bp).blueprint ?? bp;
}

test('research targets follow the project’s own structure: renamed parts, its own section and questions, nothing for sections not needed', () => {
  const targets = M.researchTargets(blueprint());
  const labels = targets.map(target => target.label), keys = targets.map(target => JSON.stringify(target.value));
  assert.equal(labels[0], 'Whole project');
  for (const expected of ['Shape › Stack', 'Decide › Pricing model', 'Operate › Observability (not needed)', 'Checkout API', 'ADR-002 Which queue (open)', 'MongoDB', 'What does success look like?', 'Pricing model: Which fee model?', 'Security: Where do keys live?', 'Checkout API: How does it scale?']) {
    assert.ok(labels.includes(expected), `${expected} in ${labels.join(' | ')}`);
  }
  assert.ok(!labels.some(text => text.startsWith('Observability: ')), 'no topic questions for a section marked not needed');
  for (const key of [{ kind: 'section', id: 'technology' }, { kind: 'record', collection: 'components', id: 'c_api' }, { kind: 'question', key: 'question:q_fee' }, { kind: 'question', key: 'topic:security:secrets' }, { kind: 'question', key: 'component:c_api:q_scale' }]) {
    assert.ok(keys.includes(JSON.stringify(key)), JSON.stringify(key));
  }
});

test('research context: constraints first, the focus in full with stable IDs, the rest in brief, bounded', () => {
  const bp = blueprint(), context = scope => M.researchContext(bp, scope, { projectName: 'Shop' });
  const whole = context({ kind: 'project' });
  assert.equal(whole.label, 'the whole project');
  assert.match(whole.text, /^## Project\nShop\nIdea: A marketplace for handmade goods\nWhat does success look like\? Sell 1,000[\s\S]*## Out of scope\nMobile apps[\s\S]*## Constraints \(keep them\)\nMust run on one small VM\nEU data only/);
  assert.match(whole.text, /\[section pricing\] Pricing model[\s\S]*\[question q_fee\] Which fee model\? → A 5% commission per sale/);
  assert.match(whole.text, /\[section observability\] Observability — marked as not needed/);
  assert.match(whole.text, /## Accepted decisions \(keep them\)\n- ADR-001 Use PostgreSQL: PostgreSQL for orders \[decisions d1\]/);

  const stack = context({ kind: 'section', id: 'technology' });
  assert.equal(stack.label, 'the section “Stack”');
  assert.match(stack.text, /## Focus: this section\n\[section technology\] Stack[\s\S]*\[technologies t_pg\] technology: PostgreSQL\n  category: Database\n  status: Selected\n  version: 17/);

  const security = context({ kind: 'section', id: 'security' });
  assert.match(security.text, /\[topic security:secrets\] Where do keys live\? → Environment variables in the VM — Loaded at start \[areas a1\]/);
  assert.match(security.text, /\[topic security:authentication\] Authentication → \(no answer yet\)/);

  const own = context({ kind: 'section', id: 'pricing' });
  assert.match(own.text, /## Focus: this section\n\[section pricing\] Pricing model\n  description: How sellers pay us\n  \[question q_fee\] Which fee model\? → A 5% commission per sale/);

  const component = context({ kind: 'record', collection: 'components', id: 'c_api' });
  assert.equal(component.label, 'the component “Checkout API”');
  assert.match(component.text, /## Focus: this record\n\[components c_api\] component: Checkout API[\s\S]*technologies: PostgreSQL[\s\S]*\[question q_scale\] How does it scale\? → Two instances/);
  assert.match(component.text, /## Linked records\n\[requirements r1\][\s\S]*\[technologies t_pg\][\s\S]*connection ← Storefront \(calls, HTTPS\)/);

  assert.match(context({ kind: 'question', key: 'vision:goal' }).text, /## Focus: this question\n\[vision goal\] What does success look like\? → Sell 1,000 items a month/);
  assert.match(context({ kind: 'question', key: 'topic:security:secrets' }).text, /\[topic security:secrets\] Where do keys live\? \(section Security\)\n\[areas a1\]/);
  assert.match(context({ kind: 'question', key: 'question:q_fee' }).label, /Which fee model\?/);
  assert.match(context({ kind: 'question', key: 'component:c_api:q_scale' }).text, /\[component c_api\] \[question q_scale\] How does it scale\? → Two instances/);
  assert.equal(context({ kind: 'record', collection: 'components', id: 'gone' }).label, 'the whole project', 'a removed record falls back to the project');

  // Renaming changes the words, never the IDs; the same blueprint always gives the same text.
  const renamed = structuredClone(bp); renamed.labels.sections.technology = 'Tools';
  assert.match(M.researchContext(renamed, { kind: 'section', id: 'technology' }).text, /\[section technology\] Tools/);
  assert.equal(context({ kind: 'project' }).text, whole.text);

  // Small limits keep the project, scope and constraints, and name what was left out.
  const small = M.researchContext(bp, { kind: 'section', id: 'technology' }, { projectName: 'Shop', limit: 1200 });
  assert.ok(small.text.includes('Must run on one small VM') && small.text.includes('[technologies t_pg]'));
  assert.ok(small.omitted.length > 0 && small.text.includes('## Left out for size'));
  assert.ok(M.researchContext(bp, { kind: 'project' }, { limit: 24000 }).size <= 24100);
});

test('the server context removes recognizable secrets and reports a scope that no longer exists', () => {
  const record = { name: 'Shop', blueprint: blueprint() };
  const context = serverContext(record, { kind: 'record', collection: 'components', id: 'c_api' });
  assert.ok(!context.text.includes('sk_live_SECRETVALUE123'), 'secrets are removed');
  assert.equal(context.missing, false);
  assert.equal(serverContext(record, { kind: 'section', id: 'nope' }).missing, true);
  assert.equal(serverContext(record, { kind: 'project' }).missing, false);
});
