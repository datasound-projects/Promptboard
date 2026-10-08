/**
 * Where an older card came from on GitHub (it was imported as an issue). Display metadata only:
 * it never grants an agent or CLI access, and new cards no longer get it.
 */
const fail = () => { const error = new Error('Use valid GitHub issue metadata.'); error.code = 'INVALID_EXTERNAL_SOURCE'; error.status = 400; throw error; };
const login = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;

export function externalIssueSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['provider', 'repository', 'id', 'number', 'url', 'title', 'assignees', 'updatedAt'].includes(key))
    || value.provider !== 'github-issues' || !Number.isSafeInteger(value.id) || value.id < 1 || !Number.isSafeInteger(value.number) || value.number < 1
    || typeof value.title !== 'string' || !value.title.isWellFormed() || !value.title.trim() || value.title.length > 512 || value.title.includes('\0')
    || !integer(value.updatedAt) || !Array.isArray(value.assignees) || value.assignees.length > 100
    || value.assignees.some(name => typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/.test(name))) fail();
  const parts = typeof value.repository === 'string' ? value.repository.split('/') : [];
  if (parts.length !== 2 || !login(parts[0]) || !/^[A-Za-z0-9._-]{1,100}$/.test(parts[1]) || ['.', '..'].includes(parts[1]) || value.repository !== value.repository.toLowerCase()
    || value.url !== `https://github.com/${value.repository}/issues/${value.number}`) fail();
  return { ...value, assignees: [...value.assignees] };
}
