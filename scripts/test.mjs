import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Chrome owns a renderer/DevTools stream per file. Keep those fixtures separate
// from competing PTY/Git/JSDOM work without changing any scenario deadline.
const directory = new URL('../tests/', import.meta.url);
const files = (await readdir(directory)).filter(name => name.endsWith('.test.mjs')).sort();
const definitions = await Promise.all(files.map(async name => {
  const path = fileURLToPath(new URL(name, directory));
  return { path, browser: /['"]\.\/helpers\/browser\.mjs['"]/.test(await readFile(path, 'utf8')) };
}));
let child = null, stopped = null;
const stop = signal => { stopped ||= signal; child?.kill(signal); };
const interrupt = () => stop('SIGINT'), terminate = () => stop('SIGTERM');
process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
try {
  for (const browser of [false, true]) {
    if (stopped) break;
    const selected = definitions.filter(file => file.browser === browser).map(file => file.path);
    if (!selected.length) continue;
    const status = await new Promise(resolve => {
      child = spawn(process.execPath, ['--test', `--test-concurrency=${browser ? 1 : 2}`, '--test-timeout=300000', '--test-force-exit', ...selected], { stdio: 'inherit' });
      child.once('error', error => { console.error(error.message); resolve(1); });
      child.once('close', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)));
    });
    child = null;
    if (status !== 0) process.exitCode ||= status;
  }
  if (stopped) process.exitCode = stopped === 'SIGINT' ? 130 : 143;
} finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
