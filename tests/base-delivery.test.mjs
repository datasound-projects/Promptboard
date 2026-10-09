import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { resolveBase, profileDefaults, checkBaseRevocations, deliveryFor } from '../src/base-resolver.mjs';
import { prepareBase, captureSources, searchSources, fetchDocument, isPublicAddress } from '../src/base-context.mjs';
import { testMcp, CONTEXT7_PRESET } from '../src/base-mcp.mjs';
import { buildSession, composeMessage, resolveConfig, ARGV_PROMPT_LIMIT } from '../src/agents.mjs';

const resource = (id, kind = 'skill', configuration = {}) => ({ id, kind, name: id, revision: 1, revisionRef: { id, revision: 1, hash: 'a'.repeat(64) }, enabled: true, trust: 'trusted', configuration, dependencies: [], content: { body: `Instructions ${id}` } });
const binding = (include = [], mode = 'extend', exclude = []) => ({ mode, include: include.map(value => typeof value === 'string' ? { resourceId: value, required: true } : value), exclude });
const stateWith = (...resources) => ({ base: { revision: 1, resources }, settings: {} });
const preview = (state, project = {}, task = {}, columnId = 'executing', provider = 'claude') => resolveBase({ state, project, task, columnId, provider });
async function directory(t) { const dir = await mkdtemp(join(tmpdir(), 'pb-base-delivery-')); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 })); return dir; }

test('Base bindings resolve stable scopes, packs, opt-out, re-addition and requirement overrides', () => {
  const a = resource('a'), b = resource('b'), c = resource('c'), pack = resource('pack', 'pack', { resources: binding(['a', 'b']).include });
  const state = stateWith(a, b, c, pack); state.settings.baseBinding = binding(['pack']);
  const project = { id: 'p', baseBinding: binding(['c'], 'extend', ['b']), baseColumns: { custom_a: { binding: binding([{ resourceId: 'b', required: false }]) } } };
  assert.deepEqual(preview(state, project, {}, 'custom_a').resources.map(r => [r.resourceId, r.required]), [['pack', true], ['a', true], ['c', true], ['b', false]]);
  assert.equal(preview(state, project, { baseBinding: binding([], 'replace') }).resources.length, 0);
  assert.deepEqual(preview(state, project, { id: 't', baseBinding: binding([], 'replace'), baseColumns: { executing: { binding: binding(['b']) } } }).resources.map(r => r.resourceId), ['b']);
  assert.deepEqual(preview(state, {}, { baseBinding: binding([], 'extend', ['pack']) }).resources, []);
  assert.equal(preview(stateWith(a), {}, {}).resources.length, 0, 'unassigned projects receive nothing');
});

