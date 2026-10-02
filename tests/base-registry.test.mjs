import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, STATE_VERSION, emptyState } from '../src/store.mjs';
import { Base, normalizeBinding, listTargets, remapBaseScopes, usedBy } from '../src/base.mjs';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pb-base-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const store = new Store(dir), base = new Base({ store });
  return { dir, store, base };
}
const skill = (name = 'Instructions', body = 'Preserve the public interface.') => ({ kind: 'skill', name, content: { body } });
const binding = resource => ({ mode: 'extend', include: [{ resourceId: resource.id, required: true }], exclude: [] });
async function targets(store) {
  await store.update(state => { state.projects.push({ id: 'p', name: 'Project', revision: 7, tasks: [{ id: 't', title: 'Task', revision: 4, contentRevision: 3, prompt: '  Exact\r\nprompt\n' }], columnLayout: [{ id: 'c_custom1', title: 'Custom', custom: true, agent: { enabled: false } }] }); });
}

test('v2 primary migration preserves exact backup, unknown fields, projects and runs without quarantine', async t => {
  const { dir, store } = await setup(t), original = { ...emptyState(), version: 2, projects: [{ id: 'p', tasks: [] }], runs: [{ id: 'r', status: 'interrupted' }], privateExtension: { preserved: true } };
  delete original.base;
  const bytes = JSON.stringify(original, null, 3); await writeFile(join(dir, 'state.json'), bytes);
  const result = await store.read();
  assert.equal(result.version, STATE_VERSION); assert.deepEqual(result.projects, original.projects); assert.deepEqual(result.runs, original.runs); assert.deepEqual(result.privateExtension, original.privateExtension);
  assert.deepEqual(result.base, { revision: 0, resources: [], approvedRoots: [] });
  const files = await readdir(dir), backup = files.find(name => name.startsWith('state.pre-migration-v2-'));
  assert.ok(backup); assert.equal(await readFile(join(dir, backup), 'utf8'), bytes); assert.equal(files.some(name => name.startsWith('state.corrupt-')), false);
  assert.equal(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).version, STATE_VERSION);
});

test('v2 backup recovery migrates only after validation; newer primary and backup are preserved', async t => {
  const { dir } = await setup(t), backup = { ...emptyState(), version: 2, projects: [{ id: 'keep', tasks: [] }] }; delete backup.base;
  await writeFile(join(dir, 'state.json'), '{broken'); await writeFile(join(dir, 'state.json.bak'), JSON.stringify(backup));
  const recovered = new Store(dir); assert.equal((await recovered.read()).projects[0].id, 'keep'); assert.equal(recovered.recovery.restoredFromBackup, true);
  const future = JSON.stringify({ ...emptyState(), version: 999 });
  await writeFile(join(dir, 'state.json'), future);
  await assert.rejects(new Store(dir).read(), { code: 'STATE_VERSION_UNSUPPORTED' }); assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), future);
  await writeFile(join(dir, 'state.json'), '{broken again'); await writeFile(join(dir, 'state.json.bak'), future);
  await assert.rejects(new Store(dir).read(), { code: 'STATE_VERSION_UNSUPPORTED' });
  assert.equal(await readFile(join(dir, 'state.json.bak'), 'utf8'), future); assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), '{broken again');
});

test('migration write failure does not quarantine valid v2 or substitute empty state', async t => {
  const { dir } = await setup(t), original = JSON.stringify({ ...emptyState(), version: 2, projects: [{ id: 'keep', tasks: [] }] });
  await writeFile(join(dir, 'state.json'), original); await mkdir(join(dir, 'state.json.bak'));
  const store = new Store(dir);
  await assert.rejects(store.read(), { code: 'STATE_MIGRATION_FAILED' }); assert.equal(store.state, null);
  assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), original); assert.equal((await readdir(dir)).some(name => name.startsWith('state.corrupt-')), false);
  await rm(join(dir, 'state.json.bak'), { recursive: true }); assert.equal((await store.read()).projects[0].id, 'keep');
});

