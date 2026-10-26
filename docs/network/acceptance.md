# Network acceptance contract

The tests each Network task must add and pass, the failure and recovery matrix, and the gates between the MVP, the
later federation work and the release. Design decisions referenced as §N are in [architecture.md](architecture.md);
requirements are in [NETWORK_REQUIREMENTS.md](NETWORK_REQUIREMENTS.md).

## 1. Ground rules for every task

- **Regression gate:** `npm run check` and the full `npm test` pass, or each failure is named, rerun alone, and shown
  to be a known load flake that also fails on the base commit. The Task 01 baseline is in
  [implementation-progress.md](implementation-progress.md) ("Task 01").
- **Route table:** every new route is listed in `tests/remote-access.test.mjs` (`ALLOWED` or `LOCAL_ONLY`), and
  `src/network/http.mjs` is in that test's scanned file list (from Task 02).
- **Isolation:** tests use temporary data folders (`tests/helpers/test-server.mjs`), fake CLIs on a PATH that holds
  only them and `node`, and never the owner's data, port 4318, or a real signed-in CLI. A live-provider test is a
  separate file that skips unless `PB_NETWORK_LIVE=claude` or `PB_NETWORK_LIVE=codex` is set, and it is logged in the
  progress file when run.
- **Browser tests** use `tests/helpers/browser.mjs`, call `browser.resize(w, h)` before width-dependent checks, test
  light and dark themes and the ≤ 730 px phone layout, and use handshakes instead of timing.
- **No secret** (token, cookie, machine token, credential value) appears in any file under `network/`, any event, any
  export, any HTTP response other than the one-time creation response, or test output. Each task that stores or emits
  data adds one assertion that greps its outputs for the secrets used in the test.

## 2. MVP tasks (02–11)

### Task 02 — registry and storage

`tests/network-registry.test.mjs` (module level) and `tests/network-http.test.mjs` (server level):

1. Register a Base `profile` and an `agentProfile`: `agents.json` holds only `baseResourceId` and Network fields;
   `state.json` bytes and `base.revision` are unchanged (compare before/after).
2. Edit the Base agent (new model): the registration view shows the new model; `agents.json` is unchanged.
3. Missing, wrong-kind, disabled and untrusted Base resources: registration refused (`BASE_PROFILE_INVALID`) or
   existing registration reported `stale: true` with a reason.
4. Restart (new `startServer` on the same data folder): same IDs, revisions, scopes, drafts and versions.
5. Two concurrent PATCHes with the same `expectedRevision`: one succeeds, one `409 REVISION_CONFLICT`; the file holds
   exactly one change.
6. Draft save → publish v1 → edit draft → publish v2: v1 file bytes and hash unchanged; `GET …/versions/1` returns v1.
7. Containment cycles refused with the cycle path: self, A→B→A, A→B→C→A, through a pinned published version.
8. Corrupt `agents.json` with a good `.bak`: loads the backup, sets the damaged file aside. Corrupt both: refuses
   (`NETWORK_DATA_DAMAGED`) without writing. `version: 2`: `409 NETWORK_VERSION_UNSUPPORTED`, file unchanged.
9. A published version file whose content no longer matches its hash: `NETWORK_CONTENT_INVALID`.
10. Export → import into an empty data folder with the same Base: identical graph; import with colliding IDs remaps
    every reference; import with an unknown `baseResourceId` is refused and writes nothing; imported registrations are
    disabled. Export contains no job, event, client, token or path.
11. Routes: missing token `403`, wrong Host `403`, foreign Origin `403`, `sec-fetch-site: cross-site` `403`, oversized
    body `413`, non-JSON `415`; paired device reaches every Task 02 route (route table updated).
12. No save, publish or import starts a process (spy on `spawnOwned`/runner: zero calls).
13. Legacy fixtures: an existing board, Base, backup and Origin project load and export byte-identically to before.

### Task 03 — Network page and agent directory

`tests/network-ui.test.mjs` (jsdom, `tests/helpers/ui-harness.mjs`) and `tests/network-browser.test.mjs` (Chrome):

