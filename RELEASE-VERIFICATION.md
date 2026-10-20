# Release verification

Final verification of Promptboard 0.4.0 before its first open-source release (PB-05), done on 29 September 2026. Code verified at commit `37f5020`.

## Repair pass, 20 October 2026

A whole-app repair pass against 20 written component checklists. They covered:
- server and security;
- storage and migrations;
- the Kanban engine, agent runs, native input, Git and Autopilot, and the Kanban UI;
- Origin, Research and Compose;
- Base, shared projects, the Coordinator and remote access;
- CLIs and Usage;
- the app shell, the command line and release, and tests and CI;
- a cleanup of duplicate code, unused code and docs.

One agent worked on each component in its own worktree. Each finding was confirmed by a failing test, a reproduction or an exact code trace before it was fixed. Each fix has a regression test that fails on the old code. Merged in five waves as #134–#138.

### Readiness criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| Full suite on every wave | PASS | Waves 1 to 4: 1228–1313 non-browser tests and 96–105 browser tests, 0 failures, before each PR. Wave 5: two runs in a row, 1322 non-browser and 105 browser tests each, 0 failures, no test Chrome left running. |
| CI | PASS | Ubuntu, macOS and Windows × Node 22 and 24 on each PR. Two real Windows-only and test-only failures were fixed: a path separator in a Base test and an export race in a JSDOM test. Known macOS flakes were rerun once and are now fixed at their cause. |
| Data survives | PASS | Every older state version v2–v13 migrates once and keeps every field. A v0.4.0 data folder and a pre-pass data folder (Origin, Base, saved prompts, Coordinator, labels, runs) both loaded unchanged on the new code: 12 API views compared by ID. Their backups imported identically. ENOSPC was tested on a real 4 MB disk image. kill -9 during 300 parallel saves lost nothing that had been acknowledged. |
| Live end to end | PASS | On an isolated instance with real CLIs (Claude Code 2.1.304 haiku, Codex 0.160 low; 22 short runs): Origin template → Research suggestion applied → Compose Batch of 3 → approved → exported twice with no duplicates → Full Autopilot took 3 cards through Planning, Executing, Review, Testing and Merge in prerequisite order, with real squash merges and passing tests → Coordinator answer with existing references → Base Agent Profile (SOUL.md reached the agent; the switched-off MCP tool was withheld) → Open in IDE with a fake editor → the page recovered from a restart without a reload → every page at 390 and 1440 px in both themes. |
| Security model holds | PASS | Every route was called from a paired phone and checked against the local-only list (a new test makes every new route classify itself). Agents no longer inherit Claude Code session variables. Local folder paths no longer reach the Coordinator's model. |

### Known limitations

- Codex failures inside its interactive session (bad model, quota, network) send no event, so the run shows as running until you look at the terminal.
- One-shot runs (Compose, Split, file proposals, Research) have no overall timeout; Stop ends them.
- Run and session history is not capped, because approved plans and evidence point at runs.
- Windows agent runs, process trees and quoting are tested by simulation and CI only, not on a real Windows machine. Gemini CLI and Antigravity are not live-verified. Real Tailscale, Twingate and iPhone checks have not been done.
- The Coordinator's project questions see the newest 15 events, so an answer can miss older merges that its index has.
- X10 mouse reports beyond column or row 95 are dropped; Claude Code, Gemini CLI and Codex use SGR reports.
- Look-alike letters from different alphabets (Cyrillic а, Latin a) still count as different project names.
- pnpm and Yarn `.cmd`-only installs on Windows are not detected.

## Quality pass, 13 October 2026

A second whole-app pass aimed at client demonstrations and real deployments. Five reviewers each covered one area: the
Kanban stage engine, the HTTP server and its security model, Origin/Compose/Base/backups, the UI in real headless Chrome
(1440 and 700 px, both themes), and performance on a large synthetic board (20 projects × 200 cards, 2,000 runs,
22 MB state). Each finding was reproduced before it was fixed, and each fix has a test that fails on the old code. A
real Full Autopilot run with signed-in CLIs checked the result end to end. Merged as #105 and #108.

