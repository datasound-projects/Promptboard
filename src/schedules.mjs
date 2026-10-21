/**
 * Scheduled cards: recurring To Do cards of a project, for example a nightly dependency update or a weekly docs sweep.
 * A schedule says what to do (title, task text, priority, labels) and when (a repeat in this computer's local time).
 *
 * While the app runs, one timer wakes for the earliest due schedule (at least once a minute, so sleep and clock changes
 * are noticed) and creates its card through the board's normal card path. A slot missed while the app was closed or the
 * computer slept gives ONE card on the next check. While the previous card of a schedule is still open, a slot is
 * skipped instead of piling cards up. "Run with Autopilot", switched on by the owner with an explicit confirm, hands
 * each new card to Autopilot through its own checked operations. See docs/schedules.md.
 */
import { randomUUID } from 'node:crypto';
// board.mjs imports this module too. Each side uses the other's exports only inside functions, so either may load first.
import { ROUTE_STAGES } from './board.mjs';
import { serial } from './durable.mjs';
import { taskPriority } from './task-priority.mjs';
import { taskLabelIds } from './task-labels.mjs';

const SCHEDULE_LIMIT = 50;
const PROMPT_LIMIT = 20000;
const MAX_WAIT = 60000;
const LATE_MS = 2 * 60000; // A card made later than this after its time says when it was due.
const DAY = 86400000;
const ID = /^[A-Za-z0-9_-]{1,100}$/;

const fail = (message, code = 'INVALID_SCHEDULE', status = 400) => { throw Object.assign(new Error(message), { code, status }); };
const clip = (text, max = 300) => String(text || '').slice(0, max);
// The card says when it was due in the same words the Schedules list uses, for example "Tue 21 Oct, 02:00".
const when = at => new Date(at).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

/** A repeat as stored: {kind:'daily'|'weekdays', time:'HH:MM'}, {kind:'weekly', days:[0..6], time} (0 is Sunday) or {kind:'monthly', day:1..28, time}. */
export function normalizeCadence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Choose how often the schedule repeats.');
  if (typeof value.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)) fail('Choose a time between 00:00 and 23:59.');
  const { kind, time } = value;
  if (kind === 'daily' || kind === 'weekdays') return { kind, time };
  if (kind === 'weekly') {
    if (!Array.isArray(value.days) || !value.days.length || value.days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) fail('Pick at least one day of the week.');
    return { kind, days: [...new Set(value.days)].sort((a, b) => a - b), time };
  }
  // Days 1 to 28 exist in every month, so a monthly schedule never silently skips one.
  if (kind === 'monthly') return Number.isInteger(value.day) && value.day >= 1 && value.day <= 28 ? { kind, day: value.day, time } : fail('Pick a day of the month from 1 to 28.');
  return fail('Choose Daily, Weekdays, Weekly or Monthly.');
}

const fires = (cadence, at) => cadence.kind === 'daily' || (cadence.kind === 'weekdays' ? at.getDay() >= 1 && at.getDay() <= 5
  : cadence.kind === 'weekly' ? cadence.days.includes(at.getDay()) : at.getDate() === cadence.day);

/**
 * The first time after `after` (ms) that `cadence` fires, in this computer's local time zone. Each day's time comes from
 * the Date constructor, which resolves clock changes: a time the clocks skip (02:30 when they go forward) runs an hour
 * later that day, and a time that happens twice (when they go back) runs once, the first time.
 */
export function nextFire(cadence, after) {
  const [hours, minutes] = cadence.time.split(':').map(Number), from = new Date(after);
  // Every repeat fires within 31 days (the longest month for a monthly one).
  for (let offset = 0; offset <= 31; offset++) {
    const at = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset, hours, minutes);
    if (at.getTime() > after && fires(cadence, at)) return at.getTime();
  }
  return null;
}

// Slots count from the last one used, or from the last change: a schedule switched back on, or given a new time, does
// not catch up on the slots before.
const since = schedule => Math.max(schedule.lastSlot ?? 0, schedule.updatedAt ?? schedule.createdAt ?? 0);

/** The slot a schedule is due for at `now`, or null. Of several missed slots only the latest counts: one card, not one per slot. */
function dueSlot(schedule, now) {
  let slot = nextFire(schedule.cadence, since(schedule));
  if (slot === null || slot > now) return null;
  for (let next = nextFire(schedule.cadence, Math.max(slot, now - 32 * DAY)); next !== null && next <= now; next = nextFire(schedule.cadence, next)) slot = next;
  return slot;
}

