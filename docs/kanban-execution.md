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
| Planning | Fresh read-only session; the task and Base context | A non-empty plan and an unchanged worktree, else `PLAN_MISSING` or `PLAN_MODIFIED_WORKSPACE`. The accepted plan goes to Executing. |
| Executing | Fresh session with the accepted plan, or the review findings / failing test output to fix | A checkpoint commit `promptboard(#N): <column> checkpoint` on the task branch; no changes at all is `NO_CHANGES`. |
| Code Review | Commits pending work, then a fresh read-only session with the diff against the target and the execution summary | A JSON verdict. `no_issues` accepts the review; `changes_required` sends the findings back; anything else is `INVALID_REVIEW_RESULT`. |
| Testing | A fresh session checks the work; then Promptboard runs the project's test commands | Only exit codes decide. Failures (or files the tester changed) go back to Executing with the exact output. |
| Merge | Promptboard's own Git merge of the reviewed and tested commit | Squash (default) or fast-forward, compare-and-swap on the target. Conflicts start a resolver agent in the Merge column; its result is reviewed and tested again. |
| Custom | One conversation continues across compatible custom columns (the earlier column-pipeline behaviour) | You move the card; "on enter" messages are the next instruction. |

New boards use typed columns. Columns saved before types existed stay custom, so existing boards behave exactly as before
until you choose a type in **Columns** or apply the **Full Autopilot** preset.

Every typed arrival starts a **fresh native session** in the same worktree. Nothing resumes another provider's
conversation, so consecutive columns can use different providers (for example Codex executes, Claude reviews, Gemini
tests). The next agent receives the task state instead of a transcript: the exact task text, the branch and target
commits, a short list of earlier stage results, and the stage's own context (plan, diff, findings, test commands or
failures). Enabled "on enter" agent messages of a typed column are sent with the task as column instructions.

## Execution policy

**Columns → Execution permissions** sets the board-wide policy; each active column can override it; board profiles and a
card's task-wide agent override can override it too. One function resolves it for every launch, most specific first:

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

Autopilot takes the queued To Do cards strictly in your order, one card at a time from first column to Done. Before
each card it refreshes the target branch, so a card starts from the target that already contains the cards merged before
it. For typed columns it follows the recorded outcome: succeeded → next column; changes required → back to Executing
(or to Code Review after a merge conflict), up to the board's rework limit (`REWORK_LIMIT_REACHED`); failed → pause with
the reason. It never pushes, never answers an agent's question for you, and pauses for its own card only.

**Full Autopilot** (in Columns) applies, explicitly and with a confirmation: typed standard columns, autonomous
workspace access, automatic completion, two rework rounds, squash merges and a route through every active column.
Any column can still override it.

## Merge

Merge needs an accepted review and passing tests of the same task commit. The merge never touches your checkout unless
the target branch is checked out there and clean, and then only fast-forwards it. Squash builds one commit with exactly
the reviewed and tested tree on top of the previewed target commit; the target moves only if it still has that commit
(otherwise `MERGE_STALE`, nothing changes). A target that moved is merged into the task branch first; a conflict starts
the resolver agent, and the resolved commit goes back through Code Review and Testing. Nothing is pushed.

## Reset task

- **Restart agent sessions:** stops the agent and forgets the card's conversations; the branch, worktree, files and
  history stay, and the next run starts fresh.
- **Reset workspace from the target branch** (confirmation): the current branch is kept exactly as it is (uncommitted
  work is committed to it first), the card returns to To Do, and the next run starts on a new branch.

Moving a card back to To Do stops its agent and keeps the branch, worktree, files and history.

## Machine-readable stops

`WORKTREE_MISSING`, `WORKTREE_BRANCH_MISMATCH`, `PLAN_MISSING`, `PLAN_MODIFIED_WORKSPACE`, `NO_CHANGES`,
`INVALID_REVIEW_RESULT`, `VERIFICATION_FAILED`, `VERIFICATION_INTERRUPTED`, `NO_TEST_COMMANDS`, `REWORK_LIMIT_REACHED`,
`MERGE_BLOCKED`, `MERGE_CONFLICT_UNRESOLVED`, `MERGE_STALE`, `AGENT_STOPPED`, `AGENT_INTERRUPTED`, `CLI_INPUT_NOT_READY`,
`EXECUTION_POLICY_UNSUPPORTED`. Each comes with a sentence that says what failed and what to do; a failed task never
changes the target branch.
