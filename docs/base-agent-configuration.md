# Configuring agents and MCP connections

Base owns reusable definitions. Saving a definition never starts a CLI, installs a package, contacts an MCP server or changes an assignment. Existing configurations keep their behavior until edited; resource IDs and immutable historical revisions are retained.

## Configure an agent

Open **Base → Agents**, create an agent or open an existing one. The editor has six sections and a persistent save area:

| Section | What belongs here |
| --- | --- |
| Identity and model | Name, description/tags, availability/trust, provider, model, effort, permissions, instructions and optional avatar |
| Capabilities | Reusable skills, tools, Markdown files, packs, supporting agents where supported, and the dedicated MCP selector |
| Knowledge and memory | Knowledge collections/context sources, and permissions for approved agent memory, network memory and project lessons in Network jobs |
| Output and checks | Plain text/Markdown instructions or exact JSON output, an optional supported JSON schema, and required/prohibited phrases |
| Execution policy | Kanban/Network targets, Base-only or inherited MCP connections, maximum time per session/run and maximum Base context |
| Test and compatibility | Provider/stage configuration checks, saved test cases and an explicit instruction/answer test |

An **Agent Profile** selects one primary agent and optionally supporting agents, resources and additional instructions. Both the primary agent's and profile's requirements apply. Time/context limits take the smaller value; memory permissions and execution targets intersect. Supporting agents remain native Claude Code writing-stage subagents; they do not become a new scheduler.

Supporting agents share the primary session's permissions and deadline. Their own contracts are enforced when they run as a primary agent, not as separate subagent checkpoints. Use separate Kanban runs or Network jobs when independent limits and output validation are required.

Choose **Save resource** to retain changes. **Apply to…** changes future assignments explicitly. Back/discard preserves the existing unsaved-change protection.

## Add and activate an MCP connection

1. Open **Base → MCPs → Create** and name the connection.
2. Under **Connection**, choose an MCP endpoint link, JSON configuration, or a local server command. JSON accepts `mcpServers`, VS Code `servers`, or one server object; review a server before applying it to the draft. Uploading JSON also fills a draft. A link is the provider's actual HTTP MCP endpoint, not an arbitrary website or an installer deep link.
3. Choose **Authentication**: no authentication, private/API credentials, or **Sign in with the provider** for HTTP OAuth. Save the reviewed definition as **Trusted by me** before supplying credentials or starting sign-in.
4. For API keys, enter values into the password fields and choose **Save credentials privately**. Portable configuration contains reference names only. An `Authorization` header usually needs the complete `Bearer …` value. Existing environment variables remain supported.
5. For OAuth, save the browser sign-in choice, then choose **Sign in with provider** and open the returned provider link. Complete sign-in there and return to Base. Providers may support dynamic client registration or require their own Client ID; optional scopes/client secret have dedicated fields. The provider must support an OAuth authorization-code flow with PKCE and a loopback callback; DPoP-only providers and providers requiring a fixed non-loopback callback are not supported. Use the provider's documented API credentials when appropriate.
6. Under **Tools and activation**, choose **Test connection and discover tools**. Testing initializes the configured server and lists tools/resources/prompts; it does not call a discovered tool. A local command executes only during this explicit test or an actual run and may itself download packages, for example through `npx`.
7. Choose the server-wide tools, switch availability on, and save. The connection is now offered in an agent's MCP dropdown.

Connection/authentication edits, credential changes, disconnection and failed connection tests deactivate availability. Retest and reactivate explicitly. Renaming and changing server-wide tool switches retain discovery when the connection itself is unchanged. Disconnect removes local credentials; it does not revoke the provider's grant or remove credentials already delivered to running processes. Revoke provider access from that provider when needed.

## Reuse MCP in agents

In **Capabilities → MCP connections**, select an activated, trusted, successfully tested connection. Choose its tools and whether it is required. New attachments start with no tools selected; only explicitly selected tools are permitted. New tools subsequently advertised by a server stay off. A tool disabled for the whole server cannot be re-enabled by an agent. Existing legacy attachments keep their available-tool behavior until you select an explicit allowlist. Disabled/unavailable saved attachments remain visible and removable.

MCP definitions, commands, authentication and credentials are managed exclusively in **Base → MCPs**. Agents retain references, never duplicate connection definitions. Other Base resources and packs may also reference those same catalog entries.

