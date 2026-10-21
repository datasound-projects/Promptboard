# Project memory

Project memory keeps lessons from finished work, so the next agents of a project start smarter. After a card merges, Promptboard suggests a few lessons; you approve, edit or reject each one. Approved lessons go to every new agent run of that project.

There are four kinds of lesson:

- **Command**: a command that worked here (install, build, test, lint, run).
- **Convention**: a rule this codebase follows.
- **Gotcha**: a trap that cost time, and how to avoid it.
- **Failed approach**: something that was tried and did not work, so nobody repeats it.

## When lessons are suggested

- After every merged card: a merge (Merge, Merge now, a legacy board's automatic merge, the typed Merge column with automatic completion, either Autopilot) or a pull request that was merged on GitHub. All of them end in one place (`Board.completeTask`), which only queues a job; the merge never waits for it and never fails because of it.
- Not for **Reviewed: no changes required**, **Done without merging** or a pull request that is still open.
- **One short run with a small model** per merged card, using the CLI that executed the card:

  | CLI | Model (default) |
  | --- | --- |
  | Claude Code | `haiku` |
  | Codex | its own default model, low effort |
  | Gemini CLI | `flash` |
  | Antigravity | not possible: it cannot run without tools. The card shows why; choose another CLI under **More**. |

- The run has every tool disabled, works in an empty temporary folder that is removed afterwards, and stops after 3 minutes.
- It goes through the same one-at-a-time CLI slot as Compose, Research, the Coordinator and sign-in. While the slot is busy it waits and tries again 30 seconds later. When you start your own work (Generate, Research, a Coordinator question, a sign-in that is allowed), the lessons run steps aside: its CLI is stopped, your work starts as soon as it has stopped (a few seconds at most), and the lessons run is queued again. A run stopped 3 times (by your own work or an app restart) is not resent on its own: the card says so and offers **Suggest again**.
- Jobs are saved. A job that was queued or running when the app stopped runs after the next start.
- A failure (CLI missing, not signed in, a timeout, an answer that is not a list of lessons) is shown on the card with its reason and **Suggest again**. It is never retried on its own.
- **No new lessons** is a valid answer and is shown as such.

## Approving lessons

- **Card details** of a merged card: **Suggested lessons**, each with its kind, text and evidence, and **Approve**, **Edit** (text and kind) and **Reject**, plus **Approve all**. While the run works it says **Suggesting lessons…**. A card merged before this feature, or while it was off, offers **Suggest lessons**.
- **Project memory** (Kanban project settings → **Memory** → **Open**):
  - approved lessons grouped by kind, each with **Edit** and **Remove** (a removed lesson no longer reaches agents and is not suggested again);
  - suggestions waiting for you, each linked to its card;
  - the switch **Suggest lessons after each merged card**, on by default: *One short run with a small model after each merged card.* Off, merges queue nothing and a waiting automatic run is dropped; **Suggest lessons** on a card still asks once, because you clicked it;
  - under **More**: the CLI and model of the suggestions. The model applies to the CLI you choose.
- Every change checks the revision you loaded. If project memory changed in another window, or new suggestions arrived, you are asked to reload. A lessons run starting or ending without new suggestions does not count as a change.
- A suggestion that repeats an approved, suggested, edited or rejected lesson (compared without case and punctuation) is dropped.
- Limits: 100 suggestions (the oldest make room), 200 rejected lessons (the oldest go) and 200 approved lessons. Approved lessons are never dropped: at 200, remove some before approving more.

## What agents receive

Every new agent run of the project (any stage or column) gets one section after its task, its plan and its stage context:

```
=== PROJECT LESSONS (approved by the owner from earlier finished cards) ===
Commands that worked:
- Run the tests with npm test.
Conventions:
- Each feature has its own file in src/.
=== END PROJECT LESSONS ===
```

Newest first, at most 8,000 characters, grouped by kind. A project without approved lessons gets no section. A resumed conversation already has them and gets nothing new. The section is saved with the run in `prompt.md`.

**Origin**: the Project Context screen shows the same approved lessons of the linked board as **Lessons from finished work**, with **Manage in Kanban**. They are shown beside the document: the Project Context text, its hashes and versions do not change.

## What the model receives

At most about 24,000 characters, built from the board's own records:

- the card's number, title and text (first 3,000 characters);
- what the executing agent reported (its stage summary);
- the review verdict and findings;
- the test commands, pass or fail, and the last output of failed ones;
- rework notes and the reasons in the card's stage history;
- the merge: target branch and number of commits, or the pull request;
- the names of the changed files (`git diff --name-status` of the merge, read in the repository, at most 150);
- the newest lessons you approved (up to 40, 6,000 characters) and rejected (up to 20, 3,000 characters), so it suggests neither again, not even reworded. They keep their room: the card's facts are cut first.

Local folders are cut to their last name (`/Users/you/shop/README.md` becomes `…/README.md`), and secret-looking values (API keys, tokens, passwords, private keys, credentials in URLs) are masked. Environment variables, CLI credentials, agent transcripts and terminal logs are never included. The card text and the facts are marked as data, not instructions.

The answer must be a JSON array of at most six `{kind, text, evidence}` (text at most 300 characters, evidence at most 200). Anything else is dropped.

## Storage and backups

- `<data folder>/lessons/<project id>.json` (in file names, capital letters and `_` in the ID are written as `_` plus the lowercase letter), replaced atomically with the previous copy kept as `.bak`. A damaged file is kept aside as `….corrupt-…` and never overwritten. A file saved by a newer Promptboard version is left as it is: that project asks you to update the app, and every other project's memory keeps working. Shape: `{schema, version, projectId, revision, settings: {enabled, provider, model}, lessons: [{id, kind, text, evidence, taskId, taskNumber, status: suggested|approved|rejected, createdAt, decidedAt?, edited?}], jobs: [...]}`.
- A project without the file has no lessons and the switch on. Nothing is written until a card merges or you change something.
- **Board backups** carry each project's approved lessons and settings. Suggestions and jobs are not exported. Importing a backup gives each project in it exactly the saved lessons and settings, when the backup has them. A backup without project memory (made before it existed) leaves the memory already stored for its projects as it is. Memory of a project the import removes from the board is not deleted: it stays in the data folder, unused, and comes back if a project with that ID returns.
- Deleting a project deletes its project memory.

## Routes

All of them go through the app's usual checks (local host and origin, session token) and work from a paired phone too. Every change needs `expectedRevision`.

| Method and path | What it does |
| --- | --- |
| `GET /api/projects/:id/lessons` | Settings, approved and suggested lessons, the number rejected, and the latest job of each card. |
| `PATCH /api/projects/:id/lessons/:lessonId` | `{status, text, kind}`: approve, reject (also Remove) or edit one lesson. |
| `POST /api/projects/:id/lessons/approve` | `{ids}`: approve these suggestions. |
| `PATCH /api/projects/:id/lessons/settings` | `{enabled, provider, model}`. |
| `POST /api/tasks/:id/lessons` | Suggest again (or the first time) for a merged card. |

Code: [`src/lessons.mjs`](../src/lessons.mjs) (store, worker, routes, prompt section) and [`public/lessons.js`](../public/lessons.js) (page).
