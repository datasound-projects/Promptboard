import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Supervisor } from '../src/supervisor.mjs';
import { SessionActivity } from '../src/session-activity.mjs';
import { TerminalInputObservation } from '../src/terminal-input-observation.mjs';

const nativeId = '11111111-2222-3333-4444-555555555555';
const user = (provider, text, id = 'new-user') => provider === 'claude'
  ? { type: 'user', sessionId: nativeId, message: { role: 'user', content: text } }
  : provider === 'codex' ? { type: 'event_msg', payload: { type: 'user_message', message: text } }
    : { id, type: 'user', content: [{ text }] };
async function fixture(t, provider = 'claude', { historyAt = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pb-native-custody-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const eventsFile = join(dir, 'events.jsonl'), writes = [], updates = [], startedAt = Date.now();
  let path = join(dir, provider === 'claude' ? `${nativeId}.jsonl` : `session-fixture.jsonl`);
  if (provider === 'codex') {
    const previousHome = process.env.CODEX_HOME; process.env.CODEX_HOME = dir;
    t.after(() => { if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome; });
    const date = new Date(historyAt ?? startedAt), parts = [String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')], day = join(dir, 'sessions', ...parts);
    await mkdir(day, { recursive: true }); path = join(day, `rollout-${parts.join('-')}T00-00-00-${nativeId}.jsonl`);
  }
  const first = provider === 'claude' ? user(provider, 'Original task') : provider === 'codex'
    ? { type: 'session_meta', payload: { id: nativeId, source: 'cli' } } : { sessionId: nativeId, kind: 'main' };
  await writeFile(path, JSON.stringify(first) + '\n');
  await writeFile(eventsFile, JSON.stringify({ provider, name: provider === 'codex' ? 'agent-turn-complete' : 'SessionStart',
    sessionId: nativeId, transcriptPath: path }) + '\n');
  const run = { id: 'receipt-run', sessionId: 'logical-receipt', config: { provider, pipeline: true }, status: 'running' };
  const board = { run: async () => structuredClone(run), updateRun: async (_id, change) => { updates.push(structuredClone(change)); Object.assign(run, change); return structuredClone(run); } };
  const supervisor = new Supervisor({ board, dataDir: dir });
  // A controlled PTY seam, with no real provider, process, timer or network call.
  const session = { runId: run.id, provider, pipeline: true, proc: { write: data => writes.push(data) }, inputEpoch: 0,
    sessionId: nativeId, eventsFile, eventsOffset: 0, startedAt, runDir: dir, activity: new SessionActivity(provider),
    terminalInput: new TerminalInputObservation(), status: 'running', turns: 0, seq: 0, ring: [], ringBytes: 0, subscribers: new Set() };
  session.terminalInput.observeOutput('\x1b[?2004h');
  supervisor.sessions.set(run.id, session);
  // The owned transport drains lifecycle hooks first, then refuses this empty request without input.
  const drain = () => supervisor.sendNativeMessage(run.id, {});
  const emit = event => appendFile(eventsFile, JSON.stringify({ provider, ...event }) + '\n');
  let messageNumber = 0;
  const append = text => appendFile(path, JSON.stringify(user(provider, text, `new-user-${++messageNumber}`)) + '\n');
  return { supervisor, session, path, dir, writes, updates, run, emit, append, drain };
}

test('the owned transport takes main Claude/Gemini hook transcripts and the exact Codex rollout as receipt history', async t => {
  for (const provider of ['claude', 'gemini', 'codex']) {
    // An older resumed Codex conversation is located by its exact native thread metadata.
    const w = await fixture(t, provider, provider === 'codex' ? { historyAt: Date.UTC(2025, 0, 2) } : {}), message = '  literal message\nwith whitespace  ';
    // A subordinate start reports another transcript; it can never redirect the main history.
    if (provider !== 'codex') await w.emit({ name: 'SessionStart', sessionId: 'child-native', agentId: 'child', transcriptPath: join(w.dir, 'child.jsonl') });
    await w.emit({ name: provider === 'claude' ? 'Stop' : provider === 'gemini' ? 'AfterAgent' : 'agent-turn-complete', sessionId: nativeId });
    let buffer = '', recorded;
    w.session.proc.write = data => { w.writes.push(data); if (data !== '\r') buffer += data; else recorded = w.append(buffer.slice(6, -6)); };
    const result = await w.supervisor.sendNativeMessage(w.run.id, { dispatchId: 'history', message, mode: 'deferred', timeoutMs: 10000,
      grant: async () => true, submitted: async () => { await recorded; return true; }, accepted: async () => true });
    assert.deepEqual(result, { status: 'confirmed', confirmed: true }, provider);
    assert.equal(w.writes.at(-1), '\r'); assert.equal(w.writes.slice(0, -1).join(''), '\x1b[200~' + message + '\x1b[201~');
    assert.doesNotMatch(JSON.stringify(w.updates), /transcriptPath|nativeHistoryPath|rollout-|literal message/);
  }
});

test('human input before initial paste consumes the automatic attempt before startup or its delayed timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const timing of ['before-startup', 'after-startup']) for (const pipeline of [true, false]) {
    const w = await fixture(t); w.session.paste = 'Private initial envelope';
    if (timing === 'after-startup') await w.drain();
    if (!pipeline) { w.session.pipeline = false; delete w.session.activity; }
    w.supervisor.input(w.run.id, 'human partial draft');
    assert.equal(w.session.paste, null);
    if (!pipeline) w.session.pipeline = true;
    await w.drain(); t.mock.timers.tick(20000);
    await w.emit({ name: 'SessionStart', sessionId: nativeId, transcriptPath: w.path });
    await w.drain(); t.mock.timers.tick(20000);
    assert.deepEqual(w.writes, ['human partial draft']);
    assert.ok(w.updates.some(row => row.lifecycle === 'initial-input-unconfirmed'));
    assert.doesNotMatch(JSON.stringify(w.updates), /Private initial envelope|human partial draft/);
  }
});

