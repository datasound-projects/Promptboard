import test from 'node:test';
import assert from 'node:assert/strict';
import { findChrome } from './helpers/browser.mjs';
import { researchPage } from './helpers/research.mjs';

const J = JSON.stringify, F = '```';
const saved = wait => wait(`document.querySelector('#origin-view').dataset.save === 'saved'`, 'saved', 20000);
const type = (ev, selector, value) => ev(`const c = document.querySelector(${J(selector)}); c.value = ${J(value)}; c.dispatchEvent(new Event('input', { bubbles: true }));`);

test('Origin blocks in real Chrome: add every type to any section, edit, reorder, delete with a second click, and keep it after a reload', { skip: !await findChrome(), timeout: 180000 }, async t => {
  const { browser, ev, wait, call, originId } = await researchPage(t);
  await ev(`document.querySelector('.origin-nav-item[data-section="pricing"]').click();`);
  await wait(`document.querySelector('.origin-block-picker.big')`, 'an own section without blocks offers the block types');
  assert.equal(await ev(`return [...document.querySelectorAll('.origin-block-picker.big .origin-block-option-name')].map(n => n.textContent).join(', ');`), 'Q&A, Table, Checklist, Flow, Notes');
  for (const kind of ['qa', 'table', 'checklist', 'flow', 'notes']) {
    const before = await ev(`return document.querySelectorAll('.origin-block').length;`);
    await ev(`document.querySelector('.origin-block-option[data-type=${J(kind)}]').click();`);
    await wait(`document.querySelectorAll('.origin-block').length === ${before + 1}`, `${kind} block`);
    assert.equal(await ev(`return document.activeElement?.classList.contains('origin-block-title');`), true, 'focus goes to the new block title');
  }
  await type(ev, '.origin-block[data-type="qa"] .origin-block-title', 'Open questions');
  await type(ev, '.origin-block[data-type="qa"] .origin-block-question', 'Who pays card fees?');
  await type(ev, '.origin-block[data-type="qa"] .origin-block-qa-row textarea', 'The buyer');
  await type(ev, '.origin-block[data-type="table"] th:nth-child(1) input', 'Plan');
  await type(ev, '.origin-block[data-type="table"] th:nth-child(2) input', 'Fee');
  await ev(`[...document.querySelectorAll('.origin-block[data-type="table"] .origin-block-add')].find(b => b.textContent.includes('row')).click();`);
  await wait(`document.querySelectorAll('.origin-block[data-type="table"] tbody tr').length === 1 && document.activeElement?.classList.contains('origin-block-cell')`, 'a new row with focus');
  await type(ev, '.origin-block[data-type="table"] tbody tr td:nth-child(2) textarea', '5%');
  await ev(`const i = document.querySelector('.origin-block[data-type="checklist"] .origin-quick input'); i.value = 'Refund policy'; i.form.requestSubmit();`);
  await wait(`document.querySelector('.origin-block[data-type="checklist"] .origin-block-check-text')?.value === 'Refund policy'`, 'a point');
  for (const step of ['Cart', 'Pay']) {
    await ev(`const i = document.querySelector('.origin-block[data-type="flow"] .origin-quick input'); i.value = ${J(step)}; i.form.requestSubmit();`);
    await wait(`[...document.querySelectorAll('.origin-flow-node')].some(n => n.textContent.includes(${J(step)}))`, `step ${step}`);
  }
  // Connect: choose where the arrow starts, then where it goes.
  await ev(`document.querySelector('[data-flow-connect]').click();`);
  const node = name => `[...document.querySelectorAll('.origin-flow-node')].find(n => n.textContent.includes(${J(name)}))`;
  await wait(`document.querySelector('[data-flow-connect]')?.textContent === 'Cancel'`, 'connect mode');
  await ev(`${node('Cart')}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`);
  await wait(`document.querySelector('.origin-flow-node.connecting')`, 'arrow start');
  await ev(`${node('Pay')}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`);
  await wait(`document.querySelector('.origin-flow-editor') && document.querySelectorAll('.origin-flow-arrows li').length === 1`, 'arrow drawn; the step editor shows it');
  await type(ev, '.origin-flow-arrows input', 'checkout');
  await type(ev, '.origin-flow-editor textarea', 'Shows the cart total');
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); document.querySelector('#origin-view').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
  await wait(`!document.querySelector('.origin-flow-editor')`, 'Escape closes the step editor');
  await type(ev, '.origin-block[data-type="notes"] textarea', 'Prices include VAT.');
  // Move the notes block to the top, one step at a time.
  for (let i = 0; i < 4; i++) { await ev(`document.querySelector('.origin-block[data-type="notes"] [data-move="-1"]').click();`); await wait(`document.querySelector('.origin-block')?.dataset.type === 'notes' || document.querySelectorAll('.origin-block')[${3 - i}]?.dataset.type === 'notes'`, 'moved'); }
  assert.equal(await ev(`return [...document.querySelectorAll('.origin-block')].map(b => b.dataset.type).join(',');`), 'notes,qa,table,checklist,flow');
  // A block with content asks again; an empty one goes at once.
  await ev(`document.querySelector('.origin-block[data-type="checklist"] .origin-block-remove').click();`);
  assert.equal(await ev(`return document.querySelector('.origin-block[data-type="checklist"] .origin-block-remove').textContent;`), 'Delete with its content?');
  await ev(`document.querySelector('.origin-block[data-type="checklist"] .origin-block-remove').click();`);
  await wait(`!document.querySelector('.origin-block[data-type="checklist"]')`, 'checklist deleted after the second click');
  await saved(wait);
  const stored = (await call(`/api/origin/projects/${originId}`)).blueprint.blocks;
  assert.deepEqual(stored.map(block => [block.sectionId, block.type, block.title]), [['pricing', 'notes', ''], ['pricing', 'qa', 'Open questions'], ['pricing', 'table', ''], ['pricing', 'flow', '']]);
  assert.deepEqual(stored[1].entries.map(entry => [entry.question, entry.answer]), [['Who pays card fees?', 'The buyer']]);
  assert.deepEqual(stored[2].columns.map(column => column.name), ['Plan', 'Fee']);
  assert.deepEqual(Object.values(stored[2].rows[0].cells), ['5%']);
  assert.deepEqual(stored[3].nodes.map(entry => [entry.label, entry.notes]), [['Cart', 'Shows the cart total'], ['Pay', '']], 'the editor opens on the step the arrow starts from');
  assert.equal(stored[3].edges[0].label, 'checkout');
  // Built-in sections hold blocks too; the sidebar counts filled ones and the map shows them.
  await ev(`document.querySelector('.origin-nav-item[data-section="security"]').click();`);
  await wait(`document.querySelector('#origin-section-heading')?.textContent === 'Security'`, 'security');
  await ev(`document.querySelector('.origin-block-picker:not(.big) .origin-block-option[data-type="notes"]').click();`);
  await wait(`document.querySelector('.origin-block[data-type="notes"] textarea')`, 'notes block in a built-in section');
  await type(ev, '.origin-block[data-type="notes"] textarea', 'Keys rotate monthly.');
  await saved(wait);
  await browser.reload();
  await wait(`document.querySelector('#origin-view').dataset.save === 'saved' && document.querySelector('.origin-nav-item[data-section="security"]')`, 'reloaded');
  assert.equal(await ev(`return document.querySelector('.origin-nav-item[data-section="security"] .origin-nav-count')?.textContent;`), '1');
  await ev(`document.querySelector('.origin-nav-item[data-section="overview"]').click();`);
  await wait(`[...document.querySelectorAll('.origin-map text')].some(n => n.textContent.includes('Notes: Untitled'))`, 'blocks appear on the map');
});

