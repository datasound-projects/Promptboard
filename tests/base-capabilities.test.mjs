import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeAgentContract, validateAgentOutput, contractRequirements } from '../src/base-agent-contract.mjs';
import { normalizeResource, normalizeReferences } from '../src/base.mjs';
import { resolveBase, deliveryFor } from '../src/base-resolver.mjs';
import { prepareBase } from '../src/base-context.mjs';
import { mcpToolAllowed, supportsClaudeMcpPolicy } from '../src/base-tool-guard.mjs';
import { baseObservation } from '../src/base-observations.mjs';
import { buildSession, resolveConfig } from '../src/agents.mjs';

const resource = (id, kind, configuration = {}, content = { body: 'Reviewed instructions' }) => ({ id, name: id, kind, enabled: true, trust: 'trusted', revision: 1, revisionRef: { id, revision: 1, hash: 'a'.repeat(64) }, dependencies: [], configuration, content });
const stateWith = (...resources) => ({ base: { resources, revision: 1 }, settings: {} });
const manifestFor = (state, profileId = 'agent', provider = 'claude') => resolveBase({ state, project: { id: 'project', agentProfileId: profileId }, task: {}, columnId: 'executing', provider });
async function folder(t) { const path = await mkdtemp(join(tmpdir(), 'pb-base-capabilities-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }

test('portable contracts preserve existing agents and reject unsupported or malformed requirements', () => {
  assert.equal(normalizeAgentContract(undefined), undefined);
  const old = normalizeResource({ kind: 'profile', name: 'Old agent', configuration: { agent: { provider: 'codex' } } });
  assert.equal(Object.hasOwn(old.configuration, 'contract'), false);
  for (const contract of [{ tools: ['Bash'] }, { version: 2 }, { memory: { agent: 'yes' } }, { runtime: { targets: [] } }, { runtime: { timeoutMinutes: 0 } }, { runtime: { contextChars: 999 } }, { output: { format: 'xml' } }, { output: { format: 'text', schema: {} } }, { output: { format: 'json', schema: { $ref: 'https://evil.example/schema' } } }, { output: { format: 'json', schema: JSON.parse('{"properties":{"__proto__":{}}}') } }, { evaluations: [{ name: 'Missing question' }] }]) assert.throws(() => normalizeAgentContract(contract), { code: 'BASE_CONTRACT_INVALID' });
  const c = { version: 1, output: { format: 'json', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } }, runtime: { targets: ['network'], timeoutMinutes: 2 }, memory: { agent: false } };
  for (const kind of ['profile', 'agentProfile']) assert.deepEqual(normalizeResource({ kind, name: 'Requirements', configuration: { contract: c } }).configuration.contract, c);
});

test('JSON checks enforce structure, exact phrases, bounds and poison-key safety without claiming semantic truth', () => {
  const c = { output: { format: 'json', schema: { type: 'object', properties: { summary: { type: 'string', minLength: 3, maxLength: 20 }, scores: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'integer', minimum: 1, maximum: 5 } }, status: { enum: ['ok', 'failed'] } }, required: ['summary', 'scores', 'status'], additionalProperties: false } }, checks: { contains: ['summary'], excludes: ['invented'] } };
  assert.equal(validateAgentOutput('{"summary":"done","scores":[1,5],"status":"ok"}', [c]).passed, true);
  for (const answer of ['```json\n{}\n```', '{}', '{"summary":"no","scores":[0,6,1.5],"status":"other","extra":true}', '{"summary":"invented","scores":[1],"status":"ok"}', '{"summary":"done","scores":[1],"status":"ok","__proto__":{"admin":true}}']) assert.equal(validateAgentOutput(answer, [c]).passed, false, answer);
  assert.deepEqual(validateAgentOutput('', []), { passed: true, errors: [] });
  assert.equal(validateAgentOutput(null, [c]).passed, false);
  assert.equal(validateAgentOutput('x'.repeat(500001), [c]).passed, false);
  assert.equal({}.admin, undefined);
  assert.equal(validateAgentOutput('{"b":2,"a":1}', [{ output: { format: 'json', schema: { const: { a: 1, b: 2 } } } }]).passed, true, 'JSON object member order does not change equality.');
  assert.equal(validateAgentOutput('"🙂"', [{ output: { format: 'json', schema: { type: 'string', minLength: 1, maxLength: 1 } } }]).passed, true, 'Schema text lengths count Unicode characters.');
  for (const schema of [{ type: 'number', minimum: 2, maximum: 1 }, { enum: [() => {}] }, { const: new Date() }]) assert.throws(() => normalizeAgentContract({ output: { format: 'json', schema } }), { code: 'BASE_CONTRACT_INVALID' });
});

