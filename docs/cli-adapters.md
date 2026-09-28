# CLI adapters

The app calls an installed CLI. Sign in to that CLI first. It uses the CLI's account, model access, usage limits, and billing. It does not collect API keys. Select a model ID or alias, or choose CLI configured default to use the CLI default. Model availability comes from your provider and account.

| Adapter | Command contract | Restrictions added by this app |
| --- | --- | --- |
| Codex CLI | `codex exec … --json -` with the prompt on stdin | Read-only sandbox; no approval escalation; shell tools and web search disabled; ephemeral session. |
| Claude Code | `claude --print --output-format json …` with the prompt on stdin | Empty built-in tool list; deny all tools; empty strict MCP configuration; slash commands disabled; one turn; no session persistence. |
| Antigravity CLI (`agy`) | `agy --input-format stream-json --output-format stream-json --sandbox …`; one JSON user event on stdin | Native terminal sandbox; existing tool permissions and managed settings stay in place. |
| Gemini CLI | `gemini --output-format json …` in a non-TTY process with the prompt on stdin | Plan mode; extensions disabled; empty MCP allow list; a temporary wildcard deny policy. |

The app uses argument arrays and `shell: false`. Request text never becomes a shell command or command argument. The adapter caps input at 256 KiB, stdout at 2 MiB, and stderr at 64 KiB. The app limits the user's input to 24,000 characters. The adapter default timeout is two minutes; the app supplies a three-minute timeout. Cancellation terminates the child process group on POSIX. On Windows, termination targets the direct child. Raw error logs are not sent to the browser.

Gemini processes `@file` references before the model call, even in headless mode. Its adapter sends a JSON string with `@` encoded as `\u0040`. A fixed instruction tells the model to decode the string. This prevents request text from causing implicit file inclusion. It also prevents a leading slash command from being interpreted by the CLI.

## Models and effort

The token-protected `/api/models?provider=codex` endpoint reads metadata from the installed CLI. Add `&refresh=1` to bypass the one-minute cache. It has bounded output, a 12-second timeout, an isolated temporary folder, and no inference prompt. The CLI can still refresh authentication or run its configured startup hooks.

| Provider | Discovery | Effort passed to generation |
| --- | --- | --- |
| Codex | App-server `initialize`, `initialized`, paginated `model/list`, then read-only `config/read` | `--config model_reasoning_effort="LEVEL"`; choices come from each model's `supportedReasoningEfforts` |
| Claude | Streaming control `initialize`, reading only `models` from its response | `--effort LEVEL` and the same per-process `CLAUDE_CODE_EFFORT_LEVEL`; choices come from `supportedEffortLevels` |
| Antigravity | `agy models`; parse the documented two-column slug/name list | Native `--effort low`, `medium`, or `high`; the CLI validates model/effort combinations |
| Gemini | ACP `initialize` and `session/new` with no tools requested; read `models.availableModels` | No effort override. Keep the CLI's configured thinking settings |

Gemini ACP may create local session metadata. It does not receive a `session/prompt` call. We never return account objects, complete settings, secrets, or raw diagnostic output from discovery. If discovery is unavailable, the UI labels that state and keeps the CLI default and custom-ID entry usable. It does not substitute a guessed model catalog. Custom IDs and their effort support are unverified until the CLI accepts the run.

Explicit Codex and Claude model choices are checked against discovered effort capabilities. Claude's environment setting can outrank its flag, so the selected effort is also supplied in that child process's environment. Global settings are not edited. Managed caps still apply. `ultracode` changes the agent workflow and is not treated as an effort enum.

Generation returns the requested `model`, `effort`, and `language`, plus `reportedModels` from Claude's `modelUsage` or Gemini's `stats.models`. Those reported IDs can include auxiliary models. Codex exec and Antigravity's final envelope do not consistently report a resolved model or effective effort. The UI explicitly marks unreported values and never equates requested effort with measured effort.

## Security boundary

These are restrictions on a trusted local CLI, not an operating system isolation boundary for the whole CLI process. The server must supply a fresh temporary working directory. The adapter does not disable the user's managed policies, replace home directories, copy credentials, or use permission bypass flags. If a CLI rejects an argument or a policy blocks a run, the app returns an error. It does not retry with fewer restrictions.

Antigravity keeps the installed permission rules and enables its terminal sandbox. This is not a tool deny-all mode: workspace reads/writes and configured allowed tools may still run. The rewrite instructions prohibit tool calls. No permission-bypass flag is added.

Codex read-only mode restricts model shell actions. It does not promise that configured MCP services, plugins, hooks, or the CLI's own state writes are read-only. Gemini administrator policies can take priority over the added user-level deny rule. Existing configured hooks can also run outside model tool calls. Use trusted CLI configuration. For a stronger boundary, run the app and CLIs in a dedicated restricted account or container.

The app does not claim that every provider has identical policy semantics. It keeps installed configuration in place, subject to each CLI's normal precedence rules, and adds the restrictions listed above. Global instructions and CLI defaults can affect the generated text.

## Compatibility and verification

Use a current stable CLI. The adapters use documented headless commands. If an older version lacks a required flag, upgrade that CLI; the app will not remove the flag. macOS and Linux executables on an absolute PATH entry are supported. On Windows, native `.exe` installs and the standard npm package layouts are supported without executing `.cmd` through a shell. Custom wrappers and other install layouts may need a PATH fix. Windows behavior has not been tested on a Windows host.

On 2026-09-28, the command contracts were checked against official sources. Local Codex `--help`, `exec --help`, and `features list` were also checked. Tests use fake CLI executables and real process pipes to check input handling, result parsing, output limits, cancellation, timeouts, policy cleanup, and error paths. These checks do **not** establish live model compatibility or prompt quality. No authenticated model call was made during development.

## API

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
