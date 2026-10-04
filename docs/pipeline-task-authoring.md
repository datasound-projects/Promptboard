# Pipeline task authoring

An opt-in column pipeline accepts a task with a nonempty title and no prompt body, following Kangentic's [optional description](https://www.kangentic.com/guide/creating-tasks/) contract. The card editor labels the body optional; quick creation can still derive a title from a supplied prompt. When both are empty, creation is refused. Titles keep the existing 120-character bound and prompt bodies keep their existing type/size limits. Legacy stage boards retain their required prompt body.

The server advertises title-only support in its existing session response. If the updated browser is served by an older running server without that capability, the editor keeps requiring a body. Updating source does not restart an existing app process.

Creation always uses the pipeline's To Do role, including renamed role IDs, and starts no agent. The stored body stays empty rather than being filled with a synthesized prompt. On an explicit active move, the existing task envelope includes the escaped title and omits an empty description. Native permission modes, selected Base resources and inherited CLI tools keep their current delivery paths.

Supplied prompt text retains its original whitespace and line endings. Editing a generated task's title or clearing its body increments content revision and marks its old generation checks outdated; its source/history metadata is retained. Copying, reopening state and portable pipeline backup/import keep the empty body. Imports still disable automatic dispatch and carry no native session grants. Malformed or missing backup prompt fields remain invalid, and legacy backups still require meaningful bodies.

Refine in Composer uses the title when a pipeline draft has no meaningful body. It opens Composer without creating the card or starting an agent. A meaningful supplied body remains the exact Composer input. Existing Composer results and edited split tasks still enter To Do through their normal authoring path.

This step adds title-only authoring. Task numbers, labels, priority, attachments, creation directly into active columns and backlog imports remain pending. Native column-message scheduling is a separate integration step; this feature does not enable message rows or advance tasks automatically.
