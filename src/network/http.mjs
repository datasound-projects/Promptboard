/**
 * Owner Network routes (/api/network/*), mounted in src/server.mjs behind its unchanged token, Host, Origin, proxy and
 * fetch-site checks. Every route here is also allowed from a paired device (architecture §10.2): none of them creates a
 * way in, shows a secret or changes trust (a paired device has the owner's control, so it may submit and cancel jobs too).
 * Only the job routes lead to work, and only through the job engine's worker. NETWORK_ROUTES below is the one route table:
 * the dispatcher reads it, and tests/remote-access.test.mjs checks that every row has exactly one paired-device row there.
 *
 *   GET  /api/network/agents                ?q tag capability status kind provider baseResourceId projectId networkId offset limit
 *   POST /api/network/agents                { baseResourceId, expectedRevision, displayName?, tags?, capabilities?, enabled?, projectAllowlist? }
 *   GET  /api/network/agents/:id
 *   PATCH /api/network/agents/:id           { expectedRevision, …fields }
 *   GET  /api/network/networks              ?q agentId archived=true offset limit
 *   POST /api/network/networks              { name, description?, nodes?, edges? }
 *   GET  /api/network/networks/:id          the draft with refs, issues and usedBy
 *   PATCH /api/network/networks/:id         { expectedRevision, name?, description?, nodes?, edges?, archived? }
 *   DELETE /api/network/networks/:id        { expectedRevision }: only a never-published network nothing uses
 *   POST /api/network/networks/:id/publish  { expectedRevision }
 *   POST /api/network/networks/:id/duplicate { name? }
 *   GET  /api/network/networks/:id/versions/:n
 *   GET  /api/network/export
 *   POST /api/network/import                { data, expectedRevision }
 *
 * Memory of an agent (agents/agt_…) or a network (networks/net_…), and an agent's reports (memory.mjs, posts.mjs):
 *   GET  …/memory                           ?q status offset limit
 *   POST …/memory                           { expectedRevision (of the memory), kind, text }: a proposal
 *   PATCH …/memory/:mid                     { expectedRevision (of the record), kind?, text? }
 *   POST …/memory/:mid/approve              { expectedRevision, decision: 'approve' | 'reject' }
 *   DELETE …/memory/:mid                    { expectedRevision }
 *   GET  /api/network/agents/:id/memory/preview   ?projectId networkId memory=none|agent|agent+network projectLessons=true|false
 *   GET  /api/network/agents/:id/posts      ?offset limit
 *   POST /api/network/agents/:id/posts      { expectedRevision, markdown, references? }
 *   PATCH /api/network/agents/:id/posts/:pid  { expectedRevision, markdown?, references? }
 *   DELETE /api/network/agents/:id/posts/:pid { expectedRevision }
 *
 * Jobs (jobs.mjs). None starts a process by itself: a job runs only when the worker (worker-local.mjs) claims it.
 *   GET  /api/network/settings              maxConcurrentJobs, defaultTimeoutMs, outputRetentionDays, limits
 *   PATCH /api/network/settings             { expectedRevision, …settings }
 *   GET  /api/network/jobs                  ?status agentId projectId networkId parentJobId offset limit
 *   POST /api/network/jobs                  { agentId, input: { text, json? }, instructions?, tools?, permissions?, limits?, requireApproval?, projectId?, networkId?, parentJobId?, idempotencyKey? }
 *   GET  /api/network/jobs/:id              the job, its accepted request and child jobs
 *   GET  /api/network/jobs/:id/result       a completed job's result { text, json } (checked against its hash)
 *   DELETE /api/network/jobs/:id            { expectedRevision }: a finished job only
 *   POST /api/network/jobs/:id/cancel       {}
 *   POST /api/network/jobs/:id/approve      { expectedRevision, decision: 'approve' | 'reject' }
 *   POST /api/network/jobs/:id/retry        { expectedRevision, confirm: true, confirmUncertain? }
 *   POST /api/network/jobs/:id/close        { expectedRevision }
 *
 * Activity (events.mjs, activity.mjs; architecture §19). Reads only: no route appends an event.
 *   GET  /api/network/events                ?after | before, limit (1–200), agentId jobId networkId pipelineRunId
 *   GET  /api/network/events/stream         ?after: NDJSON replay from `after`, then live events and a ping every 15 s
 *   GET  /api/network/activity              agents' statuses with coverage, open jobs, Kanban runs of registered agents
 */
