// Scheduled cards: repeats in local time (daylight saving included), firing, catch-up, pile-up, Autopilot, backup and HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from '../src/board.mjs';
import { Autopilot } from '../src/autopilot.mjs';
import { Schedules, nextFire, normalizeCadence } from '../src/schedules.mjs';
import { startTestServer } from './helpers/test-server.mjs';

// One time zone with both clock changes, so every expectation is exact on every machine.
process.env.TZ = 'Europe/Warsaw';
const at = (year, month, day, hours = 0, minutes = 0) => new Date(year, month - 1, day, hours, minutes).getTime();
const iso = ms => new Date(ms).toISOString();
const FULL_ROUTE = ['planning', 'executing', 'code_review', 'testing', 'merge'];

async function world(t, start = at(2026, 10, 21, 12)) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-schedules-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const board = new Board({ dataDir });
  let now = start;
  const clock = { now: () => now, setTimer: () => null, clearTimer: () => {} };
  const schedules = new Schedules(board, clock);
  const project = await board.createProject({ name: 'Shop' });
  const read = async () => (await board.state()).projects.find(item => item.id === project.id);
  const add = async (input = {}) => schedules.create(project.id, { title: 'Update dependencies', prompt: 'Update the dependencies.', cadence: { kind: 'daily', time: '02:00' }, expectedRevision: (await read()).revision, ...input });
  // A linked repository and an executor, as Autopilot needs them; no agent runs in these tests.
  const link = async () => {
    await board.store.update(state => { const item = state.projects.find(entry => entry.id === project.id); item.repository = { path: '/repo', root: '/repo', commonDir: '/repo/.git' }; item.targetBranch = { name: 'main', commit: 'a'.repeat(40) }; item.revision++; });
    board.executor = {};
  };
  return { board, schedules, project, read, add, link, clock, set: value => { now = value; }, get now() { return now; } };
}

test('nextFire gives the next local time for each repeat: daily, weekdays, weekly and monthly', () => {
  const wednesday = at(2026, 10, 21, 12);
  assert.equal(nextFire({ kind: 'daily', time: '02:00' }, wednesday), at(2026, 10, 22, 2));
  assert.equal(nextFire({ kind: 'daily', time: '13:30' }, wednesday), at(2026, 10, 21, 13, 30), 'later the same day');
  assert.equal(nextFire({ kind: 'daily', time: '12:00' }, wednesday), at(2026, 10, 22, 12), 'strictly after: the same minute is the next day');
  assert.equal(nextFire({ kind: 'weekdays', time: '02:00' }, at(2026, 10, 23, 21)), at(2026, 10, 26, 2), 'Friday night to Monday');
  assert.equal(nextFire({ kind: 'weekdays', time: '02:00' }, wednesday), at(2026, 10, 22, 2));
  assert.equal(nextFire({ kind: 'weekly', days: [1, 5], time: '09:00' }, wednesday), at(2026, 10, 23, 9), 'Friday comes first');
  assert.equal(nextFire({ kind: 'weekly', days: [3], time: '09:00' }, wednesday), at(2026, 10, 28, 9), 'this Wednesday has passed');
  assert.equal(nextFire({ kind: 'weekly', days: [0], time: '00:00' }, wednesday), at(2026, 10, 25), 'Sunday is day 0');
  assert.equal(nextFire({ kind: 'monthly', day: 21, time: '08:00' }, wednesday), at(2026, 11, 21, 8), 'this month has passed');
  assert.equal(nextFire({ kind: 'monthly', day: 28, time: '08:00' }, at(2027, 1, 31, 9)), at(2027, 2, 28, 8), 'February has a 28th');
  assert.equal(nextFire({ kind: 'monthly', day: 1, time: '08:00' }, at(2026, 12, 15)), at(2027, 1, 1, 8), 'into the next year');
});

