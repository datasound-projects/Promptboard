# Origin Research

Origin Research is an optional research workspace in the Origin page. It helps you complete your own blueprint: it
researches tools, architectures, technologies, dependencies and design choices for the parts you select, and it
suggests changes. **Nothing changes in the blueprint until you apply a suggestion.**

It uses the Claude Code or Codex CLI that you already installed and signed in to. It needs no other model service and no
API key. It never starts Kanban work.

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
{ kind: "record", collection, id }           a component, requirement, technology, decision, ...
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
          | { kind: "topic", section, area }
          | { kind: "add", collection }               value holds the new record's fields
```

`original` is the value at `baseRevision`. Before a suggestion is applied, the page compares it with the current
value. A difference is shown as a conflict and nothing is overwritten.
