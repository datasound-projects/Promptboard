'use strict';

// Optional shared projects in Compose. History stays exactly as before (browser-only, no project needed);
// the Projects tab lists every project (one ID across Origin and Kanban) with its saved prompts. Saving
// or moving a prompt never creates a card; a card is made, or an idle card updated, only on request.
window.PromptboardProjects = (() => {
  const TAB_KEY = 'promptboard.compose.sidebar';
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const button = (text, onClick, className = 'text-button', title = '') => { const node = el('button', className, text); node.type = 'button'; if (title) node.title = title; node.addEventListener('click', onClick); return node; };
  const pref = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
  const setPref = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
  const date = value => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  function create(host) {
    const { api, announce } = host;
    let projects = [], open = pref('promptboard.compose.project', ''), promptsFor = new Map(), loading = null, link = null, barBusy = false, barMessage = '', barAction = null, naming = false;
    const call = async (path, options = {}) => {
      const { response, data } = await api(path, { timeoutMs: 120000, ...options }).catch(() => ({ response: { ok: false, status: 0 }, data: { error: 'The app did not answer. Nothing was changed.' } }));
      return { ok: response.ok, status: response.status, data };
    };

    // ---- Sidebar: History | Projects ----
    const historyTab = document.getElementById('sidebar-tab-history'), projectsTab = document.getElementById('sidebar-tab-projects');
    const historySection = document.getElementById('history-section'), projectsSection = document.getElementById('projects-section');
    function showTab(name, focus = false) {
      const projectsShown = name === 'projects';
      historySection.hidden = projectsShown; projectsSection.hidden = !projectsShown;
      historyTab.setAttribute('aria-selected', String(!projectsShown)); projectsTab.setAttribute('aria-selected', String(projectsShown));
      historyTab.tabIndex = projectsShown ? -1 : 0; projectsTab.tabIndex = projectsShown ? 0 : -1;
      setPref(TAB_KEY, name);
      if (projectsShown) void refresh();
      if (focus) (projectsShown ? projectsTab : historyTab).focus();
    }
    historyTab.addEventListener('click', () => showTab('history'));
    projectsTab.addEventListener('click', () => showTab('projects'));
    for (const tab of [historyTab, projectsTab]) tab.addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); showTab(tab === historyTab ? 'projects' : 'history', true); } });

    async function refresh() {
      loading ??= (async () => {
        const { ok, data } = await call('/api/shared-projects');
        if (ok) projects = data.projects;
        if (open && projects.some(project => project.id === open)) await loadPrompts(open);
        renderProjects();
      })().finally(() => { loading = null; });
      return loading;
    }
    async function loadPrompts(id) {
      const { ok, data } = await call(`/api/shared-projects/${encodeURIComponent(id)}/prompts`);
      if (ok) promptsFor.set(id, data.prompts);
    }
    function renderProjects() {
      const list = el('div', 'projects-list'); list.id = 'projects-list';
      const create = button('＋ New project', () => { naming = true; renderProjects(); projectsSection.querySelector('#projects-new-name')?.focus(); }, 'new-prompt projects-new'); create.id = 'projects-new';
      const nodes = [create];
      if (naming) {
        const form = el('form', 'projects-new-form'), input = el('input'); input.id = 'projects-new-name'; input.maxLength = 80; input.placeholder = 'Project name'; input.setAttribute('aria-label', 'New project name');
        const add = el('button', 'secondary-button', 'Create'); add.type = 'submit';
        form.append(input, add, button('Cancel', () => { naming = false; renderProjects(); create.focus(); }, 'text-button'));
        form.addEventListener('submit', event => { event.preventDefault(); void newProject(input.value); });
        input.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); naming = false; renderProjects(); projectsSection.querySelector('#projects-new')?.focus(); } });
        nodes.push(form);
      }
      projectsSection.replaceChildren(...nodes, el('p', 'projects-note', 'Optional. Save prompts to a project when you want them kept together; History works without one.'), list);
      if (!projects.length) { list.append(el('p', 'history-empty-text', 'No projects yet.')); return; }
      for (const project of projects) {
        const expanded = project.id === open, row = el('div', `project-row${expanded ? ' open' : ''}`);
        const head = button('', () => { open = expanded ? '' : project.id; setPref('promptboard.compose.project', open); void (open ? loadPrompts(open) : Promise.resolve()).then(renderProjects); }, 'project-row-head');
        head.setAttribute('aria-expanded', String(expanded)); head.dataset.projectId = project.id;
        head.append(el('strong', '', project.name), el('small', '', `${project.prompts} ${project.prompts === 1 ? 'prompt' : 'prompts'}${project.kanban ? ' · board' : ''}${project.origin ? ' · Origin' : ''}`));
        row.append(head);
        if (expanded) {
          const items = promptsFor.get(project.id) || [];
          const box = el('div', 'project-prompts');
          if (!items.length) box.append(el('p', 'history-empty-text', 'No saved prompts yet. Use “Save to project” on a result or a History entry.'));
          for (const prompt of items) {
            const item = button('', () => void openSaved(project, prompt.id), 'project-prompt');
            item.dataset.promptId = prompt.id;
            if (link?.kind === 'prompt' && link.promptId === prompt.id) item.setAttribute('aria-current', 'true');
            item.append(el('strong', '', prompt.title), el('small', '', `rev ${prompt.current} · ${date(prompt.updatedAt)}${prompt.cards.length ? ` · ${prompt.cards.length} ${prompt.cards.length === 1 ? 'card' : 'cards'}` : ''}`));
            box.append(item);
          }
          const actions = el('div', 'project-links');
          if (project.origin) actions.append(button('Open in Origin', () => host.openOrigin(project.origin.id), 'text-button'));
          if (project.kanban) actions.append(button('Open board', () => host.openKanban(project.kanban.id), 'text-button'));
          box.append(actions);
          row.append(box);
        }
        list.append(row);
      }
    }
    async function newProject(name) {
      if (!name?.trim()) return;
      const { ok, data } = await call('/api/shared-projects', { method: 'POST', body: { name } });
      if (!ok) { announce(data.error || 'The project could not be created.'); return; }
      naming = false; open = data.project.id; setPref('promptboard.compose.project', open);
      await refresh();
      announce(data.existing ? `Selected the existing project “${data.project.name}”.` : `Created the project “${data.project.name}”.`);
    }

    // ---- Opening a saved prompt in Compose ----
    async function openSaved(project, promptId) {
      if (host.running()) return;
      const { ok, data } = await call(`/api/shared-projects/${encodeURIComponent(project.id)}/prompts/${encodeURIComponent(promptId)}`);
      if (!ok) { announce(data.error || 'The saved prompt could not be opened.'); return; }
      const saved = data.prompt;
      host.openInCompose({ id: `saved-${saved.id}-${saved.current}`, input: saved.input, prompt: saved.prompt, createdAt: saved.updatedAt, ...saved.settings },
        { kind: 'prompt', projectId: data.project.id, projectName: data.project.name, promptId: saved.id, revision: saved.revision, number: saved.current, title: saved.title, prompt: saved });
    }

    // ---- The link bar: where the open prompt came from and what can go back ----
    const bar = el('div', 'compose-link'); bar.id = 'compose-link'; bar.hidden = true; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Linked project item');
    document.getElementById('compose-origin').after(bar);
    function setLink(next) { link = next; barMessage = ''; barAction = null; renderBar(); if (!projectsSection.hidden) renderProjects(); }
    function renderBar() {
      bar.hidden = !link; bar.replaceChildren();
      if (!link) return;
      const result = host.getResult(), busy = barBusy || host.running();
      const text = el('span', 'compose-link-text');
      const actions = el('span', 'compose-link-actions');
      if (link.kind === 'prompt') {
        text.textContent = `Project · ${link.projectName} / ${link.title} (revision ${link.number})`;
        const changed = Boolean(result && result.prompt !== link.prompt.prompt);
        const revise = button('Save as new revision', () => void saveRevision(), 'secondary-button', 'Keep this result as the next revision; earlier revisions stay'); revise.id = 'compose-link-revise'; revise.disabled = busy || !changed;
        const card = button('Create Kanban card', () => void createCard(), 'secondary-button', 'Add the current saved revision to To Do. No agent starts.'); card.id = 'compose-link-card'; card.disabled = busy || changed;
        actions.append(revise, card);
        for (const cardLink of link.prompt.cards.filter(entry => entry.exists)) {
          actions.append(button(`Card #${cardLink.number ?? ''}${cardLink.behind ? ' (older revision)' : ''}`, () => host.openKanban(cardLink.projectId, cardLink.taskId), 'text-button', `${cardLink.title} · ${cardLink.column}`));
          if (cardLink.behind && !changed) { const update = button(`Update card #${cardLink.number ?? ''}`, () => void updateLinkedCard(cardLink), 'text-button', 'Give this idle To Do card the current revision'); update.disabled = busy; actions.append(update); }
        }
        for (const origin of link.prompt.origin.filter(entry => entry.exists)) actions.append(button(`Origin: ${origin.name}`, () => host.openOrigin(origin.originId, origin), 'text-button'));
      } else if (link.kind === 'card') {
        text.textContent = `Kanban · #${link.number ?? ''} ${link.title}`;
        const update = button('Update card', () => void updateCard(), 'secondary-button', 'Replace this idle To Do card’s prompt with the current result'); update.id = 'compose-link-update';
        update.disabled = busy || !result || result.prompt === link.prompt;
        actions.append(update, button('Back to Kanban', () => host.openKanban(link.kanbanProjectId, link.taskId), 'text-button'));
      } else if (link.kind === 'origin') {
        text.textContent = `From Origin · ${link.name || link.collection}`;
        actions.append(button('Back to Origin', () => host.openOrigin(link.originId, link), 'text-button'));
      }
      actions.append(button('Unlink', () => setLink(null), 'text-button', 'Keep the result here without the link'));
      bar.append(text, actions);
      if (barMessage) {
        const note = el('p', 'compose-link-message', barMessage); note.setAttribute('role', 'status');
        if (barAction) { const follow = button(barAction.label, barAction.run, 'secondary-button'); follow.id = barAction.id; follow.disabled = busy; note.append(' ', follow); }
        bar.append(note);
      }
    }
    async function guarded(work) {
      if (barBusy) return;
      barBusy = true; barMessage = ''; barAction = null; renderBar();
      try { await work(); } finally { barBusy = false; renderBar(); }
    }
    const say = message => { barMessage = message; announce(message); };
    async function saveRevision() {
      const result = host.getResult(); if (!result || link?.kind !== 'prompt') return;
      await guarded(async () => {
        const { ok, data } = await call(`/api/shared-projects/${encodeURIComponent(link.projectId)}/prompts/${encodeURIComponent(link.promptId)}/revisions`, { method: 'POST',
          body: { expectedRevision: link.revision, prompt: result.prompt, input: result.input, settings: host.settingsOf(result), verification: host.verificationOf(result), historyId: result.id } });
        if (!ok) { say(data.error || 'The revision could not be saved.'); return; }
        link = { ...link, revision: data.prompt.revision, number: data.prompt.current, prompt: data.prompt };
        say(`Saved revision ${data.prompt.current}. Earlier revisions and linked cards are unchanged.`);
        await refresh();
      });
    }
    async function createCard(createBoard = false) {
      if (link?.kind !== 'prompt') return;
      await guarded(async () => {
        const { ok, data } = await call(`/api/shared-projects/${encodeURIComponent(link.projectId)}/prompts/${encodeURIComponent(link.promptId)}/cards`, { method: 'POST', body: { expectedRevision: link.revision, createBoard } });
        if (!ok && data.code === 'NO_BOARD') {
          barMessage = `“${link.projectName}” has no Kanban board yet.`;
          barAction = { id: 'compose-link-board', label: 'Create its board and the card', run: () => void createCard(true) };
          return;
        }
        if (!ok) { say(data.error || 'The card could not be created.'); return; }
        link = { ...link, revision: data.prompt.revision, prompt: data.prompt };
        say(`Created card #${data.task.number} in To Do. No agent started.`);
        await host.refreshBoard(); await refresh();
      });
    }
    async function updateLinkedCard(cardLink, replaceEdited = false) {
      await guarded(async () => {
        const card = host.card(cardLink.taskId);
        const { ok, data } = await call(`/api/shared-projects/${encodeURIComponent(link.projectId)}/prompts/${encodeURIComponent(link.promptId)}/cards/${encodeURIComponent(cardLink.taskId)}/update`, { method: 'POST',
          body: { expectedRevision: link.revision, expectedCardRevision: card?.revision, replaceEdited } });
        if (!ok && data.code === 'CARD_EDITED') {
          barMessage = data.error; barAction = { id: 'compose-link-replace', label: 'Replace the edited prompt', run: () => void updateLinkedCard(cardLink, true) };
          return;
        }
        if (!ok) { say(data.error || 'The card was not changed.'); return; }
        link = { ...link, revision: data.prompt.revision, prompt: data.prompt };
        say(`Card #${cardLink.number} now has revision ${data.prompt.current}.`);
        await host.refreshBoard();
      });
    }
    async function updateCard() {
      const result = host.getResult(); if (!result || link?.kind !== 'card') return;
      await guarded(async () => {
        const { ok, data } = await call(`/api/tasks/${encodeURIComponent(link.taskId)}/refine`, { method: 'POST', body: { prompt: result.prompt, expectedRevision: link.cardRevision } });
        if (!ok) { say(`${data.error || 'The card was not changed.'}${data.code === 'CARD_BUSY' ? ' Use “Add to Kanban” to create a new card instead.' : ''}`); return; }
        link = { ...link, cardRevision: data.task.revision, prompt: data.task.prompt };
        say(`Card #${link.number} now has this prompt. No agent started.`);
        await host.refreshBoard();
      });
    }

    // ---- Save or move a result into a project ----
    const dialog = el('dialog', 'kanban-dialog projects-dialog'); dialog.id = 'project-save-dialog'; dialog.setAttribute('aria-labelledby', 'project-save-heading');
    document.body.append(dialog);
    async function openSave(entry, { fromHistory = false } = {}) {
      if (!entry || host.running()) return;
      await refresh();
      const form = el('form'); form.noValidate = true;
      const heading = el('h2', '', fromHistory ? 'Save to a project' : 'Save this prompt to a project'); heading.id = 'project-save-heading';
      const select = el('select'); select.id = 'project-save-target';
      select.append(...projects.map(project => Object.assign(el('option', '', project.name), { value: project.id })), Object.assign(el('option', '', 'New project…'), { value: '' }));
      const preferred = link?.kind === 'prompt' ? link.projectId : link?.kind === 'origin' ? link.originId : open;
      select.value = projects.some(project => project.id === preferred) ? preferred : (projects[0]?.id || '');
      const name = el('input'); name.id = 'project-save-name'; name.maxLength = 80; name.placeholder = 'Project name';
      const nameField = el('label', 'field-label', 'New project name'); nameField.append(name);
      const title = el('input'); title.id = 'project-save-title'; title.maxLength = 120; title.value = (entry.input || entry.prompt).replace(/\s+/g, ' ').trim().slice(0, 80);
      const titleField = el('label', 'field-label', 'Title'); titleField.append(title);
      const projectField = el('label', 'field-label', 'Project'); projectField.append(select);
      const move = el('input'); move.type = 'checkbox'; move.id = 'project-save-move';
      const moveField = el('label', 'check-option'); moveField.append(move, ' Move: remove it from History after saving'); moveField.hidden = !fromHistory;
      const error = el('p', 'inline-error'); error.hidden = true; error.setAttribute('role', 'alert');
      const toggle = () => { nameField.hidden = select.value !== ''; };
      select.addEventListener('change', toggle); toggle();
      const cancel = button('Cancel', () => dialog.close(), 'secondary-button');
      const submit = el('button', 'copy-button', 'Save'); submit.type = 'submit'; submit.id = 'project-save-submit';
      const actions = el('div', 'kanban-dialog-actions'); actions.append(cancel, submit);
      form.append(heading, el('p', 'note', 'The prompt keeps its text and settings. No Kanban card is created.'), projectField, nameField, titleField, moveField, error, actions);
      form.addEventListener('submit', async event => {
        event.preventDefault(); error.hidden = true; submit.disabled = true;
        try {
          let projectId = select.value;
          if (!projectId) {
            const made = await call('/api/shared-projects', { method: 'POST', body: { name: name.value } });
            if (!made.ok) throw new Error(made.data.error || 'The project could not be created.');
            projectId = made.data.project.id;
          }
          const originLinks = link?.kind === 'origin' && link.collection ? [{ originId: link.originId, collection: link.collection, id: link.id }] : [];
          const saved = await call(`/api/shared-projects/${encodeURIComponent(projectId)}/prompts`, { method: 'POST',
            body: { title: title.value, prompt: entry.prompt, input: entry.input, settings: host.settingsOf(entry), verification: host.verificationOf(entry), historyId: entry.id, origin: originLinks } });
          if (!saved.ok) throw new Error(saved.data.error || 'The prompt could not be saved.');
          if (fromHistory && move.checked) host.removeHistory(entry.id);
          dialog.close();
          open = saved.data.project.id; setPref('promptboard.compose.project', open);
          await refresh();
          if (!fromHistory || entry.id === host.getResult()?.id) setLink({ kind: 'prompt', projectId: saved.data.project.id, projectName: saved.data.project.name, promptId: saved.data.prompt.id, revision: saved.data.prompt.revision, number: saved.data.prompt.current, title: saved.data.prompt.title, prompt: saved.data.prompt });
          announce(`${saved.data.existing ? 'Already saved' : 'Saved'} in “${saved.data.project.name}”${fromHistory && move.checked ? ' and removed from History' : ''}. No card was created.`);
        } catch (failure) { error.textContent = failure.message; error.hidden = false; }
        finally { submit.disabled = false; }
      });
      dialog.replaceChildren(form);
      dialog.showModal(); (select.value ? title : name).focus();
    }

    showTab(pref(TAB_KEY, 'history') === 'projects' ? 'projects' : 'history');
    return { openSave, setLink, link: () => link, renderBar, refresh, openPrompt: (projectId, promptId) => openSaved({ id: projectId }, promptId) };
  }

  return { create };
})();