test('nextFire keeps the local time across both daylight-saving changes (Europe/Warsaw)', () => {
  const night = { kind: 'daily', time: '02:30' };
  // 29 March 2026: the clocks jump from 02:00 to 03:00, so 02:30 does not exist. It runs an hour later, once.
  const spring = nextFire(night, at(2026, 3, 28, 12));
  assert.equal(iso(spring), '2026-03-29T01:30:00.000Z', '03:30 summer time');
  assert.equal(iso(nextFire(night, spring)), '2026-03-30T00:30:00.000Z', 'the next night is 02:30 again');
  // 25 October 2026: the clocks go back from 03:00 to 02:00, so 02:30 happens twice. It runs once, the first time.
  const autumn = nextFire(night, at(2026, 10, 24, 12));
  assert.equal(iso(autumn), '2026-10-25T00:30:00.000Z', 'the first 02:30 (summer time)');
  assert.equal(iso(nextFire(night, autumn)), '2026-10-26T01:30:00.000Z', 'not again at the second 02:30, but the next night (winter time)');
  // Away from the change, the local time stays: the day is 23 hours long in March and 25 in October.
  const morning = { kind: 'daily', time: '09:00' };
  assert.equal(nextFire(morning, at(2026, 3, 28, 9)) - at(2026, 3, 28, 9), 23 * 3600000);
  assert.equal(nextFire(morning, at(2026, 10, 24, 9)) - at(2026, 10, 24, 9), 25 * 3600000);
  assert.equal(iso(nextFire({ kind: 'weekly', days: [0], time: '09:00' }, at(2026, 3, 22, 10))), '2026-03-29T07:00:00.000Z', 'a weekly Sunday after the change');
  assert.equal(iso(nextFire({ kind: 'monthly', day: 1, time: '09:00' }, at(2026, 10, 2))), '2026-11-01T08:00:00.000Z', 'a monthly one after the change');
});

test('a repeat is checked: a real time, at least one weekday, and a day of the month from 1 to 28', () => {
  assert.deepEqual(normalizeCadence({ kind: 'weekly', days: [5, 1, 5], time: '07:05', extra: 1 }), { kind: 'weekly', days: [1, 5], time: '07:05' });
  assert.deepEqual(normalizeCadence({ kind: 'monthly', day: 28, time: '23:59' }), { kind: 'monthly', day: 28, time: '23:59' });
  for (const bad of [null, [], { kind: 'daily' }, { kind: 'daily', time: '24:00' }, { kind: 'daily', time: '9:00' }, { kind: 'weekly', days: [], time: '09:00' },
    { kind: 'weekly', days: [7], time: '09:00' }, { kind: 'weekly', days: [1.5], time: '09:00' }, { kind: 'monthly', day: 29, time: '09:00' }, { kind: 'monthly', day: 0, time: '09:00' }, { kind: '0 2 * * *', time: '02:00' }])
    assert.throws(() => normalizeCadence(bad), { code: 'INVALID_SCHEDULE' }, JSON.stringify(bad));
});

test('a card made on time has the plain task text, through the normal card path with its number, priority and labels', async t => {
  const w = await world(t);
  await w.board.setLabels(w.project.id, { labels: [{ id: 'deps', name: 'Dependencies', color: '#2563eb' }, { id: 'gone', name: 'Gone', color: '#111111' }], expectedLabelRevision: 0 });
  const schedule = await w.add({ priority: 2, labelIds: ['deps', 'gone'] });
  await w.board.setLabels(w.project.id, { labels: [{ id: 'deps', name: 'Dependencies', color: '#2563eb' }], expectedLabelRevision: 1 });
  await w.board.createTask({ projectId: w.project.id, title: 'By hand', prompt: 'Something else.' });
  const revision = (await w.read()).revision;
  w.set(at(2026, 10, 22, 2) + 20000);
  await w.schedules.tick();
  const card = (await w.read()).tasks.find(task => task.scheduleId);
  assert.deepEqual([card.title, card.prompt, card.column, card.number, card.priority, card.labelIds, card.scheduleId, card.scheduledFor],
    ['Update dependencies', 'Update the dependencies.', 'todo', 2, 2, ['deps'], schedule.id, at(2026, 10, 22, 2)], 'a label removed from the project is left out');
  assert.equal((await w.read()).revision, revision, 'making a card is not a settings change: the project revision stays');
});

test('a schedule missed while the app was closed makes one card on the next check, and the card says when it was due', async t => {
  const w = await world(t);
  const schedule = await w.add();
  w.set(at(2026, 10, 24, 9, 15)); // Three nights were missed: 22, 23 and 24 October at 02:00.
  await w.schedules.tick();
  const cards = (await w.read()).tasks;
  assert.equal(cards.length, 1, 'one card, not one per missed night');
  assert.deepEqual([cards[0].scheduleId, cards[0].scheduledFor], [schedule.id, at(2026, 10, 24, 2)], 'for the latest missed time');
  assert.equal(cards[0].prompt, 'Update the dependencies.\n\n(This scheduled card was due Sat 24 Oct, 02:00. Promptboard was not running then, or the computer was asleep, so it was created at Sat 24 Oct, 09:15.)');
  await w.schedules.tick();
  assert.equal((await w.read()).tasks.length, 1, 'checking again makes nothing');
  const [listed] = (await w.schedules.list(w.project.id)).schedules;
  assert.deepEqual([listed.lastSlot, listed.lastFiredAt, listed.lastTaskId, listed.next], [at(2026, 10, 24, 2), w.now, cards[0].id, at(2026, 10, 25, 2)]);
});

