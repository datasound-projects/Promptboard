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

## Status

| Task | File | Status | Commit |
|---:|---|---|---|
| 01 | 01-audit-and-contracts.md | done | 27646ef |
| 02 | 02-registry-and-storage.md | done | 7771788 |
| 03 | 03-network-page-and-agent-profiles.md | done | 9edf549 |
| 04 | 04-agent-memory-and-feed.md | done | 1fc58b6 |
| 05 | 05-graph-designer-and-subnetworks.md | done | 47447fc |
| 06 | 06-general-purpose-job-engine.md | done | |
| 07 | 07-local-worker-runtime.md | pending | |
| 08 | 08-live-activity-and-observability.md | pending | |
| 09 | 09-pipeline-dag-engine.md | pending | |
| 10 | 10-pipeline-designer-and-network-run-ui.md | pending | |
| 11 | 11-private-api-and-mcp.md | pending | |
| 12 | 12-delegation-and-triggers.md | pending | |
| 13 | 13-a2a-federation.md | pending | |
| 14 | 14-verification-and-release.md | pending | |

**Next task:** 07

## Live provider runs

None yet.

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

**Commit.** (Task 06 commit, recorded in the next commit), then this log entry.

**Next task: 07.**
