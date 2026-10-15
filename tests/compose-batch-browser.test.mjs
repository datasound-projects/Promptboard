import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/origin-model.js';
import { OriginStore } from '../src/origin.mjs';
import { REVIEW_CRITERIA } from '../src/pipeline.mjs';
import { launch, findChrome } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const Model = globalThis.PromptboardOriginModel;
const skip = !(await findChrome());
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A stand-in CLI: drafts keep every line (except one task's file path), reviews confirm every unit. Drafts wait at `gate`. */
let open;
const gate = new Promise(resolve => { open = resolve; });
async function runner(call) {
  await pause(60);
  if (call.prompt.startsWith('# Review task')) {
    const data = JSON.parse(call.prompt.split('# Review data\n')[1]);
    return { text: JSON.stringify({ covered: data.units.map(unit => unit.id), requirements: [], criteria: Object.fromEntries(REVIEW_CRITERIA.map(name => [name, 'pass'])), issues: [] }) };
  }
  if (call.prompt.includes('\n# Revision task\n')) return { text: JSON.parse(call.prompt.split('# Revision data\n')[1]).previousDraft };
  const request = JSON.parse(call.prompt.split('# Source data\n')[1]).request, lines = request.split('\n');
  if (/^IMP-00\d /.test(request)) await gate;
  const text = `# Goal\n${lines.filter(line => !line.startsWith('Done when:')).join('\n')}\n\n# Acceptance checks\n${lines.filter(line => line.startsWith('Done when:')).map(line => `- ${line.slice(11)}`).join('\n')}`;
  return { text: request.includes('IMP-003') ? text.replace('`src/cart.js`', 'the cart file') : text };
}

test('Compose Batch: Origin selection → parallel generation → review and edit → approval → Kanban, with Single intact', { skip, timeout: 180000 }, async t => {
  const calls = [];
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [{ id: 'codex', available: true }], authAdapter: { installed: async () => true, status: async () => ({ state: 'signed-in' }) },
    runner: async call => { calls.push(call); return runner(call); } });
  const store = new OriginStore(app.board.store.dir);
  let record = await store.create({ name: 'Web shop' });
  const kanban = await app.board.createProject({ name: 'Web shop', workflowMode: 'pipeline' });
  record = await store.link(record.id, { expectedRevision: record.revision, kanbanProjectId: kanban.id });
  const blueprint = Model.emptyBlueprint();
  [['Set up the project', 'Create a Node.js project with `npm test`.', 'npm test runs', []],
    ['Product catalog', 'List products from `data/products.json`.', 'GET /products returns all products', ['i1']],
    ['Shopping cart', 'Keep the cart in `src/cart.js`. Totals use integer cents.', 'Adding an item updates the total', ['i2']],
    ['Checkout', 'Validate the address and create an order.', 'An order is saved with status pending', ['i3']],
    ['Admin login', 'Protect /admin with a password from the environment.', 'Wrong passwords return 401', ['i1']]]
    .forEach(([title, description, acceptanceCriteria, dependsOn], index) => blueprint.items.push({ id: `i${index + 1}`, key: `IMP-00${index + 1}`, title, description, acceptanceCriteria, dependsOn }));
  blueprint.sequence = { items: 5 };
  record = await store.write(record.id, { expectedRevision: record.revision, blueprint });

  const browser = await launch(); if (!browser) { t.skip('Chrome did not start.'); return; } t.after(() => browser.close());
  const errors = [];
  browser.on(message => { if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text); });
  await browser.send('Runtime.enable');
  await browser.resize(1360, 900);
  const ev = expression => browser.eval(expression), until = (expression, label, ms = 30000) => browser.until(expression, label, ms);
  const row = key => `[...document.querySelectorAll('.batch-row-main')].find(node => node.textContent.includes(${JSON.stringify(key)}))`;
  const chipOf = key => ev(`return ${row(key)}.querySelector('.batch-chip').textContent;`);

  // Origin: select every task and send them; Compose opens in Batch mode with the tasks pending.
  await browser.goto(`${app.url}/#/origin`);
  await until(`!!document.querySelector('.origin-nav-item[data-section="plan"]')`, 'Origin');
  await ev(`document.querySelector('.origin-nav-item[data-section="plan"]').click();`);
  await until(`!!document.querySelector('#origin-select-drafts')`, 'tasks');
  await ev(`document.querySelector('#origin-select-drafts').click();`);
  await until(`document.querySelector('#origin-send-compose')?.textContent.includes('Send 5 tasks to Compose')`, 'send button');
  await ev(`document.querySelector('#origin-send-compose').click();`);
  await until(`location.hash === '#/' && !document.querySelector('#batch-view').hidden && document.querySelectorAll('.batch-row').length === 5`, 'batch opened');
  assert.equal(await ev(`return document.querySelector('#compose-mode-batch').getAttribute('aria-selected');`), 'true');
  assert.equal(await ev(`return getComputedStyle(document.querySelector('#prompt-form')).display;`), 'none', 'Single mode is hidden in Batch mode.');
  assert.deepEqual(await ev(`return [...document.querySelectorAll('.batch-row .batch-key')].map(node => node.textContent);`), ['IMP-001', 'IMP-002', 'IMP-003', 'IMP-004', 'IMP-005'], 'Build order.');
  assert.equal(calls.length, 0, 'Sending to Compose runs nothing.');
  // Sending the same selection again duplicates nothing.
  await ev(`location.hash = '#/origin';`);
  await until(`!!document.querySelector('#origin-send-compose')`, 'back in Origin');
  await ev(`document.querySelector('#origin-send-compose').click();`);
  await until(`location.hash === '#/' && document.querySelectorAll('.batch-row').length === 5`, 'same batch');

  // Mode switch by keyboard, and back.
  await ev(`document.querySelector('#compose-mode-batch').focus();`);
  await browser.key('ArrowLeft', 'ArrowLeft', 37);
  await until(`document.querySelector('#batch-view').hidden && getComputedStyle(document.querySelector('#prompt-form')).display !== 'none' && document.activeElement.id === 'compose-mode-single'`, 'single by keyboard');
  await ev(`document.querySelector('#compose-mode-batch').click();`);
  await until(`!document.querySelector('#batch-view').hidden && document.querySelectorAll('.batch-row').length === 5`, 'batch again');

  // Run all: tasks run a few at a time; one keeps a blocking finding.
  await ev(`document.querySelector('#batch-run-all').click();`);
  await until(`[...document.querySelectorAll('.batch-row .batch-chip')].filter(node => node.textContent === 'Running').length === 3 && [...document.querySelectorAll('.batch-row .batch-chip')].filter(node => node.textContent === 'Queued').length === 2`, 'three running, two queued');
  open();
  await until(`[...document.querySelectorAll('.batch-row .batch-chip')].every(node => !/Running|Queued/.test(node.textContent))`, 'settled', 60000);
  assert.equal(await chipOf('IMP-003'), 'Needs review');
  assert.equal(await chipOf('IMP-001'), 'Generated');
  assert.equal(new Set(calls.map(call => call.cwd)).size, calls.length, 'Every call had its own folder.');

  // Approve passing takes the four clean tasks; the blocked one cannot be approved.
  await until(`document.querySelector('#batch-approve-passing')?.textContent === 'Approve passing (4)'`, 'passing count');
  await ev(`document.querySelector('#batch-approve-passing').click();`);
  await until(`document.querySelector('#batch-send')?.textContent === 'Send 4 to Kanban'`, 'four approved');
  await ev(`${row('IMP-003')}.click();`);
  await until(`document.querySelector('.batch-inspector h3')?.textContent.includes('Shopping cart') && !!document.querySelector('#batch-approve')`, 'inspector');
  assert.equal(await ev(`return document.querySelector('#batch-approve').disabled;`), true);
  assert.match(await ev(`return document.querySelector('.batch-finding.blocking').textContent;`), /src\/cart\.js/);
  // Fix the literal by hand: a new version, checked again, approvable after reading.
  await ev(`const text = document.querySelector('#batch-prompt'); text.focus(); text.value = text.value.replace('the cart file', '\`src/cart.js\`'); text.dispatchEvent(new Event('input', { bubbles: true }));`);
  await until(`!document.querySelector('#batch-save-edit').hidden`, 'dirty');
  await ev(`document.querySelector('#batch-save-edit').click();`);
  await until(`document.querySelector('.batch-facts')?.textContent.includes('Version 2') && !document.querySelector('#batch-approve').disabled`, 'edited version');
  assert.match(await ev(`return document.querySelector('.batch-findings').textContent;`), /not been reviewed by the model/);
  await ev(`document.querySelector('#batch-approve').click();`);
  await until(`document.querySelector('#batch-send')?.textContent === 'Send 5 to Kanban'`, 'five approved');

  // Keyboard moves through the queue.
  await ev(`${row('IMP-001')}.focus();`);
  await browser.key('ArrowDown', 'ArrowDown', 40);
  await until(`document.activeElement.classList.contains('batch-row-main') && document.activeElement.getAttribute('aria-current') === 'true' && document.activeElement.textContent.includes('IMP-002')`, 'arrow down');

  // Kanban: approved prompts, in prerequisite order, once.
  await ev(`document.querySelector('#batch-send').click();`);
  await until(`document.querySelector('.batch-success')?.textContent.includes('5 cards added')`, 'sent');
  const cards = (await app.board.view()).projects.find(project => project.id === kanban.id).tasks, byKey = Object.fromEntries(cards.map(card => [card.originSource.key, card]));
  assert.equal(cards.length, 5);
  assert.deepEqual(byKey['IMP-004'].dependsOn, [byKey['IMP-003'].id]);
  assert.match(byKey['IMP-003'].prompt, /^# Goal\nIMP-003 Shopping cart\nKeep the cart in `src\/cart\.js`/);
  await until(`[...document.querySelectorAll('.batch-row .batch-chip')].every(node => node.textContent === 'On Kanban') && document.querySelector('#batch-send').disabled`, 'all on Kanban');

  // Phones: one column, nothing wider than the page.
  await browser.resize(390, 844);
  assert.equal(await browser.layout(`return getComputedStyle(document.querySelector('.batch-grid')).gridTemplateColumns.split(' ').length === 1 && document.querySelector('.batch-grid').getBoundingClientRect().right <= document.documentElement.clientWidth + 1;`), true);
  await browser.resize(1360, 900);

  // Single mode still writes one prompt as before.
  await ev(`document.querySelector('#compose-mode-single').click();`);
  await until(`!document.querySelector('#generate-button').disabled`, 'single ready');
  await ev(`const input = document.querySelector('#prompt-input'); input.value = 'Add a dark mode toggle to the settings page.'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[name="quality"][value="fast"]').click(); document.querySelector('#generate-button').click();`);
  await until(`!document.querySelector('#prompt-output').hidden && document.querySelector('#prompt-output').textContent.includes('Add a dark mode toggle')`, 'single generated');
  assert.deepEqual(errors, []);
});
