'use strict';

// Network handoffs and schedules (docs/network/architecture.md §23), shown inside Activity and Settings. A job's record
// gets where it came from (you, a client, a schedule, a delegating job), its approval request, the question it asked and the
// answer form, its sub-jobs as a tree (with their approval requests) and its handoff messages with read marks; Activity gets
// the Schedules list and editor; Settings gets the owner's handoff policy. No feed: messages exist only inside their job.
// Switching a schedule or handoffs on works only at the computer (the server refuses it from a paired phone). Text is set as
// text only.
window.PromptboardNetworkDelegation = (() => {
  const { el, button, plural, ago, clip, errorLine, holdFocus } = window.PromptboardDom;
  const note = (text, className = 'note') => el('p', className, text);
  const labelled = (text, control, className = 'field-label') => { const label = el('label', className); label.append(text, control); return label; };
  const short = id => (id ? String(id).replace(/^[a-z]+_/, '').slice(0, 6) : '');
  const KINDS = { request: 'Request', result: 'Result', review: 'Review note', needs_input: 'Question', blocked: 'Blocked' };
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const REPEATS = [['on_demand', 'On demand (Run now only)'], ['daily', 'Daily'], ['weekdays', 'Weekdays'], ['weekly', 'Weekly'], ['monthly', 'Monthly']];
  const timeText = at => new Date(at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const cadenceText = cadence => (cadence.kind === 'on_demand' ? 'On demand' : cadence.kind === 'daily' ? `Every day at ${cadence.time}` : cadence.kind === 'weekdays' ? `Every weekday at ${cadence.time}`
    : cadence.kind === 'weekly' ? `Every ${cadence.days.map(day => DAYS[day]).join(', ')} at ${cadence.time}` : `Every month on day ${cadence.day} at ${cadence.time}`);
  const key = () => (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const failureLine = () => { const line = el('p', 'inline-error'); line.setAttribute('role', 'alert'); line.hidden = true; return line; };
  const showFailure = (line, failure) => { line.textContent = failure?.message || String(failure); line.hidden = false; };

  /** The module's own dialog (as network-clients.js has): Escape and × close it and give focus back. */
  function dialogBox(id) {
    const dialog = el('dialog', 'kanban-dialog network-dialog network-handoff-dialog'); dialog.id = id; dialog.setAttribute('aria-labelledby', `${id}-heading`);
    document.body.append(dialog); holdFocus(dialog);
    let opener = null;
    const close = () => {
      if (dialog.open) dialog.close();
      dialog.replaceChildren();
      const back = opener; opener = null;
      (back?.isConnected ? back : back?.id && document.getElementById(back.id))?.focus?.();
    };
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close(); } });
    // A close event can arrive after the dialog was opened again (it is queued): only a dialog that is really closed is cleared.
    dialog.addEventListener('close', () => { if (!dialog.open && dialog.childElementCount) close(); });
    const open = (title, nodes, focus) => {
      opener = dialog.open ? opener : document.activeElement;
      const x = button('×', close, 'dialog-close icon-button'); x.setAttribute('aria-label', 'Close');
      const heading = el('h2', '', title); heading.id = `${id}-heading`; heading.tabIndex = -1;
      dialog.replaceChildren(x, el('p', 'eyebrow', 'NETWORK'), heading, ...nodes);
      if (!dialog.open) dialog.showModal();
      (focus || heading).focus?.();
    };
    return { open, close, get isOpen() { return dialog.open; } };
  }

  /**
   * The Activity part. `host`: { request, say, go, rerender (draw Activity again), reloadJob (read the shown job again),
   * chip(status) (Activity's state chip), agentName(id) }.
   */
  function create(host) {
    const dialog = dialogBox('network-handoff-dialog');
    const party = value => (value.owner ? 'You' : value.app ? 'Promptboard' : value.clientId ? `Client ${short(value.clientId)}` : nameOf(value.agentId));
    async function act(run, success) {
      try { await run(); if (success) host.say(success); } catch (failure) { host.say(failure.message); }
      host.reloadJob();
    }

    // ---- One job: its sub-jobs and messages, read with the record.
    const shown = { id: null, messages: null, unread: 0, tree: null, error: '', forms: null };
    async function childrenOf(id, depth, budget) {
      if (depth > 4 || budget.count >= 50) return Object.assign([], { more: 0 });
      const page = await host.request(`/api/network/jobs?parentJobId=${id}&limit=50`), rows = page.jobs.slice(0, 50 - budget.count);
      budget.count += rows.length;
      for (const row of rows) row.children = await childrenOf(row.id, depth + 1, budget);
      return Object.assign(rows, { more: page.total - rows.length });
    }
    async function loadJob(id) {
      if (shown.id !== id) Object.assign(shown, { id, messages: null, unread: 0, tree: null, error: '', forms: null });
      if (!schedules.data && !schedules.loading) void loadSchedules(); // A schedule's name for the job's origin.
      try {
        const [thread, tree, agents] = await Promise.all([host.request(`/api/network/jobs/${id}/messages`), childrenOf(id, 1, { count: 0 }), host.request('/api/network/agents?limit=200')]);
        schedules.agents = agents.agents; // Names of agents registered since Activity opened.
        if (shown.id === id) Object.assign(shown, { messages: thread.messages, unread: thread.unread, tree, error: '' });
      } catch (failure) { if (shown.id === id) shown.error = failure.message; }
      host.rerender();
    }
    /** Where the job came from, for the record's facts. */
    function origin(record) {
      const by = record.requester || { kind: 'owner' };
      if (record.parentJobId) {
        const link = button(`job ${short(record.parentJobId)}`, () => host.go(`#/network/activity/${record.parentJobId}`), 'text-button network-handoff-link'); link.id = 'network-job-parent';
        const box = el('span');
        box.append(record.delegation ? (record.delegation.by === 'machine' ? 'A sub-job the external client asked for under ' : 'Delegated by the agent of ') : 'Linked by you under ', link,
          record.delegation ? ` · depth ${record.delegation.depth}` : '');
        return box;
      }
      if (by.kind === 'schedule') {
        const name = schedules.data?.schedules.find(row => row.id === by.id)?.name;
        return `Schedule “${name || `${short(by.id)} (deleted or not loaded)`}”${record.schedule?.slot ? ` · for ${timeText(record.schedule.slot)}` : ' · Run now'}`;
      }
      return { owner: 'You', machine: `External client ${short(by.id)}`, pipeline: 'A pipeline run', a2a: 'A remote agent' }[by.kind] || by.kind;
    }
    function decide(record, decision) {
      return act(() => host.request(`/api/network/jobs/${record.id}/approve`, { method: 'POST', body: { expectedRevision: record.revision, decision } }),
        decision === 'approve' ? `Approved job ${short(record.id)}: it is queued.` : `Rejected job ${short(record.id)}: it was cancelled before it ran.`);
    }
    function approval(record, label) {
      const box = el('div', 'detail-actions network-handoff-approval');
      const yes = button('Approve', () => decide(record, 'approve'), 'secondary-button'); yes.id = `network-approve-${record.id}`; yes.dataset.focusKey = `approve:${record.id}`;
      const no = button('Reject', () => decide(record, 'reject'), 'secondary-button network-danger'); no.id = `network-reject-${record.id}`; no.dataset.focusKey = `reject:${record.id}`;
      yes.setAttribute('aria-label', `Approve ${label}`); no.setAttribute('aria-label', `Reject ${label}`);
      box.append(yes, no);
      return box;
    }
    /** The answer and note forms live as long as the job is shown, so a live redraw never drops what is being typed. */
    function forms(record) {
      if (shown.forms) return shown.forms;
      const answer = Object.assign(el('textarea'), { rows: 4, maxLength: 16000 }); answer.id = 'network-handoff-answer';
      const send = Object.assign(el('button', 'dialog-done', 'Send answer'), { type: 'submit' }); send.id = 'network-handoff-send';
      const answerForm = el('form', 'network-form network-handoff-form'); answerForm.noValidate = true;
      const answerFailure = failureLine();
      answerForm.append(labelled('Your answer', answer), answerFailure, send);
      answerForm.addEventListener('submit', async event => {
        event.preventDefault(); answerFailure.hidden = true;
        if (!answer.value.trim()) { showFailure(answerFailure, 'Write the answer.'); answer.focus(); return; }
        send.disabled = true;
        try {
          await host.request(`/api/network/jobs/${shown.id}/answer`, { method: 'POST', body: { expectedRevision: shown.revision, text: answer.value } });
          answer.value = ''; host.say('Answer sent. The job runs again with it.');
        } catch (failure) { showFailure(answerFailure, failure); }
        send.disabled = false; host.reloadJob();
      });
      const kind = el('select'); kind.id = 'network-handoff-note-kind';
      for (const [value, text] of [['review', 'Review note'], ['request', 'Request for its next attempt']]) kind.append(Object.assign(el('option', '', text), { value }));
      const text = Object.assign(el('textarea'), { rows: 3, maxLength: 16000 }); text.id = 'network-handoff-note';
      const add = Object.assign(el('button', 'secondary-button', 'Add note'), { type: 'submit' }); add.id = 'network-handoff-add';
      const noteFailure = failureLine(), noteForm = el('form', 'network-form network-handoff-form'); noteForm.noValidate = true;
      noteForm.append(labelled('Kind', kind), labelled('Note', text), noteFailure, add);
      noteForm.addEventListener('submit', async event => {
        event.preventDefault(); noteFailure.hidden = true;
        if (!text.value.trim()) { showFailure(noteFailure, 'Write the note.'); text.focus(); return; }
        add.disabled = true;
        try { await host.request(`/api/network/jobs/${shown.id}/messages`, { method: 'POST', body: { kind: kind.value, text: text.value } }); text.value = ''; host.say('Note added to this job’s record.'); }
        catch (failure) { showFailure(noteFailure, failure); }
        add.disabled = false; host.reloadJob();
      });
      // The note form folds away: most records only need reading.
      const noteBox = el('details', 'network-handoff-more network-handoff-notes'); noteBox.id = 'network-handoff-notes';
      noteBox.append(el('summary', '', 'Add a note to this job’s record'), noteForm);
      return shown.forms = { answerForm, noteForm: noteBox };
    }
    function tree(rows) {
      const list = el('ul', 'network-activity-rows network-handoff-tree');
      for (const row of rows) {
        const item = el('li', 'network-activity-row'); item.dataset.status = row.status;
        const head = el('div', 'network-activity-row-head'); head.append(host.chip(row.status), el('strong', '', nameOf(row.agentId)), el('span', 'note', `Job ${short(row.id)}`));
        const how = row.delegation ? (row.delegation.by === 'machine' ? 'asked for by the external client' : `delegated by the agent · depth ${row.delegation.depth}`) : 'linked by you';
        const open = button('Details', () => host.go(`#/network/activity/${row.id}`), 'text-button'); open.dataset.focusKey = `child:${row.id}`; open.setAttribute('aria-label', `Details of sub-job ${short(row.id)}`);
        item.append(head, note([how, row.waiting?.message || row.reason].filter(Boolean).join(' · ')));
        if (row.status === 'waiting_for_approval') item.append(approval(row, `sub-job ${short(row.id)}`));
        item.append(open);
        if (row.children?.length) item.append(tree(row.children));
        list.append(item);
      }
      if (rows.more > 0) list.append(el('li', 'note', `${plural(rows.more, 'more sub-job')}: open a sub-job to see the rest.`));
      return list;
    }
    function messageItem(message) {
      const item = el('li', 'network-handoff-message'); item.dataset.kind = message.kind;
      const head = el('div', 'network-activity-row-head');
      head.append(el('strong', '', KINDS[message.kind] || message.kind), el('span', 'note', `${party(message.from)} → ${party(message.to)}`), el('span', 'note network-time', `${timeText(message.createdAt)} (${ago(message.createdAt)})`));
      if ((message.to.owner) && !message.readAt) head.append(el('span', 'network-handoff-unread', 'Unread'));
      item.append(head);
      if (message.jobId) { const link = button(`Sub-job ${short(message.jobId)}`, () => host.go(`#/network/activity/${message.jobId}`), 'text-button network-handoff-link'); link.dataset.focusKey = `message:${message.id}`; item.append(link); }
      const text = el('p', 'network-handoff-text', clip(message.text, 600));
      item.append(text);
      if (message.text.length > 600) { const more = el('details', 'network-handoff-more'); more.append(el('summary', '', 'Show all'), el('pre', 'network-preview-text', message.text)); item.append(more); }
      return item;
    }
    /** The record's handoff parts, after its facts. */
    function jobParts(record) {
      if (shown.id !== record.id) return [];
      shown.revision = record.revision;
      const nodes = [];
      if (record.status === 'waiting_for_approval') nodes.push(el('h3', '', 'Approval'), note('This job waits for your approval. Nothing runs until you approve it.'), approval(record, `job ${short(record.id)}`));
      if (record.status === 'waiting_for_input' && record.awaiting?.kind !== 'children') {
        const question = record.awaiting?.question || shown.messages?.findLast(message => message.kind === 'needs_input')?.text || '';
        const box = el('div', 'network-handoff-box'); box.id = 'network-handoff-question';
        box.append(note('The agent asked:', 'note network-handoff-label'), el('p', 'network-handoff-question', question || 'Its question is in the messages below.'));
        if (record.requester?.kind === 'machine') box.append(note('The external client that submitted this job can answer too.'));
        nodes.push(el('h3', '', 'Question'), box, forms(record).answerForm);
      } else if (record.status === 'waiting_for_input') nodes.push(el('h3', '', 'Waiting for sub-jobs'), note(record.waiting?.message || 'It waits for the sub-jobs it delegated.'));
      nodes.push(el('h3', '', 'Sub-jobs'), ...(shown.tree === null ? [note(shown.error ? '' : 'Loading sub-jobs…')] : shown.tree.length ? [tree(shown.tree)]
        : [note('No sub-jobs. A job gets them when its agent delegates along a delegate relation and your handoff policy allows it.')]));
      nodes.push(el('h3', '', 'Handoffs and messages'));
      if (shown.error) nodes.push(errorLine(`Could not load the messages and sub-jobs. ${shown.error}`));
      else if (!shown.messages) nodes.push(note('Loading messages…'));
      else {
        nodes.push(note('A record of this job’s handoffs: what it asked, what it delegated and what came back. A read mark only says you read a message; the job’s status says what ran.'));
        if (shown.messages.length) { const list = el('ol', 'network-handoff-messages'); list.id = 'network-handoff-messages'; list.setAttribute('aria-label', 'Messages of this job, oldest first'); list.append(...shown.messages.map(messageItem)); nodes.push(list); }
        else nodes.push(note('No messages yet.'));
        if (shown.unread) {
          const read = button(`Mark ${plural(shown.unread, 'message')} as read`, () => act(() => host.request(`/api/network/jobs/${record.id}/messages/read`, { method: 'POST', body: {} }), 'Marked as read.'), 'secondary-button');
          read.id = 'network-handoff-read'; read.classList.add('network-handoff-action'); nodes.push(read);
        }
        nodes.push(forms(record).noteForm);
      }
      return nodes;
    }
    /** The record's "Started by" fact. */
    const originFact = record => ['Started by', origin(record)];

    // ---- Schedules (Activity's side column).
    const schedules = { data: null, agents: [], pipelines: [], error: '', loading: false }, running = new Set();
    /** Every saved pipeline (all pages): names for pipeline schedules, and the published versions the editor offers. */
    async function readPipelines() {
      const items = [];
      for (let offset = 0; offset !== null;) { const page = await host.request(`/api/network/pipelines?offset=${offset}&limit=200`); items.push(...page.pipelines); offset = page.next; }
      return schedules.pipelines = items;
    }
    const pipelineName = target => `${schedules.pipelines.find(item => item.id === target.pipelineId)?.name || `Pipeline ${short(target.pipelineId)}`} · version ${target.version}`;
    /**
     * A pipeline schedule's confirmation shows what one of its runs does, as Run does before it starts (network-pipeline.js
     * runFacts): `submit` stays disabled until the version is checked and can start now.
     */
    function factsBox(target, submit) {
      const box = el('div', 'network-run-facts'); box.id = 'network-schedule-facts'; box.setAttribute('aria-live', 'polite');
      if (submit) submit.disabled = true;
      box.append(note('Checking this version as a run would…'));
      window.PromptboardNetworkPipeline.runFacts({ request: host.request, pipelineId: target.pipelineId, number: target.version, agentName: nameOf }).then(checked => {
        box.replaceChildren(...checked.nodes);
        if (submit) submit.disabled = !checked.valid;
      }, failure => { box.replaceChildren(el('p', 'inline-error', `Could not check this version. ${failure.message}`)); });
      return box;
    }
    const section = el('section', 'network-activity-section network-schedules'); section.id = 'network-schedules';
    const heading = el('h3', '', 'Schedules'); heading.id = 'network-schedules-heading';
    const add = button('New schedule', () => editor(null), 'secondary-button'); add.id = 'network-schedule-new';
    const zoneNote = note('', 'note network-schedules-zone'), list = el('ul', 'network-activity-rows'); list.id = 'network-schedules-list'; list.setAttribute('aria-labelledby', heading.id);
    const empty = el('div', 'network-empty'), failure = errorLine(''); failure.hidden = true;
    const top = el('div', 'network-schedules-head'); top.append(heading, add);
    section.append(top, zoneNote, failure, list, empty);
    async function loadSchedules() {
      schedules.loading = true;
      try {
        const [data, agents] = await Promise.all([host.request('/api/network/schedules'), host.request('/api/network/agents?limit=200')]);
        if (data.schedules.some(row => row.target.pipelineId)) await readPipelines();
        Object.assign(schedules, { data, agents: agents.agents, error: '' });
      } catch (error) { schedules.error = error.message; }
      schedules.loading = false;
      renderSchedules();
      host.rerender();
    }
    const agentOf = id => schedules.agents.find(agent => agent.id === id);
    const nameOf = id => { const agent = agentOf(id); return agent ? agent.displayName || agent.base.name || agent.baseResourceId : host.agentName(id); };
    function stateOf(row) {
      if (row.zoneMismatch && row.enabled) return ['Zone changed', 'unknown', '?'];
      if (row.cadence.kind === 'on_demand') return ['On demand', 'queued', '○'];
      return row.enabled ? ['On', 'ok', '✓'] : ['Off', 'off', '–'];
    }
    function scheduleRow(row) {
      const item = el('li', 'network-activity-row network-schedule'); item.dataset.scheduleId = row.id;
      const [label, tone, mark] = stateOf(row), chip = el('span', 'network-state'); chip.dataset.state = tone;
      const sign = el('span', 'network-state-mark', mark); sign.setAttribute('aria-hidden', 'true'); chip.append(sign, label);
      const name = el('strong', '', row.name); name.id = `network-schedule-name-${row.id}`;
      const head = el('div', 'network-activity-row-head'); head.append(name, chip);
      const what = row.target.pipelineId ? pipelineName(row.target) : nameOf(row.target.agentId);
      item.append(head, note([what, cadenceText(row.cadence), row.next ? `next ${timeText(row.next)}` : ''].filter(Boolean).join(' · ')));
      if (row.zoneMismatch && row.enabled) item.append(note(`Set up in ${row.timeZone}; this computer now uses ${schedules.data.timeZone}. It starts nothing until you switch it on again here.`, 'note network-schedule-warning'));
      if (row.lastSkip) item.append(note(`Skipped ${timeText(row.lastSkip.at)}: ${row.lastSkip.reason}`, 'note network-schedule-warning'));
      else if (row.lastFiredAt) item.append(note(`Last started ${ago(row.lastFiredAt)}`));
      const actions = el('div', 'detail-actions network-schedule-actions');
      const control = (text, run, id, className = 'secondary-button') => { const node = button(text, run, className); node.id = `${id}-${row.id}`; node.setAttribute('aria-describedby', name.id); actions.append(node); return node; };
      if (row.cadence.kind !== 'on_demand') control(row.enabled && !row.zoneMismatch ? 'Switch off' : 'Switch on…', () => (row.enabled && !row.zoneMismatch ? switchOff(row) : confirmOn(row)), 'network-schedule-toggle');
      const run = control('Run now', () => runNow(row, run), 'network-schedule-run'); run.disabled = running.has(row.id);
      if (row.lastJobId) control('Last job', () => host.go(`#/network/activity/${row.lastJobId}`), 'network-schedule-last', 'text-button');
      if (row.lastRunId) control('Last run', () => host.go(`#/network/runs/${row.lastRunId}`), 'network-schedule-last-run', 'text-button');
      control('Edit', () => editor(row), 'network-schedule-edit', 'text-button');
      control('Delete', () => remove(row), 'network-schedule-delete', 'text-button network-danger');
      item.append(actions);
      return item;
    }
    function renderSchedules() {
      const data = schedules.data;
      window.PromptboardDom.recoveryNotice(section, data?.recovery);
      failure.hidden = !schedules.error; failure.textContent = schedules.error ? `Could not load the schedules. ${schedules.error}` : '';
      zoneNote.textContent = data ? `Times are this computer’s (${data.timeZone}). A schedule starts nothing until you switch it on at this computer; missed times run once, and a time is skipped while its previous job is open.` : '';
      const focused = list.contains(document.activeElement) ? document.activeElement.id : null;
      list.replaceChildren(...(data?.schedules || []).map(scheduleRow));
      if (focused) document.getElementById(focused)?.focus();
      empty.replaceChildren(...(data && !data.schedules.length ? [note('No schedules. A schedule runs a job for an agent, or a published pipeline, daily, on weekdays, weekly, monthly or when you choose Run now.')] : []));
      empty.hidden = !data || data.schedules.length > 0;
    }
    async function change(run, success) {
      try { await run(); host.say(success); } catch (error) { host.say(error.code === 'REMOTE_LOCAL_ONLY' ? 'Switch schedules on at the computer that runs Promptboard.' : error.message); }
      await loadSchedules();
    }
    const switchOff = row => change(() => host.request(`/api/network/schedules/${row.id}`, { method: 'PATCH', body: { expectedRevision: row.revision, enabled: false } }), `“${row.name}” is off. Nothing starts on its own.`);
    function runNow(row, node) {
      if (row.target.pipelineId) {
        // Starting a run is never implicit (architecture §21 item 10): the same facts as Run, then Start run.
        const fail = failureLine(), go = button('Start run', async () => {
          go.disabled = true; fail.hidden = true;
          try {
            const answer = await host.request(`/api/network/schedules/${row.id}/run`, { method: 'POST', body: { idempotencyKey: key() } });
            dialog.close(); host.say(`Started run ${short(answer.runId)} of “${row.name}”.`); await loadSchedules();
          } catch (error) { showFailure(fail, error); go.disabled = false; }
        }, 'dialog-done'); go.id = 'network-schedule-run-confirm';
        const footer = el('div', 'kanban-dialog-actions'); footer.append(button('Cancel', dialog.close, 'secondary-button'), go);
        dialog.open(`Run “${row.name}” now?`, [note(`It starts one run of ${pipelineName(row.target)} now, as Run in Pipelines does. Its steps are agent jobs that use your CLI sign-in.`), factsBox(row.target, go), fail, footer], go);
        return;
      }
      running.add(row.id); node.disabled = true;
      return change(async () => {
        try {
          const answer = await host.request(`/api/network/schedules/${row.id}/run`, { method: 'POST', body: { idempotencyKey: key() } });
          if (answer.jobId) host.say(`Started job ${short(answer.jobId)}.`);
        } finally { running.delete(row.id); node.disabled = false; }
      }, `Started “${row.name}” now.`);
    }
    function confirmOn(row) {
      const fail = failureLine(), go = button('Switch on', async () => {
        go.disabled = true; fail.hidden = true;
        try {
          await host.request(`/api/network/schedules/${row.id}/confirm`, { method: 'POST', body: { expectedRevision: row.revision, confirm: true } });
          dialog.close(); host.say(`“${row.name}” is on.`); await loadSchedules();
        } catch (error) { showFailure(fail, error.code === 'REMOTE_LOCAL_ONLY' ? 'Switch schedules on at the computer that runs Promptboard: a paired phone cannot.' : error); go.disabled = false; }
      }, 'dialog-done'); go.id = 'network-schedule-confirm';
      const footer = el('div', 'kanban-dialog-actions'); footer.append(button('Cancel', dialog.close, 'secondary-button'), go);
      const what = row.target.pipelineId ? `a run of ${pipelineName(row.target)}` : `a job for ${nameOf(row.target.agentId)}`;
      dialog.open(`Switch on “${row.name}”?`, [note(`It will start ${what} ${cadenceText(row.cadence).toLowerCase()} (${schedules.data?.timeZone || row.timeZone}), without asking you each time. Its jobs only read, and use your CLI sign-in.`),
        ...(row.target.pipelineId ? [note('Each run does what a run started from Pipelines does:'), factsBox(row.target, go)] : []),
        note(`Times missed while Promptboard is closed run once, and a time is skipped while its previous ${row.target.pipelineId ? 'run' : 'job'} is still open. Changing what it runs, or when, switches it off again.`), fail, footer], go);
    }
    function remove(row) {
      const fail = failureLine(), go = button('Delete schedule', async () => {
        go.disabled = true;
        try { await host.request(`/api/network/schedules/${row.id}`, { method: 'DELETE', body: { expectedRevision: row.revision } }); dialog.close(); host.say(`Deleted “${row.name}”. Its jobs stay.`); await loadSchedules(); }
        catch (error) { showFailure(fail, error); go.disabled = false; }
      }, 'dialog-done network-danger'); go.id = 'network-schedule-delete-confirm';
      const footer = el('div', 'kanban-dialog-actions'); footer.append(button('Cancel', dialog.close, 'secondary-button'), go);
      dialog.open(`Delete “${row.name}”?`, [note('Jobs it started stay in Activity.'), fail, footer], go);
    }
    /**
     * New or edit: what it runs (an agent and its task, or a published pipeline version with its run input) and when. Saving
     * starts nothing. The agents and pipelines are read again first.
     */
    async function editor(row) {
      try { [schedules.agents] = await Promise.all([host.request('/api/network/agents?limit=200').then(data => data.agents), readPipelines()]); } catch (error) { host.say(error.message); }
      const form = el('form', 'network-form network-schedule-form'); form.noValidate = true;
      const name = Object.assign(el('input'), { maxLength: 80, value: row?.name || '', autocomplete: 'off', placeholder: 'For example: Morning digest' }); name.id = 'network-schedule-name';
      const agent = el('select'); agent.id = 'network-schedule-agent';
      for (const item of schedules.agents) agent.append(Object.assign(el('option', '', `${item.displayName || item.base.name || item.baseResourceId}${item.enabled && !item.base.stale ? '' : ' (cannot run jobs now)'}`), { value: item.id }));
      const text = Object.assign(el('textarea'), { rows: 4, maxLength: 20000, value: row?.target.input?.text || '' }); text.id = 'network-schedule-text';
      const tools = el('select'); tools.id = 'network-schedule-tools';
      for (const [value, label] of [['none', 'No tools'], ['web', 'Read-only web search']]) tools.append(Object.assign(el('option', '', label), { value }));
      const repeat = el('select'); repeat.id = 'network-schedule-repeat';
      for (const [value, label] of REPEATS) repeat.append(Object.assign(el('option', '', label), { value }));
      const time = Object.assign(el('input'), { type: 'time', value: row?.cadence.time || '02:00' }); time.id = 'network-schedule-time';
      const days = el('fieldset', 'settings-group network-schedule-days'); days.append(el('legend', '', 'Days'));
      for (const [index, day] of DAYS.entries()) { const box = Object.assign(el('input'), { type: 'checkbox', value: String(index), checked: row?.cadence.days?.includes(index) ?? index === 1 }); const line = el('label', 'network-clients-choice'); line.append(box, el('span', '', day)); days.append(line); }
      const monthDay = Object.assign(el('input'), { type: 'number', min: 1, max: 28, step: 1, value: String(row?.cadence.day || 1) }); monthDay.id = 'network-schedule-day';
      const dayLabel = labelled('Day of the month (1–28)', monthDay), timeLabel = labelled('Time', time);
      // What it runs: a job, or a published pipeline version (only published versions are offered; the server checks again).
      const kind = el('select'); kind.id = 'network-schedule-kind';
      for (const [value, label] of [['job', 'A job for one agent'], ['pipeline', 'A run of a published pipeline']]) kind.append(Object.assign(el('option', '', label), { value }));
      const version = el('select'); version.id = 'network-schedule-pipeline';
      for (const item of schedules.pipelines) for (const entry of [...item.publishedVersions].reverse()) {
        version.append(Object.assign(el('option', '', `${item.name} · version ${entry.version}${entry === item.publishedVersions.at(-1) ? ' (latest)' : ''}`), { value: `${item.id}@${entry.version}` }));
      }
      const runInput = Object.assign(el('textarea'), { rows: 3, maxLength: 20000, value: row?.target.pipelineId ? row.target.input?.text || '' : '', placeholder: 'What the steps work on each time.' }); runInput.id = 'network-schedule-run-input';
      const facts = el('div'), jobPart = el('div', 'network-schedule-part'), pipelinePart = el('div', 'network-schedule-part');
      jobPart.append(labelled('Agent', agent), labelled('Task (the job’s input each time)', text), labelled('Tools', tools));
      pipelinePart.append(...(version.options.length ? [labelled('Pipeline and published version', version), facts, labelled('Run input (optional)', runInput)] : [note('No pipeline has a published version yet. Publish one in Network → Pipelines first.')]));
      const target = () => { const [pipelineId, number] = version.value.split('@'); return { pipelineId, version: Number(number) }; };
      const showFacts = () => { if (kind.value === 'pipeline' && version.value) facts.replaceChildren(factsBox(target())); };
      kind.value = row?.target.pipelineId ? 'pipeline' : 'job';
      if (row?.target.pipelineId) version.value = `${row.target.pipelineId}@${row.target.version}`;
      if (row && !row.target.pipelineId) { agent.value = row.target.agentId; tools.value = row.target.tools; }
      repeat.value = row?.cadence.kind || 'daily';
      const sync = () => { timeLabel.hidden = repeat.value === 'on_demand'; days.hidden = repeat.value !== 'weekly'; dayLabel.hidden = repeat.value !== 'monthly'; jobPart.hidden = kind.value !== 'job'; pipelinePart.hidden = kind.value !== 'pipeline'; };
      repeat.addEventListener('change', sync); kind.addEventListener('change', () => { sync(); showFacts(); }); version.addEventListener('change', showFacts); sync(); showFacts();
      const fail = failureLine(), save = Object.assign(el('button', 'dialog-done', row ? 'Save schedule' : 'Create schedule'), { type: 'submit' }); save.id = 'network-schedule-save';
      const footer = el('div', 'kanban-dialog-actions'); footer.append(button('Cancel', dialog.close, 'secondary-button'), save);
      form.append(labelled('Name', name), labelled('It runs', kind), jobPart, pipelinePart,
        labelled('Repeat', repeat), timeLabel, days, dayLabel,
        note(row?.enabled ? 'Changing what it runs, or when, switches it off until you switch it on again at this computer.' : 'Saving starts nothing. A new schedule stays off until you switch it on at this computer.'), fail, footer);
      form.addEventListener('submit', async event => {
        event.preventDefault(); fail.hidden = true;
        if (!name.value.trim()) { showFailure(fail, 'Name the schedule.'); name.focus(); return; }
        const pipeline = kind.value === 'pipeline';
        if (pipeline && !version.value) { showFailure(fail, 'Publish a pipeline in Network → Pipelines first.'); return; }
        if (!pipeline && !agent.value) { showFailure(fail, 'Register an agent in Network first.'); return; }
        if (!pipeline && !text.value.trim()) { showFailure(fail, 'Write the task.'); text.focus(); return; }
        const every = repeat.value, cadence = every === 'on_demand' ? { kind: every } : every === 'weekly' ? { kind: every, time: time.value, days: [...days.querySelectorAll('input:checked')].map(box => Number(box.value)) }
          : every === 'monthly' ? { kind: every, time: time.value, day: Number(monthDay.value) } : { kind: every, time: time.value };
        // A run input's json (set through the API) is kept; the text is what the field holds.
        const kept = row?.target.pipelineId ? row.target.input?.json : undefined, input = { ...(runInput.value.trim() ? { text: runInput.value } : {}), ...(kept !== undefined ? { json: kept } : {}) };
        const body = { name: name.value.trim(), cadence, target: pipeline ? { ...target(), ...(Object.keys(input).length ? { input } : {}) }
          : { ...(row && !row.target.pipelineId ? row.target : {}), agentId: agent.value, input: { ...(row && !row.target.pipelineId ? row.target.input : {}), text: text.value }, tools: tools.value } };
        save.disabled = true;
        try {
          const answer = row ? await host.request(`/api/network/schedules/${row.id}`, { method: 'PATCH', body: { expectedRevision: row.revision, ...body } })
            : await host.request('/api/network/schedules', { method: 'POST', body: { expectedRevision: schedules.data?.revision ?? 0, ...body } });
          dialog.close(); host.say(answer.switchedOff ? `Saved “${answer.schedule.name}”. It is off until you switch it on again.` : `Saved “${answer.schedule.name}”.`); await loadSchedules();
        } catch (error) { showFailure(fail, error); save.disabled = false; }
      });
      dialog.open(row ? `Edit “${row.name}”` : 'New schedule', [form], name);
    }
    /** A live event: schedule events read the list again; handoff and message events of the shown job read it again. */
    let timer = null;
    function onEvent(event) {
      if (event.type?.startsWith('schedule.')) { clearTimeout(timer); timer = setTimeout(() => void loadSchedules(), 300); }
      if (shown.id && event.jobId === shown.id && ['job.message', 'job.handoff'].includes(event.type)) void loadJob(shown.id);
    }
    return { loadJob, jobParts, originFact, schedules: section, loadSchedules, onEvent, closeDialog: () => dialog.close() };
  }

  /** Settings → Handoffs: the owner's policy (off by default). Saving it works only at the computer. */
  function policyCard(host) {
    const card = el('section', 'network-clients-card network-handoff-policy'); card.id = 'network-handoff-policy'; card.setAttribute('aria-labelledby', 'network-handoff-policy-heading');
    const heading = el('h3', '', 'Handoffs'); heading.id = 'network-handoff-policy-heading';
    const status = el('p', 'network-clients-status'); status.id = 'network-handoff-status'; status.setAttribute('role', 'status');
    const toggle = (id, text, help) => {
      const input = Object.assign(el('input', 'base-switch'), { type: 'checkbox' }); input.id = id; input.setAttribute('role', 'switch');
      const line = el('label', 'network-clients-choice'); line.append(input, el('span', '', text), el('small', 'note', help));
      return [input, line];
    };
    const [ask, askLine] = toggle('network-handoff-ask', 'Agents may ask you a question', 'A job can end with one question; it waits for your answer (or its external client’s), then runs again with it.');
    const [delegate, delegateLine] = toggle('network-handoff-delegate', 'Agents may delegate sub-jobs', 'Only to agents they have a delegate relation to in the job’s network (Graph). A relation is required, never enough.');
    const [approve, approveLine] = toggle('network-handoff-approve', 'Sub-jobs wait for my approval', 'Each delegated sub-job waits in Activity until you approve it.');
    const number = (id, min, max) => { const input = Object.assign(el('input'), { type: 'number', min, max, step: 1, inputMode: 'numeric' }); input.id = id; return input; };
    const depth = number('network-handoff-depth', 1, 4), children = number('network-handoff-children', 1, 10), share = number('network-handoff-share', 10, 100);
    const numbers = el('div', 'network-clients-controls');
    numbers.append(labelled('Deepest sub-job (1–4)', depth), labelled('Sub-jobs per job (1–10)', children), labelled('Time budget per sub-job (% of its parent’s)', share));
    const save = button('Save handoff policy', () => submit(), 'secondary-button'); save.id = 'network-handoff-save';
    card.append(heading, status, note('What a running agent may ask for at the end of its report. Promptboard checks every request on this computer and refuses what this policy, the relations and the agents’ projects do not allow: no wider tools, no other project, no loops. Switching these on works only at this computer.'),
      askLine, delegateLine, approveLine, numbers, save);
    let policy = null, visible = false;
    function render() {
      if (!policy) { status.textContent = 'Loading…'; return; }
      window.PromptboardDom.recoveryNotice(card, policy.recovery);
      ask.checked = policy.askOwner; delegate.checked = policy.delegate; approve.checked = policy.requireApproval;
      for (const [input, value] of [[depth, policy.maxDepth], [children, policy.maxChildren], [share, policy.budgetShare]]) if (document.activeElement !== input) input.value = String(value);
      status.dataset.state = policy.askOwner || policy.delegate ? 'on' : 'off';
      status.textContent = policy.askOwner || policy.delegate ? [policy.askOwner ? 'Questions on' : '', policy.delegate ? `Delegation on (up to ${policy.maxDepth} deep, ${plural(policy.maxChildren, 'sub-job')} per job)` : ''].filter(Boolean).join(' · ') : 'Off: agents cannot ask questions or delegate.';
    }
    async function load() {
      try { policy = (await host.request('/api/network/delegation')).policy; } catch (failure) { host.showError(failure); }
      render();
    }
    async function submit() {
      save.disabled = true; host.showError('');
      try {
        policy = (await host.request('/api/network/delegation', { method: 'PATCH', body: { expectedRevision: policy.revision, askOwner: ask.checked, delegate: delegate.checked, requireApproval: approve.checked,
          maxDepth: Number(depth.value), maxChildren: Number(children.value), budgetShare: Number(share.value) } })).policy;
        host.say('Saved the handoff policy. Saving starts nothing.');
      } catch (failure) { host.showError(failure.code === 'REMOTE_LOCAL_ONLY' ? 'Change the handoff policy at the computer that runs Promptboard: a paired phone cannot.' : failure); }
      save.disabled = false; render();
    }
    return { node: card, show(on) { const entering = on && !visible; visible = on; if (entering) void load(); } };
  }

  return { create, policyCard, cadenceText };
})();
