/** Project-local display identities; UUIDs remain the routing/ownership identity. */
export function validateTaskNumbers(project, { required = false } = {}) {
  const seen = new Set();
  for (const task of project.tasks) {
    if (task.number === undefined && !required) continue;
    if (!Number.isSafeInteger(task.number) || task.number < 1 || task.number >= Number.MAX_SAFE_INTEGER || seen.has(task.number))
      throw new Error('Task numbers must be unique positive safe integers within a project.');
    seen.add(task.number);
  }
  if (project.nextTaskNumber !== undefined || required) {
    if (!Number.isSafeInteger(project.nextTaskNumber) || project.nextTaskNumber < 1 || [...seen].some(number => number >= project.nextTaskNumber))
      throw new Error('The next task number must exceed every saved task number.');
  }
}

/** Assign missing historical identities once in saved array order, retaining existing ones. */
export function assignTaskNumbers(project) {
  validateTaskNumbers(project);
  project.nextTaskNumber ??= Math.max(0, ...project.tasks.map(task => task.number || 0)) + 1;
  for (const task of project.tasks) if (task.number === undefined) task.number = allocateTaskNumber(project);
  return project;
}

export function allocateTaskNumber(project) {
  const number = project.nextTaskNumber;
  if (!Number.isSafeInteger(number) || number < 1 || number >= Number.MAX_SAFE_INTEGER) {
    const error = new Error('This project has exhausted its task numbers. No task was created.');
    error.code = 'TASK_NUMBER_EXHAUSTED'; error.status = 409; throw error;
  }
  project.nextTaskNumber++;
  return number;
}
