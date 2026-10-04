'use strict';

// Project-scoped files, explicit saves and opt-in AI proposals. No automatic agent actions.
window.PromptboardFiles = (() => {
  const node = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; };
  const button = (text, title, action, className = 'file-button') => {
    const el = node('button', className, text); el.type = 'button'; el.title = title; el.setAttribute('aria-label', title); el.addEventListener('click', action); return el;
  };
  const language = path => ({ js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', py: 'Python', json: 'JSON', css: 'CSS', html: 'HTML', xml: 'XML', svg: 'XML', sh: 'Shell', bash: 'Shell', yml: 'YAML', yaml: 'YAML', sql: 'SQL', md: 'Markdown', rs: 'Rust', go: 'Go', java: 'Java', c: 'C', h: 'C', cpp: 'C++', toml: 'TOML', rb: 'Ruby' })[path.split('.').pop().toLowerCase()] || 'Text';
  const keywords = /^(?:async|await|break|case|catch|class|const|continue|def|default|delete|do|else|elif|except|export|extends|false|finally|for|from|function|if|import|in|let|new|null|None|pass|raise|return|static|super|switch|this|throw|true|try|typeof|var|void|while|with|yield|True|False|public|private|protected|interface|type|package|func|select|SELECT|FROM|WHERE|INSERT|INTO|CREATE|TABLE|AND|OR|NOT|JOIN|UPDATE|SET|VALUES)$/;

  // A small lexical highlighter; never interpret source as HTML or execute it.
  function codeLines(text, lang) {
    const fragment = document.createDocumentFragment(); let blockComment = false;
    for (const [i, line] of text.split(/\r?\n/).entries()) {
      const row = node('div', 'file-code-line'), number = node('span', 'file-line-number', String(i + 1)), content = node('span', 'file-line-text');
      number.setAttribute('aria-hidden', 'true');
      if (lang === 'Text' || line.length > 10_000) content.textContent = line;
      else {
        const pattern = /\/\*|\*\/|\/\/.*$|<!--.*?(?:-->|$)|#[^\n]*$|--[^\n]*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b/g;
        let cursor = 0;
        for (const match of line.matchAll(pattern)) {
          const plain = line.slice(cursor, match.index); if (plain) content.append(node('span', blockComment ? 'file-token-comment' : '', plain));
          const value = match[0], hashComment = ['Python', 'Shell', 'YAML', 'TOML', 'Ruby'].includes(lang) && value.startsWith('#');
          const sqlComment = lang === 'SQL' && value.startsWith('--');
          const comment = blockComment || value === '/*' || value.startsWith('//') || value.startsWith('<!--') || hashComment || sqlComment;
          if (value === '/*') blockComment = true;
          content.append(node('span', comment ? 'file-token-comment' : /^["'`]/.test(value) ? 'file-token-string' : /^\d/.test(value) ? 'file-token-number' : keywords.test(value) ? 'file-token-keyword' : '', value));
          if (value === '*/') blockComment = false;
          cursor = match.index + value.length;
        }
        if (cursor < line.length) content.append(node('span', blockComment ? 'file-token-comment' : '', line.slice(cursor)));
      }
      row.append(number, content); fragment.append(row);
    }
    return fragment;
  }

  function create({ request }) {
    const projects = new Map(), viewers = new Map(); let visible = false, active = null, refreshing = false, sequence = 0;
    const dialog = node('dialog', 'file-viewer'); dialog.id = 'workspace-file-viewer'; dialog.setAttribute('aria-labelledby', 'workspace-file-title');
    const heading = node('div', 'file-viewer-heading'), title = node('h2', '', 'Project file'); title.id = 'workspace-file-title';
    const location = node('p', 'file-location'), tabs = node('div', 'file-viewer-tabs'); tabs.setAttribute('aria-label', 'Open project files');
    const status = node('p', 'file-status'); status.setAttribute('role', 'status');
    const code = node('div', 'file-code'); code.tabIndex = 0; code.setAttribute('aria-label', 'Read-only file contents');
    const surface = node('div', 'file-editor-surface'), editor = node('textarea', 'file-editor'); editor.hidden = true; editor.spellcheck = false; editor.wrap = 'off'; editor.setAttribute('aria-label', 'Edit file contents');
    const tools = node('div', 'file-editor-tools');
    const editButton = button('Edit', 'Edit file', () => { const row = viewers.get(active); if (row) { remember(); row.editing = !row.editing; paint(row, true); if (row.editing) editor.focus(); } });
    const saveButton = button('Save', 'Save file (⌘ / Ctrl + S)', () => void saveFile(viewers.get(active)), 'file-button file-save');
    const aiToggle = button('AI', 'Show AI file panel', () => { const row = viewers.get(active); if (row) { row.aiOpen = !row.aiOpen; paint(row); if (row.aiOpen) instruction.focus(); } }); aiToggle.setAttribute('aria-expanded', 'false'); aiToggle.setAttribute('aria-controls', 'file-ai-panel');
    tools.append(editButton, saveButton, aiToggle);
    const confirmation = node('div', 'file-close-confirm'); confirmation.hidden = true; confirmation.setAttribute('role', 'alert');
    const aiPanel = node('section', 'file-ai-panel'); aiPanel.id = 'file-ai-panel'; aiPanel.hidden = true; aiPanel.setAttribute('aria-label', 'AI file proposal');
    const aiOptions = node('div', 'file-ai-options'), provider = node('select'), model = node('input'); provider.setAttribute('aria-label', 'File AI provider'); model.setAttribute('aria-label', 'File AI model (optional)'); model.placeholder = 'Default model'; model.maxLength = 100;
    for (const [id, name] of [['codex', 'Codex'], ['claude', 'Claude Code'], ['gemini', 'Gemini']]) { const option = node('option', '', name); option.value = id; provider.append(option); }
    const instruction = node('textarea'); instruction.setAttribute('aria-label', 'Describe the change to this file'); instruction.placeholder = 'Describe a change to this file…'; instruction.maxLength = 8000; instruction.rows = 3;
    const aiNote = node('p', 'file-ai-note', 'Only this file and your request are sent through the selected CLI. Review the proposal, then save. No commands or project agents run.');
    const aiStatus = node('p', 'file-ai-status'); aiStatus.setAttribute('role', 'status');
    const aiActions = node('div', 'file-ai-actions'), proposeButton = button('Propose change', 'Propose changes to this file', () => void proposeFile(viewers.get(active))), cancelButton = button('Cancel', 'Cancel file AI proposal', () => { const row = viewers.get(active); if (row) { cancelAi(row); paint(row); } });
    const useButton = button('Use proposal', 'Use AI proposal in draft', () => { const row = viewers.get(active); if (!row?.proposal) return; row.draft = row.proposal.text; row.proposal = null; row.reviewing = false; row.editing = true; row.notice = 'AI proposal applied to draft. Review and Save to write it.'; paint(row, true); editor.focus(); });
    const discardButton = button('Discard proposal', 'Discard AI proposal', () => { const row = viewers.get(active); if (row) { row.proposal = null; row.reviewing = false; paint(row, true); } });
    const compareButton = button('View current draft', 'Compare AI proposal with current draft', () => { const row = viewers.get(active); if (row) { row.reviewing = !row.reviewing; paint(row, true); } });
    aiOptions.append(provider, model); aiActions.append(proposeButton, cancelButton, compareButton, useButton, discardButton); aiPanel.append(aiOptions, instruction, aiNote, aiStatus, aiActions);
    const tray = node('div', 'file-viewer-tray'); tray.hidden = true; tray.setAttribute('aria-label', 'Minimized project files');
    const refreshButton = button('↻', 'Refresh file', () => { const row = viewers.get(active); if (row) void readFile(row, true); });
    heading.append(title, refreshButton, button('−', 'Minimize file viewer', () => minimize(active)), button('×', 'Close file viewer', () => close(active)));
    surface.append(code, editor); dialog.append(heading, location, tabs, tools, status, confirmation, surface, aiPanel); document.body.append(dialog, tray);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(active); });
    const endpoint = (project, workspace, path, kind, extra = {}) => `/api/projects/${encodeURIComponent(project)}/${kind}?${new URLSearchParams({ path, workspace, ...extra })}`;
    const key = (project, workspace, path) => JSON.stringify([project, workspace, path]);
    const rootKey = project => JSON.stringify([project.repository?.root, project.repository?.inspectionRoot || project.repository?.path]);
    const dirty = row => row?.draft !== undefined && row.draft !== row.text;
    editor.addEventListener('input', () => {
      const row = viewers.get(active); if (!row || row.aiBusy || row.saving || row.reviewing) return;
      row.draft = /\r\n/.test(row.text || '') && !/(?:^|[^\r])\n/.test(row.text || '') ? editor.value.replace(/\n/g, '\r\n') : editor.value;
      row.notice = ''; remember(); code.replaceChildren(codeLines(row.draft, language(row.path))); code._shown = row.draft; code.scrollTop = editor.scrollTop; code.scrollLeft = editor.scrollLeft; paint(row);
    });
    editor.addEventListener('scroll', () => { code.scrollTop = editor.scrollTop; code.scrollLeft = editor.scrollLeft; });
    dialog.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveFile(viewers.get(active)); } });
    for (const [field, property] of [[provider, 'aiProvider'], [model, 'aiModel'], [instruction, 'instruction']]) field.addEventListener('input', () => { const row = viewers.get(active); if (row) { row[property] = field.value; paint(row); } });
    window.addEventListener('beforeunload', event => { if ([...viewers.values()].some(row => dirty(row) || row.proposal || row.saving || row.aiBusy)) { event.preventDefault(); event.returnValue = ''; } });
    function renderTray() {
      const rows = [...viewers.values()].filter(row => row.minimized);
      tray.replaceChildren(...rows.map(row => {
        const chip = node('div', 'file-viewer-chip');
        chip.append(button(`${row.project.name} · ${row.path.split('/').pop()}${dirty(row) ? ' •' : ''}`, `${row.project.name} · ${row.scope} · ${row.path}`, () => show(row)), button('×', `Close ${row.path}`, () => close(row.key)));
        return chip;
      })); tray.hidden = !visible || !rows.length || dialog.open;
    }
    function renderTabs() {
      const rows = [...viewers.values()], signature = JSON.stringify(rows.map(row => [row.key, row.minimized, row.project.name, dirty(row), active === row.key]));
      if (tabs.dataset.signature === signature) return;
      const focused = tabs.contains(document.activeElement) ? document.activeElement.dataset.viewerKey : null;
      tabs.dataset.signature = signature;
      tabs.replaceChildren(...rows.map(row => {
        const tab = button(row.path.split('/').pop() + (dirty(row) ? ' •' : '') + (row.minimized ? ' ↗' : ''), `${row.minimized ? 'Restore ' : ''}${row.project.name} · ${row.scope} · ${row.path}`, () => show(row), 'file-tab');
        tab.dataset.viewerKey = row.key;
        tab.setAttribute('aria-pressed', String(row.key === active)); return tab;
      })); tabs.hidden = tabs.children.length < 2;
      if (focused) [...tabs.children].find(tab => tab.dataset.viewerKey === focused)?.focus();
    }
    function paint(row, reset = false) {
      if (row.key !== active || !dialog.open) return;
      title.textContent = row.project.name; location.textContent = `${row.scope} / ${row.path}`;
      const draft = row.draft ?? row.text, shown = row.reviewing && row.proposal ? row.proposal.text : draft;
      status.textContent = row.error || (row.aiBusy ? 'AI is proposing a change…' : row.notice) || (row.text === undefined ? 'Reading file…' : `${language(row.path)}${row.reviewing ? ' · AI proposal · Not saved' : dirty(row) ? ' · Unsaved draft' : row.editing ? ' · Editing' : ' · Preview'}${row.changed ? ' · Updated since opening' : ''}`);
      status.classList.toggle('file-error', Boolean(row.error));
      refreshButton.disabled = Boolean(row.loading || row.saving);
      editButton.textContent = row.editing ? 'Preview' : 'Edit'; editButton.disabled = row.text === undefined || row.aiBusy || row.saving || Boolean(row.proposal);
      saveButton.disabled = !dirty(row) || row.saving || row.conflict || row.unavailable || row.reviewing || row.aiBusy;
      saveButton.textContent = row.saving ? 'Saving…' : 'Save';
      editor.hidden = !row.editing || row.reviewing || row.text === undefined;
      editor.readOnly = Boolean(row.saving || row.aiBusy || row.unavailable || row.proposal); editor.setAttribute('aria-label', `Edit ${row.project.name} / ${row.path}`);
      const displayDraft = (draft || '').replace(/\r\n/g, '\n');
      if (editor.value !== displayDraft) editor.value = displayDraft;
      if (reset || code.dataset.version !== row.version || code.dataset.key !== row.key || code._shown !== shown) {
        code.replaceChildren(shown === undefined ? document.createTextNode('') : codeLines(shown, language(row.path))); code._shown = shown;
        code.dataset.key = row.key; code.dataset.version = row.version || '';
        code.scrollTop = row.scrollTop || 0; code.scrollLeft = row.scrollLeft || 0;
        editor.scrollTop = code.scrollTop; editor.scrollLeft = code.scrollLeft;
      }
      aiPanel.hidden = !row.aiOpen; aiToggle.setAttribute('aria-expanded', String(Boolean(row.aiOpen)));
      provider.value = row.aiProvider || 'codex'; if (model.value !== (row.aiModel || '')) model.value = row.aiModel || ''; if (instruction.value !== (row.instruction || '')) instruction.value = row.instruction || '';
      for (const field of [provider, model, instruction]) field.disabled = Boolean(row.aiBusy);
      proposeButton.hidden = Boolean(row.aiBusy || row.proposal); proposeButton.disabled = !row.text && row.text !== '' || !row.instruction?.trim() || row.saving || row.conflict || row.unavailable;
      cancelButton.hidden = !row.aiBusy; for (const el of [compareButton, useButton, discardButton]) el.hidden = !row.proposal;
      compareButton.textContent = row.reviewing ? 'View current draft' : 'View AI proposal';
      aiStatus.textContent = row.aiBusy ? 'Proposing a change…' : row.aiError || row.proposal?.summary || ''; aiStatus.classList.toggle('file-error', Boolean(row.aiError));
      confirmation.hidden = !row.confirmClose && !row.conflict;
      if (row.confirmClose) confirmation.replaceChildren(node('span', '', 'Discard this unsaved draft/proposal and close?'), button('Discard and close', 'Discard draft and close file', () => close(row.key, true)), button('Keep editing', 'Keep file draft', () => { row.confirmClose = false; paint(row); }));
      else if (row.conflict) confirmation.replaceChildren(node('span', '', 'The disk version changed. Your draft is kept. Copy it before reloading to reconcile.'), button('Copy draft', 'Copy unsaved file draft', async () => { try { await navigator.clipboard.writeText(row.draft ?? ''); row.notice = 'Draft copied.'; } catch { row.notice = 'Select and copy the draft in the editor.'; } paint(row); }), button('Discard draft and reload', 'Discard draft and reload disk file', () => { row.draft = row.text; row.conflict = false; row.proposal = null; row.reviewing = false; void readFile(row, true); }));
      renderTabs();
    }
    function remember() { const row = viewers.get(active); if (row) { row.scrollTop = editor.hidden ? code.scrollTop : editor.scrollTop; row.scrollLeft = editor.hidden ? code.scrollLeft : editor.scrollLeft; } }
    function show(row) {
      if (!visible) return;
      remember(); active = row.key; row.minimized = false;
      if (!dialog.open) dialog.showModal();
      paint(row); renderTray(); code.focus(); void readFile(row);
    }
    function next() {
      const row = [...viewers.values()].find(item => !item.minimized);
      if (row && visible) { active = row.key; paint(row); code.focus(); }
      else { active = null; if (dialog.open) dialog.close(); }
      renderTabs(); renderTray();
    }
    function cancelAi(row) { row.aiAbort?.abort(); row.aiBusy = false; row.aiSequence = (row.aiSequence || 0) + 1; row.aiError = 'Proposal cancelled. Your draft is unchanged.'; }
    function minimize(id) { const row = viewers.get(id); if (!row) return; remember(); row.minimized = true; row.abort?.abort(); if (row.aiBusy) cancelAi(row); next(); }
    function close(id, force = false) { const row = viewers.get(id); if (!row) return; if (row.saving) return; if (!force && (dirty(row) || row.proposal)) { row.confirmClose = true; if (row.minimized || id !== active) show(row); else paint(row); return; } row.abort?.abort(); if (row.aiBusy) cancelAi(row); viewers.delete(id); if (id === active) next(); else { renderTray(); renderTabs(); } markSelection(); }
    async function readFile(row, force = false) {
      if (row.loading || row.saving || row.unavailable || !visible || row.minimized) return;
      const own = new AbortController(); row.abort = own; row.loading = true;
      try {
        const data = await request(endpoint(row.project.id, row.workspace, row.path, 'file', { version: force ? '' : row.version || '' }), own.signal);
        if (own.signal.aborted || viewers.get(row.key) !== row) return;
        row.project = data.project;
        if (!data.unchanged) {
          if ((dirty(row) || row.proposal || row.aiBusy) && row.version && row.version !== data.version) { row.conflict = true; row.error = 'File changed on disk. Your draft has not been overwritten.'; }
          else if (!dirty(row) && !row.proposal && !row.aiBusy) { remember(); row.changed ||= Boolean(row.version && row.version !== data.version); row.version = data.version; row.scopeVersion = data.scopeVersion; row.text = data.text; row.draft = data.text; row.error = ''; }
        } else if (!row.conflict) row.error = '';
      } catch (error) { if (!own.signal.aborted) row.error = `${error.message}${row.text !== undefined ? ' Showing the last read version.' : ''}`; }
      finally { row.loading = false; paint(row); if (own.signal.aborted && visible && row.key === active && !row.minimized) void readFile(row); }
    }
    async function saveFile(row) {
      if (!row || !dirty(row) || row.saving || row.conflict || row.unavailable || row.reviewing || row.aiBusy) return;
      row.abort?.abort(); const text = row.draft; row.saving = true; row.error = ''; paint(row);
      try {
        const data = await request(endpoint(row.project.id, row.workspace, row.path, 'file'), undefined, { method: 'PUT', body: { path: row.path, workspace: row.workspace, text, version: row.version, scopeVersion: row.scopeVersion } });
        row.text = text; row.version = data.version; row.scopeVersion = data.scopeVersion; row.changed = false; row.notice = 'Saved to project file.';
      } catch (error) { row.error = error.message; row.conflict = error.code === 'FILE_CONFLICT'; }
      finally { row.saving = false; paint(row); renderTray(); }
    }
    async function proposeFile(row) {
      if (!row || row.aiBusy || row.saving || row.conflict || row.unavailable || !row.instruction?.trim()) return;
      const own = new AbortController(), sequence = row.aiSequence = (row.aiSequence || 0) + 1;
      row.aiAbort = own; row.aiBusy = true; row.aiError = ''; row.error = ''; row.notice = ''; paint(row);
      try {
        const proposal = await request(`/api/projects/${encodeURIComponent(row.project.id)}/file-proposal`, own.signal, { method: 'POST', timeoutMs: null, body: { path: row.path, workspace: row.workspace, text: row.draft ?? row.text, version: row.version, scopeVersion: row.scopeVersion, instruction: row.instruction, provider: row.aiProvider || 'codex', model: row.aiModel || '' } });
        if (own.signal.aborted || sequence !== row.aiSequence || viewers.get(row.key) !== row) return;
        row.proposal = proposal; row.reviewing = true;
      } catch (error) { if (!own.signal.aborted && sequence === row.aiSequence) { row.aiError = error.message; if (error.code === 'FILE_CONFLICT') { row.conflict = true; row.error = error.message; } } }
      finally { if (sequence === row.aiSequence) { row.aiBusy = false; paint(row, true); } }
    }
    function markSelection() {
      for (const state of projects.values()) for (const el of state.host.querySelectorAll('[data-file-path]')) el.classList.toggle('selected', viewers.has(key(state.project.id, state.workspace, el.dataset.filePath)));
    }
    function openFile(state, path) {
      const id = key(state.project.id, state.workspace, path);
      let row = viewers.get(id);
      if (!row) {
        if (viewers.size >= 8) { state.status.textContent = 'Close a file viewer before opening another (maximum 8).'; return; }
        row = { key: id, project: state.project, root: rootKey(state.project), workspace: state.workspace, scope: state.scopes.find(s => s.id === state.workspace)?.name || 'Project checkout', path, minimized: false, aiProvider: ['codex', 'claude', 'gemini'].includes(state.project.agentDefaults?.provider) ? state.project.agentDefaults.provider : 'codex' };
        viewers.set(id, row);
      }
      show(row); markSelection();
    }
    function renderDirectory(state, path) {
      const data = state.directories.get(path), list = state.lists.get(path); if (!data || !list) return;
      const focused = document.activeElement, focusPath = list.contains(focused) ? focused.dataset.filePath : undefined;
      list.replaceChildren(...data.entries.map(entry => {
        const item = node('li', 'file-tree-item'), full = path ? `${path}/${entry.name}` : entry.name;
        const dir = entry.kind === 'directory', expanded = state.expanded.has(full);
        const label = button(`${dir ? expanded ? '▾' : '▸' : '·'} ${entry.name}`, entry.blocked ? `${entry.name}: links, special files and credentials are not opened` : entry.name, () => {
          if (dir) {
            if (state.expanded.has(full)) { state.expanded.delete(full); state.lists.delete(full); renderDirectory(state, path); }
            else { if (state.expanded.size >= 64) { state.status.textContent = 'Collapse a folder before expanding more (maximum 64).'; return; } state.expanded.add(full); renderDirectory(state, path); void loadDirectory(state, full); }
          } else openFile(state, full);
        }, 'file-tree-row');
        label.dataset.filePath = full; label.disabled = entry.blocked;
        if (dir) label.setAttribute('aria-expanded', String(expanded));
        item.append(label);
        if (dir && expanded && !entry.blocked) { const child = node('ul', 'file-tree-list'); child.setAttribute('aria-label', entry.name); item.append(child); state.lists.set(full, child); renderDirectory(state, full); }
        return item;
      }));
      if (data.next !== null) { const more = node('li'); more.append(button('Show more', 'Show more files', () => void loadDirectory(state, path, data.next), 'file-tree-more')); list.append(more); }
      if (!data.entries.length) list.append(node('li', 'file-tree-note', 'Empty folder'));
      if (data.truncated) list.append(node('li', 'file-tree-note', 'Showing a bounded subset (5,000 entries).'));
      if (focusPath) [...list.querySelectorAll('[data-file-path]')].find(el => el.dataset.filePath === focusPath)?.focus();
      markSelection();
    }
    async function loadDirectory(state, path, offset = 0) {
      if (!visible || !state.open || state.pending.has(path)) return;
      const epoch = state.epoch, own = new AbortController(); state.pending.set(path, own);
      try {
        const data = await request(endpoint(state.project.id, state.workspace, path, 'files', { offset: String(offset) }), own.signal);
        if (own.signal.aborted || state.epoch !== epoch || projects.get(state.project.id) !== state) return;
        const old = state.directories.get(path);
        if (offset) data.entries = [...(old?.entries || []), ...data.entries];
        // Refresh all previously revealed pages without collapsing the directory.
        if (!offset && old?.entries.length > data.entries.length) {
          while (data.next !== null && data.entries.length < old.entries.length) {
            const page = await request(endpoint(state.project.id, state.workspace, path, 'files', { offset: String(data.next) }), own.signal);
            data.entries.push(...page.entries); data.next = page.next; data.truncated ||= page.truncated;
          }
          if (own.signal.aborted || state.epoch !== epoch) return;
        }
        state.directories.set(path, data); state.scopes = data.scopes;
        if (path === '') updateScopes(state);
        if (JSON.stringify(old) !== JSON.stringify(data)) renderDirectory(state, path);
        state.errors.delete(path);
      } catch (error) { if (!own.signal.aborted) state.errors.set(path, error.message); }
      finally {
        if (state.pending.get(path) === own) state.pending.delete(path);
        state.status.textContent = [...state.errors].slice(0, 2).map(([where, message]) => `${where || 'Files'}: ${message}`).join(' ');
        state.status.classList.toggle('file-error', Boolean(state.errors.size));
      }
    }
    function abortTree(state) { state.epoch++; for (const own of state.pending.values()) own.abort(); state.pending.clear(); }
    function updateScopes(state) {
      const scopes = state.scopes;
      state.select.replaceChildren(...scopes.map(scope => { const option = node('option', '', scope.name); option.value = scope.id; return option; }));
      state.select.value = state.workspace; state.select.hidden = scopes.length < 2;
    }
    function mount(project) {
      let state = projects.get(project.id);
      if (state) { state.project = project; state.host.setAttribute('aria-label', `${project.name} files`); return state.host; }
      const host = node('section', 'workspace-files'); host.setAttribute('aria-label', `${project.name} files`);
      const body = node('div', 'workspace-files-body'); body.hidden = true;
      const select = node('select', 'file-scope'); select.setAttribute('aria-label', `Checkout for ${project.name}`); select.hidden = true;
      const status = node('p', 'file-tree-note'); status.setAttribute('role', 'status');
      const list = node('ul', 'file-tree-list'); list.setAttribute('aria-label', `${project.name} files`);
      state = { project, host, body, select, status, list, workspace: '', scopes: [{ id: '', name: 'Project checkout' }], open: false, epoch: ++sequence, expanded: new Set(), pending: new Map(), errors: new Map(), directories: new Map(), lists: new Map([['', list]]) };
      const toggle = button('▸ Files', `Show files in ${project.name}`, () => {
        state.open = !state.open; body.hidden = !state.open; toggle.textContent = state.open ? '▾ Files' : '▸ Files'; toggle.setAttribute('aria-expanded', String(state.open));
        if (state.open) void loadDirectory(state, ''); else abortTree(state);
      }, 'file-tree-toggle'); toggle.setAttribute('aria-expanded', 'false');
      body.id = `workspace-files-${project.id}`; toggle.setAttribute('aria-controls', body.id);
      select.addEventListener('change', () => { abortTree(state); state.workspace = select.value; state.expanded.clear(); state.errors.clear(); state.directories.clear(); state.lists = new Map([['', list]]); list.replaceChildren(); void loadDirectory(state, ''); });
      body.append(select, status, list); host.append(toggle, body); projects.set(project.id, state); return host;
    }
    function sync(nextProjects) {
      const linked = new Map(nextProjects.filter(p => p.repository).map(p => [p.id, p]));
      for (const [id, state] of projects) {
        const project = linked.get(id);
        if (!project || rootKey(project) !== rootKey(state.project)) { abortTree(state); projects.delete(id); }
        else state.project = project;
      }
      for (const row of [...viewers.values()]) {
        const project = linked.get(row.project.id);
        if (!project || row.root && row.root !== rootKey(project)) {
          if (dirty(row) || row.proposal || row.saving) { row.unavailable = true; row.abort?.abort(); if (row.aiBusy) cancelAi(row); row.error = 'Project removed or relinked. Your draft is kept for copying; saving is disabled.'; }
          else close(row.key, true);
        } else { row.root = rootKey(project); row.project = project; }
      }
      if (active) paint(viewers.get(active)); renderTray();
    }
    async function refresh() {
      if (!visible || document.hidden || refreshing) return;
      refreshing = true;
      try {
        for (const state of projects.values()) if (state.open) {
          for (const path of ['', ...state.expanded]) if (state.lists.get(path)?.isConnected) await loadDirectory(state, path);
        }
        const row = viewers.get(active); if (row) await readFile(row);
      } finally { refreshing = false; }
    }
    function setVisible(value) {
      if (visible === value) return;
      visible = value;
      if (!value) { for (const state of projects.values()) abortTree(state); for (const row of viewers.values()) { row.abort?.abort(); if (row.aiBusy) cancelAi(row); row.minimized = true; } remember(); active = null; if (dialog.open) dialog.close(); }
      renderTray(); if (value) void refresh();
    }
    setInterval(() => void refresh(), 3000);
    return { mount, sync, setVisible };
  }
  return { create };
})();
