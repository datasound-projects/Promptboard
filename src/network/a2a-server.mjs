/**
 * Inbound A2A (docs/network/architecture.md §10.4, §11.1, §24): a private Agent Card and JSON-RPC endpoint on the machine
 * listener (rest.mjs), served only while inbound federation is on and at least one usable agent is published for A2A.
 * Callers are machine clients of `kind: 'a2a'` (Bearer pbm_…), scoped to published agents and their own tasks.
 *
 * An A2A task IS a Network job: SendMessage submits a job through the job engine (`source: 'a2a'`, the caller as requester,
 * idempotency key `a2a:<messageId>`), so the same limits, worker, approvals and audit apply, and no CLI is ever started from
 * here. The task ID is the job ID; GetTask and CancelTask read and cancel that job. Status and artifacts come only from the
 * job: its state, and its hash-checked result text and json once completed — never its request, prompt, memory, attempts,
 * process IDs or files. The SDK's `JsonRpcTransportHandler` parses and answers JSON-RPC; the handler below replaces the
 * SDK's DefaultRequestHandler (whose tasks live in an in-memory store keyed by its own IDs) so that the job, which survives
 * a restart, stays the only record. Streaming, push notifications, task lists and follow-up messages are not offered.
 */
import { AgentCard, Role, TaskState } from '@a2a-js/sdk';
import { A2AError, ContentTypeNotSupportedError, ExtendedAgentCardNotConfiguredError, PushNotificationNotSupportedError, RequestMalformedError, TaskNotCancelableError, TaskNotFoundError,
  UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { JsonRpcTransportHandler, ServerCallContext } from '@a2a-js/sdk/server';
import { JOB_LIMITS } from './jobs.mjs';
import { NetworkError } from './storage.mjs';

/** How a job's status reads as an A2A task state. `unknown`/`interrupted` wait for the owner: the protocol's unspecified state. */
export const TASK_STATES = Object.freeze({ queued: TaskState.TASK_STATE_SUBMITTED, waiting_for_approval: TaskState.TASK_STATE_SUBMITTED, preparing: TaskState.TASK_STATE_WORKING,
  running: TaskState.TASK_STATE_WORKING, waiting_for_input: TaskState.TASK_STATE_WORKING, completed: TaskState.TASK_STATE_COMPLETED, failed: TaskState.TASK_STATE_FAILED,
  cancelled: TaskState.TASK_STATE_CANCELED, interrupted: TaskState.TASK_STATE_UNSPECIFIED, unknown: TaskState.TASK_STATE_UNSPECIFIED });
const SAYS = { waiting_for_approval: 'Waiting for the owner of this Promptboard to approve the task.', failed: 'The task failed.', cancelled: 'The task was cancelled.',
  interrupted: 'The outcome of this task is not known. The owner of this Promptboard decides whether it runs again.', unknown: 'The outcome of this task is not known. The owner of this Promptboard decides whether it runs again.' };
const ENDED = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'unknown']);
/** A blocking send returns once the job ended or waits for the owner (approval, input): nothing more happens without them. */
const SETTLED = new Set([...ENDED, 'waiting_for_approval', 'waiting_for_input']);
const MESSAGE_ID = /^[^\u0000-\u001f\u007f]{1,150}$/, AGENT_ID = /^agt_[0-9a-f]{20}$/;
const text = value => ({ content: { $case: 'text', value }, metadata: undefined, filename: '', mediaType: 'text/plain' });
const agentMessage = (job, said) => ({ messageId: `${job.id}-status`, contextId: job.id, taskId: job.id, role: Role.ROLE_AGENT, parts: [text(said)], metadata: undefined, extensions: [], referenceTaskIds: [] });
const nameOf = agent => agent.displayName || agent.base.name || agent.baseResourceId;

export class A2AInbound {
  /** `registry` (its `federation` lists what is published), `jobs` (the job engine). `waitMs`/`pollMs` bound a blocking send. */
  constructor({ registry, jobs, waitMs = 10 * 60_000, pollMs = 500 }) { Object.assign(this, { registry, jobs, waitMs, pollMs }); }

