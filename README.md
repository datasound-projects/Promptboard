<p align="center">
  <img src="docs/logo.png" width="180" alt="Promptboard mascot: a girl in glasses and a kimono giving a thumbs-up">
</p>

<h1 align="center">Promptboard</h1>

<p align="center">
  Write clear prompts for AI coding agents, then run them on a local Kanban board.<br>
  Your own CLI · Your own repository · Nothing merges without you.
</p>

<p align="center">
  <img src="docs/kanban-demo.gif" width="820" alt="The Kanban board with coloured stages and a project sidebar: a card starts an agent, its terminal streams in the dock, the board scrolls across to Done, and switching projects keeps the agent running.">
  <br><sub>Demo recorded with a simulated agent CLI.</sub>
</p>

## What it does

Promptboard is a local web app with two pages.

- **Compose** turns a rough request into a structured prompt for a coding agent. It checks that code, quoted text, URLs, and paths stay unchanged, and flags missing or conflicting requirements. The writing rules draw on ASD-STE100 Simplified Technical English.
- **Kanban** runs each task through seven stages: To Do, Planning, Executing, Code Review, Testing, Merge, and Done. Agents work in a separate Git worktree for each task, in a terminal you can watch and type into.

Promptboard uses the CLIs you already have (**Claude Code, Codex CLI, Gemini CLI**, and **Antigravity** for prompts) with your existing sign-in. It has no API keys, no accounts, and no analytics.

## Requirements

- Node.js 22 or later, and Git.
- At least one supported CLI, installed and signed in:

