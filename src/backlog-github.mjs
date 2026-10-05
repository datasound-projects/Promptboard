/** Read-only issue previews through the existing CLI; no credential or board writes. */
import { gh, GitHubError } from './github.mjs';

const fail = (message, code = 'INVALID_BACKLOG_SOURCE', status = 400) => { throw new GitHubError(message, code, status); };
const login = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value);
const account = value => login(value) || typeof value === 'string' && value.endsWith('[bot]') && login(value.slice(0, -5));
const positive = value => Number.isSafeInteger(value) && value > 0;
const literal = (value, max, empty = false) => typeof value === 'string' && value.isWellFormed() && value.length <= max && !value.includes('\0') && (empty || value.trim().length > 0);

export function githubIssueSource(value) {
  if (typeof value !== 'string' || value.length > 500) fail('Use a GitHub repository name or its HTTPS URL.');
  let name = value.trim();
  if (name.includes('://')) {
    let url; try { url = new URL(name); } catch { fail('Use a GitHub repository HTTPS URL.'); }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) fail('Use a github.com HTTPS repository URL without credentials or query parameters.');
    name = url.pathname.replace(/^\//, '').replace(/\/$/, '');
  }
  name = name.replace(/\.git$/i, '');
  const parts = name.split('/');
  if (parts.length !== 2 || !login(parts[0]) || !/^[A-Za-z0-9._-]{1,100}$/.test(parts[1]) || ['.', '..'].includes(parts[1])) fail('Use a repository name such as owner/repository.');
  const repository = name.toLowerCase();
  return { provider: 'github-issues', repository, url: `https://github.com/${repository}` };
}

function issue(row, source) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || !positive(row.id) || !positive(row.number)
    || !literal(row.title, 512) || !['open', 'closed'].includes(row.state)
    || row.body !== null && !literal(row.body, 2 * 1024 * 1024, true)
    || !Array.isArray(row.labels) || row.labels.length > 100 || !Array.isArray(row.assignees) || row.assignees.length > 100) throw new Error('Invalid issue metadata.');
  const url = `${source.url}/issues/${row.number}`;
  if (typeof row.html_url !== 'string' || row.html_url.toLowerCase() !== url) throw new Error('The issue link does not belong to this repository.');
  const timestamp = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) throw new Error('Invalid issue timestamp.');
    const time = Date.parse(value);
    if (!Number.isSafeInteger(time) || time < 0 || new Date(time).toISOString().replace('.000Z', 'Z') !== value.replace('.000Z', 'Z')) throw new Error('Invalid issue timestamp.');
    return time;
  };
  const labels = row.labels.map(label => {
    if (!label || typeof label !== 'object' || !literal(label.name, 60) || typeof label.color !== 'string' || !/^[a-fA-F0-9]{6}$/.test(label.color)) throw new Error('Invalid issue labels.');
    return { name: label.name, color: '#' + label.color.toLowerCase() };
  });
  const assignees = row.assignees.map(user => { if (!user || !account(user.login)) throw new Error('Invalid issue assignees.'); return user.login; });
  const type = row.type == null ? null : row.type && literal(row.type.name, 100) ? row.type.name : (() => { throw new Error('Invalid issue type.'); })();
  return { sourceKey: `github:issue:${row.id}`, id: row.id, number: row.number, title: row.title, prompt: row.body ?? '', state: row.state,
    url, labels, assignees, type, createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) };
}

/** One bounded page. A full page exposes another page even when every row was a pull request. */
export async function listGitHubBacklogIssues({ repository, state = 'open', page = 1 }, { run = gh } = {}) {
  const source = githubIssueSource(repository);
  if (!['open', 'closed', 'all'].includes(state) || !Number.isSafeInteger(page) || page < 1 || page > 1000) fail('Choose Open, Closed or All and a page from 1 to 1000.');
  const endpoint = `repos/${source.repository}/issues?state=${state}&sort=updated&direction=desc&per_page=100&page=${page}`;
  let data;
  try {
    const raw = await run(['api', '--hostname', 'github.com', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2026-03-10', endpoint],
      { timeoutMs: 30000, maxBuffer: 8 * 1024 * 1024 });
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 8 * 1024 * 1024) fail('The issue page is too large to preview.', 'GH_ISSUES_RESPONSE_INVALID', 502);
    try { data = JSON.parse(raw); } catch { fail('GitHub returned an invalid issue page.', 'GH_ISSUES_RESPONSE_INVALID', 502); }
  } catch (error) {
    if (error instanceof GitHubError) throw error;
    if (error?.missing) fail('Install the GitHub CLI (gh) to preview issues.', 'GH_MISSING', 409);
    const text = String(error?.stderr || '');
    if (/auth login|not logged in|bad credentials|401|authentication/i.test(text)) fail('Connect GitHub before previewing issues.', 'GH_AUTH_REQUIRED', 409);
    if (/rate limit|429/i.test(text)) fail('GitHub rate-limited this preview. Try again later.', 'GH_RATE_LIMITED', 429);
    if (/403|404|forbidden|not found/i.test(text)) fail('The repository is unavailable or your GitHub account cannot read its issues.', 'GH_ISSUES_UNAVAILABLE', 409);
    fail('GitHub issues could not be read. Check the connection and try again.', 'GH_ISSUES_FAILED', 502);
  }
  if (!Array.isArray(data) || data.length > 100) fail('GitHub returned an invalid issue page.', 'GH_ISSUES_RESPONSE_INVALID', 502);
  const items = [], unavailable = [], ids = new Set(); let pullRequests = 0;
  for (const row of data) {
    if (row && typeof row === 'object' && Object.hasOwn(row, 'pull_request')) { pullRequests++; continue; }
    try {
      const item = issue(row, source); if (ids.has(item.sourceKey)) throw new Error('Duplicate issue identity.');
      ids.add(item.sourceKey); items.push(item);
    } catch { unavailable.push({ number: positive(row?.number) ? row.number : null, reason: 'This issue has unsupported or inconsistent metadata and was not included.' }); }
  }
  return { source, state, page, items, pullRequests, unavailable, nextPage: data.length === 100 && page < 1000 ? page + 1 : null,
    pageLimitReached: data.length === 100 && page === 1000 };
}
