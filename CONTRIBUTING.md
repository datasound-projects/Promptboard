# Contributing

Use Node.js 22 or later and Git.

```bash
npm ci
npm run check
npm test
```

The suite first runs non-browser test files two at a time, then runs files using `tests/helpers/browser.mjs` one at a time. This keeps Chrome fixtures separate from competing Git, PTY and JSDOM work; it does not disable tests or extend their timeouts. The runner uses the same Node executable and propagates failures from either phase.

1. Make one change with one clear purpose. Match the style of the surrounding code: plain ES modules, no framework, no build step.
2. Add or update a test that fails without your change. Tests use simulated CLIs (`tests/fixtures/fake-agent.cjs`) and disposable Git repositories. Never point a test at a real repository.
3. Update the README, `docs/`, and `CHANGELOG.md` (under **Unreleased**) when behaviour changes.
4. For UI changes, check keyboard use, both themes, and a narrow screen.
5. For CLI adapter changes, check the CLI's current official docs and add an offline regression test.
6. Read [SECURITY.md](SECURITY.md) before you change anything in its "extra review" list.

Do not add runtime dependencies without a strong reason. Pin exact versions.
Do not describe the checks as full STE compliance, and do not bundle the ASD standard or dictionary.
Do not add model or performance claims without evidence.

## Live checks (maintainers)

`scripts/live-flow.mjs --provider claude|codex` runs one task through every stage with a real, signed-in CLI in a disposable repository. `scripts/live-agents.mjs` checks a single stage. Both use your provider quota and never run in CI. Record results in `docs/live-verification.md`.

`scripts/live-native-messages.mjs --provider claude|codex|gemini` checks the private deferred native-message bridge in its own disposable board; `--column-automation` instead exercises a configured deferred Code Review enter row. Read [the smoke-check contract](docs/live-native-messages.md) before running it; startup, native input, durable receipts and subsequent task completion are separate results. This opt-in command uses provider quota and never runs live in CI.

## Releasing (maintainers)

1. Run the checks above, the live flow for each supported CLI, and update `RELEASE-VERIFICATION.md`.
2. Move the **Unreleased** notes in `CHANGELOG.md` under a new `## X.Y.Z — date` heading and set the same version in `package.json` and `package-lock.json` (`npm version X.Y.Z --no-git-tag-version`).
3. Commit, then push a tag `vX.Y.Z`. The release workflow runs the tests and creates the GitHub release from the changelog. Nothing is published to npm.
