'use strict';

// Compose Batch: the Batch side of Compose's Single | Batch switch. A queue of Origin tasks on the left, the
// selected task's prompt, findings and actions on the right, and batch-wide settings, dependencies and quality
// in one collapsed panel. The server runs and checks every task; this page only shows state and sends choices.
// All text is set as text. Nothing runs until Run is chosen, and nothing reaches Kanban unless approved.
window.PromptboardBatch = (() => {
  const { el, button, plural, clip, pref, setPref, duration, left, estimate, remaining, meter } = window.PromptboardDom;
  const STATES = {
    pending: ['Pending', 'muted'], queued: ['Queued', 'muted'], running: ['Running', 'accent'], generated: ['Generated', 'ok'], review: ['Needs review', 'warn'],
    approved: ['Approved', 'ok'], failed: ['Failed', 'error'], rejected: ['Rejected', 'muted'], sent: ['On Kanban', 'ok'],
  };
  const FILTERS = [['all', 'All tasks'], ['review', 'Needs review'], ['generated', 'Generated'], ['approved', 'Approved'], ['failed', 'Failed'], ['pending', 'Pending'], ['running', 'Running'], ['rejected', 'Rejected'], ['sent', 'On Kanban']];
  const STAGES = { models: 'checking models', draft: 'drafting', review: 'reviewing', repair: 'revising', 'repair-review': 'rechecking', split: 'splitting' };
  const SEVERITY = { blocking: 'Blocks approval', warning: 'Read before approving', info: 'Note' };
  const BOOL = [[true, 'On'], [false, 'Off']];
  const KEY = 'promptboard.compose.batch';

  function create(app) {
    const root = document.getElementById('batch-view');
    let batches = [], batchId = pref(KEY, ''), batch = null, item = null, selectedId = '', filter = 'all', checked = new Set(), visible = false;
    let timer = null, polling = false, error = '', message = null, draft = null, splitDrafts = new Map(), regions = null;
    const openDetails = new Set(); // Which collapsible parts are open survives every redraw.

    const call = async (path, options = {}) => {
      const { response, data } = await app.api(`/api/compose/batches${path}`, { timeoutMs: 60000, ...options });
      if (!response.ok) throw Object.assign(new Error(typeof data.error === 'string' ? data.error : 'The batch request failed.'), { data, status: response.status });
      return data;
    };
    const chip = state => { const [label, tone] = STATES[state] || [state, 'muted']; return el('span', `batch-chip ${tone}`, label); };
    const optionsOf = id => [...(document.getElementById(id)?.options || [])].filter(option => option.value).map(option => [option.value, option.textContent.trim()]);
    const FIELDS = () => [
      ['provider', 'CLI', optionsOf('provider')], ['model', 'Model', 'text'],
      ['effort', 'Effort', [['', 'CLI default'], ['none', 'None'], ['minimal', 'Minimal'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']]],
      ['quality', 'Checks', [['reviewed', 'Reviewed'], ['fast', 'Fast']]],
      ['detail', 'Detail', [['super-short', 'Super short'], ['concise', 'Concise'], ['detailed', 'Detailed'], ['extremely-detailed', 'Extremely detailed']]],
      ['task', 'Task type', optionsOf('task')], ['language', 'Language', [['en', 'English'], ['de', 'Deutsch'], ['pl', 'Polski']]],
      ['options.acceptanceChecks', 'Acceptance checks', BOOL], ['options.planFirst', 'Plan first', BOOL], ['options.edgeCases', 'Edge cases', BOOL], ['options.securityReview', 'Security review', BOOL],
      ['includeContext', 'Origin context', BOOL], ['instructions', 'Extra instructions', 'textarea'],
    ];
    const read = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);

    // ---- Data ----
    async function loadList() {
      try { batches = (await call('')).batches; } catch (failure) { error = failure.message; }
      if (!batches.some(entry => entry.id === batchId)) batchId = batches[0]?.id || '';
    }
    async function refresh({ force = false } = {}) {
      if (!batchId) { batch = null; render(); return; }
      try {
        const query = !force && batch?.id === batchId ? `?since=${batch.revision}&origin=${batch.originRevision ?? ''}&instance=${encodeURIComponent(batch.instance)}` : '';
        const data = await call(`/${encodeURIComponent(batchId)}${query}`);
        error = '';
        if (data.unchanged) { tick(); return; }
        accept(data.batch);
      } catch (failure) {
        if (failure.status === 404) { batches = batches.filter(entry => entry.id !== batchId); batchId = batches[0]?.id || ''; batch = null; item = null; }
        error = failure.message;
        render();
      }
    }
    // Origin and Kanban change a task's state without changing the task itself, so the whole row is compared.
    const signature = entry => entry && JSON.stringify([entry.revision, entry.state, entry.origin, entry.card?.id, entry.findings]);
    function accept(next) {
      const before = signature(batch?.items.find(entry => entry.id === selectedId));
      batch = next;
      if (!batch.items.some(entry => entry.id === selectedId)) selectedId = batch.items[0]?.id || '';
      checked = new Set([...checked].filter(id => batch.items.some(entry => entry.id === id)));
      const now = batch.items.find(entry => entry.id === selectedId);
      if (now && (signature(now) !== before || item?.id !== now.id)) void loadItem();
      render();
    }
    async function loadItem() {
      const id = selectedId;
      if (!id) { item = null; renderInspector(); return; }
      try {
        const data = await call(`/${encodeURIComponent(batchId)}/items/${encodeURIComponent(id)}`);
        if (id !== selectedId) return;
        item = data.item;
      } catch (failure) { error = failure.message; }
      renderInspector();
    }
    function schedule() {
      clearTimeout(timer);
      if (!visible) return;
      const busy = batch?.items.some(entry => entry.state === 'running' || entry.state === 'queued');
      timer = setTimeout(async () => {
        if (polling || document.hidden) { schedule(); return; }
        polling = true;
        try { await refresh(); } finally { polling = false; schedule(); }
      }, busy ? 1000 : 6000);
    }
    /** Every change answers with the new queue; errors are shown where the action was taken. */
    async function act(path, body, success, { method = 'POST', where = 'batch' } = {}) {
      message = null;
      try {
        const data = await call(path, { method, body });
        if (data.batch) accept(data.batch);
        if (data.item && data.item.id === selectedId) { item = data.item; renderInspector(); }
        if (success) say(typeof success === 'function' ? success(data) : success, where);
        schedule();
        return data;
      } catch (failure) { say(failure.message, where, true, failure.data); return null; }
    }
    function say(text, where = 'batch', isError = false, data = null) {
      message = { text, where, isError, data };
      if (!isError) app.announce(text);
      render();
      if (where === 'item') renderInspector();
    }

    // ---- Rendering ----
    /**
     * The page has four regions that redraw on their own: the header and the queue follow the batch, the
     * inspector follows the selected task, and the advanced panel waits while you work in it. So a running
     * batch never moves the cursor, a scroll position or an open section.
     */
    function render() {
      if (!root) return;
      if (!batch) {
        regions = null;
        const empty = el('section', 'card batch-empty');
        empty.append(el('h2', '', 'No batch yet'), el('p', 'note', 'In Origin, select tasks under Tasks and choose Send to Compose. They arrive here; nothing runs until you choose Run.'));
        if (error) empty.append(el('p', 'inline-error', error));
        empty.append(button('Open Origin', () => { location.hash = '#/origin'; }, 'secondary-button'));
        root.replaceChildren(empty);
        return;
      }
      if (!regions) {
        regions = { head: el('div'), notices: el('div'), queue: el('div', 'batch-queue-region'), inspector: el('section', 'card batch-inspector'), advanced: el('div') };
        regions.inspector.setAttribute('aria-label', 'Selected task');
        const grid = el('div', 'batch-grid'); grid.append(regions.queue, regions.inspector);
        root.replaceChildren(regions.head, regions.notices, grid, regions.advanced);
        renderInspector();
      }
      regions.head.replaceChildren(header());
      const notes = [];
      if (batch.notice) notes.push(el('p', 'inline-error batch-notice', batch.notice.message));
      if (batch.cycle) notes.push(el('p', 'inline-error', `These tasks wait for each other: ${batch.cycle.join(' → ')}. Fix the prerequisites in Origin before sending to Kanban.`));
      if (error) notes.push(el('p', 'inline-error', error));
      if (message?.where === 'batch') notes.push(notice(message));
      regions.notices.replaceChildren(...notes);
      const focused = regions.queue.contains(document.activeElement) ? { id: document.activeElement.closest('[data-id]')?.dataset.id, cls: document.activeElement.className, tag: document.activeElement.tagName } : null;
      const scroll = regions.queue.querySelector('.batch-list')?.scrollTop || 0;
      regions.queue.replaceChildren(queue());
      regions.queue.querySelector('.batch-list').scrollTop = scroll;
      if (focused) {
        const scope = focused.id ? regions.queue.querySelector(`[data-id="${CSS.escape(focused.id)}"]`) : regions.queue;
        [...(scope?.querySelectorAll(focused.tag) || [])].find(node => node.className === focused.cls)?.focus();
      }
      if (!regions.advanced.contains(document.activeElement)) regions.advanced.replaceChildren(advanced());
      tick();
    }
    /** A collapsible section whose open state is remembered by name. */
    function section(name, title, className = 'batch-details') {
      const details = el('details', className); details.open = openDetails.has(name);
      details.addEventListener('toggle', () => { details.open ? openDetails.add(name) : openDetails.delete(name); });
      details.append(el('summary', '', title));
      return details;
    }
    function notice({ text, isError, data }) {
      const box = el('div', isError ? 'inline-error batch-message' : 'batch-message batch-success'); box.setAttribute('role', isError ? 'alert' : 'status');
      box.append(el('span', '', text));
      for (const row of data?.missing || []) box.append(el('span', 'batch-message-line', `${row.key} waits for ${row.waitsFor}${row.inBatch ? ' (in this batch, not approved)' : ' (not in this batch)'}`));
      for (const row of data?.problems || []) box.append(el('span', 'batch-message-line', `${row.key}: ${row.reason}`));
      if (data?.code === 'CARDS_REMOVED') box.append(button(`Create ${plural(data.removed.length, 'card')} again`, () => sendToKanban(data.removed.map(row => row.id)), 'secondary-button'));
      if (data?.sent && batch.kanban) box.append(button('Open Kanban', () => app.openKanban(batch.kanban.id), 'text-button'));
      return box;
    }
    function header() {
      const head = el('section', 'batch-head');
      const title = el('div', 'batch-title');
      if (batches.length > 1) {
        const select = el('select'); select.setAttribute('aria-label', 'Batch');
        for (const entry of batches) { const option = el('option', '', `${entry.name} · ${plural(entry.count, 'task')}`); option.value = entry.id; option.selected = entry.id === batchId; select.append(option); }
        select.addEventListener('change', () => open(select.value));
        title.append(select);
      } else title.append(el('h2', '', batch.name));
      const counts = batch.counts, total = batch.items.length, busy = (counts.running || 0) + (counts.queued || 0);
      title.append(el('p', 'batch-progress', [`${total} ${total === 1 ? 'task' : 'tasks'}`, counts.running && `${counts.running} running`, counts.queued && `${counts.queued} queued`, counts.approved && `${counts.approved} approved`, counts.review && `${counts.review} to review`, counts.failed && `${counts.failed} failed`, counts.sent && `${counts.sent} on Kanban`].filter(Boolean).join(' · ')));
      const bar = el('progress', 'batch-bar'); bar.max = total || 1; bar.value = total - (counts.pending || 0) - busy; bar.setAttribute('aria-label', 'Tasks with a prompt');
      const eta = el('p', 'batch-eta'); eta.id = 'batch-eta'; eta.setAttribute('aria-live', 'off');
      title.append(bar, eta);
      const actions = el('div', 'batch-actions');
      const runnable = batch.items.filter(entry => entry.state === 'pending' || entry.state === 'failed').length;
      const run = button(runnable ? `Run all (${runnable})` : 'Run all', () => act(`/${enc()}/run`, { all: true, defaults: app.composeSettings() }, data => `${plural(data.queued, 'task')} queued.${data.skipped.length ? ` ${plural(data.skipped.length, 'task')} skipped.` : ''}`), runnable ? 'copy-button' : 'secondary-button', 'Generate a prompt for every pending or failed task, a few at a time');
      run.disabled = !runnable; run.id = 'batch-run-all';
      const passing = counts.generated || 0;
      const approve = button(`Approve passing (${passing})`, () => act(`/${enc()}/approve`, { passing: true }, data => `${plural(data.approved, 'task')} approved.`), 'secondary-button', 'Approve every task whose checks all passed. Tasks with findings need your own review.');
      approve.disabled = !passing; approve.id = 'batch-approve-passing';
      const send = button(`Send ${counts.approved || 0} to Kanban`, () => sendToKanban(), counts.approved ? 'copy-button' : 'secondary-button', batch.kanban ? `Create To Do cards in ${batch.kanban.name}, prerequisites first. No agent starts.` : 'Connect the Origin project to a Kanban project first.');
      send.disabled = !counts.approved || !batch.kanban; send.id = 'batch-send';
      if (busy) actions.append(Object.assign(button('Cancel all', () => act(`/${enc()}/cancel`, {}, data => `${plural(data.cancelled, 'run')} cancelled.`), 'secondary-button', 'Stops every running agent at once and empties the queue'), { id: 'batch-cancel-all' }));
      actions.append(runMode(), run, approve, send);
      head.append(title, actions);
      return head;
    }
    const enc = () => encodeURIComponent(batchId);
    // How many tasks run at once: one at a time, or in parallel, each task with its own agent.
    function runMode() {
      const pick = el('select', 'batch-run-mode'); pick.id = 'batch-run-mode'; pick.setAttribute('aria-label', 'How tasks run');
      pick.title = 'One at a time: one agent works on one task. In parallel: each task gets its own agent, up to this many at once.';
      for (let n = 1; n <= 8; n++) pick.append(Object.assign(el('option', '', n === 1 ? 'One at a time' : `${n} in parallel`), { value: String(n) }));
      pick.value = String(batch.concurrency);
      pick.addEventListener('change', () => act(`/${enc()}/settings`, { concurrency: Number(pick.value) }, Number(pick.value) === 1 ? 'Tasks now run one at a time.' : `Up to ${pick.value} tasks now run at once, each with its own agent.`));
      return pick;
    }
    // Live progress of running tasks, every second between polls: elapsed time, an estimate and the time left.
    function tick() {
      if (!regions || !batch) return;
      const now = Date.now(), typical = batch.typicalMs || 0;
      for (const node of regions.queue.querySelectorAll('[data-started]')) {
        const elapsed = now - Number(node.dataset.started), guess = estimate(elapsed, typical);
        node.querySelector('.pb-meter')?.set(guess.percent);
        const time = node.querySelector('.batch-row-time');
        if (time) time.textContent = [duration(elapsed), guess.left !== null && `${left(guess.left)} left`].filter(Boolean).join(' · ');
      }
      const eta = root.querySelector('#batch-eta'), running = batch.items.filter(entry => entry.state === 'running' && entry.startedAt), waiting = batch.items.filter(entry => entry.state === 'queued').length;
      if (!eta) return;
      const rest = remaining({ startedAt: running.map(entry => entry.startedAt), waiting, typical, slots: batch.concurrency, now });
      eta.textContent = running.length || waiting ? (rest === null ? `${running.length} running · the first result gives a time estimate` : `${left(rest)} left (estimated from this batch's finished tasks)`) : '';
    }
    async function sendToKanban(recreate) {
      const data = await act(`/${enc()}/export`, recreate ? { recreate } : {}, result => `${plural(result.results.filter(row => row.status === 'created').length, 'card')} added to ${result.destination.name}. Nothing started.`);
      if (data && message) { message.data = { sent: true }; render(); }
    }

    function queue() {
      const panel = el('section', 'card batch-queue'); panel.setAttribute('aria-label', 'Task queue');
      const tools = el('div', 'batch-queue-tools');
      const select = el('select'); select.setAttribute('aria-label', 'Show');
      for (const [value, label] of FILTERS) {
        const count = value === 'all' ? batch.items.length : batch.items.filter(entry => matches(entry, value)).length;
        if (value !== 'all' && !count && value !== filter) continue;
        const option = el('option', '', `${label} (${count})`); option.value = value; option.selected = value === filter; select.append(option);
      }
      select.addEventListener('change', () => { filter = select.value; render(); });
      tools.append(select);
      const shown = batch.items.filter(entry => matches(entry, filter));
      const all = el('input'); all.type = 'checkbox'; all.setAttribute('aria-label', 'Select all shown tasks');
      all.checked = shown.length > 0 && shown.every(entry => checked.has(entry.id));
      all.addEventListener('change', () => { for (const entry of shown) all.checked ? checked.add(entry.id) : checked.delete(entry.id); render(); });
      const runSelected = button(checked.size ? `Run selected (${checked.size})` : 'Run selected', () => act(`/${enc()}/run`, { itemIds: [...checked], defaults: app.composeSettings() }, data => `${plural(data.queued, 'task')} queued.${data.skipped.length ? ` Skipped: ${data.skipped.map(row => `${row.key} (${row.reason})`).join(', ')}` : ''}`), 'secondary-button', 'Generate prompts for the checked tasks again');
      runSelected.disabled = !checked.size; runSelected.id = 'batch-run-selected';
      const pick = el('label', 'batch-check-all'); pick.append(all, el('span', 'sr-only', 'Select all'));
      tools.append(pick, runSelected);
      const list = el('ul', 'batch-list');
      for (const entry of shown) list.append(row(entry));
      if (!shown.length) list.append(el('li', 'note', 'No tasks match this filter.'));
      list.addEventListener('keydown', event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !event.target.classList.contains('batch-row-main')) return;
        event.preventDefault();
        const rows = [...list.querySelectorAll('.batch-row-main')], index = rows.indexOf(event.target);
        const next = rows[event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
        if (!next) return;
        const id = next.closest('[data-id]').dataset.id;
        next.click(); // Selecting redraws the queue: focus the new row, not the old node.
        regions.queue.querySelector(`[data-id="${CSS.escape(id)}"] .batch-row-main`)?.focus();
      });
      panel.append(tools, list);
      return panel;
    }
    const matches = (entry, value) => value === 'all' || entry.state === value || (value === 'running' && entry.state === 'queued');
    function row(entry) {
      const li = el('li', 'batch-row'); li.dataset.id = entry.id;
      const box = el('input'); box.type = 'checkbox'; box.checked = checked.has(entry.id); box.setAttribute('aria-label', `Select ${entry.key} ${entry.title}`);
      box.addEventListener('change', () => { box.checked ? checked.add(entry.id) : checked.delete(entry.id); render(); });
      const main = button('', () => { if (selectedId === entry.id) return; selectedId = entry.id; draft = null; splitDrafts.clear(); message = null; item = null; render(); renderInspector(); void loadItem(); }, 'batch-row-main');
      main.setAttribute('aria-current', String(entry.id === selectedId));
      const name = el('span', 'batch-row-name'); name.append(el('span', 'batch-key', entry.key), document.createTextNode(` ${entry.title || 'Untitled task'}`));
      const meta = el('span', 'batch-row-meta', [entry.state === 'running' && STAGES[entry.stage], entry.findings.blocking && plural(entry.findings.blocking, 'blocking finding'), !entry.findings.blocking && entry.findings.warning && plural(entry.findings.warning, 'note'),
        entry.card && `#${entry.card.number}`, entry.split && plural(entry.split.children.length, 'part'), entry.origin === 'changed' && 'changed in Origin'].filter(Boolean).join(' · '));
      main.append(name, meta, chip(entry.state));
      if (entry.hint) main.append(el('span', 'batch-row-hint', entry.hint));
      if (entry.state === 'running' && entry.startedAt) {
        const live = el('span', 'batch-row-live'); live.dataset.started = String(entry.startedAt);
        live.append(meter(`${entry.key} progress`), el('span', 'batch-row-time'));
        main.append(live);
      }
      li.append(box, main);
      return li;
    }

    // ---- Inspector ----
    const currentVersion = target => target?.versions.find(version => version.id === target.current) || null;
    function renderInspector() {
      const panel = regions?.inspector;
      if (!panel) return;
      // An unsaved edit keeps its text and cursor; the page says when the task changed underneath it.
      const typing = panel.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA' && document.activeElement.id === 'batch-prompt';
      if (typing && draft?.itemId === item?.id) { const note = panel.querySelector('.batch-draft-note'); if (note) note.hidden = draft.base === item.current; return; }
      panel.replaceChildren();
      const summary = batch.items.find(entry => entry.id === selectedId);
      if (!summary) { panel.append(el('p', 'note', 'Choose a task in the queue.')); return; }
      if (!item || item.id !== selectedId) { panel.append(el('p', 'note', 'Loading the task…')); return; }
      const version = currentVersion(item), running = summary.state === 'running' || summary.state === 'queued', sent = summary.state === 'sent';
      const head = el('div', 'batch-inspector-head'), heading = el('h3');
      heading.append(el('span', 'batch-key', item.key), document.createTextNode(` ${item.title || 'Untitled task'}`));
      head.append(heading, chip(summary.state));
      panel.append(head);
      const facts = [version && `Version ${version.n} · ${version.kind === 'edited' ? 'edited by you' : `${version.settings.provider}${version.settings.model ? ` · ${version.settings.model}` : ''}`}`,
        summary.state === 'running' && STAGES[item.stage] && `Now ${STAGES[item.stage]}`, item.card && `Kanban #${item.card.number}`].filter(Boolean);
      if (facts.length) panel.append(el('p', 'batch-facts', facts.join(' · ')));
      if (item.error) panel.append(el('p', 'inline-error', item.error.message));
      panel.append(actions(summary, version, running, sent));
      if (message?.where === 'item') panel.append(notice(message));
      panel.append(findings());
      if (version) panel.append(editor(version, running || sent));
      else if (!running) panel.append(el('p', 'note', 'No prompt yet. Choose Generate. The prompt writer gets this task’s own words, its Origin context as reference, and your instructions.'));
      if (item.split) panel.append(splitPanel(sent));
      panel.append(compare(version), trace(version), settingsPanel('task', item.overrides, item.inherited, overrides => act(`/${enc()}/items/${encodeURIComponent(item.id)}`, { overrides }, 'Settings for this task saved. They apply to the next run.', { method: 'PATCH', where: 'item' }), running || sent), versions());
    }
    function actions(summary, version, running, sent) {
      const bar = el('div', 'batch-inspector-actions');
      const path = `/${enc()}`, id = item.id;
      if (running) { bar.append(button('Cancel', () => act(`${path}/cancel`, { itemIds: [id] }, 'Cancelled.', { where: 'item' }), 'secondary-button')); return bar; }
      if (sent) { bar.append(button(item.card ? `Open Kanban #${item.card.number}` : 'Open Kanban', () => app.openKanban(batch.kanban?.id, item.card?.id), 'secondary-button')); return bar; }
      if (item.rejected) { bar.append(button('Restore', () => act(`${path}/items/${id}`, { rejected: false }, 'Restored.', { method: 'PATCH', where: 'item' }), 'secondary-button')); return bar; }
      const generate = button(version ? 'Regenerate' : 'Generate', () => {
        if ((item.approved || item.split?.state === 'accepted') && generate.dataset.confirm !== 'true') {
          generate.dataset.confirm = 'true'; generate.textContent = item.split ? 'Regenerate and drop the split?' : 'Regenerate and remove the approval?'; generate.classList.add('danger'); return;
        }
        void act(`${path}/run`, { itemIds: [id], defaults: app.composeSettings() }, data => (data.queued ? 'Queued.' : data.skipped[0]?.reason || 'Not queued.'), { where: 'item' });
      }, version ? 'secondary-button' : 'copy-button', 'Write this task’s prompt again in a fresh, separate run');
      generate.id = 'batch-generate';
      bar.append(generate);
      if (version && !item.split && app.toOrigin) {
        const back = button('Use in Origin task', async () => { const result = await app.toOrigin({ originId: batch.id, itemId: item.id, text: version.prompt }); if (result !== 'ok') say(result, 'item', true); }, 'secondary-button',
          'Send this prompt back to the Origin task as a proposal. The task changes only when you accept it there.');
        back.id = 'batch-to-origin'; back.disabled = summary.origin !== 'current' || item.findings.some(row => row.code === 'source-old');
        if (back.disabled) back.title = 'The task changed in Origin since this prompt. Regenerate it first.';
        bar.append(back);
      }
      const blocked = item.findings.some(row => row.severity === 'blocking');
      if (version && !item.split) {
        if (item.approved) bar.append(button('Remove approval', () => act(`${path}/approve`, { items: [{ itemId: id }], approve: false }, 'Approval removed.', { where: 'item' }), 'secondary-button'));
        else {
          const approve = button('Approve', () => act(`${path}/approve`, { items: [{ itemId: id, versionId: version.id }] }, data => (data.approved ? `${item.key} approved for Kanban.` : data.refused[0]?.reason || 'Not approved.'), { where: 'item' }), 'copy-button', blocked ? 'Resolve the blocking findings first' : 'Approve exactly this version for Kanban');
          approve.disabled = blocked || draft?.itemId === item.id; approve.dataset.blocked = String(blocked); approve.id = 'batch-approve';
          bar.append(approve);
        }
        bar.append(button('Check again', () => act(`${path}/run`, { itemIds: [id], kind: 'review' }, 'A fresh review of this prompt is queued.', { where: 'item' }), 'secondary-button', 'A separate model call reviews the current prompt against the task. The prompt does not change.'));
        const split = button('Split…', () => act(`${path}/run`, { itemIds: [id], kind: 'split' }, data => (data.queued ? 'A split is being proposed. Nothing changes until you accept it.' : data.skipped[0]?.reason), { where: 'item' }), 'secondary-button', 'Propose smaller tasks for this prompt. You review and approve each one.');
        split.disabled = blocked;
        bar.append(split);
      }
      bar.append(button('Reject', () => act(`${path}/items/${id}`, { rejected: true }, 'Rejected. It stays here and never goes to Kanban.', { method: 'PATCH', where: 'item' }), 'text-button', 'Keep this task out of Kanban'));
      return bar;
    }
    function findings() {
      const box = el('div', 'batch-findings');
      const rows = [...item.findings].sort((a, b) => ['blocking', 'warning', 'info'].indexOf(a.severity) - ['blocking', 'warning', 'info'].indexOf(b.severity));
      if (!currentVersion(item) && !rows.length) return box;
      if (!rows.length) { box.append(el('p', 'batch-pass', 'All checks passed: exact values kept, every requirement confirmed by the review, acceptance checks traced.')); return box; }
      const list = el('ul');
      for (const row of rows) {
        const li = el('li', `batch-finding ${row.severity}`);
        li.append(el('span', 'batch-finding-kind', SEVERITY[row.severity]), el('span', '', `${row.requirement ? `${row.requirement}: ` : ''}${row.message}`));
        if (row.excerpt) li.append(el('code', '', clip(row.excerpt, 200)));
        list.append(li);
      }
      box.append(list);
      return box;
    }
    function editor(version, locked) {
      const box = el('div', 'batch-editor');
      const label = el('label', 'field-label', 'Engineered prompt');
      const text = el('textarea', 'batch-prompt'); text.id = 'batch-prompt'; text.spellcheck = false; text.readOnly = locked;
      const mine = draft?.itemId === item.id ? draft : null;
      text.value = mine ? mine.text : version.prompt;
      label.append(text);
      const save = button('Save edit', async () => {
        const saved = await act(`/${enc()}/items/${encodeURIComponent(item.id)}`, { prompt: text.value, baseVersionId: draft?.base || version.id }, 'Saved as a new version. Its exact values were checked again; approve it after reading.', { method: 'PATCH', where: 'item' });
        if (saved) { draft = null; renderInspector(); }
      }, 'secondary-button');
      const discard = button('Discard edit', () => { draft = null; renderInspector(); }, 'text-button');
      const copy = button('Copy', () => navigator.clipboard.writeText(text.value).then(() => app.announce('Prompt copied.'), () => app.announce('Copy failed. Select the text and copy it.')), 'text-button');
      save.id = 'batch-save-edit';
      const dirty = () => {
        const changed = text.value !== version.prompt; save.hidden = discard.hidden = !changed;
        draft = changed ? { itemId: item.id, base: draft?.itemId === item.id ? draft.base : version.id, text: text.value } : null;
        // Approval is for the saved version: unsaved text must be saved (and checked) first.
        const approve = regions?.inspector.querySelector('#batch-approve'); if (approve) approve.disabled = approve.dataset.blocked === 'true' || changed;
      };
      text.addEventListener('input', dirty);
      const row = el('div', 'batch-editor-actions'); row.append(save, discard, copy);
      save.hidden = discard.hidden = !mine;
      const stale = el('p', 'note batch-draft-note', 'This task changed while you were editing. Discard your edit to see the new version.'); stale.hidden = !mine || mine.base === version.id;
      box.append(label, row, stale, el('p', 'note', `Kanban receives this prompt followed by the task’s Origin context${item.source.evidence.length ? ` (${plural(item.source.evidence.length, 'excerpt')} also given to the prompt writer)` : ''}.`));
      return box;
    }
    function compare(version) {
      const details = section('compare', 'Compare with the Origin task');
      const grid = el('div', 'batch-compare');
      const side = (title, text) => { const column = el('div'); column.append(el('p', 'field-label', title), el('pre', 'batch-pre', text || '—')); return column; };
      grid.append(side('Origin task (what Compose received)', item.source.input), side('Engineered prompt', version?.prompt || ''));
      details.append(grid);
      return details;
    }
    function trace(version) {
      const details = section('trace', 'Requirement trace');
      const rows = version?.integrity.trace || [];
      if (!rows.length) { details.append(el('p', 'note', 'Generate a prompt to trace each requirement.')); return details; }
      const table = el('table', 'batch-trace'), headRow = el('tr');
      for (const title of ['Origin requirement', 'Prompt section', 'Acceptance check', 'Review']) headRow.append(el('th', '', title));
      const thead = el('thead'); thead.append(headRow); table.append(thead);
      const body = el('tbody');
      for (const entry of rows) {
        const tr = el('tr'); tr.append(el('td', '', `${entry.id} ${clip(entry.text, 160)}`), el('td', '', entry.section ? `${entry.section}: ${clip(entry.excerpt, 120)}` : 'Not found'), el('td', '', entry.check ? clip(entry.check, 120) : '—'), el('td', `batch-review ${entry.review.replace(/\s/g, '-')}`, entry.review));
        body.append(tr);
      }
      table.append(body);
      const scroll = el('div', 'batch-table-scroll'); scroll.append(table);
      details.append(el('p', 'note', 'Sections and checks are matched by shared words; the review decides coverage.'), scroll);
      return details;
    }
    function versions() {
      const details = section('versions', `Versions (${item.versions.length})`);
      const list = el('ol', 'batch-versions');
      for (const version of [...item.versions].reverse()) {
        const li = el('li');
        const status = version.integrity.status === 'pass' ? 'checks passed' : version.integrity.status === 'blocked' ? 'blocked' : 'needs review';
        li.append(el('span', '', `v${version.n} · ${version.kind} · ${new Date(version.createdAt).toLocaleString()} · ${version.settings.provider}${version.settings.model ? `/${version.settings.model}` : ''} · ${version.settings.quality} · ${status}${version.id === item.current ? ' · current' : ''}`));
        const view = el('details'); view.append(el('summary', '', 'Show prompt'), el('pre', 'batch-pre', version.prompt)); li.append(view);
        list.append(li);
      }
      details.append(item.versions.length ? list : el('p', 'note', 'No versions yet.'));
      return details;
    }
    function splitPanel(sent) {
      const split = item.split, box = el('section', 'batch-split'); box.setAttribute('aria-label', 'Split');
      box.append(el('h4', '', split.state === 'proposed' ? `Proposed split into ${plural(split.children.length, 'task')}` : `Split into ${plural(split.children.length, 'task')}`));
      box.append(el('p', 'note', split.state === 'proposed' ? 'The parts run one after another on Kanban; later tasks wait for the last part. Nothing changes until you choose Use these tasks.' : 'Approve each part. Kanban receives the parts instead of the whole prompt.'));
      if (split.coverage.status === 'issues') { const list = el('ul', 'inline-error'); for (const issue of split.coverage.issues) list.append(el('li', '', `${issue.message}${issue.excerpt ? `: ${issue.excerpt}` : ''}`)); box.append(list); }
      const path = `/${enc()}/items/${encodeURIComponent(item.id)}`;
      for (const child of split.children) {
        const part = el('div', 'batch-part'), key = `${batchId}:${item.id}:${split.createdAt}:${child.id}`;
        part.append(el('p', 'batch-part-title', `${item.key}.${child.id} ${child.title}${child.approved ? ' · approved' : ''}`));
        const text = el('textarea', 'batch-prompt small'); text.value = splitDrafts.get(key) ?? child.prompt; text.readOnly = sent || Boolean(child.sent); text.setAttribute('aria-label', `Prompt of part ${child.id}`);
        const row = el('div', 'batch-editor-actions');
        row.append(button('Save part', async () => { if (await act(path, { child: { childId: child.id, prompt: text.value } }, 'Part saved. Approve it again.', { method: 'PATCH', where: 'item' })) { splitDrafts.delete(key); renderInspector(); } }, 'text-button'));
        let approve = null;
        if (split.state === 'accepted' && !child.sent) row.append(approve = child.approved ? button('Remove approval', () => act(`/${enc()}/approve`, { items: [{ itemId: item.id, childId: child.id }], approve: false }, 'Approval removed.', { where: 'item' }), 'text-button')
          : button('Approve part', () => act(`/${enc()}/approve`, { items: [{ itemId: item.id, childId: child.id }] }, data => (data.approved ? `Part ${child.id} approved.` : data.refused[0]?.reason || 'Not approved.'), { where: 'item' }), 'secondary-button'));
        // Approval is for the saved text: unsaved changes must be saved first.
        const dirty = () => { const changed = text.value !== child.prompt; changed ? splitDrafts.set(key, text.value) : splitDrafts.delete(key); if (approve && !child.approved) approve.disabled = changed; };
        text.addEventListener('input', dirty); dirty();
        part.append(text, row);
        box.append(part);
      }
      const decide = el('div', 'batch-editor-actions');
      if (split.state === 'proposed') decide.append(button('Use these tasks', () => act(`${path}/split`, { accept: true }, 'Split accepted. Approve each part.', { where: 'item' }), 'copy-button'));
      if (!split.children.some(child => child.sent)) decide.append(button(split.state === 'proposed' ? 'Discard split' : 'Undo split', () => act(`${path}/split`, { accept: false }, 'Split removed. The task is whole again.', { where: 'item' }), 'text-button'));
      box.append(decide);
      return box;
    }

    // ---- Settings (Compose defaults → batch → task) ----
    // The models a CLI reports, offered as suggestions; any model ID can still be typed.
    const catalogs = new Map();
    function suggestModels(control, provider) {
      if (!provider) return;
      const id = `batch-models-${provider}`;
      control.setAttribute('list', id);
      if (catalogs.has(provider)) return;
      const list = el('datalist'); list.id = id; document.body.append(list); catalogs.set(provider, list);
      void app.api(`/api/models?provider=${encodeURIComponent(provider)}`, { timeoutMs: 60000 }).then(({ response, data }) => {
        if (response.ok) list.replaceChildren(...(data.models || []).map(model => Object.assign(el('option', '', model.name || model.id), { value: model.id })));
      }).catch(() => {});
    }
    function settingsPanel(level, overrides, inherited, save, locked = false) {
      const details = section(`settings-${level}`, level === 'task' ? 'Settings for this task' : 'Batch settings');
      details.append(el('p', 'note', level === 'task' ? 'Each setting is inherited from the batch unless you choose a value for this task. A different CLI resets the model and effort it does not set.' : 'Each setting is inherited from your Compose settings unless you choose a value for the whole batch. Tasks can override it.'));
      const grid = el('div', 'batch-settings'), controls = [];
      for (const [path, label, kind] of FIELDS()) {
        const wrap = el('label', 'field-label'); wrap.append(document.createTextNode(label));
        const shown = read(inherited.value, path), from = inherited.from[path] === 'batch' ? 'batch' : 'Compose';
        const own = read(overrides, path);
        let control;
        if (kind === 'text' || kind === 'textarea') {
          control = el(kind === 'text' ? 'input' : 'textarea'); control.value = own ?? '';
          if (path === 'model') suggestModels(control, read(overrides, 'provider') ?? read(inherited.value, 'provider'));
          control.placeholder = `Inherit · ${shown ? clip(shown, 40) : kind === 'text' ? 'CLI default' : 'none'} (${from})`;
          if (kind === 'textarea') control.rows = 2;
        } else {
          control = el('select');
          const inherit = el('option', '', `Inherit · ${kind.find(([value]) => value === shown)?.[1] ?? (shown === '' ? 'CLI default' : String(shown))} (${from})`); inherit.value = '__inherit'; control.append(inherit);
          for (const [value, text] of kind) { const option = el('option', '', text); option.value = JSON.stringify(value); option.selected = own !== undefined && own === value; control.append(option); }
          if (own === undefined) control.value = '__inherit';
        }
        control.disabled = locked;
        wrap.append(control); grid.append(wrap); controls.push([path, kind, control]);
      }
      const row = el('div', 'batch-editor-actions');
      const saveButton = button('Save settings', () => {
        const next = {};
        for (const [path, kind, control] of controls) {
          let value;
          if (kind === 'text' || kind === 'textarea') { if (!control.value.trim()) continue; value = control.value.trim(); }
          else { if (control.value === '__inherit') continue; value = JSON.parse(control.value); }
          if (path.startsWith('options.')) (next.options ||= {})[path.slice(8)] = value; else next[path] = value;
        }
        // A model or effort belongs to a CLI: saved with the one shown now, a later change of CLI cannot pair them wrongly.
        const shownProvider = read(inherited.value, 'provider');
        if ((next.model !== undefined || next.effort !== undefined) && next.provider === undefined && shownProvider) next.provider = shownProvider;
        void save(next);
      }, 'secondary-button');
      saveButton.disabled = locked;
      row.append(saveButton);
      details.append(grid, row);
      return details;
    }
    function advanced() {
      const details = section('advanced', 'Batch settings, dependencies and quality', 'card batch-advanced'); details.id = 'batch-advanced';
      const body = el('div', 'batch-advanced-body');
      const parallel = el('label', 'field-label', 'Runs at once (1 = one at a time)');
      const number = el('input'); number.type = 'number'; number.min = '1'; number.max = '8'; number.value = String(batch.concurrency); number.id = 'batch-concurrency';
      parallel.append(number);
      const saveParallel = button('Save', () => act(`/${enc()}/settings`, { concurrency: Number(number.value) }, `Up to ${number.value} tasks now run at once.`), 'secondary-button');
      const limits = el('div', 'batch-editor-actions'); limits.append(parallel, saveParallel);
      body.append(el('p', 'note', 'Each task runs in its own fresh CLI call with its own copy of its task and settings. Runs never share a session. Prompt generation runs in parallel; Kanban still runs tasks in prerequisite order.'), limits,
        settingsPanel('batch', batch.settings, batch.inherited, settings => act(`/${enc()}/settings`, { settings }, 'Batch settings saved. They apply to the next run of each task.')));
      // Dependencies: Kanban order, never Compose order.
      const deps = section('dependencies', 'Dependencies');
      const list = el('ul', 'batch-deps'), byId = new Map(batch.items.map(entry => [entry.id, entry]));
      for (const entry of batch.items.filter(row => row.dependsOn.length)) {
        const li = el('li'); li.append(el('span', 'batch-key', entry.key), document.createTextNode(' waits for '));
        entry.dependsOn.forEach((id, index) => { const dep = byId.get(id); li.append(document.createTextNode(`${index ? ', ' : ''}${batch.keys[id] || id}${dep ? ` (${STATES[dep.state]?.[0] || dep.state})` : ' (not in this batch)'}`)); });
        list.append(li);
      }
      deps.append(list.children.length ? list : el('p', 'note', 'No task in this batch has prerequisites.'));
      // Quality: what the checks found across the batch.
      const quality = section('quality', 'Quality');
      const blocking = batch.items.reduce((sum, entry) => sum + entry.findings.blocking, 0), notes = batch.items.reduce((sum, entry) => sum + entry.findings.warning, 0);
      quality.append(el('p', 'note', `${plural(blocking, 'blocking finding')} and ${plural(notes, 'note')} across ${plural(batch.items.length, 'task')}. ${Object.entries(batch.counts).map(([state, count]) => `${STATES[state]?.[0] || state}: ${count}`).join(' · ')}.`));
      const remove = button('Remove this batch', () => {
        if (remove.dataset.confirm !== 'true') { remove.dataset.confirm = 'true'; remove.textContent = 'Remove the batch and its prompts? Origin and Kanban stay as they are.'; remove.classList.add('danger'); return; }
        void call(`/${enc()}`, { method: 'DELETE' }).then(async () => { app.announce('Batch removed.'); batch = null; item = null; await loadList(); await refresh({ force: true }); }, failure => say(failure.message, 'batch', true));
      }, 'text-button');
      body.append(deps, quality, remove);
      details.append(body);
      return details;
    }

    async function open(id) {
      batchId = id; setPref(KEY, id); selectedId = ''; item = null; draft = null; splitDrafts.clear(); checked = new Set(); message = null; filter = 'all'; regions = null;
      await refresh({ force: true });
      schedule();
    }
    async function show(on) {
      visible = on;
      if (!on) { clearTimeout(timer); return; }
      await loadList();
      await refresh({ force: true });
      schedule();
    }
    return {
      show,
      /** Origin sends tasks here: they are added once and shown; nothing runs. */
      async receive({ originId, expectedRevision, itemIds }) {
        try {
          const data = await call('', { method: 'POST', body: { originId, expectedRevision, itemIds, defaults: app.composeSettings() } });
          await loadList(); batchId = originId; setPref(KEY, originId); accept(data.batch); filter = 'all';
          return { ok: true, added: data.added, existing: data.existing };
        } catch (failure) { return { ok: false, error: failure.message }; }
      },
      open,
    };
  }
  return { create };
})();
