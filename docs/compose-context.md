# Optional Compose context grounding

Step 2 contains a collapsed **Context grounding** section. All three options start off:

- **Ask clarification questions** makes one optional CLI planning call before generation. Up to six focused questions are optional. **Skip questions and generate** keeps unanswered decisions open.
- **Use context sources** lets the planner identify relevant lookups in Context7, a custom MCP server, local PDF/text/Markdown files, or expert context. No source is contacted unless the plan includes a relevant query for it.
- **Auto-split final prompt into subtasks** sends the exact completed prompt to the existing splitter. The preview can be reviewed, edited, and copied without a project. Saving to Kanban remains a separate explicit action.

Turning off questions and sources restores the existing generation path: no preparation request, PDF work, retrieval, MCP process, or extra model call. Turning off auto-split also restores the existing manual split behavior.

## Sources and privacy

Add **Context7** to use library documentation. It resolves the library before querying task-specific concepts, including the programming language. The preset discovers current tool schemas and read-only annotations; an incompatible API produces a visible error. It uses `CONTEXT7_API_KEY` from the environment that starts Promptboard when available. Anonymous access depends on Context7's service limits. See the [official Context7 MCP implementation](https://github.com/upstash/context7/blob/master/packages/mcp/src/index.ts).

**Custom MCP (advanced)** accepts a small configuration in JSON. HTTP uses Streamable HTTP; local programs use stdio without a shell. Local programs require the explicit “Allow starting” checkbox. Starting a trusted MCP program itself runs code on the computer; read-only tool filtering cannot sandbox that program.

```json
{
  "name": "Documentation",
  "transport": "streamable-http",
  "endpoint": "https://example.com/mcp",
  "headers": { "Authorization": "DOCS_AUTHORIZATION" }
}
```

The example header references an environment variable containing the complete authorization value. It does not contain a literal credential. Remote connections require HTTPS; HTTP is permitted for loopback servers. URLs cannot contain embedded credentials or query parameters. Redirects are rejected.

```json
{
  "name": "Local documentation",
  "transport": "stdio",
  "command": "my-documentation-mcp",
  "args": [],
  "env": { "API_KEY": "DOCS_API_KEY" }
}
```

Generic MCP retrieval supports one clearly named read-only query tool with a string `query` input and no other required arguments. It refuses ambiguous tool selection and incompatible schemas. A `readOnlyHint: true` annotation is required, destructive annotations and action-like tool names are rejected, and returned server instructions are ignored. Compose does not execute arbitrary tool plans from a model. It does not implement OAuth, general MCP management, resource-template browsing, or arbitrary argument mapping.

**Documents** support PDF, UTF-8 `.txt`, and `.md`. PDF processing uses the [PDF.js Node extraction API](https://github.com/mozilla/pdf.js/blob/master/examples/node/getinfo.mjs), loaded only during PDF preparation, in a terminable worker. Node 22.13 or newer is required by this dependency. Select a page range before uploading; only those pages are extracted/indexed. Scanned, encrypted, malformed, and empty PDFs fail with a recoverable message. OCR is not included.

Documents and expert context stay local except for the retrieved excerpts passed to the selected CLI for prompt generation and review. MCP queries may contact external services. Only the three harmless checkbox preferences are persisted by the new UI. Uploaded bytes, extracted text, MCP configuration, credentials, and the grounding payload are not saved in browser storage. Existing history still saves the generated prompt and its review report, which can contain facts included in that output.

## Boundaries and limits

- Eight sources total, including at most three MCP servers.
- One planning model call per preparation attempt, never one per source/question/chunk. Retry is explicit.
- Six questions, each with up to two targeted source queries. Invalid JSON, unknown fields, duplicate IDs, required questions, and oversized strings are rejected.
- 20 MiB raw upload; text files and extracted PDF text have a 2,000,000-character/byte cap. At most 200 PDF pages per selection.
- Page-local chunks target 2,800 characters with 280-character overlap and prefer paragraph boundaries. Tiny documents remain one direct excerpt.
- Deterministic BM25-style retrieval selects up to four relevant chunks per query. Low lexical overlap is discarded. Duplicate passages merge question IDs and additional provenance.
- A shared 24,000-character budget includes excerpt text and provenance (approximately 6,000 tokens). Lower-ranked excerpts are dropped first.
- PDF parsing has a 30-second deadline and a 128 MiB worker heap limit. The session cache stores at most eight documents and four million extracted characters, with a 30-minute inactivity expiry checked on access. It keeps no raw upload bytes or temporary files.
- MCP responses are bounded to 1 MB per response; usable text results are bounded to 100,000 characters. Each source has a 30-second deadline. Up to 64 identical query results are cached for ten minutes. Preparation has a 120-second total deadline.
- Disconnecting or pressing Cancel propagates cancellation to the provider, MCP connection/process group, or PDF worker. The existing shared CLI job slot prevents overlapping preparation/generation/auth operations.

Evidence always carries source type, name, locator, query, and linked question IDs. The UI says **relevant evidence found**, not that retrieval proved an answer. User-specific decisions stay unanswered unless the user supplies them. A source-only question with evidence is deferred to the final model for synthesis; the model must keep unsupported details open.

All source content is untrusted JSON data behind explicit instruction boundaries in generation, review, and repair. Original explicit constraints take priority over clarification answers, which take priority over supporting evidence. Conflicts must be exposed. The model receives no tools through this feature. Prompt boundaries reduce injection risk; semantic correctness still requires the same human review as existing Compose.

## Implementation and verification

`compose-grounding.mjs` defines the strict contracts and boundaries. `compose-retrieval.mjs` implements chunking, BM25 ranking, duplicate merging, and budgeting. `compose-documents.mjs` and `compose-pdf-worker.mjs` handle document validation, extraction, and caching. `compose-mcp.mjs` owns source connections and safe retrieval. `compose-context.mjs` orchestrates the single planning call and lookups. `mcp-process.mjs` is the generic process-ownership bridge also used by the existing Base compatibility entry point; Compose imports no Base module.

The existing engine, review pipeline, server, and Step 2 UI are extended. The original source text is never rewritten into a concatenated grounding request. User answers participate in literal and review coverage checks; source excerpts are supporting evidence, not additional mandatory requirements.

Compose-only routes use the existing local session token, origin/host protection, and bounded bodies:

- `POST /api/compose/prepare`: `{ request, clarify, sources }`
- `POST /api/compose/sources/document?name=guide.pdf&from=40&to=55`: raw bytes with the matching content type
- `DELETE /api/compose/sources/document/:id`: release a cached document
- `POST /api/compose/mcp/test`: discover eligible tools without calling them

`POST /api/generate` accepts optional `grounding: { userAnswers, evidence, unresolvedQuestions }`. Old API and CLI requests remain valid.

Run `npm run check` and `npm test`. The `compose-*.test.mjs` suites use deterministic provider/MCP fixtures and actual PDF extraction, SDK transports, HTTP routes, and Chrome when installed. They cover default-off behavior, source combinations, exact answers/unresolved payloads, irrelevant documents, malicious source boundaries, destructive MCP tools, cancellation, errors, cache/budget limits, languages, history/editing, and both split modes. Normal CI does not call Context7 or an external model. Set `PB_BROWSER_SHOTS` to an existing directory to capture the real-browser theme/viewport checks.
