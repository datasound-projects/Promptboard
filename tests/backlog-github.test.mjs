import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { githubIssueSource, listGitHubBacklogIssues } from '../src/backlog-github.mjs';
import { Board } from '../src/board.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const exact = '  Markdown 雪\r\n{{title}}\r\n  ';
const issue = (number = 1, patch = {}) => ({ id: 9000 + number, number, title: 'Literal <img src=x> issue', body: exact, html_url: `https://github.com/acme/app/issues/${number}`,
  state: 'open', labels: [{ name: 'Literal 雪', color: 'ABCDEF' }], assignees: [{ login: 'octo' }, { login: 'dependabot[bot]' }], type: { name: 'Bug' },
  created_at: '2026-10-01T12:00:00Z', updated_at: '2026-10-02T12:00:00Z', ...patch });
const listing = (rows, input = {}) => listGitHubBacklogIssues({ repository: 'acme/app', ...input }, { run: async () => JSON.stringify(rows) });

test('GitHub issue source accepts canonical repository names and HTTPS URLs without arbitrary hosts or paths', () => {
  for (const value of ['Acme/App', 'https://github.com/Acme/App', 'https://github.com/Acme/App/', 'https://github.com/Acme/App.git'])
    assert.deepEqual(githubIssueSource(value), { provider: 'github-issues', repository: 'acme/app', url: 'https://github.com/acme/app' });
  for (const value of ['--help', 'acme/..', 'acme/.', 'acme/app/extra', 'acme/%61pp', 'acme/app?token=secret', 'https://evil.example/acme/app',
    'http://github.com/acme/app', 'https://user:secret@github.com/acme/app', 'https://github.com:444/acme/app', 'https://github.com/acme/app?x=y', 'https://github.com/acme/app#x', '', null])
    assert.throws(() => githubIssueSource(value), { code: 'INVALID_BACKLOG_SOURCE' });
});

