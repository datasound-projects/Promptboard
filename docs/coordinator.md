# Coordinator

The Coordinator is a read-only observer for one project. It sits above the Kanban columns and explains what is happening. Kanban cards stay the single source of truth for task execution, and agents still receive their task from their card, unchanged.

## The panel

- **Coordinator**, right after **Autopilot** in the board toolbar, opens and closes the panel with one click. It starts closed, and the choice is remembered per project in this browser.
- Open, it shows active agents, progress per column, what needs attention (an agent waiting for you, a failed run, a review that asked for changes, failed tests, a failed column automation, paused Autopilot) and recent activity, with **Ask Coordinator** and an **On/Off** switch. Every card name opens the card.
- **Off:** no updates and no questions. The project knowledge, history and chat are kept. On/Off is saved with the project's knowledge.

## Project knowledge

- Two compact files per project in `<data folder>/coordinator/`: the knowledge index `<project id>.json.gz` and the chat `<project id>.chat.json.gz` (gzip-compressed JSON, replaced atomically, each with its previous copy as `.bak`). In file names, capital letters and `_` in the ID are written as `_` plus the lowercase letter (`_` becomes `__`), so IDs that differ only in case never share a file. A board that reuses a deleted board's ID starts with empty knowledge and chat. The index holds references and small facts:
  - card number, title and column
  - state of its agent
  - branch
  - review and test results
  - completion
  - links to the saved prompt revision or Origin task it came from
  - the project's timeline events: moves, runs, reviews, tests, pull requests, completions, commits and notes
- Card prompts, Compose history, agent transcripts and logs are not copied. They stay in their own records and are read only when a question needs them.
- Events keep their original IDs and times. The same event is stored once and updated in place, for example a run that finished. Each update that changes something adds a small snapshot record with the board revision.
- Updates are deterministic and happen only when the panel is shown or a question is asked. There are no timers, no background work and no model calls.
- While the Coordinator is off, nothing is recorded. Turning it on reconciles what happened meanwhile from the board's own history, with the original times. The knowledge survives restarts.

## Asking

**Ask Coordinator** opens a chat in the panel. Choose **Project**, **Task**, **Agent** or **Branch**, or use **Ask Coordinator about this card** in a card's details.

- Evidence is chosen without a model:
  - the project's status, agents and blockers
  - for a card or agent: that card's own text, its events, its last runs and the agent's last message (excerpt)
  - for a branch: its cards, commits, reviews and tests
  - for the project: the cards your question names or matches, and recent activity
  - Origin names, layers, accepted decisions and requirements only for design questions
- The answer comes from one call to the CLI selected in Compose, without tools, in an empty temporary folder. The Coordinator cannot change code, cards, branches or agents.
- Answers cite their evidence as [T12], [run:…] or [commit:…]. References that exist become links: cards open, commits copy their ID. Anything else stays text.
- Asking the same question about the same evidence again uses the saved answer, without a model call.
- Each project keeps its own chat (the last 200 messages).

## Not included yet

Agents cannot ask the Coordinator themselves. When an agent waits for an answer, the panel shows it under **Needs attention**, and you can ask the Coordinator about that agent.
