import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BacklogCache } from '../src/backlog-cache.mjs';
import { listGitHubBacklogIssues } from '../src/backlog-github.mjs';
import { Board } from '../src/board.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const exact = '  Original 雪\r\n{{title}}\r\n  ';
const source = { id: 'saved', provider: 'github-issues', repository: 'acme/app' };
const raw = (number = 1, patch = {}) => ({ id: 100 + number, number, title: `Issue ${number}`, body: exact, state: 'open', html_url: `https://github.com/acme/app/issues/${number}`,
  labels: [{ name: 'Bug', color: 'abcdef' }], assignees: [{ login: 'octo' }], type: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z', ...patch });
const page = (rows, input) => listGitHubBacklogIssues(input, { run: async () => JSON.stringify(rows) });
async function world(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pb-backlog-cache-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  let clock = Date.parse('2026-10-05T10:00:00.500Z');
  const cache = new BacklogCache(dir, { now: () => clock });
  const snapshot = async () => { const file = (await readdir(cache.dir)).find(name => name.endsWith('.json')); return { path: join(cache.dir, file), bytes: await readFile(join(cache.dir, file), 'utf8') }; };
  return { dir, cache, snapshot, tick: () => { clock += 2000; }, guard: async () => {} };
}

test('persistent page previews preserve literal metadata, isolate projects/sources, and reuse disk without a CLI read', async t => {
  const w = await world(t); let reads = 0;
  const reader = input => { reads++; return page([raw()], input); };
  const first = await w.cache.preview('owner', source, {}, reader, w.guard);
  assert.equal(first.cache.cached, false); assert.equal(first.items[0].prompt, exact);
  const saved = await w.snapshot(), reopened = new BacklogCache(w.dir);
  const cached = await reopened.preview('owner', source, {}, () => assert.fail('Cached reads must not invoke GitHub.'), w.guard);
  assert.equal(cached.cache.cached, true); assert.deepEqual(cached.items, first.items); assert.equal((await w.snapshot()).bytes, saved.bytes);
  await reopened.preview('other', source, {}, reader, w.guard);
  await reopened.preview('owner', { ...source, id: 'reconnected' }, {}, reader, w.guard);
  assert.equal(reads, 3); assert.equal((await readdir(w.cache.dir)).filter(name => name.endsWith('.json')).length, 3);
});

test('explicit refresh updates a page, while an access failure preserves exact cache bytes and cursor', async t => {
  const w = await world(t), reader = input => page([raw()], input);
  await w.cache.preview('owner', source, {}, reader, w.guard); w.tick();
  const updated = await w.cache.preview('owner', source, { refresh: true }, input => page([raw(1, { body: '  Changed\r\n' })], input), w.guard);
  assert.equal(updated.items[0].prompt, '  Changed\r\n'); assert.equal(updated.cache.cached, false);
  const saved = await w.snapshot();
  await assert.rejects(w.cache.preview('owner', source, { refresh: true }, async () => { throw Object.assign(new Error('Unavailable'), { code: 'GH_AUTH_REQUIRED' }); }, w.guard), { code: 'GH_AUTH_REQUIRED' });
  assert.equal((await w.snapshot()).bytes, saved.bytes);
  assert.equal((await w.cache.preview('owner', source, {}, reader, w.guard)).items[0].prompt, '  Changed\r\n');
});

test('incremental sync overlaps the cursor, follows PR-only pages, checks closed changes, and invalidates old page positions', async t => {
  const w = await world(t);
  await w.cache.preview('owner', source, { page: 1 }, input => page([raw()], input), w.guard);
  await w.cache.preview('owner', source, { page: 2 }, input => page([raw(2)], input), w.guard); w.tick();
  const calls = [];
  const result = await w.cache.sync('owner', source, input => {
    calls.push(input);
    return page(input.since ? input.page === 1 ? Array.from({ length: 100 }, (_, index) => raw(index + 1, { pull_request: {} })) : [raw(1, { state: 'closed' }), raw(3)] : [raw(3)], input);
  }, w.guard);
  assert.equal(calls.length, 3); assert.equal(calls[0].since, '2026-10-05T09:59:59Z'); assert.equal(calls[1].since, calls[0].since);
  assert.equal(calls[0].state, 'all'); assert.equal(calls[1].page, 2); assert.equal(calls[2].since, undefined);
  assert.equal(result.cache.changed, 2); assert.equal(result.items[0].id, 103);
  const saved = JSON.parse((await w.snapshot()).bytes); assert.equal(saved.pages.length, 1); assert.equal(saved.cursor, Date.parse('2026-10-05T10:00:02.500Z'));
  let requested = false; await w.cache.preview('owner', source, { page: 2 }, input => { requested = true; return page([raw(2)], input); }, w.guard); assert.equal(requested, true);
});

test('incremental sync merges exact known metadata, retains snapshot times, and avoids full reads for unchanged sources', async t => {
  const w = await world(t), reader = input => page([raw(input.page)], input);
  const original = await w.cache.preview('owner', source, {}, reader, w.guard);
  await w.cache.preview('owner', source, { page: 2 }, reader, w.guard);
  await w.cache.preview('owner', source, { state: 'open' }, reader, w.guard); w.tick();
  const calls = [], changedText = '  Updated 雪\r\n{{literal}}\r\n  ';
  const synced = await w.cache.sync('owner', source, input => {
    calls.push(input); assert.ok(input.since, 'Known changes must not reread the full page.');
    return page([raw(1, { body: changedText, state: 'closed' }), raw(2, { title: 'Renamed' })], input);
  }, w.guard);
  assert.equal(calls.length, 1); assert.equal(synced.cache.cached, true); assert.equal(synced.cache.changed, 2);
  assert.equal(synced.cache.checkedAt, original.cache.checkedAt); assert.equal(synced.cache.syncedAt, original.cache.checkedAt + 2000);
  assert.equal(synced.items[0].prompt, changedText); assert.equal(synced.items[0].state, 'closed');
  const second = await w.cache.preview('owner', source, { page: 2 }, () => assert.fail('Known page remains cached.'), w.guard);
  assert.equal(second.items[0].title, 'Renamed');
  const disk = JSON.parse((await w.snapshot()).bytes); assert.deepEqual(disk.pages.map(row => row.state), ['all', 'all']);
  w.tick(); let reads = 0;
  const unchanged = await w.cache.sync('owner', source, input => { reads++; assert.ok(input.since); return page([], input); }, w.guard);
  assert.equal(reads, 1); assert.equal(unchanged.cache.changed, 0); assert.equal(unchanged.items[0].prompt, changedText);
  assert.equal(unchanged.cache.checkedAt, original.cache.checkedAt); assert.equal(unchanged.cache.syncedAt, original.cache.checkedAt + 4000);
});

test('incomplete, bounded and failed incremental reads preserve the prior page and do not advance the cursor', async t => {
  const w = await world(t); await w.cache.preview('owner', source, {}, input => page([raw()], input), w.guard); w.tick(); const saved = await w.snapshot();
  await assert.rejects(w.cache.sync('owner', source, input => page([raw(1, { title: '' })], input), w.guard), { code: 'BACKLOG_SYNC_INCOMPLETE' });
  assert.equal((await w.snapshot()).bytes, saved.bytes);
  await assert.rejects(w.cache.sync('owner', source, input => page(input.page === 1 ? Array.from({ length: 100 }, (_, index) => raw(index + 1)) : [raw(1)], input), w.guard), { code: 'BACKLOG_SYNC_INCOMPLETE' });
  assert.equal((await w.snapshot()).bytes, saved.bytes);
  let reads = 0;
  await assert.rejects(w.cache.sync('owner', source, input => { reads++; return page(Array.from({ length: 100 }, (_, index) => raw(index + 1, { pull_request: {} })), input); }, w.guard), { code: 'BACKLOG_SYNC_LIMIT' });
  assert.equal(reads, 20); assert.equal((await w.snapshot()).bytes, saved.bytes);
  await assert.rejects(w.cache.sync('owner', source, async () => { throw Object.assign(new Error('Network failure'), { code: 'GH_ISSUES_FAILED' }); }, w.guard), { code: 'GH_ISSUES_FAILED' });
  assert.equal((await w.snapshot()).bytes, saved.bytes);
  await w.cache.preview('owner', source, { refresh: true }, input => page([raw(2)], input), w.guard);
  const reset = JSON.parse((await w.snapshot()).bytes); assert.equal(reset.cursor, Date.parse('2026-10-05T10:00:02.500Z')); assert.equal(reset.pages.length, 1);
  let since; await w.cache.sync('owner', source, input => { if (input.since) since = input.since; return page([], input); }, w.guard);
  assert.equal(since, '2026-10-05T10:00:01Z');
});

test('late owner revocation cannot publish a refreshed cache and only successful serialized syncs advance the watermark', async t => {
  const w = await world(t); await w.cache.preview('owner', source, {}, input => page([raw()], input), w.guard); w.tick(); const saved = await w.snapshot(); let checks = 0;
  await assert.rejects(w.cache.preview('owner', source, { refresh: true }, input => page([raw(2)], input), async () => { if (++checks === 2) throw Object.assign(new Error('Source removed'), { code: 'NOT_FOUND', status: 404 }); }), { code: 'NOT_FOUND' });
  assert.equal((await w.snapshot()).bytes, saved.bytes); assert.ok((await readdir(w.cache.dir)).every(name => !name.includes('.tmp-')));
  const since = [], reader = async input => { if (input.since) since.push(input.since); return page([], input); };
  // Concurrent requests exercise the cache's serialization contract; no separate feature work runs in parallel.
  await Promise.all([w.cache.sync('owner', source, reader, w.guard), w.cache.sync('owner', source, reader, w.guard)]);
  assert.deepEqual(since, ['2026-10-05T09:59:59Z', '2026-10-05T10:00:01Z']);
});

test('the original bounded sync deadline aborts a hanging reader and late results cannot publish or advance its cursor', async t => {
  const w = await world(t); await w.cache.preview('owner', source, {}, input => page([raw()], input), w.guard); w.tick(); const saved = await w.snapshot();
  const entered = Promise.withResolvers(), late = Promise.withResolvers(); let signal;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = w.cache.sync('owner', source, input => { signal = input.signal; entered.resolve(); return late.promise; }, w.guard);
  const rejected = assert.rejects(pending, { code: 'BACKLOG_SYNC_TIMEOUT' });
  await entered.promise; t.mock.timers.tick(30000); await rejected; assert.equal(signal.aborted, true);
  late.resolve(await page([raw(2)], { repository: source.repository, state: 'all', page: 1 })); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await w.snapshot()).bytes, saved.bytes);
});

