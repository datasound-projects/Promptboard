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
  <a href="#origin--plan-the-project">Origin</a> ·
  <a href="#compose--write-the-prompt">Compose</a> ·
  <a href="#kanban--run-the-work">Kanban</a> ·
  <a href="#base--reuse-agent-resources">Base</a> ·
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

| Page | What you do there |
| --- | --- |
| **Origin** | Design the project: requirements, architecture, decisions, tasks. |
| **Compose** | Turn an idea into a clear, structured prompt for an agent. |
| **Kanban** | Run tasks through Execute → Review → Test → Merge, by hand or on Autopilot. |
| **Base** | Keep agents, skills, MCPs and knowledge in one library and reuse them. |

Every page shares one project, so a plan in Origin becomes cards in Kanban without copying anything.

## Origin — plan the project

- Describe what you want to build. Work through **Define → Design → Operate → Decide → Build** as short lists you can rename and extend.
- Sketch building blocks and layers, record decisions with their reasons, and keep assumptions apart from facts.
- See the whole plan as a mind map you can arrange and zoom.
- **Tasks** are prepared per component. Each carries only the context it needs, and you see it before sending.
- **Send to Kanban** creates To Do cards in dependency order. When the design changes, only the affected cards are flagged.
- **Create Context** exports the design as one editable Markdown document you can attach to prompts or agents.

<p align="center">
  <img src="docs/origin-demo.gif" width="960" alt="Origin demo: describe an online shop, add requirements, connect building blocks into layers, accept a decision, prepare tasks with their context, and view the project mind map.">
  <br><sub>Idea → requirements → architecture → decisions → tasks → project map</sub>
</p>

## Compose — write the prompt

- Describe the feature or fix. Pick the CLI, model, language and level of detail.
- Optionally let it research your selected sources first, so the prompt fits the real codebase.
- Edit the result, save your wording, copy it, or split it into smaller Kanban tasks.

<p align="center">
  <img src="docs/compose-demo.gif" width="960" alt="Compose demo: enter a request, choose generation settings, generate a structured prompt, edit and save it, then split it into three To Do tasks.">
  <br><sub>Idea → settings → prompt → edits → tasks</sub>
</p>

## Kanban — run the work

Each card runs in its own Git branch and worktree, so tasks never step on each other.

- **Typed columns.** Every column has one job, and its result is checked before the card moves on:

  | Column | Agent does | Card moves on when |
  | --- | --- | --- |
  | Planning | Writes a read-only plan | The plan is ready |
  | Executing | Implements the task | Changes are committed |
  | Code Review | Reviews read-only | No blocking findings |
  | Testing | Runs your test command, or finds and runs the tests | Tests pass |
  | Merge | Merges the reviewed, tested commit | The target branch has it |

- **Rework until done.** Blocking findings and failing tests send the card back with the details. Minor suggestions are shown but don't block. Autopilot keeps going while each round makes progress, and pauses only when the same problem keeps coming back.
- **Autopilot.** Runs your queue in order, one card from To Do to Done at a time, and skips cards whose prerequisites aren't done yet. Before it starts, it lists anything the board still needs.
- **Mix providers.** Each column can use its own CLI and model, for example Codex executes and Claude reviews.
- **Permissions you choose.** Set for the whole board or per column: ask or autonomous; read-only, task workspace or full access.
- **Built-in terminals.** Watch each agent live and type into it. Pause and resume keep the agent's own conversation.
- **Workspace.** Browse and edit project files with syntax highlighting. Unsaved drafts survive a refresh.
- **Coordinator.** A read-only overview of progress, running agents and blockers. Ask it questions and get cited answers; it calls a model only when you ask.

<p align="center">
  <img src="docs/kanban-demo.gif" width="960" alt="Kanban demo: browse the project workspace, edit a file, start Autopilot, run a task through Executing, Code Review, Testing and Merge, and finish in Done with agent terminal tabs.">
  <br><sub>To Do → Execute → Review → Test → Merge → Done</sub>
</p>

## Base — reuse agent resources

- One library for **agents, packs, MCPs, skills, knowledge, context and tools**.
- Build agent profiles with their own instructions and resources. Group resources into packs.
- Assign them to a project, a column or a single task, then inherit, add, replace or opt out.
- **Run details** shows exactly what each agent received.

<p align="center">
  <img src="docs/base-demo.gif" width="960" alt="Base demo: browse the resource library, inspect a skill and linked knowledge pages, view agent cards, and assign resources to a project without starting an agent.">
  <br><sub>Store → configure → assign → inspect</sub>
</p>

<sub>The demos use the real interface with simulated agents. Saves, Git and resource delivery are real.</sub>

## Supported CLIs

| CLI | Compose | Kanban |
| --- | --- | --- |
| [Claude Code](https://code.claude.com/docs/en/quickstart) | ✓ | ✓ |
| [OpenAI Codex CLI](https://developers.openai.com/codex/cli) | ✓ | ✓ |
| [Gemini CLI](https://geminicli.com/docs/get-started/installation/) | ✓ | ✓ (not live-verified) |
| [Antigravity](https://antigravity.google/docs/getting-started?tab=cli) (`agy`) | ✓ | — |

Agents run through each CLI's own sign-in and plan; Promptboard has no account of its own. Manage connections from **CLIs installed** in the top bar.

## Privacy

- Runs only on `127.0.0.1`. No analytics, no telemetry.
- Your prompts and selected context go only to the provider you choose, through its CLI.
- Boards, logs and worktrees stay in your local data folder. New project repositories go in `~/Promptboard/projects`.
- In autonomous mode, agents can change files in the task's workspace. Read [SECURITY.md](SECURITY.md) before you use sensitive repositories.

## Good to know

- Without a test command, Testing relies on the Testing agent's own report. Set a command when you need an independent run.
- Promptboard answers the CLI's folder-trust prompt only. Other startup prompts (sign-in, changed hooks, updates) need you in the terminal. Autonomous columns report them after 2 minutes.
- Use another port with `npm start -- --port 4320`. Check your installed CLIs with `node bin/ste.mjs --doctor`.

## Docs

- [Kanban execution](docs/kanban-execution.md): stages, rework, merge and error codes
- [Origin](docs/origin.md) · [Project Context](docs/origin-project-context.md) · [Shared projects](docs/shared-projects.md) · [Coordinator](docs/coordinator.md)
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
