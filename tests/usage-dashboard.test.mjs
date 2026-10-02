import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { UsageDashboard, sessionMetrics, limitWindows } from '../src/usage-dashboard.mjs';
import { startServer } from '../src/server.mjs';

async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'pb-dashboard-')); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return dir; }
const stamp = '2026-10-02T00:00:00Z';
const claude = (id, model, tokens) => ({ sessionId: 'session', timestamp: stamp, type: 'assistant', message: { id, model, content: [{ type: 'tool_use', id: `tool-${id}`, name: 'Read', input: { secret: 'private' } }], usage: { input_tokens: tokens, output_tokens: 4, cache_read_input_tokens: 5 } } });
test('usage reducers deduplicate streamed messages and tool calls and keep model changes separate', () => {
  const c = sessionMetrics('claude', [claude('one','opus',10), claude('one','opus',12), claude('two','sonnet',20)], 0);
  assert.deepEqual(c.rows.map(r => [r.model,r.input]), [['opus',12],['sonnet',20]]);
  assert.equal(c.tools.length,2); assert.doesNotMatch(JSON.stringify(c), /private|secret/);
  const event = (input, cached, output) => ({ timestamp: stamp, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } });
  const x = sessionMetrics('codex', [{type:'turn_context',payload:{model:'one'}},event(100,40,10),event(100,40,10),{type:'turn_context',payload:{model:'two'}},event(150,50,20)],0);
  assert.deepEqual(x.rows.map(r=>[r.model,r.input,r.cached,r.output]),[['one',60,40,10],['two',40,10,10]]);
  const g = sessionMetrics('gemini',[{id:'g',type:'gemini',model:'gemini-test',timestamp:stamp,tokens:{input:100,cached:40,output:10,thoughts:5},toolCalls:[{id:'tool',name:'read_file',args:'secret'}]}],0);
  assert.equal(g.rows[0].input,60); assert.equal(g.rows[0].output,15); assert.equal(g.tools[0].name,'read_file'); assert.doesNotMatch(JSON.stringify(g),/secret/);
});
test('limits preserve missing values, zero remaining, and reported reset times', () => {
  assert.deepEqual(limitWindows({primary:{usedPercent:null},secondary:{usedPercent:'10'}}),[]);
  const [limit] = limitWindows({five_hour:{used_percentage:100,resets_at:1790900000}});
  assert.equal(limit.remainingPercent,0);
  assert.equal(limitWindows({five_hour:limit})[0].resetsAt,limit.resetsAt);
});
test('dashboard refresh reads changed local files without double counting and exposes no transcript content', async t => {
  const dir = await temp(t), root = join(dir,'claude'); await mkdir(root);
  const path = join(root,'session.jsonl'); await writeFile(path,JSON.stringify(claude('one','opus',10))+'\n');
  let now = Date.parse(stamp)+1000, calls = 0;
  const service = new UsageDashboard({dataDir:dir,roots:{claude:[root]},now:()=>now,limitReader:async()=>{calls++;return {status:'live',windows:[{label:'primary',remainingPercent:80,usedPercent:20}]};}}); t.after(()=>service.close());
  const first = await service.get(); assert.equal(first.providers[1].inputTokens,10); assert.equal(first.providers[1].costUSD,null);
  assert.equal(first.providers[0].limits.windows[0].remainingPercent,80);
  await service.get(); assert.equal(calls,1);
  await writeFile(path,[claude('one','opus',10),claude('two','sonnet',15)].map(JSON.stringify).join('\n')+'\n');
  now+=60000; const next = await service.refresh();
  assert.equal(next.providers[1].inputTokens,25); assert.equal(next.providers[1].models.length,2);
  assert.equal(next.providers[1].tools[0].count,2);
  assert.doesNotMatch(JSON.stringify(next),/private|secret|tool-one/);
  const fresh = new UsageDashboard({dataDir:dir,roots:{claude:[root]},now:()=>now,limitReader:async()=>({status:'unavailable',windows:[]})}); t.after(()=>fresh.close());
  assert.equal((await fresh.get()).providers[1].inputTokens,25);
});
test('status-line bridge keeps only usage and cost fields, with no credentials or prompts', async t => {
  const dir = await temp(t), path = join(dir,'usage-status.json');
  execFileSync(process.execPath, [fileURLToPath(new URL('../src/usage-status.mjs',import.meta.url)),path], { input: JSON.stringify({session_id:'session',cost:{total_cost_usd:.5},rate_limits:{five_hour:{used_percentage:25,resets_at:1791000000}},secret:'never-store',prompt:'private prompt'}) });
  const { readFile } = await import('node:fs/promises'); const value = await readFile(path,'utf8');
  assert.doesNotMatch(value,/never-store|private prompt/); assert.equal(JSON.parse(value).costUSD,.5);
});
test('usage API requires the session token and sanitizes failures', async t => {
  const dir = await temp(t); let fail = false;
  const app = await startServer({port:0,dataDir:dir,executor:null,usageReader:{get:async()=>{if(fail)throw new Error('secret');return {providers:[],updatedAt:1};}}}); t.after(()=>app.close());
  assert.equal((await fetch(app.url+'/api/usage')).status,403);
  const {token}=await (await fetch(app.url+'/api/session')).json(); const headers={'X-STE-Token':token};
  assert.deepEqual(await (await fetch(app.url+'/api/usage',{headers})).json(),{providers:[],updatedAt:1});
  fail=true; const response=await fetch(app.url+'/api/usage',{headers}); assert.equal(response.status,502); assert.doesNotMatch(await response.text(),/secret/);
});


test('allowance failures retain the last known observation as stale, never fresh or reset', async t => {
  const dir = await temp(t); let fail = false;
  const service = new UsageDashboard({dataDir:dir,roots:{},limitReader:async()=>{if(fail)throw new Error('private');return {status:'live',checkedAt:10,windows:[{label:'primary',remainingPercent:0,usedPercent:100}]};}}); t.after(()=>service.close());
  await service.get(); fail=true;
  const value=(await service.refresh()).providers[0].limits;
  assert.equal(value.status,'stale'); assert.equal(value.checkedAt,10); assert.equal(value.windows[0].remainingPercent,0);
  assert.doesNotMatch(JSON.stringify(value),/private/);
});