test('preview uses one bounded GET on github.com and retains exact descriptions and whitelisted metadata', async () => {
  const calls = [];
  const result = await listGitHubBacklogIssues({ repository: 'Acme/App', state: 'all', page: 2 }, { run: async (...args) => { calls.push(args); return JSON.stringify([issue()]); } });
  assert.equal(calls.length, 1); const [args, limits] = calls[0];
  assert.deepEqual(args, ['api', '--hostname', 'github.com', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2026-03-10', 'repos/acme/app/issues?state=all&sort=updated&direction=desc&per_page=100&page=2']);
  assert.deepEqual(limits, { timeoutMs: 30000, maxBuffer: 8 * 1024 * 1024 });
  const row = result.items[0]; assert.equal(row.prompt, exact); assert.equal(row.title, issue().title); assert.equal(row.sourceKey, 'github:issue:9001');
  assert.deepEqual(row.labels, [{ name: 'Literal 雪', color: '#abcdef' }]); assert.deepEqual(row.assignees, ['octo', 'dependabot[bot]']); assert.equal(row.type, 'Bug');
  assert.equal(row.createdAt, Date.parse(issue().created_at)); assert.equal(result.nextPage, null); assert.deepEqual(result.unavailable, []);
});

test('pagination counts source rows before pull-request exclusion and exposes its bound', async () => {
  const rows = Array.from({ length: 100 }, (_, index) => issue(index + 1, { pull_request: { url: 'ignored' } }));
  const result = await listing(rows); assert.deepEqual(result.items, []); assert.equal(result.pullRequests, 100); assert.equal(result.nextPage, 2);
  const last = await listing(rows, { page: 1000 }); assert.equal(last.nextPage, null); assert.equal(last.pageLimitReached, true);
  assert.equal((await listing(rows.slice(0, 99))).nextPage, null);
});

test('invalid filters and pages start no CLI request', async () => {
  let reads = 0;
  for (const patch of [{ state: 'anything' }, { page: 0 }, { page: 1001 }, { page: 1.1 }, { page: '1' }, { repository: '--version' }])
    await assert.rejects(listGitHubBacklogIssues({ repository: 'acme/app', ...patch }, { run: async () => { reads++; return '[]'; } }), { code: 'INVALID_BACKLOG_SOURCE' });
  assert.equal(reads, 0);
});

test('malformed and duplicate issues are reported while valid exact issues remain available', async () => {
  const rows = [issue(), issue(), issue(2, { html_url: 'https://foreign.example/issue' }), issue(3, { id: Number.MAX_SAFE_INTEGER + 1 }),
    issue(4, { body: '\ud800' }), issue(5, { body: 'bad\0text' }), issue(6, { labels: [{ name: 'Bad', color: 'invalid' }] }),
    issue(7, { assignees: [{ login: '--bad' }] }), issue(8, { updated_at: '2026-02-30T12:00:00Z' }), issue(9, { type: { name: '' } }),
    issue(10, { state: 'unknown' }), null, issue(11, { body: null, type: null, labels: [], assignees: [] })];
  const result = await listing(rows); assert.deepEqual(result.items.map(row => row.number), [1, 11]); assert.equal(result.items[1].prompt, ''); assert.equal(result.items[1].type, null);
  assert.equal(result.unavailable.length, 11); assert.equal(result.unavailable.at(-1).number, null); assert.ok(result.unavailable.every(row => !row.reason.includes('foreign.example')));
});

test('oversized and malformed page envelopes fail explicitly without partial claims', async () => {
  for (const raw of ['not-json', '{}', JSON.stringify(Array.from({ length: 101 }, (_, index) => issue(index + 1))), ' '.repeat(8 * 1024 * 1024 + 1)])
    await assert.rejects(listGitHubBacklogIssues({ repository: 'acme/app' }, { run: async () => raw }), { code: 'GH_ISSUES_RESPONSE_INVALID' });
  const oversized = await listing([issue(1, { body: 'x'.repeat(2 * 1024 * 1024 + 1) })]); assert.equal(oversized.items.length, 0); assert.equal(oversized.unavailable.length, 1);
});

test('CLI errors expose bounded literal guidance without tokens, raw stderr or implicit sign-in', async () => {
  for (const [error, code] of [[{ missing: true }, 'GH_MISSING'], [{ stderr: '401 bad credentials secret-token' }, 'GH_AUTH_REQUIRED'],
    [{ stderr: 'API rate limit exceeded secret-token' }, 'GH_RATE_LIMITED'], [{ stderr: 'HTTP 404 secret-token' }, 'GH_ISSUES_UNAVAILABLE'],
    [{ stderr: 'offline secret-token' }, 'GH_ISSUES_FAILED'], [null, 'GH_ISSUES_FAILED']]) {
    let calls = 0;
    await assert.rejects(listGitHubBacklogIssues({ repository: 'acme/app' }, { run: async () => { calls++; throw error; } }), failure => {
      assert.equal(failure.code, code); assert.doesNotMatch(failure.message, /secret-token|bad credentials|stderr/); return true;
    });
    assert.equal(calls, 1);
  }
});

test('project preview is inert and rechecks its captured owner after an asynchronous read', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pb-issue-preview-'))); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const held = Promise.withResolvers(); let calls = 0;
  const board = new Board({ dataDir: dir, githubIssueReader: async () => { calls++; return held.promise; } });
  const project = await board.createProject({ name: 'Issue owner', workflowMode: 'pipeline' }), legacy = await board.createProject({ name: 'Legacy', workflowMode: 'legacy' });
  const before = await board.state(); await assert.rejects(board.previewGitHubBacklogIssues(legacy.id, {}), { code: 'PIPELINE_SETTINGS_REQUIRED' });
  await assert.rejects(board.previewGitHubBacklogIssues('foreign', {})); assert.equal(calls, 0);
  const pending = board.previewGitHubBacklogIssues(project.id, { repository: 'acme/app' });
  while (!calls) await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(await board.state(), before);
  await board.deleteProject(project.id, { expectedRevision: project.revision }); held.resolve({ items: [] }); await assert.rejects(pending, { code: 'NOT_FOUND' });
  assert.deepEqual((await board.state()).runs, []); assert.deepEqual((await board.state()).sessions, []);
});

test('HTTP issue previews require token/local origin and an existing pipeline project and never publish drafts', async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] }), project = await app.board.createProject({ name: 'HTTP preview', workflowMode: 'pipeline' });
  const token = (await (await fetch(app.url + '/api/session')).json()).token, before = await app.board.state(), requests = [];
  app.board.githubIssueReader = async input => { requests.push(input); return listing([issue()], input); };
  const url = `${app.url}/api/projects/${project.id}/backlog/import/github-issues?repository=acme%2Fapp&state=all&page=2`;
  assert.equal((await fetch(url)).status, 403); assert.equal((await fetch(url, { headers: { 'x-ste-token': token, Origin: 'https://foreign.example' } })).status, 403);
  assert.equal(requests.length, 0); const response = await fetch(url, { headers: { 'x-ste-token': token } }); assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.items[0].prompt, exact); assert.deepEqual(requests, [{ repository: 'acme/app', state: 'all', page: 2 }]);
  assert.deepEqual(await app.board.state(), before);
});
