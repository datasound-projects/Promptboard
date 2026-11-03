# Chat: Workspace and App guide

Open **Chat** with the speech-bubble icon at the top right. It has its own page and conversation sidebar.
Choose one of two agents. Each conversation belongs to that agent; switching agents keeps their histories separate.

## Workspace

Workspace finds information across saved app data, including all projects:

- **Origin:** project names, blueprints, saved Project Context and research conversations.
- **Compose:** prompts saved to shared projects, their revisions and links.
- **Kanban:** projects, cards, workflows, schedules, saved settings and agent-run records.
- **Base:** saved resources and profiles, including their enabled/trusted state.
- **Network:** registrations, scoped memory with its approval status, saved agent reports, graphs, jobs, pipelines,
  run states, selected result/report contents, schedules and the handoff policy.

Try questions such as “List my projects and their current status”, “Which cards need attention?”,
“What did we decide in the research for Shop?”, or “Why is this Network run waiting for approval?”
Give a project, card, agent or run name/ID when you want a narrow answer. Follow-up questions retain conversation context,
but every turn reads fresh source records; an earlier AI answer is not treated as proof.

### Browser-only Compose History

Saved project prompts are available through the workspace services. Compose **History** is different: it belongs to
the browser. It is included only when you select **Response settings and context → Include this browser’s Compose History**.
The request includes its title catalog and bounded excerpts selected for the question and recent follow-ups.
Another browser’s History is not available. The source panel identifies browser-provided information.

### Scope and completeness

Chat reads saved app records. It does not read unsaved form edits, traverse linked repositories, inspect arbitrary files,
read provider credential stores, or search the web. Large collections and long records have bounded retrieval.
Saved Compose batches, project memory (with approval status), and previously saved Coordinator observations are included.
Retrieval does not reconcile Coordinator history, repair damaged files, reset interrupted batch runs, or mark job messages read.
Network also includes public job engine, listener, client-scope and A2A federation settings, without credential values.
At most six relevant jobs (accepted requests, messages and results) and six detailed pipeline runs/reports are read per retrieval.
One additional focused retrieval is available when the initial passages are insufficient.
Open **What was searched?** under an answer to see coverage, unavailable records and clipped sources.
A retrieved subset must not be described as the entire workspace. Ask a narrower question when the evidence is incomplete.

Every answer shows its source-read time. If records change while an answer is prepared, a notice identifies the earlier
snapshot and invites a fresh question. Reading several services is not an atomic transaction across the entire app.

## App guide

App guide explains the installed application: its pages, features, field labels, settings, prerequisites and limitations.
It uses bundled user-facing documentation and the current interface’s Settings text. Historical design plans and
implementation journals are excluded. Workspace records and browser History are not supplied to this agent.

Examples:

- “Walk me through Network, from registering an agent to an approved pipeline report. Tell me what to enter and why.”
- “Explain each type of Network pipeline step, including joins, conditions and approvals.”
- “What is the difference between Origin, Compose and Kanban?”
- “How do Base profiles and project default agents interact?”
- “Where do I change the default agent? What do Model and Effort mean?”
- “How do I pair a phone, use Docker, configure notifications, or restore a backup?”

The agent should give the exact navigation and labels used by this build, with example inputs when supported by the
sources. It must identify missing evidence instead of inventing an option, an input format or a feature.

## Sources and version identity

The page shows the package version and a build fingerprint. The fingerprint covers the installed application code,
interface, dependency lock file and selected user guides, so two builds with the same package version are distinguishable.
Guidance does not come from a generic online manual for a different release.

Each factual answer section needs a recognized source ID and an exact supporting quotation. The complete reply is checked
before it is displayed; unverified model output is not streamed into the conversation. The agent can request one extra
round of local source retrieval. If it cannot support an answer, it says so. Unknown source IDs, fabricated quotations
and malformed replies are rejected.

Select **Source 1**, **Source 2**, etc. to read quotations and the retrieved passage. Older answers retain their original
build and source snapshot. After an upgrade, answers from a different build are labelled. If installed files change while
the app is running, restart Promptboard before asking for new guidance.

**No model can promise 100% correctness.** Matching a quotation verifies its provenance; it does not prove every model
interpretation. Review the supplied evidence for important decisions. A source can itself be incomplete or contain an
author’s unverified statement. Proposed notes are not approved facts, drafts are not published versions, and queued,
interrupted or unknown jobs must not be presented as successfully completed.

## CLI, model and effort

Under **Response settings and context**, choose **CLI**, an optional **Model**, and **Effort**. Empty Model/Effort uses
that CLI’s default. Initial settings follow Compose when its provider is supported. Changing Chat settings does not change
Compose or the workspace’s default agent. **Refresh CLIs** checks installed providers again.

These are Chat’s own controls; model pickers on other pages do not describe this form. **Model** is a manual text field,
not a discovered-model dropdown. Chat does not display or verify a model catalog. Enter a model ID or alias accepted by
the selected CLI/account, or leave it empty for that CLI’s configured default. **Refresh CLIs** refreshes installed-provider
detection, not a Chat model catalog. **Effort** offers the supported provider-level choices; Chat does not check a selected
model’s discovered effort capabilities. The CLI ultimately accepts or rejects that model/effort combination. Gemini offers
only **CLI default** for Effort. A rejected request reports an error; Chat does not silently substitute another model.

Chat supports **Claude Code**, **Codex** and **Gemini CLI** through the existing tool-disabled headless adapters. Install
and sign in to the chosen CLI first. Antigravity is not offered here because its adapter does not enforce the same
deny-all-tools contract. No external search or MCP tool is enabled for Chat. Questions and selected source excerpts go
to the chosen CLI/provider. Credential fields are excluded and recognizable secrets are redacted; private free text
cannot be guaranteed to contain no sensitive information.

## Conversations and controls

- **New conversation** starts an independent discussion with the selected agent. Conversations are saved locally and
  remain available after a restart. The sidebar filters by agent and can find a conversation by its title.
- **Enter** sends; **Shift+Enter** inserts a new line. Input composition is respected. The draft is not cleared until
  the server acknowledges saving the question. A draft typed while an answer is prepared is kept.
- **Stop response** cancels that chat’s CLI request. It does not stop a Kanban or Network job.
- **Copy answer** includes source titles and their version/read time.
- **Delete conversation** asks for confirmation and deletes chat history only. It leaves workspace records intact.
- A conversation keeps up to 200 messages and has a bounded file size. At the limit, start a new conversation; existing
  messages are not silently discarded. The history supplied to the model is a bounded recent window.
- An interrupted response is not automatically replayed after restart. Reopen the conversation, check its saved state,
  and ask again if needed.

Chat shares the app’s one-off CLI slot with Compose and other single-request assistants. If that slot is busy, the question
stays in the input until it can be sent. Kanban and Network keep their existing execution pools.
Chat also works through paired Remote access; browser History still means that paired browser’s own History.

## Read-only means no workspace actions

Neither agent can create/edit projects or cards, run or approve pipelines, change settings, install tools, execute shell
commands, or write repository files. An answer can explain the steps for you to perform in the relevant app page.
Source material—including prompts, notes, reports and documentation—is treated as data, not permission to execute
instructions embedded in it. Only the Chat conversation is written by a Chat request.
