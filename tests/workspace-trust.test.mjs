// Opt-in Workspace trust: a CLI's folder-trust menu is answered only when positively identified for this exact task
// worktree, after it settles. The screens are those of Claude Code 2.1 and Codex CLI 0.160 captured on a real terminal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supportsWorkspaceTrust, WorkspaceTrust } from '../src/workspace-trust.mjs';
import { buildSession, resolveConfig } from '../src/agents.mjs';
import { Board } from '../src/board.mjs';
import { Supervisor } from '../src/supervisor.mjs';
import { defaultPipelineConfig } from '../src/pipeline-config.mjs';

const path = '/private/tmp/promptboard/worktrees/project-1/0c05101c-cbf4-47d0-a7c1-d0e01ea0c86d';
const claude = selected => `\x1b[2J\x1b[H${'─'.repeat(120)}\r\n Accessing workspace:\r\n ${path}\r\n Quick safety check: Is this a project you created or one you trust?\r\n`
  + ` Claude Code'll be able to read, edit, and execute files here.\r\n Security guide\r\n ${selected === 'no' ? '❯' : ' '} No, exit\r\n ${selected === 'yes' ? '❯' : ' '} Yes, I trust this folder\r\n Enter to confirm · Esc to cancel\r\n`;
const codex = (selected, folder = path) => `\x1b[2J\x1b[H  Folder access\r\n  ${folder}\r\n  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.\r\n`
  + `${selected === 'yes' ? '›' : ' '} 1. Trust and continue\r\n${selected === 'no' ? '›' : ' '} 2. Quit\r\n  enter continue · esc quit\r\n`;
const update = '\x1b[2J\x1b[H  Update available · 0.160.0 → 0.162.0\r\n› 1. Update now (runs `npm install -g @openai/codex`)\r\n  2. Skip\r\n  3. Skip until next version\r\n  enter continue · esc skip\r\n';
const daemon = '\x1b[2J\x1b[H  Background server has incompatible feature settings\r\n  1. Run without daemon this time\r\n  2. Restart with these settings\r\n› 3. Cancel\r\n';
const reader = (t, provider, folder = path) => { const value = new WorkspaceTrust(provider, folder); t.after(() => value.close()); return value; };

test('the folder-trust menu is answered only for this worktree, only once settled, and a reset to No is never confirmed', async t => {
  assert.equal(supportsWorkspaceTrust('gemini'), false, 'Gemini has no recognized menu: its questions stay with the person.');
  // Claude preselects "No, exit": one Down, then Enter on a settled Yes.
  let r = reader(t, 'claude'), screen = claude('no');
  assert.equal(await r.observe(screen, 0), null);
  assert.equal(await r.observe(screen, 999), null, 'Not settled yet.');
  assert.equal(await r.observe(screen, 1000), 'down');
  assert.equal(await r.observe(screen, 2500), null, 'Navigation is never repeated against a stale screen.');
  screen += claude('yes'); await r.observe(screen, 2600);
  assert.equal(await r.observe(screen, 3600), 'confirm');
  assert.equal(await r.observe(screen, 9000), null, 'Confirmation happens once.');
  // Codex preselects "Trust and continue": Enter on the settled menu.
  r = reader(t, 'codex'); screen = codex('yes'); await r.observe(screen, 0);
  assert.equal(await r.observe(screen, 1000), 'confirm');
  r = reader(t, 'codex'); screen = codex('no'); await r.observe(screen, 0);
  assert.equal(await r.observe(screen, 1000), 'up');
  // Another folder, an update offer (its default runs npm install) or a daemon question are never answered.
  for (const [provider, other] of [['codex', codex('yes', '/Users/someone/elsewhere')], ['codex', update], ['codex', daemon], ['claude', codex('yes')]]) {
    r = reader(t, provider); await r.observe(other, 0);
    assert.equal(await r.observe(other, 5000), null, other.slice(0, 60));
  }
  // A reset to No after the Down key is never confirmed.
  r = reader(t, 'claude'); screen = claude('no'); await r.observe(screen, 0); assert.equal(await r.observe(screen, 1000), 'down');
  screen += claude('yes') + claude('no'); await r.observe(screen, 1100);
  assert.equal(await r.observe(screen, 10000), null);
  // Rewritten or oversized history blocks the reader.
  r = reader(t, 'codex'); await r.observe(codex('yes'), 0);
  assert.equal(await r.observe('different start', 2000), null); assert.equal(r.phase, 'blocked');
});

