/**
 * Project timeline, built only from recorded facts: task creation and column moves, agent runs,
 * review and test evidence, pull requests, completions, the Git commits of each task branch (or
 * of its merge), and notes the user wrote. System events are read-only; notes can be edited.
 */
import { git } from './git.mjs';

const COMMITS_PER_TASK = 30;
const TASKS_WITH_GIT = 60; // ponytail: Git is read for the 60 most recently changed tasks; page older ones if boards grow.
const SHA = /^[0-9a-f]{7,64}$/;
const COMPLETION_KINDS = new Set(['merged', 'pull_request', 'no_changes', 'unmerged']);

async function commits(root, range) {
  const out = await git(['log', '--no-merges', `-n${COMMITS_PER_TASK}`, '--format=%H%x1f%at%x1f%s', range, '--'], { cwd: root, timeoutMs: 10000 }).catch(() => '');
  return out.split('\n').filter(Boolean).map(line => { const [sha, at, subject] = line.split('\x1f'); return { sha, at: Number(at) * 1000, subject: subject.slice(0, 200) }; });
}

/** Commits of one task: its unmerged branch, or the commits its fast-forward merge brought in. */
async function taskCommits(project, task) {
  const root = project.repository?.root;
  if (!root) return [];
  const done = task.completion?.kind === 'merged' ? task.completion : null;
  if (done && SHA.test(done.previousTarget || '') && SHA.test(done.mergedCommit || '')) return commits(root, `${done.previousTarget}..${done.mergedCommit}`);
  const ws = task.workspace;
  if (ws?.status === 'ready' && ws.branch && ws.targetBranch) return commits(root, `refs/heads/${ws.targetBranch}..refs/heads/${ws.branch}`);
  return [];
}

const agentOf = run => run?.config?.provider ? { provider: run.config.provider, model: run.usage?.model || run.config.model || '', effort: run.config.effort || '' } : null;

