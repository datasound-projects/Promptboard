# Autonomous Compose context research

Compose can turn a rough task into an implementation-ready prompt without asking the user clarification questions. Step 2 contains a compact **Context grounding** section:

- **Enable context grounding** assesses the complete request and chooses the smallest useful investigation. Click **Generate prompt** once; preparation continues into the existing generation/review pipeline automatically. Internal questions never become user-answer fields.
- **Use selected sources** enables explicitly selected Context7/custom read-only MCP servers, local project/knowledge folders, PDF/text/Markdown documents, and expert context. This control is subordinate to grounding. Available sources are not contacted just because they exist.
- **Auto-split final prompt into subtasks** uses the existing splitter on the exact finished prompt and opens a review/copy preview. Saving tasks remains an explicit action.

All new preferences start off. Legacy clarification/source-only preferences migrate deliberately to grounding, retaining the existing source consent; an explicitly saved grounding-off preference always wins. Turning grounding off prevents preparation and source access even when source consent or selections remain in memory. The normal Compose pipeline adds no planning model call or retrieval. It still rejects clear topic-only/noise inputs locally. The Compose generator never asks the user clarification questions, including when grounding is off.

## Intent and restraint

A conservative zero-I/O guard rejects obvious single-word topics such as `dog` and `QuestDB`, greetings, and noise. It performs no model call, MCP connection, folder traversal, or document retrieval. The API returns a non-actionable state; direct generation returns `NON_ACTIONABLE_INPUT` (422). Ambiguous longer inputs use the optional structured assessment rather than a brittle fixed list of English verbs. The model must identify the original goal before planning research and must not invent an objective. An unavailable or malformed assessment contributes no evidence and shows a warning; generation can continue from the original task. A valid non-actionable assessment still stops generation.

The assessment extracts goal, entities/technologies, operations, explicit constraints, expected output, complexity, whether project context is needed, and a justified research level. Internal research questions contain a concrete gap, its material implementation impact, a source hint, library hint, and targeted query. They are not displayed as user answer fields. Unknown preferences and environment details become explicit assumptions or implementation-time inspection instructions.

Research scales with the task:

| Level | Internal questions | Total source/query lookups | Retrieval rounds |
| --- | ---: | ---: | ---: |
| None | up to 3 | up to 2 supplied-context lookups; no MCP | 1 |
| Light | up to 3 | up to 2 | 1 |
| Standard | up to 10 | up to 8 | 1 |
| Deep | up to 24 initially; 32 total | up to 24 | 2 |

A website about dogs or a directory listing script normally needs no external research. A simple writing task can still use selected style guidance. Current multi-system integration details can justify standard research. A Docker/QuestDB/yfinance schema plus historical/incremental ingestion task can justify deep research. Limits are ceilings, never question quotas. Depth follows uncertainty and material interactions, not input length or technology count. Informal, multilingual and nontechnical tasks do not receive invented engineering scope.

Source descriptions have stable IDs and may include at most 1,200 characters of already supplied expert/document text before assessment, without new parsing, traversal or networking. Local queries can use synonyms or a different language from the task. A specifically selected source may contribute a bounded preview on a lexical miss, but only an accepted relevant synthesis finding can enter final grounding from that preview. External queries still require task/entity/evidence overlap. Recognizable credentials, private paths, code delimiters, URLs, or contact details are excluded from external queries.

The first model call combines intent assessment and initial research planning. An evidence review compresses facts and can discover up to eight new material questions. Deep research reserves part of the lookup budget for one targeted follow-up. Repeated source/library/query lookups are deduplicated. Empty or irrelevant retrieval does not trigger synthesis calls. The process stops on sufficient context, no new evidence, repeated queries, lookup/round budgets, or Cancel. At most four preparation model calls are allowed, including an optional repository checkpoint; simple tasks usually need one. The existing generation/review calls remain separate.

## Repository-first reasoning

Add **Project / local folder**, choose **Project / repository**, and set **Use as: Target project** for the actual target folder. The default is **Reference**; the role can also be changed on its compact source card. Reference architecture, dependencies and conventions must not become requirements for another target. The role survives retrieval, duplicate provenance and final generation. Compose never assumes that Promptboard's own repository, a Kanban project or its host machine establishes the user's target environment.

For existing-project tasks, local manifests, relevant code, README/conventions and selected skill files establish the actual framework and existing behavior before external documentation queries are chosen. A repository checkpoint refines queries using that evidence. If project context is unavailable, generic external architecture research is deferred and the generated prompt instructs the implementation agent to inspect the actual repository first.

