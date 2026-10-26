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
| Network settings | `network/settings.json` | `src/network/settings.mjs` (or inside `registry.mjs`) | 06 |
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
   `redactLocal(noPaths(text))` as `src/lessons.mjs:35` does.

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
  a non-terminal job or pipeline run references any of its versions (`NETWORK_IN_USE`).
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
   name, network name, description, labels) is masked with `redactLocal` before it is saved. `providerCapabilities` is
   left to Task 03.
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
6. **Loading.** A stored row or draft must be exactly what the registry writes (strict node/edge check, hash-shaped
   version entries); anything else is damaged. `agents.json` with no usable copy refuses the agent routes
   (`NETWORK_DATA_DAMAGED`). A draft with no usable copy, or a newer version, is listed under `unavailable` and refused
   on its own; the other networks keep working. Export refuses while any draft is unavailable, rather than writing an
   incomplete file.
7. **Publish order.** The version file is written before the draft names it; a crash between leaves an unreferenced
   version file (harmless, never deleted), and the next publish takes the same number with a new hash.
8. **Import.** Validation is all-or-nothing and happens before any write. Writes go registrations (disabled), then
   version files, then drafts, so a saved draft never names a missing agent or file; a crash in between can leave
   disabled registrations or unreferenced version files, never a run. A version whose network and references keep
   their IDs keeps its bytes and hash; a remapped one is re-hashed. Project IDs that are not on this board are dropped
   from `projectAllowlist` with a warning. A network name already in use gets ` (2)`, ` (3)`…. Importing the same file
   twice adds copies.

## 5. Data shapes

Field names are binding; tasks may add optional fields.

