# Agentic Kanban contract

This file records the board's state model, safety rules, persistence format, and service interfaces. PB-01 built the foundation. PB-02 added agent execution for Planning and Executing (see [Agent execution](#agent-execution-pb-02)). Later stages keep these rules.

Kangentic was used as a behavior reference only. No code was copied.

## Columns

| ID | Title | Runs an agent |
| --- | --- | --- |
| `todo` | To Do | Never |
| `planning` | Planning | Yes, after explicit consent |
| `executing` | Executing | Yes, after explicit consent |
| `code_review` | Code Review | Yes, read-only review after explicit consent |
| `testing` | Testing | No agent: runs the project's approved test commands |
| `merge` | Merge | Never: a Git fast-forward, confirmed by you or by the project's "Merge automatically" setting |
| `done` | Done | Never |

The columns are fixed in `src/board.mjs` (`COLUMNS`). **The backend enforces "never"**: `requestRun` rejects `todo` and `done` with `STAGE_NOT_RUNNABLE`, whatever the UI shows.

## State model

A **task** has a position: `column`, plus its order in the project's task list. A **run** has a status. The two are separate on purpose:

- Moving a card records a transition `{at, from, to, by}` on the task. It does not create a run, and it does not show that a stage succeeded.
- Run status is one of `queued`, `running`, `waiting_for_input`, `succeeded`, `failed`, `cancelled`, or `interrupted`. Only these forward changes are accepted: queued → running, cancelled, or failed; running → waiting_for_input, succeeded, failed, or cancelled; waiting_for_input → running, cancelled, or failed.
- When a new process starts, any run still `queued`, `running`, or `waiting_for_input` becomes `interrupted`. It is never restarted.

### Stage transitions

`TRANSITIONS` in `src/board.mjs` is the only table of allowed column changes. The server enforces it, and the board view sends it to the UI, which offers only these moves (stage menu and drop targets):

| From | To |
| --- | --- |
| To Do | Planning, Executing |
| Planning | Executing, To Do |
| Executing | Code Review, To Do |
| Code Review | Testing, Executing |
| Testing | Merge, Executing |
| Merge | Done, Executing, Code Review |
| Done | none (use **Reopen**, which starts a new cycle in To Do and keeps the history) |

Every move, from drag-and-drop, the stage menu, a task-details button, or Autopilot, goes through `Board.transition`: **request → validate → prepare → execute → persist**. **The drag is the instruction**: there is no confirmation dialog. Transitions for one card are serialized, and one `transitionId` gives one outcome: a repeated request returns the first result (`duplicate: true`) and starts nothing.

