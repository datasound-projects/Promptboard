// Origin's sidebar is the project's own structure: start from the default categories or blank, then create, rename,
// move (menus and drag and drop), copy and delete categories, sections and fields. It persists, stays per project,
// and Research follows it while its window is open, also when a run is under way.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findChrome, launch } from './helpers/browser.mjs';
import { researchPage } from './helpers/research.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const chrome = await findChrome();
const J = JSON.stringify;

/** Page helpers shared by both tests. */
function helpers(ev, wait) {
  const pick = async (key, text) => {
    await ev(`const m = document.querySelector('[data-nav=${J(`menu:${key}`)}]').closest('details'); m.open = true;
      [...m.querySelectorAll('.origin-menu-item')].find(b => b.textContent === ${J(text)}).click();`);
  };
  const reword = async (key, value) => {
    await ev(`document.querySelector('[data-edit=${J(key)}]').click();`);
    await wait(`document.activeElement?.matches('.origin-inline-input')`, `editing ${key}`);
    await ev(`const i = document.activeElement; i.value = ${J(value)}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`);
  };
  const structure = () => ev(`return [...document.querySelectorAll('#origin-nav .origin-phase')].map(p => [p.querySelector('.origin-phase-name').textContent, [...p.querySelectorAll('.origin-nav-label')].map(n => n.textContent)]);`);
  const open = id => ev(`document.querySelector('.origin-nav-item[data-section=${J(id)}]').click();`);
  const sectionId = name => ev(`return [...document.querySelectorAll('.origin-nav-item')].find(n => n.querySelector('.origin-nav-label').textContent === ${J(name)})?.dataset.section;`);
  const phaseId = name => ev(`return [...document.querySelectorAll('#origin-nav .origin-phase')].find(p => p.querySelector('.origin-phase-name').textContent === ${J(name)})?.dataset.phase;`);
  // Drag and drop as the browser sends it: dragstart on the source, dragover and drop on the target, dragend.
  const drag = (from, to, after = false) => ev(`
    const source = document.querySelector(${J(from)}), target = document.querySelector(${J(to)}), data = new DataTransfer();
    const box = target.getBoundingClientRect(), y = ${after} ? box.bottom - 2 : box.top + 2, at = { bubbles: true, cancelable: true, dataTransfer: data, clientX: box.left + 10, clientY: y };
    source.dispatchEvent(new DragEvent('dragstart', at)); target.dispatchEvent(new DragEvent('dragover', at)); target.dispatchEvent(new DragEvent('drop', at)); source.dispatchEvent(new DragEvent('dragend', at));`);
  return { pick, reword, structure, open, sectionId, phaseId, drag };
}

