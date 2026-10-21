# Project card and explorer

On a Kanban board whose project has a linked folder, one extra lane follows **Done**. It holds the **Project: <name>** card:

- the project folder and the branch checked out there;
- the latest commit, with its time;
- the last merged card (number and title);
- **Open project** and **Pop out**.

The card is not a task. It cannot be dragged, moved, numbered, started or archived, nothing can be dropped on its lane, and it is not part of the column settings, counts, Autopilot, backups or the Coordinator. A project without a linked folder has no lane.

## The explorer

**Open project** opens the explorer in a large window over the board. **Pop out** opens the same explorer as its own page (`/project.html?project=<id>`, titled "<name> — Promptboard"). That page reads its own session, so it keeps working after the board tab is closed, and a restarted app is picked up on the next request.

- **Files** on the left, folders first. A folder is read only when you open it. Hidden files (names starting with a dot) and files Git ignores are dimmed. Git's own folder is not shown; links, special files and credential files are shown but never opened.
- **Git markers** next to names: **M** modified, **A** added, **U** untracked (not in Git yet). A folder with changes inside shows a dot.
- **Filter** narrows the folders you have opened. It does not search unopened folders.
- **Keyboard:** ↑ ↓ move, → opens a folder or enters it, ← closes it or goes to the parent, Home and End, Enter opens.
- **Tabs** on the right, up to 12, with line numbers and the same syntax colours as the file viewer. A dot marks a tab with unsaved changes. Closing it asks first.
- **Save** or **⌘ / Ctrl + S** writes the file. Nothing saves on its own.
- **Read only:** binary, non-UTF-8 and files over 512 KiB open with a note and **Open in IDE**.
- **New file** and **New folder** ask for a name in the tree, inside the selected folder. They never replace an existing name. A new file opens in a tab.
- **Refresh** reads the open folders, the Git markers and the open files again. This also happens when the window gets focus again, so files a merge added show up.
- **Open in IDE** opens the project folder in the editor you used last, or lets you choose one of the editors found on this computer. A paired phone does not show it.
- Drag the edge between the tree and the editor to resize it; arrow keys work on it too. The width is remembered in this browser.

Deleting and renaming are not offered: both can lose work, and the explorer has no undo. Use your editor or Finder for those. The file viewer's optional AI panel stays in the sidebar viewer only.

## What it shows

The explorer shows the **project checkout**: the folder you linked, where merged cards land. Task worktrees stay in the sidebar's file list (its checkout menu).

Merges move the target branch (for example `main`). When the checkout has that branch checked out, a merge fast-forwards it and the new files appear here. When another branch is checked out, the explorer says so: merged work is on the target branch, not in these files, until you check it out.

## Saving while agents work

- Every save carries the version of the file you opened. When the file changed on disk since then (an agent merge, another editor), the save is refused and nothing is overwritten. You choose: **Reload** takes the disk version and drops your changes; **Keep mine and save anyway** saves your version over the newer one. Refresh shows the same choice as soon as it notices the change.
- Promptboard does not merge into a checkout with uncommitted changes to tracked files (it never stashes or discards them). The explorer says it plainly: "You have changes here that are not committed. Promptboard will not merge cards into main until you commit or discard them." The card's merge stays blocked with that reason until you commit or discard the changes, then you merge again. New files that are not in Git yet do not block a merge.

## Boundaries

- Routes, all behind the session token, host, origin and fetch-site checks: GET `/api/projects/:id/files` and GET/PUT `/api/projects/:id/file` (the file viewer's), POST `/api/projects/:id/files` (create `{ path, kind: "file" | "directory", scopeVersion }`) and GET `/api/projects/:id/git-status`. POST `/api/projects/:id/open` (Open in IDE) is local-only.
- Paths are checked like the file viewer's: no absolute paths, `..`, links, Git internals or credential files, and the folder identity (`scopeVersion`) must still match. Creating uses exclusive creation, so an existing file or folder is never replaced. Names Windows cannot hold are refused on every system, so the project still checks out there: `< > " | ? *`, a trailing dot or space, and device names such as `CON`, `NUL.txt`, `CON .txt` or `COM1`.
- Git runs without a shell and without optional locks (`git status --porcelain=v1 -z`, `git log -1`), so a status read never waits for or blocks a merge. Answers contain folder names, never absolute paths.
- Nothing here calls a model, starts an agent or runs a command, and nothing runs while the board and the explorer are closed. The card reads Git when the board shows it: after a merge, and at most every 30 seconds.
