// Origin page fixes in real Chrome: the whole prerequisite chain is shown before sending, a deleted prerequisite card
// is created again only when asked, text too long to store is shown as stored, a project deleted elsewhere does not trap
// the window, one connection per pair, and an assumption whose decision is deleted is open again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';
import { OriginStore } from '../src/origin.mjs';

const J = JSON.stringify;

test('Origin: prerequisite chains, deleted prerequisite cards, stored text, deleted projects, connections and assumptions', { skip: !await findChrome(), timeout: 180000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const kanban = await app.board.createProject({ name: 'Shop', workflowMode: 'pipeline' });
  const store = new OriginStore(app.board.store.dir);
  let shop = await store.create({ name: 'Shop design' });
  shop = await store.link(shop.id, { expectedRevision: 1, kanbanProjectId: kanban.id });
  await store.write(shop.id, { expectedRevision: shop.revision, blueprint: { idea: 'Shop',
    components: [{ id: 'c1', name: 'Web', type: 'frontend' }, { id: 'c2', name: 'API', type: 'api' }],
    decisions: [{ id: 'd1', title: 'Use Postgres', status: 'accepted' }],
    assumptions: [{ id: 'a1', statement: 'Traffic stays small', status: 'converted', decisionId: 'd1' }],
    items: [{ id: 'i1', key: 'IMP-001', title: 'Schema', acceptanceCriteria: 'Tables exist' }, { id: 'i2', key: 'IMP-002', title: 'Orders API', acceptanceCriteria: 'Orders', dependsOn: ['i1'] },
      { id: 'i3', key: 'IMP-003', title: 'Checkout', acceptanceCriteria: 'Pay', dependsOn: ['i2'] }, { id: 'i4', key: 'IMP-004', title: 'Reports', acceptanceCriteria: 'Totals', dependsOn: ['i1'] }], sequence: { items: 4 } } });
  const other = await store.create({ name: 'Other design' });
  const browser = await launch({ width: 1280, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  const ev = code => browser.eval(code), wait = (expression, label, ms = 10000) => browser.until(expression, label, ms);
  const saved = () => wait(`document.querySelector('#origin-view').dataset.save === 'saved'`, 'saved', 15000);
  const section = id => ev(`document.querySelector('.origin-nav-item[data-section=${J(id)}]').click();`);
  const check = key => ev(`[...document.querySelectorAll('#origin-main .origin-row')].find(r => r.textContent.includes(${J(key)})).querySelector('.origin-check').click();`);
  const openRow = text => ev(`[...document.querySelectorAll('#origin-main .origin-row-open')].find(b => b.textContent.includes(${J(text)})).click();`);
  await browser.goto(`${app.url}/#/origin`);
  await ev(`localStorage.setItem('promptboard.origin.project', ${J(shop.id)});`);
  await browser.reload();
  await wait(`document.querySelector('.origin-map')`, 'map');

  // The whole chain: IMP-003 needs IMP-002, which needs IMP-001. Both are named, and three cards are sent.
  await section('plan'); await wait(`document.querySelector('#origin-main .origin-check')`, 'tasks');
  await check('IMP-003');
  await ev(`document.querySelector('#origin-kanban-handoff').click();`);
  await wait(`document.querySelector('#origin-handoff-dialog')?.open`, 'review panel');
  assert.match(await ev(`return document.querySelector('#origin-handoff-dialog .origin-handoff-prerequisites').textContent;`), /Include prerequisites: IMP-001 Schema, IMP-002 Orders API/);
  await ev(`document.querySelector('#origin-handoff-prerequisites').click();`);
  assert.equal(await ev(`return document.querySelector('#origin-handoff-confirm').textContent;`), 'Send 3 tasks');
  await ev(`document.querySelector('#origin-handoff-confirm').click();`);
  await wait(`!document.querySelector('#origin-handoff-dialog .origin-handoff-results').hidden`, 'results', 15000);
  assert.equal((await app.board.view()).projects[0].tasks.length, 3);
  await ev(`document.querySelector('#origin-handoff-dialog').close();`);

  // IMP-001's card is deleted in Kanban; sending IMP-004 (after IMP-001) asks whether to create it again.
  const schema = (await app.board.view()).projects[0].tasks.find(task => task.title.startsWith('IMP-001'));
  await app.board.deleteTask(schema.id, { expectedRevision: schema.revision });
  await browser.reload(); await wait(`document.querySelector('.origin-nav-item[data-section="plan"]')`, 'reloaded');
  await section('plan'); await wait(`document.querySelector('#origin-main .origin-check')`, 'tasks');
  await check('IMP-004');
  await ev(`document.querySelector('#origin-kanban-handoff').click();`);
  await wait(`document.querySelector('#origin-handoff-dialog')?.open && /Create IMP-001 again/.test(document.querySelector('#origin-handoff-dialog .origin-handoff-prerequisites').textContent)`, 'recreate choice');
  await ev(`document.querySelector('#origin-handoff-prerequisites').click();`);
  assert.equal(await ev(`return document.querySelector('#origin-handoff-confirm').disabled;`), true, 'a deleted card is never created again silently');
  await ev(`[...document.querySelectorAll('#origin-handoff-dialog .origin-handoff-prerequisites input')].at(-1).click();`);
  assert.deepEqual(await ev(`const b = document.querySelector('#origin-handoff-confirm'); return [b.disabled, b.textContent];`), [false, 'Send 2 tasks']);
  await ev(`document.querySelector('#origin-handoff-confirm').click();`);
  await wait(`!document.querySelector('#origin-handoff-dialog .origin-handoff-results').hidden`, 'results', 15000);
  assert.deepEqual((await app.board.view()).projects[0].tasks.map(task => task.title.slice(0, 7)).sort(), ['IMP-001', 'IMP-002', 'IMP-003', 'IMP-004']);
  await ev(`document.querySelector('#origin-handoff-dialog').close();`);

  // Text longer than a field can hold: the page shows what was stored, and says so.
  await openRow('IMP-004');
  await wait(`!document.querySelector('#origin-drawer').hidden`, 'editor');
  await ev(`const f = [...document.querySelectorAll('#origin-drawer .origin-field')].find(f => f.querySelector('.origin-field-label')?.textContent === 'What to do'); const c = f.querySelector('textarea'); c.value = 'x'.repeat(25000); c.dispatchEvent(new Event('input', { bubbles: true }));`);
  await saved();
  await wait(`/shortened or removed when saved/.test(document.querySelector('#origin-view').textContent)`, 'notice');
  assert.equal((await store.read(shop.id)).blueprint.items.find(item => item.id === 'i4').description.length, 20000);

  // One connection per pair: once Web calls API, the picker no longer offers API.
  await section('architecture'); await wait(`document.querySelector('#origin-main .origin-row-open')`, 'components');
  await openRow('Web');
  await wait(`document.querySelector('#origin-drawer select[aria-label="Connect to a component"]')`, 'connect picker');
  await ev(`const s = document.querySelector('#origin-drawer select[aria-label="Connect to a component"]'); s.value = 'c2'; s.dispatchEvent(new Event('change', { bubbles: true }));`);
  await saved();
  assert.equal(await ev(`return Boolean(document.querySelector('#origin-drawer select[aria-label="Connect to a component"]'));`), false, 'nothing left to connect to');
  assert.equal((await store.read(shop.id)).blueprint.connections.length, 1);

  // Deleting the decision an assumption was turned into opens the assumption again.
  await section('decisions'); await wait(`document.querySelector('#origin-main .origin-row-open')`, 'decisions');
  await openRow('Use Postgres');
  await wait(`[...document.querySelectorAll('#origin-drawer button')].some(b => b.textContent === 'Delete')`, 'delete');
  await ev(`[...document.querySelectorAll('#origin-drawer button')].find(b => b.textContent === 'Delete').click();`);
  await ev(`[...document.querySelectorAll('#origin-drawer button')].find(b => b.classList.contains('danger')).click();`);
  await saved();
  assert.deepEqual((await store.read(shop.id)).blueprint.assumptions.map(entry => [entry.status, entry.decisionId]), [['open', '']]);

  // Deleted in another window while this one has an edit: no trap, another project can be opened.
  const current = await store.read(shop.id);
  const { token } = await (await fetch(`${app.url}/api/session`)).json();
  const gone = await fetch(`${app.url}/api/origin/projects/${shop.id}/delete`, { method: 'POST', headers: { 'X-STE-Token': token, 'Content-Type': 'application/json' }, body: J({ expectedRevision: current.revision }) });
  assert.equal(gone.status, 200);
  await section('vision'); await wait(`document.querySelector('#origin-main textarea')`, 'vision');
  await ev(`const t = document.querySelector('#origin-main textarea'); t.value = 'Edited after delete'; t.dispatchEvent(new Event('input', { bubbles: true }));`);
  await wait(`document.querySelector('#origin-view').dataset.save === 'gone'`, 'deleted elsewhere', 15000);
  assert.match(await ev(`return document.querySelector('#origin-view').textContent;`), /deleted in another window/);
  await ev(`const s = document.querySelector('#origin-project'); s.value = ${J(other.id)}; s.dispatchEvent(new Event('change', { bubbles: true }));`);
  await wait(`document.querySelector('#origin-project').value === ${J(other.id)} && document.querySelector('#origin-view').dataset.save === 'saved'`, 'switched project');
  assert.deepEqual(browser.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);
});

test('Origin: after "Deleted in another window" the project selector offers only projects that exist', { skip: !await findChrome(), timeout: 90000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const store = new OriginStore(app.board.store.dir);
  const shop = await store.create({ name: 'Shop design' }), other = await store.create({ name: 'Other design' });
  const browser = await launch({ width: 1280, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  const ev = code => browser.eval(code), wait = (expression, label, ms = 10000) => browser.until(expression, label, ms);
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('promptboard.origin.project', ${J(shop.id)}); localStorage.setItem('promptboard.origin.section', 'vision');` });
  await browser.goto(`${app.url}/#/origin`);
  await wait(`document.querySelector('#origin-project').value === ${J(shop.id)} && document.querySelector('#origin-main textarea')`, 'Vision of Shop design');
  const { token } = await (await fetch(`${app.url}/api/session`)).json();
  const gone = await fetch(`${app.url}/api/origin/projects/${shop.id}/delete`, { method: 'POST', headers: { 'X-STE-Token': token, 'Content-Type': 'application/json' }, body: J({ expectedRevision: shop.revision }) });
  assert.equal(gone.status, 200);
  await ev(`const t = document.querySelector('#origin-main textarea'); t.value = 'Edited after delete'; t.dispatchEvent(new Event('input', { bubbles: true }));`);
  await wait(`document.querySelector('#origin-view').dataset.save === 'gone'`, 'deleted elsewhere', 15000);
  await wait(`document.querySelector('#origin-project').options.length === 1`, 'the list is read again');
  assert.deepEqual(await ev(`const s = document.querySelector('#origin-project'); return [[...s.options].map(o => o.textContent), s.hidden, document.querySelector('#origin-project-menu').hidden];`), [['Other design'], false, true],
    'the deleted project is gone from the selector and its menu, and another one can be chosen');
  await ev(`const s = document.querySelector('#origin-project'); s.value = ${J(other.id)}; s.dispatchEvent(new Event('change', { bubbles: true }));`);
  await wait(`document.querySelector('#origin-project').value === ${J(other.id)} && document.querySelector('#origin-view').dataset.save === 'saved'`, 'switched project');
});
