'use strict';

// Network → Library and Network → Graph (docs/network/architecture.md §9, §12): the owner's networks as an editable draft
// plus immutable published versions, and a visual editor for one draft. A graph is topology only: agent and sub-network
// nodes, typed relations (message, delegate, share_result) and positions. Nodes hold IDs and pinned version numbers;
// nothing from Base or from a child network is copied. Saving or publishing starts nothing and a relation grants no
// permission. The canvas is Cytoscape (index.html loads /vendor/cytoscape.min.js); without it, and on a phone, the node
// and relation lists beside it edit the same draft with the keyboard. All text is set as text (PromptboardDom).
window.PromptboardNetworkGraph = (() => {
  const { el, button, plural, ago, clip, download } = window.PromptboardDom;
  const RELATIONS = [['message', 'Message'], ['delegate', 'Delegate'], ['share_result', 'Share result']];
  const RELATION_NAMES = Object.fromEntries(RELATIONS);
  const RELATION_VERBS = { message: 'may send messages to', delegate: 'may delegate work to', share_result: 'may share results with' };
  const PROVIDERS = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', agy: 'Antigravity' };
  const KINDS = { profile: 'Agent', agentProfile: 'Agent profile' };
  const STATE_NAMES = { disabled: 'Switched off', stale: 'Stale', missing: 'Missing', unavailable: 'Unreadable' };
  // Resource limits of the view, not of the product: the canvas draws at most this many nodes once sub-networks are
  // expanded; the side lists show a page at a time.
  const VIEW_CAP = 1000, LIST_PAGE = 200, UNDO_DEPTH = 50, NUDGE = 10;
  const INERT = 'Saving or publishing a graph starts nothing. A relation records what you allow between two nodes: it grants no permission, sends no message and shares no data.';
  const note = (text, className = 'note') => el('p', className, text);
  const labelled = (text, control, className = 'field-label') => { const label = el('label', className); label.append(text, control); return label; };
  const checkRow = (control, text) => { const label = el('label', 'check-row'); label.append(control, text); return label; };
  const select = options => { const node = el('select'); for (const [value, text, disabled] of options) { const option = Object.assign(el('option', '', text), { value }); option.disabled = Boolean(disabled); node.append(option); } return node; };
  const chip = (text, tone) => el('small', `base-status tone-${tone}`, text);
  const randomHex = () => Array.from({ length: 12 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const isPhone = () => (window.matchMedia ? window.matchMedia('(max-width: 730px)').matches : window.innerWidth <= 730);
  const clone = value => JSON.parse(JSON.stringify(value));
  const agentState = ref => (!ref || ref.missing ? 'missing' : ref.stale ? 'stale' : ref.enabled === false ? 'disabled' : 'ok');
  const debounce = (fn, ms) => { let timer = null; return () => { clearTimeout(timer); timer = setTimeout(fn, ms); }; };

  function create(host) {
    const { request, say, go } = host;
    let current = null; // The route last shown: { section, networkId, version } or null when another section shows.

    // ---- Dialog helpers over network.js's dialog (Escape and Close return focus to the opener).
    function closeActions(...extra) { const box = el('div', 'kanban-dialog-actions'); box.append(button('Close', host.closeDialog, 'secondary-button'), ...extra); return box; }
    /** A confirmation: `action` runs on the button and closes the dialog itself; a failure stays in the dialog. */
    function ask(title, nodes, label, action, { danger = false, extra = () => [] } = {}) {
      const failure = el('div', 'inline-error'); failure.setAttribute('role', 'alert'); failure.hidden = true;
      const confirm = button(label, async () => {
        confirm.disabled = true; failure.hidden = true;
        try { await action(); } catch (error) { failure.replaceChildren(el('span', '', error.message), ...extra(error)); failure.hidden = false; } finally { confirm.disabled = false; }
      }, `secondary-button${danger ? ' network-danger' : ''}`);
      confirm.id = 'network-confirm';
      const footer = el('div', 'kanban-dialog-actions'); footer.append(button('Cancel', host.closeDialog, 'secondary-button'), confirm);
      host.openDialog(title, [...nodes, failure, footer]);
      confirm.focus();
    }
    function textForm({ name = '', description = '', submitLabel, onSubmit, withDescription = true }) {
      const form = el('form', 'network-form'); form.noValidate = true;
      const nameInput = Object.assign(el('input'), { type: 'text', maxLength: 80, value: name, autocomplete: 'off' }); nameInput.id = 'network-name-input';
      const descriptionInput = Object.assign(el('textarea'), { rows: 3, maxLength: 2000, value: description }); descriptionInput.id = 'network-description-input';
      form.append(labelled('Name', nameInput), ...(withDescription ? [labelled('Description (optional)', descriptionInput)] : []));
      const failure = el('div', 'inline-error'); failure.setAttribute('role', 'alert'); failure.hidden = true;
      const submit = el('button', 'dialog-done', submitLabel); submit.type = 'submit'; submit.id = 'network-name-submit';
      const footer = el('div', 'kanban-dialog-actions'); footer.append(button('Cancel', host.closeDialog, 'secondary-button'), submit);
      form.append(failure, footer);
      form.addEventListener('submit', async event => {
        event.preventDefault(); submit.disabled = true; failure.hidden = true;
        try { await onSubmit({ name: nameInput.value.trim(), description: descriptionInput.value.trim() }); }
        catch (error) { failure.replaceChildren(el('span', '', error.message), ...(error.code === 'REVISION_CONFLICT' ? [button('Reload', async () => { host.closeDialog(); await refreshAll(); say('Reloaded the current version. Make your change again.'); }, 'secondary-button network-reload')] : [])); failure.hidden = false; }
        finally { submit.disabled = false; }
      });
      return { form, focus: () => { nameInput.focus(); nameInput.select?.(); } };
    }

    // ---- Library: every network with its drafts, versions and uses; create, rename, duplicate, archive, delete,
    // export and import. Read again on every visit to the section.
    const lib = { items: [], total: 0, next: null, unavailable: [], loaded: false, loading: false, error: '', q: '', archived: false, version: 0,
      detail: null, detailError: null, detailVersion: 0, loadingId: null, focus: null };
    const libPanel = el('section', 'network-panel network-library'); libPanel.id = 'network-panel-library'; libPanel.setAttribute('role', 'tabpanel'); libPanel.setAttribute('aria-labelledby', 'network-tab-library'); libPanel.hidden = true;
    const libSearch = Object.assign(el('input'), { type: 'search', placeholder: 'Find a network…', autocomplete: 'off', maxLength: 200 }); libSearch.id = 'network-library-search';
    const libArchived = Object.assign(el('input'), { type: 'checkbox' }); libArchived.id = 'network-library-archived';
    const libNew = button('New network…', () => newNetworkDialog(), 'secondary-button'); libNew.id = 'network-library-new';
    const libExport = button('Export', () => exportAll(), 'secondary-button'); libExport.id = 'network-library-export';
    const libFile = Object.assign(el('input'), { type: 'file', accept: '.json,application/json' }); libFile.id = 'network-library-file'; libFile.hidden = true; libFile.setAttribute('aria-label', 'Network export file');
    const libImport = button('Import…', () => libFile.click(), 'secondary-button'); libImport.id = 'network-library-import';
    const libTools = el('div', 'network-toolbar network-library-tools');
    const libButtons = el('div', 'network-library-buttons'); libButtons.append(libNew, libExport, libImport, libFile);
    libTools.append(labelled('Search networks', libSearch, 'field-label network-search'), checkRow(libArchived, 'Show archived'), libButtons);
    const libCount = note('', 'note network-count');
    const libList = el('ul', 'network-list'); libList.id = 'network-library-list'; libList.setAttribute('aria-label', 'Networks');
    const libEmpty = el('div', 'network-empty');
    const libMore = button('Show more networks', () => loadLibrary({ append: true }), 'secondary-button network-more'); libMore.hidden = true;
    const libListPanel = el('section', 'network-list-panel'); libListPanel.setAttribute('aria-label', 'Network library'); libListPanel.append(libCount, libList, libEmpty, libMore);
    const libDetail = el('section', 'base-detail network-detail'); libDetail.id = 'network-library-detail'; libDetail.setAttribute('aria-label', 'Network details');
    const libLayout = el('div', 'network-layout'); libLayout.append(libListPanel, libDetail);
    libPanel.append(note('Each network is a draft you edit in Graph, plus the versions you published. A published version never changes; a run will pin one, never the draft.', 'note network-section-intro'), libTools, libLayout);
    libSearch.addEventListener('input', debounce(() => { if (lib.q !== libSearch.value.trim()) { lib.q = libSearch.value.trim(); void loadLibrary(); } }, 250));
    libArchived.addEventListener('change', () => { lib.archived = libArchived.checked; void loadLibrary(); });
    libFile.addEventListener('change', () => { const file = libFile.files?.[0]; libFile.value = ''; if (file) void importFile(file); });

    async function loadLibrary({ append = false } = {}) {
      const version = ++lib.version;
      lib.loading = true; if (!append) lib.error = '';
      renderLibraryList(); renderChooser();
      const params = new URLSearchParams({ limit: '200', offset: String(append ? lib.items.length : 0) });
      if (lib.q) params.set('q', lib.q); if (lib.archived) params.set('archived', 'true');
      try {
        const data = await request(`/api/network/networks?${params}`);
        if (version === lib.version) Object.assign(lib, { items: append ? [...lib.items, ...data.networks] : data.networks, total: data.total, next: data.next, unavailable: data.unavailable || [], loaded: true });
      } catch (failure) { if (version === lib.version) lib.error = failure.message; }
      finally { if (version === lib.version) { lib.loading = false; renderLibraryList(); renderChooser(); } }
    }
    function networkRow(item, open, currentId) {
      const row = el('li', 'network-row'); row.dataset.state = item.archived ? 'disabled' : 'enabled';
      const pick = button('', open, 'network-agent network-network'); pick.dataset.networkId = item.id;
      if (item.id === currentId) pick.setAttribute('aria-current', 'true');
      const latest = item.publishedVersions.at(-1), text = el('span', 'network-row-text');
      text.append(el('strong', '', item.name), el('span', 'network-row-sub', `${plural(item.nodeCount, 'node')} · ${plural(item.edgeCount, 'relation')}`), chip(latest ? `Version ${latest.version} latest` : 'Not published', latest ? 'ok' : 'off'));
      if (item.archived) text.append(chip('Archived', 'off'));
      const icon = el('span', 'base-kind-icon network-graph-icon', '⬡'); icon.setAttribute('aria-hidden', 'true');
      pick.append(icon, text); row.append(pick);
      return row;
    }
    /** A list's empty, loading and error states (the Library list and the Graph chooser share them). */
    function listState(box, onRetry) {
      box.replaceChildren(); box.hidden = lib.loaded && !lib.error && lib.items.length > 0;
      if (!lib.loaded && !lib.error) box.append(note('Loading networks…'));
      else if (lib.error) { const failure = el('p', 'inline-error', `Could not load networks. ${lib.error}`); failure.setAttribute('role', 'alert'); box.append(failure, button('Retry', onRetry, 'secondary-button')); }
      else if (!lib.items.length && (lib.q || lib.archived)) box.append(note('No networks match.'), button('Clear search', () => { lib.q = ''; lib.archived = false; libSearch.value = ''; libArchived.checked = false; void loadLibrary(); }, 'secondary-button'));
      else if (!lib.items.length) box.append(el('p', 'network-empty-title', 'No networks yet.'), note('A network groups registered agents and other networks with the relations you allow between them.'), button('New network…', () => newNetworkDialog(), 'secondary-button'));
      if (lib.unavailable.length) box.append(note(`${plural(lib.unavailable.length, 'saved network')} cannot be read and ${lib.unavailable.length === 1 ? 'is' : 'are'} left out. Nothing was changed.`, 'note network-stale'));
      box.hidden = box.hidden && !lib.unavailable.length;
    }
    function renderLibraryList() {
      if (current?.section !== 'library') return;
      const focused = libList.contains(document.activeElement) ? document.activeElement.dataset.networkId : null;
      libListPanel.setAttribute('aria-busy', String(lib.loading || !lib.loaded));
      libList.replaceChildren(...(lib.error ? [] : lib.items.map(item => networkRow(item, () => { lib.focus = 'detail'; go(`#/network/library/${item.id}`); }, current.networkId))));
      const again = lib.focus && lib.focus !== 'detail' ? lib.focus : focused;
      if (again && libList.querySelector(`[data-network-id="${again}"]`)) { libList.querySelector(`[data-network-id="${again}"]`).focus(); if (lib.focus === again) lib.focus = null; }
      libCount.hidden = !lib.loaded || Boolean(lib.error) || !lib.items.length;
      libCount.textContent = lib.total > lib.items.length ? `${lib.items.length} of ${plural(lib.total, 'network')}` : plural(lib.total, 'network');
      listState(libEmpty, () => loadLibrary());
      libMore.hidden = !lib.loaded || Boolean(lib.error) || lib.next === null;
    }
    async function loadDetail(id) {
      const version = ++lib.detailVersion; lib.loadingId = id;
      try { const data = await request(`/api/network/networks/${id}`); if (version === lib.detailVersion) { lib.detail = data; lib.detailError = null; } }
      catch (failure) { if (version === lib.detailVersion) lib.detailError = { id, message: failure.message }; }
      if (version !== lib.detailVersion) return;
      lib.loadingId = null;
      if (current?.section === 'library' && current.networkId === id) renderLibraryDetail();
    }
    function renderLibraryDetail() {
      const id = current.networkId;
      libPanel.dataset.view = id ? 'detail' : 'list';
      for (const pick of libList.querySelectorAll('[data-network-id]')) { if (pick.dataset.networkId === id) pick.setAttribute('aria-current', 'true'); else pick.removeAttribute('aria-current'); }
      if (!id) { libDetail.replaceChildren(el('p', 'base-placeholder', 'Choose a network to see its versions and where it is used.')); return; }
      if (lib.detailError?.id === id) { libDetail.replaceChildren(el('p', 'inline-error', lib.detailError.message), button('Back to networks', () => go('#/network/library'), 'secondary-button')); return; }
      if (lib.detail?.network.id !== id) { libDetail.replaceChildren(note('Loading network…')); if (lib.loadingId !== id) void loadDetail(id); return; }
      const keep = libDetail.contains(document.activeElement) ? document.activeElement.id : '';
      libDetail.replaceChildren(networkDetail(lib.detail));
      if (keep && document.getElementById(keep)) document.getElementById(keep).focus();
      else if (lib.focus === 'detail' && isPhone()) document.querySelector('#network-library-heading')?.focus();
      if (lib.focus === 'detail') lib.focus = null;
    }
    /** Why Delete is refused, in words, or '' when the network can be deleted (the server checks the same). */
    function deleteBlocker({ network, usedBy, usedByUnknown }) {
      if (usedByUnknown.length) return 'It cannot be deleted while some saved networks cannot be read: one of them might use it.';
      if (usedBy.length) return `It cannot be deleted: it is a sub-network of ${usedBy.map(use => `“${use.name}”`).join(', ')}. ${usedBy.some(use => use.versions.length) ? 'Published versions keep it for good, so archive it instead.' : 'Remove it there first, or archive it.'}`;
      if (network.publishedVersions.length) return 'It cannot be deleted: it has published versions, which later runs may pin. Archive it instead; every version stays readable.';
      return '';
    }
    function networkDetail(data) {
      const { network, usedBy, usedByUnknown, issues } = data, latest = network.publishedVersions.at(-1);
      const box = el('article', 'network-profile');
      const back = button('Back to networks', () => { lib.focus = network.id; go('#/network/library'); }, 'text-button network-back');
      const title = el('h2', '', network.name); title.id = 'network-library-heading'; title.tabIndex = -1;
      const state = el('p', 'network-chips'); state.append(chip(`Draft · revision ${network.revision}`, 'ok'), chip(latest ? `Version ${latest.version} latest` : 'Not published', latest ? 'ok' : 'off'), ...(network.archived ? [chip('Archived', 'off')] : []));
      const titleBox = el('div', 'network-profile-title'); titleBox.append(title, note(network.description || 'No description.'), state);
      const icon = el('span', 'base-kind-icon network-graph-icon', '⬡'); icon.setAttribute('aria-hidden', 'true');
      const head = el('header', 'network-profile-head'); head.append(icon, titleBox);
      const open = button('Open in Graph', () => go(`#/network/graph/${network.id}`), 'secondary-button'); open.id = 'network-library-open';
      const rename = button('Rename…', () => renameDialog(network), 'secondary-button'); rename.id = 'network-library-rename';
      const duplicate = button('Duplicate…', () => duplicateDialog(network), 'secondary-button'); duplicate.id = 'network-library-duplicate';
      const archive = button(network.archived ? 'Restore' : 'Archive', () => setArchived(network, !network.archived), 'secondary-button'); archive.id = 'network-library-archive';
      const remove = button('Delete…', () => deleteDialog(network), 'secondary-button network-danger'); remove.id = 'network-library-delete';
      const actions = el('div', 'detail-actions network-controls'); actions.append(open, rename, duplicate, archive, remove);
      box.append(back, head, actions);
      const blocker = deleteBlocker(data);
      if (blocker) { const why = note(blocker, 'note network-delete-reason'); why.id = 'network-library-delete-reason'; remove.disabled = true; remove.title = blocker; remove.setAttribute('aria-describedby', why.id); box.append(why); }
      const facts = el('dl', 'network-facts');
      for (const [label, value] of [['Network ID', el('code', '', network.id)], ['Nodes', plural(network.nodes.length, 'node')], ['Relations', plural(network.edges.length, 'relation')], ['Created', ago(network.createdAt)], ['Updated', ago(network.updatedAt)]]) { const dd = el('dd'); dd.append(value); facts.append(el('dt', '', label), dd); }
      box.append(facts, el('h3', '', 'Published versions'));
      if (!network.publishedVersions.length) box.append(note('Not published yet. Publish it from Graph: a sub-network and a later run can only pin a published version.'));
      else {
        const versions = el('ul', 'network-versions'); versions.id = 'network-library-versions'; versions.setAttribute('aria-label', 'Published versions');
        for (const entry of [...network.publishedVersions].reverse()) {
          const item = el('li'); item.dataset.version = String(entry.version);
          const text = el('span', 'network-row-text'); text.append(el('strong', '', `Version ${entry.version}`), el('span', 'network-row-sub', `Published ${ago(entry.publishedAt)} · sha256 ${entry.sha256.slice(0, 12)}`));
          if (entry === latest) text.append(chip('Latest', 'ok'));
          const view = button('View', () => go(`#/network/graph/${network.id}/v${entry.version}`), 'text-button'); view.setAttribute('aria-label', `View version ${entry.version}`);
          item.append(text, view); versions.append(item);
        }
        box.append(versions, note('A published version never changes and is never deleted.'));
      }
      box.append(el('h3', '', 'Used by'));
      const uses = el('ul', 'network-versions'); uses.id = 'network-library-used-by'; uses.setAttribute('aria-label', 'Networks that contain it');
      for (const use of usedBy) {
        const item = el('li'), where = [use.draft ? `its draft pins version ${use.draft}` : '', ...use.versions.map(entry => `its version ${entry.version} pins version ${entry.pins}`)].filter(Boolean).join('; ');
        const text = el('span', 'network-row-text'); text.append(el('strong', '', use.name), el('span', 'network-row-sub', where));
        if (use.archived) text.append(chip('Archived', 'off'));
        item.append(text, button('Open', () => go(`#/network/library/${use.networkId}`), 'text-button')); uses.append(item);
      }
      box.append(...(usedBy.length ? [uses] : [note('No other network contains it.')]));
      if (usedByUnknown.length) box.append(note(`${plural(usedByUnknown.length, 'saved network')} could not be read to check.`, 'note network-stale'));
      box.append(el('h3', '', 'Check'), issueList(issues, null));
      if (host.memoryPanel) box.append(host.memoryPanel(network.id));
      return box;
    }
    function issueList(issues, actions) {
      const list = el('ul', 'network-issues'); list.setAttribute('aria-label', 'Things to fix');
      for (const issue of issues) { const item = el('li', `network-issue issue-${issue.code.toLowerCase()}`); item.append(el('span', '', issue.message), ...(actions ? actions(issue) : [])); list.append(item); }
      if (!issues.length) list.append(el('li', 'network-issue is-clear', 'Nothing to fix: every agent can take work and every pinned version can be read.'));
      return list;
    }
    async function refreshAll() {
      await loadLibrary();
      if (current?.section === 'library' && current.networkId) { lib.detail = null; await loadDetail(current.networkId); }
      if (current?.section === 'graph' && current.networkId && !ed?.dirty) { ed = null; renderGraph(); }
    }
    function newNetworkDialog() {
      const { form, focus } = textForm({ submitLabel: 'Create', onSubmit: async fields => {
        const data = await request('/api/network/networks', { method: 'POST', body: fields });
        host.closeDialog(); say(`Created “${data.network.name}”. Add agents and sub-networks, then save the draft.`);
        await loadLibrary(); go(`#/network/graph/${data.network.id}`);
      } });
      form.prepend(note('A new, empty draft. You add registered agents and published networks in Graph.'));
      host.openDialog('New network', [form]); focus();
    }
    function renameDialog(network) {
      const { form, focus } = textForm({ name: network.name, description: network.description, submitLabel: 'Save', onSubmit: async fields => {
        const data = await request(`/api/network/networks/${network.id}`, { method: 'PATCH', body: { expectedRevision: network.revision, ...fields } });
        host.closeDialog(); say(`Saved “${data.network.name}”. Published versions keep the name they were published with.`);
        lib.detail = data; await loadLibrary(); renderLibraryDetail();
      } });
      host.openDialog('Rename network', [form]); focus();
    }
    function duplicateDialog(network) {
      const { form, focus } = textForm({ name: `${clip(network.name, 73)} (copy)`, submitLabel: 'Duplicate', withDescription: false, onSubmit: async ({ name }) => {
        const data = await request(`/api/network/networks/${network.id}/duplicate`, { method: 'POST', body: { name } });
        host.closeDialog(); say(`Created “${data.network.name}”, an unpublished draft with the same nodes, relations and pins.`);
        lib.detail = data; lib.focus = 'detail'; await loadLibrary(); go(`#/network/library/${data.network.id}`);
      } });
      form.prepend(note('The copy is a new draft. Its agents and sub-networks stay references: nothing is copied by value, and nothing is published.'));
      host.openDialog('Duplicate network', [form]); focus();
    }
    async function setArchived(network, archived) {
      host.showError?.('');
      try {
        const data = await request(`/api/network/networks/${network.id}`, { method: 'PATCH', body: { expectedRevision: network.revision, archived } });
        say(archived ? `Archived “${network.name}”. It left the lists; every pinned version keeps working.` : `Restored “${network.name}”.`);
        lib.detail = data; await loadLibrary(); renderLibraryDetail(); document.querySelector('#network-library-archive')?.focus();
      } catch (failure) { host.showError?.(failure); }
    }
    function deleteDialog(network) {
      ask('Delete network?', [note(`“${network.name}” was never published and no network contains it. It is removed from Network; its memory stays in the data folder.`, 'note network-quote')], 'Delete', async () => {
        await request(`/api/network/networks/${network.id}`, { method: 'DELETE', body: { expectedRevision: network.revision } });
        host.closeDialog(); say(`Deleted “${network.name}”.`); lib.detail = null; await loadLibrary(); go('#/network/library');
        setTimeout(() => libNew.focus(), 0);
      }, { danger: true, extra: error => [
        ...(['NETWORK_IN_USE', 'NETWORK_PUBLISHED'].includes(error.code) ? [button('Archive instead', async () => { host.closeDialog(); await setArchived(network, true); }, 'secondary-button')] : []),
        ...(['REVISION_CONFLICT', 'NOT_FOUND'].includes(error.code) ? [button('Reload', async () => { host.closeDialog(); await refreshAll(); }, 'secondary-button network-reload')] : []),
      ] });
    }
    async function exportAll() {
      try {
        const data = await request('/api/network/export');
        download(`promptboard-network-${new Date().toISOString().slice(0, 10)}.json`, `${JSON.stringify(data, null, 1)}\n`, 'application/json');
        say(`Exported ${plural(data.agents.length, 'agent registration')}, ${plural(data.networks.length, 'network')} and ${plural(data.versions.length, 'published version')}. Memory and reports are not in the file.`);
      } catch (failure) { host.showError?.(failure); }
    }
    async function importFile(file) {
      host.showError?.('');
      try {
        let data; try { data = JSON.parse(await file.text()); } catch { throw new Error('This file is not JSON. Choose a Promptboard Network export. Nothing was imported.'); }
        const { revision } = await request('/api/network/agents?limit=1');
        const result = await request('/api/network/import', { method: 'POST', body: { data, expectedRevision: revision } });
        say(`Imported ${plural(result.imported.networks, 'network')}, ${plural(result.imported.versions, 'published version')} and ${plural(result.imported.agents, 'agent')} (switched off until you enable them). Nothing ran.${result.warnings.length ? ` ${result.warnings.join(' ')}` : ''}`);
        await loadLibrary();
      } catch (failure) { host.showError?.(failure); }
    }

    // ---- Graph: the editor for one draft, or a read-only published version (#/network/graph/<id>/v<n>).
    const graphPanel = el('section', 'network-panel network-graph-panel'); graphPanel.id = 'network-panel-graph'; graphPanel.setAttribute('role', 'tabpanel'); graphPanel.setAttribute('aria-labelledby', 'network-tab-graph'); graphPanel.hidden = true;
    const chooser = el('section', 'network-graph-chooser'); chooser.id = 'network-graph-chooser';
    const chooserList = el('ul', 'network-list'); chooserList.setAttribute('aria-label', 'Networks to edit');
    const chooserEmpty = el('div', 'network-empty');
    const chooserNew = button('New network…', () => newNetworkDialog(), 'secondary-button'); chooserNew.id = 'network-graph-new';
    const chooserHead = el('div', 'network-posts-head'); chooserHead.append(note('Choose a network to edit its graph, or start a new one.'), chooserNew);
    chooser.append(el('h2', '', 'Graph'), chooserHead, chooserList, chooserEmpty);
    function renderChooser() {
      if (current?.section !== 'graph' || current.networkId) return;
      chooserList.replaceChildren(...(lib.error ? [] : lib.items.map(item => networkRow(item, () => go(`#/network/graph/${item.id}`)))));
      listState(chooserEmpty, () => loadLibrary());
    }

    const editor = el('section', 'network-graph'); editor.id = 'network-graph-editor';
    const gHeading = el('h2', '', ''); gHeading.id = 'network-graph-heading'; gHeading.tabIndex = -1;
    const gMeta = el('div', 'network-chips network-graph-meta'); gMeta.id = 'network-graph-meta';
    const gTitle = el('div', 'network-graph-title'); gTitle.append(gHeading, gMeta);
    const gSave = button('Save draft', () => void save(), 'secondary-button network-primary'); gSave.id = 'network-graph-save';
    const gPublish = button('Publish', () => publishDialog(), 'secondary-button'); gPublish.id = 'network-graph-publish';
    const gUndo = button('Undo', () => undo(), 'secondary-button'); gUndo.id = 'network-graph-undo';
    const gDiscard = button('Discard changes…', () => discardDialog(), 'secondary-button'); gDiscard.id = 'network-graph-discard';
    const gEditDraft = button('Edit the draft', () => go(`#/network/graph/${ed.id}`), 'secondary-button'); gEditDraft.id = 'network-graph-edit-draft';
    const gLibrary = button('Library details', () => go(`#/network/library/${ed.id}`), 'secondary-button'); gLibrary.id = 'network-graph-library';
    const gActions = el('div', 'detail-actions network-graph-actions'); gActions.append(gSave, gPublish, gUndo, gDiscard, gEditDraft, gLibrary);
    const gHead = el('header', 'network-graph-head'); gHead.append(gTitle, gActions);
    const gInert = note(INERT, 'note network-inert'); gInert.id = 'network-graph-inert';
    const gAlert = el('div', 'inline-error network-alert'); gAlert.id = 'network-graph-alert'; gAlert.setAttribute('role', 'alert'); gAlert.hidden = true;
    const gNotice = el('div', 'network-graph-notice'); gNotice.id = 'network-graph-notice'; gNotice.setAttribute('role', 'status'); gNotice.setAttribute('aria-live', 'polite');
    // Toolbar: editing, then the canvas view (pan, zoom, fit, layout), then search and the relation filter.
    const gAddAgent = button('Add agent…', () => addAgentDialog(), 'secondary-button'); gAddAgent.id = 'network-graph-add-agent';
    const gAddNetwork = button('Add sub-network…', () => void addSubnetworkDialog(), 'secondary-button'); gAddNetwork.id = 'network-graph-add-subnetwork';
    const gRelation = select(RELATIONS); gRelation.id = 'network-graph-relation';
    const gConnect = button('Connect', () => toggleConnect(), 'secondary-button'); gConnect.id = 'network-graph-connect'; gConnect.setAttribute('aria-pressed', 'false');
    const gRemove = button('Remove', () => removeSelected(), 'secondary-button'); gRemove.id = 'network-graph-remove';
    const gFit = button('Fit', () => fitView(), 'secondary-button'); gFit.id = 'network-graph-fit';
    const gZoomOut = button('−', () => zoomBy(1 / 1.25), 'secondary-button'); gZoomOut.id = 'network-graph-zoom-out'; gZoomOut.setAttribute('aria-label', 'Zoom out');
    const gZoomIn = button('+', () => zoomBy(1.25), 'secondary-button'); gZoomIn.id = 'network-graph-zoom-in'; gZoomIn.setAttribute('aria-label', 'Zoom in');
    const gGrid = button('Arrange in a grid', () => arrange('grid'), 'secondary-button'); gGrid.id = 'network-graph-grid';
    const gLayered = button('Arrange in layers', () => arrange('layered'), 'secondary-button'); gLayered.id = 'network-graph-layered';
    const gSearch = Object.assign(el('input'), { type: 'search', placeholder: 'Find a node…', autocomplete: 'off', maxLength: 200 }); gSearch.id = 'network-graph-search';
    const gFilter = el('fieldset', 'network-graph-filter'); gFilter.append(el('legend', 'sr-only', 'Show relations'));
    for (const [relation, label] of RELATIONS) { const box = Object.assign(el('input'), { type: 'checkbox', checked: true }); box.dataset.relationFilter = relation; const row = checkRow(box, label); row.classList.add(`relation-${relation}`); gFilter.append(row); }
    const gRelationLabel = labelled('Relation', gRelation, 'field-label network-inline-label');
    const editTools = el('div', 'network-graph-tools'); editTools.append(gAddAgent, gAddNetwork, gRelationLabel, gConnect, gRemove);
    const viewTools = el('div', 'network-graph-tools network-canvas-tools'); viewTools.append(gFit, gZoomOut, gZoomIn, gGrid, gLayered);
    const findTools = el('div', 'network-graph-tools'); findTools.append(labelled('Find nodes', gSearch, 'field-label network-inline-label'), gFilter);
    const gTools = el('div', 'network-graph-toolbar'); gTools.append(editTools, viewTools, findTools);
    const canvas = el('div', 'network-canvas'); canvas.id = 'network-canvas'; canvas.tabIndex = 0;
    canvas.setAttribute('role', 'application'); canvas.setAttribute('aria-roledescription', 'graph canvas'); canvas.setAttribute('aria-describedby', 'network-canvas-hint');
    const canvasHint = note('Drag nodes to place them; double-click a sub-network to expand or collapse it. With the canvas focused, arrow keys move the chosen node, Delete removes it and Escape stops connecting. The lists beside the canvas do everything with the keyboard.', 'note network-canvas-hint'); canvasHint.id = 'network-canvas-hint';
    const canvasBox = el('div', 'network-canvas-box'); canvasBox.append(canvas, canvasHint);
    const gDetails = el('section', 'network-graph-details'); gDetails.id = 'network-graph-details'; gDetails.setAttribute('aria-label', 'Details');
    const gNodesTitle = el('h3', '', 'Nodes'), gEdgesTitle = el('h3', '', 'Relations');
    const gNodes = el('ul', 'network-graph-list'); gNodes.id = 'network-graph-nodes'; gNodes.setAttribute('aria-labelledby', 'network-graph-nodes-title'); gNodesTitle.id = 'network-graph-nodes-title';
    const gEdges = el('ul', 'network-graph-list'); gEdges.id = 'network-graph-edges'; gEdges.setAttribute('aria-labelledby', 'network-graph-edges-title'); gEdgesTitle.id = 'network-graph-edges-title';
    const gNodesMore = button('Show all nodes', () => { ed.nodeLimit = Infinity; renderLists(); }, 'secondary-button network-more'); gNodesMore.id = 'network-graph-nodes-more';
    const gEdgesMore = button('Show all relations', () => { ed.edgeLimit = Infinity; renderLists(); }, 'secondary-button network-more'); gEdgesMore.id = 'network-graph-edges-more';
    const gIssues = el('div', 'network-graph-issues'); gIssues.id = 'network-graph-issues';
    const lists = el('div', 'network-graph-lists'); lists.append(gNodesTitle, gNodes, gNodesMore, gEdgesTitle, gEdges, gEdgesMore, el('h3', '', 'Check'), gIssues);
    const side = el('aside', 'network-graph-side'); side.setAttribute('aria-label', 'Nodes, relations and details'); side.append(gDetails, lists);
    const body = el('div', 'network-graph-body'); body.append(canvasBox, side);
    editor.append(gHead, gInert, gAlert, gNotice, gTools, body);
    graphPanel.append(chooser, editor);

    gSearch.addEventListener('input', debounce(() => { if (!ed) return; ed.q = gSearch.value.trim().toLocaleLowerCase(); ed.nodeLimit = LIST_PAGE; syncCanvas(); renderLists(); }, 150));
    gFilter.addEventListener('change', event => { const relation = event.target.dataset.relationFilter; if (!ed || !relation) return; if (event.target.checked) ed.hidden.delete(relation); else ed.hidden.add(relation); syncCanvas(); renderLists(); });
    window.addEventListener('beforeunload', event => { if (ed?.dirty) { event.preventDefault(); event.returnValue = ''; } });

    // ---- Editor state. `ed.nodes` and `ed.edges` are the working copy; `ed.draft` is the saved draft it came from.
    let ed = null, cy = null, cyKey = null, dragStart = null, solidLines = false;
    const versionCache = new Map(); // `${id}@${n}` → { version, refs } (versions never change; refs are as of the read).
    function fetchVersion(id, number) {
      const key = `${id}@${number}`;
      if (!versionCache.has(key)) versionCache.set(key, request(`/api/network/networks/${id}/versions/${number}`).catch(failure => { versionCache.delete(key); throw failure; }));
      return versionCache.get(key);
    }
    const fresh = (key, extra) => ({ key, id: null, readOnly: false, versionNumber: null, loading: true, loadError: null, draft: null, nodes: [], edges: [], refs: { agents: {}, networks: {} }, issues: [], usedBy: [],
      dirty: false, saving: false, undo: [], selected: null, phoneDetail: false, expanded: new Map(), inner: new Map(), error: null, problems: new Set(), notice: '', connect: null,
      q: '', hidden: new Set(), nodeLimit: LIST_PAGE, edgeLimit: LIST_PAGE, inside: null, ...extra });
    const editorHash = () => `#/network/graph/${ed.id}${ed.readOnly ? `/v${ed.versionNumber}` : ''}`;
    const byId = id => ed.nodes.find(node => node.id === id);
    const snapshot = () => ({ nodes: clone(ed.nodes), edges: clone(ed.edges) });
    function nodeName(node, refs = ed.refs) { return node.type === 'agent' ? refs.agents[node.agentId]?.name || node.agentId : refs.networks[node.networkId]?.name || node.networkId; }
    function stateOf(node, refs = ed.refs) { return node.type === 'agent' ? agentState(refs.agents[node.agentId]) : refs.networks[node.networkId]?.pinned === null ? 'unavailable' : 'ok'; }
    function subtitleOf(node, refs = ed.refs) {
      if (node.type === 'agent') { const ref = refs.agents[node.agentId] || {}; return [KINDS[ref.kind] || 'Agent', PROVIDERS[ref.provider]].filter(Boolean).join(' · '); }
      const ref = refs.networks[node.networkId] || {}, latest = ref.versions?.at(-1);
      return `Sub-network · version ${node.version}${latest ? ` of ${latest}` : ''}${ref.pinned ? ` · ${plural(ref.pinned.nodes, 'node')}` : ''}`;
    }
    const matches = node => !ed.q || nodeName(node).toLocaleLowerCase().includes(ed.q);

    async function openEditor(id, versionNumber) {
      const key = `${id}@${versionNumber || 'draft'}`;
      if (ed?.key === key) return;
      ed = fresh(key, { id, readOnly: Boolean(versionNumber), versionNumber });
      gSearch.value = ''; for (const box of gFilter.querySelectorAll('input')) box.checked = true;
      renderGraph();
      try {
        if (versionNumber) {
          const [detail, data] = await Promise.all([request(`/api/network/networks/${id}`), fetchVersion(id, versionNumber)]);
          if (ed?.key !== key) return;
          Object.assign(ed, { draft: detail.network, nodes: clone(data.version.nodes), edges: clone(data.version.edges), refs: data.refs, published: data.version });
        } else {
          const data = await request(`/api/network/networks/${id}`);
          if (ed?.key !== key) return;
          applyDetail(data);
        }
      } catch (failure) { if (ed?.key === key) ed.loadError = failure; }
      if (ed?.key !== key) return;
      ed.loading = false;
      renderGraph();
      if (!ed.loadError) gHeading.focus();
    }
    function applyDetail(data) {
      Object.assign(ed, { draft: data.network, nodes: clone(data.network.nodes), edges: clone(data.network.edges), refs: data.refs, issues: data.issues, usedBy: data.usedBy });
    }
    /** One edit of the working copy: undo keeps the copy before it; the canvas and lists follow. */
    function change(mutate, message, before = snapshot()) {
      if (!ed || ed.readOnly || ed.loading) return;
      ed.undo.push(before); if (ed.undo.length > UNDO_DEPTH) ed.undo.shift();
      mutate();
      Object.assign(ed, { dirty: true, error: null, problems: new Set() });
      syncCanvas(); renderEditor();
      if (message) say(message);
    }
    function undo() {
      const last = ed?.undo.pop(); if (!last) return;
      ed.nodes = last.nodes; ed.edges = last.edges;
      if (ed.selected && !byId(ed.selected) && !ed.edges.some(edge => edge.id === ed.selected)) ed.selected = null;
      ed.dirty = JSON.stringify([ed.nodes, ed.edges]) !== JSON.stringify([ed.draft.nodes, ed.draft.edges]);
      syncCanvas(); renderEditor(); say('Undone.');
    }
    function freshId(prefix) { const taken = new Set([...ed.nodes, ...ed.edges].map(item => item.id)); let id; do id = `${prefix}_${randomHex()}`; while (taken.has(id)); return id; }
    /** A free spot for a new node: the middle of what the canvas shows, or below the lowest node without a canvas. */
    function placeNew() {
      let at;
      if (cy) { const box = cy.extent(); at = { x: Math.round((box.x1 + box.x2) / 2), y: Math.round((box.y1 + box.y2) / 2) }; }
      else at = { x: 0, y: ed.nodes.length ? Math.max(...ed.nodes.map(node => node.position.y)) + 90 : 0 };
      // Free means no overlap with a gap: nodes are 168 × 46 (a sub-network 168 × 56), so centres 190 apart across or 70 down.
      for (let tries = 0; tries < 200 && ed.nodes.some(node => Math.abs(node.position.x - at.x) < 190 && Math.abs(node.position.y - at.y) < 70); tries++) at = { x: at.x + 30, y: at.y + 60 };
      return at;
    }
    function addAgentNode(agent) {
      if (ed.nodes.some(node => node.agentId === agent.id)) { say('This agent is already in the network.'); return; }
      const id = freshId('n'), name = agent.displayName || agent.base.name || agent.baseResourceId;
      change(() => {
        ed.nodes.push({ id, type: 'agent', agentId: agent.id, position: placeNew() });
        ed.refs.agents[agent.id] = { name, kind: agent.base.kind, provider: agent.base.provider, enabled: agent.enabled, stale: agent.base.stale, staleReason: agent.base.staleReason };
      }, `Added “${name}”. Save the draft to keep it.`);
      selectItem(id, { focus: true });
    }
    function addSubnetworkNode(item, version) {
      if (ed.nodes.some(node => node.networkId === item.id)) { say('This network is already a sub-network here.'); return; }
      const id = freshId('n');
      change(() => {
        ed.nodes.push({ id, type: 'subnetwork', networkId: item.id, version, position: placeNew() });
        ed.refs.networks[item.id] = { name: item.name, archived: Boolean(item.archived), versions: item.publishedVersions.map(entry => entry.version) };
      }, `Added “${item.name}” version ${version} as a sub-network. Saving checks that no network contains itself.`);
      selectItem(id, { focus: true });
    }
    function removeNode(id) {
      const node = byId(id); if (!node) return;
      const count = ed.edges.filter(edge => edge.from === id || edge.to === id).length;
      if (ed.expanded.has(id)) collapse(id);
      change(() => { ed.nodes = ed.nodes.filter(item => item.id !== id); ed.edges = ed.edges.filter(edge => edge.from !== id && edge.to !== id); if (ed.selected === id) ed.selected = null; ed.phoneDetail = false; },
        `Removed “${nodeName(node)}”${count ? ` and ${plural(count, 'relation')}` : ''}. Undo brings it back.`);
    }
    /** A typed relation between two different nodes of this network; each (from, to, relation) once. */
    function addRelation(from, to, relation) {
      const a = byId(from), b = byId(to);
      if (!a || !b) { say('Relations join nodes of this network itself. Open a sub-network to change its own relations.'); return false; }
      if (from === to) { say('A relation joins two different nodes.'); return false; }
      if (ed.edges.some(edge => edge.from === from && edge.to === to && edge.relation === relation)) { say('This relation already exists.'); return false; }
      change(() => { ed.edges.push({ id: freshId('e'), from, to, relation }); }, `“${nodeName(a)}” ${RELATION_VERBS[relation]} “${nodeName(b)}”. Nothing is granted or started.`);
      return true;
    }
    function removeRelation(id) {
      const edge = ed.edges.find(item => item.id === id); if (!edge) return;
      change(() => { ed.edges = ed.edges.filter(item => item.id !== id); if (ed.selected === id) ed.selected = null; }, `Disconnected “${nodeName(byId(edge.from))}” from “${nodeName(byId(edge.to))}”.`);
    }
    function removeSelected() { if (!ed?.selected) { say('Choose a node or relation first.'); return; } if (byId(ed.selected)) removeNode(ed.selected); else removeRelation(ed.selected); }
    function setPin(id, version) {
      const node = byId(id); if (!node || node.version === version) return;
      if (ed.expanded.has(id)) collapse(id);
      change(() => { node.version = version; }, `“${nodeName(node)}” now pins version ${version}.`);
    }
    /** Grid (here, so it works without the canvas) or layers (Cytoscape's breadth-first layout along the relations). */
    function arrange(kind) {
      if (!ed.nodes.length) return;
      for (const id of [...ed.expanded.keys()]) collapse(id);
      let positions;
      if (kind === 'layered' && cy) {
        const top = cy.nodes().filter(item => !item.data('inner')), layout = top.union(top.edgesWith(top)).layout({ name: 'breadthfirst', directed: true, spacingFactor: 1.15, animate: false, fit: false });
        layout.run(); positions = new Map(top.map(item => [item.id(), { x: Math.round(item.position('x')), y: Math.round(item.position('y')) }]));
      } else {
        const columns = Math.max(1, Math.ceil(Math.sqrt(ed.nodes.length * 1.6)));
        positions = new Map(ed.nodes.map((node, index) => [node.id, { x: (index % columns) * 200, y: Math.floor(index / columns) * 100 }]));
      }
      change(() => { for (const node of ed.nodes) node.position = positions.get(node.id) || node.position; }, kind === 'grid' ? 'Arranged in a grid. Save the draft to keep the positions.' : 'Arranged in layers along the relations. Save the draft to keep the positions.');
      fitView();
    }
    function selectItem(id, { focus = false } = {}) {
      if (!ed) return;
      ed.selected = id; ed.inside = null;
      if (id && isPhone()) ed.phoneDetail = true;
      if (cy) cy.batch(() => { cy.elements(':selected').unselect(); if (id) cy.getElementById(id).select(); });
      renderEditor();
      if (focus) document.querySelector('#network-graph-detail-heading')?.focus();
    }

    // ---- Save, publish, conflicts. Every save names the revision it was loaded at (CAS); nothing is ever overwritten.
    async function save() {
      if (!ed || ed.readOnly || ed.saving) return false;
      ed.saving = true; renderHead();
      try {
        const data = await request(`/api/network/networks/${ed.id}`, { method: 'PATCH', body: { expectedRevision: ed.draft.revision, nodes: ed.nodes, edges: ed.edges } });
        applyDetail(data);
        Object.assign(ed, { dirty: false, undo: [], error: null, problems: new Set() });
        say(`Saved the draft of “${data.network.name}” (revision ${data.network.revision}). Nothing started.`);
        return true;
      } catch (failure) {
        ed.error = failure; ed.problems = new Set(problemNodes(failure));
        return false;
      } finally { ed.saving = false; syncCanvas(); renderEditor(); }
    }
    /**
     * The nodes a refused save or publish points at: the sub-network on the way of a cycle or to a version that cannot be
     * read (`details.path[1]` is this network's own node), or references that are not valid.
     */
    function problemNodes(failure) {
      const details = failure.details || {};
      return ed.nodes.filter(node => (node.networkId && node.networkId === details.path?.[1]) || details.agentIds?.includes(node.agentId)
        || (failure.code === 'NETWORK_REFERENCE_INVALID' && node.networkId && node.networkId === details.networkId)).map(node => node.id);
    }
    function publishDialog() {
      const next = (ed.draft.publishedVersions.at(-1)?.version || 0) + 1;
      ask(`Publish version ${next}?`, [note(`Version ${next} of “${ed.draft.name}” is saved exactly as the draft is${ed.dirty ? ' after your unsaved changes are saved' : ''}. A published version never changes and is never deleted; a sub-network or a later run pins its number, never the draft.`), note(INERT)], `Publish version ${next}`, async () => {
        if (ed.dirty && !(await save())) { host.closeDialog(); return; }
        let data;
        try { data = await request(`/api/network/networks/${ed.id}/publish`, { method: 'POST', body: { expectedRevision: ed.draft.revision } }); } catch (failure) {
          // A conflict, or a refusal that names nodes, belongs in the editor's alert with its choices; anything else stays here.
          if (failure.code !== 'REVISION_CONFLICT' && !failure.details) throw failure;
          host.closeDialog(); Object.assign(ed, { error: failure, problems: new Set(problemNodes(failure)) }); syncCanvas(); renderEditor(); return;
        }
        applyDetail(data); host.closeDialog();
        say(`Published version ${data.published.version} of “${data.network.name}”. It never changes. Nothing started.`);
        syncCanvas(); renderEditor();
      });
    }
    function discardDialog() {
      ask('Discard unsaved changes?', [note(`The draft goes back to revision ${ed.draft.revision} as it is saved. This cannot be undone.`)], 'Discard changes', async () => {
        for (const id of [...ed.expanded.keys()]) collapse(id);
        Object.assign(ed, { nodes: clone(ed.draft.nodes), edges: clone(ed.draft.edges), dirty: false, undo: [], error: null, problems: new Set(), selected: null });
        host.closeDialog(); syncCanvas(); renderEditor(); say('Discarded the unsaved changes.');
      }, { danger: true });
    }
    async function reloadTheirs() { const id = ed.id; ed = null; destroyCanvas(); await openEditor(id, null); say('Loaded the saved draft. Your unsaved changes were dropped.'); }
    /** Keep my edits without overwriting the newer draft: they become a new network. */
    async function saveAsNew() {
      const base = clip(ed.draft.name, 60);
      for (let n = 1; n <= 9; n++) {
        try {
          const data = await request('/api/network/networks', { method: 'POST', body: { name: `${base} (my changes${n > 1 ? ` ${n}` : ''})`, description: ed.draft.description, nodes: ed.nodes, edges: ed.edges } });
          ed.dirty = false; say(`Saved your changes as “${data.network.name}”. The other draft is unchanged.`); go(`#/network/graph/${data.network.id}`); return;
        } catch (failure) { if (failure.code !== 'NETWORK_NAME_TAKEN') { ed.error = failure; renderEditor(); return; } }
      }
    }

    // ---- Dialogs that add nodes.
    function addAgentDialog() {
      const form = el('div', 'network-form');
      const search = Object.assign(el('input'), { type: 'search', placeholder: 'Find an agent…', autocomplete: 'off', maxLength: 200 }); search.id = 'network-pick-search';
      const list = el('ul', 'network-pick-list'); list.id = 'network-pick-list'; list.setAttribute('aria-label', 'Registered agents');
      const status = note('Loading agents…'); status.setAttribute('aria-live', 'polite');
      form.append(labelled('Search agents', search), status, list, note('Each agent appears once in a network. A switched-off or stale agent can be placed; it is marked until it can take work.'), closeActions());
      host.openDialog('Add agent', [form]); search.focus();
      let version = 0;
      const load = async () => {
        const mine = ++version, params = new URLSearchParams({ limit: '200' }); if (search.value.trim()) params.set('q', search.value.trim());
        try {
          const data = await request(`/api/network/agents?${params}`); if (mine !== version || !ed) return;
          const present = new Set(ed.nodes.map(node => node.agentId).filter(Boolean));
          list.replaceChildren(...data.agents.map(agent => {
            const state = agent.base.stale ? 'stale' : agent.enabled ? 'ok' : 'disabled', item = el('li');
            const pick = button('', () => { host.closeDialog(); addAgentNode(agent); }, 'network-agent network-pick'); pick.dataset.agentId = agent.id;
            const text = el('span', 'network-row-text'); text.append(el('strong', '', agent.displayName || agent.base.name || agent.baseResourceId), el('span', 'network-row-sub', [KINDS[agent.base.kind], PROVIDERS[agent.base.provider]].filter(Boolean).join(' · ')));
            if (state !== 'ok') text.append(chip(STATE_NAMES[state], 'warn'));
            if (present.has(agent.id)) { pick.disabled = true; pick.title = 'Already in this network'; text.append(chip('Already in this network', 'off')); }
            pick.append(text); item.append(pick); return item;
          }));
          status.textContent = !data.total ? (search.value.trim() ? 'No registered agent matches.' : 'No agents are registered yet. Register Base agents in Network → Agents first.') : data.total > data.agents.length ? `${data.agents.length} of ${plural(data.total, 'agent')}. Search to find the others.` : plural(data.total, 'agent');
        } catch (failure) { if (mine === version) status.textContent = `Could not load agents. ${failure.message}`; }
      };
      search.addEventListener('input', debounce(load, 200)); void load();
    }
    async function addSubnetworkDialog() {
      host.openDialog('Add sub-network', [note('Loading networks…')]);
      let data;
      try { data = await request('/api/network/networks?limit=200'); } catch (failure) { host.openDialog('Add sub-network', [el('p', 'inline-error', failure.message), closeActions()]); return; }
      if (!ed) return;
      const present = new Set(ed.nodes.map(node => node.networkId).filter(Boolean)), others = data.networks.filter(item => item.id !== ed.id);
      const usable = item => !present.has(item.id) && item.publishedVersions.length > 0;
      if (!others.some(usable)) { host.openDialog('Add sub-network', [note('No other network has a published version to add. Publish one first: a sub-network always pins a published version, never a draft.'), closeActions()]); return; }
      const pick = select(others.map(item => [item.id, `${item.name}${present.has(item.id) ? ' — already here' : !item.publishedVersions.length ? ' — not published yet' : ''}`, !usable(item)])); pick.id = 'network-pick-network';
      pick.value = others.find(usable).id;
      const version = el('select'); version.id = 'network-pick-version';
      const fill = () => { const item = others.find(entry => entry.id === pick.value), last = item.publishedVersions.at(-1); version.replaceChildren(...select([...item.publishedVersions].reverse().map(entry => [String(entry.version), `Version ${entry.version}${entry === last ? ' (latest)' : ''} · published ${ago(entry.publishedAt)}`])).children); };
      pick.addEventListener('change', fill); fill();
      const add = el('button', 'dialog-done', 'Add sub-network'); add.type = 'button'; add.id = 'network-pick-add';
      add.addEventListener('click', () => { const item = others.find(entry => entry.id === pick.value); host.closeDialog(); addSubnetworkNode(item, Number(version.value)); });
      const footer = el('div', 'kanban-dialog-actions'); footer.append(button('Cancel', host.closeDialog, 'secondary-button'), add);
      const form = el('div', 'network-form');
      form.append(labelled('Network', pick), labelled('Pinned version', version), note('The sub-network is a reference to that version: its agents and relations are not copied, and publishing it again never changes this pin.'), footer);
      host.openDialog('Add sub-network', [form]); pick.focus();
    }

    // ---- Canvas (Cytoscape). Built per network when the canvas is on screen; the lists work without it.
    function css(name, fallback) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; }
    function styleSheet() {
      const ink = css('--ink', '#16161a'), surface = css('--surface', '#fff'), raised = css('--surface-2', '#f1f1f4'), line = css('--line-strong', '#85858f'), muted = css('--muted', '#4f4f58');
      const warn = css('--og-warn', '#b45309'), error = css('--error', '#c2410c'), accent = css('--sash', '#7c3aed');
      const colors = { message: css('--og-design', '#2563eb'), delegate: css('--og-define', '#7c3aed'), share_result: css('--og-operate', '#047857') };
      return [
        { selector: 'node', style: { shape: 'round-rectangle', width: 168, height: 46, 'background-color': surface, 'border-width': 1.5, 'border-color': line, label: 'data(label)', color: ink, 'font-size': 12,
          'font-family': css('--sans', 'sans-serif'), 'text-valign': 'center', 'text-halign': 'center', 'text-wrap': 'wrap', 'text-max-width': 156, 'min-zoomed-font-size': 7 } },
        { selector: 'node[type = "subnetwork"]', style: { height: 56, 'border-width': 4, 'border-style': 'double', 'background-color': raised } },
        // An expanded sub-network's one-line label sits inside its box, below the border where relations arrive, on its
        // own background; relations inside it are drawn above its nodes, so a short one still shows its name.
        { selector: 'node.expanded', style: { 'text-valign': 'top', 'text-margin-y': 24, padding: 32, 'background-opacity': 0.4, 'border-style': 'dashed', 'border-width': 2,
          'text-wrap': 'ellipsis', 'text-max-width': 320, 'text-background-color': raised, 'text-background-opacity': 1, 'text-background-padding': 3, 'text-background-shape': 'roundrectangle' } },
        { selector: 'node.inner', style: { 'border-style': 'dotted', 'background-color': raised } },
        { selector: 'node.disabled', style: { 'border-style': 'dashed', opacity: 0.62 } },
        { selector: 'node.stale, node.missing, node.unavailable', style: { 'border-color': warn, 'border-width': 3 } },
        { selector: 'node.problem', style: { 'border-color': error, 'border-width': 4 } },
        { selector: 'node:selected', style: { 'border-color': accent, 'border-width': 3.5, 'overlay-opacity': 0 } },
        { selector: 'node.source', style: { 'border-color': accent, 'border-style': 'double', 'border-width': 5 } },
        // Relations are dashed (pipelines will draw solid execution arrows). Dashes cost seconds per frame once there are
        // hundreds of them (measured in Chrome), so a large view draws them solid; colour and arrow shape still tell them apart.
        { selector: 'edge', style: { width: 1.8, 'curve-style': 'bezier', 'line-style': solidLines ? 'solid' : 'dashed', 'line-color': colors.message, 'target-arrow-color': colors.message, 'target-arrow-shape': 'triangle',
          label: 'data(label)', 'font-size': 10, color: muted, 'text-rotation': 'autorotate', 'text-background-color': surface, 'text-background-opacity': 1, 'text-background-padding': 2, 'min-zoomed-font-size': 9 } },
        { selector: 'edge[relation = "delegate"]', style: { 'line-color': colors.delegate, 'target-arrow-color': colors.delegate, 'target-arrow-shape': 'triangle-tee' } },
        { selector: 'edge[relation = "share_result"]', style: { 'line-color': colors.share_result, 'target-arrow-color': colors.share_result, 'target-arrow-shape': 'circle' } },
        { selector: 'edge:selected', style: { width: 3.5, 'overlay-opacity': 0 } },
        { selector: 'edge.inner', style: { width: 1.2, opacity: 0.85, 'z-compound-depth': 'top' } },
        { selector: '.faded', style: { opacity: 0.16 } },
        { selector: 'edge.hidden-relation', style: { display: 'none' } },
      ];
    }
    function labelOf(node, cyId, refs = ed.refs) {
      if (node.type === 'agent') { const state = stateOf(node, refs); return `${clip(nodeName(node, refs), 40)}${state !== 'ok' ? `\n${STATE_NAMES[state]}` : ''}`; }
      const ref = refs.networks[node.networkId] || {};
      return `${ed.expanded.has(cyId) ? '▾' : '▸'} ${clip(nodeName(node, refs), 36)}${ed.expanded.has(cyId) ? ' · ' : '\n'}version ${node.version}${ref.pinned ? ` · ${plural(ref.pinned.nodes, 'node')}` : ''}`;
    }
    function classesOf(node) {
      return [stateOf(node) !== 'ok' ? stateOf(node) : '', ed.expanded.has(node.id) ? 'expanded' : '', ed.problems.has(node.id) ? 'problem' : '', ed.q && !matches(node) ? 'faded' : '', ed.connect?.from === node.id ? 'source' : ''].filter(Boolean).join(' ');
    }
    function edgeClasses(edge) {
      const hidden = ed.hidden.has(edge.relation), faded = ed.q && ![byId(edge.from), byId(edge.to)].some(node => node && matches(node));
      return [hidden ? 'hidden-relation' : '', faded ? 'faded' : ''].filter(Boolean).join(' ');
    }
    const edgeElement = edge => ({ group: 'edges', data: { id: edge.id, source: edge.from, target: edge.to, relation: edge.relation, label: RELATION_NAMES[edge.relation] }, classes: edgeClasses(edge) });
    /** Make the canvas show the working copy: add, update and remove only what differs (in one batch). */
    function syncCanvas() {
      if (!cy || !ed) return;
      const nodes = new Map(ed.nodes.map(node => [node.id, node])), edges = new Set(ed.edges.map(edge => edge.id));
      cy.batch(() => {
        cy.edges().filter(item => !item.data('inner') && !edges.has(item.id())).remove();
        cy.nodes().filter(item => !item.data('inner') && !nodes.has(item.id())).remove();
        const added = []; // One add for everything new: per-element adds are far slower on large graphs.
        for (const node of ed.nodes) {
          const item = cy.getElementById(node.id);
          if (item.empty()) { added.push({ group: 'nodes', data: { id: node.id, type: node.type, version: node.version ?? null, label: labelOf(node, node.id) }, position: { ...node.position }, classes: classesOf(node) }); continue; }
          if (ed.expanded.has(node.id) && item.data('version') !== node.version) collapse(node.id);
          item.data({ label: labelOf(node, node.id), version: node.version ?? null }); item.classes(classesOf(node));
          const at = item.position(), dx = node.position.x - at.x, dy = node.position.y - at.y;
          if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) { if (item.isParent()) item.descendants().shift({ x: dx, y: dy }); else item.position({ ...node.position }); }
        }
        cy.add(added); added.length = 0;
        for (const edge of ed.edges) { const item = cy.getElementById(edge.id); if (item.empty()) added.push(edgeElement(edge)); else item.classes(edgeClasses(edge)); }
        cy.add(added);
        cy.elements(':selected').unselect(); if (ed.selected) cy.getElementById(ed.selected).select();
      });
      lineStyle();
    }
    /** Dashed relations while the canvas holds at most 300 of them, solid above (see the edge style). */
    function lineStyle() { const solid = Boolean(cy) && cy.edges().length > 300; if (cy && solid !== solidLines) { solidLines = solid; cy.style(styleSheet()); } }
    function destroyCanvas() { if (cy) { cy.destroy(); cy = null; cyKey = null; solidLines = false; } if (ed) { ed.expanded.clear(); ed.inner.clear(); } canvas.replaceChildren(); }
    /** The canvas for the open network, when Cytoscape loaded and the screen is wide enough; never on a phone. */
    function drawCanvas() {
      if (!ed || ed.loading || ed.loadError || !window.cytoscape || isPhone() || editor.hidden || graphPanel.hidden) return;
      if (cy && cyKey === ed.key) { cy.resize(); return; }
      destroyCanvas();
      const big = ed.nodes.length > 300; // Large graphs pan and zoom on a cached image and hide relations while moving.
      solidLines = ed.edges.length > 300; // Decided before the first frame, so a large graph is never restyled at once.
      cy = window.cytoscape({ container: canvas, style: styleSheet(), elements: [], layout: { name: 'preset' }, minZoom: 0.05, maxZoom: 3, boxSelectionEnabled: false, selectionType: 'single',
        autoungrabify: ed.readOnly, textureOnViewport: big, hideEdgesOnViewport: big, motionBlur: false });
      cyKey = ed.key;
      cy.on('tap', 'node, edge', event => onTap(event.target.id()));
      cy.on('tap', event => { if (event.target === cy && !ed.connect) selectItem(null); });
      cy.on('dbltap', 'node', event => { if (describe(event.target.id())?.type === 'subnetwork') void toggleExpand(event.target.id()); });
      cy.on('grab', 'node', () => { dragStart = snapshot(); });
      cy.on('dragfree', 'node', event => onDragged(event.target));
      syncCanvas();
      if (ed.nodes.length) fitView(); else cy.center();
    }
    /** Fit everything in view, but never closer than a little over 1:1, so a small graph is not drawn huge. */
    function fitView() { if (!cy) return; cy.fit(undefined, 40); if (cy.zoom() > 1.25) { cy.zoom(1.25); cy.center(); } }
    function zoomBy(factor) { if (!cy) return; const box = { x: cy.width() / 2, y: cy.height() / 2 }; cy.zoom({ level: Math.min(3, Math.max(0.05, cy.zoom() * factor)), renderedPosition: box }); }
    function onDragged(item) {
      const node = byId(item.id()); if (!node || !dragStart) return;
      const at = item.position(), next = { x: Math.round(at.x), y: Math.round(at.y) };
      if (next.x === node.position.x && next.y === node.position.y) return;
      const before = dragStart; dragStart = null;
      change(() => { node.position = next; }, '', before);
    }
    function onTap(id) {
      if (!ed.connect) { selectItem(id); return; }
      if (!byId(id)) { say(ed.edges.some(edge => edge.id === id) ? 'Choose a node, not a relation.' : 'Relations join nodes of this network itself. Open a sub-network to change its own relations.'); return; }
      if (!ed.connect.from) { ed.connect.from = id; say(`Connecting from “${nodeName(byId(id))}”: now choose the node it relates to. Escape stops.`); syncCanvas(); return; }
      if (addRelation(ed.connect.from, id, ed.connect.relation)) stopConnect(''); // addRelation said what was added.
    }
    function toggleConnect() {
      if (!ed || ed.readOnly) return;
      if (ed.connect) { stopConnect(); return; }
      const from = byId(ed.selected) ? ed.selected : null;
      ed.connect = { relation: gRelation.value, from };
      // On the status line, which keeps its place: a notice above the canvas would move it just before the taps.
      say(from ? `Connecting from “${nodeName(byId(from))}” (${RELATION_NAMES[ed.connect.relation]}): choose the node it relates to. Escape stops.` : `Connect (${RELATION_NAMES[ed.connect.relation]}): choose the node it starts from, then the node it relates to. Escape stops.`);
      syncCanvas(); renderEditor(); canvas.focus();
    }
    function stopConnect(message = 'Stopped connecting.') { if (!ed?.connect) return; ed.connect = null; if (message) say(message); syncCanvas(); renderEditor(); }
    canvas.addEventListener('keydown', event => {
      if (!ed || ed.loading) return;
      const step = event.shiftKey ? 5 * NUDGE : NUDGE, move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key], node = byId(ed.selected);
      if (move && node && !ed.readOnly) { event.preventDefault(); change(() => { node.position = { x: node.position.x + move[0], y: node.position.y + move[1] }; }); return; }
      if (['Delete', 'Backspace'].includes(event.key) && ed.selected && !ed.readOnly) { event.preventDefault(); removeSelected(); return; }
      if (event.key === 'Escape') { event.preventDefault(); if (ed.connect) stopConnect(); else selectItem(null); }
    });
    // Lazy expansion: a sub-network's pinned version is read when it is expanded and drawn inside it, read only.
    function describe(cyId) { return byId(cyId) || ed.inner.get(cyId)?.node || null; }
    async function toggleExpand(cyId) {
      if (!cy || !ed) return;
      if (ed.expanded.has(cyId)) { collapse(cyId); syncCanvas(); renderEditor(); return; }
      const target = describe(cyId); if (target?.type !== 'subnetwork') return;
      const key = ed.key, refs = byId(cyId) ? ed.refs : ed.inner.get(cyId).refs, name = nodeName(target, refs);
      let data;
      try { data = await fetchVersion(target.networkId, target.version); } catch (failure) { ed.notice = `Could not expand “${name}”. ${failure.message}`; renderNotice(); return; }
      if (ed?.key !== key || !cy || cy.getElementById(cyId).empty() || ed.expanded.has(cyId)) return;
      const count = data.version.nodes.length, shown = cy.nodes().length;
      if (!count) { ed.notice = `“${name}” version ${target.version} has no nodes.`; renderNotice(); return; }
      if (shown + count > VIEW_CAP) {
        ed.notice = `Not expanded: “${name}” has ${plural(count, 'node')}, and the canvas would then draw ${(shown + count).toLocaleString('en-US')}, more than the ${VIEW_CAP.toLocaleString('en-US')}-node view limit. Collapse another sub-network first, or open “${name}” on its own.`;
        ed.capped = true; renderNotice(); return;
      }
      const parent = cy.getElementById(cyId), center = { ...parent.position() }, xs = data.version.nodes.map(node => node.position.x), ys = data.version.nodes.map(node => node.position.y);
      const dx = center.x - (Math.min(...xs) + Math.max(...xs)) / 2, dy = center.y - (Math.min(...ys) + Math.max(...ys)) / 2;
      ed.expanded.set(cyId, { networkId: target.networkId, version: target.version });
      const elements = data.version.nodes.map(child => {
        const id = `${cyId}/${child.id}`; ed.inner.set(id, { node: child, refs: data.refs, parent: cyId, networkName: name, version: target.version, networkId: target.networkId });
        return { group: 'nodes', data: { id, parent: cyId, inner: true, type: child.type, version: child.version ?? null, label: labelOf(child, id, data.refs) }, position: { x: child.position.x + dx, y: child.position.y + dy },
          classes: ['inner', stateOf(child, data.refs) !== 'ok' ? stateOf(child, data.refs) : ''].join(' ').trim(), grabbable: false };
      }).concat(data.version.edges.map(edge => ({ group: 'edges', data: { id: `${cyId}/${edge.id}`, source: `${cyId}/${edge.from}`, target: `${cyId}/${edge.to}`, relation: edge.relation, label: RELATION_NAMES[edge.relation], inner: true }, classes: 'inner' })));
      cy.batch(() => { cy.add(elements); parent.addClass('expanded'); parent.data('label', labelOf(target, cyId, refs)); });
      lineStyle();
      ed.notice = ''; ed.capped = false;
      // Show the whole expanded network when it reaches past the visible part of the canvas.
      const box = parent.boundingBox(), view = cy.extent();
      if (box.x1 < view.x1 || box.x2 > view.x2 || box.y1 < view.y1 || box.y2 > view.y2) fitView();
      renderEditor();
    }
    function collapse(cyId) {
      for (const key of [...ed.expanded.keys()]) if (key === cyId || key.startsWith(`${cyId}/`)) ed.expanded.delete(key);
      for (const key of [...ed.inner.keys()]) if (key.startsWith(`${cyId}/`)) ed.inner.delete(key);
      if (ed.selected?.startsWith(`${cyId}/`)) ed.selected = null;
      const parent = cy?.getElementById(cyId);
      if (!parent || parent.empty()) return;
      const at = { ...parent.position() }, target = describe(cyId), refs = byId(cyId) ? ed.refs : ed.inner.get(cyId)?.refs;
      cy.batch(() => { parent.descendants().remove(); parent.removeClass('expanded'); parent.position(at); if (target) parent.data('label', labelOf(target, cyId, refs)); });
      lineStyle();
    }

    // ---- Rendering
    function renderGraph() {
      const editing = Boolean(current?.networkId);
      chooser.hidden = editing; editor.hidden = !editing;
      if (!editing) { destroyCanvas(); renderChooser(); return; }
      renderEditor();
    }
    function renderEditor() {
      if (!ed || editor.hidden) return;
      graphPanel.dataset.view = ed.phoneDetail && ed.selected ? 'detail' : 'list';
      editor.dataset.mode = ed.readOnly ? 'version' : 'draft';
      renderHead(); renderAlert(); renderNotice();
      const ready = !ed.loading && !ed.loadError;
      gTools.hidden = !ready; body.hidden = !ready; gInert.hidden = !ready;
      if (!ready) return;
      editTools.hidden = ed.readOnly;
      const canvasOn = Boolean(window.cytoscape) && !isPhone();
      for (const control of [gFit, gZoomOut, gZoomIn, gConnect, gRelationLabel]) control.hidden = !canvasOn; // The node details connect without a canvas.
      gGrid.hidden = ed.readOnly || isPhone(); gLayered.hidden = !canvasOn || ed.readOnly; // A phone shows no positions.
      canvasBox.hidden = !canvasOn;
      gConnect.setAttribute('aria-pressed', String(Boolean(ed.connect))); gConnect.textContent = ed.connect ? 'Stop connecting' : 'Connect';
      gRemove.disabled = !ed.selected || (!byId(ed.selected) && !ed.edges.some(edge => edge.id === ed.selected)); gRemove.title = gRemove.disabled ? 'Choose a node or relation of this network first.' : '';
      canvas.setAttribute('aria-label', `Graph canvas: ${plural(ed.nodes.length, 'node')} and ${plural(ed.edges.length, 'relation')}. The lists beside it hold the same nodes and relations.`);
      drawCanvas();
      renderDetails(); renderLists(); renderIssues();
    }
    function renderHead() {
      if (!ed) return;
      const draft = ed.draft;
      gHeading.textContent = ed.loadError ? 'Network not available' : !draft ? 'Loading…' : ed.readOnly ? `${draft.name} · version ${ed.versionNumber}` : draft.name;
      gMeta.replaceChildren();
      if (draft && !ed.loadError) {
        if (ed.readOnly) gMeta.append(chip(`Published ${ago(ed.published.publishedAt)} · read only`, 'off'));
        else gMeta.append(chip(`Draft · revision ${draft.revision}`, 'ok'), ...(ed.dirty ? [Object.assign(chip('Unsaved changes', 'warn'), { id: 'network-graph-dirty' })] : []));
        const latest = draft.publishedVersions.at(-1);
        const versions = el('span', 'network-graph-versions'); versions.id = 'network-graph-versions';
        if (!latest) versions.append(el('small', 'base-status', 'Not published yet'));
        for (const entry of draft.publishedVersions.slice(-8)) {
          const open = button(`v${entry.version}${entry === latest ? ' · latest' : ''}`, () => go(`#/network/graph/${ed.id}/v${entry.version}`), 'network-version-chip'); open.dataset.version = String(entry.version);
          if (ed.readOnly && entry.version === ed.versionNumber) open.setAttribute('aria-current', 'page');
          open.setAttribute('aria-label', `Version ${entry.version}${entry === latest ? ', the latest' : ''}`); versions.append(open);
        }
        gMeta.append(versions);
      }
      const ready = Boolean(draft) && !ed.loading && !ed.loadError;
      for (const control of [gSave, gPublish, gUndo, gDiscard]) control.hidden = ed.readOnly || !ready;
      gEditDraft.hidden = !ed.readOnly || !ready; gLibrary.hidden = !ready;
      if (!ready || ed.readOnly) return;
      const next = (draft.publishedVersions.at(-1)?.version || 0) + 1;
      // After a revision conflict both would only conflict again: the alert's choices come first.
      const conflict = ed.error?.code === 'REVISION_CONFLICT' ? 'This draft was saved elsewhere: load the saved draft, or save yours as a new network, first.' : '';
      gSave.disabled = !ed.dirty || ed.saving || Boolean(conflict); gSave.title = conflict || (ed.dirty ? '' : 'No unsaved changes'); gSave.textContent = ed.saving ? 'Saving…' : 'Save draft';
      gPublish.textContent = ed.dirty ? `Save and publish version ${next}` : `Publish version ${next}`; gPublish.disabled = ed.saving || Boolean(conflict); gPublish.title = conflict;
      gUndo.disabled = !ed.undo.length; gUndo.title = ed.undo.length ? '' : 'Nothing to undo';
      gDiscard.disabled = !ed.dirty; gDiscard.title = ed.dirty ? '' : 'No unsaved changes';
    }
    function renderAlert() {
      const failure = ed.loadError || ed.error;
      gAlert.hidden = !failure; if (!failure) { gAlert.replaceChildren(); return; }
      gAlert.replaceChildren(el('span', '', failure.message));
      if (ed.loadError) { gAlert.append(button('Back to the Library', () => go('#/network/library'), 'secondary-button')); return; }
      if (failure.code === 'REVISION_CONFLICT') {
        const theirs = button('Load the saved draft', () => void reloadTheirs(), 'secondary-button network-reload'); theirs.id = 'network-graph-reload';
        const mine = button('Save mine as a new network', () => void saveAsNew(), 'secondary-button'); mine.id = 'network-graph-save-new';
        gAlert.append(note(ed.dirty ? 'Someone saved this draft elsewhere after you opened it. Nothing was overwritten: load the saved draft (your changes are dropped), or keep your changes as a new network.'
          : 'Someone saved this draft elsewhere after you opened it, so nothing was published. Load the saved draft to see it, or keep what you see here as a new network.'), theirs, mine);
        return;
      }
      for (const id of ed.problems) { const node = byId(id); if (!node) continue; const remove = button(`Remove “${nodeName(node)}”`, () => removeNode(id), 'secondary-button'); remove.dataset.removeNode = id; gAlert.append(remove); }
      gAlert.append(note(ed.dirty ? 'The draft was not saved; your changes are kept.' : 'Nothing was published.'));
    }
    function renderNotice() {
      if (!ed) return;
      const lines = [];
      if (ed.notice) lines.push([ed.notice, ed.capped ? 'network-cap-notice' : '']);
      if (!ed.loading && !ed.loadError && !isPhone() && !window.cytoscape) lines.push(['The canvas could not load in this browser. The lists below show and edit the same network.', '']);
      if (!ed.loading && ed.nodes.length > VIEW_CAP) lines.push([`This network has ${plural(ed.nodes.length, 'node')}, more than the ${VIEW_CAP.toLocaleString('en-US')}-node view limit. The canvas draws all of them, so it may be slow, and sub-networks cannot be expanded. Search finds a node.`, 'network-cap-notice']);
      if (ed.loading) lines.push(['Loading the network…', '']);
      gNotice.replaceChildren(...lines.map(([text, className]) => note(text, `note network-notice ${className}`.trim())));
    }
    /** Keep keyboard focus on the same control (by ID or data attribute) when a part of the page is drawn again. */
    function keepFocus(container, draw) {
      const active = container.contains(document.activeElement) ? document.activeElement : null;
      const id = active?.id, data = active && Object.entries(active.dataset)[0];
      draw();
      if (!active || active.isConnected) return;
      const again = id ? document.getElementById(id) : data ? container.querySelector(`[data-${data[0].replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}="${data[1]}"]`) : null;
      again?.focus();
    }
    function renderLists() {
      if (!ed) return;
      keepFocus(lists, () => {
        const nodes = ed.nodes.filter(matches), edges = ed.edges.filter(edge => !ed.hidden.has(edge.relation) && (!ed.q || [byId(edge.from), byId(edge.to)].some(node => node && matches(node))));
        gNodesTitle.textContent = `Nodes (${ed.q ? `${nodes.length} of ${ed.nodes.length}` : ed.nodes.length})`;
        gEdgesTitle.textContent = `Relations (${edges.length === ed.edges.length ? ed.edges.length : `${edges.length} of ${ed.edges.length}`})`;
        gNodes.replaceChildren(...nodes.slice(0, ed.nodeLimit).map(node => {
          const item = el('li', 'network-graph-row'), state = stateOf(node); item.dataset.state = state;
          const pick = button('', () => selectItem(node.id, { focus: true }), 'network-graph-item'); pick.dataset.nodeId = node.id;
          if (ed.selected === node.id) pick.setAttribute('aria-current', 'true');
          if (ed.problems.has(node.id)) pick.classList.add('is-problem');
          const text = el('span', 'network-row-text'); text.append(el('strong', '', nodeName(node)), el('span', 'network-row-sub', subtitleOf(node)));
          if (state !== 'ok') text.append(chip(STATE_NAMES[state], 'warn'));
          pick.append(el('span', `network-node-mark mark-${node.type}`, node.type === 'agent' ? '◉' : '⬡'), text);
          pick.firstChild.setAttribute('aria-hidden', 'true');
          item.append(pick); return item;
        }));
        if (!ed.nodes.length) gNodes.append(el('li', 'note', ed.readOnly ? 'This version has no nodes.' : 'No nodes yet. Add an agent or a sub-network.'));
        else if (!nodes.length) gNodes.append(el('li', 'note', 'No node matches.'));
        gNodesMore.hidden = nodes.length <= ed.nodeLimit; gNodesMore.textContent = `Show all ${plural(nodes.length, 'node')}`;
        gEdges.replaceChildren(...edges.slice(0, ed.edgeLimit).map(edge => {
          const item = el('li', `network-graph-row relation-${edge.relation}`), from = byId(edge.from), to = byId(edge.to);
          const pick = button('', () => selectItem(edge.id, { focus: true }), 'network-graph-item'); pick.dataset.edgeId = edge.id;
          if (ed.selected === edge.id) pick.setAttribute('aria-current', 'true');
          const text = el('span', 'network-row-text'); text.append(el('strong', '', `${nodeName(from)} → ${nodeName(to)}`), el('span', `network-row-sub network-relation relation-${edge.relation}`, RELATION_NAMES[edge.relation]));
          pick.append(text); item.append(pick);
          if (!ed.readOnly) { const cut = button('Disconnect', () => removeRelation(edge.id), 'text-button'); cut.dataset.disconnect = edge.id; cut.setAttribute('aria-label', `Disconnect ${nodeName(from)} ${RELATION_NAMES[edge.relation].toLowerCase()} ${nodeName(to)}`); item.append(cut); }
          return item;
        }));
        if (!ed.edges.length) gEdges.append(el('li', 'note', ed.readOnly ? 'This version has no relations.' : 'No relations yet. Choose a node, then connect it to another.'));
        gEdgesMore.hidden = edges.length <= ed.edgeLimit; gEdgesMore.textContent = `Show all ${plural(edges.length, 'relation')}`;
      });
    }
    function renderIssues() {
      if (ed.readOnly) { gIssues.replaceChildren(note('A published version is checked when it is pinned or run, not here.')); return; }
      const present = new Set(ed.nodes.map(node => node.id)), issues = ed.issues.filter(issue => present.has(issue.nodeId));
      keepFocus(gIssues, () => gIssues.replaceChildren(issueList(issues, issue => {
        const node = byId(issue.nodeId), actions = [button('Show', () => selectItem(issue.nodeId, { focus: true }), 'text-button')];
        if (issue.agentId && host.openAgent) actions.push(button('Open agent profile', () => host.openAgent(issue.agentId), 'text-button'));
        if (issue.code === 'SUBNETWORK_OUTDATED') actions.push(button(`Use version ${issue.latest}`, () => setPin(issue.nodeId, issue.latest), 'text-button'));
        actions.push(button('Remove from network', () => removeNode(issue.nodeId), 'text-button'));
        for (const [index, action] of actions.entries()) { action.dataset.issueAction = `${issue.nodeId}-${index}`; action.setAttribute('aria-label', `${action.textContent}: ${nodeName(node)}`); }
        const box = el('span', 'network-record-actions'); box.append(...actions); return [box];
      }), ...(ed.dirty ? [note('Unsaved changes are checked when you save.')] : [])));
    }
    function renderDetails() {
      keepFocus(gDetails, () => {
        const id = ed.selected, back = button('Back to the lists', () => { const last = ed.selected; ed.phoneDetail = false; renderEditor(); lists.querySelector(`[data-node-id="${last}"], [data-edge-id="${last}"]`)?.focus(); }, 'text-button network-back');
        back.id = 'network-graph-back';
        const heading = text => { const title = el('h3', 'network-graph-detail-title', text); title.id = 'network-graph-detail-heading'; title.tabIndex = -1; return title; };
        if (!id) { gDetails.replaceChildren(heading('Details'), note(ed.readOnly ? 'Choose a node or relation to see it.' : 'Choose a node or relation on the canvas or in the lists. Add agents and sub-networks from the toolbar, then connect them.')); return; }
        const edge = ed.edges.find(item => item.id === id), node = byId(id), inner = ed.inner.get(id);
        if (edge) { gDetails.replaceChildren(back, heading(RELATION_NAMES[edge.relation]), ...edgeDetails(edge)); return; }
        if (node) { gDetails.replaceChildren(back, heading(nodeName(node)), ...nodeDetails(node)); return; }
        if (inner) {
          const open = button(`Open “${inner.networkName}”`, () => go(`#/network/graph/${inner.networkId}`), 'secondary-button');
          gDetails.replaceChildren(back, heading(nodeName(inner.node, inner.refs)), note(`${subtitleOf(inner.node, inner.refs)}. Inside “${inner.networkName}” version ${inner.version}, read only: open that network to change it.`), open);
          return;
        }
        ed.selected = null; gDetails.replaceChildren(heading('Details'), note('Choose a node or relation.'));
      });
    }
    function edgeDetails(edge) {
      const from = byId(edge.from), to = byId(edge.to), parts = [note(`“${nodeName(from)}” ${RELATION_VERBS[edge.relation]} “${nodeName(to)}”.`), note('A relation records what you allow. It grants no permission and starts nothing.', 'note network-inert')];
      if (!ed.readOnly) { const cut = button('Disconnect', () => removeRelation(edge.id), 'secondary-button network-danger'); cut.id = 'network-graph-disconnect'; parts.push(cut); }
      return parts;
    }
    function nodeDetails(node) {
      const parts = [], state = stateOf(node);
      if (node.type === 'agent') {
        const ref = ed.refs.agents[node.agentId] || {};
        parts.push(note(subtitleOf(node) || 'Agent'));
        const open = host.openAgent ? button('Open agent profile', () => host.openAgent(node.agentId), 'secondary-button') : null; if (open) open.id = 'network-graph-open-agent';
        if (state === 'ok') parts.push(chip('Can take work once Network jobs arrive', 'ok'));
        else {
          const text = state === 'missing' ? 'The registration no longer exists. Remove this node.' : state === 'stale' ? `Stale: ${{ missing: 'its Base agent no longer exists', disabled: 'its Base agent is switched off', untrusted: 'its Base agent is not trusted', revoked: 'trust in its Base agent was revoked' }[ref.staleReason] || 'its Base agent cannot be used'}. It stays in the graph but cannot take work until it is fixed in Base.` : 'Switched off in Network. It stays in the graph but cannot take work until you switch it on in its profile.';
          const warning = note(text, 'network-stale'); warning.id = 'network-graph-node-warning'; parts.push(warning);
        }
        if (open && state !== 'missing') parts.push(open);
      } else {
        const ref = ed.refs.networks[node.networkId] || {};
        parts.push(note(subtitleOf(node)));
        if (state === 'unavailable') parts.push(note('This pinned version cannot be read from the data folder. Remove the node, or restore the network’s files.', 'network-stale'));
        if (ref.archived) parts.push(note('This network is archived. The pinned version keeps working.', 'note'));
        const pin = select((ref.versions || [node.version]).slice().reverse().map(version => [String(version), `Version ${version}${version === ref.versions?.at(-1) ? ' (latest)' : ''}`])); pin.id = 'network-graph-pin'; pin.value = String(node.version); pin.disabled = ed.readOnly;
        pin.addEventListener('change', () => setPin(node.id, Number(pin.value)));
        parts.push(labelled('Pinned version', pin));
        const actions = el('div', 'network-record-actions');
        if (cy) { const toggle = button(ed.expanded.has(node.id) ? 'Collapse on the canvas' : 'Expand on the canvas', () => void toggleExpand(node.id), 'text-button'); toggle.id = 'network-graph-expand'; actions.append(toggle); }
        const inside = button(ed.inside === node.id ? 'Hide what is inside' : 'Show what is inside', () => { ed.inside = ed.inside === node.id ? null : node.id; renderDetails(); }, 'text-button'); inside.id = 'network-graph-inside';
        const open = button('Open its graph', () => go(`#/network/graph/${node.networkId}`), 'text-button'); open.id = 'network-graph-open-child';
        actions.append(inside, open); parts.push(actions);
        if (ed.inside === node.id) parts.push(insideList(node));
      }
      const facts = el('dl', 'network-facts');
      for (const [label, value] of [['Node ID', el('code', '', node.id)], [node.type === 'agent' ? 'Agent ID' : 'Network ID', el('code', '', node.agentId || node.networkId)], ['Position', `${Math.round(node.position.x)}, ${Math.round(node.position.y)}`]]) { const dd = el('dd'); dd.append(value); facts.append(el('dt', '', label), dd); }
      parts.push(facts);
      const linked = ed.edges.filter(edge => edge.from === node.id || edge.to === node.id), relations = el('ul', 'network-graph-list network-node-relations'); relations.setAttribute('aria-label', 'Its relations');
      for (const edge of linked) {
        const item = el('li', `network-graph-row relation-${edge.relation}`), other = byId(edge.from === node.id ? edge.to : edge.from);
        item.append(el('span', 'network-row-sub', edge.from === node.id ? `${RELATION_NAMES[edge.relation]} → ${nodeName(other)}` : `${nodeName(other)} → ${RELATION_NAMES[edge.relation]}`));
        if (!ed.readOnly) { const cut = button('Disconnect', () => removeRelation(edge.id), 'text-button'); cut.dataset.disconnectFrom = edge.id; item.append(cut); }
        relations.append(item);
      }
      parts.push(el('h4', '', `Relations (${linked.length})`), linked.length ? relations : note('None yet.'));
      if (ed.readOnly) return parts;
      const others = ed.nodes.filter(item => item.id !== node.id);
      const to = select(others.length ? others.map(item => [item.id, nodeName(item)]) : [['', 'No other node yet']]); to.id = 'network-graph-connect-to'; to.disabled = !others.length;
      const relation = select(RELATIONS); relation.id = 'network-graph-connect-relation';
      const add = button('Add relation', () => { if (addRelation(node.id, to.value, relation.value)) document.querySelector('#network-graph-connect-add')?.focus(); }, 'secondary-button'); add.id = 'network-graph-connect-add'; add.disabled = !others.length;
      if (!others.length) add.title = 'Add another node first.';
      const connect = el('fieldset', 'network-connect'); connect.append(el('legend', '', `Connect from “${clip(nodeName(node), 40)}”`), labelled('To', to), labelled('Relation', relation), add);
      const remove = button('Remove from network', () => removeNode(node.id), 'secondary-button network-danger'); remove.id = 'network-graph-node-remove';
      parts.push(connect, note('A relation records what you allow; nothing is granted or started.'), remove);
      return parts;
    }
    function insideList(node) {
      const box = el('div', 'network-inside'); box.id = 'network-graph-inside-list'; box.setAttribute('aria-live', 'polite'); box.append(note('Loading…'));
      void fetchVersion(node.networkId, node.version).then(data => {
        if (ed?.inside !== node.id || !box.isConnected) return;
        const list = el('ul', 'network-graph-list'); list.setAttribute('aria-label', `Inside version ${node.version}`);
        for (const child of data.version.nodes.slice(0, LIST_PAGE)) list.append(el('li', 'network-row-sub', `${nodeName(child, data.refs)} · ${subtitleOf(child, data.refs)}`));
        box.replaceChildren(note(`Version ${node.version}: ${plural(data.version.nodes.length, 'node')} and ${plural(data.version.edges.length, 'relation')}, read only.`), list);
        if (data.version.nodes.length > LIST_PAGE) box.append(note(`The first ${LIST_PAGE}. Open its graph to see them all.`));
      }, failure => { if (box.isConnected) box.replaceChildren(el('p', 'inline-error', failure.message)); });
      return box;
    }

    // Theme and width: the canvas takes its colours from the page's tokens and is never drawn on a phone.
    new MutationObserver(() => cy?.style(styleSheet())).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    window.addEventListener('resize', debounce(() => { if (current?.section === 'graph' && ed) { if (isPhone()) destroyCanvas(); renderEditor(); } }, 150));

    // ---- Navigation: a dirty draft asks before anything replaces it.
    /** True when `next` may show (it keeps or leaves the editor); otherwise the editor's address comes back. */
    function guard(next) {
      if (!ed?.dirty || (next?.section === 'graph' && next.networkId === ed.id && !next.version && !ed.readOnly)) return true;
      if (window.confirm(`Discard your unsaved changes to “${ed.draft.name}”?`)) { ed.dirty = false; return true; }
      location.hash = editorHash();
      return false;
    }
    function show(next) {
      const before = current; current = next;
      libPanel.hidden = next?.section !== 'library'; graphPanel.hidden = next?.section !== 'graph';
      const leftEditor = !next || next.section !== 'graph' || !next.networkId || (ed && ed.key !== `${next.networkId}@${next.version || 'draft'}`);
      if (leftEditor) { destroyCanvas(); if (!next || next.section !== 'graph' || !next.networkId) ed = null; }
      if (!next) return;
      const entered = before?.section !== next.section;
      if (entered) versionCache.clear();
      if (next.section === 'library') {
        if (entered || !lib.loaded) void loadLibrary();
        if (next.networkId && (entered || lib.detail?.network.id !== next.networkId)) { lib.detail = null; lib.detailError = null; }
        renderLibraryList(); renderLibraryDetail();
        return;
      }
      if (!next.networkId) { if (entered || !lib.loaded) void loadLibrary(); renderGraph(); return; }
      renderGraph();
      void openEditor(next.networkId, next.version);
    }
    return { library: libPanel, graph: graphPanel, show, guard, isDirty: () => Boolean(ed?.dirty) };
  }
  return { create };
})();
