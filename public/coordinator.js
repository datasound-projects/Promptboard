'use strict';

// Coordinator panel above the Kanban columns, opened and closed with one click on the Coordinator button
// next to Autopilot (remembered per project). It reads what the board already records, only while open,
// and asks a model only when you ask a question.
window.PromptboardCoordinator = (() => {
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const button = (text, onClick, className = 'text-button', label = '') => { const node = el('button', className, text); node.type = 'button'; if (label) node.setAttribute('aria-label', label); node.addEventListener('click', onClick); return node; };
  const pref = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
  const setPref = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
  const ago = at => { const s = Math.max(0, Math.round((Date.now() - at) / 1000)); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(at).toLocaleDateString(); };
  const ICON = 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm0 3.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z';

  function create(host) {
    const panel = document.getElementById('coordinator'), toggle = document.getElementById('coordinator-toggle');
    let projectId = null, data = null, revision = null, fetching = null, chatOpen = false, scope = { kind: 'project' }, asking = false, message = '', draft = '';
    const key = () => `promptboard.coordinator.${projectId}`;
    const isOpen = () => pref(key(), '') === 'open';
    const call = (path, options = {}) => host.api(`/api/coordinator/${encodeURIComponent(projectId)}${path}`, { timeoutMs: 200000, ...options })
      .then(({ response, data: body }) => (response.ok ? body : Promise.reject(new Error(body.error || 'The Coordinator is unavailable.'))));
    async function refresh() {
      if (!projectId) return;
      const id = projectId;
      // One read per project at a time; switching projects starts the new project's read at once.
      if (fetching?.id === id) return fetching.promise;
      const promise = call('').then(body => { if (id === projectId) { data = body; message = ''; } }).catch(error => { if (id === projectId) message = error.message; })
        .finally(() => { if (fetching?.promise === promise) fetching = null; render(); });
      fetching = { id, promise };
      return promise;
    }

    /** Called on every board render; fetches only when the project or the board changed and the panel is shown. */
    function sync(project, boardRevision, visible = true) {
      if (!project) { projectId = null; panel.hidden = true; toggle.hidden = true; return; }
      if (project.id !== projectId) { projectId = project.id; data = null; revision = null; chatOpen = false; scope = { kind: 'project' }; message = ''; draft = ''; }
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
      const focusId = panel.contains(document.activeElement) ? document.activeElement.id : '';
      const bar = el('div', 'coordinator-bar');
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true'); icon.classList.add('coordinator-icon');
      const path = document.createElementNS(icon.namespaceURI, 'path'); path.setAttribute('d', ICON); icon.append(path);
      const title = el('strong', 'coordinator-name', 'Coordinator');
      const status = el('span', 'coordinator-status');
      status.setAttribute('role', 'status');
      if (off) status.textContent = 'Off · project knowledge is kept';
      else if (!data) status.textContent = message || 'Reading the board…';
      else {
        const needs = data.agents.filter(agent => agent.needsYou).length;
        status.append(...[`${data.agents.length} ${data.agents.length === 1 ? 'agent' : 'agents'} active`, `${data.progress.done}/${data.progress.total} done`,
          ...(needs ? [`${needs} ${needs === 1 ? 'needs' : 'need'} you`] : []), ...(data.blockers.length ? [`${data.blockers.length} ${data.blockers.length === 1 ? 'blocker' : 'blockers'}`] : [])]
          .map((text, index) => el('span', index >= 2 ? 'coordinator-alert' : '', text)));
      }
      const controls = el('div', 'coordinator-controls');
      if (!off) {
        const ask = button('Ask Coordinator', () => openChat(), 'secondary-button coordinator-ask'); ask.id = 'coordinator-ask';
        controls.append(ask);
      }
      const onOff = el('label', 'coordinator-switch'), box = el('input'); box.type = 'checkbox'; box.id = 'coordinator-enabled'; box.setAttribute('role', 'switch'); box.checked = !off;
      box.addEventListener('change', async () => {
        box.disabled = true;
        try { data = await call('', { method: 'PATCH', body: { enabled: box.checked } }); host.announce(box.checked ? 'Coordinator is on. Missed changes were added from the board.' : 'Coordinator is off. Its project knowledge is kept.'); }
        catch (error) { message = error.message; }
        render(); document.getElementById('coordinator-enabled')?.focus();
      });
      onOff.append(box, el('span', '', off ? 'Off' : 'On'));
      controls.append(onOff);
      bar.append(icon, title, status, controls);
      const nodes = [bar];
      if (!off && data) nodes.push(dashboard());
      if (!off && chatOpen) nodes.push(chat());
      panel.replaceChildren(...nodes);
      if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
    }

    function card(titleText, items, empty) {
      const box = el('section', 'coordinator-card'); box.append(el('h3', '', titleText));
      if (!items.length) box.append(el('p', 'coordinator-empty', empty)); else { const list = el('ul'); list.append(...items); box.append(list); }
      return box;
    }
    const taskLink = (number, title, taskId) => button(`${number ? `#${number} ` : ''}${title}`, () => host.openTask(taskId), 'coordinator-link');
    function dashboard() {
      const grid = el('div', 'coordinator-grid');
      const progress = el('section', 'coordinator-card coordinator-progress');
      progress.append(el('h3', '', 'Progress'));
      const meter = el('div', 'coordinator-meter'), fill = el('span'); fill.style.width = `${data.progress.total ? Math.round(data.progress.done / data.progress.total * 100) : 0}%`;
      meter.setAttribute('role', 'img'); meter.setAttribute('aria-label', `${data.progress.done} of ${data.progress.total} cards done`); meter.append(fill);
      progress.append(meter, el('p', 'coordinator-columns', data.columns.map(column => `${column.name} ${column.count}`).join(' · ')));
      grid.append(progress,
        card('Active agents', data.agents.map(agent => { const li = el('li'); li.append(taskLink(agent.number, agent.title, agent.taskId), el('small', '', `${agent.column} · ${agent.needsYou ? 'waiting for you' : agent.status.replaceAll('_', ' ')}`)); return li; }), 'No agent is working.'),
        card('Needs attention', data.blockers.map(blocker => { const li = el('li'); if (blocker.taskId) li.append(taskLink(blocker.number, blocker.title, blocker.taskId)); li.append(el('small', '', blocker.text)); return li; }), 'Nothing is blocked.'),
        card('Recent activity', data.recent.slice(0, 6).map(event => { const li = el('li'); li.append(event.task ? taskLink(event.number, event.taskTitle, event.task) : el('span', '', event.title)); li.append(el('small', '', `${event.title}${event.status ? ` · ${event.status}` : ''} · ${ago(event.at)}`)); return li; }), 'No activity yet.'));
      return grid;
    }

    function openChat(next = null) {
      if (next) scope = next;
      chatOpen = true; render(); document.getElementById('coordinator-question')?.focus();
    }
    const SCOPES = [['project', 'Project'], ['task', 'Task'], ['agent', 'Agent'], ['branch', 'Branch']];
    const svg = d => { const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); node.setAttribute('viewBox', '0 0 24 24'); node.setAttribute('aria-hidden', 'true'); const p = document.createElementNS(node.namespaceURI, 'path'); p.setAttribute('d', d); node.append(p); return node; };
    function chat() {
      const box = el('section', 'coordinator-chat'); box.setAttribute('aria-label', 'Ask Coordinator');
      // Header: what the question is about, and which one.
      const head = el('div', 'coordinator-chat-head');
      const kinds = el('div', 'coordinator-scope'); kinds.id = 'coordinator-scope'; kinds.setAttribute('role', 'group'); kinds.setAttribute('aria-label', 'Ask about');
      for (const [value, label] of SCOPES) {
        const option = button(label, () => { if (scope.kind !== value) { scope = { kind: value }; render(); } }, 'coordinator-scope-option');
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
      const close = button('', () => { chatOpen = false; render(); document.getElementById('coordinator-ask')?.focus(); }, 'coordinator-close', 'Close chat');
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
      if (asking) { const wait = el('div', 'coordinator-message coordinator-thinking'); wait.append(el('span'), el('span'), el('span')); wait.setAttribute('aria-label', 'Reading the board'); log.append(wait); }
      if (!(data?.chat || []).length && !asking) log.append(el('p', 'coordinator-empty coordinator-hint', 'Ask about the project, a card, an agent or a branch. Answers cite what the board recorded; nothing is changed.'));

      // Composer: one rounded field with a send button inside.
      const form = el('form', 'coordinator-form');
      const question = el('textarea'); question.id = 'coordinator-question'; question.rows = 1; question.maxLength = 2000; question.value = draft;
      question.placeholder = scope.kind === 'project' ? 'Ask about this project…' : `Ask about this ${scope.kind === 'task' ? 'card' : scope.kind}…`;
      question.setAttribute('aria-label', 'Question for the Coordinator');
      question.addEventListener('input', () => { draft = question.value; send.disabled = asking || !draft.trim(); });
      question.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } });
      const send = el('button', 'coordinator-send'); send.type = 'submit'; send.setAttribute('aria-label', asking ? 'Asking' : 'Ask'); send.id = 'coordinator-send'; send.disabled = asking || !draft.trim();
      send.append(svg('M12 19V5M6 11l6-6 6 6'));
      form.append(question, send);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (!draft.trim() || asking) return;
        asking = true; message = ''; render();
        try {
          const settings = host.composeSettings();
          const result = await call('/ask', { method: 'POST', body: { question: draft, scope, provider: settings.provider, model: settings.model, effort: settings.effort } });
          data = { ...data, chat: result.chat }; draft = '';
        } catch (error) { message = error.message; }
        finally { asking = false; render(); document.getElementById('coordinator-question')?.focus(); }
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
