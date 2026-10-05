# CLI adapters

The app calls an installed CLI. Sign in to that CLI first. It uses the CLI's account, model access, usage limits, and billing. It does not collect API keys. Select a model ID or alias, or choose CLI configured default to use the CLI default. Model availability comes from your provider and account.

| Adapter | Command contract | Restrictions added by this app |
| --- | --- | --- |
| Codex CLI | `codex exec … --json -` with the prompt on stdin | Read-only sandbox; no approval escalation; shell tools and web search disabled; ephemeral session. |
| Claude Code | `claude --print --output-format stream-json --verbose …` with the prompt on stdin | Empty built-in tool list; deny all tools; empty strict MCP configuration; slash commands disabled; one turn; no session persistence. |
| Antigravity CLI (`agy`) | `agy --input-format stream-json --output-format stream-json --sandbox …`; one JSON user event on stdin | Native terminal sandbox; existing tool permissions and managed settings stay in place. |
| Gemini CLI | `gemini --output-format json …` in a non-TTY process with the prompt on stdin | Default approval mode; extensions disabled; empty MCP allow list; a temporary wildcard deny policy. Plan mode is not required: stable releases such as 0.30.0 gate it behind `experimental.plan`. |

The app uses argument arrays and `shell: false`. Request text never becomes a shell command or command argument. The adapter caps input at 256 KiB, stdout at 2 MiB, and stderr at 64 KiB. The app limits the user's input to 100,000 characters. The adapter default timeout is two minutes; the app supplies a three-minute timeout. Cancellation terminates the child process group on POSIX. On Windows, termination targets the direct child. If a descendant keeps a pipe open after the CLI exits, the adapter stops waiting after 2 seconds. Raw error logs are not sent to the browser.

Gemini processes `@file` references before the model call, even in headless mode. Its adapter sends a JSON string with `@` encoded as `\u0040`. A fixed instruction tells the model to decode the string. This prevents request text from causing implicit file inclusion. It also prevents a leading slash command from being interpreted by the CLI.

## Models and effort

The token-protected `/api/models?provider=codex` endpoint reads metadata from the installed CLI. Add `&refresh=1` to bypass the one-minute cache. It has bounded output, a 12-second timeout, an isolated temporary folder, and no inference prompt. The CLI can still refresh authentication or run its configured startup hooks.

| Provider | Discovery | Effort passed to generation |
| --- | --- | --- |
| Codex | App-server `initialize`, `initialized`, paginated `model/list`, then read-only `config/read` | `--config model_reasoning_effort="LEVEL"`; choices come from each model's `supportedReasoningEfforts` |
| Claude | Streaming control `initialize`, reading only `models` from its response | `--effort LEVEL` and the same per-process `CLAUDE_CODE_EFFORT_LEVEL`; choices come from `supportedEffortLevels` |
| Antigravity | `agy models`; parse the two-column slug/name list separated by tabs or at least two spaces | Effort-pinned slugs such as `gemini-3.8-flash-high` offer only their matching effort. Conflicting overrides are rejected before launch. Unsuffixed/custom IDs do not report effort capabilities. |
| Gemini | ACP `initialize` and `session/new` with no tools requested; read `models.availableModels` | No effort override. Keep the CLI's configured thinking settings |

Gemini ACP may create local session metadata. It does not receive a `session/prompt` call. We never return account objects, complete settings, secrets, or raw diagnostic output from discovery. If discovery is unavailable, the UI labels that state and keeps the CLI default and custom-ID entry usable. It does not substitute a guessed model catalog. Custom IDs and their effort support are unverified until the CLI accepts the run.

Explicit Codex and Claude model choices are checked against discovered effort capabilities. Claude's environment setting can outrank its flag, so the selected effort is also supplied in that child process's environment. Global settings are not edited. Managed caps still apply. `ultracode` changes the agent workflow and is not treated as an effort enum.

Generation returns the requested `model`, `effort`, and `language`, plus `reportedModels` from Claude's `modelUsage` or Gemini's `stats.models`. Those reported IDs can include auxiliary models. Codex exec and Antigravity's final envelope do not consistently report a resolved model or effective effort. The UI explicitly marks unreported values and never equates requested effort with measured effort.

## Error classification

Failures return a stable `code` and a fixed message. Structured provider fields are used first; raw stderr, tokens, and paths are never returned.

| Code | Evidence used |
| --- | --- |
| `QUOTA_EXHAUSTED` | Claude `rate_limit_event` rejected with `errorCode: "credits_required"`; Gemini `TerminalQuotaError`; Codex text `You've hit your usage limit` (verified in the installed binary) |
| `RATE_LIMITED` | Other Claude rejections, assistant error `rate_limit`, or HTTP 429; Gemini `RetryableQuotaError`; Codex `last status: 429` |
| `AUTH_REQUIRED` | Claude `authentication_failed` or HTTP 401; Gemini `FatalAuthenticationError` or exit code 41; Codex status 401; Antigravity `authentication required` |
| `MODEL_UNAVAILABLE`, `PROVIDER_UNAVAILABLE`, `NETWORK_ERROR`, `POLICY_DENIED`, `ACCOUNT_UNAVAILABLE` | Documented Claude assistant error codes and structured `stop_reason: "refusal"`, Gemini error types, and HTTP status classes |
| `CLIENT_UNSUPPORTED` | Gemini account setup reports `IneligibleTierError` with backend reason `UNSUPPORTED_CLIENT`; choosing a different model cannot fix a client/account rejection |
| `TIMEOUT`, `ABORTED` | App timers and cancellation |
| `CLI_FAILED` / `UNKNOWN` | Anything else. It is not guessed. |