Choose **Documentation, wiki, or Skills** for a local knowledge/LLMWiki folder or a directory containing skill references. These are reference data, never executable instructions. No Base/profile/pack assignment or Kanban data model is involved. A trusted search/API/knowledge service can also be supplied through a compatible read-only MCP query source. Compose does not silently enable autonomous web browsing or third-party accounts.

Local folders are read-only. Inspection is bounded to 1,500 directory entries, depth eight, 120 text files, 100,000 bytes per file and 1.5 MB total. Reads themselves use fixed-size buffers. Dependency/build/cache folders, symlinks, credential files, private keys and lockfiles are excluded. Common inline secrets in local files are redacted. Files outside the selected root are not eligible. Large folders produce a bounded-subset notice; the implementation agent must verify the complete project. Up to four folder indexes are cached for 30 seconds; each new preparation refreshes its first local read and reuses the index within that operation. Absolute paths and raw contents are not saved in browser storage. This filtering is conservative, not a guarantee that arbitrary sensitive information in selected source files can be recognized.

## Evidence and synthesis

Local project context is preferred, followed by selected documents/manual constraints, Context7 documentation, and other configured MCP sources. Each retrieved excerpt retains source type, name, locator, query and internal question IDs; duplicate passages merge additional provenance.

Local lexical retrieval uses paragraph/page-aware chunks, deterministic BM25-style relevance and duplicate removal. The research review sees at most 24,000 characters of relevant evidence (about 6,000 tokens), not entire documents. Findings must include an exact quotation present in the named retrieved excerpt. Invented quotations, unknown evidence IDs, oversized findings and unauthorized continuation are rejected. The final payload contains concise findings with their supporting excerpts and provenance, with a tighter 16,000-character evidence budget. If synthesis fails, small exact excerpts are used instead; malformed model summaries are never trusted.

Retrieval alone does not prove that a question is answered. The review classifies each question as supported, unresolved, a user-owned choice, or a conflict. Supported answers require known stable question IDs and associated exact-quoted findings retained within the final context budget. IDs survive repository checkpoints and follow-ups; duplicate lookups can serve multiple questions. User-owned choices cannot be resolved by documentation. Unsupported details remain proportionate verification instructions, and conflicts are exposed. A failed later MCP lookup preserves earlier successful results and exposes unfinished details. No source access or certainty is claimed beyond the actual supplied excerpts.

A valid review with no relevant findings contributes no evidence. Failed synthesis never resolves questions; its fallback uses only small lexical excerpts, not provisional previews. Exact quotations and schema validation constrain provenance, but semantic relevance and whether a conclusion is supported still depend on the selected model's judgment.

The original task remains unchanged in its own field. The final Compose engine receives an optional structured `grounding` payload containing evidence, explicitly labelled assumptions, and unresolved implementation-time verification instructions. Legacy `userAnswers` remains accepted by the API for compatibility, but the UI no longer gathers answers. Explicit original requirements override source evidence; conflicts must be exposed. Existing ASD-STE100 principles, detail modes, languages, literal preservation and review/repair mechanics remain active.

## Sources, privacy and failures

**Context7** discovers the current read-only `resolve-library-id` and `query-docs` schemas, resolves a task/library/language-specific result, and fails visibly if the API changes. `CONTEXT7_API_KEY` is read from the server environment when set. Anonymous use depends on the service's limits. See the [official Context7 implementation](https://github.com/upstash/context7/blob/master/packages/mcp/src/index.ts).

**Custom MCP** supports Streamable HTTP and stdio, using the existing MCP client SDK. Remote connections require HTTPS; loopback HTTP is allowed. Embedded URL credentials, query strings, fragments, redirects and arbitrary transport changes are rejected. Headers/environment values reference server environment variable names, not literal credentials. Local programs require explicit trust consent; read-only tool filtering does not sandbox the program itself. Generic retrieval requires one compatible string-`query` tool with `readOnlyHint: true`; destructive/ambiguous/action tools are refused. MCP server instructions are ignored. Up to three MCP servers and eight sources total are allowed.

```json
{"name":"Docs","transport":"streamable-http","endpoint":"https://example.com/mcp","headers":{"Authorization":"DOCS_AUTHORIZATION"}}
```

