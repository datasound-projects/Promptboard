import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveWorkflow } from '../src/board.mjs';
import { defaultPipelineConfig } from '../src/pipeline-config.mjs';

// One agent tuple per level on a column pipeline: a column's model pin never mixes with a Base profile's provider.
test('a pipeline column\'s model and effort pins apply to its own or the inherited agent, never to a Base column profile', () => {
  const state = { settings: {}, base: { resources: [{ id: 'p1', kind: 'profile', enabled: true, trust: 'trusted', configuration: { agent: { provider: 'codex', model: 'gpt-5', effort: 'low' } } }] } };
  const pipeline = defaultPipelineConfig();
  Object.assign(pipeline.columns.find(column => column.id === 'executing').strategy, { modelOverride: 'claude-opus-4', effortOverride: 'minimal' });
  const columns = (project, task) => effectiveWorkflow({ workflowMode: 'pipeline', pipeline, ...project }, null, state, task).executing;
  const pick = settings => [settings.provider, settings.model, settings.effort];
  assert.deepEqual(pick(columns({ baseColumns: { executing: { profileId: 'p1' } } })), ['codex', 'gpt-5', 'low'], 'the profile brings its own tuple');
  assert.deepEqual(pick(columns({ agentDefaults: { provider: 'claude' } })), ['claude', 'claude-opus-4', ''], 'the pins apply to the inherited project agent; an effort Claude rejects is dropped');
  pipeline.columns.find(column => column.id === 'executing').strategy.agentOverride = 'codex';
  assert.deepEqual(pick(columns({ baseColumns: { executing: { profileId: 'p1' } } })), ['codex', 'claude-opus-4', 'minimal'], 'the column\'s own agent takes its pins');
});

test('a required Base MCP server on a typed Planning or Code Review column is reported as unavailable, not as supplied', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const { Board } = await import('../src/board.mjs');
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-ro-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const board = new Board({ dataDir });
  const project = await board.createProject({ name: 'Typed', workflowMode: 'pipeline' });
  const mcp = await board.base.create({ kind: 'mcp', name: 'Docs server', enabled: true, trust: 'trusted', configuration: { transport: 'stdio', command: process.execPath, args: ['--version'] } });
  await board.base.apply({ changes: [{ target: { scope: 'project', projectId: project.id }, binding: { mode: 'extend', include: [{ resourceId: mcp.id, required: true }], exclude: [] } }], expectedBaseRevision: (await board.state()).base.revision });
  for (const columnId of ['planning', 'code_review']) {
    const { manifest } = await board.previewBase({ target: { scope: 'column', projectId: project.id, columnId } });
    assert.match(manifest.errors.map(error => error.message || error).join(' '), /unavailable in read-only Planning and Code Review/, columnId);
  }
  const { manifest } = await board.previewBase({ target: { scope: 'column', projectId: project.id, columnId: 'executing' } });
  assert.deepEqual(manifest.errors, []);
  assert.ok(manifest.resources.some(resource => resource.resourceId === mcp.id && resource.delivery === 'native-mcp'));
});
