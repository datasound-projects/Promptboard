# Kanban execution: typed columns, permissions, completion and Autopilot

You decide what is built and in what order. Promptboard carries each card from To Do to Done: it runs the agent you chose
for each column in the task's own branch and worktree, checks every stage, and merges the result. A drag and Autopilot
use the same engine; Autopilot only decides when the card moves.

## One task, one branch, one worktree

The first agent run of a card creates its branch (`promptboard/<title>-<id>`) and worktree from the target branch's
current commit. Every later column, provider and session of that card uses the same branch and worktree until the card
is merged or you reset it. Before each run Promptboard checks that the worktree exists, belongs to the linked
repository, is registered with Git and is on the task branch. Anything else stops with a reason
(`WORKTREE_MISSING`, `WORKTREE_BRANCH_MISMATCH`, `WORKTREE_BRANCH_MISSING`, `WORKTREE_REPOSITORY_MISMATCH`). A deleted
worktree folder is never recreated silently: **Restore worktree** in the task details recreates it from the branch
(every commit is there; uncommitted files are gone).

## Column types

Each active pipeline column has a type; its name is only a label.

| Type | What an arrival does | How the stage completes |
| --- | --- | --- |
| Planning | Fresh read-only session; the task and Base context | A non-empty plan and an unchanged worktree, else `PLAN_MISSING` or `PLAN_MODIFIED_WORKSPACE`. A plan completed automatically or by Autopilot also needs numbered steps (a question is `PLAN_MISSING`). The accepted plan is frozen with its hash and goes to Executing; a missing or changed copy stops Executing with `PLAN_UNAVAILABLE`. |
| Executing | Fresh session with the accepted plan, or the review findings / failing test output to fix | A checkpoint commit `promptboard(#N): <column> checkpoint` on the task branch; no changes at all is `NO_CHANGES`, and a rework round with no new commit is `NO_NEW_CHANGES`. |
| Code Review | Commits pending work, then a fresh read-only session with the diff against the target and the execution summary | A JSON verdict. Critical, high and medium findings send the work back; low findings are kept as suggestions and never block. `no_issues` accepts the review; anything unreadable is `INVALID_REVIEW_RESULT`. |
| Testing | A fresh session tests the work. With no test commands configured (they are optional) the agent finds the project's tests itself, runs them and ends with a JSON verdict (`verdict`, `commands` with exit codes, `failures`, `summary`); with commands configured, Promptboard runs them after the agent | Without commands, the verdict decides: a pass counts only when it lists commands that all exited 0, and a missing or inconsistent verdict is `INVALID_TEST_RESULT`. With commands, only their exit codes decide. Failures (or files the tester changed) go back to Executing with the findings or the exact output; a commit the tester made (`TESTER_COMMITTED`) goes back to Code Review. |
| Merge | Promptboard's own Git merge of the reviewed and tested commit | Squash (default) or fast-forward, compare-and-swap on the target. Conflicts start a resolver agent in the Merge column; its result is reviewed and tested again. |
| Custom | One conversation continues across compatible custom columns (the earlier column-pipeline behaviour) | You move the card; "on enter" messages are the next instruction. |

New boards use typed columns. Columns saved before types existed stay custom, so existing boards behave exactly as before
until you choose a type in **Columns** or apply the **Full Autopilot** preset.

### What every typed run is told

After the exact card text, each Planning, Executing, Code Review, Testing and Merge run (and each legacy stage) gets a
section **Where this task fits**, built from the board only: the project, the card and its position among the cards
planned together in Origin ("task 2 of 5"), the stage's own job, each prerequisite with how it was completed and what it
did, the other cards of the project for awareness (an Origin card with its "What to do" line, any other card by title,
at most 20), and the boundary: the project's goals and design describe the whole project and do not authorize other
cards' work; Promptboard owns card moves, merging and Done. Custom columns keep sending exactly the task envelope.

### Done

Merge, a pull request or "no changes" records how the card was completed. Moving a card to Done in any other way
completes it **without merging**: the record says so, with the branch, its commit and any uncommitted changes, and the
stage it left is no longer shown as running. Moving the card out of Done again keeps that record in its history.

Every typed arrival starts a **fresh native session** in the same worktree. Nothing resumes another provider's
conversation, so consecutive columns can use different providers (for example Codex executes, Claude reviews, Gemini
tests). The next agent receives the task state instead of a transcript: the exact task text, the branch and target
commits, a short list of earlier stage results, and the stage's own context (plan, diff, findings, test commands or
failures). Enabled "on enter" agent messages of a typed column are sent with the task as column instructions.

## Execution policy

**Columns → How it runs** offers two ways of working: **Hands-off** (the Full Autopilot preset below) and **Step by step**
(the defaults: agents ask, you complete each stage). Its **Advanced** section sets the board-wide policy; each active
column can override it under **More options**; board profiles and a card's task-wide agent override can override it too. One function resolves it for every launch, most specific first:

task override → board profile → column → board → defaults (ask, task workspace, manual completion).

