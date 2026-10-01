<p align="center">
  <img src="docs/logo.png" width="180" alt="Promptboard mascot: a girl in glasses and a kimono giving a thumbs-up">
</p>

<h1 align="center">Promptboard</h1>

<p align="center">
  Write clear prompts for AI coding agents, then run them on a local Kanban board.<br>
  Your own CLI · Your own repository · Nothing merges without you.
</p>

<p align="center">
  <img src="docs/compose-demo.gif" width="820" alt="Compose: a rough request is typed, Promptboard writes a structured prompt, and Split into tasks proposes three ordered tasks.">
  <br><sub><b>Compose</b>: a rough request becomes a clear prompt, then optional smaller tasks.</sub>
</p>

<p align="center">
  <img src="docs/kanban-demo.gif" width="820" alt="Kanban: Autopilot takes three cards one after another from To Do through Executing, Code Review, Testing, and Merge to Done, with the agents sidebar and terminal tabs.">
  <br><sub><b>Kanban</b>: Autopilot takes three cards from To Do to Done, each in its own Git worktree.</sub>
</p>

## Install

You need **Node.js 22+**, **Git**, and at least one AI coding CLI, installed and signed in:

| CLI | Compose | Kanban agents |
| --- | --- | --- |
| [Claude Code](https://code.claude.com/docs/en/quickstart) | Yes | Yes |
| [OpenAI Codex CLI](https://developers.openai.com/codex/cli) | Yes | Yes |
| [Gemini CLI](https://geminicli.com/docs/get-started/installation/) | Yes | Yes (not verified live) |
| [Google Antigravity](https://antigravity.google/docs/getting-started?tab=cli) (`agy`) | Yes | No |

```bash
git clone https://github.com/datasound-projects/Promptboard.git
cd Promptboard
npm install
npm start
```

Your browser opens **http://127.0.0.1:4318**. Press **Ctrl+C** to stop. No API keys and no accounts: Promptboard uses your CLI's own sign-in.

## Features

**Compose**
- Turn a rough request into a clear, structured prompt for a coding agent.
- Keep exact text safe: code, paths, commands, URLs, and quoted text are checked so they stay unchanged.
- Choose the CLI, model, effort, detail level, task type, and language (English, German, Polish).
- **Reviewed** mode checks the prompt with a second model call; **Fast** mode uses one call.
- **Split into tasks** (optional): break the prompt into smaller, ordered tasks that become To Do cards.
- Keep your last 500 prompts in the sidebar; copy, export, or add them to the board.

**Kanban**
- Move each task through To Do → Planning → Executing → Code Review → Testing → Merge → Done.
- Each card gets its own Git branch and worktree. Your main checkout is never touched.
- Click the **project agent** above the board to choose its provider, model, and effort. Use **Agents per stage…**, or the agent label on a column, to override it for a stage. Compose has separate settings.
- The compact project bar shows the target branch; **Files** opens the local repository details. **Files and context** on a card shows where the agent edits files; paths and branch names can be copied.
- **Drag = start.** Drop a card on a stage and its work starts at once: planning, the coding agent, the review, or your tests.
- Watch and type into each agent's terminal in the dock at the bottom.
- Drag the terminal divider (or use its arrow keys) to resize it; the board adjusts to the space left. Expand **Run details** for paths and usage. Stop has a visible confirmation and waits for the selected agent to exit, keeping its files and logs.
- Terminal tabs identify the actual provider and model. Connection feedback shows whether output is live or reconnecting; **View output** also opens saved logs after a restart.
- See every agent in the sidebar: Active, On hold, Awaits you, or Inactive, with model and time.
- **Merge** is the one place you approve: one click on **Merge main** merges a verified card and moves it to Done.
- Reviews and tests must match the exact commit before a merge. If `main` moved on, it is brought in first; conflicts go to the merge agent.
- **Autopilot** runs queued cards one at a time through their route, from To Do to Done.
- **Columns**: add your own columns, rename or recolour stages, and hide Planning.
- **Timeline**: see the history of a project: moves, agent runs, reviews, tests, commits, and merges.

**Projects and GitHub**
- **New project** creates a folder with a Git repository, ready to use.
- **Open folder** uses code you already have (Git is set up if needed; your files are not added).
- Connect GitHub with the official GitHub CLI, pick a repository, and open pull requests.

## More details

<details>
<summary><b>How a card moves</b></summary>

- Cards move only along the workflow. The board offers only the allowed moves.
- A card enters a column only when the move worked. If a stage cannot start, the card stays and shows why.
- Dropping a card starts its stage. Set a stage to **Manual** in **Workflow settings** to only move cards there.
- Moving on from a stage confirms the agent's finished turn and commits its work in the task worktree.
- In **Merge**, the card shows **Merge main** (one click) and **Open pull request**. **Merge automatically** merges as soon as the card is verified.
- Code Review → Testing needs a review of the current commit. Testing → Merge also needs passing tests for it.
- Sending a card back to Executing gives the next run the review findings or the failing test output.
- Done needs a verified merge, a merged pull request, or "no changes required". **Reopen** starts a new cycle.
- Not happy with an attempt? **Start over** (task details) keeps the old branch exactly as it is, removes the worktree, and sends the card back to To Do. The next run starts a new branch from the current target and gets your reason. Nothing is deleted or force-pushed.
- The agent for a stage comes from the stage setting, else the project default, else the global default in **Settings**.

Full rules: [Kanban contract](docs/agentic-kanban-contract.md).
</details>

<details>
<summary><b>Settings</b></summary>

The gear in the top bar opens **Settings**: theme, start page, default agent and model, agents at the same time (1–4), terminal font size, dock behaviour, and GitHub.
</details>

<details>
<summary><b>GitHub</b></summary>

Install the [GitHub CLI](https://cli.github.com), then choose **Settings → GitHub → Connect GitHub**. Promptboard runs `gh auth login --web`; the GitHub CLI keeps the token. Pick a repository and Promptboard clones it into its data folder. **Open pull request** pushes the task branch (never forced). **Disconnect** keeps your local work and never signs you out.
</details>

<details>
<summary><b>Privacy and data</b></summary>

- Promptboard runs only on this computer (`127.0.0.1`). No analytics, no telemetry.
- Your prompts stay in your browser. The board, runs, and worktrees are in the Promptboard data folder (`PROMPTBOARD_DATA_DIR` changes it). New projects go to `~/Promptboard Projects` (`PROMPTBOARD_PROJECTS_DIR` changes it).
- Text you send goes to your AI provider through its CLI. **Do not put secrets into prompts or cards.**
- Promptboard never reads CLI or GitHub credentials.

Read [SECURITY.md](SECURITY.md) before you use it with sensitive repositories.
</details>

<details>
<summary><b>Command line</b></summary>

```bash
node bin/ste.mjs --provider codex < request.txt > prompt.md
node bin/ste.mjs --provider claude --language de --quality fast < request.txt
```

Run `node bin/ste.mjs --help` for all options.
</details>

<details>
<summary><b>Troubleshooting</b></summary>

| Problem | Action |
| --- | --- |
| Port already in use | `npm start -- --port 4320` |
| CLI not detected | `node bin/ste.mjs --doctor` |
| Agent seems stuck at the start | Open its terminal. The CLI may ask whether to trust the folder. |
| Board terminals unavailable | Run `npm install`. On Linux, install `python3`, `make`, and a C++ compiler first. |

Kanban agents are verified on macOS and Linux, not on Windows. See [what was verified](RELEASE-VERIFICATION.md).
</details>

<details>
<summary><b>Development</b></summary>

```bash
npm ci
npm run check
npm test
```

`scripts/live-transitions.mjs` and `scripts/live-flow.mjs` run real CLIs in throwaway repositories and use your provider quota. `scripts/record-demo.mjs` records the demos above. See [CONTRIBUTING.md](CONTRIBUTING.md) and the [changelog](CHANGELOG.md).
</details>

## License

[MIT](LICENSE). Third-party licences: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The writing rules draw on ASD-STE100 Simplified Technical English; ASD and STEMG do not endorse this project.
