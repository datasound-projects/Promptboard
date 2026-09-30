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
  const height = dock.state === 'collapsed' ? 44 : dock.height;
  $('#dock').style.height = dock.state === 'max' ? '' : `${height}px`;
  view.style.setProperty('--dock-height', `${dock.state === 'max' ? dock.height : height}px`);
  $('#dock-divider').setAttribute('aria-valuenow', String(dock.height));
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
  nextFrame(() => fitSession(dock.sessions.get(dock.selected)));
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
  const short = (task?.title || 'Task').length > 24 ? `${(task?.title || 'Task').slice(0, 23)}…` : task?.title || 'Task';
  const label = document.createElement('span'); label.textContent = `${short} · ${run.config?.model || providerName(run.config?.provider)}`;
  // Closing a tab only hides it here. The agent keeps running; its run history stays.
  const close = document.createElement('span'); close.className = 'tab-close'; close.textContent = '×'; close.setAttribute('aria-hidden', 'true');
  close.title = 'Close this tab (the agent keeps running)';
  close.addEventListener('click', event => { event.stopPropagation(); closeSession(run.id); });
  tab.append(icon, label, close);
  tab.addEventListener('click', () => selectDockTab(run.id, true));
  tab.addEventListener('keydown', event => { if (event.key === 'Delete') { event.preventDefault(); closeSession(run.id); } });
  $('#dock-tabs').append(tab);
  $('#dock-terminals').append(panel);
  const session = { runId: run.id, taskId: run.taskId, run, title, panel, tab, label, icon, lastSeq: 0, pending: 0, input: '', ended: !DOCK_LIVE.has(run.status), closed: false, cols: 0, rows: 0 };
  attachRenderer(session);
  dock.sessions.set(run.id, session);
  updateSessionTab(session);
  streamSession(session); // Live runs stream; ended runs replay their kept output, then stop.
  if (typeof ResizeObserver === 'function') (session.observer = new ResizeObserver(() => fitSession(session))).observe(panel);
  return session;
}

/** Remove a tab and its terminal view. Never stops the process or deletes run history. */
function closeSession(runId) {
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
  announce(`Closed the tab for ${session.title}.${DOCK_LIVE.has(session.run.status) ? ' The agent keeps running.' : ''}`);
}

function attachRenderer(session) {
  const { panel } = session;
  if (typeof Terminal === 'function') {
    try {
      const term = new Terminal({ scrollback: 5000, fontSize: 12, fontFamily: 'ui-monospace, "SFMono-Regular", Consolas, monospace', cursorBlink: false, convertEol: false,
        theme: { background: '#111111', foreground: '#eeeeee' },
        // Links in agent output are shown, never opened automatically.
        linkHandler: { activate: (_event, uri) => dockNote(`Link not opened automatically: ${uri}`), allowNonHttpProtocols: false } });
      const fit = typeof FitAddon === 'object' ? new FitAddon.FitAddon() : null;
      if (fit) term.loadAddon(fit);
      term.open(panel);
      // The WebGL renderer draws to a canvas, so it works under the page's strict style policy.
      if (typeof WebglAddon === 'object') {
        const webgl = new WebglAddon.WebglAddon();
        webgl.onContextLoss(() => { webgl.dispose(); dockNote('The terminal lost its graphics context. Reload the page to restore it; the agent keeps running.'); });
        term.loadAddon(webgl);
      } else dockNote('Terminal graphics are unavailable. Reinstall with npm install; output is still recorded.');
      term.onData(data => sendInput(session, data));
      Object.assign(session, { term, fit, write: (data, done) => term.write(data, done) });
      return;
    } catch {
      panel.replaceChildren();
    }
  }
  // Plain fallback: readable text through textContent, no input.
  const pre = document.createElement('pre');
  pre.setAttribute('aria-live', 'off');
  panel.append(pre);
  session.pre = pre;
  session.write = (data, done) => {
    pre.textContent = (pre.textContent + stripTerminal(data)).slice(-DOCK_PLAIN_LIMIT);
    panel.scrollTop = panel.scrollHeight;
    done?.();
  };
  if (typeof Terminal !== 'function') dockNote('The interactive terminal files are missing. Run npm install, then reload. Output is shown as plain text.');
}

function dockNote(message) { $('#dock-note').textContent = message; $('#dock-note').hidden = !message; }

function write(session, data) {
  // Client-side backpressure: stop reading while xterm has a large backlog to render.
  session.pending += data.length;
  session.write(data, () => { session.pending -= data.length; if (session.pending < 256 * 1024) session.drained?.(); });
}

async function streamSession(session) {
  while (!session.closed) {
    const controller = new AbortController();
    session.abort = controller;
    try {
      // fetch keeps the session token in a header; it never appears in a URL.
      const response = await fetch(`/api/runs/${encodeURIComponent(session.runId)}/stream?after=${session.lastSeq}`, { cache: 'no-store', headers: { 'X-STE-Token': token }, signal: controller.signal });
      if (response.status === 404) { markEnded(session); return; }
      if (!response.ok || !response.body) throw new Error('stream');
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
          handleItem(session, item);
          if (session.pending > 2 * 1024 * 1024) await new Promise(resolve => { session.drained = resolve; });
        }
      }
      if (session.ended) return;
    } catch { if (session.closed) return; }
    await new Promise(resolve => setTimeout(resolve, 1000)); // Reconnect to the same run; never restart it.
  }
}

