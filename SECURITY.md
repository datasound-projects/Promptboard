# Security

**Agent portraits are optional image API requests.** Only an explicit Generate action sends the avatar description to the fixed OpenAI Images HTTPS endpoint. Credentials remain in the server environment, are never collected from CLI sign-in, and are excluded from definitions, logs, exports, and errors. Responses are bounded raster PNG/JPEG content, never SVG/HTML. Saving stores image content in immutable resource revisions outside state metadata; avatar reads require the existing session token. Portraits are not supplied to coding agents. Export includes image bytes only when document content is explicitly selected. Generation uses the existing job coordinator and scoped cancellation/shutdown handling.

**Nested agent profiles use native CLI delegation.** Claude writing-stage subagents receive bounded session-scoped JSON with pinned instructions/context. They inherit the parent permission mode; Base never passes a subagent permission override, installs an agent file, changes global settings, or creates a second scheduler. Incompatible providers/stages report omissions or block required selections. MCPs remain subject to the session’s permissions; resource selection is not a claim of tool exclusivity or observed invocation.

Promptboard is a local, single-user app. It starts AI coding agents that can edit files in your repositories, so read this before you use it with sensitive code.

## Reporting a vulnerability

Report problems privately through GitHub: **Security → Report a vulnerability** on this repository. Do not open a public issue, and do not attach credentials, private code, or prompt history.

## What the app does to protect you

**Local only.** The server binds to `127.0.0.1` and checks the Host, Origin, and fetch-site headers. Every API request needs a per-process token, sent in a header and never in a URL. Pages use a strict content security policy with no inline scripts or styles. Do not expose the port through a proxy or tunnel.

**No shell interpolation of user text.** CLIs, Git, and your test commands start through `execFile`/`spawn` without a shell. Task text is passed as one argument or pasted into the terminal, never interpolated into a command. Kanban provider executables and flags remain adapter-controlled. A Base stdio MCP definition is an explicit exception for the program and argument list: it is user-configured, must be trusted, and can execute only through an explicit connection test or an authorized agent run. A command recipe is instruction text for the existing CLI, not a separate tool executor.

**Agents stay in their worktree.** Each task gets its own Git worktree and branch outside your checkout. Planning and Code Review use each CLI's read-only mode (Claude Code plan mode with read tools only, Codex `--sandbox read-only`, Gemini plan mode plus a deny policy). Executing uses the CLI's normal approval mode. Promptboard never passes bypass, "yolo", or full-access flags and never pre-trusts a folder. Selected Base MCP definitions use generated per-run configuration outside the worktree; global CLI configuration, credentials, provider home directories, and tracked project instruction files are not changed.

**You confirm the important steps.** Runs start only when you start them or turn on automatic start for a stage. A stage succeeds only when you confirm it. Commits and branch updates need confirmation. Merges need confirmation unless you turn on **Merge automatically** for a project; even then Promptboard merges only when the accepted review and passing tests belong to exactly the current task and target commits. Merges are fast-forward only. The only push is **Open pull request**: after you confirm, the task branch (never another branch) is pushed without `--force` and a pull request is opened with the GitHub CLI; its description is yours, and the task prompt is not sent unless you add it. Testing and Merge agents write only in the task worktree; they are told not to commit, merge, rebase, reset, or push, and Promptboard refuses to commit files that still contain conflict markers. Setting up Git in a new folder (`git init` plus one empty commit) happens only after you confirm it, and never adds your files. Promptboard never force-resets, stashes, or deletes a dirty worktree.

**Autopilot is opt-in per project.** Starting it needs an explicit acknowledgment, because it then confirms finished agent turns, commits, accepts reviews with no issues, and merges (through the same gate as a manual merge) or pushes the task branch for a pull request without asking each time. It advances only when an agent has finished its turn, never while an agent waits for permission, and it pauses on anything unexpected.

**Processes are owned.** Stopping a run, or Promptboard itself, stops only the process groups it started.

**Credentials stay with the CLI.** Promptboard never reads, copies, or logs CLI credential files, and does not copy them into worktrees.

**Base is optional context, not an authorization boundary.** Creating, enabling, importing, or assigning a resource never starts a run, installs packages, approves a command, or changes a provider. Trust, availability, assignment, connection status, and compatibility are separate. Imported resources begin inactive and untrusted. Executable definitions require explicit trust; trusting them does not weaken the agent's permission mode. Base MCPs and command recipes are unavailable in Planning and Code Review, regardless of MCP `readOnlyHint` annotations.

