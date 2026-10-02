# Changes

## Unreleased

- Kanban: separate columns with a minimal 4px gap while retaining subtle top accents.

- Composer: remove the introductory input placeholder and example button, including the bundled sample prompt and its event handler.

- Fix: Composer installation labels and generation availability follow the latest connection check; newly available CLIs refresh their model choices.
- Settings audit: shared live agent/model/effort controls with explicit global saves and model refresh, browser-wide card display defaults, and direct Composer/Columns access. Less-used sections collapse; stale decorative Composer copy is removed.
- Fix: repeated task submissions are locked while saving. Task Split retries only unsaved tasks after a partial failure, and newly created projects remain selected for retry. Settings/GitHub responses honor board revisions; rapid settings writes are serialized. Fix the Board tab’s accessibility target.

- Task cards: compact title/preview/action layout with a subtle glossy surface. The … menu groups editing, moving, task details, context, and column-agent configuration. Per-card display choices control previews, agent information, and spacing, saved in this browser.

- Kanban: subtle per-column top colors and a direct Agents control for each project. Use one project agent across all columns or choose individual providers/models, including custom agent columns.

- Kanban: thin scrollbars across scrolling panes, flat column separators and toolbar controls, fewer decorative borders, and instant card hover feedback.

- Kanban: add tasks directly from To Do or send drafts to Composer for refinement. Restore the enlarged left-side anime mascot beside the project heading.
- Composer: optionally edit and save generated prompts; history, Kanban, and Task Split use the saved wording, with original checks cleared.

- Fix: Stop reveals its confirmation from a collapsed dock, keeps the selected run as its target across tab switches, and displays retryable errors. Cancellation also works during startup; success waits for the owned process to exit, with the existing forced-stop fallback for an unresponsive agent. Files and logs are kept.
- Kanban: a compact project bar opens agent, file, and settings panels on demand. Cards hide prompt metadata and secondary actions until needed; terminal paths and usage sit under Run details. The board fits around the resized terminal, toolbar actions wrap on narrow screens, and background refreshes preserve column scroll positions, open card controls, and per-run details.

- Kanban: project provider, model, and effort are available directly above the board, even when Project settings is collapsed. Each agent column links to its stage settings and displays its resolved agent. Compose settings remain separate; changing settings affects future runs only.
- Kanban: repository, target branch, task branch, and worktree paths are shown with copy actions on the board, cards, task details, and terminal dock. Prompt source and the actual run agent are labelled separately.
- Fix: terminal details and connection feedback no longer overlap the CLI output. Tabs always show provider and model; model selection ignores stale discovery results and uses the selected model's reported effort options.
- Fix: ended runs can replay their saved output after a restart. When WebGL terminal graphics are unavailable, readable text output is used instead of the CSP-blocked terminal renderer.

- Kanban: **the destination column alone decides what runs.** A card can move from any column to any other; only that column's stage runs, and skipped columns never do. To Do → Executing starts implementing at once: Executing (and Testing and Merge) sessions are told not to plan or ask for plan approval, even when the card text asks for a plan first, and Claude Code cannot switch them into plan mode. Only Planning plans.
- Kanban: **Done** shows a “Drop here to complete” zone, then “Completed (N)” with compact cards (title, #number, one-line preview, how long ago) and **View all N**. Dropping a card on Done closes it without merging, pushing, or starting anything.
- Every error message is shown in orange.
- Fix: agents start on projects that have no target branch chosen yet: linking a repository records the checked-out branch.

- Kanban: **Autopilot** (optional, per project). Queue To Do cards in any order, choose a default route and per-card routes, and Autopilot takes one card at a time through them: agent stages, commits, accepted clean reviews, your tests, and a local merge or a pull request, with bounded rework and a pause (with the reason) on anything unexpected.

- Kanban: **Testing and Merge agents.** A testing agent runs your tests in the worktree, fixes failures, and can add focused tests; only Promptboard's own test run decides whether tests pass. A merge agent resolves conflicts after Promptboard starts merging the target branch into the task branch (`git merge --no-commit`); you commit the result, or abort it.
- Kanban: **Open pull request.** After you confirm, the task branch is pushed (never forced) and a GitHub pull request is opened with `gh`; a merged pull request moves the card to Done.
- Fix: files that still contain conflict markers can no longer be committed (Commit used to stage them as resolved).
- Fix: a failed branch update that was not caused by conflicts (for example a missing Git identity) no longer reports conflicts.

- Kanban: the Model field when starting an agent (and in Workflow settings) is a list of the models your CLI reports, with “CLI default” and “Custom model ID…”, instead of a free-text box.

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
