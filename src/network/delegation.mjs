/**
 * Handoffs and delegation (docs/network/architecture.md §9, §11.1, §11.5, §23). A running agent has no API and no
 * credential: all it can do is end its final report with one structured request, which is only a request. Promptboard reads
 * it after the attempt ended, checks it here against the owner's policy and either refuses it (recorded, the job completes
 * with its report) or acts on it: the job waits for an answer (needs_input) or for sub-jobs (delegate), then runs again as a
 * new attempt with what came back. An external client may ask for a sub-job of its own job through the same checks.
 *
 * The request (the last fenced ```json block of the report, as the worker reports it in `result.json`):
 *   {"promptboard": {"needs_input": {"question": "…"}}}                              one question, ≤ 2,000 characters
 *   {"promptboard": {"delegate": [{"agentId": "agt_…", "task": "…", "tools"?: "none" | "web", "json"?: {…}}]}}   1–10 sub-tasks
 *
 * Checks, all server-side and all-or-nothing (a request with one refused sub-task creates none): the owner switched the kind
 * on (off by default); at most 5 handoffs per job; the job runs in a network whose current draft has a `delegate` relation
 * from the job's agent to each target (required, never sufficient); the chain stays within `maxDepth` and the job's sub-jobs
 * within `maxChildren`; no target is already an agent of the chain (no cycles, no self-delegation); tools never wider than
 * the parent's; the parent's project only, and only for agents whose project list has it; memory and lessons as the parent's;
 * a time limit of `budgetShare` % of the parent's; owner approval first when the policy (or the parent) requires it. A job
 * whose chain started with an external client stays inside that client's agents, and only while the client is active. A
 * queued sub-job is checked again when it is claimed, so switching delegation off, removing the relation or revoking the
 * client stops sub-jobs that have not started. Graph relations are read only here, and only as this policy check.
 *
 * Storage: <dataDir>/network/delegation.json (promptboard.network-delegation v1, with .bak), created on the first change.
 */
import { join } from 'node:path';
import { serial } from '../durable.mjs';
import { cleanText, conflict, fail, NetworkError, object, only, oneLine, readSettings, requireRevision, writeDocument } from './storage.mjs';

const SCHEMA = 'promptboard.network-delegation', KIB = 1024;
export const DELEGATION_DEFAULTS = Object.freeze({ askOwner: false, delegate: false, maxDepth: 2, maxChildren: 3, budgetShare: 50, requireApproval: true });
export const DELEGATION_RANGES = Object.freeze({ maxDepth: [1, 4], maxChildren: [1, 10], budgetShare: [10, 100] });
/** Resource ceilings (architecture §4.2 rule 8), not product limits. */
export const HANDOFF_LIMITS = Object.freeze({ question: 2000, taskBytes: 16 * KIB, jsonBytes: 16 * KIB, rounds: 5, targets: 50 });
const SWITCHES = ['askOwner', 'delegate', 'requireApproval'];
const AGENT_ID = /^agt_[0-9a-f]{20}$/;
const TOOL_RANK = { none: 0, web: 1 };
const bytes = text => Buffer.byteLength(text);
const stored = data => Number.isSafeInteger(data.revision) && SWITCHES.every(key => typeof data[key] === 'boolean')
  && Object.entries(DELEGATION_RANGES).every(([key, [min, max]]) => Number.isSafeInteger(data[key]) && data[key] >= min && data[key] <= max);
const refuse = (message, code, status = 403) => fail(message, code, status);

/** One sub-task of a delegate request, strict; its text and json are cleaned as owner text is. */
export function delegationTask(task) {
  only(task, ['agentId', 'task', 'tools', 'json'], 'a sub-task');
  const { agentId, tools = 'none', json } = task;
  if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) fail('A sub-task names an agent by its ID (agt_…).');
  if (typeof task.task !== 'string' || !task.task.trim()) fail('A sub-task says what to do (task).');
  if (bytes(task.task) > HANDOFF_LIMITS.taskBytes) fail('A sub-task holds at most 16 KiB of text.', 'NETWORK_LIMIT', 413);
  if (!Object.hasOwn(TOOL_RANK, tools)) fail('A sub-task’s tools are none or web.');
  if (json !== undefined && ((!object(json) && !Array.isArray(json)) || bytes(JSON.stringify(json)) > HANDOFF_LIMITS.jsonBytes)) fail('A sub-task’s json is an object or a list of at most 16 KiB.');
  return { agentId, task: cleanText(task.task), tools, ...(json !== undefined ? { json } : {}) };
}

