<p align="center">
  <img src="public/nerd.png" width="150" alt="AI Prompt Engineer mascot">
</p>

<h1 align="center">AI Prompt Engineer</h1>

<p align="center">
  Turn rough ideas into clear, structured prompts for AI coding agents.
</p>

<p align="center">
  ASD-STE100 writing principles · Your own AI CLI · Built-in checks · MIT license
</p>

## What is it?

AI Prompt Engineer helps you describe coding tasks clearly before you send them to an AI agent.

Write your request in your own words. Choose your model and preferences. The app creates a structured prompt, checks it, and shows the result for you to review and copy.

It works through your installed **Codex, Claude Code, Antigravity, or Gemini CLI**, using your existing sign-in.

## Why use it?

A coding agent needs a clear goal, relevant context, and precise constraints. This app helps you prepare those instructions without rebuilding a prompt from scratch every time.

- **Clarify the task.** Organize the goal, requirements, constraints, and expected result.
- **Protect technical details.** Check that recognized code, quoted text, URLs, and paths remain unchanged.
- **Find potential problems.** Review missing requirements, conflicting instructions, and unsupported additions.
- **Control the output.** Choose the model, supported effort level, language, task, and amount of detail.
- **Reuse your work.** Keep prompt history and copy or export results and check reports.

The writing rules draw on **ASD-STE100 Simplified Technical English**: short sentences, direct instructions, and consistent terms.

## Installation

### 1. Install the requirements

You need **Node.js 22 or later** and at least one supported CLI.

| CLI | Official setup |
| --- | --- |
| OpenAI Codex | [Install Codex](https://developers.openai.com/codex/cli) |
| Claude Code | [Install Claude Code](https://code.claude.com/docs/en/quickstart) |
| Google Antigravity (`agy`) | [Install Antigravity CLI](https://antigravity.google/docs/getting-started?tab=cli) |
| Gemini CLI | [Install Gemini CLI](https://geminicli.com/docs/get-started/installation/) |

Sign in to your chosen CLI and confirm that it works in your terminal.

### 2. Download the project

Download and extract the release ZIP, then open a terminal in the extracted folder.

### 3. Start the app

```bash
npm start
```

Open **http://127.0.0.1:4318** if your browser does not open automatically.

**No `npm install` is needed to run the app.** No separate API key is required by the app. Your CLI’s access requirements, usage limits, and charges still apply.

Keep the app and CLI in the same environment. If your Windows CLI setup requires WSL2, run both inside WSL2.

## How to use it

1. **Choose a provider and model.** Select an effort level when supported.
2. **Choose the language.** English is the default; German and Polish are also available.
3. **Set the task and detail.** Use Build, Debug, Refactor, Review, Architecture, Agent Workflow, or Research.
4. **Enter your request.** Include important constraints and any exact technical text.
5. Click **“Okay , Lets Goooo!”**
6. **Review the prompt and findings**, then copy it into your coding agent.

Optional controls add planning, acceptance checks, edge cases, or security review.

Model choices come from your installed CLI. Availability depends on your account and CLI version. Gemini uses its CLI thinking settings.

## How it works

| Mode | Process | Model calls |
| --- | --- | --- |
| **Reviewed — default** | Draft → automatic checks → model review → one repair and another review when needed | 2–4 |
| **Fast** | Draft → automatic checks | 1 |

Automatic checks compare recognized technical text and flag selected English writing issues. The model review assesses meaning, requirements, scope, conflicts, and clarity.

The report shows findings and any failed or unavailable checks. Put important exact text in backticks or double quotes to make its boundaries explicit.

The app generates instructions for a coding agent. It does not perform the coding task.

## What the checks mean

A passing report means the implemented checks found no remaining issue. **Always review the final prompt.** The reviewer uses the same selected model and can miss mistakes.

This is an independent writing aid, **not a full or certified STE checker**. German and Polish use clear technical language rather than English STE. ASD and STEMG do not endorse the project.

See [the method and sources](docs/ste-method.md) and [verification details](docs/verification.md).

## Terminal use

```bash
# Create a reviewed prompt
node bin/ste.mjs --provider codex < request.txt > prompt.md

# Use Fast mode with German output
node bin/ste.mjs --provider claude --language de --quality fast < request.txt

# Export the prompt and verification report
node bin/ste.mjs --provider agy --json < request.txt > result.json
```

Flagged drafts return exit code `2` and are withheld from plain output. Use `--json` to inspect the full result, or `--allow-draft` to output draft text.

Run `node bin/ste.mjs --help` for all options.

## Data and troubleshooting

The app runs on your computer. History stays in your browser. Your CLI sends requests to its provider and may retain its own logs. The app includes no analytics.

| Problem | Action |
| --- | --- |
| Port already in use | Run `npm start -- --port 4320` |
| CLI not detected | Run `node bin/ste.mjs --doctor` |
| Check the installed app version | Run `node bin/ste.mjs --version` |
| Model unavailable | Check CLI sign-in and model access, then refresh the model list |

Read [security notes](SECURITY.md) and [CLI details](docs/cli-adapters.md).

## Development

```bash
npm ci
npm run check
npm test
```

See [contributing](CONTRIBUTING.md), [evaluation guidance](evals/README.md), and [GitHub publishing instructions](docs/publishing.md).

Released under the [MIT license](LICENSE).
