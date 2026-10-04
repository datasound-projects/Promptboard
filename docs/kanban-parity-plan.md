# Promptboard Kanban parity plan

Promptboard should use Kangentic's Kanban behavior as the reference for task orchestration. A task's column controls its agent session, and column automations provide the next instructions. This document compares that target with this checkout and proposes the implementation sequence. It records requirements and design decisions for review; the runtime still follows [the existing contract](agentic-kanban-contract.md).

Scope is the Kanban board and the services it needs: tasks, columns, automations, archives, backlog, profiles, Git workspaces, session continuity, conversation history, and activity. Prompt composition remains part of Promptboard. Kangentic's desktop packaging, mobile app, relay, window system, and complete agent catalog are outside this scope.

Reviewed on 3 October 2026 against the documentation linked below and GitHub main at `9089a95`, after reconciling the existing local changes. That baseline includes Composer editing and task splitting, Base assignments and native tool delivery, and the usage dashboard.

Two integration requirements apply to every step: Composer must continue inserting exact engineered prompts and edited split tasks into To Do without starting an agent; Base must continue resolving user-selected resources and supplying supported MCP tools and native subagents under the configured permissions. Session continuation must retain Base delivery records and recheck resource revocations when launching another process. Base agent profiles remain distinct from board workflow profiles.

The user also confirmed that Kanban agents should inherit tools, MCP servers, and extensions configured in their underlying CLI. Implement ambient CLI inheritance for writing stages alongside Base delivery as a separate compatibility step. Retain the current read-only legacy stage restrictions and do not change CLI configuration files.

## Default board behavior

The following layout is the product requirement supplied by the user. Column names are editable; behavior should attach to a role or setting rather than the display name.

| Column | Session behavior |
| --- | --- |
| To Do | No agent; entering resets the task session. |
| Planning | Starts in plan mode; a detected plan exit moves to Executing. |
| Executing | Starts or resumes with the configured execution permissions. |
| Code Review | Keeps the agent running; a configured message supplies review instructions. |
| Testing | Keeps the agent running; a configured message supplies test instructions. |
| Merge | Keeps the agent running; configured automation supplies shipping instructions. |
| Done | Suspends the session, preserves context, and archives the task. |

Kangentic runs exit automations, applies the destination's session rule, then runs enter automations. Compatible active-column moves retain the conversation. Default columns contain no automation messages; the first spawn gets the task envelope, and later instructions come from configured message rows. Planning has a continuation fallback when its exit target has no message. To Do and Done allow exit automations only. The four automation types are agent message, script, webhook, and notification. Delivery can be immediate or deferred; a fresh spawn waits for readiness. Runs record failures and interruptions rather than silently replaying side effects. The queue is global and FIFO. [Columns and automations](https://www.kangentic.com/features/workflows/)

These defaults provide session orchestration. A configured board can provide a complete plan, execute, review, test, and ship pipeline. Arrival in an unconfigured Review, Testing, or Merge column must not imply that the agent was instructed to do that work.

## Initial gap audit

This table records the starting implementation before the checkpoints below. The final implementation-status paragraph distinguishes completed work from the remaining gaps.

| Area | Starting Promptboard behavior | Required change |
| --- | --- | --- |
| Column moves | A fixed transition matrix restricts the destination. | Resolve moves from project column definitions and their lifecycle settings. |
| Session continuity | Stage handoff confirms and ends the previous run; the next stage starts another CLI. | Keep compatible live sessions across moves; support native resume and explicit handoff when settings change. |
| Prompts | `composeMessage` adds fixed stage instructions and repeats task text. | Separate the first task prompt from automation messages and resumed-session input. |
| Planning | Plan exit is unavailable in the restricted adapters; plan approval is separate. | Add a provider-aware plan-exit signal and configured exit target. |
| Review and tests | Read-only review, committed diffs, and matching evidence are required by the stage contract. | Make lifecycle independent of the names Review and Testing; retain evidence tools as optional capabilities. |
| Merge | Arrival invokes built-in merge preparation and verification gates. | Make arrival follow column settings; keep Git delivery available as an explicit operation. |
| To Do | Active runs block moves; returning does not reset the session. | Implement reset semantics and a preview when cleanup would lose work. |
| Done | Verified completion is gated; cards remain in Done; reopening goes to To Do. | Archive on arrival and restore to a chosen active column with context. |
| Column manager | Built-in stages keep their order; custom moves depend on the stage to their left. | Allow configurable columns, roles, ordering, and per-column session strategy. |
| Automations | Stage instructions and Autopilot implement a specialized pipeline. | Add ordered, enabled enter/exit automation lists and a persistent run log. |
| Queue | The supervisor already has a global FIFO queue, with a default limit of one and a maximum of four. | Preserve its ownership guarantees; support queued moves, cancellation, suspension, and visible queue position. |
| Task authoring | Tasks have a title, exact prompt, and prompt-generation metadata. | Add description, attachments, display number, labels, priority, and task strategy choices. |
| Backlog | Board backup import exists; there is no separate backlog or tracker import service. | Add backlog storage, promotion, bulk operations, and deduplicated imports. |
| Profiles | Global, project, stage, and custom-column agent overrides exist. | Add named sparse strategy overrides selected per task. |
| Shared configuration | Board settings live in the app state and board backups. | Add repository configuration and personal overrides with reconciliation. |
| Persistence | Atomic state writes and run artifacts exist; restart marks active runs interrupted. | Persist logical sessions and resumable conversation references independently of process runs. |
| Conversation memory | Output, last messages, plans, and summaries are retained; native history is read for usage counts. | Parse structured conversation turns, add a viewer and project search. |
| Activity | Hooks detect broad running, waiting, and turn-complete states. | Separate activity from session status and completion; account for tools and background work. |

