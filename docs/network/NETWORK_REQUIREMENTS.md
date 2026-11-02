# Promptboard Network — Agreed Product & Engineering Specification

**Approved direction, October 26, 2026.** Build `Network` as Promptboard's fifth main page (`Origin · Compose · Kanban · Base · Network`). Inspired by the useful parts of Flocker.md (persistent profiles, role documentation, memory, status/activity feeds, tasks, teams, connected agents). This is NOT a Flocker dependency or clone.

## Product outcome

The owner can configure agents once in Base and register them in Network, build visual graphs and nested sub-networks, compose executable pipelines, run general-purpose jobs outside Kanban, monitor live agent activity, give authorized agents ways to collaborate, and expose jobs to outside applications by private REST/MCP. Extend to limited A2A federation after local reliability.

## Current-code facts to preserve

- Plain Node.js ES modules + plain JavaScript DOM frontend; no mandatory SPA rewrite or separate backend. `public/index.html`, `public/app.js`, `public/base.js`, `public/styles.css`; `src/server.mjs`, `src/base.mjs`, `src/board.mjs`, `src/store.mjs`, `src/supervisor.mjs`, `src/session-activity.mjs`, `src/agents.mjs`.
- Base kind `profile` = **Agent** definition. Base kind `agentProfile` = **deployable composition** with primary/supporting agents and references. Do NOT introduce a parallel definition of model/skills/tool settings. Network registrations reference stable Base IDs.
- Existing Kanban is authoritative for coding cards, Git branches/worktrees, review/test/merge. The new general Job Engine does not replace Kanban; it may reference or create authorized Kanban cards using existing Board APIs.
- Existing project-specific approved **Project Memory** and coordinator are authoritative for their scopes. Do not create another conflicting copy. Extend with separately scoped agent/network memory when warranted.
- Provider lifecycle hooks and activity coverage differ. Claude/Gemini tool-level observation can be available; Codex may be less observable. `unknown` is preferable to false 'idle/done'. Existing request token, origin/host, paired-device and Docker sandbox safeguards must remain intact.
- Promptboard already supports scheduled **Kanban** cards; build general Network Job schedules by adapting patterns rather than duplicating a competing scheduler.
- Repo updates continuously. Verify current files, tests, and state schema before coding. These documents specify behavior, not guaranteed line numbers or an immutable current state.

## Domains and invariants

1. **Base Agent** = one definition in Base; may be used by many network registrations or jobs. One registration `agentId` references a valid Base `profile` or `agentProfile` `baseResourceId`.
2. **Network** = reusable container and Graph topology, with agent or nested-network nodes; a Graph edge represents an allowed relation (e.g. delegation or information-sharing), **not execution order**. No implicit data sharing from a visually drawn edge.
3. **Pipeline** = directed execution DAG, with `agent`, `subnetwork`, `condition`, `parallel`, `join`, `approval`, `output` node kinds as appropriate. Dataflow/dependencies are explicit. No arbitrary cycles; only explicit bounded retry attempts; all step inputs/outputs scoped.
4. **Network Job** = general-purpose work without a mandatory Git repo/card. Job records have durable IDs, state machine, immutable accepted request/config snapshot, events, outputs, and exact worker ownership. No side-effect replay when previous outcome is uncertain.
5. **Network Run** = one pinned published Pipeline revision with exact nested versions. Editing a network/pipeline does not change an active run.
6. **Agent/Network Memory** = approved, scope-labeled documents/lessons; exclude credentials and avoid blindly concatenating transcripts. Existing `Project Memory` remains separate, with permissioned access to related lessons.
7. **External client** = separately authenticated/scoped principal, NOT a paired-device owner; can only access explicitly granted agents, networks, or jobs. Do not let MCP tool annotations, agent prompts, or Graph edges override server-side authorization.
8. **Federated agent** = remote A2A peer discovered from an explicitly trusted Agent Card and permitted endpoint. Never assume remote tool visibility, full memory, run-control, or trustworthy results.

## Proposed canonical models (names may be adapted to match current code)

- `AgentRegistration {id, baseResourceId, displayName?, tags, capabilities, enabled, projectAllowlist, revision}`. No copied `model`, `provider`, `tools`, or prompts.
- `NetworkDefinition {id, name, description, revision, nodes:[{id,type,agentId?|networkId?|versionId?,position}], edges:[{id,from,to,relation}], ...}`; published immutable revisions for stable reuse.
- `PipelineDefinition {id, networkId, draftRevision, publishedVersionId, nodes:[{id,type,config}], edges:[{from,to,outputPort?,inputPort?}]}`.
- `Job {id, source, agentId?, projectId?, networkId?, pipelineVersionId?, parentJobId?, idempotencyKey?, status, attempts, permissionSnapshot, limits, createdAt, updatedAt, workerRunRef?, artifactRefs}`.
- `NetworkEvent {seq,id,at,type,agentId?,jobId?,runId?,pipelineRunId?,status?,message?,artifactRef?}`. Keep events bounded, redacted, searchable by ID/cursor.
- `MemoryRecord {id, scope:{agentId?|networkId?|projectId?},kind,textRef,sourceRef?,approved,revision}`.

