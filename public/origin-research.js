'use strict';

// Origin Research: a chat panel in Origin's right-side drawer. It researches the selected part of the blueprint with
// the user's own CLI (Claude Code or Codex) and shows suggestions. It never changes the blueprint by itself: the user
// applies each suggestion. Nothing is read or started until the panel is opened.
window.PromptboardOriginResearch = (() => {
  const WIDTH_KEY = 'promptboard.origin.research-width', SETTINGS_KEY = 'promptboard.origin.research-settings', DEFAULT_WIDTH = 500, MIN_WIDTH = 360;
  const { el, pref, setPref, clip } = window.PromptboardDom;
  const button = (text, onClick, className = 'origin-ghost', title) => window.PromptboardDom.button(text, onClick, className, title);
  const M = () => window.PromptboardOriginModel;
  const MODES = [['chat', 'Chat', 'Guided research: one agent, a continuous conversation'], ['swarm', 'Swarm', 'Parallel research: one independent agent per selected part'],
    ['decision', 'Decision Lab', 'Compare two or three options against your constraints'], ['audit', 'Audit', 'Find gaps, conflicts and weak assumptions in the blueprint']];
  const PROVIDERS = { claude: 'Claude Code', codex: 'Codex' };
  const SVG = 'http://www.w3.org/2000/svg';
  const ICONS = {
    research: 'M10.5 4a6.5 6.5 0 1 0 4.03 11.6l4.43 4.43 1.06-1.06-4.43-4.43A6.5 6.5 0 0 0 10.5 4Zm0 1.5a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm-.75 2v2.25H7.5v1.5h2.25v2.25h1.5v-2.25h2.25v-1.5h-2.25V7.5Z',
    clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 1.5a7.5 7.5 0 1 1 0 15 7.5 7.5 0 0 1 0-15Zm-.75 3v5.06l3.72 2.15.75-1.3-2.97-1.71V7.5Z',
    plus: 'M11.25 5v6.25H5v1.5h6.25V19h1.5v-6.25H19v-1.5h-6.25V5Z',
    max: 'M5 5h6v1.5H7.56l4.22 4.22-1.06 1.06L6.5 7.56V11H5Zm8 0h6v6h-1.5V7.56l-4.22 4.22-1.06-1.06 4.22-4.22H13Zm-8 8h1.5v3.44l4.22-4.22 1.06 1.06-4.22 4.22H11V19H5Zm12.44 4.5-4.22-4.22 1.06-1.06 4.22 4.22V13H19v6h-6v-1.5Z',
    restore: 'M9 4.5h1.5v4.94L5.28 4.22 4.22 5.28l5.22 5.22H4.5V12H12V4.5Zm4.5 7.5H18v1.5h-3.44l5.22 5.22-1.06 1.06-5.22-5.22V18H12v-6Z',
    min: 'M5 11.25h14v1.5H5Z',
    close: 'M6.53 5.47 12 10.94l5.47-5.47 1.06 1.06L13.06 12l5.47 5.47-1.06 1.06L12 13.06l-5.47 5.47-1.06-1.06L10.94 12 5.47 6.53Z',
    send: 'M11.25 19V7.06l-4.72 4.72-1.06-1.06L12 4.19l6.53 6.53-1.06 1.06-4.72-4.72V19Z',
    stop: 'M7 7h10v10H7Z',
    globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm5.92 5.25h-2.6a14 14 0 0 0-1.3-3.48 7.53 7.53 0 0 1 3.9 3.48ZM12 4.6c.7.9 1.38 2.15 1.8 3.65h-3.6c.42-1.5 1.1-2.75 1.8-3.65Zm-6.98 9.15a7.6 7.6 0 0 1 0-3.5h3.04a15 15 0 0 0 0 3.5Zm1.06 1.5h2.6c.28 1.27.72 2.46 1.3 3.48a7.53 7.53 0 0 1-3.9-3.48Zm2.6-7h-2.6a7.53 7.53 0 0 1 3.9-3.48 14 14 0 0 0-1.3 3.48ZM12 19.4c-.7-.9-1.38-2.15-1.8-3.65h3.6c-.42 1.5-1.1 2.75-1.8 3.65Zm2.12-5.65H9.88a13 13 0 0 1 0-3.5h4.24a13 13 0 0 1 0 3.5Zm-.1 5.48c.58-1.02 1.02-2.21 1.3-3.48h2.6a7.53 7.53 0 0 1-3.9 3.48Zm1.92-4.98a15 15 0 0 0 0-3.5h3.04a7.6 7.6 0 0 1 0 3.5Z',
  };
  const icon = (name, size = 16) => {
    const svg = document.createElementNS(SVG, 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', size); svg.setAttribute('height', size); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG, 'path'); path.setAttribute('d', ICONS[name]); path.setAttribute('fill', 'currentColor'); svg.append(path); return svg;
  };
  const tool = (name, label, onClick, id) => { const node = button('', onClick, 'origin-icon origin-research-tool', label); node.setAttribute('aria-label', label); node.append(icon(name)); if (id) node.id = id; return node; };
  const when = at => { const date = new Date(at); return date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : date.toLocaleDateString(); };

  function create(host) {
    const { app, view, drawer } = host;
    const headerButton = button('', () => void open(), 'origin-ghost origin-research-open', 'Research parts of this blueprint with your CLI. Nothing changes until you apply a suggestion.');
    headerButton.id = 'origin-research-open'; headerButton.hidden = true; headerButton.setAttribute('aria-label', 'Research'); headerButton.append(icon('research', 15), el('span', 'origin-research-label', 'Research'));
    const mini = button('', () => void open(), 'origin-research-mini', 'Open Research'); mini.id = 'origin-research-mini'; mini.hidden = true;
    mini.append(icon('research', 15), el('span', '', 'Research'), el('span', 'origin-research-mini-status'));
    view.append(mini);

    // Saved per browser: the CLI choice and the mode. Web search is chosen per chat and starts off.
    const stored = (() => { try { return JSON.parse(pref(SETTINGS_KEY, '{}')) || {}; } catch { return {}; } })();
    const settings = { provider: PROVIDERS[stored.provider] ? stored.provider : '', model: typeof stored.model === 'string' ? stored.model : '', effort: typeof stored.effort === 'string' ? stored.effort : '',
      mode: MODES.some(([id]) => id === stored.mode) ? stored.mode : 'chat', web: false, skills: stored.skills === true, scope: { kind: 'project' } };
    let projectId = null, isOpen = false, minimized = false, maximized = false, panel = 'chat', providers = null, models = new Map();
    let chats = null, chatsQuery = '', chat = null, error = '', confirmDelete = null;
    // The run in progress: its stop controller and the live text of each agent, kept across re-renders.
    let running = null;
    const drafts = new Map(); // Unsent text per project survives closing the panel and switching projects.
    const saveSettings = () => setPref(SETTINGS_KEY, JSON.stringify({ provider: settings.provider, model: settings.model, effort: settings.effort, mode: settings.mode, skills: settings.skills }));
    let sourceBusy = false, baseLibrary = null, sourceForm = 'document', mcpKind = 'context7';
    const api = (path, options = {}) => app.api(`/api/origin/research/${encodeURIComponent(projectId)}${path}`, { timeoutMs: 30000, ...options })
      .catch(() => ({ response: { ok: false, status: 0 }, data: { error: 'The app did not answer. Nothing was changed; try again.' } }));

    // ---- Opening, closing, minimizing ----
    function renderButton() {
      headerButton.hidden = !projectId;
      headerButton.setAttribute('aria-pressed', String(isOpen));
      mini.hidden = !minimized || !projectId;
      mini.querySelector('.origin-research-mini-status').textContent = running ? 'Researching…' : '';
    }
    async function open() {
      if (!projectId) return;
      // A new chat starts on what the person is looking at: the open record, otherwise the current section.
      const focus = host.currentFocus?.();
      if (!chat?.messages?.length && !running && focus) {
        const options = scopeOptions().map(option => scopeKey(option.value));
        const record = focus.record && { kind: 'record', collection: focus.record.collection, id: focus.record.id };
        if (record && options.includes(scopeKey(record))) settings.scope = record;
        else if (focus.section && focus.section !== 'overview' && options.includes(scopeKey({ kind: 'section', id: focus.section }))) settings.scope = { kind: 'section', id: focus.section };
      }
      host.closeOthers(); // The record editor and Project Context close; their unsaved work is kept and keeps saving.
      isOpen = true; minimized = false; error = '';
      applyWidth(); render(); renderButton();
      drawer.querySelector('#origin-research-input')?.focus();
      await loadProviders();
      if (isOpen) render();
    }
    function hide() {
      drawer.style.removeProperty('width'); view.style.removeProperty('--origin-drawer-width');
      drawer.hidden = true; drawer.replaceChildren(); delete drawer.dataset.mode; view.dataset.drawer = 'closed';
    }
    function close() {
      if (!isOpen && !minimized) return;
      keepDraft(); isOpen = false; minimized = false; maximized = false; hide(); renderButton();
      headerButton.focus({ preventScroll: true });
    }
    /** Minimized: the drawer is free for other panels; a small box brings Research back as it was. */
    function minimize() {
      keepDraft(); isOpen = false; minimized = true; hide(); renderButton();
      mini.focus({ preventScroll: true });
    }
    /** The panel yields the drawer to another panel. Its chat, settings and unsent text are kept. */
    function yieldDrawer() { if (isOpen) { keepDraft(); isOpen = false; hide(); renderButton(); } }
    function keepDraft() { const input = drawer.querySelector('#origin-research-input'); if (input && projectId) drafts.set(projectId, input.value); }

    async function reset(id) {
      if (id === projectId) return;
      if (isOpen || minimized) { keepDraft(); isOpen = false; minimized = false; hide(); }
      if (running) { running.switched = true; running.controller.abort(); } // A run belongs to its project; its partial answer is kept.
      projectId = id; chats = null; chat = null; chatsQuery = ''; panel = 'chat'; error = ''; confirmDelete = null;
      settings.scope = { kind: 'project' }; settings.web = false;
      renderButton();
    }

    // ---- Width: drag the left edge; maximize up to the navigation sidebar ----
    const maxWidth = () => {
      const sidebar = document.querySelector('#sidebar'), edge = sidebar && !sidebar.hidden && getComputedStyle(sidebar).display !== 'none' ? sidebar.getBoundingClientRect().right : 0;
      return Math.max(MIN_WIDTH, Math.floor(window.innerWidth - Math.max(0, edge) - 24));
    };
    const width = () => Math.min(maxWidth(), Math.max(MIN_WIDTH, Number(pref(WIDTH_KEY)) || DEFAULT_WIDTH));
    function applyWidth(value = maximized ? maxWidth() : width(), { save = false } = {}) {
      const next = Math.min(maxWidth(), Math.max(MIN_WIDTH, Math.round(value)));
      if (save) { maximized = false; setPref(WIDTH_KEY, String(next)); }
      if (window.matchMedia('(max-width: 730px)').matches) { drawer.style.removeProperty('width'); view.style.removeProperty('--origin-drawer-width'); return next; }
      drawer.style.width = `${next}px`; view.style.setProperty('--origin-drawer-width', `${next}px`);
      drawer.querySelector('.origin-research-resize')?.setAttribute('aria-valuenow', String(next));
      return next;
    }
    function resizer(grip) {
      grip.addEventListener('pointerdown', event => {
        event.preventDefault(); grip.setPointerCapture(event.pointerId);
        const move = moved => applyWidth(window.innerWidth - moved.clientX - 12, { save: true });
        const stop = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', stop); grip.removeEventListener('pointercancel', stop); renderTools(); };
        grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', stop); grip.addEventListener('pointercancel', stop);
      });
      grip.addEventListener('keydown', event => {
        const step = { ArrowLeft: 40, ArrowRight: -40, Home: 1e6, End: -1e6 }[event.key];
        if (step === undefined) return;
        event.preventDefault(); applyWidth(drawer.getBoundingClientRect().width + step, { save: true }); renderTools();
      });
    }
    function toggleMaximize() { maximized = !maximized; applyWidth(); renderTools(); drawer.querySelector('#origin-research-max')?.focus(); }
    window.addEventListener('resize', () => { if (isOpen) applyWidth(); });

    // ---- CLIs and models ----
    async function loadProviders() {
      if (providers) return;
      const { response, data } = await app.api('/api/providers', { timeoutMs: 30000 }).catch(() => ({ response: { ok: false }, data: {} }));
      providers = response.ok && Array.isArray(data.providers) ? data.providers.filter(item => PROVIDERS[item.id] && item.available) : [];
      if (!providers.some(item => item.id === settings.provider)) {
        // Start from Compose's CLI when it can research; otherwise the first installed one.
        const compose = host.composeSettings?.()?.provider;
        settings.provider = providers.find(item => item.id === compose)?.id || providers[0]?.id || '';
        settings.model = ''; settings.effort = '';
      }
      if (settings.provider) await loadModels(settings.provider);
    }
    async function loadModels(provider) {
      if (models.has(provider)) return;
      const { response, data } = await app.api(`/api/models?provider=${encodeURIComponent(provider)}`, { timeoutMs: 60000 }).catch(() => ({ response: { ok: false }, data: {} }));
      models.set(provider, response.ok && Array.isArray(data.models) ? data.models : []);
    }

    // ---- Scope: what to research, by stable IDs ----
    function scopeOptions() {
      const blueprint = host.blueprint();
      if (!blueprint) return [{ value: { kind: 'project' }, label: 'Whole project' }];
      return M().researchTargets ? M().researchTargets(blueprint) : [{ value: { kind: 'project' }, label: 'Whole project' },
        ...M().phaseList(blueprint).flatMap(phase => phase.sections.map(id => ({ value: { kind: 'section', id }, label: `${phase.label} › ${M().sectionTitle(blueprint, id)}`, group: 'Sections' })))];
    }
    const scopeKey = scope => JSON.stringify(scope);

    // ---- Rendering ----
    let toolsBox = null;
    function render() {
      if (!isOpen) return;
      drawer.dataset.mode = 'research'; view.dataset.drawer = 'open'; drawer.hidden = false;
      const focusId = drawer.contains(document.activeElement) ? document.activeElement.id : '';
      const grip = el('div', 'origin-context-resize origin-research-resize'); grip.tabIndex = 0;
      for (const [name, value] of Object.entries({ role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize the Research panel', 'aria-valuemin': String(MIN_WIDTH), 'aria-valuemax': String(maxWidth()), 'aria-valuenow': String(Math.round(drawer.getBoundingClientRect().width || width())) })) grip.setAttribute(name, value);
      resizer(grip);
      const head = el('div', 'origin-drawer-head origin-research-head');
      const top = el('div', 'origin-drawer-top');
      const title = el('h2', 'origin-research-title', 'Research'); title.id = 'origin-drawer-title'; title.tabIndex = -1;
      toolsBox = el('div', 'origin-research-tools');
      renderTools();
      top.append(title, toolsBox);
      head.append(top, controls());
      const body = el('div', 'origin-drawer-body origin-research-body'); body.id = 'origin-research-body';
      if (panel === 'history') body.append(...historyView()); else body.append(...chatView());
      const nodes = [grip, head, body];
      if (error) { const message = el('p', 'origin-inline-error', error); message.setAttribute('role', 'alert'); nodes.push(message); }
      if (panel === 'chat') nodes.push(composer());
      drawer.replaceChildren(...nodes);
      if (focusId) drawer.querySelector(`#${CSS.escape(focusId)}`)?.focus({ preventScroll: true });
    }
    function renderTools() {
      if (!toolsBox) return;
      const provider = providers?.find(item => item.id === settings.provider);
      const cli = button(provider ? `${PROVIDERS[provider.id]}${settings.model ? ` · ${clip(settings.model, 22)}` : ''}` : providers ? 'No CLI' : 'CLI…', () => { panel = panel === 'settings' ? 'chat' : 'settings'; render(); }, 'origin-research-cli', 'Choose the CLI and model for research');
      cli.id = 'origin-research-cli'; cli.setAttribute('aria-expanded', String(panel === 'settings'));
      const web = button('', () => { settings.web = !settings.web; renderTools(); }, `origin-icon origin-research-tool origin-research-web${settings.web ? ' is-on' : ''}`, settings.web ? 'Web search is on for this chat' : 'Web search is off');
      web.id = 'origin-research-web'; web.setAttribute('aria-pressed', String(settings.web)); web.setAttribute('aria-label', 'Web search'); web.append(icon('globe'));
      const history = tool('clock', 'History', () => void openHistory(), 'origin-research-history'); history.setAttribute('aria-pressed', String(panel === 'history'));
      toolsBox.replaceChildren(cli, web, history, tool('plus', 'New chat', () => newChat(), 'origin-research-new'),
        tool(maximized ? 'restore' : 'max', maximized ? 'Restore width' : 'Maximize', toggleMaximize, 'origin-research-max'),
        tool('min', 'Minimize', minimize, 'origin-research-minimize'), tool('close', 'Close (Esc)', close, 'origin-research-close'));
    }
    function controls() {
      const box = el('div', 'origin-research-controls');
      const modes = el('div', 'origin-seg origin-research-modes'); modes.setAttribute('role', 'radiogroup'); modes.setAttribute('aria-label', 'Research mode');
      for (const [id, label, help] of MODES) {
        const option = button(label, () => { settings.mode = id; saveSettings(); render(); }, '', help);
        option.setAttribute('role', 'radio'); option.setAttribute('aria-checked', String(settings.mode === id)); option.dataset.mode = id; option.id = `origin-research-mode-${id}`;
        modes.append(option);
      }
      const scope = el('select', 'origin-research-scope'); scope.id = 'origin-research-scope'; scope.setAttribute('aria-label', 'What to research');
      const groups = new Map();
      for (const option of scopeOptions()) {
        const node = el('option', '', option.label); node.value = scopeKey(option.value);
        if (!option.group) { scope.append(node); continue; }
        if (!groups.has(option.group)) { const group = el('optgroup'); group.label = option.group; groups.set(option.group, group); scope.append(group); }
        groups.get(option.group).append(node);
      }
      scope.value = scopeKey(settings.scope);
      if (scope.selectedIndex < 0) { settings.scope = { kind: 'project' }; scope.value = scopeKey(settings.scope); }
      scope.addEventListener('change', () => { settings.scope = JSON.parse(scope.value); });
      box.append(modes, scope, sourceChips());
      return box;
    }
    /** Attached sources as small chips: a click turns one on or off, × removes it. */
    function sourceChips() {
      const row = el('div', 'origin-research-sources'); row.setAttribute('aria-label', 'Sources for this chat');
      for (const source of chat?.sources || []) {
        const chip = el('span', `origin-research-chip${source.enabled ? '' : ' is-off'}`);
        const toggle = button(`${{ document: '📄', excerpt: '❝', base: '◆', mcp: '⇄' }[source.type] || ''} ${source.name}${source.from ? ` · pp. ${source.from}–${source.to}` : ''}`, () => void setSource(source.id, { enabled: !source.enabled }), 'origin-research-chip-toggle',
          source.enabled ? 'Used for research. Click to turn off.' : 'Not used. Click to turn on.');
        toggle.setAttribute('aria-pressed', String(source.enabled));
        const remove = button('×', () => void removeSource(source.id), 'origin-research-chip-remove', `Remove ${source.name}`); remove.setAttribute('aria-label', `Remove ${source.name}`);
        chip.append(toggle, remove); row.append(chip);
      }
      const add = button('+ Sources', () => { panel = panel === 'sources' ? 'chat' : 'sources'; render(); }, 'origin-research-add-source', 'Attach documents, excerpts, Base knowledge or a read-only MCP server to this chat');
      add.id = 'origin-research-add-source'; add.setAttribute('aria-expanded', String(panel === 'sources'));
      row.append(add);
      return row;
    }
    function chatView() {
      if (panel === 'settings') return [settingsView()];
      if (panel === 'sources') return [sourcesView()];
      const log = el('div', 'origin-research-log'); log.id = 'origin-research-log'; log.setAttribute('aria-live', 'polite');
      const messages = chat?.messages || [];
      if (!messages.length) {
        const mode = MODES.find(([id]) => id === settings.mode);
        log.append(el('p', 'origin-research-hint', `${mode[2]}. Choose what to research above, then ask. Research reads the saved blueprint and changes nothing until you apply a suggestion.`));
        if (providers && !providers.length) log.append(el('p', 'origin-inline-error', 'Install and sign in to Claude Code or Codex to research. Open CLI connections at the top right.'));
      }
      for (const message of messages) log.append(messageView(message));
      if (running) for (const agent of running.agents.values()) log.append(liveView(agent));
      return [log];
    }
    function messageView(message) {
      const item = el('article', `origin-research-message is-${message.role}`); item.dataset.id = message.id;
      if (message.agent?.label) item.append(el('p', 'origin-research-agent', message.agent.label));
      if (message.role === 'user') item.append(el('p', 'origin-research-text', message.text));
      else item.append(window.PromptboardMarkdown.render(message.text || ''));
      if (message.citations?.length) {
        const list = el('ul', 'origin-research-citations'); list.setAttribute('aria-label', 'Sources');
        for (const cite of message.citations) {
          const row = el('li');
          if (cite.url) { const link = el('a', '', cite.title || cite.url); link.href = cite.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link, el('span', '', ` · accessed ${cite.accessedAt}`)); }
          else row.append(el('strong', '', `[${cite.ref}]`), el('span', '', ` ${cite.title} · ${cite.locator}`));
          list.append(row);
        }
        item.append(list);
      }
      for (const warning of message.warnings || []) item.append(el('small', 'origin-research-meta is-error', warning));
      const meta = [when(message.at), message.provider && PROVIDERS[message.provider], message.status === 'stopped' && 'Stopped', message.error?.message].filter(Boolean).join(' · ');
      if (message.role !== 'user' && meta) item.append(el('small', `origin-research-meta${message.error ? ' is-error' : ''}`, meta));
      return item;
    }
    /** A reply while the CLI writes it: plain text that grows, and the latest activity (search, fetch, tool). */
    function liveView(agent) {
      const item = el('article', 'origin-research-message is-assistant is-live'); item.dataset.agent = agent.id;
      if (agent.label) item.append(el('p', 'origin-research-agent', agent.label));
      const text = el('p', 'origin-research-text'); text.append(agent.textNode = document.createTextNode(agent.text));
      const activity = el('p', 'origin-research-activity'); activity.setAttribute('aria-live', 'off');
      agent.activityNode = activity; renderActivity(agent);
      item.append(text, activity);
      return item;
    }
    function renderActivity(agent) {
      if (!agent.activityNode) return;
      const labels = { search: 'Searching the web', fetch: 'Reading', tool: 'Using', skill: 'Using skill', note: '' };
      const dots = el('span', 'origin-research-dots'); dots.append(el('span'), el('span'), el('span'));
      const words = agent.status === 'running' ? (agent.activity ? `${labels[agent.activity.kind] ?? ''}${labels[agent.activity.kind] ? ': ' : ''}${agent.activity.label}` : agent.text ? '' : 'Thinking') : agent.status === 'failed' ? 'Failed' : '';
      agent.activityNode.replaceChildren(...(agent.status === 'running' ? [dots] : []), document.createTextNode(words));
    }
    function settingsView() {
      const box = el('section', 'origin-research-settings'); box.setAttribute('aria-label', 'CLI and model');
      if (!providers) { box.append(el('p', 'origin-research-hint', 'Checking installed CLIs…')); return box; }
      if (!providers.length) { box.append(el('p', 'origin-inline-error', 'Research uses Claude Code or Codex. Install one, sign in, then open Research again.')); return box; }
      const field = (label, control) => { const wrap = el('label', 'origin-research-field'); wrap.append(el('span', '', label), control); return wrap; };
      const provider = el('select'); provider.id = 'origin-research-provider';
      for (const item of providers) provider.append(Object.assign(el('option', '', `${PROVIDERS[item.id]}${item.version ? ` (${clip(item.version, 24)})` : ''}`), { value: item.id }));
      provider.value = settings.provider;
      provider.addEventListener('change', async () => { settings.provider = provider.value; settings.model = ''; settings.effort = ''; saveSettings(); await loadModels(settings.provider); render(); });
      const list = models.get(settings.provider) || [];
      const model = el('select'); model.id = 'origin-research-model';
      model.append(Object.assign(el('option', '', 'CLI default model'), { value: '' }), ...list.map(entry => Object.assign(el('option', '', entry.name || entry.id), { value: entry.id })));
      if (settings.model && !list.some(entry => entry.id === settings.model)) model.append(Object.assign(el('option', '', settings.model), { value: settings.model }));
      model.value = settings.model;
      model.addEventListener('change', () => { settings.model = model.value; settings.effort = ''; saveSettings(); render(); });
      const efforts = list.find(entry => entry.id === settings.model)?.efforts || (settings.model ? [] : ['low', 'medium', 'high']);
      const effort = el('select'); effort.id = 'origin-research-effort';
      effort.append(Object.assign(el('option', '', 'CLI default'), { value: '' }), ...efforts.map(level => Object.assign(el('option', '', level), { value: level })));
      effort.value = efforts.includes(settings.effort) ? settings.effort : '';
      effort.addEventListener('change', () => { settings.effort = effort.value; saveSettings(); });
      const done = button('Done', () => { panel = 'chat'; render(); drawer.querySelector('#origin-research-cli')?.focus(); }, 'origin-ghost');
      const skills = el('label', 'origin-research-check'); const box2 = el('input'); box2.type = 'checkbox'; box2.id = 'origin-research-skills'; box2.checked = settings.skills;
      box2.addEventListener('change', () => { settings.skills = box2.checked; saveSettings(); });
      skills.append(box2, el('span', '', 'Use my installed Claude Code skills as instructions (their scripts never run)'));
      box.append(field('CLI', provider), field('Model', model), field('Effort', effort), ...(settings.provider === 'claude' ? [skills] : []),
        el('p', 'origin-research-hint', 'Research runs read-only: no shell and no file changes. Web search, MCP tools and skills stay off until you turn them on for a chat.'), done);
      return box;
    }
    function composer() {
      const form = el('form', 'origin-research-form');
      const input = el('textarea'); input.id = 'origin-research-input'; input.rows = 2; input.maxLength = 8000; input.value = drafts.get(projectId) || '';
      input.placeholder = { chat: 'Ask about this part of your blueprint…', swarm: 'What should each agent find out? (optional)', decision: 'Which options should be compared? For example: PostgreSQL vs MongoDB', audit: 'What should the audit focus on? (optional)' }[settings.mode];
      input.setAttribute('aria-label', 'Research request');
      input.addEventListener('input', () => drafts.set(projectId, input.value));
      input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } });
      const send = el('button', `origin-research-send${running ? ' is-stop' : ''}`); send.type = running ? 'button' : 'submit'; send.id = 'origin-research-send';
      send.setAttribute('aria-label', running ? 'Stop' : 'Send'); send.append(icon(running ? 'stop' : 'send'));
      send.disabled = !running && !settings.provider;
      if (running) send.addEventListener('click', () => running?.controller.abort());
      form.append(input, send);
      form.addEventListener('submit', event => { event.preventDefault(); if (!running) void submit(input.value); });
      return form;
    }

    // ---- Sources ----
    function sourcesView() {
      const box = el('section', 'origin-research-source-form'); box.setAttribute('aria-label', 'Add a source');
      const kinds = el('div', 'origin-seg'); kinds.setAttribute('role', 'radiogroup'); kinds.setAttribute('aria-label', 'Source type');
      for (const [id, label] of [['document', 'Document'], ['excerpt', 'Excerpt'], ['base', 'Base'], ['mcp', 'MCP']]) {
        const option = button(label, () => { sourceForm = id; render(); }, ''); option.setAttribute('role', 'radio'); option.setAttribute('aria-checked', String(sourceForm === id)); option.id = `origin-research-source-${id}`;
        kinds.append(option);
      }
      const field = (label, control) => { const wrap = el('label', 'origin-research-field'); wrap.append(el('span', '', label), control); return wrap; };
      const input = (id, placeholder, type = 'text') => { const node = el('input'); node.id = id; node.type = type; node.placeholder = placeholder; return node; };
      const action = (label, onClick) => { const node = button(label, onClick, 'origin-ghost origin-research-source-add'); node.id = 'origin-research-source-submit'; node.disabled = sourceBusy; return node; };
      const forms = {
        document: () => {
          const file = input('origin-research-file', '', 'file'); file.accept = '.pdf,.txt,.md,application/pdf,text/plain,text/markdown';
          const from = input('origin-research-from', 'From page', 'number'), to = input('origin-research-to', 'To page', 'number'); from.min = to.min = '1';
          const pages = el('div', 'origin-research-pages'); pages.append(from, to);
          return [field('PDF, text or Markdown (up to 20 MiB)', file), field('Pages (PDF only, optional)', pages), el('p', 'origin-research-hint', 'The text is read on this computer. Only passages that match each question are sent to the CLI, with page or section references.'),
            action('Attach document', () => void attachDocument(file.files[0], from.value, to.value))];
        },
        excerpt: () => {
          const title = input('origin-research-excerpt-name', 'For example: Chapter 4, Designing Data-Intensive Applications'), text = el('textarea'); text.id = 'origin-research-excerpt'; text.rows = 6; text.maxLength = 20000; text.placeholder = 'Paste the passage to use…';
          return [field('Title and location', title), field('Excerpt', text), action('Add excerpt', () => void addSource({ type: 'excerpt', name: title.value, text: text.value }))];
        },
        base: () => {
          if (!baseLibrary) { void loadBase(); return [el('p', 'origin-research-hint', 'Reading Base…')]; }
          if (!baseLibrary.length) return [el('p', 'origin-research-hint', 'No enabled, trusted Base knowledge, context, skill or MCP resource yet. Add one in Base first.')];
          const pick = el('select'); pick.id = 'origin-research-base';
          for (const resource of baseLibrary) pick.append(Object.assign(el('option', '', `${resource.name} · ${resource.kind === 'mcp' ? 'MCP' : resource.kind}`), { value: resource.id }));
          return [field('Base resource', pick), action('Add from Base', () => { const resource = baseLibrary.find(item => item.id === pick.value); void addSource(resource.kind === 'mcp' ? { type: 'mcp', resourceId: resource.id } : { type: 'base', resourceId: resource.id, name: resource.name }); })];
        },
        mcp: () => {
          const preset = el('select'); preset.id = 'origin-research-mcp-kind';
          for (const [value, label] of [['context7', 'Context7 (documentation)'], ['http', 'HTTP server'], ['stdio', 'Local program']]) preset.append(Object.assign(el('option', '', label), { value }));
          preset.value = mcpKind; preset.addEventListener('change', () => { mcpKind = preset.value; render(); });
          const name = input('origin-research-mcp-name', 'Name'), library = input('origin-research-mcp-library', 'Library to look up, for example PostgreSQL'), endpoint = input('origin-research-mcp-url', 'https://…'),
            command = input('origin-research-mcp-command', 'Program, for example npx'), args = input('origin-research-mcp-args', 'Arguments, separated by spaces');
          const allow = el('label', 'origin-research-check'); const allowBox = el('input'); allowBox.type = 'checkbox'; allowBox.id = 'origin-research-mcp-allow'; allow.append(allowBox, el('span', '', 'I trust this program. Allow Promptboard to start it for research.'));
          const kind = preset.value, fields = [field('Kind', preset)];
          if (kind === 'context7') fields.push(field('Library', library));
          else fields.push(field('Name', name), ...(kind === 'http' ? [field('Server URL', endpoint)] : [field('Program', command), field('Arguments', args), allow]));
          fields.push(el('p', 'origin-research-hint', 'Promptboard connects first and lists the server’s tools. Only one annotated read-only query tool can be used; the app asks it and gives the answers to the agent as cited data. Credentials stay in environment variables.'),
            action('Test and add', () => void addSource(kind === 'context7' ? { type: 'mcp', config: { type: 'mcp', preset: 'context7' }, library: library.value }
              : { type: 'mcp', config: kind === 'http' ? { type: 'mcp', name: name.value, transport: 'streamable-http', endpoint: endpoint.value } : { type: 'mcp', name: name.value, transport: 'stdio', command: command.value, args: args.value.split(/\s+/).filter(Boolean), allowStart: allowBox.checked } })));
          return fields;
        },
      };
      box.append(kinds, ...forms[sourceForm](), button('Back to chat', () => { panel = 'chat'; render(); }, 'origin-link'));
      return box;
    }
    async function loadBase() {
      const { response, data } = await app.api('/api/base', { timeoutMs: 30000 }).catch(() => ({ response: { ok: false }, data: {} }));
      baseLibrary = response.ok ? (data.resources || []).filter(resource => resource.enabled && resource.trust === 'trusted' && ['knowledge', 'context', 'skill', 'mcp'].includes(resource.kind)) : [];
      if (isOpen && panel === 'sources') render();
    }
    async function addSource(source) {
      if (sourceBusy) return;
      sourceBusy = true; error = ''; render();
      const id = projectId, current = await ensureChat();
      if (!current || id !== projectId) { sourceBusy = false; render(); return; }
      const { response, data } = await api(`/chats/${current.id}/sources`, { method: 'POST', body: { source }, timeoutMs: 60000 });
      sourceBusy = false;
      if (id !== projectId) return;
      if (!response.ok) { error = data.error || 'The source could not be added.'; render(); return; }
      chat = { ...chat, sources: data.sources }; panel = 'chat'; app.announce(`${data.source.name} attached to this chat.`); render();
    }
    async function attachDocument(file, from, to) {
      if (!file) { error = 'Choose a PDF, .txt or .md file.'; render(); return; }
      if (file.size > 20 * 1024 * 1024) { error = 'Choose a document up to 20 MiB.'; render(); return; }
      const params = new URLSearchParams({ name: file.name });
      if (from) params.set('from', from); if (to) params.set('to', to);
      sourceBusy = true; error = ''; render();
      let data = {};
      try { const response = await app.uploadApi(`/api/compose/sources/document?${params}`, file); data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'The document could not be read.'); }
      catch (failure) { sourceBusy = false; error = failure.message; render(); return; }
      sourceBusy = false;
      const doc = data.document;
      await addSource({ type: 'document', documentId: doc.id, name: doc.name, ...(doc.sourceType === 'pdf' && doc.from ? { from: doc.from, to: doc.to } : {}) });
    }
    async function setSource(sourceId, change) {
      const { response, data } = await api(`/chats/${chat.id}/sources/${sourceId}`, { method: 'PATCH', body: change });
      if (response.ok) chat = { ...chat, sources: data.sources }; else error = data.error || 'The source could not be changed.';
      render();
    }
    async function removeSource(sourceId) {
      const { response, data } = await api(`/chats/${chat.id}/sources/${sourceId}`, { method: 'DELETE' });
      if (response.ok) chat = { ...chat, sources: data.sources }; else error = data.error || 'The source could not be removed.';
      render(); drawer.querySelector('#origin-research-add-source')?.focus();
    }

    // ---- History ----
    async function openHistory() {
      if (panel === 'history') { panel = 'chat'; render(); return; }
      panel = 'history'; confirmDelete = null; render();
      await loadChats();
    }
    async function loadChats() {
      const id = projectId, { response, data } = await api(`/chats${chatsQuery ? `?q=${encodeURIComponent(chatsQuery)}` : ''}`);
      if (id !== projectId) return;
      chats = response.ok ? data.chats : [];
      error = response.ok ? '' : data.error || 'Research history could not be read.';
      if (isOpen && panel === 'history') render();
    }
    function historyView() {
      const search = el('input', 'origin-research-search'); search.id = 'origin-research-search'; search.type = 'search'; search.placeholder = 'Search research chats…'; search.value = chatsQuery;
      search.setAttribute('aria-label', 'Search research chats');
      let timer;
      search.addEventListener('input', () => { chatsQuery = search.value; clearTimeout(timer); timer = setTimeout(() => void loadChats(), 250); });
      const list = el('ul', 'origin-research-chats'); list.setAttribute('aria-label', 'Research chats');
      if (!chats) list.append(el('li', 'origin-research-hint', 'Loading…'));
      else if (!chats.length) list.append(el('li', 'origin-research-hint', chatsQuery ? 'No chat matches.' : 'No research chats yet.'));
      for (const entry of chats || []) {
        const row = el('li', 'origin-research-chat'); row.dataset.id = entry.id;
        const openChat = button('', () => void resume(entry.id), 'origin-research-chat-open');
        openChat.append(el('strong', '', entry.title), el('small', '', [when(entry.updatedAt), MODES.find(([id]) => id === entry.mode)?.[1], PROVIDERS[entry.provider], `${entry.messages} messages`, entry.pending ? `${entry.pending} suggestions to review` : ''].filter(Boolean).join(' · ')));
        row.append(openChat);
        if (confirmDelete === entry.id) {
          const yes = button('Delete', () => void removeChat(entry.id), 'origin-ghost danger'); yes.id = 'origin-research-delete-confirm';
          row.append(el('span', 'origin-research-confirm', 'Delete this chat?'), yes, button('Keep', () => { confirmDelete = null; render(); }, 'origin-ghost'));
        } else {
          const remove = tool('close', `Delete “${entry.title}”`, () => { confirmDelete = entry.id; render(); drawer.querySelector('#origin-research-delete-confirm')?.focus(); });
          row.append(remove);
        }
        list.append(row);
      }
      return [search, list];
    }
    async function resume(id) {
      const { response, data } = await api(`/chats/${id}`);
      if (!response.ok) { error = data.error || 'This chat could not be opened.'; render(); return; }
      chat = data.chat; panel = 'chat'; error = '';
      if (PROVIDERS[chat.settings?.provider]) Object.assign(settings, { provider: chat.settings.provider, model: chat.settings.model || '', effort: chat.settings.effort || '' });
      settings.mode = chat.settings?.mode || settings.mode; settings.web = chat.settings?.web === true; settings.scope = chat.settings?.scope || { kind: 'project' };
      render(); scrollToEnd();
    }
    async function removeChat(id) {
      const { response, data } = await api(`/chats/${id}`, { method: 'DELETE' });
      if (!response.ok) { error = data.error || 'The chat could not be deleted.'; render(); return; }
      if (chat?.id === id) chat = null;
      confirmDelete = null; app.announce('Research chat deleted.'); await loadChats();
      drawer.querySelector('#origin-research-search')?.focus();
    }
    function newChat() { chat = null; panel = 'chat'; error = ''; settings.web = false; render(); drawer.querySelector('#origin-research-input')?.focus(); }
    const scrollToEnd = () => { const log = drawer.querySelector('#origin-research-log'); if (log) log.scrollTop = log.scrollHeight; };

    // ---- Sending: one streamed run at a time ----
    const runSettings = () => ({ provider: settings.provider, model: settings.model, effort: settings.effort, mode: settings.mode, web: settings.web, skills: settings.skills, scope: settings.scope });
    /** The current chat, created on first use so sources can be attached before the first question. */
    async function ensureChat() {
      if (chat) return chat;
      const id = projectId, { response, data } = await api('/chats', { method: 'POST', body: { settings: runSettings() } });
      if (id !== projectId) return null;
      if (!response.ok) { error = data.error || 'The chat could not be created.'; render(); return null; }
      return (chat = data.chat);
    }
    const nearEnd = () => { const body = drawer.querySelector('#origin-research-body'); return !body || body.scrollHeight - body.scrollTop - body.clientHeight < 80; };
    const followEnd = stick => { if (stick) { const body = drawer.querySelector('#origin-research-body'); if (body) body.scrollTop = body.scrollHeight; } };
    async function submit(value) {
      const question = value.trim();
      if (!settings.provider) { error = 'Choose Claude Code or Codex first.'; render(); return; }
      if (!question && settings.mode === 'chat') return;
      const id = projectId;
      error = '';
      if (!(await ensureChat()) || id !== projectId) return;
      const run = running = { controller: new AbortController(), agents: new Map(), chatId: chat.id, projectId: id };
      drafts.delete(id); panel = 'chat'; render(); renderButton(); followEnd(true);
      let response;
      try { response = await app.streamApi(`/api/origin/research/${encodeURIComponent(id)}/chats/${chat.id}/run`, { text: question, settings: runSettings() }, { signal: run.controller.signal }); }
      catch { response = null; }
      if (!response?.ok) {
        const data = response ? await response.json().catch(() => ({})) : {};
        if (running === run) running = null;
        if (id === projectId) { error = run.controller.signal.aborted ? '' : data.error || 'Research could not start. Check that the app is running.'; drafts.set(id, value); render(); }
        renderButton(); return;
      }
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let pending = '';
      try {
        for (;;) {
          const { value: chunk, done } = await reader.read();
          if (done) break;
          pending += decoder.decode(chunk, { stream: true });
          const lines = pending.split('\n'); pending = lines.pop();
          for (const line of lines) if (line.trim()) { try { receive(run, JSON.parse(line)); } catch {} }
        }
      } catch {}
      if (running === run) running = null;
      if (run.projectId === projectId && !run.done) {
        // Stopped or disconnected: the server keeps what was produced. Read the stored chat.
        const { response: again, data } = await api(`/chats/${run.chatId}`);
        if (again.ok && chat?.id === run.chatId) chat = data.chat;
        if (run.switched === undefined && !run.controller.signal.aborted && !run.failed) error = 'The connection to the app ended. What was stored is shown.';
      }
      if (run.projectId === projectId) { render(); followEnd(true); if (isOpen) drawer.querySelector('#origin-research-input')?.focus({ preventScroll: true }); }
      renderButton();
      if (run.done && !isOpen) app.announce('Research finished.');
    }
    /** One streamed event. Only the live text node changes for text; whole redraws happen on new messages. */
    function receive(run, event) {
      const visible = run.projectId === projectId && chat?.id === run.chatId && isOpen && panel === 'chat';
      const stick = visible && nearEnd();
      if (event.type === 'start') {
        for (const agent of event.agents || []) run.agents.set(agent.id, { id: agent.id, label: agent.label || '', text: '', status: 'running', activity: null });
        if (visible) { render(); followEnd(stick); }
      } else if (event.type === 'delta' || event.type === 'activity') {
        const agent = run.agents.get(event.agent);
        if (!agent) return;
        if (event.type === 'delta') { agent.text += event.text; agent.activity = null; if (visible && agent.textNode?.isConnected) agent.textNode.appendData(event.text); else if (visible) render(); }
        else { agent.activity = { kind: event.kind, label: event.label }; if (visible) renderActivity(agent); }
        followEnd(stick);
      } else if (event.type === 'agent') {
        const agent = run.agents.get(event.agent);
        if (agent) { agent.status = event.status; if (visible) renderActivity(agent); }
      } else if (event.type === 'message') {
        if (chat?.id === run.chatId) chat = { ...chat, messages: [...chat.messages.filter(message => message.id !== event.message.id), event.message] };
        if (event.message.role !== 'user') { const agent = run.agents.get(event.message.agent?.id || 'main'); if (agent) run.agents.delete(agent.id); }
        if (visible) { render(); followEnd(stick); }
      } else if (event.type === 'done') {
        run.done = true;
        if (chat?.id === run.chatId) chat = event.chat;
      } else if (event.type === 'error') {
        run.failed = true;
        if (run.projectId === projectId) error = event.message || 'Research failed.';
      }
    }

    return { button: headerButton, reset, close, minimize, yieldDrawer, isOpen: () => isOpen, isMinimized: () => minimized };
  }

  return { create };
})();
