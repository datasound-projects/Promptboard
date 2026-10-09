import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_SCRIPT, buildSession, resolveConfig } from '../src/agents.mjs';
import { ACTIVITY_QUIET_MS, SessionActivity } from '../src/session-activity.mjs';

async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'pb-activity-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test('unrelated and late tool results cannot dismiss permission waits', () => {
  for (const provider of ['claude', 'gemini']) {
    const a = new SessionActivity(provider), end = provider === 'claude' ? 'PostToolUse' : 'AfterTool';
    a.observe({ name: end, toolId: 'old', tool: 'Read' }, 1);
    a.observe(provider === 'claude' ? { name: 'PermissionRequest', tool: 'Bash' }
      : { name: 'Notification', notification: 'ToolPermission' }, 2);
    for (const event of [{ name: end, toolId: 'old' }, { name: end, toolId: 'parallel' }, { name: end, agentId: 'child', toolId: 'child-tool' }]) {
      a.observe(event, 3);
      assert.equal(a.snapshot(100000).permissionPending, true);
      assert.equal(a.snapshot(100000).phase, 'waiting');
    }
    a.observe({ name: provider === 'claude' ? 'Stop' : 'AfterAgent' }, 4);
    assert.equal(a.snapshot(100000).ready, true);
  }
});

test('identified permission results resolve only their own tool and agent', () => {
  const a = new SessionActivity('claude');
  a.observe({ name: 'PermissionRequest', agentId: 'first', toolId: 'same' }, 1);
  a.observe({ name: 'PermissionRequest', agentId: 'second', toolId: 'same' }, 2);
  a.observe({ name: 'PostToolUseFailure', agentId: 'first', toolId: 'same' }, 3);
  assert.equal(a.snapshot().permissionPending, true);
  a.observe({ name: 'PermissionDenied', agentId: 'second', toolId: 'same' }, 4);
  assert.equal(a.snapshot().permissionPending, false);
  a.observe({ name: 'Stop' }, 5); assert.equal(a.snapshot(100000).ready, true);
  a.observe({ name: 'PermissionRequest', agentId: 'first', toolId: 'same' }, 6);
  assert.equal(a.snapshot(100000).ready, true); // Late request for a finished tool cannot rearm.
});

test('main lifecycle boundaries do not dismiss another agent permission dialog', () => {
  for (const name of ['Stop', 'SessionStart', 'UserPromptSubmit']) {
    const a = new SessionActivity('claude');
    a.observe({ name: 'SubagentStart', agentId: 'child' }, 1);
    a.observe({ name: 'PermissionRequest', agentId: 'child' }, 2);
    a.observe({ name }, 3);
    assert.equal(a.snapshot(100000).permissionPending, true);
    assert.equal(a.snapshot(100000).ready, false);
    a.observe({ name: 'SubagentStop', agentId: 'other' }, 4);
    assert.equal(a.snapshot().permissionPending, true);
    a.observe({ name: 'SubagentStop', agentId: 'child' }, 5);
    assert.equal(a.snapshot().permissionPending, false);
    a.observe({ name: 'Stop' }, 6); assert.equal(a.snapshot(100000).ready, true);
  }
});

