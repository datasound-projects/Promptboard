# Network implementation progress

Overnight, unattended implementation of the Promptboard Network feature (owner request, 2026-10-26).

- **Branch:** `feat/network`, worktree `.claude/worktrees/network`, cut from `origin/main` 67aff01. Never pushed, merged or force-pushed by this run.
- **Specification:** `docs/network/NETWORK_REQUIREMENTS.md` (copy of the owner's file). Task files: `/Users/kingogboss/Downloads/Promptboard_Network_Claude_Tasks/tasks/NN-*.md` (identical to the sections of `/Users/kingogboss/Downloads/Promptboard_Network_Implementation_Plan.md`).
- **Order:** strictly 01 → 14. A task starts only after the previous one is implemented, tested and committed.
- **Run rules:** one implementation agent per task; the coordinator reviews the diff, reruns the task's tests and the full suite, and checks every acceptance criterion with evidence before the next task. Isolated app instances only (ports 4900+, temporary data folders, a PATH holding only node plus fake CLIs unless a bounded live smoke test is explicitly logged here). Never touch the owner's app (port 4318, `~/Library/Application Support/Promptboard`, `~/Promptboard/projects`, `~/Desktop/promptboard-github`).
- **Live provider runs:** bounded opt-in smoke tests only, cheapest models, each one logged below with provider and result.

## Rules every task agent follows

1. Read `docs/network/NETWORK_REQUIREMENTS.md`, the task file, `docs/network/architecture.md`, `docs/network/acceptance.md` and this file before coding. The architecture decisions (storage under `<data>/network/`, headless read-only job workers, owner routes under `/api/network/*`, separate machine listener, NDJSON streams, §14 conflict choices) are binding unless a task proves one wrong; then document the change in architecture.md.
2. Commit locally only (message "Network: …" with the Co-Authored-By trailer), explicit paths, never push/merge/rebase/stash/force; CHANGELOG.md only in Task 14.
3. Match the codebase: dense ESM, plain DOM JS, no TypeScript/build step/framework; reuse durable.mjs, Base resolver, providers/research-cli, server.mjs handle(), remote-access localOnly, dom.js and app api(). New code in `src/network/` and `public/network*.js`; minimal wiring in shared files. New npm dependencies only as exact pinned versions at least two weeks old, license and advisories checked.
4. Security and data: every route behind handle(); computer-only routes in localOnly; no secrets anywhere persistent or returned; untrusted input stays data; fail closed; saving/editing/importing never executes; old data folders load unchanged; nothing deleted automatically.
5. Isolated app instances only (port 49NN for task NN, temporary data folders, PATH with only a node symlink plus fakes). Never touch the owner's app on 4318 or its folders. Headless Chrome via tests/helpers/browser.mjs only.
6. Paid CLI runs only within the budget a task prompt gives, cheapest models, each logged under "Live provider runs".
7. Tests: `tests/network-*.test.mjs` (browser: `*-browser.test.mjs`), every behaviour with a failing-without test, cross-platform rules (path.join, CRLF, no fixed ports, no real CLIs/network/Docker, injectable clocks, no `main` assumption, no exact page width). Run `npm run check`, new tests twice, touched modules' tests, then the full `npm test` (log in `$TMPDIR/network-logs/task-NN-suite.log`).
8. Update this file (row + "Task NN" section) and commit it with the task's last commit.

## Parallel waves (owner request, 2026-10-26 ~10:50)

The owner asked for three agents at a time. Remaining work runs in dependency-respecting waves, each agent on its own
branch from the same verified base, merged by the coordinator in order, then integrated and fully tested:

- **Wave A:** 07 (local worker runtime), 08 (events and Activity), 09 (pipeline compiler and runner). Contracts: architecture §17.
- **Wave B:** 10 (pipeline designer), 11 (private REST and MCP), 12 (delegation, messages, schedules).
- **Wave C:** 13 (A2A federation) with a review of 06–12; then 14 (final verification and release).

## Status

| Task | File | Status | Commit |
|---:|---|---|---|
| 01 | 01-audit-and-contracts.md | done | 27646ef |
| 02 | 02-registry-and-storage.md | done | 7771788 |
| 03 | 03-network-page-and-agent-profiles.md | done | 9edf549 |
| 04 | 04-agent-memory-and-feed.md | done | 1fc58b6 |
| 05 | 05-graph-designer-and-subnetworks.md | done | 47447fc |
| 06 | 06-general-purpose-job-engine.md | done | d49d064 |
| 07 | 07-local-worker-runtime.md | done (merged, wave A) | a6aab88 |
| 08 | 08-live-activity-and-observability.md | done (merged, wave A) | 4d275e7 |
| 09 | 09-pipeline-dag-engine.md | done (merged, wave A) | 018a2fd |
| 10 | 10-pipeline-designer-and-network-run-ui.md | done (lane; in `feat/network-wave-b` 96987d8, merge here pending) | 6bc96d1 |
| 11 | 11-private-api-and-mcp.md | done (lane; in `feat/network-wave-b`, merge here pending) | a1d6642 |
| 12 | 12-delegation-and-triggers.md | in progress (lane `feat/network-12`) | |
| 13 | 13-a2a-federation.md | in progress (lane `feat/network-13`) | |
| 14 | 14-verification-and-release.md | pending | |

**Next:** Wave A integrated (730c862, cd8f5f6; full suite clean twice). Running: Task 12 and Task 13 lanes and the
Phase-2 review fixes (Tasks 06–11, 1 P2 + 10 P3) on `feat/network-wave-b`; then wave-b → 12 → 13 merge here, an
integration pass, the full suite, and Task 14.

## Live provider runs

Every real (paid) CLI run, in order. Five in all so far.

| When (UTC) | Task | Provider | Model / effort | Purpose | Result |
|---|---|---|---|---|---|
| 2026-10-26 10:25 | 07 | Codex CLI | CLI default, effort low | one job end to end, usage fields (R1) | completed in 7 s (details in "Task 07") |
| 2026-10-26 10:25 | 07 | Claude Code | haiku | one job end to end, usage fields (R1) | completed in 5 s |
| 2026-10-26 10:25 | 07 | Gemini CLI | CLI default | one job end to end | failed `CLIENT_UNSUPPORTED` (provider refused the client); not retried |
| 2026-10-26 11:07 | wave A integration | Codex CLI | CLI default, effort low | pipeline step "Benefit" (two parallel steps → join → output) | completed, exit 0, 5.5 s, `partial-tools`, usage reported |
| 2026-10-26 11:07 | wave A integration | Codex CLI | CLI default, effort low | pipeline step "Risk" (the parallel branch) | completed, exit 0, 5.5 s, `partial-tools`, usage reported |

## Task log

(Each task adds a section: changes, files, tests and results, acceptance evidence, known issues, commit.)

### Task 01 — Audit current code and freeze integration contracts (2026-10-26)

**What was done.** Read the requirements, the task files 01–14, README, SECURITY.md, the listed docs and the code paths
the later tasks touch (`server.mjs`, `store.mjs`, `durable.mjs`, `board.mjs` run/backup paths, `supervisor.mjs`,
`agents.mjs`, `providers.mjs`, `research-cli.mjs`, `base*.mjs`, `session-activity.mjs`, `usage.mjs`, `lessons.mjs`,
`coordinator.mjs`, `remote-access.mjs`, `schedules.mjs`, `public/app.js` routing, `public/index.html`,
`tests/remote-access.test.mjs`). Checked npm for the candidate dependencies and inspected their published tarballs in a
throw-away folder (removed afterwards; nothing installed). Wrote the two contract documents. No runtime source, test or
existing file format was changed.

**Files.** `docs/network/architecture.md` (new), `docs/network/acceptance.md` (new), this file.

**Key decisions** (details and `file:line` evidence in architecture.md):

- Storage: every Network entity in its own versioned file under `<dataDir>/network/` through `src/durable.mjs`
  (atomic write + `.bak`, set-aside of damaged files, newer version refused, `serial()` + CAS). Nothing in
  `state.json` (stays version 14) and nothing in board backups (stay version 12); a separate Network export/import.
- Execution: Network jobs do not use Board/Supervisor (that would need a spoofed card, run record and worktree) and do
  not take the shared one-job CLI slot. They run on the existing headless adapters (`streamResearch` for Claude/Codex,
  `runProvider` for tool-less Gemini; Antigravity refused) in an empty per-attempt folder, read-only, optional web
  search only, with their own pool (default 2, 1–4). Two small shared changes later: optional usage parsing in
  `research-cli.mjs` and an optional `layers` argument for `resolveBase`; sign-in waits for Network jobs.
- Completion only from a structured final result plus exit 0; anything else is failed/unknown; a crash after launch is
  `interrupted`/uncertain and is never retried without the owner.
- Routes: owner `/api/network/*` behind the unchanged `handle()` checks; paired devices allowed except credential,
  listener and federation-trust routes (local-only); external clients only on a separate, off-by-default loopback
  listener with scoped bearer tokens (SHA-256 at rest); MCP as a stdio bridge to that listener; A2A inbound/outbound
  separately switched, with an SSRF-guarded `fetchImpl`.
- Event stream as NDJSON over fetch (token stays in a header), not `EventSource`.
- Dependencies: `cytoscape` 3.34.3 (MIT) served from `/vendor/`, with a CSP-safe stylesheet placeholder;
  `cytoscape-edgehandles` rejected (needs a global lodash, unmaintained since 2021); `@modelcontextprotocol/server`
  2.3.1 (matches the installed client/core 2.3.1); `@a2a-js/sdk` 1.3.0 (A2A protocol 1.0, no Express needed). Each is
  at least two weeks old; the newer `cytoscape` 3.34.4 and MCP 2.4.0 are too new.
- 14 requirement/HEAD conflicts listed with the chosen option (architecture.md §14).

**Existing Network implementation:** none (no `src/network/`, no `/api/network`, `#/network`, A2A or Cytoscape code);
`origin/main` is still `67aff01`, no remote branch named for Network.

**Baseline tests** (worktree HEAD `ade0233`, code identical to `origin/main` `67aff01`; log
`$TMPDIR/network-logs/task-01-baseline.log`, 2026-10-26 03:00–03:27, about 27 minutes):

- `npm run check`: pass ("All JavaScript files pass the syntax check.").
- `npm test` non-browser phase: 1,506 tests, 1,505 pass, 0 fail, 0 cancelled, 1 skipped.
- `npm test` browser phase (headless Chrome): 146 tests, 146 pass, 0 fail, 0 skipped.
- Total: 1,652 tests, 1,651 pass, 0 fail, 1 skipped. Exit code 0. No reruns were needed.
- The one skip is `tests/editors.test.mjs` "Windows: program folders, a JetBrains IDE … never a .cmd", which runs only
  on `win32`. Other `skip: process.platform === 'win32'` tests ran on this Mac. Chrome was available, so no browser test
  skipped. `npm test` contains no live-provider test: live checks are separate scripts (`scripts/live-*.mjs`,
  `npm run eval:live`) and were not run (zero paid CLI runs in this task).

**Acceptance criteria and evidence:**

- *Architecture identifies concrete existing integration points and files with evidence from HEAD:* architecture.md §2
  (table of 30 integration points with `file:line`), §7.1 (traced Kanban run path), §8 (capability matrix from
  `agents.mjs`/`providers.mjs`/`research-cli.mjs`), §12 (routing lines in `app.js`/`index.html`). Line numbers were
  re-checked against the files after writing.
- *Dependency/task map lists prerequisites and non-goals; no running systems or existing formats are modified:*
  architecture.md §15 (map, per-task prerequisites and non-goals, never-in-scope list), §4.4 and §11.4 (formats
  unchanged); `git show --stat 27646ef` touches only `docs/network/`; the owner's app on port 4318 was not touched.
- *Baseline tests recorded honestly, including failures and skipped live tests:* this section (counts above, the skip
  named, no live tests in the suite).
- *Explicit design for uncertain outcomes, authority, revocation, timeouts, migration and privacy:* architecture.md
  §6.1–6.3 (state machines with uncertain/interrupted handling), §11.1 authority, §11.2 revocation, §11.3 timeouts and
  uncertain outcomes, §11.4 migration, §11.5 privacy, SSRF and prompt injection; acceptance.md §6 failure and recovery
  matrix (37 rows).

**Known issues / open questions** (architecture.md §16): Base "Used by" does not list Network registrations; default
job concurrency 2 and timeout 20 minutes are guesses; workspace-write and repository-reading jobs are post-MVP;
whether the board backup should later embed the Network export; headless usage field names must be confirmed in the
Task 07 opt-in smoke.

**Next task: 02.**

### Task 02 — Durable agent and network registry (2026-10-26)

**What was done.** Agent registrations that reference Base `profile`/`agentProfile` resources by ID only, networks
(agent and sub-network nodes with positions, `message`/`delegate`/`share_result` relations) as a draft plus immutable
published versions, owner routes under `/api/network/*`, and a Network-only export/import. Base is read through
`board.base.list()` only; `state.json`, Base and the board backup format are untouched. No UI, no jobs, nothing that
starts a process.

**Files.** New: `src/network/storage.mjs` (NetworkError, IDs, versioned/immutable file discipline over
`durable.mjs`), `src/network/registry.mjs` (model validation, registry, cycle check, export/import),
`src/network/http.mjs` (routes), `tests/network-registry.test.mjs`, `tests/network-http.test.mjs`. Changed:
`src/server.mjs` (registry created in `startServer` with the server's data folder and Board's Base and project list;
route branch after the Coordinator; `NetworkError` in `EXPOSED`), `tests/remote-access.test.mjs` (every Task 02 route
in `ALLOWED`, `network/http.mjs` scanned), `docs/network/architecture.md` (§4.6 decisions), this file.

**Data layout** (created on the first save; reading creates nothing): `<data>/network/agents.json`
(`promptboard.network-agents` v1, `{ revision, rows }` + `.bak`), `network/networks/<escapeId(id)>.json`
(`promptboard.network-draft` v1 + `.bak`), `network/networks/<escapeId(id)>/v<n>-<sha256>.json`
(`promptboard.network-version` v1, written once, hash of the exact bytes checked on every read, never deleted).

**Routes** (all behind `handle()`; all allowed from a paired device per §10.2, none local-only, so `localOnly()` is
unchanged): `GET/POST /api/network/agents`, `GET/PATCH /api/network/agents/:id`, `GET/POST /api/network/networks`,
`GET/PATCH /api/network/networks/:id`, `POST /api/network/networks/:id/publish`,
`GET /api/network/networks/:id/versions/:n`, `GET /api/network/export`, `POST /api/network/import`. Lists take
`offset`/`limit` (1–200, default 50) and filters (`q`, `tag`, `capability`, `status`, `baseResourceId`, `projectId`,
`networkId` for agents; `q`, `agentId` for networks) and answer `{ total, offset, limit, next, … }`.

**Decisions** (architecture.md §4.6): body limits per route (a draft may be 8 MiB, so the 1 MiB default of §4.2 rule 8
does not apply to network and import bodies); disabled/untrusted Base agents can be registered and show as stale;
`POST /networks` takes no revision (no collection file); cycles are checked by network ID through pinned published
versions; a stored file that is not exactly what the registry writes counts as damaged; export refuses while a draft
is unreadable; import writes registrations, then versions, then drafts.

**Tests** (all with temporary data folders, no CLI, no network):

- `tests/network-registry.test.mjs` 13 tests: reference-only registration with `state.json` and Base revision
  unchanged; Base edit shown, `agents.json` unchanged; missing/wrong-kind refused, disabled/untrusted/deleted stale
  and kept; concurrent row and collection CAS; draft → v1 → edit → v2 with v1 bytes unchanged; cycles self, A→B→A,
  A→B→C→A and through an old pinned version; strict content; restart; damaged `agents.json` with good and bad
  backup, newer version; unreadable and hand-edited drafts; tampered version hash; export/import identical, remapped,
  and refused whole (unknown or non-agent Base ID, tampered hash, missing reference, cycle, newer file, extra field,
  wrong kind of file); filters, paging, no folder on read.
- `tests/network-http.test.mjs` 3 tests: missing token, wrong Host, foreign Origin, cross-site, proxy header all 403;
  413, 415, 400, 404; a full owner flow over HTTP, then a new `startServer` on the same folder showing the same IDs,
  revisions, scopes, drafts and versions; every file outside `network/` (state.json, its backup, Base revisions,
  Origin project), the board backup, Base and Origin byte-identical before/after; a `child_process` recorder (proven
  to see processes started inside `src/`) records zero processes; a paired device calls every Task 02 route.
- `tests/remote-access.test.mjs`: route table now includes all 12 Task 02 rows and scans `network/http.mjs`; removing
  a row makes it fail (checked).
- Mutation check: patching out the cycle check, row CAS, disabled-on-import, agent remap, unresolved-Base refusal,
  set-aside, damaged refusal, newer refusal, hash check, kind check or the version file name each makes a test fail.
- Runs: `npm run check` pass; new tests twice 16/16 and 16/16; touched modules (`server`, `base-avatar`, `base-backup`,
  `base-delivery`, `base-fixes`, `base-profiles`, `base-registry`, `base-server`, `base-ui`, `remote-access`,
  `durable`) 157/157 (log `$TMPDIR/network-logs/task-02-touched.log`).
- Full `npm test` (log `$TMPDIR/network-logs/task-02-suite.log`, 2026-10-26 03:53–04:19): non-browser 1,522 tests,
  1,521 pass, 0 fail, 0 cancelled, 1 skipped (the same win32-only `editors.test.mjs` test as the baseline); browser
  146/146. Exit 0, no reruns. Baseline 1,506 + the 16 new tests = 1,522.
- Isolated smoke on port 4902 (temporary data and projects folders, PATH holding only a `node` symlink): `GET
  /api/network/agents` answered an empty page, no token 403, an unknown Base ID `BASE_PROFILE_INVALID`, a created
  network appeared as `network/networks/net__….json`; instance stopped and folder removed.

**Acceptance criteria and evidence:**

- *Register existing Base Agent without copying or changing Base definition:* registry test 1 (stored row keys are
  exactly the Network fields, no Base text in `agents.json`, `state.json` bytes and Base revision unchanged); HTTP
  test 2 (every non-Network file byte-identical).
- *Stable `agentId` survives restart; edit of Base is reflected as a reference, never cloned:* registry tests 2 and
  "a restart"; HTTP test 2 (new `startServer`, same responses).
- *Save draft vs published revisions; existing published versions remain unchanged:* registry "a draft saves and
  publishes" (v1 bytes and hash identical after edit and v2) and "a published version whose bytes no longer match".
- *Cyclic subnetwork composition is rejected; no save starts a worker:* registry cycle test; HTTP test 2 (self-cycle
  over HTTP, zero recorded processes across save, publish and import; no job code exists).
- *Legacy boards, Base records, backups and projects load unchanged:* HTTP test 2 (board created before Network,
  board export, Base and Origin answers and file hashes equal before, after and after a restart).

**Known limits.** `providerCapabilities` and Base "Used by" for registrations are not computed (Task 03 / open question
1). One queue serializes the whole registry, and the first read loads every draft sequentially (`ponytail:` notes).
Import body ceiling 32 MiB. A crash during an import's writes can leave disabled registrations or unreferenced
version files (nothing runs). No delete routes yet (Task 05 adds network delete; registrations are disabled instead).
Paid CLI runs: 0. The only app instance outside the tests was the port 4902 smoke above.

**Next task: 03.**

### Task 03 — Network page and agent profiles (2026-10-26)

**What was done.** `Network` is the fifth page (`Origin · Compose · Kanban · Base · Network`, `#/network`) with the same
routing quality as the others: nav `aria-current`, document title "Network · Promptboard", skip link, sidebar panel and
labels, start-page option, back/forward, and a phone layout. The page has the six-section tablist (Agents, Graph,
Pipelines, Activity, Library, Federation); only Agents works, the other five are marked "soon" and say "Not available
yet." with one sentence on what they will do and no controls. The Agents section is a directory filled from
`GET /api/network/agents` (search; Role, Provider, Capability and Status filters, all server-side; "Show more" paging)
beside the chosen agent's profile; a phone shows the list, then the profile. "Register agent" picks an existing Base
Agent or Agent profile (from `GET /api/base`) and sets the Network identity (display name, tags, capabilities, projects,
enabled); "Edit identity…" changes it; a switch enables/disables the registration; "Open in Base" opens the real
resource in Base's own editor. The profile shows the Network ID, Base kind/name/revision, provider/model/effort, Base
state and use count, tags, capabilities, projects, networks, the instructions preview, the provider capability matrix
(unknown where unknown) and the allowed operations, plus Tasks/Activity/Memory tabs that say they are not available
yet. Empty, loading, error (with Retry), stale and revision-conflict (with Reload) states are explicit. Nothing on the
page starts a job, a run or a model call, and it calls only the app's own API.

**Files.** New: `public/network.js` (the page module, `window.PromptboardNetwork.create`), `tests/network-ui.test.mjs`,
`tests/network-browser.test.mjs`. Changed: `public/index.html` (nav link, `#network-sidebar-panel`, `#network-view`,
start-page option, script), `public/app.js` (`currentPage`, `showPage`, sidebar label, skip link, start page,
`networkView` creation with `api`, `projects`, `ensureBoard`, `openBase`; scroll kept between Network sub-routes),
`public/styles.css` (Network section; top-bar breakpoints for five links), `src/server.mjs` (`/network.js` asset),
`src/network/registry.mjs` (provider capability matrix, instructions preview, Base use count, `kind`/`provider` filters,
`facets`), `src/network/http.mjs` (the two query keys), `tests/network-registry.test.mjs` (one test),
`tests/helpers/ui-harness.mjs` (evaluates `network.js` like the page does), `tests/ui-3.test.mjs`,
`tests/browser.test.mjs`, `tests/origin-browser.test.mjs` (five nav links), `tests/app-fixes-browser.test.mjs` (top bar
at the new breakpoints, all five pages), `docs/network/architecture.md` (§5 computed fields, §10.1 row 03, §12.1), this
file.

**Routes and fields.** No new route. `GET /api/network/agents` also takes `kind` (`profile`|`agentProfile`, the "role")
and `provider` (`claude`|`codex`|`gemini`|`agy`) and answers `facets: { capabilities }`. Agent views add
`providerCapabilities` (`{ provider, known, jobTools, toolEvents, waitingEvents, readOnly, webSearch, sessionId, usage,
dockerSandbox, liveVerified }`, values `yes|partial|no|unknown`), `base.instructions` (`{ summary ≤280 redacted, chars }`)
and `base.usedBy` (count). Decisions (role = Base kind, Open in Base through the existing `openResource` seam, sidebar
section links, conflict handling, top-bar breakpoints): architecture.md §12.1.

**Tests** (temporary data folders, no CLI, no network beyond the local test server):

- `tests/network-ui.test.mjs` 6 tests (jsdom, real server): (1) five nav links, only `#network-view` shown, title,
  `aria-current`, skip link, sidebar label and panel, tablist state; every other page opens (Base loads, Compose works);
  back/forward through Kanban, Base, Graph and an agent profile; (2) start page Network only without an explicit route;
  (3) the rows are the server's registration IDs; Role, Provider, Capability (from `facets`), Status and search each
  narrow the list and are sent to the server; filtered empty state and Clear filters; a registration made elsewhere
  appears on the next visit; (4) empty state → Register (only Base agents and agent profiles offered) → stored fields,
  focus on the new profile; Edit identity (Base agent not changeable, focus back on Edit); disable and enable (focus
  stays on the switch); Base revision and every resource unchanged; Open in Base lands on Base's editor for `lead`;
  Back returns; the request log holds only GETs plus `POST/PATCH /api/network/agents*`, no generate/run/job/research
  URL, zero runner calls, zero runs; (5) damaged `agents.json` + backup → error with Retry; disabled and deleted Base
  agents show Stale with their reason, Open in Base disabled with the reason when the resource is gone, capabilities
  unknown; a conflicting change → switch reverted, message, Reload; the same in the edit dialog without overwriting;
  (6) section and profile tablists with ArrowRight/Left, Home, End (wrap); unavailable panels hold no controls; every
  input/select is labelled and every button named, tabs and panels reference each other; Escape closes the dialog and
  returns focus; every visible enabled button in the list and profile views changes the route, view, focus or a dialog
  (a disabled one carries a reason).
- `tests/network-browser.test.mjs` 1 test (Chrome): light and dark; at 1440 px the list and profile sit side by side
  with no sideways scroll; at 390 px the list and toolbar only, a real tap shows the profile only (focus on its
  heading), Back returns focus to the row; theme colours differ; ArrowRight/Left with a visible focus ring; Enter opens
  Register, Escape returns focus; Open in Base and Back in a real browser; no exception or CSP message. With
  `PB_NETWORK_SCREENSHOTS=<folder>` it saves its screenshots.
- `tests/network-registry.test.mjs` +1: role and provider filters (an agent profile counts as its primary agent's
  provider), invalid filter values refused, facets ignore filters, the capability matrix per provider and all-unknown
  for no provider (not shared with callers), the instructions preview (agent's then profile's text, 280 characters,
  a credential masked), Base use count, a deleted resource.
- Existing tests changed only where they pinned four nav links (`ui-3`, `browser`, `origin-browser`) or the old top-bar
  breakpoints (`app-fixes-browser` now checks 320–735 px on all five pages and the theme toggle at 735 px).
- Mutation check (`$TMPDIR/network-logs/task-03-mutations.log`): removing the nav link, the route, the start-page value,
  the kind/provider filter or query keys, the facets, the capability matrix, the preview redaction, the conflict Reload,
  the stale note, Escape, focus return, tab arrows, the `openBase` seam, the asset registration, the phone or
  side-by-side CSS, or either top-bar breakpoint change, or making the edit dialog send a Base field (refused by the
  server), each makes its test fail (20/20).
- Runs: `npm run check` pass; new tests twice: 23/23 non-browser and 1/1 browser, both times
  (`$TMPDIR/network-logs/task-03-new-twice.log`); touched files `ui`, `ui-2`, `ui-3`, `project-explorer-ui`,
  `remote-access`, `sandbox-ui`, `base-*`, `server` 281/281 (`task-03-touched.log`) and `app-fixes-browser`, `browser`,
  `origin-browser`, `remote-access-browser`, `sidebar-resize-browser`, `base-profiles-browser`, `network-browser` 33/33
  (`task-03-touched-browser.log`); `compose-operation`, `kanban-audit` 11/11.
- Full `npm test` (log `$TMPDIR/network-logs/task-03-suite.log`, 2026-10-26 05:02–05:30): non-browser 1,529 tests,
  1,528 pass, 0 fail, 1 skipped (the win32-only `editors.test.mjs` test); browser 147 tests, 146 pass, 0 fail,
  1 cancelled: `kanban-focus-browser` "delayed usage dialog close events preserve subsequent project settings focus"
  hit its 60 s limit (load average about 4.7 during the run). Run alone it passed 3 times out of 3 and once more with
  `PB_CPU_THROTTLE=6` (`task-03-rerun.log`); it touches no Network code (Kanban project settings and the Usage dialog at 1280/390 px, where
  this task changed nothing but the fifth nav link). Exit 1 for that one test. Baseline 1,522 + 7 new = 1,529;
  146 + 1 = 147.
- Isolated instance on port 4903 (temporary data folder, fake detector and catalog, no runner) for the screenshots and
  the top-bar measurements (every width from 320 to 940 px fits); stopped and its folder removed each time.

**Acceptance criteria and evidence** (screenshots in `$TMPDIR/network-logs/task-03-screens/`, all looked at):

- *Network opens as a first-class tab; existing pages still work:* network-ui tests 1–2; the touched and full suites;
  `1440-light-detail.png`, `1440-dark-detail.png`, `390-light-list.png`, `390-dark-list.png`.
- *The UI can register and edit the Network identity of a Base agent, then navigate to the real Base resource:*
  network-ui test 4, network-browser (Open in Base, Back); `1440-light-register.png`, `1440-dark-register.png`.
- *Server data, not mocked static content, drives the directory:* network-ui test 3 (row IDs are the server's; a later
  registration appears; every filter goes to the server).
- *Keyboard/mobile/empty/error states are usable; no execution or network side effects from opening/editing:*
  network-ui tests 4–6, network-browser; `1440-light-empty.png`, `1440-dark-empty.png`, `1440-light-conflict.png`,
  `1440-light-stale.png`, `1440-dark-stale.png`, `1440-*-graph.png`, `390-*-detail.png`, `390-*-detail-lower.png`,
  `1440-*-detail-lower.png`; `browser-test/network-{1440,390}-{light,dark}-*.png`.
- acceptance.md Task 03 rows 1–8: rows 1–2 tests 1–2; row 3 test 3 + the registry test; row 4 test 4 + browser; row 5
  test 5 (+ test 4 empty state); row 6 test 6 + browser keyboard; row 7 browser; row 8 test 4's request log.

**Known limits.** Base's own "Used by" panel still does not list Network registrations (open question 1); Network shows
only Base's count. A Posts tab (Task 04), quick job submission (Task 06+) and real Tasks/Activity/Memory content wait
for their tasks. The Capability select lists capabilities of all registrations (facets), not of the current page only.
One page of the list is 200 rows; "Show more" adds the next 200. Network names on a profile are read per agent with
`?agentId=` (one request, at most 200 networks shown by name). The directory is read again each time the page is
opened, not pushed live; a change elsewhere while the page is open shows after Reload or the next visit. README is not
updated yet (release notes and README are Task 14). Paid CLI runs: 0.

**Commit.** 9edf549 (Task 03), then this log entry.

**Next task: 04.**

### Task 04 — Agent memory and profile posts (2026-10-26)

**What was done.** Private, scoped memory for a registered agent or a network, and the owner's reports on an agent's
profile. A memory record (fact, lesson, preference or procedure; text ≤ 4,000 characters) is proposed, then approved by
the owner; it can be edited (status kept, earlier text in its history), withdrawn/rejected, approved again or deleted.
Every change names the revision the owner saw, so a record changed elsewhere is never approved unseen (`409`). Search is
deterministic keyword matching. A pure resolver gives the exact memory block a future job of an agent would receive:
approved records of that agent, of a network it is a node of when the job runs in that network and asks for it, then the
project's approved Project Memory lessons only with an explicit permission and only for a project on the registration's
list; never another project's lessons, never an unapproved or foreign record, nothing for a disabled or stale
registration. The owner previews that block and why each part is in it or not. Reports are limited Markdown with source
references, labelled "Report · Written by you" and never shown as an event or a job. Project Memory (`src/lessons.mjs`,
`docs/project-memory.md`) and Base are not changed: lessons are read only through the unchanged `lessonsPrompt`. No job,
run or model call exists or starts.

**Files.** New: `src/network/memory.mjs` (`NetworkMemory`, pure `memoryAccess`/`memoryBlock`), `src/network/posts.mjs`
(`NetworkPosts`), `tests/network-memory.test.mjs`. Changed: `src/network/storage.mjs` (shared `only`, `requireRevision`,
`conflict`, `object`, `page`, `cleanText`, moved out of `registry.mjs`), `src/network/registry.mjs` (uses them; creates
`this.memory` and `this.posts`; export comment), `src/network/http.mjs` (routes), `public/network.js` (Memory and Posts
tabs, a "Memory" line under Allowed operations), `public/styles.css` (their styles; profile labels no longer restyle
Markdown headings), `tests/network-ui.test.mjs` (3 tests; the Task 03 tab assertion now expects working Memory/Posts),
`tests/network-browser.test.mjs` (1 test), `tests/helpers/ui-harness.mjs` (evaluates `markdown-view.js` before
`network.js`, as the page does), `tests/remote-access.test.mjs` (every new route), `docs/network/architecture.md`
(§4.7, §5 shapes, §10.1 row 04, §12.1 item 4), this file. `src/server.mjs` is unchanged (the registry owns both stores).

**Data layout** (created on the first save): `<data>/network/memory/agent-<escapeId(agt_…)>.json` and
`network-<escapeId(net_…)>.json` (`promptboard.network-memory` v1: `{ scope, revision, records }` + `.bak`),
`<data>/network/posts/<escapeId(agt_…)>.json` (`promptboard.network-posts` v1: `{ agentId, revision, posts }` + `.bak`),
all through `durable.mjs` with the Task 02 discipline (damaged copy set aside when the backup loads, no usable copy
`NETWORK_DATA_DAMAGED`, newer version `NETWORK_VERSION_UNSUPPORTED` and never rewritten, a record that is not exactly what
the module writes counts as damaged). Text is cleaned before saving (`cleanText`: CRLF, control characters, `noPaths`,
`redactLocal`). Ceilings: 4,000 characters per record (413), 500 approved / 1,000 records per scope, 20 history entries
per record, 8 MiB per memory file; a report 16 KiB in bytes (413), 2,000 per agent, 10 references × 300 characters.

**Routes** (behind `handle()`, all allowed from a paired device, none local-only): `GET/POST
/api/network/{agents|networks}/:id/memory` (`?q status offset limit`; propose with the scope revision),
`PATCH/DELETE …/memory/:mid` (record revision), `POST …/memory/:mid/approve` (`{ expectedRevision, decision:
'approve'|'reject' }`), `GET /api/network/agents/:id/memory/preview?projectId&networkId&memory=none|agent|agent+network&projectLessons=true|false`,
`GET/POST /api/network/agents/:id/posts`, `PATCH/DELETE /api/network/agents/:id/posts/:pid`. Task 07 calls
`registry.memory.resolve(agentId, request)` and puts its `text` into `prompt.md`.

**UI.** Agent profile tabs: Profile · Tasks (soon) · Activity (soon) · **Memory** · **Posts**. Memory: search (server
keywords) and status filter, counts, "Add memory…" dialog (kind, text, character count, what happens to it), each record
with kind and status chips, its text as text, "Written by you · approved … · revision n", Approve / Reject or Withdraw /
Edit… / Delete… (confirmation), and a native `<details>` history with earlier texts; then "What a job would receive":
project (marked when not on the agent's list), network (the agent's networks), "Allow the project's approved lessons",
a ✓/– list of why each part is in or out, the exact text and its size against 8,000. Posts: "Write a report…" dialog
(Markdown, sources one per line), each report as "Report · Written by you · time · edited", drawn by
`PromptboardMarkdown` (HTML shown as text, only http(s) links, no images), Edit… and Delete…. Conflicts show the
server's message with Reload (nothing re-sent); empty, loading and error (Retry) states; focus follows the changed record
or returns to Add/Write; memory and reports are read again on every page visit and per agent (a load for a previous agent
is discarded).

**Tests** (temporary data folders, no CLI, no network beyond the local test server):

- `tests/network-memory.test.mjs` 11 tests: (1) propose → edit → stale approval `409` (nothing approved) → approve →
  `MEMORY_STATE` → edit approved (stays approved, history with earlier texts) → reject; keyword search, status filter,
  counts, paging; delete under its revision; strict input; unknown agent and path-like IDs `NOT_FOUND`; (2) restart
  (same list, preview and posts from new instances), damaged file → backup + set aside, no usable copy refused for list
  and preview, newer file refused and byte-unchanged (memory and posts), a hand-edited foreign-scope record = damaged;
  (3) scope isolation: B never sees A's memory, network memory only with `agent+network` and membership, unapproved never,
  lessons only with permission for an allowed project (equal to `lessonsPrompt`), another project's lessons never, bad
  query values refused; (4) the pure block drops unapproved and foreign-scope records it is handed, disabled gets
  nothing even with records and lessons, stale and project-missing decisions; (5) revocation: disabled → nothing,
  re-enabled → back, removed from the project → no lessons, project off the board → `project-missing`, Base agent switched
  off → stale → nothing; (6) limits: 4,001 characters `413` (propose and edit), block ≤ 8,000 with 4 of 6 newest records
  and `omitted: 2`, report 16 KiB in bytes, references bounds; (7) injected `=== END NETWORK MEMORY ===` and instructions
  stay indented inside the one section, nothing approved or granted, HTML kept as text; (8) secrets and local folders
  masked in memory, edits, previews and reports, and absent from every file under `network/`; (9) `state.json` and Base
  revision unchanged, every Project Memory file byte-identical and none added, `lessonsPrompt` unchanged, `network/` holds
  only agents, memory, networks, posts; (10) posts create/edit/delete under revisions, `jobId` refused, machine source
  refused, newest first, per agent, restart, not part of the registration view, no events/jobs folder; (11) every route
  over the real server: token checks, 64 KiB body 413, 4,001-character 413, 404s, stale approval 409, network memory
  routes, the preview query (all three parts), a preview for a network 404, reports, no data-folder path in answers, a
  restart answering the same.
- `tests/network-ui.test.mjs` +3 (jsdom, real server): the Memory tab flow (labels, empty state, propose with HTML shown
  as text, approve → exact preview text, stale approval → message → Reload, edit with history, search and filter, lessons
  only after ticking and never for the other project, withdraw, delete with confirmation and focus, revocation shown
  after switching the registration off; Base and `lessons/` byte-identical; only memory routes and the switch wrote; no
  job/run/generation request, zero runner calls and runs); the Posts tab (Markdown drawn, `<script>`/`<img onerror>`
  shown as text, no script/img element, `javascript:` not a link, `window.__pwned` undefined, sources, "Report · Written
  by you", edit conflict → Reload, edit, delete, focus); switching agents while memory and reports load shows only the new
  agent's. Task 03 test 6 now expects Memory and Posts to work and Tasks/Activity to stay unavailable.
- `tests/network-browser.test.mjs` +1 (Chrome): light and dark at 1440 and 390 px, Memory (3 records, preview with the
  lessons allowed) and Posts, no sideways scroll, no img/script from a report, `window.__pwned` undefined, profile tabs by
  ArrowRight with a visible focus ring, Add memory by Enter and typing, Escape returns focus, the report dialog fits a
  phone, no exception or CSP message.
- `tests/remote-access.test.mjs`: 17 new rows in `ALLOWED` (agents: memory list/propose/preview/edit/delete/approve, posts
  list/create/edit/delete; networks: memory list/propose/edit/delete/approve).
- Mutation check (`$TMPDIR/network-logs/task-04-mutations.log`): 37 mutations, each makes a test fail (record and propose
  CAS, approved-only and scope filters in the block, allowlist, permission, disabled, stale, membership, `agent+network`,
  indentation, 8,000 budget, newest first, 4,000 limit, history text, already decided, strict stored record, delete,
  masking, writing into `lessons/`, `jobId`, report CAS, 16 KiB, preview route, network memory route, record text as
  HTML, report as HTML, both Reloads, approving with another revision, the lessons permission in the UI, the preview
  refresh after revocation, focus after an action, the renderer in the harness, the phone CSS, both loading resets).
- Runs: `npm run check` pass; new and touched Network tests twice on the final code: 54/54 non-browser
  (`network-memory`, `network-ui`, `network-registry`, `network-http`, `remote-access`) and 2/2 browser, both times
  (`task-04-new-twice.log`); touched modules `lessons`, `lessons-ui`, `remote-access`, `ui`, `ui-2`, `ui-3`, `sandbox-ui`,
  `project-explorer-ui`, `server` 189/189 and `lessons-browser`, `app-fixes-browser`, `browser` 14/14
  (`task-04-touched.log`, run before the last UI fix; the Network files were rerun after it).
- Full `npm test` on the final code (log `$TMPDIR/network-logs/task-04-suite.log`, 2026-10-26 06:09–06:36): non-browser
  1,543 tests, 1,542 pass, 0 fail, 0 cancelled, 1 skipped (the win32-only `editors.test.mjs` test); browser 148/148.
  Exit 0, no reruns needed. Task 03's 1,529 + 11 memory + 3 UI = 1,543; 147 + 1 = 148. (An earlier run was stopped
  before it finished because two UI fixes landed after it started; it is not counted.)
- No isolated app instance outside the tests was needed (port 4904 unused): the screenshots come from the Chrome test's
  own temporary server. Paid CLI runs: 0.

**Acceptance criteria and evidence** (screenshots in `$TMPDIR/network-logs/task-04-screens/`, all looked at):

- *Agent notes survive restart and are only retrieved within their allowed scope:* memory tests 2, 3, 4, 5, 11; UI
  "moving to another agent"; `memory-1440-{light,dark}.png`, `memory-390-{light,dark}.png`.
- *Approved Project Memory remains authoritative; Network neither re-suggests nor modifies it:* memory test 9 (files
  byte-identical, none added, same `lessonsPrompt`), test 3 (the block ends with exactly `lessonsPrompt`'s section), UI
  Memory test (`lessons/` byte-identical); `lessons*` tests unchanged and green; `docs/project-memory.md` and
  `src/lessons.mjs` untouched.
- *Owner can publish a report to the agent's private feed; posts are not mislabeled as verified tool events:* memory
  test 10, UI Posts test, Chrome test; `posts-1440-{light,dark}.png`, `posts-390-{light,dark}.png`,
  `post-write-390-dark.png`.
- *All published/injected context is bounded, attributable, redacted and previewable:* memory tests 6, 7, 8 and 3 (record
  lines with ID and scope), 11 (preview route); UI Memory test (exact preview text, reasons); `memory-preview-1440-{light,dark}.png`,
  `memory-preview-390-{light,dark}.png`, `memory-add-1440-dark.png`.
- acceptance.md Task 04 rows: 1 → memory tests 1, 11; 2 → tests 2, 3, 5; 3 → test 6 (413 with code `NETWORK_LIMIT`);
  4 → tests 7, 8 and the UI tests; 5 → test 9 and the lessons tests; 6 → test 10, UI Posts test, Chrome test.

**Known limits.** Network memory has routes but no screen yet (Graph/Library, Task 05); the agent's preview shows it.
Membership for network memory is the network's current draft (Task 09 may use the pinned version). The Network export
carries neither memory nor reports (§4.4 options not built). History keeps the newest 20 entries per record. One queue
for all memory files and one for all report files; a report file is rewritten whole on each change (≤ 2,000 × 16 KiB).
Job references on reports are refused until Task 06; machine-written reports wait for Task 11. Agent proposals of memory
(`source.kind: 'job'`) arrive with Task 07. The memory list and reports are read again per visit, not pushed live.

**Commit.** 1fc58b6 (Task 04), then this log entry.

**Next task: 05.**

### Task 05 — Graph designer and nested networks (2026-10-26)

**What was done.** Network → Library and Network → Graph work. The Library lists every network (search, Show archived)
and, per network, its draft revision, published versions newest first with the latest marked, where it is used (other
networks' drafts and published versions), the issues to fix and the network's own **Memory** (the Task 04 panel over the
existing `/api/network/networks/:id/memory` routes, without the job preview); it creates, renames, duplicates, archives,
restores and deletes networks, and exports/imports the Network file. Delete removes only a never-published network that
nothing contains; otherwise the button is disabled with the reason and the server refuses (`NETWORK_IN_USE` with where,
`NETWORK_PUBLISHED`); archive is offered instead and keeps every version readable and every pin working. The Graph edits
one draft on a Cytoscape canvas: add agents (registrations) and sub-networks (a pin `{ networkId, version }` of a
published version, never a copy), drag to place, typed relations (message, delegate, share_result) with own connect
controls (canvas Connect mode with two taps, or the keyboard form in the node details), disconnect, remove, undo, pan,
zoom, fit, grid and layered layouts on request, search, relation filter, collapse/expand of nested networks with lazy
reads of the pinned version, and a 1,000-node view cap with a notice. Save draft is one `PATCH` of the whole working copy
with the loaded revision (drags and layouts batched into it); a conflict overwrites nothing and offers "Load the saved
draft" or "Save mine as a new network"; leaving with unsaved edits asks (in-app navigation and tab close). Publish
writes an immutable version; the version chips `v1`, `v2 · latest` open a read-only view. The page says that saving or
publishing starts nothing and that a relation grants no permission, sends no message and shares no data. Beside the canvas
the Nodes and Relations lists and the details panel do everything by keyboard; at 390 px there is no canvas, only the
lists and then one node's details. Nothing here starts a job, a run or a model call.

**Dependency.** `cytoscape` **3.34.3** (published 2026-09-07, MIT, no dependencies), `npm install --save-exact`; `npm
audit`: 0 vulnerabilities. Package 5.7 MB unpacked; the served `dist/cytoscape.min.js` is 435,503 bytes (136,854 gzip).
Served by exact path `/vendor/cytoscape.min.js` from `node_modules` (the vendor map now resolves from `node_modules/`;
the xterm entries gained their `@xterm/` prefix) and loaded by `index.html` with `<script defer>` (architecture §13). The CSP
is unchanged: Cytoscape's one `<style>` rule is in `styles.css` and `<meta id="__________cytoscape_stylesheet">` in
`index.html` tells it so; the Chrome test proves no `<style>` element is inserted and no CSP message appears. No
`cytoscape-edgehandles`. Licence text added to `THIRD_PARTY_NOTICES.md` (checked by `tests/cli.test.mjs`).

**Files.** New: `public/network-graph.js`, `tests/network-graph.test.mjs`, `tests/network-graph-ui.test.mjs`,
`tests/network-graph-browser.test.mjs`. Changed: `src/network/registry.mjs` (archive flag, `networkDetail` with refs,
issues and uses, duplicate, delete, version refs, cycle message with the fix), `src/network/http.mjs` (DELETE, duplicate,
`archived` query, detail route), `src/server.mjs` (`/network-graph.js`, `/vendor/cytoscape.min.js`), `public/network.js`
(routes `#/network/{library,graph}/<id>[/v<n>]`, the guard, Graph and Library available, error `details`, the Memory panel
for a network too), `public/index.html` (Cytoscape script and placeholder, `network-graph.js`), `public/styles.css`,
`package.json`, `package-lock.json`, `THIRD_PARTY_NOTICES.md`, `tests/helpers/ui-harness.mjs` (evaluates
`network-graph.js`), `tests/network-ui.test.mjs` and `tests/network-browser.test.mjs` (Graph and Library are no longer
"soon"), `tests/remote-access.test.mjs` (2 rows), `docs/network/architecture.md` (§4.5 note, §4.8, §5, §10.1 row 05,
§12.2, §13), `docs/network/acceptance.md` (test file names), this file.

**Routes.** New: `DELETE /api/network/networks/:id` (`{ expectedRevision }`), `POST /api/network/networks/:id/duplicate`
(`{ name? }`). Changed: `GET /api/network/networks?archived=true`; `PATCH /api/network/networks/:id` takes `archived`;
`GET /networks/:id` and every create/update/publish/duplicate answer `{ network, refs, issues, usedBy, usedByUnknown }`;
`GET …/versions/:n` answers `{ version, refs }`. All behind `handle()`, allowed from a paired device, listed in
`tests/remote-access.test.mjs`. Decisions: architecture §4.8 and §12.2.

**Tests** (temporary data folders, no CLI, no network beyond the local test server):

- `tests/network-graph.test.mjs` 6 tests: (1) a 3-agent network pinning a 2-agent version saves and reads back the same
  (fractional position, IDs, relations) after a restart; refs; a batched move; version refs not stored in the version
  file; (2) one child version reused by two parents: each stored pin holds only `id, type, networkId, version, position`,
  no child agent ID, name or Base instruction text in the parents, one version file; Used by lists both (draft and v1
  pins); duplicate keeps references, starts unpublished (also from a published network), names `(copy)`, `(copy) (2)`,
  refuses a taken name and extra fields; rename leaves the published name; (3) A → B → C → A refused with
  `details.path` and the fix in the message, the draft byte-identical; a self-pin is a cycle; delete refused
  `NETWORK_IN_USE` (draft and version uses, "only be archived"), `NETWORK_PUBLISHED`, conflict, missing revision; a draft
  deleted: draft and backup set aside, memory file kept, gone after a restart; fails closed while a draft is unreadable;
  (4) archive: hidden, listed with `archived=true`, bad values refused, versions readable, the parent still saves with a
  `SUBNETWORK_ARCHIVED` issue, export/import keep the flag (a false flag refused), restore removes it; (5) issues
  `AGENT_DISABLED`, `AGENT_STALE` (Base agent switched off), `SUBNETWORK_OUTDATED` with messages; a tampered pinned
  version gives `pinned: null` and `SUBNETWORK_UNAVAILABLE` while a save is refused; (6) the routes over the real server:
  detail, version refs, delete refusals with IDs only and no data-folder path, 404/403/409, duplicate, archive, list
  filter, `archived=maybe` 400; zero runner calls, `state.json` byte-identical, `network/` holds only registrations and
  networks.
- `tests/network-graph-ui.test.mjs` 5 tests (jsdom; no canvas there, so the keyboard lists): (1) New network → Add agent
  ×3 (switched-off marked, placed ones disabled) → Add sub-network (pin v1, never itself) → three typed relations from the
  form, duplicate refused, no self target → grid → Save; the server draft has those agents, pin, grid positions and
  relations; the switched-off agent's issue says what to do; reopened in a new page with the same nodes, relations and
  position; Publish v1, disconnect, Save: v1 identical; Publish v2: chips `v1`, `v2 · latest`; the v1 view is read only
  with its 3 relations; Library versions and Used by; only GETs and graph routes, zero runner calls; (2) the indirect
  cycle in the editor: the message with the path, the node marked, the saved draft identical, Remove from the alert,
  Undo ×2 back to clean; (3) `beforeunload` only when dirty; navigation inside Network and to Base asks (declined keeps
  the editor and edits; accepted discards); a conflicting save offers both choices, "Save mine" makes `Team (my
  changes)` with the edits and leaves the other draft; "Load the saved draft" drops edits; (4) Library: server search;
  Delete disabled with the reason (used, published); archive, Show archived, restore with focus kept; rename and a rename
  conflict with Reload (nothing saved); delete of an unused draft; duplicate; export (file name and content) and import
  (counts, agents off, nothing ran) and a non-JSON file refused; network memory proposed and approved in the Library;
  (5) every Graph and Library control named, disabled buttons carry a reason; row → focused details; canvas keys move,
  delete and undo; search and relation filter; "Show what is inside"; phone width shows one node with Back and focus
  back on its row.
- `tests/network-graph-browser.test.mjs` 2 tests (Chrome): (1) the child and parent built through the UI, three nodes
  dragged with real mouse events, three relations by Connect + taps, a double tap on one node refused; the canvas equals
  the saved draft and the dragged positions were saved; after a page reload the same positions and relations; publish
  v1; drag + disconnect + save: v1 identical; expand the nested network (2 inner nodes, read only, the switched-off one
  marked); the cycle Review pair → Research team → Review pair refused with its message and the node marked; discard;
  light and dark at 1440 (canvas beside the lists, theme colours differ) and 390 (no canvas, lists, then one node with
  Back); Cytoscape from `/vendor/`, no outside request, no `<style>` element, no exception or CSP message; (2) the stress
  fixture below.
- Existing tests changed only where Graph and Library were "soon" (`network-ui` test 1, `network-browser`), plus the 2
  route rows in `remote-access`.
- Mutation check (`$TMPDIR/network-logs/task-05-mutations.log`, final code): 37 of 38 mutations make a test fail (delete
  in-use, published and unreadable checks, setting the backup aside, the archived filter and its import, a duplicate's
  unpublished state, Used by of versions, the disabled and outdated issues, unreadable pins, the cycle fix text, the
  DELETE, duplicate and detail routes, the guard, `beforeunload`, the conflict choices, the cycle's marked node, undo, no
  self target, no duplicate relation, read-only versions, the node state, the delete reason, the network memory panel,
  the archived query, import, the phone details, arrow keys, the relation filter, the view cap, the stylesheet placeholder,
  the container rule, no canvas on a phone, the vendor route, a drag reaching the saved draft). The one that does not:
  removing the `POST duplicate` row from `remote-access` (its scan matches actions by suffix and Kanban already has
  `/api/tasks/:id/duplicate`; a pre-existing limit of that test, listed below).
- Runs: `npm run check` pass; the new tests twice: 11/11 non-browser and 2/2 browser, both times
  (`task-05-new-twice.log`); touched modules `network-ui`, `network-registry`, `network-http`, `network-memory`,
  `remote-access`, `cli`, `server`, `ui`, `ui-2`, `ui-3`, `project-explorer-ui`, `sandbox-ui` 208/208 (`task-05-touched.log`).
- Full `npm test` on the final code (log `$TMPDIR/network-logs/task-05-suite.log`, 2026-10-26 07:32–07:59): non-browser
  1,554 tests, 1,553 pass, 0 fail, 0 cancelled, 1 skipped (the win32-only `editors.test.mjs` test); browser 150/150. Exit 0,
  no reruns needed. Task 04's 1,543 + 6 model + 5 UI = 1,554; 148 + 2 = 150. (Docs were edited during the run; the
  screenshots and the mutation log were made after it on the same code.)

**Performance** (headless Chrome 1440×1000 with software rendering (`--use-angle=swiftshader`), this Mac, the test alone,
six runs, and once inside the full suite): the 1,000-node / 999-relation draft draws in **0.53–1.21 s** (1.41 s in the suite) from choosing it to two painted frames after
every node is on the canvas (cold first canvas of the page; a second open is about 0.15 s; target under 3 s met); five
pan/zoom steps each 20–970 ms, median about 100 ms (the slow ones are Cytoscape rebuilding its cached textures at a new
zoom level in software); choosing a node from the list 35–160 ms; Fit 25–180 ms; expanding a 500-node pinned version
(read lazily) 165–575 ms; JS heap after GC 3.2 MB before and 14.7–16.8 MB after opening the 1,000-node graph (**+11.4 to
+13.6 MB**). Last run: `{"firstRenderMs":645,"panZoomStepMs":[47,81,43,148,95],"chooseNodeMs":70,"fitMs":119,
"expand500Ms":574,"heapDeltaMB":11.4}` (`$TMPDIR/network-logs/task-05-perf.json`). The view cap refused expanding a 600-node version next to it ("would then draw 1,112, more than the
1,000-node view limit") and drew nothing more; a 1,001-node draft shows its notice. Before two fixes the same fixture
took 2.2 s to draw and up to 2–3 s per zoom step: adding elements one by one (now one `cy.add` per change) and dashed
lines (now solid above 300 relations; measured: dashes cost 1–3.7 s per frame, solid 20–300 ms). The suite asserts only
under 10 s (CI draws in software under load); `PB_NETWORK_PERF_LOG=<file>` writes the numbers. No promise of running
workers is made or implied: the fixture only draws registrations.

**Acceptance criteria and evidence** (screenshots in `$TMPDIR/network-logs/task-05-screens/`, all looked at):

- *Visual editor creates a 3-agent network with a nested 2-agent network; saves and reopens with positions/edges
  preserved:* browser test 1 (mouse, reload), UI test 1 (lists, new page), model test 1 (restart);
  `graph-1440-{light,dark}.png`, `graph-1440-light-expanded.png`.
- *One nested network is reused by two parents with no copied resources:* model test 2, UI test 1 (Used by).
- *Cycles are rejected and actionable errors displayed:* model test 3, UI test 2 (indirect, through the UI path), browser
  test 1; `graph-1440-light-cycle.png`.
- *Graph editing/publishing never starts work or leaks data; 500+ node stress fixture is measurable:* model test 6 (zero
  runner calls, `state.json` identical, only registrations and networks under `network/`), UI test 1 (request log),
  model test 2 (no Base instruction text in drafts); browser test 2 and the numbers above; `stress-1000.png`,
  `stress-lazy-cap.png`.
- acceptance.md Task 05 rows: 1 → browser 1, UI 1, model 1; 2 → model 2; 3 → model 3, UI 2, browser 1 (`NETWORK_IN_USE`:
  model 3, 6, UI 4); 4 → model 5, UI 1, browser 1 (disabled marked), self-relation refused in all three; 5 → UI 3, browser
  1 (dirty chip); 6 → browser 1; 7 → browser 2; 8 → UI 5, browser 1 (390 px); `graph-390-{light,dark}-{list,detail}.png`,
  `library-{1440,390}-{light,dark}.png`.

**Known limits.** The view cap counts nodes (1,000), not relations; a draft above it is still drawn whole. Pan and zoom on
1,000 nodes can stall up to about 1 s when Cytoscape rebuilds textures in software rendering; GPU drawing should be faster
(not measured). Above 300 relations they are drawn solid, not dashed. The side lists show 200 rows until "Show all". The
Add dialogs list the first 200 agents or networks (search narrows them). Expansion is not remembered (default collapsed);
the stored `collapsed` flag is kept but unused. Inner nodes of an expanded network are read only and cannot be connected
(open that network to change it). Layouts, drags and arrow keys are undone one step at a time (50 steps). `usedBy` reads
every published version once per server start. The vendor script is parsed on every page load (about 136 KB gzip). The
`remote-access` route scan matches actions by suffix, so the `duplicate` row is also satisfied by Kanban's
`/api/tasks/:id/duplicate` (the row is listed anyway). No isolated app instance outside the tests ran except a scratch
look and two perf experiments on port 4905 (temporary folders, removed). Paid CLI runs: 0.

**Commit.** 47447fc (Task 05), then this log entry.

**Next task: 06.**

### Task 06 — General-purpose job engine (2026-10-26)

**What was done.** Durable Network jobs outside Kanban, with a fake worker only (no live CLI; Task 07 adds the worker).
An owner submits a job for one registered agent and at once gets a durable `jobId` with status `queued` (or
`waiting_for_approval` with `requireApproval`), never `completed`. The accepted request is written once (`request.json`,
its SHA-256 kept in `job.json` and checked on every read) and pins the registration and the Base revision. A FIFO pool
(`maxConcurrentJobs`, default 2, 1–4) claims queued jobs, saves the attempt with a new ID before the worker hears of it,
and holds a lease token in memory only; a worker report counts only while that lease owns the job's current attempt.
`completed` needs result text from a running attempt, saved to `result.md` before the status. Anything that may have run
without a trusted receipt ends `unknown` or `interrupted` and waits for the owner (retry with `confirm`, plus
`confirmUncertain` when it may have done its work, or close). Without a worker, jobs stay queued and inert and their view
says so (`waiting: { for: 'worker', message }`). Sign-in changes wait for running jobs (R3), and jobs wait for a sign-in
change. Shutdown stops claiming, stops attempts and saves them `interrupted`. No job needs or touches a card, branch,
worktree, repository, `state.json`, Base or lessons.

**Files.** New: `src/network/jobs.mjs` (engine, store, settings), `tests/network-jobs.test.mjs`,
`tests/helpers/network-worker.mjs` (the deterministic fake worker). Changed: `src/network/http.mjs` (job and settings
routes), `src/server.mjs` (`NetworkJobs` created beside the registry; `networkWorker` option, default null; R3 in
`claim('auth')`; the end of a sign-in change wakes the pool; `start()` after listening; `close()` in shutdown),
`src/network/storage.mjs` (`writeImmutable` names what failed), `tests/remote-access.test.mjs` (10 rows),
`docs/network/architecture.md` (§3 row, new §4.9, §5 `Job`/`Attempt`/`JobRequest`, §10.1 row 06), `docs/network/acceptance.md`
(test file names), this file. No UI.

**Data layout** (created on the first submit; reading creates nothing): `<data>/network/jobs/<escapeId(job_…)>/request.json`
(`promptboard.network-job-request` v1, written once without backup), `jobs/<id>/job.json` (`promptboard.network-job` v1 +
`.bak`: status, requester/source, agent/project/network/parent IDs, idempotency key and `submissionSha256`,
`requestSha256`, `queuedAt`, attempts, `currentAttemptId`, outcome, error code, reason, result reference, history ≤ 200,
`outputsRemovedAt`), `jobs/<id>/attempts/<escapeId(att_…)>/result.md` (≤ 1 MiB), `result.json` (≤ 64 KiB),
`late-result.md`, and `network/settings.json` (`promptboard.network-settings` v1, on the first settings change). Input
ceilings: text 256 KiB, JSON 64 KiB, instructions 32 KiB, submit body 1 MiB, other bodies 64 KiB. No limit on the number
of jobs. Index: one scan at the first access (16 files at a time).

**State machine** (`JOB_TRANSITIONS`, every change through one checked function, history records `by`):
`queued → preparing | failed (claim-time check) | cancelled`; `waiting_for_approval → queued (approve) | cancelled
(reject/cancel)`; `preparing → running | failed | unknown | cancelled | interrupted`; `running → completed | failed | unknown
| waiting_for_input | cancelled | interrupted`; `waiting_for_input → queued | cancelled`; `interrupted | unknown → queued
(retry) | failed (close)`; any non-terminal → `interrupted` (restart, shutdown, restored from backup); `completed`,
`failed`, `cancelled` are final. Attempt: `claimed → launching → running → completed | failed | cancelled | unknown |
interrupted`. Outcome: `completed | failed | cancelled | uncertain | not_started`.

**Routes** (behind `handle()`, all allowed from a paired device, `localOnly()` unchanged): `GET/PATCH
/api/network/settings`; `GET /api/network/jobs` (`?status agentId projectId networkId parentJobId offset limit`);
`POST /api/network/jobs` (202 new, 200 deduplicated); `GET /api/network/jobs/:id` (job, request, children);
`DELETE /api/network/jobs/:id` (`{ expectedRevision }`, finished jobs only); `POST …/:id/cancel` (`{}`),
`…/approve` (`{ expectedRevision, decision }`), `…/retry` (`{ expectedRevision, confirm, confirmUncertain? }`), `…/close`
(`{ expectedRevision }`).

**Settings** (`network/settings.json`, revisioned): `maxConcurrentJobs` 2 (1–4, separate from Kanban's
`maxConcurrentRuns`), `defaultTimeoutMs` 20 min (1–120 min; a request may give 1 s–120 min), `outputRetentionDays` 30
(1–3650). Fixed: preparation 45 s, stop bound 3 s, claim retry after a storage failure 5 s, sweep 500 jobs per start.

**Decisions** (architecture §4.9): the attempt's §6.2 `preparing` state is the job's `preparing` status (not stored
twice); the pool starts with `start()`; queued jobs are claimed fresh after a restart (no attempt is in flight, so a new
claim is safe), while a `job.json` that loaded from its backup in any non-final state becomes `interrupted`/`uncertain`
(`RESTORED_FROM_BACKUP`); the engine itself enforces the preparation and run time limits; cancel takes no revision
(idempotent; a running job's revision moves); a result reported after the engine ended the attempt is kept as
`late-result.md`; idempotency keys are scoped by requester and a different submission under the same key is
`IDEMPOTENCY_CONFLICT`; input text, instructions and JSON strings are cleaned like memory (secrets masked, local folders
cut); the pinned agent has `manifest: null` until Task 07 builds it (R2) from the pinned revision references; attempts are
kept out of the server's shared task list (a Compose cancel waits on that list), `close()` stops them instead; no UI in
this task (a submit control before a worker exists would only queue jobs that cannot run; the agent's Tasks tab and
Activity come with Tasks 07–08).

**Tests** (temporary data folders; the only worker is the fake; no CLI, no network beyond the local test server):

- `tests/network-jobs.test.mjs` 18 tests: (1) submit answers queued after both files exist, the request's hash matches,
  no worker → stays queued with the reason (also after `start()`), then the fake worker: history `queued → preparing →
  running → completed`, attempt fields, `result.md`, the lease neither in a view nor on disk; (2) the pinned request and
  default permissions (`read_only`, `agent` memory, no lessons, no tools, 20 min, 1 MiB output), the Base revision
  reference, a Base edit leaves `request.json` byte-identical, secrets masked in text and JSON, no project needed, explicit
  choices kept; (3) 27 malformed or unrunnable submissions (fields, sizes, IDs, agent missing/off/stale, no provider, tool
  mode, write access, memory and lessons rules, project, network, parent, key) → 400/409/413 and no `jobs/` folder;
  (4) idempotency sequential, 8 concurrent, conflict, other requester, keyless, after a restart; (5) 20 concurrent submits
  with distinct FIFO stamps and positions, 3 concurrent claims → one attempt, forged lease, other job, spawn before launch,
  malformed reports, ended and stale (after retry) ownerships change nothing, the pool claims in FIFO order; (6) ceilings
  1, 2 and 4 (never more at once, all six run, a worker without a result never completes a job), settings ranges,
  revisions, restart, the default timeout used by new jobs; (7) a restart after every transition (queued, waiting,
  approved, claimed → `interrupted/not_started`, launching → `uncertain`, running with pid → `uncertain` with the pid,
  retry needing `confirm`/`confirmUncertain`, a worker after a restart runs only the queued job, completed, unknown, closed,
  cancelled; the full history); (8) a `job.json` loaded from its backup → `RESTORED_FROM_BACKUP`, damaged set aside, no
  usable copy and newer version refused and unchanged, a tampered `request.json` fails at claim with no attempt;
  (9) storage failure (a folder in the backup's place) at submit (no job, key free), claim (stays queued), launching (no
  `launchingAt`), spawn (the fake process is killed by the engine), finish (job stays `running`, then `unknown NO_RESULT`
  once storage works); memory equals disk after each; (10) cancel while queued (never claimed), preparing (launch refused
  afterwards), running (killed; a later result → `late-result.md` only, status `cancelled`), completion queued before the
  cancel (`JOB_FINISHED`), completion arriving while the cancel stops the worker (completed stands), waiting for approval,
  the view's `live.process`; (11) uncertain effects: empty result → `unknown`, no replay after a restart, retry needs
  `confirmUncertain`, a silent worker after launch → `unknown`, before launch → `failed`, `unknown` before launch →
  `failed`; (12) a worker refusing at claim, registration switched off and project removed after acceptance (failed, no
  attempt, the worker never called), preparation limit, 1-second run limit (killed); (13) retention (old logs removed,
  results kept, recent and open-parent jobs untouched) and delete (finished only, revision, `JOB_IN_USE`, folder gone, key
  freed); (14) HTTP: token, Origin, 202/200, conflict, a request whose answer is lost then sent again → one job, 413 body
  and input, 400, 404, every action, settings, no data-folder path or token in answers; (15) 20 jobs through the fake
  worker: every file outside `network/` byte-identical (including `state.json`), no card, run or session, a
  `child_process` recorder (proven to see `git`) records zero processes; (16) sign-in: a job submitted during a sign-in
  change waits (`sign-in`) and starts right after it, `POST /api/auth/login` → `409 RUNS_ACTIVE` while it runs, allowed
  after; (17) queued jobs without a worker never block sign-in; (18) shutdown: the running attempt is stopped (killed) and
  saved `interrupted`/`uncertain`/`APP_STOPPED`, the queued one stays queued and runs after the restart, the interrupted one
  never does.
- `tests/remote-access.test.mjs`: 10 rows (settings GET/PATCH, jobs GET/POST, job GET/DELETE, cancel, approve, retry,
  close); the job actions are dispatched as `[…].includes(action)`, so the route scan catches a missing row (checked).
- Mutation check (`$TMPDIR/network-logs/task-06-mutations.log`, final code, scratch copy): 52 of 52
  mutations make a test fail (submit status, request hash, idempotency dedupe, scope and conflict, claim of a non-queued job,
  lease checks in finish and in launching/spawned, restart reconcile and its outcome, backup copy, FIFO order, ceiling, sign-in
  wait, start gating, R3, the wake after sign-in, shutdown wiring and stop, result-text rule, late result, saved-first rule,
  killing an unrecorded process, unknown after launch, claim-time registration and project checks, both time limits, sweep
  guards, delete guard, both retry confirmations, five submit refusals, input cleaning, Base pin, default memory, the no-worker
  reason, 202, the action routes, write before effect, memory after disk, cancel of an interrupted job, settings ranges, the
  newer-version refusal, history, queued jobs not blocking sign-in, the route-table rows). Two survived the first round and
  led to test changes: the sign-in test now runs before any cancel (a 3-second release timer had hidden a missing wake), and
  the claim-time test now also removes a project.
- Runs: `npm run check` pass; the new tests twice on the final code: 35/35 and 35/35 with `remote-access`
  (`task-06-new-twice-final.log`; also 18/18 twice before the last engine change, `task-06-new-twice.log`); touched
  modules `auth`, `server`, `remote-access`, every `compose*` and `network-*` test 211/211, and their browser tests
  (`compose*-browser`, `network*-browser`, `remote-access-browser`) 11/11 (`task-06-touched.log`, before the last change,
  which only removed the engine's use of the shared task list).
- Full `npm test` (log `$TMPDIR/network-logs/task-06-suite.log`): 2026-10-26 08:50–09:17, non-browser 1,572 tests, 1,571 pass,
  0 fail, 0 cancelled, 1 skipped (the win32-only `editors.test.mjs` test); browser 150/150. Exit 0, no reruns needed.
  Task 05's 1,554 + 18 = 1,572; browser unchanged.
- Isolated app on port 4906 (temporary data and projects folders, PATH holding only a `node` symlink, no worker): a
  registered agent, `POST /api/network/jobs` → 202 `queued` with "No job worker is available … stays queued and nothing
  runs", no token 403, the same key → the same job, settings defaults; stopped with Ctrl+C and started again: the job is
  still `queued`, revision 1, no attempt; stopped, folder removed. Paid CLI runs: 0.

**Acceptance criteria and evidence:**

- *An owner can submit a job and immediately get a durable `jobId` with `queued` status; the fake worker can finish it:*
  tests 1, 14 (HTTP 202) and the port 4906 smoke.
- *Job persists through restart and retains the exact state; no duplicate job or worker launch on retries:* tests 4, 7, 8,
  14 (repeated POST, lost answer), 18; test 7 shows a worker after a restart starting only the queued job; test 5 shows one
  claim out of three.
- *A general job does not create Kanban cards/branches, run tests or merge code:* test 15 (files, board view, zero
  processes) and test 2 (no project needed).
- *Uncertain effects remain unknown/interrupted and require explicit user action; no implicit replay:* tests 7, 8, 9
  (finish), 11, 18.
- acceptance.md Task 06 rows: 1 → test 1; 2 → test 4 (+14); 3 → test 5; 4 → tests 7, 18; 5 → test 9; 6 → test 10;
  7 → tests 7, 11; 8 → test 3; 9 → test 15; 10 → test 16 (+17); 11 → test 6; 12 → test 13.

**Known limits.** No worker exists yet: until Task 07, submitted jobs stay queued (and say so). No UI. The Base resolution
manifest is `null` in requests accepted now (Task 07 decides how such queued jobs get one). One queue serializes every job
change, and the start scan reads every `job.json` (`ponytail:` notes). A process left by a hard crash is never signalled
after a restart; its pid is shown in the reason. The stop of a worker that ignores `cancel` is bounded to 3 s; then the
status is saved and the slot freed while that process may still run (at shutdown the server's existing
`killOwnedProcesses('SIGKILL')` still covers processes a Task 07 worker starts through `spawnOwned`). A submit whose `job.json` write fails after `request.json` was written removes the folder; that
clean-up is not covered by a test (the failure cannot be injected without knowing the new ID). Reports still refuse
`jobId`. The retention guard knows parent jobs only; Task 09 adds pipeline runs. Cross-process claims are excluded by the
instance lock, not by the job files.

**Commit.** d49d064 (Task 06), then this log entry.

**Next task: 07.**

### Phase-1 review fixes (2026-10-26)

An independent review of Tasks 01–05 (at 2c42b99; findings, probes and screenshots in
`$TMPDIR/network-logs/review-p1/`) listed ten findings and six unconfirmed points. All ten are fixed at their root, each
with a test that fails without it (checked by reverting the source change or by a mutation, `git stash` never used;
`$TMPDIR/network-logs/review-p1-fixes/mutations.log`, `p1-3-mutations.log`, `p1-8-without.log`). Task 06's job input was
checked for the same injection problem. Task 07 is not started. Architecture changes: §4.2 rule 9, §4.6 items 2, 5 and 8,
§4.7 item 5, §4.8 item 5, §7.2 step 5, §10.2, §12.2 item 8.

| Finding | Status | Commit | Test that covers it |
|---|---|---|---|
| P1-1 newline injection into the memory block | fixed: names, display names, tags, capabilities, report source references and job idempotency keys refuse `\r`, `\n`, tab, U+0085, U+2028, U+2029 at save **and** import (`LINE_BREAK`); the block collapses a network name to one line (`oneLine`) and indents record text on every line break, Unicode ones included (`indent`); descriptions, memory text, reports and job input stay multi-line | 798e4b7 | `network-review` "P1-1: a line break or tab…", "P1-1: no stored name or record text can close or forge the memory block…" (also a name saved before the fix), "P1-1: job input text and instructions…" |
| P1-2 cubic, blocking import cycle validation | fixed: one depth-first walk with a shared path (O(versions + pins)), yielding every 1,000 versions; an import first peels off networks that cannot be on a loop of pins (Kahn both ways, O(networks + pins)) and walks only the rest. The reviewer's 1.32 MiB chain: 6.6 s with the event loop held → about 20 ms; a 13 MiB chain of 20,000 networks 146 ms (`review-p1-fixes/probe2-worktree.log`) | a4d8e06 | `network-review` "P1-2: import validation is linear…" (2,000-network chain < 3 s, event loop held < 1 s, a loop through it still refused with the whole path), "P1-2: a crafted file whose networks all pin each other…" (held < 400 ms) |
| P1-3 route scan blind to `:id` routes | fixed: `src/network/http.mjs` exports `NETWORK_ROUTES` (method + anchored pattern + handler), the dispatcher reads it, and `tests/remote-access.test.mjs` requires exactly one `ALLOWED`/`LOCAL_ONLY` row per route and a route per Network row. Task 06's 10 routes included (39 in all). Mutation check: each of the 39 rows removed, each of the 39 routes removed, and one unlisted route added — 79 of 79 fail the test (Task 05's surviving `POST duplicate` row now fails too) | f7228c2 | `remote-access` "every route from a paired phone…" |
| P1-4 new nodes placed on top of others | fixed: a spot is free only with node size plus a gap (centres 190 × 70 apart) | a5e709e | `network-review-browser` (Chrome, both themes: the reviewer's pan, gap between bounding boxes) |
| P1-5 publish conflict left a stale Publish and no alert | fixed: a publish refused by a newer save (or with node `details`) closes its dialog and shows the editor's alert with "Load the saved draft" / "Save mine as a new network"; Save and Publish stay disabled with the reason until one is chosen | a5e709e | `network-review-ui` "P1-5: a publish refused by a newer save…" |
| P1-6 a damaged deeper version blocks every ancestor save, error names nothing | fixed: a draft update re-checks only the references it adds (create, duplicate and publish check all); a version that cannot be read on the way fails with `details: { networkId, version, path }` and a message naming the sub-network that leads to it; the editor marks that node and offers Remove after a refused save or publish. Task 05's test that pinned the old refusal now expects the save and a refused publish | 2940a0a | `network-review` "P1-6: a damaged version deep inside…"; `network-review-ui` "P1-6: a save that adds a pin…", "P1-6: a publish refused…"; `network-graph` "issues name agents…" |
| P1-7 local folders saved and exported verbatim | fixed **at save and import** (not at export): registry text goes through `redactLocal(noPaths())`, so an export carries it as saved and a published version's bytes still match its hash. Rule 9 of §4.2 now says so. Exports made before this fix whose published version names hold a folder no longer import (their hash cannot match); the branch was never released | c8de7d5 | `network-review` "P1-7: local folders in names…" |
| P1-8 8 MiB draft check after the import's first writes | fixed: every remapped draft is measured with the other checks before anything is written. Without it the test's file made the old code write about 82,000 version files over 10.7 minutes before it refused | d818eec | `network-review` "P1-8: an imported draft over 8 MiB…" |
| P1-9 expanded label on the border, inner relation labels hidden | fixed: a one-line label inside the box below the border, on its own background; relations inside an expanded sub-network are drawn above its nodes (`z-compound-depth: top`) | a5e709e | `network-review-browser` (label box inside the parent and above its nodes; the inner edge style) |
| P1-10 status messages push the canvas down ~43 px | fixed: the status line keeps its height when empty; Connect mode's instructions (which moved the canvas 48 px just before the taps, found while checking this) now use that line instead of a notice above the canvas | a5e709e | `network-review-browser` (canvas top unchanged after a message and after Connect at 1440 px; editor unchanged after a message at 390 px) |

**Unconfirmed points** (commit 62fb4bb for the four that were real):

- *`memory.resolve()` checks membership and reads network memory in two queues* — **dismissed.** Membership comes from
  the registry's read of the agent, the records a moment later from the memory queue. A concurrent owner edit in that
  window gives the block as of the membership read, the same as the job starting a moment earlier; no other scope can be
  read (every record's scope is checked again in `memoryBlock`), and a deleted network fails the call. One lock across
  both modules would serialise unrelated work for no gain.
- *`exportedAt` unvalidated* — **real, fixed:** any JSON value at any depth (up to the 32 MiB body) was accepted and
  ignored; now a string of at most 64 characters or absent (`network-review` "Unconfirmed: exportedAt…").
- *Import keeps free IDs, so an old export reattaches a deleted network's orphaned memory* — **real, fixed:** an ID is
  now taken while a set-aside draft or a memory file still names it; the deleted network's memory file is left untouched
  (same test; both checks killed by mutation).
- *Add sub-network lists only the first 200, no search* — **real, fixed:** a server search past the first 200, with
  "The first 200 of N networks. Search to find the others." (`network-review-ui` "Unconfirmed: …").
- *Read-only version heading shows the current draft name* — **real, fixed:** it shows the name the version was
  published with (same test).
- *Cancelling the unsaved guard pushes a history entry* — **real, fixed:** the editor's address comes back through
  `history.replaceState`, so Back no longer leads to the declined page (same test).

**Task 06 and the same problem.** A job's `input.text`, `instructions` and JSON strings are multi-line by design and
will sit in `prompt.md` inside `=== JOB INPUT … ===` (Task 07); they could forge an approved-memory block there. The
accepted request keeps them as data; §7.2 step 5 now requires Task 07 to put them through `indent()` (and labels through
`oneLine()`), and `network-review` "P1-1: job input text and instructions…" pins that every line of an accepted input,
Unicode breaks included, is indented. The idempotency key refuses Unicode line breaks too; jobs have no title field.

**Files.** `src/network/{storage,registry,memory,posts,jobs,http}.mjs`, `public/network-graph.js`, `public/styles.css`;
tests: new `tests/network-review.test.mjs` (9), `tests/network-review-ui.test.mjs` (4, jsdom),
`tests/network-review-browser.test.mjs` (1, Chrome); changed `tests/remote-access.test.mjs`, `tests/network-graph.test.mjs`;
`docs/network/architecture.md`, this file.

**Screenshots looked at** (`$TMPDIR/network-logs/review-p1-fixes/shots/` from an isolated app on port 4907 with a
temporary data folder and a PATH holding only `node`, stopped and its data removed; and `test-shots/run2/` from the
Chrome tests): `p1-9-expanded-1440-{light,dark}`, `p1-4-placement-1440-{light,dark}`, `p1-5-conflict-{1440,390}-{light,dark}`,
`p1-10-status-390-{light,dark}`, `graph-list-390-{light,dark}`; `expanded-1440-{light,dark}`, `placement-1440-{light,dark}`,
`status-390-{light,dark}`, `graph-1440-light-expanded`, `network-1440-light-profile`. Measured there: the new node
lands at (185, 120) beside the one at (0, 0), overlap 0; the canvas top stays at 465 px after a message, the 390 px panel
top at 398 px; the expanded label box (y 250–272) lies inside its parent (241–360) and above its nodes; no console
exception or CSP message.

**Tests and runs.**

- `npm run check`: pass.
- The new and changed tests twice on the final code (`$TMPDIR/network-logs/review-p1-fixes-twice.log`): every
  non-browser `network-*` test plus `remote-access`, 96/96 both times; `network-review-browser`, `network-browser`,
  `network-graph-browser`, `remote-access-browser` 6/6 both times. (A first browser pair failed only because
  `PB_NETWORK_SCREENSHOTS` named a folder that did not exist yet and `network-browser.test.mjs` writes without creating
  it; rerun with the folder present.)
- Mutation and revert checks: every check in `review-p1-fixes/mutations.log` ends killed (two first attempts survived
  and were corrected: one mutation that did not remove the pruning, and the memory-file check, which then got its own
  case); P1-3 79/79; P1-1, P1-2 and the UI points also fail on the reverted source.
- Full `npm test` on the final code (log `$TMPDIR/network-logs/review-p1-fixes-suite.log`, 2026-10-26 10:16–10:44):
  non-browser 1,585 tests, 1,584 pass, 0 fail, 0 cancelled, 1 skipped (the win32-only `editors.test.mjs` test); browser
  151/151. Exit 0, no reruns. Task 06's 1,572 + 13 = 1,585; 150 + 1 = 151.

**Known limits.** A crafted import whose networks all pin each other in loops is still walked once per root (quadratic,
yielding to the event loop; `ponytail:` note). An empty status line now keeps about 35 px between the section tabs and
the panel. Exports from before P1-7 with a folder in a published version's name or description no longer import.
Paid CLI runs: 0.

**Commits.** 798e4b7 (P1-1), c8de7d5 (P1-7), a4d8e06 (P1-2), d818eec (P1-8), 2940a0a (P1-6), f7228c2 (P1-3),
a5e709e (P1-4, P1-5, P1-9, P1-10), 62fb4bb (unconfirmed points), then this log entry.

**Next task: 07.**

### Task 07 — Local worker runtime (2026-10-26, parallel wave A, branch `feat/network-07`)

**What was done.** Network jobs now run on this computer. `src/network/worker-local.mjs` (`LocalJobWorker`) is the worker of
Task 06's engine: an accepted job runs once through the existing headless adapters (`streamResearch` for Claude Code and
Codex, `runProvider` for tool-less Gemini; Antigravity refused), in an empty folder of its own under the data folder,
read-only, with the Base revisions pinned when the job was accepted, the approved memory and lessons it may have, and its
instructions and input indented inside labelled sections. It completes only with exit 0 and the CLI's structured final answer.
The app uses this worker by default (tests inject a fake or `null`). The agent's **Tasks** tab runs a job after a confirmation
and follows the agent's jobs (polling). Not done here: the event journal (Task 08; activity goes to `this.events?.append`) and
pipelines (Task 09). Decisions: architecture §18.

**Files.** New: `src/network/worker-local.mjs`, `tests/network-worker.test.mjs`, `tests/network-tasks-ui.test.mjs`,
`tests/network-tasks-browser.test.mjs`, `tests/fixtures/fake-headless-cli.mjs`, `scripts/network-live-smoke.mjs`. Changed:
`src/research-cli.mjs` (R1), `src/providers.mjs` (`onSpawn`), `src/base-resolver.mjs` (R2), `src/server.mjs` (default worker),
`src/network/jobs.mjs`, `src/network/http.mjs`, `src/network/registry.mjs` (usage `yes` for Claude/Codex), `public/network.js`,
`public/styles.css`; tests `network-jobs` (manifest expectation; the lost-answer flake below), `network-ui` (Tasks works),
`network-registry` (usage), `remote-access` (result row), `helpers/test-server.mjs` and `helpers/ui-harness.mjs` (no worker
unless a test passes one); `docs/network/architecture.md` §18, `docs/network/acceptance.md` (Task 07 file names), this section.

**Worker design** (§18 items 1–12). `claim(job, own)`: the launch checks (read-only only, Claude/Codex/Gemini, tool mode,
`checkBaseRevocations` of the pinned manifest, the CLI resolves); any refusal fails the job with no `launchingAt` and no
process. `start(job, own)`: a new `attempts/<att>/workspace/` (0700, empty) as the working directory; `prepareBase` from exactly
the pinned revisions; `registry.memory.resolve()` for memory and lessons; `prompt.md` and `base-manifest.json` written;
`own.launching()`; the runner (`streamResearch` with `persist: false`, `requireFinal`, `onSpawn`, `onUsage`, `onEvent`, or
`runProvider` with `timeoutMs: null`, `onSpawn`); `onSpawn` → `own.spawned({ pid })` (its failure stops the CLI at once); the
CLI's process group is ended when it exits; then exactly one `own.finish()` with status, code, fixed reason, exit code,
coverage, `sideEffects`, `usage` and `nativeSessionId`. Ownership is the engine's lease (`own`), never a card or run; cancel is
the engine's `AbortController` plus `worker.cancel` (waits for the run to settle, ≤ 3 s); a cancelled, timed-out or stopped run
reports nothing. Activity goes to `own.activity()` (labels never carry tool arguments) and `stream.jsonl` (bounded evidence).

**Shared-file edits.** `src/server.mjs`: imports `LocalJobWorker`; `networkWorker` defaults to it (`undefined` → local, `null`
→ none). `src/network/jobs.mjs`: `jobManifest()` and the manifest pinned at submit (`BASE_REQUIRED_UNAVAILABLE` refusal),
`activity(own, item)` and `own.activity`, `usage`/`nativeSessionId` accepted in reports and stored on the attempt, the view's
`lastActivity` and `live.coverage`, `result(id)`. No constructor change (Task 08 adds `events`; `activity()` already calls
`this.events?.append`). `src/research-cli.mjs` (R1): optional `onSpawn`, `onUsage` (usage parsed from Claude `result` and Codex
`turn.completed`), `requireFinal`, `error.exitCode`; Origin Research passes none of them. `src/base-resolver.mjs` (R2): optional
`layers`. Also `src/providers.mjs`: optional `onSpawn` on `execute`/`runProvider` (Gemini pid and launch order; §18 item 13).

**Routes.** One new route: `GET /api/network/jobs/:id/result` (`NETWORK_ROUTES` row, allowed from a paired device, row added
to `tests/remote-access.test.mjs`). `localOnly()` unchanged.

**Task 06's `manifest: null` decision.** Built at claim from the current Base only while the agent (and an agent profile's
primary agent) is still exactly the pinned revision; otherwise `failed BASE_CHANGED` before anything runs (§18 item 3; test
"a job accepted before Base pinning …").

**UI.** The agent profile's **Tasks** tab (no longer "soon"; Activity stays "soon" for Task 08): "Run a job" (text, tools
none/web with web disabled and named for Gemini, time limit, optional project and network, approved memory on/off, project
lessons, and the memory preview of exactly what is added), a confirmation listing what the job may use (and "Cost: not limited;
usage only if the CLI reports it"), then the agent's jobs with status, live process and last activity, coverage, reported usage,
reason and code, Cancel / Approve / Reject / Retry… (uncertainty confirmation) / Close…, and details with the result as
Markdown (HTML shown as text), its json, the input and the attempt facts. A switched-off, stale or refused agent shows why and
disables the form. Polling: 2 s while a job is open, 10 s otherwise, only while the tab shows. Both themes, 1440 and 390 px,
keyboard (tab arrows, Enter on Run job…, focus on the confirm button, Escape returns focus, Enter opens the details).
Screenshots looked at (`$TMPDIR/network-logs/task-07-shots/`): `tasks-1440-{light,dark}`, `tasks-1440-{light,dark}-confirm`,
`tasks-390-{light,dark}-form`, `tasks-390-{light,dark}-job`; the first round showed the textarea unstyled beside its label
(fixed: block textarea in the app's input style) and a cramped note under the confirmation facts (fixed).

**Tests** (fake CLIs only; the real ones are never on a test's PATH; test helpers default to no worker):

- `tests/network-worker.test.mjs` 11 tests: (1) exact argv for Claude none/web, Codex none/web (ambient MCP disabled), Gemini
  (deny-all policy); cwd = the attempt's empty 0700 workspace; stdin = `prompt.md`; coverage `tools`/`partial-tools`/`final-only`;
  activity events only where the CLI reported tools, never with the query or a local folder; `stream.jsonl` evidence. (2) exact
  `prompt.md` (header, pinned definition, indented instructions, approved memory and the allowed project's lessons only, input
  with forged delimiters and a U+2028 break indented, JSON input), and none of memory/lessons when not asked for. (3) Base pinned
  at acceptance: manifest revision refs in `request.json`, later edits of the agent and its knowledge not received, optional MCP
  omitted and never configured, required MCP refused at submit; a revoked dependency (worker) or agent (engine) fails the job
  before launch with no CLI started; revoked while running → completed with the "revoked after start" reason. (4) Task 06
  `manifest: null` jobs: unchanged agent runs, changed agent `BASE_CHANGED`, nothing started. (5) completion rules: result + exit
  0 → completed (json block → `result.json`), no structured answer → `unknown INVALID_OUTPUT` (Claude, Codex, Gemini), rate limits
  → `RATE_LIMITED` with the fixed message (all three), signed out → `AUTH_REQUIRED`, exit 3 → `CLI_FAILED`, oversized output →
  `OUTPUT_LIMIT` (Claude stream, Gemini runner), 1.5 s limit → `TIMEOUT` with the CLI and its helper gone; no result kept for any
  failure. (6) a `spawned` that cannot be saved stops the CLI at once and reports nothing. (7) a CLI killed from outside →
  `failed CLI_FAILED`, pid recorded, its helper gone. (8) six jobs with the default pool of 2: never more than two CLIs at once and
  two did run together; every file outside `network/jobs/<these jobs>/` (state.json, Base, lessons) and a project folder with
  `.git` byte-identical; board view unchanged; a `child_process` recorder sees only the three CLIs, never `git`. (9) native
  session IDs kept or `null` when missing; usage `reported: true` with the exact numbers only when the stream carries them.
  (10) refusals: write access `EXECUTION_POLICY_UNSUPPORTED`, Antigravity `PROVIDER_UNSUPPORTED`, web on Gemini
  `TOOLS_UNSUPPORTED`, no CLI on PATH `NOT_INSTALLED` before launch. (11) through `startServer` with the default worker: three
  jobs at once, cancel one (its process group gone, the others still run), stop the app (both `interrupted`/`uncertain`/
  `APP_STOPPED`, process groups gone), restart (nothing relaunched), a new job completes and its result route answers; 404
  without a result.
- `tests/network-tasks-ui.test.mjs` 2 tests (jsdom, real server, deterministic fake worker): the form, preview with lessons, empty
  input refused, the confirmation's content, Escape sends nothing, the exact POST body (with a `ui-` idempotency key), the live
  list without a click (running with activity), coverage and reported usage, the result as Markdown with `<script>`/`<img>` kept as
  text, details staying open, Cancel; a switched-off agent's disabled form with its reason, Gemini's web option disabled and named,
  Approve, Retry gated by the uncertainty checkbox (a second attempt), Close.
- `tests/network-tasks-browser.test.mjs` 1 test (Chrome, the app's own local worker, fake CLIs only on PATH): the flow above by
  keyboard in light and dark at 1440 and 390 px, no sideways scroll, theme colours differ, no console exception or CSP message.
- Changed: `network-jobs` (the pinned manifest replaces `manifest: null`; the lost-answer request now ignores the reset of its
  unread reply: beside the worker tests' extra load it failed 2 of 3 runs with an uncaught `ECONNRESET` (the base commit, which
  has no worker tests, passed), and 0 of 6 after the fix), `network-ui` (Tasks works; a report creates no job),
  `network-registry` (usage `yes`), `remote-access` (result row).
- Mutation check (`$TMPDIR/network-logs/task-07-mutations.log`, scratch copy of HEAD, `git stash` never used): 39 of 39 killed
  (prompt indenting and sections, workspace cwd, persistence flags, each refusal, revocation at launch, the accepted-manifest
  check, the process-group kill, coverage, usage, sessions, unknown on no answer, failure codes, revoked-after-start, activity and
  its event, the manifest at submit and its refusal, stored usage, `lastActivity`, the result route, R1 usage/onSpawn/
  requireFinal, R2 layers, Gemini onSpawn, the default worker, and six UI behaviours); plus the two later checks (`spawned`
  failure stops the CLI; the signed-out scenario) killed.
- Runs on the final code (parallel-wave rule: no full `npm test` here; logs in `$TMPDIR/network-logs/`): `npm run check` pass;
  the new tests twice — `network-worker` + `network-tasks-ui` + `remote-access` 30/30 and 30/30, `network-tasks-browser` 1/1 and
  1/1 (`task-07-new-run{1,2}.log`, `task-07-new-browser-run{1,2}.log`); every touched module's suite (`research-cli`,
  `origin-research*`, `base-*`, `network-*`, `remote-access`, `server`, `providers`): non-browser 304/304 (`task-07-touched.log`;
  the base commit's same set is 291, + 13 new), browser 24/24 (`task-07-touched-browser.log`: `base-profiles`, `network`,
  `network-graph`, `network-review`, `network-tasks`, `origin-research`, `origin-research-approval`, `origin-research-chat`,
  `remote-access`). No skips, no reruns.

**Live provider runs (Task 07).** `PB_NETWORK_LIVE=codex,claude,gemini node scripts/network-live-smoke.mjs`, 2026-10-26 10:25
UTC: an isolated app on port 4917 with a temporary data folder (removed afterwards), the app's own local worker, the real
signed-in CLIs behind a wrapper that copied their stdout for the usage check. One job each, "Summarise in three bullet points:
<two sentences about Network>". **3 real CLI runs in total** (plus Codex's own `codex mcp list --json`, which reads its
configuration and calls no model).

| Provider | Model / effort | Purpose | Result | Usage fields seen in the stream → recorded |
|---|---|---|---|---|
| Codex CLI | CLI default, effort low | R1 + end-to-end job | `completed` in 7 s, exit 0, three bullets, `partial-tools`, thread ID reported | `turn.completed.usage`: `input_tokens` 10471, `cached_input_tokens` 3968, `cache_write_input_tokens` 0, `output_tokens` 47, `reasoning_output_tokens` 0 → `{ inputTokens: 6503, cachedTokens: 3968, outputTokens: 47 }` |
| Claude Code | haiku | R1 + end-to-end job (not rate-limited) | `completed` in 5 s, exit 0, three bullets, `tools`, session ID reported | `result.usage`: `input_tokens` 2, `cache_creation_input_tokens` 5212, `cache_read_input_tokens` 649, `output_tokens` 205; `total_cost_usd` 0.00115159 → `{ inputTokens: 5214, cachedTokens: 649, outputTokens: 205, costUsd: 0.00115159 }` |
| Gemini CLI | CLI default | end-to-end job (OAuth credentials present) | `failed CLIENT_UNSUPPORTED` in 8 s (the provider refused the client, as `docs/live-verification.md` already records); fixed message shown, nothing retried | none (no stdout) → `{ reported: false }` |

The R1 field names are confirmed for Claude and Codex (§18 item 11); the §8 matrix's `usage` is now `yes` for both. Gemini
Network jobs are covered by fakes only.

**Acceptance criteria and evidence.**

- *A real Network job can execute with an existing supported CLI and return result/artifact, without a repo:* live Codex and
  Claude runs above (completed, result read through the result route); worker tests 1, 5, 8 (cwd is an empty attempt folder,
  no repository, `result.json` artifact); test 11 (through the app).
- *A rejected/disabled Base profile cannot start, and a job cannot write to an unrelated project:* worker test 3 (revoked
  dependency or disabled agent → `BASE_REVOKED`, no CLI started; required MCP refused at submit), test 4 (`BASE_CHANGED`),
  test 10 (write access refused), test 8 (project folder and every file outside the job's folder unchanged; never `git`); UI test 2
  (disabled agent cannot start).
- *Task lifecycle and cancellation are visible; provider status is explicitly uncertain when evidence is inadequate:* tests 5
  (`unknown`/uncertain without a structured answer), 6, 7, 11 (cancel, app stop, restart); UI tests (live status, activity,
  coverage, "May have run", Retry's uncertainty confirmation); Chrome test.
- *Existing Kanban Supervisor/Autopilot behaviour is unchanged and regressions pass:* the Supervisor, `agents.mjs` and Board are
  untouched; the shared changes are optional parameters whose defaults keep behaviour (R1/R2, `onSpawn`); `research-cli`,
  `origin-research*`, `providers`, `base-*`, `server`, `remote-access` and every `network-*` suite pass (runs below). The full
  `npm test` is the coordinator's after merging (parallel-wave rule).
- acceptance.md Task 07 rows: 1 → worker test 1 (+10 for Antigravity and Gemini web); 2 → test 2; 3 → test 3; 4 → tests 1, 8;
  5 → test 5; 6 → tests 7, 11 (three concurrent, cancel and app stop, pids checked); 7 → test 1; 8 → test 9; 9 → touched-suite runs;
  10 → the live smoke (a script, not `tests/network-worker-live.test.mjs`, so no real CLI is ever reachable from `npm test`).
- Failure matrix rows: 4 and 5 → test 11 and Task 06's reconcile (pid recorded by the worker, test 7); 6 → test 6; 12 → test 3;
  13 → test 3 (revoked while running) and the Tasks tab mark; 17 → tests 5 (`AUTH_REQUIRED`) and 10 (`NOT_INSTALLED`); 19 → test 5;
  20 → test 5; 21 → test 11.

**Known limits.** Claude and Codex results are cut at 100,000 characters by `streamResearch`'s existing ceiling. Base MCP
servers, command recipes and supporting agents never reach a job; workspace-write and repository access stay refused (§14 item
14). The CLI's own user-level configuration still applies (as in Origin Research). Gemini is verified with fakes only
(`CLIENT_UNSUPPORTED` live). A process left by a hard crash is not signalled after a restart (Task 06 rule). The Tasks list polls;
the "revoked after start" mark is computed from the agent's current Base state. Paid CLI runs: 3 (above).

**For Task 08 and Task 09.** `NetworkJobs.activity(own, { kind, label })` exists and calls `this.events?.append({ type:
'job.activity', jobId, attemptId, agentId, projectId, networkId, status, coverage?, message })` (async, never awaited); Task 08 only
adds the constructor option. The job view now has `lastActivity` (memory only) and `live: { process, coverage }`. The attempt has
`coverage`, `usage` (`costUsd`) and `nativeSessionId` after the worker reports. Worker refusals and runs use these codes:
`EXECUTION_POLICY_UNSUPPORTED`, `PROVIDER_UNSUPPORTED`, `TOOLS_UNSUPPORTED`, `BASE_REVOKED`, `BASE_ROOT_NOT_APPROVED`,
`BASE_CHANGED`, `BASE_REQUIRED_UNAVAILABLE` (also at submit), `NOT_INSTALLED`, `INVALID_OUTPUT` (unknown), the provider codes of
`FAILURE_MESSAGES`, `CLI_FAILED`, `OUTPUT_LIMIT`. `jobs.submit` refuses a required undeliverable Base resource; pipeline steps
(Task 09) get the same check. Result text: `GET /api/network/jobs/:id/result` or `jobs.result(id)`. Test helpers start the app
without a worker unless a test passes one (`networkWorker: undefined` selects the real one). Activity in the profile stays "soon"
for Task 08, which can replace the Tasks tab's polling with the stream.

**Commits** (local, `feat/network-07`, never pushed or merged): a6aab88 (worker, engine and shared changes, Tasks tab, tests),
b3fa6fb (Chrome test, live smoke script, usage confirmed), then this entry with the last test additions and fixes.

### Task 08 — Live activity and observability (2026-10-26, parallel wave A)

**What was done.** A durable, append-only event journal for Network (`src/network/events.mjs`), the job engine reporting
every saved status change to it, three read-only owner routes (the journal in pages, its NDJSON stream, and an Activity
summary), and two working screens: Network → Activity and the agent profile's Activity tab (`public/network-activity.js`).
Statuses come only from the job records and the journal (never from silence or a guess); each agent's status sits beside
what its CLI can report; Kanban runs of registered Base agents are listed read only from the board's own run records and
open their card. Costs and token counts appear only as reported; nothing shows a percentage. The stream replays from a
cursor and reconnects with the last sequence number, so each event shows once, also across a restart. Built in parallel
with Tasks 07 and 09 to architecture §17; decisions in architecture §19. The progress status table is left to the
coordinator.

**Files.** New: `src/network/events.mjs` (journal, pages, stream), `src/network/activity.mjs` (coverage, statuses, open
jobs, Kanban runs), `public/network-activity.js` (Activity UI), `tests/network-events.test.mjs`,
`tests/network-activity-ui.test.mjs`, `tests/network-activity-browser.test.mjs`. Changed: `src/network/jobs.mjs` (the
`events` option and `job.status` emission only), `src/network/http.mjs` (3 routes, a `stream` flag on route rows, `events`
and `board` in the route context), `src/server.mjs` (`NetworkEvents` created and given to the jobs and routes,
`networkEventOptions` option, `networkEvents` on the returned handle, `/network-activity.js` asset), `public/network.js`
(Activity section and profile tab, route `#/network/activity/<jobId>`), `public/app.js` (`stream` = `tokenFetch` and
`openTask` for the Network view), `public/index.html` (script), `public/styles.css` (Activity styles),
`tests/helpers/ui-harness.mjs` (evaluates `network-activity.js`; passes `networkWorker`/`networkEventOptions`),
`tests/network-ui.test.mjs` (Activity is no longer "soon"), `tests/remote-access.test.mjs` (3 rows),
`docs/network/architecture.md` (§19), this file.

**Journal format** (architecture §19 items 1–5): `<data>/network/events/<16-digit first seq>.jsonl`, created on the first
event; line 1 `{"schema":"promptboard.network-events","version":1,"first":n}`, then one event per line
`{ seq, id: evt_…, at, type, jobId?, attemptId?, agentId?, pipelineRunId?, networkId?, projectId?, nodeId?, status?, from?,
by?, kind?, errorCode?, coverage?, artifactRef?, message? }` (≤ 4 KiB; message one redacted line ≤ 500). `seq` strictly
increases across segments and restarts; damaged, duplicate or reordered lines are skipped and counted; a torn tail is
closed on load; 8 MiB segments, newest 16 kept, cursors survive retention (`gap`); a newer-version segment makes the
journal refuse reads and writes without touching a file.

**Routes** (behind `handle()`; allowed from a paired device, none local-only; rows in `tests/remote-access.test.mjs`):
`GET /api/network/events?after|before&limit&agentId&jobId&networkId&pipelineRunId`, `GET /api/network/events/stream?after`
(NDJSON: replay, `{"live":true}`, events, `{"ping":true}` every 15 s; 4 streams per client, 32 in all, 1 MiB unread →
dropped), `GET /api/network/activity` (agents' statuses with coverage, open jobs, Kanban runs, journal status).

**Job engine edit** (§17 item 2): `new NetworkJobs({ …, events })`; `#save` appends `job.status` when the saved status
differs from the previous one (`from`), `submit` appends the new job's (`from: null`); fields per §17 plus `pipelineRunId`,
`nodeId`, `coverage` and the completed result's `artifactRef`. Not awaited; every sink failure is swallowed.

**UI.** Network → Activity: a live line (role=status: connecting, live, reconnecting, paused at the stream ceiling,
stopped), each agent's card (status chip, provider and coverage label with its note, open-job counts, active Kanban runs),
the timeline (newest first; agent and event-kind filters, search, "Show older events", the retention note), "Running and
queued" (status, where it waits or since when it runs, what it reports, "Usage: not reported" unless reported, Details),
"Kanban runs (read only)" (card, project, stage, provider, reported usage and cost, Open in Kanban). Details opens one
job's record at `#/network/activity/<jobId>` (status, outcome, error, request summary, attempts with provider, coverage and
usage, result size and text once Task 07's result route exists, status history, the job's events; Back returns focus). The
agent profile's Activity tab shows that agent's status and coverage note, open jobs, Kanban runs and events, kept live. Zero
events, zero agents, load errors (Retry) and a journal that cannot be read each have their own state; no percentage or
progress bar anywhere; live redraws keep keyboard focus.

**Tests** (temporary data folders; jobs only through the fake worker; `job.activity` and `pipeline.*` events are synthetic
appends; no CLI):

- `tests/network-events.test.mjs` 8 tests: (1) every saved transition of four jobs (completed; cancelled while running;
  rejected; approved → unknown → retried → failed) is exactly one `job.status` event with the history's status, `from`
  and `by`; seq 1…N, unique `evt_` IDs, attempt IDs, the result's `artifactRef`; a forged "completed" changes no job; a
  restart journals the reconciled `interrupted` as the next seq; (2) a sink that throws, rejects, never answers, or a
  journal whose folder is a file: every job still completes with the same history, failures counted; (3) 30 synthetic
  events across types: forward pages of 7 and backward pages of 8 each give every event once; filters by agent, job,
  network, pipeline run and combined; a filtered empty page moves its cursor; `reset` past the newest; 10 bad queries 400;
  `kanban.*` and malformed types refused; unknown fields (`prompt`, `input`, `toolInput`, `result`) and bad shapes dropped;
  the same over HTTP with 403 without the token; (4) the stream over HTTP: `{"live":true}`, four live events of a job, a
  ping, close, a job while away, reconnect with the last seq → exactly the missed four before the live line, a restart of
  the server on the same folder, reconnect → the next four; 12 events each once and equal to the journal; no cursor →
  live only; a cursor past the newest → `reset`; `after=x` 400; (5) recovery: a non-JSON line, a duplicate seq, a corrupt
  middle line and a torn tail skipped and counted (4), the next seq is 7, segment 1 byte-identical, segment 2 only
  appended; a restart continues; a header-only segment fixes where seq continues (and a read moves past numbers no event
  holds); rollover at 1 KiB with 3 kept: names are first seqs, `gap` for an older cursor, a restart continues; a newer
  segment: read and stream 409, append null, files unchanged; (6) redaction: input, instructions, three secrets and a home
  folder appear in no journal file and no answer; the activity label is one line ≤ 500 with the folder cut and the key
  masked; every line ≤ 4 KiB; (7) four local streams, the fifth 429, a closed one torn down and its slot reused; a paired
  device is its own client and hears events; revoking it closes its stream within 2 s, tears it down, and it gets 401; a
  reader leaving more than 1 MiB unread is dropped; 32 streams in all, then 429; (8) `/api/network/activity`: statuses
  running, unknown, waiting_for_approval, waiting_for_input and none; counts; coverage tools/partial-tools/final-only/
  unknown with the Codex and Gemini notes; queue order and FIFO position; no input or result text and no "progress"; the
  Kanban runs of registered agents only (active first, reported usage, `null` when not reported), `state.json`
  byte-identical; a forged event moves nothing, an approval does; an interrupted job counts as unknown; pure
  `coverageOf`/`kanbanRuns`.
- `tests/network-activity-ui.test.mjs` 4 tests (jsdom, real server): (1) zero events and zero agents usable (each empty
  state, Go to Agents), then live without a reload: preparing/running, queued with its slot message and position, a
  synthetic web-search activity, waiting for input and unknown with different chip states, texts and marks, the Codex
  "Limited activity" note, focus kept on a Details button across live redraws, the feed equal to the journal, no `%`, no
  `$`, no progress bar, every control labelled; (2) all connections dropped: "reconnecting", then live again; events
  written while away shown once, eight in order, equal to the journal; (3) filters by agent and kind, search and Clear
  filters; a job's record (focus on its heading, four history entries, attempt, "Usage: not reported", result size, its
  events; Back returns focus to the button); catching up after leaving the section; Kanban runs with reported usage and
  cost, "cost: not reported" for tokens without a cost, Open in Kanban opens the card's details; the agent tab with its
  status, coverage, Kanban run and events, live, and only its own events; (4) retention: the newest 100 first, Show older
  events reads the rest (focus stays in the timeline), the retention note.
- `tests/network-activity-browser.test.mjs` 1 test (Chrome): light and dark at 1440 px (timeline beside the queue, nothing
  sideways) and 390 px (one column, queue first); waiting and unknown differ in colour, border (solid/dashed) and mark;
  chips follow the theme; no `%`; a live event without a reload; a job's record with focus on its heading and "Usage: not
  reported", Back returning focus; the agent tab with the Codex note; Tab into the timeline with a visible focus ring and
  Enter opening a record; no exception or CSP message (the dock's xterm.js messages for the seeded running Kanban run are
  excluded, as on Kanban). `PB_NETWORK_SCREENSHOTS=<folder>` saves the screenshots.
- Changed: `tests/network-ui.test.mjs` (Activity tab and section no longer "soon"; a report never shows in Activity),
  `tests/network-jobs.test.mjs` (the `network/` folder now also holds `events`), `tests/remote-access.test.mjs` (3 rows).
- Mutation check (`$TMPDIR/network-logs/task-08-mutations.log`, scratch edits restored after each): 40 of 40 mutations
  make a test fail (no emission, submit not journaled, a sink throw not caught, an awaited sink, duplicate seq accepted,
  torn tail not closed, no retention, no rollover, newer version read, seq restarting, no redaction, any field copied,
  kanban journaled, seq not advancing, a stuck filtered cursor, no gap, no reset, no replay, no per-client or total
  ceiling, no teardown, no backpressure, no ping, unregistered Kanban runs, no coverage, interrupted not unknown, invented
  usage, jobs without the journal, one client key for all, no reconnect, unknown drawn as waiting, cost always shown, no
  live append, focus dropped, Kanban card not opened, no older pages, agent tab not live, no gap note, Activity still
  "soon", the stream row missing from the paired-device table). Three survived the first round and each got a test
  (the cursor past reserved numbers, an interrupted job in the summary, tokens without a cost).

**Runs.** `npm run check` pass. New tests twice on the final code: 13/13 and 13/13 (12 non-browser, 1 Chrome;
`$TMPDIR/network-logs/task-08-new-twice.log`). Touched modules, non-browser (`network-*`, `remote-access`, `server`, `ui`,
`ui-2`, `ui-3`, `project-explorer-ui`, `sandbox-ui`, `base-server`, `cli`; `task-08-touched.log`): the first run found the
one Task 06 assertion that pinned the `network/` folder to `agents.json` and `jobs` (now with `events`), then 18/18;
the final run (`task-08-touched-final.log`) 278 tests, 277 pass, 1 fail: `network-jobs` "job routes over HTTP" with a
client-side `ECONNRESET` while running four files at once (its 1.1 MiB 413 request); alone it passed 4 of 4, and it
passed in the first run; it touches no Task 08 code path (the body is refused before a job exists). Touched browser files
(`network-browser`, `network-graph-browser`, `network-review-browser`, `remote-access-browser`, `browser`,
`app-fixes-browser`): 19/19 (`task-08-touched-browser.log`). The full `npm test` is left to the coordinator (parallel
wave rule). Isolated instance on port 4918 (temporary data folder, PATH holding only a `node` symlink): events page,
activity summary, stream `{"live":true,"last":0}`, 403 without the token; stopped and folder removed
(`task-08-port-4918.log`). Paid CLI runs: 0.

**Acceptance criteria and evidence** (screenshots in `$TMPDIR/network-logs/task-08-screens/`, all looked at:
`activity-{1440,390}-{light,dark}.png`, `activity-390-{light,dark}-timeline.png`, `activity-job-{1440,390}-{light,dark}.png`,
`agent-activity-1440-{light,dark}.png`):

- *Starting a job emits truthful queued/running/waiting/done or uncertain events; the dashboard updates without a
  refresh:* events tests 1, 4; UI test 1 (same window throughout); Chrome test (live event).
- *Restart and reconnection replay exact events once using stable cursors:* events tests 4 (across a server restart), 5
  (seq after restarts, cursors across retention); UI test 2.
- *An agent's feed includes its actual work, not fake posts:* events test 1 (only saved transitions), test 1/8 (a forged
  event changes nothing); UI test 3 (the agent tab shows only its own events); `network-ui` Posts test (a report never
  appears in Activity).
- *The Activity view is coherent when Codex only exposes limited lifecycle data:* events test 8 (partial-tools and its
  note), UI test 1 (the Codex card), Chrome test (the agent tab).
- acceptance.md Task 08 rows: 1 → events 1; 2 → events 3; 3 → events 4, UI 2; 4 → events 5; 5 → events 6 (+3); 6 → events
  7; 7 → UI 1, UI 3, Chrome; 8 → events 8, UI 3 (`src/supervisor.mjs` and `src/board.mjs` untouched). Failure matrix rows
  10, 11, 28 → events 5, 4, 7.
- Task prompt extras: the sink failing never breaks a transition → events 2; coverage labels → events 8, UI 1; no "100%"
  or fake completion → UI 1, Chrome, events 8.

**For Tasks 07 and 09 at merge.** Nothing more is needed for their events to show: Task 07's `jobs.activity()` and Task
09's runner call `append` with fields the journal keeps (checked against their worktrees while building, read only).
Optional: Task 07 may add `kind: item.kind` to its `job.activity` event so the timeline names it ("Web search", "Tool")
instead of "Activity". The job record shows result text through Task 07's `GET /jobs/:id/result` (`{ text }`) once
merged. Expected merge overlaps: `src/network/jobs.mjs` (constructor and `#save`/`submit` lines), `src/network/http.mjs`
route table, `src/server.mjs` near the `NetworkJobs` line, `public/network.js` (`PROFILE_TABS`), `tests/helpers/ui-harness.mjs`,
`tests/remote-access.test.mjs`, `tests/network-jobs.test.mjs`, `tests/network-ui.test.mjs`; all additive.

**Known limits.** Appends are not fsynced: a power loss (not an app crash) can lose the newest lines, and their numbers
may then be given to new events, so a reader whose cursor lies in the lost range skips that many new events (or reloads
when its cursor is past the newest). The summary re-reads every registration and open job (in memory) per call; the page
asks after events (300 ms debounce) and every 20 s. Kanban runs come from the board's newest 500 runs and refresh every 20
s (not streamed). Timeline search and filters work on the loaded events (newest 100, live ones, older pages); the server
filters by ID are used by the agent tab and the job record. The computer counts as one stream client: a fifth Activity
tab there pauses and retries every 15 s. A page read loads whole segment files (≤ 8 MiB) and looks at ≤ 50,000 lines.
`failures` counts since the app started. Until Task 07 is merged there are no real `job.activity` events and the result
text is not shown.

**Commits.** 4d275e7 (code and tests), then the tests for the three first-round survivors and this log entry.

### Task 09 — Pipeline compiler and runner (2026-10-26, wave A, branch `feat/network-09`)

**What was done.** Network pipelines: execution DAGs that belong to one network and pin one published version of it, kept as
a draft plus immutable published versions; a compiler that turns a published version into a pinned plan (nested
sub-pipelines expanded and version-pinned, agents checked against their registrations and network membership, scope,
typed ports and artifacts, bounded expansion); and a runner that executes the plan step by step as real Network jobs through
the job engine, with true parallel branches up to the caps, joins, typed conditions, owner approvals that survive restarts,
outputs saved as reports, bounded retries, step and run time limits, cancel, and restart reconciliation that counts only
proven results. Saving, validating and publishing start nothing; a run starts only with an explicit, confirmed start. No UI
(Task 10). The decisions, and the two deviations (retries are new jobs; `reports/<name>.md`), are in architecture.md §20.

**Files.** New: `src/network/pipeline-model.mjs` (drafts, versions, strict schema, validate/publish), `src/network/pipeline-compiler.mjs`
(`compilePipeline`, `order`, `decide`), `src/network/pipeline-runner.mjs` (`PipelineRunner`), `tests/network-pipeline.test.mjs`,
`tests/network-pipeline-http.test.mjs`. Changed: `src/network/jobs.mjs` (the §17 item 4 link and the `holds` guard),
`src/network/http.mjs` (13 routes, `pipelineRunId` job filter), `src/server.mjs` (pipelines and runner created after the job
engine, passed to the routes, `start()` after listening, `close()` before the job engine closes), `tests/remote-access.test.mjs`
(13 rows), `docs/network/architecture.md` (§20 at the end), this section. `acceptance.md` and the status table are unchanged
(wave rules).

**Data model** (created on the first save or start): `network/pipelines/<pip>.json` (`promptboard.pipeline-draft` v1 + `.bak`:
`id, networkId, networkVersion, name, description, settings { maxParallel 1–4, deadlineMs 1 min–24 h, failurePolicy },
nodes [{ id, type, label, position, config }], edges [{ id, from, to, fromPort, toPort }], publishedVersions [{ version,
sha256, publishedAt, networkVersion }], revision, createdAt, updatedAt`), `network/pipelines/<pip>/v<n>-<sha256>.json`
(`promptboard.pipeline-version` v1, immutable), `network/pipeline-runs/<run>/plan.json` (`promptboard.network-plan` v1,
immutable, hash in run.json), `run.json` (`promptboard.network-run` v1 + `.bak`: status, input, deadlineAt, pausedAt, step
states with `attempt, jobId, jobIds, inputs, result, decision, approval, errorCode, reason`, history ≤ 200) and
`reports/<name>.md`. Step results stay in their jobs' files, referenced by job, attempt and SHA-256.

**jobs.mjs edits** (small, for the merge with Tasks 07/08): `submit` accepts `pipeline: { runId, nodeId }` (validated
`RUN_ID`/`PLAN_NODE_ID`, exported) only from requester `{ kind: 'pipeline', id: runId }` (`PIPELINE_LINK_REFUSED` 403
otherwise), stores it as `job.pipelineRunId`/`nodeId` and `request.json.pipeline` (only when present: submission hashes and
earlier requests unchanged); `list({ pipelineRunId })`; a public `holds = null` field that the runner sets: the retention
sweep skips held jobs and `remove` answers `JOB_IN_USE` for them. Nothing else in the engine changed.

**Routes** (behind `handle()`, all allowed from a paired device, `localOnly()` unchanged): `GET/POST /api/network/pipelines`,
`GET/PATCH/DELETE /api/network/pipelines/:id`, `POST …/:id/validate`, `POST …/:id/publish`, `GET …/:id/versions/:n`,
`POST …/:id/runs` (`{ version, confirm: true, input? }` → 202), `GET /api/network/pipeline-runs`, `GET
/api/network/pipeline-runs/:id`, `POST …/:id/cancel`, `POST …/:id/nodes/:nodeId/approve` (`{ decision }`, nodeId may be
`<sub>/<step>`); `GET /api/network/jobs` also takes `pipelineRunId`.

**Tests** (temporary data folders, the deterministic fake worker of Task 06, no process, CLI or network):

- `tests/network-pipeline.test.mjs` 16 tests: (1) drafts and versions: execution edges stored apart from the network file
  (byte-identical, no relation in the pipeline file), strict schema (unknown config key, wrong ports, an edge out of an output,
  another toPort, self edge, loop with path, dangling include, mistyped rule value, code in a rule path, unpublished network
  version, maxParallel 5), publish v1 → edit → v2 with v1's bytes and hash unchanged, topological order, revision conflict,
  delete refused when published and allowed when not, a tampered version refused after a restart, no job and only the expected
  folders; (2) compiler refusals: missing agent, agent not in the network version, switched off, tools the provider cannot
  use, condition on a text port (and valid on its json port), output including a step that does not reach it, no output,
  duplicate output names, a crafted loop refused by the compiler itself, recursion, scope (a stranger network's pipeline,
  an unpublished version, an agent outside the network), 4 levels compile and 5 are refused (`PIPELINE_DEPTH` at the fifth),
  4 × 450 steps compile and 5 × 450 are refused; publish refused with the same code; (3) the MVP demo: both research jobs
  running at the same time (the fake's `active` = 2, both jobs `running`), the join and reviewer waiting for the second
  branch, the reviewer's input holding the run input and both results indented, approval waiting with no report, approve →
  `reports/report.md` exactly, run history, three linked jobs with keys and request links, `pipeline.run`/`pipeline.node`
  events with no result text; (4) condition true and false paths with skipped branches, decision evidence and inputs, the
  report noting a step that did not run, and the interpreter (no prototype keys, no `length`, missing matches nothing);
  (5) approval: still waiting after a restart and 3 hours, wrong answers refused, approve → completed with the deadline moved
  by the wait, reject → cancelled (stop and continue_independent); (6) cancel: open steps and both jobs cancelled, the worker
  told to stop both, nothing starts afterwards; (7) restart: an interrupted step job blocks with its reason, nothing
  resubmitted, the owner's retry resumes and completes it; a submit whose answer is lost is found by its key (one job) and
  a new runner after a restart completes it; (8) nested pinning: the plan's groups and pins, edits and republishes of the
  child pipeline, the parent and a network during the run leave plan.json byte-identical and the job instructions at v1,
  the nested report, a later run of v1 still v1 and of v2 v2; (9) revocation mid-run: the running step finishes, the next
  submit is refused, the run fails with the reason, a new start is refused; (10) a step over `timeoutMs` 1 s fails
  `TIMEOUT`; a run past its deadline fails `DEADLINE` with its job cancelled; (11) retries: 3 tries then failed, a flaky step
  recovering on its second job, `unknown` never retried, no retries by default; (12) receipts: forged lease and forged
  attempt ignored by the engine, a record naming another attempt's file (same bytes) blocked, a job of another run blocked,
  a changed result file blocked, an upstream result changed before the next step's submit blocks it (`ARTIFACT_INVALID`);
  (13) the job link: refused for the owner and a mismatched run, invalid IDs, stored and filtered, unlinked jobs unchanged,
  delete refused while the run is open, logs kept by the sweep while it is open and removed after; (14) caps: maxParallel 1
  runs one step at a time; with one job slot two runs submit one step in all; (15) continue_independent lets the other branch
  finish, a join of any goes on with the first branch, a Graph relation carries no data even when its source finished first;
  (16) damaged files: a run.json read from its backup becomes `interrupted` and never moves, a changed plan.json is
  unavailable, a pass that cannot be saved shows `passError` and recovers.
- `tests/network-pipeline-http.test.mjs` 1 test (real server, fake worker): token and Origin 403, 413 body, 404s, create,
  list, rename, conflict, validate, publish, version, delete refused, zero jobs and runs before the start,
  `CONFIRMATION_REQUIRED`, 202 start, list with step counts, approval waiting across a **server restart**, approve, completed
  with plan and linked jobs, `RUN_FINISHED`, cancel while waiting, approve after cancel refused, and the run input's secret in
  no file under `network/`.
- `tests/remote-access.test.mjs`: 13 new rows (every pipeline route exactly once).
- Mutation check (`$TMPDIR/network-logs/task-09-mutations.log`, final code): 53 of 53 mutations make a test fail (every
  compiler refusal, the interpreter's missing-value and own-key rules, strict config, ports, both loop checks, publish
  compiling, version hashes, join any, condition branches, both caps, the receipt's attempt, hash and link checks, the
  artifact hash, retry bound and eligibility, unknown blocking, approvals waiting, reject, deadline and its pause, cancelling
  jobs on halt and cancel, the idempotency key, scoped inputs, the stop policy, backup → interrupted, the pass error, holds,
  report order, events, the frozen version, the link refusal, filter, sweep guard and request field, the approve route row,
  the server's runner start, run-input cleaning). Five survived the first round and led to stronger tests (decoy file for the
  attempt check, the rejected step's status and a continue_independent rejection, a result finished elsewhere before the step
  is ready, a v1 run after the edits, a settled-state wait in the pool-ceiling check).
- Runs: `npm run check` pass. New and touched tests twice (`task-09-new-run1.log`, `task-09-new-run2.log`:
  `network-pipeline`, `network-pipeline-http`, `remote-access`, `network-jobs`): 52/52, then 51/52 — the failure is Task 06's
  `network-jobs` "job routes over HTTP" (`read ECONNRESET` on the 1,100 KiB body that gets 413: the server closes while the
  client still writes). It is **pre-existing**: the same test on base `db73249` (a `git archive` export, no worktree) failed
  4 of 12 times with the same error, and 1 of 6 on this branch alone; Task 09 does not touch that path. Every non-browser
  `network-*` test plus `remote-access` and `server`: 130/130 (`task-09-touched.log`); `network-browser`,
  `network-graph-browser`, `network-review-browser`, `remote-access-browser`: 6/6 (`task-09-touched-browser.log`). The full
  `npm test` was not run (wave rule: the coordinator runs it after merging).
- Isolated smoke on port 4919 (temporary data and projects folders, PATH holding only a `node` symlink, `node bin/ste.mjs
  --gui --no-open --port 4919`, no worker): register, network, pipeline create 200, publish 200 with zero jobs, start 202;
  the step's job `queued` waiting for a worker; stopped with SIGINT and started again: the same run `running`, the same single
  job still queued; stopped; folder removed. Paid CLI runs: 0.

**Acceptance criteria and evidence:**

- *Two branches → join → reviewer → approval → final output works with simulated and at least one actual CLI path:* simulated:
  `network-pipeline` test 3 and the HTTP test. The actual CLI path needs Task 07's worker, built in parallel: not run here
  (Task 14's live smoke after the merge; `tests/network-pipeline-e2e.test.mjs` with fake CLIs through the real worker also
  waits for Task 07).
- *A pipeline cannot run an untrusted graph connection merely because one was drawn:* test 15 (a `share_result` relation moves
  no data), test 1 (pipeline edges stored apart; the network file untouched), test 2 (membership and scope), runs need an
  explicit confirmed start (test 3, HTTP test).
- *Active runs keep their exact published version even after editing:* test 8 (plan.json byte-identical, v1 instructions,
  a later v1 run still v1), HTTP test (plan pins).
- *A failed/unknown parent job prevents unsafe dependent execution and is diagnosable:* tests 7, 11, 12 (blocked with the
  job's code and a reason naming it; descendants pending; nothing resubmitted), 9 and 15 (failed parent → descendants
  cancelled `UPSTREAM_FAILED`), 16 (`passError`).
- acceptance.md Task 09 rows: 1 → test 2 (+ test 1 for unknown config keys); 2 → tests 3, 4, 15; 3 → test 5 and the HTTP
  test (only the owner route approves); 4 → test 8; 5 → test 7; 6 → test 7; 7 → test 6 and the HTTP test; 8 → tests 10, 11
  (retries are new jobs, architecture §20 item 9); 9 → tests 3, 4, 8; 10 → test 12. Failure matrix rows 22–26 → tests 7, 5,
  8, 7, 12.

**What Tasks 07, 08 and 10 must know.**

- **Task 07:** pipeline step jobs are ordinary jobs with `source: 'pipeline'`, `requester { kind: 'pipeline', id: runId }`,
  `pipelineRunId`, `nodeId` and `request.json.pipeline`; their `input.text` already holds indented upstream results (put it
  through `indent()` inside the job-input section as §7.2 says), `input.json` may hold `{ run?, steps: { <stepId>: json } }`,
  `networkId` is the step's network and memory the default `agent`. The runner trusts only `job.result` of the current
  attempt with the recorded SHA-256 (`result.md`, optional `result.json`), so the worker must report results through
  `finish` as Task 06 defined. A worker that sets `sideEffects: 'external_unknown'` makes a failed step not retried.
- **Task 08:** `server.mjs` passes `events: networkJobs.events ?? null` to the runner, so once `NetworkJobs` keeps
  `this.events` the runner appends `pipeline.run` and `pipeline.node` events (§20 item 15) with no other change. Their
  `message` is a one-line reason ≤ 500 characters; filter by `pipelineRunId`.
- **Task 10:** everything is JSON over the routes above. `GET /api/network/pipelines/:id` is the draft; `POST …/validate`
  answers `{ valid, summary: { steps, agentSteps, groups, order, pins } }` or `{ valid: false, error: { code, message,
  details: { nodeId, edgeId, path, … } } }` to mark a step or edge; `GET /api/network/pipeline-runs/:id` is `{ run, plan }`
  (plan `groups` give the nested hierarchy, `run.nodes[stepId]` the state, decision, approval and result refs, `passError`
  a failing save). The designer must send whole `nodes`/`edges` with `expectedRevision`, n_/e_ IDs and the ports of §20
  item 2. The report is `reports/<name>.md` in the run folder; there is no report route yet (add one, or read it through
  the step's `result.text.ref`).

**Known limits.** The runner polls (`pollMs` 1 s in the app), so a step starts up to a second after its inputs complete. One
queue serializes every run change and rewrites `run.json` whole (`ponytail:` note): fine for hundreds of steps, not for
thousands at a high rate. A step job queued without a worker shows the step `running` (its job says it waits for a worker).
A run whose step is blocked on a completed job with a broken receipt stays blocked until the owner cancels it. Tokens and
cost are not enforced. No pipeline export/import, no start idempotency key, no report download route, no UI. A sub-pipeline's
own settings are ignored. Pipeline jobs never carry a project (no project lessons). The fake-CLI end-to-end and the live
smoke wait for Task 07. Task 06's ECONNRESET flake above is pre-existing and was not changed here.

**Commits.** See `git log feat/network-09` (Task 09 code and tests, then this log entry).

### Wave A integration (2026-10-26, after the merge of Tasks 07, 08 and 09)

**What was done.** The three wave-A lanes were checked against each other in the real app and the gaps closed: every event
type reaches the journal through `startServer`, the Activity view names worker activity by its kind and ties a pipeline step's
job to its run, the job record shows the result text, and the agent's Tasks tab now follows the same event stream as Activity
instead of polling every 2 seconds. Task 09's deferred `tests/network-pipeline-e2e.test.mjs` runs the MVP pipeline through the
real local worker with fake CLIs, and a bounded live smoke ran a two-step parallel pipeline on the real Codex CLI.

**Wiring checked; each gap fixed with a test that fails without the fix (the result text needed no change and is now covered).**

- *Events in the real server.* `job.status` (Task 08's engine hook), `pipeline.run`/`pipeline.node` (Task 09's runner, given
  `networkEvents` at the merge) and `job.activity` (Task 07's `jobs.activity()`) all reach `network/events/`. Gap: the activity
  event had no `kind` and no pipeline link, so the timeline showed every activity as "Activity" and
  `GET /api/network/events?pipelineRunId=` missed a run's activity. `src/network/jobs.mjs` now adds `kind`, `pipelineRunId` and
  `nodeId` (journal fields Task 08 already keeps); architecture §18 item 10 updated.
- *Activity shows each type sensibly.* `job.activity` reads "Web search", "Tool", "Writing", "Status" (Task 08's labels, now fed);
  `job.status` and `pipeline.*` as before.
- *Result text.* Task 08 had already wired Task 07's `GET /api/network/jobs/:id/result` into the job record; now covered by a test
  with real result text (shown as text, a `<script>` stays text).
- *Step jobs linked to their run.* A step job's timeline entries read "Job abc123 (pipeline run def456, step n_…) · …", its row
  in Running and queued names the run and step, and its record has "Pipeline run" (button "Run def456: show its events": the
  timeline searched by that run ID, focus in the search field) and "Pipeline step". There is no run view yet (Task 10), so the
  link targets the timeline.
- *Tasks tab and Activity.* They never ran at the same time (each only while its own tab shows), so nothing fought; Task 07 left
  the switch to the stream to Task 08. Now `network-activity.js`'s `create(host)` takes `onEvent(event)` and
  `onLive(state, was)` and answers `streaming()`; `network.js` keeps the page's one stream open while the profile shows Tasks or
  Activity (`STREAM_TABS`). On the Tasks tab, every `job.status` event (queue positions move with any agent's jobs) or a job
  event of this agent reads the list again (debounced 250 ms); while the stream is live the timer is a 30 s safety read for what
  is not journaled (a sign-in wait, the slot count); when the stream is not live (refused at the 4-per-computer ceiling,
  reconnecting) it polls every 2 s / 10 s as before, and a drop from live reads at once. Architecture §18 item 15 and §19 item 12
  updated. Found on the way: Task 07's jsdom tests closed their window while the stream reconnected, and the new listener threw
  (`location is not defined`) inside the stream loop; listeners are now guarded so a throwing one never stops the stream.
- *Fake CLI.* `tests/fixtures/fake-headless-cli.mjs` gained `[[barrier:<name>:<n>]]`: a run waits until `n` runs carrying the
  same barrier have started (exit 4 after 30 s), so parallelism is proven by a handshake, not by timing.

**Tests.**

- `tests/network-pipeline-e2e.test.mjs` (1 test, about 13 s): `startServer` with the default `LocalJobWorker`, `PATH` = fake
  `claude` and `codex` plus a `node` symlink only. The MVP pipeline (Research A on Claude and Research B on Codex, both with the
  barrier → join → Review → approval → output) followed through the NDJSON stream: both research jobs `running` before either
  `completed` (and the barrier itself would fail a sequential run), the reviewer queued only after both, its input holding the
  run input and both results indented; the approval waits for 2.5 s with no CLI run and no `reports/`, then **across an app
  restart** (stream reconnected from its last seq); a non-approval step refuses a decision; approve → `reports/report.md`
  exactly, run history `running → waiting_for_approval → running → completed`; one job per step with keys
  `run:<id>:node:<step>:a1`, three CLI runs in all; the run's journal holds `job.status` (each job `queued → preparing → running
  → completed` with its step), `job.activity` (with `kind`, `nodeId`, `agentId`; started then writing), `pipeline.node` (naming
  each job) and `pipeline.run`, and the stream gave exactly the journal's events once, in order; no event holds a result or the
  input. Run 2 cancelled while both research CLIs hang: run and steps cancelled, both process groups (CLI and helper) gone, no
  reviewer, no new job. Run 3: the app stops while both hang: groups gone; after the restart the run is `blocked` on both steps
  (`APP_STOPPED`, "Retry the job (confirming it) or close it"), jobs `interrupted`/`uncertain`, nothing resubmitted or relaunched
  after 2.5 s; the owner cancels it. Throughout, a `child_process` recorder sees only `claude` and `codex` (never `git`), every
  file outside `network/` (except the instance lock) and `state.json` are byte-identical, and the board view is unchanged.
- `tests/network-integration-ui.test.mjs` (2 tests, jsdom, real server, fake worker driven through the engine's own calls):
  (1) a pipeline run's step job: its `job.activity` (kind web) appears as "… (pipeline run …, step …) · Web search", its status
  event and queue row name the run and step; its record shows the result text from the result route as text and the run link,
  which opens the timeline searched by the run (focus in the search) showing exactly the journal's events of that run, all four
  types. (2) The Tasks tab with the stream live: activity and the completion read the list on their events, and no list read
  happens for 2.6 s while a job is open; with every stream slot of the computer taken (the page's stream refused, "limited"), the
  tab polls again and shows new activity.
- Mutation checks (scratch edits restored, `git diff` checked after each): the e2e test fails without the `jobs.mjs` change (no
  `job.activity` in the run's journal) and with the runner's per-run cap forced to 1 (the barrier keeps the first research step
  waiting, the run never reaches its approval); the UI tests fail with `public/network.js` reverted (Tasks test), with
  `public/network-activity.js` reverted (both) and with `src/network/jobs.mjs` reverted (Activity test).
- Runs: `npm run check` pass; the new tests twice, 3/3 and 3/3 (`$TMPDIR/network-logs/wave-a-new-run{1,2}.log`); every
  non-browser and browser `network-*` file plus `remote-access` and `server` (`wave-a-touched*.log`): the first run found the
  listener throw above (2 Task 07 jsdom tests), then 36/36 for the touched jsdom/engine files and 4/4 for `network-tasks-browser`,
  `network-activity-browser` and `network-browser` in Chrome.

**Live smoke** (`PB_NETWORK_LIVE=codex node scripts/network-pipeline-live-smoke.mjs`, 2026-10-26 11:07:39–11:07:47 UTC, log
`$TMPDIR/network-logs/wave-a-live.log`): an isolated app on port 4930 with a temporary data folder (removed afterwards), the
app's own local worker, `PATH` holding only a Codex wrapper (it runs the real Codex by absolute path with the original `PATH`)
and `node`. One Base agent (Codex, effort low) in a published one-agent network; pipeline "Benefit" and "Risk" (two agent steps,
no retries) → join → output. **2 real Codex runs**, no retry needed: the run `completed` in 8 s; both jobs `completed`, exit 0,
`partial-tools`, usage reported (2,313/17 and 2,309/18 input/output tokens, 8,192 cached each); they ran in parallel (spawned 22 ms
apart, each about 5.5 s); the journal held `pipeline.run` 2, `pipeline.node` 10, `job.status` 8 and `job.activity` 4 (kinds
`status`, `text`); `reports/report.md` held both one-sentence answers under their step labels. Logged in "Live provider runs".

**Full suite.**

- Baseline, the merged HEAD `403e184` before any integration change (a `git archive` export with this worktree's
  `node_modules`, `$TMPDIR/network-logs/wave-a-baseline-suite.log`, about 10:56–11:29 UTC): `npm run check` pass; non-browser 1,627 tests,
  1,626 pass, 0 fail, 1 skipped (the win32-only `editors.test.mjs` test); browser 153/153. Exit 0. (The last full run before wave
  A: 1,585 non-browser tests, 1 skipped, and 151 browser; wave A added 42 non-browser tests, 13 + 12 + 17, and 2 browser.)
- Run 1 on the integration commit `730c862` (`$TMPDIR/network-logs/wave-a-integration-suite-run1.log`, 11:30–12:00 UTC):
  `npm run check` pass; non-browser 1,630 tests (the baseline's 1,627 + the 3 new), 1,629 pass, 0 fail, 0 cancelled, 1 skipped
  (the same win32-only test); browser 153/153. Exit 0, no reruns. The new tests took 13.6 s (end to end), 1.9 s and 8.1 s.
- Run 2, the same commit (`$TMPDIR/network-logs/wave-a-integration-suite.log`, 12:00–12:30 UTC): `npm run check` pass;
  non-browser 1,630 tests, 1,629 pass, 0 fail, 0 cancelled, 1 skipped; browser 153/153. Exit 0, no reruns.
- No failure appeared in any of the three full runs, so nothing needed a timing fix; Task 06's known `ECONNRESET` flake in
  `network-jobs` "job routes over HTTP" did not occur.

**For wave B at merge (Tasks 10 and 11).**

- *Merge overlaps:* `public/network.js` (the `activity` creation line now passes `onEvent`/`onLive`; `STREAM_TABS`; the
  `activity?.live(...)` lines in `render()` and `showInner()`; `loadJobs()`'s scheduling and the new `tasksShown`, `tasksEvent`,
  `tasksLive`), `public/network-activity.js` (`setLive`, `receive`, `describe`, `queueRow`, `renderJob`/`runLink`, the returned
  object), `src/network/jobs.mjs` (`activity()`'s event), `tests/fixtures/fake-headless-cli.mjs`, architecture §18 items 10 and
  15 and §19 item 12 (edited in place; no new section, so the lanes' appended sections do not collide with this one).
- *Task 10 (designer and run view):* the page keeps **one** event stream (4 per computer); a run view should follow it through
  the same `create(host)` hooks rather than open a second stream: extend `network.js`'s `onEvent` to dispatch `pipeline.*` and
  step-job events to the run view and include its section in the `activity.live(...)` condition. `GET
  /api/network/events?pipelineRunId=` now also returns the run's `job.activity` events. The job record's "Run …: show its events"
  button (`runLink` in `network-activity.js`) should open the run view once it exists. `[[barrier:…]]` and
  `tests/network-pipeline-e2e.test.mjs` show how to run pipelines on the real worker with fakes.
- *Task 11 (REST/MCP):* `job.activity` events now carry `kind`, `pipelineRunId` and `nodeId`; a machine-facing event or job view
  that allowlists fields should decide whether to pass them (they are IDs and a lower-case word, no content). Nothing in
  `src/network/http.mjs`, `events.mjs` or the route table changed here.

**Known limits.** The Tasks tab's 30 s safety read means a change that is not journaled (a sign-in wait, a new slot count) can
take up to 30 s to show while the stream is live. With the Tasks tab open the page also reads the Activity summary (after events
and every 20 s), as the Activity tab does. The run link searches the loaded timeline (newest 100 events, live ones, older pages),
not the whole journal. Paid CLI runs: 2.

**Commits** (local `feat/network`, never pushed or merged): 730c862 (wiring, tests, smoke script, architecture §18/§19), then this log
entry with the "Live provider runs" table.
