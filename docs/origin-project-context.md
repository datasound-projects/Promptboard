# Origin — Project Context

**Create Context** in the Origin header writes the project's saved design into one Markdown document and opens it in the right-side panel. You can read it, edit it, download it, and optionally reuse it in Compose, Base or Kanban. The blueprint stays the structured design; the document is a separate copy.

## One-way conversion

- Create Context first saves any pending Origin edits. If that save fails or conflicts, nothing is created.
- The server converts one saved blueprint revision. It reads the stored records, not the screen, so collapsed editors, More details, custom sections and every answer are included. It makes no model call, fetches no link, scans no repository and starts no agent.
- Editing the document never changes Origin, and the document is never parsed back into Origin, including changed headings, IDs and diagrams. Editing Origin never changes the document until you regenerate it.

## What the document contains

- A header with the project name, the source blueprint revision, the generation time and a provenance note. A table of contents with stable anchors (`#ctx-phase-…`, `#ctx-section-…`) follows the sidebar order and the project's own names.
- Every section, in your own wording: its guiding question, its state (including **Not applicable**, with anything written there kept), and every record with its ID, key, status and links. Empty fields are listed once per record as “Not provided”; nothing is invented.
- Authored text is kept exactly. Text that would change the document's structure (code fences, headings, raw HTML) is placed in a longer fenced block, unchanged. Technologies are grouped as Selected, Candidates and Rejected. Decisions, assumptions and sources keep their states. A task shows its current instruction, the original instruction when a Compose refinement was accepted, and a pending proposal separately. A task sent to Kanban shows its stored handoff reference; the card's live column is not included.
- **Diagrams.** Architecture (components, layers, directed connections with labels and protocols) and task prerequisites are written as Mermaid flowcharts generated from the saved records, each with a plain-text table. Visual links drawn on the Overview map are listed separately as visual relationships, never as dependencies or prerequisites. Positions are in **Appendix B. Layout data**, which states that they are not implementation requirements.
- **Appendix A. Export report** states the coverage (every stored field is exported; a field the format does not know is listed as data instead of being dropped), redactions and what is excluded: Kanban card states, sessions and transcripts, Base resource contents (Base references are listed by ID), linked web pages (only stored claims), task-context snapshots and earlier Project Context documents.
- Text that looks like a secret is replaced with `[redacted]` by the same pattern check as other Origin context, and the report names where. Detection is pattern-based and can miss secrets.
- The same saved design always gives the same body; only the header's revision and time differ.

## Storage and versions

- Files live in `<data folder>/origin/context/<origin id>/`: `document.json` (document ID, its own revision, title and versions) and immutable Markdown files named by their SHA-256 hash. Replacing `document.json` (temporary file, fsync, rename, previous copy kept as `.bak`) is the only commit point, so an interrupted write leaves the previous document or the new one, never mismatched text. A damaged `document.json` falls back to its backup. Without a good backup the document is reported as damaged (`CONTEXT_DAMAGED`); **Create Context** then starts a new document and keeps the damaged files in `<data folder>/origin/deleted/`.
- Each version keeps its generated baseline separately from its edited text, with the source blueprint revision, the export format version, generation and edit times, and both hashes. **Edited** shows when the text differs from its baseline.
- One active document per project. **Versions…** lists up to 20 generated versions; older ones open read-only so you can copy text from them. The blueprint file and its revision never change when the document is opened or edited.
- Deleting the Origin project moves the folder to `origin/deleted/`. Base copies are independent and stay usable. The Kanban backup does not include Origin data; the document travels with the Origin data folder.

## The panel

- **Preview** renders the saved Markdown locally: raw HTML is shown as text, links open only `http(s)` addresses or in-document anchors, and images or other external content are never loaded. Mermaid flowcharts of the kind this document writes are drawn locally as SVG; other or invalid diagram code shows a local message and the text is kept. Very long documents are previewed in part, with a note; the file stays complete.
- **Edit** is a plain Markdown editor with its own autosave, revision check, **Retry**, and **Reload saved version** / **Keep mine** after a conflict. Unsaved text survives switching the panel to a record editor, and Origin waits for it before switching projects.
- The panel is resizable on desktop (drag its left edge, or focus the edge and use the arrow keys) and a full-width sheet on narrow screens. Escape closes it.
- **Origin changed** appears when Origin's saved content no longer matches the document's source. Moving things on the map does not count. Nothing changes until you choose **Regenerate from Origin**.
- **Download .md** and **Copy Markdown** save pending edits first and use that exact saved revision.

## Regenerating

**Regenerate from Origin** saves pending Origin and document edits, then generates a new candidate from the latest saved blueprint. It reads Origin, not your edited document, and does not carry edits over. The comparison shows lines only in the new version (+) and only in the current one (−). **Use new version** makes it current and keeps the previous version, with its edits, in Versions. **Keep current** drops the candidate.

## Reusing it (optional)

Each action uses the current saved revision and its hash. Project Context is reference material: it grants no tool or permission and never replaces task instructions or a task's own Origin context.

- **Use in Compose** attaches the document as an optional source through Compose's existing document upload, labelled as the target project's planned design (not evidence that the repository implements it), with the revision in its name. Compose's limits, retrieval budget, cancellation and consent apply; because Compose reads sources during research, attaching turns on Research and Use selected sources. Your Compose request is unchanged and nothing is generated. Documents above 2 MB are attached as a labelled excerpt of the sections you choose. Evidence from Markdown documents now names its section.
- **Save in Base** creates one Base Knowledge resource, “Project Context: <project>”, through Base's validated API. Its pages are the document's sections and join back into the exact file; each page records the Origin project ID, document ID, revision and hash. It is not assigned to anything. Saving the same revision again creates nothing; a changed document asks whether to update a copy or save a new one, and a copy edited in Base is replaced only after confirmation. Base's 4 MiB resource limit applies; larger documents are refused with that reason.
- **Use in Kanban** supplies chosen sections to one scope you pick: a card or an agent column of the linked Kanban project, or a Base agent profile. A preview first lists what happens: the Base copy used or first saved, the Base Context resource that names the chosen pages, and the scope. The scope's assignment is extended, never replaced. The Context resource is marked `complete`: a run receives the chosen sections whole, or the run stops with a clear Base budget message (one run receives at most 48,000 characters of Base material, counting the source line that each excerpt of up to 1,800 characters gets, so larger selections are refused before anything changes). Runs pin the resource revisions they accept and record what they received in the run's Base evidence; running sessions are not changed and the document is not resent on every column move.

## Limits

- The master document is at most 8 MB; a larger export fails without saving anything. Compose accepts up to 2 MB per document, Base up to 4 MiB per resource and 200 pages, and a run up to 48,000 characters of Base material.
- The local diagram preview draws flowcharts only (nodes, subgraphs and arrows with labels); it does not reproduce Origin's canvas positions.
