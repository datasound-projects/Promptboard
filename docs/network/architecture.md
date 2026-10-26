# Network architecture (integration contract)

This document is the binding design for the Promptboard Network feature (Tasks 02–14). It was written in Task 01 from
an audit of HEAD `ade0233` on `feat/network`, whose code is identical to `origin/main` `67aff01`. `file:line`
references point at that code. Requirements come from [NETWORK_REQUIREMENTS.md](NETWORK_REQUIREMENTS.md); the tests
that prove each task are in [acceptance.md](acceptance.md).

Each section below makes a decision. A later task that needs to deviate records the deviation and its reason in
[implementation-progress.md](implementation-progress.md) before it changes code.

## 1. Audit result

- **No Network implementation exists.** `src/network/` does not exist; `grep` over `src/`, `public/`, `tests/`, `docs/`
  and `README.md` finds no `/api/network`, `#/network`, `networkId`, `AgentRegistration`, A2A or Cytoscape code. The
  hits for the word "network" are network errors and Origin's "Networking" checklist entry.
- **No upstream changes to merge.** `git ls-remote origin` shows `main` at `67aff01` and no branch with "network" in its
  name (133 heads checked on 2026-10-26).
- **Nothing in this task changes runtime code, `state.json`, board backups or any existing file format.**

## 2. Existing integration points

| Area | Where (HEAD) | What Network uses it for |
|---|---|---|
| Owner request checks | `src/server.mjs:463-489` `handle()`: Host/Origin allowlist (470-475), proxy headers refused (477-479), `sec-fetch-site` (481), `X-STE-Token` for every `/api/` path (485-487), `/api/remote` local only (488-489) | Owner Network routes sit behind these checks unchanged. |
| Route dispatch pattern | `src/server.mjs:519-522` (`/api/coordinator` → `coordinatorRoute`, `sendFailure` fallback) | `/api/network` is added the same way. |
| Error mapping | `src/server.mjs:125` `EXPOSED`, `127-135` `failureBody` | `NetworkError` is added to `EXPOSED`. |
| JSON body limit | `src/server.mjs:96-109` `jsonBody(req, limit)` | Reused for every Network body. |
| Static files | `src/server.mjs:52-79` `assets`, `82-88` `vendor`, `759-764` | `/network*.js` and `/vendor/cytoscape.min.js` are added by exact path. |
| Streams | `src/server.mjs:345-357` `streamRun` (NDJSON over fetch, 15 s ping, token in a header) | Template for the Network event stream. |
| Shared CLI job slot | `src/server.mjs:406-432` `claim`/`release`; sign-in refused while sessions or batches run (410-411); lessons yield (414) | Network jobs do **not** take this slot (§7.3); sign-in must also wait for Network jobs. |
| Bounded side pool | `src/server.mjs:455-456`, `src/compose-batch.mjs:27` `BATCH_LIMITS` (global 8), `:192` `activeCount()` | Model for the Network job pool. |
| Shutdown | `src/server.mjs:787-818` `close()`, `killOwnedProcesses('SIGKILL')` (814) | Network closes its pool and listener here. |
| Paired devices | `src/remote-access.mjs:261-302` `serve()` (cookie session, Host/Origin), `:343-349` `localOnly()`, `:112` open responses per session, `:205-212` revoke ends streams | Owner Network routes are allowed from a paired device except the local-only list in §10.2. |
| Route table test | `tests/remote-access.test.mjs:248-293` (scans `server.mjs`, `base-http.mjs`, `sandbox.mjs` for route literals) | Every Network route goes into that table, and `src/network/http.mjs` into its file list. |
| One app per data folder | `src/instance-lock.mjs:24`, `src/server.mjs:362` | Single writer: in-process `serial()` queues are enough. |
| Durable files | `src/durable.mjs:38` `writeAtomic`, `:54` `readWithBackup`, `:67` `setAside`, `:72` `serial` | Every Network file. |
| Domain-file precedent | `src/lessons.mjs:21,43-50` (schema/version, newer version refused), `:208-240` (set aside, CAS `#change`); `src/coordinator.mjs:49-78` (gzip per project) | Same discipline for Network files. |
| Board state | `src/store.mjs:19` `STATE_VERSION = 14`, `:42-88` `checkShape`, `:250-262` `update` clones and rewrites the whole file | Network stores **nothing** in `state.json` (§4). |
| Base registry | `src/base.mjs:13` `BASE_KINDS`, `:369` `Base`, `:379` `readRevision(ref)` (hash-checked immutable revisions), `:515-560` `remove` | Registrations reference Base IDs; jobs pin `revisionRef`s. |
| Base resolution | `src/base-resolver.mjs:18` `profileDefaults`, `:39` `deliveryFor`, `:55-216` `resolveBase` (layers 63-69), `:224` `checkBaseRevocations` | Agent tuple, manifest and revocation checks for jobs. |
| Base preparation | `src/base-context.mjs:172` `prepareBase` | Turns a pinned manifest into prompt sections. |
| Base deep link | `public/base.js:1328` returns `openResource`; `public/app.js:6257` `window.PromptboardBaseView` | "Open in Base" from Network without a second editor. |
| Kanban run path | `src/board.mjs:2755` `requestRun` → `:2869` `#startRun` → `:2924` run record → `:2953` `executor.start`; `src/supervisor.mjs:116` `start`, `:121` `#pump`, `:211` `#launch`, `:223-316` `#launchSession` | Traced in §7.1; not used for Network jobs. |
| PTY adapters | `src/agents.mjs:40-101` `ADAPTERS`, `:122` `resolveConfig`, `:202` `buildSession`, `:308` `interpretEvent` | Capability evidence (§8); not used for Network jobs. |
| Headless runners | `src/providers.mjs:38` `buildCommand`, `:107` `resolveExecutable`, `:187` `cliEnv`, `:190` `spawnOwned`, `:373` `classifyProviderFailure`, `:444` `runProvider`; `src/research-cli.mjs:17` `researchArgs`, `:80` `streamResearch` | The Network worker's execution path (§7.2). |
| Activity vocabulary | `src/session-activity.mjs:144-155` `snapshot()` (`coverage`, `phase`, `uncertain`) | Same words in Network activity. |
| Usage | `src/usage.mjs:37-82`, `src/supervisor.mjs:565-580` | "Reported, never estimated" rule. |
| Project memory | `src/lessons.mjs:69` `lessonsPrompt(dataDir, projectId)` (read-only) | The only way a job sees a project's lessons. |
| Redaction | `src/compose-local.mjs:21` `redactLocal`, `src/coordinator.mjs:40` `noPaths` | Event messages, memory proposals, prompts. |
| File names from IDs | `src/origin.mjs:35` `escapeId` | Case-safe file names. |
| Kanban schedules | `src/schedules.mjs:35` `normalizeCadence`, `:57` `nextFire` (pure) | Reused by Network schedules (Task 12). |
| SSRF-checked fetch | `src/base-context.mjs:26` `isPublicAddress`, `:37` `fetchDocument` | Pattern for A2A's guarded `fetchImpl` (Task 13). |
| Frontend routing | `public/app.js:1368` `currentPage`, `:1369-1399` `showPage`, `:4139` `hashchange`, `:5901-5905` start-page pref, `:6314`; `public/index.html:46-51` nav, `:424` start-page select, `:13-39` scripts | Fifth page (§12). |

## 3. Domains and ownership

| Entity | Source of truth | Owner module (to create) | Created in task |
|---|---|---|---|
| Base Agent (`profile`) and Agent Profile (`agentProfile`) | `state.json` `base.resources` (unchanged) | `src/base.mjs` (unchanged) | existing |
| Agent registration | `network/agents.json` | `src/network/registry.mjs` | 02 |
| Network draft | `network/networks/<id>.json` | `src/network/registry.mjs` | 02 |
| Network published version | `network/networks/<id>/v<n>-<sha256>.json` | `src/network/registry.mjs` | 02 |
| Agent / network memory | `network/memory/<scope>.json` | `src/network/memory.mjs` | 04 |
| Profile posts (reports) | `network/posts/<agentId>.json` | `src/network/posts.mjs` | 04 |
| Network settings | `network/settings.json` | `src/network/jobs.mjs` (job settings only so far) | 06 |
| Job, attempts | `network/jobs/<jobId>/job.json` (+ `request.json`) | `src/network/jobs.mjs` | 06 |
| Attempt artifacts | `network/jobs/<jobId>/attempts/<attemptId>/` | `src/network/worker-local.mjs` | 07 |
| Event journal | `network/events/<segment>.jsonl` | `src/network/events.mjs` | 08 |
| Pipeline draft / published version | `network/pipelines/<id>.json`, `network/pipelines/<id>/v<n>-<sha256>.json` | `src/network/pipeline-model.mjs` | 09 |
| Pipeline run | `network/pipeline-runs/<runId>/run.json` (+ `plan.json`) | `src/network/pipeline-runner.mjs` | 09 |
| Machine clients | `network/clients.json` | `src/network/machine-auth.mjs` | 11 |
| Job messages | `network/jobs/<jobId>/messages.json` | `src/network/messages.mjs` | 12 |
| Network schedules | `network/schedules.json` | `src/network/schedules.mjs` | 12 |
| A2A peers and inbound settings | `network/federation.json` | `src/network/a2a-registry.mjs` | 13 |
| Kanban cards, runs, sessions, worktrees | `state.json` (unchanged) | Board/Supervisor | existing; Network only reads them |
| Project memory (lessons) | `lessons/<project>.json` (unchanged) | `src/lessons.mjs` | existing; Network only reads approved lessons |

Rules that follow from the requirements:

- A registration stores **only** `baseResourceId`. Provider, model, effort, instructions and tools are read from Base on
  every view (`profileDefaults`, `src/base-resolver.mjs:18`) and pinned only inside an accepted job's request.
- Registering, editing, disabling or deleting a registration never writes `state.json` or Base.
- Base stays authoritative and is not changed to know about Network. Deleting a Base resource is not blocked by a
  registration; the registration then shows as **stale** and cannot start jobs (fail closed). Base's "Used by" list does
  not show Network uses in the MVP (open question 1).
- Graph edges describe allowed relations; they never grant data access or start work. Pipeline edges are a separate type.

## 4. Storage plan

### 4.1 Layout

Everything lives under `<dataDir>/network/` (`defaultDataDir`, `src/store.mjs:22`). The folder is created on the first
write, never at startup, so an install that never opens Network has no `network/` folder (like Origin Research,
`src/server.mjs:448`).

```
network/
  settings.json                      promptboard.network-settings      v1
  agents.json                        promptboard.network-agents        v1  registrations
  networks/<id>.json                 promptboard.network-draft         v1
  networks/<id>/v<n>-<sha256>.json   promptboard.network-version       v1  immutable
  pipelines/<id>.json                promptboard.pipeline-draft        v1
  pipelines/<id>/v<n>-<sha256>.json  promptboard.pipeline-version      v1  immutable
  memory/<scope>.json                promptboard.network-memory        v1  scope = agent-<id> | network-<id>
  posts/<agentId>.json               promptboard.network-posts         v1
  jobs/<jobId>/job.json              promptboard.network-job           v1  mutable metadata
  jobs/<jobId>/request.json          promptboard.network-job-request   v1  immutable accepted snapshot
  jobs/<jobId>/messages.json         promptboard.network-messages      v1  (Task 12)
  jobs/<jobId>/attempts/<attemptId>/ prompt.md, stream.jsonl, output.log, result.md, result.json, workspace/
  pipeline-runs/<runId>/run.json     promptboard.network-run           v1  mutable
  pipeline-runs/<runId>/plan.json    promptboard.network-plan          v1  immutable compiled plan
  pipeline-runs/<runId>/report.md    output node artifact
  events/<16-digit first seq>.jsonl  append-only journal segments
  clients.json                       promptboard.network-clients       v1  (Task 11)
  schedules.json                     promptboard.network-schedules     v1  (Task 12)
  federation.json                    promptboard.network-federation    v1  (Task 13)
```

**Why not `state.json`:** `Store.update` clones and rewrites the whole board file on every change
(`src/store.mjs:250-262`) and the board polls it; Network writes (job transitions, events) would inflate and slow every
Kanban write. Adding fields would also force `STATE_VERSION` 15, after which an older Promptboard refuses the whole board
(`src/store.mjs:44`). Separate files keep Kanban and older versions untouched.

### 4.2 File discipline (every Network file)

1. Every file is `{ "schema": "<id>", "version": <n>, ... }`. Writes use `writeAtomic` (temp file, fsync, `.bak` kept,
   rename, folder fsync; `src/durable.mjs:38`); folders `0700`, files `0600`.
2. Reads use `readWithBackup([file, file.bak], parse)` (`src/durable.mjs:54`). A file that fails to parse or has the
   wrong schema is set aside with `setAside` (`src/durable.mjs:67`) and its backup is used. An unreadable file (EACCES,
   EIO, EMFILE) is an error, never "no data" (`src/durable.mjs:51-53`).
3. **Newer version fails closed:** `version > supported` throws `NetworkError('…saved by a newer Promptboard version…',
   'NETWORK_VERSION_UNSUPPORTED', 409)` and the file is never rewritten (as `src/lessons.mjs:46`). Only that domain is
   refused; Kanban, Base and the rest of Network keep working.
4. **Migrations** (none in v1): the exact original bytes are first copied with `open(…, 'wx')` to
   `<file>.pre-migration-v<old>-<time>-<random>` (as `src/store.mjs:215-233`); a failed migration leaves the original.
5. **Immutable files** (published versions, `request.json`, `plan.json`) are written once with `open(path, 'wx', 0o600)`
   or `writeAtomic(..., { backup: false })` after checking the name is free. Their name carries the SHA-256 of the
   canonical body; a read whose hash does not match is refused (`NETWORK_CONTENT_INVALID`), as Base does
   (`src/base.mjs:379-389`). They are never deleted automatically.
6. **Serialization and CAS:** one `serial()` queue per domain file; every owner change carries `expectedRevision`; a
   mismatch is `409 REVISION_CONFLICT`. The revision increases by one per published change.
7. **File names** come only from validated server-generated IDs, passed through `escapeId` (`src/origin.mjs:35`).
   IDs: `<prefix>_` + 20 lowercase hex characters from `randomBytes(10)`; prefixes `agt net pip job att run mem pst
   cli sch peer evt`. Node and edge IDs inside a document: `n_`/`e_` + 12 hex characters.
8. **Size ceilings** (resource safety, not product caps; each returns a fixed error): request body 1 MiB (job submit
   256 KiB input + 32 KiB instructions); `agents.json` 5,000 registrations; a network draft 5,000 nodes / 20,000 edges /
   8 MiB; a pipeline 500 nodes before expansion, 2,000 after; memory text 4,000 characters per record and 500 approved
   records per scope; posts 16 KiB Markdown, 2,000 per agent; `result.md` 1 MiB; `output.log` 20 MiB (as
   `src/supervisor.mjs:28`); `stream.jsonl` 16 MiB (as `src/research-cli.mjs:7`); event line 4 KiB with a 300-character
   message.
