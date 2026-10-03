import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_SCRIPT, buildSession, resolveConfig } from '../src/agents.mjs';
import { ACTIVITY_QUIET_MS, SessionActivity } from '../src/session-activity.mjs';

async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'pb-activity-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test('silence and permission waits never become a completed turn; quiet output is only a secondary gate', () => {
  const activity = new SessionActivity('claude');
  assert.equal(activity.snapshot(100000).ready, false);
  activity.observe({ name: 'UserPromptSubmit' }, 1);
  activity.output(2); assert.equal(activity.snapshot(100000).ready, false);
  activity.observe({ name: 'PermissionRequest' }, 3);
  assert.equal(activity.snapshot(100000).phase, 'waiting'); assert.equal(activity.snapshot(100000).ready, false);
  activity.observe({ name: 'Stop' }, 4);
  assert.equal(activity.snapshot(4 + ACTIVITY_QUIET_MS - 1).ready, false);
  assert.equal(activity.snapshot(4 + ACTIVITY_QUIET_MS).ready, true);
  activity.output(2000); assert.equal(activity.snapshot(3000).ready, false);
  assert.equal(activity.snapshot(3500).ready, true);
  activity.observe({ name: 'UserPromptSubmit' }, 3501); assert.equal(activity.snapshot(100000).ready, false);
  activity.observe({ name: 'Stop' }, 3502); activity.observe({ name: 'SessionEnd' }, 3503);
  assert.equal(activity.snapshot(100000).phase, 'ended'); assert.equal(activity.snapshot(100000).ready, false);
});

test('parallel tools, failures, subagents and native background snapshots hold a completed parent response', () => {
  const a = new SessionActivity('claude'); let at = 1;
  const emit = event => a.observe(event, at++);
  emit({ name: 'PreToolUse', toolId: 'one', tool: 'Bash' });
  emit({ name: 'PreToolUse', toolId: 'two', tool: 'Bash' });
  emit({ name: 'PreToolUse', toolId: 'one', tool: 'Bash' }); // Repeated ID is one tool.
  emit({ name: 'SubagentStart', agentId: 'child' });
  emit({ name: 'PreToolUse', agentId: 'child', toolId: 'one', tool: 'Read' });
  emit({ name: 'Stop', agentId: 'child' });
  assert.equal(a.snapshot(100000).parentTurnComplete, false);
  emit({ name: 'Stop', backgroundCount: 1, scheduledCount: 1 });
  assert.deepEqual([a.snapshot().tools, a.snapshot().subagents, a.snapshot().background, a.snapshot().scheduled], [3, 1, 1, 1]);
  assert.equal(a.snapshot(100000).ready, false);
  emit({ name: 'PostToolUse', toolId: 'one' }); emit({ name: 'PostToolUse', toolId: 'one' });
  assert.equal(a.snapshot().tools, 2);
  emit({ name: 'PostToolUseFailure', toolId: 'two' });
  emit({ name: 'PostToolUse', agentId: 'child', toolId: 'one' });
  emit({ name: 'SubagentStop', agentId: 'child', backgroundCount: 0, scheduledCount: 0 });
  assert.equal(a.snapshot(100000).ready, true);
  emit({ name: 'PreToolUse', toolId: 'background', backgroundRequested: true });
  emit({ name: 'PostToolUse', toolId: 'background', backgroundRequested: true });
  emit({ name: 'Stop' });
  assert.equal(a.snapshot(100000).uncertain, true); assert.equal(a.snapshot(100000).ready, false);
  emit({ name: 'Stop', backgroundCount: 0, scheduledCount: 0 });
  assert.equal(a.snapshot(100000).ready, true);
});

test('approval requires a main native completed plan tool, never a request, rejection, failure or subagent', () => {
  for (const provider of ['claude', 'gemini']) {
    const a = new SessionActivity(provider), tool = provider === 'claude' ? 'ExitPlanMode' : 'exit_plan_mode';
    const start = provider === 'claude' ? 'PreToolUse' : 'BeforeTool', end = provider === 'claude' ? 'PostToolUse' : 'AfterTool';
    a.observe({ name: start, tool, toolId: 'request' }, 1);
    a.observe({ name: 'PermissionRequest', tool }, 2); assert.equal(a.snapshot().planApproval, undefined);
    a.observe({ name: provider === 'claude' ? 'PostToolUseFailure' : end, tool, toolId: 'request', planApproved: false }, 3);
    assert.equal(a.snapshot().planApproval, undefined);
    a.observe({ name: end, tool, agentId: 'child', planApproved: true }, 4); assert.equal(a.snapshot().planApproval, undefined);
    a.observe({ name: end, tool, toolId: 'approved', planApproved: true }, 5);
    assert.deepEqual(a.snapshot().planApproval, { provider, at: 5, toolId: 'approved', source: end });
    a.observe({ name: end, tool, toolId: 'approved', planApproved: true }, 6);
    assert.equal(a.snapshot().planApproval.at, 5);
  }
});