test('unidentified subordinate waits and overflowing permission registries cannot establish readiness', () => {
  for (const previouslyFinished of [false, true]) {
    const unknown = new SessionActivity('claude');
    if (previouslyFinished) unknown.observe({ name: 'PostToolUse', toolId: 'same' }, 0);
    unknown.observe({ name: 'PermissionRequest', subordinate: true, toolId: 'same' }, 1);
    unknown.observe({ name: 'PostToolUse', toolId: 'same' }, 2);
    unknown.observe({ name: 'Stop' }, 3);
    assert.equal(unknown.snapshot(100000).permissionPending, true);
    assert.equal(unknown.snapshot(100000).uncertain, true);
    assert.equal(unknown.snapshot(100000).ready, false);
  }
  const overflow = new SessionActivity('claude');
  for (let n = 0; n < 4097; n++) overflow.observe({ name: 'PermissionRequest', agentId: `child-${n}` }, n);
  overflow.observe({ name: 'Stop' }, 5000);
  assert.equal(overflow.snapshot(100000).uncertain, true);
  assert.equal(overflow.snapshot(100000).ready, false);
});

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
  activity.input(3501); assert.equal(activity.snapshot(100000).ready, false);
  activity.observe({ name: 'Stop' }, 3502); assert.equal(activity.snapshot(100000).ready, true);
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
  // The parent's own calls ended with its turn; the subagent's call, background and scheduled work did not.
  assert.deepEqual([a.snapshot().tools, a.snapshot().subagents, a.snapshot().background, a.snapshot().scheduled], [1, 1, 1, 1]);
  assert.equal(a.snapshot(100000).ready, false);
  emit({ name: 'PostToolUse', toolId: 'one' }); emit({ name: 'PostToolUse', toolId: 'one' });
  emit({ name: 'PostToolUseFailure', toolId: 'two' }); // Late end events change nothing.
  assert.equal(a.snapshot().tools, 1);
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
    a.observe({ name: start, tool, toolId: 'next-request' }, 7);
    assert.equal(a.snapshot().planApproval, undefined); // A new plan request supersedes a deferred prior approval.
    a.observe({ name: end, tool, toolId: 'next-request', planApproved: true }, 8);
    assert.equal(a.snapshot().planApproval.at, 8);
    if (provider === 'gemini') {
      a.observe({ name: end, tool: 'enter_plan_mode', planEntered: false }, 9); assert.ok(a.snapshot().planApproval);
      a.observe({ name: end, tool: 'enter_plan_mode', planEntered: true }, 10); assert.equal(a.snapshot().planApproval, undefined);
    } else {
      a.observe({ name: end, tool: 'EnterPlanMode', toolId: 'enter' }, 9); assert.equal(a.snapshot().planApproval, undefined);
      a.observe({ name: end, tool, toolId: 'next-request' }, 10); assert.equal(a.snapshot().planApproval, undefined); // Late duplicate approval cannot rearm after re-entry.
      a.observe({ name: end, tool, toolId: 'new-approved' }, 11); assert.equal(a.snapshot().planApproval.at, 11);
      a.observe({ name: end, tool: 'EnterPlanMode', toolId: 'enter' }, 12); assert.equal(a.snapshot().planApproval.at, 11);
      a.observe({ name: start, tool, toolId: 'next-request' }, 13); assert.equal(a.snapshot().planApproval.at, 11); // Late duplicate starts also cannot supersede newer approval.
    }
  }
});

test('main session startup revokes prior approval and termination without accepting late old tools', () => {
  for (const provider of ['claude', 'gemini']) {
    const a = new SessionActivity(provider), tool = provider === 'claude' ? 'ExitPlanMode' : 'exit_plan_mode';
    const start = provider === 'claude' ? 'PreToolUse' : 'BeforeTool', end = provider === 'claude' ? 'PostToolUse' : 'AfterTool';
    a.observe({ name: end, tool, toolId: 'old-approved', planApproved: true }, 1);
    a.observe({ name: 'SessionEnd' }, 2);
    assert.equal(a.snapshot(100000).phase, 'ended'); assert.ok(a.snapshot().planApproval);
    for (const child of [{ agentId: 'child' }, { subordinate: true }]) {
      a.observe({ name: 'SessionStart', ...child }, 3);
      assert.equal(a.snapshot().phase, 'ended'); assert.equal(a.snapshot().planApproval.toolId, 'old-approved');
    }
    a.observe({ name: 'SessionStart' }, 4);
    assert.equal(a.snapshot(100000).phase, 'working'); assert.equal(a.snapshot(100000).ready, false);
    assert.equal(a.snapshot().parentTurnComplete, false); assert.equal(a.snapshot().planApproval, undefined);
    a.observe({ name: start, tool, toolId: 'old-approved' }, 5);
    a.observe({ name: end, tool, toolId: 'old-approved', planApproved: true }, 6);
    assert.equal(a.snapshot().planApproval, undefined); assert.equal(a.snapshot().tools, 0);
    a.observe({ name: end, tool, toolId: 'fresh-approved', planApproved: true }, 7);
    assert.equal(a.snapshot().planApproval.toolId, 'fresh-approved');
    a.observe({ name: end, tool, toolId: 'old-approved', planApproved: true }, 8);
    assert.equal(a.snapshot().planApproval.toolId, 'fresh-approved');
    a.observe({ name: 'SessionStart' }, 9); // Startup also supersedes an approval before SessionEnd.
    assert.equal(a.snapshot().planApproval, undefined); assert.equal(a.snapshot(100000).ready, false);
  }
});