9. No secret is ever written: credential values, the owner token, the paired-device cookie, machine tokens (only their
   SHA-256), provider tokens, raw stderr. Text that leaves the app (events, prompts, exports) passes through
   `redactLocal(noPaths(text))` as `src/lessons.mjs:35` does. Owner text that is stored and exported as is (registry
   names, descriptions, display names, labels; memory; reports) gets it **when it is saved and when it is imported**, not
   at export: a published version's exact bytes carry its hash, so an export must hold what was saved (Phase-1 review,
   P1-7).

### 4.3 Per-entity notes

- **Registrations** (`agents.json`): one file, one revision for the collection plus a revision per row. The file is
  small (about 1 KB per row).
- **Networks**: the draft file is the editable copy; publishing writes `v<n>-<sha>.json` and then bumps the draft's
  `publishedVersions` list in the same queue. A list view reads `networks/*.json` once and caches it in memory.
- **Jobs**: `job.json` per job is the source of truth. At load, the job module scans `jobs/*/job.json` with bounded
  concurrency (16) into an in-memory index for list/filter/idempotency.
  `ponytail: startup scan is O(jobs); add a compact index file when an install passes ~10,000 jobs.`
- **Events**: append-only JSON lines. One line per event; `seq` is a monotonically increasing integer across segments.
  A segment rolls over at 8 MiB; the newest 16 segments are kept (about 128 MiB). Events are observability, not
  authority: job and pipeline state come only from `job.json`/`run.json`. A partial last line after a crash is dropped
  on load and `seq` continues at `max + 1`.
- **Clients**: token `pbm_<clientId>_<43 base64url chars>` (32 random bytes); only `sha256(token)` and an 8-character
  display prefix are stored; comparison with `timingSafeEqual` (as `src/remote-access.mjs:22-23,197-204`). A SHA-256 of
  256 random bits is the right hash here; a slow password hash adds nothing for a random secret.

### 4.4 Backups and exports

| | Board backup `GET /api/board/export` (`src/board.mjs:2451`) | Network export `GET /api/network/export` (Task 02) | Never exported |
|---|---|---|---|
| Content | **Unchanged** (backup version 12, `src/board.mjs:65`) | `{ application: 'Promptboard', kind: 'promptboard-network', version: 1 }` with registrations, network drafts and all published versions, pipeline drafts and published versions (Task 09); with explicit options: approved memory (`includeMemory`), posts (`includePosts`); Task 12 adds schedule definitions, Task 13 peer card metadata | jobs, attempts, leases, request snapshots, results, artifacts, events, pipeline runs, messages, native session IDs, workspaces, machine clients and their hashes, peer credential references, listener settings, `lastSlot`/history fields |

Import (`POST /api/network/import`, Task 02):

- Validates the whole file first; nothing is written unless everything validates.
- Every `baseResourceId` must exist in the current Base with kind `profile` or `agentProfile`; otherwise the import is
  refused with the list of unresolved IDs (`NETWORK_IMPORT_UNRESOLVED`). Restore the board backup (which carries Base)
  first, then the Network export.
- IDs are kept when free; colliding IDs get new IDs and every reference (nodes, edges, subnetwork pins, pipeline nodes,
  memory scopes, posts) is remapped in one pass. Published version numbers and hashes are kept.
- Imported registrations come back **disabled**; imported schedules disabled; imported peers disabled and untrusted.
  Restoring metadata never runs anything.

Why the board backup stays unchanged: its import replaces the board and refuses while runs or worktrees exist
(`src/board.mjs:2478-2486`); Network data merges instead. Changing backup version 12 would also stop older apps from
reading new backups. A board restore never starts Network work because jobs are not in any backup.

### 4.5 Retention

- Published network and pipeline versions: never deleted automatically. Delete of a network or pipeline is refused while
  a non-terminal job or pipeline run references any of its versions (`NETWORK_IN_USE`). Task 05 is stricter for networks:
  a published or contained network cannot be deleted at all, only archived (§4.8).
- Jobs: metadata, `request.json` and `result.*` are kept until the owner deletes a terminal job. `stream.jsonl` and
  `output.log` of terminal jobs older than `outputRetentionDays` (default 30) are removed once per start, bounded to 500
  jobs per sweep (as `src/board.mjs:721-735`), never for a job referenced by a non-terminal pipeline run or parent job.
- Events: segment rotation only (§4.3).
- Memory and posts: never deleted automatically.

### 4.6 Registry details settled in Task 02

Refinements of §4–§5 made while building `src/network/{storage,registry,http}.mjs`. Only the first changes a rule
above; the others fill in what it left open.

1. **Body limits (changes §4.2 rule 8 for these routes).** A draft may reach 8 MiB, which a 1 MiB body cannot carry:
   agent routes and publish take 64 KiB, network create/update 8 MiB + 64 KiB, import 32 MiB (one export with every
   draft and version; split it past that). Job bodies (Task 06) keep the limits of rule 8.
2. **Registrations.** A missing Base ID or a kind other than `profile`/`agentProfile` is refused
   (`BASE_PROFILE_INVALID`). A disabled, untrusted or revoked Base agent can be registered (nothing runs) and shows as
   stale. One Base resource may back several registrations (different scopes). `baseResourceId` never changes; any
   field Network does not own (`model`, `provider`, `instructions`, …) is refused. The computed view adds
   `base.staleReason` (`missing`, `wrong-kind`, `disabled`, `untrusted`, `revoked`, `no-primary-agent`,
   `primary-agent-<reason>`) and `missingProjects`; `networks` lists drafts that contain the agent. Owner text (display
   name, network name, description, labels) is cut with `noPaths` and masked with `redactLocal` before it is saved
   (`noPaths` since the Phase-1 review, P1-7). `providerCapabilities` is
   left to Task 03. *(Phase-1 review, P1-1)* Names, display names, tags, capabilities, report source references and job
   idempotency keys are one line: a line break (`\r`, `\n`, U+0085, U+2028, U+2029) or tab inside them is refused at save
   and at import (`LINE_BREAK`, `src/network/storage.mjs`); only descriptions, memory text, reports and job input or
   instructions keep their lines.
3. **Revisions.** `POST /agents` and `POST /import` take the `agents.json` collection revision; `PATCH /agents/:id` the
   row revision (each row change also bumps the collection). `POST /networks` takes none: networks have no collection
   file, and creation cannot overwrite anything (names stay unique inside the queue). Every network update and publish
   takes the draft revision.
4. **Graph rules.** Each registration and each network appears at most once in a network; a relation joins two
   different nodes and appears once per `(from, to, relation)`; changing `nodes` re-checks every edge. A sub-network
   node always pins an existing published version.
5. **Cycles.** Pins name published versions only, so the check walks from the network being saved through the pinned
   versions (each once) and refuses when it reaches that network's ID again, whatever version (`NETWORK_CYCLE`,
   `details.path` = IDs, names in the message). Drafts of other networks are never containment. An import checks every
   draft and every version as a root, which also catches crafted cycles that do not involve a saved network.
   *(Phase-1 review, P1-2)* The walk is one depth-first search with a shared path (each version once, O(versions +
   pins)) that yields to the event loop every 1,000 versions. An import first peels off, in O(networks + pins), every
   network that cannot lie on a loop of pins (Kahn's algorithm in both directions); only graphs of networks left on a
   loop are walked, only through each other. A file the app wrote has none unless two networks pin versions of each
   other, so a 13 MiB chain of 20,000 networks validates in about 150 ms (was more than ten minutes). A crafted file
   whose networks all pin each other in loops is still walked once per root (quadratic, yielding between roots; a
   `ponytail:` note in `registry.mjs`). Exact "contains itself" by network ID needs reachability between versions of the
   same network, which has no linear algorithm in general; one shared visited set across roots would miss loops.
6. **Loading.** A stored row or draft must be exactly what the registry writes (strict node/edge check, hash-shaped
   version entries); anything else is damaged. `agents.json` with no usable copy refuses the agent routes
   (`NETWORK_DATA_DAMAGED`). A draft with no usable copy, or a newer version, is listed under `unavailable` and refused
   on its own; the other networks keep working. Export refuses while any draft is unavailable, rather than writing an
   incomplete file.
7. **Publish order.** The version file is written before the draft names it; a crash between leaves an unreferenced
   version file (harmless, never deleted), and the next publish takes the same number with a new hash.
8. **Import.** Validation is all-or-nothing and happens before any write (since the Phase-1 review, P1-8, that includes
   the 8 MiB size of every remapped draft, which `#saveDraft` used to check only after the registrations and version
   files were written). Writes go registrations (disabled), then
   version files, then drafts, so a saved draft never names a missing agent or file; a crash in between can leave
   disabled registrations or unreferenced version files, never a run. A version whose network and references keep
   their IDs keeps its bytes and hash; a remapped one is re-hashed. Project IDs that are not on this board are dropped
   from `projectAllowlist` with a warning. A network name already in use gets ` (2)`, ` (3)`…. Importing the same file
   twice adds copies. *(Phase-1 review)* An ID also counts as taken while a set-aside draft (a deleted network) or a
   memory file still names it, so an old export never brings back a deleted network's notes under its ID; `exportedAt`
   must be a string of at most 64 characters (it used to accept any JSON value).

### 4.7 Memory and posts settled in Task 04

Refinements made while building `src/network/{memory,posts}.mjs`; none changes a binding rule.

1. **Files and ceilings.** One file per scope, `memory/agent-<escapeId(agt_…)>.json` or `memory/network-<…>.json`, and one
   per agent, `posts/<escapeId(agt_…)>.json`, each with a scope revision and per-record revisions. Ceilings (fixed errors,
   `NETWORK_LIMIT`): memory text 4,000 characters (413), 500 approved and 1,000 records per scope (409), 20 history entries
   per record (the oldest leave), 8 MiB per memory file (413); a report 16 KiB of Markdown in bytes (413), 2,000 per agent
   (409), 10 source references of 300 characters. Route bodies are 64 KiB.
2. **Owner text** of memory and reports goes through `cleanText` (`src/network/storage.mjs`): CRLF to LF, control
   characters dropped, local folders cut to their last name (`noPaths`) and secret-looking values masked (`redactLocal`)
   before it is saved, as Project Memory does. HTML is kept as plain text and never rendered as HTML.
3. **States.** `proposed → approved | rejected`; an approved record can be withdrawn (`rejected`) and a rejected one
   approved again; an edit keeps the status and records the earlier kind and text in the record's history; delete removes
   the record and its history (the previous file stays only as its `.bak`). Every change of a record takes that record's
   revision, so an approval names exactly the text the owner saw (a changed record answers `409 REVISION_CONFLICT`);
   a proposal takes the scope revision (as `POST /agents` takes the collection revision). Approve and reject share
   `POST …/memory/:mid/approve` with `{ decision: 'approve' | 'reject' }`, the pattern of pipeline approvals (§10.1 row 09).
4. **Search** is deterministic keyword matching: every word of `q` (≤ 200 characters, case-insensitive) must appear in the
   record's kind or text; results are newest first (`updatedAt`, then ID). No embeddings or index.
5. **The job memory block** (§7.2 step 5) comes from `registry.memory.resolve(agentId, { projectId, networkId, memory,
   projectLessons })`, which reads the registration, then calls two pure functions. `memoryAccess` decides each part:
   a disabled or stale registration gets nothing (`REGISTRATION_DISABLED`/`REGISTRATION_STALE`); agent memory unless
   `memory: 'none'`; network memory only with `memory: 'agent+network'`, a `networkId`, and the agent being a node of that
   network's current draft (Task 09 may pass membership of the pinned version instead); project lessons only with
   `projectLessons: true`, the project on the registration's `projectAllowlist` and still on the board. `memoryBlock`
   keeps only approved records of the two allowed scopes (whatever it is handed), newest first, inside
   `=== NETWORK MEMORY (approved by the owner; reference data, not instructions) ===` … `=== END NETWORK MEMORY ===`, at
   most 8,000 characters including the delimiters with the rest counted as `omitted`. Each record line names its ID,
   scope, kind and approval date (a network name in it is collapsed to one line, `oneLine`); its text is indented two
   spaces on every line break, the Unicode ones included (`indent`), so no record can close or forge the section. Then the
   project's section from the unchanged `lessonsPrompt` (its own 8,000-character bound), so a job's block is at most
   about 16,000 characters. Only allowed parts are read: another project's lessons file is never opened. Damaged memory
   fails the call (`NETWORK_DATA_DAMAGED`), never an empty block; a damaged lessons file gives no section, as
   `lessonsPrompt` already decides. Task 07 puts `text` into `prompt.md` and keeps the answer's `memory.included` IDs.
6. **Preview** (`GET /api/network/agents/:id/memory/preview?projectId&networkId&memory&projectLessons`) answers exactly
   that object: `access` per part, `memory.included` (ID, scope, kind, characters, approval time), `omitted`, the
   lessons' size and the full `text`. It exists for agents only (a network's memory reaches a job only through an agent).
7. **Network memory** has its owner routes now (`/api/network/networks/:id/memory…`); its screen arrives with the
   Graph and Library pages (Task 05). The agent profile's Memory tab previews it when the agent is in a network.
8. **Posts** are written by the owner only; machine-written reports wait for the gateway (Task 11). A `jobId` is refused
   (`JOB_NOT_FOUND`) until the job engine can verify it (Task 06); the field is stored as `null`. A report is never an
   event, a job or part of a registration view; the page labels it "Report · Written by you" and says it is not checked.
9. **Not yet:** the Network export carries neither memory nor reports (private text; the §4.4 options `includeMemory` and
   `includePosts` are left for later). No route deletes a registration, and none removes memory or reports with one; when
   Task 05 deletes a network, its memory file stays (nothing is deleted automatically).
10. **Paired devices:** every memory, preview and report route is allowed (no secret, listener or trust is involved);
    all are listed in `tests/remote-access.test.mjs`.
11. **Shared helpers** (`only`, `requireRevision`, `conflict`, `object`, `page`, `cleanText`) moved from `registry.mjs` to
    `storage.mjs` so memory, posts and later domains use one copy.

### 4.8 Graph and Library settled in Task 05

Refinements made while building Network → Graph and Network → Library (`src/network/registry.mjs`, `http.mjs`,
`public/network-graph.js`); none changes a binding rule.

