import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';
import { OriginStore, blueprintFileName } from '../src/origin.mjs';

const J = JSON.stringify;
// Page helpers: every action goes through the rendered controls.
function pageTools(browser) {
  const ev = code => browser.eval(code);
  const wait = (expression, label, ms = 10000) => browser.until(expression, label, ms);
  const saved = () => wait(`document.querySelector('#origin-view').dataset.save === 'saved'`, 'blueprint saved', 15000);
  const drawerField = label => `[...document.querySelectorAll('#origin-drawer .origin-field')].find(f => f.querySelector('.origin-field-label')?.textContent === ${J(label)})`;
  const tools = {
    ev, wait, saved,
    section: async id => {
      const label = await ev(`const item = document.querySelector('.origin-nav-item[data-section=${J(id)}]'); item.click(); return item.querySelector('.origin-nav-label').textContent;`);
      await wait(`document.querySelector('#origin-section-heading')?.textContent === ${J(label)}`, `section ${id}`);
    },
    quick: async (text, id) => assert.equal(await ev(`const i = ${id ? `document.querySelector('[data-quick=${J(id)}]')` : `document.querySelector('#origin-main .origin-quick input')`}; if (!i) return false; i.value = ${J(text)}; i.form.requestSubmit(); return true;`), true, `quick add ${text}`),
    press: async (text, scope = '#origin-view') => assert.equal(await ev(`const b = [...document.querySelector(${J(scope)}).querySelectorAll('button')].find(b => b.textContent.trim() === ${J(text)}); if (!b) return false; b.click(); return true;`), true, `button ${text}`),
    open: async text => {
      assert.equal(await ev(`const b = [...document.querySelectorAll('#origin-main .origin-row-open')].find(b => b.querySelector('.origin-row-title').textContent.includes(${J(text)})); if (!b) return false; b.click(); return true;`), true, `row ${text}`);
      await wait(`!document.querySelector('#origin-drawer').hidden`, `editor for ${text}`);
    },
    close: async () => { await ev(`document.querySelector('#origin-drawer [aria-label="Close editor"]').click();`); await wait(`document.querySelector('#origin-drawer').hidden`, 'editor closed'); },
    title: async value => ev(`const t = document.querySelector('#origin-drawer-title'); t.value = ${J(value)}; t.dispatchEvent(new Event('input', { bubbles: true }));`),
    set: async (label, value) => assert.equal(await ev(`const f = ${drawerField(label)}; const c = f?.querySelector('input, textarea, select'); if (!c) return false; c.value = ${J(value)}; c.dispatchEvent(new Event(c.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); return true;`), true, `field ${label}`),
    seg: async (label, option) => assert.equal(await ev(`const f = ${drawerField(label)}; const b = f && [...f.querySelectorAll('.origin-seg button')].find(b => b.textContent === ${J(option)}); if (!b) return false; b.click(); return true;`), true, `${label}: ${option}`),
    link: async (label, name) => assert.equal(await ev(`const f = ${drawerField(label)}; const s = f?.querySelector('select.origin-link-add'); const o = s && [...s.options].find(o => o.value && o.textContent.includes(${J(name)})); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true;`), true, `link ${label} → ${name}`),
    node: async (name, key) => ev(`[...document.querySelectorAll('.origin-node')].find(n => n.textContent.includes(${J(name)})).dispatchEvent(new KeyboardEvent('keydown', { key: ${J(key)}, bubbles: true }));`),
  };
  return tools;
}
async function blueprintFile(app, originId) { return JSON.parse(await readFile(join(app.board.store.dir, 'origin', blueprintFileName(originId)), 'utf8')); }
const originId = ev => ev(`return localStorage.getItem('promptboard.origin.project');`);

