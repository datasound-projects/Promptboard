/** Saved task metadata, independent of prompt content and execution order. */
export const TASK_PRIORITIES = Object.freeze(['None', 'Low', 'Medium', 'High', 'Urgent']);

export function taskPriority(value = 0) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= TASK_PRIORITIES.length) {
    const error = new Error('Choose a task priority: None, Low, Medium, High or Urgent.');
    error.code = 'INVALID_TASK_PRIORITY'; error.status = 400; throw error;
  }
  return value;
}
