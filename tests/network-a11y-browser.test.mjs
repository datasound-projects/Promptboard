// Network accessibility in headless Chrome (Task 14 item 7), with the keyboard only: every section (Agents and an agent's
// five profile tabs, Graph and its editor, Pipelines with the designer and a run, Activity and a job's record, Library and
// a network, Federation, Settings) in light and dark at 1440 and 390 px. A small in-page check (no dependency; the
// DevTools command-line API's getEventListeners finds click handlers) asks of every visible control: an accessible name,
// a handler unless it is disabled with a reason, aria references that resolve, tabs with panels, errors in alert
// regions, unique IDs. Tab walks each view: focus is always visible, named and ringed, and it leaves the view (no trap).
// Dialogs open by Enter, trap Tab and Shift+Tab, and give focus back on Escape; a form submitted empty moves focus to its
// field or its error. Graph and Pipelines fall back to lists on a phone. The privacy notes where data leaves this computer
// (a provider CLI, an A2A peer, an external client) and the Graph/Pipeline difference are on the page.
// PB_NETWORK_SCREENSHOTS=<folder> saves the screenshots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';
import { fakeWorker } from './helpers/network-worker.mjs';

const chrome = await findChrome();
const J = JSON.stringify;
const hex = text => createHash('sha256').update(text).digest('hex');
const N = name => `n_${hex(`step:${name}`).slice(0, 12)}`;

