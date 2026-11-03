/**
 * Network → Activity's current picture (docs/network/architecture.md §8, §14 items 9–10, §19): each registered agent's
 * Network job status with what its CLI can report (coverage), the open jobs in the order they run, and the Kanban runs of
 * registered Base agents. Kanban runs are derived read-only from the board's own run records whose Base manifest pins a
 * registered agent: they are never journaled and the Supervisor is unchanged. Nothing here estimates progress or cost:
 * usage and cost appear only as the CLI reported them.
 */
import { PAGE_LIMIT } from './storage.mjs';

/**
 * What a Network job's CLI reports while it runs (architecture §7.2, §8): Claude Code's headless stream has tool calls,
 * Codex's only web searches and MCP calls, Gemini CLI's only the final answer. Antigravity and agents without a provider
 * cannot run Network jobs. The label is shown next to every live status.
 */
export const COVERAGE = Object.freeze({
  claude: { level: 'tools', label: 'Tool activity', note: 'Claude Code reports each tool call while a job runs, then its final result.' },
  codex: { level: 'partial-tools', label: 'Limited activity', note: 'Codex reports only its web searches and MCP calls while a job runs. Between them Promptboard cannot see what it does, so a running job may show no activity for a while; that is not a sign that it stopped.' },
  gemini: { level: 'final-only', label: 'Final result only', note: 'Gemini CLI reports nothing while a job runs. Promptboard sees only its final result, so a running job shows no activity until it ends.' },
  agy: { level: 'none', label: 'Not observable', note: 'Antigravity cannot run Network jobs, so nothing about it is observed here.' },
  unknown: { level: 'unknown', label: 'Unknown', note: 'No provider is set in Base, so Promptboard cannot say what a job of this agent would report.' },
});
export const coverageOf = provider => COVERAGE[Object.hasOwn(COVERAGE, provider) ? provider : 'unknown'];

/** Open job statuses, grouped into what the owner sees for an agent; the first group present is the agent's status. */
const GROUP = { waiting_for_input: 'waiting_for_input', unknown: 'unknown', interrupted: 'unknown', waiting_for_approval: 'waiting_for_approval', running: 'running', preparing: 'running', queued: 'queued' };
const ORDER = ['waiting_for_input', 'unknown', 'waiting_for_approval', 'running', 'queued'];
const QUEUE = 200, KANBAN = 50;
const ACTIVE_RUNS = new Set(['queued', 'running', 'waiting_for_input']);

/** Every page of a paged list (registrations, jobs of one status); both live in memory, so this reads no file twice. */
async function all(list, key) {
  const items = [];
  for (let offset = 0; offset !== null;) { const page = await list({ offset, limit: PAGE_LIMIT }); items.push(...page[key]); offset = page.next; }
  return items;
}
/** Usage only as reported: token counts and a cost when the CLI gave them; null means "not reported". */
function reported(usage) {
  if (!usage || typeof usage !== 'object' || usage.reported === false) return null;
  const number = value => (Number.isFinite(value) && value >= 0 ? value : null);
  const out = { inputTokens: number(usage.inputTokens), outputTokens: number(usage.outputTokens), cachedTokens: number(usage.cachedTokens), costUsd: number(usage.costUsd ?? usage.costUSD) };
  return Object.values(out).some(value => value !== null) ? out : null;
}
/** A job as the Activity view lists it: status and where it waits, never its input, prompt or result text. */
function jobRow(job) {
  const attempt = job.attempts.find(item => item.id === job.currentAttemptId) || job.attempts.at(-1) || null;
  return { id: job.id, status: job.status, agentId: job.agentId, ...(job.peerId ? { peerId: job.peerId } : {}), projectId: job.projectId, networkId: job.networkId, pipelineRunId: job.pipelineRunId ?? null, nodeId: job.nodeId ?? null,
    createdAt: job.createdAt, updatedAt: job.updatedAt, waiting: job.waiting, outcome: job.outcome, errorCode: job.errorCode, reason: job.reason,
    // Task 12: where it came from (a schedule, a delegating job, a client) and what it waits for; never the question or the sub-tasks.
    requester: job.requester, parentJobId: job.parentJobId ?? null, schedule: job.schedule ?? null, delegation: job.delegation ? { by: job.delegation.by, depth: job.delegation.depth } : null, awaiting: job.awaiting ? { kind: job.awaiting.kind } : null,
    attempt: attempt && { id: attempt.id, number: attempt.number, status: attempt.status, provider: attempt.provider, model: attempt.model, coverage: attempt.coverage,
      launchingAt: attempt.launchingAt, spawnedAt: attempt.spawnedAt, endedAt: attempt.endedAt, usage: reported(attempt.usage) }, live: job.live };
}

