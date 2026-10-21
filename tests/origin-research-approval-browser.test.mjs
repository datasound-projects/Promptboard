import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { escapeId } from '../src/origin.mjs';
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

test('Apply all: one answer adds a layer, components, a connection and dependent tasks; the architecture diagram and Tasks show them', { skip: !chrome, timeout: 180000 }, async t => {
  const batch = { suggestions: [
    { ref: 'api', title: 'Order API', target: { kind: 'add', collection: 'components' }, value: { name: 'Order API', type: 'api', purpose: 'Takes orders', layerId: '@back' } },
    { ref: 'db', title: 'Orders database', target: { kind: 'add', collection: 'components' }, value: { name: 'Orders database', type: 'database', purpose: 'Stores orders', layerId: '@back' } },
    { ref: 'back', title: 'Backend layer', target: { kind: 'add', collection: 'layers' }, value: { name: 'Backend' } },
    { title: 'API writes orders', target: { kind: 'add', collection: 'connections' }, value: { from: '@api', to: '@db', label: 'writes', protocol: 'SQL' } },
    { ref: 't2', title: 'Order endpoints', target: { kind: 'add', collection: 'items' }, value: { title: 'Order endpoints', acceptanceCriteria: 'POST /orders stores an order', componentIds: ['@api'], dependsOn: ['@t1'] } },
    { ref: 't1', title: 'Orders schema', target: { kind: 'add', collection: 'items' }, value: { title: 'Orders schema', acceptanceCriteria: 'Migration creates the orders table', componentIds: ['@db'] } },
  ] };
  const researchRunner = async call => ({ text: `Plan for orders.\n\n\`\`\`origin-suggestions\n${J(batch)}\n\`\`\``, session: call.session?.id || 'thread-1' });
  const { ev, wait, call, originId } = await researchPage(t, { server: { researchRunner } });
  await ev(`document.querySelector('#origin-research-open').click();`);
  await wait(`document.querySelector('#origin-research-send') && !document.querySelector('#origin-research-send').disabled`, 'ready');
  await ev(`const i = document.querySelector('#origin-research-input'); i.value = 'Design the order flow'; i.dispatchEvent(new Event('input', { bubbles: true })); i.closest('form').requestSubmit();`);
  await wait(`document.querySelector('#origin-research-apply-all')?.textContent === 'Apply all (6)'`, 'Apply all offered');
  // Cards name links by the records they point to, new ones marked.
  await ev(`[...document.querySelectorAll('.origin-research-proposal')].find(c => c.textContent.includes('Order endpoints')).querySelector('button').click();`);
  await wait(`/componentIds: Order API \\(new\\)[\\s\\S]*dependsOn: Orders schema \\(new\\)/.test([...document.querySelectorAll('.origin-research-proposal')].find(c => c.textContent.includes('Order endpoints')).querySelector('.is-new')?.textContent || '')`, 'preview names linked records');
  await ev(`document.querySelector('#origin-research-apply-all').click();`);
  await wait(`[...document.querySelectorAll('.origin-research-proposal')].every(c => c.dataset.status === 'applied')`, 'all applied');
  await wait(`document.querySelector('#origin-view').dataset.save === 'saved'`, 'saved');
  const bp = (await call(`/api/origin/projects/${originId}`)).blueprint;
  const id = name => bp.components.find(entry => entry.name === name)?.id;
  assert.deepEqual(bp.connections.map(entry => [entry.from, entry.to, entry.label]), [[id('Order API'), id('Orders database'), 'writes']]);
  const layer = bp.layers.find(entry => entry.name === 'Backend').id;
  assert.deepEqual([bp.components.find(entry => entry.name === 'Order API').layerId, bp.components.find(entry => entry.name === 'Orders database').layerId], [layer, layer]);
  const schema = bp.items.find(entry => entry.title === 'Orders schema'), endpoints = bp.items.find(entry => entry.title === 'Order endpoints');
  assert.deepEqual([endpoints.dependsOn, endpoints.componentIds, schema.componentIds], [[schema.id], [id('Order API')], [id('Orders database')]]);
  // Origin's own views show the result: the canvas edge and the tasks with their prerequisite.
  await ev(`document.querySelector('.origin-nav-item[data-section="architecture"]').click();`);
  await wait(`document.querySelectorAll('#origin-main svg path[data-from], #origin-main .origin-edge, #origin-main svg line').length > 0 || /writes/.test(document.querySelector('#origin-main').textContent)`, 'connection on the architecture canvas');
  await ev(`document.querySelector('.origin-nav-item[data-section="plan"]').click();`);
  await wait(`/Order endpoints/.test(document.querySelector('#origin-main').textContent) && /Orders schema/.test(document.querySelector('#origin-main').textContent)`, 'tasks listed');
});

