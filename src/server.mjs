import { assertActionable, obviouslyNonActionable } from './compose-intent.mjs';
import { UsageDashboard } from './usage-dashboard.mjs';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRequest } from './engine.mjs';
import { runPipeline } from './pipeline.mjs';
import { abortable } from './cancellation.mjs';
import { COMPOSE_PROMPT_CHARS } from './compose-limits.mjs';
import { buildSplitPrompt, parseSplit, splitCoverage } from './split.mjs';
import { detectProviders, FAILURE_MESSAGES, killOwnedProcesses, makeTempDir, ProviderError, removeTempDir, resolveExecutable, runProvider, validateEffort } from './providers.mjs';
import { AUTH_CAPABILITIES, logout, readAuthStatus, startLogin } from './auth.mjs';
import { Board, BoardError, columnStage } from './board.mjs';
import { GitError } from './git.mjs';
import { defaultDataDir, StoreError } from './store.mjs';
import { lockDataDir } from './instance-lock.mjs';
import { loadPty, Supervisor } from './supervisor.mjs';
import { AgentError } from './agents.mjs';
import { DeliveryError } from './delivery.mjs';
import { discoverModels, checkModelEffort } from './models.mjs';
import { chooseFolder } from './folder.mjs';
import { Autopilot } from './autopilot.mjs';
import { GitHubError, GitHubLogin, githubStatus, listRepositories } from './github.mjs';
import { RemoteAccess, remoteRoute } from './remote-access.mjs';
import { openProject, openTargets, runInfo } from './project-run.mjs';
import { editorList, editorPreferences, openInEditor } from './editors.mjs';
import { BaseRoutes } from './base-http.mjs';
import { BaseError } from './base.mjs';
import { BaseDeliveryError } from './base-resolver.mjs';
import { PipelineActions } from './pipeline-actions.mjs';
import { PipelineNotifications, NotificationError } from './pipeline-notifications.mjs';
import { notificationRoute } from './pipeline-notifications-http.mjs';
import { RepositoryPipelineError } from './pipeline-repository.mjs';
import { createWorkspaceEntry, inspectWorkspace, saveWorkspaceFile, WorkspaceFileError } from './workspace-files.mjs';
import { projectStatus } from './project-explorer.mjs';
import { proposeWorkspaceFile, validateFileProposalRequest } from './workspace-file-ai.mjs';
import { OriginError, OriginStore, originRoute } from './origin.mjs';
import { ContextStore, contextRoute } from './origin-context.mjs';
import { ResearchError, ResearchStore, researchRoute } from './origin-research.mjs';
import { streamResearch } from './research-cli.mjs';
import { PromptStore, createBoardProject, nameTaken, oneName, projectsRoute } from './projects.mjs';
import { Coordinator, CoordinatorError, coordinatorRoute } from './coordinator.mjs';
import { BatchError, ComposeBatches, batchRoute } from './compose-batch.mjs';
import { Schedules, scheduleRoute } from './schedules.mjs';
import { projectInsights } from './insights.mjs';
import { Lessons, LessonsError, lessonsRoute } from './lessons.mjs';
import { Sandbox, sandboxRoute } from './sandbox.mjs';
import { NetworkRegistry } from './network/registry.mjs';
import { NetworkJobs } from './network/jobs.mjs';
import { LocalJobWorker } from './network/worker-local.mjs';
import { NetworkEvents } from './network/events.mjs';
import { networkRoute } from './network/http.mjs';
import { NetworkPipelines } from './network/pipeline-model.mjs';
import { PipelineRunner } from './network/pipeline-runner.mjs';
import { MachineListener } from './network/rest.mjs';
import { NetworkError } from './network/storage.mjs';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/dom.js', ['dom.js', 'text/javascript; charset=utf-8']],
  ['/base.js', ['base.js', 'text/javascript; charset=utf-8']],
  ['/prefs.js', ['prefs.js', 'text/javascript; charset=utf-8']],
  ['/notifications.js', ['notifications.js', 'text/javascript; charset=utf-8']],
  ['/workspace-files.js', ['workspace-files.js', 'text/javascript; charset=utf-8']],
  ['/origin-model.js', ['origin-model.js', 'text/javascript; charset=utf-8']],
  ['/origin-templates.js', ['origin-templates.js', 'text/javascript; charset=utf-8']],
  ['/origin.js', ['origin.js', 'text/javascript; charset=utf-8']],
  ['/markdown-view.js', ['markdown-view.js', 'text/javascript; charset=utf-8']],
  ['/origin-context.js', ['origin-context.js', 'text/javascript; charset=utf-8']],
  ['/origin-research.js', ['origin-research.js', 'text/javascript; charset=utf-8']],
  ['/projects.js', ['projects.js', 'text/javascript; charset=utf-8']],
  ['/coordinator.js', ['coordinator.js', 'text/javascript; charset=utf-8']],
  ['/insights.js', ['insights.js', 'text/javascript; charset=utf-8']],
  ['/compose-batch.js', ['compose-batch.js', 'text/javascript; charset=utf-8']],
  ['/live-preview.js', ['live-preview.js', 'text/javascript; charset=utf-8']],
  ['/dock.js', ['dock.js', 'text/javascript; charset=utf-8']],
  ['/schedules.js', ['schedules.js', 'text/javascript; charset=utf-8']],
  ['/project.html', ['project.html', 'text/html; charset=utf-8']], // The project explorer in its own window.
  ['/project-explorer.js', ['project-explorer.js', 'text/javascript; charset=utf-8']],
  ['/lessons.js', ['lessons.js', 'text/javascript; charset=utf-8']],
  ['/sandbox.js', ['sandbox.js', 'text/javascript; charset=utf-8']],
  ['/network.js', ['network.js', 'text/javascript; charset=utf-8']],
  ['/network-graph.js', ['network-graph.js', 'text/javascript; charset=utf-8']],
  ['/network-activity.js', ['network-activity.js', 'text/javascript; charset=utf-8']],
  ['/network-clients.js', ['network-clients.js', 'text/javascript; charset=utf-8']],
]);
// Pinned terminal and graph assets, served from the installed packages by exact path only (no CDN,
// no directory browsing). Missing files (no npm install) return 404: the dock and the Network graph fall back.
const vendorDir = fileURLToPath(new URL('../node_modules/', import.meta.url));
const vendor = new Map([
  ['/vendor/xterm.js', ['@xterm/xterm/lib/xterm.js', 'text/javascript; charset=utf-8']],
  ['/vendor/xterm.css', ['@xterm/xterm/css/xterm.css', 'text/css; charset=utf-8']],
  ['/vendor/addon-fit.js', ['@xterm/addon-fit/lib/addon-fit.js', 'text/javascript; charset=utf-8']],
  ['/vendor/addon-webgl.js', ['@xterm/addon-webgl/lib/addon-webgl.js', 'text/javascript; charset=utf-8']],
  ['/vendor/cytoscape.min.js', ['cytoscape/dist/cytoscape.min.js', 'text/javascript; charset=utf-8']], // Network → Graph canvas (MIT).
]);

