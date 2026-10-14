'use strict';

// Coordinator panel above the Kanban columns, opened and closed with one click on the Coordinator button
// next to Autopilot (remembered per project). It reads what the board already records, only while open,
// and asks a model only when you ask a question.
window.PromptboardCoordinator = (() => {
  const { el, pref, setPref } = window.PromptboardDom;
  const button = (text, onClick, className = 'text-button', label = '') => { const node = window.PromptboardDom.button(text, onClick, className); if (label) node.setAttribute('aria-label', label); return node; };
  const ago = at => { const s = Math.max(0, Math.round((Date.now() - at) / 1000)); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(at).toLocaleDateString(); };
  const ICON = 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm0 3.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z';

  function create(host) {
    const panel = document.getElementById('coordinator'), toggle = document.getElementById('coordinator-toggle');
    let projectId = null, data = null, revision = null, fetching = null, chatOpen = false, scope = { kind: 'project' }, message = '', readError = '', draft = '';
    // Questions in flight, per project. The chat node is kept across board renders so typing is never interrupted.
    const asking = new Set();
    let chatNode = null;
    const key = () => `promptboard.coordinator.${projectId}`;
    // Where the panel sits and how big it is. Layout only: it never changes what the Coordinator reads or does.
    // Attached: above the columns. Detached: a window dragged by its top bar and resized from its corner.
    // Minimized: a small box that can be dragged anywhere; a click opens it again. Phones always attach.
    const LAYOUT_KEY = 'promptboard.coordinator.layout';
    const layout = (() => {
      let saved = {};
      try { saved = JSON.parse(pref(LAYOUT_KEY, '{}')) || {}; } catch {}
      const read = { mode: saved.mode === 'float' ? 'float' : 'attached', mini: saved.mini === true, overview: saved.overview !== false };
      for (const name of ['x', 'y', 'w', 'h', 'mx', 'my']) if (Number.isFinite(saved[name])) read[name] = saved[name];
      return read;
    })();
    const saveLayout = () => setPref(LAYOUT_KEY, JSON.stringify(layout));
    const phone = () => window.innerWidth <= 730;
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const topEdge = () => document.querySelector('.topbar')?.getBoundingClientRect().bottom || 60;
    let draggedAt = -1e9; // A click right after a drag ends that drag; it is not a click.
    const justDragged = () => performance.now() - draggedAt < 400;
    function place() {
      const dock = phone() ? 'attached' : layout.mini ? 'mini' : layout.mode;
      panel.dataset.dock = dock;
      for (const name of ['left', 'top', 'width', 'height']) panel.style.removeProperty(name);
      if (dock === 'attached') return;
      const vw = window.innerWidth, vh = window.innerHeight, top = topEdge();
      if (dock === 'mini') {
        const w = panel.offsetWidth || 200, h = panel.offsetHeight || 40;
        layout.mx = clamp(layout.mx ?? vw - w - 24, 8, vw - w - 8); layout.my = clamp(layout.my ?? vh - h - 72, top + 8, vh - h - 8);
        Object.assign(panel.style, { left: `${layout.mx}px`, top: `${layout.my}px` });
        return;
      }
      const w = clamp(layout.w ?? 480, 320, vw - 16), h = clamp(layout.h ?? Math.min(560, vh - top - 96), 180, vh - top - 16);
      layout.x = clamp(layout.x ?? vw - w - 24, 8, vw - w - 8); layout.y = clamp(layout.y ?? top + 72, top + 8, vh - h - 8);
      Object.assign(panel.style, { left: `${layout.x}px`, top: `${layout.y}px`, width: `${w}px`, height: `${h}px` });
    }
    /** Drags the panel by `handle`; buttons and fields inside it keep working. A drag never counts as a click. */
    function draggable(handle, save) {
      handle.addEventListener('pointerdown', event => {
        const control = event.target.closest('button, input, select, textarea, label, a');
        if (event.button !== 0 || phone() || (control && control !== handle)) return;
        const rect = panel.getBoundingClientRect(), dx = event.clientX - rect.left, dy = event.clientY - rect.top, sx = event.clientX, sy = event.clientY;
        let moved = false;
        const move = next => {
          if (!moved && Math.hypot(next.clientX - sx, next.clientY - sy) < 4) return;
          moved = true; panel.dataset.dragging = 'true';
          panel.style.left = `${clamp(next.clientX - dx, 8, window.innerWidth - rect.width - 8)}px`;
          panel.style.top = `${clamp(next.clientY - dy, topEdge() + 8, window.innerHeight - rect.height - 8)}px`;
        };
        const stop = () => {
          window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop);
          delete panel.dataset.dragging;
          if (!moved) return;
          draggedAt = performance.now();
          save(Math.round(parseFloat(panel.style.left)), Math.round(parseFloat(panel.style.top))); saveLayout();
        };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop); window.addEventListener('pointercancel', stop);
      });
    }
    function setLayout(change, focusId) { Object.assign(layout, change); saveLayout(); render(); if (focusId) document.getElementById(focusId)?.focus(); }
    // The window keeps the size you drag its corner to.
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => {
      if (panel.hidden || panel.dataset.dock !== 'float' || panel.dataset.dragging) return;
      const w = Math.round(panel.offsetWidth), h = Math.round(panel.offsetHeight);
      if (w && h && (w !== layout.w || h !== layout.h)) { layout.w = w; layout.h = h; saveLayout(); }
    }).observe(panel);
    let resizeFrame = 0;
    window.addEventListener('resize', () => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(() => render()); });
    const isOpen = () => pref(key(), '') === 'open';
    const call = (path, options = {}) => host.api(`/api/coordinator/${encodeURIComponent(projectId)}${path}`, { timeoutMs: 200000, ...options })
      .then(({ response, data: body }) => (response.ok ? body : Promise.reject(new Error(body.error || 'The Coordinator is unavailable.'))));
    async function refresh() {
      if (!projectId) return;
      const id = projectId;
      // One read per project at a time; switching projects starts the new project's read at once.
      // A change during a read may be missing from it, so one more read follows.
      if (fetching?.id === id) { fetching.again = true; return fetching.promise; }
      const read = { id, again: false };
      read.promise = call('').then(body => { if (id === projectId) { if (JSON.stringify(body.chat) !== JSON.stringify(data?.chat)) chatNode = null; data = body; message = ''; readError = ''; } }).catch(error => { if (id === projectId) readError = error.message; })
        .finally(() => { if (fetching === read) { fetching = null; if (read.again) void refresh(); } render(); });
      fetching = read;
      return read.promise;
    }

    /** Called on every board render; fetches only when the project or the board changed and the panel is shown. */
    function sync(project, boardRevision, visible = true) {
      if (!project) { projectId = null; panel.hidden = true; toggle.hidden = true; return; }
      if (project.id !== projectId) { projectId = project.id; data = null; revision = null; chatOpen = false; chatNode = null; scope = { kind: 'project' }; message = ''; readError = ''; draft = ''; }
      panel.dataset.visible = String(visible);
      toggle.hidden = !visible;
      if (!visible) { panel.hidden = true; return; }
      if (revision !== boardRevision) { revision = boardRevision; if (isOpen()) void refresh(); }
      render();
    }

    function render() {
      if (!projectId) return;
      toggle.setAttribute('aria-pressed', String(isOpen()));
      panel.hidden = !isOpen() || panel.dataset.visible === 'false';
      if (panel.hidden) return;
      const off = data?.enabled === false;
      panel.dataset.mode = off ? 'off' : 'on';
      panel.dataset.overview = layout.overview ? 'shown' : 'folded';
      const focusId = panel.contains(document.activeElement) ? document.activeElement.id : '';
      if (layout.mini && !phone()) { panel.replaceChildren(miniBox(off)); place(); if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true }); return; }
      const bar = el('div', 'coordinator-bar');
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true'); icon.classList.add('coordinator-icon');
      const path = document.createElementNS(icon.namespaceURI, 'path'); path.setAttribute('d', ICON); icon.append(path);
      const title = el('strong', 'coordinator-name', 'Coordinator');
      const status = el('span', 'coordinator-status');
      status.setAttribute('role', 'status');
      if (off) status.textContent = 'Off · project knowledge is kept';
      else if (!data) status.textContent = readError || message || 'Reading the board…';
      else {
        const needs = data.agents.filter(agent => agent.needsYou).length;
        status.append(...[`${data.agents.length} ${data.agents.length === 1 ? 'agent' : 'agents'} active`, `${data.progress.done}/${data.progress.total} done`,
          ...(needs ? [`${needs} ${needs === 1 ? 'needs' : 'need'} you`] : []), ...(data.blockers.length ? [`${data.blockers.length} ${data.blockers.length === 1 ? 'blocker' : 'blockers'}`] : []),
          ...(readError ? [`Not refreshed: ${readError}`] : [])]
          .map((text, index) => el('span', index >= 2 ? 'coordinator-alert' : '', text)));
      }
      const controls = el('div', 'coordinator-controls');
      if (!off) {
        const ask = button('Ask Coordinator', () => openChat(), 'secondary-button coordinator-ask'); ask.id = 'coordinator-ask';
        controls.append(ask);
      }
      const onOff = el('label', 'coordinator-switch'), box = el('input'); box.type = 'checkbox'; box.id = 'coordinator-enabled'; box.setAttribute('role', 'switch'); box.checked = !off;
      box.addEventListener('change', async () => {
        const id = projectId;
        box.disabled = true;
        try {
          const next = await call('', { method: 'PATCH', body: { enabled: box.checked } });
          if (id !== projectId) return;
          data = next; chatNode = null; host.announce(box.checked ? 'Coordinator is on. Missed changes were added from the board.' : 'Coordinator is off. Its project knowledge is kept.');
        } catch (error) { if (id !== projectId) return; message = error.message; }
        render(); document.getElementById('coordinator-enabled')?.focus();
      });
      onOff.append(box, el('span', '', off ? 'Off' : 'On'));
      controls.append(onOff);
      if (!phone()) controls.append(windowTools(off));
      bar.append(icon, title, status, controls);
      const nodes = [bar];
      if (!off && data) nodes.push(dashboard());
      // The chat stays in place (caret, selection, open menus, scroll); only the bar and dashboard are redrawn.
      const kept = !off && chatOpen ? (chatNode ||= chat()) : null;
      for (const child of [...panel.children]) if (child !== kept) child.remove();
      panel.prepend(...nodes);
      if (kept && !kept.isConnected) panel.append(kept);
      if (layout.mode === 'float' && !phone()) draggable(bar, (x, y) => Object.assign(layout, { x, y }));
      place();
      if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
    }

    function windowTools(off) {
      const tools = el('div', 'coordinator-window');
      const tool = (id, label, d, onClick, extra = {}) => {
        const node = button('', onClick, 'coordinator-tool', label); node.id = id; node.title = label;
        for (const [name, value] of Object.entries(extra)) node.setAttribute(name, value);
        node.append(svg(d)); return node;
      };
      if (!off && data) tools.append(tool('coordinator-overview', layout.overview ? 'Hide overview' : 'Show overview', layout.overview ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6',
        () => setLayout({ overview: !layout.overview }, 'coordinator-overview'), { 'aria-expanded': String(layout.overview) }));
      const floating = layout.mode === 'float';
      tools.append(
        tool('coordinator-dock', floating ? 'Attach above the board' : 'Detach into a window', floating ? 'M10 14H4v6M4 20l7-7M8 4h11a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5' : 'M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
          () => { if (!floating && !off) chatOpen = true; setLayout({ mode: floating ? 'attached' : 'float' }, 'coordinator-dock'); }),
        tool('coordinator-minimize', 'Minimize', 'M6 12h12', () => setLayout({ mini: true }, 'coordinator-mini')));
      return tools;
    }
    /** The minimized Coordinator: icon, name and a one-line summary. Drag it anywhere; a click opens it again. */
    function miniBox(off) {
      const box = button('', () => { if (!justDragged()) setLayout({ mini: false }, layout.mode === 'float' ? 'coordinator-dock' : 'coordinator-toggle'); }, 'coordinator-mini', 'Open Coordinator');
      box.id = 'coordinator-mini'; box.setAttribute('aria-label', 'Open Coordinator');
      const icon = svg(ICON); icon.classList.add('coordinator-icon');
      const needs = data ? data.agents.filter(agent => agent.needsYou).length + data.blockers.length : 0;
      const summary = off ? 'Off' : asking.has(projectId) ? 'Thinking…' : data ? (needs ? `${needs} need${needs === 1 ? 's' : ''} attention` : `${data.agents.length} active · ${data.progress.done}/${data.progress.total} done`) : '…';
      box.append(icon, el('strong', '', 'Coordinator'), el('span', `coordinator-mini-status${needs && !off ? ' is-alert' : ''}`, summary));
      draggable(box, (x, y) => Object.assign(layout, { mx: x, my: y }));
      return box;
    }

    function card(titleText, items, empty) {
      const box = el('section', 'coordinator-card'); box.append(el('h3', '', titleText));
      if (!items.length) box.append(el('p', 'coordinator-empty', empty)); else { const list = el('ul'); list.append(...items); box.append(list); }
      return box;
    }
    function dashboard() {
      // Stable, unique ids let render() put keyboard focus back on the same link after a redraw.
      const ids = new Map();
      const taskLink = (list, number, title, taskId) => {
        const node = button(`${number ? `#${number} ` : ''}${title}`, () => host.openTask(taskId), 'coordinator-link'), id = `coordinator-task-${list}-${taskId}`, n = (ids.get(id) || 0) + 1;
        ids.set(id, n); node.id = n > 1 ? `${id}-${n}` : id; return node;
      };
      const grid = el('div', 'coordinator-grid');
      const progress = el('section', 'coordinator-card coordinator-progress');
      progress.append(el('h3', '', 'Progress'));
      const meter = el('div', 'coordinator-meter'), fill = el('span'); fill.style.width = `${data.progress.total ? Math.round(data.progress.done / data.progress.total * 100) : 0}%`;
      meter.setAttribute('role', 'img'); meter.setAttribute('aria-label', `${data.progress.done} of ${data.progress.total} cards done`); meter.append(fill);
      progress.append(meter, el('p', 'coordinator-columns', data.columns.map(column => `${column.name} ${column.count}`).join(' · ')));
      grid.append(progress,
        card('Active agents', data.agents.map(agent => { const li = el('li'); li.append(taskLink('agent', agent.number, agent.title, agent.taskId), el('small', '', `${agent.column} · ${agent.needsYou ? 'waiting for you' : agent.status.replaceAll('_', ' ')}`)); return li; }), 'No agent is working.'),
        card('Needs attention', data.blockers.map(blocker => { const li = el('li'); if (blocker.taskId) li.append(taskLink('blocker', blocker.number, blocker.title, blocker.taskId)); li.append(el('small', '', blocker.text)); return li; }), 'Nothing is blocked.'),
        card('Recent activity', data.recent.slice(0, 6).map(event => { const li = el('li'); li.append(event.task ? taskLink('recent', event.number, event.taskTitle, event.task) : el('span', '', event.title)); li.append(el('small', '', `${event.title}${event.status ? ` · ${event.status}` : ''} · ${ago(event.at)}`)); return li; }), 'No activity yet.'));
      return grid;
    }

    function openChat(next = null) {
      if (next) scope = next;
      chatOpen = true; chatNode = null; render(); document.getElementById('coordinator-question')?.focus();
    }
    const SCOPES = [['project', 'Project'], ['task', 'Task'], ['agent', 'Agent'], ['branch', 'Branch']];
    const svg = d => { const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); node.setAttribute('viewBox', '0 0 24 24'); node.setAttribute('aria-hidden', 'true'); const p = document.createElementNS(node.namespaceURI, 'path'); p.setAttribute('d', d); node.append(p); return node; };
    function chat() {
      const box = el('section', 'coordinator-chat'); box.setAttribute('aria-label', 'Ask Coordinator');
      // Header: what the question is about, and which one.
      const head = el('div', 'coordinator-chat-head');
      const kinds = el('div', 'coordinator-scope'); kinds.id = 'coordinator-scope'; kinds.setAttribute('role', 'group'); kinds.setAttribute('aria-label', 'Ask about');
      for (const [value, label] of SCOPES) {
        const option = button(label, () => { if (scope.kind !== value) { scope = { kind: value }; chatNode = null; render(); } }, 'coordinator-scope-option');
        option.id = `coordinator-scope-${value}`; option.dataset.scope = value; option.setAttribute('aria-pressed', String(scope.kind === value));
        kinds.append(option);
      }
      const target = el('select', 'coordinator-target'); target.id = 'coordinator-target'; target.setAttribute('aria-label', 'Which one');
      const project = host.project(), runs = host.runs().filter(run => run.projectId === project.id);
      const choices = scope.kind === 'task' ? project.tasks.map(task => [task.id, `#${task.number ?? ''} ${task.title}`])
        : scope.kind === 'agent' ? runs.slice(-30).reverse().map(run => [run.id, `#${project.tasks.find(task => task.id === run.taskId)?.number ?? ''} · ${run.stage} · ${run.status}`])
        : scope.kind === 'branch' ? [...new Set(project.tasks.map(task => task.workspace?.branch).filter(Boolean))].map(branch => [branch, branch]) : [];
      target.append(...choices.map(([value, label]) => Object.assign(el('option', '', label), { value })));
      target.hidden = scope.kind === 'project' || !choices.length;
      if (scope.id && choices.some(([value]) => value === scope.id)) target.value = scope.id; else if (choices[0]) scope = { kind: scope.kind, id: choices[0][0] };
      target.addEventListener('change', () => { scope = { kind: scope.kind, id: target.value }; });
      const close = button('', () => { chatOpen = false; chatNode = null; render(); document.getElementById('coordinator-ask')?.focus(); }, 'coordinator-close', 'Close chat');
      close.append(svg('M6 6l12 12M18 6 6 18'));
      head.append(kinds, target, close);
      if (scope.kind !== 'project' && !choices.length) head.append(el('span', 'coordinator-none', { task: 'No cards yet', agent: 'No agent runs yet', branch: 'No branches yet' }[scope.kind]));

      const log = el('div', 'coordinator-messages'); log.setAttribute('aria-live', 'polite');
      for (const entry of data?.chat || []) {
        const item = el('div', `coordinator-message is-${entry.role}`);
        if (entry.role === 'user') item.append(el('p', '', entry.text));
        else {
          const text = el('p');
          // References become links to the real card, run or commit; everything else stays text.
          const refs = new Map((entry.refs || []).map(ref => [ref.ref, ref]));
          let last = 0;
          for (const match of entry.text.matchAll(/\[([^\]\n]{1,60})\]/g)) {
            const ref = refs.get(match[1]);
            if (!ref) continue;
            text.append(entry.text.slice(last, match.index));
            text.append(button(ref.kind === 'task' ? `#${ref.number ?? ''}` : ref.kind === 'commit' ? ref.commit.slice(0, 7) : 'run', () => (ref.kind === 'commit' ? host.copy(ref.commit) : host.openTask(ref.taskId)), 'coordinator-ref', ref.kind === 'commit' ? `Copy commit ${ref.commit}` : `Open ${ref.kind === 'task' ? `card #${ref.number}` : 'the card of this run'}`));
            last = match.index + match[0].length;
          }
          text.append(entry.text.slice(last));
          item.append(text, el('small', '', `${new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${entry.cached ? ' · from earlier evidence' : ''}`));
        }
        log.append(item);
      }
      if (asking.has(projectId)) { const wait = el('div', 'coordinator-message coordinator-thinking'); wait.append(el('span'), el('span'), el('span')); wait.setAttribute('aria-label', 'Reading the board'); log.append(wait); }
      if (!(data?.chat || []).length && !asking.has(projectId)) log.append(el('p', 'coordinator-empty coordinator-hint', 'Ask about the project, a card, an agent or a branch. Answers cite what the board recorded; nothing is changed.'));

      // Composer: one rounded field with a send button inside.
      const form = el('form', 'coordinator-form');
      const question = el('textarea'); question.id = 'coordinator-question'; question.rows = 1; question.maxLength = 2000; question.value = draft;
      question.placeholder = scope.kind === 'project' ? 'Ask about this project…' : `Ask about this ${scope.kind === 'task' ? 'card' : scope.kind}…`;
      question.setAttribute('aria-label', 'Question for the Coordinator');
      question.addEventListener('input', () => { draft = question.value; send.disabled = asking.has(projectId) || !draft.trim(); });
      question.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } });
      const send = el('button', 'coordinator-send'); send.type = 'submit'; send.setAttribute('aria-label', asking.has(projectId) ? 'Asking' : 'Ask'); send.id = 'coordinator-send'; send.disabled = asking.has(projectId) || !draft.trim();
      send.append(svg('M12 19V5M6 11l6-6 6 6'));
      form.append(question, send);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        const id = projectId;
        if (!draft.trim() || asking.has(id)) return;
        asking.add(id); message = ''; chatNode = null; render();
        try {
          const settings = host.composeSettings();
          const result = await call('/ask', { method: 'POST', body: { question: draft, scope, provider: settings.provider, model: settings.model, effort: settings.effort } });
          // An answer belongs to the project it was asked in; another project's panel is left alone.
          if (id === projectId) { if (data) data = { ...data, chat: result.chat }; draft = ''; }
        } catch (error) { if (id === projectId) message = error.message; }
        finally {
          asking.delete(id);
          if (id === projectId) { chatNode = null; render(); document.getElementById('coordinator-question')?.focus(); }
        }
      });
      box.append(head, log, form);
      if (message) box.append(el('p', 'inline-error', message));
      queueMicrotask(() => { log.scrollTop = log.scrollHeight; });
      return box;
    }

    // One click opens or closes the panel; opening reads the board's latest state.
    function setOpen(open) { setPref(key(), open ? 'open' : 'closed'); if (open) void refresh(); render(); }
    toggle.addEventListener('click', () => { if (projectId) setOpen(!isOpen()); });
    return { sync, askAbout: next => { if (!isOpen()) setOpen(true); openChat(next); } };
  }

  return { create };
})();
