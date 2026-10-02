'use strict';
// Terminal dock (PB-03). Agent sessions are owned by the server; this page only shows them.
// Terminal output is untrusted data. It is written to xterm, or to a <pre> through
// textContent, and never parsed as HTML. Links are never opened automatically.
// Uses helpers from app.js: $, api, token, announce, savePref, board, currentProject.

const DOCK_HEIGHT_KEY = 'promptboard.dock.height';
const DOCK_STATE_KEY = 'promptboard.dock.state';
const DOCK_LIVE = new Set(['queued', 'running', 'waiting_for_input']);
const DOCK_PLAIN_LIMIT = 400_000;
const dock = { sessions: new Map(), selected: 'activity', state: 'collapsed', height: 320, stopFor: null, dismissed: new Set() };
window.promptboardDock = dock; // Read-only handle for tests.

const nextFrame = fn => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 0));

function dockPref(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }

function applyDockHeight() {
  const view = $('#kanban-view');
  const limit = Math.max(160, window.innerHeight - 140);
  const barHeight = Math.max(44, Math.ceil($('#dock .dock-bar').getBoundingClientRect().height));
  const promptHeight = $('#dock-stop-prompt').hidden ? 0 : Math.ceil($('#dock-stop-prompt').getBoundingClientRect().height);
  const height = dock.state === 'collapsed' ? barHeight + promptHeight + 1 : Math.max(Math.min(limit, barHeight + promptHeight + 80), Math.max(160, Math.min(limit, dock.height)));
  $('#dock').style.height = dock.state === 'max' ? '' : `${height}px`;
  view.style.setProperty('--dock-height', `${dock.state === 'max' ? dock.height : height}px`);
  $('#dock-divider').setAttribute('aria-valuenow', String(height));
  $('#dock-divider').setAttribute('aria-valuemax', String(limit));
  fitBoardHeight(true);
}

function setDockState(state, save = true) {
  dock.state = state;
  $('#dock').dataset.state = state;
  $('#dock-body').hidden = state === 'collapsed';
  $('#dock-toggle').textContent = state === 'collapsed' ? 'Expand' : 'Collapse';
  $('#dock-toggle').setAttribute('aria-expanded', String(state !== 'collapsed'));
  $('#dock-max').textContent = state === 'max' ? 'Restore' : 'Maximize';
  $('#dock-max').setAttribute('aria-pressed', String(state === 'max'));
  applyDockHeight();
  if (save) savePref(DOCK_STATE_KEY, state === 'max' ? 'open' : state);
  // A restored terminal must be refitted to its new size. Collapsing never stops a process.
  nextFrame(() => {
    const session = dock.sessions.get(dock.selected);
    session?.tab.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    fitSession(session);
  });
}

function stripTerminal(text) {
  return text.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '').replace(/\x1b[()][0-9A-Za-z]/g, '').replace(/\r(?!\n)/g, '');
}

function createSession(run) {
  const task = board?.projects.flatMap(project => project.tasks).find(item => item.id === run.taskId);
  const title = `${task?.title || 'Task'} · ${columnTitle(run.stage)}`;
  const panel = document.createElement('div');
  panel.className = 'dock-terminal';
  panel.id = `dock-panel-${run.id}`;
  panel.setAttribute('role', 'tabpanel');
  panel.hidden = true;
  const tab = document.createElement('button');
  tab.type = 'button';
  tab.className = 'dock-tab';
  tab.id = `dock-tab-${run.id}`;
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-selected', 'false');
  tab.setAttribute('aria-controls', panel.id);
  panel.setAttribute('aria-labelledby', tab.id);
  const icon = document.createElement('span'); icon.className = 'tab-state'; icon.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  // Closing a tab only hides it here. The agent keeps running; its run history stays.
  const close = document.createElement('span'); close.className = 'tab-close'; close.textContent = '×'; close.setAttribute('aria-hidden', 'true');
  close.title = 'Close this tab (the agent keeps running)';
  close.addEventListener('click', event => { event.stopPropagation(); closeSession(run.id); });
  tab.append(icon, label, close);
  tab.addEventListener('click', () => selectDockTab(run.id, true));
  tab.addEventListener('keydown', event => { if (event.key === 'Delete') { event.preventDefault(); closeSession(run.id); } });
  $('#dock-tabs').append(tab);
  $('#dock-terminals').append(panel);
  const session = { runId: run.id, taskId: run.taskId, run, title, panel, tab, label, icon, wasLive: DOCK_LIVE.has(run.status), lastSeq: 0, pending: 0, input: '', ended: !DOCK_LIVE.has(run.status), closed: false, cols: 0, rows: 0, connection: 'connecting', lastOutputAt: null };
  attachRenderer(session);
  dock.sessions.set(run.id, session);
  updateSessionTab(session);
  streamSession(session); // Live runs stream; ended runs replay their kept output, then stop.
  if (typeof ResizeObserver === 'function') (session.observer = new ResizeObserver(() => fitSession(session))).observe(panel);
  return session;
}