function send(res, code, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function jsonBody(req, limit = 1_048_576) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
    throw Object.assign(new Error('Send JSON with Content-Type: application/json.'), { status: 415 });
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('The request is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('The request is not valid JSON.'), { status: 400 }); }
}

export async function generate(request, { runner = runProvider, signal, catalogReader = discoverModels, onStage } = {}) {
  const value = validateRequest(request);
  assertActionable(value.input, value.language);
  try { validateEffort(value.provider, value.effort); } catch (error) { throw Object.assign(error, { status: 400 }); }
  if (value.effort) {
    onStage?.('models');
    checkModelEffort(value.provider, value.model, value.effort, await abortable(catalogReader(value.provider, { signal }), signal));
  }
  return runPipeline(value, { runner, signal, onStage });
}

// Map internal codes to HTTP statuses. Message text always comes from fixed strings.
const STATUS = { ABORTED: 499, TIMEOUT: 504, BUSY: 409, AUTH_IN_PROGRESS: 409, NOT_INSTALLED: 409, UNSUPPORTED: 400, INVALID_PROVIDER: 400, INVALID_MODEL: 400, INVALID_EFFORT: 400, INVALID_INPUT: 400 };
// Domain errors whose messages are fixed, user-facing strings.
const EXPOSED = [AgentError, BatchError, BaseDeliveryError, BaseError, BoardError, CoordinatorError, DeliveryError, GitError, GitHubError, LessonsError, NetworkError, NotificationError, OriginError, RepositoryPipelineError, ResearchError, StoreError, WorkspaceFileError];
/** The one error-to-HTTP mapping. Unexpected errors get the route's fallback text, never internal details. */
function failureBody(error, fallback, unknown = { status: 502, code: 'UNKNOWN' }) {
  if (EXPOSED.some(Type => error instanceof Type)) return { status: error.status || 500, body: { error: error.message, code: error.code || 'INVALID_REQUEST' } };
  if (error?.status && error.status < 500 && error.status !== 499) return { status: error.status, body: { error: error.message, code: error.code || 'INVALID_REQUEST' } };
  if (typeof error?.code === 'string' && Object.hasOwn(FAILURE_MESSAGES, error.code)) return { status: STATUS[error.code] || 502, body: { error: FAILURE_MESSAGES[error.code], code: error.code, ...(error.resetsAt ? { resetsAt: error.resetsAt } : {}) } };
  if (error instanceof ProviderError && STATUS[error.code]) return { status: STATUS[error.code], body: { error: error.message, code: error.code } };
  if (error?.name === 'TimeoutError') return { status: 504, body: { error: FAILURE_MESSAGES.TIMEOUT, code: 'TIMEOUT' } };
  if (error?.name === 'AbortError') return { status: 499, body: { error: FAILURE_MESSAGES.ABORTED, code: 'ABORTED' } };
  return { status: unknown.status, body: { error: fallback, code: unknown.code } };
}
const sendFailure = (res, error, fallback, unknown) => { const { status, body } = failureBody(error, fallback, unknown); send(res, status, body); };

const auth = { installed: async provider => Boolean(await resolveExecutable(provider)), status: readAuthStatus, login: startLogin, logout };

// Board payloads carry full prompts (up to 2 MiB each); migration and import carry whole boards.
const TASK_BODY_LIMIT = 8 * 1024 * 1024;
const BOARD_BODY_LIMIT = 48 * 1024 * 1024;

/** Kanban routes. IDs come from the URL; every filesystem path is resolved on the server. */
async function boardRoute(board, req, res, pathname, searchParams, origin, prompts) {
  const method = req.method;
  const match = pathname.match(/^\/api\/(projects|tasks|runs)\/([A-Za-z0-9_-]{1,100})(?:\/([a-z-]+))?$/);
  const body = async (limit = TASK_BODY_LIMIT) => { const value = await jsonBody(req, limit); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('Send a JSON object.'), { status: 400 }); return value; };
  const view = async extra => send(res, 200, { ...extra, board: await board.view() });
  if (method === 'GET' && pathname === '/api/board') {
    // A poll that already holds the current board gets a few bytes instead of the whole board again.
    const since = searchParams.get('since');
    if (since !== null && await board.unchangedSince(Number(since), searchParams.get('instance'))) return send(res, 200, { unchanged: true });
    return view();
  }
  if (method === 'GET' && pathname === '/api/board/export') {
    const backup = await board.exportBackup({ includeBaseContent: searchParams.get('includeBaseContent') === 'true' });
    // A backup the import cannot take back is refused here, not discovered at restore time (1 MiB left for the request wrapper).
    if (Buffer.byteLength(JSON.stringify(backup)) > BOARD_BODY_LIMIT - 1024 * 1024) return send(res, 413, { error: `This backup would be larger than the ${BOARD_BODY_LIMIT / 1024 / 1024} MB a restore accepts. Export without Base document content, or shorten very long task prompts.`, code: 'BACKUP_TOO_LARGE' });
    return send(res, 200, backup);
  }
  // Imported boards keep one name per project: a name an Origin project uses gets a “ (2)” suffix. The names are
  // read and the boards made in the one-name queue, so a project created meanwhile is never given the same name.
  if (method === 'POST' && pathname === '/api/board/migrate') { const data = await body(BOARD_BODY_LIMIT); return view({ migrated: await oneName(async () => board.migrateBrowserBoard(data.board, { originProjects: await origin.list() })) }); }
  if (method === 'POST' && pathname === '/api/board/import') { const data = await body(BOARD_BODY_LIMIT); return view({ imported: await oneName(async () => board.importBackup(data.backup, { replace: data.replace === true, originProjects: await origin.list() })) }); }
  if (method === 'POST' && pathname === '/api/projects') {
    const { name, folder, workflowMode = 'pipeline' } = await body();
    // New app projects use column pipelines; an explicit legacy request preserves integrations. A project
    // of the same name that has no board yet gets this board (one project, one ID); no duplicate is made.
    return view(await createBoardProject({ origin, board }, { name, folder: folder === undefined ? 'new' : folder, workflowMode }));
  }
  if (method === 'POST' && pathname === '/api/folder/choose') return send(res, 200, await board.folderPicker());
  if (method === 'POST' && pathname === '/api/repository/validate') return send(res, 200, { repository: await board.validateRepository((await body()).path) });
  if (method === 'POST' && pathname === '/api/tasks') return view({ task: await board.createTask(await body()) });
  if (pathname.startsWith('/api/github/')) return githubRoute(board, req, res, pathname, searchParams, body);
  if (method === 'PATCH' && pathname === '/api/settings') return view({ settings: await board.setSettings(await body()) });
  const note = pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]{1,100})\/timeline\/([A-Za-z0-9_-]{1,100})$/);
  if (note && method === 'PATCH') return send(res, 200, { note: await board.updateTimelineNote(note[1], note[2], await body()) });
  if (note && method === 'DELETE') return send(res, 200, { deleted: await board.deleteTimelineNote(note[1], note[2]) ?? true });
  const schedule = pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]{1,100})\/schedules(?:\/([A-Za-z0-9_-]{1,100})(\/run)?)?$/);
  if (schedule) return scheduleRoute(board.schedules, { method, projectId: schedule[1], scheduleId: schedule[2], run: Boolean(schedule[3]), body, json: data => send(res, 200, data), view, searchParams });
  if (!match) return false;
  const [, kind, id, action = ''] = match;
  const expected = () => Number(searchParams.get('expectedRevision'));
  if (kind === 'projects') {
    if (method === 'PUT' && action === 'file') return send(res, 200, await saveWorkspaceFile(board, id, await body(4 * 1024 * 1024)));
    // Project explorer: a new empty file or folder (never over an existing one), and the checkout's Git status.
    if (method === 'POST' && action === 'files') return send(res, 200, await createWorkspaceEntry(board, id, await body()));
    if (method === 'GET' && action === 'git-status') return send(res, 200, await projectStatus(board, id));
    if (method === 'GET' && ['files', 'file'].includes(action)) return send(res, 200, await inspectWorkspace(board, id, {
      path: searchParams.get('path') || '', workspace: searchParams.get('workspace') || '',
      offset: searchParams.get('offset') || '0', version: searchParams.get('version') || '', file: action === 'file',
    }));
    if (method === 'PATCH' && !action) {
      // One name per shared project: a board is not renamed to an Origin project's name either.
      const value = await body();
      return view({ project: await oneName(async () => {
        if (typeof value.name === 'string' && await nameTaken({ origin, board }, value.name.trim(), id)) throw new BoardError('A project with this name already exists.', 'NAME_TAKEN', 409);
        return board.renameProject(id, value);
      }) });
    }
    if (method === 'PATCH' && action === 'labels') return view({ project: await board.setLabels(id, await body()) });
    if (method === 'DELETE' && !action) return view({ deleted: await board.deleteProject(id, { expectedRevision: expected() }) ?? true });
    if (method === 'POST' && action === 'repository') return view(await board.linkRepository(id, await body()));
    if (method === 'POST' && action === 'init-repository') return view(await board.initAndLinkRepository(id, await body()));
    if (method === 'GET' && action === 'branches') return send(res, 200, { repository: await board.listProjectBranches(id) });
    if (method === 'PATCH' && action === 'autopilot') return view({ project: await board.setAutopilot(id, await body()) });
    if (method === 'POST' && action === 'autopilot') { const { action: command, confirm } = await body(); return view({ project: await board.controlAutopilot(id, { action: command, confirm }) }); }
    if (method === 'PATCH' && action === 'columns') return view({ project: await board.setColumns(id, await body()) });
    if (method === 'PATCH' && action === 'pipeline') return view({ project: await board.setPipeline(id, await body()) });
    if (method === 'PATCH' && action === 'execution') return view({ project: await board.setExecutionPolicy(id, await body()) });
    if (method === 'POST' && action === 'full-autopilot') return view({ project: await board.applyFullAutopilot(id, await body()) });
    if (method === 'GET' && action === 'repository-pipeline') return send(res, 200, await board.previewRepositoryPipeline(id));
    if (method === 'GET' && action === 'repository-pipeline-status') return send(res, 200, await board.repositoryPipelineStatus(id));
    if (method === 'POST' && action === 'repository-pipeline') {
      const { sourceRevision, expectedProjectRevision, confirm } = await body();
      return view({ project: await board.applyRepositoryPipeline(id, { sourceRevision, expectedProjectRevision, confirm }) });
    }
    if (method === 'PATCH' && action === 'workflow') return view({ project: await board.setWorkflow(id, await body()) });
    if (method === 'PATCH' && action === 'tests') return view({ project: await board.delivery.setTestCommands(id, await body()) });
    if (method === 'PATCH' && action === 'preview') return view({ project: await board.previews.setSettings(id, await body()) });
    if (method === 'POST' && action === 'target-branch') return view({ project: await board.setTargetBranch(id, await body()) });
    if (method === 'GET' && action === 'timeline') return send(res, 200, { events: await board.timeline(id) });
    if (method === 'GET' && action === 'insights') return send(res, 200, { insights: await projectInsights({ board, origin, prompts }, id, searchParams.get('days')) });
    if (method === 'POST' && action === 'timeline') return send(res, 200, { note: await board.addTimelineNote(id, await body()) });
    if (method === 'POST' && action === 'github') return view({ project: await board.connectGitHub(id, await body()) });
    if (method === 'GET' && action === 'github-remote') return view({ repository: await board.githubRemote(id) });
    // How to run the project, and opening its folder, a terminal there or its index.html on this computer.
    if (method === 'GET' && action === 'run-info') return send(res, 200, { run: { ...await runInfo(await storedProject(board, id)), open: openTargets() } });
    if (method === 'POST' && action === 'open') {
      const { target, editor, taskId } = await body();
      try {
        // An editor opens the project's folder or one of its task's worktrees, both read from the stored project.
        if (target === 'editor') return send(res, 200, await board.editorOpener(await storedProject(board, id), { editor: typeof editor === 'string' ? editor : '', taskId: typeof taskId === 'string' ? taskId : '' }));
        return send(res, 200, await board.projectOpener(await storedProject(board, id), typeof target === 'string' ? target : ''));
      }
      // The openers' own refusals carry a status and a fixed message; any other failure stays the generic one.
      catch (error) { throw error.status ? new BoardError(error.message, error.code || 'OPEN_FAILED', error.status) : error; }
    }
    if (method === 'DELETE' && action === 'github') return view({ project: await board.disconnectGitHub(id, { expectedRevision: expected() }) });
    if (method === 'POST' && action === 'github-fetch') return view({ project: await board.fetchGitHub(id) });
    if (method === 'POST' && action === 'github-update') return view({ project: await board.updateTargetFromGitHub(id, await body()) });
    if (method === 'POST' && action === 'confirm-import') return view({ project: await board.confirmImport(id, await body()) });
  } else if (kind === 'runs') {
    const supervisor = board.executor;
    await board.run(id); // 404 for an unknown run.
    if (!supervisor) throw new BoardError('Agent execution is not available.', 'EXECUTION_UNAVAILABLE', 503);
    if (method === 'GET' && !action) return send(res, 200, { run: await board.run(id) });
    if (method === 'GET' && action === 'stream') return streamRun(supervisor, req, res, id, Number(searchParams.get('after') || 0));
    if (method === 'GET' && ['plan', 'last-message', 'output'].includes(action)) return send(res, 200, { name: action, text: await supervisor.artifact(id, action) });
    if (method === 'POST' && action === 'input') { supervisor.input(id, (await body(128 * 1024)).data); return send(res, 200, { ok: true }); }
    if (method === 'POST' && action === 'resize') { const size = await body(); supervisor.resize(id, size.cols, size.rows); return send(res, 200, { ok: true }); }
    if (method === 'POST' && action === 'cancel') {
      if ((await body()).confirm !== true) throw new BoardError('Confirm that you want to stop this agent session.', 'CONFIRMATION_REQUIRED');
      await supervisor.cancel(id);
      return view({ run: await board.run(id) });
    }
    if (method === 'POST' && action === 'confirm') {
      await body();
      // A typed pipeline column completes through the stage engine (plan check, checkpoint, verdict, tests).
      const run = await board.run(id);
      if (run.stageKind) await board.completeStage(run.taskId, { runId: id }); else await supervisor.confirm(id);
      return view({ run: await board.run(id) });
    }
    if (method === 'POST' && action === 'pause') return view({ run: await board.pauseRun(id, await body()) });
  } else {
    if (method === 'PATCH' && !action) return view(await board.updateTask(id, await body()));
    if (method === 'POST' && action === 'refine') { const { prompt, expectedRevision } = await body(); return view({ task: await board.refineTask(id, { prompt, expectedRevision }) }); }
    if (method === 'POST' && action === 'pipeline-settings') {
      const { profileId, agentOverride, expectedRevision, expectedProjectRevision } = await body();
      return view(await board.updateTask(id, { pipelineSettings: { profileId, agentOverride }, expectedRevision, expectedProjectRevision }));
    }
    if (method === 'DELETE' && !action) return view({ deleted: await board.deleteTask(id, { expectedRevision: expected(), keepFiles: searchParams.get('keepFiles') === 'true' }) ?? true });
    if (method === 'POST' && action === 'move') {
      // Only the fields a person can choose; the trigger is always the user here.
      const { column, index, expectedRevision, expectedProjectRevision, transitionId, decision, commitMessage, config } = await body();
      return view(await board.transition(id, { column, index, expectedRevision, expectedProjectRevision, transitionId, decision, commitMessage, config }));
    }
    if (method === 'GET' && action === 'automations') return send(res, 200, { moves: await board.automationRuns(id) });
    if (method === 'POST' && action === 'cancel-automations') return view({ task: await board.cancelAutomationMove(id, await body()) });
    if (method === 'POST' && action === 'merge-now') { await body(); return view(await board.mergeNow(id)); }
    if (method === 'POST' && action === 'start-over') { const { expectedRevision, reason, startExecuting, confirm, deleteIgnored } = await body(); return view(await board.startOver(id, { expectedRevision, reason, startExecuting: startExecuting === true, confirm: confirm === true, deleteIgnored: deleteIgnored === true })); }
    if (method === 'POST' && action === 'restart-sessions') { const { expectedRevision } = await body(); return view({ task: await board.restartTaskSessions(id, { expectedRevision }) }); }
    if (method === 'POST' && action === 'restore-worktree') { await body(); await board.restoreTaskWorktree(id); return view({ task: (await board.state()).projects.flatMap(project => project.tasks).find(task => task.id === id) }); }
    if (method === 'POST' && action === 'complete-stage') { const { runId } = await body(); return view(await board.completeStage(id, { runId })); }
    if (method === 'POST' && action === 'reopen') return view({ task: await board.reopenTask(id, await body()) });
    if (method === 'POST' && action === 'duplicate') { await body(); return view({ task: await board.duplicateTask(id) }); }
    if (method === 'POST' && action === 'prerequisites') return view({ task: await board.clearPrerequisite(id, await body()) });
    if (method === 'POST' && action === 'runs') return view({ run: await board.requestRun(id, await body()) });
    if (method === 'POST' && action === 'resume') return view({ run: await board.resumeTask(id, await body(128 * 1024)) });
    if (method === 'DELETE' && action === 'worktree') return view({ task: await board.removeTaskWorktree(id, { deleteIgnored: searchParams.get('deleteIgnored') === '1' }) });
    // Live preview: the card's dev server in its worktree, on this computer (starting and stopping are local-only).
    if (method === 'GET' && action === 'preview') return send(res, 200, await board.previews.status(id));
    if (method === 'POST' && action === 'preview') return send(res, 200, await board.previews.start(id, await body()));
    if (method === 'DELETE' && action === 'preview') { await board.previews.stop(id); return send(res, 200, await board.previews.status(id)); }
    // Review, testing, merge, and completion (PB-04). Every change needs an explicit confirm flag.
    const delivery = board.delivery;
    if (method === 'GET' && action === 'revision') return send(res, 200, { revision: await delivery.revision(id) });
    if (method === 'GET' && action === 'uncommitted') return send(res, 200, await delivery.uncommitted(id));
    if (method === 'GET' && action === 'merge-preview') return send(res, 200, { preview: await delivery.mergePreview(id) });
    if (method === 'POST' && action === 'commit') return view({ revision: await delivery.commit(id, await body()) });
    if (method === 'POST' && action === 'accept-review') { await body(); return view({ task: await delivery.acceptReview(id) }); }
    if (method === 'POST' && action === 'tests') return view({ tests: await delivery.runTests(id, await body()) });
    if (method === 'POST' && action === 'merge') {
      const { confirm, taskCommit, targetCommit } = await body();
      // On a column pipeline a card merges from its Merge column only, as the Merge button and Autopilot do.
      const owner = (await board.state()).projects.find(project => project.tasks.some(task => task.id === id));
      if (owner?.workflowMode === 'pipeline' && columnStage(owner, owner.tasks.find(task => task.id === id).column) !== 'merge') throw new BoardError('Move the card to Merge first.', 'STAGE_MISMATCH', 409);
      return view({ task: await delivery.merge(id, { confirm, taskCommit, targetCommit }) });
    }
    if (method === 'POST' && action === 'update-branch') return view({ revision: await delivery.updateBranch(id, await body()) });
    if (method === 'POST' && action === 'abort-merge') return view({ revision: await delivery.abortMerge(id, await body()) });
    if (method === 'POST' && action === 'pull-request') { const { confirm, title, body: text } = await body(); return view({ task: await delivery.openPullRequest(id, { confirm, title, body: text }) }); }
    if (method === 'POST' && action === 'pull-request-status') { await body(); return view({ task: await delivery.pullRequestStatus(id) }); }
    if (method === 'POST' && action === 'complete-no-changes') return view({ task: await delivery.completeNoChanges(id, await body()) });
  }
  return false;
}

