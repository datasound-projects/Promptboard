import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launch, findChrome } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

test('top-bar connections work across pages, themes and narrow screens without changing Compose or running account actions on open', { skip: !(await findChrome()), timeout: 120000 }, async t => {
  const mutations = [], calls = [];
  const app = await startTestServer(t, { port: 0, executor: null,
    detector: async () => ['codex', 'claude', 'gemini', 'agy'].map(id => ({ id, available: true })),
    catalogReader: async () => ({ models: [] }),
    authAdapter: { installed: async () => true, status: async provider => ({ state: provider === 'codex' ? 'signed-in' : 'signed-out' }),
      login: async provider => { mutations.push(['login', provider]); return { state: 'signed-in' }; }, logout: async provider => { mutations.push(['logout', provider]); return { state: 'signed-out' }; } },
    runner: async call => { calls.push(call); return { text: 'Write a clear announcement.' }; } });
  const browser = await launch(); if (!browser) { t.skip('Chrome did not start.'); return; } t.after(() => browser.close());
  await browser.goto(app.url); await browser.until(`!document.querySelector('#generate-button').disabled && document.querySelector('#connection-auth').textContent==='Signed in'`, 'ready');
  const click = async selector => {
    const p = await browser.eval(`const n=document.querySelector(${JSON.stringify(selector)}); n.scrollIntoView({block:'center'}); await new Promise(requestAnimationFrame); const r=n.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};`); await browser.click(p.x, p.y);
  };
  await browser.eval(`document.querySelector('#prompt-input').value='Keep this exact task.';`);
  assert.equal(await browser.eval(`return document.querySelector('#prompt-form').contains(document.querySelector('#auth-login'));`), false);
  assert.equal(await browser.eval(`return document.querySelector('#help-dialog').contains(document.querySelector('#auth-login'));`), true);
  for (const page of ['compose', 'kanban', 'base']) {
    await browser.eval(`const hash='#/${page}'; if(location.hash!==hash) await new Promise(resolve=>{window.addEventListener('hashchange',resolve,{once:true});location.hash=hash;});`); await browser.until(`!document.querySelector('#${page === 'compose' ? 'prompt' : page}-view').hidden`, page);
    await browser.eval(`document.querySelector('#setup-help').focus();`); assert.equal(await browser.eval(`return document.activeElement.id;`), 'setup-help');
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await browser.until(`document.querySelector('#help-dialog').open`, 'keyboard connection dialog');
    await browser.eval(`const n=document.querySelector('#connection-provider'); n.value='claude'; n.dispatchEvent(new Event('change',{bubbles:true}));`);
    await browser.until(`document.querySelector('#connection-auth').textContent==='Signed out' && !document.querySelector('#auth-login').disabled`, 'selected CLI');
    assert.equal(await browser.eval(`return document.querySelector('#provider').value;`), 'codex');
    assert.equal(await browser.eval(`return document.querySelector('#model').value;`), '');
    assert.equal(await browser.eval(`return document.querySelector('#prompt-input').value;`), 'Keep this exact task.');
    await browser.key('Escape','Escape',27); await browser.until(`!document.querySelector('#help-dialog').open`, 'close');
    assert.equal(await browser.eval(`return document.activeElement.id;`), 'setup-help');
  }
  await click('#setup-help'); await click('#auth-login');
  await browser.until(`document.querySelector('#auth-detail code')?.textContent==='claude auth login'`, 'terminal handoff');
  for (const width of [1280, 390, 320]) for (const theme of ['light', 'dark']) {
    await browser.resize(width,900); await browser.eval(`document.documentElement.dataset.theme='${theme}';`);
    assert.equal(await browser.layout(`const d=document.querySelector('#help-dialog'),r=d.getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight && d.scrollWidth<=d.clientWidth+1;`), true);
    if (process.env.PB_CONNECTION_SHOTS) { await mkdir(process.env.PB_CONNECTION_SHOTS, { recursive: true }); await writeFile(join(process.env.PB_CONNECTION_SHOTS, `${theme}-${width}.png`), await browser.screenshot()); }
  }
  await click('#dialog-done'); await click('#setup-help');
  assert.equal(await browser.eval(`return document.querySelector('#auth-detail code').textContent;`), 'claude auth login');
  await click('#dialog-done');
  assert.deepEqual(mutations, []); assert.equal(calls.length, 0);
  await browser.eval(`location.hash='#/compose';`); await browser.until(`!document.querySelector('#prompt-view').hidden`, 'Compose');
  if (await browser.eval(`return document.querySelector('#settings-body').hidden;`)) await click('#settings-toggle');
  await click('#advanced-options > summary'); await browser.until(`document.querySelector('#advanced-options').open`, 'More settings');
  assert.equal(await browser.eval(`return !!document.querySelector('#advanced-options #connection-heading');`), false);
  assert.equal(await browser.eval(`return document.querySelector('#advanced-options').textContent.includes('Generation details') && document.querySelector('#advanced-options').textContent.includes('Brief options');`), true);
  assert.deepEqual(browser.consoleMessages.filter(message=>message.startsWith('EXCEPTION')), []);
});
