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

try {
  if (eventsFile && ['claude', 'codex', 'gemini'].includes(provider)) {
    let data = {};
    try { data = JSON.parse(argPayload ?? (readFileSync(0, 'utf8') || '{}')); } catch {}
    // Keep lifecycle fields only. Raw payloads can contain tool input and file content.
    const event = {
      at: Date.now(), provider,
      name: pick(data.hook_event_name) || pick(data.type) || 'unknown',
      sessionId: pick(data.session_id) || pick(data['thread-id']),
      notification: pick(data.notification_type) || pick(data.notificationType),
      tool: pick(data.tool_name),
      error: pick(data.error),
      message: pick(data.last_assistant_message) || pick(data['last-assistant-message']) || pick(data.prompt_response),
    };
    appendFileSync(eventsFile, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }
} catch {}
process.exit(0);
