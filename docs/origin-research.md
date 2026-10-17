# Origin Research

Origin Research is an optional research workspace in the Origin page. It helps you complete your own blueprint: it
researches tools, architectures, technologies, dependencies and design choices for the parts you select, and it
suggests changes. **Nothing changes in the blueprint until you apply a suggestion.**

It uses the Claude Code or Codex CLI that you already installed and signed in to. It needs no other model service and no
API key. It never starts Kanban work.

## Using Research

1. In Origin, choose **Research** (beside **Create Context**). A panel opens on the right. On a new chat, it starts on the
   record that was open or the current section; change it in the **What to research** list.
2. Choose a mode:
   - **Chat**: one agent and a continuous conversation. Follow-up questions continue the same CLI session.
   - **Swarm**: add up to eight parts (sections, records or questions). Each part gets its own independent agent; three
     work at the same time. Stop one agent with its own **Stop**, or all with the main **Stop**.
   - **Decision Lab**: name two or three options (for example "PostgreSQL vs MongoDB"). You get one comparison table,
     one recommendation with its reasons, the other options and the open tradeoffs.
   - **Audit**: finds missing building blocks, conflicts, weak assumptions and security or dependency gaps, each with
     the exact part it affects.
3. Optional: turn on **Web search** (the globe) for this chat, or add **+ Sources**: a PDF, text or Markdown document
   (with a page range), a pasted excerpt, a Base knowledge, context or skill resource, or an MCP server (Context7, an
   HTTP server or a local program that you allow to start). Click a source chip to turn it off; × removes it.
4. Read the answer as it arrives. Sources are cited as [S1], [S2]; web pages show their URL and access date.
5. Review the suggestion cards: **Preview** shows the current and the suggested value (links by the names of the
   records they point to, new ones marked), **Edit** changes the suggestion, **Apply** writes it into the exact field,
   **Reject** discards it. Select several cards and use **Apply selected**, or **Apply all**.

**History** (the clock) lists this project's chats: search them, open one to continue, or delete one after
confirmation. Each chat is marked by color: **red** while suggestions wait to be applied (or have a conflict),
**green** once applied, **grey** when there was nothing to apply, **orange** when its latest run failed or its
suggestions could not be read. Every message, source, suggestion and its state is restored after a restart.

The panel resizes by dragging its left edge (or the arrow keys on the edge), maximizes up to the navigation sidebar,
minimizes to a small box and closes with Esc. The record editor, Project Context and Research share one panel: opening
one closes the others and keeps unsaved and unsent text. On phones the panel fills the screen.

## How it works

- **Context.** `researchContext` builds the context from the saved blueprint revision: the project's purpose, scope and
  constraints first (never cut), the selected part in full with stable `[collection id]` tags, linked records, accepted
  decisions, the selected stack, Origin's own open points, then the rest of the blueprint in brief while it fits
  (24,000 characters; 16,000 per swarm agent). Recognizable secrets are removed. Renamed and custom sections and
  questions need no code changes.