1. Nav shows Origin · Compose · Kanban · Base · Network; `#/network` shows `#network-view` only, sets `aria-current`,
   the title "Network · Promptboard" and the skip link; back/forward between all five pages and Network sub-routes.
2. Start page "Network" applies only without an explicit route; the other four pages still open and behave as before
   (existing `ui*.test.mjs` and browser tests green).
3. Directory is filled from `GET /api/network/agents` (the test server holds two registrations; no static data);
   search and filters by role, capability, provider and status.
4. Create a registration from an existing Base agent; enable/disable it; Base data unchanged; "Open in Base" opens that
   exact resource (`openResource`).
5. Revision conflict shows a reload message; a stale registration shows its reason; empty and error states render.
6. Keyboard: tablist arrows, every control reachable and labelled; no button without an action (each visible button
   either works or is absent/disabled with an explanation).
7. Phone layout (390 px) list → detail; light and dark themes.
8. Opening and editing never call job, run or generation routes (request log assertion).

### Task 04 — agent memory and posts

`tests/network-memory.test.mjs`:

1. Propose → approve → edit → reject → delete, each with `expectedRevision`; stale approval `409`.
2. Restart keeps records; scope isolation: agent A's memory never appears in agent B's view, preview or prompt;
   network memory only for jobs of that network; project lessons only with `projectLessons: true` and an allowed
   project; another project's lessons never (assert on the composed `prompt.md` in Task 07, on the preview here).
3. Size limits: record > 4,000 characters `413`/`INVALID_INPUT`; preview total ≤ 8,000 characters, newest first, with
   the omitted count.
4. A proposal containing a credential-looking value is masked or refused; HTML/script content is stored as text and
   rendered as text.
5. Existing Project Memory (`tests/lessons*.test.mjs`) passes unchanged; Network never writes `lessons/`.
6. Posts: create/edit/delete, limited Markdown rendered safely, labelled "Report"; never listed as an event or a job.

### Task 05 — Graph designer and nested networks

`tests/network-graph.test.mjs` (model and routes), `tests/network-graph-ui.test.mjs` (jsdom, the keyboard lists) and
`tests/network-graph-browser.test.mjs` (Chrome, the canvas and the stress fixture):

1. Build a 3-agent network containing a pinned 2-agent sub-network; save; reload; positions, edges and relations
   identical.
2. One sub-network version used by two parents; the stored parents contain only `{ networkId, version }`.
3. Cycle attempt shows the cycle path and leaves the draft unchanged; deleting a used network is refused
   (`NETWORK_IN_USE`).
4. Disabled or stale agent nodes are highlighted; relations are typed; no self-relation.
5. Unsaved changes warn on navigation; save uses CAS and shows conflicts.
6. Cytoscape loads from `/vendor/cytoscape.min.js`; no CSP violation is reported in the console (the stylesheet
   placeholder works); no CDN request.
7. Stress fixture: 1,000 synthetic visible nodes and 500 with lazy expansion: first render and a pan/zoom step are
   measured and logged (target: first render under 3 s on the test machine), memory delta logged; the expanded-view
   cap shows its notice.
8. Keyboard node list and connect controls; phone layout shows the list fallback.
9. Saving or publishing makes zero job or generation requests.

### Task 06 — job engine (fake worker)

`tests/network-jobs.test.mjs` (engine and HTTP; the fake worker is `tests/helpers/network-worker.mjs`):

1. Submit returns `{ jobId, status: 'queued' }` after `job.json` and `request.json` exist on disk; the fake worker
   completes it; status sequence `queued → preparing → running → completed` in `job.json` history.
2. Same idempotency key twice (sequential and concurrent): one job, the second answer `deduplicated: true`; same key
   with a different body `409 IDEMPOTENCY_CONFLICT`; keys of different requesters do not collide.
3. Two claimers race for one job: exactly one attempt; the loser's writes are ignored.
4. Restart after each durable transition (inject a crash by stopping the server between steps): queued stays queued
   and inert until the pool claims it; preparing without `launchingAt` → `interrupted`/`not_started`; with
   `launchingAt` → `interrupted`/`uncertain`; no automatic relaunch.
