/**
 * Board execution adapters (PB-02). These are separate from the restricted prompt
 * adapters in providers.mjs, which stay unchanged. Each adapter builds an argument
 * array for an interactive CLI session in the task worktree. Task text never enters
 * a shell: it is one argv element, or it is pasted into the terminal for long prompts.
 *
 * Capabilities come from the installed CLIs' documented options (see
 * docs/agentic-kanban-contract.md). Unsupported actions are refused with a reason.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { validateEffort } from './providers.mjs';

export const HOOK_SCRIPT = fileURLToPath(new URL('./agent-hook.mjs', import.meta.url));
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,99}$/;
// POSIX argv strings are limited (Linux: 128 KiB per argument). Longer prompts are pasted.
export const ARGV_PROMPT_LIMIT = 100_000;

// Only the Planning column plans. Writing stages start their own work at once, even when the task
// text asks for a plan first (Compose's "Plan first" option adds that request).
const noPlanning = ' Do not write a plan for approval, do not ask whether to proceed, and do not enter plan mode: planning happens only in the Planning column, never in this stage.';
const readOnlyPlanning = 'Plan only. Inspect the repository as needed, but do not create, edit, or delete files, and do not run commands that change anything. End with a numbered implementation plan, the files you expect to change, and how the result should be verified.';

export const STAGE_INSTRUCTIONS = Object.freeze({
  planning: `${readOnlyPlanning} Promptboard shows your final message to the user as the plan; the user must approve it before any implementation starts.`,
  code_review: `Review only. ${readOnlyPlanning.replace('Plan only. ', '').replace(' End with a numbered implementation plan, the files you expect to change, and how the result should be verified.', '')} Compare the diff below with the task requirements and acceptance criteria. Do not fix anything. End with one fenced json block: {"verdict": "no_issues" | "changes_required", "findings": [{"severity": "critical" | "high" | "medium" | "low", "file": "path", "line": 1, "explanation": "what is wrong and why"}]}.`,
  executing: 'Start implementing the task below now.' + noPlanning + ' If an approved plan is included below, follow it; if the task text asks for a plan before implementation, skip that step and implement. Work in this working directory only. It is a dedicated Git worktree on the task branch. Do not change files outside it, do not push, and do not rewrite Git history. When you finish, summarize what changed and how you verified it. The user confirms completion in Promptboard.',
  testing: 'Test the task below in this working directory only. It is a dedicated Git worktree on the task branch. Assess the execution results for this same task and run the test commands listed below (if none are listed, the project\'s usual test commands). Report failures, their causes, and missing coverage. Do not implement fixes, change production code, commit, push, merge, or rewrite Git history: fixes belong in Execute. Only Promptboard\'s independent test run (exit codes) decides whether the configured tests pass. When you finish, list the commands you ran with their results, issues found, and any files the test commands changed.' + noPlanning,
  // A column the user added. Its own instructions follow as the project stage instructions.
  custom: 'Work on the task below as the column instructions below say. Work in this working directory only. It is a dedicated Git worktree on the task branch. Do not change files outside it, do not commit, push, or rewrite Git history: Promptboard commits after the user confirms. When you finish, summarize what you did.' + noPlanning,
  merge: 'Prepare the task branch below for merging into its target branch. The merge context below says what Promptboard already did in this working directory (a dedicated Git worktree on the task branch). Resolve every listed conflict: keep both the task\'s intent and the target branch\'s changes, and remove every conflict marker. Then run the test commands listed below and fix anything the combined code breaks. Do not run git commit, git merge, git rebase, git reset, git checkout of another branch, or git push: Promptboard commits the merge after the user confirms, then merges it or opens a pull request. When you finish, list each conflicted file and how you resolved it, and the test results.' + noPlanning,
});

export const ADAPTERS = Object.freeze({
  claude: {
    name: 'Claude Code',
    capabilities: {
      planning: { supported: true, how: 'Native plan permission mode, with built-in tools limited to Read, Grep, and Glob, and no MCP servers. File changes and plan exit are not available in this session.' },
      execution: { supported: true, how: 'Permission mode acceptEdits (default) or default (ask for every change). File edits are limited to the task worktree.' },
      interactiveInput: true,
      base: { instruction: true, context: true, subagents: true, mcp: ['stdio', 'streamable-http', 'tool-reference'], isolation: 'strict per-run MCP configuration' },
      completionEvents: 'Claude Code hooks (SessionStart, UserPromptSubmit, PermissionRequest, Notification, Stop, StopFailure), passed with --settings in exec form.',
      waitingEvents: true,
      cancellation: true,
      resume: 'Session ID recorded; resume with --resume is available to later stages.',
    },
    permissionModes: ['acceptEdits', 'default'],
  },
  codex: {
    name: 'Codex CLI',
    capabilities: {
      planning: { supported: true, how: 'read-only sandbox with approval policy never, so the session cannot write files or ask to escalate. Codex has no plan-mode flag; the boundary is the sandbox.' },
      execution: { supported: true, how: 'workspace-write sandbox rooted at the task worktree, approval policy on-request.' },
      interactiveInput: true,
      base: { instruction: true, context: true, mcp: ['stdio', 'streamable-http', 'tool-reference'], isolation: 'Base-managed servers supplement ambient Codex configuration' },
      completionEvents: 'Codex notify program (agent-turn-complete with the last assistant message).',
      waitingEvents: false, // notify reports finished turns only; approval prompts are visible in the terminal.
      cancellation: true,
      resume: 'Thread ID recorded from notify events.',
    },
    permissionModes: ['workspace-write'],
  },
  gemini: {
    name: 'Gemini CLI',
    // Covered by simulated tests only: a live sign-in was refused by the provider (docs/live-verification.md).
    notLiveVerified: true,
    capabilities: {
      planning: { supported: true, how: 'Native plan approval mode (experimental in Gemini CLI 0.30; enabled for the planning session only) plus a Promptboard policy that denies file-writing tools, shell commands, plan exit, and MCP tools, so the session cannot start implementation.' },
      execution: { supported: true, how: 'Approval mode auto_edit (default) or default (ask for every tool).' },
      interactiveInput: true,
      base: { instruction: true, context: true, mcp: ['stdio', 'streamable-http', 'tool-reference'], isolation: 'per-run MCP server allowlist; administrator settings preserved' },
      completionEvents: 'Gemini CLI hooks (SessionStart, BeforeAgent, AfterAgent, Notification) from a merged system settings file.',
      waitingEvents: true,
      cancellation: true,
      resume: 'Session ID recorded.',
    },
    permissionModes: ['auto_edit', 'default'],
  },
  agy: {
    name: 'Antigravity CLI',
    capabilities: {
      planning: { supported: false, how: 'Not enabled: no verified way to enforce a read-only planning session or to receive lifecycle events from an interactive agy session.' },
      execution: { supported: false, how: 'Not enabled until its interactive lifecycle events are verified. agy remains available for prompt generation.' },
      interactiveInput: false, completionEvents: 'Not verified.', waitingEvents: false, cancellation: false, resume: 'Not verified.',
    },
    permissionModes: [],
  },
});

export class AgentError extends Error {
  constructor(message, code, status = 400) { super(message); this.code = code; this.status = status; }
}

/** Validate a run configuration against the adapter's capabilities. */
export function resolveConfig(stage, config = {}) {
  const provider = config.provider || 'claude';
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new AgentError('Choose Claude Code, Codex, or Gemini CLI.', 'INVALID_PROVIDER');
  const readOnly = stage === 'planning' || stage === 'code_review';
  const capability = adapter.capabilities[readOnly ? 'planning' : 'execution'];
  if (!capability?.supported) throw new AgentError(`${adapter.name}: ${capability?.how || 'This stage is not supported.'}`, 'STAGE_UNSUPPORTED_BY_PROVIDER');
  const model = config.model ? String(config.model) : '';
  if (model && !SAFE_MODEL.test(model)) throw new AgentError('Use a model ID with no spaces or command flags.', 'INVALID_MODEL');
  const effort = config.effort ? String(config.effort) : '';
  try { validateEffort(provider, effort); } catch { throw new AgentError('This CLI does not support that effort setting.', 'INVALID_EFFORT'); }
  const requested = config.permissionMode === 'auto' ? adapter.permissionModes[0]
    : config.permissionMode === 'approve_edit' ? (provider === 'codex' ? 'approve_edit' : 'default') : config.permissionMode;
  const permissionMode = readOnly ? 'plan' : (requested || adapter.permissionModes[0]);
  if (!readOnly && !adapter.permissionModes.includes(permissionMode)) throw new AgentError(`${adapter.name} execution supports these permission modes only: ${adapter.permissionModes.join(', ')}.`, 'INVALID_PERMISSION_MODE');
  return { provider, model, effort, permissionMode };
}