test('attached profiles expand their resources and nested profiles use bounded native Claude definitions', async t => {
  const dir = await directory(t), skill = resource('skill');
  const child = resource('child', 'profile', { agent: { provider: 'claude', model: 'custom-claude-model', instructions: 'SPECIALIST INSTRUCTIONS' }, binding: binding(['skill']) });
  const parent = resource('parent', 'profile', { agent: { provider: 'claude', instructions: 'MAIN INSTRUCTIONS' }, binding: binding(['child']) });
  const state = stateWith(skill, child, parent), project = { id: 'p', agentProfileId: parent.id };
  const manifest = preview(state, project); assert.equal(manifest.errors.length, 0);
  assert.equal(manifest.resources.find(resource => resource.resourceId === child.id).delivery, 'native-subagent');
  const definitions = new Map([skill, child, parent].map(resource => [resource.id, resource]));
  const prepared = await prepareBase({ manifest, currentResources: state.base.resources, readRevision: async ref => structuredClone(definitions.get(ref.id)), runDir: dir });
  assert.match(prepared.subagents.pb_child.prompt, /SPECIALIST INSTRUCTIONS/); assert.match(prepared.subagents.pb_child.prompt, /Instructions skill/);
  assert.equal(prepared.subagents.pb_child.model, 'custom-claude-model'); assert.equal('permissionMode' in prepared.subagents.pb_child, false);
  const session = await buildSession({ provider: 'claude', stage: 'executing', config: resolveConfig('executing', { provider: 'claude' }), message: 'Exact task', runDir: dir, eventsFile: join(dir, 'events'), sessionId: 'session', baseDelivery: prepared });
  assert.deepEqual(JSON.parse(session.args[session.args.indexOf('--agents') + 1]), prepared.subagents);
  assert.equal(prepared.manifest.observed.length, 0); assert.equal(prepared.manifest.supplied.find(resource => resource.resourceId === child.id).delivery, 'native-subagent');
  assert.match(await readFile(join(dir, 'base-context/child.txt'), 'utf8'), /Instructions skill/);
  for (const provider of ['codex', 'gemini']) {
    const incompatible = preview(state, project, {}, 'executing', provider);
    assert.ok(incompatible.errors.some(error => /Native Base subagents/.test(error.message)));
    assert.equal(incompatible.resources.some(resource => resource.resourceId === skill.id), false, 'An omitted native profile does not supply its resources through the main agent.');
  }
  assert.equal(preview(state, project, { baseBinding: binding([], 'replace') }).resources.length, 0);
  assert.ok(preview(state, project, {}, 'planning').errors.some(error => /Native Base subagents/.test(error.message)));
  await prepared.cleanup();
});

test('Base dependencies do not re-add exclusions and converge required status across shared dependencies', () => {
  const a = resource('a'), b = resource('b'), c = resource('c'); a.dependencies = [{ resourceId: 'b', required: false }]; b.dependencies = [{ resourceId: 'c', required: false }];
  const state = stateWith(a, b, c); state.settings.baseBinding = binding([{ resourceId: 'b', required: false }, 'a']);
  assert.equal(preview(state).resources.find(r => r.resourceId === 'c').required, true);
  const result = preview(state, { baseBinding: binding([], 'extend', ['b']) });
  assert.ok(result.errors.some(error => /excluded/.test(error.message))); assert.ok(!result.resources.some(r => r.resourceId === 'b'));
  assert.equal(preview(state, { baseBinding: binding([{ resourceId: 'b', required: false }]) }).resources.find(r => r.resourceId === 'b').required, false);
  c.dependencies = [{ resourceId: 'a', required: true }]; assert.ok(preview(state).errors.some(error => error.code === 'BASE_CYCLE'));
});

test('Same-scope pack and explicit requirements combine independently of selection order', () => {
  const child = resource('child');
  const requiredPack = resource('required-pack', 'pack', { resources: [{ resourceId: 'child', required: true }] });
  const optionalPack = resource('optional-pack', 'pack', { resources: [{ resourceId: 'child', required: false }] });
  const required = { resourceId: requiredPack.id, required: false }, optional = { resourceId: optionalPack.id, required: false }, direct = { resourceId: child.id, required: false };
  for (const selection of [[required, direct], [direct, required], [required, optional], [optional, required]]) {
    const state = stateWith(child, requiredPack, optionalPack); state.settings.baseBinding = binding(selection);
    assert.equal(preview(state).resources.find(entry => entry.resourceId === child.id).required, true);
    assert.equal(preview(state, { baseBinding: binding([direct]) }).resources.find(entry => entry.resourceId === child.id).required, false, 'A more-specific explicit selection may lower the inherited requirement.');
  }
});

