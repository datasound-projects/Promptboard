# Security

Promptboard is a local, single-user app. It starts AI coding agents that can edit files in your repositories, so read this before you use it with sensitive code.

## Reporting a vulnerability

Report problems privately through GitHub: **Security → Report a vulnerability** on this repository. Do not open a public issue, and do not attach credentials, private code, or prompt history.

## What the app does to protect you

**Local only.** The server binds to `127.0.0.1` and checks the Host, Origin, and fetch-site headers. Every API request needs a per-process token, sent in a header and never in a URL. Pages use a strict content security policy with no inline scripts or styles. Do not expose the port through a proxy or tunnel.

**No shell.** CLIs, Git, and your test commands start through `execFile`/`spawn` without a shell. Task text is passed as one argument or pasted into the terminal, never interpolated into a command. The browser cannot choose an executable, a working directory, or CLI flags.

**Agents stay in their worktree.** Each task gets its own Git worktree and branch outside your checkout. Planning and Code Review use each CLI's read-only mode (Claude Code plan mode with read tools only, Codex `--sandbox read-only`, Gemini plan mode plus a deny policy). Executing uses the CLI's normal approval mode. Promptboard never passes bypass, "yolo", or full-access flags, never pre-trusts a folder, and never edits your CLI configuration.

**You confirm the important steps.** Runs start only when you start them or turn on automatic start for a stage. A stage succeeds only when you confirm it. Commits and branch updates need confirmation. Merges need confirmation unless you turn on **Merge automatically** for a project; even then Promptboard merges only when the accepted review and passing tests belong to exactly the current task and target commits. Merges are fast-forward only. The only push is **Open pull request**: after you confirm, the task branch (never another branch) is pushed without `--force` and a pull request is opened with the GitHub CLI; its description is yours, and the task prompt is not sent unless you add it. Testing and Merge agents write only in the task worktree; they are told not to commit, merge, rebase, reset, or push, and Promptboard refuses to commit files that still contain conflict markers. Setting up Git in a new folder (`git init` plus one empty commit) happens only after you confirm it, and never adds your files. Promptboard never force-resets, stashes, or deletes a dirty worktree.

**Processes are owned.** Stopping a run, or Promptboard itself, stops only the process groups it started.

**Credentials stay with the CLI.** Promptboard never reads, copies, or logs CLI credential files, and does not copy them into worktrees.

## Limits

- An agent in Executing can run any command its CLI allows in the task worktree, with your user's permissions. Review what it asks to do.
- Worktrees are created with Git hooks disabled. Commits and merges you confirm run your repository's normal Git hooks, like any commit you make yourself. The agent's own commands and your test commands also run normally.
- These controls do not protect against other software that already runs as your user.
- Prompt boundaries and read-only modes are enforced by each CLI, not by an operating-system sandbox. A CLI bug can weaken them.
- Prompt text, run output, and plans are stored unencrypted in the data folder and sent to your provider through its CLI. **Do not put API keys, tokens, passwords, or private code you cannot share with your provider into prompts or tasks.**

## Changes that need extra review

- CLI flags, permission modes, hook or notify handling, and executable lookup.
- Git worktree, commit, merge, and cleanup code.
- Process start, stop, time limits, and output limits.
- HTTP binding, token and origin checks, static routes, and the content security policy.
- Anything that renders agent output (it must stay text, never HTML).

Do not add automatic approval bypass, shell interpolation, remote binding, force-push, pushing without confirmation, or conflict resolution that skips the marker check and the user's commit.