test('main session startup retains outstanding work and uncertain observations until native completion evidence', () => {
  for (const provider of ['claude', 'gemini']) {
    const a = new SessionActivity(provider), start = provider === 'claude' ? 'PreToolUse' : 'BeforeTool';
    const end = provider === 'claude' ? 'PostToolUse' : 'AfterTool', complete = provider === 'claude' ? 'Stop' : 'AfterAgent';
    a.observe({ name: start, toolId: 'ongoing', tool: 'read', backgroundRequested: true }, 1);
    a.observe({ name: start, tool: 'anonymous' }, 2);
    if (provider === 'claude') a.observe({ name: 'SubagentStart', agentId: 'child' }, 3);
    a.observe({ name: complete, backgroundCount: 2, scheduledCount: 1 }, 4);
    a.observe({ name: start, toolId: 'background', backgroundRequested: true }, 5);
    const prior = a.snapshot(100000);
    a.observe({ name: 'SessionEnd' }, 6); a.observe({ name: 'SessionStart' }, 7);
    a.observe({ name: complete }, 8);
    const after = a.snapshot(100000);
    for (const key of ['tools', 'subagents', 'background', 'scheduled', 'uncertain']) assert.equal(after[key], prior[key]);
    assert.equal(after.ready, false); assert.equal(after.phase, 'working');
    a.observe({ name: end, toolId: 'ongoing' }, 9); a.observe({ name: end, tool: 'anonymous' }, 10);
    a.observe({ name: end, toolId: 'background' }, 11);
    if (provider === 'claude') a.observe({ name: 'SubagentStop', agentId: 'child' }, 12);
    assert.equal(a.snapshot(100000).ready, false);
    a.observe({ name: complete, backgroundCount: 0, scheduledCount: 0 }, 13);
    assert.equal(a.snapshot(100000).ready, true);
    a.observe({ name: complete, activityUncertain: true }, 14);
    a.observe({ name: 'SessionStart' }, 15); a.observe({ name: complete, backgroundCount: 0, scheduledCount: 0 }, 16);
    assert.equal(a.snapshot(100000).uncertain, true); assert.equal(a.snapshot(100000).ready, false);
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

test('a long session of finished tools stays certain and can become ready again', () => {
  const a = new SessionActivity('claude');
  for (let n = 0; n < 5000; n++) { a.observe({ name: 'PreToolUse', toolId: `tool-${n}` }, n); a.observe({ name: 'PostToolUse', toolId: `tool-${n}` }, n); }
  a.observe({ name: 'Stop' }, 5000);
  assert.equal(a.snapshot(100000).uncertain, false); assert.equal(a.snapshot(100000).ready, true);
  a.observe({ name: 'PreToolUse', toolId: 'tool-4999' }, 5001); // A late duplicate of a remembered finished tool.
  a.observe({ name: 'Stop' }, 5002);
  assert.equal(a.snapshot(100000).tools, 0); assert.equal(a.snapshot(100000).ready, true);
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
  for (const display of ['Cancelled', 'Switching to Plan mode', 'Switching to Plan mode: PRIVATE REASON']) {
    emit('gemini', { hook_event_name: 'AfterTool', tool_name: 'enter_plan_mode', tool_response: { returnDisplay: display, llmContent: 'PRIVATE RESULT' } });
  }
  emit('gemini', { hook_event_name: 'AfterTool', tool_name: 'enter_plan_mode', tool_response: { returnDisplay: 'Switching to Plan mode', error: { message: 'PRIVATE ERROR' } } });
  const entered = await readFile(events, 'utf8'); assert.doesNotMatch(entered, /PRIVATE/);
  assert.deepEqual(entered.trim().split('\n').slice(-4).map(line => JSON.parse(line).planEntered), [false, true, true, false]);
  emit('claude', { hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', tool_use_id: 'x'.repeat(300), agent_id: 'y'.repeat(300) });
  const malformed = JSON.parse((await readFile(events, 'utf8')).trim().split('\n').at(-1));
  assert.equal(malformed.toolId, undefined); assert.equal(malformed.agentId, undefined);
  assert.equal(malformed.subordinate, true); assert.equal(malformed.activityUncertain, true);
  const activity = new SessionActivity('claude'); activity.observe(malformed, 1);
  activity.observe({ name: 'Stop' }, 2);
  assert.equal(activity.snapshot(100000).planApproval, undefined); assert.equal(activity.snapshot(100000).ready, false);
  for (const raw of ['{broken', 'null', '[]', '{}']) {
    const result = spawnSync(process.execPath, [HOOK_SCRIPT, events, 'claude'], { input: raw });
    assert.equal(result.status, 0); assert.equal(result.stdout.length, 0);
    const event = JSON.parse((await readFile(events, 'utf8')).trim().split('\n').at(-1));
    assert.equal(event.activityUncertain, true);
    const a = new SessionActivity('claude'); a.observe(event, 1); a.observe({ name: 'Stop' }, 2);
    assert.equal(a.snapshot(100000).ready, false);
  }
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

test('a parallel tool call cancelled without an end event does not keep a finished turn working', () => {
  const a = new SessionActivity('claude');
  a.observe({ name: 'PreToolUse', toolId: 'failed', tool: 'resize' }, 1);
  a.observe({ name: 'PreToolUse', toolId: 'cancelled', tool: 'script' }, 2);
  a.observe({ name: 'PostToolUseFailure', toolId: 'failed' }, 3);
  assert.equal(a.snapshot(100000).tools, 1);
  a.observe({ name: 'Stop', backgroundCount: 0, scheduledCount: 0 }, 4);
  assert.deepEqual([a.snapshot(100000).tools, a.snapshot(100000).ready], [0, true]);
  a.observe({ name: 'PermissionRequest', toolId: 'cancelled' }, 5);
  assert.equal(a.snapshot(100000).ready, true, 'A late dialog for that call cannot rearm it.');
});

test('an unidentified dialog closes when the last call of its own tool ends, never on another tool\'s result', () => {
  const a = new SessionActivity('claude');
  a.observe({ name: 'PreToolUse', toolId: 'plan', tool: 'ExitPlanMode' }, 1);
  a.observe({ name: 'PreToolUse', toolId: 'read', tool: 'Read' }, 2);
  a.observe({ name: 'PermissionRequest', tool: 'ExitPlanMode' }, 3);
  a.observe({ name: 'Notification', notification: 'permission_prompt' }, 4); // The same dialog, reminded.
  a.observe({ name: 'PostToolUse', toolId: 'read', tool: 'Read' }, 5);
  assert.equal(a.snapshot().permissionPending, true, 'Another tool\'s result proves nothing.');
  a.observe({ name: 'PostToolUse', toolId: 'plan', tool: 'ExitPlanMode' }, 6);
  assert.deepEqual([a.snapshot().permissionPending, a.snapshot().phase], [false, 'working'], 'Approved: the agent works on.');
  // Two calls of one tool: the dialog stays until neither can still be waiting.
  a.observe({ name: 'PreToolUse', toolId: 'b1', tool: 'Bash' }, 7); a.observe({ name: 'PreToolUse', toolId: 'b2', tool: 'Bash' }, 8);
  a.observe({ name: 'PermissionRequest', tool: 'Bash' }, 9);
  a.observe({ name: 'PostToolUse', toolId: 'b1', tool: 'Bash' }, 10); assert.equal(a.snapshot().permissionPending, true);
  a.observe({ name: 'PostToolUse', toolId: 'b2', tool: 'Bash' }, 11); assert.equal(a.snapshot().permissionPending, false);
  // An unnamed dialog of its own (an MCP elicitation) waits for the turn boundary.
  a.observe({ name: 'Notification', notification: 'elicitation_dialog' }, 12);
  a.observe({ name: 'PreToolUse', toolId: 'w', tool: 'Write' }, 13); a.observe({ name: 'PermissionRequest', tool: 'Write' }, 14);
  a.observe({ name: 'PostToolUse', toolId: 'w', tool: 'Write' }, 15); assert.equal(a.snapshot().permissionPending, true);
  a.observe({ name: 'Stop' }, 16); assert.equal(a.snapshot(100000).ready, true);
});
