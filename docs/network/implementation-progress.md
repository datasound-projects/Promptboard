# Network implementation progress

**Publication follow-up, 2026-11-02:** the owner explicitly authorized the isolated preview, commit, push and a pull
request for CI/review. This supersedes the earlier no-commit/no-push instruction. Main remains unchanged.

**Continuation, 2026-10-30:** the combined review copy is `network-continuation/`, branch
`codex/network-continuation`. The final verification record is at the end of this document. The earlier task entries
and their local commits are historical evidence; the October 30 continuation made no new commit or push.

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
| 10 | 10-pipeline-designer-and-network-run-ui.md | done (merged) | 6bc96d1 |
| 11 | 11-private-api-and-mcp.md | done (merged) | a1d6642 |
| 12 | 12-delegation-and-triggers.md | done (merged) | 7d3adb5 |
| 13 | 13-a2a-federation.md | done; combined with wave B and all reviews | 2ab3277, 69f1c8f; uncommitted continuation |
| 14 | 14-verification-and-release.md | done; syntax, full regression, Chrome, compatibility and audit verified | 6318d2c, 140b67e; uncommitted continuation |

**Next:** Ready for review in the combined continuation at `network-continuation/`, branch
`codex/network-continuation` (based on `feat/network` 970eaea). The owner's 2026-10-30 handoff instruction supersedes
the earlier local-commit rules: no new commit, push or change to main. Original worktrees remain preserved.

## Live provider runs

Every real (paid) CLI run, in order. Eight in all so far.

| When (UTC) | Task | Provider | Model / effort | Purpose | Result |
|---|---|---|---|---|---|
| 2026-10-26 10:25 | 07 | Codex CLI | CLI default, effort low | one job end to end, usage fields (R1) | completed in 7 s (details in "Task 07") |
| 2026-10-26 10:25 | 07 | Claude Code | haiku | one job end to end, usage fields (R1) | completed in 5 s |
| 2026-10-26 10:25 | 07 | Gemini CLI | CLI default | one job end to end | failed `CLIENT_UNSUPPORTED` (provider refused the client); not retried |
| 2026-10-26 11:07 | wave A integration | Codex CLI | CLI default, effort low | pipeline step "Benefit" (two parallel steps → join → output) | completed, exit 0, 5.5 s, `partial-tools`, usage reported |
| 2026-10-26 11:07 | wave A integration | Codex CLI | CLI default, effort low | pipeline step "Risk" (the parallel branch) | completed, exit 0, 5.5 s, `partial-tools`, usage reported |
| 2026-10-26 12:30 | 12 | Claude Code | haiku | delegation: parent emits the request block (`scripts/network-delegation-live.mjs`) | completed; request exactly as specified; $0.0015 |
| 2026-10-26 12:30 | 12 | Claude Code | haiku | delegation: parent's second attempt reads the sub-job result | completed; its new delegation refused by fan-out, recorded; $0.0017 |
| 2026-10-26 (afternoon) | 13 | Codex CLI | CLI default, effort low | one inbound A2A task (official SDK client → machine listener → local worker; `scripts/network-a2a-live-smoke.mjs`) | task COMPLETED in 6 s, job `completed` (`source: a2a`), exit 0, `partial-tools`, usage reported |

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

### Task 11 — Private REST and MCP for external clients (2026-10-26, parallel wave B)

**What was done.** Apps and MCP hosts on this computer can reuse registered agents through Network jobs without owner
access. The owner turns on a separate machine listener (off by default, 127.0.0.1 only), creates scope-limited clients
(agents, networks, projects, permissions) whose bearer token is shown once and stored only as its SHA-256, and revokes or
rotates them. The REST gateway serves only `/machine/v1/*`: scoped agents, submit (202 with a `jobId` at once), the
client's own jobs, cancel, the result and an event page and NDJSON stream of its own jobs. `node bin/ste.mjs --mcp` is a
stdio MCP server (official `@modelcontextprotocol/server` 2.3.1) that calls that gateway with one token from its
environment. Network → Settings holds the listener, the clients and setup snippets for Claude Code, Codex, other MCP hosts
and REST. Built in parallel with Tasks 07 and 10; decisions in architecture §22. The progress status table is left to the
coordinator.

**Files.** New: `src/network/machine-auth.mjs` (clients, tokens, listener settings), `src/network/rest.mjs` (listener and
gateway), `src/network/mcp.mjs` (stdio MCP server), `public/network-clients.js` (Settings UI), `tests/network-machine.test.mjs`,
`tests/network-mcp.test.mjs`, `tests/network-clients-ui.test.mjs`, `tests/network-clients-browser.test.mjs`,
`tests/helpers/network-machine.mjs`. Changed: `src/network/http.mjs` (6 routes, `machine` in the route context),
`src/network/jobs.mjs` (`result(id)` byte-identical to Task 07's; `cancel(id, input, { by })`), `src/network/events.mjs`
(a server-only `view` option on `read` and `stream`), `src/server.mjs` (`MachineListener` created, started after listening,
closed at shutdown; `machineOptions`; `machine` on the returned handle; `Bearer pbm_…` refused on owner routes;
`/network-clients.js` asset), `src/remote-access.mjs` (`localOnly`: create, rotate, listener), `bin/ste.mjs` (`--mcp`;
a `pbm_` value is never repeated in an option error), `public/network.js` (Settings section), `public/index.html`,
`public/styles.css`, `tests/helpers/ui-harness.mjs` (evaluates `network-clients.js`), `tests/network-ui.test.mjs` (the
seventh tab), `tests/remote-access.test.mjs` (6 rows), `package.json`, `package-lock.json`, `THIRD_PARTY_NOTICES.md`,
`docs/network/architecture.md` (§22), this file.

**Dependency.** `@modelcontextprotocol/server` 2.3.1 (Apache-2.0, published 2026-10-05; the same release as the installed
client and core 2.3.1; dependencies `zod ^4.2.0` and core 2.3.1; 2.4.0 of 2026-10-23 is too new) and `zod` 4.6.7 (MIT,
2026-10-12, already installed by the SDKs, now a direct dependency because `mcp.mjs` imports it), both `--save-exact`.
`npm audit`: 0 vulnerabilities. The server LICENSE equals the client's; the notice heading lists it.

**Data layout.** `<data>/network/clients.json` (`promptboard.network-clients` v1 + `.bak`, 0600), created on the first
client or listener change: `{ revision, listener: { enabled, port }, clients: [{ id: cli_…, kind: 'api', name, tokenSha256,
tokenHint, createdAt, lastUsedAt, expiresAt, revokedAt, rotatedAt, revision, scopes: { agents, networks, projects,
permissions } }] }`. Jobs of a client are ordinary jobs with `source: 'machine'`, `requester: { kind: 'machine', id }`.

**Auth model.** Token `pbm_<cli_id>_<43 base64url>` (32 random bytes), shown once (create, rotate), stored as SHA-256,
compared in constant time; revoke final; rotate keeps the client, its jobs and keys; optional expiry 1–365 days. Order of
checks on the listener: Host (`127.0.0.1:<port>`/`localhost:<port>`), Origin (its own only), cross-site, proxy headers,
owner token or `pb_remote` cookie (`403 MACHINE_CREDENTIAL_REQUIRED`), `/machine/v1/` only, bearer (`401
MACHINE_UNAUTHORIZED`), 60 requests/min per client (`429`), the route's permission (`403 PERMISSION_DENIED`), then scopes
(`AGENT_NOT_ALLOWED`, `PROJECT_NOT_ALLOWED`, `NETWORK_NOT_ALLOWED`, `MEMORY_NOT_ALLOWED`), 10 submits/min, JSON ≤ 256 KiB.
No CORS header ever. The owner app refuses `Authorization: Bearer pbm_…` (`403 MACHINE_TOKEN_REFUSED`).

**REST endpoints** (`/machine/v1`): `GET /agents`, `GET /agents/:id` (`read_agents`); `POST /jobs` (`submit_jobs`,
`Idempotency-Key` header, 202/200); `GET /jobs`, `GET /jobs/:id` (own only); `POST /jobs/:id/cancel` (`cancel_own_jobs`);
`GET /jobs/:id/result` (`read_job_result`); `GET /events?after&limit`, `GET /events/stream?after` (own jobs, narrow fields).

**MCP tools** (`node bin/ste.mjs --mcp`; `PROMPTBOARD_MACHINE_TOKEN` or `PROMPTBOARD_MACHINE_TOKEN_FILE`,
`PROMPTBOARD_MACHINE_URL` loopback only): `agents_list`, `agents_get`, `jobs_submit` (jobId at once), `jobs_get`,
`jobs_cancel`, `artifacts_get` (windows ≤ 60,000 bytes); strict zod schemas; no write beyond queueing a read-only job or
cancelling an own one.

**Owner routes.** `GET /api/network/clients` (allowed from a paired device), `POST /api/network/clients` (local-only),
`DELETE /api/network/clients/:id` (allowed: revoking only removes access), `POST /api/network/clients/:id/rotate`
(local-only), `GET /api/network/listener` (allowed), `PATCH /api/network/listener` (local-only). All six are in
`NETWORK_ROUTES` with their rows.

**UI.** Network → Settings (`#/network/settings`, seventh tab and sidebar link): "Machine listener" (switch, port, status
line: off / on at its URL / its error), "Clients" (create with name, agents, permissions with memory off by default,
projects, networks, expiry; each client's scopes, `pbm_…` hint, created, last used, expiry; Rotate token and Revoke with
confirmation; active first), "Connect an MCP host" (Claude Code / Codex / Other MCP hosts / REST snippets with the
variable name only; Copy snippet). The token shows once in the module's own dialog with "Copy it now: Promptboard will not
show this token again", reaches the clipboard only on Copy, and leaves the page when the dialog closes.

**Tests** (temporary data folders, the fake worker or none, no CLI; the MCP host is the real
`@modelcontextprotocol/client` 2.3.1 starting `node bin/ste.mjs --mcp`):

- `tests/network-machine.test.mjs` 10 tests: (1) off by default: every Network read opens no port and writes no file;
  refused listener changes write nothing; on: 127.0.0.1 only (another address of this computer is refused), the app port
  refused; off closes the port; (2) clients: refusals (no agent, unknown agent/project/network, bad permission, two-line
  name, bad expiry, extra fields), the token once, only its hash on disk, never in a list; rotate (revision, new token,
  same client, old token 401, its job still its own); expiry (injected clock); revoke final and idempotent; malformed and
  forged tokens 401; (3) REST: only scoped agents with public fields and no Base content, 403 for others (also unknown
  IDs), submit 202 at once, poll, result 404 before completion then text and json, another client's and the owner's jobs
  404 on read, result and cancel, own list, cancel while queued (`by: machine`) and while running (the worker stopped),
  the event page only own jobs with narrow fields; (4) denials: agent, project, network, memory, lessons outside the scope
  403; owner-only fields 400; memory `none` by default, `agent` and lessons with `read_scoped_memory`; each permission;
  no admin route on the listener; a machine token on owner routes 403 (`MACHINE_TOKEN_REFUSED` even beside the owner
  token); the owner token and a `pb_remote` cookie on the listener 403; (5) Host (six rebinding names), Origin (four),
  cross-site, six proxy headers, no CORS header on any answer (a preflight too), 415, 400, 413, 10 submits then 429, the
  61st request 429 with `Retry-After`, another client unaffected; (6) idempotency: same key same job (200), changed body
  409, another client's key its own job, a lost answer and its retry one job, revoked token replays 401; (7) the stream:
  own events only, replay from 0 each once, 4 per client, 5 machine streams in the test (8 by default), rotation and
  revocation end the streams at once, the freed places reused; (8) no token or secret in any `network/` file, event,
  answer after creation, console or stderr; the export holds no client; (9) restart: clients and the listener setting
  persist, the listener comes back, a queued job without a worker says so, a worker after a restart runs it and the client
  reads the result; (10) paired device: lists and revokes, `REMOTE_LOCAL_ONLY` for create, rotate and listener, its
  listener never reaches the machine listener, a machine token there is refused, its cookie is refused on the machine
  listener.
- `tests/network-mcp.test.mjs` 3 tests: (1) a real MCP client: six strict tools, `agents_list` only the allowed agent,
  `jobs_submit` answers at once, `jobs_get` until completed, `artifacts_get`, a retried key the same job, a ~170 KB result
  in three or more windows each ≤ 60,000 bytes that read back whole, `jobs_cancel` of an own waiting job, refusals as
  tool errors (agent outside the scope, memory, unknown job, extra or malformed arguments, no result yet), no refused call
  makes a job, no token in any answer or the bridge's stderr; (2) same-provider nesting: with one slot held by a running
  Claude job, an MCP `jobs_submit` for the same provider answers in well under 3 s as `queued`, five polls stay queued
  behind it, the outer job keeps running, then the nested job runs and its result is read; (3) the bridge: `--mcp` with
  any other option or a token in argv exits 1 without repeating it; missing, malformed or unreadable tokens and
  non-loopback, https, credentialed or path URLs exit 1 with nothing on stdout; a token file works; revoked → tool error
  `MACHINE_UNAUTHORIZED`; the listener off → a clear tool error; no token anywhere.
- `tests/network-clients-ui.test.mjs` 1 test (jsdom): opening Network and Settings writes nothing and opens no port; the
  snippets name the variable before and after; Create without agents explains; Escape returns focus; port saved, listener
  on, the app port and a low port refused; the form's labels and default permissions; validation; the token once (focus on
  it), nothing on the clipboard until Copy, the token works, Done removes it from the page and returns focus; the list shows
  only the hint; every snippet copied holds no token; rotate (confirm, new token, old 401, Escape removes it); revoke
  (confirm, revoked without actions, 401, status line); off; leaving the section closes the dialog.
- `tests/network-clients-browser.test.mjs` 1 test (Chrome): light and dark at 1440 px (listener and setup beside the
  clients) and 390 px (one column, nothing sideways, the snippet wraps), the create and token dialogs at both widths, the
  token gone after Done, Tab to Create with a visible ring, Enter opens with the name focused, Tab to the agents, Escape
  returns focus, Tab to the switch with a visible ring and Space turns it off, no exception or CSP message.
- Changed: `tests/network-ui.test.mjs` (the seventh tab and End/Home/arrow order), `tests/remote-access.test.mjs` (3
  local-only and 3 allowed rows).
- Mutation check (`$TMPDIR/network-logs/task-11-mutations.log`, each source restored after its run): 52 of 52 plus 3 for the
  paired-device test make a test fail (owner-route refusal, Host, Origin, fetch-site, proxy, owner credential, agent scope
  on submit, read and list, project, network, memory refusal and default, own jobs, per-route permission, both rate limits,
  JSON only, revoke teardown, the machine stream cap and its release, both event filters, the narrow agent and job, the
  idempotency header, loopback bind, reserved ports, off by default, hash compare, revoked and expired refusal, rotation
  replacing the hash, the hidden hash, the token not stored, agents checked at creation, revoke notification, local-only
  routes, cancel by machine, the journal's stream view, MCP submit not waiting, MCP loopback only, strict schemas, result
  windows, the CLI's token masking and lone `--mcp`, the listener's start and shutdown, the token leaving the page, no
  automatic clipboard, the dialog closing on leave, the Settings tab). Two (the stream cap, shutdown) fail by timing out.