test('policy composition only narrows target, memory, context and time; resolution pins the primary and profile requirements', () => {
  const a = { runtime: { timeoutMinutes: 10, contextChars: 3000, targets: ['kanban'] }, memory: { agent: false } }, b = { runtime: { timeoutMinutes: 2, contextChars: 5000, targets: ['kanban', 'network'] }, memory: { network: false }, mcpMode: 'base-only' };
  assert.deepEqual(contractRequirements([a, b]), { timeoutMs: 120000, contextChars: 3000, targets: ['kanban'], memory: { agent: false, network: false, projectLessons: true }, mcpMode: 'base-only' });
  const state = stateWith(resource('agent', 'profile', { contract: a }), resource('team', 'agentProfile', { agents: [{ resourceId: 'agent', role: 'primary' }], contract: b }));
  assert.equal(manifestFor(state, 'team').requirements.timeoutMs, 120000);
  assert.equal(manifestFor(state, 'team').contracts.length, 2);
  state.base.resources[0].configuration.contract.runtime.targets = ['network'];
  assert.ok(manifestFor(state, 'team').errors.some(e => e.code === 'BASE_TARGET_UNAVAILABLE'));
});

test('MCP selections survive normalization, intersect inheritance, respect server switches, and reject new or colliding tools', () => {
  assert.deepEqual(normalizeReferences([{ resourceId: 'mcp', allowedTools: [] }]), [{ resourceId: 'mcp', required: true, allowedTools: [] }]);
  const server = resource('mcp', 'mcp', { transport: 'streamable-http', endpoint: 'https://example.com/mcp', disabledTools: ['write'] }); server.connectionTest = { status: 'connected', tools: [{ name: 'read' }, { name: 'write' }] };
  const agent = resource('agent', 'profile', { binding: { mode: 'extend', include: [{ resourceId: 'mcp', required: true, allowedTools: ['read', 'write'] }] }, contract: { mcpMode: 'base-only' } });
  const state = stateWith(server, agent); state.settings.baseBinding = { mode: 'extend', include: [{ resourceId: 'mcp', allowedTools: ['read'] }] };
  let manifest = manifestFor(state); assert.deepEqual(manifest.resources.find(e => e.kind === 'mcp').allowedTools, ['read']); assert.equal(manifest.warnings.some(e => e.code === 'BASE_AMBIENT_CONFIGURATION'), false);
  agent.configuration.binding.include[0].allowedTools.push('new'); assert.ok(manifestFor(state).errors.length === 0, 'A narrower inherited allowlist stays narrow.');
  delete state.settings.baseBinding; assert.ok(manifestFor(state).errors.some(e => /not in the last connection test/.test(e.message)));
  server.connectionTest.tools.push({ name: 'read.x' }, { name: 'read_x' }); assert.ok(manifestFor(state).errors.some(e => /collide/.test(e.message)));
});