test('provider coverage is explicit and unmatched or bounded activity cannot manufacture readiness', () => {
  const codex = new SessionActivity('codex');
  codex.observe({ name: 'agent-turn-complete', message: '{"title":"Synthetic title"}' }, 1);
  assert.equal(codex.snapshot(100000).ready, false);
  codex.observe({ name: 'agent-turn-complete', message: 'Actual reply' }, 2);
  assert.equal(codex.snapshot(100000).coverage, 'turns-only'); assert.equal(codex.snapshot(100000).ready, true);
  const gemini = new SessionActivity('gemini');
  gemini.observe({ name: 'BeforeTool', tool: 'read_file' }, 1);
  gemini.observe({ name: 'BeforeTool', tool: 'read_file' }, 2);
  gemini.observe({ name: 'AfterTool', tool: 'read_file' }, 3);
  gemini.observe({ name: 'AfterAgent' }, 4);
  assert.equal(gemini.snapshot(100000).tools, 1); assert.equal(gemini.snapshot(100000).ready, false);
  gemini.observe({ name: 'AfterTool', tool: 'read_file' }, 5); assert.equal(gemini.snapshot(100000).ready, true);
  const a = new SessionActivity('claude');
  a.observe({ name: 'PostToolUse', toolId: 'already-done' }, 1);
  a.observe({ name: 'PreToolUse', toolId: 'already-done' }, 2); assert.equal(a.snapshot().tools, 0);
  a.observe({ name: 'SubagentStart' }, 3); a.observe({ name: 'Stop' }, 4);
  assert.equal(a.snapshot(100000).uncertain, true); assert.equal(a.snapshot(100000).ready, false);
  const overflow = new SessionActivity('claude');
  for (let n = 0; n < 4100; n++) overflow.observe({ name: 'PreToolUse', toolId: `tool-${n}` }, n);
  overflow.observe({ name: 'Stop' }, 5000);
  assert.equal(overflow.snapshot(100000).ready, false); assert.equal(overflow.snapshot(100000).uncertain, true);
});

test('hook bridge keeps bounded activity metadata but excludes tool inputs, results, background commands and cron prompts', async t => {
  const dir = await temp(t), events = join(dir, 'events.jsonl');
  const emit = (provider, payload) => { const result = spawnSync(process.execPath, [HOOK_SCRIPT, events, provider], { input: JSON.stringify(payload) }); assert.equal(result.status, 0); assert.equal(result.stdout.length, 0); };
  emit('claude', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'tool-1', agent_id: 'child',
    tool_input: { run_in_background: true, command: 'PRIVATE COMMAND' }, tool_response: { content: 'PRIVATE RESULT' },
    background_tasks: [{ command: 'PRIVATE BACKGROUND' }], session_crons: [{ prompt: 'PRIVATE CRON' }] });
  for (const display of ['Cancelled', 'Error: Invalid plan', 'Feedback: PRIVATE FEEDBACK', 'Rejected (no feedback)', 'Plan approved: /PRIVATE/PATH']) {
    emit('gemini', { hook_event_name: 'AfterTool', tool_name: 'exit_plan_mode', tool_response: { returnDisplay: display, llmContent: 'PRIVATE RESULT' } });
  }
  emit('gemini', { hook_event_name: 'AfterTool', tool_name: 'exit_plan_mode', tool_response: { returnDisplay: 'Plan approved: /PRIVATE/PATH', error: { message: 'PRIVATE ERROR' } } });
  const text = await readFile(events, 'utf8'), lines = text.trim().split('\n').map(JSON.parse);
  assert.doesNotMatch(text, /PRIVATE/);
  assert.deepEqual([lines[0].toolId, lines[0].agentId, lines[0].backgroundRequested, lines[0].backgroundCount, lines[0].scheduledCount], ['tool-1', 'child', true, 1, 1]);
  assert.deepEqual(lines.slice(1).map(event => event.planApproved), [false, false, false, false, true, false]);
  emit('claude', { hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', tool_use_id: 'x'.repeat(300), agent_id: 'y'.repeat(300) });
  const malformed = JSON.parse((await readFile(events, 'utf8')).trim().split('\n').at(-1));
  assert.equal(malformed.toolId, undefined); assert.equal(malformed.agentId, undefined);
  assert.equal(malformed.subordinate, true); assert.equal(malformed.activityUncertain, true);
  const activity = new SessionActivity('claude'); activity.observe(malformed, 1);
  activity.observe({ name: 'Stop' }, 2);
  assert.equal(activity.snapshot(100000).planApproval, undefined); assert.equal(activity.snapshot(100000).ready, false);
});

test('extra observation hooks are pipeline-only; provider permissions and ambient user settings stay intact', async t => {
  const runDir = await temp(t);
  for (const pipeline of [false, true]) {
    for (const provider of ['claude', 'gemini']) {
      const built = await buildSession({ provider, stage: 'executing', config: resolveConfig('executing', { provider, pipeline }),
        message: 'Task', runDir, eventsFile: join(runDir, 'events'), sessionId: 'session' });
      const settings = provider === 'claude' ? JSON.parse(built.args[built.args.indexOf('--settings') + 1]) : JSON.parse(await readFile(built.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, 'utf8'));
      assert.equal(Boolean(settings.hooks[provider === 'claude' ? 'PreToolUse' : 'BeforeTool']), pipeline);
      assert.equal(Boolean(settings.hooks[provider === 'claude' ? 'SubagentStop' : 'AfterTool']), pipeline);
      assert.equal(built.args.includes('--dangerously-skip-permissions'), false);
    }
  }
});
