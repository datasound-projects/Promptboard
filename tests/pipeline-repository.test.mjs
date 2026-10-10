import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from '../src/board.mjs';
import { attachSession } from '../src/sessions.mjs';
import { resolvePipelineStrategy } from '../src/pipeline-config.mjs';
import { customPipelineConfig } from './helpers/pipeline.mjs';
import { readRepositoryPipeline, resolveRepositoryPipeline, repositoryPipelineDefinition } from '../src/pipeline-repository.mjs';

const snapshot = (team, local = null) => ({ files: [{ name: 'promptboard.json', data: team }, { name: 'promptboard.local.json', data: local }] });
const write = (root, name, data) => writeFile(join(root, name), JSON.stringify(data));
async function temp(t) { const root = await realpath(await mkdtemp(join(tmpdir(), 'pb-repository-pipeline-'))); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return root; }
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } }).trim();
async function world(t) {
  const root = await temp(t), dataDir = await temp(t), board = new Board({ dataDir });
  git(root, 'init', '-q', '-b', 'trunk'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.test');
  git(root, '-c', 'core.hooksPath=' + dataDir, 'commit', '-q', '--allow-empty', '-m', 'Fixture');
  const project = await board.createProject({ name: 'Repository pipeline' }); await board.linkRepository(project.id, { path: root, expectedRevision: 1 });
  const pipeline = customPipelineConfig(); for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  await board.setPipeline(project.id, { pipeline, expectedRevision: 2, confirm: true });
  const current = async () => (await board.state()).projects.find(item => item.id === project.id);
  return { root, dataDir, board, projectId: project.id, pipeline, current };
}

test('repository change detection observes atomic shared edits, personal addition/removal and reverts without changing state or files', async t => {
  const w = await world(t), task = await w.board.createTask({ projectId: w.projectId, title: 'Composer split', prompt: '  Exact 😀\r\n' });
  assert.deepEqual(await w.board.repositoryPipelineStatus(w.projectId), { projectId: w.projectId, watching: false });
  const team = repositoryPipelineDefinition(w.pipeline), bytes = JSON.stringify(team);
  await writeFile(join(w.root, 'promptboard.json'), bytes);
  await w.board.applyRepositoryPipeline(w.projectId, { ...await w.board.previewRepositoryPipeline(w.projectId), confirm: true });
  const before = structuredClone(await w.board.state()), source = before.projects[0].repositoryPipeline.sourceRevision;
  w.board.executor = { start() { assert.fail('A poll must not start.'); }, validate() { assert.fail('A poll must not probe a CLI.'); }, cancel() { assert.fail('A poll must not signal.'); } };
  const unchanged = await w.board.repositoryPipelineStatus(w.projectId);
  assert.equal(unchanged.watching, true); assert.equal(unchanged.changed, false); assert.equal(unchanged.errorCode, null); assert.equal(unchanged.appliedSourceRevision, source); assert.equal(unchanged.expectedProjectRevision, before.projects[0].revision);
  team.columns[2].strategy.autoSpawn = true;
  await write(w.root, 'replacement.json', team); await rename(join(w.root, 'replacement.json'), join(w.root, 'promptboard.json'));
  assert.equal((await w.board.repositoryPipelineStatus(w.projectId)).changed, true);
  await writeFile(join(w.root, 'promptboard.json'), bytes);
  assert.equal((await w.board.repositoryPipelineStatus(w.projectId)).changed, false, 'Restoring identical source bytes clears the change.');
  await write(w.root, 'promptboard.local.json', { version: 1, columns: [{ name: 'Executing', strategy: { autoSpawn: true } }] });
  assert.equal((await w.board.repositoryPipelineStatus(w.projectId)).changed, true);
  await rm(join(w.root, 'promptboard.local.json'));
  assert.equal((await w.board.repositoryPipelineStatus(w.projectId)).changed, false);
  assert.deepEqual(await w.board.state(), before); assert.equal((await w.current()).tasks[0].prompt, task.prompt); assert.equal(await readFile(join(w.root, 'promptboard.json'), 'utf8'), bytes);
  const reopened = new Board({ dataDir: w.dataDir }); assert.equal((await reopened.repositoryPipelineStatus(w.projectId)).changed, false);
  assert.equal((await reopened.exportBackup()).projects[0].repositoryPipeline, undefined, 'Portable imports cannot grant file monitoring.');
  const current = await w.current(); await w.board.setPipeline(w.projectId, { pipeline: current.pipeline, expectedRevision: current.revision });
  assert.equal((await w.board.repositoryPipelineStatus(w.projectId)).watching, false, 'A normal saved draft ends the accepted file baseline.');
});

test('unreadable or removed repository configuration never rewrites the saved board or returns file content', async t => {
  const w = await world(t); await write(w.root, 'promptboard.json', repositoryPipelineDefinition(w.pipeline));
  await w.board.applyRepositoryPipeline(w.projectId, { ...await w.board.previewRepositoryPipeline(w.projectId), confirm: true });
  const before = structuredClone(await w.board.state());
  await writeFile(join(w.root, 'promptboard.json'), 'SECRET_BAD_JSON <img src=x>');
  const invalid = await w.board.repositoryPipelineStatus(w.projectId); assert.equal(invalid.changed, null); assert.equal(invalid.errorCode, 'INVALID_REPOSITORY_PIPELINE'); assert.ok(!JSON.stringify(invalid).includes('SECRET'));
  await write(w.root, 'promptboard.json', { version: 1, columns: [{ name: 'Invalid', strategy: { unknown: 'SECRET' } }] });
  const schema = await w.board.repositoryPipelineStatus(w.projectId); assert.equal(schema.changed, true); assert.equal(schema.errorCode, 'INVALID_PIPELINE_CONFIG'); assert.ok(!JSON.stringify(schema).includes('SECRET'));
  await rm(join(w.root, 'promptboard.json'));
  const missing = await w.board.repositoryPipelineStatus(w.projectId); assert.equal(missing.changed, true); assert.equal(missing.errorCode, 'REPOSITORY_PIPELINE_NOT_FOUND'); assert.ok(missing.files.every(file => !file.present));
  await mkdir(join(w.root, 'promptboard.json')); assert.equal((await w.board.repositoryPipelineStatus(w.projectId)).errorCode, 'INVALID_REPOSITORY_PIPELINE');
  assert.deepEqual(await w.board.state(), before);
});

test('repository status refuses a changed project snapshot and stays inert while agents or automations own a task', async t => {
  const w = await world(t), task = await w.board.createTask({ projectId: w.projectId, title: 'Owned', prompt: 'Exact' });
  await write(w.root, 'promptboard.json', repositoryPipelineDefinition(w.pipeline));
  await w.board.applyRepositoryPipeline(w.projectId, { ...await w.board.previewRepositoryPipeline(w.projectId), confirm: true });
  await w.board.store.update(state => { const run = { id: 'observed-run', projectId: w.projectId, taskId: task.id, stage: 'executing', status: 'queued', config: { provider: 'claude', pipeline: true } }; state.runs.push(run); attachSession(state, run); });
  w.board.automationMoves.set(task.id, {}); w.board.executor = { start() { assert.fail('No start.'); }, validate() { assert.fail('No probe.'); }, cancel() { assert.fail('No signal.'); } };
  const before = structuredClone(await w.board.state()); assert.equal((await w.board.repositoryPipelineStatus(w.projectId)).changed, false); assert.deepEqual(await w.board.state(), before);
  const state = w.board.state.bind(w.board); let reads = 0;
  w.board.state = async () => { if (++reads === 2) await w.board.renameProject(w.projectId, { name: 'Concurrent edit', expectedRevision: before.projects[0].revision }); return state(); };
  await assert.rejects(w.board.repositoryPipelineStatus(w.projectId), { code: 'REPOSITORY_PIPELINE_CHANGED' });
  assert.equal((await state()).projects[0].repositoryPipeline.sourceRevision, before.projects[0].repositoryPipeline.sourceRevision);
});

test('fresh repository review retains the linked Git identity guard when the configured checkout root changes', async t => {
  const w = await world(t), elsewhere = await temp(t);
  await write(w.root, 'promptboard.json', repositoryPipelineDefinition(w.pipeline));
  const before = structuredClone(await w.board.state());
  git(w.root, 'config', 'core.worktree', elsewhere);
  await assert.rejects(w.board.previewRepositoryPipeline(w.projectId), { code: 'REPOSITORY_PIPELINE_ROOT_CHANGED' });
  assert.deepEqual(await w.board.state(), before);
});

test('repository config preserves sparse local values, replaces both automation groups, and resolves profile/plan names without mutating sources', () => {
  const current = customPipelineConfig(), team = repositoryPipelineDefinition(current);
  team.columns[2].strategy = { agentOverride: 'codex', modelOverride: 'team-model', effortOverride: 'high' };
  team.columns[2].automations = { onEnter: [{ name: 'Team notice', type: 'notify', title: 'Team' }], onExit: [{ name: 'Team exit', type: 'notify' }] };
  team.profiles = [{ name: 'Economy', columns: { Executing: { modelOverride: null, effortOverride: 'low' }, Planning: { planExitTarget: 'Testing' } } }];
  const local = { version: 1, columns: [{ name: 'Executing', color: 'green', strategy: { modelOverride: null }, automations: { onEnter: [{ name: 'Personal notice', type: 'notify' }] } }] };
  const input = snapshot(team, local), before = structuredClone(input), result = resolveRepositoryPipeline(input, current);
  const executing = result.pipeline.columns.find(column => column.id === 'executing');
  assert.equal(executing.strategy.agentOverride, 'codex'); assert.equal(executing.strategy.modelOverride, null); assert.equal(executing.strategy.effortOverride, 'high'); assert.equal(executing.color, 'green');
  assert.equal(executing.automations.onEnter[0].name, 'Personal notice'); assert.deepEqual(executing.automations.onExit, []);
  assert.equal(result.shared.columns[2].automations.onEnter[0].name, 'Team notice'); assert.equal(result.shared.columns[2].strategy.modelOverride, 'team-model');
  const profile = result.pipeline.profiles[0]; assert.equal(resolvePipelineStrategy(result.pipeline, 'planning', { profileId: profile.id }).planExitTargetId, 'testing');
  assert.equal(resolvePipelineStrategy(result.pipeline, 'executing', { profileId: profile.id }).modelOverride, null);
  assert.deepEqual(input, before); assert.deepEqual(resolveRepositoryPipeline(input, current), result, 'Missing row/profile IDs are deterministic across review and apply.');
});

test('hand-written configs add named columns without dropping tasks; canonical IDs reconcile order and removals while supplying system roles', () => {
  const current = customPipelineConfig();
  const additive = resolveRepositoryPipeline(snapshot({ version: 1, columns: [{ name: 'Planning', strategy: { planExitTarget: 'Testing' } }, { name: 'Triage', strategy: { autoSpawn: false } }] }), current);
  assert.equal(additive.canonical, false); assert.equal(additive.pipeline.columns.length, 8); assert.equal(additive.pipeline.columns[1].strategy.planExitTargetId, 'testing');
  assert.equal(additive.pipeline.columns.at(-1).role, 'done'); assert.ok(additive.pipeline.columns.some(column => column.id === 'merge'));
  const canonical = resolveRepositoryPipeline(snapshot({ version: 1, columns: [{ id: 'executing', name: 'Build' }], profiles: [] }), current);
  assert.equal(canonical.canonical, true); assert.deepEqual(canonical.pipeline.columns.map(column => column.id), ['todo', 'executing', 'done']); assert.equal(canonical.pipeline.columns[1].name, 'Build');
});

test('repository definitions round-trip stable profiles and targets; a local-only file cannot define or leak shared profiles', () => {
  const current = customPipelineConfig(); current.profiles = [{ id: 'p', name: 'Personal choice', columns: { planning: { planExitTargetId: 'testing' }, executing: { modelOverride: null } } }];
  const definition = repositoryPipelineDefinition(current); assert.equal(definition.profiles[0].columns.Planning.planExitTarget, 'Testing');
  assert.deepEqual(resolveRepositoryPipeline(snapshot(definition), current).pipeline, current);
  const local = { version: 1, columns: [{ name: 'Executing', strategy: { modelOverride: 'personal-model' } }] };
  assert.equal(resolveRepositoryPipeline(snapshot(null, local), current).shared.columns[2].strategy.modelOverride, undefined);
  assert.throws(() => resolveRepositoryPipeline(snapshot(null, { ...local, profiles: [] }), current), { code: 'INVALID_REPOSITORY_PIPELINE' });
});

test('invalid repository references, unsupported fields and malformed rows cannot silently alter a definition', () => {
  const current = customPipelineConfig();
  for (const team of [
    { version: 2, columns: [] }, { version: 1, columns: [{ name: 'Executing', strategy: { planExitTarget: 'Missing' } }] },
    { version: 1, columns: [{ name: 'Executing', strategy: { planExitTarget: 'Testing', planExitTargetId: 'testing' } }] },
    { version: 1, columns: [{ name: 'Executing' }, { name: ' executing ' }] },
    { version: 1, columns: [], profiles: [{ name: 'P', columns: { Missing: {} } }] },
    { version: 1, columns: [], profiles: [{ name: 'P', columns: { Executing: {}, executing: {} } }] },
    { version: 1, columns: [{ name: 'Executing', automations: { onEnter: [{ name: 'Unknown', type: 'other' }] } }] },
  ]) assert.throws(() => resolveRepositoryPipeline(snapshot(team), current));
  assert.throws(() => resolveRepositoryPipeline(snapshot(null), current), { code: 'REPOSITORY_PIPELINE_NOT_FOUND' });
});

test('repository file reads are bounded and fatal UTF-8, detect either source changing, and read only fixed filenames', async t => {
  const root = await temp(t), missing = await readRepositoryPipeline(root); assert.ok(missing.files.every(file => file.hash === null));
  await write(root, 'promptboard.json', repositoryPipelineDefinition(customPipelineConfig()));
  const original = await readRepositoryPipeline(root); assert.match(original.sourceRevision, /^[a-f0-9]{64}$/);
  await write(root, 'promptboard.local.json', { version: 1, columns: [{ name: 'Executing', color: 'green' }] });
  assert.notEqual((await readRepositoryPipeline(root)).sourceRevision, original.sourceRevision);
  await writeFile(join(root, 'promptboard.local.json'), Buffer.from([0xff])); await assert.rejects(readRepositoryPipeline(root), { code: 'INVALID_REPOSITORY_PIPELINE' });
  await writeFile(join(root, 'promptboard.local.json'), '{'); await assert.rejects(readRepositoryPipeline(root), { code: 'INVALID_REPOSITORY_PIPELINE' });
  await writeFile(join(root, 'promptboard.local.json'), ' '.repeat(4 * 1024 * 1024 + 1)); await assert.rejects(readRepositoryPipeline(root), { code: 'INVALID_REPOSITORY_PIPELINE' });
  await rm(join(root, 'promptboard.local.json')); await mkdir(join(root, 'promptboard.local.json')); await assert.rejects(readRepositoryPipeline(root), { code: 'INVALID_REPOSITORY_PIPELINE' });
});

test('repository config refuses hardlinks and descendant symlinks without reading the outside definition', async t => {
  const root = await temp(t), outside = await temp(t), file = join(outside, 'outside.json'); await writeFile(file, '{}');
  await link(file, join(root, 'promptboard.json')); await assert.rejects(readRepositoryPipeline(root), { code: 'INVALID_REPOSITORY_PIPELINE' }); await rm(join(root, 'promptboard.json'));
  if (process.platform === 'win32') return;
  await symlink(file, join(root, 'promptboard.json')); await assert.rejects(readRepositoryPipeline(root), { code: 'INVALID_REPOSITORY_PIPELINE' });
  const parent = await temp(t); await symlink(root, join(parent, 'linked')); await assert.rejects(readRepositoryPipeline(join(parent, 'linked')), { code: 'REPOSITORY_PIPELINE_ROOT_CHANGED' });
});

test('reviewed repository configuration applies atomically without launching, connecting Base, touching prompt bytes or modifying files', async t => {
  const w = await world(t), prompt = '  Engineered <literal>\r\n😀  ';
  const task = await w.board.createTask({ projectId: w.projectId, title: 'Composer split', prompt });
  const team = repositoryPipelineDefinition(w.pipeline); team.columns[2].name = 'Build'; team.columns[2].strategy.autoSpawn = true;
  team.columns[1].strategy.planExitTarget = 'Build';
  team.columns[2].automations.onEnter = [{ name: 'Notify later', type: 'notify', title: 'Literal <img src=x>' }];
  team.profiles = [{ id: 'p', name: 'Economy', columns: { Build: { modelOverride: 'profile-model' } } }];
  await write(w.root, 'promptboard.json', team); await write(w.root, 'promptboard.local.json', { version: 1, columns: [{ name: 'Build', color: 'green', strategy: { effortOverride: 'low' } }] });
  const bytes = await readFile(join(w.root, 'promptboard.json'), 'utf8'), before = structuredClone(await w.board.state());
  const preview = await w.board.previewRepositoryPipeline(w.projectId); assert.deepEqual(await w.board.state(), before); assert.deepEqual(preview.changes.renamed, ['Build']);
  w.board.executor = { start() { assert.fail('Configuration must not dispatch.'); }, validate() { assert.fail('Configuration must not probe a CLI.'); } };
  const saved = await w.board.applyRepositoryPipeline(w.projectId, { ...preview, confirm: true }); assert.equal(saved.pipeline.columns[2].name, 'Build'); assert.equal(saved.pipeline.columns[2].color, 'green');
  assert.equal(saved.tasks[0].prompt, prompt); assert.equal(saved.tasks[0].revision, task.revision); assert.equal(saved.tasks[0].contentRevision, 1);
  assert.deepEqual((await w.board.state()).runs, []); assert.deepEqual((await w.board.state()).base, before.base); assert.equal(await readFile(join(w.root, 'promptboard.json'), 'utf8'), bytes);
  assert.equal(git(w.root, 'status', '--porcelain').split('\n').length, 2); assert.equal(saved.repositoryPipeline.sourceRevision, preview.sourceRevision);
  await rm(join(w.root, 'promptboard.local.json')); const withoutLocal = await w.board.previewRepositoryPipeline(w.projectId); assert.equal(withoutLocal.pipeline.columns[2].color, w.pipeline.columns[2].color); assert.equal(withoutLocal.pipeline.columns[2].strategy.effortOverride, undefined);
});

test('changed file or project snapshots, missing confirmation, active runs and occupied removals never apply silently', async t => {
  const w = await world(t), team = repositoryPipelineDefinition(w.pipeline); await write(w.root, 'promptboard.json', team);
  const preview = await w.board.previewRepositoryPipeline(w.projectId), before = structuredClone(await w.board.state());
  await assert.rejects(w.board.applyRepositoryPipeline(w.projectId, preview), { code: 'CONFIRMATION_REQUIRED' });
  await assert.rejects(w.board.applyRepositoryPipeline(w.projectId, { ...preview, sourceRevision: 'x', confirm: true }), { code: 'INVALID_REPOSITORY_PIPELINE' });
  await write(w.root, 'promptboard.local.json', { version: 1, columns: [] }); await assert.rejects(w.board.applyRepositoryPipeline(w.projectId, { ...preview, confirm: true }), { code: 'REPOSITORY_PIPELINE_CHANGED' }); assert.deepEqual(await w.board.state(), before);
  const stale = await w.board.previewRepositoryPipeline(w.projectId); await w.board.renameProject(w.projectId, { name: 'New name', expectedRevision: stale.expectedProjectRevision });
  await assert.rejects(w.board.applyRepositoryPipeline(w.projectId, { ...stale, confirm: true }), { code: 'REPOSITORY_PIPELINE_CHANGED' });
  const task = await w.board.createTask({ projectId: w.projectId, title: 'Occupied', prompt: 'Exact' }); await w.board.transition(task.id, { column: 'testing', expectedRevision: 1 });
  const removed = team.columns.findIndex(column => column.id === 'testing'); team.columns.splice(removed, 1); await write(w.root, 'promptboard.json', team);
  const occupied = await w.board.previewRepositoryPipeline(w.projectId); assert.equal(occupied.conflicts.length, 1); const prior = structuredClone(await w.board.state());
  await assert.rejects(w.board.applyRepositoryPipeline(w.projectId, { ...occupied, confirm: true }), { code: 'COLUMN_NOT_EMPTY' }); assert.deepEqual(await w.board.state(), prior);
});

test('repository application respects owned automation and queued run guards without signalling or probing the CLI', async t => {
  const w = await world(t), task = await w.board.createTask({ projectId: w.projectId, title: 'Owned', prompt: 'Exact' });
  await write(w.root, 'promptboard.json', repositoryPipelineDefinition(w.pipeline));
  const preview = await w.board.previewRepositoryPipeline(w.projectId);
  w.board.executor = { start() { assert.fail('No start.'); }, cancel() { assert.fail('No cancel.'); }, validate() { assert.fail('No CLI probe.'); } };
  w.board.automationMoves.set(task.id, {});
  await assert.rejects(w.board.applyRepositoryPipeline(w.projectId, { ...preview, confirm: true }), { code: 'AUTOMATIONS_ACTIVE' }); w.board.automationMoves.delete(task.id);
  await w.board.store.update(state => { const run = { id: 'owned-run', projectId: w.projectId, taskId: task.id, stage: 'executing', status: 'queued', config: { provider: 'claude', pipeline: true } }; state.runs.push(run); attachSession(state, run); });
  const before = structuredClone(await w.board.state());
  await assert.rejects(w.board.applyRepositoryPipeline(w.projectId, { ...preview, confirm: true }), { code: 'RUN_ACTIVE' }); assert.deepEqual(await w.board.state(), before);
});
