import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile, mkdir, symlink, link, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Board } from '../src/board.mjs';
import { TaskFiles, taskFileFields, decodeAttachment } from '../src/task-files.mjs';
import { migrateState } from '../src/store.mjs';
import { renderPipelineSpawnPrompt } from '../src/pipeline-templates.mjs';
import { inlineImageURLs, downloadGitHubImage } from '../src/task-file-imports.mjs';
import { startTestServer } from './helpers/test-server.mjs';
import { listGitHubBacklogIssues } from '../src/backlog-github.mjs';
const exact = '  Composer 雪\r\n{{attachments}}\r\n  ';
async function temp(t) { const path = await realpath(await mkdtemp(join(tmpdir(), 'pb-taskfiles-'))); t.after(() => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })); return path; }
async function world(t) { const dataDir = await temp(t), board = new Board({ dataDir }), project = await board.createProject({ name: 'Files', workflowMode: 'pipeline' }); return { dataDir, board, project }; }
const input = (name = 'context.txt', bytes = Buffer.from('attachment 雪\0')) => ({ name, base64: bytes.toString('base64') });

test('immutable binary attachments are bounded, hash checked, deduplicated and isolated by project', async t => {
  const root = await temp(t), files = new TaskFiles(root), descriptor = await files.upload('one', input());
  assert.deepEqual(await files.upload('one', input()), descriptor); assert.deepEqual((await files.read('one', descriptor)).bytes, Buffer.from('attachment 雪\0'));
  await assert.rejects(files.read('two', descriptor), { code: 'TASK_FILE_MISSING' });
  const { path } = await files.read('one', descriptor); await writeFile(path, Buffer.alloc(descriptor.size)); await assert.rejects(files.read('one', descriptor), { code: 'TASK_FILES_CHANGED' });
});
test('descriptors, base64, filenames and references reject forged, oversized, duplicate or escaping input', () => {
  const descriptor = decodeAttachment(input()).descriptor;
  for (const name of ['../escape', 'a/b', 'a\\b', 'a\n', 'nul.txt', 'name.', 'x:stream', '\ud800']) assert.throws(() => decodeAttachment(input(name)));
  for (const base64 of ['A', 'AA=A', 'AB==', 'a'.repeat(6 * 1024 * 1024)]) assert.throws(() => decodeAttachment({ name: 'a', base64 }));
  for (const patch of [{ id: 'forged' }, { size: -1 }, { path: '/etc/passwd' }, { sha256: 'x' }]) assert.throws(() => taskFileFields({ attachments: [{ ...descriptor, ...patch }] }));
  assert.throws(() => taskFileFields({ attachments: [descriptor, descriptor] }));
  for (const path of ['/etc/passwd', '../outside', 'x\\y', '.git/config', '.env', 'keys/a.pem', '', 'src//file', 'a\n']) assert.throws(() => taskFileFields({ fileReferences: [path] }));
});
test('attachments preserve exact inert Composer text through Backlog promotion, copy, edits and restart', async t => {
  const w = await world(t), attachment = await w.board.uploadTaskAttachment(w.project.id, input());
  w.board.executor = { start: () => assert.fail('Authoring must not execute'), validate: () => assert.fail('Authoring must not probe CLI') };
  const item = await w.board.createBacklogItem(w.project.id, { title: 'Draft', prompt: exact, attachments: [attachment], expectedBacklogRevision: 0, expectedLabelRevision: 0 });
  const task = await w.board.promoteBacklogItem(w.project.id, item.id, { expectedRevision: 1, expectedBacklogRevision: 1 });
  assert.equal(task.prompt, exact); assert.equal(task.column, 'todo'); assert.deepEqual(task.attachments, [attachment]);
  const copy = await w.board.duplicateTask(task.id); assert.deepEqual(copy.attachments, task.attachments); assert.equal(copy.prompt, exact);
  const edited = await w.board.updateTask(task.id, { attachments: [], expectedRevision: 1 }); assert.equal(edited.task.contentRevision, 2); assert.equal(edited.task.prompt, exact);
  const saved = await w.board.state(); assert.deepEqual(saved.runs, []); assert.deepEqual(saved.sessions, []);
  assert.deepEqual(await new Board({ dataDir: w.dataDir }).state(), saved);
  const other = await w.board.createProject({ name: 'Other' }); await assert.rejects(w.board.createTask({ projectId: other.id, title: 'Foreign', prompt: exact, attachments: [attachment] }), { code: 'TASK_FILE_MISSING' });
});
test('portable backups embed exact attachment bytes, retain references and reject missing or mismatched blobs atomically', async t => {
  const w = await world(t), attachment = await w.board.uploadTaskAttachment(w.project.id, input());
  const task = await w.board.createTask({ projectId: w.project.id, title: 'Portable', prompt: exact, attachments: [attachment] });
  const backup = await w.board.exportBackup(); assert.equal(backup.version, 11); assert.equal(backup.taskAttachmentBlobs[0].attachment.base64, input().base64);
  const restored = new Board({ dataDir: await temp(t) }); await restored.importBackup(backup); const state = await restored.state(); assert.equal(state.projects[0].tasks[0].prompt, exact);
  assert.deepEqual(state.projects[0].tasks[0].attachments, task.attachments); assert.equal((await restored.taskAttachment(w.project.id, attachment)).base64, input().base64); assert.deepEqual(state.runs, []);
  for (const mutate of [value => value.taskAttachmentBlobs.pop(), value => value.taskAttachmentBlobs[0].attachment.base64 = input('x', Buffer.from('other')).base64, value => value.taskAttachmentBlobs.push(value.taskAttachmentBlobs[0]), value => value.taskAttachmentBlobs[0].projectId = 'foreign']) {
    const bad = structuredClone(backup); mutate(bad); const target = new Board({ dataDir: await temp(t) }); const before = await target.state(); await assert.rejects(target.importBackup(bad)); assert.deepEqual(await target.state(), before);
  }
  await unlink((await w.board.taskFiles.read(w.project.id, attachment)).path); await assert.rejects(w.board.exportBackup(), { code: 'TASK_FILE_MISSING' });
});
test('version 12 migration retains source catalog, dedup ledger, Base, sessions and unknown user metadata', async t => {
  const w = await world(t), saved = await w.board.state(); saved.version = 12; saved.privateExtension = { keep: true };
  saved.projects[0].backlogImportRevision = 17;
  const migrated = migrateState(saved); assert.equal(migrated.version, 13); assert.deepEqual(migrated.projects, saved.projects); assert.deepEqual(migrated.base, saved.base); assert.deepEqual(migrated.privateExtension, saved.privateExtension);
});
test('project references respect selected-folder/worktree mapping, reject symlinks/secrets and fail explicitly when missing', async t => {
  const w = await world(t), root = await temp(t); const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  await mkdir(join(root, 'selected')); await writeFile(join(root, 'selected', 'context.txt'), 'tracked context'); await writeFile(join(root, 'outside.txt'), 'sibling'); git('add', '.'); git('commit', '-qm', 'Initial');
  await w.board.linkRepository(w.project.id, { path: join(root, 'selected'), expectedRevision: 1 });
  await w.board.setTargetBranch(w.project.id, { branch: 'main', expectedRevision: 2 });
  const task = await w.board.createTask({ projectId: w.project.id, title: 'Reference', prompt: exact, fileReferences: ['context.txt'] });
  const workspace = await w.board.ensureTaskWorktree(task.id), current = (await w.board.state()).projects[0].tasks[0];
  const paths = await w.board.taskFiles.resolve(w.board, w.project.id, current, task.id); assert.deepEqual(paths, [join(workspace.path, 'selected', 'context.txt')]);
  assert.equal(renderPipelineSpawnPrompt({ task: current, attachmentPaths: paths }).endsWith('\n' + paths[0]), true); assert.equal(current.prompt, exact);
  await assert.rejects(w.board.validateTaskFiles(w.project.id, { fileReferences: ['outside.txt'] }), { code: 'TASK_FILE_MISSING' });
  await assert.rejects(w.board.validateTaskFiles(w.project.id, { fileReferences: ['.git/config'] }), { code: 'FILE_PROTECTED' });
  if (process.platform !== 'win32') { await symlink(join(root, 'outside.txt'), join(root, 'selected', 'alias')); await assert.rejects(w.board.validateTaskFiles(w.project.id, { fileReferences: ['alias'] }), { code: 'FILE_LINK_BLOCKED' }); }
  await unlink(paths[0]); await assert.rejects(w.board.prepareTaskFiles({ taskId: task.id, promptRevision: 1, workspacePath: workspace.path }), { code: 'TASK_FILE_MISSING' });
});
test('uploads and attachment reads use authenticated local routes without publishing cards or agent runs', async t => {
  const app = await startTestServer(t, { port: 0, executor: null }), project = await app.board.createProject({ name: 'HTTP' });
  const session = await (await fetch(app.url + '/api/session')).json(); assert.equal(session.capabilities.taskFiles, true);
  const post = (action, data, token = session.token) => fetch(`${app.url}/api/projects/${project.id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-STE-Token': token }, body: JSON.stringify(data) });
  assert.equal((await post('attachments', input(), 'bad')).status, 403);
  const descriptor = (await (await post('attachments', input())).json()).attachment;
  assert.equal((await (await post('attachment-read', descriptor)).json()).attachment.base64, input().base64);
  assert.equal((await app.board.state()).projects[0].tasks.length, 0); assert.deepEqual((await app.board.state()).runs, []);
});
test('inline image capture rejects arbitrary hosts/private DNS and preserves selected issue text and atomic imports', async t => {
  const url = 'https://github.com/user-attachments/assets/abc123'; assert.deepEqual(inlineImageURLs(`![alt](${url}) <img src="${url}">`), [url]);
  for (const value of ['http://github.com/user-attachments/assets/a', 'https://127.0.0.1/image.png', 'https://github.com/other/path', 'https://user-images.githubusercontent.com/a?token=x']) await assert.rejects(downloadGitHubImage(value), { code: 'TASK_FILE_IMPORT_FAILED' });
  await assert.rejects(downloadGitHubImage(url, { lookupFn: async () => [{ address: '127.0.0.1', family: 4 }], requestFn: () => assert.fail('No private request') }), { code: 'TASK_FILE_IMPORT_FAILED' });
  const w = await world(t), body = exact + `![screenshot](${url})`;
  w.board.githubIssueReader = value => listGitHubBacklogIssues(value, { run: async () => JSON.stringify([{ id: 101, number: 1, title: 'Image', body, state: 'open', html_url: 'https://github.com/acme/app/issues/1', labels: [], assignees: [], created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z' }]) });
  const source = await w.board.connectBacklogGitHubSource(w.project.id, { repository: 'acme/app', expectedImportRevision: 0 });
  const request = { keys: ['github:issue:101'], expectedImportRevision: 1, expectedBacklogRevision: 0, expectedLabelRevision: 0 };
  const before = await w.board.state(); w.board.imageDownloader = async () => { throw new Error('fixture download failure'); }; await assert.rejects(w.board.importGitHubBacklogIssues(w.project.id, source.id, request)); assert.deepEqual(await w.board.state(), before);
  w.board.imageDownloader = async () => input('screenshot.png', Buffer.from([137, 80, 78, 71]));
  const result = await w.board.importGitHubBacklogIssues(w.project.id, source.id, request); assert.equal(result.created[0].prompt, body); assert.equal(result.created[0].attachments.length, 1); assert.deepEqual((await w.board.state()).runs, []);
  w.board.imageDownloader = () => assert.fail('Duplicates do not redownload files'); const repeated = await w.board.importGitHubBacklogIssues(w.project.id, source.id, { ...request, expectedImportRevision: 2, expectedBacklogRevision: 1 }); assert.equal(repeated.skipped.length, 1);
});

test('attachment custody refuses symlink and hard-link substitution and changed storage directories', async t => {
  const root = await temp(t), service = new TaskFiles(root), descriptor = await service.upload('p', input()), file = await service.read('p', descriptor), outside = join(await temp(t), 'outside');
  await writeFile(outside, file.bytes); await unlink(file.path);
  if (process.platform !== 'win32') { await symlink(outside, file.path); await assert.rejects(service.read('p', descriptor), { code: 'TASK_FILES_CHANGED' }); await unlink(file.path); }
  await link(outside, file.path); await assert.rejects(service.read('p', descriptor), { code: 'TASK_FILES_CHANGED' });
  await unlink(file.path); await rm(join(root, 'task-files'), { recursive: true }); await symlink(await temp(t), join(root, 'task-files'), process.platform === 'win32' ? 'junction' : 'dir'); await assert.rejects(service.upload('p', input()), { code: 'TASK_FILES_STORAGE' });
});
test('file-bearing backup imports retain a strict concurrent board revision guard', async t => {
  const w = await world(t), attachment = await w.board.uploadTaskAttachment(w.project.id, input()); await w.board.createTask({ projectId: w.project.id, title: 'Files', prompt: exact, attachments: [attachment] });
  const portable = await w.board.exportBackup(), target = new Board({ dataDir: await temp(t) }), prepare = target.base.prepareImport.bind(target.base);
  target.base.prepareImport = async (...args) => { const prepared = await prepare(...args); await target.store.update(state => { state.settings.userChange = 'preserved'; }); return prepared; };
  await assert.rejects(target.importBackup(portable), { code: 'REVISION_CONFLICT' }); const saved = await target.state(); assert.equal(saved.settings.userChange, 'preserved'); assert.deepEqual(saved.projects, []); assert.deepEqual(saved.base.resources, []);
});

test('GitHub image DNS lookup cancellation remains bounded without contacting a host', async () => {
  const controller = new AbortController();
  const pending = downloadGitHubImage('https://github.com/user-attachments/assets/abc123', { signal: controller.signal, lookupFn: () => new Promise(() => {}), requestFn: () => assert.fail('No request after aborted lookup') });
  controller.abort(); await assert.rejects(pending, { code: 'TASK_FILE_IMPORT_FAILED' });
});

test('a maximum 4 MiB binary attachment decodes, persists, reads and exports without recursive-regex failure', async t => {
  const w = await world(t), bytes = Buffer.alloc(4 * 1024 * 1024, 251), upload = input('maximum.bin', bytes), descriptor = await w.board.uploadTaskAttachment(w.project.id, upload);
  assert.equal(descriptor.size, bytes.length); assert.deepEqual((await w.board.taskFiles.read(w.project.id, descriptor)).bytes, bytes);
  await w.board.createTask({ projectId: w.project.id, title: 'Maximum', prompt: exact, attachments: [descriptor] });
  assert.equal((await w.board.exportBackup()).taskAttachmentBlobs[0].attachment.base64, upload.base64);
  assert.throws(() => decodeAttachment(input('too-large.bin', Buffer.alloc(4 * 1024 * 1024 + 1))), { code: 'TASK_FILES_LIMIT' });
});
