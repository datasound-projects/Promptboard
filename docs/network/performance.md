# Network performance (Task 14)

Measured numbers, not promises. Every number below was measured on 2026-10-26 on the machine described here, with the
fixtures, tests and script named in each section. Nothing here says how Network behaves on other hardware, other operating
systems, a phone, or with real CLIs (all runs used the deterministic fake job worker or the fake headless CLIs).

## Machine and conditions

| | |
|---|---|
| CPU | Apple M2 (`sysctl -n machdep.cpu.brand_string`), 8 cores: 4 performance + 4 efficiency |
| Memory | 16 GB |
| System | macOS 26.6.2, Node.js v24.14.1 |
| Browser | Headless Chrome 155.0.8059.85 through `tests/helpers/browser.mjs`: 1440 × 1000 window, software GL (`--use-angle=swiftshader`), reduced motion |
| Data | A temporary data folder per run; the app on port 0 (loopback) |

The machine was shared: two other agents ran test suites and their own headless Chromes at the same time. Each run records the
load average (1, 5 and 15 minutes). The tables below come from quieter windows (1-minute load 5–9 on 8 cores). The same
browser steps measured earlier at loads of 15–42 were 5–30 times slower (see "Under load"), so a single number from a busy
machine says little; compare runs at similar load.

## Fixtures

`tests/fixtures/network-perf.mjs` generates everything offline against a running app on a temporary folder:

- **Registrations** written as `network/agents.json` in the registry's own format before the app reads it (round robin over two
  Base agents, Claude and Codex; every 7th tagged, every 5th with a capability).
- **Journal**: full segments written in the journal's own format before the app reads it (`segments` × `segmentBytes`).
- **Graphs** through the owner API: 50 published team networks of 20 agents each, an "Org" network pinning all 50 (drawn
  collapsed: one node per team) plus 50 agents of its own, a 1,000-node / 999-relation draft ("Thousand"), and a 3-agent
  network for the pipeline.
- **Pipeline** through the owner API: 200 steps (199 agent steps in ten chains, one report), published.
- **Jobs**: one job submitted and finished by the app, then copied with new job and attempt IDs and a recomputed request hash.

| Size | Registrations | Teams × agents | Big graph | Pipeline | Jobs | Journal |
|---|---:|---:|---:|---:|---:|---|
| Suite (`SIZES.suite`, in `npm test`) | 1,100 | 50 × 20 | 1,000 nodes | 200 steps | 500 | 15 × 256 KiB segments (16,973 events) |
| Full (`SIZES.full`, opt-in script) | 5,000 (the registry ceiling) | 50 × 20 | 1,000 nodes | 200 steps | 5,000 | 15 × 8 MiB segments (540,496 events, 120 MiB; the ceiling keeps 16) |

## Server (owner API)

Each operation is the median of three calls over loopback HTTP (`measureServer`), in milliseconds. "Start" is
`startServer` on the folder; the first job list includes the start scan of every `job.json`; the first events page includes
the journal load.

| Operation | Suite (`tests/network-perf.test.mjs`) | Full (`scripts/network-perf.mjs`) |
|---|---:|---:|
| Generate the fixture | 4,968 | 11,466 |
| Start the app on the folder | 8 | 4 |
| First job list (start scan of 500 / 5,000 jobs) | 41 | 223 |
| First events page (journal load) | 4 | 35 |
| List agents (first 200 of 1,100 / 5,000) | 4.8 | 14.6 |
| Search agents (`q`) | 5.5 | 16.1 |
| Filter agents by capability | 4.4 | 17.4 |
| List networks | 0.7 | 1.3 |
| Read the 1,000-node draft | 5.3 | 4.9 |
| Read the Org network | 0.9 | 1.5 |
| Read a team's published version | 0.6 | 0.8 |
| Save the 1,000-node draft (every position changed) | 22.5 | 21.3 |
| Publish the 1,000-node draft | 26.4 (one call) | 32.8 (one call) |
| Validate (compile) the 200-step pipeline | 2.5 | 3.0 |
| Read the 200-step pipeline | 0.9 | 0.9 |
| List jobs (first 200) | 2.5 | 4.2 |
| Filter jobs by status and agent | 2.3 | 3.7 |
| Newest 200 events | 0.9 | 1.8 |
| Replay 200 events from the start | 0.8 | 1.1 |
| 200 events filtered by agent (scans up to 50,000 lines) | 19.2 | 89.9 |

Full size, after the measurements: the server process held 109.1 MB of JS heap and 481.7 MB resident (the test process holds
the app; the journal files total 125,825,589 bytes on disk). Load average during the runs: suite 7.3, full 6.9 (1 minute).
An earlier full run on the busy machine took 1,421 ms for the first job list and 203.5 ms for the filtered events page.

## Browser (headless Chrome)

