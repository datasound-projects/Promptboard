import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipelineTaskEnvelope, pipelineTemplateVariables, renderPipelineTemplate, renderPipelineSpawnPrompt, pipelineScriptEnvironment, unknownPipelineVariables, PIPELINE_VARIABLES } from '../src/pipeline-templates.mjs';

test('first spawn contains only the task envelope and resolved attachments, preserving engineered prompt whitespace', () => {
  const prompt = '  Exact {{title}} & <script>\r\n```js\r\nconst x = 1;  \r\n```\r\n  ';
  const task = { id: 'task', title: 'Title <&> "quoted"', prompt }, attachmentPaths = [join(tmpdir(), 'one.png'), join(tmpdir(), 'two.png')];
  const rendered = renderPipelineSpawnPrompt({ task, attachmentPaths, move: { column: 'Review', toColumn: 'Review', trigger: 'enter' } });
  assert.equal(rendered, `${pipelineTaskEnvelope(task)}\n${attachmentPaths.join('\n')}`);
  assert.ok(rendered.includes('  Exact {{title}} &amp; &lt;script&gt;\r\n```js\r\nconst x = 1;  \r\n```\r\n  '));
  assert.ok(rendered.includes('&lt;&amp;&gt; &quot;quoted&quot;'));
  assert.equal(task.prompt, prompt); assert.doesNotMatch(rendered, /Review|stage|permission|implement/i);
  assert.equal(pipelineTaskEnvelope({ title: 'Only title', prompt: '' }), '<task>\n  <title>Only title</title>\n</task>');
  assert.match(pipelineTaskEnvelope({ title: 'One line', prompt: 'body  ' }), /<description>body  <\/description>/);
});

test('template variables use current task facts and do not invent branches, usage, ports, or project paths', () => {
  const task = { id: 'task', title: 'Feature', prompt: 'Description', number: 42, labels: ['bug', 'priority'], workspace: { path: join(tmpdir(), 'worktree'), branch: 'task-42' }, baseBranch: 'task-base', externalSource: { key: 'ISSUE-7', url: 'https://example.test/7' }, evidence: { pullRequest: { url: 'https://github.com/example/project/pull/8', number: 8, state: 'OPEN', isDraft: true } } };
  const project = { name: 'Project', repository: { root: join(tmpdir(), 'main-checkout') }, targetBranch: { name: 'trunk' } };
  const values = pipelineTemplateVariables({ task, project, port: 5000, move: { column: 'Review', fromColumn: 'Build', toColumn: 'Review', trigger: 'enter' } });
  assert.deepEqual(Object.keys(values), PIPELINE_VARIABLES);
  assert.equal(values.taskNumber, '42'); assert.equal(values.description, ': Description'); assert.equal(values.labels, 'bug, priority');
  assert.equal(values.projectPath, project.repository.root); assert.equal(values.worktreePath, task.workspace.path);
  assert.equal(values.baseBranch, 'task-base'); assert.equal(values.prState, 'draft'); assert.equal(values.issueKey, 'ISSUE-7'); assert.equal(values.port, '5000');
  assert.equal(values.column, 'Review'); assert.equal(values.fromColumn, 'Build'); assert.equal(values.trigger, 'enter');
  const empty = pipelineTemplateVariables({ task: { title: 'Unstarted', prompt: '' }, project });
  for (const key of ['worktreePath', 'branchName', 'taskNumber', 'prUrl', 'port', 'issueKey', 'attachments', 'trigger']) assert.equal(empty[key], '');
  assert.equal(empty.baseBranch, 'trunk');
  assert.equal(pipelineTemplateVariables({ task: {} }).baseBranch, '');
});

test('automation substitution is literal and single-pass, with visible unknown variables and prototype keys', () => {
  const values = { title: 'Unexpanded {{description}}', description: ': Original' };
  assert.equal(renderPipelineTemplate('{{title}} {{missing}} {{constructor}}', values), 'Unexpanded {{description}} {{missing}} {{constructor}}');
  assert.deepEqual(unknownPipelineVariables('{{missing}} {{title}} {{missing}} {{constructor}}', values), ['missing', 'constructor']);
  const task = { title: 'Raw  title  ', prompt: 'line  \r\nnext\r\n' };
  assert.equal(renderPipelineSpawnPrompt({ task }, '  {{title}}   {{missing}}  \r\n  {{description}}  '), 'Raw  title  \r\n : line  \r\nnext\r\n');
  assert.equal(renderPipelineSpawnPrompt({ task }, '/review  {{baseBranch}}  {{column}}'), '/review');
});

