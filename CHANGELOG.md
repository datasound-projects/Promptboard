# Changes

## Unreleased

- Add a Backlog destination picker and revision-checked promotion API for chosen columns using the existing arrival lifecycle. Capture destinations for single/bulk operations, preserve published cards and report failed arrivals without replaying promotion; initial creation skips To Do exit actions. Older servers retain To Do-only promotion.

- Add Backlog multi-selection and ordered To Do promotion or confirmed deletion, retaining hidden selections and captured revisions. Stop unstarted requests on cancellation, project/view changes, conflicts or unknown replies; report each result without replay or agent work.

- Add a separate Backlog view with keyboard draft editing, shared label/priority filters and title/prompt/label search, filtered full-list ordering, sorting, explicit deletion and atomic Add to To Do. Preserve Composer routing, exact prompt bytes and stale-write guards; expand completed search to descriptions and labels. Bulk/active-column promotion and imports remain pending.

- Add inert local backlog drafts with independent revisions, shared labels/priorities and atomic promotion into To Do through normal task creation. State version 11 and portable version 9 retain exact text and original migration backups. Backlog UI and active-column/import integrations follow separately.

- Add a shared board/completed label filter with All labels, Unlabeled and project definitions. Combine priority/search, retain hidden tasks and archive selections, and reset removed/invalid label preferences without agent work.

- Add keyboard task-label checkboxes, a shared name/color editor and readable badges on active/completed cards and task details. Keep nested card drafts, stale revision guards and exact prompts; hide unsupported controls on older servers.

- Add project-shared label definitions, custom hex colors and task assignments through revision-checked metadata APIs. Preserve prompts, Base, pending messages and agent configuration; keep copies and portable backups consistent. State version 10 preserves an exact original migration backup. Label UI and backlog integration follow separately.

- Keep deferred column messages queued while their owned agent waits for a slot or finishes its current work. Give the later native attempt a fresh bounded budget; preserve FIFO, Stop, target rechecks, human-input guards and no replay after uncertain outcomes.

- Share keyboard priority filters between pipeline boards and completed tasks, with per-project browser preferences and visible/total counts. Keep saved task metadata, order and agent execution inert; translate explicit filtered keyboard moves and card drops to complete-column positions so hidden cards remain intact.

- Queued Usage dialog close events preserve focus on subsequent project actions and reopened dialogs while normal closing still returns to Usage.

- Retain keyboard focus on the same card action when background board updates replace its DOM. Keep open menus and the existing confirmation/display focus behavior, so a refreshed card can still open task settings with Enter.

- Add an opt-in disposable Codex busy-queue check with bounded native-turn evidence, exact follow-up confirmation and real offline PTY coverage. Verify the default Tab queue behavior separately from steering, preserve manual-input guards and report both replies and cleanup without enabling automatic immediate delivery.

- Save task priority separately from prompt content, with keyboard pipeline editing and labeled card/archive badges. Preserve exact Composer prompts, content checks, task order and agent execution; migrate state to version 9 with exact original backups and export portable version 7 metadata. Custom levels and backlog integration remain pending.

- Make the opt-in disposable Claude live check wait for a settled folder-trust screen and verify the current positive selection before Enter. Preserve manual-input guards and separate trust warmup from fresh-process delivery; never confirm a stale or reset negative answer.

- Release native message scheduler capacity after known completion, retaining a bounded recent-completion cache and durable replay protection. Keep uncertain owners and blocked-run barriers intact so long-running boards can deliver more than 1,000 messages without restarting.

- Default newly created/opened app projects to the empty seven-column pipeline. Keep saved and imported stage boards unchanged, retain explicit legacy creation for integrations, and reject invalid workflow choices before filesystem changes. Composer and split tasks still enter To Do without starting agents.

- Enable configured deferred Send message to agent rows on active-column entry, keeping the same task conversation and Composer/Base input. Add capability-aware editing, delivery receipts and task-scoped Stop after placement completes. Persist pending references independently of history, migrate state to version 8 with exact backups, and recover interrupted delivery without replay. Add an opt-in actual-column live check; immediate/exit/slash delivery and full Kanban parity remain pending.