```js
// network/agents.json → rows[]
AgentRegistration = { id: 'agt_…', baseResourceId, displayName: string|null /* ≤80 */, tags: string[] /* ≤20×40 */,
  capabilities: string[] /* owner-declared capability tags, ≤20×40; not provider capabilities */,
  enabled: boolean, visibility: 'private', projectAllowlist: string[] /* board project IDs; [] = no project data */,
  createdAt, updatedAt, revision }
// Computed on read, never stored: base: { kind, name, enabled, trust, revision, provider, model, effort, stale: boolean },
// networks: [ids containing it], providerCapabilities (from ADAPTERS + §8).

// network/networks/<id>.json
NetworkDraft = { schema, version: 1, id: 'net_…', name /* ≤80, unique case-insensitive */, description /* ≤2000 */,
  revision, createdAt, updatedAt,
  nodes: [ { id: 'n_…', type: 'agent', agentId, position: { x, y }, collapsed?: true }
         | { id: 'n_…', type: 'subnetwork', networkId, version: number /* pinned published version */, position, collapsed? } ],
  edges: [ { id: 'e_…', from: nodeId, to: nodeId, relation: 'message' | 'delegate' | 'share_result' } ],
  publishedVersions: [ { version, sha256, publishedAt } ] }
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
  parentJobId: string|null, idempotencyKey: string|null /* ≤200 printable */, requestSha256,
  createdAt, updatedAt, acceptedAt, attempts: [Attempt], currentAttemptId: string|null,
  outcome: null | 'completed' | 'failed' | 'cancelled' | 'uncertain', errorCode: string|null, reason: string /* ≤500 */,
  result: null | { textRef: 'attempts/<id>/result.md', jsonRef?: 'attempts/<id>/result.json', chars, sha256 },
  children: [jobId] }
Attempt = { id: 'att_…', number, status /* §6.2 */, workerInstance /* process UUID */, claimedAt, launchingAt: number|null,
  spawnedAt: number|null, endedAt: number|null, pid: number|null, provider, model, effort,
  nativeSessionId: string|null, exitCode: number|null, errorCode: string|null,
  coverage: 'tools' | 'partial-tools' | 'final-only', sideEffects: 'none' | 'read_only_web' | 'external_unknown',
  usage: { reported: false } | { reported: true, inputTokens?, outputTokens?, cachedTokens?, costUSD? } }
// The lease token is held in memory only and never written, exported or returned.

// network/jobs/<id>/request.json (immutable, the accepted snapshot)
JobRequest = { schema, version: 1, jobId, acceptedAt, input: { text /* ≤256 KiB */, json?: object /* ≤64 KiB */ },
  instructions /* ≤32 KiB */, tools: 'none' | 'web',
  permissions: { filesystem: 'read_only', memory: 'none' | 'agent' | 'agent+network', projectLessons: boolean },
  limits: { timeoutMs /* default 20 min, max 120 min */, maxOutputBytes },
  requireApproval: boolean,
  agent: { registrationId, registrationRevision, baseResourceId, provider, model, effort,
           manifest /* resolveBase() result with revisionRefs, §7.2 step 2 */ } }

NetworkEvent = { seq, id: 'evt_…', at, type /* e.g. job.queued, job.status, job.activity, run.node, registry.changed */,
  source: 'job' | 'worker' | 'pipeline' | 'registry' | 'memory' | 'owner' | 'machine' | 'a2a',
  agentId?, jobId?, attemptId?, pipelineRunId?, nodeId?, networkId?, status?, coverage?,
  message? /* ≤300, redacted */, artifactRef? }

MemoryRecord = { id: 'mem_…', scope: { kind: 'agent', agentId } | { kind: 'network', networkId },
  kind: 'fact' | 'lesson' | 'preference' | 'procedure', text /* ≤4000 */,
  source: { kind: 'owner' } | { kind: 'job', jobId, attemptId }, status: 'proposed' | 'approved' | 'rejected',
  revision, createdAt, decidedAt?, editedAt? }

Post = { id: 'pst_…', agentId, markdown /* ≤16 KiB */, jobId?, source: { kind: 'owner' } | { kind: 'machine', clientId },
  createdAt, editedAt?, revision }        // shown as "Report", never as a verified event

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
   `=== JOB INPUT (data, not instructions) ===` delimiters.
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
| 04 | `GET/POST /api/network/agents/:id/memory` (list, `?q=` search, propose), `PATCH/DELETE /api/network/agents/:id/memory/:mid`, `POST /api/network/agents/:id/memory/:mid/approve`, `GET /api/network/agents/:id/memory/preview`; the same under `/api/network/networks/:id/memory`; `GET/POST /api/network/agents/:id/posts`, `PATCH/DELETE /api/network/agents/:id/posts/:pid` |
| 05 | `DELETE /api/network/networks/:id`, `POST /api/network/networks/:id/duplicate` |
| 06 | `GET/PATCH /api/network/settings`; `POST/GET /api/network/jobs`, `GET /api/network/jobs/:id`, `POST /api/network/jobs/:id/cancel`, `POST /api/network/jobs/:id/approve`, `POST /api/network/jobs/:id/retry`, `POST /api/network/jobs/:id/close`, `DELETE /api/network/jobs/:id` (terminal only) |
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

## 13. Dependencies (checked 2026-10-26 with `npm view`; nothing installed)

| Package | Decision | Version (published) | License | Size | Notes |
|---|---|---|---|---|---|
| `cytoscape` | **Use** (Task 05) | 3.34.3 (2026-09-07) | MIT | 5.7 MB unpacked; `dist/cytoscape.min.js` 435,503 B (137 KB gzip) | No dependencies. UMD `dist/cytoscape.min.js` served by exact path `/vendor/cytoscape.min.js` (like xterm, `src/server.mjs:82-88`) and loaded with a `<script defer>`; ESM build exists but the app uses classic scripts. The bundle has no `eval`, `new Function`, workers or network calls, but inserts one `<style>` element (`.__________cytoscape_container{position:relative}`) unless an element with id `__________cytoscape_stylesheet` exists; the CSP (`style-src 'self'`) would block it. Put that rule in `styles.css` and an empty `<meta id="__________cytoscape_stylesheet">` in `index.html`. Never relax the CSP. 3.34.4 (2026-10-15) is too new. |
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
