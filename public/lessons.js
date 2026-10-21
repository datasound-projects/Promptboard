'use strict';

// Project memory: lessons from merged cards. The server suggests them after each merge (one short run with a small
// model, switchable per project) or when you choose Suggest again; nothing here calls a model. Suggestions are
// approved, edited or rejected in the card's details. The Project memory dialog, opened from the Kanban project
// settings, holds the approved lessons, the switch and, under More, the CLI and model. Origin's Project Context
// shows the same approved lessons.
window.PromptboardLessons = (() => {
  const { el, button, plural } = window.PromptboardDom;
  const KINDS = { command: 'Command', convention: 'Convention', gotcha: 'Gotcha', failed_approach: 'Failed approach' };
  const GROUPS = { command: 'Commands that worked', convention: 'Conventions', gotcha: 'Gotchas', failed_approach: 'Failed approaches' };
  const CLIS = [['', 'The card’s CLI'], ['claude', 'Claude Code'], ['codex', 'Codex'], ['gemini', 'Gemini CLI']];
  const merged = card => card?.completion?.kind === 'merged' || (card?.completion?.kind === 'pull_request' && Boolean(card.completion.mergedAt));
  const status = (text, className = 'note') => { const node = el('p', className, text); node.setAttribute('role', 'status'); return node; };

  function create(host) {
    const cache = new Map(), cards = new Map(); // Project → its memory; card → the section showing it.
    const edits = new Map(); // Lesson → its open edit draft, kept across renders.
    let shownId = null, shownRevision, syncTimer = null, dialog = null, dialogProject = null, dialogMessage = '';
    const path = projectId => `/api/projects/${encodeURIComponent(projectId)}/lessons`;
    async function load(projectId) {
      const { response, data } = await host.api(path(projectId), { timeoutMs: 15000 });
      if (!response.ok) throw new Error(data.error || 'Project memory could not be read. Try again.');
      cache.set(projectId, data);
      return data;
    }
    /** One change; the answer is the new memory, shown everywhere it is open. */
    async function change(projectId, suffix, method, body) {
      const { response, data } = await host.api(`${suffix.startsWith('/api/') ? suffix : path(projectId) + suffix}`, { method, body: { ...body, expectedRevision: cache.get(projectId)?.revision ?? 0 }, timeoutMs: 20000 });
      if (!response.ok) {
        if (response.status === 409) await load(projectId).catch(() => {});
        refresh(projectId);
        throw new Error(data.error || 'Project memory could not be changed. Nothing was saved.');
      }
      cache.set(projectId, data); refresh(projectId);
      return data;
    }
    function refresh(projectId) {
      for (const [taskId, entry] of cards) if (!entry.body.isConnected) cards.delete(taskId); else if (entry.projectId === projectId) renderCard(entry);
      if (dialog?.open && dialogProject === projectId) renderDialog();
      if (shownId === projectId) renderRow();
    }
    const taskOf = taskId => host.project()?.tasks.find(task => task.id === taskId);

    // ---- One lesson: kind, text and evidence, with its actions. In a list grouped by kind (`grouped`) the kind is the heading. ----
    function lessonNode(projectId, lesson, actions, { grouped = false } = {}) {
      const item = el('article', 'lesson'); item.dataset.status = lesson.status; item.dataset.id = lesson.id;
      const draft = edits.get(lesson.id);
      const head = el('div', 'lesson-head');
      if (!grouped && !draft) head.append(el('span', 'lesson-kind', KINDS[lesson.kind] || lesson.kind)); // While editing, the kind is a field.
      if (lesson.edited) head.append(el('span', 'lesson-badge', 'Edited'));
      if (head.childElementCount) item.append(head);
      if (draft) {
        const kind = el('select'); kind.setAttribute('aria-label', 'Kind of lesson');
        kind.append(...Object.entries(KINDS).map(([value, label]) => Object.assign(el('option', '', label), { value })));
        kind.value = draft.kind;
        const text = el('textarea', 'lesson-edit'); text.rows = 3; text.maxLength = 300; text.value = draft.text; text.setAttribute('aria-label', 'Lesson text');
        kind.addEventListener('change', () => { draft.kind = kind.value; });
        text.addEventListener('input', () => { draft.text = text.value; });
        const error = el('p', 'inline-error'); error.setAttribute('role', 'alert'); error.hidden = true;
        const save = button('Save', async () => {
          save.disabled = true;
          try { await change(projectId, `/${encodeURIComponent(lesson.id)}`, 'PATCH', { text: draft.text, kind: draft.kind }); edits.delete(lesson.id); host.announce('Lesson saved.'); refresh(projectId); }
          catch (failure) { error.textContent = failure.message; error.hidden = false; save.disabled = false; }
        }, 'danger');
        item.append(kind, text, error, el('div', 'detail-actions lesson-actions'));
        item.lastChild.append(save, button('Cancel', () => { edits.delete(lesson.id); refresh(projectId); }, 'text-button'));
        if (draft.focus) { draft.focus = false; queueMicrotask(() => text.focus()); }
        return item;
      }
      item.append(el('p', 'lesson-text', lesson.text));
      if (lesson.evidence) item.append(el('p', 'lesson-evidence', `Evidence: ${lesson.evidence}`));
      const row = el('div', grouped ? 'lesson-links' : 'detail-actions lesson-actions');
      for (const [label, run, className, title] of actions) row.append(button(label, run, className, title));
      item.append(row);
      return item;
    }
    const editAction = (projectId, lesson) => ['Edit', () => { edits.set(lesson.id, { text: lesson.text, kind: lesson.kind, focus: true }); refresh(projectId); }, 'text-button', 'Change the text or kind'];
    async function decide(projectId, lesson, next, message, error) {
      try { await change(projectId, `/${encodeURIComponent(lesson.id)}`, 'PATCH', { status: next }); host.announce(message); }
      catch (failure) { error(failure.message); }
    }

    // ---- Task details: "Suggested lessons" of a merged card ----
    function taskSection(card, section) {
      const projectId = host.project()?.id;
      if (!merged(card) || !projectId) return [];
      const body = el('div', 'lessons-card'); body.tabIndex = -1; body.append(status('Loading lessons…'));
      const box = section('Suggested lessons', body); box.id = 'task-lessons';
      const entry = { taskId: card.id, projectId, body, error: '' };
      cards.set(card.id, entry);
      load(projectId).then(() => renderCard(entry), failure => { entry.error = failure.message; renderCard(entry); });
      return [box];
    }
    function renderCard(entry) {
      const { body, projectId, taskId } = entry, data = cache.get(projectId);
      clearTimeout(entry.poll);
      if (cards.get(taskId) !== entry) return; // The details were opened again since.
      const nodes = [];
      const fail = message => { entry.error = message; renderCard(entry); };
      if (!data) { body.replaceChildren(el('p', 'inline-error', entry.error || 'Project memory could not be read.')); return; }
      const job = data.jobs.find(item => item.taskId === taskId), mine = data.lessons.filter(item => item.taskId === taskId);
      const suggested = mine.filter(item => item.status === 'suggested'), approved = mine.filter(item => item.status === 'approved');
      const busy = ['queued', 'running'].includes(job?.status);
      if (job?.status === 'running') nodes.push(status('Suggesting lessons…', 'note lessons-working'));
      else if (job?.status === 'queued') nodes.push(status('Waiting for a free CLI slot to suggest lessons…', 'note lessons-working'));
      else if (job?.status === 'failed') nodes.push(status(`Lessons could not be suggested: ${job.reason}`, 'inline-error'));
      else if (!suggested.length && !approved.length) nodes.push(status(job ? 'No new lessons from this card.' : 'No lessons were suggested for this card.'));
      if (suggested.length) {
        const lead = el('div', 'lessons-lead');
        lead.append(el('p', 'note', `${plural(suggested.length, 'suggestion')} to review. Approved lessons go to every new agent in this project.`),
          button('Approve all', async () => {
            try { await change(projectId, '/approve', 'POST', { ids: suggested.map(item => item.id) }); host.announce(`${plural(suggested.length, 'lesson')} approved.`); }
            catch (failure) { fail(failure.message); }
          }, 'secondary-button lessons-approve-all'));
        nodes.push(lead);
        const list = el('div', 'lessons-list');
        list.append(...suggested.map(lesson => lessonNode(projectId, lesson, [
          ['Approve', () => decide(projectId, lesson, 'approved', 'Lesson approved.', fail), 'danger lesson-approve'],
          editAction(projectId, lesson),
          ['Reject', () => decide(projectId, lesson, 'rejected', 'Lesson rejected. It is not suggested again.', fail), 'text-button lesson-reject'],
        ])));
        nodes.push(list);
      }
      if (approved.length) nodes.push(el('p', 'note', `${plural(approved.length, 'approved lesson')} from this card.`));
      const actions = el('div', 'detail-actions');
      if (!busy && !suggested.length) {
        const again = button(job ? 'Suggest again' : 'Suggest lessons', async () => {
          again.disabled = true;
          try { await change(projectId, `/api/tasks/${encodeURIComponent(taskId)}/lessons`, 'POST', {}); host.announce('Suggesting lessons for this card.'); }
          catch (failure) { fail(failure.message); }
        }, 'secondary-button lessons-again', 'One short run with a small model reads this card’s results.');
        actions.append(again);
      }
      actions.append(button('Open Project memory', () => open(projectId), 'text-button'));
      nodes.push(actions);
      if (entry.error) { const error = el('p', 'inline-error', entry.error); error.setAttribute('role', 'alert'); nodes.push(error); entry.error = ''; }
      const focused = body.contains(document.activeElement);
      body.replaceChildren(...nodes);
      if (focused) (body.querySelector('textarea, button:not(:disabled)') || body).focus();
      // While the suggestion runs, look again every few seconds; nothing is read once the details close.
      if (busy) entry.poll = setTimeout(() => { if (body.isConnected) load(projectId).then(() => refresh(projectId), () => {}); }, 2500);
    }

    // ---- Kanban project settings: one row that opens the Project memory dialog ----
    const row = el('div', 'toolbar-cell settings-row lessons-row'); row.id = 'lessons-row';
    const summary = el('p', 'toolbar-value', ''); summary.id = 'lessons-summary';
    const openButton = button('Open', () => shownId && open(shownId), 'text-button', 'Lessons from finished cards for the next agents');
    openButton.id = 'lessons-open'; openButton.setAttribute('aria-haspopup', 'dialog'); openButton.setAttribute('aria-label', 'Open Project memory');
    row.append(el('span', 'field-label settings-label', 'Memory'), summary, openButton);
    const columnsRow = document.getElementById('workflow-open')?.closest('.settings-row');
    if (columnsRow) columnsRow.after(row); else document.querySelector('#project-body .kanban-toolbar')?.append(row);
    function rowText(data) {
      if (!data) return '…';
      const approved = data.lessons.filter(item => item.status === 'approved').length, pending = data.lessons.filter(item => item.status === 'suggested').length;
      if (!approved && !pending) return data.settings.enabled ? 'No lessons yet' : 'Off';
      return [plural(approved, 'lesson'), ...(pending ? [`${pending} new`] : []), ...(data.settings.enabled ? [] : ['off'])].join(' · ');
    }
    function renderRow() { row.hidden = !shownId; summary.textContent = rowText(cache.get(shownId)); summary.title = summary.textContent; }
    const working = data => data?.jobs.some(job => ['queued', 'running'].includes(job.status));
    /** Read the shown project's memory after `delay`; while a suggestion runs, again every few seconds. */
    function reload(id, delay) {
      clearTimeout(syncTimer);
      syncTimer = setTimeout(async () => {
        await load(id).catch(() => {});
        if (shownId !== id) return;
        refresh(id);
        if (working(cache.get(id))) reload(id, 4000);
      }, delay);
    }
    /** The board shows `project`: its memory is read when the project or the board changes (a merge queues suggestions). */
    function sync(project, revision) {
      const id = project?.id || null;
      if (id !== shownId) { shownId = id; shownRevision = undefined; clearTimeout(syncTimer); }
      renderRow();
      if (!id || revision === shownRevision) return;
      shownRevision = revision;
      reload(id, cache.has(id) ? 1500 : 0);
    }

    // ---- The Project memory dialog ----
    function ensureDialog() {
      if (dialog) return dialog;
      dialog = el('dialog', 'kanban-dialog lessons-dialog'); dialog.id = 'lessons-dialog'; dialog.setAttribute('aria-labelledby', 'lessons-heading');
      document.body.append(dialog);
      dialog.addEventListener('close', () => { dialogMessage = ''; });
      return dialog;
    }
    async function open(projectId) {
      ensureDialog(); dialogProject = projectId; dialogMessage = '';
      renderDialog();
      if (!dialog.open) dialog.showModal(); // Focus starts on Close, as in the app's other dialogs.
      await load(projectId).catch(failure => { dialogMessage = failure.message; });
      if (dialogProject === projectId) renderDialog();
    }
    function renderDialog() {
      const projectId = dialogProject, data = cache.get(projectId), project = (host.projects?.() || []).find(item => item.id === projectId) || host.project();
      const close = button('×', () => dialog.close(), 'dialog-close icon-button'); close.id = 'lessons-close'; close.setAttribute('aria-label', 'Close Project memory');
      const heading = el('h2', '', 'Project memory'); heading.id = 'lessons-heading';
      const nodes = [close, el('p', 'eyebrow', String(project?.name || 'PROJECT').toUpperCase()), heading,
        el('p', 'note', 'Lessons from finished cards: commands that worked, conventions, gotchas and failed approaches. Approved lessons go to every new agent in this project.')];
      const message = el('p', 'inline-error'); message.setAttribute('role', 'alert'); message.hidden = !dialogMessage; message.textContent = dialogMessage;
      if (!data) { nodes.push(status('Loading project memory…'), message); dialog.replaceChildren(...nodes); return; }
      const say = text => { dialogMessage = text; renderDialog(); };
      // The switch: on by default.
      const toggle = el('label', 'check-row lessons-switch'), box = el('input'); box.type = 'checkbox'; box.id = 'lessons-enabled'; box.checked = data.settings.enabled;
      toggle.append(box, ' Suggest lessons after each merged card');
      box.addEventListener('change', async () => {
        box.disabled = true;
        try { await change(projectId, '/settings', 'PATCH', { enabled: box.checked }); host.announce(box.checked ? 'Lessons are suggested after each merged card.' : 'Lessons are no longer suggested automatically.'); }
        catch (failure) { say(failure.message); }
      });
      nodes.push(el('div', 'lessons-setting'));
      nodes.at(-1).append(toggle, el('p', 'note', 'One short run with a small model after each merged card.'));
      // Suggestions waiting, each linked to its card.
      const pending = data.lessons.filter(item => item.status === 'suggested');
      if (pending.length) {
        const byCard = new Map();
        for (const lesson of pending) byCard.set(lesson.taskId, [...(byCard.get(lesson.taskId) || []), lesson]);
        const list = el('ul', 'lessons-pending'); list.setAttribute('aria-label', 'Suggestions to review');
        for (const [taskId, lessons] of byCard) {
          const task = taskOf(taskId), item = el('li');
          if (task) item.append(button(`${task.number ? `#${task.number} ` : ''}${task.title}`, () => { dialog.close(); host.openTask(taskId); }, 'text-button lessons-card-link', 'Review in the card’s details'), el('span', 'lessons-count', plural(lessons.length, 'suggestion')));
          else {
            // The card was deleted: its suggestions are reviewed here instead.
            const decided = el('div', 'lessons-list');
            decided.append(...lessons.map(lesson => lessonNode(projectId, lesson, [['Approve', () => decide(projectId, lesson, 'approved', 'Lesson approved.', say), 'danger lesson-approve'], editAction(projectId, lesson),
              ['Reject', () => decide(projectId, lesson, 'rejected', 'Lesson rejected. It is not suggested again.', say), 'text-button lesson-reject']])));
            item.append(el('span', 'lessons-count', `${lessons[0].taskNumber ? `#${lessons[0].taskNumber}, ` : ''}a deleted card`), decided);
          }
          list.append(item);
        }
        nodes.push(el('h3', '', `${plural(pending.length, 'suggestion')} to review`), list);
      }
      // Approved lessons, grouped by kind.
      const approved = data.lessons.filter(item => item.status === 'approved');
      nodes.push(el('h3', '', approved.length ? `${plural(approved.length, 'approved lesson')}` : 'Approved lessons'));
      if (!approved.length) nodes.push(el('p', 'note', 'None yet. After a card merges, its suggestions appear in the card’s details for you to approve.'));
      for (const [kind, title] of Object.entries(GROUPS)) {
        const group = approved.filter(item => item.kind === kind).sort((a, b) => (b.decidedAt || 0) - (a.decidedAt || 0));
        if (!group.length) continue;
        const list = el('div', 'lessons-list'); list.setAttribute('aria-label', title);
        list.append(...group.map(lesson => lessonNode(projectId, lesson, [editAction(projectId, lesson),
          ['Remove', () => decide(projectId, lesson, 'rejected', 'Lesson removed. Agents no longer receive it.', say), 'text-button lesson-remove', 'Agents stop receiving it; it is not suggested again']], { grouped: true })));
        nodes.push(el('h4', 'lessons-group', title), list);
      }
      // More: the CLI and model of the suggestions.
      const more = el('details', 'lessons-more'); more.id = 'lessons-more';
      more.append(el('summary', '', 'More'));
      const cli = el('select'); cli.id = 'lessons-provider';
      cli.append(...CLIS.map(([value, label]) => Object.assign(el('option', '', label), { value })));
      cli.value = data.settings.provider || '';
      const model = el('input'); model.id = 'lessons-model'; model.type = 'text'; model.maxLength = 100; model.autocomplete = 'off'; model.spellcheck = false; model.value = data.settings.model || '';
      const hint = () => { const fixed = data.defaults?.[cli.value]; model.disabled = !cli.value; model.placeholder = cli.value ? `Default: ${fixed?.model || 'the CLI’s own model'}${fixed?.effort ? `, ${fixed.effort} effort` : ''}` : 'Smallest model of the card’s CLI'; if (!cli.value) model.value = ''; };
      cli.addEventListener('change', hint); hint();
      const field = (label, control) => { const node = el('label', 'field-label'); node.append(label, control); return node; };
      const save = button('Save', async () => {
        save.disabled = true;
        try { await change(projectId, '/settings', 'PATCH', { provider: cli.value, model: model.value.trim() }); host.announce('Project memory settings saved.'); }
        catch (failure) { say(failure.message); }
      }, 'secondary-button');
      save.id = 'lessons-settings-save';
      more.append(el('p', 'note', 'By default lessons are written by the CLI that executed the card, with its smallest model: Claude Code with Haiku, Codex with low effort, Gemini CLI with Flash. Antigravity cannot run without tools, so choose another CLI for its cards.'),
        el('div', 'lessons-more-fields'), save);
      more.children[2].append(field('CLI', cli), field('Model', model));
      nodes.push(more, message);
      const active = document.activeElement, inside = active !== dialog && dialog.contains(active), focused = inside && active.id;
      dialog.replaceChildren(...nodes);
      heading.tabIndex = -1;
      // Focus stays on the same control, or comes back to the heading when that control is gone.
      if (inside) (focused && dialog.querySelector(`#${CSS.escape(focused)}`) || dialog.querySelector('.lesson-edit') || heading).focus();
      if (more.open !== (dialog.dataset.more === 'open')) more.open = dialog.dataset.more === 'open';
      more.addEventListener('toggle', () => { dialog.dataset.more = more.open ? 'open' : ''; });
    }

    // ---- Origin: "Lessons from finished work" in the Project Context screen ----
    /** The approved lessons of the board linked to this Origin project (its stored link or the same ID), read-only. */
    function contextPanel(originProject, boardProjects = []) {
      const board = boardProjects.find(item => item.id === originProject?.kanbanProjectId) || boardProjects.find(item => item.id === originProject?.id), id = board?.id;
      if (!board) return null;
      const box = el('details', 'lessons-context'); box.id = 'origin-context-lessons';
      const title = el('summary', '', 'Lessons from finished work'), content = el('div', 'lessons-context-body');
      content.append(status('Loading lessons…', 'origin-hint'));
      box.append(title, content);
      load(id).then(data => {
        const approved = data.lessons.filter(item => item.status === 'approved');
        title.textContent = `Lessons from finished work (${approved.length})`;
        const nodes = [el('p', 'origin-hint', approved.length ? 'Approved in Kanban from merged cards. Every new agent in this project receives them. They are not part of this document.' : 'None approved yet. They are suggested in Kanban after each merged card.')];
        for (const [kind, label] of Object.entries(GROUPS)) {
          const group = approved.filter(item => item.kind === kind);
          if (!group.length) continue;
          const list = el('ul', 'lessons-context-list');
          list.append(...group.map(item => el('li', '', item.text)));
          nodes.push(el('p', 'lessons-group', label), list);
        }
        nodes.push(button('Manage in Kanban', () => host.openKanban(id, () => open(id)), 'origin-link'));
        content.replaceChildren(...nodes);
      }, failure => content.replaceChildren(el('p', 'origin-inline-error', failure.message)));
      return box;
    }

    return { taskSection, sync, open, contextPanel };
  }
  return { create };
})();
