# Origin — project blueprints

Origin is the planning layer before Compose and Kanban. It stores a structured **project blueprint** for each Promptboard project: requirements, architecture components and their connections, technologies, dependencies, decisions, assumptions, sources and the implementation plan. The blueprint is the source of truth; diagrams, readiness and issue lists are views computed from it.

## Projects

- An **Origin project** has its own stable ID, a name, an optional description and an optional link to one Kanban project. It does not need a Kanban project.
- **New project** asks for a name, an optional description and one option: **Also create a Kanban project and Git repository** (on by default, as before). With it on, the Kanban project is created through Kanban's normal project and repository service and linked. With it off, nothing is created on the board, no repository folder and no Git repository.
- If creating the Kanban project fails (for example its name is already used), the Origin project is kept and the page says why. **Connect to Kanban** (project menu or the link pill in the header) links an existing Kanban project or creates a new one. The destination is shown before anything is linked; projects are never linked because their names match. One Kanban project belongs to at most one Origin project.
- Origin's project selection is its own; it does not follow the project selected in Kanban.
- **Delete from Origin** (project menu) removes the Origin project after one confirmation. Its linked Kanban project and tasks stay. Removing the Kanban project too is a separate checkbox; it uses Kanban's own deletion checks, so running work or task worktrees block it and nothing is removed. Repository folders and worktrees are never deleted. A deleted project cannot be recreated by a stale save from another window.

## Storage