| Setting | Values |
| --- | --- |
| Agent questions | Ask for approval · Autonomous (never pause for approval) |
| Workspace access | Read only · Write in the task workspace · Full access |
| Stage completion | Manual (you complete each stage) · Automatic (when the turn is done and the stage's checks pass) |

Planning and Code Review columns are always read-only. Promptboard translates the policy for each CLI:

| | Claude Code | Codex CLI | Gemini CLI |
| --- | --- | --- | --- |
| Read only | plan mode, Read/Grep/Glob only | `--sandbox read-only --ask-for-approval never` | plan approval mode with a deny policy |
| Ask, workspace | `acceptEdits` | `workspace-write`, `on-request` | `auto_edit` |
| Autonomous, workspace | `auto` (Claude's own classifier decides; no prompt) | `workspace-write`, `never` | `yolo` inside `--sandbox` |
| Autonomous, full | `bypassPermissions` | `danger-full-access`, `never` | `yolo` without sandbox |

**Folder trust.** Claude Code and Codex ask whether to trust each new folder, and every task worktree is a new folder.
By default the run waits for you. With **Trust Promptboard task worktrees automatically**, Promptboard answers only
that question, only when the rendered screen is positively identified as the CLI's folder-trust menu (Claude Code:
"Accessing workspace … Yes, I trust this folder"; Codex: "Folder access … Trust this folder? … Trust and continue"),
only when the folder it names is exactly this card's worktree, and only once the screen has settled. Any other startup
question (sign-in, an update offer, a background-server question) stays with you and the run waits. Gemini's menu is not
recognized. Autonomous Codex sessions also start without its update offer and its shared background server
(`-c check_for_update_on_startup=false --disable daemon_auto_start`), whose menus would otherwise wait for an answer.

A combination a provider cannot run is refused when you save the policy (`EXECUTION_POLICY_UNSUPPORTED`), never in the
middle of a task. Writing agents are told not to commit: Promptboard makes the checkpoint commits, which also keeps
Codex from asking to write Git metadata outside its sandbox.

## Completion: manual and automatic

A typed stage completes only after the CLI reported a finished turn, nothing is outstanding (tools, permission or
question prompts, unconfirmed input) and the stage's own check passes. Process exit or a quiet terminal never counts.
- **Manual:** the card waits; **Complete stage** (or dragging the card on) completes it.
- **Automatic:** Promptboard completes it as soon as those conditions hold, also when you move cards yourself.

The outcome is shown on the card and in **Stage and reset** in the task details, with the findings and the stage history.

## Autopilot

Autopilot takes the queued To Do cards in your order, one card at a time from first column to Done. A card whose
prerequisites are not complete waits, and the next queued card that is ready goes first; if every remaining card waits,
Autopilot pauses and names what it waits for. A prerequisite is complete when its card is in Done and its code is on the
target branch: merged, a merged pull request, or no code changes (a card that never had a worktree counts too). Done
without merging does not count, for a card you start by hand either. Before
each card it refreshes the target branch, so a card starts from the target that already contains the cards merged before
it. For typed columns it follows the recorded outcome: succeeded → next column; changes required → back to Executing
(to Code Review after a merge conflict, to Testing when the target moved). Rework goes on while each round brings a
new problem; each Executing run gets the current findings and the earlier rounds, so a fix that undoes another is
noticed. Autopilot pauses with `REWORK_LIMIT_REACHED` only when a problem keeps coming back (the board's limit, 2 by
default) or after 8 rounds in any case; failed → pause with
the reason. It never pushes, never answers an agent's question for you, and pauses for its own card only.

**Full Autopilot** (Columns → How it runs → **Hands-off**) applies, explicitly and with a confirmation: typed standard columns, autonomous
workspace access, folder trust for task worktrees, automatic completion, a pause when a problem comes back twice, squash merges and a route through every active column.
Any column can still override it.

## Merge

Merge needs an accepted review and passing tests of the same task commit. The merge never touches your checkout unless
the target branch is checked out there and clean, and then only fast-forwards it. Squash builds one commit with exactly
the reviewed and tested tree on top of the previewed target commit; the target moves only if it still has that commit
(otherwise nothing changes and the merge is prepared again). A target that moved is merged into the task branch first;
the combined code is tested again: by the configured test commands, or, without them, by sending the card back to the
Testing agent (`TARGET_MOVED`). A conflict starts the resolver agent, and the resolved commit goes back through Code
Review and Testing. If the app stops while those tests run, **Merge** (or resuming Autopilot) runs them again. Nothing is
pushed.

## Reset task

- **Restart agent sessions:** stops the agent and forgets the card's conversations; the branch, worktree, files and
  history stay, and the next run starts fresh.
- **Reset workspace from the target branch** (confirmation): the current branch is kept exactly as it is (uncommitted
  work is committed to it first), the card returns to To Do, and the next run starts on a new branch.

Moving a card back to To Do stops its agent and keeps the branch, worktree, files and history.

## Machine-readable stops

`WORKTREE_MISSING`, `WORKTREE_BRANCH_MISMATCH`, `PLAN_MISSING`, `PLAN_MODIFIED_WORKSPACE`, `PLAN_UNAVAILABLE`, `NO_CHANGES`, `NO_NEW_CHANGES`, `TESTER_COMMITTED`,
`INVALID_REVIEW_RESULT`, `VERIFICATION_FAILED`, `VERIFICATION_INTERRUPTED`, `INVALID_TEST_RESULT`, `TESTS_FAILED`, `TEST_COMMAND_NOT_FOUND`, `TARGET_MOVED`, `REWORK_LIMIT_REACHED`,
`MERGE_BLOCKED`, `MERGE_CONFLICT_UNRESOLVED`, `MERGE_STALE`, `AGENT_STOPPED`, `AGENT_INTERRUPTED`, `CLI_INPUT_NOT_READY`,
`EXECUTION_POLICY_UNSUPPORTED`. Each comes with a sentence that says what failed and what to do; a failed task never
changes the target branch.
