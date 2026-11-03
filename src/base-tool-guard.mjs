#!/usr/bin/env node
/** Deny-only MCP hook. Never approves a tool, changes its arguments, or records payload content. */
import { readFileSync, readSync } from 'node:fs';

export function supportsClaudeMcpPolicy(version) {
  const match = String(version).match(/\b(\d+)\.(\d+)\.(\d+)(?![\d-])/);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2 || major === 2 && (minor > 1 || minor === 1 && patch >= 295);
}

export function mcpToolAllowed(tool, policy, provider) {
  if (typeof tool !== 'string' || !policy || !['claude', 'gemini'].includes(provider)) return false;
  const prefix = provider === 'claude' ? 'mcp__' : 'mcp_';
  if (!tool.startsWith(prefix)) return true;
  for (const server of policy.servers || []) {
    const start = `${prefix}${server.name}${provider === 'claude' ? '__' : '_'}`;
    if (!tool.startsWith(start)) continue;
    if (server.allowedTools === undefined) return true;
    const normalize = name => provider === 'claude' ? name.replace(/[^A-Za-z0-9_-]/g, '_') : name.replace(/[^A-Za-z0-9_.:-]/g, '_');
    return server.allowedTools.some(name => `${start}${normalize(name)}` === tool);
  }
  return policy.mode !== 'base-only';
}

if (process.argv[1]?.endsWith('/base-tool-guard.mjs') || process.argv[1]?.endsWith('\\base-tool-guard.mjs')) {
  const [path, provider] = process.argv.slice(2); let allowed = false;
  try {
    const chunks = []; let size = 0; const chunk = Buffer.alloc(16384);
    for (;;) { const bytes = readSync(0, chunk, 0, chunk.length, null); if (!bytes) break; size += bytes; if (size > 1000000) throw new Error('Payload too large'); chunks.push(Buffer.from(chunk.subarray(0, bytes))); }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')), policy = JSON.parse(readFileSync(path, 'utf8'));
    allowed = mcpToolAllowed(payload.tool_name, policy, provider);
  } catch {}
  if (!allowed) {
    const reason = 'This MCP tool is outside the Base agent’s selected tool policy.';
    process.stderr.write(`${reason}\n`);
    process.stdout.write(JSON.stringify(provider === 'gemini' ? { decision: 'deny', reason } : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
    // Exit 2 is an additional fail-closed signal understood by both tool-hook runtimes.
    process.exitCode = 2;
  }
}
