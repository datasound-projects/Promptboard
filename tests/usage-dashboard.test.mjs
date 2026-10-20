import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
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
  // A resumed or forked session repeats earlier messages under a new session ID; they count once.
  await writeFile(join(root,'fork.jsonl'),[{...claude('one','opus',10),sessionId:'fork'},{...claude('three','opus',7),sessionId:'fork'}].map(JSON.stringify).join('\n')+'\n');
  const forked = new UsageDashboard({dataDir:dir,roots:{claude:[root]},now:()=>now,limitReader:async()=>({status:'unavailable',windows:[]})}); t.after(()=>forked.close());
  const usage = (await forked.get()).providers[1]; assert.equal(usage.inputTokens,32); assert.equal(usage.tools[0].count,3);
});
test('background refresh runs only while usage is requested and stops after five idle minutes', async t => {
  const dir = await temp(t);
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = Date.parse(stamp), calls = 0;
  const service = new UsageDashboard({dataDir:dir,roots:{claude:[join(dir,'none')]},now:()=>now,limitReader:async()=>{calls++;return {status:'unavailable',windows:[]};}}); t.after(()=>service.close());
  assert.equal(service.timer, undefined, 'nothing runs before the first request');
  await service.get(); assert.equal(calls,1);
  now += 60000; t.mock.timers.tick(60000); await service.pending; assert.equal(calls,2,'a recent request keeps the refresh going');
  now += 5 * 60000; t.mock.timers.tick(60000); await service.pending; assert.equal(calls,2,'idle: no refresh');
  assert.equal(service.timer, null);
  await service.get({ refresh: true }); assert.equal(calls,3); assert.ok(service.timer, 'the next request starts it again');
});
test('the file cap counts only sessions inside the 30-day window', async t => {
  const dir = await temp(t), root = join(dir,'claude'), old = join(root,'a-old'), recent = join(root,'z-new'); await mkdir(old,{recursive:true}); await mkdir(recent);
  const long = new Date(Date.parse(stamp) - 90 * 86400000);
  for (let i = 0; i < 5001; i++) { const file = join(old,`${i}.jsonl`); await writeFile(file,''); await utimes(file,long,long); }
  await writeFile(join(recent,'session.jsonl'),JSON.stringify(claude('one','opus',10))+'\n');
  const service = new UsageDashboard({dataDir:dir,roots:{claude:[root]},now:()=>Date.parse(stamp)+1000,limitReader:async()=>({status:'unavailable',windows:[]})}); t.after(()=>service.close());
  const claudeUsage = (await service.get()).providers[1];
  assert.equal(claudeUsage.inputTokens,10); assert.equal(claudeUsage.partial,false);
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


test('incremental Codex collection preserves totals and models across chunks without duplication', () => {
  const context = model => ({type:'turn_context',payload:{model}});
  const event = input => ({timestamp:stamp,payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,output_tokens:10,cached_input_tokens:0}}}});
  const first = sessionMetrics('codex',[context('one'),event(100)],0);
  const next = sessionMetrics('codex',[event(100),context('two'),event(160)],0,first);
  assert.deepEqual(next.rows.map(r=>[r.model,r.input]),[['one',100],['two',60]]);
});

test('Codex rollout limits are read, and daily totals use local calendar days across a DST change', async t => {
  const [limit] = sessionMetrics('codex', [{ timestamp: stamp, payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex', primary: { used_percent: 25, window_minutes: 300, resets_at: 1791000000 }, secondary: null, credits: { has_credits: false } } } }], 0).limits.windows;
  assert.deepEqual(limit, { label: 'primary', usedPercent: 25, remainingPercent: 75, resetsAt: new Date(1791000000 * 1000).toISOString(), windowMinutes: 300 });
  const zone = process.env.TZ; process.env.TZ = 'America/New_York';
  t.after(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });
  const dir = await temp(t), root = join(dir,'claude'); await mkdir(root);
  // 23:00 on 8 March 2026 in New York, the day clocks moved forward, is 03:00 UTC on 9 March.
  await writeFile(join(root,'late.jsonl'), JSON.stringify({ ...claude('late','opus',10), timestamp: '2026-03-09T03:00:00Z' })+'\n');
  const service = new UsageDashboard({dataDir:dir,roots:{claude:[root]},now:()=>Date.parse('2026-03-09T04:30:00Z'),limitReader:async()=>({status:'unavailable',windows:[]})}); t.after(()=>service.close());
  const { daily } = (await service.get()).providers[1];
  assert.equal(new Set(daily.map(d => d.day)).size, 30);
  assert.equal(daily[0].day, '2026-02-08');
  assert.deepEqual(daily.slice(-2), [{ day: '2026-03-08', tokens: 19 }, { day: '2026-03-09', tokens: 0 }]);
});

test('a forked Codex rollout that repeats its parent session_meta counts as its own session', async t => {
  const dir = await temp(t), root = join(dir,'codex'); await mkdir(root);
  const meta = id => ({ type: 'session_meta', payload: { id } });
  const tokens = input => ({ timestamp: stamp, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 1 } } } });
  await writeFile(join(root,'rollout-a-parent.jsonl'), [meta('parent'), tokens(100)].map(JSON.stringify).join('\n')+'\n');
  await writeFile(join(root,'rollout-b-child.jsonl'), [meta('child'), meta('parent'), tokens(40)].map(JSON.stringify).join('\n')+'\n');
  const service = new UsageDashboard({dataDir:dir,roots:{codex:[root]},now:()=>Date.parse(stamp)+1000,limitReader:async()=>({status:'unavailable',windows:[]})}); t.after(()=>service.close());
  const codex = (await service.get()).providers[0];
  assert.equal(codex.inputTokens, 140); assert.equal(codex.sessions, 2);
});

test('one refresh reads a whole long session; history left at the time limit is labelled as still reading', async t => {
  const dir = await temp(t), root = join(dir,'claude'); await mkdir(root);
  // More than one 16 MiB read of other records comes before the counted message.
  const filler = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(1000) } }) + '\n';
  await writeFile(join(root,'long.jsonl'), filler.repeat(17 * 1024) + JSON.stringify(claude('one','opus',10)) + '\n');
  const open = options => { const service = new UsageDashboard({dataDir:dir,roots:{claude:[root]},now:()=>Date.parse(stamp)+1000,limitReader:async()=>({status:'unavailable',windows:[]}),...options}); t.after(()=>service.close()); return service; };
  const read = (await open().get()).providers[1];
  assert.deepEqual([read.reading, read.partial, read.inputTokens], [false, false, 10], 'The first refresh already counts the whole file.');
  const late = open({ readBudgetMs: 0 }), waiting = (await late.get()).providers[1];
  assert.deepEqual([waiting.reading, waiting.partial, waiting.inputTokens], [true, false, 0]);
  late.readBudgetMs = 30000;
  assert.equal((await late.refresh()).providers[1].inputTokens, 10);
});