- Do not report successful board-data migrations as corruption. Show damage warnings only for quarantined files and distinguish recovery of a missing board from a backup; preserve saved projects and tasks.

- Add a private deferred enter-message scheduler that acknowledges durable handoff before queued startup/input, reserves per-run invocation FIFO, rechecks exact target/configuration custody and bounds cancellation/unknown saves without replay. Board/HTTP/editor activation, exit messages and busy/immediate delivery remain pending.

- Capture private native-message task/session/run custody with content, configuration, Base and workspace rechecks. Keep compatible active moves on the same target, learn queued native identity once, and refuse changed/replaced targets before input. Use this check in the disposable smoke harness; actual column scheduling remains pending.

- Render `{{taskNumber}}` as the saved `#N` identity across automation/custom spawn templates and `PROMPTBOARD_TASK_NUMBER`. Leave missing/malformed numbers empty without positional fallback; preserve numeric API/webhook fields and the exact default first task envelope.

- Add an opt-in disposable private native-message smoke harness with bounded option validation, separate startup/native/durable-receipt reporting and owned-process cleanup. Test the exact harness offline with a simulated CLI and record the authorized live Codex confirmation and Claude startup limitation separately. Column-message scheduling remains pending.

- Display saved task numbers on board/completed cards and in archive/edit/details metadata. Add exact `#number` lookup to the completed-task filter, retain literal title filtering otherwise and omit invented positional numbers on older servers. Preserve task titles, copied prompts and keyboard actions.

- Retain native-message process custody during valid hook publication while blocking input and confirmation on pending hooks. Drain hooks arriving during receipt reads before durable confirmation. Report outer deadlines separately from explicit cancellation, keep attempted writes uncertain and never replay input. Column scheduling and enabled message rows remain pending.

- Allocate stable project-local task numbers atomically across Composer creation, duplication and browser migration. Retain numbers through moves/archive/restore and never recycle deleted numbers. Migrate state to version 7 with an exact original backup; portable version 6 exports preserve numbers/counters and older backups remain importable. Number display remains a separate UI step.

- Refresh the short dark-mode Compose, Kanban and Base demos with the current interface, including task settings, sidebar project setup, explicit file editing and linked knowledge pages. Simplify the GitHub social preview around all three pages and add its repeatable renderer.

- Move Kanban project settings into the project sidebar and keep the board at full width. Use one compact disclosure for repository, target branch, project agent and workflow controls; hide redundant project selection, shorten repository status and collapse backup actions while preserving keyboard and phone navigation.

- Store repositories created through New project under `~/Promptboard/projects` by default, with `PROMPTBOARD_PROJECTS_DIR` override support. Keep projects opened from existing local folders at their original absolute paths and explain both locations in the interface.

- Expand Compose Task Type coverage for agentic coding with feature, integration, UI/UX, data, security, dependency, CI/CD/infrastructure and workflow-automation guidance.

- Add neutral, documentation, testing, migration and performance Task Type choices to Compose, with distinct prompt guidance and history restoration support.
- Scope each Kanban file tree to its selected project folder, including folders inside a parent repository; give newly created projects their own repository. Add explicit editing/saving with draft preservation and disk-conflict checks, plus an optional tool-disabled single-file AI proposal panel with review, cancellation and explicit Save. Keep project agents, Git actions, Compose and Base independent.

- Connect queued journal receipts to private owned deferred input with exact scope/preflight checks, per-run FIFO and durable confirmation before releasing input. Preserve live queue tails during cancellation, use atomic queued-only outcomes and retain unknown acknowledgements as blocked ownership without replay. Keep column scheduling, live provider readiness and enabled message rows pending.

- Prepare private deferred native-message transport bound to one live pipeline process, exact native history and strict durable callback acknowledgements. Preserve literal Unicode, consume dispatch IDs once, cancel changed ownership/input before Enter, bound hanging callbacks and keep unknown writes sticky without clearing drafts or retrying. Block Stop-based completion during pending/unknown submission; column scheduling, immediate delivery and enabled message rows remain pending.

- Move CLI connection/status/sign-in controls from Compose's More settings into the top-bar CLI dialog. Manage accounts independently of Compose's CLI/model selection, preserve pending sign-in through close/reopen, and keep model feedback beside generation controls. Retain installation guides and privacy help.

