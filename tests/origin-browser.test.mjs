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
  return {
    ev, wait, saved,
    section: async id => {
      const label = await ev(`const item = document.querySelector('.origin-nav-item[data-section=${J(id)}]'); item.click(); return item.querySelector('.origin-nav-label').textContent;`);
      await wait(`document.querySelector('#origin-section-heading')?.textContent === ${J(label)}`, `section ${id}`);
    },
    click: async (text, scope = '#origin-view') => assert.equal(await ev(`const b = [...document.querySelector(${J(scope)}).querySelectorAll('button')].find(b => b.textContent.trim() === ${J(text)}); if (!b) return false; b.click(); return true;`), true, `button ${text}`),
    open: async text => assert.equal(await ev(`const b = [...document.querySelectorAll('#origin-main .origin-row-open')].find(b => b.textContent.includes(${J(text)})); if (!b) return false; b.click(); return true;`), true, `row ${text}`),
    set: async (label, value) => assert.equal(await ev(`const l = [...document.querySelectorAll('#origin-main .origin-editor .origin-field')].find(l => l.firstChild.textContent === ${J(label)}); if (!l) return false; const c = l.querySelector('input, textarea, select'); c.value = ${J(value)}; c.dispatchEvent(new Event(c.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); return true;`), true, `field ${label}`),
    link: async (label, name) => assert.equal(await ev(`const l = [...document.querySelectorAll('#origin-main .origin-editor .origin-field')].find(l => l.firstChild.textContent === ${J(label)}); const row = l && [...l.querySelectorAll('.check-row')].find(r => r.textContent.includes(${J(name)})); if (!row) return false; const box = row.querySelector('input'); box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); return true;`), true, `link ${label} → ${name}`),
    node: async (name, key) => ev(`[...document.querySelectorAll('.origin-node')].find(n => n.textContent.includes(${J(name)})).dispatchEvent(new KeyboardEvent('keydown', { key: ${J(key)}, bubbles: true }));`),
  };
}
async function blueprintFile(app, projectId) { return JSON.parse(await readFile(join(app.board.store.dir, 'origin', originFileName(projectId)), 'utf8')); }