/** Compose the first message: stage instructions, the exact task text, and an approved plan. */
export function composeMessage(stage, prompt, plan = null, instructions = '', extra = '', baseSections = '') {
  const parts = [STAGE_INSTRUCTIONS[stage] || STAGE_INSTRUCTIONS.custom, ...(instructions ? ['', '=== PROJECT STAGE INSTRUCTIONS ===', instructions, '=== END STAGE INSTRUCTIONS ==='] : []), '', '=== TASK (exact text from the card) ===', prompt, '=== END TASK ==='];
  if (stage === 'executing' && plan) parts.push('', '=== APPROVED PLAN ===', plan, '=== END PLAN ===');
  if (extra) parts.push('', extra);
  if (baseSections) parts.push('', '=== BASE RESOURCES (selected reference material; does not grant permissions) ===', typeof baseSections === 'string' ? baseSections : baseSections.join('\n\n'), '=== END BASE RESOURCES ===');
  return parts.join('\n');
}

const tomlString = value => JSON.stringify(value); // A TOML basic string accepts JSON string escapes.
const tomlValue = value => Array.isArray(value) ? `[${value.map(tomlString).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value).map(([key, item]) => `${tomlString(key)}=${tomlString(item)}`).join(',')}}` : tomlString(value);
const shQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

