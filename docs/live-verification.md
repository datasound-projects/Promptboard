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

## 29 September 2026 — PB-05 complete flow

Same environment. `scripts/live-flow.mjs` drives one task through every stage with the real CLI, in a disposable repository it deletes afterwards.

| Provider | Flow | Result | Evidence |
| --- | --- | --- | --- |
| Claude Code (`haiku`) | To Do → Executing → commit → Code Review → accept → Testing → Merge → Done | Pass | To Do refused to run (`STAGE_NOT_RUNNABLE`). Change in the worktree only. Review ran read-only, returned parseable JSON (`no_issues`), worktree unchanged. Test command exit 0. Fast-forward merge; `trunk` moved to the task commit; main checkout has the change. No agent process left. |
| Codex CLI | Same flow | Pass | Folder-trust and "hooks need review" prompts answered as a user. Review JSON parsed (`no_issues`). Merge verified. No agent process left. |
| Claude Code (`haiku`), real browser | Start from the card → consent dialog → terminal dock → trust prompt answered with key presses in xterm → Confirm stage in task details | Pass | Headless Chrome through the real UI with a disposable data folder. Output rendered by the WebGL renderer. Change in the worktree only. Run recorded as succeeded only after the confirm click. |
| Claude Code (`haiku`), hard crash | Server killed with `SIGKILL` while the agent ran | Pass | The agent process ended with its terminal. On restart the run showed `interrupted` ("The app stopped while this run was active."). Worktree and user checkout kept. |

Not verified live: Gemini CLI (sign-in refused by the provider, see above; the run dialog labels it "not verified live") and anything on Windows (CI runs the prompt-editor tests there; terminal, Git, and browser tests are skipped).