test('Disabled and untrusted optional packs omit their contents while independent selections remain deliverable', () => {
  const child = resource('child'), pack = resource('pack', 'pack', { resources: [{ resourceId: 'child', required: true }] });
  for (const unavailable of [{ enabled: false }, { trust: 'untrusted' }, { trust: 'revoked' }]) {
    const state = stateWith(child, { ...pack, ...unavailable }); state.settings.baseBinding = binding([{ resourceId: 'pack', required: false }]);
    const onlyPack = preview(state); assert.deepEqual(onlyPack.resources.map(entry => entry.resourceId), ['pack']); assert.equal(onlyPack.errors.length, 0); assert.ok(onlyPack.warnings.length);
    const independent = preview(state, { baseBinding: binding(['child']) }); assert.equal(independent.resources.find(entry => entry.resourceId === 'child').status, 'ready');
  }
  const declared = stateWith(child, pack); declared.settings.baseBinding = binding([{ resourceId: 'pack', required: false }]);
  assert.equal(preview(declared).resources.find(entry => entry.resourceId === 'child').required, true, 'Declared member requirements persist when an available pack expands.');
  const disabledSkill = { ...resource('disabled'), enabled: false, dependencies: [{ resourceId: 'child', required: true }] };
  const dormant = stateWith(child, disabledSkill); dormant.settings.baseBinding = binding([{ resourceId: 'disabled', required: false }]);
  assert.deepEqual(preview(dormant).resources.map(entry => entry.resourceId), ['disabled'], 'An omitted resource does not expose dependencies solely on its behalf.');
  assert.equal(preview(dormant, { baseBinding: binding([{ resourceId: 'child', required: false }]) }).resources.find(entry => entry.resourceId === 'child').required, false);
});

test('Profile defaults preserve provider tuples; profile resources and instructions respect later replacement', () => {
  const skill = resource('skill'), profile = resource('profile', 'profile', { agent: { provider: 'codex', model: 'custom', effort: 'high', instructions: 'Profile instruction' }, binding: binding(['skill'], 'replace') });
  const state = stateWith(skill, profile); state.settings.agentProfileId = profile.id;
  assert.deepEqual(profileDefaults(state, profile.id, { provider: 'claude' }), { provider: 'claude', model: '', effort: '', permissionMode: '', instructions: 'Profile instruction' });
  assert.deepEqual(preview(state).resources.map(r => r.resourceId), ['skill', 'profile']);
  assert.equal(preview(state, { baseBinding: binding([], 'replace') }).resources.length, 0);
  const optedOut = preview(state, {}, { baseBinding: binding([], 'replace') });
  assert.equal(optedOut.profiles[0].resourceId, profile.id);
  assert.throws(() => checkBaseRevocations(optedOut, [{ ...profile, trust: 'revoked' }, skill]), { code: 'BASE_REVOKED' });
  profile.enabled = false;
  assert.equal(profileDefaults(state, profile.id).provider, 'codex');
  assert.ok(preview(state, {}, { baseBinding: binding([], 'replace') }).errors.some(error => error.code === 'BASE_PROFILE_UNAVAILABLE'));
});

test('Provider changes retain selections with truthful permission and optional delivery diagnostics', () => {
  const mcp = resource('mcp', 'mcp', { transport: 'stdio', command: 'unused', args: [] });
  const state = stateWith(mcp); state.settings.baseBinding = binding(['mcp']);
  assert.ok(preview(state, {}, {}, 'planning').errors.length);
  assert.ok(preview(state, {}, {}, 'executing', 'agy').errors.length);
  assert.equal(preview(state, {}, {}, 'executing', 'codex').resources[0].resourceId, 'mcp');
  for (const provider of ['claude', 'codex', 'gemini']) assert.ok(preview(state, {}, {}, 'executing', provider).warnings.some(w => w.code === 'BASE_AMBIENT_CONFIGURATION'));
  state.settings.baseBinding = binding([{ resourceId: 'mcp', required: false }]);
  const optional = preview(state, {}, {}, 'code_review'); assert.equal(optional.errors.length, 0); assert.ok(optional.warnings.length); assert.equal(optional.resources[0].status, 'omitted');
});

