import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers/test-server.mjs';
import { defaultPipelineConfig } from '../src/pipeline-config.mjs';

async function setup(t, actions) {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] }), project = await app.board.createProject({ name: 'Guarded restore' }), pipeline = defaultPipelineConfig();
  for (const column of pipeline.columns) column.strategy.autoSpawn = false;
  if (actions) pipeline.columns.find(column=>column.role==='done').automations.onExit = [{ id: 'disabled-row', name: 'Disabled script', type: 'run_script', enabled: false, script: 'must not run' }];
  await app.board.setPipeline(project.id, { pipeline, expectedRevision: project.revision, confirm: true });
  const task = await app.board.createTask({ projectId: project.id, title: 'Restore', prompt: 'Exact\r\n' });
  await app.board.transition(task.id, { column: 'done', expectedRevision: task.revision, transitionId: 'archive-for-restore' });
  return { app, projectId: project.id, taskId: task.id, pipeline };
}

for (const actions of [false, true]) test(`an optional public settings revision rejects a changed pipeline before lifecycle or action intent (${actions ? 'journaled' : 'plain'}) and preserves exact-ID replay`, async t => {
  const { app, projectId, taskId, pipeline } = await setup(t, actions);
  const original = (await app.board.state()).projects.find(p=>p.id===projectId), task = original.tasks[0];
  const changed = structuredClone(pipeline); changed.columns[2].description = 'Changed settings';
  await app.board.setPipeline(projectId, { pipeline: changed, expectedRevision: original.revision, confirm: true });
  const before = structuredClone(await app.board.state()), request = { column: 'executing', expectedRevision: task.revision, expectedProjectRevision: original.revision, transitionId: 'stable-restore' };
  await assert.rejects(app.board.transition(taskId, request), { code: 'REVISION_CONFLICT' }); assert.deepEqual(await app.board.state(), before); assert.deepEqual(await app.board.automationRuns(taskId), []);
  for (const value of [-1, '2', 1.5, Number.MAX_SAFE_INTEGER+1]) await assert.rejects(app.board.transition(taskId, { ...request, expectedProjectRevision: value }), { code: 'INVALID_INPUT' });
  assert.deepEqual(await app.board.state(), before);
  const current = before.projects.find(p=>p.id===projectId), accepted = { ...request, expectedProjectRevision: current.revision };
  assert.equal((await app.board.transition(taskId, accepted)).task.column, 'executing');
  const later = structuredClone(changed); later.columns[2].description = 'Later settings';
  await app.board.setPipeline(projectId, { pipeline: later, expectedRevision: current.revision, confirm: true });
  const after = structuredClone(await app.board.state());
  assert.equal((await app.board.transition(taskId, accepted)).duplicate, true); assert.deepEqual(await app.board.state(), after); assert.deepEqual(after.runs, []);
});

test('the authenticated move route enforces the settings revision rather than discarding it; older-style moves stay compatible', async t => {
  const { app, projectId, taskId } = await setup(t, false), project = (await app.board.state()).projects.find(p=>p.id===projectId), task = project.tasks[0];
  const session = await (await fetch(`${app.url}/api/session`)).json(); assert.equal(session.capabilities.pipelineBulkRestore, true);
  const post = body => fetch(`${app.url}/api/tasks/${taskId}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-STE-Token': session.token, Origin: app.url }, body: JSON.stringify(body) });
  const before = structuredClone(await app.board.state());
  const response = await post({ column: 'executing', expectedRevision: task.revision, expectedProjectRevision: project.revision-1, transitionId: 'http-stale' });
  assert.equal(response.status, 409); assert.equal((await response.json()).code, 'REVISION_CONFLICT'); assert.deepEqual(await app.board.state(), before);
  assert.equal((await post({ column: 'executing', expectedRevision: task.revision, expectedProjectRevision: 'invalid' })).status, 400);
  assert.equal((await post({ column: 'executing', expectedRevision: task.revision, transitionId: 'compatible-old-move' })).status, 200);
  assert.deepEqual((await app.board.state()).runs, []);
});

test('the optional pipeline settings guard cannot dispatch a legacy stage', async t => {
  const {app}=await setup(t,false),project=await app.board.createProject({name:'Legacy'}),task=await app.board.createTask({projectId:project.id,title:'Legacy task',prompt:'Required body'});
  const before=structuredClone(await app.board.state());
  await assert.rejects(app.board.transition(task.id,{column:'executing',expectedRevision:task.revision,expectedProjectRevision:project.revision}),{code:'PIPELINE_REQUIRED'});
  assert.deepEqual(await app.board.state(),before);
});