5. Storage failure (injected `writeAtomic` error) at submit, claim, launch and finish: the API reports
   `NETWORK_WRITE_FAILED`, in-memory and disk state agree, a spawned fake process is killed.
6. Cancel races: cancel during queued, preparing, running, and at the same moment as completion; final state is the
   one that was saved first; a late result is kept as `late-result.md` only.
7. Retry of `interrupted`/`unknown` needs `confirm`, and `confirmUncertain` when the outcome is uncertain.
8. Malformed inputs: unknown fields, oversized input, bad IDs, disabled agent, unknown project: `400`/`409` without a
   job file.
9. No Kanban change: `state.json` bytes unchanged after 20 jobs; no card, branch or worktree.
10. Sign-in change: `POST /api/auth/login` while a job runs answers `409 RUNS_ACTIVE`; a job queued during a sign-in
    change waits and starts after it.
11. Concurrency ceiling respected (setting 1, 2, 4).
12. Retention: the sweep removes only old terminal outputs, never a job referenced by a non-terminal run or parent.

### Task 07 — local worker runtime

`tests/network-worker.test.mjs` (fake headless Claude, Codex and Gemini executables, like `tests/research-cli.test.mjs`)
and `tests/network-worker-live.test.mjs` (opt-in):

1. Exact argv per provider and tool mode (`none`, `web`): only the flags of architecture §7.2; Antigravity and Gemini
   `web` refused with a reason.
2. Exact `prompt.md`: header, pinned agent instructions, approved memory, permitted lessons only, Base sections, input
   inside the data delimiters.
3. Base pinning: editing the Base agent after acceptance does not change the job's tuple; disabling or untrusting it
   before launch fails the job with `BASE_REVOKED`; a required Base MCP refuses the job; optional ones are listed as
   omitted.
4. Working directory: an empty attempt `workspace/`; no file outside `network/jobs/<id>/` is created (snapshot of the
   data folder and a temp project repository before/after).
5. Completion rules: result event + exit 0 → `completed`; exit 0 without result → `unknown`; structured rate limit →
   `failed RATE_LIMITED`; non-zero exit → `failed`; output over the limit → `failed OUTPUT_LIMIT`; timeout → `failed
   TIMEOUT` with the process group gone.
6. Cancel and app stop with three concurrent jobs: process groups end, statuses `cancelled`/`interrupted`, no orphan
   fake process (check by pid).
7. Coverage labels: Claude `tools`, Codex `partial-tools`, Gemini `final-only`; tool activity events only for
   providers that reported them.
8. Usage: `reported: true` only when the fake stream contains the fields; otherwise `reported: false`.
9. Existing suites for Kanban, Supervisor, Autopilot, Origin Research and Base stay green (R1/R2 do not change
   defaults).
10. Live (opt-in): one research/report job with a real signed-in Claude or Codex returns a non-empty result and a
    `completed` status; the run is logged in the progress file with provider, model and result.

### Task 08 — events and Activity

`tests/network-events.test.mjs` and `tests/network-activity-browser.test.mjs`:

1. Every job transition appends one event; `seq` strictly increases; IDs unique.
2. `GET /api/network/events?after=N&limit=` pages exactly; filters by agent, job, network and pipeline run.
3. Stream: initial replay from `after`, live events, ping, reconnect with the last `seq` gives each event exactly once
   across a server restart.
4. Journal recovery: partial last line dropped; a corrupt middle line skipped and counted; segment rollover; `seq`
   continues.
5. Redaction: events contain no prompt text, tool arguments, paths or secrets used in the test.
6. Revocation: a paired device's stream ends when it is revoked; stream ceilings enforced.
7. Activity view updates without reload; `unknown` and `waiting` are visually distinct; a Codex job shows its
   coverage note; no percentage or cost appears unless reported; zero events shows the empty state.
8. Kanban runs of a registered Base agent appear read-only with "Open in Kanban"; no Supervisor change.

### Task 09 — pipeline compiler and runner

`tests/network-pipeline.test.mjs` (fake worker) and `tests/network-pipeline-e2e.test.mjs` (fake CLIs through the
real worker):

