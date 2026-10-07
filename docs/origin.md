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

## Using Origin

- Open **Origin** in the top navigation. It plans the project selected in Kanban; the header selector switches projects for both pages.
- Without a blueprint, describe the product or choose **Start manually**. **Open existing repository** uses Kanban's folder picker. **Import project context** reads a blueprint exported from Origin (JSON). With no projects at all, Origin can create one, exactly like Kanban → New project.
- The navigator lists the 15 sections with their state. Arrow keys, Home and End move between sections. Data, AI / Agents, Deployment and Observability can be marked not applicable.
- Records open inline. Escape closes an editor, the inspector drawer or connect mode. Delete asks for confirmation and removes every link to the deleted record.
- Changes save automatically about a second after you stop typing (and at least every few seconds while you keep typing). The header shows **Saved**, **Unsaved changes**, **Saving…**, **Not saved** (with Retry) or **Changed in another window** (with **Reload saved version** or **Keep mine**). ⌘/Ctrl+S saves immediately. Leaving the page or switching projects saves first.
- The diagram supports click to select, double-click or Enter to edit, drag or arrow keys to move, **Connect** (choose the dependent component, then its dependency) and **Auto-arrange** by dependency level. Positions are stored on the components; the records stay the source of truth.
- The inspector shows details and relationships of the selected record, or overall intelligence: unresolved decisions, open assumptions, unverified claims, conflicts, missing information, recorded risks and suggestions. On narrow screens it is a drawer opened from the header.

## Handoffs

- **Send to Compose** (requirements, components, decisions, milestones and implementation items) fills the Compose request with that item, its direct relationships, accepted decisions that apply to it, its evidence and the project's constraints and out-of-scope list. Compose waits for you to review and choose Generate. An existing Compose draft is replaced only after a second, explicit confirmation.
- **Create Kanban tasks** (Implementation Plan) creates one To Do card per selected item through the normal task API, dependencies first, then milestone and plan order. Each card prompt contains the item, its acceptance criteria, linked requirements with their criteria, components, dependencies, the milestone's definition of done and `Origin reference: IMP-00n (origin item <id>)`. The blueprint records the created card ID. No agent starts and no new board field is used. Creating cards for an item again adds another card.

## Base

AI / Agents items can reference Base resources by ID. Origin reads the Base list only when that section needs it; it never creates, copies, changes or assigns Base resources. A reference to a deleted resource is shown as missing and kept until you remove it.

## Limits

- AI research, AI suggestions and AI proposals are not implemented. The data model already distinguishes `human`, `ai` and `system` origins, and AI suggestions never count as blocking. All current issues are deterministic checks.
- Origin does not fetch sources. You open a source, check it and set its verification and access date. A failed or unsafe URL is never followed by the app.
- One blueprint per project, edited from one window at a time; a second window gets a revision conflict instead of overwriting.
- Board backups do not include blueprints, and blueprint files of deleted projects stay in `origin/`.
- There is no undo history. Export the blueprint before large changes.
