// Task 12 in headless Chrome: Activity's Schedules list and editor, a delegating job's record (sub-job tree with its approval
// request, handoff messages), a question with its answer form, and Settings' handoff policy, in light and dark at 1440 and
// 390 px with nothing scrolling sideways; the keyboard (Tab reaches New schedule with a visible ring, Enter opens the editor
// with the name focused, Escape returns focus; Tab from the answer reaches Send answer). No exception or CSP message. Jobs run
// through the deterministic fake worker. PB_NETWORK_SCREENSHOTS=<folder> saves PNGs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { fakeWorker } from './helpers/network-worker.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const chrome = await findChrome();
const J = JSON.stringify, hex = text => createHash('sha256').update(text).digest('hex');

test('handoffs and schedules in Chrome: both themes at 1440 and 390 px, the dialogs and the keyboard', { skip: !chrome, timeout: 240000 }, async t => {
  const asks = new Map();
  const worker = fakeWorker({ text: job => (job.handoff?.context ? 'Final.' : `Report for: ${job.request.input.text}`), json: job => (job.handoff?.context ? null : asks.get(job.request.input.text) ?? null) });
  const app = await startTestServer(t, { port: 0, executor: null, networkWorker: worker, networkScheduleOptions: { setTimer: () => null } });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = async (path, method = 'GET', body) => (await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: J(body) } : {}) })).json();
  const agents = [];
  for (const [id, name] of [['lead', 'Research lead'], ['helper', 'Fact checker with a rather long display name']]) {
    await app.board.base.create({ id, kind: 'profile', name, configuration: { agent: { provider: 'claude' } } });
    agents.push((await call('/api/network/agents', 'POST', { baseResourceId: id, expectedRevision: (await call('/api/network/agents')).revision })).agent);
  }
  const [lead, helper] = agents, N = id => `n_${hex(id).slice(0, 12)}`;
  const { network } = await call('/api/network/networks', 'POST', { name: 'Team', nodes: agents.map(item => ({ id: N(item.id), type: 'agent', agentId: item.id, position: { x: 0, y: 0 } })),
    edges: [{ id: `e_${hex('edge').slice(0, 12)}`, from: N(lead.id), to: N(helper.id), relation: 'delegate' }] });
  await call('/api/network/delegation', 'PATCH', { expectedRevision: 0, delegate: true, askOwner: true });
  asks.set('Write the quarterly summary.', { promptboard: { delegate: [{ agentId: helper.id, task: 'Check every number in the quarterly figures against the source tables and list any that differ.' }] } });
  asks.set('Plan the launch.', { promptboard: { needs_input: { question: 'Which market should launch first, and is the date fixed or can it move by a week?' } } });
  const delegating = (await call('/api/network/jobs', 'POST', { agentId: lead.id, input: { text: 'Write the quarterly summary.' }, networkId: network.id })).jobId;
  const asking = (await call('/api/network/jobs', 'POST', { agentId: lead.id, input: { text: 'Plan the launch.' } })).jobId;
  for (let tries = 0; (await call(`/api/network/jobs/${delegating}`)).children.length < 1 || (await call(`/api/network/jobs/${asking}`)).job.status !== 'waiting_for_input'; tries++) {
    assert.ok(tries < 400, 'jobs reached their handoffs'); await new Promise(resolve => setTimeout(resolve, 10));
  }
  const on = (await call('/api/network/schedules', 'POST', { expectedRevision: 0, name: 'Morning digest of every overnight change', target: { agentId: lead.id, input: { text: 'Summarise.' } }, cadence: { kind: 'weekdays', time: '07:30' } })).schedule;
  await call(`/api/network/schedules/${on.id}/confirm`, 'POST', { expectedRevision: on.revision, confirm: true });
  await call('/api/network/schedules', 'POST', { expectedRevision: 2, name: 'Monthly report', target: { agentId: helper.id, input: { text: 'Report.' } }, cadence: { kind: 'monthly', day: 1, time: '09:00' } });

  const browser = await launch({ width: 1440, height: 1000 }); assert.ok(browser); t.after(() => browser.close());
  const ev = code => browser.eval(code), wait = (expression, label, ms = 20000) => browser.until(expression, label, ms);
  const shots = process.env.PB_NETWORK_SCREENSHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  const shot = async name => { if (shots) await writeFile(join(shots, `${name}.png`), await browser.screenshot()); };
  const noSideways = 'document.documentElement.scrollWidth <= document.documentElement.clientWidth';
  const press = async (key, code, keyCode, text) => { await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, text }); await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode }); };
  await browser.goto(`${app.url}/#/network/activity`);
  for (const theme of ['light', 'dark']) {
    await ev(`localStorage.setItem('ste-prompt-engineer.theme', ${J(theme)});`);
    await browser.reload();
    await browser.resize(1440, 1000);
    await ev(`location.hash = '#/network/activity';`);
    await wait(`(document.documentElement.dataset.theme || 'light') === ${J(theme)} && document.querySelectorAll('#network-schedules-list > li').length === 2`, `${theme}: schedules listed`);
    assert.equal(await browser.layout(`const list = document.querySelector('#network-schedules').getBoundingClientRect(), feed = document.querySelector('.network-activity-feed').getBoundingClientRect();
      return ${noSideways} && list.left >= feed.right && list.width > 250;`), true, `${theme}: the schedules sit in the side column at 1440`);
    const colors = await ev(`const row = getComputedStyle(document.querySelector('#network-schedules-list > li')); return [row.backgroundColor];`);
    assert.equal(theme === 'dark' ? colors[0] !== 'rgb(255, 255, 255)' : colors[0] === 'rgb(255, 255, 255)', true, `${theme}: the rows follow the theme (${colors})`);
    await shot(`activity-schedules-1440-${theme}`);
    await browser.resize(390, 844);
    assert.equal(await browser.layout(`const box = document.querySelector('#network-schedules').getBoundingClientRect(); return ${noSideways} && box.right <= innerWidth + 1;`), true, `${theme}: schedules at 390`);
    await ev(`document.querySelector('#network-schedules').scrollIntoView();`);
    await shot(`activity-schedules-390-${theme}`);
    // The editor at 390 stays inside the screen.
    await ev(`document.querySelector('#network-schedule-new').click();`);
    await wait(`document.querySelector('#network-handoff-dialog')?.open && document.activeElement?.id === 'network-schedule-name'`, `${theme}: editor`);
    assert.equal(await browser.layout(`const box = document.querySelector('#network-handoff-dialog').getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth + 1;`), true, `${theme}: editor at 390`);
    await shot(`schedule-editor-390-${theme}`);
    await browser.key('Escape', 'Escape', 27);
    await wait(`!document.querySelector('#network-handoff-dialog').open`, 'editor closed');
    // A delegating job's record: the tree with its approval request and the messages.
    for (const width of [1440, 390]) {
      await browser.resize(width, width === 390 ? 844 : 1000);
      await ev(`location.hash = '#/network/activity/${delegating}';`);
      await wait(`document.querySelector('.network-handoff-tree [id^="network-approve-"]') && document.querySelector('#network-handoff-messages')`, `${theme} ${width}: delegating record`);
      assert.equal(await browser.layout(`const tree = document.querySelector('.network-handoff-tree').getBoundingClientRect(); return ${noSideways} && tree.right <= innerWidth;`), true, `${theme} ${width}: tree fits`);
      await ev(`document.querySelector('.network-handoff-tree').scrollIntoView();`);
      await shot(`job-delegating-${width}-${theme}`);
      await ev(`location.hash = '#/network/activity/${asking}';`);
      await wait(`document.querySelector('#network-handoff-answer') && /Which market/.test(document.querySelector('#network-handoff-question').textContent)`, `${theme} ${width}: question record`);
      assert.equal(await browser.layout(`const box = document.querySelector('#network-handoff-question').getBoundingClientRect(), answer = document.querySelector('#network-handoff-answer').getBoundingClientRect(); return ${noSideways} && box.right <= innerWidth && answer.right <= innerWidth && answer.width > 200;`), true, `${theme} ${width}: question fits`);
      await ev(`document.querySelector('#network-handoff-question').scrollIntoView();`);
      await shot(`job-question-${width}-${theme}`);
      await ev(`location.hash = '#/network/settings';`);
      await wait(`/Questions on · Delegation on/.test(document.querySelector('#network-handoff-status')?.textContent || '')`, `${theme} ${width}: policy`);
      assert.equal(await browser.layout(`const card = document.querySelector('#network-handoff-policy').getBoundingClientRect(); return ${noSideways} && card.right <= innerWidth;`), true, `${theme} ${width}: policy fits`);
      await ev(`document.querySelector('#network-handoff-policy').scrollIntoView();`);
      await shot(`settings-handoffs-${width}-${theme}`);
    }
    await browser.resize(1440, 1000);
  }
  // Keyboard: Tab from the control before it reaches New schedule with a visible ring; Enter opens the editor on the name;
  // Escape closes it and focus returns.
  await ev(`location.hash = '#/network/activity'; window.scrollTo(0, 0);`);
  await wait(`document.querySelectorAll('#network-schedules-list > li').length === 2`, 'back on Activity');
  await ev(`const all = [...document.querySelectorAll('button, a[href], input, select, textarea')].filter(node => node.offsetParent && !node.disabled); all[all.indexOf(document.querySelector('#network-schedule-new')) - 1].focus();`);
  await browser.key('Tab', 'Tab', 9);
  await wait(`document.activeElement?.id === 'network-schedule-new'`, 'Tab reaches New schedule');
  assert.notEqual(await ev(`return getComputedStyle(document.activeElement).outlineStyle;`), 'none', 'visible focus on New schedule');
  await press('Enter', 'Enter', 13, '\r');
  await wait(`document.querySelector('#network-handoff-dialog')?.open && document.activeElement?.id === 'network-schedule-name'`, 'Enter opens the editor');
  await browser.key('Escape', 'Escape', 27);
  await wait(`!document.querySelector('#network-handoff-dialog').open && document.activeElement?.id === 'network-schedule-new'`, 'Escape returns focus');
  // The answer form: Tab from the answer reaches Send answer with a visible ring.
  await ev(`location.hash = '#/network/activity/${asking}';`);
  await wait(`document.querySelector('#network-handoff-answer')`, 'answer form');
  await ev(`document.querySelector('#network-handoff-answer').focus();`);
  await browser.key('Tab', 'Tab', 9);
  await wait(`document.activeElement?.id === 'network-handoff-send'`, 'Tab reaches Send answer');
  assert.notEqual(await ev(`return getComputedStyle(document.activeElement).outlineStyle;`), 'none', 'visible focus on Send answer');
  assert.deepEqual(browser.consoleMessages.filter(message => /EXCEPTION|Uncaught|Content Security Policy|Refused/i.test(message)), []);
});
