// Task 12 review (phase 3) in headless Chrome: a live redraw of a job's record keeps the keyboard in the answer and note
// fields, with the caret where it was (P3-1). jsdom cannot show this: Chrome blurs a focused field that the redraw takes out
// and puts back. Real app, fake worker; each redraw comes from a note posted to the job (a live job.message event).
import test from 'node:test';
import assert from 'node:assert/strict';
import { findChrome, launch } from './helpers/browser.mjs';
import { fakeWorker } from './helpers/network-worker.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const chrome = await findChrome();

test('P3-1: typing in the answer and note fields survives live redraws of the job record', { skip: !chrome, timeout: 120000 }, async t => {
  const worker = fakeWorker({ text: () => 'Draft.', json: job => (job.handoff?.context ? null : { promptboard: { needs_input: { question: 'Which market first?' } } }) });
  const app = await startTestServer(t, { port: 0, executor: null, networkWorker: worker, networkScheduleOptions: { setTimer: () => null } });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = async (path, method = 'GET', body) => (await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
  await app.board.base.create({ id: 'lead', kind: 'profile', name: 'Lead', configuration: { agent: { provider: 'claude' } } });
  const lead = (await call('/api/network/agents', 'POST', { baseResourceId: 'lead', expectedRevision: 0 })).agent;
  await call('/api/network/delegation', 'PATCH', { expectedRevision: 0, askOwner: true });
  const { jobId } = await call('/api/network/jobs', 'POST', { agentId: lead.id, input: { text: 'Plan the launch.' } });
  for (let i = 0; (await call(`/api/network/jobs/${jobId}`)).job.status !== 'waiting_for_input'; i++) { assert.ok(i < 500, 'the job asks'); await new Promise(resolve => setTimeout(resolve, 10)); }

  const browser = await launch({ width: 1200, height: 900 }); assert.ok(browser); t.after(() => browser.close());
  await browser.goto(`${app.url}/#/network/activity/${jobId}`);
  await browser.until(`!!document.querySelector('#network-handoff-answer') && document.querySelector('#network-activity-live')?.dataset.state === 'live'`, 'record and live stream', 20000);
  /** Post a note to the job and wait until the record was drawn again with it. */
  const redraw = async text => {
    await browser.eval(`window.__heading = document.querySelector('#network-activity-job-heading');`);
    await call(`/api/network/jobs/${jobId}/messages`, 'POST', { kind: 'review', text });
    await browser.until(`document.querySelector('#network-activity-job-heading') !== window.__heading && (document.querySelector('#network-handoff-messages')?.textContent || '').includes(${JSON.stringify(text)})`, `redrawn with “${text}”`, 20000);
  };
  const state = id => browser.eval(`const node = document.querySelector('#${id}'); return [document.activeElement.id || document.activeElement.tagName, node.value, node.selectionStart, node.selectionEnd];`);

  await browser.eval(`document.querySelector('#network-handoff-answer').focus();`);
  await browser.type('Germany');
  await browser.eval(`document.querySelector('#network-handoff-answer').setSelectionRange(3, 3);`);
  await redraw('First note.');
  assert.deepEqual(await state('network-handoff-answer'), ['network-handoff-answer', 'Germany', 3, 3], 'focus and caret kept in the answer');
  await browser.type('X');
  assert.equal((await state('network-handoff-answer'))[1], 'GerXmany', 'the keystrokes after the redraw land in the answer');

  await browser.eval(`document.querySelector('#network-handoff-notes').open = true; document.querySelector('#network-handoff-note').focus();`);
  await browser.type('Check');
  await redraw('Second note.');
  await browser.type('!');
  assert.deepEqual(await state('network-handoff-note'), ['network-handoff-note', 'Check!', 6, 6], 'focus kept in the note');
  assert.deepEqual(browser.consoleMessages.filter(line => /EXCEPTION|Content Security Policy/.test(line)), []);
});
