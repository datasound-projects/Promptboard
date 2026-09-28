# Contribute

Use Node.js 22 or later. No runtime package installation is needed.

1. Make a small change with one clear purpose.
2. Update the docs when behavior changes.
3. Run `npm ci`, `npm run check`, and `npm test`.
4. For UI changes, check keyboard access and a narrow screen.
5. For adapter changes, check current official CLI docs. Add an offline regression test.

Keep user requirements and literal code unchanged during rewriting.
Do not market heuristic checks as full STE compliance.
Do not bundle the ASD standard, dictionary, or white paper without permission.
Do not add fixed model claims or performance claims without evidence.

## Release checks

- Run the CI matrix.
- Run the opt-in evaluations and manually review held-out cases. See `evals/README.md`.
- Record failures and latency; do not tune prompts on the held-out set.
- Create one prompt with each authenticated CLI on a supported system.
- Check cancellation, policy denial, sign-in failure, and model access errors.
- Record CLI versions, source dates, and any unsupported platform.
- Check the UI at desktop and mobile sizes.
- Check the archive for credentials, private data, and unnecessary files.
