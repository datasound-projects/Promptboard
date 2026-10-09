# Pipeline Autopilot

On a column-pipeline board, **Autopilot** (next to **Columns**) takes queued To Do cards one at a time through the active columns you choose, then moves each card to Done.

## How a card goes through

- **First column:** entering it starts the card's agent with the card's own task, exactly as dragging the card there would.
- **Later columns:** the card keeps the same agent conversation, so each later column gives the agent its instruction when the card arrives. The instruction is the column's **on enter** agent message, a deferred message configured in **Columns**.
  - The Autopilot dialog lists each instruction.
  - **Add default instructions** fills in any that are missing. You can change them later in Columns.
  - Autopilot does not start while a later column has no instruction, because its agent would receive nothing new there.
- **Plan columns:** a column reached through an approved plan (a plan column's **After native plan approval** target) needs no extra instruction. The approved plan already says "Proceed with implementing the approved plan."
- **When a column is finished:** its agent has completed a new turn since the card arrived, it is idle, and its instruction was delivered.
  - A plan column waits for you to approve the plan in the agent's terminal. The approval moves the card on, and Autopilot continues from there.
- **After the last column:** the card moves to Done. Its agent is paused there, and its branch, worktree and conversation are kept.

## Limits

- Autopilot never merges, pushes or opens pull requests.
- It never bypasses agent permissions or answers for you. When an agent asks something, the Autopilot bar says so and offers **Open terminal**.
- It works through one card at a time. Before each new card it refreshes the target branch, so the card starts from the latest commit.

## When it pauses

- A card's agent fails, is interrupted or is stopped.
- A card is moved by hand to a column that is not in Autopilot's list.
- You pause an agent yourself.
- A column's instruction did not reach its agent, for example because you typed a message in its terminal first. The bar shows the reason. Send the instruction yourself, then **Resume**; Resume continues without re-sending it. Answering the CLI's own permission or question prompts (arrow keys, Enter, a number) does not cancel an instruction.

Resume continues from the card's current column. If that column's agent is no longer running (for example after the app restarted), Autopilot starts it again there and tells the resumed conversation to continue its current step. **Skip card** leaves the card where it is and takes the next one; **Stop** leaves every card where it is.

System handoffs between agent turns, and Autopilot's own move to Done, do not pause it.
