'use strict';

// A deliberate boundary: this file never reads app.js globals. The application supplies
// its authenticated API and existing agent controls when it creates this view.
window.PromptboardBase = (() => {
  const KINDS = { profile: 'Agent profile', pack: 'Resource pack', mcp: 'MCP server', skill: 'Skill', knowledge: 'Knowledge / Wiki', context: 'Context source', tool: 'Tool' };
  const CATEGORIES = [['', 'All'], ['agent', 'Agents'], ['pack', 'Packs'], ['mcp', 'MCPs'], ['skill', 'Skills'], ['knowledge', 'Knowledge'], ['context', 'Context'], ['tool', 'Tools']];
  const INHERIT = { mode: 'inherit', include: [], exclude: [] };
  const el = (tag, text, className = '') => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const p = text => el('p', text, 'note');
  const button = (text, handler, className = 'secondary-button') => { const node = el('button', text, className); node.type = 'button'; node.addEventListener('click', handler); return node; };
  const field = (name, control, note = '') => { const label = el('label', undefined, 'field-label'); label.append(name, control); if (note) label.append(p(note)); return label; };
  const input = (value = '', maxLength = 200) => Object.assign(el('input'), { type: 'text', value, maxLength });
  const area = (value = '', maxLength = 200000) => Object.assign(el('textarea'), { value, maxLength, rows: 6, spellcheck: false });
  const option = (value, text) => Object.assign(el('option', text), { value });
  const select = (options, value) => { const node = el('select'); node.append(...options.map(([id, name]) => option(id, name))); node.value = value; return node; };
  const check = (text, checked = false) => { const control = Object.assign(el('input'), { type: 'checkbox', checked }); const label = el('label', undefined, 'check-row'); label.append(control, text); return { control, label }; };
  const actions = (...nodes) => { const box = el('div', undefined, 'detail-actions'); box.append(...nodes); return box; };
  const group = (name, ...nodes) => { const box = el('fieldset', undefined, 'settings-group'); box.append(el('legend', name), ...nodes); return box; };
  const details = (name, ...nodes) => { const box = el('details', undefined, 'base-disclosure'); box.append(el('summary', name), ...nodes); return box; };
  const clone = value => JSON.parse(JSON.stringify(value));
  const targetKey = target => ['scope', 'projectId', 'columnId', 'taskId'].map(key => target?.[key] || '').join(':');
  const refsText = refs => (refs || []).map(item => item.resourceId || item.id || item).join(', ');
  const lineValues = text => text.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const basename = name => String(name || '').split(/[\\/]/).at(-1);

  // Locally generated portraits: fixed SVG elements and palettes, never imported HTML.
  function avatar(configuration, fallback = 'agent') {
    if (configuration?.mime && configuration?.data) return Object.assign(el('img', undefined, 'base-agent-avatar'), { src: `data:${configuration.mime};base64,${configuration.data}`, alt: 'Agent profile avatar' });
    const prompt = configuration?.prompt || '', seed = `${configuration?.seed || fallback}:${prompt}`;
    let value = 2166136261;
    for (const character of seed) value = Math.imul(value ^ character.charCodeAt(0), 16777619) >>> 0;
    const colors = { blue: '#6b9edd', green: '#7aaf91', purple: '#a58aca', pink: '#d894b7', orange: '#dba177', red: '#ca8585', yellow: '#d9c17a', black: '#555967', white: '#c7cbd3' };
    const requested = Object.keys(colors).find(color => new RegExp(`\\b${color}\\b`, 'i').test(prompt));
    const accent = colors[requested] || Object.values(colors)[value % 9];
    const skin = ['#efc4a2', '#d9a17e', '#ac7459', '#80503e'][value >>> 4 & 3];
    const hair = /blond|golden/i.test(prompt) ? '#d8b565' : /red hair|ginger/i.test(prompt) ? '#b36548' : ['#33343f', '#685042', '#4a3e54'][(value >>> 7) % 3];
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 80 80'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', prompt ? `Agent avatar: ${prompt}` : 'Agent avatar'); svg.classList.add('base-agent-avatar');
    const add = (tag, attrs) => { const node = document.createElementNS(svg.namespaceURI, tag); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value)); svg.append(node); };
    add('rect', { width: 80, height: 80, rx: 12, fill: accent });
    add('path', { d: 'M10 80Q12 57 40 56Q68 57 70 80Z', fill: '#333846' });
    if (/robot|android|bot/i.test(prompt)) {
      add('path', { d: 'M40 20V12', stroke: '#333846', 'stroke-width': 3 }); add('circle', { cx: 40, cy: 10, r: 4, fill: '#eff4fa' });
      add('rect', { x: 21, y: 24, width: 38, height: 33, rx: 10, fill: '#e0e7ee' });
      add('rect', { x: 25, y: 30, width: 30, height: 15, rx: 6, fill: '#333846' });
      add('circle', { cx: 32, cy: 37, r: 3, fill: accent }); add('circle', { cx: 48, cy: 37, r: 3, fill: accent });
      add('path', { d: 'M34 50H46', stroke: '#777e88', 'stroke-width': 2, 'stroke-linecap': 'round' });
    } else {
      add('ellipse', { cx: 40, cy: 35, rx: 21, ry: 24, fill: hair });
      add('rect', { x: 35, y: 48, width: 10, height: 13, rx: 4, fill: skin });
      add('ellipse', { cx: 40, cy: 37, rx: 17, ry: 21, fill: skin });
      add('path', { d: value & 1 ? 'M22 30Q18 10 42 13Q62 15 58 33Q44 28 35 19Q32 29 22 30Z' : 'M22 30Q20 10 42 13Q62 14 58 29Q37 16 22 30Z', fill: hair });
      for (const cx of [33, 47]) add('circle', { cx, cy: 37, r: 2, fill: '#33313a' });
      add('path', { d: 'M35 47Q40 51 45 47', fill: 'none', stroke: '#874f47', 'stroke-width': 2, 'stroke-linecap': 'round' });
      if (/glasses|scientist|engineer/i.test(prompt)) { for (const cx of [32, 48]) add('rect', { x: cx - 6, y: 32, width: 12, height: 10, rx: 3, fill: 'none', stroke: '#34343f', 'stroke-width': 2 }); add('path', { d: 'M38 36H42', stroke: '#34343f', 'stroke-width': 2 }); }
    }
    return svg;
  }

  // Only a small Markdown subset is rendered. All text is built as DOM nodes, and links
  // are restricted to http(s) and page fragments. Raw HTML remains literal text.
  function markdown(text, onPage) {
    const output = el('div', undefined, 'base-markdown');
    let fence = null;
    const inline = (parent, value) => {
      const pattern = /\[([^\]\n]+)\]\(([^\s)]+)\)|`([^`]+)`|\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g;
      let at = 0;
      for (const match of value.matchAll(pattern)) {
        parent.append(value.slice(at, match.index));
        if (match[4] !== undefined) parent.append(onPage ? button(match[5] || match[4], () => onPage(match[4]), 'text-button') : match[0]);
        else if (match[3] !== undefined) parent.append(el('code', match[3]));
        else {
          const href = match[2];
          if (/^(?:base:|#page-)/.test(href) && onPage) {
            parent.append(button(match[1], () => onPage(href.replace(/^(?:base:|#page-)/, '')), 'text-button'));
          } else if (/^https?:\/\//i.test(href)) {
            const link = el('a', match[1]); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; parent.append(link);
          } else parent.append(match[0]);
        }
        at = match.index + match[0].length;
      }
      parent.append(value.slice(at));
    };
    for (const line of String(text || '').split('\n')) {
      if (line.startsWith('```')) { if (fence) { output.append(fence); fence = null; } else fence = el('pre'); continue; }
      if (fence) { fence.append(`${line}\n`); continue; }
      const heading = /^(#{1,4})\s+(.+)$/.exec(line);
      const node = el(heading ? `h${Math.min(heading[1].length + 1, 5)}` : 'p');
      inline(node, heading ? heading[2] : line); output.append(node);
    }
    if (fence) output.append(fence);
    return output;
  }

  function create(context) {
    const $ = selector => document.querySelector(selector);
    const state = { revision: -1, resources: [], targets: [], providers: {} };
    const avatarCache = new Map();
    const preferenceKey = 'promptboard.base.library-view';
    const viewState = { category: '', search: '', filter: 'all', sort: 'recently_updated', viewMode: 'grid' };
    try {
      const saved = JSON.parse(localStorage.getItem(preferenceKey) || '{}');
      const category = ['agents', 'profile'].includes(saved.category) ? 'agent' : saved.category;
      if (CATEGORIES.some(([id]) => id === category)) viewState.category = category;
      if (typeof saved.search === 'string') viewState.search = saved.search.slice(0, 200);
      if (['all', 'enabled', 'disabled'].includes(saved.filter)) viewState.filter = saved.filter;
      if (['recently_updated', 'name'].includes(saved.sort)) viewState.sort = saved.sort;
      if (['grid', 'list'].includes(saved.viewMode)) viewState.viewMode = saved.viewMode;
    } catch { /* Invalid or unavailable browser preferences use the library defaults. */ }
    let category = viewState.category, chosen = null, editingKind = null, loading = null, requestVersion = 0;
    let loadVersion = 0, loadError = '', resultLoading = false, libraryScroll = 0;
    const typeOf = item => item.type || (item.kind === 'profile' ? 'agent' : item.kind);
    const categoryKind = () => category === 'agent' ? 'profile' : category;
    function persistView() {
      Object.assign(viewState, { category, search: $('#base-search').value });
      try { localStorage.setItem(preferenceKey, JSON.stringify(viewState)); } catch {}
    }
    // Replacing the editor asks first when it holds unsaved changes. Saves, deletes and Cancel pass `true`.
    const leave = force => force === true || !$('#base-detail .base-resource-form')?.isDirty?.() || window.confirm('Discard your unsaved changes to this resource?');
    window.addEventListener('beforeunload', event => { if ($('#base-detail .base-resource-form')?.isDirty?.()) { event.preventDefault(); event.returnValue = ''; } });
    function closeResource(force) {
      if (!leave(force)) return;
      ++requestVersion; chosen = null; editingKind = null; renderList();
      $('.base-list-panel').scrollTop = libraryScroll;
    }
    const categoryLabel = () => CATEGORIES.find(([id]) => id === category)?.[1] || 'All';
    const resource = id => state.resources.find(item => item.id === id);
    const nameOf = id => resource(id)?.name || id;
    const status = text => { $('#base-status').textContent = text; };
    const error = text => { $('#base-error').textContent = text || ''; $('#base-error').hidden = !text; };
    const accept = data => {
      const next = data.base || data;
      if (Number.isInteger(next.revision) && next.revision >= state.revision && Array.isArray(next.resources)) Object.assign(state, next);
      if (data.board) context.acceptBoard?.(data.board);
      if (restoreGlobals) restoreGlobals.hidden = !state.pendingGlobalBaseImport;
    };
    async function request(path, options) {
      const { response, data } = await context.api(path, options);
      if (!response.ok) throw Object.assign(new Error(data.error || 'Base could not complete this request.'), { code: data.code, data });
      accept(data); return data;
    }
    async function load(force = false) {
      if (loading && !force) return loading;
      const version = ++loadVersion;
      resultLoading = true; loadError = ''; renderList();
      // The collection is fetched once, independently of the current category. A late
      // refresh cannot publish an older response even when its Base revision is equal.
      const job = (async () => {
        try {
          const { response, data } = await context.api('/api/base');
          if (!response.ok) throw new Error(data.error || 'Base could not load resources.');
          if (version === loadVersion) { accept(data); resultLoading = false; renderList(); status(`${state.resources.length} resources · assignments are always optional`); }
          return data;
        } catch (failure) {
          if (version === loadVersion) { resultLoading = false; loadError = failure.message; renderList(); }
          throw failure;
        }
      })();
      loading = job;
      try { return await job; } finally { if (loading === job) loading = null; }
    }
    async function show() {
      error(''); if (state.revision < 0) resultLoading = true; renderList();
      window.requestAnimationFrame?.(placeCategories);
      try {
        if (state.revision < 0) { await context.ensureBoard?.(); await load(); }
        status(`${state.resources.length} resources · assignments are always optional`);
      } catch (failure) {
        // load() owns its generation-guarded error state. Only an initial board-load
        // failure needs a local error; an obsolete show() failure must not replace it.
        if (!loadError && !loading && state.revision < 0) { resultLoading = false; loadError = failure.message; renderList(); }
      }
    }
    function openDialog(title, nodes) {
      $('#base-dialog-heading').textContent = title;
      $('#base-dialog-content').replaceChildren(...nodes);
      if (!$('#base-dialog').open) $('#base-dialog').showModal();
    }
    const closeDialog = () => $('#base-dialog').close();
    $('#base-dialog-close').addEventListener('click', closeDialog);
    function inlineError(parent) {
      const node = el('p', '', 'inline-error'); node.setAttribute('role', 'alert'); node.hidden = true; parent.append(node);
      return failure => { node.textContent = failure?.message || failure || ''; node.hidden = !node.textContent; };
    }
    function busyButton(label, action, className = 'secondary-button') {
      const node = button(label, async () => { node.disabled = true; try { await action(); } finally { node.disabled = false; } }, className); return node;
    }
    const download = (name, data) => window.PromptboardDom.download(name, JSON.stringify(data, null, 2), 'application/json');
    function metadata(item) {
      const trust = item.trust || 'untrusted';
      return `${KINDS[item.kind] || item.kind} · ${item.enabled ? 'Available' : 'Disabled'} · ${trust} · r${item.revision}`;
    }
    function renderList() {
      const query = $('#base-search').value.trim().toLocaleLowerCase();
      const kind = categoryKind();
      const list = state.resources.filter(item => (!category || typeOf(item) === category)
        && (viewState.filter === 'all' || Boolean(item.enabled) === (viewState.filter === 'enabled'))
        && (!query || `${item.name} ${item.description || ''} ${(item.tags || []).join(' ')}`.toLocaleLowerCase().includes(query)));
      list.sort((a, b) => (viewState.sort === 'recently_updated' ? (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0) : 0) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      $('#base-category-heading').textContent = category ? categoryLabel() : 'All resources';
      $('#base-sidebar-count').textContent = String(state.resources.length);
      const showEditor = editingKind && (!kind || kind === editingKind);
      $('#base-detail').hidden = !showEditor;
      $('.base-layout').classList.toggle('base-browse', !showEditor);
      $('#base-list').classList.toggle('base-list-mode', viewState.viewMode === 'list');
      $('.base-list-panel').setAttribute('aria-busy', String(resultLoading));
      $('#base-list').replaceChildren(...(resultLoading || loadError ? [] : list.map(item => {
        if (item.kind === 'profile') return agentCard(item);
        const row = el('li'); const open = button('', () => openResource(item.id), 'base-resource'); open.dataset.resourceId = item.id;
        if (chosen === item.id) open.setAttribute('aria-current', 'true');
        open.append(el('strong', item.name), el('span', item.description || KINDS[item.kind], 'base-resource-description'), el('small', metadata(item)));
        row.append(open); return row;
      })));
      const empty = $('#base-empty'); empty.hidden = !resultLoading && !loadError && list.length > 0; empty.replaceChildren();
      if (resultLoading) empty.append(p(`Loading ${category ? categoryLabel().toLowerCase() : 'resources'}…`));
      else if (loadError) {
        const failure = el('p', `Could not load ${category ? categoryLabel().toLowerCase() : 'resources'}. ${loadError}`, 'inline-error'); failure.setAttribute('role', 'alert');
        empty.append(failure, button('Retry', () => load(true).catch(() => {})));
      } else if (!list.length) {
        empty.append(p(query ? `No ${category ? categoryLabel().toLowerCase() : 'resources'} match “${$('#base-search').value.trim()}”.` : viewState.filter !== 'all' ? `No ${category ? categoryLabel().toLowerCase() : 'resources'} match these filters.` : category ? `No ${categoryLabel().toLowerCase()} yet.` : 'Your library is empty. Create a skill, wiki, MCP connection, or reusable pack.'));
        if (query) empty.append(button('Clear search', () => { $('#base-search').value = ''; persistView(); renderList(); }));
        if (viewState.filter !== 'all') empty.append(button('Clear filters', () => { viewState.filter = 'all'; $('#base-filter').value = 'all'; persistView(); renderList(); }));
        empty.append(button(category ? `Add ${categoryLabel() === 'MCPs' ? 'MCP' : KINDS[kind]}` : 'Add resource', createResource));
      }
      for (const item of $('#base-categories').children) {
        item.setAttribute('aria-pressed', String(item.dataset.kind === category));
        item.querySelector('.base-category-count').textContent = String(state.resources.filter(resource => !item.dataset.kind || typeOf(resource) === item.dataset.kind).length);
      }
    }
    function profileResources(item, seen = new Set()) {
      if (seen.has(item.id)) return []; seen.add(item.id);
      const selected = new Map();
      const refs = [...(item.dependencies || []), ...(item.kind === 'pack' ? item.configuration?.resources || [] : item.configuration?.binding?.include || [])];
      for (const ref of refs) {
        const target = resource(ref.resourceId); selected.set(ref.resourceId, target || { id: ref.resourceId, name: ref.resourceId, kind: 'unavailable' });
        if (target && ['pack', 'profile'].includes(target.kind)) for (const child of profileResources(target, new Set(seen))) selected.set(child.id, child);
      }
      for (const id of item.configuration?.binding?.exclude || []) selected.delete(id);
      return [...selected.values()];
    }
    function agentCard(item) {
      const row = el('li', undefined, 'base-agent-card');
      const open = button('', () => openResource(item.id), 'base-resource'); open.dataset.resourceId = item.id;
      if (chosen === item.id) open.setAttribute('aria-current', 'true');
      const title = el('div'); title.append(el('strong', item.name), el('small', `${item.configuration?.agent?.provider || 'Inherited provider'}${item.configuration?.agent?.model ? ` · ${item.configuration.agent.model}` : ''}`));
      const head = el('div', undefined, 'base-agent-card-head'); const portrait = avatar(null, item.id); head.append(portrait, title);
      if (item.configuration?.avatar?.contentHash) {
        const hash = item.configuration.avatar.contentHash;
        if (!avatarCache.has(hash)) { avatarCache.set(hash, request(`/api/base/resources/${encodeURIComponent(item.id)}/avatar`).then(data => data.image)); if (avatarCache.size > 32) avatarCache.delete(avatarCache.keys().next().value); }
        avatarCache.get(hash).then(image => portrait.replaceWith(avatar(image))).catch(() => { portrait.setAttribute('aria-label', 'Saved avatar unavailable; regenerate or import its content.'); avatarCache.delete(hash); });
      }
      open.append(head, el('span', item.description || 'Reusable agent profile', 'base-resource-description'), el('small', metadata(item))); row.append(open);
      const equipped = profileResources(item), loadout = el('div', undefined, 'base-agent-loadout'); loadout.setAttribute('aria-label', `Configured resources for ${item.name}`);
      for (const resource of equipped) {
        const toggle = check(resource.name, true); toggle.control.disabled = true; toggle.control.setAttribute('aria-label', `${resource.name} configured`); toggle.label.title = `${KINDS[resource.kind] || resource.kind} · configured for future runs`; loadout.append(toggle.label);
      }
      row.append(equipped.length ? loadout : p('No Base resources equipped.'), actions(button('Configure', () => openResource(item.id), 'text-button'), button('Apply to…', () => openApply(item), 'text-button')));
      return row;
    }
    function revealCategory(node) {
      const nav = $('#base-categories'), bounds = nav.getBoundingClientRect(), active = node.getBoundingClientRect();
      if (active.left < bounds.left) nav.scrollLeft += active.left - bounds.left;
      else if (active.right > bounds.right) nav.scrollLeft += active.right - bounds.right;
    }
    function createResource() {
      if (!leave()) return;
      if (categoryKind()) kindSelect.value = categoryKind();
      editResource({ kind: kindSelect.value, name: '', enabled: true, trust: ['mcp', 'tool'].includes(kindSelect.value) ? 'untrusted' : 'trusted', dependencies: [], configuration: {}, content: {} });
    }
    for (const [kind, label] of CATEGORIES) {
      const node = button('', () => {
        category = kind; if (categoryKind()) kindSelect.value = categoryKind(); kindSelect.disabled = Boolean(category);
        persistView(); renderList(); libraryScroll = 0; $('.base-list-panel').scrollTop = 0;
        revealCategory(node); context.closeSidebar?.();
      }, 'base-category');
      node.append(el('span', label), el('span', '', 'base-category-count')); node.dataset.kind = kind; node.setAttribute('aria-label', label); node.setAttribute('aria-pressed', String(kind === category)); $('#base-categories').append(node);
    }
    // Buttons provide Tab/Enter/Space; arrows and Home/End move focus without changing
    // the active filter. Only activation changes the collection.
    $('#base-categories').addEventListener('keydown', event => {
      const buttons = [...$('#base-categories').children], index = buttons.indexOf(document.activeElement);
      if (index < 0) return;
      let next = index;
      if (['ArrowRight', 'ArrowDown'].includes(event.key)) next = (index + 1) % buttons.length;
      else if (['ArrowLeft', 'ArrowUp'].includes(event.key)) next = (index + buttons.length - 1) % buttons.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = buttons.length - 1;
      else return;
      event.preventDefault(); buttons[next].focus(); revealCategory(buttons[next]);
    });
    $('#base-search').value = viewState.search; $('#base-search').maxLength = 200;
    $('#base-search').addEventListener('input', () => { persistView(); renderList(); });
    for (const [id, key, label, options] of [
      ['base-filter', 'filter', 'Availability', [['all', 'Any status'], ['enabled', 'Enabled'], ['disabled', 'Disabled']]],
      ['base-sort', 'sort', 'Sort', [['recently_updated', 'Recently Updated'], ['name', 'Name']]],
      ['base-view-mode', 'viewMode', 'View', [['grid', 'Grid'], ['list', 'List']]],
    ]) {
      const control = select(options, viewState[key]); control.id = id; control.setAttribute('aria-label', label);
      control.addEventListener('change', () => { viewState[key] = control.value; persistView(); renderList(); });
      $('#base-view-controls').append(field(label, control));
    }
    const kindSelect = select(Object.entries(KINDS), categoryKind() || 'skill'); kindSelect.id = 'base-new-kind'; kindSelect.setAttribute('aria-label', 'New resource type'); kindSelect.disabled = Boolean(category);
    const mobile = window.matchMedia?.('(max-width: 600px)');
    const placeCategories = () => {
      const parent = mobile?.matches ? $('#base-mobile-categories') : $('#base-sidebar-panel');
      const nav = $('#base-categories');
      if (nav.parentElement !== parent) { if (mobile?.matches) parent.append(nav); else parent.insertBefore(nav, $('.base-sidebar-note')); }
      const active = $('#base-categories [aria-pressed="true"]'); if (active) revealCategory(active);
    };
    mobile?.addEventListener?.('change', placeCategories); placeCategories();
    const restoreGlobals = button('Review restored global resources…', () => {
      const pending = state.pendingGlobalBaseImport;
      const box = el('div'); box.append(p('This backup contains global Base selections. Restoring them applies to future runs in every project that inherits them. Imported executable resources remain inactive and untrusted until reviewed.'), el('pre', JSON.stringify(pending, null, 2), 'base-code'));
      const fail = inlineError(box);
      box.append(actions(button('Cancel', closeDialog), busyButton('Restore global selections', async () => {
        try { await request('/api/base/restore-global', { method: 'POST', body: { confirm: true, expectedBaseRevision: state.revision } }); await context.refreshBoard?.(); await load(); closeDialog(); status('Restored global Base selections. No runs started.'); }
        catch (error) { fail(error); }
      })));
      openDialog('Restore global selections', [box]);
    }, 'text-button'); restoreGlobals.hidden = true;
    $('#base-actions').append(kindSelect, button('Create', createResource), button('Import…', openImport), button('Export…', () => openExport()), button('Context7 preset', createContext7, 'text-button'), restoreGlobals);

    function referenceFields(selected = [], { excludeId, kinds, label = 'Resources', exclusions = false } = {}) {
      const box = el('div', undefined, 'base-references'); box.setAttribute('role', 'group'); box.setAttribute('aria-label', label);
      const value = new Map(selected.map(item => [typeof item === 'string' ? item : item.resourceId, typeof item === 'string' ? true : item.required !== false]));
      const candidates = state.resources.filter(item => item.id !== excludeId && (!kinds || kinds.includes(item.kind)));
      for (const item of candidates) {
        const line = el('div', undefined, 'base-reference-row');
        const chosen = check(`${item.name} · ${KINDS[item.kind]}${item.enabled ? '' : ' · disabled'}`, value.has(item.id)); chosen.control.dataset.resource = item.id;
        line.append(chosen.label);
        if (!exclusions) {
          const required = check('Required', value.get(item.id) !== false); required.control.dataset.required = item.id; required.control.disabled = !chosen.control.checked;
          chosen.control.addEventListener('change', () => { required.control.disabled = !chosen.control.checked; }); line.append(required.label);
        }
        box.append(line);
      }
      // Keep unresolved references visible, rather than dropping them on an unrelated edit.
      for (const [id, required] of value) if (!candidates.some(item => item.id === id)) {
        const row = check(`Unavailable reference: ${id}`, true); row.control.dataset.resource = id; row.control.dataset.missingRequired = String(required); box.append(row.label);
      }
      if (!box.children.length) box.append(p('No resources yet. Create them in Base first.'));
      box.read = () => [...box.querySelectorAll('[data-resource]:checked')].map(node => exclusions ? node.dataset.resource : ({ resourceId: node.dataset.resource, required: box.querySelector(`[data-required="${node.dataset.resource}"]`)?.checked ?? node.dataset.missingRequired !== 'false' }));
      return box;
    }
    function bindingFields(binding = INHERIT, { excludeId, allowProfiles = true } = {}) {
      const box = el('div', undefined, 'base-binding-fields');
      const mode = select([['inherit', 'Inherit upstream resources'], ['extend', 'Extend — add and exclude'], ['replace', 'Replace — only this selection']], binding.mode || 'inherit'); mode.dataset.baseMode = 'true';
      const kinds = Object.keys(KINDS).filter(kind => allowProfiles || kind !== 'profile');
      const includes = referenceFields(binding.include || [], { excludeId, kinds, label: 'Include resources' });
      const excludes = referenceFields(binding.exclude || [], { excludeId, kinds, label: 'Exclude resources', exclusions: true });
      const selection = el('div'); selection.append(group('Include', includes), details('Exclude inherited resources', excludes));
      const update = () => { selection.hidden = mode.value === 'inherit'; };
      mode.addEventListener('change', update); update();
      box.append(field('Resource inheritance', mode), p('An empty Replace selection opts out of all inherited Base resources, including resources from profiles. Exclusions apply after expanding packs.'), selection);
      box.read = () => ({ mode: mode.value, include: mode.value === 'inherit' ? [] : includes.read(), exclude: mode.value === 'inherit' ? [] : excludes.read() });
      return box;
    }
    function showManifest(manifest = {}, provider) {
      const box = el('div', undefined, 'base-manifest');
      if (provider) box.append(p(`Effective provider: ${typeof provider === 'string' ? provider : provider.provider || 'CLI default'}${provider.model ? ` · ${provider.model}` : ''}`));
      const entries = manifest.resources || manifest.entries || manifest.configured || [];
      if (!entries.length) box.append(p('No Base resources resolve here.'));
      const list = el('ul');
      for (const item of entries) {
        const id = item.resourceId || item.id; const origin = item.origins || item.origin;
        const origins = Array.isArray(origin) ? origin.map(value => typeof value === 'string' ? value : value.scope || value.label || '').filter(Boolean).join(' → ') : typeof origin === 'string' ? origin : origin?.scope || '';
        const delivery = typeof item.delivery === 'string' ? item.delivery : item.delivery?.method || item.deliveryMethod || 'pending validation';
        const row = el('li'); row.append(el('strong', item.name || nameOf(id)), ` · ${item.required ? 'required' : 'optional'} · ${delivery}${origins ? ` · from ${origins}` : ''}${item.revision ? ` · r${item.revision}` : ''}`);
        for (const warning of [item.reason, item.incompatibility, ...(item.issues || []), ...(item.warnings || []), ...(item.failures || [])].filter(Boolean)) row.append(p(typeof warning === 'string' ? warning : warning.message || warning.code || 'Unavailable'));
        list.append(row);
      }
      box.append(list);
      for (const [key, label] of [['exclusions', 'Excluded'], ['warnings', 'Warning'], ['errors', 'Blocked'], ['failures', 'Blocked']]) {
        for (const value of manifest[key] || []) box.append(p(`${label}: ${typeof value === 'string' ? value : value.message || value.reason || nameOf(value.resourceId || value.id)}`));
      }
      if (manifest.blocked || manifest.valid === false || manifest.errors?.length) box.append(el('p', 'Required resources cannot currently be delivered. A run will be blocked until the issue is resolved.', 'inline-error'));
      return box;
    }
    function picker({ target, label = 'Base resources', provider, inactive = false } = {}) {
      const box = el('div', undefined, 'base-picker');
      const open = button(`${label}…`, () => openPicker(target, { provider, inactive }), 'text-button'); open.dataset.baseTarget = targetKey(target);
      box.append(open, p(inactive ? 'Stored here, inactive while this column has no agent.' : 'Optional · changes apply to future runs.'));
      return box;
    }
    async function openPicker(target, { provider, inactive = false } = {}) {
      openDialog('Base resources', [p('Loading assignments…')]);
      try {
        await load();
        const expectedBaseRevision = state.revision;
        const entry = state.targets.find(item => targetKey(item.target) === targetKey(target));
        if (!entry) throw new Error('This configuration target no longer exists. Reload the board.');
        const fields = bindingFields(entry.binding || INHERIT, { allowProfiles: false });
        const preview = el('div', undefined, 'base-preview');
        const form = el('form');
        form.append(p(entry.label || 'Configuration scope'), p('Saved selections configure future accepted runs. They do not reconfigure a running CLI session.'), fields);
        const canProfile = ['global', 'project', 'column'].includes(target.scope);
        const profile = select([['', 'No agent profile'], ...state.resources.filter(item => item.kind === 'profile').map(item => [item.id, item.name])], entry.profileId || ''); profile.dataset.baseProfile = 'true';
        if (canProfile) form.append(field('Reusable agent profile', profile), p('Choosing a profile is an explicit agent configuration change: its provider, model, effort, instructions, and resources become defaults at this scope. Explicit agent settings at this same scope take priority.'));
        if (inactive || entry.columnActive === false) form.append(p('This column has no active agent. Saving resources does not enable it.'));
        const fail = inlineError(form);
        let sequence = 0;
        const updatePreview = async () => {
          const current = ++sequence; preview.replaceChildren(p('Resolving…'));
          try {
            const data = await request('/api/base/preview', { method: 'POST', body: { target, binding: fields.read(), ...(canProfile ? { profileId: profile.value || null } : {}) } });
            if (current === sequence) preview.replaceChildren(showManifest(data.manifest, data.provider || entry.provider || provider));
          } catch (error) { if (current === sequence) preview.replaceChildren(el('p', error.message, 'inline-error')); }
        };
        form.append(group('Effective resources', preview));
        const save = el('button', 'Save Base resources', 'dialog-done'); save.type = 'submit';
        form.append(actions(button('Cancel', closeDialog), save));
        form.addEventListener('submit', async event => {
          event.preventDefault(); save.disabled = true; fail('');
          try {
            await request('/api/base/apply', { method: 'POST', body: { expectedBaseRevision, changes: [{ target, binding: fields.read(), ...(canProfile ? { profileId: profile.value || null } : {}), expectedRevision: entry.revision }] } });
            await context.refreshBoard?.(); await load(); closeDialog(); context.announce?.('Base resources saved for future runs.');
          } catch (error) { fail(error); } finally { save.disabled = false; }
        });
        let timer;
        form.addEventListener('change', () => { clearTimeout(timer); timer = setTimeout(updatePreview, 120); });
        openDialog('Base resources', [form]); updatePreview();
      } catch (failure) { openDialog('Base resources', [el('p', failure.message, 'inline-error'), button('Close', closeDialog)]); }
    }

    async function openResource(id, force) {
      if (!leave(force)) return;
      if (!editingKind) libraryScroll = $('.base-list-panel').scrollTop;
      const current = ++requestVersion; chosen = id; editingKind = resource(id)?.kind || null; renderList(); $('#base-detail').replaceChildren(p('Loading resource…'));
      try { const data = await request(`/api/base/resources/${encodeURIComponent(id)}`); if (current === requestVersion) editResource(data.resource || data); }
      catch (failure) { if (current === requestVersion) $('#base-detail').replaceChildren(el('p', failure.message, 'inline-error')); }
    }
    function editResource(original) {
      const item = clone(original); item.configuration ||= {}; item.content ||= {};
      const expectedBaseRevision = state.revision, editorVersion = ++requestVersion;
      chosen = item.id || null; editingKind = item.kind; renderList();
      const form = el('form', undefined, 'base-resource-form'); form.dataset.kind = item.kind;
      const heading = el('h2', item.id ? item.name : `New ${KINDS[item.kind].toLowerCase()}`);
      form.append(button('Back to library', () => closeResource(), 'text-button'), heading);
      if (item.id) form.append(p(metadata(item)));
      const name = input(item.name, 120); name.required = true; name.id = 'base-resource-name';
      const description = area(item.description || '', 2000); description.rows = 2;
      const tags = input((item.tags || []).join(', '), 1000);
      const enabled = check('Available for assignment and future runs', item.enabled !== false); enabled.control.id = 'base-resource-enabled';
      const trust = select([['untrusted', 'Untrusted'], ['trusted', 'Trusted by me'], ['revoked', 'Trust revoked']], item.trust || 'untrusted'); trust.id = 'base-resource-trust';
      form.append(field('Name', name), details('Description and tags', field('Description', description), field('Tags (comma separated)', tags)), actions(enabled.label, field('Trust', trust)));
      form.append(p('Availability and trust do not assign this resource, start agents, install packages, or test connections.'));
      const config = kindEditor(item, form);
      const dependencies = referenceFields(item.dependencies || [], { excludeId: item.id, label: 'Dependencies' });
      form.append(details('Dependencies', p('Required dependencies must resolve too. Excluded dependencies are never silently added back.'), dependencies));
      if (item.id) {
        const used = item.usedBy || resource(item.id)?.usedBy || [];
        const usedList = el('ul'); for (const where of used) usedList.append(el('li', typeof where === 'string' ? where : where.label || where.name || targetKey(where.target || where)));
        form.append(details(`Used by (${used.length})`, used.length ? usedList : p('No current assignments or dependencies. Historical run revisions are retained.')));
        const compatibility = item.compatibility || resource(item.id)?.compatibility;
        if (compatibility) form.append(details('Provider compatibility', el('pre', JSON.stringify(compatibility, null, 2), 'base-code')));
        form.append(revisionHistory(item));
        if (item.connectionTest || item.connection) form.append(details('Last connection test', el('pre', JSON.stringify(item.connectionTest || item.connection, null, 2), 'base-code')));
      }
      const fail = inlineError(form);
      const save = el('button', 'Save resource', 'dialog-done'); save.type = 'submit'; save.id = 'base-resource-save';
      const footer = actions(save, button('Cancel', () => { if (item.id) openResource(item.id, true); else closeResource(true); }));
      if (item.id) footer.append(button('Apply to…', () => openApply(item)), button('Export…', () => openExport(item.id)), button('Delete…', () => openDelete(item), 'text-button'));
      form.append(footer);
      form.addEventListener('submit', async event => {
        event.preventDefault(); if (!name.value.trim()) { name.focus(); fail('Give this resource a name.'); return; }
        fail(''); save.disabled = true;
        try {
          const values = config.read();
          const { skillImport, ...resourceValues } = values;
          const body = skillImport ? { markdown: skillImport.markdown, files: skillImport.files, name: name.value.trim(), description: description.value, tags: tags.value.split(',').map(value => value.trim()).filter(Boolean), expectedBaseRevision }
            : { kind: item.kind, name: name.value.trim(), description: description.value, tags: tags.value.split(',').map(value => value.trim()).filter(Boolean), enabled: enabled.control.checked, trust: trust.value, dependencies: dependencies.read(), ...resourceValues, expectedBaseRevision, ...(item.id ? { expectedRevision: item.revision } : {}) };
          const data = await request(skillImport ? '/api/base/skills/import' : item.id ? `/api/base/resources/${encodeURIComponent(item.id)}` : '/api/base/resources', { method: item.id && !skillImport ? 'PATCH' : 'POST', body });
          const savedId = data.resource?.id || data.id || item.id;
          await load(); if (savedId && editorVersion === requestVersion) await openResource(savedId, true);
          status('Saved. No assignments changed.'); context.announce?.('Base resource saved.');
        } catch (error) { fail(error); } finally { save.disabled = false; }
      });
      $('#base-detail').replaceChildren(form);
      if (!item.id) name.focus();
      const editable = () => ({ name: name.value, description: description.value, tags: tags.value, enabled: enabled.control.checked, trust: trust.value, dependencies: dependencies.read(), ...config.read() });
      let savedDraft = JSON.stringify(editable()), touched = false;
      // Unsaved means changed by the person. Fields filled in later (a model list) are not edits, so until the
      // first edit the baseline is read again just before each interaction. A field that no longer reads counts as changed.
      for (const type of ['pointerdown', 'keydown']) form.addEventListener(type, () => { if (!touched) try { savedDraft = JSON.stringify(editable()); } catch {} }, true);
      for (const type of ['input', 'change', 'click']) form.addEventListener(type, () => { touched = true; });
      form.isDirty = () => { if (!touched) return false; try { return JSON.stringify(editable()) !== savedDraft; } catch { return true; } };
      // Discovery and refresh publish new immutable revisions too. Keep their editor
      // synchronized, without discarding a draft or allowing saves during the operation.
      form.savedAction = async (action, success) => {
        let result = el('div'); form.append(result);
        try {
          if (JSON.stringify(editable()) !== savedDraft) throw new Error('Save your edits before testing or refreshing this resource.');
        } catch (error) { result.append(el('p', error.message, 'inline-error')); return; }
        const controls = [...form.querySelectorAll('input, textarea, select, button')].map(node => [node, node.disabled]);
        controls.forEach(([node]) => { node.disabled = true; });
        let data, failure;
        try { data = await action(); } catch (error) { failure = error; }
        try {
          // Failed tests also persist a connection result and advance the revision.
          await load();
          if (form.isConnected && chosen === item.id) {
            await openResource(item.id, true);
            const current = $('#base-detail .base-resource-form');
            if (current && chosen === item.id) { result = el('div'); current.append(result); }
          }
          result.replaceChildren(failure ? el('p', failure.message, 'inline-error') : success(data));
        } catch (error) { result.replaceChildren(el('p', (failure || error).message, 'inline-error')); }
        finally { controls.forEach(([node, disabled]) => { node.disabled = disabled; }); }
      };
    }
    function fileEditor(files = [], label = 'Supporting files') {
      const list = el('div', undefined, 'base-files');
      const add = value => {
        const row = el('div', undefined, 'base-file'); const path = input(value.path || '', 500); const text = area(value.text || '');
        path.placeholder = 'references/guide.md';
        row.append(field('Relative file path', path), field('Text content', text), button('Remove file', () => row.remove(), 'text-button'));
        row.read = () => ({ path: path.value.trim(), text: text.value }); list.append(row);
      };
      files.forEach(add);
      const box = details(label, p('Files remain inert. Scripts are stored as supporting material and are never executed by importing a skill.'), list, button('Add supporting file', () => add({})));
      box.read = () => [...list.children].map(row => row.read()); return box;
    }
    function environmentEditor(value = {}, heading) {
      const text = area(Object.entries(value).map(([key, reference]) => `${key}=${typeof reference === 'string' ? reference : reference.env || ''}`).join('\n'), 10000); text.rows = 3;
      const box = field(heading, text, 'One NAME=ENVIRONMENT_VARIABLE per line. Store variable names only, never passwords or tokens.');
      box.read = () => Object.fromEntries(lineValues(text.value).map(line => {
        const at = line.indexOf('='); if (at < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(at + 1))) throw new Error(`${heading}: use NAME=ENVIRONMENT_VARIABLE references.`);
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      })); return box;
    }
    function kindEditor(item, form) {
      const config = item.configuration, content = item.content;
      if (item.kind === 'skill') {
        let importedSkill = false;
        const text = area(content.body || '', 200000); text.id = 'base-skill-body'; text.rows = 12;
        const files = fileEditor(content.files);
        const imported = Object.assign(el('input'), { type: 'file', accept: '.md,.markdown,text/markdown,text/plain' }); imported.id = 'base-skill-import';
        const importStatus = p('');
        imported.addEventListener('change', async () => {
          const file = imported.files?.[0]; if (!file) return;
          try { if (file.size > 256 * 1024 || basename(file.name).toLowerCase() !== 'skill.md') throw new Error('Select a SKILL.md file up to 256 KiB.'); text.value = await file.text(); importedSkill = true; importStatus.textContent = 'Imported into this draft. Save validates SKILL.md and creates a separate disabled, untrusted skill. No scripts run.'; }
          catch (error) { importStatus.textContent = error.message; }
        });
        const preview = el('div'); const previewButton = button('Preview instructions', () => preview.replaceChildren(markdown(text.value)), 'text-button');
        form.append(field('Instructions / SKILL.md', text), p('Instruction delivery: this text is appended separately to the existing agent message. It is not native skill installation.'), details('Import SKILL.md', field('Instruction file', imported), importStatus), files, previewButton, preview);
        return { read: () => ({ configuration: { ...config, format: 'instruction', ...(text.value.startsWith('---') ? { entrypoint: 'SKILL.md' } : {}) }, content: { ...content, body: text.value, files: files.read() }, ...(importedSkill ? { skillImport: { markdown: text.value, files: files.read() } } : {}) }) };
      }
      if (item.kind === 'mcp') {
        const transport = select([['stdio', 'stdio — local process'], ['streamable-http', 'Streamable HTTP']], config.transport || 'stdio');
        const command = input(config.command || '', 4096), args = area((config.args || []).join('\n'), 16000), endpoint = input(config.endpoint || '', 4096);
        args.rows = 3; endpoint.placeholder = 'https://mcp.example.com/mcp';
        const env = environmentEditor(config.env, 'Environment references'); const headers = environmentEditor(config.headers, 'HTTP header references');
        const auth = check('This server requires authentication', config.auth?.required || config.authRequired || false); const authDescription = input(config.auth?.description || '', 2000);
        const stdio = group('Local server', field('Executable', command), field('Arguments (one per line; no shell)', args), env);
        const http = group('HTTP server', field('Endpoint', endpoint), headers);
        const update = () => { stdio.hidden = transport.value !== 'stdio'; http.hidden = transport.value === 'stdio'; }; transport.addEventListener('change', update); update();
        form.append(field('Transport', transport), stdio, http, auth.label, field('Authentication requirements', authDescription), p('MCP is available only where the agent adapter can safely deliver it. Planning and Code Review do not receive Base MCP servers. A connection test starts the configured server or contacts its endpoint; trust and an explicit action are required.'));
        if (item.id) form.append(button('Test connection and discover tools', () => form.savedAction(
          () => request(`/api/base/resources/${encodeURIComponent(item.id)}/test`, { method: 'POST', body: { expectedRevision: item.revision }, timeoutMs: 30000 }),
          data => { const result = el('div'); result.append(p('Connection test completed. This does not prove authenticated agent compatibility.'), el('pre', JSON.stringify(data.connection || data.result || data, null, 2), 'base-code')); return result; }
        )));
        return { read: () => ({ configuration: { ...config, transport: transport.value, ...(transport.value === 'stdio' ? { command: command.value.trim(), args: lineValues(args.value), env: env.read() } : { endpoint: endpoint.value.trim(), headers: headers.read() }), auth: { required: auth.control.checked, description: authDescription.value } }, content }) };
      }
      if (item.kind === 'knowledge') return knowledgeEditor(item, form);
      if (item.kind === 'context') {
        const sourceList = el('div', undefined, 'base-sources');
        const add = source => {
          const row = el('div', undefined, 'base-source-editor');
          const kind = select([['repository', 'Repository files'], ['external', 'Approved external files'], ['knowledge', 'Knowledge collection'], ['url', 'Documentation URL']], source.kind || 'repository');
          const path = input(source.path || '', 4096); path.placeholder = 'docs/';
          const root = select([['', 'Choose an approved root'], ...(state.approvedRoots || []).map(item => [item.id, item.path || item.name || item.id])], source.rootId || '');
          const url = input(source.url || '', 4096); url.placeholder = 'https://docs.example.com/guide';
          const knowledge = select([['', 'Choose a collection'], ...state.resources.filter(item => item.kind === 'knowledge').map(item => [item.id, item.name])], source.resourceId || '');
          const pathField = field('Relative path or folder', path), rootField = field('Approved root', root), urlField = field('URL', url), knowledgeField = field('Collection', knowledge);
          const update = () => { pathField.hidden = !['repository', 'external'].includes(kind.value); rootField.hidden = kind.value !== 'external'; urlField.hidden = kind.value !== 'url'; knowledgeField.hidden = kind.value !== 'knowledge'; };
          kind.addEventListener('change', update); update();
          row.append(field('Source', kind), pathField, rootField, urlField, knowledgeField, button('Remove source', () => row.remove(), 'text-button'));
          row.read = () => ({ kind: kind.value, ...(['repository', 'external'].includes(kind.value) ? { path: path.value.trim() } : {}), ...(kind.value === 'external' ? { rootId: root.value } : {}), ...(kind.value === 'knowledge' ? { resourceId: knowledge.value } : {}), ...(kind.value === 'url' ? { url: url.value.trim() } : {}) }); sourceList.append(row);
        };
        (config.sources || []).forEach(add);
        const budget = Object.assign(input(String(config.budgetChars || 24000)), { type: 'number', min: '1000', max: '100000', step: '1000' });
        const maxFiles = Object.assign(input(String(config.maxFiles || 30)), { type: 'number', min: '1', max: '100' });
        form.append(sourceList, actions(button('Add source', () => add({})), button('Manage external roots…', approveRoot, 'text-button')), field('Context budget (characters)', budget), field('Maximum files', maxFiles), p('Repository paths resolve in the task worktree at launch. Secret files, dependency folders, symlinks outside approved roots, and generated output are excluded. Supplied captures record their time and content hash; omitted material is reported. Token counts are estimates.'));
        if (item.id) form.append(sourceTools(item, form));
        return { read: () => ({ configuration: { ...config, sources: [...sourceList.children].map(row => row.read()), budgetChars: Number(budget.value), maxFiles: Number(maxFiles.value) }, content }) };
      }
      if (item.kind === 'tool') {
        const delivery = select([['command-recipe', 'Command recipe (instructions)'], ['mcp', 'Discovered MCP tool']], config.delivery || 'command-recipe');
        const command = input(config.command || '', 4096), args = area((config.args || []).join('\n'), 16000); args.rows = 3;
        const server = select([['', 'Choose MCP server'], ...state.resources.filter(item => item.kind === 'mcp').map(item => [item.id, item.name])], config.serverId || '');
        const tool = select([], ''); const identity = p('Tool identity comes from the parent server’s last explicit connection test.');
        const refreshTools = (keep = tool.value) => {
          const parent = resource(server.value), discovered = parent?.connectionTest?.tools || parent?.connection?.tools || [];
          tool.replaceChildren(option('', discovered.length ? 'Choose a discovered tool' : 'Test this server to discover tools'), ...discovered.map(item => option(item.name, item.name)));
          if (keep && !discovered.some(item => item.name === keep)) tool.append(option(keep, `${keep} · not in latest discovery`));
          tool.value = keep || '';
        };
        server.addEventListener('change', () => refreshTools('')); refreshTools(config.toolName);
        const recipe = group('Command recipe', field('Command', command), field('Arguments (one per line)', args), p('Supplied as instructions, subject to the CLI’s existing shell permissions. This is not a registered native tool and is never executed by Promptboard.'));
        const mcp = group('MCP identity', field('Parent server', server), field('Discovered tool name', tool), identity, p('Selecting one tool can expose other tools from its server unless the adapter enforces filtering. The server remains a required dependency.'));
        const update = () => { recipe.hidden = delivery.value !== 'command-recipe'; mcp.hidden = delivery.value !== 'mcp'; }; delivery.addEventListener('change', update); update();
        form.append(field('Delivery method', delivery), recipe, mcp);
        return { read: () => ({ configuration: { ...config, delivery: delivery.value, ...(delivery.value === 'mcp' ? { serverId: server.value, toolName: tool.value.trim() } : { command: command.value, args: lineValues(args.value) }) }, content }) };
      }
      if (item.kind === 'profile') {
        const agent = context.agentFields(config.agent || {}, { inherit: 'Inherit provider at the assigned scope' });
        const instructions = area(config.agent?.instructions || '', 4000);
        const binding = bindingFields(config.binding || { mode: 'extend', include: [], exclude: [] }, { excludeId: item.id });
        let portrait = config.avatar ? clone(config.avatar) : undefined;
        let image = content.avatar;
        const avatarPrompt = input(portrait?.prompt || '', 2000); avatarPrompt.id = 'base-avatar-prompt'; avatarPrompt.placeholder = 'Purple-haired engineer with glasses';
        const preview = el('div', undefined, 'base-avatar-editor'); preview.append(avatar(image, item.id || item.name));
        const feedback = p(''), errors = el('div'), fail = inlineError(errors); let operationId;
        const cancel = button('Cancel avatar generation', async () => { try { if (operationId) await request('/api/base/avatar/cancel', { method: 'POST', body: { operationId } }); } catch (error) { fail(error); } }); cancel.hidden = true;
        const generate = busyButton('Generate avatar', async () => {
          fail(''); if (!avatarPrompt.value.trim()) { fail('Describe the illustrated face you want.'); return; }
          operationId = `avatar_${globalThis.crypto?.randomUUID?.() || Date.now().toString(36)}`; cancel.hidden = false; feedback.textContent = 'Generating an illustration…';
          const save = form.querySelector('#base-resource-save'); if (save) save.disabled = true;
          try {
            const data = await request('/api/base/avatar/generate', { method: 'POST', body: { prompt: avatarPrompt.value, operationId, ...(item.id ? { resourceId: item.id, expectedRevision: item.revision } : {}) }, timeoutMs: 240000 });
            portrait = data.avatar; image = data.image; preview.replaceChildren(avatar(image)); feedback.textContent = 'Preview ready. Save the profile to keep this face.';
          } catch (error) { fail(error); feedback.textContent = ''; }
          finally { operationId = null; cancel.hidden = true; if (save) save.disabled = false; }
        }); generate.id = 'base-avatar-generate';
        form.append(group('Agent identity', preview, field('Avatar prompt', avatarPrompt), actions(generate, cancel, button('Reset avatar', () => { portrait = undefined; image = undefined; avatarPrompt.value = ''; preview.replaceChildren(avatar(null, item.id)); }, 'text-button')), feedback, errors, p('AI illustrations use OpenAI Images and require an API key in the server environment (OPENAI_API_KEY by default). Your prompt is sent to that service only when you generate. Save the profile to keep the reviewed face.')),
          group('Agent defaults', agent, field('Agent instructions', instructions)), group('Base resources', binding), p('Attach any Base resource, pack, or another profile by reference. Attached profile instructions and resources do not change this agent’s provider or permissions. Separate subagent execution depends on CLI support. Cycles are rejected.'));
        return { read: () => { const nextContent = { ...content }; if (image) nextContent.avatar = image; else delete nextContent.avatar;
          return { configuration: { ...config, avatar: portrait, agent: { ...(context.readAgentFields(agent) || {}), instructions: instructions.value }, binding: binding.read() }, content: nextContent }; } };
      }
      if (item.kind === 'pack') {
        const refs = referenceFields(config.resources || [], { excludeId: item.id, kinds: Object.keys(KINDS).filter(kind => !['pack', 'profile'].includes(kind)) });
        form.append(group('Pack contents', refs), p('Packs contain resources by reference. Nested packs and agent profiles are not allowed. Attaching this pack never changes provider settings.'));
        return { read: () => ({ configuration: { ...config, resources: refs.read() }, content }) };
      }
      return { read: () => ({ configuration: config, content }) };
    }

    function knowledgeEditor(item, form) {
      const content = item.content;
      const pages = clone(content.pages || []), sources = clone(content.sources || []);
      let pageIndex = 0;
      const pageSelect = select([], ''), pageTitle = input('', 160), pageBody = area('', 200000), pageLinks = input('', 2000);
      pageSelect.setAttribute('aria-label', 'Wiki page'); pageBody.id = 'base-wiki-markdown'; pageBody.rows = 12;
      const editor = el('div'), preview = el('div'), sourceList = el('div', undefined, 'base-source-list');
      const flush = () => { if (pages[pageIndex]) Object.assign(pages[pageIndex], { title: pageTitle.value, markdown: pageBody.value, links: pageLinks.value.split(',').map(value => value.trim()).filter(Boolean) }); };
      const renderPage = () => {
        pageSelect.replaceChildren(...pages.map((page, index) => option(String(index), page.title || page.id)));
        pageSelect.value = String(pageIndex); editor.hidden = !pages.length;
        const page = pages[pageIndex]; pageTitle.value = page?.title || ''; pageBody.value = page?.markdown || ''; pageLinks.value = (page?.links || []).join(', '); preview.replaceChildren();
      };
      const addPage = () => { flush(); pages.push({ id: `page_${globalThis.crypto?.randomUUID?.() || Date.now().toString(36)}`, title: 'Untitled page', markdown: '', links: [], provenance: {} }); pageIndex = pages.length - 1; renderPage(); pageTitle.focus(); };
      pageSelect.addEventListener('change', () => { const next = Number(pageSelect.value); flush(); pageIndex = next; renderPage(); });
      const showPreview = () => { flush(); preview.replaceChildren(markdown(pageBody.value, id => { const next = pages.findIndex(page => page.id === id); if (next >= 0) { flush(); pageIndex = next; renderPage(); showPreview(); } })); };
      editor.append(field('Page title', pageTitle), field('Markdown', pageBody), field('Linked page IDs (comma separated)', pageLinks), p('Link pages with [[page_id]], [[page_id|label]], or [label](base:page_id). HTML is displayed as text.'), actions(button('Preview page', showPreview, 'text-button'), button('Remove page', () => { pages.splice(pageIndex, 1); pageIndex = Math.max(0, pageIndex - 1); renderPage(); }, 'text-button')), preview);
      form.append(group('Wiki pages', actions(pageSelect, button('Add page', addPage)), editor)); renderPage();
      const renderSources = () => {
        sourceList.replaceChildren(...sources.map((source, index) => {
          const title = input(source.name || source.id, 200), text = area(source.text || '', 200000), origin = input(source.provenance?.url || source.provenance?.path || source.provenance?.source || '', 4096);
          const row = details(source.name || source.id, field('Source name', title), field('Source text', text), field('Original path or URL (provenance only)', origin));
          title.addEventListener('input', () => { source.name = title.value; row.firstChild.textContent = title.value || source.id; }); text.addEventListener('input', () => { source.text = text.value; }); origin.addEventListener('input', () => { const provenance = { ...source.provenance }; delete provenance.path; delete provenance.url; if (origin.value) provenance[/^https?:\/\//i.test(origin.value) ? 'url' : 'path'] = origin.value; source.provenance = provenance; });
          if (source.provenance?.hash || source.provenance?.capturedAt) row.append(p(`Capture: ${source.provenance.capturedAt || 'not recorded'} · hash ${source.provenance.hash || 'recorded on save'}`));
          row.append(button('Remove source', () => { sources.splice(index, 1); renderSources(); }, 'text-button')); return row;
        }));
      };
      const fileInput = Object.assign(el('input'), { type: 'file', accept: '.md,.markdown,.txt,text/plain,text/markdown', multiple: true }); fileInput.id = 'base-source-files';
      const folderInput = Object.assign(el('input'), { type: 'file', multiple: true }); folderInput.setAttribute('webkitdirectory', ''); folderInput.id = 'base-source-folder';
      const sourceStatus = p('');
      const importFiles = async input => {
        const files = [...(input.files || [])];
        try {
          if (files.length > 100) throw new Error('Choose at most 100 source files.');
          let bytes = 0, omitted = 0, imported = 0;
          for (const file of files) {
            const path = file.webkitRelativePath || file.name;
            if (!/\.(md|markdown|txt)$/i.test(path) || /(?:^|[/\\])(?:\.env[^/\\]*|\.git|node_modules|dist|build|coverage|vendor|\.ssh|\.aws|credentials|secrets?)(?:[/\\.]|$)/i.test(path)) { omitted++; continue; }
            bytes += file.size; if (file.size > 256 * 1024 || bytes > 3 * 1024 * 1024) throw new Error('Source import is limited to 256 KiB per file and 3 MiB total.');
            sources.push({ id: `source_${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${sources.length}`}`, name: basename(path), text: await file.text(), provenance: { path, capturedAt: new Date().toISOString(), method: 'user-selected-file' } }); imported++;
          }
          renderSources(); sourceStatus.textContent = `${imported} sources added to this draft; ${omitted} unsupported, secret, or generated files omitted. Save to persist.`;
        } catch (error) { sourceStatus.textContent = error.message; }
      };
      fileInput.addEventListener('change', () => importFiles(fileInput)); folderInput.addEventListener('change', () => importFiles(folderInput));
      const url = input('', 4096); url.placeholder = 'https://docs.example.com/guide';
      const importUrl = busyButton('Fetch documentation for review', async () => {
        try { const data = await request('/api/base/source/import', { method: 'POST', body: { url: url.value }, timeoutMs: 30000 }); if (!data.source) throw new Error('No source text was returned.'); sources.push(data.source); renderSources(); sourceStatus.textContent = 'Documentation added to this draft for review. Save to persist; nothing is assigned.'; }
        catch (error) { sourceStatus.textContent = error.message; }
      });
      form.append(group('Sources', p('Paste content or explicitly select Markdown/text files. Basic wiki editing and search work without a model.'), sourceList, button('Paste a source', () => { sources.push({ id: `source_${globalThis.crypto?.randomUUID?.() || Date.now().toString(36)}`, name: 'Pasted source', text: '', provenance: { method: 'paste', capturedAt: new Date().toISOString() } }); renderSources(); sourceList.lastChild.open = true; }), details('Import selected files or a folder', field('Markdown/text files', fileInput), field('Folder (bounded text selection)', folderInput)), details('Import documentation URL', field('Public documentation URL', url), p('Text is fetched only by this action. Redirects, size, and network destinations are validated.'), importUrl), sourceStatus));
      renderSources();
      if (item.id) form.append(sourceTools(item, form), button('Generate/update from sources…', () => openWikiGenerate(item), 'secondary-button'), p('Generation uses the saved sources. Save manual edits first. Proposed changes remain a reviewable draft until you apply them.'));
      return { read: () => { flush(); return { configuration: item.configuration, content: { ...content, pages, sources } }; } };
    }
    function sourceTools(item, form) {
      const box = el('div', undefined, 'base-source-tools');
      const query = input('', 500); query.placeholder = 'Search saved source text…'; query.setAttribute('aria-label', 'Search sources');
      const result = el('div');
      const projects = state.targets.filter(entry => entry.target.scope === 'project');
      const repositoryProject = select([['', 'Choose project for repository sources'], ...projects.map(entry => [entry.target.projectId, entry.label || entry.name || entry.target.projectId])], '');
      const needsProject = item.configuration?.sources?.some(source => source.kind === 'repository');
      repositoryProject.hidden = !needsProject; repositoryProject.setAttribute('aria-label', 'Project used to preview repository context');
      const search = busyButton('Search sources', async () => {
        try { const data = await request(`/api/base/resources/${encodeURIComponent(item.id)}/search?q=${encodeURIComponent(query.value)}`); result.replaceChildren(); for (const match of data.results || data.matches || []) { result.append(el('h4', match.title || match.name || match.sourceId || 'Source'), p(match.excerpt || match.text || ''), p(match.provenance?.url || match.provenance?.path || '')); } if (!result.children.length) result.append(p('No matching source passages.')); }
        catch (error) { result.replaceChildren(el('p', error.message, 'inline-error')); }
      });
      const refresh = button('Refresh saved sources', () => form.savedAction(async () => {
        if (needsProject && !repositoryProject.value) throw new Error('Choose a project for this repository source preview. Runs still use their own worktree.');
        return request(`/api/base/resources/${encodeURIComponent(item.id)}/refresh`, { method: 'POST', body: { expectedRevision: item.revision, ...(repositoryProject.value ? { projectId: repositoryProject.value } : {}) }, timeoutMs: 60000 });
      }, data => p(data.message || 'Sources refreshed. Live content is captured with its retrieval time and content hash.')));
      box.append(repositoryProject, actions(query, search, refresh), result); return box;
    }
    function revisionHistory(item) {
      const revisions = item.revisions || Array.from({ length: Math.min(item.revision || 1, 100) }, (_, index) => (item.revision || 1) - index);
      const selected = select(revisions.map(value => [String(typeof value === 'object' ? value.revision : value), `Revision ${typeof value === 'object' ? value.revision : value}`]), String(item.revision));
      const output = el('div');
      return details('Revision history', actions(selected, busyButton('View revision', async () => {
        try { const data = await request(`/api/base/resources/${encodeURIComponent(item.id)}/revisions/${encodeURIComponent(selected.value)}`); const saved = data.resource || data; output.replaceChildren(p(`Immutable revision ${saved.revision || selected.value}; viewing does not replace current content.`), el('pre', JSON.stringify(saved.content || saved, null, 2), 'base-code')); }
        catch (error) { output.replaceChildren(el('p', error.message, 'inline-error')); }
      }, 'text-button')), output);
    }
    async function createContext7() {
      if (!leave()) return;
      try {
        const data = await request('/api/base/presets');
        const preset = data.presets?.find(item => item.name === 'Context7');
        if (!preset) throw new Error('The Context7 preset is unavailable.');
        editResource({ ...preset, enabled: false, trust: 'untrusted', dependencies: preset.dependencies || [], content: {} });
      } catch (failure) { error(failure.message); }
    }
    async function approveRoot() {
      const path = input('', 4096); path.placeholder = '/absolute/path/to/documents';
      const confirmation = check('I approve read access beneath this folder for explicitly selected context sources.');
      const form = el('form'); form.append(field('External filesystem root', path), p('Real paths and symlink containment are validated. Approving a root does not attach its content to an agent.'), confirmation.label);
      const fail = inlineError(form), save = el('button', 'Approve root', 'dialog-done'); save.type = 'submit'; form.append(actions(button('Cancel', closeDialog), save));
      if (state.approvedRoots?.length) {
        const roots = el('div');
        for (const root of state.approvedRoots) {
          const row = el('div'); row.append(p(root.path || root.id), busyButton('Revoke root approval', async () => {
            try { await request(`/api/base/roots/${encodeURIComponent(root.id)}`, { method: 'DELETE', body: { expectedBaseRevision: state.revision } }); row.remove(); await load(); context.announce?.('External root approval revoked for future launches.'); }
            catch (error) { fail(error); }
          }, 'text-button')); roots.append(row);
        }
        form.append(group('Approved roots', p('Revocation blocks future launches that require these files. It does not remove context already supplied to a live process.'), roots));
      }
      form.addEventListener('submit', async event => {
        event.preventDefault(); if (!confirmation.control.checked) { fail('Confirm read access for this root.'); return; } save.disabled = true;
        try { await request('/api/base/roots', { method: 'POST', body: { path: path.value, confirm: true, expectedBaseRevision: state.revision } }); await load(); closeDialog(); status('Root approved. Reopen this context editor to select it.'); }
        catch (error) { fail(error); } finally { save.disabled = false; }
      });
      openDialog('Approve external folder', [form]);
    }
    async function openApply(item) {
      openDialog('Apply to…', [p('Loading targets…')]);
      try {
        await context.refreshBoard?.(); await load();
        const targets = state.targets.filter(entry => entry.target.scope !== 'profile');
        const form = el('form'), list = el('div', undefined, 'base-apply-targets'), preview = el('div');
        const mode = select([['extend', 'Add to current selection'], ['replace', 'Replace local selection']], 'extend');
        const required = check('Required: block the run if this resource cannot be delivered', true);
        for (const entry of targets) { const row = check(entry.label || targetKey(entry.target)); row.control.dataset.targetKey = targetKey(entry.target); list.append(row.label); }
        form.append(p(`Apply “${item.name}” by reference. No task starts, provider changes, permissions are granted, or software is installed.`), field('Assignment operation', mode), required.label, list, preview);
        const fail = inlineError(form);
        const selected = () => targets.filter(entry => [...list.querySelectorAll(':checked')].some(node => node.dataset.targetKey === targetKey(entry.target)));
        const changes = () => selected().map(entry => {
          const old = entry.binding || INHERIT;
          const include = mode.value === 'replace' ? [] : old.mode === 'inherit' ? [] : [...(old.include || [])];
          const found = include.find(ref => ref.resourceId === item.id);
          if (found) found.required = required.control.checked; else include.push({ resourceId: item.id, required: required.control.checked });
          return { target: entry.target, expectedRevision: entry.revision, binding: { mode: mode.value === 'replace' ? 'replace' : old.mode === 'replace' ? 'replace' : 'extend', include, exclude: mode.value === 'replace' ? [] : (old.exclude || []).filter(id => id !== item.id) } };
        });
        let previewed = '', previewBaseRevision = state.revision;
        const apply = el('button', 'Apply assignments', 'dialog-done'); apply.type = 'submit'; apply.disabled = true;
        const inspect = busyButton('Preview changes', async () => {
          fail(''); preview.replaceChildren(); apply.disabled = true;
          try {
            const draft = changes(); if (!draft.length) throw new Error('Choose one or more targets.');
            const results = await Promise.all(draft.map(change => request('/api/base/preview', { method: 'POST', body: change })));
            previewBaseRevision = results[0]?.manifest?.baseRevision ?? state.revision;
            if (results.some(result => Number.isInteger(result.manifest?.baseRevision) && result.manifest.baseRevision !== previewBaseRevision)) throw new Error('Base changed while previewing. Refresh this dialog and preview again.');
            for (let index = 0; index < results.length; index++) preview.append(el('h3', selected()[index]?.label || targetKey(draft[index].target)), p(`${draft[index].binding.mode}: ${mode.value === 'replace' ? 'inherited resources are discarded' : 'existing selection is retained'}`), showManifest(results[index].manifest, results[index].provider));
            previewed = JSON.stringify(draft); apply.disabled = false;
          } catch (error) { fail(error); }
        });
        form.addEventListener('change', () => { apply.disabled = true; previewed = ''; });
        form.append(actions(button('Cancel', closeDialog), inspect, apply));
        form.addEventListener('submit', async event => {
          event.preventDefault(); const draft = changes(); if (JSON.stringify(draft) !== previewed) { fail('Preview the selected changes before applying.'); return; } apply.disabled = true;
          try { await request('/api/base/apply', { method: 'POST', body: { expectedBaseRevision: previewBaseRevision, changes: draft } }); await context.refreshBoard?.(); await load(); closeDialog(); status(`Applied to ${draft.length} targets. No agents were started.`); }
          catch (error) { fail(error); }
        });
        openDialog('Apply to…', [form]);
      } catch (error) { openDialog('Apply to…', [el('p', error.message, 'inline-error')]); }
    }
    function openDelete(item) {
      const used = item.usedBy || resource(item.id)?.usedBy || [];
      const list = el('ul'); for (const target of used) list.append(el('li', typeof target === 'string' ? target : target.label || target.name || targetKey(target.target || target)));
      const detach = check('Explicitly detach every current assignment and dependency that refers to this resource.');
      const box = el('div'); box.append(p(`Delete “${item.name}” from the current library? Immutable revisions needed by historical runs remain available.`), el('h3', 'Used by'), used.length ? list : p('No current references.'), detach.label);
      const fail = inlineError(box);
      box.append(actions(button('Cancel', closeDialog), busyButton('Delete resource', async () => {
        try { await request(`/api/base/resources/${encodeURIComponent(item.id)}`, { method: 'DELETE', body: { expectedRevision: item.revision, expectedBaseRevision: state.revision, detach: detach.control.checked } }); await load(); await context.refreshBoard?.(); closeDialog(); if (chosen === item.id) closeResource(true); status('Resource deleted. Historical revisions are retained.'); }
        catch (error) { fail(error); }
      }, 'danger')));
      openDialog('Delete resource', [box]);
    }
    function openExport(id) {
      const include = check('Include document bodies and supporting files (may contain private context).');
      const choices = referenceFields(id ? [{ resourceId: id }] : [], { label: 'Resources to export', exclusions: true });
      const box = el('div'); box.append(p('Exports include dependency closure and credential references only. Resolved credentials are never exported.'), choices, include.label);
      const fail = inlineError(box);
      box.append(actions(button('Cancel', closeDialog), busyButton('Download Base export', async () => {
        try { const ids = choices.read(); if (!ids.length) throw new Error('Choose resources to export.'); const data = await request('/api/base/export', { method: 'POST', body: { resourceIds: ids, includeContent: include.control.checked } }); download('promptboard-base.json', data.export || data.package || data); closeDialog(); }
        catch (error) { fail(error); }
      })));
      openDialog('Export Base', [box]);
    }
    function openImport() {
      const file = Object.assign(el('input'), { type: 'file', accept: '.json,application/json' }); file.id = 'base-import-file';
      const content = el('div'), box = el('div'); let imported = null, previewed = false, remap = null, expectedBaseRevision = state.revision;
      box.append(field('Versioned Base export', file), p('Import never executes code or assigns resources. Executable resources start disabled and untrusted. IDs are remapped consistently, including dependency references.'), content);
      const fail = inlineError(box);
      const apply = busyButton('Import reviewed resources', async () => {
        try { if (!previewed || !imported) throw new Error('Choose and preview a valid export first.'); await request('/api/base/import', { method: 'POST', body: { data: imported, expectedBaseRevision, collision: 'remap', ...(remap ? { remap } : {}) } }); await load(); closeDialog(); status('Imported. Review trust and availability before assigning resources.'); }
        catch (error) { fail(error); }
      }); apply.disabled = true;
      file.addEventListener('change', async () => {
        apply.disabled = true; previewed = false; fail('');
        try { const selected = file.files?.[0]; if (!selected) return; if (selected.size > 12 * 1024 * 1024) throw new Error('Import exceeds 12 MiB.'); imported = JSON.parse(await selected.text()); const data = await request('/api/base/import/preview', { method: 'POST', body: { data: imported } }); remap = data.remap || data.preview?.remap; expectedBaseRevision = data.expectedBaseRevision ?? state.revision; content.replaceChildren(el('pre', JSON.stringify(data.preview || data, null, 2), 'base-code')); previewed = true; apply.disabled = false; }
        catch (error) { fail(error); }
      });
      box.append(actions(button('Cancel', closeDialog), apply)); openDialog('Import Base', [box]);
    }
    function openWikiGenerate(item) {
      const sources = item.content?.sources || [];
      const sourceList = el('div', undefined, 'base-references');
      for (const source of sources) { const row = check(source.name || source.id, true); row.control.dataset.sourceId = source.id; sourceList.append(row.label); }
      const agent = context.agentFields({}, {}), prompt = area('', 4000); prompt.placeholder = 'Optional focus for these pages';
      const box = el('div'), result = el('div');
      box.append(p('Saved, selected sources are sent to the existing restricted text-generation engine. Manual pages remain unchanged until you review and apply the draft. Source input is bounded; the result reports omissions.'), sourceList, agent, field('Instructions for this draft (optional)', prompt), result);
      const fail = inlineError(box);
      let operationId = null, draft = null;
      const cancel = busyButton('Cancel generation', async () => {
        try { if (operationId) await request('/api/base/wiki/cancel', { method: 'POST', body: { operationId } }); }
        catch (error) { fail(error); }
      }); cancel.hidden = true;
      const apply = busyButton('Apply reviewed draft', async () => {
        try { await request('/api/base/wiki/apply', { method: 'POST', body: { resourceId: item.id, expectedRevision: item.revision, draft } }); closeDialog(); await load(); await openResource(item.id, true); status('Wiki draft applied.'); }
        catch (error) { fail(error); }
      }); apply.hidden = true;
      const generate = busyButton('Generate draft', async () => {
        fail(''); apply.hidden = true; draft = null;
        const sourceIds = [...sourceList.querySelectorAll(':checked')].map(node => node.dataset.sourceId);
        if (!sourceIds.length) { fail('Select saved sources. Add and save a source in the wiki first.'); return; }
        operationId = `wiki_${globalThis.crypto?.randomUUID?.() || Date.now().toString(36)}`; cancel.hidden = false; result.replaceChildren(p('Generating a draft…'));
        try {
          const data = await request('/api/base/wiki/generate', { method: 'POST', body: { resourceId: item.id, expectedRevision: item.revision, sourceIds, operationId, instructions: prompt.value, ...(context.readAgentFields(agent) || {}) }, timeoutMs: 240000 });
          draft = data.draft; if (!draft) throw new Error('The engine returned no reviewable draft.');
          result.replaceChildren(el('h3', 'Review proposed changes'), p(`Source references: ${refsText(data.sources || sourceIds)}`));
          if (data.omitted?.length || data.warnings?.length) result.append(p([...(data.warnings || []), ...(data.omitted || [])].map(value => typeof value === 'string' ? value : value.reason || value.name || '').join(' · ')));
          const pages = draft.pages || draft.content?.pages || [];
          if (pages.length) for (const page of pages) {
            const previous = (item.content?.pages || []).find(old => old.id === page.id);
            const text = area(page.markdown || '', 200000); text.addEventListener('input', () => { page.markdown = text.value; });
            result.append(details(`${previous ? 'Update' : 'Add'}: ${page.title || page.id}`, details('Current text', el('pre', previous?.markdown || '(new page)', 'base-code')), field('Proposed Markdown (editable)', text)));
          } else {
            const text = area(draft.markdown || draft.body || draft.text || '', 200000);
            text.addEventListener('input', () => { if ('markdown' in draft) draft.markdown = text.value; else if ('body' in draft) draft.body = text.value; else draft.text = text.value; }); result.append(field('Proposed draft (editable)', text));
          }
          apply.hidden = false;
        } catch (error) { result.replaceChildren(); fail(error); }
        finally { cancel.hidden = true; operationId = null; }
      });
      box.append(actions(button('Close', closeDialog), generate, cancel, apply)); openDialog('Generate/update from sources', [box]);
    }
    function runManifest(run) {
      const box = el('section', undefined, 'base-run-resources');
      const manifest = run.baseManifest || run.base?.manifest || run.base;
      const count = manifest?.resources?.length || manifest?.entries?.length || 0;
      box.append(el('h3', 'Base resources'), p(manifest ? `Configured for this accepted run: ${count} resources. Definitions are pinned; attachment alone does not prove invocation.` : 'No Base configuration was recorded for this run.'));
      if (run.planBaseChanged || manifest?.planBaseChanged) box.append(p('The approved plan was produced with different Base context. Its approval does not cover resources added or changed later.'));
      const content = el('div');
      box.append(actions(busyButton('Inspect supplied resources', async () => {
        try {
          const data = await request(`/api/runs/${encodeURIComponent(run.id)}/base`); const actual = data.manifest || data.baseManifest || data;
          content.replaceChildren(showManifest(actual, run.config), p('Supplied context and observed invocation are separate facts. CLI output does not always expose tool identity.'));
          if (data.planBaseChanged || actual.planBaseChanged) content.append(p('This approved plan has different Base context. Review the additional resources separately.'));
          const suppliedById = new Map((actual.supplied || []).map(item => [item.resourceId, item]));
          for (const configured of actual.resources || []) {
            const id = configured.resourceId || configured.id, supplied = suppliedById.get(id), payload = el('div');
            const readPayload = async (kind, output) => {
              try { const data = await request(`/api/runs/${encodeURIComponent(run.id)}/base-${kind}?resourceId=${encodeURIComponent(id)}`); const text = kind === 'context' ? data.text || data.context || '' : JSON.stringify(data.resource || data.definition || data, null, 2); output.replaceChildren(el('pre', text, 'base-code')); }
              catch (error) { output.replaceChildren(el('p', error.message, 'inline-error')); }
            };
            const definitionText = el('div'); payload.append(busyButton('Inspect pinned definition', () => readPayload('definition', definitionText), 'text-button'), definitionText);
            if (supplied) {
              payload.append(p(`Supplied: ${supplied.delivery || supplied.method || 'context'}${supplied.contentHash || supplied.hash ? ` · hash ${supplied.contentHash || supplied.hash}` : ''} · ${supplied.chars || 0} characters`));
              for (const capture of supplied.captures || []) payload.append(p(`Source: ${capture.path || capture.url || capture.sourceId} · captured ${capture.capturedAt ? new Date(capture.capturedAt).toLocaleString() : 'not recorded'}${capture.hash ? ` · hash ${capture.hash}` : ''}`));
              for (const omitted of supplied.omitted || []) payload.append(p(`Omitted: ${typeof omitted === 'string' ? omitted : omitted.reason || omitted.sourceId || ''}`));
              if (supplied.contextRef || supplied.hash) { const contextText = el('div'); payload.append(busyButton('Inspect supplied context', () => readPayload('context', contextText), 'text-button'), contextText); }
            } else payload.append(p('No supplied context was recorded for this resource.'));
            content.append(details(`${configured.name || nameOf(id)} · revision ${configured.revision || '?'}`, payload));
          }
          if (actual.observed?.length) for (const invocation of actual.observed) content.append(p(`Observed invocation: ${invocation.toolName || invocation.name || invocation.resourceId}`));
          else content.append(p('Observed invocation: not reported.'));
          content.append(details('Pinned manifest', el('pre', JSON.stringify(actual, null, 2), 'base-code')));
        } catch (error) { content.replaceChildren(el('p', error.message, 'inline-error')); }
      }, 'text-button'), button('Configure resources for next run…', () => openPicker({ scope: 'task-column', projectId: run.projectId, taskId: run.taskId, columnId: run.stage }, { provider: run.config?.provider }), 'text-button')), content);
      return box;
    }
    return { show, refresh: load, picker, openPicker, runManifest, openResource, state, viewState };
  }
  return { create, markdown };
})();
