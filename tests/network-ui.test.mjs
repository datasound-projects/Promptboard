// Network page (public/network.js inside app.js) in jsdom against the real server: the fifth page and its routes, the
// agent directory filled from /api/network/agents, register / edit / disable / enable without touching Base, "Open in
// Base" landing on the real resource, stale references, revision conflicts, empty and error states, keyboard, labels,
// no dead buttons, and no job, run or generation request from opening or editing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, until } from './helpers/ui-harness.mjs';

const VIEWS = { '#/origin': '#origin-view', '#/': '#prompt-view', '#/kanban': '#kanban-view', '#/base': '#base-view', '#/network': '#network-view' };
/** The owner API with the page's own token (the same requests the page sends). */
async function call(ctx, path, method = 'GET', body) {
  const response = await fetch(`${ctx.app.url}${path}`, { method, headers: { 'X-STE-Token': ctx.win.__pbTest.token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, json: await response.json() };
}
async function seed(ctx) {
  const base = ctx.app.board.base;
  await base.create({ id: 'lead', kind: 'profile', name: 'Lead', configuration: { agent: { provider: 'claude', model: 'sonnet', instructions: 'Lead the research.' } } });
  await base.create({ id: 'reviewer', kind: 'profile', name: 'Reviewer', configuration: { agent: { provider: 'codex', effort: 'low' } } });
  await base.create({ id: 'team', kind: 'agentProfile', name: 'Team', configuration: { agents: [{ resourceId: 'reviewer', role: 'primary' }] } });
  await base.create({ id: 'notes', kind: 'knowledge', name: 'Notes', content: { body: 'Facts.' } });
}
async function register(ctx, baseResourceId, extra = {}) {
  const { json: list } = await call(ctx, '/api/network/agents');
  const { status, json } = await call(ctx, '/api/network/agents', 'POST', { baseResourceId, expectedRevision: list.revision, ...extra });
  assert.equal(status, 200, JSON.stringify(json));
  return json.agent;
}
/** Every request the page sends from now on: [method, path]. */
function requestLog(ctx) {
  const log = [], original = ctx.win.fetch;
  ctx.win.fetch = (url, options = {}) => { log.push([options.method || 'GET', String(url)]); return original(url, options); };
  return log;
}
const visible = (ctx, node) => { for (let at = node; at && at !== ctx.win.document; at = at.parentNode) if (at.hidden) return false; return true; };
const buttons = (ctx, root) => [...root.querySelectorAll('button')].filter(node => visible(ctx, node));
const byText = (root, text) => [...root.querySelectorAll('button')].find(node => node.textContent === text);
async function visit(ctx, hash, check) { ctx.win.location.hash = hash; await until(check, `page ${hash}`); await ctx.idle(); }
const rows = ctx => [...ctx.$('#network-list').querySelectorAll('[data-agent-id]')];
const shown = ctx => rows(ctx).map(node => node.querySelector('strong').textContent);
const ready = ctx => until(() => ctx.$('.network-list-panel')?.getAttribute('aria-busy') === 'false', 'directory loaded');
const choose = (ctx, selector, value) => { const node = ctx.$(selector); node.value = value; node.dispatchEvent(new ctx.win.Event('change', { bubbles: true })); };
const submit = ctx => ctx.$('#network-dialog form').dispatchEvent(new ctx.win.Event('submit', { bubbles: true, cancelable: true }));
const key = (ctx, node, name) => node.dispatchEvent(new ctx.win.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
const baseSnapshot = async ctx => { const base = await ctx.app.board.base.list(); return JSON.stringify([base.revision, base.resources.map(item => [item.id, item.revision, item.updatedAt, item.enabled, item.trust, item.configuration])]); };

test('Network is the fifth page: nav, title, skip link and sidebar; back and forward across all five pages and Network sub-routes', async t => {
  const ctx = await setup(t, { hash: '#/network' }); const { $, win } = ctx;
  await seed(ctx); const lead = await register(ctx, 'lead');
  await ctx.idle();
  assert.deepEqual([...win.document.querySelectorAll('.page-nav a')].map(link => [link.textContent, link.getAttribute('href')]), [['Origin', '#/origin'], ['Compose', '#/'], ['Kanban', '#/kanban'], ['Base', '#/base'], ['Network', '#/network']]);
  assert.deepEqual(Object.values(VIEWS).map(id => $(id).hidden), [true, true, true, true, false], 'only the Network view shows');
  assert.equal(win.document.title, 'Network · Promptboard');
  assert.equal($('.page-nav [aria-current="page"]').getAttribute('href'), '#/network');
  assert.deepEqual([$('#network-sidebar-panel').hidden, $('#history-panel').hidden, $('#base-sidebar-panel').hidden, $('#sidebar').getAttribute('aria-label')], [false, true, true, 'Network sections']);
  assert.match($('#menu-toggle').getAttribute('aria-label'), /Network sections$/);
  assert.equal($('#skip-link').getAttribute('href'), '#network-view');
  $('#skip-link').dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.deepEqual([win.document.activeElement.id, win.location.hash], ['network-view', '#/network']);
  assert.equal($('#network-view').getAttribute('aria-labelledby'), 'network-heading'); assert.equal($('#network-heading').textContent, 'Network');
  assert.deepEqual([...$('#network-view [role="tablist"]').querySelectorAll('[role="tab"]')].map(tab => [tab.dataset.tab, tab.getAttribute('aria-selected'), tab.dataset.available || 'true']),
    [['agents', 'true', 'true'], ['graph', 'false', 'false'], ['pipelines', 'false', 'false'], ['activity', 'false', 'false'], ['library', 'false', 'false'], ['federation', 'false', 'false']]);
  // Every page still opens, and history moves through all five pages and Network's own sub-routes.
  const open = page => () => Object.entries(VIEWS).every(([hash, id]) => $(id).hidden === (hash !== page));
  for (const hash of ['#/origin', '#/', '#/kanban', '#/base']) await visit(ctx, hash, open(hash));
  assert.equal($('#base-error').hidden, true, $('#base-error').textContent);
  await until(() => $('.base-list-panel').getAttribute('aria-busy') === 'false', 'Base still loads');
  assert.ok(!$('#prompt-input').disabled && $('#generate-button'), 'Compose still works');
  await visit(ctx, '#/network/graph', () => !$('#network-panel-soon').hidden);
  assert.deepEqual([win.document.title, $('#network-tab-graph').getAttribute('aria-selected'), $('#network-panel-agents').hidden], ['Network · Promptboard', 'true', true]);
  assert.equal($('#network-sections [aria-current="page"]').dataset.section, 'graph');
  await visit(ctx, `#/network/agents/${lead.id}`, () => $('#network-detail-heading')?.textContent === 'Lead');
  const back = async (check, label) => { win.history.back(); await until(check, `back to ${label}`); };
  const forward = async (check, label) => { win.history.forward(); await until(check, `forward to ${label}`); };
  await back(() => !$('#network-panel-soon').hidden && $('#network-tab-graph').getAttribute('aria-selected') === 'true', 'Graph');
  await back(open('#/base'), 'Base'); assert.equal(win.document.title, 'Base · Promptboard');
  await back(open('#/kanban'), 'Kanban');
  await forward(open('#/base'), 'Base');
  await forward(() => open('#/network')() && !$('#network-panel-soon').hidden, 'Graph');
  await forward(() => $('#network-detail-heading')?.textContent === 'Lead' && !$('#network-panel-agents').hidden, 'the agent');
  assert.equal($(`[data-agent-id="${lead.id}"]`).getAttribute('aria-current'), 'true');
  $('.page-nav a[href="#/"]').click(); win.location.hash = '#/'; await until(open('#/'), 'Compose from the nav');
  assert.equal(win.document.title, 'Compose · Promptboard');
});

test('the Network start page applies only without an explicit route', async t => {
  const saved = { 'promptboard.settings.start-page': 'network' };
  const first = await setup(t, { prefs: saved }); await first.idle();
  assert.deepEqual([first.win.location.hash, first.$('#network-view').hidden, first.$('#prompt-view').hidden], ['#/network', false, true]);
  const explicit = await setup(t, { prefs: saved, hash: '#/kanban' }); await explicit.idle();
  assert.deepEqual([explicit.$('#kanban-view').hidden, explicit.$('#network-view').hidden], [false, true]);
  explicit.$('#app-settings-open').click(); await explicit.idle();
  assert.deepEqual([[...explicit.$('#set-start').options].map(option => option.value), explicit.$('#set-start').value], [['origin', 'compose', 'kanban', 'base', 'network'], 'network']);
});

test('the directory is the server’s: two registrations, searched and filtered by role, provider, capability and status', async t => {
  const ctx = await setup(t, { hash: '#/' }); const { $ } = ctx;
  await seed(ctx);
  const lead = await register(ctx, 'lead', { displayName: 'Research lead', capabilities: ['research'], tags: ['alpha'] });
  const team = await register(ctx, 'team', { capabilities: ['review'], enabled: false });
  const log = requestLog(ctx);
  await visit(ctx, '#/network', () => !$('#network-view').hidden); await ready(ctx);
  assert.deepEqual(rows(ctx).map(node => node.dataset.agentId), [lead.id, team.id], 'the rows are the server’s registrations');
  assert.deepEqual(shown(ctx), ['Research lead', 'Team']);
  assert.deepEqual(rows(ctx).map(node => node.querySelector('.network-row-sub').textContent), ['Agent · Claude Code · sonnet', 'Agent profile · Codex']);
  assert.deepEqual(rows(ctx).map(node => node.closest('li').dataset.state), ['enabled', 'disabled']);
  assert.equal($('.network-count').textContent, '2 agents');
  assert.deepEqual([...$('#network-filter-capability').options].map(option => option.value), ['', 'research', 'review'], 'capabilities from the server’s facets');
  const filtered = async (selector, value, expected, query) => {
    choose(ctx, selector, value); await until(() => JSON.stringify(shown(ctx)) === JSON.stringify(expected), `${selector}=${value}`);
    if (query) assert.ok(log.some(([, url]) => url.includes(query)), `${query} sent to the server`);
    choose(ctx, selector, ''); await until(() => shown(ctx).length === 2, 'filter cleared');
  };
  await filtered('#network-filter-kind', 'agentProfile', ['Team'], 'kind=agentProfile');
  await filtered('#network-filter-kind', 'profile', ['Research lead'], 'kind=profile');
  await filtered('#network-filter-provider', 'codex', ['Team'], 'provider=codex');
  await filtered('#network-filter-provider', 'claude', ['Research lead'], 'provider=claude');
  await filtered('#network-filter-capability', 'research', ['Research lead'], 'capability=research');
  await filtered('#network-filter-status', 'disabled', ['Team'], 'status=disabled');
  await filtered('#network-filter-status', 'enabled', ['Research lead'], 'status=enabled');
  $('#network-search').value = 'ALPHA'; $('#network-search').dispatchEvent(new ctx.win.Event('input', { bubbles: true }));
  await until(() => JSON.stringify(shown(ctx)) === '["Research lead"]', 'search by tag');
  assert.ok(log.some(([, url]) => url.includes('q=ALPHA')));
  choose(ctx, '#network-filter-status', 'stale');
  await until(() => /No agents match these filters/.test($('#network-empty').textContent), 'filtered empty state');
  byText($('#network-empty'), 'Clear filters').click();
  await until(() => shown(ctx).length === 2 && $('#network-search').value === '' && $('#network-filter-status').value === '', 'filters cleared');
  // A registration made elsewhere shows when the page is opened again: the directory is read from the server, not kept.
  await register(ctx, 'reviewer', { displayName: 'From elsewhere' });
  await visit(ctx, '#/kanban', () => !$('#kanban-view').hidden);
  await visit(ctx, '#/network', () => shown(ctx).includes('From elsewhere'));
});

test('register a Base agent, edit its Network identity, disable and enable it: Base is unchanged, Open in Base lands on the resource, nothing runs', async t => {
  const ctx = await setup(t, { hash: '#/' }); const { $, win } = ctx;
  await seed(ctx);
  const site = await ctx.app.board.createProject({ name: 'Site' }); await win.__pbTest.loadBoard();
  const before = await baseSnapshot(ctx), log = requestLog(ctx);
  await visit(ctx, '#/network', () => !$('#network-view').hidden); await ready(ctx);
  assert.match($('#network-empty').textContent, /No agents registered yet\./, 'empty state');
  assert.match($('#network-detail').textContent, /profile appears here/);
  byText($('#network-empty'), 'Register agent').click();
  await until(() => $('#network-form-base'), 'register form');
  assert.equal($('#network-dialog').open, true);
  assert.deepEqual([...$('#network-form-base').options].map(option => option.value), ['lead', 'reviewer', 'team'], 'only Base agents and agent profiles, by name');
  assert.equal(win.document.activeElement, $('#network-form-base'), 'focus starts in the form');
  $('#network-form-name').value = 'Research lead'; $('#network-form-tags').value = 'alpha, beta, alpha'; $('#network-form-capabilities').value = 'research';
  $(`#network-dialog [data-project="${site.id}"]`).checked = true;
  submit(ctx);
  await until(() => !$('#network-dialog').open && $('#network-detail-heading')?.textContent === 'Research lead', 'registered and shown');
  await ctx.idle();
  const { json: { agents: [stored] } } = await call(ctx, '/api/network/agents');
  assert.deepEqual([stored.baseResourceId, stored.displayName, stored.tags, stored.capabilities, stored.projectAllowlist, stored.enabled], ['lead', 'Research lead', ['alpha', 'beta'], ['research'], [site.id], true]);
  assert.equal(win.location.hash, `#/network/agents/${stored.id}`);
  assert.equal(win.document.activeElement, $('#network-detail-heading'), 'focus moves to the new profile');
  assert.match($('#network-status').textContent, /Registered Research lead\. Base is unchanged\./);
  // The profile: identity, Base settings read from Base, projects, capabilities with unknown where unknown, operations.
  const detail = $('#network-detail').textContent;
  for (const text of [stored.id, 'Lead · Agent · revision 1', 'Claude Code', 'sonnet', 'Site', 'Lead the research.', 'Not in a network yet.', 'Usage reported', 'Unknown', 'Read only. Network jobs never change files.', 'No tools, Web search']) assert.ok(detail.includes(text), `profile shows ${text}`);
  // Edit the Network identity.
  $('#network-edit').focus(); $('#network-edit').click(); await until(() => $('#network-form-name')?.value === 'Research lead', 'edit form');
  assert.equal($('#network-form-base'), null, 'the Base agent of a registration never changes');
  assert.deepEqual([$('#network-form-tags').value, $('#network-form-capabilities').value, $(`#network-dialog [data-project="${site.id}"]`).checked], ['alpha, beta', 'research', true]);
  $('#network-form-name').value = 'Lead researcher'; $('#network-form-capabilities').value = 'research, sources'; $(`#network-dialog [data-project="${site.id}"]`).checked = false;
  submit(ctx);
  await until(() => !$('#network-dialog').open && $('#network-detail-heading')?.textContent === 'Lead researcher', 'edited');
  await ctx.idle();
  assert.equal(win.document.activeElement, $('#network-edit'), 'focus returns to Edit identity');
  let { json: { agent } } = await call(ctx, `/api/network/agents/${stored.id}`);
  assert.deepEqual([agent.displayName, agent.capabilities, agent.projectAllowlist, agent.revision], ['Lead researcher', ['research', 'sources'], [], 2]);
  // Disable, then enable again.
  const toggle = () => { const node = $('#network-enabled'); node.focus(); node.checked = !node.checked; node.dispatchEvent(new win.Event('change', { bubbles: true })); };
  toggle(); await until(() => $('#network-detail .base-status')?.textContent === 'Disabled', 'disabled'); await ctx.idle();
  ({ json: { agent } } = await call(ctx, `/api/network/agents/${stored.id}`));
  assert.deepEqual([agent.enabled, $('#network-enabled').checked, rows(ctx)[0].closest('li').dataset.state], [false, false, 'disabled']);
  assert.match($('#network-detail').textContent, /Refused\. The registration is switched off in Network\./);
  toggle(); await until(() => $('#network-detail .base-status')?.textContent === 'Enabled', 'enabled again'); await ctx.idle();
  ({ json: { agent } } = await call(ctx, `/api/network/agents/${stored.id}`));
  assert.deepEqual([agent.enabled, agent.revision], [true, 4]);
  assert.equal(win.document.activeElement, $('#network-enabled'), 'the switch keeps focus');
  assert.equal(await baseSnapshot(ctx), before, 'Base resources and revision are unchanged');
  // Open in Base: Base's own editor on the real resource; back returns to the profile.
  $('#network-open-base').click();
  await until(() => !$('#base-view').hidden && $('#base-resource-name')?.value === 'Lead', 'the Lead resource open in Base');
  assert.deepEqual([win.location.hash, $('.base-resource-form').dataset.kind, $('.base-resource-form h2').textContent, win.document.title], ['#/base', 'profile', 'Lead', 'Base · Promptboard']);
  win.history.back(); await until(() => $('#network-detail-heading')?.textContent === 'Lead researcher', 'back to the profile');
  // Nothing but reads and the registration's own writes; no job, run or generation request; no runner call; no run.
  const writes = log.filter(([method]) => method !== 'GET').map(([method, url]) => `${method} ${url.replace(stored.id, ':id')}`);
  assert.deepEqual([...new Set(writes)].sort(), ['PATCH /api/network/agents/:id', 'POST /api/network/agents']);
  assert.ok(!log.some(([, url]) => /\/api\/(generate|runs|jobs|network\/jobs|research|compose)|\/run\b/.test(url)), JSON.stringify(log));
  assert.deepEqual([ctx.calls.length, (await ctx.app.board.view()).runs.length], [0, 0]);
});

test('stale references show their reason; a revision conflict offers Reload; load errors render with Retry', async t => {
  const ctx = await setup(t, { hash: '#/' }); const { $, win } = ctx;
  // A damaged registry file (and backup) is refused: the directory shows the error and Retry.
  await mkdir(join(ctx.dataDir, 'network'), { recursive: true });
  for (const name of ['agents.json', 'agents.json.bak']) await writeFile(join(ctx.dataDir, 'network', name), '{ damaged');
  await visit(ctx, '#/network', () => !$('#network-view').hidden);
  await until(() => /Could not load Network agents\. The Network agent registry is damaged/.test($('#network-empty').textContent), 'load error');
  assert.equal($('#network-empty [role="alert"]') !== null, true);
  for (const name of ['agents.json', 'agents.json.bak']) await rm(join(ctx.dataDir, 'network', name));
  byText($('#network-empty'), 'Retry').click();
  await until(() => /No agents registered yet/.test($('#network-empty').textContent), 'retried');

  await seed(ctx);
  await ctx.app.board.base.create({ id: 'temp', kind: 'profile', name: 'Temp', configuration: { agent: { provider: 'claude' } } });
  const lead = await register(ctx, 'lead'), temp = await register(ctx, 'temp');
  await ctx.app.board.base.update('lead', { enabled: false }, { expectedRevision: 1 });
  await ctx.app.board.base.remove('temp', { expectedRevision: 1 });
  await visit(ctx, '#/kanban', () => !$('#kanban-view').hidden);
  await visit(ctx, '#/network', () => rows(ctx).length === 2);
  assert.deepEqual(rows(ctx).map(node => [node.closest('li').dataset.state, node.querySelector('.base-status').textContent]), [['stale', 'Stale'], ['stale', 'Stale']]);
  await visit(ctx, `#/network/agents/${lead.id}`, () => $('#network-stale-note'));
  assert.match($('#network-stale-note').textContent, /^Stale\. The Base agent is switched off\. It cannot take new work/);
  assert.equal($('#network-open-base').disabled, false, 'a switched-off agent still opens in Base');
  await visit(ctx, `#/network/agents/${temp.id}`, () => /no longer exists/.test($('#network-stale-note')?.textContent || ''));
  assert.deepEqual([$('#network-open-base').disabled, $('#network-open-base').getAttribute('aria-describedby')], [true, 'network-stale-note'], 'nothing to open: disabled with the reason');
  assert.match($('#network-detail').textContent, /Missing \(temp\)/);
  assert.match($('#network-detail').textContent, /No known provider is set in Base, so every capability is unknown\./);

  // Revision conflict on the switch: someone else changed the registration since the page loaded it.
  await ctx.app.board.base.update('lead', { enabled: true }, { expectedRevision: 2 });
  await visit(ctx, `#/network/agents/${lead.id}`, () => $('#network-detail-heading')?.textContent === 'Lead');
  await call(ctx, `/api/network/agents/${lead.id}`, 'PATCH', { expectedRevision: 1, displayName: 'Renamed elsewhere' });
  const toggle = $('#network-enabled'); toggle.checked = false; toggle.dispatchEvent(new win.Event('change', { bubbles: true }));
  await until(() => !$('#network-error').hidden, 'conflict shown'); await ctx.idle();
  assert.match($('#network-error').textContent, /changed since you loaded it\. Reload and try again\./);
  assert.equal($('#network-enabled').checked, true, 'the switch shows the saved state again');
  assert.equal((await call(ctx, `/api/network/agents/${lead.id}`)).json.agent.enabled, true, 'nothing was saved');
  byText($('#network-error'), 'Reload').click();
  await until(() => $('#network-error').hidden && $('#network-detail-heading')?.textContent === 'Renamed elsewhere', 'reloaded');
  assert.match($('#network-status').textContent, /Reloaded the current version/);
  // The same in the edit dialog: the edit is reopened on the current version instead of overwriting it.
  $('#network-edit').click(); await until(() => $('#network-form-name'), 'edit form');
  await call(ctx, `/api/network/agents/${lead.id}`, 'PATCH', { expectedRevision: 2, tags: ['changed-elsewhere'] });
  $('#network-form-name').value = 'Mine'; submit(ctx);
  await until(() => /changed since you loaded it/.test($('#network-dialog [role="alert"]').textContent), 'conflict in the dialog'); await ctx.idle();
  byText($('#network-dialog'), 'Reload').click();
  await until(() => !$('#network-dialog').open && /changed-elsewhere/.test($('#network-detail').textContent), 'dialog closed, current version shown');
  assert.equal((await call(ctx, `/api/network/agents/${lead.id}`)).json.agent.displayName, 'Renamed elsewhere', 'the conflicting edit was not saved');
});

test('keyboard and labels: tablists follow arrow keys, every control is named, Escape returns focus, and no visible button is dead', async t => {
  const ctx = await setup(t, { hash: '#/' }); const { $, win } = ctx;
  await seed(ctx);
  const lead = await register(ctx, 'lead', { capabilities: ['research'] }); await register(ctx, 'team');
  await visit(ctx, '#/network', () => !$('#network-view').hidden); await ready(ctx);
  // Section tabs: arrows, Home and End select and focus; the URL follows.
  const tab = id => $(`#network-tab-${id}`);
  tab('agents').focus(); key(ctx, tab('agents'), 'ArrowRight');
  await until(() => win.location.hash === '#/network/graph' && tab('graph').getAttribute('aria-selected') === 'true', 'ArrowRight');
  assert.deepEqual([win.document.activeElement, tab('graph').tabIndex, tab('agents').tabIndex], [tab('graph'), 0, -1]);
  const selected = (id, hash) => () => win.location.hash === hash && tab(id).getAttribute('aria-selected') === 'true' && win.document.activeElement === tab(id);
  key(ctx, tab('graph'), 'End'); await until(selected('federation', '#/network/federation'), 'End');
  key(ctx, tab('federation'), 'ArrowRight'); await until(selected('agents', '#/network'), 'wraps to Agents');
  key(ctx, tab('agents'), 'ArrowLeft'); await until(selected('federation', '#/network/federation'), 'wraps back');
  // An unavailable section says so and offers nothing that looks like it works.
  const soon = $('#network-panel-soon');
  assert.deepEqual([soon.hidden, soon.getAttribute('aria-labelledby'), soon.querySelector('h2').textContent, soon.querySelectorAll('button, input, select, a, textarea').length], [false, 'network-tab-federation', 'Federation', 0]);
  assert.match(soon.textContent, /Not available yet\./);
  assert.equal($('#network-register').hidden, true, 'no Register agent outside Agents');
  key(ctx, tab('federation'), 'Home'); await until(() => selected('agents', '#/network')() && !$('#network-panel-agents').hidden, 'Home');
  await visit(ctx, `#/network/agents/${lead.id}`, () => $('#network-detail-heading'));
  // Profile tabs: Tasks, Activity and Memory are clearly unavailable.
  const inner = id => $(`#network-profile-tab-${id}`);
  inner('profile').focus(); key(ctx, inner('profile'), 'ArrowRight');
  assert.deepEqual([win.document.activeElement, $('#network-profile-panel-tasks').hidden, $('#network-profile-panel-profile').hidden], [inner('tasks'), false, true]);
  for (const id of ['tasks', 'activity', 'memory']) assert.match($(`#network-profile-panel-${id}`).textContent, /Not available yet\./);
  key(ctx, inner('tasks'), 'Home'); assert.equal($('#network-profile-panel-profile').hidden, false);

  // Names: every control and button in the page and the dialog; tabs and panels reference each other.
  const named = root => {
    for (const control of root.querySelectorAll('input, select, textarea')) assert.ok(control.labels?.length || control.getAttribute('aria-label'), `${control.id || control.outerHTML.slice(0, 80)} has a label`);
    for (const node of root.querySelectorAll('button')) assert.ok((node.textContent.trim() || node.getAttribute('aria-label') || '').length > 0, `${node.outerHTML.slice(0, 80)} has a name`);
    for (const node of root.querySelectorAll('[role="tab"]')) assert.ok(win.document.getElementById(node.getAttribute('aria-controls')), `${node.id} controls a panel`);
    for (const node of root.querySelectorAll('[role="tabpanel"]')) assert.ok(win.document.getElementById(node.getAttribute('aria-labelledby')), `${node.id} is labelled`);
  };
  named($('#network-view')); named($('#network-sidebar-panel'));
  assert.ok($('#network-status').getAttribute('role') === 'status' && $('#network-error').getAttribute('role') === 'alert');
  $('#network-register').focus(); $('#network-register').click(); await until(() => $('#network-form-base'), 'dialog');
  named($('#network-dialog'));
  assert.equal($('#network-dialog').getAttribute('aria-labelledby'), 'network-dialog-heading');
  key(ctx, $('#network-form-base'), 'Escape');
  assert.deepEqual([$('#network-dialog').open, win.document.activeElement], [false, $('#network-register')], 'Escape closes and returns focus');

  // No dead buttons: each visible, enabled button changes what the page shows, its route, focus or a dialog.
  const look = () => JSON.stringify([win.location.hash, $('#network-dialog').open, win.document.activeElement?.id, $('#network-view').textContent, [...win.document.querySelectorAll('#network-view [aria-selected="true"]')].map(node => node.id)]);
  for (const route of ['#/network', `#/network/agents/${lead.id}`]) {
    await visit(ctx, route, () => win.location.hash === route); await ctx.idle();
    const labels = buttons(ctx, $('#network-view')).filter(node => node.getAttribute('aria-current') !== 'true' && node.getAttribute('aria-selected') !== 'true').map(node => node.id || node.dataset.agentId || node.textContent);
    assert.ok(labels.length >= (route === '#/network' ? 8 : 12), labels.join(' | '));
    for (const label of labels) {
      const node = buttons(ctx, $('#network-view')).find(item => (item.id || item.dataset.agentId || item.textContent) === label);
      if (node.disabled) { assert.ok(node.title || node.getAttribute('aria-describedby'), `${label} is disabled with a reason`); continue; }
      const before = look(); node.click(); await ctx.idle();
      await until(() => look() !== before, `${label} does something`);
      if ($('#network-dialog').open) { key(ctx, $('#network-dialog'), 'Escape'); }
      await visit(ctx, route, () => win.location.hash === route && !$('#network-dialog').open); await ctx.idle();
    }
  }
});