test('one slot makes one card, even when checks for it run at the same time', async t => {
  const w = await world(t);
  const schedule = await w.add();
  const slot = at(2026, 10, 22, 2);
  w.set(slot + 30000);
  const made = await Promise.all([w.schedules.fire(w.project.id, schedule.id, { slot }), w.schedules.fire(w.project.id, schedule.id, { slot })]);
  assert.equal(made.filter(Boolean).length, 1);
  // A second scheduler on the same board, and a re-entrant check, find the slot already used.
  await Promise.all([w.schedules.tick(), w.schedules.tick(), new Schedules(w.board, w.clock).tick()]);
  assert.equal((await w.read()).tasks.length, 1);
  assert.equal((await w.read()).schedules[0].lastSlot, slot);
});

test('while the previous card is open the slot is skipped and says why; once that card is Done the next slot makes one', async t => {
  const w = await world(t);
  await w.add();
  w.set(at(2026, 10, 22, 2, 1)); await w.schedules.tick();
  const [first] = (await w.read()).tasks;
  await w.board.store.update(state => { state.projects[0].tasks[0].column = 'executing'; }); // In progress counts as open too.
  w.set(at(2026, 10, 23, 2, 1)); await w.schedules.tick();
  let saved = (await w.read()).schedules[0];
  assert.equal((await w.read()).tasks.length, 1, 'no pile-up');
  assert.deepEqual(saved.lastSkip, { at: w.now, reason: `previous card #${first.number} is still open` });
  assert.equal(saved.lastSlot, at(2026, 10, 23, 2), 'the skipped slot is used up, so it is not retried every minute');
  await w.board.store.update(state => { state.projects[0].tasks[0].column = 'todo'; });
  await w.board.completeTask(first.id, { kind: 'no_changes', details: {} });
  w.set(at(2026, 10, 24, 2, 1)); await w.schedules.tick();
  const tasks = (await w.read()).tasks;
  saved = (await w.read()).schedules[0];
  assert.equal(tasks.length, 2);
  assert.deepEqual([saved.lastTaskId, saved.lastSkip], [tasks.find(task => task.id !== first.id).id, undefined]);
});

test('Run now makes a card at once and keeps the next time; a schedule switched off and on again does not catch up', async t => {
  const w = await world(t);
  const schedule = await w.add();
  const before = (await w.schedules.list(w.project.id)).schedules[0];
  const card = await w.schedules.runNow(w.project.id, schedule.id);
  const after = (await w.schedules.list(w.project.id)).schedules[0];
  assert.deepEqual([card.number, after.next, after.lastSlot, after.lastTaskId], [1, before.next, null, card.id]);
  assert.equal((await w.read()).tasks[0].scheduledFor, w.now);
  await w.schedules.update(w.project.id, schedule.id, { enabled: false, expectedRevision: (await w.read()).revision });
  assert.equal((await w.schedules.list(w.project.id)).schedules[0].next, null);
  await w.board.completeTask(card.id, { kind: 'no_changes', details: {} });
  w.set(at(2026, 10, 25, 12)); await w.schedules.tick();
  assert.equal((await w.read()).tasks.length, 1, 'a switched-off schedule makes no card');
  await w.schedules.update(w.project.id, schedule.id, { enabled: true, expectedRevision: (await w.read()).revision });
  await w.schedules.tick();
  assert.equal((await w.read()).tasks.length, 1, 'switching it on does not catch up on the nights it was off');
  assert.equal((await w.schedules.list(w.project.id)).schedules[0].next, at(2026, 10, 26, 2));
  await assert.rejects(w.schedules.runNow(w.project.id, 'missing'), { code: 'NOT_FOUND', status: 404 });
});