### Readiness criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| Autopilot never waits silently | PASS | Five dead ends fixed: a moved target with no test command (`TARGET_MOVED`, back to the Testing agent), a failed re-test that sent stale review findings, tests left "running" by a restart, a crash between confirming a run and recording its outcome, and a CLI stuck on a startup menu nobody answers (reported after 2 minutes as `PERMISSION_REQUIRED`). Tests in `tests/kanban-stage-engine.test.mjs`. |
| Security model holds | PASS | About 150 routes fuzzed with no 5xx or crash; Host/Origin/fetch-site, token, path, symlink and body-limit checks held. The CLI check (`/api/providers`) needed no token and is now protected; backup IDs are validated; local redaction covers quoted secrets and URL credentials in linear time (a quadratic regex found by CI was fixed before merge). |
| Backups round-trip | PASS | Execution policy and Autopilot route are kept; repeated restores reuse identical Base resources; a backup larger than a restore accepts is refused at export (`BACKUP_TOO_LARGE`). |
| No silent data loss | PASS | A damaged saved-prompts file is kept aside instead of being reset and overwritten. |
| Large boards stay responsive | PASS | Unchanged 2-second board poll: 17 MB → 18 bytes, 115–200 ms → 1–4 ms in the browser. Backups by hard link; activity writes coalesced; run folders of deleted cards and projects removed. |
| Demo-ready UI | PASS | Layout defects fixed (board squeezed by the Coordinator, sideways scrolling, stray scrollbars); offline errors in plain words; Autopilot Start disabled with the blocking reason; card details show the essentials with an Advanced section; consistent wording. |
| Live end-to-end, no test command | PASS | `node scripts/live-kanban.mjs --tasks 2 --plan claude --exec claude --review claude --test claude --claude-model '' --no-test-commands`: both cards To Do → Planning → Executing → Code Review → Testing → squash-merged in queue order in about 6 minutes, zero waits; the Testing agent found `node test.js` itself; the final target passes its tests. |
| Live run with Codex | Blocked by the local machine, reported correctly | Codex 0.160 asked "Hooks need review" for a changed user hook in `~/.codex/hooks.json`. Promptboard does not approve third-party hooks; the run now reports it instead of waiting. |
| CI | PASS | Ubuntu, macOS and Windows × Node 22 and 24 on each merged PR. |

### Known limitations

- Every save still clones, serializes and writes the whole state file (about 85 ms at 22 MB), and the first board load
  and mutation responses carry every card prompt (about 17 MB on that board). Unchanged polls no longer do.
- Without a test command, Testing trusts the Testing agent's report of the commands it ran and their exit codes; the
  report is checked for consistency, not re-executed. Configure a test command when an independent run is required.
- Promptboard answers only the folder-trust menu of Claude Code and Codex, and only when enabled. Other startup menus
  (changed hooks, sign-in, updates) need a person; autonomous columns report them after 2 minutes.
- Claude Code has no workspace sandbox in autonomous mode; Gemini remains not live-verified; Antigravity is unavailable
  for Kanban.
- An execution policy restored from a backup is not re-checked against every column until a card launches.
- Removing run folders of deleted cards also removes their cost from the Usage page's 30-day totals.
- Kanban's New project form and Origin's are still separate flows.
- Local test runs on a heavily loaded machine can time out (seen at load averages of 17–36); CI is the reference.

## Stability audit, 9 October 2026

A whole-app review after the Origin, Project Context, shared projects, pipeline Autopilot and Coordinator work. Seven read-only reviewers covered the board and workflow engine, agent execution, the HTTP server, the Origin/Base/Compose backends, the Kanban/Compose page, the other pages, and dead code and test stability. They reported about 100 findings, most reproduced with scripts or in real Chrome. Every confirmed defect was fixed with a regression test that fails on the old code.

