// The MVP pipeline end to end through the real app (startServer) and its default local worker, with the fake headless
// Claude Code and Codex CLIs (tests/fixtures/fake-headless-cli.mjs) as the only programs on PATH besides node: two research
// steps that provably run at the same time (a barrier in the fake CLI only opens when both have started) → join → reviewer
// → approval → saved report. Live statuses come through the events stream; the approval waits, also across a restart;
// cancel and an app stop in the middle of a run end the CLIs' process groups and start nothing again; every step is one
// job (no duplicates); every event type of the three wave-A lanes reaches the journal; nothing touches Git, the board or
// state.json. No real CLI, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { chmod, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { startServer } from '../src/server.mjs';

const skip = process.platform === 'win32'; // The fakes are scripts with a shebang line.
const bin = await mkdtemp(join(tmpdir(), 'pb-network-e2e-bin-'));
for (const name of ['claude', 'codex']) {
  await writeFile(join(bin, name), `#!${process.execPath}\nimport ${JSON.stringify(new URL('./fixtures/fake-headless-cli.mjs', import.meta.url).href)};\n`);
  await chmod(join(bin, name), 0o700);
}
await writeFile(join(bin, 'package.json'), '{"type":"module"}');
await symlink(process.execPath, join(bin, 'node'));
process.env.PATH = bin; // Only the fakes and node: no real CLI and no git can be found.
process.on('exit', () => rmSync(bin, { recursive: true, force: true }));