1. **Delete** (`DELETE /api/network/networks/:id`, `{ expectedRevision }`) removes only a network that was never published
   and that no other network's draft or published version contains. Otherwise it is refused with the reason:
   `NETWORK_IN_USE` (409, `details.usedBy` = `[{ networkId, name, archived, draft: pinnedVersion|null, versions:
   [{ version, pins }] }]`; a use by a published version lasts for good, so the message says it can only be archived) or
   `NETWORK_PUBLISHED` (409; a later run may pin any published version). While any saved draft cannot be read the delete
   fails closed (`NETWORK_DATA_DAMAGED`): that draft might use it. A deleted draft and its backup are set aside as
   `<file>.deleted-<time>-<random>` (backup first, so the draft cannot come back from it): never read again, recoverable by
   hand. Its memory file stays (§4.7 item 9). Version files are never deleted.
2. **Archive** is the answer for everything delete refuses: `PATCH …/networks/:id { expectedRevision, archived: true|false }`
   stores `archived: true` on the draft (absent when not archived, so older drafts and exports stay valid). An archived
   network leaves `GET /networks` unless `?archived=true`, is not offered as a new sub-network, and keeps every version
   readable; every existing pin keeps working and shows an issue (`SUBNETWORK_ARCHIVED`). Export and import carry the flag.
3. **Duplicate** (`POST …/networks/:id/duplicate`, `{ name? }`) writes a new unpublished draft with the same nodes, relations
   and pins (IDs and version numbers only; nothing copied by value); the name defaults to `<name> (copy)`, then ` (2)`….
   Rename is the existing `PATCH { name, description }`; published versions keep the name they were published with.
4. **Detail answers.** `GET /networks/:id` and every create, update, publish and duplicate answer
   `{ network, refs, issues, usedBy, usedByUnknown }`; `GET …/versions/:n` answers `{ version, refs }`. `refs` is computed
   on read and never stored (it is not part of a version's hashed bytes): per agent `{ name, kind, provider, enabled,
   stale, staleReason }` (or `{ missing: true }`), per sub-network `{ name, archived, versions, pinned: { nodes, edges } |
   null }` (null when the pinned version cannot be read). `issues` (warnings; saving never depends on them):
   `AGENT_MISSING`, `AGENT_DISABLED`, `AGENT_STALE`, `SUBNETWORK_UNAVAILABLE`, `SUBNETWORK_ARCHIVED`, `SUBNETWORK_OUTDATED`
   (with `latest`), each with `nodeId` and a message that says what to do. `usedBy` reads every published version once
   and caches it (`ponytail:` reverse index if installs reach thousands of versions); a draft or version that cannot be read
   is listed in `usedByUnknown` instead of failing the answer. `registry.network(id)` stays the light read memory uses.
5. **Errors that point at a fix.** `NETWORK_CYCLE` now says which sub-network to remove ("Remove the sub-network “B” from
   this network, or pin a version of it that does not contain this network"); a self-pin is a cycle, not a missing
   reference. The editor marks the node that closes the loop (`details.path[1]`) and the nodes of a
   `NETWORK_REFERENCE_INVALID`, and offers to remove them; the draft on disk is unchanged and the edits are kept.
   *(Phase-1 review, P1-6)* A draft update checks only the references it adds (a new agent, a new or changed pin):
   pinned versions never change, so kept pins cannot form a new cycle, and an unreadable version deep inside one no
   longer blocks a rename, a description or an archive. Create, duplicate and publish check every reference. A version
   that cannot be read on the way fails with its own code plus `details: { networkId, version, path }` (`path[1]` is the
   network's own node) and a message naming that sub-network; the editor marks and offers to remove that node, after a
   refused save or a refused publish.
6. **`collapsed`** stays accepted and round-trips unchanged, but the Graph does not write it: expansion is view state
   (default collapsed, lazy), because expanding must not change the draft or a version's hash.

### 4.9 Jobs settled in Task 06

Refinements made while building `src/network/jobs.mjs` (engine, store and settings in one module), its routes and the
server wiring. Items 1, 4 and 6 fill in or narrow §5–§7; none changes a binding rule.

1. **Files.** `network/jobs/<escapeId(job_…)>/request.json` is written first (once, no backup; `job.json.requestSha256`
   is checked on every read, a mismatch is `REQUEST_INVALID`), then `job.json` (+ `.bak`); a failed submit removes the
   half-made folder. Results go to `attempts/<escapeId(att_…)>/result.md` (≤ 1 MiB) and `result.json` (≤ 64 KiB), written
   before the status says `completed`; `late-result.md` holds a result that arrived after the engine ended the attempt.
   `network/settings.json` (`promptboard.network-settings` v1: `{ revision, maxConcurrentJobs: 2 (1–4), defaultTimeoutMs:
   20 min (1–120 min), outputRetentionDays: 30 (1–3650) }`) appears on the first settings change. Every write goes through
   `writeDocument`/`writeImmutable`; memory changes only after a write succeeded, so memory always equals disk.
2. **Index.** One scan of `jobs/*/job.json` at the first access (16 at a time) builds the in-memory index (jobs,
   idempotency keys, the FIFO stamp). A `job.json` that is damaged with no usable backup, or newer, is listed under
   `unavailable` and refused on its own (`NETWORK_DATA_DAMAGED`, `NETWORK_VERSION_UNSUPPORTED`, never rewritten).
3. **Submission.** Strict fields (§5 `JobRequest` as input: `agentId, input { text, json? }, instructions, tools,
   permissions { filesystem, memory, projectLessons }, limits { timeoutMs }, requireApproval, projectId, networkId,
   parentJobId, idempotencyKey`). Text, instructions and JSON string values pass through `cleanText` (secrets masked,
   local folders cut) before they are hashed or saved. Defaults: `tools: 'none'`, `permissions: { filesystem: 'read_only',
   memory: 'agent', projectLessons: false }`, the settings' timeout, no approval. Refused at submit (nothing written):
   unknown or malformed fields (400), oversized parts (413 `NETWORK_LIMIT`), `filesystem` other than `read_only`
   (`EXECUTION_POLICY_UNSUPPORTED`), an unregistered agent (`AGENT_NOT_FOUND` 409), a switched-off or stale registration
   (`REGISTRATION_DISABLED`, `REGISTRATION_STALE` with `staleReason`), a provider without Network job tools or without the
   requested tool mode (`PROVIDER_UNSUPPORTED`, `TOOLS_UNSUPPORTED`, from the §8 matrix), a project not on the board
   (`PROJECT_NOT_FOUND`), lessons of a project not on the registration's list (`PROJECT_NOT_ALLOWED`), an unknown network
   or parent job. A job never needs a project, card, branch or repository.
4. **The pinned agent** (`request.json` `agent`): `registrationId, registrationRevision, baseResourceId, baseKind,
   baseRevisionRef` (Base's immutable `{ id, revision, hash }`), `primaryAgent: { resourceId, revisionRef } | null` (an agent
   profile), `provider, model, effort`, and `manifest: null`. The `resolveBase` manifest needs R2 and is built by Task 07
   from exactly these revision references; Task 07 decides whether a queued job accepted before it fails at claim or gets its
   manifest from the pinned references. Memory and lessons are pinned as the request's `permissions` (`memory`,
   `projectLessons`), `projectId` and `networkId`, which Task 07 passes to `registry.memory.resolve`.
5. **Idempotency.** The key (≤ 200 printable characters) is scoped by requester (`owner`, `machine:<clientId>`, …); the
   same key and the same cleaned submission answer the existing job (`deduplicated: true`, HTTP 200); a different
   submission is `409 IDEMPOTENCY_CONFLICT` with `details.jobId`; deleting a job frees its key. Without a key every submit is
   a new job. Submit answers `202 { jobId, status, deduplicated: false, job }`.
6. **Attempt states (narrows §6.2).** `claimed` (saved at claim with the attempt ID, `workerInstance`, provider tuple and
   `sideEffects`: `read_only_web` when `tools: 'web'`, else `none`) → `launching` (`launchingAt`) → `running` (`spawnedAt`,
   `pid`) → `completed | failed | cancelled | unknown | interrupted`. §6.2's separate `preparing` attempt state is not
   stored: the job's `preparing` status covers claim to launch. A `waiting_for_input` job's attempt ends `completed`.
7. **Worker interface.** `worker.claim(job, ownership)` (may throw to refuse: the job fails with the error's code, nothing
   ran), `worker.start(job, ownership)`, `worker.cancel(ownership)`, `worker.getStatus(ownership) → { process }`
   (synchronous; shown as the job view's `live.process`). `job` is the view plus `request`; `ownership` = `{ jobId,
   attemptId, lease, signal, launching(), spawned({ pid }), finish(report) }`. The lease (32 random bytes) lives in memory
   only; a report is applied only while that lease owns the job's current, open attempt. `launching` and `spawned` throw
   `JOB_OWNERSHIP_LOST` otherwise (the worker must not start or keep a process); a `spawned` that cannot be saved also
   makes the engine call `worker.cancel`. `finish({ status: completed | failed | unknown | waiting_for_input, errorCode?,
   reason?, exitCode?, result?: { text, json? }, sideEffects?, coverage? })`: `completed` needs a running attempt and
   non-empty text, otherwise it becomes `unknown` (launched) or `failed` (not launched); `unknown` before launch is `failed`;
   an oversized result is `failed OUTPUT_LIMIT`. A worker that returns without a report leaves `unknown` (`NO_RESULT`)
   after launch and `failed` (`WORKER_ENDED` or its own code) before. Without a worker (`startServer({ networkWorker })`
   defaults to null until Task 07) jobs stay queued; their view says `waiting: { for: 'worker', message }`.
8. **Pool.** Starts with `start()` (the server calls it after listening). FIFO by `queuedAt`, a stamp that strictly
   increases (also across restarts). `activeCount()` = attempts being claimed or owned (a process may be alive); queued jobs
   never count. While a sign-in change holds the CLI slot nothing is claimed (`waiting.for: 'sign-in'`), and the change's end
   wakes the pool. **R3:** `claim('auth')` answers `409 RUNS_ACTIVE` while `activeCount() > 0`. A claim whose write fails
   leaves the job queued and the pool tries again after 5 s.
9. **Limits enforced by the engine** (whatever the worker does): preparation 45 s from claim to `launching`
   (`PREPARE_TIMEOUT`), the request's `timeoutMs` from `launching` (`TIMEOUT`); both stop the worker and save `failed`.
10. **Stop (cancel, time limits, shutdown).** The worker's signal is aborted and `worker.cancel` awaited for at most 3 s;
    then the status is saved unless the worker's own report was saved first ("the one saved first wins"). Cancel takes no
    revision (it is idempotent and a running job's revision moves) and answers `{ job, cancelled }`; a job already ended is
    `409 JOB_FINISHED`; an interrupted or unknown job needs retry or close (`JOB_STATE`). A result reported after the engine
    ended the attempt is kept as `late-result.md` and `attempt.lateResult = { chars, sha256, at }`; the status never changes.
    The lease is released when the worker returns, or 3 s after the stop for a worker that never does.
11. **Restart.** `preparing`/`running` become `interrupted` (`APP_RESTARTED`; `not_started` without `launchingAt`, else
    `uncertain`, with "process <pid> may still be running"). A `job.json` that loaded from its `.bak` while it was `queued`,
    `waiting_*`, `preparing` or `running` becomes `interrupted` / `uncertain` (`RESTORED_FROM_BACKUP`): the older copy cannot
    tell whether it ran since. Queued jobs stay queued and are claimed fresh when a worker exists (a queued job has no attempt
    in flight, so a new claim is safe ownership); approvals stay pending. Neither the board backup nor the Network export
    carries jobs, so restoring either never runs one.
12. **Owner decisions.** `retry` (`{ expectedRevision, confirm: true, confirmUncertain? }`) needs `confirmUncertain` when the
    outcome is uncertain or the last attempt's `sideEffects` is not `none`; it queues the job again (`currentAttemptId: null`,
    a new attempt at the next claim). `close` saves `failed` with `CLOSED_BY_OWNER` and keeps the outcome. `approve`
    (`{ expectedRevision, decision: 'approve' | 'reject' }`). `DELETE` (`{ expectedRevision }`) only for a finished job
    whose lease is gone and that no open job names as parent (`JOB_IN_USE`); the folder is renamed, then removed.
13. **History.** `job.history` = `[{ at, status, by: owner | app | worker | <requester kind> }]`, newest 200 kept. `children`
    is computed on read (`GET /jobs/:id`), not stored.
14. **Retention** (§4.5), once per start: terminal jobs with attempts whose `updatedAt` is older than
    `outputRetentionDays` lose `attempts/*/stream.jsonl` and `output.log` (500 jobs per start, oldest first), never while
    their parent job is open; `outputsRemovedAt` is then saved so a job is swept once. Requests, results and metadata stay
    until the owner deletes the job. Task 09 adds the pipeline-run reference to this guard.
15. **Paired devices:** every job and settings route is allowed (no secret, listener or trust is involved; a phone has the
    owner's control); `localOnly()` is unchanged; all rows are in `tests/remote-access.test.mjs`.
16. **Not yet:** no UI (the Activity page and the agent's Tasks tab arrive with Tasks 07–08, once a worker can run what is
    submitted); reports still refuse `jobId` (§4.7 item 8); no result route (Task 07).

## 5. Data shapes

Field names are binding; tasks may add optional fields.

```js
// network/agents.json → rows[]
AgentRegistration = { id: 'agt_…', baseResourceId, displayName: string|null /* ≤80 */, tags: string[] /* ≤20×40 */,
  capabilities: string[] /* owner-declared capability tags, ≤20×40; not provider capabilities */,
  enabled: boolean, visibility: 'private', projectAllowlist: string[] /* board project IDs; [] = no project data */,
  createdAt, updatedAt, revision }
// Computed on read, never stored: base: { kind, name, enabled, trust, revision, provider, model, effort, stale: boolean,
//   staleReason, instructions: { summary /* ≤280, redacted */, chars }, usedBy /* count of Base's own non-historical "Used by" */ },
// networks: [ids containing it], missingProjects, providerCapabilities: { provider, known, jobTools: string[] | null,
//   toolEvents, waitingEvents, readOnly, webSearch, sessionId, usage, dockerSandbox, liveVerified /* 'yes'|'partial'|'no'|'unknown' */ }
// (the §8 matrix; Task 03, see §12.1).

// network/networks/<id>.json
NetworkDraft = { schema, version: 1, id: 'net_…', name /* ≤80, unique case-insensitive */, description /* ≤2000 */,
  revision, createdAt, updatedAt,
  nodes: [ { id: 'n_…', type: 'agent', agentId, position: { x, y }, collapsed?: true }
         | { id: 'n_…', type: 'subnetwork', networkId, version: number /* pinned published version */, position, collapsed? } ],
  edges: [ { id: 'e_…', from: nodeId, to: nodeId, relation: 'message' | 'delegate' | 'share_result' } ],
  publishedVersions: [ { version, sha256, publishedAt } ], archived?: true /* Task 05: only while archived */ }