test('immutable content precedes registry publication; run polling does not conflict with Base revisions', async t => {
  const { dir, store, base } = await setup(t), resource = await base.create(skill());
  const data = await readFile(join(dir, 'state.json'), 'utf8'); assert.equal(data.includes('Preserve the public interface.'), false);
  assert.equal((await base.detail(resource.id)).content.body, 'Preserve the public interface.');
  const oldRef = resource.revisionRef, rev = (await base.list()).revision;
  await store.update(state => state.runs.push({ id: 'run', status: 'interrupted' }));
  const updated = await base.update(resource.id, { content: { body: 'New instructions.' } }, { expectedRevision: resource.revision, expectedBaseRevision: rev });
  assert.equal(updated.revision, 2); assert.equal((await base.readRevision(oldRef)).content.body, 'Preserve the public interface.');
  await assert.rejects(base.update(resource.id, { name: 'Stale' }, { expectedRevision: 1 }), { code: 'RESOURCE_REVISION_CONFLICT' });
  assert.equal((await new Base({ store: new Store(dir) }).detail(resource.id)).content.body, 'New instructions.');
});

test('content and state write failures never publish missing or partially updated definitions', async t => {
  const { dir, store, base } = await setup(t); await store.read();
  await writeFile(join(dir, 'base'), 'blocks content directory');
  await assert.rejects(base.create(skill())); assert.equal((await base.list()).resources.length, 0);
  await rm(join(dir, 'base')); const resource = await base.create(skill());
  await rm(join(dir, 'state.json.bak'), { force: true }); await mkdir(join(dir, 'state.json.bak'));
  await assert.rejects(base.update(resource.id, { content: { body: 'Unpublished edit' } }, { expectedRevision: 1 }), { code: 'STATE_WRITE_FAILED' });
  assert.equal((await base.detail(resource.id)).revision, 1); assert.equal((await base.detail(resource.id)).content.body, 'Preserve the public interface.');
});

test('graph rejects cycles, missing dependencies and nested packs; skills remain unassigned', async t => {
  const { store, base } = await setup(t), a = await base.create(skill('A')), b = await base.create({ ...skill('B'), dependencies: [{ resourceId: a.id }] });
  await assert.rejects(base.update(a.id, { dependencies: [{ resourceId: b.id }] }, { expectedRevision: a.revision }), { code: 'BASE_DEPENDENCY_CYCLE' });
  await assert.rejects(base.create({ ...skill('Missing'), dependencies: [{ resourceId: 'missing' }] }), { code: 'BASE_DEPENDENCY_MISSING' });
  const pack = await base.create({ kind: 'pack', name: 'Pack', configuration: { resources: [{ resourceId: a.id }] } });
  await assert.rejects(base.create({ kind: 'pack', name: 'Nested', configuration: { resources: [{ resourceId: pack.id }] } }), /cannot contain/);
  const state = await store.read(); assert.equal(state.runs.length, 0); assert.equal(state.settings.baseBinding, undefined);
});