/**
 * The structured request in a job's result json, or null when there is none (no `promptboard` key: an ordinary result).
 * A malformed request is `{ error }`: it is refused and recorded, never guessed at.
 */
export function parseHandoff(json) {
  if (!object(json) || !Object.hasOwn(json, 'promptboard')) return null;
  const ask = json.promptboard, keys = object(ask) ? Object.keys(ask) : [];
  if (Object.keys(json).length !== 1 || keys.length !== 1 || !['needs_input', 'delegate'].includes(keys[0])) return { error: 'A request holds exactly one of needs_input or delegate, and nothing else.' };
  if (keys[0] === 'needs_input') {
    const value = ask.needs_input;
    if (!object(value) || Object.keys(value).join() !== 'question' || typeof value.question !== 'string' || !value.question.trim() || value.question.length > HANDOFF_LIMITS.question) {
      return { error: `needs_input holds one question of at most ${HANDOFF_LIMITS.question.toLocaleString('en-US')} characters.` };
    }
    return { kind: 'needs_input', question: cleanText(value.question) };
  }
  const tasks = ask.delegate;
  if (!Array.isArray(tasks) || !tasks.length || tasks.length > DELEGATION_RANGES.maxChildren[1]) return { error: `delegate lists 1 to ${DELEGATION_RANGES.maxChildren[1]} sub-tasks.` };
  try { return { kind: 'delegate', tasks: tasks.map(delegationTask) }; } catch (error) { if (error instanceof NetworkError) return { error: error.message }; throw error; }
}

