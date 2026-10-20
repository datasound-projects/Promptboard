# Compose Batch

Compose Batch engineers prompts for many Origin tasks at once, lets you review each one, and sends only the approved ones to Kanban. It is the **Batch** side of Compose's `Single | Batch` switch; Single works as before.

## From Origin

In Origin → Tasks, select tasks and choose **Send N tasks to Compose**. The tasks join that Origin project's batch (one batch per project), in build order, and Compose opens in Batch mode. Each task enters once: sending the same tasks again adds nothing. Nothing runs until you choose **Run**. With one task selected, **Send to Compose** opens it in Single mode, as Improve with Compose does.

Each task keeps a snapshot of what Origin said when it arrived: its own words (key, title, What to do, one line per Done when), its Origin context with secrets removed, its prerequisites and the context hash Kanban uses. The batch never changes Origin.

## Runs

- **Bounded and parallel.** Up to *Runs at once* tasks of a batch run at once (1–8, default 3), and at most eight across all batches. The rest wait in the queue. Repeated clicks never start a second run of a task.
- **Isolated.** Each task is one Compose generation of its own: a frozen copy of its snapshot and settings, a fresh CLI process per stage in its own temporary folder, no tools and no resumed session. The request holds only that task: its own words as the request, its Origin context as evidence excerpts, your instructions as answers. Results are written only to that task's own file, and only while that run still owns the task, so a cancelled or late answer is ignored.
- **Failures stay local.** A failed task shows *Failed* with a fixed message (never CLI output); the others continue. **Run all** retries pending and failed tasks only. A rate limit, used-up quota or sign-in problem stops the queued tasks of that batch before they spend more; running ones finish.
- **One at a time or in parallel.** The choice beside **Run all** sets how many tasks run at once: *One at a time* (one agent works on one task) or *2–8 in parallel* (each task gets its own agent).
- **Live progress.** The queue shows what each task asks (its first line), and each running task its stage, a progress bar, the elapsed time and the time left, estimated from the batch's finished runs (before the first one finishes, the bar only moves). The header shows about how long the queue still needs.
- **Cancel, timeout, restart.** Cancel stops queued and running work: running agents get their stop at once (their process group ends; a CLI that does not exit within a second is killed), before any other queued change. A task stops after 20 minutes. Runs live in the app process: after a restart, a task that was running shows “The app stopped while this task was running. Run it again.” (a stopped generation makes it *Failed*) and a queued one is pending again. Nothing is re-run on its own. Sign-in changes wait until no batch work runs.

Regenerating always uses the task as Origin has it now.

## Settings

Three levels: your **Compose** settings → **batch settings** → **task settings**. Each level names only what it changes; everything else is inherited, and the page shows where each value comes from. A level that chooses another CLI resets the model and effort it does not set. Settings: CLI, model, effort, checks (Reviewed or Fast), detail, task type, language, the four prompt aids, whether the Origin context is given to the prompt writer, and extra instructions (task instructions replace batch instructions). The effective settings are fixed when a task is queued and stored with the version it produces: a change applies to tasks queued after it, not to tasks already queued or running. A change of *Runs at once* applies at once.

Compose's context sources (project folder, documents, MCP) are not used in Batch.

## Integrity

The prompt may make a task clearer; it must not change what the task asks. Every version is checked:

| Check | How | Severity |
| --- | --- | --- |
| Exact values (code, paths, URLs, numbers, quotes) | Deterministic, against the task's own words | Blocks approval |
| Each requirement covered, not changed | The model review (a separate call) per requirement unit | Missing or changed blocks |
| Scope, constraints, conflicts, invented facts | The model review's criteria with quoted evidence | Confirmed issues block |
| Acceptance checks present | Deterministic trace of every Done when | Read before approving |
| Another task's key, a rejected technology | Deterministic | Read before approving |
| Origin warnings (open decision, no Done when) | From Origin | Read before approving |
| Origin task changed or deleted, prompt from an older task | Deterministic, on every view | Blocks approval |
| A secret in the task text or instructions | Deterministic | The task does not run |

**Requirement trace** shows each Origin requirement, the prompt section that carries it, the acceptance check and the review's verdict. Sections and checks are matched by shared words; the review decides coverage.

Generation repairs at most once (Reviewed mode), as in Single. There is no automatic regeneration loop.

**Improve with Compose** in Origin (several tasks) runs on this queue too, with the CLI, model, effort, checks, grounding and runs chosen in its window, and brings each prompt back to its Origin task as a proposal. **Use in Origin task** in the selected task does the same for one prompt by hand; it is offered while the prompt still matches the task.

## Review and approval

- **Approve** approves exactly the current version. A task with a blocking finding cannot be approved.
- **Approve passing** approves only tasks with no findings at all. Fast mode has no model review, so its prompts are approved one by one.
- **Save edit** saves a new version; its exact values are checked again. If the last review found problems, the edit must be checked again (**Check again**, one review call) before approval.
- Regenerating, editing or checking again removes the approval until you approve again.
- **Reject** keeps a task out of Kanban; **Restore** brings it back. **Remove from batch** (click twice) takes a task and its prompts out of the batch, for example a task deleted in Origin; Origin and Kanban stay as they are. **Versions** keeps the last 12 versions with their settings.

## Split

**Split…** proposes smaller parts for the current prompt (one call). Nothing changes until **Use these tasks**; that is refused while an exact value of the prompt is in no part. Each part is approved separately and can be edited. On Kanban the parts run one after another, the first waits for the task's prerequisites, and later tasks wait for the last part.

## Kanban

**Send N to Kanban** creates To Do cards in the Kanban project linked to the Origin project, prerequisites first. Each card carries the approved prompt followed by the task's Origin context, and its Origin identity, so sending again never duplicates a card and Origin's own Send to Kanban sees it as sent. Origin's snapshot of each card records the batch, version and prompt hash. Sending is refused when:

- a task is not approved, or its approval is older than its prompt or task;
- a prerequisite has no card and is not approved in this send;
- prerequisites form a loop;
- a card was deleted in Kanban (choose to create it again).

Nothing starts: no agent, automation or worktree. Tasks that already have a card are locked in the batch.

## Storage and API

Batches live in `<data>/compose-batches/<origin-id>/`: `batch.json` and one file per task under `items/`, written atomically with a backup. A damaged file is kept aside as `….corrupt-…` and its backup is used. Removing a batch leaves Origin and Kanban as they are.

`/api/compose/batches` — list (GET), add Origin tasks (POST). `/:id` — queue (GET; `since`, `origin` and `instance` answer `unchanged`), remove (DELETE). `/:id/settings`, `/run` (`all`, `itemIds`, `kind`: generate, review or split), `/cancel`, `/approve` (`items` or `passing`), `/export` — POST. `/:id/items/:itemId` — one task (GET), change it (PATCH: `overrides`, `prompt` + `baseVersionId`, `rejected`, `child`), remove (DELETE); `/split` (POST `accept`).

## Limits

- 500 tasks per batch; per-task context for the prompt writer is capped at Compose's grounding budget (the card still carries the full context).
- The deterministic trace is lexical: it locates; it does not prove meaning.
- Tasks that already have a card keep their card; Batch does not replace a card's prompt.
- Real provider runs were not part of the automated tests; they use a stand-in CLI.
