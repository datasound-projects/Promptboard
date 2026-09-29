# Live provider verification log

Real CLI runs, recorded separately from the simulated (fake-CLI) test suite. Each run used `scripts/live-agents.mjs`, which creates and deletes its own disposable repository and uses the installed, signed-in CLI. Nothing here ran against a user repository.

## 29 September 2026 — PB-02 adapters

Environment: macOS (Darwin 25.6, arm64), Node.js 24.14.1, Git 2.50.1. Installed CLIs: Claude Code 2.1.284, Codex CLI 0.156.1, Gemini CLI 0.30.0, Antigravity CLI 1.2.12.

| Provider | Stage | Result | Evidence |
| --- | --- | --- | --- |
| Claude Code (`haiku`) | Planning | Pass | Hooks `SessionStart`, `UserPromptSubmit`, `Stop` received. Plan captured. Worktree and main checkout unchanged. Process stopped on cancel. |
| Claude Code (`haiku`) | Executing | Pass | `notes.txt` changed in the task worktree only. Main checkout clean. Completion from `Stop`. |
| Claude Code (`haiku`) | Executing, permission | Pass | A `node -e` command raised `PermissionRequest`; the run showed `waiting_for_input`. |
| Codex CLI (effort `low`) | Planning | Pass after fix | `agent-turn-complete` via `notify`. First event was a thread-title turn (`{"title": ...}`); the adapter now ignores it. Worktree unchanged. |
| Codex CLI (effort `low`) | Executing | Pass | `notes.txt` changed in the worktree only. Title turn ignored; one real turn counted. |
| Gemini CLI 0.30.0 | Planning | Blocked (account) | Plan mode needs `experimental.plan` (now set for planning sessions only). `SessionStart` hook received after folder trust. Sign-in then failed: "This client is no longer supported for Gemini Code Assist for individuals." Plan/turn events were **not** verified live. |
| Antigravity CLI | — | Not run | Board execution is not enabled for agy. |

Observed startup prompts, answered in the terminal by the user (the smoke script can answer them with `--answer-trust`):

- Claude Code and Gemini CLI ask whether to trust each new worktree folder; Codex asks once per repository.
- Codex also asks to review hooks that already exist in the user's Codex configuration. The smoke script chose "Continue without trusting".
- Promptboard never pre-trusts folders or edits CLI configuration. Until the first lifecycle event arrives, the run says the CLI may be waiting for a startup answer.
