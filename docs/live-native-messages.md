# Private native-message smoke check

Run `node scripts/live-native-messages.mjs --provider codex --model MODEL --effort low --timeout 120` explicitly to use an installed, signed-in CLI. The check consumes model quota. Select a model available to your account; the override applies to this disposable board only.

The script creates its own repository and data directory, saves one fixed task in To Do, starts Executing and waits for a completed native turn. It moves to Code Review through the common lifecycle and checks the continued run ID. A private journal intent then sends one small literal deferred message and records native confirmation separately from the submission marker and durable journal receipt. This is an internal transport check; configured column-message rows remain disabled.

The JSON report contains readiness, observed native identity as a boolean, continued-run identity as a boolean, message/receipt status, exact saved prompt, clean main/worktree checks and owned-process shutdown. A confirmed receipt proves input, not completion of the second reply. A blocked startup or unconfirmed message is a reported result, not a passing check just because the script exits normally. No raw terminal output or conversation IDs appear in the report.

`--answer-trust` answers only the fixed disposable-folder and existing-hook-review startup questions. It never approves a tool call or clears manual-input observations. `--fresh-trusted` optionally stops/resets the warmup through To Do and starts a separate conversation in the same already trusted worktree when the completed warmup observed startup input. The new process must establish its own readiness. The warmup receives no private message, and no unknown write is retried. The whole check shares the selected 1–180 second budget; private message delivery is capped at ten seconds.

`--keep` retains the owned fixture and reports its paths for local diagnosis. Otherwise cleanup removes both temporary directories after shutting down the private dispatcher and Supervisor. No user repository, CLI credential file or global settings file is edited. Kanban permission modes, ambient CLI tools and Base behavior are unchanged.

The offline test installs a simulated Claude-compatible executable in its own temporary PATH, runs this exact script through an actual owned PTY, checks exact delivery and cleanup, and uses no model or credentials. Invalid provider, timeout, model and effort options are rejected before filesystem setup or CLI launch.

Record real results in [the live verification log](live-verification.md), separately from these offline tests. Pending scope includes first-startup readiness without manual-input ambiguity, native resume, immediate/slash delivery and actual configured column scheduling.
