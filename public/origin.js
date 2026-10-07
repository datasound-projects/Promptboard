'use strict';

// Origin: the project blueprint workspace. Every section is a short list you type into, one drawer edits
// one record, and the Overview draws the whole blueprint as a mind map. Origin owns its blueprint requests
// and reaches Compose and Kanban only through explicit application seams. All user text is rendered as DOM
// text. Nothing here starts an agent, calls a model or fetches a source.
window.PromptboardOrigin = (() => {
  const M = globalThis.PromptboardOriginModel;
  const SECTION_KEY = 'promptboard.origin.section', MORE_KEY = 'promptboard.origin.more', PROJECT_KEY = 'promptboard.origin.project';
  const SAVE_DELAY = 700, SAVE_MAX_WAIT = 3000;
  const NODE_W = 184, NODE_H = 58, GAP_X = 270, GAP_Y = 100;
  // Built-in guiding questions. Each project can reword them; the wording never changes what a section does.
  const QUESTION = {
    overview: 'Your whole project on one map. Click any branch to work on it.',
    vision: 'Why does this exist, and who is it for?',
    requirements: 'What must it do — and how will you know it works?',
    architecture: 'What are the building blocks, and how do they connect?',
    technology: 'What will you build it with, and why?',
    dependencies: 'What does it rely on that you do not build yourself?',
    data: 'What data does it handle, and where does it live?',
    ai: 'Where does AI help, and how is it kept in check?',
    security: 'How is it protected?',
    testing: 'How will you prove it works?',
    deployment: 'Where and how does it run?',
    observability: 'How will you see what is happening?',
    research: 'What did you check, what are you assuming, and what could go wrong?',
    decisions: 'What have you decided, and why?',
    plan: 'In what order will you build it?',
  };
  const MAP_LEFT = ['vision', 'requirements', 'architecture', 'technology', 'dependencies', 'data', 'ai'];
  const MAP_RIGHT = ['security', 'testing', 'deployment', 'observability', 'research', 'decisions', 'plan'];
  const NOUN = { requirements: 'Requirement', components: 'Component', connections: 'Connection', technologies: 'Technology', dependencies: 'Dependency', decisions: 'Decision',
    assumptions: 'Assumption', sources: 'Source', risks: 'Risk', areas: 'Approach', milestones: 'Milestone', items: 'Step' };
  // Reference fields → the collection they point to. Used for deletes and “used by”.
  const REFS = { componentIds: 'components', technologyIds: 'technologies', requirementIds: 'requirements', dependencyIds: 'dependencies', sourceIds: 'sources',
    requiredBy: 'components', dependsOn: owner => (owner === 'dependencies' ? 'dependencies' : 'items'), supersededBy: 'decisions', decisionId: 'decisions',
    milestoneId: 'milestones', from: 'components', to: 'components' };
  const COMPOSABLE = new Set(['requirements', 'components', 'decisions', 'milestones', 'items']);
  const BLANK = {
    requirements: title => ({ title, description: '', type: 'functional', priority: 'should', status: 'draft', acceptanceCriteria: '', componentIds: [], sourceIds: [] }),
    components: name => ({ name, type: 'service', purpose: '', responsibilities: '', technologyIds: [], interfaces: '', dataHandled: '', status: 'draft', notes: '', sourceIds: [], x: null, y: null, layerId: '', answers: {} }),
    technologies: name => ({ name, category: 'other', purpose: '', version: '', status: 'candidate', reason: '', alternatives: '', sourceIds: [] }),
    dependencies: name => ({ name, type: 'package', version: '', requiredBy: [], dependsOn: [], sourceIds: [], notes: '' }),
    decisions: title => ({ title, context: '', decision: '', alternatives: '', reason: '', consequences: '', status: 'proposed', date: today(), supersededBy: '', componentIds: [], technologyIds: [], requirementIds: [], dependencyIds: [], sourceIds: [] }),
    assumptions: statement => ({ statement, reason: '', impact: '', status: 'open', decisionId: '', sourceIds: [] }),
    sources: text => { const url = safeUrl(text); return { title: url ? hostOf(url) : text, url, type: 'documentation', claim: '', accessedAt: today(), verification: 'unverified', notes: '' }; },
    risks: title => ({ title, description: '', kind: 'risk', severity: 'medium', mitigation: '', status: 'open', componentIds: [] }),
    milestones: title => ({ title, goal: '', definitionOfDone: '' }),
    items: title => ({ milestoneId: '', workstream: '', title, description: '', acceptanceCriteria: '', dependsOn: [], requirementIds: [], componentIds: [], status: 'planned', handoff: null }),
    areas: (title, section, area) => ({ section, area, title, description: '', status: 'defined', componentIds: [], requirementIds: [], technologyIds: [], baseResourceIds: [] }),
  };

  const el = (tag, className = '', text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const button = (text, onClick, className = 'origin-ghost', title = '') => { const node = el('button', className, text); node.type = 'button'; if (title) node.title = title; node.addEventListener('click', onClick); return node; };
  const chip = (text, tone = '') => el('span', `origin-chip${tone ? ` ${tone}` : ''}`, text);
  const pref = (key, fallback = '') => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
  const setPref = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
  const newId = () => globalThis.crypto?.randomUUID?.() || `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  function today() { return new Date().toLocaleDateString('en-CA'); }
  function safeUrl(value) { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; } }
  function hostOf(value) { try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return ''; } }
  const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
  const firstLine = text => M.lines(text)[0] || '';
  const clip = (text, max) => { const value = String(text || '').trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };
  function icon(d, size = 16) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'aria-hidden': 'true' })) svg.setAttribute(name, value);
    const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', d); svg.append(path);
    return svg;
  }
  const ICON = { edit: 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4', plus: 'M12 5v14M5 12h14', minus: 'M5 12h14', fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5', grip: 'M20 10L10 20M20 15l-5 5M20 4L4 20', close: 'M6 6l12 12M18 6 6 18', dots: 'M5 12h.01M12 12h.01M19 12h.01', arrow: 'M5 12h14M13 6l6 6-6 6', link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1' };
  function autoGrow(area) {
    const fit = () => { if (!area.isConnected) return; area.style.height = 'auto'; area.style.height = `${area.scrollHeight + 2}px`; };
    area.addEventListener('input', fit); requestAnimationFrame(fit);
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
      button('Delete from Origin…', () => { menu.open = false; openDelete(); }, 'origin-menu-item danger'));
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
    const main = el('section', 'origin-main'); main.id = 'origin-main'; main.setAttribute('aria-labelledby', 'origin-section-heading');
    const drawer = el('aside', 'origin-drawer'); drawer.id = 'origin-drawer'; drawer.hidden = true; drawer.tabIndex = -1; drawer.setAttribute('aria-labelledby', 'origin-drawer-title');
    view.append(heading, header, errorBox, notice, main, drawer);

    let projects = [], projectId = null, record = null, loading = null, loadError = null, visible = false;
    let section = pref(SECTION_KEY) || 'overview';
    let open = null, connectFrom = null, planSelection = new Set(), handoffBusy = false, lastHandoff = '';
    let views = { map: null, canvas: null }, mapLinkFrom = null, selectedLink = null;
    let saveTimer = null, saving = null, changeCount = 0, savedCount = 0, saveState = 'saved', saveMessage = '', dirtySince = 0, shownSaveError = '';
    let baseResources = null, baseLoading = null, focusAfter = null, renderFrame = 0, uid = 0;
    const bp = () => record.blueprint;
    // The sidebar reads top to bottom as the order of work, in this project's own names.
    const phases = () => M.phaseList(record?.exists ? bp() : null).map((phase, index) => ({ ...phase, number: String(index + 1).padStart(2, '0') }));
    const order = () => phases().flatMap(phase => phase.sections);
    const phaseOf = id => phases().find(phase => phase.sections.includes(id)) || phases()[0];
    const sectionName = id => M.sectionTitle(record?.exists ? bp() : null, id);
    const isCustom = id => Boolean(record?.exists && bp().customSections.some(entry => entry.id === id));
    const topicName = (id, topic) => M.questionText(bp(), `topic:${id}:${topic}`, M.label(id, topic));
    const project = () => projects.find(item => item.id === projectId) || null;
    const kanbanTasks = () => new Map(app.projects().flatMap(item => item.tasks.map(task => [task.id, task])));
    const showError = message => { errorBox.textContent = message; errorBox.hidden = !message; };
    const showNotice = message => { notice.textContent = message; notice.hidden = !message; };

    // ---- Saving: debounced, revision-checked autosave with a visible state ----
    function changed({ structure = false, drawer: redraw = false } = {}) {
      if (!record?.exists) return;
      changeCount++;
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
          if (data.project) projects = projects.map(item => (item.id === id ? data.project : item));
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
      const text = { saved: 'Saved', dirty: 'Editing…', saving: 'Saving…', error: 'Not saved', conflict: 'Changed in another window' }[saveState];
      const dot = el('span', 'origin-save-dot'); dot.setAttribute('aria-hidden', 'true');
      saveStatus.append(dot, el('span', '', text));
      saveStatus.title = saveMessage || (saveState === 'saved' ? `Saved revision ${record.revision}` : text);
      if (saveState === 'error') saveStatus.append(button('Retry', () => void save({ force: true }), 'origin-link'));
      if (saveState === 'conflict') saveStatus.append(button('Reload saved version', () => void load(projectId, { force: true }), 'origin-link'),
        button('Keep mine', () => void keepMine(), 'origin-link', 'Save this window’s version over the newer saved one'));
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
      projectId = id; record = null; loadError = null; open = null; connectFrom = null; planSelection = new Set(); lastHandoff = '';
      views = { map: null, canvas: null }; mapLinkFrom = null; selectedLink = null;
      changeCount = savedCount = 0; dirtySince = 0; saveState = 'saved'; showNotice(''); showError('');
      renderDrawer();
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
      return true;
    }
    async function show() {
      visible = true;
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
    async function leave() { visible = false; connectFrom = null; mapLinkFrom = null; await flush(); }

    async function switchProject(id) {
      if (id === projectId) return;
      if (!(await flush())) { projectSelect.value = projectId; showError('This blueprint has unsaved changes. Save or reload it before switching projects.'); return; }
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
      projectSelect.hidden = menu.hidden = linkChip.hidden = !current;
      if (!current) return;
      const linked = current.kanban;
      linkChip.replaceChildren(el('span', `origin-link-dot${linked?.exists ? ' on' : ''}`), el('span', '', linked?.exists ? `Kanban · ${linked.name}` : linked ? 'Kanban project removed' : 'Not on Kanban'));
      linkChip.title = linked?.exists ? 'Open this project on Kanban' : 'Connect this project to Kanban';
      linkChip.dataset.state = linked?.exists ? 'linked' : linked ? 'missing' : 'none';
    }
    function renderDerived() {
      view.dataset.empty = String(!record?.exists);
      if (!record?.exists) { navigator.replaceChildren(el('p', 'origin-nav-empty', record || !projectId ? 'Your blueprint sections appear here once you start.' : 'Loading…')); readinessButton.hidden = true; return; }
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
      if (counts[id] !== undefined) return counts[id];
      if (M.AREAS[id]) return blueprint.areas.filter(item => item.section === id).length;
      return blueprint.questions.filter(question => question.sectionId === id && blueprint.answers[question.id]?.trim()).length;
    }
    function renderNavigator(states) {
      // A rename in progress is never thrown away by a redraw.
      if (navigator.contains(document.activeElement) && document.activeElement.matches('.origin-inline-input')) return;
      const focused = navigator.contains(document.activeElement) ? document.activeElement.dataset.section : null;
      const groups = phases().map(phase => {
        const box = el('div', `origin-phase phase-${phase.id}`);
        const label = el('div', 'origin-phase-label');
        const builtin = M.PHASES.find(entry => entry.id === phase.id).label;
        const add = button('', () => addSection(phase.id), 'origin-icon origin-phase-add', `Add a section to ${phase.label}`);
        add.setAttribute('aria-label', `Add a section to ${phase.label}`); add.append(icon(ICON.plus, 13));
        label.append(el('span', 'origin-phase-number', phase.number),
          renamable(el('span', 'origin-phase-name', phase.label), { key: `phase:${phase.id}`, value: phase.label, fallback: builtin, label: `${phase.label} name`, max: 60,
            onSave: value => { if (value) bp().labels.phases[phase.id] = value; else delete bp().labels.phases[phase.id]; changed({ structure: true }); } }), add);
        const list = el('ul');
        for (const id of phase.sections) {
          const meaning = M.SECTION_STATE[states[id]][1];
          const item = el('button', 'origin-nav-item'); item.type = 'button'; item.dataset.section = id; item.title = meaning;
          if (id === section) item.setAttribute('aria-current', 'page');
          const dot = el('span', 'origin-dot'); dot.dataset.state = states[id]; dot.setAttribute('aria-hidden', 'true');
          item.append(dot, el('span', 'origin-nav-label', sectionName(id)), el('span', 'sr-only', `, ${meaning}`));
          const count = id === 'overview' ? 0 : sectionCount(id);
          if (count) item.append(el('span', 'origin-nav-count', String(count)));
          item.addEventListener('click', () => { openSection(id); app.closeSidebar(); });
          item.addEventListener('keydown', event => {
            const ids = order(), index = ids.indexOf(id);
            const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: ids.length - 1 }[event.key];
            if (next === undefined) return;
            event.preventDefault();
            navigator.querySelector(`[data-section="${CSS.escape(ids[(next + ids.length) % ids.length])}"]`)?.focus();
          });
          const entry = el('li'); entry.append(item); list.append(entry);
        }
        box.append(label, list);
        return box;
      });
      navigator.replaceChildren(...groups);
      if (focused) navigator.querySelector(`[data-section="${CSS.escape(focused)}"]`)?.focus();
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
      section = id; setPref(SECTION_KEY, id); connectFrom = null; mapLinkFrom = null; selectedLink = null;
      if (open && sectionOf(open) !== id) { open = null; renderDrawer(); }
      renderMain();
      window.scrollTo(0, 0);
      main.querySelector('h2')?.focus({ preventScroll: true });
    }
    function sectionOf(target) {
      if (target.collection === 'areas') return bp().areas.find(item => item.id === target.id)?.section;
      return { requirements: 'requirements', components: 'architecture', connections: 'architecture', technologies: 'technology', dependencies: 'dependencies', decisions: 'decisions',
        assumptions: 'research', sources: 'research', risks: 'research', milestones: 'plan', items: 'plan' }[target.collection];
    }
    function focusTarget(target) {
      if (!target) return;
      if (target.collection === 'connections') { const connection = bp().connections.find(item => item.id === target.id); target = connection ? { collection: 'components', id: connection.from } : { section: 'architecture' }; }
      const id = target.collection ? sectionOf(target) || target.section : target.section;
      if (id && id !== section) { section = id; setPref(SECTION_KEY, id); renderMain(); window.scrollTo(0, 0); }
      if (target.collection && target.id) openDrawer(target.collection, target.id);
      else main.querySelector('h2')?.focus();
    }

    function renderMain() {
      if (renderFrame) { cancelAnimationFrame(renderFrame); renderFrame = 0; }
      if (record?.exists && !order().includes(section)) section = 'overview';
      const phase = phaseOf(section);
      main.className = `origin-main phase-${phase.id}${['overview', 'architecture'].includes(section) ? ' origin-wide' : ''}`;
      view.dataset.section = section;
      if (!projectId) { main.className = 'origin-main phase-define'; main.replaceChildren(startState()); renderDerived(); return; }
      if (loadError && !record) { main.replaceChildren(errorState()); renderDerived(); return; }
      if (!record) return;
      const y = window.scrollY;
      const body = isCustom(section) ? customSection(section) : [...(SECTIONS[section] || SECTIONS.overview)(), ...(section === 'overview' ? [] : questionsBlock(section))];
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
        onSave: value => {
          if (custom) custom.title = value || 'New section';
          else if (value) bp().labels.sections[section] = value; else delete bp().labels.sections[section];
          changed({ structure: true });
        } });
      text.append(el('p', 'origin-eyebrow', `${phase.number} · ${phase.label}`), rename);
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
          if (refocus) view.querySelector(`[data-edit="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
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
      for (const phase of phases()) { const step = el('li', `phase-${phase.id}`); step.append(el('span', 'origin-flow-dot'), phase.label); strip.append(step); }
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
      const kanban = kanbanOption('origin-first-kanban');
      const error = el('p', 'origin-inline-error'); error.hidden = true; error.setAttribute('role', 'alert');
      const start = el('button', 'origin-primary', 'Start blueprint'); start.type = 'submit'; start.id = 'origin-start'; start.append(icon(ICON.arrow, 16));
      const actions = el('div', 'origin-hero-actions'); actions.append(start, el('span', 'origin-hint', '⌘/Ctrl + Enter'));
      form.append(name, idea, kanban.box, actions, error);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        error.hidden = true;
        if (!name.value.trim()) { error.textContent = 'Give the project a name first.'; error.hidden = false; name.focus(); return; }
        start.disabled = true;
        try { await createProject(name.value, idea.value, kanban.input.checked); }
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
    async function createProject(name, description, createKanban) {
      const { response, data } = await app.api('/api/origin/projects', { method: 'POST', body: { name: name.trim(), description: description.trim(), createKanban }, timeoutMs: 120000 })
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
    function modal(id, { eyebrow = 'Origin', title, lead = '', body = [] }) {
      dialogs[id] ??= (() => { const dialog = el('dialog', 'origin-modal'); dialog.id = id; dialog.setAttribute('aria-labelledby', `${id}-heading`); document.body.append(dialog); return dialog; })();
      const dialog = dialogs[id];
      const heading = el('h2', '', title); heading.id = `${id}-heading`;
      const close = button('', () => dialog.close(), 'origin-icon origin-modal-close'); close.setAttribute('aria-label', 'Close'); close.append(icon(ICON.close));
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
      const idea = el('textarea'); idea.id = 'origin-new-idea'; idea.rows = 4; idea.maxLength = 20000; idea.placeholder = 'What do you want to build? (optional)';
      const kanban = kanbanOption('origin-new-kanban');
      modal('origin-new-dialog', { title: 'New project', lead: 'Name it and describe the idea. You shape the design step by step; no agent starts.',
        body: [dialogForm('origin-new-dialog', [field('Name', name), field('Description', idea), kanban.box], 'Create project', async () => {
          if (!name.value.trim()) { name.focus(); throw new Error('Give the project a name.'); }
          if (!(await flush())) throw new Error('This blueprint has unsaved changes. Save or reload it first.');
          await createProject(name.value, idea.value, kanban.input.checked);
        })] });
      name.focus();
    }
    function openRename() {
      const current = project(); if (!current) return;
      const name = el('input'); name.id = 'origin-rename-name'; name.maxLength = 80; name.value = current.name;
      modal('origin-rename-dialog', { title: 'Rename project', body: [dialogForm('origin-rename-dialog', [field('Name', name)], 'Rename', async () => {
        if (!(await flush())) throw new Error('This blueprint has unsaved changes. Save or reload it first.');
        const { response, data } = await app.api(`/api/origin/projects/${encodeURIComponent(current.id)}`, { method: 'PATCH', body: { expectedRevision: record.revision, name: name.value }, timeoutMs: 30000 })
          .catch(() => ({ response: { ok: false }, data: {} }));
        if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'The project could not be renamed.');
        record.revision = data.revision; projects = projects.map(item => (item.id === current.id ? data.project : item));
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
        const data = await call(`/api/origin/projects/${encodeURIComponent(current.id)}/link`, { expectedRevision: record.revision, kanbanProjectId: null }, 'The link could not be removed.').catch(failure => { showError(failure.message); return null; });
        if (!data) return;
        record.revision = data.revision; projects = projects.map(item => (item.id === current.id ? data.project : item));
        dialogs['origin-connect-dialog']?.close(); render(); app.announce('Kanban link removed. Kanban work is unchanged.');
      }, 'origin-link') : null;
      modal('origin-connect-dialog', { title: 'Connect to Kanban', lead: 'Choose where this project’s tasks go. Nothing is created or sent until you choose Connect.',
        body: [dialogForm('origin-connect-dialog', [existing.label, pick, fresh.label, name, destination, ...(unlink ? [unlink] : [])], 'Connect', async () => {
          if (!(await flush())) throw new Error('This blueprint has unsaved changes. Save or reload it first.');
          const body = existing.radio.checked ? { expectedRevision: record.revision, kanbanProjectId: pick.value } : { expectedRevision: record.revision, createKanban: true, name: name.value };
          if (existing.radio.checked && !pick.value) throw new Error('Choose a Kanban project.');
          const data = await call(`/api/origin/projects/${encodeURIComponent(current.id)}/link`, body, 'The project could not be connected. The design is unchanged.');
          record.revision = data.revision; projects = projects.map(item => (item.id === current.id ? data.project : item));
          await app.ensureBoard({ ifChanged: true });
          render(); app.announce(`Connected to Kanban › ${data.project.kanban?.name || ''}.`);
          then?.();
        })] });
      (existing.radio.checked ? pick : name).focus();
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
          const data = await call(`/api/origin/projects/${encodeURIComponent(current.id)}/delete`, { expectedRevision: record.revision, deleteKanban: alsoInput.checked, expectedKanbanRevision: current.kanban?.revision },
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
      form.append(icon(ICON.plus, 16), control);
      if (extra) form.append(extra);
      form.append(el('kbd', 'origin-kbd', '↵'));
      form.addEventListener('submit', event => {
        event.preventDefault();
        const value = control.value.trim();
        if (!value) return;
        control.value = '';
        focusAfter = () => main.querySelector(`[data-quick="${CSS.escape(id)}"]`);
        onAdd(value);
      });
      return form;
    }
    function add(collection, entry, { keyed = false, edit = false } = {}) {
      const item = { id: newId(), origin: 'human', ...entry };
      if (keyed) item.key = M.nextKey(bp(), collection);
      bp()[collection].push(item);
      changed({ structure: true });
      if (edit) openDrawer(collection, item.id);
      app.announce(`${NOUN[collection]} added.`);
      return item;
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
          const targetCollection = typeof REFS[name] === 'function' ? REFS[name](owner) : REFS[name];
          if (targetCollection !== collection) continue;
          if (Array.isArray(value) ? value.includes(id) : value === id) found.push({ owner, entry, field: name });
        }
      }
      return found;
    }
    function removeEntity(collection, id) {
      const references = referencesTo(collection, id);
      bp()[collection] = bp()[collection].filter(item => item.id !== id);
      for (const { owner, entry, field: name } of references) {
        if (owner === 'connections') bp().connections = bp().connections.filter(item => item !== entry);
        else if (Array.isArray(entry[name])) entry[name] = entry[name].filter(value => value !== id);
        else entry[name] = '';
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
        essentials: [field('Type', select(item, 'type', M.ENUMS.componentType, { structure: true })), ask(item, 'purpose', 'What it does', 'Its job in one or two sentences'), group('Connects to', connectionsEditor(item)),
          componentQuestions(item)],
        more: [ask(item, 'responsibilities', 'Responsibilities', 'One per line'), ask(item, 'interfaces', 'Interfaces', 'APIs, events, files…'), ask(item, 'dataHandled', 'Data it handles'),
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
      milestones: item => ({
        title: ['title', 'Milestone'],
        essentials: [field('Goal', area(item, 'goal', 'What is true when this milestone is reached')), field('Done when', area(item, 'definitionOfDone', 'One check per line'))],
        more: [(() => { const box = el('div', 'origin-inline-actions'); box.append(button('Move earlier', () => moveMilestone(item, -1), 'origin-ghost'), button('Move later', () => moveMilestone(item, 1), 'origin-ghost')); return box; })(),
          el('p', 'origin-hint', 'Deleting a milestone keeps its steps; they move to Unscheduled.')],
      }),
      items: item => ({
        title: ['title', 'Step'],
        essentials: [field('Done when', area(item, 'acceptanceCriteria', 'One check per line')), group('Starts after', linkChips(item, 'dependsOn', 'items', { exclude: item.id, empty: 'No other steps yet.' }))],
        more: [field('Milestone', select(item, 'milestoneId', [['', 'Unscheduled'], ...bp().milestones.map(milestone => [milestone.id, milestone.title || 'Untitled milestone'])])),
          field('Workstream', input(item, 'workstream', { max: 80, placeholder: 'Backend, UI…' })), field('Description', area(item, 'description')),
          group('Requirements', linkChips(item, 'requirementIds', 'requirements')), group('Components', linkChips(item, 'componentIds', 'components')), field('Status', select(item, 'status', M.ENUMS.workStatus)),
          item.handoff ? el('p', 'origin-hint', `Sent to Kanban on ${new Date(item.handoff.at).toLocaleString()}. Sending it again adds another card.`) : null].filter(Boolean),
      }),
    };
    function openDrawer(collection, id) {
      open = { collection, id };
      renderDrawer({ restore: false });
      markSelected();
      drawer.querySelector('.origin-drawer-title')?.focus();
    }
    function closeDrawer() {
      const was = open;
      open = null; renderDrawer();
      if (renderFrame) renderMain(); else markSelected();
      if (was) main.querySelector(`[data-id="${CSS.escape(was.id)}"] .origin-row-open, .origin-node[data-id="${CSS.escape(was.id)}"], .origin-milestone[data-id="${CSS.escape(was.id)}"] .origin-milestone-title`)?.focus({ preventScroll: true });
    }
    function renderDrawer({ restore = true } = {}) {
      const entry = open && record?.exists ? bp()[open.collection]?.find(item => item.id === open.id) : null;
      if (!entry) { open = null; drawer.hidden = true; drawer.replaceChildren(); view.dataset.drawer = 'closed'; return; }
      const focusKey = restore && drawer.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
      const scroll = drawer.querySelector('.origin-drawer-body')?.scrollTop || 0;
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
      const message = el('p', 'origin-inline-error'); message.hidden = true; message.setAttribute('role', 'alert');
      const foot = el('div', 'origin-drawer-foot');
      const left = el('div', 'origin-inline-actions');
      if (COMPOSABLE.has(collection)) left.append(composeButton(collection, entry.id, message));
      foot.append(left, deleteControl(collection, entry));
      drawer.replaceChildren(head, body, message, foot);
      drawer.hidden = false; view.dataset.drawer = 'open';
      body.scrollTop = scroll;
      if (focusKey) drawer.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
    }
    drawer.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); closeDrawer(); } });
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
      const others = blueprint.components.filter(component => component.id !== item.id);
      if (others.length) {
        const pick = el('select', 'origin-link-add'); pick.setAttribute('aria-label', 'Connect to a component'); pick.dataset.focusKey = 'connect';
        pick.append(Object.assign(el('option', '', '＋ Connect to…'), { value: '' }), ...others.map(component => Object.assign(el('option', '', component.name || 'Unnamed component'), { value: component.id })));
        pick.addEventListener('change', () => {
          if (!pick.value) return;
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
        const vision = bp().vision, grid = el('div', 'origin-q-grid');
        const question = (key2, text, placeholder, wide = false) => {
          const box = el('div', `origin-q${wide ? ' wide' : ''}`), key = `vision:${key2}`, wording = M.questionText(bp(), key, text);
          const control = area(vision, key2, placeholder, { label: wording });
          box.append(renamable(el('span', 'origin-q-label', wording), { key, value: wording, fallback: text, label: 'question', max: 500, onSave: value => setQuestion(key, value) }), control);
          box.addEventListener('click', event => { if (event.target === box) control.focus(); });
          return box;
        };
        grid.append(question('summary', 'In one sentence, what is it?', 'A web app that…', true), question('problem', 'What problem does it solve?', 'What is broken or missing today'),
          question('goal', 'What is the goal?', 'What changes once it exists'), question('users', 'Who is it for?', 'One group per line'), question('useCases', 'What will they do with it?', 'One use case per line'),
          question('inScope', 'What is included?', 'One item per line'), question('outOfScope', 'What is not included?', 'One item per line — agents get this as a guardrail'),
          question('successCriteria', 'How will you know it worked?', 'Observable outcomes, one per line'), question('constraints', 'Any limits?', 'Budget, deadlines, platforms, compliance…'));
        return [grid];
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
        return [canvas(), subhead('Components', 'Click one to describe it and connect it to others.'),
          list('components', blueprint.components, item => {
            const out = blueprint.connections.filter(connection => connection.from === item.id).map(connection => name(connection.to));
            return { title: item.name, fallback: 'Unnamed component', tone: item.status === 'needs_decision' ? 'decision' : item.purpose.trim() ? 'defined' : 'progress',
              sub: item.purpose.trim() ? clip(item.purpose, 110) : 'What does it do?', meta: [out.length ? el('span', 'origin-row-note', `→ ${clip(out.join(', '), 40)}`) : null, chip(M.label('componentType', item.type))] };
          }, 'No components yet. Add the main building blocks above.')];
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

    // Planning topics: one question per topic, answered in place.
    function areaSection(id) {
      const blueprint = bp(), topics = M.AREAS[id], items = blueprint.areas.filter(item => item.section === id);
      const answered = new Set(items.filter(item => item.title.trim()).map(item => item.area));
      const nodes = [];
      if (blueprint.sections[id]?.notApplicable) nodes.push(el('p', 'origin-callout', 'Marked as not needed. Anything already written is kept.'));
      const progress = el('p', 'origin-progress'); progress.append(el('strong', '', `${answered.size} of ${topics.length}`),
        id === 'security' ? ' topics answered. This shows which security decisions exist — not how secure the project is.' : ' topics answered. Skip what does not apply.');
      nodes.push(progress);
      const topicList = el('ul', 'origin-topics');
      for (const [area2, builtin] of topics) {
        const row = el('li', 'origin-topic'); row.dataset.area = area2;
        const key = `topic:${id}:${area2}`, label = topicName(id, area2);
        const name = el('span', 'origin-topic-label'); const dot = el('span', 'origin-dot'); dot.dataset.state = answered.has(area2) ? 'defined' : 'empty'; dot.setAttribute('aria-hidden', 'true');
        name.append(dot, renamable(el('span', '', label), { key, value: label, fallback: builtin, label: `${label} topic`, max: 500, onSave: value => setQuestion(key, value) }));
        const answers = el('div', 'origin-answers');
        const own = items.filter(item => item.area === area2);
        for (const item of own.length ? own : [null]) answers.append(answerRow(id, area2, label, item, dot));
        if (own.length) {
          const another = button('＋ Another', () => { const extra = answerRow(id, area2, label, null, dot); answers.insertBefore(extra, another); extra.querySelector('input').focus(); }, 'origin-link origin-another');
          answers.append(another);
        }
        row.append(name, answers);
        topicList.append(row);
      }
      nodes.push(topicList);
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
      if (bp().customSections.length >= M.LIMITS.customSections) { app.announce(`A project can have at most ${M.LIMITS.customSections} sections of its own.`); return; }
      const entry = { id: newId(), origin: 'human', phase: phaseId, title: 'New section', description: '', notApplicable: false };
      bp().customSections.push(entry); views.map = null;
      section = entry.id; setPref(SECTION_KEY, section); open = null; renderDrawer();
      changed({ structure: true });
      app.closeSidebar();
      main.querySelector('[data-edit="title"]')?.click();
    }
    function customSection(id) {
      const entry = bp().customSections.find(item => item.id === id), nodes = [];
      if (entry.notApplicable) nodes.push(el('p', 'origin-callout', 'Marked as not needed. Anything already written is kept.'));
      const about = el('div', 'origin-q wide'), control = area(entry, 'description', 'What belongs in this section', { max: 2000, label: 'What this section is about' });
      about.append(el('span', 'origin-q-label', 'What is this section about?'), control);
      about.addEventListener('click', event => { if (event.target === about) control.focus(); });
      const remove = button('Delete section', () => deleteSection(entry, remove), 'origin-link origin-delete origin-section-delete');
      nodes.push(about, ...questionsBlock(id), remove);
      return nodes;
    }
    function deleteSection(entry, control) {
      const blueprint = bp(), asked = blueprint.questions.filter(question => question.sectionId === entry.id);
      const written = entry.description.trim() || asked.some(question => blueprint.answers[question.id]?.trim());
      if (written && control.dataset.confirm !== 'true') { control.dataset.confirm = 'true'; control.textContent = 'Delete the section and what you wrote in it?'; control.classList.add('danger'); return; }
      blueprint.customSections = blueprint.customSections.filter(item => item !== entry);
      blueprint.questions = blueprint.questions.filter(question => question.sectionId !== entry.id);
      for (const question of asked) delete blueprint.answers[question.id];
      delete blueprint.layout.map.nodes[entry.id];
      blueprint.layout.map.links = blueprint.layout.map.links.filter(link => link.from !== entry.id && link.to !== entry.id);
      section = 'overview'; setPref(SECTION_KEY, section);
      app.announce('Section deleted.');
      changed({ structure: true });
      main.querySelector('h2')?.focus({ preventScroll: true });
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

    function planSection() {
      const blueprint = bp();
      const tasks = new Map(app.projects().flatMap(item => item.tasks.map(task => [task.id, task])));
      const nodes = [quickAdd('Add a milestone — e.g. “Foundation”', value => add('milestones', BLANK.milestones(value)), { id: 'milestones' })];
      if (lastHandoff) { const done = el('p', 'origin-callout ok', lastHandoff); done.setAttribute('role', 'status'); done.append(' ', button('Open Kanban', () => app.openKanban(project()?.kanbanProjectId), 'origin-link')); nodes.push(done); }
      const leading = item => {
        const box = el('input', 'origin-check'); box.type = 'checkbox'; box.checked = planSelection.has(item.id); box.setAttribute('aria-label', `Select ${item.key} for Kanban`);
        box.addEventListener('change', () => { if (box.checked) planSelection.add(item.id); else planSelection.delete(item.id); renderMain(); });
        return box;
      };
      const describe = item => {
        const task = item.handoff && tasks.get(item.handoff.taskId);
        const after = item.dependsOn.map(id => blueprint.items.find(entry => entry.id === id)?.key).filter(Boolean);
        const checks = M.lines(item.acceptanceCriteria).length;
        return { title: item.title, fallback: 'Untitled step', tone: item.status === 'done' ? 'defined' : checks ? 'defined' : 'progress',
          sub: [after.length && `after ${after.join(', ')}`, checks ? `done when: ${plural(checks, 'check')}` : 'No “done when” yet'].filter(Boolean).join(' · '),
          meta: [key(item), item.status === 'planned' ? null : chip(M.label('workStatus', item.status), item.status === 'done' ? 'ok' : 'muted'),
            item.handoff ? chip(task ? `In Kanban${task.number ? ` #${task.number}` : ''}` : 'Card removed', task ? 'ok' : 'warn') : null] };
      };
      const groups = blueprint.milestones.map((milestone, index) => ({ milestone, index }));
      if (!groups.length || blueprint.items.some(item => !item.milestoneId)) groups.push({ milestone: null });
      const timeline = el('ol', 'origin-timeline');
      for (const { milestone, index } of groups) {
        const stage = el('li', 'origin-milestone'); if (milestone) stage.dataset.id = milestone.id;
        const items = blueprint.items.filter(item => (item.milestoneId || '') === (milestone?.id || ''));
        const head = el('div', 'origin-milestone-head');
        head.append(el('span', 'origin-milestone-marker', milestone ? String(index + 1) : '·'));
        if (milestone) {
          const title = el('button', 'origin-milestone-title'); title.type = 'button';
          title.append(el('span', 'origin-row-title', milestone.title || 'Untitled milestone'));
          if (milestone.goal.trim()) title.append(el('span', 'origin-row-sub', clip(milestone.goal, 120)));
          title.addEventListener('click', () => openDrawer('milestones', milestone.id));
          head.append(title);
        } else head.append(el('span', 'origin-milestone-title static', blueprint.milestones.length ? 'Unscheduled' : 'Steps'));
        head.append(el('span', 'origin-count', plural(items.length, 'step')));
        stage.append(head, list('items', items, describe, milestone ? 'No steps yet.' : 'Add the first step — or create milestones above to group steps.', { leading }),
          quickAdd(milestone ? `Add a step to ${clip(milestone.title || 'this milestone', 40)}…` : 'Add a step…', value => add('items', { ...BLANK.items(value), milestoneId: milestone?.id || '' }, { keyed: true }), { id: `items-${milestone?.id || 'none'}` }));
        timeline.append(stage);
      }
      nodes.push(timeline);
      if (blueprint.items.length) {
        const count = planSelection.size, bar = el('div', 'origin-selection');
        const send = button(count ? `Create ${plural(count, 'Kanban task')}` : 'Create Kanban tasks', () => openHandoff(), 'origin-primary', 'Create To Do cards for the selected steps. No agent starts.');
        send.id = 'origin-kanban-handoff'; send.disabled = !count || handoffBusy;
        bar.append(el('span', 'origin-selection-text', count ? `${plural(count, 'step')} selected` : 'Select steps to send to Kanban'),
          button('Select all not sent', () => { planSelection = new Set(blueprint.items.filter(item => !item.handoff).map(item => item.id)); renderMain(); }, 'origin-link'),
          count ? button('Clear', () => { planSelection = new Set(); renderMain(); }, 'origin-link') : '', send);
        nodes.push(bar);
      }
      return nodes;
    }

    // ---- Overview: the blueprint as a mind map ----
    function leaves(id) {
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
        case 'plan': return blueprint.milestones.length ? blueprint.milestones.map(item => entry('milestones', item, item.title || 'Untitled milestone')) : blueprint.items.map(item => entry('items', item, item.title || 'Untitled step'));
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
      const make = (tag, attrs = {}, parent = svg) => { const node = document.createElementNS(ns, tag); for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value)); parent.append(node); return node; };
      const decor = make('g', { class: 'origin-map-decor' }), links = make('g', { class: 'origin-map-links' }), nodes = make('g');
      const curve = (x1, y1, x2, y2, bend) => `M${x1} ${y1}C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`;
      const named = id => (id === 'center' ? project()?.name || 'Project' : sectionName(id));
      // Center: the project itself.
      const summary = blueprint.vision.summary.trim() || blueprint.idea.trim();
      const words = summary.split(/\s+/).filter(Boolean), lines = [];
      for (const word of words) { if (!lines.length || `${lines.at(-1)} ${word}`.length > 38) lines.push(word); else lines[lines.length - 1] += ` ${word}`; if (lines.length > 3) break; }
      if (lines.length > 3) { lines.length = 3; lines[2] = `${lines[2].slice(0, 36)}…`; }
      const centerH = 64 + Math.max(lines.length, 1) * 20;
      // Built-in places: branches stacked on both sides. Custom sections join the shorter side. A moved
      // node keeps its own place; new sections take a built-in place without moving anything else.
      const left = [...MAP_LEFT], right = [...MAP_RIGHT];
      for (const entry of blueprint.customSections) (left.length <= right.length ? left : right).push(entry.id);
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
        let drag = null;
        node.addEventListener('pointerdown', event => {
          if (event.button !== 0) return;
          const matrix = svg.getScreenCTM()?.inverse(); if (!matrix) return;
          drag = { id: event.pointerId, start: new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix), origin: { ...pos(id) }, moved: false, matrix };
          node.setPointerCapture?.(event.pointerId);
        });
        node.addEventListener('pointermove', event => {
          if (!drag || event.pointerId !== drag.id) return;
          const now = new DOMPoint(event.clientX, event.clientY).matrixTransform(drag.matrix), dx = now.x - drag.start.x, dy = now.y - drag.start.y;
          if (!drag.moved && Math.hypot(dx, dy) < 4) return;
          drag.moved = true; live[id] = { x: drag.origin.x + dx, y: drag.origin.y + dy };
          (node.closest('.origin-map-branch') || node).setAttribute('transform', `translate(${dx} ${dy})`);
          for (const [other, path] of centerLinks) if (id === 'center' || other === id) path.setAttribute('d', linkPath(other));
          drawDecor();
        });
        node.addEventListener('pointerup', event => {
          if (!drag || event.pointerId !== drag.id) return;
          const moved = drag.moved; drag = null;
          if (!moved) { activate(id, openIt); return; }
          keep(live[id], false);
        });
        node.addEventListener('pointercancel', () => { drag = null; delete live[id]; renderMain(); });
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
        const p = pos(block.id), side = sideOf(block.id), phase = phaseOf(block.id).id, state = states[block.id];
        const outer = p.x + side * SECTION_W / 2, top = p.y - block.rows * LEAF_H / 2;
        const path = make('path', { d: linkPath(block.id), class: `origin-map-link phase-${phase}${state === 'empty' || state === 'na' ? ' faint' : ''}` }, links);
        centerLinks.set(block.id, path);
        const branch = make('g', { class: 'origin-map-branch' }, nodes);
        const node = make('g', { class: `origin-map-section phase-${phase} state-${state}`, transform: `translate(${p.x - SECTION_W / 2} ${p.y - SECTION_H / 2})` }, branch);
        make('rect', { width: SECTION_W, height: SECTION_H, rx: SECTION_H / 2 }, node);
        make('circle', { cx: 20, cy: SECTION_H / 2, r: 4.5, class: 'origin-map-dot' }, node);
        const label = make('text', { x: 36, y: SECTION_H / 2 + 5, class: 'origin-map-label' }, node); label.textContent = clip(sectionName(block.id), 18);
        const count = block.id === 'vision' ? 0 : sectionCount(block.id);
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
      const name = make('text', { x: CENTER_W / 2, y: 38, 'text-anchor': 'middle', class: 'origin-map-title' }, centerNode); name.textContent = clip(project()?.name || 'Project', 30);
      lines.forEach((line, index) => { const text = make('text', { x: CENTER_W / 2, y: 64 + index * 20, 'text-anchor': 'middle', class: 'origin-map-summary' }, centerNode); text.textContent = line; });
      if (!lines.length) { const text = make('text', { x: CENTER_W / 2, y: 64, 'text-anchor': 'middle', class: 'origin-map-summary faint' }, centerNode); text.textContent = 'Click to describe the idea'; }
      movable(centerNode, 'center', `${project()?.name || 'Project'}. Open ${sectionName('vision')}`, () => openSection('vision'));
      drawDecor();
      // The whole map fits by default; zoom and pan are kept until Fit.
      const pad = 44, fitBox = { x: bounds.x1 - pad, y: bounds.y1 - pad, w: bounds.x2 - bounds.x1 + 2 * pad, h: bounds.y2 - bounds.y1 + 2 * pad };
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
      grip.addEventListener('pointerup', event => {
        if (!sizing || event.pointerId !== sizing.id) return;
        const done = sizing; sizing = null;
        if (done.moved) { const rect = wrap.getBoundingClientRect(); setSize(rect.width, rect.height); }
      });
      grip.addEventListener('pointercancel', () => { sizing = null; renderMain(); });
      grip.addEventListener('keydown', event => {
        const rect = wrap.getBoundingClientRect();
        const step = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] }[event.key];
        if (step) { event.preventDefault(); setSize(rect.width + step[0], rect.height + step[1]); }
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
      } else next.append(el('p', 'origin-empty-note', ready.state === 'not_started' ? 'Describe the idea to begin.' : 'Nothing blocking. Plan the build, then send steps to Kanban.'));
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
      const make = (tag, attrs = {}, parent = svg) => { const node = document.createElementNS(ns, tag); for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value)); parent.append(node); return node; };
      const marker = make('marker', { id: 'origin-arrow', viewBox: '0 0 10 10', refX: 8.5, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, make('defs'));
      make('path', { d: 'M1 1.5L8.5 5L1 8.5', class: 'origin-arrow' }, marker);
      if (!blueprint.components.length) {
        svg.setAttribute('viewBox', '0 0 640 200');
        const empty = make('text', { x: 320, y: 96, 'text-anchor': 'middle', class: 'origin-canvas-empty' }); empty.textContent = 'Add the main building blocks above — then connect them.';
        const sub = make('text', { x: 320, y: 120, 'text-anchor': 'middle', class: 'origin-canvas-empty faint' }); sub.textContent = 'For example: Web app → API → Database';
        wrap.append(svg); return wrap;
      }
      const at = positions(blueprint);
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
          bp().connections.push({ id: newId(), origin: 'human', from, to: component.id, label: 'calls', protocol: '', notes: '' });
          connectFrom = null;
          changed({ structure: true });
          openDrawer('components', from);
          app.announce('Connected. Name how they talk in the editor.');
        };
        let drag = null;
        node.addEventListener('pointerdown', event => {
          if (event.button !== 0) return;
          const matrix = svg.getScreenCTM()?.inverse(); if (!matrix) return;
          drag = { id: event.pointerId, start: new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix), origin: { ...point }, moved: false, matrix };
          node.setPointerCapture?.(event.pointerId);
        });
        node.addEventListener('pointermove', event => {
          if (!drag || event.pointerId !== drag.id) return;
          const now = new DOMPoint(event.clientX, event.clientY).matrixTransform(drag.matrix), dx = now.x - drag.start.x, dy = now.y - drag.start.y;
          if (!drag.moved && Math.hypot(dx, dy) < 4) return;
          drag.moved = true; point.x = Math.round(drag.origin.x + dx); point.y = Math.round(drag.origin.y + dy);
          node.setAttribute('transform', `translate(${point.x} ${point.y})`); drawEdges();
        });
        node.addEventListener('pointerup', event => {
          if (!drag || event.pointerId !== drag.id) return;
          const moved = drag.moved; drag = null;
          if (!moved) { activate(); return; }
          for (const [id, value] of at) { const entry = bp().components.find(item => item.id === id); if (entry) { entry.x = value.x; entry.y = value.y; } }
          holdView('canvas', svg, point.x, point.y, NODE_W, NODE_H);
          changed({ structure: true });
        });
        node.addEventListener('pointercancel', () => { drag = null; renderMain(); });
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
    function composeButton(collection, id, message) {
      const control = button('Send to Compose', async () => {
        const spec = M.composeSpec(bp(), collection, id, project()?.name || '');
        if (!spec) return;
        await flush();
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
        app.announce(`Opened ${spec.title} in Compose. Review the prompt, then choose Generate. Nothing was generated.`);
      }, 'origin-ghost origin-compose', 'Fill Compose with just this item and what it links to. Nothing is generated.');
      control.prepend(icon(ICON.arrow, 14));
      return control;
    }
    let handoffDialog = null;
    function openHandoff() {
      const blueprint = bp(), selection = [...planSelection].filter(id => blueprint.items.some(item => item.id === id));
      if (!selection.length) return;
      const target = project(), destination = target?.kanban?.exists ? target.kanbanProjectId : null;
      if (!destination) { openConnect({ then: openHandoff }); return; }
      const tasks = M.kanbanTasks(blueprint, selection, target?.name || '');
      handoffDialog ??= (() => { const dialog = el('dialog', 'origin-modal'); dialog.id = 'origin-handoff-dialog'; dialog.setAttribute('aria-labelledby', 'origin-handoff-heading'); document.body.append(dialog); return dialog; })();
      const dialog = handoffDialog;
      const heading = el('h2', '', 'Create Kanban tasks'); heading.id = 'origin-handoff-heading';
      const steps = el('ol', 'origin-handoff-list');
      for (const task of tasks) { const item = blueprint.items.find(entry => entry.id === task.itemId); const li = el('li', '', task.title); if (item.handoff) li.append(' ', chip('already sent', 'warn')); steps.append(li); }
      const error = el('p', 'origin-inline-error'); error.hidden = true; error.setAttribute('role', 'alert');
      const confirm = button(`Create ${plural(tasks.length, 'card')} in To Do`, async () => {
        confirm.disabled = true; handoffBusy = true;
        const created = [];
        try {
          for (const task of tasks) {
            const result = await app.createTask({ projectId: destination, title: task.title, prompt: task.prompt });
            const item = bp().items.find(entry => entry.id === task.itemId);
            if (item && result?.task?.id) { item.handoff = { projectId: destination, taskId: result.task.id, at: Date.now(), snapshotId: '', hash: '' }; created.push(task.title); changed(); }
          }
        } catch (failure) {
          error.textContent = `${failure.message}${created.length ? ` ${plural(created.length, 'card')} already created: ${created.join(', ')}.` : ' No card was created.'}`;
          error.hidden = false;
        } finally { handoffBusy = false; confirm.disabled = false; await flush(); }
        if (!error.hidden) { renderMain(); return; }
        dialog.close();
        planSelection = new Set();
        lastHandoff = `Created ${plural(created.length, 'card')} in To Do of ${target?.kanban?.name || 'the Kanban project'}, dependencies first. No agent started.`;
        app.announce(lastHandoff);
        renderMain();
      }, 'origin-primary');
      confirm.id = 'origin-handoff-confirm';
      const close = button('', () => dialog.close(), 'origin-icon origin-modal-close'); close.setAttribute('aria-label', 'Close'); close.append(icon(ICON.close));
      const actions = el('div', 'origin-modal-actions'); actions.append(button('Cancel', () => dialog.close(), 'origin-ghost'), confirm);
      dialog.replaceChildren(close, el('p', 'origin-eyebrow', `Kanban · ${target?.kanban?.name || ''}`), heading,
        el('p', 'origin-modal-lead', 'Each step becomes one To Do card, dependencies first, with its “done when”, linked requirements and components, and an Origin reference. No agent starts — you start work from Kanban.'),
        steps, error, actions);
      dialog.showModal();
      confirm.focus();
    }

    // ---- Keyboard ----
    view.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save({ force: changeCount !== savedCount }); return; }
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (connectFrom !== null || mapLinkFrom !== null || selectedLink) { event.preventDefault(); connectFrom = mapLinkFrom = selectedLink = null; renderMain(); return; }
      if (open) { event.preventDefault(); closeDrawer(); }
    });

    return { show, leave };
  }

  return { create };
})();