test('Portable preparation pins instructions, exact prompt/evidence, concurrent contexts, and revocations', async t => {
  const dir = await directory(t), a = resource('a'), b = resource('b'), state = stateWith(a, b);
  const first = preview(state, { baseBinding: binding(['a']) }), second = preview(state, { baseBinding: binding(['b']) });
  const readRevision = async ref => ({ ...resource(ref.id), content: { body: `PINNED ${ref.id}` } });
  const [x, y] = await Promise.all([prepareBase({ manifest: first, readRevision, currentResources: [a, b], runDir: join(dir, 'one') }), prepareBase({ manifest: second, readRevision, currentResources: [a, b], runDir: join(dir, 'two') })]);
  assert.match(x.sections, /PINNED a/); assert.doesNotMatch(x.sections, /PINNED b/); assert.match(y.sections, /PINNED b/);
  const prompt = '  exact\r\n@file\n' + 'x'.repeat(ARGV_PROMPT_LIMIT);
  const message = composeMessage('executing', prompt, 'approved', 'stage', 'evidence', x.sections);
  assert.ok(message.includes(`=== TASK (exact text from the card) ===\n${prompt}\n=== END TASK ===`)); assert.match(message, /approved/); assert.match(message, /evidence/);
  const session = await buildSession({ provider: 'claude', stage: 'executing', config: resolveConfig('executing'), message, runDir: dir, eventsFile: 'events', sessionId: 'session' }); assert.equal(session.paste, message);
  assert.ok(x.manifest.supplied[0].contentHash); await x.cleanup(); assert.ok(await stat(join(dir, 'one', x.manifest.supplied[0].contextRef)));
  assert.throws(() => checkBaseRevocations(first, [{ ...a, trust: 'revoked' }]), { code: 'BASE_REVOKED' });
  a.revision = 2; a.revisionRef.revision = 2; assert.equal(first.resources[0].revision, 1); assert.equal(first.resources[0].revisionRef.revision, 1, 'references are copied, not aliases');
});

test('Native MCP delivery preserves adapter hooks, permissions and secret references', async t => {
  const dir = await directory(t);
  const baseDelivery = { mcpServers: [{ name: 'pb_docs', required: true, configuration: { transport: 'streamable-http', endpoint: 'https://example.com/mcp', headers: { Authorization: 'BASE_TEST_AUTH' } } }] };
  for (const provider of ['claude', 'codex', 'gemini']) {
    const built = await buildSession({ provider, stage: 'executing', config: resolveConfig('executing', { provider }), message: 'exact', runDir: dir, eventsFile: 'events', sessionId: 's', baseDelivery });
    assert.doesNotMatch(JSON.stringify(built), /bypassPermissions|yolo|danger-full-access/);
    if (provider === 'claude') { assert.equal(built.args.includes('--strict-mcp-config'), false); assert.match(await readFile(built.args[built.args.indexOf('--mcp-config') + 1], 'utf8'), /\$\{BASE_TEST_AUTH\}/); assert.match(built.args[built.args.indexOf('--settings') + 1], /SessionStart/); }
    if (provider === 'codex') { assert.ok(built.args.includes('--sandbox')); assert.ok(built.args.some(arg => arg.includes('env_http_headers'))); assert.ok(built.args.some(arg => arg.startsWith('notify='))); }
    if (provider === 'gemini') { const config = JSON.parse(await readFile(built.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, 'utf8')); assert.equal(config.mcpServers.pb_docs.trust, false); assert.ok(config.hooks.BeforeAgent); assert.equal(built.args.includes('--allowed-mcp-server-names'), false); }
    const restricted = await buildSession({ provider, stage: 'planning', config: resolveConfig('planning', { provider }), message: 'exact', runDir: dir, eventsFile: 'events', sessionId: 's', baseDelivery });
    assert.doesNotMatch(JSON.stringify(restricted.args), /pb_docs/);
  }
});

