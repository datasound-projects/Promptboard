# Evaluate a change

This is a small regression corpus, not proof that a model produces reliable prompts.
The 12 authored cases cover all seven tasks, three languages, and four detail settings.
They include exact literals, code, paths, numbers, negations, conflicting requirements,
requested renames, hostile test data, and attempts to pass a check while changing meaning.

## Offline checks

Run `npm test`. The corpus test checks independently authored good and bad candidates
against the literal verifier. No model is called. Some bad candidates must pass these
mechanical checks: their failures concern meaning, which literal retention cannot prove.
The reference candidates are useful comparison examples, not the only valid answers.

## Optional live evaluation

Sign in to the installed CLI. Then explicitly select a provider:

```bash
npm run eval:live -- --provider codex --split dev
npm run eval:live -- --provider claude --model MODEL_ID --effort high --split holdout
```

`--quality reviewed` is the default: drafting, review, and at most one repair with a new
review use up to four model calls per case. `--quality fast` uses one call per case.
CLI limits and charges apply. Running the command without a provider only shows help
when no options are supplied; other incomplete settings fail before any model call.

The script runs cases sequentially and writes JSON to stdout. To save clean JSON without
npm's script banner, run `node scripts/evaluate.mjs --provider codex --split dev > eval.json`.
Generation errors contain generic diagnostics, not CLI stderr. Reports include prompts,
model check evidence, observed models when reported, timings, and the human checklist.
Counts summarize app checks; they are not a universal quality score. Model-call counts
cover completed cases only; a failed case can also consume usage. Exit 0 means the run
completed, not that its prompts are correct. Exit 1 means configuration or generation
errors. Exit 130 means interruption.

## Human rubric

Compare each result with the original input in `cases.mjs`, then mark each item as
**pass**, **fail**, or **uncertain**. Record a source excerpt and a prompt excerpt for
each failure or uncertainty.

- Meaning: retain all requirements, values, units, order, priorities, and exclusions.
- Literals: retain original code, commands, paths, identifiers, URLs, and quoted text.
- Scope: rewrite the task without executing it, inventing facts, or adding unrelated work.
- Conflicts: show conflicting requirements and ask only necessary blocking questions.
- Language: use the selected language and useful detail without dropping requirements.
- Clarity: use clear instructions and consistent terms. Review English against the
  official STE standard when compliance matters; German and Polish are not English STE.
- Evidence: do not claim unperformed work, tests, source checks, or dictionary approval.

Use each case's `humanChecks` and `badFailure` to identify the intended failure mode.
A model reviewer can miss the same defect as the drafting model. Compare its findings
with human findings before relying on it. Do not derive an accuracy claim from the app's
own pass rate. Check both missed defects and false alarms against human judgments.

Use **dev** while changing rules. Freeze the implementation before running **holdout**.
If a holdout result influences a change, treat that case as development data for that
iteration and add fresh cases before claiming a new holdout result. These public splits
are a workflow convention, not secret data or proof of absence from model training.
Reference candidates and human rubrics are never sent in the live generation request.

No live-model accuracy is asserted by this corpus. Record the engine version, CLI
version, requested and reported model, effort, date, and human decisions when comparing
releases. Repeat runs to inspect variation; a single successful sample is not a guarantee.
