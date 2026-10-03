# Base implementation map

## Follow-up audit and agent cards (2026-10-02)

Reference checkout: main `652666e`. The audit found stale editor revisions after MCP discovery/source refresh and replacement of standalone sources during live refresh. Regression tests cover both connection outcomes, retained drafts, mixed sources, and distinct knowledge identities.

The existing sidebar now owns Base categories; `public/base.js` renders category-specific browsing and reusable profile cards with equipped resources. Profile references expand through the shared resolver; nested profile references become native subagent entries where the adapter supports them. `base-context.mjs` prepares pinned native prompts and captures them, and `agents.mjs` passes bounded session-scoped Claude `--agents` JSON without changing permission modes, hooks, workspaces, or Supervisor ownership. Required incompatibility blocks runs, including per-run provider changes. Empty Replace still opts out.

`src/base-avatar.mjs` owns explicit OpenAI Images drafts, with the existing server claim/track/cancel/shutdown seams. Avatar bytes are validated PNG/JPEG and persist inside immutable content, outside state metadata. Protected content loading is separate from library metadata. Credentials are environment references only; image generation never starts a task, invokes Compose rewriting, or automatically saves/assigns a profile. Exporting content is required to export avatar bytes. The state schema remains version 3; existing migration behavior is unchanged.

Coverage adds category/editor behavior, profile resource cards, image drafts/save/import/export/cancellation/credential redaction, native profile resolution and adapter arguments, actual fake-CLI PTY delivery, and authenticated Chrome interactions. Authenticated image and provider calls are not part of deterministic tests.

Baseline: the clean local `main` checkout is `06a89c03355d4b71530280db5556a5bf876bac02`, newer than the architectural reference. Development uses an isolated checkout. Existing conventions are plain DOM/hash navigation, JavaScript ES modules, Node 22+, Node tests, jsdom, and the existing Chrome smoke harness. Baseline check/test results are recorded below as they finish.

## Integration order and ownership

1. **Registry and migration** — `src/base.mjs` uses the existing `board.store`; `src/store.mjs` explicitly migrates version 2 before corruption recovery. Immutable resource definitions and document content live under the data directory's `base/` folder. Publish content before its metadata reference. Preserve the original migration backup and refuse unknown newer versions without modifying them.
2. **Portable execution** — `src/base-resolver.mjs` is the shared pure preview/execution resolver. `Board.transition()` preflights before handoff/commit; the common `Board.#startRun()` resolves the final provider, checks revision changes, and records the manifest with the queued run. `Supervisor.#launch()` prepares pinned content through `src/base-context.mjs`, before the existing `composeMessage()` / `buildSession()` / PTY path. No new scheduler or task-text rewriting.
3. **Universal assignment** — independent Base fields survive provider inheritance: `settings.baseBinding/agentProfileId`, project `baseBinding/agentProfileId/baseColumns[columnId]`, and task `baseBinding/baseColumns[columnId]`. Column entries contain `binding` and an optional profile reference; task-column entries contain only bindings. Stable IDs preserve renaming/reordering. Profile defaults participate at their existing global/project/column scope; explicit same-scope provider tuples override them. Packs cannot nest or contain profiles. Bulk changes are serialized and revision checked.
4. **Native delivery** — `src/base-mcp.mjs` uses a maintained MCP client for explicit trusted connection tests/discovery. Adapter changes stay in `src/agents.mjs`, retain lifecycle hooks and permission restrictions, and use run-scoped configuration outside Git worktrees. Official documentation and installed CLI help establish supported mechanisms. Instruction/context delivery works through existing messages; command recipes are instructions, not newly registered tools. MCP delivery is blocked in restricted Planning/Review stages. Unsupported adapters stay unsupported. Ambient CLI configuration is disclosed where isolation is not enforced.
5. **Knowledge and portability** — bounded Markdown/text sources, lexical search/capture with hashes/provenance, explicit external-root approval, safe fetch/import, editable wiki pages, and optional wiki drafts through the server's existing restricted generation job slot (never Compose's rewrite pipeline). Base exports remap references and include bodies only by explicit choice. Board backups remain portable and defer imported execution settings for confirmation.
6. **Interface and regression** — isolated `public/base.js` initialized explicitly by `app.js`; register the static asset. Explicit Compose/Kanban/Base page state at `#/base`, page titles, navigation accessibility, start-page preferences, Back/Forward, and existing terminal state. Reuse one picker in global/project/workflow/custom/task/profile settings; run details distinguish configured, supplied, and observed. Metadata loads separately from document bodies and respects existing stale-board guards.

## Persistence and safety contracts

- `state.base` holds a Base-specific revision, lightweight resource metadata, and approved roots. Target Base revisions are independent of run polling and task text revisions.
- Resource definitions have stable IDs, immutable revision references, dependencies, and distinct enablement/trust/validation/connection status. Credentials are environment references only; no resolved credentials enter prompts, manifests, exports, or diagnostic responses.
- Layer order: Global → Project → Column → Task → Task-column. Inherit keeps upstream; Extend adds then excludes; Replace discards upstream, including profile resources. Expand packs before exclusions, deduplicate stably, and validate dependencies without silently re-adding exclusions.
- Queue acceptance pins definition revisions and assignment origins. Launch checks current revocations while retaining pinned content. Capture live sources at launch with a timestamp/hash. Cancellation, failed starts, and shutdown clean up only the affected run's preparation.
- Existing host/origin/session-token protections cover every Base endpoint. No import/save/assignment starts a CLI, installs software, changes agent permissions, or modifies user CLI/project configuration.

