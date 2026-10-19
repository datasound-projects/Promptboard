// Base end to end in the page: add resources once (an MCP server from a pasted configuration, validated by a real
// connection test; a repository's instruction files and a skill; a Markdown file from a template), compose agents and
// an Agent Profile from the library, switch things off per profile and globally, reuse profiles across projects, give
// a project its own version of a shared file, delete with dependencies detached, reload, and use it on a phone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const chrome = await findChrome();
const J = JSON.stringify;
async function repository(t, files) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pb-base-e2e-'))); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  for (const [path, text] of Object.entries(files)) { await mkdir(join(dir, path, '..'), { recursive: true }); await writeFile(join(dir, path), text); }
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

test('Base: add once, compose agent profiles, switch per assignment and globally, reuse across projects, reload', { skip: !chrome, timeout: 300000 }, async t => {
  const shopRepo = await repository(t, { 'AGENTS.md': '# Agents\nRun npm test before finishing.\n', 'CLAUDE.md': '# Claude\nKeep diffs small.\n', '.claude/skills/review/SKILL.md': '---\nname: review\ndescription: Review a change\n---\nCheck tests and naming.\n' });
  const docsRepo = await repository(t, {});
  const app = await startTestServer(t, { port: 0, executor: null });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = (path, method = 'GET', body) => fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: J(body) } : {}) }).then(async r => ({ status: r.status, json: await r.json() }));
  const shop = await app.board.createProject({ name: 'Shop' }); await app.board.linkRepository(shop.id, { path: shopRepo, expectedRevision: 1 });
  const docs = await app.board.createProject({ name: 'Docs' }); await app.board.linkRepository(docs.id, { path: docsRepo, expectedRevision: 1 });
  const library = async () => (await call('/api/base')).json;
  const named = async name => (await library()).resources.find(item => item.name === name);
  const preview = async projectId => (await call('/api/base/preview', 'POST', { target: { scope: 'project', projectId } })).json.manifest;

  const browser = await launch({ width: 1440, height: 1000 }); assert.ok(browser); t.after(() => browser.close());
  const ev = code => browser.eval(code), wait = (expression, label, ms = 20000) => browser.until(expression, label, ms);
  const category = label => ev(`[...document.querySelectorAll('#base-categories button')].find(b => b.firstElementChild.textContent === ${J(label)}).click();`);
  const more = text => ev(`const m = document.querySelector('#base-actions .base-more'); m.open = true; [...m.querySelectorAll('.origin-menu-item')].find(b => b.textContent === ${J(text)}).click();`);
  const dialogButton = text => ev(`[...document.querySelectorAll('#base-dialog button')].find(b => b.textContent === ${J(text)}).click();`);
  const row = name => `[...document.querySelectorAll('#base-list > li')].find(li => li.querySelector('strong')?.textContent === ${J(name)})`;
  const save = async label => {
    await ev(`document.querySelector('#base-resource-save').click();`);
    await wait(`/Saved/.test(document.querySelector('#base-status').textContent)`, label).catch(async failure => { console.log('FORM ERROR', await ev(`return [...document.querySelectorAll('.base-resource-form .inline-error')].map(n => n.textContent).join(' | ')`)); throw failure; });
    await ev(`document.querySelector('#base-status').textContent = '';`);
  };

  await browser.goto(`${app.url}/#/base`);
  await wait(`document.querySelector('#base-categories button')`, 'Base');
  // Empty state with its contextual action.
  await category('Agent Profiles');
  await wait(`/No agent profiles yet/.test(document.querySelector('#base-empty').textContent)`, 'empty agent profiles');

  // 1. An individual agent from the page; a second one from the API.
  await category('Agents');
  await ev(`[...document.querySelectorAll('#base-actions button')].find(b => b.textContent === 'Create').click();`);
  await wait(`document.querySelector('.base-resource-form[data-kind="profile"]')`, 'agent editor');
  await ev(`document.querySelector('#base-resource-name').value = 'Research Coordinator';`);
  await save('agent saved');
  const coordinator = await named('Research Coordinator');
  const reviewer = (await call('/api/base/resources', 'POST', { kind: 'profile', name: 'Technical Reviewer', configuration: { agent: { provider: 'claude', instructions: 'Review every claim.' }, binding: { mode: 'inherit', include: [], exclude: [] } } })).json.resource;

  // 2. An MCP server from a pasted configuration, then trusted, tested for real, and one tool switched off.
  await more('Import MCP servers…');
  const fixture = fileURLToPath(new URL('./fixtures/base-mcp-server.mjs', import.meta.url));
  await ev(`document.querySelector('#base-dialog textarea').value = ${J(J({ mcpServers: { docs: { command: process.execPath, args: [fixture] } } }))};`);
  await dialogButton('Preview');
  await wait(`document.querySelector('#base-dialog [data-server="docs"]')?.checked === true`, 'importable server');
  await dialogButton('Import selected');
  await wait(`/Imported 1 MCP server/.test(document.querySelector('#base-status').textContent)`, 'imported');
  let mcp = await named('docs');
  assert.deepEqual([mcp.enabled, mcp.trust], [false, 'untrusted'], 'nothing runs until reviewed');
  await category('MCPs');
  await ev(`${row('docs')}.querySelector('.base-resource').click();`);
  await wait(`document.querySelector('.base-resource-form[data-kind="mcp"]')`, 'mcp editor');
  await ev(`const t2 = document.querySelector('#base-resource-trust'); t2.value = 'trusted'; t2.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#base-resource-enabled').checked = true;`);
  await save('trusted');
  await ev(`[...document.querySelectorAll('.base-resource-form button')].find(b => b.textContent === 'Test connection and discover tools').click();`);
  await wait(`document.querySelector('.base-tool-list [data-tool="read_document"]')`, 'tools discovered by a real connection', 30000);
  await ev(`const tool = document.querySelector('.base-tool-list [data-tool="read_document"]'); tool.checked = false; tool.dispatchEvent(new Event('change', { bubbles: true }));`);
  await save('tool switched off');
  await wait(`/Connected · 1 tool, 1 off/.test(${row('docs')}?.textContent || '')`, 'still connected with the tool off').catch(async failure => { console.log('ROW', await ev(`return ${row('docs')}?.textContent`), JSON.stringify((await named('docs')).connectionTest), JSON.stringify((await named('docs')).configuration)); throw failure; });

  // 3. A repository's instruction files and its skill, read without changing the repository.
  await more('Import Markdown from a repository…');
  await ev(`const s = document.querySelector('#base-dialog select'); s.value = ${J(shop.id)}; s.dispatchEvent(new Event('change', { bubbles: true }));`);
  await dialogButton('Find files');
  await wait(`document.querySelectorAll('#base-dialog [data-path]').length === 3`, 'three files found');
  await dialogButton('Import selected');
  await wait(`/Imported 3/.test(document.querySelector('#base-status').textContent)`, 'imported files');
  const agentsFile = await named('AGENTS.md');
  assert.deepEqual([agentsFile.kind, agentsFile.trust, (await named('review')).kind], ['markdown', 'untrusted', 'skill']);
  await call(`/api/base/resources/${agentsFile.id}`, 'PATCH', { trust: 'trusted', enabled: true, expectedRevision: agentsFile.revision });

  // 4. SOUL.md from a template, editable before saving.
  await more('Markdown file from a template…');
  await wait(`[...document.querySelectorAll('#base-dialog .base-template')].length > 5`, 'templates');
  await ev(`[...document.querySelectorAll('#base-dialog .base-template')].find(b => b.textContent.startsWith('SOUL.md')).click();`);
  await wait(`document.querySelector('#base-markdown-body')?.value.startsWith('# SOUL.md')`, 'template in the editor');
  await ev(`const b = document.querySelector('#base-markdown-body'); b.value += '- Prefer primary sources\\n'; b.dispatchEvent(new Event('input', { bubbles: true }));`);
  await wait(`[...document.querySelectorAll('.base-markdown-preview li')].some(li => li.textContent === 'Prefer primary sources')`, 'live preview');
  await save('SOUL.md saved');
  const soul = await named('SOUL.md');

  // 5. A pack of reusable resources.
  await category('Packs');
  await ev(`[...document.querySelectorAll('#base-actions button')].find(b => b.textContent === 'Create').click();`);
  await wait(`document.querySelector('.base-resource-form[data-kind="pack"]')`, 'pack editor');
  await ev(`document.querySelector('#base-resource-name').value = 'Research pack'; for (const id of ${J([soul.id, agentsFile.id])}) document.querySelector('.base-resource-form [data-resource="' + id + '"]').checked = true;`);
  await save('pack saved');
  const pack = await named('Research pack');

  // 6. The agent profile, equipped from the library in a few clicks; the pack is switched off for this profile only.
  await category('Agent Profiles');
  await ev(`[...document.querySelectorAll('#base-actions button')].find(b => b.textContent === 'Create').click();`);
  await wait(`document.querySelector('.base-resource-form[data-kind="agentProfile"]')`, 'profile builder');
  await ev(`document.querySelector('#base-resource-name').value = 'AI Research & Architecture'; const p2 = document.querySelector('#base-profile-primary'); p2.value = ${J(coordinator.id)}; p2.dispatchEvent(new Event('change', { bubbles: true }));`);
  await ev(`[...document.querySelectorAll('.base-resource-form button')].find(b => b.textContent === 'Add supporting agents…').click();`);
  await wait(`document.querySelector('#base-dialog [data-pick=${J(reviewer.id)}]')`, 'agent picker');
  await ev(`document.querySelector('#base-dialog [data-pick=${J(reviewer.id)}]').click();`); await dialogButton('Add selected');
  await wait(`document.querySelector('.base-profile-agents input[aria-label^="Responsibility"]')`, 'supporting agent');
  await ev(`const d = document.querySelector('.base-profile-agents input[aria-label^="Responsibility"]'); d.value = 'Checks every claim'; d.dispatchEvent(new Event('input', { bubbles: true }));`);
  await ev(`[...document.querySelectorAll('.base-resource-form button')].find(b => b.textContent === 'Add from Base…').click();`);
  await wait(`document.querySelector('#base-dialog [data-pick=${J(mcp.id)}]')`, 'library picker');
  await ev(`const s = document.querySelector('#base-dialog input[type="search"]'); s.value = 'docs'; s.dispatchEvent(new Event('input', { bubbles: true }));`);
  await wait(`document.querySelectorAll('#base-dialog [data-pick]').length === 1`, 'search narrows the library');
  await ev(`document.querySelector('#base-dialog [data-pick=${J(mcp.id)}]').click(); const s = document.querySelector('#base-dialog input[type="search"]'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true }));`);
  await ev(`for (const id of ${J([pack.id, soul.id])}) document.querySelector('#base-dialog [data-pick="' + id + '"]').click();`);
  await dialogButton('Add selected');
  await wait(`document.querySelectorAll('.base-profile-resources .base-profile-row').length === 3`, 'three resources equipped');
  await ev(`const r = [...document.querySelectorAll('.base-profile-resources .base-profile-row')].find(x => x.querySelector('strong').textContent === 'Research pack'); const s = r.querySelector('input[role="switch"]'); s.checked = false; s.dispatchEvent(new Event('change', { bubbles: true }));`);
  await wait(`/Runs as Research Coordinator/.test(document.querySelector('.base-inventory').textContent)`, 'inventory');
  await save('profile saved');
  const research = await named('AI Research & Architecture');
  assert.deepEqual(research.configuration.agents.map(agent => [agent.role, agent.responsibility]), [['primary', ''], ['supporting', 'Checks every claim']]);
  assert.equal(research.configuration.resources.find(ref => ref.resourceId === pack.id).enabled, false);

  // 7. A second profile sharing the same server and pack (references, not copies).
  const writing = (await call('/api/base/resources', 'POST', { kind: 'agentProfile', name: 'Writing team', configuration: { agents: [{ resourceId: reviewer.id, role: 'primary' }], resources: [{ resourceId: mcp.id, required: true }, { resourceId: pack.id, required: true }], instructions: '' } })).json.resource;
  assert.equal((await library()).resources.filter(item => item.kind === 'mcp').length, 1, 'one server, used twice');

  // 8. Reuse: profile one on Shop from the page, profile two on Docs.
  await ev(`const m = ${row('AI Research & Architecture')}.querySelector('.base-row-menu'); m.open = true; [...m.querySelectorAll('.origin-menu-item')].find(b => b.textContent === 'Apply to…').click();`);
  await wait(`[...document.querySelectorAll('#base-dialog [data-target-key]')].some(i => i.dataset.targetKey === ${J(`project:${shop.id}::`)})`, 'targets');
  await ev(`document.querySelector('#base-dialog [data-target-key=${J(`project:${shop.id}::`)}]').click();`);
  await wait(`!document.querySelector('#base-dialog button[type="submit"]').disabled`, 'previewed');
  await ev(`document.querySelector('#base-dialog button[type="submit"]').click();`);
  await wait(`!document.querySelector('#base-dialog').open`, 'applied');
  const docsTarget = (await library()).targets.find(entry => entry.target.scope === 'project' && entry.target.projectId === docs.id);
  await call('/api/base/apply', 'POST', { expectedBaseRevision: (await library()).revision, changes: [{ target: docsTarget.target, binding: { mode: 'inherit', include: [], exclude: [] }, profileId: writing.id, expectedRevision: docsTarget.revision }] });
  let shopRun = await preview(shop.id), docsRun = await preview(docs.id);
  const entry = (manifest, id) => manifest.resources.find(item => item.resourceId === id);
  assert.deepEqual(shopRun.errors, []);
  assert.deepEqual(entry(shopRun, mcp.id).disabledTools, ['read_document'], 'the tool switched off on the server is withheld');
  assert.equal(entry(shopRun, pack.id), undefined, 'the pack is off in this profile');
  assert.equal(entry(shopRun, reviewer.id).responsibility, 'Checks every claim');
  assert.equal(entry(docsRun, pack.id).status, 'ready', 'the same pack stays on in the other profile');

  // 9. Switched off globally from its row: every assignment leaves it out (it is required in profile one, so runs stop).
  await category('Custom MD Files');
  await ev(`const s = ${row('SOUL.md')}.querySelector('.base-switch'); s.checked = false; s.dispatchEvent(new Event('change', { bubbles: true }));`);
  await wait(`/SOUL.md switched off/.test(document.querySelector('#base-status').textContent)`, 'switched off');
  assert.match((await preview(shop.id)).errors.map(item => item.message).join(' '), /disabled/);
  await ev(`const s = ${row('SOUL.md')}.querySelector('.base-switch'); s.checked = true; s.dispatchEvent(new Event('change', { bubbles: true }));`);
  await wait(`/SOUL.md switched on/.test(document.querySelector('#base-status').textContent)`, 'switched on');
  assert.deepEqual((await preview(shop.id)).errors, []);

  // 10. Docs gets its own version of AGENTS.md; Shop keeps the shared one.
  await call(`/api/base/resources/${writing.id}`, 'PATCH', { configuration: { ...writing.configuration, resources: [...writing.configuration.resources, { resourceId: agentsFile.id, required: true }] }, expectedRevision: writing.revision });
  await ev(`const m = ${row('AGENTS.md')}.querySelector('.base-row-menu'); m.open = true; [...m.querySelectorAll('.origin-menu-item')].find(b => b.textContent === 'Project version…').click();`);
  await wait(`document.querySelector('#base-dialog select')`, 'project version dialog');
  await ev(`const s = document.querySelector('#base-dialog select'); s.value = ${J(docs.id)}; s.dispatchEvent(new Event('change', { bubbles: true }));`);
  await dialogButton('Create project version');
  await wait(`document.querySelector('#base-markdown-body') && /Docs’s version/.test(document.querySelector('.base-resource-form').textContent)`, 'project version open');
  await ev(`const b = document.querySelector('#base-markdown-body'); b.value = '# Agents for docs\\nWrite in plain English.\\n'; b.dispatchEvent(new Event('input', { bubbles: true }));`);
  await save('project version saved');
  docsRun = await preview(docs.id);
  const version = docsRun.resources.find(item => item.overrides === agentsFile.id);
  assert.ok(version && version.status === 'ready', 'the project version replaces the shared file in Docs');
  assert.equal((await call(`/api/base/resources/${agentsFile.id}`)).json.resource.content.body, '# Agents\nRun npm test before finishing.\n', 'the shared file is unchanged');

  // 11. Deleting a shared resource that others use: Used by is shown, and detaching removes the references.
  await category('Custom MD Files');
  await ev(`const m = ${row('CLAUDE.md')}.querySelector('.base-row-menu'); m.open = true; [...m.querySelectorAll('.origin-menu-item')].find(b => b.textContent === 'Delete…').click();`);
  await wait(`document.querySelector('#base-dialog')?.open`, 'delete dialog');
  await dialogButton('Delete resource');
  await wait(`!document.querySelector('#base-dialog').open`, 'deleted');
  await category('Custom MD Files');
  await ev(`const m = ${row('SOUL.md')}.querySelector('.base-row-menu'); m.open = true; [...m.querySelectorAll('.origin-menu-item')].find(b => b.textContent === 'Delete…').click();`);
  await wait(`/Used by/.test(document.querySelector('#base-dialog').textContent) && /Research pack/.test(document.querySelector('#base-dialog').textContent)`, 'used by is shown');
  await ev(`document.querySelector('#base-dialog input[type="checkbox"]').click();`); await dialogButton('Detach and delete');
  await wait(`!document.querySelector('#base-dialog').open`, 'detached and deleted');
  assert.equal((await named('Research pack')).configuration.resources.some(ref => ref.resourceId === soul.id), false);
  assert.equal((await named('AI Research & Architecture')).configuration.resources.some(ref => ref.resourceId === soul.id), false);

  // 12. Reload: everything is still there, per category.
  await browser.reload();
  await wait(`document.querySelector('#base-categories [data-kind="markdown"] .base-category-count')?.textContent === '2'`, 'reloaded');
  const counts = await ev(`return Object.fromEntries([...document.querySelectorAll('#base-categories button')].map(b => [b.dataset.kind, b.querySelector('.base-category-count').textContent]));`);
  assert.deepEqual([counts.agent, counts.agentProfile, counts.mcp, counts.skill, counts.pack, counts.markdown], ['2', '2', '1', '1', '1', '2']);

  // 13. On a phone: categories as a strip, rows readable, nothing scrolls sideways.
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await wait(`document.querySelector('#base-mobile-categories #base-categories')`, 'mobile categories');
  assert.equal(await ev(`return document.documentElement.scrollWidth <= innerWidth;`), true);
  assert.deepEqual(browser.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);
});
