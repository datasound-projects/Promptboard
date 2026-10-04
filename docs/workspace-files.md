# Workspace file inspection

In Kanban, expand **Files** below any linked project in the Workspace sidebar. Folders load only when expanded. The tree includes actual on-disk files, including untracked/ignored files. Select **Project checkout** or an existing task worktree when available: agents usually edit their task worktrees, so their changes need not appear in the project checkout before merge.

Click a file to open a centered, read-only viewer. The heading identifies the project, checkout/task branch and relative path. Code has line numbers and small dependency-free lexical highlighting for common languages; unknown formats use plain text. Multiple files share viewer tabs. Minimize a file with **−**, restore it from the compact tray (or its tab while another viewer is open), and close it with **×** or Escape. Up to eight file viewers can remain open. Nothing is saved to browser storage.

While Kanban is visible, expanded folders and the active viewer refresh every three seconds. Minimized files reread when restored. Content hashes detect edits even when the file size stays the same. Refresh preserves expansion, selection and viewer scroll; a failed refresh labels any retained content as the last read version. New and deleted entries appear in expanded folders. No background scans happen for collapsed trees or other application pages.

**Updated since opening** reports an observed content change, not its author. Current agent activity snapshots report tool counts/turn state but do not provide reliable per-file editing paths. This feature therefore does not label a file as actively edited by an agent. No terminal text, timestamps or generic running status is used to fabricate that attribution.

## Read boundaries

- Existing local session-token, origin and host protections apply to both GET routes: `/api/projects/:id/files` and `/api/projects/:id/file`.
- Root directories come only from saved, linked projects. Task paths must belong to a recorded, registered Git worktree with the recorded branch/common repository. Inspection never creates, repairs or switches a worktree.
- Absolute paths, traversal, malformed path components, symbolic links, Git internals, common credential/private-key files and special files are refused. Example `.env.example`/`.env.sample`/`.env.template` files remain readable.
- Regular UTF-8 text is limited to 512 KiB and 20,000 lines. Binary/non-UTF-8 and oversized files receive a clear editor-fallback message. Reads use bounded buffers and check identity/timestamps to detect replacement or concurrent writes.
- Directory listings return 250 entries per page, capped at 5,000 entries with an explicit subset notice. **Show more** reveals additional pages. Folder nesting is bounded to 64 path components; at most 64 folders per project can remain expanded.
- Source strings are rendered as text nodes. HTML, scripts and code are never executed. No content goes to a model or an external service through inspection.
- All file APIs use read-only filesystem operations and board-store reads. They do not write project contents or board state, execute agents, stage/commit files, or merge changes.

The module is independent of Compose, Base and agent lifecycle logic. Backend tests cover path custody, links, secrets, malformed/binary/large files, pagination, Unicode, registered worktrees, auth and unchanged board/source contents. UI and real-Chrome tests cover nested expansion, independent viewers, refresh, keyboard use, themes and narrow screens.
