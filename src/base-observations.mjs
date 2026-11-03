/** Match reported native MCP tool identities without retaining tool inputs or results. */
export function baseObservation(manifest, provider, event) {
  if (event.provider && event.provider !== provider || event.activityUncertain || !['PostToolUse', 'PostToolUseFailure', 'AfterTool'].includes(event.name) || typeof event.tool !== 'string' || event.tool.length > 400) return null;
  if (provider !== 'claude' && provider !== 'gemini') return null;
  for (const resource of manifest?.resources || []) {
    if (resource.kind !== 'mcp' || resource.status !== 'ready' || !manifest.supplied?.some(entry => entry.resourceId === resource.resourceId)) continue;
    const name = `pb_${resource.resourceId.replace(/[^A-Za-z0-9_]/g, '_')}`;
    const prefix = provider === 'claude' ? `mcp__${name}__` : `mcp_${name}_`;
    if (event.tool.startsWith(prefix) && event.tool.length > prefix.length) return { resourceId: resource.resourceId, toolName: event.tool, provider, source: event.name };
  }
  return null;
}