Normalize and validate all inputs; prefer strict schemas and CAS/expected revisions. Assign one source of truth to each entity and store artifacts separately from metadata. Export/import metadata without credentials, execution leases, runtime sessions, or private document bodies unless explicitly and safely selected.

## User experience

- Page `#/network` with **Agents**, **Graph**, **Pipelines**, **Activity**, **Library**, **Federation** (visible only once functional or clearly marked unavailable).
- Agents: search, profiles, provider/availability, Base link, tasks, activity, memory, project scopes, quick job submission; no redundant Base editor.
- Graph: pan/zoom, add from Base, make network, nest network, connect typed relations, collapse/expand, save/publish revisions, search/filter; huge graphs use lazy expansion and render only the relevant level. Graph save is inert.
- Pipelines: use same visual language but distinguish **execution** edges; dry-run / validate / publish / run; step states overlay while running; unambiguous approvals and outputs.
- Activity: live state with provider coverage notes, waiting/unknown distinguishable, event feed, job/revision drill-down, optional costs only where actually reported.
- No new top-level framework required. Cytoscape.js (locally bundled, no CDN) is a reasonable candidate for Graph/Workflow canvas with compound nodes and edgehandles. Verify dependency/version/security before adding it.

## Security and execution

- Default local-only. Dedicated scoped machine/agent credentials for external APIs; hashed at rest and revocable. No unrestricted access to existing admin/session tokens. No internet listener without explicit owner opt-in.
- Job workers run in explicitly scoped temporary workspaces, with tool access from trusted Base resources and the provider's enforced permissions. Read-only/default-restricted behavior must be capability-verified; otherwise refuse. No implicit access to home, unrelated repo, other agent/project memory.
- Shared scheduling enforces a configurable global concurrency ceiling and per-run time/step/token/budget limits (where enforceable); hard stop where supported, otherwise transparently report uncertainty.
- Durable owned execution means queue/claim/complete are atomic, but **external side effects are not guaranteed exactly-once**. Never auto-resubmit after uncertain outcome; require operator decision.
- Every delegated task, external message, publication, and credential access is policy checked on the server. No free-form dynamic code evaluation for pipeline conditions.
- Treat A2A URLs as SSRF-sensitive: restrict schemes and hosts, protect redirects/DNS resolution, allowlist trusted endpoints, redact credentials. A2A is not a generic remote-control API.

## MVP demonstration (must pass before federation)

1. Register a reusable Base Agent. Find it on Network page, use it in 2 private networks, restart app, see same ID and scopes.
2. Create a Graph containing two Agents and a nested network, publish version 1, edit a draft without changing version 1, reject a recursive containment loop.
3. Build/publish Pipeline: two independent research steps in parallel → join → reviewer → human approval → saved report. Run it with fake CLIs; verify live statuses, durability, output, cancellation/restart behavior, and no duplicate runs.
4. Call private REST/MCP from an external local client to create an authorized job; receive a job ID; poll/stream its lifecycle and fetch the result. Deny unauthorized project/memory access.
5. Use a real signed-in CLI for one opt-in smoke test if available. Offline simulated tests alone do not prove live-provider parity.
6. No regression to Base, Compose, Origin, Kanban, Docker sandbox, project lessons, native session recovery, or paired-device access.

## Scope guardrails

- Build a genuinely useful small/medium agent-network product before large federation.
- **No Redis, Kafka, Kubernetes, separate microservices, graph database, generic multi-tenant cloud SaaS, cryptographic agent passports, arbitrary self-writing skills, or agent social feed.**
- Support many saved networks and large canvases without artificial tiny product caps; bounded accepted payload sizes, graph expansion, concurrency, and budgets are safety/resource limits, not paid-plan product restrictions.
- Remote workers across owned machines and multi-host distributed scheduling are **post-MVP extensions**. A2A federation provides controlled communication with independent remote peers, not a promise to control their OS processes.

## Reference docs

- Promptboard: https://github.com/datasound-projects/Promptboard ; relevant `docs/base-delivery.md`, `docs/project-memory.md`, `docs/pipeline-activity.md`, `docs/session-persistence.md`, `docs/schedules.md`, `docs/docker-sandbox.md`, `SECURITY.md`.
- A2A official: https://a2a-protocol.org/latest/ and official JS SDK https://github.com/a2aproject/a2a-js (A2A 1.x).
- MCP official TypeScript v2: https://ts.sdk.modelcontextprotocol.io/v2/ . Repo currently uses `@modelcontextprotocol/client` v2; inspect and choose a compatible server package rather than outdated v1 examples.
- Cytoscape.js: https://js.cytoscape.org/ and https://github.com/cytoscape/cytoscape.js-edgehandles .
