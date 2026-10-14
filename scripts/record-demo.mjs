#!/usr/bin/env node
/** Five dark-mode README demos, each 12–20 s, with step captions and a visible pointer. Requires Chrome and ffmpeg.
 * Model responses and coding CLIs are simulated; UI, persistence, Git worktrees, stage checks, merges and
 * resource delivery use the real app in disposable folders. The script fails if a scene did not really happen.
 * Run: node scripts/record-demo.mjs
 * Optional: PB_DEMO_PREVIEW_DIR=/absolute/path keeps the stills for review.
 */
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../tests/helpers/browser.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const work = await mkdtemp(join(tmpdir(), 'pb-demo-'));
const preview = process.env.PB_DEMO_PREVIEW_DIR;
const J = JSON.stringify;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const IDEA = 'An online shop where customers sign in, browse products and check out. Two developers, launch in three months.';
const REQUEST = 'Add login to the shop. Use `src/auth.ts`. Limit attempts to 5 per minute. No new dependencies.';
const PROMPT = '# Goal\nAdd login to the shop.\n\n# Work\n1. Use `src/auth.ts` for the login route.\n2. Limit attempts to 5 per minute.\n3. Write tests and API docs.\n\n# Constraints\nDo not add dependencies.\n\n# Acceptance checks\nA correct login returns a session. The sixth attempt is refused.';
const SPLIT = [
  { title: 'Add the login route', prompt: 'Add login to the shop using `src/auth.ts`. Do not add dependencies. A correct login returns a session.' },
  { title: 'Rate-limit login attempts', prompt: 'Limit attempts to 5 per minute. Test that the sixth attempt is refused.' },
  { title: 'Write the login API docs', prompt: 'Document the login route, its session response, and the limit of 5 attempts per minute.' },
];
const ANSWER = '## Stripe or Adyen for checkout\n\n| | Stripe | Adyen |\n| --- | --- | --- |\n| Setup | Self-serve, same day | Sales onboarding |\n| Pricing | Flat fee per payment | Interchange++ |\n| Fit for two developers | **Strong** | Weak |\n\n**Recommendation:** use **Stripe Checkout**. The API calls Stripe, and a webhook confirms each paid order.\n';
const research = { taskId: null };
const researchRunner = async call => {
  for (const label of ['stripe checkout pricing', 'adyen onboarding']) { call.onEvent({ type: 'activity', kind: 'search', label }); await pause(500); }
  const parts = ANSWER.match(/[^\n]*\n/g);
  for (let index = 0; index < parts.length; index += 3) { call.onEvent({ type: 'delta', text: parts.slice(index, index + 3).join('') }); await pause(220); }
  const suggestions = { suggestions: [
    { ref: 'adr', title: 'Payment provider: Stripe', target: { kind: 'add', collection: 'decisions' }, value: { title: 'Payment provider', decision: 'Stripe Checkout', reason: 'Self-serve setup and flat pricing suit a two-person team', alternatives: 'Adyen', status: 'proposed' } },
    { ref: 'stripe', title: 'Stripe', target: { kind: 'add', collection: 'components' }, value: { name: 'Stripe', type: 'external', purpose: 'Takes card payments' } },
    { title: 'API charges cards through Stripe', target: { kind: 'add', collection: 'connections' }, value: { from: research.apiId, to: '@stripe', label: 'charges', protocol: 'HTTPS' } },
    { title: 'Stripe webhook handler', target: { kind: 'add', collection: 'items' }, value: { title: 'Stripe webhook handler', description: 'Confirm paid orders from Stripe webhooks.', acceptanceCriteria: 'A paid event marks the order paid\nA bad signature is refused', componentIds: [research.apiId], dependsOn: [research.taskId] } },
  ] };
  return { text: `${ANSWER}\n\`\`\`origin-suggestions\n${J(suggestions)}\n\`\`\``, session: call.session?.id || 'thread-1' };
};

let app, browser, frames, sceneName, step, caption = '';
const pointer = { x: 1180, y: 760 };
const storyboards = {};
/** The caption pill and the pointer are top-layer popovers, so page re-renders and modal dialogs never cover them.
 * The app's Content-Security-Policy refuses <style> elements, so the styles come as a constructed stylesheet. */
