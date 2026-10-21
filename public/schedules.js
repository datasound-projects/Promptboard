'use strict';

// Schedules: recurring To Do cards of the open project (Kanban board actions → Schedules). The list says each schedule's
// repeat in words, when it runs next and what happened last time; the editor keeps the essentials in view and priority
// and labels under More. The app on the computer makes the cards, only while it runs (src/schedules.mjs).
window.PromptboardSchedules = (() => {
  const { el, button } = window.PromptboardDom;
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const WEEK = [1, 2, 3, 4, 5, 6, 0]; // Shown Monday first; 0 is Sunday, as the server stores it.
  const PRIORITIES = ['None', 'Low', 'Medium', 'High', 'Urgent'];
  const QUICK_STARTS = [
    { title: 'Nightly dependency update', cadence: { kind: 'daily', time: '02:00' }, prompt: `Check this project's dependencies for updates and apply the safe ones.

1. Find the package manager and lock file the project uses (for example package.json with package-lock.json, requirements.txt, go.mod or Cargo.toml).
2. List the outdated dependencies. Update patch and minor versions within the ranges the project allows. Do not change major versions: list them in your report instead.
3. Install, then run the project's tests and build. If an update breaks something you cannot fix quickly, undo that update and note why.
4. Commit the changed manifest and lock file together, with a message that lists the updates.
5. Report what you updated, what you left out and why, and the test results.

If everything is already up to date, change nothing and say so.` },
    { title: 'Weekly docs sweep', cadence: { kind: 'weekly', days: [1], time: '03:00' }, prompt: `Check that the project's documentation still matches the code.

1. Read the README and any docs folder, and compare them with the current code: setup steps, commands, configuration, options and examples.
2. Fix what is wrong or out of date, such as renamed commands, removed options, broken links inside the repository and examples that no longer run.
3. Keep the existing style and structure. Leave correct sections as they are and add no new documents.
4. Run the documentation checks the project has (for example a link check or a docs build), and the tests if you changed code examples.
5. Report each change and why you made it.

If the documentation is already accurate, change nothing and say so.` },
    { title: 'Weekly security sweep', cadence: { kind: 'weekly', days: [3], time: '03:00' }, prompt: `Look for security problems in this project and fix the clear ones.

1. Run the dependency audit of the project's package manager if it is installed (for example npm audit, pip-audit or cargo audit), and note known vulnerable versions.
2. Search the code for secrets committed by mistake (keys, tokens, passwords), input that reaches SQL, shell commands or HTML without escaping, and actions that skip the check of who may do them.
3. Fix problems that have a clear, low-risk fix, and add or update a test for each fix. Never print or copy a secret you find: name the file and line, and say that it must be rotated.
4. Run the project's tests.
5. Report what you checked, what you fixed, and what needs a person's decision.

If you find nothing that needs changing, change nothing and say so.` },
  ];
  // The same words the server writes into a late card, for example "Tue 21 Oct, 02:00".
  const when = at => new Date(at).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  const ordinal = n => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
  const and = words => (words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0]);

  /** "Every weekday at 02:00", "Every Mon, Wed and Fri at 09:00", "On the 1st of every month at 08:30". */
  function repeatText(cadence) {
    const at = `at ${cadence.time}`;
    if (cadence.kind === 'daily' || (cadence.kind === 'weekly' && cadence.days.length === 7)) return `Every day ${at}`;
    if (cadence.kind === 'weekdays') return `Every weekday ${at}`;
    if (cadence.kind === 'monthly') return `On the ${ordinal(cadence.day)} of every month ${at}`;
    return `Every ${and(WEEK.filter(day => cadence.days.includes(day)).map(day => (cadence.days.length > 1 ? DAY_NAMES[day].slice(0, 3) : DAY_NAMES[day])))} ${at}`;
  }

  /** What the schedule did last: "Created #12 · Autopilot started", or "Skipped: previous card #11 is still open". */
  function lastResult(schedule, project) {
    if (schedule.lastSkip) return { text: `Skipped: ${schedule.lastSkip.reason}`, warn: true };
    if (!schedule.lastTaskId) return { text: 'No card yet', warn: false };
    const card = project?.tasks.find(task => task.id === schedule.lastTaskId), autopilot = schedule.lastAutopilot;
    const made = card ? `Created #${card.number}` : 'Created a card, since deleted';
    return { text: autopilot ? `${made} · ${autopilot.text}` : made, warn: Boolean(autopilot && !autopilot.ok) };
  }

  const field = (text, control, hint = '') => { const label = el('label', 'field-label', text); label.append(control); if (hint) label.append(el('small', '', hint)); return label; };
  const control = (tag, id, props = {}) => Object.assign(el(tag), { id, ...props });
  const option = (value, text, selected) => Object.assign(el('option', '', text), { value: String(value), selected });

  function create({ api, announce, project, acceptBoard }) {
    const dialog = el('dialog', 'kanban-dialog schedules-dialog');
    dialog.id = 'schedules-dialog'; dialog.setAttribute('aria-labelledby', 'schedules-heading');
    const close = button('×', () => dialog.close(), 'dialog-close icon-button'); close.setAttribute('aria-label', 'Close schedules');
    const eyebrow = el('p', 'eyebrow'), heading = el('h2', '', 'Schedules'), body = el('div', 'schedules-body'), status = el('p', 'note schedules-status');
    heading.id = 'schedules-heading'; status.setAttribute('role', 'status');
    dialog.append(close, eyebrow, heading, body, status);
    document.body.append(dialog);
    let projectId = null, data = { revision: null, schedules: [] };

    const path = (rest = '') => `/api/projects/${encodeURIComponent(projectId)}/schedules${rest}`;
    async function load() {
      const { response, data: answer } = await api(path());
      if (!response.ok) throw new Error(answer.error || 'The schedules could not be loaded.');
      data = answer;
    }
    // Every change answers with the fresh list (with next times) and the board, so cards and markers update at once.
    async function call(method, rest, payload) {
      const { response, data: answer } = await api(path(rest), { method, body: payload, timeoutMs: 30000 });
      if (answer.board) acceptBoard(answer.board);
      if (Array.isArray(answer.schedules)) data = { revision: answer.revision, schedules: answer.schedules };
      if (!response.ok) {
        if (answer.code === 'REVISION_CONFLICT') await load().catch(() => {}); // The list is current again; trying once more works.
        throw new Error(answer.error || 'The schedule could not be saved.');
      }
      return answer;
    }

    async function open() {
      const current = project();
      if (!current) return;
      projectId = current.id;
      eyebrow.textContent = `${current.name} · Schedules`.toUpperCase();
      status.textContent = '';
      body.replaceChildren(el('p', 'note', 'Loading schedules…'));
      if (!dialog.open) dialog.showModal();
      try { await load(); showList(); }
      catch (error) { showList('', error.message); }
      dialog.querySelector('.schedule-item input, #schedule-new')?.focus();
    }

    function showList(message = '', error = '') {
      const current = project(), list = el('ul', 'schedule-list');
      list.append(...data.schedules.map(schedule => row(schedule, current)));
      const add = button('New schedule', () => showEditor(), 'dialog-done'); add.id = 'schedule-new';
      const failure = el('p', 'inline-error', error); failure.setAttribute('role', 'alert'); failure.hidden = !error;
      const empty = el('div', 'schedule-empty'), actions = el('div', 'kanban-dialog-actions');
      empty.append(el('p', 'note', 'No schedules yet. Start from one of these, or make your own.'), quickStarts());
      actions.append(add);
      body.replaceChildren(el('p', 'note schedule-lede', 'Cards that land in To Do on a repeat, for example a nightly dependency update. Promptboard makes them while it is open; a time missed while it was closed gives one card when it opens again.'),
        data.schedules.length ? list : empty, failure, actions);
      status.textContent = message;
    }

    function quickStarts() {
      const box = el('div', 'schedule-quick');
      box.append(el('span', 'note', 'Start from'), ...QUICK_STARTS.map(preset => button(preset.title, () => showEditor(null, preset), 'secondary-button')));
      return box;
    }

    function row(schedule, current) {
      const item = el('li', 'schedule-item'); item.dataset.id = schedule.id;
      const toggle = control('input', `schedule-on-${schedule.id}`, { type: 'checkbox', className: 'base-switch', checked: schedule.enabled });
      toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-label', `“${schedule.title}” makes cards`);
      toggle.addEventListener('change', () => act(toggle, () => call('PATCH', `/${schedule.id}`, { enabled: toggle.checked, expectedRevision: data.revision }),
        toggle.checked ? `“${schedule.title}” is on.` : `“${schedule.title}” is off. It makes no cards until you switch it on.`));
      const result = lastResult(schedule, current), text = el('div', 'schedule-text');
      text.append(el('strong', 'schedule-title', schedule.title),
        el('span', 'schedule-when', `${repeatText(schedule.cadence)} · ${schedule.enabled && schedule.next ? `Next ${when(schedule.next)}` : 'Off'}${schedule.autopilot ? ' · With Autopilot' : ''}`),
        el('span', `schedule-last${result.warn ? ' warn' : ''}`, result.text));
      const named = (node, id, label) => { node.id = `${id}-${schedule.id}`; node.setAttribute('aria-label', label); return node; };
      const run = named(button('Run now', () => act(run, () => call('POST', `/${schedule.id}/run`, {}), answer => `Created #${answer.task.number} “${answer.task.title}” in To Do.`), 'secondary-button'), 'schedule-run', `Run “${schedule.title}” now`);
      const actions = el('div', 'schedule-actions');
      actions.append(run, named(button('Edit', () => showEditor(schedule), 'secondary-button'), 'schedule-edit', `Edit “${schedule.title}”`),
        named(button('Delete', () => confirmDelete(actions, schedule), 'secondary-button'), 'schedule-delete', `Delete “${schedule.title}”`));
      item.append(toggle, text, actions);
      return item;
    }

    /** One change from the list: the list redraws with the result and keeps focus on the same control. */
    async function act(node, work, message) {
      node.disabled = true;
      try { const answer = await work(); const text = typeof message === 'function' ? message(answer) : message; showList(text); announce(text); }
      catch (error) { showList('', error.message); }
      (document.getElementById(node.id) || document.getElementById('schedule-new'))?.focus();
    }

    function confirmDelete(actions, schedule) {
      const box = el('div', 'schedule-confirm');
      const yes = button('Delete schedule', () => act(yes, () => call('DELETE', `/${schedule.id}?expectedRevision=${data.revision}`), `“${schedule.title}” was deleted. The cards it made stay on the board.`), 'secondary-button');
      yes.id = 'schedule-delete-confirm';
      const no = button('Cancel', () => { showList(); document.getElementById(`schedule-delete-${schedule.id}`)?.focus(); }, 'secondary-button');
      box.append(el('p', '', `Delete “${schedule.title}”? The cards it made stay on the board.`), yes, no);
      actions.replaceWith(box);
      no.focus();
    }

    /** The editor: what and when first; Autopilot with its one-time confirm; priority and labels under More. */
    function showEditor(schedule = null, preset = null) {
      const current = project();
      const draft = schedule || { title: '', prompt: '', priority: 0, labelIds: [], cadence: { kind: 'daily', time: '09:00' }, autopilot: false, ...preset }; // Read only.
      const form = el('form', 'schedule-form'); form.noValidate = true;
      const title = control('input', 'schedule-title', { value: draft.title, maxLength: 120, autocomplete: 'off' });
      const prompt = control('textarea', 'schedule-prompt', { value: draft.prompt, rows: 8 });
      const kind = control('select', 'schedule-kind');
      kind.append(...[['daily', 'Daily'], ['weekdays', 'Weekdays (Monday to Friday)'], ['weekly', 'Weekly'], ['monthly', 'Monthly']].map(([value, text]) => option(value, text, draft.cadence.kind === value)));
      const time = control('input', 'schedule-time', { type: 'time', value: draft.cadence.time, required: true });
      const days = el('fieldset', 'schedule-days'), dayInputs = {};
      days.append(el('legend', '', 'On'), el('div', 'route-chips'));
      for (const day of WEEK) {
        const chip = el('label', 'route-chip'), box = control('input', `schedule-day-${day}`, { type: 'checkbox', checked: (draft.cadence.days || [1]).includes(day) });
        box.setAttribute('aria-label', DAY_NAMES[day]); dayInputs[day] = box;
        chip.append(box, el('span', '', DAY_NAMES[day].slice(0, 3)));
        days.lastChild.append(chip);
      }
      const monthDay = control('select', 'schedule-month-day');
      for (let day = 1; day <= 28; day++) monthDay.append(option(day, ordinal(day), (draft.cadence.day || 1) === day));
      const monthField = field('Day of the month', monthDay, 'Days 1 to 28 exist in every month.');
      const repeat = el('div', 'select-grid schedule-repeat');
      repeat.append(field('Repeat', kind), field('Time', time, 'This computer’s time.'));
      const shape = () => { days.hidden = kind.value !== 'weekly'; monthField.hidden = kind.value !== 'monthly'; };
      kind.addEventListener('change', shape); shape();

      // Agents run without asking only after the owner confirms it once for this schedule; the server checks it too.
      let confirmed = false;
      const linked = Boolean(current?.repository);
      const autopilot = control('input', 'schedule-autopilot', { type: 'checkbox', className: 'base-switch', checked: draft.autopilot, disabled: !linked && !draft.autopilot });
      autopilot.setAttribute('role', 'switch');
      const autopilotOption = el('label', 'check-option schedule-autopilot'), words = el('span');
      words.append(el('strong', '', 'Run with Autopilot'), el('small', '', linked ? 'Agents then work on each new card on their own, without asking you.' : 'Connect a code folder in Project settings first. Autopilot works there.'));
      autopilotOption.append(autopilot, words);
      const consent = el('div', 'schedule-consent'); consent.hidden = true;
      const yes = button('Turn on Autopilot', () => { confirmed = true; autopilot.checked = true; consent.hidden = true; autopilot.focus(); }, 'secondary-button');
      const no = button('Keep it off', () => { consent.hidden = true; autopilot.focus(); }, 'secondary-button');
      consent.append(el('p', '', 'Agents will work on every card this schedule makes, without asking you first, the way Autopilot works on its queue. Turn it on?'), yes, no);
      autopilot.addEventListener('change', () => {
        if (!autopilot.checked || draft.autopilot || confirmed) return;
        autopilot.checked = false; consent.hidden = false; yes.focus();
      });

      const priority = control('select', 'schedule-priority');
      priority.append(...PRIORITIES.map((text, value) => option(value, text, draft.priority === value)));
      const labels = el('fieldset', 'schedule-labels'), labelInputs = new Map();
      labels.append(el('legend', '', 'Labels'));
      for (const label of current?.labels || []) {
        const choice = el('label', 'check-option'), box = control('input', `schedule-label-${label.id}`, { type: 'checkbox', checked: draft.labelIds.includes(label.id) });
        labelInputs.set(label.id, box); choice.append(box, el('span', '', label.name)); labels.append(choice);
      }
      if (!labelInputs.size) labels.append(el('p', 'note', 'This project has no labels yet.'));
      const more = el('details', 'schedule-more');
      more.append(el('summary', '', 'More'), field('Priority', priority), labels);

      const failure = el('p', 'inline-error'); failure.setAttribute('role', 'alert'); failure.hidden = true;
      const showFailure = message => { failure.textContent = message; failure.hidden = false; };
      const save = Object.assign(el('button', 'dialog-done', 'Save schedule'), { type: 'submit', id: 'schedule-save' });
      const cancel = button('Cancel', () => { showList(); document.getElementById(schedule ? `schedule-edit-${schedule.id}` : 'schedule-new')?.focus(); }, 'secondary-button');
      const actions = el('div', 'kanban-dialog-actions'); actions.append(cancel, save);
      form.append(...(schedule ? [] : [quickStarts()]), field('Title', title), field('Task', prompt, 'What the agent should do each time. Each run gets this text on a new card.'), repeat, days, monthField, autopilotOption, consent, more, failure, actions);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        failure.hidden = true;
        const cadence = { kind: kind.value, time: time.value, ...(kind.value === 'weekly' ? { days: WEEK.filter(day => dayInputs[day].checked) } : {}), ...(kind.value === 'monthly' ? { day: Number(monthDay.value) } : {}) };
        if (!title.value.trim()) { showFailure('Give the schedule a title.'); title.focus(); return; }
        if (!prompt.value.trim()) { showFailure('Write what the agent should do.'); prompt.focus(); return; }
        if (!time.value) { showFailure('Choose a time.'); time.focus(); return; }
        if (cadence.kind === 'weekly' && !cadence.days.length) { showFailure('Pick at least one day.'); dayInputs[1].focus(); return; }
        save.disabled = true;
        try {
          const answer = await call(schedule ? 'PATCH' : 'POST', schedule ? `/${schedule.id}` : '', { title: title.value, prompt: prompt.value, cadence, priority: Number(priority.value),
            labelIds: [...labelInputs].filter(([, box]) => box.checked).map(([id]) => id), autopilot: autopilot.checked, ...(confirmed ? { confirmAutopilot: true } : {}), expectedRevision: data.revision });
          const saved = data.schedules.find(item => item.id === answer.schedule.id);
          const message = `“${saved.title}” saved.${saved.enabled && saved.next ? ` Its next card comes ${when(saved.next)}.` : ''}`;
          showList(message); announce(message);
          document.getElementById(`schedule-edit-${saved.id}`)?.focus();
        } catch (error) { showFailure(error.message); save.disabled = false; }
      });
      body.replaceChildren(form);
      status.textContent = '';
      title.focus();
    }

    document.getElementById('schedules-open')?.addEventListener('click', () => void open());

    /** For task details: which schedule made this card, and for when. */
    function detail(card, current) {
      const schedule = (current?.schedules || []).find(item => item.id === card.scheduleId);
      return el('p', 'note', `${schedule ? `Made by the schedule “${schedule.title}”` : 'Made by a schedule that was deleted since'}, for ${when(card.scheduledFor)}.`);
    }
    return { open, detail };
  }

  return { create, repeatText };
})();
