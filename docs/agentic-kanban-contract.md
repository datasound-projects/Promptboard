# Agentic Kanban contract (PB-01)

This file records the board's state model, safety rules, persistence format, and service interfaces. PB-01 builds the foundation. **No agent runs yet:** no executor is registered, so every run request is refused before any worktree is created. PB-02 to PB-04 add execution on top of these rules without weakening them.

Kangentic was used as a behavior reference only. No code was copied.

## Columns

| ID | Title | Runs an agent |
| --- | --- | --- |
| `todo` | To Do | Never |
| `planning` | Planning | Yes (PB-02) |
| `executing` | Executing | Yes (PB-02) |
| `code_review` | Code Review | Yes (PB-02) |
| `testing` | Testing | Yes (PB-02) |
| `merge` | Merge | Yes (PB-02) |
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
- Logs and artifacts are not stored in `state.json`. Runs carry a relative `logDir` (`runs/<taskId>`) for PB-02.
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

## Integration points for later work

- **PB-02 (execution):** pass `executor` to `startServer`/`Board`. `executor.start({ run, task, workspace })` must launch the CLI in `workspace.path` only, write logs under `<dataDir>/runs/<taskId>/`, and report progress through `updateRun`. It must keep the prompt-generation restrictions: no permission-bypass flags and no added tools, shell, MCP, or network access beyond what PB-02 explicitly specifies. Cancellation and shutdown must use the owned-process cleanup in `providers.mjs`.
- **PB-03 (review, testing, merge):** these stages reuse the task worktree (`WORKSPACE_REQUIRED` until one exists). Merging into the target branch must be an explicit, confirmed action that never force-updates a branch.
- **PB-04 (automation):** `project.automation.autoRun` exists and is always off. Any automatic start must still go through `requestRun` and its checks, and must never fire on import, migration, reload, or card creation.

## Known limits

- A crash between saving the ownership record and `git worktree add` finishing leaves `status: "creating"`, reported as `WORKTREE_INCOMPLETE`. It is not fixed automatically; check `git worktree list`.
- The transition history keeps the last 100 moves per task.
- The locks work within one app process. Run one Promptboard instance per data folder.
- Windows paths and Git behavior are not tested.