const OVERLAY = `if (!document.getElementById('demo-caption')) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync('.demo-layer{position:fixed;inset:auto;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none}#demo-caption{left:718px;top:10px;transform:translateX(-50%);max-width:520px;padding:9px 18px 9px 10px;border-radius:999px;background:rgba(9,11,22,.92);color:#f4f6ff;font:600 15px/1.25 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.16);white-space:nowrap;display:flex;align-items:center;gap:10px}#demo-caption b{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;background:linear-gradient(135deg,#7c8cff,#b06cff);color:#fff;font-size:13px}#demo-pointer{left:0;top:0;filter:drop-shadow(0 2px 3px rgba(0,0,0,.6))}#demo-ring{width:38px;height:38px;margin:-19px 0 0 -19px;border-radius:50%;border:2px solid #a9b6ff;background:rgba(140,155,255,.22);opacity:0}');
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  const layer = id => { const node = document.createElement('div'); node.id = id; node.className = 'demo-layer'; node.popover = 'manual'; return node; };
  const pill = layer('demo-caption'), ring = layer('demo-ring'), arrow = layer('demo-pointer');
  arrow.innerHTML = '<svg width="24" height="28" viewBox="0 0 24 28"><path d="M3 2v20l5-4.6 3.4 7.6 3.3-1.5-3.3-7.4H18z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  document.body.append(pill, ring, arrow);
}
// Re-open in order: the last popover shown is on top, above any modal dialog opened since.
for (const id of ['demo-ring', 'demo-pointer', 'demo-caption']) { const node = document.getElementById(id); if (node.matches(':popover-open')) node.hidePopover(); node.showPopover(); }`;
async function paintOverlay({ ring = false } = {}) {
  await browser.eval(`${OVERLAY}
    const pill = document.getElementById('demo-caption'); pill.style.visibility = ${J(caption)} ? 'visible' : 'hidden'; pill.innerHTML = '<b>${step}</b><span></span>'; pill.lastChild.textContent = ${J(caption)};
    document.getElementById('demo-pointer').style.transform = 'translate(${pointer.x - 3}px, ${pointer.y - 2}px)';
    const ring = document.getElementById('demo-ring'); ring.style.opacity = ${ring} ? '1' : '0'; ring.style.left = '${pointer.x}px'; ring.style.top = '${pointer.y}px';`);
}
/** One frame. `settle` waits for the page to finish painting; pointer frames skip it. */
async function shot(seconds, { settle = 250, ring = false } = {}) {
  await paintOverlay({ ring });
  // Nothing personal on screen: the recording machine's home folder never appears in a frame.
  if (await browser.eval(`return document.body.innerText.includes(${J(homedir())});`)) throw new Error(`${sceneName}: the home folder is visible on screen (${caption}).`);
  if (settle) { await browser.layout('return document.documentElement.dataset.theme === "dark";'); await pause(settle); }
  const file = join(work, `${sceneName}-${String(frames.length).padStart(3, '0')}.png`);
  await writeFile(file, await browser.screenshot()); frames.push({ file, seconds, caption });
}
const say = text => { step += 1; caption = text; };
const finder = target => typeof target === 'string' ? `document.querySelector(${J(target)})` : `(${target.js})`;
/** Glide the pointer to an element (a selector, or { js } returning the node). */
async function moveTo(target) {
  const to = await browser.eval(`const node = ${finder(target)}; if (!node) throw new Error('Not on the page: ' + ${J(String(target.js || target))});
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = node.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(r.width / 2, 48)), y: Math.round(r.top + r.height / 2) };`);
  const from = { ...pointer };
  for (const fraction of [0.35, 0.7, 0.92, 1]) { pointer.x = Math.round(from.x + (to.x - from.x) * fraction); pointer.y = Math.round(from.y + (to.y - from.y) * fraction); await shot(0.067, { settle: 0 }); }
}
/** Point, show the click ring, then press the real control. */
async function tap(target) {
  await moveTo(target); await shot(0.2, { settle: 0, ring: true });
  await browser.eval(`const node = ${finder(target)}; if (node.disabled) throw new Error('Disabled: ' + ${J(String(target.js || target))}); node.focus(); node.click();`);
}
const button = (text, scope = 'document') => ({ js: `[...${scope}.querySelectorAll('button')].find(node => node.textContent.trim() === ${J(text)})` });
/** Type text into a field in a few visible steps. */
async function type(target, text, { seconds = 0.13, chunks = 4 } = {}) {
  const words = text.split(' ');
  for (let index = 1; index <= chunks; index++) {
    const part = words.slice(0, Math.ceil(words.length * index / chunks)).join(' ');
    await browser.eval(`const node = ${finder(target)}; node.focus(); node.value = ${J(part)}; node.dispatchEvent(new Event('input', { bubbles: true }));`);
    await shot(seconds, { settle: index === chunks ? 120 : 0 });
  }
}
async function encode(name, scene) {
  sceneName = name; frames = []; step = 0; caption = '';
  await scene();
  const total = frames.reduce((sum, frame) => sum + frame.seconds, 0);
  if (total > 20 || total < 12) throw new Error(`${name}: ${total.toFixed(1)} s is outside 12–20 s`);
  const list = join(work, `${name}.txt`);
  await writeFile(list, frames.map(frame => `file '${frame.file}'\nduration ${frame.seconds.toFixed(3)}`).join('\n') + `\nfile '${frames.at(-1).file}'\n`);
  const out = join(root, 'docs', `${name}.gif`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-t', total.toFixed(2),
    '-vf', 'fps=15,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', '-loop', '0', out]);
  storyboards[name] = frames.filter(frame => frame.seconds > 0.1).map(({ seconds, caption }) => ({ seconds, caption }));
  if (preview) { await mkdir(preview, { recursive: true }); for (const [index, frame] of frames.entries()) if (frame.seconds > 0.1) await copyFile(frame.file, join(preview, `${name}-${String(index).padStart(3, '0')}.png`)); }
  console.log(`${name}: ${total.toFixed(1)} s, ${frames.length} frames, ${((await stat(out)).size / 1e6).toFixed(1)} MB`);
}
const view = async () => (await app.board.view()).projects.find(project => project.name === 'Shop app');