### Readiness criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| No request can stop the server | PASS | `//`, `//a:b` and absolute-form request targets used to crash the process (and every running agent). They now return 400; any handler failure returns 500 (`tests/server.test.mjs`). |
| One error mapping, correct status codes | PASS | Every route uses `failureBody`; provider client errors keep 400/409 instead of a generic 502. |
| No silent data loss | PASS | One durable-write helper (`src/durable.mjs`) for the board, Origin, Project Context, saved prompts, Coordinator and Base. Unreadable files are reported and never replaced by empty data (`tests/durable.test.mjs`). Damaged Origin and Project Context files without a backup stay reported. Unsaved Base, Origin and Project Context edits ask before they are replaced. |
| Agents, Autopilot and tests do not stall | PASS | Terminal auto-replies no longer count as typing (they paused Autopilot and native messages once a terminal opened). Autopilot resume, profile plan routes and blocked automations are fixed. Test runs finish at exit, run once per card and survive log-write errors. |
| One project identity and one name | PASS | Names are unique across Origin, Compose and Kanban (create, rename, concurrent requests); one ID never belongs to two projects (`tests/shared-projects.test.mjs`). |
| Syntax check | PASS | `npm run check`. |
| Full regression (local) | PASS | `npm test` on the final code: 978 non-browser and 68 browser tests, 0 failures (macOS, Node 24). |
| Critical workflows end-to-end in real Chrome | PASS | Compose (generate, history, save to a project), Origin (create, map, Create Context, handoff), Kanban (projects from the sidebar, cards, pipeline moves, terminal dock, Autopilot, Coordinator), Base, shared projects Origin → Compose → Kanban, recovery from damaged files, phone widths and both themes. |
| Live complete flow: Codex CLI | PASS | `scripts/live-flow.mjs --provider codex --effort low`: To Do refused to run → Executing → commit → read-only Code Review (no issues) → tests (exit 0) → merge preview → merged → Done; no agent process left. |
| Live complete flow: Claude Code | PASS with a note | `--provider claude --model haiku` ran every stage correctly. The review asked for changes because the user's global Serena MCP server wrote `.serena/` into the task worktree, so merge was correctly refused. |
| CI | See the run for the pushed commit | Ubuntu, macOS and Windows × Node 22 and 24. |

### Simplified

Removed dead or duplicate code and controls: the duplicate project picker and its New/Rename/Delete copies (the sidebar list is the one place), five always-true capability flags, the unused test-log and Base target routes, the duplicate Compose folder route, test-only planners and APIs, unused CSS, and the unshipped `nerd.png`. Shared helpers replace copies: durable files, DOM helpers (`public/dom.js`), native-message helpers, one abortable helper, one Claude error map. The UI tests are split into three files to stay well under the per-file CI limit.

### Known limitations

- Windows agent runs are still not verified on a real machine. Process-tree stop (`taskkill /T`) and the command-line length limit are fixed in code and covered by mocked tests only. A very large `--agents` definition alone can still exceed the Windows limit.
- Gemini CLI board runs are not verified live.
- MCP servers configured for the user's CLI can write files into task worktrees (for example `.serena/`). They are committed with the task and Code Review flags them. Add such folders to the repository's `.gitignore`.
- In the terminal, Shift/Ctrl+F3 produce the same bytes as a cursor-position report and are treated as one. While a new tab replays history, escape-sequence keys (such as arrows) typed in that moment are ignored.
- A card-save conflict with label changes made elsewhere is reported, not merged automatically.
- Smaller duplication remains where merging would cost more than it saves: SHA-256 one-liners, error classes with the same shape, the Base page's own DOM helpers (different argument order) and its column list (import cycle).

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
- CLIs ask their own startup questions (folder trust, hook review). Promptboard never pre-trusts folders; the user answers in the terminal. (Since this report, an opt-in setting can answer the folder-trust menu for the card's own worktree.)
- The browser console shows CSP reports when a terminal opens: xterm tries to add inline styles before the WebGL renderer takes over. The CSP blocks them by design; rendering is unaffected.
- Without a GPU (for example headless CI), WebGL runs in software and the page can pause briefly while a terminal is created or floods.
- If Promptboard is started from inside a Claude Code session, Claude runs inherit that session's environment marker and show "Transcript saving is off". Start Promptboard from a normal terminal. (Fixed since this report: every CLI Promptboard starts gets an environment without the enclosing session's markers.)

## Owner actions

- Turn on **private vulnerability reporting** (Settings → Code security). `SECURITY.md` and the issue form point to it; it is off today.

## Security concerns

None open. The app trusts software already running as the local user, and prompt text reaches the chosen provider through its CLI; both are documented in `SECURITY.md`.

## Blockers

None.

## Status

READY FOR OPEN-SOURCE RELEASE
