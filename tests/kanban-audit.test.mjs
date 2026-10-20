import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prerequisiteMet, projectColumns } from '../src/board.mjs';

const project = { workflowMode: 'pipeline', pipeline: { columns: [{ id: 'todo', role: 'todo' }, { id: 'finished', role: 'done' }] } };
const card = extra => ({ column: 'finished', ...extra });
const CASES = [
  [{ completion: { kind: 'merged' } }, true],
  [{ completion: { kind: 'no_changes' } }, true],
  [{ completion: null }, true, 'a Done card from before completions were recorded'],
  [{ completion: { kind: 'unmerged', branch: null } }, true, 'a card that never had a worktree has no code'],
  [{ workspace: { branch: 'task/a' }, completion: { kind: 'unmerged', branch: 'task/a' } }, false],
  [{ workspace: null, completion: { kind: 'unmerged', branch: 'task/a' } }, false, 'Remove worktree does not merge the code'],
  [{ workspace: null, completion: { kind: 'pull_request', mergedAt: null, url: 'https://github.com/o/r/pull/1' } }, false, 'an open pull request'],
  [{ workspace: { branch: 'task/a' }, completion: { kind: 'pull_request', mergedAt: null } }, false],
  [{ workspace: null, completion: { kind: 'pull_request', mergedAt: 1 } }, true],
  [{ workspace: { branch: 'task/a' }, completion: { kind: 'closed', branch: 'task/a' } }, false, 'an unknown kind with code on a branch'],
  [{ column: 'todo', completion: { kind: 'merged' } }, false],
];

test('a prerequisite counts only when its code is on the target branch, also after its worktree is removed', () => {
  for (const [extra, met, label] of CASES) assert.equal(prerequisiteMet(project, card(extra)), met, label || JSON.stringify(extra));
});

test('the page applies the board’s prerequisite rule to the same cards, on pipeline and legacy boards', async () => {
  // public/app.js keeps its own copy of the rule for card badges; it runs here on the server's cases.
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('const cardDone = '), end = source.indexOf('\n', source.indexOf('const prerequisiteMet = '));
  const page = new Function('projectColumnsOf', `${source.slice(start, end)}\nreturn prerequisiteMet;`)(board => board.columns);
  const legacy = { workflowMode: 'legacy' };
  for (const [board, done] of [[project, 'finished'], [legacy, 'done']]) for (const [extra, met, label] of CASES) {
    const entry = { column: done, ...extra, ...(extra.column ? { column: extra.column } : {}) };
    assert.equal(prerequisiteMet(board, entry), met, label);
    assert.equal(page({ ...board, columns: projectColumns(board) }, entry), met, `page: ${label || JSON.stringify(extra)}`);
  }
});