test('atomic multi-target bindings survive inherited providers and never change task text or ordinary revisions', async t => {
  const { store, base } = await setup(t); await targets(store); const resource = await base.create(skill());
  const scopes = [{ scope: 'global' }, { scope: 'project', projectId: 'p' }, { scope: 'column', projectId: 'p', columnId: 'c_custom1' }, { scope: 'task', projectId: 'p', taskId: 't' }, { scope: 'task-column', projectId: 'p', taskId: 't', columnId: 'executing' }];
  const revision = (await base.list()).revision;
  await base.apply({ changes: scopes.map(target => ({ target, binding: binding(resource), expectedRevision: 0 })), expectedBaseRevision: revision });
  const state = await store.read(), project = state.projects[0], task = project.tasks[0];
  assert.equal(project.agentDefaults, undefined); assert.equal(project.revision, 7); assert.equal(task.contentRevision, 3); assert.equal(task.revision, 4); assert.equal(task.prompt, '  Exact\r\nprompt\n');
  assert.equal(project.columnLayout[0].agent.enabled, false); assert.equal(task.baseColumns.executing.binding.include[0].resourceId, resource.id); assert.equal(usedBy(state, resource.id).length, 5);
  await assert.rejects(base.apply({ changes: [{ target: scopes[1], binding: { mode: 'replace' }, expectedRevision: 1 }, { target: scopes[3], binding: { mode: 'replace' }, expectedRevision: 0 }] }), { code: 'BASE_TARGET_REVISION_CONFLICT' });
  assert.equal((await store.read()).projects[0].baseBinding.include[0].resourceId, resource.id);
  assert.equal(listTargets(state).find(scope => scope.target.scope === 'column' && scope.target.columnId === 'c_custom1').inactive, true);
});

test('deletion previews dependencies and Used by; explicit detach preserves historical immutable definitions', async t => {
  const { store, base } = await setup(t); await targets(store); const resource = await base.create(skill()), pack = await base.create({ kind: 'pack', name: 'P', configuration: { resources: [{ resourceId: resource.id }] } });
  await base.apply({ changes: [{ target: { scope: 'project', projectId: 'p' }, binding: binding(resource) }] });
  await store.update(state => state.runs.push({ id: 'old', status: 'succeeded', stage: 'executing', baseManifest: { resources: [{ resourceId: resource.id, revisionRef: resource.revisionRef }] } }));
  await assert.rejects(base.remove(resource.id, { expectedRevision: 1 }), { code: 'BASE_RESOURCE_IN_USE' });
  assert.equal((await base.detail(resource.id)).usedBy.length, 3);
  await base.remove(resource.id, { expectedRevision: 1, detach: true });
  assert.deepEqual((await base.detail(pack.id)).configuration.resources, []); assert.deepEqual((await store.read()).projects[0].baseBinding.include, []);
  assert.equal((await base.readRevision(resource.revisionRef)).content.body, 'Preserve the public interface.');
});

test('active run resource deletion is refused even with detach', async t => {
  const { store, base } = await setup(t), resource = await base.create(skill());
  await store.update(state => state.runs.push({ id: 'active', status: 'queued', stage: 'executing', baseManifest: { resources: [{ resourceId: resource.id }] } }));
  await assert.rejects(base.remove(resource.id, { expectedRevision: 1, detach: true }), { code: 'BASE_RESOURCE_IN_USE' });
});

test('Base export includes dependency closure and optional content; imports remap consistently and remain inactive', async t => {
  const { base } = await setup(t), resource = await base.create(skill()), pack = await base.create({ kind: 'pack', name: 'P', configuration: { resources: [{ resourceId: resource.id, required: false }] } });
  const metadataOnly = await base.export({ ids: [pack.id] }); assert.equal(metadataOnly.resources.length, 2); assert.equal(JSON.stringify(metadataOnly).includes('Preserve the public interface.'), false);
  const bundle = await base.export({ ids: [pack.id], includeContent: true }), preview = await base.previewImport(bundle);
  const imported = await base.import(bundle, { remap: preview.remap, expectedBaseRevision: preview.revision });
  const copy = await base.detail(imported.remap[pack.id]); assert.equal(copy.configuration.resources[0].resourceId, imported.remap[resource.id]); assert.notEqual(copy.id, pack.id);
  for (const item of imported.resources) { assert.equal(item.trust, 'untrusted'); assert.equal(item.enabled, false); }
  assert.equal((await base.detail(imported.remap[resource.id])).content.body, 'Preserve the public interface.');
  assert.throws(() => remapBaseScopes({ baseBinding: binding(resource) }, {}), /missing/);
  assert.equal(remapBaseScopes({ baseBinding: binding(resource) }, imported.remap).baseBinding.include[0].resourceId, imported.remap[resource.id]);
  const omitted = await base.import(metadataOnly); assert.equal((await base.detail(omitted.remap[resource.id])).contentStatus, 'omitted');
});