- Observe bracketed-paste mode, incomplete controls and manual input privately per owned pipeline process. Bound metadata, close observations on Stop/exit and create fresh state on native resume, without dispatching input or enabling pending message rows.

- Restore selected pipeline archive tasks through the common move path with captured task/settings revisions and individual outcomes. Preserve selection order across filtering, prevent duplicate groups, stop unstarted requests on stop/close/project changes, and keep lost responses reviewable without replay. Advertise server support to hide bulk controls on older processes; retain old-style moves and exact-ID idempotency. Bulk deletion remains pending.

- Consume a queued initial prompt before nonempty human terminal input, including failed writes and input before startup. Clear paste timers so later startup events cannot append and submit the task into a human draft; retain empty/rejected-input behavior, exact Composer/Base artifacts and CLI tools.

- Make Compose grounding's main toggle authoritative, with deliberate legacy preference migration and one cancellable preparation/generation snapshot. Use relevant supplied guidance for simple and multilingual tasks, distinguish reference repositories from confirmed targets, share duplicate lookups without changing question IDs, and resolve questions only from retained quoted findings. Preserve provider errors, refresh mutable local context and keep existing UI, generation/review, limits and no-default-deadline behavior.

- Browse completed pipeline tasks in a filtered table with keyboard title/archive-date sorting, retained conversation state and exact latest reported usage. Preserve old card actions, refresh focus and project scoping; use archive dates after task edits and retain the common restoration lifecycle without dispatching from browsing. Bulk operations and complete telemetry summaries remain pending.

- Add read-only project file trees to the Kanban Workspace sidebar, with lazy folder expansion, checkout/task-worktree selection and centered file viewers. Preserve multiple files, minimized viewers, scroll and expansion during refresh. Display UTF-8 code with lexical highlighting and line numbers; bound reads and directory pages, refuse traversal/symlinks/credentials and never start agents or mutate board/repository state. Report observed updates without inventing per-file agent activity.
- Allow title-only tasks in opt-in column pipelines, preserving empty or supplied descriptions through editing, copying, restart and portable backups. Keep new tasks in To Do without agents, retain legacy required bodies, and refine a title-only draft through Composer using its title. Native first input uses the existing escaped task envelope and CLI/Base delivery.

- Run Chrome fixture files sequentially after the other tests, preserving scenario/file deadlines and failure exit codes. Keep non-browser concurrency at two; avoid concurrent renderer/PTY/Git fixture work during full verification.

- Detect changes to previously applied repository board sources with bounded, read-only polling for the selected visible Kanban project. Offer a fresh review; preserve saved settings, exact Composer text, Base, sessions and open drafts. Reject stale project/source responses, report unreadable files without their contents, and clear the banner on source recovery. Automatic export/application and retained ghost columns remain pending.

- Remove default Compose model and browser generation deadlines across autonomous research, draft/review/repair and task splitting. Preserve Cancel, process cleanup, explicit programmatic deadlines and bounded optional-source retrieval. Invalid optional planning falls back to the original task with a warning. Align detailed prompt, split and verification size bounds; test all provider/settings combinations and long-running browser states.
- Accept Codex's reported `max` effort and classify its account/model rejection explicitly. Disable ambient Codex MCPs/apps/plugins/hooks per generation invocation without altering CLI defaults or credentials. Track cancelled Compose provider cleanup through shutdown.
- Keep accepted shutdown cleanup alive through its bounded outcome on Node 22, and prevent a cancelled split's late response/error from overwriting a replacement split.

- Prepare asynchronous enter-message coordinator handoff: verify exact durable journal intent before releasing placement, keep native delivery receipts separate, and stop on lost outcome acknowledgements without replay. Preserve exit confirmation, manual/restore suppression and Composer/Base/CLI delivery. Actual native scheduling, readiness and enabled message rows remain pending.

- Add explicit reviewed application of repository `promptboard.json` and personal overrides to opt-in pipelines. Preserve stable identities and sparse profiles; replace personal automation groups as a unit. Recheck bounded file/root custody and exact review/project revisions; retain paused-agent, automation and occupied-column guards without dispatching or changing Composer/Base. Automatic file synchronization and retained ghost columns remain pending.