/**
 * Kanban runs of registered agents (architecture §14 item 10), newest first, at most 50 (every active one first): a run
 * belongs to an agent when its Base manifest pins the registration's Base resource. Read only: the board's run record is
 * not changed, and only its card, status and reported usage are shown.
 */
export function kanbanRuns(state, agents) {
  const byBase = new Map();
  for (const agent of agents) byBase.set(agent.baseResourceId, [...(byBase.get(agent.baseResourceId) || []), agent.id]);
  const tasks = new Map(), projects = new Map();
  for (const project of state?.projects || []) { projects.set(project.id, project.name); for (const task of project.tasks || []) tasks.set(task.id, task.title); }
  const rows = [];
  for (const run of (state?.runs || []).slice(-500)) {
    const agentIds = [...new Set((run.baseManifest?.profiles || []).flatMap(profile => byBase.get(profile?.resourceId) || []))];
    if (!agentIds.length) continue;
    rows.push({ runId: run.id, taskId: run.taskId, taskTitle: String(tasks.get(run.taskId) ?? '').slice(0, 200), projectId: run.projectId, projectName: projects.get(run.projectId) ?? null,
      stage: run.stage ?? null, status: run.status, active: ACTIVE_RUNS.has(run.status), provider: run.config?.provider ?? run.baseManifest?.provider ?? null, model: run.config?.model || null,
      createdAt: run.createdAt ?? null, updatedAt: run.updatedAt ?? run.createdAt ?? null, agentIds, usage: reported(run.usage) });
  }
  return rows.sort((a, b) => b.active - a.active || (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, KANBAN);
}

/**
 * GET /api/network/activity: `agents` (every registration with its status — waiting_for_input, unknown (needs your
 * decision), waiting_for_approval, running, queued or none — per-status counts, coverage and active Kanban runs),
 * `queue` (open jobs: those that need you first, then running, then queued in FIFO order; the first 200) with
 * `queueTotal`, `kanban` and the journal's `events` status. `board()` answers the board state.
 */
export async function activitySummary({ registry, jobs, events, board }) {
  const agents = await all(page => registry.listAgents(page), 'agents');
  const open = (await Promise.all(Object.keys(GROUP).map(status => all(page => jobs.list({ status, ...page }), 'jobs')))).flat();
  const kanban = kanbanRuns(await board(), agents);
  const rank = job => ORDER.indexOf(GROUP[job.status]);
  open.sort((a, b) => rank(a) - rank(b) || (a.waiting?.position ?? 0) - (b.waiting?.position ?? 0) || a.createdAt - b.createdAt);
  return {
    agents: agents.map(agent => {
      const mine = open.filter(job => job.agentId === agent.id), counts = Object.fromEntries(ORDER.map(group => [group, mine.filter(job => GROUP[job.status] === group).length]));
      return { agentId: agent.id, name: agent.displayName || agent.base.name || agent.baseResourceId, baseResourceId: agent.baseResourceId, provider: agent.base.provider ?? null,
        enabled: agent.enabled, stale: agent.base.stale, status: ORDER.find(group => counts[group]) || 'none', counts, coverage: coverageOf(agent.base.provider),
        kanbanActive: kanban.filter(run => run.active && run.agentIds.includes(agent.id)).length };
    }),
    queue: open.slice(0, QUEUE).map(jobRow), queueTotal: open.length, kanban, events: await events.status(),
  };
}
