# Agentic Kanban contract

This file records the board's state model, safety rules, persistence format, and service interfaces. PB-01 built the foundation. PB-02 added agent execution for Planning and Executing (see [Agent execution](#agent-execution-pb-02)). Later stages keep these rules.

Kangentic was used as a behavior reference only. No code was copied.

## Columns

| ID | Title | Runs an agent |
| --- | --- | --- |
| `todo` | To Do | Never |
| `planning` | Planning | Yes, after explicit consent |
| `executing` | Executing | Yes, after explicit consent |
| `code_review` | Code Review | PB-04 |
| `testing` | Testing | PB-04 (commands) |
| `merge` | Merge | Never (Git operation, PB-04) |
| `done` | Done | Never |

The columns are fixed in `src/board.mjs` (`COLUMNS`). **The backend enforces "never"**: `requestRun` rejects `todo` and `done` with `STAGE_NOT_RUNNABLE`, whatever the UI shows.

## State model

A **task** has a position: `column`, plus its order in the project's task list. A **run** has a status. The two are separate on purpose:

- Moving a card records a transition `{at, from, to, by}` on the task. It does not create a run, and it does not show that a stage succeeded.
- Run status is one of `queued`, `running`, `waiting_for_input`, `succeeded`, `failed`, `cancelled`, or `interrupted`. Only these forward changes are accepted: queued → running, cancelled, or failed; running → waiting_for_input, succeeded, failed, or cancelled; waiting_for_input → running, cancelled, or failed.
- When a new process starts, any run still `queued`, `running`, or `waiting_for_input` becomes `interrupted`. It is never restarted.

Allowed moves (`canTransition`):

- Reordering within a column is always allowed.
- A card can move forward one stage, and To Do → Executing is allowed (Planning is optional).
- A card can move back to any earlier stage, for rework.
- Done can only reopen to To Do.

A card cannot leave To Do until its project has a linked repository. A card with an active run cannot change columns.

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

- `validateRepository(path)` runs `git rev-parse` without a shell. `GIT_DIR`-style variables are removed, and terminal prompts are off. It reports `GIT_MISSING`, `PATH_NOT_FOUND`, `NOT_A_DIRECTORY`, `NOT_A_REPOSITORY`, `BARE_REPOSITORY`, `NOT_A_WORKTREE`, or `NO_COMMITS`, each with a fixed message. It returns `root`, `commonDir` (from `--git-common-dir`, which works when `.git` is a file), `linkedWorktree`, and the local `branches`. Promptboard never runs `init` or `commit` for the user.
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

Code Review, Testing, and Merge runs return `STAGE_NOT_IMPLEMENTED` until PB-04.

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

- Every move uses `POST /api/tasks/:id/move`, which records the transition first. Then, for Planning or Executing, it applies the project's workflow policy: `ask` returns a question, `start` requests a run with `trigger: "automation"`, and `manual` does nothing. `PATCH /api/projects/:id/workflow` stores overrides; runs keep a snapshot of their settings.
- Terminal output is rendered only by xterm (WebGL renderer, because the CSP blocks xterm's inline `<style>` elements) or through `textContent`. Links are never opened automatically.
- Not tested: Safari, Firefox, Windows, and browsers without WebGL (they use a plain-text fallback). Under software rendering (no GPU), creating each terminal takes several seconds.

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