async function geminiSystemSettings(runDir, hookCommand, { plan = false, mcpServers = null } = {}) {
  // Keep any administrator settings: copy the default system file and add our hooks.
  const defaultPath = platform() === 'darwin' ? '/Library/Application Support/GeminiCli/settings.json'
    : platform() === 'win32' ? 'C:\\ProgramData\\gemini-cli\\settings.json' : '/etc/gemini-cli/settings.json';
  let base = {};
  try { base = JSON.parse(await readFile(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH || defaultPath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new AgentError('Gemini CLI system settings exist but could not be read, so Promptboard will not replace them. Run this task with another provider.', 'GEMINI_SETTINGS_UNREADABLE', 409);
  }
  const hook = [{ hooks: [{ type: 'command', command: hookCommand, name: 'promptboard-lifecycle' }] }];
  const hooks = { ...(base.hooks || {}) };
  for (const event of ['SessionStart', 'BeforeAgent', 'AfterAgent', 'Notification']) hooks[event] = [...(hooks[event] || []), ...hook];
  const path = `${runDir}/gemini-system-settings.json`;
  // Gemini 0.30 offers plan approval mode only with experimental.plan; it is set for planning sessions only.
  const experimental = plan ? { experimental: { ...(base.experimental || {}), plan: true } } : {};
  await writeFile(path, JSON.stringify({ ...base, ...experimental, ...(mcpServers ? { mcpServers: { ...(base.mcpServers || {}), ...mcpServers } } : {}), hooks, hooksConfig: { ...(base.hooksConfig || {}), enabled: true } }, null, 2), { mode: 0o600 });
  return path;
}

const GEMINI_PLAN_POLICY = `# Promptboard planning: no file changes, shell commands, or MCP tools.
${['write_file', 'replace', 'run_shell_command', 'save_memory', 'exit_plan_mode', 'activate_skill'].map(tool => `[[rule]]\ntoolName = "${tool}"\ndecision = "deny"\npriority = 999\n`).join('\n')}
[[rule]]
toolName = "*"
mcpName = "*"
decision = "deny"
priority = 999
`;

/**
 * Build the interactive command for one run. Returns { args, env, paste } where
 * `paste` is the message to type into the terminal when it is too long for argv.
 */
export async function buildSession({ provider, stage, config, message, runDir, eventsFile, sessionId, nodePath = process.execPath, baseDelivery = null }) {
  const readOnly = stage === 'planning' || stage === 'code_review';
  const inArgv = Buffer.byteLength(message) <= ARGV_PROMPT_LIMIT;
  const env = { TERM: 'xterm-256color', PROMPTBOARD_RUN: '1' };
  const selected = readOnly ? [] : baseDelivery?.mcpServers || [];
  const jsonServers = Object.fromEntries(selected.map(server => {
    const cfg = server.configuration;
    const ref = value => '${' + value + '}';
    const item = cfg.transport === 'stdio'
      ? { command: cfg.command, args: cfg.args || [], env: Object.fromEntries(Object.entries(cfg.env || {}).map(([key, value]) => [key, ref(value)])) }
      : { ...(provider === 'gemini' ? { httpUrl: cfg.endpoint } : { type: 'http', url: cfg.endpoint }), headers: Object.fromEntries(Object.entries(cfg.headers || {}).map(([key, value]) => [key, ref(value)])) };
    if (provider === 'gemini') { item.trust = false; item.timeout = 15000; }
    return [server.name, item];
  }));
  let args;
  if (provider === 'claude') {
    const hook = { type: 'command', command: nodePath, args: [HOOK_SCRIPT, eventsFile, 'claude'] };
    const hooks = Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'].map(event => [event, [{ hooks: [hook] }]]));
    let mcpConfig = '{"mcpServers":{}}';
    if (selected.length) { mcpConfig = `${runDir}/base-claude-mcp.json`; await writeFile(mcpConfig, JSON.stringify({ mcpServers: jsonServers }), { mode: 0o600 }); }
    args = ['--session-id', sessionId, '--settings', JSON.stringify({ hooks, statusLine: { type: 'command', command: [nodePath, fileURLToPath(new URL('./usage-status.mjs', import.meta.url)), `${runDir}/usage-status.json`].map(shQuote).join(' ') } }), '--strict-mcp-config', '--mcp-config', mcpConfig];
    if (readOnly) args.push('--permission-mode', 'plan', '--tools', 'Read,Grep,Glob', '--disallowedTools', 'Edit,Write,NotebookEdit,Bash,ExitPlanMode');
    else args.push('--permission-mode', config.permissionMode, '--disallowedTools', 'EnterPlanMode,ExitPlanMode'); // Writing stages never switch to plan mode.
    if (!readOnly && baseDelivery?.subagents && Object.keys(baseDelivery.subagents).length) {
      const agents = JSON.stringify(baseDelivery.subagents);
      if (Buffer.byteLength(agents) > 60000) throw new AgentError('Native subagent definitions exceed the per-run limit.', 'BASE_SUBAGENT_LIMIT');
      args.push('--agents', agents);
    }
    if (config.model) args.push('--model', config.model);
    if (config.effort) { args.push('--effort', config.effort); env.CLAUDE_CODE_EFFORT_LEVEL = config.effort; }
    if (inArgv) args.push(message);
  } else if (provider === 'codex') {
    args = ['-c', `notify=[${[nodePath, HOOK_SCRIPT, eventsFile, 'codex'].map(tomlString).join(',')}]`, '--no-alt-screen'];
    if (readOnly) args.push('--sandbox', 'read-only', '--ask-for-approval', 'never');
    else args.push('--sandbox', 'workspace-write', '--ask-for-approval', 'on-request');
    if (config.model) args.push('--model', config.model);
    if (config.effort) args.push('-c', `model_reasoning_effort=${tomlString(config.effort)}`);
    for (const server of selected) {
      const cfg = server.configuration, prefix = `mcp_servers.${server.name}`;
      const fields = cfg.transport === 'stdio' ? { command: cfg.command, args: cfg.args || [], env_vars: Object.keys(cfg.env || {}) } : { url: cfg.endpoint, env_http_headers: cfg.headers || {} };
      // env_vars forwards names without secrets in argv or changes to the CLI environment.
      if (Object.entries(cfg.env || {}).some(([key, value]) => key !== value)) throw new AgentError('Codex MCP environment aliases are unsupported; use matching variable names.', 'BASE_MCP_ENV_ALIAS', 409);
      for (const [key, value] of Object.entries(fields)) args.push('-c', `${prefix}.${key}=${tomlValue(value)}`);
      args.push('-c', `${prefix}.required=${server.required === true}`, '-c', `${prefix}.startup_timeout_sec=15`);
    }
    if (inArgv) args.push(message);
  } else if (provider === 'gemini') {
    env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = await geminiSystemSettings(runDir, [nodePath, HOOK_SCRIPT, eventsFile, 'gemini'].map(shQuote).join(' '), { plan: readOnly, mcpServers: selected.length ? jsonServers : null });
    args = ['--extensions', 'none', '--allowed-mcp-server-names', selected.map(server => server.name).join(',')];
    if (readOnly) {
      const policy = `${runDir}/plan-policy.toml`;
      await writeFile(policy, GEMINI_PLAN_POLICY, { mode: 0o600 });
      args.push('--approval-mode', 'plan', '--policy', policy);
    } else args.push('--approval-mode', config.permissionMode);
    if (config.model) args.push('--model', config.model);
    // Gemini expands @file references and slash commands in typed prompts. Encode them
    // as in the prompt adapter; the JSON string carries the exact text.
    const encoded = `Decode the JSON string below and follow it exactly.\n${JSON.stringify(message).replaceAll('@', '\\u0040')}`;
    if (Buffer.byteLength(encoded) <= ARGV_PROMPT_LIMIT) args.push('--prompt-interactive', encoded);
    return { args, env, paste: Buffer.byteLength(encoded) <= ARGV_PROMPT_LIMIT ? null : encoded };
  } else throw new AgentError('This provider cannot run board tasks.', 'STAGE_UNSUPPORTED_BY_PROVIDER');
  return { args, env, paste: inArgv ? null : message };
}

/**
 * Map one lifecycle event (from agent-hook.mjs) to a supervisor signal:
 * started | running | waiting | turn_complete | failed | ended | ignore.
 */
export function interpretEvent(provider, event) {
  const name = event?.name;
  if (provider === 'claude') {
    if (name === 'SessionStart') return { kind: 'started', sessionId: event.sessionId };
    if (name === 'UserPromptSubmit') return { kind: 'running' };
    if (name === 'PermissionRequest') return { kind: 'waiting', reason: `Permission requested for ${event.tool || 'a tool'}.` };
    if (name === 'Notification' && ['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog'].includes(event.notification)) return { kind: 'waiting', reason: 'The agent is waiting for your answer in the terminal.' };
    if (name === 'Stop') return { kind: 'turn_complete', message: event.message || '' };
    if (name === 'StopFailure') return { kind: 'failed', error: event.error || 'unknown' };
    if (name === 'SessionEnd') return { kind: 'ended' };
  } else if (provider === 'codex') {
    if (name === 'agent-turn-complete') {
      // Observed with Codex 0.156: a thread-title turn also reports agent-turn-complete, with a
      // message that is only {"title": ...}. It is not the agent's reply, so it is ignored.
      try { const parsed = JSON.parse(event.message); if (parsed && typeof parsed === 'object' && Object.keys(parsed).join() === 'title') return { kind: 'ignore' }; } catch {}
      return { kind: 'turn_complete', message: event.message || '', sessionId: event.sessionId };
    }
  } else if (provider === 'gemini') {
    if (name === 'SessionStart') return { kind: 'started', sessionId: event.sessionId };
    if (name === 'BeforeAgent') return { kind: 'running' };
    if (name === 'Notification' && event.notification === 'ToolPermission') return { kind: 'waiting', reason: 'The agent is waiting for tool permission in the terminal.' };
    if (name === 'AfterAgent') return { kind: 'turn_complete', message: event.message || '' };
    if (name === 'SessionEnd') return { kind: 'ended' };
  }
  return { kind: 'ignore' };
}

// Claude StopFailure error types -> Promptboard failure codes (same meanings as providers.mjs).
export const HOOK_ERRORS = Object.freeze({
  rate_limit: 'RATE_LIMITED', overloaded: 'PROVIDER_UNAVAILABLE', server_error: 'PROVIDER_UNAVAILABLE',
  authentication_failed: 'AUTH_REQUIRED', cloud_credential_error: 'AUTH_REQUIRED', oauth_org_not_allowed: 'POLICY_DENIED',
  account_on_hold: 'ACCOUNT_UNAVAILABLE', billing_error: 'ACCOUNT_UNAVAILABLE', model_not_found: 'MODEL_UNAVAILABLE',
});
