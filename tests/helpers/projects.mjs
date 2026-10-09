// Tests switch projects through the sidebar project list, as a person does. Evaluate these in the page.
/** Show a project's board, as a click on its sidebar entry does. */
export const pickProject = id => `document.querySelector('#workspace-list [data-project-id=${JSON.stringify(id)}] .workspace-item').click();`;
/** The id of the project whose board is shown. */
export const shownProject = `document.querySelector('#workspace-list .current')?.dataset.projectId`;