/** Remove a tab and its terminal view. Never stops the process or deletes run history. */
function closeSession(runId, quiet = false) {
  const session = dock.sessions.get(runId);
  if (!session) return;
  session.closed = true;
  session.abort?.abort();
  session.observer?.disconnect();
  session.term?.dispose();
  session.tab.remove(); session.panel.remove();
  dock.sessions.delete(runId);
  dock.dismissed.add(runId);
  if (dock.selected === runId) selectDockTab('activity');
  updateDockIndicator();
  if (!quiet) announce(`Closed the tab for ${session.title}.${DOCK_LIVE.has(session.run.status) ? ' The agent keeps running.' : ''}`);
}

function attachRenderer(session) {
  const { panel } = session;
  // The DOM renderer relies on inline styles blocked by our CSP. Without WebGL,
  // use the readable text renderer rather than leaving an empty interactive terminal.
  if (typeof Terminal === 'function' && typeof WebglAddon === 'object') {
    try {
      const term = new Terminal({ scrollback: 5000, fontSize: Number(uiPref('termFont')) || 12, fontFamily: 'ui-monospace, "SFMono-Regular", Consolas, monospace', cursorBlink: false, convertEol: false,
        theme: { background: '#111111', foreground: '#eeeeee' },
        // Links in agent output are shown, never opened automatically.
        linkHandler: { activate: (_event, uri) => dockNote(`Link not opened automatically: ${uri}`), allowNonHttpProtocols: false } });
      const fit = typeof FitAddon === 'object' ? new FitAddon.FitAddon() : null;
      if (fit) term.loadAddon(fit);
      term.open(panel);
      session.term = term;
      // The WebGL renderer draws to a canvas, so it works under the page's strict style policy.
      const webgl = new WebglAddon.WebglAddon();
      webgl.onContextLoss(() => {
        let text = '';
        const buffer = term.buffer.active;
        for (let i = 0; i < buffer.length; i++) text += `${buffer.getLine(i)?.translateToString(true) || ''}\n`;
        attachPlainRenderer(session, text);
        dockNote('Terminal graphics were lost. Live output is shown as text; the agent keeps running.');
      });
      term.loadAddon(webgl);
      term.onData(data => sendInput(session, data));
      Object.assign(session, { term, fit, write: (data, done) => term.write(data, done) });
      return;
    } catch {
      session.term?.dispose();
      panel.replaceChildren();
    }
  }
  attachPlainRenderer(session);
  dockNote('Interactive terminal graphics are unavailable. Live output is shown as text.');
}

function attachPlainRenderer(session, text = '') {
  const { panel } = session;
  session.term?.dispose();
  session.term = null; session.fit = null;
  session.pending = 0; session.drained?.();
  panel.replaceChildren();
  // Plain fallback: readable text through textContent, no input.
  const pre = document.createElement('pre');
  pre.setAttribute('aria-live', 'off');
  pre.textContent = text.slice(-DOCK_PLAIN_LIMIT);
  panel.append(pre);
  session.pre = pre;
  session.write = (data, done) => {
    pre.textContent = (pre.textContent + stripTerminal(data)).slice(-DOCK_PLAIN_LIMIT);
    panel.scrollTop = panel.scrollHeight;
    done?.();
  };
}

function dockNote(message) { $('#dock-note').textContent = message; $('#dock-note').hidden = !message; }

function write(session, data) {
  // Client-side backpressure: stop reading while xterm has a large backlog to render.
  session.pending += data.length;
  session.write(data, () => { session.pending = Math.max(0, session.pending - data.length); if (session.pending < 256 * 1024) session.drained?.(); });
}

