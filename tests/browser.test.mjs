// Real-browser terminal smoke test (PB-03). Uses headless Chrome through the DevTools
// protocol and fake agent CLIs (SIMULATED providers). Skips when Chrome is not installed.
// Screenshots are written to PB_BROWSER_SHOTS when that variable is set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, launch } from './helpers/browser.mjs';
import { startServer } from '../src/server.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const fake = fileURLToPath(new URL('./fixtures/fake-agent.cjs', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
const chrome = await findChrome();
const skip = process.platform === 'win32' || !chrome ? 'Chrome is not installed or the platform has no PTY support in this test.' : false;

// This scenario includes cold Chrome startup and many sequential persisted UI actions.
// Individual browser.until checks remain bounded; allow slower Windows CI the total budget.
test('Base saved-resource actions, sidebar categories, agent cards and avatar drafts work in real Chrome', { skip: !chrome, timeout: 90000 }, async t => {
  let tests = 0;
  const image = { mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=' };
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [], imageGenerator: async () => image, mcpTester: async () => {
    if (++tests === 2) throw Object.assign(new Error('Fixture failure'), { code: 'BASE_MCP_FAILED' });
    return { status: 'connected', tools: [{ name: 'lookup' }], resources: [], prompts: [] };
  } });
  const mcp = await app.board.base.create({ kind: 'mcp', name: 'Browser MCP', enabled: true, trust: 'trusted', configuration: { transport: 'stdio', command: 'inert-fixture' } });
  const upstream = await app.board.base.create({ kind: 'knowledge', name: 'Upstream', enabled: true, trust: 'trusted', content: { pages: [{ id: 'guide', title: 'Guide', markdown: 'Fresh upstream documentation' }] } });
  const wiki = await app.board.base.create({ kind: 'knowledge', name: 'Mixed wiki', enabled: true, trust: 'trusted', configuration: { sources: [{ kind: 'knowledge', resourceId: upstream.id }] }, content: { sources: [{ id: 'pasted', name: 'Pasted notes', text: 'Keep my local notes' }] } });
  const child = await app.board.base.create({ kind: 'profile', name: 'Specialist', configuration: { agent: { provider: 'claude', instructions: 'Specialist role' } } });
  const parent = await app.board.base.create({ kind: 'profile', name: 'Lead engineer', configuration: { agent: { provider: 'claude' }, binding: { mode: 'extend', include: [{ resourceId: child.id, required: true }, { resourceId: wiki.id, required: true }], exclude: [] } } });
  const instruction = await app.board.base.create({ kind: 'skill', name: 'coding checklist', content: { body: 'Check invariants.' } });
  await app.board.base.create({ kind: 'pack', name: 'Coding essentials', configuration: { resources: [{ resourceId: instruction.id, required: true }] } });
  await app.board.base.create({ kind: 'context', name: 'Coding context', configuration: { sources: [] } });
  const utility = await app.board.base.create({ kind: 'tool', name: 'Coding utility', configuration: { delivery: 'command-recipe', command: 'node', args: ['--version'] } });
  const browser = await launch();
  if (!browser) { t.skip('Chrome did not start.'); return; }
  t.after(() => browser.close());
  const click = text => browser.eval(`[...document.querySelectorAll('#base-detail button')].find(node => node.textContent === ${JSON.stringify(text)}).click();`);
  const editName = value => browser.eval(`const input = document.querySelector('#base-resource-name'); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', { bubbles: true }));`);
  const open = async id => {
    const name = (await app.board.base.detail(id)).name;
    await browser.eval(`document.querySelector('[data-resource-id="${id}"]').click();`);
    await browser.until(`document.querySelector('#base-resource-name')?.value === ${JSON.stringify(name)}`, 'resource editor');
  };
  await browser.goto(`${app.url}/#/base`);
  await browser.until(`document.querySelector('[data-resource-id="${mcp.id}"]')`, 'Base library');
  await open(mcp.id); await editName('Unsaved MCP name'); await click('Test connection and discover tools');
  await browser.until(`document.querySelector('#base-detail').textContent.includes('Save your edits')`, 'unsaved draft protected');
  assert.equal(tests, 0); assert.equal(await browser.eval(`return document.querySelector('#base-resource-name').value;`), 'Unsaved MCP name');
  await click('Cancel'); await browser.until(`document.querySelector('#base-resource-name')?.value === 'Browser MCP'`, 'saved MCP reopened');
  await click('Test connection and discover tools'); await browser.until(`document.querySelector('.base-resource-form')?.textContent.includes('r2')`, 'successful discovery revision');
  await editName('After discovery'); await click('Save resource'); await browser.until(`document.querySelector('.base-resource-form')?.textContent.includes('r3')`, 'save after discovery');
  await click('Test connection and discover tools'); await browser.until(`document.querySelector('.base-resource-form')?.textContent.includes('r4')`, 'failed discovery revision');
  assert.equal((await app.board.base.detail(mcp.id)).connectionTest.status, 'failed');
  await editName('After failed discovery'); await click('Save resource'); await browser.until(`document.querySelector('.base-resource-form')?.textContent.includes('r5')`, 'save after failed discovery');
  assert.equal((await app.board.base.detail(mcp.id)).name, 'After failed discovery');
  await open(wiki.id); await click('Refresh saved sources');
  await browser.until(`[...document.querySelectorAll('.base-source-list textarea')].some(node => node.value === 'Fresh upstream documentation')`, 'captured sources displayed');
  await click('Save resource'); await browser.until(`document.querySelector('.base-resource-form')?.textContent.includes('r3')`, 'save refreshed wiki');
  assert.deepEqual((await app.board.base.detail(wiki.id)).content.sources.map(source => source.text), ['Keep my local notes', 'Fresh upstream documentation']);
  await browser.eval(`document.querySelector('#base-categories [data-kind="agent"]').click();`);
  assert.equal(await browser.eval(`return document.querySelector('#base-detail').hidden && document.querySelector('#base-category-heading').textContent === 'Agents' && document.querySelectorAll('.base-agent-card').length === 2 && document.querySelector('#base-categories').closest('#sidebar') !== null;`), true);
  await open(parent.id);
  await browser.eval(`document.querySelector('#base-avatar-prompt').value = 'Illustrated purple scientist'; document.querySelector('#base-avatar-generate').click();`);
  await browser.until(`document.querySelector('.base-avatar-editor img')?.naturalWidth > 0`, 'illustration draft visible');
  await click('Save resource'); await browser.until(`document.querySelector('.base-resource-form')?.textContent.includes('r2')`, 'profile portrait saved');
  assert.equal((await app.board.base.detail(parent.id)).content.avatar.data, image.data);
  assert.equal(await browser.eval(`return [...document.querySelectorAll('.base-agent-card .base-agent-loadout input')].every(node => node.checked);`), true);
  for (const width of [1280, 850, 390]) {
    await browser.resize(width, 900);
    assert.equal(await browser.layout(`return document.documentElement.scrollWidth <= innerWidth && document.querySelector('#base-detail').getBoundingClientRect().right <= innerWidth;`), true);
  }
  await click('Back to library');
  assert.deepEqual(await browser.eval(`return [...document.querySelectorAll('#base-categories button')].map(node => node.getAttribute('aria-label'));`), ['All', 'Agents', 'Packs', 'MCPs', 'Skills', 'Knowledge', 'Context', 'Tools']);
  await browser.eval(`window.baseFetches = 0; const originalFetch = window.fetch; window.fetch = (...args) => { if (args[0] === '/api/base') window.baseFetches++; return originalFetch(...args); };`);
  for (const type of ['', 'agent', 'pack', 'mcp', 'skill', 'knowledge', 'context', 'tool']) {
    await browser.eval(`document.querySelector('#base-categories [data-kind="${type}"]').click();`);
    const ids = await browser.eval(`return [...document.querySelectorAll('#base-list [data-resource-id]')].map(node => node.dataset.resourceId);`);
    const resources = (await app.board.base.list()).resources;
    assert.deepEqual(ids.slice().sort(), resources.filter(item => !type || item.type === type).map(item => item.id).sort());
    if (type) assert.equal(await browser.eval(`return document.querySelector('#base-new-kind').value;`), type === 'agent' ? 'profile' : type);
  }
  assert.equal(await browser.eval(`return window.baseFetches;`), 0);
  assert.equal(await browser.layout(`const nav = document.querySelector('#base-categories'); const active = nav.querySelector('[aria-pressed="true"]').getBoundingClientRect(); const bounds = nav.getBoundingClientRect(); return nav.closest('#base-mobile-categories') !== null && nav.scrollWidth > nav.clientWidth && active.left >= bounds.left && active.right <= bounds.right + 1 && active.height >= 44 && document.documentElement.scrollWidth <= innerWidth;`), true);
  await browser.eval(`const search = document.querySelector('#base-search'); search.value = 'coding'; search.dispatchEvent(new Event('input')); for (const [id, value] of [['base-filter', 'enabled'], ['base-sort', 'recently_updated'], ['base-view-mode', 'grid']]) { const control = document.getElementById(id); control.value = value; control.dispatchEvent(new Event('change')); } document.querySelector('#base-categories [data-kind="agent"]').click(); document.querySelector('#base-categories [data-kind="mcp"]').click(); document.querySelector('#base-categories [data-kind="skill"]').click();`);
  assert.equal(await browser.eval(`return document.querySelector('#base-list [data-resource-id]')?.dataset.resourceId;`), instruction.id);
  await open(instruction.id); await editName('coding checklist edited'); await click('Save resource');
  await browser.until(`document.querySelector('.base-resource-form')?.textContent.includes('r2') && document.querySelector('#base-resource-name')?.value === 'coding checklist edited'`, 'edited skill retains filter');
  await click('Back to library'); await browser.reload();
  await browser.until(`document.querySelector('#base-list [data-resource-id]')?.dataset.resourceId === ${JSON.stringify(instruction.id)}`, 'restored library state');
  assert.equal((await app.board.base.detail(instruction.id)).name, 'coding checklist edited');
  assert.equal(await browser.layout(`const nav = document.querySelector('#base-categories').getBoundingClientRect(), active = document.querySelector('#base-categories [aria-pressed="true"]').getBoundingClientRect(); return active.left >= nav.left && active.right <= nav.right + 1;`), true);
  assert.equal(await browser.eval(`return document.querySelector('#base-categories [aria-pressed="true"]').dataset.kind === 'skill' && document.querySelector('#base-search').value === 'coding' && document.querySelector('#base-filter').value === 'enabled' && document.querySelector('#base-sort').value === 'recently_updated' && document.querySelector('#base-view-mode').value === 'grid';`), true);
  const shots = process.env.PB_BROWSER_SHOTS;
  if (shots) await writeFile(join(shots, 'base-mobile-filters.png'), await browser.screenshot());
  await browser.resize(1280, 900); await browser.layout(`return true;`);
  if (shots) await writeFile(join(shots, 'base-desktop-filters.png'), await browser.screenshot());
  await browser.eval(`document.querySelector('#base-categories [data-kind="tool"]').click();`); await open(utility.id); await click('Delete…');
  await browser.eval(`[...document.querySelectorAll('#base-dialog button')].find(node => node.textContent === 'Delete resource').click();`);
  await browser.until(`!document.querySelector('#base-dialog').open && document.querySelector('#base-detail').hidden && document.querySelector('#base-categories [data-kind="tool"] .base-category-count').textContent === '0'`, 'deleted resource and canonical count');
  assert.equal((await app.board.base.list()).resources.some(item => item.id === utility.id), false);
  assert.equal(await browser.eval(`return document.querySelector('#base-search').value === 'coding' && document.querySelector('#base-filter').value === 'enabled' && document.querySelector('#base-empty').textContent.includes('No tools match');`), true);
  assert.deepEqual(browser.consoleMessages.filter(message => message.startsWith('EXCEPTION')), []);
});