- **The card enters a column only when the move succeeded.** When the destination starts an agent, the card's new column and the run record are saved in one write. A preparation failure leaves the card where it was, with the reason. If the session then fails before it begins (for example the CLI disappeared), the card returns to its previous column (`by: "system"`, with the reason). The browser shows "Moving to …" on the card in its old column until the server answers.
- **Skipped stages never run.** Only the destination's own stage action can start.
- **Drag = start.** When the card arrives, the destination's action starts at once: Planning (read-only plan), Executing (the agent in the task worktree), Code Review (read-only review of the committed diff), Testing (the project's test commands; optionally the testing agent when they fail, `agentOnFailure`), and custom agent columns. `decision: "move"` (used by Autopilot and scripts) only moves; `decision: "start"` starts even a Manual stage.
- **Hand-off.** An agent that finished its turn in the stage the card leaves is confirmed as part of the move. That approves a plan (Planning) or records a review (Code Review). An agent that is still working, or any active run when the card goes to To Do, refuses the move (`RUN_ACTIVE`); stopping it needs its own confirmation.
- **Commits.** Leaving a writing stage for Code Review commits the uncommitted work in the task worktree (message: `commitMessage`, or the card title) with the repository's Git identity. Work is never discarded, stashed, or reset.
- **Evidence gates** (reviewed = tested = task HEAD). Code Review → Testing needs a review of the current commit that is accepted, or completed without findings (the move accepts it). Testing → Merge also needs passing tests for the current commit and a clean worktree. Changes made in Testing go back to Executing, then through Code Review and Testing again. These gates are checked after the hand-off, so a review recorded by the move counts.
- **Rework.** Code Review → Executing passes the review findings (the review becomes `changes_requested`, and an old review never authorizes a newer commit). Testing → Executing passes the failing test output. Merge → Executing passes the conflicted files.
- **Merge** is the one human approval point. Entering Merge checks that the accepted review and passing tests belong to the current commit and that the target checkout is clean. If the target branch moved on, it is merged into the task branch: a clean merge keeps the review (it adds no task changes, `review.carriedFrom`) and reruns the tests on the merge commit; a conflict starts the merge agent in the task worktree, and its result is committed and sent back to Code Review (resolving conflicts changes code). Then the card shows **Merge `<target>`**: one click (`POST /api/tasks/:id/merge-now`) merges, records the result, removes the clean worktree (the branch stays), and moves the card to Done. With **Merge automatically** the merge happens as soon as the card is verified. **Open pull request** pushes without force and opens or updates the pull request; the board checks an open pull request of a card in Merge every minute and moves the card to Done when it is merged. The card shows what the Merge stage is doing (`task.flow`: `merge-tests`, `merge-resolve`, `ready`, or `blocked` with the reason).
- **Done** is reached only through a verified merge (the Merge button, dragging from Merge to Done, or Merge automatically), a merged pull request, or an explicit **no changes required** (task details, only when the branch has no changes). A "move only" request never reaches Done (`MERGE_REQUIRED`).
- **Worktree check before each stage.** The task worktree must exist, be registered with Git, and be on the task branch. A deleted folder is rebuilt from the task branch (`git worktree prune`, then `git worktree add <path> <branch>`; `workspace.recoveredAt` records it). A switched branch (`BRANCH_MISMATCH`) or a deleted branch (`WORKTREE_BRANCH_MISSING`) stops with the exact problem and the safe next action.
- Only the Planning column plans. Executing, Testing, and Merge sessions are told to start their own work without a plan or approval step, even when the card text asks for one, and Claude Code runs them with `EnterPlanMode` and `ExitPlanMode` disallowed.

