'use strict';

// Network page (#/network): the agent directory and agent profiles, over the owner routes /api/network/*.
// Base stays the only editor of agent definitions: this page reads Base, registers a Base agent by its ID, edits only the
// Network identity (display name, tags, capabilities, projects, on/off) and opens the real resource in Base. Nothing here
// starts a job, a run or a model call. All text is set as text (PromptboardDom), never parsed as HTML.
window.PromptboardNetwork = (() => {
  const { el, button, plural, ago } = window.PromptboardDom;
  // Agents works now; each other section says what it will do and offers no working-looking controls until then.
  const SECTIONS = [
    ['agents', 'Agents', ''],
    ['graph', 'Graph', 'Draw networks from registered agents and nested networks, then publish versions. Saving a graph never starts work.'],
    ['pipelines', 'Pipelines', 'Build execution pipelines from a published network: parallel steps, joins, approvals and a saved report.'],
    ['activity', 'Activity', 'Live status and events of Network jobs, with what each CLI can report shown next to every status.'],
    ['library', 'Library', 'Every network and pipeline with its drafts, published versions and where each version is used, plus export and import.'],
    ['federation', 'Federation', 'Work with trusted remote agents over A2A. It stays off until you turn it on.'],
  ];
  const PROFILE_TABS = [
    ['profile', 'Profile', ''],
    ['tasks', 'Tasks', 'The jobs this agent takes will appear here once Network jobs arrive in a later update.'],
    ['activity', 'Activity', 'This agent’s live status and events will appear here once Network activity arrives in a later update.'],
    ['memory', 'Memory', 'Approved memory for this agent will appear here in a later update. Project memory stays with each Kanban project.'],
  ];
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
  const AGENT_ID = /^agt_[0-9a-f]{20}$/;

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

  // #/network (Agents), #/network/agents/<id>, #/network/<section>. Anything else under #/network opens Agents.
  function route() {
    const [section, id] = location.hash.replace(/^#\/network\/?/, '').split('/');
    if (section === 'agents' && AGENT_ID.test(id || '')) return { section: 'agents', agentId: id };
    return { section: SECTIONS.some(([key]) => key === section) ? section : 'agents', agentId: null };
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
      if (!response.ok) throw Object.assign(new Error(data.error || 'Network could not complete this request. Nothing was changed.'), { code: data.code });
      return data;
    }

    // ---- The page skeleton, built once; renders replace only the parts that change (app.js keeps #app-error first).
    const heading = el('h1', '', 'Network'); heading.id = 'network-heading';
    const register = button('Register agent', () => openForm(null), 'secondary-button'); register.id = 'network-register';
    const head = el('section', 'base-heading network-heading'), titles = el('div'), headActions = el('div', 'detail-actions');
    titles.append(heading, note('Register Base agents once, then find them here. Their definitions stay in Base.', 'intro-description'));
    headActions.append(register); head.append(titles, headActions);
    const privacy = note('Network keeps references to Base agents in this computer’s data folder. Opening or editing them never runs an agent.', 'note network-privacy');
    const panelOf = id => (id === 'agents' ? 'network-panel-agents' : 'network-panel-soon');
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
    view.append(head, privacy, sections, status, alert, agentsPanel, soonPanel);

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
      const { section } = route();
      sections.select(section);
      for (const link of sideNav.children) { if (link.dataset.section === section) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); }
      agentsPanel.hidden = section !== 'agents'; soonPanel.hidden = section === 'agents';
      register.hidden = section !== 'agents';
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
        if (soon) panel.append(el('h3', '', label), note('Not available yet.', 'note unavailable'), note(soon)); else panel.append(...profileSections(agent));
        return panel;
      });
      function showInner() { inner.select(profileTab); for (const panel of panels) panel.hidden = panel.id !== panelId(profileTab); }
      showInner();
      box.append(inner, ...panels);
      return box;
    }
    function profileSections(agent) {
      const base = agent.base, caps = agent.providerCapabilities || {};
      const projectNames = new Map(context.projects().map(project => [project.id, project.name]));
      const projects = agent.projectAllowlist.map(id => (agent.missingProjects.includes(id) ? `${id} (not on this board)` : projectNames.get(id) || id));
      const networks = el('span', '', agent.networks.length ? plural(agent.networks.length, 'network') : 'Not in a network yet.');
      if (agent.networks.length) void networkNames(agent.id).then(names => { if (names.length) networks.textContent = names.join(', '); }, () => {});
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
        ['New work', reason ? `Refused. ${reason}` : 'Allowed once Network jobs arrive in a later update.'],
        ['Job tools', tools],
        ['Files', 'Read only. Network jobs never change files.'],
        ['Project data', projects.length ? `Only ${projects.join(', ')}` : 'None'],
        ['Visibility', 'Private: this computer and your paired devices.'],
      ]));
      return sections;
    }
    const names = new Map(); // agentId → network names, read once per page visit.
    function networkNames(id) {
      if (!names.has(id)) names.set(id, request(`/api/network/networks?agentId=${id}&limit=200`).then(data => data.networks.map(item => item.name)).catch(failure => { names.delete(id); throw failure; }));
      return names.get(id);
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
      render();
      if (entering) { say(''); showError(''); await load(); }
    }
    function leave() { visible = false; if (dialog.open) { opener = null; closeDialog(); } } // A dialog never stays over another page.
    return { show, leave, refresh: load };
  }
  return { create };
})();
