#!/usr/bin/env node
/**
 * Lifecycle bridge. Provider CLIs run this as a hook (Claude Code, Gemini CLI: JSON on
 * stdin) or as a notify program (Codex: JSON as the last argument). It appends one
 * JSON line to the run's event file and prints nothing, so it never changes the
 * agent's decisions. Usage: agent-hook.mjs <eventsFile> <provider> [codexPayload]
 */
import { appendFileSync, readFileSync } from 'node:fs';

const [eventsFile, provider, argPayload] = process.argv.slice(2);
const pick = value => (typeof value === 'string' ? value.slice(0, 200_000) : undefined);
const metadata = value => (typeof value === 'string' && value.length <= 256 ? value : undefined);

try {
  if (eventsFile && ['claude', 'codex', 'gemini'].includes(provider)) {
    let data = {}, malformed = false;
    try {
      data = JSON.parse(argPayload ?? (readFileSync(0, 'utf8') || '{}'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) { data = {}; malformed = true; }
    } catch { malformed = true; }
    // Keep lifecycle fields only. Raw payloads can contain tool input and file content.
    const event = {
      at: Date.now(), provider,
      name: pick(data.hook_event_name) || pick(data.type) || 'unknown',
      sessionId: pick(data.session_id) || pick(data['thread-id']),
      notification: pick(data.notification_type) || pick(data.notificationType),
      tool: pick(data.tool_name),
      toolId: metadata(data.tool_use_id),
      agentId: metadata(data.agent_id),
      subordinate: data.agent_id != null && data.agent_id !== '' || undefined,
      activityUncertain: malformed || !(pick(data.hook_event_name) || pick(data.type)) || [data.tool_use_id, data.agent_id].some(value => value != null && metadata(value) === undefined) || undefined,
      backgroundRequested: data.tool_input?.run_in_background === true || undefined,
      // Keep counts, never commands, scheduled prompts or tool results.
      backgroundCount: Array.isArray(data.background_tasks) ? data.background_tasks.length : undefined,
      scheduledCount: Array.isArray(data.session_crons) ? data.session_crons.length : undefined,
      planApproved: provider === 'gemini' && data.hook_event_name === 'AfterTool' && data.tool_name === 'exit_plan_mode'
        ? !data.tool_response?.error && typeof data.tool_response?.returnDisplay === 'string' && data.tool_response.returnDisplay.startsWith('Plan approved: ') : undefined,
      error: pick(data.error),
      transcriptPath: pick(data.transcript_path),
      message: pick(data.last_assistant_message) || pick(data['last-assistant-message']) || pick(data.prompt_response),
    };
    appendFileSync(eventsFile, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }
} catch {}
process.exit(0);