New agents default to **Only connections selected through Base**. Existing agents default to their previous inherited behavior. Base-only mode restricts MCP connections; it does not remove built-in CLI tools or replace normal approval/sandbox policies. Claude uses strict MCP configuration and a deny-only PreToolUse hook; explicit MCP policies require Claude Code **2.1.295+** so hook failure blocks execution. Codex disables discovered ambient servers before adding Base definitions and uses `enabled_tools`; Gemini uses a server allowlist, disables extensions in Base-only mode, and uses `includeTools` plus a deny hook. A failed isolation/version check stops launch. These controls depend on the native CLI and are not an OS sandbox against a writing agent that can alter local configuration.

MCP remains unavailable in Network jobs and strict read-only Planning/Code Review. Required incompatible attachments block; optional ones are omitted with a reason. Read-only annotations from servers are hints, not enforcement. Codex stdio environment aliases remain unsupported; references must match the variable names expected by that server. Conflicting private values for one stdio environment reference stop preparation rather than mixing credentials.

## Output requirements and limits

JSON output must parse as one JSON value without surrounding prose or fences. The bounded schema subset supports `type`, `properties`, `required`, boolean `additionalProperties`, `items`, `enum`, `const`, string/array size limits, numeric bounds, titles and descriptions. External references, patterns, unions and executable validation are refused. Schemas are limited to eight nesting levels, 20,000 characters and 50 properties per object. Text/Markdown are format instructions; use required phrases/headings for deterministic checks.

Kanban final-answer failures block confirmation/automatic turn completion and invite correction. Network marks an answer that fails its pinned checks as failed. Checks establish format and exact text, not factual accuracy. Runtime policy can shorten a Network job's limit and deny memory the job requests; it cannot grant extra access. The Kanban limit is wall-clock time for one launched session, including time waiting for input, and resets for a new run/resume. The context limit applies to Base-supplied context, not the CLI's complete conversation. No hard token or spending cap is claimed.

Network's job form reflects these limits before confirmation. An implicit default request, including a pipeline step, omits agent memory when the Base policy disables it; an explicit request for forbidden memory is refused. Existing agents without these requirements retain their defaults. Network memory currently travels together with agent memory, so both permissions must allow it.

## Tests and compatibility

**Check compatibility** resolves the saved agent for Claude/Codex/Gemini writing, Planning and Code Review contexts, without a model call or MCP connection. It reports optional omissions and required blockers. Actual assignments can add inherited resources; it does not establish installed CLI availability, login or provider access.

**Run test** uses the selected restricted CLI adapter in an empty temporary folder, through the shared job slot. It tests your question and/or saved cases against pinned instructions, saved knowledge/context text and output requirements. It has cancellation and a bounded total deadline, removes its temporary workspace, and refuses results if selected revisions changed. It does not test live sources, MCP calls, native skill activation, supporting agents, command recipes, repository access or memory writes. Test the intended workflow separately for those capabilities. Results state their coverage and selected revisions; they are displayed for the current request, not a permanent certification.

## Native skills and execution evidence

Skills default to instruction/reference text. An optional **Native skill package** delivery mode materializes reviewed supporting text files in a unique per-run plugin directory for Claude Code writing stages and passes `--plugin-dir`. Base generates the skill's metadata and strips imported policy frontmatter; it does not add hooks or permission overrides. Files load on demand, under existing CLI permissions. Saving/importing never installs or executes scripts. Other providers and read-only/Network contexts report this mode as incompatible; choose instruction delivery for portability.

Run details separate configured resources, supplied content/configuration, and observed invocation. Claude/Gemini post-tool hooks can report matching Base MCP tool identities; raw arguments/results are not retained in those observations. Codex's existing notification channel does not provide equivalent tool identity, so no invocation is invented. Output checks are not proof that a model used a selected tool.

## Local credentials and portability

Private values and OAuth tokens live under the data folder's `base-connections/`, in mode-0600 files, separate from resource revisions and Base exports. They are local plaintext protected by filesystem permissions, not an OS keychain or encrypted vault. POSIX systems use 0600 files and a 0700 directory; Windows relies on the data folder’s inherited ACLs, which Node does not replace with owner-only ACLs. Records bind to connection/authentication settings; changed endpoints/settings cannot silently reuse them. OAuth uses PKCE, random one-use state, issuer-bound discovery and a short-lived loopback callback. Metadata/token requests pin DNS, bound time/size, refuse redirects and disallow unrelated private destinations. Explicitly selected local MCP origins remain supported.

Authentication setup is restricted to the computer running Promptboard. Paired devices cannot save credentials or start/disconnect sign-in. Agent instructions, tests and selected documents may still contain private text and are sent to the chosen provider when you explicitly run a test or workflow. Keep secrets out of prompts, JSON definitions and command arguments; use the dedicated private credential fields.
