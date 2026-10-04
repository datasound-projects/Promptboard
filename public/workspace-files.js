'use strict';

// Independent, read-only Workspace UI. No agents, board mutations or persisted source text.
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
    const tray = node('div', 'file-viewer-tray'); tray.hidden = true; tray.setAttribute('aria-label', 'Minimized project files');
    const refreshButton = button('↻', 'Refresh file', () => { const row = viewers.get(active); if (row) void readFile(row, true); });
    heading.append(title, refreshButton, button('−', 'Minimize file viewer', () => minimize(active)), button('×', 'Close file viewer', () => close(active)));
    dialog.append(heading, location, tabs, status, code); document.body.append(dialog, tray);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(active); });
    const endpoint = (project, workspace, path, kind, extra = {}) => `/api/projects/${encodeURIComponent(project)}/${kind}?${new URLSearchParams({ path, workspace, ...extra })}`;
    const key = (project, workspace, path) => JSON.stringify([project, workspace, path]);
    function renderTray() {
      const rows = [...viewers.values()].filter(row => row.minimized);
      tray.replaceChildren(...rows.map(row => {
        const chip = node('div', 'file-viewer-chip');
        chip.append(button(`${row.project.name} · ${row.path.split('/').pop()}`, `${row.project.name} · ${row.scope} · ${row.path}`, () => show(row)), button('×', `Close ${row.path}`, () => close(row.key)));
        return chip;
      })); tray.hidden = !visible || !rows.length || dialog.open;
    }
    function renderTabs() {
      const rows = [...viewers.values()], signature = JSON.stringify(rows.map(row => [row.key, row.minimized, row.project.name, active === row.key]));
      if (tabs.dataset.signature === signature) return;
      const focused = tabs.contains(document.activeElement) ? document.activeElement.dataset.viewerKey : null;
      tabs.dataset.signature = signature;
      tabs.replaceChildren(...rows.map(row => {
        const tab = button(row.path.split('/').pop() + (row.minimized ? ' ↗' : ''), `${row.minimized ? 'Restore ' : ''}${row.project.name} · ${row.scope} · ${row.path}`, () => show(row), 'file-tab');
        tab.dataset.viewerKey = row.key;
        tab.setAttribute('aria-pressed', String(row.key === active)); return tab;
      })); tabs.hidden = tabs.children.length < 2;
      if (focused) [...tabs.children].find(tab => tab.dataset.viewerKey === focused)?.focus();
    }
    function paint(row, reset = false) {
      if (row.key !== active || !dialog.open) return;
      title.textContent = row.project.name; location.textContent = `${row.scope} / ${row.path}`;
      status.textContent = row.error || (row.text === undefined ? 'Reading file…' : `${language(row.path)} · Read-only${row.changed ? ' · Updated since opening' : ''}`);
      status.classList.toggle('file-error', Boolean(row.error));
      refreshButton.disabled = Boolean(row.loading);
      if (reset || code.dataset.version !== row.version || code.dataset.key !== row.key) {
        code.replaceChildren(row.text === undefined ? document.createTextNode('') : codeLines(row.text, language(row.path)));
        code.dataset.key = row.key; code.dataset.version = row.version || '';
        code.scrollTop = row.scrollTop || 0; code.scrollLeft = row.scrollLeft || 0;
      }
      renderTabs();
    }
    function remember() { const row = viewers.get(active); if (row) { row.scrollTop = code.scrollTop; row.scrollLeft = code.scrollLeft; } }
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
    function minimize(id) { const row = viewers.get(id); if (!row) return; remember(); row.minimized = true; row.abort?.abort(); next(); }
    function close(id) { const row = viewers.get(id); if (!row) return; row.abort?.abort(); viewers.delete(id); if (id === active) next(); else { renderTray(); renderTabs(); } markSelection(); }
    async function readFile(row, force = false) {
      if (row.loading || !visible || row.minimized) return;
      const own = new AbortController(); row.abort = own; row.loading = true;
      try {
        const data = await request(endpoint(row.project.id, row.workspace, row.path, 'file', { version: force ? '' : row.version || '' }), own.signal);
        if (own.signal.aborted || viewers.get(row.key) !== row) return;
        row.project = data.project;
        if (!data.unchanged) { remember(); row.changed ||= Boolean(row.version && row.version !== data.version); row.version = data.version; row.text = data.text; }
        row.error = '';
      } catch (error) { if (!own.signal.aborted) row.error = `${error.message}${row.text !== undefined ? ' Showing the last read version.' : ''}`; }
      finally { row.loading = false; paint(row); if (own.signal.aborted && visible && row.key === active && !row.minimized) void readFile(row); }
    }
    function markSelection() {
      for (const state of projects.values()) for (const el of state.host.querySelectorAll('[data-file-path]')) el.classList.toggle('selected', viewers.has(key(state.project.id, state.workspace, el.dataset.filePath)));
    }
    function openFile(state, path) {
      const id = key(state.project.id, state.workspace, path);
      let row = viewers.get(id);
      if (!row) {
        if (viewers.size >= 8) { state.status.textContent = 'Close a file viewer before opening another (maximum 8).'; return; }
        row = { key: id, project: state.project, root: state.project.repository.root, workspace: state.workspace, scope: state.scopes.find(s => s.id === state.workspace)?.name || 'Project checkout', path, minimized: false };
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
        if (!project || project.repository.root !== state.project.repository.root) { abortTree(state); projects.delete(id); }
        else state.project = project;
      }
      for (const row of [...viewers.values()]) {
        const project = linked.get(row.project.id);
        if (!project || row.root && row.root !== project.repository.root) close(row.key);
        else { row.root = project.repository.root; row.project = project; }
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
      if (!value) { for (const state of projects.values()) abortTree(state); for (const row of viewers.values()) { row.abort?.abort(); row.minimized = true; } remember(); active = null; if (dialog.open) dialog.close(); }
      renderTray(); if (value) void refresh();
    }
    setInterval(() => void refresh(), 3000);
    return { mount, sync, setVisible };
  }
  return { create };
})();