test('the timer waits for the earliest schedule, at most a minute, and stops with the app', async t => {
  const w = await world(t, at(2026, 10, 21, 1, 59));
  const waits = [];
  const schedules = new Schedules(w.board, { now: () => w.now, setTimer: (fn, ms) => { waits.push(ms); return { fn }; }, clearTimer: () => {} });
  schedules.start();
  assert.deepEqual(waits, [1000], 'the first check comes a second after start');
  await w.add({ cadence: { kind: 'daily', time: '02:00' } });
  await w.add({ title: 'Docs', cadence: { kind: 'weekly', days: [3], time: '09:00' } });
  w.set(at(2026, 10, 21, 1, 59) + 30000);
  await schedules.tick();
  assert.equal(waits.at(-1), 30000, 'until 02:00, the earliest');
  w.set(at(2026, 10, 21, 3));
  await schedules.tick();
  assert.equal(waits.at(-1), 60000, 'never more than a minute, so sleep and clock changes are noticed');
  schedules.stop();
  const count = waits.length;
  await schedules.tick();
  schedules.wake();
  assert.equal(waits.length, count, 'a stopped scheduler sets no timer');
});

test('Run with Autopilot: an idle Autopilot starts for the card, a running one gets it at the end of its queue, a paused one is left alone', async t => {
  const w = await world(t);
  await assert.rejects(w.add({ autopilot: true, confirmAutopilot: true }), { code: 'REPOSITORY_REQUIRED', status: 409 });
  await w.link();
  await assert.rejects(w.add({ autopilot: true }), { code: 'CONFIRMATION_REQUIRED' }, 'switching Autopilot on needs the owner’s confirm');
  const schedule = await w.add({ autopilot: true, confirmAutopilot: true });
  // Idle (never set up): started through the dialog's own Start, with its default route and a queue of this card only.
  w.set(at(2026, 10, 22, 2, 1)); await w.schedules.tick();
  let project = await w.read();
  const first = project.tasks[0];
  assert.deepEqual([project.autopilot.status, project.autopilot.queue, project.autopilot.done, project.autopilot.route], ['running', [first.id], [], FULL_ROUTE]);
  assert.deepEqual(project.schedules[0].lastAutopilot, { at: w.now, ok: true, text: 'Autopilot started' });
  // Running: Autopilot is on another card and has finished one. The new card joins the end; nothing else changes.
  const other = await w.board.createTask({ projectId: w.project.id, title: 'Other', prompt: 'Other work.' });
  await w.board.updateAutopilot(w.project.id, ap => { ap.queue = [first.id, other.id]; ap.done = [first.id]; ap.current = { taskId: other.id, stage: 'executing', step: 'running' }; });
  await w.board.completeTask(first.id, { kind: 'no_changes', details: {} });
  w.set(at(2026, 10, 23, 2, 1)); await w.schedules.tick();
  project = await w.read();
  const second = project.tasks.find(task => task.scheduleId && task.id !== first.id);
  assert.deepEqual([project.autopilot.status, project.autopilot.queue, project.autopilot.done, project.autopilot.current.taskId], ['running', [first.id, other.id, second.id], [first.id], other.id]);
  assert.match(project.autopilot.log.at(-1).text, /Scheduled card “Update dependencies” joined the queue/);
  assert.equal(project.schedules[0].lastAutopilot.text, 'Added to the Autopilot queue');
  // Paused by the owner: the card waits in To Do and the schedule says why. Autopilot stays paused.
  await w.board.controlAutopilot(w.project.id, { action: 'pause' });
  await w.board.completeTask(second.id, { kind: 'no_changes', details: {} });
  w.set(at(2026, 10, 24, 2, 1)); await w.schedules.tick();
  project = await w.read();
  const third = project.tasks.find(task => task.scheduleId && ![first.id, second.id].includes(task.id));
  assert.deepEqual([third.column, project.autopilot.status, project.autopilot.queue.includes(third.id)], ['todo', 'paused', false]);
  assert.deepEqual(project.schedules[0].lastAutopilot, { at: w.now, ok: false, text: 'Autopilot is paused, so the card waits in To Do' });
  // A start that Autopilot's own checks refuse is reported on the schedule; the card stays in To Do.
  await w.board.controlAutopilot(w.project.id, { action: 'stop' });
  w.board.executor = null;
  await w.board.completeTask(third.id, { kind: 'no_changes', details: {} });
  await w.schedules.runNow(w.project.id, schedule.id);
  project = await w.read();
  assert.deepEqual([project.autopilot.status, project.schedules[0].lastAutopilot.ok, project.schedules[0].lastAutopilot.text], ['off', false, 'Autopilot did not start: Agent execution is not available']);
});

