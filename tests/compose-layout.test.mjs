import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launch, findChrome } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const prompt = '## Goal\n\nBuild a small website about dogs. Keep the page accessible and responsive.\n\n## Implementation\n\nUse the existing project conventions. Keep the layout simple.\n\n## Acceptance checks\n\nVerify keyboard use and the layout on a narrow screen.\n\nPreserve this literal: <script>alert("source data")</script>.';
test('Compose layout: compact groups, centred headings, keyboard menus, exact copying and responsive result controls', { skip: !(await findChrome()), timeout: 120000 }, async t => {
  const app = await startTestServer(t, { port: 0, detector: async () => [{ id: 'codex', available: true }], authAdapter: { installed: async () => true, status: async () => ({ state: 'signed-in' }) }, runner: async () => ({ text: prompt }) });
  const browser = await launch(); if (!browser) { t.skip('Chrome did not start.'); return; } t.after(() => browser.close());
  await browser.goto(app.url); await browser.until(`!document.querySelector('#generate-button').disabled`, 'ready');
  const click = async selector => {
    const point = await browser.eval(`const node = document.querySelector(${JSON.stringify(selector)}); node.scrollIntoView({block:'center'}); await new Promise(requestAnimationFrame); const r=node.getBoundingClientRect(); const x=r.x+r.width/2, y=r.y+r.height/2; if (!node.contains(document.elementFromPoint(x,y))) throw new Error('Control is not visible: '+${JSON.stringify(selector)}); return {x,y};`);
    await browser.click(point.x, point.y);
  };
  const shot = async name => { if (process.env.PB_COMPOSE_LAYOUT_SHOTS) await writeFile(join(process.env.PB_COMPOSE_LAYOUT_SHOTS, name+'.png'), await browser.screenshot()); };
  assert.equal(await browser.eval(`return document.querySelectorAll('#prompt-view .step, #prompt-view img').length;`), 0);
  assert.equal(await browser.eval(`return [...document.querySelectorAll('#settings-body > details')].every(node=>!node.open);`), true);
  assert.equal(await browser.eval(`return getComputedStyle(document.querySelector('#input-heading')).fontSize === getComputedStyle(document.querySelector('#settings-heading')).fontSize;`), true);
  for (const theme of ['light','dark']) {
    await browser.eval(`document.documentElement.dataset.theme='${theme}'; window.scrollTo(0,0);`); await shot('empty-1280-'+theme);
  }
  await click('#compose-general > summary'); await browser.until(`document.querySelector('#compose-general').open`, 'general settings');
  await browser.eval(`document.querySelector('#prompt-input').value = 'Create a website about dogs.'; const model=document.querySelector('#model'); model.value='__custom__'; model.dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#custom-model').value='';`);
  await click('#compose-general > summary'); await click('#generate-button');
  assert.equal(await browser.eval(`return document.querySelector('#compose-general').open && document.activeElement.id==='custom-model';`), true);
  await browser.eval(`const model=document.querySelector('#model'); model.value=''; model.dispatchEvent(new Event('change',{bubbles:true}));`);
  await click('[name="quality"][value="fast"]');
  await browser.eval(`document.querySelector('#prompt-input').value = 'Create a website about dogs.'; document.querySelector('#prompt-input').dispatchEvent(new Event('input',{bubbles:true}));`);
  await click('#compose-general > summary'); await click('#generate-button');
  await browser.until(`!document.querySelector('#prompt-output').hidden && !document.querySelector('#copy-button').disabled`, 'result');
  assert.equal(await browser.eval(`return document.querySelector('#prompt-output').textContent;`), prompt);
  assert.equal(await browser.eval(`return !!document.querySelector('#prompt-output script');`), false);
  await browser.eval(`window.__copied = ''; Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.__copied=text}},configurable:true});`);
  await click('#copy-button'); assert.equal(await browser.eval(`return window.__copied;`), prompt);
  await click('#prompt-edit'); await browser.until(`!document.querySelector('#prompt-editor').hidden`, 'edit opened');
  await browser.eval(`document.querySelector('#prompt-edit-text').value += ${JSON.stringify('\nKeep exact edits.')};`);
  await click('#prompt-edit-save'); await click('#copy-button');
  assert.equal(await browser.eval(`return window.__copied;`), prompt+'\nKeep exact edits.');
  for (const width of [1280, 390, 320]) for (const theme of ['light','dark']) {
    await browser.resize(width,900); await browser.eval(`document.documentElement.dataset.theme='${theme}'; window.scrollTo(0,0);`);
    assert.equal(await browser.layout(`return document.documentElement.scrollWidth <= innerWidth;`), true);
    assert.equal(await browser.layout(`const r=document.querySelector('.compose-input-surface').getBoundingClientRect(), a=document.querySelector('#input-heading').getBoundingClientRect(), b=document.querySelector('#settings-heading').getBoundingClientRect(); return Math.abs((a.x+a.width/2)-(r.x+r.width/2))<1 && Math.abs((b.x+b.width/2)-(r.x+r.width/2))<1;`), true);
    await click('#compose-general > summary'); await browser.until(`document.querySelector('#compose-general').open`, 'settings expanded');
    assert.equal(await browser.layout(`return document.documentElement.scrollWidth <= innerWidth;`), true);
    await shot('settings-'+width+'-'+theme); await click('#compose-general > summary');
    await browser.eval(`document.querySelector('#output-tools > summary').scrollIntoView({block:'center'}); document.querySelector('#output-tools > summary').focus();`);
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await browser.until(`document.querySelector('#output-tools').open && document.querySelector('#output-tools > summary').getAttribute('aria-expanded')==='true'`, 'keyboard menu');
    assert.equal(await browser.layout(`const r=document.querySelector('#output-tools .output-actions').getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth;`), true);
    await shot('result-'+width+'-'+theme); await browser.key('Escape','Escape',27);
    assert.equal(await browser.eval(`return document.activeElement===document.querySelector('#output-tools > summary') && !document.querySelector('#output-tools').open;`), true);
    await click('#output-tools > summary'); await click('#prompt-output');
    assert.equal(await browser.eval(`return document.querySelector('#output-tools').open;`), false);
  }
  assert.deepEqual(browser.consoleMessages.filter(message=>message.startsWith('EXCEPTION')),[]);
});
