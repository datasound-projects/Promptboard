import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';
import { originFileName } from '../src/origin.mjs';

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
async function blueprintFile(app, projectId) { return JSON.parse(await readFile(join(app.board.store.dir, 'origin', originFileName(projectId)), 'utf8')); }

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
  await ev(`document.querySelector('#origin-idea').value = ${J(hostile)}; document.querySelector('#origin-start').click();`);
  await wait(`document.querySelectorAll('.origin-nav-item').length === 15 && document.querySelector('.origin-map')`, 'mind map');
  await saved();
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

  // Plan: a milestone with ordered steps; testing answered in place.
  await section('plan'); await quick('Foundation', 'milestones');
  await ev(`[...document.querySelectorAll('.origin-milestone-title')].find(b => b.textContent.includes('Foundation')).click();`);
  await wait(`document.querySelector('#origin-drawer-title')?.value === 'Foundation'`, 'milestone editor');
  await set('Done when', 'CI passes'); await close();
  for (const step of ['Repository structure', 'Publish API']) await ev(`const i = document.querySelector('.origin-milestone .origin-quick input'); i.value = ${J(step)}; i.form.requestSubmit();`);
  await wait(`document.querySelectorAll('.origin-milestone .origin-row').length === 2`, 'two steps');
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
    Assumptions: '0 open', Sources: '0 not verified', Testing: '1 area defined', Implementation: '2 items · 0 sent to Kanban' });
  await ev(`[...document.querySelectorAll('.origin-map-leaf')].find(g => g.textContent.includes('Publish release notes')).dispatchEvent(new MouseEvent('click', { bubbles: true }));`);
  await wait(`document.querySelector('#origin-section-heading').textContent === 'Requirements' && document.querySelector('#origin-drawer-title')?.value === 'Publish release notes'`, 'map leaf opens the record');
  await ev(`document.querySelector('#origin-drawer').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
  await wait(`document.querySelector('#origin-drawer').hidden`, 'Escape closes the editor');
  await section('overview');
  await saved();
  const file = await blueprintFile(app, project.id);
  assert.equal(file.blueprint.components.length, 2); assert.equal(file.blueprint.connections.length, 1);
  assert.deepEqual(file.blueprint.requirements[0].componentIds, [file.blueprint.components.find(item => item.name === 'API').id], 'The deleted block’s link was removed.');

  // Reload keeps the blueprint and the selected section.
  await browser.reload();
  await wait(`document.querySelectorAll('.origin-nav-item').length === 15 && document.querySelector('#origin-section-heading')?.textContent === 'Overview'`, 'reloaded');
  assert.equal(await ev(`return document.querySelector('#origin-readiness').textContent;`), 'Ready for implementation');

  // Kanban handoff: explicit, ordered, To Do, no run.
  await section('plan'); await press('Select all not sent');
  await ev(`document.querySelector('#origin-kanban-handoff').click();`);
  await wait(`document.querySelector('#origin-handoff-dialog')?.open`, 'handoff dialog');
  assert.deepEqual(await ev(`return [...document.querySelectorAll('#origin-handoff-dialog li')].map(li => li.textContent);`), ['IMP-001 Repository structure', 'IMP-002 Publish API']);
  await ev(`document.querySelector('#origin-handoff-confirm').click();`);
  await wait(`!document.querySelector('#origin-handoff-dialog').open && document.querySelector('#origin-main .origin-callout.ok')`, 'handoff done', 15000);
  await saved();
  const view = await app.board.view(), saved1 = view.projects.find(item => item.id === project.id);
  const todo = saved1.pipeline.columns.find(column => column.role === 'todo').id;
  assert.deepEqual(saved1.tasks.map(task => [task.title, task.column]), [['Existing card', todo], ['IMP-001 Repository structure', todo], ['IMP-002 Publish API', todo]]);
  assert.equal(saved1.tasks[0].prompt, existing.prompt);
  assert.match(saved1.tasks[2].prompt, /^Implement IMP-002 Publish API\./);
  assert.match(saved1.tasks[2].prompt, /- POST \/notes works/);
  assert.match(saved1.tasks[2].prompt, /## Depends on\n- IMP-001 Repository structure/);
  assert.match(saved1.tasks[2].prompt, /## Planned tests\n- Integration tests: API integration tests/);
  assert.match(saved1.tasks[2].prompt, /Origin reference: IMP-002 \(origin item [A-Za-z0-9_-]+\)/);
  assert.equal(view.runs.length, 0, 'No agent starts.');
  assert.match(await ev(`return document.querySelector('#origin-main').textContent;`), /In Kanban #3/);
  assert.equal((await blueprintFile(app, project.id)).blueprint.items.filter(item => item.handoff?.taskId).length, 2);

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
  await ev(`document.querySelector('.origin-nav-item[data-section="overview"]').focus();`);
  await wait(`document.activeElement?.dataset.section === 'overview'`, 'sidebar focus');
  await browser.key('ArrowDown', 'ArrowDown', 40);
  await wait(`document.activeElement?.dataset.section === 'vision'`, 'ArrowDown moves to the next section');

  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).version, 12, 'Board state version is unchanged.');
  assert.notEqual(stateBefore, '');
  assert.deepEqual(browser.consoleMessages.filter(message => message.startsWith('EXCEPTION') || /Failed to load|Refused/.test(message)), []);
});

test('Origin contains damaged blueprint files and stale saves without touching board data', { skip: !await findChrome(), timeout: 90000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const project = await app.board.createProject({ name: 'Damaged', workflowMode: 'pipeline' });
  await app.board.createTask({ projectId: project.id, title: 'Board card', prompt: 'Still here.' });
  const dir = join(app.board.store.dir, 'origin');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, originFileName(project.id)), '{"schema":"promptboard.origin", broken');
  const statePath = join(app.board.store.dir, 'state.json'), stateBefore = await readFile(statePath);
  const browser = await launch({ width: 1280, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  const { ev, wait, saved, section } = pageTools(browser);
  await browser.goto(`${app.url}/#/origin`);
  await wait(`document.querySelector('#origin-start')`, 'start screen after damage');
  assert.match(await ev(`return document.querySelector('#origin-notice').textContent;`), /damaged and no good copy was found/);
  await ev(`document.querySelector('#origin-start-empty').click();`);
  await wait(`document.querySelectorAll('.origin-nav-item').length === 15`, 'started with an empty map');
  await saved();
  assert.ok((await readFile(statePath)).equals(stateBefore), 'Board state is untouched by Origin recovery and saves.');

  // Another window saves first: this window refuses to overwrite and offers an explicit choice.
  const token = await ev(`return (await (await fetch('/api/session')).json()).token;`);
  const current = await (await fetch(`${app.url}/api/origin/projects/${project.id}`, { headers: { 'X-STE-Token': token } })).json();
  const other = await fetch(`${app.url}/api/origin/projects/${project.id}`, { method: 'PUT', headers: { 'X-STE-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: current.revision, blueprint: { ...current.blueprint, idea: 'Saved elsewhere' } }) });
  assert.equal(other.status, 200);
  await section('vision');
  await ev(`const t = document.querySelector('#origin-main textarea'); t.value = 'Local edit'; t.dispatchEvent(new Event('input', { bubbles: true }));`);
  await wait(`document.querySelector('#origin-view').dataset.save === 'conflict'`, 'conflict shown', 15000);
  assert.match(await ev(`return document.querySelector('#origin-error').textContent;`), /changed in another window/);
  assert.equal((await blueprintFile(app, project.id)).blueprint.idea, 'Saved elsewhere', 'The newer save was not overwritten.');
  await ev(`[...document.querySelectorAll('#origin-save button')].find(b => b.textContent === 'Reload saved version').click();`);
  await wait(`document.querySelector('#origin-view').dataset.save === 'saved' && document.querySelector('#origin-error').hidden`, 'reloaded saved version');
  assert.equal((await app.board.view()).projects[0].tasks[0].prompt, 'Still here.');
  assert.deepEqual(browser.consoleMessages.filter(message => message.startsWith('EXCEPTION')), []);
});

test('Origin starts the first project, adds another from New project and opens a block with a real click', { skip: !await findChrome(), timeout: 90000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const browser = await launch({ width: 1280, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  const { ev, wait, saved, section, quick } = pageTools(browser);
  await browser.goto(`${app.url}/#/origin`);
  await wait(`document.querySelector('#origin-first-project')`, 'first-project start');
  await ev(`document.querySelector('#origin-start').click();`);
  assert.match(await browser.until(`document.querySelector('#origin-main .origin-inline-error:not([hidden])')?.textContent`, 'name required'), /name/);
  await ev(`document.querySelector('#origin-first-project').value = 'Atlas'; document.querySelector('#origin-idea').value = 'An internal API gateway.'; document.querySelector('#origin-start').click();`);
  await wait(`document.querySelectorAll('.origin-nav-item').length === 15`, 'project and blueprint created', 20000);
  await saved();
  const atlas = (await app.board.view()).projects.find(item => item.name === 'Atlas');
  assert.ok(atlas?.repository, 'The project is created like Kanban → New project.');

  // New project is always one click away.
  await ev(`document.querySelector('#origin-new-project').click();`);
  await wait(`document.querySelector('#origin-new-dialog')?.open && document.activeElement?.id === 'origin-new-name'`, 'new project dialog');
  await ev(`document.querySelector('#origin-new-name').value = 'Beacon'; document.querySelector('#origin-new-idea').value = 'A status page.'; document.querySelector('#origin-new-create').click();`);
  await wait(`!document.querySelector('#origin-new-dialog').open && document.querySelector('.origin-map-center')?.textContent.includes('Beacon')`, 'second project started', 20000);
  await saved();
  const beacon = (await app.board.view()).projects.find(item => item.name === 'Beacon');
  assert.equal((await blueprintFile(app, atlas.id)).blueprint.vision.summary, 'An internal API gateway.');
  assert.equal((await blueprintFile(app, beacon.id)).blueprint.vision.summary, 'A status page.', 'Each project has its own blueprint.');
  await ev(`const s = document.querySelector('#origin-project'); s.value = ${J(atlas.id)}; s.dispatchEvent(new Event('change', { bubbles: true }));`);
  await wait(`document.querySelector('.origin-map-center')?.textContent.includes('Atlas')`, 'switched back');

  await section('architecture');
  await quick('Gateway', 'components');
  await wait(`document.querySelectorAll('.origin-node').length === 1`, 'block drawn');
  const point = await ev(`const r = document.querySelector('.origin-node').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
  await browser.click(point.x, point.y);
  await wait(`document.querySelector('#origin-drawer-title')?.value === 'Gateway'`, 'editor opened by a real click');
  assert.equal((await app.board.view()).runs.length, 0);
  assert.deepEqual(browser.consoleMessages.filter(message => message.startsWith('EXCEPTION')), []);
});
