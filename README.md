<h1 align="center">Promptboard</h1>
<p align="center">
  <img src="docs/readme-logo.png" width="960" alt="Promptboard mascot">
</p>

<p align="center">
  <b>Plan a project, write the prompts, and let your coding agents ship it — one reviewed, tested task at a time.</b><br>
  A local workspace for Claude Code, Codex and Gemini CLI.
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#origin">Origin</a> ·
  <a href="#compose">Compose</a> ·
  <a href="#kanban">Kanban</a> ·
  <a href="#base">Base</a> ·
  <a href="#docs">Docs</a>
</p>

## Install

You need **Node.js 22.13+**, **Git**, and at least one [supported CLI](#supported-clis), signed in.

```bash
git clone https://github.com/datasound-projects/Promptboard.git
cd Promptboard
npm ci
npm start
```

Promptboard opens at **http://127.0.0.1:4318**. Stop it with **Ctrl+C**.

To update later:

```bash
git pull --ff-only
npm ci
npm start
```

## How it fits together

```text
Origin ──tasks──▶ Kanban ◀──prompts── Compose
                    ▲
                  Base  (agents, skills, MCPs, knowledge)
```

| Page | Purpose |
| --- | --- |
| [**Origin**](#origin) | Design the project and break it into tasks. |
| [**Compose**](#compose) | Turn a rough request into a precise, reviewed prompt. |
| [**Kanban**](#kanban) | Run each task through Execute → Review → Test → Merge with your agents. |
| [**Base**](#base) | Keep the agents, skills, MCPs and knowledge your agents use. |

The pages share one project, so a plan in Origin becomes cards in Kanban without copying anything. Each page also works on its own.

## Origin

**Design the project before any code is written.**

You fill in a structured blueprint. Origin turns it into tasks that each carry exactly the context they need, and sends them to Kanban as cards. Building, checking and sending tasks is local and deterministic: no model is called unless you ask.

- **Guided blueprint.** 15 sections in five phases, from **Define** to **Build**: vision, requirements with a "done when", architecture, security, testing, decisions, assumptions and sources. Rename anything, or add your own sections and questions.
- **Architecture canvas.** Components, connections, and layers (such as Frontend or Data) with their stack and shared rules.
- **Mind map overview.** The whole plan on one map, with next steps and readiness counts. There are no made-up quality scores.
- **Checks.** Missing information, open decisions, unverified dependencies, conflicts and dependency cycles, each with the rule that found it.
- **Tasks with exact context.** Each task carries its own words first, then only what it links to: components, requirements, decisions, stack. Secrets are removed, and you see the exact text before sending.
- **Send to Kanban.** Creates To Do cards with prerequisites first. Sending again never makes duplicates. When the design changes, only the affected cards are flagged: update them, keep them or improve them.
- **Optional AI help.** **Improve with Compose** and **Suggest tasks** only propose. Nothing changes until you accept.
- **Create Context.** Exports the design as one editable Markdown document, with Mermaid diagrams, ready to attach to prompts or agents.
- **Research.** Chat with your own Claude Code or Codex about any part of the plan: guided chat, a swarm of parallel agents, a Decision Lab that compares options, or a blueprint audit. Add web search, documents, Base knowledge or MCP sources. Suggestions are applied only when you approve them.

<p align="center">
  <img src="docs/origin-demo.gif" width="960" alt="Origin demo: describe an online shop, add requirements, connect building blocks into layers, accept a decision, prepare tasks with their context, and view the project mind map.">
  <br><sub>Idea → requirements → architecture → decisions → tasks → project map</sub>
</p>

## Compose

**Turn a rough request into a precise prompt for a coding agent.**

Your CLI drafts the prompt. In **Reviewed** mode, a second, fresh call checks that every part of your request is covered and unchanged, and only confirmed problems are repaired. You get the prompt and a check report. **Fast** mode uses one call.

- **Settings.** 19 task types (build, debug, refactor, tests, security, migration, CI/CD and more), CLI, model, reasoning effort, level of detail, and English, German or Polish.
- **Exact text is kept.** Code, quoted text, file paths and URLs are checked to come through unchanged. Add your own **Terms to keep**.
- **Context grounding (optional).** Researches only the sources you select: a project folder, documents and PDFs, Context7 or your own read-only MCP servers, and expert notes. Research depth scales with the task, and **Cancel** stops everything.
- **Clear writing.** Prompts follow rules based on ASD-STE100 Simplified Technical English.
- **Use the result.** Copy it, edit it, download it as Markdown, add it to Kanban, split it into smaller To Do cards, or save it to a project with revisions. History stays in your browser.

<p align="center">
  <img src="docs/compose-demo.gif" width="960" alt="Compose demo: enter a request, choose generation settings, generate a structured prompt, edit and save it, then split it into three To Do tasks.">
  <br><sub>Idea → settings → prompt → edits → tasks</sub>
</p>

## Kanban

**Let your agents do the work, task by task, from To Do to Done.**

Each card gets its own Git branch and worktree. When a card enters a column, that column's agent starts in a fresh session, and Promptboard checks the result before the card can move on. Drag cards yourself, or let Autopilot run the queue.

| Column | What happens | The card moves on when |
| --- | --- | --- |
| Planning | An agent writes a read-only plan. | The plan is ready. |
| Executing | An agent implements the task, or fixes what came back. | The changes are committed. |
| Code Review | An agent reviews the diff, read-only. | No blocking findings remain. |
| Testing | Your test command runs, or an agent finds and runs the tests. | The tests pass. |
| Merge | Promptboard merges the reviewed, tested commit. | The target branch has it. |

- **Rework until done.** Blocking findings and failing tests send the card back with the details. Minor suggestions are shown but don't block. Rework continues while each round makes progress, and pauses only when the same problem keeps coming back.
- **Autopilot.** Runs your queue in order, one card at a time, and skips cards whose prerequisites aren't done yet. Before it starts, it lists anything the board still needs.
- **Safe merges.** Squash (the default) or fast-forward, and only if the target hasn't moved. If it has, the work is tested again. Conflicts go to a resolver agent, whose result is reviewed and tested again. You can also open a pull request through the GitHub CLI.
- **Mix providers.** Each column can use its own CLI and model, for example Codex executes and Claude reviews. Each agent gets the task state, never another agent's conversation.
- **Permissions you choose.** For the whole board or per column: ask or autonomous; read-only, task workspace or full access; manual or automatic completion.
- **Built-in terminals.** Watch every agent live and type into it. Pause and resume keep the agent's own conversation and files.
- **Column actions.** Run a script, call a webhook, send a notification, or message the agent when a card enters a column.
- **Coordinator.** A read-only overview of progress, running agents and blockers. Ask it questions and get answers with sources. It calls a model only when you ask.
- **Workspace and history.** Browse and edit project files, see the board as a timeline, and search, filter or restore completed tasks. Labels, priorities and stable task numbers (`#12`) are built in.
- **Backups.** Export and import a whole board as JSON.

<p align="center">
  <img src="docs/kanban-demo.gif" width="960" alt="Kanban demo: browse the project workspace, edit a file, start Autopilot, run a task through Executing, Code Review, Testing and Merge, and finish in Done with agent terminal tabs.">
  <br><sub>To Do → Execute → Review → Test → Merge → Done</sub>
</p>

## Base

**Set up what your agents use once, and reuse it everywhere.**

Store resources in one library and assign them to a project, a column or a single card. When a run starts, Promptboard pins exactly what that run gets and delivers it the provider's native way: MCP configuration, instructions, or Claude Code subagents. Saving or assigning never starts an agent.

- **Resource types.** Agent profiles, packs, MCP servers (stdio or HTTP), skills, knowledge wikis, context sources and command recipes.
- **Agent profiles.** Instructions plus the resources they need. Attach other profiles as Claude Code subagents. Add an optional illustrated avatar.
- **Scoped assignment.** Inherit, add, replace or opt out at each level. Mark a resource required to block a run that can't receive it.
- **MCP connection test.** Discovers a server's tools without calling them, and only when you click.
- **Knowledge wikis.** Markdown pages and imported sources, with optional AI-written drafts you review.
- **Run details.** Shows exactly what each agent received.
- **No stored secrets.** Credentials are referenced by environment variable name only.

<p align="center">
  <img src="docs/base-demo.gif" width="960" alt="Base demo: browse the resource library, inspect a skill and linked knowledge pages, view agent cards, and assign resources to a project without starting an agent.">
  <br><sub>Store → configure → assign → inspect</sub>
</p>

<sub>The demos use the real interface with simulated agents. Saves, Git and resource delivery are real.</sub>

## Also included

- **CLIs installed** (top bar): connect, sign in and check each CLI from any page.
- **Usage**: tokens, tool calls and cost estimates, read from your CLIs' local records. They're estimates, not invoices.
- **Settings**: theme, start page, default agents, how many agents can run at once, terminal and notification preferences.
- **Command line**: `node bin/ste.mjs --provider claude < request.txt` writes a prompt without the app. Run `--help` for all options.

## Supported CLIs

| CLI | Compose | Kanban |
| --- | --- | --- |
| [Claude Code](https://code.claude.com/docs/en/quickstart) | ✓ | ✓ |
| [OpenAI Codex CLI](https://developers.openai.com/codex/cli) | ✓ | ✓ |
| [Gemini CLI](https://geminicli.com/docs/get-started/installation/) | ✓ | ✓ (not live-verified) |
| [Antigravity](https://antigravity.google/docs/getting-started?tab=cli) (`agy`) | ✓ | — |

Agents run through each CLI's own sign-in and plan. Promptboard has no account of its own.

## Privacy and security

- Runs only on `127.0.0.1`, with no analytics or telemetry.
- Prompts and the context you select go only to the provider you choose, through its CLI.
- Boards, logs and worktrees stay in your local data folder. New project repositories go in `~/Promptboard/projects`.
- In autonomous mode, an agent can change files in its task workspace. Read [SECURITY.md](SECURITY.md) before you use sensitive repositories.

## Good to know

- Without a test command, Testing relies on the Testing agent's own report. Set a command when you need an independent run.
- Promptboard answers only the CLI's folder-trust prompt for you. Other startup prompts (sign-in, changed hooks, updates) need you in the terminal. Autonomous columns flag them after 2 minutes.
- To use another port, run `npm start -- --port 4320`. To check which CLIs are installed, run `node bin/ste.mjs --doctor`.

## Docs

- [Kanban execution](docs/kanban-execution.md): stages, rework, merge and error codes
- [Origin](docs/origin.md) · [Origin Research](docs/origin-research.md) · [Project Context](docs/origin-project-context.md) · [Shared projects](docs/shared-projects.md) · [Coordinator](docs/coordinator.md)
- [Compose context research](docs/compose-context.md) · [Prompt checks](docs/verification.md)
- [Base delivery](docs/base-delivery.md) · [CLI adapters](docs/cli-adapters.md) · [Session persistence](docs/session-persistence.md)
- [Changelog](CHANGELOG.md) · [Release verification](RELEASE-VERIFICATION.md) · [All docs](docs/)

## Contributing

Plain Node.js with ES modules. No framework, no build step. Before you open a pull request, run:

```bash
npm run check
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)

<sub>Prompt writing rules draw on ASD-STE100 Simplified Technical English. ASD and STEMG do not endorse this project.</sub>
