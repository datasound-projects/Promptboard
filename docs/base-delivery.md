# Base delivery and verification

Connection tests and source refreshes publish new resource revisions. Save editor changes before either action; the editor reloads the current revision and results afterward, including failed connection tests. Refresh replaces only sources marked as managed refresh captures and preserves pasted/uploaded sources and wiki pages. Older captures without a refresh marker are retained as standalone sources, so upgrading cannot silently delete them. Pages retrieved from different knowledge collections have distinct source IDs while provenance retains the original collection and page IDs.

Base definitions and assignment previews do not start programs. A normal Kanban run resolves the actual provider and column, pins immutable definitions, then prepares selected resources in the existing Supervisor before the CLI starts. Required failures stop launch; optional omissions appear in the manifest. Resource changes apply to future accepted runs. Current disablement, trust revocation, and deletion also block a queued snapshot from launching. Running CLI sessions are not reconfigured.

An available pack expands its members in declared order. Required packs make their members required; a member's own declared requirement is also retained. Dependency requirements propagate to a fixed point. A more-specific explicit selection can change an inherited requirement. Disabled or untrusted optional packs do not expand, while independently attached members can still be supplied. Excluding a pack excludes its members; a later scope may explicitly add one back.

## Delivery matrix

| Resource | Claude Code | Codex CLI | Gemini CLI |
| --- | --- | --- | --- |
| Skill instructions/supporting text | Delimited message section | Delimited message section | Delimited message section, existing JSON prompt encoding |
| Wiki and retrieved context | Bounded message section and captured artifact | Same | Same |
| Profile instructions | Delimited message section at its configuration scope | Same | Same |
| Command recipe | Instruction text; existing shell approval applies | Same | Same |
| Stdio MCP | Per-run strict MCP JSON file | Per-run `-c mcp_servers…` overrides | Merged per-run system settings and server allowlist |
| Streamable HTTP MCP | Per-run `type:http` definition | Per-run URL and `env_http_headers` | Per-run `httpUrl` definition |
| MCP tool reference | Parent server supplied; other server tools remain exposed | Same | Same |

Planning and Code Review cannot receive Base MCP servers or command recipes. MCP `readOnlyHint` is not enforcement. Optional incompatible attachments are omitted with an explanation; required ones block. Base does not enable Antigravity for Kanban. No native skill package loading is claimed: scripts in imported skills are reference text and never run automatically.

Provider permission modes, hooks, Codex notify, Claude usage status line, Gemini administrator settings, model/effort options, long-prompt paste, the exact card prompt, and required evidence retain their existing paths. Generated configuration stays outside task worktrees. Claude uses its strict MCP configuration; Gemini uses a selected-name allowlist. Codex's ambient MCP configuration is **not isolated**: the manifest distinguishes Base-managed configuration from external CLI configuration.

Credentials are environment-variable references. Claude and Gemini support reference aliases; Codex stdio delivery requires matching names because its `env_vars` forwards names and embedding resolved aliases in arguments would expose credentials. HTTP header references may include a complete bearer header value in the referenced environment variable. Base never reads CLI credential files, copies credentials, changes provider homes, performs global setup, or grants tool approval. Gemini `trust` remains false.

## Explicit MCP tests

The pinned `@modelcontextprotocol/client` 2.2.0 SDK performs initialization and supported tools/resources/prompts discovery over stdio or Streamable HTTP. Tests need a trusted definition and an explicit action. Stdio discovery executes that definition's program. A small pipe bridge owns its process group and stops descendants when discovery ends; it does not implement MCP or invoke tools. HTTP discovery permits deliberately configured local endpoints, rejects redirects, and does not use CLI OAuth credentials. It needs declared environment headers when authentication is required.

Discovery is bounded by time, message/output sizes and pagination, returns sanitized identities, and closes its connections. No connection test occurs on import, save, attach, or page load. “Supplied” means instructions/context or native configuration were delivered. It does not prove that the model invoked a tool. Observed invocation is a separate fact and is not inferred from attachment.

## Sources and capture

Text/Markdown and supported source files are selected against the run's actual worktree. External roots need explicit approval; each capture checks real paths, symlink containment, excluded secrets/generated paths, file identities, size limits and cancellation. URL documents resolve and pin public DNS addresses on each redirect. Private/local document URLs, credentials and query strings are refused. Local MCP endpoints use their separate explicit connection boundary.

Knowledge uses a bounded hash-cached lexical index, with a per-resource character budget, estimated token counts and omitted-section reporting. Captures keep source references, timestamps and hashes. Live sources are captured at launch; their earlier contents and remote model behavior are not claimed to be replayable. Persistent captured context files and the sanitized manifest stay with run evidence. Temporary native configuration is removed on exit or failed preparation.

## Documentation and installed versions checked

On 2026-10-02, installed help/version and official configuration references were checked for Codex **0.157.0**, Claude Code **2.1.287**, and Gemini CLI **0.30.0**. Gemini's installed settings loader additionally confirms recursive environment interpolation and comma-separated server allowlists.

- [Codex MCP configuration](https://developers.openai.com/codex/mcp)
- [Claude Code MCP configuration and environment references](https://code.claude.com/docs/en/mcp)
- [Gemini MCP configuration](https://geminicli.com/docs/tools/mcp-server/)
- [MCP maintained TypeScript client SDK](https://ts.sdk.modelcontextprotocol.io/v2/clients/connect)
- [Context7 MCP clients](https://context7.com/docs/clients/claude-code)
- [Context7 manual MCP configuration and API-key headers](https://context7.com/docs/resources/all-clients)
- [Context7 CLI setup behavior](https://context7.com/docs/clients/cli)
- [MCP tool annotations are hints, not enforcement](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/)

The optional Context7 preset uses its documented `https://mcp.context7.com/mcp` endpoint and `Authorization` header. Set `CONTEXT7_AUTHORIZATION` to the complete `Bearer YOUR_API_KEY` header value in the app's environment. Context7 also documents lower-limit anonymous access: remove the header reference and authentication-required setting to choose that mode. The preset starts inactive and untrusted. The setup tool, package installers, and skill installers are never run automatically.

Deterministic tests exercise real local MCP protocol initialization/discovery, adapter configuration, bounded source capture, resolver inheritance and pinning, cancellation and cleanup. Kanban process tests use simulated coding CLIs. These checks do **not** establish authenticated live-provider compatibility. Gemini retains its existing `notLiveVerified` marker. No paid model call or real provider credential is needed by default tests.