async function streamSession(session) {
  while (!session.closed && typeof document !== 'undefined') {
    const controller = new AbortController();
    session.abort = controller;
    session.connection = session.lastSeq ? 'reconnecting' : 'connecting';
    renderDockConnection(session);
    try {
      // fetch keeps the session token in a header; it never appears in a URL.
      const response = await fetch(`/api/runs/${encodeURIComponent(session.runId)}/stream?after=${session.lastSeq}`, { cache: 'no-store', headers: { 'X-STE-Token': token }, signal: controller.signal });
      if (response.status === 404) { await replayRecordedOutput(session); markEnded(session); return; }
      if (!response.ok || !response.body) throw new Error('stream');
      session.connection = 'connected';
      renderDockConnection(session);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let sliceStart = performance.now();
      for (;;) {
        // Reads of already-buffered data resolve as microtasks and would starve the page.
        // Yield to the event loop every few milliseconds so the board stays responsive.
        if (performance.now() - sliceStart > 8) { await new Promise(resolve => setTimeout(resolve, 0)); sliceStart = performance.now(); }
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let item; try { item = JSON.parse(line); } catch { continue; }
          if (item.missing) await replayRecordedOutput(session);
          handleItem(session, item);
          if (session.pending > 2 * 1024 * 1024) await new Promise(resolve => { session.drained = resolve; });
        }
      }
      if (session.ended) { session.connection = 'ended'; renderDockConnection(session); return; }
    } catch { if (session.closed) return; }
    session.connection = 'reconnecting'; renderDockConnection(session);
    await new Promise(resolve => setTimeout(resolve, 1000)); // Reconnect to the same run; never restart it.
  }
}

async function replayRecordedOutput(session) {
  if (session.replayedLog || session.closed) return;
  session.replayedLog = true;
  const { response, data } = await api(`/api/runs/${encodeURIComponent(session.runId)}/output`, { timeoutMs: 15000 }).catch(() => ({ response: { ok: false }, data: {} }));
  if (session.closed) return;
  // The server has no live session after a restart; read its bounded saved log.
  // Replace reconnect scrollback so already-received chunks are not duplicated.
  session.term?.reset();
  if (session.pre) session.pre.textContent = '';
  write(session, response.ok && data.text ? data.text : '\r\n[Promptboard: no recorded output is available for this run]\r\n');
  session.savedOutput = true;
}

function handleItem(session, item) {
  if (item.ping) return;
  if (item.gap) write(session, '\r\n[Promptboard: earlier output was dropped because the view fell behind]\r\n');
  if (Number.isInteger(item.seq)) session.lastSeq = item.seq;
  if (typeof item.data === 'string') { session.lastOutputAt = Date.now(); write(session, item.data); renderDockConnection(session); }
  if (item.usage && typeof item.usage === 'object') { session.run = { ...session.run, usage: item.usage }; if (dock.selected === session.runId) renderDockDetails(session); }
  if (item.status) { session.run = { ...session.run, status: item.status, waitingReason: item.reason || '' }; updateSessionTab(session); updateDockIndicator(); scheduleBoardRefresh(); }
  if (item.ended || item.missing) markEnded(session);
}

// Card badges come from the board; refresh it (debounced) when a run's status changes.
function scheduleBoardRefresh() {
  clearTimeout(dock.refreshTimer);
  dock.refreshTimer = setTimeout(() => loadBoard(), 300);
}

function markEnded(session) {
  session.connection = 'ended';
  renderDockConnection(session);
  if (session.ended && !DOCK_LIVE.has(session.run.status)) return;
  session.ended = true;
  updateSessionTab(session);
  updateDockIndicator();
  scheduleBoardRefresh();
}

function updateSessionTab(session) {
  const live = !session.ended && DOCK_LIVE.has(session.run.status);
  const run = live ? session.run : { ...session.run, status: DOCK_LIVE.has(session.run.status) ? 'interrupted' : session.run.status };
  const state = agentState(run);
  const task = board?.projects.flatMap(project => project.tasks).find(task => task.id === session.taskId);
  const title = task?.title || 'Task';
  session.label.textContent = `${title.length > 20 ? `${title.slice(0, 19)}…` : title} · ${agentModel(session.run)}`;
  session.tab.classList.toggle('live', state === 'active');
  session.tab.classList.toggle('waiting', state === 'awaits_you');
  session.tab.dataset.state = state;
  session.icon.textContent = AGENT_STATE_ICON[state];
  session.tab.setAttribute('aria-label', `${session.title}, ${agentModel(session.run)}: ${agentStateText(run)}`);
  session.tab.title = `${session.title}\n${agentModel(session.run)}\n${agentStateText(run)}${run.waitingReason ? `\n${run.waitingReason}` : ''}`;
  if (dock.selected === session.runId) { $('#dock-stop').hidden = !live; $('#dock-copy').hidden = !session.term; renderDockDetails(session); }
}

