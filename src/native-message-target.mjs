/** Private scheduling custody. Selecting a target never starts a run or grants terminal input. */
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

const LIVE = new Set(['queued', 'running', 'waiting_for_input']);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
const one = (rows, predicate) => { const matches = Array.isArray(rows) ? rows.filter(predicate) : []; return matches.length === 1 ? matches[0] : null; };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pinnedBase = manifest => ({ resources: (manifest?.resources || []).map(row =>
  Object.fromEntries(['resourceId', 'revision', 'revisionRef', 'required', 'kind', 'delivery'].map(field => [field, row[field]]))), profiles: manifest?.profiles || [] });

function facts(state, key) {
  if (!key || !['projectId', 'taskId', 'runId'].every(field => identifier(key[field]))) return null;
  const project = one(state?.projects, row => row.id === key.projectId);
  const task = one(project?.tasks, row => row.id === key.taskId);
  const run = one(state?.runs, row => row.id === key.runId);
  const session = one(state?.sessions, row => row.id === task?.sessionId);
  const column = one(project?.pipeline?.columns, row => row.id === task?.column);
  const nativeId = run?.providerSessionId || session?.nativeSessionId || null;
  if (!project || !task || !run || !session || project.workflowMode !== 'pipeline' || project.pipelineImport || column?.role !== 'active'
    || !Number.isSafeInteger(project.revision) || project.revision < 1 || !Number.isSafeInteger(task.contentRevision) || task.contentRevision < 1
    || task.archivedAt != null || task.deletedAt != null || !identifier(task.sessionId) || !identifier(session.id)
    || run.taskId !== task.id || run.projectId !== project.id || run.sessionId !== session.id || !LIVE.has(run.status)
    || session.taskId !== task.id || session.projectId !== project.id || session.currentRunId !== run.id || !LIVE.has(session.status)
    || session.pauseIntent != null || session.suspensionRequestedAt != null || !Array.isArray(session.runIds) || !session.runIds.includes(run.id)
    || one(state.runs, row => row.taskId === task.id && LIVE.has(row.status)) !== run
    || run.config?.pipeline !== true || !['claude', 'codex', 'gemini'].includes(run.config?.provider) || session.provider !== run.config.provider
    || digest(session.config) !== digest(run.config) || run.promptRevision !== task.contentRevision || typeof task.title !== 'string' || typeof task.prompt !== 'string'
    || typeof run.workspacePath !== 'string' || !isAbsolute(run.workspacePath) || task.workspace?.path !== run.workspacePath
    || session.workspacePath !== run.workspacePath || typeof run.branch !== 'string' || !run.branch
    || task.workspace?.branch !== run.branch || session.branch !== run.branch
    || !Number.isSafeInteger(state?.base?.revision) || state.base.revision < 0
    || nativeId !== null && (typeof nativeId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(nativeId))
    || run.providerSessionId && session.nativeSessionId && run.providerSessionId !== session.nativeSessionId) return null;
  // Polling fields, native activity, task order/revision and column names do not
  // select a different conversation. Configuration and content do.
  return { provider: run.config.provider, sessionId: session.id, runId: run.id, nativeId,
    fingerprint: digest({ projectRevision: project.revision, contentRevision: task.contentRevision, title: task.title, prompt: task.prompt,
      workspacePath: run.workspacePath, branch: run.branch, config: run.config, baseManifest: pinnedBase(run.baseManifest),
      baseRevision: state.base.revision, settings: state.settings ?? null,
      profileId: task.profileId ?? null, agentOverride: task.agentOverride ?? null,
      baseBinding: task.baseBinding ?? null, baseColumns: task.baseColumns ?? null, baseRevisionTask: task.baseRevision ?? null }) };
}

/** Returns only routing IDs and a private recheck; prompt/configuration facts stay inside its closure. */
export function captureNativeMessageTarget(state, key) {
  let captured;
  try { captured = facts(state, key); } catch { return null; }
  if (!captured) return null;
  let nativeId = captured.nativeId;
  key = Object.freeze(Object.fromEntries(['projectId', 'taskId', 'runId'].map(field => [field, key[field]])));
  return Object.freeze({ provider: captured.provider, sessionId: captured.sessionId, runId: captured.runId,
    matches(current) {
      try {
        const observed = facts(current, key);
        if (!observed || !['provider', 'sessionId', 'runId', 'fingerprint'].every(field => observed[field] === captured[field])
          || nativeId !== null && observed.nativeId !== nativeId) return false;
        // Queued runs learn their first native ID later. Once learned, it may
        // never disappear or switch within this captured process target.
        nativeId ??= observed.nativeId;
        return true;
      } catch { return false; }
    } });
}
