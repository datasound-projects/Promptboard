// Usage from the CLIs' own session files. Agents are SIMULATED by tests/fixtures/fake-agent.cjs,
// which writes records in the shapes Claude Code and Codex CLI use (checked against real files).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Board } from '../src/board.mjs';
import { Supervisor } from '../src/supervisor.mjs';
import { addClaudeRecord, addCodexRecord, claudeTranscript, newUsage, usageSummary } from '../src/usage.mjs';

const skip = process.platform === 'win32';
const fake = fileURLToPath(new URL('./fixtures/fake-agent.cjs', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
async function temp(t, prefix) { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return dir; }
async function until(fn, label, ms = 15000) { const end = Date.now() + ms; for (;;) { const value = await fn(); if (value) return value; if (Date.now() > end) assert.fail(`Timed out: ${label}`); await new Promise(r => setTimeout(r, 50)); } }

test('Claude records: one count per message ID, cache reads separate, latest request is the context', () => {
  const acc = newUsage('claude-transcript');
  const line = (id, input, read, write, output) => ({ type: 'assistant', message: { id, model: 'claude-x', usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: output } } });
  for (const record of [line('a', 10, 1000, 200, 50), line('a', 10, 1000, 200, 50), { type: 'user', message: { content: 'text' } }, line('b', 5, 1200, 0, 70), { type: 'assistant', message: { id: 'c', model: '<synthetic>' } }]) addClaudeRecord(acc, record);
  const summary = usageSummary(acc);
  assert.deepEqual({ ...summary, updatedAt: 0 }, { source: 'claude-transcript', model: 'claude-x', inputTokens: 215, cachedTokens: 2200, outputTokens: 120, contextTokens: 1205, contextWindow: 0, updatedAt: 0 });
  assert.doesNotMatch(JSON.stringify(summary), /content|"text"/);
  assert.equal(claudeTranscript('/x/sid.jsonl', 'sid'), '/x/sid.jsonl');
  assert.equal(claudeTranscript('/x/other.jsonl', 'sid'), null, 'Only the transcript of the session Promptboard started is read.');
  assert.equal(claudeTranscript('relative/sid.jsonl', 'sid'), null);
});

test('Codex records: totals, context window, rate limit, and model come from token_count and turn_context', () => {
  const acc = newUsage('codex-rollout');
  addCodexRecord(acc, { type: 'turn_context', payload: { model: 'gpt-x' } });
  addCodexRecord(acc, { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 15732, cached_input_tokens: 7424, output_tokens: 99 }, last_token_usage: { input_tokens: 15732, output_tokens: 99 }, model_context_window: 258400 }, rate_limits: { primary: { used_percent: 100, resets_at: 1791048036 } } } });
  const summary = usageSummary(acc);
  assert.deepEqual({ ...summary, updatedAt: 0 }, { source: 'codex-rollout', model: 'gpt-x', inputTokens: 8308, cachedTokens: 7424, outputTokens: 99, contextTokens: 15831, contextWindow: 258400,
    rateLimit: { usedPercent: 100, resetsAt: new Date(1791048036 * 1000).toISOString() }, updatedAt: 0 });
  const empty = newUsage('codex-rollout');
  addCodexRecord(empty, { type: 'event_msg', payload: { type: 'token_count', info: null } });
  assert.equal(usageSummary(empty).inputTokens, 0, 'No numbers are invented when the CLI reports none.');
});

test('live runs record real usage for Claude and Codex, and none for Gemini', { skip, timeout: 60000 }, async t => {
  const bin = await temp(t, 'pb-usage-bin-');
  for (const id of ['claude', 'codex', 'gemini']) { await writeFile(join(bin, id), `#!${process.execPath}\nrequire(${JSON.stringify(fake)});\n`); await chmod(join(bin, id), 0o755); }
  const projects = await temp(t, 'pb-claude-projects-'), codexHome = await temp(t, 'pb-codex-home-');
  const old = { PATH: process.env.PATH, FAKE_CLAUDE_PROJECTS: process.env.FAKE_CLAUDE_PROJECTS, CODEX_HOME: process.env.CODEX_HOME };
  Object.assign(process.env, { PATH: `${bin}:${old.PATH}`, FAKE_CLAUDE_PROJECTS: projects, CODEX_HOME: codexHome });
  const dataDir = await temp(t, 'pb-usage-data-'), root = await temp(t, 'pb-usage-repo-');
  git(root, 'init', '-q', '-b', 'trunk'); git(root, 'config', 'user.email', 't@e'); git(root, 'config', 'user.name', 'T');
  await writeFile(join(root, 'README.md'), 'x\n'); git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'init');
  const board = new Board({ dataDir });
  const supervisor = new Supervisor({ board, dataDir });
  board.executor = supervisor;
  t.after(async () => { await supervisor.shutdown(500); for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const project = await board.createProject({ name: 'Usage' });
  await board.linkRepository(project.id, { path: root, expectedRevision: 1 });
  await board.setTargetBranch(project.id, { branch: 'trunk', expectedRevision: 2 });
  await board.setSettings({ maxConcurrentRuns: 3 });
  const start = async (provider, title) => {
    const created = await board.createTask({ projectId: project.id, title, prompt: `Do the USAGE task ${title}.` });
    await board.moveTask(created.id, { column: 'executing', expectedRevision: 1 });
    return board.requestRun(created.id, { stage: 'executing', consent: true, config: { provider } });
  };
  const runs = { claude: await start('claude', 'a'), codex: await start('codex', 'b'), gemini: await start('gemini', 'c') };
  const claude = await until(async () => (await board.run(runs.claude.id)).usage, 'Claude usage');
  assert.deepEqual([claude.model, claude.inputTokens, claude.cachedTokens, claude.outputTokens, claude.contextTokens], ['claude-test-model', 215, 2200, 120, 1205]);
  const codex = await until(async () => (await board.run(runs.codex.id)).usage, 'Codex usage');
  assert.deepEqual([codex.model, codex.contextWindow, codex.contextTokens, codex.rateLimit.usedPercent], ['gpt-test', 200000, 15100, 40]);
  await until(async () => (await board.run(runs.gemini.id)).status === 'waiting_for_input', 'Gemini turn');
  assert.equal((await board.run(runs.gemini.id)).usage, undefined, 'Gemini reports no usage, so none is shown.');
  // Each run has its own numbers; nothing leaks across runs.
  assert.notEqual(claude.source, codex.source);
  assert.doesNotMatch(await readFile(join(dataDir, 'board.json'), 'utf8').catch(async () => JSON.stringify(await board.state())), /secret text/);
});
