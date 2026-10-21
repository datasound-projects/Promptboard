# Live preview

For web projects, Promptboard starts a card's development server in the card's own worktree and gives you a link. You can click-test the change in your browser before it merges.

## Use it

1. Open the **Details** of a card that has a worktree (a card gets one when it first runs). They have a **Preview** section.
2. The first time, the section says **Set a preview command** and offers what the card's files suggest, in one click: for example **Use npm run dev**. Your own command goes under **More**.
3. Choose **Start preview**. The section shows **Installing dependencies…** (only when needed), then **Starting… waiting for the address**, then **Open preview**, **Stop**, the address, and the last 40 lines of the server's output under **Output**.
4. **Open preview** opens the address in a new tab. Promptboard never embeds it in its own page.

While a preview runs, its board card shows a small preview button: it opens the preview, or the card's Details while the preview is still starting.

## The preview setting

The setting belongs to the project, so every card uses the same command. It is kept in board backups. An imported command never runs until you confirm the imported settings, like test commands.

- **Preview command**: for example `npm run dev`. It runs as typed, without a shell (quotes group words; `$VAR`, `&&` and pipes are not special), and its program must be installed on this computer. Promptboard suggests the start command it finds in the card's files: `npm run dev` for a `dev` script, `npm start`, `node <main>`, `python3 manage.py runserver` and so on. A Docker Compose file is never suggested.
- **Install first, when node_modules is missing**: setup commands, one per line, at most five. They run before the preview command only when the card's folder has no `node_modules` folder. A fresh worktree never has one, so a new card installs once and later starts are quick. For a Node project the suggestion is `npm ci` when there is a `package-lock.json`, otherwise the project's own `npm install` (or `pnpm install`, `yarn install`, `bun install`). A setup command may run for up to 10 minutes.
- Promptboard refuses to install into a folder whose `.gitignore` does not cover `node_modules`: every dependency would otherwise show up as the card's changes.
- An empty command and **Save** removes the setting.

## How it runs

- In the card's worktree, on this computer, with your user's permissions, like test commands. Never in Docker or a sandbox.
- With `PORT` set to a free port (Promptboard asks the system for one on `127.0.0.1`), `HOST=127.0.0.1` and `BROWSER=none`, so the server does not open a browser window itself. On Windows, `npm` and `npx` start through Node's own npm, as test commands do.
- In its own process group, with its output kept: the last 20 KB for the page, and up to 5 MB in `<data folder>/previews/<card id>.log` (replaced at each start).
- The address is the first `http://localhost:N`, `127.0.0.1:N` or `[::1]:N` the server prints (colour codes are ignored; a debugger's `ws://` address is not one). A server that prints none is looked for at `http://127.0.0.1:<PORT>/`. Vite and others that choose their own port are found from what they print.
- The preview is ready when that address answers HTTP with any status, within 2 minutes.

When something goes wrong, the section says so in one line and the output stays under **Output**:

- **The preview stopped:** and the last line of the output that names an error (or its last line), when the server exits.
- **No address appeared within 2 minutes.** (or the printed address did not answer in time). The server is stopped.
- **Install failed:** and the reason, when a setup command fails or times out.

## When it stops

- One preview runs per card, and at most three at once. A fourth is refused with **Stop another preview first** and the running ones, each with its own **Stop**.
- A preview stops when you choose **Stop**; when the card's worktree goes (a merge, **Remove worktree**, **Start over**, deleting the card, also when its files are kept, or **Restore worktree**); and when Promptboard stops. It stops before Git removes the folder, so the server never holds the folder open.
- Nothing is saved about a running preview: none survives a restart of Promptboard, and none is started again. Promptboard tracks every process it starts and stops the whole process group, as it does for test commands.

## On a phone

The link is `127.0.0.1`, which only the computer itself can open. On a paired phone the section says **Open the preview on the computer**, and starting and stopping a preview are refused there (they are local-only routes).

## Limits

- The page reads a preview's status every second only while it is starting. A server that crashes later shows as stopped the next time you open the card or the board changes.
- The command runs at the root of the card's worktree, as test commands do. For a project in a subfolder, use a command such as `npm --prefix web run dev`.
- Files the server writes that Git does not ignore show up as the card's changes, and a worktree with changes is not removed.
- A server that ignores `HOST` may listen on your network as well, as when you start it yourself.

## Routes

All go through the app's usual checks (local host and origin, and the session token).

| Route | What it does | Phone |
|---|---|---|
| `GET /api/tasks/:id/preview` | The card's preview, the project's setting, the suggestion and the running previews | allowed |
| `POST /api/tasks/:id/preview` `{ confirm: true }` | Start the card's preview | local only |
| `DELETE /api/tasks/:id/preview` | Stop it | local only |
| `PATCH /api/projects/:id/preview` `{ command, setup, expectedRevision }` | Check and save the setting | allowed |

The board's own answer lists the running previews as `previews` (card, status and address).