- **CLI runs.** `src/research-cli.mjs` starts Claude Code (`--print --output-format stream-json
  --include-partial-messages`) or Codex (`exec --json`) and reads their output line by line, so text and activity reach
  the page while the CLI works. Every run has no shell and no file writes (Claude `--tools` limited to the allowed
  tools; Codex `sandbox_mode="read-only"`, shell tools disabled, MCP servers from the user's configuration disabled).
  Chat sessions continue with `--resume` / `exec resume`; when a session cannot continue, one new session starts with
  the chat's recent history. Swarm agents leave no session behind.
- **One job at a time.** A research run uses the app's shared job slot, so it never overlaps Compose, the Coordinator,
  file proposals or a sign-in change. Closing the request (Stop, leaving, switching project) stops the CLI at once and
  keeps the text it produced.
- **Sources** are retrieved by the app, per question: Compose's document index and retrieval, Base `searchSources` and
  Compose's read-only MCP lookup (the server must expose one annotated read-only query tool, or be Context7). Only
  passages relevant to each agent's question are sent, bounded and cited. Text that looks like paths, URLs, code or
  contact details is never sent to an MCP server. The CLI gets no MCP tools of its own.
- **The project's own structure.** Research reads the structure the project has now. What it may research and where
  it may write come from the sections, topics and questions that exist: a deleted section, topic or Vision question is
  never offered, its records are never suggested, and a suggestion for one is refused. A run saves pending edits first,
  so a section added a moment ago is part of it. With the panel open, adding, renaming, moving or deleting a section
  updates its scopes at once. A suggestion whose section, topic, question or record was deleted after the research
  ran (also while it was running) is shown as no longer applicable with only **Dismiss**: nothing brings the removed
  part back. A project with no sections gets a chat answer and no suggestions.
- **Where to write.** Each run also gets instructions built from the saved blueprint for the selected part
  (`researchGuide`): the exact places its findings go, in the project's own names and IDs. For a section these are its
  vision fields or records (technologies for Technology, components, connections and layers for Architecture, …), every
  topic of Data, AI / Agents, Security, Testing, Deployment and Observability with its topic ID, the section's own
  questions, its description (own sections) and each block with the formats for its parts. A new block may be added
  when a finding fits nowhere else. Tasks are suggested only for the task plan (Build › Tasks) or when you ask. A whole-
  project scope lists every section with what it holds. Renamed and custom sections, questions and blocks need no code
  changes.
- **Suggestions** are checked against the saved blueprint by stable IDs (`validateResearchSuggestion`). They can change
  a field, answer a question, add links, or add a record of any type: layers, technologies, components, requirements,
  dependencies, milestones, tasks, decisions, assumptions, risks, sources, architecture connections, topic answers and
  blocks. They also fill blocks: a table cell, row or column, a Q&A answer or question, a checklist point, a flow step or
  arrow, a block title or notes text, and an own section's description. A topic answer has a one-line answer and its
  details; sections, topics, block types and table columns may be named by their words instead of their IDs. A new record can
  carry a short `ref`, and other new records in the same answer point to it as `@ref`; refs are local to one answer.
  The prompt lists the values Origin accepts for each choice field (built from the model, so it never drifts); common
  words agents use map to them (for example “frontend” → client, status “proposed” → candidate). A new record with an
  unknown value keeps Origin's default; a change to an existing field still needs a valid value.
  Only the last `origin-suggestions` block of an answer counts, so code examples earlier in the answer (JSON, JSONL)
  never cut it short; text after the block is kept and trailing commas are forgiven. An unreadable block is reported
  under the answer.
  The page applies an approved suggestion through Origin's normal edit path (autosave with its revision check), so the
  sidebar, editors, readiness, map and architecture diagram update as for a hand edit (`applyResearchSuggestion`).
  **Apply all** applies new records in dependency order (layers and technologies before components, components before
  tasks and connections), then resolves the links to records created later. A link to a record whose suggestion is
  applied later (even after a reload) is completed when that record is applied; links of suggestions you edited before
  applying are not, because the edit is not stored. A field that changed since the research
  ran is a conflict. Link lists are only added to, never removed from; a single link (layer, milestone, connection end) is
  replaced, and it is a conflict only when it changed after the research ran.

## Limits

- Claude Code and Codex only. Gemini CLI and Antigravity are not offered for research.
- Codex returns each answer as one complete message, so its text appears at once, not word by word.
- A research run cannot start while Compose, the Coordinator or a sign-in change is running, and the other way round.
- Uploaded documents stay loaded for 30 minutes without use and not across restarts (Compose's document cache).
  Research then reports the document and asks you to attach it again.
- A generic MCP server must expose exactly one annotated read-only query tool. Read-only annotations are not a security
  boundary: add only MCP servers you trust. Claude Code skills are offered as instructions only; their scripts cannot
  run because research has no shell.
- The swarm summary lists each agent's outcome; it does not merge their texts with another model call. Suggestions
  from all agents are reviewed together, with disagreements marked.
- Your own Claude Code hooks and settings still run with each research call, as they do for Compose.

## Design rules

- **Inactive until opened.** The page loads one small script. The server does no research work, reads no research
  files and starts no CLI until you open Research and send a message.
- **Read-only research.** Every research run has no shell, no file writes and no file reads outside its own empty
  folder. Web search, MCP tools and CLI skills are off until you turn them on for a chat.
- **One job at a time.** A research run uses the same job slot as Compose, the Coordinator and sign-in changes. A swarm
  is one job that runs at most three CLI processes at the same time.
- **Your design comes first.** Research context is built from the saved blueprint revision. Agents get your idea,
  requirements, constraints and decisions as fixed input and must not change them to fit a recommendation.
- **Separate storage.** Chats are stored per Origin project in `<data folder>/origin/research/<project>/`. They are not
  part of the blueprint, the Kanban board or backups.

## Parts

| Part | File | Job |
| --- | --- | --- |
| Panel | `public/origin-research.js` | The right-side panel in Origin: chat, modes, scope, sources, history and suggestion cards. |
| Context | `public/origin-model.js` (`researchContext`, `researchTargets`) | Builds bounded, read-only context for one scope from stable IDs. Shared by the page and the server. |
| Service | `src/origin-research.mjs` | Chat storage, validation, prompts, the streaming CLI adapter, the swarm pool and suggestion parsing. |
| Routes | `src/server.mjs` → `researchRoute` | `/api/origin/research/...`, NDJSON streaming, cancellation and the shared job slot. |

## Interfaces

### Chat (stored)

```text
Chat      { schema: "promptboard.origin-research", version: 1, id, originId, title, createdAt, updatedAt,
            settings: { provider, model, effort, mode, web, scope }, native: { provider, sessionId } | null,
            sources: Source[], messages: Message[], proposals: Proposal[] }
Message   { id, role: "user" | "assistant" | "agent", text, at, mode, agent?: { id, label, target },
            status: "done" | "stopped" | "failed", error?: { code, message }, citations?: Citation[], provider, model }
Citation  { title, url?, locator?, accessedAt? }
```

A chat keeps no hidden model reasoning, no credentials and no copy of the blueprint.

### Scope

```text
{ kind: "project" }
{ kind: "section", id }                      built-in or custom section ID
{ kind: "record", collection, id }           a component, requirement, technology, decision, block, ...
{ kind: "question", key }                    vision:<field> | topic:<section>:<area> | question:<id> |
                                             component:<componentId>:<questionId>
```

Scopes use stable IDs only. Renamed phases, renamed sections, custom sections, custom questions and sections marked
not needed work without code changes.

### Streaming events (NDJSON, server → page)

```text
{ type: "start", runId, mode, agents: [{ id, label }] }
{ type: "delta", agent, text }                     text as the CLI produces it
{ type: "activity", agent, kind, label }           web search, page fetch, tool use
{ type: "agent", agent, status, error? }           running | done | failed | stopped
{ type: "message", message }                       the stored message for one agent or the chat reply
{ type: "proposals", proposals }                   validated suggestions
{ type: "error", code, message }
{ type: "done", chat }                             the chat summary after storage
```

### Source

```text
{ id, type: "document" | "base" | "mcp", name, enabled, ref }
```

`ref` holds an identifier only: a Compose document ID, a Base resource ID, or an MCP connection without secrets.
Document text is never copied into the chat.

### Proposal (suggestion)

```text
Proposal  { id, messageId, op: "set" | "add", target, value, original, baseRevision, title, why,
            evidence: Citation[], status: "pending" | "applied" | "rejected" | "conflict", updatedAt }
target    { kind: "vision", field } | { kind: "idea" }
          | { kind: "record", collection, id, field }
          | { kind: "answer", questionId } | { kind: "componentAnswer", componentId, questionId }
          | { kind: "topic", section, area }          read as a new topic answer (areas), or a change to the one there
          | { kind: "section", section, field: "description" }                   an own section
          | { kind: "block", block, part?, field }    a block's title or text, an answer, a point, a cell, a step or arrow
          | { kind: "blockAdd", block }               value: a question, point, row (column name → text), column, step or arrow
          | { kind: "add", collection }               value holds the new record's fields and links; `ref` names it
                                                      (areas: section, area, title, description; blocks: section, type,
                                                      title and its content)
```

`original` is the value at `baseRevision`. Before a suggestion is applied, the page compares it with the current
value. A difference is shown as a conflict and nothing is overwritten.