test('Kanban writing launches and resumes inherit CLI tools alongside Base without changing configured policy', async t => {
  const dir = await directory(t), settingsPath = join(dir, 'administrator.json');
  const original = JSON.stringify({ mcpServers: { ambient: { command: 'user-configured-server' } }, security: { allowedExtensions: ['trusted-extension'] }, mcp: { excluded: ['blocked-server'] }, hooks: { BeforeAgent: [{ hooks: [{ type: 'command', command: 'existing-hook' }] }] } });
  await writeFile(settingsPath, original);
  const previous = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
  process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = settingsPath;
  t.after(() => { if (previous === undefined) delete process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH; else process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = previous; });
  const baseDelivery = { mcpServers: [{ name: 'pb_docs', configuration: { transport: 'stdio', command: 'base-server', args: [] } }], subagents: { specialist: { description: 'Base specialist', prompt: 'Review invariants' } } };
  for (const provider of ['claude', 'codex', 'gemini']) for (const stage of ['executing', 'testing', 'merge', 'planning', 'code_review']) for (const resumeId of [null, 'captured-conversation']) {
    const readOnly = ['planning', 'code_review'].includes(stage);
    const built = await buildSession({ provider, stage, config: resolveConfig(stage, { provider }), message: '', runDir: dir, eventsFile: 'events', sessionId: 'new-id', resumeId, workspacePath: dir, baseDelivery });
    assert.doesNotMatch(JSON.stringify(built.args), /dangerously|bypassPermissions|yolo|danger-full-access/);
    if (provider === 'claude') {
      assert.equal(built.args.includes('--strict-mcp-config'), readOnly);
      assert.equal(built.args[built.args.indexOf('--permission-mode') + 1], readOnly ? 'plan' : 'acceptEdits');
      const native = JSON.parse(await readFile(built.args[built.args.indexOf('--mcp-config') + 1], 'utf8').catch(() => built.args[built.args.indexOf('--mcp-config') + 1]));
      assert.deepEqual(Object.keys(native.mcpServers), readOnly ? [] : ['pb_docs']);
      assert.equal(built.args.includes('--agents'), !readOnly);
      if (!readOnly) assert.deepEqual(JSON.parse(built.args[built.args.indexOf('--agents') + 1]), baseDelivery.subagents);
    } else if (provider === 'gemini') {
      assert.equal(built.args.includes('--extensions'), readOnly);
      assert.equal(built.args.includes('--allowed-mcp-server-names'), readOnly);
      if (readOnly) assert.equal(built.args[built.args.indexOf('--allowed-mcp-server-names') + 1], '');
      const settings = JSON.parse(await readFile(built.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, 'utf8'));
      assert.deepEqual(settings.mcpServers.ambient, { command: 'user-configured-server' });
      assert.deepEqual(settings.mcp, { excluded: ['blocked-server'] });
      assert.deepEqual(settings.security, { allowedExtensions: ['trusted-extension'] });
      assert.equal(settings.hooks.BeforeAgent[0].hooks[0].command, 'existing-hook');
      assert.equal(Boolean(settings.mcpServers.pb_docs), !readOnly);
    } else {
      assert.equal(built.args[built.args.indexOf('--sandbox') + 1], readOnly ? 'read-only' : 'workspace-write');
      assert.equal(built.args.some(arg => arg.includes('mcp_servers.')), !readOnly);
    }
  }
  assert.equal(await readFile(settingsPath, 'utf8'), original, 'Administrator settings must remain byte-for-byte unchanged.');
  for (const provider of ['claude', 'gemini']) {
    const built = await buildSession({ provider, stage: 'executing', config: resolveConfig('executing', { provider }), message: 'Exact task', runDir: dir, eventsFile: 'events', sessionId: 'new' });
    assert.equal(built.args.includes('--mcp-config'), false);
    assert.equal(built.args.includes('--allowed-mcp-server-names'), false);
    assert.equal(built.args.includes('--extensions'), false);
  }
});

