# Network user guide

Network is Promptboard's fifth page (`Origin · Compose · Kanban · Base · Network`, at `#/network`). It reuses the agents
you set up in Base for work that is not a code change: research, reviews, summaries and checks. Kanban stays the place
for code: cards, branches, worktrees, review, tests and merges.

The page has seven sections: **Agents**, **Graph**, **Pipelines**, **Activity**, **Library**, **Federation** and
**Settings**. Each one also works by keyboard and on a phone (a list instead of a canvas below 730 px).

**What starts work, and what never does.** Saving, publishing, validating, importing and opening anything start nothing.
Work starts only from:

- a job you confirm in an agent's **Tasks** tab, or a pipeline run you confirm with **Start run**;
- **Run now** on a schedule, or a schedule you switched on at this computer;
- an external client or A2A caller you created, through its own token;
- a sub-job or question your handoff policy allows.

**Every Network job only reads.** It runs once on this computer with your signed-in CLI, in an empty folder of its own
(`network/jobs/<job>/attempts/<attempt>/workspace` in the data folder). It never gets a project, a repository, a card or
a worktree, and Promptboard never starts `git` for it. A job that needs to change files belongs on a Kanban card.

Contents: [Register an agent](#register-a-base-agent) · [Graph](#build-a-graph-and-nested-networks) ·
[Library](#library) · [Pipelines](#build-publish-and-run-a-pipeline) · [Tasks](#run-a-job-from-an-agents-tasks-tab) ·
[What each CLI reports](#what-network-can-observe-per-provider) · [Activity](#activity-and-the-live-feed) ·
[Handoffs](#delegation-and-questions) · [Schedules](#schedules) · [External clients](#external-clients-rest-and-mcp) ·
[Federation](#a2a-federation) · [Export and import](#export-and-import) · [Limitations](#limitations) ·
[Future: remote workers](#future-remote-workers)

If something is refused or ends unexpectedly, see [Troubleshooting](troubleshooting.md).

## Register a Base agent

1. Set the agent up in Base first: a Base **Agent** or **Agent profile** with its provider (Claude Code, Codex or Gemini
   CLI), model and instructions. Antigravity agents can be registered but cannot run Network jobs.
2. **Network → Agents → Register agent.** Choose the Base agent, then its Network identity: display name, tags,
   capabilities, the projects whose approved lessons its jobs may read, and on or off.
3. The profile opens. **Open in Base** edits the definition in Base's own editor; **Edit identity…** changes only the
   Network fields; the switch turns the registration off or on.

Network stores only a reference (the Base ID) in `network/agents.json`. A later Base edit shows at once and is never
copied. A Base agent that is deleted, switched off or no longer trusted makes the registration **Stale**, with the
reason; it cannot take jobs until you fix it in Base.

The profile has five tabs:

- **Profile:** Base kind, provider, model and effort, state, tags, capabilities, projects, networks, an instructions
  preview, and what its CLI can do for Network (the [matrix below](#what-network-can-observe-per-provider)).
- **Tasks:** its Network jobs ([below](#run-a-job-from-an-agents-tasks-tab)).
- **Activity:** its status, open jobs, Kanban runs and events.
- **Memory:** facts, lessons, preferences and procedures (up to 4,000 characters each). A record is proposed, then
  approved by you; only approved records reach a job. **What a job would receive** shows the exact text and why each part
  is in or out. Project Memory stays separate: a job gets a project's approved lessons only when you allow it and the
  project is on the agent's list.
- **Posts:** your own reports, labelled "Report · Written by you". They never appear in Activity as work.

Limits: the directory shows 200 agents a page (**Show more agents**) and is read again on each visit, not pushed live.
Base's own "Used by" panel does not list Network registrations; the profile shows Base's count only.

## Build a graph and nested networks

A graph says which agents belong together and what you allow between them. It is not an execution order.

1. **Library → New network…**, then **Open in Graph** (or pick it in **Graph**).
2. **Add agent…** places registered agents. **Add sub-network…** pins one published version of another network: a
   reference, never a copy. **Add remote peer…** places a peer you trust in Federation.
3. Connect two nodes: **Connect**, then tap the first node and the second, or use the node's details form. A relation is
   **Message**, **Delegate** or **Share result**.
4. **Save draft** saves the whole draft at once. When someone else saved first, nothing is overwritten: choose **Load
   the saved draft** or **Save mine as a new network**.
5. **Publish version N** writes a version that never changes. Version chips (`v1`, `v2 · latest`) open a read-only view.
   Draft edits after that never change a published version.

**Nested networks.** A sub-network node shows **Show what is inside** (read only). One version can be reused by many
networks; the Library lists where each is used. A loop of containment (A contains B contains A, directly or through
older versions) is refused with its path, and the node is marked.

**Relations grant nothing.** Saving or publishing a graph starts nothing, sends no message and shares no data. Only a
pipeline's own arrows move data. The one place Promptboard reads a relation is a delegation check: a `delegate`
relation is required for an agent to hand work to another, never enough on its own.

Also on the canvas: **Arrange in a grid** or **Arrange in layers**, **Fit**, zoom, search, a relation filter, **Undo**
(50 steps) and **Discard changes…**. Leaving with unsaved edits asks first. Every action also works from the **Nodes**
and **Relations** lists beside the canvas; on a phone only the lists are shown, then one node's details.

Limits: the canvas draws at most 1,000 nodes (a sub-network that would pass that is not expanded, with a notice). The side
lists show 200 rows until **Show all**. Nodes inside an expanded sub-network are read only. Above 300 relations, lines
are drawn solid instead of dashed. For measured draw times, see [Performance](performance.md).

## Library

Every network with its draft revision, published versions (newest first), where each version is used, the issues to fix
(a switched-off or stale agent, an archived or outdated sub-network, a missing peer) and the network's own **Memory**.

- **Rename…**, **Duplicate…** (a new unpublished draft that keeps the same references), **Archive** and restore (**Show
  archived** lists them; every version stays readable and every pin keeps working).
- **Delete…** only for a network that was never published and that nothing contains. Otherwise the button is disabled
  with the reason; archive it instead.
- **Export** and **Import…**: see [Export and import](#export-and-import).

## Build, publish and run a pipeline

A pipeline is an execution plan for one network: it pins one published version of that network and runs its agents in
the order its arrows give.

1. **Pipelines → New pipeline…** (empty) or **New from template…** (two research steps in parallel → join → reviewer →
   approval → report). Choose the network and its published version.
2. Add steps from the palette:
   - **Agent:** runs one agent of the pinned network version as a Network job. It gets only what its arrows carry.
   - **Sub-network:** runs a published pipeline of a network this network contains, pinned at one version.
   - **Parallel:** starts the steps after it at the same time.
   - **Join:** waits for all the steps before it, or for the first one.
   - **Condition:** checks the json results before it with fixed rules (equals, is less than, is one of, exists,
     contains and so on), then goes on along "true" or "false". No code is ever run.
   - **Approval:** waits for your **Approve** or **Reject**. Nothing after it runs until you decide.
   - **Output:** saves a report of the steps you tick, in order.
   - **Remote peer:** sends what its arrows carry to a peer you trust in Federation.
3. Draw arrows: **Connect** and two taps, or the step's "Add an arrow from …" form. Each arrow leaves on a port (text
   result, json result, when true, when false, when done).
4. Step settings: an agent step has instructions, tools (none or web search), a time limit and 0–2 retries. **Pipeline
   settings:** at most 1–4 steps at once (default 2), a run deadline from 1 minute to 24 hours (default 2 hours), and what
   a failed step does (stop the run, or let independent branches finish).
5. **Save draft**, then **Validate**: refused steps and arrows are marked with the reason. **Publish** saves first and
   shows what changed since the previous version.
6. **Run…** shows the version, its size, how many steps run at once, the permissions and tools, and that cost is not
   enforced. **Start run** starts it.

The run view (`#/network/runs/<id>`) shows each step's live state (Waiting, Running, Waiting for you, Blocked,
Completed, Failed, Skipped, Cancelled), its reason, its job (**Open job**), the condition's evidence and the saved
report (**Download**; a report changed on disk is refused). **Approve** or **Reject** works from the step. **Cancel
run…** cancels open steps and their jobs. A sub-pipeline is one collapsed group that you can expand.

**What a run keeps.** It runs one published version, pinned with every nested version and hash. Editing, saving or
publishing the pipeline or its network never changes a run that already started. A pipeline arrow is not a Graph
relation: a relation never moves data, and an arrow only moves data inside its run.

**After a restart.** An approval keeps waiting. A step whose job was running when Promptboard stopped becomes **Blocked**
and nothing is sent again: retry that job (confirming it) or close it in Activity, or cancel the run. A step whose job
ended "outcome unknown" blocks the same way, and the steps after it wait. A failed agent step is retried only as often as
its retries allow; a remote peer step is never retried on its own.

A pipeline step's job may ask you a question or delegate sub-jobs under your handoff policy. The run view shows **Waiting
for your answer** or **Waiting for sub-jobs** and links to its job record. The pipeline deadline keeps counting while a
job waits; approval steps and blocked steps pause it.

Limits: the runner checks for work each second, so a step can start up to a second after its inputs. There is no pause.
Tokens and cost are not limited during a run. Pipelines are not part of the Network export. A sub-pipeline's own
settings are ignored. Pipeline jobs never name a project, so they get no project lessons. The designer reads the first 200
registrations. An agent step's result text is read through its job (**Open job**); only output steps have a report.

## Run a job from an agent's Tasks tab

1. Open the agent's profile → **Tasks** → **Run a job**.
2. Write what it should do. Choose the tools (**No tools**, or **Web search (read only)**; not offered for Gemini CLI),
   a time limit (1–120 minutes, default 20), and optionally a project and a network. Choose whether it gets the agent's
   approved memory (and the network's, when a network is chosen) and the project's approved lessons. **What it receives
   besides your text** shows exactly what is added.
3. **Run job…** shows everything the job may use: agent, CLI and model, tools, files (read only, an empty folder),
   memory, lessons, time limit and cost (not limited; usage is shown only if the CLI reports it). **Run job** sends it.

The job list follows the live feed. Each job shows its status, where it waits, its last activity, what its CLI reports,
reported usage, and its reason and error code. Actions: **Cancel**, **Approve** / **Reject** (when it waits for approval),
**Retry…** and **Close…** (when its outcome is unknown or it was interrupted). Details show the result as Markdown (HTML
stays text) and its json.

| Status | Meaning |
| --- | --- |
| Queued | Accepted, waiting for a job slot (two at once by default, apart from Kanban's agents). |
| Waiting for approval | Waits for your Approve or Reject. |
| Preparing, Running | Its CLI is being started, or runs. |
| Waiting for input | It asked a question or waits for its sub-jobs ([Handoffs](#delegation-and-questions)). |
| Completed | The CLI exited 0 **and** gave its structured final answer. Nothing else counts as done. |
| Failed | A definite failure, with a fixed reason and code. |
| Cancelled | You (or its client) cancelled it. |
| Outcome unknown | It may have done its work, but Promptboard has no trusted answer. It waits for you. |
| Interrupted | Promptboard stopped while it ran. It waits for you. |

**Never run twice on its own.** An unknown or interrupted job runs again only when you choose **Retry…**; when it may
already have done its work (or read the web), you confirm that first. **Close…** ends it as failed.

How a job runs: its prompt holds a fixed header (read only, no file changes), the agent's Base definition pinned when the
job was accepted, your instructions, the approved memory and lessons it may have, and your text, each in its own section.
Text you send is indented inside its section, so it cannot close or fake another one. Base MCP servers, command recipes
and supporting agents of a profile are never given to a job; an agent that requires one is refused when you submit.

Settings of the job pool (no screen yet; `PATCH /api/network/settings`): at most 1–4 jobs at once (default 2), the default
time limit (1–120 minutes, default 20) and how long attempt logs are kept (default 30 days, removed at app start; the
result and record stay). A CLI sign-in change waits for running jobs, and new jobs wait for the sign-in.

## What Network can observe per provider

Network shows a coverage label next to every live status. When there is no evidence, it says "unknown", never "idle" or
"done".

| | Claude Code | Codex | Gemini CLI | Remote A2A peer |
| --- | --- | --- | --- | --- |
| Job tools | none, or web search and page reading | none, or web search | none | the peer's own; Promptboard cannot see them |
| While it runs, Activity shows | each tool call ("Searched the web", "Read a web page") and when it starts writing: **Tool activity** | its web searches and when its answer arrives: **Limited activity** (quiet gaps are normal) | nothing until it ends: **Final result only** | the task states the peer reports (accepted, working) |
| Counts as completed | `result` event without an error, and exit 0 | a completed `agent_message`, and exit 0 | the JSON `response`, and exit 0 | task state COMPLETED with text |
| Usage | input, cached and output tokens, and cost (`total_cost_usd`) | input, cached and output tokens; no cost | not reported | not reported |
| Session or task ID kept | session ID | thread ID | none | the remote task ID |
| Read-only enforcement | `--tools ""` (web: `--tools WebSearch,WebFetch --allowedTools WebSearch,WebFetch`), `--strict-mcp-config --mcp-config {"mcpServers":{}}`, `--disable-slash-commands`, `--max-turns 1` (web: 30), `--no-session-persistence` | `exec --ephemeral`, `sandbox_mode="read-only"`, `approval_policy="never"`, `web_search="disabled"` (web: `"live"`), apps, plugins and hooks off, `--disable shell_tool --disable unified_exec`, your configured MCP servers switched off | `--approval-mode default --extensions none --allowed-mcp-server-names '' --allowed-tools ''` and a deny-all `--policy` file | none on the peer; Promptboard sends only instructions and input, never tools, memory, a project or lessons |
| Checked with the real CLI | yes (Haiku) | yes | no: the live run was refused by the provider (`CLIENT_UNSUPPORTED`); covered by fake CLIs only | inbound: a real Codex job through an A2A client; outbound: only against local test peers |

**Antigravity** cannot run Network jobs (`PROVIDER_UNSUPPORTED`): its sandbox cannot refuse every tool.

The CLI's own user-level configuration (for example `~/.claude/CLAUDE.md`) still applies, as in Origin Research. Claude
Code and Codex results are cut at 100,000 characters.

## Activity and the live feed

**Network → Activity** shows:

- the live line: "Live", "Reconnecting…", or "Live updates paused" when too many Activity views are open;
- **Agents:** each agent's status (running, queued, waiting for approval or input, unknown) beside what its CLI reports;
- **Timeline:** every saved job status, worker activity, pipeline step, handoff, message and schedule event, newest
  first, with agent and kind filters, search and **Show older events**;
- **Running and queued:** each open job, where it waits or how long it runs, where it came from (you, a client, a
  schedule, a delegating job, a pipeline run) and its usage when reported;
- **Kanban runs (read only):** runs of registered Base agents on your boards, with **Open in Kanban**;
- **Schedules** ([below](#schedules)).

**Details** opens one job's record (`#/network/activity/<jobId>`): status, outcome, error, the request summary, its
attempts with provider, coverage and usage, the result, its status history and its events, plus who started it, an
approval, a question, its sub-jobs and messages.

The feed comes from a journal in `network/events/` that survives restarts. After a lost connection or a restart, the page
reconnects with the last event it saw and shows each missed event once. Statuses come only from job records and the
journal, never from silence. There is no progress percentage, and usage and cost appear only as the CLI reported them.

Limits: one computer keeps at most 4 live views (each paired device has its own 4; 32 in all); a fifth view pauses and
tries again every 15 seconds. The journal keeps its newest 16 files of 8 MiB; older events are gone and the timeline says
so. Search and filters work on the events loaded in the page. Kanban runs refresh every 20 seconds. A power loss (not an
app crash) can lose the newest journal lines.

## Delegation and questions

A running agent can ask for help in one way only: the last fenced ```` ```json ```` block of its final report. Promptboard
treats that block as a request and checks it on this computer:

```json
{"promptboard": {"needs_input": {"question": "Which market should I focus on?"}}}
{"promptboard": {"delegate": [{"agentId": "agt_…", "task": "Check the 2025 pricing pages.", "tools": "web"}]}}
```

Both are **off by default**. **Network → Settings → Handoffs** (at this computer only; saving starts nothing):

| Setting | Default |
| --- | --- |
| Agents may ask you a question | off |
| Agents may delegate sub-jobs | off |
| Sub-jobs wait for my approval | on |
| Deepest sub-job | 2 (1–4) |
| Sub-jobs per job | 3 (1–10) |
| Time budget per sub-job | 50 % of its parent's time limit (10–100 %) |

- **A question:** the job waits (**Waiting for input**). Answer it in its record in Activity; the job's external client
  can answer too. The job then runs again as a new attempt that reads the question and your answer as data.
- **Delegation:** each sub-job must follow a `delegate` relation from the parent's agent in the job's network, use no
  wider tools, stay in the same project, add no loop, and fit the depth and fan-out limits. All tasks of one request
  pass, or none does. Sub-jobs appear as a tree in the parent's record (with **Approve** / **Reject** when they wait).
  When they end, the parent runs again with their results as data.
- **Refused requests** are recorded as a message and an event; the job completes with its report.
- **Messages** are records of each handoff with read marks. You can add a review or request note; agents cannot post.
- Cancelling a parent cancels its open sub-jobs. A queued sub-job is checked again before it starts: if you removed the
  relation or switched delegation off, it fails without running.

Limits: one policy for all networks; at most 5 handoffs per job; jobs started over A2A cannot delegate, and a remote peer
cannot be a delegation target; there is no free messaging between agents.

## Schedules

If Network reports a recovered backup, review the values before enabling access or automation again. Recovered clients
are revoked and need new tokens; recovered memory notes require approval again. A recovered graph keeps its contents,
but delegation is suspended until you review it and choose **Confirm recovered relations** in Graph. Renaming it does
not confirm those permissions. Recovery notices and Activity explain what changed; damaged bytes are kept.

**Network → Activity → Schedules → New schedule:** choose a name and **It runs**: either an agent job (agent, task and
tools), or a published pipeline version with optional run input. Pipeline schedules show the same permissions, time,
parallelism and cost facts as Run. Choose a repeat (daily, weekdays, weekly, monthly on day 1–28, or on demand) with a
time. A new schedule is **off**; saving or editing starts nothing.

- **Switch on…** confirms that it may start jobs without asking each time. It works only at this computer (not from a
  paired phone) and records this computer's time zone.
- A time missed while Promptboard was closed starts **one** job, never one per missed time.
- While its previous job is open, a time is skipped and used up ("Skipped: …").
- A restart never starts the same time twice.
- **Run now** starts one job at once, even while the schedule is off. For a pipeline it first shows the pinned version's
  run facts and asks you to confirm **Start run**. **Last run** opens its live run view.
- Editing what it runs, or when, switches it off again.
- After the computer's time zone changes, the schedule shows **Zone changed** and starts nothing until you switch it on
  again here.


Limits: at most 100 schedules, only while Promptboard runs. Times are this computer's local time.

## External clients (REST and MCP)

Apps and MCP hosts on this computer (Claude Code, Codex, a script) can use your agents through jobs, without owner access.
**Network → Settings:** turn on **Listen for external clients** (the machine listener, `127.0.0.1` only, port 4330 by
default), then **Create client** with its agents, permissions, projects, networks and expiry. Its token is shown once.

A client can list its agents, submit read-only jobs, read and cancel its own jobs and their results, and follow their
events. It can never approve, retry, change settings or reach Base, Kanban or another client's jobs. **Rotate token** and
**Revoke** work at once, also on open streams. Exact setup, snippets and curl examples:
[MCP and A2A setup](setup-mcp-a2a.md).

Limits: loopback only (no Tailscale address or TLS); scopes cannot be edited (create a new client and revoke the old one);
revoking does not cancel the client's jobs; 60 requests and 10 submits a minute per client.

## A2A federation

**Network → Federation.** Both directions are off until you turn them on, at this computer only.

- **Outbound:** turn on **Call trusted remote peers**, then **Add peer…** with the peer's Agent Card URL. Review what the
  card says (shown as text) and approve exactly that card. Put the peer in a network in Graph, then use a **Remote peer**
  step in a pipeline. The peer gets only the step's instructions and what its arrows carry.
- **Inbound:** publish agents under **Published for A2A**, turn on **Accept A2A tasks**, keep the machine listener on,
  and **Create caller…** for each outside agent. Each task becomes one read-only Network job of a published agent.

Switching outbound off, switching a peer off or removing it stops that peer's running jobs at once; they end "outcome
unknown", because the peer may still finish them. Setup, credentials and the address rules: [MCP and A2A
setup](setup-mcp-a2a.md#a2a-federation).

## Export and import

**Library → Export** saves one JSON file with your registrations, every network draft and published version, and your
schedule definitions (job schedules only, when there are any).

It never carries memory, reports, pipelines, jobs, results, events, the handoff policy, external clients or token
hashes, remote peers, cards, credential names or federation settings. Board backups do not carry Network data either.

**Library → Import…** checks the whole file before it writes anything:

- every agent in it must be a Base agent here (restore the board backup that holds them first);
- an ID already in use gets a new one, and every reference follows;
- registrations and schedules arrive **switched off**;
- a remote peer node keeps its ID and shows as missing until you add that peer again.

Nothing runs because of an import.

## Limitations

What this version does not do, from the [implementation log](implementation-progress.md):

- **Read-only jobs only.** No job can write files, use a repository or a worktree, or receive Base MCP servers, command
  recipes or a profile's supporting agents. Use Kanban for code changes.
- **Gemini CLI** is checked with fake CLIs only (the provider refused the live run with `CLIENT_UNSUPPORTED`), and has no
  web search in Network. **Antigravity** cannot run Network jobs.
- **Cost is never enforced.** Tokens and cost are not limited for jobs or runs, and appear only as the CLI reports them.
- **A process left by a hard crash** is not stopped after a restart; its job shows the process ID in its reason.
- **A changed Base agent** does not change a job already accepted; a job accepted before Base pinning whose agent changed
  since fails with `BASE_CHANGED`.
- **Graph:** the 1,000-node view cap counts nodes, not relations; expansion is not remembered; nodes inside an expanded
  sub-network are read only.
- **Pipelines:** no pause, no export or import, no start idempotency key; a sub-pipeline's own settings are ignored; jobs
  of a run are read 200 at a time; the run view stops following at the first read that sees the run end.
- **Activity:** 4 live views per computer, 32 in all; the journal keeps 16 files of 8 MiB; appends are not flushed to disk
  on each write.
- **Handoffs:** one policy for all networks; at most 5 handoffs per job; a parent restored from its backup while waiting
  becomes interrupted; webhook triggers are not built.
- **External clients:** `127.0.0.1` only; scopes cannot be edited; revoking does not cancel jobs; rate limits reset when
  the app restarts.
- **A2A:** A2A 1.x JSON-RPC only (no v0.3, gRPC or HTTP+JSON); credentials are bearer or header API keys from environment
  variables (no OAuth 2.0, OpenID Connect or mTLS); card signatures are not verified; inbound tasks take one message (no
  follow-ups, streaming, task lists or push notifications) and reach agents only, not pipelines; a remote "input required"
  or "auth required" ends the job as failed; peers are never exported; real remote peers over the internet were not
  tested.
- **Performance:** see [Performance](performance.md) for what was measured; no "unlimited" claim is made.

## Future: remote workers

Today every Network job runs on this computer. A later version may add **owned remote workers**: other machines you own
(a desktop, a home server) that run Network jobs for this Promptboard, with the same job records, leases, read-only rules
and "never run twice on its own" outcomes. This is a post-MVP extension and is not built.

The plan keeps the current shape:

- the job engine stays the one record of every job; a remote worker only claims and reports, under a lease it cannot
  forge, like the local worker;
- a worker machine pairs once and gets its own revocable credential, like an external client today;
- no new infrastructure: no Redis, Kafka, Kubernetes, separate microservices, graph database or hosted multi-tenant
  service.

A2A federation stays what it is: controlled communication with independent peers. Promptboard sends a peer a task and
reads the states it reports; it never controls a peer's processes, tools or memory, and a peer is never a worker.

## See also

[MCP and A2A setup](setup-mcp-a2a.md) · [Troubleshooting](troubleshooting.md) · [Performance](performance.md) ·
[Architecture](architecture.md) · [All Network docs](README.md) · [SECURITY.md](../../SECURITY.md)
