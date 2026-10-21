import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/origin-model.js';
import { REVIEW_CRITERIA } from '../src/pipeline.mjs';
import { findChrome } from './helpers/browser.mjs';
import { researchPage } from './helpers/research.mjs';

const M = globalThis.PromptboardOriginModel;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A stand-in CLI that waits while `held`, stops on abort, and counts how many runs work at the same time. */
function agents() {
  const state = { held: true, live: 0, max: 0, aborted: 0, calls: 0, waiting: [] };
  state.release = () => { state.held = false; for (const resolve of state.waiting.splice(0)) resolve(); };
  state.runner = async call => {
    state.calls++; state.live++; state.max = Math.max(state.max, state.live);
    try {
      await new Promise((resolve, reject) => {
        call.signal?.addEventListener('abort', () => { state.aborted++; reject(Object.assign(new Error('Generation was cancelled.'), { code: 'ABORTED' })); }, { once: true });
        if (state.held) state.waiting.push(resolve); else setTimeout(resolve, 120);
      });
      if (call.prompt.startsWith('# Review task')) {
        const data = JSON.parse(call.prompt.split('# Review data\n')[1]);
        return { text: JSON.stringify({ covered: data.units.map(unit => unit.id), requirements: [], criteria: Object.fromEntries(REVIEW_CRITERIA.map(name => [name, 'pass'])), issues: [] }) };
      }
      const request = JSON.parse(call.prompt.split('# Source data\n')[1]).request;
      return { text: `# Goal\n${request}` };
    } finally { state.live--; }
  };
  return state;
}

test('Improve with Compose runs tasks on the batch: chosen settings, parallel or one at a time, live progress, minimize, instant cancel', { skip: !await findChrome(), timeout: 180000 }, async t => {
  const cli = agents();
  const { ev, wait, call, originId } = await researchPage(t, { runner: cli.runner, blueprint: bp => {
    for (let i = 1; i <= 6; i++) bp.items.push({ ...M.RECORD_DEFAULTS.items(`Task ${i}`), id: `t${i}`, origin: 'human', key: `IMP-00${i}`, description: `Build part ${i} with tests.`, acceptanceCriteria: 'It works' });
    bp.sequence = { items: 6 };
  } });
  const dialog = '#origin-improve-dialog';
  const chips = () => ev(`return [...document.querySelectorAll('${dialog} .origin-improve-row .origin-chip')].map(chip => chip.textContent);`);
  await ev(`document.querySelector('.origin-nav-item[data-section="plan"]').click();`);
  await wait(`document.querySelector('#origin-main input[type=checkbox]')`, 'tasks');
  await ev(`document.querySelector('#origin-main input[type=checkbox]').click();`);
  await wait(`document.querySelector('#origin-select-drafts')`, 'selection');
  await ev(`document.querySelector('#origin-select-drafts').click();`);
  await ev(`document.querySelector('#origin-improve').click();`);
  await wait(`document.querySelector('${dialog}')?.open && !document.querySelector('#origin-improve-start')?.disabled`, 'settings', 20000);
  assert.equal(cli.calls, 0, 'Opening the window runs nothing.');
  // Settings for the whole run: Fast checks, no grounding, three at once.
  await ev(`const pick = [...document.querySelectorAll('${dialog} select')]; pick[3].value = 'fast'; pick[3].dispatchEvent(new Event('change')); const runs = document.querySelector('#origin-improve-runs'); runs.value = '3'; runs.dispatchEvent(new Event('change')); document.querySelector('#origin-improve-grounding').click();`);
  await ev(`document.querySelector('#origin-improve-start').click();`);
  await wait(`document.querySelectorAll('${dialog} .origin-improve-row').length === 6`, 'progress view', 20000);
  await wait(`[...document.querySelectorAll('${dialog} .origin-improve-row .origin-chip')].filter(chip => !['Queued', 'Waiting'].includes(chip.textContent)).length === 3`, 'three agents working', 20000);
  assert.equal(cli.max, 3, 'three agents at once, never more');
  const batch = (await call(`/api/compose/batches/${originId}`)).batch;
  assert.deepEqual([batch.concurrency, batch.settings.quality, batch.settings.includeContext, batch.settings.model, batch.settings.effort], [3, 'fast', false, '', ''],
    'the settings chosen here are the batch settings; "CLI default" is saved as itself, never Compose’s model');
  assert.match(await ev(`return document.querySelector('${dialog} .origin-improve-total-text').textContent;`), /0 of 6 done · 3 working · 3 waiting/);
  assert.equal(await ev(`return document.querySelector('${dialog} .origin-improve-row .pb-meter').getAttribute('role');`), 'progressbar');
  // Read shows the task's own words while it runs.
  await ev(`document.querySelector('${dialog} .origin-improve-read').click();`);
  assert.match(await ev(`return document.querySelector('${dialog} .origin-improve-pre').textContent;`), /^IMP-001 Task 1\n\nWhat to do:\nBuild part 1 with tests\.\n\nDone when:\n- It works$/);
  // Minimize: the run goes on; a small card shows it on every page.
  await ev(`document.querySelector('#origin-improve-minimize').click();`);
  await wait(`!document.querySelector('${dialog}').open && document.querySelector('#origin-improve-mini')`, 'minimized');
  await ev(`location.hash = '#/';`);
  await wait(`location.hash === '#/' && /Improving 0 of 6/.test(document.querySelector('#origin-improve-mini')?.textContent || '')`, 'card on Compose');
  await ev(`document.querySelector('#origin-improve-show').focus();`);
  await pause(2200);
  assert.equal(await ev(`return document.activeElement?.id;`), 'origin-improve-show', 'the card updates without taking focus from its buttons');
  // Cancel from the card stops every running agent at once.
  const before = cli.aborted;
  await ev(`[...document.querySelectorAll('#origin-improve-mini button')].find(b => b.textContent === 'Cancel').click();`);
  await wait(`/Cancelled/.test(document.querySelector('#origin-improve-mini')?.textContent || '')`, 'cancelled', 10000);
  await pause(300);
  assert.equal(cli.aborted - before, 3, 'the three running agents were stopped');
  assert.equal(cli.live, 0);
  const calls = cli.calls;
  await pause(1500);
  assert.equal(cli.calls, calls, 'nothing else starts after Cancel');
  // One at a time: the same tasks again, now released.
  cli.release(); cli.max = 0;
  await ev(`[...document.querySelectorAll('#origin-improve-mini button')].find(b => b.title === 'Dismiss').click(); location.hash = '#/origin';`);
  await wait(`location.hash === '#/origin' && document.querySelector('#origin-improve')`, 'back in Origin');
  await ev(`document.querySelector('#origin-improve').click();`);
  await wait(`document.querySelector('${dialog}')?.open && !document.querySelector('#origin-improve-start')?.disabled`, 'settings again', 20000);
  assert.equal(await ev(`return document.querySelector('#origin-improve-runs').value;`), '3', 'the batch remembers how it ran');
  await ev(`const runs = document.querySelector('#origin-improve-runs'); runs.value = '1'; runs.dispatchEvent(new Event('change')); document.querySelector('#origin-improve-start').click();`);
  await wait(`[...document.querySelectorAll('${dialog} .origin-improve-row .origin-chip')].length === 6 && [...document.querySelectorAll('${dialog} .origin-improve-row .origin-chip')].every(chip => chip.textContent === 'Proposal ready')`, 'all proposals', 60000);
  assert.equal(cli.max, 1, 'one agent at a time');
  assert.deepEqual(await chips(), Array(6).fill('Proposal ready'));
  await wait(`document.querySelector('#origin-view').dataset.save === 'saved'`, 'saved', 20000);
  await ev(`document.querySelector('#origin-improve-close').click();`);
  await pause(600);
  assert.equal(await ev(`return Boolean(document.querySelector('#origin-improve-mini')) || document.querySelector('${dialog}').open;`), false, 'Close leaves no card behind');
  const items = (await call(`/api/origin/projects/${originId}`)).blueprint.items;
  assert.deepEqual(items.map(item => [item.key, item.description, item.refinement?.proposal.startsWith(`# Goal\n${item.key}`)]), items.map(item => [item.key, `Build part ${item.key.at(-1)} with tests.`, true]),
    'each task has its own proposal; its text is unchanged until accepted');
});

