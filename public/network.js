'use strict';

// Network page (#/network): the agent directory and agent profiles, over the owner routes /api/network/*; the Graph and
// Library sections live in network-graph.js, the Pipelines section (designer and run view) in network-pipeline.js,
// Activity (and a profile's Activity tab) in network-activity.js, Settings (external clients) in network-clients.js,
// all shown from here.
// Base stays the only editor of agent definitions: this page reads Base, registers a Base agent by its ID, edits only the
// Network identity (display name, tags, capabilities, projects, on/off) and opens the real resource in Base. A profile
// also holds the agent's memory (proposed, then approved by the owner, with history and a preview of exactly what a job
// would receive) and the owner's reports. Only the Tasks tab starts work: a job the owner confirms, run by the local worker
// on this computer. All text is set as text (PromptboardDom); reports and job results are Markdown drawn by
// PromptboardMarkdown, which shows HTML as text and loads nothing.
window.PromptboardNetwork = (() => {
  const { el, button, plural, ago, clip } = window.PromptboardDom;
  // Agents works now; each other section says what it will do and offers no working-looking controls until then.
  const SECTIONS = [
    ['agents', 'Agents', ''],
    ['graph', 'Graph', ''],
    ['pipelines', 'Pipelines', ''],
    ['activity', 'Activity', ''],
    ['library', 'Library', ''],
    ['federation', 'Federation', 'Work with trusted remote agents over A2A. It stays off until you turn it on.'],
    ['settings', 'Settings', ''],
  ];
  const PROFILE_TABS = [
    ['profile', 'Profile', ''],
    ['tasks', 'Tasks', ''],
    ['activity', 'Activity', ''],
    ['memory', 'Memory', ''],
    ['posts', 'Posts', ''],
  ];
  const MEMORY_KINDS = [['fact', 'Fact'], ['lesson', 'Lesson'], ['preference', 'Preference'], ['procedure', 'Procedure']];
  const KIND_NAMES = Object.fromEntries(MEMORY_KINDS);
  const MEMORY_STATES = { proposed: ['Proposed', 'warn'], approved: ['Approved', 'ok'], rejected: ['Rejected', 'off'] };
  const HISTORY = { proposed: 'Proposed', edited: 'Edited', approved: 'Approved', rejected: 'Rejected' };
  const KINDS = { profile: 'Agent', agentProfile: 'Agent profile' };
  const ICONS = { profile: '◉', agentProfile: '◎' };
  const PROVIDERS = [['claude', 'Claude Code'], ['codex', 'Codex'], ['gemini', 'Gemini CLI'], ['agy', 'Antigravity']];
  const PROVIDER_NAMES = Object.fromEntries(PROVIDERS);
  const STALE = {
    missing: 'The Base agent no longer exists.', 'wrong-kind': 'The Base resource is no longer an agent.', disabled: 'The Base agent is switched off.',
    untrusted: 'The Base agent is not trusted.', revoked: 'Trust in the Base agent was revoked.', 'no-primary-agent': 'The agent profile has no primary agent switched on.',
    'primary-agent-disabled': 'The profile’s primary agent is switched off.', 'primary-agent-untrusted': 'The profile’s primary agent is not trusted.', 'primary-agent-revoked': 'Trust in the profile’s primary agent was revoked.',
  };
  // The provider capability matrix (docs/network/architecture.md §8), as the server reports it for the agent's CLI.
  const CAPABILITIES = [['toolEvents', 'Tool-level activity'], ['waitingEvents', 'Waiting and permission events'], ['readOnly', 'Enforced read-only mode'], ['webSearch', 'Read-only web search'],
    ['sessionId', 'Native session ID'], ['usage', 'Usage reported'], ['dockerSandbox', 'Docker sandbox'], ['liveVerified', 'Checked with the real CLI']];
  const VALUES = { yes: ['Yes', 'ok'], partial: ['Partly', 'warn'], no: ['No', 'off'], unknown: ['Unknown', ''] };
  // Network job statuses (src/network/jobs.mjs) and what each CLI lets Network see of a running job (architecture §8).
  const JOB_STATES = { queued: ['Queued', 'warn'], waiting_for_approval: ['Waiting for approval', 'warn'], preparing: ['Preparing', 'warn'], running: ['Running', 'ok'],
    waiting_for_input: ['Waiting for input', 'warn'], completed: ['Completed', 'ok'], failed: ['Failed', 'error'], cancelled: ['Cancelled', 'off'], interrupted: ['Interrupted', 'warn'], unknown: ['Outcome unknown', 'warn'] };
  const JOB_OPEN = new Set(['queued', 'waiting_for_approval', 'preparing', 'running', 'waiting_for_input']);
  const COVERAGE = { tools: 'Tool-level activity reported', 'partial-tools': 'Some tool activity reported (web search)', 'final-only': 'Only the final answer is reported' };
  const AGENT_ID = /^agt_[0-9a-f]{20}$/, NETWORK_ID = /^net_[0-9a-f]{20}$/, JOB_ID = /^job_[0-9a-f]{20}$/;
  const PIPELINE_ID = /^pip_[0-9a-f]{20}$/, RUN_ID = /^run_[0-9a-f]{20}$/;

  const note = (text, className = 'note') => el('p', className, text);
  const labelled = (text, control, className = 'field-label') => { const label = el('label', className); label.append(text, control); return label; };
  const select = options => { const node = el('select'); for (const [value, text] of options) node.append(Object.assign(el('option', '', text), { value })); return node; };
  const words = value => [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))];
  const nameOf = agent => agent.displayName || agent.base.name || agent.baseResourceId;
  const subtitle = agent => [KINDS[agent.base.kind] || 'Not in Base', PROVIDER_NAMES[agent.base.provider], agent.base.model].filter(Boolean).join(' · ');
  const stateOf = agent => (agent.base.stale ? 'stale' : agent.enabled ? 'enabled' : 'disabled');
  const blocked = agent => (agent.base.stale ? STALE[agent.base.staleReason] || 'The Base agent cannot be used.' : agent.enabled ? '' : 'The registration is switched off in Network.');
  function statusLine(agent) {
    const [text, tone] = { stale: ['Stale', 'warn'], enabled: ['Enabled', 'ok'], disabled: ['Disabled', 'off'] }[stateOf(agent)];
    return el('small', `base-status tone-${tone}`, text);
  }
  function kindIcon(kind) { const mark = el('span', `base-kind-icon kind-${kind || 'missing'}`, ICONS[kind] || '?'); mark.setAttribute('aria-hidden', 'true'); return mark; }
  const chips = (values, empty) => { if (!values.length) return empty; const box = el('span', 'network-chips'); box.append(...values.map(value => el('span', 'base-tag', value))); return box; };
  function facts(rows) {
    const list = el('dl', 'network-facts');
    for (const [label, value] of rows) { const dd = el('dd'); dd.append(value); list.append(el('dt', '', label), dd); }
    return list;
  }

  // #/network (Agents), #/network/agents/<id>, #/network/<section>, #/network/library/<networkId>,
  // #/network/graph/<networkId> and its published versions #/network/graph/<networkId>/v<n>, #/network/activity/<jobId> (one
  // job's record), #/network/pipelines/<pipelineId> (the designer) and #/network/runs/<runId> (a run, under Pipelines).
  // Anything else opens Agents.
  function route() {
    const [section, id, extra] = location.hash.replace(/^#\/network\/?/, '').split('/');
    if (section === 'agents' && AGENT_ID.test(id || '')) return { section: 'agents', agentId: id };
    if (section === 'activity' && JOB_ID.test(id || '')) return { section, agentId: null, networkId: null, version: null, jobId: id };
    if (section === 'pipelines' && PIPELINE_ID.test(id || '')) return { section, agentId: null, pipelineId: id };
    if (section === 'runs' && RUN_ID.test(id || '')) return { section: 'pipelines', agentId: null, runId: id };
    if (['graph', 'library'].includes(section) && NETWORK_ID.test(id || '')) return { section, agentId: null, networkId: id, version: section === 'graph' && /^v[1-9]\d{0,8}$/.test(extra || '') ? Number(extra.slice(1)) : null };
    return { section: SECTIONS.some(([key]) => key === section) ? section : 'agents', agentId: null, networkId: null, version: null };
  }
  const hashFor = (section, agentId) => (agentId ? `#/network/agents/${agentId}` : section === 'agents' ? '#/network' : `#/network/${section}`);

  /** A tablist: arrow keys, Home and End move between the tabs and select them (as the Compose mode tabs do). */
  function tablist(label, items, prefix, panelOf, onSelect, className) {
    const list = el('div', `view-switch ${className}`); list.setAttribute('role', 'tablist'); list.setAttribute('aria-label', label);
    const tabs = items.map(([id, text, soon]) => {
      const tab = button(text, () => onSelect(id), '', soon ? 'Not available yet' : ''); tab.setAttribute('role', 'tab'); tab.id = `${prefix}-${id}`; tab.dataset.tab = id;
      tab.setAttribute('aria-controls', panelOf(id));
      if (soon) { tab.dataset.available = 'false'; const mark = el('span', 'network-soon', 'soon'); mark.setAttribute('aria-hidden', 'true'); tab.append(mark, el('span', 'sr-only', ', not available yet')); }
      tab.addEventListener('keydown', event => {
        const at = tabs.indexOf(tab), next = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: tabs.length - 1 }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        const target = tabs[(next + tabs.length) % tabs.length];
        onSelect(target.dataset.tab); target.focus();
      });
      return tab;
    });
    list.append(...tabs);
    list.select = id => { for (const tab of tabs) { const on = tab.dataset.tab === id; tab.setAttribute('aria-selected', String(on)); tab.tabIndex = on ? 0 : -1; } };
    return list;
  }

  function create(context) {
    const view = document.querySelector('#network-view'), side = document.querySelector('#network-sidebar-panel');
    if (!view) return null;
    const state = { revision: null, agents: [], total: 0, next: null, capabilities: [], loading: false, loaded: false, error: '' };
    const filters = { q: '', kind: '', provider: '', capability: '', status: '' };
    const fetched = new Map(); // Agents opened by link that the filtered list does not hold.
    // focusDetail: 'phone' after a list choice (the profile replaces the list there), 'always' after registering.
    let visible = false, listVersion = 0, detailVersion = 0, profileTab = 'profile', focusDetail = '', focusRow = null, detailError = null, fetching = null;
    const go = hash => { if (location.hash !== hash) location.hash = hash; else render(); };
    const find = id => state.agents.find(agent => agent.id === id) || fetched.get(id) || null;
    async function request(path, options) {
      const { response, data } = await context.api(path, options);
      if (!response.ok) throw Object.assign(new Error(data.error || 'Network could not complete this request. Nothing was changed.'), { code: data.code, details: data.details });
      return data;
    }

    // ---- The page skeleton, built once; renders replace only the parts that change (app.js keeps #app-error first).
    const heading = el('h1', '', 'Network'); heading.id = 'network-heading';
    const register = button('Register agent', () => openForm(null), 'secondary-button'); register.id = 'network-register';
    const head = el('section', 'base-heading network-heading'), titles = el('div'), headActions = el('div', 'detail-actions');
    titles.append(heading, note('Register Base agents once, then find them here. Their definitions stay in Base.', 'intro-description'));
    headActions.append(register); head.append(titles, headActions);
    const privacy = note('Network keeps references to Base agents in this computer’s data folder. Opening or editing them never runs an agent.', 'note network-privacy');
    const panelOf = id => ({ agents: 'network-panel-agents', graph: 'network-panel-graph', library: 'network-panel-library', activity: 'network-panel-activity', settings: 'network-panel-settings', pipelines: 'network-panel-pipelines' })[id] || 'network-panel-soon';
    const sections = tablist('Network sections', SECTIONS.map(([id, label, soon]) => [id, label, Boolean(soon)]), 'network-tab', panelOf, id => go(hashFor(id)), 'network-tabs');
    const status = note('', 'note network-status'); status.id = 'network-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const alert = el('div', 'inline-error network-alert'); alert.id = 'network-error'; alert.setAttribute('role', 'alert'); alert.hidden = true;
    const say = text => { status.textContent = text; };
    /** An error stays until the next action; a revision conflict offers Reload, which reads the current data again. */
    function showError(failure) {
      const message = failure?.message || failure || '';
      alert.replaceChildren(...(message ? [el('span', '', message)] : []));
      if (failure?.code === 'REVISION_CONFLICT') alert.append(button('Reload', async () => { showError(''); await load(); say('Reloaded the current version. Make your change again.'); }, 'secondary-button network-reload'));
      alert.hidden = !message;
    }

    const search = Object.assign(el('input'), { type: 'search', placeholder: 'Find an agent…', autocomplete: 'off', maxLength: 200 }); search.id = 'network-search';
    const kind = select([['', 'All roles'], ['profile', 'Agents'], ['agentProfile', 'Agent profiles']]); kind.id = 'network-filter-kind';
    const provider = select([['', 'All providers'], ...PROVIDERS]); provider.id = 'network-filter-provider';
    const capability = select([['', 'All capabilities']]); capability.id = 'network-filter-capability';
    const statusFilter = select([['', 'All'], ['enabled', 'Enabled'], ['disabled', 'Disabled'], ['stale', 'Stale']]); statusFilter.id = 'network-filter-status';
    const toolbar = el('div', 'network-toolbar');
    toolbar.append(labelled('Search agents', search, 'field-label network-search'), labelled('Role', kind), labelled('Provider', provider), labelled('Capability', capability), labelled('Status', statusFilter));
    let searchTimer = null;
    search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { if (filters.q !== search.value.trim()) { filters.q = search.value.trim(); void load(); } }, 250); });
    for (const [key, control] of [['kind', kind], ['provider', provider], ['capability', capability], ['status', statusFilter]]) control.addEventListener('change', () => { filters[key] = control.value; void load(); });

    const count = note('', 'note network-count');
    const list = el('ul', 'network-list'); list.id = 'network-list'; list.setAttribute('aria-label', 'Registered agents');
    const empty = el('div', 'network-empty'); empty.id = 'network-empty';
    const more = button('Show more agents', () => load({ append: true }), 'secondary-button network-more'); more.hidden = true;
    const listPanel = el('section', 'network-list-panel'); listPanel.setAttribute('aria-label', 'Agent directory'); listPanel.append(count, list, empty, more);
    const detail = el('section', 'base-detail network-detail'); detail.id = 'network-detail'; detail.setAttribute('aria-label', 'Agent profile');
    const layout = el('div', 'network-layout'); layout.append(listPanel, detail);
    const agentsPanel = el('section', 'network-panel'); agentsPanel.id = 'network-panel-agents'; agentsPanel.setAttribute('role', 'tabpanel'); agentsPanel.setAttribute('aria-labelledby', 'network-tab-agents');
    agentsPanel.append(toolbar, layout);
    const soonPanel = el('section', 'network-panel network-unavailable'); soonPanel.id = 'network-panel-soon'; soonPanel.setAttribute('role', 'tabpanel'); soonPanel.hidden = true;
    // Graph and Library (network-graph.js): the networks, their versions and the editor, beside the same status line.
    const graphs = window.PromptboardNetworkGraph?.create({ request, say, go, showError, openDialog, closeDialog: () => closeDialog(),
      memoryPanel: networkId => memoryView(null, networkId), openAgent: id => go(hashFor('agents', id)) }) || null;
    // Activity (network-activity.js): agents' job status, the open jobs, Kanban runs and the live timeline.
    const activity = window.PromptboardNetworkActivity?.create({ request, say, go, stream: context.stream, openTask: context.openTask,
      openAgent: id => { profileTab = 'activity'; focusDetail = 'always'; go(hashFor('agents', id)); }, onEvent: event => tasksEvent(event), onLive: (state, was) => tasksLive(state, was) }) || null;
    // Settings (network-clients.js): the machine listener and external clients.
    const clients = window.PromptboardNetworkClients?.create({ request, say, showError, projects: context.projects, ensureBoard: context.ensureBoard }) || null;
    // Pipelines (network-pipeline.js): the designer and the run view. `openJob` and `followRun` are optional seams for the
    // Activity drill-down and the live event stream (architecture §21); without them it shows the job as JSON and polls.
    const pipes = window.PromptboardNetworkPipeline?.create({ request, say, go, showError, openDialog, closeDialog: () => closeDialog(), openAgent: id => go(hashFor('agents', id)),
      openJob: context.openJob, followRun: context.followRun }) || null;
    const STREAM_TABS = ['activity', 'tasks']; // The profile tabs that follow the event stream (Tasks reads its list again on job events).
    view.append(head, privacy, sections, status, alert, agentsPanel, soonPanel, ...(graphs ? [graphs.library, graphs.graph] : []), ...(pipes ? [pipes.panel] : []), ...(activity ? [activity.panel] : []), ...(clients ? [clients.panel] : []));

    // The sidebar lists the same sections as links, so the phone drawer and the keyboard both reach them.
    const sideNav = el('nav', 'base-categories network-sections'); sideNav.id = 'network-sections'; sideNav.setAttribute('aria-label', 'Network sections');
    for (const [id, label, soon] of SECTIONS) {
      const link = el('a', 'base-category', label); link.href = hashFor(id); link.dataset.section = id;
      if (soon) { const mark = el('span', 'network-soon', 'soon'); mark.setAttribute('aria-hidden', 'true'); link.append(mark, el('span', 'sr-only', ', not available yet')); }
      sideNav.append(link);
    }
    if (side) { const label = el('div', 'history-label'); label.append(el('span', '', 'NETWORK')); side.append(label, sideNav); }

    // ---- Rendering
    function render() {
      const where = route(), { section } = where;
      // A graph or pipeline with unsaved changes asks first; "keep editing" brings its address back.
      if ((graphs && !graphs.guard(where)) || (pipes && !pipes.guard(where))) return;
      sections.select(section);
      for (const link of sideNav.children) { if (link.dataset.section === section) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); }
      const own = (Boolean(graphs) && ['graph', 'library'].includes(section)) || (Boolean(pipes) && section === 'pipelines'), watching = Boolean(activity) && section === 'activity';
      const settings = Boolean(clients) && section === 'settings';
      agentsPanel.hidden = section !== 'agents'; soonPanel.hidden = section === 'agents' || own || watching || settings;
      register.hidden = section !== 'agents';
      graphs?.show(['graph', 'library'].includes(section) ? where : null);
      pipes?.show(section === 'pipelines' ? where : null);
      activity?.show(watching ? where : null);
      activity?.live(watching || (section === 'agents' && Boolean(where.agentId) && STREAM_TABS.includes(profileTab)));
      clients?.show(settings);
      if (own || watching || settings) return;
      if (section !== 'agents') {
        const [, label, text] = SECTIONS.find(([id]) => id === section);
        soonPanel.setAttribute('aria-labelledby', `network-tab-${section}`);
        soonPanel.replaceChildren(el('h2', '', label), note('Not available yet.', 'note unavailable'), note(text));
        return;
      }
      renderList(); renderDetail();
    }
    function renderList() {
      // Before the first answer nothing is "empty" yet: it is still loading.
      const waiting = !state.loaded && !state.error, current = route().agentId;
      agentsPanel.dataset.view = current ? 'detail' : 'list'; // First: a phone hides the list (and so its focus) in the profile view.
      const focused = list.contains(document.activeElement) ? document.activeElement.dataset.agentId : null;
      listPanel.setAttribute('aria-busy', String(state.loading || waiting));
      list.replaceChildren(...(waiting || state.error ? [] : state.agents.map(agent => row(agent, current))));
      const again = focusRow || focused;
      if (again) { list.querySelector(`[data-agent-id="${again}"]`)?.focus(); focusRow = null; }
      const filtered = Object.values(filters).some(Boolean);
      count.hidden = waiting || Boolean(state.error) || !state.agents.length;
      count.textContent = state.total > state.agents.length ? `${state.agents.length} of ${plural(state.total, 'agent')}` : plural(state.total, 'agent');
      empty.replaceChildren(); empty.hidden = !waiting && !state.error && state.agents.length > 0;
      if (waiting) empty.append(note('Loading agents…'));
      else if (state.error) { const failure = el('p', 'inline-error', `Could not load Network agents. ${state.error}`); failure.setAttribute('role', 'alert'); empty.append(failure, button('Retry', () => load(), 'secondary-button')); }
      else if (!state.agents.length && filtered) empty.append(note('No agents match these filters.'), button('Clear filters', clearFilters, 'secondary-button'));
      else if (!state.agents.length) empty.append(el('p', 'network-empty-title', 'No agents registered yet.'), note('Register an Agent or an Agent profile from Base to find it here and use it in networks. Base keeps its definition.'), button('Register agent', () => openForm(null), 'secondary-button'));
      more.hidden = waiting || Boolean(state.error) || state.next === null;
      const known = new Set([...state.capabilities, filters.capability].filter(Boolean));
      if ([...capability.options].slice(1).map(option => option.value).join('\n') !== [...known].join('\n')) {
        capability.replaceChildren(...select([['', 'All capabilities'], ...[...known].map(value => [value, value])]).children);
        capability.value = filters.capability;
      }
    }
    function row(agent, current) {
      const item = el('li', 'network-row'); item.dataset.state = stateOf(agent);
      const open = button('', () => { focusDetail = 'phone'; go(hashFor('agents', agent.id)); }, 'network-agent'); open.dataset.agentId = agent.id;
      if (agent.id === current) open.setAttribute('aria-current', 'true');
      const text = el('span', 'network-row-text'); text.append(el('strong', '', nameOf(agent)), el('span', 'network-row-sub', subtitle(agent)), statusLine(agent));
      open.append(kindIcon(agent.base.kind), text); item.append(open);
      return item;
    }
    function clearFilters() {
      Object.assign(filters, { q: '', kind: '', provider: '', capability: '', status: '' });
      search.value = ''; kind.value = ''; provider.value = ''; capability.value = ''; statusFilter.value = '';
      void load();
    }

    function renderDetail() {
      const id = route().agentId, focusedId = detail.contains(document.activeElement) ? document.activeElement.id : '';
      for (const open of list.querySelectorAll('[data-agent-id]')) { if (open.dataset.agentId === id) open.setAttribute('aria-current', 'true'); else open.removeAttribute('aria-current'); }
      if (!id) { detail.replaceChildren(el('p', 'base-placeholder', state.agents.length ? 'Choose an agent to see its profile.' : 'A registered agent’s profile appears here.')); return; }
      const agent = find(id);
      if (!agent) {
        if (detailError?.id === id) { detail.replaceChildren(el('p', 'inline-error', detailError.message), button('Back to agents', () => go('#/network'), 'secondary-button')); return; }
        detail.replaceChildren(note('Loading agent…'));
        if (state.loaded && fetching !== id) void fetchAgent(id);
        return;
      }
      detail.replaceChildren(profile(agent));
      if (focusedId) document.getElementById(focusedId)?.focus();
      if (focusDetail === 'always' || (focusDetail && window.innerWidth <= 730)) document.querySelector('#network-detail-heading')?.focus();
      focusDetail = '';
    }
    async function fetchAgent(id) {
      const version = ++detailVersion; fetching = id;
      try { const data = await request(`/api/network/agents/${id}`); if (version === detailVersion) { fetched.set(id, data.agent); detailError = null; } }
      catch (failure) { if (version === detailVersion) detailError = { id, message: failure.message }; }
      if (version !== detailVersion) return;
      fetching = null;
      if (route().agentId === id) renderDetail();
    }
    function backButton() { return button('Back to agents', () => { focusRow = route().agentId; go('#/network'); }, 'text-button network-back'); }

    function profile(agent) {
      const box = el('article', 'network-profile');
      const title = el('h2', '', nameOf(agent)); title.id = 'network-detail-heading'; title.tabIndex = -1;
      const titleBox = el('div', 'network-profile-title');
      titleBox.append(title, note(`${KINDS[agent.base.kind] || 'Missing resource'} in Base: ${agent.base.name || agent.baseResourceId}`), statusLine(agent));
      const top = el('header', 'network-profile-head'); top.append(kindIcon(agent.base.kind), titleBox);
      const toggle = Object.assign(el('input', 'base-switch'), { type: 'checkbox', checked: agent.enabled }); toggle.id = 'network-enabled'; toggle.setAttribute('role', 'switch');
      toggle.addEventListener('change', () => setEnabled(agent, toggle));
      const switchLabel = el('label', 'check-row network-switch'); switchLabel.append(toggle, 'Enabled in Network');
      const edit = button('Edit identity…', () => openForm(agent), 'secondary-button'); edit.id = 'network-edit';
      const openBase = button('Open in Base', () => context.openBase?.(agent.baseResourceId), 'secondary-button'); openBase.id = 'network-open-base';
      const controls = el('div', 'detail-actions network-controls'); controls.append(switchLabel, edit, openBase);
      box.append(backButton(), top, controls);
      if (agent.base.stale) {
        const warning = note(`Stale. ${STALE[agent.base.staleReason] || 'The Base agent cannot be used.'} It cannot take new work until this is fixed in Base.`, 'network-stale'); warning.id = 'network-stale-note';
        box.append(warning);
        // Nothing to open when the resource is gone; the reason above says why.
        if (agent.base.staleReason === 'missing') { openBase.disabled = true; openBase.setAttribute('aria-describedby', warning.id); openBase.title = 'The Base agent no longer exists.'; }
      }
      const panelId = id => `network-profile-panel-${id}`;
      const inner = tablist('Agent profile sections', PROFILE_TABS.map(([id, label, soon]) => [id, label, Boolean(soon)]), 'network-profile-tab', panelId, id => { profileTab = id; showInner(); }, 'network-profile-tabs');
      const panels = PROFILE_TABS.map(([id, label, soon]) => {
        const panel = el('section', 'network-profile-panel'); panel.id = panelId(id); panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `network-profile-tab-${id}`);
        if (soon) panel.append(el('h3', '', label), note('Not available yet.', 'note unavailable'), note(soon));
        else panel.append(...(id === 'memory' ? [memoryView(agent)] : id === 'posts' ? [postsView(agent)] : id === 'tasks' ? [tasksView(agent)] : id === 'activity' ? (activity ? [activity.agentPanel(agent)] : []) : profileSections(agent)));
        return panel;
      });
      function showInner() { inner.select(profileTab); for (const panel of panels) panel.hidden = panel.id !== panelId(profileTab); activity?.live(STREAM_TABS.includes(profileTab)); openTab(); }
      showInner();
      box.append(inner, ...panels);
      return box;
    }
    function profileSections(agent) {
      const base = agent.base, caps = agent.providerCapabilities || {};
      const projectNames = new Map(context.projects().map(project => [project.id, project.name]));
      const projects = agent.projectAllowlist.map(id => (agent.missingProjects.includes(id) ? `${id} (not on this board)` : projectNames.get(id) || id));
      const networks = el('span', '', agent.networks.length ? plural(agent.networks.length, 'network') : 'Not in a network yet.');
      if (agent.networks.length) void networkNames(agent.id).then(list => { if (list.length) networks.textContent = list.map(item => item.name).join(', '); }, () => {});
      const sections = [facts([
        ['Network ID', el('code', '', agent.id)],
        ['Base resource', base.kind ? `${base.name} · ${KINDS[base.kind] || base.kind} · revision ${base.revision}` : `Missing (${agent.baseResourceId})`],
        ['Provider', PROVIDER_NAMES[base.provider] || (base.provider ? base.provider : 'Not set in Base')],
        ['Model', base.model || (base.kind ? 'CLI default' : 'Unknown')],
        ['Effort', base.effort || (base.kind ? 'CLI default' : 'Unknown')],
        ['In Base', base.kind ? `${base.enabled ? 'Switched on' : 'Switched off'} · ${base.trust === 'trusted' ? 'trusted' : base.trust === 'revoked' ? 'trust revoked' : 'not trusted'} · ${base.usedBy ? `used in ${plural(base.usedBy, 'place')}` : 'not used elsewhere in Base'}` : 'Not found'],
        ['Tags', chips(agent.tags, 'None')],
        ['Capabilities', chips(agent.capabilities, 'None declared')],
        ['Projects', projects.length ? projects.join(', ') : 'None: it serves no project data.'],
        ['Networks', networks],
        ['Updated', ago(agent.updatedAt)],
      ])];
      const instructions = base.instructions || { summary: '', chars: 0 };
      sections.push(el('h3', '', 'Instructions from Base'), note(instructions.summary || 'No instructions in Base.', 'network-instructions'));
      if (instructions.chars > instructions.summary.length) sections.push(note(`The start of ${instructions.chars.toLocaleString('en-US')} characters. Read or change them in Base.`));
      sections.push(el('h3', '', 'Provider capabilities'));
      sections.push(note(caps.known ? `What ${PROVIDER_NAMES[caps.provider]} can report and enforce for Network. Unknown means Promptboard has no evidence.` : 'No known provider is set in Base, so every capability is unknown.'));
      const capabilityList = el('ul', 'network-capabilities');
      for (const [key, label] of CAPABILITIES) {
        const [text, tone] = VALUES[caps[key]] || VALUES.unknown, item = el('li');
        item.append(el('span', '', label), el('small', `base-status${tone ? ` tone-${tone}` : ' network-unknown'}`, text)); capabilityList.append(item);
      }
      sections.push(capabilityList);
      const tools = caps.jobTools === null || caps.jobTools === undefined ? 'Unknown until a provider is set in Base.' : caps.jobTools.length ? caps.jobTools.map(mode => ({ none: 'No tools', web: 'Web search' })[mode] || mode).join(', ') : 'None: this CLI is refused for Network jobs.';
      const reason = blocked(agent);
      sections.push(el('h3', '', 'Allowed operations'), facts([
        ['New work', reason ? `Refused. ${reason}` : caps.jobTools?.length ? 'Allowed: run a job from Tasks. It runs on this computer with your signed-in CLI.' : 'Refused: Network jobs cannot run this agent’s CLI.'],
        ['Job tools', tools],
        ['Files', 'Read only. Network jobs never change files.'],
        ['Project data', projects.length ? `Only ${projects.join(', ')}` : 'None'],
        ['Memory', 'Only notes you approved, at most 8,000 characters per job. Project lessons only for a listed project, and only when the job allows them.'],
        ['Visibility', 'Private: this computer and your paired devices.'],
      ]));
      return sections;
    }
    const names = new Map(); // agentId → its networks ({ id, name }), read once per page visit.
    function networkNames(id) {
      if (!names.has(id)) names.set(id, request(`/api/network/networks?agentId=${id}&archived=true&limit=200`).then(data => data.networks.map(({ id: networkId, name }) => ({ id: networkId, name }))).catch(failure => { names.delete(id); throw failure; }));
      return names.get(id);
    }

    // ---- Memory: the agent's notes. Each starts as a proposal; only approved ones can reach a job. Every change names the
    // record revision shown here, so a note changed elsewhere is never approved unseen (the server answers 409; Reload).
    // `id` is the agent's or the network's ID and `path` its route; only an agent's memory has the job preview.
    const memory = { id: null, path: '', agent: null, key: '', data: null, error: null, loading: false, version: 0, focus: null, q: '', status: '', open: new Set(),
      preview: null, previewError: '', previewKey: null, previewVersion: 0, project: '', lessons: false, network: '' };
    const memoryRoot = el('section', 'network-memory'); memoryRoot.setAttribute('aria-label', 'Memory');
    const memorySearch = Object.assign(el('input'), { type: 'search', placeholder: 'Find in memory…', autocomplete: 'off', maxLength: 200 }); memorySearch.id = 'network-memory-search';
    const memoryStatus = select([['', 'All'], ['approved', 'Approved'], ['proposed', 'Proposed'], ['rejected', 'Rejected']]); memoryStatus.id = 'network-memory-status';
    const memoryAdd = button('Add memory…', () => memoryForm(null), 'secondary-button'); memoryAdd.id = 'network-memory-add';
    const memoryTools = el('div', 'network-memory-tools'); memoryTools.append(labelled('Search memory', memorySearch), labelled('Status', memoryStatus), memoryAdd);
    const memoryCounts = note('', 'note network-memory-counts');
    const memoryAlert = el('div', 'inline-error network-alert'); memoryAlert.id = 'network-memory-error'; memoryAlert.setAttribute('role', 'alert'); memoryAlert.hidden = true;
    const memoryList = el('ul', 'network-records'); memoryList.id = 'network-memory-list'; memoryList.setAttribute('aria-label', 'Memory records');
    const memoryEmpty = el('div', 'network-empty'); memoryEmpty.id = 'network-memory-empty';
    const memoryMore = button('Show more records', () => loadMemory({ append: true }), 'secondary-button network-more'); memoryMore.hidden = true;
    const previewProject = select([['', 'No project']]); previewProject.id = 'network-preview-project';
    const previewLessons = Object.assign(el('input'), { type: 'checkbox' }); previewLessons.id = 'network-preview-lessons';
    const previewNetwork = select([['', 'No network']]); previewNetwork.id = 'network-preview-network';
    const lessonsRow = el('label', 'check-row'); lessonsRow.append(previewLessons, 'Allow the project’s approved lessons');
    const previewControls = el('div', 'network-preview-controls'); previewControls.append(labelled('Project of the job', previewProject), labelled('Network it runs in', previewNetwork), lessonsRow);
    const previewReasons = el('ul', 'network-reasons'); previewReasons.id = 'network-preview-reasons'; previewReasons.setAttribute('aria-label', 'What is included and why');
    const previewText = el('pre', 'network-preview-text'); previewText.id = 'network-preview-text'; previewText.tabIndex = 0; previewText.setAttribute('aria-label', 'Exact text a job would receive');
    const previewSize = note('', 'note network-preview-size'); previewSize.id = 'network-preview-size';
    const previewBox = el('div', 'network-preview'); previewBox.setAttribute('aria-live', 'polite'); previewBox.append(previewReasons, previewText, previewSize);
    const memoryIntro = note('');
    const previewSection = el('div', 'network-preview-section');
    previewSection.append(el('h3', '', 'What a job would receive'), note('The exact text added to a job’s prompt for this agent, and why each part is in it or not. Nothing runs here.'), previewControls, previewBox);
    memoryRoot.append(el('h3', '', 'Memory'), memoryIntro, memoryTools, memoryCounts, memoryAlert, memoryList, memoryEmpty, memoryMore, previewSection);
    let memoryTimer = null;
    memorySearch.addEventListener('input', () => { clearTimeout(memoryTimer); memoryTimer = setTimeout(() => { if (memory.q !== memorySearch.value.trim()) { memory.q = memorySearch.value.trim(); void loadMemory(); } }, 250); });
    memoryStatus.addEventListener('change', () => { memory.status = memoryStatus.value; void loadMemory(); });
    for (const control of [previewProject, previewLessons, previewNetwork]) control.addEventListener('change', () => {
      Object.assign(memory, { project: previewProject.value, lessons: previewLessons.checked, network: previewNetwork.value }); void loadPreview();
    });

    /**
     * The Memory panel of `agent`, or of the network `networkId` (Library), as one node kept across renders, so search
     * text and focus survive a list reload. A network's memory has no preview: it reaches a job only through an agent.
     */
    function memoryView(agent, networkId) {
      const id = agent ? agent.id : networkId;
      if (memory.id !== id) {
        Object.assign(memory, { id, path: `/api/network/${agent ? 'agents' : 'networks'}/${id}`, data: null, error: null, loading: false, focus: null, q: '', status: '', open: new Set(), preview: null, previewError: '', previewKey: null, project: '', lessons: false, network: '' });
        memory.version++; memory.previewVersion++; memorySearch.value = ''; memoryStatus.value = ''; memoryAlert.hidden = true;
      }
      memoryIntro.textContent = agent ? 'Notes this agent can be given in a Network job. You approve each one before any job receives it, and it is given as reference data, never as instructions. Project memory stays with each Kanban project.'
        : 'Notes about this network. You approve each one; a job of one of its agents receives approved notes only when it runs in this network and asks for network memory, as reference data, never as instructions.';
      previewSection.hidden = !agent; memory.agent = agent;
      if (!agent) { renderMemory(); if (!memory.data && !memory.loading && !memory.error) void loadMemory(); return memoryRoot; }
      // What decides the preview: a change of the registration (on/off, projects, networks) or of its Base agent.
      memory.key = JSON.stringify([agent.id, agent.revision, agent.enabled, agent.base.stale, agent.networks, agent.projectAllowlist]);
      previewOptions(agent); renderMemory(); renderPreview();
      return memoryRoot;
    }
    function openTab() {
      if (profileTab === 'memory' && memory.agent) { if (!memory.data && !memory.loading) void loadMemory(); if (memory.previewKey !== memory.key) void loadPreview(); }
      if (profileTab === 'posts' && posts.agentId && !posts.data && !posts.loading) void loadPosts();
      if (profileTab === 'tasks' && tasks.agent) { if (!tasks.loading) void loadJobs(); if (tasks.previewKey !== jobPreviewKey()) void loadJobPreview(); }
      else stopPolling();
      if (profileTab === 'activity') activity?.loadAgent();
    }
    async function loadMemory({ append = false } = {}) {
      const version = ++memory.version;
      memory.loading = true; renderMemory();
      const params = new URLSearchParams({ limit: '200', offset: String(append ? memory.data.records.length : 0) });
      if (memory.q) params.set('q', memory.q); if (memory.status) params.set('status', memory.status);
      try {
        const data = await request(`${memory.path}/memory?${params}`);
        if (version === memory.version) { memory.data = append ? { ...data, records: [...memory.data.records, ...data.records] } : data; memory.error = null; }
      } catch (failure) { if (version === memory.version) { if (append) memoryFailure(failure); else Object.assign(memory, { data: null, error: failure }); } }
      finally { if (version === memory.version) { memory.loading = false; renderMemory(); } }
    }
    const refreshMemory = async () => { await loadMemory(); if (memory.agent) await loadPreview(); };
    function renderMemory() {
      const data = memory.data, waiting = !data && !memory.error, active = document.activeElement, keep = memoryList.contains(active) ? active.id : '';
      memoryList.setAttribute('aria-busy', String(memory.loading || waiting));
      memoryCounts.hidden = !data;
      if (data) memoryCounts.textContent = `${data.counts.approved} approved · ${data.counts.proposed} proposed · ${data.counts.rejected} rejected`;
      memoryList.replaceChildren(...(data ? data.records.map(recordItem) : []));
      memoryEmpty.replaceChildren(); memoryEmpty.hidden = Boolean(data?.records.length);
      if (waiting) memoryEmpty.append(note('Loading memory…'));
      else if (memory.error) { const failure = el('p', 'inline-error', `Could not load this memory. ${memory.error.message}`); failure.setAttribute('role', 'alert'); memoryEmpty.append(failure, button('Retry', () => loadMemory(), 'secondary-button')); }
      else if (!data.records.length && (memory.q || memory.status)) memoryEmpty.append(note('No records match.'), button('Clear search', () => { memory.q = ''; memory.status = ''; memorySearch.value = ''; memoryStatus.value = ''; void loadMemory(); }, 'secondary-button'));
      else if (!data.records.length) memoryEmpty.append(el('p', 'network-empty-title', 'No memory yet.'), note('Add facts, preferences or procedures this agent should know. Approve them before any job may use them.'));
      memoryMore.hidden = !data || data.next === null;
      // Focus follows the record an action changed (its first action) once the list is read again, or stays where it was;
      // a deleted record's focus goes to Add.
      if (memory.focus && data && !memory.loading) { const id = memory.focus; memory.focus = null; (document.querySelector(`#network-memory-${id} .network-record-actions button`) || memoryAdd).focus(); }
      else if (keep) document.getElementById(keep)?.focus();
    }
    function recordItem(record) {
      const item = el('li', 'lesson network-record'); item.id = `network-memory-${record.id}`; item.dataset.id = record.id; item.dataset.status = record.status;
      const [stateText, tone] = MEMORY_STATES[record.status], head = el('div', 'lesson-head');
      head.append(el('span', 'lesson-kind', KIND_NAMES[record.kind] || record.kind), el('small', `base-status tone-${tone}`, stateText));
      const text = el('p', 'lesson-text network-record-text', record.text); text.id = `network-memory-${record.id}-text`;
      const when = record.status === 'proposed' ? `proposed ${ago(record.createdAt)}` : `${stateText.toLowerCase()} ${ago(record.decidedAt)}`;
      const meta = note(`Written by you · ${when}${record.editedAt ? ` · edited ${ago(record.editedAt)}` : ''} · revision ${record.revision}`, 'note network-record-meta');
      const actions = el('div', 'network-record-actions');
      const act = (label, run, name) => {
        const node = button(label, async () => { node.disabled = true; try { await run(); } finally { node.disabled = false; } }, 'text-button');
        node.id = `network-memory-${record.id}-${name}`; node.setAttribute('aria-describedby', text.id);
        return node;
      };
      if (record.status !== 'approved') actions.append(act('Approve', () => decide(record, 'approve'), 'approve'));
      if (record.status !== 'rejected') actions.append(act(record.status === 'approved' ? 'Withdraw' : 'Reject', () => decide(record, 'reject'), 'reject'));
      actions.append(act('Edit…', () => memoryForm(record), 'edit'), act('Delete…', () => deleteRecord(record), 'delete'));
      const history = el('details', 'network-history'); history.open = memory.open.has(record.id);
      history.addEventListener('toggle', () => { if (history.open) memory.open.add(record.id); else memory.open.delete(record.id); });
      const steps = el('ol', 'network-history-list');
      for (const entry of [...record.history].reverse()) {
        const step = el('li', '', `${HISTORY[entry.action] || entry.action} ${ago(entry.at)} · revision ${entry.revision}`);
        if (entry.previous) step.append(el('span', 'network-history-before', `Before (${KIND_NAMES[entry.previous.kind] || entry.previous.kind}): ${entry.previous.text}`));
        steps.append(step);
      }
      history.append(el('summary', '', `History (${record.history.length})`), steps);
      item.append(head, text, meta, actions, history);
      return item;
    }
    /** A refused change: its message; a conflict or a gone record offers Reload, which reads the memory again. */
    function memoryFailure(failure) {
      memoryAlert.replaceChildren(el('span', '', failure.message));
      if (['REVISION_CONFLICT', 'MEMORY_STATE', 'NOT_FOUND'].includes(failure.code)) memoryAlert.append(button('Reload', async () => { memoryAlert.hidden = true; await refreshMemory(); say('Reloaded the current memory. Make your change again.'); }, 'secondary-button network-reload'));
      memoryAlert.hidden = false;
    }
    async function decide(record, decision) {
      memoryAlert.hidden = true;
      try {
        await request(`${memory.path}/memory/${record.id}/approve`, { method: 'POST', body: { expectedRevision: record.revision, decision } });
        say(decision === 'approve' ? `Approved. ${memory.agent ? 'Jobs of this agent' : 'Jobs that run in this network and ask for its memory'} may now receive it.` : 'No job receives it now.');
        memory.focus = record.id; await refreshMemory();
      } catch (failure) { memoryFailure(failure); }
    }
    /** Add (a proposal) or edit one record in the dialog. A conflict closes nothing until Reload shows the current version. */
    function memoryForm(record) {
      const form = el('form', 'network-form'); form.noValidate = true;
      const kind = select(MEMORY_KINDS); kind.id = 'network-memory-form-kind'; kind.value = record?.kind || 'fact';
      const text = Object.assign(el('textarea'), { rows: 7, maxLength: 4000, value: record?.text || '' }); text.id = 'network-memory-form-text';
      const count = note('', 'note network-chars'); const counted = () => { count.textContent = `${text.value.length.toLocaleString('en-US')} of 4,000 characters`; }; counted();
      text.addEventListener('input', counted);
      form.append(labelled('Kind', kind), labelled('Text', text), count,
        note(!record ? 'Saved as a proposal. Approve it before any job may receive it.' : record.status === 'approved' ? 'It stays approved; the earlier text is kept in its history.' : 'Its status stays as it is; the earlier text is kept in its history.'),
        note('Local folders are cut to their last name and secret-looking values are masked before saving.'));
      const failure = el('div', 'inline-error'); failure.setAttribute('role', 'alert'); failure.hidden = true;
      const submit = el('button', 'dialog-done', record ? 'Save' : 'Propose'); submit.type = 'submit'; submit.id = 'network-memory-form-submit';
      const footer = el('div', 'kanban-dialog-actions'); footer.append(button('Cancel', closeDialog, 'secondary-button'), submit);
      form.append(failure, footer);
      form.addEventListener('submit', async event => {
        event.preventDefault(); submit.disabled = true; failure.hidden = true;
        try {
          const data = record
            ? await request(`${memory.path}/memory/${record.id}`, { method: 'PATCH', body: { expectedRevision: record.revision, kind: kind.value, text: text.value } })
            : await request(`${memory.path}/memory`, { method: 'POST', body: { expectedRevision: memory.data?.revision ?? 0, kind: kind.value, text: text.value } });
          closeDialog(); say(record ? 'Saved the memory record.' : 'Proposed. Approve it when it is right.');
          memory.focus = data.record.id; await refreshMemory();
        } catch (error) {
          failure.replaceChildren(el('span', '', error.message)); failure.hidden = false;
          if (['REVISION_CONFLICT', 'NOT_FOUND'].includes(error.code)) failure.append(button('Reload', async () => { closeDialog(); await refreshMemory(); say('Reloaded the current memory. Make your change again.'); }, 'secondary-button network-reload'));
        } finally { submit.disabled = false; }
      });
      openDialog(record ? 'Edit memory' : 'Add memory', [form]);
      text.focus();
    }
    function deleteRecord(record) {
      confirmDialog('Delete memory?', [note(`“${clip(record.text, 200)}”`, 'note network-quote'), note('Jobs stop receiving it. It is deleted for good, with its history.')], async () => {
        await request(`${memory.path}/memory/${record.id}`, { method: 'DELETE', body: { expectedRevision: record.revision } });
        say('Deleted the memory record.'); memory.focus = record.id; opener = memoryAdd;
      }, refreshMemory);
    }
    function previewOptions(agent) {
      const options = [['', 'No project'], ...context.projects().map(project => [project.id, agent.projectAllowlist.includes(project.id) ? project.name : `${project.name} (not on its project list)`])];
      if (!options.some(([id]) => id === memory.project)) memory.project = '';
      previewProject.replaceChildren(...select(options).children); previewProject.value = memory.project;
      previewLessons.checked = memory.lessons;
      const fill = list => { previewNetwork.replaceChildren(...select([['', 'No network'], ...list]).children); if (!list.some(([id]) => id === memory.network)) memory.network = ''; previewNetwork.value = memory.network; };
      fill(agent.networks.map(id => [id, id]));
      if (agent.networks.length) void networkNames(agent.id).then(list => { if (memory.id === agent.id) fill(list.map(item => [item.id, item.name])); }, () => {});
    }
    async function loadPreview() {
      const agentId = memory.id, key = memory.key, version = ++memory.previewVersion;
      const params = new URLSearchParams({ memory: memory.network ? 'agent+network' : 'agent', projectLessons: String(memory.lessons) });
      if (memory.project) params.set('projectId', memory.project); if (memory.network) params.set('networkId', memory.network);
      previewBox.setAttribute('aria-busy', 'true');
      try { const data = await request(`/api/network/agents/${agentId}/memory/preview?${params}`); if (version === memory.previewVersion) Object.assign(memory, { preview: data, previewError: '', previewKey: key }); }
      catch (failure) { if (version === memory.previewVersion) Object.assign(memory, { preview: null, previewError: failure.message, previewKey: key }); }
      if (version === memory.previewVersion) { previewBox.setAttribute('aria-busy', 'false'); renderPreview(); }
    }
    /** Each part of the block: [included, why], in words. */
    function reasons(preview) {
      const access = preview.access, count = kind => preview.memory.included.filter(item => item.scope.kind === kind).length;
      if (access.blocked) return [[false, access.blocked === 'REGISTRATION_DISABLED' ? 'Nothing: this registration is switched off in Network, so no job can start.' : 'Nothing: its Base agent cannot be used (stale), so no job can start.']];
      const project = context.projects().find(item => item.id === preview.request.projectId)?.name || preview.request.projectId;
      return [
        access.agent === 'allowed' ? [count('agent') > 0, count('agent') ? `This agent’s approved memory: ${plural(count('agent'), 'record')}.` : 'This agent’s approved memory: nothing approved yet.'] : [false, 'This agent’s memory: not asked for.'],
        { 'not-requested': [false, 'Network memory: only when the job runs in one of this agent’s networks.'], 'not-a-member': [false, 'Network memory: this agent is not in that network.'],
          allowed: [count('network') > 0, `Memory of the network “${preview.network?.name}”: ${count('network') ? plural(count('network'), 'record') : 'nothing approved yet'}.`] }[access.network],
        { 'no-project': [false, 'Project lessons: no project chosen.'], 'not-permitted': [false, `Project lessons of ${project}: not given unless the job allows them.`],
          'project-not-allowed': [false, `Project lessons of ${project}: never given, because the project is not on this agent’s project list.`], 'project-missing': [false, `Project lessons of ${project}: the project is no longer on the board.`],
          allowed: [preview.lessons.chars > 0, preview.lessons.chars ? `Project lessons of ${project}: its approved lessons, read from Project memory (unchanged).` : `Project lessons of ${project}: none approved yet.`] }[access.lessons],
        ...(preview.memory.omitted ? [[false, `${plural(preview.memory.omitted, 'older approved record')} left out: memory is limited to ${preview.memory.limit.toLocaleString('en-US')} characters, newest first.`]] : []),
      ];
    }
    function renderPreview() {
      const preview = memory.preview;
      previewReasons.replaceChildren(...(preview ? reasons(preview) : []).map(([included, text]) => {
        const item = el('li', included ? 'is-in' : 'is-out'); const mark = el('span', 'network-reason-mark', included ? '✓' : '–'); mark.setAttribute('aria-hidden', 'true');
        item.append(mark, el('span', 'sr-only', included ? 'Included: ' : 'Not included: '), text); return item;
      }));
      if (!preview && memory.previewError) previewReasons.replaceChildren(Object.assign(el('li', 'inline-error'), { textContent: `Could not build the preview. ${memory.previewError}` }));
      previewText.textContent = preview?.text || ''; previewText.hidden = !preview?.text;
      previewSize.textContent = !preview ? (memory.previewError ? '' : 'Loading the preview…') : preview.text ? `${preview.chars.toLocaleString('en-US')} characters in all (memory ${preview.memory.chars.toLocaleString('en-US')} of ${preview.memory.limit.toLocaleString('en-US')}).` : 'Nothing would be added to the job’s prompt.';
      previewLessons.disabled = !memory.project; previewLessons.title = memory.project ? '' : 'Choose a project first.';
    }

    // ---- Tasks: this agent's Network jobs. "Run a job" asks for a confirmation that says what the job may use; the list reads
    // the job routes again while the tab shows it: on the event stream's job events while that is live, otherwise by polling.
    // A job only reads: the local worker gives it an empty folder of its own, never a project or a repository.
    const tasks = { agent: null, data: null, error: null, loading: false, version: 0, timer: null, requests: new Map(), results: new Map(), open: new Set(),
      preview: null, previewError: '', previewKey: null, previewVersion: 0, timeoutMinutes: null, focus: null };
    const tasksRoot = el('section', 'network-tasks'); tasksRoot.setAttribute('aria-label', 'Tasks');
    const jobForm = el('form', 'network-form network-job-form'); jobForm.id = 'network-job-form'; jobForm.noValidate = true; jobForm.setAttribute('aria-label', 'Run a job');
    const jobInput = Object.assign(el('textarea'), { rows: 5, maxLength: 262144, placeholder: 'For example: Summarise these release notes in three bullet points…' }); jobInput.id = 'network-job-input';
    const jobChars = note('', 'note network-chars');
    const jobTools = select([['none', 'No tools'], ['web', 'Web search (read only)']]); jobTools.id = 'network-job-tools';
    const jobProject = select([['', 'No project']]); jobProject.id = 'network-job-project';
    const jobNetwork = select([['', 'No network']]); jobNetwork.id = 'network-job-network';
    const jobMemory = Object.assign(el('input'), { type: 'checkbox', checked: true }); jobMemory.id = 'network-job-memory';
    const jobLessons = Object.assign(el('input'), { type: 'checkbox' }); jobLessons.id = 'network-job-lessons';
    const jobTimeout = Object.assign(el('input'), { type: 'number', min: 1, max: 120, step: 1, value: '20', inputMode: 'numeric' }); jobTimeout.id = 'network-job-timeout';
    const memoryRow = el('label', 'check-row'); memoryRow.append(jobMemory, 'Give it this agent’s approved memory');
    const jobLessonsRow = el('label', 'check-row'); jobLessonsRow.append(jobLessons, 'Allow the project’s approved lessons');
    const jobOptions = el('div', 'network-preview-controls network-job-options');
    jobOptions.append(labelled('Tools', jobTools), labelled('Time limit (minutes)', jobTimeout), labelled('Project (optional)', jobProject), labelled('Network (optional)', jobNetwork), memoryRow, jobLessonsRow);
    const jobReasons = el('ul', 'network-reasons'); jobReasons.id = 'network-job-reasons'; jobReasons.setAttribute('aria-label', 'What is included and why');
    const jobPreviewText = el('pre', 'network-preview-text'); jobPreviewText.id = 'network-job-preview-text'; jobPreviewText.tabIndex = 0; jobPreviewText.setAttribute('aria-label', 'Exact memory text the job would receive');
    const jobPreview = el('details', 'network-job-preview'); jobPreview.id = 'network-job-preview';
    jobPreview.append(el('summary', '', 'What it receives besides your text'), jobReasons, jobPreviewText);
    const jobBlocked = note('', 'network-stale network-job-blocked'); jobBlocked.id = 'network-job-blocked'; jobBlocked.hidden = true;
    const jobFormError = el('div', 'inline-error'); jobFormError.id = 'network-job-form-error'; jobFormError.setAttribute('role', 'alert'); jobFormError.hidden = true;
    const jobRun = el('button', 'secondary-button network-primary', 'Run job…'); jobRun.type = 'submit'; jobRun.id = 'network-job-run';
    const jobFoot = el('div', 'network-job-foot'); jobFoot.append(note('It only reads: an empty folder of its own, never a project, a repository or other files.'), jobRun);
    jobForm.append(jobBlocked, labelled('What should it do?', jobInput), jobChars, jobOptions, jobPreview, jobFormError, jobFoot);
    const jobAlert = el('div', 'inline-error network-alert'); jobAlert.id = 'network-job-error'; jobAlert.setAttribute('role', 'alert'); jobAlert.hidden = true;
    const jobWorker = note('', 'network-stale'); jobWorker.hidden = true;
    const jobList = el('ul', 'network-records network-jobs'); jobList.id = 'network-job-list'; jobList.setAttribute('aria-label', 'Jobs of this agent');
    const jobEmpty = el('div', 'network-empty'); jobEmpty.id = 'network-job-empty';
    const jobMore = button('Show more jobs', () => loadJobs({ more: true }), 'secondary-button network-more'); jobMore.hidden = true;
    tasksRoot.append(el('h3', '', 'Run a job'), note('Give this agent one piece of work. You confirm before it starts; it runs on this computer with your signed-in CLI.'), jobForm,
      el('h3', '', 'Jobs'), jobWorker, jobAlert, jobList, jobEmpty, jobMore);
    const counted = () => { jobChars.textContent = `${jobInput.value.length.toLocaleString('en-US')} characters`; };
    jobInput.addEventListener('input', counted); counted();
    let jobPreviewTimer = null;
    for (const control of [jobProject, jobNetwork, jobMemory, jobLessons]) control.addEventListener('change', () => { renderJobForm(); clearTimeout(jobPreviewTimer); jobPreviewTimer = setTimeout(() => void loadJobPreview(), 150); });
    jobForm.addEventListener('submit', event => { event.preventDefault(); confirmJob(); });

    /** The Tasks panel of `agent`, one node kept across renders (the typed text, choices and open details survive a reload). */
    function tasksView(agent) {
      if (tasks.agent?.id !== agent.id) {
        stopPolling();
        Object.assign(tasks, { data: null, error: null, loading: false, requests: new Map(), results: new Map(), open: new Set(), preview: null, previewError: '', previewKey: null, focus: null });
        tasks.version++; tasks.previewVersion++;
        jobInput.value = ''; counted(); jobFormError.hidden = true; jobAlert.hidden = true; jobProject.value = ''; jobNetwork.value = ''; jobMemory.checked = true; jobLessons.checked = false; jobTools.value = 'none';
      }
      tasks.agent = agent;
      jobChoices(agent); renderJobForm(); renderJobs();
      return tasksRoot;
    }
    const jobBlockedReason = agent => blocked(agent) || (agent.providerCapabilities?.jobTools?.length ? '' : agent.providerCapabilities?.known ? `Network jobs cannot run ${PROVIDER_NAMES[agent.base.provider] || 'this CLI'}: it cannot be held to read-only work.` : 'No CLI is set for this agent in Base, so it cannot run jobs.');
    function jobChoices(agent) {
      const projects = context.projects(), keep = jobProject.value;
      jobProject.replaceChildren(...select([['', 'No project'], ...projects.map(project => [project.id, agent.projectAllowlist.includes(project.id) ? project.name : `${project.name} (not on its project list)`])]).children);
      jobProject.value = projects.some(project => project.id === keep) ? keep : '';
      const fill = list => { const value = jobNetwork.value; jobNetwork.replaceChildren(...select([['', 'No network'], ...list]).children); jobNetwork.value = list.some(([id]) => id === value) ? value : ''; };
      fill(agent.networks.map(id => [id, id]));
      if (agent.networks.length) void networkNames(agent.id).then(list => { if (tasks.agent?.id === agent.id) fill(list.map(item => [item.id, item.name])); }, () => {});
      const web = jobTools.querySelector('option[value="web"]'), webOk = agent.providerCapabilities?.jobTools?.includes('web');
      web.disabled = !webOk; web.textContent = webOk ? 'Web search (read only)' : `Web search (not available for ${PROVIDER_NAMES[agent.base.provider] || 'this CLI'})`;
      if (!webOk) jobTools.value = 'none';
      if (tasks.timeoutMinutes === null) void request('/api/network/settings').then(data => { tasks.timeoutMinutes = Math.round(data.settings.defaultTimeoutMs / 60000); if (!jobTimeout.dataset.touched) jobTimeout.value = String(tasks.timeoutMinutes); }, () => {});
    }
    jobTimeout.addEventListener('input', () => { jobTimeout.dataset.touched = 'true'; });
    /** What the job asks for, from the form: the same question the memory preview answers. */
    function jobAsk() {
      const projectId = jobProject.value || null, networkId = jobNetwork.value || null;
      return { projectId, networkId, memory: !jobMemory.checked ? 'none' : networkId ? 'agent+network' : 'agent', projectLessons: Boolean(projectId) && jobLessons.checked };
    }
    const jobPreviewKey = () => tasks.agent && JSON.stringify([tasks.agent.id, tasks.agent.revision, tasks.agent.enabled, tasks.agent.base.stale, jobAsk()]);
    function renderJobForm() {
      const agent = tasks.agent, reason = agent ? jobBlockedReason(agent) : '';
      jobBlocked.hidden = !reason; jobBlocked.textContent = reason ? `No new job can start. ${reason}` : '';
      for (const control of [jobInput, jobTools, jobProject, jobNetwork, jobMemory, jobLessons, jobTimeout, jobRun]) {
        control.disabled = Boolean(reason);
        if (reason) control.setAttribute('aria-describedby', jobBlocked.id); else control.removeAttribute('aria-describedby');
      }
      if (!reason) { jobLessons.disabled = !jobProject.value; jobLessons.title = jobProject.value ? '' : 'Choose a project first.'; }
      if (!jobProject.value) jobLessons.checked = false;
      const preview = tasks.preview;
      jobReasons.replaceChildren(...(preview ? reasons(preview) : []).map(([included, text]) => {
        const item = el('li', included ? 'is-in' : 'is-out'); const mark = el('span', 'network-reason-mark', included ? '✓' : '–'); mark.setAttribute('aria-hidden', 'true');
        item.append(mark, el('span', 'sr-only', included ? 'Included: ' : 'Not included: '), text); return item;
      }));
      if (!preview && tasks.previewError) jobReasons.replaceChildren(Object.assign(el('li', 'inline-error'), { textContent: `Could not build the preview. ${tasks.previewError}` }));
      else if (!preview) jobReasons.replaceChildren(el('li', 'is-out', 'Loading…'));
      jobPreviewText.textContent = preview?.text || ''; jobPreviewText.hidden = !preview?.text;
    }
    async function loadJobPreview() {
      if (!tasks.agent) return;
      const agentId = tasks.agent.id, key = jobPreviewKey(), version = ++tasks.previewVersion, ask = jobAsk();
      const params = new URLSearchParams({ memory: ask.memory, projectLessons: String(ask.projectLessons) });
      if (ask.projectId) params.set('projectId', ask.projectId); if (ask.networkId) params.set('networkId', ask.networkId);
      try { const data = await request(`/api/network/agents/${agentId}/memory/preview?${params}`); if (version === tasks.previewVersion) Object.assign(tasks, { preview: data, previewError: '', previewKey: key }); }
      catch (failure) { if (version === tasks.previewVersion) Object.assign(tasks, { preview: null, previewError: failure.message, previewKey: key }); }
      if (version === tasks.previewVersion && tasks.agent?.id === agentId) renderJobForm();
    }
    /** The confirmation: everything the job may use, said before it starts. Nothing is sent until "Run job". */
    function confirmJob() {
      const agent = tasks.agent, text = jobInput.value.trim(), minutes = Number(jobTimeout.value);
      jobFormError.hidden = true;
      const problem = !text ? 'Write what the job should do.' : !Number.isInteger(minutes) || minutes < 1 || minutes > 120 ? 'Choose a time limit from 1 to 120 minutes.' : '';
      if (problem) { jobFormError.replaceChildren(el('span', '', problem)); jobFormError.hidden = false; (text ? jobTimeout : jobInput).focus(); return; }
      const ask = jobAsk(), project = context.projects().find(item => item.id === ask.projectId)?.name, network = jobNetwork.selectedOptions[0]?.textContent;
      const body = { agentId: agent.id, input: { text: jobInput.value }, tools: jobTools.value, permissions: { memory: ask.memory, projectLessons: ask.projectLessons }, limits: { timeoutMs: minutes * 60000 },
        ...(ask.projectId ? { projectId: ask.projectId } : {}), ...(ask.networkId ? { networkId: ask.networkId } : {}),
        // Sent twice (a lost answer), it is one job. getRandomValues also works over a paired device's plain HTTP.
        idempotencyKey: `ui-${[...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('')}` };
      const summary = facts([
        ['Agent', nameOf(agent)],
        ['CLI', [PROVIDER_NAMES[agent.base.provider] || agent.base.provider, agent.base.model || 'CLI default model', agent.base.effort].filter(Boolean).join(' · ')],
        ['Tools', jobTools.value === 'web' ? 'Web search and reading web pages (read only)' : 'None'],
        ['Files', 'Read only: an empty folder of its own. No project, repository or other files.'],
        ['Memory', { none: 'None', agent: 'This agent’s approved memory', 'agent+network': `This agent’s and the network “${network}”’s approved memory` }[ask.memory]],
        ['Project lessons', ask.projectLessons ? `Approved lessons of ${project}` : 'None'],
        ['Time limit', plural(minutes, 'minute')],
        ['Cost', 'Not limited. Usage is shown afterwards only if the CLI reports it.'],
      ]);
      const failure = el('div', 'inline-error'); failure.setAttribute('role', 'alert'); failure.hidden = true;
      const run = button('Run job', async () => {
        run.disabled = true; failure.hidden = true;
        try {
          const data = await request('/api/network/jobs', { method: 'POST', body });
          closeDialog(); jobInput.value = ''; counted();
          say(data.status === 'queued' ? 'Job queued. It starts when a job slot is free.' : 'Job accepted.');
          tasks.focus = data.jobId; await loadJobs();
        } catch (error) { failure.replaceChildren(el('span', '', error.message)); failure.hidden = false; }
        finally { run.disabled = false; }
      }, 'dialog-done'); run.id = 'network-job-confirm';
      const footer = el('div', 'kanban-dialog-actions'); footer.append(button('Cancel', closeDialog, 'secondary-button'), run);
      openDialog('Run this job?', [summary, note('Your CLI account’s usage applies. Results come back as text; nothing the agent writes changes a file, a card or Base.'), failure, footer]);
      run.focus();
    }

    async function loadJobs({ more = false } = {}) {
      if (!tasks.agent) return;
      const agentId = tasks.agent.id, version = ++tasks.version;
      clearTimeout(tasks.timer); tasks.loading = true; if (!tasks.data) renderJobs();
      const limit = Math.min(200, Math.max(50, (tasks.data?.jobs.length || 0) + (more ? 50 : 0)));
      try {
        const data = await request(`/api/network/jobs?agentId=${agentId}&limit=${limit}`);
        // Each job's accepted request never changes, so it is read once (for the job's text and choices).
        await Promise.all(data.jobs.filter(job => !tasks.requests.has(job.id)).map(job => request(`/api/network/jobs/${job.id}`).then(detail => { tasks.requests.set(job.id, detail.request); }, () => {})));
        await Promise.all(data.jobs.filter(job => job.result && tasks.open.has(job.id) && !tasks.results.has(job.id)).map(job => loadResult(job.id)));
        if (version === tasks.version) Object.assign(tasks, { data, error: null });
      } catch (failure) { if (version === tasks.version && !tasks.data) tasks.error = failure; else if (version === tasks.version) jobFailure(failure); }
      if (version !== tasks.version) return;
      tasks.loading = false; renderJobs();
      // Read again while this tab shows it: on job events while the stream is live (every 30 s besides, for what is not journaled:
      // a sign-in wait, the slot count), otherwise every 2 seconds while a job is open and every 10 otherwise (jobs from elsewhere).
      if (tasksShown(agentId)) tasks.timer = setTimeout(() => void loadJobs(), activity?.streaming() ? 30000 : tasks.data?.jobs.some(job => JOB_OPEN.has(job.status)) ? 2000 : 10000);
    }
    function tasksShown(agentId) { return visible && profileTab === 'tasks' && route().agentId === agentId; }
    /** A job event while the Tasks tab shows: any job's status (queue positions move) or this agent's activity reads the list again. */
    function tasksEvent(event) {
      if (!tasks.agent || !tasksShown(tasks.agent.id) || !(event.type === 'job.status' || (event.type?.startsWith('job.') && event.agentId === tasks.agent.id))) return;
      clearTimeout(tasks.timer); tasks.timer = setTimeout(() => void loadJobs(), 250);
    }
    /** The stream dropped: read now, which goes back to polling until it is live again. */
    function tasksLive(state, was) { if (was === 'live' && state !== 'live' && tasks.agent && tasksShown(tasks.agent.id) && tasks.data && !tasks.loading) void loadJobs(); }
    function stopPolling() { clearTimeout(tasks.timer); tasks.timer = null; }
    async function loadResult(id) {
      try { tasks.results.set(id, await request(`/api/network/jobs/${id}/result`)); }
      catch (failure) { tasks.results.set(id, { error: failure.message }); }
    }
    function renderJobs() {
      const data = tasks.data, waiting = !data && !tasks.error, active = document.activeElement, keep = jobList.contains(active) ? active.id : '';
      jobList.setAttribute('aria-busy', String(tasks.loading || waiting));
      jobList.replaceChildren(...(data ? data.jobs.map(jobItem) : []));
      jobWorker.hidden = !data || data.worker; jobWorker.textContent = 'No job worker runs in this app, so new jobs stay queued and nothing runs.';
      jobEmpty.replaceChildren(); jobEmpty.hidden = Boolean(data?.jobs.length);
      if (waiting) jobEmpty.append(note('Loading jobs…'));
      else if (tasks.error) { const failure = el('p', 'inline-error', `Could not load the jobs. ${tasks.error.message}`); failure.setAttribute('role', 'alert'); jobEmpty.append(failure, button('Retry', () => { tasks.error = null; void loadJobs(); }, 'secondary-button')); }
      else if (!data.jobs.length) jobEmpty.append(el('p', 'network-empty-title', 'No jobs yet.'), note('Jobs you run for this agent appear here with their status and result.'));
      jobMore.hidden = !data || data.next === null;
      if (tasks.focus && data && !tasks.loading) { const id = tasks.focus; tasks.focus = null; (document.querySelector(`#network-job-${id} .network-record-actions button`) || document.querySelector(`#network-job-${id} summary`) || jobRun).focus(); }
      else if (keep) document.getElementById(keep)?.focus();
    }
    const firstLine = text => clip(String(text || '').split('\n').find(line => line.trim()) || '', 140);
    function jobItem(job) {
      const item = el('li', 'lesson network-record network-job'); item.id = `network-job-${job.id}`; item.dataset.id = job.id; item.dataset.status = job.status;
      const request = tasks.requests.get(job.id), attempt = job.attempts.find(entry => entry.id === job.currentAttemptId) || job.attempts.at(-1) || null;
      const [stateText, tone] = JOB_STATES[job.status] || [job.status, ''];
      const head = el('div', 'lesson-head');
      head.append(el('small', `base-status tone-${tone}`, stateText), el('span', 'note network-job-when', `${JOB_OPEN.has(job.status) ? 'submitted' : 'ended'} ${ago(JOB_OPEN.has(job.status) ? job.createdAt : job.updatedAt)}`));
      if (request?.tools === 'web') head.append(el('span', 'lesson-kind', 'Web'));
      if (job.outcome === 'uncertain') head.append(el('span', 'lesson-badge', 'May have run'));
      const title = el('p', 'lesson-text network-job-title', request ? firstLine(request.input.text) : 'Job'); title.id = `network-job-${job.id}-title`;
      item.append(head, title);
      const lines = [];
      if (job.waiting) lines.push(job.waiting.message + (job.waiting.position ? ` Position ${job.waiting.position}.` : ''));
      if (job.live) lines.push(`Process: ${job.live.process}.${job.lastActivity ? ` Last: ${job.lastActivity.label}` : ''}`);
      if (job.live && tasks.agent?.base.stale) lines.push('Its Base agent was revoked after the job started. It goes on with what was accepted; cancel it to stop it.');
      if (attempt?.coverage || job.live?.coverage) lines.push(COVERAGE[attempt?.coverage || job.live.coverage]);
      if (attempt?.usage?.reported) lines.push(`Reported by the CLI: ${[['inputTokens', 'input'], ['outputTokens', 'output'], ['cachedTokens', 'cached']].filter(([key]) => attempt.usage[key] !== undefined).map(([key, label]) => `${attempt.usage[key].toLocaleString('en-US')} ${label} tokens`).concat(attempt.usage.costUsd !== undefined ? [`$${attempt.usage.costUsd.toFixed(4)}`] : []).join(' · ')}.`);
      else if (attempt && !JOB_OPEN.has(job.status) && attempt.launchingAt) lines.push('Usage: not reported by the CLI.');
      for (const line of lines) item.append(note(line, 'note network-job-line'));
      if (job.reason) {
        const why = note(`${job.reason}${job.errorCode ? ` (${job.errorCode})` : ''}`, `note network-job-reason${['failed', 'unknown', 'interrupted'].includes(job.status) ? ' is-problem' : ''}`); why.id = `network-job-${job.id}-reason`; item.append(why);
      }
      const actions = el('div', 'network-record-actions');
      const act = (label, run, name) => {
        const node = button(label, async () => { node.disabled = true; try { await run(); } finally { node.disabled = false; } }, 'text-button');
        node.id = `network-job-${job.id}-${name}`; node.setAttribute('aria-describedby', title.id); actions.append(node);
      };
      if (job.status === 'waiting_for_approval') { act('Approve', () => jobAction(job, 'approve', { expectedRevision: job.revision, decision: 'approve' }, 'Approved. It starts when a job slot is free.'), 'approve'); act('Reject', () => jobAction(job, 'approve', { expectedRevision: job.revision, decision: 'reject' }, 'Rejected. Nothing ran.'), 'reject'); }
      if (JOB_OPEN.has(job.status)) act('Cancel', () => jobAction(job, 'cancel', {}, job.status === 'queued' ? 'Cancelled. Nothing ran.' : 'Cancelled. Its process was stopped.'), 'cancel');
      if (['interrupted', 'unknown'].includes(job.status)) { act('Retry…', () => retryJob(job), 'retry'); act('Close…', () => closeJob(job), 'close'); }
      if (actions.childElementCount) item.append(actions);
      const more = el('details', 'network-history network-job-details'); more.open = tasks.open.has(job.id);
      more.addEventListener('toggle', () => {
        if (!more.open) { tasks.open.delete(job.id); return; }
        tasks.open.add(job.id);
        if (job.result && !tasks.results.has(job.id)) void loadResult(job.id).then(() => { if (more.isConnected) more.replaceChildren(...jobDetails(job)); });
      });
      more.append(...jobDetails(job));
      item.append(more);
      return item;
    }
    function jobDetails(job) {
      const request = tasks.requests.get(job.id), nodes = [el('summary', '', job.result ? 'Result and details' : 'Details')];
      if (job.result) {
        const result = tasks.results.get(job.id), body = el('div', 'md-view network-job-result'); body.id = `network-job-${job.id}-result`;
        if (!result) body.append(note('Loading the result…'));
        else if (result.error) body.append(el('p', 'inline-error', `Could not read the result. ${result.error}`));
        else { body.append(window.PromptboardMarkdown.render(result.text)); if (result.json) body.append(el('p', 'note network-sources-label', 'Structured data (json)'), Object.assign(el('pre', 'network-preview-text'), { textContent: JSON.stringify(result.json, null, 2) })); }
        nodes.push(body);
      }
      const attempt = job.attempts.at(-1);
      if (attempt?.lateResult) nodes.push(note('A result arrived after the job had ended. It was kept in the data folder and not used.'));
      if (request) {
        nodes.push(el('p', 'note network-sources-label', 'What it was given'), Object.assign(el('pre', 'network-preview-text network-job-input'), { textContent: request.input.text }));
        if (request.instructions) nodes.push(el('p', 'note network-sources-label', 'Instructions'), Object.assign(el('pre', 'network-preview-text'), { textContent: request.instructions }));
      }
      nodes.push(facts([
        ['Job ID', el('code', '', job.id)],
        ['Attempts', String(job.attempts.length)],
        ...(attempt ? [['CLI', [PROVIDER_NAMES[attempt.provider] || attempt.provider, attempt.model].filter(Boolean).join(' · ')], ['Exit code', attempt.exitCode === null ? 'None' : String(attempt.exitCode)],
          ['Session', attempt.nativeSessionId ? el('code', '', attempt.nativeSessionId) : 'Not reported']] : []),
        ...(request ? [['Memory', { none: 'None', agent: 'Agent', 'agent+network': 'Agent and network' }[request.permissions.memory]], ['Time limit', plural(Math.round(request.limits.timeoutMs / 60000) || 1, 'minute')]] : []),
      ]));
      return nodes;
    }
    function jobFailure(failure) {
      jobAlert.replaceChildren(el('span', '', failure.message));
      if (['REVISION_CONFLICT', 'JOB_STATE', 'JOB_FINISHED', 'NOT_FOUND'].includes(failure.code)) jobAlert.append(button('Reload', async () => { jobAlert.hidden = true; await loadJobs(); say('Reloaded the jobs.'); }, 'secondary-button network-reload'));
      jobAlert.hidden = false;
    }
    async function jobAction(job, action, body, done) {
      jobAlert.hidden = true;
      try { await request(`/api/network/jobs/${job.id}/${action}`, { method: 'POST', body }); say(done); tasks.focus = job.id; await loadJobs(); }
      catch (failure) { jobFailure(failure); }
    }
    /** Ask, then act in the dialog; a refusal stays in the dialog. */
    function askJob(title, nodes, label, action) {
      const failure = el('div', 'inline-error'); failure.setAttribute('role', 'alert'); failure.hidden = true;
      const confirm = button(label, async () => {
        confirm.disabled = true; failure.hidden = true;
        try { await action(); closeDialog(); }
        catch (error) { failure.replaceChildren(el('span', '', error.message)); failure.hidden = false; }
        finally { confirm.disabled = false; }
      }, 'dialog-done'); confirm.id = 'network-job-dialog-confirm';
      const footer = el('div', 'kanban-dialog-actions'); footer.append(button('Cancel', closeDialog, 'secondary-button'), confirm);
      openDialog(title, [...nodes, failure, footer]);
      return confirm;
    }
    function retryJob(job) {
      const last = job.attempts.at(-1), uncertain = job.outcome === 'uncertain' || (last && last.sideEffects !== 'none');
      const check = Object.assign(el('input'), { type: 'checkbox' }); check.id = 'network-job-uncertain';
      const row = el('label', 'check-row'); row.append(check, 'It may have done its work already. Run it again anyway.');
      const confirm = askJob('Run this job again?', [note(uncertain ? 'The last attempt may have finished its work, or read the web, before it stopped. Running it again does that again: effects outside Promptboard are not guaranteed to happen only once.' : 'Nothing ran last time. It runs again as a new attempt with the same accepted request.'), ...(uncertain ? [row] : [])],
        'Run again', async () => { await request(`/api/network/jobs/${job.id}/retry`, { method: 'POST', body: { expectedRevision: job.revision, confirm: true, ...(uncertain ? { confirmUncertain: check.checked } : {}) } }); say('Queued again as a new attempt.'); tasks.focus = job.id; await loadJobs(); });
      if (uncertain) { confirm.disabled = true; check.addEventListener('change', () => { confirm.disabled = !check.checked; }); check.focus(); } else confirm.focus();
    }
    function closeJob(job) {
      askJob('Close this job?', [note('It is marked failed and is not run again. Its outcome stays as it is: whether it did its work is not known.')], 'Close job',
        async () => { await request(`/api/network/jobs/${job.id}/close`, { method: 'POST', body: { expectedRevision: job.revision } }); say('Closed. It will not run again.'); tasks.focus = job.id; await loadJobs(); }).focus();
    }

    // ---- Posts: reports you write on the agent's profile. They are your notes, never events from a run.
    const posts = { agentId: null, data: null, error: null, loading: false, version: 0, focus: null };
    const postsRoot = el('section', 'network-posts-panel'); postsRoot.setAttribute('aria-label', 'Posts');
    const postsWrite = button('Write a report…', () => postForm(null), 'secondary-button'); postsWrite.id = 'network-post-write';
    const postsAlert = el('div', 'inline-error network-alert'); postsAlert.id = 'network-post-error'; postsAlert.setAttribute('role', 'alert'); postsAlert.hidden = true;
    const postsList = el('ul', 'network-posts'); postsList.id = 'network-post-list'; postsList.setAttribute('aria-label', 'Reports');
    const postsEmpty = el('div', 'network-empty'); postsEmpty.id = 'network-post-empty';
    const postsMore = button('Show more reports', () => loadPosts({ append: true }), 'secondary-button network-more'); postsMore.hidden = true;
    const postsHead = el('div', 'network-posts-head'); postsHead.append(note('Reports you write about this agent, in Markdown. They are your own notes: not events from a run, and nothing checks them.'), postsWrite);
    postsRoot.append(el('h3', '', 'Posts'), postsHead, postsAlert, postsList, postsEmpty, postsMore);
    function postsView(agent) {
      if (posts.agentId !== agent.id) { Object.assign(posts, { agentId: agent.id, data: null, error: null, loading: false, focus: null }); posts.version++; postsAlert.hidden = true; }
      renderPosts();
      return postsRoot;
    }
    async function loadPosts({ append = false } = {}) {
      const agentId = posts.agentId, version = ++posts.version;
      posts.loading = true; renderPosts();
      try {
        const data = await request(`/api/network/agents/${agentId}/posts?limit=50&offset=${append ? posts.data.posts.length : 0}`);
        if (version === posts.version) { posts.data = append ? { ...data, posts: [...posts.data.posts, ...data.posts] } : data; posts.error = null; postsAlert.hidden = true; }
      } catch (failure) {
        if (version !== posts.version) return;
        if (append) { postsAlert.replaceChildren(el('span', '', failure.message)); postsAlert.hidden = false; } else Object.assign(posts, { data: null, error: failure });
      } finally { if (version === posts.version) { posts.loading = false; renderPosts(); } }
    }
    function renderPosts() {
      const data = posts.data, waiting = !data && !posts.error, active = document.activeElement, keep = postsList.contains(active) ? active.id : '';
      postsList.setAttribute('aria-busy', String(posts.loading || waiting));
      postsList.replaceChildren(...(data ? data.posts.map(postItem) : []));
      postsEmpty.replaceChildren(); postsEmpty.hidden = Boolean(data?.posts.length);
      if (waiting) postsEmpty.append(note('Loading reports…'));
      else if (posts.error) { const failure = el('p', 'inline-error', `Could not load the reports. ${posts.error.message}`); failure.setAttribute('role', 'alert'); postsEmpty.append(failure, button('Retry', () => loadPosts(), 'secondary-button')); }
      else if (!data.posts.length) postsEmpty.append(el('p', 'network-empty-title', 'No reports yet.'), note('Write what this agent did well, what to watch, or where its work lives. Only you see it.'));
      postsMore.hidden = !data || data.next === null;
      if (posts.focus && data && !posts.loading) { const id = posts.focus; posts.focus = null; (document.querySelector(`#network-post-${id} .network-record-actions button`) || postsWrite).focus(); }
      else if (keep) document.getElementById(keep)?.focus();
    }
    function postItem(post) {
      const item = el('li', 'network-post'); item.id = `network-post-${post.id}`; item.dataset.id = post.id;
      const head = el('header', 'network-post-head'), badge = el('span', 'lesson-kind network-report', 'Report');
      head.append(badge, el('span', 'note', `Written by you · ${ago(post.createdAt)}${post.editedAt ? ` · edited ${ago(post.editedAt)}` : ''}`));
      const body = el('div', 'md-view network-post-body'); body.id = `network-post-${post.id}-body`;
      body.append(window.PromptboardMarkdown.render(post.markdown));
      item.append(head, body);
      if (post.references.length) { const sources = el('ul', 'network-sources'); sources.setAttribute('aria-label', 'Sources'); sources.append(...post.references.map(text => el('li', '', text))); item.append(el('p', 'note network-sources-label', 'Sources'), sources); }
      const actions = el('div', 'network-record-actions');
      for (const [label, run, name] of [['Edit…', () => postForm(post), 'edit'], ['Delete…', () => deletePost(post), 'delete']]) {
        const node = button(label, run, 'text-button'); node.id = `network-post-${post.id}-${name}`; node.setAttribute('aria-describedby', body.id); actions.append(node);
      }
      item.append(actions);
      return item;
    }
    function postForm(post) {
      const form = el('form', 'network-form'); form.noValidate = true;
      const markdown = Object.assign(el('textarea'), { rows: 10, maxLength: 16384, value: post?.markdown || '' }); markdown.id = 'network-post-form-markdown';
      const references = Object.assign(el('textarea'), { rows: 3, value: (post?.references || []).join('\n') }); references.id = 'network-post-form-references';
      form.append(labelled('Report (Markdown)', markdown), note('Headings, lists, links, code and tables. HTML is shown as text and images are not loaded. Local folders are cut to their last name and secret-looking values are masked.'),
        labelled('Sources (optional, one per line)', references), note('Where this report comes from: a card, a page, a run you watched. They are shown as text.'));
      const failure = el('div', 'inline-error'); failure.setAttribute('role', 'alert'); failure.hidden = true;
      const submit = el('button', 'dialog-done', post ? 'Save' : 'Publish to the profile'); submit.type = 'submit'; submit.id = 'network-post-form-submit';
      const footer = el('div', 'kanban-dialog-actions'); footer.append(button('Cancel', closeDialog, 'secondary-button'), submit);
      form.append(failure, footer);
      form.addEventListener('submit', async event => {
        event.preventDefault(); submit.disabled = true; failure.hidden = true;
        const body = { markdown: markdown.value, references: references.value.split('\n').map(line => line.trim()).filter(Boolean) };
        try {
          const data = post
            ? await request(`/api/network/agents/${posts.agentId}/posts/${post.id}`, { method: 'PATCH', body: { expectedRevision: post.revision, ...body } })
            : await request(`/api/network/agents/${posts.agentId}/posts`, { method: 'POST', body: { expectedRevision: posts.data?.revision ?? 0, ...body } });
          closeDialog(); say(post ? 'Saved the report.' : 'Published the report to this agent’s profile.');
          posts.focus = data.post.id; await loadPosts();
        } catch (error) {
          failure.replaceChildren(el('span', '', error.message)); failure.hidden = false;
          if (['REVISION_CONFLICT', 'NOT_FOUND'].includes(error.code)) failure.append(button('Reload', async () => { closeDialog(); await loadPosts(); say('Reloaded the current reports. Make your change again.'); }, 'secondary-button network-reload'));
        } finally { submit.disabled = false; }
      });
      openDialog(post ? 'Edit report' : 'Write a report', [form]);
      markdown.focus();
    }
    function deletePost(post) {
      confirmDialog('Delete report?', [note(`“${clip(post.markdown, 200)}”`, 'note network-quote'), note('It is deleted for good.')], async () => {
        await request(`/api/network/agents/${posts.agentId}/posts/${post.id}`, { method: 'DELETE', body: { expectedRevision: post.revision } });
        say('Deleted the report.'); posts.focus = post.id; opener = postsWrite;
      }, loadPosts);
    }

    // ---- Data
    async function load({ append = false } = {}) {
      const version = ++listVersion;
      state.loading = true; if (!append) state.error = '';
      renderList();
      const params = new URLSearchParams({ limit: '200', offset: String(append ? state.agents.length : 0) });
      for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
      try {
        // Project names come from the board; it is read once if the page has not loaded it yet.
        const [data] = await Promise.all([request(`/api/network/agents?${params}`), context.projects().length ? null : context.ensureBoard?.()?.catch?.(() => {})]);
        if (version !== listVersion) return;
        Object.assign(state, { revision: data.revision, agents: append ? [...state.agents, ...data.agents] : data.agents, total: data.total, next: data.next, capabilities: data.facets?.capabilities || [], loaded: true });
        fetched.clear(); names.clear(); detailError = null;
      } catch (failure) { if (version === listVersion) state.error = failure.message; }
      finally { if (version === listVersion) { state.loading = false; if (visible && route().section === 'agents') { renderList(); renderDetail(); } } }
    }
    async function setEnabled(agent, toggle) {
      toggle.disabled = true; showError('');
      try {
        await request(`/api/network/agents/${agent.id}`, { method: 'PATCH', body: { expectedRevision: agent.revision, enabled: toggle.checked } });
        say(`${nameOf(agent)} ${toggle.checked ? 'enabled' : 'disabled'} in Network. Base is unchanged.`);
        await load();
      } catch (failure) { toggle.checked = !toggle.checked; showError(failure); }
      finally {
        // A disabled control loses focus; give it back to the switch (redrawn after a save) unless focus moved on.
        toggle.disabled = false;
        if ([document.body, toggle, null].includes(document.activeElement)) document.querySelector('#network-enabled')?.focus();
      }
    }

    // ---- Register / edit dialog. Escape and Close return focus to the control that opened it.
    const dialog = el('dialog', 'kanban-dialog network-dialog'); dialog.id = 'network-dialog'; dialog.setAttribute('aria-labelledby', 'network-dialog-heading');
    document.body.append(dialog);
    let opener = null, ticket = 0;
    function closeDialog() {
      ticket++;
      if (dialog.open) dialog.close();
      const back = opener; opener = null;
      (back?.isConnected ? back : back?.id && document.getElementById(back.id))?.focus?.();
    }
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closeDialog(); } });
    dialog.addEventListener('close', () => { if (opener) closeDialog(); });
    function openDialog(title, nodes) {
      opener = dialog.open ? opener : document.activeElement;
      const close = button('×', closeDialog, 'dialog-close icon-button'); close.setAttribute('aria-label', 'Close');
      const heading = el('h2', '', title); heading.id = 'network-dialog-heading';
      dialog.replaceChildren(close, el('p', 'eyebrow', 'NETWORK'), heading, ...nodes);
      if (!dialog.open) dialog.showModal();
    }
    async function openForm(agent) {
      const mine = ++ticket;
      let choices = [];
      if (!agent) {
        openDialog('Register agent', [note('Loading Base agents…')]);
        try { choices = (await request('/api/base')).resources.filter(item => KINDS[item.kind]).sort((a, b) => a.name.localeCompare(b.name)); }
        catch (failure) { if (mine === ticket) openDialog('Register agent', [el('p', 'inline-error', failure.message), closeActions()]); return; }
        if (mine !== ticket) return;
        if (!choices.length) {
          openDialog('Register agent', [note('Base has no agents yet. Create an Agent or an Agent profile in Base, then register it here.'), closeActions(button('Open Base', () => { opener = null; closeDialog(); location.hash = '#/base'; }, 'secondary-button'))]);
          return;
        }
      }
      openDialog(agent ? 'Edit Network identity' : 'Register agent', [identityForm(agent, choices)]);
      dialog.querySelector('select, input')?.focus();
    }
    function closeActions(...extra) { const box = el('div', 'kanban-dialog-actions'); box.append(button('Close', closeDialog, 'secondary-button'), ...extra); return box; }
    /** Delete after a confirmation: `action` deletes, then the dialog closes and `after` reads the list again. */
    function confirmDialog(title, nodes, action, after) {
      const failure = el('div', 'inline-error'); failure.setAttribute('role', 'alert'); failure.hidden = true;
      const confirm = button('Delete', async () => {
        confirm.disabled = true; failure.hidden = true;
        try { await action(); closeDialog(); await after(); }
        catch (error) {
          failure.replaceChildren(el('span', '', error.message)); failure.hidden = false;
          if (['REVISION_CONFLICT', 'NOT_FOUND'].includes(error.code)) failure.append(button('Reload', async () => { closeDialog(); await after(); say('Reloaded. Nothing was deleted.'); }, 'secondary-button network-reload'));
        } finally { confirm.disabled = false; }
      }, 'secondary-button network-danger');
      confirm.id = 'network-confirm-delete';
      const footer = el('div', 'kanban-dialog-actions'); footer.append(button('Cancel', closeDialog, 'secondary-button'), confirm);
      openDialog(title, [...nodes, failure, footer]);
      confirm.focus();
    }
    function identityForm(agent, choices) {
      const form = el('form', 'network-form'); form.noValidate = true;
      let baseSelect = null;
      if (agent) form.append(note(`Base agent: ${agent.base.name || agent.baseResourceId} (${KINDS[agent.base.kind] || 'missing'}). Change its provider, model and instructions in Base.`));
      else {
        baseSelect = select(choices.map(item => [item.id, `${item.name} · ${KINDS[item.kind]}${item.kind === 'profile' && PROVIDER_NAMES[item.configuration?.agent?.provider] ? ` · ${PROVIDER_NAMES[item.configuration.agent.provider]}` : ''}${item.enabled === false ? ' · switched off' : item.trust !== 'trusted' ? ' · not trusted' : ''}`]));
        baseSelect.id = 'network-form-base';
        form.append(labelled('Base agent', baseSelect), note('Network keeps only this agent’s ID. Its provider, model and instructions stay in Base. A switched-off or untrusted agent shows as stale.'));
      }
      const displayName = Object.assign(el('input'), { type: 'text', maxLength: 80, value: agent?.displayName || '', autocomplete: 'off' }); displayName.id = 'network-form-name';
      const tags = Object.assign(el('input'), { type: 'text', maxLength: 900, value: (agent?.tags || []).join(', '), autocomplete: 'off' }); tags.id = 'network-form-tags';
      const capabilities = Object.assign(el('input'), { type: 'text', maxLength: 900, value: (agent?.capabilities || []).join(', '), autocomplete: 'off' }); capabilities.id = 'network-form-capabilities';
      const placeholder = () => { displayName.placeholder = agent ? agent.base.name || '' : choices.find(item => item.id === baseSelect.value)?.name || ''; };
      baseSelect?.addEventListener('change', placeholder); placeholder();
      form.append(labelled('Display name (optional)', displayName), labelled('Tags (comma separated)', tags), labelled('Capabilities (comma separated)', capabilities),
        note('Capabilities are what you declare this agent is for, such as research or review. What its CLI can do is shown on its profile.'));
      // Projects it may serve: the board's projects, plus any listed project that is no longer on the board (kept unless unticked).
      const projectBox = el('fieldset', 'settings-group network-projects'); projectBox.append(el('legend', '', 'Projects it may serve'));
      const kept = agent?.projectAllowlist || [], options = [...context.projects().map(project => [project.id, project.name]), ...kept.filter(id => !context.projects().some(project => project.id === id)).map(id => [id, `${id} (not on this board)`])];
      for (const [id, name] of options) { const box = Object.assign(el('input'), { type: 'checkbox', checked: kept.includes(id) }); box.dataset.project = id; const label = el('label', 'check-row'); label.append(box, name); projectBox.append(label); }
      if (!options.length) projectBox.append(note('No projects on the board. It serves no project data.'));
      form.append(projectBox);
      let enabled = null;
      if (!agent) { enabled = Object.assign(el('input'), { type: 'checkbox', checked: true }); enabled.id = 'network-form-enabled'; const label = el('label', 'check-row'); label.append(enabled, 'Enabled in Network'); form.append(label); }
      const failure = el('div', 'inline-error'); failure.setAttribute('role', 'alert'); failure.hidden = true;
      const submit = el('button', 'dialog-done', agent ? 'Save' : 'Register'); submit.type = 'submit'; submit.id = 'network-form-submit';
      const footer = el('div', 'kanban-dialog-actions'); footer.append(button('Cancel', closeDialog, 'secondary-button'), submit);
      form.append(failure, footer);
      form.addEventListener('submit', async event => {
        event.preventDefault(); submit.disabled = true; failure.hidden = true;
        const fields = { displayName: displayName.value.trim() || null, tags: words(tags.value), capabilities: words(capabilities.value), projectAllowlist: [...projectBox.querySelectorAll('[data-project]:checked')].map(box => box.dataset.project) };
        try {
          const data = agent
            ? await request(`/api/network/agents/${agent.id}`, { method: 'PATCH', body: { expectedRevision: agent.revision, ...fields } })
            : await request('/api/network/agents', { method: 'POST', body: { baseResourceId: baseSelect.value, expectedRevision: state.revision ?? 0, enabled: enabled.checked, ...fields } });
          opener = agent ? opener : null; closeDialog();
          say(agent ? `Saved ${nameOf(data.agent)}. Base is unchanged.` : `Registered ${nameOf(data.agent)}. Base is unchanged.`);
          await load();
          if (!agent) { focusDetail = 'always'; go(hashFor('agents', data.agent.id)); }
        } catch (error) {
          failure.replaceChildren(el('span', '', error.message)); failure.hidden = false;
          // A conflict means someone changed it meanwhile: a new registration only needs the current revision; an edit
          // is reopened on the current version, so nothing changed elsewhere is overwritten.
          if (error.code === 'REVISION_CONFLICT') failure.append(button('Reload', async () => {
            if (agent) { closeDialog(); showError(''); await load(); say('Reloaded the current version. Edit it again to change it.'); return; }
            await load(); failure.hidden = true; say('Reloaded. Register the agent again.');
          }, 'secondary-button network-reload'));
        } finally { submit.disabled = false; }
      });
      return form;
    }

    // ---- Page entry
    async function show() {
      const entering = !visible; visible = true;
      if (entering) { memory.id = null; posts.agentId = null; tasks.agent = null; tasks.timeoutMinutes = null; } // Read again on every visit, as the directory is.
      render();
      if (entering) { say(''); showError(''); await load(); }
    }
    function leave() {
      if ((graphs && !graphs.guard(null)) || (pipes && !pipes.guard(null))) return; // Unsaved changes: "keep editing" brings the editor's address back.
      visible = false; graphs?.show(null); pipes?.show(null); stopPolling(); activity?.show(null); activity?.live(false); clients?.show(false);
      if (dialog.open) { opener = null; closeDialog(); } // A dialog never stays over another page.
    }
    return { show, leave, refresh: load };
  }
  return { create };
})();
