#!/usr/bin/env node
/**
 * Records the two README demos with headless Chrome and ffmpeg:
 *   docs/compose-demo.gif  Compose: a rough request → engineered prompt → Split into tasks (about 10 s)
 *   docs/kanban-demo.gif   Kanban: the split cards run through Autopilot from To Do to Done (about 15 s)
 * The model and the agents are SIMULATED (a fixed Compose answer and tests/fixtures/fake-agent.cjs), so the
 * demo is reproducible and costs nothing. Everything else is the real app: server, board, Git, worktrees.
 *   node scripts/record-demo.mjs
 */
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../tests/helpers/browser.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const work = await mkdtemp(join(tmpdir(), 'pb-demo-'));
const bin = join(work, 'bin');
await mkdir(bin);
await writeFile(join(bin, 'claude'), `#!${process.execPath}\nrequire(${JSON.stringify(join(root, 'tests/fixtures/fake-agent.cjs'))});\n`);
await chmod(join(bin, 'claude'), 0o755);
Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, FAKE_AGENT_WRITE: '1', GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.invalid', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.invalid' });
const { startServer } = await import('../src/server.mjs');

const REQUEST = 'add login to the shop app. use the existing `src/auth.ts`, rate limit to 5 tries per minute, and write the API docs. no new dependencies';
const PROMPT = `# Goal
Add login to the shop app.

# Constraints
- Use the existing \`src/auth.ts\`.
- Limit login attempts to 5 per minute for each user.
- Do not add a new dependency.

# Work
1. Inspect \`src/auth.ts\` and the current routes.
2. Add the login route and connect it to \`src/auth.ts\`.
3. Add the rate limit.
4. Write the API documentation for the login route.

# Acceptance checks
- A correct login returns a session.
- The sixth attempt within one minute is refused.`;
const TASKS = [
  { title: 'Add the login route', prompt: 'Add a login route to the shop app. Use the existing `src/auth.ts`. Do not add a new dependency. A correct login returns a session.' },
  { title: 'Rate-limit login attempts', prompt: 'Limit login attempts to 5 per minute for each user. Do not add a new dependency. The sixth attempt within one minute is refused.' },
  { title: 'Write the login API docs', prompt: 'Write the API documentation for the login route that uses `src/auth.ts`, including the limit of 5 attempts per minute.' },
];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const runner = async ({ prompt }) => {
  await pause(prompt.startsWith('# Task split') ? 1500 : 2200);
  return { text: prompt.startsWith('# Task split') ? JSON.stringify({ tasks: TASKS }) : PROMPT, reportedModels: ['claude-haiku-4-5'] };
};
const catalog = { provider: 'claude', source: 'cli', defaultModel: 'claude-haiku-4-5', defaultEffort: '', note: 'Models reported by your installed CLI.', models: [{ id: 'claude-haiku-4-5', name: 'Haiku 4.5', efforts: ['low', 'medium', 'high'] }, { id: 'claude-opus-5-5', name: 'Opus 5.5', efforts: ['low', 'medium', 'high'] }] };
const app = await startServer({ port: 0, dataDir: join(work, 'data'), projectsDir: join(work, 'projects'), runner,
  detector: async () => [{ id: 'claude', name: 'Claude Code', available: true, version: 'demo' }, { id: 'codex', name: 'Codex CLI', available: false }, { id: 'gemini', name: 'Gemini CLI', available: false }, { id: 'agy', name: 'Antigravity CLI', available: false }],
  catalogReader: async () => catalog, authAdapter: { installed: async () => true, status: async () => ({ state: 'signed-in', method: 'subscription' }), login: async () => ({}), logout: async () => ({}) } });
const browser = await launch({ width: 1600, height: 900 });
if (!browser) throw new Error('Chrome was not found.');
await browser.resize(1600, 900);

/** Capture frames while `scene` runs; then make a looping GIF that lasts `seconds`. */
async function record(name, seconds, scene) {
  const dir = join(work, name);
  await mkdir(dir);
  const frames = [], writes = [];
  // The screencast pushes a frame whenever the page changes, which is far cheaper than screenshots.
  const stop = browser.on(message => {
    if (message.method !== 'Page.screencastFrame') return;
    const file = join(dir, `${String(frames.length).padStart(5, '0')}.jpg`);
    frames.push({ file, at: Date.now() });
    writes.push(writeFile(file, Buffer.from(message.params.data, 'base64')));
    browser.send('Page.screencastFrameAck', { sessionId: message.params.sessionId }).catch(() => {});
  });
  await browser.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 1600, maxHeight: 900, everyNthFrame: 1 });
  // A still page sends no frames: a slow heartbeat keeps the timeline complete.
  let recording = true;
  const heartbeat = (async () => { while (recording) { await pause(700); await browser.eval('document.body.dataset.tick = String(Date.now());').catch(() => {}); } })();
  await scene();
  recording = false;
  await heartbeat;
  await browser.send('Page.stopScreencast');
  stop();
  await Promise.all(writes);
  const total = frames.at(-1).at - frames[0].at;
  const scale = seconds * 1000 / total;
  const list = frames.map((frame, index) => `file '${frame.file}'\nduration ${(((frames[index + 1]?.at ?? frame.at + 1500) - frame.at) * scale / 1000).toFixed(3)}`).join('\n') + `\nfile '${frames.at(-1).file}'\n`;
  await writeFile(join(dir, 'list.txt'), list);
  const out = join(root, 'docs', `${name}.gif`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'), '-vf', 'fps=12,scale=1000:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', '-loop', '0', out]);
  console.log(`${out}: ${frames.length} frames, ${(total / 1000).toFixed(1)} s recorded → ${seconds} s`);
}