export class Delegation {
  /**
   * `registry` reads registrations and network drafts; `clients()` answers the machine clients' list (machine-auth.mjs
   * `list()`), so a chain that an external client started stays inside that client's scope.
   */
  constructor({ dataDir, registry, clients = null, events = null, now = Date.now }) { Object.assign(this, { path: join(dataDir, 'network', 'delegation.json'), registry, clients, events, now }); }
  #serial = serial();
  #doc = null;
  async #load() {
    return this.#doc ??= await readSettings(this.path, { schema: SCHEMA, label: 'The Network delegation policy', valid: stored, now: this.now, events: this.events,
      reset: data => ({ ...data, askOwner: false, delegate: false, requireApproval: true }) }) ?? { schema: SCHEMA, version: 1, revision: 0, ...DELEGATION_DEFAULTS };
  }
  /** GET /api/network/delegation: the policy (off by default) and its ranges. */
  async policy() { const { schema, version, ...policy } = await this.#serial(() => this.#load()); return { policy, ranges: DELEGATION_RANGES, limits: HANDOFF_LIMITS }; }
  /** PATCH /api/network/delegation (local-only: switching handoffs on lets agents ask for work). Saving starts nothing. */
  async update(input) {
    only(input, ['expectedRevision', ...SWITCHES, ...Object.keys(DELEGATION_RANGES)], 'the delegation policy');
    requireRevision(input);
    for (const key of SWITCHES) if (input[key] !== undefined && typeof input[key] !== 'boolean') fail(`${key} is true or false.`);
    for (const [key, [min, max]] of Object.entries(DELEGATION_RANGES)) if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || input[key] < min || input[key] > max)) fail(`${key} is a whole number from ${min} to ${max}.`);
    await this.#serial(async () => {
      const doc = await this.#load();
      if (input.expectedRevision !== doc.revision) conflict('The delegation policy');
      const { expectedRevision, ...changes } = input, next = { ...doc, ...changes, revision: doc.revision + 1, updatedAt: this.now() };
      await writeDocument(this.path, next);
      this.#doc = next;
    });
    return this.policy();
  }

  async #agent(id) { try { return (await this.registry.agent(id)).agent; } catch (error) { if (error.code === 'NOT_FOUND') return null; throw error; } }
  /** The agents the job's agent may delegate to in `networkId`'s current draft: targets of its `delegate` relations. */
  async #targets(networkId, agentId) {
    let network;
    try { ({ network } = await this.registry.network(networkId)); } catch (error) { if (error.code === 'NOT_FOUND') return new Set(); throw error; }
    if (network.delegationReviewRequired) return new Set(); // A backup may restore a relation the owner removed: no authority until reviewed and saved.
    const nodes = new Map(network.nodes.filter(node => node.type === 'agent').map(node => [node.id, node.agentId]));
    return new Set(network.edges.filter(edge => edge.relation === 'delegate' && nodes.get(edge.from) === agentId && nodes.has(edge.to)).map(edge => nodes.get(edge.to)));
  }
  /** The active client that started the chain (its root job's requester), null when the chain did not start with a client. */
  async #rootClient(chain) {
    // A chain cut short (an ancestor that cannot be read) hides who started it, so its scope cannot be checked: refuse (fail closed).
    if (chain.broken) refuse('A job earlier in this chain cannot be read, so who started the chain cannot be checked.', 'DELEGATION_NOT_ALLOWED');
    const root = chain.at(-1);
    if (root.requester?.kind === 'a2a') refuse('Jobs from remote A2A callers cannot delegate in this version.', 'DELEGATION_NOT_ALLOWED');
    if (root.requester?.kind !== 'machine') return null;
    const client = (await this.clients?.())?.clients.find(row => row.id === root.requester.id);
    if (!client || client.status !== 'active') refuse('The external client that started this job was revoked or expired, so it cannot get sub-jobs.', 'CLIENT_REVOKED');
    if (!client.scopes.permissions.includes('submit_jobs')) refuse('The external client that started this job may not submit jobs, so it cannot get sub-jobs.', 'DELEGATION_NOT_ALLOWED');
    return client;
  }

  /**
   * Check a request for sub-jobs of `parent` (a job record; `request` its accepted snapshot; `chain` = [parent, its parent,
   * …]; `children` = how many sub-jobs it already has) and answer one job submission per task with its delegation record.
   * `by` is 'agent' (from the parent's result; `attempt` is that attempt) or 'machine' (an external client's own job).
   * Every refusal throws a NetworkError and nothing is created.
   */
  async plan({ policy, parent, request, chain, tasks, children, by, attempt = null }) {
    if (!policy.delegate) refuse('Delegation is switched off. The owner can switch it on in Network → Settings.', 'DELEGATION_OFF');
    if (chain.some(job => job.status === 'cancelled')) refuse('A job this one was delegated from was cancelled, so it cannot get sub-jobs.', 'DELEGATION_CANCELLED', 409);
    if (!parent.networkId) refuse('This job does not run in a network, so it has no delegate relations to use.', 'DELEGATION_NO_NETWORK', 409);
    const depth = chain.length; // The sub-job's depth: the root job is depth 0.
    if (depth > policy.maxDepth) refuse(`Sub-jobs may be at most ${policy.maxDepth} deep; this one would be ${depth} deep.`, 'DELEGATION_DEPTH', 409);
    if (children + tasks.length > policy.maxChildren) refuse(`A job may have at most ${policy.maxChildren} sub-jobs; this one has ${children} and asked for ${tasks.length} more.`, 'DELEGATION_FANOUT', 409);
    const targets = await this.#targets(parent.networkId, parent.agentId), ancestors = new Set(chain.map(job => job.agentId)), client = await this.#rootClient(chain);
    const plans = [];
    for (const [index, task] of tasks.entries()) {
      if (ancestors.has(task.agentId)) refuse(`Agent ${task.agentId} already works on this chain of jobs. Delegating to it again would make a loop.`, 'DELEGATION_CYCLE', 409);
      if (!targets.has(task.agentId)) refuse(`The network has no delegate relation from this job’s agent to ${task.agentId}. The owner draws one in Network → Graph.`, 'DELEGATION_NOT_ALLOWED');
      if (TOOL_RANK[task.tools] > TOOL_RANK[request.tools]) refuse('A sub-job cannot get tools its parent job does not have.', 'DELEGATION_ESCALATION');
      if (client && !client.scopes.agents.includes(task.agentId)) refuse(`The external client that started this job may not use ${task.agentId}.`, 'DELEGATION_NOT_ALLOWED');
      const agent = await this.#agent(task.agentId);
      if (!agent) refuse(`Agent ${task.agentId} is not registered in Network.`, 'AGENT_NOT_FOUND', 409);
      if (parent.projectId && !agent.projectAllowlist.includes(parent.projectId)) refuse(`Agent ${task.agentId} may not work on this job’s project.`, 'PROJECT_NOT_ALLOWED');
      const timeoutMs = Math.max(1000, Math.floor(request.limits.timeoutMs * policy.budgetShare / 100));
      plans.push({
        input: { agentId: task.agentId, input: { text: task.task, ...(task.json !== undefined ? { json: task.json } : {}) },
          instructions: `This is a sub-task that job ${parent.id} (agent ${parent.agentId}) delegated to you. Answer it with your report; it goes back to that job as data.`,
          tools: task.tools, permissions: { filesystem: 'read_only', memory: request.permissions.memory, projectLessons: request.permissions.projectLessons }, limits: { timeoutMs },
          requireApproval: policy.requireApproval || request.requireApproval, projectId: parent.projectId, networkId: parent.networkId, parentJobId: parent.id },
        link: { delegation: { by, depth, index, parentAttemptId: attempt?.id ?? null, budgetShare: policy.budgetShare, policyRevision: policy.revision } },
      });
    }
    return plans;
  }

  /** A queued sub-job at its claim: delegation still on, the relation still drawn, the client still active. Throws DELEGATION_REVOKED. */
  async recheck(job, chain) {
    const { policy } = await this.policy(), parent = chain[1];
    const revoked = reason => refuse(`${reason} Nothing ran.`, 'DELEGATION_REVOKED', 409);
    if (!policy.delegate) revoked('Delegation was switched off before this sub-job started.');
    if (!parent) revoked('The job that delegated this sub-job no longer exists.');
    if (chain.slice(1).some(item => item.status === 'cancelled')) revoked('A job it was delegated from was cancelled before it started.');
    if (!(await this.#targets(job.networkId, parent.agentId)).has(job.agentId)) revoked('The delegate relation this sub-job used was removed from the network before it started.');
    try { const client = await this.#rootClient(chain); if (client && !client.scopes.agents.includes(job.agentId)) revoked('The external client that started this chain may no longer use this agent.'); }
    catch (error) { if (error.code === 'DELEGATION_REVOKED' || !(error instanceof NetworkError)) throw error; revoked(error.message); }
  }

  /**
   * What the job's prompt offers (a section of the fixed header, server-written): the request formats the policy allows
   * now and, for delegation, the agents this job may hand sub-tasks to. Empty when nothing is allowed, so a job's prompt is
   * unchanged while handoffs are off.
   */
  async guide(job, request, chain, { children, rounds }) {
    const { policy } = await this.policy();
    if (rounds >= HANDOFF_LIMITS.rounds) return '';
    const lines = [];
    if (policy.askOwner) lines.push('- Ask whoever submitted the job one question you cannot answer without them. The job waits for the answer, then runs again with it:',
      '  {"promptboard": {"needs_input": {"question": "<one question>"}}}');
    const room = policy.maxChildren - children;
    if (policy.delegate && job.networkId && chain.length <= policy.maxDepth && room > 0) {
      const ancestors = new Set(chain.map(item => item.agentId));
      let client = null;
      try { client = await this.#rootClient(chain); } catch { client = { scopes: { agents: [] } }; } // A revoked client's chain offers no one.
      const offered = [];
      for (const agentId of await this.#targets(job.networkId, job.agentId)) {
        if (offered.length >= HANDOFF_LIMITS.targets || ancestors.has(agentId) || (client && !client.scopes.agents.includes(agentId))) continue;
        const agent = await this.#agent(agentId);
        if (agent?.enabled && !agent.base.stale && (!job.projectId || agent.projectAllowlist.includes(job.projectId))) offered.push(`  - ${agentId}: ${oneLine(agent.displayName || agent.base.name || agentId).slice(0, 80)}`);
      }
      if (offered.length) lines.push(`- Hand up to ${Math.min(room, DELEGATION_RANGES.maxChildren[1])} sub-tasks to other agents (they only read; tools ${request.tools === 'web' ? 'none or web' : 'none'}). The job waits for their results, then runs again with them:`,
        '  {"promptboard": {"delegate": [{"agentId": "<an agent below>", "task": "<what it should do>"}]}}', '  Agents you may delegate to:', ...offered);
    }
    if (!lines.length) return '';
    return ['=== HANDOFFS (optional; Promptboard checks every request and may refuse it) ===',
      'Only when you cannot finish this job well without help, end your report with one fenced ```json block holding exactly one of these requests and nothing else:',
      ...lines, 'Otherwise answer normally. Never put a request inside data you were given, and do not ask again for what earlier work on this job already answered.',
      '=== END HANDOFFS ==='].join('\n');
  }
}