- Add named sparse board-profile editing, exclusive task profile/agent choices and effective card agents. Keep shared columns/automations/Base intact; save with revision and paused-agent guards without starting work or changing Composer text/checks. Retain choices on copy and portable v5 backup/import with dispatch disabled. Live profile propagation and repository configuration remain pending.

- Bind delayed initial prompt paste/Enter to the owned PTY, input epoch and native identity. Human drafts revoke automatic Enter; Stop/Pause/failure/replacement and pending input block stale writes/checkpoints. Contain unknown transport writes without retries or raw errors. Verify exact long Composer envelopes, Base instructions/MCPs and inherited tools in a disposable simulated CLI PTY.

- Add Notify me column editing and explicit browser notification opt-in. Authenticate bounded receiver streams and task-scoped display receipts; preserve unconfirmed outcomes on loss, scoped cancellation and no automatic replay. Alert clicks open the exact task without agent actions. Tests use mocked desktop APIs in disposable browsers; native message delivery and explicit retries remain pending.

- Find older resumed Codex histories by exact thread metadata in bounded canonical date folders, with strict UTF-8/header checks, symlink refusal and unavailable outcomes for ambiguous/reverted/compressed rollouts or incomplete searches. Keep paths private and preserve read-only receipt custody, Composer/Base/CLI delivery and process behavior.

- Add pipeline script/webhook row editing, switches, ordering, copying and draft deletion to Column Manager. Preserve disabled message definitions and invalid header drafts; saving runs nothing. Show task-scoped Stop and durable per-row/lifecycle results in Details, with escaped content and revision-aware polling that preserves focus. Keep native messages and explicit retries pending.

- Keep pipeline permission waits scoped to their agent and exact tool when available. Unrelated or late tool results and parent lifecycle boundaries cannot dismiss another agent's dialog. Uncorrelated native notifications await their own lifecycle boundary; bound registries and unknown subordinate waits retain uncertainty. No permission decisions or terminal messages are injected.

- Integrate durable exit/lifecycle/enter script and webhook execution on opt-in pipeline moves, with exact metadata, verified workspaces, delayed fresh startup, queued FIFO holds, scoped cancellation and no-replay recovery. Preserve Composer/Base/CLI delivery, migrate state 5 to 6 with its original backup, omit move grants from portable backups, and add authenticated receipt/Stop endpoints. Message scheduling and explicit retries remain pending; later steps expose editor/display controls and browser notification reception.

- Bind read-only native message checkpoints to Supervisor process ownership, observed native identity, main hook history and terminal-input epochs. Revoke stale evidence on partial drafts, startup, Stop/Pause, exit, failure or uncertainty. Keep private paths out of run updates; terminal scheduling, durable receipt display and enabled rows remain pending.

- Revoke prior native plan approval and ended activity on a main SessionStart. Preserve outstanding work, uncertain observations and finished-tool guards so startup cannot invent readiness or rearm late old approvals; subordinate starts cannot reset the parent.

- Prepare journal version 2 asynchronous enter-message receipts: complete scheduled dispatch separately from delivery, grant native dispatch once, retain submission/queue/confirmation stages, and recover unfinished delivery after completed placement without replay. Preserve version 1 synchronous records and refuse active delivery cancellation until owned work is stopped and recorded. Keep runtime scheduling, receipt UI and enabled rows pending; board state stays version 5.

- Prepare read-only native message receipts with private pre-submission checkpoints, exact new-turn matching, distinct Claude queue acceptance, input/cancellation guards and bounded Claude/Codex/Gemini history formats. Reject changed, malformed or uncertain evidence without retrying input. Keep terminal scheduling, asynchronous receipt persistence and board integration pending.

- Prepare ordered automation groups with durable dispatch grants, configuration/metadata guards, a sixty-second exit budget, independent task cancellation, strict message acknowledgements and retained ownership of scripts whose termination is unconfirmed. Refuse incomplete group replay. Keep runtime/session/editor integration pending and enabled rows unavailable.

