#!/usr/bin/env node
/** Four dark-mode README demos, each <=12s. Requires Chrome and ffmpeg.
 * Model responses and coding CLIs are simulated; UI, persistence, Git worktrees,
 * review/test gates and resource delivery use the real app in disposable folders.
 * Run: node scripts/record-demo.mjs
 * Optional: PB_DEMO_PREVIEW_DIR=/absolute/path keeps storyboard stills for review.
 */
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../tests/helpers/browser.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const work = await mkdtemp(join(tmpdir(), 'pb-demo-'));
const preview = process.env.PB_DEMO_PREVIEW_DIR;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const IDEA = 'An online shop where customers sign in, browse products and check out. Two developers, launch in three months.';
const REQUEST = 'Add login to the shop. Use `src/auth.ts`. Limit attempts to 5 per minute. No new dependencies.';
const PROMPT = '# Goal\nAdd login to the shop.\n\n# Work\n1. Use `src/auth.ts` for the login route.\n2. Limit attempts to 5 per minute.\n3. Write tests and API docs.\n\n# Constraints\nDo not add dependencies.\n\n# Acceptance checks\nA correct login returns a session. The sixth attempt is refused.';
const TASKS = [
  { title: 'Add the login route', prompt: 'Add login to the shop using `src/auth.ts`. Do not add dependencies. A correct login returns a session. Keep the existing API response format.' },
  { title: 'Rate-limit login attempts', prompt: 'Limit attempts to 5 per minute. Test that the sixth attempt is refused. Do not add dependencies.' },
  { title: 'Write the login API docs', prompt: 'Document the login route, its session response, and the limit of 5 attempts per minute.' },
];
let app, browser;
const storyboards = {};
let frames, sceneName;
async function shot(seconds, label) {
  await browser.layout('return document.documentElement.dataset.theme === "dark";');
  await pause(250);
  const file = join(work, `${sceneName}-${String(frames.length).padStart(3, '0')}.png`);
  await writeFile(file, await browser.screenshot()); frames.push({ file, seconds, label });
}
async function click(selector) {
  await browser.eval(`const node = document.querySelector(${JSON.stringify(selector)}); if (!node || node.disabled) throw new Error('Control unavailable: ' + ${JSON.stringify(selector)}); node.focus(); node.click();`);
}
async function clickText(text, scope = 'document') {
  await browser.eval(`const node = [...${scope}.querySelectorAll('button')].find(node => node.textContent === ${JSON.stringify(text)}); if (!node || node.disabled) throw new Error('Button unavailable: ' + ${JSON.stringify(text)}); node.focus(); node.click();`);
}
async function encode(name, scene) {
  sceneName = name; frames = []; await scene();
  const total = frames.reduce((sum, frame) => sum + frame.seconds, 0);
  if (total > 12 || total < 8) throw new Error(`${name}: invalid storyboard duration ${total}`);
  const fileList = join(work, `${name}.txt`);
  await writeFile(fileList, frames.map(frame => `file '${frame.file}'\nduration ${frame.seconds.toFixed(3)}`).join('\n') + `\nfile '${frames.at(-1).file}'\n`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', fileList, '-t', total.toFixed(2), '-vf', 'fps=10,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', '-loop', '0', join(root, 'docs', `${name}.gif`)]);
  storyboards[name] = frames.map(({ seconds, label }) => ({ seconds, label }));
  if (preview) { await mkdir(preview, { recursive: true }); for (const [index, frame] of frames.entries()) await copyFile(frame.file, join(preview, `${name}-${String(index).padStart(2, '0')}.png`)); }
  console.log(`${name}: ${total.toFixed(1)}s, ${frames.length} storyboard stills, dark mode`);
}
try {
  const bin = join(work, 'bin'); await mkdir(bin);
  // Keep lifecycle hooks unchanged, while making simulated terminal output readable.
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\nconst write = process.stdout.write.bind(process.stdout); process.stdout.write = (text, ...args) => write(typeof text === 'string' ? text.replace(/fake claude started in [^\\r\\n]+/, 'Simulated Claude Code session').replace(/working on \\d+ characters/, 'Inspecting task and selected Base context...') : text, ...args); if (!process.argv.at(-1).startsWith('Start implementing')) process.env.FAKE_AGENT_WRITE = '0'; require(${JSON.stringify(join(root, 'tests/fixtures/fake-agent.cjs'))});\n`);
  await chmod(join(bin, 'claude'), 0o755);
  Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, FAKE_AGENT_WRITE: '1', GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.invalid', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.invalid' });
  const { startServer } = await import('../src/server.mjs');
  app = await startServer({ port: 0, dataDir: join(work, 'data'), projectsDir: join(work, 'projects'),
    runner: async ({ prompt }) => {
      const splitting = prompt.startsWith('# Task split');
      if (splitting && !JSON.parse(prompt.split('\n').at(-1)).prompt.endsWith('\n\nKeep the existing API response format.')) throw new Error('Saved edits did not reach Task Split.');
      await pause(500); return { text: splitting ? JSON.stringify({ tasks: TASKS }) : PROMPT, reportedModels: ['demo-model'] };
    },
    detector: async () => [{ id: 'claude', name: 'Claude Code', available: true, version: 'simulated demo' }],
    catalogReader: async provider => ({ provider, source: 'cli', defaultModel: 'demo-model', note: 'Simulated demo model.', models: [{ id: 'demo-model', name: 'Demo model', efforts: ['low', 'high'] }] }),
    authAdapter: { installed: async () => true, status: async () => ({ state: 'signed-in', method: 'demo' }) },
    usageReader: { get: async () => ({ updatedAt: Date.now(), providers: [] }) },
  });
  // The Autopilot scene runs a stage board, which the project API still creates on explicit request.
  await app.board.createProjectWithRepository({ name: 'Shop app', folder: 'new', workflowMode: 'legacy' });
  browser = await launch({ width: 1280, height: 820 }); if (!browser) throw new Error('Chrome was not found.');
  await browser.resize(1280, 820); await browser.goto(app.url);
  await browser.eval(`localStorage.setItem('ste-prompt-engineer.theme', 'dark'); localStorage.setItem('promptboard.settings.dock-start', 'collapsed'); localStorage.setItem('promptboard.dock.height', '200'); localStorage.setItem('promptboard.settings.open-terminal', '0'); localStorage.setItem('promptboard.project-panel', 'collapsed');`);
  await browser.reload();
  await browser.until(`!document.querySelector('#generate-button').disabled`, 'Compose ready', 20000);
  await click('input[name="quality"][value="fast"]');
  await browser.eval(`setSettingsCollapsed(true); document.querySelector('#prompt-input').focus(); window.scrollTo(0,0);`);
  await encode('compose-demo', async () => {
    await shot(0.6, 'Start with an idea');
    const words = REQUEST.split(' ');
    for (const progress of [6, 13, words.length]) {
      await browser.eval(`const input = document.querySelector('#prompt-input'); input.value = ${JSON.stringify(words.slice(0, progress).join(' '))}; input.dispatchEvent(new Event('input', { bubbles: true }));`);
      await shot(0.5, 'Describe the task');
    }
    await click('#settings-toggle');
    await browser.eval(`document.querySelector('#compose-general').open = true; const task = document.querySelector('#task'); task.value = 'feature'; task.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('.compose-settings-card').scrollIntoView({block:'start'});`);
    await shot(1.6, 'Choose Add a feature, CLI, model and output settings');
    await click('#settings-toggle');
    await browser.eval(`document.querySelector('#generate-button').scrollIntoView({block:'center'});`);
    await click('#generate-button'); await shot(0.5, 'Generate a structured prompt');
    await browser.until(`document.querySelector('#prompt-output').textContent.includes('Acceptance checks') && !document.querySelector('#split-button').disabled`, 'generated prompt', 20000);
    await browser.eval(`document.querySelector('#output-card').scrollIntoView({block:'start'});`); await shot(1.8, 'Review the structured result');
    await click('#prompt-edit'); await browser.eval(`const edit = document.querySelector('#prompt-edit-text'); edit.value += '\\n\\nKeep the existing API response format.'; edit.setSelectionRange(edit.value.length - 37, edit.value.length); edit.scrollTop = edit.scrollHeight;`); await shot(1.2, 'Edit the result if needed');
    await click('#prompt-edit-save'); await shot(0.7, 'Save your exact wording');
    await click('#output-tools > summary'); await shot(0.6, 'More actions: split, export or add to Kanban');
    await click('#split-button');
    await browser.until(`document.querySelectorAll('#split-list .split-item').length === 3`, 'three proposed tasks', 20000);
    await browser.eval(`const target = document.querySelector('#split-project'); target.value = [...target.options].find(option => option.textContent === 'Shop app').value; target.dispatchEvent(new Event('change'));`);
    await shot(2.6, 'Split into three editable To Do tasks');
  });
  await browser.eval(`document.querySelector('#split-form').requestSubmit();`);
  await browser.until(`document.querySelector('#autopilot-dialog').open`, 'tasks saved', 20000);
  await browser.eval(`document.querySelector('#autopilot-dialog').close();`);
  let project = (await app.board.view()).projects[0];
  const checkout = project.repository.path || project.repository.root;
  await mkdir(join(checkout, 'src'), { recursive: true });
  await writeFile(join(checkout, 'src/auth.ts'), 'export const LOGIN_LIMIT = 5;\n\nexport type LoginRequest = {\n  email: string;\n  password: string;\n};\n\nexport type Session = {\n  userId: string;\n  expiresAt: number;\n};\n');
  execFileSync('git', ['add', 'src/auth.ts'], { cwd: checkout });
  execFileSync('git', ['commit', '-m', 'Seed demo authentication types'], { cwd: checkout, stdio: 'ignore' });
  await app.board.delivery.setTestCommands(project.id, { commands: [{ command: `${process.execPath} -e "process.exit(0)"`, label: 'Unit tests (demo)' }], expectedRevision: project.revision });
  project = (await app.board.view()).projects[0];
  await app.board.setColumns(project.id, { columns: project.columns.map(column => column.id === 'planning' ? { id: 'planning', hidden: true } : { id: column.id }), expectedRevision: project.revision });
  const instruction = await app.board.base.create({ kind: 'skill', name: 'API checklist', description: 'Preserve API contracts. Cover failure paths.', content: { body: 'Preserve existing API responses. Test valid login, invalid credentials, and rate limits. Keep changes small.' } });
  const wiki = await app.board.base.create({ kind: 'knowledge', name: 'Shop API wiki', description: 'Linked notes for login, sessions and rate limits.', content: { pages: [{ id: 'auth', title: 'Authentication', markdown: '# Authentication\nUse the existing src/auth.ts. Return the existing session format.\n\nSee [[limits|Rate limits]].', links: ['limits'] }, { id: 'limits', title: 'Rate limits', markdown: '# Rate limits\nAllow five attempts per minute. Refuse the sixth attempt.', links: [] }] } });
  const context = await app.board.base.create({ kind: 'context', name: 'Shop conventions', description: 'Retrieve the relevant API reference for each task.', configuration: { sources: [{ kind: 'knowledge', resourceId: wiki.id }], query: 'login session rate limit' } });
  await app.board.base.create({ kind: 'mcp', name: 'Context7', description: 'Optional documentation MCP. Review credentials before use.', enabled: false, trust: 'untrusted', configuration: { transport: 'streamable-http', endpoint: 'https://mcp.context7.com/mcp', headers: { Authorization: 'CONTEXT7_AUTHORIZATION' } } });
  await app.board.base.create({ kind: 'tool', name: 'Run unit tests', description: 'A reusable command recipe, subject to agent permissions.', configuration: { delivery: 'command-recipe', command: 'npm', args: ['test'] } });
  const pack = await app.board.base.create({ kind: 'pack', name: 'Shop essentials', description: 'One reusable bundle: API skill, wiki and context.', configuration: { resources: [instruction, wiki, context].map(resource => ({ resourceId: resource.id, required: true })) } });
  const profile = await app.board.base.create({ kind: 'profile', name: 'Shop engineer', description: 'Build focused changes using the shared API resources.', configuration: { agent: { provider: 'claude', instructions: 'Make small, testable changes. Preserve the existing API.' }, binding: { mode: 'extend', include: [{ resourceId: pack.id, required: true }], exclude: [] } } });
  await app.board.base.create({ kind: 'profile', name: 'API reviewer', description: 'Check contracts, failure paths and test coverage.', configuration: { agent: { provider: 'claude', instructions: 'Review the API contracts and tests.' }, binding: { mode: 'extend', include: [{ resourceId: instruction.id, required: true }, { resourceId: wiki.id, required: true }], exclude: [] } } });
  await browser.eval(`location.hash = '#/base';`);
  await browser.until(`document.querySelector('#base-list').children.length === 8`, 'Base library');
  await encode('base-demo', async () => {
    await shot(1.2, 'One shared library for all resource types');
    await click('#base-categories [data-kind="skill"]'); await click(`#base-list [data-resource-id="${instruction.id}"]`);
    await browser.until(`document.querySelector('#base-skill-body')`, 'instruction editor');
    await browser.eval(`document.querySelector('#base-skill-body').scrollIntoView({block:'center'});`); await shot(1.6, 'Reusable, editable instructions');
    await click('#base-categories [data-kind="knowledge"]'); await click(`#base-list [data-resource-id="${wiki.id}"]`);
    await browser.until(`document.querySelector('#base-wiki-markdown')`, 'wiki editor');
    await browser.eval(`document.querySelector('#base-wiki-markdown').scrollIntoView({block:'center'});`); await shot(1.6, 'Linked knowledge pages keep shared context');
    await click('#base-categories [data-kind="agent"]'); await browser.until(`document.querySelectorAll('#base-list > li').length === 2`, 'filtered agent cards'); await browser.eval(`window.scrollTo(0,0);`); await shot(2.2, 'Agent cards show configured resources');
    await browser.eval(`const card = [...document.querySelectorAll('.base-agent-card')].find(node => node.textContent.includes('Shop engineer')); [...card.querySelectorAll('button')].find(node => node.textContent === 'Apply to…').click();`);
    await browser.until(`document.querySelector('.base-apply-targets input')`, 'assignment targets');
    await browser.eval(`const target = document.querySelector('[data-target-key=${JSON.stringify(`project:${project.id}::`)}]'); target.click();`); await shot(1.2, 'Choose a real project');
    await clickText('Preview changes', "document.querySelector('#base-dialog')");
    await browser.until(`[...document.querySelectorAll('#base-dialog button')].some(node => node.textContent === 'Apply assignments' && !node.disabled)`, 'resolved resource preview');
    await browser.eval(`document.querySelector('#base-dialog').scrollTop = document.querySelector('#base-dialog').scrollHeight;`); await shot(2.4, 'Preview the resolved instructions and context');
    await clickText('Apply assignments', "document.querySelector('#base-dialog')"); await browser.until(`!document.querySelector('#base-dialog').open`, 'saved assignment');
    await shot(1.4, 'Assigned by reference. No agent starts yet.');
  });
  // The following real task run consumes the profile and its pack through Base.
  project = (await app.board.view()).projects[0]; const taskId = project.tasks[0].id;
  await app.board.setAutopilot(project.id, { route: ['executing', 'code_review', 'testing', 'merge'], finish: 'merge', maxRework: 1, queue: [taskId], expectedRevision: project.revision });
  await browser.resize(1280,820);
  await browser.eval(`location.hash = '#/kanban'; await loadBoard(); setProjectCollapsed(true); if (document.documentElement.dataset.sidebar === 'collapsed') toggleSidebar(); document.documentElement.style.zoom = '1'; window.PromptboardDock?.setState('collapsed');`);
  await encode('kanban-demo', async () => {
    await shot(0.6, 'Project workspace, board and To Do tasks');
    await click('#project-toggle'); await shot(1.2, 'Project settings now live in the sidebar');
    await click('#project-toggle');
    await click('#workspace-list .file-tree-toggle');
    await browser.until(`document.querySelector('[data-file-path="src"]')`, 'project source folder');
    await click('[data-file-path="src"]');
    await browser.until(`document.querySelector('[data-file-path="src/auth.ts"]')`, 'authentication file');
    await click('[data-file-path="src/auth.ts"]');
    await browser.until(`document.querySelector('.file-code').textContent.includes('LOGIN_LIMIT')`, 'file preview');
    await click('[aria-label="Edit file"]');
    await browser.eval(`const edit = document.querySelector('.file-editor'); edit.value += '\\n// Keep the existing API response format.\\n'; edit.dispatchEvent(new Event('input', { bubbles: true }));`);
    await click('.file-save');
    await browser.until(`document.querySelector('.file-status').textContent.includes('Saved')`, 'explicit file save');
    await click('[aria-label="Show AI file panel"]');
    await shot(1.6, 'Edit and save project files; AI proposals stay optional');
    await click('[aria-label="Close file viewer"]');
    if (!(await readFile(join(checkout, 'src/auth.ts'), 'utf8')).includes('// Keep the existing API response format.')) throw new Error('The explicit file edit did not reach disk.');
    execFileSync('git', ['add', 'src/auth.ts'], { cwd: checkout });
    execFileSync('git', ['commit', '-m', 'Save the demo file edit'], { cwd: checkout, stdio: 'ignore' });
    await browser.eval(`toggleSidebar(); openAutopilot({first:[${JSON.stringify(taskId)}]});`);
    await shot(1.0, 'Choose the Autopilot route and consent');
    await browser.eval(`document.querySelector('#autopilot-consent').checked = true; document.querySelector('#autopilot-form').requestSubmit();`);
    await browser.until(`!document.querySelector('#autopilot-dialog').open`, 'Autopilot started', 20000);
    const captured = new Set();
    for (const deadline = Date.now() + 180000; ;) {
      const view = await app.board.view(), task = view.projects[0].tasks.find(task => task.id === taskId);
      const autopilot = (await app.board.state()).projects[0].autopilot;
      if (autopilot.status === 'paused') throw new Error(`Autopilot paused: ${autopilot.reason}`);
      const run = view.runs.find(run => run.taskId === taskId && run.stage === task.column);
      const ready = ['merge','done'].includes(task.column) || run?.turnComplete;
      if (ready && !captured.has(task.column) && ['executing', 'code_review', 'testing', 'merge', 'done'].includes(task.column)) {
        await browser.eval(`await loadBoard(); const column = document.querySelector('.kanban-column[data-column="${task.column}"]'); column.scrollIntoView({block:'nearest',inline:'nearest'});`);
        if (run) await browser.eval(`window.PromptboardDock.open(${JSON.stringify(run.id)});`);
        await shot(task.column === 'done' ? 1.6 : 1.1, `${task.column}: real workflow, simulated agent`); captured.add(task.column);
      }
      if (autopilot.status === 'finished') break;
      if (Date.now() > deadline) throw new Error('Autopilot did not finish.'); await pause(150);
    }
    if (!['executing','code_review','testing','merge','done'].every(stage => captured.has(stage))) throw new Error('A required workflow scene was missed.');
    const runs = (await app.board.view()).runs.filter(run => run.taskId === taskId);
    if (!runs.some(run => run.baseManifest?.supplied?.some(entry => entry.resourceId === instruction.id))) throw new Error('The selected Base skill was not actually supplied.');
    await browser.eval(`window.PromptboardDock.setState('collapsed'); await loadBoard();`); await shot(1.1, 'Verified task merged and recorded in Done');
  });
  // Origin plans the same shop through the real page: every entry is typed into the UI and saved.
  await browser.eval(`if (document.documentElement.dataset.sidebar === 'collapsed') toggleSidebar(); location.hash = '#/origin'; window.scrollTo(0,0);`);
  await browser.until(`document.querySelector('#origin-idea')`, 'Origin start screen');
  const section = async id => { await browser.eval(`document.querySelector('.origin-nav-item[data-section=${JSON.stringify(id)}]').click(); window.scrollTo(0,0);`); await browser.until(`document.querySelector('#origin-section-heading')`, `Origin ${id}`); };
  const quick = (id, text) => browser.eval(`const input = document.querySelector('[data-quick=${JSON.stringify(id)}]'); input.value = ${JSON.stringify(text)}; input.form.requestSubmit();`);
  const field = (label, value) => browser.eval(`const box = [...document.querySelectorAll('#origin-drawer .origin-field')].find(node => node.querySelector('.origin-field-label')?.textContent === ${JSON.stringify(label)}); const control = box.querySelector('input, textarea, select'); control.value = ${JSON.stringify(value)}; control.dispatchEvent(new Event(control.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));`);
  const closeDrawer = () => browser.eval(`document.querySelector('#origin-drawer [aria-label="Close editor"]')?.click();`);
  await encode('origin-demo', async () => {
    await browser.eval(`document.querySelector('#origin-first-project').value = 'Shop app'; document.querySelector('#origin-first-kanban').checked = false; const idea = document.querySelector('#origin-idea'); idea.value = ${JSON.stringify(IDEA)}; idea.focus();`);
    await shot(1.2, 'Every project starts in Origin');
    await click('#origin-start');
    await browser.until(`document.querySelector('.origin-map') && document.querySelector('#origin-view').dataset.save === 'saved'`, 'project map', 20000);
    // The shop's Kanban project already exists; connect it through the page's own dialog.
    await click('#origin-kanban-link');
    await browser.until(`document.querySelector('#origin-connect-dialog')?.open`, 'connect dialog');
    await click('#origin-connect-dialog-submit');
    await browser.until(`document.querySelector('#origin-kanban-link').textContent === 'Kanban · Shop app'`, 'linked to Kanban');
    await shot(1.0, 'The idea becomes a project map');
    await section('requirements');
    for (const title of ['Customers sign in with email', 'Browse and search products', 'Check out with a card']) await quick('requirements', title);
    await browser.eval(`document.querySelector('#origin-main .origin-row-open').click();`);
    await browser.until(`!document.querySelector('#origin-drawer').hidden`, 'requirement editor');
    await field('Done when', 'A magic link arrives within one minute\nThe sixth failed attempt is refused');
    await shot(1.4, 'Type a line, press Enter; add details only where needed');
    for (const [index, checks] of [[1, 'Search finds a product by name'], [2, 'A paid order reaches the order list']]) {
      await browser.eval(`document.querySelectorAll('#origin-main .origin-row-open')[${index}].click();`);
      await field('Done when', checks);
    }
    await closeDrawer(); await section('architecture');
    for (const [name, type] of [['Web app', 'client'], ['API', 'api'], ['PostgreSQL', 'database']]) { await browser.eval(`document.querySelector('.origin-canvas-tools select').value = ${JSON.stringify(type)};`); await quick('components', name); }
    const node = (name, key) => browser.eval(`[...document.querySelectorAll('.origin-node')].find(node => node.textContent.includes(${JSON.stringify(name)})).dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }));`);
    for (const [from, to] of [['Web app', 'API'], ['API', 'PostgreSQL']]) { await click('#origin-connect'); await node(from, ' '); await node(to, ' '); await closeDrawer(); }
    await browser.until(`document.querySelectorAll('.origin-edge').length === 2`, 'connected blocks');
    await shot(1.4, 'Sketch the building blocks and how they connect');
    // Two layers group the blocks; each block picks its layer in its editor.
    for (const layer of ['Frontend', 'Backend']) await quick('layers', layer);
    for (const [name, purpose, layer] of [['Web app', 'Catalog, cart and checkout pages', 'Frontend'], ['API', 'Accounts, orders and payments', 'Backend'], ['PostgreSQL', 'Stores customers, products and orders', 'Backend']]) {
      await node(name, 'Enter'); await field('What it does', purpose);
      await browser.eval(`const box = [...document.querySelectorAll('#origin-drawer .origin-field')].find(node => node.querySelector('.origin-field-label')?.textContent === 'Layer'); const select = box.querySelector('select'); select.value = [...select.options].find(option => option.textContent === ${JSON.stringify(layer)}).value; select.dispatchEvent(new Event('change', { bubbles: true }));`);
    }
    await closeDrawer();
    await section('decisions'); await quick('decisions', 'Database');
    await browser.until(`document.querySelector('#origin-drawer-title')?.value === 'Database'`, 'decision editor');
    await field('Decision', 'PostgreSQL'); await field('Why', 'Orders and stock are relational');
    await browser.eval(`[...document.querySelectorAll('#origin-drawer .origin-seg button')].find(node => node.textContent === 'Accepted').click();`);
    await shot(1.0, 'Record decisions with their reason');
    await closeDrawer(); await section('security');
    for (const [area, text] of [['authentication', 'Email magic links, rate-limited'], ['secrets', 'Environment variables on the host'], ['input_validation', 'Schema checks on every API route']]) await browser.eval(`const input = document.querySelector('.origin-topic[data-area=${JSON.stringify(area)}] input'); input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('input', { bubbles: true }));`);
    await browser.eval(`document.activeElement?.blur(); window.scrollTo(0,0);`);
    await shot(0.9, 'Answer one question per topic');
    // Tasks: one per building block, grouped by layer; the block and its layer come with the task.
    await section('plan');
    for (const [name, title] of [['Web app', 'Product catalog page'], ['API', 'Checkout endpoint'], ['PostgreSQL', 'Orders schema']]) {
      await browser.eval(`const input = [...document.querySelectorAll('.origin-task-component')].find(block => block.querySelector('.origin-task-component-name')?.textContent === ${JSON.stringify(name)}).querySelector('.origin-quick input'); input.value = ${JSON.stringify(title)}; input.form.requestSubmit();`);
    }
    await browser.until(`document.querySelectorAll('#origin-main .origin-task-group .origin-row').length === 3`, 'component tasks');
    await browser.eval(`document.activeElement?.blur(); window.scrollTo(0,0);`);
    await shot(1.2, 'Prepare tasks by layer and component');
    await browser.eval(`[...document.querySelectorAll('#origin-main .origin-row-open')].find(row => row.textContent.includes('Checkout endpoint')).click();`);
    await browser.until(`document.querySelector('#origin-drawer-title')?.value === 'Checkout endpoint'`, 'task editor');
    await field('Done when', 'A paid order reaches the order list\nA declined card shows a clear message');
    await browser.eval(`document.querySelector('#origin-drawer .origin-context').open = true;`);
    await browser.until(`document.querySelector('#origin-drawer .origin-context-names')`, 'context summary', 20000);
    await shot(1.6, 'Each task carries just the context it needs');
    await closeDrawer();
    await section('overview');
    await browser.until(`document.querySelector('#origin-view').dataset.save === 'saved'`, 'blueprint saved', 20000);
    await shot(2.0, 'See the whole project before any agent starts');
  });
  const { OriginStore } = await import('../src/origin.mjs');
  const [shop] = await new OriginStore(join(work, 'data')).list();
  if (shop?.kanbanProjectId !== project.id) throw new Error('The Origin project was not linked to the Kanban project.');
  const blueprint = shop.blueprint;
  if (blueprint.requirements.length !== 3 || blueprint.components.length !== 3 || blueprint.connections.length !== 2 || blueprint.items.length !== 3 || blueprint.layers.length !== 2
    || !blueprint.items.every(item => item.componentIds.length === 1)) throw new Error('The Origin blueprint was not saved as shown.');
  const exceptions = browser.consoleMessages.filter(message => message.startsWith('EXCEPTION')); if (exceptions.length) throw new Error(exceptions.join('\n'));
  if (preview) await writeFile(join(preview, 'storyboards.json'), JSON.stringify(storyboards, null, 2));
  console.log('Verified: three To Do tasks, an explicit project file save, one real verified merge, pinned Base instruction delivery and a saved Origin blueprint.');
} finally {
  await browser?.close(); await app?.close(); await rm(work, { recursive: true, force: true });
}
