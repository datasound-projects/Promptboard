# Approved remaining parity sequence

The user approved this exact sequence on 2026-10-05. Work serially: finish, review, test and merge the current task before starting the next. Do not delegate or run tasks in parallel. The same-day target never overrides validation. Read this durable record when resuming.

For every task: use isolated branches from current main; preserve unrelated commits and the original checkout. Preserve exact Composer/split prompts entering inert To Do, Base and configured CLI tool inheritance. Push and review each bounded step, test on Node 22/24, run the complete local suite on the final tree and require the complete exact-head GitHub CI matrix before merging. Investigate failures before reruns. Do not weaken assertions, extend deadlines, skip required checks, force-push or replay uncertain effects. Mark a task complete only after its scope has shipped. Record PRs and validation evidence here.

1. **Source caching and incremental sync — in progress.** Add persistent GitHub preview caching and explicit incremental refresh. Show freshness and failures, preserve deduplication, and never overwrite locally edited imported tasks or start agents during synchronization.
2. **Attachments and file references — pending.** Add task attachments and validated file references through authoring, import, storage and agent delivery. Preserve exact prompt text, enforce file boundaries, and handle missing files explicitly.
3. **Additional import providers — pending.** Extend the existing import contract to GitHub Projects, then Azure DevOps, then Asana—one provider at a time. Preserve previews, provenance, atomic imports, durable deduplication and inert Backlog drafts.
4. **Message delivery and recovery — pending.** Add explicit delivery reconciliation/retry, verified native-resume delivery, immediate messages, exit messages and slash commands in separate steps. Preserve ordering, human input and running turns; never automatically replay uncertain delivery.
5. **Provider and session handoffs — pending.** Add deliberate provider changes, optional handoff context, fresh/resumed session strategies and verified plan-to-execute transitions. Preserve workspaces and Base; report unsupported CLI behavior explicitly.
6. **Board configuration and profiles — pending.** Add configuration export, opt-in application, retained references for removed columns and safe live profile propagation. Require revision checks and preserve active sessions, task overrides and existing configuration.
7. **Conversations, memory and activity — pending.** Add a structured conversation viewer and search, then configurable task-scoped memory and improved activity detection. Distinguish working, waiting and completed states using evidence; protect private session data.
8. **Remaining board/completed-task gaps — pending.** Add configurable priorities, direct active-column creation, explicit cleanup, completed-task bulk deletion, expired-context warnings and measured usage/change summaries as separate checkpoints. Preserve numbering, history and execution boundaries.

## Current checkpoint

Task 1 draft PR: [#92](https://github.com/datasound-projects/Promptboard/pull/92).

Task 1 recovery branch: `feat/backlog-source-sync-recovery`, based on main `fea77a7803152aad9fa49ab1179a1617cc95720d`. Persistent isolated worktree: `.claude/worktrees/backlog-source-sync-recovery` under the original checkout (already ignored by Git). The original checkout remains on `docs/readme-original-mascot`, HEAD `157e7a45638b179687d0fa5882b90ba5f22e0677`. Prior milestone PR #90 is merged. Tasks 2–8 have not started.

An interrupted session removed the earlier `/private/tmp` worktree and logs before a commit/push. Its completed checks cannot certify this recovered tree. The implementation and regressions have been recovered; repeat all gates on this tree. Keep validation logs in the ignored worktree `.claude/validation` folder, rather than using temporary storage as the sole handoff.

Design: bounded machine-local preview cache outside portable state. Explicit incremental reads merge known metadata in labeled snapshot positions; unseen identities invalidate positions and refresh page 1. Advance the cursor only after complete bounded reads and durable cache publication. Fresh selected imports remain atomic and inert. No background synchronization or automatic task edits.

Recovered checkpoint: default-shell Node 26 cache/adapter/import tests (supplemental only): 34 passed, 0 failed/cancelled/skipped. Browser, broader Node 22/24, final full suite and exact-head CI are still required. The native smoke fixture also waits for a confirmed transport callback inside its existing deadline; a delayed-acknowledgement regression preserves all production safety guards.