An HTTP 429 alone is a temporary rate limit, not exhausted quota. A reset time is shown only when the provider supplies one (Claude `resetsAt`). The app never switches model or provider. After an account-level failure in review, it makes no repair call.

## Sign-in controls

The connection panel shows installation and sign-in separately. Failed model discovery never counts as "signed out". The app runs only these allowlisted, CLI-managed operations; it stores no credentials.

| CLI | Status | Sign in | Sign out |
| --- | --- | --- | --- |
| Codex | App-server `account/read` | Native: app-server `account/login/start` (`chatgpt` browser or `chatgptDeviceCode`); the CLI replaces credentials only on success | `codex logout`, after confirmation |
| Claude Code | `claude auth status --json` (exit 0/1) | Terminal handoff: `claude auth login` | `claude auth logout`, after confirmation |
| Gemini CLI | Not reported (no documented command) | Terminal handoff: `gemini`, then "Sign in with Google" | Not available (no documented command) |
| Antigravity | Not reported | Terminal handoff: `agy` | Terminal handoff: `/logout` inside `agy` |

Claude sign-in is a terminal handoff because non-TTY behavior of `claude auth login` was not verified. Reauthentication never signs out first. Sign-out requires confirmation because it affects every tool that shares that CLI configuration. Auth endpoints require the page token, a local host/origin, and JSON. Auth changes and generation cannot overlap. A completed change clears the model cache.

## Security boundary

These are restrictions on a trusted local CLI, not an operating system isolation boundary for the whole CLI process. The server must supply a fresh temporary working directory. The adapter does not disable the user's managed policies, replace home directories, copy credentials, or use permission bypass flags. If a CLI rejects an argument or a policy blocks a run, the app returns an error. It does not retry with fewer restrictions.

Antigravity keeps the installed permission rules and enables its terminal sandbox. This is not a tool deny-all mode: workspace reads/writes and configured allowed tools may still run. The rewrite instructions prohibit tool calls. No permission-bypass flag is added.

Codex read-only mode restricts model shell actions. It does not promise that configured MCP services, plugins, hooks, or the CLI's own state writes are read-only. Gemini administrator policies can take priority over the added user-level deny rule. Existing configured hooks can also run outside model tool calls. Use trusted CLI configuration. For a stronger boundary, run the app and CLIs in a dedicated restricted account or container.

The app does not claim that every provider has identical policy semantics. It keeps installed configuration in place, subject to each CLI's normal precedence rules, and adds the restrictions listed above. Global instructions and CLI defaults can affect the generated text.

## Compatibility and verification

Use a current stable CLI. The adapters use documented headless commands. If an older version lacks a required flag, upgrade that CLI; the app will not remove the flag. macOS and Linux executables on an absolute PATH entry are supported. On Windows, native `.exe` installs and the standard npm package layouts are supported without executing `.cmd` through a shell. Custom wrappers and other install layouts may need a PATH fix. Windows behavior has not been tested on a Windows host.

On 2026-09-28, the command contracts were checked against official sources. Local Codex `--help`, `exec --help`, and `features list` were also checked. Tests use fake CLI executables and real process pipes to check input handling, result parsing, output limits, cancellation, timeouts, policy cleanup, and error paths. These checks do **not** establish live model compatibility or prompt quality. No authenticated model call was made during development.

On 2026-10-05, authenticated checks exercised the real `/api/models` and `/api/generate` endpoints with isolated app data. The request was to compose a short prompt for a Python integer-square function with one example:

| Installed provider | Live Compose result |
| --- | --- |
| Claude Code | 11 of 12 catalog choices generated the test prompt after CLI sign-in. `claude-opus-5` answered a direct smoke request, but the provider refused the Compose brief with structured `stop_reason: "refusal"`; this now reports `POLICY_DENIED`. The configured default, a separate reviewed run, and all five reported effort levels were also checked. |
| Antigravity CLI 1.2.14 | All 18 reported model slugs generated the test prompt. Reviewed generation passed. A conflicting slug/effort pair reproduced a native CLI error; model metadata now offers only the effort pinned by each slug and rejects conflicting overrides before launch. |
| Codex CLI | All seven catalog choices generated the test prompt. Reviewed generation and the five reported effort levels passed. This machine's configured default was absent from the catalog and the provider rejected it as `MODEL_UNAVAILABLE`; no automatic model substitution was made. |
| Gemini CLI 0.30.0 | Reproduced and fixed the experimental Plan Mode startup failure. The CLI then reached authentication, where the provider rejected this client/account combination with `UNSUPPORTED_CLIENT`. Live model discovery and generation remain unavailable for that account; Compose reports `CLIENT_UNSUPPORTED` rather than a generic CLI failure. |