test('Apply, Reject and Preview keep the chat where you are reading, and keep focus on that card', { skip: !chrome, timeout: 120000 }, async t => {
  const many = { suggestions: Array.from({ length: 14 }, (_, index) => ({ title: `Risk ${index + 1}`, why: 'Found while reading the design. '.repeat(3), target: { kind: 'add', collection: 'risks' }, value: { title: `Risk ${index + 1}` } })) };
  const researchRunner = async call => ({ text: `Findings.\n\n\`\`\`origin-suggestions\n${J(many)}\n\`\`\``, session: call.session?.id || 'thread-1' });
  const { ev, wait } = await researchPage(t, { height: 800, server: { researchRunner } });
  await ev(`document.querySelector('#origin-research-open').click();`);
  await wait(`document.querySelector('#origin-drawer')?.dataset.mode === 'research'`, 'research');
  await ev(`const i = document.querySelector('#origin-research-input'); i.value = 'Find risks'; i.form.requestSubmit();`);
  await wait(`document.querySelectorAll('.origin-research-proposal').length === 14`, 'suggestions', 30000);
  const body = `document.querySelector('#origin-research-body')`, card = n => `[...document.querySelectorAll('.origin-research-proposal')].find(c => c.querySelector('strong').textContent === 'Risk ${n}')`;
  // Read near the end, then decide on cards there: the list must not jump back to the top.
  await ev(`${card(12)}.scrollIntoView({ block: 'center' });`);
  const before = await ev(`return ${body}.scrollTop;`);
  assert.ok(before > 400, `the chat is scrolled down (${before})`);
  for (const [n, action] of [[12, 'Apply'], [13, 'Reject'], [11, 'Preview']]) {
    await ev(`const b = [...${card(n)}.querySelectorAll('button')].find(b => b.textContent === ${J(action)}); b.focus(); b.click();`);
    await wait(`${action === 'Preview' ? `${card(n)}.querySelector('.origin-research-diff')` : `${card(n)}.dataset.status === ${J(action === 'Apply' ? 'applied' : 'rejected')}`}`, `${action} on risk ${n}`);
    const now = await ev(`return ${body}.scrollTop;`);
    assert.ok(Math.abs(now - before) < 200, `${action} keeps the position (${before} → ${now})`);
    assert.equal(await ev(`return ${card(n)}.contains(document.activeElement);`), true, `${action}: focus stays on the card`);
  }
});

