// Agent Profiles, Custom MD files and per-assignment switches: shared resources referenced (never copied), switched
// off for one profile without touching another, delivered per CLI with switched-off MCP tools withheld, Markdown sent
// only where it is active, project versions of shared files, and importing what people already have.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Base, normalizeReferences } from '../src/base.mjs';
import { Store } from '../src/store.mjs';
import { resolveBase, profileDefaults } from '../src/base-resolver.mjs';
import { prepareBase } from '../src/base-context.mjs';
import { buildSession, resolveConfig } from '../src/agents.mjs';
import { markdownFileName, markdownConvention, markdownFrontmatter, normalizeActivation, scanRepository, deployToRepository } from '../src/base-markdown.mjs';
import { parseMcpConfig, mcpResourceFrom } from '../src/base-mcp-import.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const resource = (id, kind = 'skill', configuration = {}, extra = {}) => ({ id, kind, name: id, revision: 1, revisionRef: { id, revision: 1, hash: 'a'.repeat(64) }, enabled: true, trust: 'trusted', configuration, dependencies: [], content: { body: `Body of ${id}` }, ...extra });
const state = (...resources) => ({ base: { revision: 1, resources }, settings: {} });
async function temp(t) { const dir = await realpath(await mkdtemp(join(tmpdir(), 'pb-base-profiles-'))); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })); return dir; }

test('references keep their old shape and gain a per-assignment switch and switched-off tools', () => {
  assert.deepEqual(normalizeReferences(['a', { resourceId: 'b', required: false }]), [{ resourceId: 'a', required: true }, { resourceId: 'b', required: false }]);
  assert.deepEqual(normalizeReferences([{ resourceId: 'm', enabled: false, disabledTools: ['delete_repo', 'delete_repo'] }]), [{ resourceId: 'm', required: true, enabled: false, disabledTools: ['delete_repo'] }]);
  assert.throws(() => normalizeReferences([{ resourceId: 'm', enabled: 'no' }]), /on\/off switch/);
});

