import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Board, COLUMNS } from '../src/board.mjs';

async function board(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-base-backup-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return new Board({ dataDir });
}
const binding = resourceId => ({ mode: 'extend', include: [{ resourceId, required: true }], exclude: [] });
async function fixture(t) {
  const source = await board(t);
  const instruction = await source.base.create({ kind: 'skill', name: 'Portable skill', content: { body: 'Private instruction content.' } });
  const profile = await source.base.create({ kind: 'profile', name: 'Reusable agent', configuration: { agent: { provider: 'codex', model: 'custom-model' }, binding: binding(instruction.id) } });
  const pack = await source.base.create({ kind: 'pack', name: 'Pack', configuration: { resources: [{ resourceId: instruction.id }] } });
  const project = await source.createProject({ name: 'Portable project' });
  const task = await source.createTask({ projectId: project.id, title: 'Card', prompt: '  Exact prompt\r\nbytes\n' });
  await source.store.update(state => {
    state.projects[0].columnLayout = [...COLUMNS.slice(0, 3).map(column => ({ id: column.id })), { id: 'c_custom1', custom: true, title: 'Custom', agent: { enabled: false } }, ...COLUMNS.slice(3).map(column => ({ id: column.id }))];
  });
  await source.base.apply({ changes: [
    { target: { scope: 'global' }, binding: binding(instruction.id), profileId: profile.id },
    { target: { scope: 'project', projectId: project.id }, binding: binding(pack.id), profileId: profile.id },
    { target: { scope: 'column', projectId: project.id, columnId: 'c_custom1' }, binding: binding(instruction.id), profileId: profile.id },
    { target: { scope: 'task', projectId: project.id, taskId: task.id }, binding: { mode: 'replace', include: [], exclude: [] } },
    { target: { scope: 'task-column', projectId: project.id, taskId: task.id, columnId: 'c_custom1' }, binding: binding(instruction.id) },
  ] });
  return { source, project, task, instruction, profile, pack };
}

test('board backup v3 preserves scope references and exact task text, with an explicit document-content choice', async t => {
  const { source, project, task, instruction, profile } = await fixture(t);
  const ordinary = await source.exportBackup(); assert.equal(ordinary.version, 11); assert.equal(ordinary.base.includesContent, false);
  assert.equal(JSON.stringify(ordinary).includes('Private instruction content.'), false);
  const portable = await source.exportBackup({ includeBaseContent: true });
  assert.equal(portable.base.includesContent, true); assert.ok(JSON.stringify(portable).includes('Private instruction content.'));
  assert.equal(portable.baseGlobal.agentProfileId, profile.id); assert.equal(portable.projects[0].id, project.id); assert.equal(portable.projects[0].tasks[0].id, task.id);
  assert.equal(portable.projects[0].tasks[0].prompt, '  Exact prompt\r\nbytes\n');
  assert.equal(portable.projects[0].tasks[0].baseColumns.c_custom1.binding.include[0].resourceId, instruction.id);
  assert.equal('runs' in portable, false); assert.equal('workspace' in portable.projects[0].tasks[0], false);
});

test('an import refused for confirmation writes no Base revision files', async t => {
  const { source } = await fixture(t), target = await board(t);
  await target.createProject({ name: 'Current work' });
  const revisions = () => readdir(join(target.dataDir, 'base', 'revisions')).catch(() => []);
  const before = await revisions();
  await assert.rejects(target.importBackup(await source.exportBackup({ includeBaseContent: true })), { code: 'CONFIRMATION_REQUIRED' });
  assert.deepEqual(await revisions(), before);
  assert.equal((await target.state()).base.resources.length, 0);
});

