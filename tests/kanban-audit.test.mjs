import test from 'node:test';
import assert from 'node:assert/strict';
import { prerequisiteMet } from '../src/board.mjs';

const project = { workflowMode: 'pipeline', pipeline: { columns: [{ id: 'todo', role: 'todo' }, { id: 'finished', role: 'done' }] } };
const card = extra => ({ column: 'finished', ...extra });

test('a prerequisite counts only when its code is on the target branch, also after its worktree is removed', () => {
  assert.equal(prerequisiteMet(project, card({ completion: { kind: 'merged' } })), true);
  assert.equal(prerequisiteMet(project, card({ completion: { kind: 'no_changes' } })), true);
  assert.equal(prerequisiteMet(project, card({ completion: null })), true, 'a Done card from before completions were recorded');
  assert.equal(prerequisiteMet(project, card({ completion: { kind: 'unmerged', branch: null } })), true, 'a card that never had a worktree has no code');
  assert.equal(prerequisiteMet(project, card({ workspace: { branch: 'task/a' }, completion: { kind: 'unmerged', branch: 'task/a' } })), false);
  assert.equal(prerequisiteMet(project, card({ workspace: null, completion: { kind: 'unmerged', branch: 'task/a' } })), false, 'Remove worktree does not merge the code');
  assert.equal(prerequisiteMet(project, card({ workspace: null, completion: { kind: 'pull_request', mergedAt: null, url: 'https://github.com/o/r/pull/1' } })), false, 'an open pull request');
  assert.equal(prerequisiteMet(project, card({ workspace: null, completion: { kind: 'pull_request', mergedAt: 1 } })), true);
  assert.equal(prerequisiteMet(project, card({ column: 'todo', completion: { kind: 'merged' } })), false);
});