1. Compiler refuses: cycle, recursive sub-pipeline, depth > 4, > 2,000 expanded nodes, agent not in the pinned network
   version, disabled agent, port mismatch, condition on a text port, unknown config key.
2. Topological order; two independent branches run at the same time (both fake jobs observed running together);
   join waits for both; condition true/false paths; skipped branches.
3. Approval node: run waits; restart keeps it waiting; reject cancels dependents; approve continues; only the owner
   route can approve.
4. Pinning: edit and republish the pipeline and its network during a run; the run's `plan.json` hash and behaviour
   are unchanged.
5. A step job ending `unknown` or `interrupted` blocks descendants; the run is `blocked` with the reason; owner retry
   resumes; nothing is resubmitted on its own.
6. Restart in the middle: no duplicate step jobs (idempotency keys); completed steps are not rerun.
7. Cancel the run: running step jobs cancelled, pending nodes cancelled.
8. Deadline, per-step timeout and bounded retries (≤ 2) honoured; retries create new attempts of the same job.
9. Output node writes `report.md` from the selected upstream results in order.
10. Inconsistent worker receipt (a job reports `completed` for another attempt) is ignored.

### Task 10 — Pipeline designer and run viewer

`tests/network-pipeline-browser.test.mjs`:

1. Build the MVP pipeline from the palette (two research agents → join → reviewer → approval → output); validation
   messages appear on the bad node or edge; publish; run with the confirmation dialog (agents, permissions,
   concurrency, "cost: not enforced").
2. Live run view: node states change from the event stream; approve from the node; open job; cancel run.
3. Editing the draft while the run is active leaves the run view and result unchanged.
4. Graph and Pipeline modes have different edge styles and explanations; a graph relation cannot be pasted into a
   pipeline.
5. Phone layout shows the ordered step list; keyboard paths for add, connect, configure, approve.

### Task 11 — private REST and MCP

`tests/network-machine.test.mjs` and `tests/network-mcp.test.mjs`:

1. Fresh install and opening Network: no machine listener (port closed); turning it on is a local-only route
   (paired device gets `REMOTE_LOCAL_ONLY`).
2. Create a client: token shown once; `clients.json` holds only the hash; a list never returns it.
3. REST: list allowed agents only; submit returns `202 { jobId }` immediately; poll; fetch result; cancel own job;
   another client's job `404`.
4. Denials: agent, project or memory outside scope `403`; owner routes with a machine token `403`; machine routes with
   the owner token or `pb_remote` cookie `403 MACHINE_CREDENTIAL_REQUIRED`; revoked token `401` and its stream closes.
5. Host/Origin: wrong Host `403` (DNS rebinding), foreign Origin `403`, no CORS headers, oversized body `413`, rate
   limit `429`.
6. Idempotency-Key replay returns the same job.
7. MCP: a real `@modelcontextprotocol/client` 2.3.1 `Client` with `StdioClientTransport` starts `node bin/ste.mjs
   --mcp`, lists tools, `agents_list`, `jobs_submit` (gets `jobId` at once), `jobs_get` until `completed`,
   `artifacts_get`; an unauthorized agent is refused.
8. Same-provider nesting: an MCP submit while a job of the same provider runs is queued, not blocked or deadlocked.
9. Secrets: the token never appears in `network/` files, events, logs captured by the test, or MCP responses.
10. Restart: clients persist; jobs submitted by a client stay visible to it; missing worker leaves jobs queued.

## 3. MVP demonstration (NETWORK_REQUIREMENTS.md "MVP demonstration")

Must pass before Task 12 starts; proven by the tests named.

| Step | Proven by |
|---|---|
| 1. Register a reusable Base Agent, find it on the Network page, use it in 2 private networks, restart, same ID and scopes | Task 02 tests 1, 4; Task 03 tests 3–4; Task 05 test 2 |
| 2. Graph with two agents and a nested network, publish v1, edit the draft without changing v1, reject a recursive containment loop | Task 02 tests 6–7; Task 05 tests 1–3 |
| 3. Pipeline: two parallel research steps → join → reviewer → human approval → saved report, with fake CLIs; live statuses, durability, output, cancel/restart, no duplicate runs | Task 09 tests 2–6, 9; Task 10 tests 1–3; Task 08 test 3 |
| 4. External local client via REST and MCP creates an authorized job, gets a job ID, polls/streams it, fetches the result; unauthorized project/memory access denied | Task 11 tests 3–4, 7 |
| 5. One opt-in smoke test with a real signed-in CLI | Task 07 test 10 (logged in the progress file; if no CLI is available that is stated, not claimed) |
| 6. No regression in Base, Compose, Origin, Kanban, Docker sandbox, project lessons, native session recovery, paired-device access | full `npm test` on the MVP head; route table test |

