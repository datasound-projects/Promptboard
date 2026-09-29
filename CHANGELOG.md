# Changes

## Unreleased

- Kanban: **Open folder…** in the workspace sidebar opens the system folder picker and turns the folder into a linked project (or offers Git setup when needed). A folder already used by a project selects that project. **Browse…** next to the repository path uses the same picker. Without a system picker, you type the path.

- Compose: prompt history keeps the last 500 prompts (was 40). If the browser's storage is full, the oldest prompts are dropped first and the app says how many; the newest prompt is always kept.

- Kanban: manage projects from the sidebar (⋯ menu: rename inline, link or change the repository, workflow settings, delete with inline confirmation).
- Kanban: a folder that is not a Git repository yet, has no commits, or does not exist can be set up after an explicit confirmation: create the folder, `git init`, and one empty "Initial commit". Files are never added or committed.

- Kanban: the sidebar becomes a project workspace on the Kanban page. Each project keeps its own board; switching never stops agents, and each project shows how many agents are running or waiting.

- Kanban: optional **Merge automatically** workflow setting. A card entering Merge is merged only when its accepted review and passing tests belong to exactly the current task and target commits; otherwise nothing is merged and the reason is shown. Manual stays the default.
- Kanban: collapsible project settings, a board that fills the window, wider columns, compact cards with a ⋯ menu, and easy sideways movement (trackpad swipes over cards, ‹ › buttons, a visible scrollbar, drag to pan).
- Fix: "Ask on entry" for Testing showed an undefined button and opened the agent dialog.

## 0.4.0 — 29 September 2026

The app is now **Promptboard**: prompt writing (Compose) plus a local Kanban board that runs your own coding-agent CLI. See `RELEASE-VERIFICATION.md` for what was verified and on which systems.

### Kanban board

- Seven fixed stages: To Do, Planning, Executing, Code Review, Testing, Merge, Done. To Do and Done never run agents; the server enforces the rules.
- Projects link to a local Git repository and target branch. Each task gets its own branch and worktree, created from the recorded target commit, outside your checkout.
- The board is saved by the app as versioned JSON with atomic writes, a backup copy, recovery, and revision checks. A board kept in the browser by an earlier version moves over once, with exact text and IDs.
- Per-project workflow settings for each stage: Manual, Ask on entry (default), or Start automatically.

### Agent runs

- Planning, Executing, and Code Review run Claude Code, Codex CLI, or Gemini CLI in an interactive terminal inside the task worktree. Planning and Code Review use each CLI's read-only mode. No bypass or full-access flags.
- Completion comes from provider hooks or notify events, never from silence or exit codes. You confirm each stage. Plans and reviews are saved outside the worktree.
- A resizable, collapsible terminal dock (xterm, WebGL renderer, local pinned assets, strict CSP) with one tab per session. It reconnects after a reload and never restarts a run.
- Runs are queued (one at a time by default, up to four), stream with the token in a header, and stop independently. A restart marks active runs as interrupted.
- Gemini CLI board runs are labelled "not verified live". Antigravity stays prompt-only.

### Review, testing, and merge

- Commit task changes after a diff preview. Code review findings are recorded; you accept them or send the task back to Executing.
- Your test commands run in the worktree without a shell. Only exit codes count, and results go stale when the code changes.
- Merge is a confirmed, verified, fast-forward-only local merge, never pushed. A moved target branch needs a confirmed update; conflicts are never resolved automatically.
- Done requires a merge or an explicit "Reviewed: no changes required".

### Compose and app

- Clear end states for generation: stage and elapsed time, cancel in every stage, bounded timeouts, input kept on failure.
- Stable error codes that separate exhausted quota, rate limits, sign-in, model, network, policy, and timeouts.
- Connection panel with install and sign-in status, native Codex sign-in, terminal handoff for other CLIs, and confirmed sign-out.
- Clean shutdown on SIGINT, SIGTERM, and SIGHUP: owned processes stop, temporary folders are removed, and the port is released.
- Simpler layout with numbered steps, a collapsible settings step, optional dark mode, a collapsible history sidebar, and better contrast, focus, and narrow-screen support.

### Fixes found during release verification

- Early terminal output from a fast CLI could be lost. Listeners now attach before any other work.

### Project

- Rewritten README, SECURITY, and CONTRIBUTING; third-party notices; issue templates; Dependabot; CI on Linux, macOS, and Windows with Node.js 22 and 24, pinned actions, a dependency audit, and a tag-driven release workflow. The package is marked private and is not published to npm.

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
