# Shared projects

Origin, Compose and Kanban can share one project. Every connection is optional: Compose works without a project, and each page still works on its own.

## One project, one ID

- A project has one ID across Origin and Kanban. A board created from Origin (with **Also create a Kanban project**, or later with **Connect to Kanban → create**) takes the Origin project's ID. An Origin blueprint started for an existing board takes the board's ID.
- Names are not duplicated across the three pages. A project's name and its board's name both count, without regard to case:
  - Creating an Origin project whose name matches a board that no Origin project uses joins that board.
  - Creating a board whose name matches an Origin project without a board makes that project's board.
  - Creating a project, renaming an Origin project or naming a new board with a name another project uses is refused (`NAME_TAKEN`). A project may take its own board's name.
  - Choosing a name in Compose selects the existing project, also when two windows ask for the same new name at once.
- A board with an Origin project's ID belongs to that project, even without a stored link; another Origin project cannot link to it (`ALREADY_LINKED`).
- Links made before this change, with different IDs on each side, keep working: the project is listed once and is reachable by either ID. Deleting the Origin side of such a link keeps the board as a project, and the board takes over the saved prompts.
- There is no separate project registry. The list (`GET /api/shared-projects`) is derived from Origin projects and Kanban boards, so names are never copied.

## Compose: History and Projects

- The Compose sidebar has two categories:
  - **History** is unchanged: every generated prompt, in this browser, with no project needed.
  - **Projects** lists the shared projects and their saved prompts.
- **Save to project** (under **More** on a result, or the ⇢ button on a History entry) saves the prompt with its request, settings and checks into a project you choose or create. On a History entry you can also **Move** it, which removes it from History after saving.
- Saving never creates a Kanban card or a board.
- Saved prompts are stored on this computer in `<data folder>/prompts/prompts-<project id>.json` (atomic writes, previous copy kept as `.bak`). They are separate from History and from the board, and they are not part of the Kanban backup.
- Each saved prompt keeps every revision (up to 100). Saving identical text again adds nothing. Saving the same History result twice in one project returns the existing prompt.

## The link bar in Compose

A prompt opened from somewhere else shows where it came from:

- **Project · name / prompt (revision N)** — a saved prompt.
  - **Save as new revision** keeps the current result as the next revision.
  - **Create Kanban card** adds the current revision to To Do. If the project has no board yet, it offers to create one with the project's ID.
  - Each linked card and Origin record is a button that opens it.
  - **Update card** gives an older card the current revision.
- **Kanban · #N title** — a card opened with **Open in Compose** from the card editor. **Update card** sends the refined prompt back.
- **From Origin · record** — **Send to Compose** from an Origin record. Saving the result links the prompt to that record.

**Unlink** keeps the result without the link. **New prompt** and opening a History entry clear it.

## Cards keep their instructions

- A card made from a saved prompt records the project, prompt and revision it received (`source.projectId`, `source.promptId`, `source.promptRevision`).
- If the prompt's link to a new card cannot be saved, the card is deleted again, so trying again makes one card. If it cannot be deleted either, the error (`CARD_UNLINKED`) names the card to delete.
- New revisions never change a card on their own. The card shows the newer revision only after **Update card**.
- **Update card** changes only an idle card in To Do: no queued or running agent and no column automation in progress. Otherwise it is refused with `CARD_BUSY`, and the card and its run keep their instructions; create a new card instead.
- A card whose prompt was edited on the board is replaced only after you confirm.
- Every update raises the card's text revision, so existing plan approvals and resumable sessions for the old text are treated as stale, as for any prompt edit.

## Reverse navigation

- **Origin:** a record's editor lists the saved prompts linked to it and their Kanban cards.
- **Kanban:** a card's details show **From a saved prompt → Open the saved prompt in Compose**, and **From Origin → Open in Origin** for cards sent from Origin.
- **Compose:** the link bar opens linked cards and Origin records.

## For integrations

- The references are plain IDs, stable across pages:
  - project ID, plus every ID of a project in `ids`
  - prompt ID and revision number
  - Kanban card ID
  - Origin `{ originId, collection, id }`
- Names and card columns are read when needed, never copied.
- Routes: `/api/shared-projects`, `/api/shared-projects/:id/{board|origin}`, `/api/shared-projects/:id/prompts[/:promptId[/revisions|/cards[/:taskId/update]]]` and `POST /api/tasks/:id/refine`.