## 4. Later tasks (12–13)

### Task 12 — delegation, messages, schedules

`tests/network-delegation.test.mjs` and `tests/network-schedules.test.mjs`:

1. Agent A's structured delegation request creates a child job for agent B only when the job's network has a
   `delegate` relation A → B and the policy allows it; otherwise refused and recorded.
2. Depth and fan-out ceilings, budget share, no permission escalation, no other project; a retry of the parent does
   not create a second child (idempotency key `job:<parent>:delegate:<n>`).
3. Messages: bounded, kinds validated, read receipts separate from execution status.
4. Cancel parent cancels children; revoked registration blocks new children.
5. Schedules: off until the owner confirms; one coalesced job after downtime; no pile-up while the previous job is
   active; restart does not fire the same slot twice; zone change shows the warning and does not fire.
6. Activity shows the child tree, handoffs and schedule origin.

### Task 13 — A2A federation

`tests/network-a2a.test.mjs` (mock peers built with `@a2a-js/sdk` 1.3.0 server classes on loopback):

1. Federation off by default: no Agent Card route, no outbound call.
2. Preview and approve a peer card (local-only routes); malicious card fields (oversized, HTML, odd URLs) are
   bounded or refused.
3. Outbound task through a pipeline `federated` node: states mapped, artifacts bounded, remote ID kept opaque; timeout
   → `unknown` and descendants blocked.
4. SSRF: `http:` refused (unless loopback test mode), private and loopback addresses refused, redirect to another
   origin refused, DNS answer changing between check and connect refused, credentials not sent after a redirect.
5. Inbound: card lists only published agents; unauthenticated or wrong-kind client refused; an inbound task creates a
   Network job (no direct CLI); its status and result are returned through A2A.
6. No public listener at any point; privacy: no memory or terminal data in A2A responses.

## 5. Release (Task 14)

`tests/network-e2e.test.mjs` plus a performance script under `scripts/`:

1. Local E2E through the real UI and API with fake CLIs (the MVP demonstration in one scenario), including reload and
   restart.
2. Outside E2E: MCP client with a scoped token submits and retrieves; unrelated project and owner API refused.
3. Federation E2E with a mock peer; non-allowlisted endpoints refused. Live external services are not claimed unless
   used.
4. Fault injection: every row of §6 below that is marked for Task 14.
5. Performance: 1,000+ registrations and graph nodes, 50 nested networks; render, save and reload timings and memory
   reported as measured numbers.
6. Accessibility and security audit of every new route (Host/Origin/token/machine checks, redaction, SSRF, scopes).
7. Docs: README, `docs/network/*`, SECURITY.md (only as needed), CHANGELOG (Task 14 only).

## 6. Failure and recovery matrix

"Expected" is what the stored state and the UI must show. "Never" lists what must not happen. Each row names the task
whose tests prove it; Task 14 reruns the rows marked ★.

