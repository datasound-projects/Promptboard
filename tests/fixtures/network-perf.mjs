/**
 * Offline performance fixtures for Network (Task 14) and the server measurements over them, shared by
 * tests/network-perf.test.mjs, tests/network-perf-browser.test.mjs (suite sizes) and scripts/network-perf.mjs (opt-in, full
 * sizes). Everything is generated locally against a running app on a temporary data folder: registrations and the
 * journal are written in the app's own formats before the app first reads them; networks, versions and the pipeline go
 * through the owner API; jobs are copies of one job the app accepted and finished. No CLI, no network.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const hex12 = n => n.toString(16).padStart(12, '0');
const sha256 = text => createHash('sha256').update(text).digest('hex');
const id = prefix => `${prefix}_${randomBytes(10).toString('hex')}`;
const RELATIONS = ['message', 'delegate', 'share_result'];

/** Suite sizes (minutes of CI time matter) and the opt-in sizes. */
export const SIZES = Object.freeze({
  suite: { agents: 1100, teams: 50, teamSize: 20, bigGraph: 1000, pipelineSteps: 200, jobs: 500, segments: 15, segmentBytes: 256 * 1024 },
  full: { agents: 5000, teams: 50, teamSize: 20, bigGraph: 1000, pipelineSteps: 200, jobs: 5000, segments: 15, segmentBytes: 8 * 1024 * 1024 },
});

/**
 * Before the app reads Network: `count` registrations of the Base agents `baseIds` (round robin) and a journal of
 * `segments` full segments of `segmentBytes` (the default ceiling keeps 16). Answers the registration rows and the last seq.
 */
export async function writeOffline(dataDir, { agents, segments, segmentBytes }, baseIds) {
  const dir = join(dataDir, 'network'), at = Date.now();
  await mkdir(join(dir, 'events'), { recursive: true, mode: 0o700 });
  const rows = Array.from({ length: agents }, (_, index) => ({ id: id('agt'), baseResourceId: baseIds[index % baseIds.length], displayName: `Agent ${index}`, tags: index % 7 ? [] : ['research'],
    capabilities: index % 5 ? [] : ['review'], enabled: true, visibility: 'private', projectAllowlist: [], createdAt: at, updatedAt: at, revision: 1 }));
  await writeFile(join(dir, 'agents.json'), JSON.stringify({ schema: 'promptboard.network-agents', version: 1, revision: 1, rows }), { mode: 0o600 });
  let seq = 0;
  for (let segment = 0; segment < segments; segment++) {
    const first = seq + 1, lines = [JSON.stringify({ schema: 'promptboard.network-events', version: 1, first })];
    for (let size = lines[0].length; size < segmentBytes - 400;) {
      const line = JSON.stringify({ seq: ++seq, id: id('evt'), at: at - 1000, type: 'job.status', jobId: id('job'), agentId: rows[seq % rows.length].id, status: 'completed', from: 'running', by: 'worker', message: 'Completed.' });
      lines.push(line); size += line.length + 1;
    }
    await writeFile(join(dir, 'events', `${String(first).padStart(16, '0')}.jsonl`), `${lines.join('\n')}\n`, { mode: 0o600 });
  }
  return { rows, lastSeq: seq };
}

/**
 * Through the owner API (`call(path, method, body)` → JSON, throwing on an error status): `teams` published networks of
 * `teamSize` agents, an "Org" network pinning every team (collapsed: one node per team) plus agents of its own, a
 * `bigGraph`-node draft, and a published pipeline of `pipelineSteps` steps (agent chains into one report). Answers their IDs.
 */
