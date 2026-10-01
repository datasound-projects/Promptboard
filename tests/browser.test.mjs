// Real-browser terminal smoke test (PB-03). Uses headless Chrome through the DevTools
// protocol and fake agent CLIs (SIMULATED providers). Skips when Chrome is not installed.
// Screenshots are written to PB_BROWSER_SHOTS when that variable is set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, launch } from './helpers/browser.mjs';
import { startServer } from '../src/server.mjs';

const fake = fileURLToPath(new URL('./fixtures/fake-agent.cjs', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
const chrome = await findChrome();
const skip = process.platform === 'win32' || !chrome ? 'Chrome is not installed or the platform has no PTY support in this test.' : false;

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
  await browser.eval(`[...document.querySelectorAll('.kanban-card')].find(card => card.textContent.includes('Second task')).querySelector('.kanban-start').click();`);
  await browser.until(`window.promptboardDock.sessions.size === 2`, 'second session tab', 30000);
  const secondRun = (await board.view()).runs.find(run => run.taskId === second.id).id;
  await browser.until(`${text(secondRun)}.includes('working on')`, 'second output');
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
  assert.equal(await browser.eval(`const prompt = document.querySelector('#dock-stop-prompt').getBoundingClientRect(); const dock = document.querySelector('#dock').getBoundingClientRect(); return prompt.top >= dock.top && prompt.bottom <= window.innerHeight;`), true, 'Collapsing during confirmation does not hide Stop below the viewport.');
  await browser.eval(`[...document.querySelectorAll('#dock-stop-prompt button')].find(button => button.textContent === 'Stop this agent').click();`);
  for (let i = 0; i < 100 && (await board.run(firstRun)).status !== 'cancelled'; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await board.run(firstRun)).status, 'cancelled');
  assert.ok(['running', 'waiting_for_input'].includes((await board.run(secondRun)).status), 'Stopping one session leaves the other running.');
  await shot('4-stopped-one');
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
  assert.equal(await browser.eval(`const terminal = document.querySelector('#dock-panel-${codexRun.id}').getBoundingClientRect(); const status = document.querySelector('#dock-connection').getBoundingClientRect(); return terminal.top >= status.bottom && terminal.height > 50;`), true, 'Run facts and connection feedback do not cover the terminal.');
  const paths = await browser.eval(`return document.querySelector('[data-id="${codexTask.id}"] .task-location').textContent;`);
  assert.ok(paths.includes(codexRun.branch)); assert.ok(paths.includes(codexRun.workspacePath));
  await browser.until(`document.querySelector('#kanban-columns').getBoundingClientRect().bottom <= document.querySelector('#dock').getBoundingClientRect().top + 1`, 'board fits above terminal');
  const boardHeight = await browser.eval(`return document.querySelector('#kanban-columns').getBoundingClientRect().height;`);
  await browser.eval(`document.querySelector('#dock-divider').focus();`);
  await browser.key('ArrowUp', 'ArrowUp', 38);
  await browser.until(`document.querySelector('#kanban-columns').getBoundingClientRect().height < ${boardHeight}`, 'board adjusts to terminal resizing');
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
  assert.equal(await browser.eval(`const bar = document.querySelector('#dock .dock-bar').getBoundingClientRect(); const dock = document.querySelector('#dock').getBoundingClientRect(); return bar.top >= dock.top && bar.bottom <= window.innerHeight;`), true, 'The wrapped phone tab bar fits when collapsed.');
  await browser.eval(`document.querySelector('#dock-toggle').click();`);
  await browser.until(`document.querySelector('#dock-panel-${codexRun.id}').getBoundingClientRect().height > 75`, 'readable narrow terminal');
  assert.equal(await browser.eval(`return document.documentElement.scrollWidth <= window.innerWidth;`), true, 'Narrow page has no horizontal overflow outside the board.');
  assert.equal(await browser.eval(`return [...document.querySelectorAll('#board-actions button')].filter(button => !button.hidden).every(button => { const r = button.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth; });`), true, 'Every narrow toolbar action is visible, including New card.');
  await browser.until(`document.querySelector('#kanban-columns').getBoundingClientRect().bottom <= document.querySelector('#dock').getBoundingClientRect().top + 1`, 'narrow board fits above terminal');
  await browser.until(`(() => { const tab = document.querySelector('#dock-tab-${codexRun.id}').getBoundingClientRect(); const tabs = document.querySelector('#dock-tabs').getBoundingClientRect(); return tab.right <= tabs.right + 1 && tab.left >= tabs.left - 1; })()`, 'selected agent stays visible after resizing');
  await shot('7-codex-narrow');
  const errors = browser.consoleMessages.filter(message => /EXCEPTION/.test(message));
  assert.deepEqual(errors, [], 'No uncaught page errors.');
});