test('a card queued after Autopilot read the board keeps it running instead of finishing', async t => {
  const w = await world(t);
  await w.link();
  const done = await w.board.createTask({ projectId: w.project.id, title: 'Done before', prompt: 'Done.' });
  await w.board.setAutopilot(w.project.id, { route: ['executing'], queue: [done.id], expectedRevision: (await w.read()).revision });
  await w.board.controlAutopilot(w.project.id, { action: 'start', confirm: true });
  await w.board.updateAutopilot(w.project.id, ap => { ap.done = [done.id]; });
  const autopilot = new Autopilot(w.board);
  autopilot.taskIds.set(w.project.id, null);
  const stale = await w.read(); // What Autopilot's step read: nothing left in the queue.
  const late = await w.board.createTask({ projectId: w.project.id, title: 'Scheduled', prompt: 'Run me.' });
  await w.board.updateAutopilot(w.project.id, ap => { ap.queue = [...ap.queue, late.id]; });
  await autopilot.next(stale);
  assert.equal((await w.read()).autopilot.status, 'running', 'the queued card is still ahead, so the next step starts it');
});

test('schedule changes are checked: the project revision, the fields, and at most 50 per project', async t => {
  const w = await world(t);
  await assert.rejects(w.schedules.create(w.project.id, { title: 'x', prompt: 'y', cadence: { kind: 'daily', time: '02:00' } }), { code: 'REVISION_REQUIRED' });
  await assert.rejects(w.add({ expectedRevision: 0 }), { code: 'REVISION_CONFLICT', status: 409 });
  for (const [input, code] of [[{ title: ' ' }, 'INVALID_SCHEDULE'], [{ title: 'x'.repeat(121) }, 'INVALID_SCHEDULE'], [{ prompt: '' }, 'INVALID_SCHEDULE'], [{ prompt: 'x'.repeat(20001) }, 'INVALID_SCHEDULE'],
    [{ cadence: { kind: 'hourly', time: '02:00' } }, 'INVALID_SCHEDULE'], [{ enabled: 'yes' }, 'INVALID_SCHEDULE'], [{ priority: 9 }, 'INVALID_TASK_PRIORITY'], [{ labelIds: ['missing'] }, 'INVALID_TASK_LABELS']])
    await assert.rejects(w.add(input), { code }, JSON.stringify(input).slice(0, 80));
  const first = await w.add({ title: '  Spaces trimmed  ' });
  assert.deepEqual([first.title, first.enabled, first.autopilot, first.priority, first.labelIds, first.lastSlot], ['Spaces trimmed', true, false, 0, [], null]);
  const before = (await w.read()).revision;
  const changed = await w.schedules.update(w.project.id, first.id, { title: 'Renamed', expectedRevision: before });
  assert.deepEqual([changed.title, changed.prompt, changed.cadence, (await w.read()).revision], ['Renamed', first.prompt, first.cadence, before + 1], 'fields left out keep their value');
  await assert.rejects(w.schedules.update(w.project.id, first.id, { title: 'Again', expectedRevision: before }), { code: 'REVISION_CONFLICT' });
  await assert.rejects(w.schedules.update(w.project.id, 'missing', { expectedRevision: before + 1 }), { code: 'NOT_FOUND' });
  for (let index = 1; index < 50; index++) await w.add({ title: `Schedule ${index}` });
  await assert.rejects(w.add(), { code: 'LIMIT' });
  assert.equal(await w.schedules.remove(w.project.id, first.id, (await w.read()).revision), true);
  assert.equal((await w.read()).schedules.length, 49);
});