test('webhook substitutions encode URL components and JSON string content without expanding task text twice', () => {
  const title = 'Quote " slash \\ newline\n{{other}} & /?', variables = { title, other: 'must not appear' };
  const url = renderPipelineTemplate('https://example.test/task/{{title}}?name={{title}}', variables, 'url');
  const parsed = new URL(url); assert.equal(parsed.searchParams.get('name'), title);
  assert.equal(decodeURIComponent(parsed.pathname.slice('/task/'.length)), title);
  const body = renderPipelineTemplate('{"title":"{{title}}"}', variables, 'json');
  assert.deepEqual(JSON.parse(body), { title });
  assert.throws(() => renderPipelineTemplate('{{title}}', { title: '\ud800' }, 'url'), { code: 'INVALID_PIPELINE_TEMPLATE' });
});

test('script substitutions cannot chain commands inside quotes or unquoted fields; environment expansion preserves exact values', { skip: process.platform === 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-template-script-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const sentinel = join(dir, 'must-not-exist');
  const title = `a'; touch ${sentinel}; echo "$(touch ${sentinel})" \`touch ${sentinel}\` $HOME %PROMPTBOARD_LABELS% &|<>\n#ignored`;
  const values = pipelineTemplateVariables({ task: { title, prompt: 'Description\nwith trailing spaces  ', labels: ['$(touch dangerous)'] } });
  for (const script of ["printf '%s' '{{title}}'", 'printf "%s" "{{title}}"', 'printf "%s" {{title}}']) {
    const rendered = renderPipelineTemplate(script, values, 'script');
    const output = execFileSync('/bin/sh', ['-c', rendered], { cwd: dir, encoding: 'utf8' });
    assert.ok(output.includes('must-not-exist')); await assert.rejects(access(sentinel));
  }
  const environment = pipelineScriptEnvironment(values);
  assert.equal(environment.PROMPTBOARD_TITLE, title); assert.equal(environment.PROMPTBOARD_TASK_XML, values.task_xml);
  assert.equal(environment.PROMPTBOARD_PROJECT_PATH, ''); assert.equal(Object.hasOwn(environment, 'HOME'), false);
  assert.equal(execFileSync('/bin/sh', ['-c', 'printf "%s" "$PROMPTBOARD_TITLE"'], { cwd: dir, env: { ...process.env, ...environment }, encoding: 'utf8' }), title);
  await assert.rejects(access(sentinel));
});

test('invalid or oversized input fails without silent truncation, allocation, or path resolution', () => {
  for (const input of ['x'.repeat(2 * 1024 * 1024 + 1), 'null\0character']) assert.throws(() => renderPipelineTemplate(input, {}), { code: 'INVALID_PIPELINE_TEMPLATE' });
  assert.throws(() => pipelineTemplateVariables({ task: {}, attachmentPaths: ['relative.png'] }), { code: 'INVALID_PIPELINE_TEMPLATE' });
  assert.throws(() => pipelineTemplateVariables({ task: {}, attachmentPaths: [join(tmpdir(), 'x\ny')] }), { code: 'INVALID_PIPELINE_TEMPLATE' });
  assert.throws(() => pipelineTemplateVariables({ task: {}, port: 0 }), { code: 'INVALID_PIPELINE_TEMPLATE' });
  assert.throws(() => renderPipelineTemplate('x', {}, 'shell-with-eval'), { code: 'INVALID_PIPELINE_TEMPLATE' });
  assert.throws(() => renderPipelineTemplate('x', null), { code: 'INVALID_PIPELINE_TEMPLATE' });
  assert.throws(() => pipelineTemplateVariables({ task: { labels: 'broken' } }), { code: 'INVALID_PIPELINE_TEMPLATE' });
  assert.throws(() => pipelineTemplateVariables({ task: { prompt: {} } }), { code: 'INVALID_PIPELINE_TEMPLATE' });
});