test('invalid inputs invoke no reader, disk metadata is validated, and newer cache versions remain unchanged', async t => {
  const w = await world(t); let reads = 0; const reader = input => { reads++; return page([raw()], input); };
  for (const input of [{ page: 0 }, { page: 1001 }, { state: 'bad' }, { refresh: 'true' }]) await assert.rejects(w.cache.preview('owner', source, input, reader, w.guard));
  await assert.rejects(w.cache.preview('../owner', source, {}, reader, w.guard)); assert.equal(reads, 0);
  await w.cache.preview('owner', source, {}, reader, w.guard); const saved = await w.snapshot(), data = JSON.parse(saved.bytes);
  data.pages[0].result.items[0].url = 'https://evil.example/secret'; await writeFile(saved.path, JSON.stringify(data));
  await assert.rejects(w.cache.preview('owner', source, {}, reader, w.guard), { code: 'BACKLOG_CACHE_INVALID' }); assert.equal(reads, 1);
  const rebuilt = await w.cache.preview('owner', source, { refresh: true }, reader, w.guard); assert.equal(rebuilt.items[0].prompt, exact); assert.equal(reads, 2);
  const newer = JSON.stringify({ ...data, version: 2 }); await writeFile(saved.path, newer);
  await assert.rejects(w.cache.preview('owner', source, { refresh: true }, reader, w.guard), { code: 'BACKLOG_CACHE_VERSION_UNSUPPORTED' }); assert.equal(await readFile(saved.path, 'utf8'), newer);
});

