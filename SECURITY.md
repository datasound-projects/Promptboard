# Security

This is a local, single-user prompt editor. Do not expose its HTTP port through a proxy or public tunnel.

The server binds to `127.0.0.1`. It checks the Host, Origin, and fetch-site headers.
POST requests require a per-process token. Static responses use a restrictive content security policy.
User text is passed through stdin to a fixed executable with `shell: false`.
No browser request can select an executable, a working directory, or arbitrary CLI arguments.
Requests and output are bounded. Only one pipeline runs at a time, with at most four model calls.
Each stage has a fresh temporary working folder. Review and repair text remain untrusted model output.
JSON and evidence checks do not prevent every prompt injection or establish semantic correctness.

These controls do not defend against software that already runs as your local user.
Prompt boundaries are guidance, not proof against prompt injection.
Some CLI integrations and managed settings can remain active. Review `docs/cli-adapters.md` before use with sensitive text.
CLI credentials stay in the CLI's own configuration. The app does not read or copy credential files.

Avoid secrets in requests. Browser history, exported verification reports, and CLI logs can contain prompt text and review excerpts.
Never attach credentials or private prompt history to a public issue.
Use the repository's private vulnerability report feature when its owner enables it.

## Changes that need review

- CLI flags, model arguments, executable lookup, and policy handling.
- Process cancellation, time limits, or maximum output size.
- HTTP binding, origin checks, static routes, or content security policy.
- History storage and model output display.

Do not add automatic approval bypass, shell interpolation, remote binding, or tool fallback on policy errors.
