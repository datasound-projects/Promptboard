// Network page in headless Chrome: list beside the profile at 1440 px, list then profile at 390 px, no sideways scroll,
// light and dark themes, real keyboard (tablist arrows, visible focus, Escape returning focus) and Open in Base; the
// Memory and Posts tabs with the job preview, and report or memory HTML that never runs.
// PB_NETWORK_SCREENSHOTS=<folder> also saves each width and theme as a PNG for a person to look at.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const chrome = await findChrome();
const J = JSON.stringify;

test('Network in Chrome: list and profile side by side or one after the other, both themes, keyboard, Open in Base', { skip: !chrome, timeout: 240000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = async (path, method = 'GET', body) => { const response = await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: J(body) } : {}) }); return response.json(); };
  const site = await app.board.createProject({ name: 'Site' });
  await app.board.base.create({ id: 'lead', kind: 'profile', name: 'Lead', configuration: { agent: { provider: 'claude', model: 'sonnet', instructions: 'Lead the research and quote every source exactly as written.' } } });
  await app.board.base.create({ id: 'reviewer', kind: 'profile', name: 'Reviewer', configuration: { agent: { provider: 'codex' } } });
  await app.board.base.create({ id: 'team', kind: 'agentProfile', name: 'Team', configuration: { agents: [{ resourceId: 'reviewer', role: 'primary' }] } });
  const lead = (await call('/api/network/agents', 'POST', { baseResourceId: 'lead', expectedRevision: 0, displayName: 'A research lead with a rather long display name', tags: ['research'], capabilities: ['research', 'sources'], projectAllowlist: [site.id] })).agent;
  const team = (await call('/api/network/agents', 'POST', { baseResourceId: 'team', expectedRevision: 1, enabled: false })).agent;

  const browser = await launch({ width: 1440, height: 1000 }); assert.ok(browser); t.after(() => browser.close());
  const ev = code => browser.eval(code), wait = (expression, label, ms = 20000) => browser.until(expression, label, ms);
  const shots = process.env.PB_NETWORK_SCREENSHOTS;
  const shot = async name => { if (shots) await writeFile(join(shots, `${name}.png`), await browser.screenshot()); };
  const noSideways = `document.documentElement.scrollWidth <= document.documentElement.clientWidth`;
  const box = selector => `document.querySelector(${J(selector)}).getBoundingClientRect()`;
  const shown = selector => `(() => { const node = document.querySelector(${J(selector)}); return Boolean(node) && getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().height > 0; })()`;
  const colors = {};
  await browser.goto(`${app.url}/#/network`);
  for (const theme of ['light', 'dark']) {
    await ev(`localStorage.setItem('ste-prompt-engineer.theme', ${J(theme)});`);
    await browser.reload();
    await browser.resize(1440, 1000);
    await ev(`location.hash = '#/network/agents/${lead.id}';`);
    await wait(`(document.documentElement.dataset.theme || 'light') === ${J(theme)} && document.querySelector('#network-detail-heading')?.textContent.startsWith('A research lead') && document.querySelectorAll('#network-list [data-agent-id]').length === 2`, `${theme} profile at 1440`);
    // Wide: the directory and the profile sit side by side, top-aligned, with nothing scrolling sideways.
    assert.equal(await browser.layout(`const list = ${box('.network-list-panel')}, detail = ${box('#network-detail')};
      return ${noSideways} && list.width > 250 && detail.left >= list.right && Math.abs(detail.top - list.top) < 40 && detail.width > list.width;`), true, `${theme}: side by side at 1440`);
    assert.equal(await ev(`return document.title;`), 'Network · Promptboard');
    colors[theme] = await ev(`return [getComputedStyle(document.querySelector('#network-detail')).backgroundColor, getComputedStyle(document.querySelector('.network-agent')).color];`);
    await shot(`network-1440-${theme}-profile`);
    await ev(`location.hash = '#/network/graph';`); await wait(`!document.querySelector('#network-panel-graph').hidden`, 'Graph');
    await shot(`network-1440-${theme}-graph`);

    // Phone: the list first; choosing an agent shows its profile instead (focus moves there); Back returns to the row.
    await browser.resize(390, 844);
    await ev(`location.hash = '#/network';`);
    await wait(`!document.querySelector('#network-panel-agents').hidden`, 'Agents at 390');
    assert.equal(await browser.layout(`return ${noSideways} && ${shown('.network-list-panel')} && ${shown('.network-toolbar')} && !${shown('#network-detail')};`), true, `${theme}: list only at 390`);
    await shot(`network-390-${theme}-list`);
    const point = await ev(`const node = document.querySelector('[data-agent-id="${team.id}"]'); node.scrollIntoView({ block: 'center' }); const r = node.getBoundingClientRect(); return { x: r.left + 40, y: r.top + 20 };`);
    await browser.click(point.x, point.y); // A real tap on the row.
    await wait(`location.hash === '#/network/agents/${team.id}' && document.activeElement?.id === 'network-detail-heading'`, `${theme}: profile focused at 390`);
    assert.equal(await browser.layout(`return ${noSideways} && ${shown('#network-detail')} && !${shown('.network-list-panel')} && !${shown('.network-toolbar')} && ${shown('.network-back')};`), true, `${theme}: profile only at 390`);
    await shot(`network-390-${theme}-profile`);
    await ev(`document.querySelector('.network-back').click();`);
    await wait(`location.hash === '#/network' && document.activeElement?.dataset.agentId === ${J(team.id)}`, `${theme}: back to the chosen row`);
    assert.equal(await browser.layout(`return ${noSideways} && ${shown('.network-list-panel')} && !${shown('#network-detail')};`), true);
  }
  assert.notDeepEqual(colors.light, colors.dark, 'the profile follows the theme');

  // Keyboard in a real browser: arrows move between section tabs with a visible focus ring; Escape closes the dialog
  // and returns focus to the button that opened it.
  await browser.resize(1440, 1000);
  await ev(`location.hash = '#/network';`); await wait(`!document.querySelector('#network-panel-agents').hidden`, 'Agents');
  await ev(`document.querySelector('#network-tab-agents').focus();`);
  await browser.key('ArrowRight', 'ArrowRight', 39);
  await wait(`location.hash === '#/network/graph' && document.activeElement?.id === 'network-tab-graph' && document.activeElement.getAttribute('aria-selected') === 'true'`, 'ArrowRight to Graph');
  assert.notEqual(await ev(`return getComputedStyle(document.activeElement).outlineStyle;`), 'none', 'visible focus');
  await browser.key('ArrowLeft', 'ArrowLeft', 37);
  await wait(`location.hash === '#/network' && document.activeElement?.id === 'network-tab-agents' && !document.querySelector('#network-panel-agents').hidden`, 'ArrowLeft to Agents');
  await ev(`document.querySelector('#network-register').focus();`);
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); // Activates the focused button.
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await wait(`document.querySelector('#network-dialog').open && document.querySelector('#network-form-base') && document.activeElement?.id === 'network-form-base'`, 'register dialog by keyboard');
  await shot('network-1440-dark-register');
  await browser.key('Escape', 'Escape', 27);
  await wait(`!document.querySelector('#network-dialog').open && document.activeElement?.id === 'network-register'`, 'Escape returns focus');

  // Open in Base: Base's own editor on the real resource; Back returns to the profile.
  await ev(`location.hash = '#/network/agents/${lead.id}';`); await wait(`document.querySelector('#network-open-base')`, 'profile');
  await ev(`document.querySelector('#network-open-base').click();`);
  await wait(`location.hash === '#/base' && document.querySelector('#base-resource-name')?.value === 'Lead' && document.querySelector('.base-resource-form').dataset.kind === 'profile'`, 'Lead open in Base');
  await ev(`history.back();`);
  await wait(`location.hash === '#/network/agents/${lead.id}' && document.querySelector('#network-detail-heading')`, 'back to the profile');
  assert.deepEqual(browser.consoleMessages.filter(message => /EXCEPTION|Uncaught|Content Security Policy/i.test(message)), []);
});