NetworkVersion = { schema, version: 1, networkId, number, sha256, publishedAt, name, description, nodes, edges }

// network/pipelines/<id>.json
PipelineDraft = { schema, version: 1, id: 'pip_…', networkId, name, revision, createdAt, updatedAt,
  settings: { maxParallel /* ≤ global ceiling */, deadlineMs /* default 2 h */, failurePolicy: 'stop' | 'continue_independent' },
  nodes: [ { id, type: 'agent' | 'subnetwork' | 'condition' | 'parallel' | 'join' | 'approval' | 'output', position, config } ],
  edges: [ { id, from, to, fromPort: 'text' | 'json' | 'true' | 'false' | 'done', toPort: 'input' } ],
  publishedVersions: [ { version, sha256, publishedAt, networkVersion } ] }
// node configs (strict, unknown keys refused):
//  agent:      { agentId, instructions /* ≤32 KiB */, tools: 'none' | 'web', timeoutMs, retries /* 0–2 */ }
//  subnetwork: { pipelineId, version }            // a published pipeline of the child network, expanded at compile time
//  condition:  { all | any: [ { path: '<nodeId>.json.<field>[.<field>]', op: 'eq'|'ne'|'lt'|'lte'|'gt'|'gte'|'in'|'exists'|'contains', value } ] }  // ≤ 20 rules, depth 1
//  parallel:   {}                                 // fan-out marker
//  join:       { require: 'all' | 'any' }
//  approval:   { prompt /* ≤2000, shown to the owner */ }
//  output:     { name /* file name stem */, include: [nodeId] /* ordered */ }
PipelineVersion = { schema, version: 1, pipelineId, number, sha256, publishedAt, networkId, networkVersion, settings, nodes, edges }

// network/jobs/<id>/job.json
Job = { schema, version: 1, id: 'job_…', revision, status /* §6.1 */,
  source: 'owner' | 'machine' | 'pipeline' | 'delegation' | 'schedule' | 'a2a',
  requester: { kind: 'owner' | 'machine' | 'pipeline' | 'job' | 'schedule' | 'a2a', id: string|null },
  agentId, projectId: string|null, networkId: string|null, pipelineRunId: string|null, nodeId: string|null,
  parentJobId: string|null, idempotencyKey: string|null /* ≤200 printable */, submissionSha256 /* Task 06: idempotency */, requestSha256,
  createdAt, updatedAt, acceptedAt, queuedAt: number|null /* Task 06: FIFO stamp */, attempts: [Attempt], currentAttemptId: string|null,
  outcome: null | 'completed' | 'failed' | 'cancelled' | 'uncertain' | 'not_started', errorCode: string|null, reason: string /* ≤500 */,
  result: null | { textRef: 'attempts/<escaped id>/result.md', jsonRef?: 'attempts/<escaped id>/result.json', chars, sha256 },
  history: [ { at, status, by } ] /* ≤200, Task 06 */, outputsRemovedAt: number|null /* Task 06 */ }
// Computed on read, never stored (Task 06): live: { process } | null, waiting: { for: 'worker' | 'sign-in' | 'slot' |
//   'approval' | 'decision', position?, message } | null; GET /jobs/:id adds children: [jobId] (§4.9 item 13).
Attempt = { id: 'att_…', number, status /* §4.9 item 6 */, workerInstance /* process UUID */, claimedAt, launchingAt: number|null,
  spawnedAt: number|null, endedAt: number|null, pid: number|null, provider, model, effort,
  nativeSessionId: string|null, exitCode: number|null, errorCode: string|null,
  coverage: null /* until the worker reports */ | 'tools' | 'partial-tools' | 'final-only', sideEffects: 'none' | 'read_only_web' | 'external_unknown',
  usage: { reported: false } | { reported: true, inputTokens?, outputTokens?, cachedTokens?, costUSD? }, lateResult: null | { chars, sha256, at } }
// The lease token is held in memory only and never written, exported or returned.

// network/jobs/<id>/request.json (immutable, the accepted snapshot)
JobRequest = { schema, version: 1, jobId, acceptedAt, input: { text /* ≤256 KiB */, json?: object /* ≤64 KiB */ },
  instructions /* ≤32 KiB */, tools: 'none' | 'web',
  permissions: { filesystem: 'read_only', memory: 'none' | 'agent' | 'agent+network', projectLessons: boolean },
  limits: { timeoutMs /* default 20 min, max 120 min */, maxOutputBytes },
  requireApproval: boolean,
  projectId, networkId, parentJobId /* Task 06 */,
  agent: { registrationId, registrationRevision, baseResourceId, baseKind, baseRevisionRef, primaryAgent /* Task 06 */, provider, model, effort,
           manifest /* resolveBase() result with revisionRefs, §7.2 step 2; null until Task 07 (§4.9 item 4) */ } }

NetworkEvent = { seq, id: 'evt_…', at, type /* e.g. job.queued, job.status, job.activity, run.node, registry.changed */,
  source: 'job' | 'worker' | 'pipeline' | 'registry' | 'memory' | 'owner' | 'machine' | 'a2a',
  agentId?, jobId?, attemptId?, pipelineRunId?, nodeId?, networkId?, status?, coverage?,
  message? /* ≤300, redacted */, artifactRef? }

MemoryRecord = { id: 'mem_…', scope: { kind: 'agent', agentId } | { kind: 'network', networkId },
  kind: 'fact' | 'lesson' | 'preference' | 'procedure', text /* ≤4000, cleaned */,
  source: { kind: 'owner' } /* | { kind: 'job', jobId, attemptId } from Task 07 */, status: 'proposed' | 'approved' | 'rejected',
  revision, createdAt, updatedAt, decidedAt: number|null, editedAt: number|null,
  history: [ { at, action: 'proposed' | 'edited' | 'approved' | 'rejected', revision, previous?: { kind, text } /* edits */ } ] /* ≤20 */ }
// network/memory/<agent|network>-<escaped id>.json = { schema, version: 1, scope, revision, records: [MemoryRecord] }

Post = { id: 'pst_…', agentId, markdown /* ≤16 KiB, cleaned */, references: string[] /* ≤10×300, shown as text */,
  jobId: null /* refused until Task 06 can verify it */, source: { kind: 'owner' } /* | { kind: 'machine', clientId } Task 11 */,
  createdAt, editedAt: number|null, revision }        // shown as "Report", never as a verified event
// network/posts/<escaped agentId>.json = { schema, version: 1, agentId, revision, posts: [Post] }

MachineClient = { id: 'cli_…', kind: 'api' | 'a2a', name, tokenSha256, tokenPrefix, createdAt, lastUsedAt, expiresAt: number|null,
  revokedAt: number|null, revision,
  scopes: { agents: [agentId], networks: [networkId], projects: [projectId],
            permissions: ['read_agents' | 'submit_jobs' | 'read_job_result' | 'cancel_own_jobs' | 'read_scoped_memory'] } }
// No wildcards in the MVP: every allowed agent is listed.
```

Task 12 and 13 shapes (`Message`, `Schedule`, `Peer`) are specified in §11.4–11.5.

## 6. State machines

### 6.1 Job

| From | To | By | Guard / effect |
|---|---|---|---|
| (new) | `queued` | submit | Validated request; `request.json` and `job.json` written before the `jobId` is returned. With `requireApproval` the job starts as `waiting_for_approval`. |
| `waiting_for_approval` | `queued` / `cancelled` | owner approve / reject | `expectedRevision`. No machine principal or model output can approve. |
| `queued` | `preparing` | scheduler claim | Pool slot free, sign-in not changing; attempt with new `workerInstance` written **before** any effect. |
| `queued` | `failed` | claim-time check | Registration disabled/stale, Base revoked (`checkBaseRevocations`), CLI missing, project gone. No process started. |
| `queued`, `preparing`, `running`, `waiting_*` | `cancelled` | owner or own machine client | Process group stopped (§7.4). |
| `preparing` | `running` | worker | `launchingAt` saved, then spawn, then `spawnedAt`/`pid` saved. If that last save fails the process is killed (as `src/supervisor.mjs:186-196`). |
| `preparing` | `failed` | worker | Failure before spawn (Base preparation, timeout 45 s as `src/supervisor.mjs:216`). |
| `running` | `completed` | worker | **Trusted terminal receipt only:** exit code 0 **and** a structured final result (Claude `result` event without `is_error`; Codex completed `agent_message` item; Gemini JSON `response`) **and** non-empty text. |
| `running` | `failed` | worker | Structured provider failure (`classifyProviderFailure`), non-zero exit, `TIMEOUT`, `OUTPUT_LIMIT`. |
| `running` | `unknown` | worker | Exit 0 without a valid structured result, or a result that cannot be stored. |
| `running` | `waiting_for_input` | worker (Task 12) | A structured `needs_input` request in the final result. |
| any non-terminal | `interrupted` | load after restart / shutdown | `launchingAt` unset → `outcome: 'not_started'`; set → `outcome: 'uncertain'`. Never relaunched. |
| `interrupted`, `unknown` | `queued` (new attempt) | owner `retry` | Body `{ confirm: true }`; when the last attempt's `sideEffects !== 'none'` or outcome is uncertain also `{ confirmUncertain: true }`. |
| `interrupted`, `unknown` | `failed` | owner `close` | Records the decision. |
| `waiting_for_input` | `queued` / `cancelled` | owner answer / cancel | New attempt with the answer appended (Task 12). |

Terminal: `completed`, `failed`, `cancelled`. A completion that arrives after `cancelled` was saved does not change the
job; its text is kept as `attempts/<id>/late-result.md` and flagged. "Submitted" is never shown as "completed".

### 6.2 Attempt

`claimed → preparing → launching → running → (completed | failed | cancelled | unknown | interrupted)`. Exactly one
attempt per job is non-terminal. Every worker write names `(jobId, attemptId)` and is applied only while that attempt is
the job's `currentAttemptId` and non-terminal; a write from a lost lease is ignored.

### 6.3 Pipeline run and nodes

Run: `running → (waiting_for_approval ⇄ running) → completed | failed | cancelled | blocked | interrupted`.
Node: `pending → ready → running → completed | failed | skipped | blocked | cancelled`, plus `waiting_for_approval` for
approval nodes. A node becomes `ready` only when every required upstream node is `completed` (or `skipped` for
condition branches) **as read from `job.json`**. A job ending `unknown` or `interrupted` makes its node `blocked`; all
descendants stay `pending` and the run becomes `blocked` until the owner retries or fails the job. On restart a run in
`running` is reconciled from its jobs; approvals stay pending; nothing is approved, retried or resubmitted.

### 6.4 Registration, memory, clients

- Registration: `enabled ⇄ disabled`; `stale` is computed (Base resource missing, wrong kind, disabled or untrusted).
- Memory: `proposed → approved | rejected`; `approved → approved` (edit, new revision); delete is explicit.
- Machine client: `active → revoked` (final); rotation = revoke + new client with the same scopes, in one write.

## 7. Execution: how Network jobs run

### 7.1 The Kanban path (traced; not reused)

1. `Board.requestRun(taskId)` serializes per card (`src/board.mjs:2755-2757`) and calls `#startRun` (`:2869`), which
   requires a card in a runnable column, consent, a linked repository (`:2889`), a target branch, then
   `executor.validate` (`:2905`), Base preflight via `resolveBase` (`:2906`), and a Git worktree (`:2908`).
2. The run record is created in `state.runs` and attached to a logical session in one Store write (`:2924-2950`), then
   `executor.start(payload)` (`:2953`).
3. `Supervisor.start` queues it (`src/supervisor.mjs:116`); `#pump` respects `settings.maxConcurrentRuns`
   (`:113`, `src/board.mjs:3838` allows 1–4) and `authBusy` (`:126`); `#launch` gives preparation 45 s (`:211-221`).
4. `#launchSession` (`:223-316`) reads `board.run`, runs `prepareBase`, writes `prompt.md`, calls
   `agents.buildSession` (`:255`), spawns a node-pty terminal in the worktree with `cliEnv` (`:271-273`), and reports
   status through `board.updateRun`/`board.recordBaseManifest`; a failed start calls `board.runFailedToStart`, which
   moves the card back (`:208`).
5. Lifecycle comes from hook files (`agent-hook.mjs`) read every 250 ms (`:299`) and interpreted by
   `interpretEvent`; usage from transcripts/rollouts every 3 s (`:300`).

The Supervisor is bound to Board records at every step (`board.run`, `board.updateRun`, `state.runs`, task worktrees,
card moves). Using it for a job would require a fake card, a fake run in `state.runs` and a worktree: that is the
"spoofed Kanban card" the requirements forbid.

### 7.2 Decision: headless, structured, read-only workers

Network jobs run through the existing **headless** adapters, which already give a structured final result, a process
exit code, tracked process groups and cancellation:

| Provider | Runner (existing) | Network tools | Coverage |
|---|---|---|---|
| Claude Code | `streamResearch` (`src/research-cli.mjs:80`) with `researchArgs` (`:17-27`): `--print --output-format stream-json --verbose --include-partial-messages --strict-mcp-config --mcp-config '{"mcpServers":{}}' --disable-slash-commands --tools <none or WebSearch,WebFetch> --max-turns 1 or 30` | `none` or `web` | `tools` (tool_use blocks in the stream) |
| Codex CLI | `streamResearch` with `exec --json --skip-git-repo-check sandbox_mode="read-only" approval_policy="never" web_search=disabled|live features.apps/plugins/hooks=false --disable shell_tool --disable unified_exec` plus `codexMcpOverride` (ambient MCP off, `src/providers.mjs:425-433`) | `none` or `web` | `partial-tools` (web search and MCP items only) |
| Gemini CLI | `runProvider` (`src/providers.mjs:444`): `--output-format json --approval-mode default --extensions none --allowed-mcp-server-names '' --allowed-tools ''` plus a wildcard deny policy | `none` only | `final-only` |
| Antigravity | — | refused (`PROVIDER_UNSUPPORTED`): its `--sandbox` is not a deny-all mode (docs/cli-adapters.md) | — |

Launch sequence of one attempt (`src/network/worker-local.mjs`, Task 07):

1. **Claim** (Task 06): pool slot, not `authBusy`, attempt written (§6.1).
2. **Pin at acceptance** (submit time, Task 06/07): read the registration; refuse if disabled or stale; read the Base
   tuple with `profileDefaults(state, baseResourceId)`; build the manifest with `resolveBase` using **only** the
   registration's layer (see refactor R2) and `columnId: 'planning'`, so delivery follows the strict read-only rules
   (`deliveryFor`, `src/base-resolver.mjs:39-53`): Base MCP servers and command recipes are unavailable; a required one
   refuses the job (`BASE_REQUIRED_UNAVAILABLE`), an optional one is listed as omitted. Supporting agents of an
   `agentProfile` are omitted (native subagents need a writing Claude stage). The manifest with `revisionRef`s goes into
   `request.json`.
