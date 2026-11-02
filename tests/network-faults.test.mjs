// Task 14 fault injection (docs/network/acceptance.md §6): the cases the task tests did not reach yet. (1) A crash after
// every durable write of a pipeline run and its step jobs: the Network folder is copied after each atomic rename of a run,
// and the app is restarted on each copy. (2) Power loss and damaged files: every Network file of a finished scenario is
// torn (cut in half), replaced by garbage, removed (its .bak kept), saved by a newer version, or left beside a stray
// temporary file; journal segments are deleted or garbage. (3) Revocation of a machine client, an inbound A2A caller and a
// Base agent around running and queued jobs. (4) On the real worker with the fake CLIs: a Base agent changed between submit
// and claim, unknown provider output and a failed tool, a missing or signed-out CLI, and shutdown with hung jobs. The
// invariant everywhere: no unauthorized run, no replay, no silent data loss. Jobs run on the deterministic fake worker
// unless a test says otherwise. No real CLI, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import fsp, { mkdtemp, readdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { startServer } from '../src/server.mjs';
import { fakeWorker } from './helpers/network-worker.mjs';
import { fixture, request, until } from './helpers/network-machine.mjs';

const hex = text => createHash('sha256').update(text).digest('hex');
const N = name => `n_${hex(`step:${name}`).slice(0, 12)}`;
const step = (name, type, config, label) => ({ id: N(name), type, label, position: { x: 0, y: 0 }, config });
const edge = (from, to, fromPort) => ({ id: `e_${hex(`${from}>${to}`).slice(0, 12)}`, from: N(from), to: N(to), fromPort });
const catalogReader = async provider => ({ provider, source: 'test fixture', models: [] });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Every file under `dir` (relative path → bytes), skipping `skip(relativePath)`. */
function tree(dir, skip = () => false) {
  const out = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = relative(dir, join(entry.parentPath, entry.name));
    if (!skip(path)) out[path.split(sep).join('/')] = readFileSync(join(entry.parentPath, entry.name));
  }
  return out;
}
/** Run `work(item)` over `items`, `width` at a time. */
async function pool(items, width, work) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => { while (next < items.length) await work(items[next++]); }));
}
/** An owner client for an app: `ok()` asserts the status. */
async function owner(app) {
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token, port = Number(new URL(app.url).port);
  const call = (path, method = 'GET', body) => request(port, path, { method, body, headers: { 'X-STE-Token': token } });
  const ok = async (path, method, body, status = 200) => { const answer = await call(path, method, body); assert.equal(answer.status, status, `${method || 'GET'} ${path}: ${answer.text}`); return answer.json; };
  return { call, ok };
}

/** The MVP pipeline (two parallel agent steps → join → reviewer → approval → report) on a fresh fixture, published; answers its IDs. */
async function mvp(ctx) {
  const agents = {};
  for (const id of ['lead', 'scout', 'gem']) agents[id] = await ctx.register(id);
  const { ok } = await owner(ctx.app);
  const network = (await ok('/api/network/networks', 'POST', { name: 'Desk', nodes: Object.values(agents).map((agent, i) => ({ id: N(`member${i}`), type: 'agent', agentId: agent.id, position: { x: i * 200, y: 0 } })), edges: [] })).network;
  await ok(`/api/network/networks/${network.id}/publish`, 'POST', { expectedRevision: network.revision });
  const pipeline = (await ok('/api/network/pipelines', 'POST', { networkId: network.id, networkVersion: 1, name: 'Report',
    nodes: [step('a', 'agent', { agentId: agents.lead.id, instructions: 'Research A.' }, 'Research A'), step('b', 'agent', { agentId: agents.scout.id, instructions: 'Research B.' }, 'Research B'),
      step('join', 'join', { require: 'all' }, 'Join'), step('review', 'agent', { agentId: agents.gem.id, instructions: 'Review.' }, 'Review'),
      step('approve', 'approval', { prompt: 'Save?' }, 'Approve'), step('report', 'output', { name: 'report', include: [N('a'), N('b'), N('review')] }, 'Report')],
    edges: [edge('a', 'join', 'text'), edge('b', 'join', 'text'), edge('join', 'review', 'done'), edge('review', 'approve', 'text'), edge('join', 'approve', 'done'), edge('approve', 'report', 'done')] })).pipeline;
  await ok(`/api/network/pipelines/${pipeline.id}/publish`, 'POST', { expectedRevision: pipeline.revision });
  return { agents, network, pipeline };
}

