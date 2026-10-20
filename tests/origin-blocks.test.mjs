import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/origin-model.js';
import { chatState, extractSuggestions, proposalsFor } from '../src/origin-research.mjs';
import { chatPrompt } from '../src/research-prompts.mjs';
import { exportProjectContext } from '../src/origin-context.mjs';

const M = globalThis.PromptboardOriginModel;
const F = '```';
let next = 0;
const newId = () => `n${++next}`;

/** A project with a renamed Data topic, an own section and one block of each type. */
function blueprint() {
  const bp = M.emptyBlueprint();
  bp.idea = 'Enterprise RAG platform';
  bp.questionText['topic:data:schemas'] = 'Document schemas';
  bp.customSections.push({ id: 'eval', origin: 'human', phase: 'design', title: 'Evaluation', description: '', notApplicable: false });
  bp.blocks.push(
    { id: 'tbl', origin: 'human', sectionId: 'data', type: 'table', title: 'Collections', columns: [{ id: 'name', name: 'Name' }, { id: 'dim', name: 'Dimension' }], rows: [{ id: 'r1', cells: { name: 'documents' } }] },
    { id: 'flow', origin: 'human', sectionId: 'data', type: 'flow', title: 'Ingestion', nodes: [{ id: 'up', label: 'Upload', notes: '', x: null, y: null }, { id: 'chunk', label: 'Chunk', notes: '', x: null, y: null }], edges: [{ id: 'e1', from: 'up', to: 'chunk', label: '' }] },
    { id: 'qa', origin: 'human', sectionId: 'eval', type: 'qa', title: 'Open questions', entries: [{ id: 'q1', question: 'Which dataset?', answer: '' }] },
    { id: 'todo', origin: 'human', sectionId: 'eval', type: 'checklist', title: 'Checks', checks: [{ id: 'k1', text: 'Licence checked', done: false }] },
    { id: 'note', origin: 'human', sectionId: 'eval', type: 'notes', title: 'Notes', text: 'Start small.' });
  return M.normalizeBlueprint(bp).blueprint;
}

test('blocks are stored in one fixed shape per type; broken parts are dropped, valid ones round-trip unchanged', () => {
  const bp = blueprint();
  assert.equal(M.normalizeBlueprint(structuredClone(bp)).repairs, 0, 'a saved blueprint with blocks loads without repairs');
  const raw = structuredClone(bp);
  raw.blocks.push({ id: 'gone', sectionId: 'missing', type: 'notes', text: 'x' }, { id: 'odd', sectionId: 'data', type: 'spreadsheet', text: 'kept as notes' });
  raw.blocks[0].rows.push({ id: 'r2', cells: { name: 'chunks', ghost: 'dropped' } });
  raw.blocks[1].edges.push({ id: 'e2', from: 'up', to: 'nowhere' }, { id: 'e3', from: 'up', to: 'up' });
  raw.blocks[1].nodes.push({ id: 'up', label: 'duplicate id' });
  const { blueprint: clean, repairs } = M.normalizeBlueprint(raw);
  assert.ok(repairs >= 5);
  assert.deepEqual(clean.blocks.map(block => block.id), ['tbl', 'flow', 'qa', 'todo', 'note', 'odd'], 'a block in a removed section is dropped');
  assert.equal(clean.blocks.at(-1).type, 'notes');
  assert.deepEqual(clean.blocks[0].rows[1].cells, { name: 'chunks' });
  assert.deepEqual(clean.blocks[1].edges.map(edge => edge.id), ['e1']);
  assert.equal(clean.blocks[1].nodes.length, 2);
  assert.throws(() => M.normalizeBlueprint({ ...raw, blocks: Array.from({ length: 301 }, (_, i) => ({ id: `b${i}`, sectionId: 'data', type: 'notes' })) }), /at most 300 blocks/);
  // Filled blocks count as content of their section; an own section is defined once every block is filled in.
  const states = M.sectionStates(clean);
  assert.equal(states.eval, 'progress', 'an unanswered Q&A keeps the section in progress');
  clean.blocks.find(block => block.id === 'qa').entries[0].answer = 'SciFact';
  assert.equal(M.sectionStates(clean).eval, 'defined');
});