Stage policies: **Start automatically** (default) starts the stage when a card arrives; **Manual** only moves (start from the card's button). Settings saved as "Ask" by an earlier version mean Start. A stage whose agent cannot start (not installed, not signed in) refuses the drag with the reason; a Manual stage still moves. Without agent terminal support at all, the card moves and the reason is shown.

### Custom columns (Column Manager)

Each project can change its columns (`PATCH /api/projects/:id/columns`, stored as `columnLayout`):

- **Built-in stages** keep their order, because the evidence gates depend on it. They can be renamed and recoloured, and Planning can be hidden (then To Do goes straight to Executing).
- **Custom columns** (at most 12) go anywhere between To Do and Done. Each one is attached to the built-in stage on its left (its anchor). A card moves from the anchor to the custom column, and from the custom column back to the anchor, along the anchor's moves, or to another custom column with the same anchor. `projectTransitions` builds the project's table; the board view sends it to the UI.
- A custom column can start an agent (automatically when a card arrives, or from the card only) with its own instructions. The agent comes from the project default or global default, writes only in the card's own worktree, and never commits. Leaving the column hands off its finished turn and commits its changes like any other stage, and the evidence gates still apply to every stage the card enters, so code changed there cannot skip Code Review or Testing.
- A column that still holds cards cannot be removed or hidden (`COLUMN_NOT_EMPTY`). Planning cannot be hidden while an Autopilot route uses it. Autopilot routes use built-in stages only.
- Column layouts are exported and imported with board backups.

### Agent settings

Each stage's agent comes from the most specific level that names a provider: the stage override (Workflow settings), else the project default agent (Workflow settings), else the global default (Settings), else Claude Code with its CLI defaults. Model and effort come from the same level. `effectiveWorkflow` reports `agentSource` (`stage`, `project`, `global`, or `default`). A run can override the agent for itself only.

A card cannot leave To Do until its project has a linked repository.

## Persistence

- Location: `PROMPTBOARD_DATA_DIR`, or the platform app-data folder: `~/Library/Application Support/Promptboard` on macOS, `%APPDATA%\Promptboard` on Windows, `$XDG_DATA_HOME/promptboard` elsewhere. The folder is created with mode `0700`.
- File: `state.json` = `{ schema: "promptboard.state", version: 2, revision, settings, projects[], runs[], migrations[] }`. Each project owns `tasks[]`.
- Writes go through one queue (`Store.update`). Each write goes to a temporary file, is fsynced, the previous good file is copied to `state.json.bak`, and the temporary file is renamed over `state.json`. A failed change or write leaves memory and disk unchanged (`STATE_WRITE_FAILED`).
- Recovery: an unreadable `state.json` is renamed `state.corrupt-<time>.json`, and the backup is loaded. If there is no good backup, the board starts empty and the damaged file is kept. The UI reports both cases. A file from a newer version is refused and left untouched.
- Revisions: projects and tasks carry `revision`. Every change sends `expectedRevision`; a stale value returns `409 REVISION_CONFLICT`. The global `revision` counts saved writes.
- Logs and artifacts are not stored in `state.json`. Each run has `artifactsDir` = `runs/<runId>`, holding `prompt.md`, `task-prompt.txt`, `events.jsonl`, `output.log`, and `plan.md` or `last-message.md`.
- The browser no longer holds the board. It keeps only per-viewer preferences, such as the selected project.

## Migration, import, export

- On first load, the page sends the old browser board (`ste-prompt-engineer.kanban.v1`) to `POST /api/board/migrate`. Project and card IDs are kept, so a repeated migration adds nothing. Order, exact prompt text (including CRLF and whitespace), source details, verification status, and the outdated-check flag are kept. Every migrated card goes to To Do. The browser copy stays, and the page sets `…kanban.v1.migrated` only after the server confirms. Unreadable browser data is reported and kept, never sent.
- Export (`GET /api/board/export`) writes `promptboard-backup` version 2. Worktrees and runs are left out because they are machine-specific.
- Import accepts version 2 backups and version 1 `kanban-backup` files. Replacing a non-empty board needs `replace: true`. It is refused while any task owns a worktree or an active run. Imported runs are dropped. Imported repository paths, target branches, and automation settings go into `project.pendingImport` and apply only through `confirm-import`; the repository path is revalidated then. Automation always imports as off.
- No import, migration, reload, restart, or card creation starts an agent.

## Repositories and worktrees

- `validateRepository(path)` runs `git rev-parse` without a shell. `GIT_DIR`-style variables are removed, and terminal prompts are off. It reports `GIT_MISSING`, `PATH_NOT_FOUND`, `NOT_A_DIRECTORY`, `NOT_A_REPOSITORY`, `BARE_REPOSITORY`, `NOT_A_WORKTREE`, or `NO_COMMITS`, each with a fixed message. It returns `root`, `commonDir` (from `--git-common-dir`, which works when `.git` is a file), `linkedWorktree`, and the local `branches`. Linking never runs `init` or `commit`. For `PATH_NOT_FOUND`, `NOT_A_REPOSITORY`, and `NO_COMMITS` the UI offers **Set up Git here**; only after the user confirms does `POST /api/projects/:id/init-repository` (`confirm: true`) create the folder if needed, run `git init`, and make one empty commit ("Initial commit", `--allow-empty`, nothing staged), then link. A repository that already has commits is refused (`ALREADY_A_REPOSITORY`); a missing Git identity is reported (`IDENTITY_REQUIRED`) without changing Git configuration.
- The user picks any local target branch; there is no `main` assumption. Its commit is recorded at that moment.
- `ensureTaskWorktree(taskId)` runs on the first authorized Planning or Executing run:
  - It creates branch `promptboard/<slug>-<id8>` (suffixed `-2`, `-3`, … if taken) at `<dataDir>/worktrees/<projectId>/<taskId>`, outside the user's checkout.
  - The base is the recorded commit, not the current branch tip.
  - It runs `git worktree add -b` with repository hooks disabled and fsmonitor off. It does not change the user's checkout.
  - Ownership (`task.workspace = {status, branch, path, baseCommit, repositoryRoot, commonDir}`) is saved before Git runs.
  - Per-task and per-repository locks, plus the saved record, prevent duplicates. Later stages reuse the same branch and folder.
- `removeTaskWorktree(taskId)` removes a worktree only when three things hold: it is recorded for this task, it is inside the app's worktree folder, and Git lists it on that branch. A dirty worktree is refused (`WORKTREE_DIRTY`). It never uses `--force`, and the branch is always kept (`task.retainedBranches`). Deleting a task goes through this check.
- Promptboard never resets or force-moves branches, discards files, auto-stashes, or deletes dirty worktrees.

## Service interfaces (`Board`)

| Method | Purpose |
| --- | --- |
| `view()` | Board, columns, recent runs, `execution.available`, recovery notice |
| `createProject`, `renameProject`, `deleteProject` | Projects; delete is refused while worktrees exist |
| `validateRepository`, `linkRepository`, `listProjectBranches`, `setTargetBranch`, `confirmImport` | Repository link |
| `createTask`, `updateTask`, `duplicateTask`, `moveTask`, `deleteTask` | Tasks; new and duplicated cards start in To Do |
| `migrateBrowserBoard`, `exportBackup`, `importBackup` | Data transfer |
| `ensureTaskWorktree`, `removeTaskWorktree` | Worktrees |
| `requestRun(taskId, {stage})`, `updateRun(runId, {status})` | Runs; `requestRun` needs an executor |

HTTP routes (`src/server.mjs`) take IDs only and resolve every execution path on the server. They use the existing local host and origin checks, the cross-site check, the page token, and a JSON content type. Errors return a stable `code` and a fixed message; raw Git output is never returned.

`GET /api/board` · `GET /api/board/export` · `POST /api/board/migrate` · `POST /api/board/import` · `POST /api/projects` · `PATCH|DELETE /api/projects/:id` · `POST /api/projects/:id/repository` · `GET /api/projects/:id/branches` · `POST /api/projects/:id/target-branch` · `POST /api/projects/:id/confirm-import` · `POST /api/repository/validate` · `POST /api/tasks` · `PATCH|DELETE /api/tasks/:id` · `POST /api/tasks/:id/move` · `POST /api/tasks/:id/duplicate` · `POST /api/tasks/:id/runs` · `DELETE /api/tasks/:id/worktree`

## Agent execution (PB-02)

Execution is a separate subsystem (`src/agents.mjs`, `src/supervisor.mjs`, `src/agent-hook.mjs`). The restricted prompt adapters in `src/providers.mjs` are unchanged and still used only for prompt generation.

**Adapters and capabilities.** These come from the installed CLIs' documented options and were checked live where possible (see `docs/live-verification.md`).

| Provider | Planning | Execution | Lifecycle events | Waiting events |
| --- | --- | --- | --- | --- |
| Claude Code | `--permission-mode plan`, `--tools Read,Grep,Glob`, `--disallowedTools Edit,Write,NotebookEdit,Bash,ExitPlanMode`, no MCP | `--permission-mode acceptEdits` (default) or `default` | Hooks via `--settings`, exec form (no shell) | `PermissionRequest`, permission notifications |
| Codex CLI | `--sandbox read-only --ask-for-approval never` (no plan flag; the sandbox is the boundary) | `--sandbox workspace-write --ask-for-approval on-request` | `notify` program (argv array): `agent-turn-complete`; title-only turns ignored | None (approvals are visible in the terminal only) |
| Gemini CLI | `--approval-mode plan` (`experimental.plan` set for the session) plus a deny policy for write, shell, plan exit, skills, and MCP | `--approval-mode auto_edit` (default) or `default` | Hooks from a merged copy of the system settings (`GEMINI_CLI_SYSTEM_SETTINGS_PATH`) | `Notification` `ToolPermission` |
| Antigravity CLI | Not enabled | Not enabled | Not verified | — |

`bypassPermissions`, `--dangerously-*`, `yolo`, and `danger-full-access` are never used. Unsupported combinations return `STAGE_UNSUPPORTED_BY_PROVIDER` or `INVALID_PERMISSION_MODE`; the adapter never substitutes a broader mode.

**Input.** The first message is the stage instructions plus the exact card text, in markers, plus the approved plan for Executing. It is one argv element up to 100,000 bytes. Longer messages are typed into the terminal with bracketed paste. Gemini receives the message JSON-encoded with `@` escaped, as the prompt adapter does. Task text never reaches a shell. The only shell string is Gemini's hook command, built from app-controlled paths with POSIX single-quote escaping.

**Runs.** `requestRun(taskId, { stage, consent: true, config })` needs `consent: true`, allows one active run per task, and records:
- the configuration snapshot (`provider`, `model`, `effort`, `permissionMode`);
- `promptRevision` (the task's `contentRevision`);
- `workspacePath`, `branch`, and `planRunId`;
- timestamps and the outcome fields `errorCode`, `exitCode`, and `reason`.

Every stage from Planning to Merge can run an agent; To Do and Done never do (`STAGE_NOT_RUNNABLE`).

**Supervisor.**
- **Queue:** runs start in FIFO order, up to `settings.maxConcurrentRuns` (default 1, at most 4). Requests return at once.
- **Sessions:** each session is a `node-pty` process in the task worktree, in its own process group, tracked for shutdown.
- **Output:** each chunk gets an ordered sequence number. It goes to a 1 MiB ring buffer (the reconnect scrollback) and to a 20 MiB `output.log`.
- **Streaming:** `GET /api/runs/:id/stream?after=N` returns NDJSON with the token in a header, never the URL. A slow reader pauses on `drain`; if it falls behind the ring buffer, it gets a `gap` marker instead of unbounded memory use.
- **Separation:** prompt generation keeps its single-job rule, and board runs never use it. Cancelling one run signals only that run's process group. Sign-in changes are refused while agent sessions run.

**Lifecycle.** Only provider events change a run's state:
- A finished turn → `waiting_for_input`. The last message is saved as `plan.md` (Planning) or `last-message.md` (Executing).
- A permission prompt → `waiting_for_input`, with a reason.
- A structured failure → `failed`, with a stable code. There is no automatic retry.

A stage becomes `succeeded` only through `POST /api/runs/:id/confirm` after a finished turn. For Planning, that also records the plan approval. Process exit is never success: an exit without confirmation becomes `interrupted`. If no event arrives within 10 seconds, the run keeps `running` and says the CLI may be asking a startup question, such as folder trust. The hook bridge writes only lifecycle fields; it never prints output that could steer the agent.

**Plan approval.** Plan approval is stored as `task.planApproval = { runId, contentRevision }`. Editing the title or prompt increments `contentRevision`, so the old approval no longer applies and later Executing runs get no plan. Planning is optional: Executing can start directly from To Do.

**Endpoints.** These need the page token, local Host and Origin, and bounded payloads (input 64 KiB, resize 20–500 × 5–300):
- `GET /api/runs/:id`, `/stream`, `/plan`, `/last-message`, `/output`
- `POST /api/runs/:id/input`, `/resize`, `/cancel` (needs `confirm: true`), `/confirm`
- `PATCH /api/settings`

**Recovery and shutdown.**
- Restart marks unfinished runs `interrupted` and replays nothing.
- Shutdown stops owned sessions (TERM, then KILL after a bounded wait), records them `interrupted`, ends streams, and then releases the port.
- Worktrees and artifacts are kept after failures.
- A card with an active run cannot change column until the run is stopped (`RUN_ACTIVE`).

**Setup.** `node-pty` is an optional dependency. If it is missing, `execution.available` is false and `setupMessage` explains how to install it. The prompt editor and board keep working. On macOS, the app restores the execute bit on node-pty's prebuilt `spawn-helper` if an install lost it.

## Board interface (PB-03)

- Every move uses `POST /api/tasks/:id/move { column, index, expectedRevision, transitionId, decision?, commitMessage?, handoffRunId?, config? }` (see [Stage transitions](#stage-transitions)). `POST /api/tasks/:id/reopen` reopens a card in Done. `PATCH /api/projects/:id/workflow { workflow, agentDefaults }` stores stage overrides and the project default agent; runs keep a snapshot of their settings.
- The browser never replaces a newer board with an older answer: every state write raises `revision`, and older views are ignored.
- Terminal output is rendered only by xterm (WebGL renderer, because the CSP blocks xterm's inline `<style>` elements) or through `textContent`. Links are never opened automatically.
- Not tested: Safari, Firefox, Windows, and browsers without WebGL (they use a plain-text fallback). Under software rendering (no GPU), creating each terminal takes several seconds.

## Review, testing, merge, and Done (PB-04)

Everything in this section lives in `src/delivery.mjs`. Evidence is tied to the task commit, the target commit, and the prompt revision. A new commit or an advanced target makes older evidence stale automatically.

- **Commit:** `GET /api/tasks/:id/uncommitted` previews all uncommitted work, including new files, which are read without staging. `POST /api/tasks/:id/commit { message, confirm }` stages everything and commits on the task branch with the repository's existing Git identity and hooks. A missing identity returns `IDENTITY_REQUIRED`; Git configuration is never changed.
- **Code Review:**
  - A review is an agent run of stage `code_review`. It uses the same read-only boundary as Planning, and the committed diff against the target is part of its message.
  - It needs a clean revision with commits ahead of the target (`UNCOMMITTED_CHANGES`, `NO_CHANGES`).
  - Confirming the run records the findings (`evidence.review.status = completed`), parsed from a ```json block. Accepting them is a separate decision (`accept-review`), valid only for the reviewed commit.
  - Moving the card from Code Review to Executing sends the findings back; the next Executing run receives them.
- **Testing:**
  - Test commands are set by the user (`PATCH /api/projects/:id/tests`). Each is stored as argv, parsed without a shell, and runs in the task worktree with a timeout.
  - Imported commands wait in `pendingImport` until confirmed.
  - `POST /api/tasks/:id/tests { confirm }` runs them in the background. For each command it records the command, working directory, exit code, duration, output tail, and a log.
  - Only all-zero exit codes make `passed`. A missing command, timeout, or failure never passes.
  - If the task commit changes during the run, the result becomes `invalid`.
- **Merge:**
  - `GET /api/tasks/:id/merge-preview` lists branches, commits, files, whether a fast-forward is possible, the target checkout, and each eligibility problem.
  - `POST /api/tasks/:id/merge { confirm, taskCommit, targetCommit }` requires all of these: an accepted review for the current task commit, passing tests for the current task and target commits, a fast-forward, a task branch that still points at the previewed commit, and a clean target checkout (tracked files).
  - Merges are serialized per repository and everything is rechecked immediately before.
  - If the target branch is checked out, that checkout runs `git merge --ff-only`. Otherwise `git update-ref` moves the branch with an old-value check. No branch is switched, nothing is pushed, and the result is verified before the card moves to Done.
  - If the target has advanced, `update-branch { confirm }` merges it into the task branch. Conflicts are aborted and reported, never resolved. Review and tests must then run again.
- **Testing and Merge agents:**
  - Testing and Merge can run an agent (`requestRun` with `stage: testing | merge`) with the Executing permissions: it writes only in the task worktree. The stage policies keep their meaning (Testing: run the commands; Merge: merge automatically); agents in these stages start from the card.
  - A Testing run receives the configured test commands. Its claims never count as evidence; only Promptboard's own test run does.
  - Before a Merge run, Promptboard runs `git merge --no-ff --no-commit <target>` in the worktree when the target has advanced, and passes the conflicted files and test commands to the agent. The agent resolves conflicts in files; it is told not to run Git commands that change history.
  - `revision` reports `merging`, `conflicts`, and `unresolved` (every file the merge changes that still has `<<<<<<<` or `>>>>>>>` markers, staged or not). `commit` refuses with `CONFLICT_MARKERS` while any remain, then creates the merge commit. `abort-merge { confirm }` runs `git merge --abort`. Review and tests are then stale and must run again.
- **Pull requests:**
  - `POST /api/tasks/:id/pull-request { confirm, title, body }` needs a clean, committed task branch ahead of the target. It pushes only `refs/heads/<task branch>` to `origin` (or the only remote) without `--force`, then runs `gh pr create --base <target> --head <task branch>` (or reuses an open pull request). No shell; `gh` prompts are disabled. The body is the user's; the task prompt is not sent unless they add it.
  - `POST /api/tasks/:id/pull-request-status` reads the state with `gh pr view`. A merged pull request completes the task (`completion.kind = pull_request`).
- **Done:**
  - A verified merge (`completion.kind = merged`), a merged pull request (`kind = pull_request`), or `complete-no-changes`, allowed only when the branch has no changes (`kind = no_changes`; never described as merged), completes a task through `completeTask`.
  - No other move reaches Done. **Reopen** (`POST /api/tasks/:id/reopen`) moves the card to To Do, clears the completion, and keeps it in `previousCompletions`.
  - Worktree cleanup stays optional and ownership-checked.
- **Automation:** "Start on entry" for Code Review starts a review run. For Testing it runs the configured commands. Merge is Manual by default. With "Merge automatically" a card entering Merge is merged by Promptboard itself (no agent) through the same gate as a confirmed merge: accepted review and passing tests for the current task and target commits, fast-forward only, clean target checkout. If any check fails, nothing is merged and the reason is returned. The completion records `trigger: "automation"`. Automatic stage advancement does not exist.

## Autopilot

- Per project, `project.autopilot = { status: off | running | paused | finished, route, finish: merge | pull_request, maxRework (0-3), queue: [taskId], routes: { taskId: route }, current, done, reason, log }`.
- `PATCH /api/projects/:id/autopilot { route, finish, maxRework, queue, routes, expectedRevision }` saves settings (refused while running). Routes list stages from Planning to Merge in board order; Executing is required; a local merge requires Code Review and Testing (the merge gate needs their evidence).
- `POST /api/projects/:id/autopilot { action: start (confirm: true) | pause | resume | skip | stop }`.
- The engine (`src/autopilot.mjs`) runs on the server and takes one queued To Do card at a time. Before a card starts, the recorded target commit is refreshed, so the card branches from the target as it is after earlier merges. Skipped stages are passed through without running.
  - Planning, Executing, Code Review: `requestRun` (`trigger: automation`); the stage is confirmed only when the run reports a finished turn (`turnComplete`), never during a permission prompt. After Executing, uncommitted work is committed with the task title. A review with `no_issues` is accepted; `changes_required` sends the card back to Executing with the findings.
  - Testing: Promptboard's own test run; a failure sends the card back to Executing with the failing output.
  - Merge: the gated fast-forward merge, or `openPullRequest`. If the target moved, `update-branch` (or, on conflicts, a merge-agent run and a commit) brings it in, and the card returns to Code Review or Testing for the new commit.
  - Rework is bounded by `maxRework`; after that, and on any error, Autopilot pauses with the reason. Cards outside the queue are never touched.

## Integration points for later work

- **PB-03 (review, testing, merge):** these stages reuse the task worktree (`WORKSPACE_REQUIRED` until one exists). Merging into the target branch must be an explicit, confirmed action that never force-updates a branch.
- **PB-04 (automation):** `project.automation.autoRun` exists and is always off. Any automatic start must still go through `requestRun` and its checks, and must never fire on import, migration, reload, or card creation.

## Known limits

- A crash between saving the ownership record and `git worktree add` finishing leaves `status: "creating"`, reported as `WORKTREE_INCOMPLETE`. It is not fixed automatically; check `git worktree list`.
- The transition history keeps the last 100 moves per task.
- The locks work within one app process. Run one Promptboard instance per data folder.
- Codex approval prompts and CLI startup prompts (folder trust, hook review) have no lifecycle event; the user answers them in the terminal.
- Gemini CLI plan and turn events were not verified against a live account (see `docs/live-verification.md`).
- Windows paths and Git behavior are not tested.
