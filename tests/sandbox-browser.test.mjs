// Real Chrome, SIMULATED Docker: Settings → Docker sandbox with the fake docker client (tests/fixtures/fake-docker.cjs)
// first on PATH. Builds the image, saves Claude Code's token, and checks the phone width. No agent starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const skip = !(await findChrome()) || process.platform === 'win32';
const TOKEN = 'sk-ant-oat01-BROWSER-FIXTURE-0123456789abcdef';

test('Settings → Docker sandbox builds the image with progress, saves the Claude Code token without showing it, and fits a phone', { skip, timeout: 120000 }, async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pb-sandbox-browser-')));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const fake = name => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  await writeFile(join(dir, 'docker'), `#!${process.execPath}\nrequire(${JSON.stringify(fake('fake-docker.cjs'))});\n`, { mode: 0o755 });
  for (const cli of ['claude', 'codex']) await writeFile(join(dir, cli), `#!${process.execPath}\nconsole.log('9.8.7');\n`, { mode: 0o755 });
  await writeFile(join(dir, 'auth.json'), '{}');
  const saved = Object.fromEntries(['PATH', 'CODEX_HOME', 'FAKE_DOCKER_STATE', 'FAKE_DOCKER_BUILD_MS'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { PATH: `${dir}${delimiter}${process.env.PATH}`, CODEX_HOME: dir, FAKE_DOCKER_STATE: dir, FAKE_DOCKER_BUILD_MS: '1500' });
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [] });
  const browser = await launch({ width: 1280, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  const ev = code => browser.eval(code), wait = (expression, label, ms = 15000) => browser.until(expression, label, ms);
  const text = () => ev(`return document.querySelector('#set-sandbox-group').textContent`);
  await browser.goto(`${app.url}/#/kanban`);
  await wait(`!!document.querySelector('#kanban-columns')`, 'app ready', 30000);
  await ev(`document.querySelector('#app-settings-open').click(); document.querySelector('#settings-sandbox-section').open = true;`);
  await wait(`document.querySelector('#set-sandbox-group [role="status"]')?.textContent === 'Not ready yet. The list below says what is missing.'`, 'status read');
  assert.match(await text(), /Docker is running\..*The image is not built yet\./);
  await ev(`document.querySelector('#set-sandbox-build').click();`);
  await wait(`!!document.querySelector('#set-sandbox-cancel') && /Step 1\\/3/.test(document.querySelector('.sandbox-log').textContent)`, 'build progress');
  await wait(`/Image ready: promptboard-sandbox:/.test(document.querySelector('#set-sandbox-group').textContent)`, 'image ready', 20000);
  // The token is typed like a paste, saved, and never shown again.
  await ev(`document.querySelector('#set-sandbox-token').focus();`);
  await browser.type(TOKEN);
  await ev(`document.querySelector('#set-sandbox-token-save').click();`);
  await wait(`/Claude Code has its token for Docker\\./.test(document.querySelector('#set-sandbox-group').textContent)`, 'token saved');
  assert.equal(await ev(`return document.querySelector('#set-sandbox-group [role="status"]').textContent`), 'Ready: card agents can run in Docker.');
  assert.equal(await ev(`return document.documentElement.outerHTML.includes(${JSON.stringify(TOKEN)})`), false);
  // Keyboard: the section's controls are reachable and show their focus.
  await ev(`[...document.querySelectorAll('#set-sandbox-group button')].find(b => b.textContent === 'Build again').focus();`);
  assert.notEqual(await ev(`const s = getComputedStyle(document.activeElement); return s.outlineStyle + ' ' + s.boxShadow;`), 'none none', 'focus is visible');
  // Phone width: the section stays inside the dialog without sideways scrolling.
  await browser.resize(390, 844);
  await browser.layout(`const box = document.querySelector('#set-sandbox-group').getBoundingClientRect(); return box.width > 0 && box.right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1 && document.querySelector('#app-settings').scrollWidth <= document.querySelector('#app-settings').clientWidth + 1;`);
  assert.deepEqual(browser.consoleMessages.filter(line => line.startsWith('EXCEPTION')), []);
});