`tests/network-perf-browser.test.mjs` at suite size, PATH holding only `node` (the page's provider and sign-in checks find no
CLI). Steps inside the running page are timed from the action to the second painted frame after the expected state. The cold
open and the reload are timed inside the page from the start of its navigation to the second painted frame after the rows or
the 1,000 nodes exist (a script added to every new document checks on every frame). Heap is `Runtime.getHeapUsage` after a
forced garbage collection. Two runs, at 1-minute load averages 5.7 and 8.8.

| Step | Run 1 (ms) | Run 2 (ms) |
|---|---:|---:|
| Agent directory opened cold (the app starts, then the first 200 of 1,100 rows) | 994 | 3,576 |
| Search typed in the directory → one row (includes the 250 ms debounce) | 661 | 635 |
| Org graph first render, collapsed (100 nodes: 50 teams + 50 agents) | 597 | 339 |
| Expand one team (its version read lazily; +20 nodes) | 184 | 551 |
| Collapse it | 422 | 583 |
| Expand five teams one after another | 136, 130, 274, 377, 450 | 191, 477, 440, 350, 438 |
| 1,000-node draft first render (opened inside the page) | 386 | 317 |
| Arrange it in layers (every position changes) | 530 | 148 |
| Save it | 168 | 316 |
| Reload the page until the 1,000 nodes are painted again (same positions, checked) | 4,134 | 2,856 |

| Heap after GC | MB |
|---|---:|
| Directory open | 3.4 |
| Org collapsed | 4.9 |
| Org with five teams expanded (195 nodes) | 7.1 |
| 1,000-node draft drawn | 15.4–15.8 |
| After the reload | 14.8 |

The slowest API request during each part took 2–22 ms, so the times are drawing. A cold page is much slower than the same
work inside a running page: a separate probe (CPU profile of the page) found the 1,000 nodes in the canvas 359 ms after the
navigation started and the first frame after them at 2,711 ms, with little JavaScript running in between (the largest
Network function, `byId`, 18 ms); the time is the first software-GL paint (SwiftShader). A second reload in the same
browser painted 59 ms after the nodes existed.

Measured by the existing browser tests at a 1-minute load near 8.5 (`PB_NETWORK_PERF_LOG`):

| Test | Numbers |
|---|---|
| `network-graph-browser` "Graph stress fixture …" (1,000 drawn nodes, lazy 500-node expansion) | first render 1,001 ms; pan/zoom steps 24, 1,026, 209, 250, 169 ms; choose a node 37 ms; Fit 150 ms; expand a 500-node version 630 ms; heap 3.4 → 14.9 MB (+11.5 MB) |
| `network-pipeline-browser` "Pipeline performance …" (200 steps) | first render 931 ms; choose a step 145 ms; edit a label 180 ms; arrange 143 ms; save and validate 50 ms; heap +3.9 MB |

### Under load

Earlier runs of the same browser test on the busy machine (1-minute load 15–42, other suites and Chromes running; the
directory then timed from the Library inside the page, the reload from outside it): directory 90–11,227 ms, Org first render
1,234–5,788 ms, expand one team 2,233–7,032 ms, collapse 2,553–17,944 ms, single expansions up to 21,196 ms, the 1,000-node
first render 2,272–13,220 ms, reload 6,130–14,346 ms, with every request still under 110 ms once the fake `claude` was off
PATH (with it on PATH, the app's sign-in check waited about 12 s on the fake, which reads stdin). The suite therefore fails
only past 60 s a step (browser) or 10 s an operation (server; 30 s for the start).

## Concurrent workers stay capped

| Test | Setup | Result |
|---|---|---|
| `network-perf` "server at size …" | 40 jobs, `maxConcurrentJobs: 2`, deterministic fake worker driven step by step | at most 2 attempts at once at every step; 2 reached; 40 started, 40 completed |
| `network-perf` "the job ceiling holds with real processes …" | 12 jobs on the real local worker, the fake Claude CLI (`[[slow:300]]`), default ceiling 2 | at most 2 CLI processes between start and end at any moment (from each fake's start and end times); 2 reached; 12 completed in 2,843 ms |

Ceilings 1, 2 and 4 are covered by `network-jobs` "the pool keeps to maxConcurrentJobs (1, 2, 4) …" (acceptance Task 06
item 11).

## Reproduce

```sh
node --test tests/network-perf.test.mjs                 # suite size, server; PB_NETWORK_PERF_LOG=<file> writes JSON
node --test tests/network-perf-browser.test.mjs         # suite size, Chrome; PB_NETWORK_PERF_LOG=<file> writes JSON
node scripts/network-perf.mjs --json <file>             # full size, server; opt-in, never in npm test (about 15 s here)
```

Logs of the runs above: `$TMPDIR/network-logs/task-14a-perf-*.{log,json}`.

## Not measured

Phones and tablets (the phone layout shows lists, not a canvas), Windows and Linux, hardware GPU rendering, real CLIs (their
own start-up and model time dominate a job), many browser tabs at once, more than one paired device streaming, and anything
over a real network. The 1,000-node view limit (Task 05) and the 2,000-step expanded pipeline limit (Task 09) were not raised.