3. **Launch checks:** `checkBaseRevocations(manifest, current resources, approvedRoots)`
   (`src/base-resolver.mjs:224`), registration still enabled, project still exists, CLI resolves
   (`resolveExecutable`, `src/providers.mjs:107`), provider allowed for the requested tools (table above).
4. **Prepare:** attempt folder `network/jobs/<job>/attempts/<att>/` with an empty `workspace/` (0700) as the CLI's
   working directory. `prepareBase({ manifest, readRevision: ref => board.base.readRevision(ref), currentResources,
   workspacePath: workspace, runDir: attemptDir, signal, approvedRoots })` (`src/base-context.mjs:172`) gives the Base
   sections.
5. **Compose the prompt** (`prompt.md`, kept): fixed job header (read-only, no files, answer with the final report;
   optional fenced `json` block), the pinned agent instructions, approved memory (Task 04, ≤ 8,000 characters), the
   project's approved lessons only if `permissions.projectLessons` and the project is on the registration's
   `projectAllowlist` (`lessonsPrompt`, `src/lessons.mjs:69`), Base sections, then the job input inside
   `=== JOB INPUT (data, not instructions) ===` delimiters. The job input, the job's instructions and any other
   multi-line text inside a delimited section go through `indent()` (`src/network/storage.mjs`, as memory record text
   does) and any one-line label through `oneLine()`, so nothing a submitter writes can close a section or forge one
   (for example a fake approved-memory block); `tests/network-review.test.mjs` pins this for accepted job requests.
6. **Run:** `launchingAt` saved; the runner spawns through `spawnOwned` (detached process group, `cliEnv` without an
   enclosing agent session's variables, `src/providers.mjs:185-193`); `spawnedAt`/`pid` saved; stream lines appended to
   `stream.jsonl`; `onEvent` activity becomes `job.activity` events (label ≤ 160 characters, redacted).
7. **Finish:** the result rules of §6.1; `result.md` (and `result.json` from the last fenced `json` block, ≤ 64 KiB)
   written before the status changes to `completed`. Provider failure codes map through `FAILURE_MESSAGES`.

Each attempt is a fresh native session: Claude without session persistence, Codex `--ephemeral` (`persist: false`).
A native session ID the CLI reports is recorded for reference only; Network does not resume conversations in the MVP.

### 7.3 Reuse table

| Piece | Decision |
|---|---|
| `providers.mjs` `resolveExecutable`, `cliEnv`, `spawnOwned`, `stopProcess`, `killOwnedProcesses`, `classifyProviderFailure`, `FAILURE_MESSAGES`, `runProvider`, `codexMcpOverride`, `validateEffort`, `SAFE_MODEL` | Reused unchanged. |
| `research-cli.mjs` `streamResearch`, `researchArgs` | **R1 (small shared change, Task 07):** optional `onUsage` callback and usage parsing from the stream (Claude `result.usage`/`total_cost_usd`, Codex `turn.completed.usage`). Defaults unchanged, so Origin Research behaves exactly as now; field names are confirmed with fixtures and one live smoke, and stay "not reported" until confirmed. |
| `base-resolver.mjs` `resolveBase` | **R2 (small shared change, Task 07):** optional `layers` argument replacing the global/project/column/task layers (`:63-69`); Network passes `[['network:agent:<registrationId>', null, baseResourceId]]`. Default unchanged; `tests/base-*.test.mjs` must stay green. |
| `base-resolver.mjs` `profileDefaults`, `checkBaseRevocations`, `deliveryFor`; `base-context.mjs` `prepareBase`; `base.mjs` `readRevision` | Reused unchanged. |
| `lessons.mjs` `lessonsPrompt` | Reused unchanged (read-only). |
| `server.mjs` `claim` (shared one-job slot) | **Not used by jobs.** A job can run for many minutes; holding the slot would make Compose, Split and file proposals answer `BUSY`, and lessons would never run. Jobs get their own pool (§7.4). **R3 (Task 06):** `claim('auth')` also refuses while Network jobs run (`network.activeCount() > 0`, next to `src/server.mjs:410-411`); the pool waits while `busy?.kind === 'auth'`. |
| Supervisor, `agents.buildSession`, `interpretEvent`, `SessionActivity`, workspace trust, native message input, Docker sandbox | **Not used.** They are PTY- and Board-bound. A future interactive Network worker would first extract a Board-agnostic session core from `Supervisor#launchSession`; that is post-MVP. |
| `Board.requestRun`, `createTask`, `transition` | **Never called by jobs in the MVP.** Creating a Kanban card from Network is a later, owner-confirmed action through `board.createTask` only. |

A job worker must **not**: create or edit `state.runs`, `state.sessions` or cards; create a branch or worktree; use a
project repository as its working directory; take the shared CLI slot; pass Base MCP servers or command recipes;
enable any CLI tool beyond the table in §7.2; resume a native session; retry on its own; infer completion from silence,
quiet output or exit code alone.

### 7.4 Pool, limits, cancellation, shutdown

- **Pool:** `settings.maxConcurrentJobs`, default 2, range 1–4 (the same range as Kanban sessions,
  `src/board.mjs:3838`). FIFO by `acceptedAt`. Kanban sessions and Network jobs have separate ceilings; Settings shows
  both. A pipeline's `maxParallel` cannot exceed the global ceiling.
- **Limits enforced:** wall-clock timeout per attempt (default 20 minutes, max 120), preparation 45 s, output bytes,
  Claude `--max-turns`, pipeline deadline and step count. **Not enforceable mid-run:** tokens and cost. They are shown
  after the run when reported; the confirmation dialog says "cost: not enforced".
- **Cancel:** `AbortController` per attempt → `stopProcess` SIGTERM to the group, SIGKILL after 1 s, pipes destroyed
  after 3 s (`src/research-cli.mjs:104-109`). Status `cancelled` is saved when the process has ended or the 3 s bound
  passed.
- **Shutdown:** `server.close()` (`src/server.mjs:787-818`) calls `network.close()`: stop claiming, abort attempts,
  save `interrupted`, then the existing `killOwnedProcesses('SIGKILL')` covers anything left.
- **Hard crash:** detached process groups can outlive a killed Node process. On the next start the attempt becomes
  `interrupted`/`uncertain` and the UI shows its recorded `pid` as "may still be running". Promptboard never signals a
  recorded pid after a restart (the pid may belong to another process by then).

## 8. Provider capability matrix

From `src/agents.mjs:40-101`, `src/providers.mjs`, `src/research-cli.mjs`, `docs/pipeline-activity.md`,
`docs/cli-adapters.md` and `docs/live-verification.md`. "Kanban" = interactive PTY sessions; "headless" = the
one-shot adapters that Network uses.

| | Claude Code | Codex CLI | Gemini CLI | Antigravity |
|---|---|---|---|---|
| Kanban lifecycle hooks | `SessionStart, UserPromptSubmit, PermissionRequest, Notification, Stop, StopFailure, SessionEnd` via `--settings` (`agents.mjs:230-235`); pipeline runs add `PreToolUse, PostToolUse, PostToolUseFailure, PermissionDenied, SubagentStart, SubagentStop` | `notify` program, `agent-turn-complete` only (`agents.mjs:258`); waiting visible only through the terminal title "Action Required" (`supervisor.mjs:47`) | `SessionStart, BeforeAgent, AfterAgent, Notification` (+ `BeforeTool, AfterTool, SessionEnd` in pipeline runs) through merged system settings (`agents.mjs:169-186`) | none (`agents.mjs:92-99`) |
| Turn completion evidence | Kanban `Stop`; headless `result` event | Kanban `agent-turn-complete` (title-only turns ignored, `agents.mjs:319-323`); headless completed `agent_message` + exit 0 | Kanban `AfterAgent`; headless JSON `response` | headless `result` with `status: SUCCESS` (text generation only) |
| Tool-level events | Kanban hooks; headless `tool_use` blocks (`research-cli.mjs:50-56`) | Kanban none; headless `web_search`, `mcp_tool_call` items (`research-cli.mjs:65-71`) | Kanban `BeforeTool/AfterTool`; headless none | none |
| Waiting / permission events | yes | no (title only) | `ToolPermission` notification | no |
| Read-only (Kanban) | `--permission-mode plan --tools Read,Grep,Glob --disallowedTools Edit,Write,NotebookEdit,Bash,ExitPlanMode --strict-mcp-config` (`agents.mjs:238-240`) | `--sandbox read-only --ask-for-approval never` (`agents.mjs:260`) | `--approval-mode plan --policy <deny toml> --extensions none --allowed-mcp-server-names ''` (`agents.mjs:282-287`) | not supported |
| No-tool headless | `--tools '' --disallowedTools * --strict-mcp-config --max-turns 1 --no-session-persistence` (`providers.mjs:54-56`) | read-only sandbox, approval never, web off, features off, shell disabled, `--ephemeral`, ambient MCP disabled (`providers.mjs:48-51,425-433`) | deny-all policy + empty allow lists (`providers.mjs:63-68`) | `--sandbox` only: **not** deny-all |
| Read-only + web headless | `--tools WebSearch,WebFetch --allowedTools … --max-turns 30` | `web_search="live"`, everything else off | not available | not available |
| Native session ID | `--session-id`/`--resume`; stream `system.init.session_id` | `thread.started.thread_id`; `codex resume` / `exec resume` | `--resume` (Kanban) | not verified |
| Usage / cost | transcript tokens + status-line `costUSD` (`usage.mjs:40-82`); headless result fields: to verify (R1) | rollout `token_count` (`usage.mjs:55-68`); headless `turn.completed.usage`: to verify (R1) | none reported (`usage.mjs:7`) | none |
| Docker sandbox | yes | yes | no (`agents.mjs:136`) | no |
| Live verified | yes | yes | `notLiveVerified` (`agents.mjs:77`) | prompt generation only |
| **Network job support (MVP)** | `none`, `web` | `none`, `web` | `none` | refused |

Rules: the coverage label is shown next to every live status. `unknown` is shown rather than `idle` or `done` when the
evidence is missing. Costs appear only when the CLI reported them.

## 9. Library, Graph and Pipelines are separate

- **Library** (Network → Library): the list of networks and pipelines, with drafts, published versions, where each
  version is used (other networks, pipelines, runs), duplicate, rename, delete (refused while in use, §4.5),
  export/import.
- **Graph** (Network → Graph): topology only. Nodes are registrations and pinned sub-network versions; edges are
  `message`, `delegate`, `share_result`. Saving or publishing a graph never starts work, sends a message or shares data.
  Containment cycles (A contains B contains … A, through drafts and published versions) are refused with the path in
  the error.
- **Pipelines** (Network → Pipelines): execution DAGs that belong to one network and pin one published version of it.
  Pipeline edges carry ports and data; they are a different type in storage and on screen (solid arrows with port labels
  versus dashed relation lines). An agent node may use only agents that are members of the pinned network version; the
  compiler refuses others (`PIPELINE_AGENT_NOT_IN_NETWORK`). Graph relations do not authorize pipeline data flow; the
  pipeline's own edges do. Task 12's delegation is the only feature that reads graph relations, and only as a policy
  check (`delegate` edge from A to B is required, never sufficient).
- **Compiler** (Task 09): input = one published pipeline version; output = `plan.json` with expanded sub-pipelines
  (node IDs namespaced `<subnodeId>/<childNodeId>`), pinned versions and hashes, topological order, per-node job
  templates. Refuses cycles, recursive sub-pipelines (stack check), depth over 4, more than 2,000 expanded nodes,
  missing or disabled agents, port mismatches, conditions on non-JSON ports, more than one `output` per name.
  Conditions are evaluated by a fixed interpreter over `result.json` values; no `eval`, `Function` or model-generated
  code.
- **Runs:** `plan.json` is immutable; editing or publishing a pipeline never changes a run. Each agent node submits a
  job with `source: 'pipeline'`, `pipelineRunId`, `nodeId` and idempotency key `run:<runId>:node:<nodeId>:a<n>`, so a
  restarted runner finds the existing job instead of submitting a second one.

## 10. Routes

### 10.1 Owner routes (`/api/network/*`)

`src/network/http.mjs` exports `networkRoute({ network, req, res, pathname, searchParams, jsonBody, send })`.
`src/server.mjs` adds, after the coordinator branch (`:519-522`):

```js
if (/^\/api\/network(?:\/|$)/.test(pathname)) {
  try { return await networkRoute({ network, req, res, pathname, searchParams: requestUrl.searchParams, jsonBody, send }); }
  catch (error) { return sendFailure(res, error, 'The Network request failed. Nothing was changed.', { status: 500, code: 'NETWORK_FAILED' }); }
}
```

The token, Host, Origin, proxy and fetch-site checks before it (`:470-489`) stay exactly as they are. IDs in paths match
`[a-z]+_[0-9a-f]{20}`; bodies go through `jsonBody` with the limits of §4.2; every change takes `expectedRevision`
(collections) or the row revision; responses never include lease tokens, token hashes or file paths.

| Task | Routes |
|---|---|
| 02 | `GET/POST /api/network/agents`, `GET/PATCH /api/network/agents/:id`; `GET/POST /api/network/networks`, `GET/PATCH /api/network/networks/:id`, `POST /api/network/networks/:id/publish`, `GET /api/network/networks/:id/versions/:n`; `GET /api/network/export`, `POST /api/network/import` |
| 03 | no new route: `GET /api/network/agents` also takes `kind` (`profile`/`agentProfile`) and `provider`, and answers `facets.capabilities`; agent views gain the computed fields of §5 |
| 04 | `GET/POST /api/network/agents/:id/memory` (list with `?q=` keywords and `status`, propose with the scope revision), `PATCH/DELETE /api/network/agents/:id/memory/:mid` (record revision; DELETE takes it in the body), `POST /api/network/agents/:id/memory/:mid/approve` (`{ expectedRevision, decision: 'approve' \| 'reject' }`), `GET /api/network/agents/:id/memory/preview?projectId&networkId&memory&projectLessons`; the same except the preview under `/api/network/networks/:id/memory`; `GET/POST /api/network/agents/:id/posts`, `PATCH/DELETE /api/network/agents/:id/posts/:pid` (§4.7) |
| 05 | `DELETE /api/network/networks/:id` (`{ expectedRevision }`), `POST /api/network/networks/:id/duplicate` (`{ name? }`); `GET /api/network/networks` also takes `archived=true`; `PATCH /api/network/networks/:id` also takes `archived`; network answers carry `refs`, `issues`, `usedBy` and versions `refs` (§4.8) |
| 06 | `GET/PATCH /api/network/settings`; `POST/GET /api/network/jobs`, `GET /api/network/jobs/:id`, `POST /api/network/jobs/:id/cancel`, `POST /api/network/jobs/:id/approve`, `POST /api/network/jobs/:id/retry`, `POST /api/network/jobs/:id/close`, `DELETE /api/network/jobs/:id` (terminal only); built as listed (§4.9): submit 1 MiB body, others 64 KiB; list `?status agentId projectId networkId parentJobId offset limit` |
| 07 | `GET /api/network/jobs/:id/result`, `GET /api/network/jobs/:id/attempts/:aid/:artifact` (`prompt`, `output`, `result`) |
| 08 | `GET /api/network/events?after=&limit=&agentId=&jobId=&networkId=&pipelineRunId=`, `GET /api/network/events/stream?after=` |
| 09 | `GET/POST /api/network/pipelines`, `GET/PATCH/DELETE /api/network/pipelines/:id`, `POST /api/network/pipelines/:id/validate`, `POST /api/network/pipelines/:id/publish`, `GET /api/network/pipelines/:id/versions/:n`, `POST /api/network/pipelines/:id/runs` (`{ version, confirm: true }`), `GET /api/network/pipeline-runs`, `GET /api/network/pipeline-runs/:id`, `POST /api/network/pipeline-runs/:id/cancel`, `POST /api/network/pipeline-runs/:id/nodes/:nodeId/approve` (`{ decision: 'approve' | 'reject' }`) |
| 11 | `GET/POST /api/network/clients`, `DELETE /api/network/clients/:id`, `POST /api/network/clients/:id/rotate`, `GET/PATCH /api/network/listener` |
| 12 | `GET/POST /api/network/jobs/:id/messages`, `POST /api/network/jobs/:id/answer`; `GET/POST /api/network/schedules`, `PATCH/DELETE /api/network/schedules/:id`, `POST /api/network/schedules/:id/run` |
| 13 | `GET /api/network/federation`, `POST /api/network/federation/peers/preview`, `POST /api/network/federation/peers`, `PATCH/DELETE /api/network/federation/peers/:id`, `PATCH /api/network/federation/inbound` |

Pipeline runs use `/api/network/pipeline-runs` so they are never confused with Kanban `/api/runs`.

**Event stream decision:** `GET /api/network/events/stream` is NDJSON over `fetch`, like `streamRun`
(`src/server.mjs:345-357`): `{"seq":…}` lines, a `{"ping":true}` line every 15 s, replay from `after`, then live events.
It is not `text/event-stream`, because `EventSource` cannot send the `X-STE-Token` header and the token must never be in
a URL (SECURITY.md "Local only"). At most 4 open streams per owner session and 32 overall; a slow reader is dropped
after 1 MiB of buffered data and reconnects with its last `seq`.

### 10.2 Paired devices

A paired device keeps "the same control as you at the computer" (`src/remote-access.mjs:336-342`). All owner Network
routes are allowed from it except those that create a new way in or change trust. Task 11 and 13 add these to
`localOnly()` (`src/remote-access.mjs:343-349`) and to the `LOCAL_ONLY` table in `tests/remote-access.test.mjs`:

- `POST /api/network/clients`, `POST /api/network/clients/:id/rotate` (they show a new secret);
- `PATCH /api/network/listener` (opens a listener);
- `POST /api/network/federation/peers/preview`, `POST /api/network/federation/peers`, `PATCH /api/network/federation/peers/:id`, `PATCH /api/network/federation/inbound` (trust and exposure).

`GET` of these lists and `DELETE /api/network/clients/:id` (revoke) stay allowed from a phone: revoking only removes
access. Task 02 adds `src/network/http.mjs` to the scanned file list in `tests/remote-access.test.mjs:277` and every new
route to `ALLOWED`. Revoking a paired device already ends its open Network streams (`src/remote-access.mjs:210`).

*(Phase-1 review, P1-3)* The source scan saw only literal paths, so every `:id` route was invisible to it. Now
`src/network/http.mjs` exports `NETWORK_ROUTES`, one frozen table of `{ method, pattern, run, status? }` that the
dispatcher itself reads (first match by method and anchored pattern; a known path with another method is 404), and
`tests/remote-access.test.mjs` imports it: every route must match exactly one `ALLOWED`/`LOCAL_ONLY` row and every
`/api/network` row must match a route. A new Network route (Tasks 07–13 too) goes into that table and gets exactly one
row; a local-only one is also added to `localOnly()`.

### 10.3 Machine listener (Task 11): REST and MCP for external clients

- **Off by default.** A separate `http.Server` owned by `src/network/machine-listener.mjs`, started only when the owner
  turns on **External clients** (local-only route). Default `127.0.0.1:4330`; the port must differ from the app port and
  the remote-access port. A private address for Tailscale/Twingate is allowed only with the same `privateAddress` check
  as remote access (`src/remote-access.mjs:31-39,47-50`); public and wildcard addresses are refused. TLS like remote
  access when a certificate is given.
- **Never the owner's `handle()`.** It serves only `/machine/v1/*` (and Task 13's `/.well-known/agent-card.json` and
  `/a2a/v1` when inbound A2A is on) and calls Network services directly with the authenticated principal.