test('a backup carries each schedule’s settings, and a restore brings them back switched off and without Autopilot', async t => {
  const w = await world(t);
  await w.link();
  await w.board.setLabels(w.project.id, { labels: [{ id: 'deps', name: 'Dependencies', color: '#2563eb' }], expectedLabelRevision: 0 });
  const schedule = await w.add({ priority: 3, labelIds: ['deps'], cadence: { kind: 'weekly', days: [1, 4], time: '06:45' }, autopilot: true, confirmAutopilot: true });
  w.set(at(2026, 10, 22, 7)); await w.schedules.tick();
  const backup = await w.board.exportBackup();
  const [exported] = backup.projects[0].schedules;
  assert.deepEqual(Object.keys(exported).sort(), ['autopilot', 'cadence', 'createdAt', 'enabled', 'id', 'labelIds', 'priority', 'prompt', 'title', 'updatedAt'], 'settings only, no record of earlier cards');
  backup.projects[0].schedules.push({ id: 'broken', title: 'No repeat', prompt: 'x' }, 'not a schedule');
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-schedules-restore-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const restored = new Board({ dataDir });
  await restored.importBackup(backup, { replace: true });
  const copies = (await restored.state()).projects[0].schedules;
  assert.equal(copies.length, 1, 'a malformed entry is left out');
  const { id, title, prompt, priority, labelIds, cadence, autopilot, enabled, lastSlot, lastTaskId } = copies[0];
  assert.deepEqual({ id, title, prompt, priority, labelIds, cadence, autopilot, enabled, lastSlot, lastTaskId },
    { id: schedule.id, title: schedule.title, prompt: schedule.prompt, priority: 3, labelIds: ['deps'], cadence: { kind: 'weekly', days: [1, 4], time: '06:45' }, autopilot: false, enabled: false, lastSlot: null, lastTaskId: null });
  // A backup made before schedules existed restores with none.
  delete backup.projects[0].schedules;
  await restored.importBackup(backup, { replace: true });
  assert.equal((await restored.state()).projects[0].schedules, undefined);
  assert.deepEqual((await new Schedules(restored).list(w.project.id)).schedules, [], 'an old project lists no schedules');
});

test('HTTP: the schedule routes need the session token, check every body, and answer changes with the list and the board', async t => {
  const app = await startTestServer(t, { port: 0, executor: null });
  const { token } = await fetch(`${app.url}/api/session`).then(response => response.json());
  const call = async (method, path, body, headers = { 'x-ste-token': token }) => {
    const response = await fetch(`${app.url}${path}`, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, json: await response.json() };
  };
  const project = await app.board.createProject({ name: 'Routes' });
  const base = `/api/projects/${project.id}/schedules`;
  assert.equal((await call('GET', base, null, {})).status, 403, 'no token, no answer');
  assert.deepEqual((await call('GET', base)).json, { revision: project.revision, schedules: [] }, 'a project from before schedules has none');
  assert.equal((await call('GET', '/api/projects/missing/schedules')).status, 404);
  const valid = { title: 'Docs sweep', prompt: 'Check the docs.', cadence: { kind: 'weekly', days: [1], time: '03:00' } };
  for (const [body, status, code] of [[valid, 400, 'REVISION_REQUIRED'], [{ ...valid, expectedRevision: 99 }, 409, 'REVISION_CONFLICT'], [{ ...valid, cadence: { kind: 'weekly', time: '03:00' }, expectedRevision: project.revision }, 400, 'INVALID_SCHEDULE'],
    [{ ...valid, autopilot: true, confirmAutopilot: true, expectedRevision: project.revision }, 409, 'REPOSITORY_REQUIRED'], [{ ...valid, priority: -1, expectedRevision: project.revision }, 400, 'INVALID_TASK_PRIORITY']]) {
    const answer = await call('POST', base, body);
    assert.deepEqual([answer.status, answer.json.code], [status, code], JSON.stringify(body));
  }
  assert.equal((await call('POST', base, [valid])).status, 400, 'a JSON array is not a schedule');
  const created = await call('POST', base, { ...valid, expectedRevision: project.revision });
  assert.equal(created.status, 200);
  const [schedule] = created.json.schedules;
  assert.deepEqual([schedule.title, typeof schedule.next, created.json.revision, created.json.board.projects[0].schedules.length], ['Docs sweep', 'number', project.revision + 1, 1]);
  assert.equal(new Date(schedule.next).getDay(), 1, 'next is a Monday');
  assert.equal((await call('PATCH', `${base}/missing`, { title: 'x', expectedRevision: created.json.revision })).status, 404);
  const run = await call('POST', `${base}/${schedule.id}/run`, {});
  assert.deepEqual([run.status, run.json.task.number, run.json.board.projects[0].tasks[0].scheduleId], [200, 1, schedule.id]);
  const off = await call('PATCH', `${base}/${schedule.id}`, { enabled: false, expectedRevision: run.json.revision });
  assert.deepEqual([off.status, off.json.schedules[0].enabled, off.json.schedules[0].next], [200, false, null]);
  assert.equal((await call('DELETE', `${base}/${schedule.id}?expectedRevision=1`)).status, 409);
  const removed = await call('DELETE', `${base}/${schedule.id}?expectedRevision=${off.json.revision}`);
  assert.deepEqual([removed.status, removed.json.schedules, removed.json.board.projects[0].tasks.length], [200, [], 1], 'its cards stay');
  assert.equal((await call('PUT', base, {})).status, 404);
});
