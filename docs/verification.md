# Verification of version 0.3.0

Source review date: 28 September 2026. This is a source release, not a certification or a measured claim of superior prompt quality.

## What happens on each request

1. Validate the input, settings, model ID, and effort selection. Preserve the source text.
2. Build the versioned rewrite brief. It separates instructions from source data and includes small preservation examples.
3. Ask the selected CLI to produce a draft in a new temporary working folder.
4. Compare recognizable source literals with the draft. Check output bounds and run advisory English prose checks.
5. In **Reviewed** mode, ask the same selected model to review the draft in a fresh CLI call and a new folder. The source is divided into at most 64 coverage units. Every nonblank source line occurs in a unit.
6. Validate the review JSON in JavaScript. Require every unit, seven review criteria, valid statuses, and evidence actually present in the supplied text. Missing, malformed, or failed reviews never count as a pass.
7. If concrete local or review findings exist, attempt one repair. Repeat local checks and model review on the new draft. Never reuse the old review for a changed draft.
8. Return the draft and its report. Keep unresolved findings visible. A failed repair retains the previous draft. A failed initial generation returns an error.

Reviewed mode uses two calls normally and at most four. An unavailable review alone does not trigger a blind retry. Fast mode uses one call and skips model review and repair. The pipeline has a six-minute total deadline and a three-minute maximum per CLI call. Cancellation applies across stages. Model discovery happens before this pipeline and has its own timeout.

The requested provider, model, and effort are retained across calls. CLI defaults can route to different models; reported model IDs are listed per stage when the CLI supplies them. A fresh call is not an independent evaluator: the same model can repeat its errors, and global CLI configuration still applies.

## What the checks can establish

- Recognizable fenced code, inline code, double-quoted text, URLs, and file paths are extracted and compared. For explicitly delimited source text, a complete quoted or code span with identical contents must remain; an extended command does not count. Internal whitespace is preserved, except CRLF is normalized to LF. Fence delimiter lines are excluded. Bare paths and URLs use token-boundary checks.
- Extraction is deliberately limited. Bare identifiers, numbers, commands without delimiters, paths with spaces, and other natural-language constraints are not exhaustively recognized. Put critical exact text in backticks or double quotes.
- A literal's presence does not prove its meaning is preserved. For example, copying a number while reversing a condition can pass a string check.
- Prose checks estimate sentence length, paragraph length, contractions, and vague wording. They do not implement all STE word-counting rules, grammar, dictionary senses, or technical-term approval.
- The model assesses meaning, constraints, unsupported additions, conflicts, language, scope, and clarity. It supplies coverage evidence and can report uncertainty. Schema validation proves only that the report has the expected form and real excerpts; it cannot prove the judgments.
- German and Polish retain exact-text checks and model review, but skip English prose rules.

`checks-passed` means the applicable implemented checks found no remaining issue. It does not mean semantic correctness or STE compliance. In Fast mode it includes no model assessment. Both modes set `reviewRequired: true`; no quality percentage is fabricated.

The browser shows flagged drafts for inspection. Plain terminal output withholds flagged drafts and exits with code 2. `--json` returns the draft and report; `--allow-draft` explicitly permits draft text. Both retain exit code 2 when flagged.

## Audit and privacy

The report includes the engine version, stage count, requested and reported models, findings, quoted evidence, repair status, timings, and SHA-256 hashes of input, output, and rewrite instructions. Hashes identify content; they are not signatures or proof of correctness. History and exported reports can contain source text and should be treated like the original request.

## Tests and measurements

All **87 offline tests passed** on Linux with Node.js 24.19.0 for this release. Syntax checks passed.

Run `npm ci`, `npm run check`, and `npm test` for the offline software checks. They cover validation, literal loss, review schema and evidence, bounded repair, invalid reviews, cancellation, cleanup, CLI output gating, process limits, HTTP boundaries, model discovery, and UI controls/history/report rendering. Fake CLI executables and synthetic model replies test the software without calling a paid model.

Run `npm run bench` for a local microbenchmark. On the release environment (Linux, Node.js 24.19.0), a 24,000-character synthetic request took **12.94 ms median / 17.00 ms p95** for prompt construction, literal comparison, and prose lint after warm-up (100 measured iterations). This is one machine and repeated synthetic text, not model latency or an end-to-end speed guarantee. Node.js is JavaScript, not Java; these measurements do not justify a Rust rewrite.

See [the evaluation corpus](../evals/README.md) for development and held-out cases. Live evaluations are explicit opt-in and consume CLI usage. Their reports require human calibration; mechanical pass rates and model judgments are not accuracy benchmarks by themselves.

### Not verified in this environment

- Authenticated live calls to Codex, Claude Code, Antigravity, or Gemini. No signed-in CLI was available.
- End-to-end prompt quality, full STE compliance, token savings, or improved coding results.
- Real desktop/mobile rendering, clipboard, and browser downloads. UI logic is tested in jsdom with controlled fixtures.
- Native macOS/Windows execution or the included GitHub Actions matrix (Node.js 22 and 24).

Before making public quality claims, run live evaluations on the intended models, review the held-out results manually, and record failures as well as successes. Complete the release checks in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Prompting sources

The review/repair sequence is this project's engineering design, informed by these primary sources. No provider certifies this implementation.

- [OpenAI prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering): clear instructions, separated context, versioned builders, and representative evaluation fixtures.
- [OpenAI evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices): task-specific tests, edge/adversarial cases, concrete judgments, and human calibration.
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs): structured results can still contain errors. This app validates ordinary CLI response text locally; it does not claim provider-enforced Structured Outputs.
- [Anthropic prompting guidance](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices): explicit constraints, relevant examples, and inspectable steps when needed.
- [Google prompt design guidance](https://ai.google.dev/gemini-api/docs/prompting-strategies): clear constraints, consistent structure, examples, and iterative testing.
- [STE method and primary sources](ste-method.md): the official standard, white paper, and limits of automatic checking.
