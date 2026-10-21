# Docker sandbox for card agents

A project can run its card agents inside a Docker container. The container sees the card's own worktree and almost
nothing else, so an agent with high autonomy (Autonomous, Full access, Hands-off) cannot change other projects, your
home folder or system files. It is **off by default** and works with **Claude Code and Codex** on macOS and Linux.

## Turn it on

1. **Settings → Docker sandbox.** The section says what is still missing:
   - Docker is installed and running (Docker Desktop, or [Colima](https://github.com/abiosoft/colima): `colima start`);
   - the image is built: **Build image** builds it with the Claude Code and Codex versions installed on this computer,
     with live progress and **Cancel**;
   - the sign-in each CLI needs inside the container (below).
2. **Columns → How agents work → Advanced → Run agents in Docker → Yes.** Saving starts nothing. Every agent of the
   project then runs in Docker; the card shows **In Docker** while its agent runs, and the agent line in the card and in
   Details ends with "In Docker".

The setting belongs to the project and travels with a board backup. Hands-off keeps it. There is no per-card switch.
A conversation stays where it started, because its history is kept there: **Resume** continues it in the same place,
and after you change the setting, a card moving to its next column starts a fresh conversation in the new place.

## What runs where

The agent's terminal runs the `docker` client instead of the CLI:

```
docker run --rm -it --init --name pb-run-<run> --label promptboard.run=<run> --label promptboard.data=<data folder hash>
  --user <your uid>:<gid> -w <worktree> -v … -e NAME … <image> claude|codex <the same arguments as on this computer>
```

Every path inside the container is the path on this computer, so workspace trust, the lifecycle hooks, the status
line, usage files, native message input and resume work unchanged. The hooks run with the image's own `node` and read
Promptboard's code from a read-only mount.

| Mounted | Access | Why |
| --- | --- | --- |
| The card's worktree | read-write (read-only in Planning and Code Review) | The work itself. |
| The worktree's `.git` pointer file | read-only | So the worktree cannot be pointed at other Git data. |
| The repository's `.git` folder | read-only | Git reads history, branches and settings. |
| `.git/objects` and this worktree's own Git folder | read-write (read-only in Planning and Code Review) | `git status`, `git diff` and `git add` work; branches, hooks and Git settings stay read-only. |
| The run folder (`<data>/runs/<run>`) | read-write | Lifecycle events, prompt files, the status line, and the CLI's home for this conversation. |
| A resumed conversation's CLI home (`<data>/runs/<first run>/sandbox-home`) | read-write | Resume finds the conversation's own history. |
| Promptboard's own folder | read-only | The hook and status-line scripts. |
| `~/.codex/auth.json` (Codex only) | read-only | Codex's sign-in, never copied. |

Nothing else of this computer is mounted: not your home folder, other projects, other runs, the board's `state.json`,
SSH keys or other CLI settings. Environment values (the terminal type, Claude Code's effort, the Claude Code token) are
passed by name (`-e NAME`), so they never appear in the command line or `ps`; only the container's own folders are
written out (`HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`).

## Sign-in

- **Codex** uses this computer's Codex sign-in: `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`) is mounted read-only
  into the container's Codex home. Codex refreshes its sign-in every few days; inside Docker it cannot save a refreshed
  one. If Codex says it is signed out, run `codex` once in your terminal, then start the card again.
- **Claude Code** keeps its sign-in in the macOS Keychain, which a Linux container cannot read. Run `claude setup-token`
  in your terminal and paste the token once in Settings → Docker sandbox. Promptboard keeps it in the data folder
  (`sandbox/claude-token`, readable only by you) and passes it as `CLAUDE_CODE_OAUTH_TOKEN`. It is never in `state.json`,
  a backup, a log or an API reply: Settings only shows whether a token is saved, and **Remove Claude Code token**
  deletes the file. Setting or removing it works only at the computer, not from a paired phone.

Each conversation has its own CLI home under its first run's folder: Codex sessions and Claude Code transcripts are
written there, not to `~/.codex` or `~/.claude`. Promptboard reads the card's usage from there. A fresh Claude Code home
is marked as set up, so first-run questions are skipped; the folder-trust question still appears (and is answered for
you only with the Workspace trust setting). A fresh Codex home does not offer CLI updates: the image is rebuilt instead.

## Permission modes inside Docker

Claude Code's permission modes are unchanged. Codex's own sandbox cannot start inside a container: it needs bubblewrap,
which needs Linux user namespaces that Docker's default security profile blocks (checked live with Codex 0.160; its
older Landlock-only mode refuses to run without bubblewrap). Promptboard never weakens the container to make room for
it. Instead, inside Docker the container is the boundary:

| Column | On this computer | In Docker |
| --- | --- | --- |
| Planning, Code Review (read-only) | Codex `--sandbox read-only` | Codex `--sandbox danger-full-access`; the worktree and its Git data are mounted read-only |
| Writing stages | Codex `--sandbox workspace-write` | Codex `--sandbox danger-full-access`; only the mounts above are writable |
| Full access | Codex `--sandbox danger-full-access` | the same, inside the container |

The approval setting (`--ask-for-approval`) is unchanged, but inside Docker Codex has nothing to escalate, so it runs
commands in the container without asking. No `--dangerously-*` flag is ever used. Claude Code's read-only stages also
get the read-only mounts.

## Checks before every run

A run in Docker starts only when every check passes; otherwise it ends through the normal failed-start path (the card
returns to its previous column with the reason). Promptboard never falls back to running the agent on this computer.

| Code | Message |
| --- | --- |
| `SANDBOX_DOCKER_MISSING` | Docker is not installed: there is no docker command on PATH. |
| `SANDBOX_DOCKER_STOPPED` | Docker is installed but not running. |
| `SANDBOX_IMAGE_MISSING` | The image for this computer's CLI versions is not built yet (also after a CLI update). |
| `SANDBOX_SIGNIN_MISSING` | Codex is not signed in on this computer, or Claude Code has no token for Docker. |
| `SANDBOX_MOUNT_HIDDEN` | Docker cannot see this folder (path). Share it with your Docker machine. |
| `SANDBOX_START_FAILED` | Docker could not start a container for this card. |
| `SANDBOX_PATH_UNSUPPORTED` | A folder path contains a colon, which Docker cannot share. |
| `SANDBOX_PROVIDER_UNSUPPORTED` | Docker mode supports Claude Code and Codex (Gemini and Antigravity are refused when you save the setting and when a run starts). |

A Docker machine that does not share a folder mounts it as an empty folder without an error, so the first run of each
worktree starts a tiny container that checks the worktree, the repository's Git data, the run folder, Promptboard's
code and Codex's sign-in are really visible. **Colima shares only your home folder by default**: keep the Promptboard
data folder and your repositories under it, or add them to Colima's mounts.

## The image

`docker/sandbox/Dockerfile`: `node:22-bookworm-slim` with Git, CA certificates, and the Claude Code and Codex npm
packages pinned (through build arguments) to the versions installed on this computer, with the npm cache removed. A CLI
that is not installed here is left out. The tag is `promptboard-sandbox:<hash of the Dockerfile and the versions>`, so a
CLI update asks for a new build, which keeps the container's CLI in step with the one on this computer. After a
successful build, Promptboard's older `promptboard-sandbox` images are removed (an image a container still uses is
kept). The image is about 1.5 GB.

Under **More** you can name an image of your own (for example one with Python or Go for your tests). It needs Node.js,
Git, `sh` and the CLIs you use on its PATH; Promptboard then does not build or remove anything.

## Stop and cleanup

The terminal holds only the docker client, so Stop, Pause, a confirmed stage and a failed start also run
`docker rm -f pb-run-<run>`. At shutdown, and at the next start after a crash, Promptboard removes every container
labelled with its data folder's hash. A data folder that never used Docker mode makes no docker call at all.

## What Docker mode does not isolate

- **The network stays on**: the CLIs need their APIs. An agent can reach the internet and your local network.
- **The worktree is writable**, and its files later run on this computer: test commands, package scripts, and code you
  merge. Review the work before you run it.
- **Git data is partly writable**: `.git/objects` and the worktree's own Git folder. Branches, Git settings and hooks
  are read-only, but an agent can still create nested repositories or Git attributes inside the worktree.
- **The sign-in is inside the container**: the agent can read the Codex sign-in file or the Claude Code token it runs
  with, like any process the CLI starts.
- **Promptboard's own code is readable** (not writable).
- Base MCP servers that start a program on this computer, or need a secret from this computer's environment, do not
  work inside the container.
- The Usage panel's 30-day summary scans `~/.claude` and `~/.codex`, so it leaves out sessions that ran in Docker; each
  card's own usage is still recorded.
- Docker itself (and Colima's virtual machine) is part of what you trust.

## Verified live

On 2026-10-21, on macOS with Colima (Docker 29.5, Ubuntu arm64 virtual machine) and Codex 0.160 at low effort:

- A data folder under `/private/var/folders` (not shared by Colima) failed the start with `SANDBOX_MOUNT_HIDDEN`
  naming the worktree; the card went back to To Do and no CLI ran.
- **Build image** in the app built `promptboard-sandbox:<hash>` in 50 seconds with Claude Code 2.1.304 and Codex
  0.160.0 inside.
- A Codex card in Executing (autonomous, Workspace trust on) ran in Promptboard's image and in a smaller image of
  my own: the folder-trust question was answered, the agent wrote `sandbox-proof.txt` in its worktree (visible on this
  computer), `cat ~/pb-sandbox-canary-….txt` failed inside with "No such file or directory", the card's usage was read
  from the conversation's own Codex home, Stop removed the container, and shutdown left none.
- Codex's own sandbox in a container failed with bubblewrap's "No permissions to create a new namespace".

Not verified live: Claude Code in Docker (it needs a `claude setup-token` token), Linux hosts and Docker Desktop.
