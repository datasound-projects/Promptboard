# Set up private MCP, REST and A2A

Network can serve your registered agents to other programs: MCP hosts and scripts on this computer, and (optionally)
outside A2A agents. It can also call remote A2A agents from a pipeline. Everything here is **off until you turn it on at
this computer**; a paired phone can look and revoke, but cannot turn anything on.

- [External clients: the machine listener](#the-machine-listener)
- [MCP: Claude Code, Codex and other hosts](#mcp)
- [REST with curl](#rest)
- [A2A federation: inbound and outbound](#a2a-federation)
- [Troubleshooting](#troubleshooting)

Every job a client, a caller or a peer step starts is an ordinary Network job: read-only, in an empty folder, run by your
signed-in CLI, and listed in Activity. See the [user guide](user-guide.md) for what a job can and cannot do.

## The machine listener

1. **Network → Settings → Machine listener.** Check the port (4330 by default; 1024–65535, not the app's or remote
   access's port), **Save port**, then turn on **Listen for external clients**. The status line says "On at
   http://127.0.0.1:4330: this computer only."
2. **Clients → Create client.** Name it after the program that uses it (one client per app or host, so you can revoke one
   alone). Choose:
   - **Agents it may use** (at least one);
   - what **It may** do:

     | Permission | Lets the client | Default |
     | --- | --- | --- |
     | `read_agents` "See its agents" | list its agents: name, provider, tool modes; never instructions or Base content | on |
     | `submit_jobs` "Submit jobs" | queue read-only jobs for those agents | on |
     | `read_job_result` "Read results" | read the results of jobs it submitted | on |
     | `cancel_own_jobs` "Cancel its jobs" | cancel its own jobs that have not ended | on |
     | `read_scoped_memory` "Jobs may read memory" | let its jobs read the agent's approved memory and the chosen projects' lessons | off |

   - **Projects** and **Networks** its jobs may name (optional), and an expiry (never, 30 days, 90 days or a year).
3. The token (`pbm_cli_…`) is shown **once**. **Copy token**, then **Done**: the token leaves the page. Promptboard keeps
   only its SHA-256, so a lost token cannot be shown again; **Rotate token** makes a new one.

The listener binds `127.0.0.1` only and serves only `/machine/v1/*` (and the A2A paths below). It refuses the app's own
session token and a paired phone's cookie, refuses requests with a foreign Host or Origin, cross-site requests and proxy
headers, and never sends a CORS header. The owner app, in turn, refuses any `Authorization: Bearer pbm_…`.

A client never gets owner access: it cannot approve, retry, close or delete jobs, change settings, or reach Base, Kanban,
memory screens or another client's jobs. Another client's job, or yours, looks exactly like a missing one (`404`).

**Rotate token** keeps the client, its jobs and its keys; the old token stops at once, also on open streams. **Revoke**
is final; the client's jobs keep running (cancel them in Activity). Scopes cannot be edited: create a new client and
revoke the old one.

### Token handling

- Never put the token in a file you share, a repository or a command line. `node bin/ste.mjs --mcp` refuses any option
  and never repeats a `pbm_` value in an error.
- Give it to the host through its environment: `PROMPTBOARD_MACHINE_TOKEN`, or a file only you can read named by
  `PROMPTBOARD_MACHINE_TOKEN_FILE` (used when `PROMPTBOARD_MACHINE_TOKEN` is not set).
- `PROMPTBOARD_MACHINE_URL` is the listener (default `http://127.0.0.1:4330`). It must be plain `http` to `127.0.0.1`,
  `localhost` or `[::1]`, with no user, path, query or fragment, so the token never leaves this computer.

## MCP

`node <Promptboard folder>/bin/ste.mjs --mcp` is an MCP server over stdio. It holds one client's token and nothing else,
and calls the machine listener for every tool, so it can do exactly what that client may do over REST.

**Network → Settings → Connect an MCP host** shows these snippets with the real path of your Promptboard folder and
your listener's address; **Copy snippet** copies them. They never contain a token. Below,
`/path/to/Promptboard` stands for that folder.

**Claude Code:** save as `.mcp.json` in your project. Claude Code fills in `${PROMPTBOARD_MACHINE_TOKEN}` from the
environment it starts in.

```json
{
  "mcpServers": {
    "promptboard": {
      "command": "node",
      "args": [
        "/path/to/Promptboard/bin/ste.mjs",
        "--mcp"
      ],
      "env": {
        "PROMPTBOARD_MACHINE_URL": "http://127.0.0.1:4330",
        "PROMPTBOARD_MACHINE_TOKEN": "${PROMPTBOARD_MACHINE_TOKEN}"
      }
    }
  }
}
```

```bash
export PROMPTBOARD_MACHINE_TOKEN='pbm_cli_…'   # in the shell that starts Claude Code
claude
```

**Codex:** add to `~/.codex/config.toml`. `env_vars` passes `PROMPTBOARD_MACHINE_TOKEN` from the shell that starts Codex.

```toml
[mcp_servers.promptboard]
command = "node"
args = ["/path/to/Promptboard/bin/ste.mjs", "--mcp"]
env = { PROMPTBOARD_MACHINE_URL = "http://127.0.0.1:4330" }
env_vars = ["PROMPTBOARD_MACHINE_TOKEN"]
```

**Other MCP hosts:** most take this JSON. Save the token in a file only you can read (`chmod 600`) and name it here, or
set `PROMPTBOARD_MACHINE_TOKEN` in the host's environment instead.

```json
{
  "mcpServers": {
    "promptboard": {
      "command": "node",
      "args": [
        "/path/to/Promptboard/bin/ste.mjs",
        "--mcp"
      ],
      "env": {
        "PROMPTBOARD_MACHINE_URL": "http://127.0.0.1:4330",
        "PROMPTBOARD_MACHINE_TOKEN_FILE": "/path/to/a/file/only/you/can/read"
      }
    }
  }
}
```

### Tools

| Tool | What it does |
| --- | --- |
| `agents_list` | The agents this client may use, with provider and tool modes. |
| `agents_get` | One of them (`agentId`). |
| `jobs_submit` | Queues a read-only job: `agentId`, `input` (text), optional `instructions`, `tools` (`none`/`web`), `projectId`, `networkId`, `memory` (`none`/`agent`/`agent+network`), `projectLessons`, `timeoutMinutes` (1–120), `requireApproval`, `idempotencyKey`. Answers `{ jobId, status, deduplicated }` at once; it never waits for the run. |
| `jobs_get` | The status of one of its jobs: queued, waiting_for_approval, preparing, running, waiting_for_input, completed, failed, cancelled, unknown or interrupted. |
| `jobs_cancel` | Cancels one of its jobs that has not ended. |
| `artifacts_get` | A completed job's result in windows (`offset`, `maxChars`; pass `nextOffset` back until it is `null`). The result's json comes with the first window when it is at most 16 KB. |
| `jobs_delegate` | Requests a sub-job (`jobId`, `agentId`, `task`, optional `idempotencyKey`), subject to the owner's handoff policy, relation, scope and approval checks. Returns its job ID immediately. |
| `jobs_answer` | Answers a question from its own waiting job (`jobId`, `text`); the job resumes as a new attempt. |
| `messages_list` | Its job's questions, results and notes in whole-message windows (`jobId`, optional `offset`; follow `nextOffset`). |
| `messages_post` | Adds a `review` or `request` note (`jobId`, `kind`, `text`, optional `json`); saving a note starts nothing. |
| `messages_mark_read` | Marks messages addressed to this client as read (`jobId`, optional `ids`; omit for all unread messages). |

Poll `jobs_get` until the status is completed, failed or cancelled, then call `artifacts_get`. Reuse the same
`idempotencyKey` when you retry a submit: the same key answers the same job. Inputs are strict: an unknown field is an
error. Tool annotations are hints for the host only; the listener decides every call. Each call has a 15-second limit and
every answer stays under 60,000 bytes.

For `waiting_for_input`, use `messages_list` to read the question and `jobs_answer` to answer it, or wait for the
sub-jobs shown in its record. An `unknown` or `interrupted` job needs the owner's decision rather than more polling.

**No deadlock.** A host whose own job runs on the same CLI can still call `jobs_submit`: the new job only queues until a
slot is free. Network jobs themselves never receive MCP servers, so a job cannot call this server.


## REST

The **REST** tab of **Connect an MCP host** shows the first two calls with your address. Every call needs
`Authorization: Bearer $PROMPTBOARD_MACHINE_TOKEN`; bodies are JSON (`Content-Type: application/json`, at most 256 KiB).

```bash
URL=http://127.0.0.1:4330
AUTH="Authorization: Bearer $PROMPTBOARD_MACHINE_TOKEN"

# The agents this client may use (read_agents)
curl -s -H "$AUTH" $URL/machine/v1/agents

# Submit a job (submit_jobs): 202 with a jobId at once; the same Idempotency-Key again answers the same job (200)
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" -H "Idempotency-Key: first-job" \
  -d '{"agentId":"agt_…","input":{"text":"Summarise the release notes."}}' \
  $URL/machine/v1/jobs

# Poll it, then read the result (read_job_result)
curl -s -H "$AUTH" $URL/machine/v1/jobs/job_…
curl -s -H "$AUTH" $URL/machine/v1/jobs/job_…/result

# Its own jobs, cancel one (cancel_own_jobs)
curl -s -H "$AUTH" "$URL/machine/v1/jobs?status=running"
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" -d '{}' $URL/machine/v1/jobs/job_…/cancel

# Events of its own jobs: a page, or a live NDJSON stream
curl -s -H "$AUTH" "$URL/machine/v1/events?after=0&limit=100"
curl -sN -H "$AUTH" "$URL/machine/v1/events/stream?after=0"
```

A submit takes `agentId`, `input: { text, json? }` and optionally `instructions`, `tools` (`none` or `web`),
`permissions: { memory, projectLessons }`, `limits: { timeoutMs }`, `requireApproval`, `projectId` and `networkId`.
Memory is `none` unless the client has `read_scoped_memory`. A job answers `{ jobId, agentId, projectId, networkId,
status, outcome, errorCode, reason, createdAt, updatedAt, attempts, result, waiting }`; the result route answers
`{ jobId, text, json, chars }` once the job completed.

The stream sends missed events after `after`, then `{"live":true,"last":N}`, then each new event, and `{"ping":true}`
every 15 seconds. Keep the last `seq` you saw and reconnect with `?after=<seq>`: each event arrives once.
`{"gap":true}` means older events were removed; `{"reset":true}` means reload.

**Handoffs on your own jobs** (when the owner's handoff policy allows them; see the [user guide](user-guide.md#delegation-and-questions)):

| Route | Permission | What it does |
| --- | --- | --- |
| `POST /machine/v1/jobs/<id>/children` | `submit_jobs` | A sub-job of one of its jobs: `{ agentId, task, tools?, json? }` and an `Idempotency-Key` header; 202. It counts as a submit and stays inside the client's agents. |
| `GET /machine/v1/jobs/<id>/messages` | `read_job_result` | The job's handoff messages and how many to this client are unread. |
| `POST /machine/v1/jobs/<id>/messages/read` | `read_job_result` | Marks messages read (`{ ids? }`). |
| `POST /machine/v1/jobs/<id>/messages` | `submit_jobs` | Adds a note: `{ kind: "review" or "request", text, json? }`; 201. |
| `POST /machine/v1/jobs/<id>/answer` | `submit_jobs` | Answers the question the job asked: `{ text }`. |

Limits per client: 60 requests and 10 submits a minute (refused submits count too); 4 open event streams per client and
8 machine streams in all.

## A2A federation

A2A lets independent agents talk to each other. Promptboard speaks **A2A 1.x over JSON-RPC** only (the official
`@a2a-js/sdk` 1.3.0). **Network → Federation** holds both directions; each is off until you turn it on.

### Inbound: outside agents use your agents

1. Turn on the machine listener ([above](#the-machine-listener)). Inbound A2A is served there, on `127.0.0.1` only.
2. **Federation → Inbound A2A → Published for A2A:** tick the agents to offer, give each a one-line description for
   callers and, if you like, **Each task waits for my approval**. **Save published agents**.
3. Turn on **Accept A2A tasks**. The status line and the card line show the addresses:
   - Agent Card: `http://127.0.0.1:<port>/.well-known/agent-card.json` (public, as A2A discovery expects);
   - endpoint: `http://127.0.0.1:<port>/a2a/v1`.
4. **A2A callers → Create caller…** for each outside agent: its published agents and what it may do (send tasks, read
   results, cancel its tasks; memory off by default). Its token is shown once; the caller sends it as
   `Authorization: Bearer <token>` to the endpoint.

The card names "Promptboard" and lists one skill per published agent (its registration ID, name and your description;
never Base content). Both paths answer `404` while inbound is off or no published agent can take work.

What a caller can do: send one message (text parts and at most one JSON data part) to one published agent in its scope
(name it in `metadata.skillId` when it may use more than one), then read or cancel that task. **The task ID is the job
ID**, so a task survives a restart. A blocking send waits until the job ends or needs you, at most 10 minutes; for long
work send with `returnImmediately` and read the task later. The same `messageId` again answers the same task.

Refused: follow-up messages to a task, files and links, streaming, task lists, push notifications and the extended
card. Job states read as task states:

| Job | A2A task state |
| --- | --- |
| queued, waiting for approval | SUBMITTED |
| preparing, running, waiting for input | WORKING |
| completed | COMPLETED, with the result as one artifact when the caller may read results |
| failed | FAILED |
| cancelled | CANCELED |
| outcome unknown, interrupted | UNSPECIFIED ("The outcome of this task is not known …"); you decide in Activity |

An A2A caller token works only on `/a2a/v1`, and an API client token only on `/machine/v1`. A2A callers appear in
Settings too and share its 100-active-clients limit, rotation and revocation. Jobs started over A2A cannot delegate.

### Outbound: your pipelines call remote agents

1. Turn on **Call trusted remote peers**. While it is off, Promptboard contacts no peer at all.
2. **Add peer…:** the peer's Agent Card URL. **Preview card** fetches it once and saves nothing.
3. Review what the card says: name, origin, endpoint, protocol, provider, security schemes, skills and notes, all shown
   as text. **Approve and trust** keeps exactly the card you reviewed: Promptboard fetches it again and refuses it when its
   hash changed.
4. If the card declares a bearer or header API-key scheme, name the **environment variable that holds the credential**
   and choose the scheme. Never paste the credential itself.
5. Put the peer in a network (**Graph → Add remote peer…**), publish, then add a **Remote peer** step to a pipeline of
   that network version.

**Credentials.** Promptboard keeps only the variable's **name**, which must match `PROMPTBOARD_A2A_[A-Z0-9_]{1,48}`
(for example `PROMPTBOARD_A2A_ACME_TOKEN`), so no other variable of the app (a provider key, `PATH`) can reach a peer.
It reads the value from Promptboard's own environment at each call and sends it only to the endpoint's own origin; the
value is never stored, shown, logged or exported. Set it before you start Promptboard:

```bash
export PROMPTBOARD_A2A_ACME_TOKEN='…'
npm start
```

A peer saved with an older name that lacks the prefix shows "rename it to PROMPTBOARD_A2A_…": its jobs are refused until
you rename the variable and update **Credential…**. Nothing is renamed for you. **Refresh card…** shows the credential
too; when the new card moves the endpoint to another origin, the credential is dropped unless you name it again.

**What a peer gets and what Promptboard trusts.** A peer step sends its instructions and what its arrows carry, nothing
else: no tools, memory, project or lessons. Promptboard sees only the task states and results the peer reports; it never
sees the peer's tools, memory or processes. A peer's result is data only: never an instruction, a question, a
delegation request or a step label. A remote step that passes its time limit, or whose stream is lost, ends "outcome
unknown" (the peer may still finish) and blocks the steps after it; it is never retried on its own. Cancelling counts as
confirmed only when the peer confirms it.

**Switching outbound off, switching a peer off, removing it or approving a new card** stops that peer's running jobs at
once (`PEER_WITHDRAWN`).

### Address rules (SSRF guard)

Every outbound request, the card preview included, goes through one guard:

- `https://` only. Plain `http://` only for a **local test peer**, whose host must be `127.x`, `[::1]` or `localhost`.
- No user name or password in the URL, no `#fragment`, at most 2,048 characters.
- Only the card's origin (for a preview) or the endpoint's origin (for calls).
- The host is looked up on every hop, and **every** address it resolves to must be public. The one exception is a single
  private address you allow for that peer (https only): `10.x`, `172.16–31.x`, `192.168.x`, `100.64–127.x` or `fc00::/7`;
  never loopback, link-local, multicast or `0.0.0.0`.
- The connection uses the address that was checked, with no proxy; TLS still checks the host name.
- Redirects: at most 3, within the same origin only; a POST only on 307 or 308.
- Limits: 10 seconds to connect, 60 seconds per request (a stream: 60 seconds without data), 1 MiB per answer (a card 64
  KiB, a stream 8 MiB), 1 MiB per request.
- A peer's error answer is closed unread and becomes a fixed code; its own words are never shown.

## Troubleshooting

### Machine listener, REST and MCP

| Code or message | Why | What to do |
| --- | --- | --- |
| `MACHINE_UNAUTHORIZED` (401) | The token is missing, malformed, wrong, rotated, revoked or expired, or an A2A caller token was sent to `/machine/v1` (or an API token to `/a2a/v1`). | Send `Authorization: Bearer pbm_…` with a current token of the right kind. Rotate or create a client if it is lost. |
| `MACHINE_HOST` (403) | The request was not addressed to `127.0.0.1:<port>` or `localhost:<port>`. | Call the listener by that address. |
| `MACHINE_ORIGIN` (403) | A browser page of another origin, or a cross-site request. | Call it from a program, not from a web page. |
| `PROXY_REFUSED` (403) | A proxy header (`X-Forwarded-For`, `Forwarded`, `Via`, …) was sent. | Call the listener directly. |
| `MACHINE_CREDENTIAL_REQUIRED` (403) | The app's own token or a paired phone's cookie was sent to the listener. | Use a client token from Network → Settings. |
| `MACHINE_TOKEN_REFUSED` (403) | A `pbm_` token was sent to the app itself (its own port, 4318 by default). | Client tokens work only on the machine listener. |
| `PERMISSION_DENIED` (403) | The client lacks the route's permission. | Create a client with that permission. |
| `AGENT_NOT_ALLOWED`, `PROJECT_NOT_ALLOWED`, `NETWORK_NOT_ALLOWED` (403) | The agent, project or network is outside the client's scope. | Use one in scope, or create a new client. |
| `MEMORY_NOT_ALLOWED` (403) | Memory or project lessons were asked for without `read_scoped_memory`. | Leave memory out, or create a client with it. |
| `RATE_LIMITED` (429) | More than 60 requests or 10 submits a minute. | Wait a minute (`Retry-After: 60`). Poll less often. |
| `STREAM_LIMIT` (429) | The client has 4 streams open, or 8 machine streams are open in all. | Close a stream, then reconnect. |
| `IDEMPOTENCY_CONFLICT` (409) | The same `Idempotency-Key` was sent with a different request. | Use a new key for a new job. |
| `BODY_TOO_LARGE` (413), `UNSUPPORTED_MEDIA_TYPE` (415) | A body over 256 KiB, or not JSON. | Send smaller JSON with `Content-Type: application/json`. |
| `NOT_FOUND` (404) | The job does not exist, or it is not this client's. | Use a job ID this client submitted. |
| `PORT_IN_USE` (409) | The port is the app's or remote access's. | Choose another port. |
| "Not listening: Port N is already in use." | Another program holds the port. | Choose another port and save it. |
| `REMOTE_LOCAL_ONLY` (403) | Turning the listener on, creating or rotating a client from a paired phone. | Do it at the computer. |
| `CLIENT_REVOKED`, `CLIENT_EXPIRED` (409) | Rotating a revoked or expired client. | Create a new client. |
| `NETWORK_LIMIT` (409) | 100 active clients already. | Revoke one first. |

`node bin/ste.mjs --mcp` exits with code 1, before it serves anything, when:

- "--mcp takes no other option." — remove every other option; configuration comes only from the environment;
- "No Promptboard client token." — set `PROMPTBOARD_MACHINE_TOKEN` or `PROMPTBOARD_MACHINE_TOKEN_FILE`;
- "PROMPTBOARD_MACHINE_TOKEN_FILE cannot be read." — check the path and its permissions;
- "The Promptboard client token is not valid." — copy the whole `pbm_cli_…` token again, or rotate it;
- "PROMPTBOARD_MACHINE_URL must be the machine listener on this computer" — use `http://127.0.0.1:<port>`.

Inside the host, a refused call is a tool error with the listener's message and code, for example "This client may not
use this agent. (AGENT_NOT_ALLOWED)". "Promptboard did not answer at http://127.0.0.1:4330" means the listener is off or
on another port.

### A2A

| Code | Why | What to do |
| --- | --- | --- |
| `FEDERATION_OFF` | Outbound federation is off: no preview, no peer call, no remote step. | Turn on **Call trusted remote peers**. |
| `A2A_URL_INVALID` | Not an absolute URL, longer than 2,048 characters, with a user name or password, or a `#fragment`. | Use a plain `https://` card URL. |
| `A2A_URL_INSECURE` | `http://` to a remote peer, or a local test peer that is not on this computer. | Use `https://`, or tick **Local test peer** only for `127.0.0.1`, `::1` or `localhost`. |
| `A2A_ADDRESS_REFUSED` | The host resolves to a private, local or reserved address. | Use a public host, or allow that peer's one private address (https). |
| `A2A_ORIGIN_REFUSED` | A request to an origin that is not the card's or the endpoint's. | The peer must serve its endpoint where its card says. |
| `A2A_REDIRECT_REFUSED` | A redirect to another origin, more than 3 redirects, or a POST redirected with 301/302/303. | Use the final URL. |
| `A2A_REQUEST_TOO_LARGE`, `PEER_RESPONSE_TOO_LARGE` | A request or an answer over its size limit. | Send less input; ask the peer for a smaller answer. |
| `PEER_UNREACHABLE` | The host name could not be resolved in time. | Check the URL and your connection. |
| `CARD_INVALID`, `CARD_UNSUPPORTED`, `CARD_ENDPOINT_REFUSED` | The card is not valid JSON or has no name; it offers no A2A 1.x JSON-RPC endpoint; or its endpoint breaks the address rules. | The peer must publish an A2A 1.x JSON-RPC card. |
| `CARD_CHANGED` | The card changed between your review and **Approve**. | Preview it again and review the new card. |
| `PEER_EXISTS` | That card URL is already trusted. | **Refresh card…** on the existing peer. |
| `CREDENTIAL_REFERENCE_INVALID` | The variable name lacks the `PROMPTBOARD_A2A_` prefix (also a peer saved before the rule). | Rename the variable in your environment and in **Credential…**. |
| `CREDENTIAL_MISSING`, `CREDENTIAL_INVALID` | The variable is not set in Promptboard's environment, or its value cannot be sent as a header. | Set it, then restart Promptboard. |
| `CREDENTIAL_SCHEME_UNSUPPORTED` | The card's scheme is not a bearer token or a header API key, or the card no longer offers it. | Choose another scheme, or ask the peer. |
| `PEER_DISABLED`, `PEER_NOT_FOUND` | The peer is switched off, or no longer trusted. | Switch it on or add it again. |
| `PEER_CHANGED` | The peer's card changed after the job was accepted. Nothing was sent. | Submit the job again. |
| `PEER_SCOPE` | A peer job asked for tools, memory, a project or lessons. | A peer gets only instructions and input. |
| `PEER_WITHDRAWN` | Trust ended while the job ran (outbound off, peer off, removed, or a new card). | Nothing more is sent. The peer may still finish; decide in Activity. |
| `REMOTE_AUTH`, `REMOTE_NOT_FOUND`, `REMOTE_BUSY`, `REMOTE_REFUSED`, `REMOTE_SERVER_ERROR` | The peer answered 401/403, 404, 429, another 4xx, or 5xx. | Check the credential and the endpoint, or try later. |
| `REMOTE_FAILED`, `REMOTE_CANCELLED`, `REMOTE_REJECTED` | The peer reported the task failed, cancelled or declined. | See the peer. |
| `REMOTE_INPUT_REQUIRED`, `REMOTE_AUTH_REQUIRED` | The peer asked for more input or authentication, which this version cannot give. | The job ends failed; the remote task may stay open there. |
| `REMOTE_STREAM_LOST`, `REMOTE_UNREACHABLE`, `REMOTE_PROTOCOL`, `REMOTE_STATE_UNKNOWN`, `TIMEOUT` | The answer was lost or could not be trusted, or the time limit passed. | The job is "outcome unknown": the peer may have done the work. Retry (confirming it) or close it. |
| `AGENT_NOT_PUBLISHED` (409) | An A2A caller was given an agent that is not published for A2A. | Publish it first. |
| `404` on the card or `/a2a/v1` | Inbound is off, or no published agent can take work (with the machine listener off, nothing answers at all). | Turn on the listener and **Accept A2A tasks**; switch the agent on or fix it in Base. |

More job-level errors: [Troubleshooting](troubleshooting.md).