async function storedProject(board, id) {
  const project = (await board.state()).projects.find(item => item.id === id);
  if (!project) throw new BoardError('This project no longer exists.', 'NOT_FOUND', 404);
  return project;
}

/** GitHub CLI status, browser sign-in, and repository search. No route returns a token. */
async function githubRoute(board, req, res, pathname, searchParams, body) {
  const method = req.method;
  if (method === 'GET' && pathname === '/api/github/status') return send(res, 200, { github: await githubStatus(), login: board.githubLogin.snapshot() });
  if (method === 'POST' && pathname === '/api/github/login') { await body(); return send(res, 200, { login: await board.githubLogin.start() }); }
  if (method === 'GET' && pathname === '/api/github/login') return send(res, 200, { login: board.githubLogin.snapshot() });
  if (method === 'POST' && pathname === '/api/github/login/cancel') return send(res, 200, { login: board.githubLogin.cancel() });
  if (method === 'GET' && pathname === '/api/github/repos') {
    // One listing per minute at most; the search filters it locally.
    const cache = board.githubRepos;
    if (searchParams.get('refresh') === '1' || !cache || Date.now() - cache.at > 60000) board.githubRepos = { at: Date.now(), rows: await listRepositories() };
    const query = String(searchParams.get('q') || '').toLowerCase().slice(0, 100);
    const rows = board.githubRepos.rows.filter(row => !query || row.nameWithOwner.toLowerCase().includes(query));
    return send(res, 200, { repositories: rows.slice(0, 50), total: rows.length });
  }
  return send(res, 404, { error: 'This route does not exist.' });
}