test('failed human transport before initial paste cannot restore automatic input ownership', async t => {
  const w = await fixture(t); t.mock.timers.enable({ apis: ['setTimeout'] });
  w.session.paste = 'Private initial envelope'; await w.drain();
  const attempts = []; w.session.proc.write = text => { attempts.push(text); throw new Error('PRIVATE HUMAN TRANSPORT'); };
  assert.throws(() => w.supervisor.input(w.run.id, 'human draft'), /PRIVATE HUMAN TRANSPORT/);
  assert.equal(w.session.paste, null); t.mock.timers.tick(20000);
  await w.emit({ name: 'SessionStart', sessionId: nativeId, transcriptPath: w.path });
  await w.drain(); t.mock.timers.tick(20000);
  assert.deepEqual(attempts, ['human draft']);
  assert.doesNotMatch(JSON.stringify(w.updates), /PRIVATE HUMAN TRANSPORT|Private initial envelope|human draft/);
});

test('empty or rejected human input does not consume the unchanged initial paste', async t => {
  const w = await fixture(t); t.mock.timers.enable({ apis: ['setTimeout'] });
  w.session.paste = 'Exact envelope'; await w.drain();
  w.supervisor.input(w.run.id, '');
  assert.throws(() => w.supervisor.input(w.run.id, null), { code: 'INPUT_TOO_LARGE' });
  assert.throws(() => w.supervisor.input(w.run.id, 'x'.repeat(65537)), { code: 'INPUT_TOO_LARGE' });
  t.mock.timers.tick(1500); t.mock.timers.tick(300);
  assert.deepEqual(w.writes, ['', '\x1b[200~Exact envelope\x1b[201~', '\r']);
  assert.ok(!w.updates.some(row => row.lifecycle === 'initial-input-unconfirmed'));
});

test('initial prompt submission cannot press Enter after a human draft changes the owned input epoch', async t => {
  const w = await fixture(t); t.mock.timers.enable({ apis: ['setTimeout'] });
  w.session.paste = 'Initial long prompt'; await w.drain();
  t.mock.timers.tick(1500); assert.deepEqual(w.writes, ['\x1b[200~Initial long prompt\x1b[201~']);
  w.supervisor.input(w.run.id, 'human draft'); t.mock.timers.tick(300);
  assert.deepEqual(w.writes, ['\x1b[200~Initial long prompt\x1b[201~', 'human draft']);
});

test('delayed initial paste and submission never write to stopped, failed or replaced owners', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const invalidate of [w => { w.session.cancelled = true; }, w => { w.session.failure = {}; }, w => { w.supervisor.stopping = true; }, w => { w.session.exiting = true; }, w => { w.session.confirmed = true; }, w => { w.session.activity.ended = true; }, w => { w.session.activity.uncertain = true; }, w => { w.supervisor.sessions.delete(w.run.id); }]) {
    const w = await fixture(t); w.session.paste = 'Original initial prompt'; await w.drain();
    invalidate(w); t.mock.timers.tick(1800); assert.deepEqual(w.writes, []);
  }
  const w = await fixture(t); w.session.paste = 'Owned initial prompt'; await w.drain(); t.mock.timers.tick(1500);
  const replacement = []; w.session.proc = { write: data => replacement.push(data) }; t.mock.timers.tick(300);
  assert.deepEqual(replacement, []); assert.deepEqual(w.writes, ['\x1b[200~Owned initial prompt\x1b[201~']);
});