function handleItem(session, item) {
  if (item.ping) return;
  if (item.gap) write(session, '\r\n[Promptboard: earlier output was dropped because the view fell behind]\r\n');
  if (Number.isInteger(item.seq)) session.lastSeq = item.seq;
  if (typeof item.data === 'string') write(session, item.data);
  if (item.status) { session.run = { ...session.run, status: item.status, waitingReason: item.reason || '' }; updateSessionTab(session); updateDockIndicator(); scheduleBoardRefresh(); }
  if (item.ended || item.missing) markEnded(session);
}

// Card badges come from the board; refresh it (debounced) when a run's status changes.
function scheduleBoardRefresh() {
  clearTimeout(dock.refreshTimer);
  dock.refreshTimer = setTimeout(() => loadBoard(), 300);
}

function markEnded(session) {
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
  details.hidden = !session;
  if (!session) return;
  const run = session.run; // Merged from the board in syncDock and from stream status items.
  const shown = session.ended && DOCK_LIVE.has(run.status) ? { ...run, status: 'interrupted' } : run;
  details.replaceChildren(`${agentModel(run)} · ${columnTitle(run.stage)} · ${agentStateText(shown)} · `, elapsedSpan(run),
    run.branch ? ` · Branch ${run.branch}` : '', run.workspacePath ? ` · Worktree ${run.workspacePath}` : '');
  details.title = details.textContent;
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
    if (chunk) api(`/api/runs/${encodeURIComponent(session.runId)}/input`, { method: 'POST', body: { data: chunk }, timeoutMs: 10000 }).catch(() => dockNote('Input was not delivered. Check that the app is running.'));
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
  $('#dock-stop').hidden = !session || session.ended || !DOCK_LIVE.has(session.run.status);
  $('#dock-copy').hidden = !session?.term;
  renderDockDetails(session);
  dock.stopFor = null;
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
    } else if (DOCK_LIVE.has(run.status) && !dock.dismissed.has(run.id)) createSession(run);
  }
  renderActivity();
  updateDockIndicator();
  // An empty dock stays collapsed. After a reload, reopen it only if live sessions exist.
  if (!dock.restored) {
    dock.restored = true;
    if (dockPref(DOCK_STATE_KEY, 'collapsed') === 'open' && board.runs.some(run => DOCK_LIVE.has(run.status))) setDockState('open', false);
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
  if (!session) return;
  const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'danger'; confirm.textContent = 'Stop this agent';
  const keep = document.createElement('button'); keep.type = 'button'; keep.textContent = 'Keep running';
  const box = $('#dock-note');
  box.replaceChildren(document.createTextNode(`Stop “${session.title}”? The process ends; its worktree and output are kept. `), confirm, document.createTextNode(' '), keep);
  box.hidden = false;
  keep.addEventListener('click', () => dockNote(''));
  confirm.addEventListener('click', async () => {
    dockNote('Stopping…');
    const { response, data } = await api(`/api/runs/${encodeURIComponent(session.runId)}/cancel`, { method: 'POST', body: { confirm: true }, timeoutMs: 15000 }).catch(() => ({ response: { ok: false }, data: {} }));
    dockNote(response.ok ? '' : data.error || 'The agent could not be stopped.');
    if (response.ok) { announce(`Stopped ${session.title}.`); if (data.board) { board = data.board; renderBoard(); } }
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
  const move = e => { dock.height = Math.max(120, Math.min(window.innerHeight - 160, window.innerHeight - e.clientY)); applyDockHeight(); };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); savePref(DOCK_HEIGHT_KEY, String(dock.height)); fitSession(dock.sessions.get(dock.selected)); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

(function initDock() {
  dock.height = Math.max(120, Math.min(900, Number(dockPref(DOCK_HEIGHT_KEY, '320')) || 320));
  $('#dock-toggle').addEventListener('click', () => setDockState(dock.state === 'collapsed' ? 'open' : 'collapsed'));
  $('#dock-max').addEventListener('click', () => setDockState(dock.state === 'max' ? 'open' : 'max'));
  $('#dock-tab-activity').addEventListener('click', () => selectDockTab('activity'));
  $('#dock-stop').addEventListener('click', stopSelected);
  $('#dock-copy').addEventListener('click', copySelection);
  $('#dock-divider').addEventListener('pointerdown', startDividerDrag);
  $('#dock-divider').addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    dock.height = Math.max(120, Math.min(window.innerHeight - 160, dock.height + (event.key === 'ArrowUp' ? 24 : -24)));
    applyDockHeight(); savePref(DOCK_HEIGHT_KEY, String(dock.height)); fitSession(dock.sessions.get(dock.selected));
  });
  $('#dock-tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const tabs = [...$('#dock-tabs').children];
    const next = tabs[(tabs.indexOf(document.activeElement) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    next?.focus(); next?.click();
  });
  window.PromptboardDock = { sync: syncDock, open: openRun, reveal: revealTask, setState: setDockState };
  setDockState('collapsed', false);
  syncDock();
})();
