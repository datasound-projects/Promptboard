'use strict';

// Origin: the project blueprint workspace. Every section is a short list you type into, one drawer edits
// one record, and the Overview draws the whole blueprint as a mind map. Origin owns its blueprint requests
// and reaches Compose and Kanban only through explicit application seams. All user text is rendered as DOM
// text. Nothing here starts an agent, calls a model or fetches a source.
window.PromptboardOrigin = (() => {
  const M = globalThis.PromptboardOriginModel;
  const SECTION_KEY = 'promptboard.origin.section', MORE_KEY = 'promptboard.origin.more', PROJECT_KEY = 'promptboard.origin.project', TASK_VIEW_KEY = 'promptboard.origin.task-view';
  const SAVE_DELAY = 700, SAVE_MAX_WAIT = 3000;
  const NODE_W = 184, NODE_H = 58, GAP_X = 270, GAP_Y = 100;
  // Built-in guiding questions. Each project can reword them; the wording never changes what a section does.
  const QUESTION = M.QUESTIONS;
  // Built-in categories keep their colour; a project's own categories take the five colours in turn.
  const TONES = M.PHASES.map(phase => phase.id);
  const NOUN = { requirements: 'Requirement', components: 'Component', connections: 'Connection', technologies: 'Technology', dependencies: 'Dependency', decisions: 'Decision',
    assumptions: 'Assumption', sources: 'Source', risks: 'Risk', areas: 'Approach', milestones: 'Milestone', items: 'Task', layers: 'Layer', blocks: 'Block' };
  // Reference fields → the collection they point to. Used for deletes and “used by”.
  const REFS = { componentIds: 'components', technologyIds: 'technologies', requirementIds: 'requirements', dependencyIds: 'dependencies', sourceIds: 'sources',
    requiredBy: 'components', dependsOn: owner => (owner === 'dependencies' ? 'dependencies' : 'items'), supersededBy: 'decisions', decisionId: 'decisions',
    milestoneId: 'milestones', layerId: 'layers', from: 'components', to: 'components' };
  const COMPOSABLE = new Set(['requirements', 'components', 'decisions', 'milestones', 'items']);
  // New-record defaults come from the shared model; a source typed here may be a link, so its title comes from the host.
  const BLANK = { ...M.RECORD_DEFAULTS,
    sources: text => { const url = safeUrl(text); return { ...M.RECORD_DEFAULTS.sources(url ? hostOf(url) : text), url }; } };

  const { el, pref, setPref, plural, clip, safeUrl } = window.PromptboardDom;
  const button = (text, onClick, className = 'origin-ghost', title) => window.PromptboardDom.button(text, onClick, className, title);
  const chip = (text, tone = '') => el('span', `origin-chip${tone ? ` ${tone}` : ''}`, text);
  const newId = () => globalThis.crypto?.randomUUID?.() || `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  function today() { return new Date().toLocaleDateString('en-CA'); }
  function hostOf(value) { try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return ''; } }
  const firstLine = text => M.lines(text)[0] || '';
  function icon(d, size = 16) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'aria-hidden': 'true' })) svg.setAttribute(name, value);
    const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', d); svg.append(path);
    return svg;
  }
  const ICON = { edit: 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4', plus: 'M12 5v14M5 12h14', minus: 'M5 12h14', fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5', grip: 'M20 10L10 20M20 15l-5 5M20 4L4 20', close: 'M6 6l12 12M18 6 6 18', dots: 'M5 12h.01M12 12h.01M19 12h.01', handle: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01', arrow: 'M5 12h14M13 6l6 6-6 6', link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
    up: 'M6 15l6-6 6 6', down: 'M6 9l6 6 6-6' };
  // One small picture per block type.
  const BLOCK_ICON = { qa: 'M4 5h16v11H10l-6 4zM9 9h6M9 12h4', table: 'M3 5h18v14H3zM3 10h18M3 15h18M10 5v14', checklist: 'M4 7l2 2 3-3M4 16l2 2 3-3M13 8h7M13 17h7',
    flow: 'M3 5h7v5H3zM14 14h7v5h-7zM10 7.5h2.5a2 2 0 0 1 2 2V14', notes: 'M6 3h9l4 4v14H6zM9 11h7M9 15h7M9 7h3' };
  const FLOW_W = 168, FLOW_H = 46, FLOW_X = 230, FLOW_Y = 82;
  /** An SVG element factory for one drawing: make(tag, attributes, parent = the drawing). */
  const svgMaker = root => (tag, attrs = {}, parent = root) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
    parent.append(node); return node;
  };
  /** Pointer dragging on a node of an SVG drawing: a press without movement is a click; movement reports the offset in drawing units. */
  function draggable(svg, node, { start, move, drop, click, cancel }) {
    let drag = null;
    node.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      const matrix = svg.getScreenCTM()?.inverse(); if (!matrix) return;
      drag = { id: event.pointerId, start: new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix), moved: false, matrix };
      start(); node.setPointerCapture?.(event.pointerId);
    });
    node.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      const now = new DOMPoint(event.clientX, event.clientY).matrixTransform(drag.matrix), dx = now.x - drag.start.x, dy = now.y - drag.start.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true; move(dx, dy);
    });
    node.addEventListener('pointerup', event => {
      if (!drag || event.pointerId !== drag.id) return;
      const moved = drag.moved; drag = null;
      if (moved) drop(); else click();
    });
    node.addEventListener('pointercancel', () => { drag = null; cancel(); });
  }
  function autoGrow(area) {
    const fit = () => { if (!area.isConnected) return; area.style.height = 'auto'; area.style.height = `${area.scrollHeight + 2}px`; };
    // Measured again when Origin is shown: a field drawn while the page was hidden has no height yet.
    area.addEventListener('input', fit); area.addEventListener('origin-fit', fit); requestAnimationFrame(fit);
    return area;
  }

  function create(app) {
    const view = document.querySelector('#origin-view'), navigator = document.querySelector('#origin-nav');
    if (!view || !navigator) return null;
    view.replaceChildren();
    const heading = el('h1', 'sr-only', 'Origin'); heading.id = 'origin-heading';
    const header = el('header', 'origin-header');
    const projectBox = el('div', 'origin-project');
    const projectSelect = el('select', 'origin-project-select'); projectSelect.id = 'origin-project'; projectSelect.setAttribute('aria-label', 'Project');
    const newProject = button('New project', () => openNewProject(), 'origin-ghost origin-new', 'Start a new project here');
    newProject.id = 'origin-new-project'; newProject.prepend(icon(ICON.plus, 15));
    // Project menu: rename, connect to Kanban, delete. The link chip shows where tasks go.
    const menu = el('details', 'origin-menu'); menu.id = 'origin-project-menu';
    const menuSummary = el('summary', 'origin-icon'); menuSummary.setAttribute('aria-label', 'Project options'); menuSummary.title = 'Project options'; menuSummary.append(icon(ICON.dots));
    const menuList = el('div', 'origin-menu-list');
    menuList.append(button('Rename…', () => { menu.open = false; openRename(); }, 'origin-menu-item'), button('Connect to Kanban…', () => { menu.open = false; openConnect(); }, 'origin-menu-item'),
      button('Save structure as blueprint…', () => { menu.open = false; openSaveBlueprint(); }, 'origin-menu-item'), button('Reset structure…', () => { menu.open = false; openReset(); }, 'origin-menu-item'), button('Delete from Origin…', () => { menu.open = false; openDelete(); }, 'origin-menu-item danger'));
    menu.append(menuSummary, menuList);
    const linkChip = button('', () => { const linked = project(); if (linked?.kanban?.exists) app.openKanban(linked.kanbanProjectId); else openConnect(); }, 'origin-link-pill');
    linkChip.id = 'origin-kanban-link';
    projectBox.append(projectSelect, menu, linkChip, newProject);
    const statusBox = el('div', 'origin-header-status');
    const readinessButton = button('', () => openSection('overview'), 'origin-pill'); readinessButton.id = 'origin-readiness';
    const saveStatus = el('span', 'origin-save'); saveStatus.id = 'origin-save'; saveStatus.setAttribute('role', 'status'); saveStatus.setAttribute('aria-live', 'polite');
    statusBox.append(readinessButton, saveStatus);
    header.append(projectBox, statusBox);
    const errorBox = el('p', 'origin-banner origin-error'); errorBox.id = 'origin-error'; errorBox.setAttribute('role', 'alert'); errorBox.hidden = true;
    const notice = el('p', 'origin-banner'); notice.id = 'origin-notice'; notice.setAttribute('role', 'status'); notice.hidden = true;
    // After a removal: one Undo, until the next change.
    const undoBar = el('div', 'origin-banner origin-undo'); undoBar.id = 'origin-undo'; undoBar.setAttribute('role', 'status'); undoBar.hidden = true;
    const main = el('section', 'origin-main'); main.id = 'origin-main'; main.setAttribute('aria-labelledby', 'origin-section-heading');
    const drawer = el('aside', 'origin-drawer'); drawer.id = 'origin-drawer'; drawer.hidden = true; drawer.tabIndex = -1; drawer.setAttribute('aria-labelledby', 'origin-drawer-title');
    view.append(heading, header, errorBox, notice, undoBar, main, drawer);
    // Project Context: a separate, editable Markdown document in the same right-side panel.
    const contextPanel = window.PromptboardOriginContext.create({ app, view, drawer, icon: name => icon(ICON[name]), exists: () => Boolean(record?.exists),
      project: () => project(), revision: () => record?.revision, flushOrigin: () => flush(), closeEditor: () => { if (open) closeDrawer(); researchPanel.yieldDrawer(); }, showError: message => showError(message) });
    statusBox.prepend(contextPanel.button);
    // Research: a chat with the user's CLI in the same panel. It suggests changes; only the user applies them.
    const researchPanel = window.PromptboardOriginResearch.create({ app, view, drawer, blueprint: () => (record?.exists ? bp() : null), revision: () => record?.revision,
      composeSettings: () => app.composeSettings?.(), closeOthers: () => { if (open) closeDrawer(); contextPanel.close(); },
      currentFocus: () => ({ section, record: open ? { ...open } : null }), applyProposal: (proposal, options) => applyResearch(proposal, options), resolveLinks: (pending, refs) => resolveResearchLinks(pending, refs), saveNow: () => flush() });
    contextPanel.button.after(researchPanel.button);

    let projects = [], projectId = null, record = null, loading = null, loadError = null, visible = false;
    let section = pref(SECTION_KEY) || 'overview';
    let open = null, connectFrom = null, planSelection = new Set(), handoffBusy = false, lastHandoff = '';
    let views = { map: null, canvas: null }, mapLinkFrom = null, selectedLink = null, taskMilestone = '', taskView = pref(TASK_VIEW_KEY, 'layers');
    let flowConnect = null, flowStep = null; // A flow block: the arrow being drawn ({ block, from }) and the step being edited ({ block, node }).
    let contextView = { itemId: null, open: false, loading: false, revision: 0, data: null, error: '' }, drawerMessage = null;
    let saveTimer = null, saving = null, changeCount = 0, savedCount = 0, saveState = 'saved', saveMessage = '', dirtySince = 0, shownSaveError = '';
    let baseResources = null, baseLoading = null, focusAfter = null, renderFrame = 0, uid = 0, undo = null, dragging = null;
    const quickDrafts = new Map(); // Unsent "Add …" text survives re-renders and view switches.
    const bp = () => record.blueprint;
    // The sidebar reads top to bottom as the order of work, in this project's own names.
    const phases = () => M.phaseList(record?.exists ? bp() : null).map((phase, index) => ({ ...phase, number: String(index + 1).padStart(2, '0'), tone: TONES.includes(phase.id) ? phase.id : TONES[index % TONES.length] }));
    // Overview is the project's home: always first, never in a category.
    const order = () => [M.HOME, ...phases().flatMap(phase => phase.sections)];
    const phaseOf = id => phases().find(phase => phase.sections.includes(id)) || null;
    const toneOf = id => phaseOf(id)?.tone || 'define';
    const sectionName = id => M.sectionTitle(record?.exists ? bp() : null, id);
    const isCustom = id => Boolean(record?.exists && bp().customSections.some(entry => entry.id === id));
    const topicName = (id, topic) => M.questionText(bp(), `topic:${id}:${topic}`, M.label(id, topic));
    const project = () => projects.find(item => item.id === projectId) || null;
    // Progress comes from Kanban: the card's current column, never Origin's own planning status.
    const kanbanCards = () => new Map(app.projects().flatMap(item => item.tasks.map(task => {
      const column = (item.columns || []).find(entry => entry.id === task.column);
      // Done without merging is not finished work: its code is not on the target branch.
      const inDone = task.column === 'done' || column?.role === 'done', unmerged = inDone && Boolean(task.workspace) && (task.completion?.kind === 'unmerged' || (task.completion?.kind === 'pull_request' && !task.completion.mergedAt));
      return [task.id, { task, column: `${column?.title || column?.name || task.column}${unmerged ? ' · not merged' : ''}`, done: inDone && !unmerged }];
    })));
    const showError = message => { errorBox.textContent = message; errorBox.hidden = !message; };
    // A project whose blueprint could not be read can still be renamed, connected or deleted: the list carries its revision.
    const revisionOf = current => record?.revision ?? current.revision;
    const saveRevision = (revision, next) => { if (record) record.revision = revision; projects = projects.map(item => (item.id === next.id ? next : item)); };
    const showNotice = message => { notice.textContent = message; notice.hidden = !message; };

    // ---- Saving: debounced, revision-checked autosave with a visible state ----
    function changed({ structure = false, drawer: redraw = false } = {}) {
      if (!record?.exists) return;
      changeCount++;
      if (undo) hideUndo();
      if (saveState !== 'conflict') { saveState = 'dirty'; saveMessage = ''; }
      // Debounced, but continuous editing still saves at least every few seconds.
      dirtySince ||= Date.now();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { void save(); }, Date.now() - dirtySince >= SAVE_MAX_WAIT ? 0 : SAVE_DELAY);
      renderSave();
      if (structure) renderMain(); else scheduleRender();
      if (redraw) renderDrawer();
    }
    // Typing in the page must keep its focus, so the page is redrawn only when focus is elsewhere.
    function scheduleRender() {
      if (renderFrame) return;
      renderFrame = requestAnimationFrame(() => { renderFrame = 0; if (main.contains(document.activeElement)) renderDerived(); else renderMain(); });
    }
    // News from elsewhere (a card's status, a finished run) redraws the page, but never the field you are typing in.
    function refreshMain() { if (main.contains(document.activeElement) && document.activeElement.matches('input, textarea, select')) renderDerived(); else renderMain(); }
    async function save({ force = false } = {}) {
      clearTimeout(saveTimer); saveTimer = null;
      if (saveState === 'conflict' && !force) return false; // Not saved: only Reload or Keep mine resolves it.
      if (!record?.exists || saveState === 'gone' || changeCount === savedCount && !force) return true;
      if (saving) { await saving; return changeCount === savedCount ? true : save(); }
      const target = changeCount, id = projectId;
      saveState = 'saving'; renderSave();
      saving = (async () => {
        const { response, data } = await app.api(`/api/origin/projects/${encodeURIComponent(id)}`, { method: 'PUT', body: { expectedRevision: record.revision, blueprint: record.blueprint }, timeoutMs: 30000 })
          .catch(() => ({ response: { ok: false, status: 0 }, data: { error: 'The app did not answer. Your changes are kept in this window.' } }));
        if (id !== projectId) return false;
        if (response.ok) {
          record.revision = data.revision; savedCount = target;
          // The server stores what fits (over-long text shortened, broken links removed): show the stored version and say so.
          if (data.repairs > 0 && data.blueprint && changeCount === target) {
            record.blueprint = data.blueprint;
            showNotice(`${plural(data.repairs, 'entry was', 'entries were')} too long or invalid and ${data.repairs === 1 ? 'was' : 'were'} shortened or removed when saved. The page shows what was saved.`);
            renderMain(); renderDrawer();
          }
          if (data.project) projects = projects.map(item => (item.id === id ? data.project : item));
          saveState = changeCount === savedCount ? 'saved' : 'dirty'; saveMessage = '';
          if (saveState === 'saved' && (section === 'plan' || open?.collection === 'items')) void refreshContextStatus();
          dirtySince = saveState === 'saved' ? 0 : Date.now();
          if (saveState === 'dirty') saveTimer = setTimeout(() => { void save(); }, SAVE_DELAY);
          contextPanel.originSaved();
          return true;
        }
        // Deleted in another window: nothing here can be saved any more, and it must not keep you from moving on.
        if (response.status === 404) { saveState = 'gone'; saveMessage = 'This project was deleted in another window, so the changes made here cannot be saved. Choose another project.'; void refreshProjects(); return true; }
        saveState = response.status === 409 && data.code === 'ORIGIN_REVISION_CONFLICT' ? 'conflict' : 'error';
        saveMessage = typeof data.error === 'string' ? data.error : 'The blueprint could not be saved.';
        return false;
      })();
      try { return await saving; } finally { saving = null; renderSave(); }
    }
    function renderSave() {
      saveStatus.replaceChildren();
      view.dataset.save = saveState;
      if (!record?.exists) return;
      const text = { saved: 'Saved', dirty: 'Editing…', saving: 'Saving…', error: 'Not saved', conflict: 'Changed in another window', gone: 'Deleted in another window' }[saveState];
      const dot = el('span', 'origin-save-dot'); dot.setAttribute('aria-hidden', 'true');
      saveStatus.append(dot, el('span', '', text));
      saveStatus.title = saveMessage || (saveState === 'saved' ? `Saved revision ${record.revision}` : text);
      if (saveState === 'error') saveStatus.append(button('Retry', () => void save({ force: true }), 'origin-link'));
      if (saveState === 'conflict') saveStatus.append(button('Reload saved version', () => void load(projectId, { force: true }), 'origin-link'),
        button('Keep mine', () => void keepMine(), 'origin-link', 'Save this window’s version over the newer saved one'));
      // Only save problems are shown or cleared here; other messages keep their own lifetime.
      const message = ['error', 'conflict', 'gone'].includes(saveState) ? saveMessage : '';
      if (message !== shownSaveError) { if (message || errorBox.textContent === shownSaveError) showError(message); shownSaveError = message; }
    }
    async function keepMine() {
      const { response, data } = await app.api(`/api/origin/projects/${encodeURIComponent(projectId)}`, { timeoutMs: 30000 }).catch(() => ({ response: { ok: false }, data: {} }));
      if (!response.ok) { saveMessage = data.error || 'The saved version could not be read.'; renderSave(); return; }
      record.revision = data.revision; saveState = 'dirty'; await save({ force: true });
    }
    async function flush() {
      if (!record?.exists || saveState === 'gone') return true;
      // Changes that arrive while saving (a running Apply all) are saved too before anyone moves on.
      if (saveTimer || changeCount !== savedCount) return (await save()) && flush();
      if (saving) return saving;
      return saveState !== 'error' && saveState !== 'conflict';
    }
    window.addEventListener('beforeunload', event => { if (record?.exists && saveState !== 'gone' && changeCount !== savedCount) { event.preventDefault(); event.returnValue = ''; } });

    // ---- Loading ----
    async function load(id, { force = false } = {}) {
      if (!force && id === projectId && (record || loading)) return loading;
      projectId = id; record = null; loadError = null; open = null; connectFrom = null; planSelection = new Set(); lastHandoff = '';
      views = { map: null, canvas: null }; mapLinkFrom = null; selectedLink = null; flowConnect = null; flowStep = null; taskMilestone = ''; contextView = { itemId: null, open: false, loading: false, revision: 0, data: null, error: '' };
      contextStatus = { revision: -1, loading: false, map: new Map() };
      changeCount = savedCount = 0; dirtySince = 0; saveState = 'saved'; showNotice(''); showError(''); hideUndo();
      renderDrawer(); void contextPanel.reset(id); void researchPanel.reset(id);
      if (!id) { render(); return null; }
      main.replaceChildren(el('p', 'origin-empty-note', 'Loading blueprint…')); main.setAttribute('aria-busy', 'true');
      const attempt = (async () => {
        const { response, data } = await app.api(`/api/origin/projects/${encodeURIComponent(id)}`, { timeoutMs: 30000 }).catch(() => ({ response: { ok: false, status: 0 }, data: {} }));
        if (id !== projectId) return;
        if (!response.ok) {
          loadError = typeof data.error === 'string' ? data.error : 'The blueprint could not be loaded. Board, Compose and Base data are unaffected.';
          if (response.status === 404) await refreshProjects();
          return;
        }
        record = { exists: true, revision: data.revision, blueprint: data.blueprint || M.emptyBlueprint() };
        if (data.project) projects = projects.map(item => (item.id === id ? data.project : item));
        const notes = [];
        if (data.recovery?.quarantined) notes.push(data.recovery.restoredFromBackup ? 'The blueprint file was damaged, so the last good copy was restored. The damaged file was kept in the app data folder.' : 'The blueprint file was damaged and no good copy was found. The damaged file was kept in the app data folder.');
        else if (data.recovery?.restoredFromBackup) notes.push('The blueprint file was missing, so the last good copy was restored.');
        if (data.repairs) notes.push(`${plural(data.repairs, 'invalid entry', 'invalid entries')} or broken links were removed while loading. The cleaned blueprint is saved with your next change.`);
        showNotice(notes.join(' '));
      })();
      loading = attempt;
      try { await attempt; } finally { if (loading === attempt) loading = null; main.removeAttribute('aria-busy'); if (id === projectId) render(); }
    }

    /** Origin's own project list. Its selection is independent of the project selected in Kanban. */
    async function refreshProjects() {
      const { response, data } = await app.api('/api/origin/projects', { timeoutMs: 30000 }).catch(() => ({ response: { ok: false }, data: {} }));
      if (!response.ok) { showError(typeof data.error === 'string' ? data.error : 'Origin projects could not be loaded. Board, Compose and Base data are unaffected.'); return false; }
      projects = Array.isArray(data.projects) ? data.projects : [];
      if (data.unreadable > 0) showNotice(`${plural(data.unreadable, 'Origin project was', 'Origin projects were')} left out: ${data.unreadable === 1 ? 'its file was' : 'their files were'} saved by a newer Promptboard version or cannot be read. The files were not changed.`);
      return true;
    }
    async function show() {
      visible = true; baseResources = null; // Base may have changed while Origin was hidden.
      requestAnimationFrame(() => { for (const area of view.querySelectorAll('textarea')) area.dispatchEvent(new Event('origin-fit')); });
      await app.ensureBoard();
      if (!(await refreshProjects())) { render(); return; }
      const stored = pref(PROJECT_KEY);
      const id = projects.some(item => item.id === projectId) ? projectId : projects.some(item => item.id === stored) ? stored : projects[0]?.id || null;
      if (id !== projectId || !record && !loading) {
        if (projectId && projects.some(item => item.id === projectId) && !(await flush())) { renderProjects(); return; }
        await load(id);
      } else {
        // Only Origin writes the blueprint, so an open editor is left as it is; redrawing it would drop a pending confirmation.
        renderProjects(); renderMain(); renderSave();
      }
    }
    async function leave() { visible = false; connectFrom = null; mapLinkFrom = null; await flush(); await contextPanel.flush(); }

    /** Before another project opens: '' when the blueprint and the Project Context are saved, otherwise why not. */
    async function unsaved() {
      if (!(await flush())) return 'This blueprint has unsaved changes. Save or reload it before switching projects.';
      if (!(await contextPanel.flush())) return 'The Project Context has unsaved edits. Retry its save or reload it before switching projects.';
      return '';
    }
    async function switchProject(id) {
      if (id === projectId) return;
      const problem = await unsaved();
      if (problem) { projectSelect.value = projectId; showError(problem); return; }
      setPref(PROJECT_KEY, id);
      await load(id);
    }
    projectSelect.addEventListener('change', () => { void switchProject(projectSelect.value); });

    // ---- Rendering ----
    function render() { renderProjects(); renderMain(); renderSave(); renderDrawer(); }
    function renderProjects() {
      projectSelect.replaceChildren(...projects.map(item => Object.assign(el('option', '', item.name), { value: item.id })));
      projectSelect.value = projectId || '';
      const current = project();
      // After a failed load the selector stays, so you can choose another project; it hides only when there is none.
      projectSelect.hidden = !projects.length || (!current && !loadError);
      menu.hidden = linkChip.hidden = !current;
      if (!current) return;
      const linked = current.kanban;
      linkChip.replaceChildren(el('span', `origin-link-dot${linked?.exists ? ' on' : ''}`), el('span', '', linked?.exists ? `Kanban · ${linked.name}` : linked ? 'Kanban project removed' : 'Not on Kanban'));
      linkChip.title = linked?.exists ? `Open this project on Kanban${linked.github ? ` · GitHub ${linked.github}` : ''}` : 'Connect this project to Kanban';
      linkChip.dataset.state = linked?.exists ? 'linked' : linked ? 'missing' : 'none';
    }
    function renderDerived() {
      view.dataset.empty = String(!record?.exists);
      if (!record?.exists) { navigator.replaceChildren(el('p', 'origin-nav-empty', loadError ? 'This project could not be loaded.' : record || !projectId ? 'Your blueprint sections appear here once you start.' : 'Loading…')); readinessButton.hidden = true; return; }
      const found = M.issues(bp()), ready = M.readiness(bp(), found), states = M.sectionStates(bp(), found);
      renderNavigator(states);
      readinessButton.hidden = false;
      readinessButton.dataset.state = ready.state;
      readinessButton.replaceChildren(el('span', 'origin-pill-dot'), el('span', '', ready.state === 'attention' ? `${plural(ready.blocking.length, 'thing')} to resolve` : ready.label));
      readinessButton.title = `${ready.label}. ${ready.reasons.join(' ')}`;
      main.querySelector('.origin-next-slot')?.replaceChildren(...nextStep(found));
    }
    function sectionCount(id) {
      const blueprint = bp();
      const counts = { vision: M.VISION.filter(key => key !== 'architectureSummary' && blueprint.vision[key].trim()).length, requirements: blueprint.requirements.length,
        architecture: blueprint.components.length, technology: blueprint.technologies.length, dependencies: blueprint.dependencies.length,
        research: blueprint.sources.length + blueprint.assumptions.length + blueprint.risks.length, decisions: blueprint.decisions.length, plan: blueprint.items.length };
      // Your own answered questions count in built-in sections too.
      const own = blueprint.questions.filter(question => question.sectionId === id && blueprint.answers[question.id]?.trim()).length + blueprint.blocks.filter(block => block.sectionId === id && M.blockWorked(block)).length;
      if (counts[id] !== undefined) return counts[id] + own;
      if (M.AREAS[id]) return blueprint.areas.filter(item => item.section === id).length + own;
      return own;
    }
    // ---- The sidebar: Overview, then the project's categories with their sections. Every category and section has a
    // ⋯ menu (also the keyboard way to move them); drag a section or a category's handle to reorder. ----
    function renderNavigator(states) {
      // A rename in progress, an open menu or a drag is never thrown away by a redraw.
      if (navigator.contains(document.activeElement) && document.activeElement.matches('.origin-inline-input') || navigator.querySelector('.origin-menu[open]') || dragging) return;
      const focused = navigator.contains(document.activeElement) ? document.activeElement.dataset.nav : null;
      const home = el('div', 'origin-nav-home phase-define'); home.append(navItem(M.HOME, states));
      const all = phases(), groups = all.map((phase, index) => categoryBox(phase, index, all, states));
      const add = button('Add category', () => addCategoryHere(), 'origin-link origin-add-category'); add.id = 'origin-add-category'; add.dataset.nav = 'add-category'; add.prepend(icon(ICON.plus, 13));
      const nodes = [home, ...groups];
      if (groups.length) nodes.push(add);
      else {
        const empty = el('div', 'origin-nav-start');
        empty.append(el('p', 'origin-nav-empty', 'No categories yet. Add one, then add sections to it.'), add,
          button('Use the default categories', () => restructure(() => M.restoreDefaultStructure(bp()), { announce: 'The default categories and sections were added.' }), 'origin-link origin-use-default'));
        nodes.push(empty);
      }
      navigator.replaceChildren(...nodes);
      if (focused) navigator.querySelector(`[data-nav="${CSS.escape(focused)}"]`)?.focus();
    }
    function navItem(id, states) {
      const meaning = M.SECTION_STATE[states[id] || 'empty'][1];
      const item = el('button', 'origin-nav-item'); item.type = 'button'; item.dataset.section = id; item.dataset.nav = `section:${id}`; item.title = meaning;
      if (id === section) item.setAttribute('aria-current', 'page');
      const dot = el('span', 'origin-dot'); dot.dataset.state = states[id] || 'empty'; dot.setAttribute('aria-hidden', 'true');
      item.append(dot, el('span', 'origin-nav-label', sectionName(id)), el('span', 'sr-only', `, ${meaning}`));
      const count = id === M.HOME ? 0 : sectionCount(id);
      if (count) item.append(el('span', 'origin-nav-count', String(count)));
      item.addEventListener('click', () => { openSection(id); app.closeSidebar(); });
      item.addEventListener('keydown', event => {
        const ids = order(), index = ids.indexOf(id);
        const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: ids.length - 1 }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        navigator.querySelector(`[data-section="${CSS.escape(ids[(next + ids.length) % ids.length])}"]`)?.focus();
      });
      return item;
    }
    function categoryBox(phase, index, all, states) {
      const box = el('div', `origin-phase phase-${phase.tone}`); box.dataset.phase = phase.id;
      const label = el('div', 'origin-phase-label');
      const builtin = M.PHASES.find(entry => entry.id === phase.id)?.label;
      const add = button('', () => addSection(phase.id), 'origin-icon origin-phase-add', `Add a section to ${phase.label}`);
      add.setAttribute('aria-label', `Add a section to ${phase.label}`); add.dataset.nav = `add:${phase.id}`; add.append(icon(ICON.plus, 13));
      const missing = M.SECTIONS.filter(entry => entry.id !== M.HOME && !M.hasPage(bp(), entry.id));
      const options = itemMenu(`Options for the category ${phase.label}`, `phase:${phase.id}`, [
        ['Rename', () => navigator.querySelector(`[data-edit="${CSS.escape(`phase:${phase.id}`)}"]`)?.click()],
        ['Add a section', () => addSection(phase.id)],
        ['Add sections from a blueprint…', () => openAddFromBlueprint(phase)],
        ...missing.map(entry => [`Add back: ${M.sectionLabel(entry.id)}`, () => addBuiltin(phase.id, entry.id)]),
        ['Move up', () => restructure(() => M.moveCategory(bp(), phase.id, index - 1)), { disabled: index === 0 }],
        ['Move down', () => restructure(() => M.moveCategory(bp(), phase.id, index + 1)), { disabled: index === all.length - 1 }],
        ['Duplicate', () => duplicateCategory(phase.id)],
        ['Delete category…', () => removeCategoryFlow(phase), { danger: true }],
      ]);
      const grip = dragHandle(`Drag to move the category ${phase.label}`);
      label.append(grip, el('span', 'origin-phase-number', phase.number),
        renamable(el('span', 'origin-phase-name', phase.label), { key: `phase:${phase.id}`, value: phase.label, fallback: builtin || 'Untitled category', label: `${phase.label} name`, max: 60,
          onSave: value => restructure(() => M.renameCategory(bp(), phase.id, value)) }), add, options);
      const list = el('ul');
      for (const id of phase.sections) {
        const entry = el('li', 'origin-nav-entry'); entry.dataset.page = id;
        entry.append(navItem(id, states), sectionMenu(id, phase));
        dragSource(entry, 'section', id);
        // A section dropped on a section takes its place, before or after it, in that category.
        dropTarget(entry, ['section'], (drag, after) => {
          const others = phase.sections.filter(page => page !== drag.id);
          restructure(() => M.movePage(bp(), drag.id, { phase: phase.id, index: others.indexOf(id) + (after ? 1 : 0) }));
        });
        list.append(entry);
      }
      if (!phase.sections.length) list.append(el('li', 'origin-nav-none', 'No sections yet'));
      box.append(label, list);
      dragSource(box, 'category', phase.id, { handle: grip });
      // A section dropped on a category goes to its end; a category dropped on another takes its place.
      dropTarget(box, ['section', 'category'], (drag, after) => {
        if (drag.kind === 'section') { restructure(() => M.movePage(bp(), drag.id, { phase: phase.id })); return; }
        const others = all.filter(item => item.id !== drag.id).map(item => item.id);
        restructure(() => M.moveCategory(bp(), drag.id, others.indexOf(phase.id) + (after ? 1 : 0)));
      }, { into: kind => kind === 'section' });
      return box;
    }
    function sectionMenu(id, phase) {
      const at = phase.sections.indexOf(id);
      return itemMenu(`Options for ${sectionName(id)}`, `section:${id}`, [
        ['Rename', () => { openSection(id); main.querySelector('[data-edit="title"]')?.click(); }],
        ['Move up', () => restructure(() => M.movePage(bp(), id, { index: at - 1 })), { disabled: at === 0 }],
        ['Move down', () => restructure(() => M.movePage(bp(), id, { index: at + 1 })), { disabled: at === phase.sections.length - 1 }],
        ['Move to category…', () => openMoveSection(id), { disabled: phases().length < 2 }],
        ...(isCustom(id) ? [['Duplicate', () => duplicateSection(id)]] : []),
        ['Delete section…', () => removeSectionFlow(id), { danger: true }],
      ]);
    }

    /** A small ⋯ menu. Items are [text, run, { disabled, danger }]; a choice, Escape or a click elsewhere closes it. */
    function itemMenu(label, key, items) {
      const box = el('details', 'origin-menu origin-item-menu');
      const summary = el('summary', 'origin-icon origin-small origin-menu-toggle'); summary.setAttribute('aria-label', label); summary.title = label; summary.dataset.nav = `menu:${key}`;
      summary.append(icon(ICON.dots, 14));
      const list = el('div', 'origin-menu-list');
      for (const [text, run, { disabled = false, danger = false } = {}] of items) {
        const item = button(text, () => {
          // The choice usually redraws this menu away: keyboard focus goes to its ⋯ button, or to Undo when the thing is gone.
          box.open = false; summary.focus(); run();
          if (document.activeElement === document.body) (document.querySelector(`[data-nav="${CSS.escape(summary.dataset.nav)}"]`) || undoBar.querySelector('.origin-undo-button'))?.focus({ preventScroll: true });
        }, `origin-menu-item${danger ? ' danger' : ''}`);
        item.disabled = disabled; list.append(item);
      }
      box.addEventListener('toggle', () => { if (box.open) for (const other of document.querySelectorAll('.origin-menu[open]')) if (other !== box) other.open = false; });
      box.append(summary, list);
      return box;
    }
    document.addEventListener('pointerdown', event => { for (const node of document.querySelectorAll('.origin-menu[open]')) if (!node.contains(event.target)) node.open = false; });
    window.addEventListener('keydown', event => {
      const node = event.key === 'Escape' && event.target.closest?.('.origin-menu[open]');
      if (!node) return;
      event.preventDefault(); event.stopImmediatePropagation(); node.open = false; node.querySelector('summary')?.focus();
    }, true);

    // ---- Drag and drop. The ⋯ menus move the same things by keyboard. ----
    const dragHandle = label => { const grip = el('span', 'origin-drag-handle'); grip.title = label; grip.setAttribute('aria-hidden', 'true'); grip.append(icon(ICON.handle, 14)); return grip; };
    const clearDropMarks = () => { for (const mark of document.querySelectorAll('.drop-before, .drop-after, .drop-into')) mark.classList.remove('drop-before', 'drop-after', 'drop-into'); };
    function dragSource(node, kind, id, { handle = node } = {}) {
      handle.draggable = true;
      handle.addEventListener('dragstart', event => {
        event.stopPropagation();
        dragging = { kind, id };
        event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', id);
        if (handle !== node) event.dataTransfer.setDragImage?.(node, 20, 16);
        requestAnimationFrame(() => node.classList.add('dragging'));
      });
      handle.addEventListener('dragend', () => { node.classList.remove('dragging'); clearDropMarks(); if (dragging) { dragging = null; renderDerived(); } });
    }
    function dropTarget(node, kinds, onDrop, { into = () => false } = {}) {
      const place = event => { const box = node.getBoundingClientRect(); return event.clientY > box.top + box.height / 2; };
      node.addEventListener('dragover', event => {
        if (!dragging || !kinds.includes(dragging.kind) || dragging.id === node.dataset.page || dragging.id === node.dataset.phase && dragging.kind === 'category') return;
        event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
        clearDropMarks(); node.classList.add(into(dragging.kind) ? 'drop-into' : place(event) ? 'drop-after' : 'drop-before');
      });
      node.addEventListener('dragleave', event => { if (!node.contains(event.relatedTarget)) node.classList.remove('drop-before', 'drop-after', 'drop-into'); });
      node.addEventListener('drop', event => {
        if (!dragging || !kinds.includes(dragging.kind)) return;
        event.preventDefault(); event.stopPropagation();
        const drag = dragging; dragging = null; clearDropMarks();
        if (drag.id !== node.dataset.page && drag.id !== node.dataset.block && drag.id !== node.dataset.question) onDrop(drag, place(event));
        else renderDerived();
      });
    }

    // ---- Changing the structure: one path, drawn everywhere at once (sidebar, page, map, Research) ----
    /** Runs one structure change. `undo` names a removal that can be taken back right after. */
    function restructure(run, { undo: label = '', announce = '' } = {}) {
      if (!record?.exists) return null;
      const before = label ? JSON.stringify(bp()) : '', from = section;
      const result = run();
      if (!result || result.error) { if (result?.error) { showNotice(result.error); app.announce(result.error); } return result; }
      if (label) {
        record.blueprint = M.normalizeBlueprint(bp()).blueprint; // Links to what was removed go too.
        if (open && !bp()[open.collection]?.some(item => item.id === open.id)) { open = null; renderDrawer(); }
      }
      views.map = null;
      changed({ structure: true });
      if (label) showUndo(label, before, from);
      researchPanel.structureChanged();
      if (announce || label) app.announce(announce || label);
      return result;
    }
    function showUndo(label, snapshot, from) {
      undo = { snapshot, section: from };
      const dismiss = button('', () => hideUndo(), 'origin-icon origin-small', 'Dismiss'); dismiss.setAttribute('aria-label', 'Dismiss'); dismiss.append(icon(ICON.close, 13));
      undoBar.replaceChildren(el('span', '', label), button('Undo', () => takeBack(), 'origin-link origin-undo-button'), dismiss);
      undoBar.hidden = false;
    }
    function hideUndo() { undo = null; undoBar.hidden = true; undoBar.replaceChildren(); }
    function takeBack() {
      if (!undo || !record?.exists) return;
      const { snapshot, section: from } = undo;
      hideUndo();
      record.blueprint = JSON.parse(snapshot); section = from; setPref(SECTION_KEY, from); views.map = null;
      changed({ structure: true }); researchPanel.structureChanged();
      app.announce('Undone. Everything is back as it was.');
      main.querySelector('h2')?.focus({ preventScroll: true });
    }
    /** What a removal takes with it, in words. */
    function contentWords(content) {
      const parts = [];
      if (content.records) parts.push(plural(content.records, 'entry', 'entries'));
      if (content.questions) parts.push(`${plural(content.questions, 'question')}${content.answers ? ` (${content.answers} answered)` : ''}`);
      if (content.blocks) parts.push(plural(content.blocks, 'block'));
      if (content.description) parts.push('a description');
      return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] || 'nothing';
    }
    const total = list => list.reduce((sum, content) => ({ records: sum.records + content.records, questions: sum.questions + content.questions, answers: sum.answers + content.answers,
      blocks: sum.blocks + content.blocks, description: sum.description || content.description, total: sum.total + content.total }), { records: 0, questions: 0, answers: 0, blocks: 0, description: false, total: 0 });
    /** A removal with content asks first and names what goes with it; an empty one happens at once. Both can be undone. */
    function confirmRemoval(title, lead, submit, run) {
      modal('origin-remove-dialog', { title, lead, body: [dialogForm('origin-remove-dialog', [], submit, async () => { run(); }, { danger: true })] });
      document.querySelector('#origin-remove-dialog-submit')?.focus();
    }
    function removeSectionFlow(id) {
      const content = M.pageContent(bp(), id), name = sectionName(id);
      const run = () => restructure(() => M.removePage(bp(), id), { undo: `Section “${name}” deleted.` });
      if (!content.total) { run(); return; }
      confirmRemoval(`Delete the section “${name}”?`, `It holds ${contentWords(content)}, deleted with it.${isCustom(id) ? '' : ' Its category’s menu can add it back, empty.'} You can undo this right after.`, 'Delete section', run);
    }
    function removeCategoryFlow(phase) {
      const content = total(phase.sections.map(id => M.pageContent(bp(), id)));
      const run = () => restructure(() => M.removeCategory(bp(), phase.id), { undo: `Category “${phase.label}” deleted.` });
      if (!phase.sections.length) { run(); return; }
      const names = phase.sections.map(sectionName).join(', ');
      confirmRemoval(`Delete the category “${phase.label}”?`, `Its ${plural(phase.sections.length, 'section')} (${names}) ${phase.sections.length === 1 ? 'is' : 'are'} deleted with it${content.total ? `, holding ${contentWords(content)}` : ''}. You can undo this right after.`, 'Delete category', run);
    }
    function addCategoryHere() {
      const id = newId();
      if (!restructure(() => M.addCategory(bp(), { id, title: 'New category' }))?.ok) return;
      navigator.querySelector(`[data-edit="${CSS.escape(`phase:${id}`)}"]`)?.click();
    }
    function duplicateCategory(id) {
      const result = restructure(() => M.duplicateCategory(bp(), id, newId));
      if (result?.ok) app.announce(`Category copied${result.copied ? ` with ${plural(result.copied, 'section')} of its own` : ''}.${result.skipped ? ` ${plural(result.skipped, 'built-in section')} exist${result.skipped === 1 ? 's' : ''} once and stayed.` : ''}`);
    }
    function addBuiltin(phaseId, pageId) {
      if (restructure(() => M.addPage(bp(), { phase: phaseId, kind: pageId }), { announce: `${M.sectionLabel(pageId)} added back, empty.` })?.ok) openSection(pageId);
    }
    function duplicateSection(id) {
      const result = restructure(() => M.duplicatePage(bp(), id, newId), { announce: 'Section copied with its questions, answers and blocks.' });
      if (result?.ok) openSection(result.id);
    }
    function openMoveSection(id) {
      const pick = el('select'); pick.id = 'origin-move-category';
      for (const phase of phases()) pick.append(Object.assign(el('option', '', phase.label), { value: phase.id }));
      pick.value = phaseOf(id)?.id || '';
      modal('origin-move-dialog', { title: `Move “${sectionName(id)}”`, lead: 'It moves with everything in it, to the end of the category.',
        body: [dialogForm('origin-move-dialog', [field('Category', pick)], 'Move', async () => { const result = restructure(() => M.movePage(bp(), id, { phase: pick.value })); if (result?.error) throw new Error(result.error); })] });
      pick.focus();
    }
    /** Moves one of a section's own questions or blocks to another section, with its answer or content. */
    function openMoveTo(kind, id, from) {
      const pick = el('select'); pick.id = 'origin-move-section';
      for (const phase of phases()) {
        const group = el('optgroup'); group.label = phase.label;
        for (const page of phase.sections) if (page !== from) group.append(Object.assign(el('option', '', sectionName(page)), { value: page }));
        if (group.children.length) pick.append(group);
      }
      if (!pick.options.length) { showNotice('There is no other section to move it to. Add one first.'); return; }
      modal('origin-move-dialog', { title: kind === 'question' ? 'Move the question' : 'Move the block', lead: `It moves with its ${kind === 'question' ? 'answer' : 'content'}, to the end of the section.`,
        body: [dialogForm('origin-move-dialog', [field('Section', pick)], 'Move', async () => {
          const to = pick.value, result = restructure(() => (kind === 'question' ? M.moveQuestion(bp(), id, { section: to }) : M.moveBlockTo(bp(), id, to)), { announce: `Moved to ${sectionName(to)}.` });
          if (result?.error) throw new Error(result.error);
        })] });
      pick.focus();
    }
    /** A list's entry dropped before or after another of the same section: questions among questions, blocks among blocks. */
    function place(list, dragId, targetId, after, sectionKey = 'sectionId') {
      const moved = list.find(entry => entry.id === dragId), target = list.find(entry => entry.id === targetId);
      if (!moved || !target || moved === target) return null;
      list.splice(list.indexOf(moved), 1); list.splice(list.indexOf(target) + (after ? 1 : 0), 0, moved);
      moved[sectionKey] = target[sectionKey];
      return { ok: true };
    }
    // One clear next step per section, taken from the deterministic checks.
    function nextStep(found) {
      if (section === 'overview') return [];
      const list = found.filter(issue => issue.target?.section === section && issue.origin === 'system');
      const next = list.find(issue => issue.blocking) || list[0];
      if (!next) return [];
      const bar = el('div', `origin-next${next.blocking ? '' : ' advisory'}`);
      bar.append(el('span', 'origin-next-label', next.blocking ? 'Next' : 'Tip'), el('span', 'origin-next-text', next.title));
      if (list.length > 1) bar.append(button(`+${list.length - 1} more`, () => openSection('overview'), 'origin-link origin-next-more', 'See every open point on the Overview'));
      if (next.target?.id) { const fix = button('Open', () => focusTarget(next.target), 'origin-link origin-next-open'); fix.append(icon(ICON.arrow, 14)); bar.append(fix); }
      return [bar];
    }

    function openSection(id) {
      if (!order().includes(id)) return;
      section = id; setPref(SECTION_KEY, id); connectFrom = null; mapLinkFrom = null; selectedLink = null; flowConnect = null; flowStep = null;
      if (open && sectionOf(open) !== id) { open = null; renderDrawer(); }
      renderMain();
      window.scrollTo(0, 0);
      main.querySelector('h2')?.focus({ preventScroll: true });
    }
    function sectionOf(target) {
      if (target.collection === 'areas') return bp().areas.find(item => item.id === target.id)?.section;
      if (target.collection === 'blocks') return bp().blocks.find(item => item.id === target.id)?.sectionId;
      return { requirements: 'requirements', components: 'architecture', connections: 'architecture', technologies: 'technology', dependencies: 'dependencies', decisions: 'decisions',
        assumptions: 'research', sources: 'research', risks: 'research', milestones: 'plan', items: 'plan', layers: 'architecture' }[target.collection];
    }
    function focusTarget(target) {
      if (!target) return;
      if (target.collection === 'connections') { const connection = bp().connections.find(item => item.id === target.id); target = connection ? { collection: 'components', id: connection.from } : { section: 'architecture' }; }
      const id = target.collection ? sectionOf(target) || target.section : target.section;
      if (id && id !== section) { section = id; setPref(SECTION_KEY, id); renderMain(); window.scrollTo(0, 0); }
      // A block lives on its section page, not in the editor panel.
      if (target.collection === 'blocks') { const card = main.querySelector(`[data-block="${CSS.escape(target.id)}"]`); card?.scrollIntoView?.({ block: 'start' }); card?.querySelector('.origin-block-title')?.focus({ preventScroll: true }); return; }
      if (target.collection && target.id) openDrawer(target.collection, target.id);
      else main.querySelector('h2')?.focus();
    }

    function renderMain() {
      if (renderFrame) { cancelAnimationFrame(renderFrame); renderFrame = 0; }
      if (record?.exists && !order().includes(section)) section = 'overview';
      main.className = `origin-main phase-${toneOf(section)}${['overview', 'architecture'].includes(section) ? ' origin-wide' : ''}`;
      view.dataset.section = section;
      if (!projectId) { main.className = 'origin-main phase-define'; main.replaceChildren(startState()); renderDerived(); return; }
      if (loadError && !record) { main.replaceChildren(errorState()); renderDerived(); return; }
      if (!record) return;
      const y = window.scrollY;
      const body = isCustom(section) ? customSection(section) : [...(SECTIONS[section] || SECTIONS.overview)(), ...(section === 'overview' ? [] : [...questionsBlock(section), ...blocksBlock(section)])];
      main.replaceChildren(sectionHeader(), el('div', 'origin-next-slot'), ...body);
      renderDerived();
      markSelected();
      if (Math.abs(window.scrollY - y) > 1) window.scrollTo(0, y);
      if (focusAfter) { const target = focusAfter(); focusAfter = null; target?.focus({ preventScroll: true }); target?.scrollIntoView?.({ block: 'nearest' }); }
    }
    // The heading and guiding question are the project's own words; the pencil rewords them in place.
    function sectionHeader() {
      const phase = phaseOf(section), custom = bp().customSections.find(entry => entry.id === section);
      const head = el('div', 'origin-section-head');
      const text = el('div', 'origin-section-text');
      const heading = el('h2', '', sectionName(section)); heading.id = 'origin-section-heading'; heading.tabIndex = -1;
      const builtin = M.sectionLabel(section);
      const rename = section === 'overview' ? heading : renamable(heading, { key: 'title', value: sectionName(section), fallback: custom ? 'New section' : builtin, label: 'section name', max: custom ? 80 : 60,
        onSave: value => restructure(() => M.renamePage(bp(), section, value)) });
      text.append(el('p', 'origin-eyebrow', phase ? `${phase.number} · ${phase.label}` : 'Home'), rename);
      if (custom && bp().questionText[`section:${section}`]) {
        // A section from a blueprint keeps the template's explanation as its guiding text; clearing it removes it.
        const key = `section:${section}`, wording = bp().questionText[key];
        text.append(renamable(el('p', 'origin-question', wording), { key, value: wording, fallback: '', label: 'guiding text', max: 500, onSave: value => setQuestion(key, value) }));
      }
      if (!custom) {
        const key = `section:${section}`, wording = M.questionText(bp(), key, QUESTION[section]);
        text.append(section === 'overview' ? el('p', 'origin-question', wording) : renamable(el('p', 'origin-question', wording), { key, value: wording, fallback: QUESTION[section], label: 'guiding question', max: 500,
          onSave: value => setQuestion(key, value) }));
      }
      head.append(text);
      const optional = custom || M.SECTIONS.find(item => item.id === section).optional;
      if (optional) {
        const toggle = el('label', 'origin-switch'); const box = el('input'); box.type = 'checkbox'; box.setAttribute('role', 'switch');
        box.checked = Boolean(custom ? custom.notApplicable : bp().sections[section]?.notApplicable);
        box.addEventListener('change', () => {
          if (custom) custom.notApplicable = box.checked;
          else if (box.checked) bp().sections[section] = { notApplicable: true }; else delete bp().sections[section];
          changed({ structure: true });
        });
        toggle.append(box, el('span', 'origin-switch-track'), el('span', '', 'Not needed for this project'));
        head.append(toggle);
      }
      return head;
    }
    function setQuestion(key, value, redraw = false) {
      if (value) bp().questionText[key] = value; else delete bp().questionText[key];
      changed({ structure: true, drawer: redraw });
    }
    // Inline rewording: the pencil swaps the text for a field. Enter or leaving it saves, Escape cancels,
    // and an empty field brings back the built-in wording. Saved answers stay with their question.
    function renamable(node, { key, value, fallback, label, max, onSave }) {
      const row = el('span', 'origin-editable');
      const edit = button('', () => {
        const control = el('input', `origin-inline-input${node.tagName === 'H2' ? ' heading' : ''}`); control.maxLength = max; control.value = value; control.placeholder = fallback; control.setAttribute('aria-label', label);
        let done = false;
        const finish = (keep, refocus) => {
          if (done) return;
          done = true;
          const next = control.value.trim().replace(/\s+/g, ' ');
          control.replaceWith(node); edit.hidden = false;
          if (keep && next !== value) onSave(next === fallback ? '' : next);
          if (refocus) document.querySelector(`[data-edit="${CSS.escape(key)}"]`)?.focus({ preventScroll: true }); // Phase names live in the sidebar, outside the view.
        };
        control.addEventListener('keydown', event => {
          if (event.key === 'Enter') { event.preventDefault(); finish(true, true); }
          else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false, true); }
        });
        control.addEventListener('blur', () => finish(true, false));
        node.replaceWith(control); edit.hidden = true;
        control.focus(); control.select();
      }, 'origin-icon origin-edit', `Edit ${label}`);
      edit.dataset.edit = key; edit.setAttribute('aria-label', `Edit ${label}`); edit.append(icon(ICON.edit, 13));
      row.append(node, edit);
      return row;
    }
    function markSelected() {
      for (const node of main.querySelectorAll('[data-id]')) node.classList.toggle('selected', node.dataset.id === open?.id);
    }

    // ---- Start: every project begins here ----
    function flowStrip() {
      const strip = el('ol', 'origin-flow'); strip.setAttribute('aria-label', 'How Origin works');
      for (const phase of phases()) { const step = el('li', `phase-${phase.tone}`); step.append(el('span', 'origin-flow-dot'), phase.label); strip.append(step); }
      return strip;
    }
    // The only start screen: Origin has no projects yet. Later projects come from New project.
    function startState() {
      const box = el('div', 'origin-hero');
      box.append(el('p', 'origin-eyebrow', 'Origin · New project'), el('h2', '', 'What do you want to build?'),
        el('p', 'origin-hero-lead', 'Describe it in a few sentences. Origin turns it into a clear project map — goals, building blocks, decisions and tasks — before any agent starts.'));
      const form = el('form', 'origin-hero-form');
      const name = el('input'); name.id = 'origin-first-project'; name.maxLength = 80; name.autocomplete = 'off'; name.placeholder = 'Project name'; name.setAttribute('aria-label', 'Project name');
      const idea = el('textarea', 'origin-idea'); idea.id = 'origin-idea'; idea.rows = 4; idea.maxLength = 20000; idea.placeholder = 'A web app that helps small teams…';
      idea.setAttribute('aria-label', 'What do you want to build?');
      const kanban = kanbanOption('origin-first-kanban'), begin = blueprintPicker('origin-first-start', { others: [] });
      const error = el('p', 'origin-inline-error'); error.hidden = true; error.setAttribute('role', 'alert');
      const start = el('button', 'origin-primary', 'Start blueprint'); start.type = 'submit'; start.id = 'origin-start'; start.append(icon(ICON.arrow, 16));
      const actions = el('div', 'origin-hero-actions'); actions.append(start, el('span', 'origin-hint', '⌘/Ctrl + Enter'));
      form.append(name, idea, begin.box, kanban.box, actions, error);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        error.hidden = true;
        if (!name.value.trim()) { error.textContent = 'Give the project a name first.'; error.hidden = false; name.focus(); return; }
        start.disabled = true;
        try { await createProject(name.value, idea.value, kanban.input.checked, begin.value(), begin.preferences()); }
        catch (failure) { error.textContent = failure.message; error.hidden = false; }
        finally { start.disabled = false; }
      });
      idea.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); form.requestSubmit(); } });
      box.append(form, flowStrip());
      return box;
    }
    function errorState() {
      const box = el('div', 'origin-hero');
      box.append(el('h2', '', 'This blueprint is unavailable'), el('p', 'origin-hero-lead', loadError), button('Try again', () => void load(projectId, { force: true }), 'origin-primary'));
      return box;
    }
    /** The one integration choice when creating: on by default, as before. */
    function kanbanOption(id) {
      const box = el('label', 'origin-check-row'); const input = el('input'); input.type = 'checkbox'; input.id = id; input.checked = true;
      const text = el('span'); text.append(el('strong', '', 'Also create a Kanban project and Git repository'), el('small', 'origin-hint', 'Turn off to plan in Origin only. You can connect Kanban later.'));
      box.append(input, text);
      return { box, input };
    }
    // ---- The blueprint library: how a new project starts ----
    const TEMPLATES = globalThis.PromptboardOriginTemplates;
    /** What a choice gives a project, as categories → sections → questions, for the preview. */
    function previewOf(choice, saved) {
      if (choice.kind === 'blank') return { name: 'Start blank', description: 'Only the Overview. Add your own categories and sections, or add sections from a blueprint later.', categories: [] };
      if (choice.kind === 'default') {
        const blueprint = M.emptyBlueprint();
        return { name: 'General software project', description: 'A technology-independent plan for any project: Define, Design, Operate, Decide and Build with their sections.',
          categories: M.phaseList(blueprint).map(phase => ({ title: phase.label, sections: phase.sections.map(id => ({ title: M.sectionLabel(id), questions: [] })) })) };
      }
      if (choice.kind === 'saved') { const entry = saved.find(item => item.id === choice.id); return entry && { name: entry.name, description: entry.description || 'Your saved blueprint.', categories: entry.categories.map(category => ({ title: category.title, sections: category.sections.map(title => ({ title, questions: [] })) })) }; }
      if (choice.kind === 'from') return { name: 'Another project’s structure', description: 'Its categories, sections, questions and empty blocks. None of its answers or entries.', categories: [] };
      const template = TEMPLATES.get(choice.id);
      return { name: template.name, description: template.description, research: template.research,
        categories: template.categories.map(category => ({ title: category.title, sections: category.sections.map(ref => {
          const module = typeof ref === 'string' ? TEMPLATES.MODULES[ref] : null, own = module ? (module.section ? null : module) : ref;
          return { title: (own || module).title, questions: [...(own || module).questions || [], ...(own ? [] : template.questions?.[module.section] || [])], blocks: [...(own || module).blocks || [], ...(own ? [] : template.blocks?.[module.section] || [])].map(block => block.title) };
        }) })) };
    }
    /**
     * Start with: Blank, the general structure, one of the library's blueprints, a blueprint you saved, or another
     * project's structure. Cards are searchable and filtered by category; the preview shows what the project gets.
     */
    function blueprintPicker(id, { others = projects } = {}) {
      const box = el('div', 'origin-blueprints'); box.id = id;
      let choice = { kind: 'default' }, category = '', saved = [];
      const search = el('input', 'origin-blueprint-search'); search.type = 'search'; search.id = `${id}-search`; search.placeholder = 'Search blueprints'; search.setAttribute('aria-label', 'Search blueprints');
      const chips = el('div', 'origin-blueprint-chips'); chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', 'Blueprint categories');
      const cards = el('div', 'origin-blueprint-cards'); cards.setAttribute('role', 'radiogroup'); cards.setAttribute('aria-label', 'Blueprints');
      const preview = el('div', 'origin-blueprint-preview'); preview.setAttribute('aria-live', 'polite');
      const from = el('select'); from.id = `${id}-from`; from.setAttribute('aria-label', 'Project to copy the structure from');
      from.append(...others.map(item => Object.assign(el('option', '', item.name), { value: item.id })));
      const preferences = el('textarea'); preferences.id = `${id}-preferences`; preferences.rows = 2; preferences.maxLength = 2000; preferences.placeholder = 'Technology preferences (optional), for example “TypeScript, PostgreSQL, deploy on our Kubernetes”';
      preferences.setAttribute('aria-label', 'Technology preferences (optional)');
      const options = () => [
        { kind: 'blank', name: 'Start blank', summary: 'Only the Overview: build your own structure.', category: 'start' },
        { kind: 'default', name: 'General software project', summary: 'Define, Design, Operate, Decide and Build: works for any project.', category: 'start' },
        ...TEMPLATES.TEMPLATES.map(template => ({ kind: 'template', id: template.id, name: template.name, summary: template.summary, category: template.category, sections: TEMPLATES.templateSections(template).length,
          words: [template.description, ...TEMPLATES.templateSections(template).map(entry => entry.title)].join(' ') })),
        ...saved.map(entry => ({ kind: 'saved', id: entry.id, name: entry.name, summary: entry.description || 'Your saved blueprint.', category: 'saved' })),
        ...(others.length ? [{ kind: 'from', name: 'Another project’s structure', summary: 'Copy the categories and questions of a project you have.', category: 'start' }] : []),
      ];
      const same = (a, b) => a.kind === b.kind && (a.id || '') === (b.id || '');
      const renderChips = () => {
        const list = [['', 'All'], ...TEMPLATES.CATEGORIES, ...(saved.length ? [['saved', 'Saved']] : [])];
        chips.replaceChildren(...list.map(([value, label]) => { const chip = button(label, () => { category = value; renderChips(); renderCards(); }, 'origin-blueprint-chip'); chip.setAttribute('aria-pressed', String(category === value)); chip.dataset.category = value; return chip; }));
      };
      const renderCards = () => {
        const query = search.value.trim().toLowerCase();
        const shown = options().filter(option => (!category || option.category === category) && (!query || `${option.name} ${option.summary} ${option.words || ''}`.toLowerCase().includes(query)));
        cards.replaceChildren(...shown.map(option => {
          const card = el('button', 'origin-blueprint-card'); card.type = 'button'; card.setAttribute('role', 'radio'); card.setAttribute('aria-checked', String(same(option, choice)));
          card.dataset.kind = option.kind; if (option.id) card.dataset.id = option.id;
          card.append(el('strong', '', option.name), el('span', '', option.summary), ...(option.sections ? [el('small', '', plural(option.sections, 'section'))] : []));
          card.addEventListener('click', () => { choice = { kind: option.kind, ...(option.id ? { id: option.id } : {}) }; renderCards(); renderPreview(); });
          return card;
        }));
        if (!shown.length) cards.append(el('p', 'origin-empty-note', 'No blueprint matches. Try another word or category.'));
      };
      const renderPreview = () => {
        const shown = previewOf(choice, saved);
        if (!shown) { preview.replaceChildren(); return; }
        const tree = el('ol', 'origin-blueprint-tree');
        for (const group of shown.categories) {
          const item = el('li'); item.append(el('strong', '', group.title));
          const sections = el('ul');
          for (const section of group.sections) {
            const row = el('li');
            if (section.questions?.length || section.blocks?.length) {
              const more = el('details'); more.append(el('summary', '', section.title));
              const inner = el('ul', 'origin-blueprint-questions'); inner.append(...section.questions.map(text => el('li', '', text)), ...(section.blocks || []).map(text => el('li', 'block', text)));
              more.append(inner); row.append(more);
            } else row.textContent = section.title;
            sections.append(row);
          }
          item.append(sections); tree.append(item);
        }
        preview.replaceChildren(el('h3', '', shown.name), el('p', '', shown.description), ...(choice.kind === 'from' ? [from] : []), ...(shown.categories.length ? [tree] : []),
          ...(shown.research?.length ? [el('p', 'origin-hint', `Research starts with: ${shown.research.slice(0, 3).join('; ')}…`)] : []),
          el('p', 'origin-hint', 'Every category, section and question stays yours to rename, move or delete.'));
      };
      search.addEventListener('input', renderCards);
      const layout = el('div', 'origin-blueprint-layout'); layout.append(cards, preview);
      box.append(el('span', 'origin-field-label', 'Start with'), search, chips, layout, preferences);
      renderChips(); renderCards(); renderPreview();
      // Saved blueprints come from the app; the library is ready at once. Saved blueprints that cannot be read (a damaged
      // file is reported once, then set aside) are named above the search.
      void app.api('/api/origin/blueprints', { timeoutMs: 15000 }).catch(() => ({ response: { ok: false }, data: {} })).then(({ response, data }) => {
        if (!response.ok) { const note = el('p', 'origin-inline-error', typeof data.error === 'string' ? data.error : 'Your saved blueprints could not be read. The library is still here.'); note.setAttribute('role', 'alert'); search.before(note); return; }
        if (Array.isArray(data.blueprints) && data.blueprints.length) { saved = data.blueprints; renderChips(); renderCards(); }
      });
      const value = () => (choice.kind === 'template' ? { template: choice.id } : choice.kind === 'saved' ? { saved: choice.id } : choice.kind === 'from' ? { from: from.value } : choice.kind);
      return { box, value, preferences: () => preferences.value.trim() };
    }
    async function createProject(name, description, createKanban, start = 'default', preferences = '') {
      const { response, data } = await app.api('/api/origin/projects', { method: 'POST', body: { name: name.trim(), description: description.trim(), createKanban, start, ...(preferences ? { preferences } : {}) }, timeoutMs: 120000 })
        .catch(() => ({ response: { ok: false }, data: {} }));
      if (!response.ok || !data.project) throw new Error(typeof data.error === 'string' ? data.error : 'The project could not be created. Nothing was changed.');
      projects = [...projects.filter(item => item.id !== data.project.id), data.project];
      if (createKanban) await app.ensureBoard({ ifChanged: true });
      setPref(PROJECT_KEY, data.project.id);
      section = 'overview'; setPref(SECTION_KEY, section);
      await load(data.project.id);
      if (data.kanbanError) showNotice(`“${data.project.name}” was created in Origin, but the Kanban project was not: ${data.kanbanError.message} Use Connect to Kanban to try again or to choose an existing project.`);
      app.announce(`${data.project.name} created${data.project.kanban?.exists ? ' in Origin and on Kanban' : ' in Origin'}.`);
    }
    const dialogs = {};
    /** One lazily made dialog per id. While `busy()` is true, neither Escape nor the close button closes it. */
    function modal(id, { eyebrow = 'Origin', title, lead = '', body = [], busy = () => false }) {
      dialogs[id] ??= (() => { const dialog = el('dialog', 'origin-modal'); dialog.id = id; dialog.setAttribute('aria-labelledby', `${id}-heading`); document.body.append(dialog); return dialog; })();
      const dialog = dialogs[id];
      dialog.oncancel = event => { if (busy()) event.preventDefault(); };
      const heading = el('h2', '', title); heading.id = `${id}-heading`;
      const close = button('', () => { if (!busy()) dialog.close(); }, 'origin-icon origin-modal-close'); close.setAttribute('aria-label', 'Close'); close.append(icon(ICON.close));
      dialog.replaceChildren(close, el('p', 'origin-eyebrow', eyebrow), heading, ...(lead ? [el('p', 'origin-modal-lead', lead)] : []), ...body);
      dialog.showModal();
      return dialog;
    }
    /** A form inside a dialog: one submit, one inline error, never a second confirmation. */
    function dialogForm(dialogId, fields, submitText, run, { danger = false } = {}) {
      const form = el('form', 'origin-modal-form');
      const error = el('p', 'origin-inline-error'); error.hidden = true; error.setAttribute('role', 'alert');
      const submit = el('button', danger ? 'origin-primary danger' : 'origin-primary', submitText); submit.type = 'submit'; submit.id = `${dialogId}-submit`;
      const actions = el('div', 'origin-modal-actions'); actions.append(button('Cancel', () => dialogs[dialogId]?.close(), 'origin-ghost'), submit);
      form.append(...fields, error, actions);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        submit.disabled = true; error.hidden = true;
        try { if (await run() !== false) dialogs[dialogId]?.close(); }
        catch (failure) { error.textContent = failure.message; error.hidden = false; }
        finally { submit.disabled = false; }
      });
      return form;
    }
    async function call(path, body, failure) {
      const { response, data } = await app.api(path, { method: 'POST', body, timeoutMs: 120000 }).catch(() => ({ response: { ok: false }, data: {} }));
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : failure);
      return data;
    }
    function openNewProject() {
      const name = el('input'); name.id = 'origin-new-name'; name.maxLength = 80; name.autocomplete = 'off'; name.placeholder = 'Project name';
      const idea = el('textarea'); idea.id = 'origin-new-idea'; idea.rows = 2; idea.maxLength = 20000; idea.placeholder = 'What do you want to build? (optional)';
      const kanban = kanbanOption('origin-new-kanban'), begin = blueprintPicker('origin-new-start');
      modal('origin-new-dialog', { title: 'New project', lead: 'Name it and describe the idea. You shape the design step by step; no agent starts.',
        body: [dialogForm('origin-new-dialog', [field('Name', name), field('Description', idea), begin.box, kanban.box], 'Create project', async () => {
          if (!name.value.trim()) { name.focus(); throw new Error('Give the project a name.'); }
          const problem = await unsaved(); if (problem) throw new Error(problem);
          await createProject(name.value, idea.value, kanban.input.checked, begin.value(), begin.preferences());
        })] }).classList.add('wide');
      name.focus();
    }
    /** The project's structure, questions and empty blocks as a blueprint for new projects. Nothing written is copied. */
    function openSaveBlueprint() {
      const current = project(); if (!current || !record?.exists) return;
      const name = el('input'); name.id = 'origin-save-blueprint-name'; name.maxLength = 80; name.value = `${current.name} blueprint`;
      const about = el('textarea'); about.id = 'origin-save-blueprint-description'; about.rows = 2; about.maxLength = 500; about.placeholder = 'What kind of project is it for? (optional)';
      modal('origin-save-blueprint-dialog', { title: 'Save structure as blueprint', lead: 'New projects can start from it. It keeps the categories, sections, questions and empty blocks — none of the answers or entries — and later changes to this project do not change it.',
        body: [dialogForm('origin-save-blueprint-dialog', [field('Name', name), field('Description', about)], 'Save blueprint', async () => {
          if (!(await flush())) throw new Error('This blueprint has unsaved changes. Save or reload it first.');
          const data = await call(`/api/origin/projects/${encodeURIComponent(current.id)}/save-blueprint`, { name: name.value, description: about.value }, 'The blueprint could not be saved.');
          app.announce(`Saved the blueprint “${data.blueprint.name}”. Choose it under Saved when you create a project.`);
        })] });
      name.select();
    }
    /** Sections of a library blueprint added to a category; sections the project already has are skipped, never replaced. */
    function openAddFromBlueprint(phase) {
      const pick = el('select'); pick.id = 'origin-add-blueprint';
      for (const [value, label] of TEMPLATES.CATEGORIES) {
        const group = el('optgroup'); group.label = label;
        group.append(...TEMPLATES.TEMPLATES.filter(template => template.category === value).map(template => Object.assign(el('option', '', template.name), { value: template.id })));
        pick.append(group);
      }
      if (bp().template && TEMPLATES.get(bp().template.id)) pick.value = bp().template.id;
      const list = el('div', 'origin-add-blueprint-sections'); list.setAttribute('role', 'group'); list.setAttribute('aria-label', 'Sections to add');
      const render = () => {
        const template = TEMPLATES.get(pick.value);
        list.replaceChildren(...TEMPLATES.templateSections(template).map(entry => {
          const present = entry.own ? bp().customSections.some(item => item.title.trim().toLowerCase() === entry.title.trim().toLowerCase()) : M.hasPage(bp(), entry.key);
          const label = el('label', 'origin-check-row'); const box = el('input'); box.type = 'checkbox'; box.value = entry.key; box.disabled = present;
          const words = el('span'); words.append(el('strong', '', entry.title), el('small', 'origin-hint', present ? 'Already in the project' : entry.category));
          label.append(box, words); return label;
        }));
      };
      pick.addEventListener('change', render); render();
      modal('origin-add-blueprint-dialog', { title: `Add sections to “${phase.label}”`, lead: 'Choose a blueprint and the sections you want. They arrive with their questions and starter blocks; nothing already in the project is replaced.',
        body: [dialogForm('origin-add-blueprint-dialog', [field('Blueprint', pick), list], 'Add sections', async () => {
          const keys = [...list.querySelectorAll('input:checked')].map(input => input.value);
          if (!keys.length) throw new Error('Choose at least one section.');
          const result = restructure(() => M.addTemplateSections(bp(), TEMPLATES.get(pick.value), keys, phase.id, { modules: TEMPLATES.MODULES, newId }));
          if (result?.error) throw new Error(result.error);
          app.announce(`${plural(result.added.length, 'section')} added${result.skipped.length ? `; ${plural(result.skipped.length, 'section')} already there` : ''}.`);
        })] }).classList.add('wide');
      pick.focus();
    }
    function openRename() {
      const current = project(); if (!current) return;
      const name = el('input'); name.id = 'origin-rename-name'; name.maxLength = 80; name.value = current.name;
      modal('origin-rename-dialog', { title: 'Rename project', body: [dialogForm('origin-rename-dialog', [field('Name', name)], 'Rename', async () => {
        if (!(await flush())) throw new Error('This blueprint has unsaved changes. Save or reload it first.');
        const { response, data } = await app.api(`/api/origin/projects/${encodeURIComponent(current.id)}`, { method: 'PATCH', body: { expectedRevision: revisionOf(current), name: name.value }, timeoutMs: 30000 })
          .catch(() => ({ response: { ok: false }, data: {} }));
        if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'The project could not be renamed.');
        saveRevision(data.revision, data.project);
        render(); app.announce(`Renamed to ${data.project.name}.`);
      })] });
      name.select();
    }
    /** Connect to an existing Kanban project or a new one. The destination is shown before anything links. */
    function openConnect({ then } = {}) {
      const current = project(); if (!current) return;
      const taken = new Set(projects.filter(item => item.id !== current.id && item.kanbanProjectId).map(item => item.kanbanProjectId));
      const choices = app.projects().filter(item => !taken.has(item.id));
      const mode = (value, text, checked) => { const label = el('label', 'origin-radio'); const radio = el('input'); radio.type = 'radio'; radio.name = 'origin-connect-mode'; radio.value = value; radio.checked = checked; label.append(radio, el('span', '', text)); return { label, radio }; };
      const existing = mode('existing', 'An existing Kanban project', choices.length > 0), fresh = mode('new', 'A new Kanban project with its own Git repository', !choices.length);
      existing.radio.disabled = !choices.length;
      const pick = el('select'); pick.id = 'origin-connect-project'; pick.setAttribute('aria-label', 'Kanban project');
      pick.append(...choices.map(item => Object.assign(el('option', '', item.name), { value: item.id })));
      if (current.kanban?.exists) pick.value = current.kanbanProjectId;
      const name = el('input'); name.id = 'origin-connect-name'; name.maxLength = 80; name.value = current.name; name.setAttribute('aria-label', 'New Kanban project name');
      const destination = el('p', 'origin-callout');
      const sync = () => {
        pick.disabled = !existing.radio.checked; name.disabled = !fresh.radio.checked;
        destination.textContent = existing.radio.checked ? `Tasks from “${current.name}” will go to Kanban › ${pick.selectedOptions[0]?.textContent || '—'}.` : `A Kanban project “${name.value.trim() || current.name}” and its Git repository will be created.`;
      };
      for (const control of [existing.radio, fresh.radio, pick, name]) control.addEventListener('input', sync);
      sync();
      const unlink = current.kanbanProjectId ? button('Remove link', async () => {
        if (!(await flush())) return;
        const data = await call(`/api/origin/projects/${encodeURIComponent(current.id)}/link`, { expectedRevision: revisionOf(current), kanbanProjectId: null }, 'The link could not be removed.').catch(failure => { showError(failure.message); return null; });
        if (!data) return;
        saveRevision(data.revision, data.project);
        dialogs['origin-connect-dialog']?.close(); render(); app.announce('Kanban link removed. Kanban work is unchanged.');
      }, 'origin-link') : null;
      modal('origin-connect-dialog', { title: 'Connect to Kanban', lead: 'Choose where this project’s tasks go. Nothing is created or sent until you choose Connect.',
        body: [dialogForm('origin-connect-dialog', [existing.label, pick, fresh.label, name, destination, ...(unlink ? [unlink] : [])], 'Connect', async () => {
          if (!(await flush())) throw new Error('This blueprint has unsaved changes. Save or reload it first.');
          const body = existing.radio.checked ? { expectedRevision: revisionOf(current), kanbanProjectId: pick.value } : { expectedRevision: revisionOf(current), createKanban: true, name: name.value };
          if (existing.radio.checked && !pick.value) throw new Error('Choose a Kanban project.');
          const data = await call(`/api/origin/projects/${encodeURIComponent(current.id)}/link`, body, 'The project could not be connected. The design is unchanged.');
          saveRevision(data.revision, data.project);
          await app.ensureBoard({ ifChanged: true });
          render(); app.announce(`Connected to Kanban › ${data.project.kanban?.name || ''}.`);
          then?.();
        })] });
      (existing.radio.checked ? pick : name).focus();
    }
    /**
     * Reset the structure. Restoring the default categories adds what is missing and removes nothing. Starting blank
     * removes every category and section with what is in them: it asks for the project's name, keeps a copy of the
     * project in the app data folder first, and can be undone right after.
     */
    function openReset() {
      const current = project(); if (!current || !record?.exists) return;
      const mode = (value, text, hint, checked) => { const label = el('label', 'origin-radio'); const radio = el('input'); radio.type = 'radio'; radio.name = 'origin-reset-mode'; radio.value = value; radio.checked = checked;
        const words = el('span'); words.append(el('strong', '', text), el('small', 'origin-hint', hint)); label.append(radio, words); return { label, radio }; };
      const content = total(order().filter(id => id !== M.HOME).map(id => M.pageContent(bp(), id)));
      const restore = mode('default', 'Restore the default categories and sections', 'Adds back the built-in categories, sections and questions that are missing. Nothing is removed.', true);
      const blank = mode('blank', 'Start over, blank', `Deletes every category and section${content.total ? `, with ${contentWords(content)}` : ''}. The Overview stays.`, false);
      const typed = el('input'); typed.id = 'origin-reset-name'; typed.autocomplete = 'off'; typed.placeholder = current.name;
      const confirm = field(`Type “${current.name}” to confirm`, typed); confirm.hidden = true;
      for (const option of [restore, blank]) option.radio.addEventListener('change', () => { confirm.hidden = !blank.radio.checked; });
      modal('origin-reset-dialog', { title: 'Reset structure', lead: 'Choose how. A copy of the project as it is now is kept in the app data folder first.',
        body: [dialogForm('origin-reset-dialog', [restore.label, blank.label, confirm], 'Reset structure', async () => {
          if (blank.radio.checked && typed.value.trim() !== current.name) { typed.focus(); throw new Error('Type the project’s name exactly to start over blank.'); }
          if (!(await flush())) throw new Error('This blueprint has unsaved changes. Save or reload it first.');
          const before = JSON.stringify(bp()), from = section;
          const data = await call(`/api/origin/projects/${encodeURIComponent(current.id)}/reset`, { expectedRevision: record.revision, mode: blank.radio.checked ? 'blank' : 'default' }, 'The structure could not be reset. Nothing was changed.');
          record.blueprint = data.blueprint; saveRevision(data.revision, data.project); views.map = null; open = null;
          render(); researchPanel.structureChanged();
          // Undo saves the copy taken just before as a normal change.
          if (blank.radio.checked) showUndo('The structure was reset to blank.', before, from); else hideUndo();
          showNotice(`The structure was reset. The project as it was is kept in the app data folder as ${data.kept}.`);
          app.announce(blank.radio.checked ? 'Started over blank.' : 'The default categories and sections are back.');
        }, { danger: false })] });
    }
    function openDelete() {
      const current = project(); if (!current) return;
      const linked = current.kanban?.exists;
      const also = el('label', 'origin-check-row'); const alsoInput = el('input'); alsoInput.type = 'checkbox'; alsoInput.id = 'origin-delete-kanban';
      const alsoText = el('span'); alsoText.append(el('strong', '', `Also remove the Kanban project “${current.kanban?.name || ''}”`), el('small', 'origin-hint', 'Kanban’s own checks apply: running work or task worktrees block it. Repository folders are never deleted.'));
      also.append(alsoInput, alsoText); also.hidden = !linked;
      modal('origin-delete-dialog', { title: `Delete “${current.name}” from Origin?`,
        lead: linked ? 'This removes the design from Origin. Its Kanban project and tasks stay unless you also choose to remove them.' : 'This removes the design from Origin. Repository folders and worktrees are never deleted.',
        body: [dialogForm('origin-delete-dialog', [also], 'Delete from Origin', async () => {
          await flush();
          const data = await call(`/api/origin/projects/${encodeURIComponent(current.id)}/delete`, { expectedRevision: revisionOf(current), deleteKanban: alsoInput.checked, expectedKanbanRevision: current.kanban?.revision },
            'The project could not be deleted. Nothing was removed.');
          projects = projects.filter(item => item.id !== current.id);
          if (data.kanbanDeleted) await app.ensureBoard({ ifChanged: true });
          const next = projects[0]?.id || null;
          setPref(PROJECT_KEY, next || '');
          await load(next);
          app.announce(`${current.name} was deleted from Origin${data.kanbanDeleted ? ' and Kanban' : '; its Kanban work stays'}.`);
        }, { danger: true })] });
    }

    // ---- Controls ----
    const field = (label, control, hint = '') => { const box = el('label', 'origin-field'); box.append(el('span', 'origin-field-label', label), control); if (hint) box.append(el('small', 'origin-hint', hint)); return box; };
    function group(label, control, hint = '') {
      const box = el('div', 'origin-field'); box.setAttribute('role', 'group');
      const title = el('span', 'origin-field-label', label); title.id = `origin-group-${++uid}`; box.setAttribute('aria-labelledby', title.id);
      box.append(title, control); if (hint) box.append(el('small', 'origin-hint', hint));
      return box;
    }
    function input(target, key, { max = 200, placeholder = '', type = 'text', label } = {}) {
      const control = el('input'); control.type = type; if (type !== 'date') control.maxLength = max;
      control.value = target[key] || ''; control.placeholder = placeholder; control.dataset.focusKey = key; if (label) control.setAttribute('aria-label', label);
      control.addEventListener('input', () => { target[key] = control.value; changed(); });
      return control;
    }
    function area(target, key, placeholder = '', { max = 20000, label } = {}) {
      const control = el('textarea'); control.rows = 2; control.maxLength = max; control.value = target[key] || ''; control.placeholder = placeholder; control.dataset.focusKey = key;
      if (label) control.setAttribute('aria-label', label);
      control.addEventListener('input', () => { target[key] = control.value; changed(); });
      return autoGrow(control);
    }
    function select(target, key, list, { structure = false, onChange, label } = {}) {
      const control = el('select');
      for (const [value, name] of list) control.append(Object.assign(el('option', '', name), { value }));
      control.value = target[key]; control.dataset.focusKey = key; if (label) control.setAttribute('aria-label', label);
      control.addEventListener('change', () => { target[key] = control.value; onChange?.(); changed({ drawer: structure }); });
      return control;
    }
    function segmented(target, key, list, { onChange, structure = false } = {}) {
      const box = el('div', 'origin-seg'); box.setAttribute('role', 'radiogroup');
      const choose = option => { target[key] = option.dataset.value; paint(); onChange?.(); changed({ drawer: structure }); };
      const options = list.map(([value, name]) => { const option = button(name, () => choose(option), ''); option.setAttribute('role', 'radio'); option.dataset.value = value; option.dataset.focusKey = `${key}:${value}`; return option; });
      const paint = () => { for (const option of options) { const on = option.dataset.value === target[key]; option.setAttribute('aria-checked', String(on)); option.tabIndex = on ? 0 : -1; } if (!options.some(option => option.tabIndex === 0)) options[0].tabIndex = 0; };
      box.addEventListener('keydown', event => {
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
        if (!step) return;
        event.preventDefault();
        const index = options.findIndex(option => option.dataset.value === target[key]);
        const next = options[(index + step + options.length) % options.length];
        choose(next); (drawer.querySelector(`[data-focus-key="${CSS.escape(next.dataset.focusKey)}"]`) || next).focus();
      });
      box.append(...options); paint();
      return box;
    }
    function linkChips(target, key, collection, { options = bp()[collection], exclude, name = item => M.itemName(bp(), collection, item.id) || 'Untitled', empty } = {}) {
      const box = el('div', 'origin-links');
      const linked = target[key].map(id => options.find(item => item.id === id)).filter(Boolean);
      for (const item of linked) {
        const tag = el('span', 'origin-chip origin-link-chip'); tag.append(el('span', '', name(item)));
        const remove = button('', () => { target[key] = target[key].filter(id => id !== item.id); changed({ drawer: true }); }, 'origin-chip-x'); remove.append(icon(ICON.close, 12));
        remove.setAttribute('aria-label', `Unlink ${name(item)}`); remove.dataset.focusKey = `${key}:add`;
        tag.append(remove); box.append(tag);
      }
      const choices = options.filter(item => item.id !== exclude && !target[key].includes(item.id));
      if (choices.length) {
        const pick = el('select', 'origin-link-add'); pick.setAttribute('aria-label', 'Add a link'); pick.dataset.focusKey = `${key}:add`;
        pick.append(Object.assign(el('option', '', linked.length ? '＋ Add' : '＋ Link…'), { value: '' }), ...choices.map(item => Object.assign(el('option', '', name(item)), { value: item.id })));
        pick.addEventListener('change', () => { if (!pick.value) return; target[key] = [...target[key], pick.value]; changed({ drawer: true }); });
        box.append(pick);
      } else if (!linked.length) box.append(el('span', 'origin-hint', empty || 'Nothing to link yet.'));
      return box;
    }
    function evidence(item) {
      const state = M.verification(item, bp().sources);
      return group('Evidence', linkChips(item, 'sourceIds', 'sources', { empty: 'Add sources in Research to back this up.' }),
        { verified: '✓ Backed by a source you verified.', conflict: 'A linked source contradicts this.', outdated: 'Only outdated evidence so far.' }[state] || 'Not verified yet — link a source you checked. A link alone verifies nothing.');
    }
    function urlField(item) {
      const control = el('input'); control.type = 'url'; control.maxLength = 2000; control.value = item.url; control.placeholder = 'https://…'; control.dataset.focusKey = 'url';
      const error = el('small', 'origin-inline-error'); error.hidden = true;
      const openLink = el('a', 'origin-link origin-open-link', 'Open ↗'); openLink.target = '_blank'; openLink.rel = 'noopener noreferrer';
      const sync = () => { const url = safeUrl(item.url); openLink.hidden = !url; if (url) openLink.href = url; else openLink.removeAttribute('href'); };
      control.addEventListener('input', () => {
        const value = control.value.trim(), valid = !value || Boolean(safeUrl(value));
        error.hidden = valid; error.textContent = valid ? '' : 'Use an http or https link without a user name or password. It is saved once it is valid.';
        control.setAttribute('aria-invalid', String(!valid));
        if (valid && item.url !== value) { item.url = value; changed(); }
        sync();
      });
      sync();
      const box = field('Link', control); box.append(error, openLink);
      return box;
    }
    function quickAdd(placeholder, onAdd, { id = section, extra, max = 200 } = {}) {
      const form = el('form', 'origin-quick');
      const control = el('input'); control.placeholder = placeholder; control.maxLength = max; control.autocomplete = 'off'; control.setAttribute('aria-label', placeholder); control.dataset.quick = id;
      const draftKey = `${projectId}\0${id}`;
      control.value = quickDrafts.get(draftKey) || '';
      control.addEventListener('input', () => { if (control.value) quickDrafts.set(draftKey, control.value); else quickDrafts.delete(draftKey); });
      form.append(icon(ICON.plus, 16), control);
      if (extra) form.append(extra);
      form.append(el('kbd', 'origin-kbd', '↵'));
      form.addEventListener('submit', event => {
        event.preventDefault();
        const value = control.value.trim();
        if (!value) return;
        control.value = ''; quickDrafts.delete(draftKey);
        focusAfter = () => main.querySelector(`[data-quick="${CSS.escape(id)}"]`);
        onAdd(value);
      });
      return form;
    }
    function add(collection, entry, { keyed = false, edit = false } = {}) {
      // One over the limit and the blueprint could not be saved any more.
      if (bp()[collection].length >= M.LIMITS[collection]) { app.announce(`A project can have at most ${M.LIMITS[collection]} ${NOUN[collection].toLowerCase()} records.`); return null; }
      const item = { id: newId(), origin: 'human', ...entry };
      if (keyed) item.key = M.nextKey(bp(), collection);
      bp()[collection].push(item);
      changed({ structure: true });
      if (edit) openDrawer(collection, item.id);
      app.announce(`${NOUN[collection]} added.`);
      return item;
    }
    /**
     * Apply one approved research suggestion to the open blueprint, like an edit made by hand: the normal autosave,
     * revision check and redraws follow. A field that changed since the research ran, a removed target or a
     * duplicate name is a conflict and changes nothing, unless the person chose to replace it anyway.
     */
    function applyResearch(proposal, { force = false, value = proposal.value, refs = new Map() } = {}) {
      if (!record?.exists) return { error: 'Open the project before applying suggestions.' };
      let result;
      try { result = M.applyResearchSuggestion(bp(), proposal, { value, force, newId, refs }); } catch (error) { return { error: error.message }; } // An edited value that is not valid.
      if (result.ok) changed({ structure: true, drawer: true });
      return result;
    }
    /** After a batch: links to records created later in it. Returns the ones that could not be resolved. */
    function resolveResearchLinks(pending, refs) {
      if (!record?.exists || !pending.length) return pending;
      const left = M.resolveResearchLinks(bp(), pending, refs);
      if (left.length !== pending.length) changed({ structure: true, drawer: true });
      return left;
    }
    // A list of records. Each row opens the drawer.
    function list(collection, items, describe, empty, { leading } = {}) {
      if (!items.length) return el('p', 'origin-empty-note', empty);
      const box = el('ol', 'origin-list');
      for (const item of items) {
        const { title, fallback, sub = '', meta = [], tone = 'progress' } = describe(item);
        const row = el('li', 'origin-row'); row.dataset.id = item.id;
        if (leading) row.append(leading(item));
        const openRow = el('button', 'origin-row-open'); openRow.type = 'button';
        const dot = el('span', 'origin-dot'); dot.dataset.state = tone; dot.setAttribute('aria-hidden', 'true');
        const text = el('span', 'origin-row-text'); text.append(el('span', 'origin-row-title', title?.trim() ? title : fallback));
        if (sub) text.append(el('span', 'origin-row-sub', sub));
        const tags = el('span', 'origin-row-meta'); tags.append(...meta.filter(Boolean));
        if (item.origin === 'ai') tags.append(chip('AI suggestion', 'accent'));
        openRow.append(dot, text, tags);
        openRow.addEventListener('click', () => openDrawer(collection, item.id));
        row.append(openRow); box.append(row);
      }
      return box;
    }
    const subhead = (title, lead) => { const box = el('div', 'origin-subhead'); box.append(el('h3', '', title)); if (lead) box.append(el('p', '', lead)); return box; };
    const key = item => el('span', 'origin-key', item.key);

    // ---- Deleting keeps every remaining link valid ----
    function referencesTo(collection, id) {
      const found = [];
      for (const [owner, records] of Object.entries(bp())) {
        if (!Array.isArray(records)) continue;
        for (const entry of records) for (const [name, value] of Object.entries(entry)) {
          // “Also include” links name their collection on each entry.
          if (name === 'contextIds') { if (Array.isArray(value) && value.some(ref => ref.collection === collection && ref.id === id)) found.push({ owner, entry, field: name }); continue; }
          const targetCollection = typeof REFS[name] === 'function' ? REFS[name](owner) : REFS[name];
          if (targetCollection !== collection) continue;
          if (Array.isArray(value) ? value.includes(id) : value === id) found.push({ owner, entry, field: name });
        }
      }
      return found;
    }
    function removeEntity(collection, id) {
      // Tasks outlive a removed component; each keeps a note of the missing link until it is relinked or dismissed.
      if (collection === 'components') {
        const gone = bp().components.find(item => item.id === id);
        for (const item of bp().items) if (item.componentIds.includes(id)) { item.lostLinks ||= []; if (item.lostLinks.length < 20) item.lostLinks.push({ collection: 'components', name: gone?.name?.trim() || 'Unnamed component' }); }
      }
      const references = referencesTo(collection, id);
      bp()[collection] = bp()[collection].filter(item => item.id !== id);
      for (const { owner, entry, field: name } of references) {
        if (owner === 'connections') bp().connections = bp().connections.filter(item => item !== entry);
        else if (name === 'contextIds') entry.contextIds = entry.contextIds.filter(ref => ref.collection !== collection || ref.id !== id);
        else if (Array.isArray(entry[name])) entry[name] = entry[name].filter(value => value !== id);
        else entry[name] = '';
        // An assumption turned into this decision is open again: the decision that resolved it is gone.
        if (owner === 'assumptions' && name === 'decisionId' && entry.status === 'converted') entry.status = 'open';
      }
      planSelection.delete(id);
      if (open?.id === id) open = null;
      return references.length;
    }

    // ---- Drawer: edit one record. Essentials first, everything else under “More details”. ----
    const DRAWER = {
      requirements: item => ({
        title: ['title', 'What must it do?'],
        essentials: [group('Priority', segmented(item, 'priority', [['must', 'Must'], ['should', 'Should'], ['could', 'Could']])),
          field('Done when', area(item, 'acceptanceCriteria', 'One check per line — e.g. “A user can reset their password”'), 'These checks travel with the work into Compose and Kanban.')],
        more: [field('Type', select(item, 'type', M.ENUMS.requirementType)), field('Status', select(item, 'status', M.ENUMS.itemStatus)), field('Description', area(item, 'description')),
          group('Built by', linkChips(item, 'componentIds', 'components', { empty: 'Add components in Architecture first.' })), evidence(item)],
      }),
      components: item => ({
        title: ['name', 'Component name'],
        essentials: [field('Type', select(item, 'type', M.ENUMS.componentType, { structure: true })),
          bp().layers.length ? field('Layer', select(item, 'layerId', [['', 'No layer'], ...bp().layers.map(layer => [layer.id, layer.name || 'Unnamed layer'])], { structure: true })) : null,
          ask(item, 'purpose', M.COMPONENT_FIELDS.purpose, 'Its job in one or two sentences'), group('Connects to', connectionsEditor(item)), group('Tasks', componentTasks(item)), componentQuestions(item)].filter(Boolean),
        more: [ask(item, 'responsibilities', M.COMPONENT_FIELDS.responsibilities, 'One per line'), ask(item, 'interfaces', M.COMPONENT_FIELDS.interfaces, 'APIs, events, files…'), ask(item, 'dataHandled', M.COMPONENT_FIELDS.dataHandled),
          group('Technologies', linkChips(item, 'technologyIds', 'technologies', { empty: 'Add technologies in Technology first.' })), field('Status', select(item, 'status', M.ENUMS.itemStatus)), field('Notes', area(item, 'notes')), evidence(item)],
      }),
      technologies: item => ({
        title: ['name', 'Technology'],
        essentials: [group('Status', segmented(item, 'status', M.ENUMS.techStatus)), field('Category', select(item, 'category', M.ENUMS.techCategory, { structure: true })), field('Why this one?', area(item, 'reason', 'The reason it fits this project'))],
        more: [field('Version', input(item, 'version', { max: 80, placeholder: 'e.g. 22' })), field('Purpose', area(item, 'purpose')), field('Alternatives considered', area(item, 'alternatives', 'One per line')), evidence(item),
          el('p', 'origin-hint', `Used by: ${bp().components.filter(component => component.technologyIds.includes(item.id)).map(component => component.name || 'Unnamed').join(', ') || 'no component yet'}.`)],
      }),
      dependencies: item => ({
        title: ['name', 'Dependency'],
        essentials: [field('Type', select(item, 'type', M.ENUMS.dependencyType)), field('Version', input(item, 'version', { max: 80, placeholder: 'e.g. ^4.2' })), group('Needed by', linkChips(item, 'requiredBy', 'components', { empty: 'Add components in Architecture first.' }))],
        more: [group('Depends on', linkChips(item, 'dependsOn', 'dependencies', { exclude: item.id })), evidence(item), field('Notes', area(item, 'notes'))],
      }),
      decisions: item => ({
        title: ['title', 'Topic — e.g. Database'],
        essentials: [group('Status', segmented(item, 'status', M.ENUMS.decisionStatus, { structure: true, onChange: () => { if (item.status === 'accepted' && !item.date) item.date = today(); } })),
          field('Decision', area(item, 'decision', 'What you chose')), field('Why', area(item, 'reason', 'The reason — so nobody undoes it by accident')),
          item.status === 'accepted' ? el('p', 'origin-callout', 'Accepted. To change it later, record a new decision that supersedes this one, so the reasoning is kept.') : null].filter(Boolean),
        more: [field('Context', area(item, 'context')), field('Alternatives', area(item, 'alternatives', 'One per line')), field('Consequences', area(item, 'consequences')), field('Date', input(item, 'date', { type: 'date' })),
          field('Superseded by', select(item, 'supersededBy', [['', 'None'], ...bp().decisions.filter(other => other.id !== item.id).map(other => [other.id, M.itemName(bp(), 'decisions', other.id)])])),
          group('Applies to components', linkChips(item, 'componentIds', 'components')), group('Technologies', linkChips(item, 'technologyIds', 'technologies')),
          group('Requirements', linkChips(item, 'requirementIds', 'requirements')), group('Dependencies', linkChips(item, 'dependencyIds', 'dependencies')), evidence(item)],
      }),
      assumptions: item => ({
        title: ['statement', 'What do you assume?'], max: 2000,
        essentials: [field('If it is wrong…', area(item, 'impact', 'What breaks or has to change')),
          item.status === 'converted' ? el('p', 'origin-callout', 'Turned into a decision.') : group('Status', segmented(item, 'status', [['open', 'Open'], ['validated', 'Holds'], ['invalid', 'Invalid']], { structure: true })),
          item.decisionId ? button(`Open ${M.itemName(bp(), 'decisions', item.decisionId)}`, () => focusTarget({ collection: 'decisions', id: item.decisionId }), 'origin-ghost')
            : button('Make it a decision', () => convertAssumption(item), 'origin-ghost', 'Create a proposed decision from this assumption')],
        more: [field('Why you assume it', area(item, 'reason')), evidence(item)],
      }),
      sources: item => ({
        title: ['title', 'Source title'],
        essentials: [urlField(item), group('Checked?', segmented(item, 'verification', M.ENUMS.sourceVerification, { structure: true }), 'Mark it Verified only after you read it. Origin never fetches links.'),
          field('What it supports', area(item, 'claim', 'The claim this source backs up or contradicts', { max: 4000 }))],
        more: [field('Type', select(item, 'type', M.ENUMS.sourceType)), field('Date checked', input(item, 'accessedAt', { type: 'date' })), field('Notes', area(item, 'notes')),
          el('p', 'origin-hint', `Evidence for: ${referencesTo('sources', item.id).map(({ owner, entry }) => M.itemName(bp(), owner, entry.id)).filter(Boolean).join(', ') || 'nothing linked yet'}.`)],
      }),
      risks: item => ({
        title: ['title', 'What could go wrong?'],
        essentials: [group('Severity', segmented(item, 'severity', [['high', 'High'], ['medium', 'Medium'], ['low', 'Low']])), field('How you reduce it', area(item, 'mitigation'))],
        more: [field('Kind', select(item, 'kind', M.ENUMS.riskKind)), field('Status', select(item, 'status', M.ENUMS.riskStatus)), field('Description', area(item, 'description')),
          group('Affects', linkChips(item, 'componentIds', 'components'))],
      }),
      areas: item => ({
        title: ['title', 'Your approach'],
        essentials: [field('Topic', select(item, 'area', M.AREAS[item.section].map(([value]) => [value, topicName(item.section, value)]), { structure: true })), field('Details', area(item, 'description', 'Anything an agent should know')), ...(item.section === 'ai' ? [baseField(item)] : [])],
        more: [field('Status', select(item, 'status', M.ENUMS.itemStatus)), group('Components', linkChips(item, 'componentIds', 'components')),
          group(item.section === 'testing' ? 'Requirements covered' : 'Requirements', linkChips(item, 'requirementIds', 'requirements')), group('Technologies', linkChips(item, 'technologyIds', 'technologies'))],
      }),
      layers: item => ({
        title: ['name', 'Layer name — e.g. Backend'],
        essentials: [field('What belongs here', area(item, 'description', 'For example: everything that runs on the server', { max: 2000 })),
          group('Stack', linkChips(item, 'technologyIds', 'technologies', { options: bp().technologies.filter(entry => entry.status !== 'rejected'), empty: 'Add technologies in Technology first.' }),
            'Only selected technologies are passed on as the stack; candidates are marked as candidates.'),
          field('Shared rules', area(item, 'constraints', 'Constraints every component in this layer follows'))],
        more: [el('p', 'origin-hint', `Components: ${bp().components.filter(component => component.layerId === item.id).map(component => component.name || 'Unnamed').join(', ') || 'none yet — choose this layer in a component’s editor'}.`),
          el('p', 'origin-hint', 'Deleting a layer keeps its components and tasks; they just lose the grouping.')],
      }),
      milestones: item => ({
        title: ['title', 'Milestone'],
        essentials: [field('Goal', area(item, 'goal', 'What is true when this milestone is reached')), field('Done when', area(item, 'definitionOfDone', 'One check per line'))],
        more: [(() => { const box = el('div', 'origin-inline-actions'); box.append(button('Move earlier', () => moveMilestone(item, -1), 'origin-ghost'), button('Move later', () => moveMilestone(item, 1), 'origin-ghost')); return box; })(),
          el('p', 'origin-hint', 'Deleting a milestone keeps its tasks; they become unscheduled.')],
      }),
      items: item => {
        const home = M.taskHome(bp(), item), component = bp().components.find(entry => entry.id === home.componentId);
        if (item.handoff && contextStatus.revision !== record.revision) void refreshContextStatus();
        return {
          title: ['title', 'Task — e.g. Build the sign-in form'],
          essentials: [...lostNotes(item), sentPanel(item, drawerMessage), proposalPanel(item), field('What to do', area(item, 'description', 'What to build or change, in a few lines')),
            field('Done when', area(item, 'acceptanceCriteria', 'One check per line — e.g. “A user can sign in with email”'), 'These checks travel with the task into Compose and Kanban.'),
            contextPreview(item)].filter(Boolean),
          more: [group('Components', linkChips(item, 'componentIds', 'components', { empty: 'Add components in Architecture first.' }), 'The first component is where the task is listed.'),
            component ? el('p', 'origin-hint', `Layer: ${bp().layers.find(layer => layer.id === home.layerId)?.name || 'none'} — from ${component.name || 'its component'}.`)
              : bp().layers.length ? field('Layer', select(item, 'layerId', [['', 'Whole project'], ...bp().layers.map(layer => [layer.id, layer.name || 'Unnamed layer'])], { structure: true })) : null,
            group('Starts after', linkChips(item, 'dependsOn', 'items', { exclude: item.id, empty: 'No other tasks yet.' }), 'Only these prerequisites set the build order.'),
            field('Milestone', select(item, 'milestoneId', [['', 'Unscheduled'], ...bp().milestones.map(milestone => [milestone.id, milestone.title || 'Untitled milestone'])], { structure: true })),
            group('Requirements', linkChips(item, 'requirementIds', 'requirements')),
            group('Also include', contextLinks(item), 'Decisions, research, planning answers or your own sections this task needs. Nothing else is added on its own.'),
            field('Workstream', input(item, 'workstream', { max: 80, placeholder: 'Backend, UI…' })),
            (() => { const box = el('div', 'origin-inline-actions'); box.append(button('Move up', () => moveTask(item, -1), 'origin-ghost'), button('Move down', () => moveTask(item, 1), 'origin-ghost')); return box; })(),
            originalNote(item),
            item.handoff ? el('p', 'origin-hint', `Sent to Kanban on ${new Date(item.handoff.at).toLocaleString()}.`) : null].filter(Boolean),
        };
      },
    };
    function openDrawer(collection, id) {
      contextPanel.close(); // Its unsaved text is kept and keeps saving.
      researchPanel.yieldDrawer(); // Its chat and unsent text are kept.
      promptCache.at = 0; // Opening a record always reads its saved prompts fresh.
      if (baseResources?.failed) baseResources = null; // A failed Base read is tried again, not kept.
      open = { collection, id };
      renderDrawer({ restore: false });
      markSelected();
      const title = drawer.querySelector('.origin-drawer-title');
      title?.focus(); title?.setSelectionRange(0, 0); // Show a long title from its start, not scrolled to its end.
    }
    function closeDrawer() {
      const was = open;
      open = null; renderDrawer();
      if (renderFrame) renderMain(); else markSelected();
      if (was) main.querySelector(`[data-id="${CSS.escape(was.id)}"] .origin-row-open, .origin-node[data-id="${CSS.escape(was.id)}"]`)?.focus({ preventScroll: true });
    }
    function renderDrawer({ restore = true } = {}) {
      if (contextPanel.isOpen() || researchPanel.isOpen()) return; // Project Context or Research owns the panel while it is open.
      const entry = open && record?.exists ? bp()[open.collection]?.find(item => item.id === open.id) : null;
      if (!entry) { open = null; drawer.hidden = true; drawer.replaceChildren(); view.dataset.drawer = 'closed'; return; }
      const focused = restore && drawer.contains(document.activeElement) ? document.activeElement : null, focusKey = focused?.dataset.focusKey;
      // The caret too: a redraw while you type must not move your next keystrokes to the end.
      const caret = typeof focused?.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
      const scroll = drawer.querySelector('.origin-drawer-body')?.scrollTop || 0;
      drawerMessage = el('p', 'origin-inline-error'); drawerMessage.hidden = true; drawerMessage.setAttribute('role', 'alert');
      const spec = DRAWER[open.collection](entry), collection = open.collection;
      const head = el('div', 'origin-drawer-head');
      const top = el('div', 'origin-drawer-top');
      const close = button('', closeDrawer, 'origin-icon', 'Close (Esc)'); close.setAttribute('aria-label', 'Close editor'); close.append(icon(ICON.close));
      top.append(el('p', 'origin-eyebrow', `${NOUN[collection]}${entry.key ? ` · ${entry.key}` : ''}`), close);
      const [titleKey, placeholder] = spec.title;
      const title = el('input', 'origin-drawer-title'); title.id = 'origin-drawer-title'; title.maxLength = spec.max || 200; title.value = entry[titleKey] || ''; title.placeholder = placeholder;
      title.dataset.focusKey = titleKey; title.setAttribute('aria-label', `${NOUN[collection]} title`);
      title.addEventListener('input', () => { entry[titleKey] = title.value; changed(); });
      head.append(top, title);
      const body = el('div', 'origin-drawer-body');
      body.append(...spec.essentials);
      if (spec.more?.length) {
        const more = el('details', 'origin-more'); more.open = pref(MORE_KEY) === 'open';
        more.append(el('summary', '', 'More details'), ...spec.more);
        more.addEventListener('toggle', () => setPref(MORE_KEY, more.open ? 'open' : 'closed'));
        body.append(more);
      }
      const message = drawerMessage;
      const foot = el('div', 'origin-drawer-foot');
      const left = el('div', 'origin-inline-actions');
      if (collection === 'items') left.append(improveButton(entry, message));
      else if (COMPOSABLE.has(collection)) left.append(composeButton(collection, entry.id, message));
      if (collection === 'items') { const send = button('Send to Kanban', () => void openHandoff([entry.id]), 'origin-ghost', 'Create its To Do card. No agent starts.'); send.id = 'origin-drawer-handoff'; left.append(send); }
      body.append(linkedPrompts(collection, entry.id));
      foot.append(left, deleteControl(collection, entry));
      drawer.replaceChildren(head, body, message, foot);
      drawer.hidden = false; view.dataset.drawer = 'open';
      body.scrollTop = scroll;
      const again = focusKey ? drawer.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`) : null;
      again?.focus();
      if (caret && typeof again?.selectionStart === 'number') again.setSelectionRange(...caret);
    }
    drawer.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); if (contextPanel.isOpen()) contextPanel.close(); else if (researchPanel.isOpen()) researchPanel.close(); else closeDrawer(); } });
    // Saved project prompts (and their cards) that link to this record. Read-only here; open them to change them.
    let promptCache = { projectId: null, at: 0, list: [] };
    function linkedPrompts(collection, id) {
      const box = el('div', 'origin-linked-prompts');
      const fill = list => {
        const mine = list.filter(prompt => prompt.origin.some(link => link.originId === projectId && link.collection === collection && link.id === id));
        if (!mine.length) { box.replaceChildren(); return; }
        box.replaceChildren(el('span', 'origin-field-label', 'Saved prompts'), ...mine.map(prompt => {
          const row = el('div', 'origin-linked-prompt');
          row.append(button(`${prompt.title} · rev ${prompt.current}`, () => app.openPrompt(projectId, prompt.id), 'origin-link'),
            ...prompt.cards.filter(card => card.exists).map(card => button(`Kanban #${card.number ?? ''}${card.behind ? ' (older revision)' : ''}`, () => app.openKanban(card.projectId, card.taskId), 'origin-link')));
          return row;
        }));
      };
      const owner = projectId;
      if (promptCache.projectId === owner && Date.now() - promptCache.at < 5000) fill(promptCache.list);
      else app.api(`/api/shared-projects/${encodeURIComponent(owner)}/prompts`).then(({ response, data }) => {
        if (!response.ok || owner !== projectId) return;
        promptCache = { projectId: owner, at: Date.now(), list: data.prompts }; fill(data.prompts);
      }).catch(() => {});
      return box;
    }
    function deleteControl(collection, item) {
      const remove = button('Delete', () => {
        if (remove.dataset.confirm !== 'true') {
          const count = referencesTo(collection, item.id).length;
          remove.dataset.confirm = 'true'; remove.textContent = count ? `Delete and unlink ${plural(count, 'reference')}?` : 'Delete — are you sure?'; remove.classList.add('danger');
          return;
        }
        const count = removeEntity(collection, item.id);
        open = null; renderDrawer();
        app.announce(`${NOUN[collection]} deleted${count ? `; ${plural(count, 'link')} removed` : ''}.`);
        changed({ structure: true });
        main.querySelector('h2')?.focus({ preventScroll: true });
      }, 'origin-link origin-delete');
      return remove;
    }
    function connectionsEditor(item) {
      const blueprint = bp(), box = el('div', 'origin-connections');
      const name = id => blueprint.components.find(component => component.id === id)?.name || 'Unnamed component';
      for (const connection of blueprint.connections.filter(entry => entry.from === item.id)) {
        const row = el('div', 'origin-connection');
        const label = input(connection, 'label', { max: 80, placeholder: 'calls', label: `How it uses ${name(connection.to)}` }); label.dataset.focusKey = `label:${connection.id}`;
        const protocol = input(connection, 'protocol', { max: 80, placeholder: 'HTTPS', label: `Protocol to ${name(connection.to)}` }); protocol.dataset.focusKey = `protocol:${connection.id}`;
        const remove = button('', () => { bp().connections = bp().connections.filter(entry => entry !== connection); changed({ structure: true, drawer: true }); }, 'origin-icon origin-small', 'Remove connection');
        remove.setAttribute('aria-label', `Remove connection to ${name(connection.to)}`); remove.append(icon(ICON.close, 14)); remove.dataset.focusKey = 'connect';
        row.append(el('span', 'origin-connection-target', `→ ${name(connection.to)}`), label, protocol, remove);
        box.append(row);
      }
      // Components it already connects to are left out: one connection per pair and direction.
      const others = blueprint.components.filter(component => component.id !== item.id && !blueprint.connections.some(entry => entry.from === item.id && entry.to === component.id));
      if (others.length) {
        const pick = el('select', 'origin-link-add'); pick.setAttribute('aria-label', 'Connect to a component'); pick.dataset.focusKey = 'connect';
        pick.append(Object.assign(el('option', '', '＋ Connect to…'), { value: '' }), ...others.map(component => Object.assign(el('option', '', component.name || 'Unnamed component'), { value: component.id })));
        pick.addEventListener('change', () => {
          if (!pick.value) return;
          if (bp().connections.length >= M.LIMITS.connections) { app.announce(`A project can have at most ${M.LIMITS.connections} connections.`); return; }
          const connection = { id: newId(), origin: 'human', from: item.id, to: pick.value, label: 'calls', protocol: '', notes: '' };
          bp().connections.push(connection);
          changed({ structure: true, drawer: true });
          drawer.querySelector(`[data-focus-key="label:${CSS.escape(connection.id)}"]`)?.focus();
        });
        box.append(pick);
      } else box.append(el('span', 'origin-hint', 'Add another component to connect them.'));
      const users = blueprint.connections.filter(entry => entry.to === item.id).map(entry => name(entry.from));
      if (users.length) box.append(el('small', 'origin-hint', `Used by ${users.join(', ')}.`));
      return box;
    }
    function convertAssumption(item) {
      const decision = { id: newId(), origin: 'human', ...BLANK.decisions(item.statement.slice(0, 200)), key: M.nextKey(bp(), 'decisions'),
        context: [item.statement, item.reason && `Reason: ${item.reason}`, item.impact && `Impact if false: ${item.impact}`].filter(Boolean).join('\n'), sourceIds: [...item.sourceIds] };
      bp().decisions.push(decision);
      item.status = 'converted'; item.decisionId = decision.id;
      section = 'decisions'; setPref(SECTION_KEY, section);
      changed({ structure: true });
      openDrawer('decisions', decision.id);
      app.announce(`Assumption turned into ${decision.key}. Decide it, then accept or reject it.`);
    }
    function moveMilestone(item, step) {
      const milestones = bp().milestones, index = milestones.indexOf(item), next = index + step;
      if (next < 0 || next >= milestones.length) return;
      milestones.splice(index, 1); milestones.splice(next, 0, item);
      changed({ structure: true, drawer: true });
    }
    function baseField(item) {
      if (!baseResources) {
        baseLoading ??= app.api('/api/base', { timeoutMs: 30000 }).then(({ response, data }) => {
          baseResources = response.ok && Array.isArray(data.resources) ? data.resources.map(resource => ({ id: resource.id, title: resource.name, kind: resource.type || resource.kind })) : [];
          if (!response.ok) baseResources.failed = true;
        }).catch(() => { baseResources = Object.assign([], { failed: true }); }).finally(() => { baseLoading = null; if (visible) renderDrawer(); });
        return group('Base resources', el('span', 'origin-hint', 'Loading Base…'));
      }
      const known = new Set(baseResources.map(resource => resource.id));
      const options = [...baseResources, ...item.baseResourceIds.filter(id => !known.has(id)).map(id => ({ id, title: `Missing Base resource (${id})`, kind: 'missing' }))];
      return group('Base resources', linkChips(item, 'baseResourceIds', 'base', { options, name: resource => `${resource.title}${resource.kind && resource.kind !== 'missing' ? ` · ${resource.kind}` : ''}`,
        empty: baseResources.failed ? 'Base could not be read. Saved references are kept.' : 'Base has no resources yet.' }), 'Referenced, never copied or changed. Nothing is assigned to an agent.');
    }

    // ---- Sections ----
    const SECTIONS = {
      overview: () => [mindMap(), overviewPanels()],
      vision() {
        const vision = bp().vision, grid = el('div', 'origin-q-grid'), shown = M.visionFields(bp()), V = M.VISION_QUESTIONS;
        const HINT = { summary: 'A web app that…', problem: 'What is broken or missing today', goal: 'What changes once it exists', users: 'One group per line', useCases: 'One use case per line',
          inScope: 'One item per line', outOfScope: 'One item per line — agents get this as a guardrail', successCriteria: 'Observable outcomes, one per line', constraints: 'Budget, deadlines, platforms, compliance…' };
        shown.forEach((key2, index) => {
          const box = el('div', `origin-q${key2 === 'summary' ? ' wide' : ''}`), key = `vision:${key2}`, wording = M.questionText(bp(), key, V[key2]);
          box.dataset.vision = key2;
          const control = area(vision, key2, HINT[key2], { label: wording });
          const head = el('div', 'origin-q-head');
          head.append(renamable(el('span', 'origin-q-label', wording), { key, value: wording, fallback: V[key2], label: 'question', max: 500, onSave: value => setQuestion(key, value) }),
            itemMenu(`Options for the question “${wording}”`, key, [
              ['Move up', () => restructure(() => M.moveVisionField(bp(), key2, -1)), { disabled: index === 0 }],
              ['Move down', () => restructure(() => M.moveVisionField(bp(), key2, 1)), { disabled: index === shown.length - 1 }],
              ['Remove question', () => restructure(() => M.removeVisionField(bp(), key2), { undo: `Question “${wording}” removed${vision[key2].trim() ? ' with its answer' : ''}.` }), { danger: true }]]));
          box.append(head, control);
          box.addEventListener('click', event => { if (event.target === box) control.focus(); });
          grid.append(box);
        });
        const hidden = M.VISION_SHOWN.filter(key => !shown.includes(key)), nodes = [grid];
        if (!shown.length) nodes.unshift(el('p', 'origin-empty-note', 'Every built-in question was removed. Add one back below, or ask your own.'));
        if (hidden.length) nodes.push(restorePicker('Add a question back…', hidden.map(key => [key, V[key]]), key => restructure(() => M.restoreVisionField(bp(), key))));
        return nodes;
      },
      requirements: () => [quickAdd('Add a requirement — e.g. “People can sign in with email”', value => add('requirements', BLANK.requirements(value), { keyed: true })),
        list('requirements', bp().requirements, item => {
          const checks = M.lines(item.acceptanceCriteria).length;
          return { title: item.title, fallback: 'Untitled requirement', tone: item.status === 'needs_decision' ? 'decision' : checks ? 'defined' : 'progress',
            sub: checks ? `Done when: ${plural(checks, 'check')}` : 'No “done when” yet', meta: [key(item), chip(M.label('priority', item.priority), item.priority === 'must' ? 'accent' : '')] };
        }, 'Nothing yet. Add what the project must do, one line each.')],
      architecture() {
        const blueprint = bp();
        const name = id => blueprint.components.find(component => component.id === id)?.name || 'Unnamed';
        const layerName = id => blueprint.layers.find(layer => layer.id === id)?.name || '';
        return [canvas(), subhead('Components', 'Click one to describe it and connect it to others.'),
          list('components', blueprint.components, item => {
            const out = blueprint.connections.filter(connection => connection.from === item.id).map(connection => name(connection.to));
            return { title: item.name, fallback: 'Unnamed component', tone: item.status === 'needs_decision' ? 'decision' : item.purpose.trim() ? 'defined' : 'progress',
              sub: item.purpose.trim() ? clip(item.purpose, 110) : 'What does it do?', meta: [out.length ? el('span', 'origin-row-note', `→ ${clip(out.join(', '), 40)}`) : null, layerName(item.layerId) ? chip(layerName(item.layerId), 'accent') : null, chip(M.label('componentType', item.type))] };
          }, 'No components yet. Add the main building blocks above.'),
          subhead('Layers', 'Optional. Group components — for example Frontend, Backend, Data — and give each layer its stack and shared rules.'),
          quickAdd('Add a layer — e.g. “Backend”', value => add('layers', BLANK.layers(value)), { id: 'layers' }),
          list('layers', blueprint.layers, item => {
            const members = blueprint.components.filter(component => component.layerId === item.id).length;
            const stack = item.technologyIds.map(id => blueprint.technologies.find(entry => entry.id === id)?.name).filter(Boolean);
            return { title: item.name, fallback: 'Unnamed layer', tone: members ? 'defined' : 'progress', sub: [plural(members, 'component'), stack.length ? clip(stack.join(', '), 60) : 'no stack yet'].join(' · ') };
          }, 'No layers. Components can stay ungrouped.')];
      },
      technology() {
        const blueprint = bp();
        const category = el('select', 'origin-quick-select'); category.setAttribute('aria-label', 'Category');
        for (const [value, name] of M.ENUMS.techCategory) category.append(Object.assign(el('option', '', name), { value }));
        category.value = pref('promptboard.origin.tech-category', 'frameworks');
        category.addEventListener('change', () => setPref('promptboard.origin.tech-category', category.value));
        const nodes = [quickAdd('Add a technology — e.g. “PostgreSQL”', value => add('technologies', { ...BLANK.technologies(value), category: category.value }), { extra: category })];
        const groups = M.ENUMS.techCategory.filter(([id]) => blueprint.technologies.some(item => item.category === id));
        if (!groups.length) nodes.push(el('p', 'origin-empty-note', 'Nothing chosen yet. Add languages, frameworks, databases and services — with the reason for each.'));
        for (const [id, label] of groups) nodes.push(subhead(label), list('technologies', blueprint.technologies.filter(item => item.category === id), item => {
          const state = M.verification(item, blueprint.sources);
          return { title: `${item.name}${item.version ? ` ${item.version}` : ''}`, fallback: 'Unnamed technology', tone: { selected: 'defined', candidate: 'progress', rejected: 'empty' }[item.status],
            sub: item.reason.trim() ? clip(item.reason, 110) : 'Why this one?', meta: [item.status === 'rejected' ? null : chip(M.VERIFICATION_LABELS[state], state === 'verified' ? 'ok' : state === 'unverified' ? 'muted' : 'warn'), chip(M.label('techStatus', item.status), item.status === 'selected' ? 'accent' : '')] };
        }, ''));
        return nodes;
      },
      dependencies() {
        const blueprint = bp();
        const type = el('select', 'origin-quick-select'); type.setAttribute('aria-label', 'Type');
        for (const [value, name] of M.ENUMS.dependencyType) type.append(Object.assign(el('option', '', name), { value }));
        return [quickAdd('Add a dependency — e.g. “Stripe API”', value => add('dependencies', { ...BLANK.dependencies(value), type: type.value }), { extra: type }),
          list('dependencies', blueprint.dependencies, item => {
            const state = M.verification(item, blueprint.sources);
            const users = item.requiredBy.map(id => blueprint.components.find(component => component.id === id)?.name).filter(Boolean);
            return { title: `${item.name}${item.version ? ` ${item.version}` : ''}`, fallback: 'Unnamed dependency', tone: state === 'verified' ? 'defined' : state === 'unverified' ? 'progress' : 'attention',
              sub: users.length ? `Needed by ${clip(users.join(', '), 80)}` : 'Not linked to a component yet', meta: [chip(M.VERIFICATION_LABELS[state], state === 'verified' ? 'ok' : state === 'unverified' ? 'muted' : 'warn'), chip(M.label('dependencyType', item.type))] };
          }, 'No dependencies yet. List packages, services, APIs and tools you rely on.')];
      },
      research() {
        const blueprint = bp();
        return [subhead('Sources', 'Official docs, repositories and standards. Mark one Verified only after you checked it.'),
          quickAdd('Paste a link or name a source…', value => add('sources', BLANK.sources(value)), { id: 'sources', max: 2000 }),
          list('sources', blueprint.sources, item => ({ title: item.title || item.url, fallback: 'Untitled source', tone: { verified: 'defined', unverified: 'progress' }[item.verification] || 'attention',
            sub: [hostOf(item.url), item.claim.trim() && clip(item.claim, 80)].filter(Boolean).join(' · '), meta: [chip(M.label('sourceVerification', item.verification), item.verification === 'verified' ? 'ok' : item.verification === 'unverified' ? 'muted' : 'warn')] }), 'No sources yet.'),
          subhead('Assumptions', 'What you believe but have not confirmed. They stay visible until they hold, fail or become a decision.'),
          quickAdd('Add an assumption — e.g. “Under 5,000 users at launch”', value => add('assumptions', BLANK.assumptions(value)), { id: 'assumptions', max: 2000 }),
          list('assumptions', blueprint.assumptions, item => ({ title: item.statement, fallback: 'Untitled assumption', tone: { open: 'decision', invalid: 'attention' }[item.status] || 'defined',
            sub: item.impact.trim() ? `If wrong: ${clip(item.impact, 90)}` : '', meta: [chip(M.label('assumptionStatus', item.status), item.status === 'open' ? 'warn' : item.status === 'invalid' ? 'muted' : 'ok')] }), 'No assumptions recorded.'),
          subhead('Risks', 'What could go wrong, and how you reduce it.'),
          quickAdd('Add a risk…', value => add('risks', BLANK.risks(value)), { id: 'risks' }),
          list('risks', blueprint.risks, item => ({ title: item.title, fallback: 'Untitled risk', tone: item.status === 'open' ? (item.severity === 'high' ? 'attention' : 'progress') : 'defined',
            sub: item.mitigation.trim() ? clip(item.mitigation, 90) : 'No mitigation yet', meta: [chip(M.label('severity', item.severity), item.severity === 'high' ? 'warn' : 'muted'), item.status === 'open' ? null : chip(M.label('riskStatus', item.status), 'ok')] }), 'No risks recorded.')];
      },
      decisions: () => [quickAdd('Add a decision — e.g. “Database”', value => add('decisions', BLANK.decisions(value), { keyed: true, edit: true })),
        list('decisions', bp().decisions, item => ({ title: item.title, fallback: 'Untitled decision', tone: { proposed: 'decision', accepted: 'defined' }[item.status] || 'empty',
          sub: item.decision.trim() ? `→ ${clip(firstLine(item.decision), 100)}` : 'Not decided yet', meta: [key(item), chip(M.label('decisionStatus', item.status), { accepted: 'ok', proposed: 'warn' }[item.status] || 'muted')] }),
        'No decisions yet. Record what you chose and why, so later work does not undo it.')],
      plan: () => planSection(),
    };
    for (const id of Object.keys(M.AREAS)) SECTIONS[id] = () => areaSection(id);

    /** Brings back a built-in field that was removed: it returns empty, at the end. */
    function restorePicker(label, options, onPick) {
      const pick = el('select', 'origin-quick-select origin-restore'); pick.setAttribute('aria-label', label);
      pick.append(Object.assign(el('option', '', label), { value: '' }), ...options.map(([value, text]) => Object.assign(el('option', '', text), { value })));
      pick.addEventListener('change', () => { if (pick.value) onPick(pick.value); });
      return pick;
    }
    // Planning topics: one question per topic, answered in place.
    function areaSection(id) {
      const blueprint = bp(), topics = M.topicsOf(blueprint, id), items = blueprint.areas.filter(item => item.section === id);
      const answered = new Set(items.filter(item => item.title.trim()).map(item => item.area));
      const nodes = [];
      if (blueprint.sections[id]?.notApplicable) nodes.push(el('p', 'origin-callout', 'Marked as not needed. Anything already written is kept.'));
      const progress = el('p', 'origin-progress'); progress.append(el('strong', '', `${answered.size} of ${topics.length}`),
        id === 'security' ? ' topics answered. This shows which security decisions exist — not how secure the project is.' : ' topics answered. Skip what does not apply.');
      nodes.push(progress);
      const topicList = el('ul', 'origin-topics');
      topics.forEach(([area2, builtin], index) => {
        const row = el('li', 'origin-topic'); row.dataset.area = area2;
        const key = `topic:${id}:${area2}`, label = topicName(id, area2), filled = items.some(item => item.area === area2);
        const name = el('span', 'origin-topic-label'); const dot = el('span', 'origin-dot'); dot.dataset.state = answered.has(area2) ? 'defined' : 'empty'; dot.setAttribute('aria-hidden', 'true');
        name.append(dot, renamable(el('span', '', label), { key, value: label, fallback: builtin, label: `${label} topic`, max: 500, onSave: value => setQuestion(key, value) }),
          itemMenu(`Options for the topic ${label}`, key, [
            ['Move up', () => restructure(() => M.moveTopic(bp(), id, area2, -1)), { disabled: index === 0 }],
            ['Move down', () => restructure(() => M.moveTopic(bp(), id, area2, 1)), { disabled: index === topics.length - 1 }],
            ['Remove topic', () => restructure(() => M.removeTopic(bp(), id, area2), { undo: `Topic “${label}” removed${filled ? ' with its answers' : ''}.` }), { danger: true }]]));
        const answers = el('div', 'origin-answers');
        const own = items.filter(item => item.area === area2);
        for (const item of own.length ? own : [null]) answers.append(answerRow(id, area2, label, item, dot));
        if (own.length) {
          const another = button('＋ Another', () => { const extra = answerRow(id, area2, label, null, dot); answers.insertBefore(extra, another); extra.querySelector('input').focus(); }, 'origin-link origin-another');
          answers.append(another);
        }
        row.append(name, answers);
        topicList.append(row);
      });
      nodes.push(topicList);
      const hidden = M.AREAS[id].filter(([area2]) => !topics.some(([shown]) => shown === area2));
      if (hidden.length) nodes.push(restorePicker('Add a topic back…', hidden, area2 => restructure(() => M.restoreTopic(bp(), id, area2))));
      return nodes;
    }
    function answerRow(id, area2, label, item, dot) {
      const row = el('div', 'origin-answer'); if (item) row.dataset.id = item.id;
      const control = el('input'); control.maxLength = 200; control.value = item?.title || ''; control.placeholder = `Your approach to ${label.toLowerCase()}…`; control.setAttribute('aria-label', `${label}: your approach`);
      let bound = item;
      const more = button('', () => { if (bound) openDrawer('areas', bound.id); }, 'origin-icon origin-small origin-answer-more', 'Details');
      more.setAttribute('aria-label', `Details for ${label}`); more.append(icon(ICON.dots)); more.hidden = !bound;
      control.addEventListener('input', () => {
        if (!bound) {
          if (!control.value.trim()) return;
          bound = { id: newId(), origin: 'human', ...BLANK.areas('', id, area2) };
          bp().areas.push(bound); row.dataset.id = bound.id; more.hidden = false;
        }
        bound.title = control.value;
        dot.dataset.state = bp().areas.some(entry => entry.section === id && entry.area === area2 && entry.title.trim()) ? 'defined' : 'empty';
        changed();
      });
      // An answer cleared back to nothing disappears, unless it carries details.
      control.addEventListener('blur', () => {
        if (!bound || bound.title.trim() || bound.description.trim() || bound.componentIds.length || bound.requirementIds.length || bound.technologyIds.length || bound.baseResourceIds.length) return;
        removeEntity('areas', bound.id); bound = null; delete row.dataset.id; more.hidden = true; changed();
      });
      row.append(control, more);
      return row;
    }

    // ---- The project's own sections and questions ----
    function addSection(phaseId) {
      const id = newId();
      const result = restructure(() => { const added = M.addPage(bp(), { phase: phaseId, id, title: 'New section' }); if (added.ok) { section = id; setPref(SECTION_KEY, id); open = null; } return added; });
      if (!result?.ok) return;
      renderDrawer(); app.closeSidebar();
      main.querySelector('[data-edit="title"]')?.click();
    }
    function customSection(id) {
      const entry = bp().customSections.find(item => item.id === id), nodes = [];
      if (entry.notApplicable) nodes.push(el('p', 'origin-callout', 'Marked as not needed. Anything already written is kept.'));
      const about = el('div', 'origin-q wide'), control = area(entry, 'description', 'What belongs in this section', { max: 2000, label: 'What this section is about' });
      about.append(el('span', 'origin-q-label', 'What is this section about?'), control);
      about.addEventListener('click', event => { if (event.target === about) control.focus(); });
      const remove = button('Delete section', () => removeSectionFlow(id), 'origin-link origin-delete origin-section-delete');
      nodes.push(about, ...questionsBlock(id), ...blocksBlock(id), remove);
      return nodes;
    }
    // Your own questions, answered in place. An answer belongs to its question, so rewording keeps it.
    function questionsBlock(id) {
      const asked = bp().questions.filter(question => question.scope === 'section' && question.sectionId === id), nodes = [];
      if (asked.length) {
        const grid = el('div', 'origin-q-grid origin-own-questions');
        grid.append(...asked.map(question => questionCard(question, bp().answers)));
        nodes.push(subhead(isCustom(id) ? 'Questions' : 'Your questions'), grid);
      }
      nodes.push(button('＋ Add a question', () => addQuestion('section', id), 'origin-link origin-add-question'));
      return nodes;
    }
    function componentQuestions(item) {
      item.answers ||= {};
      const asked = bp().questions.filter(question => question.scope === 'component');
      const box = el('div', 'origin-own-questions');
      if (asked.length) box.append(el('small', 'origin-hint', 'Your questions are asked for every component; each keeps its own answers.'), ...asked.map(question => questionCard(question, item.answers)));
      box.append(button('＋ Add a question for every component', () => addQuestion('component'), 'origin-link origin-add-question'));
      return box;
    }
    function questionCard(question, answers) {
      const box = el('div', 'origin-q wide'); box.dataset.question = question.id;
      const control = area(answers, question.id, 'Your answer', { label: question.text });
      const remove = button('Delete', () => removeQuestion(question, remove), 'origin-link origin-q-remove');
      remove.setAttribute('aria-label', `Delete question: ${question.text}`);
      const head = el('div', 'origin-q-head');
      head.append(renamable(el('span', 'origin-q-label', question.text), { key: `question:${question.id}`, value: question.text, fallback: '', label: 'question', max: 500,
        onSave: value => { if (!value) return; question.text = value; changed({ structure: true, drawer: question.scope === 'component' }); } }), remove);
      if (question.scope === 'section') {
        // A section's own question moves, is copied or becomes a notes block; drag its handle to reorder.
        const own = bp().questions.filter(entry => entry.scope === 'section' && entry.sectionId === question.sectionId), at = own.indexOf(question);
        const grip = dragHandle('Drag to move the question');
        head.prepend(grip);
        head.append(itemMenu(`Options for the question “${question.text}”`, `question:${question.id}`, [
          ['Move up', () => restructure(() => M.moveQuestion(bp(), question.id, { step: -1 })), { disabled: at === 0 }],
          ['Move down', () => restructure(() => M.moveQuestion(bp(), question.id, { step: 1 })), { disabled: at === own.length - 1 }],
          ['Move to section…', () => openMoveTo('question', question.id, question.sectionId)],
          ['Duplicate', () => restructure(() => M.duplicateQuestion(bp(), question.id, newId), { announce: 'Question copied with its answer.' })],
          ['Turn into notes', () => restructure(() => M.questionToNotes(bp(), question.id, newId), { announce: 'The question is now a notes block with its answer.' })]]));
        dragSource(box, 'question', question.id, { handle: grip });
        dropTarget(box, ['question'], (drag, after) => restructure(() => place(bp().questions, drag.id, question.id, after)));
      }
      box.append(head, control);
      box.addEventListener('click', event => { if (event.target === box) control.focus(); });
      return box;
    }
    function addQuestion(scope, sectionId = '') {
      if (bp().questions.length >= M.LIMITS.questions) { app.announce(`A project can have at most ${M.LIMITS.questions} questions of its own.`); return; }
      const question = { id: newId(), origin: 'human', scope, sectionId, text: 'New question' };
      bp().questions.push(question);
      changed({ structure: true, drawer: scope === 'component' });
      view.querySelector(`[data-edit="question:${CSS.escape(question.id)}"]`)?.click();
    }
    // A question with an answer is deleted only after a second, explicit click.
    function removeQuestion(question, control) {
      const blueprint = bp();
      const answered = question.scope === 'section' ? Boolean(blueprint.answers[question.id]?.trim()) : blueprint.components.some(item => item.answers?.[question.id]?.trim());
      if (answered && control.dataset.confirm !== 'true') { control.dataset.confirm = 'true'; control.textContent = question.scope === 'section' ? 'Delete with its answer?' : 'Delete with every answer?'; control.classList.add('danger'); return; }
      blueprint.questions = blueprint.questions.filter(item => item !== question);
      delete blueprint.answers[question.id];
      for (const item of blueprint.components) delete item.answers?.[question.id];
      app.announce('Question deleted.');
      changed({ structure: true, drawer: question.scope === 'component' });
    }
    // A component field whose label is a guiding question the project can reword.
    function ask(item, key, fallback, placeholder = '') {
      const wordKey = `field:components:${key}`, wording = M.questionText(bp(), wordKey, fallback);
      const box = el('div', 'origin-field');
      box.append(renamable(el('span', 'origin-field-label', wording), { key: wordKey, value: wording, fallback, label: 'question', max: 500, onSave: value => setQuestion(wordKey, value, true) }),
        area(item, key, placeholder, { label: wording }));
      return box;
    }

    // ---- Blocks: your own Q&A, tables, checklists, flows and notes on any section page ----
    const blockLabel = type => M.BLOCK_TYPES.find(([id]) => id === type)?.[1] || 'Block';
    const blockFocus = (block, selector) => { focusAfter = () => main.querySelector(`[data-block="${CSS.escape(block.id)}"] ${selector}`); };
    function blocksBlock(id) {
      const own = bp().blocks.filter(block => block.sectionId === id);
      const empty = isCustom(id) && !own.length && !bp().questions.some(question => question.sectionId === id);
      return [...own.map(blockCard), blockPicker(id, { big: empty })];
    }
    // The page's own building blocks: a click adds one below the others.
    function blockPicker(id, { big = false } = {}) {
      const box = el('div', `origin-block-picker${big ? ' big' : ''}`); box.setAttribute('role', 'group'); box.setAttribute('aria-label', 'Add a block');
      box.append(el(big ? 'p' : 'span', 'origin-block-picker-lead', big ? 'Choose what this page holds. Add as many blocks as you need, in any order.' : 'Add a block'));
      const options = el('div', 'origin-block-options');
      for (const [type, label, help] of M.BLOCK_TYPES) {
        const option = button('', () => addBlock(id, type), 'origin-block-option', help);
        option.dataset.type = type; option.setAttribute('aria-label', `Add a ${label} block: ${help}`);
        option.append(icon(BLOCK_ICON[type], big ? 20 : 15), el('span', 'origin-block-option-name', label));
        if (big) option.append(el('span', 'origin-block-option-help', help));
        options.append(option);
      }
      box.append(options);
      return box;
    }
    function addBlock(sectionId, type) {
      if (bp().blocks.length >= M.LIMITS.blocks) { app.announce(`A project can have at most ${M.LIMITS.blocks} blocks.`); return; }
      const block = { id: newId(), origin: 'human', ...M.RECORD_DEFAULTS.blocks('', sectionId, type) };
      if (type === 'qa') block.entries.push({ id: newId(), question: '', answer: '' });
      if (type === 'table') block.columns.push({ id: newId(), name: '' }, { id: newId(), name: '' });
      bp().blocks.push(block);
      blockFocus(block, '.origin-block-title');
      changed({ structure: true });
      app.announce(`${blockLabel(type)} block added.`);
    }
    function blockCard(block) {
      const label = blockLabel(block.type), own = bp().blocks.filter(entry => entry.sectionId === block.sectionId), index = own.indexOf(block);
      const card = el('section', 'origin-block'); card.dataset.block = block.id; card.dataset.type = block.type;
      const head = el('div', 'origin-block-head');
      const kind = el('span', 'origin-block-kind'); kind.append(icon(BLOCK_ICON[block.type], 14), el('span', '', label));
      const title = el('input', 'origin-block-title'); title.value = block.title; title.maxLength = 120; title.placeholder = `Untitled ${label === 'Q&A' ? 'Q&A' : label.toLowerCase()}`;
      title.setAttribute('aria-label', `${label} block title`);
      title.addEventListener('input', () => { block.title = title.value; changed(); });
      card.setAttribute('aria-label', `${label} block${block.title.trim() ? `: ${block.title.trim()}` : ''}`);
      const tools = el('div', 'origin-block-tools');
      const move = (step, name, path) => { const control = button('', () => moveBlock(block, step), 'origin-icon origin-small', name); control.setAttribute('aria-label', `${name}: ${label} block`); control.dataset.move = String(step); control.disabled = !own[index + step]; control.append(icon(path, 14)); return control; };
      const remove = button('Delete', () => removeBlock(block, remove), 'origin-link origin-block-remove'); remove.setAttribute('aria-label', `Delete the ${label} block`);
      // An empty block can change its type; a notes block can become a question with its text.
      const types = M.blockWorked(block) ? [] : M.BLOCK_TYPES.filter(([type]) => type !== block.type);
      const options = itemMenu(`Options for the ${label} block`, `block:${block.id}`, [
        ['Move to section…', () => openMoveTo('block', block.id, block.sectionId)],
        ['Duplicate', () => restructure(() => M.duplicateBlock(bp(), block.id, newId), { announce: 'Block copied with its content.' })],
        ...(block.type === 'notes' ? [['Turn into a question', () => restructure(() => M.notesToQuestion(bp(), block.id, newId), { announce: 'The notes are now a question with its answer.' })]] : []),
        ...types.map(([type, name]) => [`Change to ${name}`, () => restructure(() => {
          const result = M.changeBlockType(bp(), block.id, type);
          if (result.ok && type === 'qa') block.entries.push({ id: newId(), question: '', answer: '' });
          if (result.ok && type === 'table') block.columns.push({ id: newId(), name: '' }, { id: newId(), name: '' });
          return result;
        }, { announce: `Now a ${name} block.` })])]);
      const grip = dragHandle(`Drag to move the ${label} block`);
      tools.append(move(-1, 'Move up', ICON.up), move(1, 'Move down', ICON.down), options, remove);
      head.append(grip, kind, title, ...(block.origin === 'ai' ? [chip('AI suggestion', 'accent')] : []), tools);
      dragSource(card, 'block', block.id, { handle: grip });
      dropTarget(card, ['block'], (drag, after) => restructure(() => place(bp().blocks, drag.id, block.id, after)));
      card.append(head, BLOCK_BODY[block.type](block));
      return card;
    }
    function moveBlock(block, step) {
      const list = bp().blocks, own = list.filter(entry => entry.sectionId === block.sectionId), other = own[own.indexOf(block) + step];
      if (!other) return;
      const a = list.indexOf(block), b = list.indexOf(other); [list[a], list[b]] = [list[b], list[a]];
      focusAfter = () => { const card = main.querySelector(`[data-block="${CSS.escape(block.id)}"]`); return card?.querySelector(`[data-move="${step}"]:enabled`) || card?.querySelector('.origin-block-title'); };
      changed({ structure: true });
    }
    // A block with something written in it is deleted only after a second, explicit click.
    function removeBlock(block, control) {
      if (M.blockWorked(block) && control.dataset.confirm !== 'true') { control.dataset.confirm = 'true'; control.textContent = 'Delete with its content?'; control.classList.add('danger'); return; }
      removeEntity('blocks', block.id); // Also unlinks it from tasks that include it.
      if (flowStep?.block === block.id) flowStep = null;
      if (flowConnect?.block === block.id) flowConnect = null;
      app.announce('Block deleted.');
      changed({ structure: true });
    }
    /** Adds one part (a question, point, row, column or step); focus moves to it. */
    function addPart(block, list, part, { focus = 'input, textarea', limit = M.BLOCK_PARTS[list] } = {}) {
      if (block[list].length >= limit) { app.announce(`A block can hold at most ${limit} of these.`); return null; }
      const entry = { id: newId(), ...part };
      block[list].push(entry);
      if (focus) blockFocus(block, `[data-part="${CSS.escape(entry.id)}"] ${focus}`);
      changed({ structure: true });
      return entry;
    }
    /** Removes one part; a part with content asks for a second click. */
    function partRemove(block, list, entry, name, filled = () => false) {
      const control = button('', () => {
        if (filled() && control.dataset.confirm !== 'true') { control.dataset.confirm = 'true'; control.classList.add('danger'); control.setAttribute('aria-label', `Click again to remove ${name}`); control.title = 'Click again to remove'; return; }
        block[list] = block[list].filter(item => item !== entry);
        if (list === 'nodes') { block.edges = block.edges.filter(edge => edge.from !== entry.id && edge.to !== entry.id); if (flowStep?.node === entry.id) flowStep = null; }
        if (list === 'columns') for (const row of block.rows) delete row.cells[entry.id];
        blockFocus(block, '.origin-block-title');
        changed({ structure: true });
      }, 'origin-icon origin-small origin-block-part-remove', `Remove ${name}`);
      control.setAttribute('aria-label', `Remove ${name}`); control.append(icon(ICON.close, 12));
      return control;
    }
    const BLOCK_BODY = {
      notes: block => { const box = el('div', 'origin-block-body origin-block-notes'); box.append(area(block, 'text', 'Write anything this section needs…', { label: `${block.title.trim() || 'Notes'}: text` })); return box; },
      qa(block) {
        const box = el('div', 'origin-block-body origin-block-qa');
        block.entries.forEach((entry, index) => {
          const row = el('div', 'origin-block-qa-row'); row.dataset.part = entry.id;
          const question = el('input', 'origin-block-question'); question.value = entry.question; question.maxLength = 500; question.placeholder = 'Question';
          question.setAttribute('aria-label', `Question ${index + 1}`);
          question.addEventListener('input', () => { entry.question = question.value; changed(); });
          question.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); row.querySelector('textarea')?.focus(); } });
          const top = el('div', 'origin-block-qa-head'); top.append(question, partRemove(block, 'entries', entry, `question ${index + 1}`, () => Boolean(entry.question.trim() || entry.answer.trim())));
          row.append(top, area(entry, 'answer', 'Answer', { label: `Answer to ${entry.question.trim() || `question ${index + 1}`}` }));
          box.append(row);
        });
        box.append(button('＋ Add a question', () => addPart(block, 'entries', { question: '', answer: '' }, { focus: '.origin-block-question' }), 'origin-link origin-block-add'));
        return box;
      },
      checklist(block) {
        const box = el('div', 'origin-block-body origin-block-checks'), list = el('ul', 'origin-block-check-list');
        block.checks.forEach((entry, index) => {
          const row = el('li', `origin-block-check${entry.done ? ' done' : ''}`); row.dataset.part = entry.id;
          const done = el('input'); done.type = 'checkbox'; done.checked = entry.done; done.setAttribute('aria-label', `Done: ${entry.text.trim() || `point ${index + 1}`}`);
          done.addEventListener('change', () => { entry.done = done.checked; row.classList.toggle('done', entry.done); changed(); });
          const text = el('input', 'origin-block-check-text'); text.value = entry.text; text.maxLength = 1000; text.placeholder = 'A point to check'; text.setAttribute('aria-label', `Point ${index + 1}`);
          text.addEventListener('input', () => { entry.text = text.value; changed(); });
          row.append(done, text, partRemove(block, 'checks', entry, `point ${index + 1}`, () => Boolean(entry.text.trim())));
          list.append(row);
        });
        if (block.checks.length) box.append(list);
        box.append(quickAdd('Add a point to check…', value => addPart(block, 'checks', { text: value, done: false }, { focus: '' }), { id: `checks:${block.id}`, max: 1000 }));
        return box;
      },
      table(block) {
        const box = el('div', 'origin-block-body origin-block-table-box'), scroll = el('div', 'origin-block-table-scroll'), table = el('table', 'origin-block-table');
        const headRow = el('tr');
        block.columns.forEach((column, index) => {
          const cell = el('th'); cell.dataset.part = column.id; cell.scope = 'col';
          const name = el('input', 'origin-block-column'); name.value = column.name; name.maxLength = 80; name.placeholder = `Column ${index + 1}`; name.setAttribute('aria-label', `Column ${index + 1} name`);
          name.addEventListener('input', () => { column.name = name.value; changed(); });
          cell.append(name, partRemove(block, 'columns', column, `column ${column.name.trim() || index + 1}`, () => block.rows.some(row => row.cells[column.id]?.trim())));
          headRow.append(cell);
        });
        const plus = el('th', 'origin-block-table-add'); const addColumn = button('', () => addPart(block, 'columns', { name: '' }, { focus: '.origin-block-column' }), 'origin-icon origin-small', 'Add a column');
        addColumn.setAttribute('aria-label', 'Add a column'); addColumn.disabled = block.columns.length >= M.BLOCK_PARTS.columns; addColumn.append(icon(ICON.plus, 13)); plus.append(addColumn); headRow.append(plus);
        const head = el('thead'); head.append(headRow);
        const body = el('tbody');
        block.rows.forEach((row, index) => {
          const line = el('tr'); line.dataset.part = row.id;
          for (const column of block.columns) {
            const cell = el('td'), text = el('textarea', 'origin-block-cell'); text.rows = 1; text.maxLength = 2000; text.value = row.cells[column.id] || '';
            text.setAttribute('aria-label', `${column.name.trim() || 'Column'}, row ${index + 1}`);
            text.addEventListener('input', () => { if (text.value) row.cells[column.id] = text.value; else delete row.cells[column.id]; changed(); });
            cell.append(autoGrow(text)); line.append(cell);
          }
          const tools = el('td', 'origin-block-row-tools'); tools.append(partRemove(block, 'rows', row, `row ${index + 1}`, () => Object.values(row.cells).some(value => value.trim()))); line.append(tools);
          body.append(line);
        });
        table.append(head, body); scroll.append(table);
        const addRow = button('＋ Add a row', () => addPart(block, 'rows', { cells: {} }, { focus: 'textarea' }), 'origin-link origin-block-add');
        addRow.disabled = !block.columns.length;
        box.append(scroll, addRow);
        return box;
      },
      flow: block => flowEditor(block),
    };
    // A flow: steps you add, joined by arrows. Like the architecture canvas: drag to move, Connect to draw an arrow.
    function flowEditor(block) {
      const ns = 'http://www.w3.org/2000/svg', name = `flow:${block.id}`, connecting = flowConnect?.block === block.id;
      const box = el('div', 'origin-block-body origin-flow-card');
      const tools = el('div', 'origin-canvas-tools');
      const connect = button(connecting ? 'Cancel' : 'Connect', () => { flowConnect = connecting ? null : { block: block.id, from: '' }; flowStep = null; renderMain(); }, `origin-ghost${connecting ? ' active' : ''}`, 'Draw an arrow between two steps');
      connect.dataset.flowConnect = block.id; connect.disabled = block.nodes.length < 2;
      const arrange = button('Arrange', () => { for (const node of block.nodes) { node.x = null; node.y = null; } views[name] = null; changed({ structure: true }); }, 'origin-ghost', 'Lay out the steps by their arrows');
      arrange.disabled = !block.nodes.length;
      tools.append(quickAdd('Add a step — e.g. “Upload a document”', value => { views[name] = null; addPart(block, 'nodes', { label: value, notes: '', x: null, y: null }, { focus: '' }); }, { id: name, max: 120 }), connect, arrange);
      const stepName = id => block.nodes.find(node => node.id === id)?.label.trim() || 'that step';
      const hint = el('p', 'origin-canvas-hint', connecting ? (flowConnect.from ? `Now click the step that ${stepName(flowConnect.from)} leads to · Esc cancels` : 'Click the step the arrow starts from · Esc cancels') : 'Click a step to edit it · drag to move');
      hint.setAttribute('role', 'status');
      box.append(tools, hint);
      const svg = document.createElementNS(ns, 'svg'); svg.classList.add('origin-canvas', 'origin-flow');
      svg.setAttribute('role', 'group'); svg.setAttribute('aria-label', `${block.title.trim() || 'Flow'}: ${plural(block.nodes.length, 'step')}, ${plural(block.edges.length, 'arrow')}`);
      const make = svgMaker(svg), arrowId = `origin-flow-arrow-${block.id}`;
      const marker = make('marker', { id: arrowId, viewBox: '0 0 10 10', refX: 8.5, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, make('defs'));
      make('path', { d: 'M1 1.5L8.5 5L1 8.5', class: 'origin-arrow' }, marker);
      if (!block.nodes.length) {
        svg.setAttribute('viewBox', '0 0 640 150');
        const empty = make('text', { x: 320, y: 70, 'text-anchor': 'middle', class: 'origin-canvas-empty' }); empty.textContent = 'Add the first step above — then the next, and connect them.';
        const sub = make('text', { x: 320, y: 94, 'text-anchor': 'middle', class: 'origin-canvas-empty faint' }); sub.textContent = 'For example: Upload → Split into chunks → Embed → Index';
        box.append(svg); return box;
      }
      const at = positions(block.nodes, block.edges, FLOW_X, FLOW_Y);
      const edges = make('g', { class: 'origin-edges' }), nodes = make('g', { class: 'origin-nodes' });
      const drawEdges = () => {
        edges.replaceChildren();
        for (const edge of block.edges) {
          const a = at.get(edge.from), b = at.get(edge.to);
          if (!a || !b) continue;
          const ac = { x: a.x + FLOW_W / 2, y: a.y + FLOW_H / 2 }, bc = { x: b.x + FLOW_W / 2, y: b.y + FLOW_H / 2 }, dx = bc.x - ac.x, dy = bc.y - ac.y;
          const horizontal = Math.abs(dx) * FLOW_H >= Math.abs(dy) * FLOW_W, s = Math.sign(horizontal ? dx : dy) || 1;
          const p0 = horizontal ? { x: ac.x + s * FLOW_W / 2, y: ac.y } : { x: ac.x, y: ac.y + s * FLOW_H / 2 }, p3 = horizontal ? { x: bc.x - s * (FLOW_W / 2 + 2), y: bc.y } : { x: bc.x, y: bc.y - s * (FLOW_H / 2 + 2) };
          const bend = Math.max(28, Math.abs(horizontal ? dx : dy) / 2.2), p1 = horizontal ? { x: p0.x + s * bend, y: p0.y } : { x: p0.x, y: p0.y + s * bend }, p2 = horizontal ? { x: p3.x - s * bend, y: p3.y } : { x: p3.x, y: p3.y - s * bend };
          const group2 = make('g', { class: `origin-edge${flowStep?.block === block.id && [edge.from, edge.to].includes(flowStep.node) ? ' related' : ''}` }, edges);
          make('path', { d: `M${p0.x} ${p0.y}C${p1.x} ${p1.y} ${p2.x} ${p2.y} ${p3.x} ${p3.y}`, 'marker-end': `url(#${arrowId})` }, group2);
          const words = clip(edge.label, 26);
          if (words) {
            const mx = (p0.x + 3 * p1.x + 3 * p2.x + p3.x) / 8, my = (p0.y + 3 * p1.y + 3 * p2.y + p3.y) / 8, w = words.length * 6.1 + 14;
            make('rect', { x: mx - w / 2, y: my - 10, width: w, height: 20, rx: 10, class: 'origin-edge-pill' }, group2);
            const text = make('text', { x: mx, y: my + 3.8, 'text-anchor': 'middle', class: 'origin-edge-label' }, group2); text.textContent = words;
          }
        }
      };
      const fit = () => {
        const xs = [...at.values()].map(point => point.x), ys = [...at.values()].map(point => point.y);
        let x = Math.min(...xs) - 36, y = Math.min(...ys) - 36, w = Math.max(...xs) - Math.min(...xs) + FLOW_W + 72, h = Math.max(...ys) - Math.min(...ys) + FLOW_H + 72;
        if (w < 640) { x -= (640 - w) / 2; w = 640; }
        if (h < 180) { y -= (180 - h) / 2; h = 180; }
        return { x, y, w, h };
      };
      const keep = () => { for (const node of block.nodes) { const point = at.get(node.id); node.x = point.x; node.y = point.y; } };
      for (const step of block.nodes) {
        const point = at.get(step.id), selected = flowStep?.block === block.id && flowStep.node === step.id;
        const node = make('g', { class: `origin-node origin-flow-node${connecting && flowConnect.from === step.id ? ' connecting' : ''}${selected ? ' selected' : ''}`, transform: `translate(${point.x} ${point.y})`, tabindex: 0, role: 'button', 'data-id': step.id,
          'aria-label': `${step.label.trim() || 'Untitled step'}. Enter edits, arrow keys move.` }, nodes);
        make('rect', { width: FLOW_W, height: FLOW_H, rx: 12, class: 'origin-node-box' }, node);
        make('rect', { x: 10, y: 13, width: 4, height: FLOW_H - 26, rx: 2, class: 'origin-node-accent' }, node);
        const text = make('text', { x: 24, y: FLOW_H / 2 + 5, class: 'origin-node-name' }, node); text.textContent = clip(step.label.trim() || 'Untitled step', 19);
        const tip = make('title', {}, node); tip.textContent = [step.label, step.notes].filter(value => value.trim()).join('\n') || 'Step';
        const activate = () => {
          if (!connecting) { flowStep = selected ? null : { block: block.id, node: step.id }; focusAfter = () => main.querySelector(selected ? `.origin-flow-node[data-id="${CSS.escape(step.id)}"]` : '.origin-flow-editor input'); renderMain(); return; }
          if (!flowConnect.from) { flowConnect = { block: block.id, from: step.id }; focusAfter = () => main.querySelector(`.origin-flow-node[data-id="${CSS.escape(step.id)}"]`); renderMain(); return; }
          if (flowConnect.from === step.id) return;
          const from = flowConnect.from;
          views[name] ||= boxOf(svg);
          flowConnect = null;
          if (block.edges.some(edge => edge.from === from && edge.to === step.id)) { app.announce('These steps are already joined.'); renderMain(); return; }
          if (block.edges.length >= M.BLOCK_PARTS.edges) { app.announce(`A flow can have at most ${M.BLOCK_PARTS.edges} arrows.`); renderMain(); return; }
          block.edges.push({ id: newId(), from, to: step.id, label: '' });
          flowStep = { block: block.id, node: from };
          changed({ structure: true });
          app.announce('Joined. Name the arrow in the step editor if you like.');
        };
        let origin = null;
        draggable(svg, node, {
          start: () => { origin = { ...point }; },
          move: (dx, dy) => { point.x = Math.round(origin.x + dx); point.y = Math.round(origin.y + dy); node.setAttribute('transform', `translate(${point.x} ${point.y})`); drawEdges(); },
          drop: () => { keep(); holdView(name, svg, point.x, point.y, FLOW_W, FLOW_H); changed({ structure: true }); },
          click: activate,
          cancel: renderMain,
        });
        node.addEventListener('keydown', event => {
          const move = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[event.key];
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
          else if (move) {
            event.preventDefault(); keep();
            step.x += move[0]; step.y += move[1]; holdView(name, svg, step.x, step.y, FLOW_W, FLOW_H);
            focusAfter = () => main.querySelector(`.origin-flow-node[data-id="${CSS.escape(step.id)}"]`);
            changed({ structure: true });
          }
        });
      }
      drawEdges();
      tools.append(viewport(svg, name, fit()));
      box.append(svg);
      const step = flowStep?.block === block.id && block.nodes.find(node => node.id === flowStep.node);
      if (step) box.append(stepEditor(block, step));
      return box;
    }
    // The selected step: its name, its details and its arrows.
    function stepEditor(block, step) {
      const box = el('div', 'origin-flow-editor'); box.setAttribute('role', 'group'); box.setAttribute('aria-label', `Step: ${step.label.trim() || 'Untitled step'}`);
      const label = el('input', 'origin-flow-step-name'); label.value = step.label; label.maxLength = 120; label.placeholder = 'Step name'; label.setAttribute('aria-label', 'Step name');
      label.addEventListener('input', () => { step.label = label.value; changed(); });
      const close = button('Done', () => { flowStep = null; focusAfter = () => main.querySelector(`.origin-flow-node[data-id="${CSS.escape(step.id)}"]`); renderMain(); }, 'origin-ghost');
      const top = el('div', 'origin-flow-editor-head'); top.append(label, partRemove(block, 'nodes', step, `step ${step.label.trim() || ''}`.trim(), () => Boolean(step.notes.trim() || block.edges.some(edge => [edge.from, edge.to].includes(step.id)))), close);
      box.append(top, area(step, 'notes', 'Details: inputs, outputs, rules, who does it…', { max: 2000, label: 'Step details' }));
      const arrows = block.edges.filter(edge => edge.from === step.id || edge.to === step.id);
      if (arrows.length) {
        const list = el('ul', 'origin-flow-arrows'); list.setAttribute('aria-label', 'Arrows of this step');
        for (const edge of arrows) {
          const out = edge.from === step.id, other = block.nodes.find(node => node.id === (out ? edge.to : edge.from));
          const row = el('li'); row.dataset.part = edge.id;
          const text = el('input'); text.value = edge.label; text.maxLength = 80; text.placeholder = 'Label (optional)'; text.setAttribute('aria-label', `Label of the arrow ${out ? 'to' : 'from'} ${other?.label.trim() || 'a step'}`);
          text.addEventListener('input', () => { edge.label = text.value; changed(); });
          row.append(el('span', 'origin-flow-arrow-name', `${out ? '→' : '←'} ${other?.label.trim() || 'Untitled step'}`), text, partRemove(block, 'edges', edge, `the arrow ${out ? 'to' : 'from'} ${other?.label.trim() || 'a step'}`));
          list.append(row);
        }
        box.append(list);
      }
      return box;
    }

    // ---- Context included: built on the server from the saved blueprint, shown before anything is sent ----
    const CONTEXT_NAMES = { components: 'Components', layers: 'Layer', technologies: 'Technologies', requirements: 'Requirements', items: 'Starts after', decisions: 'Decisions',
      dependencies: 'Dependencies', areas: 'Planning answers', milestones: 'Milestone', risks: 'Risks', assumptions: 'Assumptions', sources: 'Evidence', customSections: 'Your sections', blocks: 'Your blocks' };
    function contextPreview(item) {
      const box = el('details', 'origin-context'), mine = contextView.itemId === item.id;
      box.open = mine && contextView.open;
      box.append(el('summary', '', 'Context included'));
      box.addEventListener('toggle', () => {
        if (box.open === (contextView.itemId === item.id && contextView.open)) return;
        contextView = { ...contextView, itemId: item.id, open: box.open };
        if (box.open && (!mine || !contextView.data || contextView.revision !== record.revision)) void loadContext(item.id);
      });
      if (!box.open) return box;
      if (contextView.loading) { box.append(el('p', 'origin-hint', 'Building the context from the saved blueprint…')); return box; }
      if (contextView.error) { box.append(el('p', 'origin-inline-error', contextView.error), button('Try again', () => void loadContext(item.id), 'origin-link')); return box; }
      const data = contextView.data;
      if (!data) return box;
      if (contextView.revision !== record.revision || changeCount !== savedCount) {
        const stale = el('p', 'origin-hint'); stale.append('Changed since this preview. ', button('Refresh', () => void loadContext(item.id), 'origin-link')); box.append(stale);
      }
      if (data.tooLarge) box.append(el('p', 'origin-callout warn', data.error));
      if (data.warnings.length) { const list = el('ul', 'origin-context-warnings'); for (const warning of data.warnings) list.append(el('li', '', warning)); box.append(list); }
      const groups = new Map();
      for (const entry of data.included) groups.set(entry.collection, [...(groups.get(entry.collection) || []), entry.name]);
      const names = el('dl', 'origin-context-names');
      for (const [collection, list] of groups) names.append(el('dt', '', CONTEXT_NAMES[collection] || collection), el('dd', '', list.join(', ')));
      box.append(groups.size ? names : el('p', 'origin-hint', 'Only the project’s purpose, scope and constraints. Link components or requirements to add more.'));
      if (data.omitted.length) box.append(el('p', 'origin-hint', `Left out for size: ${data.omitted.join(', ')}.`));
      if (!data.tooLarge) {
        const exact = el('details', 'origin-context-exact'); exact.append(el('summary', '', 'Exact text'), el('pre', 'origin-context-text', data.body));
        box.append(exact);
      }
      return box;
    }
    async function loadContext(itemId) {
      contextView = { ...contextView, itemId, open: true, loading: true, error: '' };
      if (open?.id === itemId) renderDrawer();
      const ready = await flush();
      const { response, data } = ready ? await app.api(`/api/origin/projects/${encodeURIComponent(projectId)}/context`, { method: 'POST', body: { expectedRevision: record.revision, itemIds: [itemId] }, timeoutMs: 30000 })
        .catch(() => ({ response: { ok: false }, data: {} })) : { response: { ok: false }, data: { error: 'Save the blueprint first, then open the context again.' } };
      if (contextView.itemId !== itemId) return;
      contextView = response.ok ? { ...contextView, loading: false, revision: data.revision, data: data.tasks[0], error: '' }
        : { ...contextView, loading: false, data: null, error: typeof data.error === 'string' ? data.error : 'The context could not be built.' };
      if (open?.id === itemId) renderDrawer();
    }
    // Links beyond the task's own components and requirements; nothing else is guessed.
    function contextLinks(item) {
      item.contextIds ||= [];
      const blueprint = bp(), box = el('div', 'origin-links');
      const nameOf = ({ collection, id }) => {
        if (collection === 'customSections') return M.sectionTitle(blueprint, id);
        if (collection === 'areas') { const area = blueprint.areas.find(entry => entry.id === id); return area ? `${topicName(area.section, area.area)}: ${area.title}` : ''; }
        return M.itemName(blueprint, collection, id);
      };
      for (const ref of item.contextIds) {
        const name = nameOf(ref) || 'Removed record';
        const tag = el('span', 'origin-chip origin-link-chip'); tag.append(el('span', '', name));
        const remove = button('', () => { item.contextIds = item.contextIds.filter(entry => entry !== ref); changed({ drawer: true }); }, 'origin-chip-x');
        remove.setAttribute('aria-label', `Unlink ${name}`); remove.dataset.focusKey = 'context:add'; remove.append(icon(ICON.close, 12));
        tag.append(remove); box.append(tag);
      }
      if (item.contextIds.length >= 100) return box;
      const pick = el('select', 'origin-link-add'); pick.setAttribute('aria-label', 'Also include'); pick.dataset.focusKey = 'context:add';
      pick.append(Object.assign(el('option', '', item.contextIds.length ? '＋ Add' : '＋ Link…'), { value: '' }));
      const taken = new Set(item.contextIds.map(ref => `${ref.collection}:${ref.id}`));
      for (const collection of M.CONTEXT_COLLECTIONS) {
        const records = collection === 'areas' ? blueprint.areas.filter(entry => entry.title.trim()) : collection === 'technologies' ? blueprint.technologies.filter(entry => entry.status !== 'rejected') : blueprint[collection];
        const options = records.filter(entry => !taken.has(`${collection}:${entry.id}`));
        if (!options.length) continue;
        const group2 = el('optgroup'); group2.label = CONTEXT_NAMES[collection];
        group2.append(...options.map(entry => Object.assign(el('option', '', nameOf({ collection, id: entry.id }) || 'Untitled'), { value: `${collection}:${entry.id}` })));
        pick.append(group2);
      }
      pick.addEventListener('change', () => {
        if (!pick.value) return;
        const [collection, id] = [pick.value.slice(0, pick.value.indexOf(':')), pick.value.slice(pick.value.indexOf(':') + 1)];
        item.contextIds = [...item.contextIds, { collection, id }]; changed({ drawer: true });
      });
      box.append(pick);
      return box;
    }

    // ---- Tasks: grouped by layer and component, or one list. Kanban owns execution. ----
    // The handoff state stays visible even on a phone.
    function handoffChip(item, cards) {
      if (!item.handoff) return chip('Draft', 'muted state');
      const card = cards.get(item.handoff.taskId);
      if (!card) return chip('Card removed', 'warn');
      return chip(`Kanban${card.task.number ? ` #${card.task.number}` : ''} · ${card.column}`, card.done ? 'ok state' : 'state');
    }
    function taskRow(cards, { where = false } = {}) {
      const blueprint = bp();
      return item => {
        const home = M.taskHome(blueprint, item), checks = M.lines(item.acceptanceCriteria).length;
        const after = item.dependsOn.map(id => blueprint.items.find(entry => entry.id === id)?.key).filter(Boolean);
        const place = where ? (home.componentId ? blueprint.components.find(entry => entry.id === home.componentId)?.name : blueprint.layers.find(entry => entry.id === home.layerId)?.name) || 'Project-wide' : '';
        return { title: item.title, fallback: 'Untitled task', tone: item.lostLinks?.length ? 'attention' : checks ? 'defined' : 'progress',
          sub: [place, clip(firstLine(item.description), 90), after.length && `after ${after.join(', ')}`, checks ? `done when: ${plural(checks, 'check')}` : 'No “done when” yet'].filter(Boolean).join(' · '),
          meta: [key(item), handoffChip(item, cards), item.refinement?.proposal && !item.refinement.acceptedAt ? chip('Proposal to review', 'accent') : item.refinement?.acceptedAt ? chip('Refined', 'muted') : null, item.lostLinks?.length ? chip('Link missing', 'warn') : null,
            contextStatus.revision === record.revision && contextStatus.map.get(item.id)?.status === 'changed' ? chip('Context changed', 'warn') : null] };
      };
    }
    function lostNotes(item) {
      return (item.lostLinks || []).map((lost, index) => {
        const note = el('div', 'origin-callout warn origin-lost');
        note.append(el('span', '', `Its component “${lost.name}” was removed.`));
        const others = bp().components.filter(component => !item.componentIds.includes(component.id));
        const dismiss = () => { item.lostLinks.splice(index, 1); changed({ structure: true, drawer: true }); };
        if (others.length) {
          const pick = el('select', 'origin-link-add'); pick.setAttribute('aria-label', `Relink instead of ${lost.name}`); pick.dataset.focusKey = `lost:${index}`;
          pick.append(Object.assign(el('option', '', 'Relink to…'), { value: '' }), ...others.map(component => Object.assign(el('option', '', component.name || 'Unnamed component'), { value: component.id })));
          pick.addEventListener('change', () => { if (!pick.value) return; item.componentIds = [...item.componentIds, pick.value]; dismiss(); });
          note.append(pick);
        }
        note.append(button('Dismiss', dismiss, 'origin-link'));
        return note;
      });
    }
    // Reordering moves a task past its neighbour in the list you are looking at.
    function moveTask(item, step) {
      const blueprint = bp(), home = M.taskHome(blueprint, item);
      const peers = taskView === 'all' ? blueprint.items.filter(taskShown) : blueprint.items.filter(entry => { const other = M.taskHome(blueprint, entry); return other.componentId === home.componentId && other.layerId === home.layerId && taskShown(entry); });
      const neighbour = peers[peers.indexOf(item) + step];
      if (!neighbour) return;
      const a = blueprint.items.indexOf(item), b = blueprint.items.indexOf(neighbour);
      [blueprint.items[a], blueprint.items[b]] = [blueprint.items[b], blueprint.items[a]];
      focusAfter = () => main.querySelector(`.origin-row[data-id="${CSS.escape(item.id)}"] .origin-row-open`);
      changed({ structure: true, drawer: true });
      app.announce(`${item.key} moved ${step < 0 ? 'up' : 'down'}.`);
    }
    const taskShown = item => !taskMilestone || (taskMilestone === 'none' ? !item.milestoneId : item.milestoneId === taskMilestone);
    function newTask(title, extra = {}) {
      return add('items', { ...BLANK.items(title), milestoneId: taskMilestone && taskMilestone !== 'none' ? taskMilestone : '', ...extra }, { keyed: true });
    }
    // The component editor lists its tasks; adding one there links the component, and the layer follows from it.
    function componentTasks(component) {
      const box = el('div', 'origin-component-tasks'), cards = kanbanCards();
      for (const item of bp().items.filter(entry => entry.componentIds.includes(component.id))) {
        const row = button('', () => openDrawer('items', item.id), 'origin-mini-row'); row.dataset.focusKey = `task:${item.id}`;
        row.append(el('span', 'origin-key', item.key), el('span', 'origin-mini-title', item.title.trim() || 'Untitled task'), handoffChip(item, cards));
        box.append(row);
      }
      const form = el('form', 'origin-mini-add'), control = el('input', 'origin-mini-input');
      control.placeholder = 'Add a task for this component…'; control.maxLength = 200; control.setAttribute('aria-label', `Add a task for ${component.name || 'this component'}`); control.dataset.focusKey = 'task:add';
      form.append(icon(ICON.plus, 14), control);
      form.addEventListener('submit', event => {
        event.preventDefault();
        const value = control.value.trim(); if (!value) return;
        newTask(value, { componentIds: [component.id] });
        renderDrawer({ restore: false });
        drawer.querySelector('[data-focus-key="task:add"]')?.focus();
      });
      box.append(form);
      return box;
    }
    function planSection() {
      const blueprint = bp(), cards = kanbanCards(), nodes = [];
      if (contextStatus.revision !== record.revision) void refreshContextStatus();
      if (lastHandoff) { const done = el('p', 'origin-callout ok', lastHandoff); done.setAttribute('role', 'status'); done.append(' ', button('Open Kanban', () => app.openKanban(project()?.kanbanProjectId), 'origin-link')); nodes.push(done); }
      if (taskMilestone && taskMilestone !== 'none' && !blueprint.milestones.some(entry => entry.id === taskMilestone)) taskMilestone = '';
      const leading = item => {
        const box = el('input', 'origin-check'); box.type = 'checkbox'; box.checked = planSelection.has(item.id); box.setAttribute('aria-label', `Select ${item.key}`);
        box.addEventListener('change', () => {
          if (box.checked) planSelection.add(item.id); else planSelection.delete(item.id);
          focusAfter = () => main.querySelector(`.origin-row[data-id="${CSS.escape(item.id)}"] .origin-check`); renderMain();
        });
        return box;
      };
      const tools = el('div', 'origin-task-tools');
      const toggle = el('div', 'origin-toggle'); toggle.setAttribute('role', 'group'); toggle.setAttribute('aria-label', 'Show tasks');
      for (const [id, label] of [['layers', 'By layer'], ['all', 'All tasks']]) {
        const option = button(label, () => { taskView = id; setPref(TASK_VIEW_KEY, id); focusAfter = () => main.querySelector(`.origin-toggle-option[data-view="${id}"]`); renderMain(); }, 'origin-toggle-option');
        option.dataset.view = id; option.setAttribute('aria-pressed', String(taskView === id)); toggle.append(option);
      }
      const filter = el('select', 'origin-quick-select'); filter.id = 'origin-task-milestone'; filter.setAttribute('aria-label', 'Milestone');
      for (const [value, name] of [['', 'All milestones'], ...blueprint.milestones.map(entry => [entry.id, entry.title || 'Untitled milestone']), ['none', 'Unscheduled']]) filter.append(Object.assign(el('option', '', name), { value }));
      filter.value = taskMilestone;
      filter.addEventListener('change', () => { taskMilestone = filter.value; focusAfter = () => main.querySelector('#origin-task-milestone'); renderMain(); });
      tools.append(toggle, filter);
      nodes.push(tools);
      const row = taskRow(cards, { where: taskView === 'all' });
      const rows = (items, empty = '') => (items.length ? [list('items', items, row, '', { leading })] : empty ? [el('p', 'origin-empty-note', empty)] : []);
      const visible = blueprint.items.filter(taskShown);
      if (taskView === 'all') {
        nodes.push(quickAdd('Add a task — e.g. “Set up continuous integration”', value => newTask(value), { id: 'items-project' }),
          ...rows(visible, blueprint.items.length ? 'No tasks in this milestone.' : 'No tasks yet. Add one here, or from a component’s editor in Architecture.'));
      } else {
        const homes = new Map(blueprint.items.map(item => [item.id, M.taskHome(blueprint, item)]));
        const at = (componentId, layerId) => visible.filter(item => homes.get(item.id).componentId === componentId && homes.get(item.id).layerId === layerId);
        const taskGroup = (title, lead, ...children) => { const box = el('section', 'origin-task-group'); const head = el('div', 'origin-task-group-head'); head.append(title); if (lead) head.append(lead); box.append(head, ...children); return box; };
        const suggest = (scope, label) => { const control = button('Suggest tasks', () => openSuggest(scope), 'origin-link origin-suggest', `Ask your CLI to propose tasks for ${label}. Nothing is added until you choose.`); return control; };
        const projectLead = el('p', '', 'Tasks that belong to no single component or layer. '); projectLead.append(suggest({}, 'the project’s requirements'));
        nodes.push(taskGroup(el('h3', '', 'Project-wide'), projectLead,
          ...rows(at('', '')), quickAdd('Add a project-wide task — e.g. “Set up continuous integration”', value => newTask(value), { id: 'items-project' })));
        const componentBlock = component => {
          const box = el('div', 'origin-task-component'); box.dataset.component = component.id;
          const name = button(component.name || 'Unnamed component', () => openDrawer('components', component.id), 'origin-task-component-name', 'Open this component');
          const head = el('div', 'origin-task-component-head'); head.append(name, suggest({ componentId: component.id }, component.name || 'this component'));
          box.append(head, ...rows(at(component.id, component.layerId || '')),
            quickAdd(`Add a task for ${clip(component.name || 'this component', 40)}…`, value => newTask(value, { componentIds: [component.id] }), { id: `items-c-${component.id}` }));
          return box;
        };
        for (const layer of blueprint.layers) {
          const stack = layer.technologyIds.map(id => blueprint.technologies.find(entry => entry.id === id)).filter(Boolean);
          const title = button(layer.name || 'Unnamed layer', () => openDrawer('layers', layer.id), 'origin-task-layer-name', 'Open this layer');
          const lead = el('p'); lead.append(...(stack.length ? stack.map(entry => chip(`${entry.name}${entry.status === 'candidate' ? ' (candidate)' : ''}`, entry.status === 'selected' ? 'accent' : 'muted')) : [el('span', '', 'No stack chosen yet.')]),
            suggest({ layerId: layer.id }, `the ${layer.name || 'unnamed'} layer`));
          nodes.push(taskGroup(title, lead, ...blueprint.components.filter(component => component.layerId === layer.id).map(componentBlock),
            el('h4', 'origin-task-sub', 'Whole layer'), ...rows(at('', layer.id)),
            quickAdd(`Add a task for the whole ${clip(layer.name || 'layer', 30)} layer…`, value => newTask(value, { layerId: layer.id }), { id: `items-l-${layer.id}` })));
        }
        const loose = blueprint.components.filter(component => !component.layerId);
        if (loose.length) nodes.push(taskGroup(el('h3', '', blueprint.layers.length ? 'Components without a layer' : 'Components'), blueprint.layers.length ? null : el('p', '', 'Add layers in Architecture to group components — optional.'), ...loose.map(componentBlock)));
      }
      // Milestones stay available as stages and as the filter above.
      nodes.push(subhead('Milestones', 'Optional stages. Choose one in a task’s details, then filter by it above.'),
        quickAdd('Add a milestone — e.g. “Foundation”', value => add('milestones', BLANK.milestones(value)), { id: 'milestones' }),
        list('milestones', blueprint.milestones, item => {
          const count = blueprint.items.filter(entry => entry.milestoneId === item.id).length;
          return { title: item.title, fallback: 'Untitled milestone', tone: count ? 'defined' : 'progress', sub: [clip(item.goal, 100), plural(count, 'task')].filter(Boolean).join(' · ') };
        }, 'No milestones. They are optional.'));
      if (blueprint.items.length) {
        const count = [...planSelection].filter(id => blueprint.items.some(item => item.id === id)).length, bar = el('div', 'origin-selection');
        const send = button(count ? `Send ${plural(count, 'task')} to Kanban` : 'Send to Kanban', () => openHandoff(), 'origin-primary', 'Create To Do cards for the selected tasks. No agent starts.');
        send.id = 'origin-kanban-handoff'; send.disabled = !count || handoffBusy;
        bar.append(el('span', 'origin-selection-text', count ? `${plural(count, 'task')} selected` : 'Select tasks to send them to Kanban'),
          Object.assign(button('Select all drafts', () => { planSelection = new Set(visible.filter(item => !item.handoff).map(item => item.id)); focusAfter = () => main.querySelector('#origin-select-drafts'); renderMain(); }, 'origin-link'), { id: 'origin-select-drafts' }),
          count ? button('Clear', () => { planSelection = new Set(); focusAfter = () => main.querySelector('#origin-select-drafts'); renderMain(); }, 'origin-link') : '',
          count ? Object.assign(button('Improve with Compose', () => openImprove([...planSelection]), 'origin-ghost', 'Get a Compose proposal for each selected task. Optional.'), { id: 'origin-improve' }) : '',
          count ? composeSelection([...planSelection].filter(id => blueprint.items.some(item => item.id === id))) : '', send);
        nodes.push(bar);
      }
      return nodes;
    }

    // ---- Overview: the blueprint as a mind map ----
    function leaves(id) {
      const blueprint = bp(), own = blueprint.blocks.filter(block => block.sectionId === id && M.blockWorked(block))
        .map(block => ({ label: `${M.BLOCK_TYPES.find(([type]) => type === block.type)[1]}: ${block.title.trim() || 'Untitled'}`, target: { collection: 'blocks', id: block.id } }));
      return [...builtinLeaves(id), ...own];
    }
    function builtinLeaves(id) {
      const blueprint = bp(), entry = (collection, item, label) => ({ label, target: { collection, id: item.id } });
      switch (id) {
        case 'vision': return [['problem', 'Problem'], ['goal', 'Goal'], ['users', 'For'], ['inScope', 'Scope'], ['successCriteria', 'Success']].filter(([name]) => blueprint.vision[name].trim())
          .map(([name, label]) => ({ label: `${label}: ${firstLine(blueprint.vision[name])}`, target: { section: 'vision' } }));
        case 'requirements': return blueprint.requirements.map(item => entry('requirements', item, item.title || 'Untitled requirement'));
        case 'architecture': return blueprint.components.map(item => entry('components', item, item.name || 'Unnamed component'));
        case 'technology': return blueprint.technologies.filter(item => item.status !== 'rejected').map(item => entry('technologies', item, `${item.name || 'Unnamed'}${item.version ? ` ${item.version}` : ''}`));
        case 'dependencies': return blueprint.dependencies.map(item => entry('dependencies', item, item.name || 'Unnamed dependency'));
        case 'research': return [...blueprint.sources.map(item => entry('sources', item, item.title || hostOf(item.url) || 'Source')),
          ...blueprint.assumptions.filter(item => item.status === 'open').map(item => entry('assumptions', item, `Assumes ${item.statement}`)),
          ...blueprint.risks.filter(item => item.status === 'open').map(item => entry('risks', item, `Risk: ${item.title || 'untitled'}`))];
        case 'decisions': return blueprint.decisions.map(item => entry('decisions', item, item.decision.trim() ? `${item.title || 'Decision'} → ${firstLine(item.decision)}` : `${item.title || 'Decision'} ?`));
        case 'plan': return blueprint.items.map(item => entry('items', item, item.title || 'Untitled task'));
        default: {
          if (M.AREAS[id]) return blueprint.areas.filter(item => item.section === id && item.title.trim()).map(item => entry('areas', item, `${topicName(id, item.area)}: ${item.title}`));
          const answers = blueprint.questions.filter(question => question.sectionId === id && blueprint.answers[question.id]?.trim())
            .map(question => ({ label: firstLine(blueprint.answers[question.id]), target: { section: id } }));
          const about = blueprint.customSections.find(item => item.id === id)?.description.trim();
          return answers.length || !about ? answers : [{ label: firstLine(about), target: { section: id } }];
        }
      }
    }
    // ---- Pan and zoom: one view box per diagram, kept while you work and reset per project ----
    function boxOf(svg) { const [x, y, w, h] = (svg.getAttribute('viewBox') || '0 0 1 1').split(/\s+/).map(Number); return { x, y, w, h }; }
    // After a move the view stays where it is, growing only as far as needed to keep the moved block visible.
    function holdView(name, svg, x, y, w, h, pad = 40) {
      const box = views[name] || boxOf(svg), x1 = Math.min(box.x, x - pad), y1 = Math.min(box.y, y - pad);
      views[name] = { x: x1, y: y1, w: Math.max(box.x + box.w, x + w + pad) - x1, h: Math.max(box.y + box.h, y + h + pad) - y1 };
    }
    function viewport(svg, name, fitBox, middle = null) {
      const apply = box => svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
      const current = () => views[name] || fitBox;
      const zoom = (factor, at) => {
        const box = current(), c = at || { x: box.x + box.w / 2, y: box.y + box.h / 2 };
        const w = Math.min(Math.max(box.w * factor, fitBox.w / 5), fitBox.w * 4), k = w / box.w;
        views[name] = { x: c.x - (c.x - box.x) * k, y: c.y - (c.y - box.y) * k, w, h: box.h * k };
        apply(views[name]);
      };
      apply(current());
      // On a narrow screen the whole map would be unreadably small, so it starts at a readable size around the middle.
      requestAnimationFrame(() => {
        if (views[name] || !svg.isConnected || !svg.clientWidth || svg.clientWidth / fitBox.w >= 0.55) return;
        const w = svg.clientWidth / 0.6, h = (svg.clientHeight || svg.clientWidth) / 0.6, c = middle || { x: fitBox.x + fitBox.w / 2, y: fitBox.y + fitBox.h / 2 };
        views[name] = { x: c.x - w / 2, y: c.y - h / 2, w, h }; apply(views[name]);
      });
      // Dragging the empty background pans. Ctrl or ⌘ with the wheel, or a trackpad pinch, zooms.
      let pan = null;
      svg.addEventListener('pointerdown', event => {
        if (event.button !== 0 || event.target !== svg) return;
        const ctm = svg.getScreenCTM(); if (!ctm) return;
        pan = { id: event.pointerId, x: event.clientX, y: event.clientY, box: { ...current() }, k: 1 / ctm.a };
        svg.setPointerCapture?.(event.pointerId); svg.classList.add('panning');
      });
      svg.addEventListener('pointermove', event => {
        if (!pan || event.pointerId !== pan.id) return;
        views[name] = { ...pan.box, x: pan.box.x - (event.clientX - pan.x) * pan.k, y: pan.box.y - (event.clientY - pan.y) * pan.k };
        apply(views[name]);
      });
      const stop = () => { pan = null; svg.classList.remove('panning'); };
      svg.addEventListener('pointerup', stop); svg.addEventListener('pointercancel', stop);
      svg.addEventListener('wheel', event => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        const matrix = svg.getScreenCTM()?.inverse();
        zoom(event.deltaY > 0 ? 1.12 : 1 / 1.12, matrix ? new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix) : null);
      }, { passive: false });
      const tool = (label, path, run) => { const control = button('', run, 'origin-icon origin-small', label); control.setAttribute('aria-label', label); control.append(icon(path, 15)); return control; };
      const tools = el('div', 'origin-view-tools'); tools.setAttribute('role', 'group'); tools.setAttribute('aria-label', 'View');
      tools.append(tool('Zoom out', ICON.minus, () => zoom(1.25)), tool('Zoom in', ICON.plus, () => zoom(0.8)), tool('Fit to view', ICON.fit, () => { views[name] = null; apply(fitBox); }));
      return tools;
    }

    function mindMap() {
      const blueprint = bp(), ns = 'http://www.w3.org/2000/svg', states = M.sectionStates(blueprint), layout = blueprint.layout.map;
      const SECTION_W = 176, SECTION_H = 40, SX = 300, LEAF_H = 27, GAP = 16, MAX = 4, LEAF_W = 196, CENTER_W = 300, STEP = 20;
      const wrap = el('section', `origin-map-card${layout.height ? ' sized' : ''}`); wrap.setAttribute('aria-label', 'Project map');
      if (layout.width) wrap.style.width = `${layout.width}px`;
      if (layout.height) wrap.style.height = `${layout.height}px`;
      const svg = document.createElementNS(ns, 'svg'); svg.classList.add('origin-map'); svg.setAttribute('role', 'group');
      svg.setAttribute('aria-label', 'Project map: click a branch to open it, drag or use arrow keys to move it');
      const make = svgMaker(svg);
      // Names are cut to the room in their shape, measured in the map's own fonts (.origin-map-label, -count and -title).
      const ruler = document.createElement('canvas').getContext('2d'), sans = getComputedStyle(document.documentElement).getPropertyValue('--sans');
      const textWidth = (text, font) => { ruler.font = `${font} ${sans}`; return ruler.measureText(text).width; };
      const fitText = (text, room, font) => { let value = text.trim(); if (textWidth(value, font) <= room) return value; while (value && textWidth(`${value}…`, font) > room) value = value.slice(0, -1); return `${value.trimEnd()}…`; };
      const decor = make('g', { class: 'origin-map-decor' }), links = make('g', { class: 'origin-map-links' }), nodes = make('g');
      const curve = (x1, y1, x2, y2, bend) => `M${x1} ${y1}C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`;
      const named = id => (id === 'center' ? project()?.name || 'Project' : sectionName(id));
      // Center: the project itself.
      const summary = blueprint.vision.summary.trim() || blueprint.idea.trim();
      const words = summary.split(/\s+/).filter(Boolean), lines = [];
      for (const word of words) { if (!lines.length || `${lines.at(-1)} ${word}`.length > 38) lines.push(word); else lines[lines.length - 1] += ` ${word}`; if (lines.length > 3) break; }
      if (lines.length > 3) { lines.length = 3; lines[2] = `${lines[2].slice(0, 36)}…`; }
      const centerH = 64 + Math.max(lines.length, 1) * 20;
      // Branches stacked on both sides, in the project's own order: the first half of its sections on the left,
      // the rest on the right. A moved node keeps its own place.
      const pages = phases().flatMap(phase => phase.sections), left = pages.slice(0, Math.ceil(pages.length / 2)), right = pages.slice(left.length);
      const blocks = [], defaults = { center: { x: 0, y: 0 } };
      for (const [side, ids] of [[-1, left], [1, right]]) {
        const list = ids.map(id => { const all = leaves(id), shown = all.slice(0, MAX); return { id, shown, extra: all.length - shown.length, rows: Math.max(1, shown.length + (all.length > MAX ? 1 : 0)) }; });
        let y = -(list.reduce((sum, block) => sum + block.rows * LEAF_H, 0) + GAP * (list.length - 1)) / 2;
        for (const block of list) { defaults[block.id] = { x: side * SX, y: y + block.rows * LEAF_H / 2 }; blocks.push(block); y += block.rows * LEAF_H + GAP; }
      }
      const live = {};
      const pos = id => live[id] || layout.nodes[id] || defaults[id];
      const sideOf = id => (pos(id).x < pos('center').x ? -1 : 1);
      const centerLinks = new Map();
      const linkPath = id => {
        const c = pos('center'), p = pos(id), side = sideOf(id);
        return curve(c.x + side * CENTER_W / 2, c.y + Math.max(-centerH / 2 + 14, Math.min(centerH / 2 - 14, (p.y - c.y) * 0.16)), p.x - side * SECTION_W / 2, p.y, side * 70);
      };
      // Decorative links are only a picture: they never mean a dependency or a build order.
      const drawDecor = () => {
        decor.replaceChildren();
        for (const link of layout.links) {
          const a = pos(link.from), b = pos(link.to);
          if (!a || !b) continue;
          const group = make('g', { class: `origin-map-deco${selectedLink === link.id ? ' selected' : ''}`, tabindex: 0, role: 'button', 'data-link': link.id,
            'aria-label': `Link from ${named(link.from)} to ${named(link.to)}${link.label ? `: ${link.label}` : ''}. Enter edits.` }, decor);
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 - Math.abs(b.x - a.x) * 0.12;
          make('path', { d: `M${a.x} ${a.y}Q${mx} ${my} ${b.x} ${b.y}`, class: 'origin-map-deco-line' }, group);
          make('path', { d: `M${a.x} ${a.y}Q${mx} ${my} ${b.x} ${b.y}`, class: 'origin-map-deco-hit' }, group);
          if (link.label) {
            const text = clip(link.label, 26), w = text.length * 6.6 + 16, lx = (a.x + 2 * mx + b.x) / 4, ly = (a.y + 2 * my + b.y) / 4;
            make('rect', { x: lx - w / 2, y: ly - 11, width: w, height: 22, rx: 11, class: 'origin-map-deco-pill' }, group);
            const label = make('text', { x: lx, y: ly + 4.5, 'text-anchor': 'middle', class: 'origin-map-deco-label' }, group); label.textContent = text;
          }
          const choose = () => { selectedLink = selectedLink === link.id ? null : link.id; focusAfter = () => main.querySelector(selectedLink ? '#origin-map-link-label' : `[data-link="${CSS.escape(link.id)}"]`); renderMain(); };
          group.addEventListener('click', choose);
          group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); } });
        }
      };
      // Clicking opens; dragging (or arrow keys) moves. In link mode, clicks pick the two ends instead.
      const activate = (id, openIt) => {
        if (mapLinkFrom === null) { openIt(); return; }
        if (!mapLinkFrom) { mapLinkFrom = id; focusAfter = () => main.querySelector(`[data-node="${CSS.escape(id)}"]`); renderMain(); return; }
        if (mapLinkFrom === id) return;
        if (layout.links.length >= 300) { app.announce('A map can have at most 300 links.'); return; }
        const link = { id: newId(), from: mapLinkFrom, to: id, label: '' };
        layout.links.push(link); mapLinkFrom = null; selectedLink = link.id;
        views.map ||= boxOf(svg);
        focusAfter = () => main.querySelector('#origin-map-link-label');
        changed({ structure: true });
        app.announce('Linked. Add a label if you like; map links are only a picture.');
      };
      const movable = (node, id, label, openIt) => {
        node.dataset.node = id; node.setAttribute('tabindex', '0'); node.setAttribute('role', 'button');
        node.setAttribute('aria-label', `${label}. Enter opens, arrow keys move.`);
        if (mapLinkFrom === id) node.classList.add('linking');
        const keep = (place, focus) => {
          const half = id === 'center' ? [CENTER_W / 2, centerH / 2] : [SECTION_W / 2, SECTION_H / 2];
          holdView('map', svg, place.x - half[0], place.y - half[1], half[0] * 2, half[1] * 2);
          layout.nodes[id] = { x: Math.round(place.x), y: Math.round(place.y) };
          if (focus) focusAfter = () => main.querySelector(`[data-node="${CSS.escape(id)}"]`);
          changed({ structure: true });
        };
        let origin = null;
        draggable(svg, node, {
          start: () => { origin = { ...pos(id) }; },
          move: (dx, dy) => {
            live[id] = { x: origin.x + dx, y: origin.y + dy };
            (node.closest('.origin-map-branch') || node).setAttribute('transform', `translate(${dx} ${dy})`);
            for (const [other, path] of centerLinks) if (id === 'center' || other === id) path.setAttribute('d', linkPath(other));
            drawDecor();
          },
          drop: () => keep(live[id], false),
          click: () => activate(id, openIt),
          cancel: () => { delete live[id]; renderMain(); },
        });
        node.addEventListener('click', event => { if (event.detail === 0) activate(id, openIt); });
        node.addEventListener('keydown', event => {
          const step = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] }[event.key];
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(id, openIt); }
          else if (step) { event.preventDefault(); const place = pos(id); keep({ x: place.x + step[0], y: place.y + step[1] }, true); }
        });
      };
      const clickable = (node, label, action) => {
        node.setAttribute('tabindex', '0'); node.setAttribute('role', 'button'); node.setAttribute('aria-label', label);
        node.addEventListener('click', action);
        node.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); action(); } });
      };
      const center = pos('center');
      const bounds = { x1: center.x - CENTER_W / 2, x2: center.x + CENTER_W / 2, y1: center.y - centerH / 2, y2: center.y + centerH / 2 };
      const grow = (x1, y1, x2, y2) => { bounds.x1 = Math.min(bounds.x1, x1); bounds.x2 = Math.max(bounds.x2, x2); bounds.y1 = Math.min(bounds.y1, y1); bounds.y2 = Math.max(bounds.y2, y2); };
      for (const block of blocks) {
        const p = pos(block.id), side = sideOf(block.id), phase = toneOf(block.id), state = states[block.id];
        const outer = p.x + side * SECTION_W / 2, top = p.y - block.rows * LEAF_H / 2;
        const path = make('path', { d: linkPath(block.id), class: `origin-map-link phase-${phase}${state === 'empty' || state === 'na' ? ' faint' : ''}` }, links);
        centerLinks.set(block.id, path);
        const branch = make('g', { class: 'origin-map-branch' }, nodes);
        const node = make('g', { class: `origin-map-section phase-${phase} state-${state}`, transform: `translate(${p.x - SECTION_W / 2} ${p.y - SECTION_H / 2})` }, branch);
        make('rect', { width: SECTION_W, height: SECTION_H, rx: SECTION_H / 2 }, node);
        make('circle', { cx: 20, cy: SECTION_H / 2, r: 4.5, class: 'origin-map-dot' }, node);
        const count = block.id === 'vision' ? 0 : sectionCount(block.id);
        const label = make('text', { x: 36, y: SECTION_H / 2 + 5, class: 'origin-map-label' }, node); label.textContent = fitText(sectionName(block.id), SECTION_W - 52 - (count ? textWidth(String(count), '600 13px') + 10 : 0), '600 15px');
        if (count) { const number = make('text', { x: SECTION_W - 18, y: SECTION_H / 2 + 4.5, 'text-anchor': 'end', class: 'origin-map-count' }, node); number.textContent = String(count); }
        movable(node, block.id, `${sectionName(block.id)}: ${M.SECTION_STATE[state][1]}${count ? `, ${count}` : ''}`, () => openSection(block.id));
        grow(p.x - SECTION_W / 2, p.y - SECTION_H / 2, p.x + SECTION_W / 2, p.y + SECTION_H / 2);
        block.shown.forEach((leaf, index) => {
          const ly = top + index * LEAF_H + LEAF_H / 2, lx = outer + side * 34;
          make('path', { d: curve(outer, p.y, lx, ly, side * 16), class: `origin-map-link leaf phase-${phase}` }, branch);
          const group2 = make('g', { class: `origin-map-leaf phase-${phase}`, transform: `translate(${lx} ${ly})` }, branch);
          make('circle', { r: 2.6, class: 'origin-map-dot' }, group2);
          const text = make('text', { x: side * 10, y: 5, 'text-anchor': side < 0 ? 'end' : 'start' }, group2); text.textContent = clip(leaf.label, 26);
          const tip = make('title', {}, group2); tip.textContent = leaf.label;
          clickable(group2, leaf.label, () => focusTarget(leaf.target));
          grow(Math.min(lx, lx + side * LEAF_W), ly - LEAF_H / 2, Math.max(lx, lx + side * LEAF_W), ly + LEAF_H / 2);
        });
        if (block.extra > 0) {
          const ly = top + block.shown.length * LEAF_H + LEAF_H / 2;
          const more = make('text', { x: outer + side * 43, y: ly + 4, 'text-anchor': side < 0 ? 'end' : 'start', class: 'origin-map-more' }, branch); more.textContent = `+${block.extra} more`;
          clickable(more, `${block.extra} more in ${sectionName(block.id)}`, () => openSection(block.id));
        }
      }
      const centerNode = make('g', { class: `origin-map-center${mapLinkFrom === 'center' ? ' linking' : ''}`, transform: `translate(${center.x - CENTER_W / 2} ${center.y - centerH / 2})` }, make('g', { class: 'origin-map-branch' }, nodes));
      make('rect', { width: CENTER_W, height: centerH, rx: 20 }, centerNode);
      const name = make('text', { x: CENTER_W / 2, y: 38, 'text-anchor': 'middle', class: 'origin-map-title' }, centerNode); name.textContent = fitText(project()?.name || 'Project', CENTER_W - 32, '700 21px');
      lines.forEach((line, index) => { const text = make('text', { x: CENTER_W / 2, y: 64 + index * 20, 'text-anchor': 'middle', class: 'origin-map-summary' }, centerNode); text.textContent = line; });
      // The idea is written on the Vision section; without one, the center shows the project's description only.
      const describable = M.hasPage(blueprint, 'vision');
      if (!lines.length && describable) { const text = make('text', { x: CENTER_W / 2, y: 64, 'text-anchor': 'middle', class: 'origin-map-summary faint' }, centerNode); text.textContent = 'Click to describe the idea'; }
      // The name includes the text shown on the node, so voice control can activate it by what it says.
      movable(centerNode, 'center', describable ? `${[clip(project()?.name || 'Project', 30), ...(lines.length ? lines : ['Click to describe the idea'])].join(' ')}. Open ${sectionName('vision')}` : [clip(project()?.name || 'Project', 30), ...lines].join(' '),
        () => { if (describable) openSection('vision'); });
      drawDecor();
      // The whole map fits by default; zoom and pan are kept until Fit.
      // A map with few branches keeps a readable size instead of zooming its center up.
      const pad = 44, fitW = Math.max(bounds.x2 - bounds.x1 + 2 * pad, 820), fitH = Math.max(bounds.y2 - bounds.y1 + 2 * pad, 400);
      const fitBox = { x: (bounds.x1 + bounds.x2 - fitW) / 2, y: (bounds.y1 + bounds.y2 - fitH) / 2, w: fitW, h: fitH };
      if (!layout.height) svg.style.setProperty('--map-ratio', String(fitBox.w / fitBox.h));

      const tools = el('div', 'origin-map-tools');
      const linkMode = button(mapLinkFrom === null ? 'Link' : 'Cancel', () => { mapLinkFrom = mapLinkFrom === null ? '' : null; selectedLink = null; renderMain(); },
        `origin-ghost origin-small-button${mapLinkFrom === null ? '' : ' active'}`, 'Draw a link between two branches. Links are only a picture, never a dependency.');
      linkMode.id = 'origin-map-link';
      const moved = Object.keys(layout.nodes).length > 0;
      const arrange = button('Arrange', () => {
        if (arrange.dataset.confirm !== 'true') { arrange.dataset.confirm = 'true'; arrange.textContent = 'Reset the layout?'; arrange.classList.add('danger'); return; }
        layout.nodes = {}; views.map = null; changed({ structure: true }); app.announce('Map arranged. Your links are kept.');
      }, 'origin-ghost origin-small-button', 'Put every branch back in its built-in place');
      arrange.id = 'origin-map-arrange'; arrange.disabled = !moved;
      const status = el('p', 'origin-map-hint', mapLinkFrom === null ? 'Click a branch to open it · drag to move' : mapLinkFrom ? `Now click what ${named(mapLinkFrom)} links to · Esc cancels` : 'Click where the link starts · Esc cancels');
      status.setAttribute('role', 'status');
      tools.append(status, linkMode, arrange, viewport(svg, 'map', fitBox, center));
      const link = selectedLink && layout.links.find(entry => entry.id === selectedLink);
      if (selectedLink && !link) selectedLink = null;
      const editor = link ? linkEditor(link, named) : null;
      // A visible corner handle resizes the map; arrow keys resize it too, and Home goes back to automatic.
      const grip = button('', null, 'origin-map-resize', 'Drag to resize the map · arrow keys resize · Home resets');
      grip.id = 'origin-map-resize'; grip.setAttribute('aria-label', 'Resize map'); grip.append(icon(ICON.grip, 14));
      // On a phone the map always uses the full width, so only its height changes there.
      const setSize = (width, height) => {
        if (matchMedia('(max-width: 730px)').matches && height !== null) width = layout.width;
        layout.width = width === null ? null : Math.max(480, Math.min(4000, Math.round(width)));
        layout.height = height === null ? null : Math.max(320, Math.min(4000, Math.round(height)));
        focusAfter = () => main.querySelector('#origin-map-resize');
        changed({ structure: true });
      };
      let sizing = null;
      grip.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        const rect = wrap.getBoundingClientRect();
        sizing = { id: event.pointerId, x: event.clientX, y: event.clientY, width: rect.width, height: rect.height, moved: false };
        grip.setPointerCapture?.(event.pointerId); event.preventDefault();
      });
      grip.addEventListener('pointermove', event => {
        if (!sizing || event.pointerId !== sizing.id) return;
        sizing.moved = true;
        wrap.style.width = `${Math.max(480, sizing.width + event.clientX - sizing.x)}px`;
        wrap.style.height = `${Math.max(320, sizing.height + event.clientY - sizing.y)}px`;
        wrap.classList.add('sized');
      });
      // The size comes from where the pointer is released: the last move event may have been coalesced away.
      grip.addEventListener('pointerup', event => {
        if (!sizing || event.pointerId !== sizing.id) return;
        const done = sizing; sizing = null;
        if (!done.moved && event.clientX === done.x && event.clientY === done.y) return;
        // The size you asked for is saved; a small screen only caps how much of it shows.
        setSize(done.width + event.clientX - done.x, done.height + event.clientY - done.y);
      });
      grip.addEventListener('pointercancel', () => { sizing = null; renderMain(); });
      grip.addEventListener('keydown', event => {
        const rect = wrap.getBoundingClientRect(), width = layout.width ?? rect.width, height = layout.height ?? rect.height;
        const step = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] }[event.key];
        if (step) { event.preventDefault(); setSize(width + step[0], height + step[1]); }
        else if (event.key === 'Home') { event.preventDefault(); setSize(null, null); }
      });
      wrap.append(tools, ...(editor ? [editor] : []), svg, grip);
      return wrap;
    }
    function linkEditor(link, named) {
      const bar = el('div', 'origin-map-link-editor');
      const label = el('input'); label.id = 'origin-map-link-label'; label.maxLength = 80; label.value = link.label; label.placeholder = 'Label (optional)';
      label.setAttribute('aria-label', `Label for the link from ${named(link.from)} to ${named(link.to)}`);
      label.addEventListener('input', () => { link.label = label.value; changed(); });
      label.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); selectedLink = null; renderMain(); } });
      const remove = button('Remove link', () => {
        bp().layout.map.links = bp().layout.map.links.filter(entry => entry !== link); selectedLink = null;
        changed({ structure: true }); app.announce('Link removed.');
      }, 'origin-link danger');
      bar.append(el('span', 'origin-map-link-ends', `${named(link.from)} → ${named(link.to)}`), label, remove, button('Done', () => { selectedLink = null; renderMain(); }, 'origin-link'));
      return bar;
    }
    function overviewPanels() {
      const blueprint = bp(), found = M.issues(blueprint), ready = M.readiness(blueprint, found);
      const steps = [...found.filter(issue => issue.blocking), ...found.filter(issue => !issue.blocking && issue.origin === 'system')].slice(0, 6);
      const box = el('div', 'origin-panels');
      const next = el('section', 'origin-panel'); next.append(el('h3', '', 'Next steps'));
      if (steps.length) {
        const ol = el('ol', 'origin-steps');
        for (const issue of steps) {
          const li = el('li'); const go = button('', () => focusTarget(issue.target), `origin-step${issue.blocking ? '' : ' advisory'}`);
          const dot = el('span', 'origin-dot'); dot.dataset.state = issue.kind === 'unresolved' ? 'decision' : issue.blocking ? 'attention' : 'empty'; dot.setAttribute('aria-hidden', 'true');
          go.append(dot, el('span', 'origin-step-text', issue.title), el('span', 'origin-step-where', sectionName(issue.target?.collection ? sectionOf(issue.target) || issue.target.section : issue.target?.section)), icon(ICON.arrow, 14));
          go.title = `${{ system: 'Detected', human: 'Recorded by you', ai: 'AI suggestion' }[issue.origin]}${issue.action ? ` · ${issue.action}` : ''}`;
          li.append(go); ol.append(li);
        }
        next.append(ol);
      } else next.append(el('p', 'origin-empty-note', ready.state === 'not_started' ? 'Describe the idea to begin.' : 'Nothing blocking. Prepare tasks, then send them to Kanban.'));
      const glance = el('section', 'origin-panel'); glance.append(el('h3', '', 'At a glance'));
      const state = el('p', `origin-state state-${ready.state}`); state.append(el('span', 'origin-pill-dot'), ready.label); glance.append(state);
      if (ready.state === 'attention') glance.append(el('p', 'origin-hint', ready.reasons.join(' ')));
      const stats = el('dl', 'origin-stats');
      for (const row of ready.rows) { const term = el('dt'); term.append(button(row.label, () => openSection(row.section), 'origin-link')); stats.append(term, el('dd', '', row.value)); }
      glance.append(stats, el('p', 'origin-hint', 'Counts come from what you wrote. Origin never scores quality.'));
      box.append(next, glance);
      return box;
    }

    // ---- Architecture canvas: a view over components and connections ----
    // Placed items keep their place; the others are laid out in columns by how far along the arrows they are.
    function positions(items, links, gapX = GAP_X, gapY = GAP_Y) {
      const map = new Map(), level = new Map(items.map(item => [item.id, 0]));
      for (let pass = 0; pass < items.length; pass++) {
        let moved = false;
        for (const link of links) if (level.get(link.to) <= level.get(link.from) && level.get(link.from) < items.length) { level.set(link.to, level.get(link.from) + 1); moved = true; }
        if (!moved) break;
      }
      const rows = new Map();
      for (const item of items) {
        if (item.x !== null && item.y !== null) { map.set(item.id, { x: item.x, y: item.y }); continue; }
        const column = level.get(item.id), row = rows.get(column) || 0; rows.set(column, row + 1);
        map.set(item.id, { x: column * gapX, y: row * gapY });
      }
      return map;
    }
    function canvas() {
      const blueprint = bp(), ns = 'http://www.w3.org/2000/svg';
      const wrap = el('section', 'origin-canvas-card'); wrap.setAttribute('aria-label', 'Architecture diagram');
      const type = el('select', 'origin-quick-select'); type.setAttribute('aria-label', 'Type');
      for (const [value, name] of M.ENUMS.componentType) type.append(Object.assign(el('option', '', name), { value }));
      const tools = el('div', 'origin-canvas-tools');
      const connect = button(connectFrom === null ? 'Connect' : 'Cancel', () => { connectFrom = connectFrom === null ? '' : null; renderMain(); }, `origin-ghost${connectFrom === null ? '' : ' active'}`, 'Draw a connection between two blocks');
      connect.id = 'origin-connect'; connect.disabled = blueprint.components.length < 2;
      const arrange = button('Arrange', () => { for (const item of bp().components) { item.x = null; item.y = null; } views.canvas = null; changed({ structure: true }); }, 'origin-ghost', 'Lay out blocks by how they depend on each other');
      arrange.disabled = !blueprint.components.length;
      tools.append(quickAdd('Add a building block — e.g. “Web app”', value => { views.canvas = null; add('components', { ...BLANK.components(value), type: type.value }); }, { id: 'components', extra: type }), connect, arrange);
      const named = id => blueprint.components.find(item => item.id === id)?.name || 'it';
      const hint = el('p', 'origin-canvas-hint', connectFrom === null ? 'Click a block to describe it · drag to move' : connectFrom ? `Now click the block that ${named(connectFrom)} connects to · Esc cancels` : 'Click the block the connection starts from · Esc cancels');
      hint.setAttribute('role', 'status');
      wrap.append(tools, hint);
      const svg = document.createElementNS(ns, 'svg'); svg.classList.add('origin-canvas');
      svg.setAttribute('role', 'group'); svg.setAttribute('aria-label', `Architecture: ${plural(blueprint.components.length, 'component')}, ${plural(blueprint.connections.length, 'connection')}`);
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      const make = svgMaker(svg);
      const marker = make('marker', { id: 'origin-arrow', viewBox: '0 0 10 10', refX: 8.5, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, make('defs'));
      make('path', { d: 'M1 1.5L8.5 5L1 8.5', class: 'origin-arrow' }, marker);
      if (!blueprint.components.length) {
        svg.setAttribute('viewBox', '0 0 640 200');
        const empty = make('text', { x: 320, y: 96, 'text-anchor': 'middle', class: 'origin-canvas-empty' }); empty.textContent = 'Add the main building blocks above — then connect them.';
        const sub = make('text', { x: 320, y: 120, 'text-anchor': 'middle', class: 'origin-canvas-empty faint' }); sub.textContent = 'For example: Web app → API → Database';
        wrap.append(svg); return wrap;
      }
      const at = positions(blueprint.components, blueprint.connections);
      const edges = make('g', { class: 'origin-edges' }), nodes = make('g', { class: 'origin-nodes' });
      const drawEdges = () => {
        edges.replaceChildren();
        for (const connection of blueprint.connections) {
          const a = at.get(connection.from), b = at.get(connection.to);
          if (!a || !b) continue;
          const ac = { x: a.x + NODE_W / 2, y: a.y + NODE_H / 2 }, bc = { x: b.x + NODE_W / 2, y: b.y + NODE_H / 2 };
          const dx = bc.x - ac.x, dy = bc.y - ac.y, horizontal = Math.abs(dx) * NODE_H >= Math.abs(dy) * NODE_W;
          const reverse = blueprint.connections.some(other => other.from === connection.to && other.to === connection.from) ? (connection.from < connection.to ? 7 : -7) : 0;
          let p0, p3, p1, p2;
          if (horizontal) {
            const s = Math.sign(dx) || 1, bend = Math.max(36, Math.abs(dx) / 2.2);
            p0 = { x: ac.x + s * NODE_W / 2, y: ac.y + reverse }; p3 = { x: bc.x - s * (NODE_W / 2 + 2), y: bc.y + reverse };
            p1 = { x: p0.x + s * bend, y: p0.y }; p2 = { x: p3.x - s * bend, y: p3.y };
          } else {
            const s = Math.sign(dy) || 1, bend = Math.max(28, Math.abs(dy) / 2.2);
            p0 = { x: ac.x + reverse, y: ac.y + s * NODE_H / 2 }; p3 = { x: bc.x + reverse, y: bc.y - s * (NODE_H / 2 + 2) };
            p1 = { x: p0.x, y: p0.y + s * bend }; p2 = { x: p3.x, y: p3.y - s * bend };
          }
          const group2 = make('g', { class: `origin-edge${open?.id === connection.from ? ' related' : ''}` }, edges);
          make('path', { d: `M${p0.x} ${p0.y}C${p1.x} ${p1.y} ${p2.x} ${p2.y} ${p3.x} ${p3.y}`, 'marker-end': 'url(#origin-arrow)' }, group2);
          const words = clip([connection.label, connection.protocol].filter(Boolean).join(' · '), 28);
          if (words) {
            const mx = (p0.x + 3 * p1.x + 3 * p2.x + p3.x) / 8, my = (p0.y + 3 * p1.y + 3 * p2.y + p3.y) / 8, w = words.length * 6.1 + 14;
            make('rect', { x: mx - w / 2, y: my - 10, width: w, height: 20, rx: 10, class: 'origin-edge-pill' }, group2);
            const label = make('text', { x: mx, y: my + 3.8, 'text-anchor': 'middle', class: 'origin-edge-label' }, group2); label.textContent = words;
          }
        }
      };
      const fitBox = () => {
        const xs = [...at.values()].map(point => point.x), ys = [...at.values()].map(point => point.y);
        let minX = Math.min(...xs) - 48, minY = Math.min(...ys) - 48, width = Math.max(...xs) - Math.min(...xs) + NODE_W + 96, height = Math.max(...ys) - Math.min(...ys) + NODE_H + 96;
        if (width < 680) { minX -= (680 - width) / 2; width = 680; }
        if (height < 260) { minY -= (260 - height) / 2; height = 260; }
        return { x: minX, y: minY, w: width, h: height };
      };
      const flagged = new Map(M.issues(blueprint).filter(issue => issue.target?.collection === 'components').map(issue => [issue.target.id, issue.kind]));
      for (const component of blueprint.components) {
        const point = at.get(component.id);
        const node = make('g', { class: `origin-node${connectFrom === component.id ? ' connecting' : ''}${flagged.has(component.id) ? ' attention' : ''}`, transform: `translate(${point.x} ${point.y})`, tabindex: 0, role: 'button', 'data-id': component.id,
          'aria-label': `${component.name || 'Unnamed component'}, ${M.label('componentType', component.type)}. Enter edits, arrow keys move.` }, nodes);
        make('rect', { width: NODE_W, height: NODE_H, rx: 14, class: 'origin-node-box' }, node);
        make('rect', { x: 12, y: 16, width: 4, height: NODE_H - 32, rx: 2, class: 'origin-node-accent' }, node);
        const kind = make('text', { x: 26, y: 23, class: 'origin-node-type' }, node); kind.textContent = M.label('componentType', component.type).toUpperCase();
        const name = make('text', { x: 26, y: 42, class: 'origin-node-name' }, node); name.textContent = clip(component.name || 'Unnamed component', 20);
        if (flagged.has(component.id)) make('circle', { cx: NODE_W - 14, cy: 14, r: 4, class: `origin-node-flag ${flagged.get(component.id)}` }, node);
        const tip = make('title', {}, node); tip.textContent = component.purpose || component.name || 'Component';
        const activate = () => {
          if (connectFrom === null) { openDrawer('components', component.id); return; }
          if (!connectFrom) { connectFrom = component.id; focusAfter = () => main.querySelector(`.origin-node[data-id="${CSS.escape(component.id)}"]`); renderMain(); return; }
          if (connectFrom === component.id) return;
          const from = connectFrom;
          views.canvas ||= boxOf(svg);
          if (bp().connections.some(entry => entry.from === from && entry.to === component.id)) app.announce('These components are already connected.');
          else bp().connections.push({ id: newId(), origin: 'human', from, to: component.id, label: 'calls', protocol: '', notes: '' });
          connectFrom = null;
          changed({ structure: true });
          openDrawer('components', from);
          app.announce('Connected. Name how they talk in the editor.');
        };
        let origin = null;
        draggable(svg, node, {
          start: () => { origin = { ...point }; },
          move: (dx, dy) => { point.x = Math.round(origin.x + dx); point.y = Math.round(origin.y + dy); node.setAttribute('transform', `translate(${point.x} ${point.y})`); drawEdges(); },
          drop: () => {
            for (const [id, value] of at) { const entry = bp().components.find(item => item.id === id); if (entry) { entry.x = value.x; entry.y = value.y; } }
            holdView('canvas', svg, point.x, point.y, NODE_W, NODE_H);
            changed({ structure: true });
          },
          click: activate,
          cancel: renderMain,
        });
        node.addEventListener('keydown', event => {
          const step = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[event.key];
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
          else if (step) {
            event.preventDefault();
            for (const [id, value] of at) { const entry = bp().components.find(item => item.id === id); if (entry) { entry.x = value.x; entry.y = value.y; } }
            component.x += step[0]; component.y += step[1]; holdView('canvas', svg, component.x, component.y, NODE_W, NODE_H);
            focusAfter = () => main.querySelector(`.origin-node[data-id="${CSS.escape(component.id)}"]`);
            changed({ structure: true });
          }
        });
      }
      drawEdges();
      tools.append(viewport(svg, 'canvas', fitBox()));
      wrap.append(svg);
      return wrap;
    }

    // ---- Handoffs ----
    /** Fills Compose with what `prepare()` returns. Unsaved Compose text is replaced only after a second click. */
    function composeControl(label, title, message, prepare, announcement) {
      const control = button(label, async () => {
        const spec = await prepare(); if (!spec) return;
        let result = app.toCompose(spec);
        if (result === 'draft') {
          if (control.dataset.confirm !== 'true') {
            control.dataset.confirm = 'true'; control.textContent = 'Replace Compose draft?'; control.classList.add('danger');
            message.textContent = 'Compose already has unsaved text. Click again to replace it, or copy that text first.'; message.hidden = false;
            return;
          }
          result = app.toCompose({ ...spec, replace: true });
        }
        if (result === 'busy') { message.textContent = 'Compose is generating a prompt. Wait for it or cancel it, then try again.'; message.hidden = false; return; }
        app.announce(announcement(spec));
      }, 'origin-ghost origin-compose', title);
      control.prepend(icon(ICON.arrow, 14));
      return control;
    }
    function composeButton(collection, id, message) {
      return composeControl('Send to Compose', 'Fill Compose with just this item and what it links to. Nothing is generated.', message, async () => {
        const found = M.composeSpec(bp(), collection, id, project()?.name || '');
        if (!found) return null;
        // The link lets a prompt saved from Compose remember this record (Origin → Compose → project).
        const spec = { ...found, link: { kind: 'origin', originId: projectId, collection, id, name: M.itemName(bp(), collection, id) } };
        await flush();
        return spec;
      }, spec => `Opened ${spec.title} in Compose. Review the prompt, then choose Generate. Nothing was generated.`);
    }
    // ---- Later design changes: sent tasks whose context changed, checked against the saved design ----
    let contextStatus = { revision: -1, loading: false, map: new Map() };
    async function refreshContextStatus() {
      if (contextStatus.loading || !record?.exists || changeCount !== savedCount || !bp().items.some(item => item.handoff)) return;
      const revision = record.revision;
      contextStatus = { ...contextStatus, loading: true };
      const { response, data } = await app.api(`/api/origin/projects/${encodeURIComponent(projectId)}/context-status`, { method: 'POST', body: { expectedRevision: revision }, timeoutMs: 30000 })
        .catch(() => ({ response: { ok: false }, data: {} }));
      contextStatus = response.ok && record?.revision === revision ? { revision, loading: false, map: new Map(data.tasks.map(task => [task.itemId, task])) } : { ...contextStatus, loading: false, revision };
      if (section === 'plan') refreshMain();
      if (open?.collection === 'items') renderDrawer();
    }
    function sentPanel(item, message) {
      const status = contextStatus.map.get(item.id);
      if (!item.handoff || !status || contextStatus.revision !== record.revision || status.status !== 'changed') return null;
      const box = el('div', 'origin-callout warn origin-changed');
      box.append(el('p', 'origin-proposal-title', `Context changed since it was sent to Kanban #${status.cardNumber}`));
      const changes = [...status.added.map(name => `Added: ${name}`), ...status.removed.map(name => `No longer included: ${name}`)];
      if (changes.length) { const list = el('ul', 'origin-context-warnings'); for (const line of changes) list.append(el('li', '', line)); box.append(list); }
      const compare = el('details', 'origin-context-exact');
      const grid = el('div', 'origin-compare');
      const side = (title, text) => { const column = el('div'); column.append(el('p', 'origin-field-label', title), el('pre', 'origin-context-text', text || 'Not available for this card.')); return column; };
      grid.append(side('Sent', status.sent), side('Now', status.now));
      compare.append(el('summary', '', 'Compare'), grid);
      const update = button('Update context', async () => {
        if (status.edited && update.dataset.confirm !== 'true') {
          update.dataset.confirm = 'true'; update.textContent = status.engineered ? 'Replace the Compose Batch prompt?' : 'Replace the edited card prompt?'; update.classList.add('danger');
          message.textContent = status.engineered ? 'The card carries a prompt approved in Compose Batch. Compare first; replacing it discards that prompt.' : 'The card’s prompt was edited in Kanban. Compare first; replacing it discards that edit.'; message.hidden = false; return;
        }
        update.disabled = true;
        const { response, data } = await app.api(`/api/origin/projects/${encodeURIComponent(projectId)}/update-context`, { method: 'POST', timeoutMs: 30000,
          body: { expectedRevision: record.revision, itemId: item.id, expectedHash: status.hash, expectedCardRevision: status.cardRevision, replaceEdited: update.dataset.confirm === 'true' } })
          .catch(() => ({ response: { ok: false }, data: { error: 'The app did not answer. Nothing was changed.' } }));
        if (!response.ok) { message.textContent = typeof data.error === 'string' ? data.error : 'The card could not be updated.'; message.hidden = false; update.disabled = false; contextStatus.revision = -1; void refreshContextStatus(); return; }
        const saved = data.blueprint.items.find(entry => entry.id === item.id);
        if (saved) item.handoff = saved.handoff;
        record.revision = data.revision; hideUndo();
        await app.ensureBoard();
        app.announce(`Kanban #${status.cardNumber} now has the current context. It stays in To Do; nothing started.`);
        contextStatus.revision = -1; void refreshContextStatus();
      }, 'origin-primary', status.idle ? 'Replace the card’s prompt with the current context. The card stays idle in To Do.' : 'Stop its work and move the card back to To Do first.');
      update.disabled = !status.idle || status.splitPart;
      if (status.splitPart) update.title = 'This card is one part of a task split in Compose Batch. Regenerate the task there.';
      const keep = button('Keep current', () => { item.handoff.keptHash = status.hash; changed({ structure: true, drawer: true }); app.announce('Kept the card as it is. It is flagged again only if the context changes further.'); }, 'origin-link');
      const actions = el('div', 'origin-inline-actions'); actions.append(update, improveButton(item, message, 'Improve again'), keep);
      box.append(...(status.idle ? [] : [el('p', 'origin-hint', 'The card is no longer idle in To Do. Stop its work and move it back to update it.')]), compare, actions);
      return box;
    }

    // ---- Compose refinement: optional, one task to one proposal; nothing changes until you accept ----
    const basisOf = item => JSON.stringify([item.title, item.description, item.acceptanceCriteria]).slice(0, 100000);
    async function taskBodyFor(itemId) {
      if (!(await flush())) return { error: 'Save the blueprint first, then try again.' };
      const { response, data } = await app.api(`/api/origin/projects/${encodeURIComponent(projectId)}/context`, { method: 'POST', body: { expectedRevision: record.revision, itemIds: [itemId] }, timeoutMs: 30000 })
        .catch(() => ({ response: { ok: false }, data: {} }));
      if (!response.ok) return { error: typeof data.error === 'string' ? data.error : 'The task context could not be built.' };
      const built = data.tasks[0];
      return built.tooLarge ? { error: built.error } : { body: built.body };
    }
    function improveButton(item, message, label = 'Improve with Compose') {
      return composeControl(label, 'Refine the instruction in Compose with this task’s context. You review the result before it changes anything.', message, async () => {
        const prepared = await taskBodyFor(item.id);
        if (prepared.error) { message.textContent = prepared.error; message.hidden = false; return null; }
        return { text: prepared.body, task: 'feature', origin: { originId: projectId, itemId: item.id, key: item.key, title: item.title, basis: basisOf(item) } };
      }, () => `Opened ${item.key} in Compose with its context. Choose Generate there, then Use in Origin task. Nothing was generated yet.`);
    }
    /**
     * Send to Compose from the selection: one task opens in Compose (Single) with its context, as Improve does;
     * several join this project's Compose Batch once each, in build order. Nothing is generated or sent.
     */
    function composeSelection(ids) {
      const message = el('span', 'origin-hint'); message.hidden = true; message.setAttribute('role', 'status');
      const item = ids.length === 1 ? bp().items.find(entry => entry.id === ids[0]) : null;
      const control = item ? improveButton(item, message, 'Send to Compose') : button(`Send ${plural(ids.length, 'task')} to Compose`, async () => {
        control.disabled = true;
        try {
          if (!(await flush())) { showError('Save the blueprint first, then try again.'); return; }
          const result = await app.toBatch({ originId: projectId, expectedRevision: record.revision, itemIds: ids });
          if (!result.ok) { showError(result.error); return; }
          app.announce(`${plural(result.added, 'task')} added to Compose Batch${result.existing ? `; ${plural(result.existing, 'task')} already there` : ''}. Nothing runs until you choose Run.`);
        } finally { control.disabled = false; }
      }, 'origin-ghost origin-compose', 'Engineer a prompt for each selected task in Compose Batch, review them, then send the approved ones to Kanban. Nothing runs until you choose Run.');
      if (!item) control.prepend(icon(ICON.arrow, 14));
      control.id = 'origin-send-compose';
      const wrap = el('span', 'origin-compose-send'); wrap.append(control, message);
      return wrap;
    }
    /** Compose hands a result back: it becomes a proposal on the same task, to accept, edit or reject. */
    async function receiveProposal({ originId, itemId, text, basis }) {
      if (originId !== projectId) {
        if (!projects.length) await refreshProjects();
        if (!projects.some(entry => entry.id === originId)) return 'That Origin project no longer exists.';
        const problem = projectId ? await unsaved() : '';
        if (problem) { showError(problem); return problem; }
        setPref(PROJECT_KEY, originId); await load(originId);
      }
      const item = record?.exists ? bp().items.find(entry => entry.id === itemId) : null;
      if (!item) return 'That Origin task no longer exists.';
      item.refinement = { proposal: String(text).slice(0, 100000), proposedAt: Date.now(), basis: basis ?? basisOf(item), originalDescription: '', acceptedAt: null, kept: keptRefinement(item) };
      section = 'plan'; setPref(SECTION_KEY, section);
      changed({ structure: true });
      openDrawer('items', item.id);
      return 'ok';
    }
    // A new proposal keeps the accepted one it replaces (one level), so Reject and Restore the original still work.
    const keptRefinement = item => (item.refinement?.acceptedAt ? { ...item.refinement, kept: null } : item.refinement?.kept || null);
    function proposalPanel(item) {
      const refinement = item.refinement;
      if (!refinement?.proposal || refinement.acceptedAt) return null;
      const box = el('div', 'origin-proposal');
      box.append(el('p', 'origin-proposal-title', 'Proposal from Compose'));
      if (refinement.basis && refinement.basis !== basisOf(item)) box.append(el('p', 'origin-hint', 'The task changed after this proposal was made. Read it again before you use it.'));
      const text = el('textarea'); text.value = refinement.proposal; text.rows = 6; text.dataset.focusKey = 'proposal'; text.setAttribute('aria-label', 'Proposed instruction (you can edit it)');
      text.addEventListener('input', () => { refinement.proposal = text.value; changed(); });
      const actions = el('div', 'origin-inline-actions');
      actions.append(button('Use as What to do', () => {
        // The original is the text before Compose's first accepted proposal.
        Object.assign(refinement, { originalDescription: refinement.kept ? refinement.kept.originalDescription : item.description, acceptedAt: Date.now(), kept: null });
        item.description = refinement.proposal;
        changed({ structure: true, drawer: true });
        app.announce('Proposal used. Done when, links and the original text are kept.');
      }, 'origin-primary'), button('Reject', () => { item.refinement = refinement.kept || null; changed({ structure: true, drawer: true }); app.announce('Proposal rejected.'); }, 'origin-link'));
      box.append(autoGrow(text), actions);
      return box;
    }
    function originalNote(item) {
      const refinement = item.refinement;
      if (!refinement?.acceptedAt) return null;
      const box = el('div', 'origin-field'); box.append(el('span', 'origin-field-label', 'Before Compose'), el('p', 'origin-hint', clip(refinement.originalDescription, 400) || '(empty)'),
        button('Restore the original', () => { item.description = refinement.originalDescription; item.refinement = null; changed({ structure: true, drawer: true }); }, 'origin-link'));
      return box;
    }
    // Several tasks: Compose's own settings and job slot, one task at a time, with progress and Cancel.
    // ---- Improve with Compose: the selected tasks run on Compose Batch's queue in the app ----
    // Each task gets its own agent run (a fresh CLI process, no shared session), one at a time or several in parallel,
    // with the CLI, model, effort, checks and grounding chosen here. Each prompt comes back as a proposal on its own
    // task; a task changes only when you accept it. The window minimizes to a small card that stays on every page,
    // and the same run is visible, with every detail, in Compose → Batch.
    const IMPROVE_STAGES = { models: 'Checking models', draft: 'Drafting', review: 'Reviewing', repair: 'Revising', 'repair-review': 'Rechecking' };
    const IMPROVE_STATES = { waiting: ['Waiting', 'muted'], queued: ['Queued', 'muted'], running: ['Working', 'accent'], ready: ['Proposal ready', 'ok'], failed: ['Failed', 'warn'],
      stopped: ['Stopped', 'muted'], skipped: ['Skipped', 'muted'], elsewhere: ['Ready in Compose', 'ok'] };
    const { duration, left, estimate, remaining, meter } = window.PromptboardDom;
    let improve = null, improveMini = null;
    const improvePath = (run, path = '') => `/api/compose/batches${run.batchId ? `/${encodeURIComponent(run.batchId)}` : ''}${path}`;
    function openImprove(ids) {
      if (improve?.active || improve?.phase === 'starting') { improve.hidden = false; showImprove(); app.announce('Improving is running. Its window is open again.'); return; }
      const list = ids.map(id => bp().items.find(item => item.id === id)).filter(Boolean);
      if (!list.length) return;
      const compose = app.composeSettings();
      improve = { projectId, phase: 'setup', active: false, timer: 0, ticks: 0, busy: false, batchId: '', typical: 0, message: '', providers: null, models: new Map(),
        settings: { provider: compose.provider || '', model: compose.model || '', effort: compose.effort || '', quality: compose.quality === 'fast' ? 'fast' : 'reviewed', includeContext: true }, concurrency: 3, keep: {},
        rows: list.map(item => ({ id: item.id, key: item.key, title: item.title.trim() || 'Untitled task', hint: firstLine(item.description), state: 'waiting', startedAt: 0, ms: 0, stage: '', current: '', basis: '', note: '', open: false, proposal: '' })) };
      improve.box = el('div', 'origin-improve');
      // While the run is being set up it cannot be closed half-way; afterwards closing only minimizes it.
      modal('origin-improve-dialog', { eyebrow: 'Compose', title: `Improve ${plural(list.length, 'task')} with Compose`, body: [improve.box], busy: () => improve?.phase === 'starting' });
      dialogs['origin-improve-dialog'].onclose = () => { if (improve?.phase !== 'setup') paintMini(); };
      renderImprove();
      void prepareImprove(improve);
    }
    // The installed CLIs, their models, and this project's batch settings as the starting point.
    async function prepareImprove(run) {
      const [providers, existing] = await Promise.all([app.api('/api/providers', { timeoutMs: 30000 }).catch(() => ({ response: { ok: false }, data: {} })),
        app.api(`/api/compose/batches/${encodeURIComponent(run.projectId)}`, { timeoutMs: 30000 }).catch(() => ({ response: { ok: false }, data: {} }))]);
      run.providers = providers.response.ok ? (providers.data.providers || []).filter(entry => entry.available) : [];
      if (existing.response.ok && existing.data.batch) {
        const batch = existing.data.batch;
        Object.assign(run.settings, Object.fromEntries(['provider', 'model', 'effort', 'quality', 'includeContext'].filter(key => batch.settings[key] !== undefined).map(key => [key, batch.settings[key]])));
        run.concurrency = batch.concurrency || run.concurrency;
      }
      if (!run.providers.some(entry => entry.id === run.settings.provider)) Object.assign(run.settings, { provider: run.providers[0]?.id || '', model: '', effort: '' }); // Only an installed CLI can run.
      await improveModels(run, run.settings.provider);
      if (improve === run) renderImprove();
    }
    async function improveModels(run, provider) {
      if (!provider || run.models.has(provider)) return;
      const { response, data } = await app.api(`/api/models?provider=${encodeURIComponent(provider)}`, { timeoutMs: 60000 }).catch(() => ({ response: { ok: false }, data: {} }));
      run.models.set(provider, response.ok ? data.models || [] : []);
    }
    function showImprove() {
      const dialog = dialogs['origin-improve-dialog'];
      if (improve) improve.hidden = false;
      if (dialog && !dialog.open) dialog.showModal();
      improveMini?.remove(); improveMini = null;
      renderImprove();
    }
    function renderImprove() {
      const run = improve;
      if (!run?.box) return;
      // Rows and buttons are rebuilt when a task changes state: focus returns to the same control.
      const active = run.box.contains(document.activeElement) ? document.activeElement : null, row = active?.closest('[data-id]');
      const focusKey = active ? active.id || (row ? `${row.dataset.id}|${active.className}` : '') : '';
      run.nodes = new Map();
      if (run.phase === 'setup' || run.phase === 'starting') run.box.replaceChildren(...improveSetup(run));
      else run.box.replaceChildren(...improveProgress(run));
      if (focusKey) {
        const [id, className] = focusKey.split('|'), target = className === undefined ? run.box.querySelector(`#${CSS.escape(id)}`)
          : [...(run.box.querySelector(`[data-id="${CSS.escape(id)}"]`)?.querySelectorAll('button, select, input') || [])].find(node => node.className === className);
        target?.focus({ preventScroll: true });
      }
      paintImprove();
    }
    // Before the run: where it runs, with what, and how many at once. Nothing starts until Start.
    function improveSetup(run) {
      const s = run.settings, choose = (label, control, hint) => field(label, control, hint);
      const select = (list, value, onChange, labelText) => {
        const control = el('select'); control.setAttribute('aria-label', labelText);
        for (const [id, name] of list) control.append(Object.assign(el('option', '', name), { value: id }));
        control.value = list.some(([id]) => id === value) ? value : list[0]?.[0] ?? ''; control.addEventListener('change', () => onChange(control.value)); return control;
      };
      const providers = run.providers === null ? [['', 'Checking installed CLIs…']] : run.providers.length ? run.providers.map(entry => [entry.id, entry.name || entry.id]) : [['', 'No CLI installed']];
      const cli = select(providers, s.provider, async value => { s.provider = value; s.model = ''; s.effort = ''; await improveModels(run, value); renderImprove(); }, 'CLI'); cli.id = 'origin-improve-cli';
      const models = run.models.get(s.provider) || [];
      const model = select([['', 'CLI default'], ...models.map(entry => [entry.id, entry.name || entry.id]), ...(s.model && !models.some(entry => entry.id === s.model) ? [[s.model, s.model]] : [])], s.model, value => { s.model = value; s.effort = ''; renderImprove(); }, 'Model'); model.id = 'origin-improve-model';
      const efforts = models.find(entry => entry.id === s.model)?.efforts || ['low', 'medium', 'high'];
      const effort = select([['', 'CLI default'], ...efforts.map(level => [level, level]), ...(s.effort && !efforts.includes(s.effort) ? [[s.effort, s.effort]] : [])], s.effort, value => { s.effort = value; }, 'Effort'); effort.id = 'origin-improve-effort';
      const checks = select([['reviewed', 'Reviewed: a second call checks every requirement'], ['fast', 'Fast: one call per task']], s.quality, value => { s.quality = value; }, 'Checks'); checks.id = 'origin-improve-checks';
      const grounding = el('label', 'origin-check-row origin-improve-grounding'); const box = el('input'); box.type = 'checkbox'; box.checked = s.includeContext !== false; box.id = 'origin-improve-grounding';
      box.addEventListener('change', () => { s.includeContext = box.checked; }); grounding.append(box, el('span', '', 'Give each agent its task’s Origin context (linked components, requirements, decisions) as grounding'));
      const runs = select(Array.from({ length: 8 }, (_, index) => [String(index + 1), index ? `In parallel: ${index + 1} at once, each task with its own agent` : 'One at a time: one agent works on one task']), String(run.concurrency), value => { run.concurrency = Number(value); }, 'How tasks run');
      runs.id = 'origin-improve-runs';
      const grid = el('div', 'origin-improve-settings');
      grid.append(choose('CLI', cli), choose('Model', model), choose('Effort', effort), choose('Checks', checks), choose('Runs', runs, 'Each run is a fresh CLI process with only its own task: no shared session, no tools. Runs live in the app, so you can leave this page.'));
      const preview = el('ol', 'origin-improve-list is-setup');
      for (const row of run.rows) { const li = el('li'); li.append(el('span', 'origin-improve-key', row.key), el('span', 'origin-improve-title', row.title), ...(row.hint ? [el('span', 'origin-improve-hint', row.hint)] : [])); preview.append(li); }
      const start = button(run.phase === 'starting' ? 'Starting…' : `Start ${plural(run.rows.length, 'task')}`, () => void startImprove(run), 'origin-primary'); start.id = 'origin-improve-start';
      start.disabled = run.phase === 'starting' || run.providers === null || !s.provider;
      const close = button('Close', () => dialogs['origin-improve-dialog'].close(), 'origin-ghost'); close.disabled = run.phase === 'starting';
      const actions = el('div', 'origin-modal-actions'); actions.append(close, start);
      const message = el('p', 'origin-inline-error', run.message); message.hidden = !run.message; message.setAttribute('role', 'alert');
      return [grid, grounding, preview, message, actions];
    }
    // During and after the run: one row per task with its own progress, and the whole run's progress.
    function improveProgress(run) {
      const total = el('div', 'origin-improve-total');
      run.totalMeter = meter('All tasks'); run.totalText = el('p', 'origin-improve-total-text'); run.totalText.setAttribute('aria-live', 'polite');
      total.append(run.totalMeter, run.totalText);
      const list = el('ol', 'origin-improve-list');
      for (const row of run.rows) {
        const li = el('li', 'origin-improve-row'); li.dataset.id = row.id;
        const head = el('div', 'origin-improve-head'), chip2 = el('span', 'origin-chip');
        head.append(el('span', 'origin-improve-key', row.key), el('span', 'origin-improve-title', row.title), chip2);
        const bar = meter(`${row.key} progress`), time = el('span', 'origin-improve-time');
        const read = button(row.open ? 'Hide' : 'Read', () => { row.open = !row.open; renderImprove(); dialogs['origin-improve-dialog'].querySelector(`[data-id="${CSS.escape(row.id)}"] .origin-improve-read`)?.focus(); }, 'origin-link origin-improve-read');
        read.setAttribute('aria-expanded', String(row.open)); read.setAttribute('aria-label', `${row.open ? 'Hide' : 'Read'} ${row.key}`);
        const tools = el('div', 'origin-improve-tools'); tools.append(time, read);
        if (row.state === 'ready') tools.append(button('Open task', () => { dialogs['origin-improve-dialog'].close(); focusTarget({ collection: 'items', id: row.id }); }, 'origin-link'));
        li.append(head, ...(row.hint ? [el('p', 'origin-improve-hint', row.hint)] : []), bar, tools);
        if (row.note) li.append(el('p', 'origin-improve-note', row.note));
        if (row.open) li.append(improveDetails(row));
        run.nodes.set(row.id, { chip: chip2, bar, time });
        list.append(li);
      }
      const message = el('p', 'origin-hint', run.message); message.setAttribute('role', 'status'); message.hidden = !run.message;
      const actions = el('div', 'origin-modal-actions');
      const toCompose = button('Open in Compose', () => { dialogs['origin-improve-dialog'].close(); app.openBatch?.(run.batchId); }, 'origin-ghost', 'See every task of this run in Compose → Batch: the original task, the prompt, its checks');
      if (run.active) {
        const minimize = button('Minimize', () => dialogs['origin-improve-dialog'].close(), 'origin-ghost'); minimize.id = 'origin-improve-minimize';
        const cancel = button('Cancel', () => void cancelImprove(run), 'origin-ghost danger', 'Stops every running agent at once; finished proposals are kept'); cancel.id = 'origin-improve-cancel';
        actions.append(cancel, toCompose, minimize);
      } else actions.append(toCompose, Object.assign(button('Close', () => { improve = null; improveMini?.remove(); improveMini = null; dialogs['origin-improve-dialog'].close(); }, 'origin-primary'), { id: 'origin-improve-close' }));
      return [total, list, message, actions];
    }
    // The task's own words (what Compose works from), and the proposal once it is back.
    function improveDetails(row) {
      const box = el('div', 'origin-improve-details'), item = bp().items.find(entry => entry.id === row.id);
      const own = item ? [`${item.key} ${item.title.trim() || 'Untitled task'}`, item.description.trim() && `What to do:\n${item.description.trim()}`, M.lines(item.acceptanceCriteria).length && `Done when:\n${M.lines(item.acceptanceCriteria).map(line => `- ${line}`).join('\n')}`].filter(Boolean).join('\n\n') : 'This task is no longer in the plan.';
      box.append(el('p', 'origin-field-label', 'The task'), el('pre', 'origin-improve-pre', own));
      if (row.proposal) box.append(el('p', 'origin-field-label', 'Proposal'), el('pre', 'origin-improve-pre', row.proposal));
      return box;
    }
    async function startImprove(run) {
      if (run.phase !== 'setup') return; // One start, even on a double click while the blueprint saves.
      run.phase = 'starting'; run.message = ''; renderImprove();
      if (!(await flush())) { run.phase = 'setup'; run.message = 'Save the blueprint first, then try again.'; renderImprove(); return; }
      // What each task said when it was sent: a proposal is marked when the task changes after this.
      for (const row of run.rows) { const item = bp().items.find(entry => entry.id === row.id); if (item) row.basis = basisOf(item); }
      const post = async (path, body) => { const { response, data } = await app.api(path, { method: 'POST', body, timeoutMs: 60000 }).catch(() => ({ response: { ok: false }, data: {} })); if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Compose Batch did not answer.'); return data; };
      try {
        const ids = run.rows.map(row => row.id), defaults = app.composeSettings();
        let data = await post('/api/compose/batches', { originId: run.projectId, expectedRevision: record.revision, itemIds: ids, defaults });
        run.batchId = data.batch.id;
        // Only the settings chosen here change; the batch keeps its other settings (detail, language, instructions…).
        // "CLI default" is sent as itself, so a model or effort from Compose is never used instead.
        const chosen = { ...data.batch.settings, provider: run.settings.provider, model: run.settings.model || '', effort: run.settings.effort || '', quality: run.settings.quality, includeContext: run.settings.includeContext !== false };
        await post(improvePath(run, '/settings'), { settings: chosen, concurrency: run.concurrency });
        // The prompt each task has now: only a different one, made by this run, becomes a proposal.
        const before = new Map(data.batch.items.map(entry => [entry.id, entry.current || '']));
        for (const row of run.rows) row.current = before.get(row.id) ?? '';
        data = await post(improvePath(run, '/run'), { itemIds: ids, defaults });
        for (const skipped of data.skipped || []) { const row = run.rows.find(entry => entry.id === skipped.id); if (row) { row.state = 'skipped'; row.note = skipped.reason; } }
        for (const row of run.rows) if (row.state === 'waiting') row.state = 'queued';
        run.phase = 'running'; run.active = run.rows.some(row => row.state === 'queued');
        if (!run.active) run.message = 'No task could start. See the reason on each task.';
        accept(run, data.batch);
      } catch (failure) { run.phase = 'setup'; run.message = failure.message; renderImprove(); return; }
      renderImprove();
      if (run.active) { clearInterval(run.timer); run.timer = setInterval(() => void tickImprove(run), 1000); }
    }
    // Every second: elapsed times move; every other second the batch is read again.
    async function tickImprove(run) {
      if (improve !== run) { clearInterval(run.timer); return; }
      if (++run.ticks % 2 === 0 && !run.busy) {
        run.busy = true;
        try { const { response, data } = await app.api(improvePath(run), { timeoutMs: 15000 }); if (response.ok && data.batch) await accept(run, data.batch); } catch {} finally { run.busy = false; }
      }
      paintImprove();
    }
    /** Folds the batch's state into the rows. A new prompt becomes a proposal on its Origin task, once. */
    async function accept(run, batch) {
      run.typical = batch.typicalMs || run.typical;
      const byId = new Map(batch.items.map(entry => [entry.id, entry])), changes = [];
      for (const row of run.rows) {
        if (['ready', 'elsewhere', 'failed', 'stopped', 'skipped'].includes(row.state)) continue;
        const entry = byId.get(row.id);
        if (!entry) { row.state = 'stopped'; row.note = 'Removed from the batch.'; continue; }
        if (entry.state === 'running') { if (row.state !== 'running') changes.push(row.id); row.state = 'running'; row.startedAt = entry.startedAt || row.startedAt || Date.now(); row.stage = entry.stage; continue; }
        if (entry.state === 'queued') { row.state = 'queued'; continue; }
        if (entry.current && entry.current !== row.current) {
          row.ms = row.startedAt ? Date.now() - row.startedAt : 0;
          const { response, data } = await app.api(improvePath(run, `/items/${encodeURIComponent(row.id)}`), { timeoutMs: 15000 }).catch(() => ({ response: { ok: false }, data: {} }));
          const version = response.ok ? data.item?.versions.find(entry2 => entry2.id === data.item.current) : null;
          if (!version?.prompt) continue; // Read again on the next tick.
          row.proposal = version.prompt;
          const task = projectId === run.projectId && record?.exists ? bp().items.find(item => item.id === row.id) : null;
          row.current = entry.current;
          if (task) { task.refinement = { proposal: version.prompt.slice(0, 100000), proposedAt: Date.now(), basis: row.basis || basisOf(task), originalDescription: '', acceptedAt: null, kept: keptRefinement(task) }; changed(); row.state = 'ready'; }
          else { row.state = 'elsewhere'; row.note = 'Use it from Compose → Batch with “Use in Origin task”.'; }
          changes.push(row.id);
          continue;
        }
        if (entry.state === 'failed') { row.state = 'failed'; row.note = entry.error?.message || 'The run failed.'; changes.push(row.id); continue; }
        if (row.state === 'running' || row.state === 'queued') { row.state = 'stopped'; changes.push(row.id); }
      }
      if (run.active && !run.cancelling && !run.rows.some(row => ['queued', 'running'].includes(row.state))) {
        run.active = false; clearInterval(run.timer);
        const ready = run.rows.filter(row => row.state === 'ready').length, failed = run.rows.filter(row => row.state === 'failed').length;
        run.message = `${plural(ready, 'proposal')} ready to review${failed ? `; ${plural(failed, 'task')} failed` : ''}. Nothing was changed or sent.`;
        app.announce(run.message);
        renderImprove(); refreshMain(); renderDrawer();
      } else if (changes.length && dialogs['origin-improve-dialog']?.open) renderImprove();
    }
    async function cancelImprove(run) {
      if (run.cancelling) return;
      run.cancelling = true;
      const ids = run.rows.filter(row => ['queued', 'running'].includes(row.state)).map(row => row.id);
      const { response, data } = await app.api(improvePath(run, '/cancel'), { method: 'POST', body: { itemIds: ids }, timeoutMs: 30000 }).catch(() => ({ response: { ok: false }, data: {} }));
      if (!response.ok) { run.cancelling = false; run.message = typeof data.error === 'string' ? data.error : 'The run could not be cancelled. Try again.'; renderImprove(); paintMini(); return; }
      // A prompt that finished just before Cancel is still delivered; only the rest stops.
      if (data.batch) await accept(run, data.batch).catch(() => {});
      for (const row of run.rows) if (['queued', 'running'].includes(row.state)) row.state = 'stopped';
      run.active = false; clearInterval(run.timer);
      run.message = `Cancelled: every running agent was stopped. ${plural(run.rows.filter(row => row.state === 'ready').length, 'proposal')} kept.`;
      renderImprove(); paintMini();
    }
    // Moves the bars and times without rebuilding the rows, so reading or focus is never disturbed.
    function paintImprove() {
      const run = improve;
      if (!run?.nodes) return;
      const now = Date.now(), finished = run.rows.filter(row => row.ms > 0), typical = run.typical || (finished.length ? finished.reduce((sum, row) => sum + row.ms, 0) / finished.length : 0);
      const running = run.rows.filter(row => row.state === 'running'), waiting = run.rows.filter(row => row.state === 'queued').length;
      for (const row of run.rows) {
        const nodes = run.nodes.get(row.id); if (!nodes) continue;
        const [label, tone] = IMPROVE_STATES[row.state] || IMPROVE_STATES.waiting;
        nodes.chip.textContent = row.state === 'running' && IMPROVE_STAGES[row.stage] ? IMPROVE_STAGES[row.stage] : label; nodes.chip.className = `origin-chip ${tone}`;
        if (row.state === 'running') {
          const guess = estimate(now - row.startedAt, typical);
          nodes.bar.set(guess.percent); nodes.time.textContent = [duration(now - row.startedAt), guess.percent !== null && `${guess.percent}%`, guess.left !== null && `${left(guess.left)} left`].filter(Boolean).join(' · ');
        } else if (['ready', 'elsewhere'].includes(row.state)) { nodes.bar.set(100); nodes.time.textContent = row.ms ? `Done in ${duration(row.ms)}` : 'Done'; }
        else { nodes.bar.set(0); nodes.time.textContent = row.state === 'queued' ? 'Waiting for a free agent' : ''; }
      }
      if (run.totalMeter) {
        const done = run.rows.filter(row => ['ready', 'elsewhere', 'failed', 'stopped', 'skipped'].includes(row.state)).length;
        run.totalMeter.set(Math.round((done / run.rows.length) * 100));
        const rest = remaining({ startedAt: running.map(row => row.startedAt), waiting, typical, slots: run.concurrency, now });
        run.totalText.textContent = [`${done} of ${run.rows.length} done`, running.length && `${running.length} working`, waiting && `${waiting} waiting`,
          run.active && (rest === null ? 'time left shown after the first task' : `${left(rest)} left (estimated)`)].filter(Boolean).join(' · ');
      }
      paintMini();
    }
    // The minimized run: a small card on every page, with the whole run's progress. It is built once per state
    // (running or finished) and then only its text and bar change, so its buttons keep focus.
    function paintMini() {
      const run = improve, dialog = dialogs['origin-improve-dialog'];
      if (!run || run.phase === 'setup' || run.hidden || dialog?.open) { improveMini?.remove(); improveMini = null; return; }
      const mode = run.active || run.phase === 'starting' ? 'running' : 'finished';
      if (!improveMini || improveMini.dataset.mode !== mode || improveMini.run !== run) {
        improveMini?.remove();
        improveMini = el('div', 'origin-improve-mini'); improveMini.id = 'origin-improve-mini'; improveMini.dataset.mode = mode; improveMini.setAttribute('role', 'region'); improveMini.setAttribute('aria-label', 'Improving tasks');
        const text = el('div', 'origin-improve-mini-text'), title = el('strong'), line = el('span'); text.append(title, line);
        const show = button(mode === 'running' ? 'Show' : 'Review', () => showImprove(), 'origin-link'); show.id = 'origin-improve-show';
        const end = mode === 'running' ? button('Cancel', () => void cancelImprove(run), 'origin-link danger', 'Stop every running agent now')
          : Object.assign(button('×', () => { improveMini?.remove(); improveMini = null; improve = null; }, 'origin-icon origin-small'), { title: 'Dismiss' });
        // While it runs, × only hides the card; Improve with Compose shows the run again.
        const hide = mode === 'running' ? Object.assign(button('×', () => { run.hidden = true; paintMini(); app.announce('Improving goes on. Choose Improve with Compose to see it again.'); }, 'origin-icon origin-small'), { title: 'Hide this card' }) : null;
        improveMini.bar = meter('Improving tasks'); improveMini.title2 = title; improveMini.line = line; improveMini.run = run;
        improveMini.append(text, improveMini.bar, show, end, ...(hide ? [hide] : []));
        document.body.append(improveMini);
      }
      const done = run.rows.filter(row => ['ready', 'elsewhere', 'failed', 'stopped', 'skipped'].includes(row.state)).length, now = run.rows.find(row => row.state === 'running');
      improveMini.bar.set(Math.round((done / run.rows.length) * 100));
      improveMini.title2.textContent = mode === 'running' ? `Improving ${done} of ${run.rows.length}` : run.message || 'Improving finished';
      improveMini.line.textContent = mode === 'running' ? (now ? `${now.key} ${now.title}` : run.phase === 'starting' ? 'Starting…' : 'Waiting for a free agent') : '';
    }
    // Suggest tasks: the split service proposes tasks from one component, one layer or the project's requirements.
    function openSuggest(scope) {
      const blueprint = bp(), component = blueprint.components.find(entry => entry.id === scope.componentId), layer = blueprint.layers.find(entry => entry.id === scope.layerId);
      const where = component ? component.name || 'this component' : layer ? `the ${layer.name || 'unnamed'} layer` : 'the project’s requirements';
      const settings = app.composeSettings(), dialog = () => dialogs['origin-suggest-dialog'];
      const body = el('div', 'origin-suggestions'), progress = el('p', 'origin-hint'); progress.setAttribute('role', 'status');
      const chain = el('label', 'origin-check-row'); const chainBox = el('input'); chainBox.type = 'checkbox'; chainBox.id = 'origin-suggest-chain'; chain.append(chainBox, el('span', '', 'Each starts after the one before')); chain.hidden = true;
      const start = button('Suggest', () => void run(), 'origin-primary'); start.id = 'origin-suggest-start';
      const accept = button('Add selected', () => addSelected(), 'origin-primary'); accept.id = 'origin-suggest-add'; accept.hidden = true;
      const cancel = button('Cancel', () => { if (job) job.abort(); else dialog().close(); }, 'origin-ghost');
      let job = null, picks = [];
      async function run() {
        if (app.composeRunning()) { progress.textContent = 'Compose is generating a prompt. Wait for it or cancel it, then try again.'; return; }
        if (!(await flush())) { progress.textContent = 'Save the blueprint first, then try again.'; return; }
        job = new AbortController(); start.disabled = true; progress.textContent = 'Asking your CLI for suggestions…';
        const brief = M.suggestionBrief(bp(), { ...scope, projectName: project()?.name || '' });
        const { response, data } = await app.api('/api/split', { method: 'POST', timeoutMs: null, compose: true, signal: job.signal,
          body: { prompt: brief, provider: settings.provider, model: settings.model || '', effort: settings.effort || '', language: settings.language || 'en' } })
          .catch(error => ({ response: { ok: false }, data: { error: job?.signal.aborted || error?.name === 'AbortError' ? 'Cancelled. Nothing was added.' : 'The app did not answer.' } }));
        job = null; start.disabled = false;
        if (!response.ok || !Array.isArray(data.tasks)) { progress.textContent = typeof data.error === 'string' ? data.error : 'No suggestions came back. Nothing was added.'; return; }
        picks = data.tasks.map(task => ({ use: true, title: task.title.slice(0, 200), prompt: task.prompt }));
        body.replaceChildren(...picks.map((pick, index) => {
          const row = el('div', 'origin-suggestion'); const box = el('input'); box.type = 'checkbox'; box.checked = true; box.setAttribute('aria-label', `Add suggestion ${index + 1}`);
          box.addEventListener('change', () => { pick.use = box.checked; accept.disabled = !picks.some(entry => entry.use && entry.title.trim()); });
          const title = el('input', 'origin-suggestion-title'); title.value = pick.title; title.maxLength = 200; title.setAttribute('aria-label', `Title of suggestion ${index + 1}`);
          title.addEventListener('input', () => { pick.title = title.value; accept.disabled = !picks.some(entry => entry.use && entry.title.trim()); });
          const detail = el('details'); detail.append(el('summary', '', 'What to do'), el('pre', 'origin-context-text', pick.prompt));
          const head = el('div', 'origin-handoff-line'); head.append(box, title); row.append(head, detail);
          return row;
        }));
        progress.textContent = `${plural(picks.length, 'suggestion')}. Edit or untick them; nothing is added until you choose.`;
        start.hidden = true; accept.hidden = false; chain.hidden = picks.length < 2;
      }
      function addSelected() {
        const chosen = picks.filter(pick => pick.use && pick.title.trim());
        if (!chosen.length) return;
        const links = component ? { componentIds: [component.id] } : layer ? { layerId: layer.id } : {};
        let previous = null;
        for (const pick of chosen) {
          const item = newTask(pick.title.trim(), { ...links, description: pick.prompt, dependsOn: chainBox.checked && previous ? [previous.id] : [] });
          if (!item) break;
          previous = item;
        }
        dialog().close();
        app.announce(`${plural(chosen.length, 'task')} added from suggestions. Review each before sending it.`);
      }
      const actions = el('div', 'origin-modal-actions'); actions.append(cancel, start, accept);
      modal('origin-suggest-dialog', { eyebrow: 'Compose', title: 'Suggest tasks', busy: () => Boolean(job), body: [body, chain, progress, actions],
        lead: `Asks your CLI (${settings.provider || 'CLI default'}) to propose tasks from ${where}, using only its design. Missing choices stay open as tasks to decide. Nothing is added until you choose.` });
      start.focus();
    }

    // ---- Send to Kanban: one review panel; the server builds the context and creates each card once ----
    async function openHandoff(ids = [...planSelection]) {
      const blueprint = bp(), selection = ids.filter(id => blueprint.items.some(item => item.id === id));
      if (!selection.length) return;
      const target = project();
      if (!target?.kanban?.exists) { openConnect({ then: () => openHandoff(selection) }); return; }
      if (!(await flush())) { showError('This blueprint has unsaved changes. Save it, then send again.'); return; }
      const destination = target.kanbanProjectId, dialog = () => dialogs['origin-handoff-dialog'];
      const tasks = app.projects().find(entry => entry.id === destination)?.tasks || [];
      const items = new Map(blueprint.items.map(item => [item.id, item]));
      const cardOf = item => tasks.find(task => task.originSource?.originProjectId === projectId && task.originSource.originTaskId === item.id)
        || (item.handoff?.projectId === destination ? tasks.find(task => task.id === item.handoff.taskId) : null) || M.splitCard(tasks, projectId, item.id, id => items.has(id));
      const { response, data } = await app.api(`/api/origin/projects/${encodeURIComponent(projectId)}/context`, { method: 'POST', body: { expectedRevision: record.revision, itemIds: selection }, timeoutMs: 30000 })
        .catch(() => ({ response: { ok: false }, data: { error: 'The app did not answer. Nothing was sent.' } }));
      if (!response.ok) { showError(typeof data.error === 'string' ? data.error : 'The tasks could not be prepared. Nothing was sent.'); return; }
      const contexts = new Map(data.tasks.map(task => [task.itemId, task]));
      // Every prerequisite down the chain that has no card, as the server adds them (handoff in src/origin.mjs).
      const missing = [];
      for (let next = selection; next.length;) {
        next = [...new Set(next.flatMap(id => items.get(id).dependsOn || []))].filter(id => items.has(id) && !selection.includes(id) && !missing.includes(id) && !cardOf(items.get(id)));
        missing.push(...next);
      }
      const list = el('ol', 'origin-handoff-list'), recreate = new Map();
      for (const id of M.orderItems(blueprint, selection)) {
        const item = items.get(id), card = cardOf(item), context = contexts.get(id), li = el('li');
        const line = el('div', 'origin-handoff-line'); line.append(el('span', 'origin-handoff-title', `${item.key} ${item.title.trim() || 'Untitled task'}`));
        if (card) line.append(chip(`Already Kanban #${card.number}`, 'ok'));
        else if (item.handoff?.projectId === destination) {
          line.append(chip('Card deleted in Kanban', 'warn'));
          const again = el('label', 'origin-check-row'); const box = el('input'); box.type = 'checkbox'; box.addEventListener('change', () => paint());
          again.append(box, el('span', '', 'Create it again')); recreate.set(id, box); li.append(line, again);
        } else line.append(chip('New card', 'muted'));
        if (!li.childElementCount) li.append(line);
        if (context && !card) {
          const summary = el('p', 'origin-handoff-context', context.tooLarge ? context.error : `Context: ${plural(context.included.length, 'linked record')}${context.omitted.length ? `, ${context.omitted.length} left out for size` : ''}.`);
          li.append(summary);
          for (const warning of context.warnings) li.append(el('p', 'origin-handoff-warning', warning));
        }
        list.append(li);
      }
      const include = el('input'); include.type = 'checkbox'; include.id = 'origin-handoff-prerequisites'; include.addEventListener('change', () => paint());
      const prerequisites = el('div', 'origin-callout warn origin-handoff-prerequisites');
      if (missing.length) {
        const row = el('label', 'origin-check-row'); row.append(include, el('span', '', `Include prerequisites: ${M.orderItems(blueprint, missing).map(id => `${items.get(id).key} ${items.get(id).title.trim() || 'Untitled task'}`).join(', ')}`));
        prerequisites.append(el('p', '', 'Some tasks start after tasks that have no card yet.'), row);
        // A prerequisite whose card was deleted in Kanban is created again only if you say so.
        for (const id of missing.filter(entry => items.get(entry).handoff?.projectId === destination)) {
          const again = el('label', 'origin-check-row'), box = el('input'); box.type = 'checkbox'; box.addEventListener('change', () => paint());
          again.append(box, el('span', '', `Create ${items.get(id).key} again (its card was deleted in Kanban)`)); recreate.set(id, box); prerequisites.append(again);
        }
      } else prerequisites.hidden = true;
      const error = el('p', 'origin-inline-error'); error.hidden = true; error.setAttribute('role', 'alert');
      const results = el('ol', 'origin-handoff-results'); results.hidden = true;
      const tooLarge = data.tasks.some(task => task.tooLarge && !cardOf(items.get(task.itemId)));
      const confirm = button('', () => void send(selection), 'origin-primary'); confirm.id = 'origin-handoff-confirm';
      const actions = el('div', 'origin-modal-actions');
      const paint = () => {
        const blocked = missing.length && !include.checked, waiting = [...recreate].some(([id, box]) => !box.checked && (!missing.includes(id) || include.checked));
        confirm.disabled = handoffBusy || blocked || waiting || tooLarge;
        confirm.textContent = `Send ${plural(selection.length + (include.checked ? missing.length : 0), 'task')}`;
        confirm.title = tooLarge ? 'A task’s essential context is too large.' : blocked ? 'Include the prerequisites or send them first.' : waiting ? 'Choose whether to create the deleted cards again, or leave those tasks out.' : 'Creates To Do cards. No agent starts.';
      };
      async function send(ids2) {
        handoffBusy = true; paint(); error.hidden = true;
        const outcome = await app.api(`/api/origin/projects/${encodeURIComponent(projectId)}/handoff`, { method: 'POST', timeoutMs: 120000,
          body: { expectedRevision: record.revision, itemIds: ids2, includePrerequisites: include.checked, recreate: [...recreate].filter(([, box]) => box.checked).map(([id]) => id) } })
          .catch(() => ({ response: { ok: false }, data: { error: 'The app did not answer. Open the project again to see what was created; sending again never adds a second card.' } }));
        handoffBusy = false;
        if (!outcome.response.ok) { error.textContent = typeof outcome.data.error === 'string' ? outcome.data.error : 'The tasks could not be sent.'; error.hidden = false; paint(); return; }
        // Only handoff links changed on the server; they are merged into this window's copy.
        const saved = new Map(outcome.data.blueprint.items.map(item => [item.id, item]));
        for (const item of bp().items) if (saved.has(item.id)) item.handoff = saved.get(item.id).handoff;
        record.revision = outcome.data.revision; hideUndo(); // An Undo from before would drop these card links.
        await app.ensureBoard();
        const sent = outcome.data.results, failed = sent.filter(result => result.status === 'failed');
        planSelection = new Set([...planSelection].filter(id => failed.some(result => result.itemId === id)));
        results.replaceChildren(...sent.map(result => el('li', `origin-handoff-result ${result.status}`, result.status === 'failed' ? `${result.key}: ${result.error}`
          : `${result.key} → Kanban #${result.number}${result.status === 'existing' ? ' (already there)' : ''}`)));
        results.hidden = false; list.hidden = prerequisites.hidden = true;
        const made = sent.filter(result => result.status === 'created').length;
        lastHandoff = `${made ? `Created ${plural(made, 'card')} in To Do of ${outcome.data.destination.name}, prerequisites first.` : 'No new card was needed.'}${failed.length ? ` ${plural(failed.length, 'task')} could not be sent.` : ''} No agent started.`;
        app.announce(lastHandoff);
        actions.replaceChildren(...(failed.length ? [button('Retry the failed tasks', () => void send(failed.map(result => result.itemId)), 'origin-ghost')] : []),
          button('Open Kanban', () => { dialog().close(); app.openKanban(destination); }, 'origin-ghost'), button('Done', () => dialog().close(), 'origin-primary'));
        renderMain(); renderDrawer();
      }
      actions.append(button('Cancel', () => dialog().close(), 'origin-ghost'), confirm);
      paint();
      modal('origin-handoff-dialog', { eyebrow: `Kanban · ${target.kanban.name}`, title: 'Send to Kanban', body: [list, prerequisites, results, error, actions],
        lead: 'Each task becomes one To Do card with its own words, then its context, and an Origin reference. Prerequisites come first and must be done before a card starts. No agent starts — you start work from Kanban. Sending again never adds a second card.' });
      confirm.focus();
    }

    // ---- Keyboard ----
    view.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save({ force: changeCount !== savedCount }); return; }
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (connectFrom !== null || mapLinkFrom !== null || selectedLink || flowConnect || flowStep) { event.preventDefault(); const step = flowStep; connectFrom = mapLinkFrom = selectedLink = flowConnect = flowStep = null; renderMain(); if (step) main.querySelector(`.origin-flow-node[data-id="${CSS.escape(step.node)}"]`)?.focus({ preventScroll: true }); return; }
      if (open) { event.preventDefault(); closeDrawer(); }
      else if (contextPanel.isOpen()) { event.preventDefault(); contextPanel.close(); }
      else if (researchPanel.isOpen()) { event.preventDefault(); researchPanel.close(); }
    });

    /** Open one record of an Origin project from another page (reverse navigation). Unsaved work is saved first. */
    async function focus({ originId, collection, id } = {}) {
      if (originId && originId !== projectId) {
        const problem = await unsaved();
        if (problem) { showError(problem); return false; }
        setPref(PROJECT_KEY, originId); await load(originId);
      }
      else if (loading) await loading;
      if (collection && id && record?.exists) focusTarget({ collection, id });
      return true;
    }

    return { show, leave, receiveProposal, focus };
  }

  return { create };
})();
