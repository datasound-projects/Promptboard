# Live provider verification log

Real CLI runs, recorded separately from the simulated (fake-CLI) test suite. Each checkpoint names its smoke script and uses an installed, signed-in CLI in its own disposable repository. Nothing here ran against a user repository.

## 4 October 2026 — private deferred native input

Source: reviewed native-message fix `0b92e9d`, subsequently merged as #64. macOS arm64, Node.js 24.14.1; Codex CLI 0.157.0 and Claude Code 2.1.287. These runs used the restored `scripts/live-native-messages.mjs` harness in disposable repositories. The harness itself is a separate review step from the transport fix.

| Provider | Check | Result | Evidence |
| --- | --- | --- | --- |
| Codex (`gpt-6-luna`, effort `low`) | Completed warmup with startup answers, fresh conversation in the same trusted worktree, Executing → Code Review, one private deferred message | Pass for private input | Fresh process had one completed turn, observed native identity and readiness, without manual input. Code Review retained the same run. Message submission, native input confirmation and durable journal confirmation were observed separately. Original task prompt retained; main checkout and worktree clean; all owned processes stopped. |
| Claude (`haiku`) | Fixed startup answer, followed by startup-only diagnostics | Startup blocked; native delivery unverified | The answered fixture exited with code 1 before a native identity or completed turn. An unanswered fixture remained at the folder-trust question. No private message was attempted. Prompt and both Git trees remained unchanged; all owned processes stopped. This result does not establish an authentication failure. |

Codex's account model catalog was queried through the existing bounded metadata adapter before the check; no inference turn was sent by discovery. Model and effort overrides affected only the disposable board. The warmup received no native message and was stopped/reset through the common To Do lifecycle before the fresh conversation. No input guard was cleared, CLI settings changed, human draft removed or unknown input retried.

The Codex result proves private message input and its saved receipt. It does not prove completion of the second reply, configured column-message scheduling, native-resume delivery, first-startup reconciliation or immediate/slash delivery. Gemini's earlier provider/client startup block remains separately documented below; it was not reverified by this checkpoint.

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

Both complete flows (Claude Code and Codex CLI) were repeated on the release code (`37f5020`, version 0.4.0) and passed again.

Not verified live: Gemini CLI (sign-in refused by the provider, see above; the run dialog labels it "not verified live") and anything on Windows (CI runs the prompt-editor tests there; terminal, Git, and browser tests are skipped).

## 29 September 2026 — Testing and Merge agents

Disposable repository; the task changed `greet.js`, which made the existing test fail, and then the target branch received a conflicting edit to the same line.

| Provider | Testing agent | Merge agent | Result |
| --- | --- | --- | --- |
| Claude Code (`haiku`) | Fixed the test, kept the task change; Promptboard's test run then passed (exit 0). | Resolved the conflict by combining both edits (`name.trim() + '!'`), no markers left; merge commit with two parents; tests passed; fast-forward possible. | Pass |
| Codex CLI | Same. | Same result. Codex staged the resolved file itself, which led to the marker check now covering every changed file, not only unmerged ones. | Pass |

Not verified live: **Open pull request** against GitHub (covered by tests with a real bare remote and a simulated `gh`), and Gemini CLI.

## 29 September 2026 — Autopilot

Disposable repository, two queued cards ("Add beta" to `notes.txt`, "Add a changelog"), route Executing → Code Review → Testing → Merge, local merge, test command checking `notes.txt`. The script only answered the CLIs' startup questions (folder trust, Codex hook review), as a user would in the terminal.

| Provider | Result | Evidence |
| --- | --- | --- |
| Claude Code (`haiku`) | Pass (about 1 minute) | Both cards went through every stage by themselves and were merged into `trunk` by fast-forward, in queue order. The second card branched from `trunk` after the first merge. Every run was recorded as started by automation. |
| Codex CLI | Pass (about 2 minutes) | Same. While Codex waited on its startup questions, Autopilot held the card and did not advance. |
