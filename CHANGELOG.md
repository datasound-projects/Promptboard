# Changes

## Unreleased

- Board interface (PB-03): toolbar (project, repository, target branch, workflow settings), compact cards with run badges, optimistic moves that roll back with a reason, a consent dialog, task details with the plan and run history, and per-project workflow settings (Manual, Ask on entry (default), Start on entry).
  - A resizable, collapsible terminal dock (xterm with the WebGL renderer, pinned local assets, strict CSP unchanged) with one tab per session. It reconnects after a reload and never restarts a run.
- Agent execution (PB-02): Planning and Executing run Claude Code, Codex, or Gemini CLI in an interactive terminal inside the task worktree, after your explicit confirmation.
  - Planning uses each CLI's read-only boundary. The plan is saved outside the worktree, and approving it is tied to the task text.
  - Completion comes from provider hooks or notify events, never from silence or exit codes. You confirm each stage.
  - Runs are queued (one at a time by default, up to 4), stream to the browser with the token in a header, and stop independently.
  - `npm install` is now required for agent terminals (`node-pty`). The prompt editor works without it.
  - Antigravity stays prompt-only. See `docs/live-verification.md` for which providers were checked live.
- Kanban (PB-01): seven fixed stages from To Do to Done, with validated moves. Planning is optional. To Do and Done never run agents, and the server enforces this.
  - The app now saves the board in its data folder as versioned JSON, with atomic writes, a backup copy, recovery, and revision checks. The browser board migrates once, keeping exact text and IDs.
  - Projects link to a Git repository (linked worktrees accepted; bare repositories refused) and a chosen local target branch.
  - Task runs are records separate from card position. Worktrees are created once per task, from the recorded target commit, outside your checkout.
  - Execution stays off until PB-02. See `docs/agentic-kanban-contract.md`.
- Kanban page: projects with one To do column of task cards. You can add a generated prompt as an exact snapshot, or write a card yourself.
  - Source details and review status stay with each card. An edit marks the previous checks as outdated.
  - Reorder cards with the move buttons or drag-and-drop.
  - The board is saved in the browser, and you can export or import a validated JSON backup.
  - Nothing runs from the board.
- Generation always ends in a clear state: stage and elapsed time, cancel in every stage, a bounded client and server timeout, and input kept on failure.
- Stable error codes that separate exhausted quota, temporary rate limits, sign-in, model, network, policy, and timeouts. Unknown failures stay unknown.
- No repair call after an account-level failure. A busy server returns `409 BUSY`, not `429`.
- Connection panel: install and sign-in status, native Codex sign-in, terminal handoff for other CLIs, refresh models, and confirmed sign-out.
- Clean shutdown on SIGINT, SIGTERM, and SIGHUP. Owned CLI processes and temporary folders are removed, and the port is released.
- Simpler web layout in four numbered steps: describe, choose settings, generate, review and copy. Sign-in controls and brief options move into a labelled **More settings** section.
- Optional dark mode and a collapsible history sidebar. Both are saved in the browser and applied before the first paint.
- History scrolls on its own; the editor stays in place. The top bar links the Studio and Kanban pages, and the Kanban page uses the same themes and components.
- Readable text sizes and contrast in both themes, visible focus, a skip link, a drawer on narrow screens, and reduced-motion support.

## 0.3.0 — 28 September 2026

- Reviewed mode: draft, local checks, a fresh model review, and at most one repair with a new review.
- Fast mode: one model call and local checks only.
- Exact comparisons for recognized code, quoted text, URLs, and file paths. Extended literals do not count as unchanged.
- Validated review JSON with complete source-unit coverage, fixed criteria, and real quoted evidence.
- Visible findings, review failures, and repair failures. Downloadable JSON reports with version, hashes, stages, and timings.
- Terminal output gating for flagged drafts, explicit `--allow-draft`, `--json`, `--quality`, and `--version` options.
- Bounded feedback, calls, output, and time; cancellation and fresh working folders for every stage.
- Development/holdout evaluation cases, an opt-in live evaluation command, and a local benchmark.
- Updated primary source notes and a shorter README with fresh GitHub publishing instructions.
- Persistent warning when browser history cannot be saved.
- Kept the logo, black-and-white interface, model and effort selection, three languages, and prompt history.

This release adds inspectable safeguards. It does not guarantee model correctness, full STE compliance, or better coding outcomes.
