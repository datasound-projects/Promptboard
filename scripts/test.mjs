import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Chrome owns a renderer/DevTools stream per file. Keep those fixtures separate
// from competing PTY/Git/JSDOM work without changing any scenario deadline.
const directory = new URL('../tests/', import.meta.url);
const files = (await readdir(directory)).filter(name => name.endsWith('.test.mjs')).sort();
const definitions = await Promise.all(files.map(async name => {
  const path = fileURLToPath(new URL(name, directory));
  return { path, browser: /['"]\.\/helpers\/browser\.mjs['"]/.test(await readFile(path, 'utf8')), fileBudgetMs: name === 'kanban-stage-engine.test.mjs' ? 900000 : 300000 };
}));
let child = null, stopped = null;
const stop = signal => { stopped ||= signal; child?.kill(signal); };
const interrupt = () => stop('SIGINT'), terminate = () => stop('SIGTERM');
process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
try {
  // The stage-engine file contains many full Git/PTY flows: its aggregate
  // duration exceeds five minutes locally. Run it alone; its scenario-specific
  // deadlines stay unchanged, as do all other files' five-minute budgets.
  for (const { browser, fileBudgetMs, concurrency } of [
    { browser: false, fileBudgetMs: 300000, concurrency: 2 },
    { browser: false, fileBudgetMs: 900000, concurrency: 1 },
    { browser: true, fileBudgetMs: 300000, concurrency: 1 },
  ]) {
    if (stopped) break;
    const selected = definitions.filter(file => file.browser === browser && file.fileBudgetMs === fileBudgetMs).map(file => file.path);
    if (!selected.length) continue;
    const status = await new Promise(resolve => {
      child = spawn(process.execPath, ['--test', `--test-concurrency=${concurrency}`, `--test-timeout=${fileBudgetMs}`, '--test-force-exit', ...selected], { stdio: 'inherit' });
      child.once('error', error => { console.error(error.message); resolve(1); });
      child.once('close', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)));
    });
    child = null;
    if (status !== 0) process.exitCode ||= status;
  }
  if (stopped) process.exitCode = stopped === 'SIGINT' ? 130 : 143;
} finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