test('Origin structure: default and blank starts, every level customized, all defaults deleted, persisted, isolated per project', { skip: !chrome, timeout: 240000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const read = id => fetch(`${app.url}/api/origin/projects/${id}`, { headers: { 'X-STE-Token': token } }).then(response => response.json());
  const browser = await launch({ width: 1440, height: 1000 }); assert.ok(browser); t.after(() => browser.close());
  const ev = code => browser.eval(code), wait = (expression, label, ms = 15000) => browser.until(expression, label, ms);
  const { pick, reword, structure, open, sectionId, phaseId, drag } = helpers(ev, wait);
  const saved = () => wait(`document.querySelector('#origin-view').dataset.save === 'saved'`, 'saved');

  // 1. From the default blueprint.
  await browser.goto(`${app.url}/#/origin`);
  await wait(`document.querySelector('#origin-first-project')`, 'start screen');
  assert.equal(await ev(`return document.querySelector('#origin-first-start .origin-blueprint-card[aria-checked="true"]').dataset.kind;`), 'default');
  await ev(`document.querySelector('#origin-first-project').value = 'Atlas'; document.querySelector('#origin-idea').value = 'A travel planner'; document.querySelector('#origin-first-kanban').checked = false;
    document.querySelector('#origin-start').closest('form').requestSubmit();`);
  await wait(`document.querySelectorAll('.origin-nav-item').length === 15 && document.querySelector('.origin-map')`, 'default structure');
  const atlas = await ev(`return document.querySelector('#origin-project').value;`);
  assert.deepEqual((await structure()).map(([name]) => name), ['Define', 'Design', 'Operate', 'Decide', 'Build']);

  // Categories: add, rename, move (menu and drag), copy.
  await ev(`document.querySelector('#origin-add-category').click();`);
  await wait(`document.activeElement?.matches('#origin-nav .origin-inline-input')`, 'new category name is editable');
  await ev(`const i = document.activeElement; i.value = 'Business'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`);
  await wait(`[...document.querySelectorAll('.origin-phase-name')].some(n => n.textContent === 'Business')`, 'category added');
  const business = await phaseId('Business');
  await pick(`phase:${business}`, 'Move up');
  assert.deepEqual((await structure()).map(([name]) => name), ['Define', 'Design', 'Operate', 'Decide', 'Business', 'Build']);
  await drag(`.origin-phase[data-phase="${business}"] .origin-drag-handle`, '.origin-phase[data-phase="define"]');
  await wait(`document.querySelector('#origin-nav .origin-phase').dataset.phase === ${J(business)}`, 'category dragged to the top');
  await reword('phase:define', 'Discover');
  // Sections: add one of its own, rename it, add a question, move sections by drag and by menu, copy one.
  await ev(`document.querySelector('.origin-phase[data-phase="${business}"] .origin-phase-add').click();`);
  await wait(`document.activeElement?.matches('#origin-main .origin-inline-input')`, 'new section title is editable');
  await ev(`const i = document.activeElement; i.value = 'Pricing'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`);
  await wait(`document.querySelector('#origin-section-heading')?.textContent === 'Pricing'`, 'section added');
  const pricing = await sectionId('Pricing');
  await ev(`[...document.querySelectorAll('#origin-main button')].find(b => b.textContent === '＋ Add a question').click();`);
  await wait(`document.activeElement?.matches('.origin-inline-input')`, 'question editable');
  await ev(`const i = document.activeElement; i.value = 'What does it cost?'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`);
  await ev(`const t = document.querySelector('[data-question] textarea'); t.value = '9 EUR a month'; t.dispatchEvent(new Event('input', { bubbles: true }));`);
  await drag('.origin-nav-entry[data-page="decisions"]', `.origin-phase[data-phase="${business}"]`);
  await wait(`[...document.querySelectorAll('.origin-phase[data-phase="${business}"] .origin-nav-item')].map(n => n.dataset.section).join() === ${J([pricing, 'decisions'].join())}`, 'section dragged into Business');
  await drag('.origin-nav-entry[data-page="decisions"]', `.origin-nav-entry[data-page="${pricing}"]`);
  await wait(`document.querySelector('.origin-phase[data-phase="${business}"] .origin-nav-item').dataset.section === 'decisions'`, 'section dragged before Pricing');
  await pick(`section:${pricing}`, 'Duplicate');
  await wait(`document.querySelector('#origin-section-heading')?.textContent === 'Pricing (copy)' && document.querySelector('[data-question] textarea')?.value === '9 EUR a month'`, 'section copied with its answer');
  const copy = await ev(`return document.querySelector('.origin-nav-item[aria-current="page"]').dataset.section;`);
  await pick(`section:${copy}`, 'Delete section…');
  await wait(`document.querySelector('#origin-remove-dialog')?.open`, 'asks before deleting a section with content');
  assert.match(await ev(`return document.querySelector('#origin-remove-dialog').textContent;`), /1 question \(1 answered\)/);
  await ev(`document.querySelector('#origin-remove-dialog-submit').click();`);
  await wait(`!document.querySelector('.origin-nav-item[data-section=${J(copy)}]')`, 'copy deleted');
  // Fields: a topic is removed (undo brings it back), a vision question removed and restored, a block changes type.
  await open('security');
  await ev(`const i = document.querySelector('.origin-topic[data-area="secrets"] input'); i.value = 'Vault'; i.dispatchEvent(new Event('input', { bubbles: true }));`);
  await pick('topic:security:secrets', 'Remove topic');
  await wait(`!document.querySelector('.origin-topic[data-area="secrets"]') && !document.querySelector('#origin-undo').hidden`, 'topic removed with undo');
  await ev(`document.querySelector('#origin-undo .origin-undo-button').click();`);
  await wait(`document.querySelector('.origin-topic[data-area="secrets"] input')?.value === 'Vault'`, 'undo brings the topic and its answer back');
  await pick('topic:security:network_exposure', 'Remove topic');
  await wait(`!document.querySelector('.origin-topic[data-area="network_exposure"]') && [...document.querySelectorAll('.origin-restore option')].some(o => o.value === 'network_exposure')`, 'a removed topic can be added back');
  await open('vision');
  await pick('vision:constraints', 'Remove question');
  await wait(`!document.querySelector('[data-vision="constraints"]')`, 'vision question removed');
  await pick('vision:summary', 'Move down');
  await wait(`document.querySelectorAll('[data-vision]')[1]?.dataset.vision === 'summary'`, 'vision question moved');
  await open(pricing);
  await ev(`document.querySelector('.origin-block-option[data-type="checklist"]').click();`);
  await wait(`document.querySelector('.origin-block[data-type="checklist"]')`, 'block added');
  const block = await ev(`return document.querySelector('.origin-block').dataset.block;`);
  await pick(`block:${block}`, 'Change to Table');
  await wait(`document.querySelector('.origin-block').dataset.type === 'table'`, 'empty block changed type');
  await saved();
  let file = (await read(atlas)).blueprint;
  assert.deepEqual(file.structure.phases.map(phase => phase.id), [business, 'define', 'design', 'operate', 'decide', 'build']);
  assert.deepEqual(file.structure.sections.filter(entry => entry.phase === business).map(entry => entry.id), ['decisions', pricing]);
  assert.equal(file.labels.phases.define, 'Discover');
  assert.deepEqual([file.structure.topics.security.includes('network_exposure'), file.structure.vision.includes('constraints'), file.structure.vision[1]], [false, false, 'summary']);
  assert.equal(file.areas.find(item => item.area === 'secrets').title, 'Vault');
  assert.equal(file.answers[file.questions.find(question => question.sectionId === pricing).id], '9 EUR a month');

  // 4. Every default category deleted: the project still works, and new structure can be added.
  for (const id of ['define', 'design', 'operate', 'decide', 'build']) {
    await pick(`phase:${id}`, 'Delete category…');
    await wait(`document.querySelector('#origin-remove-dialog')?.open || !document.querySelector('.origin-phase[data-phase=${J(id)}]')`, `deleting ${id}`);
    await ev(`const d = document.querySelector('#origin-remove-dialog'); if (d?.open) d.querySelector('#origin-remove-dialog-submit').click();`);
    await wait(`!document.querySelector('.origin-phase[data-phase=${J(id)}]')`, `${id} deleted`);
  }
  assert.deepEqual(await structure(), [['Business', ['Decisions', 'Pricing']]]);
  await open('overview');
  await wait(`document.querySelectorAll('.origin-map-section').length === 2 && document.querySelector('#origin-readiness') && !document.querySelector('#origin-readiness').hidden`, 'Overview and map with the two sections left');
  await open(pricing);
  await saved();
  file = (await read(atlas)).blueprint;
  assert.deepEqual([file.requirements.length, file.areas.length, file.vision.goal, Object.keys(file.structure.topics)], [0, 0, '', []]);

  // 2. A blank project, built from nothing.
  await ev(`document.querySelector('#origin-new-project').click();`);
  await wait(`document.querySelector('#origin-new-dialog')?.open`, 'new project dialog');
  await ev(`document.querySelector('#origin-new-name').value = 'Recipes'; document.querySelector('#origin-new-kanban').checked = false;
    document.querySelector('#origin-new-start .origin-blueprint-card[data-kind="blank"]').click();
    document.querySelector('#origin-new-dialog-submit').click();`);
  await wait(`document.querySelector('#origin-project').selectedOptions[0]?.textContent === 'Recipes' && document.querySelectorAll('.origin-nav-item').length === 1 && document.querySelector('.origin-nav-start')`, 'blank: only the Overview and an empty state');
  await ev(`document.querySelector('#origin-add-category').click();`);
  await wait(`document.activeElement?.matches('#origin-nav .origin-inline-input')`, 'category editable');
  await ev(`const i = document.activeElement; i.value = 'Kitchen'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`);
  await ev(`document.querySelector('#origin-nav .origin-phase .origin-phase-add').click();`);
  await wait(`document.activeElement?.matches('#origin-main .origin-inline-input')`, 'section editable');
  await ev(`const i = document.activeElement; i.value = 'Ingredients'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`);
  await wait(`document.querySelector('#origin-section-heading')?.textContent === 'Ingredients'`, 'section in a blank project');
  await saved();
  const recipes = await ev(`return document.querySelector('#origin-project').value;`);

  // 5. Reload and reopen: both custom structures are kept.
  await browser.reload();
  await wait(`document.querySelectorAll('.origin-nav-item').length === 2`, 'reloaded Recipes');
  assert.deepEqual(await structure(), [['Kitchen', ['Ingredients']]]);
  // 6. Switching projects swaps the whole structure; nothing of one shows in the other.
  await ev(`const s = document.querySelector('#origin-project'); s.value = ${J(atlas)}; s.dispatchEvent(new Event('change', { bubbles: true }));`);
  await wait(`document.querySelectorAll('.origin-nav-item').length === 3`, 'Atlas');
  assert.deepEqual(await structure(), [['Business', ['Decisions', 'Pricing']]]);
  await ev(`document.querySelector('#origin-research-open').click();`);
  await wait(`document.querySelector('#origin-research-scope')`, 'research open');
  assert.deepEqual(await ev(`return [...document.querySelectorAll('#origin-research-scope option')].map(o => o.textContent).filter(t => t.includes('›'));`).then(list => list.filter(text => /Business|Kitchen/.test(text))), ['Business › Decisions', 'Business › Pricing']);
  await ev(`const s = document.querySelector('#origin-project'); s.value = ${J(recipes)}; s.dispatchEvent(new Event('change', { bubbles: true }));`);
  await wait(`document.querySelectorAll('.origin-nav-item').length === 2`, 'Recipes again');
  assert.deepEqual((await read(recipes)).blueprint.structure.phases.map(phase => phase.title), ['Kitchen']);

  // Reset: restoring the default categories keeps Kitchen; starting over blank asks for the name and can be undone.
  const reset = () => ev(`document.querySelector('#origin-project-menu').open = true; [...document.querySelectorAll('#origin-project-menu .origin-menu-item')].find(b => b.textContent === 'Reset structure…').click();`);
  await reset();
  await wait(`document.querySelector('#origin-reset-dialog')?.open`, 'reset dialog');
  await ev(`document.querySelector('#origin-reset-dialog-submit').click();`);
  await wait(`document.querySelectorAll('.origin-nav-item').length === 16 && /resets/.test(document.querySelector('#origin-notice').textContent)`, 'default categories back next to Kitchen; the copy is named');
  assert.ok((await structure()).some(([name, pages]) => name === 'Kitchen' && pages.join() === 'Ingredients'));
  await reset();
  await wait(`document.querySelector('#origin-reset-dialog')?.open`, 'reset dialog again');
  await ev(`const r = document.querySelector('input[name="origin-reset-mode"][value="blank"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#origin-reset-name').value = 'Wrong'; document.querySelector('#origin-reset-dialog-submit').click();`);
  await wait(`document.querySelector('#origin-reset-dialog .origin-inline-error')?.hidden === false`, 'a wrong name is refused');
  assert.equal(await ev(`return document.querySelectorAll('.origin-nav-item').length;`), 16, 'nothing changed');
  await ev(`document.querySelector('#origin-reset-name').value = 'Recipes'; document.querySelector('#origin-reset-dialog-submit').click();`);
  await wait(`document.querySelectorAll('.origin-nav-item').length === 1 && !document.querySelector('#origin-undo').hidden`, 'blank, with an undo');
  await ev(`document.querySelector('#origin-undo .origin-undo-button').click();`);
  await wait(`document.querySelectorAll('.origin-nav-item').length === 16`, 'undone');
  await saved();
  assert.equal((await read(recipes)).blueprint.structure.phases.length, 6);
  assert.deepEqual(browser.consoleMessages.filter(text => text.startsWith('EXCEPTION')), [], 'no page errors');
});