test('Memory and Posts in Chrome: both themes at 1440 and 390 px, keyboard, the preview, and report HTML that never runs', { skip: !chrome, timeout: 240000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = async (path, method = 'GET', body) => { const response = await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: J(body) } : {}) }); return response.json(); };
  const site = await app.board.createProject({ name: 'Site' });
  await mkdir(join(app.board.dataDir, 'lessons'), { recursive: true });
  await writeFile(join(app.board.dataDir, 'lessons', `${site.id}.json`), J({ schema: 'promptboard.lessons', version: 1, projectId: site.id, revision: 1, settings: { enabled: true, provider: '', model: '' },
    lessons: [{ id: 'l1', kind: 'command', text: 'Run the tests with npm test before a merge.', evidence: '', taskId: 't1', taskNumber: 1, status: 'approved', createdAt: 1, decidedAt: 2 }], jobs: [] }));
  await app.board.base.create({ id: 'lead', kind: 'profile', name: 'Lead', configuration: { agent: { provider: 'claude', model: 'sonnet' } } });
  const lead = (await call('/api/network/agents', 'POST', { baseResourceId: 'lead', expectedRevision: 0, displayName: 'Research lead', projectAllowlist: [site.id] })).agent;
  const root = `/api/network/agents/${lead.id}`;
  const add = async (kind, text, approve) => {
    const { revision } = await call(`${root}/memory`);
    const { record } = await call(`${root}/memory`, 'POST', { expectedRevision: revision, kind, text });
    if (approve) await call(`${root}/memory/${record.id}/approve`, 'POST', { expectedRevision: 1, decision: 'approve' });
  };
  await add('fact', 'The client is Acme Ltd. Their brand name is always written in capitals: ACME.', true);
  await add('procedure', 'Quote every source exactly as written.\nAdd the date you read it.\nNever paraphrase a number.', true);
  await add('preference', 'Short answers first, details after a blank line. <img src=x onerror="window.__pwned = 1">', false);
  await call(`${root}/posts`, 'POST', { expectedRevision: 0, markdown: '## Week 1\n**Shipped** the weekly digest.\n\n- Sources quoted exactly\n- `npm test` green\n\n<img src=x onerror="window.__pwned = 2"><script>window.__pwned = 3</script>', references: ['Card #12', 'https://example.com/run'] });

  const browser = await launch({ width: 1440, height: 1000 }); assert.ok(browser); t.after(() => browser.close());
  const ev = code => browser.eval(code), wait = (expression, label, ms = 20000) => browser.until(expression, label, ms);
  const shots = process.env.PB_NETWORK_SCREENSHOTS;
  const shot = async name => { if (shots) await writeFile(join(shots, `${name}.png`), await browser.screenshot()); };
  const noSideways = `document.documentElement.scrollWidth <= document.documentElement.clientWidth`;
  const tab = id => `document.querySelector('#network-profile-tab-${id}').click();`;
  await browser.goto(`${app.url}/#/network`);
  for (const theme of ['light', 'dark']) {
    await ev(`localStorage.setItem('ste-prompt-engineer.theme', ${J(theme)});`);
    await browser.reload();
    for (const [width, height] of [[1440, 1300], [390, 844]]) {
      await browser.resize(width, height);
      await ev(`location.hash = '#/network/agents/${lead.id}';`);
      await wait(`(document.documentElement.dataset.theme || 'light') === ${J(theme)} && document.querySelector('#network-detail-heading')?.textContent === 'Research lead'`, `${theme} profile at ${width}`);
      await ev(tab('memory'));
      await wait(`document.querySelectorAll('#network-memory-list .network-record').length === 3 && /2 approved/.test(document.querySelector('.network-memory-counts').textContent) && /Acme/.test(document.querySelector('#network-preview-text').textContent)`, `${theme} memory at ${width}`);
      assert.equal(await browser.layout(`return ${noSideways} && document.querySelector('#network-memory-list').getBoundingClientRect().width > 250;`), true, `${theme}: memory fits at ${width}`);
      await ev(`window.scrollTo(0, 0); document.querySelector('#network-profile-tabs, .network-profile-tabs').scrollIntoView({ block: 'start' });`);
      await shot(`memory-${width}-${theme}`);
      // The preview with the project's lessons allowed: exactly what a job would receive, and why.
      await ev(`const project = document.querySelector('#network-preview-project'); project.value = ${J(site.id)}; project.dispatchEvent(new Event('change', { bubbles: true }));`);
      await wait(`!document.querySelector('#network-preview-lessons').disabled`, 'project chosen');
      await ev(`document.querySelector('#network-preview-lessons').click();`);
      await wait(`/npm test before a merge/.test(document.querySelector('#network-preview-text').textContent)`, `${theme}: lessons in the preview at ${width}`);
      assert.equal(await browser.layout(`return ${noSideways};`), true);
      await ev(`document.querySelector('#network-preview-reasons').scrollIntoView({ block: 'start' });`);
      await shot(`memory-preview-${width}-${theme}`);
      await ev(`document.querySelector('#network-preview-lessons').click(); const project = document.querySelector('#network-preview-project'); project.value = ''; project.dispatchEvent(new Event('change', { bubbles: true }));`);
      await ev(tab('posts'));
      await wait(`document.querySelector('#network-post-list .network-post .network-post-body strong')?.textContent === 'Shipped'`, `${theme} posts at ${width}`);
      assert.equal(await browser.layout(`return ${noSideways} && !document.querySelector('#network-post-list img, #network-post-list script');`), true, `${theme}: posts fit at ${width}`);
      await ev(`document.querySelector('.network-profile-tabs').scrollIntoView({ block: 'start' });`);
      await shot(`posts-${width}-${theme}`);
      await ev(tab('profile'));
    }
  }
  assert.equal(await ev(`return window.__pwned;`), undefined, 'no HTML from memory or a report ran');
  // Keyboard: the profile tabs by arrows; Add memory by Enter, Escape returns focus; the dialog in both widths.
  await browser.resize(1440, 1000);
  await ev(`location.hash = '#/network/agents/${lead.id}';`); await wait(`document.querySelector('#network-profile-tab-profile')`, 'profile');
  await ev(`document.querySelector('#network-profile-tab-profile').focus();`);
  for (let n = 0; n < 3; n++) await browser.key('ArrowRight', 'ArrowRight', 39);
  await wait(`document.activeElement?.id === 'network-profile-tab-memory' && !document.querySelector('#network-profile-panel-memory').hidden`, 'ArrowRight to Memory');
  assert.notEqual(await ev(`return getComputedStyle(document.activeElement).outlineStyle;`), 'none', 'visible focus');
  await ev(`document.querySelector('#network-memory-add').focus();`);
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); // Activates the focused button.
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await wait(`document.querySelector('#network-dialog').open && document.activeElement?.id === 'network-memory-form-text'`, 'Add memory by keyboard');
  await browser.type('Typed by keyboard.');
  await shot('memory-add-1440-dark');
  await browser.key('Escape', 'Escape', 27);
  await wait(`!document.querySelector('#network-dialog').open && document.activeElement?.id === 'network-memory-add'`, 'Escape returns focus');
  await browser.resize(390, 844);
  await ev(`document.querySelector('#network-profile-tab-posts').click(); document.querySelector('#network-post-write').click();`);
  await wait(`document.querySelector('#network-dialog').open && document.activeElement?.id === 'network-post-form-markdown'`, 'Write a report at 390');
  assert.equal(await browser.layout(`const box = document.querySelector('#network-dialog').getBoundingClientRect(); return ${noSideways} && box.right <= innerWidth && box.left >= 0;`), true, 'the dialog fits a phone');
  await shot('post-write-390-dark');
  await browser.key('Escape', 'Escape', 27);
  assert.deepEqual(browser.consoleMessages.filter(message => /EXCEPTION|Uncaught|Content Security Policy/i.test(message)), []);
});