/** Facts about the selected run, from the board's run record only. */
function renderDockDetails(session) {
  const details = $('#dock-details');
  // Native toggle events are asynchronous; capture the DOM before a refresh replaces it.
  const previous = dock.sessions.get(details.dataset.runId);
  const previousContext = details.querySelector('.dock-context');
  if (previous && previousContext) previous.detailsOpen = previousContext.open;
  details.dataset.runId = session?.runId || '';
  details.hidden = !session;
  if (!session) { $('#dock-connection').hidden = true; return; }
  const run = session.run; // Merged from the board in syncDock and from stream status items.
  const shown = session.ended && DOCK_LIVE.has(run.status) ? { ...run, status: 'interrupted' } : run;
  const project = board?.projects.find(project => project.id === run.projectId || project.tasks.some(task => task.id === run.taskId));
  const summary = paragraph('', 'dock-run-summary');
  summary.append(`${agentModel(run)} · ${columnTitle(run.stage, project)} · ${agentStateText(shown)} · `, elapsedSpan(run));
  const location = document.createElement('div'); location.className = 'dock-location';
  location.append(locationFact('Repository', project?.repository?.root), locationFact('Task branch', run.branch), locationFact('Worktree', run.workspacePath));
  const context = document.createElement('details'); context.className = 'dock-context';
  context.open = Boolean(session.detailsOpen);
  const toggle = document.createElement('summary'); toggle.textContent = 'Run details';
  context.append(toggle, paragraph(agentActivity(shown), 'dock-run-activity'), location,
    paragraph(usageText(run) || (run.config?.provider === 'gemini' ? 'Usage: not reported by Gemini CLI' : 'Usage: not reported yet'), 'dock-usage'));
  if (window.PromptboardBaseView) context.append(window.PromptboardBaseView.runManifest(run));
  context.addEventListener('toggle', () => {
    if (!context.isConnected) return;
    session.detailsOpen = context.open;
    nextFrame(() => fitSession(session));
  });
  details.replaceChildren(summary, context);
  details.title = details.textContent;
  renderDockConnection(session);
}

function renderDockConnection(session = dock.sessions.get(dock.selected)) {
  if (!session || session.closed || session.runId !== dock.selected || typeof document === 'undefined') return;
  const status = $('#dock-connection'); status.hidden = false;
  status.classList.toggle('kanban-error', session.connection === 'reconnecting');
  status.textContent = session.savedOutput ? 'Saved output · this session has ended.'
    : session.connection === 'ended' ? 'Session ended · output remains available.'
    : session.connection === 'connecting' ? 'Connecting to the agent terminal…'
    : session.connection === 'reconnecting' ? 'Connection lost. Reconnecting to this agent…'
    : session.lastOutputAt ? `Connected · last output ${Math.max(0, Math.floor((Date.now() - session.lastOutputAt) / 1000))}s ago.`
    : session.run.status === 'queued' ? 'Connected · waiting for an agent slot.' : 'Connected · waiting for CLI output. Check the terminal for a startup or permission question.';
}

function updateDockIndicator() {
  // Counts every live run on the board, including runs whose tab was closed.
  const live = (board?.runs || []).filter(run => DOCK_LIVE.has(run.status));
  const waiting = live.filter(run => run.status === 'waiting_for_input');
  const indicator = $('#dock-indicator');
  indicator.textContent = waiting.length ? `${waiting.length} waiting for you` : live.length ? `${live.length} running` : '';
  indicator.classList.toggle('waiting', waiting.length > 0);
  $('#dock-empty').hidden = dock.sessions.size > 0;
}

function sendInput(session, data) {
  if (session.ended) return;
  session.input += data;
  clearTimeout(session.inputTimer);
  session.inputTimer = setTimeout(() => {
    const chunk = session.input; session.input = '';
    if (chunk) api(`/api/runs/${encodeURIComponent(session.runId)}/input`, { method: 'POST', body: { data: chunk }, timeoutMs: 10000 })
      .then(({ response, data }) => { if (!response.ok) dockNote(data.error || 'Input was not delivered. Check the agent status.'); })
      .catch(() => dockNote('Input was not delivered. Check that the app is running.'));
  }, 15);
}