**Runs.** `npm run check` pass. New and changed tests twice on the final code: 40/40 and 40/40 (`network-machine`,
`network-mcp`, `network-clients-ui`, `network-ui`, `remote-access`) plus the Chrome test 1/1 twice
(`$TMPDIR/network-logs/task-11-new-twice.log`). Touched modules: see `task-11-touched-final.log` (every `network-*`
non-browser file, `remote-access`, `server`, `cli`, `compose-mcp`, `base-server`, `ui`, `ui-2`, `ui-3`,
`project-explorer-ui`, `sandbox-ui`) and `task-11-touched-browser.log` (`network-browser`, `network-graph-browser`,
`network-review-browser`, `network-activity-browser`, `network-clients-browser`, `remote-access-browser`: 8/8). The first
touched run found the release-metadata test needing the new package in `THIRD_PARTY_NOTICES.md` (fixed); the final one
(`task-11-touched-final.log`): 299 tests, 298 pass, 1 fail: `network-jobs` "job routes over HTTP" with a client-side
`ECONNRESET` on its 1.1 MiB 413 request (Task 08's known flake); alone it failed 3 of 4 runs here and also 3 of 4 on an
exported copy of the base commit 9a2f693, so it is not caused by this task (the owner `jsonBody` is unchanged). The full
`npm test` is left to the coordinator (parallel wave rule). Isolated app on port 4921 (`$TMPDIR/network-logs/task-11-port-4921.log`;
temporary data, projects and home folders, PATH holding only a `node` symlink, no worker in this base): listener off and no
`network/` folder before; a client created; listener on at 4922; a real MCP host over `bin/ste.mjs --mcp` listed six
tools and the one allowed agent, `jobs_submit` answered `queued` in 39 ms with "No job worker is available…", another
agent refused (`AGENT_NOT_ALLOWED`), owner route with the machine token 403, machine route with the owner token 403,
`jobs_cancel` cancelled, the bridge's stderr empty; listener off; `clients.json` holds no `pbm_`; Ctrl+C (SIGINT) stopped
the app and its listener; folder removed. Paid CLI runs: 0.

**Acceptance criteria and evidence** (screenshots in `$TMPDIR/network-logs/task-11-screens/`, all looked at:
`settings-{1440,390}-{light,dark}.png`, `settings-390-{light,dark}-setup.png`, `settings-create-1440-{light,dark}.png`,
`settings-token-{1440,390}-{light,dark}.png`):

- *An outside compatible MCP client lists an allowed agent, submits a job, receives `jobId`, polls, and retrieves its
  result:* `network-mcp` test 1 (real client and `bin/ste.mjs --mcp`), the port-4921 smoke; REST: `network-machine` test 3.
- *Unauthorized agent/project/memory access returns denied; no admin action through a machine token:* `network-machine`
  tests 3, 4 (and 10), `network-mcp` test 1.
- *No new public interface appears on installation or by simply visiting Network:* `network-machine` test 1,
  `network-clients-ui` (no folder, no port after visiting Network and Settings), the port-4921 smoke; the listener is
  127.0.0.1 only.
- *Existing paired-device remote access remains separate and secure:* `network-machine` test 10, `remote-access` route
  table (create, rotate and listener local-only), `network-machine` test 4.
- acceptance.md Task 11 rows: 1 → machine 1, 10, `remote-access`; 2 → machine 2; 3 → machine 3; 4 → machine 4, 7 (stream
  closes); 5 → machine 5; 6 → machine 6; 7 → mcp 1; 8 → mcp 2; 9 → machine 8, mcp 1, 3; 10 → machine 9. Failure matrix
  rows 1, 27, 29, 30 → machine 6, 7, 5, 4.
- Task prompt extras: replay → machine 6; missing worker, cancellation, restart → machine 9, 3; tokens refused both ways →
  machine 4, 10; UI both themes, 390/1440, keyboard → the Chrome test; snippets with a placeholder only → UI test.

**For Tasks 12 and 13.** Inbound A2A belongs on this listener: rows in `MACHINE_ROUTES`, an exception before the
`/machine/v1/` check for `/.well-known/agent-card.json`, clients of `kind: 'a2a'` (only `'api'` validates now), the same
`onRevoke` teardown. A client's jobs are `requester: { kind: 'machine', id }`; Task 12 messages from a client are
`{ clientId }`. Expected merge overlaps: `src/network/jobs.mjs` (`result()` is identical to Task 07's; `cancel` and
`#stop` lines), `src/network/http.mjs` (route table end and the context line), `src/server.mjs` (import, `startServer`
options, after `NetworkJobs`, the start and close lines, the return), `public/network.js` (`SECTIONS`, `panelOf`, the
`view.append` line, `render`, `leave`), `public/index.html`, `public/styles.css` (appended block),
`tests/helpers/ui-harness.mjs`, `tests/network-ui.test.mjs` (line 74 and the End/Home block; Task 10 changes the
Pipelines entry on the same line), `tests/remote-access.test.mjs`; all additive.

**Known limits.** Loopback only: no Tailscale/Twingate address or TLS for the machine listener yet. Listing a client's
jobs and building its event filter scan the whole job index (`ponytail:` note). Rate limits are per client and in memory
(a restart resets them); unauthenticated requests are not rate limited (loopback, 256-bit tokens). A machine job's input
is bounded by the 256 KiB body. Revoking does not cancel the client's jobs. Scopes cannot be edited (create a new client and
revoke the old one). No Streamable HTTP MCP endpoint. Until Task 07 is merged, jobs submitted through the real app stay
queued (no worker), as the smoke shows; with it, they run like owner jobs. Port 0 shows as "0" in the port field.

**Commits.** a1d6642 (code, tests, dependency, architecture §22), then this log entry.

### Task 10 — Pipeline designer and run view (2026-10-26, wave B, branch `feat/network-10`)

