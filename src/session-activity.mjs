/** Provider observations, independent of process status. Silence is never completion. */
export const ACTIVITY_QUIET_MS = 1500;
const LIMIT = 4096;
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;

export class SessionActivity {
  constructor(provider) {
    this.provider = provider;
    this.tools = new Set(); this.finishedTools = new Set(); this.agents = new Set();
    this.anonymousTools = new Map();
    this.parentComplete = false; this.permission = false; this.ended = false;
    this.uncertain = false; this.backgroundUnknown = false;
    this.background = 0; this.scheduled = 0; this.planApproval = null;
    this.lastEventAt = 0; this.lastOutputAt = 0;
  }

  output(now = Date.now()) { this.lastOutputAt = now; }

  // The user can type before the CLI emits a new-turn hook. Invalidate the old
  // completed turn immediately, including partially entered prompt text.
  input(now = Date.now()) { this.parentComplete = false; this.lastEventAt = now; }

  observe(event, now = Date.now()) {
    if (!event || (event.provider && event.provider !== this.provider)) return;
    const name = event.name, child = id(event.agentId), subordinate = Boolean(child || event.subordinate);
    const claude = this.provider === 'claude', gemini = this.provider === 'gemini';
    const toolStart = claude ? name === 'PreToolUse' : gemini && name === 'BeforeTool';
    const toolEnd = claude ? ['PostToolUse', 'PostToolUseFailure', 'PermissionDenied'].includes(name) : gemini && name === 'AfterTool';
    const agentStart = claude && name === 'SubagentStart', agentEnd = claude && name === 'SubagentStop';
    const started = name === 'SessionStart' && !subordinate;
    const running = !subordinate && (claude ? name === 'UserPromptSubmit' : gemini && name === 'BeforeAgent');
    const waiting = (claude && (name === 'PermissionRequest' || name === 'Notification' && ['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog'].includes(event.notification)))
      || (gemini && name === 'Notification' && event.notification === 'ToolPermission');
    const complete = !subordinate && (claude ? name === 'Stop' : gemini ? name === 'AfterAgent' : name === 'agent-turn-complete');
    const ended = !subordinate && (name === 'SessionEnd' || name === 'StopFailure');
    if (event.activityUncertain) this.uncertain = true;
    if (!(started || running || waiting || complete || ended || toolStart || toolEnd || agentStart || agentEnd)) return;
    // Codex also reports synthetic thread-title turns; those are not task replies.
    if (complete && this.provider === 'codex') {
      try { const parsed = JSON.parse(event.message); if (parsed && typeof parsed === 'object' && Object.keys(parsed).join() === 'title') return; } catch {}
    }
    this.lastEventAt = now;
    // A new main lifecycle cannot carry approval or termination from the prior
    // lifecycle. Keep outstanding work and finished tool IDs: startup alone
    // neither proves readiness nor makes late old approvals fresh again.
    if (started) { this.planApproval = null; this.ended = false; }
    if (started || running) { this.parentComplete = false; this.permission = false; }
    if (waiting) { this.permission = true; this.parentComplete = false; }
    if (ended) { this.ended = true; this.parentComplete = false; }
    const toolId = id(event.toolId), key = toolId ? JSON.stringify([child, toolId]) : null;
    const repeatedToolEnd = Boolean(key && this.finishedTools.has(key));
    const toolName = id(event.tool) || 'unknown';
    if (toolStart) {
      this.parentComplete = false;
      if (!subordinate && !repeatedToolEnd && (claude && event.tool === 'ExitPlanMode' || gemini && event.tool === 'exit_plan_mode')
        && (!toolId || this.planApproval?.toolId !== toolId)) this.planApproval = null;
      if (key) {
        if (!this.finishedTools.has(key)) this.tools.add(key);
      } else {
        this.anonymousTools.set(toolName, (this.anonymousTools.get(toolName) || 0) + 1);
      }
      if (event.backgroundRequested === true) this.backgroundUnknown = true;
    }
    if (toolEnd) {
      if (key) { this.tools.delete(key); this.finishedTools.add(key); }
      else if (this.anonymousTools.get(toolName) > 0) this.anonymousTools.set(toolName, this.anonymousTools.get(toolName) - 1);
      this.permission = false;
      if (event.backgroundRequested === true && name === 'PostToolUse') this.backgroundUnknown = true;
      if (!subordinate && !repeatedToolEnd && name === 'PostToolUse' && event.tool === 'EnterPlanMode') this.planApproval = null;
      if (!subordinate && gemini && name === 'AfterTool' && event.tool === 'enter_plan_mode' && event.planEntered === true) this.planApproval = null;
      // Gemini rejection/invalid-plan results need not contain an error. The bridge
      // requires the native tool's explicit approved display, not merely AfterTool.
      const approved = !subordinate && !event.activityUncertain && ((claude && name === 'PostToolUse' && event.tool === 'ExitPlanMode')
        || (gemini && name === 'AfterTool' && event.tool === 'exit_plan_mode' && event.planApproved === true));
      if (approved && !repeatedToolEnd && !this.planApproval) this.planApproval = { provider: this.provider, at: now, toolId, source: name };
    }
    if (agentStart) { if (child) this.agents.add(child); else this.uncertain = true; }
    if (agentEnd && child) this.agents.delete(child);
    if (complete || agentEnd) {
      if (Number.isSafeInteger(event.backgroundCount) && event.backgroundCount >= 0) {
        this.background = Math.min(event.backgroundCount, LIMIT); this.backgroundUnknown = false;
      }
      if (Number.isSafeInteger(event.scheduledCount) && event.scheduledCount >= 0) this.scheduled = Math.min(event.scheduledCount, LIMIT);
    }
    if (complete) { this.parentComplete = true; this.permission = false; }
    // Never let malformed/lost hooks or unbounded counters establish a safe boundary.
    if (this.tools.size + this.finishedTools.size + this.agents.size > LIMIT || this.anonymousTools.size > LIMIT
      || [...this.anonymousTools.values()].reduce((sum, n) => sum + n, 0) > LIMIT) {
      this.uncertain = true; this.tools.clear(); this.finishedTools.clear(); this.agents.clear(); this.anonymousTools.clear();
    }
  }

  snapshot(now = Date.now()) {
    const tools = this.tools.size + [...this.anonymousTools.values()].reduce((sum, n) => sum + n, 0);
    const outstanding = tools + this.agents.size + this.background + this.scheduled;
    const idle = this.parentComplete && !this.permission && !outstanding && !this.uncertain && !this.backgroundUnknown && !this.ended;
    const ready = idle && now - Math.max(this.lastEventAt, this.lastOutputAt) >= ACTIVITY_QUIET_MS;
    return { coverage: this.provider === 'claude' ? 'tools-and-subagents' : this.provider === 'gemini' ? 'tools' : 'turns-only',
      phase: this.ended ? 'ended' : this.permission ? 'waiting' : idle ? (ready ? 'idle' : 'settling') : 'working',
      parentTurnComplete: this.parentComplete, permissionPending: this.permission,
      tools, subagents: this.agents.size, background: this.background, scheduled: this.scheduled,
      uncertain: this.uncertain || this.backgroundUnknown, ready,
      ...(this.planApproval ? { planApproval: this.planApproval } : {}) };
  }
}