test('Research follows the structure while open: new sections are offered and researched, renamed ones relabelled, removed ones never come back', { skip: !chrome, timeout: 180000 }, async t => {
  let gate = null, reply = () => '';
  const prompts = [];
  const researchRunner = async call => { prompts.push(call.prompt); if (gate) await gate.promise; return { text: reply(), session: call.session?.id || 'thread-1' }; };
  const { ev, wait, call, originId } = await researchPage(t, { server: { researchRunner } });
  const { pick, reword, open, sectionId } = helpers(ev, wait);
  const saved = async () => { await wait(`document.querySelector('#origin-view').dataset.save === 'saved'`, 'saved'); return (await call(`/api/origin/projects/${originId}`)).blueprint; };
  const scopes = () => ev(`return [...document.querySelectorAll('#origin-research-scope option')].map(o => o.textContent);`);
  const send = text => ev(`const i = document.querySelector('#origin-research-input'); i.value = ${J(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.closest('form').requestSubmit();`);

  await ev(`document.querySelector('#origin-research-open').click();`);
  await wait(`document.querySelector('#origin-research-send') && !document.querySelector('#origin-research-send').disabled`, 'research ready');
  assert.ok((await scopes()).includes('Decide › Pricing model'));

  // 7. With Research open: a new section with a question, and a rename, show in its scopes at once.
  await ev(`document.querySelector('.origin-phase[data-phase="build"] .origin-phase-add').click();`);
  await wait(`document.activeElement?.matches('#origin-main .origin-inline-input')`, 'new section editable');
  await ev(`const i = document.activeElement; i.value = 'Launch'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`);
  await wait(`document.querySelector('#origin-section-heading')?.textContent === 'Launch'`, 'Launch added');
  const launch = await sectionId('Launch');
  await ev(`[...document.querySelectorAll('#origin-main button')].find(b => b.textContent === '＋ Add a question').click();`);
  await wait(`document.activeElement?.matches('.origin-inline-input')`, 'question editable');
  await ev(`const i = document.activeElement; i.value = 'Which channels?'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`);
  await wait(`[...document.querySelectorAll('#origin-research-scope option')].some(o => o.textContent === 'Build › Launch')`, 'the new section is a research scope at once');
  await open('pricing');
  await reword('title', 'Pricing');
  await wait(`[...document.querySelectorAll('#origin-research-scope option')].some(o => o.textContent === 'Decide › Pricing') && ![...document.querySelectorAll('#origin-research-scope option')].some(o => o.textContent === 'Decide › Pricing model')`, 'the rename shows in the scopes at once');

  // 8. Research the new section: the agent is told its question, and its answer lands in it.
  const question = (await saved()).questions.find(entry => entry.sectionId === launch).id;
  reply = () => `Two channels.\n\n\`\`\`origin-suggestions\n${J({ suggestions: [{ title: 'Answer the channels', target: { kind: 'answer', questionId: question }, value: 'Newsletter and Product Hunt' }] })}\n\`\`\``;
  await ev(`const s = document.querySelector('#origin-research-scope'); s.value = ${J(J({ kind: 'section', id: launch }))}; s.dispatchEvent(new Event('change', { bubbles: true }));`);
  await send('Where should we launch?');
  await wait(`document.querySelectorAll('.origin-research-proposal').length === 1`, 'a suggestion for the new question');
  assert.match(prompts.at(-1), new RegExp(`${question} \\(Which channels\\?\\)`), 'the prompt names the new question by its ID');
  await ev(`[...document.querySelector('.origin-research-proposal').querySelectorAll('button')].find(b => b.textContent === 'Apply').click();`);
  await wait(`document.querySelector('.origin-research-proposal').dataset.status === 'applied'`, 'applied');
  assert.equal((await saved()).answers[question], 'Newsletter and Product Hunt');

  // 9. Sections removed while a run is under way: their suggestions arrive but cannot land or bring anything back.
  reply = () => `Ideas.\n\n\`\`\`origin-suggestions\n${J({ suggestions: [
    { title: 'Add Stripe', target: { kind: 'add', collection: 'technologies' }, value: { name: 'Stripe', category: 'cloud' } },
    { title: 'Better channels', target: { kind: 'answer', questionId: question }, value: 'Newsletter only' },
    { title: 'Sharper goal', target: { kind: 'vision', field: 'goal' }, value: 'Sell 100 items a month' }] })}\n\`\`\``;
  let release; gate = { promise: new Promise(resolve => { release = resolve; }) };
  await ev(`const s = document.querySelector('#origin-research-scope'); s.value = ${J(J({ kind: 'project' }))}; s.dispatchEvent(new Event('change', { bubbles: true }));`);
  await send('Anything else?');
  await wait(`document.querySelector('#origin-research-send')?.classList.contains('is-stop')`, 'running');
  await pick('section:technology', 'Delete section…');
  await wait(`!document.querySelector('.origin-nav-item[data-section="technology"]')`, 'Stack deleted (it was empty)');
  await pick(`section:${launch}`, 'Delete section…');
  await wait(`document.querySelector('#origin-remove-dialog')?.open`, 'asks: Launch has an answered question');
  await ev(`document.querySelector('#origin-remove-dialog-submit').click();`);
  await wait(`!document.querySelector('.origin-nav-item[data-section=${J(launch)}]') && ![...document.querySelectorAll('#origin-research-scope option')].some(o => o.textContent.includes('Launch'))`, 'Launch deleted and gone from the scopes');
  await saved();
  release(); gate = null;
  await wait(`document.querySelectorAll('.origin-research-proposal').length === 4`, 'three new suggestions');
  const card = title => `[...document.querySelectorAll('.origin-research-proposal')].find(c => c.querySelector('strong')?.textContent === ${J(title)})`;
  for (const title of ['Add Stripe', 'Better channels']) {
    assert.equal(await ev(`return ${card(title)}.dataset.gone;`), 'true', `${title} is marked as no longer applicable`);
    assert.deepEqual(await ev(`return [...${card(title)}.querySelectorAll('button')].map(b => b.textContent);`), ['Dismiss'], 'no Apply and no Replace anyway');
  }
  await ev(`[...${card('Sharper goal')}.querySelectorAll('button')].find(b => b.textContent === 'Apply').click();`);
  await wait(`${card('Sharper goal')}.dataset.status === 'applied'`, 'a suggestion for a part that still exists applies');
  await ev(`[...${card('Add Stripe')}.querySelectorAll('button')].find(b => b.textContent === 'Dismiss').click();`);
  await wait(`${card('Add Stripe')}.dataset.status === 'rejected'`, 'dismissed');
  const after = await saved();
  assert.deepEqual([after.technologies.length, after.customSections.some(entry => entry.id === launch), after.structure.sections.some(entry => entry.id === 'technology'), after.vision.goal],
    [0, false, false, 'Sell 100 items a month'], 'nothing removed came back');
});