**What was done.** Network → Pipelines works (no longer "soon"). The list shows every pipeline with its network, pinned
network version, step and arrow counts and latest version, filtered by network and searched on the server, plus the latest
runs; it creates (empty, or from the MVP template), renames, duplicates (a new unpublished draft) and deletes a pipeline
(Delete is disabled with the reason once a version is published; the server refuses it too). The designer edits one draft
on a Cytoscape canvas beside keyboard lists: a palette of Agent (members of the pinned network version), Sub-network (a
published pipeline of a contained network at that version), Parallel, Join, Condition, Approval and Output; port-aware
connect (canvas Connect mode with a From-port select, or the "Add an arrow from …" form), remove, drag, arrow keys,
"Arrange in order" (columns along the execution order), fit and zoom, undo; a details panel per step (label, the type's
config, ports in and out, what reaches it, connect form) and per arrow (ports and what it carries), the pipeline settings,
a declarative rule editor with Task 09's nine operators and typed values, a Check list and Versions and runs. Save is one
`PATCH` with the loaded revision (incomplete steps are refused before sending and marked; a conflict offers "Load the saved
pipeline" or "Save mine as a new pipeline"; unsaved changes are guarded). Validate and Publish save first, mark refused
steps and arrows from the error details, and Publish shows the version and a diff summary against the previous version.
Run confirms an explicit published version with its size, concurrency, permissions, tools and "cost not enforced". The run
view shows the pinned plan live (polling one swappable function), per step status, reasons, job link, provider, worker,
tries and job IDs, inputs, artifact references, condition evidence, Approve/Reject on approvals, the saved report
(hash-checked) and Cancel run; nested sub-pipelines are one collapsed group with drill-in on the canvas and in the list. A
phone gets the ordered step list and one step's details in both views. Graph's text now says relations are permissions
and intent, not execution order. Decisions: architecture.md §21.

**Files.** New: `public/network-pipeline.js`, `tests/network-pipeline-ui.test.mjs`, `tests/network-pipeline-browser.test.mjs`.
Changed: `public/network.js` (routes `#/network/pipelines[/<id>]` and `#/network/runs/<id>`, the panel, both guards, the
`openJob`/`followRun` seams), `public/network-graph.js` (exports `kit`; `css` and `keepFocus` at module scope; one sentence
in its explanation), `public/index.html` (script), `public/styles.css` (Pipelines section), `src/server.mjs` (asset),
`src/network/pipeline-runner.mjs` (`report()`), `src/network/http.mjs` (one route), `tests/remote-access.test.mjs` (its row),
`tests/helpers/ui-harness.mjs` (evaluates `network-pipeline.js`; `networkWorker` option), `tests/network-ui.test.mjs`
(Pipelines is available), `docs/network/architecture.md` (§21), this section. The status table is unchanged (wave rule).

**Route.** `GET /api/network/pipeline-runs/:id/nodes/:nodeId/report` → `{ nodeId, name, file, text, sha256, chars }` for a
completed output step whose saved report still hashes to the recorded SHA-256 (`ARTIFACT_INVALID` 409, `STEP_STATE` 409,
`NOT_FOUND`). In `NETWORK_ROUTES` and the paired-device table (allowed, like every run route).

**Tests** (temporary data folders; the only worker is Task 06's deterministic fake behind the real server; no CLI, no
network beyond the local test server):

- `tests/network-pipeline-ui.test.mjs` 5 tests (jsdom): (1) the template becomes a draft with the agents of the pinned
  version, six steps in execution order and six port-typed arrows; a new condition makes Save refuse before any `PATCH`
  with the step marked; the rule editor (operators, "Write a number.", field names, the json port that must reach it);
  a loop and an arrow out of an output refused where drawn; save, remove; Validate refuses a switched-off agent with the
  message, the marked step and its details, then passes; nothing ran; Publish v1 ("This is the first version."); the run
  confirmation (version, 6 steps/3 agent jobs, at most 2 at once, permissions, tools, cost not enforced); the live run
  view to "Waiting for you"; Approve from the step; completed; the saved report exactly as on disk, Download, a report
  changed on disk refused; provider, inputs and result references; the job record as JSON; one start and one approval
  sent. (2) a run of v1 waiting for its approval while the draft is renamed, extended, saved and published as v2 ("1 step
  added, 1 step changed"): the run view still shows v1's steps and `plan.json` is byte-identical; Reject from the step →
  cancelled, no report; a version that cannot start is refused in the confirmation with its reason; a reload (new page
  and server on the same folder) shows the same run and the edited draft. (3) manual worker: both research steps running
  live, one finished shows Completed while the other runs; Cancel run → cancelled, the worker told to stop, jobs
  cancelled/completed; `beforeunload` and the in-app guard (declined keeps editor, edits and address); a conflicting save
  offers both choices and "Save mine" makes "Market report (my changes)"; a failed job → step Failed with
  "PROVIDER_ERROR: Its job … failed (PROVIDER_ERROR). The CLI failed.", the run stops, the other step cancelled. (4) nested,
  built from the UI: New pipeline, an agent step (only the pinned version's members offered), a sub-network step (only
  the contained network's pipeline at the pinned network version; one at another version is not offered), drill-in
  ("Show its steps"), an output (connecting ticks it), save, validate (5 steps, 2 agent jobs, 1 sub-pipeline), publish; a
  switched-off agent is highlighted before any check; the run shows the sub-pipeline as one collapsed group, Expand
  lists its steps by depth, its inner approval is approved from the group's details, both reports saved. (5) the list
  (network filter, rename with focus kept, duplicate as an unpublished copy, delete only never-published, server
  `PIPELINE_PUBLISHED`), every control labelled and every disabled button with a reason, palette/connect form/config by
  keyboard, canvas keys (arrows, Shift, Delete, undo, Escape), a relation edge refused by the server (400) and not shown as
  an arrow, the Graph text, and the phone: ordered steps → one step → Back with focus on its row; settings; a run's
  approval on a phone.
- `tests/network-pipeline-browser.test.mjs` 3 tests (Chrome, real Cytoscape, unchanged CSP): (1) Graph relations are
  dashed bezier curves named by type, pipeline arrows solid taxi lines with `triangle-backcurve` heads labelled by port,
  steps shaped per type; the template; a mouse drag saved exactly; a Parallel step connected by Connect + two taps;
  Validate valid and refused without moving the canvas (the refused step has the error border); publish, run
  confirmation, live canvas states, approve by a tap on the node and its button, the report; the run canvas did not move
  during live updates; light and dark at 1440 (canvas beside the list, colours differ) and 390 (no canvas, ordered steps,
  one step, Back); no outside request, no `<style>` element, no exception, CSP or Cytoscape style warning. (2) a 200-step
  pipeline (10 chains into one report). (3) nested: the sub-network step is a barrel; in the run one collapsed node that
  expands into 3 steps without overlapping anything (the report moves right), the inner approval approved by a tap,
  Collapse all.
- Changed: `tests/network-ui.test.mjs` (Pipelines is available), `tests/remote-access.test.mjs` (the report route row).
- Mutation check (`$TMPDIR/network-logs/task-10-mutations.log`, script kept outside the repo): 29 of 29 mutations make a
  test fail (route row, report hash check, validate marks, save pre-check, loop check, number rule, Approve button, live
  polling, cost row, run view header, Reject, the refused start, the cancel call, the guard, the conflict choices,
  `beforeunload`, the step reason, the sub-pipeline scope filter, collapsed groups, the disabled-agent warning, output
  auto-include, delete of a published pipeline, canvas keys, the phone detail view, the Graph sentence, Pipelines still
  "soon", dashed arrows, room for an expanded group, the remote-access row). The scope filter survived the first round;
  the nested test now publishes a pipeline of the inner network's version 2, which must not be offered.
- Runs: `npm run check` pass. New and touched tests twice on the final code (`task-10-new-twice.log`): `network-pipeline-ui`,
  `network-ui`, `network-graph-ui`, `network-review-ui`, `remote-access` 40/40 and 40/40; `network-pipeline-browser`,
  `network-browser`, `network-graph-browser`, `network-review-browser`, `remote-access-browser` 9/9 and 9/9. Earlier on this
  code (`task-10-touched.log`): every non-browser `network-*` test plus `remote-access`, `server`, `ui`, `ui-2`, `ui-3`,
  `project-explorer-ui`, `sandbox-ui`: 262/263 — the one failure is Task 06's `network-jobs` "job routes over HTTP" `read
  ECONNRESET` (pre-existing, logged by Task 09); alone 18/18 (`task-10-jobs-rerun.log`). One browser run with five Chrome
  files in parallel failed at the mouse drag: Cytoscape refreshes its cached container offset some time after a scroll,
  so a press right after `scrollIntoView` missed the node; the test's `point()` now calls `cy.resize()` first (passes 3/3
  alone and in both final runs). The full `npm test` was not run (wave rule).
- Isolated smoke on port 4920 (temporary data and projects folders, PATH holding only a `node` symlink, no worker):
  `/network-pipeline.js` 200 with a JavaScript type and loaded by the page, `/api/network/pipelines` 403 without the token
  and an empty page with it, the report route 403 without the token and `NOT_FOUND` for a missing run; stopped, folder
  removed. Paid CLI runs: 0.

**Performance** (headless Chrome 1440×1000, software rendering, this Mac; 200 steps and 199 arrows; ten runs): first
draw from choosing the pipeline to two painted frames with every step on the canvas and in the list 0.37–3.3 s (median
about 1.4 s; the slow ones while other Chrome processes ran); choosing a step 36–840 ms (its JavaScript is 8–23 ms; the
rest is software paint, slowest on the first selection, 60–200 ms on later ones; 684–1,491 ms in two runs before
redundant canvas writes and resizes were removed); a label edit 27–918 ms; Arrange in order 42–544 ms; save and validate 50–354 ms; JS heap +3.7–3.8 MB. The
suite asserts only a 10 s first draw and 3 s per action (CI draws in software under load). `PB_NETWORK_PERF_LOG` writes
the numbers (`task-10-perf.json`).

**Screenshots looked at** (`$TMPDIR/network-logs/task-10-screens/`): `pipelines-list-1440-light-empty`,
`pipelines-template-1440-light`, `pipeline-designer-1440-{light,dark}`, `pipeline-validate-refused-1440-light`,
`pipeline-publish-1440-light`, `pipeline-run-confirm-1440-light`, `run-waiting-1440-light`, `run-approval-1440-light`,
`run-report-1440-light`, `run-1440-{light,dark}`, `pipelines-list-1440-{light,dark}`, `run-390-{light,dark}-{list,detail}`,
`pipeline-390-{light,dark}-{list,detail}`, `run-nested-{collapsed,expanded}-1440-light`, `pipeline-200-steps`. Fixed after
looking: "Collapse all" showed with no sub-pipeline (now hidden; disabled with a reason when nothing is expanded), report
headings took the side panel's uppercase label style, the description field was unstyled, labels were too small at the
fitted zoom (larger font, narrower columns), dialog notes had no spacing, and an expanded sub-pipeline overlapped the next
step.

**Acceptance criteria and evidence:**

- *User can build & execute a nested pipeline graph from UI, with real live states and approval actions:* UI test 4 (built,
  validated, published and run from the UI; group expand; inner approval approved), browser test 3 (canvas expand, tap to
  approve), UI tests 1 and 3 (live Running/Completed/Waiting/Failed/Cancelled from the real server's runner and job
  engine), browser test 1; `run-nested-*`, `run-waiting-*`, `run-approval-*`. Live states are polled each second until Task
  08's stream is wired (below).
- *Editing the draft while a run is active has no effect on the run:* UI test 2 (draft renamed, extended, saved and
  republished as v2 while the run waits: run view labels and steps of v1, `plan.json` byte-identical, the plan from the
  route deep-equal), the run view's pinned note.
- *No invalid step graph is executable; useful validation errors are shown:* UI test 1 (incomplete step refused before
  saving, marked; Validate refusal with message, marked step, details and Show; loops and arrows out of an output refused
  where drawn), UI test 2 (a version that cannot start is refused in the confirmation, Start disabled, nothing started),
  browser test 1 (refused step marked on the canvas, canvas does not move); Run is disabled until a version is published.
- *Pipeline and Graph modes explain their different semantics and do not accidentally share edge types:* browser test 1
  (style comparison), UI test 4 (both texts, a relation edge refused 400, a network's relation not shown as an arrow).
- acceptance.md Task 10 rows: 1 → browser test 1, UI test 1 (palette, validation on the bad node, publish, confirmation
  with agents, permissions, concurrency, "cost not enforced"); 2 → UI tests 1 and 3, browser tests 1 and 3 (states change
  live by polling, approve from the node, open job, cancel); 3 → UI test 2; 4 → browser test 1, UI test 4; 5 → UI test 4,
  browser test 1 (phone list and keyboard paths for add, connect, configure, approve). Failure matrix row 24 → UI test 2.

**What the integration pass must wire.** (1) Task 08's event stream: `app.js` passes `followRun(runId, changed) → stop` into
`PromptboardNetwork.create` (`network.js` forwards it as `host.followRun`); it subscribes to `pipeline.run`, `pipeline.node`
and `job.status` events with that `pipelineRunId` and calls `changed()` per event (it resolves to whether the run still
moves); without it the run view polls every second (`pollRun`). (2) If Task 08 adds a job drill-down, pass `openJob(jobId)`
the same way; otherwise "Open job" shows the job record as JSON. (3) Task 07's real worker needs nothing here; Task 12's
pipeline schedules would add their own controls.

**Known limits.** Live states are polled (1 s) until the stream is wired; the jobs of a run are read 200 at a time. Pause
is not offered (the runner has none). An agent step's result text has no route; the run view shows its references and the
saved report. No read-only view of an older pipeline version (the publish diff summary and the run view cover it). The
designer reads the first 200 registrations (state and tools of others are unknown, so not warned). Sub-pipelines are
always collapsed in the designer; on the run canvas an expanded group's steps are laid out in columns and what lies to its
right or below moves, but routes of long taxi arrows can still cross. Undo keeps 50 steps; layouts and drags are undone one
at a time. The run view's network is named by version only. The 200-step canvas pays 0.4–3 s for its first draw in
software rendering. Paid CLI runs: 0.

**Commits.** 6bc96d1 (Task 10), then this log entry.

### Task 12 — Delegation, job messages and schedules (2026-10-26, parallel wave B, branch `feat/network-12`)

**What was done.** A running agent can ask for help in the only way it has: the last fenced ```json block of its final report,
`{"promptboard": {"needs_input": {"question"}}}` or `{"promptboard": {"delegate": [{ agentId, task, tools?, json? }]}}`. The server
treats it as a request: it checks it against the owner's handoff policy (off by default; Network → Settings → Handoffs) and either
refuses it (recorded as a `blocked` message and a `job.handoff` event; the job completes with its report) or acts: the job waits
(`waiting_for_input`) for the owner's (or its client's) answer, or for sub-jobs created under keys of its own, then runs again
as a new attempt that reads its report and the handoff messages as data. Delegation follows only a `delegate` relation in the
job's network, within depth, fan-out and time-budget ceilings, with no wider tools, no other project, no cycles and optional
owner approval; queued sub-jobs are checked again at their claim, cancelled with their parent and never doubled across
restarts. Job messages are bounded records with read receipts apart from execution. Network job schedules (daily, weekdays,
weekly, monthly or on demand) reuse Kanban's slot arithmetic: off until confirmed at the computer, one coalesced job after
downtime, no pile-up, no replay after a restart, nothing while the computer's zone differs. External clients get sub-jobs,
messages and answers on their own jobs. Activity shows each job's origin, approval request, question, sub-job tree and
messages, and a Schedules list; Settings holds the policy. Webhook triggers are deferred (no private verified delivery path).
Decisions in architecture §23; the progress status table is left to the coordinator.

**Files.** New: `src/network/delegation.mjs` (policy, request format, checks, guide), `src/network/messages.mjs`,
`src/network/schedules.mjs`, `public/network-delegation.js`, `scripts/network-delegation-live.mjs` (opt-in, never in `npm test`),
`tests/network-delegation.test.mjs`, `tests/network-delegation-http.test.mjs`, `tests/network-delegation-e2e.test.mjs`,
`tests/network-delegation-ui.test.mjs`, `tests/network-delegation-browser.test.mjs`, `tests/network-schedules.test.mjs`.
Changed: `src/network/jobs.mjs` (handoff path, `#accept` split out of `submit` with a server-only `link`, `#resume`, cancel
propagation, claim recheck, `answer`, `messagesOf`, `postMessage`, `readMessages`, `delegate`, `jobSubmission` export, the
`waiting` texts, a delete guard), `src/network/worker-local.mjs` (`jobPrompt` gains `handoff`: HANDOFFS after the header,
EARLIER WORK before the input; byte-identical when null), `src/network/http.mjs` (12 routes, `schedules` in the route context,
export/import of schedule definitions), `src/network/rest.mjs` (5 machine routes), `src/network/events.mjs` (`scheduleId`
field), `src/network/activity.mjs` (origin fields on queue rows), `src/network/registry.mjs` (the export file may carry
`schedules`), `src/schedules.mjs` (exports `dueSlot` and `since`, nothing else), `src/server.mjs` (wiring, start/stop,
`networkScheduleOptions`, asset), `src/remote-access.mjs` (`localOnly`: policy PATCH and schedule confirm),
`public/network-activity.js`, `public/network-clients.js`, `public/index.html`, `public/styles.css` (appended block),
`tests/remote-access.test.mjs` (12 rows), `tests/helpers/network-worker.mjs` (optional `json`), `tests/helpers/ui-harness.mjs`,
`tests/fixtures/fake-headless-cli.mjs` (`[[delegate:<id>]]`), `docs/network/architecture.md` (§23), this file. `acceptance.md`
already had the Task 12 rows and is unchanged.

**Data layout.** `network/delegation.json` (`promptboard.network-delegation` v1, created on the first policy change),
`network/schedules.json` (`promptboard.network-schedules` v1), `network/jobs/<id>/messages.json`
(`promptboard.network-messages` v1), `attempts/<att>/handoff.md` and `handoff.json` (written once); `job.json` gains
`awaiting`, `delegation`, `schedule` and `attempt.handoff`, and `request.json` `delegation` or `schedule`, only when present
(older files and hashes unchanged). The Network export carries `schedules` only when there are any.

**Routes.** Owner: `GET/POST /api/network/jobs/:id/messages`, `POST …/messages/read`, `POST …/answer`, `GET/PATCH
/api/network/delegation`, `GET/POST /api/network/schedules`, `PATCH/DELETE /api/network/schedules/:id`, `POST …/confirm`,
`POST …/run`. Local-only: `PATCH /api/network/delegation` and `POST /api/network/schedules/:id/confirm` (both switch standing
automation on); everything else is the owner's control over saved definitions and their own jobs, allowed from a paired phone
(a phone can create a switched-off schedule, edit it — which can only switch it off — run it once, delete it; it can never
switch one on). Machine (own jobs only): `POST /machine/v1/jobs/:id/children` (`submit_jobs`, a submit), `GET …/messages`,
`POST …/messages/read` (`read_job_result`), `POST …/messages`, `POST …/answer` (`submit_jobs`). The MCP bridge is unchanged.

**UI.** A job's record in Activity: "Started by" (you, a client, a schedule and its slot, or the delegating job with a link),
Approve/Reject when it waits for approval, the question with an answer form that survives live redraws, the sub-job tree
(four levels, 50 rows, with Approve/Reject), the handoff messages with Unread marks, "Mark … as read" and a folded note form.
Activity's side column: Schedules (zone note, state, repeat, next time, last skip, Switch on… with a confirmation, Switch off,
Run now, Last job, Edit, Delete, editor dialog). Settings: Handoffs (two switches, approval, depth, fan-out, time budget). The
timeline names and filters handoff, message and schedule events; open sub-jobs and scheduled jobs say where they came from.

**Tests** (temporary data folders, the deterministic fake worker or the fake CLIs, no real CLI; module tests on fake clocks):

- `tests/network-delegation.test.mjs` 10 tests: (1) the request format, strict, malformed ones are errors; (2) A delegates an
  approved sub-job to B along a delegate relation: the guide offers exactly B, the sub-job's requester, source, key
  `delegate:a1:0`, delegation record in `request.json`, inherited permissions and the 50 % budget, nothing before approval, the
  parent's second attempt reads the request and B's result as data, the result links back, events carry no text, no
  `federation.json` or `clients.json` (A2A not required); (3) refusals create nothing and are recorded: switched off, no
  relation, escalation, another project, unregistered, no network, malformed, one bad sub-task of two (all-or-nothing),
  switched-off registration; (4) depth and fan-out, the guide empty at the depth limit, cycle suppression (helper cannot hand
  back to lead) and the guide never offering a chain agent; (5) a second round counts against the fan-out, five handoffs per
  job, then nothing is offered; (6) one child per key across two restarts after a simulated crash, and an awaited child cannot
  be deleted; (7) revocation: a removed relation and a switched-off policy fail queued sub-jobs at their claim with no attempt,
  and the parent goes on with that outcome; (8) cancelling a parent cancels the whole open tree; (9) questions: off, then wait,
  read receipts change no execution state and only mark what is addressed to the reader, answer revision checked, the new
  attempt reads question and answer, no question or answer in any event, notes only review/request, 16 KiB, 200 per job,
  secrets masked, 500 per job; (10) a client-started chain stays inside the client's scope, a client's own sub-job with its key,
  cycle and scope refusals, revoked client refused and its queued sub-job fails at claim, no sub-job of a finished job.
- `tests/network-delegation-http.test.mjs` 1 test: the policy routes (revision), a client's sub-jobs over REST (202, the same
  key 200, its own job, outside its scope 403, extra field 400, another principal's job 404 on all three routes, no
  `submit_jobs` 403), messages without `attemptId`, a question addressed to the client, read, answered, `JOB_STATE` after; the
  owner's message, read and answer routes.
- `tests/network-delegation-e2e.test.mjs` 1 test: the real `LocalJobWorker` with fake Claude and Codex CLIs only on PATH: the
  parent's `prompt.md` has the HANDOFFS section with the checker, the fake CLI's json delegates, the Codex sub-job runs, the
  second `prompt.md` holds the sub-job's result indented in EARLIER WORK, three CLI runs, no A2A or machine files.
- `tests/network-schedules.test.mjs` 7 tests: off until confirmed, saving and editing start nothing, no catch-up before the
  confirmation, one job per slot with its key and `request.schedule`, firing keeps the revision, an edit switches it off;
  one coalesced job after four missed slots, the next slot skipped and used up while the job is open (`PREVIOUS_OPEN`), a new
  job after it ended; a restart never fires a slot twice, also after a crash between submit and save; a zone change warns and
  fires nothing until confirmed again; Run now (with and without key), on-demand cannot be switched on, a refused time is used
  up with its code, delete; a pipeline schedule saves its slot before the run, skips while a run is open, and a crash between
  save and start never starts that slot again; over HTTP: definitions-only export (none: no `schedules` key), an import with an
  unresolved agent refused whole, the import comes back switched off and remapped, the routes' statuses, only Run now started
  a job.
- `tests/network-delegation-ui.test.mjs` 4 tests (jsdom): the policy card; a delegating job's record (origin, tree, approval,
  messages, timeline words without text, the parent going on, the child's link back, the queue row's origin); a question
  answered from the record with the typed answer kept across a redraw, read marks, a folded note; Schedules (new, validation,
  confirmation text, switch on, Run now, an edit switching it off, delete, its job stays).
- `tests/network-delegation-browser.test.mjs` 1 test (Chrome): light and dark at 1440 and 390 px (side column at 1440, nothing
  sideways at 390), the editor dialog inside the screen, the delegating and question records and the policy card at both
  widths, Tab to New schedule with a visible ring, Enter opens on the name, Escape returns focus, Tab from the answer to Send
  answer with a ring, no exception or CSP message. Screenshots (all looked at): `$TMPDIR/network-logs/task-12-screens/`
  `activity-schedules-*`, `schedule-editor-390-*`, `job-delegating-*`, `job-question-*`, `settings-handoffs-*`.
