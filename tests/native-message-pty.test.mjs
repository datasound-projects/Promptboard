import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Board } from '../src/board.mjs';
import { defaultPipelineConfig } from '../src/pipeline-config.mjs';
import { Supervisor } from '../src/supervisor.mjs';

async function temp(t) { const path = await realpath(await mkdtemp(join(tmpdir(), 'pb-native-message-pty-'))); t.after(() => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return path; }
async function until(fn) { const deadline = Date.now() + 10000; for (;;) { if (await fn()) return; if (Date.now() > deadline) assert.fail('The offline native message fixture did not become ready.'); await new Promise(resolve => setTimeout(resolve, 50)); } }
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } });

test('private deferred transport uses a real owned PTY and exact native receipts without repeating Composer/Base or changing CLI tools', { skip: process.platform === 'win32' }, async t => {
  const dataDir = await temp(t), root = await temp(t), report = join(await temp(t), 'messages.jsonl');
  git(root, 'init', '-q', '-b', 'trunk'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.test');
  await writeFile(join(root, 'README.md'), 'Disposable checkout\n'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'Fixture');
  const previous = process.env.FAKE_NATIVE_MESSAGE_REPORT; process.env.FAKE_NATIVE_MESSAGE_REPORT = report;
  t.after(() => { if (previous === undefined) delete process.env.FAKE_NATIVE_MESSAGE_REPORT; else process.env.FAKE_NATIVE_MESSAGE_REPORT = previous; });
  const board = new Board({ dataDir }), fixture = fileURLToPath(new URL('./fixtures/fake-native-message.cjs', import.meta.url));
  board.executor = new Supervisor({ board, dataDir, resolver: async () => ({ command: process.execPath, prefix: [fixture] }) });
  t.after(() => board.executor.shutdown(500));
  const project = await board.createProject({ name: 'Native transport' });
  await board.linkRepository(project.id, { path: root, expectedRevision: 1 }); await board.setTargetBranch(project.id, { branch: 'trunk', expectedRevision: 2 });
  const config = defaultPipelineConfig(); config.columns[2].strategy.agentOverride = 'claude';
  await board.setPipeline(project.id, { pipeline: config, expectedRevision: 3, confirm: true });
  const resource = await board.base.create({ kind: 'skill', name: 'Literal Base', enabled: true, trust: 'trusted', content: { body: 'BASE_MESSAGE_LITERAL' }, configuration: {} });
  await board.base.apply({ changes: [{ target: { scope: 'project', projectId: project.id }, binding: { mode: 'extend', include: [{ resourceId: resource.id, required: true }], exclude: [] } }], expectedBaseRevision: (await board.state()).base.revision });
  const prompt = '  Exact Composer <literal>\r\nbody  ';
  const task = await board.createTask({ projectId: project.id, title: 'Split Composer task', prompt }); assert.equal((await board.state()).runs.length, 0);
  const started = await board.transition(task.id, { column: 'executing', expectedRevision: task.revision });
  const session = await untilSession();
  async function untilSession() { await until(() => board.executor.sessions.get(started.run.id)?.activity?.snapshot().ready && board.executor.sessions.get(started.run.id).terminalInput.snapshot().bracketedPaste === true); return board.executor.sessions.get(started.run.id); }
  const grants = [], deliveries = [];
  for (const [index, message] of ['  Review 😀\n' + 'literal '.repeat(170), 'Then test this task\n'].entries()) {
    const result = await board.executor.sendNativeMessage(started.run.id, { dispatchId: `pty-${index}`, mode: 'deferred', message, timeoutMs: 7000,
      grant: async scope => { grants.push(scope); return true; }, submitted: async () => true, accepted: async () => { assert.fail('This fixture records native turns, not queue acceptance.'); } });
    assert.deepEqual(result, { status: 'confirmed', confirmed: true }); deliveries.push(message); await untilSession();
  }
  const rows = (await readFile(report, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row => row.kind === 'initial').length, 1); assert.deepEqual(rows.filter(row => row.kind === 'submitted').map(row => row.text), deliveries);
  assert.ok(rows[0].text.includes('BASE_MESSAGE_LITERAL')); assert.ok(rows[0].text.includes('Exact Composer &lt;literal&gt;'));
  assert.ok(!rows[0].args.includes('--strict-mcp-config')); assert.ok(!rows[0].args.includes('--tools')); assert.ok(!rows[0].args.includes('--disallowedTools'));
  assert.equal(grants.length, 2); assert.equal(grants[0].sessionId, started.run.sessionId);
  assert.equal(session.terminalInput.snapshot().manualInputObserved, false);
  const state = await board.state(); assert.equal(state.projects.find(row => row.id === project.id).tasks.find(row => row.id === task.id).prompt, prompt);
  assert.doesNotMatch(JSON.stringify(await board.view()), /nativeHistoryPath|messageLifecycleEpoch|manualInputObserved/);
  const enabled = structuredClone(config); enabled.columns[2].automations.onEnter.push({ id: 'still-pending', type: 'send_message', name: 'Review', message: 'Review', enabled: true });
  await assert.rejects(board.setPipeline(project.id, { pipeline: enabled, expectedRevision: state.projects.find(row => row.id === project.id).revision, confirm: true }), { code: 'PIPELINE_FEATURE_PENDING' });
});
