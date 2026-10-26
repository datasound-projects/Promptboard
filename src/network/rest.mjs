/**
 * The machine listener (docs/network/architecture.md §10.3, §11.1–11.2, §22): a private REST gateway for apps and MCP
 * hosts on this computer, on its own http.Server, off by default. It is never the owner's handle(): it serves only
 * /machine/v1/*, authenticates every request with a machine client's bearer token (machine-auth.mjs) and calls the
 * Network services with that principal, so a client sees only its scoped agents and its own jobs and can never approve,
 * retry, edit or read anything else. The owner's token and the paired-phone cookie are refused here, and machine tokens
 * are refused by the owner app (src/server.mjs); the paired-phone listener never forwards here.
 *
 * Every request: Host must be this listener's own (DNS rebinding), an Origin must be its own, cross-site fetches and
 * proxy headers are refused, no CORS header is ever sent, bodies are JSON of at most 256 KiB, and each client may make
 * 60 requests and 10 submits a minute. Submit answers 202 { jobId } at once and never waits for the run, so an MCP host
 * that calls Promptboard while a job of the same provider runs only queues work (no deadlock).
 *
 *   GET  /machine/v1/agents                 read_agents: the client's agents (public fields only)
 *   GET  /machine/v1/agents/:id             read_agents
 *   POST /machine/v1/jobs                   submit_jobs: { agentId, input: { text, json? }, instructions?, tools?, permissions?, limits?,
 *                                           requireApproval?, projectId?, networkId? }, header Idempotency-Key → 202 { jobId, status }
 *   GET  /machine/v1/jobs                   ?status offset limit: the client's own jobs
 *   GET  /machine/v1/jobs/:id               an own job (any other is 404)
 *   POST /machine/v1/jobs/:id/cancel        cancel_own_jobs
 *   GET  /machine/v1/jobs/:id/result        read_job_result: { jobId, text, json, chars }
 *   GET  /machine/v1/events                 ?after limit: events of the client's own jobs
 *   GET  /machine/v1/events/stream          ?after: NDJSON (events.mjs), own jobs only; ends at once when the client is revoked
 * Task 12 (architecture §23), own jobs only:
 *   POST /machine/v1/jobs/:id/children      submit_jobs: { agentId, task, tools?, json? }, header Idempotency-Key → 202: a sub-job
 *                                           of its own job, through the owner's delegation policy and inside its own scope
 *   GET  /machine/v1/jobs/:id/messages      read_job_result: the job's messages and how many to the client are unread
 *   POST /machine/v1/jobs/:id/messages      submit_jobs: { kind: 'review' | 'request', text, json? } → 201
 *   POST /machine/v1/jobs/:id/messages/read read_job_result: { ids? } read receipts
 *   POST /machine/v1/jobs/:id/answer        submit_jobs: { text }: answers the question the job asked
 */
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { serial } from '../durable.mjs';
import { JOB_STATUSES } from './jobs.mjs';
import { MachineClients } from './machine-auth.mjs';
import { fail, NetworkError, object, only, page } from './storage.mjs';

/** Resource ceilings (architecture §10.3), not product limits. */
export const MACHINE_REST_LIMITS = Object.freeze({ body: 256 * 1024, requestsPerMinute: 60, submitsPerMinute: 10, streams: 8 });
const JOB = '(job_[0-9a-f]{20})', AGENT = '(agt_[0-9a-f]{20})';
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded', 'via', 'tailscale-user-login', 'tailscale-funnel-request'];
const SUBMIT_FIELDS = ['agentId', 'input', 'instructions', 'tools', 'permissions', 'limits', 'requireApproval', 'projectId', 'networkId'];
const STE = fileURLToPath(new URL('../../bin/ste.mjs', import.meta.url));
const has = (client, permission) => client.scopes.permissions.includes(permission);
const denied = (message, code) => fail(message, code, 403);
const mine = (job, client) => job.requester?.kind === 'machine' && job.requester.id === client.id;
const seq = value => (value === null || value === '' ? undefined : /^\d{1,15}$/.test(value) ? Number(value) : NaN);
const count = (value, fallback) => (value === null ? fallback : /^\d{1,9}$/.test(value) ? Number(value) : NaN);