test('Apply all stops when another project opens: nothing lands in that project, what was applied is saved, the rest stays pending', { skip: !chrome, timeout: 180000 }, async t => {
  const names = ['Alpha cache', 'Beta queue', 'Gamma search', 'Delta mail'];
  const batch = { suggestions: names.map(name => ({ title: name, target: { kind: 'add', collection: 'technologies' }, value: { name, purpose: 'Test', status: 'candidate' } })) };
  const researchRunner = async call => ({ text: `Options.\n\n\`\`\`origin-suggestions\n${J(batch)}\n\`\`\``, session: call.session?.id || 'thread-1' });
  const { ev, wait, call, originId } = await researchPage(t, { server: { researchRunner } });
  const other = (await call('/api/origin/projects', 'POST', { name: 'Other' })).project.id;
  await ev(`location.hash = '#/kanban';`); await wait(`!document.querySelector('#origin-view') || document.querySelector('#origin-view').hidden`, 'left Origin');
  await ev(`location.hash = '#/origin';`); await wait(`[...document.querySelectorAll('#origin-project option')].some(o => o.value === ${J(other)})`, 'both projects listed');
  await ev(`document.querySelector('#origin-research-open').click();`);
  await wait(`document.querySelector('#origin-research-send') && !document.querySelector('#origin-research-send').disabled`, 'ready');
  await ev(`const i = document.querySelector('#origin-research-input'); i.value = 'Which services?'; i.dispatchEvent(new Event('input', { bubbles: true })); i.closest('form').requestSubmit();`);
  await wait(`document.querySelector('#origin-research-apply-all')?.textContent === 'Apply all (4)'`, 'Apply all offered');
  // The first decision is held until the other project is open, so the switch lands in the middle of the batch.
  await ev(`const f = window.fetch; window.__held = []; window.fetch = (url, options) => options?.method === 'PATCH' && /proposals/.test(url) ? new Promise(r => window.__held.push(r)).then(() => f(url, options)) : f(url, options);`);
  await ev(`document.querySelector('#origin-research-apply-all').click();`);
  await wait(`window.__held.length === 1`, 'first decision on its way');
  await ev(`const s = document.querySelector('#origin-project'); s.value = ${J(other)}; s.dispatchEvent(new Event('change'));`);
  await wait(`document.querySelector('#origin-project').value === ${J(other)} && document.querySelector('#origin-view').dataset.save === 'saved' && document.querySelector('#origin-main').textContent.length > 0`, 'Other open');
  await ev(`window.__held.shift()();`);
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(await ev(`return window.__held.length`), 0, 'no further decision was sent');
  const tech = async id => (await call(`/api/origin/projects/${id}`)).blueprint.technologies.map(entry => entry.name);
  assert.deepEqual((await tech(other)).filter(name => names.includes(name)), [], 'nothing from the other project’s chat');
  assert.deepEqual((await tech(originId)).filter(name => names.includes(name)), ['Alpha cache'], 'the suggestion applied before the switch is saved');
  const [{ id: chatId }] = (await call(`/api/origin/research/${originId}/chats`)).chats;
  const { chat } = await call(`/api/origin/research/${originId}/chats/${chatId}`);
  assert.deepEqual(chat.proposals.map(entry => entry.status), ['applied', 'pending', 'pending', 'pending']);
});

test('a link to a record that is applied after a reload is still completed', { skip: !chrome, timeout: 180000 }, async t => {
  const batch = { suggestions: [
    { ref: 't2', title: 'Order endpoints', target: { kind: 'add', collection: 'items' }, value: { title: 'Order endpoints', acceptanceCriteria: 'POST /orders works', dependsOn: ['@t1'] } },
    { ref: 't1', title: 'Orders schema', target: { kind: 'add', collection: 'items' }, value: { title: 'Orders schema', acceptanceCriteria: 'The table exists' } },
  ] };
  const researchRunner = async call => ({ text: `Plan.\n\n\`\`\`origin-suggestions\n${J(batch)}\n\`\`\``, session: call.session?.id || 'thread-1' });
  const { browser, ev, wait, call, originId } = await researchPage(t, { server: { researchRunner } });
  const card = title => `[...document.querySelectorAll('.origin-research-proposal')].find(c => c.querySelector('strong').textContent === ${J(title)})`;
  await ev(`document.querySelector('#origin-research-open').click();`);
  await wait(`document.querySelector('#origin-research-send') && !document.querySelector('#origin-research-send').disabled`, 'ready');
  await ev(`const i = document.querySelector('#origin-research-input'); i.value = 'Plan the orders'; i.dispatchEvent(new Event('input', { bubbles: true })); i.closest('form').requestSubmit();`);
  await wait(`document.querySelectorAll('.origin-research-proposal').length === 2`, 'two suggestions');
  // The task that depends on the other is applied first: its link has to wait.
  await ev(`[...${card('Order endpoints')}.querySelectorAll('button')].find(b => b.textContent === 'Apply').click();`);
  await wait(`${card('Order endpoints')}.dataset.status === 'applied' && document.querySelector('#origin-view').dataset.save === 'saved'`, 'first applied');
  // Reload, reopen the chat, apply the other task: the waiting link is completed.
  await browser.reload();
  await wait(`document.querySelector('#origin-view').dataset.save === 'saved' && !document.querySelector('#origin-research-open').hidden`, 'reloaded');
  await ev(`document.querySelector('#origin-research-open').click();`);
  await wait(`document.querySelector('#origin-research-history')`, 'panel');
  await ev(`document.querySelector('#origin-research-history').click();`);
  await wait(`document.querySelector('.origin-research-chat-open')`, 'history');
  await ev(`document.querySelector('.origin-research-chat-open').click();`);
  await wait(`document.querySelectorAll('.origin-research-proposal').length === 2`, 'cards restored');
  await ev(`[...${card('Orders schema')}.querySelectorAll('button')].find(b => b.textContent === 'Apply').click();`);
  await wait(`${card('Orders schema')}.dataset.status === 'applied'`, 'second applied');
  await wait(`document.querySelector('#origin-view').dataset.save === 'saved'`, 'saved');
  const items = (await call(`/api/origin/projects/${originId}`)).blueprint.items;
  const schema = items.find(item => item.title === 'Orders schema'), endpoints = items.find(item => item.title === 'Order endpoints');
  assert.deepEqual(endpoints.dependsOn, [schema.id]);
});

