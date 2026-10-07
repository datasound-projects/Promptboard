# Origin — project blueprints

Origin is the planning layer before Compose and Kanban. It stores a structured **project blueprint** for each Promptboard project: requirements, architecture components and their connections, technologies, dependencies, decisions, assumptions, sources and the implementation plan. The blueprint is the source of truth; diagrams, readiness and issue lists are views computed from it.

## Storage

- One file per project: `<data folder>/origin/project-<project id>.json`. The data folder is the same one that holds `state.json` (on macOS `~/Library/Application Support/Promptboard`).
- The file name comes only from the validated project ID (`[A-Za-z0-9_-]{1,100}`). Uppercase letters and `_` are escaped (`A` → `_a`, `_` → `__`) so IDs that differ only in case never share a file on case-insensitive file systems.
- Origin never writes `state.json`, never changes the board state version (still 12) and never writes Base, session, backlog or journal files. Main-branch Promptboard ignores the `origin/` folder, so you can switch versions without migration.
- Writes are serialized and atomic (temporary file, fsync, rename). The previous good file is kept as `….json.bak`.
- A missing file means “no blueprint yet”. A damaged file is renamed to `project-<id>.corrupt-<time>-<random>.json`; the last good backup is used when it is valid, otherwise Origin starts empty and says so. A file from a newer Origin version is refused and never overwritten.
- Saves are revision-checked (`expectedRevision`). A save from a stale window is refused instead of overwriting newer work.
- Deleting or renaming a project does not touch its blueprint. A deleted project's blueprint file stays in `origin/` as an orphan; you can delete it by hand.
- Board backups (Kanban **Export**) do not include blueprints. Use Origin's **Export blueprint** to save a copy.

## Schema (version 1)

```text
OriginFile   { schema: "promptboard.origin", version: 1, projectId, revision, createdAt, updatedAt, blueprint }
Blueprint    { idea, vision, sections, sequence, requirements[], components[], connections[], technologies[],
               dependencies[], decisions[], assumptions[], sources[], risks[], areas[], milestones[], items[] }
```

Every record has a stable `id` (`[A-Za-z0-9_-]{1,100}`) and an `origin`: `human` (entered in the page), `ai` (AI suggestion) or `system` (reserved for detected records). Relationships are stored as ID lists, never as copied text. Unknown fields are dropped, invalid values fall back to safe defaults and references to missing records are removed on load and save.

| Entity | Fields |
| --- | --- |
| Vision (`vision`) | summary, problem, goal, users, useCases, inScope, outOfScope, successCriteria, constraints, architectureSummary |
| Blueprint section (`sections`) | per optional section (Data, AI / Agents, Deployment, Observability): `notApplicable` |
| Requirement | key (`REQ-001`), title, description, type, priority, status, acceptanceCriteria, componentIds, sourceIds |
| Architecture component | name, type, purpose, responsibilities, technologyIds, interfaces, dataHandled, status, notes, sourceIds, x, y |
| Connection | from (component), to (component), label (for example “calls”), protocol (for example “HTTPS”), notes. “Depends on” and “Used by” are derived from connections. |
| Technology | name, category, purpose, version, status (candidate, selected, rejected), reason, alternatives, sourceIds |
| Dependency | name, type, version, requiredBy (components), dependsOn (dependencies), sourceIds, notes |
| Decision (ADR) | key (`ADR-001`), title, context, decision, alternatives, reason, consequences, status (proposed, accepted, superseded, rejected), date, supersededBy, componentIds, technologyIds, requirementIds, dependencyIds, sourceIds |
| Assumption | statement, reason, impact, status (open, validated, invalid, converted), decisionId, sourceIds |
| Source | title, url (http/https only, no credentials), type, claim, accessedAt, verification (verified, unverified, outdated, conflicting), notes |
| Risk | title, description, kind (risk, conflict, missing information, unverified dependency, unresolved decision), severity, mitigation, status, componentIds |
| Planning item (`areas`) | section (data, ai, security, testing, deployment, observability), area, title, description, status, componentIds, requirementIds, technologyIds, baseResourceIds |
| Milestone | title, goal, definitionOfDone (order is the array order) |
| Implementation item | key (`IMP-001`), milestoneId, workstream, title, description, acceptanceCriteria, dependsOn (items), requirementIds, componentIds, status, handoff (`{ projectId, taskId, at }` after a Kanban handoff) |

`sequence` keeps the last issued REQ/ADR/IMP number, so deleted keys are not reused.

Item statuses: **In progress**, **Defined**, **Needs decision**, **Based on an assumption**.

## Status semantics

Statuses describe stored project state. Origin has no confidence percentages or quality scores.

- **Verification** of a technology, dependency, requirement or decision is derived from its linked sources: **Conflict** if a linked source is conflicting, **Verified** if a linked source is verified, **Outdated** if the only evidence is outdated, otherwise **Unverified**. A URL never verifies anything by itself; a person marks a source verified after checking it.
- **Issues** are deterministic checks over stored records (each names its rule): missing information, unresolved decisions, unverified technologies and dependencies, conflicts (conflicting evidence, duplicate entries, dependency cycles, plan items scheduled before their dependencies) and recorded risks. System-detected issues, human-entered risks and AI suggestions are labelled separately; Origin does not read meaning from free text.
- **Section state** in the navigator: ✓ Defined, ● In progress, ! Needs attention, ? Decision required, ○ Not started, – Not applicable.
- **Readiness** shows counts (for example “3 / 4 defined”, “2 unresolved”) and one state: Not started, Needs attention (with the reasons), Ready for task decomposition, or Ready for implementation.
