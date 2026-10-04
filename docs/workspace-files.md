# Workspace project files

In Kanban, expand **Files** below a linked project. The tree follows the folder you opened or created, including its real nesting and untracked files. If that folder is inside a larger Git repository, sibling projects stay outside its tree. Task checkout selection maps the same relative folder into an existing registered worktree. Git/agent execution still uses its existing repository/worktree configuration.

New app-created projects initialize their own empty repository, even if the projects container already has one. Opening an existing subfolder does not initialize a nested repository or change its Git structure.

Folders load only when expanded. **Show more** pages through large directories. Click a file to open the centered viewer with its project, checkout and relative path. Multiple files share tabs; minimize with **−**, restore from the compact tray, and close with **×** or Escape. Up to eight files can stay open.

## Edit and save

**Edit** enables keyboard editing with the existing syntax colors and line numbers. **Preview** returns to inspection. **Save** or **⌘ / Ctrl + S** writes only this existing file. Nothing saves automatically, runs a project agent, stages a commit or merges code. UTF-8, Unicode, a BOM and uniform CRLF line endings are preserved. Binary, oversized and protected files remain unavailable.

Drafts stay in memory through refresh, file switching, minimization and page navigation. Closing a changed draft asks whether to discard it. Reloading/leaving the browser warns about unsaved work; drafts are not stored in localStorage. Removing/relinking a project keeps changed drafts available for copying but disables saving to the old location.

Visible expanded folders and the active file refresh every three seconds. Clean files update without losing expansion, selection or scroll. A disk edit never replaces an unsaved draft or a pending AI proposal. A conflict disables saving; **Copy draft**, then **Discard draft and reload** to compare/reconcile with the disk version. Failed saves retain the draft. A failed read labels retained content as the last read version.

Saves require the read content hash and folder identity. Saves to the same file are serialized. The server checks current bytes, file/folder identity and project/worktree custody twice, writes a temporary file next to the original, flushes it, preserves ordinary permissions and atomically replaces the file. Temporary files are removed on failure. Like other file editors, these optimistic checks cannot lock unrelated external applications out of the tiny interval between the final check and replacement. Coordinate simultaneous edits to the same file.

## Optional AI panel

**AI** opens a compact panel inside the viewer. Choose Codex, Claude Code or Gemini and an optional model ID; enter a change request. Only that request, the current file/draft and project/path labels go through the chosen CLI. No other project files, hidden credentials or surrounding repository context are supplied. Requests share the existing single CLI-operation slot with Compose/sign-in; they do not create a Kanban task, session or worktree.

The existing tool-disabled provider runs in an isolated temporary directory and returns a validated JSON proposal. It cannot intentionally run commands, save files or start project agents. Source text is explicitly untrusted data; it cannot grant tools or override the requested change. The CLI's configured account, model availability and policies still apply.

**View current draft / View AI proposal** compares the two complete versions. **Use proposal** puts the proposal into the unsaved editor; **Save** is still explicit. **Discard proposal** keeps the previous draft. **Cancel**, minimizing, closing or leaving Kanban aborts the request; late results cannot replace drafts. Provider failures or malformed/oversized output leave the file untouched. AI supports files/drafts up to 128 KiB; manual viewing/editing supports 512 KiB. The panel can be hidden and is optional.

## Boundaries

- Local session-token, origin and host protections apply to GET `/api/projects/:id/files`, GET/PUT `/api/projects/:id/file` and POST `/api/projects/:id/file-proposal`.
- Folder roots come only from saved linked projects. New links record the canonical selected folder; older links use their saved selected path. A read/write may not escape the selected folder. Worktree selection requires a recorded registered Git worktree with matching branch/common repository and never creates/repairs/switches it.
- Absolute paths, traversal, malformed components, symbolic links, Git internals, common credentials/private keys and special files are refused. Example `.env.example`/`.env.sample`/`.env.template` files remain available. Hard-linked files can be read but cannot be saved.
- Regular UTF-8 files are limited to 512 KiB and 20,000 lines. Requests, output, depth and listings are bounded. Lists return 250 entries per page, up to 5,000 entries; at most 64 folders per project stay expanded. No recursive background scans run for collapsed trees or other pages.
- Code/filenames/proposals are text nodes, never interpreted HTML or executed code. Inspection/manual editing contacts no model or external service. Only an explicit AI proposal sends the selected file through a CLI. No project contents or authentication secrets are persisted in browser storage.
- **Updated since opening** means a content change was observed; it does not identify its author. Existing activity does not reliably report individual editing paths, so files are never labelled as actively edited by an agent through inference.

Compose, Base, board imports and existing project agent execution remain independent. Tests cover nested project folders, registered worktrees, read/write security, conflicts, Unicode/CRLF/BOM, permissions, malformed proposals, cancellation, unchanged board state, draft custody, explicit AI review/save, native keyboard input, refresh, themes and narrow screens.