test('import remaps every Base reference, preserves existing local resources and waits for profile/global confirmation', async t => {
  const { source, instruction, profile, pack } = await fixture(t), target = await board(t);
  const existing = await target.base.create({ ...{ kind: 'skill', name: 'Existing same ID', content: { body: 'Do not replace me.' } }, id: instruction.id });
  await target.importBackup(await source.exportBackup({ includeBaseContent: true }));
  const state = await target.state(), project = state.projects[0], resources = state.base.resources;
  const importedSkill = resources.find(resource => resource.name === 'Portable skill'), importedProfile = resources.find(resource => resource.name === 'Reusable agent'), importedPack = resources.find(resource => resource.name === 'Pack');
  assert.notEqual(importedSkill.id, instruction.id); assert.notEqual(importedProfile.id, profile.id); assert.notEqual(importedPack.id, pack.id);
  assert.equal((await target.base.detail(existing.id)).content.body, 'Do not replace me.');
  assert.equal(project.baseBinding, undefined); assert.equal(project.agentProfileId, undefined); assert.equal(project.pendingImport.agentProfileId, importedProfile.id);
  assert.equal(project.pendingImport.baseBinding.include[0].resourceId, importedPack.id); assert.equal(project.pendingImport.baseColumns.c_custom1.profileId, importedProfile.id);
  assert.equal(project.tasks[0].baseBinding.mode, 'replace'); assert.equal(project.tasks[0].baseColumns.c_custom1.binding.include[0].resourceId, importedSkill.id);
  assert.equal(state.settings.agentProfileId, undefined); assert.equal(state.settings.pendingBaseImport.agentProfileId, importedProfile.id);
  assert.equal(state.runs.length, 0); assert.equal(project.columnLayout.find(column => column.id === 'c_custom1').agent.enabled, false);
  for (const resource of resources.filter(resource => resource.id !== existing.id)) { assert.equal(resource.enabled, false); assert.equal(resource.trust, 'untrusted'); }
  assert.ok((await target.base.detail(importedProfile.id)).usedBy.some(use => use.kind === 'pending-assignment'));
  await target.confirmImport(project.id, { accept: true, expectedRevision: project.revision });
  assert.equal((await target.state()).projects[0].agentProfileId, importedProfile.id);
  await assert.rejects(target.restoreBaseGlobals({ confirm: false }), { code: 'CONFIRMATION_REQUIRED' });
  await target.restoreBaseGlobals({ confirm: true, expectedBaseRevision: (await target.state()).base.revision });
  assert.equal((await target.state()).settings.agentProfileId, importedProfile.id);
});

test('exporting an unconfirmed board import retains its pending Base selections', async t => {
  const { source } = await fixture(t), target = await board(t);
  await target.importBackup(await source.exportBackup());
  const state = await target.state(), again = await target.exportBackup();
  assert.equal(again.projects[0].agentProfileId, state.projects[0].pendingImport.agentProfileId);
  assert.deepEqual(again.projects[0].baseColumns, state.projects[0].pendingImport.baseColumns);
  assert.equal(again.baseGlobal.agentProfileId, state.settings.pendingBaseImport.agentProfileId);
});

test('missing, wrong-type and removed-column Base references reject the whole backup without accidental rebinding', async t => {
  const { source, instruction } = await fixture(t), target = await board(t), good = await source.exportBackup();
  const before = structuredClone(await target.state());
  const missing = structuredClone(good); missing.base.resources = missing.base.resources.filter(resource => resource.id !== instruction.id);
  await assert.rejects(target.importBackup(missing), /missing|dependency/i);
  const wrongType = structuredClone(good); wrongType.projects[0].agentProfileId = instruction.id;
  await assert.rejects(target.importBackup(wrongType), { code: 'INVALID_BACKUP' });
  const wrongColumn = structuredClone(good); wrongColumn.projects[0].tasks[0].baseColumns.c_absent = { binding: binding(instruction.id) };
  await assert.rejects(target.importBackup(wrongColumn), { code: 'INVALID_BACKUP' });
  assert.deepEqual(await target.state(), before);
});

test('unrelated state writes permit import; Base changes during async preparation reject atomically', async t => {
  const { source } = await fixture(t), target = await board(t), portable = await source.exportBackup();
  const realPrepare = target.base.prepareImport.bind(target.base);
  target.base.prepareImport = async (...args) => { const prepared = await realPrepare(...args); await target.base.create({ kind: 'skill', name: 'Concurrent', content: { body: 'Keep this.' } }); return prepared; };
  await assert.rejects(target.importBackup(portable), { code: 'BASE_REVISION_CONFLICT' });
  assert.equal((await target.state()).projects.length, 0); assert.deepEqual((await target.base.list()).resources.map(resource => resource.name), ['Concurrent']);
  target.base.prepareImport = async (...args) => { const prepared = await realPrepare(...args); await target.store.update(state => { state.settings.theme = 'dark'; }); return prepared; };
  await target.importBackup(portable); assert.equal((await target.state()).projects.length, 1); assert.equal((await target.state()).settings.theme, 'dark');
});