- Keep accepted automation/action/message deadlines referenced until completion so pending callbacks receive their bounded outcomes on Node 22 without an external keep-alive handle. Clear owned timers on completion and verify standalone notification timeout in a subprocess.

- Prepare the durable automation move journal with atomic revision publication, stable request/action identities, ordered exit/lifecycle/enter grants, persisted webhook attempts and dead-owner interruption recovery. Refuse replay after unknown outcomes or corrupt/newer records. Keep enabled rows unavailable until runtime and message scheduling are integrated; no board or state-schema changes.

- Make Merge and Base pack UI fixtures await completed requests and saved results before asserting. Keep intentionally pending discovery tests bounded. Increase the test runner's file budget to five minutes so Node 22 can finish the growing UI file; retain explicit scenario deadlines and concurrency two.

- Prepare bounded script/webhook/notification execution primitives with native shell files, exact task metadata, owned process-tree cancellation, retry/idempotency handling and explicit unconfirmed notification outcomes. Keep automation rows unavailable until durable move journaling and session message delivery are integrated; no board behavior changes in this step.

- Route verified main Claude/Gemini native plan approvals to the current column/profile's configured target, with a durable one-attempt record and visible pending/failure states. Keep compatible live implementation and native permissions without injecting a prompt. Concrete model/effort/Base changes wait for a verified boundary and resume the exact conversation with an implementation continuation; Stop/Pause, superseding plans and restart cannot replay the action. Add the plan target selector; Codex remains an explicit move. Keep Composer input and Base/CLI tool inheritance intact.

- Resume same-provider live pipeline settings/Base changes at an observed native turn boundary, preserving the exact conversation and worktree without replaying task text. Invalidate readiness on terminal input, recheck events and committed task/settings before signalling, revoke stale leases, and let explicit Stop/Pause cancel the handoff. Distinguish system suspension from user pause and retain the original process/card on timeout or pre-stop conflicts.

- Retarget waiting pipeline runs to their latest destination provider/model/permissions/Base without losing FIFO position. Hold the slot during atomic acceptance, reject already-preparing launches and cross-provider native resumes, and never resurrect a cancelled entry. Manual columns now park queued/live agents while preserving context for explicit Start.

- Add pipeline activity observations separate from process status: track native tools/subagents, background/scheduled-work counts and permission waits, retain explicit provider coverage, and require turn-end evidence before a quiet-output readiness gate. Subordinate events cannot finish/fail their parent. Record genuine native plan approval evidence without advancing cards yet; omit raw tool results, commands and scheduled prompts from lifecycle logs. Legacy hooks and Composer/Base behavior remain intact.

- Add an opt-in main-session column pipeline in Column Manager. Stable roles replace stage-name actions: compatible live moves preserve the process without hidden prompts/commits/tests/merges; Done suspends and archives, active restoration resumes the native conversation without task replay, and To Do stops/resets its session while retaining files. Preserve Composer entry and Base/CLI tool inheritance. Migrate state to version 5 without reconstructing version 4 sessions; pipeline backups restore with dispatch disabled. Guard unsupported automation/advanced strategies and incompatible live settings changes until subsequent checkpoints. Legacy boards retain their original workflow.

- Add pure pipeline prompt/template rendering: task envelopes preserve Composer text and Markdown whitespace, attachment paths follow the envelope, and substitutions never re-expand task content. Distinguish literal messages, encoded URL/JSON values, and stripped script substitutions with exact `PROMPTBOARD_*` environment values. Runtime stage prompts remain unchanged until lifecycle integration.

- Add the pure column-pipeline configuration foundation: stable role-based columns, silent seven-column defaults, plan targets, sparse strategy profiles, exclusive task-wide agent pins, isolated conversation policies, and bounded definitions for the four automation types. Runtime integration remains pending; this checkpoint does not alter existing projects or run automations.

- Kanban writing stages inherit user-configured CLI tools, MCPs, and extensions alongside Base delivery on fresh starts and native resumes. Preserve native permissions, administrator settings, read-only stage restrictions, and Composer's existing adapters; do not edit CLI configuration files.