- Changed: `tests/remote-access.test.mjs` (2 local-only and 10 allowed rows, one per new route).
- Mutation check (`$TMPDIR/network-logs/task-12-mutations.log`, a throw-away script outside the repo, each source restored and
  hash-checked): 50 mutations of the policy, engine, messages, schedules, phone rule and UI; **49 killed**. The survivor, the
  `lastSlot >= slot` re-check inside `#fire`, was unreachable (only the busy-guarded tick fires, and `dueSlot` already counts
  from `lastSlot`) and differed from Kanban for a slot recorded while the clock ran ahead, so it was removed: 49 of 49 remaining.

**Runs.** `npm run check` pass. New tests twice on the final code: 24/24 and 24/24 (`task-12-new-run1.log`, `-run2.log`).
Touched modules (every non-browser `network-*`, `remote-access`, `schedules`, `schedules-ui`, `server`, `ui`, `ui-2`, `ui-3`,
`project-explorer-ui`, `sandbox-ui`, `cli`; 35 files, concurrency 4): first run 355 tests, 354 pass, 1 fail —
`network-mcp` test 1 hit its own client's 60-requests-a-minute limit (`RATE_LIMITED`) while polling every 5 ms under load
(`task-12-touched.log`); alone it passed 3 of 3 (`task-12-mcp-alone.log`), the same 35-file load on an exported copy of the
base commit c074c7b passed 332/332 once (`task-12-base-touched.log`), and the rerun of the full set passed 355/355
(`task-12-touched-rerun.log`). I read it as a load flake of that test's polling (Task 12 adds one cached policy read before a
claim), not a regression, but one base run is not proof. Browser: `network-activity`, `network-clients`, `network`,
`network-tasks`, `network-graph`, `network-review`, `network-delegation`, `remote-access`, `schedules` 11/11
(`task-12-browser.log`). The full `npm test` is left to the coordinator (parallel wave rule).

**Live provider runs (Task 12).** `PB_NETWORK_LIVE=claude node scripts/network-delegation-live.mjs`, 2026-10-26 12:30 UTC,
16 s: an isolated app on port 4912 with a temporary data folder (removed), the app's own worker; the parent agent Claude Code
haiku (real CLI through a stdout-copying wrapper), the sub-job agent on the **fake** Codex CLI; delegation on, approval off,
`maxChildren` 1. **2 real CLI runs.** Attempt 1 ended its report with exactly `{"promptboard": {"delegate": [{"agentId":
"agt_…", "task": "Confirm the version number format …"}]}}`; the sub-job was created (depth 1, `delegate:a1:0`) and completed
("Answer from codex."); attempt 2 read it as data, judged the fake answer empty and asked again, which the fan-out ceiling
refused (recorded `blocked`), so the job completed with its partial checklist. Usage as reported: attempt 1 input 5,487
(cached 649), output 819, $0.00151; attempt 2 input 5,915 (cached 649), output 1,088, $0.00173. Output in
`task-12-live.log`.

**Acceptance criteria and evidence.**

- *Agent A can delegate an approved sub-job to Agent B; the child result links back to the parent:* delegation test 2, e2e,
  UI test 2, the live run.
- *Recursion, budgets, ownership and cross-project permission checks work server-side:* delegation tests 3, 4, 5, 10, http.
- *Scheduled Network Jobs run only when the owner opted in; duplicate missed jobs are not replayed:* schedules tests 1–3, 7.
- *All handoffs are inspectable and revocable; no free-form unbounded agent-to-agent messaging:* delegation tests 2, 7, 8, 9
  (agents cannot post; bounded notes), UI tests 2–3.
- acceptance.md Task 12 rows: 1 → delegation 2, 3; 2 → delegation 4, 5, 6 (the key is `job:<parent>:delegate:a<attempt>:<n>`);
  3 → delegation 9; 4 → delegation 7, 8, 10; 5 → schedules 1–4, 7; 6 → UI 2, 4, browser. Failure matrix 32 → schedules 7 (import
  and restore start nothing); 33 → schedules 2; 34 → delegation 4, 6; 37 → webhooks deferred (§23 item 15), jobs by key.
- Task prompt list: bounded depth and fan-out, denied delegate, no duplicate child on retry, cycle suppression, schedule
  restart and no pile-up, permission revocation, cancellation propagation, A2A not required → delegation 2–8, 10, schedules 2–3.

**Expected merge overlaps with Task 10** (all additive): `src/network/http.mjs` (the header comment's end, the `SCHEDULE`
pattern beside `PIPELINE/RUN/STEP`, `importNetwork` after `jobAction`, the export and import rows, rows appended to
`NETWORK_ROUTES`, `schedules` in `networkRoute`'s parameters and context), `src/server.mjs` (two imports after
`MachineListener`, the `/network-delegation.js` asset after `/network-clients.js`, `networkScheduleOptions` in `startServer`'s
options, two lines after the `MachineListener`, `schedules` in the `networkRoute` call, `networkSchedules.start()` after
`machine.start()`, `.stop()` in `close`), `public/index.html` (one script line after `network-clients.js`), `public/styles.css`
(a block appended at the end), `tests/helpers/ui-harness.mjs` (one eval line before `network-clients.js`). Not touched:
`public/network.js`, `public/network-graph.js`, `src/network/pipeline-runner.mjs` (only called), `tests/network-ui.test.mjs`.

**For Task 13.** A2A-started chains are refused delegation (`#rootClient`) until the A2A principal's scope is defined; extend
that function, never widen it. A question from an `a2a` job goes to the owner (`#requesterParty`). Inbound A2A that should
answer questions or ask for sub-jobs can reuse `jobs.answer(…, { by })` and `jobs.delegate(…)` with its own principal checks.

**Known limits.** One policy for all networks. A waiting parent restored from its backup becomes `interrupted`; its sub-jobs
still run but their results are recorded for it only while it waits. Pipeline schedules are made through the API (the editor
makes job schedules). No MCP tools for sub-jobs, messages or answers yet. Webhooks deferred. A refused request stays in the
completed job's report text (the report is kept as written).

**Commits.** 7d3adb5 (code, tests, architecture §23), then this log entry with the live-run script.

### Phase-2 review fixes (Tasks 06–11)

An independent review of Tasks 06–11 at 96987d8 (`$TMPDIR/network-logs/review-p2/FINDINGS.md`, its repros and outputs
beside it) listed one P2 and ten P3 findings. All eleven are fixed at their root on `feat/network-wave-b`, each with a test
in `tests/network-review2.test.mjs` (server) or `tests/network-review2-ui.test.mjs` (page) that failed before its fix
(`review2-fix-before-server.log`: 7 of 7 failing; `review2-fix-before-ui.log`: 6 of 6, the Task 10 seams test included)
and passes after. Task 10's two seams are wired. Mutation check: each fix reverted on its own, its test run, the file
restored from HEAD (`git stash` never used): 25 of 25 mutations fail (`review2-fix-mutations.log`). Architecture: §19 item 8
(`job.recovered`), §21 item 11 (the seams).

| Finding | Fix | Test (`network-review2*`) | Commit |
|---|---|---|---|
| P2-1 an edit made while a pipeline draft saves is lost | the working copy becomes the server's copy only when it still equals what the save (or the publish) sent; otherwise only the draft and its revision move on and the edit stays unsaved with its undo steps. `network-graph.js` had the same save-then-replace pattern and is fixed the same way (its publish saves inside its modal dialog, so it needs nothing more) | "P2-1: an edit made while the pipeline draft saves…" (Save, and Save, validate and publish), "P2-1 (Graph)…" | 225681e |
| P2-2 a machine stream slot leaks when its reader leaves during an await | the listener returns when the response is gone after authentication (nothing kept in the open set), and `eventStream` counts the stream and hears its close before awaiting the own-job scan | "P2-2…" (8 drops during a slow scan, 8 during slow authentication; a new client's stream is then 200) | ab5797d |
| P2-3 retention never removes finished runs' step-job logs | the runner asks the job engine for one more retention pass once it has loaded (`jobs.sweep()`, which `close()` waits for) | "P2-3…" | c6d2d97 |
| P2-4 an interrupted run hides Cancel | Cancel run is offered for every run that has not ended | "P2-4…" (interrupted from its backup, then cancelled from the view) | 72e72fe |
| P2-5 each journal page parses a whole segment | a segment's parse is reused while the file keeps the size it was parsed at (append only, so the same lines); the two segments read last stay parsed; a backward page no longer reverses the shared array. Repro: 50,000 events in 250 pages took 5.8 s (23 ms a page, event loop blocked up to 46 ms) before, 0.1 s after (blocked up to 21 ms: one parse) | "P2-5…" (JSON.parse calls for a 6,000-event replay: 96,034 before, under 3 per event after; appends and backward reads stay right) | 2e0ee9d |
| P2-6 a job's or agent's events older than one journal read are "not in the journal" | the job record and the agent's Activity tab follow `prev` until they have a page of events or reach the journal's start (at most 40 reads, more than the kept journal holds) | "P2-6…" (50,000 newer events) | 2213d5d |
| P2-7 a join(any) report says a slower step "did not run" | a step still open when the report is saved reads "This step had not finished when this report was saved."; an ended step without a result keeps "did not run" | "P2-7…" (exact report) | 8838923 |
| P2-8 a finished job read from its backup is recovered silently | every job read from its `.bak` is saved once, one revision past the lost copy, and appends one `job.recovered` event (`RESTORED_FROM_BACKUP`, `by: app`) | "P2-8…" (the event, its fields, revision newer than the lost one) | c574994 |
| P2-9 a machine client's stream outlives its expiry | the stream ends at the client's expiry (a timer, re-armed past setTimeout's 24.8-day ceiling), and an event that comes after the expiry by the clock ends it instead of reaching the client | "P2-9…" (a stream opened 400 ms before expiry ends; a clock jump past expiry delivers nothing) | ab5797d |
| P2-10 the Create client form offers only the first 200 agents and networks | it reads every page of both | "P2-10…" (205 agents) | 520d7af |
| P2-11 a job cancelled during the worker's claim leaves its entry in memory | `LocalJobWorker.claim()` keeps nothing once the attempt's signal is aborted (the repro now answers `{ process: 'none' }`) | "P2-11…" | 8acaea3 |
| Task 10 seams | `network.js` passes its own `followRun` on the page's one event stream (Activity's; never a second, per the wave-A integration constraint): a run on screen turns that stream on, the `onEvent` fan-out calls `changed()` for `pipeline.run`, `pipeline.node`, `job.status` and `job.activity` events of the run, and it polls every second only while the stream is not live. `app.js` passes `openJob` (`#/network/activity/<jobId>`); the job record also offers "Open run". The Task 10 UI test expects the Activity record and now waits for the cancelled job, since the live view shows the cancelled run before the runner has stopped its job | "Task 10 seams…" (at most one stream; no run reads for 2.5 s while live; an approval made elsewhere arrives live; polling while all 4 stream slots are taken) | 55d80e2 (a first wiring with its own stream), dfb0c68, 5ed5dcf |

**Test runs** (PATH: a `node` symlink plus `/usr/bin:/bin:/usr/sbin:/sbin`, which hold `git` and `sh` but no AI CLI; with
`node` alone the two tests that call `git --version` fail): `npm run check` passes; the new and changed tests
(`network-review2`, `network-review2-ui`, `network-pipeline-ui`) twice, 18 of 18 each time; every non-browser
`tests/network-*.test.mjs` (23 files) with `remote-access`, `project-explorer-ui`, `sandbox-ui`, `ui`, `ui-2` and `ui-3`,
301 of 301 (`review2-fix-touched.log`); every `tests/network-*browser*.test.mjs` (7 files), 11 of 11
(`review2-fix-browser.log`). The full `npm test` is left to the coordinator after the merge.

**Known limits.** When a run ends, its view stops following at the first read that sees the end; jobs the runner stops
after saving that end (a failed step halting the run) can show their last status in the step details until the view is
opened again, as with polling before. The journal keeps at most two parsed segments in memory. Paid CLI runs: 0.

### Wave B integration (2026-10-26, after the merge of Tasks 10, 11 and 12)

**What was done.** Tasks 10, 11 and 12 were built in parallel lanes; this pass connected them on `feat/network` (from
5aceacb) and brought the full suite to green. A pipeline step whose agent job asks a question or delegates is now proven end
to end on the real worker and shown in the run view; the Schedules editor makes pipeline schedules; the MCP bridge has Task
12's tools; and five smaller seams a user would hit are closed. Isolated app only (port 4932 for the screenshot smoke,
temporary folders, `PATH` holding a `node` symlink, plus `/usr/bin:/bin:/usr/sbin:/sbin` for the test runs). Paid CLI runs: 0.

**Browser tests and the full suite before any change** (5aceacb). Every `tests/network-*browser*.test.mjs` (7 files): 12/12
(`$TMPDIR/network-logs/wave-b-browser-run1.log`). Full `npm run check` + `npm test` on a `git archive` export of 5aceacb with
this worktree's `node_modules` (`wave-b-baseline-suite.log`): check pass; non-browser 1,685 tests, 1,684 pass, 0 fail, 0
cancelled, 1 skipped (the win32-only `editors.test.mjs` test); browser 158/158; exit 0. Nothing failed, so nothing needed a fix
there. The touched-module run later found one load flake that is ours: `network-delegation-http` polls the machine listener every
few ms and passed its 60 requests a minute under load (`RATE_LIMITED` instead of `JOB_STATE`, `wave-b-touched.log`); it now
raises the ceiling it does not test, as `network-mcp` did in 3d3a79a (d9447df).

**Cross-lane gaps** (each with a test that fails without it; mutation check below).

- *a. Pipeline step jobs and handoffs (Tasks 09/10 × 12).* The runner already treated a step job in `waiting_for_input` as an
  open job, so no runner change was needed; `tests/network-pipeline-handoff-e2e.test.mjs` (real `LocalJobWorker`, fake Claude
  and Codex only; the fake CLI gained `[[ask]]` beside `[[delegate:<id>]]`) proves it: run 1 delegates — while the parent waits
  for its sub-job (which waits for approval) the step stays `running`, `pausedAt` stays null, one step job, one CLI run after
  2.5 s; after the approval the sub-job runs on Codex, the parent's second attempt completes the step (`result.attemptId` is
  the second attempt), the report holds "Final answer from claude, with what came back.", 3 CLI runs; run 2 asks — the
  question goes to the owner, the answer completes the step; run 3 is cancelled while the parent waits — run, step, parent and
  sub-job cancelled ("…the job that delegated it was cancelled"), no further CLI run; run 4 passes its deadline (the runner's
  clock, through the new `startServer({ networkPipelineOptions })`) — `failed DEADLINE`, step `RUN_STOPPED`, parent and
  sub-job cancelled. **Decisions:** the deadline keeps counting while a step's job waits for an answer or its sub-jobs (only
  approval and blocked steps pause it; §20 item 11; Run's facts now say so); sub-jobs carry no `pipelineRunId` (only the runner
  links a job to a run, and every reader takes the link to mean "a step job of this run"); instead the step job's `job.handoff`
  and `job.message` events carry `pipelineRunId`/`nodeId`, so the run's event filter shows that the step asked, delegated and
  went on (§20 item 14, §23 item 12). Run view: a running step whose job waits reads "Waiting for your answer" (amber, double
  border) or "Waiting for sub-jobs" (blue, double border) in the list, on the canvas, in the summary and in its details, with
  the question or the waiting message and "Answer in the job’s record" / "Open its sub-jobs" (`openJob` → the Activity record
  with the answer form and the sub-job tree); the agent's Tasks tab gets the same link ("Answer…"), which it lacked (a Task 07
  × 12 seam). Commits 1bd3407, 4c53a6f.
