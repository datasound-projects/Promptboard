'use strict';

// Network → Activity and an agent profile's Activity tab (docs/network/architecture.md §8, §12, §19): what Network jobs
// are doing, from their own events and job records, never from guesses. Each agent shows its open jobs' status
// (waiting for input, unknown, waiting for approval, running, queued) with what its CLI can report; the timeline is the
// event journal, kept live by one NDJSON stream (fetch, so the token stays in a header) that reconnects with the last
// sequence number it saw, so each event shows once. Kanban runs of registered agents are listed read only and open their
// card. Costs and token counts appear only when the CLI reported them; nothing shows a percentage. All text is set as text.
window.PromptboardNetworkActivity = (() => {
  const { el, button, plural, ago, clip } = window.PromptboardDom;
  // [label, tone, mark]: the tone colours the chip, the mark tells the states apart without colour.
  const STATES = {
    running: ['Running', 'running', '▶'], preparing: ['Preparing', 'running', '▶'], queued: ['Queued', 'queued', '○'],
    waiting_for_approval: ['Waiting for your approval', 'waiting', '⏸'], waiting_for_input: ['Waiting for input', 'waiting', '⏸'],
    unknown: ['Unknown: needs your decision', 'unknown', '?'], interrupted: ['Interrupted: needs your decision', 'unknown', '?'],
    completed: ['Completed', 'ok', '✓'], failed: ['Failed', 'error', '✕'], cancelled: ['Cancelled', 'off', '–'], none: ['No open job', 'off', '·'],
    pending: ['Pending', 'queued', '○'], ready: ['Ready', 'queued', '○'], skipped: ['Skipped', 'off', '–'], blocked: ['Blocked', 'unknown', '?'],
  };
  const KANBAN_STATES = { queued: ['Queued', 'queued', '○'], running: ['Running', 'running', '▶'], waiting_for_input: ['Waiting for input', 'waiting', '⏸'], succeeded: ['Succeeded', 'ok', '✓'],
    failed: ['Failed', 'error', '✕'], cancelled: ['Cancelled', 'off', '–'], interrupted: ['Interrupted', 'off', '–'], suspended: ['Suspended', 'off', '⏸'] };
  const PROVIDERS = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', agy: 'Antigravity' };
  const BY = { owner: 'by you', app: 'by Promptboard', worker: 'by the worker', machine: 'by an external client', pipeline: 'by a pipeline', job: 'by another job', schedule: 'by a schedule', a2a: 'by a remote agent' };
  const ACTIVITY = { turn: 'Turn', tool: 'Tool', web: 'Web search', mcp: 'MCP call', text: 'Writing', status: 'Status' };
  const KINDS = [['', 'All events'], ['job.status', 'Job status'], ['job.activity', 'Job activity'], ['pipeline', 'Pipelines'], ['other', 'Other']];
  const LIVE = {
    off: '', connecting: 'Connecting to live updates…', live: 'Live: new events appear as they happen.', reconnecting: 'Connection lost. Reconnecting…',
    limited: 'Live updates paused: too many Activity views are open. Close one; this view tries again in 15 seconds.', stopped: 'Live updates stopped. Reload the page to start them again.',
  };
  const FEED_CAP = 1000, PAGE = 100;
  const note = (text, className = 'note') => el('p', className, text);
  const labelled = (text, control) => { const label = el('label', 'field-label'); label.append(text, control); return label; };
  const select = options => { const node = el('select'); for (const [value, text] of options) node.append(Object.assign(el('option', '', text), { value })); return node; };
  const short = id => (id ? String(id).replace(/^[a-z]+_/, '').slice(0, 6) : '');
  const stateOf = (status, map = STATES) => map[status] || [String(status || 'unknown').replaceAll('_', ' '), 'unknown', '?'];
  function chip(status, map) {
    const [label, tone, mark] = stateOf(status, map), node = el('span', 'network-state'); node.dataset.state = tone;
    const sign = el('span', 'network-state-mark', mark); sign.setAttribute('aria-hidden', 'true'); node.append(sign, label);
    return node;
  }
  const when = at => { const node = el('time', 'network-time', new Date(at).toLocaleTimeString()); node.dateTime = new Date(at).toISOString(); node.title = `${new Date(at).toLocaleString()} (${ago(at)})`; return node; };
  /** Usage only as the CLI reported it. */
  function usageText(usage) {
    if (!usage) return 'Usage: not reported';
    const tokens = usage.inputTokens !== null || usage.outputTokens !== null ? `${(usage.inputTokens ?? 0).toLocaleString('en-US')} in · ${(usage.outputTokens ?? 0).toLocaleString('en-US')} out tokens` : 'Tokens: not reported';
    return `${tokens} · ${usage.costUsd !== null && usage.costUsd !== undefined ? `cost $${usage.costUsd.toFixed(4)} (reported by the CLI)` : 'cost: not reported'}`;
  }
  const COVERAGE_NAMES = { tools: 'tool activity', 'partial-tools': 'limited activity', 'final-only': 'final result only' };
  const coverageName = level => COVERAGE_NAMES[level] || level;
  const kindOf = event => (event.type === 'job.status' || event.type === 'job.activity' ? event.type : event.type.startsWith('pipeline.') ? 'pipeline' : 'other');

  function create(host) {
    const panel = el('section', 'network-panel network-activity'); panel.id = 'network-panel-activity'; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', 'network-tab-activity'); panel.hidden = true;
    const liveLine = el('p', 'network-live'); liveLine.id = 'network-activity-live'; liveLine.setAttribute('role', 'status'); liveLine.setAttribute('aria-live', 'polite');
    const intro = note('What Network jobs are doing, from their own records and events. What a CLI cannot report is shown as unknown, never as idle or done. Kanban runs of registered agents are listed read only.');
    const journalNote = el('p', 'note network-journal'); journalNote.hidden = true;
    const head = el('div', 'network-activity-head'); head.append(liveLine, intro, journalNote);

    // Agents, open jobs and Kanban runs: GET /api/network/activity, read again after events (debounced) and every 20 s.
    const agentsList = el('ul', 'network-activity-agents'); agentsList.id = 'network-activity-agents'; agentsList.setAttribute('aria-label', 'Agents and their status');
    const agentsEmpty = el('div', 'network-empty'); agentsEmpty.id = 'network-activity-agents-empty';
    const queueList = el('ul', 'network-activity-rows'); queueList.id = 'network-activity-queue'; queueList.setAttribute('aria-label', 'Open jobs');
    const queueEmpty = el('div', 'network-empty');
    const queueCount = note('', 'note network-activity-count');
    const kanbanList = el('ul', 'network-activity-rows'); kanbanList.id = 'network-activity-kanban'; kanbanList.setAttribute('aria-label', 'Kanban runs of registered agents');
    const kanbanEmpty = el('div', 'network-empty');
    const summaryError = el('div', 'inline-error network-alert'); summaryError.setAttribute('role', 'alert'); summaryError.hidden = true;

    // The timeline: the newest events first, filtered on the page.
    const agentFilter = select([['', 'All agents']]); agentFilter.id = 'network-activity-agent';
    const kindFilter = select(KINDS); kindFilter.id = 'network-activity-kind';
    const search = Object.assign(el('input'), { type: 'search', placeholder: 'Find in the timeline…', autocomplete: 'off', maxLength: 200 }); search.id = 'network-activity-search';
    const filters = el('div', 'network-activity-filters'); filters.append(labelled('Agent', agentFilter), labelled('Events', kindFilter), labelled('Search the timeline', search));
    const feedList = el('ol', 'network-events'); feedList.id = 'network-activity-feed'; feedList.tabIndex = -1; feedList.setAttribute('aria-label', 'Timeline, newest first');
    const feedEmpty = el('div', 'network-empty'); feedEmpty.id = 'network-activity-feed-empty';
    const older = button('Show older events', () => loadOlder(), 'secondary-button network-more'); older.id = 'network-activity-older'; older.hidden = true;
    const gapNote = note('Older events were removed when the journal reached its size limit.', 'note network-gap'); gapNote.hidden = true;

    const section = (title, ...nodes) => { const box = el('section', 'network-activity-section'); const h = el('h3', '', title); box.append(h, ...nodes); return box; };
    const feedBox = section('Timeline', filters, feedList, feedEmpty, older, gapNote); feedBox.classList.add('network-activity-feed');
    const side = el('div', 'network-activity-side'); side.append(section('Running and queued', queueCount, queueList, queueEmpty), section('Kanban runs (read only)', kanbanList, kanbanEmpty));
    const columns = el('div', 'network-activity-columns'); columns.append(feedBox, side);
    const overview = el('div', 'network-activity-overview'); overview.id = 'network-activity-overview';
    overview.append(section('Agents', agentsList, agentsEmpty), summaryError, columns);
    const jobView = el('div', 'network-activity-job'); jobView.id = 'network-activity-job'; jobView.hidden = true;
    panel.append(head, overview, jobView);

    const data = { summary: null, summaryError: '', feed: [], seqs: new Set(), prev: null, oldest: 1, loaded: false, error: '', errorCode: '', version: 0, summaryVersion: 0 };
    let shown = null, agentView = null, job = null, focusJob = null, focusHeading = false, renderTimer = null, summaryTimer = null, refresh = null;
    const expected = agentId => { const coverage = data.summary?.agents.find(agent => agent.agentId === agentId)?.coverage; return coverage ? coverage.label.toLowerCase() : 'what its CLI allows'; };
    /**
     * Redraw `root` and keep the keyboard where it was: a control that was replaced gets focus back through its id or its
     * data-focus-key (a Details or Open button of the same event, job, run or agent), so live updates never drop focus.
     */
    function keepFocus(root, draw) {
      const active = root.contains(document.activeElement) ? document.activeElement : null, key = active?.dataset.focusKey, id = active?.id;
      draw();
      if (!active || active.isConnected) return;
      (key ? root.querySelector(`[data-focus-key="${key}"]`) : id ? document.getElementById(id) : null)?.focus();
    }
    const names = () => new Map((data.summary?.agents || []).map(agent => [agent.agentId, agent.name]));
    const agentName = id => names().get(id) || (id ? `Agent ${short(id)}` : '');

    // ---- Live: one stream while Activity or an agent's Activity tab shows.
    const live = { wanted: false, generation: 0, controller: null, last: null, state: 'off', attempts: 0, wake: null };
    // `host.onLive(state, was)` hears every change, so a view that relies on the stream (the Tasks tab) can poll again when it drops.
    const setLive = (state, extra = '') => { const was = live.state; live.state = state; liveLine.dataset.state = state; liveLine.textContent = extra || LIVE[state]; if (was !== state) { try { host.onLive?.(state, was); } catch {} } }; // A listener never stops the stream.
    const sleep = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); live.wake = () => { clearTimeout(timer); resolve(); }; });
    function want(on) {
      if (on === live.wanted) return;
      live.wanted = on;
      if (on) {
        void connect(++live.generation); void loadSummary();
        refresh = setInterval(() => void loadSummary(), 20000);
      } else {
        live.controller?.abort(); live.wake?.(); clearInterval(refresh); refresh = null; setLive('off');
      }
    }
    /** One loop per time the stream is wanted: a loop from an earlier time (stopped, then wanted again) ends itself. */
    async function connect(generation) {
      const current = () => live.wanted && generation === live.generation;
      while (current()) {
        const controller = new AbortController(); live.controller = controller;
        setLive(live.attempts ? 'reconnecting' : 'connecting');
        let retry = Math.min(15000, 1000 * 2 ** Math.min(live.attempts, 4));
        try {
          if (live.last === null) await loadFeed();
          if (data.errorCode === 'NETWORK_VERSION_UNSUPPORTED') { setLive('stopped', data.error); live.wanted = false; clearInterval(refresh); return; }
          if (live.last === null) throw new Error('no cursor'); // The first page failed; its error is on the page.
          const response = await host.stream(`/api/network/events/stream?after=${live.last}`, { cache: 'no-store', signal: controller.signal });
          if (response.status === 429) { setLive('limited'); retry = 15000; throw new Error('limited'); }
          if ([401, 403, 409].includes(response.status)) {
            const body = await response.json().catch(() => ({}));
            setLive('stopped', response.status === 409 && body.error ? body.error : ''); live.wanted = false; clearInterval(refresh); return;
          }
          if (!response.ok || !response.body) throw new Error('stream');
          const reader = response.body.getReader(), decoder = new TextDecoder();
          let buffer = '';
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              for (let end; (end = buffer.indexOf('\n')) >= 0;) {
                const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
                let item; try { item = JSON.parse(line); } catch { continue; }
                receive(item);
              }
            }
          } finally { reader.releaseLock?.(); }
        } catch { /* Aborted, dropped or refused: reconnect below while wanted. */ }
        if (!current()) return;
        live.attempts++;
        if (live.state !== 'limited') setLive('reconnecting');
        await sleep(retry);
      }
    }
    function receive(item) {
      if (item.ping) return;
      if (item.live) { live.attempts = 0; setLive('live'); return; }
      if (item.reset) { live.last = null; data.feed = []; data.seqs.clear(); live.controller?.abort(); return; } // The journal was removed: read it again.
      if (item.gap) { data.prev = null; data.oldest = item.oldest; scheduleRender(); return; }
      if (!Number.isSafeInteger(item.seq) || item.seq <= live.last) return; // Already shown: each event once.
      live.last = item.seq;
      add([item]);
      scheduleSummary();
      try { host.onEvent?.(item); } catch {}
    }
    function add(events, { older: isOlder = false } = {}) {
      const fresh = events.filter(event => !data.seqs.has(event.seq));
      for (const event of fresh) data.seqs.add(event.seq);
      data.feed = isOlder ? [...fresh, ...data.feed] : [...data.feed, ...fresh];
      if (data.feed.length > FEED_CAP && !isOlder) { for (const event of data.feed.splice(0, data.feed.length - FEED_CAP)) data.seqs.delete(event.seq); data.prev = data.feed[0].seq; }
      if (job && fresh.some(event => event.jobId === job.id)) job.events = [...job.events, ...fresh.filter(event => event.jobId === job.id && !job.events.some(known => known.seq === event.seq))];
      if (agentView && !isOlder) agentView.events = [...agentView.events, ...fresh.filter(event => event.agentId === agentView.agent.id && !agentView.events.some(known => known.seq === event.seq))];
      scheduleRender();
    }

    // ---- Data
    async function loadFeed() {
      const version = ++data.version;
      try {
        const page = await host.request(`/api/network/events?limit=${PAGE}`);
        if (version !== data.version) return;
        data.feed = []; data.seqs.clear();
        add(page.events);
        Object.assign(data, { prev: page.prev, oldest: page.oldest, loaded: true, error: '', errorCode: '' });
        live.last = page.last;
      } catch (failure) { if (version === data.version) Object.assign(data, { error: failure.message, errorCode: failure.code || '', loaded: false }); }
      scheduleRender();
    }
    async function loadOlder() {
      if (data.prev === null) return;
      older.disabled = true;
      try { const page = await host.request(`/api/network/events?before=${data.prev}&limit=${PAGE}`); add(page.events, { older: true }); data.prev = page.prev; }
      catch (failure) { host.say(`Could not load older events. ${failure.message}`); }
      finally { older.disabled = false; renderNow(); (older.hidden ? feedList : older).focus(); }
    }
    async function loadSummary() {
      const version = ++data.summaryVersion;
      try { const summary = await host.request('/api/network/activity'); if (version === data.summaryVersion) Object.assign(data, { summary, summaryError: '' }); }
      catch (failure) { if (version === data.summaryVersion) data.summaryError = failure.message; }
      if (version === data.summaryVersion) scheduleRender();
    }
    function scheduleSummary() { clearTimeout(summaryTimer); summaryTimer = setTimeout(() => void loadSummary().then(() => { if (job) void loadJob(job.id, { quiet: true }); }), 300); }
    function scheduleRender() { if (!renderTimer) renderTimer = setTimeout(renderNow, 30); }
    function renderNow() { clearTimeout(renderTimer); renderTimer = null; if (shown) render(); if (agentView) renderAgent(); }

    // ---- Overview
    function render() {
      if (shown?.jobId) { overview.hidden = true; jobView.hidden = false; renderJob(); return; }
      overview.hidden = false; jobView.hidden = true;
      keepFocus(panel, () => { renderSummary(); renderFeed(); });
      if (focusJob) { panel.querySelector(focusJob === 'search' ? '#network-activity-search' : `[data-open-job="${focusJob}"]`)?.focus(); focusJob = null; }
    }
    function renderSummary() {
      const summary = data.summary;
      summaryError.replaceChildren(...(data.summaryError ? [el('span', '', `Could not load the agents’ status. ${data.summaryError}`), button('Retry', () => loadSummary(), 'secondary-button')] : []));
      summaryError.hidden = !data.summaryError;
      const events = summary?.events;
      journalNote.hidden = !events?.failures && !events?.unavailable;
      journalNote.textContent = events?.unavailable ? `The activity journal ${events.unavailable === 'NETWORK_VERSION_UNSUPPORTED' ? 'was saved by a newer Promptboard version' : 'cannot be read from the data folder'}, so the timeline is empty. Jobs still run and keep their own records.`
        : events?.failures ? `${plural(events.failures, 'event')} could not be saved since the app started, so the timeline may miss them. Job records are unaffected.` : '';
      agentsList.replaceChildren(...(summary?.agents || []).map(agentCard));
      agentsEmpty.replaceChildren(...(!summary ? [note(data.summaryError ? '' : 'Loading agents…')] : summary.agents.length ? []
        : [el('p', 'network-empty-title', 'No agents registered yet.'), note('Register an agent in Agents; its jobs show here.'), button('Go to Agents', () => host.go('#/network'), 'secondary-button')]));
      agentsEmpty.hidden = Boolean(summary?.agents.length);
      const current = agentFilter.value, options = [['', 'All agents'], ...(summary?.agents || []).map(agent => [agent.agentId, agent.name])];
      if ([...agentFilter.options].map(option => option.value).join() !== options.map(([id]) => id).join()) { agentFilter.replaceChildren(...select(options).children); agentFilter.value = options.some(([id]) => id === current) ? current : ''; }
      queueList.replaceChildren(...(summary?.queue || []).map(queueRow));
      queueCount.hidden = !summary?.queueTotal; queueCount.textContent = summary?.queueTotal > (summary?.queue.length || 0) ? `The first ${summary.queue.length} of ${plural(summary.queueTotal, 'open job')}.` : plural(summary?.queueTotal || 0, 'open job');
      queueEmpty.replaceChildren(...(summary && !summary.queue.length ? [note('No open jobs. Running, queued and waiting jobs show here.')] : [])); queueEmpty.hidden = !summary || summary.queue.length > 0;
      kanbanList.replaceChildren(...(summary?.kanban || []).map(kanbanRow));
      kanbanEmpty.replaceChildren(...(summary && !summary.kanban.length ? [note('No Kanban runs of registered agents. A card whose Base agent is registered here shows its runs.')] : [])); kanbanEmpty.hidden = !summary || summary.kanban.length > 0;
    }
    function agentCard(agent) {
      const item = el('li', 'network-activity-agent'); item.dataset.status = agent.status; item.dataset.agentId = agent.agentId;
      const top = el('div', 'network-activity-agent-head'), name = button(agent.name, () => host.openAgent(agent.agentId), 'text-button network-activity-name');
      name.setAttribute('aria-label', `${agent.name}: open its activity`); name.dataset.focusKey = `agent:${agent.agentId}`;
      top.append(name, chip(agent.status));
      const counts = Object.entries(agent.counts).filter(([, n]) => n).map(([status, n]) => `${n} ${stateOf(status)[0].toLowerCase()}`);
      const coverage = el('details', 'network-coverage'); coverage.append(el('summary', '', `${PROVIDERS[agent.provider] || 'No provider'} · ${agent.coverage.label}`), note(agent.coverage.note));
      coverage.dataset.level = agent.coverage.level;
      item.append(top, coverage, note([counts.join(' · ') || 'No open Network job', agent.kanbanActive ? `Kanban: ${agent.kanbanActive} active` : '', !agent.enabled ? 'switched off' : agent.stale ? 'stale' : ''].filter(Boolean).join(' · '), 'note network-activity-counts'));
      return item;
    }
    function openJob(id) { return Object.assign(button('Details', () => host.go(`#/network/activity/${id}`), 'text-button'), { title: 'Open this job’s record' }); }
    function queueRow(row) {
      const item = el('li', 'network-activity-row'); item.dataset.status = row.status;
      const level = row.attempt?.coverage || data.summary?.agents.find(agent => agent.agentId === row.agentId)?.coverage.level;
      const since = row.status === 'running' && row.attempt?.spawnedAt ? `running since ${new Date(row.attempt.spawnedAt).toLocaleTimeString()}`
        : row.status === 'preparing' ? 'preparing to start' : row.waiting?.message || row.reason || (row.status === 'waiting_for_input' ? 'It asked for input. Open its record.' : '');
      const open = openJob(row.id); open.dataset.openJob = row.id; open.dataset.focusKey = `queue:${row.id}`; open.setAttribute('aria-label', `Details of job ${short(row.id)} (${agentName(row.agentId)})`);
      const head = el('div', 'network-activity-row-head'); head.append(chip(row.status), el('strong', '', agentName(row.agentId)), el('span', 'note', `Job ${short(row.id)}`));
      item.append(head, note([since, row.waiting?.position ? `position ${row.waiting.position}` : '', level ? `reports ${coverageName(level)}` : '', row.pipelineRunId ? `pipeline run ${short(row.pipelineRunId)}, step ${row.nodeId || '?'}` : ''].filter(Boolean).join(' · ')),
        note(usageText(row.attempt?.usage), 'note network-usage'), open);
      return item;
    }
    function kanbanRow(run) {
      const item = el('li', 'network-activity-row network-kanban-run'); item.dataset.status = run.status;
      const head = el('div', 'network-activity-row-head'); head.append(chip(run.status, KANBAN_STATES), el('strong', '', run.taskTitle || 'A card that no longer exists'));
      const open = button('Open in Kanban', () => host.openTask(run.projectId, run.taskId), 'text-button'); open.dataset.kanbanRun = run.runId; open.dataset.focusKey = `kanban:${run.runId}`;
      open.setAttribute('aria-label', `Open “${clip(run.taskTitle || 'card', 60)}” in Kanban`);
      if (!run.taskTitle) { open.disabled = true; open.title = 'The card was deleted.'; }
      item.append(head, note([run.projectName, run.stage, PROVIDERS[run.provider] || run.provider, run.agentIds.map(agentName).join(', '), run.updatedAt ? `updated ${ago(run.updatedAt)}` : ''].filter(Boolean).join(' · ')),
        note(usageText(run.usage), 'note network-usage'), open);
      return item;
    }

    // ---- Timeline
    function matches(event) {
      const kind = kindFilter.value, q = search.value.trim().toLowerCase();
      if (agentFilter.value && event.agentId !== agentFilter.value) return false;
      if (kind && kindOf(event) !== kind) return false;
      return !q || [describe(event), event.message, event.errorCode, event.jobId, event.pipelineRunId, event.nodeId, agentName(event.agentId)].some(text => text && String(text).toLowerCase().includes(q));
    }
    function describe(event) {
      // A pipeline step's job names its run and step, so its events read as part of that run.
      const jobText = event.jobId ? `Job ${short(event.jobId)}${event.pipelineRunId ? ` (pipeline run ${short(event.pipelineRunId)}, step ${event.nodeId || '?'})` : ''}` : '', run = `Pipeline run ${short(event.pipelineRunId)}`;
      if (event.type === 'job.status') return `${jobText}: ${event.from ? `${stateOf(event.from)[0]} → ` : ''}${stateOf(event.status)[0]}`;
      if (event.type === 'job.activity') return `${jobText} · ${ACTIVITY[event.kind] || 'Activity'}`;
      if (event.type === 'job.result') return `${jobText} · result saved`;
      if (event.type === 'pipeline.run') return `${run}: ${stateOf(event.status)[0]}`;
      if (event.type === 'pipeline.node') return `${run} · step ${event.nodeId || '?'}: ${stateOf(event.status)[0]}`;
      return `${event.type}${event.status ? `: ${stateOf(event.status)[0]}` : ''}`;
    }
    function eventItem(event, { withAgent = true } = {}) {
      const item = el('li', 'network-event'); item.dataset.seq = String(event.seq); item.dataset.type = event.type;
      const tone = event.status ? stateOf(event.status)[1] : 'activity'; item.dataset.tone = tone;
      const mark = el('span', 'network-event-mark', event.status ? stateOf(event.status)[2] : '•'); mark.setAttribute('aria-hidden', 'true');
      const title = el('p', 'network-event-title');
      if (withAgent && event.agentId) title.append(el('strong', '', agentName(event.agentId)), ' ');
      title.append(describe(event));
      const details = el('p', 'note network-event-meta'); details.append(when(event.at), ` · #${event.seq}`, ...(event.by ? [` · ${BY[event.by] || event.by}`] : []), ...(event.errorCode ? [` · ${event.errorCode}`] : []));
      const body = el('div', 'network-event-body'); body.append(title, details);
      if (event.message) body.append(el('p', 'network-event-message', event.message));
      if (event.coverage) body.append(note(`Reports ${coverageName(event.coverage)}`, 'note network-event-meta'));
      if (event.jobId && (!job || job.id !== event.jobId)) { const open = openJob(event.jobId); open.dataset.openJob = event.jobId; open.dataset.focusKey = `event:${event.seq}`; open.setAttribute('aria-label', `Details of job ${short(event.jobId)}`); body.append(open); }
      item.append(mark, body);
      return item;
    }
    function renderFeed() {
      const shownEvents = data.feed.filter(matches).reverse();
      feedList.setAttribute('aria-busy', String(!data.loaded && !data.error));
      feedList.replaceChildren(...shownEvents.map(event => eventItem(event)));
      const filtered = Boolean(agentFilter.value || kindFilter.value || search.value.trim());
      feedEmpty.replaceChildren(); feedEmpty.hidden = shownEvents.length > 0;
      if (data.error) { const failure = el('p', 'inline-error', `Could not load the timeline. ${data.error}`); failure.setAttribute('role', 'alert'); feedEmpty.append(failure, button('Retry', () => { live.controller?.abort(); live.wake?.(); void loadFeed(); }, 'secondary-button')); }
      else if (!data.loaded) feedEmpty.append(note('Loading the timeline…'));
      else if (!data.feed.length) feedEmpty.append(el('p', 'network-empty-title', 'No activity yet.'), note('Jobs of Network agents appear here as they are queued, start, wait and end, with what their CLI reports while they run.'));
      else if (filtered) feedEmpty.append(note('No events match.'), button('Clear filters', () => { agentFilter.value = ''; kindFilter.value = ''; search.value = ''; renderFeed(); }, 'secondary-button'));
      older.hidden = !data.loaded || data.prev === null;
      gapNote.hidden = !data.loaded || data.prev !== null || data.oldest <= 1;
    }
    for (const control of [agentFilter, kindFilter]) control.addEventListener('change', () => renderFeed());
    let searchTimer = null;
    search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderFeed, 150); });

    // ---- One job: its record (Task 06 routes), its result when the app can serve it, and its events.
    async function loadJob(id, { quiet = false } = {}) {
      if (!quiet) job = { id, record: null, error: '', events: [], result: null, loading: true };
      try {
        const [record, events] = await Promise.all([host.request(`/api/network/jobs/${id}`), host.request(`/api/network/events?jobId=${id}&limit=200`)]);
        if (job?.id !== id) return;
        Object.assign(job, { record, error: '', loading: false });
        for (const event of events.events) if (!job.events.some(known => known.seq === event.seq)) job.events.push(event);
        job.events.sort((a, b) => a.seq - b.seq);
        if (record.job.result && job.result === null) {
          job.result = { text: null };
          host.request(`/api/network/jobs/${id}/result`).then(answer => { if (job?.id === id) { job.result = { text: typeof answer.text === 'string' ? answer.text : answer.result?.text ?? null }; scheduleRender(); } }, () => {});
        }
      } catch (failure) { if (job?.id === id) Object.assign(job, { error: failure.message, loading: false }); }
      scheduleRender();
    }
    /** A step job's run: the timeline filtered to that run's events (its steps, their jobs and their activity). */
    function runLink(id) {
      const node = button(`Run ${short(id)}: show its events`, () => { agentFilter.value = ''; kindFilter.value = ''; search.value = id; focusJob = 'search'; host.go('#/network/activity'); }, 'text-button');
      node.id = 'network-activity-run-events'; node.title = id;
      return node;
    }
    function renderJob() {
      const back = button('Back to Activity', () => { focusJob = job?.id; host.go('#/network/activity'); }, 'text-button network-back-activity'); back.id = 'network-activity-back';
      if (!job || job.loading) { jobView.replaceChildren(back, note('Loading the job…')); return; }
      if (job.error) { const failure = el('p', 'inline-error', job.error); failure.setAttribute('role', 'alert'); jobView.replaceChildren(back, failure); return; }
      const { job: record, request } = job.record, attempt = record.attempts.find(item => item.id === record.currentAttemptId) || record.attempts.at(-1);
      const heading = el('h3', 'network-activity-job-title', `Job ${short(record.id)}`); heading.id = 'network-activity-job-heading'; heading.tabIndex = -1;
      const title = el('div', 'network-activity-row-head'); title.append(heading, chip(record.status));
      const agent = button(agentName(record.agentId), () => host.openAgent(record.agentId), 'text-button');
      const rows = [['Job ID', el('code', '', record.id)], ['Agent', agent], ['Status', record.waiting?.message || record.reason || stateOf(record.status)[0]],
        ...(record.outcome ? [['Outcome', { completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', uncertain: 'Uncertain: it may have done its work', not_started: 'Nothing ran' }[record.outcome] || record.outcome]] : []),
        ...(record.errorCode ? [['Error', record.errorCode]] : []), ['Submitted', `${new Date(record.createdAt).toLocaleString()} (${ago(record.createdAt)})`], ['Updated', ago(record.updatedAt)],
        ...(request ? [['Tools', request.tools === 'web' ? 'Read-only web search' : 'None'], ['Time limit', `${Math.round(request.limits.timeoutMs / 60000) || '<1'} min`], ['Input', clip(request.input.text, 280)]] : [['Request', 'Its accepted request failed its integrity check.']]),
        ...['projectId', 'networkId', 'parentJobId'].filter(key => record[key]).map(key => [{ projectId: 'Project', networkId: 'Network', parentJobId: 'Parent job' }[key], el('code', '', record[key])]),
        ...(record.pipelineRunId ? [['Pipeline run', runLink(record.pipelineRunId)], ['Pipeline step', el('code', '', record.nodeId || '?')]] : [])];
      const facts = el('dl', 'network-facts');
      for (const [label, value] of rows) { const dd = el('dd'); dd.append(value); facts.append(el('dt', '', label), dd); }
      const attempts = el('ol', 'network-activity-attempts');
      for (const item of record.attempts) {
        const line = el('li');
        line.append(chip(item.status === 'claimed' || item.status === 'launching' ? 'preparing' : item.status), ` Attempt ${item.number} · ${[PROVIDERS[item.provider] || item.provider, item.model].filter(Boolean).join(' ')}`,
          note([item.coverage ? `Reported ${coverageName(item.coverage)}` : `Reports ${expected(record.agentId)}`, item.spawnedAt ? `started ${new Date(item.spawnedAt).toLocaleTimeString()}` : 'not started', item.endedAt ? `ended ${new Date(item.endedAt).toLocaleTimeString()}` : '', item.pid ? `process ${item.pid}` : ''].filter(Boolean).join(' · ')),
          note(usageText(item.usage?.reported ? { inputTokens: item.usage.inputTokens ?? null, outputTokens: item.usage.outputTokens ?? null, costUsd: item.usage.costUsd ?? item.usage.costUSD ?? null } : null), 'note network-usage'));
        attempts.append(line);
      }
      const history = el('ol', 'network-history-list');
      for (const entry of record.history) history.append(el('li', '', `${stateOf(entry.status)[0]} · ${BY[entry.by] || entry.by} · ${new Date(entry.at).toLocaleString()}`));
      const result = [];
      if (record.result) {
        result.push(note(`Saved result: ${plural(record.result.chars, 'character')}.`));
        if (typeof job.result?.text === 'string') { const text = el('pre', 'network-preview-text network-result', job.result.text); text.tabIndex = 0; text.setAttribute('aria-label', 'Job result'); result.push(text); }
        else result.push(note('The result text is not shown here in this version; it is kept with the job.'));
      } else result.push(note(record.status === 'completed' ? 'No result was saved.' : 'No result yet. A result appears only when the job completes with one.'));
      const events = el('ol', 'network-events network-job-events'); events.id = 'network-activity-job-events'; events.setAttribute('aria-label', 'Events of this job, newest first');
      events.append(...[...job.events].reverse().map(event => eventItem(event, { withAgent: false })));
      const eventsEmpty = job.events.length ? [] : [note('No events of this job are in the journal.')];
      keepFocus(jobView, () => jobView.replaceChildren(back, title, facts, el('h3', '', 'Attempts'), ...(record.attempts.length ? [attempts] : [note('Not claimed yet.')]), el('h3', '', 'Result'), ...result,
        el('h3', '', 'Status history'), history, el('h3', '', 'Events'), events, ...eventsEmpty));
      if (focusHeading) { heading.focus(); focusHeading = false; }
    }

    // ---- An agent's Activity tab: its status, open jobs, Kanban runs and events.
    const agentRoot = el('section', 'network-agent-activity'); agentRoot.setAttribute('aria-label', 'Activity');
    function agentPanel(agent) {
      if (agentView?.agent.id !== agent.id) agentView = { agent, events: [], loading: false, loaded: false, error: '' };
      agentView.agent = agent;
      renderAgent();
      return agentRoot;
    }
    /** Read the shown agent's events once its tab opens (not while the tab is hidden). */
    function loadAgent() {
      const view = agentView;
      if (!view || view.loading || view.loaded) return;
      view.loading = true; view.error = '';
      host.request(`/api/network/events?agentId=${view.agent.id}&limit=${PAGE}`).then(page => {
        view.events = [...page.events, ...view.events.filter(event => !page.events.some(known => known.seq === event.seq))].sort((a, b) => a.seq - b.seq);
        view.loaded = true;
      }, failure => { view.error = failure.message; }).finally(() => { view.loading = false; if (agentView === view) renderAgent(); });
      if (!data.summary) void loadSummary();
      renderAgent();
    }
    function renderAgent() {
      if (!agentView) return;
      const { agent } = agentView, entry = data.summary?.agents.find(item => item.agentId === agent.id);
      const nodes = [el('h3', '', 'Status')];
      if (entry) {
        const line = el('div', 'network-activity-row-head'); line.append(chip(entry.status), el('span', 'note', `${PROVIDERS[entry.provider] || 'No provider'} · ${entry.coverage.label}`));
        nodes.push(line, note(entry.coverage.note, 'note network-coverage-note'));
      } else nodes.push(note(data.summaryError ? `Could not load the status. ${data.summaryError}` : 'Loading the status…'));
      const retry = agentView.error ? [button('Retry', () => loadAgent(), 'secondary-button')] : [];
      const jobs = (data.summary?.queue || []).filter(row => row.agentId === agent.id), runs = (data.summary?.kanban || []).filter(run => run.agentIds.includes(agent.id));
      const jobList = el('ul', 'network-activity-rows'); jobList.id = 'network-agent-activity-jobs'; jobList.setAttribute('aria-label', 'Open jobs of this agent'); jobList.append(...jobs.map(queueRow));
      const runList = el('ul', 'network-activity-rows'); runList.setAttribute('aria-label', 'Kanban runs of this agent'); runList.append(...runs.map(kanbanRow));
      const eventList = el('ol', 'network-events'); eventList.id = 'network-agent-activity-feed'; eventList.setAttribute('aria-label', 'Events of this agent, newest first');
      eventList.append(...[...agentView.events].reverse().map(event => eventItem(event, { withAgent: false })));
      nodes.push(el('h3', '', 'Open jobs'), ...(jobs.length ? [jobList] : [note('No open Network job.')]), el('h3', '', 'Kanban runs (read only)'), ...(runs.length ? [runList] : [note('No Kanban runs use this agent’s Base definition.')]),
        el('h3', '', 'Events'), ...(agentView.error ? [el('p', 'inline-error', `Could not load the events. ${agentView.error}`), ...retry] : !agentView.loaded ? [note('Loading events…')] : agentView.events.length ? [eventList] : [el('p', 'network-empty-title', 'No activity yet.'), note('This agent’s Network jobs appear here as they are queued, run and end.')]),
        button('Open the whole timeline', () => host.go('#/network/activity'), 'text-button'));
      keepFocus(agentRoot, () => agentRoot.replaceChildren(...nodes));
    }

    /** Show the Activity section for route `where` ({ jobId? }) or hide it (null). */
    function show(where) {
      const entering = !shown && where;
      shown = where; panel.hidden = !where;
      if (!where) return;
      if (entering) void loadSummary();
      if (where.jobId && job?.id !== where.jobId) { focusHeading = true; void loadJob(where.jobId); }
      if (!where.jobId) job = null;
      render();
    }
    // `live(on)`: the stream runs while Activity or an agent's Activity tab shows. Off and on again, it replays what it
    // missed from the last seq it saw, so the timeline and the agent's events stay whole.
    return { panel, show, agentPanel, loadAgent, live: want, streaming: () => live.state === 'live' };
  }
  return { create };
})();