test('a crash after every durable write of a pipeline run and its step jobs: each copy restarts without a duplicate job, a relaunch, an approval nobody gave, a second report, a signalled pid or a lost record', { timeout: 300000 }, async t => {
  // A live process that stands for the CLI the fake worker reports (its own process group): after any restart it must still live.
  const stand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(stand.pid, 'SIGKILL'); } catch {} });
  const signalled = [], kill = process.kill;
  process.kill = function (pid, signal) { if (Math.abs(pid) === stand.pid && signal !== 0 && signal !== undefined) signalled.push([pid, signal]); return kill.call(this, pid, signal); };
  t.after(() => { process.kill = kill; });

  const ctx = await fixture(t, { worker: fakeWorker({ pid: stand.pid }) });
  const { pipeline } = await mvp(ctx);
  const { ok } = await owner(ctx.app);
  const networkDir = join(ctx.dataDir, 'network'), snapshots = mkdtempSync(join(tmpdir(), 'pb-network-crash-')), seen = new Set(), copies = [];
  t.after(() => rmSync(snapshots, { recursive: true, force: true }));
  // Every completed rename into network/ (writeAtomic's last step) is a state a crash can leave: copy the folder then.
  const rename = fsp.rename;
  let capturing = true;
  fsp.rename = async function (from, to) {
    const answer = await rename.call(this, from, to);
    if (capturing && String(to).startsWith(networkDir) && !String(to).endsWith('.bak')) {
      const files = tree(networkDir), print = hex(JSON.stringify(Object.entries(files).sort().map(([path, bytes]) => [path, hex(bytes)])));
      if (!seen.has(print)) { seen.add(print); const dir = join(snapshots, String(copies.length)); cpSync(networkDir, dir, { recursive: true }); copies.push({ dir, after: relative(networkDir, String(to)) }); }
    }
    return answer;
  };
  syncBuiltinESMExports();
  t.after(() => { fsp.rename = rename; syncBuiltinESMExports(); });

  const runId = (await ok(`/api/network/pipelines/${pipeline.id}/runs`, 'POST', { version: 1, confirm: true, input: { text: 'Crash me.' } }, 202)).runId;
  await until(async () => (await ok(`/api/network/pipeline-runs/${runId}`)).run.status === 'waiting_for_approval', 'the run waits', 20000);
  await ok(`/api/network/pipeline-runs/${runId}/nodes/${N('approve')}/approve`, 'POST', { decision: 'approve' });
  await until(async () => (await ok(`/api/network/pipeline-runs/${runId}`)).run.status === 'completed', 'the run completes', 20000);
  capturing = false; fsp.rename = rename; syncBuiltinESMExports();
  await ctx.app.close();
  const runFolder = `pipeline-runs/run__${runId.slice(4)}`;
  const kinds = new Set(copies.map(copy => copy.after.split(sep).join('/').replace(/[0-9a-f]{20}/g, '*').replace(/att__\*\/.*/, 'att__*/…')));
  for (const kind of ['pipeline-runs/run__*/plan.json', 'pipeline-runs/run__*/run.json', 'jobs/job__*/request.json', 'jobs/job__*/job.json', 'jobs/job__*/attempts/att__*/…', 'pipeline-runs/run__*/reports/report.md']) assert.ok(kinds.has(kind), `a copy after a write of ${kind}: ${[...kinds].join(', ')}`);
  assert.ok(copies.length >= 25, `${copies.length} crash points`);

  // The rest of the data folder (board, Base) does not change during a run: each restart gets it plus one copy of network/.
  const fixed = mkdtempSync(join(tmpdir(), 'pb-network-crash-fixed-'));
  t.after(() => rmSync(fixed, { recursive: true, force: true }));
  cpSync(ctx.dataDir, fixed, { recursive: true, filter: source => !source.startsWith(networkDir) && !source.endsWith('instance.lock') });
  const outcomes = [];
  await pool(copies, 6, async copy => {
    const before = tree(copy.dir), jobFile = Object.entries(before).filter(([path]) => /^jobs\/job__[0-9a-f]{20}\/job\.json$/.test(path)).map(([, bytes]) => JSON.parse(bytes));
    const runBytes = before[`${runFolder}/run.json`], savedRun = runBytes ? JSON.parse(runBytes) : null, savedReport = before[`${runFolder}/reports/report.md`];
    const dataDir = await mkdtemp(join(tmpdir(), 'pb-network-crash-restart-'));
    try {
      cpSync(fixed, dataDir, { recursive: true }); cpSync(copy.dir, join(dataDir, 'network'), { recursive: true });
      const worker = fakeWorker({ pid: stand.pid }), app = await startServer({ port: 0, dataDir, executor: null, networkWorker: worker, catalogReader });
      try {
        const { call, ok: sure } = await owner(app), label = `after ${copy.after}`;
        const jobsNow = async () => (await sure('/api/network/jobs?limit=200')).jobs;
        // Crash before run.json existed: the start never answered, so there is no run and nothing runs.
        if (!savedRun) {
          await new Promise(resolve => setTimeout(resolve, 1500));
          assert.deepEqual([(await call(`/api/network/pipeline-runs/${runId}`)).status, (await jobsNow()).length, worker.starts.length], [404, 0, 0], label);
          outcomes.push('no run');
          return;
        }
        const decided = savedRun.nodes[N('approve')].approval?.decision ?? null;
        let run = await until(async () => { const value = (await sure(`/api/network/pipeline-runs/${runId}`)).run; return ['waiting_for_approval', 'completed', 'blocked', 'failed', 'cancelled', 'interrupted'].includes(value.status) && value; }, `${label}: the run settles`, 20000);
        if (run.status === 'waiting_for_approval') {
          assert.equal(decided, null, `${label}: an approval saved as decided is never asked again`);
          await sure(`/api/network/pipeline-runs/${runId}/nodes/${N('approve')}/approve`, 'POST', { decision: 'approve' });
          run = await until(async () => { const value = (await sure(`/api/network/pipeline-runs/${runId}`)).run; return value.status !== 'waiting_for_approval' && value.status !== 'running' && value; }, `${label}: the run ends`, 20000);
        }
        const jobs = await jobsNow(), stepsWithJob = new Set(jobFile.map(job => job.nodeId));
        // No silent loss: every job of the copy is still there; no duplicate: one job per step.
        for (const job of jobFile) assert.ok(jobs.some(item => item.id === job.id), `${label}: job ${job.id} kept`);
        assert.equal(new Set(jobs.map(job => job.nodeId)).size, jobs.length, `${label}: one job per step`);
        assert.ok(jobs.length <= 3);
        // No replay: a job that had ended is not started again; one that may have started (claimed, launching or running) is
        // interrupted and waits for the owner; only queued jobs and steps that had no job yet run now.
        for (const job of jobFile) {
          const now = jobs.find(item => item.id === job.id);
          if (['completed', 'failed', 'cancelled'].includes(job.status)) assert.deepEqual([now.status, now.attempts.length], [job.status, job.attempts.length], `${label}: ${job.nodeId} unchanged`);
          if (['preparing', 'running'].includes(job.status)) {
            const started = Boolean(job.attempts.find(attempt => attempt.id === job.currentAttemptId)?.launchingAt);
            assert.deepEqual([now.status, now.outcome, now.attempts.length], ['interrupted', started ? 'uncertain' : 'not_started', job.attempts.length], `${label}: ${job.nodeId} interrupted, not relaunched`);
          }
        }
        const started = worker.starts.length, allowed = jobFile.filter(job => job.status === 'queued').length + jobs.filter(job => !stepsWithJob.has(job.nodeId)).length;
        assert.equal(started, allowed, `${label}: only queued jobs and new steps started`);
        const interrupted = jobs.some(job => job.status === 'interrupted');
        assert.equal(run.status, interrupted ? 'blocked' : 'completed', `${label}: ${JSON.stringify(run.nodes)}`);
        // One report, written once: bytes kept when the copy had it.
        const reports = await readdir(join(dataDir, 'network', runFolder, 'reports')).catch(() => []);
        if (run.status === 'completed') {
          assert.deepEqual(reports, ['report.md'], label);
          if (savedReport) assert.ok(savedReport.equals(await readFile(join(dataDir, 'network', runFolder, 'reports', 'report.md'))), `${label}: the saved report is unchanged`);
          assert.equal(run.nodes[N('approve')].approval.decision, 'approved');
        } else assert.deepEqual(reports, [], `${label}: no report while blocked`);
        outcomes.push(run.status);
      } finally { await app.close(); }
    } finally { await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
  t.diagnostic(`crash points: ${copies.length}; outcomes: ${JSON.stringify(Object.fromEntries([...new Set(outcomes)].map(key => [key, outcomes.filter(item => item === key).length])))}`);
  assert.ok(outcomes.includes('blocked') && outcomes.includes('completed') && outcomes.includes('no run'), 'crash points before the run, while steps ran, and after they ended');
  assert.deepEqual(signalled, [], 'no restart signalled the recorded pid');
  assert.equal(alive(stand.pid), true);
});

test('a network or pipeline draft read from its backup still knows the versions published since that backup: they stay readable and the next publish never reuses their number', async t => {
  const ctx = await fixture(t, { worker: null });
  const { network, pipeline } = await mvp(ctx);
  const { ok } = await owner(ctx.app);
  const v1 = { network: (await ok(`/api/network/networks/${network.id}/versions/1`)).version, pipeline: (await ok(`/api/network/pipelines/${pipeline.id}/versions/1`)).version };
  await ctx.app.close();
  // The publish was the last save of each draft, so each backup is the draft before it. The drafts are torn (a power loss).
  for (const path of [join('networks', `net__${network.id.slice(4)}.json`), join('pipelines', `pip__${pipeline.id.slice(4)}.json`)]) {
    const file = join(ctx.dataDir, 'network', path);
    assert.deepEqual(JSON.parse(readFileSync(`${file}.bak`, 'utf8')).publishedVersions, [], `${path}: the backup is from before the publish`);
    await truncate(file, 40);
  }
  const restarted = await fixture(t, { dataDir: ctx.dataDir, worker: null });
  const again = await owner(restarted.app);
  for (const [kind, id] of [['networks', network.id], ['pipelines', pipeline.id]]) {
    const draft = (await again.ok(`/api/network/${kind}/${id}`))[kind.slice(0, -1)];
    assert.deepEqual(draft.publishedVersions.map(item => [item.version, item.sha256]), [[1, v1[kind.slice(0, -1)].sha256]], `${kind}: v1 is still listed`);
    assert.equal((await again.ok(`/api/network/${kind}/${id}/versions/1`)).version.sha256, v1[kind.slice(0, -1)].sha256, `${kind}: v1 still reads`);
    const published = await again.ok(`/api/network/${kind}/${id}/publish`, 'POST', { expectedRevision: draft.revision });
    assert.equal(published.published.version, 2, `${kind}: the next publish is v2, not a second v1`);
  }
  assert.equal((await again.ok(`/api/network/pipelines/${pipeline.id}/validate`, 'POST', { version: 1 })).valid, true, 'pipeline v1, pinned to network v1, still compiles');
});

test('power loss and damaged files: every Network file torn, garbage, removed beside its backup, saved by a newer version, or next to a stray temporary file; journal segments torn, garbage or missing: the app starts, nothing runs, nothing is lost silently, damaged bytes are kept, Kanban keeps working', { timeout: 300000 }, async t => {
  const events = { segmentBytes: 2048 }; // Several journal segments.
  const ctx = await fixture(t, { serverOptions: { networkEventOptions: events } });
  const { pipeline } = await mvp(ctx);
  const { ok } = await owner(ctx.app);
  const runId = (await ok(`/api/network/pipelines/${pipeline.id}/runs`, 'POST', { version: 1, confirm: true, input: { text: 'Then damage it.' } }, 202)).runId;
  await until(async () => (await ok(`/api/network/pipeline-runs/${runId}`)).run.status === 'waiting_for_approval', 'the run waits', 20000);
  await ok(`/api/network/pipeline-runs/${runId}/nodes/${N('approve')}/approve`, 'POST', { decision: 'approve' });
  await until(async () => (await ok(`/api/network/pipeline-runs/${runId}`)).run.status === 'completed', 'the run completes', 20000);
  const lead = await ctx.register('lead');
  const done = (await ok('/api/network/jobs', 'POST', { agentId: lead.id, input: { text: 'An owner job.' } }, 202)).jobId;
  await until(async () => (await ok(`/api/network/jobs/${done}`)).job.status === 'completed', 'the owner job completes');
  const waiting = (await ok('/api/network/jobs', 'POST', { agentId: lead.id, input: { text: 'Waits for a yes.' }, requireApproval: true }, 202)).jobId;
  await ctx.client({ agents: [lead.id] });
  await ctx.app.close();

  // What the owner sees now: every list's IDs and every detail's answer. Results and reports keep their exact text.
  const probe = async call => {
    const lists = {}, details = {};
    for (const [name, path] of [['agents', '/api/network/agents?limit=200'], ['networks', '/api/network/networks?limit=200'], ['pipelines', '/api/network/pipelines?limit=200'], ['jobs', '/api/network/jobs?limit=200'],
      ['runs', '/api/network/pipeline-runs?limit=200'], ['clients', '/api/network/clients'], ['events', '/api/network/events?after=0&limit=200'], ['settings', '/api/network/settings']]) {
      const answer = await call(path), items = Object.values(answer.json ?? {}).find(value => Array.isArray(value) && value.every(item => item && typeof item === 'object'));
      lists[name] = { status: answer.status, ids: (items ?? []).map(item => item.id ?? item.seq), unavailable: (answer.json?.unavailable ?? []).map(item => item.id) };
    }
    return { lists, details };
  };
  const detailPaths = original => [
    ...original.lists.networks.ids.flatMap(id => [`/api/network/networks/${id}`, `/api/network/networks/${id}/versions/1`]),
    ...original.lists.pipelines.ids.flatMap(id => [`/api/network/pipelines/${id}`, `/api/network/pipelines/${id}/versions/1`]),
    ...original.lists.jobs.ids.flatMap(id => [`/api/network/jobs/${id}`, `/api/network/jobs/${id}/result`]),
    `/api/network/pipeline-runs/${runId}`, `/api/network/pipeline-runs/${runId}/nodes/${N('report')}/report`];
  const start = async dataDir => {
    const worker = fakeWorker(), app = await startServer({ port: 0, dataDir, executor: null, networkWorker: worker, catalogReader, networkEventOptions: events });
    return { worker, app, ...(await owner(app)) };
  };
  const first = await start(ctx.dataDir);
  const original = await probe(first.call), originalDetails = {};
  for (const path of detailPaths(original)) { const answer = await first.call(path); originalDetails[path] = { status: answer.status, text: answer.json?.text ?? answer.json?.report?.text ?? null }; }
  await first.app.close();
  assert.ok(original.lists.jobs.ids.length === 5 && original.lists.runs.ids.length === 1 && original.lists.events.ids.length > 20, JSON.stringify(original.lists));
  const networkDir = join(ctx.dataDir, 'network');
  const files = Object.keys(tree(networkDir, path => /\.bak$|\.corrupt-|\.tmp-/.test(path)));
  assert.ok(files.filter(path => path.startsWith('events/')).length >= 3, 'several journal segments');

  // The variants: each changes one file of a copy of the data folder.
  const variants = [];
  for (const path of files) {
    const bytes = readFileSync(join(networkDir, path)), backup = (() => { try { return statSync(join(networkDir, `${path}.bak`)).isFile(); } catch { return false; } })();
    variants.push({ path, kind: 'torn', backup, apply: async dir => truncate(join(dir, path), Math.floor(bytes.length / 2)) });
    variants.push({ path, kind: 'garbage', backup, apply: async dir => writeFile(join(dir, path), Buffer.concat([Buffer.from('\0\0\0{not json'), Buffer.alloc(64)])) });
    if (backup) {
      variants.push({ path, kind: 'torn without backup', apply: async dir => { await truncate(join(dir, path), Math.floor(bytes.length / 2)); await rm(join(dir, `${path}.bak`)); } });
      variants.push({ path, kind: 'missing, backup kept', backup, apply: async dir => rm(join(dir, path)) });
    }
    if (path.startsWith('events/')) variants.push({ path, kind: 'missing segment', apply: async dir => rm(join(dir, path)) });
    if (/\.json$/.test(path) && !/\/v\d+-[0-9a-f]{64}\.json$/.test(path) && !/(request|plan)\.json$/.test(path)) {
      variants.push({ path, kind: 'newer version', newer: true, apply: async dir => { const data = JSON.parse(bytes); await writeFile(join(dir, path), `${JSON.stringify({ ...data, version: data.version + 1 })}\n`); } });
    }
    if (/\.json$/.test(path)) variants.push({ path, kind: 'stray temporary file', apply: async dir => writeFile(join(dir, `${path}.tmp-99999-0badf00d`), bytes.subarray(0, Math.floor(bytes.length / 3))) });
  }
  const report = [];
  await pool(variants, 6, async variant => {
    const dataDir = await mkdtemp(join(tmpdir(), 'pb-network-damage-')), label = `${variant.path} (${variant.kind})`;
    try {
      cpSync(ctx.dataDir, dataDir, { recursive: true, filter: source => !source.endsWith('instance.lock') });
      await variant.apply(join(dataDir, 'network'));
      const damaged = variant.newer ? readFileSync(join(dataDir, 'network', variant.path)) : null;
      const kept = existsBytes(join(dataDir, 'network'), variant.path);
      const app = await start(dataDir);
      try {
        const now = await probe(app.call);
        // The app answers: every route 200, or 409 when its domain fails closed; never a crash or a 500.
        for (const [name, list] of Object.entries(now.lists)) {
          assert.ok([200, 409].includes(list.status), `${label}: ${name} answered ${list.status}`);
          if (list.status !== 200 || name === 'events' || name === 'settings') continue;
          // A file read from its backup (architecture §4.2 rule 2) is the save before the last one: only what that save did not
          // know yet may be missing, and the damaged copy is kept (checked below).
          const backup = (() => { try { return readFileSync(join(ctx.dataDir, 'network', `${variant.path}.bak`), 'utf8'); } catch { return ''; } })();
          for (const id of original.lists[name].ids) assert.ok(list.ids.includes(id) || list.unavailable.includes(id) || (variant.backup && !backup.includes(id)), `${label}: ${name} lost ${id} silently`);
        }
        for (const [path, before] of Object.entries(originalDetails)) {
          const answer = await app.call(path);
          // A finished job read from its backup is the copy before its result: it says so (RESTORED_FROM_BACKUP), and its result file stays on disk.
          const recovered = answer.status === 404 && /\/result$/.test(path) && (await app.call(path.replace(/\/result$/, ''))).json?.job?.errorCode === 'RESTORED_FROM_BACKUP';
          assert.ok(answer.status === before.status || answer.status === 409 || recovered, `${label}: ${path} answered ${answer.status} (was ${before.status}): ${answer.text.slice(0, 200)}`);
          const text = answer.json?.text ?? answer.json?.report?.text ?? null;
          if (answer.status === 200 && before.text !== null) assert.equal(text, before.text, `${label}: ${path} answered other content`);
        }
        // Nothing runs: every job is finished or waits for the owner (a waiting job read from its backup is interrupted instead).
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.equal(app.worker.starts.length, 0, `${label}: a job ran`);
        const job = await app.call(`/api/network/jobs/${waiting}`);
        if (job.status === 200) assert.ok(['waiting_for_approval', 'interrupted'].includes(job.json.job.status), `${label}: ${job.json.job.status}`);
        // The damaged bytes are kept (in place or set aside); a newer file is never rewritten; Kanban is not affected.
        kept(label);
        if (damaged) assert.ok(damaged.equals(readFileSync(join(dataDir, 'network', variant.path))), `${label}: a newer file was rewritten`);
        assert.equal((await app.call('/api/board')).status, 200, `${label}: Kanban`);
        // The journal: a new event continues after every kept one, never reusing a sequence number.
        if (now.lists.events.status === 200 && job.status === 200 && job.json.job.status === 'waiting_for_approval') {
          await app.ok(`/api/network/jobs/${waiting}/cancel`, 'POST', {});
          const after = await app.call('/api/network/events?limit=200');
          if (after.status === 200) {
            const seqs = after.json.events.map(event => event.seq);
            assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), `${label}: ordered`);
            assert.equal(new Set(seqs).size, seqs.length, `${label}: no seq twice`);
          }
        }
        report.push(label);
      } finally { await app.app.close(); }
    } finally { await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
  t.diagnostic(`damaged-file variants: ${variants.length} over ${files.length} files`);
  assert.equal(report.length, variants.length);
});

/**
 * After a damage variant: the damaged file's bytes are still somewhere under `dir` (in place, set aside, or as the start of
 * a journal segment whose torn last line was closed), unless the variant removed the file itself.
 */
function existsBytes(dir, path) {
  let bytes = null;
  try { bytes = readFileSync(join(dir, path)); } catch { return () => {}; }
  return label => assert.ok(Object.values(tree(dir)).some(value => value.subarray(0, bytes.length).equals(bytes)), `${label}: its bytes were deleted`);
}

test('revocation around running and queued jobs: a machine client and an inbound A2A caller revoked while their jobs run lose access at once (stream ended, 401) while the jobs run on as the owner’s to cancel; a Base agent deleted while its job waits fails the claim; a Base agent revoked while its job runs leaves it running and cancellable', async t => {
  const worker = fakeWorker({ mode: 'manual' });
  const ctx = await fixture(t, { worker, serverOptions: { a2aOptions: { inbound: { pollMs: 20 } } } });
  const lead = await ctx.register('lead'), scout = await ctx.register('scout');
  const port = await ctx.on();
  const { ok } = await owner(ctx.app);
  const job = async id => (await ok(`/api/network/jobs/${id}`)).job;
  const run = async submit => { const next = worker.next(); const id = await submit(); const entry = await next; await entry.own.launching(); await entry.own.spawned({ pid: 4343 }); return { id, entry }; };

  // A REST client's job runs while its event stream is open; the owner revokes the client.
  const rest = await ctx.client({ agents: [lead.id] });
  const mine = await run(async () => (await ctx.machine(rest.token, '/jobs', { method: 'POST', body: { agentId: lead.id, input: { text: 'Client job.' } } })).json.jobId);
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}/machine/v1/events/stream?after=0`, { headers: { Authorization: `Bearer ${rest.token}` }, signal: controller.signal });
  assert.equal(response.status, 200);
  let ended = false, received = '';
  const reading = (async () => { const reader = response.body.getReader(); for (;;) { const { value, done } = await reader.read(); if (done) break; received += Buffer.from(value).toString(); } })().catch(() => {}).finally(() => { ended = true; });
  await until(() => received.includes('"live":true'), 'the client stream is live');
  await ok(`/api/network/clients/${rest.client.id}`, 'DELETE', {});
  await until(() => ended, 'the client stream ended at once');
  const afterRevoke = received.length;
  assert.deepEqual([(await ctx.machine(rest.token, `/jobs/${mine.id}`)).status, (await ctx.machine(rest.token, `/jobs/${mine.id}/result`)).status], [401, 401]);
  // The inbound A2A caller: its task (a job) runs; the owner revokes the caller.
  await ok('/api/network/federation/inbound', 'PATCH', { expectedRevision: (await ok('/api/network/federation')).revision, enabled: true, agents: [{ agentId: lead.id, description: 'Answers.' }] });
  const caller = await ctx.client({ agents: [lead.id], permissions: ['submit_jobs', 'read_job_result', 'cancel_own_jobs'] }, { kind: 'a2a', name: 'Partner' });
  const rpc = (body, auth = caller.token) => request(port, '/a2a/v1', { method: 'POST', body: { jsonrpc: '2.0', id: 1, ...body }, headers: { Authorization: `Bearer ${auth}` } });
  const remote = await run(async () => (await rpc({ method: 'SendMessage', params: { message: { messageId: 'm-1', role: 'ROLE_USER', parts: [{ text: 'Partner job.' }] }, configuration: { returnImmediately: true } } })).json.result.task.id);
  assert.equal((await rpc({ method: 'GetTask', params: { id: remote.id } })).json.result.status.state, 'TASK_STATE_WORKING');
  await ok(`/api/network/clients/${caller.client.id}`, 'DELETE', {});
  for (const method of ['GetTask', 'CancelTask']) assert.equal((await rpc({ method, params: { id: remote.id } })).status, 401, method);
  // Both jobs run on (architecture §11.2: revoking a client does not stop its running jobs); nothing more reaches the clients.
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual([(await job(mine.id)).status, (await job(remote.id)).status, worker.cancels.length, received.length], ['running', 'running', 0, afterRevoke]);
  // The owner decides: cancel one, let the other finish; the revoked clients still see nothing.
  assert.equal((await ok(`/api/network/jobs/${mine.id}/cancel`, 'POST', {})).job.status, 'cancelled');
  assert.ok(worker.cancels.includes(mine.entry.own.attemptId), 'the worker was told to stop');
  await remote.entry.own.finish({ status: 'completed', exitCode: 0, result: { text: 'Partner answer.' } }); remote.entry.end();
  assert.equal((await job(remote.id)).status, 'completed');
  assert.equal((await rpc({ method: 'GetTask', params: { id: remote.id } })).status, 401);
  await controller.abort(); await reading;

  // A Base agent deleted while its job waits for approval: the claim fails, nothing starts.
  const waiting = (await ok('/api/network/jobs', 'POST', { agentId: scout.id, input: { text: 'Waits.' }, requireApproval: true }, 202)).jobId;
  const base = await ctx.app.board.base.list(), resource = base.resources.find(item => item.id === 'scout');
  await ctx.app.board.base.remove('scout', { expectedRevision: resource.revision, expectedBaseRevision: base.revision });
  const starts = worker.starts.length;
  await ok(`/api/network/jobs/${waiting}/approve`, 'POST', { expectedRevision: (await job(waiting)).revision, decision: 'approve' });
  const refused = await until(async () => { const value = await job(waiting); return value.status === 'failed' && value; }, 'the claim fails');
  assert.deepEqual([refused.errorCode, refused.attempts.length, worker.starts.length], ['BASE_REVOKED', 0, starts]);

  // A Base agent switched off while its job runs: the job runs on (what was supplied stays supplied) and the owner can cancel it.
  const lead2 = await run(async () => (await ok('/api/network/jobs', 'POST', { agentId: lead.id, input: { text: 'Runs while Base changes.' } }, 202)).jobId);
  const leadResource = (await ctx.app.board.base.list()).resources.find(item => item.id === 'lead');
  await ctx.app.board.base.update('lead', { enabled: false }, { expectedRevision: leadResource.revision });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal((await job(lead2.id)).status, 'running', 'not killed silently');
  assert.equal((await ok(`/api/network/jobs/${lead2.id}/cancel`, 'POST', {})).job.status, 'cancelled');
  // A late result after the cancel is kept apart; the job stays cancelled.
  await lead2.entry.own.finish({ status: 'completed', exitCode: 0, result: { text: 'Too late.' } }).catch(() => {}); lead2.entry.end();
  assert.equal((await job(lead2.id)).status, 'cancelled');
});

test('a board backup restored while Network holds a waiting job, a waiting run and a schedule starts nothing and changes no Network file', async t => {
  const ctx = await fixture(t);
  const { agents, pipeline } = await mvp(ctx);
  const { ok, call } = await owner(ctx.app);
  const runId = (await ok(`/api/network/pipelines/${pipeline.id}/runs`, 'POST', { version: 1, confirm: true, input: { text: 'Waits.' } }, 202)).runId;
  await until(async () => (await ok(`/api/network/pipeline-runs/${runId}`)).run.status === 'waiting_for_approval', 'the run waits', 20000);
  const jobId = (await ok('/api/network/jobs', 'POST', { agentId: agents.lead.id, input: { text: 'Waits for a yes.' }, requireApproval: true }, 202)).jobId;
  const schedule = (await ok('/api/network/schedules', 'POST', { expectedRevision: 0, name: 'Nightly', target: { agentId: agents.lead.id, input: { text: 'Check the docs.' } }, cadence: { kind: 'weekly', days: [1, 3], time: '03:30' } }, 201)).schedule;
  const backup = (await call('/api/board/export')).json;
  const networkDir = join(ctx.dataDir, 'network'), before = tree(networkDir), starts = ctx.worker.starts.length;
  const restored = await call('/api/board/import', 'POST', { backup, replace: true });
  assert.equal(restored.status, 200, restored.text);
  await new Promise(resolve => setTimeout(resolve, 1500)); // More than a pass of the pipeline runner.
  assert.deepEqual([(await ok(`/api/network/jobs/${jobId}`)).job.status, (await ok(`/api/network/pipeline-runs/${runId}`)).run.status, (await ok('/api/network/schedules')).schedules.find(item => item.id === schedule.id).enabled],
    ['waiting_for_approval', 'waiting_for_approval', false]);
  assert.deepEqual([(await ok('/api/network/jobs?limit=200')).total, ctx.worker.starts.length], [4, starts], 'no job was made or started');
  assert.deepEqual(Object.keys(tree(networkDir)).sort(), Object.keys(before).sort(), 'no Network file was added or removed');
  for (const [path, bytes] of Object.entries(before)) assert.ok(bytes.equals(readFileSync(join(networkDir, path))), `${path} unchanged`);
});
