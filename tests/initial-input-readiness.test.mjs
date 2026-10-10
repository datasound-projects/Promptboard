import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARGV_PROMPT_LIMIT } from '../src/agents.mjs';
import { Supervisor } from '../src/supervisor.mjs';

const prompt = 'Long task. ' + 'x'.repeat(ARGV_PROMPT_LIMIT), paste = `\x1b[200~${prompt}\x1b[201~`;
const idle = () => new Promise(resolve => setImmediate(resolve));

// A prompt too long for argv through the real launch path. The PTY and board are controlled seams:
// no provider, process or network. Call t.mock.timers.enable({ apis: ['setTimeout'] }) first.
async function launch(t, provider) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-input-ready-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const writes = [], updates = [];
  let output, exit;
  const pty = { spawn: () => ({ pid: 2147483000, onData(cb) { output = cb; }, onExit(cb) { exit = cb; }, write: data => { writes.push(data === paste ? 'PASTE' : data); }, resize() {} }) };
  const run = { id: `ready-${provider}`, sessionId: 'logical', status: 'queued', taskId: 't', artifactsDir: `runs/ready-${provider}`, stage: 'executing', workspacePath: dataDir,
    config: { provider, permissionMode: 'acceptEdits', pipeline: true }, baseManifest: { resources: [] } };
  const board = { state: async () => ({ settings: { maxConcurrentRuns: 1 }, base: { resources: [], approvedRoots: [] }, sessions: [] }),
    run: async () => structuredClone(run), recordBaseManifest: async () => {},
    updateRun: async (_id, change) => { updates.push(structuredClone(change)); Object.assign(run, change); return structuredClone(run); } };
  const supervisor = new Supervisor({ board, dataDir, ptyLoader: async () => ({ pty, message: '' }), resolver: async () => ({ command: provider, prefix: [] }),
    basePreparer: async () => ({ sections: '', manifest: { resources: [] }, cleanup: async () => {} }) });
  await supervisor.start({ run, task: { prompt }, firstPrompt: prompt });
  for (let i = 0; i < 5000 && !supervisor.sessions.get(run.id)?.poll; i++) await idle();
  const session = supervisor.sessions.get(run.id);
  assert.ok(session?.paste && session.poll, 'The long prompt waits for terminal paste.');
  t.after(async () => { exit({ exitCode: 0 }); await session.exited; });
  const emit = async event => { await appendFile(session.eventsFile, JSON.stringify({ provider, ...event }) + '\n'); await supervisor.sendNativeMessage(run.id, {}); };
  const ready = () => provider === 'codex' ? output('\x1b]0;thread-1\x07') : emit({ name: 'SessionStart', sessionId: session.sessionId });
  const initialInput = () => session.ring.map(({ item }) => item.initialInput).filter(Boolean);
  return { run, session, writes, updates, output, emit, ready, initialInput };
}

test('a Codex long prompt is never pasted on a timer alone, nor while its title asks a question', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = await launch(t, 'codex');
  t.mock.timers.tick(20000); // Past the old blind paste at 15 s, which could answer a folder-trust question.
  assert.deepEqual(w.writes, []);
  w.output('\x1b]0;[ ! ] Action Required | thread-1\x07'); t.mock.timers.tick(5000);
  assert.deepEqual(w.writes, [], 'A title asking for an answer is a question, not readiness.');
});

test('a Codex long prompt is pasted and submitted once after the first terminal title', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = await launch(t, 'codex');
  w.output('starting\r\n'); t.mock.timers.tick(1800); assert.deepEqual(w.writes, [], 'Output without a title is not readiness.');
  await w.ready(); t.mock.timers.tick(1499); assert.deepEqual(w.writes, []);
  t.mock.timers.tick(1); assert.deepEqual(w.writes, ['PASTE']);
  t.mock.timers.tick(300); assert.deepEqual(w.writes, ['PASTE', '\r']);
  await w.ready(); t.mock.timers.tick(120000);
  assert.deepEqual(w.writes, ['PASTE', '\r'], 'Exactly one paste and Enter.');
  assert.ok(!w.updates.some(row => row.lifecycle === 'initial-input-not-ready'));
});

test('a Claude long prompt waits for the main SessionStart, then is pasted and submitted once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = await launch(t, 'claude');
  t.mock.timers.tick(20000); assert.deepEqual(w.writes, []);
  await w.emit({ name: 'SessionStart', sessionId: 'child-native', agentId: 'child' }); t.mock.timers.tick(5000);
  assert.deepEqual(w.writes, [], 'A subordinate start is not the main session.');
  await w.ready(); t.mock.timers.tick(1500); t.mock.timers.tick(300);
  assert.deepEqual(w.writes, ['PASTE', '\r']);
  await w.ready(); t.mock.timers.tick(120000);
  assert.deepEqual(w.writes, ['PASTE', '\r'], 'Another start cannot paste again.');
});

test('no readiness sign by the deadline reports CLI_INPUT_NOT_READY without typing; a later sign still pastes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const provider of ['codex', 'claude']) {
    const w = await launch(t, provider);
    t.mock.timers.tick(59999); assert.ok(!w.updates.some(row => row.lifecycle === 'initial-input-not-ready'), provider);
    t.mock.timers.tick(1); t.mock.timers.tick(600000);
    assert.deepEqual(w.writes, [], `${provider}: nothing is typed without a sign`);
    const report = w.updates.find(row => row.lifecycle === 'initial-input-not-ready');
    assert.equal(report?.errorCode, 'CLI_INPUT_NOT_READY', provider); assert.equal(report.turnComplete, false); assert.match(report.waitingReason, /startup question/);
    assert.equal(w.run.status, 'running', 'The run stays alive for the terminal.');
    assert.deepEqual(w.initialInput(), [{ status: 'not-ready', code: 'CLI_INPUT_NOT_READY', reason: report.waitingReason }]);
    await w.ready(); t.mock.timers.tick(1500); t.mock.timers.tick(300);
    assert.deepEqual(w.writes, ['PASTE', '\r'], `${provider}: a late sign is still positive`);
    assert.equal(w.run.errorCode, ''); assert.equal(w.run.lifecycle, 'events-received'); assert.equal(w.run.waitingReason, '');
    assert.deepEqual(w.initialInput().at(-1), { status: 'ready' });
  }
});