/** The checked settings of a schedule from a request. On a change (`previous`), fields the request leaves out keep their value. */
function settings(input, project, previous = null) {
  const pick = (key, fallback) => (input[key] === undefined ? (previous ? previous[key] : fallback) : input[key]);
  const title = pick('title'), prompt = pick('prompt'), autopilot = pick('autopilot', false), enabled = pick('enabled', true);
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 120) fail('A title needs 1 to 120 characters.');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > PROMPT_LIMIT) fail(`The task text needs 1 to ${PROMPT_LIMIT.toLocaleString('en-US')} characters.`);
  if (typeof autopilot !== 'boolean' || typeof enabled !== 'boolean') fail('Turn a schedule and its Autopilot on or off with true or false.');
  // Agents may work on scheduled cards only in a linked code folder, and only once the owner confirmed it for this schedule.
  if (input.autopilot === true && !project.repository) fail('Connect a code folder in Project settings first. Autopilot works there.', 'REPOSITORY_REQUIRED', 409);
  if (autopilot && !previous?.autopilot && input.confirmAutopilot !== true) fail('Confirm that agents may work on this schedule’s cards without asking.', 'CONFIRMATION_REQUIRED');
  return { title: title.trim(), prompt, priority: taskPriority(pick('priority', 0)),
    // Saved labels that were removed from the project later are dropped when a card is made, not refused here.
    labelIds: input.labelIds === undefined && previous ? previous.labelIds : taskLabelIds(pick('labelIds', []), project.labels || []),
    cadence: input.cadence === undefined && previous ? previous.cadence : normalizeCadence(input.cadence), autopilot, enabled };
}

/** What a backup carries: the settings, never the record of earlier cards. */
export const exportSchedules = list => list.map(({ id, title, prompt, priority, labelIds, cadence, autopilot, enabled, createdAt, updatedAt }) => ({ id, title, prompt, priority, labelIds, cadence, autopilot, enabled, createdAt, updatedAt }));

/**
 * Schedules from a backup. They come back switched off, without Autopilot: a restored board starts nothing until the
 * owner switches each schedule on (and confirms Autopilot again) on this computer. A malformed entry is left out.
 */
export function backupSchedules(list, labels, now = Date.now()) {
  if (!Array.isArray(list)) return [];
  const ids = new Set();
  return list.slice(0, SCHEDULE_LIMIT).flatMap(item => {
    try {
      const { title, prompt, priority, cadence } = settings({ ...item, autopilot: false, enabled: false, labelIds: [] }, { labels });
      const id = typeof item.id === 'string' && ID.test(item.id) && !ids.has(item.id) ? item.id : randomUUID();
      ids.add(id);
      const labelIds = Array.isArray(item.labelIds) ? [...new Set(item.labelIds)].filter(labelId => labels.some(label => label.id === labelId)).slice(0, 20) : [];
      return [{ id, title, prompt, priority, labelIds, cadence, autopilot: false, enabled: false, createdAt: Number.isSafeInteger(item.createdAt) ? item.createdAt : now, updatedAt: now, lastFiredAt: null, lastSlot: null, lastTaskId: null }];
    } catch { return []; }
  });
}

const doneColumn = project => (project.workflowMode === 'pipeline' ? project.pipeline.columns.find(column => column.role === 'done')?.id : 'done');
/** The schedule's previous card while it is not in Done (To Do or in progress); a deleted card is not open. */
const openCard = (project, taskId) => { const task = taskId && project.tasks.find(item => item.id === taskId); return task && task.column !== doneColumn(project) ? task : null; };

export class Schedules {
  #handOffs = serial();
  constructor(board, { now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { board, now, setTimer, clearTimer, timer: null, stopped: true, busy: false, again: false });
  }