- **Checks on every request:** Host must be one of the listener's own names (DNS-rebinding protection); `Origin`, if
  present, must equal the Host's origin; `sec-fetch-site: cross-site` refused; proxy headers refused unless the owner
  chose the Tailscale/Twingate mode; no CORS headers at all; requests carrying `X-STE-Token` or a `pb_remote` cookie are
  refused (`MACHINE_CREDENTIAL_REQUIRED`) so the owner credentials are never accepted or forwarded there;
  `Authorization: Bearer pbm_…` required; JSON only; 256 KiB body limit; 60 requests per minute and 10 submits per
  minute per client; idempotency through the `Idempotency-Key` header.
- **Endpoints:** `GET /machine/v1/agents`, `GET /machine/v1/agents/:id` (only agents in the client's scope; computed
  provider and capability, no instructions or Base content), `POST /machine/v1/jobs` (agent, project and memory scope
  checked against the client), `GET /machine/v1/jobs` (own jobs), `GET /machine/v1/jobs/:id`,
  `POST /machine/v1/jobs/:id/cancel` (own jobs, `cancel_own_jobs`), `GET /machine/v1/jobs/:id/result`
  (`read_job_result`), `GET /machine/v1/events?after=` and `/machine/v1/events/stream` (NDJSON, own jobs only). Submit
  answers `202 { jobId, status }` at once; it never waits for the run.