test('page cache evicts bounded snapshots without losing the incremental cursor and refuses directory links', async t => {
  const w = await world(t);
  for (let p = 1; p <= 13; p++) await w.cache.preview('owner', source, { page: p }, input => page([], input), w.guard);
  const saved = JSON.parse((await w.snapshot()).bytes); assert.equal(saved.pages.length, 12); assert.equal(saved.pages[0].page, 2); assert.equal(saved.cursor, Date.parse('2026-10-05T10:00:00.500Z'));
  const alternate = join(w.dir, 'linked-root'), target = join(w.dir, 'target'); await mkdir(alternate); await mkdir(target);
  await symlink(target, join(alternate, 'backlog-preview-cache'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(new BacklogCache(alternate).preview('owner', source, {}, () => assert.fail('A linked cache must start no reader.'), w.guard), { code: 'BACKLOG_CACHE_UNAVAILABLE' });
  assert.deepEqual(await readdir(target), []);
});

test('Board cache and sync leave edited imports, identities, Composer text, Base, numbering and agent state unchanged', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-cache-board-')); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const rows = [raw()], calls = [], reader = input => { calls.push(input); return page(rows, input); }, board = new Board({ dataDir: dir, githubIssueReader: reader });
  const project = await board.createProject({ name: 'Cache owner', workflowMode: 'pipeline' });
  const saved = await board.connectBacklogGitHubSource(project.id, { repository: 'acme/app', expectedImportRevision: 0 });
  const imported = await board.importGitHubBacklogIssues(project.id, saved.id, { keys: ['github:issue:101'], expectedImportRevision: 1, expectedBacklogRevision: 0, expectedLabelRevision: 0 });
  await board.updateBacklogItem(project.id, imported.created[0].id, { prompt: '  Locally edited\r\n', expectedRevision: 1 });
  const composer = await board.createTask({ projectId: project.id, title: 'Composer', prompt: exact }); const before = await board.state();
  await board.previewBacklogSource(project.id, saved.id, {}); rows[0] = raw(1, { body: 'Source changed', state: 'closed' });
  await board.syncBacklogSource(project.id, saved.id, { expectedImportRevision: before.projects[0].backlogImportRevision });
  assert.deepEqual(await board.state(), before); assert.equal(composer.prompt, exact); assert.equal(composer.column, 'todo');
  const reopened = new Board({ dataDir: dir, githubIssueReader: () => assert.fail('Restarted previews must reuse disk.') });
  const cached = await reopened.previewBacklogSource(project.id, saved.id, {}); assert.equal(cached.items[0].prompt, 'Source changed'); assert.equal(cached.cache.cached, true);
  const reads = calls.length;
  await assert.rejects(board.syncBacklogSource(project.id, saved.id, {})); await assert.rejects(board.syncBacklogSource(project.id, saved.id, { expectedImportRevision: 0 })); assert.equal(calls.length, reads);
});

test('saved-source preview and sync HTTP routes retain token/origin protections and source ownership', async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] }); let reads = 0;
  app.board.githubIssueReader = input => { reads++; return page([raw()], input); };
  const project = await app.board.createProject({ name: 'HTTP cache', workflowMode: 'pipeline' });
  const saved = await app.board.connectBacklogGitHubSource(project.id, { repository: 'acme/app', expectedImportRevision: 0 }), before = await app.board.state();
  const session = await (await fetch(app.url + '/api/session')).json(); assert.equal(session.capabilities.pipelineBacklogSourceCache, true);
  const path = `${app.url}/api/projects/${project.id}/backlog/sources/${saved.id}`;
  assert.equal((await fetch(path + '/preview')).status, 403);
  assert.equal((await fetch(path + '/sync', { method: 'POST', headers: { 'x-ste-token': session.token, Origin: 'https://foreign.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedImportRevision: 1 }) })).status, 403); assert.equal(reads, 1);
  assert.equal((await fetch(path + '/preview', { headers: { 'x-ste-token': session.token } })).status, 200);
  assert.equal((await fetch(path + '/sync', { method: 'POST', headers: { 'x-ste-token': session.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedImportRevision: 1 }) })).status, 200);
  assert.deepEqual(await app.board.state(), before);
  assert.equal((await fetch(path.replace(saved.id, 'foreign') + '/preview', { headers: { 'x-ste-token': session.token } })).status, 404);
});

test('incremental adapter accepts only canonical timestamps and encodes a read-only ascending since query', async () => {
  let args, reads = 0;
  await listGitHubBacklogIssues({ repository: 'acme/app', state: 'all', page: 2, since: '2026-10-05T10:00:00Z' }, { run: async input => { args = input; reads++; return '[]'; } });
  assert.match(args.at(-1), /direction=asc.*page=2&since=2026-10-05T10%3A00%3A00Z$/); assert.ok(args.includes('GET'));
  for (const since of ['bad', '2026-02-30T00:00:00Z', '2026-10-05T10:00:00Z&secret=anything', 123]) await assert.rejects(listGitHubBacklogIssues({ repository: 'acme/app', since }, { run: async () => { reads++; return '[]'; } }), { code: 'INVALID_BACKLOG_SOURCE' });
  assert.equal(reads, 1);
});