test('autonomous Codex sessions skip its update offer and shared background server; other sessions keep their flags', async t => {
  const runDir = await realpath(await mkdtemp(join(tmpdir(), 'pb-trust-args-'))); t.after(() => rm(runDir, { recursive: true, force: true }));
  const build = interaction => buildSession({ provider: 'codex', stage: 'executing', config: resolveConfig('executing', { provider: 'codex', pipeline: true, stageEngine: true, interaction, filesystem: 'workspace_write', trustWorkspace: true }), message: 'x', runDir, eventsFile: join(runDir, 'e'), sessionId: 's' });
  const autonomous = (await build('autonomous')).args, ask = (await build('ask')).args;
  assert.ok(autonomous.includes('check_for_update_on_startup=false')); assert.deepEqual(autonomous.slice(autonomous.indexOf('--disable'), autonomous.indexOf('--disable') + 2), ['--disable', 'daemon_auto_start']);
  assert.ok(!ask.includes('check_for_update_on_startup=false') && !ask.includes('--disable'));
  assert.equal(resolveConfig('executing', { provider: 'codex', pipeline: true, interaction: 'ask', filesystem: 'workspace_write', trustWorkspace: true }).trustWorkspace, true);
});

test('with Workspace trust on, a typed column passes the CLI’s folder-trust menu by itself; with it off the run waits for the person', { skip: process.platform === 'win32', timeout: 90000 }, async t => {
  const fake = fileURLToPath(new URL('./fixtures/fake-agent.cjs', import.meta.url));
  const temp = async prefix => { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return dir; };
  const until = async (fn, label, ms = 20000) => { const end = Date.now() + ms; for (;;) { const value = await fn(); if (value) return value; if (Date.now() > end) assert.fail(`Timed out: ${label}`); await new Promise(r => setTimeout(r, 50)); } };
  const bin = await temp('pb-trust-bin-');
  for (const name of ['claude', 'codex']) { await writeFile(join(bin, name), `#!${process.execPath}\nrequire(${JSON.stringify(fake)});\n`); await chmod(join(bin, name), 0o755); }
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  const root = await temp('pb-trust-repo-'), git = (...args) => execFileSync('git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-q', '-b', 'trunk'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'Tester');
  await writeFile(join(root, 'a.txt'), 'a\n'); git('add', '.'); git('commit', '-q', '-m', 'init');
  const dataDir = await temp('pb-trust-data-'), board = new Board({ dataDir }), supervisor = new Supervisor({ board, dataDir }); board.executor = supervisor;
  t.after(async () => { await supervisor.shutdown(500); process.env.PATH = oldPath; });
  const project = await board.createProject({ name: 'Trust', workflowMode: 'pipeline' });
  await board.linkRepository(project.id, { path: root, expectedRevision: project.revision });
  const now = async () => (await board.state()).projects[0];
  await board.setTargetBranch(project.id, { branch: 'trunk', expectedRevision: (await now()).revision });
  const config = defaultPipelineConfig(); config.columns.find(column => column.id === 'executing').strategy.agentOverride = 'codex';
  config.columns.find(column => column.id === 'planning').strategy.agentOverride = 'claude';
  await board.setPipeline(project.id, { pipeline: config, expectedRevision: (await now()).revision });
  const card = async id => (await now()).tasks.find(task => task.id === id);
  // Off (default): the menu stays up and nothing is typed.
  const waiting = await board.createTask({ projectId: project.id, title: 'Asks first', prompt: 'TRUST_SCREEN WRITE_FILE:b.txt' });
  const blocked = (await board.transition(waiting.id, { column: 'executing', expectedRevision: (await card(waiting.id)).revision })).run;
  await new Promise(resolve => setTimeout(resolve, 3000));
  let run = await board.run(blocked.id);
  assert.equal(run.turnComplete, undefined); assert.notEqual(run.lifecycle, 'workspace-trusted');
  assert.match(await supervisor.artifact(blocked.id, 'output'), /Trust this folder\?/);
  await board.pauseRun(blocked.id, { confirm: true });
  // On: Codex (Trust preselected) and Claude (No preselected) both pass their menus and do the stage.
  await board.setExecutionPolicy(project.id, { policy: { workspaceTrust: 'task_workspaces' }, expectedRevision: (await now()).revision });
  const trusted = await board.createTask({ projectId: project.id, title: 'Trusted', prompt: 'TRUST_SCREEN WRITE_FILE:c.txt' });
  const planning = (await board.transition(trusted.id, { column: 'planning', expectedRevision: (await card(trusted.id)).revision })).run;
  run = await until(async () => { const value = await board.run(planning.id); return value.turnComplete && value.activity?.ready && value; }, 'Claude planned after its trust menu');
  assert.equal(run.lifecycle !== 'initial-input-not-ready', true);
  const executing = (await board.transition(trusted.id, { column: 'executing', expectedRevision: (await card(trusted.id)).revision })).run;
  await until(async () => { const value = await board.run(executing.id); return value.turnComplete && value.activity?.ready; }, 'Codex executed after its trust menu');
  assert.match(await supervisor.artifact(executing.id, 'output'), /trusted/);
});