test('prepared Base import can publish atomically with portable board bindings and rejects intervening edits', async t => {
  const { store, base } = await setup(t), resource = await base.create(skill()), bundle = await base.export({ includeContent: true });
  const prepared = await base.prepareImport(bundle);
  await store.update(state => { base.publishPreparedImport(state, prepared); state.projects.push({ id: 'portable', name: 'Portable', tasks: [], ...remapBaseScopes({ baseBinding: binding(resource) }, prepared.remap) }); });
  assert.equal((await store.read()).projects[0].baseBinding.include[0].resourceId, prepared.remap[resource.id]);
  const stale = await base.prepareImport(bundle); await base.create(skill('Intervening'));
  await assert.rejects(store.update(state => base.publishPreparedImport(state, stale)), { code: 'BASE_REVISION_CONFLICT' });
});

test('MCP definitions retain reference-only credentials and explicit discovery identities', async t => {
  const { base } = await setup(t);
  await assert.rejects(base.create({ kind: 'mcp', name: 'Secret', configuration: { transport: 'streamable-http', endpoint: 'https://example.com/mcp?token=secret' } }), /credentials/);
  await assert.rejects(base.create({ kind: 'mcp', name: 'Secret', configuration: { command: 'node', env: { API_KEY: 'abc-secret-value' } } }), /references/);
  const server = await base.create({ kind: 'mcp', name: 'Local test', configuration: { transport: 'stdio', command: 'node', args: ['-e', 'x', '-e', 'x'], env: { API_KEY: 'MY_MCP_KEY' } } });
  assert.equal(server.trust, 'untrusted'); assert.deepEqual(server.configuration.args, ['-e', 'x', '-e', 'x']);
  await assert.rejects(base.create({ kind: 'tool', name: 'Invented', configuration: { delivery: 'mcp', serverId: server.id, toolName: 'invented' } }), { code: 'BASE_TOOL_NOT_DISCOVERED' });
  const tested = await base.recordConnectionTest(server.id, { status: 'connected', tools: [{ name: 'lookup' }], resources: [], prompts: [], durationMs: 1, server: { name: 'fixture', version: '1' } }, { expectedRevision: server.revision });
  const tool = await base.create({ kind: 'tool', name: 'Lookup', configuration: { delivery: 'mcp', serverId: server.id, toolName: 'lookup' } });
  assert.equal(tool.configuration.serverId, server.id); assert.equal(tested.connectionTest.testedRevision, tested.revision);
  const exported = JSON.stringify(await base.export()); assert.ok(exported.includes('MY_MCP_KEY')); assert.equal(exported.includes('connectionTest'), false);
});

test('SKILL.md imports validate frontmatter and supporting file containment without executing anything', async t => {
  const { base } = await setup(t);
  await assert.rejects(base.importSkill({ markdown: 'Missing frontmatter' }), /frontmatter/);
  await assert.rejects(base.importSkill({ markdown: '---\nname: skill\ndescription: Useful\n---\nDo it.', files: [{ path: '../outside', text: 'x' }] }), /relative paths/);
  await assert.rejects(base.importSkill({ markdown: '---\nname: skill\ndescription: Useful\n---\nDo it.', files: [{ path: '.env', text: 'secret' }] }), /Secret files/);
  const imported = await base.importSkill({ markdown: '---\nname: example\ndescription: Reusable directions\n---\nNever run scripts on import.', files: [{ path: 'scripts/check.js', text: 'throw new Error("must never execute");' }] });
  assert.equal(imported.enabled, false); assert.equal(imported.trust, 'untrusted'); assert.equal((await base.detail(imported.id)).content.files.length, 2);
});

