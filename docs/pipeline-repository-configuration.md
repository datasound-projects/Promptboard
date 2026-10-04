# Reviewed repository board configuration

Opt-in column pipelines can read `promptboard.json` and `promptboard.local.json` from their linked repository root. In Column Manager, choose Review repository configuration, inspect the column/profile summary and effective JSON, then Apply reviewed configuration. Closing or rejecting the review preserves unsaved Column Manager edits. Applying replaces saved definitions and closes that draft; it starts no agents, MCP connections, scripts, webhooks or notifications. Enabled actions remain definitions for subsequent authorized moves.

File application is explicit and read-only on disk. After a source has been applied, the visible selected Kanban board checks its files for changes and offers a fresh review. It does not write either file, change `.gitignore`, auto-export UI edits, apply on project open, or silently reload personal changes. Those sync operations are subsequent steps. An occupied canonical removal is shown as a conflict and cannot apply; retained ghost columns are also subsequent work. Messages and advanced session strategies retain their existing runtime availability guards.

Both files use version 1 and a columns array. Column entries use the existing pipeline fields `id`, `name`, `role`, `color`, `description`, `strategy` and `automations`. Strategy values remain sparse: an absent value inherits the saved/team value, null clears it to the strategy default, and an explicit value overrides it. Personal strategy fields merge with team fields. A personal `automations` object replaces both groups as a unit; an omitted group becomes empty, never merged by row. Profiles are allowed only in the team file. Unknown fields, invalid references and malformed rows reject the complete review without changing the saved board.

```json
{
  "version": 1,
  "columns": [
    { "name": "To Do", "role": "todo" },
    {
      "name": "Planning",
      "strategy": { "permissionMode": "plan", "planExitTarget": "Executing" }
    },
    { "name": "Executing", "strategy": { "autoSpawn": true } },
    { "name": "Done", "role": "done" }
  ],
  "profiles": [
    { "name": "Economy", "columns": { "Executing": { "modelOverride": null, "effortOverride": "low" } } }
  ]
}
```

Profile column keys and `planExitTarget` use column names, ignoring case; renaming a column in the file requires updating those names too. Stable `planExitTargetId` is also accepted, but a strategy cannot supply both spellings. New names receive deterministic stable IDs, so reviewing and applying an unchanged file resolve the same identity. Existing IDs survive rename and reorder. Hand-written columns without IDs are additive and retain existing columns; a team array with IDs on every entry is canonical and reconciles its order/removals. Missing To Do and Done roles retain the saved system columns, placed first/last. System IDs cannot be replaced through file application.

A personal file can override a named column or add a personal column. It cannot rename an existing shared identity or define profiles. For example:

```json
{
  "version": 1,
  "columns": [
    { "name": "Executing", "color": "green", "strategy": { "modelOverride": "my-model" } }
  ]
}
```

After file application, Promptboard retains the team definition separately from the effective personal overlay. Explicitly reviewing again after removing a personal value/file restores the shared value. A normal Column Manager save becomes the new saved fallback and ends that remembered file baseline; no shared file is exported. Portable board backups retain the effective board normally and exclude file custody metadata. Personal files should be excluded from Git by their author until automatic ignore management is implemented.

Reads accept only the two fixed root filenames, regular single-link files up to 4 MiB each, and fatal UTF-8 JSON. Symlinks, hardlinks, special files, changing descriptor/path identity and replaced roots are rejected. Review records an opaque source revision over both files and root identity. Apply requires confirmation, the exact project revision and the reviewed source revision; it rereads the sources inside the serialized definition update. File/project changes require a fresh explicit review. Existing active/queued agent, automation ownership, occupied-column, profile-choice, Base and native tuple guards still apply. Tasks and prompt bytes are not rewritten, moved or replayed.

An explicit fresh review rechecks the already linked checkout root and common Git directory with one read-only `git rev-parse` invocation and canonical filesystem paths. It does not repeat initial-link branch, HEAD or current-branch discovery. New links still receive full repository validation. The fixed request deadline and file/source guards are unchanged. See [Git's path/checkout identity options](https://git-scm.com/docs/git-rev-parse).

The HTTP endpoints are authenticated `GET /api/projects/:id/repository-pipeline` for review and `POST` to the same endpoint for apply with `sourceRevision`, `expectedProjectRevision` and `confirm: true`. They use existing Host, Origin and page-token protections. No client-provided path, CLI command or execution grant is accepted.

## Detecting external changes

Once a configuration is explicitly applied, the selected visible Kanban board polls its two fixed source files at most once every two seconds. An edit or atomic replacement, creation/removal of personal overrides, or deleted source produces a review banner without changing the saved pipeline, task text, Base, queue, session, automation state or files. Reading configuration does not probe a CLI or Git executable. An unreadable file or invalid definition shows a fixed warning and preserves saved settings. Restoring identical valid source bytes clears the warning; explicitly applying a fresh review establishes the new baseline. The monitor persists across normal app restart because its accepted source revision is saved; recovery does not launch any work.

The review button opens Column Manager and the existing fresh read/review flow. Background checks preserve keyboard focus and an open editor's exact unsaved draft. Closing a review keeps that draft; applying replaces it only after the existing confirmation and source/project revision guards. An older response cannot update a different project, newer source baseline or changed project revision. Checks begin only for previously accepted repository sources, only for the selected project, and stop starting requests when the document is hidden or another app page is shown. A normal Column Manager save ends that remembered file baseline and monitoring until another source is explicitly applied. Portable backup import does not establish machine-specific file monitoring.

Authenticated `GET /api/projects/:id/repository-pipeline-status` returns monitoring availability, the applied/checked opaque source revisions, current project revision, source presence, change status and a fixed error code. It returns no definition, file bytes, prompts, executable content or caller-selected path. `changed: null` means the sources could not be read consistently, rather than claiming that they are unchanged. Missing/invalid sources require repair and a fresh review; polling never applies or removes columns. This implements reviewed change detection with bounded polling, rather than project-open reconciliation, silent personal reload or automatic export.

Offline checks cover shared/personal merging, whole-group replacement, deterministic identities, name references, strict invalid input, bounded filesystem custody, exact prompt/Base preservation, stale reviews, occupied removals and owned automation/queue guards. Browser checks cover literal rendering, preserved drafts, keyboard controls, both themes and narrow layouts. This is a staged implementation of [Kangentic's repository configuration behavior](https://www.kangentic.com/guide/board-config/), not completed synchronization or signed-in CLI verification.