/** NDJSON output stream for one run. The page reads it with fetch, so the token stays in a header. */
function streamRun(supervisor, req, res, runId, after) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  const ping = setInterval(() => res.write('{"ping":true}\n'), 15000);
  const finish = () => { clearInterval(ping); if (!res.writableEnded) res.end(); };
  const unsubscribe = supervisor.subscribe(runId, after, {
    // A write after end() raises an uncaught 'error' on the response; an ended stream takes nothing more.
    write: item => res.writableEnded || res.write(`${JSON.stringify(item)}\n`),
    onDrain: resume => res.once('drain', resume),
    end: finish,
  });
  if (!unsubscribe) { res.write(`${JSON.stringify({ ended: true, missing: true })}\n`); finish(); return; }
  req.on('close', () => { clearInterval(ping); unsubscribe(); });
}

export async function startServer({ batchTimeoutMs, port = 4318, runner = runProvider, detector = detectProviders, catalogReader = discoverModels, authAdapter = auth, dataDir = defaultDataDir(), projectsDir, executor = 'auto', folderPicker = chooseFolder, projectOpener = openProject, editorOptions = {}, githubPty = loadPty, usageReader, mcpTester, imageGenerator, composeMcp, researchRunner = streamResearch, networkWorker, networkEventOptions = {}, machineOptions = {} } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('The port must be 0–65535.');
  // One app per data folder; the board itself loads lazily, so starting never reads or writes board files.
  const lock = await lockDataDir(dataDir);
  const usage = usageReader || new UsageDashboard({ dataDir });
  const notifications = new PipelineNotifications();
  const board = new Board({ dataDir, ...(projectsDir ? { projectsDir } : {}), automationActions: new PipelineActions({ notifier: (message, options) => notifications.deliver(message, options) }) });
  // Docker mode for card agents: one per data folder. Containers a crash left behind are removed before any run starts.
  const sandbox = new Sandbox({ dataDir });
  void sandbox.sweep();
  board.executor = executor === 'auto' ? new Supervisor({ board, dataDir, sandbox }) : executor;
  board.folderPicker = folderPicker;
  board.projectOpener = projectOpener; // Opens a project's folder, a terminal or index.html (tests pass a fake).
  // Code editors on this computer: found where they install, or added by hand; the last one used is remembered.
  const editors = editorPreferences(dataDir);
  board.editorOpener = (project, choice) => openInEditor(project, choice, { preferences: editors, ...editorOptions });
  board.githubLogin = new GitHubLogin({ ptyLoader: githubPty });
  // Autopilot runs only for projects where the user started it; otherwise each tick does nothing.
  const autopilot = new Autopilot(board);
  if (board.executor) autopilot.start();
  // Scheduled cards land in To Do while the app runs; agents start on them only where the owner chose Autopilot.
  board.schedules = new Schedules(board);
  board.schedules.start();
  const token = randomBytes(32).toString('hex');
  const catalogAbort = new AbortController();
  const catalogs = new Map(), lookups = new Map();
  // The model list view refreshes after 60 s. Effort validation for a prompt reuses any
  // list this server already read, so Generate does not start another discovery CLI.
  const getCatalog = (provider, { refresh = false, maxAgeMs = 60000 } = {}) => {
    if (!['codex', 'claude', 'gemini', 'agy'].includes(provider)) throw Object.assign(new Error('Choose a valid provider.'), { status: 400 });
    const cached = catalogs.get(provider);
    if (!refresh && cached && Date.now() - cached.time < maxAgeMs) return Promise.resolve(cached.value);
    if (lookups.has(provider)) return lookups.get(provider);
    const pending = Promise.resolve().then(() => catalogReader(provider, { signal: catalogAbort.signal }))
      .then(value => { catalogs.set(provider, { value, time: Date.now() }); return value; })
      .finally(() => lookups.delete(provider));
    lookups.set(provider, pending);
    return pending;
  };
  // One CLI operation at a time: a generation or an auth change. `busy` is always
  // cleared in a finally block, so a failed or cancelled job cannot block the next one.
  let busy = null;
  let authOperation = null; // Public snapshot of the latest sign-in attempt.
  const tasks = new Set();
  const track = promise => { tasks.add(promise); promise.finally(() => tasks.delete(promise)).catch(() => {}); return promise; };
  const authStates = new Map(); // Last read per provider, shown while another CLI job runs.
  const invalidate = provider => { catalogs.delete(provider); authStates.delete(provider); };
  const claim = async (kind, provider) => {
    // A just-cancelled generation may still be stopping its CLI. Wait briefly for it.
    if (busy?.controller.signal.aborted) await Promise.race([busy.done, new Promise(resolve => setTimeout(resolve, 5000).unref())]);
    // Changing sign-in under a running agent session would break it.
    if (kind === 'auth' && (board.executor?.pendingCount?.() ?? board.executor?.activeCount?.()) > 0) throw Object.assign(new ProviderError('Agent sessions are running. Stop them before you change sign-in.', 'RUNS_ACTIVE'), { status: 409 });
    if (kind === 'auth' && batches.activeCount() > 0) throw Object.assign(new ProviderError('Compose Batch is running. Wait for it or cancel it before you change sign-in.', 'RUNS_ACTIVE'), { status: 409 });
    if (kind === 'auth' && networkJobs.activeCount() > 0) throw Object.assign(new ProviderError('Network jobs are running. Wait for them or cancel them before you change sign-in.', 'RUNS_ACTIVE'), { status: 409 });
    // Project memory runs in the background: the owner's own CLI work, once allowed, stops it (it is queued again) and
    // gets the slot as soon as that run has stopped (src/lessons.mjs), never a BUSY refusal.
    if (busy?.kind === 'lessons' && kind !== 'lessons') { busy.controller.abort('yield'); await busy.done; }
    if (busy) {
      throw Object.assign(new ProviderError(busy.kind === 'auth' ? 'A sign-in change is in progress. Finish or cancel it first.' : 'A prompt is already in progress. Wait or cancel that prompt.', busy.kind === 'auth' ? 'AUTH_IN_PROGRESS' : 'BUSY'), { status: 409 });
    }
    let release;
    const done = new Promise(resolve => { release = resolve; });
    busy = { kind, provider, stage: 'starting', startedAt: Date.now(), controller: new AbortController(), done };
    const job = busy;
    return { job, release: () => {
      const free = () => { if (busy === job) busy = null; release(); if (job.kind === 'auth') { board.executor?.wake?.(); networkJobs.wake(); } };
      // The lessons worker releases only after its own CLI call has settled, so it waits for no unrelated work.
      if (!job.controller.signal.aborted || closing || job.kind === 'lessons') { free(); return; }
      // The UI can finish cancelling before provider pipes have closed. Keep the
      // slot until tracked cleanup settles; a broken injected adapter is bounded.
      let timer;
      void Promise.race([Promise.allSettled([...tasks]), new Promise(resolve => { timer = setTimeout(resolve, 3500); timer.unref(); })])
        .finally(() => { clearTimeout(timer); free(); });
    } };
  };
  const cancelledCompose = new Map();
  const composeId = value => {
    if (value !== undefined && (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))) throw Object.assign(new Error('Invalid Compose request ID.'), { status: 400 });
    return value?.toLowerCase();
  };
  const claimCompose = async (req, res) => {
    const id = composeId(req.headers['x-ste-compose-id']);
    const claimed = await claim('generate', null);
    claimed.job.composeId = id;
    if (res.destroyed || (id && cancelledCompose.get(id) > Date.now())) claimed.job.controller.abort();
    return claimed;
  };
  // Origin projects live in their own files; Kanban changes go only through the board service.
  const origin = new OriginStore(dataDir, { kanbanProjects: async () => (await board.state()).projects });
  const contexts = new ContextStore(dataDir);
  const research = new ResearchStore(dataDir); // Creates nothing on disk until a chat is saved.
  const prompts = new PromptStore(dataDir);
  const coordinator = new Coordinator({ dataDir, board, origin });
  // Network registrations and networks live in <dataDir>/network/ (created on the first save); Base is only read.
  const network = new NetworkRegistry({ dataDir, base: board.base, projects: async () => (await board.state()).projects.map(project => project.id) });
  // Network activity: an append-only event journal in <dataDir>/network/events/ (created on the first event); jobs report
  // every saved status change to it. Observability only: nothing reads it to decide anything.
  const networkEvents = new NetworkEvents({ dataDir, ...networkEventOptions });
  // Network jobs run through the local headless worker (tests inject a fake, or null to keep jobs queued); their own pool,
  // never the CLI slot above.
  const networkJobs = new NetworkJobs({ dataDir, registry: network, worker: networkWorker === undefined ? new LocalJobWorker({ dataDir, registry: network }) : networkWorker, authBusy: () => busy?.kind === 'auth', events: networkEvents });
  // Pipelines (drafts, versions) and their runs; a run's steps are jobs of the engine above, never started by a save.
  const pipelines = new NetworkPipelines({ dataDir, registry: network });
  const pipelineRuns = new PipelineRunner({ dataDir, pipelines, jobs: networkJobs, events: networkEvents });
  // External clients (REST and MCP): their own 127.0.0.1 listener, off until the owner turns it on; never this handle().
  const machine = new MachineListener({ dataDir, registry: network, jobs: networkJobs, events: networkEvents, reservedPorts: () => [server.address()?.port, remoteAccess?.settings.port], ...machineOptions });
  // Project memory: a merged card queues one lessons job (Board.completeTask); the worker starts once the app listens.
  const lessons = new Lessons({ dataDir, board, claim, runner: call => track(runner(call)) });
  board.lessons = lessons;
  // Compose Batch has its own bounded pool beside the one-job slot: each task is one tracked Compose run.
  const batches = new ComposeBatches({ dataDir, origin, board, track, call: input => track(runner(input)), authBusy: () => busy?.kind === 'auth', ...(batchTimeoutMs ? { timeoutMs: batchTimeoutMs } : {}),
    generate: (request, options) => generate(request, { runner: call => track(runner(call)), catalogReader: provider => getCatalog(provider, { maxAgeMs: Infinity }), ...options }) });
  if (board.executor) board.executor.authBusy = () => busy?.kind === 'auth'; // Kanban runs wait while sign-in changes.
  const baseRoutes = new BaseRoutes({ board, runner, claim, track, catalog: getCatalog, send, jsonBody, ...(mcpTester ? { mcpTester } : {}), imageGenerator });
  let composeContext;
  const getCompose = () => composeContext ??= import('./compose-context.mjs').then(({ ComposeContext }) => new ComposeContext(composeMcp ? { mcp: composeMcp } : {}));
  let closing = false, remoteAccess = null;
  // `remote` is a paired device, already checked by the remote listener (its host, origin and session).
  const handle = async (req, res, remote = null) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (closing) { res.setHeader('Connection', 'close'); return send(res, 503, { error: 'The app is shutting down.', code: 'SHUTTING_DOWN' }); }
    // A machine client's token never acts on the owner's routes, even beside the owner's own token (architecture §10.3).
    if (/^\s*bearer\s+pbm_/i.test(req.headers.authorization || '')) return send(res, 403, { error: 'Client tokens work only on the machine listener.', code: 'MACHINE_TOKEN_REFUSED' });
    if (!remote) {
      const actualPort = server.address()?.port;
      const allowedHosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
      const allowedOrigins = allowedHosts.map(host => `http://${host}`);
      if (!allowedHosts.includes(req.headers.host)) return send(res, 403, { error: 'This server accepts local requests only.' });
      if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) return send(res, 403, { error: 'This origin is not allowed.' });
      // A proxy in front of the local app (one that rewrites Host) would skip pairing: those requests are refused.
      if (['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded', 'via', 'tailscale-user-login', 'tailscale-funnel-request'].some(name => req.headers[name] !== undefined)) {
        return send(res, 403, { error: 'This port accepts direct local requests only. For other devices, turn on Remote access in Settings.', code: 'PROXY_REFUSED' });
      }
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: 'Cross-site requests are not allowed.' });
    let requestUrl;
    try { requestUrl = new URL(req.url, 'http://127.0.0.1'); } catch { return send(res, 400, { error: 'This request address is not valid.', code: 'INVALID_URL' }); }
    const pathname = requestUrl.pathname;
    const isApi = pathname.startsWith('/api/') && pathname !== '/api/session';
    // A restarted app has a new token: the page reads /api/session again and resends once (nothing has run yet).
    if (isApi && req.headers['x-ste-token'] !== token) return send(res, 403, { error: 'Reload this page before you try again.', code: 'SESSION_EXPIRED' });
    if (pathname.startsWith('/api/remote') && remote) return send(res, 403, { error: 'Remote access is managed on the computer that runs Promptboard.', code: 'REMOTE_LOCAL_ONLY' });
    if (pathname.startsWith('/api/remote')) return remoteAccess ? remoteRoute(remoteAccess, req, res, pathname, { jsonBody, send }) : send(res, 503, { error: 'The app is starting. Try again.' }); // Local only: the remote listener refuses these.
    if (pathname === '/api/editors') {
      // Editors start on the computer that runs Promptboard, so a paired phone neither lists nor changes them.
      if (remote) return send(res, 403, { error: 'Editors open on the computer that runs Promptboard. Use Copy path on this device.', code: 'REMOTE_LOCAL_ONLY' });
      try {
        if (req.method === 'PUT') { const input = await jsonBody(req); await editors.update(input && typeof input === 'object' ? input : {}, editorOptions); }
        else if (req.method !== 'GET') return send(res, 404, { error: 'Not found.' });
        return send(res, 200, await editorList(editors, editorOptions));
      } catch (error) { return sendFailure(res, error, 'The editors could not be saved.', { status: 500, code: 'EDITORS_FAILED' }); }
    }
    if (req.method === 'GET' && pathname === '/api/session') return send(res, 200, { token, platform: process.platform, ...(remote ? { remote: { name: remote.name } } : {}) });
    if (/^\/api\/notifications(?:\/|$)/.test(pathname)) {
      try { return await notificationRoute(notifications, req, res, pathname, { jsonBody, send }); }
      catch (error) {
        if (res.headersSent) { res.end(); return; }
        return sendFailure(res, error, 'Browser notification reception failed.', { status: 500, code: 'NOTIFICATION_FAILED' });
      }
    }
    if (req.method === 'GET' && pathname === '/api/providers') {
      try { return send(res, 200, { providers: await detector() }); }
      catch { return send(res, 500, { error: 'Cannot check the installed CLIs. Restart this app from your terminal.' }); }
    }
    if (req.method === 'GET' && pathname === '/api/status') {
      return send(res, 200, { busy: busy ? { kind: busy.kind, provider: busy.provider, stage: busy.stage, elapsedMs: Date.now() - busy.startedAt } : null, auth: authOperation });
    }
    if (/^\/api\/base(?:\/|$)/.test(pathname) || /^\/api\/runs\/[A-Za-z0-9_-]+\/base(?:-context|-definition)?$/.test(pathname)) {
      try { if ((await baseRoutes.route(req, res, pathname, requestUrl.searchParams)) !== false) return; }
      catch (error) { return sendFailure(res, error, 'The Base request could not be completed. Saved content is unchanged.'); }
      return send(res, 404, { error: 'This Base route does not exist.' });
    }
    if (/^\/api\/coordinator(?:\/|$)/.test(pathname)) {
      try { return await coordinatorRoute({ coordinator, runner, track, claim, req, res, pathname, jsonBody, send }); }
      catch (error) { return sendFailure(res, error, 'The Coordinator request failed. Project data is unchanged.', { status: 500, code: 'COORDINATOR_FAILED' }); }
    }
    if (/^\/api\/network(?:\/|$)/.test(pathname)) {
      try { return await networkRoute({ network, jobs: networkJobs, events: networkEvents, board: () => board.state(), pipelines, runs: pipelineRuns, machine, req, res, pathname, searchParams: requestUrl.searchParams, jsonBody, send }); }
      catch (error) { return sendFailure(res, error, 'The Network request failed. Nothing was changed.', { status: 500, code: 'NETWORK_FAILED' }); }
    }
    if (/^\/api\/sandbox(?:\/|$)/.test(pathname)) {
      try { return await sandboxRoute({ sandbox, req, res, pathname, jsonBody, send }); }
      catch (error) { return sendFailure(res, error, 'The Docker sandbox request failed. Nothing was changed.', { status: 500, code: 'SANDBOX_FAILED' }); }
    }
    if (/^\/api\/shared-projects(?:\/|$)/.test(pathname)) {
      try { return await projectsRoute({ origin, board, prompts, req, res, pathname, jsonBody, send }); }
      catch (error) { return sendFailure(res, error, 'The project request failed. Nothing was changed.', { status: 500, code: 'PROJECTS_FAILED' }); }
    }
    if (/^\/api\/origin\/research(?:\/|$)/.test(pathname)) {
      try { return await researchRoute({ research, origin, runner: researchRunner, claim, track, sources: async () => { const compose = await getCompose(); return { documents: compose.documents, mcp: compose.mcp, base: board.base }; }, req, res, pathname, searchParams: requestUrl.searchParams, jsonBody, send }); }
      catch (error) { return sendFailure(res, error, 'The research request failed. The blueprint is unchanged.', { status: 500, code: 'RESEARCH_FAILED' }); }
    }
    if (/^\/api\/origin(?:\/|$)/.test(pathname)) {
      const route = /^\/api\/origin\/projects\/[^/]+\/document(?:\/|$)/.test(pathname) ? contextRoute : originRoute;
      try { return await route({ origin, contexts, research, batches, board, prompts, req, res, pathname, jsonBody, send }); }
      catch (error) { return sendFailure(res, error, 'The blueprint request failed. Board, Compose and Base data are unchanged.', { status: 500, code: 'ORIGIN_FAILED' }); }
    }
    if (req.method === 'GET' && pathname === '/api/models') {
      try { return send(res, 200, await getCatalog(requestUrl.searchParams.get('provider'), { refresh: requestUrl.searchParams.get('refresh') === '1' })); }
      catch (error) { return send(res, error.status || 502, { error: error.status === 400 ? error.message : 'Cannot read CLI models. Check sign-in and update your CLI.' }); }
    }
    if (req.method === 'GET' && pathname === '/api/usage') {
      try { return send(res, 200, await usage.get({ refresh: requestUrl.searchParams.get('refresh') === '1' })); }
      catch { return send(res, 502, { error: 'Usage could not be refreshed. Try again.' }); }
    }
    if (req.method === 'GET' && pathname === '/api/auth') {
      const provider = requestUrl.searchParams.get('provider');
      if (!Object.hasOwn(AUTH_CAPABILITIES, provider)) return send(res, 400, { error: 'Choose a valid provider.', code: 'INVALID_PROVIDER' });
      const installed = await authAdapter.installed(provider);
      let status = { state: 'unknown' };
      // Status reads also start CLI processes; do not overlap them with a running job.
      if (installed && busy) status = { ...(authStates.get(provider) || status), stale: true };
      else if (installed) {
        try { status = await track(authAdapter.status(provider, { signal: catalogAbort.signal })); authStates.set(provider, status); } catch { status = { state: 'unknown' }; }
      }
      return send(res, 200, { provider, installed, ...status, capabilities: AUTH_CAPABILITIES[provider], operation: authOperation?.provider === provider ? authOperation : null });
    }
    if (req.method === 'POST' && pathname === '/api/auth/login') {
      let claimed;
      try {
        const body = await jsonBody(req);
        if (!Object.hasOwn(AUTH_CAPABILITIES, body?.provider) || !['browser', 'device'].includes(body?.method ?? 'browser')) throw Object.assign(new Error('Choose a valid provider and sign-in method.'), { status: 400, code: 'INVALID_REQUEST' });
        claimed = await claim('auth', body.provider);
        const { job, release } = claimed;
        job.stage = 'sign-in';
        const id = randomBytes(8).toString('hex');
        authOperation = { id, provider: body.provider, method: body.method ?? 'browser', state: 'starting' };
        let ready;
        const readySignal = new Promise(resolve => { ready = resolve; });
        const run = track(authAdapter.login(body.provider, { method: body.method ?? 'browser', signal: job.controller.signal,
          onUpdate: update => { if (authOperation?.id === id) authOperation = { ...authOperation, ...update, state: 'waiting' }; ready(); } }))
          .then(() => { if (authOperation?.id === id) authOperation = { id, provider: body.provider, method: authOperation.method, state: 'succeeded' }; },
            error => { if (authOperation?.id === id) authOperation = { id, provider: body.provider, method: authOperation.method, state: job.controller.signal.aborted ? 'cancelled' : 'failed', code: ['TIMEOUT', 'UNSUPPORTED', 'NOT_INSTALLED'].includes(error?.code) ? error.code : 'AUTH_FAILED' }; })
          .finally(() => { invalidate(body.provider); release(); ready(); });
        claimed = null;
        await Promise.race([readySignal, run]);
        const status = authOperation?.code === 'UNSUPPORTED' || authOperation?.state === 'failed' ? STATUS[authOperation.code] || 502 : 202;
        return send(res, status, { operation: authOperation });
      } catch (error) {
        claimed?.release();
        const { status, body } = failureBody(error, 'Could not start sign-in.');
        return send(res, status, body);
      }
    }
    if (req.method === 'POST' && pathname === '/api/auth/cancel') {
      try { await jsonBody(req); } catch (error) { return send(res, error.status || 400, { error: error.message }); }
      if (busy?.kind === 'auth') busy.controller.abort();
      return send(res, 200, { operation: authOperation });
    }
    if (req.method === 'POST' && pathname === '/api/auth/logout') {
      let claimed;
      try {
        const body = await jsonBody(req);
        if (!Object.hasOwn(AUTH_CAPABILITIES, body?.provider)) throw Object.assign(new Error('Choose a valid provider.'), { status: 400, code: 'INVALID_PROVIDER' });
        // Sign-out can affect every session that shares this CLI configuration.
        if (body.confirm !== true) throw Object.assign(new Error('Confirm sign-out first.'), { status: 400, code: 'CONFIRMATION_REQUIRED' });
        claimed = await claim('auth', body.provider);
        claimed.job.stage = 'sign-out';
        const result = await track(authAdapter.logout(body.provider, { signal: claimed.job.controller.signal }));
        invalidate(body.provider);
        return send(res, 200, { provider: body.provider, ...result });
      } catch (error) {
        const { status, body } = failureBody(error, 'The CLI could not sign out. Run its sign-out command in your terminal.');
        return send(res, status, body);
      } finally { claimed?.release(); }
    }
    if (req.method === 'POST' && pathname === '/api/compose/cancel') {
      try {
        const body = await jsonBody(req, 1024);
        if (!body || Object.keys(body).length !== 1 || !body.id) throw Object.assign(new Error('Provide the Compose request ID.'), { status: 400 });
        const id = composeId(body.id), now = Date.now();
        for (const [key, expires] of cancelledCompose) if (expires <= now) cancelledCompose.delete(key);
        cancelledCompose.set(id, now + 60000);
        if (cancelledCompose.size > 64) cancelledCompose.delete(cancelledCompose.keys().next().value);
        const matched = busy?.kind === 'generate' && busy.composeId === id;
        if (matched) busy.controller.abort();
        return send(res, 200, { cancelled: Boolean(matched) });
      } catch (error) { return send(res, error.status || 400, { error: error.message }); }
    }
    if (/^\/api\/compose\/batches(?:\/|$)/.test(pathname)) {
      try { return await batchRoute({ batches, req, res, pathname, searchParams: requestUrl.searchParams, jsonBody, send }); }
      catch (error) { return sendFailure(res, error, 'The batch request failed. Origin and Kanban are unchanged.', { status: 500, code: 'BATCH_FAILED' }); }
    }
    if (pathname.startsWith('/api/compose/')) {
      let claimed;
      const abort = () => { if (!res.writableEnded) claimed?.job.controller.abort(); };
      res.once('close', abort);
      try {
        const documentId = pathname.match(/^\/api\/compose\/sources\/document\/([a-zA-Z0-9-]{1,80})$/)?.[1];
        if (req.method === 'DELETE' && documentId) { (await getCompose()).documents.delete(documentId); return send(res, 200, { removed: true }); }
        if (req.method !== 'POST' || !['/api/compose/prepare', '/api/compose/sources/document', '/api/compose/mcp/test'].includes(pathname)) return send(res, 404, { error: 'This Compose route does not exist.' });
        claimed = await claimCompose(req, res);
        const { job } = claimed;
        job.controller.signal.throwIfAborted();
        const context = await getCompose();
        const signal = job.controller.signal;
        if (pathname === '/api/compose/sources/document') {
          job.stage = 'document';
          const { UPLOAD_BYTES, documentMeta } = await import('./compose-documents.mjs');
          const param = name => requestUrl.searchParams.has(name) ? Number(requestUrl.searchParams.get(name)) : undefined;
          const metadata = { name: requestUrl.searchParams.get('name'), type: req.headers['content-type'] || '', from: param('from'), to: param('to') };
          documentMeta(metadata);
          const length = Number(req.headers['content-length']);
          if (Number.isFinite(length) && length > UPLOAD_BYTES) throw Object.assign(new Error('Documents must be at most 20 MiB.'), { status: 413 });
          const chunks = []; let bytes = 0;
          const timer = setTimeout(() => { job.controller.abort(); req.destroy(); }, 30_000);
          try { for await (const chunk of req) { signal.throwIfAborted(); bytes += chunk.length; if (bytes > UPLOAD_BYTES) throw Object.assign(new Error('Documents must be at most 20 MiB.'), { status: 413 }); chunks.push(chunk); } }
          finally { clearTimeout(timer); }
          const document = await track(context.documents.add(Buffer.concat(chunks), metadata, { signal }));
          return send(res, 200, { document });
        }
        const body = await jsonBody(req, 1_048_576);
        if (pathname === '/api/compose/mcp/test') {
          job.stage = 'retrieving';
          return send(res, 200, await track(context.mcp.retrieve(body, [], { signal, discoveryOnly: true })));
        }
        const { validatePreparation } = await import('./compose-context.mjs');
        const { request, autonomous } = validatePreparation(body);
        if (!autonomous || obviouslyNonActionable(request.input)) return send(res, 200, await context.prepare(body, { runner, signal }));
        job.provider = request.provider;
        validateEffort(request.provider, request.effort);
        if (request.effort) checkModelEffort(request.provider, request.model, request.effort, await abortable(getCatalog(request.provider), signal));
        return send(res, 200, await track(context.prepare(body, { runner: call => track(runner(call)), signal, onStage: stage => { job.stage = stage; } })));
      } catch (error) {
        if (error.statusCode === 400 || error.status === 400) send(res, 400, { error: error.message, code: 'INVALID_REQUEST' });
        else if (pathname === '/api/compose/sources/document' && !claimed?.job.controller.signal.aborted && !error.status) send(res, 422, { error: error.message, code: 'DOCUMENT_FAILED' });
        else { const failure = failureBody(error, 'Context preparation failed. Retry or continue without this source.'); send(res, failure.status, failure.body); }
      } finally { res.off('close', abort); claimed?.release(); }
      return;
    }
    if (req.method === 'POST' && pathname === '/api/split') {
      // Optional: one CLI call splits an engineered prompt into tasks. Shares the one-job slot with Generate.
      let claimed;
      const abort = () => { if (!res.writableEnded) claimed?.job.controller.abort(); };
      res.once('close', abort);
      try {
        // Validated before the slot is taken: a refused request never stops the background lessons run.
        const body = await jsonBody(req, 2_097_152);
        let value;
        try { value = validateRequest({ input: body?.prompt, provider: body?.provider, model: body?.model, effort: body?.effort, language: body?.language }, { maxInputChars: COMPOSE_PROMPT_CHARS }); validateEffort(value.provider, value.effort); }
        catch (error) { throw Object.assign(error, { status: 400 }); }
        claimed = await claimCompose(req, res);
        const { job } = claimed;
        job.controller.signal.throwIfAborted();
        Object.assign(job, { provider: value.provider, stage: 'split' });
        const cwd = await makeTempDir('ste-split-');
        const started = Date.now();
        let result;
        // The folder is removed before the answer is sent, so the job slot is free when the page gets it.
        try { result = await track(abortable(track(runner({ provider: value.provider, model: value.model, effort: value.effort, prompt: buildSplitPrompt(value.input, value.language), cwd, signal: job.controller.signal, timeoutMs: null })), job.controller.signal)); }
        finally { await removeTempDir(cwd); }
        let tasks;
        try { tasks = parseSplit(result.text); } catch (error) { throw Object.assign(error, { status: 502, code: 'INVALID_OUTPUT' }); }
        send(res, 200, { tasks, coverage: splitCoverage(value.input, tasks, value.language), reportedModels: result.reportedModels || [], durationMs: Date.now() - started });
      } catch (error) {
        if (error?.code === 'INVALID_OUTPUT' && error.status === 502) send(res, 502, { error: `${error.message} Try again, or add the prompt as one card.`, code: 'INVALID_OUTPUT' });
        else { const { status, body } = failureBody(error, FAILURE_MESSAGES.CLI_FAILED); send(res, status, body); }
      } finally {
        res.off('close', abort);
        claimed?.release();
      }
      return;
    }
    if (req.method === 'POST' && pathname === '/api/generate') {
      let claimed;
      const abort = () => { if (!res.writableEnded) claimed?.job.controller.abort(); };
      res.once('close', abort);
      try {
        // Validated before the slot is taken: a refused request never stops the background lessons run.
        const body = await jsonBody(req);
        let value;
        try { value = validateRequest(body); }
        catch (error) { throw Object.assign(error, { status: 400 }); }
        claimed = await claimCompose(req, res);
        const { job } = claimed;
        job.controller.signal.throwIfAborted();
        job.provider = value.provider;
        const result = await track(generate(value, { runner: call => track(runner(call)), signal: job.controller.signal, catalogReader: provider => getCatalog(provider, { maxAgeMs: Infinity }),
          onStage: stage => { job.stage = stage; } }));
        send(res, 200, result);
      } catch (error) {
        // CLI stderr can contain provider diagnostics. Never include it in HTTP responses.
        const { status, body } = failureBody(error, FAILURE_MESSAGES.CLI_FAILED);
        send(res, status, body);
      } finally {
        res.off('close', abort);
        claimed?.release();
      }
      return;
    }
    const fileAi = pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]{1,100})\/file-proposal$/);
    if (req.method === 'POST' && fileAi) {
      let claimed;
      const abort = () => { if (!res.writableEnded) claimed?.job.controller.abort(); };
      res.once('close', abort);
      try {
        const value = validateFileProposalRequest(await jsonBody(req, 4 * 1024 * 1024));
        claimed = await claim('file-proposal', value.provider);
        const { job } = claimed; job.stage = 'proposing-file-edit';
        if (res.destroyed) job.controller.abort();
        if (value.effort) checkModelEffort(value.provider, value.model, value.effort, await abortable(getCatalog(value.provider), job.controller.signal));
        return send(res, 200, await track(proposeWorkspaceFile(board, fileAi[1], value, { runner: call => track(runner(call)), signal: job.controller.signal })));
      } catch (error) { const failure = failureBody(error, 'The AI file proposal failed. Your file and draft are unchanged.'); send(res, failure.status, failure.body); }
      finally { res.off('close', abort); claimed?.release(); }
      return;
    }
    if (/^\/api\/(?:projects|tasks)\/[A-Za-z0-9_-]{1,100}\/lessons(?:\/|$)/.test(pathname)) {
      try { return await lessonsRoute({ lessons, req, res, pathname, jsonBody, send }); }
      catch (error) { return sendFailure(res, error, 'The project memory request failed. Nothing was changed.', { status: 500, code: 'LESSONS_FAILED' }); }
    }
    if (/^\/api\/(board|projects|tasks|runs|github)(\/|$)/.test(pathname) || pathname === '/api/repository/validate' || pathname === '/api/folder/choose' || pathname === '/api/settings') {
      try { if ((await track(boardRoute(board, req, res, pathname, requestUrl.searchParams, origin, prompts))) !== false) return; }
      // Board, store, and Git errors carry fixed messages; raw Git output is never returned.
      catch (error) { return sendFailure(res, error, 'The board request failed.', { status: 500, code: 'BOARD_FAILED' }); }
      return send(res, 404, { error: 'This route does not exist.' });
    }
    if (req.method === 'GET' && (assets.has(pathname) || vendor.has(pathname))) {
      const [name, mime] = assets.get(pathname) || vendor.get(pathname);
      try { const file = await readFile(join(assets.has(pathname) ? publicDir : vendorDir, name)); res.writeHead(200, { 'Content-Type': mime }); res.end(file); }
      catch { send(res, 404, { error: 'The file is not available.' }); }
      return;
    }
    send(res, 404, { error: 'This route does not exist.' });
  };
  // A failing request must never stop the app (and with it every running agent).
  const server = http.createServer((req, res) => handle(req, res).catch(() => {
    if (res.headersSent) res.destroy(); else send(res, 500, { error: 'The request failed. Nothing was changed.', code: 'INTERNAL' });
  }));
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 2_000;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) { autopilot.stop(); board.schedules.stop(); await lock.release(); throw error; }
  await lock.setPort(server.address().port);
  // Remote access stays off unless it was turned on; a listener that cannot start is reported in Settings.
  remoteAccess = await new RemoteAccess({ dataDir, localPort: server.address().port, handle: (req, res, who) => handle(req, res, who) }).load();
  lessons.start(); // Queued lessons jobs, also those a restart interrupted, run now (one at a time, through the job slot).
  void networkJobs.start().catch(() => {}); // Reconciles jobs a stop interrupted (never relaunched); queued ones start only with a worker.
  void pipelineRuns.start().catch(() => {}); // Open runs go on from what was saved and proven; approvals stay pending.
  await machine.start().catch(() => {}); // Listens only when the owner turned external clients on; a failure is shown in Network → Settings.
  let closed;
  // Idempotent and bounded: stop accepting, cancel owned work, close sockets, then
  // SIGKILL any owned CLI process group that is still alive.
  const close = ({ graceMs = 4000 } = {}) => closed ??= (async () => {
    await lock.markStopping(); // First: once the port stops answering, a restart must not take the data folder yet.
    closing = true;
    await remoteAccess?.shutdown();
    await machine.close();
    notifications.close();
    const listening = new Promise(resolve => server.close(() => resolve()));
    busy?.controller.abort();
    const batchesClosed = batches.close(), pipelineRunsClosed = pipelineRuns.close(), networkJobsClosed = networkJobs.close();
    baseRoutes.close();
    if (composeContext) (await composeContext).close();
    catalogAbort.abort();
    usage.close?.();
    server.closeIdleConnections();
    // Agent sessions: stop owned process groups, record runs as interrupted, end streams.
    const automations = board.shutdownAutomations(), lessonsClosed = lessons.close();
    const agents = board.executor?.shutdown ? board.executor.shutdown(Math.min(3000, graceMs)) : null;
    autopilot.stop();
    board.schedules.stop();
    board.githubLogin.cancel('The app stopped.');
    board.delivery.stopAllTests();
    board.previews.stopAll();
    const settle = Promise.allSettled([...tasks, ...lookups.values(), busy?.done, automations, agents, batchesClosed, pipelineRunsClosed, networkJobsClosed, lessonsClosed].filter(Boolean));
    // An accepted shutdown must keep Node alive even when a broken adapter has
    // no remaining handles. Observe cleanup or reach this bounded terminal state.
    let cleanupTimer;
    try { await Promise.race([settle, new Promise(resolve => { cleanupTimer = setTimeout(resolve, graceMs); })]); }
    finally { clearTimeout(cleanupTimer); }
    killOwnedProcesses('SIGKILL');
    server.closeAllConnections();
    await listening;
    await lock.release();
  })();
  return { server, url: `http://127.0.0.1:${server.address().port}`, close, board, networkEvents, machine };
}