/** What a client sees of an agent: who it is and what it can do; never Base content, instructions or other scopes. */
const machineAgent = view => ({ id: view.id, name: view.displayName || view.base.name || view.baseResourceId, tags: view.tags, capabilities: view.capabilities,
  available: view.enabled && !view.base.stale, provider: view.base.provider, tools: view.providerCapabilities.jobTools ?? [] });
/** What a client sees of its job: status and outcome, never attempts, pids, leases, requester internals or file references. */
const machineJob = job => ({ jobId: job.id, agentId: job.agentId, projectId: job.projectId, networkId: job.networkId, status: job.status, outcome: job.outcome, errorCode: job.errorCode,
  reason: job.reason, createdAt: job.createdAt, updatedAt: job.updatedAt, attempts: job.attempts.length, result: job.result ? { chars: job.result.chars, sha256: job.result.sha256, json: Boolean(job.result.jsonRef) } : null,
  waiting: job.waiting ? { for: job.waiting.for, position: job.waiting.position ?? null, message: job.waiting.message } : null });
/** What a client sees of a message on its own job: everything but the internal attempt reference. */
const machineMessage = ({ attemptId, ...message }) => message;
/** What a client sees of an event of its own job. */
const machineEvent = event => ({ seq: event.seq, at: event.at, type: event.type, jobId: event.jobId, agentId: event.agentId, ...(event.status ? { status: event.status } : {}),
  ...(event.from ? { from: event.from } : {}), ...(event.kind ? { kind: event.kind } : {}), ...(event.errorCode ? { errorCode: event.errorCode } : {}), ...(event.message ? { message: event.message } : {}) });

function reply(res, status, body, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) fail('Send JSON with Content-Type: application/json.', 'UNSUPPORTED_MEDIA_TYPE', 415);
  if (Number(req.headers['content-length']) > MACHINE_REST_LIMITS.body) fail(`A request body holds at most ${MACHINE_REST_LIMITS.body / 1024} KiB.`, 'BODY_TOO_LARGE', 413); // Refused unread.
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MACHINE_REST_LIMITS.body) fail(`A request body holds at most ${MACHINE_REST_LIMITS.body / 1024} KiB.`, 'BODY_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('The request is not valid JSON.'); }
  if (!object(value)) fail('Send a JSON object.');
  return value;
}