test('initial paste transport failures are unconfirmed, contained and never retried by another startup event', async t => {
  const w = await fixture(t); t.mock.timers.enable({ apis: ['setTimeout'] }); let attempts = 0;
  w.session.paste = 'Private initial envelope'; w.session.proc.write = () => { attempts++; throw new Error('PRIVATE TRANSPORT'); };
  await w.drain(); assert.doesNotThrow(() => t.mock.timers.tick(1500));
  await Promise.resolve(); assert.equal(attempts, 1); assert.equal(w.session.paste, null);
  await w.emit({ name: 'SessionStart', sessionId: nativeId, transcriptPath: w.path }); await w.drain(); t.mock.timers.tick(20000);
  assert.equal(attempts, 1); assert.doesNotMatch(JSON.stringify(w.updates), /PRIVATE TRANSPORT|Private initial envelope/);
});

test('a pending initial submission holds native message input, then submits exactly once to its unchanged owner', async t => {
  const w = await fixture(t); t.mock.timers.enable({ apis: ['setTimeout'] });
  const settled = () => w.session.activity.observe({ name: 'Stop' }, Date.now() - 2000);
  w.session.paste = 'Exact initial envelope'; await w.drain(); t.mock.timers.tick(1500);
  settled(); assert.equal(w.supervisor.nativeMessageReadiness(w.run.id), 'waiting', 'A pending Enter holds native input.');
  await w.drain(); t.mock.timers.tick(300); assert.deepEqual(w.writes, ['\x1b[200~Exact initial envelope\x1b[201~', '\r']);
  settled(); assert.equal(w.supervisor.nativeMessageReadiness(w.run.id), 'ready'); t.mock.timers.tick(20000);
  assert.deepEqual(w.writes, ['\x1b[200~Exact initial envelope\x1b[201~', '\r']);
});

test('a changed main native identity or lifecycle cannot submit the old initial envelope', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const change of ['identity', 'startup', 'partial-events']) {
    const w = await fixture(t); w.session.paste = 'Old envelope'; await w.drain(); t.mock.timers.tick(1500);
    if (change === 'identity') w.session.nativeSessionId = '66666666-7777-8888-9999-000000000000';
    else if (change === 'partial-events') w.session.eventsPending = true;
    else { await w.emit({ name: 'SessionStart', sessionId: nativeId, transcriptPath: w.path }); await w.drain(); }
    t.mock.timers.tick(300); assert.deepEqual(w.writes, ['\x1b[200~Old envelope\x1b[201~']);
  }
});

test('initial Enter transport failures retain uncertainty without another write or raw diagnostic', async t => {
  const w = await fixture(t); t.mock.timers.enable({ apis: ['setTimeout'] }); let attempts = 0;
  w.session.paste = 'Literal envelope'; w.session.proc.write = text => { attempts++; if (text === '\r') throw new Error('PRIVATE ENTER FAILURE'); w.writes.push(text); };
  await w.drain(); t.mock.timers.tick(1500); assert.doesNotThrow(() => t.mock.timers.tick(300));
  assert.equal(attempts, 2); assert.equal(w.session.activity.uncertain, true); await Promise.resolve();
  assert.match(w.updates.at(-1).waitingReason, /not confirmed/); assert.doesNotMatch(JSON.stringify(w.updates), /PRIVATE ENTER FAILURE|Literal envelope/);
  await w.emit({ name: 'SessionStart', sessionId: nativeId, transcriptPath: w.path }); await w.drain(); t.mock.timers.tick(20000);
  assert.equal(attempts, 2);
});

test('a later native Stop cannot turn an unknown initial write into automatic-advancement evidence', async t => {
  const w = await fixture(t); t.mock.timers.enable({ apis: ['setTimeout'] });
  w.session.paste = 'Unknown initial text'; await w.drain();
  w.session.proc.write = () => { throw new Error('UNKNOWN BYTES'); };
  t.mock.timers.tick(1500); await w.emit({ name: 'Stop', sessionId: nativeId, message: 'Some turn finished.' });
  await w.drain();
  assert.equal(w.run.turnComplete, false); assert.equal(w.run.activity.ready, false); assert.equal(w.run.status, 'waiting_for_input'); assert.match(w.run.waitingReason, /automatic advancement is blocked/);
  assert.doesNotMatch(JSON.stringify(w.updates), /UNKNOWN BYTES|Unknown initial text/);
});

test('reentrant human input during a paste cannot re-acquire pending Enter ownership', async t => {
  const w = await fixture(t); t.mock.timers.enable({ apis: ['setTimeout'] }); w.session.paste = 'Owned initial text';
  w.session.proc.write = data => { w.writes.push(data); if (data.startsWith('\x1b[200~')) w.supervisor.input(w.run.id, 'human draft'); };
  await w.drain(); t.mock.timers.tick(1500); assert.equal(w.session.initialSubmitPending, false); t.mock.timers.tick(300);
  assert.deepEqual(w.writes, ['\x1b[200~Owned initial text\x1b[201~', 'human draft']); assert.match(w.run.waitingReason, /submission was cancelled/);
});