- **MCP (decision):** a stdio MCP server, `node bin/ste.mjs --mcp`, built with `@modelcontextprotocol/server` 2.3.1
  (`StdioServerTransport`/`serveStdio`). It reads `PROMPTBOARD_MACHINE_URL` and `PROMPTBOARD_MACHINE_TOKEN` from its
  environment and calls the machine REST API; it holds no other credential and no Promptboard state. Tools:
  `agents_list`, `agents_get`, `jobs_submit` (returns `jobId` immediately), `jobs_get`, `jobs_cancel`, `artifacts_get`
  (≤ 64 KiB per call); strict input schemas; tool annotations are informational only. Because MCP calls are
  asynchronous job submissions, a host that calls Promptboard while Promptboard runs a job with the same provider cannot
  deadlock it. A Streamable HTTP MCP endpoint on the machine listener (`WebStandardStreamableHTTPServerTransport`, with
  the package's Host/Origin validation) is a later option, not MVP.
- **Owner UI:** Network → "External clients" dialog: create (name, agents, projects, permissions, optional expiry),
  one-time token display (copy only on click; never in an export, a log or the page after closing), revoke, rotate,
  setup snippets for Claude Code / Codex that reference the token by environment variable name.

### 10.4 A2A boundary (Task 13)

- Outbound and inbound are separate switches in `federation.json`, both off by default.
- Outbound: the owner previews an Agent Card URL (local-only route), reviews origin, endpoint, skills and declared
  security schemes, and approves a peer. Only public card fields (bounded to 64 KiB) and a credential **environment
  variable name** are stored. Calls use `@a2a-js/sdk` 1.3.0 `ClientFactory` with an injected guarded `fetchImpl`
  (§11.5).
- Inbound: `GET /.well-known/agent-card.json` and `POST /a2a/v1` on the machine listener, served only when inbound is
  on, listing only agents/pipeline versions the owner published for A2A. Callers authenticate with a machine client of
  `kind: 'a2a'`. An inbound task creates a Network job through the job engine (`source: 'a2a'`); it never starts a CLI
  directly. Uses the SDK's `DefaultRequestHandler` and `JsonRpcTransportHandler` without Express.
- A remote peer appears as node type `federated` in Graph and Pipelines. Its steps are jobs with
  `sideEffects: 'external_unknown'`; remote task IDs are stored as opaque strings; a timeout or lost stream makes the
  step `unknown` and blocks descendants.

## 11. Threat model

### 11.1 Authority

| Principal | How it authenticates | What it may do |
|---|---|---|
| Owner at the computer | per-process `X-STE-Token` + loopback Host/Origin (`src/server.mjs:470-487`) | everything |
| Paired device | `pb_remote` cookie on the remote listener, then the same token (`src/remote-access.mjs:287-301`) | everything except §10.2 local-only routes |
| Machine client | `Bearer pbm_…` on the machine listener only | only its scoped agents, projects and permissions; only its own jobs |
| A2A caller | machine client of kind `a2a` | submit to published A2A agents; read its own tasks |
| Agent (a running CLI) | none | no API access. Agents receive no credential, token or URL of Promptboard. A delegation or memory proposal is only structured text in the agent's result, which the server validates against policy (Tasks 04, 12) |
| Model output, documents, remote peers | none | data only |

Server-side checks decide every action; graph edges, MCP tool annotations, Agent Cards and prompts never grant
anything.

### 11.2 Revocation

- Registration disabled or stale, Base resource disabled/untrusted/deleted, external root approval revoked: queued jobs
  fail at claim (`REGISTRATION_DISABLED`, `BASE_REVOKED`); a running attempt continues (as Base: "revocation does not
  remove context already supplied", SECURITY.md) and is labelled "revoked after start"; the owner can cancel it.
- Machine client revoked: every later request is `401`; its open streams are destroyed at once (open responses kept per
  client, as `src/remote-access.mjs:112,210`); its running jobs continue unless the owner chooses "Revoke and cancel its
  jobs".
- Paired device revoked: existing mechanism ends its streams.
- Peer disabled: no new calls; in-flight remote tasks become `unknown` when their stream or poll ends.

### 11.3 Timeouts and uncertain outcomes

- Preparation 45 s, attempt timeout default 20 min (max 120), pipeline deadline default 2 h, A2A call 60 s per request
  with a task deadline equal to the step timeout.
- **Write before effect:** claim, `launchingAt`, remote-task creation intent and approvals are saved before the
  process, request or release they authorize.
- **Never auto-replay:** an attempt that may have run (`launchingAt` set) and has no trusted terminal receipt becomes
  `interrupted` or `unknown` with `outcome: 'uncertain'`. Only the owner can retry (`confirmUncertain: true`) or close
  it. Pipelines block descendants. Schedules never fire a second time for the same slot. External side effects are
  not guaranteed exactly-once; the UI says so on retry.
- Idempotency keys are scoped by requester (`owner`, `cli_…`, `run_…`); the same key with a different request hash is
  `409 IDEMPOTENCY_CONFLICT`.

### 11.4 Migration and compatibility

- `state.json` (version 14), board backups (version 12), Base revisions, lessons and every other existing file are not
  changed by any Network task.
- Network files start at version 1; newer versions fail closed (§4.2 rule 3); migrations keep exact originals.
- An older Promptboard ignores `network/`. A newer Network export is refused by an older one with a clear message.
- Task 12 `Message` and `Schedule` shapes: `Message = { id, kind: 'request' | 'result' | 'review' | 'needs_input' |
  'blocked', from: { agentId } | { owner: true } | { clientId }, to: { agentId } | { owner: true }, nodeId?, text ≤16 KiB,
  json? ≤16 KiB, createdAt, readAt? }`, ≤ 500 per job; `Schedule = { id, name, target: { agentId, input } | { pipelineId,
  version }, cadence /* normalizeCadence */, timeZone /* IANA zone recorded at creation */, enabled, confirmedAt,
  lastSlot, lastJobId | lastRunId, lastSkip }`.

### 11.5 Privacy, SSRF and prompt injection

- **Privacy:** job inputs, prompts, results and memory are stored unencrypted in the data folder like prompts and run
  output today, and are sent to the provider through its CLI. Memory proposals are redacted and refused when they look
  like credentials. Events carry IDs and short redacted summaries, never prompts, tool arguments, tool results or
  transcripts. Machine clients see only their scoped agents' public fields and their own jobs. Cross-project memory
  bleed is prevented by scope keys checked on every read: a job reads memory of its own registration (and network when
  permitted) and lessons only of its own allowed project.
- **SSRF (A2A, Task 13):** a guarded `fetchImpl` for the SDK: `https:` only (plain `http:` only for loopback when the
  owner enables "local test peer"); DNS resolved first and every address checked with `isPublicAddress`
  (`src/base-context.mjs:26`) unless the peer entry explicitly allows one private address; the connection pinned to the
  checked address; `redirect: 'manual'`, redirects followed only to the same origin and re-checked, `Authorization`
  dropped on any cross-origin hop (so refused); 10 s connect, 60 s request, 1 MiB response, 64 KiB card; userinfo in
  URLs refused. Inbound A2A never fetches caller-supplied URLs (push notifications are not supported).
- **Prompt injection:** job input, upstream step outputs, memory, Base documents and remote results are wrapped in
  labelled data sections; no model output can change permissions, scopes, the DAG, approvals or tools; conditions read
  only typed JSON values; results are rendered as text or the limited Markdown renderer (`public/markdown-view.js`),
  never HTML; agent-proposed memory, delegations and posts need owner approval or a server policy check.
- **Resource abuse:** pool ceiling, rate limits, body limits, stream ceilings, bounded files (§4.2).

## 12. UI plan

**Routing today:** `currentPage()` compares `location.hash` exactly (`public/app.js:1368`); `showPage()`
(`:1369-1399`) toggles the four `<main>` views, the sidebar panels, `aria-current` in `.page-nav`
(`public/index.html:46-51`), the title, the skip link and the sidebar labels; `hashchange` calls `showPage`
(`:4139`); the start page preference allows `origin | compose | kanban | base` (`:5905`) and is applied only without
an explicit route (`:6314`); the select is `public/index.html:424`. Feature modules are classic scripts that expose
`window.Promptboard<Name>.create({...})` and are created at the end of `app.js` (`:6255-6311`).

**Task 03 changes:**

- `index.html`: `<a href="#/network">Network</a>` after Base; `<main class="workspace network-workspace"
  id="network-view" tabindex="-1" hidden aria-labelledby="network-heading">`; a `#network-sidebar-panel`; the start
  page option `network`; `<script src="/network.js" defer>` before `app.js`.
- `app.js`: `currentPage()` returns `network` for `/^#\/network(?:\/|$)/`; `showPage()` handles the fifth view, the
  title "Network · Promptboard", the skip link, the sidebar label "Network"; heavy side effects
  (`setSidebar(false)`, `scrollTo`) run only when the page changes, so in-page sub-routes do not reset it.
  `allowed.startPage` gains `network`. `window.PromptboardNetwork?.create({ api, announce, openBase: id => { location.hash
  = '#/base'; baseView?.openResource(id); }, projects: () => board?.projects || [], ensureBoard: loadBoard,
  closeSidebar: () => setSidebar(false), remote: () => Boolean(remoteSession) })`.
- `server.mjs` `assets`: `/network.js` (Task 03), `/network-graph.js` (05), `/network-pipeline.js` (10).
- Sub-routes owned by `network.js`: `#/network` (Agents), `#/network/agents/<id>`, `#/network/graph/<networkId>`,
  `#/network/pipelines/<pipelineId>`, `#/network/runs/<runId>`, `#/network/activity`, `#/network/library`,
  `#/network/federation`. Back/forward work through `hashchange`.
- Tabs: Agents, Graph, Pipelines, Activity, Library, Federation, as a tablist with arrow-key navigation like the
  Compose mode tabs (`public/app.js:6265-6268`). A tab whose task is not done shows "Not available yet" with what it
  will do; it has no working-looking controls. Federation stays marked unavailable until Task 13.
- Agent detail: Base kind, name, provider/model (computed), trust/enabled, stale reason, Open in Base, projects,
  networks, enable/disable, Tasks/Activity/Memory/Posts sections (unavailable until their tasks).
- Mobile (≤ 730 px, the app's phone layout): list → detail; Graph and Pipelines show an ordered list instead of the
  canvas.
- Rendering: `public/dom.js` helpers and DOM text only; the existing CSS variables, light/dark tokens and hairline
  styles; no new framework.

### 12.1 Settled in Task 03

Refinements of the plan above made while building `public/network.js`; none changes a binding rule.

1. **Role filter = the Base kind** (`kind=profile` for an Agent, `kind=agentProfile` for an Agent profile); Base has no
   other "role" field on a resource. **Provider filter** = the provider the agent would run with (an agent profile's
   primary agent). Both are server-side because the list is paged; `facets.capabilities` lists every declared
   capability of every registration (unfiltered) for the Capability select.
2. **Derived fields live in the registry view** (§5): `providerCapabilities` comes from the §8 matrix in
   `src/network/registry.mjs` (an unset or unknown provider is `known: false` with every value `unknown` and
   `jobTools: null`, never assumed capable); `base.instructions` is a 280-character preview masked with `redactLocal`
   plus the full length; `base.usedBy` counts Base's own non-historical "Used by" entries. Base's "Used by" panel still
   does not list Network registrations (open question 1 unchanged); "Open in Base" shows Base's own list.
3. **Open in Base** uses the existing seam `baseView.openResource(id)` after `location.hash = '#/base'`; no new deep link
   was needed in `base.js` and the Base URL stays `#/base`, so Back returns to `#/network/agents/<id>`. A registration
   whose Base resource is missing shows "Open in Base" disabled, described by its stale note.
4. **Unavailable sections and profile tabs** (Graph, Pipelines, Activity, Library, Federation; Tasks, Activity)
   are selectable, marked "soon", and show "Not available yet." plus one sentence on what they will do, with no
   controls. The profile's Memory and Posts tabs work since Task 04 (§4.7). Their sub-routes exist (`#/network/graph` …), so back and forward work now. "Register agent" shows on the
   Agents section only.
5. **Sidebar:** `#network-sidebar-panel` lists the same six sections as links (the phone drawer and keyboard reach
   them); the in-page tablist is the primary control.
6. **Scrolling:** `showPage()` keeps the scroll position while moving between Network sub-routes; every other page change
   still scrolls to the top. On a phone (≤ 730 px) choosing an agent shows the profile instead of the list and toolbar
   and focuses its heading; "Back to agents" returns focus to that row.
7. **Revision conflicts:** the switch shows the server's message with **Reload** (reads the list again, nothing is
   retried); an edit dialog's **Reload** closes the dialog and shows the current version (the edit is never re-sent over
   someone else's change); a register dialog's **Reload** only refreshes the collection revision and keeps the form.
8. **Edit identity** keeps listed projects that are no longer on the board as ticked "(not on this board)" entries, so
   saving never drops them silently.
9. **Top bar with five links** (measured in Chrome from 320 to 940 px): the links wrap onto their own row at ≤ 479 px
   (was 430), the actions compact at ≤ 540 px (was 500), the links tighten at ≤ 610 px (was 560), and link padding is
   9 px at ≤ 820 px. `tests/app-fixes-browser.test.mjs` checks the widths just above each step on all five pages.

### 12.2 Settled in Task 05 (Graph and Library)

1. **Routes:** `#/network/library`, `#/network/library/<networkId>`, `#/network/graph` (choose a network),
   `#/network/graph/<networkId>` (the draft editor) and `#/network/graph/<networkId>/v<n>` (a published version, read only).
   `public/network-graph.js` (`window.PromptboardNetworkGraph.create`) owns both panels; `network.js` routes to it and lends
   it its status line, dialog and the Memory panel.
2. **Library:** search (server), Show archived, New network, Export (the Network file through `PromptboardDom.download`),
   Import (a file; registrations arrive switched off), and per network: Open in Graph, Rename, Duplicate, Archive/Restore,
   Delete (disabled with the reason when §4.8 would refuse it), published versions newest first with Latest and View,
   Used by, Check (issues) and the network's **Memory** (the Task 04 panel over `/api/network/networks/:id/memory`, without
   the job preview, which exists for agents only).
3. **Editor:** a working copy edited locally, saved as one `PATCH` of all nodes and relations with the loaded revision
   (positions from drags, arrow keys and layouts are batched into it). Save draft, Publish version n (saves first when
   needed, with a confirmation that versions never change), Undo (50 steps), Discard changes, version chips `v1`, `v2 · latest`
   (each opens the read-only view). Add agent (search over registrations; switched-off and stale ones marked; already
   placed ones disabled), Add sub-network (only published versions of other, non-archived networks; the pin is
   `{ networkId, version }`), own connect controls (no edgehandles): the node details' "Connect from" form (keyboard), or
   Connect mode on the canvas (relation select, then two taps; Escape stops), Disconnect in the relation list, the node's
   relations and the relation details; Remove (node with its relations, or a relation). The page says plainly that saving or
   publishing starts nothing and that a relation grants no permission, sends no message and shares no data.
4. **Canvas** (Cytoscape, desktop only): drag to place, wheel/pinch pan and zoom plus Fit, −, +; Arrange in a grid (plain
   JS, so it also works without the canvas) and Arrange in layers (breadth-first along the relations), both only on request;
   search fades non-matching nodes and filters the lists; relation checkboxes hide a type. Colours come from the page tokens
   and follow the theme. Relations are dashed with a colour and arrow shape per type (message: triangle, delegate: tee,
   share result: circle); above 300 relations on the canvas they are drawn solid, because dashes cost seconds per frame in
   software rendering (measured). Graphs above 300 nodes pan and zoom on a cached image with relations hidden while moving.
   Switched-off agents are dashed and faded, stale/missing ones and unreadable pins have a warning border, the node that
   closes a refused cycle an error border.
5. **Lazy nested networks:** a sub-network node is drawn collapsed (name, pinned version, size). Expanding it (double-click
   or the details button) reads that version then (`GET …/versions/:n`, cached for the visit) and draws its nodes and
   relations inside it, read only and not draggable; nested sub-networks inside can be expanded in turn. **View cap:** at
   most 1,000 nodes are drawn; an expansion that would pass it is refused with a notice that names the sizes and what to
   do, and a draft that itself has more than 1,000 nodes is drawn with a notice. Without a canvas, "Show what is inside"
   lists the pinned version's nodes (first 200).
6. **Accessible fallback and phones:** beside the canvas, the Nodes and Relations lists (200 rows, then "Show all") and the
   details panel do everything with the keyboard; with the canvas focused, arrow keys move the chosen node (Shift: 50),
   Delete removes it and Escape stops connecting. At ≤ 730 px the canvas is never created: the lists, then one node's
   details with "Back to the lists" (focus returns to the row). Without Cytoscape (the vendor file missing), the page says
   so and the lists edit the same draft.
7. **Unsaved changes and conflicts:** leaving the editor (another section, another page, another network) asks with
   `window.confirm` as Base does; "keep editing" brings the editor's address back. Closing the tab asks through
   `beforeunload`. A save over a newer draft (`REVISION_CONFLICT`) overwrites nothing and offers "Load the saved draft"
   (drops the edits) or "Save mine as a new network" (`<name> (my changes)`).
8. **Phase-1 review (P1-4, P1-5, P1-9, P1-10).** A publish refused by a newer save, or refused with node `details`, closes
   its dialog and shows the same alert and choices in the editor; Save and Publish stay disabled (with the reason) until
   the owner picks one. A new node is placed where it keeps clear of every other node (centres at least 190 × 70 apart).
   An expanded sub-network shows a one-line label inside its box, below the border where relations arrive, on its own
   background; relations inside it are drawn above its nodes (`z-compound-depth: top`). The page's status line keeps its
   height when empty, and Connect mode's instructions use it instead of a notice above the canvas, so no message moves the
   canvas under the pointer. Also from the review: Add sub-network searches on the server past the first 200 networks;
   a read-only version's heading shows the name it was published with; declining the unsaved-changes question restores
   the editor's address with `history.replaceState`, so Back never leads to the declined page.

## 13. Dependencies (checked 2026-10-26 with `npm view`; nothing installed)

| Package | Decision | Version (published) | License | Size | Notes |
|---|---|---|---|---|---|
| `cytoscape` | **Installed** (Task 05: `npm install --save-exact`, `npm audit` 0 vulnerabilities, no dependencies; `THIRD_PARTY_NOTICES.md`). The vendor map now resolves paths from `node_modules/` (xterm entries gained their `@xterm/` prefix); only the listed exact paths are served. | 3.34.3 (2026-09-07) | MIT | 5.7 MB unpacked; `dist/cytoscape.min.js` 435,503 B (137 KB gzip) | No dependencies. UMD `dist/cytoscape.min.js` served by exact path `/vendor/cytoscape.min.js` (like xterm, `src/server.mjs:82-88`) and loaded with a `<script defer>`; ESM build exists but the app uses classic scripts. The bundle has no `eval`, `new Function`, workers or network calls, but inserts one `<style>` element (`.__________cytoscape_container{position:relative}`) unless an element with id `__________cytoscape_stylesheet` exists; the CSP (`style-src 'self'`) would block it. Put that rule in `styles.css` and an empty `<meta id="__________cytoscape_stylesheet">` in `index.html`. Never relax the CSP. 3.34.4 (2026-10-15) is too new. |
| `cytoscape-edgehandles` | **Do not use** | 4.0.1 (2021-07-28) | MIT | 201 KB | Its UMD build reads `lodash.memoize`/`lodash.throttle` as `root._.memoize`/`root._.throttle` (needs a global lodash) and is unmaintained since 2021. Task 05 writes its own connect controls: select a node, choose "Connect to…", pick the target by click or from a keyboard list, choose the relation. |
| `@modelcontextprotocol/server` | **Use** (Task 11) | 2.3.1 (2026-10-05) | Apache-2.0 | 7.0 MB | Same release as the installed `@modelcontextprotocol/client` 2.3.1 and `core` 2.3.1 (`package.json`, `node_modules/@modelcontextprotocol/`); its only dependencies are `zod ^4.2.0` (4.6.7 installed) and `core` 2.3.1. Exports `McpServer`, `./stdio` (`StdioServerTransport`, `serveStdio`), `WebStandardStreamableHTTPServerTransport`, Host/Origin validators. 2.4.0 (2026-10-23) is too new; upgrade client and server together later. |
| `@a2a-js/sdk` | **Use** (Task 13) | 1.3.0 (2026-09-29) | Apache-2.0 | 4.5 MB | A2A protocol `1.0` (`PROTOCOL_VERSION = "1.0"`). Hard dependency only `jose ^6.2.3` (6.2.12 installed); Express, gRPC and databases are optional peers and not needed: use `DefaultRequestHandler`, `JsonRpcTransportHandler`, `InMemoryTaskStore` (server) and `ClientFactory`, `DefaultAgentCardResolver`, `JsonRpcTransportFactory` with `fetchImpl` (client). |

Every new dependency is pinned exactly (as `package.json` does today), added to `package-lock.json` with `npm install
--save-exact`, and to `THIRD_PARTY_NOTICES.md` with its license text, in the task that first uses it. Network access
worked for these checks.

## 14. Conflicts between NETWORK_REQUIREMENTS.md and HEAD, and the choice made

1. **SSE requested (Task 08), but browser `EventSource` cannot send the token header and tokens never go in URLs.** →
   NDJSON over `fetch` with SSE semantics (sequence IDs, replay from `after`, heartbeat, reconnect), as
   `streamRun` does.
2. **"Reuse existing Store serialization" vs "do not inflate `state.json`".** → durable per-domain files with `serial()`
   and CAS, not `Store`; no `STATE_VERSION` change.
3. **"Reuse the existing global concurrency setting if compatible".** → `maxConcurrentRuns` limits PTY Kanban sessions
   with worktrees; Network gets `maxConcurrentJobs` (default 2, 1–4) beside it.
4. **"Reuse Board/Supervisor run path" vs "do not spoof a Kanban card".** → reuse the headless adapters and Base
   pipeline; the Supervisor is not used (§7).
5. **"Tool access from trusted Base resources" vs read-only enforcement.** → Base MCP servers and command recipes are
   unavailable in Network jobs (the existing read-only delivery rule); web search is the only optional tool.
6. **Cytoscape with edgehandles.** → Cytoscape only; own connect controls; CSP-safe stylesheet placeholder.
7. **Network schedules with an explicit time zone vs Kanban schedules in local time (`src/schedules.mjs`).** → reuse
   `normalizeCadence`/`nextFire` in local time, record the IANA zone at creation, and show a warning (no firing) when the
   computer's zone differs from the recorded one until the owner confirms the schedule again.
8. **`MemoryRecord.textRef`.** → text stored inline in the scope file (bounded); no separate blob files.
9. **`NetworkEvent.runId`.** → `attemptId` (job worker run) and `pipelineRunId` (pipeline run), so Kanban run IDs are
   never ambiguous.
10. **"Emit events from Supervisor/Board runs".** → Kanban runs are shown in Network Activity read-only, derived from
    `board.view()` runs whose `baseManifest.profiles` contain a registered Base ID; they are not journaled and the
    Supervisor is not changed.
11. **Board backup coverage.** → board backup unchanged; separate Network export (§4.4).
12. **"New routes respect paired-device classification".** → allowed by default like other owner routes; credential,
    listener and trust routes local-only (§10.2).
13. **Pipeline `subnetwork` nodes.** → a sub-network has no execution semantics of its own, so a pipeline sub-network
    node references a **published pipeline** of that network and is expanded at compile time.
14. **Task 07 "workspace-write jobs".** → not in the MVP: refused with `EXECUTION_POLICY_UNSUPPORTED` until a headless
    write mode is verified per provider; code changes stay on Kanban.

## 15. Task dependency map and non-goals

```
01 → 02 → 03 → 04 ─┐
          02 → 05 ─┤
          02 → 06 → 07 (needs 04) → 08 (needs 03) → 09 (needs 05) → 10
                                    08 → 11 (needs 02, 06, 07)
MVP = 02–11.   Later: 12 (06, 08, 09, 11) → 13 (06, 08, 09, 11, 12).   Release: 14 (all).
```

| Task | Prerequisites | Delivers | Non-goals |
|---|---|---|---|
| 02 | 01 | registry storage, owner routes, export/import | UI, jobs |
| 03 | 02 | fifth page, agent directory and detail | graph canvas, execution |
| 04 | 02, 03 | scoped memory, posts | embeddings, vector DB, changes to Project Memory |
| 05 | 02, 03 | Graph and Library, Cytoscape | pipelines, any execution |
| 06 | 02 | job engine with fake worker | live CLIs |
| 07 | 04, 06 | local headless worker, R1/R2 | PTY jobs, workspace-write, resume |
| 08 | 03, 06, 07 | journal, stream, Activity | Kanban run journaling, cost estimates |
| 09 | 05, 06, 07, 08 | compiler and runner | cycles, free-form code |
| 10 | 05, 08, 09 | Pipeline designer and run viewer | new frontend framework |
| 11 | 02, 06, 07, 08 | machine clients, REST, stdio MCP | public listener, Streamable HTTP MCP |
| 12 | 06, 08, 09, 11 | messages, delegation, schedules | social feed, unbounded chat, webhooks (deferred unless verified) |
| 13 | 06, 08, 09, 11, 12 | A2A client/server, federated node | multi-hop federation, marketplace, remote process control |
| 14 | all | E2E, performance, docs, release notes, CHANGELOG | merging or pushing |

Never in scope (requirements): Redis, Kafka, Kubernetes, microservices, graph databases, multi-tenant SaaS, agent
passports, self-writing skills, agent social feed, remote workers on other machines.

## 16. Open questions (decided defaults, owner may change)

1. Should Base's "Used by" panel list Network registrations? Default: no (keeps Base independent); Network shows its own
   reverse links.
2. Default `maxConcurrentJobs` 2 and attempt timeout 20 minutes are guesses for a laptop; both are settings.
3. Workspace-write Network jobs and repository read access are post-MVP (§14 item 14).
4. Whether the board backup should later embed the Network export (one file for everything). Default: separate files
   in the MVP; revisit in Task 14.
5. Headless usage field names (R1) must be confirmed against real CLIs in the Task 07 opt-in smoke; until then usage is
   "not reported".

## 17. Parallel wave contracts (binding for Tasks 07, 08 and 09)

From Task 07 on, the owner asked for three agents at a time. Tasks 07, 08 and 09 are built at the same time on separate
branches from the same base and merged in that order. These interfaces are fixed so the three meet without guessing:

1. **Event sink (Task 08 owns).** `src/network/events.mjs` exports `NetworkEvents` with
   `append(event) → Promise<{ seq, id }>`, never throwing on a full or damaged journal (it records the failure and
   returns `null`). Event: `{ type, at?, agentId?, jobId?, attemptId?, pipelineRunId?, nodeId?, networkId?, projectId?,
   status?, from?, by?, errorCode?, message?, coverage?, artifactRef? }`; the journal adds `seq`, `id` and `at`.
   Types: `job.status`, `job.activity`, `job.result`, `pipeline.run`, `pipeline.node`, `kanban.run` (read-only, derived).
   `message` ≤ 500 characters, one line, redacted with `redactLocal(noPaths())`; never prompts, tool inputs or results.
2. **Job engine hook (Task 08 wires it).** `NetworkJobs` gets an optional constructor option `events` (stored as
   `this.events`). Every saved status change appends one `job.status` event `{ jobId, attemptId, agentId, projectId,
   networkId, status, from, by, errorCode, message }` after the save succeeds. Nothing else in the engine changes for
   Task 08.
3. **Worker activity (Task 07 owns).** `NetworkJobs.activity(own, item)` validates the ownership like `spawned`,
   accepts `{ kind: 'turn'|'tool'|'web'|'mcp'|'text'|'status', label }` (label ≤ 160 characters, one line, redacted),
   keeps only the latest item in memory for the job view (`lastActivity`), never writes `job.json` for it, and calls
   `this.events?.append({ type: 'job.activity', … })` (a no-op until Task 08 is merged). The worker report gains
   `usage` (`{ reported: boolean, inputTokens?, outputTokens?, cachedTokens?, costUsd? }`, only reported numbers) and
   `nativeSessionId` (one line, ≤ 200 characters).
4. **Pipeline link (Task 09 owns).** `jobs.submit` accepts an optional `pipeline: { runId, nodeId }` (validated IDs),
   stored on the job and in `request.json`, filterable in `list({ pipelineRunId })`. The pipeline runner follows its
   node jobs with `jobs.read()` on an injectable timer (no dependency on Task 08 internals) and reports its own
   transitions through an injected `events` (same `append` contract, optional).
5. **Shared files.** Each task adds its own rows to `NETWORK_ROUTES` and the paired-device table, its own section at the
   end of this document and its own "Task NN" section at the end of the progress log; it does not edit the progress
   status table (the coordinator does, when merging).

## 19. Task 08 decisions (events, stream and Activity)

Built in `src/network/events.mjs` (journal and stream), `src/network/activity.mjs` (the Activity summary: coverage,
statuses, Kanban runs) and `public/network-activity.js` (the UI). None changes a binding rule; items 2, 6 and 8 fill in
§4.3 and §10.1, item 7 adds one route.

1. **Journal files.** `<data>/network/events/<16-digit first seq>.jsonl`, created on the first append (reading creates
   nothing), folder 0700, files 0600, append only. Line 1 of a segment is the header
   `{"schema":"promptboard.network-events","version":1,"first":<seq>}`; every other line is one event
   `{ seq, id: 'evt_…', at, type, …fields }`. Fields kept (anything else is dropped, never copied): `jobId attemptId
   agentId pipelineRunId networkId projectId` (`[A-Za-z0-9_-]{1,100}`), `nodeId` (`n_…` and `/`-namespaced steps),
   `status from by kind coverage` (lower-case words), `errorCode` (`[A-Z][A-Z0-9_]+`), `artifactRef` (a relative path
   without `..`), and `message`: one line (`oneLine`: local folders cut, secret-looking values masked, every line break
   and run of white space one space), at most 500 characters. `label` (a worker activity's text) is taken as the
   message. Types are `<word>.<word>` (`job.status`, `job.activity`, `job.result`, `pipeline.run`, `pipeline.node`, …);
   `kanban.*` is refused because Kanban runs are derived, never journaled (§14 item 10). A line is at most 4 KiB.
2. **Sequence.** `seq` strictly increases across segments and restarts: the next one is the newest segment's last valid
   seq + 1, or its `first` when it holds no event (a crash right after the header). A write that fails part-way still
   uses up its seq, so no seq is ever written twice; readers see a seq only after its write ended. Appends run one at a
   time in call order, so the job engine's events keep its transition order.
3. **Damage and versions.** A line that does not parse, lacks `seq`/`id`/`at`/`type`, or does not continue the sequence
   (a duplicate or reordered seq) is skipped and counted (`skipped` in each page: damaged lines in the segments that page
   read); nothing is repaired in place. A torn last line (crash during a write) is closed with a line break on load, so
   it stays one skipped line and the next event starts on its own line. A segment whose header has a newer `version`
   makes the whole journal unavailable: `read` and the stream answer `409 NETWORK_VERSION_UNSUPPORTED`, `append` answers
   null, and no file is written, rolled or removed. An unreadable folder is reported as `NETWORK_DATA_UNREADABLE`.
4. **Retention (§4.3, kept).** A segment rolls over past 8 MiB; the newest 16 are kept (about 128 MiB) and the oldest
   segment file is removed when a new one starts. This is the only automatic deletion in Network and it touches only
   the journal (observability, not data: jobs keep their own records). Cursors are sequence numbers, so retention never
   breaks one: `after` older than the oldest kept event reads from the oldest with `gap: true` (the stream sends
   `{"gap":true,"oldest":n}`), and the UI says "Older events were removed when the journal reached its size limit". A
   cursor past the newest (the journal was removed by hand) answers `reset: true` (stream `{"reset":true,"last":n}`), and
   the page reads the journal again.
5. **Durability.** Appends are not fsynced (one per event would slow every transition, and the journal is not
   authority). An event reaches listeners only after its write ended, so a crash of the app never loses an event a
   reader saw; a power loss can lose the newest lines (see known limits in the progress log).
6. **Routes (§10.1 row 08).** `GET /api/network/events` takes `after` *or* `before`, `limit` 1–200 (default 100) and
   the exact filters `agentId jobId networkId pipelineRunId`, and answers `{ events (ascending), last, oldest, next, prev,
   more, gap, reset, skipped }`: `after` pages forward (`next`), otherwise the newest events before `before` (default:
   all) page backward (`prev`, null at the oldest). At most 50,000 lines are looked at per call, so a narrow filter
   answers an empty page with a cursor that moved instead of reading the whole journal. `GET /api/network/events/stream`
   is NDJSON (§14 item 1): with `after` it replays every kept event after it, then `{"live":true,"last":n}`, then each
   event as it is written and `{"ping":true}` every 15 s; without `after` it starts live. Ceilings: 4 open streams per
   client (the computer is one client, each paired device another) and 32 in all (`429 STREAM_LIMIT`); a reader that
   leaves 1 MiB unread, or lets 1,000 events pile up while it replays, is dropped and reconnects with its last seq. Every
   close tears the stream down (listener, ping, count). A revoked paired device's response is destroyed by
   `src/remote-access.mjs` itself (it keeps every response per session), which ends the stream at once.
7. **One added route: `GET /api/network/activity`.** The page's current picture in one read: every registration with
   its status, per-status counts, coverage and active Kanban runs; the open jobs (every page of the seven open statuses,
   from the job engine's memory) ordered "needs you" first, then running, then queued in FIFO order, the first 200 with
   `queueTotal`; up to 50 Kanban runs; and the journal's `{ last, oldest, failures, unavailable }`. Without it the page
   would need seven job-list calls and the board. All three Task 08 routes only read, show no secret and create no way
   in, so they are allowed from a paired device (§10.2) and none is local-only; each has its row in
   `tests/remote-access.test.mjs`.
8. **Job engine hook (§17 item 2).** `new NetworkJobs({ …, events })`; `#save` appends one `job.status` event whenever
   the saved status differs from the one before (`from`), and `submit` one for the new job (`from: null`), also for the
   restart reconciliation and backup restores. Fields: `jobId attemptId agentId projectId networkId status from by
   errorCode message` (the job's reason) as §17 lists, plus `pipelineRunId`/`nodeId` (Task 09's job fields, so the run
   filter works), `coverage` (the attempt's, once known) and `artifactRef` (the result file of a completed job). The
   append is not awaited and every throw or rejection of the sink is swallowed: a full disk, a damaged journal or a sink
   that never answers cannot hold up or undo a saved transition (tested).
9. **Authority.** Events are never read to decide anything: job and pipeline state come only from `job.json`/`run.json`,
   no route appends an event, and a forged `job.status completed` changes no job (tested). "Only trusted source events
   may influence completion" therefore holds trivially: none may.
10. **Statuses and coverage.** An agent's status is the first of `waiting_for_input`, `unknown` (also `interrupted`:
    needs your decision), `waiting_for_approval`, `running` (also `preparing`), `queued` among its open jobs, else `none`
    ("No open job"), never idle or done. Coverage per provider from §7.2/§8: Claude `tools` ("Tool activity"), Codex
    `partial-tools` ("Limited activity": only web searches and MCP calls, so a quiet running job is not a stopped one),
    Gemini `final-only`, Antigravity `none`, no provider `unknown`; each with a one-sentence note shown beside the status.
11. **Kanban runs (§14 item 10).** Read from `board.state()` (the same runs `board.view()` sends, the newest 500): a run
    belongs to every registration whose Base resource is in its `baseManifest.profiles`. Shown read only with the card
    title, project, stage, provider, status (Kanban's own words), reported usage and "Open in Kanban"
    (`openTask(projectId, taskId)` from `app.js`: loads the board, selects the project, opens the card's details). Active
    runs first, at most 50. Not journaled; the Supervisor and the board are unchanged and nothing is written.
12. **UI.** Network → Activity (`#/network/activity`; one job's record at `#/network/activity/<jobId>`) and the agent
    profile's Activity tab. One stream per page while either shows, through `tokenFetch` (the token stays in a header);
    it reconnects after 1, 2, 4, 8, 15 s with the last seq it saw, ignores any seq it already has, reloads on `reset`, and
    pauses for 15 s on `429`. The summary is read again 300 ms after events and every 20 s (Kanban runs and queue positions
    are not journaled). The timeline keeps at most 1,000 events in memory ("Show older events" reads further back);
    filters (agent, event kind) and search work on the loaded events. Usage and cost appear only as reported ("Usage: not
    reported"); nothing shows a percentage or a progress bar. A state is a colour, a border and a mark (running ▶ blue,
    waiting ⏸ amber, unknown ? dashed), so waiting and unknown differ without colour. A job's record uses Task 06's
    `GET /jobs/:id` and the journal; its result text comes from Task 07's `GET /jobs/:id/result` when that route exists
    (otherwise "not shown here in this version"). Live redraws keep keyboard focus (by id or `data-focus-key`). The Tasks
    tab stays Task 07's.
13. **For Tasks 07 and 09.** Append `{ type, …fields }` as §17 says; unknown fields are dropped silently, invalid ones
    left out, an unusable type refused (`append` answers null and the journal counts it). A `job.activity` may carry
    `kind` (`turn|tool|web|mcp|text|status`), which the timeline shows ("Web search", "Tool"); without it the event shows
    as "Activity" with its message. Pipeline events show as "Pipeline run <id>: <status>" and "… step <nodeId>: <status>".
