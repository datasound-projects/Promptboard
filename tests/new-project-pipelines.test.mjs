import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { startTestServer } from './helpers/test-server.mjs';
import { Board } from '../src/board.mjs';
import { defaultPipelineConfig } from '../src/pipeline-config.mjs';

async function temp(t) { const path = await realpath(await mkdtemp(join(tmpdir(), 'pb-new-pipeline-')));
  t.after(()=>rm(path,{recursive:true,force:true,maxRetries:10,retryDelay:100})); return path; }
async function world(t) {
  const projectsDir = await temp(t), app = await startTestServer(t, { port: 0, projectsDir, executor: null, detector: async()=>[] });
  const { token } = await (await fetch(app.url+'/api/session')).json();
  const call = async (method,path,body)=> { const response=await fetch(app.url+path,{method,headers:{'x-ste-token':token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,data:await response.json()}; };
  return {app,projectsDir,call};
}

test('new app projects default to the exact empty seven-column pipeline and retain Composer/split To Do input without agents', async t=>{
  const {app,call}=await world(t), created=await call('POST','/api/projects',{name:'New pipeline'});
  assert.equal(created.status,200); const project=created.data.project;
  assert.equal(project.workflowMode,'pipeline'); assert.deepEqual(project.pipeline,defaultPipelineConfig());
  assert.ok(project.repository && project.targetBranch);
  for(const [title,prompt] of [['Engineered','  Exact {{title}}\r\n雪  '],['Split task','<literal>\nbody'],['Title only','']]) {
    const result=await call('POST','/api/tasks',{projectId:project.id,title,prompt}); assert.equal(result.status,200);
    assert.equal(result.data.task.column,'todo'); assert.equal(result.data.task.prompt,prompt); assert.equal(result.data.task.workspace,null);
  }
  const state=await app.board.state(); assert.deepEqual(state.runs,[]); assert.deepEqual(state.sessions,[]);
  assert.equal((await app.board.automationRuns(state.projects[0].tasks[0].id)).length,0);
  const persisted=await new Board({dataDir:app.board.store.dir}).state(); assert.deepEqual(persisted.projects[0].pipeline,project.pipeline);
});

test('opening an existing folder makes a new pipeline while selecting saved legacy projects changes no workflow', async t=>{
  const {app,call}=await world(t), folder=await temp(t); await writeFile(join(folder,'notes.txt'),'User bytes\r\n');
  const original=await app.board.createProject({name:'Saved stages'}), before=structuredClone((await app.board.state()).projects[0]);
  const opened=await call('POST','/api/projects',{name:'Opened pipeline',folder}); assert.equal(opened.status,200);
  assert.equal(opened.data.project.workflowMode,'pipeline'); assert.deepEqual(opened.data.project.pipeline,defaultPipelineConfig());
  assert.equal(await readFile(join(folder,'notes.txt'),'utf8'),'User bytes\r\n');
  assert.equal(execFileSync('git',['status','--porcelain'],{cwd:folder,encoding:'utf8'}).trim(),'?? notes.txt');
  await call('GET','/api/board'); assert.deepEqual((await app.board.state()).projects.find(project=>project.id===original.id),before);
  const legacy=await call('POST','/api/projects',{name:'Explicit stages',workflowMode:'legacy'}); assert.equal(legacy.status,200);
  assert.equal(legacy.data.project.workflowMode,'legacy'); assert.equal(legacy.data.project.pipeline,undefined);
});

test('invalid new-project modes are rejected before folder creation and cannot publish partial projects', async t=>{
  const {app,projectsDir,call}=await world(t);
  for(const workflowMode of ['unknown',null,{},true]) {
    const result=await call('POST','/api/projects',{name:'Invalid',workflowMode}); assert.equal(result.status,400);
    assert.equal(result.data.code,'INVALID_INPUT'); assert.deepEqual(await readdir(projectsDir),[]); assert.deepEqual((await app.board.state()).projects,[]);
  }
});