test('Origin in real Chrome: structured blueprint, diagram, evidence, readiness, persistence and explicit handoffs', { skip: !await findChrome(), timeout: 180000 }, async t => {
  const generated = [];
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [{ id: 'codex', available: true }], runner: async request => { generated.push(request); throw new Error('No model call is allowed.'); } });
  const project = await app.board.createProject({ name: 'ReMa', workflowMode: 'pipeline' });
  const existing = await app.board.createTask({ projectId: project.id, title: 'Existing card', prompt: 'Keep me intact.' });
  const statePath = join(app.board.store.dir, 'state.json');
  const browser = await launch({ width: 1280, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  const page = pageTools(browser), { ev, wait, saved, section, click, open, set, link, node } = page;

  await browser.goto(`${app.url}/#/origin`);
  await wait(`document.querySelector('#origin-start')`, 'empty state');
  assert.equal(await ev(`return [...document.querySelectorAll('.page-nav a')].map(a => a.textContent).join(' | ');`), 'Origin | Compose | Kanban | Base');
  assert.equal(await ev(`return document.querySelector('.page-nav [aria-current="page"]').getAttribute('href');`), '#/origin');
  assert.equal(await ev(`return document.title;`), 'Origin · Promptboard');
  assert.equal(await ev(`return document.querySelector('#origin-main h2').textContent;`), 'Start with the project, not the prompt.');
  assert.equal(await ev(`return /Ask AI/i.test(document.querySelector('#origin-view').textContent);`), false);
  const stateBefore = await readFile(statePath, 'utf8');

  // Untrusted text stays text.
  const hostile = '<img src=x onerror="window.__pwned=1">Release hub';
  await ev(`document.querySelector('#origin-idea').value = ${J(hostile)}; document.querySelector('#origin-start').click();`);
  await wait(`document.querySelectorAll('.origin-nav-item').length === 15`, 'navigator');
  await saved();
  assert.equal(await ev(`return document.querySelector('#origin-section-heading').textContent;`), 'Vision & Scope');
  assert.equal(await ev(`return document.querySelector('#origin-main textarea').value;`), hostile);
  assert.equal(await ev(`return window.__pwned === undefined && !document.querySelector('#origin-view img');`), true);

  // Requirements: create, edit, delete.
  await section('requirements');
  await click('＋ Requirement'); await set('Title', 'Publish release notes'); await set('Acceptance criteria', 'A maintainer can publish\nReaders see it'); await set('Status', 'defined'); await click('Close', '#origin-main');
  await click('＋ Requirement'); await set('Title', 'Temporary requirement'); await click('Close', '#origin-main');
  await open('Temporary requirement'); await click('Delete', '#origin-main'); await click('Confirm delete', '#origin-main');
  assert.deepEqual(await ev(`return [...document.querySelectorAll('#origin-main .origin-row .origin-key')].map(n => n.textContent);`), ['REQ-001']);

  // Architecture: components, keyboard connect mode, relationship editor and a component delete.
  await section('architecture');
  for (const [name, type] of [['Web Client', 'client'], ['API', 'api'], ['Scratch', 'service']]) { await click('＋ Component'); await set('Name', name); await set('Type', type); await set('Purpose', `${name} purpose`); await set('Status', 'defined'); await click('Close', '#origin-main'); }
  await click('Connect'); await node('Web Client', ' '); await node('API', ' ');
  await wait(`document.querySelectorAll('.origin-edge').length === 1`, 'edge drawn');
  await set('Protocol / interface', 'HTTPS'); await click('Close', '#origin-main');
  await click('Connect'); await node('API', ' '); await node('Scratch', ' '); await click('Close', '#origin-main');
  await wait(`document.querySelectorAll('.origin-edge').length === 2`, 'second edge');
  await requirementsLink();
  async function requirementsLink() { await section('requirements'); await open('Publish release notes'); await link('Related components', 'API'); await link('Related components', 'Scratch'); await click('Close', '#origin-main'); await section('architecture'); }
  await open('Scratch'); await click('Delete', '#origin-main');
  assert.match(await ev(`return document.querySelector('#origin-main .origin-delete').textContent;`), /Delete and remove 2 links/);
  await click('Delete and remove 2 links', '#origin-main');
  await wait(`document.querySelectorAll('.origin-node').length === 2 && document.querySelectorAll('.origin-edge').length === 1`, 'component and its connection removed');
  assert.match(await ev(`return document.querySelector('.origin-edge-label').textContent;`), /calls · HTTPS/);
  await node('API', 'Enter');
  await wait(`document.querySelector('#origin-main .origin-editor')`, 'component editor from the diagram');
  assert.match(await ev(`return document.querySelector('#origin-main .origin-editor').textContent;`), /Used by: Web Client \(calls\)/);
  await click('Close', '#origin-main');

  // Technology with evidence: verification follows the linked source, not the URL.
  await section('technology'); await click('＋ Technology'); await set('Name', 'Node.js'); await set('Version', '22'); await set('Status', 'selected'); await click('Close', '#origin-main');
  assert.match(await ev(`return document.querySelector('#origin-main .origin-row').textContent;`), /Unverified/);
  await section('research'); await click('＋ Source'); await set('Title', 'Node.js releases');
  await set('URL', 'javascript:alert(1)');
  assert.equal(await ev(`return document.querySelector('#origin-main input[type="url"]').getAttribute('aria-invalid');`), 'true');
  assert.equal(await ev(`return document.querySelector('.origin-open-link').hidden;`), true);
  await set('URL', 'https://nodejs.org/en/about/previous-releases');
  assert.equal(await ev(`const a = document.querySelector('.origin-open-link'); return [a.hidden, a.rel, a.target, a.href].join(' ');`), 'false noopener noreferrer _blank https://nodejs.org/en/about/previous-releases');
  await click('Close', '#origin-main');
  await section('technology'); await open('Node.js'); await link('Evidence (sources)', 'Node.js releases'); await click('Close', '#origin-main');
  assert.match(await ev(`return document.querySelector('#origin-main .origin-row').textContent;`), /Unverified/, 'An unchecked source does not verify.');
  await section('research'); await open('Node.js releases'); await set('Verification', 'verified'); await click('Close', '#origin-main');
  await section('technology'); assert.match(await ev(`return document.querySelector('#origin-main .origin-row').textContent;`), /Verified/);
  await section('architecture'); await open('API'); await link('Technologies', 'Node.js'); await click('Close', '#origin-main');

  // Assumption → decision, then accept the decision.
  await section('research'); await click('＋ Assumption'); await set('Assumption', 'Fewer than 5,000 concurrent users'); await set('Impact if false', 'Scaling changes');
  await click('Convert to decision');
  await wait(`document.querySelector('#origin-section-heading').textContent === 'Decisions'`, 'decision opened');
  await set('Decision', 'Single region'); await set('Reason', 'Modest load'); await set('Status', 'accepted'); await click('Close', '#origin-main');
  assert.match(await ev(`return document.querySelector('#origin-main .origin-row').textContent;`), /ADR-001.*Accepted/);

  // Plan with ordering, then readiness and the status bar.
  await section('plan');
  await click('＋ Milestone'); await set('Title', 'Foundation'); await set('Definition of done', 'CI passes'); await click('Close', '#origin-main');
  await click('＋ Item'); await set('Title', 'Repository structure'); await click('Close', '#origin-main');
  await click('＋ Item'); await set('Title', 'Publish API'); await set('Acceptance criteria', 'POST /notes works');
  await link('Depends on', 'Repository structure'); await link('Requirements', 'Publish release notes'); await link('Components', 'API'); await click('Close', '#origin-main');
  await section('testing'); await click('＋ Item'); await set('Title', 'API integration tests'); await set('Status', 'defined'); await link('Requirements covered', 'Publish release notes'); await click('Close', '#origin-main');
  await section('overview');
  assert.equal(await ev(`return document.querySelector('#origin-readiness').textContent;`), 'Ready for implementation');
  assert.deepEqual(await ev(`return Object.fromEntries([...document.querySelectorAll('.origin-counts dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent]));`), {
    Requirements: '1 / 1 defined', Components: '2 / 2 described', Technologies: '1 / 1 verified', Dependencies: '0 / 0 verified', Decisions: '0 unresolved',
    Assumptions: '0 open', Sources: '0 not verified', Testing: '1 area defined', Implementation: '2 items · 0 sent to Kanban' });
  await saved();
  const file = await blueprintFile(app, project.id);
  assert.equal(file.blueprint.components.length, 2); assert.equal(file.blueprint.connections.length, 1);
  assert.deepEqual(file.blueprint.requirements[0].componentIds, [file.blueprint.components.find(item => item.name === 'API').id], 'The deleted component link was removed.');

  // Reload keeps the blueprint and the selected section.
  await browser.reload();
  await wait(`document.querySelectorAll('.origin-nav-item').length === 15 && document.querySelector('#origin-section-heading')?.textContent === 'Overview'`, 'reloaded');
  assert.equal(await ev(`return document.querySelector('#origin-readiness').textContent;`), 'Ready for implementation');

  // Kanban handoff: explicit, ordered, To Do, no run.
  await section('plan'); await click('Select items not sent');
  await ev(`document.querySelector('#origin-kanban-handoff').click();`);
  await wait(`document.querySelector('#origin-handoff-dialog')?.open`, 'handoff dialog');
  assert.deepEqual(await ev(`return [...document.querySelectorAll('#origin-handoff-dialog li')].map(li => li.textContent);`), ['IMP-001 Repository structure', 'IMP-002 Publish API']);
  await ev(`document.querySelector('#origin-handoff-confirm').click();`);
  await wait(`!document.querySelector('#origin-handoff-dialog').open && document.querySelector('.origin-handoff-result')`, 'handoff done', 15000);
  await saved();
  const view = await app.board.view(), saved1 = view.projects.find(item => item.id === project.id);
  const todo = saved1.pipeline.columns.find(column => column.role === 'todo').id;
  assert.deepEqual(saved1.tasks.map(task => [task.title, task.column]), [['Existing card', todo], ['IMP-001 Repository structure', todo], ['IMP-002 Publish API', todo]]);
  assert.equal(saved1.tasks[0].prompt, existing.prompt);
  assert.match(saved1.tasks[2].prompt, /^Implement IMP-002 Publish API\./);
  assert.match(saved1.tasks[2].prompt, /- POST \/notes works/);
  assert.match(saved1.tasks[2].prompt, /## Depends on\n- IMP-001 Repository structure/);
  assert.match(saved1.tasks[2].prompt, /Origin reference: IMP-002 \(origin item [A-Za-z0-9_-]+\)/);
  assert.equal(view.runs.length, 0, 'No agent starts.');
  assert.match(await ev(`return document.querySelector('#origin-main').textContent;`), /In Kanban #3/);
  assert.equal((await blueprintFile(app, project.id)).blueprint.items.filter(item => item.handoff?.taskId).length, 2);

  // Compose handoff: targeted prefill only; nothing is generated.
  await section('requirements'); await open('Publish release notes');
  await ev(`document.querySelector('#origin-main .origin-compose').click();`);
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
  await wait(`!document.querySelector('#origin-view').hidden && document.querySelector('#origin-main .origin-compose')`, 'back in Origin');
  await ev(`document.querySelector('#origin-main .origin-compose').click();`);
  await wait(`!document.querySelector('#origin-error').hidden`, 'draft protection');
  assert.equal(await ev(`return location.hash;`), '#/origin');
  assert.equal(generated.length, 0, 'No model call was made.');

  // Layout and themes: no horizontal overflow; inspector is a column on desktop and a drawer on phones.
  await section('architecture');
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    await browser.resize(width, 900);
    await ev(`document.documentElement.dataset.theme = ${J(theme)};`);
    assert.equal(await browser.layout(`return document.documentElement.scrollWidth <= innerWidth && getComputedStyle(document.querySelector('#origin-inspector')).visibility === ${J(width > 1100 ? 'visible' : 'hidden')} && document.querySelector('.origin-canvas').getBoundingClientRect().width > 0;`), true, `Origin fits ${width}px in ${theme}`);
    for (const hash of ['#/', '#/kanban', '#/base']) {
      await ev(`location.hash = ${J(hash)};`);
      assert.equal(await browser.layout(`return document.documentElement.scrollWidth <= innerWidth;`), true, `${hash} fits ${width}px with four pages`);
    }
    await ev(`location.hash = '#/origin';`); await wait(`!document.querySelector('#origin-view').hidden`, 'Origin again');
  }
  await ev(`document.querySelector('#origin-inspector-toggle').click();`);
  assert.equal(await browser.layout(`return getComputedStyle(document.querySelector('#origin-inspector')).visibility;`, 'visible'), 'visible');
  await ev(`document.querySelector('#origin-inspector').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
  assert.equal(await browser.layout(`return getComputedStyle(document.querySelector('#origin-inspector')).visibility;`, 'hidden'), 'hidden');
  await browser.resize(1280, 900);
  // Keyboard section navigation inside the navigator.
  await ev(`document.querySelector('.origin-nav-item[data-section="overview"]').focus();`);
  await browser.key('ArrowDown', 'ArrowDown', 40);
  assert.equal(await ev(`return document.activeElement.dataset.section;`), 'vision');

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
  const { ev, wait, saved } = pageTools(browser);
  await browser.goto(`${app.url}/#/origin`);
  await wait(`document.querySelector('#origin-start')`, 'empty state after damage');
  assert.match(await ev(`return document.querySelector('#origin-notice').textContent;`), /damaged and no good copy was found/);
  await ev(`document.querySelector('#origin-start').click();`);
  await wait(`document.querySelectorAll('.origin-nav-item').length === 15`, 'started');
  await saved();
  assert.ok((await readFile(statePath)).equals(stateBefore), 'Board state is untouched by Origin recovery and saves.');

  // Another window saves first: this window refuses to overwrite and offers an explicit choice.
  const token = await ev(`return (await (await fetch('/api/session')).json()).token;`);
  const current = await (await fetch(`${app.url}/api/origin/projects/${project.id}`, { headers: { 'X-STE-Token': token } })).json();
  const other = await fetch(`${app.url}/api/origin/projects/${project.id}`, { method: 'PUT', headers: { 'X-STE-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: current.revision, blueprint: { ...current.blueprint, idea: 'Saved elsewhere' } }) });
  assert.equal(other.status, 200);
  await ev(`const t = document.querySelector('#origin-main textarea'); t.value = 'Local edit'; t.dispatchEvent(new Event('input', { bubbles: true }));`);
  await wait(`document.querySelector('#origin-view').dataset.save === 'conflict'`, 'conflict shown', 15000);
  assert.match(await ev(`return document.querySelector('#origin-error').textContent;`), /changed in another window/);
  assert.equal((await blueprintFile(app, project.id)).blueprint.idea, 'Saved elsewhere', 'The newer save was not overwritten.');
  await ev(`[...document.querySelectorAll('#origin-save button')].find(b => b.textContent === 'Reload saved version').click();`);
  await wait(`document.querySelector('#origin-view').dataset.save === 'saved' && document.querySelector('#origin-error').hidden`, 'reloaded saved version');
  assert.equal((await app.board.view()).projects[0].tasks[0].prompt, 'Still here.');
  assert.deepEqual(browser.consoleMessages.filter(message => message.startsWith('EXCEPTION')), []);
});

test('Origin creates its first project, imports an exported blueprint and opens a diagram node by double-click', { skip: !await findChrome(), timeout: 90000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const browser = await launch({ width: 1280, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  const { ev, wait, saved, section } = pageTools(browser);
  await browser.goto(`${app.url}/#/origin`);
  await wait(`document.querySelector('#origin-new-project')`, 'first-project form');
  assert.equal(await ev(`return [...document.querySelectorAll('#origin-main button')].some(b => b.textContent === 'Import project context');`), false, 'Import needs a project first.');
  await ev(`document.querySelector('#origin-new-project').value = 'Atlas'; document.querySelector('#origin-idea').value = 'An internal API gateway.'; [...document.querySelectorAll('#origin-main button')].find(b => b.textContent === 'Start project blueprint').click();`);
  await wait(`document.querySelectorAll('.origin-nav-item').length === 15`, 'project and blueprint created', 20000);
  await saved();
  const project = (await app.board.view()).projects.find(item => item.name === 'Atlas');
  assert.ok(project?.repository, 'The project is created like Kanban → New project.');

  const exported = { schema: 'promptboard.origin', version: 1, kind: 'export', blueprint: { vision: { summary: '<b>Imported</b>' },
    components: [{ id: 'gw', name: 'Gateway', purpose: 'Routes' }, { id: 'st', name: 'Store', purpose: 'Keeps' }],
    connections: [{ id: 'k1', from: 'gw', to: 'st', label: 'reads' }, { id: 'k2', from: 'gw', to: 'deleted' }], requirements: [{ id: 'r1', title: 'Imported requirement' }] } };
  const file = join(app.board.store.dir, 'export.json');
  await writeFile(file, JSON.stringify(exported));
  const { root } = await browser.send('DOM.getDocument');
  const { nodeId } = await browser.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#origin-import-file' });
  await browser.send('DOM.setFileInputFiles', { nodeId, files: [file] });
  await wait(`[...document.querySelectorAll('#origin-notice button')].some(b => b.textContent === 'Replace blueprint')`, 'inline import confirmation');
  await ev(`[...document.querySelectorAll('#origin-notice button')].find(b => b.textContent === 'Replace blueprint').click();`);
  await wait(`document.querySelector('#origin-notice').textContent.startsWith('Blueprint imported')`, 'imported');
  assert.match(await ev(`return document.querySelector('#origin-notice').textContent;`), /invalid entries or broken links were removed/);
  const stored = await blueprintFile(app, project.id);
  assert.deepEqual(stored.blueprint.connections.map(item => item.id), ['k1']);
  assert.equal(stored.blueprint.requirements[0].key, 'REQ-001');

  await section('architecture');
  for (let i = 0; i < 2; i++) {
    const point = await ev(`const r = [...document.querySelectorAll('.origin-node')].find(n => n.textContent.includes('Store')).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
    await browser.click(point.x, point.y);
  }
  await wait(`document.querySelector('#origin-main .origin-editor input')?.value === 'Store'`, 'editor opened by double-click');
  assert.equal((await app.board.view()).runs.length, 0);
  assert.deepEqual(browser.consoleMessages.filter(message => message.startsWith('EXCEPTION')), []);
});
