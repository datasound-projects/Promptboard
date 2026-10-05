import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from '../src/board.mjs';
import { Store, STATE_VERSION } from '../src/store.mjs';
import { listGitHubBacklogIssues } from '../src/backlog-github.mjs';
import { startTestServer } from './helpers/test-server.mjs';
const exact = '  Source Markdown 雪\r\n{{title}}\r\n  ';
const raw = (number = 1, patch = {}) => ({ id: 100 + number, number, title: `Issue ${number}`, body: exact, html_url: `https://github.com/acme/app/issues/${number}`, state: 'open', labels: [{ name: 'Bug', color: 'abcdef' }], assignees: [{ login: 'octo' }], created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z', ...patch });
const preview = (rows, input) => listGitHubBacklogIssues(input, { run: async () => JSON.stringify(rows) });
async function world(t, rows = [raw()]) {
  const dir = await mkdtemp(join(tmpdir(), 'pb-backlog-import-')); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const calls = [], board = new Board({ dataDir: dir, githubIssueReader: async input => { calls.push(input); return preview(rows, input); } });
  const project = await board.createProject({ name: 'Issue import', workflowMode: 'pipeline' });
  const source = await board.connectBacklogGitHubSource(project.id, { repository: 'Acme/App', expectedImportRevision: 0 });
  const owner = async () => (await board.state()).projects.find(row => row.id === project.id);
  const request = async (keys = ['github:issue:101'], extra = {}) => { const p = await owner(); return { keys, expectedImportRevision: p.backlogImportRevision, expectedBacklogRevision: p.backlogRevision, expectedLabelRevision: p.labelRevision, ...extra }; };
  return { dir, board, project, source, calls, rows, owner, request };
}

test('selected GitHub issues publish exact inert drafts, shared labels, assignees and independent durable identities', async t => {
  const w = await world(t, [raw(1, { labels: [{ name: 'BUG', color: 'abcdef' }, { name: 'UI', color: '654321' }] }), raw(2)]);
  await w.board.setLabels(w.project.id, { labels: [{ id: 'existing', name: 'Bug', color: '#123456' }], expectedLabelRevision: 0 });
  const before = await w.board.state(), result = await w.board.importGitHubBacklogIssues(w.project.id, w.source.id, await w.request());
  const item = result.created[0], p = await w.owner();
  assert.equal(result.created.length, 1); assert.deepEqual(result.skipped, []); assert.equal(item.prompt, exact); assert.equal(item.title, 'Issue 1'); assert.equal(item.source, null);
  assert.equal(item.priority, 0); assert.equal(item.revision, 1); assert.equal(item.checksOutdated, false); assert.equal(item.number, undefined); assert.equal(item.workspace, undefined);
  assert.equal(item.labelIds[0], 'existing'); assert.equal(p.labels[0].color, '#123456'); assert.equal(p.labels[1].name, 'UI'); assert.equal(p.labelRevision, 2);
  assert.deepEqual(item.externalSource.assignees, ['octo']); assert.equal(item.externalSource.url, raw().html_url); assert.equal(item.externalSource.title, raw().title);
  assert.deepEqual(p.backlogImported, [{ key: 'github:issue:101', taskId: item.id, importedAt: item.createdAt }]); assert.equal(p.backlogImportRevision, 2); assert.equal(p.backlogRevision, 1);
  assert.equal(p.nextTaskNumber, 1); assert.equal(p.revision, before.projects[0].revision); assert.deepEqual((await w.board.state()).base, before.base); assert.deepEqual((await w.board.state()).runs, []); assert.deepEqual((await w.board.state()).sessions, []);
  assert.deepEqual((await new Store(w.dir).read()).projects[0], p); assert.equal(w.calls.at(-1).state, 'all');
});

test('duplicate identity survives promotion, Done archive, deletion, source removal and reconnect', async t => {
  const w = await world(t), result = await w.board.importGitHubBacklogIssues(w.project.id, w.source.id, await w.request()), item = result.created[0];
  const task = (await w.board.promoteBacklogToColumn(w.project.id, item.id, { column: 'done', expectedRevision: 1, expectedBacklogRevision: 1, expectedProjectRevision: w.project.revision })).task;
  assert.equal(task.id, item.id); assert.equal(task.prompt, exact); assert.deepEqual(task.externalSource, item.externalSource); assert.ok(task.archivedAt);
  let duplicate = await w.board.importGitHubBacklogIssues(w.project.id, w.source.id, await w.request()); assert.equal(duplicate.created.length, 0); assert.equal(duplicate.skipped[0].taskId, task.id);
  await w.board.deleteTask(task.id, { expectedRevision: task.revision });
  await w.board.removeBacklogImportSource(w.project.id, w.source.id, { expectedImportRevision: (await w.owner()).backlogImportRevision });
  const replacement = await w.board.connectBacklogGitHubSource(w.project.id, { repository: 'acme/app', expectedImportRevision: (await w.owner()).backlogImportRevision });
  assert.notEqual(replacement.id, w.source.id); w.rows[0] = raw(1, { title: 'Source changed', body: 'new body' });
  duplicate = await w.board.importGitHubBacklogIssues(w.project.id, replacement.id, await w.request());
  assert.deepEqual(duplicate.created, []); assert.deepEqual(duplicate.skipped, [{ key: 'github:issue:101', taskId: task.id }]); assert.equal((await w.owner()).nextTaskNumber, 2); assert.equal((await w.owner()).backlog.length, 0);
});

test('concurrent imports allocate one identity and reject stale or foreign requests without publishing', async t => {
  const w = await world(t), request = await w.request(), results = await Promise.allSettled([w.board.importGitHubBacklogIssues(w.project.id, w.source.id, request), w.board.importGitHubBacklogIssues(w.project.id, w.source.id, request)]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal((await w.owner()).backlog.length, 1); assert.equal((await w.owner()).backlogImported.length, 1);
  const before = await w.board.state(), calls = w.calls.length;
  for (const extra of [{ expectedBacklogRevision: undefined }, { expectedImportRevision: 0 }, { expectedLabelRevision: 0 }, { keys: [] }, { keys: ['github:issue:101', 'github:issue:101'] }, { keys: ['github:issue:9999999999999999'] }, { page: 0 }, { state: 'unknown' }, { titleOverrides: { foreign: 'Title' } }])
    await assert.rejects(w.board.importGitHubBacklogIssues(w.project.id, w.source.id, await w.request(undefined, extra)));
  await assert.rejects(w.board.importGitHubBacklogIssues(w.project.id, 'foreign', await w.request()), { code: 'NOT_FOUND' });
  assert.equal(w.calls.length, calls); assert.deepEqual(await w.board.state(), before);
});

test('failed publication and changed source pages retain all drafts, catalogs, ledger and counters', async t => {
  const w = await world(t), before = await w.board.state(), request = await w.request(), path = w.board.store.path, blocked = join(w.dir, 'blocked'); await mkdir(blocked); w.board.store.path = blocked;
  await assert.rejects(w.board.importGitHubBacklogIssues(w.project.id, w.source.id, request), { code: 'STATE_WRITE_FAILED' }); assert.deepEqual(await w.board.state(), before); w.board.store.path = path;
  assert.deepEqual(await new Store(w.dir).read(), before); w.rows.splice(0);
  await assert.rejects(w.board.importGitHubBacklogIssues(w.project.id, w.source.id, request), { code: 'BACKLOG_IMPORT_ITEMS_CHANGED' }); assert.deepEqual(await w.board.state(), before);
});

test('long issue titles need an explicit short title; original provenance and exact body are retained', async t => {
  const title = 'X'.repeat(121), w = await world(t, [raw(1, { title })]), before = await w.board.state();
  await assert.rejects(w.board.importGitHubBacklogIssues(w.project.id, w.source.id, await w.request()), { code: 'BACKLOG_IMPORT_TITLE_REQUIRED' }); assert.deepEqual(await w.board.state(), before);
  const result = await w.board.importGitHubBacklogIssues(w.project.id, w.source.id, await w.request(undefined, { titleOverrides: { 'github:issue:101': 'Explicit short title' } }));
  assert.equal(result.created[0].title, 'Explicit short title'); assert.equal(result.created[0].externalSource.title, title); assert.equal(result.created[0].prompt, exact);
});

test('portable imports retain provenance and duplicate identities, reject injection, and run no agents', async t => {
  const w = await world(t), item = (await w.board.importGitHubBacklogIssues(w.project.id, w.source.id, await w.request())).created[0];
  await w.board.promoteBacklogItem(w.project.id, item.id, { expectedRevision: 1, expectedBacklogRevision: 1 });
  const backup = await w.board.exportBackup(); assert.equal(backup.version, 10);
  const imported = await world(t); await imported.board.importBackup(backup, { replace: true });
  const p = (await imported.board.state()).projects[0]; assert.deepEqual(p.backlogSources, (await w.owner()).backlogSources); assert.deepEqual(p.backlogImported, (await w.owner()).backlogImported); assert.deepEqual(p.tasks[0].externalSource, item.externalSource); assert.deepEqual((await imported.board.state()).runs, []);
  const before = await imported.board.state();
  for (const change of [data => { data.projects[0].tasks[0].externalSource.url = 'https://foreign.example'; }, data => { data.projects[0].backlogImported = []; }, data => { delete data.projects[0].tasks[0].externalSource; }, data => { data.projects[0].backlogSources[0].token = 'secret'; }, data => { data.projects[0].backlogImported.push(data.projects[0].backlogImported[0]); }]) {
    const bad = structuredClone(backup); change(bad); await assert.rejects(imported.board.importBackup(bad, { replace: true }), { code: 'INVALID_BACKUP' }); assert.deepEqual(await imported.board.state(), before);
  }
});

test('v11 migration retains backlog, labels, native state and exact original backup; newer versions are refused unchanged', async t => {
  const w = await world(t), saved = await w.board.state(); saved.version = 11;
  const draft = await w.board.createBacklogItem(w.project.id, { title: 'Local retained', prompt: exact, expectedLabelRevision: 0, expectedBacklogRevision: 0 }); saved.projects[0].backlog = [draft]; saved.projects[0].backlogRevision = 1;
  for (const p of saved.projects) { delete p.backlogSources; delete p.backlogImported; delete p.backlogImportRevision; }
  saved.privateExtension = { exact: 'retained' }; const dir = await mkdtemp(join(tmpdir(), 'pb-import-migrate-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const bytes = JSON.stringify(saved, null, 2); await writeFile(join(dir, 'state.json'), bytes); const store = new Store(dir), migrated = await store.read();
  assert.equal(migrated.version, 12); assert.deepEqual(migrated.projects[0], { ...saved.projects[0], backlogSources: [], backlogImported: [], backlogImportRevision: 0 }); assert.deepEqual(migrated.base, saved.base); assert.deepEqual(migrated.sessions, saved.sessions); assert.deepEqual(migrated.privateExtension, saved.privateExtension);
  assert.equal(await readFile(join(dir, store.recovery.migrationBackup), 'utf8'), bytes);
  const future = JSON.stringify({ ...saved, version: STATE_VERSION + 1 }); await writeFile(join(dir, 'state.json'), future); await assert.rejects(new Store(dir).read(), { code: 'STATE_VERSION_UNSUPPORTED' }); assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), future);
});

test('HTTP source connection and selected import require local token/origin and stay project scoped', async t => {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] }); app.board.githubIssueReader = input => preview([raw()], input);
  const project = await app.board.createProject({ name: 'HTTP imports', workflowMode: 'pipeline' }), token = (await (await fetch(app.url + '/api/session')).json()).token;
  const path = `${app.url}/api/projects/${project.id}/backlog/sources/github-issues`, body = JSON.stringify({ repository: 'acme/app', expectedImportRevision: 0 });
  assert.equal((await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 403);
  assert.equal((await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ste-token': token, Origin: 'https://foreign.example' }, body })).status, 403);
  const connected = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ste-token': token }, body }); assert.equal(connected.status, 200); const source = (await connected.json()).source;
  const imported = await fetch(`${app.url}/api/projects/${project.id}/backlog/sources/${source.id}/import`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ste-token': token }, body: JSON.stringify({ keys: ['github:issue:101'], expectedImportRevision: 1, expectedBacklogRevision: 0, expectedLabelRevision: 0 }) });
  assert.equal(imported.status, 200); const result = await imported.json(); assert.equal(result.created[0].prompt, exact); assert.deepEqual((await app.board.state()).runs, []);
});

test('an asynchronous import rechecks label revisions and deleted project ownership before publication', async t => {
  for (const change of ['labels', 'delete']) {
    const w = await world(t), held = Promise.withResolvers(); let reading = false;
    w.board.githubIssueReader = async () => { reading = true; return held.promise; };
    const pending = w.board.importGitHubBacklogIssues(w.project.id, w.source.id, await w.request());
    while (!reading) await new Promise(resolve => setImmediate(resolve));
    if (change === 'labels') await w.board.setLabels(w.project.id, { labels: [{ id: 'new', name: 'Concurrent', color: '#123456' }], expectedLabelRevision: 0 });
    else await w.board.deleteProject(w.project.id, { expectedRevision: w.project.revision });
    const before = await w.board.state(); held.resolve(await preview(w.rows, { repository: 'acme/app', state: 'all', page: 1 }));
    await assert.rejects(pending, { code: change === 'labels' ? 'LABEL_REVISION_CONFLICT' : 'NOT_FOUND' }); assert.deepEqual(await w.board.state(), before);
  }
});

test('catalog, ledger and safe revision limits refuse complete batches without partial labels or identities', async t => {
  const w = await world(t);
  await w.board.store.update(saved => { const p = saved.projects[0]; p.backlogSources = [w.source, ...Array.from({ length: 19 }, (_, i) => ({ id: `source-${i}`, provider: 'github-issues', repository: `acme/repo-${i}`, url: `https://github.com/acme/repo-${i}`, createdAt: 0 }))]; });
  let before = await w.board.state(); await assert.rejects(w.board.connectBacklogGitHubSource(w.project.id, { repository: 'acme/overflow', expectedImportRevision: 1 }), { code: 'LIMIT' }); assert.deepEqual(await w.board.state(), before);
  await w.board.store.update(saved => { const p = saved.projects[0]; p.backlogSources = [w.source]; p.backlogImported = Array.from({ length: 10000 }, (_, i) => ({ key: `github:issue:${1000 + i}`, taskId: `prior-${i}`, importedAt: 0 })); });
  before = await w.board.state(); await assert.rejects(w.board.importGitHubBacklogIssues(w.project.id, w.source.id, await w.request()), { code: 'LIMIT' }); assert.deepEqual(await w.board.state(), before);
  for (const field of ['backlogRevision', 'backlogImportRevision', 'labelRevision']) {
    await w.board.store.update(saved => { const p = saved.projects[0]; p.backlogImported = []; p.backlogRevision = 0; p.backlogImportRevision = 1; p.labelRevision = 0; p[field] = Number.MAX_SAFE_INTEGER; });
    before = await w.board.state(); await assert.rejects(w.board.importGitHubBacklogIssues(w.project.id, w.source.id, await w.request()), { code: 'LIMIT' }); assert.deepEqual(await w.board.state(), before);
  }
});

test('source read failures preserve drafts and catalogs and cannot save an unverified connection', async t => {
  const w = await world(t), before = await w.board.state();
  w.board.githubIssueReader = async () => { const failure = new Error('Read unavailable'); failure.code = 'GH_ISSUES_FAILED'; throw failure; };
  await assert.rejects(w.board.importGitHubBacklogIssues(w.project.id, w.source.id, await w.request()), { code: 'GH_ISSUES_FAILED' });
  await assert.rejects(w.board.connectBacklogGitHubSource(w.project.id, { repository: 'acme/other', expectedImportRevision: 1 }), { code: 'GH_ISSUES_FAILED' });
  assert.deepEqual(await w.board.state(), before);
});

test('explicit card copies preserve display provenance without allocating another import identity or agent', async t => {
  const w = await world(t), item = (await w.board.importGitHubBacklogIssues(w.project.id, w.source.id, await w.request())).created[0];
  const original = await w.board.promoteBacklogItem(w.project.id, item.id, { expectedRevision: 1, expectedBacklogRevision: 1 });
  const copy = await w.board.duplicateTask(original.id); assert.notEqual(copy.id, original.id); assert.deepEqual(copy.externalSource, original.externalSource); assert.equal(copy.prompt, exact); assert.equal(copy.column, 'todo');
  assert.equal((await w.owner()).backlogImported.length, 1); assert.deepEqual((await w.board.state()).runs, []);
  await w.board.deleteTask(original.id, { expectedRevision: original.revision });
  const duplicate = await w.board.importGitHubBacklogIssues(w.project.id, w.source.id, await w.request()); assert.deepEqual(duplicate.created, []); assert.equal(duplicate.skipped[0].taskId, original.id);
  const backup = await w.board.exportBackup(), imported = await world(t); await imported.board.importBackup(backup, { replace: true });
  assert.deepEqual((await imported.board.state()).projects[0].tasks[0].externalSource, copy.externalSource);
});