export async function buildGraphs(call, rows, { teams, teamSize, bigGraph, pipelineSteps }) {
  const grid = (count, offset = 0) => ({
    nodes: Array.from({ length: count }, (_, index) => ({ id: `n_${hex12(index + 1)}`, type: 'agent', agentId: rows[(offset + index) % rows.length].id, position: { x: (index % 40) * 200, y: Math.floor(index / 40) * 100 } })),
    edges: Array.from({ length: count - 1 }, (_, index) => ({ id: `e_${hex12(index + 1)}`, from: `n_${hex12(index + 1)}`, to: `n_${hex12(index + 2)}`, relation: RELATIONS[index % 3] })),
  });
  const teamIds = [];
  for (let team = 0; team < teams; team++) {
    const { network } = await call('/api/network/networks', 'POST', { name: `Team ${team + 1}`, ...grid(teamSize, team * teamSize) });
    await call(`/api/network/networks/${network.id}/publish`, 'POST', { expectedRevision: network.revision });
    teamIds.push(network.id);
  }
  const own = grid(Math.min(50, rows.length), teams * teamSize).nodes.map((node, index) => ({ ...node, id: `n_${hex12(5000 + index)}`, position: { x: (index % 10) * 200, y: 1200 + Math.floor(index / 10) * 100 } }));
  const org = (await call('/api/network/networks', 'POST', { name: 'Org', nodes: [...teamIds.map((networkId, index) => ({ id: `n_${hex12(index + 1)}`, type: 'subnetwork', networkId, version: 1, position: { x: (index % 10) * 260, y: Math.floor(index / 10) * 200 } })), ...own], edges: [] })).network;
  await call(`/api/network/networks/${org.id}/publish`, 'POST', { expectedRevision: org.revision });
  const big = (await call('/api/network/networks', 'POST', { name: 'Thousand', ...grid(bigGraph) })).network;
  // The pipeline's network: three agents; ten chains of agent steps into one report.
  const desk = (await call('/api/network/networks', 'POST', { name: 'Desk', ...grid(3) })).network;
  await call(`/api/network/networks/${desk.id}/publish`, 'POST', { expectedRevision: desk.revision });
  const nodes = [], edges = [], agentSteps = pipelineSteps - 1;
  for (let n = 0; n < agentSteps; n++) {
    nodes.push({ id: `n_${hex12(n + 1)}`, type: 'agent', label: `Step ${n + 1}`, position: { x: Math.floor(n / 10) * 240, y: (n % 10) * 112 }, config: { agentId: rows[n % 3].id } });
    if (n >= 10) edges.push({ id: `e_${hex12(n + 1)}`, from: `n_${hex12(n - 9)}`, to: `n_${hex12(n + 1)}`, fromPort: 'text' });
  }
  const last = Array.from({ length: 10 }, (_, chain) => nodes.filter((_, n) => n % 10 === chain).at(-1).id);
  nodes.push({ id: `n_${hex12(9000)}`, type: 'output', label: 'Report', position: { x: 21 * 240, y: 500 }, config: { include: last } });
  last.forEach((from, index) => edges.push({ id: `e_${hex12(9000 + index)}`, from, to: `n_${hex12(9000)}`, fromPort: 'text' }));
  const pipeline = (await call('/api/network/pipelines', 'POST', { networkId: desk.id, networkVersion: 1, name: 'Two hundred', nodes, edges })).pipeline;
  await call(`/api/network/pipelines/${pipeline.id}/publish`, 'POST', { expectedRevision: pipeline.revision });
  return { teamIds, orgId: org.id, bigId: big.id, deskId: desk.id, pipelineId: pipeline.id };
}

