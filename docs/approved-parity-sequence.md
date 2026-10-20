# Approved remaining parity sequence

The user approved this exact sequence on 2026-10-05. Work serially: finish, review, test and merge the current task before starting the next. Do not delegate or run tasks in parallel. The same-day target never overrides validation. Read this durable record when resuming.

For every task: use isolated branches from current main; preserve unrelated commits and the original checkout. Preserve exact Composer/split prompts entering inert To Do, Base and configured CLI tool inheritance. Push and review each bounded step, test on Node 22/24, run the complete local suite on the final tree and require the complete exact-head GitHub CI matrix before merging. Investigate failures before reruns. Do not weaken assertions, extend deadlines, skip required checks, force-push or replay uncertain effects. Mark a task complete only after its scope has shipped. Record PRs and validation evidence here.

1. **Source caching and incremental sync — dropped (Backlog removed in state version 13).** Add persistent GitHub preview caching and explicit incremental refresh. Show freshness and failures, preserve deduplication, and never overwrite locally edited imported tasks or start agents during synchronization.
2. **Attachments and file references — pending.** Add task attachments and validated file references through authoring, import, storage and agent delivery. Preserve exact prompt text, enforce file boundaries, and handle missing files explicitly.
3. **Additional import providers — dropped (Backlog removed in state version 13).** Extend the existing import contract to GitHub Projects, then Azure DevOps, then Asana—one provider at a time. Preserve previews, provenance, atomic imports, durable deduplication and inert Backlog drafts.
4. **Message delivery and recovery — pending.** Add explicit delivery reconciliation/retry, verified native-resume delivery, immediate messages, exit messages and slash commands in separate steps. Preserve ordering, human input and running turns; never automatically replay uncertain delivery.
5. **Provider and session handoffs — pending.** Add deliberate provider changes, optional handoff context, fresh/resumed session strategies and verified plan-to-execute transitions. Preserve workspaces and Base; report unsupported CLI behavior explicitly.
6. **Board configuration and profiles — pending.** Add configuration export, opt-in application, retained references for removed columns and safe live profile propagation. Require revision checks and preserve active sessions, task overrides and existing configuration.
7. **Conversations, memory and activity — pending.** Add a structured conversation viewer and search, then configurable task-scoped memory and improved activity detection. Distinguish working, waiting and completed states using evidence; protect private session data.
8. **Remaining board/completed-task gaps — pending.** Add configurable priorities, direct active-column creation, explicit cleanup, completed-task bulk deletion, expired-context warnings and measured usage/change summaries as separate checkpoints. Preserve numbering, history and execution boundaries.

## Current checkpoint

Task 1 shipped as [#92](https://github.com/datasound-projects/Promptboard/pull/92) and was removed with the Backlog in state version 13, as was the import contract task 3 would have extended; no source cache remains in the code. Tasks 2 and 4–8 are pending.