export async function buildTimeline(project, runs) {
  const events = [];
  const add = event => events.push({ stage: '', detail: '', status: '', agent: null, commit: null, pr: null, editable: false, ...event });
  for (const task of project.tasks) {
    const base = { taskId: task.id, taskTitle: task.title };
    add({ ...base, id: `created:${task.id}`, at: task.createdAt, kind: 'created', stage: 'todo', title: 'Task created', detail: task.source ? 'From Compose' : 'Written by you' });
    for (const [index, move] of (task.transitions || []).entries()) {
      if (COMPLETION_KINDS.has(move.by)) continue; // completeTask records its move; the completion event below describes it.
      add({ ...base, id: `move:${task.id}:${index}`, at: move.at, kind: 'moved', stage: move.to, title: `Moved to ${move.to}`, detail: `From ${move.from}`, from: move.from });
    }
    const evidence = task.evidence || {};
    if (evidence.review?.at) add({ ...base, id: `review:${task.id}:${evidence.review.at}`, at: evidence.review.at, kind: 'review', stage: 'code_review', title: 'Review recorded',
      status: evidence.review.status === 'completed' ? evidence.review.verdict || 'completed' : evidence.review.status || '', detail: Array.isArray(evidence.review.findings) ? `${evidence.review.findings.length} finding${evidence.review.findings.length === 1 ? '' : 's'}` : '',
      commit: SHA.test(evidence.review.taskCommit || '') ? evidence.review.taskCommit : null });
    if (evidence.tests?.endedAt) add({ ...base, id: `tests:${task.id}:${evidence.tests.id}`, at: evidence.tests.endedAt, kind: 'tests', stage: 'testing', title: 'Tests ran', status: evidence.tests.status,
      detail: Array.isArray(evidence.tests.results) ? `${evidence.tests.results.filter(r => r.status === 'passed').length} of ${evidence.tests.results.length} commands passed` : '',
      commit: SHA.test(evidence.tests.taskCommit || '') ? evidence.tests.taskCommit : null });
    if (evidence.pullRequest?.at) add({ ...base, id: `pr:${task.id}`, at: evidence.pullRequest.at, kind: 'pull_request', stage: 'merge', title: 'Pull request opened', status: String(evidence.pullRequest.state || '').toLowerCase(),
      pr: { number: evidence.pullRequest.number ?? null, url: evidence.pullRequest.url || '', state: evidence.pullRequest.state || '' }, detail: `${evidence.pullRequest.branch || ''} → ${evidence.pullRequest.base || ''}` });
    for (const [index, attempt] of (task.previousAttempts || []).entries()) {
      add({ ...base, id: `restart:${task.id}:${index}`, at: attempt.archivedAt, kind: 'restart', stage: 'todo', title: 'Started over',
        detail: [attempt.reason, `Previous attempt kept on ${attempt.branch}`].filter(Boolean).join(' · '), commit: attempt.head,
        status: attempt.pullRequest?.state === 'OPEN' ? 'pull request still open' : '', pr: attempt.pullRequest?.url ? { number: attempt.pullRequest.number, url: attempt.pullRequest.url, state: attempt.pullRequest.state } : null });
    }
    for (const [index, completion] of [...(task.previousCompletions || []), ...(task.completion ? [task.completion] : [])].entries()) {
      const merged = completion.kind === 'merged', pr = completion.kind === 'pull_request';
      add({ ...base, id: `done:${task.id}:${index}`, at: completion.at, kind: 'completed', stage: 'done', status: completion.kind,
        title: merged ? `Merged into ${completion.targetBranch}` : pr ? 'Pull request merged' : completion.kind === 'no_changes' ? 'Completed: no changes required' : completion.kind === 'unmerged' ? 'Completed without merging' : 'Closed',
        detail: merged ? `${completion.commits ?? '?'} commit${completion.commits === 1 ? '' : 's'}, ${completion.method || 'fast-forward'}${completion.trigger === 'automation' ? ', automatic' : ''}` : completion.summary || '',
        commit: merged && SHA.test(completion.mergedCommit || '') ? completion.mergedCommit : null,
        pr: pr ? { number: completion.number ?? null, url: completion.url || '', state: 'MERGED' } : null });
    }
  }
  const titles = new Map(project.tasks.map(task => [task.id, task.title]));
  for (const run of runs) {
    if (!titles.has(run.taskId)) continue;
    const ended = run.endedAt || (['queued', 'running', 'waiting_for_input'].includes(run.status) ? null : run.updatedAt);
    add({ taskId: run.taskId, taskTitle: titles.get(run.taskId), id: `run:${run.id}`, runId: run.id, at: run.startedAt || run.createdAt, endAt: ended || null, kind: 'run', stage: run.stage,
      title: `${run.trigger === 'automation' ? 'Automatic' : 'Agent'} run`, status: run.status, agent: agentOf(run), detail: run.reason || run.waitingReason || '' });
  }
  // Git: the most recently changed tasks only, read in parallel.
  const recent = [...project.tasks].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, TASKS_WITH_GIT);
  const found = await Promise.all(recent.map(async task => [task, await taskCommits(project, task)]));
  // git log lists newest first; `seq` keeps Git's order for commits made in the same second.
  for (const [task, list] of found) for (const [index, commit] of list.entries()) {
    add({ taskId: task.id, taskTitle: task.title, id: `commit:${commit.sha}`, at: commit.at, seq: list.length - index, kind: 'commit', title: commit.subject || 'Commit', commit: commit.sha });
  }
  for (const note of project.timelineNotes || []) {
    add({ id: `note:${note.id}`, noteId: note.id, at: note.at, kind: 'note', taskId: note.taskId || null, taskTitle: note.taskId ? titles.get(note.taskId) || 'Deleted task' : '', title: note.title, detail: note.text, editable: true });
  }
  // One commit can belong to several tasks' ranges; keep one event per ID.
  const unique = new Map(events.filter(event => Number.isFinite(event.at)).map(event => [event.id, event]));
  return [...unique.values()].sort((a, b) => a.at - b.at || (a.seq || 0) - (b.seq || 0) || a.id.localeCompare(b.id));
}
