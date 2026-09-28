#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { startServer, generate } from '../src/server.mjs';
import { buildPrompt, validateRequest } from '../src/engine.mjs';
import { detectProviders } from '../src/providers.mjs';
import { VERSION } from '../src/version.mjs';

const help = `AI Prompt Engineer ${VERSION} · STE

Open the app:       npm start
Use the terminal:  node bin/ste.mjs --provider codex < request.txt
Choose a model:    node bin/ste.mjs --provider claude --model MODEL_ID < request.txt
Check CLIs:        node bin/ste.mjs --doctor
Prepare a brief:   node bin/ste.mjs --instructions < request.txt

Options:
  --gui                         Open the browser app
  --no-open                     Print the address without opening a browser
  --port NUMBER                 Local port (default: 4318)
  --provider codex|claude|gemini|agy  CLI to use (default: codex)
  --model ID                    Use a model available through your CLI
  --effort LEVEL                Use a level supported by the selected model
  --language en|de|pl            Output language (default: en)
  --quality reviewed|fast       Reviewed by default; fast uses one model call
  --detail LEVEL                super-short, concise, detailed, extremely-detailed
  --task TYPE                   build, debug, refactor, review, architecture,
                                agent-workflow, research
  --instructions                Print the rewrite instructions without a model call
  --json                        Print the full result and verification report as JSON
  --allow-draft                 Allow a flagged draft on stdout (exit code stays 2)
  --doctor                      Show installed CLI versions; does not check sign-in
  --version                     Show the app version
  --help                        Show this help

Use Node.js 22 or later. Sign in to your CLI first. Generation uses your CLI plan.
Only prompts that pass the available checks are printed by default.
Exit 2 means review is needed. A human must still check meaning and STE use.
`;

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  const flags = new Set(['gui', 'no-open', 'instructions', 'json', 'allow-draft', 'doctor', 'version', 'help']);
  const valued = new Set(['port', 'provider', 'model', 'effort', 'language', 'quality', 'detail', 'task']);
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || (!flags.has(key) && !valued.has(key))) throw new Error(`Unknown option: ${args[i]}`);
    if (flags.has(key)) options[key] = true;
    else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Set a value for --${key}.`);
      options[key] = args[++i];
    }
  }
  if (options.help) return console.log(help);
  if (options.version) return console.log(VERSION);
  if (options.doctor) {
    for (const item of await detectProviders()) console.log(`${item.name}: ${item.available ? item.version || 'installed' : item.reason || 'not installed'}`);
    return;
  }
  if (options.gui || (args.length === 0 && process.stdin.isTTY)) {
    const port = options.port === undefined ? 4318 : Number(options.port);
    let app;
    try {
      app = await startServer({ port });
    } catch (error) {
      if (error.code === 'EADDRINUSE') {
        throw new Error(`Port ${port} is already in use. If AI Prompt Engineer is already running, open http://127.0.0.1:${port}.\nOr start on another port: npm start -- --port ${port === 4320 ? 4321 : 4320}`);
      }
      throw error;
    }
    console.log(`\nAI Prompt Engineer ${VERSION} · STE\n${app.url}\n\nPress Ctrl+C to stop.\n`);
    const stop = async () => { await app.close(); process.exit(0); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
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
    if (input.length > 24_000) throw new Error('Use at most 24,000 characters.');
  }
  const request = validateRequest({ input, provider: options.provider || 'codex', model: options.model || '',
    effort: options.effort || '', language: options.language || 'en', quality: options.quality || 'reviewed',
    detail: options.detail || 'concise', task: options.task || 'build' });
  if (options.instructions) return process.stdout.write(buildPrompt(request) + '\n');
  const controller = new AbortController();
  let stopCode = 0;
  const interrupt = () => { stopCode = 130; controller.abort(); };
  const terminate = () => { stopCode = 143; controller.abort(); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
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
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
