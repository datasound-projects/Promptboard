#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { startServer, generate } from '../src/server.mjs';
import { COMPOSE_INPUT_CHARS } from '../src/compose-limits.mjs';
import { buildPrompt, validateRequest } from '../src/engine.mjs';
import { detectProviders, killOwnedProcesses, removeOwnedTempDirsSync } from '../src/providers.mjs';
import { defaultProjectsDir } from '../src/store.mjs';
import { VERSION } from '../src/version.mjs';

const help = `Promptboard ${VERSION}

Open the app:       npm start
Use the terminal:  node bin/ste.mjs --provider codex < request.txt
Choose a model:    node bin/ste.mjs --provider claude --model MODEL_ID < request.txt
Check CLIs:        node bin/ste.mjs --doctor
Prepare a brief:   node bin/ste.mjs --instructions < request.txt
Serve MCP:         PROMPTBOARD_MACHINE_TOKEN=… node bin/ste.mjs --mcp

Options:
  --gui                         Open the browser app
  --no-open                     With --gui: print the address, open no browser
  --port NUMBER                 With --gui: local port 0–65535 (default: 4318)
  --provider codex|claude|gemini|agy
                                CLI to use (default: codex)
  --model ID                    Use a model available through your CLI
  --effort LEVEL                Use a level supported by the selected model
  --language en|de|pl           Output language (default: en)
  --quality reviewed|fast       Reviewed by default; fast uses one model call
  --detail LEVEL                super-short, concise (default), detailed,
                                extremely-detailed
  --task TYPE                   build (default), feature, debug, refactor, review,
                                architecture, integration, ui-ux, data, testing,
                                security, performance, migration, dependencies,
                                devops, automation, documentation, agent-workflow,
                                research, unspecified
  --instructions                Print the rewrite instructions without a model call
  --json                        Print the full result and verification report as JSON
  --allow-draft                 Allow a flagged draft on stdout (exit code stays 2)
  --doctor                      Show installed CLI versions; does not check sign-in
  --mcp                         Serve Network agents to an MCP host over stdio. Needs a client
                                token from Network → Settings in PROMPTBOARD_MACHINE_TOKEN (or
                                a file named by PROMPTBOARD_MACHINE_TOKEN_FILE), never as an
                                option; PROMPTBOARD_MACHINE_URL defaults to http://127.0.0.1:4330
  --version                     Show the app version
  --help                        Show this help

Use Node.js 22.13 or later. Sign in to your CLI first. Generation uses your CLI plan.
Only prompts that pass the available checks are printed by default.
Exit codes: 0 done, 1 error, 2 review needed, 129, 130 or 143 cancelled.
A human must still check meaning and STE use.
`;

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  const flags = new Set(['gui', 'no-open', 'instructions', 'json', 'allow-draft', 'doctor', 'version', 'help', 'mcp']);
  const valued = new Set(['port', 'provider', 'model', 'effort', 'language', 'quality', 'detail', 'task']);
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    // A client token is never repeated into a log: it belongs in PROMPTBOARD_MACHINE_TOKEN, not in argv.
    if (!args[i].startsWith('--') || (!flags.has(key) && !valued.has(key))) throw new Error(`Unknown option: ${/pbm_/.test(args[i]) ? 'a Promptboard client token (set it as PROMPTBOARD_MACHINE_TOKEN instead; never pass it as an option)' : args[i]}`);
    if (flags.has(key)) options[key] = true;
    else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Set a value for --${key}.`);
      options[key] = args[++i];
    }
  }
  if (options.help) return console.log(help);
  if (options.version) return console.log(VERSION);
  if (options.mcp) {
    // stdout belongs to MCP: only protocol messages go there. The token comes from the environment, never from argv.
    if (args.length !== 1) throw new Error('--mcp takes no other option. Set PROMPTBOARD_MACHINE_TOKEN and PROMPTBOARD_MACHINE_URL in its environment.');
    const { serveMcp } = await import('../src/network/mcp.mjs');
    serveMcp();
    return;
  }
  if (options.doctor) {
    for (const item of await detectProviders({ paths: true })) console.log(`${item.name}: ${item.available ? item.version || 'installed' : item.reason || 'not installed'}${item.path ? ` · ${item.path}` : ''}`);
    return;
  }
  const gui = Boolean(options.gui || (args.length === 0 && process.stdin.isTTY));
  // --port and --no-open belong to the app, every other option to terminal generation: never ignore one silently.
  const misplaced = Object.keys(options).find(key => key !== 'gui' && (key === 'port' || key === 'no-open') !== gui);
  if (misplaced) throw new Error(gui ? `--${misplaced} does not apply with --gui.` : `Use --${misplaced} with --gui.`);
  if (gui) {
    // Decimal digits only: Number() would also take 0x10, 1e3, +80 or 80.0.
    const port = options.port === undefined ? 4318 : /^[0-9]{1,5}$/.test(options.port) ? Number(options.port) : NaN;
    let app;
    try {
      // New projects get their own Git repository in a stable, user-visible folder.
      // Projects opened from another local path remain at that path.
      app = await startServer({ port, projectsDir: defaultProjectsDir() });
    } catch (error) {
      if (error.code === 'EADDRINUSE') {
        // A second Promptboard on the same data folder is refused before this (DATA_DIR_IN_USE), so another port is safe here.
        throw new Error(`Port ${port} is already in use. If another Promptboard runs there, open http://127.0.0.1:${port}.\nOr start on another port: npm start -- --port ${port === 4320 ? 4321 : 4320}`);
      }
      throw error;
    }
    console.log(`\nPromptboard ${VERSION}\n${app.url}\n\nPress Ctrl+C to stop.\n`);
    // Idempotent shutdown. The first signal cancels work and closes the port with a
    // bounded grace period; a second signal exits at once. SIGKILL cannot be handled.
    let stopping = false;
    const stop = async signal => {
      if (stopping) { killOwnedProcesses('SIGKILL'); removeOwnedTempDirsSync(); process.exit(130); }
      stopping = true;
      console.log(`\n${signal} received. Stopping Promptboard…`);
      const force = setTimeout(() => { killOwnedProcesses('SIGKILL'); removeOwnedTempDirsSync(); process.exit(1); }, 8000);
      force.unref();
      try { await app.close(); } catch {}
      removeOwnedTempDirsSync();
      process.exit(0);
    };
    for (const signal of ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? [] : ['SIGHUP'])]) process.on(signal, () => stop(signal));
    if (!options['no-open']) {
      const browser = process.platform === 'darwin' ? ['open', app.url]
        : process.platform === 'win32' ? ['explorer.exe', app.url] : ['xdg-open', app.url];
      const child = spawn(browser[0], browser.slice(1), { stdio: 'ignore', detached: true, shell: false });
      child.on('error', () => {});
      child.unref();
    }
    return;
  }
  if (process.stdin.isTTY) throw new Error('Send your request through stdin. Use --help for examples.');
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (input.length > COMPOSE_INPUT_CHARS) throw new Error(`Use at most ${COMPOSE_INPUT_CHARS.toLocaleString('en-US')} characters.`);
  }
  const request = validateRequest({ input, provider: options.provider || 'codex', model: options.model || '',
    effort: options.effort || '', language: options.language || 'en', quality: options.quality || 'reviewed',
    detail: options.detail || 'concise', task: options.task || 'build' });
  if (options.instructions) return process.stdout.write(buildPrompt(request) + '\n');
  const controller = new AbortController();
  let stopCode = 0, settled = false;
  // The first signal cancels the run; a second one, or one after the run, exits at once through the exit handler below.
  // Kept until exit: without a handler Node ends at once and leaves the CLI process group and its temporary folder.
  const stop = code => () => { if (stopCode || settled) process.exit(stopCode || code); stopCode = code; controller.abort(); };
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ...(process.platform === 'win32' ? [] : [['SIGHUP', 129]])]) process.on(signal, stop(code));
  try {
    const result = await generate(request, { signal: controller.signal });
    const passed = result.verification?.status === 'checks-passed';
    const issueCount = (result.verification?.automatic?.issues?.length || 0)
      + (result.verification?.review?.issues?.length || 0)
      + (result.verification?.review?.requirements?.filter(row => row.status !== 'covered').length || 0)
      + (result.verification?.review?.criteria?.filter(row => row.status !== 'pass').length || 0)
      + (result.lint?.warnings?.filter(issue => issue.rule !== 'language-review').length || 0);
    if (!passed) {
      process.exitCode = 2;
      process.stderr.write(`Review needed: ${issueCount} flagged finding${issueCount === 1 ? '' : 's'}. The available checks did not pass.\n`);
      if (result.verification?.repairFailed) process.stderr.write('The repair attempt failed. The report contains the retained draft.\n');
      if (!options.json && !options['allow-draft']) {
        process.stderr.write('Draft withheld from stdout. Use --json for the full report, or --allow-draft to inspect the draft.\n');
      }
    } else if (issueCount) {
      process.stderr.write(`Checks passed with ${issueCount} review note${issueCount === 1 ? '' : 's'}. Review meaning before use.\n`);
    }
    if (options.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else if (passed || options['allow-draft']) process.stdout.write(result.prompt + '\n');
  } catch (error) {
    if (!stopCode) throw error;
    process.stderr.write('Generation cancelled.\n');
    process.exitCode = stopCode;
  } finally { settled = true; }
}

// Last line of defense on any exit path: stop owned CLI process groups and remove owned temp folders.
process.on('exit', () => { killOwnedProcesses('SIGKILL'); removeOwnedTempDirsSync(); });
main().catch(error => { console.error(error.message); process.exitCode = 1; });
