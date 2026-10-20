// The blueprint library in the page: choose, preview and switch templates, create projects from five different ones,
// edit and mix them, save and reuse a personal blueprint, reload, and research a template question.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/origin-model.js';
import '../public/origin-templates.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const chrome = await findChrome();
const J = JSON.stringify;
const T = globalThis.PromptboardOriginTemplates;

test('blueprint library: five project types from preview to research, edited, mixed, saved, reloaded and isolated', { skip: !chrome, timeout: 300000 }, async t => {
  let reply = () => 'Nothing to add.';
  const prompts = [];
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [{ id: 'claude', available: true, version: '2.1.296' }],
    authAdapter: { installed: async () => true, status: async () => ({ state: 'signed-in' }) }, catalogReader: async provider => ({ provider, models: [{ id: 'sonnet', name: 'Sonnet', efforts: ['low'] }] }),
    researchRunner: async call => { prompts.push(call.prompt); return { text: reply(), session: 'thread-1' }; } });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const read = async name => { const list = await (await fetch(`${app.url}/api/origin/projects`, { headers: { 'X-STE-Token': token } })).json(); const id = list.projects.find(item => item.name === name).id; return (await (await fetch(`${app.url}/api/origin/projects/${id}`, { headers: { 'X-STE-Token': token } })).json()).blueprint; };
  const browser = await launch({ width: 1440, height: 1000 }); assert.ok(browser); t.after(() => browser.close());
  const ev = code => browser.eval(code), wait = (expression, label, ms = 15000) => browser.until(expression, label, ms);
  const categories = () => ev(`return [...document.querySelectorAll('#origin-nav .origin-phase-name')].map(n => n.textContent);`);
  const expected = id => T.get(id).categories.map(category => category.title);
  const saved = () => wait(`document.querySelector('#origin-view').dataset.save === 'saved'`, 'saved');
  const card = (scope, kind, id) => `${scope} .origin-blueprint-card[data-kind=${J(kind)}]${id ? `[data-id=${J(id)}]` : ''}`;

  // 1. Web app, from the first-project page: search, preview, create.
  await browser.goto(`${app.url}/#/origin`);
  await wait(`document.querySelector('#origin-first-start .origin-blueprint-card')`, 'library on the start page');
  await ev(`const s = document.querySelector('#origin-first-start-search'); s.value = 'progressive'; s.dispatchEvent(new Event('input', { bubbles: true }));`);
  await wait(`[...document.querySelectorAll('#origin-first-start .origin-blueprint-card')].map(c => c.dataset.id).join() === 'frontend-web'`, 'search finds the PWA blueprint');
  await ev(`document.querySelector(${J(card('#origin-first-start', 'template', 'frontend-web'))}).click();`);
  await wait(`/UI Architecture/.test(document.querySelector('#origin-first-start .origin-blueprint-preview').textContent) && /rendering model/.test(document.querySelector('#origin-first-start .origin-blueprint-preview').textContent)`, 'preview with sections and questions');
  await ev(`document.querySelector('#origin-first-project').value = 'Storefront'; document.querySelector('#origin-first-kanban').checked = false; document.querySelector('#origin-start').closest('form').requestSubmit();`);
  await wait(`document.querySelectorAll('#origin-nav .origin-phase').length === ${expected('frontend-web').length}`, 'web app structure');
  assert.deepEqual(await categories(), expected('frontend-web'));

  // 2–5. MLOps, Agentic AI, Data engineering and Desktop through New project; a category chip narrows the cards and
  // the last card chosen is the one used (switching templates before creating).
  const create = async (name, id, chip, switchFrom) => {
    await ev(`document.querySelector('#origin-new-project').click();`);
    await wait(`document.querySelector('#origin-new-dialog')?.open && document.querySelector('#origin-new-start .origin-blueprint-card')`, `dialog for ${name}`);
    await ev(`document.querySelector('#origin-new-start .origin-blueprint-chip[data-category=${J(chip)}]').click();`);
    await wait(`[...document.querySelectorAll('#origin-new-start .origin-blueprint-card')].every(c => ${J(T.TEMPLATES.filter(template => template.category === chip).map(template => template.id))}.includes(c.dataset.id))`, `${chip} cards only`);
    if (switchFrom) { await ev(`document.querySelector(${J(card('#origin-new-start', 'template', switchFrom))}).click();`); await wait(`document.querySelector(${J(card('#origin-new-start', 'template', switchFrom))}).getAttribute('aria-checked') === 'true'`, 'first choice'); }
    await ev(`document.querySelector(${J(card('#origin-new-start', 'template', id))}).click();`);
    await wait(`document.querySelector('#origin-new-start .origin-blueprint-preview h3').textContent === ${J(T.get(id).name)}`, `${id} preview`);
    await ev(`document.querySelector('#origin-new-name').value = ${J(name)}; document.querySelector('#origin-new-kanban').checked = false; document.querySelector('#origin-new-dialog-submit').click();`);
    await wait(`document.querySelector('#origin-project').selectedOptions[0]?.textContent === ${J(name)} && document.querySelectorAll('#origin-nav .origin-phase').length === ${expected(id).length}`, `${name} created`);
    assert.deepEqual(await categories(), expected(id), name);
  };
  await create('Churn model', 'mlops', 'ai', 'rag');
  await wait(`!!document.querySelector('.origin-nav-item[data-section]')`, 'nav');
  await ev(`[...document.querySelectorAll('.origin-nav-item')].find(n => n.textContent.includes('Training & Experiment Tracking')).click();`);
  await wait(`/Training pipeline/.test(document.querySelector('.origin-block[data-type="flow"] .origin-block-title')?.value || '')`, 'the training pipeline skeleton is a flow block');
  await create('Support agents', 'agentic', 'ai');
  await create('Warehouse pipelines', 'data-platform', 'data');
  await create('Notes desktop', 'desktop', 'apps');

  // Edit the desktop project: delete a category, mix in sections from another blueprint (twice is prevented).
  const desktopPhases = await ev(`return [...document.querySelectorAll('#origin-nav .origin-phase')].map(p => p.dataset.phase);`);
  await ev(`const m = document.querySelector('[data-nav="menu:phase:${desktopPhases[0]}"]').closest('details'); m.open = true; [...m.querySelectorAll('.origin-menu-item')].find(b => b.textContent === 'Delete category…').click();`);
  await wait(`document.querySelector('#origin-remove-dialog')?.open || document.querySelectorAll('#origin-nav .origin-phase').length === ${expected('desktop').length - 1}`, 'delete asks or deletes');
  await ev(`const d = document.querySelector('#origin-remove-dialog'); if (d?.open) d.querySelector('#origin-remove-dialog-submit').click();`);
  await wait(`document.querySelectorAll('#origin-nav .origin-phase').length === ${expected('desktop').length - 1}`, 'category deleted');
  const lastPhase = desktopPhases.at(-1);
  const mix = async () => {
    await ev(`const m = document.querySelector('[data-nav="menu:phase:${lastPhase}"]').closest('details'); m.open = true; [...m.querySelectorAll('.origin-menu-item')].find(b => b.textContent === 'Add sections from a blueprint…').click();`);
    await wait(`document.querySelector('#origin-add-blueprint-dialog')?.open`, 'add from blueprint');
    await ev(`const s = document.querySelector('#origin-add-blueprint'); s.value = 'cli'; s.dispatchEvent(new Event('change', { bubbles: true }));`);
  };
  await mix();
  await wait(`[...document.querySelectorAll('.origin-add-blueprint-sections input')].some(i => i.value === 'distribution')`, 'CLI sections listed');
  await ev(`document.querySelector('.origin-add-blueprint-sections input[value="distribution"]').click(); document.querySelector('#origin-add-blueprint-dialog-submit').click();`);
  await wait(`[...document.querySelectorAll('.origin-nav-label')].some(n => n.textContent === 'Cross-Platform Support & Distribution')`, 'mixed-in section');
  await mix();
  await wait(`document.querySelector('.origin-add-blueprint-sections input[value="distribution"]')?.disabled === true`, 'already in the project: cannot be added twice');
  await ev(`document.querySelector('#origin-add-blueprint-dialog').close();`);
  await saved();

  // Save the agentic structure as a personal blueprint and start a project from it.
  const switchTo = name => ev(`const s = document.querySelector('#origin-project'); s.value = [...s.options].find(o => o.textContent === ${J(name)}).value; s.dispatchEvent(new Event('change', { bubbles: true }));`);
  await switchTo('Support agents');
  await wait(`document.querySelectorAll('#origin-nav .origin-phase').length === ${expected('agentic').length}`, 'agentic project');
  await ev(`document.querySelector('#origin-project-menu').open = true; [...document.querySelectorAll('#origin-project-menu .origin-menu-item')].find(b => b.textContent === 'Save structure as blueprint…').click();`);
  await wait(`document.querySelector('#origin-save-blueprint-dialog')?.open`, 'save dialog');
  await ev(`document.querySelector('#origin-save-blueprint-name').value = 'Our agent blueprint'; document.querySelector('#origin-save-blueprint-dialog-submit').click();`);
  await wait(`/Saved the blueprint/.test(document.querySelector('#announcement')?.textContent || '')`, 'saved blueprint');
  await ev(`document.querySelector('#origin-new-project').click();`);
  await wait(`document.querySelector('#origin-new-start .origin-blueprint-chip[data-category="saved"]')`, 'Saved chip');
  await ev(`document.querySelector('#origin-new-start .origin-blueprint-chip[data-category="saved"]').click();`);
  await wait(`document.querySelector(${J(card('#origin-new-start', 'saved'))})`, 'saved card');
  await ev(`document.querySelector(${J(card('#origin-new-start', 'saved'))}).click(); document.querySelector('#origin-new-name').value = 'Billing agents'; document.querySelector('#origin-new-kanban').checked = false; document.querySelector('#origin-new-dialog-submit').click();`);
  await wait(`document.querySelector('#origin-project').selectedOptions[0]?.textContent === 'Billing agents' && document.querySelectorAll('#origin-nav .origin-phase').length === ${expected('agentic').length}`, 'project from the saved blueprint');
  assert.deepEqual(await categories(), expected('agentic'));

  // Reload: every project keeps its own structure.
  await browser.reload();
  await wait(`document.querySelectorAll('#origin-nav .origin-phase').length > 0`, 'reloaded');
  for (const [name, id, delta] of [['Storefront', 'frontend-web', 0], ['Churn model', 'mlops', 0], ['Warehouse pipelines', 'data-platform', 0], ['Notes desktop', 'desktop', -1]]) {
    await switchTo(name);
    await wait(`document.querySelector('#origin-project').selectedOptions[0]?.textContent === ${J(name)} && document.querySelectorAll('#origin-nav .origin-phase').length === ${expected(id).length + delta}`, `${name} after reload`);
  }
  assert.ok((await read('Notes desktop')).customSections.some(section => section.title === 'Cross-Platform Support & Distribution'));
  assert.equal((await read('Storefront')).customSections.some(section => section.title === 'Cross-Platform Support & Distribution'), false, 'projects stay isolated');

  // Research knows the project type and the template's questions, and fills one of them.
  await switchTo('Churn model');
  await wait(`document.querySelectorAll('#origin-nav .origin-phase').length === ${expected('mlops').length}`, 'mlops project');
  const blueprint = await read('Churn model');
  const question = blueprint.questions.find(entry => /reproduced exactly/.test(entry.text));
  reply = () => `Pin everything.\n\n\`\`\`origin-suggestions\n${J({ suggestions: [{ title: 'Reproducible runs', target: { kind: 'answer', questionId: question.id }, value: 'Version data snapshots, code commit, parameters, environment image and seeds together.' }] })}\n\`\`\``;
  await ev(`document.querySelector('#origin-research-open').click();`);
  await wait(`document.querySelector('#origin-research-send') && !document.querySelector('#origin-research-send').disabled`, 'research ready');
  assert.ok((await ev(`return [...document.querySelectorAll('#origin-research-scope option')].map(o => o.textContent);`)).includes('Training & Evaluation › Training & Experiment Tracking'));
  await ev(`const i = document.querySelector('#origin-research-input'); i.value = 'How do we make training reproducible?'; i.dispatchEvent(new Event('input', { bubbles: true })); i.closest('form').requestSubmit();`);
  await wait(`document.querySelectorAll('.origin-research-proposal').length === 1`, 'suggestion');
  assert.match(prompts.at(-1), /Project type: Machine Learning \/ MLOps Platform/);
  assert.match(prompts.at(-1), /Typical research for a Machine Learning \/ MLOps Platform/);
  await ev(`[...document.querySelector('.origin-research-proposal').querySelectorAll('button')].find(b => b.textContent === 'Apply').click();`);
  await wait(`document.querySelector('.origin-research-proposal').dataset.status === 'applied'`, 'applied');
  await saved();
  assert.match((await read('Churn model')).answers[question.id], /Version data snapshots/);
  assert.deepEqual(browser.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);
});

test('saved blueprints that cannot be read are reported in the library instead of disappearing', { skip: !chrome, timeout: 120000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null });
  await mkdir(join(app.board.store.dir, 'origin'), { recursive: true });
  await writeFile(join(app.board.store.dir, 'origin', 'blueprints.json'), '{"version":1,"blueprints":[');
  const browser = await launch({ width: 1440, height: 1000 }); assert.ok(browser); t.after(() => browser.close());
  await browser.goto(`${app.url}/#/origin`);
  await browser.until(`document.querySelector('#origin-first-start [role=alert]:not([hidden])')`, 'the library says what happened', 15000);
  assert.match(await browser.eval(`return document.querySelector('#origin-first-start [role=alert]').textContent;`), /saved blueprints were damaged/);
  assert.ok(await browser.eval(`return document.querySelectorAll('#origin-first-start .origin-blueprint-card').length > 2;`), 'the library still works');
});