test('a task carries the blocks it links, or the blocks of an own section it links', () => {
  const bp = blueprint();
  bp.items.push({ ...M.RECORD_DEFAULTS.items('Build ingestion'), id: 'i1', origin: 'human', key: 'IMP-001', contextIds: [{ collection: 'blocks', id: 'tbl' }] });
  let built = M.taskContext(bp, 'i1');
  assert.match(built.context, /## Table: Data · Collections\n- Name: documents \| Dimension: —/);
  assert.doesNotMatch(built.context, /Ingestion/, 'only linked blocks are included');
  assert.ok(built.included.some(entry => entry.collection === 'blocks' && entry.id === 'tbl'));
  bp.items[0].contextIds = [{ collection: 'customSections', id: 'eval' }];
  built = M.taskContext(bp, 'i1');
  assert.doesNotMatch(built.context, /Open questions/, 'a Q&A without answers adds nothing');
  bp.blocks.find(block => block.id === 'qa').entries[0].answer = 'SciFact';
  built = M.taskContext(bp, 'i1');
  assert.match(built.context, /## Q&A: Evaluation · Open questions\n- Which dataset\? → SciFact/);
  assert.match(built.context, /## Notes: Evaluation · Notes\nStart small\./);
  assert.match(built.context, /\[ \] Licence checked/);
});

test('research reads every block with stable tags and is told exactly where to write for the selected part', () => {
  const bp = blueprint();
  const context = M.researchContext(bp, { kind: 'section', id: 'data' }).text;
  assert.match(context, /\[blocks tbl\] Table block “Collections”/);
  assert.match(context, /columns: \[column name\] Name; \[column dim\] Dimension/);
  assert.match(context, /\[row r1\] Name: documents \| Dimension: —/);
  assert.match(context, /\[node up\] Upload/);
  assert.match(context, /\[edge e1\] Upload → Chunk/);
  const guide = M.researchGuide(bp, { kind: 'section', id: 'data' });
  assert.match(guide, /^# Where to write \(the section Data \[section data\]\)/);
  assert.match(guide, /"kind":"add","collection":"areas"\} with "section":"data"/);
  assert.match(guide, /schemas: Document schemas/, 'renamed topics are listed in the project’s own words');
  assert.match(guide, /Table block “Collections” \[blocks tbl\]: fill a cell/);
  assert.match(guide, /Flow block “Ingestion” \[blocks flow\]: add a step/);
  assert.match(guide, /Suggest tasks \(items\) only when the selected part is the task plan or the person asks for tasks/);
  assert.doesNotMatch(guide, /collection":"items"/, 'the Data guide does not offer tasks as a place to write');
  assert.match(M.researchGuide(bp, { kind: 'section', id: 'technology' }), /Add a new technology: \{"kind":"add","collection":"technologies"\} with name, category/);
  assert.match(M.researchGuide(bp, { kind: 'section', id: 'plan' }), /collection":"items"/);
  const own = M.researchGuide(bp, { kind: 'section', id: 'eval' });
  assert.match(own, /"kind":"section","section":"eval","field":"description"/);
  assert.match(own, /Q&A block “Open questions” \[blocks qa\]: answer a question/);
  const whole = M.researchGuide(bp, { kind: 'project' });
  assert.match(whole, /- Evaluation \[section eval\]: its description, its blocks/);
  assert.match(whole, /- Data \[section data\]: topic answers \(areas, section "data"\), its blocks/);
  assert.match(M.researchGuide(bp, { kind: 'record', collection: 'blocks', id: 'qa' }), /Rename it with/);
  assert.ok(M.researchTargets(bp).some(option => option.group === 'Your blocks' && option.label === 'Data · Collections'));
  assert.match(M.researchContext(bp, { kind: 'record', collection: 'blocks', id: 'flow' }).text, /Focus: this block\n\[blocks flow\] Flow block “Ingestion”\n {4}\[node up\] Upload/);
  // The guide reaches the agent in a new chat, and again only when a follow-up carries a new context.
  assert.ok(chatPrompt({ question: 'q', context: 'ctx', guide }).includes(guide));
  assert.ok(!chatPrompt({ question: 'q', followUp: true, guide }).includes(guide));
  assert.ok(chatPrompt({ question: 'q', context: 'new', followUp: true, guide }).includes(guide));
});

test('suggestions fill topics, tables, Q&A, checklists, flows and own sections, then apply like a hand edit', () => {
  const bp = blueprint();
  const raw = [
    { title: 'Sources', target: { kind: 'add', collection: 'areas' }, value: { section: 'Data', area: 'Data sources', title: 'SharePoint exports', description: 'Nightly; 50 MB per file.' } },
    { title: 'Schemas', target: { kind: 'topic', section: 'data', area: 'schemas' }, value: 'Three tables\nchunks(id, doc_id, text)' },
    { title: 'Cell', target: { kind: 'block', block: 'tbl', part: 'r1', field: 'Dimension' }, value: '1024' },
    { title: 'Row', target: { kind: 'blockAdd', block: 'tbl' }, value: { Name: 'chunks', Dimension: '384', Index: 'HNSW' } },
    { title: 'Column', target: { kind: 'blockAdd', block: 'tbl' }, value: { column: 'Owner' } },
    { title: 'Answer', target: { kind: 'block', block: 'qa', part: 'q1', field: 'answer' }, value: 'SciFact (CC BY 4.0)' },
    { title: 'Question', target: { kind: 'blockAdd', block: 'qa' }, value: { question: 'Who labels?', answer: 'Two reviewers' } },
    { title: 'Check', target: { kind: 'blockAdd', block: 'todo' }, value: 'Recall@5 above 0.8' },
    { title: 'Arrow first', target: { kind: 'blockAdd', block: 'flow' }, value: { from: 'Chunk', to: '@embed', label: 'chunks' } },
    { title: 'Step', target: { kind: 'blockAdd', block: 'flow' }, ref: 'embed', value: { label: 'Embed', notes: 'e5-small-v2' } },
    { title: 'Notes', target: { kind: 'block', block: 'note', field: 'text' }, value: 'Start small, then grow.' },
    { title: 'About', target: { kind: 'section', section: 'eval', field: 'description' }, value: 'How we measure retrieval.' },
    { title: 'Flow block', target: { kind: 'add', collection: 'blocks' }, value: { section: 'Evaluation', type: 'diagram', title: 'Eval loop', nodes: [{ ref: 'a', label: 'Run' }, { ref: 'b', label: 'Score' }], edges: [{ from: 'a', to: '@b' }] } },
    { title: 'Table block', target: { kind: 'add', collection: 'blocks' }, value: { section: 'data', type: 'Table', title: 'Fields', rows: [{ field: 'id', type: 'uuid' }, { field: 'title', type: 'text' }] } },
    { title: 'Mention', target: { kind: 'blockAdd', block: 'todo' }, value: '@team signs off' },
    // Rejected: a missing block, an unknown type, a cell in a column that does not exist, an arrow to another flow.
    { target: { kind: 'block', block: 'nope', field: 'title' }, value: 'x' },
    { target: { kind: 'add', collection: 'blocks' }, value: { section: 'data', type: 'spreadsheet', title: 'x' } },
    { target: { kind: 'block', block: 'tbl', part: 'r1', field: 'Missing' }, value: 'x' },
    { target: { kind: 'blockAdd', block: 'flow' }, value: { from: 'up', to: 'q1' } },
  ];
  const { proposals, dropped } = proposalsFor({ blueprint: bp, revision: 4 }, raw, { messageId: 'abcdef12-0000-4000-8000-000000000000' });
  assert.equal(dropped, 4);
  const by = title => proposals.find(proposal => proposal.title === title);
  assert.deepEqual(by('Sources').value, { section: 'data', area: 'sources', title: 'SharePoint exports', description: 'Nightly; 50 MB per file.' }, 'section and topic may be named by their words');
  assert.deepEqual(by('Schemas').target, { kind: 'add', collection: 'areas' }, 'an open topic gets a new answer');
  assert.deepEqual(by('Schemas').value, { section: 'data', area: 'schemas', title: 'Three tables', description: 'chunks(id, doc_id, text)' });
  assert.equal(by('Cell').target.field, 'dim', 'a column may be named by its name');
  assert.equal(by('Mention').value.text, '@team signs off', 'text that starts with @ is not a reference');
  assert.equal(M.researchTargetLabel(bp, by('Cell').target), 'Data › Collections › Row “documents” › Dimension');
  assert.equal(M.researchTargetLabel(bp, by('Step').target, by('Step').value), 'Data › Ingestion › New step');
  assert.equal(M.researchTargetLabel(bp, by('Flow block').target, by('Flow block').value), 'New Flow block in Evaluation');
  assert.deepEqual(M.researchBlockPreview(by('Table block').value), ['field: id | type: uuid', 'field: title | type: text']);

  // One at a time, the arrow waits for its step; a batch applies in dependency order.
  const refs = new Map();
  assert.match(M.applyResearchSuggestion(bp, by('Arrow first'), { newId, refs }).conflict, /Apply the two steps/);
  for (const proposal of [...proposals].sort((a, b) => M.researchApplyOrder(a) - M.researchApplyOrder(b))) {
    const result = M.applyResearchSuggestion(bp, proposal, { newId, refs });
    assert.ok(result.ok, `${proposal.title}: ${JSON.stringify(result)}`);
  }
  const block = id => bp.blocks.find(entry => entry.id === id);
  assert.deepEqual(block('tbl').columns.map(column => column.name), ['Name', 'Dimension', 'Owner', 'Index']);
  assert.deepEqual(block('tbl').rows.map(row => Object.values(row.cells)), [['documents', '1024'], ['chunks', '384', 'HNSW']]);
  assert.deepEqual(block('qa').entries.map(entry => entry.answer), ['SciFact (CC BY 4.0)', 'Two reviewers']);
  assert.deepEqual(block('todo').checks.map(entry => entry.text), ['Licence checked', 'Recall@5 above 0.8', '@team signs off']);
  const embed = block('flow').nodes.find(node => node.label === 'Embed');
  assert.ok(block('flow').edges.some(edge => edge.from === 'chunk' && edge.to === embed.id && edge.label === 'chunks'));
  assert.equal(block('note').text, 'Start small, then grow.');
  assert.equal(bp.customSections[0].description, 'How we measure retrieval.');
  const made = bp.blocks.find(entry => entry.title === 'Eval loop');
  assert.equal(made.sectionId, 'eval'); assert.equal(made.origin, 'ai'); assert.equal(made.edges.length, 1);
  assert.deepEqual(bp.areas.map(area => [area.area, area.title]), [['sources', 'SharePoint exports'], ['schemas', 'Three tables']]);
  assert.equal(M.normalizeBlueprint(structuredClone(bp)).repairs, 0, 'applied suggestions leave a valid blueprint');
  // Applying the same again is a conflict, not a duplicate.
  assert.match(M.applyResearchSuggestion(bp, by('Step'), { newId, refs: new Map() }).conflict, /already in this flow/);
  assert.match(M.applyResearchSuggestion(bp, by('Flow block'), { newId, refs: new Map() }).conflict, /already exists in this section/);
  assert.match(M.applyResearchSuggestion(bp, by('Column'), { newId, refs: new Map() }).conflict, /already exists/);
  // An answered topic is improved in place: one line changes the answer, more lines change the details.
  const again = proposalsFor({ blueprint: bp, revision: 5 }, [{ title: 'Short', target: { kind: 'topic', section: 'data', area: 'schemas' }, value: 'Four tables' },
    { title: 'Long', target: { kind: 'topic', section: 'data', area: 'sources' }, value: 'SharePoint\nAnd Confluence pages.' }], { messageId: 'bbbbbbbb-0000-4000-8000-000000000000' }).proposals;
  assert.deepEqual(again.map(proposal => [proposal.target.kind, proposal.target.field]), [['record', 'title'], ['record', 'description']]);
});

test('only the last suggestions block counts: earlier JSON or JSONL examples never cut the answer or hide suggestions', () => {
  const block = JSON.stringify({ suggestions: [{ title: 'Goal', target: { kind: 'vision', field: 'goal' }, value: 'Answer questions' }] });
  const answer = `## Data\n${F}json\n{"doc_id": "d1"}\n${F}\n\n### Acceptance set (JSONL)\n${F}jsonl\n{"q": "a"}\n${F}\nEnd of answer.\n\n${F}origin-suggestions\n${block}\n${F}\n`;
  const found = extractSuggestions(answer);
  assert.equal(found.raw.length, 1);
  assert.ok(found.text.endsWith('End of answer.'), 'the whole answer is kept');
  assert.match(found.text, /Acceptance set \(JSONL\)/);
  assert.equal(extractSuggestions(`a\n${F}origin-suggestions\n{"suggestions":[{"title":"t","target":{"kind":"idea"},"value":"x",},]}\n${F}`).raw.length, 1, 'trailing commas are forgiven');
  assert.deepEqual(extractSuggestions(`a\n${F}origin-suggestions\n{"suggestions": [ {bad\n${F}\nAfter.`), { text: 'a\n\nAfter.', raw: [], unreadable: true });
  assert.deepEqual(extractSuggestions(`a\n${F}json\n{"x": 1}\n${F}`), { text: `a\n${F}json\n{"x": 1}\n${F}`, raw: [] }, 'a final plain JSON example is not a suggestions block');
  assert.equal(extractSuggestions(`a\n${F}json\n{"suggestions": []}\n${F}`).text, 'a');
});

test('a chat’s history state: red while suggestions wait, orange when the latest run failed, green once applied, grey otherwise', () => {
  const chat = (messages, proposals = []) => ({ messages, proposals });
  const ask = { id: 'u1', role: 'user' }, reply = (extra = {}) => ({ id: 'a1', role: 'assistant', status: 'done', ...extra });
  assert.equal(chatState(chat([ask, reply()])), 'none');
  assert.equal(chatState(chat([ask, reply()], [{ status: 'rejected', messageId: 'a1' }])), 'none');
  assert.equal(chatState(chat([ask, reply()], [{ status: 'applied', messageId: 'a1' }, { status: 'rejected', messageId: 'a1' }])), 'applied');
  assert.equal(chatState(chat([ask, reply()], [{ status: 'applied', messageId: 'a1' }, { status: 'pending', messageId: 'a1' }])), 'pending');
  assert.equal(chatState(chat([ask, reply()], [{ status: 'conflict', messageId: 'a1' }])), 'pending');
  assert.equal(chatState(chat([ask, reply({ status: 'failed' })])), 'error');
  assert.equal(chatState(chat([ask, reply({ warnings: ['The suggestions block could not be read, so no suggestions are shown.'] })])), 'error');
  assert.equal(chatState(chat([ask, reply({ warnings: ['2 suggestions were left out because they did not match this blueprint.'] })])), 'error', 'every suggestion of the latest run was lost');
  assert.equal(chatState(chat([ask, reply({ status: 'failed' }), { id: 'u2', role: 'user' }, { id: 'a2', role: 'assistant', status: 'done' }], [{ status: 'applied', messageId: 'a1' }])), 'applied', 'a later good run clears an earlier error');
  assert.equal(chatState(chat([ask, reply({ status: 'stopped' })])), 'none');
});

test('Create Context exports every block: tables as tables, flows as Mermaid, with no unsupported values', () => {
  const bp = blueprint();
  bp.blocks[1].nodes[0].x = 10; bp.blocks[1].nodes[0].y = 20;
  bp.blocks[3].starter = M.blockFingerprint(bp.blocks[3]); // A template's starter mark is bookkeeping, not an unsupported value.
  const { markdown, unsupported } = exportProjectContext({ id: 'p1', name: 'RAG', description: '', kanbanProjectId: null, revision: 2, blueprint: bp });
  assert.deepEqual(unsupported, []);
  assert.match(markdown, /#### Table: Collections\n\n- \*\*Block ID:\*\* `tbl`/);
  assert.match(markdown, /\| Row \| Name \(`name`\) \| Dimension \(`dim`\) \|\n\| --- \| --- \| --- \|\n\| `r1` \| documents \| — \|/);
  assert.match(markdown, /flowchart LR\n {2}N_up\["Upload"\]\n {2}N_chunk\["Chunk"\]\n {2}N_up --> N_chunk/);
  assert.match(markdown, /\*\*Which dataset\?\*\* \(`q1`\)\n\n_Not provided\._/);
  assert.match(markdown, /- \[ \] Licence checked \(`k1`\)/);
  assert.match(markdown, /\| Ingestion \(`flow`\) \| `up` \| 10 \| 20 \|/, 'step positions go to the layout appendix');
});

test('names in any script match exactly (never by being empty), text keeps its "@", and nothing is longer than its field', () => {
  const bp = blueprint();
  bp.customSections.push({ id: 'sec', origin: 'human', phase: 'operate', title: 'Безопасность', description: '', notApplicable: false }, { id: 'dat', origin: 'human', phase: 'design', title: 'Данные', description: '', notApplicable: false });
  bp.blocks.push({ id: 'ru', origin: 'human', sectionId: 'dat', type: 'table', title: 'Поля', columns: [{ id: 'k1', name: 'Имя' }, { id: 'k2', name: 'Тип' }, { id: 'k3', name: '' }], rows: [{ id: 'r', cells: {} }] },
    { id: 'steps', origin: 'human', sectionId: 'dat', type: 'flow', title: 'Поток', nodes: [{ id: 's1', label: 'Загрузка', notes: '', x: null, y: null }], edges: [] });
  const check = raw => proposalsFor({ blueprint: bp, revision: 1 }, raw, { messageId: 'cccccccc-0000-4000-8000-000000000000' });
  const { proposals, dropped } = check([
    { title: 'Block', target: { kind: 'add', collection: 'blocks' }, value: { section: 'Безопасность', type: 'notes', title: 'Ключи', text: 'x' } },
    { title: 'Row', target: { kind: 'blockAdd', block: 'ru' }, value: { Имя: 'id', Тип: 'uuid', Owner: '@alice' } },
    { title: 'List row', target: { kind: 'blockAdd', block: 'ru' }, value: ['a', 'b', 'c'] },
    { title: 'Cell', target: { kind: 'block', block: 'ru', part: 'r', field: 'Тип' }, value: 'text' },
    { title: 'Arrow', target: { kind: 'blockAdd', block: 'steps' }, value: { from: 'Загрузка', to: '@n' } },
    { title: 'Step', target: { kind: 'blockAdd', block: 'steps' }, ref: 'n', value: { label: 'Разбиение' } },
    { title: 'Layer', target: { kind: 'add', collection: 'layers' }, ref: 'L', value: { name: 'Backend' } },
    { title: 'Item', target: { kind: 'add', collection: 'items' }, value: { title: 'Task', layerId: ['@L'], description: '@team owns it' } },
    { title: 'No field', target: { kind: 'block', block: 'ru', part: 'r' }, value: 'lost' },
    { title: 'Flow', target: { kind: 'add', collection: 'blocks' }, value: { section: 'dat', type: 'flow', title: 'Dup', nodes: [{ label: 'A' }, { ref: '1', label: 'B' }, { label: 'C' }], edges: [{ from: '1', to: '3' }] } },
    { title: 'Long', target: { kind: 'add', collection: 'blocks' }, value: { section: 'dat', type: 'qa', title: 'T'.repeat(300), entries: [{ question: 'Q'.repeat(900), answer: 'A' }] } },
  ]);
  assert.equal(dropped, 1, 'a cell without a column is refused instead of landing in the first column');
  const by = title => proposals.find(proposal => proposal.title === title);
  assert.equal(by('Block').value.section, 'sec');
  assert.deepEqual(by('Row').value, { Имя: 'id', Тип: 'uuid', Owner: '@alice' });
  assert.deepEqual(by('List row').value, { Имя: 'a', Тип: 'b', k3: 'c' }, 'an unnamed column is filled by its place');
  assert.equal(by('Cell').target.field, 'k2');
  assert.equal(by('Item').value.description, '@team owns it');
  assert.match(by('Item').value.layerId, /^@cccccccc\.L$/, 'a single link given as a list of one is read as that link');
  const refs = new Map(), next2 = (() => { let i = 0; return () => `z${++i}`; })();
  for (const proposal of [...proposals].sort((a, b) => M.researchApplyOrder(a) - M.researchApplyOrder(b))) assert.ok(M.applyResearchSuggestion(bp, proposal, { newId: next2, refs }).ok, proposal.title);
  const flow = bp.blocks.find(block => block.title === 'Dup');
  assert.equal(new Set(flow.nodes.map(node => node.id)).size, 3, 'three steps keep three IDs');
  assert.equal(bp.blocks.find(block => block.id === 'ru').columns.length, 4, 'one new column, for Owner');
  assert.ok(bp.blocks.find(block => block.id === 'steps').edges.length === 1);
  const long = bp.blocks.find(block => block.type === 'qa' && block.title.startsWith('T'));
  assert.ok(long.title.length <= 120 && long.entries[0].question.length <= 500);
  assert.equal(M.normalizeBlueprint(structuredClone(bp)).repairs, 0, 'nothing is shortened again on save');
  // A notes block never grows past its limit.
  const note = bp.blocks.find(block => block.id === 'note'); note.text = 'x'.repeat(19990);
  const more = check([{ title: 'More', target: { kind: 'blockAdd', block: 'note' }, value: { text: 'y'.repeat(50) } }]).proposals[0];
  assert.match(M.applyResearchSuggestion(bp, more, { newId: next2 }).error, /at most 20,000 characters/);
});

test('reading a suggestions block stays fast on hostile input', () => {
  const started = Date.now();
  extractSuggestions(`${F}origin-suggestions\n{${'\n'.repeat(60000)}x\n${F}`);
  extractSuggestions(`${F}json\n${'{"a":1}\n'.repeat(20000)}${F}`);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});