import { activitySummary } from './activity.mjs';
import { EVENT_FILTERS } from './events.mjs';
import { JOB_LIMITS } from './jobs.mjs';
import { NETWORK_LIMITS } from './registry.mjs';
import { NetworkError } from './storage.mjs';

// A draft may reach 8 MiB; an import carries every draft and version (ponytail: one body, split imports past 32 MiB).
const BODY = { small: 64 * 1024, network: NETWORK_LIMITS.draftBytes + 64 * 1024, import: 32 * 1024 * 1024 };
const integer = (value, fallback) => value === null ? fallback : /^\d{1,9}$/.test(value) ? Number(value) : NaN; // NaN is refused by the registry.
// A sequence number; anything else is NaN, which the journal refuses.
const seq = value => value === null || value === '' ? undefined : /^\d{1,15}$/.test(value) ? Number(value) : NaN;
const eventQuery = params => ({ after: seq(params.get('after')), before: seq(params.get('before')), limit: params.get('limit') === null ? 100 : /^\d{1,9}$/.test(params.get('limit')) ? Number(params.get('limit')) : NaN,
  ...Object.fromEntries(EVENT_FILTERS.map(key => [key, params.get(key) || undefined])) });
const query = (params, keys) => ({ ...Object.fromEntries(keys.map(key => [key, params.get(key) || undefined])), offset: integer(params.get('offset'), 0), limit: integer(params.get('limit'), 50) });
// The preview's question as resolve() takes it; a value it does not know is passed on and refused there.
const preview = params => ({ projectId: params.get('projectId') || null, networkId: params.get('networkId') || null, memory: params.get('memory') || 'agent',
  projectLessons: ({ true: true, false: false, null: false })[params.get('projectLessons')] ?? params.get('projectLessons') });

const AGENT = '(agt_[0-9a-f]{20})', NETWORK = '(net_[0-9a-f]{20})', MEMORY = '(mem_[0-9a-f]{20})', POST = '(pst_[0-9a-f]{20})', JOB = '(job_[0-9a-f]{20})';
const route = (method, path, run, status, stream = false) => Object.freeze({ method, pattern: new RegExp(`^/api/network${path}$`), run, status, stream });
/** Memory routes of one scope: an agent's (agents/agt_…) or a network's (networks/net_…). */
const memoryRoutes = (kind, prefix) => [
  route('GET', `${prefix}/memory`, (c, id) => c.network.memory.list(kind, id, query(c.searchParams, ['q', 'status']))),
  route('POST', `${prefix}/memory`, async (c, id) => c.network.memory.propose(kind, id, await c.body(BODY.small))),
  route('PATCH', `${prefix}/memory/${MEMORY}`, async (c, id, record) => c.network.memory.edit(kind, id, record, await c.body(BODY.small))),
  route('DELETE', `${prefix}/memory/${MEMORY}`, async (c, id, record) => c.network.memory.remove(kind, id, record, await c.body(BODY.small))),
  route('POST', `${prefix}/memory/${MEMORY}/approve`, async (c, id, record) => c.network.memory.decide(kind, id, record, await c.body(BODY.small))),
];
const jobAction = (action, method) => route('POST', `/jobs/${JOB}/${action}`, async (c, id) => c.jobs[method](id, await c.body(BODY.small)));
/**
 * Every Network route: method, path pattern and handler `(context, ...path IDs)`; `status(answer)` when it is not 200.
 * Patterns never overlap, so each request matches at most one path; a known path with another method is 404.
 */