These checks establish the observed adapter behavior, not future model access or provider uptime. Regression fixtures also cover Gemini generation and discovery without requiring experimental settings. The [Claude CLI reference](https://code.claude.com/docs/en/cli-reference), [Antigravity headless reference](https://www.antigravity.google/docs/cli/headless/), and installed Gemini source/help were used to check the command contracts.

## API

### Base and Kanban sessions

The restricted text-generation adapters documented above remain separate from `agents.mjs`, which builds interactive Kanban sessions. Optional wiki generation invokes the existing restricted runner directly through the shared server job coordinator, as Task Split does; it never uses Compose's rewrite pipeline or starts a Kanban task.

Base instruction skills, wiki/context text, and command recipes reach interactive agents through delimited message sections. This is instruction/context delivery, not native skill installation or a new tool registry. Required incompatibilities block the existing launch path; optional omissions appear in the pinned run manifest. Command recipes and Base MCPs cannot be attached to read-only Planning or Code Review runs.

For authorized writing stages, Claude uses a selected strict per-run MCP configuration while retaining hooks and its usage status line. Gemini receives selected server names and merged per-run system settings while retaining administrator settings and hooks. Codex uses documented per-run MCP configuration overrides and preserves notify/sandbox arguments; ambient Codex MCP configuration remains external to Base and is not claimed to be isolated. Per-run model/effort selection, approvals, long-prompt paste, and Gemini's prompt encoding are unchanged.

Stdio and Streamable HTTP definitions use declared environment/header references. Explicit trusted connection tests use the maintained MCP client SDK for initialization and capability discovery, with bounded output and cleanup. A discovered tool reference retains its parent server and tool identity; it does not claim that other server tools are filtered out. No global setup command, provider-home replacement, credential copy, permission bypass, or automatic skill/script execution is introduced.

The [Base delivery matrix](base-delivery.md) records the exact supported combinations, current official references, installed CLI versions checked on 2026-10-02, and limitations. Default regression tests use fake coding CLIs and deterministic local MCP fixtures. They are not authenticated live-provider verification; Gemini retains its `notLiveVerified` status and Antigravity remains unavailable for Kanban.

### Restricted text generation

```js
import { detectProviders, runProvider } from './src/providers.mjs';

const providers = await detectProviders();
// [{ id, name, available, version? , reason? }]

const result = await runProvider({
  provider: 'claude',
  model: 'opus',
  effort: 'high',
  prompt: 'Write a clear prompt for this task: …',
  cwd: absoluteTemporaryDirectory,
  signal: abortController.signal,
  timeoutMs: 120000,
});
// { text, provider, model, effort, reportedModels, durationMs }
```

`buildCommand({ provider, model, effort, policyPath })` exposes the argument contract for inspection. Gemini requires an absolute path to the deny-tools policy. Normal callers should use `runProvider`, which creates and removes that file. Errors have a stable `code` and a safe `message`.

## Official sources

- [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive)
- [Codex configuration reference](https://developers.openai.com/codex/config-reference)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Gemini headless mode](https://geminicli.com/docs/cli/headless/)
- [Gemini policy engine](https://geminicli.com/docs/reference/policy-engine/)
- [Gemini CLI argument source](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/config.ts)
- [Gemini headless input source](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/nonInteractiveCli.ts)

- [Codex app-server model and configuration APIs](https://developers.openai.com/codex/app-server)
- [Claude model configuration and effort](https://code.claude.com/docs/en/model-config)
- [Claude Agent SDK control protocol](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py)
- [Claude Agent SDK types](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) (`ModelInfo`, `SDKControlInitializeResponse`; reviewed 0.3.284)
- [Gemini ACP model metadata source](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/acp/acpSessionManager.ts)
- [Antigravity headless model, effort, and stream contracts](https://antigravity.google/docs/cli/headless/)
- [Antigravity permission rules](https://antigravity.google/docs/permissions?tab=cli)

## Usage dashboard

- Codex: read-only `account/rateLimits/read` after app-server initialization ([official protocol](https://learn.chatgpt.com/docs/app-server)); never starts a thread or turn. Local rollout token totals are differenced across model changes.
- Claude: local transcript usage is deduplicated by message ID. Per-run `statusLine` receives documented cost and rate-limit fields ([official status-line schema](https://code.claude.com/docs/en/statusline)); a whitelist-only bridge records these without changing global settings. Costs are CLI estimates, not invoices.
- Gemini: local session JSON/JSONL provides per-message tokens and tool names ([record format](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingTypes.ts)). The interactive `/stats model` remains the source for account quota ([quota docs](https://geminicli.com/docs/resources/quota-and-pricing/)).
- Antigravity: unsupported metrics are explicitly unavailable. No guessed token pricing or quota percentages.

The server's `/api/usage` endpoint requires the usual local session token. Collection begins on opening Usage, refreshes every 60 seconds, and stops at server shutdown. Bounded scans use known session directories only and return sanitized aggregates. Manual refresh is coalesced and rate-limited to once per ten seconds.