/** `count` copies of the finished job `templateId` (new job and attempt IDs, the request's hash recomputed), written as the app writes them. */
export async function copyJobs(dataDir, templateId, count) {
  const jobs = join(dataDir, 'network', 'jobs'), folder = jobId => join(jobs, `job__${jobId.slice(4)}`);
  const job = JSON.parse(await readFile(join(folder(templateId), 'job.json'), 'utf8')), request = await readFile(join(folder(templateId), 'request.json'), 'utf8');
  const attempt = job.attempts[0].id, result = await readFile(join(folder(templateId), 'attempts', `att__${attempt.slice(4)}`, 'result.md'));
  for (let index = 0; index < count; index++) {
    const jobId = id('job'), attemptId = id('att'), swap = text => text.replaceAll(templateId, jobId).replaceAll(templateId.slice(4), jobId.slice(4)).replaceAll(attempt, attemptId).replaceAll(attempt.slice(4), attemptId.slice(4));
    const requestText = swap(request), copy = JSON.parse(swap(JSON.stringify(job)));
    Object.assign(copy, { requestSha256: sha256(requestText), idempotencyKey: null, createdAt: job.createdAt - index, updatedAt: job.updatedAt - index });
    await mkdir(join(folder(jobId), 'attempts', `att__${attemptId.slice(4)}`), { recursive: true, mode: 0o700 });
    await writeFile(join(folder(jobId), 'request.json'), requestText, { mode: 0o600 });
    await writeFile(join(folder(jobId), 'job.json'), `${JSON.stringify(copy, null, 1)}\n`, { mode: 0o600 });
    await writeFile(join(folder(jobId), 'attempts', `att__${attemptId.slice(4)}`, 'result.md'), result, { mode: 0o600 });
  }
}

/** Milliseconds of `work()`, the median of `times` runs, with its last answer. */
export async function timed(work, times = 3) {
  const runs = [];
  let answer;
  for (let i = 0; i < times; i++) { const start = performance.now(); answer = await work(); runs.push(performance.now() - start); }
  return { ms: Math.round(runs.sort((a, b) => a - b)[Math.floor(runs.length / 2)] * 10) / 10, answer };
}

/** The owner-API measurements over a fixture (each the median of three): lists, search, reads, saves, validation, jobs and the journal. */
export async function measureServer(call, ids, rows) {
  const out = {}, put = async (name, work) => { const { ms, answer } = await timed(work); out[name] = ms; return answer; };
  const agents = await put('listAgentsMs', () => call('/api/network/agents?limit=200'));
  await put('searchAgentsMs', () => call('/api/network/agents?q=Agent%20777&limit=50'));
  await put('filterAgentsMs', () => call('/api/network/agents?capability=review&limit=200'));
  await put('listNetworksMs', () => call('/api/network/networks?limit=200'));
  const big = await put('readBigGraphMs', () => call(`/api/network/networks/${ids.bigId}`));
  await put('readOrgMs', () => call(`/api/network/networks/${ids.orgId}`));
  await put('readTeamVersionMs', () => call(`/api/network/networks/${ids.teamIds[0]}/versions/1`));
  let revision = big.network.revision;
  await put('saveBigGraphMs', async () => { const saved = await call(`/api/network/networks/${ids.bigId}`, 'PATCH', { expectedRevision: revision, nodes: big.network.nodes.map(node => ({ ...node, position: { x: node.position.x + 1, y: node.position.y } })) }); revision = saved.network.revision; return saved; });
  out.publishBigGraphMs = (await timed(() => call(`/api/network/networks/${ids.bigId}/publish`, 'POST', { expectedRevision: revision }), 1)).ms;
  await put('validatePipelineMs', () => call(`/api/network/pipelines/${ids.pipelineId}/validate`, 'POST', { version: 1 }));
  await put('readPipelineMs', () => call(`/api/network/pipelines/${ids.pipelineId}`));
  const jobs = await put('listJobsMs', () => call('/api/network/jobs?limit=200'));
  await put('filterJobsMs', () => call(`/api/network/jobs?status=completed&agentId=${rows[0].id}&limit=200`));
  const events = await put('newestEventsMs', () => call('/api/network/events?limit=200'));
  await put('replayEventsMs', () => call('/api/network/events?after=0&limit=200'));
  await put('filteredEventsMs', () => call(`/api/network/events?limit=200&agentId=${rows[1].id}`));
  return { ...out, agents: agents.total, bigGraphNodes: big.network.nodes.length, jobs: jobs.total, events: events.last };
}