export const NETWORK_ROUTES = Object.freeze([
  route('GET', '/agents', c => c.network.listAgents(query(c.searchParams, ['q', 'tag', 'capability', 'status', 'kind', 'provider', 'baseResourceId', 'projectId', 'networkId']))),
  route('POST', '/agents', async c => c.network.registerAgent(await c.body(BODY.small))),
  route('GET', `/agents/${AGENT}`, (c, id) => c.network.agent(id)),
  route('PATCH', `/agents/${AGENT}`, async (c, id) => c.network.updateAgent(id, await c.body(BODY.small))),
  ...memoryRoutes('agent', `/agents/${AGENT}`),
  route('GET', `/agents/${AGENT}/memory/preview`, (c, id) => c.network.memory.resolve(id, preview(c.searchParams))),
  route('GET', `/agents/${AGENT}/posts`, (c, id) => c.network.posts.list(id, query(c.searchParams, []))),
  route('POST', `/agents/${AGENT}/posts`, async (c, id) => c.network.posts.create(id, await c.body(BODY.small))),
  route('PATCH', `/agents/${AGENT}/posts/${POST}`, async (c, id, post) => c.network.posts.update(id, post, await c.body(BODY.small))),
  route('DELETE', `/agents/${AGENT}/posts/${POST}`, async (c, id, post) => c.network.posts.remove(id, post, await c.body(BODY.small))),
  route('GET', '/networks', c => c.network.listNetworks(query(c.searchParams, ['q', 'agentId', 'archived']))),
  route('POST', '/networks', async c => c.network.createNetwork(await c.body(BODY.network))),
  route('GET', `/networks/${NETWORK}`, (c, id) => c.network.networkDetail(id)),
  route('PATCH', `/networks/${NETWORK}`, async (c, id) => c.network.updateNetwork(id, await c.body(BODY.network))),
  route('DELETE', `/networks/${NETWORK}`, async (c, id) => c.network.deleteNetwork(id, await c.body(BODY.small))),
  route('POST', `/networks/${NETWORK}/publish`, async (c, id) => c.network.publishNetwork(id, await c.body(BODY.small))),
  route('POST', `/networks/${NETWORK}/duplicate`, async (c, id) => c.network.duplicateNetwork(id, await c.body(BODY.small))),
  route('GET', `/networks/${NETWORK}/versions/([1-9]\\d{0,8})`, (c, id, number) => c.network.version(id, Number(number))),
  ...memoryRoutes('network', `/networks/${NETWORK}`),
  route('GET', '/export', c => c.network.export()),
  route('POST', '/import', async c => c.network.import(await c.body(BODY.import))),
  route('GET', '/settings', c => c.jobs.settings()),
  route('PATCH', '/settings', async c => c.jobs.updateSettings(await c.body(BODY.small))),
  route('GET', '/jobs', c => c.jobs.list(query(c.searchParams, ['status', 'agentId', 'projectId', 'networkId', 'parentJobId']))),
  route('POST', '/jobs', async c => c.jobs.submit(await c.body(JOB_LIMITS.submitBody)), accepted => (accepted.deduplicated ? 200 : 202)),
  route('GET', `/jobs/${JOB}`, (c, id) => c.jobs.read(id)),
  route('GET', `/jobs/${JOB}/result`, (c, id) => c.jobs.result(id)),
  route('DELETE', `/jobs/${JOB}`, async (c, id) => c.jobs.remove(id, await c.body(BODY.small))),
  jobAction('cancel', 'cancel'), jobAction('approve', 'approve'), jobAction('retry', 'retry'), jobAction('close', 'closeJob'),
  route('GET', '/events', c => c.events.read(eventQuery(c.searchParams))),
  // The stream answers on the response itself; the client key is the paired device's session, or the computer.
  route('GET', '/events/stream', c => c.events.stream({ res: c.res, after: seq(c.searchParams.get('after')), client: c.req.promptboardRemote?.id ?? 'local' }), undefined, true),
  route('GET', '/activity', c => activitySummary({ registry: c.network, jobs: c.jobs, events: c.events, board: c.board })),
]);

export async function networkRoute({ network, jobs, events, board, req, res, pathname, searchParams, jsonBody, send }) {
  const body = async limit => {
    const value = await jsonBody(req, limit);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NetworkError('Send a JSON object.');
    return value;
  };
  try {
    for (const row of NETWORK_ROUTES) {
      if (row.method !== req.method) continue;
      const match = row.pattern.exec(pathname);
      if (!match) continue;
      const answer = await row.run({ network, jobs, events, board, req, res, searchParams, body }, ...match.slice(1));
      if (row.stream) return; // It answered on the response.
      return send(res, row.status ? row.status(answer) : 200, answer);
    }
    return send(res, 404, { error: 'This Network route does not exist.', code: 'NOT_FOUND' });
  } catch (error) {
    // Fixed messages; details carry IDs only (a cycle path, unresolved references), never file paths or content.
    if (error instanceof NetworkError) return send(res, error.status, { error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) });
    throw error;
  }
}
