/** External provenance is display metadata; it never grants an agent or CLI access. */
import { githubIssueSource } from './backlog-github.mjs';
const fail = () => { const error = new Error('Use valid backlog import metadata and revisions.'); error.code = 'INVALID_BACKLOG_IMPORT'; error.status = 400; throw error; };
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const fields = (row, keys) => row && typeof row === 'object' && !Array.isArray(row) && Object.keys(row).every(key => keys.includes(key));
export const IMPORT_IDENTITY_LIMIT = 10000;
export function externalIssueSource(value) {
  if (!fields(value, ['provider', 'repository', 'id', 'number', 'url', 'title', 'assignees', 'updatedAt']) || value.provider !== 'github-issues'
    || !Number.isSafeInteger(value.id) || value.id < 1 || !Number.isSafeInteger(value.number) || value.number < 1
    || typeof value.title !== 'string' || !value.title.isWellFormed() || !value.title.trim() || value.title.length > 512 || value.title.includes('\0')
    || !integer(value.updatedAt) || !Array.isArray(value.assignees) || value.assignees.length > 100
    || value.assignees.some(login => typeof login !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/.test(login))) fail();
  let source; try { source = githubIssueSource(value.repository); } catch { fail(); }
  if (source.repository !== value.repository || value.url !== `${source.url}/issues/${value.number}`) fail();
  return { ...value, assignees: [...value.assignees] };
}
export function backlogImportSources(value) {
  if (!Array.isArray(value) || value.length > 20) fail();
  const repositories = new Set(), ids = new Set();
  return value.map(row => {
    if (!fields(row, ['id', 'provider', 'repository', 'url', 'createdAt']) || !id(row.id) || ids.has(row.id) || !integer(row.createdAt)) fail();
    let source; try { source = githubIssueSource(row.repository); } catch { fail(); }
    if (row.provider !== source.provider || row.repository !== source.repository || row.url !== source.url || repositories.has(source.repository)) fail();
    ids.add(row.id); repositories.add(source.repository); return { ...row };
  });
}
export function backlogImportLedger(value) {
  if (!Array.isArray(value) || value.length > IMPORT_IDENTITY_LIMIT) fail();
  const identities = new Set(), tasks = new Set();
  return value.map(row => {
    if (!fields(row, ['key', 'taskId', 'importedAt']) || typeof row.key !== 'string' || !/^github:issue:[1-9][0-9]{0,15}$/.test(row.key)
      || !Number.isSafeInteger(Number(row.key.slice(13))) || !id(row.taskId) || !integer(row.importedAt) || identities.has(row.key) || tasks.has(row.taskId)) fail();
    identities.add(row.key); tasks.add(row.taskId); return { ...row };
  });
}
export function validateBacklogImports(projects) {
  const owners = new Map(projects.flatMap(project => [...project.tasks, ...project.backlog].map(task => [task.id, project.id])));
  for (const project of projects) {
    if (!integer(project.backlogImportRevision)) fail();
    const sources = backlogImportSources(project.backlogSources), ledger = backlogImportLedger(project.backlogImported);
    if (project.workflowMode !== 'pipeline' && (sources.length || ledger.length)) fail();
    const imported = new Map(ledger.map(row => [row.taskId, row.key])), identities = new Set(ledger.map(row => row.key));
    for (const row of ledger) if (owners.has(row.taskId) && owners.get(row.taskId) !== project.id) fail();
    for (const task of [...project.tasks, ...project.backlog]) {
      if (imported.has(task.id) && task.externalSource === undefined) fail();
      if (task.externalSource !== undefined) {
        const source = externalIssueSource(task.externalSource);
        const key = `github:issue:${source.id}`;
        if (!identities.has(key) || imported.has(task.id) && imported.get(task.id) !== key) fail();
      }
    }
  }
}
