# GitHub

Promptboard connects to GitHub through the official GitHub CLI (`gh`). It never sees, stores or forwards a GitHub
token: `gh` keeps the sign-in in your system keychain and runs every GitHub request itself. Commands run without a
shell, and nothing here force-pushes, resets or deletes a branch.

## Sign in

**Settings → GitHub → Connect GitHub** runs `gh auth login --web`. Promptboard shows only the one-time code; you enter
it at github.com/login/device. The global Git credential setup is declined: each clone Promptboard makes gets a
repository-local credential helper (`gh auth git-credential`) instead.

| Status | Meaning | What to do |
| --- | --- | --- |
| Connected as @you | `gh` is signed in and GitHub answers. | Nothing. |
| Not connected | `gh` is not signed in. | Connect GitHub. |
| Needs attention | The sign-in expired or was revoked, or GitHub cannot be reached. | Check your network, then Connect GitHub again. Local work is not affected. |
| GitHub CLI not installed | `gh` is not on PATH. | Install it from cli.github.com, then Check connection. |

Disconnecting a repository never signs `gh` out. To sign out everywhere, run `gh auth logout` in a terminal.

## Connect a repository to a project

With the project selected on Kanban, open **Settings → GitHub**:

- **Search your repositories.** Lists what the signed-in account can read: your own, collaborations and
  organization repositories, public and private. Pick one and its default branch becomes the target branch.
  - By default it is cloned once into Promptboard's data folder (`clones/<owner>/<name>`).
  - **Clone into a folder of my own** clones it into `<chosen folder>/<name>` instead.
  - A folder that already exists there is used only if it is a clone of that repository; anything else is refused
    and left unchanged.
- **Connect this folder.** When the project already links a local folder whose `origin` is on GitHub (HTTPS or SSH),
  it is connected as it is: nothing is cloned and its Git configuration is not changed. Fetching uses your own Git
  credentials for that remote.

Changing the repository is refused while tasks have worktrees in the current one. **Disconnect…** forgets the GitHub
link; the clone or folder, its worktrees and all local work stay.

## Staying in sync

- **Fetch** fetches `origin` and reports the target branch as up to date, behind, ahead, or diverged.
- **Update <branch>…** fast-forwards the local target branch after you confirm. Anything that is not a fast-forward is
  refused, as are uncommitted changes on that branch.
- Merges still go through Kanban's reviewed, tested Merge step. Nothing is pushed unless you open a pull request.

The Coordinator knows which repository each project uses and its last sync state (names only, never local paths).
Origin's Kanban link shows the repository in its tooltip.
