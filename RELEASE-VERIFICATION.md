# Release verification

Final verification of Promptboard 0.4.0 before its first open-source release (PB-05), done on 29 September 2026. Code verified at commit `37f5020`.

## Environment

| Item | Version |
| --- | --- |
| Local OS | macOS 26.6.2 (Darwin 25.6.0), arm64 |
| Node.js / npm | 24.14.1 / 11.11.0 |
| Git | 2.50.1 |
| Chrome (browser tests) | 154.0.8037.58, headless, software WebGL |
| Claude Code | 2.1.284 |
| Codex CLI | 0.156.1 |
| Gemini CLI | 0.30.0 |
| Antigravity CLI | 1.2.12 |
| CI | GitHub Actions: ubuntu-latest, macos-latest, windows-latest × Node.js 22 and 24 |

## Results

| Area | Result | Evidence |
| --- | --- | --- |
| Syntax check | PASS | `npm run check`: all JavaScript files pass. |
| Full regression (local) | PASS | `npm test`: 159 tests, 159 pass, 0 fail, 0 skipped (macOS, Node 24). |
| Full regression (CI) | PASS | Linux and macOS, Node 22 and 24: 159 of 159 pass. Windows, Node 22 and 24: 118 pass, 36 skipped (terminal, Git worktree, and browser tests need a POSIX PTY or shebang fixtures), 0 fail. Run 36531831358 on `37f5020` passed all six jobs three times in a row, including `npm audit` of runtime dependencies. |
| Benchmark | PASS | `npm run bench`: median 23.05 ms, p95 25.95 ms for local prompt construction and checks (24,000 characters, 100 iterations, no model calls). |
| Clean install | PASS | Following the README on `37f5020`: fresh `git clone` from GitHub → `npm install` (44 packages, 2 s) → `npm run check` → `npm test` 159/159 → `--version` prints 0.4.0. An earlier clean clone also started the server: page, pinned xterm assets, and `/dock.js` served; port released after Ctrl+C. |
| Live complete flow: Claude Code | PASS | `scripts/live-flow.mjs --provider claude --model haiku`: To Do refused to run → Executing → commit → read-only Code Review (parsed JSON verdict) → accept → Testing (exit code 0) → confirmed fast-forward Merge → Done. Repeated on `37f5020`: pass. See `docs/live-verification.md`. |
| Live complete flow: Codex CLI | PASS | Same flow with `--provider codex`. Folder-trust and hook-review prompts answered as a user. Repeated on `37f5020`: pass. |
| Live UI flow | PASS | Real Claude session started from a card in headless Chrome, rendered in the dock, trust prompt answered with key presses in xterm, stage confirmed in task details. |
| Live Gemini CLI | NOT RUN | Blocked by the provider account ("This client is no longer supported for Gemini Code Assist for individuals"). Gemini board runs are covered by simulated tests only and labelled "not verified live" in the run dialog. |
| Terminal and session recovery | PASS | Browser reload reconnects to the same runs without starting new ones (browser test). Graceful stop marks runs interrupted (execution test). Hard crash (`SIGKILL` of the server with a live Claude session): the agent ended with its terminal, restart showed the run as interrupted, worktree kept. |
| Isolation | PASS | In every live run the change appeared only in the task worktree; the user checkout stayed clean until the confirmed merge. Review stages left the worktree unchanged. |
| HTTP security probes | PASS | Server listens on 127.0.0.1 only. `/api/board` without the token: 403. Foreign `Host`: 403. Cross-origin POST: 403. `/vendor/../package.json`: 404. Strict CSP header present (`script-src 'self'; style-src 'self'`, no inline). |
| Code security review | PASS | No `shell: true`, `exec`, or `execSync` in `src` or `bin`. No token in any URL. No bypass-permission, yolo, or full-access flags. Git runs through `execFile` with a scrubbed environment and hooks disabled. |
| Secrets and private data | PASS | Tree and full history scanned for API-key, token, and private-key patterns: none. The only home-directory paths are a placeholder (`/Users/you/...`) and deliberately fake test fixtures. |
| Dependencies and licences | PASS | `npm audit --omit=dev`: 0 vulnerabilities. Runtime packages: @xterm/xterm 6.0.0, @xterm/addon-fit 0.11.0, @xterm/addon-webgl 0.19.0, node-pty 1.1.0, node-addon-api 7.1.1, all MIT and pinned. |

## Bugs found and fixed during verification

- **Lost early agent output (product bug).** The PTY output and exit listeners were attached after an `await`, so the first output of a fast CLI could be dropped (seen once on macOS CI). They are now attached immediately after spawn, and an exit during startup no longer leaves a polling timer behind.
- **Flaky CI tests.** The resize check now compares the agent's last reported size with the terminal's current width (layout can refit twice); the flood check tolerates one software-rendering stall but still fails on sustained lag; a process that disappears while `/proc` is read counts as gone. CI no longer cancels other jobs on the first failure, stops a hung test after 3 minutes, and limits each job to 15 minutes.
- **Outdated text.** The CLI banner, page titles, and licence still used the old name; the Kanban intro said agents ran only in Planning and Executing (Code Review also runs one); the Code Review, Testing, and Merge columns still said their runs would "arrive in a later version". The README described an older app and a ZIP download.

## Known limitations

- Board agent runs are verified on macOS (live and CI) and Linux (CI with simulated CLIs). They are not verified on Windows.
- Gemini CLI board runs are not verified live (see above). Antigravity is prompt-only.
- CLIs ask their own startup questions (folder trust, hook review). Promptboard never pre-trusts folders; the user answers in the terminal.
- The browser console shows CSP reports when a terminal opens: xterm tries to add inline styles before the WebGL renderer takes over. The CSP blocks them by design; rendering is unaffected.
- Without a GPU (for example headless CI), WebGL runs in software and the page can pause briefly while a terminal is created or floods.
- If Promptboard is started from inside a Claude Code session, Claude runs inherit that session's environment marker and show "Transcript saving is off". Start Promptboard from a normal terminal.

## Owner actions

- Turn on **private vulnerability reporting** (Settings → Code security). `SECURITY.md` and the issue form point to it; it is off today.

## Security concerns

None open. The app trusts software already running as the local user, and prompt text reaches the chosen provider through its CLI; both are documented in `SECURITY.md`.

## Blockers

None.

## Status

READY FOR OPEN-SOURCE RELEASE
