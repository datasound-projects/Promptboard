// An agent's Tasks tab in headless Chrome with the app's own local job worker and fake headless CLIs
// (tests/fixtures/fake-headless-cli.mjs; only they are on PATH, so no real CLI can start): a job typed and run with the
// keyboard, its confirmation, its live status and its result, in light and dark themes at 1440 and 390 px, with nothing
// scrolling sideways. PB_NETWORK_SCREENSHOTS=<folder> also saves each width and theme as a PNG for a person to look at.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const chrome = await findChrome();
const J = JSON.stringify;
const bin = await mkdtemp(join(tmpdir(), 'pb-network-tasks-bin-'));
for (const name of ['claude', 'codex', 'gemini']) {
  await writeFile(join(bin, name), `#!${process.execPath}\nimport ${J(new URL('./fixtures/fake-headless-cli.mjs', import.meta.url).href)};\n`);
  await chmod(join(bin, name), 0o700);
}
await writeFile(join(bin, 'package.json'), '{"type":"module"}');
process.env.PATH = bin;
process.on('exit', () => rmSync(bin, { recursive: true, force: true }));
const enter = async browser => { // Activates the focused control, as a person pressing Enter does.
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
};

test('Tasks in Chrome: a job typed and run with the keyboard through the local worker, confirmed, followed live and read, in both themes at 1440 and 390 px', { skip: !chrome || process.platform === 'win32', timeout: 240000 }, async t => {
  const app = await startTestServer(t, { port: 0, executor: null, networkWorker: undefined }); // undefined: the app's own local worker.
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = async (path, method = 'GET', body) => { const response = await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: J(body) } : {}) }); return response.json(); };
  const site = await app.board.createProject({ name: 'Site' });
  await app.board.base.create({ id: 'lead', kind: 'profile', name: 'Lead', configuration: { agent: { provider: 'claude', model: 'haiku', instructions: 'Lead the research.' } } });
  const lead = (await call('/api/network/agents', 'POST', { baseResourceId: 'lead', expectedRevision: 0, displayName: 'Research lead', projectAllowlist: [site.id] })).agent;

  const browser = await launch({ width: 1440, height: 1000 }); assert.ok(browser); t.after(() => browser.close());
  const ev = code => browser.eval(code), wait = (expression, label, ms = 20000) => browser.until(expression, label, ms);
  const shots = process.env.PB_NETWORK_SCREENSHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  const shot = async name => { if (shots) await writeFile(join(shots, `${name}.png`), await browser.screenshot()); };
  const noSideways = `document.documentElement.scrollWidth <= document.documentElement.clientWidth`;
  const colors = {};
  await browser.goto(`${app.url}/#/network`);
  for (const theme of ['light', 'dark']) {
    await ev(`localStorage.setItem('ste-prompt-engineer.theme', ${J(theme)});`);
    await browser.reload();
    await browser.resize(1440, 1000);
    await ev(`location.hash = '#/network/agents/${lead.id}';`);
    await wait(`(document.documentElement.dataset.theme || 'light') === ${J(theme)} && document.querySelector('#network-detail-heading')?.textContent === 'Research lead'`, `${theme} profile`);
    // Keyboard: the profile tabs, then the form.
    await ev(`document.querySelector('#network-profile-tab-profile').focus();`);
    await browser.key('ArrowRight', 'ArrowRight', 39);
    await wait(`document.activeElement?.id === 'network-profile-tab-tasks' && !document.querySelector('#network-profile-panel-tasks').hidden && document.querySelector('#network-job-list')?.getAttribute('aria-busy') === 'false'`, `${theme}: Tasks by keyboard`);
    assert.notEqual(await ev(`return getComputedStyle(document.activeElement).outlineStyle;`), 'none', 'visible focus');
    await ev(`document.querySelector('#network-job-input').focus();`);
    await browser.type(`Summarise in three bullet points (${theme}).`);
    await ev(`document.querySelector('#network-job-run').focus();`);
    await enter(browser);
    await wait(`document.querySelector('#network-dialog').open && document.activeElement?.id === 'network-job-confirm'`, `${theme}: confirmation focused`);
    assert.match(await ev(`return document.querySelector('#network-dialog').textContent;`), /Read only: an empty folder of its own/);
    await shot(`tasks-1440-${theme}-confirm`);
    await enter(browser);
    await wait(`!document.querySelector('#network-dialog').open && [...document.querySelectorAll('#network-job-list .network-job')].some(item => item.dataset.status === 'completed' && item.textContent.includes(${J(`(${theme})`)}))`, `${theme}: completed by the local worker`);
    const id = await ev(`return [...document.querySelectorAll('#network-job-list .network-job')].find(item => item.textContent.includes(${J(`(${theme})`)})).dataset.id;`);
    await ev(`document.querySelector('#network-job-${id} summary').focus();`);
    await enter(browser);
    await wait(`document.querySelector('#network-job-${id} .network-job-result')?.textContent.includes('Answer from claude.')`, `${theme}: result shown`);
    assert.match(await ev(`return document.querySelector('#network-job-${id}').textContent;`), /Tool-level activity reported/);
    assert.equal(await browser.layout(`return ${noSideways};`), true, `${theme}: nothing scrolls sideways at 1440`);
    colors[theme] = await ev(`return [getComputedStyle(document.querySelector('#network-job-form')).backgroundColor, getComputedStyle(document.querySelector('#network-job-${id}')).borderColor];`);
    await ev(`document.querySelector('#network-profile-panel-tasks').scrollIntoView({ block: 'start' });`);
    await shot(`tasks-1440-${theme}`);
    // Phone: one column, the form and the jobs under each other, nothing sideways.
    await browser.resize(390, 844);
    await wait(`document.querySelector('#network-job-form').getBoundingClientRect().width > 0`, `${theme}: form at 390`);
    assert.equal(await browser.layout(`const form = document.querySelector('#network-job-form').getBoundingClientRect(), list = document.querySelector('#network-job-list').getBoundingClientRect();
      return ${noSideways} && form.width <= 390 && list.top > form.bottom && document.querySelector('#network-job-tools').getBoundingClientRect().width > 200;`), true, `${theme}: phone layout`);
    await ev(`document.querySelector('#network-job-form').scrollIntoView({ block: 'start' });`);
    await shot(`tasks-390-${theme}-form`);
    await ev(`document.querySelector('#network-job-${id}').scrollIntoView({ block: 'start' });`);
    await shot(`tasks-390-${theme}-job`);
  }
  assert.notDeepEqual(colors.light, colors.dark, 'the Tasks tab follows the theme');
  const { jobs } = await call(`/api/network/jobs?agentId=${lead.id}`);
  assert.deepEqual(jobs.map(job => job.status), ['completed', 'completed']);
  assert.deepEqual(browser.consoleMessages.filter(message => /EXCEPTION|Uncaught|Content Security Policy/i.test(message)), []);
});
