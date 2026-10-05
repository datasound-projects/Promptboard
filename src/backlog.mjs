/** Local backlog drafts own no column, session, workspace or execution configuration. */
import { taskPriority } from './task-priority.mjs';
import { taskLabelIds } from './task-labels.mjs';

export const BACKLOG_LIMIT = 1000;
const fail = () => { const error = new Error('Use a valid backlog item and revision.'); error.code = 'INVALID_BACKLOG'; error.status = 400; throw error; };
const stableId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
export function backlogRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail();
  return value;
}
export function backlogTitle(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.trim() || value.trim().length > 120 || value.includes('\0')) fail();
  return value.trim();
}
export function backlogPrompt(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.length > 2 * 1024 * 1024 || value.includes('\0')) fail();
  return value;
}
export function backlogItems(value, labels) {
  if (!Array.isArray(value) || value.length > BACKLOG_LIMIT) fail();
  const ids = new Set();
  return value.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || !stableId(row.id) || ids.has(row.id)
      || Object.keys(row).some(key => !['id', 'title', 'prompt', 'priority', 'labelIds', 'source', 'checksOutdated', 'createdAt', 'updatedAt', 'revision'].includes(key))
      || !Number.isSafeInteger(row.revision) || row.revision < 1 || typeof row.checksOutdated !== 'boolean'
      || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0 || !Number.isSafeInteger(row.updatedAt) || row.updatedAt < 0
      || row.source !== null && (!row.source || typeof row.source !== 'object' || Array.isArray(row.source))
      || !Array.isArray(row.labelIds)) fail();
    ids.add(row.id);
    return { ...row, title: backlogTitle(row.title), prompt: backlogPrompt(row.prompt), priority: taskPriority(row.priority), labelIds: taskLabelIds(row.labelIds, labels) };
  });
}
export function validateBacklogs(projects) {
  const taskIds = new Set(projects.flatMap(project => project.tasks.map(task => task.id)));
  for (const project of projects) {
    backlogRevision(project.backlogRevision);
    const items = backlogItems(project.backlog, project.labels);
    if (items.length && project.workflowMode !== 'pipeline') fail();
    for (const item of items) { if (taskIds.has(item.id)) fail(); taskIds.add(item.id); }
  }
}