- One file per Origin project: `<data folder>/origin/blueprint-<origin id>.json`. The data folder is the same one that holds `state.json` (on macOS `~/Library/Application Support/Promptboard`).
- File names come only from validated IDs (`[A-Za-z0-9_-]{1,100}`). Uppercase letters and `_` are escaped (`A` → `_a`, `_` → `__`) so IDs that differ only in case never share a file on case-insensitive file systems.
- Origin never writes `state.json`, never changes the board state version and never writes Base, session or journal files. Kanban projects are created or removed only through the board service.
- Writes are serialized and atomic (temporary file, fsync, rename). The previous good file is kept as `….json.bak`.
- A damaged file is renamed to `blueprint-<id>.corrupt-<time>-<random>.json` and the last good backup is restored and reported. Without a good backup the project is kept aside and not shown. A file from a newer Origin version is refused and never overwritten.
- Saves are revision-checked (`expectedRevision`). A save from a stale window is refused instead of overwriting newer work.
- **Delete from Origin** moves the file to `origin/deleted/`. Linked Kanban cards and every snapshot stay.
- Approved task context is saved once per send or update as `origin/snapshots/<origin id>/<snapshot id>.json` and never changed or pruned, so a card's history can always be read back.
- **Two different backups.** A Kanban backup (Kanban **Export**) holds the board: every card with its saved prompt (the task's words and the context it was sent with), its Origin reference (`originSource`) and its prerequisites (`dependsOn`); cards stay usable without Origin. It does not hold Origin projects or snapshots. For a full Origin backup, copy the `origin/` folder (projects, snapshots, `deleted/` and `migration.json`) while the app is stopped.

### Upgrading from version 1, and rolling back

Version 1 stored one blueprint per Kanban project in `origin/project-<kanban project id>.json`. On the first start of version 2, each valid version 1 file is copied once into an Origin project **with the same ID**, linked to that Kanban project when it still exists. Every record ID, `REQ`/`ADR`/`IMP` key, link and milestone order is kept. `origin/migration.json` records the upgrade, so it never runs again; a migrated project you delete later is not brought back. Damaged version 1 files, and empty ones whose Kanban project no longer exists, are skipped and listed there. A blueprint whose Kanban project is gone is named after its idea.

The version 1 files are left unchanged. To roll back, run the previous Promptboard version: it reads the version 1 files as they were at the upgrade and ignores the version 2 files. Changes made after the upgrade (new projects, edits, links) exist only in the version 2 files and are not visible to the older version.

Rolling back to a release from before tasks, handoff and change review: copy the `origin/` folder first. Kanban keeps every card and its prompt; an older version ignores `originSource` and `dependsOn` (so it no longer checks prerequisites before a start) and drops them from new backups. An older Origin drops task fields it does not know (such as `lostLinks`, `keptHash` or newer **Also include** links) the next time it saves, and the board state version (12) is unchanged, so no board migration is needed either way.

## Schema (version 2)

```text
OriginFile   { schema: "promptboard.origin", version: 2, originId, project: { name, description, kanbanProjectId }, revision, createdAt, updatedAt, blueprint }
Blueprint    { idea, vision, sections, sequence, labels, customSections[], questions[], answers, questionText, layers[],
               requirements[], components[], connections[], technologies[], dependencies[], decisions[], assumptions[], sources[],
               risks[], areas[], milestones[], items[], layout }
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
| Layer | name, description, technologyIds (its stack), constraints (shared rules) |
| Task (`items`) | key (`IMP-001`), title, description (what to do), acceptanceCriteria (done when), componentIds, layerId (only for a task without components), milestoneId, dependsOn (prerequisites), requirementIds, contextIds, workstream, status (kept, not shown), handoff, refinement, lostLinks (`{ collection: "components", name }` notes left by removed components) |

`sequence` keeps the last issued REQ/ADR/IMP number, so deleted keys are not reused.

Task details: `handoff` is `{ projectId, taskId, at, snapshotId, hash, keptHash }` once the task has a card (`hash` is the context it was sent with; `keptHash` the newer context you chose to keep without updating), `refinement` is `{ proposal, proposedAt, basis, originalDescription, acceptedAt }`, and `contextIds` lists records linked under **Also include** (`{ collection, id }`, collections: decisions, technologies, dependencies, areas, sources, assumptions, risks, customSections).

```text
Snapshot     { schema: "promptboard.origin-snapshot", version: 1, id, originId, itemId, key, revision, createdAt, instruction, context, body, included[], omitted[], hash }
Kanban card  …existing fields, plus optional originSource { originProjectId, originTaskId, snapshotId, hash, key } and dependsOn [card ids of the same project]
```

Item statuses (under **More details**): **In progress**, **Defined**, **Needs decision**, **Based on an assumption**. A requirement is complete when it has a “done when”; a component when it says what it does.

## Status semantics

Statuses describe stored project state. Origin has no confidence percentages or quality scores.

- **Verification** of a technology, dependency, requirement or decision is derived from its linked sources: **Conflict** if a linked source is conflicting, **Verified** if a linked source is verified, **Outdated** if the only evidence is outdated, otherwise **Unverified**. A URL never verifies anything by itself; a person marks a source verified after checking it.
- **Issues** are deterministic checks over stored records (each names its rule): missing information, unresolved decisions, unverified technologies and dependencies, conflicts (conflicting evidence, duplicate entries, dependency cycles, plan items scheduled before their dependencies) and recorded risks. Missing evidence is always shown but is advisory: it does not block readiness on its own. System-detected issues, human-entered risks and AI suggestions are labelled separately; Origin does not read meaning from free text.
- **Section state** in the navigator: ✓ Defined, ● In progress, ! Needs attention, ? Decision required, ○ Not started, – Not applicable.
- **Readiness** shows counts (for example “3 / 4 defined”, “2 unresolved”) and one state: Not started, Needs attention (with the reasons), Ready for task decomposition, or Ready for implementation.

## Using Origin

- Open **Origin** in the top navigation. The header shows the Origin project, its menu (Rename, Connect to Kanban, Delete from Origin), a pill with its Kanban link and **New project**.
- With no Origin projects yet, Origin asks for a name, what you want to build and the Kanban option, then opens the project map. There is no import: every blueprint starts in Origin.
- The sidebar groups the 15 sections by phase: Define, Design, Operate, Decide, Build. Each shows a state dot and a count. Arrow keys, Home and End move between sections. Data, AI / Agents, Deployment and Observability can be marked **Not needed for this project**.
- **In your own words.** Hover a phase, a section name or a question and use the pencil to reword it for this project: Enter saves, Escape cancels, and an empty field brings back the built-in wording. The **+** beside a phase adds a section of your own with a title, a description and questions. **＋ Add a question** adds a question to any section; in the component editor it adds a question asked for every component, each component keeping its own answer. Answers are stored under the question's ID, so rewording never moves an answer to another question, and a question with an answer is deleted only after a second click. Wording changes only what you see: checks, readiness and handoffs follow the built-in IDs. Your own sections can be marked **Not needed for this project** and appear on the map. They are not added to every task on their own.
- The **Overview** is a mind map of the blueprint. Branches open their section; leaves open their record. Drag a branch or the project in the middle (or focus it and use the arrow keys) to move it; a click without movement still opens it. Places are saved per project and survive reloads, renames and project switches; new sections take a built-in place without moving anything. **Link** draws a dashed, optionally labelled link between two branches: it is only a picture and never means a dependency, a connection or a build order. **Arrange** asks once, then puts every branch back in its built-in place and keeps your links. **−**, **+** and **Fit** zoom (Ctrl/⌘ with the wheel or a trackpad pinch also zooms), and dragging the empty background pans; the view is not saved. The corner handle resizes the map (arrow keys resize it too, Home goes back to automatic); its size is saved per project and stays within the screen on small devices. **Next steps** lists blocking points first, then advice; **At a glance** shows the readiness counts.
- List sections add an entry when you type a line and press Enter, and keep focus there for the next one. Clicking an entry opens the side editor: essentials first, the rest under **More details** (that choice is remembered). Escape closes it. Delete asks for a second click and removes every link to the deleted record.
- Security, Testing, Data, AI / Agents, Deployment and Observability list their topics with one answer field each. Typing creates the entry; clearing an answer without details removes it; **⋯** opens its details.
- Each section shows one **Next** hint taken from the checks, with a link to the record.
- Changes save automatically shortly after you stop typing (and at least every few seconds while you keep typing). The header shows **Saved**, **Editing…**, **Saving…**, **Not saved** (with Retry) or **Changed in another window** (with **Reload saved version** or **Keep mine**). ⌘/Ctrl+S saves immediately. Leaving the page or switching projects saves first.
- **Tasks** (under Build; internal ID `plan`) is where work is prepared. **By layer** lists project-wide tasks first, then each layer with its stack and its components' tasks plus tasks for the whole layer, then components without a layer. **All tasks** is one list in plan order showing where each task lives; the milestone filter narrows both views. A task needs only a title; its editor shows **What to do** and **Done when** first and keeps components, layer, milestone, prerequisites (**Starts after**, the only thing that sets build order), requirements and **Move up**/**Move down** under **More details**. A task lives with its first component, which decides its layer; a task without components can belong to a layer or to the whole project. Each component's editor lists its tasks and adds one with the component already linked. Removing a component keeps its tasks and shows **Link missing** until you relink or dismiss it. Rows show **Draft** or the Kanban card and its current column, read from Kanban; Origin never marks work as done itself. Milestones stay available below the list.
- **Layers** (in Architecture) are optional groups such as Frontend, Backend or Data. Each has a stack (selected technologies; candidates stay marked as candidates) and shared rules. Pick a component's layer in its editor; deleting a layer keeps its components and tasks.
- The architecture canvas supports zoom, Fit and panning like the map, keeps the view still while you move a block, and supports click to edit, drag or arrow keys to move, **Connect** (choose the starting block, then the block it connects to) and **Arrange** by dependency level. Connections are named in the block's editor. Positions are stored on the components; the records stay the source of truth.

## Task context

One builder (`taskContext` in `public/origin-model.js`, served by `POST /api/origin/projects/:id/context`) decides what a task carries, for the preview, for Kanban and for Compose. It is local and deterministic; no model is called to build, preview or send it.

- The task's own words come first, exactly as written: title, **What to do**, **Done when**. Context follows under its own heading as reference material, not further instructions.
- Always included: the project's purpose, in-scope list, **out of scope** and **constraints**.
- From the task's links: its components (purpose, responsibilities, interfaces, data, technologies and their answers to your component questions), one hop of their connections with the neighbours' interfaces, the layer of each component (or the task's own layer) with its stack and shared rules, linked requirements with every acceptance criterion, prerequisites (**Starts after**), accepted decisions that apply to those components, requirements, technologies or dependencies, dependencies with their verification state, linked testing and planning answers (not from sections marked not needed), open risks on those components, the milestone's definition of done, and the evidence behind included records with its verification state.
- Project-wide quality requirements (non-functional, security, performance, operational, linked to no component) apply to every task. Everything else must be linked; **Also include** under More details adds decisions, technologies, dependencies, planning answers, sources, assumptions, risks or your own sections. Nothing is guessed.
- Selected technologies are named; candidates are marked “candidate — not decided”; rejected ones are left out. Assumptions are labelled as assumptions; open decisions and conflicts (the task mentions a rejected technology, or an alternative an accepted decision did not choose) are shown as warnings, never resolved.
- Records are deduplicated by ID and only one hop is followed. Positions and labels never change the context. Recognizable secrets (keys, tokens, passwords, private keys, credentials in URLs) are removed from the context part; if the task's own text looks like it holds a secret, a warning asks you to remove it.
- The context is capped at 60,000 characters. Optional parts are dropped first and named under “Left out for size”; acceptance criteria, constraints, out of scope, shared rules and accepted decisions are never cut. If those alone exceed the cap, the task cannot be sent and the message says how to narrow it.
- **Context included** in the task editor shows the readable names, warnings and the exact text, built from the saved revision; it says when the preview is out of date.
- Each built context has a hash over the instruction and the context only, so it changes when what the task would receive changes. When a task is sent, its approved context is saved as an immutable snapshot in `origin/snapshots/<project>/<snapshot>.json` (instruction, context, included records, hash), because references alone cannot rebuild an older revision.

## Handoffs

- **Send to Compose** (requirements, components, decisions, milestones and tasks) fills the Compose request with that item, its direct relationships, accepted decisions that apply to it, its evidence and the project's constraints and out-of-scope list. Compose waits for you to review and choose Generate. An existing Compose draft is replaced only after a second, explicit confirmation.
- **Send to Kanban** (Tasks; one or several selected tasks) saves pending edits, then shows one review panel: the destination (the linked Kanban project, or the connect dialog first), each task as **New card**, **Already Kanban #n** or **Card deleted in Kanban**, its context summary and warnings, and any prerequisites that have no card yet. Those are never left out or added silently: **Include prerequisites** adds them, otherwise sending waits; a deleted card is created again only with **Create it again**. **Send N tasks** asks the server (`POST /api/origin/projects/:id/handoff`) to rebuild each context from the saved revision, save its snapshot, and create the cards in one board write — prerequisites first, in the board's To Do role (or the legacy To Do column), each with an execution-ready body (the task's own words exactly, then its context) and its Origin identity (`originSource`: Origin project and task, snapshot, hash, key) and prerequisite cards (`dependsOn`). A card that already has the same Origin identity is returned instead of a new one, so repeated clicks, retries, reloads and concurrent requests never duplicate it; a changed blueprint revision is not a reason to create another. The results list created, existing and failed tasks separately; created cards are never removed automatically, and **Retry the failed tasks** sends only those. If the Origin side missed recording a card (for example after an interruption), the next send restores the link from the card. Nothing starts: no agent, column automation, script, webhook or worktree.
- **Improve with Compose** (optional; a task's editor, or several selected tasks) never replaces Send to Kanban. For one task it fills Compose with the task's own words and its context (an existing Compose draft is replaced only after a second click) and shows **From Origin · IMP-00n** there; after you choose Generate, **Use in Origin task** brings the result back and **Back to Origin** returns without it. A prompt that belongs to an Origin task is never split automatically. For several tasks, Origin runs them one at a time with your current Compose settings and job slot, with progress and Cancel; finished proposals are kept if you cancel or the CLI fails. Every result arrives as a **Proposal from Compose** on the same task: edit it, **Use as What to do** (the earlier text is kept and can be restored; Done when, links and IDs are untouched) or **Reject**. A proposal never overwrites your text on its own and is marked when the task changed after it was made. Compose's source access, research and MCP settings are not turned on by Origin, and no repository is read or changed. Nothing is sent to Kanban.
- **Suggest tasks** (beside a component, a layer or Project-wide) asks the Compose split service, with your Compose settings, for tasks based only on that part of the design (the same context builder; never the whole blueprint), and tells it to leave missing choices as tasks to decide. Suggestions are shown first; edit their titles, untick the ones you do not want, optionally make each start after the one before, then **Add selected**. Nothing is called when you open or edit the blueprint.
- In Kanban, a card with prerequisites shows **Waits for #n** until they are done, and its details list them. Leaving To Do (legacy boards) or entering an agent column (column pipelines) is refused with the reason while any prerequisite is not in Done, is part of a loop, or was deleted; manual and automatic starts are checked the same way, and nothing is merged to satisfy a prerequisite. **Remove prerequisite** (or **Clear** for a deleted one) is the only way to change the list. **Duplicate** makes a new card that keeps the prerequisites but not the Origin identity. Board backups keep both fields.

## When the design changes

The saved blueprint is the current design; each card keeps the context it was approved with.

- When Tasks open (and after each save), Origin rebuilds the context of every sent task from the saved design and compares its hash with the card's. Only relevant content counts, so moving the map, renaming labels or editing an unrelated task flags nothing. A changed task shows **Context changed**.
- Its editor lists what was added or is no longer included (a deleted record is named, never replaced by something else) and **Compare** shows the sent and current text side by side. Then choose:
  - **Update context** gives the card the current context. It is checked again first: the design and the card must be exactly what you reviewed, the card must be idle in To Do (stop its work and move it back otherwise), and a prompt edited in Kanban is replaced only after a second, explicit click. A new snapshot is saved; earlier ones stay. Nothing starts.
  - **Improve again** opens the task in Compose with its current context.
  - **Keep current** leaves the card as it is; it is flagged again only if the context changes further.
- Kanban progress is only read through the saved link; Origin never rewrites your design from Kanban.

## Safety boundaries

- Building, previewing and sending tasks is local and deterministic: no model call. Only **Improve with Compose**, **Suggest tasks** and Compose's own Generate call your CLI, and only when you start them, through Compose's services, limits and job slot.
- Handoff creates idle To Do cards through the board service only: no agent, column automation, script, webhook or worktree. Agents receive the card's saved prompt through the existing delivery; moving a card between columns does not add the context again.
- Every route checks the session token, validated IDs (`[A-Za-z0-9_-]{1,100}`), revisions and size limits (4 MB request bodies, 100 tasks per request, 50 prerequisites per card, a 60,000-character context). User text is stored and shown as text.
- Secrets that look like keys, tokens, passwords, private keys or credentials in URLs are removed from task context; Base resources are never assigned by Origin.

## Base

AI / Agents items can reference Base resources by ID. Origin reads the Base list only when that section needs it; it never creates, copies, changes or assigns Base resources. A reference to a deleted resource is shown as missing and kept until you remove it.

## Limits

- AI research is not implemented, and all issues are deterministic checks. Proposals and suggestions come only from **Improve with Compose** and **Suggest tasks** (Compose's services), never on their own, and Origin does not read or change project repositories for them.
- Origin does not fetch sources. You open a source, check it and set its verification and access date. A failed or unsafe URL is never followed by the app.
- One blueprint per project, edited from one window at a time; a second window gets a revision conflict instead of overwriting.
- Board backups do not include blueprints. A project deleted from Origin moves to `origin/deleted/`; deleting a Kanban project leaves its Origin project in place, marked “Kanban project removed”.
- Per project: up to 50 own sections and 300 own questions. Phase and section names hold up to 60 characters (own section titles 80); questions up to 500.
- There is no undo history. Copy the project's file before large changes.
- One send covers up to 100 tasks; **Suggest tasks** returns at most 12. Snapshots are never pruned, so the `origin/snapshots/` folder grows with each send and update.
- A prerequisite counts as finished only when its card is in Done; Promptboard never merges anything to satisfy it.