test('Source capture uses workspace path, checks approved roots and symlinks, and bounded lexical selection', async t => {
  const root = await directory(t), work = join(root, 'workspace'), outside = join(root, 'outside'); await mkdir(work); await mkdir(outside);
  await writeFile(join(work, 'guide.md'), '# Guide\nUseful repository context'); await writeFile(join(work, '.env'), 'SECRET'); await writeFile(join(outside, 'escape.md'), 'EXTERNAL');
  const def = resource('context', 'context', { sources: [{ kind: 'repository', path: '.' }] });
  const capture = await captureSources(def, { workspacePath: work }); assert.deepEqual(capture.sources.map(s => s.name), ['guide.md']); assert.ok(capture.omitted.includes('.env'));
  assert.ok(searchSources(capture.sources, 'Useful').selected[0].text.includes('Useful'));
  assert.ok(capture.sources[0].provenance.contentHash);
  const external = resource('external', 'context', { sources: [{ kind: 'external', rootId: 'root', path: 'escape.md' }] });
  await assert.rejects(captureSources(external, { approvedRoots: [] }), { code: 'BASE_ROOT_NOT_APPROVED' });
  assert.equal((await captureSources(external, { approvedRoots: [{ id: 'root', path: outside }] })).sources[0].text, 'EXTERNAL');
  if (process.platform !== 'win32') { await symlink(join(outside, 'escape.md'), join(work, 'linked.md')); await assert.rejects(captureSources(def, { workspacePath: work }), { code: 'BASE_SOURCE_FORBIDDEN' }); }
  await assert.rejects(captureSources(resource('context', 'context', { sources: [{ kind: 'repository', path: '../outside' }] }), { workspacePath: work }), { code: 'BASE_SOURCE_FORBIDDEN' });
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fc00::1']) assert.equal(isPublicAddress(address), false, address);
  await assert.rejects(fetchDocument('https://example.com', { lookupFn: async () => [{ address: '127.0.0.1', family: 4 }] }), { code: 'BASE_PRIVATE_NETWORK' });
  await assert.rejects(fetchDocument('http://user:secret@example.com'), { code: 'BASE_INVALID_URL' });
});

test('MCP explicit discovery initializes real stdio protocol, is trust gated, bounded and cancellable', async () => {
  const server = fileURLToPath(new URL('./fixtures/base-mcp-server.mjs', import.meta.url));
  const def = resource('mcp', 'mcp', { transport: 'stdio', command: process.execPath, args: [server] });
  const result = await testMcp(def); assert.equal(result.status, 'connected'); assert.deepEqual(result.tools, [{ name: 'read_document' }]); assert.equal(result.resources[0].name, 'Guide');
  await assert.rejects(testMcp({ ...def, trust: 'untrusted' }), { code: 'BASE_UNTRUSTED' });
  await assert.rejects(testMcp({ ...def, configuration: { ...def.configuration, args: [server, 'hang'] } }, { timeoutMs: 100 }), { code: 'ABORTED' });
  await assert.rejects(testMcp({ ...def, configuration: { ...def.configuration, args: [server, 'flood'] } }, { timeoutMs: 3000 }), error => ['ABORTED', 'BASE_MCP_FAILED'].includes(error.code));
  assert.equal(CONTEXT7_PRESET.enabled, false); assert.equal(CONTEXT7_PRESET.configuration.endpoint, 'https://mcp.context7.com/mcp');
});

test('MCP Streamable HTTP local fixture initializes/discovers and rejects auth without leaking headers', async t => {
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' || req.method === 'DELETE') { res.writeHead(405).end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const message = JSON.parse(Buffer.concat(chunks));
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    const echo = req.url === '/reflect' ? req.headers.authorization : '';
    const result = message.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: echo || 'http-fixture', version: echo || '1' } } : { tools: [{ name: echo || 'http_tool', inputSchema: { type: 'object' } }] };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const def = resource('http', 'mcp', { transport: 'streamable-http', endpoint: `http://127.0.0.1:${server.address().port}/mcp`, headers: { Authorization: 'MCP_TEST_SECRET' } });
  const result = await testMcp(def, { environment: { MCP_TEST_SECRET: 'test-secret-value' } }); assert.deepEqual(result.tools, [{ name: 'http_tool' }]); assert.doesNotMatch(JSON.stringify(result), /test-secret-value/);
  await assert.rejects(testMcp(def, { environment: {} }), { code: 'BASE_AUTH_REQUIRED' });
  const reflected = await testMcp({ ...def, configuration: { ...def.configuration, endpoint: def.configuration.endpoint.replace('/mcp', '/reflect') } }, { environment: { MCP_TEST_SECRET: 'test-secret-value' } });
  assert.doesNotMatch(JSON.stringify(reflected), /test-secret-value/, 'Malicious server names, versions, and tool identities cannot reflect declared credentials.');
});

