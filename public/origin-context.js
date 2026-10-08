'use strict';

// Project Context panel for Origin. It shows one Markdown document generated from the saved blueprint,
// lets the person edit it (autosaved on its own revision), and offers optional destinations. The document
// is never parsed back into Origin. Every destination uses the exact saved revision; nothing starts an
// agent or a generation on its own.
window.PromptboardOriginContext = (() => {
  const WIDTH_KEY = 'promptboard.origin.context-width', SAVE_DELAY = 800, COMPOSE_BYTES = 2_000_000, PREVIEW_CHARS = 2_000_000;
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const button = (text, onClick, className = 'origin-ghost', title = '') => { const node = el('button', className, text); node.type = 'button'; if (title) node.title = title; node.addEventListener('click', onClick); return node; };
  const pref = (key, fallback = null) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
  const setPref = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
  const count = (n, word, many = `${word}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? word : many}`;
  const when = value => (value ? new Date(value).toLocaleString() : '');
  const bytes = text => new TextEncoder().encode(text).length;
  const slug = name => String(name || 'project').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').toLowerCase().slice(0, 60) || 'project';

  /** Line comparison for the regenerate review. Bounded: very large differences are summarized instead. */
  function compare(before, after) {
    const a = before.split('\n'), b = after.split('\n');
    let start = 0; while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length, endB = b.length; while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    const x = a.slice(start, endA), y = b.slice(start, endB);
    if (x.length * y.length > 4_000_000) return { rows: null, removed: x.length, added: y.length };
    const table = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) table[i][j] = x[i] === y[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    const rows = []; let i = 0, j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) { rows.push([' ', x[i]]); i++; j++; }
      else if (j < y.length && (i >= x.length || table[i][j + 1] >= table[i + 1][j])) rows.push(['+', y[j++]]);
      else rows.push(['-', x[i++]]);
    }
    return { rows, removed: rows.filter(row => row[0] === '-').length, added: rows.filter(row => row[0] === '+').length };
  }

  function create(host) {
    const { app, view, drawer } = host;
    const headerButton = button('Create Context', () => void openPanel(), 'origin-ghost origin-context-open', 'Write the saved design into one editable Markdown document');
    headerButton.id = 'origin-context-open';
    let projectId = null, doc = null, text = '', sections = [], draft = null, sourceRevision = 0, originChanged = false, loaded = false, isOpen = false;
    let tab = 'preview', sub = null, saveState = 'saved', saveMessage = '', saveTimer = null, saving = null, statusTimer = null, error = '', busy = false;
    const api = (path, options = {}) => app.api(`/api/origin/projects/${encodeURIComponent(projectId)}/document${path}`, { timeoutMs: 60000, ...options })
      .catch(() => ({ response: { ok: false, status: 0 }, data: { error: 'The app did not answer. Your document is unchanged; try again.' } }));
    const active = () => doc?.versions.find(version => version.id === doc.activeVersionId);
    const current = () => (draft ?? text);
    function accept(data) {
      if (data.document) doc = data.document;
      if (typeof data.text === 'string' && draft === null) { text = data.text; sections = data.sections || []; }
      else if (typeof data.text === 'string') { text = data.text; sections = data.sections || sections; }
      if (Number.isSafeInteger(data.sourceRevision)) sourceRevision = data.sourceRevision;
      if (typeof data.originChanged === 'boolean') originChanged = data.originChanged;
    }
    function renderButton() {
      headerButton.hidden = !projectId;
      headerButton.textContent = doc ? 'Open Context' : 'Create Context';
      headerButton.disabled = busy || !loaded;
      headerButton.setAttribute('aria-pressed', String(isOpen));
    }

    // ---- Loading and project changes ----
    async function reset(id) {
      if (isOpen) close();
      if (projectId && projectId !== id) await flush();
      clearTimeout(saveTimer); clearTimeout(statusTimer);
      projectId = id; doc = null; text = ''; sections = []; draft = null; loaded = false; originChanged = false; sub = null; error = ''; saveState = 'saved'; saveMessage = '';
      renderButton();
      if (!id) return;
      const { response, data } = await api('');
      if (id !== projectId) return;
      loaded = true;
      if (response.ok) accept(data); else error = data.error || 'The Project Context could not be read.';
      renderButton(); if (isOpen) render();
    }
    /** After Origin saves, check (quietly, at most once a second) whether its content still matches. */
    function originSaved() {
      if (!doc) return;
      clearTimeout(statusTimer);
      statusTimer = setTimeout(async () => {
        const id = projectId, { response, data } = await api('');
        if (id === projectId && response.ok && draft === null) { accept(data); if (isOpen) renderMeta(); }
        else if (id === projectId && response.ok) { originChanged = data.originChanged; sourceRevision = data.sourceRevision; if (isOpen) renderMeta(); }
      }, 1000);
    }

    // ---- Opening ----
    async function openPanel() {
      if (busy || !projectId) return;
      error = '';
      if (!doc) {
        busy = true; renderButton();
        // Only saved work is converted: pending Origin edits are saved first, and a failed save stops here.
        if (!(await host.flushOrigin())) { busy = false; renderButton(); host.showError('Origin has unsaved changes that could not be saved, so no Project Context was created. Fix the save problem first.'); return; }
        const { response, data } = await api('', { method: 'POST', body: { expectedRevision: host.revision() }, timeoutMs: 120000 });
        busy = false;
        if (!response.ok) { renderButton(); host.showError(data.error || 'The Project Context could not be created. Nothing was saved.'); return; }
        accept(data); app.announce('Project Context created from the saved design.');
      } else {
        const id = projectId, { response, data } = await api(''); // Fresh status (and text, if nothing is unsaved).
        if (id === projectId && response.ok) accept(draft === null ? data : { document: data.document, sourceRevision: data.sourceRevision, originChanged: data.originChanged });
      }
      host.closeEditor();
      isOpen = true; sub = null; tab = pref('promptboard.origin.context-tab') === 'edit' ? 'edit' : 'preview';
      applyWidth(); render(); renderButton();
      drawer.querySelector('#origin-drawer-title')?.focus();
    }
    function close() {
      if (!isOpen) return;
      isOpen = false; sub = null;
      if (draft !== null) void flush(); // Unsaved text stays in memory and keeps saving after the panel closes.
      drawer.style.removeProperty('width'); view.style.removeProperty('--origin-drawer-width');
      drawer.hidden = true; drawer.replaceChildren(); delete drawer.dataset.mode; view.dataset.drawer = 'closed';
      renderButton(); headerButton.focus({ preventScroll: true });
    }

    // ---- Saving edits: debounced, revision-checked, independent of Origin ----
    function edited(value) {
      draft = value; if (saveState !== 'conflict') saveState = 'dirty';
      clearTimeout(saveTimer); saveTimer = setTimeout(() => void save(), SAVE_DELAY);
      renderSave();
    }
    function save({ force = false } = {}) {
      clearTimeout(saveTimer); saveTimer = null;
      if (saving) return saving.then(ok => (draft !== null ? save() : ok));
      if (draft === null || (saveState === 'conflict' && !force)) return Promise.resolve(saveState === 'saved');
      const sent = draft, id = projectId;
      saveState = 'saving'; renderSave();
      saving = (async () => {
        const { response, data } = await api('', { method: 'PUT', body: { expectedRevision: doc.revision, text: sent }, timeoutMs: 120000 });
        if (id !== projectId) return false;
        if (response.ok) {
          doc = data.document; text = sent; sections = data.sections || sections; sourceRevision = data.sourceRevision; originChanged = data.originChanged;
          if (draft === sent) { draft = null; saveState = 'saved'; } else { saveState = 'dirty'; saveTimer = setTimeout(() => void save(), SAVE_DELAY); }
          saveMessage = ''; return true;
        }
        saveState = response.status === 409 && data.code === 'CONTEXT_REVISION_CONFLICT' ? 'conflict' : 'error';
        saveMessage = data.error || 'The document could not be saved.'; return false;
      })();
      return saving.finally(() => { saving = null; renderSave(); if (isOpen) renderMeta(); });
    }
    async function flush() { if (saveTimer || draft !== null) return save(); return saving ? saving : saveState !== 'error' && saveState !== 'conflict'; }
    async function reloadSaved() {
      const { response, data } = await api('');
      if (!response.ok) { saveMessage = data.error || 'The saved document could not be read.'; renderSave(); return; }
      draft = null; saveState = 'saved'; saveMessage = ''; accept(data); render();
    }
    async function keepMine() {
      const { response, data } = await api('');
      if (!response.ok) { saveMessage = data.error || 'The saved document could not be read.'; renderSave(); return; }
      doc = data.document; saveState = 'dirty'; await save({ force: true });
    }
    window.addEventListener('beforeunload', event => { if (draft !== null) { event.preventDefault(); event.returnValue = ''; } });

    // ---- Rendering ----
    let saveBox, metaBox, body, errorBox;
    function renderSave() {
      if (!saveBox) return;
      saveBox.replaceChildren();
      drawer.dataset.contextSave = saveState;
      const label = { saved: 'Saved', dirty: 'Editing…', saving: 'Saving…', error: 'Not saved', conflict: 'Changed in another window' }[saveState];
      const dot = el('span', 'origin-save-dot'); dot.setAttribute('aria-hidden', 'true');
      saveBox.append(dot, el('span', '', label));
      saveBox.title = saveMessage || (saveState === 'saved' && doc ? `Saved document revision ${doc.revision}` : label);
      if (saveState === 'error') saveBox.append(button('Retry', () => void save({ force: true }), 'origin-link'));
      if (saveState === 'conflict') saveBox.append(button('Reload saved version', () => void reloadSaved(), 'origin-link'), button('Keep mine', () => void keepMine(), 'origin-link', 'Save this window’s text over the newer saved one'));
      if (errorBox) { errorBox.textContent = ['error', 'conflict'].includes(saveState) ? saveMessage : error; errorBox.hidden = !errorBox.textContent; }
    }
    function renderMeta() {
      if (!metaBox) return;
      const version = active(), edited = draft !== null ? draft !== text || version?.edited : version?.edited;
      metaBox.replaceChildren(el('span', '', `From Origin revision ${version?.sourceRevision ?? '—'} · version ${version?.number ?? 1}`));
      if (edited) metaBox.append(Object.assign(el('span', 'origin-context-badge', 'Edited'), { title: 'This document differs from what Origin generated.' }));
      if (originChanged) {
        const badge = button('Origin changed', () => showSub('regenerate'), 'origin-context-badge changed', 'Origin’s saved design no longer matches this document. Nothing changes until you regenerate.');
        badge.id = 'origin-context-changed'; metaBox.append(badge);
      }
      if (doc?.candidateVersionId) metaBox.append(button('New version to review', () => void showCompare(), 'origin-context-badge changed'));
    }
    function menu(label, items, id) {
      const details = el('details', 'origin-menu origin-context-menu'); details.id = id;
      const summary = el('summary', 'origin-ghost', label);
      const list = el('div', 'origin-menu-list');
      for (const [text, action, title] of items) list.append(button(text, () => { details.open = false; void action(); }, 'origin-menu-item', title));
      details.append(summary, list);
      details.addEventListener('keydown', event => { if (event.key === 'Escape' && details.open) { event.preventDefault(); event.stopPropagation(); details.open = false; summary.focus(); } });
      return details;
    }
    function render() {
      if (!isOpen) return;
      drawer.dataset.mode = 'context'; view.dataset.drawer = 'open'; drawer.hidden = false;
      const grip = el('div', 'origin-context-resize'); grip.tabIndex = 0;
      for (const [name, value] of Object.entries({ role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize the Project Context panel', 'aria-valuemin': '360', 'aria-valuemax': String(maxWidth()), 'aria-valuenow': String(width()) })) grip.setAttribute(name, value);
      resizer(grip);
      const head = el('div', 'origin-drawer-head');
      const top = el('div', 'origin-drawer-top');
      const closeButton = button('', close, 'origin-icon', 'Close (Esc)'); closeButton.setAttribute('aria-label', 'Close Project Context'); closeButton.append(host.icon('close'));
      top.append(el('p', 'origin-eyebrow', 'Project Context'), closeButton);
      const title = el('h2', 'origin-context-title', doc?.title || 'Project Context'); title.id = 'origin-drawer-title'; title.tabIndex = -1;
      metaBox = el('div', 'origin-context-meta');
      saveBox = el('span', 'origin-save origin-context-save'); saveBox.id = 'origin-context-save'; saveBox.setAttribute('role', 'status'); saveBox.setAttribute('aria-live', 'polite');
      const tools = el('div', 'origin-context-tools');
      const tabs = el('div', 'origin-seg origin-context-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Document view');
      for (const [id, label] of [['preview', 'Preview'], ['edit', 'Edit']]) {
        const item = button(label, () => { tab = id; sub = null; setPref('promptboard.origin.context-tab', id); render(); (id === 'edit' ? drawer.querySelector('#origin-context-editor') : drawer.querySelector(`#origin-context-tab-${id}`))?.focus(); }, tab === id && !sub ? 'active' : '');
        item.id = `origin-context-tab-${id}`; item.setAttribute('role', 'tab'); item.setAttribute('aria-selected', String(tab === id && !sub)); item.setAttribute('aria-controls', 'origin-context-body');
        item.addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); tabs.querySelector(`[role=tab]:not([aria-selected=true])`)?.click(); } });
        tabs.append(item);
      }
      tools.append(tabs,
        menu('Use in…', [['Compose…', () => showSub('compose'), 'Attach this document to Compose as project context'], ['Save in Base…', () => showSub('base'), 'Keep a Base-owned copy'], ['Kanban…', () => showSub('kanban'), 'Supply chosen sections to one card, column or agent profile']], 'origin-context-use'),
        menu('More', [['Download .md', download], ['Copy Markdown', copy], ['Regenerate from Origin…', () => showSub('regenerate')], ['Versions…', () => showSub('versions')]], 'origin-context-more'));
      head.append(top, title, metaBox, saveBox, tools);
      body = el('div', 'origin-drawer-body origin-context-body'); body.id = 'origin-context-body';
      body.setAttribute('role', 'tabpanel');
      errorBox = el('p', 'origin-inline-error'); errorBox.setAttribute('role', 'alert'); errorBox.hidden = true;
      drawer.replaceChildren(grip, head, body, errorBox);
      renderMeta(); renderSave(); renderBody();
    }
    function renderBody() {
      if (!body) return;
      body.replaceChildren(); body.dataset.view = sub || tab;
      if (sub) return SUBVIEWS[sub]();
      if (tab === 'edit') {
        const area = el('textarea', 'origin-context-editor'); area.id = 'origin-context-editor'; area.value = current(); area.spellcheck = false;
        area.setAttribute('aria-label', 'Project Context Markdown'); area.addEventListener('input', () => edited(area.value));
        body.append(el('p', 'origin-hint', 'Edits stay in this document. Origin is never changed from here, including headings, IDs and diagrams.'), area);
        return;
      }
      const preview = el('article', 'origin-context-preview md-view'); preview.id = 'origin-context-preview';
      const all = current(), cut = all.length > PREVIEW_CHARS ? all.lastIndexOf('\n', PREVIEW_CHARS) + 1 || PREVIEW_CHARS : all.length;
      // A very long document is previewed in part so the page stays responsive; the saved file is complete.
      if (cut < all.length) body.append(el('p', 'origin-callout', `The preview shows the first ${count(cut, 'character')} of ${count(all.length, 'character')}. The saved document is complete: use Edit or Download .md for the rest.`));
      preview.append(window.PromptboardMarkdown.render(all.slice(0, cut)));
      preview.addEventListener('click', event => {
        const link = event.target.closest('a[href^="#"]');
        if (!link) return;
        event.preventDefault(); const target = preview.querySelector(`#${CSS.escape(link.getAttribute('href').slice(1))}`);
        target?.scrollIntoView({ block: 'start' }); target?.setAttribute('tabindex', '-1'); target?.focus({ preventScroll: true });
      });
      body.append(preview);
    }
    function showSub(name) { sub = name; error = ''; renderBody(); renderSave(); for (const tabButton of drawer.querySelectorAll('.origin-context-tabs [role=tab]')) tabButton.setAttribute('aria-selected', 'false'); body.querySelector('h3')?.focus(); }
    function subHead(title, lead) {
      const heading = el('h3', 'origin-context-subtitle', title); heading.tabIndex = -1;
      const back = button('← Back to the document', () => { sub = null; render(); }, 'origin-link');
      body.append(back, heading, ...(lead ? [el('p', 'origin-hint', lead)] : []));
    }
    function fail(message) { error = message; renderSave(); }

    // ---- Download and copy: always the exact saved revision ----
    async function exactSaved() {
      if (!(await flush())) { fail('Save the document first; the download and copy use the saved revision.'); return null; }
      const { response, data } = await api('');
      if (!response.ok) { fail(data.error || 'The saved document could not be read.'); return null; }
      accept(data); return data;
    }
    function saveFile(content, name) {
      const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
      const link = el('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    const fileName = (revision, extra = '') => `project-context-${slug(host.project()?.name)}-r${revision}${extra}.md`;
    async function download() { const data = await exactSaved(); if (!data) return; saveFile(data.text, fileName(data.document.revision)); app.announce(`Downloaded document revision ${data.document.revision}.`); }
    async function copy() {
      const data = await exactSaved(); if (!data) return;
      try { await navigator.clipboard.writeText(data.text); app.announce(`Copied document revision ${data.document.revision}.`); } catch { fail('The clipboard is unavailable. Use Download .md instead.'); }
    }

    // ---- Versions, regeneration and comparison ----
    const SUBVIEWS = {
      versions() {
        subHead('Versions', 'Each version was generated from Origin. Older versions keep their own edits and stay read-only here; copy what you need into the current one.');
        const list = el('ul', 'origin-context-versions');
        for (const version of [...doc.versions].sort((a, b) => b.number - a.number)) {
          const row = el('li', 'origin-context-version');
          const label = `Version ${version.number}${version.active ? ' · current' : ''}${version.candidate ? ' · waiting for review' : ''}`;
          row.append(el('strong', '', label), el('span', 'origin-hint', `From Origin revision ${version.sourceRevision} · generated ${when(version.generatedAt)}${version.edited ? ` · edited ${when(version.editedAt)}` : ''}`),
            button('View', () => void viewVersion(version), 'origin-link', `Open version ${version.number} read-only`));
          list.append(row);
        }
        body.append(list);
      },
      regenerate() {
        subHead('Regenerate from Origin', 'Regeneration reads Origin’s saved design, not this document. It makes a new version for you to compare; your current version and its edits are kept either way, and edits are not carried over automatically.');
        if (originChanged) body.append(el('p', 'origin-callout', 'Origin has changed since this version was generated.'));
        const go = button('Generate a new version', () => void regenerate(go), 'origin-primary'); go.id = 'origin-context-regenerate';
        body.append(go);
      },
      compose() {
        subHead('Use in Compose', 'Adds this document to Compose as optional design context for the target project — a plan, not evidence that the repository already does this. Your Compose request is unchanged and nothing is generated until you choose Generate.');
        const full = bytes(current()) <= COMPOSE_BYTES;
        const picker = sectionPicker(full ? null : 'This document is larger than Compose accepts (2 MB). Choose the sections Compose should receive; it gets an excerpt, labelled as such.');
        body.append(el('p', 'origin-context-plan', full ? `Compose receives the full document: revision ${doc.revision}, ${count(current().length, 'character')}.` : 'Compose receives the chosen sections as an excerpt.'),
          el('p', 'origin-hint', 'Compose reads attached documents during its research step, so attaching also turns on Research and Use selected sources in Compose. You can turn them off there.'));
        if (!full) body.append(picker.node);
        const attach = button('Attach to Compose', () => void attachCompose(full ? null : picker.chosen()), 'origin-primary'); attach.id = 'origin-context-compose';
        body.append(attach);
      },
      base() {
        subHead('Save in Base', `Saves document revision ${doc.revision} as a Base Knowledge resource you own: “Project Context: ${host.project()?.name || ''}”, ${count(sections.length, 'section')}, one complete file. It is not assigned to any agent and does not change Origin. Saving the same revision again does not make a copy.`);
        const result = el('div', 'origin-context-result');
        const save = button('Save in Base', () => void saveBase({}, result), 'origin-primary'); save.id = 'origin-context-base';
        body.append(save, result);
      },
      kanban() { void kanbanView(); },
    };
    async function viewVersion(version) {
      const { response, data } = await api(`/versions/${encodeURIComponent(version.id)}`);
      if (!response.ok) { fail(data.error || 'That version could not be read.'); return; }
      body.replaceChildren(); subHead(`Version ${version.number} (read-only)`, 'Select text to copy it into the current version.');
      const actions = el('div', 'origin-inline-actions');
      actions.append(button('Copy Markdown', async () => { try { await navigator.clipboard.writeText(data.text); app.announce(`Version ${version.number} copied.`); } catch { fail('The clipboard is unavailable.'); } }, 'origin-ghost'),
        button('Download .md', () => saveFile(data.text, fileName(doc.revision, `-version-${version.number}`)), 'origin-ghost'));
      const preview = el('article', 'origin-context-preview md-view'); preview.append(window.PromptboardMarkdown.render(data.text));
      body.append(actions, preview);
    }
    async function regenerate(control) {
      control.disabled = true; error = ''; renderSave();
      if (!(await host.flushOrigin())) { control.disabled = false; fail('Origin has unsaved changes that could not be saved. Fix that first; nothing was regenerated.'); return; }
      if (!(await flush())) { control.disabled = false; fail('Save this document first; nothing was regenerated.'); return; }
      const { response, data } = await api('/regenerate', { method: 'POST', body: { expectedRevision: doc.revision, expectedSourceRevision: host.revision() }, timeoutMs: 120000 });
      control.disabled = false;
      if (!response.ok) { fail(data.error || 'A new version could not be generated. The current version is unchanged.'); return; }
      accept(data); renderMeta(); showCompareWith(data.candidate.text);
    }
    async function showCompare() {
      const candidate = doc.versions.find(version => version.id === doc.candidateVersionId);
      if (!candidate) return;
      const { response, data } = await api(`/versions/${encodeURIComponent(candidate.id)}`);
      if (!response.ok) { fail(data.error || 'The new version could not be read.'); return; }
      sub = 'compare'; showCompareWith(data.text);
    }
    function showCompareWith(candidateText) {
      sub = 'compare'; body.replaceChildren(); body.dataset.view = 'compare';
      subHead('Compare with the new version', 'Lines starting with + are only in the new version; lines starting with − are only in the current one, including your edits. Use new version keeps the current one in Versions.');
      const result = compare(current(), candidateText);
      body.append(el('p', 'origin-context-plan', `${count(result.added, 'line')} added · ${count(result.removed, 'line')} removed`));
      if (result.rows) {
        const list = el('pre', 'origin-context-diff'); list.id = 'origin-context-diff';
        let context = 0;
        for (const [mark, line] of result.rows) {
          if (mark === ' ') { if (++context > 2) continue; } else context = 0;
          list.append(el('span', mark === '+' ? 'added' : mark === '-' ? 'removed' : '', `${mark === '-' ? '−' : mark} ${line}\n`));
        }
        body.append(list);
      } else body.append(el('p', 'origin-hint', 'The difference is too large to list here. Open both from Versions to compare them.'));
      const actions = el('div', 'origin-inline-actions');
      const use = button('Use new version', () => void resolve(true), 'origin-primary'); use.id = 'origin-context-use-new';
      actions.append(use, button('Keep current', () => void resolve(false), 'origin-ghost'));
      body.append(actions);
    }
    async function resolve(use) {
      const { response, data } = await api('/candidate', { method: 'POST', body: { expectedRevision: doc.revision, use } });
      if (!response.ok) { fail(data.error || 'The choice could not be saved.'); return; }
      draft = null; saveState = 'saved'; accept(data); sub = null; render();
      app.announce(use ? 'The new version is now current. The previous version is kept in Versions.' : 'Kept the current version.');
    }

    // ---- Destinations ----
    function sectionPicker(lead) {
      const node = el('fieldset', 'origin-context-sections'); node.append(el('legend', '', 'Sections'));
      if (lead) node.append(el('p', 'origin-hint', lead));
      const total = el('p', 'origin-context-plan'), boxes = [];
      const all = el('label', 'origin-context-section'); const allBox = el('input'); allBox.type = 'checkbox'; all.append(allBox, ' Full document');
      node.append(all);
      for (const section of sections) {
        const row = el('label', 'origin-context-section'), box = el('input'); box.type = 'checkbox'; box.value = section.id;
        row.append(box, ` ${section.title} `, el('span', 'origin-hint', `(${count(section.chars, 'character')})`)); node.append(row); boxes.push([box, section]);
      }
      const update = () => { const chosen = boxes.filter(([box]) => box.checked); allBox.checked = chosen.length === boxes.length; total.textContent = `${count(chosen.length, 'section')} · ${count(chosen.reduce((sum, [, section]) => sum + section.chars, 0), 'character')}`; };
      allBox.addEventListener('change', () => { for (const [box] of boxes) box.checked = allBox.checked; update(); });
      for (const [box] of boxes) box.addEventListener('change', update);
      node.append(total); update();
      return { node, chosen: () => boxes.filter(([box]) => box.checked).map(([, section]) => section), onChange: fn => node.addEventListener('change', fn) };
    }
    async function attachCompose(chosen) {
      if (chosen && !chosen.length) { fail('Choose at least one section.'); return; }
      const data = await exactSaved(); if (!data) return;
      const name = host.project()?.name || 'project', revision = data.document.revision, hash = data.document.versions.find(version => version.active).hash.slice(0, 10);
      const excerpt = chosen ? chosen.map(section => data.text.slice(section.start, section.end)).join('') : data.text;
      if (bytes(excerpt) > COMPOSE_BYTES) { fail('The chosen sections are larger than Compose accepts (2 MB). Choose fewer.'); return; }
      const label = `Planned design (Origin) · ${name} · revision ${revision}${chosen ? ` · excerpt, ${count(chosen.length, 'section')}` : ''}`;
      const file = `Planned design - ${name.replace(/[\/\\\x00-\x1f]/g, ' ').slice(0, 60)} - r${revision}-${hash}${chosen ? ' - excerpt' : ''}.md`;
      const result = await app.attachComposeContext({ name: file, text: excerpt, label });
      if (result === 'busy') fail('Compose is busy. Wait for it to finish, then attach again.');
      else if (result !== 'ok') fail(result || 'The document could not be attached to Compose.');
    }
    async function saveBase(extra, result) {
      const data = await exactSaved(); if (!data) return;
      result.replaceChildren(el('p', 'origin-hint', 'Saving…'));
      const { response, data: saved } = await api('/base', { method: 'POST', body: { expectedRevision: data.document.revision, ...extra } });
      result.replaceChildren();
      if (response.ok) {
        result.append(el('p', 'origin-callout', saved.existing ? `This revision is already in Base as “${saved.resource.name}”. Nothing new was created.` : `Saved in Base as “${saved.resource.name}”. It is not assigned to any agent.`),
          button('Open Base', () => { location.hash = '#/base'; }, 'origin-link'));
        app.announce(saved.existing ? 'Already saved in Base.' : 'Saved in Base.');
        return;
      }
      if (saved.code === 'BASE_COPY_EXISTS') {
        result.append(el('p', 'origin-hint', saved.error));
        for (const copy of saved.copies) {
          const row = el('div', 'origin-context-copy'), replace = el('label', 'origin-hint'), box = el('input'); box.type = 'checkbox';
          row.append(el('span', '', `${copy.name} · from document revision ${copy.documentRevision}${copy.edited ? ' · edited in Base' : ''}`));
          if (copy.edited) { replace.append(box, ' Replace the edits made in Base'); row.append(replace); }
          row.append(button('Update this copy', () => { if (copy.edited && !box.checked) { fail('This copy was edited in Base. Confirm that those edits may be replaced, or save a new copy.'); return; } void saveBase({ mode: 'update', resourceId: copy.id, replaceEdited: box.checked }, result); }, 'origin-ghost'));
          result.append(row);
        }
        result.append(button('Save as a new copy', () => void saveBase({ mode: 'copy' }, result), 'origin-ghost'));
        return;
      }
      fail(saved.error || 'The document could not be saved in Base. Nothing was changed.');
    }
    async function kanbanView() {
      subHead('Use in Kanban', 'Supplies the sections you choose to one scope through Base. Existing assignments, permissions and task text stay as they are; runs that already started keep what they received.');
      const project = host.project(), kanban = project?.kanbanProjectId ? app.projects().find(item => item.id === project.kanbanProjectId) : null;
      const base = await app.api('/api/base').catch(() => ({ response: { ok: false }, data: {} }));
      if (sub !== 'kanban') return;
      const profiles = base.response.ok ? (base.data.resources || []).filter(resource => resource.kind === 'profile') : [];
      const scopeField = el('label', 'origin-field'), scope = el('select'); scope.id = 'origin-context-scope';
      scopeField.append(el('span', 'origin-field-label', 'Scope'), scope);
      const options = [];
      if (kanban) {
        for (const task of kanban.tasks) options.push([`task:${task.id}`, `Card${task.number ? ` #${task.number}` : ''}: ${task.title}`]);
        for (const column of (kanban.columns || []).filter(column => !['todo', 'done'].includes(column.role) && !['todo', 'done'].includes(column.id))) options.push([`column:${column.id}`, `Column: ${column.title || column.name || column.id}`]);
      }
      for (const profile of profiles) options.push([`profile:${profile.id}`, `Agent profile: ${profile.name}`]);
      if (!options.length) { body.append(el('p', 'origin-callout', kanban ? 'This Kanban project has no cards or agent columns yet.' : 'Connect this Origin project to a Kanban project first, or create an agent profile in Base.')); return; }
      scope.append(...[['', 'Choose a card, column or agent profile…'], ...options].map(([value, label]) => Object.assign(el('option', '', label), { value })));
      const picker = sectionPicker('Choose what agents in this scope need. One run receives at most 48,000 characters from Base; larger selections are refused, not cut.');
      const plan = el('div', 'origin-context-result'); plan.id = 'origin-context-kanban-plan';
      const apply = button('Use in Kanban', () => void sendKanban(false), 'origin-primary'); apply.id = 'origin-context-kanban'; apply.disabled = true;
      const request = preview => {
        const [kind, id] = scope.value.split(/:(.*)/s);
        return { expectedRevision: doc.revision, pageIds: picker.chosen().map(section => section.id), preview, target: kind === 'task' ? { scope: 'task', taskId: id } : kind === 'column' ? { scope: 'column', columnId: id } : { scope: 'profile', profileId: id } };
      };
      let sequence = 0;
      async function sendKanban(preview) {
        error = ''; renderSave();
        if (!scope.value || !picker.chosen().length) { apply.disabled = true; plan.replaceChildren(); return; }
        if (!preview && !(await flush())) { fail('Save the document first.'); return; }
        const mine = ++sequence;
        const { response, data } = await api('/kanban', { method: 'POST', body: request(preview) });
        if (mine !== sequence) return;
        plan.replaceChildren();
        if (!response.ok) { apply.disabled = true; plan.append(el('p', 'origin-inline-error', data.error || 'This scope cannot receive the document.')); return; }
        const p = data.plan;
        plan.append(el('ul', 'origin-context-steps'));
        const steps = plan.firstChild;
        for (const line of [
          `${p.full ? 'The full document' : `${count(p.sections.length, 'section')}`}, ${count(p.chars, 'character')}, from document revision ${p.documentRevision}.`,
          p.copy.status === 'new' ? `First saves a Base copy: “${p.copy.name}”.` : `Uses the Base copy “${p.copy.name}”.`,
          p.selection.status === 'new' ? `Creates the Base context resource “${p.selection.name}”, supplied complete or not at all.` : `Uses the Base context resource “${p.selection.name}”.`,
          `Adds it to ${p.scope.name}. Existing assignments are kept.`]) steps.append(el('li', '', line));
        if (preview) { apply.disabled = data.alreadyAssigned; if (data.alreadyAssigned) plan.append(el('p', 'origin-hint', 'This scope already receives these sections.')); return; }
        apply.disabled = true;
        plan.append(el('p', 'origin-callout', data.assigned ? 'Done. Future runs in this scope receive these sections; running sessions are not changed.' : 'This scope already received these sections. Nothing changed.'));
        app.announce(data.assigned ? 'Project Context sections assigned.' : 'Nothing changed.');
      }
      scope.addEventListener('change', () => void sendKanban(true)); picker.onChange(() => void sendKanban(true));
      body.append(scopeField, picker.node, plan, apply);
    }

    // ---- Resizing (desktop): pointer or arrow keys; a full-width sheet on narrow screens ----
    const maxWidth = () => Math.max(360, Math.min(1100, window.innerWidth - 140));
    const width = () => Math.min(maxWidth(), Math.max(360, Number(pref(WIDTH_KEY)) || 560));
    function applyWidth(value = width()) {
      const next = Math.min(maxWidth(), Math.max(360, Math.round(value)));
      setPref(WIDTH_KEY, String(next));
      if (window.matchMedia('(max-width: 730px)').matches) { drawer.style.removeProperty('width'); view.style.removeProperty('--origin-drawer-width'); return next; }
      drawer.style.width = `${next}px`; view.style.setProperty('--origin-drawer-width', `${next}px`);
      drawer.querySelector('.origin-context-resize')?.setAttribute('aria-valuenow', String(next));
      return next;
    }
    function resizer(grip) {
      grip.addEventListener('pointerdown', event => {
        event.preventDefault(); grip.setPointerCapture(event.pointerId);
        const move = moved => applyWidth(window.innerWidth - moved.clientX - 12);
        const stop = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', stop); grip.removeEventListener('pointercancel', stop); };
        grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', stop); grip.addEventListener('pointercancel', stop);
      });
      grip.addEventListener('keydown', event => {
        const step = { ArrowLeft: 40, ArrowRight: -40, Home: 1e6, End: -1e6 }[event.key];
        if (step === undefined) return;
        event.preventDefault(); applyWidth(width() + step);
      });
    }
    window.addEventListener('resize', () => { if (isOpen) applyWidth(); });

    return { button: headerButton, reset, originSaved, flush, close, open: openPanel, isOpen: () => isOpen };
  }

  return { create, compare };
})();