function fitSession(session) {
  if (!session?.fit || session.panel.hidden || dock.state === 'collapsed' || !session.panel.clientWidth) return;
  try { session.fit.fit(); } catch { return; }
  const { cols, rows } = session.term;
  if (cols === session.cols && rows === session.rows) return;
  session.cols = cols; session.rows = rows;
  clearTimeout(session.resizeTimer);
  session.resizeTimer = setTimeout(() => {
    if (!session.ended) api(`/api/runs/${encodeURIComponent(session.runId)}/resize`, { method: 'POST', body: { cols, rows }, timeoutMs: 10000 }).catch(() => {});
  }, 150);
}

function selectDockTab(id, focus = false) {
  dock.selected = id;
  for (const tab of $('#dock-tabs').children) tab.setAttribute('aria-selected', String(tab.id === (id === 'activity' ? 'dock-tab-activity' : `dock-tab-${id}`)));
  $('#dock-activity').hidden = id !== 'activity';
  for (const session of dock.sessions.values()) session.panel.hidden = session.runId !== id;
  const session = dock.sessions.get(id);
  session?.tab.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  $('#dock-stop').hidden = !session || session.ended || !DOCK_LIVE.has(session.run.status);
  $('#dock-copy').hidden = !session?.term;
  renderDockDetails(session);
  if (session) nextFrame(() => { fitSession(session); if (focus) session.term?.focus(); });
}

function renderActivity() {
  const list = $('#dock-activity-list');
  const runs = (board?.runs || []).slice(-30).reverse();
  const titles = new Map(board?.projects.flatMap(project => project.tasks).map(task => [task.id, task.title]));
  list.replaceChildren(...runs.map(run => {
    const item = document.createElement('li');
    const when = new Date(run.updatedAt || run.createdAt).toLocaleTimeString();
    item.textContent = `${when} · ${titles.get(run.taskId) || 'Deleted task'} · ${run.stage} · ${run.status.replaceAll('_', ' ')}${run.reason ? ` · ${run.reason}` : ''}`;
    if (['failed', 'interrupted'].includes(run.status)) item.className = 'run-failed';
    return item;
  }));
  $('#dock-empty').hidden = runs.length > 0 || dock.sessions.size > 0;
}

/** Called after every board render. Opens a tab for each live run; never restarts a run. */
function syncDock() {
  if (!board) return;
  for (const run of board.runs) {
    const session = dock.sessions.get(run.id);
    if (session) {
      session.run = { ...session.run, ...run };
      if (!DOCK_LIVE.has(run.status)) session.ended = true;
      updateSessionTab(session);
      // Settings: "Keep tabs of finished runs" off closes a tab once its run ends (unless it is shown).
      if (session.ended && session.wasLive && uiPref('keepTabs') !== '1' && dock.selected !== run.id) closeSession(run.id, true);
    } else if (DOCK_LIVE.has(run.status) && !dock.dismissed.has(run.id)) createSession(run);
  }
  renderActivity();
  updateDockIndicator();
  renderDockDetails(dock.sessions.get(dock.selected));
  // An empty dock stays collapsed. After a reload, reopen it only if live sessions exist.
  if (!dock.restored) {
    dock.restored = true;
    const start = uiPref('dockStart');
    if (start === 'open' || (start === 'last' && dockPref(DOCK_STATE_KEY, 'collapsed') === 'open' && board.runs.some(run => DOCK_LIVE.has(run.status)))) setDockState('open', false);
  }
}

/** Show the session for a run (after the user starts it or selects its card). */
function openRun(runId) {
  const run = board?.runs.find(item => item.id === runId);
  if (!run) return;
  dock.dismissed.delete(runId);
  if (!dock.sessions.has(runId)) createSession(run);
  if (dock.state === 'collapsed') setDockState('open');
  selectDockTab(runId);
}

function revealTask(taskId) {
  const sessions = [...dock.sessions.values()].filter(session => session.taskId === taskId);
  const latest = sessions.at(-1) || null;
  if (latest) openRun(latest.runId);
  return Boolean(latest);
}