test('knowledge revisions preserve exact Markdown, linked pages and bounded source provenance', async t => {
  const { base } = await setup(t), hash = 'a'.repeat(64);
  const resource = await base.create({ kind: 'knowledge', name: 'Wiki', configuration: { sources: [{ kind: 'repository', path: 'docs' }] }, content: { pages: [{ id: 'a', title: 'A', markdown: '<script>example()</script>\n', links: ['b'], provenance: { generatedAt: 123, sourceIds: ['source'], sources: [{ id: 'source', path: 'docs/a.md', hash }] } }, { id: 'b', title: 'B', markdown: 'Manual' }] } });
  const detail = await base.detail(resource.id); assert.equal(detail.content.pages[0].markdown, '<script>example()</script>\n'); assert.equal(detail.content.pages[0].provenance.sources[0].hash, hash); assert.equal(detail.configuration.sources[0].path, 'docs');
  const update = await base.update(resource.id, { content: { ...detail.content, pages: detail.content.pages.map(page => page.id === 'b' ? { ...page, markdown: 'Manual edit' } : page) } }, { expectedRevision: resource.revision });
  assert.equal((await base.detail(resource.id, { revision: 1 })).content.pages[1].markdown, 'Manual'); assert.equal(update.revision, 2);
});

test('binding validation enforces explicit modes, stable references and task-column provider independence', async t => {
  const { store, base } = await setup(t); await targets(store);
  assert.throws(() => normalizeBinding({ mode: 'inherit', include: ['x'] }), /Inherit/);
  assert.deepEqual(normalizeBinding({ mode: 'replace' }), { mode: 'replace', include: [], exclude: [] });
  await assert.rejects(base.apply({ changes: [{ target: { scope: 'task-column', projectId: 'p', taskId: 't', columnId: 'executing' }, binding: { mode: 'inherit' }, profileId: 'p' }] }), /do not change provider/);
  await assert.rejects(base.apply({ changes: [
    { target: { scope: 'project', projectId: 'p' }, binding: { mode: 'replace' }, expectedRevision: 0 },
    { target: { projectId: 'p', scope: 'project' }, binding: { mode: 'extend' }, expectedRevision: 1 },
  ] }), /only once/);
  assert.equal((await store.read()).projects[0].baseBinding, undefined, 'Duplicate targets roll back the entire update.');
});

test('external roots need explicit approval, can be revoked, and never survive resource import as access grants', async t => {
  const { base, dir } = await setup(t);
  await assert.rejects(base.approveRoot(dir), { code: 'CONFIRMATION_REQUIRED' });
  await assert.rejects(base.approveRoot('/' + 'a'.repeat(4096), { confirm: true }), { code: 'BASE_INVALID_INPUT' });
  await assert.rejects(base.approveRoot(join(dir, 'absent'), { confirm: true }), { code: 'BASE_ROOT_UNAVAILABLE' });
  const root = await base.approveRoot(dir, { confirm: true });
  const resource = await base.create({ kind: 'context', name: 'Approved files', configuration: { sources: [{ kind: 'external', rootId: root.id, path: '.' }] } });
  const imported = await base.import(await base.export({ ids: [resource.id] }));
  const copy = await base.detail(imported.remap[resource.id]); assert.notEqual(copy.configuration.sources[0].rootId, root.id);
  const before = await base.list(); await assert.rejects(base.revokeRoot(root.id, { expectedBaseRevision: before.revision - 1 }), { code: 'BASE_REVISION_CONFLICT' });
  await base.revokeRoot(root.id, { expectedBaseRevision: before.revision }); assert.equal((await base.list()).approvedRoots.length, 0);
});