| CLI | Compose | Kanban agent runs | Setup |
| --- | --- | --- | --- |
| Claude Code | Yes | Yes | [Install](https://code.claude.com/docs/en/quickstart) |
| OpenAI Codex CLI | Yes | Yes | [Install](https://developers.openai.com/codex/cli) |
| Gemini CLI | Yes | Yes, not verified live | [Install](https://geminicli.com/docs/get-started/installation/) |
| Google Antigravity (`agy`) | Yes | No | [Install](https://antigravity.google/docs/getting-started?tab=cli) |

Kanban agent runs are verified on macOS and Linux. They are not verified on Windows or WSL2. See [what was verified](RELEASE-VERIFICATION.md).

## Install and start

```bash
git clone https://github.com/datasound-projects/Promptboard.git
cd Promptboard
npm install
npm start
```

Open **http://127.0.0.1:4318** if the browser does not open. Use `npm start -- --port 4320` for another port. Press **Ctrl+C** once to stop: Promptboard stops its agents, removes temporary folders, and frees the port.

`npm install` adds the terminal packages (`node-pty` and `xterm`). On macOS and Windows, `node-pty` ships prebuilt binaries. On Linux it compiles during install and needs `python3`, `make`, and a C++ compiler. Without it, Compose still works and the board tells you what is missing.

## Compose a prompt

1. Describe the task in your own words. Put exact text in backticks or double quotes.
2. Choose the job, the CLI, the model and effort, the detail level, and the language (English, German, or Polish).
3. Click **Okay, let's goooo!** or press ⌘/Ctrl+Enter.
4. Read the prompt and the findings, then copy it or add it to the board.

**Reviewed** mode (default) drafts, checks, and asks the model for a compact review (2 model calls). It repairs once, with a fresh review (4 calls), only when a check confirms a lost literal or a missing or changed requirement; style notes and reviewer uncertainty are reported, not repaired. **Fast** mode drafts and checks (1 call). A passing report means the implemented checks found nothing. Always read the prompt yourself. This is a writing aid, not a certified STE checker. See [the method](docs/ste-method.md) and [verification](docs/verification.md).

### Split into tasks (optional)

After a prompt is ready, **Split into tasks** asks your CLI once to break it into 2–8 smaller, ordered tasks. You can edit titles and prompts, reorder them, or leave some out. They become To Do cards in that order. If you like, Autopilot then opens with those cards first, so you can review the order and start it. Promptboard warns you when an exact text from the prompt (a path, code, or quoted text) is in no task.

## Run tasks on the board

1. **Pick or create a project** in the sidebar. **New project** creates its own folder in `~/Promptboard Projects` (or `PROMPTBOARD_PROJECTS_DIR`) with a Git repository, ready for agents. **Open folder…** turns a folder on your computer into a project; if it is not a Git repository yet, Promptboard runs `git init` and makes one empty first commit (your files are not added). Each project has its own board and repository; agents keep running when you switch. The ⋯ next to a project renames it, links or changes its repository, opens its workflow settings, or deletes it.
2. **Check the repository.** The project's target branch is the checked-out branch; you can change it or link another repository. When Promptboard sets up Git, it never adds your files; if Git has no name and email yet, that one empty commit is made as “Promptboard” and your Git settings stay unchanged. Task commits always use your own Git identity.
3. **Add a card.** Write a task or add a prompt from Compose. The card keeps an exact copy.
4. **Move it through the stages.**

| Stage | What happens |
| --- | --- |
| To Do | Nothing runs. |
| Planning | Optional. The agent plans in read-only mode. You approve the plan. |
| Executing | The agent edits files in the task's own worktree and branch. You confirm when it is done. |
| Code Review | You commit the changes, then an agent reviews the diff read-only and lists findings. You accept them or send the task back. |
| Testing | Your test commands run in the worktree, without a shell. Only exit codes count. Optionally, a **testing agent** runs the tests, fixes failures, and adds focused tests (you commit its changes). |
| Merge | You confirm a fast-forward merge into the target branch, or turn on **Merge automatically**: then a card merges on entry only if its accepted review and passing tests belong to exactly the current commits. If the target has moved on, a **merge agent** resolves the conflicts after Promptboard starts the merge; you commit the result. Or choose **Open pull request**: after you confirm, the task branch is pushed (never forced) and a GitHub pull request is opened with `gh`; when it is merged there, the card moves to Done. |
| Done | Reached only by a verified merge (drag from Merge to Done and confirm once), a merged pull request, or an explicit "no changes required". **Reopen** starts a new cycle; the history stays. |

Cards move only along the workflow: To Do → Planning or Executing; Planning → Executing or back to To Do; Executing → Code Review or back to To Do; Code Review → Testing or back to Executing; Testing → Merge or back to Executing; Merge → Done, Executing, or Code Review. The board offers only these moves. A card enters a column only when the move worked: if a stage cannot start, the card stays where it was and shows why. Each card keeps one branch and one worktree for all stages, including rework.

Each project chooses what happens when a card enters a stage: **Manual** (move only), **Ask** (default: one approval), or **Start automatically**. The one approval shows everything the move will do: confirm the agent's finished turn in the stage the card leaves (this approves a plan or records a review), commit its work with your message, and start the next stage with the resolved agent. **Move only** moves without starting; **Cancel** leaves the card where it was. Code Review → Testing needs a review of the current commit; Testing → Merge also needs passing tests for it. Sending a card back to Executing passes the review findings or failing test output to the next run.

The agent for a stage comes from the stage's own setting, else the project default agent (both in Workflow settings), else the global default (Settings). You choose a model once, not on every move; an approval can still change it for one run. Terminals open in the dock at the bottom of the page. You can collapse the dock, reload the page, or run several tasks at once (one by default, up to four). Promptboard never passes a bypass or "yolo" permission flag, never pre-trusts a folder for a CLI, and never force-resets or stashes your work.

### Agents, tabs, and usage

The Kanban sidebar lists **Agents** under Workspace: every running run, plus each task's latest run from the last 30 minutes, for this project or all projects. Each row shows the task, the provider, model, and effort, the stage, the state, and the elapsed time. Selecting one opens its project, card, and existing terminal. It never starts a run.

States come from the run itself (provider lifecycle events), not from the column:

| State | Meaning |
|---|---|
| ● Active | The agent is working. |
| ○ On hold | Queued until an agent slot is free. |
| ! Awaits you | A permission prompt, question, or finished turn needs you. |
| – Inactive | Succeeded, failed, cancelled, or interrupted. |

The dock has one tab per run. Switching tabs never restarts anything. Closing a tab only hides it: the agent keeps running and its history stays. The line above the terminal shows provider, model, effort, stage, state, time, branch, worktree, and usage.

**Usage** is read from the CLI's own session file and never estimated. Claude Code: input, cached, and output tokens, the context of the latest request in tokens, and the model it reported (from the session transcript). Codex CLI: the same, plus the context as a share of the model's context window and the plan usage limit (from the session rollout file). Gemini CLI reports no usage, so none is shown. Context is the size of the conversation, not task progress. Promptboard shows no completion percentage.

### Timeline

Each project has two views: **Board | Timeline**. The Timeline shows the project's history from left (oldest) to right (newest), grouped by day. It is built only from what Promptboard recorded: tasks created and moved, agent runs (stage, provider, model, effort, result, duration), reviews, test runs, pull requests, merges and other completions, and the Git commits of each task branch or merge. Completed work is numbered in the order it finished. Choose a task name to open that task, or **Output** on a run to see its terminal. Filter by key events, all events (with column moves), or completed work only.

You can add **notes** (for example a release or a decision) with a date and an optional task. Notes are the only entries you can edit or remove; recorded events cannot be changed. Notes are included in board backups.

### Settings

The gear in the top bar opens **Settings**:

- **General:** theme (System, Light, Dark) and start page (Compose or Kanban).
- **Agents:** default provider and model for every stage that a project did not set itself, agents at the same time (1–4), open the terminal when a run starts, keep tabs of finished runs.
- **Kanban:** opens the current project's workflow and Autopilot. Those settings belong to that project only.
- **GitHub:** see below.
- **Terminal:** font size, dock state when the page opens, close finished tabs.

Browser preferences stay in this browser. Agent defaults and the agent limit are saved with the board.

### GitHub repositories

A project uses a **local folder** or a **GitHub repository**. For GitHub, install the [GitHub CLI](https://cli.github.com), then choose **Settings → GitHub → Connect GitHub**. Promptboard runs the official `gh auth login --web` and shows the one-time code; you finish the sign-in on github.com. The GitHub CLI keeps the token in your system keychain. Promptboard never sees, stores, or logs it.

Then search your repositories and choose **Connect repository**. Promptboard clones it once into its data folder (`clones/<owner>/<name>`) and links that **managed clone** to the project. Agents work in task worktrees of the clone, as with a local folder, and **Open pull request** pushes the task branch (never forced) and reuses an open pull request for the same branch. **Fetch** shows whether the target branch is up to date, behind, or ahead of GitHub. **Update** is a confirmed fast-forward only. **Disconnect** forgets the GitHub link but keeps the clone and all work, and never signs the GitHub CLI out. To sign out, run `gh auth logout` yourself.

### Autopilot (optional)

Paste your subtasks as To Do cards, then choose **Autopilot** on the board. Pick which cards run and in which order, the default route (for example Executing → Code Review → Testing → Merge), and, per card, its own route. Autopilot then takes one card at a time through its route: it confirms each finished agent turn, commits with your Git identity, accepts reviews that report no issues, runs your test commands, and merges locally (fast-forward) or opens a pull request. Review findings and failing tests go back to Executing, up to the rework limit you set. When the target branch moved on, it is merged in (by the merge agent if there are conflicts) and the card is reviewed and tested again.

Autopilot pauses, with the reason, whenever an agent asks you something in the terminal, a check fails beyond the rework limit, or anything unexpected happens. You resume, skip the card, or stop. It never force-pushes, never passes permission-bypass flags, and never touches cards outside its queue. It runs on the local server, so closing the page does not stop it; stopping Promptboard pauses it.

The full behaviour is in the [Kanban contract](docs/agentic-kanban-contract.md).

## Privacy and data

- GitHub sign-in stays with the GitHub CLI. Promptboard stores only repository metadata (owner, name, URL, default branch, clone folder, last fetch), never a token.

- **Do not put API keys, tokens, passwords, or private code you cannot share with your AI provider into prompts or tasks.** Text you send goes to the provider through its CLI, and the CLI may keep its own logs.
- Promptboard runs only on `127.0.0.1` and sends nothing anywhere itself. It has no analytics and no telemetry.
- Prompt history stays in your browser. The board, run logs, and task worktrees are saved in `~/Library/Application Support/Promptboard` (macOS), `%APPDATA%\Promptboard` (Windows), or `~/.local/share/promptboard` (Linux). Set `PROMPTBOARD_DATA_DIR` to use another folder. Run one instance per data folder.
- Promptboard never reads or copies CLI credential files.

Read [SECURITY.md](SECURITY.md) before you use it with sensitive repositories.

## Terminal use

```bash
node bin/ste.mjs --provider codex < request.txt > prompt.md
node bin/ste.mjs --provider claude --language de --quality fast < request.txt
node bin/ste.mjs --provider agy --json < request.txt > result.json
```

Flagged drafts exit with code `2` and are withheld; use `--json` or `--allow-draft` to see them. Run `node bin/ste.mjs --help` for all options.

## Troubleshooting

| Problem | Action |
| --- | --- |
| Port already in use | `npm start -- --port 4320` |
| CLI not detected | `node bin/ste.mjs --doctor` |
| Agent seems stuck at the start | Open its terminal. The CLI may ask whether to trust the folder. Answer there. |
| Signed out or expired | Use **Connect / Sign in** under **More settings**, or run the shown command, then **Check again**. |
| Usage or rate limit | The error names the one your provider reported, with a reset time only when the provider gives one. |
| Board terminals unavailable | Run `npm install`. On Linux install `python3`, `make`, and a C++ compiler first. |

## Development

```bash
npm ci
npm run check
npm test
```

`scripts/live-flow.mjs` and `scripts/live-agents.mjs` run real CLIs in disposable repositories. They use your provider quota, so they never run in CI. See [CONTRIBUTING.md](CONTRIBUTING.md), [the changelog](CHANGELOG.md), and [live verification](docs/live-verification.md).

Released under the [MIT license](LICENSE). Third-party licences are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). ASD and STEMG do not endorse this project.