| # | Fault | Expected | Never | Task |
|---|---|---|---|---|
| 1 | Response to a submit is lost; client retries with the same idempotency key | same `jobId`, `deduplicated: true` | a second job | 06, 11 ★ |
| 2 | App stops after `queued` was saved | job stays `queued`, claimed after start | a job lost or run twice | 06 ★ |
| 3 | App stops after claim, before `launchingAt` | `interrupted`, `outcome: not_started`; retry needs `confirm` | relaunch on its own | 06 ★ |
| 4 | App stops after `launchingAt`, before `spawnedAt` | `interrupted`, `outcome: uncertain`; retry needs `confirmUncertain` | relaunch on its own | 06, 07 ★ |
| 5 | App stops (or crashes) while running | `interrupted`/`uncertain`; recorded pid shown as "may still be running" | signalling a pid after restart; relaunch | 07 ★ |
| 6 | Disk full / write error on any transition | API error `NETWORK_WRITE_FAILED`; memory = disk; a spawned process is killed | a process without a saved record | 06, 07 ★ |
| 7 | `job.json` damaged, `.bak` good | loaded from backup, damaged file set aside, event `job.recovered` | silent data loss | 06 |
| 8 | `job.json` and `.bak` damaged | job listed as damaged (read-only); never claimed | deletion; a run | 06 |
| 9 | Network file with a newer `version` | that domain answers `409 NETWORK_VERSION_UNSUPPORTED`; Kanban works | overwriting the file | 02, 06 ★ |
| 10 | Journal ends in a partial line / has a corrupt line | partial dropped, corrupt skipped and counted, `seq` continues | duplicated or reordered `seq` | 08 ★ |
| 11 | Client reconnects to the stream after a restart | each event once from its last `seq` | gaps or repeats | 08 ★ |
| 12 | Base agent disabled/untrusted/deleted while queued | claim fails `BASE_REVOKED`/stale | running with other content | 07 ★ |
| 13 | Base revoked while running | job continues, marked "revoked after start"; owner can cancel | silent kill or silent success claim | 07 |
| 14 | Registration disabled while queued | `failed REGISTRATION_DISABLED` | a run | 06 |
| 15 | Cancel at the same time as completion | the first saved transition wins; late result kept separately | a cancelled job reported completed | 06 ★ |
| 16 | Two claims for one job | one attempt | two processes | 06 |
| 17 | CLI missing or signed out | `failed NOT_INSTALLED` / `AUTH_REQUIRED` | retries | 07 |
| 18 | Sign-in change requested while jobs run | `409 RUNS_ACTIVE`; queued jobs wait during a change | a job started mid-change | 06 |
| 19 | CLI exits 0 without a structured result | `unknown` | `completed` | 07 ★ |
| 20 | Output over the limit / timeout | `failed OUTPUT_LIMIT` / `failed TIMEOUT`, process group gone | an orphan process | 07 |
| 21 | App shutdown with running jobs | `interrupted` saved within the grace period; processes killed | hang on shutdown | 07 ★ |
| 22 | Pipeline step job `unknown`/`interrupted` | node `blocked`, descendants pending, run `blocked` | dependents started | 09 ★ |
| 23 | Restart with an approval pending | still pending | auto-approval | 09 ★ |
| 24 | Pipeline edited/republished during a run | run keeps its `plan.json` | behaviour change | 09, 10 ★ |
| 25 | Runner restarts mid-run | existing step jobs found by idempotency key | duplicate step jobs | 09 ★ |
| 26 | Worker reports a result for a stale attempt | ignored and logged | node released | 09 |
| 27 | Machine client revoked during a stream / request | stream destroyed; `401` afterwards | further data | 11 ★ |
| 28 | Paired device revoked during a Network stream | stream destroyed | further data | 08 |
| 29 | Request with a rebinding Host or foreign Origin | `403` | handler reached | 02, 11 ★ |
| 30 | Owner token or `pb_remote` cookie sent to the machine listener | `403 MACHINE_CREDENTIAL_REQUIRED` | accepted | 11 ★ |
| 31 | Network import with an unresolved Base ID | whole import refused | partial import | 02 |
| 32 | Board backup restored | no Network job, run or schedule starts | any execution | 02, 12 ★ |
| 33 | Schedule slots missed while closed | one coalesced job; skipped while the previous job is active | a pile-up or a replayed slot | 12 ★ |
| 34 | Delegation retried / chain too deep | one child; depth refusal | duplicate or unbounded children | 12 ★ |
| 35 | A2A peer times out or the stream drops | step `unknown`, descendants blocked | `completed` assumed | 13 ★ |
| 36 | A2A redirect to a private address / DNS change | refused | request sent | 13 ★ |
| 37 | Duplicate inbound A2A or webhook request | one job (idempotency) | two jobs | 12, 13 ★ |