**Documents** support PDF, UTF-8 TXT and Markdown. PDF.js is loaded lazily in a terminable worker; Node 22.13+ is required. Raw uploads are bounded to 20 MiB. Selected page ranges are respected; only those pages are extracted/indexed. At most 200 pages and two million extracted characters are permitted. Scanned, encrypted, malformed and empty PDFs fail with a recoverable message. OCR is not included. The session cache holds at most eight documents/four million characters, expires after 30 minutes of inactivity, and retains no raw PDF bytes or temporary files. See the [PDF.js Node extraction API](https://github.com/mozilla/pdf.js/blob/master/examples/node/getinfo.mjs).

PDF extraction has a 30-second deadline and 128 MiB worker heap limit. Each MCP session has a 30-second deadline, 1 MB response cap and 100,000-character usable-text cap. Identical MCP queries are cached for ten minutes, up to 64 results. Compose's planning, synthesis, generation, review, repair and splitting model calls wait for completion or Cancel by default: neither the browser nor the server imposes a generation deadline. The finite call/query/round budgets still prevent research loops. Programmatic callers may supply an explicit pipeline/preparation deadline. Other provider consumers retain their existing bounded defaults.

Request-scoped Cancel/disconnect propagates to provider processes, MCP connections/process groups, local reads and PDF workers. One UI operation owns preparation and generation through the same cancellation ID and task/settings/source snapshot. Busy state continues across both stages; changes invalidate that operation, and stale successes or errors cannot overwrite newer state. Cached preparation refreshes on submission for local folders and after the MCP/document cache lifetime. A non-cooperative adapter cannot hold the Compose job slot after cancellation, and late promise rejections are observed. The existing shared CLI job slot prevents overlapping generation/auth/preparation jobs. Optional-source failures preserve the task and allow final generation with explicit unknowns. Invalid intent assessment contributes no facts or invented objective. Actionable provider/account errors remain errors during preparation as well as generation; Compose never changes the selected provider, model or effort to hide such failures.

Source material—including PDFs, MCP responses, repository files, wiki/skill text and expert context—is untrusted JSON data behind explicit boundaries in planning, synthesis, generation, review and repair. Model calls receive no execution permission through this feature. Source commands are inert; no task, skill, code, deployment, or repository mutation is automatically executed.

Codex generation reads bounded MCP configuration metadata without connecting, then disables inherited servers and ambient apps/plugins/hooks for that invocation. Overrides contain no MCP credentials and never edit CLI configuration. Compose-selected MCPs remain controlled by the separate read-only retrieval adapter. Codex effort validation includes `max` when supported by the selected model; unsupported/account-inaccessible models remain explicit errors.

Documents/local files stay local except for the selected excerpts sent through the chosen CLI. MCP queries can contact an external service. Only harmless checkbox preferences are persisted. Source configuration, folder paths, uploaded bytes, extracted text, raw grounding and credentials are not stored in browser localStorage. Existing prompt history still stores generated output/review, which can contain facts used in that output.

## Architecture and verification

`compose-intent.mjs` handles conservative local intent rejection. `compose-research.mjs` defines strict assessment/review contracts, research budgets, exact quotation checks and compact grounding. `compose-context.mjs` orchestrates the bounded loop. `compose-local.mjs`, `compose-documents.mjs`/`compose-pdf-worker.mjs` and `compose-mcp.mjs` provide isolated read-only source adapters. `compose-retrieval.mjs` ranks and budgets evidence. No new dependency is added by autonomous research.

Compose-only routes use the existing session token and host/origin protection:

- `POST /api/compose/cancel`: bounded, session-protected cancellation for a matching client-generated request ID; stale cancellations cannot stop another job.
- `POST /api/compose/prepare`: `{ request, autonomous, sources }`; the legacy `clarify` flag remains accepted as an alias but never produces user questions.
- `POST /api/compose/folder/choose`: opens the local folder picker; typed paths are also supported.
- `POST /api/compose/sources/document?name=guide.pdf&from=40&to=55`: bounded raw upload.
- `DELETE /api/compose/sources/document/:id`: releases a cached document.
- `POST /api/compose/mcp/test`: discovers eligible tools without invoking them.

Preparation and generation JSON are bounded to 1 MiB. Task input remains limited to 100,000 characters. Generated prompts and split input/task text support up to 200,000 characters; split JSON requests are bounded to 2 MiB to accommodate escaped text. Combined split coverage checks support two million characters without losing per-task or task-count bounds. Provider input/stdout remain bounded to 2 MiB. `POST /api/generate` accepts optional `grounding`; old CLI/API requests remain compatible. Explicitly non-actionable single-word/topic input is rejected rather than turned into an invented task.

Run `npm run check` and `npm test`. Deterministic tests cover all research levels, topic/noise rejection with zero calls, irrelevant query/source gating, 20+ internal questions, a discovered follow-up, repeated-query stopping, exact quotation validation, source failures/partial results, deadlines/cancellation, repository-first selection, missing repository context, local secrets/symlinks/file bounds, knowledge/skill sources, PDF ranges, source injection boundaries, mixed context, languages and one-click UI with no user-answer fields. The browser test preserves history, editing, manual split, auto-split, themes, keyboard access and narrow layouts. Live model/Context7 checks are optional and not required by normal CI.
