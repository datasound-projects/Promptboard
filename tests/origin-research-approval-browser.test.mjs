import test from 'node:test';
import assert from 'node:assert/strict';
import { findChrome } from './helpers/browser.mjs';
import { researchPage } from './helpers/research.mjs';

const chrome = await findChrome();
const J = JSON.stringify;
const SUGGESTIONS = { suggestions: [
  { title: 'Explain PostgreSQL', why: 'Orders need transactions.', evidence: ['https://www.postgresql.org/docs/'], target: { kind: 'record', collection: 'technologies', id: 't1', field: 'reason' }, value: 'ACID transactions keep orders consistent.' },
  { title: 'Add a cache', why: 'Sessions are read often.', target: { kind: 'add', collection: 'technologies' }, value: { name: 'Redis', purpose: 'Session cache', status: 'candidate' } },
  { title: 'Answer: secrets', target: { kind: 'topic', section: 'security', area: 'secrets' }, value: 'Keys in the platform secret store' },
  { title: 'Sharper goal', target: { kind: 'vision', field: 'goal' }, value: 'Sell 1,000 handmade items a month' },
] };

test('Research suggestions: preview, edit, apply one, apply selected; a changed field is a conflict; nothing reaches Kanban', { skip: !chrome, timeout: 180000 }, async t => {
  const researchRunner = async call => ({ text: `Use PostgreSQL and add a cache.\n\n\`\`\`origin-suggestions\n${J(SUGGESTIONS)}\n\`\`\``, session: call.session?.id || 'thread-1' });
  const { app, browser, ev, wait, call, originId } = await researchPage(t, { server: { researchRunner }, blueprint: bp => {
    bp.vision.goal = 'Sell online';
    bp.technologies.push({ id: 't1', origin: 'human', name: 'PostgreSQL', category: 'database', purpose: 'Orders', version: '', status: 'candidate', reason: '', alternatives: '', sourceIds: [] });
  } });
  const click = selector => ev(`document.querySelector(${J(selector)}).click();`);
  const card = title => `[...document.querySelectorAll('.origin-research-proposal')].find(c => c.querySelector('strong')?.textContent === ${J(title)})`;
  const press = (title, label) => ev(`[...${card(title)}.querySelectorAll('button')].find(b => b.textContent === ${J(label)}).click();`);
  const saved = async () => { await wait(`document.querySelector('#origin-view').dataset.save === 'saved'`, 'saved'); return (await call(`/api/origin/projects/${originId}`)).blueprint; };

  await click('#origin-research-open');
  await wait(`document.querySelector('#origin-research-send') && !document.querySelector('#origin-research-send').disabled`, 'ready');
  await ev(`const i = document.querySelector('#origin-research-input'); i.value = 'How should we store data?'; i.dispatchEvent(new Event('input', { bubbles: true })); i.closest('form').requestSubmit();`);
  await wait(`document.querySelectorAll('.origin-research-proposal').length === 4`, 'four suggestion cards');
  assert.ok(!(await ev(`return document.querySelector('.origin-research-message.is-assistant').textContent;`)).includes('origin-suggestions'), 'the raw block is never shown');
  assert.equal(await ev(`return ${card('Explain PostgreSQL')}.querySelector('.origin-research-target').textContent;`), 'Technology “PostgreSQL” › reason');
  assert.equal(await ev(`return ${card('Answer: secrets')}.querySelector('.origin-research-target').textContent;`), 'Security › Secrets');

  // Preview, then apply one suggestion: the exact field changes and is saved through Origin.
  await press('Explain PostgreSQL', 'Preview');
  await wait(`${card('Explain PostgreSQL')}.querySelector('.origin-research-diff .is-old')?.textContent === '(empty)' && ${card('Explain PostgreSQL')}.querySelector('.is-new').textContent === 'ACID transactions keep orders consistent.'`, 'preview');
  await press('Explain PostgreSQL', 'Apply');
  await wait(`${card('Explain PostgreSQL')}.dataset.status === 'applied'`, 'applied');
  let blueprint = await saved();
  assert.equal(blueprint.technologies.find(entry => entry.id === 't1').reason, 'ACID transactions keep orders consistent.');
  assert.equal(blueprint.technologies.find(entry => entry.id === 't1').origin, 'human', 'an existing record keeps its origin');

  // Edit the new record, then apply two suggestions together.
  await press('Add a cache', 'Edit');
  await wait(`${card('Add a cache')}.querySelector('.origin-research-edit')`, 'editor');
  await ev(`const e = ${card('Add a cache')}.querySelector('.origin-research-edit'); e.value = 'name: Redis\\npurpose: Session and cart cache\\nstatus: candidate'; e.dispatchEvent(new Event('input', { bubbles: true }));`);
  for (const title of ['Add a cache', 'Answer: secrets']) await ev(`const c = ${card(title)}.querySelector('input[type=checkbox]'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true }));`);
  await wait(`document.querySelector('#origin-research-apply-selected')?.textContent === 'Apply selected (2)'`, 'two selected');
  await click('#origin-research-apply-selected');
  await wait(`${card('Add a cache')}.dataset.status === 'applied' && ${card('Answer: secrets')}.dataset.status === 'applied'`, 'both applied');
  blueprint = await saved();
  const redis = blueprint.technologies.find(entry => entry.name === 'Redis');
  assert.deepEqual([redis.purpose, redis.status, redis.origin], ['Session and cart cache', 'candidate', 'ai'], 'the edit is applied and marked as an AI suggestion');
  assert.equal(blueprint.areas.find(entry => entry.section === 'security' && entry.area === 'secrets').title, 'Keys in the platform secret store');

  // The person changes the goal after the research: applying is a conflict, and Keep mine keeps their text.
  await ev(`document.querySelector('.origin-nav-item[data-section="vision"]').click();`);
  await wait(`[...document.querySelectorAll('#origin-main textarea')].length > 0`, 'vision');
  await ev(`const area = [...document.querySelectorAll('#origin-main textarea')].find(a => a.value === 'Sell online'); area.value = 'Sell to EU customers'; area.dispatchEvent(new Event('input', { bubbles: true }));`);
  await saved();
  await click('#origin-research-open');
  await wait(`${card('Sharper goal')}`, 'cards again');
  await press('Sharper goal', 'Apply');
  await wait(`${card('Sharper goal')}.dataset.status === 'conflict' && /changed after the research ran/.test(${card('Sharper goal')}.textContent)`, 'conflict shown');
  assert.equal((await saved()).vision.goal, 'Sell to EU customers', 'a changed field is never overwritten');
  await press('Sharper goal', 'Keep mine');
  await wait(`${card('Sharper goal')}.dataset.status === 'rejected'`, 'kept mine');

  // Origin's own views show the applied records; Kanban received nothing.
  await ev(`document.querySelector('.origin-nav-item[data-section="technology"]').click();`);
  await wait(`[...document.querySelectorAll('#origin-main .origin-row-title')].some(n => n.textContent.includes('Redis'))`, 'Redis in the Technology section');
  assert.deepEqual((await app.board.state()).projects.flatMap(project => project.tasks), [], 'no Kanban card or run');

  // After a reload, the chat shows every suggestion with its state.
  await browser.reload();
  await wait(`!document.querySelector('#origin-research-open').hidden`, 'reloaded');
  await click('#origin-research-open');
  await click('#origin-research-history');
  await wait(`document.querySelector('.origin-research-chat-open')`, 'history');
  assert.match(await ev(`return document.querySelector('.origin-research-chat small').textContent;`), /2 messages/);
  await click('.origin-research-chat-open');
  await wait(`document.querySelectorAll('.origin-research-proposal').length === 4`, 'cards restored');
  assert.deepEqual(await ev(`return [...document.querySelectorAll('.origin-research-proposal')].map(c => c.dataset.status);`), ['applied', 'applied', 'applied', 'rejected']);
  assert.deepEqual(browser.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);
});
