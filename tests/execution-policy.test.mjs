import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSession, resolveConfig } from '../src/agents.mjs';

const dir = async t => { const runDir = await mkdtemp(join(tmpdir(), 'pb-policy-')); t.after(() => rm(runDir, { recursive: true, force: true })); return runDir; };
const build = (runDir, provider, stage, policy, extra = {}) => buildSession({ provider, stage, config: resolveConfig(stage, { provider, pipeline: true, stageEngine: true, ...policy, ...extra }),
  message: 'Do the task.', runDir, eventsFile: join(runDir, 'events.jsonl'), sessionId: 'sid' });
const after = (args, flag) => args[args.indexOf(flag) + 1];

test('generic execution policies translate to each CLI’s own permission mode, and only through the policy', () => {
  const table = { claude: ['acceptEdits', 'auto', 'acceptEdits', 'bypassPermissions'], codex: ['workspace-write', 'workspace-write', 'danger-full-access', 'danger-full-access'], gemini: ['auto_edit', 'yolo', 'auto_edit', 'yolo'] };
  for (const [provider, modes] of Object.entries(table)) {
    const got = [['ask', 'workspace_write'], ['autonomous', 'workspace_write'], ['ask', 'full'], ['autonomous', 'full']].map(([interaction, filesystem]) => resolveConfig('executing', { provider, pipeline: true, interaction, filesystem }));
    assert.deepEqual(got.map(config => config.permissionMode), modes, provider);
    assert.deepEqual(got.map(config => [config.interaction, config.filesystem]), [['ask', 'workspace_write'], ['autonomous', 'workspace_write'], ['ask', 'full'], ['autonomous', 'full']]);
    assert.equal(resolveConfig('executing', { provider, pipeline: true, interaction: 'autonomous', filesystem: 'read_only' }).permissionMode, 'plan', 'Read-only wins over autonomy.');
  }
  // Without a policy the raw permission modes stay as narrow as before: no bypass through a column's saved mode.
  assert.throws(() => resolveConfig('executing', { provider: 'claude', pipeline: true, permissionMode: 'bypassPermissions' }), { code: 'INVALID_PERMISSION_MODE' });
  assert.throws(() => resolveConfig('executing', { provider: 'gemini', permissionMode: 'yolo' }), { code: 'INVALID_PERMISSION_MODE' });
  assert.throws(() => resolveConfig('executing', { provider: 'codex', pipeline: true, interaction: 'reckless', filesystem: 'workspace_write' }), { code: 'INVALID_EXECUTION_POLICY' });
  assert.throws(() => resolveConfig('executing', { provider: 'agy', pipeline: true, interaction: 'ask', filesystem: 'workspace_write' }), { code: 'STAGE_UNSUPPORTED_BY_PROVIDER' });
});

test('stage-engine sessions: read-only columns never ask, autonomous writing columns never pause, ask keeps prompts', async t => {
  const runDir = await dir(t);
  // Codex: Planning/Review read-only with no approval prompt; writing columns ask unless autonomous.
  let args = (await build(runDir, 'codex', 'planning', { interaction: 'ask', filesystem: 'read_only' })).args;
  assert.deepEqual([after(args, '--sandbox'), after(args, '--ask-for-approval')], ['read-only', 'never']);
  args = (await build(runDir, 'codex', 'executing', { interaction: 'ask', filesystem: 'workspace_write' })).args;
  assert.deepEqual([after(args, '--sandbox'), after(args, '--ask-for-approval')], ['workspace-write', 'on-request']);
  args = (await build(runDir, 'codex', 'executing', { interaction: 'autonomous', filesystem: 'workspace_write' })).args;
  assert.deepEqual([after(args, '--sandbox'), after(args, '--ask-for-approval')], ['workspace-write', 'never']);
  args = (await build(runDir, 'codex', 'executing', { interaction: 'autonomous', filesystem: 'full' })).args;
  assert.deepEqual([after(args, '--sandbox'), after(args, '--ask-for-approval')], ['danger-full-access', 'never']);
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
  // Claude: typed Planning/Review use strict plan mode with read tools only; writing columns use the mapped mode.
  args = (await build(runDir, 'claude', 'code_review', { interaction: 'autonomous', filesystem: 'read_only' })).args;
  assert.equal(after(args, '--permission-mode'), 'plan'); assert.equal(after(args, '--tools'), 'Read,Grep,Glob');
  assert.match(after(args, '--disallowedTools'), /ExitPlanMode/);
  args = (await build(runDir, 'claude', 'executing', { interaction: 'autonomous', filesystem: 'workspace_write' })).args;
  assert.equal(after(args, '--permission-mode'), 'auto'); assert.equal(after(args, '--disallowedTools'), 'EnterPlanMode,ExitPlanMode', 'Writing stages never enter plan mode.');
  args = (await build(runDir, 'claude', 'executing', { interaction: 'ask', filesystem: 'workspace_write' })).args;
  assert.equal(after(args, '--permission-mode'), 'acceptEdits');
  // Gemini: autonomous workspace writes run yolo inside Gemini's own sandbox; full access drops the sandbox; ask keeps prompts.
  args = (await build(runDir, 'gemini', 'executing', { interaction: 'autonomous', filesystem: 'workspace_write' })).args;
  assert.equal(after(args, '--approval-mode'), 'yolo'); assert.ok(args.includes('--sandbox'));
  args = (await build(runDir, 'gemini', 'executing', { interaction: 'autonomous', filesystem: 'full' })).args;
  assert.equal(after(args, '--approval-mode'), 'yolo'); assert.ok(!args.includes('--sandbox'));
  args = (await build(runDir, 'gemini', 'executing', { interaction: 'ask', filesystem: 'workspace_write' })).args;
  assert.equal(after(args, '--approval-mode'), 'auto_edit'); assert.ok(!args.includes('--sandbox'));
  args = (await build(runDir, 'gemini', 'planning', { interaction: 'autonomous', filesystem: 'read_only' })).args;
  assert.equal(after(args, '--approval-mode'), 'plan');
});

test('custom pipeline columns without a policy keep their saved permission flags', async t => {
  const runDir = await dir(t);
  const session = await buildSession({ provider: 'codex', stage: 'planning', config: resolveConfig('planning', { provider: 'codex', pipeline: true, permissionMode: 'plan' }), message: 'x', runDir, eventsFile: join(runDir, 'e'), sessionId: 's' });
  assert.deepEqual([after(session.args, '--sandbox'), after(session.args, '--ask-for-approval')], ['read-only', 'on-request'], 'Unchanged for boards nobody reconfigured.');
  const claude = await buildSession({ provider: 'claude', stage: 'executing', config: resolveConfig('executing', { provider: 'claude', pipeline: true }), message: 'x', runDir, eventsFile: join(runDir, 'e'), sessionId: 's' });
  assert.ok(!claude.args.includes('--disallowedTools'), 'Custom columns may still use native plan mode.');
  // A typed column with no model: --disallowedTools is the last option, and the prompt must still be the prompt.
  const typed = await buildSession({ provider: 'claude', stage: 'executing', config: resolveConfig('executing', { provider: 'claude', pipeline: true, stageEngine: true, interaction: 'ask', filesystem: 'workspace_write' }), message: '=== TASK STATE ===\nbranch: x', runDir, eventsFile: join(runDir, 'e'), sessionId: 's' });
  assert.deepEqual(typed.args.slice(-4), ['--disallowedTools', 'EnterPlanMode,ExitPlanMode', '--', '=== TASK STATE ===\nbranch: x']);
});
