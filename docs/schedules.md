# Scheduled cards

A schedule makes the same card again and again: it lands in To Do on a repeat, for example a nightly dependency update or a weekly docs or security sweep. With **Run with Autopilot** switched on, agents then work on each new card without you starting it.

## Making a schedule

- **Schedules** in the board actions (after **Autopilot** and **Coordinator**) opens the list of the project's schedules. **New schedule** opens the editor. The editor of a new schedule, and an empty list, offer three quick starts that prefill it: **Nightly dependency update** (every day at 02:00), **Weekly docs sweep** (Mondays at 03:00) and **Weekly security sweep** (Wednesdays at 03:00). Each tells the agent to check, change, test and report, and to change nothing when nothing needs changing.
- The editor holds the card's **Title** and **Task** (what the agent should do each time; up to 20,000 characters), the **Repeat** and the **Time**:
  - **Daily**, **Weekdays** (Monday to Friday), **Weekly** (pick one or more days) or **Monthly** (pick a day from the 1st to the 28th, which every month has).
  - Times are this computer's local time. On the night the clocks go forward, a time that does not exist (02:30) runs an hour later; on the night they go back, a time that happens twice runs once, the first time. Other times stay the same local time all year.
- **More** holds the card's priority and labels. A label removed from the project later is left off new cards.
- The list shows each schedule's repeat in words ("Every weekday at 02:00"), when it runs next ("Next Tue 27 Oct, 02:00", shown in the time zone of the device you look from) and what happened last time: "Created #12", "Created #12 · Autopilot started", or "Skipped: previous card #11 is still open". Each row has an on/off switch, **Run now**, **Edit** and **Delete** (which asks first; the cards a schedule made stay on the board).
- At most 50 schedules per project.

## When cards are made

- Only while Promptboard runs. One timer waits for the earliest next time of all schedules, and checks at least once a minute, so a computer that slept or a clock that changed is noticed within a minute.
- A time missed while Promptboard was closed or the computer slept gives **one** card on the next check, never one per missed time. Its task text ends with a note saying when it was due and when it was created.
- **No pile-up.** While the previous card of a schedule is not in Done (still in To Do, or in progress), its next time is skipped and the list says why. The skipped time is used up; the next one tries again.
- Each time makes at most one card: the time is recorded in the same board write that creates the card, so a check that runs twice never makes a second card.
- A schedule switched off and on again, or given a new repeat, starts counting from that change: it does not catch up on the times before.
- **Run now** makes a card at once, through the same path, even while the previous card is open (you asked for it), and leaves the next time as it was.
- Cards are made through the board's normal card path: the same checks, task number, priority and labels as a card you add. They carry a small **Scheduled** marker, and their details name the schedule and the time they were made for.

## Run with Autopilot

- Available only when the project has a code folder. Switching it on for a schedule asks once whether agents may work on its cards without asking you; that confirm is your consent, and the server refuses the switch without it.
- When a card is made:
  - **Autopilot running:** the card joins the end of its queue. Autopilot's own rules still decide when it runs (prerequisites, one card at a time); the cards it already finished stay finished.
  - **Autopilot off or finished:** Autopilot starts for this one card, the way **Start Autopilot** does in its dialog, with its saved steps (or the dialog's default steps) and its own checks.
  - **Autopilot paused by you:** it is not resumed. The card waits in To Do, and the schedule says "Autopilot is paused, so the card waits in To Do".
  - If Autopilot's checks refuse to start (for example a column without an instruction), the card stays in To Do and the schedule shows the reason.
- Without **Run with Autopilot**, a schedule only makes cards: no agent starts and no tokens are spent until you start one.

## Backups

A board backup carries each schedule's settings (title, task, repeat, priority, labels, Autopilot, on/off), not the record of earlier cards. A restored schedule comes back switched off and without Autopilot, so a restored board starts nothing until you switch each schedule on, and confirm Autopilot again, on this computer.

## For developers

- Stored as `project.schedules` in `state.json`: `{ id, title, prompt, priority, labelIds, cadence, autopilot, enabled, createdAt, updatedAt, lastFiredAt, lastSlot, lastTaskId, lastSkip?: { at, reason }, lastAutopilot?: { at, ok, text } }`. A project saved before schedules has none. A card made by a schedule has `scheduleId` and `scheduledFor` (the time it was made for).
- `cadence` is `{ kind: 'daily' | 'weekdays', time: 'HH:MM' }`, `{ kind: 'weekly', days: [0..6], time }` (0 is Sunday) or `{ kind: 'monthly', day: 1..28, time }`. `nextFire(cadence, after)` in `src/schedules.mjs` is pure and exported.
- Settings changes check and raise the project revision, like the other project settings. Making a card does not.
- Routes (all through the usual session token and origin checks; allowed from a paired device):
  - `GET /api/projects/:id/schedules` → `{ revision, schedules }`, each with `next` (ms, or null when off)
  - `POST /api/projects/:id/schedules` with the settings and `expectedRevision` (plus `confirmAutopilot: true` to switch Autopilot on)
  - `PATCH /api/projects/:id/schedules/:sid` with the fields to change and `expectedRevision`
  - `DELETE /api/projects/:id/schedules/:sid?expectedRevision=N`
  - `POST /api/projects/:id/schedules/:sid/run` (Run now)
  - Changes answer with the list and the board. Errors use the board's codes: `REVISION_REQUIRED`, `REVISION_CONFLICT`, `NOT_FOUND`, `LIMIT`, `CONFIRMATION_REQUIRED`, `REPOSITORY_REQUIRED`, `INVALID_TASK_PRIORITY`, `INVALID_TASK_LABELS`, and `INVALID_SCHEDULE` for the rest.
