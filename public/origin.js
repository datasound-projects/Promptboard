'use strict';

// Origin: the project blueprint workspace. It owns its blueprint requests and receives explicit
// application seams (authenticated API, projects, Compose prefill, Kanban task creation).
// All user text is rendered as DOM text. Nothing here starts an agent, calls a model or fetches a source.
window.PromptboardOrigin = (() => {
  const M = globalThis.PromptboardOriginModel;
  const SECTION_KEY = 'promptboard.origin.section', INSPECTOR_KEY = 'promptboard.origin.inspector';
  const SAVE_DELAY = 700, SAVE_MAX_WAIT = 3000;
  const NODE_W = 176, NODE_H = 58, GAP_X = 300, GAP_Y = 100;
  const NOUN = { requirements: 'Requirement', components: 'Component', connections: 'Connection', technologies: 'Technology', dependencies: 'Dependency', decisions: 'Decision',
    assumptions: 'Assumption', sources: 'Source', risks: 'Risk', areas: 'Planning item', milestones: 'Milestone', items: 'Implementation item' };
  // Reference fields → the collection they point to. Used for deletes, details and “referenced by”.
  const REFS = { componentIds: 'components', technologyIds: 'technologies', requirementIds: 'requirements', dependencyIds: 'dependencies', sourceIds: 'sources',
    requiredBy: 'components', dependsOn: owner => (owner === 'dependencies' ? 'dependencies' : 'items'), supersededBy: 'decisions', decisionId: 'decisions',
    milestoneId: 'milestones', from: 'components', to: 'components' };
  const REF_LABELS = { componentIds: 'Components', technologyIds: 'Technologies', requirementIds: 'Requirements', dependencyIds: 'Dependencies', sourceIds: 'Evidence',
    requiredBy: 'Required by', dependsOn: 'Depends on', supersededBy: 'Superseded by', decisionId: 'Decision', milestoneId: 'Milestone', from: 'From', to: 'To' };
  const COMPOSABLE = new Set(['requirements', 'components', 'decisions', 'milestones', 'items']);
  const SECTION_INTRO = {
    overview: 'What are we building, why, for whom, and how ready is the blueprint?',
    vision: 'Problem, goal, users and boundaries. Lists take one entry per line.',
    requirements: 'Structured requirements with acceptance criteria. Editing a requirement never starts an agent.',
    architecture: 'Components and their connections. The diagram is a view of these records.',
    technology: 'Selected technologies, why they were chosen and the evidence behind them.',
    dependencies: 'Packages, services, APIs and tools the system relies on. Unverified entries are highlighted.',
    data: 'Data sources, storage, flows, retention, privacy and ownership. Mark the section not applicable when it does not matter.',
    ai: 'Models, agents, tools, knowledge and guardrails. Reference Base resources instead of copying them.',
    security: 'Which security decisions are defined. Origin shows coverage; it never claims a project is secure.',
    testing: 'Test strategy by area. Linked requirements carry into implementation items and tasks.',
    deployment: 'Environments, runtime, configuration and recovery, linked to the components they serve.',
    observability: 'Logs, metrics, alerts and usage signals. Optional for small projects.',
    research: 'Sources with explicit verification, and assumptions kept separate from facts.',
    decisions: 'Architecture decision records with their rationale, so later work does not undo them by accident.',
    plan: 'Milestones and ordered implementation items. Send selected items to Kanban To Do or one item to Compose.',
  };

  const el = (tag, className = '', text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const button = (text, onClick, className = 'secondary-button', title = '') => { const node = el('button', className, text); node.type = 'button'; if (title) node.title = title; node.addEventListener('click', onClick); return node; };
  const pref = (key, fallback = '') => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
  const setPref = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
  const newId = () => globalThis.crypto?.randomUUID?.() || `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  const today = () => new Date().toLocaleDateString('en-CA');
  const safeUrl = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; } };
  const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
  const badge = (text, kind = '') => el('span', `origin-badge${kind ? ` origin-badge-${kind}` : ''}`, text);
  const verificationBadge = state => badge(M.VERIFICATION_LABELS[state], state);
  const field = (name, control, hint = '') => { const label = el('label', 'field-label origin-field'); label.append(name, control); if (hint) label.append(el('small', '', hint)); return label; };

  function create(app) {
    const view = document.querySelector('#origin-view'), navigator = document.querySelector('#origin-nav');
    if (!view || !navigator) return null;
    view.replaceChildren();
    const header = el('header', 'origin-header');
    const titleBox = el('div', 'origin-title'), heading = el('h1', '', 'Origin'); heading.id = 'origin-heading';
    const projectSelect = el('select'); projectSelect.id = 'origin-project'; projectSelect.setAttribute('aria-label', 'Project');
    const projectLabel = el('label', 'origin-project'); projectLabel.append(el('span', 'small-label', 'Project'), projectSelect);
    titleBox.append(heading, projectLabel);
    const statusBox = el('div', 'origin-header-status');
    const readinessButton = el('button', 'origin-readiness'); readinessButton.type = 'button'; readinessButton.id = 'origin-readiness';
    const saveStatus = el('span', 'origin-save'); saveStatus.id = 'origin-save'; saveStatus.setAttribute('role', 'status'); saveStatus.setAttribute('aria-live', 'polite');
    const tools = el('details', 'origin-tools'); const toolsSummary = el('summary', 'secondary-button', 'Blueprint'); toolsSummary.title = 'Export or import this blueprint';
    const toolsMenu = el('div', 'origin-tools-menu');
    const importFile = el('input'); importFile.type = 'file'; importFile.accept = '.json,application/json'; importFile.hidden = true; importFile.id = 'origin-import-file';
    toolsMenu.append(button('Export blueprint (JSON)', () => exportBlueprint(), 'text-button'), button('Import blueprint…', () => importFile.click(), 'text-button'), importFile);
    tools.append(toolsSummary, toolsMenu);
    const inspectorToggle = button('', () => setInspector(!inspectorOpen()), 'icon-button origin-inspector-toggle');
    inspectorToggle.id = 'origin-inspector-toggle'; inspectorToggle.setAttribute('aria-controls', 'origin-inspector');
    inspectorToggle.append(svgIcon('M3.5 4.5h17v15h-17zM15 4.5v15'));
    statusBox.append(readinessButton, saveStatus, tools, inspectorToggle);
    header.append(titleBox, statusBox);
    const errorBox = el('p', 'inline-error origin-error'); errorBox.id = 'origin-error'; errorBox.setAttribute('role', 'alert'); errorBox.hidden = true;
    const notice = el('p', 'note origin-notice'); notice.id = 'origin-notice'; notice.setAttribute('role', 'status'); notice.hidden = true;
    const layout = el('div', 'origin-layout');
    const main = el('section', 'origin-main'); main.id = 'origin-main'; main.setAttribute('aria-labelledby', 'origin-section-heading');
    const inspector = el('aside', 'origin-inspector'); inspector.id = 'origin-inspector'; inspector.setAttribute('aria-label', 'Inspector'); inspector.tabIndex = -1;
    const scrim = button('', () => setInspector(false), 'origin-inspector-scrim'); scrim.setAttribute('aria-label', 'Close inspector'); scrim.hidden = true;
    layout.append(main, inspector);
    const statusbar = el('footer', 'origin-statusbar'); statusbar.id = 'origin-statusbar';
    view.append(header, errorBox, notice, layout, scrim, statusbar);

    let projectId = null, record = null, loading = null, loadError = null, visible = false;
    let section = M.SECTIONS.some(item => item.id === pref(SECTION_KEY)) ? pref(SECTION_KEY) : 'overview';
    let selected = null, editing = null, inspectorTab = 'intel', connectFrom = null, planSelection = new Set(), handoffBusy = false, lastHandoff = '';
    let saveTimer = null, saving = null, changeCount = 0, savedCount = 0, saveState = 'saved', saveMessage = '', dirtySince = 0, shownSaveError = '';
    let baseResources = null, baseLoading = null, focusAfter = null, refreshRow = null;
    const bp = () => record.blueprint;
    const project = () => app.projects().find(item => item.id === projectId) || null;

    function svgIcon(d) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.6'); svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', d); svg.append(path); return svg;
    }
    const showError = message => { errorBox.textContent = message; errorBox.hidden = !message; };
    const showNotice = message => { notice.textContent = message; notice.hidden = !message; };

    // ---- Inspector visibility: a column on desktop, a drawer on narrow screens ----
    const narrow = () => window.innerWidth <= 1100;
    let drawerOpen = false;
    function inspectorOpen() { return narrow() ? drawerOpen : pref(INSPECTOR_KEY) !== 'collapsed'; }
    function setInspector(open) {
      if (narrow()) { drawerOpen = open; if (open) inspector.focus(); else if (view.contains(document.activeElement) && inspector.contains(document.activeElement)) inspectorToggle.focus(); }
      else setPref(INSPECTOR_KEY, open ? 'expanded' : 'collapsed');
      syncInspector();
    }
    function syncInspector() {
      const open = inspectorOpen();
      view.dataset.inspector = open ? 'open' : 'closed';
      scrim.hidden = !(narrow() && open);
      inspectorToggle.setAttribute('aria-expanded', String(open));
      inspectorToggle.setAttribute('aria-label', open ? 'Hide inspector' : 'Show inspector');
      inspectorToggle.title = open ? 'Hide inspector' : 'Show inspector';
    }
    window.addEventListener('resize', syncInspector);

    // ---- Saving: debounced, revision-checked autosave with a visible state ----
    function changed({ structure = false } = {}) {
      if (!record?.exists) return;
      changeCount++;
      if (saveState !== 'conflict') { saveState = 'dirty'; saveMessage = ''; }
      // Debounced, but continuous editing still saves at least every few seconds.
      dirtySince ||= Date.now();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { void save(); }, Date.now() - dirtySince >= SAVE_MAX_WAIT ? 0 : SAVE_DELAY);
      renderSave();
      refreshRow?.();
      if (structure) renderMain(); else renderDerived();
    }
    async function save({ force = false } = {}) {
      clearTimeout(saveTimer); saveTimer = null;
      if (!record?.exists || saveState === 'conflict' && !force || changeCount === savedCount && !force) return true;
      if (saving) { await saving; return changeCount === savedCount ? true : save(); }
      const target = changeCount, id = projectId;
      saveState = 'saving'; renderSave();
      saving = (async () => {
        const { response, data } = await app.api(`/api/origin/projects/${encodeURIComponent(id)}`, { method: 'PUT', body: { expectedRevision: record.revision, blueprint: record.blueprint }, timeoutMs: 30000 })
          .catch(() => ({ response: { ok: false, status: 0 }, data: { error: 'The app did not answer. Your changes are kept in this window.' } }));
        if (id !== projectId) return false;
        if (response.ok) {
          record.revision = data.revision; savedCount = target;
          saveState = changeCount === savedCount ? 'saved' : 'dirty'; saveMessage = '';
          dirtySince = saveState === 'saved' ? 0 : Date.now();
          if (saveState === 'dirty') saveTimer = setTimeout(() => { void save(); }, SAVE_DELAY);
          return true;
        }
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
      const text = { saved: 'Saved', dirty: 'Unsaved changes', saving: 'Saving…', error: 'Not saved', conflict: 'Changed in another window' }[saveState];
      const dot = el('span', 'origin-save-dot'); dot.setAttribute('aria-hidden', 'true');
      saveStatus.append(dot, el('span', '', text));
      saveStatus.title = saveMessage || (saveState === 'saved' ? `Saved revision ${record.revision}` : text);
      if (saveState === 'error') saveStatus.append(button('Retry', () => void save({ force: true }), 'text-button'));
      if (saveState === 'conflict') saveStatus.append(button('Reload saved version', () => void load(projectId, { force: true }), 'text-button'),
        button('Keep mine', () => void keepMine(), 'text-button', 'Save this window’s version over the newer saved one'));
      // Only save problems are shown or cleared here; other messages keep their own lifetime.
      const message = ['error', 'conflict'].includes(saveState) ? saveMessage : '';
      if (message !== shownSaveError) { if (message || errorBox.textContent === shownSaveError) showError(message); shownSaveError = message; }
    }
    async function keepMine() {
      const { response, data } = await app.api(`/api/origin/projects/${encodeURIComponent(projectId)}`, { timeoutMs: 30000 }).catch(() => ({ response: { ok: false }, data: {} }));
      if (!response.ok) { saveMessage = data.error || 'The saved version could not be read.'; renderSave(); return; }
      record.revision = data.revision; saveState = 'dirty'; await save({ force: true });
    }
    async function flush() {
      if (!record?.exists) return true;
      if (saveTimer || changeCount !== savedCount) return save();
      if (saving) return saving;
      return saveState !== 'error' && saveState !== 'conflict';
    }
    window.addEventListener('beforeunload', event => { if (record?.exists && changeCount !== savedCount) { event.preventDefault(); event.returnValue = ''; } });

    // ---- Loading ----
    async function load(id, { force = false } = {}) {
      if (!force && id === projectId && (record || loading)) return loading;
      projectId = id; record = null; loadError = null; selected = null; editing = null; connectFrom = null; planSelection = new Set(); lastHandoff = '';
      changeCount = savedCount = 0; dirtySince = 0; saveState = 'saved'; showNotice(''); showError('');
      if (!id) { render(); return null; }
      main.replaceChildren(el('p', 'note origin-loading', 'Loading blueprint…')); main.setAttribute('aria-busy', 'true');
      const attempt = (async () => {
        const { response, data } = await app.api(`/api/origin/projects/${encodeURIComponent(id)}`, { timeoutMs: 30000 }).catch(() => ({ response: { ok: false, status: 0 }, data: {} }));
        if (id !== projectId) return;
        if (!response.ok) {
          loadError = typeof data.error === 'string' ? data.error : 'The blueprint could not be loaded. Board, Compose and Base data are unaffected.';
          if (response.status === 404) await app.ensureBoard({ ifChanged: true });
          return;
        }
        record = { exists: data.exists, revision: data.revision, blueprint: data.blueprint || M.emptyBlueprint() };
        const notes = [];
        if (data.recovery?.quarantined) notes.push(data.recovery.restoredFromBackup ? 'The blueprint file was damaged, so the last good copy was restored. The damaged file was kept in the app data folder.' : 'The blueprint file was damaged and no good copy was found. The damaged file was kept in the app data folder.');
        else if (data.recovery?.restoredFromBackup) notes.push('The blueprint file was missing, so the last good copy was restored.');
        if (data.repairs) notes.push(`${plural(data.repairs, 'invalid entry', 'invalid entries')} or broken links were removed while loading. The cleaned blueprint is saved with your next change.`);
        showNotice(notes.join(' '));
      })();
      loading = attempt;
      try { await attempt; } finally { if (loading === attempt) loading = null; main.removeAttribute('aria-busy'); if (id === projectId) render(); }
    }

    async function show() {
      visible = true;
      syncInspector();
      await app.ensureBoard();
      const projects = app.projects(), current = app.currentProjectId();
      const id = projects.some(item => item.id === projectId) ? (current && current !== projectId ? current : projectId) : current;
      if (id !== projectId || !record && !loading) {
        if (projectId && !(await flush())) { renderProjects(); return; }
        await load(id || null);
      } else render();
    }
    async function leave() { visible = false; connectFrom = null; await flush(); }

    async function switchProject(id) {
      if (id === projectId) return;
      if (!(await flush())) { projectSelect.value = projectId; showError('This blueprint has unsaved changes. Save or reload it before switching projects.'); return; }
      app.selectProject(id);
      await load(id);
    }
    projectSelect.addEventListener('change', () => { void switchProject(projectSelect.value); });

    // ---- Rendering ----
    function render() {
      renderProjects(); renderMain(); renderSave(); syncInspector();
    }
    function renderProjects() {
      const projects = app.projects();
      projectSelect.replaceChildren(...projects.map(item => Object.assign(el('option', '', item.name), { value: item.id })));
      projectSelect.value = projectId || '';
      projectLabel.hidden = !projects.length;
      heading.textContent = 'Origin';
    }
    function renderDerived() {
      view.dataset.empty = String(!record?.exists);
      inspectorToggle.hidden = !record?.exists;
      if (!record?.exists) { navigator.replaceChildren(el('p', 'note', record ? 'Start a blueprint to open its sections.' : 'Choose a project to plan.')); statusbar.replaceChildren(); statusbar.hidden = true; readinessButton.hidden = true; inspector.replaceChildren(); return; }
      const found = M.issues(bp()), ready = M.readiness(bp(), found), states = M.sectionStates(bp(), found);
      renderNavigator(states);
      readinessButton.hidden = false;
      readinessButton.replaceChildren(el('span', `origin-state origin-state-${ready.state}`, ready.label));
      readinessButton.title = ready.reasons.join(' ');
      readinessButton.dataset.state = ready.state;
      renderStatusbar(found);
      if (!inspector.contains(document.activeElement) || inspectorTab === 'intel') renderInspector(found, ready);
    }
    function renderNavigator(states) {
      const list = el('ul', 'origin-nav-list');
      for (const item of M.SECTIONS) {
        const [glyph, meaning] = M.SECTION_STATE[states[item.id]];
        const entry = el('li'), open = el('button', 'origin-nav-item'); open.type = 'button'; open.dataset.section = item.id;
        if (item.id === section) open.setAttribute('aria-current', 'page');
        const mark = el('span', `origin-glyph origin-glyph-${states[item.id]}`, glyph); mark.setAttribute('aria-hidden', 'true');
        open.append(mark, el('span', 'origin-nav-label', item.label), el('span', 'sr-only', `, ${meaning}`));
        open.title = meaning;
        open.addEventListener('click', () => { openSection(item.id); app.closeSidebar(); });
        open.addEventListener('keydown', event => {
          const index = M.SECTIONS.findIndex(entry => entry.id === item.id);
          const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: M.SECTIONS.length - 1 }[event.key];
          if (next === undefined) return;
          event.preventDefault();
          navigator.querySelectorAll('.origin-nav-item')[(next + M.SECTIONS.length) % M.SECTIONS.length]?.focus();
        });
        entry.append(open); list.append(entry);
      }
      const focused = navigator.contains(document.activeElement) ? document.activeElement.dataset.section : null;
      navigator.replaceChildren(list);
      if (focused) navigator.querySelector(`[data-section="${focused}"]`)?.focus();
    }
    function renderStatusbar(found) {
      statusbar.hidden = false;
      const count = (test) => found.filter(test).length;
      const parts = [
        plural(count(issue => issue.kind === 'unresolved'), 'unresolved decision'),
        plural(count(issue => issue.kind === 'unverified' && /^(technology|dependency)/.test(issue.rule)), 'unverified technology or dependency', 'unverified technologies or dependencies'),
        plural(count(issue => issue.kind === 'conflict'), 'conflict'),
        plural(bp().assumptions.filter(item => item.status === 'open').length, 'open assumption'),
      ];
      const next = found.find(issue => issue.blocking) || found[0];
      const children = parts.map(text => el('span', 'origin-status-item', text));
      if (next) { const action = button(`Next: ${next.title}`, () => focusTarget(next.target), 'text-button origin-next'); action.title = next.action || next.title; children.push(action); }
      else children.push(el('span', 'origin-status-item', 'No open issues'));
      statusbar.replaceChildren(...children);
    }

    function openSection(id) {
      if (!M.SECTIONS.some(item => item.id === id)) return;
      section = id; setPref(SECTION_KEY, id); editing = null; connectFrom = null;
      renderMain();
      main.querySelector('h2')?.focus();
    }
    function focusTarget(target) {
      if (!target) return;
      const sectionId = target.collection === 'areas' ? bp().areas.find(item => item.id === target.id)?.section || target.section : target.section;
      if (target.collection === 'connections') { editing = target.id; section = 'architecture'; }
      else if (target.id) { selected = { collection: target.collection, id: target.id }; editing = target.id; inspectorTab = 'details'; }
      section = sectionId || section; setPref(SECTION_KEY, section);
      focusAfter = () => main.querySelector('.origin-editor input, .origin-editor textarea, .origin-editor select') || main.querySelector('h2');
      renderMain();
    }

    function renderMain() {
      refreshRow = null;
      if (!projectId) { main.replaceChildren(noProjectState()); renderDerived(); return; }
      if (loadError && !record) { main.replaceChildren(errorState()); renderDerived(); return; }
      if (!record) return;
      if (!record.exists) { main.replaceChildren(emptyState()); renderDerived(); return; }
      const scroll = main.scrollTop;
      const content = (SECTIONS[section] || SECTIONS.overview)();
      main.replaceChildren(sectionHeader(), ...content);
      main.scrollTop = scroll;
      renderDerived();
      if (focusAfter) { const target = focusAfter(); focusAfter = null; target?.focus(); target?.scrollIntoView?.({ block: 'nearest' }); }
    }
    function sectionHeader() {
      const box = el('div', 'origin-section-head');
      const title = el('h2', '', M.sectionLabel(section)); title.id = 'origin-section-heading'; title.tabIndex = -1;
      const intro = el('p', 'note', SECTION_INTRO[section]);
      const text = el('div'); text.append(title, intro);
      box.append(text);
      const meta = M.SECTIONS.find(item => item.id === section);
      if (meta.optional) {
        const toggle = el('label', 'check-row origin-na'); const box2 = el('input'); box2.type = 'checkbox'; box2.checked = Boolean(bp().sections[section]?.notApplicable);
        box2.addEventListener('change', () => { if (box2.checked) bp().sections[section] = { notApplicable: true }; else delete bp().sections[section]; changed(); });
        toggle.append(box2, 'Not applicable to this project'); box.append(toggle);
      }
      return box;
    }

    // ---- Empty, error and project states ----
    function noProjectState() {
      const box = el('div', 'origin-empty');
      const projects = app.projects();
      box.append(el('p', 'eyebrow', 'ORIGIN'), el('h2', '', 'Start with the project, not the prompt.'));
      if (projects.length) { box.append(el('p', 'note', 'Choose a project in the header to open its blueprint.')); return box; }
      box.append(el('p', 'intro-description', 'Origin plans one Promptboard project. Name the project and describe what you want to create.'));
      const name = el('input'); name.id = 'origin-new-project'; name.maxLength = 80; name.autocomplete = 'off'; name.placeholder = 'Project name';
      const idea = ideaInput();
      const error = el('p', 'inline-error'); error.hidden = true; error.setAttribute('role', 'alert');
      const start = button('Start project blueprint', async () => {
        if (!name.value.trim()) { error.textContent = 'Enter a project name.'; error.hidden = false; name.focus(); return; }
        start.disabled = true;
        try {
          const created = await app.createProject(name.value.trim());
          app.selectProject(created.id);
          await load(created.id);
          await startBlueprint(idea.value);
        } catch (failure) { error.textContent = failure.message; error.hidden = false; }
        finally { start.disabled = false; }
      }, 'copy-button');
      box.append(field('Project name', name), field('What do you want to create?', idea), el('p', 'note', 'Creates a Promptboard project with its own repository folder, like Kanban → New project. No agent starts.'), start, error, startLinks(false));
      return box;
    }
    function ideaInput() {
      const idea = el('textarea', 'origin-idea'); idea.id = 'origin-idea'; idea.rows = 5; idea.maxLength = 20000; idea.placeholder = 'Describe the product, system, or idea…';
      idea.setAttribute('aria-label', 'What do you want to create?');
      return idea;
    }
    function startLinks(withManual = true) {
      const links = el('div', 'origin-start-links');
      links.append(button('Open existing repository', () => app.openFolder(), 'text-button'), button('Import project context', () => importFile.click(), 'text-button', 'Import an exported Origin blueprint (JSON)'));
      if (withManual) links.append(button('Start manually', () => void startBlueprint(''), 'text-button'));
      return links;
    }
    function emptyState() {
      const box = el('div', 'origin-empty');
      const idea = ideaInput();
      const start = button('Start project blueprint', () => void startBlueprint(idea.value), 'copy-button');
      start.id = 'origin-start';
      box.append(el('p', 'eyebrow', `ORIGIN · ${(project()?.name || '').toUpperCase()}`), el('h2', '', 'Start with the project, not the prompt.'),
        field('What do you want to create?', idea), start, startLinks(true),
        el('p', 'note', 'The blueprint is saved locally for this project. Nothing is generated and no agent starts.'));
      return box;
    }
    function errorState() {
      const box = el('div', 'origin-empty');
      box.append(el('h2', '', 'The blueprint is unavailable'), el('p', 'note', loadError), button('Try again', () => void load(projectId, { force: true })));
      return box;
    }
    async function startBlueprint(idea) {
      if (!record || record.exists) return;
      record.exists = true;
      record.blueprint.idea = idea.trim();
      if (idea.trim() && !record.blueprint.vision.summary) record.blueprint.vision.summary = idea.trim();
      section = idea.trim() ? 'vision' : 'overview'; setPref(SECTION_KEY, section);
      changeCount++;
      const saved = await save();
      if (!saved && saveState !== 'conflict') { record.exists = false; changeCount = savedCount; saveState = 'saved'; showError(saveMessage); }
      focusAfter = () => main.querySelector('h2');
      renderMain(); renderSave();
      if (saved) app.announce(`Blueprint started for ${project()?.name || 'this project'}.`);
    }

    // ---- Editing helpers ----
    function text(target, key, { max = 20000, rows = 0, placeholder = '', type = 'text', label } = {}) {
      const control = el(rows ? 'textarea' : 'input');
      if (rows) control.rows = rows; else control.type = type;
      if (type !== 'date') control.maxLength = max;
      control.value = target[key] || ''; control.placeholder = placeholder; control.spellcheck = rows > 0;
      if (label) control.setAttribute('aria-label', label);
      control.addEventListener('input', () => { target[key] = control.value; changed(); });
      return control;
    }
    function choice(target, key, list, { onChange, label } = {}) {
      const control = el('select');
      for (const [value, name] of list) control.append(Object.assign(el('option', '', name), { value }));
      control.value = target[key];
      if (label) control.setAttribute('aria-label', label);
      control.addEventListener('change', () => { target[key] = control.value; changed({ structure: Boolean(onChange) }); onChange?.(); });
      return control;
    }
    function links(target, key, collection, { exclude, name = item => M.itemName(bp(), collection, item.id) || 'Untitled', options = bp()[collection], empty } = {}) {
      const box = el('details', 'origin-links'), summary = el('summary'), list = el('div', 'origin-link-list');
      const update = () => {
        const names = target[key].map(id => options.find(item => item.id === id)).filter(Boolean).map(name);
        summary.textContent = names.length ? names.join(', ') : 'None linked';
        summary.title = summary.textContent;
      };
      const choices = options.filter(item => item.id !== exclude);
      if (!choices.length) list.append(el('p', 'note', empty || `No ${M.sectionLabel(collection).toLowerCase()} to link yet.`));
      for (const item of choices) {
        const row = el('label', 'check-row'), box2 = el('input'); box2.type = 'checkbox'; box2.checked = target[key].includes(item.id);
        box2.addEventListener('change', () => { target[key] = box2.checked ? [...target[key], item.id] : target[key].filter(id => id !== item.id); update(); changed(); });
        row.append(box2, name(item)); list.append(row);
      }
      box.append(summary, list); update();
      return box;
    }
    function referencesTo(collection, id) {
      const found = [];
      for (const [owner, list] of Object.entries(bp())) {
        if (!Array.isArray(list)) continue;
        for (const entry of list) for (const [field2, value] of Object.entries(entry)) {
          const targetCollection = typeof REFS[field2] === 'function' ? REFS[field2](owner) : REFS[field2];
          if (targetCollection !== collection) continue;
          if (Array.isArray(value) ? value.includes(id) : value === id) found.push({ owner, entry, field: field2 });
        }
      }
      return found;
    }
    function removeEntity(collection, id) {
      const references = referencesTo(collection, id);
      bp()[collection] = bp()[collection].filter(item => item.id !== id);
      for (const { owner, entry, field: field2 } of references) {
        if (owner === 'connections') bp().connections = bp().connections.filter(item => item !== entry);
        else if (Array.isArray(entry[field2])) entry[field2] = entry[field2].filter(value => value !== id);
        else entry[field2] = '';
      }
      planSelection.delete(id);
      if (selected?.id === id) selected = null;
      if (editing === id) editing = null;
      return references.length;
    }
    function deleteControl(collection, item) {
      const remove = button('Delete', () => {
        if (remove.dataset.confirm !== 'true') {
          const count = referencesTo(collection, item.id).length;
          remove.dataset.confirm = 'true'; remove.textContent = count ? `Delete and remove ${plural(count, 'link')}` : 'Confirm delete'; remove.classList.add('danger');
          return;
        }
        const count = removeEntity(collection, item.id);
        app.announce(`${NOUN[collection]} deleted${count ? `; ${plural(count, 'link')} removed` : ''}.`);
        changed({ structure: true });
        main.querySelector('h2')?.focus();
      }, 'text-button origin-delete');
      return remove;
    }
    function toggleEditor(collection, id) {
      const opening = editing !== id;
      editing = opening ? id : null;
      if (opening) { selected = { collection, id }; inspectorTab = 'details'; }
      focusAfter = opening ? () => main.querySelector(`.origin-row[data-id="${CSS.escape(id)}"] .origin-editor :is(input, textarea, select)`)
        : () => main.querySelector(`.origin-row[data-id="${CSS.escape(id)}"] .origin-row-open`);
      renderMain();
    }
    function rowList(collection, items, { summary, editor, empty, leading } = {}) {
      const list = el('ol', 'origin-list');
      if (!items.length) { list.append(el('li', 'origin-empty-row', empty)); return list; }
      for (const item of items) {
        const row = el('li', 'origin-row'); row.dataset.id = item.id;
        if (selected?.id === item.id) row.classList.add('selected');
        const head = el('div', 'origin-row-head');
        const open = el('button', 'origin-row-open'); open.type = 'button'; open.setAttribute('aria-expanded', String(editing === item.id));
        const paint = () => { open.replaceChildren(...summary(item)); if (item.origin === 'ai') open.append(badge('AI suggestion', 'ai')); };
        paint();
        open.addEventListener('click', () => toggleEditor(collection, item.id));
        if (leading) head.append(leading(item));
        head.append(open); row.append(head);
        if (editing === item.id) {
          refreshRow = paint;
          const form = el('div', 'origin-editor'); form.setAttribute('role', 'group'); form.setAttribute('aria-label', `Edit ${NOUN[collection].toLowerCase()}`);
          form.append(...editor(item));
          const actions = el('div', 'detail-actions origin-editor-actions');
          if (COMPOSABLE.has(collection)) actions.append(composeButton(collection, item.id));
          actions.append(deleteControl(collection, item), button('Close', () => toggleEditor(collection, item.id), 'text-button'));
          form.append(actions);
          form.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); toggleEditor(collection, item.id); } });
          row.append(form);
        }
        list.append(row);
      }
      return list;
    }
    const grid = (...nodes) => { const box = el('div', 'origin-grid'); box.append(...nodes); return box; };
    const card = (title, ...nodes) => { const box = el('section', 'origin-card'); if (title) box.append(el('h3', '', title)); box.append(...nodes); return box; };
    const toolbar = (...nodes) => { const box = el('div', 'origin-toolbar'); box.append(...nodes.filter(Boolean)); return box; };
    const key = item => el('span', 'origin-key', item.key);
    const titleText = (value, fallback) => el('span', 'origin-row-title', value?.trim() ? value : fallback);
    const statusBadge = (enumName, value, warn = []) => badge(M.label(enumName, value), warn.includes(value) ? 'warn' : value === 'defined' || value === 'accepted' || value === 'verified' ? 'ok' : '');
    function add(collection, entry, { keyed = false, at } = {}) {
      const item = { id: newId(), origin: 'human', ...entry };
      if (keyed) item.key = M.nextKey(bp(), collection);
      if (at === undefined) bp()[collection].push(item); else bp()[collection].splice(at, 0, item);
      editing = item.id; selected = { collection, id: item.id }; inspectorTab = 'details';
      focusAfter = () => main.querySelector(`.origin-row[data-id="${CSS.escape(item.id)}"] .origin-editor :is(input, textarea, select)`);
      changed({ structure: true });
      return item;
    }
    function evidence(item) {
      const state = M.verification(item, bp().sources);
      const box = el('div', 'origin-evidence');
      box.append(field('Evidence (sources)', links(item, 'sourceIds', 'sources', { empty: 'Add sources in Research first.' })), el('p', 'note', ''));
      box.lastChild.append('Verification: ', verificationBadge(state), state === 'verified' ? ' — supported by a verified source.' : ' — link a verified source in Research. A URL alone does not verify a claim.');
      return box;
    }

    // ---- Sections ----
    const SECTIONS = {
      overview() {
        const blueprint = bp(), found = M.issues(blueprint), ready = M.readiness(blueprint, found);
        const read = (title, value, target) => { const box = card(title); box.append(value?.trim() ? el('p', 'origin-prose', value) : el('p', 'note', 'Not defined yet.')); if (target) box.append(button('Edit in Vision & Scope', () => openSection('vision'), 'text-button')); return box; };
        const objective = card('What are we building?', field('Project objective', text(blueprint.vision, 'summary', { rows: 3, placeholder: 'One or two sentences.' })));
        const components = blueprint.components;
        const architecture = card('Architecture summary', field('Summary', text(blueprint.vision, 'architectureSummary', { rows: 3, placeholder: 'How the main parts fit together.' })),
          el('p', 'note', components.length ? `${plural(components.length, 'component')} · ${plural(blueprint.connections.length, 'connection')}: ${components.slice(0, 8).map(item => item.name || 'Unnamed').join(', ')}${components.length > 8 ? '…' : ''}` : 'No components yet.'),
          button('Open Architecture', () => openSection('architecture'), 'text-button'));
        const unresolved = found.filter(issue => issue.kind === 'unresolved');
        const decisions = card('Unresolved decisions', issueList(unresolved, 'No unresolved decisions.'));
        const risks = blueprint.risks.slice().sort((a, b) => ['high', 'medium', 'low'].indexOf(a.severity) - ['high', 'medium', 'low'].indexOf(b.severity));
        const riskCard = card('Major risks', toolbar(button('＋ Risk', () => add('risks', { title: '', description: '', kind: 'risk', severity: 'medium', mitigation: '', status: 'open', componentIds: [] }), 'secondary-button')),
          rowList('risks', risks, { empty: 'No risks recorded.',
            summary: item => [badge(M.label('severity', item.severity), item.severity === 'high' ? 'warn' : ''), titleText(item.title, 'Untitled risk'), badge(M.label('riskKind', item.kind)), statusBadge('riskStatus', item.status)],
            editor: item => [field('Title', text(item, 'title', { max: 200 })), grid(field('Kind', choice(item, 'kind', M.ENUMS.riskKind)), field('Severity', choice(item, 'severity', M.ENUMS.severity)), field('Status', choice(item, 'status', M.ENUMS.riskStatus))),
              field('Description', text(item, 'description', { rows: 3 })), field('Mitigation', text(item, 'mitigation', { rows: 2 })), field('Affected components', links(item, 'componentIds', 'components')),
              el('p', 'note', item.origin === 'ai' ? 'AI suggestion. Review it before relying on it.' : 'Human-entered. System-detected problems appear in the Inspector.')] }));
        const readinessCard = card('Implementation readiness', readinessTable(ready));
        return [grid(objective, read('Why?', blueprint.vision.problem, true), read('For whom?', blueprint.vision.users, true)),
          grid(read('Key outcomes', blueprint.vision.successCriteria, true), read('Scope', [blueprint.vision.inScope && `In scope:\n${blueprint.vision.inScope}`, blueprint.vision.outOfScope && `Out of scope:\n${blueprint.vision.outOfScope}`].filter(Boolean).join('\n\n'), true), read('Constraints', blueprint.vision.constraints, true)),
          grid(architecture, decisions), readinessCard, riskCard];
      },
      vision() {
        const vision = bp().vision;
        const area = (key2, name, hint, rows = 3, placeholder = '') => field(name, text(vision, key2, { rows, placeholder }), hint);
        return [card('', area('summary', 'Project objective', 'One or two sentences.', 2),
          grid(area('problem', 'Problem', 'What is wrong or missing today?'), area('goal', 'Goal', 'What changes when this exists?')),
          grid(area('users', 'Target users', 'One user group per line.'), area('useCases', 'Use cases', 'One use case per line.')),
          grid(area('inScope', 'In scope', 'One item per line.'), area('outOfScope', 'Out of scope', 'One item per line. Compose and Kanban handoffs carry this as a guardrail.')),
          grid(area('successCriteria', 'Success criteria', 'Observable outcomes, one per line.'), area('constraints', 'Constraints', 'Budget, platform, compliance, deadlines. One per line.')))];
      },
      requirements() {
        const filter = pref('promptboard.origin.requirement-filter', 'all');
        const type = el('select'); type.setAttribute('aria-label', 'Filter requirements by type');
        for (const [value, name] of [['all', 'All types'], ...M.ENUMS.requirementType]) type.append(Object.assign(el('option', '', name), { value }));
        type.value = M.ENUMS.requirementType.some(([id]) => id === filter) ? filter : 'all';
        type.addEventListener('change', () => { setPref('promptboard.origin.requirement-filter', type.value); renderMain(); });
        const items = bp().requirements.filter(item => type.value === 'all' || item.type === type.value);
        return [toolbar(button('＋ Requirement', () => add('requirements', { title: '', description: '', type: type.value === 'all' ? 'functional' : type.value, priority: 'should', status: 'draft', acceptanceCriteria: '', componentIds: [], sourceIds: [] }, { keyed: true }), 'secondary-button'), field('Type', type)),
          rowList('requirements', items, { empty: bp().requirements.length ? 'No requirements of this type.' : 'No requirements yet. Add what the system must do and how you will know it works.',
            summary: item => [key(item), titleText(item.title, 'Untitled requirement'), badge(M.label('requirementType', item.type)), badge(M.label('priority', item.priority)), statusBadge('itemStatus', item.status, ['needs_decision', 'assumption']),
              ...(M.lines(item.acceptanceCriteria).length ? [] : [badge('No criteria', 'warn')])],
            editor: item => [field('Title', text(item, 'title', { max: 200 })),
              grid(field('Type', choice(item, 'type', M.ENUMS.requirementType)), field('Priority', choice(item, 'priority', M.ENUMS.priority)), field('Status', choice(item, 'status', M.ENUMS.itemStatus))),
              field('Description', text(item, 'description', { rows: 3 })), field('Acceptance criteria', text(item, 'acceptanceCriteria', { rows: 4 }), 'One criterion per line.'),
              field('Related components', links(item, 'componentIds', 'components')), evidence(item)] })];
      },
      architecture() {
        const blueprint = bp();
        const name = id => blueprint.components.find(item => item.id === id)?.name || 'Unnamed component';
        return [diagram(),
          el('h3', 'origin-subheading', 'Components'),
          rowList('components', blueprint.components, { empty: 'No components yet.',
            summary: item => [titleText(item.name, 'Unnamed component'), badge(M.label('componentType', item.type)), statusBadge('itemStatus', item.status, ['needs_decision', 'assumption']),
              el('span', 'origin-row-meta', `${plural(blueprint.connections.filter(connection => connection.from === item.id).length, 'dependency', 'dependencies')} · used by ${blueprint.connections.filter(connection => connection.to === item.id).length}`)],
            editor: item => componentEditor(item) }),
          el('h3', 'origin-subheading', 'Connections'),
          rowList('connections', blueprint.connections, { empty: 'No connections yet. Use Connect on the diagram or add dependencies in a component.',
            summary: item => [titleText(`${name(item.from)} → ${name(item.to)}`), el('span', 'origin-row-meta', [item.label, item.protocol].filter(Boolean).join(' · '))],
            editor: item => [grid(field('From', choice(item, 'from', blueprint.components.map(component => [component.id, component.name || 'Unnamed component']))),
              field('To', choice(item, 'to', blueprint.components.map(component => [component.id, component.name || 'Unnamed component'])))),
            grid(field('Relationship', text(item, 'label', { max: 80, placeholder: 'calls, stores, publishes…' })), field('Protocol / interface', text(item, 'protocol', { max: 80, placeholder: 'HTTPS, SQL, gRPC…' }))),
            field('Notes', text(item, 'notes', { rows: 2, max: 2000 }))] })];
      },
      technology() {
        const blueprint = bp(), groups = M.ENUMS.techCategory.filter(([id]) => blueprint.technologies.some(item => item.category === id));
        const category = el('select'); category.setAttribute('aria-label', 'Category for the new technology');
        for (const [value, name] of M.ENUMS.techCategory) category.append(Object.assign(el('option', '', name), { value }));
        const nodes = [toolbar(button('＋ Technology', () => add('technologies', { name: '', category: category.value, purpose: '', version: '', status: 'candidate', reason: '', alternatives: '', sourceIds: [] }), 'secondary-button'), field('Category', category))];
        if (!groups.length) nodes.push(el('p', 'note origin-empty-row', 'No technologies yet. Record each choice with its reason and evidence.'));
        for (const [id, label] of groups) nodes.push(el('h3', 'origin-subheading', label), rowList('technologies', blueprint.technologies.filter(item => item.category === id), {
          summary: item => [titleText(`${item.name}${item.version ? ` ${item.version}` : ''}`, 'Unnamed technology'), statusBadge('techStatus', item.status), ...(item.status === 'rejected' ? [] : [verificationBadge(M.verification(item, blueprint.sources))])],
          editor: item => [grid(field('Name', text(item, 'name', { max: 200 })), field('Version', text(item, 'version', { max: 80 }))),
            grid(field('Category', choice(item, 'category', M.ENUMS.techCategory, { onChange: () => {} })), field('Status', choice(item, 'status', M.ENUMS.techStatus))),
            field('Purpose', text(item, 'purpose', { rows: 2 })), field('Reason selected', text(item, 'reason', { rows: 2 })), field('Alternatives considered', text(item, 'alternatives', { rows: 2 }), 'One per line.'),
            evidence(item), el('p', 'note', `Used by: ${blueprint.components.filter(component => component.technologyIds.includes(item.id)).map(component => component.name || 'Unnamed').join(', ') || 'no component yet'}.`)] }));
        return nodes;
      },
      dependencies() {
        const blueprint = bp();
        return [toolbar(button('＋ Dependency', () => add('dependencies', { name: '', type: 'package', version: '', requiredBy: [], dependsOn: [], sourceIds: [], notes: '' }), 'secondary-button')),
          rowList('dependencies', blueprint.dependencies, { empty: 'No dependencies yet.',
            summary: item => { const state = M.verification(item, blueprint.sources); return [titleText(`${item.name}${item.version ? ` ${item.version}` : ''}`, 'Unnamed dependency'), badge(M.label('dependencyType', item.type)), verificationBadge(state), el('span', 'origin-row-meta', `required by ${item.requiredBy.length}`)]; },
            editor: item => [grid(field('Name', text(item, 'name', { max: 200 })), field('Version', text(item, 'version', { max: 80 })), field('Type', choice(item, 'type', M.ENUMS.dependencyType))),
              grid(field('Required by', links(item, 'requiredBy', 'components')), field('Depends on', links(item, 'dependsOn', 'dependencies', { exclude: item.id }))),
              evidence(item), field('Notes', text(item, 'notes', { rows: 2 }))] })];
      },
      research() {
        const blueprint = bp();
        const usedBy = id => referencesTo('sources', id).map(({ owner, entry }) => M.itemName(blueprint, owner, entry.id)).filter(Boolean);
        return [el('h3', 'origin-subheading', 'Sources'),
          toolbar(button('＋ Source', () => add('sources', { title: '', url: '', type: 'documentation', claim: '', accessedAt: today(), verification: 'unverified', notes: '' }), 'secondary-button'),
            el('p', 'note', 'Prefer official documentation, repositories, standards and primary sources. Origin does not fetch sources; you check them and set the verification.')),
          rowList('sources', blueprint.sources, { empty: 'No sources yet.',
            summary: item => [titleText(item.title || item.url, 'Untitled source'), badge(M.label('sourceType', item.type)), badge(M.label('sourceVerification', item.verification), item.verification === 'verified' ? 'ok' : item.verification === 'unverified' ? '' : 'warn'), el('span', 'origin-row-meta', item.accessedAt ? `accessed ${item.accessedAt}` : 'no access date')],
            editor: item => [field('Title', text(item, 'title', { max: 200 })), urlField(item),
              grid(field('Source type', choice(item, 'type', M.ENUMS.sourceType)), field('Verification', choice(item, 'verification', M.ENUMS.sourceVerification)), field('Date accessed', text(item, 'accessedAt', { type: 'date' }))),
              field('Relevant claim', text(item, 'claim', { rows: 2, max: 4000 }), 'What this source supports or contradicts.'), field('Notes', text(item, 'notes', { rows: 2 })),
              el('p', 'note', `Evidence for: ${usedBy(item.id).join(', ') || 'nothing linked yet'}.`)] }),
          el('h3', 'origin-subheading', 'Assumptions'),
          toolbar(button('＋ Assumption', () => add('assumptions', { statement: '', reason: '', impact: '', status: 'open', decisionId: '', sourceIds: [] }), 'secondary-button'),
            el('p', 'note', 'Assumptions stay visible until they are resolved, marked invalid or turned into a decision.')),
          rowList('assumptions', blueprint.assumptions, { empty: 'No assumptions recorded.',
            summary: item => [badge('ASSUMPTION', 'assumption'), titleText(item.statement, 'Untitled assumption'), statusBadge('assumptionStatus', item.status, ['open', 'invalid'])],
            editor: item => [field('Assumption', text(item, 'statement', { rows: 2, max: 2000 })), grid(field('Reason', text(item, 'reason', { rows: 2 })), field('Impact if false', text(item, 'impact', { rows: 2 }))),
              field('Status', choice(item, 'status', M.ENUMS.assumptionStatus)),
              toolbar(button('Resolve: it holds', () => { item.status = 'validated'; changed({ structure: true }); }), button('Mark invalid', () => { item.status = 'invalid'; changed({ structure: true }); }),
                item.decisionId ? button(`Open ${M.itemName(blueprint, 'decisions', item.decisionId)}`, () => focusTarget({ section: 'decisions', collection: 'decisions', id: item.decisionId }), 'text-button')
                  : button('Convert to decision', () => convertAssumption(item))),
              evidence(item)] })];
      },
      decisions() {
        const blueprint = bp();
        return [toolbar(button('＋ Decision', () => add('decisions', { title: '', context: '', decision: '', alternatives: '', reason: '', consequences: '', status: 'proposed', date: today(), supersededBy: '', componentIds: [], technologyIds: [], requirementIds: [], dependencyIds: [], sourceIds: [] }, { keyed: true }), 'secondary-button')),
          rowList('decisions', blueprint.decisions, { empty: 'No decisions yet. Record important choices with their alternatives and reasons.',
            summary: item => [key(item), titleText(item.title, 'Untitled decision'), el('span', 'origin-row-meta', item.decision ? `→ ${item.decision.split('\n')[0].slice(0, 80)}` : ''), statusBadge('decisionStatus', item.status, ['proposed']), el('span', 'origin-row-meta', item.date)],
            editor: item => [field('Title', text(item, 'title', { max: 200, placeholder: 'Database' })),
              grid(field('Status', choice(item, 'status', M.ENUMS.decisionStatus, { onChange: () => { if (item.status === 'accepted' && !item.date) item.date = today(); } })), field('Date', text(item, 'date', { type: 'date' })),
                field('Superseded by', choice(item, 'supersededBy', [['', 'None'], ...blueprint.decisions.filter(other => other.id !== item.id).map(other => [other.id, M.itemName(blueprint, 'decisions', other.id)])]))),
              item.status === 'accepted' ? el('p', 'note origin-accepted', 'Accepted. Change this decision through a new decision record so its rationale is kept.') : '',
              field('Context', text(item, 'context', { rows: 2 })), field('Decision', text(item, 'decision', { rows: 2 })),
              grid(field('Alternatives', text(item, 'alternatives', { rows: 3 }), 'One per line.'), field('Reason', text(item, 'reason', { rows: 3 }))), field('Consequences', text(item, 'consequences', { rows: 2 })),
              grid(field('Components', links(item, 'componentIds', 'components')), field('Technologies', links(item, 'technologyIds', 'technologies'))),
              grid(field('Requirements', links(item, 'requirementIds', 'requirements')), field('Dependencies', links(item, 'dependencyIds', 'dependencies'))), evidence(item)].filter(Boolean) })];
      },
      plan: () => planSection(),
    };
    for (const id of Object.keys(M.AREAS)) SECTIONS[id] = () => areaSection(id);

    function componentEditor(item) {
      const blueprint = bp();
      const others = blueprint.components.filter(component => component.id !== item.id);
      const outgoing = blueprint.connections.filter(connection => connection.from === item.id), incoming = blueprint.connections.filter(connection => connection.to === item.id);
      const name = id => blueprint.components.find(component => component.id === id)?.name || 'Unnamed component';
      const depends = el('div', 'origin-connections');
      for (const connection of outgoing) {
        const row = el('div', 'origin-connection-row');
        row.append(el('span', 'origin-row-title', `→ ${name(connection.to)}`), text(connection, 'label', { max: 80, placeholder: 'relationship', label: `Relationship to ${name(connection.to)}` }),
          text(connection, 'protocol', { max: 80, placeholder: 'protocol', label: `Protocol to ${name(connection.to)}` }),
          button('Remove', () => { bp().connections = bp().connections.filter(entry => entry !== connection); changed({ structure: true }); }, 'text-button'));
        depends.append(row);
      }
      const target = el('select'); target.setAttribute('aria-label', 'New dependency target');
      target.append(Object.assign(el('option', '', 'Choose a component…'), { value: '' }), ...others.map(component => Object.assign(el('option', '', component.name || 'Unnamed component'), { value: component.id })));
      depends.append(toolbar(target, button('Add dependency', () => {
        if (!target.value) { target.focus(); return; }
        bp().connections.push({ id: newId(), origin: 'human', from: item.id, to: target.value, label: 'calls', protocol: '', notes: '' });
        focusAfter = () => main.querySelector(`.origin-row[data-id="${CSS.escape(item.id)}"] .origin-connection-row:last-of-type input`);
        changed({ structure: true });
      })));
      return [grid(field('Name', text(item, 'name', { max: 200 })), field('Type', choice(item, 'type', M.ENUMS.componentType)), field('Status', choice(item, 'status', M.ENUMS.itemStatus))),
        field('Purpose', text(item, 'purpose', { rows: 2 })), field('Responsibilities', text(item, 'responsibilities', { rows: 3 }), 'One per line.'),
        grid(field('Interfaces', text(item, 'interfaces', { rows: 2 })), field('Data handled', text(item, 'dataHandled', { rows: 2 }))),
        field('Technologies', links(item, 'technologyIds', 'technologies', { empty: 'Add technologies in Technology first.' })),
        field('Depends on', depends), el('p', 'note', `Used by: ${incoming.map(connection => `${name(connection.from)}${connection.label ? ` (${connection.label})` : ''}`).join(', ') || 'no component'}.`),
        field('Notes', text(item, 'notes', { rows: 2 })), evidence(item)];
    }
    function urlField(item) {
      const control = el('input'); control.type = 'url'; control.maxLength = 2000; control.value = item.url; control.placeholder = 'https://…';
      const error = el('small', 'origin-field-error'); error.hidden = true;
      const open = el('a', 'text-button origin-open-link', 'Open source ↗'); open.target = '_blank'; open.rel = 'noopener noreferrer';
      const sync = () => { const url = safeUrl(item.url); open.hidden = !url; if (url) open.href = url; else open.removeAttribute('href'); };
      control.addEventListener('input', () => {
        const value = control.value.trim(), valid = !value || Boolean(safeUrl(value));
        error.hidden = valid; error.textContent = valid ? '' : 'Use an http or https address without a user name or password. It is not saved until it is valid.';
        control.setAttribute('aria-invalid', String(!valid));
        if (valid && item.url !== value) { item.url = value; changed(); }
        sync();
      });
      sync();
      const box = field('URL', control); box.append(error, open);
      return box;
    }
    function convertAssumption(item) {
      const decision = add('decisions', { title: item.statement.slice(0, 200), context: [item.statement, item.reason && `Reason: ${item.reason}`, item.impact && `Impact if false: ${item.impact}`].filter(Boolean).join('\n'),
        decision: '', alternatives: '', reason: '', consequences: '', status: 'proposed', date: today(), supersededBy: '', componentIds: [], technologyIds: [], requirementIds: [], dependencyIds: [], sourceIds: [...item.sourceIds] }, { keyed: true });
      item.status = 'converted'; item.decisionId = decision.id;
      section = 'decisions'; setPref(SECTION_KEY, section);
      changed({ structure: true });
      app.announce(`Assumption converted to ${decision.key}. Complete the decision and accept or reject it.`);
    }

    function areaSection(id) {
      const blueprint = bp(), areas = M.AREAS[id], items = blueprint.areas.filter(item => item.section === id);
      const nodes = [];
      if (blueprint.sections[id]?.notApplicable) nodes.push(el('p', 'note origin-na-note', 'Marked not applicable. Existing entries are kept and still count in the blueprint.'));
      const area = el('select'); area.setAttribute('aria-label', 'Area for the new item');
      for (const [value, name] of areas) area.append(Object.assign(el('option', '', name), { value }));
      nodes.push(toolbar(button('＋ Item', () => add('areas', { section: id, area: area.value, title: '', description: '', status: 'draft', componentIds: [], requirementIds: [], technologyIds: [], baseResourceIds: [] }), 'secondary-button'), field('Area', area)));
      if (id === 'security') {
        const covered = new Set(items.filter(item => item.status === 'defined').map(item => item.area));
        const coverage = el('ul', 'origin-coverage');
        for (const [value, name] of areas) { const entry = el('li', covered.has(value) ? 'covered' : ''); entry.append(el('span', 'origin-glyph', covered.has(value) ? '✓' : '○'), ` ${name}`); entry.title = covered.has(value) ? 'A defined security item exists' : 'No defined item yet'; coverage.append(entry); }
        nodes.push(card(`Security decisions defined: ${covered.size} / ${areas.length} areas`, coverage, el('p', 'note', 'Coverage shows which decisions exist. It is not an assessment of security.')));
      }
      const used = areas.filter(([value]) => items.some(item => item.area === value));
      if (!used.length) nodes.push(el('p', 'note origin-empty-row', 'No items yet.'));
      for (const [value, name] of used) nodes.push(el('h3', 'origin-subheading', name), rowList('areas', items.filter(item => item.area === value), {
        summary: item => [titleText(item.title, 'Untitled item'), statusBadge('itemStatus', item.status, ['needs_decision', 'assumption']),
          el('span', 'origin-row-meta', [item.componentIds.length && plural(item.componentIds.length, 'component'), item.requirementIds.length && plural(item.requirementIds.length, 'requirement'), item.baseResourceIds.length && plural(item.baseResourceIds.length, 'Base resource')].filter(Boolean).join(' · '))],
        editor: item => [grid(field('Title', text(item, 'title', { max: 200 })), field('Area', choice(item, 'area', areas, { onChange: () => {} })), field('Status', choice(item, 'status', M.ENUMS.itemStatus))),
          field('Description', text(item, 'description', { rows: 3 })),
          grid(field('Components', links(item, 'componentIds', 'components')), field(id === 'testing' ? 'Requirements covered' : 'Requirements', links(item, 'requirementIds', 'requirements'))),
          field('Technologies', links(item, 'technologyIds', 'technologies')),
          ...(id === 'ai' ? [baseField(item)] : [])] }));
      return nodes;
    }
    function baseField(item) {
      const box = el('div', 'origin-base');
      if (!baseResources) {
        box.append(el('p', 'note', baseLoading ? 'Loading Base resources…' : 'Base resources are read when needed.'));
        baseLoading ??= app.api('/api/base', { timeoutMs: 30000 }).then(({ response, data }) => {
          baseResources = response.ok && Array.isArray(data.resources) ? data.resources.map(resource => ({ id: resource.id, title: resource.name, kind: resource.type || resource.kind })) : [];
          if (!response.ok) baseResources.failed = true;
        }).catch(() => { baseResources = Object.assign([], { failed: true }); }).finally(() => { baseLoading = null; if (visible) renderMain(); });
        return box;
      }
      const known = new Set(baseResources.map(resource => resource.id));
      const options = [...baseResources, ...item.baseResourceIds.filter(id => !known.has(id)).map(id => ({ id, title: `Missing Base resource (${id})`, kind: 'missing' }))];
      box.append(field('Base resources (referenced, not copied)', links(item, 'baseResourceIds', 'base', { options, name: resource => `${resource.title}${resource.kind && resource.kind !== 'missing' ? ` · ${resource.kind}` : ''}`, empty: baseResources.failed ? 'Base could not be read. Saved references are kept.' : 'Base has no resources yet.' })),
        el('p', 'note', 'Origin only stores resource IDs. It never creates, copies or changes Base resources, and nothing is assigned to an agent.'));
      return box;
    }

    function planSection() {
      const blueprint = bp();
      const tasks = new Map(app.projects().flatMap(item => item.tasks.map(task => [task.id, task])));
      const handoffText = item => { if (!item.handoff) return null; const task = tasks.get(item.handoff.taskId); return badge(task ? `In Kanban${task.number ? ` #${task.number}` : ''}` : 'Sent to Kanban (card removed)', task ? 'ok' : 'warn'); };
      const leading = item => {
        const box2 = el('input'); box2.type = 'checkbox'; box2.className = 'origin-select'; box2.checked = planSelection.has(item.id); box2.setAttribute('aria-label', `Select ${item.key} for Kanban`);
        box2.addEventListener('change', () => { if (box2.checked) planSelection.add(item.id); else planSelection.delete(item.id); renderMain(); });
        return box2;
      };
      const itemRows = items => rowList('items', items, { leading, empty: 'No items.',
        summary: item => [key(item), titleText(item.title, 'Untitled item'), statusBadge('workStatus', item.status), ...(item.workstream ? [badge(item.workstream)] : []),
          ...(item.dependsOn.length ? [el('span', 'origin-row-meta', `after ${item.dependsOn.map(id => blueprint.items.find(entry => entry.id === id)?.key).filter(Boolean).join(', ')}`)] : []), handoffText(item)].filter(Boolean),
        editor: item => [field('Title', text(item, 'title', { max: 200 })),
          grid(field('Milestone', choice(item, 'milestoneId', [['', 'Unscheduled'], ...blueprint.milestones.map(milestone => [milestone.id, milestone.title || 'Untitled milestone'])], { onChange: () => {} })),
            field('Workstream', text(item, 'workstream', { max: 80, placeholder: 'Backend, UI…' })), field('Status', choice(item, 'status', M.ENUMS.workStatus))),
          field('Description', text(item, 'description', { rows: 3 })), field('Acceptance criteria', text(item, 'acceptanceCriteria', { rows: 3 }), 'One per line.'),
          grid(field('Depends on', links(item, 'dependsOn', 'items', { exclude: item.id })), field('Requirements', links(item, 'requirementIds', 'requirements'))),
          field('Components', links(item, 'componentIds', 'components')),
          item.handoff ? el('p', 'note', `Sent to Kanban on ${new Date(item.handoff.at).toLocaleString()}. Creating tasks again adds another card.`) : ''].filter(Boolean) });
      const count = planSelection.size;
      const send = button(`Create Kanban tasks (${count})`, () => openHandoff(), 'copy-button', 'Create To Do cards for the selected items. No agent starts.');
      send.id = 'origin-kanban-handoff'; send.disabled = !count || handoffBusy;
      const nodes = [toolbar(button('＋ Milestone', () => add('milestones', { title: '', goal: '', definitionOfDone: '' }), 'secondary-button'),
        button('＋ Item', () => add('items', { milestoneId: blueprint.milestones.at(-1)?.id || '', workstream: '', title: '', description: '', acceptanceCriteria: '', dependsOn: [], requirementIds: [], componentIds: [], status: 'planned', handoff: null }, { keyed: true }), 'secondary-button'),
        button('Select items not sent', () => { planSelection = new Set(blueprint.items.filter(item => !item.handoff).map(item => item.id)); renderMain(); }, 'text-button'),
        count ? button('Clear selection', () => { planSelection = new Set(); renderMain(); }, 'text-button') : null, send)];
      if (lastHandoff) { const done = el('p', 'note origin-handoff-result', lastHandoff); done.setAttribute('role', 'status'); done.append(' ', button('Open Kanban', () => app.openKanban(), 'text-button')); nodes.push(done); }
      blueprint.milestones.forEach((milestone, index) => {
        const head = el('div', 'origin-milestone');
        const items = blueprint.items.filter(item => item.milestoneId === milestone.id);
        head.append(rowList('milestones', [milestone], {
          summary: item => [el('span', 'origin-key', `M${index + 1}`), titleText(item.title, 'Untitled milestone'), el('span', 'origin-row-meta', plural(items.length, 'item'))],
          editor: item => [field('Title', text(item, 'title', { max: 200 })), field('Goal', text(item, 'goal', { rows: 2 })), field('Definition of done', text(item, 'definitionOfDone', { rows: 3 }), 'One per line.'),
            toolbar(button('Move up', () => moveMilestone(item, -1)), button('Move down', () => moveMilestone(item, 1))), el('p', 'note', 'Deleting a milestone moves its items to Unscheduled.')] }));
        head.append(itemRows(items));
        nodes.push(head);
      });
      const unscheduled = blueprint.items.filter(item => !item.milestoneId);
      if (unscheduled.length || !blueprint.milestones.length) nodes.push(el('h3', 'origin-subheading', blueprint.milestones.length ? 'Unscheduled' : 'Items'), itemRows(unscheduled));
      return nodes;
    }
    function moveMilestone(item, step) {
      const list = bp().milestones, index = list.indexOf(item), next = index + step;
      if (next < 0 || next >= list.length) return;
      list.splice(index, 1); list.splice(next, 0, item);
      focusAfter = () => main.querySelector(`.origin-row[data-id="${CSS.escape(item.id)}"] .origin-editor button`);
      changed({ structure: true });
    }

    // ---- Architecture diagram: an SVG view over components and connections ----
    function positions(blueprint) {
      const map = new Map(), level = new Map(blueprint.components.map(item => [item.id, 0]));
      for (let pass = 0; pass < blueprint.components.length; pass++) {
        let moved = false;
        for (const connection of blueprint.connections) if (level.get(connection.to) <= level.get(connection.from) && level.get(connection.from) < blueprint.components.length) { level.set(connection.to, level.get(connection.from) + 1); moved = true; }
        if (!moved) break;
      }
      const rows = new Map();
      for (const item of blueprint.components) {
        if (item.x !== null && item.y !== null) { map.set(item.id, { x: item.x, y: item.y }); continue; }
        const column = level.get(item.id), row = rows.get(column) || 0; rows.set(column, row + 1);
        map.set(item.id, { x: column * GAP_X, y: row * GAP_Y });
      }
      return map;
    }
    function diagram() {
      const blueprint = bp(), ns = 'http://www.w3.org/2000/svg';
      const wrap = el('section', 'origin-canvas-card'); wrap.setAttribute('aria-label', 'Architecture diagram');
      const connect = button(connectFrom === null ? 'Connect' : 'Cancel connecting', () => { connectFrom = connectFrom === null ? '' : null; renderMain(); }, connectFrom === null ? 'secondary-button' : 'secondary-button origin-active');
      connect.disabled = blueprint.components.length < 2;
      const hint = el('p', 'note origin-canvas-hint', connectFrom === null ? 'Select a component for details. Double-click or press Enter to edit. Drag or use arrow keys to move.'
        : connectFrom ? `Choose the component that ${blueprint.components.find(item => item.id === connectFrom)?.name || 'it'} depends on. Escape cancels.` : 'Choose the component that depends on another. Escape cancels.');
      hint.setAttribute('role', 'status');
      wrap.append(toolbar(button('＋ Component', () => add('components', { name: '', type: 'service', purpose: '', responsibilities: '', technologyIds: [], interfaces: '', dataHandled: '', status: 'draft', notes: '', sourceIds: [], x: null, y: null }), 'secondary-button'),
        connect, button('Auto-arrange', () => { for (const item of bp().components) { item.x = null; item.y = null; } changed({ structure: true }); }, 'secondary-button', 'Lay out components by dependency level'), hint));
      const svg = document.createElementNS(ns, 'svg'); svg.classList.add('origin-canvas'); svg.setAttribute('role', 'group'); svg.setAttribute('aria-label', `Architecture: ${plural(blueprint.components.length, 'component')}, ${plural(blueprint.connections.length, 'connection')}`);
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      const make = (tag, attrs = {}, parent = svg) => { const node = document.createElementNS(ns, tag); for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value)); parent.append(node); return node; };
      const defs = make('defs'), marker = make('marker', { id: 'origin-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs);
      make('path', { d: 'M0 0L10 5L0 10z', class: 'origin-arrow' }, marker);
      if (!blueprint.components.length) {
        svg.setAttribute('viewBox', '0 0 600 200');
        const empty = make('text', { x: 300, y: 100, 'text-anchor': 'middle', class: 'origin-canvas-empty' }); empty.textContent = 'No components yet. Add the main parts of the system, then connect them.';
        wrap.append(svg); return wrap;
      }
      const at = positions(blueprint);
      const edges = make('g', { class: 'origin-edges' }), nodes = make('g', { class: 'origin-nodes' });
      const drawEdges = () => {
        edges.replaceChildren();
        for (const connection of blueprint.connections) {
          const a = at.get(connection.from), b = at.get(connection.to);
          if (!a || !b) continue;
          const reverse = blueprint.connections.some(other => other.from === connection.to && other.to === connection.from);
          const [x1, y1] = [a.x + NODE_W / 2, a.y + NODE_H / 2], [x2, y2] = [b.x + NODE_W / 2, b.y + NODE_H / 2];
          const length = Math.hypot(x2 - x1, y2 - y1) || 1, nx = -(y2 - y1) / length * (reverse ? 7 : 0), ny = (x2 - x1) / length * (reverse ? 7 : 0);
          const clip = (cx, cy, dx, dy) => { const scale = Math.min((NODE_W / 2 + 4) / Math.abs(dx || 1e-9), (NODE_H / 2 + 4) / Math.abs(dy || 1e-9)); return [cx + dx * scale, cy + dy * scale]; };
          const [sx, sy] = clip(x1, y1, x2 - x1, y2 - y1), [ex, ey] = clip(x2, y2, x1 - x2, y1 - y2);
          const group = make('g', { class: `origin-edge${editing === connection.id ? ' selected' : ''}` }, edges);
          make('path', { d: `M${sx + nx} ${sy + ny}L${ex + nx} ${ey + ny}`, 'marker-end': 'url(#origin-arrow)' }, group);
          const words = [connection.label, connection.protocol].filter(Boolean).join(' · ');
          if (words) { const label = make('text', { x: (sx + ex) / 2 + nx, y: (sy + ey) / 2 + ny - 7, 'text-anchor': 'middle', class: 'origin-edge-label' }, group); label.textContent = words.length > 32 ? `${words.slice(0, 31)}…` : words; }
        }
      };
      const fit = () => {
        const xs = [...at.values()].map(point => point.x), ys = [...at.values()].map(point => point.y);
        let minX = Math.min(...xs) - 40, minY = Math.min(...ys) - 40, width = Math.max(...xs) - Math.min(...xs) + NODE_W + 80, height = Math.max(...ys) - Math.min(...ys) + NODE_H + 80;
        if (width < 560) { minX -= (560 - width) / 2; width = 560; }
        if (height < 220) { minY -= (220 - height) / 2; height = 220; }
        svg.setAttribute('viewBox', `${minX} ${minY} ${width} ${height}`);
      };
      const states = new Map(M.issues(blueprint).filter(issue => issue.target?.collection === 'components').map(issue => [issue.target.id, issue.kind]));
      for (const component of blueprint.components) {
        const point = at.get(component.id);
        const node = make('g', { class: `origin-node${selected?.id === component.id ? ' selected' : ''}${connectFrom === component.id ? ' connecting' : ''}${states.has(component.id) ? ' attention' : ''}`, transform: `translate(${point.x} ${point.y})`, tabindex: 0, role: 'button', 'data-id': component.id,
          'aria-label': `${component.name || 'Unnamed component'}, ${M.label('componentType', component.type)}, ${M.label('itemStatus', component.status)}. Enter edits.` }, nodes);
        make('rect', { width: NODE_W, height: NODE_H, rx: 8 }, node);
        const name = make('text', { x: 12, y: 24, class: 'origin-node-name' }, node); name.textContent = (component.name || 'Unnamed component').slice(0, 24) + ((component.name || '').length > 24 ? '…' : '');
        const meta = make('text', { x: 12, y: 43, class: 'origin-node-meta' }, node); meta.textContent = `${M.label('componentType', component.type)} · ${M.label('itemStatus', component.status)}`;
        if (states.has(component.id)) { const mark = make('text', { x: NODE_W - 14, y: 22, 'text-anchor': 'middle', class: 'origin-node-mark' }, node); mark.textContent = states.get(component.id) === 'unresolved' ? '?' : '!'; }
        const title = make('title', {}, node); title.textContent = component.purpose || component.name || 'Component';
        const activate = () => {
          if (connectFrom === null) { selected = { collection: 'components', id: component.id }; inspectorTab = 'details'; focusAfter = () => main.querySelector(`.origin-node[data-id="${CSS.escape(component.id)}"]`); renderMain(); return; }
          if (!connectFrom) { connectFrom = component.id; focusAfter = () => main.querySelector(`.origin-node[data-id="${CSS.escape(component.id)}"]`); renderMain(); return; }
          if (connectFrom === component.id) return;
          const connection = { id: newId(), origin: 'human', from: connectFrom, to: component.id, label: 'calls', protocol: '', notes: '' };
          bp().connections.push(connection); connectFrom = null; editing = connection.id;
          focusAfter = () => main.querySelector(`.origin-row[data-id="${CSS.escape(connection.id)}"] .origin-editor input`);
          app.announce('Connection added. Name the relationship and protocol.');
          changed({ structure: true });
        };
        let drag = null;
        node.addEventListener('pointerdown', event => {
          if (event.button !== 0) return;
          const matrix = svg.getScreenCTM()?.inverse(); if (!matrix) return;
          const start = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix);
          drag = { id: event.pointerId, start, origin: { ...point }, moved: false, matrix };
          node.setPointerCapture?.(event.pointerId);
        });
        node.addEventListener('pointermove', event => {
          if (!drag || event.pointerId !== drag.id) return;
          const now = new DOMPoint(event.clientX, event.clientY).matrixTransform(drag.matrix);
          const dx = now.x - drag.start.x, dy = now.y - drag.start.y;
          if (!drag.moved && Math.hypot(dx, dy) < 4) return;
          drag.moved = true; point.x = Math.round(drag.origin.x + dx); point.y = Math.round(drag.origin.y + dy);
          node.setAttribute('transform', `translate(${point.x} ${point.y})`); drawEdges();
        });
        const finish = event => {
          if (!drag || event.pointerId !== drag.id) return;
          const moved = drag.moved; drag = null;
          if (moved) { for (const [id, value] of at) { const entry = bp().components.find(item => item.id === id); if (entry) { entry.x = value.x; entry.y = value.y; } } changed({ structure: true }); }
          else activate();
        };
        node.addEventListener('pointerup', finish);
        node.addEventListener('pointercancel', () => { drag = null; renderMain(); });
        node.addEventListener('dblclick', () => toggleEditor('components', component.id));
        node.addEventListener('keydown', event => {
          const step = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[event.key];
          if (event.key === 'Enter') { event.preventDefault(); if (connectFrom === null) toggleEditor('components', component.id); else activate(); }
          else if (event.key === ' ') { event.preventDefault(); activate(); }
          else if (step) {
            event.preventDefault();
            for (const [id, value] of at) { const entry = bp().components.find(item => item.id === id); if (entry) { entry.x = value.x; entry.y = value.y; } }
            component.x += step[0]; component.y += step[1];
            focusAfter = () => main.querySelector(`.origin-node[data-id="${CSS.escape(component.id)}"]`);
            changed({ structure: true });
          }
        });
      }
      drawEdges(); fit();
      const scroller = el('div', 'origin-canvas-scroll'); scroller.append(svg);
      wrap.append(scroller);
      return wrap;
    }

    // ---- Inspector ----
    function issueList(list, empty) {
      const box = el('ul', 'origin-issues');
      if (!list.length) { box.append(el('li', 'note', empty)); return box; }
      for (const issue of list) {
        const entry = el('li', `origin-issue origin-issue-${issue.kind}`);
        const open = button('', () => focusTarget(issue.target), 'origin-issue-open');
        open.append(el('span', 'origin-issue-title', issue.title));
        const meta = el('span', 'origin-issue-meta', `${{ system: 'Detected', human: 'Recorded', ai: 'AI suggestion' }[issue.origin]} · ${M.label('riskKind', issue.kind)}${issue.blocking ? '' : ' · advisory'}`);
        open.append(meta);
        if (issue.action) open.title = issue.action;
        entry.append(open); box.append(entry);
      }
      return box;
    }
    function readinessTable(ready) {
      const box = el('div', 'origin-readiness-table');
      const state = el('p', `origin-state origin-state-${ready.state}`, ready.label);
      const reasons = el('ul', 'origin-reasons'); for (const reason of ready.reasons) reasons.append(el('li', '', reason));
      const table = el('dl', 'origin-counts');
      for (const row of ready.rows) {
        const term = el('dt'); term.append(button(row.label, () => openSection(row.section), 'text-button'));
        table.append(term, el('dd', '', row.value));
      }
      box.append(state, reasons, table, el('p', 'note', 'Counts come from saved records. Origin does not score quality.'));
      return box;
    }
    function renderInspector(found = M.issues(bp()), ready = M.readiness(bp(), found)) {
      const tabs = el('div', 'view-switch origin-inspector-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Inspector views');
      const tab = (id, name) => { const node = button(name, () => { inspectorTab = id; renderInspector(); }, ''); node.setAttribute('role', 'tab'); node.setAttribute('aria-selected', String(inspectorTab === id)); node.id = `origin-tab-${id}`; return node; };
      const entry = selected && bp()[selected.collection]?.find(item => item.id === selected.id);
      if (!entry && inspectorTab === 'details') inspectorTab = 'intel';
      tabs.append(tab('intel', 'Intelligence'), tab('details', 'Details'));
      tabs.lastChild.disabled = !entry;
      const panel = el('div', 'origin-inspector-panel'); panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `origin-tab-${inspectorTab}`);
      if (inspectorTab === 'details' && entry) panel.append(...details(selected.collection, entry));
      else {
        const group = (title, list, empty) => { const box = el('section', 'origin-inspector-group'); box.append(el('h3', '', `${title} · ${list.length}`), issueList(list, empty)); return box; };
        const assumptions = bp().assumptions.filter(item => item.status === 'open').map(item => ({ kind: 'unresolved', origin: item.origin, title: item.statement || 'Untitled assumption', blocking: false, target: { section: 'research', collection: 'assumptions', id: item.id } }));
        panel.append(el('p', `origin-state origin-state-${ready.state}`, ready.label), ...ready.reasons.map(reason => el('p', 'note origin-reason', reason)),
          group('Unresolved decisions', found.filter(issue => issue.kind === 'unresolved'), 'None.'),
          group('Assumptions', assumptions.map(item => ({ ...item, kind: 'risk' })), 'No open assumptions.'),
          group('Unverified claims', found.filter(issue => issue.kind === 'unverified'), 'None.'),
          group('Conflicts', found.filter(issue => issue.kind === 'conflict'), 'None.'),
          group('Missing information', found.filter(issue => issue.kind === 'missing' && issue.blocking), 'None.'),
          group('Suggestions', found.filter(issue => !issue.blocking && issue.kind !== 'conflict' && issue.kind !== 'unresolved' && issue.kind !== 'unverified'), 'None.'),
          el('p', 'note', 'Detected items come from fixed rules over saved records. Origin has no AI research yet.'));
      }
      const close = button('×', () => setInspector(false), 'icon-button origin-inspector-close'); close.setAttribute('aria-label', 'Close inspector');
      inspector.replaceChildren(close, tabs, panel);
    }
    function details(collection, entry) {
      const blueprint = bp(), nodes = [];
      nodes.push(el('p', 'eyebrow', NOUN[collection].toUpperCase()), el('h3', 'origin-detail-title', M.itemName(blueprint, collection, entry.id) || (collection === 'connections' ? 'Connection' : 'Untitled')));
      const badges = el('div', 'origin-badges');
      for (const [fieldName, enumName] of [['type', collection === 'requirements' ? 'requirementType' : collection === 'components' ? 'componentType' : collection === 'dependencies' ? 'dependencyType' : ''], ['status', { requirements: 'itemStatus', components: 'itemStatus', areas: 'itemStatus', technologies: 'techStatus', decisions: 'decisionStatus', assumptions: 'assumptionStatus', risks: 'riskStatus', items: 'workStatus' }[collection]], ['verification', collection === 'sources' ? 'sourceVerification' : ''], ['category', collection === 'technologies' ? 'techCategory' : '']]) {
        if (enumName && entry[fieldName]) badges.append(badge(M.label(enumName, entry[fieldName])));
      }
      if (entry.sourceIds) badges.append(verificationBadge(M.verification(entry, blueprint.sources)));
      if (entry.origin === 'ai') badges.append(badge('AI suggestion', 'ai'));
      nodes.push(badges);
      const prose = entry.purpose || entry.description || entry.decision || entry.statement || entry.claim || entry.goal || '';
      if (prose) nodes.push(el('p', 'origin-prose', prose.length > 600 ? `${prose.slice(0, 600)}…` : prose));
      const row = (title, list) => { if (!list.length) return; const box = el('section', 'origin-inspector-group'); box.append(el('h3', '', title)); const ul = el('ul', 'origin-detail-links'); for (const [label, target] of list) { const li = el('li'); li.append(button(label, () => focusTarget(target), 'text-button')); ul.append(li); } box.append(ul); nodes.push(box); };
      const ref = (targetCollection, id) => [M.itemName(blueprint, targetCollection, id) || (targetCollection === 'connections' ? 'Connection' : 'Untitled'), { section: { components: 'architecture', connections: 'architecture', requirements: 'requirements', technologies: 'technology', dependencies: 'dependencies', decisions: 'decisions', assumptions: 'research', sources: 'research', risks: 'overview', milestones: 'plan', items: 'plan', areas: blueprint.areas.find(item => item.id === id)?.section }[targetCollection], collection: targetCollection, id }];
      if (collection === 'components') {
        const name = id => blueprint.components.find(item => item.id === id)?.name || 'Unnamed component';
        row('Depends on', blueprint.connections.filter(item => item.from === entry.id).map(item => [`${name(item.to)}${item.label ? ` (${item.label})` : ''}`, { section: 'architecture', collection: 'connections', id: item.id }]));
        row('Used by', blueprint.connections.filter(item => item.to === entry.id).map(item => [`${name(item.from)}${item.label ? ` (${item.label})` : ''}`, { section: 'architecture', collection: 'connections', id: item.id }]));
      }
      for (const [fieldName, value] of Object.entries(entry)) {
        const target = typeof REFS[fieldName] === 'function' ? REFS[fieldName](collection) : REFS[fieldName];
        if (!target || collection === 'connections' && ['from', 'to'].includes(fieldName) && false) continue;
        const ids = Array.isArray(value) ? value : value ? [value] : [];
        row(REF_LABELS[fieldName], ids.filter(id => blueprint[target]?.some(item => item.id === id)).map(id => ref(target, id)));
      }
      const incoming = referencesTo(collection, entry.id).filter(({ owner }) => !(collection === 'components' && owner === 'connections'));
      row('Referenced by', incoming.map(({ owner, entry: other }) => ref(owner, other.id)));
      if (collection === 'areas' && entry.baseResourceIds.length) row('Base resources', entry.baseResourceIds.map(id => [baseResources?.find(resource => resource.id === id)?.title || id, { section: 'ai', collection: 'areas', id: entry.id }]));
      if (collection === 'sources' && safeUrl(entry.url)) { const link = el('a', 'text-button', 'Open source ↗'); link.href = safeUrl(entry.url); link.target = '_blank'; link.rel = 'noopener noreferrer'; nodes.push(link); }
      const actions = el('div', 'detail-actions');
      actions.append(button(editing === entry.id ? 'Editing' : 'Edit', () => focusTarget(ref(collection, entry.id)[1]), 'secondary-button'));
      if (COMPOSABLE.has(collection)) actions.append(composeButton(collection, entry.id));
      actions.append(button('Show intelligence', () => { selected = null; inspectorTab = 'intel'; renderInspector(); renderMain(); }, 'text-button'));
      nodes.push(actions);
      return nodes;
    }

    // ---- Handoffs ----
    function composeButton(collection, id) {
      const control = button('Send to Compose', async () => {
        const spec = M.composeSpec(bp(), collection, id, project()?.name || '');
        if (!spec) return;
        await flush();
        let result = app.toCompose(spec);
        if (result === 'draft') {
          control.textContent = 'Replace Compose draft?';
          control.classList.add('danger');
          if (control.dataset.confirm !== 'true') { control.dataset.confirm = 'true'; showError('Compose already has unsaved text. Choose “Replace Compose draft?” to replace it, or copy that text first.'); return; }
          result = app.toCompose({ ...spec, replace: true });
        }
        if (result === 'busy') { showError('Compose is generating a prompt. Wait for it or cancel it, then try again.'); return; }
        showError('');
        app.announce(`Opened ${spec.title} in Compose. Review the prompt, then choose Generate. Nothing was generated.`);
      }, 'secondary-button', 'Prefill Compose with this item and its direct relationships. Nothing is generated.');
      control.classList.add('origin-compose');
      return control;
    }

    let handoffDialog = null;
    function openHandoff() {
      const blueprint = bp(), selection = [...planSelection].filter(id => blueprint.items.some(item => item.id === id));
      if (!selection.length) return;
      const target = project();
      const tasks = M.kanbanTasks(blueprint, selection, target?.name || '');
      handoffDialog ??= (() => { const dialog = el('dialog', 'kanban-dialog origin-dialog'); dialog.id = 'origin-handoff-dialog'; dialog.setAttribute('aria-labelledby', 'origin-handoff-heading'); document.body.append(dialog); return dialog; })();
      const dialog = handoffDialog;
      const heading = el('h2', '', 'Create Kanban tasks'); heading.id = 'origin-handoff-heading';
      const list = el('ol', 'origin-handoff-list');
      for (const task of tasks) { const item = blueprint.items.find(entry => entry.id === task.itemId); const li = el('li', '', task.title); if (item.handoff) li.append(' ', badge('already sent', 'warn')); list.append(li); }
      const error = el('p', 'inline-error'); error.hidden = true; error.setAttribute('role', 'alert');
      const confirm = button(`Create ${plural(tasks.length, 'card')} in To Do`, async () => {
        confirm.disabled = true; handoffBusy = true;
        const created = [];
        try {
          for (const task of tasks) {
            const result = await app.createTask({ projectId, title: task.title, prompt: task.prompt });
            const item = bp().items.find(entry => entry.id === task.itemId);
            if (item && result?.task?.id) { item.handoff = { projectId, taskId: result.task.id, at: Date.now() }; created.push(task.title); changed(); }
          }
        } catch (failure) {
          error.textContent = `${failure.message}${created.length ? ` ${plural(created.length, 'card')} already created: ${created.join(', ')}.` : ' No card was created.'}`;
          error.hidden = false;
        } finally { handoffBusy = false; confirm.disabled = false; await flush(); }
        if (!error.hidden) { renderMain(); return; }
        dialog.close();
        planSelection = new Set();
        lastHandoff = `Created ${plural(created.length, 'card')} in To Do of ${target?.name || 'this project'}, in dependency order. No agent started.`;
        app.announce(lastHandoff);
        renderMain();
      }, 'dialog-done');
      confirm.id = 'origin-handoff-confirm';
      const close = button('×', () => dialog.close(), 'dialog-close icon-button'); close.setAttribute('aria-label', 'Close');
      const actions = el('div', 'kanban-dialog-actions'); actions.append(button('Cancel', () => dialog.close()), confirm);
      dialog.replaceChildren(close, el('p', 'eyebrow', `KANBAN · ${(target?.name || '').toUpperCase()}`), heading,
        el('p', 'note', 'Each selected item becomes one To Do card, dependencies first. Cards include the item’s acceptance criteria, linked requirements and components, and an Origin reference. No agent starts; you start work from Kanban.'),
        list, error, actions);
      dialog.showModal();
      confirm.focus();
    }

    // ---- Import and export ----
    function exportBlueprint() {
      tools.open = false;
      if (!record?.exists) { showError('Start a blueprint before exporting it.'); return; }
      const data = { schema: M.SCHEMA, version: M.VERSION, kind: 'export', projectName: project()?.name || '', exportedAt: new Date().toISOString(), blueprint: bp() };
      const url = URL.createObjectURL(new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' }));
      const link = el('a'); link.href = url; link.download = `${(project()?.name || 'project').replace(/[^\w.-]+/g, '-').slice(0, 60)}-origin-blueprint.json`;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      app.announce('Blueprint exported.');
    }
    importFile.addEventListener('change', async () => {
      tools.open = false;
      const file = importFile.files?.[0]; importFile.value = '';
      if (!file || !projectId || !record) return;
      if (file.size > 4 * 1024 * 1024) { showError('Choose a blueprint file smaller than 4 MiB.'); return; }
      let data;
      try { data = JSON.parse(await file.text()); } catch { showError('This file is not valid JSON. Nothing was imported.'); return; }
      const blueprint = data?.schema === M.SCHEMA && data.blueprint ? data.blueprint : data;
      if (!blueprint || typeof blueprint !== 'object' || Array.isArray(blueprint)) { showError('This file does not contain an Origin blueprint. Nothing was imported.'); return; }
      if (record.exists && !window.confirm('Importing replaces this project’s blueprint. Export it first if you want to keep it. Replace the blueprint?')) return;
      if (!(await flush()) && saveState !== 'conflict') return;
      const { response, data: result } = await app.api(`/api/origin/projects/${encodeURIComponent(projectId)}`, { method: 'PUT', body: { expectedRevision: record.revision, blueprint }, timeoutMs: 30000 })
        .catch(() => ({ response: { ok: false }, data: {} }));
      if (!response.ok) { showError(result.error || 'The blueprint could not be imported. The saved blueprint is unchanged.'); return; }
      await load(projectId, { force: true });
      showNotice(`Blueprint imported${result.repairs ? `; ${plural(result.repairs, 'invalid entry', 'invalid entries')} or broken links were removed` : ''}.`);
      app.announce('Blueprint imported.');
    });

    // ---- Keyboard ----
    view.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save({ force: changeCount !== savedCount }); return; }
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (connectFrom !== null) { event.preventDefault(); connectFrom = null; renderMain(); return; }
      if (narrow() && inspectorOpen()) { event.preventDefault(); setInspector(false); }
    });
    readinessButton.addEventListener('click', () => { selected = null; inspectorTab = 'intel'; if (!inspectorOpen()) setInspector(true); renderInspector(); });

    return { show, leave, flush, refresh: () => { if (visible) { renderProjects(); renderDerived(); } },
      state: () => ({ projectId, revision: record?.revision ?? null, exists: Boolean(record?.exists), section, saveState, blueprint: record?.blueprint || null }) };
  }

  return { create };
})();
