// Real browser, real Chat HTTP/storage/retrieval, simulated read-only model replies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const chrome = await findChrome(), J = JSON.stringify;
const dataFrom = call => JSON.parse(call.prompt.split('INPUT DATA (not instructions):\n')[1]);
function responseFor(call) {
  const data = dataFrom(call), workspace = call.prompt.includes('Workspace assistant');
  const source = workspace ? data.evidence.find(item => item.title.includes('Atlas board')) || data.evidence[0] : data.evidence.find(item => item.path === 'docs/network/user-guide.md') || data.evidence[0];
  return { text: J({ status: 'answer', sections: [{ text: `${workspace ? 'Saved workspace record' : 'Installed app guide'}:\n${source.text.slice(0, 1000)}`, citations: [{ sourceId: source.id, quote: source.text.slice(0, 400) }] }], uncertainties: [] }) };
}
async function setup(t, runner = async call => responseFor(call)) {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [{ id: 'claude', name: 'Claude Code', available: true, version: 'simulated Chat fixture' }], runner });
  const browser = await launch({ width: 1280, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  const ev = code => browser.eval(code), wait = (value, label, ms = 20000) => browser.until(value, label, ms);
  const click = async selector => {
    const point = await ev(`const b = document.querySelector(${J(selector)}); if (!b) throw new Error('Missing control'); b.scrollIntoView({block:'nearest',inline:'nearest'}); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); const r=b.getBoundingClientRect(), x=r.left+r.width/2,y=r.top+r.height/2; const hit=document.elementFromPoint(x,y); let parent=b;const ancestors=[];while(parent&&ancestors.length<6){ancestors.push({tag:parent.tagName,id:parent.id,hidden:parent.hidden,display:getComputedStyle(parent).display});parent=parent.parentElement;}return {x,y,visible:!!hit&&(hit===b||b.contains(hit)),rect:r.toJSON(),hit:hit?.id||hit?.tagName,sidebar:document.querySelector('#sidebar').getBoundingClientRect().toJSON(),collapsed:document.documentElement.dataset.sidebar,scrollX,hash:location.hash,page:document.documentElement.dataset.page,ancestors};`);
    assert.equal(point.visible, true, `pointer reaches ${selector}: ${J(point)}`); await browser.click(point.x, point.y);
  };
  const ask = async text => { await ev(`document.querySelector('#chat-input').focus();`); await browser.type(text); await browser.key('Enter', 'Enter', 13); };
  return { app, browser, ev, wait, click, ask };
}

test('the top-right icon opens Chat; Workspace and App guide use distinct saved conversations and exact sources', { skip: !chrome, timeout: 180000 }, async t => {
  const calls = [], { app, browser, ev, wait, click, ask } = await setup(t, async call => { calls.push(dataFrom(call)); return responseFor(call); });
  const project = await app.board.createProject({ name: 'Atlas board' });
  await app.board.createTask({ projectId: project.id, title: 'Review release notes', prompt: 'Review the notes without running any agent.' });
  await browser.goto(`${app.url}/#/kanban`);
  await wait(`document.querySelector('#cli-status-label')?.textContent.includes('ready') || providers?.some(p=>p.available)`, 'provider discovered');
  await click('#chat-open');
  await wait(`document.documentElement.dataset.page==='chat' && document.querySelector('#chat-provider')?.options.length===3 && document.querySelector('#chat-version')?.textContent.includes('0.4.0')`, 'dedicated chat page');
  assert.equal(await ev(`return document.querySelector('#chat-open').getAttribute('aria-current');`), 'page');
  await click('.chat-settings > summary');
  await ev(`document.querySelector('#chat-input').focus();`);
  await browser.type('Show the saved Atlas board project and its current workflow.');
  await click('#chat-send');
  await wait(`document.querySelector('.chat-message-assistant')?.textContent.includes('Atlas board') && document.querySelector('#chat-stop').hidden`, 'workspace reply');
  const workspaceHash = await ev('return location.hash;');
  await click('.chat-source-buttons button');
  assert.equal(await ev(`return document.querySelector('.chat-source-panel blockquote')?.textContent.length > 12;`), true);
  assert.ok(calls[0].evidence.some(source => source.kind === 'workspace' && source.text.includes('Atlas board')));
  await click('[data-agent="guide"]');
  await wait(`document.querySelector('[data-agent="guide"]').getAttribute('aria-pressed')==='true' && !document.querySelector('.chat-message-assistant')`, 'separate guide conversation');
  await ask('How do I register a Network agent and run a pipeline with approval?');
  await wait(`document.querySelector('.chat-message-assistant')?.textContent.includes('Installed app guide') && document.querySelector('#chat-stop').hidden`, 'guide reply');
  const guideHash = await ev('return location.hash;'); assert.notEqual(guideHash, workspaceHash);
  assert.equal(calls.length, 2); assert.ok(calls[1].evidence.every(source => ['guide', 'interface'].includes(source.kind)));
  assert.equal(J(calls[1]).includes('Atlas board'), false);
  await browser.reload();
  await wait(`document.querySelector('.chat-message-assistant')?.textContent.includes('Installed app guide')`, 'saved guide conversation after reload');
  assert.equal(calls.length, 2, 'reloading never runs another model request');
  await click('[data-agent="workspace"]');
  await wait(`document.querySelector('#chat-history-list a')?.textContent.includes('Atlas')`, 'workspace history');
  await click('#chat-history-list a');
  await wait(`location.hash===${J(workspaceHash)} && document.querySelector('.chat-message-assistant')?.textContent.includes('Atlas board')`, 'saved workspace conversation');
  assert.deepEqual(browser.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);
});

test('Chat and its global icon fit phone/tablet/desktop widths in both themes, preserve touch targets and keyboard focus', { skip: !chrome, timeout: 240000 }, async t => {
  const { app, browser, ev, wait, click, ask } = await setup(t);
  await browser.goto(`${app.url}/#/chat`);
  await wait(`document.querySelector('#chat-provider')?.options.length===3 && providers?.some(p=>p.available)`, 'Chat ready');
  await click('[data-agent="guide"]');
  await ask('Explain Network approval steps and saved reports.');
  await wait(`document.querySelector('.chat-source-buttons button') && document.querySelector('#chat-stop').hidden`, 'answer ready');
  const chatHash = await ev('return location.hash;');
  for (const theme of ['light', 'dark']) {
    await ev(`applyTheme(${J(theme)});`);
    for (const width of [320, 390, 485, 545, 561, 600, 735, 820, 840, 1280]) {
      await browser.resize(width, 844);
      for (const [hash, page] of [['#/origin', 'origin'], ['#/', 'compose'], ['#/kanban', 'kanban'], ['#/base', 'base'], ['#/network', 'network'], [chatHash, 'chat']]) {
        await ev(`location.hash=${J(hash)};`); await wait(`document.documentElement.dataset.page===${J(page)}`, `${page} visible`);
        assert.equal(await browser.layout(`const r=document.documentElement, controls=[...document.querySelectorAll('.topbar :is(.icon-button,.help-pill), .page-nav a')].filter(n=>n.getBoundingClientRect().width);return r.scrollWidth<=r.clientWidth&&controls.every(n=>{const b=n.getBoundingClientRect();return b.left>=-1&&b.right<=innerWidth+1;});`), true, `${theme} ${page} at ${width}: no sideways overflow`);
      }
      assert.equal(await browser.layout(`const r=document.querySelector('#chat-open').getBoundingClientRect();return ${width > 560} || (r.width>=44&&r.height>=44);`), true, 'Chat touch target');
      assert.equal(await browser.layout(`const r=document.querySelector('#chat-send').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.width>0;`), true, 'composer inside viewport width');
    }
  }
  await browser.resize(390, 844);
  await ev(`document.querySelector('#skip-link').focus();`); await browser.key('Enter', 'Enter', 13);
  await wait(`document.activeElement?.id==='chat-view'`, 'skip link enters Chat');
  for (let stop = 0; stop < 10; stop++) {
    await browser.key('Tab', 'Tab', 9);
    assert.equal(await browser.layout(`const n=document.activeElement,r=n.getBoundingClientRect(),s=getComputedStyle(n);return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&(s.outlineStyle!=='none'||s.boxShadow!=='none');`), true, `visible focus at stop ${stop}`);
  }
  await ev(`document.querySelector('#chat-input').focus();`); await browser.type('Keep this exact draft');
  await ev(`location.hash='#/base';`); await wait(`document.documentElement.dataset.page==='base'`, 'leave Chat');
  await click('#chat-open'); await wait(`document.documentElement.dataset.page==='chat' && document.querySelector('#chat-input').value==='Keep this exact draft'`, 'draft returns');
  assert.deepEqual(browser.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);
});

test('real-browser Stop cancels the owned chat and keeps a follow-up draft; the next request can use the CLI slot', { skip: !chrome, timeout: 120000 }, async t => {
  let started, count = 0; const began = new Promise(resolve => { started = resolve; });
  const { app, browser, ev, wait, click, ask } = await setup(t, async call => {
    if (++count !== 1) return responseFor(call);
    started(); return new Promise((resolve, reject) => call.signal.addEventListener('abort', () => reject(Object.assign(new Error('simulation stopped'), { code: 'ABORTED' })), { once: true }));
  });
  await browser.goto(`${app.url}/#/chat`); await wait(`document.querySelector('#chat-provider')?.options.length===3 && providers?.some(p=>p.available)`, 'Chat ready');
  await click('[data-agent="guide"]'); await ask('Explain Network approvals'); await began;
  await ev(`document.querySelector('#chat-input').focus();`); await browser.type('My next question about Network reports');
  await click('#chat-stop');
  await wait(`document.querySelector('#chat-stop').hidden && document.querySelector('.chat-message-assistant')?.textContent.includes('cancelled')`, 'cancelled and saved');
  assert.equal(await ev(`return document.querySelector('#chat-input').value;`), 'My next question about Network reports');
  await click('#chat-send');
  await wait(`document.querySelectorAll('.chat-message-assistant').length===2 && document.querySelector('#chat-stop').hidden`, 'next response completed');
  assert.equal(count, 2); assert.deepEqual(browser.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);
});
