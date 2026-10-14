import test from 'node:test';
import assert from 'node:assert/strict';
import { taskScope } from '../src/board.mjs';

// Five Origin tasks in a chain; task 1 carries the whole project's design in its own text.
function project() {
  const origin = id => ({ originProjectId: 'o1', originTaskId: id, snapshotId: 's', hash: 'h', key: id });
  const card = (n, title, todo, dependsOn = []) => ({ id: `t${n}`, number: n, title, column: 'todo', prompt: `# IMP-00${n} ${title}\n\n## What to do\n${todo}\n\n## Done when\nIt works.\n\n---\n# Context from the Origin design\nA customer portal with authentication, APIs, persistence and UI.`, originSource: origin(`i${n}`), dependsOn });
  return { id: 'p1', name: 'Customer Portal', tasks: [
    card(1, 'Application foundation', 'Project structure, dependencies, configuration and entry point.'),
    card(2, 'Database and persistence', 'Schema and data access.', ['t1']),
    card(3, 'Authentication', 'Sign-in and sessions.', ['t2']),
    card(4, 'Backend APIs', 'Order and account endpoints.', ['t3']),
    card(5, 'Frontend integration', 'Pages that use the APIs.', ['t4']),
    { id: 'x', number: 9, title: 'Unrelated chore', column: 'todo', prompt: 'Update the README badge.' },
  ] };
}

test('a run knows its project, its position, the other tasks for awareness only, its stage duty and who owns transitions', () => {
  const board = project(), [first, second] = board.tasks;
  first.column = 'executing';
  const scope = taskScope(board, first, 'executing');
  assert.match(scope, /^=== WHERE THIS TASK FITS/);
  assert.match(scope, /Project: Customer Portal/);
  assert.match(scope, /This task: #1 Application foundation \(task 1 of 5 planned in Origin\)/);
  assert.match(scope, /Stage: Executing\. Your job: implement this task only/);
  assert.match(scope, /Other tasks in this project \(for awareness only; they are not your job\):\n- #2 Database and persistence \(To Do; after #1\): Schema and data access\./, 'the task waiting for this one comes first, with its own scope');
  assert.match(scope, /- #9 Unrelated chore \(To Do\)\n/, 'a card that did not come from Origin is listed by title only');
  assert.match(scope, /do not authorize work assigned to other tasks/);
  assert.match(scope, /the next column is Code Review/);
  assert.match(scope, /Do not merge, move or complete cards, or start another task\./);
  assert.doesNotMatch(scope, /Prerequisites/);

  // Task 2 sees its prerequisite's completion and what it did; an unmerged Done is named as such.
  Object.assign(first, { column: 'done', completion: { kind: 'merged', targetBranch: 'main', summary: 'Added the Express entry point and config loader.' } });
  second.column = 'planning';
  let two = taskScope(board, second, 'planning');
  assert.match(two, /task 2 of 5/);
  assert.match(two, /Your job: plan this task only/);
  assert.match(two, /Prerequisites \(must be complete before this task\):\n- #1 Application foundation: Done, merged into main\n  What it did: Added the Express entry point and config loader\./);
  first.completion = { kind: 'unmerged', summary: '' };
  two = taskScope(board, second, 'code_review');
  assert.match(two, /#1 Application foundation: Done, completed without merging; its code is not on the target branch/);
  assert.match(two, /Report work that belongs to another task below as a finding/);

  // An Autopilot route decides the next column; a deleted prerequisite is named.
  board.autopilot = { route: ['planning', 'executing', 'testing'] };
  second.dependsOn = ['gone'];
  two = taskScope(board, second, 'executing');
  assert.match(two, /the next column is Testing/);
  assert.match(two, /- a deleted card/);
});

test('the scope section stays bounded on a large board', () => {
  const board = project();
  for (let n = 10; n < 60; n++) board.tasks.push({ id: `y${n}`, number: n, title: `Task ${n}`, column: 'todo', originSource: { originProjectId: 'o1' }, prompt: `## What to do\n${'x'.repeat(5000)}` });
  const scope = taskScope(board, board.tasks[0], 'planning');
  assert.match(scope, /- and 35 more/);
  assert.ok(scope.length < 8000, `${scope.length} characters`);
});