test('pending imported references and active profile snapshots protect deletion', async t => {
  const { store, base } = await setup(t), resource = await base.create(skill()), profile = await base.create({ kind: 'profile', name: 'P', configuration: { agent: { provider: 'codex' } } });
  await store.update(state => { state.settings.pendingBaseImport = { baseBinding: binding(resource) }; state.runs.push({ id: 'running-profile', status: 'queued', stage: 'executing', baseManifest: { profiles: [{ resourceId: profile.id }] } }); });
  await assert.rejects(base.remove(resource.id, { expectedRevision: 1 }), { code: 'BASE_RESOURCE_IN_USE' });
  await base.remove(resource.id, { expectedRevision: 1, detach: true }); assert.deepEqual((await store.read()).settings.pendingBaseImport.baseBinding.include, []);
  await assert.rejects(base.remove(profile.id, { expectedRevision: 1, detach: true }), { code: 'BASE_RESOURCE_IN_USE' });
});

test('configuration-only resource exports remain complete when document content is excluded', async t => {
  const { base } = await setup(t), server = await base.create({ kind: 'mcp', name: 'Remote', configuration: { transport: 'streamable-http', endpoint: 'https://example.com/mcp' } });
  const result = await base.import(await base.export({ ids: [server.id] }));
  assert.equal((await base.detail(result.remap[server.id])).contentStatus, 'available');
});

test('packs cannot hide nested containers through member dependencies or later edits', async t => {
  const { base } = await setup(t);
  const profile = await base.create({ kind: 'profile', name: 'Agent', configuration: { agent: { provider: 'codex' } } });
  const dependent = await base.create({ ...skill('Dependent'), dependencies: [{ resourceId: profile.id }] });
  await assert.rejects(base.create({ kind: 'pack', name: 'Hidden profile', configuration: { resources: [{ resourceId: dependent.id }] } }), /including through dependencies/);
  const ordinary = await base.create(skill('Ordinary')), pack = await base.create({ kind: 'pack', name: 'Valid pack', configuration: { resources: [{ resourceId: ordinary.id }] } });
  await assert.rejects(base.update(ordinary.id, { dependencies: [{ resourceId: dependent.id }] }, { expectedRevision: ordinary.revision }), /including through dependencies/);
  const packDependent = await base.create({ ...skill('Pack dependent'), dependencies: [{ resourceId: pack.id }] });
  await assert.rejects(base.create({ kind: 'pack', name: 'Hidden pack', configuration: { resources: [{ resourceId: packDependent.id }] } }), /including through dependencies/);
});

test('large bounded definitions remain readable with metadata overhead included in the immutable limit', async t => {
  const { base } = await setup(t);
  const resource = await base.create({ kind: 'mcp', name: 'Large definition', configuration: { command: 'node', args: Array.from({ length: 100 }, () => 'a'.repeat(4000)) },
    content: { sources: Array.from({ length: 15 }, (_, i) => ({ id: `source_${i}`, name: `Source ${i}`, text: 't'.repeat(256 * 1024) })) } });
  const definition = await base.detail(resource.id); assert.equal(definition.content.sources.length, 15); assert.equal(definition.configuration.args.length, 100);
});


test('explicit library type maps Agents to existing profiles and preserves legacy immutable revisions', async t => {
  const { base, store } = await setup(t);
  const profile = await base.create({ type: 'agent', name: 'Engineer', configuration: { agent: {}, binding: { mode: 'inherit' } } });
  assert.equal(profile.kind, 'profile'); assert.equal(profile.type, 'agent');
  assert.equal((await store.read()).base.resources[0].type, 'agent');
  const instruction = await base.create(skill()); assert.equal(instruction.type, 'skill');
  await assert.rejects(base.create({ ...skill(), type: 'agent' }), /must match/);
  await store.update(state => { delete state.base.resources[0].type; });
  assert.equal((await base.list()).resources[0].type, 'agent', 'Legacy stored kind remains the explicit source of type.');
  assert.equal((await base.readRevision(profile.revisionRef)).type, 'agent');
});