## Verification map

- Registry/store tests: version-2 migration, primary and backup recovery, future versions, write failures, immutable revisions, graph validation, deletion protection, import/export remapping, atomic bindings.
- Resolver tests: provider inheritance, profile defaults, required/optional dependencies, pack exclusions, empty Replace, custom/task-column targets, revocation and independent scopes.
- Execution tests through existing fake CLIs/PTY seams: exact task text, evidence, hooks/long prompt, concurrent isolation, pinned queues, preparation cancellation/rollback/cleanup; direct, transition, Autopilot, and internal launches.
- Server tests: authenticated/bounded endpoints, wiki job coordination/cancellation/stale revisions, safe sources/imports, credential redaction, backup portability.
- jsdom and existing Chrome smoke tests: third-page routing/start-page/accessibility, assignment forms and editors, supplied manifests, uninterrupted terminals, narrow screens and themes. Deterministic local MCP fixtures require no external service or account.
- Required checks: `npm run check`, `npm test`. Simulated tests do not establish authenticated live-provider compatibility. Record any skipped checks and actual limitations explicitly.

## Results

Baseline `npm run check` passed. Baseline `npm test`: 252 tests, 251 passed, 1 failed, 0 skipped (135.6 s). The pre-existing `Task saves ignore repeated submits and Split retries only unsaved cards` jsdom test failed on a missing button at `tests/ui.test.mjs:2312`; focused and final full runs passed with its assertions unchanged.

Final local verification on 2026-10-02, macOS with Node 26.8.2:

- `npm run check`: passed for all source and test JavaScript.
- `npm test`: **336 passed, 0 failed, 0 skipped**, 110.0 s. This includes the existing real Chrome smoke harness with simulated providers, new Base UI/registry/server/delivery/backup suites, deterministic local stdio and Streamable HTTP MCP fixtures, and the existing application regressions.
- Chrome exercised resource creation, assignment, actual fake-CLI delivery and pinned manifests, navigation while a terminal remained connected, and light/dark layouts at 1280 px and 390 px. The screenshots were visually reviewed.
- `npm audit --omit=dev --audit-level=moderate`: **0 vulnerabilities**. `git diff --check`: passed.
- Failure-path verification includes concurrent runs, queued revision pinning and revocation, cancelled preparation, shutdown timing, post-spawn persistence failures, owned-process cleanup, rollback completion, and continued queue progress. An existing subprocess fixture now publishes its readiness file atomically; asynchronous rollback tests wait for completion without weakening their assertions.
- CI exposed Windows' requirement for a writable backup handle when flushing to disk; migration now opens the preserved copy without truncating it. Exact-byte preservation and recovery assertions remain intact. All test servers and GUI child processes use disposable data folders, including background polling, and fake cancellation/layout checks wait for explicit readiness. The final full run left the existing application state file unchanged.

The [delivery matrix and limitations](base-delivery.md) describe Claude, Codex, and Gemini instruction/context and run-scoped MCP mechanisms. No authenticated live-provider request or paid model call was made. Gemini retains its existing `notLiveVerified` status; Antigravity remains unavailable for Kanban. Instruction skills/command recipes are not native tool installation, MCP tool references expose their parent server, Codex ambient MCP configuration is not isolated, observed invocations are not inferred, and source extraction is limited to supported text/Markdown files. GitHub CI separately checks supported Node 22 and 24 on Linux, macOS, and Windows.


## Category navigation follow-up

The canonical `Base.list()` metadata collection supplies exactly All, Agents, Packs, MCPs, Skills, Knowledge, Context, Tools. New definitions persist explicit `type`; `agent` maps to the existing internal `profile` kind. Older stored kinds supply their explicit compatibility type without rewriting immutable revision hashes or introducing a second agent registry. The state schema remains version 3; existing version-2 migration and recovery remain unchanged.

`public/base.js` derives results from one collection plus validated category/search/availability/sort/Grid-or-List preferences in one browser preference key. All operations keep the existing editor, assignment picker, persistence and authenticated API. Categories do not fetch or navigate. Counts ignore search and filters; collection refreshes use a request generation guard and the existing Base revision guard. Loading/failure/retry affect only results. Detail return restores the results scroll; category selection resets it. The same eight-button navigation lives in the desktop sidebar and moves to one horizontally scrolling strip at 600px or less.

jsdom covers exact types/order, defaults/restoration, shared AND filters, sorting/view preservation, contextual creation, count changes, empty/search actions, detail scroll, keyboard focus and out-of-order equal-revision responses with failure/retry. Chrome checks every category against actual server metadata, saved edits/reload restoration, zero category refetches and 1280/850/390px layouts, including mobile active-button visibility. Existing Chrome terminal-session tests remain intact. The package has no separate TypeScript, lint or build command; `npm run check` validates JavaScript syntax and `npm test` exercises the supported runtime/interface.


Follow-up verification on 2026-10-02: `npm run check` passed; `npm test` passed **356/356**, 0 failed, 0 skipped (121.3s). Real Chrome exercised all eight categories, edits/deletion and durable counts, preference restoration, no category refetches, mobile scrolling and 1280/850/390px layouts; desktop/mobile screenshots were visually inspected. The existing headless cancellation fixture now atomically publishes its readiness JSON, fixing a truncated-read race with cancellation/cleanup assertions unchanged (focused CLI tests: 2/2). Registry/UI focused checks: 39/39. No paid image request or authenticated native-subagent delegation was made; image and provider behavior was tested with injected fixtures/fake CLIs. No separate typecheck/lint/build scripts or dependency changes were introduced.
