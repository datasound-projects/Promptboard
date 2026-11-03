# Network troubleshooting

Common Network errors and what to do. Every error shows a message and a code; the code is what to search for here.
Errors of the machine listener, MCP and A2A are in [MCP and A2A setup](setup-mcp-a2a.md#troubleshooting).

Two rules explain most of what you see:

- **Nothing is ever run twice on its own.** When Promptboard cannot prove what a job did, the job waits for you.
- **A refusal before the start changes nothing.** "Nothing was submitted", "Nothing ran" and "Nothing was sent" mean
  exactly that.

## The agent cannot take a job

| Code | Why | What to do |
| --- | --- | --- |
| `REGISTRATION_DISABLED` | The registration is switched off in Network. | Switch it on in the agent's profile. |
| `REGISTRATION_STALE` | Its Base agent no longer exists, is switched off, is not trusted (or trust was revoked), or an agent profile has no usable primary agent. The message names which. | Fix the agent in Base (**Open in Base**). The profile shows **Stale** with the reason. |
| `PROVIDER_UNSUPPORTED` | The agent's CLI cannot run Network jobs: Antigravity (its sandbox cannot refuse every tool), or no provider set in Base. | Use an agent that runs Claude Code, Codex or Gemini CLI. |
| `TOOLS_UNSUPPORTED` | Web search was asked for on Gemini CLI, which runs Network jobs without tools only. | Choose **No tools**, or use a Claude Code or Codex agent. |
| `BASE_REQUIRED_UNAVAILABLE` | The agent requires a Base resource a Network job cannot be given: an MCP server, a command recipe, a profile's supporting agent, or something switched off or untrusted. The message names it. | Make that resource optional for the agent in Base, or run the work on a Kanban card. |
| `BASE_CHANGED` | The Base agent changed while the job was submitted, or a job accepted before Base pinning found its agent changed. | Submit it again. |
| `BASE_REVOKED`, `BASE_ROOT_NOT_APPROVED` | A Base resource the job pinned was revoked, or a folder it reads is no longer approved, before the job started. Nothing ran. | Fix it in Base, then submit again. A revocation after the start lets the job finish with what was accepted, and its reason says so. |
| `EXECUTION_POLICY_UNSUPPORTED` | The job asked to write files. | Network jobs only read. Use a Kanban card. |
| `NOT_INSTALLED` | The CLI was not found on this computer. | Install it and sign in from your terminal, then **Retry…**. |
| `PROJECT_NOT_ALLOWED` | Project lessons were asked for a project that is not on the agent's project list. | Add the project in **Edit identity…**, or leave lessons off. |

## The provider refused or failed

These come from the CLI and carry the same fixed messages as Compose and Origin Research. The job is **Failed**.

| Code | What to do |
| --- | --- |
| `CLIENT_UNSUPPORTED` | The provider no longer supports this CLI for the account. Promptboard's own live Gemini CLI check ended this way, so Gemini Network jobs are covered by fake CLIs only. Check the provider's supported clients and sign-in, or use a Claude Code or Codex agent. |
| `AUTH_REQUIRED` | The CLI is not signed in, or the sign-in expired. Open **CLIs** in the top bar, sign in, then **Retry…**. |
| `RATE_LIMITED` | The provider is limiting requests for this account. Wait, then **Retry…**. (The same code from the machine listener means a client sent too many requests: see [setup](setup-mcp-a2a.md#troubleshooting).) |
| `QUOTA_EXHAUSTED`, `ACCOUNT_UNAVAILABLE` | The account's usage is used up, or it has a billing problem. Check the provider account. |
| `MODEL_UNAVAILABLE` | The model set in Base is not available to this account. Choose another model in Base. |
| `PROVIDER_UNAVAILABLE`, `NETWORK_ERROR` | The provider or your connection is down. Try again later. |
| `POLICY_DENIED` | A provider, CLI, sandbox or organization policy blocked the request. |
| `CLI_FAILED` | The CLI exited with an error Promptboard does not recognise, or it was killed from outside. Run the CLI in a terminal to see why. |
| `OUTPUT_LIMIT` | The result was larger than 1 MiB (64 KiB for its json), or a remote peer sent too much. Ask for a shorter answer. |
| `TIMEOUT` | The job ran past its time limit and was stopped (**Failed**). Give it a longer limit (up to 120 minutes). For a remote peer the job is instead **Outcome unknown**, because the peer may still finish. |
| `PREPARE_TIMEOUT` | The job did not start within 45 seconds. Try again. |

## Outcome unknown

**Outcome unknown** means the job may have done its work, but Promptboard has no trusted answer. It waits for you.

| Code | Why |
| --- | --- |
| `INVALID_OUTPUT` | The CLI exited 0 without its structured final answer. |
| `NO_RESULT` | The worker ended without a result after the job started. |
| `REMOTE_*`, `TIMEOUT`, `PEER_WITHDRAWN` | A remote peer's answer was lost, could not be trusted, ran past its time limit, or trust was withdrawn. See [setup](setup-mcp-a2a.md#a2a). |

In the job's row (Tasks tab or Activity):

- **Retry…** starts a new attempt. When the last attempt may have done its work or read the web, you must confirm that
  running it again is safe; over the API that is `confirmUncertain: true` (otherwise `UNCERTAIN_CONFIRMATION_REQUIRED`).
- **Close…** ends it as **Failed** and runs nothing.

## Interrupted jobs and runs

| Code | Why | What to do |
| --- | --- | --- |
| `APP_STOPPED` | Promptboard stopped (quit, Ctrl+C) while the job ran. Its CLI was stopped. | **Retry…** (confirming it) or **Close…**. |
| `APP_RESTARTED` | Promptboard found the job preparing or running when it started again, for example after a crash. The reason names a process ID that may still run. | Check that process if named, then **Retry…** or **Close…**. |
| `RESTORED_FROM_BACKUP` | The job's record was damaged and was read from its backup copy, so it may have run after that copy was made. A run read from its backup becomes **Interrupted** the same way. | Retry or close the job; cancel the run. |

A queued job is not interrupted by a restart: it simply starts afterwards (unless its record had to be read from its
backup). A process left by a hard crash is not stopped for you.

**A pipeline step is Blocked** when its job is interrupted, outcome unknown or its result cannot be verified
(`ARTIFACT_INVALID`). The steps after it wait and nothing is sent again. Retry or close the step's job (**Open job**),
or **Cancel run…**. Other run endings:

| Code | Meaning |
| --- | --- |
| `STEP_FAILED` (or the step's own code) | A step failed and the run's failure policy is "stop". |
| `UPSTREAM_FAILED` | The step was cancelled because a step before it failed, was rejected or was cancelled. |
| `APPROVAL_REJECTED` | You rejected an approval step. |
| `DEADLINE` | The run passed its deadline (pipeline settings) and was stopped. |
| `RUN_STOPPED` | The run ended, so its open steps were cancelled. |
| `ARTIFACT_INVALID` (on a report) | The saved report changed on disk, so it is not shown. |

## Handoffs (questions and delegation)

A refused request never stops the job: it completes with its report, and the refusal is a message and an event in
Activity.

| Code | Why | What to do |
| --- | --- | --- |
| `HANDOFF_OFF` | Questions are off. | Turn on **Agents may ask you a question** in Settings → Handoffs. |
| `DELEGATION_OFF` | Delegation is off. | Turn on **Agents may delegate sub-jobs**. |
| `HANDOFF_INVALID` | The agent's request block was malformed. | Nothing to fix in Promptboard; the agent wrote an invalid block. |
| `HANDOFF_LIMIT` | The job already made 5 handoffs. | None: this is the ceiling. |
| `DELEGATION_NO_NETWORK` | The job does not run in a network, so there is no relation to check. | Choose a network when you run the job. |
| `DELEGATION_NOT_ALLOWED` | No `delegate` relation from the agent to that agent in the network's current draft, outside a client's scope, a job started over A2A, or a chain that cannot be read back to its start. | Draw the relation in Graph and save, if you want to allow it. |
| `DELEGATION_DEPTH`, `DELEGATION_FANOUT` | Deeper than **Deepest sub-job**, or more than **Sub-jobs per job**. | Raise the limit, if you want to. |
| `DELEGATION_CYCLE` | The agent is already in the chain (no self-delegation, no loops). | None. |
| `DELEGATION_ESCALATION` | The sub-job asked for wider tools than its parent (web from a job without tools). | None: sub-jobs never get more. |
| `DELEGATION_CANCELLED` | An ancestor job was cancelled. | None. |
| `DELEGATION_REVOKED` | A queued sub-job was checked again at its start and is no longer allowed (relation removed, delegation off, client revoked). It ran nothing. | The parent goes on with that outcome. |
| `JOB_IN_USE` | You tried to delete a sub-job its parent still waits for. | Wait, or cancel the parent. |

## Schedules

- **Zone changed.** The computer's time zone differs from the one the schedule was switched on in. It starts nothing
  until you choose **Switch on…** again at this computer, which records the new zone.
- **"Skipped …: The previous job … is still open"** (`PREVIOUS_OPEN`): a time came while its previous job (or run) was
  open. That time is used up; the next one tries again. **Run now** works anyway.
- **Switching on from a phone** is refused (`REMOTE_LOCAL_ONLY`): do it at the computer. A phone can create, edit (which
  switches it off), run once and delete.
- **An edit switched it off.** Changing what it runs, or when, always does. Switch it on again.
- `SCHEDULE_ON_DEMAND`: an on-demand schedule cannot be switched on; use **Run now**.

## Activity and live updates

- **"Live updates paused: too many Activity views are open"** (`STREAM_LIMIT`): one computer keeps at most 4 live views
  (each paired device has its own 4; 32 in all). Close a tab; the view tries again every 15 seconds. The Tasks tab polls
  meanwhile.
- **"Connection lost. Reconnecting…"**: the page reconnects with the last event it saw and shows each missed event once.
- **"Older events were removed when the journal reached its size limit."** The journal keeps its newest 16 files of
  8 MiB.
- **A running Codex or Gemini job shows no activity.** Codex reports only its web searches; Gemini CLI reports nothing
  until it ends. A quiet job has not stopped.
- **"Usage: not reported"**: the CLI did not report it (Gemini CLI and remote peers never do).

## Saving and editing

| Code | Why | What to do |
| --- | --- | --- |
| `REVISION_CONFLICT` | Someone (another tab, a phone) saved first. Nothing was overwritten. | **Reload**, or in Graph and Pipelines **Load the saved draft** / **Save mine as a new network** (or pipeline). |
| `NETWORK_CYCLE` | A sub-network would contain itself. The message shows the path. | Remove the marked node. |
| `NETWORK_IN_USE`, `NETWORK_PUBLISHED`, `PIPELINE_PUBLISHED` | Deleting something published or in use. | Archive the network instead; a published pipeline stays. |
| `PIPELINE_AGENT_NOT_IN_NETWORK`, `PIPELINE_PEER_NOT_IN_NETWORK` | A step names an agent or peer that is not in the pinned network version. | Add it to the network, publish, and pin that version. |
| `PIPELINE_CYCLE`, `PIPELINE_PORT`, `CONDITION_PORT`, `PIPELINE_NO_OUTPUT`, `PIPELINE_DEPTH`, `PIPELINE_TOO_LARGE` | The pipeline has a loop, a wrong port, a condition on a text port, no output, more than 4 levels of sub-pipelines, or too many steps. | **Validate** marks the step or arrow. |
| `CONFIRMATION_REQUIRED` | A run was started without its confirmation. | Use **Run…** and **Start run**. |
| `NETWORK_IMPORT_UNRESOLVED` | The file names Base agents this board does not have. Nothing was imported. | Restore the board backup that holds them, then import again. |
| `NETWORK_DATA_DAMAGED` | A Network file and its backup are both unreadable. | Restore the data folder from a backup. Promptboard never deletes the damaged file. |
| `SETTINGS_RECOVERED` (notice and Activity event) | An access or automation file was restored from its backup, which might predate a revocation or off switch. | Review the recovered values. Registrations, the listener, delegation, schedules and federation are off; enable only what you still want. Recovered clients are revoked: create new clients and copy their new tokens. Recovered memory notes are proposals and need approval again. Damaged bytes and backups remain available for inspection. |
| `NETWORK_VERSION_UNSUPPORTED` | A file was written by a newer Promptboard. | Update Promptboard. The file is not changed. |
| `NETWORK_LIMIT` | A size or count ceiling (for example 4,000 characters per memory record, 100 schedules). | Shorten it, or remove something first. |