Evidence for this table comes from `src/board.mjs`, `src/supervisor.mjs`, `src/agents.mjs`, `src/agent-hook.mjs`, `src/store.mjs`, `src/delivery.mjs`, `src/autopilot.mjs`, `src/base.mjs`, `src/base-resolver.mjs`, `src/usage.mjs`, `public/app.js`, and their tests. Having seven matching column names does not currently provide lifecycle parity.

## Requirements from the supporting chapters

### Installation and task creation

Kangentic detects installed agent CLIs and explains missing installation or sign-in prerequisites. Its tasks support Markdown descriptions, attachments, labels, priorities, display numbers, branch/base choices, and worktree selection. Creating into an active column can start work; reordering within a column does not touch the session. [Installation](https://www.kangentic.com/guide/installation/), [Creating tasks](https://www.kangentic.com/guide/creating-tasks/)

Proposed Promptboard implementation: reuse existing CLI discovery and authentication, add readiness information to board setup, and extend task creation to route through the same arrival handler as a move. Preserve legacy `prompt` bytes during migration rather than silently rewriting existing tasks. Assign stable project task numbers. Keep isolated worktrees as the initial default; implement main-checkout tasks with explicit collision handling before exposing the toggle.

### Completed tasks

Kangentic archives Done tasks in a sortable table with session usage and change summaries. Restore chooses a column and resumes the conversation. The first move out of Done skips destination agent-message automations; other automations still run. [Completed tasks](https://www.kangentic.com/guide/completed-tasks/), [Columns and automations](https://www.kangentic.com/features/workflows/)

Proposed Promptboard implementation: add `archivedAt`, keep the task and conversation records, and expose archive browsing separately from live cards. Aggregate only measured usage; show unavailable values explicitly. Bulk restore returns individual outcomes so one failed workspace recreation does not hide successful restores.

### Backlog and imports

Kangentic provides a separate backlog with filtering, labels, priorities, manual order, bulk promotion, and imports from GitHub Issues, GitHub Projects, Azure DevOps, and Asana. Promotion preserves task metadata and uses the destination's arrival behavior. Imported tickets retain their source identity; duplicate detection includes promoted and archived tasks. [Backlog and imports](https://www.kangentic.com/guide/backlog/)

Proposed Promptboard implementation: represent backlog placement separately from a column. Implement local backlog and GitHub Issues first using the existing GitHub CLI integration, then GitHub Projects and the other named sources as independent import adapters. Store source/provider IDs on the task and maintain a project import index. Import into backlog without running agents. Attachment download failure must be visible without dropping the ticket.

### Profiles and board configuration

Kangentic profiles override per-column strategy while sharing column structure and automations. Missing, explicitly cleared, and set fields have different meanings. A task chooses a profile or a task-wide agent override. Repository configuration is team-shared; a separate local file supplies personal overrides. Automation arrays replace as complete lists during merging. [Board profiles](https://www.kangentic.com/features/board-profiles/), [Board configuration](https://www.kangentic.com/guide/board-config/)

Proposed Promptboard implementation: use `promptboard.json` and `promptboard.local.json` with a documented versioned schema. Profiles contain strategy fields only. Optional review/test enforcement is a separate Promptboard policy, not a Kangentic-style profile field. Resolve configuration by stable IDs, retain occupied removed columns until tasks can be relocated, and validate plan targets. Reconcile file changes without firing automations merely because the file was read. Imported executable configuration remains inactive until accepted, matching existing backup handling.

### Agent orchestration and Git workspaces

Kangentic supports native session resume, per-column agent choices, and cross-agent handoff through readable native conversation history. Changing relevant agent settings can require a resume or a fresh agent rather than retaining the process. Worktrees isolate tasks; cleanup warns about uncommitted files or local-only commits before deleting them. PR URLs can be linked from agent output or manually. [Agent orchestration](https://www.kangentic.com/features/agent-orchestration/), [Worktrees and pull requests](https://www.kangentic.com/features/git-worktrees/)

Proposed Promptboard implementation: begin with its existing Claude, Codex, and Gemini adapters. Declare each adapter's verified lifecycle, resume, plan-exit, transcript, and message-delivery capabilities. Keep the current repository ownership checks and workspace recovery. Add a cleanup preview and an explicitly confirmed destructive path; never treat an ordinary drag as permission to discard uncommitted or unpushed work. Keep the present commit/test/PR/merge services available independently of mandatory column gates. Expand provider support only with adapter verification.

### Session persistence and conversation memory

Kangentic persists session metadata and terminal replay, resumes using native conversation IDs, distinguishes user pauses from system suspension, and blocks in-place resume for To Do or archived tasks. Conversation memory indexes structured turns rather than terminal redraws; keyword search is local, while semantic search is optional. [Session persistence](https://www.kangentic.com/features/sessions/), [Conversation memory](https://www.kangentic.com/features/conversation-memory/)

Proposed Promptboard implementation: retain the atomic store and artifacts initially. Introduce durable logical sessions and append structured turns separately from state snapshots. A process exit does not mean task completion. Persist user pause intent and recover orphaned process records without replaying automation runs. Implement keyword search and a clean conversation viewer before introducing an optional local embedding service. Keep indexing project-scoped and configurable.

### Activity detection

Kangentic distinguishes session status from activity. Permission waits, tools, subagents, and background shells contribute to the indicator. Detection uses provider hooks or provider-specific terminal fallbacks. [Activity detection](https://www.kangentic.com/features/activity-detection/)

Proposed Promptboard implementation: normalize provider events into one activity reducer. Track permission waits and outstanding work separately from turn completion. PTY silence may inform the display; it must not approve a plan, finish a task, authorize cleanup, or prove a message was received. Reuse actual turn-end events where available. Add bounded recovery for stale activity counters and label uncertain detection.

## Proposed architecture

This section is an implementation proposal for Promptboard, not a claim about Kangentic's internal code.

Separate four durable entities:

| Entity | Responsibility |
| --- | --- |
| Task | Requirement text, metadata, board/backlog/archive placement, ordering, and workspace ownership. |
| Session | The logical conversation, native provider ID, strategy, transcript references, pause intent, and resumability. |
| Run | One launch of a CLI process, timestamps, exit result, terminal log, and its session ID. |
| Automation run | One row firing for one arrival or departure, including delivery outcome or side-effect result. |

`Board.transition` remains the common entry point for drag, menus, programmatic moves, backlog promotion, and plan exit. It validates revisions and serializes operations per task. Same-column reorder is a placement operation. Introduce a move journal with stable event IDs so a retried HTTP request does not deliver another message or repeat a script. Persist a row as started before its side effect; after an unknown outcome, mark it interrupted and require an explicit retry.

The lifecycle service resolves effective column strategy, checks whether the existing process is compatible, then keeps, suspends, resumes, replaces, or resets its session. The supervisor continues to own PTYs, output streaming, queue slots, cancellation, and shutdown. A dedicated automation service executes rows and records outcomes. Git delivery remains a separate service callable by explicit UI operations or intentionally configured automation.

Message delivery needs a scheduler per session: bounded pending input, readiness, immediate/deferred semantics, outcome recording, and provider-specific confirmation. Delivery must preserve a running turn. Unsupported confirmation is an explicit unconfirmed result. If changing a model, permission mode, or provider requires restarting, defer that change until a safe boundary and expose it on the card.

Template rendering must use the destination format: literal text for messages, quoted substitutions plus `PROMPTBOARD_*` environment values for scripts, percent encoding for URL fields, and JSON-safe substitution for JSON bodies. Preserve unknown automation variables visibly. Validate script limits, webhook methods and retry policy, and notification outcomes at the service boundary. The existing local token, origin checks, and text-only output rendering continue to apply.

## Implementation sequence and acceptance checks

Each step must be pushed as a separate pull request, reviewed, and tested locally and in GitHub CI before merging. Tests use disposable repositories and simulated CLIs. Required live adapter checks use a disposable project and must distinguish simulation from verified provider behavior. A passing suite establishes the tested behavior; it cannot establish the absence of every possible defect.

1. **Session foundation and migration.** Add logical session records, native resume, suspended/orphaned states, and process-run links. Preserve existing tasks, branches, artifacts, overrides, and unfinished checkout changes. Test restart recovery, user pause persistence, resume IDs, and clean shutdown. Bump the state schema when old readers cannot safely interpret the new model; retain backup import compatibility.
2. **Column lifecycle and configuration.** Replace fixed stage semantics with roles and strategy. Add configurable order, creation/removal, plan targets, and continuity across active moves. Test moving a busy agent without killing it, settings changes at a safe boundary, queued moves to the latest destination, To Do reset, archive/restore, and same-column reorder. Cleanup tests must cover uncommitted and local-only committed work.
3. **Automations and prompt boundary.** Add all four automation types, enter/exit order, row switches, copying, retries chosen by the user, templates, run records, and the Column Manager editor. Test first prompt versus continuation, a silent column, initial readiness, deferred delivery, plan continuation, restore message suppression, failure without wedging a move, cancellation, and duplicate requests. Test script quoting with adversarial task titles and webhook idempotency.
4. **Task and archive UI.** Add task numbers, metadata, attachments, strategy choices, archive table, bulk restore, and visible session/queue states. Test keyboard navigation, both themes, narrow screens, attachment handling, and safe rendering of agent output. Remove stage-confirmation wording that incorrectly suggests every move ends the conversation.
5. **Profiles and shared configuration.** Add named sparse profiles, task override exclusivity, repository/local configuration, file reconciliation, and backup round trips. Test inherited/cleared/set values, unknown references, occupied removed columns, profile deletion, local automation replacement, and importing config without running it.
6. **Backlog, imports, memory, and activity.** Add backlog operations and the named import adapters, structured transcript viewing/search, and provider activity reducers. Test promotion through the common arrival path, duplicate imports after archive, bulk partial failure, project isolation, incremental indexing, disabled memory, permission waits, background work, and stale signals.

The first end-to-end milestone is a task moving Planning → Executing → Code Review → Testing → Merge without manual retyping, preserving the conversation where the strategy permits. Completion must archive it; restoration must recover its context. A configured message must be observable in the delivery log, and an unconfigured move must introduce no hidden stage prompt.

## Decisions for migration

The [completed pipeline table](pipeline-completed-tasks.md) adds inert title filtering and keyboard title/archive-date sorting, retained-context visibility and exact latest reported usage, with old card actions preserved. [Bulk restore](pipeline-bulk-restore.md) now adds selection-ordered common transitions with task/settings revisions, individual outcomes, scoped stop and no automatic retry after unknown responses. Bulk deletion, complete per-session telemetry/cost/change summaries, expired-context warnings and archive search remain pending.

The [column automation runtime](pipeline-runtime-automations.md) now integrates exit/lifecycle/enter scripts and webhooks, authenticated receipts/Stop, exact metadata, verified workspaces, queued FIFO holds and task-scoped no-replay recovery. State version 6 preserves version 5 pipeline configuration and native sessions with an original backup. The [action editor](pipeline-automation-editor.md) now provides script/webhook switches, ordering, copying, draft deletion, scoped Stop and escaped durable results. The [browser notification receiver](pipeline-notifications.md) now provides explicit permission, scoped display acknowledgements and no-replay loss/cancellation. Explicit retries and native message scheduling remain pending.

The [asynchronous message journal](pipeline-message-journal.md) now prepares durable scheduler handoff separately from native delivery, including one dispatch grant and post-placement interruption recovery. It preserves version 1 records and keeps board state version 5. Actual session scheduling, receipt display, explicit retries and enabling rows remain pending.

The [native message receipt reader](native-message-receipts.md) prepares private pre-submission checkpoints and exact new-turn evidence for Claude, Codex and both Gemini history formats. It distinguishes Claude queue acceptance from a conversation turn and revokes uncertain, stale or cancelled evidence. The [Supervisor ownership integration](native-message-custody.md) binds checkpoints to live processes, main hook history, native identity and terminal input epochs; [exact Codex discovery](codex-history-discovery.md) now includes earlier conversation dates. The [owned initial input](initial-prompt-ownership.md) consumes a queued paste before human input, prevents delayed Enter from submitting a changed human draft and contains unknown transport failures without replay. The [private terminal observations](terminal-input-observation.md) now track bounded paste-mode/control and manual-input evidence per owned process, close with its terminal and stay out of public state. They do not grant readiness or delivery. Persistent verified history locations, native readiness/scheduling, durable delivery updates and board/editor integration remain pending; enabled agent-message rows remain refused.

The [automation coordinator](pipeline-automation-coordinator.md) now prepares ordered row dispatch, aggregate exit deadlines, independent cancellation, progress metadata and strict message callback outcomes. Its optional asynchronous enter handoff verifies exact durable intent before completing placement, keeping native delivery separate and refusing lost save acknowledgements. It does not select/start native sessions or provide readiness/confirmation; the board still refuses enabled message rows and native scheduling remains pending. Script/webhook/notification editor integration is available as described above.

The [durable automation journal](pipeline-automation-journal.md) now prepares atomic move/action intent, ordered exit/lifecycle/enter grants, webhook attempt receipts and dead-owner interruption recovery. It now serves journaled script/webhook board execution and scoped startup recovery. Native scheduling and explicit retry/delivery UI remain pending.

The desired new-project default is the column-driven behavior described above. Existing projects currently depend on mandatory review/test gates, stage-specific prompts, and Autopilot. Proposed migration: preserve their saved settings under an explicit legacy workflow policy, and let users convert a project to the new model without running work during conversion. Whether that legacy policy should remain user-visible is a product choice.

Kangentic's documentation contains older descriptions in some supporting chapters. Use the current [Columns and automations](https://www.kangentic.com/features/workflows/) and [Board configuration](https://www.kangentic.com/guide/board-config/) pages for current automation and move semantics. “Advanced” is a navigation label on board configuration and activity detection, rather than a separate requested feature chapter. Verify provider flags against each CLI's official documentation during adapter implementation.

Implementation status: the session registry, version 4 migration, and native Pause/Resume are merged. The compatibility change enables writing-stage CLI tool inheritance alongside Base delivery. The [pipeline configuration foundation](pipeline-configuration.md) supplies pure validation and sparse strategy resolution. The [prompt/template foundation](pipeline-prompts.md) preserves Composer text inside the first-spawn envelope and supplies bounded, single-pass substitution for automation destinations. The opt-in [main-session lifecycle](pipeline-lifecycle.md) now integrates silent first input, compatible live moves, Done suspension/native restoration, To Do session reset with files retained, role-based Column Manager editing, and version 5 migration. The [activity observation checkpoint](pipeline-activity.md) separates outstanding work from process status and records genuine native plan approval evidence. The [queued destination checkpoint](pipeline-queue.md) retains FIFO while retargeting waiting runs and parks agents on arrival in manual columns. The [live settings checkpoint](pipeline-live-settings.md) waits for current native turn completion and settled observations before same-provider settings/Base handoffs, with revision checks and explicit Stop/Pause cancellation. The [native approved-plan checkpoint](pipeline-native-plan.md) routes verified main Claude/Gemini approvals through the configured column/profile target, preserves live implementation and native permissions, and records one durable attempt with cancellation/recovery guards. Codex remains an explicit move. The [automation execution primitives](pipeline-automation-actions.md) now provide bounded scripts, webhook retries and notification outcomes, and the [column runtime](pipeline-runtime-automations.md) integrates scripts/webhooks with durable journaling and scoped cancellation/recovery. The [action editor and results](pipeline-automation-editor.md) expose scripts/webhooks, ordering/copying and scoped Stop. The [browser notification receiver](pipeline-notifications.md) integrates Notify me editing, explicit browser permission, exact display acknowledgements, scoped clicks and no replay after loss. The [board profile editor and task choices](pipeline-board-profiles.md) add guarded sparse profile editing, exclusive task pins, effective next-run display and portable v5 selection round trips. The [reviewed repository configuration](pipeline-repository-configuration.md) applies bounded shared/personal definitions with stable identity, whole automation replacement and exact source/project revisions, without dispatch. Previously applied repository sources now have selected visible-board change detection and a fresh-review banner that preserves saved settings and drafts. Automatic export/application, retained ghost columns and live profile propagation remain pending. Pipeline [title-only authoring](pipeline-task-authoring.md) now keeps optional descriptions through edits, copies and inert backups while preserving legacy required bodies and exact Composer inputs. Native message scheduling, explicit retries, provider handoff, advanced session strategies, cleanup, and the remaining steps are pending. The existing contract still describes the current stage workflow; this document must not be described as completed parity.