test('Research fills the selected section’s topics and blocks; history shows what is left to apply by color', { skip: !await findChrome(), timeout: 180000 }, async t => {
  let answer = () => 'Nothing to change.';
  const prompts = [], researchRunner = async call => { prompts.push(call.prompt); return { text: answer(call), session: call.session?.id || 'thread-1' }; };
  const { ev, wait, call, originId } = await researchPage(t, { server: { researchRunner }, blueprint: bp => {
    bp.blocks.push({ id: 'tbl', origin: 'human', sectionId: 'data', type: 'table', title: 'Collections', columns: [{ id: 'c1', name: 'Collection' }, { id: 'c2', name: 'Dimension' }], rows: [{ id: 'r1', cells: { c1: 'documents' } }] },
      { id: 'fl', origin: 'human', sectionId: 'data', type: 'flow', title: 'Ingestion', nodes: [{ id: 'up', label: 'Upload' }], edges: [] });
  } });
  // An answer with JSON and JSONL examples before the suggestions block (the case that hid every suggestion before).
  answer = () => [`## Data`, `${F}json`, '{"doc_id": "d1"}', F, '### Acceptance set (JSONL)', `${F}jsonl`, '{"q": "a"}', F, 'All set.', '', `${F}origin-suggestions`, J({ suggestions: [
    { title: 'Sources', target: { kind: 'add', collection: 'areas' }, value: { section: 'data', area: 'sources', title: 'SharePoint exports', description: 'Nightly.' } },
    { title: 'Dimension', target: { kind: 'block', block: 'tbl', part: 'r1', field: 'Dimension' }, value: '1024' },
    { title: 'Chunk step', target: { kind: 'blockAdd', block: 'fl' }, ref: 'c', value: { label: 'Chunk' } },
    { title: 'Arrow', target: { kind: 'blockAdd', block: 'fl' }, value: { from: 'up', to: '@c' } },
    { title: 'Retention', target: { kind: 'add', collection: 'blocks' }, value: { section: 'data', type: 'table', title: 'Retention', columns: ['Data', 'Kept for'], rows: [['Raw', '90 days']] } },
  ] }), F].join('\n');
  await ev(`document.querySelector('.origin-nav-item[data-section="data"]').click();`);
  await wait(`document.querySelector('#origin-section-heading')?.textContent === 'Data'`, 'data');
  await ev(`document.querySelector('#origin-research-open').click();`);
  await wait(`document.querySelector('#origin-drawer')?.dataset.mode === 'research'`, 'research');
  assert.equal(await ev(`return JSON.parse(document.querySelector('#origin-research-scope').value).id;`), 'data', 'research starts on the section that is open');
  await ev(`const i = document.querySelector('#origin-research-input'); i.value = 'Design the data architecture'; i.form.requestSubmit();`);
  await wait(`document.querySelectorAll('.origin-research-proposal').length === 5`, 'five suggestions', 30000);
  assert.match(prompts.at(-1), /# Where to write \(the section Data \[section data\]\)/, 'the agent is told where to write');
  assert.match(prompts.at(-1), /Table block “Collections” \[blocks tbl\]/);
  assert.match(await ev(`return document.querySelector('.origin-research-message.is-assistant').textContent;`), /Acceptance set \(JSONL\)[\s\S]*All set\./, 'the whole answer stays readable');
  assert.deepEqual(await ev(`return [...document.querySelectorAll('.origin-research-proposal .origin-research-target')].map(n => n.textContent);`),
    ['Data › Data sources', 'Data › Collections › Row “documents” › Dimension', 'Data › Ingestion › New step', 'Data › Ingestion › New arrow', 'New Table block in Data']);
  await ev(`document.querySelector('#origin-research-apply-all').click();`);
  await wait(`[...document.querySelectorAll('.origin-research-proposal')].every(c => c.dataset.status === 'applied')`, 'all applied', 20000);
  await saved(wait);
  const bp = (await call(`/api/origin/projects/${originId}`)).blueprint;
  assert.deepEqual(bp.areas.map(area => [area.section, area.area, area.title]), [['data', 'sources', 'SharePoint exports']]);
  assert.equal(bp.blocks[0].rows[0].cells.c2, '1024');
  assert.deepEqual(bp.blocks[1].nodes.map(node => node.label), ['Upload', 'Chunk']);
  assert.equal(bp.blocks[1].edges.length, 1);
  assert.equal(bp.blocks[2].title, 'Retention');
  assert.equal(await ev(`return document.querySelectorAll('#origin-main .origin-block').length;`), 3, 'the page shows the new block');
  // Three more chats: nothing to apply, a broken block, one suggestion left open.
  const ask = async text => {
    await ev(`document.querySelector('#origin-research-new').click();`);
    await ev(`const i = document.querySelector('#origin-research-input'); i.value = ${J(text)}; i.form.requestSubmit();`);
    await wait(`document.querySelector('.origin-research-message.is-assistant:not(.is-live)') && !document.querySelector('.origin-research-message.is-live')`, `answer to ${text}`, 30000);
  };
  answer = () => 'Nothing to change.'; await ask('Anything else?');
  answer = () => `Partial.\n${F}origin-suggestions\n{"suggestions": [ {bad\n${F}`; await ask('Broken');
  assert.match(await ev(`return document.querySelector('.origin-research-message.is-assistant').textContent;`), /could not be read/);
  answer = () => `One more.\n${F}origin-suggestions\n${J({ suggestions: [{ title: 'Goal', target: { kind: 'vision', field: 'goal' }, value: 'Sell handmade goods' }] })}\n${F}`; await ask('Open one');
  await ev(`document.querySelector('#origin-research-history').click();`);
  await wait(`document.querySelectorAll('.origin-research-chat').length === 4`, 'history', 15000);
  const rows = await ev(`return [...document.querySelectorAll('.origin-research-chat')].map(r => [r.querySelector('strong').textContent, r.dataset.state, r.querySelector('.origin-research-chat-state').textContent, getComputedStyle(r).borderLeftColor]);`);
  assert.deepEqual(rows.map(([title, state, label]) => [title, state, label]), [['Open one', 'pending', '1 suggestion not applied yet'], ['Broken', 'error', 'Something went wrong — open it to see what'],
    ['Anything else?', 'none', 'Nothing to apply'], ['Design the data architecture', 'applied', 'Applied · 5']]);
  assert.equal(new Set(rows.map(row => row[3])).size, 4, 'each state has its own color');
});