**Connection tests execute real protocol operations.** An explicit trusted MCP test initializes the server and discovers its supported capabilities. Stdio testing executes its configured program; local HTTP MCP endpoints can deliberately contact local services. Tests have bounded output, timeouts, cancellation, and owned-process cleanup. They never run on save, page load, import, or assignment and do not invoke discovered tools. Selecting one MCP tool supplies its parent server; it does not claim to hide other tools on that server. Codex may also expose MCPs from its ambient configuration, which Base does not isolate.

**Sources and secrets.** MCP environments and HTTP headers store variable names, not credential values. Resolved credentials are not placed in resource previews, prompt sections, exports, manifests, or application diagnostics. Repository context resolves in the run's task worktree. External roots need explicit approval and can be revoked; real-path, symlink, excluded-file, traversal, and size checks apply. Dependency folders, generated output, and common secret files are excluded. Public documentation requests check DNS addresses and every redirect, pin the checked address, reject private networks and credential-bearing URLs, and limit fetched text. These document rules are separate from explicitly configured MCP endpoints.

**Documents are untrusted.** Base text and wiki Markdown are rendered with safe DOM text nodes and a limited Markdown renderer; imported HTML is not inserted into the page. Selected instructions, documents, command recipes, and tool output can still influence a model. Local storage does not prevent selected context from being sent through a cloud-backed CLI. Wiki generation is optional, uses the same restricted generation job coordinator as Compose, and produces a reviewable draft. Cancellation targets its operation ID; stale updates cannot overwrite a newer wiki revision.

**Persistence and revocation.** Base uses Board's serialized Store. Immutable content is saved before its metadata is published. State version 2 migrates explicitly to version 3 with a retained original backup; migration errors and unknown newer versions are not treated as an empty installation. Resource and assignment revisions are independent of run polling. Accepted runs pin definition revisions; current disablement, missing resources, revoked trust, and source access revocations prevent queued delivery without substituting newer content. Revocation does not remove context already supplied to a running process. Deleting a referenced resource requires detachment; historical immutable definitions and supplied context remain in the local data directory.

**GitHub through the GitHub CLI.** Sign-in runs the official `gh auth login --web`; Promptboard reads only the one-time code that gh prints for you and declines gh's global Git credential setup. Tokens stay in gh's keychain storage and never reach the board, the browser, logs, URLs, process arguments, or Git remotes. A managed clone lives in the data folder; for an HTTPS remote it gets `gh auth git-credential` as a credential helper in that clone's own config only. Fetch never changes a branch; updating the target branch is a confirmed fast-forward. Disconnecting a project never signs gh out.

**Usage data.** The Usage panel scans known local Claude, Codex, and Gemini session directories, including sessions outside Promptboard, for the last 30 days. It reduces structured records to numbers, model IDs, timestamps, and tool names; transcript text and tool arguments are not retained or returned. Scans are bounded, skip symlinks and oversized files, and label incomplete coverage. No credential files are read. Codex account limits use its read-only app-server method. New Promptboard Claude sessions have a per-process status-line command that saves only whitelisted usage fields to their run folder; global CLI configuration is not edited. A refresh failure never fabricates available quota or costs.

## Limits

- An agent in Executing can run any command its CLI allows in the task worktree, with your user's permissions. Review what it asks to do.
- Worktrees are created with Git hooks disabled. Commits and merges you confirm run your repository's normal Git hooks, like any commit you make yourself. The agent's own commands and your test commands also run normally.
- These controls do not protect against other software that already runs as your user.
- Prompt boundaries and read-only modes are enforced by each CLI, not by an operating-system sandbox. A CLI bug can weaken them.
- Prompt text, run output, plans, Base documents, and supplied context are stored unencrypted in the data folder and may be sent to your provider through its CLI. **Do not put API keys, tokens, passwords, or private code you cannot share with your provider into prompts, tasks, or resource documents.** Resource and board exports include document bodies only when requested; review them before sharing. Imports remap resource IDs and external-root references rather than reusing local access grants.

## Changes that need extra review

- CLI flags, permission modes, hook or notify handling, and executable lookup.
- Git worktree, commit, merge, and cleanup code.
- Process start, stop, time limits, and output limits.
- HTTP binding, token and origin checks, static routes, and the content security policy.
- Anything that renders agent output (it must stay text, never HTML).
- Base trust/revocation, immutable revisions, MCP configuration and discovery, source containment and network fetching, import remapping, and wiki job coordination.

Do not add automatic approval bypass, shell interpolation, remote binding, force-push, pushing without confirmation, or conflict resolution that skips the marker check and the user's commit.
