<p align="center"><img src="public/nerd.png" width="150" alt="The black and white nerd mascot"></p>

<h1 align="center">AI Prompt Engineer</h1>
<p align="center"><strong>Based on ASD-STE100 Simplified Technical English (STE)</strong></p>
<p align="center">Turn rough ideas into clear coding prompts with your own AI CLI.</p>
<p align="center">Black & white UI · Model selection · Prompt history · MIT</p>

## Start in three steps

1. Install **Node.js 22+** and one CLI below. Sign in to the CLI in your terminal.
2. Extract **`ai-prompt-engineer-ste-0.3.0.zip`**. Open a terminal in the extracted folder.
3. Run **`npm start`**. Open [127.0.0.1:4318](http://127.0.0.1:4318) if the browser does not open.

No `npm install` is needed to run the app. It uses your CLI's sign-in, access, and billing.

| Supported CLI | Setup |
| --- | --- |
| OpenAI Codex | [Official instructions](https://developers.openai.com/codex/cli) |
| Claude Code | [Official instructions](https://code.claude.com/docs/en/quickstart) |
| Google Antigravity (`agy`) | [Official instructions](https://antigravity.google/docs/getting-started?tab=cli) |
| Gemini CLI | [Official instructions](https://geminicli.com/docs/get-started/installation/) |

Keep the app and CLI in the same environment. For Windows CLI setups that need WSL2, run both there. See [CLI details](docs/cli-adapters.md).

## Make a prompt

- Select your **provider, model, and supported effort level**. Model lists come from your installed CLI; account access varies. **Refresh models** updates the list. Gemini keeps its CLI thinking settings.
- Choose **English**, **Deutsch**, or **Polski**. English is the default. German and Polish use clear technical language; STE is an English standard.
- Choose the task and detail level. Add planning, acceptance checks, edge cases, or security checks when useful.
- Enter your request. Click **“Okay , Lets Goooo!”**. Review the result and its checks, then copy or export it.

The app rewrites your request. It does not carry out the coding task.

## What makes the result more reliable?

**Reviewed** is the default. The app drafts a prompt, checks detectable exact text and English writing rules, and asks the selected model to review meaning and requirements. If issues remain, it attempts one repair and checks again. This uses **2–4 model calls**.

**Fast** uses **one model call** and automatic checks only. It costs less time and usage, but skips the model review.

The report distinguishes automatic checks from model review. A passing result means the implemented checks passed—not that every requirement is correct. The reviewer uses the **same selected model** and can miss errors. Read the result before using it.

This is **not a full or certified STE checker**. It does not include the complete official dictionary or replace technical and human review. ASD and STEMG do not endorse it. Read [the method and sources](docs/ste-method.md) and [verification details](docs/verification.md).

## Terminal use

```bash
node bin/ste.mjs --provider codex < request.txt > prompt.md
node bin/ste.mjs --provider claude --language de --quality fast < request.txt
node bin/ste.mjs --provider agy --json < request.txt > result.json
```

By default, a flagged draft is withheld from stdout and returns exit code **2**. Use `--json` for the draft and report, or `--allow-draft` to inspect draft text; both keep exit code 2 when flagged. Use `--instructions` for a rewrite brief without a model call. See `--help` for options.

## Local data and troubleshooting

The server listens on your computer only. History stays in your browser. Your selected CLI sends the request to its provider and can keep its own logs. The app has no analytics. See [security and privacy](SECURITY.md).

- **Port already in use?** Open the running app, or use `npm start -- --port 4320`.
- **Wrong version?** Run `node bin/ste.mjs --version`; this release is **0.3.0**.
- **CLI missing?** Run `node bin/ste.mjs --doctor`.
- **Publish your copy:** follow the [GitHub guide](docs/publishing.md).

For development and tests only: `npm ci`, then `npm run check` and `npm test`. See [contributing](CONTRIBUTING.md).
