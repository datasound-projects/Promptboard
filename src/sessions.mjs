/** Durable conversations are separate from individual process runs. No process starts here. */
import { randomUUID } from 'node:crypto';

export const LIVE_SESSION_STATUSES = new Set(['queued', 'running', 'waiting_for_input']);
const PROVIDERS = new Set(['claude', 'codex', 'gemini']);

function sessionStatus(run) {
  if (LIVE_SESSION_STATUSES.has(run.status)) return run.status;
  return run.status === 'interrupted' ? 'orphaned' : 'exited';
}

/** Called inside the same Store update that publishes a run. Historical stage runs stay separate. */
export function attachSession(state, run, id = randomUUID()) {
  const session = {
    id, taskId: run.taskId, projectId: run.projectId, provider: run.config.provider,
    nativeSessionId: run.providerSessionId || null, status: sessionStatus(run), pauseIntent: null,
    config: structuredClone(run.config), workspacePath: run.workspacePath || null, branch: run.branch || null,
    createdAt: run.createdAt || 0, updatedAt: run.updatedAt || run.createdAt || 0,
    currentRunId: run.id, runIds: [run.id],
    artifacts: [{ runId: run.id, directory: run.artifactsDir || null }],
    lastRunStatus: run.status,
  };
  run.sessionId = id;
  state.sessions.push(session);
  const task = state.projects.find(project => project.id === run.projectId)?.tasks?.find(task => task.id === run.taskId);
  if (task) task.sessionId = id;
  return session;
}

/** Migration is deterministic and never merges distinct legacy stage conversations. */
export function migrateSessions(state) {
  state.sessions = [];
  for (const run of state.runs) {
    if (typeof run.id !== 'string' || typeof run.taskId !== 'string' || typeof run.projectId !== 'string' || !PROVIDERS.has(run.config?.provider)) continue;
    attachSession(state, run, `legacy-${run.id}`);
  }
  return state;
}

/** Keep the logical conversation synchronized without changing historical process outcomes. */
export function synchronizeSession(state, run) {
  const session = state.sessions.find(item => item.id === run.sessionId);
  if (!session || session.currentRunId !== run.id) return;
  session.status = sessionStatus(run);
  session.lastRunStatus = run.status;
  session.updatedAt = run.updatedAt;
  if (run.providerSessionId) session.nativeSessionId = run.providerSessionId;
  if (run.endedAt !== undefined) session.lastEndedAt = run.endedAt;
}

export function recoverSessions(state, now = Date.now()) {
  for (const session of state.sessions) if (LIVE_SESSION_STATUSES.has(session.status)) {
    session.status = 'orphaned';
    session.updatedAt = now;
    session.reason = 'The app stopped while this session was active.';
  }
}