test('deny-only hooks reject unknown tools, empty selections and malformed input without approving allowed tools', async t => {
  const policy = { mode: 'base-only', servers: [{ name: 'pb_docs', allowedTools: ['lookup.page'] }, { name: 'pb_empty', allowedTools: [] }] };
  assert.equal(mcpToolAllowed('mcp__pb_docs__lookup_page', policy, 'claude'), true);
  for (const tool of ['mcp__pb_docs__write', 'mcp__pb_empty__read', 'mcp__ambient__read']) assert.equal(mcpToolAllowed(tool, policy, 'claude'), false);
  assert.equal(mcpToolAllowed('Read', policy, 'claude'), true);
  assert.equal(mcpToolAllowed('mcp_pb_docs_lookup.page', policy, 'gemini'), true);
  const path = join(await folder(t), 'policy.json'); const { writeFile } = await import('node:fs/promises'); await writeFile(path, JSON.stringify(policy));
  const hook = fileURLToPath(new URL('../src/base-tool-guard.mjs', import.meta.url));
  const run = input => spawnSync(process.execPath, [hook, path, 'claude'], { input, encoding: 'utf8' });
  assert.equal(run('{"tool_name":"mcp__pb_docs__lookup_page"}').stdout, '');
  for (const input of ['bad json', '{"tool_name":"mcp__pb_docs__write"}', '{}']) { const r = run(input); assert.equal(r.status, 2); assert.match(r.stderr, /outside the Base/); assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny'); }
});

test('native skill packages are isolated per run, strip imported policy frontmatter, and retain supporting files on demand', async t => {
  const path = await folder(t), runDir = join(path, 'run'); await mkdir(runDir);
  const skill = resource('skill', 'skill', { format: 'native-package', entrypoint: 'SKILL.md' }, { body: '---\nallowed-tools: Bash\nhooks: unsafe\n---\nDo reviewed work.', files: [{ path: 'references/guide.md', text: 'SUPPORTING FILE' }, { path: 'skill.md', text: 'must not replace frontmatter' }] });
  assert.ok(deliveryFor(skill, 'codex', 'executing').issue); assert.ok(deliveryFor(skill, 'claude', 'planning').issue); assert.equal(deliveryFor(skill, 'claude', 'executing').issue, undefined);
  const state = stateWith(skill, resource('agent', 'profile', { binding: { mode: 'extend', include: [{ resourceId: 'skill', required: true }] } }));
  const manifest = manifestFor(state), delivery = await prepareBase({ manifest, currentResources: state.base.resources, runDir, workspacePath: path, readRevision: async ref => structuredClone(state.base.resources.find(r => r.id === ref.id)) });
  assert.equal(delivery.nativeSkills.length, 1); assert.doesNotMatch(delivery.sections, /SUPPORTING FILE/);
  const plugin = delivery.nativeSkills[0].path, { readdir } = await import('node:fs/promises'), name = (await readdir(join(plugin, 'skills')))[0];
  assert.doesNotMatch(await readFile(join(plugin, 'skills', name, 'SKILL.md'), 'utf8'), /allowed-tools|hooks:|must not replace/);
  assert.equal(await readFile(join(plugin, 'skills', name, 'references/guide.md'), 'utf8'), 'SUPPORTING FILE');
  const built = await buildSession({ provider: 'claude', stage: 'executing', config: resolveConfig('executing', { provider: 'claude' }), message: 'test', runDir, eventsFile: join(runDir, 'events'), sessionId: 'session', baseDelivery: delivery });
  assert.equal(built.args[built.args.indexOf('--plugin-dir') + 1], plugin);
  await delivery.cleanup(); await assert.rejects(access(plugin));
  state.base.resources[1].configuration.binding.include[0].required = false;
  const omitted = await prepareBase({ manifest: manifestFor(state), currentResources: state.base.resources, contextBudget: 0, runDir, workspacePath: path, readRevision: async ref => structuredClone(state.base.resources.find(r => r.id === ref.id)) });
  assert.equal(omitted.manifest.resources.find(entry => entry.resourceId === 'skill').status, 'omitted'); assert.deepEqual(omitted.nativeSkills, [], 'An omitted optional package is never passed to the CLI.'); await omitted.cleanup();
});

test('failed optional MCP preparation supplies no partial credentials, and colliding native server identities block', async t => {
  const path = await folder(t), server = resource('mcp', 'mcp', { transport: 'stdio', command: 'fixture', env: { FIRST: 'FIRST', SECOND: 'SECOND' } });
  const state = stateWith(server); state.settings.baseBinding = { mode: 'extend', include: [{ resourceId: server.id, required: false }] };
  const manifest = resolveBase({ state, project: {}, task: {}, provider: 'claude', columnId: 'executing' });
  const delivery = await prepareBase({ manifest, currentResources: state.base.resources, runDir: path, readRevision: async () => structuredClone(server), connections: { delivery: async definition => ({ definition, environment: { FIRST: 'PARTIAL_PRIVATE_SECRET' } }) } });
  assert.deepEqual(delivery.environment, {}); assert.deepEqual(delivery.mcpServers, []); assert.equal(delivery.manifest.resources[0].status, 'omitted');
  const a = resource('a-b', 'mcp', { transport: 'stdio', command: 'a' }), b = resource('a_b', 'mcp', { transport: 'stdio', command: 'b' });
  const collision = stateWith(a, b); collision.settings.baseBinding = { mode: 'extend', include: [a, b].map(item => ({ resourceId: item.id, required: true })) };
  const blocked = resolveBase({ state: collision, project: {}, task: {}, provider: 'claude', columnId: 'executing' }); assert.equal(blocked.resources.every(item => item.status === 'omitted'), true); assert.ok(blocked.errors.some(error => /identifiers collide/.test(error.message)));
});

test('observations map only supplied MCP hook identities, never tool contents or a pre-use attempt', () => {
  const manifest = { resources: [{ resourceId: 'docs', kind: 'mcp', status: 'ready' }], supplied: [{ resourceId: 'docs' }] };
  const event = { provider: 'claude', name: 'PostToolUse', tool: 'mcp__pb_docs__lookup', input: { secret: 'private' }, result: 'private' };
  assert.deepEqual(baseObservation(manifest, 'claude', event), { resourceId: 'docs', toolName: event.tool, provider: 'claude', source: 'PostToolUse' });
  for (const override of [{ name: 'PreToolUse' }, { activityUncertain: true }, { tool: 'mcp__ambient__lookup' }, { provider: 'codex' }]) assert.equal(baseObservation(manifest, 'claude', { ...event, ...override }), null);
  assert.equal(baseObservation({ ...manifest, supplied: [] }, 'claude', event), null);
});

test('MCP policy adapters retain lifecycle hooks, never put credentials in arguments, and require supported isolation', async t => {
  for (const version of ['2.1.295 (Claude Code)', '2.2.0', '3.0.0']) assert.equal(supportsClaudeMcpPolicy(version), true);
  for (const version of ['', '2.1.294', '2.0.999', '2.1.295-beta']) assert.equal(supportsClaudeMcpPolicy(version), false);
  const path = await folder(t);
  const delivery = { manifest: { requirements: { mcpMode: 'base-only' } }, environment: { PRIVATE_HEADER_REFERENCE: 'Bearer NEVER_IN_ARGUMENTS' }, mcpServers: [{ name: 'pb_docs', required: true, allowedTools: ['read'], disabledTools: ['write'], configuration: { transport: 'streamable-http', endpoint: 'https://example.com/mcp', headers: { Authorization: 'PRIVATE_HEADER_REFERENCE' } } }] };
  const build = (provider, baseDelivery = delivery) => buildSession({ provider, stage: 'executing', config: resolveConfig('executing', { provider }), message: 'A task', runDir: path, eventsFile: join(path, 'events'), sessionId: 'session', baseDelivery });
  const claude = await build('claude'), settings = JSON.parse(claude.args[claude.args.indexOf('--settings') + 1]);
  assert.ok(claude.args.includes('--strict-mcp-config')); assert.ok(settings.hooks.Stop.length); assert.ok(settings.hooks.PostToolUse.length);
  const guard = settings.hooks.PreToolUse.at(-1).hooks[0]; assert.equal(guard.onFailure, 'block'); assert.ok(guard.args.includes('claude'));
  await assert.rejects(build('codex'), { code: 'BASE_MCP_ISOLATION_UNAVAILABLE' });
  const codex = await build('codex', { ...delivery, mcpIsolationChecked: true, mcpIsolationArgs: ['-c', 'mcp_servers.ambient.enabled=false'] });
  assert.match(codex.args.join(' '), /mcp_servers\.pb_docs\.enabled_tools=\["read"\]/); assert.match(codex.args.join(' '), /mcp_servers\.pb_docs\.enabled=true/); assert.ok(codex.args.includes('mcp_servers.ambient.enabled=false'));
  const gemini = await build('gemini'), config = JSON.parse(await readFile(gemini.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, 'utf8'));
  assert.deepEqual(config.mcpServers.pb_docs.includeTools, ['read']); assert.deepEqual(config.mcpServers.pb_docs.excludeTools, ['write']); assert.equal(config.mcpServers.pb_docs.trust, false); assert.ok(gemini.args.includes('--extensions')); assert.ok(config.hooks.BeforeTool.length);
  for (const result of [claude, codex, gemini]) { assert.doesNotMatch(JSON.stringify(result.args), /NEVER_IN_ARGUMENTS/); assert.equal(result.env.PRIVATE_HEADER_REFERENCE, 'Bearer NEVER_IN_ARGUMENTS'); }
  const empty = await build('codex', { ...delivery, mcpIsolationChecked: true, mcpServers: [{ ...delivery.mcpServers[0], allowedTools: [] }] }); assert.ok(empty.args.includes('mcp_servers.pb_docs.enabled_tools=[]'));
});