/** Installs window.__a11y in the page: the accessible name (aria-labelledby, aria-label, <label>, content, title) and the checks. */
function install() {
  if (window.__a11y) return;
  const text = node => [...node.childNodes].map(child => (child.nodeType === 3 ? child.textContent
    : child.nodeType === 1 && child.getAttribute('aria-hidden') !== 'true' && !['SELECT', 'STYLE', 'SCRIPT'].includes(child.tagName) ? (child.tagName === 'IMG' ? child.alt || '' : text(child)) : '')).join('');
  const refText = ids => (ids || '').trim().split(/\s+/).filter(Boolean).map(id => document.getElementById(id)).filter(Boolean).map(text).join(' ').trim();
  const name = node => {
    const by = refText(node.getAttribute('aria-labelledby')); if (by) return by;
    const aria = (node.getAttribute('aria-label') || '').trim(); if (aria) return aria;
    if (node.labels?.length) { const label = [...node.labels].map(text).join(' ').trim(); if (label) return label; }
    if (!['INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName)) { const own = text(node).trim(); if (own) return own; }
    return (node.getAttribute('title') || '').trim();
  };
  const shown = node => { const box = node.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(node).visibility !== 'hidden'; };
  const describe = node => `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${typeof node.className === 'string' && node.className.trim() ? `.${node.className.trim().split(/\s+/).join('.')}` : ''}${node.dataset.tab ? `[tab=${node.dataset.tab}]` : ''} “${text(node).trim().slice(0, 50) || node.getAttribute('aria-label') || ''}”`;
  const ring = node => { const style = getComputedStyle(node); return (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none'; };
  const INTERACTIVE = 'button, a[href], input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"]), [role="tab"], [role="button"], [role="switch"], [role="link"], [role="checkbox"]';
  const CLICKS = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'];
  // eslint-disable-next-line no-undef -- getEventListeners is the DevTools command-line API (includeCommandLineAPI).
  const listens = (node, types) => { const all = getEventListeners(node); return types.some(type => all[type]?.length); };
  /** A control is live when it, or an ancestor below <body> (delegation), handles clicks, or it submits a form that is handled. */
  const live = node => {
    for (let at = node; at && at !== document.body && at !== document.documentElement; at = at.parentElement) if (listens(at, CLICKS)) return true;
    return node.type === 'submit' && Boolean(node.form) && listens(node.form, ['submit']);
  };
  const reason = node => (node.getAttribute('title') || '').trim() || refText(node.getAttribute('aria-describedby'));
  function audit(selectors) {
    const problems = [], roots = selectors.flatMap(selector => [...document.querySelectorAll(selector)]), seen = new Set();
    for (const root of roots) {
      for (const node of root.querySelectorAll(INTERACTIVE)) {
        if (seen.has(node) || !shown(node) || node.closest('[inert]')) continue;
        seen.add(node);
        const what = describe(node), role = node.getAttribute('role');
        if (!name(node)) problems.push(`no accessible name: ${what}`);
        const pressable = node.tagName === 'BUTTON' || role === 'button' || role === 'tab';
        if (!pressable) continue;
        if (node.disabled || node.getAttribute('aria-disabled') === 'true') { if (!reason(node)) problems.push(`disabled without a reason: ${what}`); }
        else if (!live(node)) problems.push(`dead control (nothing handles a click): ${what}`);
      }
      for (const node of root.querySelectorAll('[aria-labelledby], [aria-describedby], [aria-controls]')) {
        for (const attribute of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
          for (const id of (node.getAttribute(attribute) || '').split(/\s+/).filter(Boolean)) if (!document.getElementById(id)) problems.push(`${attribute} names a missing element “${id}”: ${describe(node)}`);
        }
      }
      for (const node of root.querySelectorAll('[role="tab"]')) if (!['true', 'false'].includes(node.getAttribute('aria-selected')) || !node.getAttribute('aria-controls')) problems.push(`tab without aria-selected or aria-controls: ${describe(node)}`);
      for (const node of root.querySelectorAll('[role="tabpanel"]')) if (!name(node)) problems.push(`tab panel without a name: ${describe(node)}`);
      for (const node of root.querySelectorAll('[aria-expanded]')) if (!['true', 'false'].includes(node.getAttribute('aria-expanded'))) problems.push(`aria-expanded is not true or false: ${describe(node)}`);
      // An error line that appears later must be announced when it does: inside role=alert (or aria-live).
      for (const node of root.querySelectorAll('.inline-error')) if (!node.closest('[role="alert"], [aria-live]') && (node.hidden || shown(node))) problems.push(`error line outside an alert region: ${describe(node)}`);
    }
    const ids = new Map();
    for (const node of document.querySelectorAll('[id]')) ids.set(node.id, (ids.get(node.id) || 0) + 1);
    for (const [id, count] of ids) if (count > 1 && id.startsWith('network')) problems.push(`duplicate id “${id}” (${count} elements)`);
    return problems;
  }
  /** The focused element as a Tab walk sees it. */
  function focused(rootSelector) {
    const node = document.activeElement, root = document.querySelector(rootSelector);
    if (!node || node === document.body || !root?.contains(node)) return { out: true, at: node ? describe(node) : 'nothing' };
    window.__a11yKeys = window.__a11yKeys || new WeakMap();
    if (!window.__a11yKeys.has(node)) window.__a11yKeys.set(node, window.__a11yKeys.size || Math.random());
    const box = node.getBoundingClientRect();
    return { out: false, key: describe(node) + (node.dataset.a11yKey ||= String(Math.random()).slice(2)), what: describe(node), name: name(node), shown: shown(node),
      onScreen: box.right > 0 && box.bottom > 0 && box.left < innerWidth && box.top < innerHeight, ring: ring(node) };
  }
  window.__a11y = { audit, focused, name, shown, describe, ring };
}

test('Network keyboard and screen-reader basics in Chrome: every section in both themes at 1440 and 390 px, dialogs, focused errors, phone lists, privacy notes', { skip: !chrome, timeout: 900000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, networkWorker: fakeWorker({ text: job => `## Result\n\nDone: ${job.request.input.text.slice(0, 40)}` }) });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: J(body) } : {}) });
    const data = await response.json();
    assert.ok(response.ok, `${method} ${path}: ${J(data).slice(0, 300)}`);
    return data;
  };
  // Seed: three registered agents, a published network with a delegate relation, a draft that nests it, a published
  // pipeline with a run waiting for its approval, a completed job, memory, a report, a schedule, a client, outbound on.
  await app.board.createProject({ name: 'Site' });
  const site = (await app.board.state()).projects[0];
  const agents = [];
  for (const [id, name, provider] of [['lead', 'Research lead', 'claude'], ['scout', 'Scout', 'codex'], ['gem', 'Gemini helper', 'gemini']]) {
    await app.board.base.create({ id, kind: 'profile', name, configuration: { agent: { provider, instructions: `${name} instructions.` } } });
    agents.push((await call('/api/network/agents', 'POST', { baseResourceId: id, expectedRevision: (await call('/api/network/agents')).revision, projectAllowlist: [site.id] })).agent);
  }
  const [lead, scout] = agents;
  const { network: desk } = await call('/api/network/networks', 'POST', { name: 'Desk', nodes: [lead, scout].map((agent, i) => ({ id: N(`desk${i}`), type: 'agent', agentId: agent.id, position: { x: i * 220, y: 0 } })),
    edges: [{ id: `e_${hex('desk-edge').slice(0, 12)}`, from: N('desk0'), to: N('desk1'), relation: 'delegate' }] });
  await call(`/api/network/networks/${desk.id}/publish`, 'POST', { expectedRevision: desk.revision });
  await call('/api/network/networks', 'POST', { name: 'Team', nodes: [{ id: N('team0'), type: 'agent', agentId: lead.id, position: { x: 0, y: 0 } }, { id: N('team1'), type: 'subnetwork', networkId: desk.id, version: 1, position: { x: 240, y: 0 } }], edges: [] });
  const step = (name, type, config) => ({ id: N(name), type, label: name, position: { x: 0, y: 0 }, config });
  const { pipeline } = await call('/api/network/pipelines', 'POST', { networkId: desk.id, networkVersion: 1, name: 'Brief',
    nodes: [step('research', 'agent', { agentId: scout.id, instructions: 'Research it.' }), step('gate', 'approval', { prompt: 'Keep it?' }), step('report', 'output', { include: [N('research')] })],
    edges: [{ id: `e_${hex('p1').slice(0, 12)}`, from: N('research'), to: N('gate'), fromPort: 'text' }, { id: `e_${hex('p2').slice(0, 12)}`, from: N('gate'), to: N('report'), fromPort: 'done' }] });
  await call(`/api/network/pipelines/${pipeline.id}/publish`, 'POST', { expectedRevision: pipeline.revision });
  const { run } = await call(`/api/network/pipelines/${pipeline.id}/runs`, 'POST', { version: 1, confirm: true, input: { text: 'Pricing pages' } });
  for (let tries = 0; (await call(`/api/network/pipeline-runs/${run.id}`)).run.status !== 'waiting_for_approval'; tries++) { assert.ok(tries < 300, 'the run waits for its approval'); await new Promise(resolve => setTimeout(resolve, 20)); }
  const { jobId } = await call('/api/network/jobs', 'POST', { agentId: lead.id, input: { text: 'Summarise the release notes.' } });
  for (let tries = 0; (await call(`/api/network/jobs/${jobId}`)).job.status !== 'completed'; tries++) { assert.ok(tries < 300, 'the job completes'); await new Promise(resolve => setTimeout(resolve, 20)); }
  await call(`/api/network/agents/${lead.id}/memory`, 'POST', { expectedRevision: 0, kind: 'fact', text: 'The release notes live in CHANGELOG.md.' });
  await call(`/api/network/agents/${lead.id}/posts`, 'POST', { expectedRevision: 0, markdown: '## Weekly report\n\nAll good.', references: [] });
  await call('/api/network/schedules', 'POST', { expectedRevision: 0, name: 'Morning digest', target: { agentId: lead.id, input: { text: 'Summarise.' } }, cadence: { kind: 'weekdays', time: '07:30' } });
  await call('/api/network/clients', 'POST', { name: 'Claude Code on this Mac', scopes: { agents: [lead.id], projects: [], permissions: ['read_agents', 'submit_jobs', 'read_job_result'] } });
  await call('/api/network/listener', 'PATCH', { enabled: true, port: 0 });
  await call('/api/network/federation/outbound', 'PATCH', { expectedRevision: (await call('/api/network/federation')).revision, enabled: true });

  const browser = await launch({ width: 1440, height: 1000 }); assert.ok(browser); t.after(() => browser.close());
  const ev = code => browser.eval(code), wait = (expression, label, ms = 20000) => browser.until(expression, label, ms);
  const shots = process.env.PB_NETWORK_SCREENSHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  const shot = async name => { if (shots) await writeFile(join(shots, `${name}.png`), await browser.screenshot()); };
  const page = async expression => {
    const result = await browser.send('Runtime.evaluate', { expression: `(async () => { (${install})(); ${expression} })()`, includeCommandLineAPI: true, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const press = async (key, code, keyCode, { shift = false, text } = {}) => {
    const modifiers = shift ? 8 : 0;
    await browser.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers, ...(text ? { text } : {}) });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers });
  };
  const tab = (shift = false) => press('Tab', 'Tab', 9, { shift });
  const enter = () => press('Enter', 'Enter', 13, { text: '\r' });
  const escape = () => press('Escape', 'Escape', 27);
  const problems = [];
  const report = (where, list) => { for (const item of list) problems.push(`${where}: ${item}`); };
  const audit = (where, selectors = ['#network-view']) => page(`return window.__a11y.audit(${J(selectors)});`).then(list => report(where, list));
  const active = () => page(`const node = document.activeElement; return node ? window.__a11y.describe(node) : 'nothing';`);

  /** Tab through `root` from where focus is: every stop is visible, named and ringed; focus leaves the view (no trap). */
  async function walk(where, root = '#network-view', max = 400) {
    const keys = new Set();
    for (let stop = 0; stop < max; stop++) {
      await tab();
      const at = await page(`return window.__a11y.focused(${J(root)});`);
      if (at.out) return stop;
      if (keys.has(at.key)) { report(where, [`focus cycles back to ${at.what} (a keyboard trap)`]); return stop; }
      keys.add(at.key);
      if (!at.shown || !at.onScreen) report(where, [`focus lands on something not visible: ${at.what}`]);
      if (!at.name) report(where, [`focus lands on a control without a name: ${at.what}`]);
      if (!at.ring) report(where, [`no visible focus ring on ${at.what}`]);
    }
    report(where, [`Tab never left the view after ${max} stops`]);
    return max;
  }
  /** Tab (forwards) until the focused element matches `selector`: proves it is reachable by keyboard. */
  async function tabTo(selector, where, max = 400) {
    for (let stop = 0; stop < max; stop++) {
      if (await page(`return Boolean(document.activeElement?.matches(${J(selector)}));`)) return true;
      await tab();
    }
    report(where, [`${selector} cannot be reached with Tab`]);
    return false;
  }
  const focusTab = id => page(`document.querySelector('#network-tab-${id}').focus(); return true;`);
  /** Open a dialog from `opener` with Enter; check it is modal, named, inside the screen and traps Tab both ways; Escape returns focus. */
  async function dialog(where, opener, { before = null, fill = null } = {}) {
    if (!(await tabTo(opener, where))) return;
    await enter();
    const open = await browser.until(`[...document.querySelectorAll('dialog')].some(node => node.open)`, `${where}: dialog opens`, 10000).catch(() => false);
    if (!open) { report(where, [`Enter on ${opener} opened no dialog`]); return; }
    const info = await page(`const box = [...document.querySelectorAll('dialog')].find(node => node.open), rect = box.getBoundingClientRect();
      const stops = [...box.querySelectorAll('button, a[href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])')].filter(node => !node.disabled && window.__a11y.shown(node));
      return { id: box.id, modal: box.matches(':modal'), inside: box.contains(document.activeElement), name: window.__a11y.name(box), within: rect.left >= -1 && rect.right <= innerWidth + 1 && rect.top >= -1 && rect.width > 0, stops: stops.length, open: [...document.querySelectorAll('dialog')].filter(node => node.open).length };`);
    if (!info.modal) report(where, [`dialog #${info.id} is not modal`]);
    if (!info.inside) report(where, [`dialog #${info.id} opened without focus inside it (${await active()})`]);
    if (!info.name) report(where, [`dialog #${info.id} has no name`]);
    if (!info.within) report(where, [`dialog #${info.id} is not inside the screen`]);
    if (info.open !== 1) report(where, [`${info.open} dialogs are open at once`]);
    await audit(`${where} dialog`, ['dialog[open]']);
    for (const shift of [false, true]) {
      for (let stop = 0; stop < info.stops + 2; stop++) {
        await tab(shift);
        if (!(await page(`const box = [...document.querySelectorAll('dialog')].find(node => node.open); return Boolean(box?.contains(document.activeElement));`))) { report(where, [`${shift ? 'Shift+' : ''}Tab leaves dialog #${info.id} to ${await active()}`]); break; }
      }
    }
    if (before) await before();
    if (fill) await fill(info);
    await escape();
    const closed = await browser.until(`![...document.querySelectorAll('dialog')].some(node => node.open)`, `${where}: Escape closes`, 5000).catch(() => false);
    if (!closed) { report(where, [`Escape does not close dialog #${info.id}`]); await page(`for (const node of document.querySelectorAll('dialog')) if (node.open) node.close(); return true;`); return; }
    if (!(await page(`return Boolean(document.activeElement?.matches(${J(opener)}));`))) { report(where, [`Escape on #${info.id} returns focus to ${await active()}, not ${opener}`]); return; }
    // Opened again at once: the close event the browser queued for the last close must not close it.
    await enter();
    await new Promise(resolve => setTimeout(resolve, 400));
    if (!(await page(`return [...document.querySelectorAll('dialog')].some(node => node.open && node.contains(document.activeElement));`))) report(where, [`dialog #${info.id} opened again at once closes by itself or loses focus`]);
    await escape();
    await browser.until(`![...document.querySelectorAll('dialog')].some(node => node.open)`, `${where}: closed again`, 5000).catch(() => report(where, [`Escape does not close #${info.id} the second time`]));
  }
  /** Submit a form in an open dialog empty with the keyboard: focus must move to a field or the error, which is announced. */
  async function emptySubmit(where, opener, submit) {
    if (!(await tabTo(opener, where))) return;
    await enter();
    if (!(await browser.until(`[...document.querySelectorAll('dialog')].some(node => node.open)`, `${where}: dialog`, 10000).catch(() => false))) { report(where, [`${opener} opened no dialog`]); return; }
    if (!(await tabTo(`dialog[open] ${submit}`, where))) { await escape(); return; }
    await enter();
    const shownError = await browser.until(`[...document.querySelectorAll('dialog[open] [role="alert"]')].some(node => !node.hidden && node.textContent.trim())`, `${where}: error`, 10000).catch(() => false);
    const at = await page(`const node = document.activeElement, box = document.querySelector('dialog[open]');
      return { inDialog: Boolean(box?.contains(node)), field: Boolean(node?.matches('input, select, textarea')), alert: Boolean(node?.closest('[role="alert"]')), what: node ? window.__a11y.describe(node) : 'nothing' };`);
    if (!shownError) report(where, ['an empty submit shows no error in an alert region']);
    if (!at.inDialog || !(at.field || at.alert)) report(where, [`after a refused submit, focus is on ${at.what}, not on a field or the error`]);
    await escape();
    await browser.until(`![...document.querySelectorAll('dialog')].some(node => node.open)`, `${where}: closed`, 5000).catch(() => {});
  }

  const SECTIONS = ['agents', 'graph', 'pipelines', 'activity', 'library', 'federation', 'settings'];
  const ready = {
    agents: `document.querySelectorAll('#network-list [data-agent-id]').length === 3`,
    graph: `!document.querySelector('#network-panel-graph').hidden && document.querySelectorAll('#network-panel-graph [data-network-id], #network-graph-editor:not([hidden])').length > 0`,
    pipelines: `document.querySelectorAll('#network-pipelines-list [data-pipeline-id]').length === 1`,
    activity: `document.querySelectorAll('#network-schedules-list > li').length === 1 && /live|Live/.test(document.querySelector('.network-activity-live, [id^="network-activity-live"]')?.textContent || 'live')`,
    library: `document.querySelectorAll('#network-library-list [data-network-id]').length === 2`,
    federation: `/^On/.test(document.querySelector('#network-federation-outbound-status')?.textContent || '')`,
    settings: `/^On at http/.test(document.querySelector('#network-listener-status')?.textContent || '')`,
  };
  const noSideways = 'document.documentElement.scrollWidth <= document.documentElement.clientWidth';
  await browser.goto(`${app.url}/#/network`);
  for (const theme of ['light', 'dark']) {
    for (const width of [1440, 390]) {
      const where = `${theme} ${width}`;
      await ev(`localStorage.setItem('ste-prompt-engineer.theme', ${J(theme)}); location.hash = '#/network';`);
      await browser.reload();
      await browser.resize(width, width === 390 ? 844 : 1000);
      await wait(`(document.documentElement.dataset.theme || 'light') === ${J(theme)} && ${ready.agents}`, `${where}: Agents`);
      // The page's own regions, once per pass.
      const regions = await page(`return [document.querySelector('#network-status')?.getAttribute('role'), document.querySelector('#network-error')?.getAttribute('role'), document.querySelector('[role="tablist"][aria-label="Network sections"]') ? 'tablist' : null];`);
      assert.deepEqual(regions, ['status', 'alert', 'tablist'], `${where}: status, alert and the section tablist`);
      await focusTab('agents');
      // Sections in order with the arrow keys on the tablist, each walked with Tab.
      for (const [index, section] of SECTIONS.entries()) {
        if (index) { await focusTab(SECTIONS[index - 1]); await press('ArrowRight', 'ArrowRight', 39); }
        await wait(`location.hash.startsWith(${J(section === 'agents' ? '#/network' : `#/network/${section}`)}) && document.activeElement?.id === 'network-tab-${section}' && ${ready[section]}`, `${where}: ${section} by ArrowRight`);
        if (!(await ev(`return ${noSideways};`))) report(`${where} ${section}`, ['the page scrolls sideways']);
        await audit(`${where} ${section}`);
        await walk(`${where} ${section}`);
        await shot(`a11y-${section}-${width}-${theme}`);
      }

      const phone = width === 390, settle = () => new Promise(resolve => setTimeout(resolve, 250));
      const view = async (name, root = '#network-view') => { await settle(); await audit(`${where} ${name}`); await walk(`${where} ${name}`, root); await shot(`a11y-${name.replace(/\W+/g, '-')}-${width}-${theme}`); };
      const start = async (section, hash = section === 'agents' ? '#/network' : `#/network/${section}`) => { await ev(`location.hash = ${J(hash)};`); await wait(ready[section], `${where}: ${section} again`); await focusTab(section); };
      const mark = (container, text) => page(`const node = [...document.querySelectorAll(${J(`${container} button`)})].find(item => item.textContent.trim() === ${J(text)}); if (node) node.dataset.a11yMark = ${J(text)}; return Boolean(node);`);
      /** Phone: a list row opens one item's details (no canvas), and Back gives focus to that row again. */
      async function phoneList(name, canvas, row, details, back = 'Back to the lists') {
        if (!(await ev(`const node = document.querySelector(${J(canvas)}); return !node || node.getBoundingClientRect().height === 0 || getComputedStyle(node).display === 'none';`))) report(`${where} ${name}`, [`${canvas} shows on a phone instead of the list`]);
        if (!(await tabTo(row, `${where} ${name}`))) return;
        const key = await page(`return document.activeElement.dataset.stepId || document.activeElement.dataset.nodeId;`);
        await enter();
        if (!(await browser.until(`Boolean([...document.querySelectorAll(${J(`${details} button`)})].find(item => item.textContent.trim() === ${J(back)}))`, 'details', 5000).catch(() => false))) { report(`${where} ${name}`, ['choosing a row shows no details with Back']); return; }
        await audit(`${where} ${name} details`);
        await mark(details, back);
        if (!(await tabTo(`[data-a11y-mark="${back}"]`, `${where} ${name}`))) return;
        await enter();
        if (!(await browser.until(`document.activeElement?.dataset.stepId === ${J(key)} || document.activeElement?.dataset.nodeId === ${J(key)}`, 'back', 5000).catch(() => false))) report(`${where} ${name}`, [`Back leaves focus on ${await active()}, not on the row`]);
      }

      // Agents: Register; an agent's profile by keyboard (Edit identity, then its five tabs by ArrowRight).
      await start('agents');
      await dialog(`${where} agents`, '#network-register');
      await start('agents');
      if (await tabTo(`[data-agent-id="${lead.id}"]`, `${where} agents`)) {
        await enter();
        await wait(`location.hash === '#/network/agents/${lead.id}' && document.querySelector('#network-detail-heading')`, `${where}: profile`);
        await dialog(`${where} profile`, '#network-edit');
        await tabTo('#network-profile-tab-profile', `${where} profile`);
        for (const [index, id] of ['profile', 'tasks', 'activity', 'memory', 'posts'].entries()) {
          if (index) { await page(`document.querySelector('#network-profile-tab-${['profile', 'tasks', 'activity', 'memory', 'posts'][index - 1]}').focus(); return true;`); await press('ArrowRight', 'ArrowRight', 39); }
          await wait(`!document.querySelector('#network-profile-panel-${id}')?.hidden && document.activeElement?.id === 'network-profile-tab-${id}'`, `${where}: ${id} tab by ArrowRight`);
          await view(`profile ${id}`);
          if (id === 'tasks') {
            // An empty job: the error is announced and focus goes to the text. Then the confirmation names what leaves this computer.
            await tabTo('#network-job-run', `${where} tasks`); await enter();
            if (!(await browser.until(`!document.querySelector('#network-job-form-error').hidden && document.activeElement?.id === 'network-job-input'`, 'job error', 5000).catch(() => false))) report(`${where} tasks`, [`an empty job leaves focus on ${await active()}`]);
            await browser.type('Summarise the release notes.');
            await dialog(`${where} tasks`, '#network-job-run', { fill: async () => {
              const said = await page(`return document.querySelector('dialog[open]').textContent;`);
              if (!/leaves? this computer/i.test(said) || !/Claude Code/.test(said)) report(`${where} tasks`, ['the job confirmation does not say what leaves this computer, and to which provider']);
            } });
          }
          if (id === 'memory') { await dialog(`${where} memory`, '#network-memory-add'); await emptySubmit(`${where} memory`, '#network-memory-add', '#network-memory-form-submit'); }
          if (id === 'posts') await emptySubmit(`${where} posts`, '#network-post-write', '#network-post-form-submit');
          await page(`document.querySelector('#network-profile-tab-${id}').focus(); return true;`);
        }
      }
      // A missing agent: the error is an alert.
      await ev(`location.hash = '#/network/agents/agt_${'0'.repeat(20)}';`);
      await wait(`/Back to agents/.test(document.querySelector('#network-detail')?.textContent || '')`, `${where}: missing agent`);
      await audit(`${where} missing agent`);

      // Graph: the editor of “Desk” chosen by keyboard; Add agent; relations are not execution order; a phone has lists only.
      await start('graph');
      if (await tabTo(`#network-graph-chooser [data-network-id="${desk.id}"]`, `${where} graph`)) {
        await enter();
        await wait(`document.querySelector('#network-graph-heading')?.textContent.includes('Desk') && document.querySelectorAll('#network-graph-nodes [data-node-id]').length === 2`, `${where}: graph editor`);
        await view('graph editor');
        if (!/not execution order/.test(await ev(`return document.querySelector('#network-graph-inert')?.textContent || '';`))) report(`${where} graph`, ['the Graph does not say relations are not execution order']);
        await focusTab('graph');
        await dialog(`${where} graph`, '#network-graph-add-agent');
        if (phone) { await focusTab('graph'); await phoneList('graph', '#network-canvas', '#network-graph-nodes [data-node-id]', '#network-graph-details'); }
      }

      // Library: a network's details by keyboard; New network submitted empty.
      await start('library');
      if (await tabTo(`#network-library-list [data-network-id="${desk.id}"]`, `${where} library`)) {
        await enter();
        await wait(`document.querySelector('#network-library-heading')?.textContent === 'Desk'`, `${where}: library detail`);
        await view('library detail');
      }
      await start('library');
      await emptySubmit(`${where} library`, '#network-library-new', '#network-name-submit');
      await ev(`location.hash = '#/network/library/net_${'0'.repeat(20)}';`);
      await wait(`/Back to networks/.test(document.querySelector('#network-library-detail')?.textContent || '')`, `${where}: missing network`);
      await audit(`${where} missing network`);

      // Pipelines: the designer and a run, by keyboard; the run confirmation says what leaves this computer.
      await start('pipelines');
      await emptySubmit(`${where} pipelines`, '#network-pipelines-new', '#network-pipeline-form-submit');
      await start('pipelines');
      if (await tabTo(`[data-pipeline-id="${pipeline.id}"]`, `${where} pipelines`)) {
        await enter();
        await wait(`document.querySelector('#network-pipeline-heading')?.textContent.includes('Brief') && document.querySelectorAll('#network-pipeline-steps [data-step-id]').length === 3`, `${where}: designer`);
        await view('pipeline designer');
        if (!/Pipeline arrows are execution order/.test(await ev(`return document.querySelector('#network-pipeline-semantics')?.textContent || '';`))) report(`${where} pipelines`, ['the designer does not say arrows are execution order']);
        await focusTab('pipelines');
        await dialog(`${where} pipelines`, '#network-pipeline-run', { fill: async () => {
          await browser.until(`/steps/.test(document.querySelector('#network-run-facts')?.textContent || '')`, 'run facts', 5000).catch(() => {});
          if (!/leaves? this computer/i.test(await page(`return document.querySelector('dialog[open]').textContent;`))) report(`${where} pipelines`, ['the run confirmation does not say what leaves this computer']);
        } });
        if (phone) { await focusTab('pipelines'); await phoneList('pipeline designer', '#network-pipeline-canvas', '#network-pipeline-steps [data-step-id]', '#network-pipeline-details'); }
      }
      await start('pipelines');
      if (await tabTo(`[data-run-id="${run.id}"]`, `${where} pipelines`)) {
        await enter();
        await wait(`location.hash === '#/network/runs/${run.id}' && document.querySelectorAll('#network-run-view [data-step-id]').length >= 3`, `${where}: run view`);
        await view('pipeline run');
        if (phone) { await focusTab('pipelines'); await phoneList('pipeline run', '#network-run-canvas', '#network-run-view [data-step-id]', '#network-run-view', 'Back to the steps'); }
      }

      // Activity: a job's record by keyboard; New schedule (a dialog, then submitted empty).
      await start('activity');
      if (await tabTo(`[data-open-job="${jobId}"]`, `${where} activity`)) {
        await enter();
        await wait(`location.hash === '#/network/activity/${jobId}' && /Completed/.test(document.querySelector('#network-panel-activity')?.textContent || '')`, `${where}: job record`);
        await view('activity job');
      }
      await start('activity');
      await dialog(`${where} activity`, '#network-schedule-new');
      await start('activity');
      await emptySubmit(`${where} activity`, '#network-schedule-new', '#network-schedule-save');

      // Federation: Add peer submitted empty; the peers card says what a peer receives.
      await start('federation');
      await dialog(`${where} federation`, '#network-federation-add-peer');
      await start('federation');
      await emptySubmit(`${where} federation`, '#network-federation-add-peer', '#network-peer-preview');
      if (!/leaves? this computer/i.test(await ev(`return document.querySelector('#network-panel-federation').textContent;`))) report(`${where} federation`, ['Federation does not say what leaves this computer for a peer']);

      // Settings: Create client submitted empty; the page says what a client receives.
      await start('settings');
      await dialog(`${where} settings`, '#network-client-create');
      await start('settings');
      await emptySubmit(`${where} settings`, '#network-client-create', '#network-client-submit');
      if (!/leaves? this computer/i.test(await ev(`return document.querySelector('#network-panel-settings').textContent;`))) report(`${where} settings`, ['Settings does not say what a client may take off this computer']);
      if (await ev(`return [...document.querySelectorAll('dialog')].some(node => node.open || (node.getBoundingClientRect().height > 0 && getComputedStyle(node).display !== 'none'));`)) report(where, ['a dialog stays open or visible after the pass']);
    }
  }
  assert.deepEqual(problems, []);
});
