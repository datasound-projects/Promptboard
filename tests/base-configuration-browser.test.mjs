// Real Chrome UI; synthetic data and simulated model replies, with both execution workers off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';
const chrome = await findChrome(), J = JSON.stringify;

test('agent configuration preserves provider/model with workers off, supports keyboard navigation, tests saved requirements and fits both themes on desktop/tablet/phone', { skip: !chrome, timeout: 180000 }, async t => {
  const calls = [];
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [], runner: async input => { calls.push(input); return { text: '{"summary":"Version 7"}' }; } });
  const knowledge = await app.board.base.create({ kind: 'knowledge', name: 'Product reference', content: { pages: [{ id: 'release', title: 'Release', markdown: '# Product reference\nVersion 7 is the current synthetic release.' }] } });
  const agent = await app.board.base.create({ kind: 'profile', name: 'Research specialist', description: 'Evidence-based answers from selected reference material.', configuration: { agent: { provider: 'codex', model: 'fixture-model', effort: 'low', instructions: 'Use the supplied reference and state missing evidence.' }, binding: { mode: 'extend', include: [{ resourceId: knowledge.id, required: true }], exclude: [] }, contract: { output: { format: 'json', schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false } }, evaluations: [{ name: 'Release question', input: 'What version is current?', contains: ['Version 7'], excludes: [] }] } } });
  const browser = await launch({ width: 1280, height: 1000 }); assert.ok(browser); t.after(() => browser.close());
  await browser.goto(app.url + '/#/base');
  await browser.until(`document.querySelector('#base-list .base-agent-card')`, 'agent card');
  await browser.eval(`document.querySelector('#base-list .base-agent-card > button').click();`);
  await browser.until(`document.querySelector('.base-configurator [data-field="provider"]')?.value === 'codex'`, 'saved provider visible even with the executor off');
  await browser.until(`document.querySelector('.base-configurator [data-field="model-custom"]')?.value === 'fixture-model'`, 'saved custom model');
  assert.equal(await browser.eval(`return document.querySelector('.base-configurator [data-field="effort"]').value;`), 'low');
  assert.equal(await browser.eval(`return document.querySelectorAll('.base-config-nav-item').length;`), 6);
  assert.equal(await browser.eval(`return Boolean(document.querySelector('.base-configurator #base-mcp-json'));`), false);
  const shotDir = process.env.PB_BASE_SCREENSHOTS ? resolve(process.env.PB_BASE_SCREENSHOTS) : null;
  if (shotDir) await mkdir(shotDir, { recursive: true });
  for (const theme of ['light', 'dark']) for (const width of [1280, 820, 390, 320]) {
    await browser.resize(width, 1000);
    await browser.eval(`document.documentElement.dataset.theme = ${J(theme)}; document.querySelector('.base-config-header').scrollIntoView({block:'start'});`);
    await browser.layout(`return document.documentElement.scrollWidth <= innerWidth + 1;`);
    const overflow = await browser.eval(`return [...document.querySelectorAll('.base-configurator input,.base-configurator select,.base-configurator textarea,.base-configurator button')].filter(n => n.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})).map(n => ({name:n.getAttribute('aria-label') || n.id || n.textContent, r:n.getBoundingClientRect()})).filter(({r}) => r.left < -1 || r.right > innerWidth + 1).map(({name}) => name);`);
    assert.deepEqual(overflow, [], `${theme} at ${width}px`);
    if (shotDir && [1280, 390].includes(width)) await writeFile(resolve(shotDir, `agent-${theme}-${width}.png`), await browser.screenshot());
    await browser.eval(`document.querySelector('.base-config-footer .base-more').open = true;`);
    const menu = await browser.eval(`const r = document.querySelector('.base-config-footer .origin-menu-list').getBoundingClientRect(); return {left:r.left,right:r.right,width:innerWidth};`); assert.ok(menu.left >= 0 && menu.right <= menu.width + 1, `open More menu fits at ${width}px`);
    await browser.eval(`document.querySelector('.base-config-footer .base-more').open = false;`);
  }
  await browser.resize(1280, 1000);
  await browser.eval(`document.querySelectorAll('.base-config-nav-item')[5].focus();`); await browser.key('Enter');
  await browser.until(`document.activeElement?.textContent === 'Test and compatibility'`, 'section heading receives keyboard focus');
  await browser.eval(`[...document.querySelectorAll('.base-configurator button')].find(n => n.textContent === 'Check compatibility').click();`);
  await browser.until(`document.querySelectorAll('.base-compatibility-table tr').length === 10`, 'nine compatibility contexts'); assert.equal(calls.length, 0);
  await browser.eval(`document.querySelector('#base-agent-run-test').click();`);
  await browser.until(`/Release question: Passed/.test(document.querySelector('.base-agent-test-result').textContent)`, 'saved case tested through the protected API');
  assert.equal(calls.length, 1); assert.match(calls[0].prompt, /Version 7/); assert.match(await browser.eval(`return document.querySelector('.base-agent-test-result').textContent;`), /not exercised/);
  await browser.eval(`document.querySelector('#base-resource-name').value = 'Edited research specialist'; document.querySelector('#base-resource-name').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#base-resource-save').click();`);
  await browser.until(`/Saved/.test(document.querySelector('#base-status').textContent)`, 'edited configuration saved');
  const saved = await app.board.base.detail(agent.id); assert.equal(saved.name, 'Edited research specialist'); assert.equal(saved.configuration.agent.provider, 'codex'); assert.equal(saved.configuration.agent.model, 'fixture-model'); assert.equal(saved.configuration.agent.effort, 'low'); assert.deepEqual(saved.configuration.contract.output.schema, agent.configuration.contract.output.schema);
  await browser.eval(`window.confirm = () => true; [...document.querySelectorAll('.base-configurator button')].find(n => n.textContent === 'Back to library').click(); [...document.querySelectorAll('#base-categories button')].find(n => n.dataset.kind === 'mcp').click(); [...document.querySelectorAll('#base-actions button')].find(n => n.textContent === 'Create').click();`);
  await browser.until(`document.querySelector('#base-mcp-source')`, 'central MCP setup'); assert.equal(await browser.eval(`return document.querySelectorAll('.base-config-nav-item').length;`), 4);
  for (const theme of ['light', 'dark']) for (const width of [1280, 820, 390, 320]) {
    await browser.resize(width, 1000); await browser.eval(`document.documentElement.dataset.theme = ${J(theme)}; document.querySelector('.base-config-header').scrollIntoView({block:'start'});`);
    await browser.layout(`return document.documentElement.scrollWidth <= innerWidth + 1;`);
    if (shotDir && [1280, 390].includes(width)) await writeFile(resolve(shotDir, `mcp-${theme}-${width}.png`), await browser.screenshot());
  }
  assert.deepEqual(browser.consoleMessages.filter(message => /EXCEPTION|Uncaught|Failed to load resource/.test(message)), []);
});
