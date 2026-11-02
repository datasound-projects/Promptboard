#!/usr/bin/env node
// Opt-in live smoke test of Network jobs with the real signed-in CLIs (docs/network/implementation-progress.md, Task 07):
// one short research job per provider named in PB_NETWORK_LIVE (codex, claude, gemini), at most one run each, through an
// isolated app on port 4917 with a temporary data folder and the app's own local worker. Paid: each job is one real CLI
// call (Codex at low effort, Claude with haiku). Never part of `npm test`.
//
//   PB_NETWORK_LIVE=codex,claude,gemini node scripts/network-live-smoke.mjs
//
// Each CLI runs through a small wrapper that copies its stdout to a log, so the usage fields it really printed can be
// compared with what Promptboard recorded (R1). The folder and logs are removed at the end unless PB_NETWORK_KEEP=1.
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { resolveExecutable } from '../src/providers.mjs';
import { startServer } from '../src/server.mjs';

const wanted = (process.env.PB_NETWORK_LIVE || '').split(',').map(value => value.trim()).filter(value => ['codex', 'claude', 'gemini'].includes(value));
if (!wanted.length) { console.error('Set PB_NETWORK_LIVE to a comma-separated list of codex, claude, gemini.'); process.exit(2); }
const AGENTS = { codex: { provider: 'codex', effort: 'low' }, claude: { provider: 'claude', model: 'haiku' }, gemini: { provider: 'gemini' } };
const TEXT = 'Summarise in three bullet points: Promptboard Network lets the owner register Base agents, group them into networks and run general-purpose jobs outside Kanban. A job runs read-only in an empty folder on this computer through the signed-in CLI, and its result comes back as text.';

const root = await mkdtemp(join(tmpdir(), 'pb-network-live-')), dataDir = join(root, 'data'), wrappers = join(root, 'bin'), logs = join(root, 'stdout');
for (const dir of [wrappers, logs]) await mkdir(dir, { recursive: true });
// The wrapper runs the real CLI (absolute path, found on the original PATH), copies its stdout to a log, keeps its exit code.
for (const name of wanted) {
  const real = await resolveExecutable(name);
  if (!real) { console.log(`${name}: not installed, skipped.`); continue; }
  await writeFile(join(wrappers, name), `#!${process.execPath}
import { spawn } from 'node:child_process'; import { createWriteStream } from 'node:fs';
const log = createWriteStream(${JSON.stringify(join(logs, name))} + '-' + process.pid + '.out');
const child = spawn(${JSON.stringify(real.command)}, [...${JSON.stringify(real.prefix)}, ...process.argv.slice(2)], { stdio: ['inherit', 'pipe', 'inherit'] });
child.stdout.on('data', chunk => { log.write(chunk); process.stdout.write(chunk); });
child.on('close', (code, signal) => log.end(() => process.exit(code ?? (signal ? 1 : 0))));
`);
  await chmod(join(wrappers, name), 0o700);
}
process.env.PATH = `${wrappers}${delimiter}${process.env.PATH}`;

const app = await startServer({ port: 4917, dataDir, projectsDir: join(root, 'projects'), executor: null });
const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
const call = async (path, method = 'GET', body) => (await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
const results = [];
try {
  for (const name of wanted) {
    if (!(await readdir(wrappers)).includes(name)) continue;
    await app.board.base.create({ id: `live-${name}`, kind: 'profile', name: `Live ${name}`, configuration: { agent: AGENTS[name] } });
    const { revision } = await call('/api/network/agents');
    const { agent } = await call('/api/network/agents', 'POST', { baseResourceId: `live-${name}`, expectedRevision: revision });
    const started = Date.now(), accepted = await call('/api/network/jobs', 'POST', { agentId: agent.id, input: { text: TEXT }, limits: { timeoutMs: 180_000 } });
    if (!accepted.jobId) { results.push({ provider: name, refused: accepted }); continue; }
    let job;
    for (;;) { job = (await call(`/api/network/jobs/${accepted.jobId}`)).job; if (!['queued', 'preparing', 'running'].includes(job.status)) break; await new Promise(resolve => setTimeout(resolve, 1000)); }
    const attempt = job.attempts.at(-1), result = job.result ? await call(`/api/network/jobs/${job.id}/result`) : null;
    // The usage-shaped fields the CLI really printed (names only), from its own stdout.
    const raw = (await Promise.all((await readdir(logs)).filter(file => file.startsWith(`${name}-`)).map(file => readFile(join(logs, file), 'utf8')))).join('\n');
    const seen = [...new Set([...raw.matchAll(/"((?:input|output|cached|cache)_[a-z_]*tokens|total_cost_usd|usage|tokens)"/g)].map(match => match[1]))].sort();
    results.push({ provider: name, model: AGENTS[name].model || '(CLI default)', effort: AGENTS[name].effort || '', status: job.status, errorCode: job.errorCode, reason: job.reason, seconds: Math.round((Date.now() - started) / 1000),
      coverage: attempt?.coverage, exitCode: attempt?.exitCode, nativeSession: attempt?.nativeSessionId ? 'reported' : 'none', usage: attempt?.usage, rawUsageFields: seen, result: result?.text?.slice(0, 400) ?? null });
  }
} finally {
  await app.close();
  if (process.env.PB_NETWORK_KEEP !== '1') await rm(root, { recursive: true, force: true }); else console.log(`Kept ${root}`);
}
console.log(JSON.stringify(results, null, 2));