  start() { this.stopped = false; this.#arm(1000); }
  stop() { this.stopped = true; this.clearTimer(this.timer); }
  /** Check again now, for a schedule that was just added or changed. */
  wake() { if (this.busy) this.again = true; else this.#arm(0); }

  #arm(ms) {
    this.clearTimer(this.timer);
    if (this.stopped) return;
    this.timer = this.setTimer(() => this.tick().catch(() => {}), Math.max(0, Math.min(MAX_WAIT, ms)));
    this.timer?.unref?.();
  }

  /** Create the cards that are due, then sleep until the earliest next slot (at most a minute). */
  async tick() {
    if (this.busy) return;
    this.busy = true;
    let wait = MAX_WAIT;
    try {
      const now = this.now();
      for (const project of (await this.board.state()).projects) for (const schedule of project.schedules || []) {
        if (!schedule.enabled) continue;
        const slot = dueSlot(schedule, now);
        if (slot !== null) await this.fire(project.id, schedule.id, { slot }).catch(() => {});
        wait = Math.min(wait, nextFire(schedule.cadence, Math.max(since(schedule), now)) - now);
      }
    } finally {
      this.busy = false;
      this.#arm(this.again ? 0 : wait);
      this.again = false;
    }
  }

  async #project(projectId) {
    return (await this.board.state()).projects.find(item => item.id === projectId) || fail('This project does not exist. Reload the board.', 'NOT_FOUND', 404);
  }
  #view(schedule, now) { return { ...schedule, next: schedule.enabled ? nextFire(schedule.cadence, Math.max(since(schedule), now)) : null }; }