function stopSelected() {
  const session = dock.sessions.get(dock.selected);
  if (!session || session.ended || dock.stopFor) return;
  if (dock.state === 'collapsed') setDockState('open');
  dock.stopFor = session.runId;
  const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'danger'; confirm.textContent = 'Stop this agent';
  const keep = document.createElement('button'); keep.type = 'button'; keep.textContent = 'Keep running';
  const box = $('#dock-stop-prompt');
  const message = document.createElement('span');
  message.setAttribute('role', 'status');
  message.textContent = `Stop “${session.title}”? Files and output are kept.`;
  box.replaceChildren(message, confirm, keep);
  box.hidden = false;
  applyDockHeight();
  confirm.focus();
  const dismiss = () => { box.hidden = true; dock.stopFor = null; $('#dock-stop').disabled = false; applyDockHeight(); };
  keep.addEventListener('click', dismiss);
  confirm.addEventListener('click', async () => {
    if (confirm.disabled) return;
    confirm.disabled = true; keep.disabled = true; $('#dock-stop').disabled = true;
    message.textContent = `Stopping “${session.title}”…`;
    applyDockHeight();
    const { response, data } = await api(`/api/runs/${encodeURIComponent(session.runId)}/cancel`, { method: 'POST', body: { confirm: true }, timeoutMs: 15000 }).catch(() => ({ response: { ok: false }, data: {} }));
    if (response.ok) {
      dismiss();
      if (data.board) { acceptBoard(data.board); renderBoard(); }
      announce(`Stopped ${session.title}. Files and output are kept.`);
      $('#dock-toggle').focus();
    } else {
      message.textContent = data.error || 'The agent could not be stopped. Try again.';
      confirm.disabled = false; keep.disabled = false; $('#dock-stop').disabled = false;
      confirm.textContent = 'Retry stop';
      applyDockHeight();
    }
  });
}

async function copySelection() {
  const session = dock.sessions.get(dock.selected);
  const text = session?.term?.getSelection() || '';
  if (!text) { dockNote('Select text in the terminal first.'); return; }
  try { await navigator.clipboard.writeText(text); announce('Terminal selection copied.'); }
  catch { dockNote('Clipboard access was not granted. Use your browser\'s copy shortcut.'); }
}

function startDividerDrag(event) {
  event.preventDefault();
  const move = e => { dock.height = Math.max(160, Math.min(window.innerHeight - 140, window.innerHeight - e.clientY)); applyDockHeight(); };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); savePref(DOCK_HEIGHT_KEY, String(dock.height)); fitSession(dock.sessions.get(dock.selected)); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

(function initDock() {
  dock.height = Math.max(160, Math.min(900, Number(dockPref(DOCK_HEIGHT_KEY, '320')) || 320));
  $('#dock-toggle').addEventListener('click', () => setDockState(dock.state === 'collapsed' ? 'open' : 'collapsed'));
  $('#dock-max').addEventListener('click', () => setDockState(dock.state === 'max' ? 'open' : 'max'));
  $('#dock-tab-activity').addEventListener('click', () => selectDockTab('activity'));
  $('#dock-stop').addEventListener('click', stopSelected);
  $('#dock-copy').addEventListener('click', copySelection);
  $('#dock-divider').addEventListener('pointerdown', startDividerDrag);
  if (typeof ResizeObserver === 'function') {
    const controls = new ResizeObserver(() => {
      applyDockHeight();
      const session = dock.sessions.get(dock.selected);
      session?.tab.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      fitSession(session);
    });
    controls.observe($('#dock .dock-bar'));
    controls.observe($('#dock-tabs'));
    controls.observe($('#dock-stop-prompt'));
  }
  window.addEventListener('resize', () => nextFrame(() => {
    applyDockHeight();
    const session = dock.sessions.get(dock.selected);
    session?.tab.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    fitSession(session);
  }));
  $('#dock-divider').addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    dock.height = Math.max(160, Math.min(window.innerHeight - 140, dock.height + (event.key === 'ArrowUp' ? 24 : -24)));
    applyDockHeight(); savePref(DOCK_HEIGHT_KEY, String(dock.height)); fitSession(dock.sessions.get(dock.selected));
  });
  $('#dock-tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const tabs = [...$('#dock-tabs').children];
    const next = tabs[(tabs.indexOf(document.activeElement) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    next?.focus(); next?.click();
  });
  const setFontSize = size => { for (const session of dock.sessions.values()) if (session.term) { session.term.options.fontSize = size; fitSession(session); } };
  const closeFinished = () => { const ended = [...dock.sessions.values()].filter(session => session.ended); for (const session of ended) closeSession(session.runId, true); return ended.length; };
  window.PromptboardDock = { sync: syncDock, open: openRun, reveal: revealTask, setState: setDockState, setFontSize, closeFinished, tick: renderDockConnection };
  setDockState('collapsed', false);
  syncDock();
})();