export class MachineListener {
  /**
   * `registry`, `jobs`, `events`: the Network services. `reservedPorts()` lists the ports it may not take (the app's and
   * remote access's). `limits` lets tests lower the ceilings.
   */
  constructor({ dataDir, registry, jobs, events, reservedPorts = () => [], now = Date.now, limits = {} }) {
    Object.assign(this, { registry, jobs, events, reservedPorts, now, limits: { ...MACHINE_REST_LIMITS, ...limits } });
    this.clients = new MachineClients({ dataDir, registry, now });
    this.clients.onRevoke(id => this.#drop(id));
  }
  #server = null;
  #error = '';
  #closed = false;
  #changes = serial(); // Listener changes one at a time; none after shutdown.
  #open = new Map(); // clientId → open responses (requests and streams), destroyed when its token stops working.
  #hits = new Map(); // clientId → { requests: [at], submits: [at] } of the last minute.
  #own = new Map(); // clientId → Promise<Set<jobId>>: its jobs, for the event filter.
  #streams = 0;

  /** At app start: listens only when the owner turned it on. */
  start() { return this.#changes(async () => { if ((await this.clients.listener()).enabled) await this.#listen().catch(() => {}); }); }
  /** At shutdown: closes the listener and every open request; none starts later. */
  close() { this.#closed = true; return this.#changes(() => this.#stop()); }
  async status() {
    const settings = await this.clients.listener(), port = this.#server?.address()?.port ?? null;
    return { listener: { enabled: settings.enabled, port: settings.port, bind: '127.0.0.1', listening: Boolean(this.#server), url: port ? `http://127.0.0.1:${port}` : null, error: this.#error },
      mcp: { command: 'node', args: [STE, '--mcp'], env: { url: 'PROMPTBOARD_MACHINE_URL', token: 'PROMPTBOARD_MACHINE_TOKEN', tokenFile: 'PROMPTBOARD_MACHINE_TOKEN_FILE' } } };
  }
  /** PATCH /api/network/listener (local-only): { enabled?, port? }. Port 0 lets the system choose a free port. */
  configure(input) {
    only(input, ['enabled', 'port'], 'the listener settings');
    return this.#changes(async () => {
      const current = await this.clients.listener(), next = { enabled: input.enabled ?? current.enabled, port: input.port ?? current.port };
      if (typeof next.enabled !== 'boolean') fail('enabled is true or false.');
      if (!Number.isSafeInteger(next.port) || (next.port !== 0 && (next.port < 1024 || next.port > 65535))) fail('Choose a port from 1024 to 65535.');
      if (next.port !== 0 && this.reservedPorts().includes(next.port)) fail('Promptboard already uses this port (the app or remote access). Choose another one.', 'PORT_IN_USE', 409);
      await this.clients.setListener(next);
      await this.#stop();
      if (next.enabled) await this.#listen().catch(() => {}); // A port that is taken is shown as the listener's error.
      return this.status();
    });
  }
  async #listen() {
    if (this.#closed) return;
    const { port } = await this.clients.listener();
    const server = http.createServer((req, res) => this.#serve(req, res).catch(error => {
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof NetworkError) reply(res, error.status, { error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) });
      else reply(res, 500, { error: 'The request failed. Nothing was changed.', code: 'INTERNAL' });
    }));
    server.requestTimeout = 30_000; server.headersTimeout = 15_000; server.keepAliveTimeout = 5_000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); }).catch(error => {
      this.#error = error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Choose another port.` : 'The machine listener could not start.';
      throw error;
    });
    server.on('error', () => { if (this.#server === server) this.#error = 'The machine listener reported an error. Turn it off and on again.'; }); // Never stops the app.
    if (this.#closed) { server.close(); return; }
    this.#server = server; this.#error = '';
  }
  async #stop() {
    const server = this.#server; this.#server = null; this.#error = '';
    for (const id of [...this.#open.keys()]) this.#drop(id);
    if (server) await new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections?.(); });
  }
  /** A client's token stopped working: its open requests and streams end now. */
  #drop(id) { for (const res of this.#open.get(id) || []) res.destroy(); this.#open.delete(id); }
  /** At most `limit` within the last minute; the time is recorded only when allowed. */
  #allow(id, kind, limit) {
    const now = this.now(), hits = this.#hits.get(id) ?? { requests: [], submits: [] };
    this.#hits.set(id, hits);
    hits[kind] = hits[kind].filter(at => now - at < 60_000);
    if (hits[kind].length >= limit) return false;
    hits[kind].push(now);
    return true;
  }
  /** The client's job IDs: one scan of the job index, then kept current by its own submits. */
  #ownSet(client) {
    if (!this.#own.has(client.id)) {
      const scan = (async () => {
        const set = new Set();
        for (let offset = 0; offset !== null;) { const listed = await this.jobs.list({ offset, limit: 200 }); for (const job of listed.jobs) if (mine(job, client)) set.add(job.id); offset = listed.next; }
        return set;
      })();
      this.#own.set(client.id, scan);
      scan.catch(() => this.#own.delete(client.id));
    }
    return this.#own.get(client.id);
  }
  /** An own job of the client; any other ID (another client's, the owner's, none) is the same 404. */
  async #ownJob(client, id) {
    const { job } = await this.jobs.read(id).catch(error => { if (error.code === 'NOT_FOUND') fail('This job does not exist.', 'NOT_FOUND', 404); throw error; });
    if (!mine(job, client)) fail('This job does not exist.', 'NOT_FOUND', 404);
    return job;
  }

  async #serve(req, res) {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    const port = this.#server?.address()?.port, host = String(req.headers.host || '').toLowerCase();
    // DNS rebinding: a page on another name that resolves here still sends that name as Host.
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) return reply(res, 403, { error: 'This listener accepts requests to 127.0.0.1 only.', code: 'MACHINE_HOST' });
    if (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`) return reply(res, 403, { error: 'This origin is not allowed.', code: 'MACHINE_ORIGIN' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return reply(res, 403, { error: 'Cross-site requests are not allowed.', code: 'MACHINE_ORIGIN' });
    if (PROXY_HEADERS.some(name => req.headers[name] !== undefined)) return reply(res, 403, { error: 'This listener accepts direct local requests only.', code: 'PROXY_REFUSED' });
    // The owner's credentials never act here, and are never forwarded anywhere from here.
    if (req.headers['x-ste-token'] !== undefined || /(?:^|;)\s*pb_remote=/.test(req.headers.cookie || '')) return reply(res, 403, { error: 'Use a client token from Network → Settings. The app’s own session is not accepted here.', code: 'MACHINE_CREDENTIAL_REQUIRED' });
    let url; try { url = new URL(req.url, 'http://machine'); } catch { return reply(res, 400, { error: 'This request address is not valid.', code: 'INVALID_URL' }); }
    if (!url.pathname.startsWith('/machine/v1/')) return reply(res, 404, { error: 'This route does not exist.', code: 'NOT_FOUND' });
    const client = await this.clients.authenticate(req.headers.authorization);
    if (!client) return reply(res, 401, { error: 'Send a valid client token: Authorization: Bearer pbm_…', code: 'MACHINE_UNAUTHORIZED' }, { 'WWW-Authenticate': 'Bearer' });
    if (!this.#allow(client.id, 'requests', this.limits.requestsPerMinute)) return reply(res, 429, { error: 'Too many requests. Wait a minute.', code: 'RATE_LIMITED' }, { 'Retry-After': '60' });
    const open = this.#open.get(client.id) ?? new Set(); this.#open.set(client.id, open);
    open.add(res); res.once('close', () => open.delete(res));
    const route = MACHINE_ROUTES.find(row => row.method === req.method && row.pattern.test(url.pathname));
    if (!route) return reply(res, 404, { error: 'This route does not exist.', code: 'NOT_FOUND' });
    if (route.permission && !has(client, route.permission)) denied(`This client does not have the ${route.permission} permission.`, 'PERMISSION_DENIED');
    const answer = await route.run.call(this, { client, req, res, params: url.searchParams }, ...route.pattern.exec(url.pathname).slice(1));
    if (answer) reply(res, answer.status ?? 200, answer.body);
  }

  async agents({ client }) {
    const agents = [];
    for (const id of client.scopes.agents) {
      try { agents.push(machineAgent((await this.registry.agent(id)).agent)); } catch (error) { if (error.code !== 'NOT_FOUND') throw error; } // A deleted registration drops out.
    }
    return { body: { agents } };
  }
  async agent({ client }, id) {
    if (!client.scopes.agents.includes(id)) denied('This client may not use this agent.', 'AGENT_NOT_ALLOWED');
    const { agent } = await this.registry.agent(id).catch(error => { if (error.code === 'NOT_FOUND') fail('This agent is no longer registered.', 'NOT_FOUND', 404); throw error; });
    return { body: { agent: machineAgent(agent) } };
  }
  /**
   * Submit: the agent, project, network and memory are checked against the client's scopes before the job engine sees the
   * request; memory defaults to none unless read_scoped_memory is granted. The idempotency key (header) is scoped by the
   * client: the same key answers the same job (200), another client's key never matches.
   */
  async submit({ client, req }) {
    if (!this.#allow(client.id, 'submits', this.limits.submitsPerMinute)) return { status: 429, body: { error: 'Too many jobs submitted. Wait a minute.', code: 'RATE_LIMITED' } };
    const body = await readBody(req);
    only(body, SUBMIT_FIELDS, 'a job');
    const { agentId, projectId = null, networkId = null } = body, memoryGranted = has(client, 'read_scoped_memory');
    if (typeof agentId !== 'string' || !client.scopes.agents.includes(agentId)) denied('This client may not use this agent.', 'AGENT_NOT_ALLOWED');
    if (projectId !== null && !client.scopes.projects.includes(projectId)) denied('This client may not use this project.', 'PROJECT_NOT_ALLOWED');
    if (networkId !== null && !client.scopes.networks.includes(networkId)) denied('This client may not use this network.', 'NETWORK_NOT_ALLOWED');
    if (body.permissions !== undefined && !object(body.permissions)) fail('Send the permissions as an object.');
    const permissions = { memory: memoryGranted ? 'agent' : 'none', ...body.permissions };
    if ((permissions.memory !== 'none' || permissions.projectLessons === true) && !memoryGranted) denied('This client may not let jobs read memory or project lessons.', 'MEMORY_NOT_ALLOWED');
    const key = req.headers['idempotency-key'];
    const accepted = await this.jobs.submit({ ...body, permissions, ...(key !== undefined ? { idempotencyKey: key } : {}) }, { requester: { kind: 'machine', id: client.id } });
    (await this.#ownSet(client)).add(accepted.jobId);
    return { status: accepted.deduplicated ? 200 : 202, body: { jobId: accepted.jobId, status: accepted.status, deduplicated: accepted.deduplicated, job: machineJob(accepted.job) } };
  }
  async listJobs({ client, params }) {
    const status = params.get('status') || undefined, offset = count(params.get('offset'), 0), limit = count(params.get('limit'), 50);
    if (status !== undefined && !JOB_STATUSES.includes(status)) fail(`Filter the status by ${JOB_STATUSES.join(', ')}.`);
    const own = [];
    // ponytail: scans the whole job index per call; add a requester index to the job engine if clients list often.
    for (let next = 0; next !== null;) { const listed = await this.jobs.list({ status, offset: next, limit: 200 }); own.push(...listed.jobs.filter(job => mine(job, client))); next = listed.next; }
    const result = page(own, offset, limit, 'jobs');
    return { body: { ...result, jobs: result.jobs.map(machineJob) } };
  }
  async getJob({ client }, id) { return { body: { job: machineJob(await this.#ownJob(client, id)) } }; }
  async cancel({ client, req }, id) {
    await this.#ownJob(client, id);
    const input = req.headers['content-length'] === '0' || req.headers['content-type'] === undefined ? {} : await readBody(req);
    const { job, cancelled } = await this.jobs.cancel(id, input, { by: 'machine' });
    return { body: { job: machineJob(job), cancelled } };
  }
  async result({ client }, id) {
    await this.#ownJob(client, id);
    const { text, json, chars } = await this.jobs.result(id);
    return { body: { jobId: id, text, json, chars } };
  }
  /** A sub-job of an own job (Task 12): the owner's delegation policy decides, inside this client's scope; counts as a submit. */
  async children({ client, req }, id) {
    if (!this.#allow(client.id, 'submits', this.limits.submitsPerMinute)) return { status: 429, body: { error: 'Too many jobs submitted. Wait a minute.', code: 'RATE_LIMITED' } };
    await this.#ownJob(client, id);
    const accepted = await this.jobs.delegate(id, await readBody(req), { clientId: client.id, idempotencyKey: req.headers['idempotency-key'] ?? null });
    (await this.#ownSet(client)).add(accepted.jobId);
    return { status: accepted.deduplicated ? 200 : 202, body: { jobId: accepted.jobId, status: accepted.status, deduplicated: accepted.deduplicated, job: machineJob(accepted.job) } };
  }
  async messages({ client }, id) {
    await this.#ownJob(client, id);
    const { messages, unread } = await this.jobs.messagesOf(id, { reader: { clientId: client.id } });
    return { body: { messages: messages.map(machineMessage), unread } };
  }
  async postMessage({ client, req }, id) {
    await this.#ownJob(client, id);
    const { message } = await this.jobs.postMessage(id, await readBody(req), { from: { clientId: client.id } });
    return { status: 201, body: { message: machineMessage(message) } };
  }
  async readMessages({ client, req }, id) {
    await this.#ownJob(client, id);
    return { body: await this.jobs.readMessages(id, await readBody(req), { reader: { clientId: client.id } }) };
  }
  async answer({ client, req }, id) {
    await this.#ownJob(client, id);
    const { job } = await this.jobs.answer(id, await readBody(req), { by: 'machine', clientId: client.id });
    return { body: { job: machineJob(job) } };
  }
  async eventPage({ client, params }) {
    const own = await this.#ownSet(client), limit = count(params.get('limit'), 100);
    const page = await this.events.read({ after: seq(params.get('after')) ?? 0, limit, view: event => (own.has(event.jobId) ? machineEvent(event) : null) });
    return { body: { events: page.events, last: page.last, next: page.next, more: page.more, gap: page.gap, reset: page.reset } };
  }
  async eventStream({ client, res, params }) {
    if (this.#streams >= this.limits.streams) fail('Too many machine streams are open. Close one first.', 'STREAM_LIMIT', 429); // The owner's Activity views keep the rest.
    const own = await this.#ownSet(client);
    this.#streams++;
    res.once('close', () => { this.#streams--; });
    try { await this.events.stream({ res, after: seq(params.get('after')), client: `machine:${client.id}`, view: event => (own.has(event.jobId) ? machineEvent(event) : null) }); }
    catch (error) { if (!res.headersSent) throw error; res.destroy(); }
  }
}

const route = (method, path, permission, run) => Object.freeze({ method, pattern: new RegExp(`^/machine/v1${path}$`), permission, run });
/** Every machine route; the permission is checked before the handler runs. Jobs are always the client's own. */
export const MACHINE_ROUTES = Object.freeze([
  route('GET', '/agents', 'read_agents', MachineListener.prototype.agents),
  route('GET', `/agents/${AGENT}`, 'read_agents', MachineListener.prototype.agent),
  route('POST', '/jobs', 'submit_jobs', MachineListener.prototype.submit),
  route('GET', '/jobs', null, MachineListener.prototype.listJobs),
  route('GET', `/jobs/${JOB}`, null, MachineListener.prototype.getJob),
  route('POST', `/jobs/${JOB}/cancel`, 'cancel_own_jobs', MachineListener.prototype.cancel),
  route('GET', `/jobs/${JOB}/result`, 'read_job_result', MachineListener.prototype.result),
  route('GET', '/events', null, MachineListener.prototype.eventPage),
  route('GET', '/events/stream', null, MachineListener.prototype.eventStream),
  route('POST', `/jobs/${JOB}/children`, 'submit_jobs', MachineListener.prototype.children),
  route('GET', `/jobs/${JOB}/messages`, 'read_job_result', MachineListener.prototype.messages),
  route('POST', `/jobs/${JOB}/messages`, 'submit_jobs', MachineListener.prototype.postMessage),
  route('POST', `/jobs/${JOB}/messages/read`, 'read_job_result', MachineListener.prototype.readMessages),
  route('POST', `/jobs/${JOB}/answer`, 'submit_jobs', MachineListener.prototype.answer),
]);