- *b. Pipeline schedules in the UI (Task 12 × 10).* The editor's "It runs" offers a job or a run of a published pipeline
  version (only published versions are listed, every page of pipelines is read; the server checks again), an optional run
  input, and Task 10's run facts for the chosen version. Those facts are now one function, `runFacts` in
  `network-pipeline.js` (exported), used by Run and by the schedules. Switch on… and Run now of a pipeline schedule show the
  facts first and stay disabled while the version cannot start; Run now no longer starts a pipeline run without that
  confirmation (Task 10: starting is never implicit). "Last run" opens the run view. Rules unchanged: created off, only the
  local-only confirm switches on; an edit of the version switches it off (tested). Commit 4c53a6f.
- *c. MCP parity for Task 12 (Task 11 × 12).* `src/network/mcp.mjs` gains `jobs_delegate` (`POST /machine/v1/jobs/:id/children`,
  `idempotencyKey` → the header), `jobs_answer`, `messages_list` (whole messages in windows within the 60 KB answer,
  `offset`/`nextOffset`), `messages_post` and `messages_mark_read`, each strict zod, each one route, so the listener applies
  the same permissions and scope; the token rules are untouched; `jobs_get` names `waiting_for_input`. Test 4 of
  `tests/network-mcp.test.mjs` (real MCP client; `POLLING` kept): a sub-job through the policy (waits for approval), the same key
  the same sub-job, the client's own job; a question listed, marked read (only listed IDs, then all), answered, completed, a late
  answer `JOB_STATE`; notes; a 7-message thread of about 90 KB read back in two or more windows, each within the limit;
  refusals as tool errors (outside the scope `DELEGATION_NOT_ALLOWED`, another principal's job `NOT_FOUND`, a forged kind,
  extra keys, bad IDs, `PERMISSION_DENIED` for a `read_job_result`-only client on delegate, answer and post); no refused call
  made a sub-job; no token in any answer or log. Commits a0bc6e0, 720989f.
- *d. Other seams, fixed:* a scheduled pipeline run was recorded as started by the owner — `startRun(…, { by })`, schedules
  pass `schedule` (history, `pipeline.run` event; the run view says "Started … by a schedule"); the timeline showed
  `job.recovered` (Phase-2 P2-8) as a raw type under Other — now "Job …: read from its backup copy · <status>" under Job status;
  the step job's handoff and message events (above); the Tasks tab link (above). Commit 4c53a6f.
- *d. Other seams, listed (not changed here):* (1) delegation from a pipeline step reads the network's **current draft**
  relations (§23 item 4), not the run's pinned network version (§20 item 3), so a relation drawn after publishing can reach an
  agent outside the pinned version (still behind the opt-in policy and, by default, owner approval) — an owner decision for the
  Task 12 review; (2) a pipeline schedule's slot is skipped while any run of that pipeline is open, also one started by hand
  (`#openWork`); (3) a machine client cannot read sub-jobs its own job's agent delegated (requester `job`), only the parent's
  waiting message and the results in its messages; (4) for a moment after a delegation the parent is saved waiting before its
  sub-jobs are written (one queue turn), so a read can see "Waiting for 1 of its 1" with no child yet (tests wait for the
  child); (5) a collapsed sub-pipeline group whose step waits for an answer reads "Running" until expanded; (6) Run now of a
  job schedule still starts at once (one explicit job, as Task 12 decided).

**Tests.** New: `tests/network-pipeline-handoff-e2e.test.mjs` (1 test, about 12 s), `tests/network-wave-b-ui.test.mjs` (3 jsdom
tests: the run view and Tasks for a question and for sub-jobs, then answered and approved from the record; pipeline schedules —
published versions only, facts, saved off, Switch on…, Run now confirmation, `by: schedule`, Last run, edit, a version that
cannot start; `job.recovered` words and filter), test 4 of `tests/network-mcp.test.mjs` (the `TOOLS` list now has 11). Changed:
`tests/fixtures/fake-headless-cli.mjs` (`[[ask]]`), `tests/network-delegation-http.test.mjs` (ceiling).

**Mutation check** (`$TMPDIR/network-logs/wave-b-mutations.log`, script `wave-b-tools/mutate.py` outside the repo; each edit
applied alone, its test run, the file restored with `git checkout` and the tree checked): 26 mutations, 25 killed at first; the
survivor (`messages_mark_read` dropping `ids`) led to a stronger test (720989f) and is killed now
(`wave-b-mutations-m9.log`): **26 of 26**.

**Runs.** `npm run check` pass. New and changed tests twice: 9/9 and 9/9 (`wave-b-new-run{1,2}.log`), MCP 4/4 twice after the
last test change (`wave-b-mcp-final{1,2}.log`). Touched modules (every non-browser `network-*` file plus `remote-access`,
`server`, `schedules`, `schedules-ui`, `ui`, `ui-2`, `ui-3`, `cli`, `project-explorer-ui`, `sandbox-ui`; 40 files, concurrency 4):
377/378 with the flake above (`wave-b-touched.log`), then 378/378 (`wave-b-touched-final.log`). Browser on the changes: 12/12
(`wave-b-browser-run2.log`). Screenshot smoke on port 4932 (`wave-b-port-4932.log`, `wave-b-screens/`, all looked at): the run
view with a step waiting for an answer, the editor with a pipeline target and its facts, the Switch on… confirmation, light and
dark at 1440 and 390 px, nothing sideways, the dialogs inside the screen; app stopped and folder removed.

**Final full suite.** Run 1 on 27ff897 (`npm run check` + `npm test`, `$TMPDIR/network-logs/wave-b-integration-suite-run1.log`,
19:10–19:45 CET): check pass; non-browser 1,690 tests (the baseline's 1,685 + 5 new), 1,689 pass, 0 fail, 0 cancelled, 1 skipped
(the win32-only test); browser 157 of 158 — `app-fixes-browser` "the shell fits phones and tablets" timed out at 735 px on the
Network page: the document was 723 px wide in a 720 px client area. Alone it failed 3 of 3 on this commit and also on the 5aceacb
export (`wave-b-shell-alone-{1,2,3}.log`, `wave-b-shell-base.log`), which had passed it at 14:30 in the baseline suite, so it
is not a wave B change: this computer's headless Chrome now reserves 15 px for scroll bars (`innerWidth` 735, `clientWidth`
720; the macOS setting is "Automatic"), and Task 03's two-column agents layout left the profile column 68 px wide, whose
placeholder ("A registered agent’s profile…", min-content 98 px) pushed the page 3 px sideways
(`wave-b-tools/overflow.mjs`). It is ours and cheap, so it is fixed at its cause (fe464c1): from 731 to 900 px the list and
the profile stack, both shown (architecture §12.1 item 6); the page is then 720 px in 720, and `app-fixes-browser` with every
`network-*browser*` file passes 22/22 (`wave-b-layout-browser.log`); `agents-800.png` looked at. Run 2 on the final code is
below.

**For the Task 13 merge** (its branch is cut from 96987d8, before Task 12): `src/server.mjs` — the `startServer` signature
(here `networkScheduleOptions` and `networkPipelineOptions`, there `a2aOptions`: keep all) and the `new PipelineRunner(…)` line
(here `...networkPipelineOptions`), next to its `networkJobs`/`machine` hunk; `src/network/jobs.mjs` — the `tags` helper after
`later` (its `storedJob` hunk is beside it; a peer job's `agentId` is null and `tags` passes it through, where the journal drops
it) and Task 12's handoff code it has not seen; `src/network/pipeline-runner.mjs` — `startRun`'s signature, history and start
event here, `#submit`/`#begin`/`#step`/`#follow` there (no shared lines expected); `public/network-pipeline.js` (`STEP_STATES`,
the canvas style rows, `runFacts`, the run view) if it adds a federated step's look; `public/styles.css` (one line inside the
Task 12 block, not at the end); `docs/network/architecture.md` §19–§23 edited in place (its §24 is new); this file's end. A
`federated` step's job can ask or delegate only through the same checks (§23 item 17); the run view's waiting state reads the
step's job, so it applies to it unchanged.

**Commits** (local `feat/network`, never pushed or merged): 1bd3407, a0bc6e0, 4c53a6f, d9447df, 8651ae4, 720989f, 27ff897 (this
entry with architecture §19 item 8, §20 items 11, 14 and 16, §21 items 10 and 11, §22 item 11 and §23 items 8, 12, 14 and 16),
fe464c1 (the layout fix), then this entry's suite results with §12.1 item 6.

### Task 12 review fixes (phase 3)

An independent review of Task 12 at 80c0693 (`$TMPDIR/network-logs/review-p3/FINDINGS.txt`, its repros and outputs beside
it) listed one P2 and six P3 findings. All seven are fixed at their root on `feat/network-review3` (base 5aceacb), each with
a test that failed before its fix and passes after: `tests/network-review3.test.mjs` (server, 10 tests;
`review3-fix-before-server.log`: 10 of 10 failing), `tests/network-review3-ui.test.mjs` (jsdom) and
`tests/network-review3-browser.test.mjs` (Chrome; jsdom cannot show the focus loss) (`review3-fix-before-page.log`: 2 of 2
failing); the final versions of all 12 fail on an exported copy of the base 5aceacb (`review3-fix-before-final.log`). The race the review reasoned about but did not reproduce (a tick that read the rows once) was reproduced
deterministically with a gate and is fixed with P3-4. Architecture §23 items 4, 6, 7, 8, 9 and 14 are updated in place.

