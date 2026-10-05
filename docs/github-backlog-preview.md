# GitHub issue preview foundation

Pipeline projects can request a read-only GitHub issue page through authenticated `GET /api/projects/:projectId/backlog/import/github-issues`, with `repository`, `state` (`open`, `closed` or `all`) and `page` parameters. This is an API foundation; the import picker, saved source configuration, deduplication ledger and creation of imported drafts are separate work.

Use `owner/repository` or its github.com HTTPS repository URL. The existing signed-in GitHub CLI makes one bounded GET request without a shell, interactive sign-in or configuration changes. Promptboard reads no credential files. Each response contains at most 100 raw rows; `nextPage` uses that raw count so a page containing only pull requests can still advance. Pull requests are excluded from issue previews. The explicit 1,000-page bound is reported when reached.

Issue previews retain exact title/body text, source identity, issue number, status, repository-owned link, label names/colors, assignees, optional issue type and timestamps. Malformed or duplicate identities are reported as unavailable rather than silently included. Labels are preview metadata and do not alter the project catalog. Oversized or malformed pages fail as a whole. Errors use bounded application messages and exclude CLI stderr.

Project ownership is checked before and after the request. Reading a preview writes no board state, creates no tasks or drafts and starts no agents. Composer, split tasks, Base configuration and ambient CLI inheritance retain their existing behavior. Offline tests inject the reader and CLI runner; they do not consume signed-in model quota or mutate GitHub.

The request follows the official [GitHub issue-list API](https://docs.github.com/en/rest/issues/issues#list-repository-issues) and [GitHub CLI API command](https://cli.github.com/manual/gh_api). Kangentic's [Backlog and imports](https://www.kangentic.com/guide/backlog/) remains the target for the later selective import workflow.