test('Origin in real Chrome: quick entry, mind map, diagram, evidence, readiness, persistence and explicit handoffs', { skip: !await findChrome(), timeout: 180000 }, async t => {
  const generated = [];
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [{ id: 'codex', available: true }], runner: async request => { generated.push(request); throw new Error('No model call is allowed.'); } });
  const project = await app.board.createProject({ name: 'Demo project', workflowMode: 'pipeline' });
  const existing = await app.board.createTask({ projectId: project.id, title: 'Existing card', prompt: 'Keep me intact.' });
  const statePath = join(app.board.store.dir, 'state.json');
  const browser = await launch({ width: 1280, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  const { ev, wait, saved, section, quick, press, open, close, title, set, seg, link, node } = pageTools(browser);

  await browser.goto(`${app.url}/#/origin`);
  await wait(`document.querySelector('#origin-start')`, 'start screen');
  assert.equal(await ev(`return [...document.querySelectorAll('.page-nav a')].map(a => a.textContent).join(' | ');`), 'Origin | Compose | Kanban | Base');
  assert.equal(await ev(`return document.querySelector('.page-nav [aria-current="page"]').getAttribute('href');`), '#/origin');
  assert.equal(await ev(`return document.title;`), 'Origin · Promptboard');
  assert.equal(await ev(`return document.querySelector('#origin-main h2').textContent;`), 'What do you want to build?');
  assert.equal(await ev(`return /Ask AI|Import/i.test(document.querySelector('#origin-view').textContent);`), false, 'Origin starts from the project: no AI prompt box and no import.');
  assert.equal(await ev(`return document.documentElement.dataset.theme;`), 'dark', 'Promptboard opens dark by default.');
  const stateBefore = await readFile(statePath, 'utf8');

  // Untrusted text stays text, on the start screen and in the mind map.
  const hostile = '<img src=x onerror="window.__pwned=1">Release hub';
  // An Origin-only project: the existing Kanban project is untouched until linked.
  assert.equal(await ev(`return document.querySelector('#origin-first-kanban').checked;`), true, 'Creating Kanban work stays the default.');
  // A different name from the board: a same-named project would join that board (see shared-projects tests).
  await ev(`document.querySelector('#origin-first-project').value = 'Demo plan'; document.querySelector('#origin-first-kanban').checked = false; document.querySelector('#origin-idea').value = ${J(hostile)}; document.querySelector('#origin-start').click();`);
  await wait(`document.querySelectorAll('.origin-nav-item').length === 15 && document.querySelector('.origin-map')`, 'mind map');
  await saved();
  assert.equal((await app.board.view()).projects.length, 1, 'No Kanban project is created for an Origin-only project.');
  assert.equal(await ev(`return document.querySelector('#origin-kanban-link').textContent;`), 'Not on Kanban');
  const blueprintId = await originId(ev);
  assert.equal(await ev(`return document.querySelector('#origin-section-heading').textContent;`), 'Overview');
  assert.equal(await ev(`return document.querySelectorAll('.origin-map-section').length;`), 14);
  assert.match(await ev(`return document.querySelector('.origin-map-center').textContent;`), /Release hub/);
  assert.equal(await ev(`return window.__pwned === undefined && !document.querySelector('#origin-view img');`), true);
  await section('vision');
  assert.equal(await ev(`return document.querySelector('#origin-main textarea').value;`), hostile);

  // Requirements: type and press Enter; the drawer holds the details; delete asks twice.
  await section('requirements');
  await quick('Publish release notes');
  await wait(`document.querySelectorAll('#origin-main .origin-row').length === 1 && document.activeElement?.dataset.quick === 'requirements'`, 'row added, focus kept for the next one');
  await open('Publish release notes'); await seg('Priority', 'Must'); await set('Done when', 'A maintainer can publish\nReaders see it'); await close();
  assert.match(await ev(`return document.querySelector('#origin-main .origin-row').textContent;`), /Done when: 2 checks.*REQ-001.*Must/);
  await quick('Temporary requirement');
  await open('Temporary requirement'); await press('Delete', '#origin-drawer'); await press('Delete — are you sure?', '#origin-drawer');
  await wait(`document.querySelector('#origin-drawer').hidden`, 'deleted');
  assert.deepEqual(await ev(`return [...document.querySelectorAll('#origin-main .origin-row .origin-key')].map(n => n.textContent);`), ['REQ-001']);

  // Architecture: blocks from the quick bar, keyboard connect mode, connections in the drawer, cascading delete.
  await section('architecture');
  for (const [name, type] of [['Web Client', 'client'], ['API', 'api'], ['Scratch', 'service']]) {
    await ev(`const s = document.querySelector('.origin-canvas-tools select'); s.value = ${J(type)};`);
    await quick(name, 'components');
  }
  await wait(`document.querySelectorAll('.origin-node').length === 3`, 'three blocks');
  await ev(`document.querySelector('#origin-connect').click();`); await node('Web Client', ' '); await node('API', ' ');
  await wait(`document.querySelectorAll('.origin-edge').length === 1 && document.querySelector('#origin-drawer-title')?.value === 'Web Client'`, 'connected; source block opened');
  await ev(`const i = document.querySelector('#origin-drawer .origin-connection input[placeholder="HTTPS"]'); i.value = 'HTTPS'; i.dispatchEvent(new Event('input', { bubbles: true }));`);
  await set('What it does', 'Web Client purpose'); await close();
  await node('API', 'Enter');
  await wait(`document.querySelector('#origin-drawer-title')?.value === 'API'`, 'API opened from the diagram');
  await set('What it does', 'API purpose'); await link('Connects to', 'Scratch');
  await wait(`document.querySelectorAll('.origin-edge').length === 2`, 'second edge');
  assert.match(await ev(`return document.querySelector('#origin-drawer').textContent;`), /Used by Web Client\./);
  await close();
  await section('requirements'); await open('Publish release notes'); await link('Built by', 'API'); await link('Built by', 'Scratch'); await close();
  await section('architecture'); await open('Scratch'); await press('Delete', '#origin-drawer');
  await press('Delete and unlink 2 references?', '#origin-drawer');
  await wait(`document.querySelectorAll('.origin-node').length === 2 && document.querySelectorAll('.origin-edge').length === 1`, 'block and its connection removed');
  assert.match(await ev(`return document.querySelector('.origin-edge-label').textContent;`), /calls · HTTPS/);

  // Technology with evidence: verification follows the linked source, never the URL.
  await section('technology');
  await ev(`document.querySelector('.origin-quick select').value = 'runtime';`);
  await quick('Node.js'); await open('Node.js'); await seg('Status', 'Selected'); await set('Version', '22'); await close();
  assert.match(await ev(`return document.querySelector('#origin-main .origin-row').textContent;`), /Unverified/);
  await section('research'); await quick('Node.js releases', 'sources'); await open('Node.js releases');
  await set('Link', 'javascript:alert(1)');
  assert.equal(await ev(`return document.querySelector('#origin-drawer input[type="url"]').getAttribute('aria-invalid');`), 'true');
  assert.equal(await ev(`return document.querySelector('.origin-open-link').hidden;`), true);
  await set('Link', 'https://nodejs.org/en/about/previous-releases');
  assert.equal(await ev(`const a = document.querySelector('.origin-open-link'); return [a.hidden, a.rel, a.target, a.href].join(' ');`), 'false noopener noreferrer _blank https://nodejs.org/en/about/previous-releases');
  await close();
  await section('technology'); await open('Node.js'); await link('Evidence', 'Node.js releases'); await close();
  assert.match(await ev(`return document.querySelector('#origin-main .origin-row').textContent;`), /Unverified/, 'An unchecked source does not verify.');
  await section('research'); await open('Node.js releases'); await seg('Checked?', 'Verified'); await close();
  await section('technology'); assert.match(await ev(`return document.querySelector('#origin-main .origin-row').textContent;`), /Verified/);
  await section('architecture'); await open('API'); await link('Technologies', 'Node.js'); await close();

  // Assumption → decision, then accept it.
  await section('research'); await quick('Fewer than 5,000 concurrent users', 'assumptions'); await open('Fewer than 5,000');
  await set('If it is wrong…', 'Scaling changes'); await press('Make it a decision', '#origin-drawer');
  await wait(`document.querySelector('#origin-section-heading').textContent === 'Decisions' && document.querySelector('#origin-drawer-title')?.value === 'Fewer than 5,000 concurrent users'`, 'decision opened');
  await set('Decision', 'Single region'); await set('Why', 'Modest load'); await seg('Status', 'Accepted'); await close();
  assert.match(await ev(`return document.querySelector('#origin-main .origin-row').textContent;`), /Single region.*ADR-001.*Accepted/);

  // Tasks: a milestone, two project-wide tasks, prerequisites and links; testing answered in place.
  await section('plan'); await quick('Foundation', 'milestones');
  await open('Foundation');
  await set('Done when', 'CI passes'); await close();
  for (const step of ['Repository structure', 'Publish API']) await quick(step, 'items-project');
  await wait(`document.querySelectorAll('#origin-main .origin-task-group .origin-row').length === 2`, 'two tasks');
  await open('Publish API'); await set('Done when', 'POST /notes works'); await link('Starts after', 'Repository structure');
  await link('Requirements', 'Publish release notes'); await link('Components', 'API'); await close();
  assert.match(await ev(`return [...document.querySelectorAll('#origin-main .origin-row')][1].textContent;`), /after IMP-001/);
  await section('testing');
  await ev(`const i = document.querySelector('.origin-topic[data-area="integration"] input'); i.value = 'API integration tests'; i.dispatchEvent(new Event('input', { bubbles: true }));`);
  await wait(`!document.querySelector('.origin-topic[data-area="integration"] .origin-answer-more').hidden`, 'answer stored');
  await ev(`document.querySelector('.origin-topic[data-area="integration"] .origin-answer-more').click();`);
  await wait(`document.querySelector('#origin-drawer-title')?.value === 'API integration tests'`, 'topic details');
  await link('Requirements covered', 'Publish release notes'); await close();
  assert.match(await ev(`return document.querySelector('.origin-progress').textContent;`), /^1 of 9 topics answered/);

  // Overview: transparent counts and a clickable map.
  await section('overview');
  assert.equal(await ev(`return document.querySelector('#origin-readiness').textContent;`), 'Ready for implementation');
  assert.deepEqual(await ev(`return Object.fromEntries([...document.querySelectorAll('.origin-stats dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent]));`), {
    Requirements: '1 / 1 with done-when', Components: '2 / 2 described', Technologies: '1 / 1 verified', Dependencies: '0 / 0 verified', Decisions: '0 unresolved',
    Assumptions: '0 open', Sources: '0 not verified', Testing: '1 area defined', Tasks: '2 tasks · 0 in Kanban' });
  await ev(`[...document.querySelectorAll('.origin-map-leaf')].find(g => g.textContent.includes('Publish release notes')).dispatchEvent(new MouseEvent('click', { bubbles: true }));`);
  await wait(`document.querySelector('#origin-section-heading').textContent === 'Requirements' && document.querySelector('#origin-drawer-title')?.value === 'Publish release notes'`, 'map leaf opens the record');
  await ev(`document.querySelector('#origin-drawer').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
  await wait(`document.querySelector('#origin-drawer').hidden`, 'Escape closes the editor');
  await section('overview');
  await saved();
  const file = await blueprintFile(app, blueprintId);
  assert.equal(file.blueprint.components.length, 2); assert.equal(file.blueprint.connections.length, 1);
  assert.deepEqual(file.blueprint.requirements[0].componentIds, [file.blueprint.components.find(item => item.name === 'API').id], 'The deleted block’s link was removed.');

  // Reload keeps the blueprint and the selected section.
  await browser.reload();
  await wait(`document.querySelectorAll('.origin-nav-item').length === 15 && document.querySelector('#origin-section-heading')?.textContent === 'Overview'`, 'reloaded');
  assert.equal(await ev(`return document.querySelector('#origin-readiness').textContent;`), 'Ready for implementation');

  // Kanban handoff: explicit, ordered, To Do, no run.
  await section('plan'); await press('Select all drafts');
  await ev(`document.querySelector('#origin-kanban-handoff').click();`);
  // Not linked yet: the destination is chosen and shown before anything is sent.
  await wait(`document.querySelector('#origin-connect-dialog')?.open`, 'connect dialog');
  assert.match(await ev(`return document.querySelector('#origin-connect-dialog .origin-callout').textContent;`), /Kanban › Demo project/);
  await ev(`document.querySelector('#origin-connect-dialog-submit').click();`);
  await wait(`document.querySelector('#origin-handoff-dialog')?.open && document.querySelector('#origin-kanban-link').textContent === 'Kanban · Demo project'`, 'handoff dialog after connecting');
  assert.deepEqual(await ev(`return [...document.querySelectorAll('#origin-handoff-dialog .origin-handoff-title')].map(node => node.textContent);`), ['IMP-001 Repository structure', 'IMP-002 Publish API']);
  await ev(`document.querySelector('#origin-handoff-confirm').click();`);
  await wait(`!document.querySelector('#origin-handoff-dialog .origin-handoff-results').hidden`, 'handoff results', 15000);
  assert.deepEqual(await ev(`return [...document.querySelectorAll('#origin-handoff-dialog .origin-handoff-result')].map(node => node.textContent);`), ['IMP-001 → Kanban #2', 'IMP-002 → Kanban #3']);
  await ev(`[...document.querySelectorAll('#origin-handoff-dialog button')].find(b => b.textContent === 'Done').click();`);
  await wait(`!document.querySelector('#origin-handoff-dialog').open && document.querySelector('#origin-main .origin-callout.ok')`, 'handoff done', 15000);
  await saved();
  const view = await app.board.view(), saved1 = view.projects.find(item => item.id === project.id);
  const todo = saved1.pipeline.columns.find(column => column.role === 'todo').id;
  assert.deepEqual(saved1.tasks.map(task => [task.title, task.column]), [['Existing card', todo], ['IMP-001 Repository structure', todo], ['IMP-002 Publish API', todo]]);
  assert.equal(saved1.tasks[0].prompt, existing.prompt);
  assert.match(saved1.tasks[2].prompt, /^# IMP-002 Publish API\n\n## Done when\nPOST \/notes works\n\n---/);
  assert.match(saved1.tasks[2].prompt, /## Starts after\n- IMP-001 Repository structure/);
  assert.match(saved1.tasks[2].prompt, /## Planned tests\n- Integration tests: API integration tests/);
  assert.match(saved1.tasks[2].prompt, /Origin reference: IMP-002 \(origin task [A-Za-z0-9_-]+\)/);
  assert.deepEqual(saved1.tasks[2].dependsOn, [saved1.tasks[1].id], 'The prerequisite travels as a card link.');
  assert.equal(view.runs.length, 0, 'No agent starts.');
  assert.match(await ev(`return document.querySelector('#origin-main').textContent;`), /Kanban #3 · /, 'Progress is read from the Kanban card.');
  // Sending again never adds a card.
  await press('Select all drafts');
  assert.equal(await ev(`return document.querySelector('#origin-kanban-handoff').disabled;`), true, 'Nothing is left to send.');
  assert.equal((await blueprintFile(app, blueprintId)).blueprint.items.filter(item => item.handoff?.taskId).length, 2);

  // Compose handoff: targeted prefill only; nothing is generated.
  await section('requirements'); await open('Publish release notes');
  await ev(`document.querySelector('#origin-drawer .origin-compose').click();`);
  await wait(`location.hash === '#/' && !document.querySelector('#prompt-view').hidden`, 'Compose opened');
  const compose = await ev(`return { text: document.querySelector('#prompt-input').value, task: document.querySelector('#task').value, focus: document.activeElement.id, output: document.querySelector('#prompt-output').hidden };`);
  assert.match(compose.text, /^# Implementation specification from Origin/);
  assert.match(compose.text, /REQ-001 Publish release notes/);
  assert.match(compose.text, /- A maintainer can publish/);
  assert.match(compose.text, /API \(API\): API purpose \[Node\.js\]/);
  assert.doesNotMatch(compose.text, /Repository structure/, 'Unrelated plan items stay out of the prompt.');
  assert.deepEqual([compose.task, compose.focus, compose.output], ['feature', 'prompt-input', true]);
  // A second handoff never silently replaces an edited Compose draft.
  await ev(`const i = document.querySelector('#prompt-input'); i.value += '\\nMy own note.'; location.hash = '#/origin';`);
  await wait(`!document.querySelector('#origin-view').hidden && document.querySelector('#origin-drawer .origin-compose')`, 'back in Origin with the editor');
  await ev(`document.querySelector('#origin-drawer .origin-compose').click();`);
  await wait(`!document.querySelector('#origin-drawer .origin-inline-error').hidden`, 'draft protection');
  assert.equal(await ev(`return location.hash;`), '#/origin');
  assert.equal(generated.length, 0, 'No model call was made.');
  await close();

  // One theme for every page: dark by default, one switch in the top bar.
  const theme = () => ev(`return document.documentElement.dataset.theme;`);
  const go = async hash => { await ev(`location.hash = ${J(hash)};`); await wait(`document.documentElement.dataset.page === ${J(hash === '#/' ? 'compose' : hash.slice(2))}`, `page ${hash}`); };
  assert.equal(await theme(), 'dark');
  await go('#/'); assert.equal(await theme(), 'dark', 'Compose shares the theme.');
  await ev(`document.querySelector('#theme-toggle').click();`);
  assert.deepEqual([await theme(), await ev(`return localStorage.getItem('ste-prompt-engineer.theme');`)], ['light', 'light']);
  await go('#/origin'); assert.equal(await theme(), 'light', 'Origin follows the same switch.');
  await ev(`document.querySelector('#theme-toggle').click();`); assert.equal(await theme(), 'dark');

  // Layout: no horizontal overflow on any page, in both themes; the editor fits narrow screens.
  for (const width of [1280, 390]) {
    await browser.resize(width, 900);
    for (const mode of ['light', 'dark']) {
      await ev(`document.documentElement.dataset.theme = ${J(mode)};`);
      for (const id of ['overview', 'security', 'architecture']) {
        await section(id);
        assert.equal(await browser.layout(`return document.documentElement.scrollWidth <= innerWidth;`), true, `Origin ${id} fits ${width}px in ${mode}`);
      }
      await open('API');
      assert.equal(await browser.layout(`const r = document.querySelector('#origin-drawer').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;`), true, `Editor fits ${width}px`);
      await close();
      for (const hash of ['#/', '#/kanban', '#/base']) {
        await ev(`location.hash = ${J(hash)};`);
        assert.equal(await browser.layout(`return document.documentElement.scrollWidth <= innerWidth;`), true, `${hash} fits ${width}px with four pages`);
      }
      await go('#/origin');
    }
  }
  await browser.resize(1280, 900);
  // Keyboard section navigation inside the sidebar, once the desktop sidebar is laid out again.
  assert.equal(await browser.layout(`return innerWidth === 1280 && getComputedStyle(document.querySelector('#sidebar')).visibility === 'visible' && document.querySelector('.origin-nav-item[data-section="overview"]').getBoundingClientRect().width > 0;`), true);
  // A late page refresh can briefly take focus on slow runners, so focus is re-applied until it holds.
  const focusState = `JSON.stringify({ active: document.activeElement?.dataset.section || document.activeElement?.id || document.activeElement?.tagName, dialogs: [...document.querySelectorAll('dialog[open]')].map(d => d.id) })`;
  await wait(`(() => { const item = document.querySelector('.origin-nav-item[data-section="overview"]'); if (document.activeElement !== item) item.focus(); return document.activeElement === item; })()`, 'sidebar focus')
    .catch(async error => { throw new Error(`${error.message} ${await ev(`return ${focusState};`)}`); });
  await browser.key('ArrowDown', 'ArrowDown', 40);
  await wait(`document.activeElement?.dataset.section === 'vision'`, 'ArrowDown moves to the next section')
    .catch(async error => { throw new Error(`${error.message} ${await ev(`return ${focusState};`)}`); });

  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).version, 13, 'Board state version is unchanged.');
  assert.notEqual(stateBefore, '');
  assert.deepEqual(browser.consoleMessages.filter(message => message.startsWith('EXCEPTION') || /Failed to load|Refused/.test(message)), []);
});

test('Origin restores a damaged project file and refuses stale saves without touching board data', { skip: !await findChrome(), timeout: 90000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const project = await app.board.createProject({ name: 'Damaged', workflowMode: 'pipeline' });
  await app.board.createTask({ projectId: project.id, title: 'Board card', prompt: 'Still here.' });
  const store = new OriginStore(app.board.store.dir);
  const created = await store.create({ name: 'Damaged plan' });
  await store.write(created.id, { expectedRevision: 1, blueprint: { idea: 'Good copy' } });
  await store.write(created.id, { expectedRevision: 2, blueprint: { idea: 'Newest' } });
  await writeFile(join(app.board.store.dir, 'origin', blueprintFileName(created.id)), '{"schema":"promptboard.origin", broken');
  const statePath = join(app.board.store.dir, 'state.json'), stateBefore = await readFile(statePath);
  const browser = await launch({ width: 1280, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  const { ev, wait, saved, section } = pageTools(browser);
  await browser.goto(`${app.url}/#/origin`);
  await wait(`document.querySelector('.origin-map') && !document.querySelector('#origin-notice').hidden`, 'restored project');
  assert.match(await ev(`return document.querySelector('#origin-notice').textContent;`), /damaged, so the last good copy was restored/);
  assert.ok((await readFile(statePath)).equals(stateBefore), 'Board state is untouched by Origin recovery.');

  // Another window saves first: this window refuses to overwrite and offers an explicit choice.
  const token = await ev(`return (await (await fetch('/api/session')).json()).token;`);
  const current = await (await fetch(`${app.url}/api/origin/projects/${created.id}`, { headers: { 'X-STE-Token': token } })).json();
  const other = await fetch(`${app.url}/api/origin/projects/${created.id}`, { method: 'PUT', headers: { 'X-STE-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: current.revision, blueprint: { ...current.blueprint, idea: 'Saved elsewhere' } }) });
  assert.equal(other.status, 200);
  await section('vision');
  await ev(`const t = document.querySelector('#origin-main textarea'); t.value = 'Local edit'; t.dispatchEvent(new Event('input', { bubbles: true }));`);
  await wait(`document.querySelector('#origin-view').dataset.save === 'conflict'`, 'conflict shown', 15000);
  assert.match(await ev(`return document.querySelector('#origin-error').textContent;`), /changed in another window/);
  assert.equal((await blueprintFile(app, created.id)).blueprint.idea, 'Saved elsewhere', 'The newer save was not overwritten.');
  await ev(`[...document.querySelectorAll('#origin-save button')].find(b => b.textContent === 'Reload saved version').click();`);
  await wait(`document.querySelector('#origin-view').dataset.save === 'saved' && document.querySelector('#origin-error').hidden`, 'reloaded saved version');
  assert.equal((await app.board.view()).projects[0].tasks[0].prompt, 'Still here.');
  assert.ok((await readFile(statePath)).equals(stateBefore));
  assert.deepEqual(browser.consoleMessages.filter(message => message.startsWith('EXCEPTION')), []);
});

test('Origin creates projects with or without Kanban, renames, deletes and opens a block with a real click', { skip: !await findChrome(), timeout: 120000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const browser = await launch({ width: 1280, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  const { ev, wait, saved, section, quick } = pageTools(browser);
  await browser.goto(`${app.url}/#/origin`);
  await wait(`document.querySelector('#origin-first-project')`, 'first-project start');
  await ev(`document.querySelector('#origin-start').click();`);
  assert.match(await browser.until(`document.querySelector('#origin-main .origin-inline-error:not([hidden])')?.textContent`, 'name required'), /name/);
  await ev(`document.querySelector('#origin-first-project').value = 'Atlas'; document.querySelector('#origin-idea').value = 'An internal API gateway.'; document.querySelector('#origin-start').click();`);
  await wait(`document.querySelectorAll('.origin-nav-item').length === 15 && document.querySelector('#origin-kanban-link').textContent === 'Kanban · Atlas'`, 'project with Kanban', 20000);
  await saved();
  const atlasKanban = (await app.board.view()).projects.find(item => item.name === 'Atlas');
  assert.ok(atlasKanban?.repository, 'Kanban → New project behaviour: a project with its own repository.');
  const atlasId = await originId(ev);

  // New project without Kanban: no board change at all.
  const boardBefore = await readFile(join(app.board.store.dir, 'state.json'));
  await ev(`document.querySelector('#origin-new-project').click();`);
  await wait(`document.querySelector('#origin-new-dialog')?.open && document.activeElement?.id === 'origin-new-name'`, 'new project dialog');
  await ev(`document.querySelector('#origin-new-name').value = 'Beacon'; document.querySelector('#origin-new-idea').value = 'A status page.'; document.querySelector('#origin-new-kanban').checked = false; document.querySelector('#origin-new-dialog-submit').click();`);
  await wait(`!document.querySelector('#origin-new-dialog').open && document.querySelector('.origin-map-center')?.textContent.includes('Beacon')`, 'second project started', 20000);
  await saved();
  assert.ok((await readFile(join(app.board.store.dir, 'state.json'))).equals(boardBefore), 'An Origin-only project leaves the board untouched.');
  const beaconId = await originId(ev);
  assert.equal((await blueprintFile(app, atlasId)).blueprint.vision.summary, 'An internal API gateway.');
  assert.equal((await blueprintFile(app, beaconId)).blueprint.vision.summary, 'A status page.', 'Each project has its own blueprint.');

  // Rename from the project menu.
  await ev(`document.querySelector('#origin-project-menu summary').click(); [...document.querySelectorAll('.origin-menu-item')].find(b => b.textContent === 'Rename…').click();`);
  await wait(`document.querySelector('#origin-rename-dialog')?.open`, 'rename dialog');
  await ev(`document.querySelector('#origin-rename-name').value = 'Beacon status'; document.querySelector('#origin-rename-dialog-submit').click();`);
  await wait(`[...document.querySelectorAll('#origin-project option')].some(o => o.textContent === 'Beacon status')`, 'renamed');

  // Delete from Origin: the Origin-only project goes; nothing on the board changes.
  await ev(`document.querySelector('#origin-project-menu summary').click(); [...document.querySelectorAll('.origin-menu-item')].find(b => b.textContent === 'Delete from Origin…').click();`);
  await wait(`document.querySelector('#origin-delete-dialog')?.open`, 'delete dialog');
  assert.equal(await ev(`return document.querySelector('#origin-delete-kanban').closest('label').hidden;`), true, 'No Kanban choice for an unlinked project.');
  await ev(`document.querySelector('#origin-delete-dialog-submit').click();`);
  await wait(`!document.querySelector('#origin-delete-dialog').open && document.querySelector('.origin-map-center')?.textContent.includes('Atlas')`, 'back to Atlas');
  assert.deepEqual([...await ev(`return [...document.querySelectorAll('#origin-project option')].map(o => o.textContent);`)], ['Atlas']);

  await section('architecture');
  await quick('Gateway', 'components');
  await wait(`document.querySelectorAll('.origin-node').length === 1`, 'block drawn');
  const point = await ev(`const r = document.querySelector('.origin-node').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
  await browser.click(point.x, point.y);
  await wait(`document.querySelector('#origin-drawer-title')?.value === 'Gateway'`, 'editor opened by a real click');
  await ev(`document.querySelector('#origin-drawer [aria-label="Close editor"]').click();`);

  // Delete with the linked Kanban project: an explicit, separate choice.
  await saved();
  await ev(`document.querySelector('#origin-project-menu summary').click(); [...document.querySelectorAll('.origin-menu-item')].find(b => b.textContent === 'Delete from Origin…').click();`);
  await wait(`document.querySelector('#origin-delete-dialog')?.open && !document.querySelector('#origin-delete-kanban').closest('label').hidden`, 'delete dialog with Kanban choice');
  assert.equal(await ev(`return document.querySelector('#origin-delete-kanban').checked;`), false, 'Kanban work is kept by default.');
  await ev(`document.querySelector('#origin-delete-kanban').checked = true; document.querySelector('#origin-delete-dialog-submit').click();`);
  await wait(`!document.querySelector('#origin-delete-dialog').open && document.querySelector('#origin-first-project')`, 'start screen after deleting the last project');
  assert.equal((await app.board.view()).projects.length, 0, 'The linked Kanban project was removed through Kanban.');
  assert.equal((await app.board.view()).runs.length, 0);
  assert.deepEqual(browser.consoleMessages.filter(message => message.startsWith('EXCEPTION')), []);
});

test('Origin rewords phases, sections and questions in place, and keeps custom sections and answers', { skip: !await findChrome(), timeout: 120000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  await app.board.createProject({ name: 'Board work', workflowMode: 'pipeline' });
  const store = new OriginStore(app.board.store.dir);
  const created = await store.create({ name: 'Wording', description: 'A small notes app' });
  await store.write(created.id, { expectedRevision: 1, blueprint: { idea: 'A small notes app', components: [{ id: 'api', name: 'API', type: 'api', purpose: 'Business rules' }] } });
  const statePath = join(app.board.store.dir, 'state.json'), stateBefore = await readFile(statePath);
  const browser = await launch({ width: 1280, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  const { ev, wait, saved, section, press, open } = pageTools(browser);
  // Rewording goes through the pencil: it opens a field, Enter saves and Escape cancels.
  const reword = async (key, value, finish = 'Enter') => {
    await ev(`document.querySelector('[data-edit=${J(key)}]').click();`);
    await wait(`document.activeElement?.matches('.origin-inline-input')`, `editing ${key}`);
    await ev(`const i = document.activeElement; i.value = ${J(value)}; i.dispatchEvent(new KeyboardEvent('keydown', { key: ${J(finish)}, bubbles: true }));`);
  };
  const navLabels = () => ev(`return [...document.querySelectorAll('.origin-nav-label')].map(n => n.textContent);`);
  await browser.goto(`${app.url}/#/origin`);
  await wait(`document.querySelectorAll('.origin-nav-item').length === 15 && document.querySelector('.origin-map')`, 'navigator');

  await reword('phase:define', 'Discover');
  await wait(`document.querySelector('.phase-define .origin-phase-name')?.textContent === 'Discover'`, 'phase renamed');
  await section('requirements');
  await reword('title', 'Must-haves');
  await wait(`document.querySelector('#origin-section-heading')?.textContent === 'Must-haves' && document.activeElement?.dataset.edit === 'title'`, 'section renamed, focus back on the pencil');
  assert.ok((await navLabels()).includes('Must-haves'));
  await reword('section:requirements', 'What must the app do?');
  await wait(`document.querySelector('.origin-question')?.textContent === 'What must the app do?'`, 'guiding question reworded');
  await reword('section:requirements', 'Thrown away', 'Escape');
  assert.equal(await ev(`return document.querySelector('.origin-question').textContent;`), 'What must the app do?', 'Escape keeps the saved wording.');

  // An answer stays with its question when the question is reworded.
  await section('vision');
  await ev(`const t = [...document.querySelectorAll('.origin-q')].find(q => q.querySelector('[data-edit="vision:goal"]')).querySelector('textarea'); t.value = 'Fewer lost notes'; t.dispatchEvent(new Event('input', { bubbles: true }));`);
  await reword('vision:goal', 'Why now?');
  await wait(`[...document.querySelectorAll('.origin-q-label')].some(l => l.textContent === 'Why now?')`, 'vision question reworded');
  assert.equal(await ev(`return [...document.querySelectorAll('.origin-q')].find(q => q.querySelector('[data-edit="vision:goal"]')).querySelector('textarea').value;`), 'Fewer lost notes');

  // A custom section in Design, with a description and a question of its own.
  await ev(`document.querySelector('.origin-phase.phase-design .origin-phase-add').click();`);
  await wait(`document.activeElement?.matches('#origin-main .origin-inline-input')`, 'new section title is editable');
  await ev(`const i = document.activeElement; i.value = 'Accessibility'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`);
  await wait(`document.querySelectorAll('.origin-nav-item').length === 16 && document.querySelector('#origin-section-heading')?.textContent === 'Accessibility'`, 'custom section in the sidebar');
  assert.equal(await ev(`return document.querySelector('.origin-phase.phase-design li:last-child .origin-nav-label').textContent;`), 'Accessibility');
  await ev(`const t = document.querySelector('#origin-main textarea'); t.value = 'WCAG AA for every screen'; t.dispatchEvent(new Event('input', { bubbles: true }));`);
  await press('＋ Add a question', '#origin-main');
  await wait(`document.activeElement?.matches('.origin-inline-input')`, 'new question is editable');
  await ev(`const i = document.activeElement; i.value = 'Which screen readers?'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`);
  await wait(`document.querySelector('[data-question] .origin-q-label')?.textContent === 'Which screen readers?'`, 'question added');
  const questionId = await ev(`return document.querySelector('[data-question]').dataset.question;`);
  await ev(`const t = document.querySelector('[data-question] textarea'); t.value = 'VoiceOver and NVDA'; t.dispatchEvent(new Event('input', { bubbles: true }));`);
  await reword(`question:${questionId}`, 'Which assistive tech?');
  await wait(`document.querySelector('[data-question] .origin-q-label')?.textContent === 'Which assistive tech?'`, 'question reworded');
  assert.equal(await ev(`return document.querySelector('[data-question] textarea').value;`), 'VoiceOver and NVDA');

  // Component questions: asked for every component, answered per component; field labels can be reworded too.
  await section('architecture');
  await open('API');
  await press('＋ Add a question for every component', '#origin-drawer');
  await wait(`document.activeElement?.matches('#origin-drawer .origin-inline-input')`, 'component question is editable');
  await ev(`const i = document.activeElement; i.value = 'Who owns it?'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`);
  await wait(`document.querySelector('#origin-drawer [data-question] .origin-q-label')?.textContent === 'Who owns it?'`, 'component question added');
  await ev(`const t = document.querySelector('#origin-drawer [data-question] textarea'); t.value = 'Platform team'; t.dispatchEvent(new Event('input', { bubbles: true }));`);
  await reword('field:components:purpose', 'Its job');
  await wait(`[...document.querySelectorAll('#origin-drawer .origin-field-label')].some(l => l.textContent === 'Its job')`, 'component field reworded');
  assert.equal(await ev(`return [...document.querySelectorAll('#origin-drawer .origin-field')].find(f => f.querySelector('.origin-field-label')?.textContent === 'Its job').querySelector('textarea').value;`), 'Business rules');
  await saved();

  let file = (await blueprintFile(app, created.id)).blueprint;
  const component = file.questions.find(question => question.scope === 'component');
  assert.deepEqual(file.labels, { phases: { define: 'Discover' }, sections: { requirements: 'Must-haves' } });
  assert.deepEqual(file.customSections.map(entry => [entry.phase, entry.title, entry.description]), [['design', 'Accessibility', 'WCAG AA for every screen']]);
  assert.deepEqual([file.answers[questionId], file.components[0].answers[component.id], file.vision.goal], ['VoiceOver and NVDA', 'Platform team', 'Fewer lost notes']);
  assert.deepEqual(file.questionText, { 'section:requirements': 'What must the app do?', 'vision:goal': 'Why now?', 'field:components:purpose': 'Its job' });

  // The map shows the custom section; a question with an answer is deleted only on a second click.
  await section('overview');
  await wait(`document.querySelectorAll('.origin-map-section').length === 15`, 'custom branch on the map');
  assert.match(await ev(`return document.querySelector('.origin-map').textContent;`), /Accessibility[\s\S]*VoiceOver and NVDA/);
  await section(file.customSections[0].id);
  await ev(`document.querySelector('[data-question] .origin-q-remove').click();`);
  assert.equal(await ev(`return document.querySelector('[data-question] .origin-q-remove').textContent;`), 'Delete with its answer?');
  await ev(`document.querySelector('[data-question] .origin-q-remove').click();`);
  await wait(`!document.querySelector('#origin-main [data-question]')`, 'question deleted');
  // Clearing a name brings back the built-in one.
  await section('requirements');
  await reword('title', '');
  await wait(`document.querySelector('#origin-section-heading')?.textContent === 'Requirements'`, 'built-in name restored');
  await saved();

  // Everything survives a reload; deleting the section asks first because it has a description.
  await browser.reload();
  await wait(`document.querySelectorAll('.origin-nav-item').length === 16`, 'reloaded with the custom section');
  assert.equal(await ev(`return document.querySelector('.phase-define .origin-phase-name').textContent;`), 'Discover');
  await section(file.customSections[0].id);
  assert.equal(await ev(`return document.querySelectorAll('#origin-main [data-question]').length;`), 0);
  await press('Delete section', '#origin-main');
  await press('Delete the section and what you wrote in it?', '#origin-main');
  await wait(`document.querySelectorAll('.origin-nav-item').length === 15 && document.querySelector('#origin-section-heading')?.textContent === 'Overview'`, 'section deleted');
  await saved();
  file = (await blueprintFile(app, created.id)).blueprint;
  assert.deepEqual([file.customSections, file.labels.sections, Object.keys(file.answers)], [[], {}, []]);
  assert.equal(file.components[0].answers[component.id], 'Platform team', 'Component answers are kept.');
  assert.ok((await readFile(statePath)).equals(stateBefore), 'Rewording never touches board data.');
  assert.deepEqual(browser.consoleMessages.filter(message => message.startsWith('EXCEPTION')), []);
});

test('Origin map: drag, keys, links, zoom and resize are saved per project and never become dependencies', { skip: !await findChrome(), timeout: 120000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  await app.board.createProject({ name: 'Board work', workflowMode: 'pipeline' });
  const store = new OriginStore(app.board.store.dir);
  const created = await store.create({ name: 'Layout', description: 'Map layout check' });
  await store.write(created.id, { expectedRevision: 1, blueprint: { idea: 'Map layout check', requirements: [{ id: 'r1', key: 'REQ-001', title: 'Sign in' }],
    components: [{ id: 'web', name: 'Web', type: 'client', purpose: 'UI' }, { id: 'api', name: 'API', type: 'api', purpose: 'Rules' }], connections: [{ id: 'c1', from: 'web', to: 'api', label: 'calls' }],
    items: [{ id: 'i1', key: 'IMP-001', title: 'Login page' }, { id: 'i2', key: 'IMP-002', title: 'Session API' }] } });
  const statePath = join(app.board.store.dir, 'state.json'), stateBefore = await readFile(statePath);
  const browser = await launch({ width: 1280, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  const { ev, wait, saved, section } = pageTools(browser);
  const centerOf = selector => ev(`const n = document.querySelector(${J(selector)}); n.scrollIntoView({ block: 'center' }); const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
  const drag = async (from, dx, dy) => {
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let step = 1; step <= 6; step++) await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + dx * step / 6, y: from.y + dy * step / 6, button: 'left', buttons: 1 });
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: from.x + dx, y: from.y + dy, button: 'left', buttons: 0, clickCount: 1 });
  };
  const nodeAt = id => ev(`return document.querySelector('[data-node=${J(id)}]').getAttribute('transform');`);
  const viewBox = selector => ev(`return document.querySelector(${J(selector)}).getAttribute('viewBox');`);
  const layout = async () => (await blueprintFile(app, created.id)).blueprint.layout.map;
  await browser.goto(`${app.url}/#/origin`);
  await wait(`document.querySelector('.origin-map [data-node="requirements"]')`, 'map');

  // Dragging moves a branch and saves its place; a click without movement still opens it.
  const before = await nodeAt('requirements');
  await drag(await centerOf('[data-node="requirements"]'), -40, 330);
  await wait(`document.querySelector('[data-node="requirements"]').getAttribute('transform') !== ${J(before)}`, 'branch moved');
  await saved();
  const moved = (await layout()).nodes.requirements;
  assert.ok(moved && Number.isInteger(moved.x) && Number.isInteger(moved.y), 'The new place is saved.');
  assert.equal(await ev(`return document.querySelector('#origin-section-heading').textContent;`), 'Overview', 'Dragging does not open the section.');
  const point = await centerOf('[data-node="requirements"]');
  assert.equal(await ev(`return Boolean(document.elementFromPoint(${point.x}, ${point.y})?.closest('[data-node="requirements"]'));`), true, 'The moved branch stays visible and uncovered.');
  await browser.click(point.x, point.y);
  await wait(`document.querySelector('#origin-section-heading')?.textContent === 'Requirements'`, 'a plain click opens the branch');
  // A text edit keeps the layout.
  await ev(`document.querySelector('[data-edit="title"]').click();`);
  await ev(`const i = document.activeElement; i.value = 'Needs'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`);
  await section('overview');
  assert.deepEqual((await layout()).nodes.requirements, moved);

  // Arrow keys move a focused branch by 20.
  await ev(`document.querySelector('[data-node="vision"]').focus();`);
  await browser.key('ArrowRight', 'ArrowRight', 39);
  await wait(`document.activeElement?.dataset.node === 'vision'`, 'focus stays on the moved branch');
  await saved();
  const vision = (await layout()).nodes.vision;
  await browser.key('ArrowDown', 'ArrowDown', 40);
  await saved();
  assert.deepEqual((await layout()).nodes.vision, { x: vision.x, y: vision.y + 20 });

  // A decorative link: Link, then the two ends. It is stored on the map only.
  await ev(`document.querySelector('#origin-map-link').click();`);
  await wait(`document.querySelector('#origin-map-link').textContent === 'Cancel'`, 'link mode');
  await ev(`document.querySelector('[data-node="vision"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));`);
  await wait(`document.querySelector('[data-node="vision"]').classList.contains('linking')`, 'first end chosen');
  await ev(`document.querySelector('[data-node="plan"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));`);
  await wait(`document.activeElement?.id === 'origin-map-link-label'`, 'link label editor');
  await ev(`const i = document.activeElement; i.value = 'informs'; i.dispatchEvent(new Event('input', { bubbles: true }));`);
  await saved();
  let file = (await blueprintFile(app, created.id)).blueprint;
  assert.deepEqual(file.layout.map.links.map(link => [link.from, link.to, link.label]), [['vision', 'plan', 'informs']]);
  assert.deepEqual([file.items.map(item => item.dependsOn), file.connections.length], [[[], []], 1], 'A map link never becomes a dependency or a connection.');
  await ev(`document.querySelector('#origin-map-link').click(); document.querySelector('[data-node="center"]').focus();`);
  await browser.key('Escape', 'Escape', 27);
  await wait(`document.querySelector('#origin-map-link').textContent === 'Link'`, 'Escape leaves link mode');

  // Zoom, fit and pan change the view only; nothing is saved for them.
  const revision = (await blueprintFile(app, created.id)).revision;
  await ev(`document.querySelector('.origin-map-card [aria-label="Fit to view"]').click();`);
  const fitted = await viewBox('.origin-map');
  await ev(`document.querySelector('.origin-map-card [aria-label="Zoom in"]').click();`);
  const zoomed = await viewBox('.origin-map');
  assert.ok(Number(zoomed.split(' ')[2]) < Number(fitted.split(' ')[2]), 'Zoom in shows less.');
  // An empty spot of the map that is on screen, whatever the window height.
  const background = await ev(`const svg = document.querySelector('.origin-map'); svg.scrollIntoView({ block: 'center' }); const r = svg.getBoundingClientRect(); for (let y = Math.max(r.top + 12, 80); y < Math.min(r.bottom, innerHeight) - 4; y += 12) for (let x = r.left + 12; x < r.right - 12; x += 24) if (document.elementFromPoint(x, y) === svg) return { x, y }; return null;`);
  assert.ok(background, 'An empty part of the map is visible.');
  await drag(background, 80, 0);
  assert.notEqual(await viewBox('.origin-map'), zoomed, 'Dragging the background pans.');
  await ev(`document.querySelector('.origin-map-card [aria-label="Fit to view"]').click();`);
  assert.equal(await viewBox('.origin-map'), fitted);
  assert.equal((await blueprintFile(app, created.id)).revision, revision);

  // The corner handle resizes the map: drag, arrow keys, and Home back to automatic.
  const card = await ev(`const r = document.querySelector('.origin-map-card').getBoundingClientRect(); return { width: r.width, height: r.height };`);
  await drag(await centerOf('#origin-map-resize'), -200, 80);
  await saved();
  let size = await layout();
  assert.ok(Math.abs(size.width - (card.width - 200)) <= 3 && Math.abs(size.height - (card.height + 80)) <= 3, `size saved: ${size.width}×${size.height}`);
  await ev(`document.querySelector('#origin-map-resize').focus();`);
  await browser.key('ArrowDown', 'ArrowDown', 40);
  await saved();
  assert.equal((await layout()).height, size.height + 20);
  assert.equal(await ev(`return document.activeElement?.id;`), 'origin-map-resize');

  // Everything survives a reload; Arrange asks before putting branches back, and keeps links.
  const placed = await nodeAt('requirements');
  await browser.reload();
  await wait(`document.querySelector('.origin-map [data-node="requirements"]')`, 'reloaded map');
  assert.equal(await nodeAt('requirements'), placed);
  assert.equal(await ev(`return document.querySelector('.origin-map-card').style.height;`), `${size.height + 20}px`);
  await ev(`document.querySelector('#origin-map-resize').focus();`);
  await browser.key('Home', 'Home', 36);
  await saved();
  size = await layout();
  assert.deepEqual([size.width, size.height], [null, null]);
  await ev(`document.querySelector('#origin-map-arrange').click();`);
  assert.equal(await ev(`return document.querySelector('#origin-map-arrange').textContent;`), 'Reset the layout?');
  await ev(`document.querySelector('#origin-map-arrange').click();`);
  await saved();
  file = (await blueprintFile(app, created.id)).blueprint;
  assert.deepEqual([file.layout.map.nodes, file.layout.map.links.length], [{}, 1]);

  // The architecture canvas keeps the view while a block is dragged, and saves the block's place.
  await section('architecture');
  await ev(`document.querySelector('.origin-canvas-card [aria-label="Zoom out"]').click();`);
  const canvasView = await viewBox('.origin-canvas');
  await drag(await centerOf('.origin-node[data-id="api"]'), 40, 30);
  await saved();
  assert.equal(await viewBox('.origin-canvas'), canvasView, 'The view does not jump after a move.');
  file = (await blueprintFile(app, created.id)).blueprint;
  assert.ok(Number.isInteger(file.components.find(item => item.id === 'api').x));
  assert.ok((await readFile(statePath)).equals(stateBefore), 'Layout changes never touch board data.');
  assert.deepEqual(browser.consoleMessages.filter(message => message.startsWith('EXCEPTION')), []);
});

test('Origin Tasks: layers, component task lists, grouping, filters, order, and tasks kept when a component goes', { skip: !await findChrome(), timeout: 120000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const kanban = await app.board.createProject({ name: 'Shop', workflowMode: 'legacy' });
  const card = await app.board.createTask({ projectId: kanban.id, title: 'IMP-009 Old card', prompt: 'Already there.' });
  const store = new OriginStore(app.board.store.dir);
  const created = await store.create({ name: 'Shop design', description: 'A small shop' });
  await store.link(created.id, { expectedRevision: 1, kanbanProjectId: kanban.id });
  await store.write(created.id, { expectedRevision: 2, blueprint: { idea: 'A small shop',
    components: [{ id: 'web', name: 'Web', type: 'client', purpose: 'UI' }, { id: 'api', name: 'API', type: 'api', purpose: 'Rules' }, { id: 'db', name: 'Database', type: 'database', purpose: 'Storage' }],
    technologies: [{ id: 't1', name: 'PostgreSQL', status: 'selected' }, { id: 't2', name: 'Redis', status: 'candidate' }],
    milestones: [{ id: 'm1', title: 'Foundation' }],
    items: [{ id: 'old', key: 'IMP-009', title: 'Old card', handoff: { projectId: kanban.id, taskId: card.id, at: Date.now() } }], sequence: { items: 9 } } });
  const browser = await launch({ width: 1280, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  const { ev, wait, saved, section, quick, press, open, close, set, link } = pageTools(browser);
  const file = async () => (await blueprintFile(app, created.id)).blueprint;
  const choose = (label, text) => ev(`const f = [...document.querySelectorAll('#origin-drawer .origin-field')].find(f => f.querySelector('.origin-field-label')?.textContent === ${J(label)}); const s = f.querySelector('select'); s.value = [...s.options].find(o => o.textContent === ${J(text)}).value; s.dispatchEvent(new Event('change', { bubbles: true }));`);
  await browser.goto(`${app.url}/#/origin`);
  await wait(`document.querySelector('.origin-map')`, 'map');

  // A layer with its stack and shared rules; a component joins it.
  await section('architecture');
  await quick('Backend', 'layers');
  await open('Backend'); await link('Stack', 'PostgreSQL'); await set('Shared rules', 'Every endpoint validates input'); await close();
  await open('API'); await choose('Layer', 'Backend');
  // Adding a task in the component editor links the component; the layer follows from it.
  await ev(`const i = document.querySelector('#origin-drawer .origin-mini-add input'); i.value = 'Session endpoint'; i.form.requestSubmit();`);
  await wait(`[...document.querySelectorAll('#origin-drawer .origin-mini-row')].some(r => r.textContent.includes('Session endpoint')) && document.activeElement?.dataset.focusKey === 'task:add'`, 'task added in the component editor');
  await close();
  await saved();
  let blueprint = await file();
  const layerId = blueprint.layers[0].id, session = blueprint.items.find(item => item.title === 'Session endpoint');
  assert.deepEqual([blueprint.layers[0].technologyIds, blueprint.layers[0].constraints, blueprint.components.find(item => item.id === 'api').layerId], [['t1'], 'Every endpoint validates input', layerId]);
  assert.deepEqual([session.key, session.componentIds, session.layerId], ['IMP-010', ['api'], ''], 'Keys continue; the layer is derived, not copied.');

  // Tasks are grouped by layer and component; a layer and the project take tasks of their own.
  await section('plan');
  const groupText = name => ev(`return [...document.querySelectorAll('.origin-task-group')].find(g => g.querySelector('.origin-task-group-head').textContent.startsWith(${J(name)}))?.textContent || '';`);
  assert.match(await groupText('Backend'), /PostgreSQL[\s\S]*API[\s\S]*Session endpoint/);
  assert.match(await groupText('Components without a layer'), /Web[\s\S]*Database/);
  assert.match(await groupText('Project-wide'), /Old card[\s\S]*Kanban #1 · To Do/, 'Progress is read from Kanban.');
  await quick('Request logging', `items-l-${layerId}`);
  await quick('Set up CI', 'items-project');
  await wait(`document.querySelectorAll('#origin-main .origin-task-group .origin-row').length === 4`, 'four tasks');
  assert.match(await groupText('Backend'), /Whole layer[\s\S]*Request logging/);
  // Only the essentials show first; links and order sit under More details. A title is enough to save.
  await open('Set up CI');
  assert.deepEqual(await ev(`return [...document.querySelectorAll('#origin-drawer .origin-drawer-body > .origin-field .origin-field-label')].map(l => l.textContent);`), ['What to do', 'Done when']);
  await choose('Milestone', 'Foundation'); await close();
  await saved();
  blueprint = await file();
  assert.deepEqual(blueprint.items.map(item => [item.title, item.componentIds.join(), item.layerId, item.milestoneId]),
    [['Old card', '', '', ''], ['Session endpoint', 'api', '', ''], ['Request logging', '', layerId, ''], ['Set up CI', '', '', 'm1']]);

  // All tasks: one list with where each task lives; the milestone filter narrows both views.
  await press('All tasks', '#origin-main');
  await wait(`document.querySelector('.origin-toggle [aria-pressed="true"]').textContent === 'All tasks'`, 'all tasks view');
  assert.deepEqual(await ev(`return [...document.querySelectorAll('#origin-main .origin-list:first-of-type .origin-row')].slice(0, 4).map(r => r.querySelector('.origin-row-sub').textContent.split(' · ')[0]);`), ['Project-wide', 'API', 'Backend', 'Project-wide']);
  await ev(`const s = document.querySelector('#origin-task-milestone'); s.value = 'm1'; s.dispatchEvent(new Event('change', { bubbles: true }));`);
  await wait(`[...document.querySelectorAll('#origin-main .origin-row-title')].map(n => n.textContent).join('|').startsWith('Set up CI|')`, 'filtered to the milestone');
  await ev(`const s = document.querySelector('#origin-task-milestone'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true }));`);
  // Reordering in the editor moves past the neighbour in this list.
  await open('Request logging'); await press('Move up', '#origin-drawer'); await close();
  await saved();
  assert.deepEqual((await file()).items.map(item => item.title), ['Old card', 'Request logging', 'Session endpoint', 'Set up CI']);

  // Removing a component keeps its tasks and shows the missing link until it is relinked.
  await section('architecture'); await open('API');
  await press('Delete', '#origin-drawer'); await press('Delete and unlink 1 reference?', '#origin-drawer');
  await wait(`document.querySelector('#origin-drawer').hidden`, 'component deleted');
  await section('plan'); await press('By layer', '#origin-main');
  assert.match(await groupText('Project-wide'), /Session endpoint[\s\S]*Link missing/);
  await open('Session endpoint');
  assert.match(await ev(`return document.querySelector('#origin-drawer .origin-lost').textContent;`), /Its component “API” was removed\./);
  await ev(`const s = document.querySelector('#origin-drawer .origin-lost select'); s.value = 'web'; s.dispatchEvent(new Event('change', { bubbles: true }));`);
  await wait(`!document.querySelector('#origin-drawer .origin-lost')`, 'relinked');
  await close(); await saved();
  const relinked = (await file()).items.find(item => item.title === 'Session endpoint');
  assert.deepEqual([relinked.componentIds, relinked.lostLinks], [['web'], []]);
  // A card removed in Kanban shows as removed; Origin never claims it is done.
  await app.board.deleteTask(card.id, { expectedRevision: (await app.board.view()).projects[0].tasks[0].revision });
  await browser.reload();
  await wait(`document.querySelector('.origin-task-group')`, 'tasks after reload');
  assert.match(await groupText('Project-wide'), /Old card[\s\S]*Card removed/);
  assert.deepEqual(browser.consoleMessages.filter(message => message.startsWith('EXCEPTION')), []);
});

test('Origin shows the context a task carries, from the saved blueprint, and adds only what you link', { skip: !await findChrome(), timeout: 90000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const store = new OriginStore(app.board.store.dir);
  const created = await store.create({ name: 'Notes' });
  await store.write(created.id, { expectedRevision: 1, blueprint: { idea: 'Notes', vision: { summary: 'Shared notes', constraints: 'EU hosting only' },
    components: [{ id: 'api', name: 'API', type: 'api', purpose: 'Rules' }],
    requirements: [{ id: 'r1', key: 'REQ-001', title: 'Publish', acceptanceCriteria: 'A maintainer can publish', componentIds: ['api'] }],
    decisions: [{ id: 'd1', key: 'ADR-001', title: 'Logging', decision: 'JSON lines', status: 'accepted' }],
    items: [{ id: 'i1', key: 'IMP-001', title: 'Publish endpoint', description: 'Add POST /notes.', acceptanceCriteria: 'Returns 201', componentIds: ['api'], requirementIds: ['r1'] }], sequence: { items: 1 } } });
  const browser = await launch({ width: 1280, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  const { ev, wait, saved, section, open, link } = pageTools(browser);
  await browser.goto(`${app.url}/#/origin`);
  await wait(`document.querySelector('.origin-map')`, 'map');
  await section('plan'); await open('Publish endpoint');
  await ev(`document.querySelector('#origin-drawer .origin-context').open = true;`);
  await wait(`document.querySelector('#origin-drawer .origin-context-names')`, 'context summary');
  const names = () => ev(`return Object.fromEntries([...document.querySelectorAll('#origin-drawer .origin-context-names dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent]));`);
  assert.deepEqual(await names(), { Components: 'API', Requirements: 'REQ-001 Publish' });
  assert.match(await ev(`return document.querySelector('#origin-drawer .origin-context-text').textContent;`), /^# IMP-001 Publish endpoint\n\n## What to do\nAdd POST \/notes\.[\s\S]*## Project constraints\nEU hosting only/);
  assert.doesNotMatch(await ev(`return document.querySelector('#origin-drawer .origin-context-text').textContent;`), /ADR-001/, 'An unrelated decision is not guessed in.');
  // Linking a decision under More details adds exactly that; the preview says when it is out of date.
  await link('Also include', 'ADR-001 Logging');
  await saved();
  await wait(`document.querySelector('#origin-drawer .origin-context')?.textContent.includes('Changed since this preview')`, 'stale preview noticed');
  await ev(`[...document.querySelectorAll('#origin-drawer .origin-context button')].find(b => b.textContent === 'Refresh').click();`);
  await wait(`document.querySelector('#origin-drawer .origin-context-names')?.textContent.includes('ADR-001 Logging')`, 'refreshed with the linked decision');
  assert.deepEqual((await blueprintFile(app, created.id)).blueprint.items[0].contextIds, [{ collection: 'decisions', id: 'd1' }]);
  assert.deepEqual(browser.consoleMessages.filter(message => message.startsWith('EXCEPTION')), []);
});

test('Origin Send to Kanban asks before including prerequisites, never duplicates, and Kanban shows what a card waits for', { skip: !await findChrome(), timeout: 120000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const kanban = await app.board.createProject({ name: 'Shop', workflowMode: 'pipeline' });
  const store = new OriginStore(app.board.store.dir);
  let created = await store.create({ name: 'Shop design' });
  created = await store.link(created.id, { expectedRevision: 1, kanbanProjectId: kanban.id });
  await store.write(created.id, { expectedRevision: created.revision, blueprint: { idea: 'Shop',
    items: [{ id: 'i1', key: 'IMP-001', title: 'Schema', acceptanceCriteria: 'Tables exist' }, { id: 'i2', key: 'IMP-002', title: 'Orders API', acceptanceCriteria: 'Orders can be placed', dependsOn: ['i1'] }], sequence: { items: 2 } } });
  const browser = await launch({ width: 1280, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  const { ev, wait, section, press } = pageTools(browser);
  const check = key => ev(`[...document.querySelectorAll('#origin-main .origin-row')].find(r => r.textContent.includes(${J(key)})).querySelector('.origin-check').click();`);
  await browser.goto(`${app.url}/#/origin`);
  await wait(`document.querySelector('.origin-map')`, 'map');
  await section('plan');
  await check('IMP-002');
  await ev(`document.querySelector('#origin-kanban-handoff').click();`);
  await wait(`document.querySelector('#origin-handoff-dialog')?.open`, 'review panel');
  assert.match(await ev(`return document.querySelector('#origin-handoff-dialog .origin-handoff-prerequisites').textContent;`), /Include prerequisites: IMP-001 Schema/);
  assert.equal(await ev(`return document.querySelector('#origin-handoff-confirm').disabled;`), true, 'A prerequisite is never left out silently.');
  await ev(`document.querySelector('#origin-handoff-prerequisites').click();`);
  assert.deepEqual(await ev(`const b = document.querySelector('#origin-handoff-confirm'); return [b.disabled, b.textContent];`), [false, 'Send 2 tasks']);
  await ev(`document.querySelector('#origin-handoff-confirm').click();`);
  await wait(`!document.querySelector('#origin-handoff-dialog .origin-handoff-results').hidden`, 'results', 15000);
  assert.deepEqual(await ev(`return [...document.querySelectorAll('#origin-handoff-dialog .origin-handoff-result')].map(node => node.textContent);`), ['IMP-001 → Kanban #1', 'IMP-002 → Kanban #2']);
  await ev(`[...document.querySelectorAll('#origin-handoff-dialog button')].find(b => b.textContent === 'Done').click();`);
  await wait(`!document.querySelector('#origin-handoff-dialog').open && /Kanban #2 · /.test(document.querySelector('#origin-main').textContent)`, 'rows show the cards');
  // Sending the same tasks again returns the existing cards.
  await check('IMP-001'); await check('IMP-002');
  await ev(`document.querySelector('#origin-kanban-handoff').click();`);
  await wait(`document.querySelector('#origin-handoff-dialog')?.open && document.querySelectorAll('#origin-handoff-dialog .origin-chip.ok').length === 2`, 'existing cards shown');
  await ev(`document.querySelector('#origin-handoff-confirm').click();`);
  await wait(`!document.querySelector('#origin-handoff-dialog .origin-handoff-results').hidden`, 'second results', 15000);
  assert.deepEqual(await ev(`return [...document.querySelectorAll('#origin-handoff-dialog .origin-handoff-result')].map(node => node.textContent);`), ['IMP-001 → Kanban #1 (already there)', 'IMP-002 → Kanban #2 (already there)']);
  assert.equal((await app.board.view()).projects[0].tasks.length, 2);
  assert.equal((await app.board.view()).runs.length, 0, 'No agent starts.');
  // Kanban shows what the card waits for, and why it cannot start yet.
  await ev(`[...document.querySelectorAll('#origin-handoff-dialog button')].find(b => b.textContent === 'Open Kanban').click();`);
  await wait(`location.hash === '#/kanban' && [...document.querySelectorAll('.task-waits')].some(n => n.textContent === 'Waits for #1')`, 'waiting badge on the card');
  assert.deepEqual(browser.consoleMessages.filter(message => message.startsWith('EXCEPTION')), []);
});

test('Origin refines tasks through Compose only when asked, keeps your words until you accept, and adds suggestions you choose', { skip: !await findChrome(), timeout: 150000 }, async t => {
  const calls = [];
  const app = await startTestServer(t, { port: 0, detector: async () => [{ id: 'codex', available: true }], authAdapter: { installed: async () => true, status: async () => ({ state: 'signed-in' }) },
    runner: async call => {
      calls.push(call.prompt);
      if (call.prompt.startsWith('# Task split')) return { text: JSON.stringify({ tasks: [{ title: 'Create the orders table', prompt: 'Add the orders table.' }, { title: 'Decide the payment provider', prompt: 'Choose and record the payment provider.' }] }) };
      return { text: 'Build the orders endpoint with validation and tests.' };
    } });
  const store = new OriginStore(app.board.store.dir);
  const created = await store.create({ name: 'Shop design' });
  await store.write(created.id, { expectedRevision: 1, blueprint: { idea: 'Shop', components: [{ id: 'api', name: 'API', type: 'api', purpose: 'Rules' }],
    items: [{ id: 'i1', key: 'IMP-001', title: 'Orders endpoint', description: 'Make orders work', acceptanceCriteria: 'Orders can be placed', componentIds: ['api'] },
      { id: 'i2', key: 'IMP-002', title: 'Order emails', componentIds: ['api'] }], sequence: { items: 2 } } });
  const browser = await launch({ width: 1280, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  const { ev, wait, saved, section, open, press } = pageTools(browser);
  const file = async () => (await blueprintFile(app, created.id)).blueprint;
  // Compose's own settings are used: here its fast, single-pass mode.
  await browser.goto(app.url);
  await wait(`!document.querySelector('#generate-button').disabled`, 'Compose ready', 20000);
  await ev(`document.querySelector('[name="quality"][value="fast"]').click();`);
  await ev(`location.hash = '#/origin';`);
  await wait(`document.querySelector('.origin-map')`, 'Origin');
  await section('plan'); await open('Orders endpoint');
  await press('Improve with Compose', '#origin-drawer');
  await wait(`location.hash === '#/' && !document.querySelector('#compose-origin').hidden`, 'Compose with the task');
  assert.equal(await ev(`return document.querySelector('#compose-origin-text').textContent;`), 'From Origin · IMP-001 Orders endpoint');
  assert.match(await ev(`return document.querySelector('#prompt-input').value;`), /^# IMP-001 Orders endpoint\n\n## What to do\nMake orders work\n\n## Done when\nOrders can be placed\n\n---\n\n# Context from the Origin design/);
  assert.equal(calls.length, 0, 'Opening Compose generates nothing.');
  await ev(`document.querySelector('#generate-button').click();`);
  await wait(`document.querySelector('#cancel-button').hidden && !document.querySelector('#prompt-output').hidden && !document.querySelector('#compose-origin-use').disabled`, 'generated', 20000);
  assert.equal(calls.length, 1);
  await ev(`document.querySelector('#compose-origin-use').click();`);
  await wait(`location.hash === '#/origin' && document.querySelector('#origin-drawer .origin-proposal textarea')`, 'proposal on the task');
  assert.equal(await ev(`return document.querySelector('#origin-drawer .origin-proposal textarea').value;`), 'Build the orders endpoint with validation and tests.');
  assert.equal((await file()).items[0].description, 'Make orders work', 'A proposal changes nothing on its own.');
  await ev(`const t = document.querySelector('#origin-drawer .origin-proposal textarea'); t.value = 'Build the orders endpoint with validation.'; t.dispatchEvent(new Event('input', { bubbles: true }));`);
  await press('Use as What to do', '#origin-drawer');
  await saved();
  let first = (await file()).items[0];
  assert.deepEqual([first.description, first.acceptanceCriteria, first.refinement.originalDescription, typeof first.refinement.acceptedAt, first.componentIds], ['Build the orders endpoint with validation.', 'Orders can be placed', 'Make orders work', 'number', ['api']]);
  await ev(`document.querySelector('#origin-drawer [aria-label="Close editor"]').click();`);

  // Several tasks: one proposal each, through Compose's job slot; your text stays until you accept.
  await ev(`[...document.querySelectorAll('#origin-main .origin-row')].find(r => r.textContent.includes('IMP-002')).querySelector('.origin-check').click();`);
  await ev(`document.querySelector('#origin-improve').click();`);
  await wait(`document.querySelector('#origin-improve-dialog')?.open`, 'improve dialog');
  await ev(`document.querySelector('#origin-improve-start').click();`);
  await wait(`[...document.querySelectorAll('#origin-improve-dialog .origin-chip')].map(n => n.textContent).join() === 'Proposal ready'`, 'batch done', 20000);
  await ev(`[...document.querySelectorAll('#origin-improve-dialog button')].find(b => b.textContent === 'Close').click();`);
  await saved();
  const second = (await file()).items[1];
  assert.deepEqual([second.description, second.refinement.proposal, second.refinement.acceptedAt], ['', 'Build the orders endpoint with validation and tests.', null]);
  assert.equal(calls.length, 2);
  assert.match(await ev(`return [...document.querySelectorAll('#origin-main .origin-row')].find(r => r.textContent.includes('IMP-002')).textContent;`), /Proposal to review/);

  // Suggest tasks from one component: shown first, edited, and only the chosen ones are added.
  await ev(`[...document.querySelectorAll('.origin-task-component')].find(b => b.dataset.component === 'api').querySelector('.origin-suggest').click();`);
  await wait(`document.querySelector('#origin-suggest-dialog')?.open`, 'suggest dialog');
  assert.equal(calls.length, 2, 'Opening Suggest calls nothing.');
  await ev(`document.querySelector('#origin-suggest-start').click();`);
  await wait(`document.querySelectorAll('#origin-suggest-dialog .origin-suggestion').length === 2`, 'suggestions', 20000);
  assert.match(calls[2], /^# Task split[\s\S]*Plan implementation tasks for the component “API” in Shop design/);
  await ev(`const rows = document.querySelectorAll('#origin-suggest-dialog .origin-suggestion'); rows[1].querySelector('input[type=checkbox]').click(); const t = rows[0].querySelector('.origin-suggestion-title'); t.value = 'Create the orders table now'; t.dispatchEvent(new Event('input', { bubbles: true }));`);
  await ev(`document.querySelector('#origin-suggest-add').click();`);
  await saved();
  const added = (await file()).items.at(-1);
  assert.deepEqual([added.key, added.title, added.description, added.componentIds, (await file()).items.length], ['IMP-003', 'Create the orders table now', 'Add the orders table.', ['api'], 3]);
  assert.equal(calls.length, 3, 'Editing and choosing call nothing else.');
  assert.equal((await app.board.view()).projects.length, 0, 'Nothing is sent to Kanban.');
  assert.deepEqual(browser.consoleMessages.filter(message => message.startsWith('EXCEPTION')), []);
});

test('Origin flags only sent tasks whose context changed, compares, and updates the idle card after review', { skip: !await findChrome(), timeout: 120000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const kanban = await app.board.createProject({ name: 'Shop', workflowMode: 'pipeline' });
  const store = new OriginStore(app.board.store.dir);
  let record = await store.create({ name: 'Shop design' });
  record = await store.link(record.id, { expectedRevision: record.revision, kanbanProjectId: kanban.id });
  record = await store.write(record.id, { expectedRevision: record.revision, blueprint: { idea: 'Shop',
    technologies: [{ id: 'pg', name: 'PostgreSQL', status: 'selected' }, { id: 'react', name: 'React', status: 'selected' }],
    layers: [{ id: 'data', name: 'Data', technologyIds: ['pg'] }, { id: 'ui', name: 'Interface', technologyIds: ['react'] }],
    components: [{ id: 'db', name: 'Database', type: 'database', purpose: 'Storage', layerId: 'data' }, { id: 'web', name: 'Web app', type: 'client', purpose: 'Shop', layerId: 'ui' }],
    items: [{ id: 'schema', key: 'IMP-001', title: 'Schema', acceptanceCriteria: 'Tables exist', componentIds: ['db'] }, { id: 'grid', key: 'IMP-002', title: 'Grid', acceptanceCriteria: 'Grid shows', componentIds: ['web'] }], sequence: { items: 2 } } });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const sent = await fetch(`${app.url}/api/origin/projects/${record.id}/handoff`, { method: 'POST', headers: { 'X-STE-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: record.revision, itemIds: ['schema', 'grid'] }) });
  assert.equal(sent.status, 200);
  record = await store.read(record.id);
  record.blueprint.technologies.push({ id: 'ts', name: 'TimescaleDB', status: 'selected' }); record.blueprint.layers[0].technologyIds.push('ts');
  record = await store.write(record.id, { expectedRevision: record.revision, blueprint: record.blueprint });
  const browser = await launch({ width: 1280, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  const { ev, wait, saved, section, open } = pageTools(browser);
  await browser.goto(`${app.url}/#/origin`);
  await wait(`document.querySelector('.origin-map')`, 'map');
  await section('plan');
  await wait(`[...document.querySelectorAll('#origin-main .origin-row')].some(r => r.textContent.includes('Context changed'))`, 'changed chip');
  assert.deepEqual(await ev(`return [...document.querySelectorAll('#origin-main .origin-row')].filter(r => r.textContent.includes('Context changed')).map(r => r.querySelector('.origin-row-title').textContent);`), ['Schema'], 'Only the task in the changed layer is flagged.');
  await open('Schema');
  await wait(`document.querySelector('#origin-drawer .origin-changed')`, 'review panel');
  assert.match(await ev(`return document.querySelector('#origin-drawer .origin-changed').textContent;`), /Context changed since it was sent to Kanban #1[\s\S]*Added: TimescaleDB/);
  await ev(`document.querySelector('#origin-drawer .origin-changed details').open = true;`);
  assert.match(await ev(`return [...document.querySelectorAll('#origin-drawer .origin-compare pre')].map(p => p.textContent).join('|');`), /Stack: PostgreSQL\n[\s\S]*\|[\s\S]*Stack: PostgreSQL, TimescaleDB/);
  await ev(`[...document.querySelectorAll('#origin-drawer .origin-changed button')].find(b => b.textContent === 'Update context').click();`);
  await wait(`!document.querySelector('#origin-drawer .origin-changed') && ![...document.querySelectorAll('#origin-main .origin-row')].some(r => r.textContent.includes('Context changed'))`, 'updated', 15000);
  const cards = (await app.board.view()).projects[0].tasks;
  assert.match(cards[0].prompt, /Stack: PostgreSQL, TimescaleDB/);
  assert.doesNotMatch(cards[1].prompt, /TimescaleDB/);
  assert.equal((await app.board.view()).runs.length, 0);
  await saved();
  assert.deepEqual(browser.consoleMessages.filter(message => message.startsWith('EXCEPTION')), []);
});