try {
  // A simulated Claude Code: the real lifecycle hooks, with a short readable transcript for each stage.
  const bin = join(work, 'bin'); await mkdir(bin);
  await writeFile(join(bin, 'claude'), `#!${process.execPath}
const args = process.argv.slice(2), prompt = args.includes('--') ? args[args.indexOf('--') + 1] : args.at(-1) || '';
const stage = prompt.includes('=== DIFF:') ? 'review' : args.includes('plan') ? 'plan' : prompt.includes('Test the task below') ? 'test' : prompt.includes('Start implementing') ? 'build' : 'other';
const title = (prompt.match(/^# (?:Task|TASK)[^\\n]*\\n+([^\\n]+)/m) || prompt.match(/Task: ([^\\n]+)/) || [])[1] || 'the task';
const lines = { plan: ['● Reading the task and where it fits', '● Plan', '  1. Change only the files this task owns', '  2. Add a test for each "done when" check', '  3. Run the tests'],
  build: ['● Following the approved plan', '● Edited 2 files, added 1 test', '● Tests pass'], review: ['● Reviewing the diff', '● No blocking findings'],
  test: ['● Running the configured tests', '● All tests pass'], other: ['● Working'] }[stage];
if (stage !== 'build') process.env.FAKE_AGENT_WRITE = '0';
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const childProcess = require('node:child_process'), spawnSync = childProcess.spawnSync;
childProcess.spawnSync = (command, list, options) => { if (String(options?.input).includes('"hook_event_name":"Stop"')) sleep(1600); return spawnSync(command, list, options); };
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (text, ...rest) => {
  if (typeof text === 'string' && /working on \\d+ characters/.test(text)) { for (const line of lines) { write(line + '\\r\\n'); sleep(180); } return true; }
  return write(typeof text !== 'string' ? text : text.replace(/fake claude started in [^\\r\\n]+/, '\\x1b[38;5;141m✻ Claude Code\\x1b[0m  simulated for this demo').replace(/^turn complete/m, '\\x1b[32m✓ Done\\x1b[0m'), ...rest);
};
require(${J(join(root, 'tests/fixtures/fake-agent.cjs'))});
`);
  await chmod(join(bin, 'claude'), 0o755);
  Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, FAKE_AGENT_WRITE: '1', GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.invalid', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.invalid' });
  const { startServer } = await import('../src/server.mjs');
  app = await startServer({ port: 0, dataDir: join(work, 'data'), projectsDir: join(work, 'projects'), researchRunner,
    runner: async ({ prompt }) => { await pause(500); return { text: prompt.startsWith('# Task split') ? J({ tasks: SPLIT }) : PROMPT, reportedModels: ['demo-model'] }; },
    detector: async () => [{ id: 'claude', name: 'Claude Code', available: true, version: 'simulated demo' }],
    catalogReader: async provider => ({ provider, source: 'cli', defaultModel: 'demo-model', note: 'Simulated demo model.', models: [{ id: 'demo-model', name: 'Demo model', efforts: ['low', 'high'] }] }),
    authAdapter: { installed: async () => true, status: async () => ({ state: 'signed-in', method: 'demo' }) },
    usageReader: { get: async () => ({ updatedAt: Date.now(), providers: [] }) },
  });
  // The Kanban side of the shop: a typed pipeline (the default for new boards) with a real test command and Full Autopilot.
  await app.board.createProjectWithRepository({ name: 'Shop app', folder: 'new', workflowMode: 'pipeline' });
  let project = await view();
  const checkout = project.repository.path || project.repository.root;
  await mkdir(join(checkout, 'test'), { recursive: true });
  await writeFile(join(checkout, 'test/shop.test.js'), "import test from 'node:test';\n\ntest('the shop starts', () => {});\n");
  execFileSync('git', ['add', 'test'], { cwd: checkout }); execFileSync('git', ['commit', '-q', '-m', 'Add the shop test suite'], { cwd: checkout });
  await app.board.delivery.setTestCommands(project.id, { commands: [{ command: 'node --test', label: 'Unit tests' }], expectedRevision: (await view()).revision });
  await app.board.applyFullAutopilot(project.id, { expectedRevision: (await view()).revision, confirm: true });

  browser = await launch({ width: 1280, height: 820, motion: true }); if (!browser) throw new Error('Chrome was not found.');
  await browser.resize(1280, 820); await browser.goto(app.url);
  await browser.eval(`localStorage.setItem('ste-prompt-engineer.theme', 'dark'); localStorage.setItem('promptboard.settings.dock-start', 'collapsed'); localStorage.setItem('promptboard.dock.height', '230'); localStorage.setItem('promptboard.settings.open-terminal', '0'); localStorage.setItem('promptboard.project-panel', 'collapsed');`);
  await browser.reload();
  await browser.until(`!document.querySelector('#generate-button').disabled`, 'Compose ready', 20000);

  // ---- Origin: design the shop, plan tasks in build order, send them to Kanban ----
  await browser.eval(`location.hash = '#/origin'; window.scrollTo(0, 0);`);
  await browser.until(`document.querySelector('#origin-idea')`, 'Origin start screen');
  const section = async id => { await browser.eval(`document.querySelector('.origin-nav-item[data-section=${J(id)}]').click(); window.scrollTo(0, 0);`); await browser.until(`document.querySelector('#origin-section-heading')`, `Origin ${id}`); };
  const quick = (id, text) => browser.eval(`const input = document.querySelector('[data-quick=${J(id)}]'); input.value = ${J(text)}; input.form.requestSubmit();`);
  const fieldJs = label => `[...document.querySelectorAll('#origin-drawer .origin-field, #origin-drawer .origin-group')].find(node => node.querySelector('.origin-field-label, .origin-group-label, h4, legend')?.textContent.trim() === ${J(label)})`;
  const field = (label, value) => browser.eval(`const box = ${fieldJs(label)}; if (!box) throw new Error('No field ' + ${J(label)}); const control = box.querySelector('input, textarea, select'); control.value = ${J(value)}; control.dispatchEvent(new Event(control.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));`);
  const link = (label, name) => browser.eval(`document.querySelectorAll('#origin-drawer details').forEach(node => { node.open = true; }); const box = ${fieldJs(label)}; if (!box) throw new Error('No group ' + ${J(label)}); const pick = box.querySelector('select.origin-link-add'); pick.value = [...pick.options].find(option => option.textContent.includes(${J(name)})).value; pick.dispatchEvent(new Event('change', { bubbles: true }));`);
  const closeDrawer = () => browser.eval(`document.querySelector('#origin-drawer [aria-label="Close editor"]')?.click();`);
  const node = (name, key) => browser.eval(`[...document.querySelectorAll('.origin-node')].find(node => node.textContent.includes(${J(name)})).dispatchEvent(new KeyboardEvent('keydown', { key: ${J(key)}, bubbles: true }));`);
  const saved = () => browser.until(`document.querySelector('#origin-view').dataset.save === 'saved'`, 'Origin saved', 20000);
  await encode('origin-demo', async () => {
    await browser.eval(`document.querySelector('#origin-first-project').value = 'Shop app'; document.querySelector('#origin-first-kanban').checked = false;`);
    say('Start with your idea');
    await type('#origin-idea', IDEA, { chunks: 4, seconds: 0.2 }); await shot(0.6);
    await tap('#origin-start');
    await browser.until(`document.querySelector('.origin-map') && document.querySelector('#origin-view').dataset.save === 'saved'`, 'project map', 20000);
    // Same name, same project: Origin links the existing Kanban board. Otherwise connect it through the page's dialog.
    if (await browser.eval(`return document.querySelector('#origin-kanban-link').textContent !== 'Kanban · Shop app';`)) {
      await browser.eval(`document.querySelector('#origin-kanban-link').click();`);
      await browser.until(`document.querySelector('#origin-connect-dialog')?.open`, 'connect dialog');
      await browser.eval(`document.querySelector('#origin-connect-dialog-submit').click();`);
    }
    await browser.until(`document.querySelector('#origin-kanban-link').textContent === 'Kanban · Shop app'`, 'linked to Kanban');
    say('Origin turns it into a project map'); await shot(1.3);
    await section('requirements');
    say('Add requirements, one line each');
    for (const title of ['Customers sign in with email', 'Browse and search products', 'Check out with a card']) { await quick('requirements', title); await shot(0.3); }
    await browser.eval(`document.querySelectorAll('#origin-main .origin-row-open')[2].click();`);
    await browser.until(`!document.querySelector('#origin-drawer').hidden`, 'requirement editor');
    await field('Done when', 'A paid order reaches the order list\nA declined card shows a clear message'); await shot(1.0);
    await closeDrawer(); await section('architecture');
    for (const [name, type] of [['Web app', 'client'], ['API', 'api'], ['PostgreSQL', 'database']]) { await browser.eval(`document.querySelector('.origin-canvas-tools select').value = ${J(type)};`); await quick('components', name); }
    for (const [from, to] of [['Web app', 'API'], ['API', 'PostgreSQL']]) { await browser.eval(`document.querySelector('#origin-connect').click();`); await node(from, ' '); await node(to, ' '); await closeDrawer(); }
    for (const layer of ['Frontend', 'Backend']) await quick('layers', layer);
    for (const [name, purpose, layer] of [['Web app', 'Catalog, cart and checkout pages', 'Frontend'], ['API', 'Accounts, orders and payments', 'Backend'], ['PostgreSQL', 'Customers, products and orders', 'Backend']]) {
      await node(name, 'Enter'); await field('What it does', purpose);
      await browser.eval(`const box = ${fieldJs('Layer')}; const select = box.querySelector('select'); select.value = [...select.options].find(option => option.textContent === ${J(layer)}).value; select.dispatchEvent(new Event('change', { bubbles: true }));`);
    }
    await closeDrawer();
    await browser.until(`document.querySelectorAll('.origin-edge').length === 2`, 'connected blocks');
    await browser.eval(`window.scrollTo(0, 0); document.querySelector('#origin-main [aria-label="Fit to view"]')?.click();`);
    say('Sketch blocks, connections and layers'); await shot(1.6);
    await section('decisions'); await quick('decisions', 'Database');
    await browser.until(`document.querySelector('#origin-drawer-title')?.value === 'Database'`, 'decision editor');
    await field('Decision', 'PostgreSQL'); await field('Why', 'Orders and stock are relational');
    say('Record decisions and why');
    await tap(button('Accepted', `document.querySelector('#origin-drawer')`)); await shot(0.9);
    await closeDrawer();
    // Tasks: one per building block, in build order (each starts after the one before).
    await section('plan');
    for (const [name, title] of [['PostgreSQL', 'Orders schema'], ['API', 'Checkout API'], ['Web app', 'Checkout page']]) {
      await browser.eval(`const input = [...document.querySelectorAll('.origin-task-component')].find(block => block.querySelector('.origin-task-component-name')?.textContent === ${J(name)}).querySelector('.origin-quick input'); input.value = ${J(title)}; input.form.requestSubmit();`);
    }
    await browser.until(`document.querySelectorAll('#origin-main .origin-task-group .origin-row').length === 3`, 'component tasks');
    const openTask = title => browser.eval(`[...document.querySelectorAll('#origin-main .origin-row-open')].find(row => row.textContent.includes(${J(title)})).click();`);
    await openTask('Checkout page'); await browser.until(`document.querySelector('#origin-drawer-title')?.value === 'Checkout page'`, 'page task'); await link('Starts after', 'Checkout API'); await closeDrawer();
    await openTask('Checkout API'); await browser.until(`document.querySelector('#origin-drawer-title')?.value === 'Checkout API'`, 'API task');
    await field('Done when', 'POST /checkout creates a paid order\nA declined card returns a clear error'); await link('Starts after', 'Orders schema');
    await browser.eval(`const context = document.querySelector('#origin-drawer .origin-context'); context.open = true; context.scrollIntoView({ block: 'center' });`);
    await browser.until(`document.querySelector('#origin-drawer .origin-context-names')`, 'context summary', 20000);
    say('Each task gets only the context it needs'); await shot(1.6);
    await closeDrawer(); await saved();
    say('Send to Kanban, prerequisites first');
    await browser.eval(`window.scrollTo(0, 0);`);
    await tap('#origin-select-drafts');
    await tap('#origin-kanban-handoff');
    await browser.until(`document.querySelector('#origin-handoff-confirm') && !document.querySelector('#origin-handoff-confirm').disabled`, 'handoff review', 20000);
    await shot(1.4);
    await tap('#origin-handoff-confirm');
    await browser.until(`document.querySelectorAll('.origin-handoff-result.created').length === 3`, 'three cards created', 30000);
    await browser.eval(`document.querySelector('.origin-handoff-results')?.scrollIntoView({ block: 'center' });`);
    say('Three To Do cards; no agent started'); await shot(1.0);
    await browser.eval(`document.querySelector('#origin-handoff-dialog')?.close?.(); document.querySelector('#origin-handoff-dialog [aria-label="Close"]')?.click();`);
    await section('overview'); await saved();
    say('The whole plan on one map'); await shot(2.0);
  });

  // ---- Origin Research: ask your own CLI; suggestions change nothing until you apply them ----
  {
    const { OriginStore } = await import('../src/origin.mjs');
    const [shop] = await new OriginStore(join(work, 'data')).list();
    research.apiId = shop.blueprint.components.find(entry => entry.name === 'API').id;
    research.taskId = shop.blueprint.items.find(entry => entry.title === 'Checkout API').id;
  }
  await encode('origin-research-demo', async () => {
    await section('decisions');
    say('Research the plan with your own CLI');
    await tap('#origin-research-open');
    await browser.until(`document.querySelector('#origin-research-send') && !document.querySelector('#origin-research-send').disabled`, 'research ready', 20000);
    await browser.eval(`document.querySelector('#origin-research-max').click();`);
    await shot(1.0);
    say('Chat, Swarm, Decision Lab or Audit');
    await tap('#origin-research-mode-decision'); await shot(1.0);
    say('Add web, document, Base or MCP sources');
    await tap('#origin-research-web'); await shot(0.9);
    say('Ask a question');
    await type('#origin-research-input', 'Stripe or Adyen for checkout? Two developers, EU customers.', { chunks: 3, seconds: 0.18 });
    await tap('#origin-research-send');
    say('The answer streams in as it searches');
    await browser.until(`document.querySelector('.is-live')`, 'live answer', 20000); await shot(0.9);
    await browser.until(`!document.querySelector('.is-live') && document.querySelectorAll('.origin-research-proposal').length === 4`, 'four suggestions', 30000);
    await browser.eval(`document.querySelector('.origin-research-message.is-assistant')?.scrollIntoView({ block: 'start' });`);
    await shot(1.6);
    say('Suggestions wait for your approval');
    await browser.eval(`document.querySelector('.origin-research-proposal')?.scrollIntoView({ block: 'start' });`); await shot(1.2);
    const webhook = `[...document.querySelectorAll('.origin-research-proposal')].find(card => card.textContent.includes('Stripe webhook handler'))`;
    await tap(button('Preview', webhook));
    await browser.eval(`${webhook}.scrollIntoView({ block: 'center' });`); await shot(1.2);
    say('Apply all: records arrive linked');
    await tap('#origin-research-apply-all');
    await browser.until(`[...document.querySelectorAll('.origin-research-proposal')].every(card => card.dataset.status === 'applied')`, 'all applied', 20000);
    await saved(); await shot(1.0);
    await browser.eval(`document.querySelector('#origin-research-minimize')?.click();`);
    await section('architecture');
    await browser.until(`document.querySelectorAll('.origin-edge').length === 3`, 'Stripe connected');
    await browser.eval(`document.querySelector('#origin-main [aria-label="Fit to view"]')?.click();`);
    say('The architecture now includes Stripe'); await shot(1.8);
  });

  // ---- Compose: a rough request becomes a structured prompt ----
  await browser.eval(`location.hash = '#/'; window.scrollTo(0, 0);`);
  await browser.until(`!document.querySelector('#generate-button').disabled`, 'Compose ready', 20000);
  await browser.eval(`document.querySelector('input[name="quality"][value="fast"]').click(); setSettingsCollapsed(true); window.scrollTo(0, 0);`);
  await encode('compose-demo', async () => {
    say('Describe the task in plain words');
    await type('#prompt-input', REQUEST, { chunks: 4, seconds: 0.25 }); await shot(0.5);
    say('Pick task type, CLI, model and detail');
    await tap('#settings-toggle');
    await browser.eval(`document.querySelector('#compose-general').open = true; const task = document.querySelector('#task'); task.value = 'feature'; task.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('.compose-settings-card').scrollIntoView({ block: 'start' });`);
    await shot(1.6);
    await browser.eval(`document.querySelector('#settings-toggle').click(); document.querySelector('#generate-button').scrollIntoView({ block: 'center' });`);
    say('Generate with your own CLI');
    await tap('#generate-button'); await shot(0.6);
    await browser.until(`document.querySelector('#prompt-output').textContent.includes('Acceptance checks') && !document.querySelector('#split-button').disabled`, 'generated prompt', 20000);
    say('A structured prompt; exact details kept');
    await browser.eval(`document.querySelector('#output-card').scrollIntoView({ block: 'start' });`); await shot(2.2);
    say('Edit, copy, export or save it');
    await tap('#prompt-edit');
    await browser.eval(`const edit = document.querySelector('#prompt-edit-text'); edit.value += '\\n\\nKeep the existing API response format.'; edit.setSelectionRange(edit.value.length - 37, edit.value.length); edit.scrollTop = edit.scrollHeight;`); await shot(1.3);
    await tap('#prompt-edit-save'); await shot(0.6);
    say('Or split it into Kanban cards');
    await tap('#output-tools > summary'); await shot(0.4);
    await tap('#split-button');
    await browser.until(`document.querySelectorAll('#split-list .split-item').length === 3`, 'three proposed tasks', 20000);
    await shot(2.2);
  });
  await browser.eval(`document.querySelector('#split-dialog')?.close?.();`);

  // ---- Base: one library; apply a profile to a project ----
  const skill = await app.board.base.create({ kind: 'skill', name: 'API checklist', description: 'Preserve API contracts. Cover failure paths.', content: { body: 'Preserve existing API responses.\nTest valid login, invalid credentials and rate limits.\nKeep changes small.' } });
  const wiki = await app.board.base.create({ kind: 'knowledge', name: 'Shop API wiki', description: 'Linked notes for checkout, sessions and payments.', content: { pages: [{ id: 'checkout', title: 'Checkout', markdown: '# Checkout\nThe API creates the order, then charges the card through Stripe.\n\nSee [[payments|Payments]].', links: ['payments'] }, { id: 'payments', title: 'Payments', markdown: '# Payments\nA webhook confirms each paid order.', links: [] }] } });
  const context = await app.board.base.create({ kind: 'context', name: 'Shop conventions', description: 'Retrieves the relevant wiki pages for each task.', configuration: { sources: [{ kind: 'knowledge', resourceId: wiki.id }], query: 'checkout payments orders' } });
  const mcp = await app.board.base.create({ kind: 'mcp', name: 'Context7', description: 'Up-to-date library docs over MCP.', enabled: false, trust: 'untrusted', configuration: { transport: 'streamable-http', endpoint: 'https://mcp.context7.com/mcp', headers: { Authorization: 'CONTEXT7_AUTHORIZATION' } } });
  await app.board.base.create({ kind: 'tool', name: 'Run unit tests', description: 'A reusable command recipe.', configuration: { delivery: 'command-recipe', command: 'npm', args: ['test'] } });
  const pack = await app.board.base.create({ kind: 'pack', name: 'Shop essentials', description: 'API checklist, wiki and conventions in one bundle.', configuration: { resources: [skill, wiki, context].map(resource => ({ resourceId: resource.id, required: true })) } });
  const engineer = await app.board.base.create({ kind: 'profile', name: 'Shop engineer', description: 'Small, tested changes with the shop’s API rules.', configuration: { agent: { provider: 'claude', instructions: 'Make small, testable changes. Preserve the existing API.' }, binding: { mode: 'extend', include: [{ resourceId: pack.id, required: true }], exclude: [] } } });
  await app.board.base.create({ kind: 'profile', name: 'API reviewer', description: 'Checks contracts, failure paths and tests.', configuration: { agent: { provider: 'claude', instructions: 'Review the API contracts and tests.' }, binding: { mode: 'extend', include: [{ resourceId: skill.id, required: true }, { resourceId: wiki.id, required: true }], exclude: [] } } });
  project = await view();
  await browser.eval(`location.hash = '#/base';`);
  await browser.until(`document.querySelector('#base-list')?.children.length === 8 && document.querySelector('.base-list-panel[aria-busy=false]')`, 'Base library', 20000);
  await encode('base-demo', async () => {
    say('One library for all agent resources'); await browser.eval(`window.scrollTo(0, 0);`); await shot(1.4);
    say('Skills: reusable instructions');
    await tap(`#base-categories [data-kind="skill"]`); await tap(`#base-list [data-resource-id="${skill.id}"]`);
    await browser.until(`document.querySelector('#base-skill-body')`, 'skill editor');
    await browser.eval(`document.querySelector('#base-skill-body').scrollIntoView({ block: 'center' });`); await shot(1.3);
    say('Knowledge: linked wiki pages');
    await tap(`#base-categories [data-kind="knowledge"]`); await tap(`#base-list [data-resource-id="${wiki.id}"]`);
    await browser.until(`document.querySelector('#base-wiki-markdown')`, 'wiki editor');
    await browser.eval(`document.querySelector('#base-wiki-markdown').scrollIntoView({ block: 'center' });`); await shot(1.3);
    say('MCP servers; secrets by name only');
    await tap(`#base-categories [data-kind="mcp"]`); await tap(`#base-list [data-resource-id="${mcp.id}"]`);
    await browser.until(`[...document.querySelectorAll('button')].some(node => node.textContent === 'Test connection and discover tools')`, 'MCP editor');
    await browser.eval(`[...document.querySelectorAll('button')].find(node => node.textContent === 'Test connection and discover tools').scrollIntoView({ block: 'end' });`); await shot(1.3);
    say('Agent profiles show what they carry');
    await tap(`#base-categories [data-kind="agent"]`);
    await browser.until(`document.querySelectorAll('#base-list > li').length === 2`, 'agent cards'); await browser.eval(`window.scrollTo(0, 0);`); await shot(1.5);
    say('Apply to a project; preview what runs get');
    await tap({ js: `[...[...document.querySelectorAll('.base-agent-card')].find(card => card.textContent.includes('Shop engineer')).querySelectorAll('button')].find(node => node.textContent === 'Apply to…')` });
    await browser.until(`document.querySelector('.base-apply-targets input')`, 'apply targets');
    await tap(`[data-target-key=${J(`project:${project.id}::`)}]`);
    await browser.until(`[...document.querySelectorAll('#base-dialog button')].some(node => node.textContent === 'Apply assignments' && !node.disabled)`, 'automatic preview', 20000);
    await browser.eval(`document.querySelector('#base-dialog h3')?.scrollIntoView({ block: 'start' });`); await shot(2.0);
    say('Saved by reference; no agent started');
    await tap(button('Apply assignments', `document.querySelector('#base-dialog')`));
    await browser.until(`!document.querySelector('#base-dialog').open`, 'applied'); await shot(1.4);
  });

  // ---- Kanban: Autopilot takes the Origin tasks through every stage, in build order ----
  project = await view();
  const order = ['Orders schema', 'Checkout API', 'Checkout page'].map(title => project.tasks.find(task => task.title.includes(title)));
  if (order.some(task => !task)) throw new Error('Origin did not create the three cards.');
  await browser.eval(`location.hash = '#/kanban'; await loadBoard(); setProjectCollapsed(true); if (document.documentElement.dataset.sidebar !== 'collapsed') toggleSidebar(); window.PromptboardDock?.setState('collapsed'); window.scrollTo(0, 0);`);
  await browser.until(`document.querySelectorAll('.task-position').length === 3`, 'cards with their position', 20000);
  await encode('kanban-demo', async () => {
    say('Origin tasks arrive in build order'); await shot(1.4);
    say('Autopilot: prerequisites merge first');
    await tap('#autopilot-open');
    await browser.until(`document.querySelector('#autopilot-dialog').open`, 'Autopilot dialog'); await shot(1.2);
    await browser.eval(`document.querySelector('#autopilot-consent').checked = true;`);
    await tap({ js: `document.querySelector('#autopilot-form [type=submit]')` });
    await browser.until(`!document.querySelector('#autopilot-dialog').open`, 'Autopilot started', 20000);
    const captions = { planning: 'Planning: a read-only plan, then frozen', executing: 'Executing: own branch and worktree', code_review: 'Code Review: a fresh agent checks', testing: 'Testing: your test command decides', merge: 'Merge: only reviewed, tested commits' };
    const captured = new Set(); let laterShown = false;
    for (const deadline = Date.now() + 360000; ;) {
      const state = await view(), autopilot = (await app.board.state()).projects.find(entry => entry.id === state.id).autopilot;
      if (autopilot.status === 'paused') throw new Error(`Autopilot paused: ${autopilot.reason}`);
      // The default board's column IDs name its stages. Each frame shows the agent at work (its turn ends 1.6 s later).
      const first = state.tasks.find(task => task.id === order[0].id), kind = first.column, runs = (await app.board.view()).runs;
      const run = runs.find(entry => entry.taskId === first.id && entry.stage === first.column);
      if (captions[kind] && !captured.has(kind) && (run || kind === 'merge')) {
        captured.add(kind); if (run) await pause(700);
        say(captions[kind]);
        await browser.eval(`await loadBoard(); document.querySelector('.kanban-column[data-column="${first.column}"]')?.scrollIntoView({ block: 'nearest', inline: 'center' }); ${run ? `window.PromptboardDock.open(${J(run.id)});` : ''}`);
        await shot(1.1);
      }
      const secondRun = runs.find(entry => entry.taskId === order[1].id);
      if (!laterShown && secondRun) {
        laterShown = true; await pause(700);
        say('The next card starts from merged code');
        await browser.eval(`await loadBoard(); document.querySelector('.kanban-column[data-column="planning"]')?.scrollIntoView({ block: 'nearest', inline: 'center' }); window.PromptboardDock.open(${J(secondRun.id)});`); await shot(1.2);
      }
      if (autopilot.status === 'finished' || autopilot.status === 'off' && state.tasks.every(task => ['done'].includes(state.pipeline.columns.find(entry => entry.id === task.column)?.role))) break;
      if (Date.now() > deadline) throw new Error('Autopilot did not finish.');
      await pause(150);
    }
    for (const kind of Object.keys(captions)) if (!captured.has(kind)) throw new Error(`Missed the ${kind} scene.`);
    say('All three merged, in order');
    await browser.eval(`window.PromptboardDock.setState('collapsed'); await loadBoard(); window.scrollTo(0, 0); document.querySelector('.kanban-column[data-column="done"]')?.scrollIntoView({ block: 'nearest', inline: 'end' });`); await shot(1.4);
    say('Coordinator: progress and blockers');
    await tap('#coordinator-toggle');
    await browser.until(`!document.querySelector('#coordinator').hidden`, 'Coordinator'); await shot(1.8);
  });

  // The scenes above must have really happened.
  const { OriginStore } = await import('../src/origin.mjs');
  const [shop] = await new OriginStore(join(work, 'data')).list();
  const bp = shop.blueprint;
  if (shop.kanbanProjectId !== project.id) throw new Error('Origin was not linked to the Kanban project.');
  if (bp.requirements.length !== 3 || bp.components.length !== 4 || bp.connections.length !== 3 || bp.layers.length !== 2 || bp.items.length !== 4 || bp.decisions.length !== 2) throw new Error(`The blueprint was not saved as shown: ${J({ r: bp.requirements.length, c: bp.components.length, e: bp.connections.length, l: bp.layers.length, i: bp.items.length, d: bp.decisions.length })}`);
  const done = await view(), runs = (await app.board.view()).runs;
  if (!done.tasks.filter(task => order.some(entry => entry.id === task.id)).every(task => task.completion?.kind === 'merged')) throw new Error('Not every card was merged.');
  if (!runs.some(run => run.baseManifest?.supplied?.some(entry => entry.resourceId === skill.id))) throw new Error('The Base skill was not supplied to a run.');
  const log = execFileSync('git', ['log', '--format=%s', '-3'], { cwd: checkout, encoding: 'utf8' });
  if (!['Orders schema', 'Checkout API', 'Checkout page'].every(title => log.includes(title))) throw new Error(`Merges missing on the target branch:\n${log}`);
  const exceptions = browser.consoleMessages.filter(message => message.startsWith('EXCEPTION')); if (exceptions.length) throw new Error(exceptions.join('\n'));
  if (preview) await writeFile(join(preview, 'storyboards.json'), J(storyboards, null, 2));
  console.log('Verified: a saved and linked Origin blueprint, four applied research suggestions, three Origin cards merged in order, and Base delivery to a run.');
} finally {
  await browser?.close(); await app?.close(); await rm(work, { recursive: true, force: true });
}
