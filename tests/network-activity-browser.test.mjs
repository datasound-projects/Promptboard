// Network → Activity in headless Chrome: light and dark at 1440 and 390 px with nothing scrolling sideways; waiting and
// unknown look different (colour, border and mark); a new event appears live without a reload; one job's record with
// its heading focused; the agent's Activity tab; keyboard focus that shows; no exception or CSP message. Jobs come from
// the deterministic fake worker; job.activity and pipeline events are synthetic appends. No CLI runs.
// PB_NETWORK_SCREENSHOTS=<folder> also saves each width and theme as a PNG for a person to look at.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';
import { fakeWorker } from './helpers/network-worker.mjs';

const chrome = await findChrome();
const J = JSON.stringify;

test('Activity in Chrome: both themes at 1440 and 390 px, distinct waiting and unknown, live updates, a job record, the agent tab and the keyboard', { skip: !chrome, timeout: 240000 }, async t => {
  const worker = fakeWorker({ mode: 'manual' });
  const app = await startTestServer(t, { port: 0, executor: null, networkWorker: worker });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = async (path, method = 'GET', body) => (await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: J(body) } : {}) })).json();
  const agents = {};
  for (const [id, name, provider] of [['lead', 'Research lead', 'claude'], ['scout', 'Scout', 'codex'], ['gem', 'Gem', 'gemini'], ['writer', 'Writer', 'claude']]) {
    await app.board.base.create({ id, kind: 'profile', name, configuration: { agent: { provider } } });
    agents[id] = (await call('/api/network/agents', 'POST', { baseResourceId: id, expectedRevision: (await call('/api/network/agents')).revision })).agent;
  }
  const start = async (agent, extra = {}) => { const next = worker.next(); const { jobId } = await call('/api/network/jobs', 'POST', { agentId: agent.id, input: { text: 'Collect the release notes.' }, ...extra }); return { jobId, entry: await next }; };
  const done = await start(agents.lead); await done.entry.own.launching(); await done.entry.own.spawned({ pid: 41 }); await done.entry.own.finish({ status: 'completed', exitCode: 0, result: { text: 'Notes.' } }); done.entry.end();
  const waiting = await start(agents.writer); await waiting.entry.own.launching(); await waiting.entry.own.spawned({ pid: 42 }); await waiting.entry.own.finish({ status: 'waiting_for_input', result: { text: 'Which year?' } }); waiting.entry.end();
  const lost = await start(agents.scout); await lost.entry.own.launching(); await lost.entry.own.finish({ status: 'unknown' }); lost.entry.end();
  const busy = await start(agents.lead); await busy.entry.own.launching(); await busy.entry.own.spawned({ pid: 43 });
  await call('/api/network/jobs', 'POST', { agentId: agents.gem.id, input: { text: 'Check it.' }, requireApproval: true });
  await app.networkEvents.append({ type: 'job.activity', jobId: busy.jobId, agentId: agents.lead.id, kind: 'web', label: 'Searching: release notes October 2026' });
  await app.networkEvents.append({ type: 'pipeline.run', pipelineRunId: 'run_' + 'a'.repeat(20), status: 'running', message: 'Research pipeline v2 started.' });
  const project = await app.board.createProject({ name: 'Site' }), card = await app.board.createTask({ projectId: project.id, title: 'Fix the login form', prompt: 'Fix it.' });
  await app.board.store.update(draft => { draft.runs.push({ id: 'run-k1', taskId: card.id, projectId: project.id, stage: 'executing', status: 'running', createdAt: Date.now() - 60000, updatedAt: Date.now(), config: { provider: 'claude' }, baseManifest: { profiles: [{ resourceId: 'lead', revision: 1 }] } }); });

  const browser = await launch({ width: 1440, height: 1000 }); assert.ok(browser); t.after(() => browser.close());
  const ev = code => browser.eval(code), wait = (expression, label, ms = 20000) => browser.until(expression, label, ms);
  const shots = process.env.PB_NETWORK_SCREENSHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  const shot = async name => { if (shots) await writeFile(join(shots, `${name}.png`), await browser.screenshot()); };
  const noSideways = 'document.documentElement.scrollWidth <= document.documentElement.clientWidth';
  const chipStyle = state => `(() => { const node = document.querySelector('#network-activity-agents .network-state[data-state="${state}"]'); const style = getComputedStyle(node); return [style.color, style.borderTopStyle, node.textContent]; })()`;
  await browser.goto(`${app.url}/#/network/activity`);
  const styles = {};
  for (const theme of ['light', 'dark']) {
    await ev(`localStorage.setItem('ste-prompt-engineer.theme', ${J(theme)});`);
    await browser.reload();
    await browser.resize(1440, 1000);
    await wait(`(document.documentElement.dataset.theme || 'light') === ${J(theme)} && document.querySelector('#network-activity-live')?.dataset.state === 'live' && document.querySelectorAll('#network-activity-agents > li').length === 4 && document.querySelectorAll('#network-activity-kanban > li').length === 1`, `${theme}: Activity is live`);
    assert.equal(await browser.layout(`const feed = document.querySelector('.network-activity-feed').getBoundingClientRect(), side = document.querySelector('.network-activity-side').getBoundingClientRect();
      return ${noSideways} && side.left >= feed.right && feed.width > side.width;`), true, `${theme}: timeline beside the queue at 1440`);
    styles[theme] = { waiting: await ev(`return ${chipStyle('waiting')};`), unknown: await ev(`return ${chipStyle('unknown')};`), running: await ev(`return ${chipStyle('running')};`) };
    assert.notEqual(styles[theme].waiting[0], styles[theme].unknown[0], `${theme}: waiting and unknown differ in colour`);
    assert.deepEqual([styles[theme].waiting[1], styles[theme].unknown[1]], ['solid', 'dashed'], `${theme}: and in their border`);
    assert.ok(styles[theme].waiting[2].startsWith('⏸') && styles[theme].unknown[2].startsWith('?'), 'and in their mark');
    assert.equal(await ev(`return document.querySelector('#network-panel-activity').innerText.includes('%');`), false, 'no percentage anywhere');
    await shot(`activity-1440-${theme}`);
    // Live: a new event shows without a reload.
    const { seq } = await app.networkEvents.append({ type: 'job.activity', jobId: busy.jobId, agentId: agents.lead.id, kind: 'tool', label: `Read: notes (${theme})` });
    await wait(`document.querySelector('#network-activity-feed [data-seq="${seq}"]')?.textContent.includes('Read: notes (${theme})')`, `${theme}: live event`);
    // Phone: one column, nothing sideways; the queue first.
    await browser.resize(390, 844);
    assert.equal(await browser.layout(`const feed = document.querySelector('.network-activity-feed').getBoundingClientRect(), side = document.querySelector('.network-activity-side').getBoundingClientRect();
      return ${noSideways} && side.bottom <= feed.top + 1 && feed.width > 300;`), true, `${theme}: one column at 390`);
    await shot(`activity-390-${theme}`);
    await ev(`window.scrollTo(0, document.querySelector('.network-activity-feed').getBoundingClientRect().top + scrollY - 70);`);
    await shot(`activity-390-${theme}-timeline`);
    // One job's record: the heading takes focus; Back returns to the button that opened it.
    await browser.resize(1440, 1000);
    await ev(`document.querySelector('#network-activity-queue [data-open-job="${busy.jobId}"]').click();`);
    await wait(`location.hash === '#/network/activity/${busy.jobId}' && document.activeElement?.id === 'network-activity-job-heading' && document.querySelectorAll('#network-activity-job-events > li').length >= 4`, `${theme}: job record`);
    assert.equal(await browser.layout(`return ${noSideways} && document.querySelector('#network-activity-overview').hidden;`), true);
    assert.match(await ev(`return document.querySelector('#network-activity-job').innerText;`), /Usage: not reported/);
    await shot(`activity-job-1440-${theme}`);
    await browser.resize(390, 844); await shot(`activity-job-390-${theme}`); await browser.resize(1440, 1000);
    await ev(`document.querySelector('#network-activity-back').click();`);
    await wait(`location.hash === '#/network/activity' && document.activeElement?.dataset.openJob === ${J(busy.jobId)}`, `${theme}: focus back on Details`);
    // The agent's own Activity tab.
    await ev(`location.hash = '#/network/agents/${agents.scout.id}';`);
    await wait(`document.querySelector('#network-detail-heading')?.textContent === 'Scout'`, `${theme}: profile`);
    await ev(`document.querySelector('#network-profile-tab-activity').click();`);
    await wait(`!document.querySelector('#network-profile-panel-activity').hidden && /Limited activity/.test(document.querySelector('#network-profile-panel-activity').innerText) && document.querySelectorAll('#network-agent-activity-feed > li').length === 3`, `${theme}: agent activity`);
    await shot(`agent-activity-1440-${theme}`);
    await ev(`location.hash = '#/network/activity';`);
    await wait(`!document.querySelector('#network-panel-activity').hidden`, 'back on Activity');
  }
  assert.notDeepEqual(styles.light.running[0], styles.dark.running[0], 'the chips follow the theme');
  // Keyboard: Tab from the search reaches the timeline's controls with a visible focus ring.
  await ev(`document.querySelector('#network-activity-search').focus();`);
  await browser.key('Tab', 'Tab', 9);
  await wait(`document.activeElement?.closest('#network-activity-feed, .network-activity-feed')`, 'Tab moves into the timeline');
  assert.notEqual(await ev(`return getComputedStyle(document.activeElement).outlineStyle;`), 'none', 'visible focus');
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await wait(`/^#\\/network\\/activity\\/job_/.test(location.hash) && document.activeElement?.id === 'network-activity-job-heading'`, 'Enter opens a job record');
  busy.entry.end();
  // The seeded running Kanban run opens the dock's terminal, whose xterm.js styles the CSP refuses (as on Kanban, unrelated).
  assert.deepEqual(browser.consoleMessages.filter(message => /EXCEPTION|Uncaught|Content Security Policy|Refused/i.test(message) && !message.includes('/vendor/xterm.js')), []);
});