const hex = text => createHash('sha256').update(text).digest('hex');
const N = name => `n_${hex(`step:${name}`).slice(0, 12)}`;
const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, ms = 20000) {
  for (const end = Date.now() + ms; Date.now() < end; await tick()) { const value = await check(); if (value) return value; }
  assert.fail(`timed out: ${label}`);
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function files(dir, skipTop = []) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  const rows = await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => { const path = join(entry.parentPath, entry.name); return [relative(dir, path), hex(await readFile(path))]; }));
  return Object.fromEntries(rows.filter(([path]) => !skipTop.includes(path.split(sep)[0])));
}
/** The NDJSON event stream from `after`, read as it arrives (the same route the Activity page follows). */
function follow(url, token, after) {
  const controller = new AbortController(), events = [];
  let live = false;
  const reading = (async () => {
    const response = await fetch(`${url}/api/network/events/stream?after=${after}`, { headers: { 'X-STE-Token': token }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let end; (end = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(end + 1)) {
        const item = JSON.parse(buffer.slice(0, end));
        if (item.live) live = true; else if (Number.isSafeInteger(item.seq)) events.push(item);
      }
    }
  })().catch(() => {}); // Stopped, or the app closed: the events read so far are what the test checks.
  return { events, live: () => live, last: () => events.at(-1)?.seq ?? after, stop: async () => { controller.abort(); await reading; } };
}

test('the MVP pipeline runs end to end on the real worker: parallel research, join, reviewer, approval across a restart, saved report; cancel and an app stop behave; one job per step; every event type is journaled; no Git, board or state.json change', { skip, timeout: 240000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-network-e2e-')), logs = await mkdtemp(join(tmpdir(), 'pb-network-e2e-log-'));
  t.after(() => Promise.all([dataDir, logs].map(dir => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))));
  process.env.FAKE_HEADLESS_LOG = logs;
  let app = null, token = null;
  const boot = async () => {
    app = await startServer({ port: 0, dataDir, executor: null, catalogReader: async provider => ({ provider, source: 'test fixture', models: [] }) }); // networkWorker unset: the app's own LocalJobWorker
    token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  };
  t.after(() => app?.close());
  await boot();
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, json: await response.json() };
  };
  const ok = async (pending, label, status = 200) => { const response = await pending; assert.equal(response.status, status, `${label}: ${JSON.stringify(response.json)}`); return response.json; };
  const cliRuns = async () => Promise.all((await readdir(logs)).filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(logs, name), 'utf8'))));
  const runPath = id => `/api/network/pipeline-runs/${id}`;
  const runOf = async id => (await ok(call(runPath(id)), 'run')).run;
  const stepJobs = async id => (await ok(call(`/api/network/jobs?pipelineRunId=${id}&limit=200`), 'step jobs')).jobs;
  assert.equal((await ok(call('/api/network/settings'), 'settings')).worker, true, 'the real worker is the default');

  // Three Base agents (Claude, Codex at low effort, Claude), registered and members of the published network "Desk".
  for (const [id, agent] of [['research-a', { provider: 'claude', model: 'haiku' }], ['research-b', { provider: 'codex', effort: 'low' }], ['reviewer', { provider: 'claude', model: 'haiku' }]]) {
    await app.board.base.create({ id, kind: 'profile', name: id, configuration: { agent } });
  }
  const agents = {};
  for (const id of ['research-a', 'research-b', 'reviewer']) {
    const { revision } = await ok(call('/api/network/agents'), 'agents');
    agents[id] = (await ok(call('/api/network/agents', 'POST', { baseResourceId: id, expectedRevision: revision }), 'register')).agent;
  }
  const { network } = await ok(call('/api/network/networks', 'POST', { name: 'Desk', nodes: Object.values(agents).map((agent, i) => ({ id: N(`member${i}`), type: 'agent', agentId: agent.id, position: { x: i * 200, y: 0 } })), edges: [] }), 'network');
  await ok(call(`/api/network/networks/${network.id}/publish`, 'POST', { expectedRevision: network.revision }), 'publish network');

  // Nothing outside network/ may change from here on (the app's instance lock records its port, so it is left out).
  const outside = await files(dataDir, ['network', 'instance.lock']), stateBytes = await readFile(join(dataDir, 'state.json'), 'utf8').catch(() => null), boardView = async () => JSON.stringify({ ...(await app.board.view()), instance: null }), boardBefore = await boardView(); // instance: this process's ID
  const spawned = [], originals = { spawn: childProcess.spawn, execFile: childProcess.execFile };
  for (const name of Object.keys(originals)) childProcess[name] = function (...args) { spawned.push(String(args[0])); return originals[name].apply(this, args); };
  syncBuiltinESMExports();
  t.after(() => { Object.assign(childProcess, originals); syncBuiltinESMExports(); });

  // The MVP pipeline: both research steps carry a barrier, so each CLI waits until the other has started too.
  const step = (name, type, config, label) => ({ id: N(name), type, label, position: { x: 0, y: 0 }, config });
  const edge = (from, to, fromPort) => ({ id: `e_${hex(`${from}>${to}`).slice(0, 12)}`, from: N(from), to: N(to), fromPort });
  const definition = {
    nodes: [step('a', 'agent', { agentId: agents['research-a'].id, instructions: 'Research the market. [[barrier:research:2]]' }, 'Research A'),
      step('b', 'agent', { agentId: agents['research-b'].id, instructions: 'Research the competitors. [[barrier:research:2]]' }, 'Research B'),
      step('join', 'join', { require: 'all' }, 'Join'), step('review', 'agent', { agentId: agents.reviewer.id, instructions: 'Review both reports.' }, 'Review'),
      step('approve', 'approval', { prompt: 'Save the report?' }, 'Approve'), step('report', 'output', { name: 'report', include: [N('a'), N('b'), N('review')] }, 'Report')],
    edges: [edge('a', 'join', 'text'), edge('b', 'join', 'text'), edge('join', 'review', 'done'), edge('review', 'approve', 'text'), edge('join', 'approve', 'done'), edge('approve', 'report', 'done')],
  };
  const { pipeline } = await ok(call('/api/network/pipelines', 'POST', { networkId: network.id, networkVersion: 1, name: 'Market report', ...definition }), 'create pipeline');
  await ok(call(`/api/network/pipelines/${pipeline.id}/publish`, 'POST', { expectedRevision: pipeline.revision }), 'publish pipeline');
  assert.deepEqual([(await ok(call('/api/network/jobs'), 'jobs')).total, (await cliRuns()).length], [0, 0], 'saving and publishing ran nothing');

  // Run 1, followed live through the events stream.
  let stream = follow(app.url, token, (await ok(call('/api/network/events?limit=1'), 'last event')).last);
  await until(() => stream.live(), 'the stream is live');
  const run1 = (await ok(call(`/api/network/pipelines/${pipeline.id}/runs`, 'POST', { version: 1, confirm: true, input: { text: 'Electric bikes in Europe.' } }), 'start', 202)).runId;
  const heard = (type, status, extra = {}) => stream.events.find(event => event.type === type && event.status === status && Object.entries(extra).every(([key, value]) => event[key] === value));
  await until(() => heard('pipeline.run', 'waiting_for_approval', { pipelineRunId: run1 }), 'the stream says the run waits for the approval');
  let run = await runOf(run1);
  assert.equal(run.status, 'waiting_for_approval');
  const jobs1 = await stepJobs(run1), byNode = Object.fromEntries(jobs1.map(job => [job.nodeId, job]));
  assert.deepEqual(jobs1.map(job => [job.nodeId, job.status]).sort(), [[N('a'), 'completed'], [N('b'), 'completed'], [N('review'), 'completed']].sort());
  // True parallelism: neither research CLI got past the barrier until the other had started, and both completed. The
  // stream shows the same: both research jobs were running before either completed.
  const research = (await cliRuns()).filter(entry => entry.input.includes('[[barrier:research:2]]'));
  assert.deepEqual(research.map(entry => entry.cli).sort(), ['claude', 'codex']);
  const at = (jobId, status) => heard('job.status', status, { jobId })?.seq;
  assert.ok(Math.max(at(byNode[N('a')].id, 'running'), at(byNode[N('b')].id, 'running')) < Math.min(at(byNode[N('a')].id, 'completed'), at(byNode[N('b')].id, 'completed')), 'both research jobs ran at the same time');
  assert.ok(at(byNode[N('review')].id, 'queued') > Math.max(at(byNode[N('a')].id, 'completed'), at(byNode[N('b')].id, 'completed')), 'the reviewer waited for the join');
  // The reviewer got both results, indented as data, and the run input.
  const reviewInput = (await ok(call(`/api/network/jobs/${byNode[N('review')].id}`), 'review job')).request.input.text;
  assert.match(reviewInput, /Run input:\n {2}Electric bikes in Europe\./);
  assert.match(reviewInput, /Result of step “Research A” \(n_[0-9a-f]{12}\):\n {2}Answer from claude\./);
  assert.match(reviewInput, /Result of step “Research B” \(n_[0-9a-f]{12}\):\n {2}Answer from codex\./);

  // The approval waits: nothing more runs and no report is saved, also after the app restarts.
  const runDir = join(dataDir, 'network', 'pipeline-runs', `run__${run1.slice(4)}`);
  await tick(2500); // More than two passes of the runner (every second).
  assert.deepEqual([(await runOf(run1)).status, (await cliRuns()).length, (await readdir(runDir)).includes('reports')], ['waiting_for_approval', 3, false]);
  await stream.stop();
  const before = stream.events;
  await app.close(); app = null;
  await boot();
  stream = follow(app.url, token, before.at(-1).seq);
  await until(() => stream.live(), 'the stream is live again');
  await tick(2500);
  assert.deepEqual([(await runOf(run1)).status, (await cliRuns()).length, (await stepJobs(run1)).length], ['waiting_for_approval', 3, 3], 'still waiting after the restart; nothing ran again');
  assert.equal((await call(`${runPath(run1)}/nodes/${N('review')}/approve`, 'POST', { decision: 'approve' })).json.code, 'STEP_STATE', 'only the approval step takes a decision');
  await ok(call(`${runPath(run1)}/nodes/${N('approve')}/approve`, 'POST', { decision: 'approve' }), 'approve');
  await until(() => heard('pipeline.run', 'completed', { pipelineRunId: run1 }), 'the stream says the run completed');
  run = await runOf(run1);
  const report = await readFile(join(runDir, 'reports', 'report.md'), 'utf8');
  assert.equal(report, '# Market report\n\n## Research A\n\nAnswer from claude.\n\n## Research B\n\nAnswer from codex.\n\n## Review\n\nAnswer from claude.\n');
  assert.deepEqual([run.status, run.nodes[N('report')].result.text.sha256, run.nodes[N('approve')].approval.decision], ['completed', hex(report), 'approved']);
  assert.deepEqual(run.history.map(entry => entry.status), ['running', 'waiting_for_approval', 'running', 'completed']);
  // One job per step, each with its own key; three CLI runs in all.
  const final1 = await stepJobs(run1);
  assert.deepEqual([final1.length, new Set(final1.map(job => job.idempotencyKey)).size, (await cliRuns()).length], [3, 3, 3]);
  for (const job of final1) assert.equal(job.idempotencyKey, `run:${run1}:node:${job.nodeId}:a1`);

  // Every wave-A event type reached the journal for this run, and the stream gave each of them once, in order.
  const journal = (await ok(call(`/api/network/events?after=0&limit=200&pipelineRunId=${run1}`), 'journal')).events;
  const streamed = [...before, ...stream.events].filter(event => event.pipelineRunId === run1);
  assert.deepEqual(streamed.map(event => event.seq), journal.map(event => event.seq), 'the stream gave every event of the run once');
  assert.deepEqual([...new Set(journal.map(event => event.type))].sort(), ['job.activity', 'job.status', 'pipeline.node', 'pipeline.run']);
  assert.deepEqual(journal.filter(event => event.type === 'pipeline.run').map(event => event.status), ['running', 'waiting_for_approval', 'running', 'completed']);
  for (const job of final1) {
    assert.deepEqual(journal.filter(event => event.type === 'job.status' && event.jobId === job.id).map(event => [event.status, event.nodeId]), ['queued', 'preparing', 'running', 'completed'].map(status => [status, job.nodeId]));
    const activity = journal.filter(event => event.type === 'job.activity' && event.jobId === job.id);
    assert.ok(activity.length >= 2, `${job.nodeId} reported activity`);
    for (const event of activity) assert.deepEqual([event.nodeId, typeof event.kind, event.agentId], [job.nodeId, 'string', job.agentId], 'activity carries its kind and its step');
    assert.deepEqual(activity.map(event => event.kind).slice(0, 2), ['status', 'text'], 'started, then writing the answer');
    assert.ok(journal.some(event => event.type === 'pipeline.node' && event.nodeId === job.nodeId && event.jobId === job.id && event.status === 'completed'), 'the step event names its job');
  }
  assert.ok(journal.every(event => !JSON.stringify(event).includes('Answer from') && !JSON.stringify(event).includes('Electric bikes')), 'no result or input text in an event');
  await stream.stop();

  // Run 2: cancelled while both research CLIs run; their process groups end and nothing after them starts.
  const run2 = (await ok(call(`/api/network/pipelines/${pipeline.id}/runs`, 'POST', { version: 1, confirm: true, input: { text: 'Cancel me. [[hang]]' } }), 'start 2', 202)).runId;
  await until(async () => (await stepJobs(run2)).filter(job => job.status === 'running').length === 2, 'both research steps of run 2 run');
  const hung2 = await until(async () => { const found = (await cliRuns()).filter(entry => entry.input.includes('Cancel me.')); return found.length === 2 && found; }, 'run 2 CLIs');
  const cancelled = await ok(call(`${runPath(run2)}/cancel`, 'POST', {}), 'cancel');
  assert.deepEqual([cancelled.run.status, cancelled.run.nodes[N('a')].status, cancelled.run.nodes[N('review')].status], ['cancelled', 'cancelled', 'cancelled']);
  for (const entry of hung2) await until(() => !alive(entry.pid) && !alive(entry.helper), `${entry.cli} of run 2 gone`);
  await until(async () => (await stepJobs(run2)).every(job => job.status === 'cancelled'), 'run 2 jobs cancelled');
  await tick(1500);
  assert.deepEqual([(await stepJobs(run2)).length, (await cliRuns()).length, (await runOf(run2)).status], [2, 5, 'cancelled'], 'no reviewer, no new job after the cancel');

  // Run 3: the app stops while both research CLIs run. Their groups end, the jobs are interrupted (uncertain), and after the
  // restart the run is blocked on them: nothing is started again until the owner decides.
  const run3 = (await ok(call(`/api/network/pipelines/${pipeline.id}/runs`, 'POST', { version: 1, confirm: true, input: { text: 'Stop the app. [[hang]]' } }), 'start 3', 202)).runId;
  await until(async () => (await stepJobs(run3)).filter(job => job.status === 'running').length === 2, 'both research steps of run 3 run');
  const hung3 = await until(async () => { const found = (await cliRuns()).filter(entry => entry.input.includes('Stop the app.')); return found.length === 2 && found; }, 'run 3 CLIs');
  await app.close(); app = null;
  for (const entry of hung3) await until(() => !alive(entry.pid) && !alive(entry.helper), `${entry.cli} of run 3 gone after the app stopped`);
  await boot();
  run = await until(async () => { const value = await runOf(run3); return value.status === 'blocked' && value; }, 'run 3 blocked after the restart');
  assert.deepEqual([N('a'), N('b')].map(id => [run.nodes[id].status, run.nodes[id].errorCode]), [['blocked', 'APP_STOPPED'], ['blocked', 'APP_STOPPED']]);
  assert.match(run.nodes[N('a')].reason, /Retry the job \(confirming it\) or close it/);
  assert.deepEqual((await stepJobs(run3)).map(job => [job.status, job.outcome]), [['interrupted', 'uncertain'], ['interrupted', 'uncertain']]);
  await tick(2500);
  assert.deepEqual([(await stepJobs(run3)).length, (await cliRuns()).length, (await runOf(run3)).status], [2, 7, 'blocked'], 'nothing resubmitted or relaunched');
  await ok(call(`${runPath(run3)}/cancel`, 'POST', {}), 'cancel the blocked run');
  assert.equal((await runOf(run3)).status, 'cancelled');

  // Only the fake CLIs ever started (never git), and nothing outside network/ changed: not the board, not state.json.
  assert.deepEqual([...new Set(spawned.map(command => relative(bin, command)))].sort(), ['claude', 'codex'], `started: ${spawned.join(', ')}`);
  assert.deepEqual(await files(dataDir, ['network', 'instance.lock']), outside);
  assert.equal(await readFile(join(dataDir, 'state.json'), 'utf8').catch(() => null), stateBytes);
  assert.equal(await boardView(), boardBefore);
});
