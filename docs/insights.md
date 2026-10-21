# Insights

Insights shows how a Kanban project's work went, counted from what the board already records. It is the lightbulb icon next to **Settings** in the top bar, on every page. It opens one dialog for the project shown on the Kanban page; with several projects, a picker chooses another one.

Opening Insights reads the board once. It never asks a model, starts an agent or changes anything, so it spends no tokens.

## The range

**Last 30 days** (the default), **90 days** or **All**. Finished cards count when their completion falls in the range. Time in columns counts stays that ended in the range or are still going on. Review and test failures count when they happened in the range.

A finished card is a card in Done. Merged means merged into the target branch, or a pull request that was merged.

## What it shows

1. **Summary**: cards finished, cards merged, the median time from a card's first agent start to its merge, and the tokens its agents used (cached input on its own). A price appears only when Claude Code reported one.
2. **Rework**, by agent (the CLI), by model and by template: the share of finished cards that went back at least once, the average number of rounds per card, and how many cards that is.
   - A round is a review that asked for changes, or failed tests. On column pipelines this comes from the stage history; a moved target branch or a resolved merge conflict is not a fault of the work and is not counted. Boards without a stage history count moves from Code Review or Testing back to Executing; a run that could not start and returned its card by itself is not counted.
   - A round belongs to the agent and model of the run whose work was sent back: the latest Executing run (or custom agent column run) that started before the round. Planning, review, testing and merge runs check work, so they are never charged with it. A card counts once for each agent and model that worked on it.
   - Template: the template of the Origin blueprint the card came from, else the saved prompt it was made from (“Saved prompt: …”), else “No template”. A card whose Origin project was deleted shows “Removed Origin project”. Names are read through the Origin and saved-prompt stores when Insights opens.
3. **Time in each column**: one bar per column, in board order, with the median and total time of a stay (from entering a column to leaving it). A card still in a column counts up to now and is marked “still here”. Done has no bar: cards end there. A card whose move log is full (100 moves) has lost its oldest moves, so its first stay is left out instead of guessed.
4. **Cost per merged card**: input plus output tokens, cached input on its own, and the price.
   - Token usage is cumulative per native conversation (a resumed run reads the conversation from its start), so each conversation counts once, at its highest numbers, and the conversations of a card are added up.
   - The price is Claude Code's own estimate from its status line, copied onto the run while it works. Promptboard has no price table and never estimates one. Codex reports no price, and Gemini CLI and Antigravity report neither tokens nor price: the price then shows “—”, and its tooltip says why. Runs from before this version have no price either.
   - A run that worked (it finished a turn or showed signs of its session) but left no usage record also makes the price “—”: its tokens are missing, so any price would be too low. A run that never got that far (a startup question, a failed start) spent nothing and is left out.
   - The ten costliest merged cards are listed; the rest are under **More**.
5. **Cards that fail review most**: the ten cards with the most review and test failure rounds in the range, finished or not, with the latest reason. When the cards come from more than one template, a short grouping by template follows. A card name opens that card's details on its board.

## Details

- Route: `GET /api/projects/:id/insights?days=30|90|all` (30 when left out). It passes the app's usual local checks and session token. A paired phone can read it too: it only reads.
- `src/insights.mjs` holds `computeInsights(state, projectId, { days, now, originLookup, promptLookup })`, a pure function: one pass over the project's newest 5,000 runs and its cards. With more runs than that, the dialog says the figures are based on the newest 5,000.
- Stored data: Claude runs gain `usage.costUSD` when Claude Code's status line reports a price for the same session. Nothing else is stored; older boards load unchanged.

## Known limits

- Whether Claude Code keeps adding to a conversation's price when Promptboard resumes it is not verified. Insights takes the highest price reported for each conversation. If Claude Code starts the price again from zero after a resume, the price shown covers only the most expensive part and is too low.
- The figures come from the board's own bounded records: the newest 5,000 runs, the last 50 stage results and the last 100 moves of each card.
- Stays in columns that were later removed from the board are left out.