  async list(projectId) {
    const project = await this.#project(projectId), now = this.now();
    return { revision: project.revision, schedules: (project.schedules || []).map(item => this.#view(item, now)) };
  }

  async create(projectId, input) {
    const now = this.now();
    const schedule = await this.board.writeSchedules(projectId, input.expectedRevision, project => {
      const list = project.schedules || [];
      if (list.length >= SCHEDULE_LIMIT) fail(`A project can have at most ${SCHEDULE_LIMIT} schedules.`, 'LIMIT');
      const created = { id: randomUUID(), ...settings(input, project), createdAt: now, updatedAt: now, lastFiredAt: null, lastSlot: null, lastTaskId: null };
      project.schedules = [...list, created];
      return created;
    });
    this.wake();
    return schedule;
  }

  async update(projectId, scheduleId, input) {
    const schedule = await this.board.writeSchedules(projectId, input.expectedRevision, project => {
      const current = (project.schedules || []).find(item => item.id === scheduleId) || fail('This schedule no longer exists. Reload the board.', 'NOT_FOUND', 404);
      return Object.assign(current, settings(input, project, current), { updatedAt: this.now() });
    });
    this.wake();
    return schedule;
  }

  /** Delete a schedule. The cards it made stay on the board. */
  remove(projectId, scheduleId, expectedRevision) {
    return this.board.writeSchedules(projectId, expectedRevision, project => {
      if (!(project.schedules || []).some(item => item.id === scheduleId)) fail('This schedule no longer exists. Reload the board.', 'NOT_FOUND', 404);
      project.schedules = project.schedules.filter(item => item.id !== scheduleId);
      return true;
    });
  }

  /** Run now: one card at once, through the same path. The next scheduled time stays as it was. */
  runNow(projectId, scheduleId) { return this.fire(projectId, scheduleId); }

  /**
   * Create the schedule's card for `slot` (null: Run now). The slot is recorded in the same board write as the card, so
   * a check that runs twice for one slot finds it used and makes no second card. Returns the card, or null.
   */
  async fire(projectId, scheduleId, { slot = null } = {}) {
    const now = this.now(), manual = slot === null;
    const made = await this.board.writeSchedules(projectId, null, (project, createTask) => {
      const schedule = (project.schedules || []).find(item => item.id === scheduleId);
      if (!schedule) return manual ? fail('This schedule no longer exists. Reload the board.', 'NOT_FOUND', 404) : null;
      if (!manual) {
        if (!schedule.enabled || (schedule.lastSlot ?? -1) >= slot) return null;
        schedule.lastSlot = slot;
        const open = openCard(project, schedule.lastTaskId);
        if (open) { schedule.lastSkip = { at: now, reason: `previous card #${open.number} is still open` }; return null; }
      }
      try {
        const late = !manual && now - slot > LATE_MS ? `\n\n(This scheduled card was due ${when(slot)}. Promptboard was not running then, or the computer was asleep, so it was created at ${when(now)}.)` : '';
        const task = createTask({ title: schedule.title, prompt: `${schedule.prompt}${late}`, priority: schedule.priority, expectedLabelRevision: project.labelRevision,
          labelIds: schedule.labelIds.filter(id => project.labels.some(label => label.id === id)) });
        Object.assign(task, { scheduleId: schedule.id, scheduledFor: slot ?? now });
        Object.assign(schedule, { lastFiredAt: now, lastTaskId: task.id });
        delete schedule.lastSkip;
        // The hand-off replaces this note with its result at once; it stays only when the app stops before the hand-off.
        if (schedule.autopilot) schedule.lastAutopilot = { at: now, ok: false, text: 'Not handed to Autopilot (Promptboard stopped first), so the card waits in To Do' };
        else delete schedule.lastAutopilot;
        return { task: { id: task.id, number: task.number, title: task.title }, autopilot: schedule.autopilot };
      } catch (error) {
        if (manual) throw error;
        schedule.lastSkip = { at: now, reason: clip(error.message) };
        return null;
      }
    });
    // One hand-off at a time: a second one waits and then finds Autopilot running, instead of racing its start.
    if (made?.autopilot) await this.#handOffs(() => this.#handOff(projectId, scheduleId, made.task));
    return made?.task || null;
  }

  /**
   * The owner's Autopilot choice for a new card: join a running queue (Autopilot's own rules still decide when it runs),
   * start Autopilot for this card when it is off or finished, or leave the card in To Do when the owner paused it or
   * saved a queue of their own.
   */
  async #handOff(projectId, scheduleId, task) {
    let note;
    try {
      const ap = await this.board.updateAutopilot(projectId, (current, log) => {
        if (current.status !== 'running') return;
        if (!current.queue.includes(task.id)) current.queue = [...current.queue, task.id];
        log(`Scheduled card “${task.title}” joined the queue.`);
      });
      if (ap?.status === 'running') note = { ok: true, text: 'Added to the Autopilot queue' };
      else if (ap?.status === 'paused') note = { ok: false, text: 'Autopilot is paused, so the card waits in To Do' };
      else note = await this.#startAutopilot(projectId, task);
    } catch (error) { note = { ok: false, text: `Autopilot did not start: ${clip(error.message).replace(/[.\s]+$/, '')}` }; }
    await this.board.writeSchedules(projectId, null, project => {
      const schedule = (project.schedules || []).find(item => item.id === scheduleId);
      if (schedule?.lastTaskId === task.id) schedule.lastAutopilot = { at: this.now(), ...note };
    }).catch(() => {});
  }

  /**
   * The Autopilot dialog's Start, with its checks: its saved steps (or the dialog's default) and a queue of this one card.
   * A queue the owner saved, with cards still waiting in To Do, is theirs: it is never replaced or started for them.
   */
  async #startAutopilot(projectId, task) {
    const project = await this.#project(projectId), saved = project.autopilot, pipeline = project.workflowMode === 'pipeline';
    const todo = pipeline ? project.pipeline.columns.find(column => column.role === 'todo').id : 'todo', done = new Set(saved?.done || []);
    if ((saved?.queue || []).some(id => !done.has(id) && project.tasks.find(item => item.id === id)?.column === todo))
      return { ok: false, text: 'Autopilot has a queue you saved, so the card waits in To Do. Start Autopilot yourself' };
    const route = saved?.route?.length ? saved.route : pipeline ? project.pipeline.columns.filter(column => column.role === 'active').map(column => column.id) : ROUTE_STAGES;
    await this.board.setAutopilot(projectId, pipeline ? { route, queue: [task.id], expectedRevision: project.revision }
      : { route, finish: route.includes('merge') ? saved?.finish || 'merge' : 'merge', maxRework: saved?.maxRework ?? 2, queue: [task.id], routes: {}, expectedRevision: project.revision });
    await this.board.controlAutopilot(projectId, { action: 'start', confirm: true, by: `the schedule “${task.title}”` });
    return { ok: true, text: 'Autopilot started' };
  }
}

/** HTTP: GET and POST /api/projects/:id/schedules, PATCH and DELETE …/schedules/:sid, POST …/schedules/:sid/run. Changes answer with the board. */
export async function scheduleRoute(schedules, { method, projectId, scheduleId, run, body, json, view, searchParams }) {
  const changed = async result => view({ ...result, ...await schedules.list(projectId) });
  if (!scheduleId && method === 'GET') return json(await schedules.list(projectId));
  if (!scheduleId && method === 'POST') return changed({ schedule: await schedules.create(projectId, await body()) });
  if (scheduleId && !run && method === 'PATCH') return changed({ schedule: await schedules.update(projectId, scheduleId, await body()) });
  if (scheduleId && !run && method === 'DELETE') return changed({ deleted: await schedules.remove(projectId, scheduleId, Number(searchParams.get('expectedRevision'))) });
  if (scheduleId && run && method === 'POST') { await body(); return changed({ task: await schedules.runNow(projectId, scheduleId) }); }
  return false;
}
