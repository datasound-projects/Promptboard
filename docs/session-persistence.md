# Session persistence

Promptboard stores logical conversation metadata separately from a CLI process run. A session records the provider, captured native conversation ID, agent configuration, worktree and branch, process-run IDs, and artifact directories. Run history retains its original stage, outcome, exact task prompt file, Base manifest, and terminal output.

This foundation does not change the existing stage workflow. Each stage launch still gets a separate conversation; confirming a stage ends that process. Native resume, explicit pause controls, and live conversation continuity across configurable columns are subsequent implementation steps in the [Kanban parity plan](kanban-parity-plan.md).

State version 4 introduces the session registry. Versions 2 and 3 migrate explicitly, with the exact original file retained as `state.pre-migration-v<version>-*.json` in the data directory. Migration preserves task prompt bytes, workspaces, branches, Base definitions and assignments, and unknown fields. Existing stage runs become separate sessions; their captured native IDs are retained rather than combined into an invented conversation. The portable board backup remains version 3 and excludes machine-specific runs and sessions.

On restart, active runs become interrupted and their sessions become orphaned. Concurrent board requests wait for the same recovery write. Recovery never starts agents or repeats automations. Suspended session records and any saved user pause intent remain intact. Older Promptboard versions refuse version 4 data instead of overwriting it.

Run and session acceptance happen in the same atomic Store write. Native IDs and lifecycle updates are persisted together. A failed write leaves both registries unchanged. Session metadata contains references to run artifacts; it does not duplicate the prompt, Base content, or full transcript into board snapshots.

Verification uses disposable state directories, Git repositories, and simulated CLIs. It covers migration and retry after write failure, distinct historical conversations, concurrent startup recovery, lifecycle updates, and atomic acceptance. These tests do not establish authenticated live-provider resume behavior.