test('MCP discovery cleans up its own descendants and leaves another process alone', async t => {
  if (process.platform === 'win32') { t.skip('POSIX process-group verification; Windows taskkill path is covered by CI only.'); return; }
  const dir = await directory(t), pidFile = join(dir, 'child-pid');
  const server = fileURLToPath(new URL('./fixtures/base-mcp-server.mjs', import.meta.url));
  const result = await testMcp(resource('mcp', 'mcp', { transport: 'stdio', command: process.execPath, args: [server, 'child', pidFile] }));
  assert.equal(result.status, 'connected');
  const pid = Number(await readFile(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'The server descendant exited with its discovery process group.');
  assert.doesNotThrow(() => process.kill(process.pid, 0), 'The application/test process remains alive.');
});

test('Preparation cancellation and optional dependency failures do not supply partial dependent instructions', async t => {
  const dir = await directory(t), a = resource('a'), b = resource('b'); a.dependencies = [{ resourceId: 'b', required: true }];
  const state = stateWith(a, b); const manifest = preview(state, { baseBinding: binding([{ resourceId: 'a', required: false }, { resourceId: 'b', required: false }]) });
  // Make dependency optional at a more-specific explicit scope.
  const optional = preview(state, { baseBinding: binding([{ resourceId: 'a', required: false }]) }, { baseBinding: binding([{ resourceId: 'b', required: false }]) });
  const prepared = await prepareBase({ manifest: optional, currentResources: [a, b], readRevision: async ref => { if (ref.id === 'b') throw new Error('private failure text'); return a; }, runDir: dir });
  assert.equal(prepared.sections, ''); assert.equal(prepared.manifest.supplied.length, 0); assert.doesNotMatch(JSON.stringify(prepared.manifest), /private failure/);
  const controller = new AbortController();
  const pending = prepareBase({ manifest, currentResources: [a, b], readRevision: async () => new Promise(() => {}), runDir: dir, signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { code: 'ABORTED' });
});

test('Knowledge page selection and configured retrieval query constrain captured source sections', async t => {
  const dir = await directory(t), wiki = resource('wiki', 'knowledge'); wiki.content = { body: 'collection body', pages: [{ id: 'one', title: 'One', markdown: 'unrelated material' }, { id: 'two', title: 'Two', markdown: 'selected needle' }] };
  const ctx = resource('context', 'context', { sources: [{ kind: 'knowledge', resourceId: 'wiki', pageId: 'two' }], query: 'needle', budgetChars: 1000 });
  const captured = await captureSources(ctx, { resources: [wiki], readRevision: async () => wiki });
  assert.equal(captured.sources.length, 1);
  assert.equal(captured.sources[0].provenance.section, 'two');
  assert.equal(captured.sources[0].provenance.resourceId, wiki.id);
  const state = stateWith(wiki, ctx), manifest = preview(state, { baseBinding: binding(['context']) });
  const delivery = await prepareBase({ manifest, currentResources: [wiki, ctx], readRevision: async ref => ref.id === 'wiki' ? wiki : ctx, runDir: dir });
  assert.match(delivery.sections, /selected needle/);
  assert.doesNotMatch(delivery.sections, /unrelated material|collection body/, 'A knowledge dependency supplies only the context rule’s selected page.');
  const limited = searchSources([{ id: 'too-large', text: 'x'.repeat(2_000_001) }, { id: 'small', text: 'usable needle' }], 'needle');
  assert.equal(limited.selected[0].sourceId, 'small'); assert.equal(limited.omitted[0].sourceId, 'too-large');
});

test('Missing Base budget never truncates the original prompt, and explicit unsupported Codex aliases diagnose correctly', async t => {
  const dir = await directory(t), skill = resource('large'); skill.content.body = 'x'.repeat(60000);
  const state = stateWith(skill), manifest = preview(state, { baseBinding: binding(['large']) });
  await assert.rejects(prepareBase({ manifest, currentResources: [skill], readRevision: async () => skill, runDir: dir, contextBudget: 1000 }), { code: 'BASE_CONTEXT_BUDGET' });
  const mcp = resource('alias', 'mcp', { transport: 'stdio', command: 'unused', env: { SERVER_KEY: 'SOURCE_KEY' } });
  const alias = preview(stateWith(mcp), { baseBinding: binding(['alias']) }, {}, 'executing', 'codex');
  assert.match(alias.errors[0].message, /aliases are unsupported/);
  assert.equal(preview(stateWith(mcp), { baseBinding: binding(['alias']) }, {}, 'executing', 'claude').errors.length, 0);
});

test('Failed preparation removes partial captures while successful run evidence survives ordinary cleanup', async t => {
  const dir = await directory(t), first = resource('first'), second = resource('second'); second.content.body = 'x'.repeat(5000);
  const manifest = preview(stateWith(first, second), { baseBinding: binding(['first', 'second']) });
  await assert.rejects(prepareBase({ manifest, currentResources: [first, second], readRevision: async ref => ref.id === first.id ? first : second, runDir: dir, contextBudget: 1000 }), { code: 'BASE_CONTEXT_BUDGET' });
  await assert.rejects(stat(join(dir, 'base-context')), { code: 'ENOENT' }, 'Capture written before the second failure was removed.');
  const okay = await prepareBase({ manifest: preview(stateWith(first), { baseBinding: binding(['first']) }), currentResources: [first], readRevision: async () => first, runDir: dir });
  await okay.cleanup(); assert.ok(await stat(join(dir, 'base-context', 'first.txt')));
  await okay.cleanup({ discardCaptures: true }); await assert.rejects(stat(join(dir, 'base-context')), { code: 'ENOENT' });
});

test('Document redirects revalidate public DNS, pin connections, and bound DNS cancellation', async () => {
  let lookups = 0, requests = 0;
  const lookupFn = async () => (++lookups === 1 ? [{ address: '1.1.1.1', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
  const requestFn = (_url, options, callback) => {
    requests++; options.lookup('ignored-rebind-host', { all: false }, (error, address) => { assert.equal(error, null); assert.equal(address, '1.1.1.1'); });
    const request = new EventEmitter(); request.end = () => queueMicrotask(() => callback({ statusCode: 302, headers: { location: 'http://localhost/private' }, resume() {} })); return request;
  };
  await assert.rejects(fetchDocument('https://public.example/doc', { lookupFn, requestFn }), { code: 'BASE_PRIVATE_NETWORK' });
  assert.equal(requests, 1); assert.equal(lookups, 2);
  await assert.rejects(fetchDocument('https://public.example/doc', { lookupFn: async () => [{ address: '1.1.1.1', family: 4 }], requestFn: (_url, _options, callback) => { const request = new EventEmitter(); request.end = () => queueMicrotask(() => callback({ statusCode: 302, headers: {}, resume() {} })); return request; } }), { code: 'BASE_HTTP_ERROR' });
  const controller = new AbortController(); const pending = fetchDocument('https://public.example/doc', { signal: controller.signal, lookupFn: async () => new Promise(() => {}) }); controller.abort(); await assert.rejects(pending, { code: 'ABORTED' });
  assert.equal(isPublicAddress('::ffff:7f00:1'), false);
});

test('Base MCP is withheld from Planning and Code Review only on legacy boards; pipeline columns receive it', () => {
  const mcp = { kind: 'mcp', configuration: { transport: 'stdio', env: {} } };
  for (const column of ['planning', 'code_review']) {
    assert.match(deliveryFor(mcp, 'claude', column, null, false).issue, /unavailable in read-only Planning and Code Review/);
    assert.deepEqual(deliveryFor(mcp, 'claude', column, null, true), { delivery: 'native-mcp' });
  }
});