try {
  await browser.goto(`${app.url}/#/`);
  await browser.eval(`localStorage.setItem('ste-prompt-engineer.theme', 'light'); localStorage.setItem('promptboard.settings.dock-start', 'open'); localStorage.setItem('promptboard.dock.height', '230'); localStorage.setItem('promptboard.settings.open-terminal', '0'); localStorage.setItem('promptboard.project-panel', 'collapsed');`);
  await browser.reload();
  await browser.until(`document.querySelector('#provider') && !document.querySelector('#generate-button').disabled`, 'Compose ready', 20000);
  await browser.eval(`const fast = document.querySelector('input[name="quality"][value="fast"]'); fast.click();`);

  await record('compose-demo', 10, async () => {
    await pause(600);
    await browser.eval(`document.querySelector('#prompt-input').focus();`);
    for (const word of REQUEST.split(/(?<= )/)) { await browser.eval(`const input = document.querySelector('#prompt-input'); input.value += ${JSON.stringify(word)}; input.dispatchEvent(new Event('input', { bubbles: true }));`); await pause(260); }
    await pause(400);
    await browser.eval(`document.querySelector('#generate-button').click();`);
    await browser.until(`document.querySelector('#prompt-output').textContent.includes('Acceptance checks') && !document.querySelector('#split-button').disabled`, 'prompt', 20000);
    await browser.eval(`document.querySelector('#output-heading').scrollIntoView({ block: 'start' });`);
    await pause(1600);
    await browser.eval(`document.querySelector('#split-button').click();`);
    await browser.until(`document.querySelectorAll('#split-list .split-item').length === 3`, 'split', 20000);
    await browser.eval(`document.querySelector('#split-project').value = ''; document.querySelector('#split-project').dispatchEvent(new Event('change')); document.querySelector('#split-project-name').value = 'Shop app';`);
    await pause(2200);
  });

  // Add the cards; Autopilot opens with them in order. Test commands let Promptboard's own test run decide.
  await browser.eval(`document.querySelector('#split-form').requestSubmit();`);
  await browser.until(`document.querySelector('#autopilot-dialog').open`, 'Autopilot dialog', 20000);
  let project = (await app.board.view()).projects[0];
  await app.board.delivery.setTestCommands(project.id, { commands: [{ command: `${process.execPath} -e "process.exit(0)"`, label: 'unit tests' }], expectedRevision: project.revision });
  // Show the whole route on screen: hide Planning (Column Manager) and run Executing → Code Review → Testing → Merge.
  project = (await app.board.view()).projects[0];
  await app.board.setColumns(project.id, { columns: project.columns.map(column => (column.id === 'planning' ? { id: 'planning', hidden: true } : { id: column.id })), expectedRevision: project.revision });
  project = (await app.board.view()).projects[0];
  await app.board.setAutopilot(project.id, { route: ['executing', 'code_review', 'testing', 'merge'], finish: 'merge', maxRework: 1, queue: project.tasks.map(task => task.id), expectedRevision: project.revision });
  await browser.eval(`await loadBoard(); document.querySelector('#autopilot-dialog').close(); openAutopilot({ first: currentProject().tasks.map(task => task.id) });`);
  // Zoom out so every column from To Do to Done is on screen.
  await browser.eval(`setProjectCollapsed(true); document.documentElement.style.zoom = '0.74'; localStorage.setItem('promptboard.dock.height', '200'); window.PromptboardDock?.setState('open');`);
  await browser.eval(`document.querySelector('.kanban-board').scrollIntoView({ block: 'start' });`);

  await record('kanban-demo', 15, async () => {
    await pause(1200);
    await browser.eval(`document.querySelector('#autopilot-consent').checked = true; document.querySelector('#autopilot-form').requestSubmit();`);
    await browser.until(`!document.querySelector('#autopilot-dialog').open || !document.querySelector('#autopilot-error').hidden`, 'Autopilot started', 20000);
    const error = await browser.eval(`return document.querySelector('#autopilot-dialog').open ? document.querySelector('#autopilot-error').textContent : '';`);
    if (error) throw new Error(`Autopilot did not start: ${error}`);
    for (const end = Date.now() + 240000; ;) {
      const view = await app.board.view();
      const ap = view.projects[0].autopilot || {};
      if (ap.status === 'finished') break;
      if (ap.status === 'paused') throw new Error(`Autopilot paused: ${ap.reason}`);
      if (Date.now() > end) throw new Error('Autopilot did not finish in time.');
      await browser.eval(`await loadBoard(); document.querySelector('.kanban-columns')?.scrollTo({ left: 0 });`).catch(() => {});
      await pause(400);
    }
    await browser.eval(`await loadBoard();`);
    await pause(2500);
  });
  const done = (await app.board.view()).projects[0].tasks.filter(task => task.column === 'done').length;
  console.log(`Cards in Done: ${done} of ${TASKS.length}`);
} finally {
  await browser.close();
  await app.close();
  await rm(work, { recursive: true, force: true });
}
