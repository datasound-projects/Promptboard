# Changes

## Unreleased

- Generation always ends in a clear state: stage and elapsed time, cancel in every stage, a bounded client and server timeout, and input kept on failure.
- Stable error codes that separate exhausted quota, temporary rate limits, sign-in, model, network, policy, and timeouts. Unknown failures stay unknown.
- No repair call after an account-level failure. A busy server returns `409 BUSY`, not `429`.
- Connection panel: install and sign-in status, native Codex sign-in, terminal handoff for other CLIs, refresh models, and confirmed sign-out.
- Clean shutdown on SIGINT, SIGTERM, and SIGHUP. Owned CLI processes and temporary folders are removed, and the port is released.
- Simpler web layout in four numbered steps: describe, choose settings, generate, review and copy. Sign-in controls and brief options move into a labelled **More settings** section.
- Optional dark mode and a collapsible history sidebar. Both are saved in the browser and applied before the first paint.
- History scrolls on its own; the editor stays in place. The top bar reserves a place for a future Kanban page.
- Readable text sizes and contrast in both themes, visible focus, a skip link, a drawer on narrow screens, and reduced-motion support.

## 0.3.0 — 28 September 2026

- Reviewed mode: draft, local checks, a fresh model review, and at most one repair with a new review.
- Fast mode: one model call and local checks only.
- Exact comparisons for recognized code, quoted text, URLs, and file paths. Extended literals do not count as unchanged.
- Validated review JSON with complete source-unit coverage, fixed criteria, and real quoted evidence.
- Visible findings, review failures, and repair failures. Downloadable JSON reports with version, hashes, stages, and timings.
- Terminal output gating for flagged drafts, explicit `--allow-draft`, `--json`, `--quality`, and `--version` options.
- Bounded feedback, calls, output, and time; cancellation and fresh working folders for every stage.
- Development/holdout evaluation cases, an opt-in live evaluation command, and a local benchmark.
- Updated primary source notes and a shorter README with fresh GitHub publishing instructions.
- Persistent warning when browser history cannot be saved.
- Kept the logo, black-and-white interface, model and effort selection, three languages, and prompt history.

This release adds inspectable safeguards. It does not guarantee model correctness, full STE compliance, or better coding outcomes.