test('terminal dock in a real browser: start, render, type, collapse, resize, separate sessions, reconnect, no HTML injection', { skip, timeout: 120000 }, async t => {
  const temp = async prefix => { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return dir; };
  const bin = await temp('pb-browser-bin-');
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\nrequire(${JSON.stringify(fake)});\n`); await chmod(join(bin, 'claude'), 0o755);
  await writeFile(join(bin, 'codex'), `#!${process.execPath}\nrequire(${JSON.stringify(fake)});\n`); await chmod(join(bin, 'codex'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  const root = await temp('pb-browser-repo-');
  git(root, 'init', '-q', '-b', 'trunk'); git(root, 'config', 'user.email', 't@e'); git(root, 'config', 'user.name', 'T');
  await writeFile(join(root, 'a.txt'), 'a\n'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'init');
  const app = await startServer({ port: 0, dataDir: await temp('pb-browser-data-'), detector: async () => [],
    usageReader: { get: async () => ({ updatedAt: Date.now(), providers: [{ id: 'codex', name: 'Codex', sessions: 12, inputTokens: 182000, cachedTokens: 64000, outputTokens: 21000, costUSD: null, costNote: 'Not reported by this CLI.', limits: { status: 'live', checkedAt: Date.now(), windows: [{ label: 'Primary', remainingPercent: 74, usedPercent: 26, windowMinutes: 300, resetsAt: new Date(Date.now() + 3600000).toISOString() }] }, models: [{ model: 'gpt-test', inputTokens: 182000, cachedTokens: 64000, outputTokens: 21000 }], tools: [{ name: 'exec_command', count: 48 }, { name: 'apply_patch', count: 21 }], daily: Array.from({ length: 30 }, (_, i) => ({ day: `Day ${i+1}`, tokens: (i % 7 + 1) * 1300 })) }] }) },
    catalogReader: async provider => ({ provider, defaultModel: `${provider}-test-model`, models: [{ id: `${provider}-test-model`, name: 'Test model', efforts: ['low', 'high'] }] }) });
  t.after(() => app.close());
  const board = app.board;
  const project = await board.createProject({ name: 'Browser' });
  await board.linkRepository(project.id, { path: root, expectedRevision: 1 });
  await board.setTargetBranch(project.id, { branch: 'trunk', expectedRevision: 2 });
  await board.setSettings({ maxConcurrentRuns: 3 });
  const makeTask = async (title, prompt) => { const task = await board.createTask({ projectId: project.id, title, prompt }); return board.moveTask(task.id, { column: 'executing', expectedRevision: 1 }); };
  const first = await makeTask('First task', 'Do the first thing. HTML_PAYLOAD');
  const second = await makeTask('Second task', 'Do the second thing.');
  const flood = await makeTask('Flood task', 'Print a lot. FLOOD');
  const codexTask = await makeTask('Codex task', 'Implement the feature. WRITE_FILE:codex-result.txt');

  const browser = await launch({ width: 1280, height: 900 });
  if (!browser) { t.skip('Chrome did not start.'); return; }
  t.after(() => browser.close());
  const shots = process.env.PB_BROWSER_SHOTS;
  const shot = async name => { if (shots) await writeFile(join(shots, `${name}.png`), await browser.screenshot()); };
  // Navigate like a user who types the address (same-origin page load).
  await browser.goto(`${app.url}/#/kanban`);
  await browser.until(`document.querySelector('#kanban-columns [data-column="executing"] .kanban-start')`, 'start buttons');
  assert.equal(await browser.eval(`return typeof Terminal === 'function' && typeof WebglAddon === 'object';`), true, 'Pinned xterm assets load from the app.');
  for (const width of [1280, 390]) {
    await browser.resize(width, 900);
    await browser.until(`document.querySelector('.kanban-add-task').getBoundingClientRect().bottom <= innerHeight`, 'task entry fits after resize');
    for (const theme of ['light', 'dark']) {
      await browser.eval(`document.documentElement.dataset.theme = '${theme}';`);
      await browser.until(`document.querySelector('.kanban-mascot').naturalWidth > 0`, 'mascot loaded');
      assert.equal(await browser.eval(`return document.querySelector('#kanban-title').textContent;`), 'Promptboard-Project');
      assert.equal(await browser.layout(`const image = document.querySelector('.kanban-mascot').getBoundingClientRect(); const title = document.querySelector('#kanban-title').getBoundingClientRect(); return image.width === 64 && image.height === 64 && image.right <= title.left && image.left >= 0 && title.right <= innerWidth;`), true, 'Mascot is enlarged, visible, and directly beside the heading.');
      assert.equal(await browser.layout(`const button = document.querySelector('.kanban-add-task'); button.focus(); const r = button.getBoundingClientRect(); return document.activeElement === button && r.width > 0 && r.bottom <= innerHeight;`), true, 'To Do Add task is visible and keyboard focusable.');
      assert.equal(await browser.layout(`const columns = [...document.querySelectorAll('.kanban-column')]; return columns.every(column => getComputedStyle(column).borderTopWidth === '2px') && new Set(columns.map(column => getComputedStyle(column).borderTopColor)).size > 3;`), true, 'Columns have distinct, thin top accents.');
      assert.equal(await browser.layout(`const columns = document.querySelectorAll('.kanban-column'); return Math.round(columns[1].getBoundingClientRect().left - columns[0].getBoundingClientRect().right);`, 4), 4, 'Columns retain a minimal visible gap in both themes and viewport sizes.');
      await shot(`entry-${width}-${theme}`);
      await browser.eval(`document.querySelector('.kanban-card').scrollIntoView({ block: 'nearest', inline: 'center' });`);
      assert.equal(await browser.layout(`const card = document.querySelector('.kanban-card'); return card.querySelector('.kanban-more').hidden && getComputedStyle(card.querySelector('.card-agent-info')).display === 'none' && card.querySelector('.kanban-start').getBoundingClientRect().height > 0;`), true, 'Secondary controls are tucked away; the primary action stays visible.');
      await shot(`cards-${width}-${theme}`);
      await browser.eval(`document.querySelector('.kanban-card .kanban-more-toggle').click();`);
      assert.equal(await browser.layout(`const card = document.querySelector('.kanban-card'); const edit = card.querySelector('.kanban-edit'); edit.focus(); const r = edit.getBoundingClientRect(); return document.activeElement === edit && r.width > 0 && r.left >= 0 && r.right <= innerWidth;`), true, 'Task menu actions are visible and keyboard accessible.');
      await shot(`card-menu-${width}-${theme}`);
      await browser.eval(`document.querySelector('.kanban-card .kanban-more').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.querySelector('#kanban-columns').scrollLeft = 0;`);

    }
  }
  for (const width of [1280, 390]) {
    await browser.resize(width, 900);
    for (const theme of ['light', 'dark']) {
      await browser.eval(`document.documentElement.dataset.theme = '${theme}'; document.querySelector('#app-settings-open').click();`);
      await browser.until(`document.querySelector('#app-settings').open`, 'settings opened');
      await browser.eval(`const theme = document.querySelector('#set-theme'); theme.value = '${theme}'; theme.dispatchEvent(new Event('change', { bubbles: true }));`);
      assert.equal(await browser.layout(`const dialog = document.querySelector('#app-settings'); const r = dialog.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.height <= innerHeight && dialog.scrollWidth <= dialog.clientWidth;`), true, 'Shared settings fit the viewport.');
      await shot(`settings-${width}-${theme}`);
      await browser.eval(`document.querySelector('#settings-agents-section').open = true; const select = document.querySelector('#set-agent-provider'); select.value = 'codex'; select.dispatchEvent(new Event('change', { bubbles: true }));`);
      await browser.until(`document.querySelector('#set-agent-model option[value="codex-test-model"]')`, 'shared model catalog');
      assert.equal(await browser.layout(`const model = document.querySelector('#set-agent-model'); return !model.disabled && !model.closest('.model-field').hidden;`), true, 'Choosing a provider exposes a usable model selector.');
      await browser.eval(`document.querySelector('#set-agent-model').scrollIntoView({ block: 'center' });`);
      await shot(`settings-agent-${width}-${theme}`);
      await browser.eval(`document.querySelector('#app-settings-close').click(); document.querySelector('#settings-agents-section').open = false;`);
      await browser.eval(`document.querySelector('#usage-open').click();`);
      await browser.until(`document.querySelector('#usage-providers progress')`, 'usage data loaded');
      assert.equal(await browser.layout(`const d = document.querySelector('#usage-dialog'); const r = d.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && d.scrollWidth <= d.clientWidth && document.querySelector('#usage-providers progress').value === 74;`), true, 'Usage is readable and fits both viewport sizes.');
      await browser.eval(`document.querySelector('#usage-providers details').open = true;`);
      await shot(`usage-${width}-${theme}`);
      await browser.eval(`document.querySelector('#usage-close').click();`);
      assert.equal(await browser.eval(`return document.activeElement.id;`), 'usage-open', 'Usage restores keyboard focus.');
    }
  }
  await browser.resize(1280, 900);
  await browser.eval(`document.querySelector('#project-toggle').click();`);
  await browser.until(`!document.querySelector('#project-settings').hidden`, 'settings expanded');
  assert.equal(await browser.layout(`const panel = document.querySelector('#project-settings').getBoundingClientRect(); const board = document.querySelector('.kanban-board').getBoundingClientRect(); return panel.left >= board.right && Math.abs(panel.top - board.top) < 2;`), true, 'Desktop settings sit beside the board.');
  await shot('0-settings-desktop');
  await browser.resize(390, 844);
  assert.equal(await browser.layout(`const panel = document.querySelector('#project-settings').getBoundingClientRect(); return panel.left >= 0 && panel.right <= innerWidth && panel.bottom <= innerHeight;`), true, 'Settings fit a phone viewport.');
  await shot('0-settings-phone');
  await browser.eval(`document.querySelector('#project-settings-close').focus(); document.querySelector('#project-settings-close').click();`);
  assert.equal(await browser.eval(`return document.querySelector('#project-settings').hidden && document.activeElement.id === 'project-toggle';`), true, 'Closing restores focus to the settings toggle.');
  await browser.resize(1280, 900);
  await shot('0-board');

  // Start the first run through the UI: one click on the card's Start button (no dialog).
  await browser.eval(`[...document.querySelectorAll('.kanban-card')].find(card => card.textContent.includes('First task')).querySelector('.kanban-start').click();`);
  await browser.until(`window.promptboardDock.sessions.size === 1`, 'first session tab', 30000);
  const firstRun = (await board.view()).runs.find(run => run.taskId === first.id).id;
  const text = runId => `(() => { const s = window.promptboardDock.sessions.get(${JSON.stringify(runId)}); if (!s?.term) return ''; const b = s.term.buffer.active; let out = ''; for (let i = 0; i < b.length; i++) out += b.getLine(i).translateToString(true) + '\\n'; return out; })()`;
  await browser.until(`${text(firstRun)}.includes('fake claude started')`, 'output rendered in xterm');
  assert.equal(await browser.eval(`return document.querySelector('#dock').dataset.state;`), 'open');
  assert.ok(await browser.eval(`return document.querySelectorAll('#dock-panel-${firstRun} canvas').length > 0;`), 'The WebGL renderer draws to a canvas.');
  // Terminal output is data: the HTML payload is shown as text, never executed or inserted.
  assert.equal(await browser.eval(`return window.__pwned ?? null;`), null);
  assert.equal(await browser.eval(`return document.querySelector('#dock img, #dock script');`), null);
  assert.match(await browser.eval(`return ${text(firstRun)};`), /<img src=x onerror=/);
  await shot('1-running');

  // Base is a global third page. Creating and assigning an instruction while the
  // first PTY is live must preserve that exact terminal and affect only future runs.
  await browser.eval(`window.__baseLiveSession = window.promptboardDock.sessions.get(${JSON.stringify(firstRun)}); location.hash = '#/base';`);
  await browser.until(`!document.querySelector('#base-view').hidden && document.querySelector('#base-status').textContent.includes('resources')`, 'Base loaded');
  assert.equal(await browser.eval(`return [...document.querySelectorAll('.page-nav a')].map(link => link.textContent).join(' | ');`), 'Compose | Kanban | Base');
  assert.equal(await browser.eval(`document.querySelector('#skip-link').click(); return document.activeElement.id;`), 'base-view');
  await browser.eval(`document.querySelector('#base-new-kind').value = 'skill'; [...document.querySelectorAll('#base-actions button')].find(button => button.textContent === 'Create').click(); document.querySelector('#base-resource-name').value = 'Browser instruction'; document.querySelector('#base-skill-body').value = 'BASE_BROWSER_CHECK: preserve invariants.\\n'; document.querySelector('#base-resource-save').click();`);
  await browser.until(`document.querySelector('#base-status').textContent === 'Saved. No assignments changed.'`, 'skill persisted through Base form');
  const baseSkill = (await board.base.list()).resources.find(item => item.name === 'Browser instruction'); assert.ok(baseSkill);
  assert.equal((await board.view()).projects[0].baseBinding, undefined, 'Creating a resource never assigns it.');
  for (const width of [1280, 390]) {
    await browser.resize(width, 900);
    for (const theme of ['light', 'dark']) {
      await browser.eval(`document.documentElement.dataset.theme = '${theme}';`);
      assert.equal(await browser.layout(`return innerWidth === ${width} && document.documentElement.dataset.page === 'base' && document.documentElement.scrollWidth <= innerWidth && !document.querySelector('#base-error').textContent && document.querySelector('#base-detail').getBoundingClientRect().right <= innerWidth;`), true, `Base editor fits ${width}px in ${theme}.`);
      await shot(`base-${width}-${theme}`);
    }
  }
  await browser.resize(1280, 900);
  await browser.eval(`[...document.querySelectorAll('#base-detail button')].find(button => button.textContent === 'Apply to…').click();`);
  await browser.until(`document.querySelector('.base-apply-targets input')`, 'Base targets available');
  await browser.eval(`const box = [...document.querySelectorAll('[data-target-key]')].find(node => node.dataset.targetKey === ${JSON.stringify(`project:${project.id}::`)}); box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); [...document.querySelectorAll('#base-dialog button')].find(button => button.textContent === 'Preview changes').click();`);
  await browser.until(`[...document.querySelectorAll('#base-dialog button')].some(button => button.textContent === 'Apply assignments' && !button.disabled)`, 'assignment preview');
  await browser.eval(`[...document.querySelectorAll('#base-dialog button')].find(button => button.textContent === 'Apply assignments').click();`);
  await browser.until(`!document.querySelector('#base-dialog').open`, 'assignment saved');
  assert.equal((await board.run(firstRun)).baseManifest.resources.length, 0, 'An already accepted run retains its original resource snapshot.');
  await browser.eval(`location.hash = '#/kanban';`);
  await browser.until(`!document.querySelector('#kanban-view').hidden`, 'Kanban restored');
  assert.equal(await browser.eval(`return window.promptboardDock.sessions.get(${JSON.stringify(firstRun)}) === window.__baseLiveSession && !window.__baseLiveSession.closed;`), true, 'Navigation preserves the live terminal object and stream.');

  // Real keystrokes into the focused terminal reach the agent.
  await browser.eval(`window.promptboardDock.sessions.get(${JSON.stringify(firstRun)}).term.focus();`);
  await browser.type('hello');
  await browser.key('Enter');
  await browser.until(`${text(firstRun)}.includes('you said: hello')`, 'typed input echoed by the agent');

  // Collapse keeps the agent alive; restore refits and the output continues.
  await browser.eval(`document.querySelector('#dock-toggle').click();`);
  assert.equal(await browser.eval(`return document.querySelector('#dock').dataset.state;`), 'collapsed');
  const statusWhileCollapsed = (await board.run(firstRun)).status;
  assert.ok(['running', 'waiting_for_input'].includes(statusWhileCollapsed), 'Collapsing does not stop the run.');
  await browser.until(`document.querySelector('#dock-indicator').textContent.includes('waiting for you') || document.querySelector('#dock-indicator').textContent.includes('running')`, 'collapsed indicator');
  await shot('2-collapsed');
  await browser.eval(`document.querySelector('#dock-toggle').click();`);
  const colsBefore = await browser.eval(`return window.promptboardDock.sessions.get(${JSON.stringify(firstRun)}).term.cols;`);
  // Resize the browser window: the terminal refits and the process sees the new size.
  await browser.resize(900, 800);
  await browser.until(`window.promptboardDock.sessions.get(${JSON.stringify(firstRun)}).term.cols !== ${colsBefore}`, 'terminal refit');
  // The agent reports SIGWINCH; its last reported width must match the terminal's current width
  // (layout can refit more than once while the window settles).
  await browser.until(`[...${text(firstRun)}.matchAll(/size (\\d+)x/g)].at(-1)?.[1] === String(window.promptboardDock.sessions.get(${JSON.stringify(firstRun)}).term.cols)`, 'resize reached the agent process', 30000)
    .catch(async error => { throw new Error(`${error.message}: terminal ${await browser.eval(`return window.promptboardDock.sessions.get(${JSON.stringify(firstRun)}).term.cols;`)} cols, agent reported ${JSON.stringify(await browser.eval(`return ${text(firstRun)}.match(/size \\d+x\\d+/g);`))}`); });
  await browser.resize(1280, 900);

  // A second task gets its own tab, process, and output.
  const capturedPrompt = join(await temp('pb-browser-base-prompt-'), 'prompt.txt');
  const oldCapturedPrompt = process.env.FAKE_AGENT_PROMPT_FILE;
  process.env.FAKE_AGENT_PROMPT_FILE = capturedPrompt;
  t.after(() => { if (oldCapturedPrompt === undefined) delete process.env.FAKE_AGENT_PROMPT_FILE; else process.env.FAKE_AGENT_PROMPT_FILE = oldCapturedPrompt; });
  await browser.eval(`[...document.querySelectorAll('.kanban-card')].find(card => card.textContent.includes('Second task')).querySelector('.kanban-start').click();`);
  await browser.until(`window.promptboardDock.sessions.size === 2`, 'second session tab', 30000);
  const secondRun = (await board.view()).runs.find(run => run.taskId === second.id).id;
  await browser.until(`${text(secondRun)}.includes('working on')`, 'second output');
  let deliveredPrompt;
  for (const deadline = Date.now() + 10000; Date.now() < deadline;) {
    try { deliveredPrompt = await readFile(capturedPrompt, 'utf8'); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.match(deliveredPrompt || '', /BASE_BROWSER_CHECK: preserve invariants\./, 'The actual simulated CLI receives the assigned instructions through the existing message path.');
  assert.match(deliveredPrompt || '', /Do the second thing\./, 'Base preserves the original task prompt.');
  const supplied = (await board.run(secondRun)).baseManifest;
  assert.ok(supplied.supplied.some(item => item.resourceId === baseSkill.id), 'The run manifest records actual supplied context.');
  if (oldCapturedPrompt === undefined) delete process.env.FAKE_AGENT_PROMPT_FILE; else process.env.FAKE_AGENT_PROMPT_FILE = oldCapturedPrompt;
  assert.doesNotMatch(await browser.eval(`return ${text(secondRun)};`), /you said: hello/, 'Sessions have separate output.');
  assert.equal(await browser.eval(`return document.querySelectorAll('#dock-tabs [role="tab"]').length;`), 3, 'Activity plus two session tabs.');
  await browser.until(`document.querySelector('#dock-tab-${secondRun}').classList.contains('waiting')`, 'waiting badge on the tab');
  await shot('3-two-sessions');

  // Reload: the page reconnects to the same server-owned runs and starts nothing new.
  const runCount = (await board.view()).runs.length;
  await browser.reload();
  await browser.until(`window.promptboardDock?.sessions.size === 2`, 'sessions reconnected after reload');
  await browser.until(`${text(firstRun)}.includes('you said: hello')`, 'scrollback replayed after reload');
  assert.equal((await board.view()).runs.length, runCount, 'A reload never starts a run.');

  // Sustained output: a third agent prints about 4 MB while the board stays responsive.
  await browser.eval(`[...document.querySelectorAll('.kanban-card')].find(card => card.textContent.includes('Flood task')).querySelector('.kanban-start').click();`);
  const floodRun = await (async () => { for (;;) { const run = (await board.view()).runs.find(item => item.taskId === flood.id); if (run) return run.id; await new Promise(r => setTimeout(r, 50)); } })();
  // Measure while output streams, after the terminal exists: creating a WebGL context is a one-off
  // cost that takes seconds under the software renderer headless Chrome uses without a GPU.
  await browser.until(`${text(floodRun)}.includes('flood line')`, 'flood output started', 60000);
  // CI runners have no GPU, so WebGL runs in software and a single frame can stall once.
  // Sustained sluggishness still fails: at most one slow answer, and never a hang.
  const times = [];
  for (let i = 0; i < 20; i++) {
    const started = Date.now();
    await browser.eval(`return document.querySelectorAll('.kanban-card').length;`);
    times.push(Date.now() - started);
    await new Promise(r => setTimeout(r, 100));
  }
  const slow = times.filter(ms => ms >= 500);
  assert.ok(slow.length <= 1 && Math.max(...times) < 5000, `The page stayed responsive during the flood (${times.join(', ')} ms).`);
  await browser.eval(`document.querySelector('#workflow-open').click();`);
  assert.equal(await browser.eval(`return document.querySelector('#workflow-dialog').open;`), true, 'Board controls work during sustained output.');
  await browser.eval(`document.querySelector('#workflow-dialog').close();`);
  await browser.until(`${text(floodRun)}.includes('flood line 39999')`, 'the flood finished rendering', 60000);

  // Stop one session from the dock (explicit confirmation); the other keeps running.
  await browser.eval(`document.querySelector('#dock-tab-${firstRun}').click();`);
  await browser.eval(`document.querySelector('#dock-toggle').click();`);
  assert.equal(await browser.eval(`return document.querySelector('#dock').dataset.state;`), 'collapsed');
  await browser.eval(`document.querySelector('#dock-stop').click();`);
  assert.equal(await browser.eval(`return document.querySelector('#dock-stop-prompt').hidden;`), false);
  assert.equal(await browser.eval(`return document.querySelector('#dock').dataset.state;`), 'open', 'Stop reveals its confirmation from the collapsed panel.');
  await browser.eval(`document.querySelector('#dock-toggle').click();`);
  await browser.until(`(() => { const prompt = document.querySelector('#dock-stop-prompt').getBoundingClientRect(); const dock = document.querySelector('#dock').getBoundingClientRect(); return prompt.top >= dock.top - 1 && prompt.bottom <= window.innerHeight + 1; })()`, 'collapsed Stop confirmation stays in the viewport');
  await browser.eval(`[...document.querySelectorAll('#dock-stop-prompt button')].find(button => button.textContent === 'Stop this agent').click();`);
  for (let i = 0; i < 100 && (await board.run(firstRun)).status !== 'cancelled'; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await board.run(firstRun)).status, 'cancelled');
  assert.ok(['running', 'waiting_for_input'].includes((await board.run(secondRun)).status), 'Stopping one session leaves the other running.');
  await shot('4-stopped-one');
  // Pause/Resume is a card action; verify real controls in both themes and a phone viewport.
  for (const width of [1280, 390]) {
    await browser.resize(width, 900);
    for (const theme of ['light', 'dark']) {
      await browser.eval(`document.documentElement.dataset.theme = '${theme}'; document.querySelector('[data-id="${second.id}"]').scrollIntoView({ block: 'nearest', inline: 'center' });`);
      assert.equal(await browser.layout(`const button = document.querySelector('[data-id="${second.id}"] .kanban-pause'); button.focus(); const r = button.getBoundingClientRect(); return document.activeElement === button && r.width > 0 && r.left >= 0 && r.right <= innerWidth;`), true, 'Pause is visible and keyboard accessible.');
      await shot(`pause-${width}-${theme}`);
    }
  }
  await browser.eval(`document.querySelector('[data-id="${second.id}"] .kanban-pause').click();`);
  await browser.until(`document.querySelector('[data-id="${second.id}"] .kanban-resume')`, 'paused conversation can resume');
  assert.equal((await board.run(secondRun)).status, 'suspended');
  for (const theme of ['light', 'dark']) {
    await browser.eval(`document.documentElement.dataset.theme = '${theme}';`);
    assert.equal(await browser.layout(`const button = document.querySelector('[data-id="${second.id}"] .kanban-resume'); button.focus(); const r = button.getBoundingClientRect(); return document.activeElement === button && r.left >= 0 && r.right <= innerWidth;`), true, 'Resume fits a phone viewport and takes keyboard focus.');
    await shot(`resume-390-${theme}`);
  }
  await browser.eval(`document.querySelector('[data-id="${second.id}"] .kanban-resume').click();`);
  await browser.until(`window.promptboardDock.sessions.size === 4`, 'resumed run opens its terminal');
  const resumed = (await board.view()).runs.find(run => run.resumeFrom?.runId === secondRun);
  assert.equal(resumed.sessionId, (await board.run(secondRun)).sessionId);
  await browser.until(`${text(resumed.id)}.includes('fake claude started')`, 'resumed terminal renders');
  assert.equal(await readFile(join(board.executor.dataDir, resumed.artifactsDir, 'prompt.md'), 'utf8'), '');
  await browser.resize(1280, 900);
  // Set the project agent through the visible form, then start a real Codex PTY.
  assert.equal(await browser.eval(`return document.querySelector('#project-agent-panel').hidden;`), true);
  await browser.eval(`document.querySelector('#project-agent-toggle').click();`);
  await browser.eval(`const provider = document.querySelector('#project-agent-fields [data-field="provider"]'); provider.value = 'codex'; provider.dispatchEvent(new Event('change', { bubbles: true }));`);
  await browser.until(`document.querySelector('#project-agent-fields [data-field="model"] option[value="codex-test-model"]')`, 'Codex model choices');
  await browser.eval(`const model = document.querySelector('#project-agent-fields [data-field="model"]'); model.value = 'codex-test-model'; model.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#project-agent-save').click();`);
  await browser.until(`document.querySelector('#kanban-columns [data-column="executing"] .column-agent').textContent.includes('Codex CLI')`, 'project agent saved');
  assert.equal(await browser.eval(`return document.querySelector('#project-agent-panel').hidden;`), true, 'Saving returns to the compact project bar.');
  await browser.eval(`document.querySelector('[data-id="${codexTask.id}"] .kanban-start').click();`);
  const codexRun = await (async () => { for (const end = Date.now() + 15000; Date.now() < end;) { const run = (await board.view()).runs.find(run => run.taskId === codexTask.id); if (run) return run; await new Promise(resolve => setTimeout(resolve, 50)); } assert.fail('Codex run did not start'); })();
  assert.deepEqual([codexRun.config.provider, codexRun.config.model], ['codex', 'codex-test-model']);
  await browser.until(`${text(codexRun.id)}.includes('fake codex started') && ${text(codexRun.id)}.includes('working on')`, 'Codex activity rendered', 30000);
  assert.match(await browser.eval(`return document.querySelector('#dock-tab-${codexRun.id}').textContent;`), /Codex CLI · codex-test-model/);
  assert.equal(await browser.eval(`return window.promptboardDock.selected;`), codexRun.id);
  const details = await browser.eval(`return document.querySelector('#dock-details').textContent;`);
  assert.ok(details.includes(root)); assert.ok(details.includes(codexRun.branch)); assert.ok(details.includes(codexRun.workspacePath));
  await browser.until(`document.querySelector('#dock-connection').textContent.includes('Connected')`, 'live connection feedback');
  assert.equal(await browser.layout(`const terminal = document.querySelector('#dock-panel-${codexRun.id}').getBoundingClientRect(); const status = document.querySelector('#dock-connection').getBoundingClientRect(); return terminal.top >= status.bottom && terminal.height > 50;`), true, 'Run facts and connection feedback do not cover the terminal.');
  const paths = await browser.eval(`return document.querySelector('[data-id="${codexTask.id}"] .task-location').textContent;`);
  assert.ok(paths.includes(codexRun.branch)); assert.ok(paths.includes(codexRun.workspacePath));
  await browser.until(`document.querySelector('#kanban-columns').getBoundingClientRect().bottom <= document.querySelector('#dock').getBoundingClientRect().top + 1`, 'board fits above terminal');
  await browser.until(`(() => { const columns = document.querySelector('#kanban-columns').getBoundingClientRect(); const height = document.querySelector('#dock').getBoundingClientRect().height; return Math.abs(columns.height - Math.max(120, window.innerHeight - columns.top - window.scrollY - height - 16)) < 1; })()`, 'board resize baseline settled');
  const boardHeight = await browser.eval(`return document.querySelector('#kanban-columns').getBoundingClientRect().height;`);
  const dockHeight = await browser.eval(`return document.querySelector('#dock').getBoundingClientRect().height;`);
  await browser.eval(`document.querySelector('#dock-divider').focus();`);
  await browser.key('ArrowUp', 'ArrowUp', 38);
  await browser.until(`document.querySelector('#dock').getBoundingClientRect().height > ${dockHeight} && document.querySelector('#kanban-columns').getBoundingClientRect().height < ${boardHeight}`, 'board adjusts to terminal resizing')
    .catch(async error => {
      const layout = await browser.eval(`const columns = document.querySelector('#kanban-columns'); return { focus: document.activeElement.id, preferred: window.promptboardDock.height, state: window.promptboardDock.state, viewport: [window.innerWidth, window.innerHeight], scrollY: window.scrollY, board: columns.getBoundingClientRect().toJSON(), boardStyle: columns.getAttribute('style'), dock: document.querySelector('#dock').getBoundingClientRect().toJSON() };`);
      throw new Error(`${error.message}: baseline board ${boardHeight}, dock ${dockHeight}; current ${JSON.stringify(layout)}; exceptions ${JSON.stringify(browser.consoleMessages.filter(message => /EXCEPTION/.test(message)))}`);
    });
  await browser.key('ArrowDown', 'ArrowDown', 40);
  // Expanded run facts remain available without covering terminal output.
  await browser.eval(`document.querySelector('#dock-details .dock-context').open = true;`);
  await browser.until(`window.promptboardDock.sessions.get('${codexRun.id}').detailsOpen === true`, 'run details open');
  await browser.eval(`document.querySelector('#dock-details .dock-context').open = false;`);
  await shot('5-codex-agent-and-workspace');
  await browser.eval(`document.documentElement.dataset.theme = 'dark';`);
  await shot('6-codex-dark');
  await browser.resize(390, 844);
  await browser.until(`getComputedStyle(document.querySelector('#sidebar')).visibility === 'hidden'`, 'narrow sidebar drawer closed');
  assert.equal(await browser.eval(`return document.querySelector('#project-context').hidden;`), false);
  await browser.eval(`document.querySelector('#dock-toggle').click();`);
  assert.equal(await browser.layout(`const bar = document.querySelector('#dock .dock-bar').getBoundingClientRect(); const dock = document.querySelector('#dock').getBoundingClientRect(); return bar.top >= dock.top && bar.bottom <= window.innerHeight;`), true, 'The wrapped phone tab bar fits when collapsed.');
  await browser.eval(`document.querySelector('#dock-toggle').click();`);
  await browser.until(`document.querySelector('#dock-panel-${codexRun.id}').getBoundingClientRect().height > 75`, 'readable narrow terminal');
  assert.equal(await browser.layout(`return document.documentElement.scrollWidth <= window.innerWidth;`), true, 'Narrow page has no horizontal overflow outside the board.');
  assert.equal(await browser.layout(`return [...document.querySelectorAll('#board-actions button')].filter(button => !button.hidden).every(button => { const r = button.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth; });`), true, 'Every narrow toolbar action is visible, including New card.');
  await browser.until(`document.querySelector('#kanban-columns').getBoundingClientRect().bottom <= document.querySelector('#dock').getBoundingClientRect().top + 1`, 'narrow board fits above terminal');
  await browser.until(`(() => { const tab = document.querySelector('#dock-tab-${codexRun.id}').getBoundingClientRect(); const tabs = document.querySelector('#dock-tabs').getBoundingClientRect(); return tab.right <= tabs.right + 1 && tab.left >= tabs.left - 1; })()`, 'selected agent stays visible after resizing');
  await shot('7-codex-narrow');
  await browser.eval(`document.querySelector('.page-nav a[href="#/"]').click();`);
  await browser.until(`!document.querySelector('#prompt-view').hidden`, 'Composer visible');
  for (const width of [1280, 390]) {
    await browser.resize(width, 900);
    if (width < 731) await browser.until(`getComputedStyle(document.querySelector('#sidebar')).visibility === 'hidden'`, 'Composer drawer settled');
    for (const theme of ['light', 'dark']) {
      await browser.eval(`document.documentElement.dataset.theme = '${theme}'; window.scrollTo(0, 0);`);
      const composerLayout = await browser.eval(`return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, label: document.querySelector('#generate-label').textContent, overflow: [...document.querySelectorAll('body *')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 1; }).slice(0, 12).map(e => ({ tag: e.tagName, id: e.id, class: e.className, right: e.getBoundingClientRect().right })) };`);
      await browser.until(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('#generate-label').textContent === 'Generate prompt' && !document.querySelector('#copy-cheer')`, `Composer layout settles: ${JSON.stringify(composerLayout)}`);
      await shot(`composer-${width}-${theme}`);
    }
  }
  const errors = browser.consoleMessages.filter(message => /EXCEPTION/.test(message));
  assert.deepEqual(errors, [], 'No uncaught page errors.');
});
