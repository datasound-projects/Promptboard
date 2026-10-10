import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Board } from '../src/board.mjs';
import { normalizePipelineAutomations } from '../src/pipeline-config.mjs';
import { customPipelineConfig } from './helpers/pipeline.mjs';
import { Supervisor } from '../src/supervisor.mjs';
import { NativeMessageDispatch } from '../src/native-message-dispatch.mjs';
import { NativeMessageScheduler } from '../src/native-message-scheduler.mjs';
import { PipelineAutomations } from '../src/pipeline-automations.mjs';

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
  const config = customPipelineConfig(); config.columns[2].strategy.agentOverride = 'claude';
  config.columns.find(column => column.id === 'code_review').automations.onEnter = [{ id: 'configured-review',
    name: 'Configured review', type: 'send_message', enabled: true, mode: 'deferred', message: 'Review {{taskNumber}} {{title}} 雪' }];
  await board.setPipeline(project.id, { pipeline: config, expectedRevision: 3, confirm: true });
  const resource = await board.base.create({ kind: 'skill', name: 'Literal Base', enabled: true, trust: 'trusted', content: { body: 'BASE_MESSAGE_LITERAL' }, configuration: {} });
  await board.base.apply({ changes: [{ target: { scope: 'project', projectId: project.id }, binding: { mode: 'extend', include: [{ resourceId: resource.id, required: true }], exclude: [] } }], expectedBaseRevision: (await board.state()).base.revision });
  const prompt = '  Exact Composer <literal>\r\nbody  ';
  const task = await board.createTask({ projectId: project.id, title: 'Split Composer task', prompt }); assert.equal((await board.state()).runs.length, 0);
  const started = await board.transition(task.id, { column: 'executing', expectedRevision: task.revision });
  const session = await untilSession();
  async function untilSession() { await until(() => board.executor.sessions.get(started.run.id)?.activity?.snapshot().ready && board.executor.sessions.get(started.run.id).terminalInput.snapshot().bracketedPaste === true); return board.executor.sessions.get(started.run.id); }
  const grants = [], deliveries = [];
  const dispatch = new NativeMessageDispatch({ journal: board.automationJournal, supervisor: board.executor }); t.after(() => dispatch.shutdown());
  for (const [index, message] of ['  Review 😀\n' + 'literal '.repeat(170), 'Then test this task\n'].entries()) {
    const current = (await board.state()).projects.find(row => row.id === project.id), key = { projectId: project.id, taskId: task.id, transitionId: `pty-${index}` };
    const scope = { provider: 'claude', sessionId: started.run.sessionId, runId: started.run.id, mode: 'deferred', messageHash: createHash('sha256').update(message).digest('hex') };
    const journal = board.automationJournal, { move } = await journal.beginMove({ ...key, taskRevision: current.tasks[0].revision, projectRevision: current.revision,
      from: { id: 'todo', name: 'To Do' }, to: { id: 'executing', name: 'Executing' }, onEnter: [{ id: 'message', name: 'Literal message', enabled: true, type: 'send_message', mode: 'deferred', message }] });
    await journal.advance(key); await journal.startLifecycle(key); await journal.finishLifecycle(key, { status: 'succeeded' });
    const actionId = move.actions[0].id; await journal.startAction(key, actionId); await journal.scheduleMessage(key, actionId, scope); await journal.advance(key);
    const result = await dispatch.deliver({ key, actionId, message, scope }, { timeoutMs: 7000, preflight: async () => {
      const run = await board.run(started.run.id); return run.sessionId === scope.sessionId && run.config.provider === scope.provider && run.taskId === task.id;
    } });
    assert.equal(result.confirmed, true); const receipt = (await journal.read(key)).actions[0].delivery;
    assert.equal(receipt.status, 'confirmed'); assert.ok(receipt.submittedAt <= receipt.finishedAt); assert.equal(receipt.acceptedAt, undefined);
    grants.push(scope); deliveries.push(message); await untilSession();
  }
  // Exercise the private scheduler independently before the actual configured
  // Board transition below.
  const schedulerRows = normalizePipelineAutomations({ onEnter: [{ id: 'scheduled-message', name: 'Scheduled review', enabled: true,
    type: 'send_message', mode: 'deferred', message: '  Scheduled review {{title}} 😀\n' }] }).onEnter;
  const schedulingBoard = { state: async () => {
    const state = structuredClone(await board.state());
    state.projects.find(row => row.id === project.id).pipeline.columns.find(row => row.id === 'executing').automations.onEnter = schedulerRows;
    return state;
  } };
  const scheduler = new NativeMessageScheduler({ board: schedulingBoard, journal: board.automationJournal, supervisor: board.executor });
  t.after(() => scheduler.shutdown());
  const coordinator = new PipelineAutomations({ journal: board.automationJournal,
    scheduleEnterMessage: (request, options) => scheduler.schedule({ ...request, runId: started.run.id }, options) });
  t.after(() => coordinator.shutdown());
  const schedulingState = await schedulingBoard.state(), schedulingProject = schedulingState.projects.find(row => row.id === project.id);
  const schedulingTask = schedulingProject.tasks.find(row => row.id === task.id), schedulingKey = { projectId: project.id, taskId: task.id, transitionId: 'pty-scheduled' };
  const journal = board.automationJournal, scheduledMove = await journal.beginMove({ ...schedulingKey,
    taskRevision: schedulingTask.revision, projectRevision: schedulingProject.revision, from: { id: 'todo', name: 'To Do' },
    to: { id: 'executing', name: 'Executing' }, onEnter: schedulerRows });
  await journal.advance(schedulingKey); await journal.startLifecycle(schedulingKey); await journal.finishLifecycle(schedulingKey, { status: 'succeeded' });
  const scheduledGroup = await coordinator.runGroup({ key: schedulingKey, trigger: 'enter', rows: schedulerRows,
    context: { task: schedulingTask, project: schedulingProject } });
  assert.equal(scheduledGroup.safeToAdvance, true); assert.equal(scheduledGroup.outcomes[0].status, 'scheduled');
  await journal.advance(schedulingKey); assert.equal((await journal.read(schedulingKey)).status, 'completed');
  assert.equal((await scheduler.wait(schedulingKey, scheduledMove.move.actions[0].id)).confirmed, true);
  assert.equal((await journal.read(schedulingKey)).actions[0].delivery.status, 'confirmed');
  deliveries.push('  Scheduled review Split Composer task 😀\n'); await untilSession();
  t.after(() => board.shutdownAutomations());
  const moved = await board.transition(task.id, { column: 'code_review', expectedRevision: (await board.state()).projects[0].tasks[0].revision });
  assert.equal(moved.continuedRunId, started.run.id); assert.equal(moved.automationMove.status, 'completed');
  await until(async () => !(await board.state()).projects[0].tasks[0].pendingAutomationMessages?.length);
  assert.equal((await board.automationJournal.read({ projectId: project.id, taskId: task.id, transitionId: moved.automationMove.transitionId })).actions[0].delivery.status, 'confirmed');
  deliveries.push('Review #1 Split Composer task 雪'); await untilSession();
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