test('an agent profile runs as its primary agent with its resources; supporting agents become subagents; switches are per profile', () => {
  const lead = resource('lead', 'profile', { agent: { provider: 'claude', model: 'opus', instructions: 'Lead the research.' }, binding: { mode: 'extend', include: [{ resourceId: 'notes', required: true }], exclude: [] } });
  const reviewer = resource('reviewer', 'profile', { agent: { provider: 'claude', instructions: 'Review it.' }, binding: { mode: 'inherit', include: [], exclude: [] } });
  const github = resource('github', 'mcp', { transport: 'stdio', command: 'gh-mcp', args: [], env: {}, headers: {}, disabledTools: ['delete_repo'] });
  const style = resource('style', 'skill'), notes = resource('notes', 'knowledge');
  const research = resource('research', 'agentProfile', { instructions: 'Cite official sources.', agents: [{ resourceId: 'lead', role: 'primary', responsibility: '' }, { resourceId: 'reviewer', role: 'supporting', responsibility: 'Checks every claim' }],
    resources: [{ resourceId: 'github', required: true, disabledTools: ['create_issue'] }, { resourceId: 'style', required: true, enabled: false }] });
  const writing = resource('writing', 'agentProfile', { instructions: '', agents: [{ resourceId: 'lead', role: 'primary', responsibility: '' }], resources: [{ resourceId: 'github', required: true }, { resourceId: 'style', required: true }] });
  const registry = state(lead, reviewer, github, style, notes, research, writing);
  // Defaults: the primary agent's provider and model, with the profile's instructions after the agent's own.
  assert.deepEqual(profileDefaults(registry, 'research'), { provider: 'claude', model: 'opus', instructions: 'Lead the research.\n\nCite official sources.' });
  const one = resolveBase({ state: registry, project: { id: 'p1', agentProfileId: 'research' }, task: {}, columnId: 'executing', provider: 'claude' });
  assert.deepEqual(one.errors, []);
  const byId = id => one.resources.find(entry => entry.resourceId === id);
  assert.deepEqual(byId('github').disabledTools.sort(), ['create_issue', 'delete_repo'], 'switched off on the server and for this profile');
  assert.equal(byId('style'), undefined, 'switched off for this profile');
  assert.ok(one.exclusions.some(entry => entry.resourceId === 'style' && entry.reason === 'disabled-here'));
  assert.deepEqual([byId('reviewer').delivery, byId('reviewer').responsibility], ['native-subagent', 'Checks every claim']);
  assert.equal(byId('notes').status, 'ready', 'the primary agent’s own resources come along');
  assert.deepEqual(one.profiles.map(entry => entry.resourceId), ['research', 'lead'], 'the profile and its primary agent are pinned for revocation checks');
  // The same shared skill stays on in another profile; switching it off globally stops it everywhere.
  const two = resolveBase({ state: registry, project: { id: 'p2', agentProfileId: 'writing' }, task: {}, columnId: 'executing', provider: 'claude' });
  assert.equal(two.resources.find(entry => entry.resourceId === 'style').status, 'ready');
  assert.deepEqual(two.resources.find(entry => entry.resourceId === 'github').disabledTools, ['delete_repo']);
  const off = state(lead, reviewer, github, { ...style, enabled: false }, notes, research, writing);
  assert.match(resolveBase({ state: off, project: { id: 'p2', agentProfileId: 'writing' }, task: {}, columnId: 'executing', provider: 'claude' }).errors[0].message, /disabled/);
  // Codex has no native subagents: the supporting agent is kept but reported, not pretended.
  const codex = resolveBase({ state: registry, project: { id: 'p1', agentProfileId: 'research' }, task: {}, columnId: 'executing', provider: 'codex' });
  assert.match(codex.resources.find(entry => entry.resourceId === 'reviewer').issues.join(' '), /supported only by Claude Code/);
  // Without a primary agent the profile cannot run.
  const headless = state(reviewer, resource('team', 'agentProfile', { instructions: '', agents: [{ resourceId: 'reviewer', role: 'supporting', responsibility: '' }], resources: [] }));
  assert.equal(resolveBase({ state: headless, project: { id: 'p', agentProfileId: 'team' }, task: {}, columnId: 'executing', provider: 'claude' }).errors[0].code, 'BASE_PROFILE_NO_PRIMARY');
});

test('Markdown files are sent only where active; a project version replaces the shared file in that project only', () => {
  const shared = resource('agents', 'markdown', { fileName: 'AGENTS.md', activation: { mode: 'always', projectIds: [], stages: [], providers: [] } });
  const testing = resource('testing-rules', 'markdown', { fileName: 'TESTING.md', activation: { mode: 'stages', projectIds: [], stages: ['testing'], providers: [] } });
  const manual = resource('deep', 'markdown', { fileName: 'RESEARCH.md', activation: { mode: 'manual', projectIds: [], stages: [], providers: [] } });
  const mine = resource('agents-p1', 'markdown', { fileName: 'AGENTS.md', activation: { mode: 'always', projectIds: [], stages: [], providers: [] }, override: { of: 'agents', projectId: 'p1' } });
  const registry = state(shared, testing, manual, mine);
  const include = ids => ({ mode: 'extend', include: ids.map(resourceId => ({ resourceId, required: true })), exclude: [] });
  const run = (projectId, columnId, task = {}) => resolveBase({ state: registry, project: { id: projectId, baseBinding: include(['agents', 'testing-rules', 'deep']) }, task, columnId, provider: 'claude' });
  const ready = manifest => manifest.resources.filter(entry => entry.status === 'ready').map(entry => entry.resourceId).sort();
  assert.deepEqual(ready(run('p2', 'executing')), ['agents']);
  assert.deepEqual(ready(run('p2', 'testing')), ['agents', 'testing-rules']);
  assert.deepEqual(run('p2', 'executing').warnings, [], 'an inactive file is not a warning');
  assert.deepEqual(ready(run('p2', 'executing', { id: 't', baseBinding: include(['deep']) })), ['agents', 'deep'], 'On demand: sent when attached to the task');
  const p1 = run('p1', 'executing');
  assert.deepEqual([ready(p1), p1.resources.find(entry => entry.resourceId === 'agents-p1').overrides], [['agents-p1'], 'agents']);
});