test('a run that finishes while you type on another page keeps your field and every keystroke', { skip: !await findChrome(), timeout: 120000 }, async t => {
  const cli = agents();
  const { browser, ev, wait, call, originId } = await researchPage(t, { runner: cli.runner, blueprint: bp => {
    bp.items.push({ ...M.RECORD_DEFAULTS.items('Task 1'), id: 't1', origin: 'human', key: 'IMP-001', description: 'Do it', acceptanceCriteria: 'Works' }); bp.sequence = { items: 1 };
  } });
  await ev(`document.querySelector('.origin-nav-item[data-section="plan"]').click();`);
  await wait(`document.querySelector('#origin-main input[type=checkbox]')`, 'tasks');
  await ev(`document.querySelector('#origin-main input[type=checkbox]').click();`);
  await wait(`document.querySelector('#origin-improve')`, 'selection');
  await ev(`document.querySelector('#origin-improve').click();`);
  await wait(`document.querySelector('#origin-improve-dialog')?.open && !document.querySelector('#origin-improve-start')?.disabled`, 'settings', 20000);
  await ev(`const pick = [...document.querySelectorAll('#origin-improve-dialog select')]; pick[3].value = 'fast'; pick[3].dispatchEvent(new Event('change')); document.querySelector('#origin-improve-start').click();`);
  await wait(`document.querySelector('#origin-improve-minimize')`, 'running', 20000);
  await ev(`document.querySelector('#origin-improve-minimize').click(); document.querySelector('.origin-nav-item[data-section="vision"]').click();`);
  await wait(`document.querySelector('[data-vision="problem"] textarea')`, 'Vision');
  await ev(`document.querySelector('[data-vision="problem"] textarea').focus();`);
  await browser.type('Shops ');
  cli.release();
  await wait(`/proposal/.test(document.querySelector('#origin-improve-mini')?.textContent || '')`, 'run finished', 30000);
  await ev(`await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);`);
  assert.equal(await ev(`return document.activeElement?.closest('[data-vision]')?.dataset.vision;`), 'problem', 'the field keeps focus when the run finishes');
  await browser.type('are slow');
  await wait(`document.querySelector('#origin-view').dataset.save === 'saved'`, 'saved', 20000);
  assert.equal((await call(`/api/origin/projects/${originId}`)).blueprint.vision.problem, 'Shops are slow');
});