  /** The published agents a caller could use now: inbound on, registered, switched on and not stale. */
  async published() {
    const { enabled, agents } = await this.registry.federation.inbound();
    if (!enabled) return [];
    const out = [];
    for (const entry of agents) {
      try { const { agent } = await this.registry.agent(entry.agentId); if (agent.enabled && !agent.base.stale) out.push({ entry, agent }); } catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
    }
    return out;
  }
  /** The Agent Card (A2A 1.0 JSON), or null while nothing is published: then the route does not exist. */
  async card(port) {
    const published = await this.published();
    if (!published.length) return null;
    return AgentCard.toJSON({ name: 'Promptboard', description: 'Agents the owner of this Promptboard published for A2A. Each task runs as one read-only Network job on the owner’s computer.',
      supportedInterfaces: [{ url: `http://127.0.0.1:${port}/a2a/v1`, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' }], provider: undefined, version: '1',
      capabilities: { streaming: false, pushNotifications: false, extensions: [], extendedAgentCard: false },
      securitySchemes: { promptboard: { scheme: { $case: 'httpAuthSecurityScheme', value: { description: 'A client token of kind a2a, created in Promptboard → Network → Federation.', scheme: 'Bearer', bearerFormat: '' } } } },
      securityRequirements: [{ schemes: { promptboard: { list: [] } } }], defaultInputModes: ['text/plain', 'application/json'], defaultOutputModes: ['text/plain', 'application/json'],
      skills: published.map(({ entry, agent }) => ({ id: agent.id, name: nameOf(agent), description: entry.description || `Runs ${nameOf(agent)} on one task.`, tags: agent.tags, examples: [], inputModes: [], outputModes: [], securityRequirements: [] })),
      signatures: [] });
  }
  /** One JSON-RPC request of an authenticated A2A caller; answers the JSON-RPC response. `signal` ends a blocking wait. */
  async handle(body, { client, signal, allowSubmit }) {
    const transport = new JsonRpcTransportHandler(new Handler(this, client, signal, allowSubmit));
    const answer = await transport.handle(body, new ServerCallContext({ user: { isAuthenticated: true, userName: client.id }, requestedVersion: '1.0' }));
    if (answer && typeof answer[Symbol.asyncIterator] === 'function') { // Streaming methods: refused before any event.
      let error = new UnsupportedOperationError('Streaming is not offered. Send SendMessage and read the task with GetTask.');
      try { await answer.next(); } catch (caught) { error = caught; }
      return { jsonrpc: '2.0', id: body?.id ?? null, error: JsonRpcTransportHandler.mapToJSONRPCError(error instanceof A2AError ? error : new A2AError('The request failed.')) };
    }
    return answer;
  }
}

/** The A2A request handler for one caller and one request: every answer is about the caller's own jobs only. */
class Handler {
  constructor(inbound, client, signal, allowSubmit) { Object.assign(this, { inbound, client, signal, allowSubmit }); }
  #may(permission) { if (!this.client.scopes.permissions.includes(permission)) throw new UnsupportedOperationError('This caller does not have permission for this operation.'); }
  /** Fixed messages only: a job-engine refusal keeps its own (fixed) text; anything unexpected says nothing about the inside. */
  #safe(error) {
    if (error instanceof A2AError) return error;
    if (error instanceof NetworkError) return error.status === 404 ? new TaskNotFoundError('This task does not exist.') : error.status === 413 || error.status === 400 ? new RequestMalformedError(error.message) : new UnsupportedOperationError(error.message);
    return new A2AError('The request failed. Nothing was changed.');
  }
  async #ownJob(id) {
    let job;
    try { ({ job } = await this.inbound.jobs.read(id)); } catch { throw new TaskNotFoundError('This task does not exist.'); }
    if (job.requester?.kind !== 'a2a' || job.requester.id !== this.client.id) throw new TaskNotFoundError('This task does not exist.'); // Another caller's or the owner's job looks missing.
    return job;
  }
  /** The A2A task of a job: its state, a fixed status line, and for a completed job its result as one artifact. */
  async #task(job) {
    const said = SAYS[job.status] ? `${SAYS[job.status]}${job.errorCode && job.status !== 'cancelled' ? ` (${job.errorCode})` : ''}` : '';
    const artifacts = [];
    if (job.status === 'completed' && this.client.scopes.permissions.includes('read_job_result')) {
      const result = await this.inbound.jobs.result(job.id);
      artifacts.push({ artifactId: 'result', name: 'result', description: '', parts: [text(result.text), ...(result.json !== null ? [{ content: { $case: 'data', value: result.json }, metadata: undefined, filename: '', mediaType: 'application/json' }] : [])], metadata: undefined, extensions: [] });
    }
    return { id: job.id, contextId: job.id, status: { state: TASK_STATES[job.status] ?? TaskState.TASK_STATE_UNSPECIFIED, message: said ? agentMessage(job, said) : undefined, timestamp: new Date(job.updatedAt).toISOString() },
      artifacts, history: [], metadata: undefined };
  }

  async getAgentCard() { throw new UnsupportedOperationError('Read the Agent Card at /.well-known/agent-card.json.'); }
  async getAuthenticatedExtendedAgentCard() { throw new ExtendedAgentCardNotConfiguredError('There is no extended Agent Card.'); }
  /**
   * A new task: one message to one published agent this caller may use (`metadata.skillId` names it; with exactly one, it
   * is chosen), text parts as the job input and one data part as its json. Files are refused and never fetched. The same
   * messageId from the same caller answers the same task. Blocking (the default) waits until the job ends or waits for the
   * owner, at most 10 minutes.
   */
  async sendMessage(params) {
    try {
      this.#may('submit_jobs');
      const message = params.message;
      if (!message || typeof message.messageId !== 'string' || !MESSAGE_ID.test(message.messageId)) throw new RequestMalformedError('Send a message with a messageId of 1 to 150 printable characters.');
      if (message.taskId) throw new UnsupportedOperationError('Promptboard tasks take one message. Send a new message without a taskId.');
      const published = (await this.inbound.published()).filter(({ agent }) => this.client.scopes.agents.includes(agent.id));
      const asked = params.metadata?.skillId ?? message.metadata?.skillId;
      const chosen = asked === undefined && published.length === 1 ? published[0] : published.find(({ agent }) => typeof asked === 'string' && AGENT_ID.test(asked) && agent.id === asked);
      if (!chosen) throw new RequestMalformedError(published.length ? 'Name a skill of the Agent Card that this caller may use in metadata.skillId.' : 'No agent is published for this caller.');
      const texts = [];
      let json;
      for (const part of message.parts || []) {
        const content = part?.content;
        if (content?.$case === 'text') texts.push(String(content.value));
        else if (content?.$case === 'data' && json === undefined && content.value && typeof content.value === 'object') json = content.value;
        else throw new ContentTypeNotSupportedError('Send text parts and at most one JSON data part. Files and links are not accepted.');
      }
      const input = texts.join('\n\n').trim();
      if (!input) throw new RequestMalformedError('Send the task as text.');
      if (Buffer.byteLength(input) > JOB_LIMITS.inputBytes || (json !== undefined && Buffer.byteLength(JSON.stringify(json)) > JOB_LIMITS.jsonBytes)) throw new RequestMalformedError(`A task holds at most ${JOB_LIMITS.inputBytes / 1024} KiB of text and ${JOB_LIMITS.jsonBytes / 1024} KiB of JSON.`);
      if (!this.allowSubmit()) throw new UnsupportedOperationError('Too many tasks were sent. Wait a minute.');
      const memory = this.client.scopes.permissions.includes('read_scoped_memory') ? 'agent' : 'none';
      const accepted = await this.inbound.jobs.submit({ agentId: chosen.agent.id, input: { text: input, ...(json !== undefined ? { json } : {}) }, permissions: { memory },
        requireApproval: chosen.entry.requireApproval, idempotencyKey: `a2a:${message.messageId}` }, { requester: { kind: 'a2a', id: this.client.id } });
      let job = accepted.job;
      if (params.configuration?.returnImmediately !== true) {
        const until = Date.now() + this.inbound.waitMs;
        while (!SETTLED.has(job.status) && Date.now() < until && !this.signal?.aborted) {
          await new Promise(resolve => { const timer = setTimeout(resolve, this.inbound.pollMs); timer.unref?.(); });
          ({ job } = await this.inbound.jobs.read(job.id));
        }
      }
      return await this.#task(job);
    } catch (error) { throw this.#safe(error); }
  }
  async getTask(params) {
    try { return await this.#task(await this.#ownJob(params.id)); } catch (error) { throw this.#safe(error); }
  }
  /** Cancel an own task that has not ended (`cancel_own_jobs`); answers the job's state after the cancel. */
  async cancelTask(params) {
    try {
      this.#may('cancel_own_jobs');
      const job = await this.#ownJob(params.id);
      if (ENDED.has(job.status)) throw new TaskNotCancelableError('This task has already ended.');
      const { job: after } = await this.inbound.jobs.cancel(job.id, {}, { by: 'machine' });
      return await this.#task(after);
    } catch (error) { throw this.#safe(error); }
  }
  async *sendMessageStream() { throw new UnsupportedOperationError('Streaming is not offered. Send SendMessage and read the task with GetTask.'); }
  async *resubscribe() { throw new UnsupportedOperationError('Streaming is not offered. Read the task with GetTask.'); }
  async listTasks() { throw new UnsupportedOperationError('Listing tasks is not offered. Keep the task IDs you receive.'); }
  async createTaskPushNotificationConfig() { throw new PushNotificationNotSupportedError('Push notifications are not offered: Promptboard never calls a caller back.'); }
  async getTaskPushNotificationConfig() { throw new PushNotificationNotSupportedError('Push notifications are not offered.'); }
  async listTaskPushNotificationConfigs() { throw new PushNotificationNotSupportedError('Push notifications are not offered.'); }
  async deleteTaskPushNotificationConfig() { throw new PushNotificationNotSupportedError('Push notifications are not offered.'); }
}