- Kanban Pause and Resume: preserve the native conversation, worktree, and run history while stopping an owned CLI process. Resume the same stage with saved permissions and pinned Base configuration, recheck revocations, and avoid repeating task text. Serialize concurrent requests, retain pause intent across restart, and stop a CLI that reports another conversation ID. Queued runs without a native ID require a fresh start. Cross-column continuity remains a later step.

- Kanban session foundation: persist logical conversation records separately from process runs, including native provider IDs and artifact references. Migrate state versions 2 and 3 to version 4 with an exact original backup; preserve Composer task text and Base. Concurrent startup reads share recovery, and orphaned sessions never relaunch automatically. Existing stage behavior is retained; native resume and column continuity are subsequent steps.

- Simplify the README around Compose, Kanban, and Base; replace the demos with dark-mode recordings under 12 seconds and add a reproducible Base demo.

- Base uses exactly eight local category filters over one library, with persistent search, availability, sort and Grid/List, canonical counts, contextual Add, accessible mobile scrolling, and result-area retry with stale-response protection.
- Base sidebar: move categories out of the content area and make each selection update the collection, heading, empty state, and creation type. Preserve unrelated editor drafts while browsing another category.
- Agent profiles: reusable cards with equipped-resource indicators, profile references, and native Claude Code subagents for writing stages. Pin and capture subagent instructions/resources through the existing runner; retain selections and report unsupported provider/stage combinations without changing permissions.
- Agent avatars: explicit AI illustration drafts via OpenAI Images, preview/save, protected image loading, content-aware export/import, and scoped cancellation. API access is optional and uses server environment credentials; no CLI login credentials are collected.

- Fix Base editing after MCP discovery and source refresh: reload persisted revisions and captured text, including failed discovery results, so subsequent saves and retries remain valid. Guard unsaved drafts and overlapping saves during these operations.
- Fix Base source refresh preserving pasted/uploaded content while replacing only managed live captures. Knowledge pages from different collections retain distinct source identities.

- Base: add the global **Compose | Kanban | Base** navigation and an optional local library of instruction skills, MCP connections, Markdown wikis, context rules, command recipes/discovered MCP tool references, agent profiles, and packs.
- Base assignments: reference resources across global, project, built-in/custom-column, task, and task-column scopes, with inheritance, exclusions, replacement/opt-out, effective previews, and atomic multi-target application. Profile selection remains an explicit agent configuration action; assignments never launch work.
- Base delivery: pin immutable definitions with accepted runs and prepare resources through the existing Supervisor. Supported writing-stage MCP configuration is scoped per run; portable instructions/context preserve the exact task prompt and existing evidence. Run details distinguish configured resources, supplied captures, warnings, and observed invocations. Read-only stages retain their restrictions, and queued delivery rechecks trust/access revocations.
- Base knowledge and portability: local text search, editable linked wiki pages, bounded source imports/refresh, optional reviewed wiki drafts through the existing restricted runner, validated SKILL.md imports, explicit MCP discovery tests, and versioned import/export with fresh reference mappings. Document bodies require an explicit export choice. Imported resources remain inactive/untrusted and do not import filesystem approval.
- Persistence: explicitly migrate state version 2 to 3 with a retained pre-migration backup; fail safely on migration errors and preserve newer formats. Portable board backups use their separate version 3 and still accept supported older formats. Resource deletion protects references and retains historical immutable revisions.
- Verification: new deterministic registry, migration, resolver, lifecycle, MCP fixture, source-containment, wiki coordination, backup, and browser coverage. Simulated CLIs and local MCP fixtures do not establish authenticated live-provider compatibility; see `docs/base-delivery.md` for supported combinations and limits.

- Usage: add a minimal dashboard beside Settings with one-minute refresh, local per-model tokens and tool counts, 30-day charts, native Codex allowance, and reported Claude status-line allowance/cost. Unavailable and stale metrics are explicit; credentials and transcript text are never returned.

- Fix: delete inactive or completed cards even when worktrees are dirty or missing. Card deletion keeps files and branches, records retained worktree locations, and removes Autopilot queue references atomically. Active runs still require stopping first.
- Kanban sidebar: compact project actions and rows, quieter selection and agent information, no decorative footer or pulsing indicators.

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