test('switched-off MCP tools are withheld by each CLI; Markdown is delivered as prompt text under its file name', async t => {
  const dir = await temp(t);
  const github = resource('github', 'mcp', { transport: 'stdio', command: 'gh-mcp', args: [], env: {}, headers: {}, disabledTools: ['delete_repo'] });
  const agents = resource('agents', 'markdown', { fileName: 'AGENTS.md', activation: { mode: 'always', projectIds: [], stages: [], providers: [] } }, { content: { body: '# Rules\nRun the tests.' } });
  const registry = state(github, agents);
  const definitions = new Map([github, agents].map(entry => [entry.id, entry]));
  for (const provider of ['claude', 'codex', 'gemini']) {
    const manifest = resolveBase({ state: registry, project: { id: 'p', baseBinding: { mode: 'extend', include: [{ resourceId: 'github', required: true, disabledTools: ['push'] }, { resourceId: 'agents', required: true }], exclude: [] } }, task: {}, columnId: 'executing', provider });
    const prepared = await prepareBase({ manifest, currentResources: registry.base.resources, readRevision: async ref => structuredClone(definitions.get(ref.id)), runDir: join(dir, provider) });
    assert.match(prepared.sections, /File AGENTS\.md:\n# Rules\nRun the tests\./);
    const session = await buildSession({ provider, stage: 'executing', config: resolveConfig('executing', { provider }), message: 'task', runDir: join(dir, provider), eventsFile: 'events', sessionId: 's', baseDelivery: prepared });
    const joined = session.args.join(' ');
    if (provider === 'claude') assert.match(joined, /--disallowedTools \S*mcp__pb_github__delete_repo,mcp__pb_github__push/);
    if (provider === 'codex') assert.match(joined, /mcp_servers\.pb_github\.disabled_tools=\["delete_repo","push"\]/);
    if (provider === 'gemini') assert.deepEqual(JSON.parse(await readFile(session.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, 'utf8')).mcpServers.pb_github.excludeTools, ['delete_repo', 'push']);
  }
});

test('a switched-off MCP tool whose name has a dot is disallowed under the name Claude Code gives it', async t => {
  const dir = await temp(t), docs = resource('docs', 'mcp', { transport: 'stdio', command: 'docs-mcp', args: [], env: {}, headers: {}, disabledTools: ['docs.delete'] });
  const registry = state(docs), manifest = resolveBase({ state: registry, project: { id: 'p', baseBinding: { mode: 'extend', include: [{ resourceId: 'docs', required: true }], exclude: [] } }, task: {}, columnId: 'executing', provider: 'claude' });
  const prepared = await prepareBase({ manifest, currentResources: registry.base.resources, readRevision: async () => structuredClone(docs), runDir: dir });
  const args = (await buildSession({ provider: 'claude', stage: 'executing', config: resolveConfig('executing', { provider: 'claude' }), message: 'task', runDir: dir, eventsFile: 'events', sessionId: 's', baseDelivery: prepared })).args;
  assert.match(args[args.indexOf('--disallowedTools') + 1], /(?:^|,)mcp__pb_docs__docs_delete(?:,|$)/, 'Claude Code replaces the dot with _ in the tool name');
  // The per-run MCP configuration is temporary: the run's cleanup removes it. (resolve: on Windows the run path keeps a forward slash.)
  assert.equal(resolve(args[args.indexOf('--mcp-config') + 1]), join(dir, 'base-claude-mcp.json')); await readFile(join(dir, 'base-claude-mcp.json'));
  await prepared.cleanup(); await assert.rejects(readFile(join(dir, 'base-claude-mcp.json')), { code: 'ENOENT' });
});

test('an agent profile delivers its primary agent’s own instructions, and the primary’s nested agents stay subagents', async t => {
  const helper = resource('helper', 'profile', { agent: { instructions: 'Help with tests.' }, binding: { mode: 'inherit', include: [], exclude: [] } });
  const lead = resource('lead', 'profile', { agent: { provider: 'claude', instructions: 'LEAD OWN INSTRUCTIONS' }, binding: { mode: 'extend', include: [{ resourceId: 'helper', required: false }], exclude: [] } });
  const team = resource('team', 'agentProfile', { instructions: 'PROFILE INSTRUCTIONS', agents: [{ resourceId: 'lead', role: 'primary', responsibility: '' }], resources: [] });
  const registry = state(helper, lead, team), definitions = new Map(registry.base.resources.map(entry => [entry.id, entry]));
  const manifest = resolveBase({ state: registry, project: { id: 'p', agentProfileId: 'team' }, task: {}, columnId: 'executing', provider: 'claude' });
  assert.deepEqual(manifest.errors, []);
  assert.equal(manifest.resources.find(entry => entry.resourceId === 'helper').delivery, 'native-subagent', 'as when the agent is assigned directly');
  const prepared = await prepareBase({ manifest, currentResources: registry.base.resources, readRevision: async ref => structuredClone(definitions.get(ref.id)), runDir: await temp(t) });
  assert.match(prepared.sections, /LEAD OWN INSTRUCTIONS[\s\S]*PROFILE INSTRUCTIONS/, 'the agent’s instructions, then the profile’s');
  assert.deepEqual(Object.keys(prepared.subagents), ['pb_helper']);
});

test('Markdown names, conventions, frontmatter and activation are checked', () => {
  assert.equal(markdownFileName('.github/instructions/api.instructions.md'), '.github/instructions/api.instructions.md');
  for (const bad of ['/etc/AGENTS.md', '../AGENTS.md', 'notes.txt', 'SKILL.md', 'node_modules/AGENTS.md', 'rules.mdc']) assert.throws(() => markdownFileName(bad), undefined, bad);
  assert.deepEqual(markdownConvention('AGENTS.md').native.codex.length > 0, true);
  assert.deepEqual(Object.keys(markdownConvention('SOUL.md').native), [], 'OpenClaw files are not read by any CLI Promptboard runs');
  assert.match(markdownFrontmatter('# no frontmatter', '.github/instructions/api.instructions.md').issues[0], /applyTo/);
  assert.deepEqual(markdownFrontmatter('---\ndescription: x\nalwaysApply: true\n---\nBody', '.cursor/rules/x.mdc').issues, []);
  assert.throws(() => normalizeActivation({ mode: 'projects' }), /at least one project/);
  assert.deepEqual(normalizeActivation({ mode: 'providers', providers: ['codex', 'codex'] }).providers, ['codex']);
});

test('MCP configurations import without copying secrets; duplicates and credential arguments are refused', () => {
  const json = JSON.stringify({ mcpServers: {
    github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_realsecretvalue1234567890' } },
    docs: { type: 'http', url: 'https://docs.example.com/mcp', headers: { Authorization: 'Bearer ${DOCS_TOKEN}' } },
    leaky: { command: 'tool', args: ['--api-key=sk-abcdefghijklmnop'] },
    old: { type: 'sse', url: 'https://old.example.com/sse' },
    again: { command: 'existing-server', args: [] } } });
  const { servers } = parseMcpConfig(json, { environment: {}, existing: [{ id: 'x', name: 'Existing', kind: 'mcp', configuration: { command: 'existing-server', args: [] } }] });
  const by = name => servers.find(server => server.name === name);
  assert.deepEqual(by('github').env, [{ name: 'GITHUB_PERSONAL_ACCESS_TOKEN', reference: 'GITHUB_PERSONAL_ACCESS_TOKEN', ready: false, copied: false, note: 'Set GITHUB_PERSONAL_ACCESS_TOKEN where Promptboard runs. The value in the file is not copied.' }]);
  assert.equal(JSON.stringify(servers).includes('ghp_realsecretvalue'), false, 'secret values never leave the parser');
  assert.equal(by('docs').headers[0].reference, 'MCP_DOCS_AUTHORIZATION', 'a templated header becomes a variable holding the full value');
  assert.deepEqual([by('leaky').importable, by('old').importable, by('again').importable, by('again').duplicateOf.name], [false, false, false, 'Existing']);
  const created = mcpResourceFrom(by('github'), 'Claude Desktop');
  assert.deepEqual([created.enabled, created.trust, created.configuration.env], [false, 'untrusted', { GITHUB_PERSONAL_ACCESS_TOKEN: 'GITHUB_PERSONAL_ACCESS_TOKEN' }]);
});

test('a credential typed into an MCP or recipe argument is refused as in imports; saved ones and long folder paths keep working', async t => {
  const dir = await temp(t), store = new Store(dir), base = new Base({ store });
  const server = args => ({ kind: 'mcp', name: 'Docs', configuration: { transport: 'stdio', command: 'docs-mcp', args } });
  await assert.rejects(base.create(server(['--api-key=sk-abcdefghijklmnop'])), /looks like a credential/);
  await assert.rejects(base.create({ kind: 'tool', name: 'Deploy', configuration: { command: 'deploy', args: ['--token=abc123def456'] } }), /looks like a credential/);
  const folder = '/Users/someone/Documents/research-notes/archive-2026';
  assert.equal(parseMcpConfig(JSON.stringify({ mcpServers: { notes: { command: 'notes-mcp', args: [folder] } } }), { environment: {} }).servers[0].importable, true, 'an absolute folder path is not a token');
  const saved = await base.create(server([folder]));
  // A server saved with such an argument before this check (here through a Promptboard export) can still be edited.
  const legacy = (await base.import({ kind: 'promptboard-base', version: 1, resources: [{ id: 'old', ...server(['--api-key=sk-abcdefghijklmnop']) }] })).resources[0];
  const renamed = await base.update(legacy.id, { name: 'Docs (old)' }, { expectedRevision: legacy.revision });
  assert.deepEqual([renamed.name, (await base.detail(legacy.id)).configuration.args], ['Docs (old)', ['--api-key=sk-abcdefghijklmnop']]);
  await assert.rejects(base.update(saved.id, { configuration: { ...server([folder, '--secret=hunter2']).configuration } }, { expectedRevision: saved.revision }), /looks like a credential/);
});

test('repository instruction files are found read-only, imported once, and written back only after a matching preview', async t => {
  const repo = await temp(t), outside = await temp(t);
  await writeFile(join(repo, 'AGENTS.md'), '# Agents\n'); await writeFile(join(repo, 'README.md'), '# Readme\n');
  await mkdir(join(repo, '.github'), { recursive: true }); await writeFile(join(repo, '.github', 'copilot-instructions.md'), 'Copilot rules');
  await mkdir(join(repo, '.claude', 'skills', 'review'), { recursive: true }); await writeFile(join(repo, '.claude', 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review code\n---\nReview carefully.\n');
  await mkdir(join(repo, 'node_modules', 'x'), { recursive: true }); await writeFile(join(repo, 'node_modules', 'x', 'AGENTS.md'), 'vendored');
  await writeFile(join(outside, 'CLAUDE.md'), 'outside');
  if (process.platform !== 'win32') await symlink(join(outside, 'CLAUDE.md'), join(repo, 'CLAUDE.md'));
  assert.deepEqual((await scanRepository(repo)).map(file => [file.path, file.convention]), [['.claude/skills/review/SKILL.md', 'skill'], ['.github/copilot-instructions.md', 'copilot'], ['AGENTS.md', 'agents']]);
  const hash = text => `h${text.length}`;
  const preview = await deployToRepository(repo, 'AGENTS.md', '# New agents\n', { hash });
  assert.deepEqual([preview.exists, preview.written, preview.currentHash], [true, false, 'h9']);
  await assert.rejects(deployToRepository(repo, 'AGENTS.md', '# New agents\n', { confirm: true, expectedHash: 'stale', hash }), { code: 'BASE_DEPLOY_CONFLICT' });
  assert.equal((await deployToRepository(repo, 'AGENTS.md', '# New agents\n', { confirm: true, expectedHash: 'h9', hash })).written, true);
  assert.equal(await readFile(join(repo, 'AGENTS.md'), 'utf8'), '# New agents\n');
  assert.equal((await deployToRepository(repo, '.github/instructions/api.instructions.md', '---\napplyTo: "**/*.ts"\n---\n', { confirm: true, hash })).written, true, 'a new file in a new folder');
});

test('Base routes: import a repository’s files and an MCP configuration, deploy a trusted file, give a project its own version', async t => {
  const repo = await temp(t);
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-q', '-b', 'main'); await writeFile(join(repo, 'AGENTS.md'), '# Agents\nRun npm test.\n'); git('add', '.'); git('-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', 'init');
  const app = await startTestServer(t, { port: 0, executor: null });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = (path, method = 'GET', body) => fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async r => ({ status: r.status, json: await r.json() }));
  const project = await app.board.createProject({ name: 'Shop' });
  await app.board.linkRepository(project.id, { path: repo, expectedRevision: 1 });
  const scan = (await call('/api/base/markdown/scan', 'POST', { projectId: project.id })).json;
  assert.deepEqual(scan.files.map(file => [file.path, file.inBase]), [['AGENTS.md', false]]);
  assert.equal((await call('/api/base/markdown/import', 'POST', { projectId: project.id, paths: ['AGENTS.md', '../../etc/passwd'] })).json.skipped[0].reason, 'Not an instruction file found in this repository.');
  const listed = (await call('/api/base')).json.resources.find(resource => resource.kind === 'markdown');
  assert.deepEqual([listed.name, listed.enabled, listed.trust], ['AGENTS.md', false, 'untrusted'], 'imported instructions wait for review');
  assert.equal((await call('/api/base/markdown/import', 'POST', { projectId: project.id, paths: ['AGENTS.md'] })).json.skipped[0].reason, 'Already in Base as “AGENTS.md”.');
  const detail = (await call(`/api/base/resources/${listed.id}`)).json.resource;
  assert.equal(detail.markdown.convention.id, 'agents');
  assert.equal((await call(`/api/base/resources/${listed.id}/deploy`, 'POST', { projectId: project.id, confirm: true })).json.code, 'BASE_TRUST_REQUIRED', 'untrusted files are never written into repositories');
  const version = (await call(`/api/base/resources/${listed.id}/override`, 'POST', { projectId: project.id })).json.resource;
  assert.deepEqual(version.configuration.override, { of: listed.id, projectId: project.id });
  assert.equal(version.trust, 'untrusted', 'a project version of an imported file still waits for review');
  assert.equal((await call(`/api/base/resources/${listed.id}/override`, 'POST', { projectId: project.id })).status, 400, 'one version per project');
  // MCP: preview, then import only the importable server, switched off and untrusted.
  const json = JSON.stringify({ mcpServers: { files: { command: 'node', args: ['server.js'], env: { ROOT: '/tmp' } }, bad: { command: 'x', args: ['--token=abc123def456'] } } });
  const preview = (await call('/api/base/mcp/import/preview', 'POST', { json })).json;
  assert.deepEqual(preview.servers.map(server => [server.name, server.importable]), [['files', true], ['bad', false]]);
  assert.equal((await call('/api/base/mcp/import', 'POST', { json, names: ['bad'] })).status, 400);
  const imported = (await call('/api/base/mcp/import', 'POST', { json, names: ['files'] })).json.imported;
  const mcp = (await call(`/api/base/resources/${imported[0].id}`)).json.resource;
  assert.deepEqual([mcp.enabled, mcp.trust, mcp.configuration.env], [false, 'untrusted', { ROOT: 'ROOT' }]);
  assert.equal((await call('/api/base/mcp/import/preview', 'POST', { json })).json.servers[0].duplicateOf.id, imported[0].id, 'a second import is recognised as a duplicate');
});