| Finding | Fix | Test | Commit |
|---|---|---|---|
| P3-1 (P2) the answer and note fields lose focus on every redraw in Chrome | `keepFocus` gives focus back to a kept node that lost it (it was taken out and put back), with its caret and selection, instead of returning because the node is still connected | `network-review3-browser` "P3-1…" (answer: focus and caret 3,3 kept, the next key lands at the caret; note field the same; each redraw from a live `job.message`) | a663563 |
| P3-2 the policy checks fail open at an unreadable ancestor | `#chain` marks a chain that stops short of its root (`broken`); `#rootClient`, which plan, recheck and guide all call, refuses it (`DELEGATION_NOT_ALLOWED`): plan refuses, a queued sub-job fails `DELEGATION_REVOKED` at its claim, the prompt offers no agent | `network-review3` "P3-2…" ×2 (the review's repro at the claim; an owner-linked job under a damaged client root: no agent offered, its delegation refused) | d5c492b |
| P3-3 a cancel that meets a handoff does not stop the tree | `cancel()` stops only an attempt that is still open, and when the attempt ended by itself while it was stopped (a handoff saved first) it cancels the job that now waits; its sub-jobs follow. `plan` refuses under a cancelled ancestor (`DELEGATION_CANCELLED`), `recheck` fails a claim under one (`DELEGATION_REVOKED`) | `network-review3` "P3-3 (b)…" (the worker has not returned), "P3-3 (a)…" ×2 (direct and cascade, the stop window held open by a gate in the fake worker's cancel), "P3-3: under a cancelled ancestor…" | 16d4295, 3216b87 (test) |
| P3-4 a schedule time that fires during shutdown is lost | for a job target, a 5xx refusal (`SHUTTING_DOWN`, `NETWORK_WRITE_FAILED`) or `BASE_CHANGED` is rethrown without using the slot (key `slot:<ms>` makes the retry safe); `#fire` also fires only the slot the row as saved now has due (the tick race) | `network-review3` "P3-4: a time that fires while the job engine shuts down…" (nothing used up; after the restart one job for that slot over two ticks), "P3-4: a time due before the schedule was switched off and on again…" | e9ccfea |
| P3-5 answers count against the 200-note ceiling | only `review` and `request` notes count; an answer (one per handoff, at most five) is bounded by the 500 in all. The Task 12 messages test counted the answer as a note and now posts 200 notes | `network-review3` "P3-5…" (answered after 200 notes; the 201st note still refused) | 3f9fa64 |
| P3-6 the children route answers a used key with another task as deduplicated | the existing sub-job's stored request (agent, task text, json, tools) is compared with the client's, `IDEMPOTENCY_CONFLICT` 409 when it differs; still before the policy, so a true retry is answered | `network-review3` "P3-6…" (same task: same sub-job; another task, tools or json: 409 naming the first) | 3f9fa64 |
| P3-7 a double-click on Run now starts two jobs | Run now is off until its request is answered, on the clicked button and on a row drawn again meanwhile (the schedules in flight are kept in a set): one click intent, one request, one key | `network-review3-ui` "P3-7…" (the test holds the request in flight and the list is drawn again meanwhile: one request, one job; a later click starts a second) | 538cb35, 3216b87 |

Also 802931b: `tests/network-delegation-http.test.mjs` raises the machine request ceiling, as 3d3a79a did for the MCP tests.
It polls every few ms and failed with `RATE_LIMITED` under a five-file load, identically on an exported copy of the base
5aceacb (`review3-base-quick.log`).

**Test runs** on the final code 3216b87 (PATH: a `node` symlink plus `/usr/bin:/bin:/usr/sbin:/sbin`, no AI CLI): `npm run
check` passes; the new and changed tests (`network-review3`, `network-review3-ui`, `network-review3-browser`,
`network-delegation`, `network-delegation-http`) twice, 23 of 23 each time (`review3-fix-new-run1.log`, `-run2.log`); every
non-browser `tests/network-*.test.mjs` (30 files) with `remote-access`, `schedules`, `schedules-ui`, `project-explorer-ui`,
`sandbox-ui`, `ui`, `ui-2` and `ui-3` (38 files, concurrency 2): 357 of 358 (`review3-fix-touched-final-run1.log`; the one
failure, `network-worker` "a CLI killed from outside…", is a read of the fake CLI's run log while it is being written,
`JSON.parse` "Unexpected end of JSON input" in the test's `runs()`, in files this work does not touch; that file passed 11 of 11
alone twice), then 358 of 358 (`review3-fix-touched-final-run2.log`); every `tests/network-*browser*.test.mjs` (9 files): 13 of
13 (`review3-fix-browser.log`). An earlier pass on 538cb35 was 358 of 358 and 13 of 13. The full `npm test` is left to the
coordinator after the merge.

**Mutation check** (`review3-fix-mutations.log`; a throw-away script outside the repo, each source file restored from HEAD and
hash-checked, `git stash` never used): 14 mutations, each a fix or one part of it reverted on its own; **14 of 14** make their
test fail. A first pass had two survivors, which led to 3216b87: the in-flight click guard of P3-7 was redundant beside the
disabled button (removed), and the P3-3 (b) test used a worker that ended on cancel, so it did not need the open-attempt check
(it now models a worker that has not returned). That one mutant hangs rather than fails: `cancel()` then spins on microtasks
(the memoised stop of the ended attempt), so even the test's timeout cannot fire; its process was killed by hand after about
10 minutes and the runner reported it failed.

**Expected merge overlaps** (wave-B integration on `feat/network`, Task 13 on `feat/network-13`): `src/network/jobs.mjs`
(`#chain`, the body of `cancel()`, the existing-key block of `delegate()`), `src/network/delegation.mjs` (one line each in
`#rootClient`, `plan` and `recheck`), `src/network/messages.mjs` (`post`'s ceiling), `src/network/schedules.mjs` (`#fire`),
`public/network-activity.js` (`keepFocus`), `public/network-delegation.js` (the `schedules` state line, the Run now line of
`scheduleRow`, `runNow`), `tests/network-delegation.test.mjs` (one line), `tests/network-delegation-http.test.mjs` (the
fixture line), `docs/network/architecture.md` §23 items 4, 6–9 and 14, this section. Not touched: `mcp.mjs`,
`pipeline-runner.mjs`, `rest.mjs`, `http.mjs`, `server.mjs`.

**Known limits.** The cancelled-ancestor check covers delegation and the claim of sub-jobs (`job.delegation`); a job the owner
linked under a parent has no claim check and is cancelled by the cascade as before. A schedule time refused with "try again"
is retried at every check (at most a minute apart) with no `lastSkip` recorded until it starts or is refused for good.
`cancel()` ends because a stop always saves the end or finds the attempt ended; a change that broke that would spin (see the
mutation note). Paid CLI runs: 0.

### Task 13 — Minimal native A2A federation and remote Agent Cards (2026-10-26, wave C, branch `feat/network-13`)

**What was done.** Controlled A2A 1.x with trusted remote agents, both directions off until the owner turns them on, built on
the official `@a2a-js/sdk` 1.3.0. **Outbound:** the owner previews a peer's Agent Card (one SSRF-guarded fetch, nothing
saved), reviews its untrusted text as text, and approves exactly that card (hash-checked); only bounded public card fields and
the *name* of a credential environment variable are kept. A peer is a `federated` node in Graph and a `federated` step in
pipelines; its steps are Network jobs (`peerId`, `sideEffects: 'external_unknown'`) run by an A2A worker through the SDK's
`ClientFactory`/`JsonRpcTransportFactory` with the guarded `fetchImpl`: streaming with a poll fallback or polling, remote
states mapped to the job lifecycle, the remote task ID kept opaque, a time limit or lost stream `unknown` (descendants blocked),
cancellation "confirmed" only when the protocol confirms it. **Inbound:** on the machine listener only, a public Agent Card and
a JSON-RPC endpoint serve agents published for A2A to callers that hold a machine-client token of `kind: 'a2a'`; each task is
a Network job through the engine (`source: 'a2a'`), and its status and result come from that job. Network → Federation holds
it all. Decisions and the two deviations (own inbound request handler instead of `DefaultRequestHandler`; peers never
exported) in architecture §24. The progress status table is left to the coordinator.

**Files.** New: `src/network/a2a-registry.mjs`, `src/network/a2a-client.mjs`, `src/network/a2a-server.mjs`,
`public/network-federation.js`, `scripts/network-a2a-live-smoke.mjs` (opt-in, never in `npm test`), `tests/network-a2a.test.mjs`,
`tests/network-a2a-ssrf.test.mjs`, `tests/network-a2a-browser.test.mjs`, `tests/helpers/a2a-peer.mjs`. Changed (small, additive):
`src/network/jobs.mjs` (peer jobs, `peerWorker`, timeout → unknown and cancel confirmation for peer jobs, `remoteTaskId` on
`spawned`), `src/network/registry.mjs` (owns `federation`; `federated` Graph nodes, refs, issues, import keeps them),
`src/network/pipeline-{model,compiler,runner}.mjs` (`federated` step), `src/network/machine-auth.mjs` (`kind: 'a2a'`),
`src/network/rest.mjs` (A2A paths before the `/machine/v1/` check), `src/network/http.mjs` (7 routes), `src/network/activity.mjs`
(`peerId` on job rows), `src/base-context.mjs` (`isPublicAddress` hardening), `src/server.mjs` (A2A worker, `a2aOptions` test
seam, asset), `src/remote-access.mjs` (`localOnly`), `public/network.js` (Federation section), `public/network-graph.js`,
`public/network-pipeline.js`, `public/index.html`, `public/styles.css`, `tests/remote-access.test.mjs` (7 rows),
`tests/helpers/network-machine.mjs` (`serverOptions`), `tests/helpers/ui-harness.mjs` (evaluates `network-federation.js`),
`tests/network-ui.test.mjs` (Federation is no longer "not available"), `package.json`, `package-lock.json`,
`THIRD_PARTY_NOTICES.md`, `docs/network/architecture.md` (§24), this file.

**Dependency.** `@a2a-js/sdk` 1.3.0 exactly (Apache-2.0, published 2026-09-29, older than two weeks); its only hard dependency
`jose ^6.2.3` is the already installed 6.2.12; no Express or other peer installed. `npm audit`: 0 vulnerabilities. Interfaces
checked in the installed package (architecture §24 item 1); `A2A_PROTOCOL_VERSION` is `"1.0"`.

**Tests and results** (logs in `$TMPDIR/network-logs/task-13-*.log`). `npm run check`: all files pass. New tests twice:
`network-a2a` + `network-a2a-ssrf` 21/21 and 21/21 (`task-13-new-run{1,2}.log`); `network-a2a-browser` 1/1 and 1/1
(`task-13-browser-new-run{1,2}.log`). Touched modules: every non-browser `tests/network-*.test.mjs` + `remote-access` +
`base-delivery` 202/202 (`task-13-touched.log`); an earlier run of the same set had 3 failures under parallel load: my own
journal-timing race in the A2A test (fixed: it now waits for the event), `network-mcp` `RATE_LIMITED` (the same failure on the
base commit 96987d8 in the same combined run, 180/181, `task-13-base-touched.log`: a known load flake of Task 11's test, which
passes alone 3/3) and `network-review` P1-2's 912 ms event-loop check (passed in the rerun). All Network browser tests 12/12
(`task-13-browser.log`); the other UI-harness tests 145/145 (`task-13-ui-harness.log`). The full `npm test` was not run (lane
rule). **Mutation check** (`task-13-mutation*.log`, 36 mutants on a separate copy): 35 killed. SSRF guard 13/13 (public-address
check, local-test loopback rule, cross-origin redirect, credential per origin, origin allowlist, https only, every DNS answer,
caller headers, size limit, userinfo, NAT64, re-resolution on every hop, POST redirects); auth and scopes 12/12 (client kind,
other callers' tasks, caller permissions, caller agent scope, unpublished agents, endpoint while inbound off, outbound switch for
calls and previews, peer job scope, phone local-only rules, reviewed card hash, card change at claim); state mapping 10/11
(completed, undefined states, failed, rejected, remote time limit, cancel confirmation, another task ID, refusal vs unknown,
result limit, inbound unknown state). The survivor (a lost stream before a task reported as `completed`) is equivalent: the
engine itself refuses `completed` without a running attempt and saves the same `unknown REMOTE_STREAM_LOST`. Four first-pass
survivors led to stronger tests (a POST 302 that would succeed on its second hop, the claim-time card change with no attempt,
the inbound unknown state, caller scopes and permissions).

**Live provider run.** 1 of the allowed 1: an inbound A2A task executed by the real local worker (Codex, low effort) through an
isolated app on 4913 — see "Live provider runs" above. Outbound calls to real remote peers were not made (no real internet
call; peers in tests are SDK mock servers on 127.0.0.1).

**Acceptance criteria and evidence.**

| Criterion | Evidence |
|---|---|
| A trusted external A2A agent performs a task and returns a result into a Promptboard pipeline | `network-a2a` "acceptance: … flows into a Promptboard pipeline" (federated step → local agent → report; remote ID exact, `external_unknown`, the report holds the remote answer) |
| A permissioned A2A client submits to one explicitly published local agent through a private, authenticated endpoint | `network-a2a` "acceptance: a permissioned A2A client …" (official SDK client; card lists only the published agent; job `source: a2a` run by the engine's worker; GetTask after a restart; wrong kinds and missing tokens 401; revoke) and the live run |
| Remote state/monitoring limited to protocol evidence | `network-a2a` "outbound states" (every remote state, stream/poll fallback, fixed reasons, never the peer's words), "a remote step … past its time limit ends unknown", "cancelling … confirmed only when the protocol confirms it", "remote answers Promptboard cannot trust"; `network-a2a-ssrf` state mapping |
| Federation off/private until deliberately enabled | `network-a2a` "off by default" (no file, no outbound call, no card or endpoint, 127.0.0.1 only), local-only rows in `remote-access` |
| Task 13 rows of acceptance.md: SSRF (http, private/loopback, redirects, DNS change, credentials after redirect) | `network-a2a-ssrf` (5 tests on the guard, real sockets on 127.0.0.1 for timeouts, pinning and sizes) |
| Malicious card metadata | `network-a2a` "malicious or broken Agent Cards …", `network-a2a-ssrf` "card normalisation", `network-a2a-browser` (markup never becomes HTML) |
| Privacy and secrets | `network-a2a` "outbound credentials …" (the value in no file, event or answer), inbound privacy assertions, "inbound tasks report the job's state honestly" |
| Failure matrix 35, 36, 37 | timeout test (35), SSRF tests (36), duplicate `messageId` → one job (37) |

**Known limits.** A2A 1.x JSON-RPC only (no v0.3 compatibility, gRPC or HTTP+JSON transports). Credentials: bearer and header
API keys from environment variables only (no OAuth 2.0, OpenID Connect or mTLS). Card signatures are not verified. Inbound:
one message per task (no follow-ups or INPUT_REQUIRED answers), no streaming, `ListTasks` or push notifications, agents only
(no pipeline versions), blocking sends return after at most 10 minutes. Remote INPUT_REQUIRED/AUTH_REQUIRED end the job as
failed. Peers are never exported; an imported remote peer node shows as missing until the peer is added again. A sign-in change
also pauses peer jobs (they share the pool). The public card lists the published agents' names to anyone who can reach
127.0.0.1 on the listener port. Real remote peers over the internet were not exercised.

**Expected merge overlaps.** With Task 12 (`feat/network-12`): `src/network/jobs.mjs` (submission, `#pin`, submit, claim,
`#stop`, `spawned`, `#run`, `#pump`), `src/network/http.mjs` (routes appended after `/listener`; the header comment),
`src/network/rest.mjs` (constructor, the A2A branch in `#serve`, `#a2a`, the constant before `route`), `public/network.js`
(sections, `panelOf`, module creation, `render`), `tests/remote-access.test.mjs` (rows beside Task 11's), `src/remote-access.mjs`
(`localOnly`), `src/server.mjs` (wiring), `src/network/activity.mjs` (`jobRow`), `docs/network/architecture.md` (§23 goes
before this §24), this file. With the review fixes (`feat/network-wave-b`): `public/network-pipeline.js`, `public/network-graph.js`,
`src/network/{rest,jobs,pipeline-runner,machine-auth}.mjs` at the places listed in architecture §24 items 7–13.

**Commits.** 40c123b (core: dependency, federation, guard, worker, inbound, Graph and pipeline model), then this entry's commit
(UI, browser test, live smoke script, test additions, docs).

### Security audit fixes (review 4)

An independent security audit of every Network route and the first review of Task 13 at 6d53a9e
(`$TMPDIR/network-logs/review-p4/FINDINGS.txt`, `ROUTES.txt`, repros beside them) listed two P2 and seven P3 findings, no P1.
All nine are fixed on `feat/network-review4` (base 6d53a9e). Each code fix has a test that asserts the correct behaviour in
`tests/network-review4.test.mjs` (server, 17 tests) or `tests/network-review4-ui.test.mjs` (jsdom, 1 test); the final versions
of all 18 were run on an exported copy of the base: 17 fail there, and the one that passes is the env-proxy guard, which
documents behaviour that was already right (`review4-fix-before-final.log`). Architecture §11.2, §11.5 and §24 items 2, 4, 5,
6, 8, 12 and 13 are updated in place; SECURITY.md has two Network paragraphs and one review bullet.

| Finding | Fix | Test (`network-review4*`) | Commit |
|---|---|---|---|
| P4-1 (P2) a peer's result json became a Task 12 question and wedged the job | `finish()` never parses a handoff for a `peerId` job: its json is data only | "P4-1…" (askOwner on: completed, json kept, no message, no handoff event) | fa29758 |
| P4-2 (P2) withdrawing trust did not stop a running peer job | the guarded fetch asks `federation.trusts()` before every request (`PEER_WITHDRAWN`, nothing sent); every saved federation change tells the A2A worker, which aborts the open attempts of a peer no longer trusted; they end `unknown PEER_WITHDRAWN`; the Federation page says so | "P4-2…" ×6 (outbound off, peer off, peer removed, a new card kept: zero transport calls after the withdrawal; an open stream closed; the guard alone) | d63df54, 5407e00 |
| P4-3 the A2A worker kept every attempt | the attempt is forgotten when it ends, or by `cancel()` when the engine stopped it; one stopped during its claim is never kept | "P4-3…" (completed, stopped, stopped before start, stopped during claim) | d63df54, 5407e00 |
| P4-4 refused answers were drained, not closed | `destroy()` instead of `resume()` for refused redirects and non-2xx answers; each attempt's controller is aborted when it ends, so no request or stream outlives its job | "P4-4…" ×2 (a trickling 500 and 302 closed within 1 s; every request signal of an ended attempt aborted) | 1fc326c |
| P4-5 a refresh that moved the endpoint kept the credential | `update()` drops the reference when the endpoint origin changes unless the same PATCH names it; Refresh card… shows the credential, says "moved from A to B" and starts the field empty | "P4-5…" (server: same origin kept, moved dropped and no Authorization sent there, named again kept); `-ui` "P4-5…" | 5fa1f70 |
| P4-6 the private address accepted 0.0.0.0, ::, 169.254.169.254, multicast, broadcast | `privateRange` (RFC 1918, 100.64.0.0/10, fc00::/7: remote access's check minus loopback) for the owner's choice, and again in `allowedAddress`, so a peer saved earlier with another address never reaches it | "P4-6…" | c05184c |
| P4-7 card text kept invisible characters; a peer's name was a prompt label | `said()` removes every `\p{Cf}` character and U+E0000–E007F; an unlabelled remote step is "Remote step" (the run view's Remote peer row shows the peer ID) | "P4-7…" ×2 (normalisation; the next agent's input header) | c05184c |
| P4-8 a credential could name any variable | new references must match `PROMPTBOARD_A2A_[A-Z0-9_]{1,48}`; a peer saved with another name loads with `renameNeeded`, is refused at submit and claim (`CREDENTIAL_REFERENCE_INVALID`, nothing sent) until renamed; never migrated silently; UI help and the Task 13 tests use the new name | "P4-8…" | 5fa1f70 |
| P4-9 (docs) SECURITY.md had no Network section | two paragraphs (external clients; A2A federation) and a review bullet | — (docs) | the docs commit |
| Also | `http.mjs` header: ten local-only routes, not three. DNS lookups in the guard give up after the connect limit or on cancel ("DNS…"). Env proxy: not reachable, see below ("env proxy…") | | 1fc326c, the docs commit |

**Env proxy.** With `NODE_USE_ENV_PROXY=1` (or `--use-env-proxy`) and `HTTP(S)_PROXY` set, Node 24.14.1 sends requests of
the global agents through the proxy, but the guarded transport connects straight to the pinned address: each request has
its own agent (`agent: false`), and Node configures `proxyEnv` only for the global agents. Measured (a probe and the test
"env proxy…": the control request reached the proxy, the guarded one reached the target, plain and TLS), so no change was
needed; the test keeps it that way.

**Test runs** (PATH: a `node` symlink plus `/usr/bin:/bin:/usr/sbin:/sbin`, no AI CLI; logs `$TMPDIR/network-logs/review4-fix-*.log`):
`npm run check` passes. New and changed tests (`network-review4`, `network-review4-ui`, `network-a2a`, `network-a2a-ssrf`) twice
on the final code: 39 of 39 each time (`review4-fix-new-run1.log`, `-run2.log`). Every non-browser `tests/network-*.test.mjs`
(34 files) with `remote-access`, `base-delivery`, `ui`, `ui-2`, `ui-3`, `sandbox-ui` and `project-explorer-ui` (41 files,
concurrency 2): 393 of 394 passed, 0 failed, 1 cancelled (`review4-fix-touched.log`): Compose's "UI sends selected model,
effort, and language…" in `ui.test.mjs` hit the 300 s test timeout under the parallel load; alone it passes in 11 s
(`review4-fix-touched-rerun.log`) and the whole `ui.test.mjs` passes 31 of 31 (`review4-fix-touched-rerun-ui.log`). That run
was on the final source; the two tests added afterwards (5407e00) are in the twice-run above. Every
`tests/network-*browser*.test.mjs` (10 files): 14 of 14 (`review4-fix-browser.log`). The full `npm test` is left to the
coordinator.

**Mutation check** (`review4-fix-mutations.log`; a script outside the repo on an exported copy, each file restored and
hash-checked, `git stash` never used): 24 mutations, each one fix or one part of it reverted on its own; **24 of 24** make
their test fail. The first pass had one survivor, `trusts()` without the card hash, which led to the "a new card kept" case
(5407e00).

**Expected merge overlaps.** Task 14 part 1 (`feat/network-14`) and the wave-B integration (`feat/network`):
`src/network/jobs.mjs` (one line in `finish()`), `src/network/a2a-client.mjs` (`guardedFetch`, `within`, `privateRange`,
`allowedAddress`, the `A2AWorker` constructor, `claim`, `start`, `cancel`, `#withdraw`, `#run`), `src/network/a2a-registry.mjs`
(imports, constants, `said`, `privateAddressOf`, `#write`/`onChange`/`trusts`, `#view`, `#credential`, `update`, `remove`'s
comment, `#usable`, `callable`), `src/network/pipeline-compiler.mjs` (the federated label line), `public/network-pipeline.js`
(the run view's Remote peer row), `public/network-federation.js` (texts, peer row, `openPreview`, `openCredential`,
`confirmRemove`), `src/network/http.mjs` (header comment), `tests/network-a2a.test.mjs` (`PEER_TOKEN` →
`PROMPTBOARD_A2A_PEER_TOKEN`; any new test there that names a credential needs the prefix), `SECURITY.md`,
`docs/network/architecture.md` §11.2, §11.5, §24, and the end of this file. Not touched: `rest.mjs`, `mcp.mjs`,
`schedules.mjs`, `pipeline-runner.mjs`, `server.mjs`, CHANGELOG.md.

**Known limits.** A changed credential reference (Credential…) does not stop a running job; it keeps the value read at its
claim. Cards stored before this fix keep any invisible characters in their saved name until the owner refreshes them (their
hash is pinned, so they are not rewritten); the name is no longer a prompt label either way. A DNS lookup that never answers
keeps its libuv thread until getaddrinfo gives up; Promptboard only stops waiting. Paid CLI runs: 0.

### Task 14 part 1 — End-to-end scenarios, fault injection and performance (2026-10-26, branch `feat/network-14`)

**Scope.** Items 2–6 of `14-verification-and-release.md` on the base 6d53a9e (Tasks 01–13 and every review fix). Not in this
part: README and the docs user guide, the accessibility pass, the security audit (a separate read-only review runs in
parallel), CHANGELOG and the final full regression. No paid or real CLI ran; every scenario uses the fake headless CLIs on a
PATH that holds only them and `node`, or the deterministic fake worker. No live external A2A service was used: the A2A peers
are SDK mock servers on 127.0.0.1.

**Scenarios (permanent tests).**

| Item | Test | What it proves |
|---|---|---|
| 2 local, API | `network-e2e` "local scenario: …" | Base agents created through `POST /api/base/resources` and registered; a nested graph (Desk pins Review desk v1) published, a containment loop refused (`NETWORK_CYCLE`, draft unchanged); a pipeline of two parallel research steps (a barrier in the fake CLIs proves they ran together) → join → a sub-pipeline reviewer from the inner network → approval → report, followed on the NDJSON stream; while the approval waits the Base agent, both networks and the pipeline change and are republished (v2): `plan.json` stays byte for byte, the report is v1's; restart while waiting (nothing runs again), approve, restart after the end (no replay); one job, one CLI run and one key per step, one report per output step, every event of the run exactly once across both restarts; the reviewer ran with the model accepted before the Base edit; a v2 run pins pipeline v2 and the new model; a rejected approval writes no report |
| 2 local, Chrome by mouse | `network-e2e-browser` "Network by mouse in Chrome on the real worker: …" | Real pointer events (at each control's centre, after checking nothing covers it) and typed input only: template → drag a step → save → publish (dialog) → run (confirmation, typed input) → live run view → page reload → app restart (new port, new browser) → approve on the run canvas → the report shown in the page; 3 jobs, 3 CLI runs, one report, exact run history |
| 3 outside client | `network-e2e` "outside client: …" | A real `@modelcontextprotocol/client` host over stdio (`bin/ste.mjs --mcp`) with a token scoped to one agent and one project: agents_list, jobs_submit, jobs_get until completed on the real worker, artifacts_get, a retried key → the same job. The same token: another project, agent, network, memory, lessons and the owner's job are tool errors and start nothing; on the owner API (bearer or `X-STE-Token`) 403; owner paths on the machine listener 404; on a really paired remote listener 401/403; the owner token and a `pb_remote` cookie on the machine listener `MACHINE_CREDENTIAL_REQUIRED`; the token in no file, answer or log |
| 4 federation | `network-e2e` "federation: …" | A mock peer (official `@a2a-js/sdk` server classes) with a card and bearer auth (credential from an environment variable) is approved and is one parallel step of a pipeline beside a local step on the real worker → join → reviewer → approval → report; one remote task, the credential only at the endpoint. Refused before anything is sent: `https://10.0.0.1`, `169.254.169.254`, `127.0.0.1` and an IPv4-mapped private address (`A2A_ADDRESS_REFUSED`), plain http outside a local test (`A2A_URL_INSECURE`), a card whose endpoint is a metadata address (`CARD_ENDPOINT_REFUSED`), a peer nobody approved (`PEER_NOT_FOUND`; a network cannot name it), and an approved peer that redirects to an unapproved origin (`A2A_REDIRECT_REFUSED`; that origin received no request) |
| 5 faults | `network-faults`, `network-faults-worker` | See the matrix below and "Fault cases" |
| 6 performance | `network-perf`, `network-perf-browser`, opt-in `scripts/network-perf.mjs` | See `docs/network/performance.md` |

**Fault cases (item 5).** `network-faults` "a crash after every durable write …": the `network/` folder is copied after
every atomic rename while the MVP pipeline runs on the fake worker (32 distinct crash points: plan, run, request, job, attempt
result, report) and the app restarts on each copy (6 at a time): every job of the copy is kept; one job per step; a job that
had ended is untouched; one that may have started (claimed, launching or running) is `interrupted` (`not_started` or
`uncertain`), not relaunched, and the run `blocked`; only queued jobs and steps without a job start; an approval saved as given
is never asked again and one not given is never assumed; one report, bytes kept; the recorded pid (a live process in its own
group) is never signalled (`process.kill` spy) and outlives every restart. "power loss and damaged files …": every file of a
finished scenario (29 files: registry, drafts, versions, jobs, requests, results, run, plan, report, settings, clients, journal
segments of 2 KiB) torn in half, garbage, removed beside its backup, saved by a newer version, or beside a stray `*.tmp-*` file
(108 variants): the app answers 200 or 409 (never 500), runs nothing, keeps every record or names it unavailable (a file read
from its backup may lack only what its save did not know, and a job read from it says `RESTORED_FROM_BACKUP`), keeps the
damaged bytes, never rewrites a newer file, keeps Kanban (`/api/board`) working, and the journal continues without a repeated
or reordered `seq`. "revocation …": a REST client and an inbound A2A caller revoked while their jobs run (stream ended at
once, 401 on every call, the jobs run on as the owner's to cancel or finish), a Base agent deleted while its job waits
(`BASE_REVOKED`, no attempt), a Base agent switched off while its job runs (runs on, owner cancels, a late result does not undo
it). "a board backup restored …": nothing starts, no Network file changes. `network-faults-worker` (real worker, fake CLIs, no
Gemini CLI): a Base agent changed between submit and claim runs with the accepted model (argv) and instructions (prompt);
output lines no adapter knows, a non-JSON line and a failed tool (new fake markers `[[odd]]`, `[[toolfail]]`) neither end the
job nor put a path into an event or `stream.jsonl`; a missing CLI (`NOT_INSTALLED`) and a signed-out one (`AUTH_REQUIRED`) fail
once and are never retried; output over the limit ends the CLI; an app stop with hung CLIs takes under 10 s, ends their
process groups, and the restart saves them `interrupted` and relaunches nothing. A cancelled pipeline is covered by
`network-pipeline` "cancelling a run cancels …" and `network-pipeline-e2e` run 2. Duplicates by idempotency key: owner REST
(`network-jobs` "idempotency: the same key …"), machine REST (`network-machine` "idempotency and replay …"), MCP (`network-mcp`,
and `network-e2e` "outside client" counts the jobs), inbound A2A (`network-a2a` "acceptance: a permissioned A2A client …", same
`messageId`), sub-jobs (`network-delegation` "one child per key …", `network-review3` P3-6), schedule slots
(`network-schedules` "a restart never fires a slot twice …").

**Failure and recovery matrix (acceptance.md §6) → tests.** ★ rows are rerun by Task 14; "new" marks this part's tests.

| # | Fault | Proven by | Notes |
|---|---|---|---|
| 1 ★ | Lost submit answer, retry with the same key | `network-jobs` "idempotency: the same key …", "job routes over HTTP …"; `network-machine` "idempotency and replay …"; `network-mcp` (same `jobId`); new `network-e2e` "outside client" (MCP retry, job count) | covered |
| 2 ★ | Stop after `queued` | `network-jobs` "a restart after every transition …", "shutdown stops claiming …"; new `network-faults` crash test (queued copies run once) | covered |
| 3 ★ | Stop after claim, before `launchingAt` | `network-jobs` "a restart after every transition …" (`not_started`, retry needs `confirm`); new crash test (with a worker present: interrupted, not started) | covered |
| 4 ★ | Stop after `launchingAt`, before `spawnedAt` | `network-jobs` same test (`uncertain`, `confirmUncertain`); new crash test | covered |
| 5 ★ | Crash while running | `network-jobs` same test (pid shown "may still be running"); `network-worker` "the app runs jobs with the local worker …"; new crash test (the pid is a live process, never signalled, alive after every restart) | covered |
| 6 ★ | Write error on a transition | `network-jobs` "storage failures at submit, claim, launch, spawn and finish …"; `network-worker` "a CLI whose start cannot be put on the record …" | covered; the error is injected (a folder where the `.bak` goes), not a real full disk |
| 7 | `job.json` damaged, `.bak` good | `network-jobs` "a job.json read from its backup …"; `network-review2` P2-8 (`job.recovered`); new `network-faults` power-loss test (torn, garbage, missing) | covered |
| 8 | `job.json` and `.bak` damaged | `network-jobs` same test; new power-loss test ("torn without backup": unavailable, never run, bytes kept) | covered |
| 9 ★ | Newer `version` | `network-registry` "damaged and newer files fail closed …", `network-jobs`; new power-loss test ("newer version" of every mutable file: 409, never rewritten, `/api/board` 200) | covered |
| 10 ★ | Journal partial / corrupt line | `network-events` "journal recovery …"; new power-loss test (segments torn, garbage, removed) | covered; see the limit below |
| 11 ★ | Stream reconnect after a restart | `network-events` "the stream replays from a cursor …"; new `network-e2e` local scenario (each event once across two restarts) | covered |
| 12 ★ | Base disabled/untrusted/deleted while queued | `network-worker` "Base is pinned at acceptance …" (disabled, untrusted); new `network-faults` revocation test (deleted) | covered |
| 13 | Base revoked while running | `network-worker` same test ("revoked after start"); new revocation test (runs on, owner cancels) | covered |
| 14 | Registration disabled while queued | `network-jobs` "claim-time checks fail a job without a process …" | covered |
| 15 ★ | Cancel at the moment of completion | `network-jobs` "cancel races …" | covered |
| 16 | Two claims | `network-jobs` "concurrent submits and claims …" | covered |
| 17 | CLI missing / signed out | `network-worker` "refusals: …", "completion needs the structured final answer …"; new `network-faults-worker` (one attempt, no retry) | covered |
| 18 | Sign-in change while jobs run | `network-jobs` "sign-in waits for Network jobs …" | covered |
| 19 ★ | Exit 0 without a result | `network-worker` "completion needs the structured final answer …" | covered |
| 20 | Output over the limit / timeout | `network-worker` same test (timeout: group gone); new `network-faults-worker` (output limit: the CLI is gone) | covered |
| 21 ★ | Shutdown with running jobs | `network-jobs` "shutdown stops claiming …"; `network-worker`; new `network-faults-worker` (under 10 s, groups gone, no relaunch) | covered |
| 22 ★ | Step job `unknown`/`interrupted` | `network-pipeline` "restart: an interrupted step job blocks …", "retries are bounded …"; new crash test (16 blocked restarts) | covered |
| 23 ★ | Restart with an approval pending | `network-pipeline` "an approval waits for the owner across a restart …"; `network-pipeline-e2e`; new `network-e2e` (API and Chrome); new crash test | covered |
| 24 ★ | Pipeline edited/republished during a run | `network-pipeline` "a running run keeps its exact pinned versions …"; new `network-e2e` local scenario (Base, both networks and the pipeline) | covered |
| 25 ★ | Runner restarts mid-run | `network-pipeline` restart test (a submit cut short is found by its key); new crash test | covered |
| 26 | Result for a stale attempt | `network-pipeline` "receipts that do not hold are never used …"; `network-jobs` "concurrent submits and claims …" | ignored: covered. "Logged": the step records `RECEIPT_INVALID` with its reason; a stale worker report the engine refuses answers `applied: false` and is not journaled, so there is no log line to test |
| 27 ★ | Machine client revoked during a stream / request | `network-machine` "the event stream shows only the client's own jobs, ends at once …"; new revocation test (stream ends at once, 401 afterwards, nothing more delivered) | covered for streams; a plain request is answered from memory in milliseconds, so a revocation inside one cannot be held open offline without a test seam in the listener |
| 28 | Paired device revoked during a stream | `network-events` "streams: four per client and 32 in all …" | covered |
| 29 ★ | Rebinding Host / foreign Origin | `network-http` "Network routes keep the token, Host, Origin and fetch-site checks …"; `network-machine` "Host, Origin and rebinding …" | covered; the answers carry the gate's own codes (`MACHINE_HOST`, `MACHINE_ORIGIN`), given before any route |
| 30 ★ | Owner token / `pb_remote` cookie on the machine listener | `network-machine` "permissions and denials …", "paired-device remote access stays separate …"; new `network-e2e` "outside client" | covered |
| 31 | Import with an unresolved Base ID | `network-registry` "export and import …" | covered |
| 32 ★ | Board backup restored | `schedules` "a backup carries each schedule's settings …" (Kanban); new `network-faults` "a board backup restored …" | covered |
| 33 ★ | Schedule slots missed while closed | `network-schedules` "slots missed while the app was closed give one job …" | covered |
| 34 ★ | Delegation retried / too deep | `network-delegation` "depth and fan-out ceilings …", "one child per key …" | covered |
| 35 ★ | A2A peer times out / stream drops | `network-a2a` "a remote step that runs past its time limit ends unknown …" (step blocked), "outbound states …" (a lost stream → `unknown`) | covered: an `unknown` step job blocks its descendants by the same runner path as row 22 |
| 36 ★ | A2A redirect to a private address / DNS change | `network-a2a-ssrf` "DNS: every answer is checked …", "redirects: only within the same origin …"; new `network-e2e` federation (redirect to an unapproved origin) | covered |
| 37 ★ | Duplicate inbound A2A or webhook request | `network-a2a` "acceptance: a permissioned A2A client …" (same `messageId` → one job) | A2A covered; Network has no webhook receiver, so there is nothing to test |

**Defect found and fixed.** `ddd5a64` + `1dc9be2`: a network or pipeline draft read from its backup (its file torn or
missing) is the save before the last one; when that last save was a publish, the draft no longer listed the new version: its
immutable file stayed on disk but read as `NOT_FOUND`, pipelines pinned to it stopped compiling, and the next publish wrote a
second, different `v<n>` under the same number. `withVersionsOnDisk` (storage.mjs, used by registry.mjs and pipeline-model.mjs)
now gives such a draft every `v<n>-<sha256>.json` in its folder that hashes to its name, belongs to it and continues its list.
Test: `network-faults` "a network or pipeline draft read from its backup …" (failed before the fix).

**Findings not fixed (for the owner, the security review or later parts).**
- A registry file read from its backup (`agents.json`, `clients.json`, as architecture §4.2 rule 2 says) silently lacks the
  last save; the damaged copy is kept as `*.corrupt-*`, but nothing tells the owner. For `clients.json` this could bring a
  client revoked in that last save back as active. It needs damage after the revoke's fsynced write, so it is rare; noted for
  the security review.
- Journal lines are appended without fsync (architecture §4.3: events are observability). After a real power loss the newest
  lines may be gone although live readers saw them; a reader whose cursor is past the kept tail gets `reset` and reloads, but
  if new events pass its cursor before it reconnects it misses them. App crashes (not power loss) keep every written line.
- Architecture §11.2 mentions "Revoke and cancel its jobs" for machine clients; it does not exist: revoking leaves the client's
  running jobs running and the owner cancels them one by one (tested).
- A sub-pipeline's output appears in the parent report as its own Markdown (`# <name>`) under the parent's `## <step>` heading.
- Test fixture only: the fake CLI reads stdin for every call, so the app's sign-in check (`claude auth status`) waits about 10 s
  in browser tests that put the fake `claude` on PATH; the performance browser test therefore uses a PATH with only `node`.

**Performance.** Measured numbers, hardware and load in `docs/network/performance.md`. In short (Apple M2, 8 cores, 16 GB,
load 5–9): every owner-API operation at 5,000 registrations, 5,000 jobs and a 120 MiB journal under 90 ms (the start scan of
5,000 jobs 223 ms); in Chrome a collapsed 100-node Org graph 339–597 ms, a team expanded or collapsed in 130–583 ms, a 1,000-node
graph 317–386 ms inside the page and 2.9–4.1 s on a cold reload (the first software-GL paint), heap 15.8 MB with it drawn; the
job ceiling held (2 of 2) with 40 jobs on the fake worker and with 12 real fake-CLI processes.

**Tests and results** (logs in `$TMPDIR/network-logs/task-14a-*.log`). `npm run check`: all files pass (`task-14a-check.log`).
New non-browser tests twice (`network-e2e`, `network-faults`, `network-faults-worker`, `network-perf`): 14/14 and 14/14, about
57 s each (`task-14a-new-run{1,2}.log`). New Chrome tests: `network-e2e-browser` passed three times (`task-14a-new-browser-run1.log`,
`task-14a-browser.log`, `task-14a-new-browser-run2.log`); `network-perf-browser` in its final form (5714d44) passed twice
(`task-14a-perf-browser-7.log`, `task-14a-perf-browser.log`) and its earlier forms passed in `task-14a-browser.log` and
`task-14a-new-browser-run2.log`. One failure on the way: in `task-14a-new-browser-run1.log`, at a load average of 31–42 from
other agents' suites, a collapse took 17.9 s against the then 15 s bound; the bound became 60 s a step (gross regressions only)
and the test expands five teams instead of ten. Regression: every non-browser `tests/network-*.test.mjs` (36 files, the new ones
and the `network-*-ui` harness tests included) + `remote-access` + `schedules` + the other UI-harness tests (`ui`, `ui-2`,
`ui-3`, `project-explorer-ui`, `sandbox-ui`): 389/389 in 240 s (`task-14a-regression.log`); every `tests/network-*browser*.test.mjs`
(12 files): 16/16 in 170 s (`task-14a-browser.log`). The full `npm test` was not run (the coordinator runs it after the merge).
Performance runs: `task-14a-perf-{server,full,browser,graph-stress,pipeline200}.{log,json}`.

**Expected merge overlaps** with the wave-B integration (`feat/network`): `tests/fixtures/fake-headless-cli.mjs` (two new
markers and their header lines, additive), `src/network/storage.mjs` (one new export), `src/network/registry.mjs` and
`src/network/pipeline-model.mjs` (one line each in `#loadDrafts`, and their storage imports), this file (a new section at the
end). Everything else is new files: `tests/network-e2e.test.mjs`, `tests/network-e2e-browser.test.mjs`,
`tests/network-faults.test.mjs`, `tests/network-faults-worker.test.mjs`, `tests/network-perf.test.mjs`,
`tests/network-perf-browser.test.mjs`, `tests/helpers/network-e2e.mjs`, `tests/fixtures/network-perf.mjs`,
`scripts/network-perf.mjs`, `docs/network/performance.md`. If the integration adds MCP tools, `network-e2e` "outside client"
does not list tools, so it is unaffected. The suite grows by about 1 minute of non-browser tests (two at a time) and about
1 minute of Chrome tests at a low load average (several minutes on a loaded machine).

**Commits.** fb3616a, ee4f5ea (scenarios), 3caf9d6, ddd5a64 and 1dc9be2 (the fix), 5327ead, 816d5f8, 470fa1a, 0cec15f (faults),
fd26c50, 3b477b2, 02ff834 and 5714d44 (performance tests), 538c410 (performance.md), 478c496 (scenario follow-up), and this
entry's commit.

### Task 14 completion and interrupted-session continuation (2026-10-30)

**Review summary.** Add Promptboard Network: Base-linked reusable agents, scoped memory, nested relationship graphs,
durable read-only jobs and pinned execution pipelines, Activity, controlled handoffs and schedules, private REST/MCP,
and separately enabled A2A federation. Existing Base, Origin, Compose and Kanban ownership stays intact. Uncertain
execution is never replayed automatically. Provider observation limits and the future remote-worker scope are explicit.

**Preserved work.** The continuation starts at `feat/network` 970eaea, which contains the wave-B integration. It combines
the saved wave-C work through 69f1c8f (A2A, all review fixes, end-to-end/fault/performance tests) and the saved docs and
accessibility work through 140b67e. Overlaps retain both pipeline schedules and the Run-now double-click protection,
both server option sets, step-job handoff labels, the shared run facts and their privacy explanation. The implementation
remains plain ES modules and DOM JavaScript with the already-selected exact dependency versions. No new commit or push;
main remains e8e158879fbe118a718a41028c3e22d25412eede. Original worktrees and source changes are preserved.

**Task 14 part 2.** README, docs index, user guide, private MCP/REST/A2A setup, troubleshooting and SECURITY.md are
integrated. Dialog focus stays within the modal, errors are announced, confirmations explain what leaves the computer,
and `network-a11y-browser` covers keyboard paths across the Network sections in Chrome. The docs now list all eleven
MCP tools, explain waiting jobs and pipeline schedule confirmations, and remove the old wave-B verification placeholders.
CHANGELOG has the Network release notes under Unreleased; no version bump or release was performed.

**Last security finding closed.** `readSettings` saves a safe state before returning a settings backup, including a
missing primary: registrations off, all clients revoked and listener off, handoffs off with approval required,
schedules off/unconfirmed, federation off with no publications and disabled peers without credential references.
Recovered memory is proposed again. Recovered graphs retain their contents and immutable published versions while
delegation is suspended until **Confirm recovered relations**; renaming cannot confirm permissions. Revisions advance,
damaged bytes and backups remain, the UI shows recovery notices and Activity records `settings.recovered`. A write
failure returns no authority. Intact data keeps its behavior and no recovery repeats just because the app restarts.

**Regression evidence.** `network-settings-recovery` adds five tests using disposable folders, fake workers and a local
SDK peer: torn/missing settings across repeated restarts, revoked REST/A2A clients, no automatic work, actual failed
atomic replacement, newer/both-damaged documents, withdrawn memory approval, and recovered delegation checked over REST
and confirmed through the UI. Existing registry/memory recovery assertions now require the disabled state and fresh
revisions. Seven mutations on an isolated copy, each skipping one domain's recovery reset, all fail with the expected
assertion. No mutation touched the source worktree.

An integration review also covered recovered graphs at the export/copy boundaries: exports omit the local recovery
markers (otherwise strict imports reject them), imported registrations remain disabled, and a duplicate retains its
confirmation requirement. The expanded recovery, registry and HTTP regressions pass 22/22 on Node 22
(`export-recovery-regression.log`); the corrected stream fixture also passes 2/2 on Node 22 (`node22-stream-fixed.log`).

**Validation record.** Logs are retained in the ignored `.pb-shots/network-validation/` folder in this worktree. The
first continuation run's temporary logs and process did not survive the interruption, so the full suite was restarted
without treating that partial run as a pass. Syntax check passes. On official Node 22.22.0 (download checksum verified),
26 recovery/MCP/A2A/UI integration tests and 25 registry/memory tests pass; seven of seven recovery mutations are caught.
The runtime dependency audit reports zero vulnerabilities. Full Node 26.8.2 regression, including headless Chrome, is
complete with exit 0: non-browser 1,759 tests, 1,758 passed, zero failed/cancelled and one skipped (the win32-only IDE
discovery test); Chrome 163/163 passed, with no failures, cancellations or skips. Total: 1,922 tests, 1,921 passed and
one platform skip. The final recovery/export/copy/HTTP cases were rechecked after the full run on Node 26: 22/22 passed
(`export-recovery-node26.log`), matching the Node 22 run. The final syntax check and both staged/unstaged whitespace
checks pass. All 89 checked local documentation links resolve. This project has no separate build, lint or
TypeScript-check script: `npm run check` checks JavaScript syntax and `npm test` runs both regression phases.

The first retained full run completed its non-browser phase: 1,759 tests, 1,757 passed, one failed and one skipped.
The failure was the pre-existing Tasks stream-limit fixture: it retained abort controllers but discarded the HTTP
responses meant to occupy four stream slots. Forced garbage collection on the exported 970eaea baseline reproduces the
timeout; an instrumented copy shows all four slots disappear and the page correctly becomes live. The fixture now retains
the responses, explicitly cancels their bodies at teardown and asserts the occupied count. Its two tests pass normally,
and the stream case passes with forced GC. Evidence: `stream-baseline-gc.log`, `stream-probe-gc.log`,
`integration-ui-fixed.log`, `stream-fixed-gc.log`. No production behavior or deadline was changed. The first browser phase
was stopped cleanly (runner exit 130), its log retained as `suite-initial.log`, and the entire suite restarted with the fix.

**Limits.** This continuation runs no paid provider or live external A2A service; earlier bounded live checks remain
recorded above. Gemini live support was not established by the earlier provider run. Mobile layouts and keyboard paths
are automated in Chrome; physical mobile Safari and a human screen-reader session are not claimed. The three partial
failure-matrix rows and event-journal power-loss caveat from part 1 remain documented. Remote process control, webhooks,
enforced cost budgets and multi-host workers remain outside this MVP.

### Preview and PR publication (2026-11-02)

The completed app was opened beside the conversation at `http://127.0.0.1:4955` with separate data under the ignored
`.pb-shots/network-preview/` folder. Its local worker runs simulated headless CLIs; it uses no provider credits or
normal Promptboard data. The visible responsive UI was used to register Scout, Analyst and Editor, publish the graph,
create and publish the parallel-research template, run it, approve its human gate and open the saved report. The durable
record confirms three completed jobs, one attempt each, and run history `running → waiting_for_approval → running →
completed`. Demo run: `run_5506d36fb5bc631d2a05`.

Fetched `origin/main` is 67aff01 and is already an ancestor of the feature branch; no main-branch reconciliation is
needed. The staged diff and the complete feature diff were reviewed, with no board/state-schema changes and no preview
data included. Syntax and runtime dependency audit pass (zero vulnerabilities).

A fresh affected-suite run exposed the same discarded-Response fixture issue in `network-review2-ui`, which now also
retains and explicitly cancels its four stream responses. Its security/status assertions and all deadlines remain
unchanged. The first run also recorded a 459 ms event-loop stall and two tests delayed about 500 seconds under heavy
machine load. All 25 tests in the affected files pass serially on Node 22; the loop test reports 21 ms stall on that run.
The entire Network/remote-access suite was rechecked on Node 22 with idle sleep inhibited: 270/270 non-browser tests
(42 files) and 18/18 Chrome scenarios (14 files), zero failures, cancellations or skips, exit 0. No timing threshold was
relaxed. The preview/report data and local runtime helpers remain ignored and are excluded from the commit.
Logs: `.pb-shots/network-validation/pr-*`. The branch is ready to publish for the full GitHub CI matrix and review.