test('a suggestion applied while its state cannot be saved is shown as applied, so it is never applied twice', { skip: !chrome, timeout: 120000 }, async t => {
  const researchRunner = async call => ({ text: `Add a cache.\n\n\`\`\`origin-suggestions\n${J({ suggestions: [SUGGESTIONS.suggestions[1]] })}\n\`\`\``, session: call.session?.id || 'thread-1' });
  const { app, ev, wait, call, originId } = await researchPage(t, { server: { researchRunner } });
  const click = selector => ev(`document.querySelector(${J(selector)}).click();`);
  await click('#origin-research-open');
  await wait(`document.querySelector('#origin-research-send') && !document.querySelector('#origin-research-send').disabled`, 'ready');
  await ev(`const i = document.querySelector('#origin-research-input'); i.value = 'Caching?'; i.dispatchEvent(new Event('input', { bubbles: true })); i.closest('form').requestSubmit();`);
  await wait(`document.querySelector('.origin-research-proposal .origin-research-apply')`, 'a suggestion card');
  // The chat's file goes away (for example, removed by hand), so the review state cannot be saved.
  const [chat] = (await call(`/api/origin/research/${originId}/chats`)).chats;
  await rm(join(app.board.store.dir, 'origin', 'research', escapeId(originId), `${chat.id}.json`));
  await click('.origin-research-proposal .origin-research-apply');
  await wait(`document.querySelector('.origin-research-proposal').dataset.status === 'applied' && document.querySelector('#origin-drawer .origin-inline-error')`, 'applied, with the error');
  assert.equal(await ev(`return document.querySelectorAll('.origin-research-proposal .origin-research-apply').length;`), 0, 'no second Apply');
  await wait(`document.querySelector('#origin-view').dataset.save === 'saved'`, 'saved');
  assert.equal((await call(`/api/origin/projects/${originId}`)).blueprint.technologies.filter(entry => entry.name === 'Redis').length, 1);
});

test('a suggestion that cites a long link stays inside the Research panel at 390 and 1440 px', { skip: !chrome, timeout: 120000 }, async t => {
  const link = 'https://github.com/questdb/questdb/blob/master/core/src/main/java/io/questdb/cutlass/line/tcp/LineTcpReceiverConfiguration.java';
  const long = { suggestions: [{ title: `Read ${link}`, why: `Documented at ${link} which fits the checkout flow.`, target: { kind: 'add', collection: 'components' }, value: { name: 'Payments', type: 'external', purpose: 'Card payments' } }] };
  const researchRunner = async call => ({ text: `Use Stripe.\n\n\`\`\`origin-suggestions\n${J(long)}\n\`\`\``, session: call.session?.id || 'thread-1' });
  const { browser, ev, wait } = await researchPage(t, { width: 390, height: 844, server: { researchRunner } });
  await ev(`document.querySelector('#origin-research-open').click();`);
  await wait(`document.querySelector('#origin-research-send') && !document.querySelector('#origin-research-send').disabled`, 'ready');
  await ev(`const i = document.querySelector('#origin-research-input'); i.value = 'Payments?'; i.form.requestSubmit();`);
  await wait(`document.querySelector('.origin-research-proposal')`, 'suggestion', 30000);
  for (const [width, height] of [[390, 844], [1440, 900]]) {
    await browser.resize(width, height);
    const box = await ev(`await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      const body = document.querySelector('#origin-research-body'), card = document.querySelector('.origin-research-proposal').getBoundingClientRect(), panel = document.querySelector('#origin-drawer').getBoundingClientRect();
      return { body: body.scrollWidth - body.clientWidth, card: Math.round(card.right - panel.right), page: document.documentElement.scrollWidth - innerWidth };`);
    assert.ok(box.body <= 1 && box.card <= 0 && box.page <= 0, `${width} px: no sideways scroll, the card inside the panel: ${J(box)}`);
  }
});