test('board+Base import state-write failure keeps the existing board and registry intact', async t => {
  const { source } = await fixture(t), target = await board(t); await target.createProject({ name: 'Keep project' });
  const before = structuredClone(await target.state()), portable = await source.exportBackup();
  await rm(join(target.dataDir, 'state.json.bak'), { force: true }); await mkdir(join(target.dataDir, 'state.json.bak'));
  await assert.rejects(target.importBackup(portable, { replace: true }), { code: 'STATE_WRITE_FAILED' });
  assert.deepEqual(await target.state(), before); assert.equal(JSON.parse(await readFile(join(target.dataDir, 'state.json'), 'utf8')).projects[0].name, 'Keep project');
});

test('supported older backups retain their old confirmation semantics and do not touch the local Base library', async t => {
  const target = await board(t), resource = await target.base.create({ kind: 'skill', name: 'Local', content: { body: 'Local.' } });
  await target.importBackup({ kind: 'promptboard-backup', version: 2, projects: [{ id: 'old', name: 'Older board', tasks: [{ id: 'old-card', title: 'Old card', prompt: 'Original', column: 'todo' }], workflow: { executing: { policy: 'start', provider: 'codex' } } }] });
  const state = await target.state(); assert.equal(state.projects[0].pendingImport.workflow.executing.provider, 'codex'); assert.equal(state.projects[0].workflow.executing, undefined);
  assert.equal(state.base.resources[0].id, resource.id); assert.equal(state.settings.pendingBaseImport, undefined);
});

test('restoring imported global opt-out clears a previous profile and rejects stale revisions', async t => {
  const target = await board(t), profile = await target.base.create({ kind: 'profile', name: 'Existing profile', configuration: { agent: { provider: 'codex' } } });
  await target.base.apply({ changes: [{ target: { scope: 'global' }, binding: { mode: 'inherit' }, profileId: profile.id }] });
  await target.store.update(state => { state.settings.pendingBaseImport = { baseBinding: { mode: 'replace', include: [], exclude: [] }, baseRevision: 1 }; });
  const state = await target.state(); await assert.rejects(target.restoreBaseGlobals({ confirm: true, expectedBaseRevision: state.base.revision - 1 }), { code: 'BASE_REVISION_CONFLICT' });
  await target.restoreBaseGlobals({ confirm: true, expectedBaseRevision: state.base.revision });
  assert.equal((await target.state()).settings.agentProfileId, undefined); assert.equal((await target.state()).settings.baseBinding.mode, 'replace');
});

test('confirming imported project Base settings cannot overwrite a newer user assignment', async t => {
  const { source } = await fixture(t), target = await board(t); await target.importBackup(await source.exportBackup());
  const project = (await target.state()).projects[0];
  await target.base.apply({ changes: [{ target: { scope: 'column', projectId: project.id, columnId: 'executing' }, binding: { mode: 'replace' } }] });
  await assert.rejects(target.confirmImport(project.id, { accept: true, expectedRevision: project.revision }), { code: 'BASE_TARGET_REVISION_CONFLICT' });
  assert.equal((await target.state()).projects[0].baseColumns.executing.binding.mode, 'replace');
});

test('removing a custom column also detaches pending imported Base settings before confirmation', async t => {
  const { source } = await fixture(t), target = await board(t);
  await target.importBackup(await source.exportBackup());
  let state = await target.state(), project = state.projects[0];
  assert.ok(project.pendingImport.baseColumns.c_custom1);
  const revision = state.base.revision;
  await target.setColumns(project.id, { columns: project.columnLayout.filter(column => column.id !== 'c_custom1'), expectedRevision: project.revision });
  state = await target.state(); project = state.projects[0];
  assert.equal(project.pendingImport.baseColumns.c_custom1, undefined); assert.equal(project.tasks[0].baseColumns.c_custom1, undefined);
  assert.ok(state.base.revision > revision);
  await target.confirmImport(project.id, { accept: true, expectedRevision: project.revision });
  assert.equal((await target.state()).projects[0].baseColumns.c_custom1, undefined);
  const exported = await target.exportBackup(), restored = await board(t);
  await restored.importBackup(exported); assert.equal((await restored.state()).projects.length, 1, 'No dangling column reference makes the next backup unreadable.');
});
